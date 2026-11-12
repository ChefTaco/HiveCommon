import { describe, expect, it } from 'vitest';
import {
  formatAgentRef, HIVE_HEADERS, isAgentRef, isHiveEvent, isIdentifier, isPage, isProductId, isRfc3339Utc, isSameOriginPath,
  parseAgentRef, validateAgentIdentity, validateHiveEvent, validateHiveEventPage,
} from '../src/contracts/index.js';
import { EVENT } from './fixtures/event.js';


describe('identifiers', () => {
  it('validates identifier segments, agent refs and product IDs', () => {
    expect(isIdentifier('ab')).toBe(true);
    expect(isIdentifier('a')).toBe(false);
    expect(isIdentifier('x'.repeat(33))).toBe(false);
    expect(isIdentifier('Upper')).toBe(false);
    expect(isAgentRef('node_1~profile-2')).toBe(true);
    expect(isAgentRef('node~')).toBe(false);
    expect(isAgentRef('a~bb')).toBe(false);
    expect(isProductId('hive-registry')).toBe(true);
    expect(isProductId('1abc')).toBe(false);
    expect(parseAgentRef('node-a~writer')).toEqual({ nodeId: 'node-a', profile: 'writer' });
    expect(parseAgentRef('bad')).toBeUndefined();
    expect(formatAgentRef('node-a', 'writer')).toBe('node-a~writer');
    expect(() => formatAgentRef('N', 'writer')).toThrow(TypeError);
  });

  it('validates agent identities', () => {
    expect(validateAgentIdentity({ agentRef: 'node-a~writer', actorId: 'operator' })).toEqual({ ok: true, value: { agentRef: 'node-a~writer', actorId: 'operator' } });
    expect(validateAgentIdentity({ agentRef: 'x', actorId: 'O' })).toEqual({ ok: false, issues: [expect.stringMatching(/^agentRef/), expect.stringMatching(/^actorId/)] });
    expect(validateAgentIdentity(null).ok).toBe(false);
  });

  it('names the suite headers', () => {
    expect(HIVE_HEADERS.requestId).toBe('x-request-id');
    expect(HIVE_HEADERS.idempotencyKeyAliases).toContain('x-idempotency-key');
  });
});

describe('timestamps and paths', () => {
  it('accepts only real RFC 3339 UTC instants', () => {
    expect(isRfc3339Utc('2026-11-12T08:30:00Z')).toBe(true);
    expect(isRfc3339Utc('2026-11-12T08:30:00.123456789Z')).toBe(true);
    for (const value of ['2026-11-12T08:30:00+01:00', '2026-02-30T00:00:00Z', '2026-11-12 08:30:00Z', '2026-13-01T00:00:00Z', '2026-11-12T24:00:00Z', 5]) {
      expect(isRfc3339Utc(value)).toBe(false);
    }
  });

  it('accepts only same-origin paths', () => {
    expect(isSameOriginPath('/a/b?c=d#e')).toBe(true);
    for (const value of ['a/b', '//evil.example.com', '/\\evil', 'https://x.example.com/', '/a b', '/a\u0000', `/${'a'.repeat(1024)}`, 1]) {
      expect(isSameOriginPath(value)).toBe(false);
    }
  });
});

describe('HiveEvent', () => {
  it('accepts a full event and a minimal one', () => {
    expect(validateHiveEvent(EVENT)).toEqual({ ok: true, value: EVENT });
    const { subject: _s, sourceRef: _r, ...minimal } = EVENT;
    expect(validateHiveEvent({ ...minimal, summary: '' })).toEqual({ ok: true, value: { ...minimal, summary: '' } });
    expect(isHiveEvent(EVENT)).toBe(true);
    expect(validateHiveEvent({ ...EVENT, subject: {} })).toEqual({ ok: true, value: { ...EVENT, subject: {} } });
  });

  it('drops unknown fields by default and rejects them when strict', () => {
    const extra = { ...EVENT, secret: 'x', subject: { ...EVENT.subject, extra: 1 }, link: { ...EVENT.link, host: 'x' } };
    const lenient = validateHiveEvent(extra);
    expect(lenient).toEqual({ ok: true, value: EVENT });
    const strict = validateHiveEvent(extra, { strict: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.issues).toEqual(['secret: unknown field', 'subject.extra: unknown field', 'link.host: unknown field']);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['id type', { id: 5 }, /^id: expected a string/],
    ['id empty', { id: '' }, /^id: expected 1-128/],
    ['id characters', { id: 'a b' }, /^id: expected \[/],
    ['product', { product: 'Magnus' }, /^product/],
    ['type', { type: 'Agent Failed' }, /^type: expected a dotted/],
    ['severity', { severity: 'error' }, /^severity/],
    ['title empty', { title: '' }, /^title/],
    ['title control', { title: 'a\u0007b' }, /^title: must not contain control/],
    ['summary long', { summary: 'x'.repeat(2001) }, /^summary/],
    ['occurredAt', { occurredAt: 'yesterday' }, /^occurredAt/],
    ['subject type', { subject: 'x' }, /^subject: expected an object/],
    ['subject actor', { subject: { actorId: 'A' } }, /^subject.actorId/],
    ['subject agent', { subject: { agentRef: 'x' } }, /^subject.agentRef/],
    ['subject node', { subject: { nodeId: '!' } }, /^subject.nodeId/],
    ['link type', { link: null }, /^link: expected an object/],
    ['link product', { link: { product: 'X', path: '/' } }, /^link.product/],
    ['link path', { link: { product: 'magnus', path: 'https://evil.example.com' } }, /^link.path/],
    ['sourceRef', { sourceRef: '' }, /^sourceRef/],
  ])('rejects a bad %s', (_name, change, issue) => {
    const result = validateHiveEvent({ ...EVENT, ...change });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some(item => issue.test(item))).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateHiveEvent([])).toEqual({ ok: false, issues: ['$: expected an object'] });
  });
});

describe('pages', () => {
  it('recognises pages', () => {
    expect(isPage({ data: [], nextCursor: null })).toBe(true);
    expect(isPage({ data: [], nextCursor: 'c' })).toBe(true);
    expect(isPage({ data: [], nextCursor: '' })).toBe(false);
    expect(isPage({ data: {}, nextCursor: null })).toBe(false);
    expect(isPage({ data: [] })).toBe(false);
  });

  it('validates a page of events', () => {
    expect(validateHiveEventPage({ data: [EVENT], nextCursor: 'c1' })).toEqual({ ok: true, value: { data: [EVENT], nextCursor: 'c1' } });
    const bad = validateHiveEventPage({ data: [EVENT, { ...EVENT, severity: 'x' }], nextCursor: null });
    expect(bad).toEqual({ ok: false, issues: ['data[1].severity: expected info, warning or critical'] });
    expect(validateHiveEventPage([]).ok).toBe(false);
  });
});
