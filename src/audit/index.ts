/**
 * The suite audit export, HiveAuditRecord v1: `GET <api>/v1/audit/export?after=<cursor>&limit=<n>`,
 * oldest first, read by Cindertrace's collector with an Oathweave service token.
 *
 * Isomorphic: no Node built-ins and no runtime dependencies. The record type and validator,
 * the opaque cursor, the query parser, detail flattening with redaction, and the page builder.
 * A product keeps its own storage and its own mapping from a stored row to a record.
 */
import { isProductId, isRfc3339Utc, type ValidationResult } from '../contracts/index.js';
import { HiveError } from '../errors/index.js';
import { decodeCursor, encodeCursor, parseFeedQuery } from '../internal/cursor.js';
import { redact } from '../log/redact.js';

export const HIVE_AUDIT_EXPORT_PATH = '/v1/audit/export';
export const HIVE_AUDIT_VERSION = 1;
export const HIVE_AUDIT_DEFAULT_LIMIT = 100;
export const HIVE_AUDIT_MAX_LIMIT = 200;

/**
 * The limits a record must meet. They are the strictest of what the suite's producers and
 * Cindertrace's collector accept, so a record that passes here is accepted by every one.
 */
export const HIVE_AUDIT_LIMITS = {
  /** The native part of `id`, after `<product>:audit:`. */
  nativeId: 200,
  action: 128,
  actorId: 256,
  issuer: 512,
  displayName: 256,
  targetType: 64,
  targetId: 512,
  subjectActorId: 256,
  agentRef: 257,
  nodeId: 128,
  /** `details` as UTF-8 JSON. */
  detailsBytes: 4096,
} as const;

export const HIVE_AUDIT_ACTOR_TYPES = ['user', 'service', 'agent', 'system'] as const;
export type HiveAuditActorType = (typeof HIVE_AUDIT_ACTOR_TYPES)[number];
export const HIVE_AUDIT_OUTCOMES = ['success', 'failure'] as const;
export type HiveAuditOutcome = (typeof HIVE_AUDIT_OUTCOMES)[number];
/** Products whose audit export Cindertrace collects today. Any product ID is a valid record `product`. */
export const HIVE_AUDIT_PRODUCTS = ['hivemem', 'hiveskills', 'ardentstudio', 'embermend'] as const;

export type HiveAuditScalar = string | number | boolean | null;

/** HiveAuditRecord v1: one audited action, as the suite exports it. */
export interface HiveAuditRecord {
  /** `<product>:audit:<native id>`, the native id `[A-Za-z0-9._:-]{1,200}`. Stable. */
  readonly id: string;
  readonly product: string;
  /** RFC 3339 UTC (`Z`). */
  readonly occurredAt: string;
  /** Dotted lowercase, at least two segments: `skill.update`, `session.login`. */
  readonly action: string;
  readonly outcome: HiveAuditOutcome;
  readonly actor: {
    readonly type: HiveAuditActorType;
    readonly id: string;
    readonly issuer?: string;
    readonly displayName?: string;
  };
  readonly target?: { readonly type?: string; readonly id?: string };
  readonly subject?: { readonly actorId?: string; readonly agentRef?: string; readonly nodeId?: string };
  /** Flat scalars only, redacted, at most 4 KiB as JSON. Never content, bodies or secrets. */
  readonly details: Readonly<Record<string, HiveAuditScalar>>;
}

