import { HiveError } from '../errors/index.js';

/** Why a token or caller was refused. Stable: products and the conformance vectors rely on it. */
export type OathweaveFailureReason =
  // 401: the credential is missing or not acceptable.
  | 'missing_token'
  | 'malformed_token'
  | 'algorithm_not_allowed'
  | 'unknown_key'
  | 'invalid_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'invalid_lifetime'
  | 'invalid_claims'
  | 'wrong_principal_kind'
  | 'session_inactive'
  | 'subject_mismatch'
  // 403: the caller is known but may not do this.
  | 'not_linked'
  | 'insufficient_permission'
  // 503: verification could not run. Still fail closed, but the client should retry, not sign out.
  | 'jwks_unavailable'
  | 'identity_unavailable';

const MESSAGES: Readonly<Record<OathweaveFailureReason, string>> = {
  missing_token: 'A bearer token is required',
  malformed_token: 'The bearer token is malformed',
  algorithm_not_allowed: 'The token signing algorithm is not allowed',
  unknown_key: 'The token was signed by an unknown key',
  invalid_signature: 'The token signature is not valid',
  expired: 'The token has expired',
  not_yet_valid: 'The token is not valid yet',
  invalid_issuer: 'The token issuer is not accepted',
  invalid_audience: 'The token is not for this service',
  invalid_lifetime: 'The token lifetime is not acceptable',
  invalid_claims: 'The token claims are not valid',
  wrong_principal_kind: 'This kind of caller is not accepted here',
  session_inactive: 'The identity session is no longer active',
  subject_mismatch: 'The identity session does not match the token',
  not_linked: 'This identity has no access to this service',
  insufficient_permission: 'The caller lacks a required permission',
  jwks_unavailable: 'The identity provider keys are unavailable',
  identity_unavailable: 'The identity provider is unavailable',
};

/** The HTTP status for a failure reason: 401, 403 or 503. */
export function statusForReason(reason: OathweaveFailureReason): 401 | 403 | 503 {
  if (reason === 'not_linked' || reason === 'insufficient_permission') return 403;
  if (reason === 'jwks_unavailable' || reason === 'identity_unavailable') return 503;
  return 401;
}

function codeForReason(reason: OathweaveFailureReason): string {
  const status = statusForReason(reason);
  if (status === 403) return reason === 'insufficient_permission' ? 'insufficient_permission' : 'forbidden';
  if (status === 503) return 'auth_unavailable';
  return reason === 'missing_token' ? 'unauthorized' : 'invalid_token';
}

function challenge(reason: OathweaveFailureReason): Record<string, string> | undefined {
  const status = statusForReason(reason);
  if (status === 401) return { 'www-authenticate': reason === 'missing_token' ? 'Bearer' : 'Bearer error="invalid_token"' };
  if (reason === 'insufficient_permission') return { 'www-authenticate': 'Bearer error="insufficient_scope"' };
  if (status === 503) return { 'retry-after': '1' };
  return undefined;
}

/**
 * A refused Oathweave credential. It is a HiveError, so error handlers send it as the suite
 * envelope: `{ error: { code: 'invalid_token', message, details: { reason } } }` with 401, 403
 * or 503. Messages are fixed per reason and never include the token or provider responses.
 */
export class OathweaveError extends HiveError {
  override readonly name = 'OathweaveError';
  readonly reason: OathweaveFailureReason;

  constructor(reason: OathweaveFailureReason, options: { readonly cause?: unknown; readonly details?: Record<string, unknown> } = {}) {
    const headers = challenge(reason);
    super(codeForReason(reason), MESSAGES[reason], {
      status: statusForReason(reason),
      details: { reason, ...options.details },
      ...(headers ? { headers } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.reason = reason;
  }
}

export function isOathweaveError(value: unknown): value is OathweaveError {
  return value instanceof OathweaveError
    || (HiveError.is(value) && typeof (value as { reason?: unknown }).reason === 'string' && value.name === 'OathweaveError');
}
