import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authenticate, handleHealth, hiveHandler, requestContextFor, sendError, sendJson } from '../src/node-http/index.js';
import { getRequestContext } from '../src/context/index.js';
import { HiveError } from '../src/errors/index.js';
import { createHealth } from '../src/health/index.js';
import { createOathweaveVerifier } from '../src/oathweave/index.js';
import { AUDIENCE, ISSUER, mint, NOW_MS, testKeys, userClaims } from './helpers.js';

const keys = await testKeys();
const verifier = createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: keys.jwks, now: () => NOW_MS });

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise(resolve => server!.close(resolve));
  server = undefined;
});

async function serve(listener: RequestListener): Promise<string> {
  server = createServer(listener);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('hiveHandler', () => {
  it('runs the handler in a request context and authenticates', async () => {
    const base = await serve(hiveHandler(async (req, res) => {
      const principal = await authenticate(req, verifier);
      sendJson(res, 200, { subject: principal.subject, requestId: getRequestContext()?.requestId, principal: (getRequestContext()?.principal as { kind: string }).kind });
    }));
    const response = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${await mint(keys, userClaims())}`, 'x-request-id': 'req-1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ subject: 'user-subject', requestId: 'req-1', principal: 'user' });
  });

  it('continues the inbound trace while generating its own request IDs', async () => {
    const base = await serve(hiveHandler((_req, res) => {
      const context = getRequestContext();
      sendJson(res, 200, { requestId: context?.requestId, trace: context?.trace.traceId, parent: context?.parentTrace?.spanId ?? null });
    }, { trustInboundRequestId: false, trustInboundTrace: true }));
    const response = await fetch(base, { headers: { 'x-request-id': 'caller-id', traceparent: TRACEPARENT } });
    const body = await response.json() as { requestId: string; trace: string; parent: string | null };
    expect(body.requestId).not.toBe('caller-id');
    expect(response.headers.get('x-request-id')).toBe(body.requestId);
    expect(body).toMatchObject({ trace: TRACE_ID, parent: '00f067aa0ba902b7' });
  });

  it('can trust the request ID but not the trace', async () => {
    const base = await serve(hiveHandler((_req, res) => {
      const context = getRequestContext();
      sendJson(res, 200, { requestId: context?.requestId, trace: context?.trace.traceId, parent: context?.parentTrace?.spanId ?? null });
    }, { trustInbound: false, trustInboundRequestId: true }));
    const response = await fetch(base, { headers: { 'x-request-id': 'caller-id', traceparent: TRACEPARENT } });
    const body = await response.json() as { requestId: string; trace: string; parent: string | null };
    expect(response.headers.get('x-request-id')).toBe('caller-id');
    expect(body.requestId).toBe('caller-id');
    expect(body.parent).toBeNull();
    expect(body.trace).not.toBe(TRACE_ID);
  });

  it('requestContextFor honours the trust split', async () => {
    const base = await serve((req, res) => {
      const context = requestContextFor(req, { trustInboundRequestId: false, trustInboundTrace: true });
      sendJson(res, 200, { requestId: context.requestId, trace: context.trace.traceId });
    });
    const body = await (await fetch(base, { headers: { 'x-request-id': 'caller-id', traceparent: TRACEPARENT } })).json() as { requestId: string; trace: string };
    expect(body.requestId).not.toBe('caller-id');
    expect(body.trace).toBe(TRACE_ID);
  });

  it('sends auth failures and HiveErrors as envelopes', async () => {
    const base = await serve(hiveHandler(async (req, res) => {
      if (req.url === '/conflict') throw HiveError.conflict('Stale');
      await authenticate(req, verifier);
      res.end('unreachable');
    }));
    const missing = await fetch(`${base}/v1/me`, { headers: { 'x-request-id': 'r2' } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(await missing.json()).toEqual({ error: { code: 'unauthorized', message: 'A bearer token is required', requestId: 'r2', details: { reason: 'missing_token' } } });
    const conflict = await fetch(`${base}/conflict`);
    expect(conflict.status).toBe(409);
  });

  it('hides unexpected errors and logs them', async () => {
    const logger = { error: vi.fn() };
    const base = await serve(hiveHandler(() => { throw new Error('secret internals'); }, { logger }));
    const response = await fetch(`${base}/x`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('answers a handler that does not respond with 404, and keeps streaming responses alone', async () => {
    const base = await serve(hiveHandler((req, res) => {
      if (req.url === '/stream') { res.writeHead(200); res.write('a'); setTimeout(() => res.end('b'), 10); }
    }, { responseHeader: false }));
    const missing = await fetch(`${base}/nothing`);
    expect(missing.status).toBe(404);
    const stream = await fetch(`${base}/stream`);
    expect(stream.headers.get('x-request-id')).toBeNull();
    expect(await stream.text()).toBe('ab');
  });

  it('serves health routes from options or a Health instance, including HEAD', async () => {
    const base = await serve(hiveHandler(() => undefined, { health: { aliases: true, checks: [{ name: 'db', check: () => false }] } }));
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: 'not_ready' });
    const head = await fetch(`${base}/health/live`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${base}/health/live`, { method: 'POST' })).status).toBe(404);
  });

  it('serves a product liveness body from options or a Health instance', async () => {
    const fromOptions = await serve(hiveHandler(() => undefined, { health: { liveBody: { status: 'ok' } } }));
    const live = await fetch(`${fromOptions}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${fromOptions}/health/ready`)).json()).toMatchObject({ status: 'ready' });
    await new Promise(resolve => server!.close(resolve));
    const fromHealth = await serve(async (req, res) => {
      if (!await handleHealth(req, res, createHealth({ service: 'studio', liveBody: standard => ({ status: 'ok', service: standard.service }) }))) sendJson(res, 404, {});
    });
    expect(await (await fetch(`${fromHealth}/health/live`)).json()).toEqual({ status: 'ok', service: 'studio' });
  });

  it('accepts a prebuilt Health', async () => {
    const base = await serve(hiveHandler(() => undefined, { health: createHealth() }));
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  });
});

describe('helpers', () => {
  it('caches the context per request and refuses duplicate authorization headers', async () => {
    const base = await serve(async (req, res) => {
      const first = requestContextFor(req);
      const second = requestContextFor(req);
      req.headers.authorization = ['Bearer a', 'Bearer b'] as unknown as string;
      try {
        await authenticate(req, verifier);
      } catch (error) {
        sendError(res, error, { requestId: first.requestId });
        return;
      }
      sendJson(res, 200, { same: first === second });
    });
    const response = await fetch(base);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('malformed_token');
  });

  it('sendJson destroys a response that already started', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      sendJson(res, 500, {});
    });
    await expect(fetch(base).then(response => response.text())).rejects.toThrow();
  });

  it('handleHealth ignores non-health paths', async () => {
    const base = await serve(async (req, res) => {
      if (!await handleHealth(req, res, createHealth())) sendJson(res, 200, { handled: false });
    });
    expect(await (await fetch(`${base}/other`)).json()).toEqual({ handled: false });
  });

  it('sendError uses the ambient context and logger', async () => {
    const logger = { error: vi.fn() };
    const base = await serve(hiveHandler((_req, res) => { sendError(res, new Error('x'), { logger }); }));
    const response = await fetch(base, { headers: { 'x-request-id': 'amb' } });
    expect(((await response.json()) as { error: { requestId: string } }).error.requestId).toBe('amb');
    expect(logger.error).toHaveBeenCalled();
  });
});
