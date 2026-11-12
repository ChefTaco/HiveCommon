/**
 * The Oathweave access-token verifier: RS256 against the issuer's JWKS, exact issuer and
 * audience, bounded lifetime with clock tolerance, user/service principal rules, and an
 * optional online session check through userinfo with a short shared cache.
 *
 * Failure is closed: every refusal is an `OathweaveError` (401, 403 or 503).
 */
import { createHash } from 'node:crypto';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  CLIENT_ID_CLAIMS,
  principalFromClaims,
  type AcceptPrincipal,
  type ClientIdClaim,
  type OathweaveLifetimeLimits,
  type OathweavePrincipal,
  type OathweaveServicePrincipal,
  type OathweaveUserPrincipal,
} from './claims.js';
import { assertOathweaveEndpoint, type EndpointOptions } from './endpoint.js';
import { OathweaveError } from './errors.js';

/** How long a userinfo answer is reused, measured from when its request started. */
export const OATHWEAVE_SESSION_CACHE_TTL_MS = 10_000;
/** How often a long-lived connection should re-check its token. */
export const OATHWEAVE_STREAM_RECHECK_MS = 5_000;
/** Failed session checks are remembered this long, so one failing request does not verify twice. */
export const OATHWEAVE_FAILED_CHECK_TTL_MS = 2_000;
export const OATHWEAVE_SESSION_CACHE_MAX = 5_000;
export const OATHWEAVE_REQUEST_TIMEOUT_MS = 3_000;
/** Oathweave access tokens live at most fifteen minutes. */
export const OATHWEAVE_MAX_LIFETIME_SEC = 900;
export const OATHWEAVE_DEFAULT_CLOCK_TOLERANCE_SEC = 30;
/** Longest accepted compact token. Real Oathweave tokens are well under 4 KiB. */
export const OATHWEAVE_MAX_TOKEN_LENGTH = 16_384;
/**
 * What a native issuer identifier must look like: a lowercase name such as `hive-iam`, never a
 * URL, so it cannot be confused with an https issuer.
 */
export const OATHWEAVE_NATIVE_ISSUER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface OathweaveVerifierOptions extends EndpointOptions {
  /** Accepted issuer, or issuers. Each must be an https URL. */
  readonly issuer: string | readonly string[];
  /**
   * Oathweave's native issuer identifiers (its `JWT_ISSUER`, for example `hive-iam`) to accept
   * as well. Oathweave signs client-credentials tokens with its native issuer unless the
   * client's policy selects the browser issuer, and with the same keys, so these tokens are
   * verified against the same `jwksUrl` or `keys`. Each must match
   * `OATHWEAVE_NATIVE_ISSUER_PATTERN`. Defaults to none: a native issuer is never accepted
   * unless it is listed here.
   */
  readonly nativeIssuers?: readonly string[];
  /**
   * Which principals a native issuer may sign for. Defaults to `service`: suite user tokens
   * come from browser clients, which Oathweave always signs with the https issuer.
   */
  readonly nativeIssuerAccept?: AcceptPrincipal;
  /** This service's resource audience, for example `hivemem`. Matched exactly. */
  readonly audience: string;
  /** The issuer's JWKS endpoint. Required unless `keys` is given. */
  readonly jwksUrl?: string;
  /**
   * The userinfo endpoint. When set, user tokens are also checked online, so a signed-out
   * session stops working within the cache TTL. Recommended for every product.
   */
  readonly userinfoUrl?: string;
  /** A local JWKS or a jose key resolver, instead of fetching `jwksUrl`. */
  readonly keys?: JSONWebKeySet | JWTVerifyGetKey;
  /** Which principals `verify()` accepts by default. Defaults to `user`. */
  readonly accept?: AcceptPrincipal;
  /** Seconds of clock skew tolerated on `exp`, `nbf` and `iat`. Defaults to 30. */
  readonly clockToleranceSec?: number;
  /**
   * Largest `exp - iat` and token age in seconds: one limit for every token, or one per
   * principal kind (`{ user: 900, service: 300 }`). Each defaults to 900.
   */
  readonly maxLifetimeSec?: number | OathweaveLifetimeLimits;
  readonly fetch?: typeof fetch;
  /** Clock in epoch milliseconds. */
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  /** How long fetched keys are trusted before a refetch. Defaults to 10 minutes. */
  readonly jwksCacheMaxAgeMs?: number;
  /** Minimum time between refetches triggered by an unknown `kid` (key rotation). Defaults to 30 s. */
  readonly jwksCooldownMs?: number;
  /**
   * How long a userinfo answer is reused, in milliseconds. Defaults to 10 000; 0 checks the
   * session online on every call.
   */
  readonly sessionCacheTtlMs?: number;
  readonly sessionCacheMax?: number;
  /**
   * Refuse a token without a `roles` array. Defaults to false, where an absent `roles` claim
   * means no roles. A present claim that is not a string array is always refused.
   */
  readonly requireRoles?: boolean;
  /**
   * Which claim names supply the client ID: `clientId` (Oathweave), `client_id` (RFC 9068) or
   * `either` (the default). When both claims are present they must agree in every mode.
   */
  readonly clientIdClaim?: ClientIdClaim;
}

