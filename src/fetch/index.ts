/**
 * Bounded outbound HTTP: a fetch with a deadline, a redirect policy and a response-size limit,
 * and readers that never buffer more of a response than the caller allowed.
 *
 * Isomorphic: no Node built-ins, so the browser UI can use it. Request-ID and trace forwarding
 * is opt-in through `contextHeaders` (pass `outboundHeaders` from `/context` on a server).
 */
import { parseHiveError, type HiveError } from '../errors/index.js';
import { readRequestId } from '../contracts/index.js';

/** Why a bounded request or read failed. */
export type BoundedFetchFailure =
  | 'timeout' // the deadline passed before the response was complete
  | 'network' // the request could not be made, or the connection failed
  | 'response_too_large'
  | 'empty_response'
  | 'invalid_json';

const MESSAGES: Readonly<Record<BoundedFetchFailure, string>> = {
  timeout: 'The request timed out',
  network: 'The request failed',
  response_too_large: 'The response is larger than the limit',
  empty_response: 'The response is empty',
  invalid_json: 'The response is not valid JSON',
};

/**
 * A bounded request or read that failed. The message is fixed per reason and never holds the
 * URL, headers or body, any of which may be secret; the original error is on `cause`.
 */
export class BoundedFetchError extends Error {
  override readonly name = 'BoundedFetchError';
  readonly reason: BoundedFetchFailure;
  /** The limit that was exceeded, for `response_too_large`. */
  readonly maxBytes: number | undefined;

  constructor(reason: BoundedFetchFailure, options: { readonly cause?: unknown; readonly maxBytes?: number } = {}) {
    super(MESSAGES[reason], options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.maxBytes = options.maxBytes;
  }
}

export function isBoundedFetchError(value: unknown, reason?: BoundedFetchFailure): value is BoundedFetchError {
  return value instanceof BoundedFetchError && (reason === undefined || value.reason === reason);
}

/** One megabyte: the default response limit. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
/** The default deadline for a request and its response body. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

function assertLimit(maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative number');
}

/**
 * Concatenate chunks read from a byte stream, refusing at `maxBytes`. `tooLarge` builds the
 * error; the stream is cancelled before it is thrown. Shared with the inbound body readers.
 */
export async function readStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => unknown,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      // A cancelled read ends as "done"; the abort is what happened.
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export interface ReadBodyOptions {
  /** Stop reading (and cancel the body) when this aborts; the read rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * The body of a response, at most `maxBytes` long. A declared `content-length` over the limit
 * is refused before anything is read; a body without one (or with a wrong one) is refused as
 * soon as it passes the limit. Either way the rest of the body is cancelled, not buffered, and
 * the error is a `BoundedFetchError` with reason `response_too_large`.
 */
export async function readBodyBounded(response: Response, maxBytes: number, options: ReadBodyOptions = {}): Promise<Uint8Array> {
  assertLimit(maxBytes);
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BoundedFetchError('response_too_large', { maxBytes });
  }
  if (!response.body) return new Uint8Array();
  return readStreamBounded(response.body, maxBytes, () => new BoundedFetchError('response_too_large', { maxBytes }), options.signal);
}

/** Like `readBodyBounded()`, decoded as UTF-8. */
export async function readTextBounded(response: Response, maxBytes: number, options: ReadBodyOptions = {}): Promise<string> {
  return new TextDecoder().decode(await readBodyBounded(response, maxBytes, options));
}

export interface ParseJsonBytesOptions {
  /**
   * What an empty (or whitespace-only) body means. By default it is an `empty_response` error;
   * with `emptyValue` set (to anything, `null` and `undefined` included) that value is returned.
   */
  readonly emptyValue?: unknown;
}

/** Parse bytes (or text) as JSON. Throws a `BoundedFetchError`: `empty_response` or `invalid_json`. */
export function parseJsonBytes(body: Uint8Array | string, options: ParseJsonBytesOptions = {}): unknown {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  if (!text.trim()) {
    if ('emptyValue' in options) return options.emptyValue;
    throw new BoundedFetchError('empty_response');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new BoundedFetchError('invalid_json', { cause });
  }
}

/** The JSON body of a response, read with `readBodyBounded()` and parsed with `parseJsonBytes()`. */
export async function readJsonBounded(response: Response, maxBytes: number, options: ReadBodyOptions & ParseJsonBytesOptions = {}): Promise<unknown> {
  return parseJsonBytes(await readBodyBounded(response, maxBytes, options), options);
}

export interface BoundedFetchOptions {
  /** Deadline for the request and its body together. 15 000 ms. `0` or `Infinity` sets none. */
  readonly timeoutMs?: number;
  /** Largest response body to accept. 1 MiB. */
  readonly maxResponseBytes?: number;
  /** The fetch to use, for tests or a custom CA (`createCaFetch()` from `/registry`). */
  readonly fetch?: typeof fetch;
  /**
   * Redirect policy when `init.redirect` is not set. Defaults to `error`: a credentialed request
   * must not follow a redirect to wherever a compromised or misconfigured peer points.
   */
  readonly redirect?: RequestRedirect;
  /**
   * Headers that join the peer to the current request, added unless `init.headers` already has
   * them. On a server pass `outboundHeaders` from `/context` to forward `x-request-id`,
   * `traceparent` and `tracestate`.
   */
  readonly contextHeaders?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
}

export interface BoundedFetchResult {
  /** The response. Its body has been read: use `body`, not `response.json()`. */
  readonly response: Response;
  readonly body: Uint8Array;
}

function mergedHeaders(init: RequestInit, extra: BoundedFetchOptions['contextHeaders']): Headers | undefined {
  const added = typeof extra === 'function' ? extra() : extra;
  if (!added || !Object.keys(added).length) return undefined;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(added)) if (!headers.has(name)) headers.set(name, value);
  return headers;
}

