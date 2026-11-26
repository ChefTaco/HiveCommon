import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import {
  createRecentAuthenticationVerifier,
  isRecentAuthenticationError,
  RecentAuthenticationError,
  RECENT_AUTHENTICATION_DEFAULT_MAX_AGE_SEC,
  verifyRecentAuthentication,
  type RecentAuthenticationCode,
  type RecentAuthenticationOptions,
} from '../src/oathweave/index.js';
import { HiveError, toErrorResponse } from '../src/errors/index.js';
import { b64, ISSUER, JWKS_URL, NOW_MS, NOW_SEC, stubFetch, testKeys, type TestKeys } from './helpers.js';

const keys = await testKeys();
const CLIENT = 'hivexui-emberpath';
const NONCE = 'nonce-0123456789abcdef';

/** An Oathweave ID token as it issues them: no actorType, clientId or roles. */
function idClaims(extra: JWTPayload = {}): JWTPayload {
  return {
    iss: ISSUER, aud: CLIENT, sub: 'user-subject', iat: NOW_SEC - 5, exp: NOW_SEC + 595, jti: 'id-1',
    auth_time: NOW_SEC - 10, sid: 'session-1', nonce: NONCE, preferred_username: 'operator', ...extra,
  };
}

async function idToken(claims: JWTPayload = idClaims(), options: { key?: CryptoKey; kid?: string; omit?: string[]; source?: TestKeys } = {}): Promise<string> {
  const payload = { ...claims };
  for (const field of options.omit ?? []) delete payload[field];
  const source = options.source ?? keys;
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' }).sign(options.key ?? source.privateKey);
}

type Overrides = { [K in keyof RecentAuthenticationOptions]?: RecentAuthenticationOptions[K] | undefined };

function verifier(options: Overrides = {}) {
  return createRecentAuthenticationVerifier({ issuer: ISSUER, audience: [CLIENT, 'hivexui-oathweave'], keys: keys.jwks, now: () => NOW_MS, ...options } as RecentAuthenticationOptions);
}

async function refusal(promise: Promise<unknown>): Promise<{ code: RecentAuthenticationCode; reason: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    expect(isRecentAuthenticationError(error)).toBe(true);
    const refused = error as RecentAuthenticationError;
    return { code: refused.code, reason: refused.reason, status: refused.status };
  }
  throw new Error('expected a rejection');
}

describe('configuration', () => {
  it('refuses unsafe settings at startup', () => {
    expect(() => verifier({ issuer: 'http://oathweave.example.test' })).toThrow(/issuer must use https/);
    expect(() => verifier({ issuer: [] })).toThrow(/At least one Oathweave issuer/);
    expect(() => verifier({ audience: [] })).toThrow(/step-up audience/);
    expect(() => verifier({ audience: '' })).toThrow(/step-up audience/);
    expect(() => verifier({ audience: [CLIENT, 7 as never] })).toThrow(/step-up audience/);
    expect(() => verifier({ audience: { length: 1 } as never })).toThrow(/step-up audience/);
    expect(() => verifier({ keys: undefined })).toThrow(/jwksUrl is required/);
    expect(() => verifier({ keys: undefined, jwksUrl: 'http://oathweave.example.test/jwks' })).toThrow(/jwksUrl must use https/);
    for (const value of [0, -1, 1.5, 3_601, Number.NaN]) expect(() => verifier({ maxAgeSeconds: value })).toThrow(/maxAgeSeconds/);
    for (const value of [-1, 301, Number.NaN]) expect(() => verifier({ clockToleranceSec: value })).toThrow(/clockToleranceSec/);
    for (const value of [0, 86_401]) expect(() => verifier({ maxLifetimeSec: value })).toThrow(/maxLifetimeSec/);
    for (const value of [0, Number.POSITIVE_INFINITY]) expect(() => verifier({ requestTimeoutMs: value })).toThrow(/requestTimeoutMs/);
  });

  it('reports what it accepts, de-duplicated, with a five-minute default window', () => {
    const v = verifier({ issuer: [ISSUER, ISSUER], audience: [CLIENT, CLIENT] });
    expect(v.issuers).toEqual([ISSUER]);
    expect(v.audiences).toEqual([CLIENT]);
    expect(v.maxAgeSeconds).toBe(RECENT_AUTHENTICATION_DEFAULT_MAX_AGE_SEC);
    expect(RECENT_AUTHENTICATION_DEFAULT_MAX_AGE_SEC).toBe(300);
    expect(verifier({ audience: CLIENT, maxAgeSeconds: 60 }).maxAgeSeconds).toBe(60);
  });
});