export interface VerifyOptions {
  /** Override the verifier's default `accept` for this call. */
  readonly accept?: AcceptPrincipal;
}

export interface OathweaveVerifier {
  /** The accepted https issuers. */
  readonly issuers: readonly string[];
  /** The accepted native issuer identifiers; empty unless configured. */
  readonly nativeIssuers: readonly string[];
  readonly audience: string;
  verify(token: string, options?: VerifyOptions): Promise<OathweavePrincipal>;
  verifyUser(token: string): Promise<OathweaveUserPrincipal>;
  verifyService(token: string): Promise<OathweaveServicePrincipal>;
  /** Verify an `Authorization` header value. A missing header is `missing_token`. */
  verifyAuthorization(header: string | null | undefined, options?: VerifyOptions): Promise<OathweavePrincipal>;
  /** Forget cached session answers, for example after a sign-out event. */
  clearSessionCache(): void;
}

const BEARER = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)[ ]*$/i;

/**
 * The token in an `Authorization: Bearer` header (RFC 6750). Undefined when there is no
 * header; throws `malformed_token` when there is one but it is not a single bearer token.
 */
export function parseBearerToken(header: string | null | undefined): string | undefined {
  if (header === undefined || header === null || header === '') return undefined;
  const match = BEARER.exec(header);
  if (!match?.[1]) throw new OathweaveError('malformed_token');
  return match[1];
}

/** Errors from the key source that mean "could not get keys", not "bad token". */
class KeySourceUnavailable extends Error {}

function keySource(options: OathweaveVerifierOptions, request: typeof fetch, timeoutMs: number): JWTVerifyGetKey {
  let resolver: JWTVerifyGetKey;
  if (typeof options.keys === 'function') resolver = options.keys;
  else if (options.keys) resolver = createLocalJWKSet(options.keys);
  else {
    if (!options.jwksUrl) throw new TypeError('Oathweave jwksUrl is required unless keys are given');
    resolver = createRemoteJWKSet(new URL(options.jwksUrl), {
      timeoutDuration: timeoutMs,
      cacheMaxAge: options.jwksCacheMaxAgeMs ?? 10 * 60_000,
      cooldownDuration: options.jwksCooldownMs ?? 30_000,
      [customFetch]: (url, init) => request(url, { ...init, redirect: 'error' }),
    });
  }
  return async (header, token) => {
    try {
      return await resolver(header, token);
    } catch (error) {
      // An unknown kid is the token's problem (after jose's rotation refetch); anything else
      // (network, timeout, non-200, malformed JWKS) means the keys could not be obtained.
      if (error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JWKSMultipleMatchingKeys) throw error;
      throw new KeySourceUnavailable('keys unavailable', { cause: error });
    }
  };
}

/** Map a jose or key-source failure onto a stable reason. */
function mapVerifyError(error: unknown): OathweaveError {
  if (error instanceof KeySourceUnavailable) return new OathweaveError('jwks_unavailable', { cause: error.cause });
  if (error instanceof joseErrors.JWTExpired) return new OathweaveError('expired');
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'nbf' || (error.claim === 'iat' && error.reason === 'check_failed')) return new OathweaveError('not_yet_valid');
    if (error.claim === 'iss') return new OathweaveError('invalid_issuer');
    if (error.claim === 'aud') return new OathweaveError('invalid_audience');
    return new OathweaveError('invalid_claims');
  }
  if (error instanceof joseErrors.JWKSNoMatchingKey) return new OathweaveError('unknown_key');
  if (error instanceof joseErrors.JWSSignatureVerificationFailed || error instanceof joseErrors.JWKSMultipleMatchingKeys) {
    return new OathweaveError('invalid_signature');
  }
  // JOSEAlgNotAllowed cannot occur: the header precheck already refused every algorithm but RS256.
  return new OathweaveError('malformed_token');
}

