import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createRateLimiter, createRedisSlidingWindowStore, limitRequest, RateLimitStoreError, resolveClientAddress,
  spendRequestLimit, trustedProxies, type RateLimitStore, type SlidingWindowPipeline, type SlidingWindowRedis,
} from '../src/rate-limit/index.js';
import { errorHandler, getClientAddress, rateLimit as honoRateLimit, type HiveEnv } from '../src/hono/index.js';
import { hiveHandler, rateLimit as nodeRateLimit, sendJson } from '../src/node-http/index.js';
import { HiveError } from '../src/errors/index.js';

/** An in-memory stand-in for the ioredis pipeline commands the sliding window queues. */
function fakeRedis(options: { zrange?: boolean } = {}) {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  const expiries = new Map<string, number>();
  let failNext: { index: number; error: Error } | undefined;
  let execReply: 'discard' | 'garbage' | 'badCount' | undefined;
  const redis: SlidingWindowRedis = {
    pipeline() {
      const queue: Array<() => unknown> = [];
      const pipeline: SlidingWindowPipeline = {
        zremrangebyscore(key, _min, max) {
          queue.push(() => {
            const set = sets.get(key) ?? [];
            const kept = set.filter(entry => entry.score > max);
            sets.set(key, kept);
            return set.length - kept.length;
          });
        },
        zadd(key, score, member) {
          queue.push(() => {
            const set = sets.get(key) ?? [];
            set.push({ score, member });
            set.sort((a, b) => a.score - b.score);
            sets.set(key, set);
            return 1;
          });
        },
        zcard(key) { queue.push(() => (sets.get(key) ?? []).length); },
        pexpire(key, ms) { queue.push(() => { expiries.set(key, ms); return 1; }); },
        async exec() {
          if (execReply === 'discard') return null;
          if (execReply === 'garbage') return ['nope'] as unknown as Array<[Error | null, unknown]>;
          const failing = failNext;
          failNext = undefined;
          const replies = queue.map((command, index): [Error | null, unknown] => {
            if (failing && failing.index === index) return [failing.error, null];
            return [null, command()];
          });
          if (execReply === 'badCount') return replies.map(([error]) => [error, 'x']);
          return replies;
        },
      };
      if (options.zrange !== false) {
        pipeline.zrange = (key, start, stop) => {
          queue.push(() => {
            const set = sets.get(key) ?? [];
            const from = Number(start) < 0 ? set.length + Number(start) : Number(start);
            const to = Number(stop) < 0 ? set.length + Number(stop) : Number(stop);
            if (from < 0 || from > to) return [];
            return set.slice(from, to + 1).flatMap(entry => [entry.member, String(entry.score)]);
          });
        };
      }
      return pipeline;
    },
  };
  return {
    redis, sets, expiries,
    failAt(index: number, error: Error) { failNext = { index, error }; },
    reply(kind: typeof execReply) { execReply = kind; },
  };
}

