import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareFeedPositions, generateRequestId, isAfterFeedPosition, isValidRequestId, rawHeader, readHeader, readRequestId, resolveRequestId, retryAfterMs,
} from '../src/contracts/index.js';
import * as context from '../src/context/index.js';
import * as contracts from '../src/contracts/index.js';
import {
  buildFeedPage, decodeCursor, decodeFeedPosition, encodeCursor, encodeFeedPosition, feedSince, requireFeedPosition,
} from '../src/events/index.js';
import { HiveError } from '../src/errors/index.js';
import { createHealth, readiness } from '../src/health/index.js';
import { createLogger, redact, REDACTED } from '../src/log/index.js';
import { EVENT } from './fixtures/event.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('request IDs in /contracts', () => {
  it('are the same functions /context exports', () => {
    expect(context.generateRequestId).toBe(contracts.generateRequestId);
    expect(context.readRequestId).toBe(contracts.readRequestId);
    expect(context.resolveRequestId).toBe(contracts.resolveRequestId);
    expect(context.readHeader).toBe(contracts.readHeader);
  });

  it('generates a UUID, or random hex where randomUUID is missing or refuses', () => {
    expect(generateRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const realCrypto = globalThis.crypto;
    const getRandomValues = (array: Uint8Array<ArrayBuffer>) => realCrypto.getRandomValues(array);
    vi.stubGlobal('crypto', { getRandomValues });
    const first = generateRequestId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidRequestId(first)).toBe(true);
    expect(generateRequestId()).not.toBe(first);
    vi.stubGlobal('crypto', { getRandomValues, randomUUID: () => { throw new Error('insecure context'); } });
    expect(generateRequestId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reads the request ID of a response', () => {
    expect(readRequestId(new Response('', { headers: { 'x-request-id': ' req-1 ' } }).headers)).toBe('req-1');
    expect(readRequestId(new Response('', { headers: { 'x-correlation-id': 'corr-1' } }).headers)).toBe('corr-1');
    expect(readRequestId(new Response('', { headers: { 'x-request-id': 'bad id', 'x-hive-request-id': 'hive-1' } }).headers)).toBe('hive-1');
    expect(readRequestId(new Headers())).toBeUndefined();
    expect(resolveRequestId(new Headers(), () => 'made')).toBe('made');
    expect(resolveRequestId({ 'X-Request-Id': 'given' })).toBe('given');
    expect(readHeader(name => (name === 'a' ? 'b' : null), 'A')).toBe('b');
    expect(rawHeader({ a: ['1', '2'] }, 'a')).toEqual(['1', '2']);
    expect(rawHeader({}, 'a')).toBeUndefined();
  });
});

