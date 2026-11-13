import { describe, expect, it, vi } from 'vitest';
import {
  ChatterMostNotifier, decodeCursor, encodeCursor, feedPage, formatChatterMostMessage, HIVE_EVENTS_PATH, MemoryDedupeStore,
  parseFeedQuery, type ChatterMostNotifierOptions,
} from '../src/events/index.js';
import { HiveError } from '../src/errors/index.js';
import { EVENT } from './fixtures/event.js';

const WEBHOOK = 'https://chat.example.com/hooks/fixture-hook-id';

describe('feed helpers', () => {
  it('parses after and limit', () => {
    expect(HIVE_EVENTS_PATH).toBe('/v1/hive/events');
    expect(parseFeedQuery(new URLSearchParams(''))).toEqual({ after: undefined, limit: 50 });
    expect(parseFeedQuery(new URLSearchParams('after=c1&limit=10'))).toEqual({ after: 'c1', limit: 10 });
    expect(parseFeedQuery({ limit: '1000' })).toEqual({ after: undefined, limit: 200 });
    expect(parseFeedQuery({ limit: '5', after: ['c2'] }, { defaultLimit: 20, maxLimit: 5 })).toEqual({ after: 'c2', limit: 5 });
    expect(parseFeedQuery({ after: '', limit: '' })).toEqual({ after: undefined, limit: 50 });
  });

  it.each([['limit=0'], ['limit=-1'], ['limit=abc'], ['limit=1.5'], ['after=%20bad'], ['limit=1&limit=2']])('rejects %s', query => {
    expect(() => parseFeedQuery(new URLSearchParams(query))).toThrow(HiveError);
  });

  it('rejects repeated record values', () => {
    expect(() => parseFeedQuery({ after: ['a', 'b'] })).toThrow(/once/);
  });

  it('builds pages with a next cursor only when more items exist', () => {
    const items = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
    expect(feedPage(items, 2, item => String(item.seq))).toEqual({ data: [{ seq: 1 }, { seq: 2 }], nextCursor: '2' });
    expect(feedPage(items, 3, item => String(item.seq))).toEqual({ data: items, nextCursor: null });
    expect(feedPage([], 3, () => 'x')).toEqual({ data: [], nextCursor: null });
    expect(() => feedPage(items, 0, () => 'x')).toThrow(RangeError);
  });

  it('round-trips opaque cursors and rejects tampering', () => {
    const cursor = encodeCursor({ seq: 42, at: '2026-11-12T00:00:00Z', name: 'ünï' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ seq: 42, at: '2026-11-12T00:00:00Z', name: 'ünï' });
    expect(parseFeedQuery({ after: cursor }).after).toBe(cursor);
    for (const bad of ['!!', encodeCursor({}).slice(0, 1), btoa('[1]'), btoa('{"a":{}}'), btoa('null')]) {
      expect(() => decodeCursor(bad.replace(/=+$/, ''))).toThrow(expect.objectContaining({ code: 'invalid_cursor' }) as Error);
    }
  });
});

describe('MemoryDedupeStore', () => {
  it('claims once per TTL and can release', () => {
    let now = 0;
    const store = new MemoryDedupeStore({ now: () => now });
    expect(store.claim('a', 100)).toBe(true);
    expect(store.claim('a', 100)).toBe(false);
    now = 100;
    expect(store.claim('a', 100)).toBe(true);
    store.release('a');
    expect(store.claim('a', 100)).toBe(true);
  });

  it('is bounded, evicting expired entries first', () => {
    let now = 0;
    const store = new MemoryDedupeStore({ maxEntries: 2, now: () => now });
    store.claim('old', 10);
    store.claim('b', 1000);
    now = 20;
    store.claim('c', 1000);
    expect(store.size).toBe(2);
    expect(store.claim('b', 1000)).toBe(false);
    store.claim('d', 1000);
    expect(store.size).toBe(2);
    expect(store.claim('b', 1000)).toBe(true);
  });
});