interface SessionCheck {
  expiresAt: number;
  displayName: Promise<string>;
}

const ACCEPT_VALUES: readonly AcceptPrincipal[] = ['user', 'service', 'any'];

/** Validate the configured native issuer identifiers. */
function nativeIssuerList(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Oathweave nativeIssuers must be an array');
  for (const issuer of value as readonly unknown[]) {
    if (typeof issuer !== 'string' || !OATHWEAVE_NATIVE_ISSUER_PATTERN.test(issuer)) {
      throw new TypeError('Oathweave nativeIssuers entries must be lowercase identifiers such as hive-iam');
    }
  }
  return [...new Set(value)];
}

/** Resolve `maxLifetimeSec` into one limit per principal kind. */
function lifetimeLimits(value: number | OathweaveLifetimeLimits | undefined): Required<OathweaveLifetimeLimits> {
  const limits = typeof value === 'object' && value !== null
    ? { user: value.user ?? OATHWEAVE_MAX_LIFETIME_SEC, service: value.service ?? OATHWEAVE_MAX_LIFETIME_SEC }
    : { user: value ?? OATHWEAVE_MAX_LIFETIME_SEC, service: value ?? OATHWEAVE_MAX_LIFETIME_SEC };
  for (const limit of [limits.user, limits.service]) {
    if (!(typeof limit === 'number' && limit > 0 && limit <= 86_400)) throw new TypeError('maxLifetimeSec must be 1-86400');
  }
  return limits;
}

