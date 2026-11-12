import { describe, expect, it } from 'vitest';
import {
  childTraceparent, createRequestContext, currentRequestId, formatTraceparent, generateRequestId, generateSpanId,
  generateTraceId, generateTraceparent, getRequestContext, isValidRequestId, isValidTraceparent, outboundHeaders,
  parseTraceparent, readHeader, readIdempotencyKey, readRequestId, requireIdempotencyKey, resolveRequestId,
  runWithRequestContext,
} from '../src/context/index.js';
import { HiveError } from '../src/errors/index.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('headers', () => {
  it('reads from Headers, records and getters', () => {
    expect(readHeader(new Headers({ 'X-Request-Id': 'a' }), 'x-request-id')).toBe('a');
    expect(readHeader({ 'x-request-id': 'b' }, 'X-Request-ID')).toBe('b');
    expect(readHeader({ 'X-Request-Id': 'c' }, 'x-request-id')).toBe('c');
    expect(readHeader(name => (name === 'x-request-id' ? 'd' : undefined), 'X-Request-Id')).toBe('d');
    expect(readHeader({ 'x-request-id': ['e'] }, 'x-request-id')).toBe('e');
    expect(readHeader({ 'x-request-id': ['e', 'f'] }, 'x-request-id')).toBeUndefined();
    expect(readHeader({}, 'x-request-id')).toBeUndefined();
    expect(readHeader(() => null, 'x')).toBeUndefined();
  });
});

describe('request IDs', () => {
  it('prefers x-request-id, then the aliases', () => {
    expect(readRequestId({ 'x-request-id': 'a', 'x-hive-request-id': 'b', 'x-correlation-id': 'c' })).toBe('a');
    expect(readRequestId({ 'x-hive-request-id': 'b', 'x-correlation-id': 'c' })).toBe('b');
    expect(readRequestId({ 'x-correlation-id': 'c' })).toBe('c');
    expect(readRequestId({})).toBeUndefined();
  });

  it('ignores unsafe or oversized IDs', () => {
    expect(readRequestId({ 'x-request-id': 'has space', 'x-correlation-id': 'ok-1' })).toBe('ok-1');
    expect(readRequestId({ 'x-request-id': 'a'.repeat(129) })).toBeUndefined();
    expect(readRequestId({ 'x-request-id': 'line\nbreak' })).toBeUndefined();
    expect(readRequestId({ 'x-request-id': '  trimmed  ' })).toBe('trimmed');
    expect(isValidRequestId('abc:DEF/123=+.@_-')).toBe(true);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId(5)).toBe(false);
  });

  it('generates IDs when none is present', () => {
    expect(generateRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId({})).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId({}, () => 'fixed')).toBe('fixed');
    expect(resolveRequestId({ 'x-request-id': 'given' })).toBe('given');
  });
});

