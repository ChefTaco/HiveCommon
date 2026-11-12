import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultCodeForStatus, defaultMessageForStatus, errorEnvelope, HiveError, isErrorEnvelope, isHiveError, parseHiveError,
  parseHiveErrorResponse, toErrorResponse,
} from '../src/errors/index.js';
import { LEGACY_ERROR_FIXTURES } from './fixtures/legacy-errors.js';

describe('HiveError', () => {
  it('carries code, status, message, details and headers', () => {
    const error = new HiveError('quota_exceeded', 'Quota exceeded', { status: 429, details: { limit: 10 }, headers: { 'Retry-After': '5' }, requestId: 'r' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'HiveError', code: 'quota_exceeded', status: 429, message: 'Quota exceeded', details: { limit: 10 }, requestId: 'r' });
    expect(error.toJSON()).toEqual({ error: { code: 'quota_exceeded', message: 'Quota exceeded', requestId: 'r', details: { limit: 10 } } });
    expect(new HiveError('x', 'y').status).toBe(500);
    expect(new HiveError('x', 'y', { cause: 'root' }).cause).toBe('root');
  });

  it('refuses non-error statuses', () => {
    for (const status of [200, 399, 600, 404.5]) expect(() => new HiveError('x', 'y', { status })).toThrow(RangeError);
  });

  it('has factories for the common cases', () => {
    expect(HiveError.badRequest()).toMatchObject({ code: 'bad_request', status: 400 });
    expect(HiveError.badRequest('m', { f: 1 }).details).toEqual({ f: 1 });
    expect(HiveError.validation('bad', [{ path: 'a' }])).toMatchObject({ code: 'validation_failed', status: 422, details: { issues: [{ path: 'a' }] } });
    expect(HiveError.unauthorized()).toMatchObject({ code: 'unauthorized', status: 401, headers: { 'www-authenticate': 'Bearer' } });
    expect(HiveError.forbidden()).toMatchObject({ code: 'forbidden', status: 403 });
    expect(HiveError.notFound()).toMatchObject({ code: 'not_found', status: 404 });
    expect(HiveError.conflict()).toMatchObject({ code: 'conflict', status: 409 });
    expect(HiveError.conflict('c', { v: 2 }).details).toEqual({ v: 2 });
    expect(HiveError.rateLimited(1.2)).toMatchObject({ status: 429, headers: { 'retry-after': '2' } });
    expect(HiveError.rateLimited().headers).toBeUndefined();
    expect(HiveError.unavailable()).toMatchObject({ code: 'unavailable', status: 503 });
    expect(HiveError.internal('m', 'cause')).toMatchObject({ code: 'internal', status: 500, cause: 'cause' });
  });

  it('is recognised across package copies and compared by code', () => {
    const error = HiveError.notFound();
    expect(isHiveError(error)).toBe(true);
    expect(HiveError.is(error, 'NOT_FOUND')).toBe(true);
    expect(HiveError.is(error, 'conflict')).toBe(false);
    expect(HiveError.is(new Error('x'))).toBe(false);
    const foreign = Object.defineProperty(new Error('x'), Symbol.for('@hivemagnus/hive-common/HiveError'), { value: true });
    expect(isHiveError(foreign)).toBe(true);
    expect(isHiveError({ code: 'x' })).toBe(false);
  });
});

