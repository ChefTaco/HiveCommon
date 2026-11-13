/**
 * Shared rules for reading an inbound JSON request body: the options, the errors and the
 * parsing. The stream reading itself is per adapter (`/node-http`, `/hono`). Not a subpath.
 */
import { HiveError } from '../errors/index.js';

/** What can be wrong with an inbound body. */
export type BodyProblem =
  | 'too_large' // 413
  | 'unsupported_media_type' // 415
  | 'invalid_json' // 400
  | 'aborted'; // 400: the client went away mid-body

export interface ReadBodyLimits {
  /** Largest body accepted, in bytes. 1 MiB. */
  readonly maxBytes?: number;
  /**
   * Build the error thrown for a problem, for a product that keeps its own error class or
   * codes. By default a `HiveError`: 413 `too_large`, 415 `unsupported_media_type`, 400
   * `invalid_json`, 400 `request_aborted`.
   */
  readonly errorFor?: (problem: BodyProblem) => unknown;
}

export interface ReadJsonBodyOptions extends ReadBodyLimits {
  /**
   * When the `content-type` must be `application/json` (parameters such as `charset` allowed):
   * `non-empty` (the default) checks it only when there is a body, after reading it; `always`
   * checks it before reading anything, so a body-less request without it is refused too;
   * `never` skips the check. Set `jsonTypes: 'suffix'` to accept `application/*+json` as well.
   */
  readonly requireContentType?: 'always' | 'non-empty' | 'never';
  /** `exact` (the default) accepts `application/json` only; `suffix` also `application/<anything>+json`. */
  readonly jsonTypes?: 'exact' | 'suffix';
  /**
   * What an empty (or whitespace-only) body means. By default it is a 400 `invalid_json`; with
   * `emptyValue` set (to anything, `undefined` included) that value is returned instead.
   */
  readonly emptyValue?: unknown;
}

export interface JsonBody {
  /** The parsed JSON, or `emptyValue` for an empty body. */
  readonly value: unknown;
  /** The body as received, decoded as UTF-8: for a request fingerprint or a signature check. Empty when the body was. */
  readonly text: string;
  /** The body's length in bytes. */
  readonly bytes: number;
}

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const DEFAULTS: Readonly<Record<BodyProblem, readonly [status: number, code: string, message: string]>> = {
  too_large: [413, 'too_large', 'The request body is too large'],
  unsupported_media_type: [415, 'unsupported_media_type', 'Send the body as application/json'],
  invalid_json: [400, 'invalid_json', 'The request body is not valid JSON'],
  aborted: [400, 'request_aborted', 'The request body was not received'],
};

export function bodyError(problem: BodyProblem, options: ReadBodyLimits, details?: Readonly<Record<string, unknown>>): unknown {
  if (options.errorFor) return options.errorFor(problem);
  const [status, code, message] = DEFAULTS[problem];
  return new HiveError(code, message, { status, ...(details ? { details } : {}) });
}

export function maxBodyBytes(options: ReadBodyLimits): number {
  const max = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isFinite(max) || max < 0) throw new RangeError('maxBytes must be a non-negative number');
  return max;
}

/** The declared `content-length` when it is a plain number; undefined when absent or not one. */
export function declaredLength(value: string | null | undefined): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
}

export function isJsonContentType(value: string | null | undefined, types: 'exact' | 'suffix' = 'exact'): boolean {
  if (typeof value !== 'string') return false;
  const type = (value.split(';')[0] as string).trim().toLowerCase();
  return type === 'application/json' || (types === 'suffix' && /^application\/[a-z0-9!#$&^_.-]+\+json$/.test(type));
}

/** Refuse a wrong content type up front, for `requireContentType: 'always'`. */
export function checkContentTypeFirst(contentType: string | null | undefined, options: ReadJsonBodyOptions): void {
  if (options.requireContentType === 'always' && !isJsonContentType(contentType, options.jsonTypes)) throw bodyError('unsupported_media_type', options);
}

/** Decode and parse a body that has been read within the limit. */
export function parseJsonBody(bytes: Uint8Array, contentType: string | null | undefined, options: ReadJsonBodyOptions): JsonBody {
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) {
    if ('emptyValue' in options) return { value: options.emptyValue, text: '', bytes: bytes.byteLength };
    throw bodyError('invalid_json', options);
  }
  if ((options.requireContentType ?? 'non-empty') !== 'never' && !isJsonContentType(contentType, options.jsonTypes)) throw bodyError('unsupported_media_type', options);
  try {
    return { value: JSON.parse(text) as unknown, text, bytes: bytes.byteLength };
  } catch {
    throw bodyError('invalid_json', options);
  }
}
