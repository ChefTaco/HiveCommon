import { describe, expect, it, vi } from 'vitest';
import {
  followSse, parseSseBlock, SseEventTooLargeError, SseHandlerError, SseIdleTimeoutError, SseStatusError, type SseEvent,
} from '../src/sse/index.js';

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

/** A stream that records whether it was cancelled, and can stay open after its chunks. */
function tracked(chunks: Array<string | Uint8Array>, { hang = false } = {}): { response: Response; cancelled: () => boolean } {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next);
      else if (hang) return new Promise<void>(() => undefined);
      else controller.close();
      return undefined;
    },
    cancel() { cancelled = true; },
  }));
  return { response, cancelled: () => cancelled };
}

describe('followSse handler errors', () => {
  it('stops with an SseHandlerError holding the last handled cursor, and releases the connection', async () => {
    const source = tracked(['id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n'], { hang: true });
    const fetcher = vi.fn(async () => source.response);
    const seen: string[] = [];
    const failure = await followSse('/s', {
      fetch: fetcher, policy: fast,
      onEvent: event => { if (event.id === '2') throw new Error('store down'); seen.push(event.data); },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SseHandlerError);
    const handlerError = failure as SseHandlerError;
    expect(handlerError.cursor).toBe('1');
    expect(handlerError.event).toEqual({ id: '2', event: 'message', data: 'b' });
    expect((handlerError.cause as Error).message).toBe('store down');
    expect(seen).toEqual(['a']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(source.cancelled()).toBe(true);
  });

  it('treats a throwing isTerminal like a handler error', async () => {
    const source = tracked(['id: 9\ndata: x\n\n']);
    const failure = await followSse('/s', {
      fetch: async () => source.response, after: '8', onEvent: () => undefined,
      isTerminal: () => { throw new Error('bad predicate'); },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SseHandlerError);
    expect((failure as SseHandlerError).cursor).toBe('8');
  });

  it('cancels the body after a terminal event', async () => {
    const source = tracked(['data: done\n\n'], { hang: true });
    await followSse('/s', { fetch: async () => source.response, onEvent: () => undefined, isTerminal: () => true });
    expect(source.cancelled()).toBe(true);
  });
});

describe('followSse parsing and limits', () => {
  it('handles CR, LF and CRLF line ends, also split across chunks, and multi-byte text', async () => {
    const encoder = new TextEncoder();
    const euro = encoder.encode('data: €\n\n');
    const source = tracked([
      'data: one\r', '\nid: 1\r', '\n\r', '\n',
      'data: two\n\r\n',
      'data: three\r\r',
      euro.slice(0, 7), euro.slice(7),
      ': comment\n\ndata: 😀\n\n',
      'event: done\ndata: end\n\n',
    ]);
    const events: SseEvent[] = [];
    await followSse('/s', { fetch: async () => source.response, onEvent: event => { events.push(event); }, isTerminal: event => event.event === 'done' });
    expect(events.map(event => event.data)).toEqual(['one', 'two', 'three', '€', '😀', 'end']);
    expect(events[0]).toEqual({ id: '1', event: 'message', data: 'one' });
  });

  it('refuses an event over maxEventBytes, counted in UTF-8 bytes, without reconnecting', async () => {
    const fetcher = vi.fn(async () => tracked(['data: ' + 'x'.repeat(40), 'x'.repeat(40)], { hang: true }).response);
    const failure = await followSse('/s', { fetch: fetcher, policy: fast, maxEventBytes: 64, onEvent: () => undefined }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SseEventTooLargeError);
    expect((failure as SseEventTooLargeError).maxEventBytes).toBe(64);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Many short lines of one event count together; multi-byte characters count as their bytes.
    const lines = tracked(['data: €€€€\n'.repeat(4)], { hang: true });
    await expect(followSse('/s', { fetch: async () => lines.response, maxEventBytes: 48, onEvent: () => undefined })).rejects.toBeInstanceOf(SseEventTooLargeError);
    expect(lines.cancelled()).toBe(true);
    // A comment line is not part of an event, but an unterminated one is bounded too.
    const comment = tracked([': ' + 'y'.repeat(100)], { hang: true });
    await expect(followSse('/s', { fetch: async () => comment.response, maxEventBytes: 64, onEvent: () => undefined })).rejects.toBeInstanceOf(SseEventTooLargeError);
    // Events below the limit pass, and the count restarts after each one.
    const many = tracked(['data: 0123456789\n\n'.repeat(20) + 'event: done\ndata: x\n\n']);
    let count = 0;
    await followSse('/s', { fetch: async () => many.response, maxEventBytes: 20, onEvent: () => { count++; }, isTerminal: event => event.event === 'done' });
    expect(count).toBe(21);
  });

  it('validates its limits', async () => {
    await expect(followSse('/s', { maxEventBytes: -1, onEvent: () => undefined })).rejects.toThrow(RangeError);
    await expect(followSse('/s', { idleTimeoutMs: Number.NaN, onEvent: () => undefined })).rejects.toThrow(RangeError);
  });

  it('honours the retry field, capped at the policy maximum', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(tracked(['retry: 3000\nid: 1\ndata: a\n\n']).response)
        .mockResolvedValueOnce(tracked(['retry: 999999\ndata: b\n\n']).response)
        .mockResolvedValueOnce(tracked(['retry: soon\nevent: done\ndata: c\n\n']).response);
      const policy = { maxAttempts: Number.MAX_SAFE_INTEGER, baseMs: 1, maxMs: 5000, jitter: 'none' as const };
      const pending = followSse('/s', { fetch: fetcher, policy, onEvent: () => undefined, isTerminal: event => event.event === 'done' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ cursor: '1', reconnects: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('followSse idle timeout', () => {
  it('reconnects a silent stream and keeps a stream with heartbeats', async () => {
    const silent = tracked(['id: 1\ndata: a\n\n'], { hang: true });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(silent.response)
      .mockResolvedValueOnce(tracked(['event: done\ndata: b\n\n']).response);
    const result = await followSse('/s', { fetch: fetcher, policy: fast, idleTimeoutMs: 30, onEvent: () => undefined, isTerminal: event => event.event === 'done' });
    expect(result).toMatchObject({ cursor: '1', reconnects: 1 });
    expect(silent.cancelled()).toBe(true);
    const signal = (fetcher.mock.calls[0] as [string, RequestInit])[1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('times out a request that never answers, and gives up when every connection stalls', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted by idle timeout')));
    }));
    const failure = await followSse('/s', { fetch: fetcher, policy: fast, idleTimeoutMs: 10, maxFailures: 2, onEvent: () => undefined }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SseIdleTimeoutError);
    expect((failure as SseIdleTimeoutError).idleTimeoutMs).toBe(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('still passes the caller abort through while idle tracking is on', async () => {
    const controller = new AbortController();
    const source = tracked([], { hang: true });
    const pending = followSse('/s', { fetch: async () => source.response, signal: controller.signal, idleTimeoutMs: 10_000, onEvent: () => undefined });
    setTimeout(() => controller.abort(new Error('user left')), 5);
    await expect(pending).rejects.toThrow('user left');
  });
});

describe('followSse idle timeout and slow handlers', () => {
  it('does not count time spent in the handler as idle', async () => {
    const source = tracked(['id: 1\ndata: a\n\n', 'event: done\ndata: b\n\n']);
    const fetcher = vi.fn(async () => source.response);
    const result = await followSse('/s', {
      fetch: fetcher, idleTimeoutMs: 20, onEvent: () => new Promise(resolve => setTimeout(resolve, 60)), isTerminal: event => event.event === 'done',
    });
    expect(result).toMatchObject({ cursor: '1', reconnects: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
