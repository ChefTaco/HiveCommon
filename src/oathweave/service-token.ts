/**
 * A service's own Oathweave identity: short-lived `client_credentials` access tokens, fetched
 * on first use, cached, and replaced before they expire.
 */
import { HiveError } from '../errors/index.js';
import { BoundedFetchError, parseJsonBytes, readBodyBounded } from '../fetch/index.js';
import { assertOathweaveEndpoint } from './endpoint.js';

/** Why no service token could be given. */
export type ServiceTokenFailure =
  | 'backoff' // a recent request failed; no new one is made until the backoff passes
  | 'http' // the token endpoint answered with an error status (see `upstreamStatus`)
  | 'network' // the token endpoint could not be reached
  | 'timeout'
  | 'malformed_response' // not JSON, too large, or without an access_token
  | 'expired_token' // the issued token is already (nearly) expired
  | 'audience_mismatch'; // the issued JWT is not for the requested audience

const MESSAGES: Readonly<Record<ServiceTokenFailure, string>> = {
  backoff: 'Oathweave token request is backing off after a failure',
  http: 'Oathweave token request failed',
  network: 'Oathweave token request failed (network error)',
  timeout: 'Oathweave token request timed out',
  malformed_response: 'Oathweave token response is malformed',
  expired_token: 'Oathweave issued an expired token',
  audience_mismatch: 'Oathweave issued a token for another audience',
};

/**
 * No service token could be obtained. A `HiveError` with status 503 and code
 * `auth_unavailable`; `reason` says why. The message is fixed per reason (plus the HTTP status)
 * and never holds the client secret, a token or the endpoint's response body.
 */
export class ServiceTokenError extends HiveError {
  override readonly name = 'ServiceTokenError';
  readonly reason: ServiceTokenFailure;
  /** The token endpoint's HTTP status, for `http`. */
  readonly upstreamStatus: number | undefined;

