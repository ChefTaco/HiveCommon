import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  errorHandler, getHiveContext, getPrincipal, notFoundHandler, oathweaveAuth, registerHealthRoutes, requestContext,
  requirePermission, requirePrincipal, requireRole, requireScope, type HiveEnv,
} from '../src/hono/index.js';
import { formatTraceparent, getRequestContext } from '../src/context/index.js';
import { HiveError } from '../src/errors/index.js';
import { createOathweaveVerifier, requireIdentityLink } from '../src/oathweave/index.js';
import { AUDIENCE, ISSUER, mint, NOW_MS, serviceClaims, testKeys, userClaims } from './helpers.js';

const keys = await testKeys();
const verifier = createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: keys.jwks, now: () => NOW_MS });

function app() {
  const logger = { error: vi.fn() };
  const hono = new Hono<HiveEnv>();
  hono.use(requestContext());
  registerHealthRoutes(hono, { aliases: true, checks: [{ name: 'db', check: () => true }] });
  hono.use('/v1/*', oathweaveAuth(verifier));
  hono.get('/v1/me', c => c.json({ subject: requirePrincipal(c).subject, requestId: getRequestContext()?.requestId, sameContext: getHiveContext(c) === getRequestContext() }));
  hono.get('/v1/admin', requireRole(['ADMIN']), c => c.text('ok'));
  hono.get('/v1/read', requirePermission(['hivemem:read']), requireScope(['openid']), c => c.text('ok'));
  hono.get('/v1/write', requirePermission(['hivemem:write']), c => c.text('ok'));
  hono.get('/v1/scope', requireScope(['admin']), c => c.text('ok'));
  hono.get('/open/boom', () => { throw new Error('secret internals'); });
  hono.get('/open/hive', () => { throw new HiveError('conflict', 'Version changed', { status: 409, details: { version: 2 } }); });
  hono.get('/open/http', () => { throw new HTTPException(413, { message: 'Payload too large' }); });
  hono.get('/open/http500', () => { throw new HTTPException(500, { message: 'internal detail' }); });
  hono.get('/open/no-auth', c => c.json({ principal: getPrincipal(c) ?? null }));
  hono.get('/open/require', c => c.json(requirePrincipal(c)));
  hono.onError(errorHandler({ logger }));
  hono.notFound(notFoundHandler());
  return { hono, logger };
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

const bearer = async (claims = userClaims()) => ({ authorization: `Bearer ${await mint(keys, claims)}` });

describe('requestContext', () => {
  it('adopts or creates request IDs and echoes them', async () => {
    const { hono } = app();
    const adopted = await hono.request('/health/live', { headers: { 'x-correlation-id': 'corr-1' } });
    expect(adopted.headers.get('x-request-id')).toBe('corr-1');
    const created = await hono.request('/health/live');
    expect(created.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('continues the inbound trace while generating its own request IDs', async () => {
    const hono = new Hono<HiveEnv>();
    hono.use(requestContext({ trustInboundRequestId: false, trustInboundTrace: true }));
    hono.get('/', c => c.json({ trace: getHiveContext(c)?.trace.traceId, parent: getHiveContext(c)?.parentTrace?.spanId ?? null }));
    const response = await hono.request('/', { headers: { 'x-request-id': 'caller-id', traceparent: TRACEPARENT } });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({ trace: TRACE_ID, parent: '00f067aa0ba902b7' });
  });

  it('can trust the request ID but not the trace', async () => {
    const hono = new Hono<HiveEnv>();
    hono.use(requestContext({ trustInbound: false, trustInboundRequestId: true }));
    hono.get('/', c => c.json({ trace: getHiveContext(c)?.trace.traceId, parent: getHiveContext(c)?.parentTrace?.spanId ?? null }));
    const response = await hono.request('/', { headers: { 'x-request-id': 'caller-id', traceparent: TRACEPARENT } });
    expect(response.headers.get('x-request-id')).toBe('caller-id');
    const body = await response.json() as { trace: string; parent: string | null };
    expect(body.parent).toBeNull();
    expect(body.trace).not.toBe(TRACE_ID);
  });

  it('can skip the response header', async () => {
    const hono = new Hono();
    hono.use(requestContext({ responseHeader: false }));
    hono.get('/', c => c.text('x'));
    expect((await hono.request('/')).headers.get('x-request-id')).toBeNull();
  });
});

describe('oathweaveAuth', () => {
  it('sets the principal and the AsyncLocalStorage context', async () => {
    const { hono } = app();
    const response = await hono.request('/v1/me', { headers: { ...await bearer(), 'x-request-id': 'req-5' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subject: 'user-subject', requestId: 'req-5', sameContext: true });
  });

  it('answers missing and bad tokens with a 401 envelope and challenge', async () => {
    const { hono } = app();
    const missing = await hono.request('/v1/me', { headers: { 'x-request-id': 'req-6' } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(await missing.json()).toEqual({ error: { code: 'unauthorized', message: 'A bearer token is required', requestId: 'req-6', details: { reason: 'missing_token' } } });
    const bad = await hono.request('/v1/me', { headers: { authorization: 'Bearer a.b.c' } });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
    const service = await hono.request('/v1/me', { headers: await bearer(serviceClaims()) });
    expect(((await service.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('wrong_principal_kind');
  });

  it('enforces roles, permissions and scopes with 403', async () => {
    const { hono } = app();
    const headers = await bearer();
    expect((await hono.request('/v1/read', { headers })).status).toBe(200);
    const write = await hono.request('/v1/write', { headers });
    expect(write.status).toBe(403);
    expect(write.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope"');
    expect((await hono.request('/v1/admin', { headers })).status).toBe(403);
    expect((await hono.request('/v1/scope', { headers })).status).toBe(403);
  });

  it('supports optional auth, accept overrides and an authorize hook', async () => {
    const hono = new Hono<HiveEnv>();
    hono.use('/maybe', oathweaveAuth(verifier, { required: false }));
    hono.use('/service', oathweaveAuth(verifier, { accept: 'service' }));
    hono.use('/linked', oathweaveAuth(verifier, { authorize: principal => { requireIdentityLink([], principal); } }));
    for (const path of ['/maybe', '/service', '/linked']) hono.get(path, c => c.json({ kind: getPrincipal(c)?.kind ?? null }));
    hono.onError(errorHandler());
    expect(await (await hono.request('/maybe')).json()).toEqual({ kind: null });
    expect(await (await hono.request('/maybe', { headers: await bearer() })).json()).toEqual({ kind: 'user' });
    expect((await hono.request('/maybe', { headers: { authorization: 'Bearer x.y.z' } })).status).toBe(401);
    expect(await (await hono.request('/service', { headers: await bearer(serviceClaims()) })).json()).toEqual({ kind: 'service' });
    expect((await hono.request('/linked', { headers: await bearer() })).status).toBe(403);
  });

  it('requirePrincipal fails closed on an unauthenticated route', async () => {
    const { hono } = app();
    expect(await (await hono.request('/open/no-auth')).json()).toEqual({ principal: null });
    expect((await hono.request('/open/require')).status).toBe(401);
  });
});

describe('errorHandler', () => {
  it('sends HiveErrors as envelopes', async () => {
    const { hono } = app();
    const response = await hono.request('/open/hive', { headers: { 'x-request-id': 'r9' } });
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'conflict', message: 'Version changed', requestId: 'r9', details: { version: 2 } } });
  });

  it('hides and logs unexpected errors', async () => {
    const { hono, logger } = app();
    const response = await hono.request('/open/boom');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret internals');
    expect(logger.error).toHaveBeenCalledWith('unhandled error', expect.objectContaining({ path: '/open/boom', method: 'GET' }));
  });

  it('maps Hono HTTPExceptions to their status', async () => {
    const { hono } = app();
    const response = await hono.request('/open/http');
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'too_large', message: 'Payload too large', requestId: expect.any(String) as string } });
    const internal = await hono.request('/open/http500');
    expect(((await internal.json()) as { error: { message: string } }).error.message).toBe('An internal error occurred');
  });

  it('answers unknown routes with a 404 envelope', async () => {
    const { hono } = app();
    const response = await hono.request('/nope');
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('registerHealthRoutes', () => {
  it('keeps headers set earlier in the request', async () => {
    const hono = new Hono<HiveEnv>();
    hono.use(requestContext());
    // A middleware that sets response headers before the handler runs, as trace propagation does.
    hono.use(async (c, next) => {
      const context = getHiveContext(c);
      if (context) c.header('traceparent', formatTraceparent(context.trace));
      c.header('x-served-by', 'fixture');
      await next();
    });
    registerHealthRoutes(hono, { aliases: true, checks: [{ name: 'db', check: () => false }] });
    hono.get('/boom', () => { throw new HiveError('conflict', 'Version changed', { status: 409 }); });
    hono.onError(errorHandler());
    hono.notFound(notFoundHandler());
    for (const [path, method, status] of [
      ['/health/live', 'GET', 200], ['/healthz', 'GET', 200], ['/health/ready', 'GET', 503], ['/health/ready', 'HEAD', 503],
      ['/boom', 'GET', 409], ['/missing', 'GET', 404],
    ] as const) {
      const response = await hono.request(path, { method, headers: { 'x-request-id': 'req-1', traceparent: TRACEPARENT } });
      expect(response.status, `${method} ${path}`).toBe(status);
      expect(response.headers.get('x-request-id'), `${method} ${path}`).toBe('req-1');
      expect(response.headers.get('traceparent'), `${method} ${path}`).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-0[01]$`));
      expect(response.headers.get('x-served-by'), `${method} ${path}`).toBe('fixture');
      expect(response.headers.get('content-type'), `${method} ${path}`).toBe('application/json; charset=utf-8');
      if (path.startsWith('/health')) expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('serves standard and alias paths', async () => {
    const { hono } = app();
    for (const path of ['/health/live', '/healthz', '/health']) {
      const response = await hono.request(path);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { status: string }).status).toBe('live');
    }
    const ready = await hono.request('/readyz');
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { db: { status: 'up' } } });
    const head = await hono.request('/health/ready', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('serves a product liveness body on the standard and alias paths', async () => {
    const hono = new Hono();
    registerHealthRoutes(hono, { aliases: { live: ['/healthz'] }, liveBody: standard => ({ status: 'ok', service: standard.service ?? null }), service: 'skills' });
    for (const path of ['/health/live', '/healthz']) {
      const response = await hono.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ status: 'ok', service: 'skills' });
    }
    expect(await (await hono.request('/health/ready')).json()).toMatchObject({ status: 'ready', service: 'skills' });
    const head = await hono.request('/health/live', { method: 'HEAD' });
    expect(await head.text()).toBe('');
  });

  it('returns 503 when a critical check fails', async () => {
    const hono = new Hono();
    registerHealthRoutes(hono, { checks: [{ name: 'db', check: () => false }] });
    expect((await hono.request('/health/ready')).status).toBe(503);
    expect((await hono.request('/healthz')).status).toBe(404);
  });
});
