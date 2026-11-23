import { describe, expect, it, vi } from 'vitest';
import { followSse, parseSseBlock, SseStatusError, type SseEvent } from '../src/sse/index.js';

function stream(chunks: string[], { fail = false } = {}): Response {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else if (fail) controller.error(new Error('connection reset'));
      else controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const fast = { maxAttempts: Number.MAX_SAFE_INTEGER, baseMs: 1, maxMs: 2, jitter: 'none' as const };

describe('parseSseBlock', () => {
  it('reads fields, multi-line data and ignores comments', () => {
    expect(parseSseBlock('id: 3\nevent: task.event\ndata: {"a":1}')).toEqual({ id: '3', event: 'task.event', data: '{"a":1}' });
    expect(parseSseBlock('data: one\ndata: two')).toEqual({ event: 'message', data: 'one\ntwo' });
    expect(parseSseBlock(': heartbeat')).toBeUndefined();
    expect(parseSseBlock('data')).toEqual({ event: 'message', data: '' });
    expect(parseSseBlock('id: a\0b\nretry: 5')).toBeUndefined();
  });
});

describe('followSse', () => {
  it('reconnects with the last event id until a terminal event', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(stream(['id: 1\nevent: task.event\ndata: a\n\n', 'id: 2\nevent: task.event\nda', 'ta: b\n\n'], { fail: true }))
      .mockResolvedValueOnce(stream([': hb\n\n']))
      .mockResolvedValueOnce(stream(['id: 3\r\nevent: task.done\r\ndata: c\r\n\r\n']));
    const events: SseEvent[] = [];
    const result = await followSse('https://ardent.example.test/api/v1/tasks/t/stream', {
      fetch: fetcher, after: '0', cursorParam: 'after', policy: fast, headers: async () => ({ authorization: 'Bearer fixture-token' }),
      onEvent: event => { events.push(event); }, isTerminal: event => event.event === 'task.done',
    });
    expect(events.map(event => event.data)).toEqual(['a', 'b', 'c']);
    expect(result).toEqual({ cursor: '3', reconnects: 2, terminal: { id: '3', event: 'task.done', data: 'c' } });
    const calls = fetcher.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual([
      'https://ardent.example.test/api/v1/tasks/t/stream?after=0',
      'https://ardent.example.test/api/v1/tasks/t/stream?after=2',
      'https://ardent.example.test/api/v1/tasks/t/stream?after=2',
    ]);
    expect(calls[1]![1].headers).toMatchObject({ 'last-event-id': '2', authorization: 'Bearer fixture-token', accept: 'text/event-stream' });
  });

  it('keeps relative URLs relative and works without a cursor', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => stream(['event: done\ndata: x\n\n']));
    await followSse('/stream?x=1', { fetch: fetcher, cursorParam: 'after', onEvent: () => undefined, isTerminal: () => true });
    expect(fetcher.mock.calls[0]![0]).toBe('/stream?x=1');
    await followSse('/stream', { fetch: fetcher, after: '5', cursorParam: 'after', onEvent: () => undefined, isTerminal: () => true });
    expect(fetcher.mock.calls[1]![0]).toBe('/stream?after=5');
  });

  it('stops on a permanent status and retries a transient one', async () => {
    await expect(followSse('/s', { fetch: vi.fn().mockResolvedValue(new Response('no', { status: 404 })), onEvent: () => undefined })).rejects.toBeInstanceOf(SseStatusError);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(stream(['event: done\ndata: x\n\n']));
    const result = await followSse('/s', { fetch: fetcher, policy: fast, onEvent: () => undefined, isTerminal: () => true });
    expect(result.reconnects).toBe(1);
  });

  it('gives up after repeated failures and honours abort', async () => {
    await expect(followSse('/s', { fetch: vi.fn().mockRejectedValue(new Error('refused')), policy: fast, maxFailures: 3, onEvent: () => undefined })).rejects.toThrow('refused');
    await expect(followSse('/s', { fetch: vi.fn(async () => stream([])), policy: fast, maxFailures: 2, onEvent: () => undefined })).rejects.toThrow('kept closing');
    await expect(followSse('/s', { fetch: vi.fn(async () => new Response(null)), policy: fast, maxFailures: 1, onEvent: () => undefined })).rejects.toThrow('no body');
    const controller = new AbortController();
    const fetcher = vi.fn(async () => { controller.abort(new Error('user left')); throw new Error('aborted fetch'); });
    await expect(followSse('/s', { fetch: fetcher, signal: controller.signal, onEvent: () => undefined })).rejects.toThrow('aborted fetch');
    await expect(followSse('/s', { fetch: fetcher, signal: controller.signal, onEvent: () => undefined })).rejects.toThrow('user left');
  });
});
