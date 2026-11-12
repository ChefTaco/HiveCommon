#!/usr/bin/env node
// Regenerates test-vectors/oathweave/{vectors.json,jwks.json}.
//
// Keys are generated in memory for each run and discarded; only the public JWKS and the
// signed tokens are written. Every token is evaluated at the fixed time in `now`, so the
// vectors never expire. Regenerating replaces every token and key ID-bound signature, so
// commit the result as one change and note it in the changelog.
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, importPKCS8, SignJWT } from 'jose';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'test-vectors/oathweave');

const ISSUER = 'https://oathweave.example.test';
const AUDIENCE = 'conformance';
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000; // 2026-01-01T00:00:00Z
const KID = 'conformance-1';

function rsaKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicKey, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

const trusted = rsaKeyPair();
const untrusted = rsaKeyPair();
const trustedKey = await importPKCS8(trusted.privatePem, 'RS256');
const untrustedKey = await importPKCS8(untrusted.privatePem, 'RS256');
const publicJwk = { ...(await exportJWK(trusted.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
const jwks = { keys: [publicJwk] };

const userClaims = {
  actorType: 'USER',
  clientId: 'hivexui',
  sessionId: 'conformance-session',
  username: 'conformance-user',
  roles: ['VIEWER'],
  permissions: ['conformance:read'],
  scope: 'openid conformance:read',
  auth_time: NOW - 120,
};
const serviceClaims = {
  actorType: 'SERVICE_ACCOUNT',
  clientId: 'conformance-service',
  token_type: 'access',
  roles: [],
  permissions: ['conformance:write'],
  scope: 'conformance:write',
};

async function sign(claims, { subject, kid = KID, key = trustedKey, iss = ISSUER, aud = AUDIENCE, iat = NOW - 60, exp = NOW + 840, nbf, jti } = {}) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(subject)
    .setJti(jti ?? `${subject}-${iat}-${exp}`)
    .setIssuedAt(iat)
    .setExpirationTime(exp);
  if (nbf !== undefined) jwt.setNotBefore(nbf);
  return jwt.sign(key);
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function unsigned(header, payload, signer) {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${signer ? signer(input) : ''}`;
}
const userPayload = { ...userClaims, iss: ISSUER, aud: AUDIENCE, sub: 'conformance-user-subject', jti: 'forged', iat: NOW - 60, exp: NOW + 840 };

const user = { subject: 'conformance-user-subject' };
const service = { subject: 'conformance-service' };
const acceptUser = {
  outcome: 'accept', kind: 'user', subject: user.subject, clientId: 'hivexui',
  roles: ['VIEWER'], permissions: ['conformance:read'], scopes: ['openid', 'conformance:read'],
};
const acceptService = {
  outcome: 'accept', kind: 'service', subject: service.subject, clientId: 'conformance-service',
  roles: [], permissions: ['conformance:write'], scopes: ['conformance:write'],
};
const reject = reason => ({ outcome: 'reject', status: 401, reason });

const vectors = [
  { name: 'valid-user', description: 'A user access token with a session, signed by the trusted key.', principal: 'user',
    token: await sign(userClaims, user), expect: acceptUser },
  { name: 'valid-service', description: 'A client-credentials token whose client ID equals its subject.', principal: 'service',
    token: await sign(serviceClaims, { ...service, iat: NOW - 30, exp: NOW + 270 }), expect: acceptService },
  { name: 'expired', description: 'Expired fifteen minutes before the evaluation time.', principal: 'user',
    token: await sign(userClaims, { ...user, iat: NOW - 1800, exp: NOW - 900 }), expect: reject('expired') },
  { name: 'not-yet-valid', description: 'nbf is ten minutes after the evaluation time, beyond any clock tolerance.', principal: 'user',
    token: await sign(userClaims, { ...user, iat: NOW - 60, nbf: NOW + 600, exp: NOW + 840 }), expect: reject('not_yet_valid') },
  { name: 'wrong-audience', description: 'Issued for another product.', principal: 'user',
    token: await sign(userClaims, { ...user, aud: 'another-product' }), expect: reject('invalid_audience') },
  { name: 'wrong-issuer', description: 'Signed by the trusted key but naming another issuer.', principal: 'user',
    token: await sign(userClaims, { ...user, iss: 'https://impostor.example.test' }), expect: reject('invalid_issuer') },
  { name: 'bad-signature', description: 'Names the trusted key ID but is signed by another key.', principal: 'user',
    token: await sign(userClaims, { ...user, key: untrustedKey }), expect: reject('invalid_signature') },
  { name: 'unknown-kid', description: 'Signed by a key the JWKS does not contain.', principal: 'user',
    token: await sign(userClaims, { ...user, key: untrustedKey, kid: 'conformance-unknown' }), expect: reject('unknown_key') },
  { name: 'alg-none', description: 'An unsigned token (alg none).', principal: 'user',
    token: unsigned({ alg: 'none', typ: 'JWT' }, userPayload), expect: reject('algorithm_not_allowed') },
  { name: 'hs256-confusion', description: 'HS256, keyed with the trusted public key, to exploit key-type confusion.', principal: 'user',
    token: unsigned({ alg: 'HS256', kid: KID, typ: 'JWT' }, userPayload,
      input => createHmac('sha256', trusted.publicKey.export({ type: 'spki', format: 'pem' })).update(input).digest('base64url')),
    expect: reject('algorithm_not_allowed') },
  { name: 'lifetime-too-long', description: 'A one-hour token; Oathweave access tokens live at most fifteen minutes.', principal: 'user',
    token: await sign(userClaims, { ...user, iat: NOW - 60, exp: NOW + 3540 }), expect: reject('invalid_lifetime') },
  { name: 'user-without-session', description: 'A USER token with no session cannot be revoked and is refused.', principal: 'user',
    token: await sign({ ...userClaims, sessionId: undefined }, user), expect: reject('invalid_claims') },
];

const document = {
  schema: 1,
  description: 'Oathweave access-token conformance vectors. Synthetic: the signing keys were discarded after generation.',
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUrl: `${ISSUER}/jwks`,
  userinfoUrl: `${ISSUER}/userinfo`,
  now: new Date(NOW * 1000).toISOString(),
  jwks,
  vectors,
};

mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'vectors.json'), `${JSON.stringify(document, null, 2)}\n`);
writeFileSync(resolve(out, 'jwks.json'), `${JSON.stringify(jwks, null, 2)}\n`);
console.log(`Wrote ${vectors.length} vectors to test-vectors/oathweave/`);
