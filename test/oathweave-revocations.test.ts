import { describe, expect, it, vi } from 'vitest';
import type { HiveEvent } from '../src/contracts/index.js';
import { HiveEventFeedError } from '../src/feed/index.js';
import {
  followOathweaveRevocations,
  OATHWEAVE_REVOCATION_RETRY_POLICY,
  parseOathweaveRevocation,
  type FollowOathweaveRevocationsOptions,
} from '../src/oathweave/index.js';

const FEED_URL = 'https://oathweave.example.test/api/v1/hive/events';

let serial = 0;
function sessionRevoked(sid: string, sub = 'user-a'): HiveEvent {
  serial++;
  return {
    id: `oathweave:revocation:e${serial}`,
    product: 'oathweave',
    type: 'session.revoked',
    severity: 'info',
    title: 'Session revoked',
    summary: `A session of user ${sub} was signed out.`,
    occurredAt: '2026-11-26T12:00:00.000Z',
    subject: { actorId: sub },
    link: { product: 'oathweave', path: '/?page=iam-users' },
    sourceRef: `session:${sid}`,
  };
}
function userRevoked(sub: string): HiveEvent {
  return { ...sessionRevoked('unused', sub), type: 'user.sessions_revoked', title: 'All sessions of a user revoked', sourceRef: `user:${sub}` };
}

/** A fake Oathweave feed: cursors are `c<index of the last event served>`, as opaque as the real ones. */
function fakeFeed() {
  const events: unknown[] = [];
  const requests: { url: string; authorization: string | undefined }[] = [];
  let answer: ((url: URL) => Response | undefined) | undefined;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'] });
    const override = answer?.(url);
    if (override) return override;
    const after = url.searchParams.get('after');
    if (after !== null && !/^c\d+$/.test(after)) return Response.json({ error: 'INVALID_CURSOR' }, { status: 400 });
    const start = after === null ? 0 : Number(after.slice(1)) + 1;
    const limit = Number(url.searchParams.get('limit'));
    const data = events.slice(start, start + limit);
    const more = events.length > start + limit;
    return Response.json({ data, nextCursor: more ? `c${start + limit - 1}` : null });
  });
  return {
    events,
    requests,
    fetch: fetch as unknown as typeof globalThis.fetch,
    answerWith(handler: ((url: URL) => Response | undefined) | undefined) { answer = handler; },
  };
}

function fakeVerifier() {
  const calls: string[] = [];
  return {
    calls,
    invalidateSession: vi.fn((sid: string) => { calls.push(`session:${sid}`); return 1; }),
    invalidateSubject: vi.fn((sub: string) => { calls.push(`subject:${sub}`); return 2; }),
  };
}

