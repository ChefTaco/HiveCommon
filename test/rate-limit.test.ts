import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  addressKey, createRateLimiter, enforceRateLimit, normalizeIpAddress, rateLimitError, rateLimitHeaders,
  resolveClientAddress, resolveTrustedProxies, trustedProxies, TRUSTED_PROXY_PRESETS, type RateLimitStore,
} from '../src/rate-limit/index.js';
import { clientAddress, errorHandler, getClientAddress, rateLimit as honoRateLimit, type HiveEnv } from '../src/hono/index.js';
import { clientAddressOf, hiveHandler, rateLimit as nodeRateLimit, sendJson } from '../src/node-http/index.js';
import { HiveError } from '../src/errors/index.js';

describe('normalizeIpAddress', () => {
  it('normalises IPv4, IPv6, mapped, bracketed, ported and zoned forms', () => {
    expect(normalizeIpAddress(' 192.0.2.7 ')).toBe('192.0.2.7');
    expect(normalizeIpAddress('192.0.2.7:51234')).toBe('192.0.2.7');
    expect(normalizeIpAddress('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeIpAddress('::FFFF:c000:0207')).toBe('192.0.2.7');
    expect(normalizeIpAddress('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(normalizeIpAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIpAddress('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeIpAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIpAddress('2001:db8:0:1:0:0:0:1')).toBe('2001:db8:0:1::1');
    expect(normalizeIpAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2:3:4:5:6');
    expect(normalizeIpAddress('2001:0:0:1::1')).toBe('2001:0:0:1::1');
    expect(normalizeIpAddress('2001:0:0:1:0:0:1:1')).toBe('2001::1:0:0:1:1');
    expect(normalizeIpAddress('::')).toBe('::');
    expect(normalizeIpAddress('::1')).toBe('::1');
    expect(normalizeIpAddress('2001:db8::')).toBe('2001:db8::');
    expect(normalizeIpAddress('64:ff9b::192.0.2.1')).toBe('64:ff9b::c000:201');
  });

  it('refuses anything that is not an address', () => {
    for (const value of [undefined, null, '', 'unknown', 'example.test', '192.0.2.300', '1.2.3', 'x'.repeat(80), '[nope]', '2001:db8::1::2']) {
      expect(normalizeIpAddress(value as string | undefined)).toBeUndefined();
    }
  });
});

describe('addressKey', () => {
  it('groups IPv6 clients by prefix and keeps IPv4 addresses', () => {
    expect(addressKey('192.0.2.7')).toBe('192.0.2.7');
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd', { ipv6PrefixLength: 56 })).toBe('2001:db8:1::/56');
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd', { ipv6PrefixLength: 128 })).toBe('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(addressKey('2001:db8:1:2:aaaa::1', { ipv6PrefixLength: 72 })).toBe('2001:db8:1:2:aa00::/72');
    expect(addressKey(' unknown ')).toBe('unknown');
    expect(() => addressKey('::1', { ipv6PrefixLength: 0 })).toThrow(RangeError);
  });
});

describe('trustedProxies', () => {
  it('reads addresses, ranges and presets from a string or a list', () => {
    const proxies = trustedProxies('198.51.100.0/24, 2001:db8::1 loopback');
    expect(proxies.has('198.51.100.9')).toBe(true);
    expect(proxies.has('::ffff:198.51.100.9')).toBe(true);
    expect(proxies.has('198.51.101.9')).toBe(false);
    expect(proxies.has('2001:db8::1')).toBe(true);
    expect(proxies.has('2001:db8::2')).toBe(false);
    expect(proxies.has('127.0.0.1')).toBe(true);
    expect(proxies.has('::1')).toBe(true);
    expect(proxies.has('not an address')).toBe(false);
    expect(proxies.entries).toEqual(['198.51.100.0/24', '2001:db8::1/128', '127.0.0.0/8', '::1/128']);
    const list = trustedProxies(['private', 'LinkLocal']);
    expect(list.has('10.1.2.3')).toBe(true);
    expect(list.has('172.31.0.1')).toBe(true);
    expect(list.has('fd00::5')).toBe(true);
    expect(list.has('169.254.1.1')).toBe(true);
    expect(list.has('203.0.113.1')).toBe(false);
    expect(Object.keys(TRUSTED_PROXY_PRESETS)).toEqual(['loopback', 'private', 'linklocal']);
  });

  it('trusts nothing when empty and refuses bad entries', () => {
    expect(trustedProxies(undefined).entries).toEqual([]);
    expect(trustedProxies('').has('127.0.0.1')).toBe(false);
    expect(trustedProxies(null).entries).toEqual([]);
    for (const bad of ['example.test', '198.51.100.0/33', '2001:db8::/129', '198.51.100.0/8/1', '198.51.100.0/x', 'constructor', '10.0.0.1/']) {
      expect(() => trustedProxies(bad)).toThrow(TypeError);
    }
    expect(() => trustedProxies([42 as unknown as string])).toThrow(TypeError);
  });

  it('resolveTrustedProxies accepts a set or a configuration', () => {
    const set = trustedProxies('loopback');
    expect(resolveTrustedProxies(set)).toBe(set);
    expect(resolveTrustedProxies('192.0.2.1').has('192.0.2.1')).toBe(true);
    expect(resolveTrustedProxies(undefined).entries).toEqual([]);
  });
});

describe('resolveClientAddress', () => {
  const trusted = trustedProxies('10.0.0.0/8, 198.51.100.1');

  it('uses the peer when it is not a trusted proxy, whatever X-Forwarded-For says', () => {
    expect(resolveClientAddress({ peer: '203.0.113.5', forwardedFor: '192.0.2.1', trusted })).toEqual({ address: '203.0.113.5', peer: '203.0.113.5', decision: 'direct' });
  });

  it('reads X-Forwarded-For from the right, past trusted hops', () => {
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: '192.0.2.1', trusted })).toMatchObject({ address: '192.0.2.1', decision: 'forwarded' });
    expect(resolveClientAddress({ peer: '::ffff:10.0.0.2', forwardedFor: '192.0.2.1, 198.51.100.1, 10.0.0.9', trusted })).toMatchObject({ address: '192.0.2.1', peer: '10.0.0.2' });
    // A client cannot forge its way past the first untrusted hop, nor break it with garbage on the left.
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: 'garbage, 10.0.0.7, 203.0.113.9', trusted })).toMatchObject({ address: '203.0.113.9', decision: 'forwarded' });
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: ['192.0.2.1', '203.0.113.9:4000'], trusted })).toMatchObject({ address: '203.0.113.9' });
    // Every hop trusted: an internal caller, attributed to the leftmost.
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: '10.0.0.3, 10.0.0.4', trusted })).toMatchObject({ address: '10.0.0.3', decision: 'forwarded' });
  });

  it('falls back to the last trusted hop when the chain is missing, broken or too long', () => {
    expect(resolveClientAddress({ peer: '10.0.0.2', trusted })).toMatchObject({ address: '10.0.0.2', decision: 'proxy_without_forwarding' });
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: ' ', trusted })).toMatchObject({ decision: 'proxy_without_forwarding' });
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: null, trusted })).toMatchObject({ decision: 'proxy_without_forwarding' });
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: '192.0.2.1, 10.0.0.5, unknown', trusted })).toMatchObject({ address: '10.0.0.2', decision: 'invalid_forwarding' });
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: '192.0.2.1, nope, 10.0.0.5', trusted })).toMatchObject({ address: '10.0.0.5', decision: 'invalid_forwarding' });
    const long = Array.from({ length: 40 }, (_, index) => `10.0.1.${index}`).join(',');
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: `192.0.2.1,${long}`, trusted })).toMatchObject({ decision: 'invalid_forwarding' });
    expect(resolveClientAddress({ peer: '10.0.0.2', forwardedFor: '192.0.2.1, 10.0.0.5, 10.0.0.6', trusted, maxHops: 2 })).toMatchObject({ address: '10.0.0.5', decision: 'invalid_forwarding' });
  });

  it('never invents a client when the peer is unknown', () => {
    expect(resolveClientAddress({ peer: undefined, forwardedFor: '192.0.2.1', trusted })).toEqual({ address: 'unknown', peer: undefined, decision: 'unknown_peer' });
  });
});

