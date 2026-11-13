import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFetch, BoundedFetchError, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, fetchJson, isBoundedFetchError, parseJsonBytes,
  readBodyBounded, readJsonBounded, readStreamBounded, readTextBounded,
} from '../src/fetch/index.js';
import { createRequestContext, outboundHeaders, runWithRequestContext } from '../src/context/index.js';
import { HiveError } from '../src/errors/index.js';

const URL_ = 'https://peer.example.test/v1/things';

function streamOf(chunks: Array<string | Uint8Array>, options: { onCancel?: () => void; hang?: boolean } = {}): ReadableStream<Uint8Array> {
  const queue = chunks.map(chunk => typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else if (!options.hang) controller.close();
      else return new Promise<void>(() => undefined);
      return undefined;
    },
    cancel() { options.onCancel?.(); },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('readBodyBounded', () => {
  it('reads a body within the limit', async () => {
    const body = await readBodyBounded(new Response(streamOf(['ab', 'cd'])), 4);
    expect(new TextDecoder().decode(body)).toBe('abcd');
    expect(await readTextBounded(new Response('héllo'), 100)).toBe('héllo');
    expect(await readBodyBounded(new Response(null, { status: 204 }), 10)).toEqual(new Uint8Array());
  });

  it('refuses a declared length over the limit without reading', async () => {
    const onCancel = vi.fn();
    const response = new Response(streamOf(['x'], { onCancel }), { headers: { 'content-length': '11' } });
    const error = await rejection(readBodyBounded(response, 10));
    expect(error).toMatchObject({ name: 'BoundedFetchError', reason: 'response_too_large', maxBytes: 10 });
    expect(onCancel).toHaveBeenCalled();
    expect(isBoundedFetchError(await rejection(readBodyBounded(new Response(null, { headers: { 'content-length': '11' } }), 10)), 'response_too_large')).toBe(true);
  });

  it('enforces the limit while streaming, without or against a content-length', async () => {
    const onCancel = vi.fn();
    const error = await rejection(readBodyBounded(new Response(streamOf(['aaaa', 'bbbb', 'cccc'], { onCancel })), 6));
    expect(isBoundedFetchError(error, 'response_too_large')).toBe(true);
    expect(isBoundedFetchError(error, 'timeout')).toBe(false);
    expect(onCancel).toHaveBeenCalled();
    const lying = new Response(streamOf(['aaaa', 'bbbb']), { headers: { 'content-length': '2' } });
    expect(isBoundedFetchError(await rejection(readBodyBounded(lying, 6)))).toBe(true);
    const unreadable = new Response(streamOf(['ab']), { headers: { 'content-length': 'many' } });
    expect((await readBodyBounded(unreadable, 6)).byteLength).toBe(2);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const onCancel = vi.fn();
    const pending = readBodyBounded(new Response(streamOf(['a'], { hang: true, onCancel })), 100, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller gave up')), 5);
    expect(await rejection(pending)).toMatchObject({ message: 'caller gave up' });
    expect(onCancel).toHaveBeenCalled();
    const already = AbortSignal.abort(new Error('before'));
    expect(await rejection(readBodyBounded(new Response('abc'), 100, { signal: already }))).toMatchObject({ message: 'before' });
  });

  it('refuses a limit that is not a number', async () => {
    await expect(readBodyBounded(new Response('a'), Number.NaN)).rejects.toThrow(RangeError);
    await expect(readBodyBounded(new Response('a'), -1)).rejects.toThrow(RangeError);
    expect(await readStreamBounded(streamOf(['a']), Infinity, () => new Error('never'))).toHaveLength(1);
  });
});

describe('parseJsonBytes and readJsonBounded', () => {
  it('parses JSON and names what is wrong otherwise', async () => {
    expect(parseJsonBytes('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonBytes(new TextEncoder().encode('[1]'))).toEqual([1]);
    expect(() => parseJsonBytes('  ')).toThrow(expect.objectContaining({ reason: 'empty_response' }));
    expect(parseJsonBytes('', { emptyValue: null })).toBeNull();
    expect(parseJsonBytes('', { emptyValue: undefined })).toBeUndefined();
    const invalid = (() => { try { return parseJsonBytes('{'); } catch (error) { return error; } })() as BoundedFetchError;
    expect(invalid).toBeInstanceOf(BoundedFetchError);
    expect(invalid.reason).toBe('invalid_json');
    expect(invalid.cause).toBeInstanceOf(SyntaxError);
    expect(await readJsonBounded(new Response('{"ok":true}'), 100)).toEqual({ ok: true });
    expect(isBoundedFetchError(await rejection(readJsonBounded(new Response('{"ok":true}'), 3)), 'response_too_large')).toBe(true);
    expect(await readJsonBounded(new Response(''), 3, { emptyValue: {} })).toEqual({});
  });
});

describe('boundedFetch', () => {
  it('fetches with redirect: error and a deadline, and returns the read body', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('hello', { status: 201 }));
    const { response, body } = await boundedFetch(URL_, { method: 'POST', body: 'x' }, { fetch: request as typeof fetch });
    expect(response.status).toBe(201);
    expect(new TextDecoder().decode(body)).toBe('hello');
    const init = request.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: 'POST', body: 'x', redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toBeUndefined();
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(1_048_576);
  });

  it('lets the caller choose the redirect policy', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(''));
    await boundedFetch(URL_, {}, { fetch: request as typeof fetch, redirect: 'manual' });
    await boundedFetch(URL_, { redirect: 'follow' }, { fetch: request as typeof fetch, redirect: 'manual' });
    expect(request.mock.calls.map(call => call[1]!.redirect)).toEqual(['manual', 'follow']);
  });

  it('uses the global fetch by default and can run without a deadline', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await boundedFetch(new URL(URL_));
    expect(spy.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    await boundedFetch(URL_, {}, { timeoutMs: 0 });
    expect(spy.mock.calls[1]![1]).not.toHaveProperty('signal');
    const controller = new AbortController();
    await boundedFetch(URL_, { signal: controller.signal }, { timeoutMs: Infinity });
    expect(spy.mock.calls[2]![1]!.signal).toBe(controller.signal);
  });

  it('forwards context headers without overriding the caller', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(''));
    const context = createRequestContext({ 'x-request-id': 'req-7' });
    await runWithRequestContext(context, () => boundedFetch(URL_, { headers: { authorization: 'Bearer fixture-token' } }, { fetch: request as typeof fetch, contextHeaders: outboundHeaders }));
    const sent = request.mock.calls[0]![1]!.headers as Headers;
    expect(sent.get('x-request-id')).toBe('req-7');
    expect(sent.get('traceparent')).toMatch(/^00-/);
    expect(sent.get('authorization')).toBe('Bearer fixture-token');
    await boundedFetch(URL_, { headers: { 'X-Request-Id': 'mine' } }, { fetch: request as typeof fetch, contextHeaders: { 'x-request-id': 'theirs', 'x-extra': '1' } });
    const second = request.mock.calls[1]![1]!.headers as Headers;
    expect(second.get('x-request-id')).toBe('mine');
    expect(second.get('x-extra')).toBe('1');
    await boundedFetch(URL_, {}, { fetch: request as typeof fetch, contextHeaders: outboundHeaders });
    expect(request.mock.calls[2]![1]!.headers).toBeUndefined();
  });

  it('reports a missed deadline as timeout, also while the body is arriving', async () => {
    const never = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    })) as typeof fetch;
    const error = await rejection(boundedFetch(URL_, {}, { fetch: never, timeoutMs: 15 }));
    expect(isBoundedFetchError(error, 'timeout')).toBe(true);
    expect((error as Error).message).not.toContain('peer.example.test');
    expect((error as Error).cause).toBeDefined();
    const slowBody = (async () => new Response(streamOf(['a'], { hang: true }))) as typeof fetch;
    expect(isBoundedFetchError(await rejection(boundedFetch(URL_, {}, { fetch: slowBody, timeoutMs: 15 })), 'timeout')).toBe(true);
  });

  it('passes the caller\'s own abort through unchanged', async () => {
    const controller = new AbortController();
    const never = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    })) as typeof fetch;
    const pending = boundedFetch(URL_, { signal: controller.signal }, { fetch: never });
    const reason = new Error('navigation');
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
  });

  it('wraps transport failures and keeps size failures', async () => {
    const broken = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const error = await rejection(boundedFetch(URL_, {}, { fetch: broken })) as BoundedFetchError;
    expect(error.reason).toBe('network');
    expect(error.cause).toBeInstanceOf(TypeError);
    const big = (async () => new Response('x'.repeat(50))) as typeof fetch;
    expect(isBoundedFetchError(await rejection(boundedFetch(URL_, {}, { fetch: big, maxResponseBytes: 10 })), 'response_too_large')).toBe(true);
  });

  it('validates its limits', async () => {
    await expect(boundedFetch(URL_, {}, { timeoutMs: -1 })).rejects.toThrow(RangeError);
    await expect(boundedFetch(URL_, {}, { timeoutMs: Number.NaN })).rejects.toThrow(RangeError);
    await expect(boundedFetch(URL_, {}, { maxResponseBytes: -1 })).rejects.toThrow(RangeError);
  });
});

