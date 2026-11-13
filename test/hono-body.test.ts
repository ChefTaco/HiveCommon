import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_MAX_BODY_BYTES, errorHandler, notFoundHandler, readBody, readJsonBody, securityHeaders, type ReadJsonBodyOptions } from '../src/hono/index.js';
import { HiveError } from '../src/errors/index.js';

function app(options: ReadJsonBodyOptions = {}) {
  const hono = new Hono();
  hono.post('/json', async c => c.json(await readJsonBody(c, options)));
  hono.post('/raw', async c => c.json({ bytes: (await readBody(c, options)).byteLength }));
  hono.onError(errorHandler());
  return hono;
}

const JSON_TYPE = { 'content-type': 'application/json' };
function chunked(chunks: string[], fail = false): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
      else if (fail) controller.error(new Error('connection reset'));
      else controller.close();
    },
  });
}
const post = (hono: Hono, path: string, body: BodyInit | null, headers: Record<string, string> = JSON_TYPE) =>
  hono.request(path, { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
const code = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

describe('hono readJsonBody', () => {
  it('parses a JSON body and returns its text', async () => {
    const response = await post(app(), '/json', '{"a": 1}', { 'content-type': 'application/json; charset=utf-8' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: { a: 1 }, text: '{"a": 1}', bytes: 8 });
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1_048_576);
  });

  it('reads from a plain Request as well as a context', async () => {
    const request = new Request('https://service.example.test/', { method: 'POST', body: '[1,2]', headers: JSON_TYPE });
    expect((await readJsonBody(request)).value).toEqual([1, 2]);
    expect(await readBody(new Request('https://service.example.test/'))).toEqual(new Uint8Array());
  });

  it('refuses a declared length over the limit before reading', async () => {
    const response = await post(app({ maxBytes: 10 }), '/json', '{"a":"0123456789"}');
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'too_large', details: { maxBytes: 10 } } });
    const bodiless = await app({ maxBytes: 10 }).request('/json', { method: 'POST', headers: { ...JSON_TYPE, 'content-length': '11' } });
    expect(bodiless.status).toBe(413);
  });

  it('enforces the limit while streaming, without a content-length', async () => {
    const response = await post(app({ maxBytes: 10 }), '/json', chunked(['{"a":"', '0123456789', '"}']));
    expect(response.status).toBe(413);
    expect(await code(response)).toBe('too_large');
    const within = await post(app({ maxBytes: 100 }), '/json', chunked(['{"a":"', '0123456789', '"}']));
    expect(((await within.json()) as { value: unknown }).value).toEqual({ a: '0123456789' });
    expect((await post(app({ maxBytes: 4 }), '/raw', chunked(['abc', 'def']))).status).toBe(413);
    expect(await (await post(app({ maxBytes: 6 }), '/raw', chunked(['abc', 'def']))).json()).toEqual({ bytes: 6 });
  });

  it('answers 400 for a body that fails mid-stream', async () => {
    const response = await post(app(), '/json', chunked(['{"a":'], true));
    expect(response.status).toBe(400);
    expect(await code(response)).toBe('request_aborted');
  });

  it('answers 400 for invalid or empty JSON, unless an empty value is set', async () => {
    expect(await code(await post(app(), '/json', '{"a":'))).toBe('invalid_json');
    const empty = await post(app(), '/json', null);
    expect(empty.status).toBe(400);
    expect(await code(empty)).toBe('invalid_json');
    const allowed = await post(app({ emptyValue: {} }), '/json', '  \n', {});
    expect(await allowed.json()).toEqual({ value: {}, text: '', bytes: 3 });
  });

  it('checks the content type only when there is a body, by default', async () => {
    const wrong = await post(app(), '/json', '{"a":1}', { 'content-type': 'text/plain' });
    expect(wrong.status).toBe(415);
    expect(await code(wrong)).toBe('unsupported_media_type');
    expect((await post(app(), '/json', '{"a":1}', {})).status).toBe(415);
    expect((await post(app(), '/json', '{"a":1}', { 'content-type': 'application/jsonx' })).status).toBe(415);
    expect((await post(app({ emptyValue: null }), '/json', null, {})).status).toBe(200);
    expect((await post(app({ requireContentType: 'never' }), '/json', '{"a":1}', { 'content-type': 'text/plain' })).status).toBe(200);
    expect((await post(app({ requireContentType: 'always', emptyValue: null }), '/json', null, {})).status).toBe(415);
    expect((await post(app({ requireContentType: 'always' }), '/json', '{}', { 'content-type': 'APPLICATION/JSON' })).status).toBe(200);
    expect((await post(app(), '/json', '{}', { 'content-type': 'application/merge-patch+json' })).status).toBe(415);
    expect((await post(app({ jsonTypes: 'suffix' }), '/json', '{}', { 'content-type': 'application/merge-patch+json' })).status).toBe(200);
  });

  it('lets a product throw its own errors', async () => {
    const hono = app({ maxBytes: 4, errorFor: problem => new HiveError(`PRODUCT_${problem.toUpperCase()}`, 'custom', { status: 422 }) });
    const response = await post(hono, '/json', '{"a":1}');
    expect(response.status).toBe(422);
    expect(await code(response)).toBe('PRODUCT_TOO_LARGE');
    expect(await code(await post(hono, '/json', '{'))).toBe('PRODUCT_INVALID_JSON');
    expect(await code(await post(hono, '/json', '[]', {}))).toBe('PRODUCT_UNSUPPORTED_MEDIA_TYPE');
    expect(await code(await post(hono, '/raw', chunked(['abcdef'])))).toBe('PRODUCT_TOO_LARGE');
  });

  it('refuses a limit that is not a number', async () => {
    await expect(readBody(new Request('https://service.example.test/'), { maxBytes: -1 })).rejects.toThrow(RangeError);
  });
});

describe('securityHeaders', () => {
  it('sets the baseline headers on every response, errors included', async () => {
    const hono = new Hono();
    hono.use(securityHeaders());
    hono.get('/ok', c => c.text('ok'));
    hono.get('/boom', () => { throw new Error('x'); });
    hono.onError(errorHandler());
    hono.notFound(notFoundHandler());
    for (const path of ['/ok', '/boom', '/missing']) {
      const response = await hono.request(path);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('takes other values, extra headers and omissions', async () => {
    const hono = new Hono();
    hono.use(securityHeaders({
      referrerPolicy: 'strict-origin-when-cross-origin', frameOptions: false,
      headers: { 'Content-Security-Policy': "default-src 'self'", 'x-content-type-options': false, 'Permissions-Policy': undefined, 'X-Empty': '' },
    }));
    hono.get('/', c => c.text('ok'));
    const response = await hono.request('/');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'");
    for (const name of ['x-frame-options', 'x-content-type-options', 'permissions-policy', 'x-empty']) expect(response.headers.has(name)).toBe(false);
  });

  it('builds headers per request and can apply them after the handler', async () => {
    const hono = new Hono();
    hono.use('/before/*', securityHeaders({ headers: c => ({ 'x-path': c.req.path }) }));
    hono.use('/after/*', securityHeaders({ apply: 'after' }));
    const handler = (c: { header(name: string, value: string): void; text(body: string): Response }) => { c.header('Referrer-Policy', 'origin'); return c.text('ok'); };
    hono.get('/before/x', handler);
    hono.get('/after/x', handler);
    const before = await hono.request('/before/x');
    expect(before.headers.get('x-path')).toBe('/before/x');
    expect(before.headers.get('referrer-policy')).toBe('origin');
    expect((await hono.request('/after/x')).headers.get('referrer-policy')).toBe('no-referrer');
  });
});