describe('retryAfterMs', () => {
  const now = () => Date.parse('2026-11-12T08:00:00Z');

  it('reads delta-seconds and HTTP dates', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(' 0 ')).toBe(0);
    expect(retryAfterMs('Thu, 12 Nov 2026 08:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Thu, 12 Nov 2026 08:00:30 GMT', { now })).toBe(30_000);
    expect(retryAfterMs('Thu, 12 Nov 2026 07:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('2026-11-12T08:00:10Z', now)).toBe(10_000);
    expect(retryAfterMs(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
  });

  it('is undefined for an absent or unreadable header', () => {
    for (const header of [undefined, null, '', '  ', 'soon', '-5', '1e3', '0x10']) expect(retryAfterMs(header)).toBeUndefined();
    expect(retryAfterMs('1.5')).toBeUndefined();
    expect(retryAfterMs('9'.repeat(400))).toBeUndefined();
  });

  it('accepts decimal seconds when asked', () => {
    expect(retryAfterMs('1.5', { allowFractional: true })).toBe(1500);
    expect(retryAfterMs('0.0001', { allowFractional: true })).toBe(1);
    expect(retryAfterMs('.5', { allowFractional: true })).toBe(500);
    expect(retryAfterMs('2.', { allowFractional: true })).toBe(2000);
    expect(retryAfterMs('1.2.3', { allowFractional: true })).toBeUndefined();
  });

  it('applies a fallback and bounds', () => {
    const options = { now, fallbackMs: 5_000, minMs: 1_000, maxMs: 60_000 };
    const fallback: number = retryAfterMs(null, options);
    expect(fallback).toBe(5_000);
    expect(retryAfterMs('soon', options)).toBe(5_000);
    expect(retryAfterMs('0', options)).toBe(1_000);
    expect(retryAfterMs('600', options)).toBe(60_000);
    expect(retryAfterMs('30', options)).toBe(30_000);
    expect(retryAfterMs(undefined, { fallbackMs: 10, minMs: 1_000 })).toBe(1_000);
    expect(retryAfterMs(undefined, { minMs: 1_000 })).toBeUndefined();
  });
});

describe('feed positions', () => {
  const a = { occurredAt: '2026-11-12T08:30:00.000Z', id: 'a' };
  const b = { occurredAt: '2026-11-12T08:30:00.000Z', id: 'b' };
  const later = { occurredAt: '2026-11-12T08:30:01Z', id: 'a' };

  it('orders by instant, then by ID', () => {
    expect(compareFeedPositions(a, b)).toBeLessThan(0);
    expect(compareFeedPositions(b, a)).toBeGreaterThan(0);
    expect(compareFeedPositions(a, { ...a })).toBe(0);
    expect(compareFeedPositions({ occurredAt: '2026-11-12T08:30:00Z', id: 'a' }, a)).toBe(0);
    expect(compareFeedPositions(later, b)).toBeGreaterThan(0);
    expect(isAfterFeedPosition(b, a)).toBe(true);
    expect(isAfterFeedPosition(a, a)).toBe(false);
    expect(isAfterFeedPosition(a, undefined)).toBe(true);
    expect(isAfterFeedPosition(a, null)).toBe(true);
  });

  it('round-trips a position through a cursor', () => {
    const cursor = encodeFeedPosition(EVENT);
    expect(decodeCursor(cursor)).toEqual({ t: EVENT.occurredAt, i: EVENT.id });
    expect(decodeFeedPosition(cursor)).toEqual({ occurredAt: EVENT.occurredAt, id: EVENT.id });
    expect(requireFeedPosition(cursor)).toEqual({ occurredAt: EVENT.occurredAt, id: EVENT.id });
    expect(decodeFeedPosition(encodeFeedPosition({ occurredAt: '2026-11-12T08:30:00.000Z', id: '~' }))?.id).toBe('~');
  });

  it('refuses anything that is not a feed cursor', () => {
    const bad = [
      'not a cursor', encodeCursor({ t: EVENT.occurredAt }), encodeCursor({ t: EVENT.occurredAt, i: '' }), encodeCursor({ t: EVENT.occurredAt, i: 5 }),
      encodeCursor({ t: '2026-11-12 08:30', i: 'a' }), encodeCursor({ t: 5, i: 'a' }), encodeCursor({ t: EVENT.occurredAt, i: 'a', x: 1 }),
      encodeCursor({ t: EVENT.occurredAt, i: 'x'.repeat(257) }), encodeCursor({ t: EVENT.occurredAt, i: 'a\u0000' }),
    ];
    for (const cursor of bad) {
      expect(decodeFeedPosition(cursor)).toBeUndefined();
      expect(() => requireFeedPosition(cursor)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_cursor' }));
    }
    expect(() => encodeFeedPosition({ occurredAt: 'yesterday', id: 'a' })).toThrow(TypeError);
    expect(() => encodeFeedPosition({ occurredAt: EVENT.occurredAt, id: '' })).toThrow(TypeError);
  });
});

describe('buildFeedPage', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-11-12T08:00:00.000Z') + seconds * 1000).toISOString();
  const event = (id: string, seconds: number, extra: Record<string, unknown> = {}) => ({ ...EVENT, id, occurredAt: at(seconds), ...extra });

  it('sorts oldest first, cuts at the limit and gives a time-and-ID cursor', () => {
    const candidates = [event('c', 2), event('b', 1), null, event('a', 1), undefined, event('d', 3)];
    const first = buildFeedPage(candidates, { limit: 2 });
    expect(first.data.map(item => item.id)).toEqual(['a', 'b']);
    expect(decodeFeedPosition(first.nextCursor!)).toEqual({ occurredAt: at(1), id: 'b' });
    const second = buildFeedPage(candidates, { limit: 2, after: first.nextCursor });
    expect(second.data.map(item => item.id)).toEqual(['c', 'd']);
    expect(second.nextCursor).toBeNull();
    expect(buildFeedPage(candidates, { limit: 5, after: { occurredAt: at(2), id: 'c' } }).data.map(item => item.id)).toEqual(['d']);
    expect(buildFeedPage(new Set(candidates), { limit: 5, after: '' }).data).toHaveLength(4);
    expect(buildFeedPage([], { limit: 5, after: null })).toEqual({ data: [], nextCursor: null });
  });

  it('drops events outside the retention window', () => {
    const now = Date.parse(at(100));
    const candidates = [event('old', 0), event('edge', 40), event('new', 90)];
    expect(buildFeedPage(candidates, { limit: 5, retentionMs: 60_000, now }).data.map(item => item.id)).toEqual(['edge', 'new']);
    expect(buildFeedPage(candidates, { limit: 5, retentionMs: 60_000, now: () => now + 1 }).data.map(item => item.id)).toEqual(['new']);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(buildFeedPage(candidates, { limit: 5, retentionMs: 20_000 }).data.map(item => item.id)).toEqual(['new']);
  });

  it('drops and reports invalid candidates, strictly by default', () => {
    const onDropped = vi.fn();
    const candidates = [event('ok', 1), { id: 'broken' }, null, event('extra', 2, { internal: true })];
    const strict = buildFeedPage(candidates, { limit: 5, onDropped });
    expect(strict.data.map(item => item.id)).toEqual(['ok']);
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped.mock.calls[0]![0]).toBe(2);
    expect(onDropped.mock.calls[0]![1]).toEqual([{ index: 1, issues: expect.any(Array) }, { index: 3, issues: ['internal: unknown field'] }]);
    const lenient = buildFeedPage(candidates, { limit: 5, validate: 'lenient' });
    expect(lenient.data.map(item => item.id)).toEqual(['ok', 'extra']);
    expect(lenient.data[1]).not.toHaveProperty('internal');
    const trusted = [event('ok', 1)];
    expect(buildFeedPage(trusted, { limit: 5, validate: 'none' }).data[0]).toBe(trusted[0]);
    const quiet = vi.fn();
    buildFeedPage([event('ok', 1)], { limit: 5, onDropped: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('refuses a bad limit, cursor or retention', () => {
    expect(() => buildFeedPage([], { limit: 0 })).toThrow(RangeError);
    expect(() => buildFeedPage([], { limit: 5, after: 'garbage' })).toThrow(HiveError);
    expect(() => buildFeedPage([], { limit: 5, retentionMs: -1 })).toThrow(RangeError);
  });

  it('gives the earliest instant a storage query needs', () => {
    const now = Date.parse(at(100));
    expect(feedSince({})).toBeUndefined();
    expect(feedSince({ retentionMs: 60_000, now })).toBe(at(40));
    expect(feedSince({ retentionMs: 60_000, now, after: { occurredAt: at(10), id: 'a' } })).toBe(at(40));
    expect(feedSince({ retentionMs: 60_000, now, after: encodeFeedPosition({ occurredAt: at(70), id: 'a' }) })).toBe(at(70));
    expect(feedSince({ after: { occurredAt: '2026-11-12T08:00:05Z', id: 'a' } })).toBe(at(5));
  });
});

describe('redact allowKeys', () => {
  it('keeps identifiers whose name only looks secret, and still scrubs their values', () => {
    const input = { authorizationId: 'auth-123', tokenCount: 'seven', credentialType: { kind: 'passkey' }, authorization: 'Bearer fixture-token', sessionId: 's-1' };
    expect(redact(input)).toEqual({ authorizationId: REDACTED, tokenCount: REDACTED, credentialType: REDACTED, authorization: REDACTED, sessionId: REDACTED });
    expect(redact(input, { allowKeys: ['authorizationId', 'TOKENCOUNT', 'credentialType'] })).toEqual({
      authorizationId: 'auth-123', tokenCount: 'seven', credentialType: { kind: 'passkey' }, authorization: REDACTED, sessionId: REDACTED,
    });
    expect(redact({ authorizationId: 'Bearer fixture-token-value' }, { allowKeys: ['authorizationId'] })).toEqual({ authorizationId: `Bearer ${REDACTED}` });
    expect(redact({ authorizationId: { password: 'hunter2', note: 'ok' } }, { allowKeys: ['authorizationId'] })).toEqual({ authorizationId: { password: REDACTED, note: 'ok' } });
    expect(redact({ authorizationId: 'auth-123' }, { allowKeys: ['authorizationId'], keys: ['authorizationid'] })).toEqual({ authorizationId: REDACTED });
    expect(redact({ nested: [{ authorizationId: 'auth-123', authorization_id: 'x' }] }, { allowKeys: ['authorizationId'] })).toEqual({ nested: [{ authorizationId: 'auth-123', authorization_id: REDACTED }] });
  });

  it('is available to the logger', () => {
    const lines: string[] = [];
    createLogger({ write: line => lines.push(line), redactAllowKeys: ['authorizationId'] }).info('exported', { authorizationId: 'auth-123', token: 'fixture-token' });
    createLogger({ write: line => lines.push(line) }).info('exported', { authorizationId: 'auth-123' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ authorizationId: 'auth-123', token: REDACTED });
    expect(JSON.parse(lines[1]!)).toMatchObject({ authorizationId: REDACTED });
  });
});

describe('readiness sharing', () => {
  function counting(delayMs = 5) {
    let runs = 0;
    const check = async () => { runs++; await new Promise(resolve => setTimeout(resolve, delayMs)); return true; };
    return { checks: [{ name: 'db', check }], runs: () => runs };
  }

  it('runs every check on every request by default', async () => {
    const { checks, runs } = counting();
    const health = createHealth({ checks });
    await Promise.all([health.ready(), health.ready(), health.handle('/health/ready')]);
    expect(runs()).toBe(3);
  });

  it('shares one in-flight run with readyCacheMs: 0, without caching the result', async () => {
    const { checks, runs } = counting();
    const health = createHealth({ checks, readyCacheMs: 0 });
    const [first, second, third] = await Promise.all([health.ready(), health.ready(), health.handle('/health/ready')]);
    expect(runs()).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.body.status).toBe('ready');
    await health.ready();
    expect(runs()).toBe(2);
  });

  it('serves a finished result for readyCacheMs', async () => {
    let at = 1_000;
    const { checks, runs } = counting(0);
    const health = createHealth({ checks, readyCacheMs: 500, now: () => at });
    const first = await health.ready();
    at += 499;
    expect(await health.ready()).toBe(first);
    expect(runs()).toBe(1);
    at += 1;
    expect(await health.ready()).not.toBe(first);
    expect(runs()).toBe(2);
  });

  it('shares failures too, and never shares the stand-alone function', async () => {
    let runs = 0;
    const checks = [{ name: 'db', check: () => { runs++; return false; } }];
    const health = createHealth({ checks, readyCacheMs: 1_000 });
    expect((await health.ready()).status).toBe(503);
    expect((await health.ready()).status).toBe(503);
    expect(runs).toBe(1);
    await readiness({ checks, readyCacheMs: 1_000 });
    await readiness({ checks, readyCacheMs: 1_000 });
    expect(runs).toBe(3);
  });

  it('validates readyCacheMs', () => {
    for (const value of [-1, Number.NaN, Infinity, '5' as never]) expect(() => createHealth({ readyCacheMs: value })).toThrow(/readyCacheMs/);
  });
});