describe('a fresh sign-in', () => {
  it('returns the person, session and sign-in time', async () => {
    const result = await verifier().verify(await idToken(), { nonce: NONCE, subject: 'user-subject', sessionId: 'session-1' });
    expect(result).toMatchObject({
      subject: 'user-subject', sessionId: 'session-1', authTime: NOW_SEC - 10, audience: CLIENT, issuer: ISSUER,
      issuedAt: NOW_SEC - 5, expiresAt: NOW_SEC + 595, recentUntil: NOW_SEC - 10 + 300,
    });
    expect(result.claims['preferred_username']).toBe('operator');
  });

  it('accepts any configured client and a token without sid or nonce when none is asked for', async () => {
    const result = await verifier().verify(await idToken(idClaims({ aud: 'hivexui-oathweave' }), { omit: ['sid', 'nonce'] }));
    expect(result).toMatchObject({ audience: 'hivexui-oathweave', sessionId: undefined });
  });

  it('accepts a sign-in exactly at the edge of the window and refuses one second later', async () => {
    expect((await verifier().verify(await idToken(idClaims({ auth_time: NOW_SEC - 300, iat: NOW_SEC - 1 })))).authTime).toBe(NOW_SEC - 300);
    expect(await refusal(verifier().verify(await idToken(idClaims({ auth_time: NOW_SEC - 301, iat: NOW_SEC - 1 }))))).toEqual({ code: 'REAUTH_STALE', reason: 'stale', status: 401 });
  });

  it('lets one call narrow the window but never widen it', async () => {
    const token = await idToken(idClaims({ auth_time: NOW_SEC - 120 }));
    expect(await refusal(verifier().verify(token, { maxAgeSeconds: 60 }))).toMatchObject({ code: 'REAUTH_STALE' });
    expect((await verifier({ maxAgeSeconds: 60 }).verify(await idToken(idClaims({ auth_time: NOW_SEC - 30 })), { maxAgeSeconds: 3_600 })).recentUntil).toBe(NOW_SEC + 30);
    expect(await refusal(verifier({ maxAgeSeconds: 60 }).verify(token, { maxAgeSeconds: 3_600 }))).toMatchObject({ code: 'REAUTH_STALE' });
    await expect(verifier().verify(token, { maxAgeSeconds: 0 })).rejects.toThrow(TypeError);
  });

  it('tolerates a sign-in slightly in the future within the clock tolerance only', async () => {
    const soon = await idToken(idClaims({ auth_time: NOW_SEC + 20, iat: NOW_SEC + 20, exp: NOW_SEC + 600 }));
    expect((await verifier().verify(soon)).authTime).toBe(NOW_SEC + 20);
    expect(await refusal(verifier({ clockToleranceSec: 0 }).verify(soon))).toMatchObject({ code: 'REAUTH_INVALID' });
  });

  it('works as one call too', async () => {
    const token = await idToken();
    const result = await verifyRecentAuthentication({ issuer: ISSUER, audience: CLIENT, keys: keys.jwks, now: () => NOW_MS, idToken: token, nonce: NONCE, subject: 'user-subject', sessionId: 'session-1', maxAgeSeconds: 60 });
    expect(result).toMatchObject({ subject: 'user-subject', recentUntil: NOW_SEC + 50 });
    expect(await refusal(verifyRecentAuthentication({ issuer: ISSUER, audience: CLIENT, keys: keys.jwks, now: () => NOW_MS, idToken: token, nonce: 'another-nonce-0123456789' }))).toMatchObject({ reason: 'nonce_mismatch' });
    expect((await verifyRecentAuthentication({ issuer: ISSUER, audience: CLIENT, keys: keys.jwks, now: () => NOW_MS, idToken: token })).sessionId).toBe('session-1');
  });

  it('uses the real clock when none is given', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await idToken(idClaims({ iat: now, exp: now + 300, auth_time: now - 1 }));
    expect((await createRecentAuthenticationVerifier({ issuer: ISSUER, audience: CLIENT, keys: keys.jwks }).verify(token)).authTime).toBe(now - 1);
  });
});

