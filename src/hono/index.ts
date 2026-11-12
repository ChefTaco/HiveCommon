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
import {
  createRequestContext,
  runWithRequestContext,
  type CreateRequestContextOptions,
  type RequestContext,
} from '../context/index.js';
import { defaultCodeForStatus, defaultMessageForStatus, HiveError, toErrorResponse } from '../errors/index.js';
import { createHealth, type HealthOptions } from '../health/index.js';
import type { Logger } from '../log/index.js';
import type { AcceptPrincipal, OathweavePrincipal } from '../oathweave/claims.js';
import { OathweaveError } from '../oathweave/errors.js';
import { hasAnyRole, hasScopes, requirePermissions, type PermissionOptions } from '../oathweave/links.js';
import type { OathweaveVerifier } from '../oathweave/verifier.js';

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
  return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
}

/** `app.onError(errorHandler())`: HiveError → envelope; everything else → generic 500, logged. */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  return (error, c) => respond(c, error, options);
}

/** `app.notFound(notFoundHandler())`: a 404 envelope. */
export function notFoundHandler(): NotFoundHandler {
  return c => respond(c, HiveError.notFound(), {});
}

/** Serve `/health/live`, `/health/ready` and any aliases on `app` (GET and HEAD). */
export function registerHealthRoutes<E extends Env>(app: Hono<E>, options: HealthOptions = {}): void {
  const health = createHealth(options);
  const serve = (kind: 'live' | 'ready') => async (c: Context<E>): Promise<Response> => {
    const result = kind === 'live' ? health.live() : await health.ready();
    return new Response(c.req.method === 'HEAD' ? null : JSON.stringify(result.body), { status: result.status, headers: result.headers });
  };
  for (const path of health.paths.live) app.get(path, serve('live'));
  for (const path of health.paths.ready) app.get(path, serve('ready'));
}
