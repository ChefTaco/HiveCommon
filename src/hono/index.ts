/**
 * Hono adapters: request context, Oathweave auth, the error envelope and health routes.
 * `hono` is an optional peer dependency (>= 4.13.18).
 *
 *   const app = new Hono<HiveEnv>();
 *   app.use(requestContext());
 *   registerHealthRoutes(app, { checks });
 *   app.use('/v1/*', oathweaveAuth(verifier));
 *   app.onError(errorHandler({ logger }));
 *   app.notFound(notFoundHandler());
 */
import type { Context, Env, ErrorHandler, Hono, MiddlewareHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  createRequestContext,
  runWithRequestContext,
  type CreateRequestContextOptions,
  type RequestContext,
} from '../context/index.js';
import { defaultCodeForStatus, defaultMessageForStatus, HiveError, toErrorResponse } from '../errors/index.js';
import { createHealth, type HealthOptions, type LiveBody } from '../health/index.js';
import type { Logger } from '../log/index.js';
import type { AcceptPrincipal, OathweavePrincipal } from '../oathweave/claims.js';
import { OathweaveError } from '../oathweave/errors.js';
import { hasAnyRole, hasScopes, requirePermissions, type PermissionOptions } from '../oathweave/links.js';
import type { OathweaveVerifier } from '../oathweave/verifier.js';
import { readStreamBounded } from '../fetch/index.js';
import {
  bodyError, checkContentTypeFirst, declaredLength, maxBodyBytes, parseJsonBody,
  type JsonBody, type ReadBodyLimits, type ReadJsonBodyOptions,
} from '../internal/body.js';

export { DEFAULT_MAX_BODY_BYTES, type BodyProblem, type JsonBody, type ReadBodyLimits, type ReadJsonBodyOptions } from '../internal/body.js';

/** Context variables set by these middlewares. Use `new Hono<HiveEnv>()` or extend it. */
export interface HiveVariables {
  hiveContext: RequestContext;
  hivePrincipal: OathweavePrincipal;
}
export interface HiveEnv extends Env {
  Variables: HiveVariables;
}

/** The request context set by `requestContext()`, or undefined. */
export function getHiveContext(c: Context): RequestContext | undefined {
  return (c as Context<HiveEnv>).get('hiveContext') as RequestContext | undefined;
}

/** The verified principal set by `oathweaveAuth()`, or undefined. */
export function getPrincipal(c: Context): OathweavePrincipal | undefined {
  return (c as Context<HiveEnv>).get('hivePrincipal') as OathweavePrincipal | undefined;
}

/** The verified principal, or a 401 when the route was not authenticated. */
export function requirePrincipal(c: Context): OathweavePrincipal {
  const principal = getPrincipal(c);
  if (!principal) throw new OathweaveError('missing_token');
  return principal;
}

export interface RequestContextMiddlewareOptions extends CreateRequestContextOptions {
  /** Echo the request ID as `x-request-id` on the response. Defaults to true. */
  readonly responseHeader?: boolean;
}

/** Create the request context, run the rest of the request inside it and echo `x-request-id`. */
export function requestContext(options: RequestContextMiddlewareOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const context = createRequestContext(name => c.req.header(name), options);
    c.set('hiveContext' as never, context as never);
    await runWithRequestContext(context, next);
    if (options.responseHeader ?? true) c.header('x-request-id', context.requestId);
  };
}

export interface OathweaveAuthOptions {
  /** Which principals this route accepts. Defaults to the verifier's default. */
  readonly accept?: AcceptPrincipal;
  /** When false, a request without credentials passes with no principal; a bad token still fails. */
  readonly required?: boolean;
  /** Further checks after verification, such as an identity-link lookup. Throw to refuse. */
  readonly authorize?: (principal: OathweavePrincipal, c: Context) => void | Promise<void>;
}

