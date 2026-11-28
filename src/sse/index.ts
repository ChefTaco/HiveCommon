/**
 * Follow a server-sent event stream with cursor-based reconnect.
 *
 * Isomorphic: uses `fetch` and web streams, so it runs in Node and in browsers, and unlike
 * `EventSource` it can send authorization headers. After a dropped or closed connection it
 * reconnects with the last event ID it handled (`Last-Event-ID`), waiting with backoff after
 * failures, until `isTerminal` accepts an event, the handler throws, or `signal` aborts.
 */
import { retryAfterMs } from '../contracts/index.js';
import { backoffDelay, sleepAbortable, type RetryPolicy } from '../retry/index.js';

export interface SseEvent {
  /** The event `id`, when the server sent one. */
  readonly id?: string;
  /** The event name; `message` when the server sent none. */
  readonly event: string;
  readonly data: string;
}

export type SseFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Where the follower is, for a UI that shows it: `connecting` before each request, `open` once the
 * server answered with a stream, `retrying` before the wait that precedes the next connection.
 */
export type SseConnectionState = 'connecting' | 'open' | 'retrying';

export interface SseStateChange {
  readonly state: SseConnectionState;
  /** The connection this is about: 0 for the first, one more for each reconnect. */
  readonly connection: number;
  /** The cursor the connection resumes from (`connecting`, `open`) or the next one will (`retrying`). */
  readonly cursor: string | undefined;
  /** `retrying` only: the wait before the next connection, in milliseconds (0 for at once). */
  readonly delayMs?: number;
  /** `retrying` only: consecutive failed connections so far (a renewal does not count as one). */
  readonly failures?: number;
  /** `retrying` only: why the connection ended. Undefined for a clean close or a renewal. */
  readonly error?: unknown;
  /** `retrying` only: the connection answered 401 and `onUnauthorized` renewed the credentials. */
  readonly renewed?: boolean;
}

export interface FollowSseOptions {
  /** Headers for every connection, or a function called before each one (for fresh tokens). */
  readonly headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** The cursor to resume after. Sent as `Last-Event-ID`. */
  readonly after?: string;
  /** Also send the cursor as this query parameter (some servers read only the query). */
  readonly cursorParam?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: SseFetch;
  /**
   * Called for every event, in order. The cursor moves past an event only once this returns.
   * When it throws (or rejects), following stops with an `SseHandlerError` whose `cursor` is
   * the last event handled, so the caller can resume from it; the event is not skipped.
   */
  readonly onEvent: (event: SseEvent) => void | Promise<void>;
  /** Stop after this event. Without it the stream is followed until `signal` aborts. */
  readonly isTerminal?: (event: SseEvent) => boolean;
  /** Called on every (re)connection, with the cursor it resumed from. */
  readonly onConnect?: (cursor: string | undefined, reconnect: number) => void;
  /** Called on every state change (see `SseConnectionState`). A throw here ends the follow. */
  readonly onStateChange?: (change: SseStateChange) => void;
  /**
   * Called when a connection answers 401, to renew the credentials `headers` returns (for example
   * by refreshing a token). Resolve `true` to reconnect at once, calling `headers` again; `false`
   * ends the follow with `SseStatusError(401)`, as without this hook. It is called once per 401:
   * when the connection right after a renewal answers 401 again, the follow ends without another
   * renewal. A rejection counts as a failed connection, retried with backoff.
   */
  readonly onUnauthorized?: (status: 401) => boolean | Promise<boolean>;
  /** Backoff between failed connections. A clean close reconnects at once (or after the server's `retry:`). */
  readonly policy?: RetryPolicy;
  /** Consecutive failed connections tolerated before giving up. Default 8; `Infinity` never gives up. */
  readonly maxFailures?: number;
  /**
   * The largest event accepted, in bytes of UTF-8 text, counting every field line of the event
   * (and a line still being received). Default 1 MiB. A larger event ends the follow with an
   * `SseEventTooLargeError`: the stream would send it again on every reconnect.
   */
  readonly maxEventBytes?: number;
  /**
   * Reconnect when the server sends nothing at all (no event, no comment or heartbeat, no
   * response headers) for this many milliseconds. Off by default; set it to a few times the
   * server's heartbeat interval. A stalled connection counts as a failed one unless it
   * delivered an event.
   */
  readonly idleTimeoutMs?: number;
}

