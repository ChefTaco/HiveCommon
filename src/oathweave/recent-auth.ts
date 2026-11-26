/**
 * Recent authentication (step-up) from an Oathweave ID token.
 *
 * A product that must know the person proved their identity a moment ago (before an upgrade, a
 * credential change, a terminal) asks the browser for a fresh OpenID Connect ID token: an
 * authorization request with `prompt=login` / `max_age`, PKCE and a nonce. The product's server,
 * never the browser, then checks that token here: RS256 signature against the issuer's JWKS,
 * exact issuer, an audience from an explicit list of clients (the browser clients the product
 * trusts for step-up), lifetime, nonce, subject and session when given, and that `auth_time` is
 * inside the window.
 *
 * Failure is closed: every refusal is a `RecentAuthenticationError` with a stable `code`.
 */
import { decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { HiveError } from '../errors/index.js';
import { assertOathweaveEndpoint, type EndpointOptions } from './endpoint.js';
import { OATHWEAVE_MAX_LIFETIME_SEC } from './claims.js';
import {
  keySource,
  mapVerifyError,
  OATHWEAVE_DEFAULT_CLOCK_TOLERANCE_SEC,
  OATHWEAVE_MAX_TOKEN_LENGTH,
  OATHWEAVE_REQUEST_TIMEOUT_MS,
} from './verifier.js';

/** The suite's default step-up window: five minutes, as Magnus and Emberpath use. */
export const RECENT_AUTHENTICATION_DEFAULT_MAX_AGE_SEC = 300;
/** The longest window a product may configure. A longer one is not "recent". */
export const RECENT_AUTHENTICATION_MAX_AGE_LIMIT_SEC = 3_600;

/**
 * Why a step-up proof was refused. Stable: products answer with it and UIs read it.
 *
 * - `REAUTH_REQUIRED`: there is no proof, or it cannot show when the person signed in (no
 *   `auth_time`). Ask the person to sign in again.
 * - `REAUTH_STALE`: a valid proof, but the sign-in is older than the window. Sign in again.
 * - `REAUTH_INVALID`: the token is not an acceptable ID token for this check (signature,
 *   issuer, audience, lifetime, nonce, subject or session). Do not retry with it.
 * - `REAUTH_UNAVAILABLE`: the issuer's keys could not be read. Retry later; never an accept.
 */
export type RecentAuthenticationCode = 'REAUTH_REQUIRED' | 'REAUTH_STALE' | 'REAUTH_INVALID' | 'REAUTH_UNAVAILABLE';

const MESSAGES: Readonly<Record<RecentAuthenticationCode, string>> = {
  REAUTH_REQUIRED: 'Sign in again to continue',
  REAUTH_STALE: 'The sign-in is too old for this action; sign in again',
  REAUTH_INVALID: 'The sign-in proof is not valid for this action',
  REAUTH_UNAVAILABLE: 'The identity provider keys are unavailable',
};

/**
 * A refused step-up proof. It is a HiveError (401, or 503 for `REAUTH_UNAVAILABLE`), so error
 * handlers send the suite envelope `{ error: { code, message, details: { reason } } }`. `reason`
 * says which check failed (`invalid_audience`, `nonce_mismatch`, `stale`, ...). Messages are fixed
 * and never include the token.
 */
export class RecentAuthenticationError extends HiveError {
  override readonly name = 'RecentAuthenticationError';
  override readonly code: RecentAuthenticationCode;
  readonly reason: string;

  constructor(code: RecentAuthenticationCode, reason: string, options: { readonly cause?: unknown; readonly details?: Record<string, unknown> } = {}) {
    super(code, MESSAGES[code], {
      status: code === 'REAUTH_UNAVAILABLE' ? 503 : 401,
      details: { reason, ...options.details },
      ...(code === 'REAUTH_UNAVAILABLE' ? { headers: { 'retry-after': '1' } } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.code = code;
    this.reason = reason;
  }
}

export function isRecentAuthenticationError(value: unknown): value is RecentAuthenticationError {
  return value instanceof RecentAuthenticationError
    || (HiveError.is(value) && value.name === 'RecentAuthenticationError' && typeof (value as { reason?: unknown }).reason === 'string');
}

export interface RecentAuthenticationOptions extends EndpointOptions {
  /** Accepted issuer, or issuers: the https browser issuer that signs the ID tokens. */
  readonly issuer: string | readonly string[];
  /**
   * The clients whose ID tokens count as step-up proof: the token's `aud`. Matched exactly; there
   * is no default, so a product names the browser clients it trusts (for example
   * `['hivexui-emberpath']`). An ID token's audience is a client, never a resource audience.
   */
  readonly audience: string | readonly string[];
  /** How recent `auth_time` must be, in seconds (1-3600). Defaults to 300. */
  readonly maxAgeSeconds?: number;
  /** The issuer's JWKS endpoint. Required unless `keys` is given. */
  readonly jwksUrl?: string;
  /** A local JWKS or a jose key resolver, instead of fetching `jwksUrl`. */
  readonly keys?: JSONWebKeySet | JWTVerifyGetKey;
  /** Seconds of clock skew tolerated on `exp`, `iat` and a future `auth_time`. Defaults to 30. */
  readonly clockToleranceSec?: number;
  /** Largest `exp - iat` in seconds. Defaults to 900. */
  readonly maxLifetimeSec?: number;
  readonly fetch?: typeof fetch;
  /** Clock in epoch milliseconds. */
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly jwksCacheMaxAgeMs?: number;
  readonly jwksCooldownMs?: number;
}

/** What one proof must also match. Each check runs only when its value is given. */
export interface RecentAuthenticationCheck {
  /** The nonce the browser sent with the authorization request. */
  readonly nonce?: string;
  /** The person already acting (for example the bearer token's `sub`): the proof must be theirs. */
  readonly subject?: string;
  /** The Oathweave session already acting (the access token's `sessionId`): the proof's `sid`. */
  readonly sessionId?: string;
  /** A narrower window for this call. It can only shorten the configured one. */
  readonly maxAgeSeconds?: number;
  /**
   * When the product started the re-authentication, epoch seconds (for example when it issued the
   * nonce). With `prompt=login` the sign-in must be new: an `auth_time` earlier than this, beyond
   * the clock tolerance, is refused as `REAUTH_STALE` (`before_request`), even inside the window.
   */
  readonly authenticatedAfter?: number;
}

/** A verified, recent sign-in. */
export interface RecentAuthentication {
  readonly subject: string;
  /** The `sid` claim, the Oathweave session; undefined when the token has none. */
  readonly sessionId: string | undefined;
  /** When the person signed in, epoch seconds. */
  readonly authTime: number;
  /** The client the token was issued to (one of the configured audiences). */
  readonly audience: string;
  readonly issuer: string;
  /** Epoch seconds. */
  readonly issuedAt: number;
  /** The token's `exp`, epoch seconds. */
  readonly expiresAt: number;
  /**
   * `authTime` plus the window that applied, epoch seconds: the step-up counts as recent until
   * then. A product that remembers the step-up must not honour it past this time.
   */
  readonly recentUntil: number;
  /** All verified claims. */
  readonly claims: Readonly<JWTPayload>;
}

export interface RecentAuthenticationVerifier {
  readonly issuers: readonly string[];
  readonly audiences: readonly string[];
  readonly maxAgeSeconds: number;
  /** Verify one ID token. Rejects with a `RecentAuthenticationError`. */
  verify(idToken: string | null | undefined, check?: RecentAuthenticationCheck): Promise<RecentAuthentication>;
}

function ageLimit(value: number | undefined, name: string): number {
  const seconds = value ?? RECENT_AUTHENTICATION_DEFAULT_MAX_AGE_SEC;
  if (!(Number.isInteger(seconds) && seconds >= 1 && seconds <= RECENT_AUTHENTICATION_MAX_AGE_LIMIT_SEC)) {
    throw new TypeError(`${name} must be an integer of 1-${RECENT_AUTHENTICATION_MAX_AGE_LIMIT_SEC} seconds`);
  }
  return seconds;
}

function list(value: string | readonly string[], name: string): string[] {
  const values: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? [...(value as readonly unknown[])] : [];
  if (!values.length || values.some(item => typeof item !== 'string' || !item)) throw new TypeError(`At least one ${name} is required`);
  return [...new Set(values as string[])];
}

function invalid(reason: string): RecentAuthenticationError {
  return new RecentAuthenticationError('REAUTH_INVALID', reason);
}

/** Create a step-up verifier. Throws a TypeError at startup when the configuration is unsafe. */
export function createRecentAuthenticationVerifier(options: RecentAuthenticationOptions): RecentAuthenticationVerifier {
  const issuers = list(options.issuer, 'Oathweave issuer');
  for (const issuer of issuers) assertOathweaveEndpoint(issuer, 'issuer', options);
  const audiences = list(options.audience, 'step-up audience');
  if (options.jwksUrl !== undefined) assertOathweaveEndpoint(options.jwksUrl, 'jwksUrl', options);
  if (options.jwksUrl === undefined && options.keys === undefined) throw new TypeError('Oathweave jwksUrl is required unless keys are given');
  const maxAgeSeconds = ageLimit(options.maxAgeSeconds, 'maxAgeSeconds');
  const clockTolerance = options.clockToleranceSec ?? OATHWEAVE_DEFAULT_CLOCK_TOLERANCE_SEC;
  if (!(typeof clockTolerance === 'number' && clockTolerance >= 0 && clockTolerance <= 300)) throw new TypeError('clockToleranceSec must be 0-300');
  const maxLifetime = options.maxLifetimeSec ?? OATHWEAVE_MAX_LIFETIME_SEC;
  if (!(typeof maxLifetime === 'number' && maxLifetime > 0 && maxLifetime <= 86_400)) throw new TypeError('maxLifetimeSec must be 1-86400');
  const timeoutMs = options.requestTimeoutMs ?? OATHWEAVE_REQUEST_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new TypeError('requestTimeoutMs must be a positive number');
  const request: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const keys = keySource(options, request, timeoutMs);

  async function verify(idToken: string | null | undefined, check: RecentAuthenticationCheck = {}): Promise<RecentAuthentication> {
    if (idToken === undefined || idToken === null || idToken === '') throw new RecentAuthenticationError('REAUTH_REQUIRED', 'missing_token');
    if (typeof idToken !== 'string' || idToken.length > OATHWEAVE_MAX_TOKEN_LENGTH || idToken.split('.').length !== 3) throw invalid('malformed_token');
    if (check.authenticatedAfter !== undefined && !(Number.isSafeInteger(check.authenticatedAfter) && check.authenticatedAfter > 0)) {
      throw new TypeError('check.authenticatedAfter must be a positive integer of epoch seconds');
    }
    const limit = check.maxAgeSeconds === undefined ? maxAgeSeconds : Math.min(maxAgeSeconds, ageLimit(check.maxAgeSeconds, 'check.maxAgeSeconds'));
    let alg: unknown;
    try {
      alg = decodeProtectedHeader(idToken).alg;
    } catch {
      throw invalid('malformed_token');
    }
    if (alg !== 'RS256') throw invalid('algorithm_not_allowed');
    const current = now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        algorithms: ['RS256'],
        issuer: issuers,
        audience: audiences,
        requiredClaims: ['sub', 'iat', 'exp'],
        maxTokenAge: maxLifetime,
        clockTolerance,
        currentDate: new Date(current),
      }));
    } catch (error) {
      const mapped = mapVerifyError(error);
      if (mapped.reason === 'jwks_unavailable') throw new RecentAuthenticationError('REAUTH_UNAVAILABLE', mapped.reason, { cause: mapped.cause });
      throw invalid(mapped.reason);
    }
    const { sub, iat, exp, iss, aud } = payload;
    // An ID token names exactly one client. An audience array, even one that contains a trusted
    // client, is refused: OpenID Connect would then need `azp`, which Oathweave never issues.
    if (typeof aud !== 'string' || !audiences.includes(aud)) throw invalid('invalid_audience');
    if (payload['azp'] !== undefined && payload['azp'] !== aud) throw invalid('invalid_audience');
    if (typeof sub !== 'string' || !sub || typeof iss !== 'string') throw invalid('invalid_claims');
    if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat || exp - iat > maxLifetime) throw invalid('invalid_lifetime');
    // An Oathweave access token is not an ID token, whatever its audience.
    if (payload['actorType'] !== undefined || payload['token_type'] !== undefined || payload['clientId'] !== undefined || payload['client_id'] !== undefined) {
      throw invalid('not_an_id_token');
    }
    if (check.nonce !== undefined && payload['nonce'] !== check.nonce) throw invalid('nonce_mismatch');
    if (check.subject !== undefined && sub !== check.subject) throw invalid('subject_mismatch');
    const sid = payload['sid'];
    if (sid !== undefined && (typeof sid !== 'string' || !sid)) throw invalid('invalid_claims');
    if (check.sessionId !== undefined && sid !== check.sessionId) throw invalid('session_mismatch');

    const authTime = payload['auth_time'];
    if (authTime === undefined) throw new RecentAuthenticationError('REAUTH_REQUIRED', 'missing_auth_time');
    if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0) throw invalid('invalid_auth_time');
    const seconds = Math.floor(current / 1000);
    // A sign-in after the token was issued, or in the future, is not a real sign-in time.
    if (authTime > iat + clockTolerance || authTime > seconds + clockTolerance) throw invalid('invalid_auth_time');
    if (seconds - authTime > limit) {
      throw new RecentAuthenticationError('REAUTH_STALE', 'stale', { details: { maxAgeSeconds: limit } });
    }
    if (check.authenticatedAfter !== undefined && authTime < check.authenticatedAfter - clockTolerance) {
      throw new RecentAuthenticationError('REAUTH_STALE', 'before_request');
    }
    return {
      subject: sub,
      sessionId: sid,
      authTime,
      audience: aud,
      issuer: iss,
      issuedAt: iat,
      expiresAt: exp,
      recentUntil: authTime + limit,
      claims: payload,
    };
  }

  return { issuers, audiences, maxAgeSeconds, verify };
}

/**
 * Verify one step-up ID token in a single call. Builds a verifier each time, so a product that
 * checks many tokens against a `jwksUrl` should keep a `createRecentAuthenticationVerifier()`
 * (or pass a shared jose resolver as `keys`) to reuse the fetched keys.
 */
export function verifyRecentAuthentication(
  options: RecentAuthenticationOptions & RecentAuthenticationCheck & { readonly idToken: string | null | undefined },
): Promise<RecentAuthentication> {
  const { idToken, nonce, subject, sessionId, authenticatedAfter, ...settings } = options;
  return createRecentAuthenticationVerifier(settings).verify(idToken, {
    ...(nonce !== undefined ? { nonce } : {}),
    ...(authenticatedAfter !== undefined ? { authenticatedAfter } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}
