/**
 * The suite error envelope, `HiveError`, and `parseHiveError()`, which turns any error
 * response a suite product has ever sent into one `HiveError`.
 *
 * Isomorphic: no Node built-ins, so the browser UI can use it.
 */
import type { ErrorEnvelope } from '../contracts/index.js';

export type { ErrorBody, ErrorEnvelope } from '../contracts/index.js';
export { isErrorEnvelope } from '../contracts/index.js';

/** Default code and message for each status this package produces or parses. */
const STATUS_DEFAULTS: Readonly<Record<number, readonly [code: string, message: string]>> = {
  400: ['bad_request', 'The request is not valid'],
  401: ['unauthorized', 'Authentication is required'],
  403: ['forbidden', 'This action is not allowed'],
  404: ['not_found', 'The resource was not found'],
  405: ['method_not_allowed', 'The method is not allowed'],
  406: ['not_acceptable', 'The requested representation is not available'],
  408: ['request_timeout', 'The request took too long'],
  409: ['conflict', 'The request conflicts with the current state'],
  410: ['gone', 'The resource is no longer available'],
  412: ['precondition_failed', 'A precondition failed'],
  413: ['too_large', 'The request is too large'],
  415: ['unsupported_media_type', 'The media type is not supported'],
  422: ['invalid_request', 'The request could not be processed'],
  428: ['precondition_required', 'A precondition is required'],
  429: ['rate_limited', 'Too many requests'],
  500: ['internal', 'An internal error occurred'],
  501: ['not_implemented', 'This is not implemented'],
  502: ['bad_gateway', 'An upstream service failed'],
  503: ['unavailable', 'The service is unavailable'],
  504: ['gateway_timeout', 'An upstream service timed out'],
};

/** The default code for an HTTP status, for example `not_found` for 404. */
export function defaultCodeForStatus(status: number): string {
  return STATUS_DEFAULTS[status]?.[0] ?? (status >= 500 ? 'internal' : 'bad_request');
}

/** The default message for an HTTP status. */
export function defaultMessageForStatus(status: number): string {
  return STATUS_DEFAULTS[status]?.[1] ?? (status >= 500 ? 'An internal error occurred' : 'The request failed');
}

/** The legacy body shape a parsed error came from. */
export type HiveErrorShape =
  | 'envelope' // {error:{code,message}} — Hive standard, Ardent, ArdentStudio, Registry
  | 'magnus' // {success:false,error:{code,message}}
  | 'oathweave' // {error:CODE,message}
  | 'oauth' // {error,error_description}
  | 'code' // {error:CODE} — Embermend
  | 'string' // {error:"text"} — Emberpath, HiveSkills, Cindertrace
  | 'fastapi' // {detail:"text"}
  | 'fastapi-validation' // {detail:[{loc,msg,type}]}
  | 'mattermost' // {id,message,status_code,request_id}
  | 'message' // {message}
  | 'text' // plain text
  | 'empty' // no body
  | 'unknown'; // JSON in no known shape

export interface HiveErrorOptions {
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  /** Extra response headers, such as `WWW-Authenticate` or `Retry-After`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly cause?: unknown;
  readonly shape?: HiveErrorShape;
}

const HIVE_ERROR_BRAND = Symbol.for('@hivemagnus/hive-common/HiveError');

/** An error that knows its HTTP status, stable code and safe message. */
export class HiveError extends Error {
  override readonly name: string = 'HiveError';
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly requestId: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
  /** Set by `parseHiveError()`: the legacy body shape it recognised. */
  readonly shape: HiveErrorShape | undefined;

  constructor(code: string, message: string, options: HiveErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    const status = options.status ?? 500;
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError('HiveError status must be 400-599');
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.requestId = options.requestId;
    this.headers = options.headers;
    this.shape = options.shape;
    Object.defineProperty(this, HIVE_ERROR_BRAND, { value: true });
  }

  /** True when `error` is a HiveError with this code (case-insensitive), across package copies. */
  static is(error: unknown, code?: string): error is HiveError {
    if (!isHiveError(error)) return false;
    return code === undefined || error.code.toLowerCase() === code.toLowerCase();
  }

  toJSON(): ErrorEnvelope {
    return errorEnvelope(this.code, this.message, {
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.details ? { details: this.details } : {}),
    });
  }