describe('createRedisSlidingWindowStore', () => {
  it('counts every attempt, refused ones included, within a sliding window', async () => {
    let now = 1_000_000;
    const fake = fakeRedis();
    const store = createRedisSlidingWindowStore({ redis: fake.redis, windowMs: 60_000, max: 2, now: () => now });
    expect(await store.consume('app:rl:192.0.2.1')).toEqual({ allowed: true, limit: 2, remaining: 1, retryAfterMs: 0, resetMs: 60_000 });
    now += 1000;
    expect(await store.consume('app:rl:192.0.2.1')).toMatchObject({ allowed: true, remaining: 0 });
    now += 1000;
    // Refused: the whole window by default, and the refusal is recorded too.
    expect(await store.consume('app:rl:192.0.2.1')).toEqual({ allowed: false, limit: 2, remaining: 0, retryAfterMs: 60_000, resetMs: 60_000 });
    expect(fake.sets.get('app:rl:192.0.2.1')).toHaveLength(3);
    expect(fake.expiries.get('app:rl:192.0.2.1')).toBe(60_000);
    // The full key is the Redis key: another client is separate.
    expect((await store.consume('app:rl:192.0.2.2')).allowed).toBe(true);
    // Once the window has passed every attempt, the client is allowed again.
    now += 60_000;
    expect((await store.consume('app:rl:192.0.2.1')).allowed).toBe(true);
  });

  it('prefixes keys and spends an integer cost', async () => {
    const fake = fakeRedis();
    const store = createRedisSlidingWindowStore({ redis: () => fake.redis, windowMs: 1000, max: 3, keyPrefix: 'svc-rl:', now: () => 5 });
    expect(await store.consume('login:alice', 2)).toMatchObject({ allowed: true, remaining: 1 });
    expect(fake.sets.get('svc-rl:login:alice')).toHaveLength(2);
    expect(new Set(fake.sets.get('svc-rl:login:alice')?.map(entry => entry.member)).size).toBe(2);
    expect(await store.consume('login:alice', 2)).toMatchObject({ allowed: false, remaining: 0 });
    await expect(store.consume('login:alice', 4)).rejects.toThrow(RangeError);
    await expect(store.consume('login:alice', 1.5)).rejects.toThrow(RangeError);
    await expect(store.consume(5 as unknown as string)).rejects.toThrow(TypeError);
  });

  it("computes Retry-After from the oldest entry that must leave with retryAfter: 'oldest'", async () => {
    let now = 10_000;
    const fake = fakeRedis();
    const store = createRedisSlidingWindowStore({ redis: fake.redis, windowMs: 60_000, max: 2, retryAfter: 'oldest', now: () => now });
    await store.consume('k'); // at 10 000
    now = 30_000;
    await store.consume('k'); // at 30 000
    now = 40_000;
    // Three entries; one more is allowed once the first two have left: the second leaves at 90 000.
    expect(await store.consume('k')).toMatchObject({ allowed: false, retryAfterMs: 50_000 });
    // Allowed ones say 0.
    expect((await store.consume('other')).retryAfterMs).toBe(0);
  });

  it("falls back to the window when the oldest entry cannot be read, and needs zrange for 'oldest'", async () => {
    const fake = fakeRedis();
    // A zrange whose reply is not a [member, score] pair.
    const odd = createRedisSlidingWindowStore({
      redis: { pipeline: () => { const p = fake.redis.pipeline(); p.zrange = (key) => { p.zcard(key); }; return p; } },
      windowMs: 1000, max: 1, retryAfter: 'oldest', now: () => 0,
    });
    await odd.consume('k');
    expect(await odd.consume('k')).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    const without = createRedisSlidingWindowStore({ redis: fakeRedis({ zrange: false }).redis, windowMs: 1000, max: 1, retryAfter: 'oldest' });
    await expect(without.consume('k')).rejects.toThrow(/zrange/);
  });

  it('throws on command errors and unreadable replies, so the caller can fail closed', async () => {
    const fake = fakeRedis();
    const store = createRedisSlidingWindowStore({ redis: fake.redis, windowMs: 1000, max: 5 });
    const failure = new Error('READONLY You can\'t write against a read only replica');
    fake.failAt(1, failure);
    await expect(store.consume('k')).rejects.toBe(failure);
    fake.reply('discard');
    await expect(store.consume('k')).rejects.toBeInstanceOf(RateLimitStoreError);
    fake.reply('garbage');
    await expect(store.consume('k')).rejects.toBeInstanceOf(RateLimitStoreError);
    fake.reply('badCount');
    await expect(store.consume('k')).rejects.toThrow(/count/);
    const down = createRedisSlidingWindowStore({ redis: { pipeline: () => ({ ...fake.redis.pipeline(), exec: () => Promise.reject(new Error('connection lost')) }) }, windowMs: 1000, max: 5 });
    await expect(down.consume('k')).rejects.toThrow('connection lost');
  });

  it('validates its configuration', () => {
    const { redis } = fakeRedis();
    expect(() => createRedisSlidingWindowStore({ redis, windowMs: 0, max: 1 })).toThrow(RangeError);
    expect(() => createRedisSlidingWindowStore({ redis, windowMs: 1000, max: 1.5 })).toThrow(RangeError);
    expect(() => createRedisSlidingWindowStore({ redis, windowMs: 1000, max: 1, keyPrefix: 5 as unknown as string })).toThrow(TypeError);
    expect(() => createRedisSlidingWindowStore({ redis, windowMs: 1000, max: 1, retryAfter: 'newest' as 'window' })).toThrow(TypeError);
  });
});