export interface HiveAuditPage {
  readonly data: readonly HiveAuditRecord[];
  /**
   * The cursor of the last row read, on every page that read one (even the final page, so a
   * collector can store it and poll again). Null only when nothing was read: caught up.
   */
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------------------
// Validation

const NATIVE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ACTION = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RECORD_FIELDS = new Set(['id', 'product', 'occurredAt', 'action', 'outcome', 'actor', 'target', 'subject', 'details']);
const ACTOR_FIELDS = new Set(['type', 'id', 'issuer', 'displayName']);
const TARGET_FIELDS = new Set(['type', 'id']);
const SUBJECT_FIELDS = new Set(['actorId', 'agentRef', 'nodeId']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export interface HiveAuditValidationOptions {
  /** Reject unknown fields instead of dropping them. Producers validate strictly (`auditExportPage()` does). */
  readonly strict?: boolean;
}

function unknownFields(value: Record<string, unknown>, known: Set<string>, prefix: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!known.has(key)) issues.push(`${prefix}${key}: unknown field`);
}

/** A bounded string without control characters; undefined (and an issue) otherwise. */
function text(value: unknown, field: string, max: number, issues: string[]): string | undefined {
  if (typeof value !== 'string') { issues.push(`${field}: expected a string`); return undefined; }
  if (value.length < 1 || value.length > max) { issues.push(`${field}: expected 1-${max} characters`); return undefined; }
  if (CONTROL_CHARACTERS.test(value)) { issues.push(`${field}: must not contain control characters`); return undefined; }
  return value;
}

/** Optional object of optional strings: the cleaned object, or undefined when absent. */
function part(
  value: unknown, name: string, fields: Readonly<Record<string, number>>, known: Set<string>, strict: boolean, issues: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) { issues.push(`${name}: expected an object`); return undefined; }
  if (strict) unknownFields(value, known, `${name}.`, issues);
  const clean: Record<string, string> = {};
  for (const [field, max] of Object.entries(fields)) {
    if (value[field] === undefined) continue;
    const checked = text(value[field], `${name}.${field}`, max, issues);
    if (checked !== undefined) clean[field] = checked;
  }
  return clean;
}

/**
 * Validate a HiveAuditRecord v1. The returned value is a fresh object holding only known fields.
 * An empty `target` or `subject` is dropped, never passed along as `{}`.
 */
export function validateHiveAuditRecord(value: unknown, options: HiveAuditValidationOptions = {}): ValidationResult<HiveAuditRecord> {
  if (!isRecord(value)) return { ok: false, issues: ['$: expected an object'] };
  const strict = options.strict ?? false;
  const issues: string[] = [];
  if (strict) unknownFields(value, RECORD_FIELDS, '', issues);
  const { id, product, occurredAt, action, outcome, actor, target, subject, details } = value;

  if (!isProductId(product)) issues.push('product: expected a product ID');
  if (typeof id !== 'string' || (isProductId(product) && !(id.startsWith(`${product}:audit:`) && NATIVE_ID.test(id.slice(product.length + 7))))) {
    issues.push('id: expected <product>:audit:<[A-Za-z0-9._:-]{1,200}>');
  }
  if (!isRfc3339Utc(occurredAt)) issues.push('occurredAt: expected an RFC 3339 UTC timestamp');
  if (typeof action !== 'string' || action.length > HIVE_AUDIT_LIMITS.action || !ACTION.test(action)) {
    issues.push(`action: expected dotted lowercase segments [a-z0-9_], at most ${HIVE_AUDIT_LIMITS.action} characters`);
  }
  if (!HIVE_AUDIT_OUTCOMES.includes(outcome as HiveAuditOutcome)) issues.push('outcome: expected success or failure');

  let cleanActor: HiveAuditRecord['actor'] | undefined;
  if (!isRecord(actor)) issues.push('actor: expected an object');
  else {
    if (strict) unknownFields(actor, ACTOR_FIELDS, 'actor.', issues);
    if (!HIVE_AUDIT_ACTOR_TYPES.includes(actor['type'] as HiveAuditActorType)) issues.push('actor.type: expected user, service, agent or system');
    const actorId = text(actor['id'], 'actor.id', HIVE_AUDIT_LIMITS.actorId, issues);
    const rest = part({ issuer: actor['issuer'], displayName: actor['displayName'] }, 'actor', { issuer: HIVE_AUDIT_LIMITS.issuer, displayName: HIVE_AUDIT_LIMITS.displayName }, ACTOR_FIELDS, false, issues);
    if (actorId !== undefined) cleanActor = { type: actor['type'] as HiveAuditActorType, id: actorId, ...rest };
  }
  const cleanTarget = part(target, 'target', { type: HIVE_AUDIT_LIMITS.targetType, id: HIVE_AUDIT_LIMITS.targetId }, TARGET_FIELDS, strict, issues);
  const cleanSubject = part(subject, 'subject', { actorId: HIVE_AUDIT_LIMITS.subjectActorId, agentRef: HIVE_AUDIT_LIMITS.agentRef, nodeId: HIVE_AUDIT_LIMITS.nodeId }, SUBJECT_FIELDS, strict, issues);

  const cleanDetails: Record<string, HiveAuditScalar> = {};
  if (!isRecord(details)) issues.push('details: expected an object of scalars');
  else {
    for (const [key, item] of Object.entries(details)) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) cleanDetails[key] = item;
      else issues.push(`details.${key}: expected a string, finite number, boolean or null`);
    }
    if (utf8Bytes(JSON.stringify(cleanDetails)) > HIVE_AUDIT_LIMITS.detailsBytes) issues.push(`details: larger than ${HIVE_AUDIT_LIMITS.detailsBytes} bytes`);
  }

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      id: id as string,
      product: product as string,
      occurredAt: occurredAt as string,
      action: action as string,
      outcome: outcome as HiveAuditOutcome,
      actor: cleanActor as HiveAuditRecord['actor'],
      ...(cleanTarget && Object.keys(cleanTarget).length ? { target: cleanTarget } : {}),
      ...(cleanSubject && Object.keys(cleanSubject).length ? { subject: cleanSubject } : {}),
      details: cleanDetails,
    },
  };
}