describe('envelope', () => {
  it('builds and recognises envelopes', () => {
    expect(errorEnvelope('a', 'b')).toEqual({ error: { code: 'a', message: 'b' } });
    expect(errorEnvelope('a', 'b', { requestId: 'r', details: {} })).toEqual({ error: { code: 'a', message: 'b', requestId: 'r' } });
    expect(isErrorEnvelope({ error: { code: 'a', message: 'b' } })).toBe(true);
    expect(isErrorEnvelope({ error: { code: 'a', message: 'b', requestId: 'r', details: {} } })).toBe(true);
    for (const value of [null, {}, { error: 'x' }, { error: { code: '', message: 'b' } }, { error: { code: 'a' } },
      { error: { code: 'a', message: 'b', requestId: 1 } }, { error: { code: 'a', message: 'b', details: [] } }]) {
      expect(isErrorEnvelope(value)).toBe(false);
    }
  });

  it('turns HiveErrors into responses with standard headers', () => {
    const response = toErrorResponse(new HiveError('conflict', 'Version changed', { status: 409, details: { version: 3 }, headers: { 'X-Extra': 'y' } }), { requestId: 'req-9' });
    expect(response).toEqual({
      status: 409,
      body: { error: { code: 'conflict', message: 'Version changed', requestId: 'req-9', details: { version: 3 } } },
      headers: { 'x-extra': 'y', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': 'req-9' },
    });
  });

  it('uses the error request ID when none is given', () => {
    expect(toErrorResponse(new HiveError('x', 'y', { status: 400, requestId: 'own' })).body.error.requestId).toBe('own');
    expect(toErrorResponse(new HiveError('x', 'y', { status: 400 })).headers['x-request-id']).toBeUndefined();
  });

  it('never leaks unexpected errors', () => {
    const onUnexpected = vi.fn();
    const secret = new Error('database password is hunter2');
    const response = toErrorResponse(secret, { onUnexpected });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'internal', message: 'An internal error occurred' } });
    expect(onUnexpected).toHaveBeenCalledWith(secret);
    expect(toErrorResponse('string thrown').status).toBe(500);
  });

  it('has defaults for every status class', () => {
    expect(defaultCodeForStatus(404)).toBe('not_found');
    expect(defaultCodeForStatus(418)).toBe('bad_request');
    expect(defaultCodeForStatus(599)).toBe('internal');
    expect(defaultMessageForStatus(418)).toBe('The request failed');
    expect(defaultMessageForStatus(599)).toBe('An internal error occurred');
  });
});

