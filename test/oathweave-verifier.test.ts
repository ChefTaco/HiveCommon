import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createOathweaveVerifier,
  isOathweaveError,
  OathweaveError,
  parseBearerToken,
  type OathweaveFailureReason,
  type OathweaveVerifierOptions,
} from '../src/oathweave/index.js';
import { toErrorResponse } from '../src/errors/index.js';
import {
  AUDIENCE, b64, ISSUER, JWKS_URL, mint, NOW_MS, NOW_SEC, serviceClaims, stubFetch, testKeys, userClaims, USERINFO_URL,
} from './helpers.js';

const keys = await testKeys();

function verifier(options: Partial<OathweaveVerifierOptions> = {}) {
  return createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: keys.jwks, now: () => NOW_MS, ...options });
}

function remoteVerifier(options: Partial<OathweaveVerifierOptions> = {}) {
  return createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl: JWKS_URL, now: () => NOW_MS, ...options });
}

async function reason(promise: Promise<unknown>): Promise<OathweaveFailureReason> {
  try {
    await promise;
  } catch (error) {
    expect(isOathweaveError(error)).toBe(true);
    return (error as OathweaveError).reason;
  }
  throw new Error('expected a rejection');
}

describe('configuration', () => {
  it('requires https issuer and endpoints', () => {
    expect(() => verifier({ issuer: 'http://oathweave.example.test' })).toThrow(/issuer must use https/);
    expect(() => verifier({ jwksUrl: 'http://oathweave.example.test/jwks' })).toThrow(/jwksUrl must use https/);
    expect(() => verifier({ userinfoUrl: 'ftp://oathweave.example.test/u' })).toThrow(/userinfoUrl must use https/);
    expect(() => verifier({ issuer: 'https://user:pass@oathweave.example.test' })).toThrow(/credentials/);
    expect(() => verifier({ issuer: 'https://oathweave.example.test/#x' })).toThrow(/fragment/);
    expect(() => verifier({ issuer: 'not a url' })).toThrow(/not a valid URL/);
    expect(() => verifier({ issuer: [] })).toThrow(/At least one/);
    expect(() => verifier({ audience: '' })).toThrow(/audience/);
    expect(() => verifier({ clockToleranceSec: -1 })).toThrow(/clockTolerance/);
    expect(() => verifier({ maxLifetimeSec: 0 })).toThrow(/maxLifetime/);
    expect(() => verifier({ requireRoles: 'yes' as never })).toThrow(/requireRoles/);
    expect(() => verifier({ clientIdClaim: 'client' as never })).toThrow(/clientIdClaim/);
  });

  it('allows loopback http only when explicitly enabled', () => {
    expect(() => verifier({ issuer: 'http://127.0.0.1:9000' })).toThrow();
    expect(() => verifier({ issuer: 'http://127.0.0.1:9000', allowInsecureLoopback: true })).not.toThrow();
    expect(() => verifier({ issuer: 'http://localhost:9000', allowInsecureLoopback: true })).not.toThrow();
    expect(() => verifier({ issuer: 'http://[::1]:9000', allowInsecureLoopback: true })).not.toThrow();
    expect(() => verifier({ issuer: 'http://oathweave.example.test', allowInsecureLoopback: true })).toThrow();
  });

  it('needs keys or a JWKS URL', () => {
    expect(() => createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE })).toThrow(/jwksUrl is required/);
  });

  it('exposes issuers and audience', () => {
    const v = verifier({ issuer: [ISSUER, 'https://other.example.test'] });
    expect(v.issuers).toEqual([ISSUER, 'https://other.example.test']);
    expect(v.audience).toBe(AUDIENCE);
  });
});