describe('trustedProxies wildcards', () => {
  it('matches IPv4 wildcards part by part, as TRUSTED_PROXY_IPS lists them', () => {
    const proxies = trustedProxies('10.*.*.*, 192.0.2.*, 198.51.*.7, 2001:db8::/32');
    expect(proxies.entries).toEqual(['10.*.*.*', '192.0.2.*', '198.51.*.7', '2001:db8::/32']);
    expect(proxies.has('10.255.0.1')).toBe(true);
    expect(proxies.has('::ffff:10.1.2.3')).toBe(true);
    expect(proxies.has('192.0.2.200')).toBe(true);
    expect(proxies.has('192.0.3.1')).toBe(false);
    expect(proxies.has('198.51.100.7')).toBe(true);
    expect(proxies.has('198.51.100.8')).toBe(false);
    expect(proxies.has('11.0.0.1')).toBe(false);
    // IPv6 never matches an IPv4 wildcard; CIDR entries still work.
    expect(proxies.has('2001:db8::1')).toBe(true);
    expect(proxies.has('2001:db9::1')).toBe(false);
    expect(trustedProxies('*.*.*.*').has('203.0.113.1')).toBe(true);
    expect(trustedProxies('*.*.*.*').has('::1')).toBe(false);
  });

  it('refuses wildcard entries that could never match', () => {
    for (const bad of ['10.*', '10.*.*', '10.*.*.*.*', '10.0*.*.*', '010.*.*.*', '256.*.*.*', '10.*.*.*/8', '*', '2001:db8::*', '10.**.0.1']) {
      expect(() => trustedProxies(bad), bad).toThrow(TypeError);
    }
  });

  it('walks a wildcard-trusted chain like any other', () => {
    const trusted = trustedProxies('10.*.*.*');
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: '192.0.2.1, 10.9.9.9', trusted })).toMatchObject({ address: '192.0.2.1', decision: 'forwarded' });
    expect(resolveClientAddress({ peer: '203.0.113.2', forwardedFor: '192.0.2.1', trusted })).toMatchObject({ address: '203.0.113.2', decision: 'direct' });
  });
});

