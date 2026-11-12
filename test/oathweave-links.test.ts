import { describe, expect, it, vi } from 'vitest';
import {
  effectivePermissions, endpointProblem, hasAnyRole, hasPermissions, hasScopes, IdentityLinkError, isLoopbackHost,
  isOathweaveEndpoint, OathweaveError, parseIdentityLinks, permissionMatches, principalFromClaims, principalKindOf,
  requireIdentityLink, requirePermissions, statusForReason, uniqueIdentityLink, watchStreamAuthorization, extractScopes,
  extractRoles, clientIdOf,
} from '../src/oathweave/index.js';
import { ISSUER } from './helpers.js';

const link = { issuer: ISSUER, subject: 's', localUserId: 'alice', role: 'ADMIN' };

describe('identity links', () => {
  it('parses links from JSON or a value', () => {
    expect(parseIdentityLinks(JSON.stringify([link]))).toEqual([link]);
    expect(parseIdentityLinks([{ ...link, displayName: '  Alice ', permissions: ['a'] }])).toEqual([{ ...link, displayName: 'Alice', permissions: ['a'] }]);
    expect(parseIdentityLinks([{ issuer: ISSUER, subject: 's', localUserId: 'bob' }])).toEqual([{ issuer: ISSUER, subject: 's', localUserId: 'bob' }]);
  });

  it.each<[string, unknown, RegExp]>([
    ['bad JSON', '{', /valid JSON/],
    ['a non-array', '{}', /JSON array/],
    ['a non-object entry', '[1]', /must be an object/],
    ['an unknown field', [{ ...link, extra: 1 }], /unknown field extra/],
    ['an http issuer', [{ ...link, issuer: 'http://oathweave.example.test' }], /issuer/],
    ['a non-URL issuer', [{ ...link, issuer: 'nope' }], /issuer/],
    ['an empty subject', [{ ...link, subject: '' }], /subject/],
    ['a long subject', [{ ...link, subject: 'x'.repeat(257) }], /subject/],
    ['an invalid local user', [{ ...link, localUserId: ' bad' }], /localUserId/],
    ['the system actor', [{ ...link, localUserId: 'system' }], /system or a service/],
    ['a service actor', [{ ...link, localUserId: 'service:magnus' }], /system or a service/],
    ['an empty role', [{ ...link, role: '' }], /role/],
    ['a blank display name', [{ ...link, displayName: ' ' }], /displayName/],
    ['bad permissions', [{ ...link, permissions: [1] }], /permissions/],
    ['a duplicate', [link, link], /duplicates/],
  ])('rejects %s', (_name, raw, message) => {
    expect(() => parseIdentityLinks(raw)).toThrow(IdentityLinkError);
    expect(() => parseIdentityLinks(raw)).toThrow(message);
  });

  it('accepts localId as an alias of localUserId', () => {
    const { localUserId, ...rest } = link;
    expect(parseIdentityLinks([{ ...rest, localId: localUserId }])).toEqual([link]);
    expect(parseIdentityLinks(JSON.stringify([{ ...rest, localId: localUserId }]))).toEqual([link]);
    expect(parseIdentityLinks([{ ...link, localId: localUserId }])).toEqual([link]);
    expect(parseIdentityLinks([{ ...link, localId: localUserId }])[0]).not.toHaveProperty('localId');
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['localId and localUserId that disagree', { localId: 'bob' }, /localId and localUserId disagree/],
    ['an invalid localId', { localUserId: undefined, localId: ' bad' }, /localUserId is not valid/],
    ['a non-string localId', { localUserId: undefined, localId: 5 }, /localUserId is not valid/],
    ['a localId naming the system actor', { localUserId: undefined, localId: 'system' }, /system or a service/],
    ['a localId naming a service actor', { localUserId: undefined, localId: 'service:magnus' }, /system or a service/],
  ])('rejects %s', (_name, extra, message) => {
    expect(() => parseIdentityLinks([{ ...link, ...extra }])).toThrow(IdentityLinkError);
    expect(() => parseIdentityLinks([{ ...link, ...extra }])).toThrow(message);
  });

  it('treats an alias link and a localUserId link for one identity as duplicates', () => {
    const { localUserId, ...rest } = link;
    expect(() => parseIdentityLinks([link, { ...rest, localId: localUserId }])).toThrow(/duplicates/);
  });

  it('enforces allowed roles and permissions', () => {
    expect(() => parseIdentityLinks([link], { roles: ['VIEWER'] })).toThrow(/role/);
    expect(() => parseIdentityLinks([{ ...link, role: undefined }], { roles: ['ADMIN'] })).toThrow(/role/);
    expect(parseIdentityLinks([link], { roles: ['ADMIN'] })).toHaveLength(1);
    expect(() => parseIdentityLinks([{ ...link, permissions: ['x'] }], { permissions: ['y'] })).toThrow(/permissions/);
    expect(() => parseIdentityLinks([link, link, link], { maxLinks: 2 })).toThrow(/too many/);
  });

  it('a duplicate link grants nothing when duplicates are kept', () => {
    const links = parseIdentityLinks([link, link], { duplicates: 'ignore' });
    expect(uniqueIdentityLink(links, ISSUER, 's')).toBeUndefined();
    expect(uniqueIdentityLink([link], ISSUER, 's')).toEqual(link);
    expect(uniqueIdentityLink([link], ISSUER, 'other')).toBeUndefined();
    expect(uniqueIdentityLink([link], 'https://other.example.test', 's')).toBeUndefined();
  });

  it('requires a link with a 403', () => {
    expect(requireIdentityLink([link], { issuer: ISSUER, subject: 's' })).toEqual(link);
    const error = (() => { try { requireIdentityLink([], { issuer: ISSUER, subject: 's' }); } catch (e) { return e; } return undefined; })() as OathweaveError;
    expect(error.reason).toBe('not_linked');
    expect(error.status).toBe(403);
  });
});

