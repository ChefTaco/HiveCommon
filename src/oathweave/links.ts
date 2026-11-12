/**
 * Identity links and authorization helpers.
 *
 * A link maps one verified Oathweave identity (issuer + subject) to a local account. Products
 * refuse identities without exactly one link, so a valid token alone never grants access.
 */
import type { OathweavePrincipal } from './claims.js';
import { OathweaveError } from './errors.js';

export interface OathweaveIdentityLink {
  readonly issuer: string;
  readonly subject: string;
  /** The local account this identity acts as. Never `system` or a `service:` actor. */
  readonly localUserId: string;
  /** A role ceiling, when the product uses roles. */
  readonly role?: string;
  readonly displayName?: string;
  /** A permission ceiling: the token's permissions grant only within it. Absent means no ceiling. */
  readonly permissions?: readonly string[];
}

export class IdentityLinkError extends Error {
  override readonly name = 'IdentityLinkError';
}

export interface ParseIdentityLinksOptions {
  /** Allowed `role` values. When set, every link must carry one of them. */
  readonly roles?: readonly string[];
  /** Allowed `permissions` entries. When set, every listed permission must be one of them. */
  readonly permissions?: readonly string[];
  /**
   * `reject` (default) fails on two links for the same identity. `ignore` keeps them, and
   * `uniqueIdentityLink()` then grants nothing for that identity.
   */
  readonly duplicates?: 'reject' | 'ignore';
  readonly maxLinks?: number;
}

/** `localId` is accepted as an alias of `localUserId`, the name older deployment configs use. */
const LINK_FIELDS = new Set(['issuer', 'subject', 'localUserId', 'localId', 'role', 'displayName', 'permissions']);

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse a JSON array of links, for example from `<PRODUCT>_OATHWEAVE_IDENTITIES_JSON`.
 * An entry may name its local account `localUserId` or, as older configs do, `localId`; an
 * entry that sets both to different values is refused. Parsed links always use `localUserId`.
 * Throws an `IdentityLinkError` naming the first problem; the raw value is never echoed.
 */