export function isHiveAuditRecord(value: unknown): value is HiveAuditRecord {
  return validateHiveAuditRecord(value).ok;
}

/** Validate an export page: at most 200 records, every one valid, and a cursor whenever there are records. */
export function validateHiveAuditPage(value: unknown, options: HiveAuditValidationOptions = {}): ValidationResult<HiveAuditPage> {
  if (!isRecord(value) || !Array.isArray(value['data']) || !(value['nextCursor'] === null || (typeof value['nextCursor'] === 'string' && value['nextCursor'].length >= 1 && value['nextCursor'].length <= 2000))) {
    return { ok: false, issues: ['$: expected { data: [], nextCursor: string | null }'] };
  }
  const issues: string[] = [];
  const nextCursor = value['nextCursor'] as string | null;
  if (value['data'].length > HIVE_AUDIT_MAX_LIMIT) issues.push(`data: at most ${HIVE_AUDIT_MAX_LIMIT} records`);
  if (value['data'].length && nextCursor === null) issues.push('nextCursor: required when data has records');
  const data: HiveAuditRecord[] = [];
  value['data'].forEach((item, index) => {
    const result = validateHiveAuditRecord(item, options);
    if (result.ok) data.push(result.value);
    else issues.push(...result.issues.map(issue => `data[${index}].${issue}`));
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: { data, nextCursor } };
}

// ---------------------------------------------------------------------------------------
// Building records

/** `<product>:audit:<nativeId>`. Throws a TypeError when either part does not fit the pattern. */
export function auditRecordId(product: string, nativeId: string | number): string {
  const native = String(nativeId);
  if (!isProductId(product) || !NATIVE_ID.test(native)) throw new TypeError('An audit record ID needs a product ID and a native ID of [A-Za-z0-9._:-]{1,200}');
  return `${product}:audit:${native}`;
}

/**
 * A stored action name as a valid record action: lowercased, other characters as `_`, empty
 * segments dropped, and a one-segment name prefixed with `fallbackPrefix` (`audit.`), so
 * `Login` becomes `audit.login` and `skill.create` stays as it is.
 */
export function auditAction(stored: string, fallbackPrefix = 'audit'): string {
  const segments = stored.toLowerCase().slice(0, 256).split('.').map(segment => segment.replace(/[^a-z0-9_]+/g, '_')).filter(Boolean);
  const cleaned = fallbackPrefix.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const prefix = /[a-z0-9]/.test(cleaned) ? cleaned : 'audit';
  const named = segments.length >= 2 ? segments : [prefix, ...(segments.length ? segments : ['unknown'])];
  let action = named.join('.');
  if (action.length > HIVE_AUDIT_LIMITS.action) action = action.slice(0, HIVE_AUDIT_LIMITS.action).replace(/\.+$/, '');
  return action;
}

export interface AuditDetailsOptions {
  /** Keys dropped before anything else (case-insensitive): fields that may hold content. */
  readonly dropKeys?: readonly string[];
  /** Passed to `redact()`: identifiers such as `tokenCount` whose name looks secret. */
  readonly allowKeys?: readonly string[];
  /** Longest kept string; longer ones are cut and end in `…`. 512. */
  readonly maxString?: number;
  /** The byte limit to fit. 4096, the record limit. */
  readonly maxBytes?: number;
}

/**
 * Flat, redacted record details from a stored detail object. Values go through `/log`
 * `redact()` (secret-looking keys masked, credentials scrubbed from text); scalars are kept,
 * strings cut at `maxString`; an array of strings or numbers becomes one comma-joined string,
 * any other array `<key>_count`; nested objects are dropped. Until the result fits `maxBytes`,
 * the longest value is dropped and `truncated: true` is set.
 */
export function auditDetails(detail: unknown, options: AuditDetailsOptions = {}): Record<string, HiveAuditScalar> {
  const maxString = options.maxString ?? 512;
  const maxBytes = options.maxBytes ?? HIVE_AUDIT_LIMITS.detailsBytes;
  if (!Number.isInteger(maxString) || maxString < 1) throw new RangeError('maxString must be a positive integer');
  if (!Number.isInteger(maxBytes) || maxBytes < 2 || maxBytes > HIVE_AUDIT_LIMITS.detailsBytes) throw new RangeError(`maxBytes must be an integer from 2 to ${HIVE_AUDIT_LIMITS.detailsBytes}`);
  if (!isRecord(detail)) return {};
  const drop = new Set((options.dropKeys ?? []).map(key => key.toLowerCase()));
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(detail)) if (!drop.has(key.toLowerCase())) kept[key] = item;
  const clean = redact(kept, options.allowKeys ? { allowKeys: options.allowKeys } : {});
  const cut = (item: string): string => (item.length > maxString ? `${item.slice(0, maxString - 1)}…` : item);
  const scalar = (item: unknown): HiveAuditScalar | undefined => {
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : undefined;
    if (typeof item === 'string') return cut(item);
    return undefined;
  };
  const flat: Record<string, HiveAuditScalar> = {};
  for (const [key, item] of Object.entries(clean)) {
    const direct = scalar(item);
    if (direct !== undefined) { flat[key] = direct; continue; }
    if (Array.isArray(item)) {
      if (item.every(entry => typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)))) flat[key] = cut(item.join(','));
      else flat[`${key}_count`] = item.length;
    }
  }
  while (utf8Bytes(JSON.stringify(flat)) > maxBytes) {
    const entries = Object.entries(flat).filter(([key]) => key !== 'truncated');
    if (!entries.length) return {};
    const longest = entries.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
    delete flat[longest[0]];
    flat['truncated'] = true;
  }
  return flat;
}