  static badRequest(message = defaultMessageForStatus(400), details?: Record<string, unknown>): HiveError {
    return new HiveError('bad_request', message, { status: 400, ...(details ? { details } : {}) });
  }
  static validation(message: string, issues: readonly unknown[]): HiveError {
    return new HiveError('validation_failed', message, { status: 422, details: { issues } });
  }
  static unauthorized(message = defaultMessageForStatus(401)): HiveError {
    return new HiveError('unauthorized', message, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  }
  static forbidden(message = defaultMessageForStatus(403)): HiveError {
    return new HiveError('forbidden', message, { status: 403 });
  }
  static notFound(message = defaultMessageForStatus(404)): HiveError {
    return new HiveError('not_found', message, { status: 404 });
  }
  static conflict(message = defaultMessageForStatus(409), details?: Record<string, unknown>): HiveError {
    return new HiveError('conflict', message, { status: 409, ...(details ? { details } : {}) });
  }
  static rateLimited(retryAfterSeconds?: number): HiveError {
    return new HiveError('rate_limited', defaultMessageForStatus(429), {
      status: 429,
      ...(retryAfterSeconds !== undefined ? { headers: { 'retry-after': String(Math.max(0, Math.ceil(retryAfterSeconds))) } } : {}),
    });
  }
  static unavailable(message = defaultMessageForStatus(503)): HiveError {
    return new HiveError('unavailable', message, { status: 503 });
  }
  static internal(message = defaultMessageForStatus(500), cause?: unknown): HiveError {
    return new HiveError('internal', message, { status: 500, ...(cause !== undefined ? { cause } : {}) });
  }
}

/** True for any HiveError, including one created by another copy of this package. */
export function isHiveError(value: unknown): value is HiveError {
  return value instanceof HiveError
    || (value instanceof Error && (value as unknown as Record<symbol, unknown>)[HIVE_ERROR_BRAND] === true);
}

/** Build `{ error: { code, message, requestId?, details? } }`. */
export function errorEnvelope(
  code: string,
  message: string,
  extra: { readonly requestId?: string | undefined; readonly details?: Readonly<Record<string, unknown>> | undefined } = {},
): ErrorEnvelope {
  const error: { code: string; message: string; requestId?: string; details?: Readonly<Record<string, unknown>> } = { code, message };
  if (extra.requestId) error.requestId = extra.requestId;
  if (extra.details && Object.keys(extra.details).length) error.details = extra.details;
  return { error };
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorEnvelope;
  /** Lowercase header names, including `content-type` and `cache-control`. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface ToErrorResponseOptions {
  readonly requestId?: string | undefined;
  /**
   * Called for anything that is not a HiveError, before it is replaced by a generic 500.
   * Use it to log the original error; its message is never sent to the client.
   */
  readonly onUnexpected?: (error: unknown) => void;
}

/**
 * Turn any thrown value into a status, envelope body and headers. A HiveError keeps its code,
 * message and details; anything else becomes a generic `internal` 500, so internal messages
 * and stack traces never reach a client.
 */
export function toErrorResponse(error: unknown, options: ToErrorResponseOptions = {}): ErrorResponse {
  let hive: HiveError;
  if (isHiveError(error)) hive = error;
  else {
    options.onUnexpected?.(error);
    hive = HiveError.internal();
  }
  const requestId = options.requestId ?? hive.requestId;
  return {
    status: hive.status,
    body: errorEnvelope(hive.code, hive.message, { requestId, details: hive.details }),
    headers: {
      ...lowercaseKeys(hive.headers),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
  };
}

function lowercaseKeys(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) result[key.toLowerCase()] = value;
  return result;
}

// ---------------------------------------------------------------------------------------
// Parsing

const MAX_MESSAGE = 1000;
const MAX_CODE = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapse whitespace, drop control characters and bound the length of remote text. */
function cleanText(value: string, max = MAX_MESSAGE): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** A remote code is kept as sent (products compare against their own codes), but bounded and safe. */
function cleanCode(value: string): string | undefined {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_CODE);
  return cleaned || undefined;
}

/** A single token with no spaces is a code (`UNAUTHORIZED`, `invalid_grant`); prose is a message. */
function looksLikeCode(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value.trim());
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (nonEmptyString(record[key])) return record[key] as string;
  return undefined;
}

interface Parsed {
  shape: HiveErrorShape;
  code?: string | undefined;
  message?: string | undefined;
  requestId?: string | undefined;
  details?: Record<string, unknown> | undefined;
  status?: number | undefined;
}

function fastApiIssues(detail: unknown[]): { message: string; issues: Array<{ path: string; message: string; type?: string }> } {
  const issues = detail.slice(0, 50).map(item => {
    if (!isRecord(item)) return { path: '$', message: typeof item === 'string' ? cleanText(item, 300) : 'Invalid value' };
    const loc = Array.isArray(item['loc']) ? item['loc'].filter(part => typeof part === 'string' || typeof part === 'number') : [];
    const path = loc.length ? loc.join('.') : '$';
    const message = nonEmptyString(item['msg']) ? cleanText(item['msg'], 300) : 'Invalid value';
    return { path: cleanText(path, 200), message, ...(nonEmptyString(item['type']) ? { type: cleanText(item['type'], 100) } : {}) };
  });
  const first = issues[0];
  const message = first ? `${first.path}: ${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}` : 'The request is not valid';
  return { message: cleanText(message), issues };
}

