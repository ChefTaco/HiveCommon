/**
 * Opaque cursors and the `?after=&limit=` feed query, shared by `/events` (which exports them)
 * and the isomorphic `/audit`. Not a subpath. Isomorphic: imports only `/errors`.
 */
import { HiveError } from '../errors/index.js';

export interface FeedQuery {
  /** Opaque cursor from a previous page's `nextCursor`; undefined for the first page. */
  readonly after: string | undefined;
  readonly limit: number;
}

export interface FeedQueryOptions {
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

/** Read `after` and `limit` from a query. Throws a 400 HiveError on malformed values. */
export function parseFeedQuery(
  query: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
  options: FeedQueryOptions = {},
): FeedQuery {
  const read = (name: string): string | undefined => {
    if (query instanceof URLSearchParams) {
      const values = query.getAll(name);
      if (values.length > 1) throw new HiveError('invalid_query', `${name} must be given once`, { status: 400 });
      return values[0];
    }
    const value = query[name];
    if (Array.isArray(value)) {
      if (value.length > 1) throw new HiveError('invalid_query', `${name} must be given once`, { status: 400 });
      return value[0] as string | undefined;
    }
    return value as string | undefined;
  };
  const maxLimit = options.maxLimit ?? 200;
  const defaultLimit = Math.min(options.defaultLimit ?? 50, maxLimit);
  const rawLimit = read('limit');
  let limit = defaultLimit;
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^\d{1,6}$/.test(rawLimit) || Number(rawLimit) < 1) {
      throw new HiveError('invalid_query', `limit must be an integer from 1 to ${maxLimit}`, { status: 400 });
    }
    limit = Math.min(Number(rawLimit), maxLimit);
  }
  const after = read('after');
  if (after !== undefined && after !== '' && !/^[A-Za-z0-9._~:-]{1,512}$/.test(after)) {
    throw new HiveError('invalid_query', 'after must be a cursor from a previous page', { status: 400 });
  }
  return { after: after || undefined, limit };
}

/** Encode a cursor position as an opaque base64url string. Isomorphic. */
export function encodeCursor(position: Readonly<Record<string, string | number>>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a cursor from `encodeCursor()`. Throws a 400 HiveError when it was tampered with. */
export function decodeCursor(cursor: string): Record<string, string | number> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('not base64url');
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.values(value).every(item => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))) throw new Error('not a position');
    return value as Record<string, string | number>;
  } catch {
    throw new HiveError('invalid_cursor', 'The cursor is not valid', { status: 400 });
  }
}
