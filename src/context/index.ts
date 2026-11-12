/**
 * Request context: request IDs, W3C trace context, idempotency keys and an
 * AsyncLocalStorage-scoped context that loggers and outbound clients read.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HIVE_HEADERS } from '../contracts/index.js';
import { HiveError } from '../errors/index.js';

export { HIVE_HEADERS } from '../contracts/index.js';

/** Anything headers can be read from: fetch `Headers`, a Node `IncomingHttpHeaders` record, or a getter. */
export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | ((name: string) => string | null | undefined);

/** Read one header. A repeated header (array value) is treated as absent: it is ambiguous. */
export function readHeader(headers: HeaderSource, name: string): string | undefined {
  const lower = name.toLowerCase();
  let value: unknown;
  if (typeof headers === 'function') value = headers(lower);
  else if (typeof (headers as { get?: unknown }).get === 'function') value = (headers as { get(name: string): unknown }).get(lower);
  else {
    const record = headers as Readonly<Record<string, unknown>>;
    value = record[lower];
    if (value === undefined) {
      const key = Object.keys(record).find(candidate => candidate.toLowerCase() === lower);
      value = key === undefined ? undefined : record[key];
    }
  }
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------
// Request IDs

/** Up to 128 printable characters that are safe in logs and headers. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:@/+=-]{1,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function generateRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The inbound request ID: `x-request-id`, else `x-hive-request-id`, else `x-correlation-id`.
 * An invalid value (too long, unsafe characters) is ignored rather than propagated.
 */
export function readRequestId(headers: HeaderSource): string | undefined {
  for (const name of [HIVE_HEADERS.requestId, ...HIVE_HEADERS.requestIdAliases]) {
    const value = readHeader(headers, name)?.trim();
    if (isValidRequestId(value)) return value;
  }
  return undefined;
}

/** The inbound request ID, or a new one. */
export function resolveRequestId(headers: HeaderSource, generate: () => string = generateRequestId): string {
  return readRequestId(headers) ?? generate();
}

// ---------------------------------------------------------------------------------------
// W3C trace context

export interface Traceparent {
  readonly version: string;
  readonly traceId: string;
  /** The parent-id field: the span ID of the caller. */
  readonly spanId: string;
  readonly flags: string;
  readonly sampled: boolean;
}

const HEX = /^[0-9a-f]+$/;
const isZero = (value: string): boolean => /^0+$/.test(value);

/** Parse a `traceparent` header per W3C Trace Context. Returns undefined when it is invalid. */
export function parseTraceparent(value: string | undefined | null): Traceparent | undefined {
  if (typeof value !== 'string') return undefined;
  const header = value.trim();
  if (header.length < 55) return undefined;
  const version = header.slice(0, 2);
  if (!HEX.test(version) || version === 'ff') return undefined;
  // Version 00 is exactly 55 characters; later versions may append fields after a dash.
  if (version === '00' ? header.length !== 55 : header.length > 55 && header[55] !== '-') return undefined;
  const [, traceId, spanId, flags] = header.slice(0, 55).split('-');
  if (header[2] !== '-' || header[35] !== '-' || header[52] !== '-') return undefined;
  if (!traceId || !spanId || !flags) return undefined;
  if (traceId.length !== 32 || !HEX.test(traceId) || isZero(traceId)) return undefined;
  if (spanId.length !== 16 || !HEX.test(spanId) || isZero(spanId)) return undefined;
  if (flags.length !== 2 || !HEX.test(flags)) return undefined;
  return { version, traceId, spanId, flags, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function isValidTraceparent(value: string | undefined | null): boolean {
  return parseTraceparent(value) !== undefined;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  // A zero ID is invalid; regenerate in the vanishingly rare case it occurs.
  do globalThis.crypto.getRandomValues(buffer); while (buffer.every(byte => byte === 0));
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generateTraceId(): string {
  return randomHex(16);
}

export function generateSpanId(): string {
  return randomHex(8);
}

export function formatTraceparent(trace: Pick<Traceparent, 'traceId' | 'spanId'> & { readonly sampled?: boolean; readonly flags?: string }): string {
  const flags = trace.flags ?? (trace.sampled === false ? '00' : '01');
  const header = `00-${trace.traceId}-${trace.spanId}-${flags}`;
  if (!parseTraceparent(header)) throw new TypeError('Invalid trace context');
  return header;
}

/** A new root trace context. */
export function generateTraceparent(options: { readonly sampled?: boolean } = {}): Traceparent {
  const sampled = options.sampled ?? true;
  return { version: '00', traceId: generateTraceId(), spanId: generateSpanId(), flags: sampled ? '01' : '00', sampled };
}

/** A child span: same trace and flags, new span ID, always version 00 on output. */
export function childTraceparent(parent: Traceparent): Traceparent {
  return { version: '00', traceId: parent.traceId, spanId: generateSpanId(), flags: parent.flags, sampled: parent.sampled };
}

// ---------------------------------------------------------------------------------------
// Idempotency keys

/** 1-255 visible ASCII characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * The `Idempotency-Key` header, also accepting `x-idempotency-key`. Returns undefined when
 * neither is present. Throws a 400 HiveError when the value is malformed or the two headers
 * disagree, because silently picking one could apply a write twice.
 */
export function readIdempotencyKey(headers: HeaderSource): string | undefined {
  const values = [HIVE_HEADERS.idempotencyKey, ...HIVE_HEADERS.idempotencyKeyAliases]
    .map(name => readHeader(headers, name))
    .filter((value): value is string => value !== undefined)
    .map(value => value.trim());
  if (!values.length) return undefined;
  const [first] = values as [string, ...string[]];
  if (values.some(value => value !== first)) {
    throw new HiveError('invalid_idempotency_key', 'Idempotency-Key and X-Idempotency-Key disagree', { status: 400 });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(first)) {
    throw new HiveError('invalid_idempotency_key', 'Idempotency-Key must be 1-255 visible ASCII characters', { status: 400 });
  }
  return first;
}

/** Like `readIdempotencyKey()`, but a missing key is a 428 error. */
export function requireIdempotencyKey(headers: HeaderSource): string {
  const key = readIdempotencyKey(headers);
  if (key === undefined) throw new HiveError('idempotency_key_required', 'This request requires an Idempotency-Key header', { status: 428 });
  return key;
}

// ---------------------------------------------------------------------------------------
// Async request context

export interface RequestContext {
  readonly requestId: string;
  /** This service's span for the request: a child of the inbound trace, or a new root. */
  readonly trace: Traceparent;
  /** The inbound `traceparent`, when one was valid. */
  readonly parentTrace: Traceparent | undefined;
  /** The inbound `tracestate`, propagated unchanged when a valid traceparent came with it. */
  readonly tracestate: string | undefined;
  readonly startedAt: number;
  /** Set by auth adapters once a caller is verified. */
  principal?: unknown;
  /** Extra fields that loggers add to every line for this request. */
  readonly bindings: Record<string, unknown>;
}

export interface CreateRequestContextOptions {
  /**
   * Accept the inbound request ID and trace context. Defaults to true; set false on an edge
   * service that must not let the public internet choose its IDs. The two settings below
   * override it for one of the two.
   */
  readonly trustInbound?: boolean;
  /**
   * Accept an inbound `x-request-id` (or `x-hive-request-id`, `x-correlation-id`). Defaults to
   * `trustInbound`. When false, every request gets a generated ID.
   */
  readonly trustInboundRequestId?: boolean;
  /**
   * Continue an inbound `traceparent` and `tracestate`. Defaults to `trustInbound`. When false,
   * every request starts a new trace. An internet-facing service can set this true with
   * `trustInboundRequestId: false` to join a caller's trace while choosing its own request IDs.
   */
  readonly trustInboundTrace?: boolean;
  readonly generateRequestId?: () => string;
  readonly now?: () => number;
}

export function createRequestContext(headers: HeaderSource, options: CreateRequestContextOptions = {}): RequestContext {
  const trust = options.trustInbound ?? true;
  const trustRequestId = options.trustInboundRequestId ?? trust;
  const trustTrace = options.trustInboundTrace ?? trust;
  const requestId = (trustRequestId ? readRequestId(headers) : undefined) ?? (options.generateRequestId ?? generateRequestId)();
  const parentTrace = trustTrace ? parseTraceparent(readHeader(headers, HIVE_HEADERS.traceparent)) : undefined;
  const rawState = parentTrace ? readHeader(headers, HIVE_HEADERS.tracestate)?.trim() : undefined;
  // eslint-disable-next-line no-control-regex
  const tracestate = rawState && rawState.length <= 512 && !/[\u0000-\u001f\u007f]/.test(rawState) ? rawState : undefined;
  return {
    requestId,
    trace: parentTrace ? childTraceparent(parentTrace) : generateTraceparent(),
    parentTrace,
    tracestate,
    startedAt: options.now ? options.now() : Date.now(),
    bindings: {},
  };
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` as the current request context. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request context, or undefined outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The current request ID, or undefined outside a request. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Headers to send to a peer service so it joins this request: `x-request-id`, `traceparent`
 * (with this service's span as the parent) and `tracestate`. Empty outside a request.
 */
export function outboundHeaders(context: RequestContext | undefined = getRequestContext()): Record<string, string> {
  if (!context) return {};
  return {
    [HIVE_HEADERS.requestId]: context.requestId,
    [HIVE_HEADERS.traceparent]: formatTraceparent(context.trace),
    ...(context.tracestate ? { [HIVE_HEADERS.tracestate]: context.tracestate } : {}),
  };
}