describe('createRateLimiter', () => {
  it('spends a burst, refills continuously and spends nothing on refusal', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, burst: 3, now: () => now });
    expect(limiter.consume('a')).toEqual({ allowed: true, limit: 3, remaining: 2, retryAfterMs: 0, resetMs: 500 });
    limiter.consume('a');
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 0, resetMs: 1500 });
    expect(limiter.consume('a')).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 500 });
    now = 499;
    expect(limiter.consume('a').allowed).toBe(false);
    now = 500;
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('b', 3)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.peek('b')).toMatchObject({ remaining: 0 });
    now = 10_000;
    expect(limiter.peek('a')).toMatchObject({ remaining: 3, resetMs: 0 });
    expect(limiter.size).toBe(2);
    limiter.reset('a');
    expect(limiter.size).toBe(1);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  it('drops the least recently used key past maxKeys', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: () => 0 });
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.consume('a').allowed).toBe(false);
    limiter.consume('c');
    expect(limiter.size).toBe(2);
    expect(limiter.peek('a').remaining).toBe(0);
    expect(limiter.peek('b').remaining).toBe(1);
  });

  it('validates its options and arguments', () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 1, windowMs: Number.NaN })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 1, windowMs: 1, maxKeys: 1.5 })).toThrow(/integer/);
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(() => limiter.consume('a', 2)).toThrow(/burst/);
    expect(() => limiter.consume('a', -1)).toThrow(RangeError);
    expect(() => limiter.consume(1 as unknown as string)).toThrow(TypeError);
    expect(limiter.consume('real-clock').allowed).toBe(true);
  });
});