describe('parseHiveError legacy shapes', () => {
  it.each(LEGACY_ERROR_FIXTURES.map(fixture => [fixture.product, fixture] as const))('normalises %s', (_name, fixture) => {
    const error = parseHiveError(fixture.status, fixture.body);
    expect(error).toBeInstanceOf(HiveError);
    expect(error.shape).toBe(fixture.expected.shape);
    expect(error.code).toBe(fixture.expected.code);
    expect(error.message).toBe(fixture.expected.message);
    expect(error.status).toBe(fixture.expected.status ?? fixture.status);
    expect(error.requestId).toBe(fixture.expected.requestId);
    expect(error.details).toEqual(fixture.expected.details);
  });

  it('accepts bytes as well as text and objects', () => {
    const body = new TextEncoder().encode('{"error":{"code":"a","message":"b"}}');
    expect(parseHiveError(400, body).code).toBe('a');
    expect(parseHiveError(400, body.buffer).code).toBe('a');
  });

  it('handles empty and odd bodies', () => {
    expect(parseHiveError(500, undefined)).toMatchObject({ shape: 'empty', code: 'internal' });
    expect(parseHiveError(500, null).shape).toBe('empty');
    expect(parseHiveError(500, '   ').shape).toBe('empty');
    expect(parseHiveError(500, '[1,2]')).toMatchObject({ shape: 'unknown', code: 'internal' });
    expect(parseHiveError(500, '"just text"')).toMatchObject({ shape: 'text', message: 'just text' });
    expect(parseHiveError(500, '42').shape).toBe('unknown');
    expect(parseHiveError(500, 42).shape).toBe('unknown');
    expect(parseHiveError(400, { foo: 'bar' })).toMatchObject({ shape: 'unknown', code: 'bad_request', message: 'The request is not valid' });
    expect(parseHiveError(400, { code: 'X' })).toMatchObject({ shape: 'unknown', code: 'X' });
    expect(parseHiveError(400, { message: 'Plain message', code: 'C', requestId: 'r' })).toMatchObject({ shape: 'message', code: 'C', message: 'Plain message', requestId: 'r' });
  });

  it('handles partial envelopes', () => {
    expect(parseHiveError(404, { error: {} })).toMatchObject({ shape: 'envelope', code: 'not_found', message: 'The resource was not found' });
    expect(parseHiveError(400, { error: { type: 'bad_type', detail: 'from detail' } })).toMatchObject({ code: 'bad_type', message: 'from detail' });
    expect(parseHiveError(400, { error: { code: 'c', message: 'm', details: 'scalar' } }).details).toEqual({ value: 'scalar' });
    expect(parseHiveError(400, { error: { code: 'c', message: 'm' }, request_id: 'top' }).requestId).toBe('top');
    expect(parseHiveError(400, { error: { code: 'c', message: 'm', request_id: 'inner' } }).requestId).toBe('inner');
    expect(parseHiveError(400, { error: 'Bad thing happened', requestId: 'r2' }).requestId).toBe('r2');
    expect(parseHiveError(401, { error: 'UNAUTHORIZED', message: 'x', requestId: 'r3' }).requestId).toBe('r3');
  });

  it('handles FastAPI edge cases', () => {
    const odd = parseHiveError(422, { detail: ['plain string', { msg: '' }, { loc: 'not-array', msg: 'm' }] });
    expect(odd.details).toEqual({ issues: [{ path: '$', message: 'plain string' }, { path: '$', message: 'Invalid value' }, { path: '$', message: 'm' }] });
    expect(odd.message).toBe('$: plain string (and 2 more)');
    expect(parseHiveError(422, { detail: [] }).message).toBe('The request is not valid');
    expect(parseHiveError(422, { detail: [5] }).details).toEqual({ issues: [{ path: '$', message: 'Invalid value' }] });
    expect(parseHiveError(400, { detail: {} })).toMatchObject({ code: 'bad_request', message: 'The request is not valid' });
    const many = parseHiveError(422, { detail: Array.from({ length: 80 }, () => ({ loc: ['a'], msg: 'm' })) });
    expect((many.details?.['issues'] as unknown[]).length).toBe(50);
  });

  it('does not mistake other objects with id and message for Mattermost', () => {
    expect(parseHiveError(400, { id: 'x', message: 'm' }).shape).toBe('message');
  });

  it('uses the Mattermost status_code when the transport status is unusable', () => {
    expect(parseHiveError(0, { id: 'api.x', message: 'm', status_code: 403, request_id: 'r' }).status).toBe(403);
    expect(parseHiveError(0, { id: 'api.x', message: 'm', status_code: 'x', request_id: 'r' }).status).toBe(502);
    expect(parseHiveError(200, { error: 'x y' }).status).toBe(502);
  });

  it('bounds and cleans remote text', () => {
    const long = parseHiveError(400, { error: { code: `bad code${'x'.repeat(200)}`, message: `line1\nline2\u0000${'y'.repeat(2000)}` } });
    expect(long.code.length).toBeLessThanOrEqual(128);
    expect(long.code.startsWith('bad_code')).toBe(true);
    expect(long.message.length).toBeLessThanOrEqual(1000);
    expect(long.message.startsWith('line1 line2 ')).toBe(true);
    expect(parseHiveError(400, { error: { code: '!!!', message: '   ' } })).toMatchObject({ code: 'bad_request', message: 'The request is not valid' });
  });

  it('takes the request ID and headers from options', () => {
    const error = parseHiveError(429, '', { requestId: 'hdr', headers: { 'retry-after': '3' } });
    expect(error.requestId).toBe('hdr');
    expect(error.headers).toEqual({ 'retry-after': '3' });
    expect(parseHiveError(400, { error: { code: 'a', message: 'b', requestId: 'body' } }, { requestId: 'hdr' }).requestId).toBe('body');
  });

  it('reads fetch responses', async () => {
    const error = await parseHiveErrorResponse(new Response('{"success":false,"error":{"code":"X","message":"m"}}', {
      status: 409, headers: { 'x-request-id': 'r1', 'retry-after': '2' },
    }));
    expect(error).toMatchObject({ shape: 'magnus', code: 'X', requestId: 'r1', headers: { 'retry-after': '2' }, status: 409 });
    const broken = new Response('x', { status: 500 });
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('stream broke'));
    expect(await parseHiveErrorResponse(broken)).toMatchObject({ shape: 'empty', status: 500 });
  });
});

describe('isomorphism', () => {
  it('errors and contracts import no Node built-ins', () => {
    for (const file of ['../src/errors/index.ts', '../src/contracts/index.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"](?:node:|fs|path|crypto|http|https|os|async_hooks)/);
      expect(source).not.toMatch(/\bprocess\.|\bBuffer\b/);
      const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
      expect(imports.every(path => path?.startsWith('../contracts/'))).toBe(true);
    }
  });
});
