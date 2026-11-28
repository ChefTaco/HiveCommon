/**
 * A shared sliding-window `RateLimitStore` on a Redis sorted set. Node only. HiveCommon takes no
 * Redis dependency: the store needs only the structural `SlidingWindowRedis` interface, which an
 * ioredis client (`new Redis(url)`) satisfies as it is.
 */
import { randomUUID } from 'node:crypto';
import type { RateLimitResult, RateLimitStore } from './index.js';

/** The pipeline commands the sliding window queues (ioredis `pipeline()`). Return values are ignored. */
export interface SlidingWindowPipeline {
  zremrangebyscore(key: string, min: string, max: number): unknown;
  zadd(key: string, score: number, member: string): unknown;
  zcard(key: string): unknown;
  pexpire(key: string, milliseconds: number): unknown;
  /** Needed only for `retryAfter: 'oldest'`. */
  zrange?(key: string, start: string, stop: string, withScores: 'WITHSCORES'): unknown;
  /** One `[error, reply]` pair per queued command, in order (ioredis); null when the pipeline was discarded. */
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/** The part of a Redis client the sliding window needs: an ioredis client satisfies it. */
export interface SlidingWindowRedis {
  pipeline(): SlidingWindowPipeline;
}

export interface RedisSlidingWindowStoreOptions {
  /** The client, or a function returning it on each call (for a client made on first use). */
  readonly redis: SlidingWindowRedis | (() => SlidingWindowRedis);
  readonly windowMs: number;
  /** Requests allowed per key in any `windowMs`; refused requests count too. */
  readonly max: number;
  /**
   * Prepended to every key, as given (include your own separator: `myapp:rl:`). Without it the
   * key passed to `consume()` is the Redis key, so a product keeps its existing key format.
   */
  readonly keyPrefix?: string;
  /**
   * What a refusal's `retryAfterMs` says:
   * - `window` (the default): the whole window. The newest attempt leaves the window last, so a
   *   client that keeps retrying waits that long;
   * - `oldest`: until enough entries have left the window for one more request to be allowed,
   *   read from the entry scores (needs `zrange` on the pipeline). A client that stops sending
   *   may come back after that, never later than one window.
   */
  readonly retryAfter?: 'window' | 'oldest';
  /** Clock in epoch milliseconds. */
  readonly now?: () => number;
}

/** Thrown when Redis answers with something the sliding window cannot read. */
export class RateLimitStoreError extends Error {
  override readonly name = 'RateLimitStoreError';
}

function positiveInteger(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/**
 * A `RateLimitStore` shared by every process and kept across restarts: a sliding window of `max`
 * requests per `windowMs` on one Redis sorted set per key. Every request is recorded, refused
 * ones included, so a client that keeps retrying stays refused; each `consume()` is one pipeline
 * (`ZREMRANGEBYSCORE`, `ZADD`, `ZCARD`, `PEXPIRE`, plus `ZRANGE` for `retryAfter: 'oldest'`).
 *
 * A connection or command failure is thrown (the command's own error, or a
 * `RateLimitStoreError` for an unreadable reply), never read as "allowed", so the caller decides
 * whether to fail closed (503) or fall back to an in-process limiter.
 *
 *   const store = createRedisSlidingWindowStore({ redis, windowMs: 60_000, max: 10, keyPrefix: 'myapp:rl:login:' });
 *   app.use('/login', rateLimit({ limiter: store }));
 */
export function createRedisSlidingWindowStore(options: RedisSlidingWindowStoreOptions): RateLimitStore {
  const windowMs = positiveInteger('windowMs', options.windowMs);
  const max = positiveInteger('max', options.max);
  const keyPrefix = options.keyPrefix ?? '';
  if (typeof keyPrefix !== 'string') throw new TypeError('keyPrefix must be a string');
  const retryAfter = options.retryAfter ?? 'window';
  if (retryAfter !== 'window' && retryAfter !== 'oldest') throw new TypeError("retryAfter must be 'window' or 'oldest'");
  const client = typeof options.redis === 'function' ? options.redis : (() => options.redis as SlidingWindowRedis);
  const now = options.now ?? (() => Date.now());

  return {
    async consume(key: string, cost = 1): Promise<RateLimitResult> {
      if (typeof key !== 'string') throw new TypeError('A rate-limit key must be a string');
      positiveInteger('cost', cost);
      if (cost > max) throw new RangeError('cost must not exceed max');
      const time = now();
      const redisKey = `${keyPrefix}${key}`;
      const pipeline = client().pipeline();
      pipeline.zremrangebyscore(redisKey, '-inf', time - windowMs);
      for (let index = 0; index < cost; index++) pipeline.zadd(redisKey, time, `${time}-${randomUUID()}`);
      pipeline.zcard(redisKey);
      pipeline.pexpire(redisKey, windowMs);
      if (retryAfter === 'oldest') {
        if (typeof pipeline.zrange !== 'function') throw new TypeError("retryAfter 'oldest' needs zrange on the Redis pipeline");
        // The entry whose departure lets one more request in: the max-th newest.
        pipeline.zrange(redisKey, String(-max), String(-max), 'WITHSCORES');
      }
      const replies = await pipeline.exec();
      if (!Array.isArray(replies)) throw new RateLimitStoreError('The rate-limit pipeline was discarded');
      for (const reply of replies) {
        if (!Array.isArray(reply)) throw new RateLimitStoreError('The rate-limit pipeline returned an unreadable reply');
        if (reply[0]) throw reply[0];
      }
      const count = replies[cost + 1]?.[1];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new RateLimitStoreError('The rate-limit pipeline returned an unreadable count');
      const allowed = count <= max;
      let retryAfterMs = 0;
      if (!allowed) {
        retryAfterMs = windowMs;
        if (retryAfter === 'oldest') {
          const entry = replies[cost + 3]?.[1];
          const score = Array.isArray(entry) ? Number(entry[1]) : Number.NaN;
          if (Number.isFinite(score)) retryAfterMs = Math.min(windowMs, Math.max(1, score + windowMs - time));
        }
      }
      return { allowed, limit: max, remaining: Math.max(0, max - count), retryAfterMs, resetMs: windowMs };
    },
  };
}
