/** Pure claim checks and principal extraction for verified Oathweave access tokens. */
import type { JWTPayload } from 'jose';
import { OathweaveError } from './errors.js';

export type PrincipalKind = 'user' | 'service';
/** Which principals a verifier or route accepts. */
export type AcceptPrincipal = PrincipalKind | 'any';

interface PrincipalBase {
  readonly kind: PrincipalKind;
  readonly subject: string;
  /** The issuer that signed this token (one of the configured issuers). */
  readonly issuer: string;
  readonly clientId: string;
  /** The token's `jti`. */
  readonly tokenId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  /** From the space-separated `scope` claim (or an `scp` array). */
  readonly scopes: readonly string[];
  /** Epoch seconds. */
  readonly issuedAt: number;
  /** Epoch seconds. Streams must close by this time. */
  readonly expiresAt: number;
  /** All verified claims, for product-specific fields. */
  readonly claims: Readonly<JWTPayload>;
}

/** A person, signed in through a client, with an Oathweave session. */
export interface OathweaveUserPrincipal extends PrincipalBase {
  readonly kind: 'user';
  readonly sessionId: string;
  /** From userinfo `name` when the session was checked online, else token `name`, `username` or the subject. */
  readonly displayName: string;
  /** When the person last proved their identity (epoch seconds). Undefined means unknown, never recent. */
  readonly authTime: number | undefined;
  /** True when the session was confirmed active against userinfo for this call. */
  readonly sessionChecked: boolean;
}

/** A machine client (client_credentials): its subject is its client ID, and it has no session. */
export interface OathweaveServicePrincipal extends PrincipalBase {
  readonly kind: 'service';
}

export type OathweavePrincipal = OathweaveUserPrincipal | OathweaveServicePrincipal;

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The client claim: Oathweave's `clientId`, or RFC 9068 `client_id`. Both present must agree. */
export function clientIdOf(payload: JWTPayload): string | undefined {
  const camel = payload['clientId'];
  const snake = payload['client_id'];
  if (camel !== undefined && snake !== undefined && camel !== snake) return undefined;
  const value = camel ?? snake;
  return typeof value === 'string' ? value : undefined;
}

/** Scopes from `scope` (space-separated) or `scp` (array or string), de-duplicated. */
export function extractScopes(payload: JWTPayload): string[] {
  const raw = payload['scope'] ?? payload['scp'];
  const list = typeof raw === 'string' ? raw.split(/\s+/) : stringArray(raw) ? raw : [];
  return [...new Set(list.map(item => item.trim()).filter(Boolean))];
}

/** Roles; an absent claim is no roles. A present claim that is not a string array is invalid. */
export function extractRoles(payload: JWTPayload): string[] | undefined {
  const roles = payload['roles'];
  if (roles === undefined) return [];
  return stringArray(roles) ? [...roles] : undefined;
}

/** A service token is one whose client ID equals its subject. */
export function principalKindOf(payload: JWTPayload): PrincipalKind {
  const clientId = clientIdOf(payload);
  return clientId !== undefined && clientId === payload.sub ? 'service' : 'user';
}

function validAuthTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export interface ClaimPolicy {
  readonly accept: AcceptPrincipal;
  /** Largest allowed `exp - iat`, in seconds. */
  readonly maxLifetimeSec: number;
}

/**
 * Check the Oathweave claim rules on a payload whose signature, issuer, audience and time
 * claims jose already verified, and build the principal (without session data).
 *
 * Users: `actorType` USER, a session, a client that is not the subject.
 * Services: subject equals client ID, `actorType` SERVICE_ACCOUNT, `token_type` access, no session.
 * Both: `jti`, string-array `permissions`, `exp - iat` within the lifetime limit.
 */
export function principalFromClaims(payload: JWTPayload, policy: ClaimPolicy): OathweavePrincipal {
  const { iat, exp, sub, jti, iss } = payload;
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat || exp - iat > policy.maxLifetimeSec) {
    throw new OathweaveError('invalid_lifetime');
  }
  if (!nonEmpty(sub) || !nonEmpty(jti) || !nonEmpty(iss)) throw new OathweaveError('invalid_claims');
  const permissions = payload['permissions'];
  const roles = extractRoles(payload);
  const clientId = clientIdOf(payload);
  if (!stringArray(permissions) || roles === undefined || clientId === undefined) throw new OathweaveError('invalid_claims');

  const kind = principalKindOf(payload);
  if (policy.accept !== 'any' && policy.accept !== kind) throw new OathweaveError('wrong_principal_kind', { details: { kind } });

  const base = {
    subject: sub,
    issuer: iss,
    clientId,
    tokenId: jti,
    roles,
    permissions: [...permissions],
    scopes: extractScopes(payload),
    issuedAt: iat,
    expiresAt: exp,
    claims: payload,
  };

  if (kind === 'service') {
    if (payload['actorType'] !== 'SERVICE_ACCOUNT' || payload['token_type'] !== 'access' || payload['sessionId'] !== undefined) {
      throw new OathweaveError('invalid_claims');
    }
    return { kind, ...base };
  }

  const sessionId = payload['sessionId'];
  if (payload['actorType'] !== 'USER' || !nonEmpty(sessionId) || !nonEmpty(clientId)) throw new OathweaveError('invalid_claims');
  const name = payload['name'] ?? payload['username'];
  return {
    kind,
    ...base,
    sessionId,
    displayName: nonEmpty(name) ? name : sub,
    authTime: validAuthTime(payload['auth_time']),
    sessionChecked: false,
  };
}