describe('user tokens', () => {
  it('accepts a valid user token and extracts roles, permissions and scopes', async () => {
    const principal = await verifier().verify(await mint(keys, userClaims({ auth_time: NOW_SEC - 30, username: 'alice' })));
    expect(principal).toMatchObject({
      kind: 'user', subject: 'user-subject', issuer: ISSUER, clientId: 'hivexui', tokenId: 'jti-1', sessionId: 'session-1',
      roles: ['VIEWER'], permissions: ['hivemem:read'], scopes: ['openid', 'hivemem:read'], displayName: 'alice',
      authTime: NOW_SEC - 30, issuedAt: NOW_SEC - 10, expiresAt: NOW_SEC + 590, sessionChecked: false,
    });
  });

  it.each(['1700000000', 0, -1, 1.5, null, true])('treats auth_time %j as unknown', async value => {
    const principal = await verifier().verifyUser(await mint(keys, userClaims({ auth_time: value as never })));
    expect(principal.authTime).toBeUndefined();
  });

  it('uses the subject as display name without a name claim', async () => {
    expect((await verifier().verifyUser(await mint(keys, userClaims()))).displayName).toBe('user-subject');
  });

  it('accepts a missing roles claim as no roles, and scp arrays as scopes', async () => {
    const principal = await verifier().verify(await mint(keys, userClaims({ roles: undefined, scope: undefined, scp: ['a', 'b', 'a'] })));
    expect(principal.roles).toEqual([]);
    expect(principal.scopes).toEqual(['a', 'b']);
  });

  it('accepts client_id as an alias of clientId', async () => {
    const principal = await verifier().verify(await mint(keys, userClaims({ clientId: undefined, client_id: 'hivexui' })));
    expect(principal.clientId).toBe('hivexui');
  });

  it.each<[string, Record<string, unknown>]>([
    ['no session', { sessionId: undefined }],
    ['an empty session', { sessionId: '' }],
    ['a non-USER actor', { actorType: 'AGENT' }],
    ['no client', { clientId: undefined }],
    ['an empty client', { clientId: '' }],
    ['disagreeing client claims', { client_id: 'other' }],
    ['non-array permissions', { permissions: 'hivemem:read' }],
    ['non-string permissions', { permissions: [1] }],
    ['non-array roles', { roles: 'ADMIN' }],
  ])('refuses a user token with %s', async (_name, claims) => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(claims as never))))).toBe('invalid_claims');
  });

  it('refuses a missing jti', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { jti: null })))).toBe('invalid_claims');
  });

  it('refuses an empty jti', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { jti: '' })))).toBe('invalid_claims');
  });

  it('refuses an empty subject', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { sub: '' })))).toBe('invalid_claims');
  });

  it('refuses a missing subject', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { omit: ['sub'] })))).toBe('invalid_claims');
  });

  it('refuses a service token by default', async () => {
    expect(await reason(verifier().verify(await mint(keys, serviceClaims())))).toBe('wrong_principal_kind');
  });
});

describe('strict legacy claim options', () => {
  it('requireRoles refuses a token without a roles claim', async () => {
    const strict = verifier({ requireRoles: true });
    expect(await reason(strict.verify(await mint(keys, userClaims({ roles: undefined }))))).toBe('invalid_claims');
    expect(await reason(strict.verify(await mint(keys, userClaims({ roles: 'ADMIN' }))))).toBe('invalid_claims');
    expect((await strict.verify(await mint(keys, userClaims({ roles: [] })))).roles).toEqual([]);
    expect((await strict.verify(await mint(keys, userClaims()))).roles).toEqual(['VIEWER']);
    expect(await reason(verifier({ requireRoles: true, accept: 'service' }).verify(await mint(keys, serviceClaims('ardent-studio', { roles: undefined }))))).toBe('invalid_claims');
  });

  it('requireRoles false keeps the default: an absent roles claim is no roles', async () => {
    expect((await verifier({ requireRoles: false }).verify(await mint(keys, userClaims({ roles: undefined })))).roles).toEqual([]);
  });

  it('clientIdClaim clientId accepts only the camel-case claim', async () => {
    const strict = verifier({ clientIdClaim: 'clientId' });
    expect((await strict.verify(await mint(keys, userClaims()))).clientId).toBe('hivexui');
    expect((await strict.verify(await mint(keys, userClaims({ client_id: 'hivexui' })))).clientId).toBe('hivexui');
    expect(await reason(strict.verify(await mint(keys, userClaims({ clientId: undefined, client_id: 'hivexui' }))))).toBe('invalid_claims');
    expect(await reason(strict.verify(await mint(keys, userClaims({ client_id: 'other' }))))).toBe('invalid_claims');
  });

  it('clientIdClaim client_id accepts only the RFC 9068 claim', async () => {
    const strict = verifier({ clientIdClaim: 'client_id' });
    expect((await strict.verify(await mint(keys, userClaims({ clientId: undefined, client_id: 'hivexui' })))).clientId).toBe('hivexui');
    expect(await reason(strict.verify(await mint(keys, userClaims())))).toBe('invalid_claims');
    expect(await reason(strict.verify(await mint(keys, userClaims({ client_id: 'other' }))))).toBe('invalid_claims');
  });

  it('clientIdClaim either is the default', async () => {
    const either = verifier({ clientIdClaim: 'either' });
    expect((await either.verify(await mint(keys, userClaims({ clientId: undefined, client_id: 'hivexui' })))).clientId).toBe('hivexui');
    expect((await either.verify(await mint(keys, userClaims()))).clientId).toBe('hivexui');
  });

  it('classifies service tokens by the accepted client claim only', async () => {
    const snakeService = await mint(keys, serviceClaims('ardent-studio', { clientId: undefined, client_id: 'ardent-studio' }), { sub: 'ardent-studio' });
    expect((await verifier({ accept: 'service' }).verify(snakeService)).kind).toBe('service');
    expect((await verifier({ accept: 'service', clientIdClaim: 'client_id' }).verify(snakeService)).kind).toBe('service');
    expect(await reason(verifier({ accept: 'any', clientIdClaim: 'clientId' }).verify(snakeService))).toBe('invalid_claims');
  });

  it('combines with clockToleranceSec 0 and sessionCacheTtlMs 0 for products that kept them', async () => {
    const stub = stubFetch({ [USERINFO_URL]: () => Response.json({ sub: 'user-subject' }) });
    const v = verifier({
      clockToleranceSec: 0, sessionCacheTtlMs: 0, requireRoles: true, clientIdClaim: 'clientId', userinfoUrl: USERINFO_URL, fetch: stub.fetch,
    });
    const token = await mint(keys, userClaims());
    await v.verify(token);
    await v.verify(token);
    expect(stub.calls).toHaveLength(2);
    expect(await reason(v.verify(await mint(keys, userClaims(), { iat: NOW_SEC - 600, exp: NOW_SEC - 1 })))).toBe('expired');
  });
});