  constructor(reason: ServiceTokenFailure, options: { readonly upstreamStatus?: number; readonly cause?: unknown } = {}) {
    super('auth_unavailable', reason === 'http' && options.upstreamStatus !== undefined ? `${MESSAGES.http} (HTTP ${options.upstreamStatus})` : MESSAGES[reason], {
      status: 503,
      details: { reason, ...(options.upstreamStatus !== undefined ? { upstreamStatus: options.upstreamStatus } : {}) },
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.reason = reason;
    this.upstreamStatus = options.upstreamStatus;
  }
}

export function isServiceTokenError(value: unknown): value is ServiceTokenError {
  return value instanceof ServiceTokenError
    || (HiveError.is(value) && value.name === 'ServiceTokenError' && typeof (value as { reason?: unknown }).reason === 'string');
}

export interface ServiceTokenProviderOptions {
  /** The Oathweave token endpoint. https only (see `allowInsecureLoopback`). */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** The client secret. Sent only to `tokenUrl`; never logged or put in an error. */
  readonly clientSecret: string;
  /** Sent as the `scope` form field when set. */
  readonly scope?: string | undefined;
  /** Sent as the `audience` form field when set, and checked against the issued JWT (see `verifyAudience`). */
  readonly audience?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Deadline for one token request. 10 000 ms. */
  readonly timeoutMs?: number;
  /** Largest token response accepted. 64 KiB. */
  readonly maxResponseBytes?: number;
  /**
   * After a failed request, how long `token()` refuses to start another (callers get the cached
   * token while it is usable, else a `backoff` error). 5000 ms; `0` retries on the next call.
   */
  readonly failureBackoffMs?: number;
  /** Lifetime assumed when the response has no usable `expires_in`. 300 s. */
  readonly defaultLifetimeSec?: number;
  /** `expires_in` is raised to this. 10 000 ms; `0` trusts a shorter lifetime. */
  readonly minLifetimeMs?: number;
  /** `expires_in` is lowered to this. One hour; `Infinity` trusts a longer lifetime. */
  readonly maxLifetimeMs?: number;
  /**
   * A cached token is no longer handed out this long before it expires, so it does not expire
   * on its way to the resource. 5000 ms.
   */
  readonly expiryMarginMs?: number;
  /**
   * When to replace a token: milliseconds after it was requested, given its lifetime. Defaults
   * to 80 % of the lifetime and at least 30 s before the end, whichever is earlier.
   */
  readonly refreshAfterMs?: (lifetimeMs: number) => number;
  /**
   * Lower the expiry to the `exp` claim when the token is a JWT and `exp` is earlier than
   * `expires_in` says. On by default. The claim is read without verifying the token: it is only
   * ever used to expire the cache sooner.
   */
  readonly clampToTokenExpiry?: boolean;
  /**
   * While a replacement is being fetched, or a fetch just failed, keep handing out the cached
   * token as long as it is still usable. On by default. When false, callers that arrive after
   * the refresh point wait for the replacement and see its failure.
   */
  readonly serveStaleWhileRefreshing?: boolean;
  /**
   * With `audience` set: refuse an issued JWT whose `aud` claim does not include it (a token
   * that is not a JWT, or has no `aud`, passes). On by default.
   */
  readonly verifyAudience?: boolean;
  /** Allow an `http:` `tokenUrl` on loopback, for tests. */
  readonly allowInsecureLoopback?: boolean;
}

export interface ServiceTokenProvider {
  /** A usable access token: the cached one, or a new one. Concurrent callers share one request. */
  token(): Promise<string>;
  /** Forget the cached token, for example after the resource answered 401. */
  invalidate(): void;
}

export const SERVICE_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
export const SERVICE_TOKEN_FAILURE_BACKOFF_MS = 5_000;
export const SERVICE_TOKEN_EXPIRY_MARGIN_MS = 5_000;

/** Claims of a JWT, read without verifying it. Undefined when the token is not a JWT. */
function unverifiedClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const binary = atob((parts[1] as string).replace(/-/g, '+').replace(/_/g, '/'));
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function nonNegative(value: number | undefined, fallback: number, name: string, allowInfinity = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || (!allowInfinity && !Number.isFinite(value))) {
    throw new TypeError(`Service token ${name} must be a non-negative number`);
  }
  return value;
}

function defaultRefreshAfter(lifetimeMs: number): number {
  return Math.min(lifetimeMs * 0.8, lifetimeMs - 30_000);
}

/**
 * A token source for one machine client (Oathweave binds a client to one audience, so use one
 * provider per audience). `token()` fetches on first use, serves the cached token until it is
 * due for replacement, refreshes in the background before expiry, shares one request between
 * concurrent callers and backs off after a failure.
 */
export function createServiceTokenProvider(options: ServiceTokenProviderOptions): ServiceTokenProvider {
  assertOathweaveEndpoint(options.tokenUrl, 'tokenUrl', { allowInsecureLoopback: options.allowInsecureLoopback ?? false });
  if (typeof options.clientId !== 'string' || !options.clientId) throw new TypeError('Service token clientId is required');
  if (typeof options.clientSecret !== 'string' || !options.clientSecret) throw new TypeError('Service token clientSecret is required');
  const { tokenUrl, clientId, clientSecret, scope, audience } = options;
  const request: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = nonNegative(options.timeoutMs, SERVICE_TOKEN_REQUEST_TIMEOUT_MS, 'timeoutMs');
  if (timeoutMs === 0) throw new TypeError('Service token timeoutMs must be positive');
  const maxResponseBytes = nonNegative(options.maxResponseBytes, 64 * 1024, 'maxResponseBytes');
  const backoffMs = nonNegative(options.failureBackoffMs, SERVICE_TOKEN_FAILURE_BACKOFF_MS, 'failureBackoffMs');
  const defaultLifetimeMs = nonNegative(options.defaultLifetimeSec, 300, 'defaultLifetimeSec') * 1000;
  const minLifetimeMs = nonNegative(options.minLifetimeMs, 10_000, 'minLifetimeMs');
  const maxLifetimeMs = nonNegative(options.maxLifetimeMs, 3_600_000, 'maxLifetimeMs', true);
  if (maxLifetimeMs < minLifetimeMs) throw new TypeError('Service token maxLifetimeMs must not be below minLifetimeMs');
  const marginMs = nonNegative(options.expiryMarginMs, SERVICE_TOKEN_EXPIRY_MARGIN_MS, 'expiryMarginMs');
  const refreshAfter = options.refreshAfterMs ?? defaultRefreshAfter;
  const clamp = options.clampToTokenExpiry ?? true;
  const serveStale = options.serveStaleWhileRefreshing ?? true;
  const verifyAudience = options.verifyAudience ?? true;

  let cached: { readonly token: string; readonly refreshAt: number; readonly expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;
  let retryAt = 0;

  async function fetchToken(): Promise<string> {
    const startedAt = now();
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    if (scope) form.set('scope', scope);
    if (audience) form.set('audience', audience);
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      let bytes: Uint8Array;
      try {
        const response = await request(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: form.toString(),
          redirect: 'error',
          signal: deadline,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          // Never include the response body: it may echo the request.
          throw new ServiceTokenError('http', { upstreamStatus: response.status });
        }
        bytes = await readBodyBounded(response, maxResponseBytes, { signal: deadline });
      } catch (error) {
        if (error instanceof ServiceTokenError) throw error;
        if (error instanceof BoundedFetchError) throw new ServiceTokenError('malformed_response');
        // The cause is kept off the error: a fetch failure can describe the request it carried.
        throw new ServiceTokenError(deadline.aborted ? 'timeout' : 'network');
      }
      let body: unknown;
      try {
        body = parseJsonBytes(bytes);
      } catch {
        throw new ServiceTokenError('malformed_response');
      }
      const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const token = record['access_token'];
      if (typeof token !== 'string' || !token) throw new ServiceTokenError('malformed_response');
      const claims = unverifiedClaims(token);
      if (audience && verifyAudience && claims && claims['aud'] !== undefined) {
        const audiences: unknown[] = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
        if (!audiences.includes(audience)) throw new ServiceTokenError('audience_mismatch');
      }
      const expiresIn = record['expires_in'];
      const stated = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : defaultLifetimeMs;
      const lifetime = Math.min(maxLifetimeMs, Math.max(minLifetimeMs, stated));
      const exp = clamp && claims && typeof claims['exp'] === 'number' && Number.isFinite(claims['exp']) ? claims['exp'] * 1000 : Number.POSITIVE_INFINITY;
      const expiresAt = Math.min(startedAt + lifetime, exp);
      if (expiresAt - marginMs <= now()) throw new ServiceTokenError('expired_token');
      const span = expiresAt - startedAt;
      const refreshIn = refreshAfter(span);
      cached = { token, expiresAt, refreshAt: startedAt + Math.max(0, Math.min(span, Number.isFinite(refreshIn) ? refreshIn : span)) };
      retryAt = 0;
      return token;
    } catch (error) {
      retryAt = now() + backoffMs;
      throw error;
    }
  }

  return {
    token(): Promise<string> {
      const at = now();
      const usable = cached && cached.expiresAt - marginMs > at ? cached : undefined;
      if (usable && usable.refreshAt > at) return Promise.resolve(usable.token);
      const stale = serveStale ? usable : undefined;
      if (inFlight) return stale ? Promise.resolve(stale.token) : inFlight;
      if (at < retryAt) return stale ? Promise.resolve(stale.token) : Promise.reject(new ServiceTokenError('backoff'));
      const refresh = fetchToken().finally(() => { inFlight = undefined; });
      inFlight = refresh;
      if (stale) {
        // A failed background refresh is reported to the callers that come once the token is no
        // longer usable; here it must not become an unhandled rejection.
        refresh.catch(() => undefined);
        return Promise.resolve(stale.token);
      }
      return refresh;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