/** Verify `Authorization: Bearer` with Oathweave and set `hivePrincipal`. Failures throw OathweaveError. */
export function oathweaveAuth(verifier: OathweaveVerifier, options: OathweaveAuthOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header && options.required === false) {
      await next();
      return;
    }
    const principal = await verifier.verifyAuthorization(header, options.accept ? { accept: options.accept } : {});
    await options.authorize?.(principal, c);
    c.set('hivePrincipal' as never, principal as never);
    const context = getHiveContext(c);
    if (context) context.principal = principal;
    await next();
  };
}

/** Require every listed permission (403 otherwise). Must follow `oathweaveAuth()`. */
export function requirePermission(permissions: readonly string[], options: PermissionOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    requirePermissions(requirePrincipal(c), permissions, options);
    await next();
  };
}

/** Require at least one listed role (403 otherwise). Must follow `oathweaveAuth()`. */
export function requireRole(roles: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!hasAnyRole(requirePrincipal(c), roles)) throw new OathweaveError('insufficient_permission', { details: { roles: [...roles] } });
    await next();
  };
}

/** Require every listed scope (403 otherwise). Must follow `oathweaveAuth()`. */
export function requireScope(scopes: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!hasScopes(requirePrincipal(c), scopes)) throw new OathweaveError('insufficient_permission', { details: { scopes: [...scopes] } });
    await next();
  };
}

export interface ErrorHandlerOptions {
  /** Unexpected errors (not HiveError) are logged here at error level. */
  readonly logger?: Pick<Logger, 'error'>;
}

function respond(c: Context, error: unknown, options: ErrorHandlerOptions): Response {
  const requestId = getHiveContext(c)?.requestId;
  let value = error;
  // Hono's own HTTPException (body limits, bad JSON, etc.) keeps its status with a standard code.
  if (!HiveError.is(error) && error instanceof HTTPException && error.status >= 400 && error.status <= 599) {
    const message = error.status >= 500 || !error.message ? defaultMessageForStatus(error.status) : error.message;
    value = new HiveError(defaultCodeForStatus(error.status), message, { status: error.status, cause: error });
  }
  const response = toErrorResponse(value, {
    requestId,
    onUnexpected: unexpected => options.logger?.error('unhandled error', { err: unexpected, path: c.req.path, method: c.req.method }),
  });
  // Through the context, like the health routes, so headers set earlier in the request survive.
  return c.body(JSON.stringify(response.body), response.status as ContentfulStatusCode, response.headers);
}

/** `app.onError(errorHandler())`: HiveError → envelope; everything else → generic 500, logged. */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  return (error, c) => respond(c, error, options);
}

/** `app.notFound(notFoundHandler())`: a 404 envelope. */
export function notFoundHandler(): NotFoundHandler {
  return c => respond(c, HiveError.notFound(), {});
}

/**
 * Serve `/health/live`, `/health/ready` and any aliases on `app` (GET and HEAD). Set
 * `liveBody` to keep a product's published liveness body.
 */
export function registerHealthRoutes<E extends Env, L extends object = LiveBody>(app: Hono<E>, options: HealthOptions<L> = {}): void {
  const health = createHealth(options);
  const serve = (kind: 'live' | 'ready') => async (c: Context<E>): Promise<Response> => {
    const result = kind === 'live' ? health.live() : await health.ready();
    // Respond through the context so headers set earlier in the request (c.header()) survive.
    return c.req.method === 'HEAD' ? c.body(null, result.status, result.headers) : c.body(JSON.stringify(result.body), result.status, result.headers);
  };
  for (const path of health.paths.live) app.get(path, serve('live'));
  for (const path of health.paths.ready) app.get(path, serve('ready'));
}

// ---------------------------------------------------------------------------------------
// Request bodies

function rawRequest(source: Context | Request): Request {
  return source instanceof Request ? source : source.req.raw;
}