describe('resolveClientAddress trustedHops', () => {
  const trusted = trustedProxies('198.51.100.10');

  it('takes the n-th entry from the right behind a trusted peer, without looking the hops up', () => {
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: '192.0.2.1', trusted, trustedHops: 1 })).toEqual({ address: '192.0.2.1', peer: '198.51.100.10', decision: 'forwarded' });
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: '203.0.113.50, 192.0.2.1, 203.0.113.9', trusted, trustedHops: 2 })).toMatchObject({ address: '192.0.2.1', decision: 'forwarded' });
    // A forged prefix changes nothing: the client is counted from the right.
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: '203.0.113.66, 192.0.2.1', trusted, trustedHops: 1 })).toMatchObject({ address: '192.0.2.1' });
  });

  it('reports a short or broken chain as invalid_forwarding with the peer as the address', () => {
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: '192.0.2.1', trusted, trustedHops: 2 })).toEqual({ address: '198.51.100.10', peer: '198.51.100.10', decision: 'invalid_forwarding' });
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: 'garbage, 192.0.2.1', trusted, trustedHops: 1 })).toMatchObject({ address: '198.51.100.10', decision: 'invalid_forwarding' });
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: '192.0.2.1,,192.0.2.2', trusted, trustedHops: 1 })).toMatchObject({ decision: 'invalid_forwarding' });
    expect(resolveClientAddress({ peer: '198.51.100.10', trusted, trustedHops: 1 })).toMatchObject({ address: '198.51.100.10', decision: 'proxy_without_forwarding' });
  });

  it('ignores X-Forwarded-For from an untrusted peer or with 0 hops, and validates the count', () => {
    expect(resolveClientAddress({ peer: '203.0.113.7', forwardedFor: '192.0.2.1', trusted, trustedHops: 1 })).toMatchObject({ address: '203.0.113.7', decision: 'direct' });
    expect(resolveClientAddress({ peer: '198.51.100.10', forwardedFor: '192.0.2.1', trusted, trustedHops: 0 })).toMatchObject({ address: '198.51.100.10', decision: 'direct' });
    for (const bad of [-1, 1.5, 33, Number.NaN]) {
      expect(() => resolveClientAddress({ peer: '198.51.100.10', trusted, trustedHops: bad })).toThrow(RangeError);
    }
    expect(() => resolveClientAddress({ peer: '198.51.100.10', trusted, trustedHops: 3, maxHops: 2 })).toThrow(RangeError);
  });
});

describe('createRateLimiter evictions', () => {
  it('counts and reports keys dropped to stay within maxKeys', () => {
    const onEvict = vi.fn();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, onEvict, now: () => 0 });
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.evictions).toBe(0);
    // A refused key that is already held displaces nothing.
    expect(limiter.consume('b').allowed).toBe(false);
    limiter.consume('c');
    expect(limiter.evictions).toBe(1);
    expect(onEvict).toHaveBeenCalledWith('a');
    limiter.reset('b');
    limiter.clear();
    expect(limiter.evictions).toBe(1);
    const throwing = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 1, onEvict: () => { throw new Error('metrics down'); }, now: () => 0 });
    throwing.consume('a');
    expect(throwing.consume('b').allowed).toBe(true);
    expect(throwing.evictions).toBe(1);
  });
});

describe('spendRequestLimit', () => {
  const trusted = trustedProxies('');

  it('returns a refusal instead of throwing, and limitRequest still throws it', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 2000, now: () => 0 });
    const onLimited = vi.fn();
    const request = { peer: '192.0.2.1', forwardedFor: undefined };
    expect(await spendRequestLimit(limiter, { prefix: 'p:' }, trusted, request, undefined, undefined)).toMatchObject({ result: { allowed: true } });
    const refused = await spendRequestLimit(limiter, { prefix: 'p:', headers: true, onLimited }, trusted, request, undefined, undefined);
    expect(refused.refusal).toMatchObject({ key: 'p:192.0.2.1', retryAfterSeconds: 2, headers: { 'retry-after': '2', 'ratelimit-limit': '1' } });
    expect(HiveError.is(refused.refusal?.error, 'rate_limited')).toBe(true);
    expect(onLimited).toHaveBeenCalledOnce();
    await expect(limitRequest({ limiter, prefix: 'p:' }, trusted, request, undefined, undefined)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(limitRequest({ limiter, prefix: 'q:' }, trusted, request, undefined, undefined)).resolves.toMatchObject({ result: { allowed: true } });
    // No store: the client is still resolved, nothing is spent.
    expect(await spendRequestLimit(undefined, {}, trusted, request, () => 'never', 1)).toEqual({ client: { address: '192.0.2.1', peer: '192.0.2.1', decision: 'direct' }, result: undefined });
  });

  it('passes trustedHops to the client resolution', async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000 });
    const outcome = await spendRequestLimit(limiter, { trustedHops: 1 }, trustedProxies('198.51.100.10'), { peer: '198.51.100.10', forwardedFor: '203.0.113.1, 192.0.2.4' }, undefined, undefined);
    expect(outcome.client).toMatchObject({ address: '192.0.2.4', decision: 'forwarded' });
  });
});