describe('feed and dedupe limits', () => {
  it('never defaults above maxLimit', () => {
    expect(parseFeedQuery(new URLSearchParams(''), { maxLimit: 10 })).toEqual({ after: undefined, limit: 10 });
    expect(parseFeedQuery({}, { defaultLimit: 500 }).limit).toBe(200);
  });

  it('rejects a cursor holding a non-finite number', () => {
    const cursor = Buffer.from('{"offset":1e999}').toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow(expect.objectContaining({ code: 'invalid_cursor', status: 400 }) as Error);
  });

  it('refuses a dedupe store that could hold nothing', () => {
    // maxEntries 0 used to make claim() loop forever.
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) expect(() => new MemoryDedupeStore({ maxEntries })).toThrow(RangeError);
    const store = new MemoryDedupeStore({ maxEntries: 1 });
    expect(store.claim('a', 1000)).toBe(true);
    expect(store.claim('b', 1000)).toBe(true);
    expect(store.size).toBe(1);
  });
});

describe('formatChatterMostMessage', () => {
  it('formats severity, title, summary and an absolute link', () => {
    const text = formatChatterMostMessage(EVENT, { linkBaseUrl: 'https://hive.example.com' });
    expect(text).toBe(':warning: **magnus: Task failed**\nThe nightly sync task failed twice.\n[Open in magnus](https://hive.example.com/agents/node-a~writer?tab=tasks)');
  });

  it('neutralises markdown, mentions and links in event text', () => {
    const text = formatChatterMostMessage({ ...EVENT, severity: 'critical', title: '@channel [click](https://evil.example.com) *now*', summary: '' });
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('@​channel');
    expect(text).toContain('\\[click\\]\\(https://evil.example.com\\)');
    expect(text).toContain('magnus: `/agents/node-a~writer?tab=tasks`');
    expect(formatChatterMostMessage({ ...EVENT, severity: 'info', link: { product: 'magnus', path: '/a(b)' } }, { linkBaseUrl: 'https://hive.example.com' }))
      .toContain(':information_source:');
  });
});