/** A sleep the test controls: every wait is recorded and ends only on `wake()` or abort. */
function controlledSleep() {
  const waits: number[] = [];
  let wake: (() => void) | undefined;
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    waits.push(ms);
    wake = resolve;
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  return { sleep, waits, wake: () => wake?.() };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function follow(overrides: Partial<FollowOathweaveRevocationsOptions> = {}) {
  const feed = fakeFeed();
  const verifier = fakeVerifier();
  const clock = controlledSleep();
  const options = { verifier, feedUrl: FEED_URL, tokenProvider: () => 'fixture-token', fetch: feed.fetch, sleep: clock.sleep, ...overrides };
  return { feed, verifier, clock, start: () => followOathweaveRevocations(options) };
}

describe('parseOathweaveRevocation', () => {
  it('reads a session or a user from Oathweave revocation events only', () => {
    expect(parseOathweaveRevocation(sessionRevoked('sid-1', 'user-a'))).toEqual({ kind: 'session', sessionId: 'sid-1', subject: 'user-a' });
    const { subject: _subject, ...noSubject } = sessionRevoked('sid-2');
    expect(parseOathweaveRevocation(noSubject)).toEqual({ kind: 'session', sessionId: 'sid-2', subject: undefined });
    expect(parseOathweaveRevocation(userRevoked('user-b'))).toEqual({ kind: 'subject', subject: 'user-b' });
    const { sourceRef: _ref, ...noRef } = sessionRevoked('sid-3');
    for (const event of [
      { ...sessionRevoked('sid'), product: 'hivemem' },
      { ...sessionRevoked('sid'), type: 'session.created' },
      { ...sessionRevoked('sid'), sourceRef: 'user:user-a' },
      { ...sessionRevoked('sid'), sourceRef: 'session:' },
      { ...userRevoked('user-a'), sourceRef: 'session:sid' },
      { ...userRevoked('user-a'), sourceRef: 'user:' },
      noRef,
    ]) expect(parseOathweaveRevocation(event)).toBeUndefined();
  });
});

describe('followOathweaveRevocations', () => {
  it('drops cached answers for revoked sessions and users, sending the bearer token', async () => {
    const { feed, verifier, start } = follow({ onRevocation: vi.fn() });
    feed.events.push(sessionRevoked('sid-1'), { ...sessionRevoked('ignored'), product: 'hivemem', link: { product: 'hivemem', path: '/' } }, { id: 'broken' },
      { ...sessionRevoked('ignored'), type: 'session.created' }, userRevoked('user-b'));
    const follower = start();
    const result = await follower.poll();
    expect(result).toEqual({ applied: 2, pages: 1, cursor: null });
    expect(verifier.calls).toEqual(['session:sid-1', 'subject:user-b']);
    expect(feed.requests[0]).toEqual({ url: `${FEED_URL}?limit=200`, authorization: 'Bearer fixture-token' });
    follower.stop();
    await follower.done;
    expect(follower.stopped).toBe(true);
  });

  it('reports each applied revocation with the number of answers dropped', async () => {
    const onRevocation = vi.fn();
    const { feed, start } = follow({ onRevocation });
    feed.events.push(sessionRevoked('sid-1', 'user-a'), userRevoked('user-a'));
    const follower = start();
    await follower.poll();
    expect(onRevocation.mock.calls.map(call => [call[0], call[1], (call[2] as HiveEvent).sourceRef])).toEqual([
      [{ kind: 'session', sessionId: 'sid-1', subject: 'user-a' }, 1, 'session:sid-1'],
      [{ kind: 'subject', subject: 'user-a' }, 2, 'user:user-a'],
    ]);
    follower.stop();
  });

  it('walks full pages, saves each cursor and applies the trailing page once', async () => {
    const saveCursor = vi.fn();
    const { feed, verifier, clock, start } = follow({ limit: 2, saveCursor });
    feed.events.push(sessionRevoked('s1'), sessionRevoked('s2'), sessionRevoked('s3'), sessionRevoked('s4'), sessionRevoked('s5'));
    const follower = start();
    expect(await follower.poll()).toEqual({ applied: 5, pages: 3, cursor: 'c3' });
    expect(saveCursor.mock.calls).toEqual([['c1'], ['c3']]);
    expect(feed.requests.map(request => new URL(request.url).search)).toEqual(['?limit=2', '?after=c1&limit=2', '?after=c3&limit=2']);

    // The scheduled poll after the interval reads the trailing page again and skips what it applied.
    await settle();
    expect(clock.waits).toEqual([2_000]);
    feed.events.push(sessionRevoked('s6'));
    clock.wake();
    await settle(); await settle();
    expect(verifier.calls).toEqual(['session:s1', 'session:s2', 'session:s3', 'session:s4', 'session:s5', 'session:s6']);
    expect(await follower.poll()).toEqual({ applied: 0, pages: 1, cursor: 'c3' });
    expect(follower.cursor).toBe('c3');
    follower.stop();
    await follower.done;
  });

  it('caps the pages read by one poll', async () => {
    const { feed, start } = follow({ limit: 1, maxPagesPerPoll: 2 });
    feed.events.push(sessionRevoked('s1'), sessionRevoked('s2'), sessionRevoked('s3'));
    const follower = start();
    expect(await follower.poll()).toEqual({ applied: 2, pages: 2, cursor: 'c1' });
    expect(await follower.poll()).toEqual({ applied: 1, pages: 1, cursor: 'c1' });
    follower.stop();
  });

  it('resumes from a saved cursor, else from `after`', async () => {
    const first = follow({ loadCursor: async () => 'c0', after: 'c1' });
    first.feed.events.push(sessionRevoked('s1'), sessionRevoked('s2'), sessionRevoked('s3'));
    const resumed = first.start();
    await resumed.poll();
    expect(first.verifier.calls).toEqual(['session:s2', 'session:s3']);
    resumed.stop();

    const second = follow({ loadCursor: () => null, after: 'c1' });
    second.feed.events.push(sessionRevoked('s1'), sessionRevoked('s2'), sessionRevoked('s3'));
    const fallback = second.start();
    await fallback.poll();
    expect(second.verifier.calls).toEqual(['session:s3']);
    fallback.stop();
  });

  it('starts again from the oldest event when the feed refuses its cursor', async () => {
    const saveCursor = vi.fn();
    const onError = vi.fn();
    const { feed, verifier, clock, start } = follow({ after: 'restored-cursor', saveCursor, onError, random: () => 0.5 });
    feed.events.push(sessionRevoked('s1'));
    const follower = start();
    await settle(); await settle();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'status', status: 400 });
    expect(saveCursor).toHaveBeenCalledWith(null);
    expect(follower.cursor).toBeNull();
    expect(clock.waits).toEqual([750]);
    clock.wake();
    await settle(); await settle();
    expect(verifier.calls).toEqual(['session:s1']);
    follower.stop();
    await follower.done;
  });

  it('forgets the service token after a 401 and backs off', async () => {
    const provider = { token: vi.fn(async () => 'fixture-token'), invalidate: vi.fn() };
    const onError = vi.fn();
    const { feed, clock, start } = follow({ tokenProvider: provider, onError, random: () => 0 });
    feed.answerWith(() => new Response('', { status: 401 }));
    const follower = start();
    await settle(); await settle();
    expect(provider.invalidate).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(HiveEventFeedError);
    expect(String(onError.mock.calls[0]![0])).not.toContain('fixture-token');
    clock.wake();
    await settle(); await settle();
    clock.wake();
    await settle(); await settle();
    // Backoff doubles per consecutive failure: 1 s, 2 s, 4 s (equal jitter at random 0 halves them).
    expect(clock.waits).toEqual([500, 1_000, 2_000]);
    feed.answerWith(undefined);
    clock.wake();
    await settle(); await settle();
    expect(clock.waits.at(-1)).toBe(2_000);
    follower.stop();
    await follower.done;
  });

  it('uses the policy ceiling when the policy gives no further delay', async () => {
    const onError = vi.fn();
    const { feed, clock, start } = follow({ onError, policy: { maxAttempts: 1, baseMs: 10, maxMs: 30_000 } });
    feed.answerWith(() => new Response('', { status: 503 }));
    const follower = start();
    await settle(); await settle();
    expect(clock.waits).toEqual([30_000]);
    expect(OATHWEAVE_REVOCATION_RETRY_POLICY.maxMs).toBe(60_000);
    follower.stop();
  });

  it('survives failing callbacks and cursor stores', async () => {
    const onError = vi.fn(() => { throw new Error('logger down'); });
    const { feed, verifier, start } = follow({
      limit: 1,
      saveCursor: () => { throw new Error('store down'); },
      onRevocation: () => { throw new Error('observer down'); },
      onError,
    });
    feed.events.push(sessionRevoked('s1'), sessionRevoked('s2'));
    const follower = start();
    expect(await follower.poll()).toMatchObject({ applied: 2, cursor: 'c0' });
    expect(verifier.calls).toEqual(['session:s1', 'session:s2']);
    expect(onError.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      new Error('observer down'), new Error('store down'), new Error('observer down'),
    ]);
    follower.stop();
  });

  it('shares one poll between concurrent callers and refuses to poll once stopped', async () => {
    const { feed, start } = follow();
    feed.events.push(sessionRevoked('s1'));
    const follower = start();
    const [a, b] = [follower.poll(), follower.poll()];
    expect(a).toBe(b);
    await a;
    follower.stop();
    await follower.done;
    await expect(follower.poll()).rejects.toThrow('stopped');
  });

  it('stops with its signal, also one aborted before it started', async () => {
    const controller = new AbortController();
    const { start, feed } = follow({ signal: controller.signal });
    const follower = start();
    controller.abort();
    await follower.done;
    expect(follower.stopped).toBe(true);

    const early = follow({ signal: AbortSignal.abort() });
    const stopped = early.start();
    await stopped.done;
    expect(stopped.stopped).toBe(true);
    expect(early.feed.requests).toEqual([]);
    expect(feed.requests.length).toBeLessThanOrEqual(1);
  });

  it('ends quietly when stopped during a request', async () => {
    const onError = vi.fn();
    let release: (() => void) | undefined;
    const { feed, start } = follow({ onError });
    feed.answerWith(() => undefined);
    const slow = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      release = () => resolve(Response.json({ data: [], nextCursor: null }));
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const follower = followOathweaveRevocations({ verifier: fakeVerifier(), feedUrl: FEED_URL, tokenProvider: () => 'fixture-token', fetch: slow as unknown as typeof fetch });
    await settle();
    follower.stop();
    await follower.done;
    expect(onError).not.toHaveBeenCalled();
    expect(release).toBeDefined();
    start().stop();
  });

  it('refuses an insecure feed URL and bad numbers', () => {
    const base = { verifier: fakeVerifier(), tokenProvider: () => 'fixture-token' };
    expect(() => followOathweaveRevocations({ ...base, feedUrl: 'http://oathweave.example.test/api/v1/hive/events' })).toThrow(/feedUrl/);
    expect(() => followOathweaveRevocations({ ...base, feedUrl: 'not a url' })).toThrow(/feedUrl/);
    expect(() => followOathweaveRevocations({ ...base, feedUrl: FEED_URL, intervalMs: -1 })).toThrow(RangeError);
    expect(() => followOathweaveRevocations({ ...base, feedUrl: FEED_URL, limit: 0 })).toThrow(RangeError);
    expect(() => followOathweaveRevocations({ ...base, feedUrl: FEED_URL, maxPagesPerPoll: 1.5 })).toThrow(RangeError);
  });

  it('uses the global fetch by default and accepts a loopback feed for tests', async () => {
    const feed = fakeFeed();
    vi.stubGlobal('fetch', feed.fetch);
    try {
      const loopback = followOathweaveRevocations({ verifier: fakeVerifier(), tokenProvider: () => 'fixture-token', feedUrl: 'http://127.0.0.1:4200/api/v1/hive/events', allowInsecureLoopback: true, timeoutMs: 1_000 });
      await loopback.poll();
      loopback.stop();
      expect(feed.requests[0]?.url).toBe('http://127.0.0.1:4200/api/v1/hive/events?limit=200');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
