import { describe, expect, it, vi } from 'vitest';
import { createServiceTokenProvider, isServiceTokenError, ServiceTokenError } from '../src/oathweave/index.js';
import { HiveError, toErrorResponse } from '../src/errors/index.js';
import { b64 } from './helpers.js';

const TOKEN_URL = 'https://oathweave.example.test/oauth2/token';
const SECRET = 'fixture-client-secret';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

function harness(answers: Array<() => Response | Promise<Response>>, extra: Partial<Parameters<typeof createServiceTokenProvider>[0]> = {}) {
  let at = 1_000_000;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init as RequestInit });
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    return next();
  }) as unknown as typeof fetch;
  const provider = createServiceTokenProvider({ tokenUrl: TOKEN_URL, clientId: 'ardent-studio', clientSecret: SECRET, fetch: request, now: () => at, ...extra });
  return { provider, calls, advance: (ms: number) => { at += ms; }, now: () => at };
}

async function failure(promise: Promise<unknown>): Promise<ServiceTokenError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceTokenError);
    return error as ServiceTokenError;
  }
  throw new Error('expected a ServiceTokenError');
}

describe('createServiceTokenProvider', () => {
  it('requests a client_credentials token and caches it', async () => {
    const { provider, calls } = harness([() => json({ access_token: 'token-1', expires_in: 300, token_type: 'Bearer' })], { scope: 'hivemem:write', audience: 'hivemem' });
    expect(await provider.token()).toBe('token-1');
    expect(await provider.token()).toBe('token-1');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: 'client_credentials', client_id: 'ardent-studio', client_secret: SECRET, scope: 'hivemem:write', audience: 'hivemem',
    });
  });

  it('omits scope and audience when unset', async () => {
    const { provider, calls } = harness([() => json({ access_token: 'token-1' })]);
    await provider.token();
    expect([...new URLSearchParams(calls[0]!.init.body as string).keys()]).toEqual(['grant_type', 'client_id', 'client_secret']);
  });

  it('shares one request between concurrent callers', async () => {
    let release!: (response: Response) => void;
    const { provider, calls } = harness([() => new Promise<Response>(resolve => { release = resolve; })]);
    const pending = [provider.token(), provider.token(), provider.token()];
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release(json({ access_token: 'token-1', expires_in: 300 }));
    expect(await Promise.all(pending)).toEqual(['token-1', 'token-1', 'token-1']);
  });

  it('refreshes in the background at 80 % of the lifetime, serving the cached token meanwhile', async () => {
    let release!: (response: Response) => void;
    const { provider, calls, advance } = harness([
      () => json({ access_token: 'token-1', expires_in: 300 }),
      () => new Promise<Response>(resolve => { release = resolve; }),
    ]);
    await provider.token();
    advance(239_000);
    expect(await provider.token()).toBe('token-1');
    expect(calls).toHaveLength(1);
    advance(2_000); // past 240 s
    expect(await provider.token()).toBe('token-1');
    expect(await provider.token()).toBe('token-1');
    expect(calls).toHaveLength(2);
    release(json({ access_token: 'token-2', expires_in: 300 }));
    await vi.waitFor(async () => expect(await provider.token()).toBe('token-2'));
    expect(calls).toHaveLength(2);
  });

  it('refreshes at least 30 s before the end of a short lifetime', async () => {
    const { provider, calls, advance } = harness([() => json({ access_token: 'token-1', expires_in: 60 }), () => json({ access_token: 'token-2', expires_in: 60 })]);
    await provider.token();
    advance(29_000);
    await provider.token();
    expect(calls).toHaveLength(1);
    advance(2_000);
    await provider.token();
    expect(calls).toHaveLength(2);
  });

  it('keeps serving a usable token when the background refresh fails, then backs off', async () => {
    const { provider, calls, advance } = harness([
      () => json({ access_token: 'token-1', expires_in: 300 }),
      () => json({ error: 'server_error' }, 500),
      () => json({ access_token: 'token-2', expires_in: 300 }),
    ]);
    await provider.token();
    advance(250_000);
    expect(await provider.token()).toBe('token-1');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise(resolve => setImmediate(resolve));
    advance(1_000);
    expect(await provider.token()).toBe('token-1'); // backing off, still usable
    expect(calls).toHaveLength(2);
    advance(5_000);
    expect(await provider.token()).toBe('token-1');
    await vi.waitFor(async () => expect(await provider.token()).toBe('token-2'));
    expect(calls).toHaveLength(3);
  });

  it('stops handing out a token shortly before it expires', async () => {
    const { provider, advance } = harness([() => json({ access_token: 'token-1', expires_in: 300 }), () => json({}, 503)]);
    await provider.token();
    advance(295_001);
    const error = await failure(provider.token());
    expect(error).toMatchObject({ reason: 'http', upstreamStatus: 503, status: 503, code: 'auth_unavailable', message: 'Oathweave token request failed (HTTP 503)' });
    expect((await failure(provider.token())).reason).toBe('backoff');
  });

  it('backs off after a failure and retries once the backoff has passed', async () => {
    const { provider, calls, advance } = harness([() => { throw new TypeError('fetch failed'); }, () => json({ access_token: 'token-1' })]);
    const first = await failure(provider.token());
    expect(first.reason).toBe('network');
    expect(first.cause).toBeUndefined();
    expect((await failure(provider.token())).reason).toBe('backoff');
    expect(calls).toHaveLength(1);
    advance(5_000);
    expect(await provider.token()).toBe('token-1');
  });

  it('retries at once with failureBackoffMs: 0', async () => {
    const { provider } = harness([() => json({}, 500), () => json({ access_token: 'token-1' })], { failureBackoffMs: 0 });
    await failure(provider.token());
    expect(await provider.token()).toBe('token-1');
  });

  it('forgets the token on invalidate()', async () => {
    const { provider, calls } = harness([() => json({ access_token: 'token-1' }), () => json({ access_token: 'token-2' })]);
    await provider.token();
    provider.invalidate();
    expect(await provider.token()).toBe('token-2');
    expect(calls).toHaveLength(2);
  });

  it('clamps the expiry to the JWT exp claim', async () => {
    const harnessed = harness([], {});
    const exp = Math.floor(harnessed.now() / 1000) + 60;
    const token = jwt({ exp });
    const { provider, calls, advance } = harness([() => json({ access_token: token, expires_in: 3600 }), () => json({ access_token: 'token-2' })]);
    expect(await provider.token()).toBe(token);
    advance(31_000); // refresh point of a 60 s token, not of a 3600 s one
    await provider.token();
    expect(calls).toHaveLength(2);
  });

  it('trusts expires_in over exp with clampToTokenExpiry: false', async () => {
    const start = harness([]).now();
    const token = jwt({ exp: Math.floor(start / 1000) + 60 });
    const { provider, calls, advance } = harness([() => json({ access_token: token, expires_in: 3600 })], { clampToTokenExpiry: false });
    await provider.token();
    advance(600_000);
    expect(await provider.token()).toBe(token);
    expect(calls).toHaveLength(1);
  });

  it('refuses a token that is already expired', async () => {
    const start = harness([]).now();
    const { provider } = harness([() => json({ access_token: jwt({ exp: Math.floor(start / 1000) - 10 }), expires_in: 300 })]);
    expect((await failure(provider.token())).reason).toBe('expired_token');
  });

  it('bounds expires_in and falls back to a default lifetime', async () => {
    const short = harness([() => json({ access_token: 'token-1', expires_in: 1 }), () => json({ access_token: 'token-2' })]);
    await short.provider.token();
    short.advance(4_000); // raised to 10 s: usable for 5 s
    expect(await short.provider.token()).toBe('token-1');
    const long = harness([() => json({ access_token: 'token-1', expires_in: 86_400 }), () => json({ access_token: 'token-2' })]);
    await long.provider.token();
    long.advance(3_600_000);
    expect(await long.provider.token()).toBe('token-2');
    const none = harness([() => json({ access_token: 'token-1', expires_in: 'soon' }), () => json({ access_token: 'token-2' })], { defaultLifetimeSec: 100 });
    await none.provider.token();
    none.advance(69_000);
    await none.provider.token();
    expect(none.calls).toHaveLength(1);
    none.advance(2_000);
    await none.provider.token();
    expect(none.calls).toHaveLength(2);
  });

  it('follows a custom refresh rule and waits for the refresh when stale serving is off', async () => {
    let release!: (response: Response) => void;
    const { provider, calls, advance } = harness([
      () => json({ access_token: 'token-1', expires_in: 300 }),
      () => new Promise<Response>(resolve => { release = resolve; }),
    ], { refreshAfterMs: lifetime => lifetime - Math.min(60_000, lifetime / 5), serveStaleWhileRefreshing: false, minLifetimeMs: 0, maxLifetimeMs: Infinity, expiryMarginMs: 0, failureBackoffMs: 0 });
    await provider.token();
    advance(239_000);
    await provider.token();
    expect(calls).toHaveLength(1);
    advance(2_000);
    const waiting = [provider.token(), provider.token()];
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    release(json({ access_token: 'token-2', expires_in: 300 }));
    expect(await Promise.all(waiting)).toEqual(['token-2', 'token-2']);
  });

  it('treats a refresh rule that returns nonsense as "refresh at expiry"', async () => {
    const { provider, calls, advance } = harness([() => json({ access_token: 'token-1', expires_in: 300 })], { refreshAfterMs: () => Number.NaN });
    await provider.token();
    advance(294_000);
    await provider.token();
    expect(calls).toHaveLength(1);
  });

  it('checks the audience of an issued JWT', async () => {
    const wrong = harness([() => json({ access_token: jwt({ aud: 'hiveskills' }) })], { audience: 'hivemem' });
    expect((await failure(wrong.provider.token())).reason).toBe('audience_mismatch');
    for (const aud of ['hivemem', ['other', 'hivemem'], undefined]) {
      const token = jwt(aud === undefined ? {} : { aud });
      const right = harness([() => json({ access_token: token })], { audience: 'hivemem' });
      expect(await right.provider.token()).toBe(token);
    }
    const opaque = harness([() => json({ access_token: 'opaque-token' })], { audience: 'hivemem' });
    expect(await opaque.provider.token()).toBe('opaque-token');
    const unchecked = harness([() => json({ access_token: jwt({ aud: 'hiveskills' }) })], { audience: 'hivemem', verifyAudience: false });
    await expect(unchecked.provider.token()).resolves.toBeTypeOf('string');
  });

  it('ignores tokens that only look like JWTs', async () => {
    for (const token of ['a.b.c', `x.${b64([1])}.y`, `x.${b64('text')}.y`]) {
      const { provider } = harness([() => json({ access_token: token })], { audience: 'hivemem' });
      expect(await provider.token()).toBe(token);
    }
  });

  it('refuses malformed and oversized responses', async () => {
    const cases: Array<() => Response> = [
      () => new Response('not json', { status: 200 }),
      () => new Response('', { status: 200 }),
      () => json(['token']),
      () => json({ access_token: '' }),
      () => json({ access_token: 5 }),
      () => json({ access_token: 'x'.repeat(70_000) }),
    ];
    for (const answer of cases) {
      const { provider } = harness([answer]);
      expect((await failure(provider.token())).reason).toBe('malformed_response');
    }
  });

  it('reports a timeout', async () => {
    const { provider } = harness([], {
      timeoutMs: 20,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      })) as typeof fetch,
    });
    expect((await failure(provider.token())).reason).toBe('timeout');
  });

  it('never puts the secret, a token or the response body in an error', async () => {
    const { provider } = harness([() => json({ error: 'invalid_client', echoed: SECRET }, 401)]);
    const error = await failure(provider.token());
    const text = JSON.stringify([error.message, error.details, toErrorResponse(error), String(error.stack)]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('invalid_client');
    expect(error).toBeInstanceOf(HiveError);
    expect(isServiceTokenError(error)).toBe(true);
    expect(isServiceTokenError(new HiveError('auth_unavailable', 'x', { status: 503 }))).toBe(false);
    const foreign = Object.assign(new HiveError('auth_unavailable', 'x', { status: 503 }), { reason: 'http' });
    Object.defineProperty(foreign, 'name', { value: 'ServiceTokenError' });
    expect(isServiceTokenError(foreign)).toBe(true);
    const failing = harness([() => { throw new Error(`could not send ${SECRET}`); }]);
    const network = await failure(failing.provider.token());
    expect(JSON.stringify([network.message, String(network.cause)])).not.toContain(SECRET);
  });

  it('validates its settings', () => {
    const base = { tokenUrl: TOKEN_URL, clientId: 'client', clientSecret: SECRET };
    expect(() => createServiceTokenProvider({ ...base, tokenUrl: 'http://oathweave.example.test/token' })).toThrow(/tokenUrl must use https/);
    expect(() => createServiceTokenProvider({ ...base, tokenUrl: 'http://127.0.0.1:9/token', allowInsecureLoopback: true })).not.toThrow();
    expect(() => createServiceTokenProvider({ ...base, clientId: '' })).toThrow(/clientId/);
    expect(() => createServiceTokenProvider({ ...base, clientSecret: '' })).toThrow(/clientSecret/);
    expect(() => createServiceTokenProvider({ ...base, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => createServiceTokenProvider({ ...base, timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => createServiceTokenProvider({ ...base, failureBackoffMs: Infinity })).toThrow(/failureBackoffMs/);
    expect(() => createServiceTokenProvider({ ...base, minLifetimeMs: 10, maxLifetimeMs: 5 })).toThrow(/maxLifetimeMs/);
    expect(() => createServiceTokenProvider({ ...base, expiryMarginMs: Number.NaN })).toThrow(/expiryMarginMs/);
  });

  it('uses the global fetch and clock by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ access_token: 'token-1' }));
    try {
      const provider = createServiceTokenProvider({ tokenUrl: TOKEN_URL, clientId: 'client', clientSecret: SECRET });
      expect(await provider.token()).toBe('token-1');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
