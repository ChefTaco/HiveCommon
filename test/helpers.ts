import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';

export const ISSUER = 'https://oathweave.example.test';
export const AUDIENCE = 'hivemem';
export const JWKS_URL = `${ISSUER}/jwks`;
export const USERINFO_URL = `${ISSUER}/userinfo`;
export const NOW_SEC = 1_767_225_600; // 2026-01-01T00:00:00Z
export const NOW_MS = NOW_SEC * 1000;

export interface TestKeys {
  privateKey: CryptoKey;
  otherPrivateKey: CryptoKey;
  jwks: JSONWebKeySet;
}

export async function testKeys(kid = 'k1'): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256');
  return { privateKey, otherPrivateKey: other.privateKey, jwks: { keys: [{ ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' }] } };
}

export interface MintOptions {
  key?: CryptoKey;
  kid?: string;
  iss?: string;
  aud?: string | string[];
  sub?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  jti?: string | null;
  omit?: string[];
}

export function userClaims(extra: JWTPayload = {}): JWTPayload {
  return {
    actorType: 'USER', clientId: 'hivexui', sessionId: 'session-1', roles: ['VIEWER'], permissions: ['hivemem:read'],
    scope: 'openid hivemem:read', ...extra,
  };
}

export function serviceClaims(clientId = 'ardent-studio', extra: JWTPayload = {}): JWTPayload {
  return { actorType: 'SERVICE_ACCOUNT', clientId, token_type: 'access', roles: [], permissions: ['hivemem:write'], scope: 'hivemem:write', ...extra };
}

export async function mint(keys: TestKeys, claims: JWTPayload, options: MintOptions = {}): Promise<string> {
  const payload: JWTPayload = {
    iss: options.iss ?? ISSUER,
    aud: options.aud ?? AUDIENCE,
    sub: options.sub ?? (claims['actorType'] === 'SERVICE_ACCOUNT' ? (claims['clientId'] as string) : 'user-subject'),
    iat: options.iat ?? NOW_SEC - 10,
    exp: options.exp ?? NOW_SEC + 590,
    ...(options.nbf !== undefined ? { nbf: options.nbf } : {}),
    ...(options.jti === null ? {} : { jti: options.jti ?? 'jti-1' }),
    ...claims,
  };
  for (const field of options.omit ?? []) delete payload[field];
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1', typ: 'JWT' }).sign(options.key ?? keys.privateKey);
}

export function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A fetch stub that records calls and answers by URL. */
export function stubFetch(routes: Record<string, (init: RequestInit | undefined) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route(init);
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}