describe('traceparent', () => {
  it('parses a valid header', () => {
    expect(parseTraceparent(VALID)).toEqual({ version: '00', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', flags: '01', sampled: true });
    expect(parseTraceparent(` ${VALID} `)?.sampled).toBe(true);
    expect(parseTraceparent(VALID.replace(/01$/, '00'))?.sampled).toBe(false);
    expect(parseTraceparent(VALID.replace(/01$/, '03'))?.sampled).toBe(true);
  });

  it('accepts future versions with extra fields', () => {
    expect(parseTraceparent(`01${VALID.slice(2)}`)?.version).toBe('01');
    expect(parseTraceparent(`01${VALID.slice(2)}-extra`)?.version).toBe('01');
    expect(parseTraceparent(`01${VALID.slice(2)}extra`)).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['short', '00-abc'],
    ['version ff', `ff${VALID.slice(2)}`],
    ['version not hex', `zz${VALID.slice(2)}`],
    ['version 00 with extra', `${VALID}-x`],
    ['uppercase trace', VALID.replace('4bf92f', '4BF92F')],
    ['zero trace', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['zero span', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
    ['bad flags', VALID.replace(/01$/, 'zz')],
    ['wrong separators', VALID.replace(/-/g, '_')],
    ['short trace', '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01x'],
  ])('rejects %s', (_name, value) => {
    expect(parseTraceparent(value as string | undefined)).toBeUndefined();
    expect(isValidTraceparent(value as string | undefined)).toBe(false);
  });

  it('generates, formats and derives child spans', () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
    const root = generateTraceparent();
    expect(root.sampled).toBe(true);
    expect(generateTraceparent({ sampled: false }).flags).toBe('00');
    const header = formatTraceparent(root);
    expect(isValidTraceparent(header)).toBe(true);
    const child = childTraceparent(parseTraceparent(`01${VALID.slice(2)}`)!);
    expect(child).toMatchObject({ version: '00', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', flags: '01' });
    expect(child.spanId).not.toBe('00f067aa0ba902b7');
    expect(formatTraceparent({ traceId: root.traceId, spanId: root.spanId, sampled: false })).toMatch(/-00$/);
    expect(() => formatTraceparent({ traceId: 'bad', spanId: root.spanId })).toThrow(TypeError);
  });
});

describe('idempotency keys', () => {
  it('reads Idempotency-Key or X-Idempotency-Key', () => {
    expect(readIdempotencyKey({ 'idempotency-key': 'k1' })).toBe('k1');
    expect(readIdempotencyKey({ 'x-idempotency-key': 'k2' })).toBe('k2');
    expect(readIdempotencyKey({ 'idempotency-key': 'k3', 'x-idempotency-key': 'k3' })).toBe('k3');
    expect(readIdempotencyKey({})).toBeUndefined();
  });

  it('refuses malformed or conflicting keys', () => {
    for (const headers of [{ 'idempotency-key': 'a', 'x-idempotency-key': 'b' }, { 'idempotency-key': 'has space' }, { 'idempotency-key': '' }, { 'idempotency-key': 'x'.repeat(256) }]) {
      expect(() => readIdempotencyKey(headers)).toThrow(HiveError);
    }
    try { readIdempotencyKey({ 'idempotency-key': 'a b' }); } catch (error) { expect((error as HiveError).status).toBe(400); }
  });

  it('can require a key', () => {
    expect(requireIdempotencyKey({ 'idempotency-key': 'k' })).toBe('k');
    expect(() => requireIdempotencyKey({})).toThrow(expect.objectContaining({ status: 428, code: 'idempotency_key_required' }) as Error);
  });
});

describe('request context', () => {
  it('adopts inbound IDs and trace context, creating a child span', () => {
    const context = createRequestContext({ 'x-request-id': 'req-1', traceparent: VALID, tracestate: 'vendor=1' }, { now: () => 42 });
    expect(context).toMatchObject({ requestId: 'req-1', startedAt: 42, tracestate: 'vendor=1', bindings: {} });
    expect(context.parentTrace?.spanId).toBe('00f067aa0ba902b7');
    expect(context.trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(context.trace.spanId).not.toBe('00f067aa0ba902b7');
  });

  it('starts a new trace without valid inbound context and drops orphan or unsafe tracestate', () => {
    const context = createRequestContext({ traceparent: 'garbage', tracestate: 'a=1' }, { generateRequestId: () => 'gen' });
    expect(context.requestId).toBe('gen');
    expect(context.parentTrace).toBeUndefined();
    expect(context.tracestate).toBeUndefined();
    expect(createRequestContext({ traceparent: VALID, tracestate: 'a=\u0001' }).tracestate).toBeUndefined();
    expect(createRequestContext({ traceparent: VALID, tracestate: 'a'.repeat(513) }).tracestate).toBeUndefined();
  });

  it('ignores inbound IDs on an untrusted edge', () => {
    const context = createRequestContext({ 'x-request-id': 'attacker', traceparent: VALID }, { trustInbound: false });
    expect(context.requestId).not.toBe('attacker');
    expect(context.parentTrace).toBeUndefined();
  });

  it('is available through async work and isolated between requests', async () => {
    expect(getRequestContext()).toBeUndefined();
    expect(currentRequestId()).toBeUndefined();
    const a = createRequestContext({ 'x-request-id': 'a' });
    const b = createRequestContext({ 'x-request-id': 'b' });
    const [ra, rb] = await Promise.all([
      runWithRequestContext(a, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return currentRequestId(); }),
      runWithRequestContext(b, async () => { await Promise.resolve(); return getRequestContext()?.requestId; }),
    ]);
    expect([ra, rb]).toEqual(['a', 'b']);
  });

  it('builds outbound headers', () => {
    expect(outboundHeaders()).toEqual({});
    const context = createRequestContext({ 'x-request-id': 'r', traceparent: VALID, tracestate: 's=1' });
    const headers = runWithRequestContext(context, () => outboundHeaders());
    expect(headers['x-request-id']).toBe('r');
    expect(parseTraceparent(headers['traceparent'])?.spanId).toBe(context.trace.spanId);
    expect(headers['tracestate']).toBe('s=1');
    expect(outboundHeaders(createRequestContext({}))).not.toHaveProperty('tracestate');
  });
});
