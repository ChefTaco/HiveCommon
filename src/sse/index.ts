/**
 * Follow a server-sent event stream with cursor-based reconnect.
 *
 * Isomorphic: uses `fetch` and web streams, so it runs in Node and in browsers, and unlike
 * `EventSource` it can send authorization headers. After a dropped or closed connection it
 * reconnects with the last event ID it saw (`Last-Event-ID`), waiting with backoff after
 * failures, until `isTerminal` accepts an event or `signal` aborts.
 */
import { backoffDelay, sleepAbortable, type RetryPolicy } from '../retry/index.js';

export interface SseEvent {
  /** The event `id`, when the server sent one. */
  readonly id?: string;
  /** The event name; `message` when the server sent none. */
  readonly event: string;
  readonly data: string;
}

export type SseFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface FollowSseOptions {
  /** Headers for every connection, or a function called before each one (for fresh tokens). */
  readonly headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** The cursor to resume after. Sent as `Last-Event-ID`. */
  readonly after?: string;
  /** Also send the cursor as this query parameter (some servers read only the query). */
  readonly cursorParam?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: SseFetch;
  /** Called for every event, in order. */
  readonly onEvent: (event: SseEvent) => void | Promise<void>;
  /** Stop after this event. Without it the stream is followed until `signal` aborts. */
  readonly isTerminal?: (event: SseEvent) => boolean;
  /** Called on every (re)connection, with the cursor it resumed from. */
  readonly onConnect?: (cursor: string | undefined, reconnect: number) => void;
  /** Backoff between failed connections. A clean close reconnects at once. */
  readonly policy?: RetryPolicy;
  /** Consecutive failed connections tolerated before giving up. Default 8. */
  readonly maxFailures?: number;
}

export interface FollowSseResult {
  /** The last event ID seen, to resume from later. */
  readonly cursor: string | undefined;
  readonly reconnects: number;
  /** The event `isTerminal` accepted, if any. */
  readonly terminal: SseEvent | undefined;
}

/** A connection the server refused in a way another attempt will not fix (for example 401, 403, 404). */
export class SseStatusError extends Error {
  override readonly name = 'SseStatusError';
  constructor(readonly status: number) { super(`The event stream answered HTTP ${status}`); }
}

const RECONNECT_POLICY: RetryPolicy = { maxAttempts: Number.MAX_SAFE_INTEGER, baseMs: 500, maxMs: 15_000, jitter: 'equal' };

/** Parse a complete SSE block (the text between blank lines). Undefined for comments or empty blocks. */
export function parseSseBlock(block: string): SseEvent | undefined {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];
  let seen = false;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') { data.push(value); seen = true; }
    else if (field === 'event') { event = value; seen = true; }
    else if (field === 'id' && !value.includes('\0')) { id = value; seen = true; }
  }
  if (!seen) return undefined;
  return { ...(id !== undefined ? { id } : {}), event, data: data.join('\n') };
}

function withCursor(url: string, param: string | undefined, cursor: string | undefined): string {
  if (!param || cursor === undefined) return url;
  const parsed = new URL(url, 'http://placeholder.invalid');
  parsed.searchParams.set(param, cursor);
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
}

/** Follow `url` until a terminal event, an abort, a permanent status or too many failures. */
export async function followSse(url: string, options: FollowSseOptions): Promise<FollowSseResult> {
  const fetcher: SseFetch = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const policy = options.policy ?? RECONNECT_POLICY;
  const maxFailures = options.maxFailures ?? 8;
  let cursor = options.after;
  let reconnects = 0;
  let failures = 0;
  for (let connection = 0; ; connection++) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Aborted');
    if (connection > 0) reconnects++;
    options.onConnect?.(cursor, connection);
    let progressed = false;
    try {
      const extra = typeof options.headers === 'function' ? await options.headers() : options.headers ?? {};
      const response = await fetcher(withCursor(url, options.cursorParam, cursor), {
        headers: { accept: 'text/event-stream', ...extra, ...(cursor !== undefined ? { 'last-event-id': cursor } : {}) },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status !== 408 && response.status !== 429 && response.status < 500) throw new SseStatusError(response.status);
        throw new Error(`The event stream answered HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('The event stream has no body');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const event = parseSseBlock(block);
          if (!event) continue;
          if (event.id !== undefined) cursor = event.id;
          progressed = true;
          failures = 0;
          await options.onEvent(event);
          if (options.isTerminal?.(event)) {
            await reader.cancel().catch(() => undefined);
            return { cursor, reconnects, terminal: event };
          }
        }
      }
      // A clean close (a server that rotates long streams): reconnect at once.
      if (!progressed) failures++;
    } catch (error: unknown) {
      if (options.signal?.aborted || error instanceof SseStatusError) throw error;
      if (!progressed) failures++;
      if (failures >= maxFailures) throw error;
    }
    if (failures >= maxFailures) throw new Error('The event stream kept closing without events');
    if (failures > 0) {
      const delay = backoffDelay(Math.min(failures, 30), { ...policy, maxAttempts: Number.MAX_SAFE_INTEGER }) ?? policy.maxMs;
      await sleepAbortable(delay, options.signal);
    }
  }
}
