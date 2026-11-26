/**
 * Follow Oathweave's session revocation feed and drop the verifier's cached session answers as
 * soon as a session ends, instead of when the cache entry expires.
 *
 * Oathweave serves revocations as HiveEvent v1 at `GET /api/v1/hive/events`:
 *
 * - `session.revoked`, `sourceRef` `session:<sid>`: one session ended. `<sid>` is the tokens'
 *   `sid` / `sessionId` claim, so the follower calls `verifier.invalidateSession(sid)`.
 * - `user.sessions_revoked`, `sourceRef` `user:<sub>`: every session of a user ended, so the
 *   follower calls `verifier.invalidateSubject(sub)`.
 *
 * The feed only shortens how long a revoked session's cached answer lives. Missing it never
 * accepts anything: an answer still expires after the verifier's `sessionCacheTtlMs`.
 */
import type { HiveEvent } from '../contracts/index.js';
import { HiveEventFeedError, readHiveEventFeed, type HiveEventFeedFetch } from '../feed/index.js';
import { backoffDelay, sleepAbortable, type RetryPolicy } from '../retry/index.js';
import { endpointProblem } from './endpoint.js';
import type { ServiceTokenProvider } from './service-token.js';
import type { OathweaveVerifier } from './verifier.js';

/** Oathweave's product ID; events from any other product in the feed are ignored. */
export const OATHWEAVE_PRODUCT_ID = 'oathweave';
/** The feed's path on an Oathweave server. */
export const OATHWEAVE_REVOCATIONS_PATH = '/api/v1/hive/events';
export const OATHWEAVE_SESSION_REVOKED = 'session.revoked';
export const OATHWEAVE_USER_SESSIONS_REVOKED = 'user.sessions_revoked';
/** Time between polls once the feed is caught up: 2000 ms. */
export const OATHWEAVE_REVOCATION_POLL_MS = 2_000;
/** Backoff after failed polls: 1 s doubling to 60 s, with equal jitter. */
export const OATHWEAVE_REVOCATION_RETRY_POLICY: RetryPolicy = { maxAttempts: Number.POSITIVE_INFINITY, baseMs: 1_000, maxMs: 60_000, jitter: 'equal' };
/** Deadline for one page request: 10 000 ms. */
export const OATHWEAVE_REVOCATION_TIMEOUT_MS = 10_000;

/** What one revocation event asks the verifier to forget. */
export type OathweaveRevocation =
  | { readonly kind: 'session'; readonly sessionId: string; readonly subject: string | undefined }
  | { readonly kind: 'subject'; readonly subject: string };

/**
 * The revocation an Oathweave HiveEvent describes; undefined for anything else (another product,
 * another type, a `sourceRef` that does not name a session or user).
 */
export function parseOathweaveRevocation(event: HiveEvent): OathweaveRevocation | undefined {
  if (event.product !== OATHWEAVE_PRODUCT_ID || event.sourceRef === undefined) return undefined;
  if (event.type === OATHWEAVE_SESSION_REVOKED && event.sourceRef.startsWith('session:')) {
    const sessionId = event.sourceRef.slice('session:'.length);
    return sessionId ? { kind: 'session', sessionId, subject: event.subject?.actorId } : undefined;
  }
  if (event.type === OATHWEAVE_USER_SESSIONS_REVOKED && event.sourceRef.startsWith('user:')) {
    const subject = event.sourceRef.slice('user:'.length);
    return subject ? { kind: 'subject', subject } : undefined;
  }
  return undefined;
}

/** Where the follower got to; persist `cursor` to resume after a restart. */
export interface OathweaveRevocationPoll {
  /** Revocations applied by this poll. */
  readonly applied: number;
  /** Pages read by this poll. */
  readonly pages: number;
  /** The cursor to resume from. */
  readonly cursor: string | null;
}