describe('service tokens', () => {
  it('accepts a client-credentials token whose client equals its subject', async () => {
    const principal = await verifier().verifyService(await mint(keys, serviceClaims()));
    expect(principal).toMatchObject({ kind: 'service', subject: 'ardent-studio', clientId: 'ardent-studio', permissions: ['hivemem:write'], scopes: ['hivemem:write'] });
  });

  it('accepts either kind with accept any', async () => {
    const v = verifier({ accept: 'any' });
    expect((await v.verify(await mint(keys, serviceClaims()))).kind).toBe('service');
    expect((await v.verify(await mint(keys, userClaims()))).kind).toBe('user');
  });

  it('refuses a user token where a service is required', async () => {
    expect(await reason(verifier().verifyService(await mint(keys, userClaims())))).toBe('wrong_principal_kind');
  });

  it.each<[string, Record<string, unknown>]>([
    ['a USER actor', { actorType: 'USER' }],
    ['a session', { sessionId: 'session' }],
    ['a refresh token type', { token_type: 'refresh' }],
    ['no token type', { token_type: undefined }],
    ['string permissions', { permissions: 'hivemem:write' }],
  ])('refuses a service token with %s', async (_name, claims) => {
    expect(await reason(verifier().verifyService(await mint(keys, serviceClaims('ardent-studio', claims as never), { sub: 'ardent-studio' })))).toBe('invalid_claims');
  });

  it('treats a token for another client as a user token', async () => {
    const token = await mint(keys, serviceClaims('ardent-studio', { clientId: 'other-client' }), { sub: 'ardent-studio' });
    expect(await reason(verifier().verifyService(token))).toBe('wrong_principal_kind');
  });

  it('accepts several issuers', async () => {
    const v = verifier({ issuer: ['https://browser.example.test', ISSUER] });
    expect((await v.verifyService(await mint(keys, serviceClaims()))).issuer).toBe(ISSUER);
  });
});

