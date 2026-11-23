import { describe, expect, it } from 'vitest';
import {
  childExecution, decodeExecutionHeader, encodeExecutionHeader, EXECUTION_HEADER, executionHeaders, executionTimeRemaining,
  formatExecutionRef, isExecutionRef, MAX_EXECUTION_HEADER_LENGTH, parseExecutionContext, parseExecutionRef,
  readExecutionHeader, rootExecution, validateExecutionContext,
} from '../src/execution/index.js';
import { createRequestContext, outboundHeaders } from '../src/context/index.js';

const STUDIO = formatExecutionRef({ product: 'studio', instance: 'local', kind: 'request', id: 'msg-1' });
const TASK = formatExecutionRef({ product: 'ardent', instance: 'node-1.assistant', kind: 'task', id: '3f2a8f1e-8c34-4c8d-9d43-0b1c2d3e4f50' });

describe('qualified references', () => {
  it('formats and parses every part', () => {
    expect(STUDIO).toBe('hx1:studio:local:request:msg-1');
    expect(parseExecutionRef(TASK)).toEqual({ product: 'ardent', instance: 'node-1.assistant', kind: 'task', id: '3f2a8f1e-8c34-4c8d-9d43-0b1c2d3e4f50' });
    expect(parseExecutionRef(formatExecutionRef({ product: 'ardent', instance: 'local.a', kind: 'attempt', id: 't1/2/1' }))?.id).toBe('t1/2/1');
  });

  it('refuses malformed, unknown-kind and oversize references', () => {
    for (const value of ['', 'hx2:ardent:x:task:1', 'hx1:Ardent:x:task:1', 'hx1:ardent:x:job:1', 'hx1:ardent:x y:task:1', `hx1:ardent:x:task:${'a'.repeat(300)}`, 42, null])
      expect(isExecutionRef(value)).toBe(false);
    expect(() => formatExecutionRef({ product: 'ardent', instance: 'x', kind: 'task', id: 'a b' })).toThrow(TypeError);
    expect(() => formatExecutionRef({ product: 'A', instance: 'x', kind: 'task', id: '1' })).toThrow(TypeError);
    expect(() => formatExecutionRef({ product: 'ardent', instance: '', kind: 'task', id: '1' })).toThrow(TypeError);
    expect(() => formatExecutionRef({ product: 'ardent', instance: 'x', kind: 'nope' as never, id: '1' })).toThrow(TypeError);
  });
});

describe('execution context', () => {
  it('validates, drops unknown keys and treats other versions as absent', () => {
    expect(parseExecutionContext({ v: 1, root: STUDIO, extra: 'dropped' })).toEqual({ v: 1, root: STUDIO });
    expect(validateExecutionContext({ v: 2, root: STUDIO })).toEqual({ ok: false, issues: ['unsupported_version'] });
    expect(validateExecutionContext('x')).toEqual({ ok: false, issues: ['not_an_object'] });
    const bad = validateExecutionContext({ v: 1, root: 'x', parent: 'y', self: 1, request_id: 'a b', inputs: ['x'], attempt: 0, deadline_ms: -1 });
    expect(bad.ok ? [] : bad.issues).toEqual(['root', 'parent', 'self', 'request_id', 'inputs', 'attempt', 'deadline_ms']);
    expect(validateExecutionContext({ v: 1, root: STUDIO, inputs: Array(17).fill(TASK) }).ok).toBe(false);
  });

  it('derives children with the same root, the parent self and the earlier deadline', () => {
    const root = rootExecution(STUDIO, { requestId: 'req-1', deadlineMs: 5000 });
    expect(root).toEqual({ v: 1, root: STUDIO, request_id: 'req-1', self: STUDIO, deadline_ms: 5000 });
    const child = childExecution(root, TASK, { attempt: 2, deadlineMs: 9000, inputs: [STUDIO, 'bogus'] });
    expect(child).toEqual({ v: 1, root: STUDIO, request_id: 'req-1', parent: STUDIO, self: TASK, inputs: [STUDIO], attempt: 2, deadline_ms: 5000 });
    expect(childExecution({ v: 1, root: STUDIO }, TASK).parent).toBe(STUDIO);
    expect(() => childExecution(root, 'nope')).toThrow(TypeError);
    expect(executionTimeRemaining(child, 4000)).toBe(1000);
    expect(executionTimeRemaining(child, 6000)).toBe(0);
    expect(executionTimeRemaining(undefined)).toBeUndefined();
  });

  it('round-trips through the header and ignores anything it cannot read', () => {
    const context = childExecution(rootExecution(STUDIO), TASK, { attempt: 1 });
    const headers = executionHeaders(context);
    expect(Object.keys(headers)).toEqual([EXECUTION_HEADER]);
    expect(readExecutionHeader(new Headers(headers))).toEqual(context);
    expect(decodeExecutionHeader(encodeExecutionHeader(context))).toEqual(context);
    for (const value of [undefined, null, '', '***', 'e30', 'x'.repeat(MAX_EXECUTION_HEADER_LENGTH + 1), btoa('{"v":2,"root":"hx1:a:b:task:c"}'), btoa('not json'), '_w']) expect(decodeExecutionHeader(value)).toBeUndefined();
    expect(executionHeaders(undefined)).toEqual({});
    expect(encodeExecutionHeader({ v: 1, root: 'invalid' })).toBeUndefined();
  });

  it('never produces a header past the limit', () => {
    const huge = { v: 1 as const, root: STUDIO, inputs: Array.from({ length: 16 }, (_, index) => formatExecutionRef({ product: 'ardent', instance: 'i'.repeat(90), kind: 'task', id: `${index}`.padEnd(120, 'x') })) };
    expect(encodeExecutionHeader(huge)).toBeUndefined();
    expect(executionHeaders(huge)).toEqual({});
  });

  it('flows through the request context into outbound headers when trusted', () => {
    const context = rootExecution(STUDIO, { requestId: 'r1' });
    const inbound = { [EXECUTION_HEADER]: encodeExecutionHeader(context)! };
    const trusted = createRequestContext(inbound);
    expect(trusted.execution).toEqual(context);
    expect(outboundHeaders(trusted)[EXECUTION_HEADER]).toBe(inbound[EXECUTION_HEADER]);
    expect(createRequestContext(inbound, { trustInbound: false }).execution).toBeUndefined();
    expect(createRequestContext(inbound, { trustInbound: false, trustInboundExecution: true }).execution).toEqual(context);
    expect(outboundHeaders(createRequestContext({}))[EXECUTION_HEADER]).toBeUndefined();
  });
});