function parseObject(body: Record<string, unknown>): Parsed {
  const error = body['error'];

  // {error:{code,message,...}} and Magnus {success:false,error:{...}}
  if (isRecord(error)) {
    const details = isRecord(error['details']) ? error['details'] : undefined;
    return {
      shape: body['success'] === false ? 'magnus' : 'envelope',
      code: stringField(error, 'code', 'type'),
      message: stringField(error, 'message', 'detail'),
      requestId: stringField(error, 'requestId', 'request_id') ?? stringField(body, 'requestId', 'request_id'),
      details: details ?? (error['details'] !== undefined ? { value: error['details'] } : undefined),
    };
  }

  if (nonEmptyString(error)) {
    // OAuth 2.0: {error, error_description?, error_uri?}
    if (nonEmptyString(body['error_description'])) {
      return { shape: 'oauth', code: error, message: body['error_description'] };
    }
    if (looksLikeCode(error)) {
      // Oathweave {error:CODE, message}; Embermend {error:CODE}; bare OAuth {error:"invalid_grant"}
      if (nonEmptyString(body['message'])) return { shape: 'oathweave', code: error, message: body['message'], requestId: stringField(body, 'requestId') };
      return { shape: 'code', code: error };
    }
    // Emberpath, HiveSkills, Cindertrace: {error:"human text"}
    return { shape: 'string', message: error, requestId: stringField(body, 'requestId', 'request_id') };
  }

  // HiveMem / FastAPI
  const detail = body['detail'];
  if (nonEmptyString(detail)) return { shape: 'fastapi', message: detail };
  if (Array.isArray(detail)) {
    const { message, issues } = fastApiIssues(detail);
    return { shape: 'fastapi-validation', code: 'validation_failed', message, details: { issues } };
  }
  if (isRecord(detail)) {
    return { shape: 'fastapi', code: stringField(detail, 'code', 'error'), message: stringField(detail, 'message', 'msg', 'detail') };
  }

  // Mattermost: {id, message, detailed_error, request_id, status_code}
  if (nonEmptyString(body['id']) && nonEmptyString(body['message']) && ('status_code' in body || 'request_id' in body)) {
    return {
      shape: 'mattermost',
      code: body['id'],
      message: body['message'],
      requestId: stringField(body, 'request_id'),
      status: validStatus(body['status_code']) ? body['status_code'] : undefined,
    };
  }

  if (nonEmptyString(body['message'])) {
    return { shape: 'message', code: stringField(body, 'code'), message: body['message'], requestId: stringField(body, 'requestId', 'request_id') };
  }
  return { shape: 'unknown', code: stringField(body, 'code') };
}

function looksLikeHtml(value: string): boolean {
  return /^\s*<(?:!doctype|html|head|body|\?xml)\b/i.test(value);
}

function parseBody(body: unknown): Parsed {
  if (body === undefined || body === null) return { shape: 'empty' };
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const textBody = typeof body === 'string' ? body : new TextDecoder().decode(body);
    if (!textBody.trim()) return { shape: 'empty' };
    try {
      const json: unknown = JSON.parse(textBody);
      if (isRecord(json)) return parseObject(json);
      if (typeof json === 'string' && json.trim()) return { shape: 'text', message: json };
      return { shape: 'unknown' };
    } catch {
      // HTML error pages from proxies carry nothing useful and may carry internals.
      return looksLikeHtml(textBody) ? { shape: 'text' } : { shape: 'text', message: textBody };
    }
  }
  if (isRecord(body)) return parseObject(body);
  return { shape: 'unknown' };
}

export interface ParseHiveErrorOptions {
  /** Used when the body carries no request ID, typically the response's `x-request-id`. */
  readonly requestId?: string | undefined;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Normalise any suite error response into a HiveError. `body` may be the raw text, bytes or
 * already-parsed JSON. Recognises every legacy shape in the suite (see `HiveErrorShape`); the
 * remote code is kept as sent and the recognised shape is on `error.shape`.
 *
 * `status` is the HTTP status. When it is not 400-599, a Mattermost `status_code` is used,
 * otherwise 502: a non-error status with an error body means the upstream misbehaved.
 */
export function parseHiveError(status: number, body: unknown, options: ParseHiveErrorOptions = {}): HiveError {
  const parsed = parseBody(body);
  const effectiveStatus = validStatus(status) ? status : parsed.status ?? 502;
  const code = (parsed.code !== undefined ? cleanCode(parsed.code) : undefined) ?? defaultCodeForStatus(effectiveStatus);
  const message = parsed.message !== undefined && cleanText(parsed.message) ? cleanText(parsed.message) : defaultMessageForStatus(effectiveStatus);
  const requestId = parsed.requestId !== undefined ? cleanText(parsed.requestId, 128) : options.requestId;
  return new HiveError(code, message, {
    status: effectiveStatus,
    shape: parsed.shape,
    ...(parsed.details ? { details: parsed.details } : {}),
    ...(requestId ? { requestId } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

/** Read a fetch `Response` and normalise it with `parseHiveError()`. Never throws on a bad body. */
export async function parseHiveErrorResponse(response: Response): Promise<HiveError> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  const requestId = response.headers.get('x-request-id') ?? undefined;
  const retryAfter = response.headers.get('retry-after');
  return parseHiveError(response.status, body, {
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
  });
}
