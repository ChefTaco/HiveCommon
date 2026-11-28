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
import {
  bodyError, checkContentTypeFirst, declaredLength, maxBodyBytes, parseJsonBody,
  type JsonBody, type ReadBodyLimits, type ReadJsonBodyOptions,
} from '../internal/body.js';

import {
  rateLimitHeaders, resolveClientAddress, resolveTrustedProxies, spendRequestLimit,
  type ClientAddress, type RateLimitMiddlewareOptions, type RateLimitRefusal, type RateLimitResult,
  type RateLimitStore, type TrustedProxies,
} from '../rate-limit/index.js';

export { DEFAULT_MAX_BODY_BYTES, type BodyProblem, type JsonBody, type ReadBodyLimits, type ReadJsonBodyOptions } from '../internal/body.js';

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

// ---------------------------------------------------------------------------------------
// Request bodies

export interface DrainOptions {
  /**
   * How long to keep discarding a body the client is still sending before the connection is
   * closed. 5000 ms; `0` closes it at once (the client may then see a reset, not the response).
   */
  readonly lingerMs?: number;
}

export const DEFAULT_DRAIN_LINGER_MS = 5_000;

/**
 * Discard the rest of a request body so the response already sent (or about to be) reaches a
 * client that is still uploading: a server that stops reading leaves that client blocked on its
 * write, and it sees a stalled or reset connection instead of the answer. Use it after refusing
 * a request without reading its body (401, 404, 413, 415). The upload is not waited for: if it
 * has not ended after `lingerMs`, the request is destroyed.
 */
export function drainRequest(req: IncomingMessage, options: DrainOptions = {}): void {
  if (req.destroyed || req.complete) return;
  const lingerMs = options.lingerMs ?? DEFAULT_DRAIN_LINGER_MS;
  if (!(lingerMs > 0)) {
    req.destroy();
    return;
  }
  const timer = setTimeout(() => { req.destroy(); }, lingerMs);
  timer.unref();
  const done = (): void => { clearTimeout(timer); };
  req.once('end', done);
  req.once('close', done);
  // Nothing is listening for the body any more; without a handler a late socket error would throw.
  req.on('error', () => undefined);
  req.resume();
}

export interface NodeReadBodyOptions extends ReadBodyLimits, DrainOptions {}

/**
 * The request body as bytes, at most `maxBytes` (1 MiB). The limit is enforced while streaming,
 * so it holds without a `content-length` and against a wrong one; a declared length over the
 * limit is refused before anything is read. An oversized body is answered and then drained: the
 * 413 is thrown at once, so the handler can respond while the client is still uploading, and
 * the rest of the upload is discarded in the background for up to `lingerMs` (see
 * `drainRequest()`). Throws a `HiveError`: 413 `too_large`, or 400 `request_aborted` when the
 * client went away mid-body.
 */
export function readBody(req: IncomingMessage, options: NodeReadBodyOptions = {}): Promise<Buffer> {
  const maxBytes = maxBodyBytes(options);
  const declared = declaredLength(req.headers['content-length']);
  if (declared !== undefined && declared > maxBytes) {
    drainRequest(req, options);
    return Promise.reject(bodyError('too_large', options, { maxBytes }));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('close', onGone);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        cleanup();
        chunks.length = 0;
        drainRequest(req, options);
        reject(bodyError('too_large', options, { maxBytes }));
      } else chunks.push(buffer);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    // An error, or 'close' without 'end': the client went away before the body was complete.
    const onGone = (): void => {
      cleanup();
      reject(bodyError('aborted', options));
    };
    if (req.readableEnded) {
      resolve(Buffer.alloc(0));
      return;
    }
    if (req.destroyed) {
      reject(bodyError('aborted', options));
      return;
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onGone);
    req.once('close', onGone);
  });
}

export interface NodeReadJsonBodyOptions extends ReadJsonBodyOptions, DrainOptions {}

/**
 * Read and parse a JSON request body within `maxBytes` (see `readBody()` for the limit and the
 * answer-then-drain behaviour). Throws a `HiveError`: 413 `too_large`, 415
 * `unsupported_media_type` (by default only when there is a body; see `requireContentType`),
 * 400 `invalid_json` for a body that does not parse or is empty (unless `emptyValue` is set).
 * Returns the parsed `value` with the raw `text`.
 */