/**
 * Fetch and read the whole response within a deadline and a size limit. The caller's own
 * `init.signal` still cancels the request, and its abort reason is rethrown unchanged; a missed
 * deadline is a `BoundedFetchError` `timeout`, a transport failure `network`, an oversized body
 * `response_too_large`. Any HTTP status is returned: check `response.ok`.
 */
export async function boundedFetch(input: string | URL, init: RequestInit = {}, options: BoundedFetchOptions = {}): Promise<BoundedFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  assertLimit(maxBytes);
  if (Number.isNaN(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be a non-negative number');
  const caller = init.signal ?? undefined;
  const deadline = timeoutMs > 0 && Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [caller, deadline].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const headers = mergedHeaders(init, options.contextHeaders);
  const request = options.fetch ?? ((url, requestInit) => fetch(url, requestInit));
  try {
    const response = await request(input, {
      ...init,
      redirect: init.redirect ?? options.redirect ?? 'error',
      ...(headers ? { headers } : {}),
      ...(signal ? { signal } : {}),
    });
    const body = await readBodyBounded(response, maxBytes, signal ? { signal } : {});
    return { response, body };
  } catch (error) {
    // The caller cancelled: that is theirs to recognise, so it passes through unchanged.
    if (caller?.aborted) throw error;
    if (error instanceof BoundedFetchError) throw error;
    throw new BoundedFetchError(deadline?.aborted ? 'timeout' : 'network', { cause: error });
  }
}

export interface FetchJsonOptions extends BoundedFetchOptions, ParseJsonBytesOptions {
  /**
   * Throw for a status outside 200-299. On by default: the error is a `HiveError` built by
   * `parseHiveError()` from the (bounded) error body, so it carries the peer's code, message,
   * request ID and `Retry-After`. When false, error responses are parsed and returned like any
   * other, and a body that is not JSON gives `data: undefined`.
   */
  readonly throwOnHttpError?: boolean;
}

export interface FetchJsonResult {
  readonly response: Response;
  /** The parsed JSON body. For 204, 205 and 304 it is `emptyValue` (undefined unless set). */
  readonly data: unknown;
}

function peerError(response: Response, body: Uint8Array): HiveError {
  const requestId = readRequestId(response.headers);
  const retryAfter = response.headers.get('retry-after');
  return parseHiveError(response.status, body, {
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
  });
}

/**
 * `boundedFetch()` for a JSON API: sends `accept: application/json` unless set, throws a
 * `HiveError` for an error status, and parses the body. A success body that is empty or not
 * JSON is a `BoundedFetchError` (`empty_response`, `invalid_json`), except for the statuses
 * that never carry one.
 */
export async function fetchJson(input: string | URL, init: RequestInit = {}, options: FetchJsonOptions = {}): Promise<FetchJsonResult> {
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const { response, body } = await boundedFetch(input, { ...init, headers }, options);
  if (!response.ok) {
    if (options.throwOnHttpError ?? true) throw peerError(response, body);
    let data: unknown;
    try {
      data = parseJsonBytes(body);
    } catch {
      data = undefined;
    }
    return { response, data };
  }
  if (response.status === 204 || response.status === 205 || response.status === 304) return { response, data: options.emptyValue };
  return { response, data: parseJsonBytes(body, options) };
}