// ---------------------------------------------------------------------------------------
// Cursor and query

/** Where an export page starts: after the row with this ID (and, for time-ordered stores, time). */
export interface AuditCursorPosition {
  /** The row's native ID: a non-negative safe integer or a string. */
  readonly id: string | number;
  /** For stores ordered by `(time, id)`: the row's time as stored. */
  readonly at?: string;
}

const MAX_CURSOR_TEXT = 256;

function isPositionId(value: unknown): value is string | number {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && value.length >= 1 && value.length <= MAX_CURSOR_TEXT);
}

/** The opaque cursor for a position: base64url JSON `{ i, t? }`. */
export function encodeAuditCursor(position: AuditCursorPosition): string {
  if (!isPositionId(position.id) || (position.at !== undefined && (typeof position.at !== 'string' || !position.at || position.at.length > MAX_CURSOR_TEXT))) {
    throw new TypeError('An audit cursor needs a non-negative integer or short string id, and an optional short time');
  }
  return encodeCursor(position.at === undefined ? { i: position.id } : { t: position.at, i: position.id });
}

/** Read a cursor from `encodeAuditCursor()`; undefined for anything else. */
export function decodeAuditCursor(cursor: string): AuditCursorPosition | undefined {
  let value: Record<string, string | number>;
  try { value = decodeCursor(cursor); } catch { return undefined; }
  const keys = Object.keys(value);
  const id = value['i'];
  const at = value['t'];
  if (!isPositionId(id) || !keys.every(key => key === 'i' || key === 't')) return undefined;
  if (at !== undefined && (typeof at !== 'string' || !at || at.length > MAX_CURSOR_TEXT)) return undefined;
  return at === undefined ? { id } : { id, at };
}