export function parseIdentityLinks(raw: string | unknown, options: ParseIdentityLinksOptions = {}): OathweaveIdentityLink[] {
  let json: unknown = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new IdentityLinkError('identity links must be valid JSON');
    }
  }
  if (!Array.isArray(json)) throw new IdentityLinkError('identity links must be a JSON array');
  if (json.length > (options.maxLinks ?? 10_000)) throw new IdentityLinkError('too many identity links');
  const seen = new Set<string>();
  return json.map((item: unknown, index): OathweaveIdentityLink => {
    const where = `identity link ${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new IdentityLinkError(`${where} must be an object`);
    const link = item as Record<string, unknown>;
    for (const key of Object.keys(link)) if (!LINK_FIELDS.has(key)) throw new IdentityLinkError(`${where} has unknown field ${key.slice(0, 40)}`);
    const { issuer, subject, localId, role, displayName, permissions } = link;
    if (link['localUserId'] !== undefined && localId !== undefined && link['localUserId'] !== localId) {
      throw new IdentityLinkError(`${where}: localId and localUserId disagree`);
    }
    const localUserId = link['localUserId'] ?? localId;
    if (!isHttpsUrl(issuer)) throw new IdentityLinkError(`${where}: issuer must be an https URL`);
    if (typeof subject !== 'string' || !subject || subject.length > 256) throw new IdentityLinkError(`${where}: subject must be 1-256 characters`);
    if (typeof localUserId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/.test(localUserId)) {
      throw new IdentityLinkError(`${where}: localUserId is not valid`);
    }
    // These identifiers name server-owned actors; a link must never impersonate one.
    if (localUserId === 'system' || localUserId.startsWith('service:')) {
      throw new IdentityLinkError(`${where}: localUserId must not name the system or a service actor`);
    }
    if (options.roles ? typeof role !== 'string' || !options.roles.includes(role) : role !== undefined && (typeof role !== 'string' || !role)) {
      throw new IdentityLinkError(`${where}: role is not allowed`);
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 120)) {
      throw new IdentityLinkError(`${where}: displayName must be 1-120 characters`);
    }
    if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every(value => typeof value === 'string'
      && (!options.permissions || options.permissions.includes(value))))) {
      throw new IdentityLinkError(`${where}: permissions are not valid`);
    }
    const key = JSON.stringify([issuer, subject]);
    if (seen.has(key) && (options.duplicates ?? 'reject') === 'reject') throw new IdentityLinkError(`${where} duplicates an earlier link`);
    seen.add(key);
    return {
      issuer,
      subject,
      localUserId,
      ...(typeof role === 'string' ? { role } : {}),
      ...(typeof displayName === 'string' ? { displayName: displayName.trim() } : {}),
      ...(Array.isArray(permissions) ? { permissions: [...permissions as string[]] } : {}),
    };
  });
}

/** The one link for a verified identity. A missing or duplicated link yields nothing. */
export function uniqueIdentityLink<L extends OathweaveIdentityLink>(links: readonly L[], issuer: string, subject: string): L | undefined {
  const matches = links.filter(link => link.issuer === issuer && link.subject === subject);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The link for a principal, or a 403 `not_linked` OathweaveError. */
export function requireIdentityLink<L extends OathweaveIdentityLink>(links: readonly L[], principal: Pick<OathweavePrincipal, 'issuer' | 'subject'>): L {
  const link = uniqueIdentityLink(links, principal.issuer, principal.subject);
  if (!link) throw new OathweaveError('not_linked');
  return link;
}

/**
 * Does one granted permission cover a required one? Exact match, `*`, or a `*` segment
 * (split on `:`) covering the rest: `iam:*` covers `iam:users:read`.
 */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  const grantedParts = granted.split(':');
  const requiredParts = required.split(':');
  for (let index = 0; index < grantedParts.length; index++) {
    if (grantedParts[index] === '*') return index < requiredParts.length;
    if (grantedParts[index] !== requiredParts[index]) return false;
  }
  return grantedParts.length === requiredParts.length;
}

export interface PermissionOptions {
  /** Honour `*` wildcards in granted permissions. Defaults to true, as the Oathweave SDK does. */
  readonly wildcards?: boolean;
}

/** True when `granted` covers every one of `required`. */
export function hasPermissions(granted: readonly string[], required: readonly string[], options: PermissionOptions = {}): boolean {
  const wildcards = options.wildcards ?? true;
  return required.every(need => granted.some(have => (wildcards ? permissionMatches(have, need) : have === need)));
}

/** Throw a 403 `insufficient_permission` OathweaveError unless the principal has every permission. */
export function requirePermissions(principal: Pick<OathweavePrincipal, 'permissions'>, required: readonly string[], options: PermissionOptions = {}): void {
  if (!hasPermissions(principal.permissions, required, options)) {
    throw new OathweaveError('insufficient_permission', { details: { required: [...required] } });
  }
}

/** True when the principal has at least one of `roles`. */
export function hasAnyRole(principal: Pick<OathweavePrincipal, 'roles'>, roles: readonly string[]): boolean {
  return roles.some(role => principal.roles.includes(role));
}

/** True when the principal has every one of `scopes`. */
export function hasScopes(principal: Pick<OathweavePrincipal, 'scopes'>, scopes: readonly string[]): boolean {
  return scopes.every(scope => principal.scopes.includes(scope));
}

/** Token permissions narrowed by a link's ceiling (and optionally a product's known set). */
export function effectivePermissions(
  link: Pick<OathweaveIdentityLink, 'permissions'>,
  tokenPermissions: readonly string[],
  known?: readonly string[],
): string[] {
  const ceiling = link.permissions ? new Set(link.permissions) : undefined;
  return [...new Set(tokenPermissions)].filter(permission => (!ceiling || ceiling.has(permission)) && (!known || known.includes(permission)));
}