export async function readJsonBody(req: IncomingMessage, options: NodeReadJsonBodyOptions = {}): Promise<JsonBody> {
  const contentType = req.headers['content-type'];
  try {
    checkContentTypeFirst(contentType, options);
  } catch (error) {
    drainRequest(req, options);
    throw error;
  }
  return parseJsonBody(await readBody(req, options), contentType, options);
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

// ---------------------------------------------------------------------------------------
// Client address and rate limiting

/** The client address of `req`, believing `X-Forwarded-For` only from `trusted` proxies. */
export function clientAddressOf(req: IncomingMessage, trusted: TrustedProxies): ClientAddress {
  return resolveClientAddress({ peer: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'], trusted });
}

export interface NodeRateLimitOptions extends Omit<RateLimitMiddlewareOptions, 'limiter'> {
  /**
   * The limiter (or shared store) to spend from, or a function choosing it per request. A
   * function that returns undefined lets the request through unlimited.
   */
  readonly limiter: RateLimitStore | ((req: IncomingMessage) => RateLimitStore | undefined);
  /**
   * Answer a refusal in the product's own shape instead of throwing the 429 `HiveError`. Used
   * when the limit is called with `res`: the refusal's headers are set on `res` first, then this
   * writes the response, and the call returns the outcome with `refusal` set, so the handler
   * must stop there. Without `res` the 429 is thrown as before.
   */
  readonly respond?: (req: IncomingMessage, res: ServerResponse, refusal: RateLimitRefusal) => void | Promise<void>;
  /** The key after `prefix`. By default the client address (`addressKey()`); undefined lets the request through. */
  readonly key?: (req: IncomingMessage, client: ClientAddress) => string | undefined | Promise<string | undefined>;
  /** Tokens a request spends. 1. */
  readonly cost?: number | ((req: IncomingMessage) => number);
}

export interface NodeRateLimit {
  /**
   * Spend for one request. Throws a 429 `HiveError` (`rate_limited`, `Retry-After`,
   * `details.retryAfterSeconds`) when refused: inside `hiveHandler()` it is answered as the
   * envelope. Returns the client and the result (undefined when `key` or `limiter` skipped the
   * request). With `respond` and `res`, a refusal is answered instead and returned as `refusal`.
   */
  (req: IncomingMessage, res?: ServerResponse): Promise<{ readonly client: ClientAddress; readonly result: RateLimitResult | undefined; readonly refusal?: RateLimitRefusal }>;
}

/**
 * A per-request rate limit for `node:http` handlers.
 *
 *   const limit = rateLimit({ limiter: createRateLimiter({ limit: 10, windowMs: 60_000 }), trustedProxies: process.env.TRUSTED_PROXIES });
 *   createServer(hiveHandler(async (req, res) => { await limit(req, res); ... }));
 */
export function rateLimit(options: NodeRateLimitOptions): NodeRateLimit {
  const trusted = resolveTrustedProxies(options.trustedProxies);
  const { limiter, respond } = options;
  return async (req, res) => {
    const store = typeof limiter === 'function' ? limiter(req) : limiter;
    const cost = store && typeof options.cost === 'function' ? options.cost(req) : options.cost as number | undefined;
    const outcome = await spendRequestLimit(
      store, options, trusted,
      { peer: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'] },
      options.key ? client => (options.key as NonNullable<NodeRateLimitOptions['key']>)(req, client) : undefined,
      cost,
    );
    const { client, result, refusal } = outcome;
    if (refusal) {
      if (!respond || !res) throw refusal.error;
      if (!res.headersSent) for (const [name, value] of Object.entries(refusal.headers)) res.setHeader(name, value);
      await respond(req, res, refusal);
      return outcome;
    }
    if (result && options.headers && res && !res.headersSent) {
      for (const [name, value] of Object.entries(rateLimitHeaders(result))) res.setHeader(name, value);
    }
    return { client, result };
  };
}
