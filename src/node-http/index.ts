/**
 * `node:http` adapters: the same request context, Oathweave auth, error envelope and health
 * routes as `/hono`, for services built on a plain `http.createServer()`.
 *
 *   const server = http.createServer(hiveHandler(async (req, res) => {
 *     const principal = await authenticate(req, verifier);
 *     sendJson(res, 200, { hello: principal.subject });
 *   }, { health: { checks }, logger }));
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  type CreateRequestContextOptions,
  type RequestContext,
} from '../context/index.js';
import { HiveError, toErrorResponse } from '../errors/index.js';
import { createHealth, type Health, type HealthOptions } from '../health/index.js';
import type { Logger } from '../log/index.js';
import type { OathweavePrincipal } from '../oathweave/claims.js';
import type { OathweaveVerifier, VerifyOptions } from '../oathweave/verifier.js';
import { OathweaveError } from '../oathweave/errors.js';

/** The request context for `req`, created on first use and cached on the request. */
const contexts = new WeakMap<IncomingMessage, RequestContext>();

export function requestContextFor(req: IncomingMessage, options: CreateRequestContextOptions = {}): RequestContext {
  let context = contexts.get(req);
  if (!context) {
    context = createRequestContext(req.headers, options);
    contexts.set(req, context);
  }
  return context;
}

/** Verify the request's `Authorization: Bearer` header and record the principal on the context. */
export async function authenticate(req: IncomingMessage, verifier: OathweaveVerifier, options: VerifyOptions = {}): Promise<OathweavePrincipal> {
  const header = req.headers.authorization;
  if (Array.isArray(header)) throw new OathweaveError('malformed_token');
  const principal = await verifier.verifyAuthorization(header, options);
  const context = contexts.get(req) ?? getRequestContext();
  if (context) context.principal = principal;
  return principal;
}

/** Send a JSON body with `no-store` caching. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

export interface SendErrorOptions {
  readonly requestId?: string | undefined;
  readonly logger?: Pick<Logger, 'error'>;
}

/** Send any thrown value as the error envelope. Non-HiveErrors become a logged, generic 500. */
export function sendError(res: ServerResponse, error: unknown, options: SendErrorOptions = {}): void {
  const response = toErrorResponse(error, {
    requestId: options.requestId ?? getRequestContext()?.requestId,
    onUnexpected: unexpected => options.logger?.error('unhandled error', { err: unexpected }),
  });
  sendJson(res, response.status, response.body, response.headers);
}

/**
 * Serve a health path. Returns true when `req` was a health request and has been answered.
 * The liveness body is the one `health` was created with (see `liveBody`).
 */
export async function handleHealth(req: IncomingMessage, res: ServerResponse, health: Health<object>): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    // A request target that is not a URL is not a health path; the handler decides what it is.
    return false;
  }
  const pending = health.handle(pathname);
  if (!pending) return false;
  const result = await pending;
  sendJson(res, result.status, result.body, result.headers);
  return true;
}

export interface HiveHandlerOptions extends CreateRequestContextOptions {
  /** Serve health endpoints before `handler` runs. */
  readonly health?: HealthOptions<object> | Health<object>;
  readonly logger?: Pick<Logger, 'error'>;
  /** Echo `x-request-id` on every response. Defaults to true. */
  readonly responseHeader?: boolean;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

function isHealth(value: HealthOptions<object> | Health<object>): value is Health<object> {
  return typeof (value as Health<object>).handle === 'function';
}

/**
 * Wrap a handler with the request context, health routes and the error envelope. Anything the
 * handler throws (or rejects with) is sent as an envelope; a handler that returns without
 * responding gets a 404 envelope.
 */
export function hiveHandler(handler: Handler, options: HiveHandlerOptions = {}): RequestListener {
  const health = options.health ? (isHealth(options.health) ? options.health : createHealth(options.health)) : undefined;
  return (req, res) => {
    const context = requestContextFor(req, options);
    if (options.responseHeader ?? true) res.setHeader('x-request-id', context.requestId);
    void runWithRequestContext(context, async () => {
      try {
        if (health && await handleHealth(req, res, health)) return;
        await handler(req, res);
        if (!res.headersSent && !res.writableEnded) sendError(res, HiveError.notFound(), { requestId: context.requestId });
      } catch (error) {
        try {
          sendError(res, error, { requestId: context.requestId, ...(options.logger ? { logger: options.logger } : {}) });
        } catch {
          // The envelope itself could not be sent (a logger that throws, an unsendable header).
          // Close the connection rather than leave it open or crash on an unhandled rejection.
          res.destroy();
        }
      }
    });
  };
}
