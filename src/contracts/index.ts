/**
 * Isomorphic suite contracts: types and small, dependency-free validators.
 *
 * Nothing in this module may import a Node built-in, a framework or a runtime dependency,
 * because the browser UI vendors it. Validators return a result instead of throwing so
 * they can be used on untrusted input without try/catch.
 */

// ---------------------------------------------------------------------------------------
// Validation result

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------
// Headers

/** Header names used across the suite. Lowercase, as HTTP/2 and fetch normalise them. */
export const HIVE_HEADERS = {
  requestId: 'x-request-id',
  /** Accepted on inbound requests for compatibility; never sent. */
  requestIdAliases: ['x-hive-request-id', 'x-correlation-id'],
  traceparent: 'traceparent',
  tracestate: 'tracestate',
  idempotencyKey: 'idempotency-key',
  /** Accepted on inbound requests for compatibility; never sent. */
  idempotencyKeyAliases: ['x-idempotency-key'],
} as const;

/** A request ID: up to 128 printable characters that are safe in logs and headers. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:@/+=-]{1,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** Anything headers can be read from: fetch `Headers`, a Node `IncomingHttpHeaders` record, or a getter. */
export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | ((name: string) => string | null | undefined);

/** The raw value of a header, before repeated values are refused. Lets a caller tell a repeated header apart from an absent one. */
export function rawHeader(headers: HeaderSource, name: string): unknown {
  const lower = name.toLowerCase();
  if (typeof headers === 'function') return headers(lower);
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(name: string): unknown }).get(lower);
  const record = headers as Readonly<Record<string, unknown>>;
  if (record[lower] !== undefined) return record[lower];
  const key = Object.keys(record).find(candidate => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

/** Read one header. A repeated header (array value) is treated as absent: it is ambiguous. */
export function readHeader(headers: HeaderSource, name: string): string | undefined {
  const value = rawHeader(headers, name);
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * A new request ID: a random UUID, or 32 random hex characters where `crypto.randomUUID` is
 * missing or refuses (a browser page outside a secure context).
 */
export function generateRequestId(): string {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === 'function') {
    try {
      return source.randomUUID();
    } catch {
      // Not a secure context: fall through to getRandomValues, which works everywhere.
    }
  }
  return Array.from(source.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The request ID in a set of headers (a request's or a response's): `x-request-id`, else
 * `x-hive-request-id`, else `x-correlation-id`. An invalid value (too long, unsafe characters)
 * is ignored rather than propagated.
 */
export function readRequestId(headers: HeaderSource): string | undefined {
  for (const name of [HIVE_HEADERS.requestId, ...HIVE_HEADERS.requestIdAliases]) {
    const value = readHeader(headers, name)?.trim();
    if (isValidRequestId(value)) return value;
  }
  return undefined;
}

/** The request ID in the headers, or a new one. */
export function resolveRequestId(headers: HeaderSource, generate: () => string = generateRequestId): string {
  return readRequestId(headers) ?? generate();
}

// ---------------------------------------------------------------------------------------
// Retry-After

export interface RetryAfterOptions {
  /** The clock an HTTP date is measured against. `Date.now`. */
  readonly now?: () => number;
  /** Also accept decimal delta-seconds (`1.5`), rounded up to a millisecond. Off: digits only, as RFC 9110 defines. */
  readonly allowFractional?: boolean;
  /** Returned when the header is absent or unreadable. Without it the result is undefined. */
  readonly fallbackMs?: number;
  /** Lower bound for the result, the fallback included. */
  readonly minMs?: number;
  /** Upper bound for the result, the fallback included. */
  readonly maxMs?: number;
}

const DELTA_SECONDS = /^\d+$/;
const DECIMAL_SECONDS = /^(?:\d+\.?\d*|\.\d+)$/;
// Every HTTP-date form starts with a day name; an ISO timestamp is accepted too. Anything else
// is not handed to Date.parse, which reads strings such as `-5` or `1.2.3` as dates.
const HTTP_DATE_LIKE = /^(?:[A-Za-z]{3}|\d{4}-\d{2}-\d{2}T)/;

/**
 * A `Retry-After` header as milliseconds to wait: delta-seconds, or an HTTP date measured
 * against `now` (a date in the past is 0). Undefined when the header is absent or unreadable,
 * unless `fallbackMs` is given. The second argument may be the clock alone.
 */
export function retryAfterMs(header: string | null | undefined, options: RetryAfterOptions & { readonly fallbackMs: number }): number;
export function retryAfterMs(header: string | null | undefined, options?: RetryAfterOptions | (() => number)): number | undefined;
export function retryAfterMs(header: string | null | undefined, options: RetryAfterOptions | (() => number) = {}): number | undefined {
  const settings: RetryAfterOptions = typeof options === 'function' ? { now: options } : options;
  const text = typeof header === 'string' ? header.trim() : '';
  let value: number | undefined;
  if (text) {
    if ((settings.allowFractional ? DECIMAL_SECONDS : DELTA_SECONDS).test(text)) value = Math.ceil(Number(text) * 1000);
    else if (HTTP_DATE_LIKE.test(text)) {
      const date = Date.parse(text);
      if (!Number.isNaN(date)) value = Math.max(0, date - (settings.now ? settings.now() : Date.now()));
    }
  }
  if (value === undefined || !Number.isFinite(value)) value = settings.fallbackMs;
  if (value === undefined) return undefined;
  if (settings.minMs !== undefined) value = Math.max(value, settings.minMs);
  if (settings.maxMs !== undefined) value = Math.min(value, settings.maxMs);
  return value;
}

// ---------------------------------------------------------------------------------------
// Error envelope

/** The body of every suite error response: `{ error: { code, message, requestId?, details? } }`. */
export interface ErrorBody {
  /** Stable, machine-readable code such as `not_found` or `invalid_token`. */
  readonly code: string;
  /** Human-readable message. Never contains secrets or internal stack traces. */
  readonly message: string;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ErrorEnvelope {
  readonly error: ErrorBody;
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isRecord(value) || !isRecord(value['error'])) return false;
  const error = value['error'];
  return typeof error['code'] === 'string' && error['code'].length > 0
    && typeof error['message'] === 'string'
    && (error['requestId'] === undefined || typeof error['requestId'] === 'string')
    && (error['details'] === undefined || isRecord(error['details']));
}

// ---------------------------------------------------------------------------------------
// Pagination

/** A cursor-paginated list: `nextCursor` is null on the last page. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export function isPage(value: unknown): value is Page<unknown> {
  return isRecord(value) && Array.isArray(value['data'])
    && (value['nextCursor'] === null || (typeof value['nextCursor'] === 'string' && value['nextCursor'].length > 0));
}

// ---------------------------------------------------------------------------------------
// Identifiers

/** A suite identifier segment: node IDs, profile names and actor IDs. */
export const IDENTIFIER_PATTERN = /^[a-z0-9_-]{2,32}$/;
/** `<nodeId>~<profile>`, both identifier segments. */
export const AGENT_REF_PATTERN = /^([a-z0-9_-]{2,32})~([a-z0-9_-]{2,32})$/;
/** A product ID as the Hive Registry stores it. */
export const PRODUCT_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

export interface AgentIdentity {
  /** `<nodeId>~<profile>` */
  readonly agentRef: string;
  readonly actorId: string;
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

export function isAgentRef(value: unknown): value is string {
  return typeof value === 'string' && AGENT_REF_PATTERN.test(value);
}

export function isProductId(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_ID_PATTERN.test(value);
}

export function parseAgentRef(value: string): { readonly nodeId: string; readonly profile: string } | undefined {
  const match = AGENT_REF_PATTERN.exec(value);
  return match ? { nodeId: match[1] as string, profile: match[2] as string } : undefined;
}

export function formatAgentRef(nodeId: string, profile: string): string {
  if (!isIdentifier(nodeId) || !isIdentifier(profile)) throw new TypeError('nodeId and profile must match [a-z0-9_-]{2,32}');
  return `${nodeId}~${profile}`;
}

export function validateAgentIdentity(value: unknown): ValidationResult<AgentIdentity> {
  if (!isRecord(value)) return { ok: false, issues: ['$: expected an object'] };
  const issues: string[] = [];
  if (!isAgentRef(value['agentRef'])) issues.push('agentRef: expected <nodeId>~<profile> matching [a-z0-9_-]{2,32}');
  if (!isIdentifier(value['actorId'])) issues.push('actorId: expected [a-z0-9_-]{2,32}');
  return issues.length ? { ok: false, issues } : { ok: true, value: { agentRef: value['agentRef'] as string, actorId: value['actorId'] as string } };
}

// ---------------------------------------------------------------------------------------
// HiveEvent v1

export const HIVE_EVENT_VERSION = 1;
export const HIVE_EVENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type HiveEventSeverity = (typeof HIVE_EVENT_SEVERITIES)[number];

/** HiveEvent v1: one notable thing that happened in a product, linking back to it. */
export interface HiveEvent {
  /** Globally unique and stable; consumers deduplicate on it. */
  readonly id: string;
  /** Product ID of the emitter, as the Hive Registry names it. */
  readonly product: string;
  /** Dotted, lowercase event type, for example `agent.task.failed`. */
  readonly type: string;
  readonly severity: HiveEventSeverity;
  readonly title: string;
  readonly summary: string;
  /** RFC 3339 timestamp in UTC (`Z`). */
  readonly occurredAt: string;
  readonly subject?: {
    readonly actorId?: string;
    readonly agentRef?: string;
    readonly nodeId?: string;
  };
  /** Where a person can see the event: a same-origin console path of a product. */
  readonly link: { readonly product: string; readonly path: string };
  /** The emitter's own reference to the record behind the event. */
  readonly sourceRef?: string;
}

export const HIVE_EVENT_LIMITS = {
  id: 128,
  type: 100,
  title: 200,
  summary: 2000,
  path: 1024,
  sourceRef: 256,
} as const;

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
// Control characters other than tab and newline never belong in display text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** True for an RFC 3339 UTC timestamp that names a real instant. */
export function isRfc3339Utc(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_UTC.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

/** A same-origin path: starts with one `/`, no scheme, no backslash, no control characters. */
export function isSameOriginPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= HIVE_EVENT_LIMITS.path && /^\/(?![/\\])/.test(value)
    && !value.includes('\\') && !CONTROL_CHARACTERS.test(value) && !/\s/.test(value);
}

function text(value: unknown, field: string, min: number, max: number, issues: string[]): value is string {
  if (typeof value !== 'string') { issues.push(`${field}: expected a string`); return false; }
  if (value.length < min || value.length > max) { issues.push(`${field}: expected ${min}-${max} characters`); return false; }
  if (CONTROL_CHARACTERS.test(value)) { issues.push(`${field}: must not contain control characters`); return false; }
  return true;
}

export interface HiveEventValidationOptions {
  /** Reject unknown fields instead of dropping them. Producers should validate strictly. */
  readonly strict?: boolean;
}

const EVENT_FIELDS = new Set(['id', 'product', 'type', 'severity', 'title', 'summary', 'occurredAt', 'subject', 'link', 'sourceRef']);
const SUBJECT_FIELDS = new Set(['actorId', 'agentRef', 'nodeId']);
const LINK_FIELDS = new Set(['product', 'path']);

function unknownFields(value: Record<string, unknown>, known: Set<string>, prefix: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!known.has(key)) issues.push(`${prefix}${key}: unknown field`);
}

/**
 * Validate a HiveEvent v1. The returned value is a fresh object holding only known fields,
 * so a consumer never passes along data it did not validate.
 */
export function validateHiveEvent(value: unknown, options: HiveEventValidationOptions = {}): ValidationResult<HiveEvent> {
  if (!isRecord(value)) return { ok: false, issues: ['$: expected an object'] };
  const issues: string[] = [];
  if (options.strict) unknownFields(value, EVENT_FIELDS, '', issues);

  const { id, product, type, severity, title, summary, occurredAt, subject, link, sourceRef } = value;
  if (text(id, 'id', 1, HIVE_EVENT_LIMITS.id, issues) && !EVENT_ID_PATTERN.test(id)) issues.push('id: expected [A-Za-z0-9._:-]');
  if (!isProductId(product)) issues.push('product: expected a product ID');
  if (text(type, 'type', 1, HIVE_EVENT_LIMITS.type, issues) && !EVENT_TYPE_PATTERN.test(type)) issues.push('type: expected a dotted lowercase type');
  if (!HIVE_EVENT_SEVERITIES.includes(severity as HiveEventSeverity)) issues.push('severity: expected info, warning or critical');
  text(title, 'title', 1, HIVE_EVENT_LIMITS.title, issues);
  text(summary, 'summary', 0, HIVE_EVENT_LIMITS.summary, issues);
  if (!isRfc3339Utc(occurredAt)) issues.push('occurredAt: expected an RFC 3339 UTC timestamp');

  let cleanSubject: { actorId?: string; agentRef?: string; nodeId?: string } | undefined;
  if (subject !== undefined) {
    if (!isRecord(subject)) issues.push('subject: expected an object');
    else {
      if (options.strict) unknownFields(subject, SUBJECT_FIELDS, 'subject.', issues);
      cleanSubject = {};
      if (subject['actorId'] !== undefined) {
        if (isIdentifier(subject['actorId'])) cleanSubject.actorId = subject['actorId'];
        else issues.push('subject.actorId: expected [a-z0-9_-]{2,32}');
      }
      if (subject['agentRef'] !== undefined) {
        if (isAgentRef(subject['agentRef'])) cleanSubject.agentRef = subject['agentRef'];
        else issues.push('subject.agentRef: expected <nodeId>~<profile>');
      }
      if (subject['nodeId'] !== undefined) {
        if (isIdentifier(subject['nodeId'])) cleanSubject.nodeId = subject['nodeId'];
        else issues.push('subject.nodeId: expected [a-z0-9_-]{2,32}');
      }
    }
  }

  if (!isRecord(link)) issues.push('link: expected an object');
  else {
    if (options.strict) unknownFields(link, LINK_FIELDS, 'link.', issues);
    if (!isProductId(link['product'])) issues.push('link.product: expected a product ID');
    if (!isSameOriginPath(link['path'])) issues.push('link.path: expected a same-origin path starting with /');
  }
  if (sourceRef !== undefined) text(sourceRef, 'sourceRef', 1, HIVE_EVENT_LIMITS.sourceRef, issues);

  if (issues.length) return { ok: false, issues };
  const linkRecord = link as Record<string, unknown>;
  const event: HiveEvent = {
    id: id as string,
    product: product as string,
    type: type as string,
    severity: severity as HiveEventSeverity,
    title: title as string,
    summary: summary as string,
    occurredAt: occurredAt as string,
    ...(cleanSubject ? { subject: cleanSubject } : {}),
    link: { product: linkRecord['product'] as string, path: linkRecord['path'] as string },
    ...(sourceRef !== undefined ? { sourceRef: sourceRef as string } : {}),
  };
  return { ok: true, value: event };
}

export function isHiveEvent(value: unknown): value is HiveEvent {
  return validateHiveEvent(value).ok;
}

// ---------------------------------------------------------------------------------------
// Feed positions

/** Where an event sits in a feed: feeds are ordered oldest first by `(occurredAt, id)`. */
export interface FeedPosition {
  /** RFC 3339 UTC timestamp. */
  readonly occurredAt: string;
  readonly id: string;
}

/**
 * Feed order: by instant, then by ID in code-unit order. Negative when `a` comes first, zero
 * when they are the same position. Timestamps compare as instants, so `…00Z` equals `…00.000Z`.
 */
export function compareFeedPositions(a: FeedPosition, b: FeedPosition): number {
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Whether `candidate` comes strictly after `position` in feed order. Everything is after no position. */
export function isAfterFeedPosition(candidate: FeedPosition, position: FeedPosition | null | undefined): boolean {
  return !position || compareFeedPositions(candidate, position) > 0;
}

/** Validate a feed page of HiveEvents. Any invalid event fails the whole page. */
export function validateHiveEventPage(value: unknown, options: HiveEventValidationOptions = {}): ValidationResult<Page<HiveEvent>> {
  if (!isPage(value)) return { ok: false, issues: ['$: expected { data: [], nextCursor: string | null }'] };
  const data: HiveEvent[] = [];
  const issues: string[] = [];
  value.data.forEach((item, index) => {
    const result = validateHiveEvent(item, options);
    if (result.ok) data.push(result.value);
    else issues.push(...result.issues.map(issue => `data[${index}].${issue}`));
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: { data, nextCursor: value.nextCursor } };
}