describe('permissions, roles and scopes', () => {
  it('matches wildcards at segment boundaries', () => {
    expect(permissionMatches('*', 'a:b')).toBe(true);
    expect(permissionMatches('a:b', 'a:b')).toBe(true);
    expect(permissionMatches('iam:*', 'iam:users:read')).toBe(true);
    expect(permissionMatches('iam:users:*', 'iam:users:read')).toBe(true);
    expect(permissionMatches('iam:users:*', 'iam:roles:read')).toBe(false);
    expect(permissionMatches('iam:*', 'iam')).toBe(false);
    expect(permissionMatches('iam', 'iam:users')).toBe(false);
    expect(permissionMatches('iam:users', 'iam')).toBe(false);
  });

  it('checks permission sets', () => {
    expect(hasPermissions(['a:*', 'b'], ['a:x', 'b'])).toBe(true);
    expect(hasPermissions(['a:*'], ['a:x'], { wildcards: false })).toBe(false);
    expect(hasPermissions(['a:x'], ['a:x'], { wildcards: false })).toBe(true);
    expect(hasPermissions([], [])).toBe(true);
    expect(() => requirePermissions({ permissions: ['a'] }, ['a'])).not.toThrow();
    expect(() => requirePermissions({ permissions: ['a'] }, ['b'])).toThrow(OathweaveError);
  });

  it('checks roles and scopes', () => {
    expect(hasAnyRole({ roles: ['A', 'B'] }, ['C', 'B'])).toBe(true);
    expect(hasAnyRole({ roles: ['A'] }, ['C'])).toBe(false);
    expect(hasScopes({ scopes: ['x', 'y'] }, ['x'])).toBe(true);
    expect(hasScopes({ scopes: ['x'] }, ['x', 'y'])).toBe(false);
  });

  it('narrows token permissions by a link ceiling', () => {
    expect(effectivePermissions({}, ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(effectivePermissions({ permissions: ['a'] }, ['a', 'b'])).toEqual(['a']);
    expect(effectivePermissions({}, ['a', 'z'], ['a', 'b'])).toEqual(['a']);
  });
});

describe('claims helpers', () => {
  it('extracts scopes, roles and clients', () => {
    expect(extractScopes({ scope: ' a  b a ' })).toEqual(['a', 'b']);
    expect(extractScopes({ scp: 'a b' })).toEqual(['a', 'b']);
    expect(extractScopes({ scope: 5 })).toEqual([]);
    expect(extractRoles({})).toEqual([]);
    expect(extractRoles({ roles: [1] })).toBeUndefined();
    expect(clientIdOf({ client_id: 'x' })).toBe('x');
    expect(clientIdOf({ clientId: 'x', client_id: 'y' })).toBeUndefined();
    expect(clientIdOf({ clientId: 5 })).toBeUndefined();
    expect(principalKindOf({ sub: 'x', clientId: 'x' })).toBe('service');
    expect(principalKindOf({ sub: 'x', clientId: 'y' })).toBe('user');
    expect(principalKindOf({ sub: 'x' })).toBe('user');
  });

  it('applies the strict legacy claim options', () => {
    expect(extractRoles({}, true)).toBeUndefined();
    expect(extractRoles({ roles: ['A'] }, true)).toEqual(['A']);
    expect(clientIdOf({ client_id: 'x' }, 'clientId')).toBeUndefined();
    expect(clientIdOf({ clientId: 'x' }, 'client_id')).toBeUndefined();
    expect(clientIdOf({ clientId: 'x', client_id: 'x' }, 'clientId')).toBe('x');
    expect(clientIdOf({ clientId: 'x', client_id: 'y' }, 'client_id')).toBeUndefined();
    expect(principalKindOf({ sub: 'x', client_id: 'x' }, 'clientId')).toBe('user');
    expect(principalKindOf({ sub: 'x', client_id: 'x' }, 'client_id')).toBe('service');
  });

  it('applies claim rules directly', () => {
    const base = { iss: ISSUER, sub: 'u', jti: 'j', iat: 100, exp: 200, actorType: 'USER', sessionId: 's', clientId: 'c', permissions: [] };
    expect(principalFromClaims(base, { accept: 'any', maxLifetimeSec: 900 }).kind).toBe('user');
    expect(() => principalFromClaims({ ...base, iss: '' }, { accept: 'any', maxLifetimeSec: 900 })).toThrow(OathweaveError);
    expect(() => principalFromClaims({ ...base, exp: 100 }, { accept: 'any', maxLifetimeSec: 900 })).toThrow(/lifetime/);
    expect(principalFromClaims(base, { accept: 'any', maxLifetimeSec: {} }).kind).toBe('user');
    expect(() => principalFromClaims(base, { accept: 'any', maxLifetimeSec: { user: 1 } })).toThrow(/lifetime/);
  });
});

describe('endpoints', () => {
  it('recognises loopback hosts', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.255.0.9', '[::1]', '::1']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['example.com', '128.0.0.1', '127.0.0.256', 'localhost.example.com']) expect(isLoopbackHost(host)).toBe(false);
  });

  it('validates endpoint URLs', () => {
    expect(isOathweaveEndpoint('https://oathweave.example.test/jwks?x=1')).toBe(true);
    expect(endpointProblem('ws://oathweave.example.test')).toMatch(/https/);
    expect(endpointProblem('http://localhost')).toMatch(/loopback/);
  });

  it('maps reasons to statuses', () => {
    expect(statusForReason('expired')).toBe(401);
    expect(statusForReason('not_linked')).toBe(403);
    expect(statusForReason('jwks_unavailable')).toBe(503);
  });
});

describe('stream recheck', () => {
  it('rechecks on an interval and ends when a recheck fails', async () => {
    vi.useFakeTimers();
    try {
      let ok = true;
      const recheck = vi.fn(async () => {
        if (!ok) throw new OathweaveError('session_inactive');
        return { expiresAt: 0 };
      });
      const onEnd = vi.fn();
      const watch = watchStreamAuthorization({ recheck, expiresAt: Date.now() / 1000 + 600, onEnd });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(onEnd).not.toHaveBeenCalled();
      ok = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect((onEnd.mock.calls[0]?.[0] as OathweaveError).reason).toBe('session_inactive');
      expect(watch.stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(recheck).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps foreign recheck errors and ends at token expiry', async () => {
    vi.useFakeTimers();
    try {
      const onEnd = vi.fn();
      watchStreamAuthorization({ recheck: async () => { throw new Error('boom'); }, expiresAt: Date.now() / 1000 + 600, onEnd, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect((onEnd.mock.calls[0]?.[0] as OathweaveError).reason).toBe('session_inactive');

      const onExpiry = vi.fn();
      watchStreamAuthorization({ recheck: () => new Promise(() => undefined), expiresAt: Date.now() / 1000 + 3, onEnd: onExpiry, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(3_000);
      expect((onExpiry.mock.calls[0]?.[0] as OathweaveError).reason).toBe('expired');
      expect(onExpiry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const onEnd = vi.fn();
      const recheck = vi.fn(async () => ({ expiresAt: 0 }));
      const watch = watchStreamAuthorization({ recheck, expiresAt: Date.now() / 1000 + 1, onEnd });
      watch.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onEnd).not.toHaveBeenCalled();
      expect(recheck).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
