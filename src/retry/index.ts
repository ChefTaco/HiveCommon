/**
 * Retry and deadline helpers shared across the suite.
 *
 * Isomorphic: no Node built-ins and no runtime dependencies.
 *
 * These helpers decide *when* another attempt may start. Whether an operation may be repeated
 * at all — no effect happened, or an idempotency or reconciliation contract makes repetition
 * safe — is decided by the owning runtime or adapter, which passes that knowledge in as
 * `effect`. An operation whose effect is unknown is never retried.
 */
import { readHeader, retryAfterMs, type HeaderSource } from '../contracts/index.js';

/** Response header a layer sets to say whether it already retried: `exhausted` or `none`. */
export const RETRY_HEADER = 'x-hive-retry';
export type RetrySignal = 'exhausted' | 'none';

/** The retry signal on a response, or undefined when the peer did not send one. */
export function readRetrySignal(headers: HeaderSource): RetrySignal | undefined {
  const value = readHeader(headers, RETRY_HEADER)?.trim().toLowerCase();
  return value === 'exhausted' || value === 'none' ? value : undefined;
}

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retries. */
  readonly maxAttempts: number;
  /** Delay before the second attempt, before jitter. */
  readonly baseMs: number;
  /** Upper bound of the exponential delay. */
  readonly maxMs: number;
  /**
   * `equal` (default): a random delay in [d/2, d]. `full`: in [0, d]. `none`: exactly d.
   */
  readonly jitter?: 'equal' | 'full' | 'none';
  /** The longest `Retry-After` a caller honours. A longer one ends retrying. */
  readonly maxRetryAfterMs?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseMs: 250, maxMs: 4000, jitter: 'equal', maxRetryAfterMs: 10_000 };

export interface BackoffOptions {
  /** A `Retry-After` the peer sent, already in milliseconds (see `retryAfterMs`). */
  readonly retryAfterMs?: number | undefined;
  /** Absolute epoch-ms deadline. No attempt starts at or after it. */
  readonly deadlineMs?: number | undefined;
  readonly now?: () => number;
  readonly random?: () => number;
}

/**
 * The wait before the next attempt after attempt number `attempt` (1-based) failed, or null
 * when no further attempt may start: the attempts are used up, the peer asked for a longer
 * wait than `maxRetryAfterMs`, or the wait would reach the deadline.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, options: BackoffOptions = {}): number | null {
  if (!Number.isFinite(attempt) || attempt < 1 || attempt >= policy.maxAttempts) return null;
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
  const random = options.random ?? Math.random;
  const jitter = policy.jitter ?? 'equal';
  let delay = jitter === 'none' ? exponential : jitter === 'full' ? random() * exponential : exponential / 2 + random() * (exponential / 2);
  if (options.retryAfterMs !== undefined) {
    if (options.retryAfterMs > (policy.maxRetryAfterMs ?? Number.POSITIVE_INFINITY)) return null;
    delay = Math.max(delay, options.retryAfterMs);
  }
  delay = Math.max(0, Math.round(delay));
  if (options.deadlineMs !== undefined && (options.now ?? Date.now)() + delay >= options.deadlineMs) return null;
  return delay;
}

/** What an attempt's failure means for another attempt. */
export type RetryClass = 'retryable' | 'permanent' | 'unknown_effect' | 'aborted';

export interface RetryFailure {
  /** The HTTP status, when a response arrived. */
  readonly status?: number | undefined;
  /** The request failed before any response (DNS, connection, reset, timeout). */
  readonly network?: boolean | undefined;
  /** The caller cancelled. */
  readonly aborted?: boolean | undefined;
  /** Response bytes already consumed or forwarded. Any consumed byte ends retrying. */
  readonly bytesConsumed?: number | undefined;
  /**
   * What the owner knows about the operation's effect: `none` (proven none, or a read),
   * `idempotent` (repeating is safe by contract), or `unknown`.
   */
  readonly effect?: 'none' | 'idempotent' | 'unknown' | undefined;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Classify a failure. Transient statuses and network failures are retryable only while no
 * response byte was consumed and the effect is not unknown; other statuses are permanent.
 */
export function classifyRetry(failure: RetryFailure): RetryClass {
  if (failure.aborted) return 'aborted';
  if (failure.effect === 'unknown') return 'unknown_effect';
  if ((failure.bytesConsumed ?? 0) > 0) return 'permanent';
  if (failure.network) return 'retryable';
  if (failure.status !== undefined) return RETRYABLE_STATUS.has(failure.status) ? 'retryable' : 'permanent';
  return 'permanent';
}

/** The reason an abort signal carries, as an Error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Wait `ms`, or reject as soon as `signal` aborts. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal as AbortSignal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** What `retry` should do after a failed attempt. */
export interface RetryDecision {
  readonly retry: boolean;
  /** A wait the peer asked for, in milliseconds. */
  readonly retryAfterMs?: number | undefined;
  /** A short machine reason, recorded by `onAttempt`. */
  readonly reason?: string | undefined;
}

export interface RetryAttempt {
  readonly attempt: number;
  readonly error: unknown;
  readonly reason: string;
  /** The wait before the next attempt, or null when this was the last. */
  readonly delayMs: number | null;
}

export interface RetryOptions {
  readonly policy: RetryPolicy;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  /** Decide from a thrown error whether to retry. Default: never. */
  readonly classify?: (error: unknown, attempt: number) => RetryDecision;
  /** Called after every failed attempt, before waiting; record it where inspection needs it. */
  readonly onAttempt?: (attempt: RetryAttempt) => void;
  readonly now?: () => number;
  readonly random?: () => number;
}

/** The error `retry` throws when it stops: the last attempt's error is the `cause`. */
export class RetryExhaustedError extends Error {
  override readonly name = 'RetryExhaustedError';
  constructor(readonly attempts: number, readonly reason: string, cause: unknown) {
    super(`Gave up after ${attempts} attempt${attempts === 1 ? '' : 's'} (${reason})`, { cause });
  }
}

/**
 * Run `operation` until it succeeds, `classify` says not to retry, the attempts are used up,
 * the deadline would be crossed or `signal` aborts. A permanent failure rethrows the original
 * error; giving up on a retryable one throws `RetryExhaustedError` with it as the cause.
 */
export async function retry<T>(operation: (attempt: number, signal?: AbortSignal) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await operation(attempt, options.signal);
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      const decision = options.classify?.(error, attempt) ?? { retry: false, reason: 'not_retryable' };
      const reason = decision.reason ?? (decision.retry ? 'retryable' : 'not_retryable');
      const delay = decision.retry ? backoffDelay(attempt, options.policy, {
        retryAfterMs: decision.retryAfterMs, deadlineMs: options.deadlineMs,
        ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
      }) : null;
      options.onAttempt?.({ attempt, error, reason, delayMs: delay });
      if (!decision.retry) throw error;
      if (delay === null) throw new RetryExhaustedError(attempt, attempt >= options.policy.maxAttempts ? 'attempts_exhausted' : 'deadline_or_retry_after', error);
      await sleepAbortable(delay, options.signal);
    }
  }
}

/** Read `Retry-After` from response headers as milliseconds (seconds or an HTTP date). */
export function retryAfterFromHeaders(headers: HeaderSource, now?: () => number): number | undefined {
  return retryAfterMs(readHeader(headers, 'retry-after'), now ? { now } : {});
}