/** Create a verifier. Throws a TypeError at startup when the configuration is unsafe. */
export function createOathweaveVerifier(options: OathweaveVerifierOptions): OathweaveVerifier {
  const issuers = typeof options.issuer === 'string' ? [options.issuer] : [...options.issuer];
  if (!issuers.length) throw new TypeError('At least one Oathweave issuer is required');
  for (const issuer of issuers) assertOathweaveEndpoint(issuer, 'issuer', options);
  const nativeIssuers = nativeIssuerList(options.nativeIssuers);
  const nativeIssuerAccept = options.nativeIssuerAccept ?? 'service';
  if (!ACCEPT_VALUES.includes(nativeIssuerAccept)) throw new TypeError("nativeIssuerAccept must be 'user', 'service' or 'any'");
  if (options.jwksUrl !== undefined) assertOathweaveEndpoint(options.jwksUrl, 'jwksUrl', options);
  if (options.userinfoUrl !== undefined) assertOathweaveEndpoint(options.userinfoUrl, 'userinfoUrl', options);
  if (typeof options.audience !== 'string' || !options.audience) throw new TypeError('Oathweave audience is required');
  const clockTolerance = options.clockToleranceSec ?? OATHWEAVE_DEFAULT_CLOCK_TOLERANCE_SEC;
  const lifetimes = lifetimeLimits(options.maxLifetimeSec);
  if (!(clockTolerance >= 0 && clockTolerance <= 300)) throw new TypeError('clockToleranceSec must be 0-300');
  const requireRoles = options.requireRoles ?? false;
  const clientIdClaim = options.clientIdClaim ?? 'either';
  if (typeof requireRoles !== 'boolean') throw new TypeError('requireRoles must be a boolean');
  if (!CLIENT_ID_CLAIMS.includes(clientIdClaim)) throw new TypeError("clientIdClaim must be 'clientId', 'client_id' or 'either'");

  const defaultAccept = options.accept ?? 'user';
  const timeoutMs = options.requestTimeoutMs ?? OATHWEAVE_REQUEST_TIMEOUT_MS;
  const request: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const keys = keySource(options, request, timeoutMs);
  const acceptedIssuers = [...issuers, ...nativeIssuers];
  const sessionTtl = options.sessionCacheTtlMs ?? OATHWEAVE_SESSION_CACHE_TTL_MS;
  const sessionMax = options.sessionCacheMax ?? OATHWEAVE_SESSION_CACHE_MAX;

  // Holds only tokens whose signature verified, so garbage can neither fill it nor reach userinfo.
  const sessions = new Map<string, SessionCheck>();

  async function fetchDisplayName(token: string, subject: string): Promise<string> {
    let response: Response;
    try {
      response = await request(options.userinfoUrl as string, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OathweaveError('identity_unavailable', { cause: error });
    }
    if (response.status === 401 || response.status === 403) throw new OathweaveError('session_inactive');
    if (!response.ok) throw new OathweaveError('identity_unavailable');
    let user: unknown;
    try {
      user = await response.json();
    } catch (error) {
      throw new OathweaveError('identity_unavailable', { cause: error });
    }
    if (!user || typeof user !== 'object' || (user as { sub?: unknown }).sub !== subject) throw new OathweaveError('subject_mismatch');
    const name = (user as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : subject;
  }

  function sessionCheck(token: string, subject: string): Promise<string> {
    const key = createHash('sha256').update(token).digest('hex');
    const startedAt = now();
    const current = sessions.get(key);
    if (current && startedAt < current.expiresAt) return current.displayName;
    sessions.delete(key);
    if (sessions.size >= sessionMax) {
      for (const [entryKey, entry] of sessions) if (entry.expiresAt <= startedAt) sessions.delete(entryKey);
      if (sessions.size >= sessionMax) sessions.delete(sessions.keys().next().value as string);
    }
    // Concurrent callers share one in-flight request; the TTL runs from when it started.
    const check: SessionCheck = { expiresAt: startedAt + sessionTtl, displayName: fetchDisplayName(token, subject) };
    check.displayName.catch(() => {
      check.expiresAt = Math.min(check.expiresAt, now() + OATHWEAVE_FAILED_CHECK_TTL_MS);
    });
    sessions.set(key, check);
    return check.displayName;
  }

  async function verify(token: string, verifyOptions: VerifyOptions = {}): Promise<OathweavePrincipal> {
    if (typeof token !== 'string' || !token) throw new OathweaveError('missing_token');
    if (token.length > OATHWEAVE_MAX_TOKEN_LENGTH || token.split('.').length !== 3) throw new OathweaveError('malformed_token');
    let alg: unknown;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new OathweaveError('malformed_token');
    }
    // Refuse `none`, HMAC and every other algorithm before any key lookup.
    if (alg !== 'RS256') throw new OathweaveError('algorithm_not_allowed');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: acceptedIssuers,
        audience: options.audience,
        requiredClaims: ['sub', 'iat', 'exp', 'jti'],
        // The per-kind limit is checked on `exp - iat` below, which also bounds the age.
        maxTokenAge: Math.max(lifetimes.user, lifetimes.service),
        clockTolerance,
        currentDate: new Date(now()),
      }));
    } catch (error) {
      throw mapVerifyError(error);
    }
    // jose accepts an audience array that contains ours; Oathweave issues exactly one audience.
    if (payload.aud !== options.audience) throw new OathweaveError('invalid_audience');

    const principal = principalFromClaims(payload, {
      accept: verifyOptions.accept ?? defaultAccept,
      maxLifetimeSec: lifetimes,
      requireRoles,
      clientIdClaim,
    });
    // A native issuer signs only the principals it was configured for.
    if (nativeIssuers.includes(principal.issuer) && nativeIssuerAccept !== 'any' && nativeIssuerAccept !== principal.kind) {
      throw new OathweaveError('invalid_issuer');
    }
    if (principal.kind === 'user' && options.userinfoUrl) {
      const displayName = await sessionCheck(token, principal.subject);
      return { ...principal, displayName, sessionChecked: true };
    }
    return principal;
  }

  return {
    issuers,
    nativeIssuers,
    audience: options.audience,
    verify,
    verifyUser: token => verify(token, { accept: 'user' }) as Promise<OathweaveUserPrincipal>,
    verifyService: token => verify(token, { accept: 'service' }) as Promise<OathweaveServicePrincipal>,
    async verifyAuthorization(header, verifyOptions) {
      const token = parseBearerToken(header);
      if (token === undefined) throw new OathweaveError('missing_token');
      return verify(token, verifyOptions);
    },
    clearSessionCache: () => sessions.clear(),
  };
}