function notifier(options: Partial<ChatterMostNotifierOptions> = {}, responses: Array<Response | Error> = [new Response('ok')]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sleeps: number[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  const instance = new ChatterMostNotifier({
    webhookUrl: WEBHOOK, fetch: fetcher, sleep: async ms => { sleeps.push(ms); }, random: () => 1, ...options,
  });
  return { instance, calls, sleeps };
}

describe('ChatterMostNotifier', () => {
  it('validates its configuration without echoing the webhook URL', () => {
    expect(() => new ChatterMostNotifier({ webhookUrl: 'http://chat.example.com/hooks/abc' })).toThrow(/must use https/);
    try {
      new ChatterMostNotifier({ webhookUrl: 'http://chat.example.com/hooks/abc' });
    } catch (error) {
      expect((error as Error).message).not.toContain('hooks/abc');
    }
    expect(() => new ChatterMostNotifier({ webhookUrl: 'http://127.0.0.1:8065/hooks/x', allowInsecureLoopback: true })).not.toThrow();
    expect(() => new ChatterMostNotifier({ webhookUrl: WEBHOOK, linkBaseUrl: 'ftp://hive.example.com' })).toThrow(/linkBaseUrl/);
  });

  it('posts a Mattermost payload once and deduplicates by event ID', async () => {
    const { instance, calls } = notifier({ username: 'Hive', iconUrl: 'https://hive.example.com/icon.png', channel: 'alerts', linkBaseUrl: 'https://hive.example.com' });
    expect(await instance.notify(EVENT)).toEqual({ status: 'sent', attempts: 1 });
    expect(await instance.notify(EVENT)).toEqual({ status: 'duplicate', attempts: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ username: 'Hive', icon_url: 'https://hive.example.com/icon.png', channel: 'alerts', props: { hive_event: { id: 'evt-01', product: 'magnus', type: 'agent.task.failed', severity: 'warning' } } });
    expect(body['text']).toContain('Task failed');
  });

  it('uses a custom formatter', async () => {
    const { instance, calls } = notifier({ format: event => ({ text: `custom ${event.id}` }) });
    await instance.notify(EVENT);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: 'custom evt-01' });
  });

  it('does not claim an event whose formatter throws, so a later call can deliver it', async () => {
    let fail = true;
    const { instance, calls } = notifier({ format: event => { if (fail) throw new Error('formatter bug'); return { text: event.id }; } });
    await expect(instance.notify(EVENT)).rejects.toThrow('formatter bug');
    fail = false;
    expect(await instance.notify(EVENT)).toEqual({ status: 'sent', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid events before sending', async () => {
    const { instance, calls } = notifier();
    await expect(instance.notify({ ...EVENT, severity: 'loud' as never })).rejects.toMatchObject({ code: 'validation_failed', status: 422 });
    expect(calls).toHaveLength(0);
  });

  it('retries 5xx, 429 and network failures with backoff, honouring Retry-After', async () => {
    const { instance, calls, sleeps } = notifier({ backoffMs: 100, maxBackoffMs: 1000 }, [
      new Response('', { status: 503 }),
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      new TypeError('fetch failed'),
      new Response('ok'),
    ]);
    expect(await instance.notify(EVENT)).toEqual({ status: 'sent', attempts: 4 });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 1000, 400]);
  });

  it('honours an HTTP-date Retry-After and ignores a bad one', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const { instance, sleeps } = notifier({ backoffMs: 10, maxBackoffMs: 100_000, retries: 2 }, [
      new Response('', { status: 503, headers: { 'retry-after': date } }),
      new Response('', { status: 503, headers: { 'retry-after': 'soon' } }),
      new Response('ok'),
    ]);
    await instance.notify(EVENT);
    expect(sleeps[0]).toBeGreaterThan(50_000);
    expect(sleeps[1]).toBe(20);
  });

  it('does not retry other 4xx, and releases the claim so a later call can retry', async () => {
    const { instance, calls } = notifier({}, [new Response('', { status: 400 }), new Response('ok')]);
    expect(await instance.notify(EVENT)).toEqual({ status: 'failed', attempts: 1, error: 'HTTP 400', httpStatus: 400 });
    expect(calls).toHaveLength(1);
    expect(await instance.notify(EVENT)).toEqual({ status: 'sent', attempts: 1 });
  });

  it('gives up after the retry budget and reports timeouts', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { instance, calls } = notifier({ retries: 2 }, [timeout]);
    expect(await instance.notify(EVENT)).toEqual({ status: 'failed', attempts: 3, error: 'timeout' });
    expect(calls).toHaveLength(3);
    const network = notifier({ retries: 0 }, [new TypeError('x')]);
    expect(await network.instance.notify(EVENT)).toEqual({ status: 'failed', attempts: 1, error: 'network error' });
  });

  it('uses a pluggable dedupe store', async () => {
    const store = { claim: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    const { instance } = notifier({ dedupe: store, dedupeTtlMs: 5 }, [new Response('', { status: 404 })]);
    await instance.notify(EVENT);
    expect(store.claim).toHaveBeenCalledWith('hive-event:magnus:evt-01', 5);
    expect(store.release).toHaveBeenCalledWith('hive-event:magnus:evt-01');
  });

  it('uses global fetch and real sleep by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      expect(await new ChatterMostNotifier({ webhookUrl: WEBHOOK, retries: 0 }).notify(EVENT)).toEqual({ status: 'sent', attempts: 1 });
      spy.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('ok'));
      const result = await new ChatterMostNotifier({ webhookUrl: WEBHOOK, retries: 1, backoffMs: 1 }).notify({ ...EVENT, id: 'evt-02' });
      expect(result).toEqual({ status: 'sent', attempts: 2 });
    } finally {
      spy.mockRestore();
    }
  });
});
