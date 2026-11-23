import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay, classifyRetry, DEFAULT_RETRY_POLICY, readRetrySignal, retry, retryAfterFromHeaders, RetryExhaustedError,
  sleepAbortable, type RetryPolicy,
} from '../src/retry/index.js';

const POLICY: RetryPolicy = { maxAttempts: 4, baseMs: 100, maxMs: 1000, jitter: 'none', maxRetryAfterMs: 5000 };

describe('backoffDelay', () => {
  it('grows exponentially to the cap and stops at the attempt limit', () => {
    expect([1, 2, 3].map(attempt => backoffDelay(attempt, POLICY))).toEqual([100, 200, 400]);
    expect(backoffDelay(4, POLICY)).toBeNull();
    expect(backoffDelay(0, POLICY)).toBeNull();
    expect(backoffDelay(3, { ...POLICY, maxAttempts: 10, maxMs: 300 })).toBe(300);
  });

  it('applies jitter within its range', () => {
    expect(backoffDelay(2, { ...POLICY, jitter: 'equal' }, { random: () => 0 })).toBe(100);
    expect(backoffDelay(2, { ...POLICY, jitter: 'equal' }, { random: () => 1 })).toBe(200);
    expect(backoffDelay(2, { ...POLICY, jitter: 'full' }, { random: () => 0 })).toBe(0);
    expect(backoffDelay(2, DEFAULT_RETRY_POLICY, { random: () => 0.5 })).toBe(375);
  });

  it('honours Retry-After up to the limit and never crosses the deadline', () => {
    expect(backoffDelay(1, POLICY, { retryAfterMs: 2000 })).toBe(2000);
    expect(backoffDelay(1, POLICY, { retryAfterMs: 6000 })).toBeNull();
    expect(backoffDelay(1, POLICY, { deadlineMs: 1100, now: () => 1000 })).toBeNull();
    expect(backoffDelay(1, POLICY, { deadlineMs: 1101, now: () => 1000 })).toBe(100);
  });
});

describe('classifyRetry', () => {
  it('separates transient, permanent, unknown-effect and aborted failures', () => {
    expect(classifyRetry({ status: 503 })).toBe('retryable');
    expect(classifyRetry({ status: 429 })).toBe('retryable');
    expect(classifyRetry({ network: true })).toBe('retryable');
    expect(classifyRetry({ status: 400 })).toBe('permanent');
    expect(classifyRetry({ status: 503, bytesConsumed: 1 })).toBe('permanent');
    expect(classifyRetry({ network: true, effect: 'unknown' })).toBe('unknown_effect');
    expect(classifyRetry({ status: 503, aborted: true })).toBe('aborted');
    expect(classifyRetry({})).toBe('permanent');
  });
});

describe('signals and headers', () => {
  it('reads the retry signal and Retry-After', () => {
    expect(readRetrySignal(new Headers({ 'x-hive-retry': 'Exhausted' }))).toBe('exhausted');
    expect(readRetrySignal({ 'x-hive-retry': 'none' })).toBe('none');
    expect(readRetrySignal({ 'x-hive-retry': 'maybe' })).toBeUndefined();
    expect(retryAfterFromHeaders({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfterFromHeaders({ 'retry-after': new Date(10_000).toUTCString() }, () => 4000)).toBe(6000);
    expect(retryAfterFromHeaders({})).toBeUndefined();
  });
});

describe('sleepAbortable', () => {
  it('resolves after the wait and rejects on abort', async () => {
    await expect(sleepAbortable(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const waiting = sleepAbortable(10_000, controller.signal);
    controller.abort('stop');
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError', message: 'stop' });
    await expect(sleepAbortable(1, controller.signal)).rejects.toThrow('stop');
    const reason = new Error('reason');
    await expect(sleepAbortable(1, AbortSignal.abort(reason))).rejects.toBe(reason);
  });
});

describe('retry', () => {
  const quick: RetryPolicy = { maxAttempts: 3, baseMs: 1, maxMs: 2, jitter: 'none' };

  it('retries retryable failures and records every attempt', async () => {
    const onAttempt = vi.fn();
    const operation = vi.fn().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValue('ok');
    await expect(retry(operation, { policy: quick, classify: () => ({ retry: true, reason: 'transient' }), onAttempt })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onAttempt.mock.calls.map(call => (call[0] as { attempt: number; delayMs: number }).delayMs)).toEqual([1, 2]);
  });

  it('rethrows permanent failures at once and wraps exhaustion', async () => {
    const permanent = new Error('bad request');
    await expect(retry(() => Promise.reject(permanent), { policy: quick })).rejects.toBe(permanent);
    const exhausted = retry(() => Promise.reject(new Error('down')), { policy: quick, classify: () => ({ retry: true }) });
    await expect(exhausted).rejects.toBeInstanceOf(RetryExhaustedError);
    await expect(exhausted).rejects.toMatchObject({ attempts: 3, reason: 'attempts_exhausted' });
    await expect(retry(() => Promise.reject(new Error('slow')), { policy: { ...quick, maxRetryAfterMs: 10 }, classify: () => ({ retry: true, retryAfterMs: 50 }) }))
      .rejects.toMatchObject({ attempts: 1, reason: 'deadline_or_retry_after' });
  });

  it('stops when the caller aborts, before or during an attempt or a wait', async () => {
    await expect(retry(() => Promise.resolve(1), { policy: quick, signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone');
    const controller = new AbortController();
    const operation = vi.fn(async () => { controller.abort(new Error('cancelled')); throw new Error('mid-attempt'); });
    await expect(retry(operation, { policy: quick, signal: controller.signal, classify: () => ({ retry: true }) })).rejects.toThrow('mid-attempt');
    expect(operation).toHaveBeenCalledTimes(1);
    const waiting = new AbortController();
    const slow = retry(() => Promise.reject(new Error('x')), { policy: { ...quick, baseMs: 10_000, maxMs: 10_000 }, signal: waiting.signal, classify: () => ({ retry: true }) });
    setTimeout(() => waiting.abort(new Error('during wait')), 5);
    await expect(slow).rejects.toThrow('during wait');
  });
});