export interface AuditExportQuery {
  /** The position to start after; undefined for the first page. */
  readonly after: AuditCursorPosition | undefined;
  readonly limit: number;
}

/**
 * Read `after` and `limit` (default 100, at most 200). Throws a 400 `HiveError`:
 * `invalid_query` for a malformed value, `invalid_cursor` for a cursor this export did not issue.
 */
export function parseAuditExportQuery(
  query: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
  options: { readonly defaultLimit?: number; readonly maxLimit?: number } = {},
): AuditExportQuery {
  const { after, limit } = parseFeedQuery(query, {
    defaultLimit: options.defaultLimit ?? HIVE_AUDIT_DEFAULT_LIMIT,
    maxLimit: Math.min(options.maxLimit ?? HIVE_AUDIT_MAX_LIMIT, HIVE_AUDIT_MAX_LIMIT),
  });
  if (after === undefined) return { after: undefined, limit };
  const position = decodeAuditCursor(after);
  if (!position) throw new HiveError('invalid_cursor', 'The cursor is not valid', { status: 400 });
  return { after: position, limit };
}

// ---------------------------------------------------------------------------------------
// Pages

export interface AuditExportPageOptions<Row> {
  /** The page size from `parseAuditExportQuery()`. Rows past it are not read. */
  readonly limit: number;
  /** Map one stored row to a record, or undefined (or null) when it is not exported. */
  readonly toRecord: (row: Row) => HiveAuditRecord | null | undefined;
  /** The row's cursor position (its native ID, and time for time-ordered stores). */
  readonly position: (row: Row) => AuditCursorPosition;
  /** Called once with the number of rows read but not exported (unmapped or invalid), when there are any. */
  readonly onDropped?: (count: number) => void;
}

/**
 * One export page from the rows stored after the cursor, in export order (oldest first). Each
 * row is mapped with `toRecord` and validated strictly; a row that is not exported, or whose
 * record is invalid, is skipped and counted, and the cursor still moves past it, so one bad row
 * never stalls the collector. `nextCursor` is the cursor of the last row read, null only when
 * there were none.
 */
export function auditExportPage<Row>(rows: Iterable<Row>, options: AuditExportPageOptions<Row>): HiveAuditPage {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > HIVE_AUDIT_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${HIVE_AUDIT_MAX_LIMIT}`);
  }
  const data: HiveAuditRecord[] = [];
  let read = 0;
  let last: Row | undefined;
  for (const row of rows) {
    read++;
    last = row;
    const record = options.toRecord(row);
    const checked = record === undefined || record === null ? undefined : validateHiveAuditRecord(record, { strict: true });
    if (checked?.ok) data.push(checked.value);
    // Stop before pulling another row from a lazy source.
    if (read >= options.limit) break;
  }
  if (data.length !== read) options.onDropped?.(read - data.length);
  return { data, nextCursor: read ? encodeAuditCursor(options.position(last as Row)) : null };
}