describe('signature, algorithm and keys', () => {
  it('refuses a token signed by another key', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { key: keys.otherPrivateKey })))).toBe('invalid_signature');
  });

  it('refuses an unknown key ID', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { kid: 'missing' })))).toBe('unknown_key');
  });

  it('refuses alg none', async () => {
    const token = `${b64({ alg: 'none' })}.${b64({ ...userClaims(), iss: ISSUER, aud: AUDIENCE, sub: 's', jti: 'j', iat: NOW_SEC, exp: NOW_SEC + 60 })}.`;
    expect(await reason(verifier().verify(token))).toBe('algorithm_not_allowed');
  });

  it('refuses HS256 keyed with the public key', async () => {
    const input = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64({ ...userClaims(), iss: ISSUER, aud: AUDIENCE, sub: 's', jti: 'j', iat: NOW_SEC, exp: NOW_SEC + 60 })}`;
    const token = `${input}.${createHmac('sha256', JSON.stringify(keys.jwks.keys[0])).update(input).digest('base64url')}`;
    expect(await reason(verifier().verify(token))).toBe('algorithm_not_allowed');
  });

  it.each(['PS256', 'ES256', 'RS512'])('refuses %s', async alg => {
    const token = `${b64({ alg, kid: 'k1' })}.${b64({ sub: 's' })}.c2ln`;
    expect(await reason(verifier().verify(token))).toBe('algorithm_not_allowed');
  });

  it.each([
    ['empty', '', 'missing_token'],
    ['two segments', 'a.b', 'malformed_token'],
    ['four segments', 'a.b.c.d', 'malformed_token'],
    ['garbage header', 'not-base64!.e30.sig', 'malformed_token'],
    ['oversized', `${'a'.repeat(20_000)}.b.c`, 'malformed_token'],
  ] as const)('refuses a %s token', async (_name, token, expected) => {
    expect(await reason(verifier().verify(token))).toBe(expected);
  });

  it('refuses a non-JSON payload', async () => {
    expect(await reason(verifier().verify(`${b64({ alg: 'RS256', kid: 'k1' })}.bm90IGpzb24.c2ln`))).toBe('invalid_signature');
  });

  it('refuses a correctly signed token whose payload is not JSON', async () => {
    const { CompactSign } = await import('jose');
    const token = await new CompactSign(new TextEncoder().encode('not json')).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(keys.privateKey);
    expect(await reason(verifier().verify(token))).toBe('malformed_token');
  });

  it('refuses when the JWKS holds two keys with the token kid', async () => {
    const other = await testKeys('k1');
    const v = verifier({ keys: { keys: [...other.jwks.keys, ...keys.jwks.keys] } });
    expect(['invalid_signature', 'unknown_key']).toContain(await reason(v.verify(await mint(keys, userClaims()))));
  });

  it('uses a custom key resolver', async () => {
    const { createLocalJWKSet } = await import('jose');
    const v = verifier({ keys: createLocalJWKSet(keys.jwks) });
    expect((await v.verify(await mint(keys, userClaims()))).kind).toBe('user');
  });
});

describe('time and audience', () => {
  it('refuses an expired token', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { iat: NOW_SEC - 1000, exp: NOW_SEC - 400 })))).toBe('expired');
  });

  it('tolerates clock skew within the tolerance', async () => {
    const token = await mint(keys, userClaims(), { iat: NOW_SEC - 620, exp: NOW_SEC - 20 });
    await expect(verifier().verify(token)).resolves.toBeDefined();
    expect(await reason(verifier({ clockToleranceSec: 0 }).verify(token))).toBe('expired');
  });

  it('refuses a token that is not valid yet', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { nbf: NOW_SEC + 300 })))).toBe('not_yet_valid');
  });

  it('refuses a token issued in the future', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { iat: NOW_SEC + 300, exp: NOW_SEC + 800 })))).toBe('not_yet_valid');
  });

  it('refuses a lifetime over fifteen minutes', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { iat: NOW_SEC - 10, exp: NOW_SEC + 1000 })))).toBe('invalid_lifetime');
  });

  it('refuses exp before iat', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { iat: NOW_SEC - 10, exp: NOW_SEC - 10 })))).toBe('invalid_lifetime');
    expect(await reason(verifier({ clockToleranceSec: 60 }).verify(await mint(keys, userClaims(), { iat: NOW_SEC, exp: NOW_SEC - 10 })))).toBe('invalid_lifetime');
  });

  it('refuses a missing exp or iat', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { omit: ['exp'] })))).toBe('invalid_claims');
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { omit: ['iat'] })))).toBe('invalid_claims');
  });

  it('refuses another audience, and an audience array even when it contains ours', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { aud: 'emberpath' })))).toBe('invalid_audience');
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { aud: [AUDIENCE, 'emberpath'] })))).toBe('invalid_audience');
  });

  it('refuses another issuer', async () => {
    expect(await reason(verifier().verify(await mint(keys, userClaims(), { iss: 'https://impostor.example.test' })))).toBe('invalid_issuer');
  });

  it('honours a custom lifetime limit', async () => {
    const token = await mint(keys, userClaims(), { iat: NOW_SEC - 10, exp: NOW_SEC + 3000 });
    await expect(verifier({ maxLifetimeSec: 3600 }).verify(token)).resolves.toBeDefined();
  });
});

describe('remote JWKS', () => {
  it('fetches keys without following redirects and caches them', async () => {
    const stub = stubFetch({ [JWKS_URL]: () => Response.json(keys.jwks) });
    const v = remoteVerifier({ fetch: stub.fetch });
    const token = await mint(keys, userClaims());
    await v.verify(token);
    await v.verify(token);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.init?.redirect).toBe('error');
  });

  it('uses the global fetch by default', async () => {
    const { vi } = await import('vitest');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(keys.jwks));
    try {
      expect((await remoteVerifier().verify(await mint(keys, userClaims()))).kind).toBe('user');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('refetches once for an unknown key ID (rotation)', async () => {
    const rotated = await testKeys('k2');
    let served = keys.jwks;
    const stub = stubFetch({ [JWKS_URL]: () => Response.json(served) });
    const v = remoteVerifier({ fetch: stub.fetch, jwksCooldownMs: 0 });
    await v.verify(await mint(keys, userClaims()));
    served = { keys: [...keys.jwks.keys, ...rotated.jwks.keys] };
    const principal = await v.verify(await mint(rotated, userClaims(), { kid: 'k2' }));
    expect(principal.kind).toBe('user');
    expect(stub.calls).toHaveLength(2);
  });

  it('reports unavailable keys as 503, not as a bad token', async () => {
    for (const route of [
      () => new Response('', { status: 500 }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ nope: true }),
      () => { throw new TypeError('connection refused'); },
    ]) {
      const v = remoteVerifier({ fetch: stubFetch({ [JWKS_URL]: route }).fetch });
      const error = await v.verify(await mint(keys, userClaims())).catch((e: unknown) => e) as OathweaveError;
      expect(error.reason).toBe('jwks_unavailable');
      expect(error.status).toBe(503);
    }
  });
});

describe('online session check', () => {
  const userinfo = (body: unknown = { sub: 'user-subject', name: 'Alice' }, status = 200) =>
    stubFetch({ [USERINFO_URL]: () => (status === 200 ? Response.json(body) : new Response('', { status })) });

  it('confirms the session and uses the userinfo name', async () => {
    const stub = userinfo();
    const principal = await verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch }).verifyUser(await mint(keys, userClaims()));
    expect(principal).toMatchObject({ displayName: 'Alice', sessionChecked: true });
    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(/^Bearer /);
    expect(stub.calls[0]?.init?.redirect).toBe('error');
  });

  it('falls back to the subject when userinfo has no name', async () => {
    const principal = await verifier({ userinfoUrl: USERINFO_URL, fetch: userinfo({ sub: 'user-subject' }).fetch }).verifyUser(await mint(keys, userClaims()));
    expect(principal.displayName).toBe('user-subject');
  });

  it('refuses a revoked session with 401', async () => {
    for (const status of [401, 403]) {
      expect(await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: userinfo(undefined, status).fetch }).verify(await mint(keys, userClaims())))).toBe('session_inactive');
    }
  });

  it('reports an unavailable identity service as 503', async () => {
    expect(await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: userinfo(undefined, 502).fetch }).verify(await mint(keys, userClaims())))).toBe('identity_unavailable');
    const throwing = stubFetch({ [USERINFO_URL]: () => { throw new TypeError('down'); } });
    expect(await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: throwing.fetch }).verify(await mint(keys, userClaims())))).toBe('identity_unavailable');
    const notJson = stubFetch({ [USERINFO_URL]: () => new Response('<html>', { status: 200 }) });
    expect(await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: notJson.fetch }).verify(await mint(keys, userClaims())))).toBe('identity_unavailable');
  });

  it('refuses a userinfo subject mismatch', async () => {
    expect(await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: userinfo({ sub: 'someone-else' }).fetch }).verify(await mint(keys, userClaims())))).toBe('subject_mismatch');
    expect(await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: userinfo(['x']).fetch }).verify(await mint(keys, userClaims())))).toBe('subject_mismatch');
  });

  it('never calls userinfo for a token that fails verification', async () => {
    const stub = userinfo();
    await reason(verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch }).verify(await mint(keys, userClaims(), { key: keys.otherPrivateKey })));
    expect(stub.calls).toHaveLength(0);
  });

  it('does not check sessions for service tokens', async () => {
    const stub = userinfo();
    await verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch }).verifyService(await mint(keys, serviceClaims()));
    expect(stub.calls).toHaveLength(0);
  });

  it('caches answers for the TTL from when the request started, and shares in-flight checks', async () => {
    let now = NOW_MS;
    const stub = userinfo();
    const v = verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch, now: () => now });
    const token = await mint(keys, userClaims());
    await Promise.all([v.verify(token), v.verify(token), v.verify(token)]);
    expect(stub.calls).toHaveLength(1);
    now += 9_999;
    await v.verify(token);
    expect(stub.calls).toHaveLength(1);
    now += 1;
    await v.verify(token);
    expect(stub.calls).toHaveLength(2);
    v.clearSessionCache();
    await v.verify(token);
    expect(stub.calls).toHaveLength(3);
  });

  it('remembers a failed check only briefly', async () => {
    let now = NOW_MS;
    let status = 401;
    const stub = stubFetch({ [USERINFO_URL]: () => (status === 200 ? Response.json({ sub: 'user-subject' }) : new Response('', { status })) });
    const v = verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch, now: () => now });
    const token = await mint(keys, userClaims());
    await reason(v.verify(token));
    await reason(v.verify(token));
    expect(stub.calls).toHaveLength(1);
    status = 200;
    now += 2_000;
    await expect(v.verify(token)).resolves.toBeDefined();
    expect(stub.calls).toHaveLength(2);
  });

  it('bounds the session cache', async () => {
    const stub = userinfo();
    const v = verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch, sessionCacheMax: 2 });
    const tokens = await Promise.all(['a', 'b', 'c'].map(jti => mint(keys, userClaims(), { jti })));
    for (const token of tokens) await v.verify(token);
    await v.verify(tokens[0] as string);
    expect(stub.calls).toHaveLength(4);
  });

  it('evicts expired cache entries before the oldest live one', async () => {
    let now = NOW_MS;
    const stub = userinfo();
    const v = verifier({ userinfoUrl: USERINFO_URL, fetch: stub.fetch, sessionCacheMax: 2, now: () => now });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(jti => mint(keys, userClaims(), { jti }))) as [string, string, string];
    await v.verify(a);
    now += 11_000;
    await v.verify(b);
    await v.verify(c); // evicts expired a, keeps b
    await v.verify(b);
    expect(stub.calls).toHaveLength(3);
  });
});

describe('authorization header and error mapping', () => {
  it('parses bearer headers', () => {
    expect(parseBearerToken(undefined)).toBeUndefined();
    expect(parseBearerToken(null)).toBeUndefined();
    expect(parseBearerToken('')).toBeUndefined();
    expect(parseBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearerToken('bearer abc')).toBe('abc');
    for (const bad of ['Basic abc', 'Bearer', 'Bearer a b', 'Bearer a,b', 'Bearerabc']) {
      expect(() => parseBearerToken(bad)).toThrow(OathweaveError);
    }
  });

  it('verifies an Authorization header', async () => {
    const v = verifier();
    expect((await v.verifyAuthorization(`Bearer ${await mint(keys, userClaims())}`)).kind).toBe('user');
    expect(await reason(v.verifyAuthorization(undefined))).toBe('missing_token');
    expect(await reason(v.verifyAuthorization('Basic eA=='))).toBe('malformed_token');
    expect((await v.verifyAuthorization(`Bearer ${await mint(keys, serviceClaims())}`, { accept: 'service' })).kind).toBe('service');
  });

  it('maps failures onto the envelope with 401, 403 and 503', () => {
    const cases: Array<[OathweaveFailureReason, number, string, string | undefined]> = [
      ['missing_token', 401, 'unauthorized', 'Bearer'],
      ['expired', 401, 'invalid_token', 'Bearer error="invalid_token"'],
      ['not_linked', 403, 'forbidden', undefined],
      ['insufficient_permission', 403, 'insufficient_permission', 'Bearer error="insufficient_scope"'],
      ['jwks_unavailable', 503, 'auth_unavailable', undefined],
    ];
    for (const [failure, status, code, challenge] of cases) {
      const response = toErrorResponse(new OathweaveError(failure), { requestId: 'r1' });
      expect(response.status).toBe(status);
      expect(response.body.error).toMatchObject({ code, requestId: 'r1', details: { reason: failure } });
      expect(response.headers['www-authenticate']).toBe(challenge);
    }
    expect(toErrorResponse(new OathweaveError('identity_unavailable')).headers['retry-after']).toBe('1');
  });

  it('recognises OathweaveErrors', () => {
    expect(isOathweaveError(new OathweaveError('expired'))).toBe(true);
    expect(isOathweaveError(new Error('x'))).toBe(false);
  });
});
