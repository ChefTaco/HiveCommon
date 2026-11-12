/**
 * `/health/live` and `/health/ready` responses with named, time-limited dependency checks.
 * Framework-free: adapters in `/hono` and `/node-http` serve these.
 */

export const HEALTH_PATHS = { live: '/health/live', ready: '/health/ready' } as const;

/** Paths products used before the suite standard. Serve them only while clients still call them. */
export const LEGACY_HEALTH_ALIASES: Readonly<Record<HealthKind, readonly string[]>> = {
  live: ['/health', '/healthz', '/livez', '/live', '/api/health'],
  ready: ['/ready', '/readyz'],
};

export type HealthKind = 'live' | 'ready';

export type CheckStatus = 'up' | 'down';

/** What a check function may return. Throwing, `false` or `{ ok: false }` all mean down. */
export type CheckOutcome = void | boolean | { readonly ok?: boolean; readonly details?: Readonly<Record<string, unknown>> };

export interface HealthCheck {
  /** Shown in the response, for example `database` or `oathweave`. */
  readonly name: string;
  /** Receives a signal that aborts at the timeout; pass it to fetch and database calls. */
  readonly check: (signal: AbortSignal) => CheckOutcome | Promise<CheckOutcome>;
  /** Milliseconds before the check counts as down. Defaults to the readiness default. */
  readonly timeoutMs?: number;
  /** A non-critical check that fails makes the service `degraded`, still 200. Defaults to true. */
  readonly critical?: boolean;
}

export interface CheckReport {
  readonly status: CheckStatus;
  readonly critical: boolean;
  readonly latencyMs: number;
  /** `timeout` or `failed`, or the error message when `exposeErrors` is on. */
  readonly error?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface LiveBody {
  readonly status: 'live';
  readonly service?: string;
  readonly version?: string;
  readonly time: string;
}

export interface ReadyBody {
  readonly status: 'ready' | 'degraded' | 'not_ready';
  readonly service?: string;
  readonly version?: string;
  readonly time: string;
  readonly checks: Readonly<Record<string, CheckReport>>;
}

export interface HealthResponse<B> {
  readonly status: 200 | 503;
  readonly body: B;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HealthOptions {
  readonly service?: string;
  readonly version?: string;
  readonly checks?: readonly HealthCheck[];
  /** Default per-check timeout. 2000 ms. */
  readonly timeoutMs?: number;
  /**
   * Include error messages from failing checks. Off by default: readiness is often reachable
   * without authentication, and error messages can name internal hosts.
   */
  readonly exposeErrors?: boolean;
  /** Also serve the legacy paths in `LEGACY_HEALTH_ALIASES`, or a custom alias map. */
  readonly aliases?: boolean | Partial<Readonly<Record<HealthKind, readonly string[]>>>;
  readonly now?: () => number;
}

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

function identity(options: HealthOptions): { service?: string; version?: string } {
  return { ...(options.service ? { service: options.service } : {}), ...(options.version ? { version: options.version } : {}) };
}

/** The liveness response: 200 whenever the process can answer. It never runs checks. */
export function liveness(options: HealthOptions = {}): HealthResponse<LiveBody> {
  const now = options.now ?? Date.now;
  return { status: 200, body: { status: 'live', ...identity(options), time: new Date(now()).toISOString() }, headers: HEADERS };
}

class CheckTimeout extends Error {}

async function runCheck(check: HealthCheck, defaultTimeout: number, exposeErrors: boolean, now: () => number): Promise<CheckReport> {
  const critical = check.critical ?? true;
  const timeoutMs = check.timeoutMs ?? defaultTimeout;
  const controller = new AbortController();
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new CheckTimeout('timeout'));
      reject(new CheckTimeout('timeout'));
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([Promise.resolve().then(() => check.check(controller.signal)), timeout]);
    const latencyMs = Math.max(0, now() - started);
    const ok = outcome === undefined || outcome === true || (typeof outcome === 'object' && outcome !== null && outcome.ok !== false);
    const details = typeof outcome === 'object' && outcome !== null ? outcome.details : undefined;
    return { status: ok ? 'up' : 'down', critical, latencyMs, ...(ok ? {} : { error: 'failed' }), ...(details ? { details } : {}) };
  } catch (error) {
    const latencyMs = Math.max(0, now() - started);
    const reason = error instanceof CheckTimeout ? 'timeout' : exposeErrors && error instanceof Error && error.message ? error.message.slice(0, 300) : 'failed';
    return { status: 'down', critical, latencyMs, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Run every check concurrently and build the readiness response: 503 if a critical check is down. */
export async function readiness(options: HealthOptions = {}): Promise<HealthResponse<ReadyBody>> {
  const now = options.now ?? Date.now;
  const checks = options.checks ?? [];
  const names = new Set<string>();
  for (const check of checks) {
    if (!check.name || names.has(check.name)) throw new Error(`Health check names must be unique and non-empty: ${check.name}`);
    names.add(check.name);
  }
  const reports = await Promise.all(checks.map(check => runCheck(check, options.timeoutMs ?? 2000, options.exposeErrors ?? false, now)));
  const byName: Record<string, CheckReport> = {};
  checks.forEach((check, index) => { byName[check.name] = reports[index] as CheckReport; });
  const criticalDown = reports.some(report => report.status === 'down' && report.critical);
  const anyDown = reports.some(report => report.status === 'down');
  const status = criticalDown ? 'not_ready' : anyDown ? 'degraded' : 'ready';
  return {
    status: criticalDown ? 503 : 200,
    body: { status, ...identity(options), time: new Date(now()).toISOString(), checks: byName },
    headers: HEADERS,
  };
}

/** Which health endpoint a path names, including legacy aliases when enabled. */
export function resolveHealthPath(pathname: string, aliases: HealthOptions['aliases'] = false): HealthKind | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === HEALTH_PATHS.live) return 'live';
  if (path === HEALTH_PATHS.ready) return 'ready';
  const map = aliasMap(aliases);
  if (map.live.includes(path)) return 'live';
  if (map.ready.includes(path)) return 'ready';
  return undefined;
}

/** All paths served for each kind, standard first. */
export function healthPaths(aliases: HealthOptions['aliases'] = false): Readonly<Record<HealthKind, readonly string[]>> {
  const map = aliasMap(aliases);
  return { live: [HEALTH_PATHS.live, ...map.live], ready: [HEALTH_PATHS.ready, ...map.ready] };
}

function aliasMap(aliases: HealthOptions['aliases']): Record<HealthKind, readonly string[]> {
  if (aliases === true) return { live: LEGACY_HEALTH_ALIASES.live, ready: LEGACY_HEALTH_ALIASES.ready };
  if (!aliases) return { live: [], ready: [] };
  return { live: aliases.live ?? [], ready: aliases.ready ?? [] };
}

export interface Health {
  live(): HealthResponse<LiveBody>;
  ready(): Promise<HealthResponse<ReadyBody>>;
  /** The response for a health path, or undefined when the path is not a health path. */
  handle(pathname: string): Promise<HealthResponse<LiveBody | ReadyBody>> | undefined;
  readonly paths: Readonly<Record<HealthKind, readonly string[]>>;
}

/** Bind options once and serve both endpoints. */
export function createHealth(options: HealthOptions = {}): Health {
  return {
    live: () => liveness(options),
    ready: () => readiness(options),
    handle(pathname) {
      const kind = resolveHealthPath(pathname, options.aliases);
      if (kind === 'live') return Promise.resolve(liveness(options));
      if (kind === 'ready') return readiness(options);
      return undefined;
    },
    paths: healthPaths(options.aliases),
  };
}