describe('/hono rateLimit per-request limiter and respond', () => {
  const env = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  it('chooses the limiter per request and lets a request through when it returns undefined', async () => {
    const reads = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    const writes = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const cost = vi.fn(() => 1);
    const hono = new Hono<HiveEnv>();
    hono.use('*', honoRateLimit({
      limiter: (c: Context) => (c.req.path === '/health' ? undefined : c.req.method === 'GET' ? reads : writes),
      cost,
    }));
    hono.all('*', c => c.json(getClientAddress(c) ?? null));
    hono.onError(errorHandler());
    const ask = (method: string, path = '/v1/x') => hono.request(path, { method }, env('192.0.2.5'));
    expect((await ask('POST')).status).toBe(200);
    expect((await ask('POST')).status).toBe(429);
    expect((await ask('GET')).status).toBe(200);
    expect((await ask('GET')).status).toBe(200);
    expect((await ask('GET')).status).toBe(429);
    const health = await ask('GET', '/health');
    expect(health.status).toBe(200);
    // The client is still resolved for an unlimited request; cost is not asked for it.
    expect(await health.json()).toMatchObject({ address: '192.0.2.5' });
    expect(cost).toHaveBeenCalledTimes(5);
  });

  it('answers a refusal in the product envelope with the headers already set', async () => {
    const onLimited = vi.fn();
    const hono = new Hono<HiveEnv>();
    hono.use('*', honoRateLimit({
      limiter: createRateLimiter({ limit: 1, windowMs: 30_000, now: () => 0 }),
      headers: true,
      onLimited,
      respond: (c, refusal) => c.json({ error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.', wait: refusal.retryAfterSeconds }, 429),
    }));
    const handler = vi.fn((c: Context) => c.text('ok'));
    hono.get('*', handler);
    expect((await hono.request('/', {}, env('192.0.2.6'))).status).toBe(200);
    const refused = await hono.request('/', {}, env('192.0.2.6'));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(refused.headers.get('ratelimit-remaining')).toBe('0');
    expect(await refused.json()).toEqual({ error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.', wait: 30 });
    expect(handler).toHaveBeenCalledOnce();
    expect(onLimited).toHaveBeenCalledOnce();
  });
});

describe('/node-http rateLimit per-request limiter and respond', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise(resolve => server!.close(resolve));
    server = undefined;
  });
  async function serve(listener: RequestListener): Promise<string> {
    server = createServer(listener);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('chooses the limiter per request and writes the product refusal when given res', async () => {
    const strict = createRateLimiter({ limit: 1, windowMs: 10_000 });
    const respond = vi.fn((_req: IncomingMessage, res: import('node:http').ServerResponse) => {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: false, error: { code: 'RATE_LIMITED' } }));
    });
    const limit = nodeRateLimit({ limiter: (req): RateLimitStore | undefined => (req.url === '/free' ? undefined : strict), respond });
    const base = await serve(hiveHandler(async (req, res) => {
      const outcome = await limit(req, res);
      if (outcome.refusal) return;
      sendJson(res, 200, { limited: outcome.result !== undefined });
    }));
    expect(await (await fetch(`${base}/free`)).json()).toEqual({ limited: false });
    expect(await (await fetch(`${base}/a`)).json()).toEqual({ limited: true });
    const refused = await fetch(`${base}/a`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('10');
    expect(await refused.json()).toEqual({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(respond).toHaveBeenCalledOnce();
  });

  it('still throws the 429 without res, even with respond', async () => {
    const limit = nodeRateLimit({ limiter: createRateLimiter({ limit: 1, windowMs: 1000 }), respond: () => undefined, cost: () => 1 });
    const base = await serve(hiveHandler(async (req, res) => {
      await limit(req);
      sendJson(res, 200, {});
    }));
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(base)).status).toBe(429);
  });
});
