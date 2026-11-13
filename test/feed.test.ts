import { describe, expect, it, vi } from 'vitest';
import { HiveEventFeedError, readHiveEventFeed, type HiveEventFeedProgress } from '../src/feed/index.js';
import { EVENT } from './fixtures/event.js';

const FEED = '/api/hiveskills/v1/hive/events';
const event = (id: string, extra: Record<string, unknown> = {}) => ({ ...EVENT, id, ...extra });
const page = (data: unknown[], nextCursor: string | null) => Response.json({ data, nextCursor });

function feed(answers: Array<() => Response | Promise<Response>>) {
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const next = answers.shift();
    if (!next) throw new Error('no page queued');
    return next();
  });
}

async function failure(promise: Promise<unknown>): Promise<HiveEventFeedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HiveEventFeedError);
    return error as HiveEventFeedError;
  }
  throw new Error('expected a HiveEventFeedError');
}

describe('readHiveEventFeed', () => {
  it('reads pages until the feed is caught up', async () => {
    const request = feed([() => page([event('e1'), event('e2')], 'cursor-1'), () => page([event('e3')], null)]);
    const controller = new AbortController();
    const result = await readHiveEventFeed(request, FEED, { signal: controller.signal });
    expect(result.events.map(item => item.id)).toEqual(['e1', 'e2', 'e3']);
    expect(result).toMatchObject({ cursor: 'cursor-1', dropped: 0, pages: 2, caughtUp: true });
    expect(request.mock.calls.map(call => call[0])).toEqual([`${FEED}?limit=200`, `${FEED}?after=cursor-1&limit=200`]);
    expect(request.mock.calls[0]![1]).toEqual({ cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
  });

  it('starts after a cursor and honours limit, headers and existing queries', async () => {
    const request = feed([() => page([], null), () => page([], null), () => page([], null)]);
    await readHiveEventFeed(request, `${FEED}?scope=all#top`, { after: 'c0', limit: 50, headers: { Accept: 'application/json;v=1', 'x-request-id': 'req-1' } });
    expect(request.mock.calls[0]![0]).toBe(`${FEED}?scope=all&after=c0&limit=50`);
    expect(request.mock.calls[0]![1]).toEqual({ cache: 'no-store', headers: { Accept: 'application/json;v=1', 'x-request-id': 'req-1' } });
    await readHiveEventFeed(request, `${FEED}?`, { after: '' });
    expect(request.mock.calls[1]![0]).toBe(`${FEED}?limit=200`);
    await readHiveEventFeed(request, `${FEED}?a=1&`, { after: null });
    expect(request.mock.calls[2]![0]).toBe(`${FEED}?a=1&limit=200`);
  });

  it('stops at maxPages and reports that more remains', async () => {
    const request = feed([() => page([event('e1')], 'c1'), () => page([event('e2')], 'c2'), () => page([event('e3')], 'c3')]);
    const result = await readHiveEventFeed(request, FEED, { maxPages: 2 });
    expect(result).toMatchObject({ cursor: 'c2', pages: 2, caughtUp: false });
    expect(result.events).toHaveLength(2);
  });

  it('drops invalid events and other products\' events one by one', async () => {
    const request = feed([() => page([event('e1'), { id: 'broken' }, event('e2', { product: 'embermend', link: { product: 'embermend', path: '/' } }), event('e3', { internal: 'x' }), event('e4')], null)]);
    const result = await readHiveEventFeed(request, FEED, { product: EVENT.product, accept: item => item.id !== 'e4' });
    expect(result.events.map(item => item.id)).toEqual(['e1', 'e3']);
    expect(result.events[1]).not.toHaveProperty('internal');
    expect(result.dropped).toBe(3);
  });

  it('continues a progress object in place and keeps earlier pages when a later one fails', async () => {
    const progress: HiveEventFeedProgress = { events: [], cursor: 'c0', dropped: 0 };
    const request = feed([() => page([event('e1')], 'c1'), () => new Response('nope', { status: 503 })]);
    const error = await failure(readHiveEventFeed(request, FEED, { progress, after: 'ignored' }));
    expect(error).toMatchObject({ kind: 'status', status: 503, message: 'The feed answered with an error status (HTTP 503)' });
    expect(error.progress).toBe(progress);
    expect(progress.events.map(item => item.id)).toEqual(['e1']);
    expect(progress.cursor).toBe('c1');
    expect(request.mock.calls[0]![0]).toBe(`${FEED}?after=c0&limit=200`);
  });

  it('names network, malformed and aborted failures', async () => {
    expect((await failure(readHiveEventFeed(feed([() => { throw new TypeError('fetch failed'); }]), FEED))).kind).toBe('network');
    expect((await failure(readHiveEventFeed(feed([() => new Response('<html>')]), FEED))).kind).toBe('malformed');
    expect((await failure(readHiveEventFeed(feed([() => Response.json({ data: [], nextCursor: '' })]), FEED))).kind).toBe('malformed');
    expect((await failure(readHiveEventFeed(feed([() => Response.json({ items: [] })]), FEED))).kind).toBe('malformed');
    const aborted = AbortSignal.abort();
    expect((await failure(readHiveEventFeed(feed([() => { throw aborted.reason; }]), FEED, { signal: aborted }))).kind).toBe('aborted');
    expect((await failure(readHiveEventFeed(feed([() => new Response('<html>')]), FEED, { signal: aborted }))).kind).toBe('aborted');
    expect((await failure(readHiveEventFeed(feed([() => new Response('', { status: 401 })]), FEED, { signal: aborted }))).kind).toBe('status');
    const plain = new HiveEventFeedError('status', { events: [], cursor: null, dropped: 0 });
    expect(plain.message).toBe('The feed answered with an error status');
  });

  it('bounds the size of a page when asked', async () => {
    const big = () => page(Array.from({ length: 20 }, (_, index) => event(`e${index}`)), null);
    expect((await failure(readHiveEventFeed(feed([big]), FEED, { maxPageBytes: 200 }))).kind).toBe('malformed');
    const ok = await readHiveEventFeed(feed([big]), FEED, { maxPageBytes: 100_000, signal: new AbortController().signal });
    expect(ok.events).toHaveLength(20);
    expect((await readHiveEventFeed(feed([big]), FEED, { maxPageBytes: 100_000 })).events).toHaveLength(20);
  });

  it('validates limit and maxPages', async () => {
    await expect(readHiveEventFeed(feed([]), FEED, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(readHiveEventFeed(feed([]), FEED, { maxPages: 1.5 })).rejects.toThrow(RangeError);
  });
});