/**
 * The request body as bytes, at most `maxBytes` (1 MiB), from a Hono context or a fetch
 * `Request`. The limit is enforced while streaming, so it holds without a `content-length` and
 * against a wrong one; a declared length over the limit is refused before anything is read, and
 * the rest of an oversized body is cancelled, never buffered. Throws a `HiveError`: 413
 * `too_large`, or 400 `request_aborted` when the body stream fails. The body can be read once:
 * do not combine it with `c.req.json()`.
 */
export async function readBody(source: Context | Request, options: ReadBodyLimits = {}): Promise<Uint8Array> {
  const maxBytes = maxBodyBytes(options);
  const request = rawRequest(source);
  const declared = declaredLength(request.headers.get('content-length'));
  if (declared !== undefined && declared > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw bodyError('too_large', options, { maxBytes });
  }
  if (!request.body) return new Uint8Array();
  const tooLarge = bodyError('too_large', options, { maxBytes });
  try {
    return await readStreamBounded(request.body, maxBytes, () => tooLarge);
  } catch (error) {
    if (error === tooLarge) throw error;
    throw bodyError('aborted', options);
  }
}

/**
 * Read and parse a JSON request body within `maxBytes`, from a Hono context or a fetch
 * `Request`. Throws a `HiveError`: 413 `too_large`, 415 `unsupported_media_type` (by default
 * only when there is a body; see `requireContentType`), 400 `invalid_json` for a body that does
 * not parse or is empty (unless `emptyValue` is set). Returns the parsed `value` with the raw
 * `text`.
 */
export async function readJsonBody(source: Context | Request, options: ReadJsonBodyOptions = {}): Promise<JsonBody> {
  const request = rawRequest(source);
  const contentType = request.headers.get('content-type');
  checkContentTypeFirst(contentType, options);
  return parseJsonBody(await readBody(request, options), contentType, options);
}

// ---------------------------------------------------------------------------------------
// Security headers

export interface SecurityHeadersOptions {
  /** `X-Content-Type-Options`. `nosniff`; false omits it. */
  readonly contentTypeOptions?: string | false;
  /** `Referrer-Policy`. `no-referrer`; false omits it. */
  readonly referrerPolicy?: string | false;
  /** `X-Frame-Options`. `DENY`; false omits it. */
  readonly frameOptions?: string | false;
  /**
   * More headers, such as `Content-Security-Policy` or `Permissions-Policy`: a record, or a
   * function of the context for values that depend on the request. A false or undefined value
   * omits that header; a name given here replaces the same default.
   */
  readonly headers?: SecurityHeaderMap | ((c: Context) => SecurityHeaderMap);
  /**
   * When the headers are set. `before` (the default) sets them before the handler runs, so a
   * handler can still change one for its own response. `after` sets them once the handler is
   * done, replacing whatever it set.
   */
  readonly apply?: 'before' | 'after';
}

export type SecurityHeaderMap = Readonly<Record<string, string | false | undefined>>;

/**
 * Set the baseline response headers every suite API sends: `X-Content-Type-Options: nosniff`,
 * `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. Register it first, so error and
 * not-found responses carry them too.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const base: Record<string, string | false | undefined> = {
    'X-Content-Type-Options': options.contentTypeOptions ?? 'nosniff',
    'Referrer-Policy': options.referrerPolicy ?? 'no-referrer',
    'X-Frame-Options': options.frameOptions ?? 'DENY',
  };
  const set = (c: Context): void => {
    const extra = typeof options.headers === 'function' ? options.headers(c) : options.headers ?? {};
    const merged = new Map<string, readonly [name: string, value: string | false | undefined]>();
    for (const [name, value] of [...Object.entries(base), ...Object.entries(extra)]) merged.set(name.toLowerCase(), [name, value]);
    for (const [name, value] of merged.values()) if (typeof value === 'string' && value) c.header(name, value);
  };
  return async (c, next) => {
    if (options.apply === 'after') {
      await next();
      set(c);
    } else {
      set(c);
      await next();
    }
  };
}