describe('responses', () => {
  const refused = { allowed: false, limit: 5, remaining: 0, retryAfterMs: 1200, resetMs: 9100 };

  it('builds the 429 envelope with Retry-After', () => {
    const error = rateLimitError(refused);
    expect(error).toBeInstanceOf(HiveError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', headers: { 'retry-after': '2' }, details: { retryAfterSeconds: 2 } });
    expect(rateLimitError({ ...refused, retryAfterMs: 0 }).headers).toEqual({ 'retry-after': '1' });
    expect(rateLimitError(refused, { headers: true }).headers).toEqual({ 'ratelimit-limit': '5', 'ratelimit-remaining': '0', 'ratelimit-reset': '10', 'retry-after': '2' });
    expect(rateLimitHeaders({ ...refused, resetMs: -5 })['ratelimit-reset']).toBe('0');
  });

  it('enforceRateLimit spends from any store and throws when refused', async () => {
    const store: RateLimitStore = { consume: vi.fn(async () => refused) };
    await expect(enforceRateLimit(store, 'account:alice', 2)).rejects.toMatchObject({ status: 429 });
    expect(store.consume).toHaveBeenCalledWith('account:alice', 2);
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    await expect(enforceRateLimit(limiter, 'k')).resolves.toMatchObject({ allowed: true });
    await expect(enforceRateLimit(limiter, 'k', 1, { headers: true })).rejects.toMatchObject({ headers: { 'ratelimit-limit': '1' } });
  });
});

describe('/hono rateLimit', () => {
  const env = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  function app(options: Partial<Parameters<typeof honoRateLimit>[0]> = {}) {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    const onLimited = vi.fn();
    const hono = new Hono<HiveEnv>();
    hono.use('/v1/*', honoRateLimit({ limiter, trustedProxies: '10.0.0.0/8', onLimited, ...options }));
    hono.get('/v1/who', c => c.json(getClientAddress(c) ?? null));
    hono.get('/open', c => c.json(clientAddress(c, trustedProxies('10.0.0.0/8'))));
    hono.onError(errorHandler());
    return { hono, limiter, onLimited };
  }

  it('limits per client behind a trusted proxy and answers 429 with Retry-After', async () => {
    const { hono, onLimited } = app({ headers: true, prefix: 'api:' });
    const ask = (forwarded: string) => hono.request('/v1/who', { headers: { 'x-forwarded-for': forwarded } }, env('10.0.0.2'));
    const first = await ask('192.0.2.1');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ address: '192.0.2.1', peer: '10.0.0.2', decision: 'forwarded' });
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    await ask('192.0.2.1');
    const refused = await ask('192.0.2.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(refused.headers.get('ratelimit-limit')).toBe('2');
    expect(await refused.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests', details: { retryAfterSeconds: 30 } } });
    expect(onLimited).toHaveBeenCalledWith(expect.objectContaining({ key: 'api:192.0.2.1' }));
    // Another client behind the same proxy has its own budget.
    expect((await ask('192.0.2.2')).status).toBe(200);
  });

  it('uses the socket peer directly, a custom key, cost and peer reader', async () => {
    const direct = app();
    expect(await (await direct.hono.request('/v1/who', { headers: { 'x-forwarded-for': '192.0.2.1' } }, env('203.0.113.4'))).json()).toMatchObject({ address: '203.0.113.4', decision: 'direct' });
    expect((await direct.hono.request('/v1/who')).status).toBe(200);
    expect(await (await direct.hono.request('/open', {}, env('10.0.0.2'))).json()).toMatchObject({ decision: 'proxy_without_forwarding' });

    const keyed = app({ key: c => c.req.header('x-tenant'), cost: () => 2, peerAddress: () => '192.0.2.9' });
    expect((await keyed.hono.request('/v1/who')).status).toBe(200); // no tenant: not limited
    expect((await keyed.hono.request('/v1/who')).status).toBe(200);
    expect((await keyed.hono.request('/v1/who', { headers: { 'x-tenant': 't1' } })).status).toBe(200);
    expect((await keyed.hono.request('/v1/who', { headers: { 'x-tenant': 't1' } })).status).toBe(429);
    expect(keyed.limiter.size).toBe(1);
    const costly = app({ cost: 2 });
    expect((await costly.hono.request('/v1/who', {}, env('192.0.2.3'))).status).toBe(200);
    expect((await costly.hono.request('/v1/who', {}, env('192.0.2.3'))).status).toBe(429);
  });
});

describe('/node-http rateLimit', () => {
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

  it('limits requests inside hiveHandler and trusts only configured proxies', async () => {
    const limit = nodeRateLimit({ limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }), trustedProxies: 'loopback', headers: true });
    const base = await serve(hiveHandler(async (req, res) => {
      const { client } = await limit(req, res);
      sendJson(res, 200, { client, again: clientAddressOf(req, trustedProxies('')) });
    }));
    const first = await fetch(base, { headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-remaining')).toBe('0');
    expect(await first.json()).toMatchObject({ client: { address: '198.51.100.20', decision: 'forwarded' }, again: { address: '127.0.0.1', decision: 'direct' } });
    const second = await fetch(base, { headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    expect(await second.json()).toMatchObject({ error: { code: 'rate_limited', details: { retryAfterSeconds: 60 } } });
    expect((await fetch(base, { headers: { 'x-forwarded-for': '198.51.100.21' } })).status).toBe(200);
  });

  it('supports a custom key and cost, and works without a response', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const limit = nodeRateLimit({ limiter, key: req => (req.url === '/skip' ? undefined : 'shared'), cost: () => 2, headers: true });
    const base = await serve(hiveHandler(async (req, res) => {
      const outcome = await limit(req);
      sendJson(res, 200, { limited: outcome.result !== undefined });
    }));
    expect(await (await fetch(`${base}/skip`)).json()).toEqual({ limited: false });
    expect(await (await fetch(`${base}/a`)).json()).toEqual({ limited: true });
    expect((await fetch(`${base}/b`)).status).toBe(429);
    const plain = nodeRateLimit({ limiter: createRateLimiter({ limit: 1, windowMs: 1000 }), cost: 1 });
    const other = await new Promise<string>(resolve => {
      const extra = createServer(hiveHandler(async (req, res) => { await plain(req, res); sendJson(res, 200, {}); }));
      extra.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(extra.address() as AddressInfo).port}`));
      setTimeout(() => extra.close(), 2000).unref();
    });
    const response = await fetch(other);
    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-limit')).toBeNull();
  });
});