export interface FollowOathweaveRevocationsOptions {
  /** The verifier whose cached session answers are dropped. */
  readonly verifier: Pick<OathweaveVerifier, 'invalidateSession' | 'invalidateSubject'>;
  /** The feed: `<Oathweave URL>/api/v1/hive/events`. https only (see `allowInsecureLoopback`). */
  readonly feedUrl: string;
  /**
   * The bearer token for the feed: a service token provider (`createServiceTokenProvider()`, for
   * a machine client whose policy grants `iam:tokens:introspect`) or a function. A provider's
   * `invalidate()` is called when the feed answers 401.
   */
  readonly tokenProvider: Pick<ServiceTokenProvider, 'token'> & Partial<Pick<ServiceTokenProvider, 'invalidate'>> | (() => string | Promise<string>);
  /** The cursor to start after when `loadCursor` gives none. Unset: the oldest retained event. */
  readonly after?: string | null | undefined;
  /** Read a saved cursor once, before the first poll. */
  readonly loadCursor?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Called with the new cursor whenever it moves (and with null after a reset). Failures are reported, not fatal. */
  readonly saveCursor?: (cursor: string | null) => void | Promise<void>;
  /** Called after each applied revocation, with the number of cache entries it dropped. */
  readonly onRevocation?: (revocation: OathweaveRevocation, dropped: number, event: HiveEvent) => void;
  /** Called for each failed poll or cursor save. Errors carry no token. */
  readonly onError?: (error: unknown) => void;
  /** Stops following. */
  readonly signal?: AbortSignal;
  /** Time between polls once caught up. `OATHWEAVE_REVOCATION_POLL_MS`. */
  readonly intervalMs?: number;
  /** Backoff after failed polls. `OATHWEAVE_REVOCATION_RETRY_POLICY`. */
  readonly policy?: RetryPolicy;
  /** Events per page. 200. */
  readonly limit?: number;
  /** Pages one poll reads before it yields. 50. */
  readonly maxPagesPerPoll?: number;
  /** Deadline for one page request. `OATHWEAVE_REVOCATION_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Allow `http:` on loopback, for tests. */
  readonly allowInsecureLoopback?: boolean;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface OathweaveRevocationFollower {
  /** Poll now, outside the schedule. Concurrent calls share one poll. */
  poll(): Promise<OathweaveRevocationPoll>;
  /** Stop following. The current request is aborted. */
  stop(): void;
  /** Settles once following has stopped. Never rejects. */
  readonly done: Promise<void>;
  /** The cursor the next poll starts after. */
  readonly cursor: string | null;
  readonly stopped: boolean;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/**
 * Follow Oathweave's revocation feed in the background and call the verifier's
 * `invalidateSession()` / `invalidateSubject()` for every revocation. Polls every `intervalMs`
 * once caught up and backs off after failures; it never stops on its own, only through `stop()`
 * or `signal`.
 *
 * The last page of a feed has no `nextCursor`, so the follower keeps the cursor before that page
 * and remembers the event IDs it already applied from it. After a restart from a saved cursor it
 * applies that page again, which is harmless: dropping a cache entry twice changes nothing.
 */
export function followOathweaveRevocations(options: FollowOathweaveRevocationsOptions): OathweaveRevocationFollower {
  const problem = endpointProblem(options.feedUrl, { allowInsecureLoopback: options.allowInsecureLoopback ?? false });
  if (problem) throw new TypeError(`Oathweave feedUrl ${problem}`);
  const intervalMs = options.intervalMs ?? OATHWEAVE_REVOCATION_POLL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new RangeError('intervalMs must be a non-negative number');
  const limit = positive(options.limit, 200, 'limit');
  const maxPagesPerPoll = positive(options.maxPagesPerPoll, 50, 'maxPagesPerPoll');
  const timeoutMs = positive(options.timeoutMs, OATHWEAVE_REVOCATION_TIMEOUT_MS, 'timeoutMs');
  const policy = options.policy ?? OATHWEAVE_REVOCATION_RETRY_POLICY;
  const request: HiveEventFeedFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? sleepAbortable;
  const provider = options.tokenProvider;
  const token = typeof provider === 'function' ? provider : () => provider.token();
  const invalidateToken = typeof provider === 'function' ? undefined : provider.invalidate?.bind(provider);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  let cursor: string | null = options.after || null;
  let loaded = !options.loadCursor;
  /** IDs applied from the events after `cursor` (the trailing page). */
  let seen = new Set<string>();
  let current: Promise<OathweaveRevocationPoll> | undefined;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A failing error handler must not stop the follower.
    }
  };

  async function moveCursor(next: string | null): Promise<void> {
    cursor = next;
    seen = new Set();
    if (!options.saveCursor) return;
    try {
      await options.saveCursor(next);
    } catch (error) {
      report(error);
    }
  }

  function apply(event: HiveEvent): boolean {
    const revocation = parseOathweaveRevocation(event);
    if (!revocation) return false;
    const dropped = revocation.kind === 'session'
      ? options.verifier.invalidateSession(revocation.sessionId)
      : options.verifier.invalidateSubject(revocation.subject);
    try {
      options.onRevocation?.(revocation, dropped, event);
    } catch (error) {
      report(error);
    }
    return true;
  }

  async function runPoll(): Promise<OathweaveRevocationPoll> {
    if (!loaded) {
      const saved = await options.loadCursor?.();
      loaded = true;
      if (saved) cursor = saved;
    }
    let applied = 0;
    let pages = 0;
    while (pages < maxPagesPerPoll) {
      const bearer = await token();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      let result;
      try {
        result = await readHiveEventFeed(request, options.feedUrl, {
          after: cursor,
          limit,
          maxPages: 1,
          product: OATHWEAVE_PRODUCT_ID,
          headers: { authorization: `Bearer ${bearer}` },
          signal,
        });
      } catch (error) {
        if (error instanceof HiveEventFeedError && error.kind === 'status') {
          if (error.status === 401) invalidateToken?.();
          // A cursor the feed no longer reads (a restored database): start again from the
          // oldest retained event. Applying old revocations again only drops cache entries.
          if (error.status === 400 && cursor !== null) await moveCursor(null);
        }
        throw error;
      }
      pages++;
      for (const event of result.events) {
        if (seen.has(event.id)) continue;
        if (apply(event)) applied++;
        seen.add(event.id);
      }
      if (result.caughtUp) break;
      await moveCursor(result.cursor);
    }
    return { applied, pages, cursor };
  }

  function poll(): Promise<OathweaveRevocationPoll> {
    if (controller.signal.aborted) return Promise.reject(new Error('The revocation follower is stopped'));
    current ??= runPoll().finally(() => { current = undefined; });
    return current;
  }

  async function loop(): Promise<void> {
    let failures = 0;
    while (!controller.signal.aborted) {
      let wait = intervalMs;
      try {
        await poll();
        failures = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        report(error);
        failures++;
        wait = backoffDelay(failures, policy, options.random ? { random: options.random } : {}) ?? policy.maxMs;
      }
      try {
        await sleep(wait, controller.signal);
      } catch {
        break;
      }
    }
  }

  function stop(): void {
    controller.abort();
    options.signal?.removeEventListener('abort', onAbort);
  }

  const done = loop().catch(report).finally(stop);
  return {
    poll,
    stop,
    done,
    get cursor() { return cursor; },
    get stopped() { return controller.signal.aborted; },
  };
}
