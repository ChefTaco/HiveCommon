/**
 * Comparing shared secrets: constant-time string equality, static bearer tokens checked against
 * a stored SHA-256 digest, and reading the token out of an `Authorization` header.
 *
 * Node only (`node:crypto`). For Oathweave access tokens use `/oathweave`; this is for the
 * static service credentials and webhook secrets products still hold.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Whether two strings are equal, in time that does not depend on where they differ. Strings of
 * different byte length are unequal; that they differ in length is not hidden (hash both sides
 * first, as `matchesSha256Digest()` does, when the length is itself secret).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Spend a comparison anyway, so the unequal-length path costs about the same.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** The SHA-256 digest of a string (UTF-8) as lowercase hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface DigestMatchOptions {
  /**
   * Accept a stored digest written in uppercase hex. Off by default: the comparison is exact,
   * so a digest must be stored as lowercase hex.
   */
  readonly caseInsensitive?: boolean;
}

/**
 * Whether `token` is the credential whose SHA-256 digest (lowercase hex) is stored. An unset
 * digest or an empty token never matches, so a missing setting cannot open a route.
 */
export function matchesSha256Digest(token: string | null | undefined, expectedDigest: string | null | undefined, options: DigestMatchOptions = {}): boolean {
  if (typeof token !== 'string' || !token || typeof expectedDigest !== 'string' || !expectedDigest) return false;
  return timingSafeEqualString(sha256Hex(token), options.caseInsensitive ? expectedDigest.toLowerCase() : expectedDigest);
}

export interface BearerTokenOptions {
  /** Match the `Bearer` scheme name exactly. Off by default: RFC 9110 makes scheme names case-insensitive. */
  readonly caseSensitiveScheme?: boolean;
  /**
   * Treat a header without the `Bearer` scheme as the token itself. Off by default; only for a
   * route that has always accepted a bare credential.
   */
  readonly allowBare?: boolean;
}

/**
 * The token in an `Authorization: Bearer <token>` header, or undefined when the header is
 * absent, repeated, uses another scheme, or carries no single token. Never throws: a static
 * credential check answers 401 for all of these alike. (For Oathweave tokens,
 * `parseBearerToken()` in `/oathweave` is stricter and throws `malformed_token`.)
 */
export function readBearerToken(header: string | readonly string[] | null | undefined, options: BearerTokenOptions = {}): string | undefined {
  const value = Array.isArray(header) ? (header.length === 1 ? header[0] as unknown : undefined) : header;
  if (typeof value !== 'string') return undefined;
  const match = (options.caseSensitiveScheme ? /^Bearer\s+(\S+)\s*$/ : /^Bearer\s+(\S+)\s*$/i).exec(value);
  if (match) return match[1];
  if (!options.allowBare) return undefined;
  const bare = value.trim();
  return bare && !/\s/.test(bare) ? bare : undefined;
}

/**
 * Whether an `Authorization` header carries the static bearer token whose SHA-256 digest is
 * stored. False for a missing header, another scheme, an empty token or an unset digest.
 */
export function bearerMatchesSha256Digest(
  header: string | readonly string[] | null | undefined,
  expectedDigest: string | null | undefined,
  options: BearerTokenOptions & DigestMatchOptions = {},
): boolean {
  return matchesSha256Digest(readBearerToken(header, options), expectedDigest, options);
}