export interface FollowSseResult {
  /** The last event ID handled, to resume from later. */
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

/** `onEvent` (or `isTerminal`) threw. The original error is `cause`; `event` was not handled. */
export class SseHandlerError extends Error {
  override readonly name = 'SseHandlerError';
  constructor(
    /** The last event ID handled before `event`: resume from here to see `event` again. */
    readonly cursor: string | undefined,
    readonly event: SseEvent,
    cause: unknown,
  ) { super('The event handler failed', { cause }); }
}

/** The server sent an event larger than `maxEventBytes`. */
export class SseEventTooLargeError extends Error {
  override readonly name = 'SseEventTooLargeError';
  constructor(readonly maxEventBytes: number) { super('The event stream sent an event larger than the limit'); }
}

/** The connection was silent for `idleTimeoutMs`. Followed by a reconnect, not thrown, unless failures run out. */
export class SseIdleTimeoutError extends Error {
  override readonly name = 'SseIdleTimeoutError';
  constructor(readonly idleTimeoutMs: number) { super('The event stream was idle for too long'); }
}

/** Carries an `onStateChange` error past the connection's failure handling. */
class StateCallbackFailure {
  constructor(readonly error: unknown) {}
}

const RECONNECT_POLICY: RetryPolicy = { maxAttempts: Number.MAX_SAFE_INTEGER, baseMs: 500, maxMs: 15_000, jitter: 'equal' };
export const DEFAULT_MAX_SSE_EVENT_BYTES = 1_048_576;

interface BlockState {
  id: string | undefined;
  event: string;
  data: string[];
  seen: boolean;
}

const emptyBlock = (): BlockState => ({ id: undefined, event: 'message', data: [], seen: false });

/** Apply one field line to the event being built. Returns the `retry:` value when the line is a valid one. */
function applyLine(line: string, state: BlockState): number | undefined {
  if (!line || line.startsWith(':')) return undefined;
  const colon = line.indexOf(':');
  const field = colon < 0 ? line : line.slice(0, colon);
  const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
  if (field === 'data') { state.data.push(value); state.seen = true; }
  else if (field === 'event') { state.event = value; state.seen = true; }
  else if (field === 'id' && !value.includes('\0')) { state.id = value; state.seen = true; }
  else if (field === 'retry' && /^\d{1,10}$/.test(value)) return Number(value);
  return undefined;
}

function finish(state: BlockState): SseEvent | undefined {
  if (!state.seen) return undefined;
  return { ...(state.id !== undefined ? { id: state.id } : {}), event: state.event, data: state.data.join('\n') };
}

/** Parse a complete SSE block (the text between blank lines). Undefined for comments or empty blocks. */
export function parseSseBlock(block: string): SseEvent | undefined {
  const state = emptyBlock();
  for (const line of block.split(/\r\n|\r|\n/)) applyLine(line, state);
  return finish(state);
}

/** UTF-8 length of a string, without allocating. Lone surrogates count as the 3-byte replacement. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * Incremental, line-based SSE parsing (CRLF, LF or CR line ends, also split across chunks).
 * Linear in the input: nothing is rescanned, and the event being built is bounded.
 */
class SseParser {
  private state = emptyBlock();
  private tail = '';
  private tailBytes = 0;
  private blockBytes = 0;
  private afterCr = false;
  /** The latest valid `retry:` value. */
  retryMs: number | undefined;

  constructor(private readonly maxBytes: number) {}

  /** Feed decoded text; returns the events it completed, in order. */
  push(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (this.afterCr) {
        this.afterCr = false;
        // The LF of a CRLF split across chunks (or just after a CR): not a second line end.
        if (code === 0x0a) { start = index + 1; continue; }
      }
      if (code !== 0x0a && code !== 0x0d) continue;
      const piece = text.slice(start, index);
      const line = this.tail + piece;
      const lineBytes = this.tailBytes + utf8Length(piece);
      this.tail = '';
      this.tailBytes = 0;
      this.afterCr = code === 0x0d;
      start = index + 1;
      this.line(line, lineBytes, events);
    }
    const rest = text.slice(start);
    this.tail += rest;
    this.tailBytes += utf8Length(rest);
    this.check(this.tailBytes);
    return events;
  }

  private line(line: string, bytes: number, events: SseEvent[]): void {
    if (!line) {
      const event = finish(this.state);
      this.state = emptyBlock();
      this.blockBytes = 0;
      if (event) events.push(event);
      return;
    }
    if (line.startsWith(':')) return;
    this.blockBytes += bytes + 1;
    this.check(0);
    const retry = applyLine(line, this.state);
    if (retry !== undefined) this.retryMs = retry;
  }

  private check(extra: number): void {
    if (this.blockBytes + extra > this.maxBytes) throw new SseEventTooLargeError(this.maxBytes);
  }
}

function withCursor(url: string, param: string | undefined, cursor: string | undefined): string {
  if (!param || cursor === undefined) return url;
  const parsed = new URL(url, 'http://placeholder.invalid');
  parsed.searchParams.set(param, cursor);
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
}

function assertNonNegative(name: string, value: number | undefined): void {
  if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value) || value < 0)) throw new RangeError(`${name} must be a non-negative number`);
}