describe('refusals', () => {
  it('asks for a sign-in when there is no proof or it has no sign-in time', async () => {
    for (const value of [undefined, null, '']) {
      expect(await refusal(verifier().verify(value))).toEqual({ code: 'REAUTH_REQUIRED', reason: 'missing_token', status: 401 });
    }
    expect(await refusal(verifier().verify(await idToken(idClaims(), { omit: ['auth_time'] })))).toEqual({ code: 'REAUTH_REQUIRED', reason: 'missing_auth_time', status: 401 });
  });

  it('refuses malformed tokens and other algorithms before any key lookup', async () => {
    const keyLookup = vi.fn();
    const v = verifier({ keys: keyLookup });
    const header = b64({ alg: 'RS256', kid: 'k1' });
    for (const token of [7 as never, 'a.b', 'x'.repeat(20_000), '!!!.e30.sig']) {
      expect(await refusal(v.verify(token))).toMatchObject({ code: 'REAUTH_INVALID', reason: 'malformed_token' });
    }
    expect(await refusal(v.verify(`${b64({ alg: 'none' })}.${b64(idClaims())}.`))).toMatchObject({ reason: 'algorithm_not_allowed' });
    const input = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(idClaims())}`;
    expect(await refusal(v.verify(`${input}.${createHmac('sha256', 'secret').update(input).digest('base64url')}`))).toMatchObject({ reason: 'algorithm_not_allowed' });
    expect(keyLookup).not.toHaveBeenCalled();
    expect(await refusal(verifier().verify(`${header}.not-json.sig`))).toMatchObject({ code: 'REAUTH_INVALID' });
  });

  it('refuses a forged or unknown-key signature', async () => {
    expect(await refusal(verifier().verify(await idToken(idClaims(), { key: keys.otherPrivateKey })))).toMatchObject({ code: 'REAUTH_INVALID', reason: 'invalid_signature' });
    expect(await refusal(verifier().verify(await idToken(idClaims(), { kid: 'k9' })))).toMatchObject({ code: 'REAUTH_INVALID', reason: 'unknown_key' });
  });

  it('refuses another issuer, audience, or an audience array', async () => {
    expect(await refusal(verifier().verify(await idToken(idClaims({ iss: 'https://elsewhere.example.test' }))))).toMatchObject({ reason: 'invalid_issuer' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ aud: 'hivexui-magnus' }))))).toMatchObject({ code: 'REAUTH_INVALID', reason: 'invalid_audience' });
    // The resource audience of an access token is not a client.
    expect(await refusal(verifier().verify(await idToken(idClaims({ aud: 'emberpath' }))))).toMatchObject({ reason: 'invalid_audience' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ aud: [CLIENT, 'other'] }))))).toMatchObject({ reason: 'invalid_audience' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ aud: [CLIENT] }))))).toMatchObject({ reason: 'invalid_audience' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ azp: 'other' }))))).toMatchObject({ reason: 'invalid_audience' });
    expect((await verifier().verify(await idToken(idClaims({ azp: CLIENT })))).audience).toBe(CLIENT);
  });

  it('refuses expired, not-yet-valid and over-long tokens', async () => {
    expect(await refusal(verifier().verify(await idToken(idClaims({ iat: NOW_SEC - 700, exp: NOW_SEC - 100, auth_time: NOW_SEC - 700 }))))).toMatchObject({ reason: 'expired' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ iat: NOW_SEC + 120, exp: NOW_SEC + 600 }))))).toMatchObject({ reason: 'not_yet_valid' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ iat: NOW_SEC - 5, exp: NOW_SEC + 3_600 }))))).toMatchObject({ reason: 'invalid_lifetime' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ iat: NOW_SEC, exp: NOW_SEC }))))).toMatchObject({ reason: 'invalid_lifetime' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ iat: NOW_SEC - 1_000, exp: NOW_SEC + 10 }))))).toMatchObject({ code: 'REAUTH_INVALID' });
    expect(await refusal(verifier().verify(await idToken(idClaims(), { omit: ['exp'] })))).toMatchObject({ reason: 'invalid_claims' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ sub: '' }))))).toMatchObject({ reason: 'invalid_claims' });
  });

  it('refuses an access token presented as an ID token', async () => {
    for (const extra of [{ actorType: 'USER' }, { token_type: 'access' }, { clientId: CLIENT }, { client_id: CLIENT }]) {
      expect(await refusal(verifier().verify(await idToken(idClaims(extra))))).toMatchObject({ code: 'REAUTH_INVALID', reason: 'not_an_id_token' });
    }
  });

  it('refuses another nonce, person or session', async () => {
    const token = await idToken();
    expect(await refusal(verifier().verify(token, { nonce: 'another-nonce-0123456789' }))).toMatchObject({ reason: 'nonce_mismatch' });
    expect(await refusal(verifier().verify(await idToken(idClaims(), { omit: ['nonce'] }), { nonce: NONCE }))).toMatchObject({ reason: 'nonce_mismatch' });
    expect(await refusal(verifier().verify(token, { subject: 'someone-else' }))).toMatchObject({ reason: 'subject_mismatch' });
    expect(await refusal(verifier().verify(token, { sessionId: 'session-2' }))).toMatchObject({ reason: 'session_mismatch' });
    expect(await refusal(verifier().verify(await idToken(idClaims(), { omit: ['sid'] }), { sessionId: 'session-1' }))).toMatchObject({ reason: 'session_mismatch' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ sid: 42 }))))).toMatchObject({ reason: 'invalid_claims' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ sid: '' }))))).toMatchObject({ reason: 'invalid_claims' });
  });

  it('refuses a sign-in time that is not a time, is in the future or after issuance', async () => {
    for (const value of ['recent', 0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await refusal(verifier().verify(await idToken(idClaims({ auth_time: value }))))).toMatchObject({ code: 'REAUTH_INVALID', reason: 'invalid_auth_time' });
    }
    expect(await refusal(verifier().verify(await idToken(idClaims({ auth_time: NOW_SEC + 120, iat: NOW_SEC + 20, exp: NOW_SEC + 600 }))))).toMatchObject({ reason: 'invalid_auth_time' });
    expect(await refusal(verifier().verify(await idToken(idClaims({ auth_time: NOW_SEC + 25, iat: NOW_SEC - 10 }))))).toMatchObject({ reason: 'invalid_auth_time' });
  });

  it('is a HiveError that sends the suite envelope without the token', async () => {
    const token = await idToken(idClaims({ auth_time: NOW_SEC - 3_000, iat: NOW_SEC - 5 }));
    let caught: unknown;
    try { await verifier().verify(token); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HiveError);
    const response = toErrorResponse(caught);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: 'REAUTH_STALE', message: 'The sign-in is too old for this action; sign in again', details: { reason: 'stale', maxAgeSeconds: 300 } } });
    expect(JSON.stringify(response.body)).not.toContain(token.split('.')[1]);
    expect(isRecentAuthenticationError(new Error('REAUTH_STALE'))).toBe(false);
    expect(isRecentAuthenticationError(Object.assign(new HiveError('REAUTH_STALE', 'copy', { status: 401 }), { name: 'RecentAuthenticationError', reason: 'stale' }))).toBe(true);
  });
});

describe('remote JWKS', () => {
  it('fetches the keys without following redirects', async () => {
    const stub = stubFetch({ [JWKS_URL]: () => Response.json(keys.jwks) });
    const v = verifier({ keys: undefined, jwksUrl: JWKS_URL, fetch: stub.fetch });
    expect((await v.verify(await idToken())).subject).toBe('user-subject');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.init?.redirect).toBe('error');
  });

  it('uses the global fetch when none is given', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(keys.jwks));
    try {
      expect((await verifier({ keys: undefined, jwksUrl: JWKS_URL }).verify(await idToken())).subject).toBe('user-subject');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('is unavailable, never an accept, when the keys cannot be read', async () => {
    const v = verifier({ keys: undefined, jwksUrl: JWKS_URL, fetch: stubFetch({}).fetch });
    const failure = verifier({ keys: undefined, jwksUrl: JWKS_URL, fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch });
    for (const instance of [v, failure]) {
      let caught: unknown;
      try { await instance.verify(await idToken()); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'REAUTH_UNAVAILABLE', reason: 'jwks_unavailable', status: 503 });
      expect(toErrorResponse(caught).headers).toMatchObject({ 'retry-after': '1' });
    }
  });
});