describe('fetchJson', () => {
  const answering = (response: () => Response) => vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());

  it('asks for JSON and parses the answer', async () => {
    const request = answering(() => Response.json({ id: 1 }));
    const { response, data } = await fetchJson(URL_, {}, { fetch: request as typeof fetch });
    expect(response.status).toBe(200);
    expect(data).toEqual({ id: 1 });
    expect((request.mock.calls[0]![1]!.headers as Headers).get('accept')).toBe('application/json');
    await fetchJson(URL_, { headers: { Accept: 'application/problem+json' } }, { fetch: request as typeof fetch });
    expect((request.mock.calls[1]![1]!.headers as Headers).get('accept')).toBe('application/problem+json');
  });

  it('throws the peer\'s error as a HiveError', async () => {
    const request = answering(() => new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such thing' } }), {
      status: 404, headers: { 'x-request-id': 'req-9', 'retry-after': '3' },
    }));
    const error = await rejection(fetchJson(URL_, {}, { fetch: request as typeof fetch })) as HiveError;
    expect(HiveError.is(error, 'not_found')).toBe(true);
    expect(error).toMatchObject({ status: 404, message: 'No such thing', requestId: 'req-9', headers: { 'retry-after': '3' } });
    const bare = await rejection(fetchJson(URL_, {}, { fetch: answering(() => new Response('', { status: 502 })) as typeof fetch })) as HiveError;
    expect(bare).toMatchObject({ status: 502, code: 'bad_gateway' });
    expect(bare.requestId).toBeUndefined();
  });

  it('returns error responses when asked to', async () => {
    const json = await fetchJson(URL_, {}, { fetch: answering(() => Response.json({ error: 'nope' }, { status: 409 })) as typeof fetch, throwOnHttpError: false });
    expect(json.response.status).toBe(409);
    expect(json.data).toEqual({ error: 'nope' });
    const text = await fetchJson(URL_, {}, { fetch: answering(() => new Response('<html>', { status: 500 })) as typeof fetch, throwOnHttpError: false });
    expect(text.data).toBeUndefined();
  });

  it('handles bodiless statuses and bad success bodies', async () => {
    expect((await fetchJson(URL_, {}, { fetch: answering(() => new Response(null, { status: 204 })) as typeof fetch })).data).toBeUndefined();
    expect((await fetchJson(URL_, {}, { fetch: answering(() => new Response(null, { status: 204 })) as typeof fetch, emptyValue: null })).data).toBeNull();
    expect(isBoundedFetchError(await rejection(fetchJson(URL_, {}, { fetch: answering(() => new Response('')) as typeof fetch })), 'empty_response')).toBe(true);
    expect((await fetchJson(URL_, {}, { fetch: answering(() => new Response('')) as typeof fetch, emptyValue: {} })).data).toEqual({});
    expect(isBoundedFetchError(await rejection(fetchJson(URL_, {}, { fetch: answering(() => new Response('<html>')) as typeof fetch })), 'invalid_json')).toBe(true);
  });
});