/** Follow `url` until a terminal event, an abort, a handler error, a permanent status or too many failures. */
export async function followSse(url: string, options: FollowSseOptions): Promise<FollowSseResult> {
  const fetcher: SseFetch = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const policy = options.policy ?? RECONNECT_POLICY;
  const maxFailures = options.maxFailures ?? 8;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  assertNonNegative('maxEventBytes', maxEventBytes);
  assertNonNegative('idleTimeoutMs', idleTimeoutMs);
  let cursor = options.after;
  let reconnects = 0;
  let failures = 0;
  let serverRetryMs: number | undefined;
  // Set by a renewal after a 401 and cleared once a connection opens: one renewal per 401.
  let renewed = false;
  const notify = options.onStateChange;
  // Inside a connection's try block, so that a throwing callback ends the follow rather than
  // counting as a failed connection.
  const notifyInside = (change: SseStateChange): void => {
    try { notify?.(change); } catch (error) { throw new StateCallbackFailure(error); }
  };
  for (let connection = 0; ; connection++) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Aborted');
    if (connection > 0) reconnects++;
    options.onConnect?.(cursor, connection);
    notify?.({ state: 'connecting', connection, cursor });
    let progressed = false;
    let lastError: unknown;
    // A `Retry-After` on a transient refusal (408, 429, 5xx), for the next wait only.
    let statusRetryMs: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Per connection: an idle timeout aborts this connection only, never the caller's signal.
    const local = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
    // Settles (rejects) when the caller aborts or the idle timer fires, so neither waits on a
    // request or body that ignores its signal.
    const stopped = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
    stopped.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (!(idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs))) return;
      clearTimeout(timer);
      timer = setTimeout(() => local.abort(new SseIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
    };
    const guarded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped]);
    try {
      const extra = typeof options.headers === 'function' ? await options.headers() : options.headers ?? {};
      armIdle();
      const response = await guarded(fetcher(withCursor(url, options.cursorParam, cursor), {
        headers: { accept: 'text/event-stream', ...extra, ...(cursor !== undefined ? { 'last-event-id': cursor } : {}) },
        signal,
      }));
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 && options.onUnauthorized && !renewed) {
          clearTimeout(timer);
          if (!await guarded(Promise.resolve(options.onUnauthorized(401)))) throw new SseStatusError(401);
          renewed = true;
          // Reconnect at once with fresh headers; a renewal is not a failed connection.
          notifyInside({ state: 'retrying', connection, cursor, delayMs: 0, failures, renewed: true });
          continue;
        }
        if (response.status !== 408 && response.status !== 429 && response.status < 500) throw new SseStatusError(response.status);
        statusRetryMs = retryAfterMs(response.headers.get('retry-after'));
        throw new Error(`The event stream answered HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('The event stream has no body');
      renewed = false;
      notifyInside({ state: 'open', connection, cursor });
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser(maxEventBytes);
      for (;;) {
        armIdle();
        const { value, done } = await guarded(reader.read());
        // Time spent in the handler is not the server being idle.
        clearTimeout(timer);
        if (done) break;
        const events = parser.push(decoder.decode(value, { stream: true }));
        if (parser.retryMs !== undefined) serverRetryMs = parser.retryMs;
        for (const event of events) {
          let terminal: boolean;
          try {
            await options.onEvent(event);
            terminal = options.isTerminal?.(event) ?? false;
          } catch (error) {
            throw new SseHandlerError(cursor, event, error);
          }
          if (event.id !== undefined) cursor = event.id;
          progressed = true;
          failures = 0;
          if (terminal) return { cursor, reconnects, terminal: event };
        }
      }
      // A clean close (a server that rotates long streams): reconnect at once.
      if (!progressed) failures++;
    } catch (error: unknown) {
      if (error instanceof StateCallbackFailure) throw error.error;
      if (options.signal?.aborted || error instanceof SseStatusError || error instanceof SseHandlerError || error instanceof SseEventTooLargeError) throw error;
      lastError = error;
      if (!progressed) failures++;
      if (failures >= maxFailures) throw error;
    } finally {
      clearTimeout(timer);
      // Release the connection on every exit: terminal event, handler error, limit, timeout.
      if (reader) void reader.cancel().catch(() => undefined);
      local.abort();
    }
    if (failures >= maxFailures) throw new Error('The event stream kept closing without events');
    // The server's `retry:` sets the reconnect wait, capped at the policy's longest backoff.
    // So does a `Retry-After` on a refused connection, with the same cap.
    const requested = Math.min(Math.max(serverRetryMs ?? 0, statusRetryMs ?? 0), policy.maxMs);
    const backoff = failures > 0 ? backoffDelay(Math.min(failures, 30), { ...policy, maxAttempts: Number.MAX_SAFE_INTEGER }) ?? policy.maxMs : 0;
    const delay = Math.max(backoff, requested);
    notify?.({ state: 'retrying', connection, cursor, delayMs: delay, failures, ...(lastError !== undefined ? { error: lastError } : {}) });
    if (delay > 0) await sleepAbortable(delay, options.signal);
  }
}
