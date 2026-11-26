import { describe, expect, it, vi } from 'vitest';
import {
  auditAction, auditDetails, auditExportPage, auditRecordId, decodeAuditCursor, encodeAuditCursor, HIVE_AUDIT_EXPORT_PATH,
  HIVE_AUDIT_LIMITS, HIVE_AUDIT_PRODUCTS, isHiveAuditRecord, parseAuditExportQuery, validateHiveAuditPage, validateHiveAuditRecord,
  type HiveAuditRecord,
} from '../src/audit/index.js';
import { encodeCursor } from '../src/events/index.js';
import { HiveError } from '../src/errors/index.js';

const record: HiveAuditRecord = {
  id: 'hiveskills:audit:42',
  product: 'hiveskills',
  occurredAt: '2026-11-20T10:00:00.000Z',
  action: 'skill.update',
  outcome: 'success',
  actor: { type: 'user', id: 'user-subject', issuer: 'https://oathweave.example.test', displayName: 'Alice' },
  target: { type: 'skill', id: 'skill-1' },
  subject: { nodeId: 'node-a', agentRef: 'node-a~ops' },
  details: { version: '1.2.0', count: 3, dry: false, note: null },
};

describe('validateHiveAuditRecord', () => {
  it('accepts a full and a minimal record and returns a clean copy', () => {
    expect(validateHiveAuditRecord(record, { strict: true })).toEqual({ ok: true, value: record });
    const minimal = { id: 'embermend:audit:a.b:c-d_e', product: 'embermend', occurredAt: '2026-11-20T10:00:00Z', action: 'job.run', outcome: 'failure', actor: { type: 'system', id: 'embermend' }, details: {} };
    expect(validateHiveAuditRecord(minimal)).toEqual({ ok: true, value: minimal });
    expect(isHiveAuditRecord(record)).toBe(true);
    expect(HIVE_AUDIT_EXPORT_PATH).toBe('/v1/audit/export');
    expect(HIVE_AUDIT_PRODUCTS).toContain('ardentstudio');
  });

  it('drops unknown fields and empty parts unless strict', () => {
    const loose = { ...record, extra: 1, actor: { ...record.actor, role: 'x' }, target: {}, subject: { nodeId: 'node-a', other: 1 } };
    const result = validateHiveAuditRecord(loose);
    expect(result.ok && result.value).toEqual({ ...record, target: undefined, subject: { nodeId: 'node-a' } } as unknown as HiveAuditRecord);
    expect(result.ok && 'target' in result.value).toBe(false);
    const strict = validateHiveAuditRecord(loose, { strict: true });
    expect(strict.ok).toBe(false);
    expect(!strict.ok && strict.issues).toEqual(['extra: unknown field', 'actor.role: unknown field', 'subject.other: unknown field']);
  });

  it('reports every problem', () => {
    const bad = {
      id: 'hivemem:audit:42', product: 'hiveskills', occurredAt: '2026-11-20T10:00:00+01:00', action: 'Login', outcome: 'ok',
      actor: { type: 'robot', id: '', issuer: 'x'.repeat(513), displayName: 'bad\u0007name' },
      target: 'skill', subject: { nodeId: 7 },
      details: { nested: { a: 1 }, big: Number.POSITIVE_INFINITY },
    };
    const result = validateHiveAuditRecord(bad);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([
      'id: expected <product>:audit:<[A-Za-z0-9._:-]{1,200}>',
      'occurredAt: expected an RFC 3339 UTC timestamp',
      'action: expected dotted lowercase segments [a-z0-9_], at most 128 characters',
      'outcome: expected success or failure',
      'actor.type: expected user, service, agent or system',
      'actor.id: expected 1-256 characters',
      'actor.issuer: expected 1-512 characters',
      'actor.displayName: must not contain control characters',
      'target: expected an object',
      'subject.nodeId: expected a string',
      'details.nested: expected a string, finite number, boolean or null',
      'details.big: expected a string, finite number, boolean or null',
    ]);
    expect(validateHiveAuditRecord('x')).toEqual({ ok: false, issues: ['$: expected an object'] });
    const noProduct = validateHiveAuditRecord({ ...record, product: 'Bad', id: 7, actor: 'me', details: [] });
    expect(!noProduct.ok && noProduct.issues).toEqual([
      'product: expected a product ID', 'id: expected <product>:audit:<[A-Za-z0-9._:-]{1,200}>', 'actor: expected an object', 'details: expected an object of scalars',
    ]);
    const huge = validateHiveAuditRecord({ ...record, details: { blob: 'é'.repeat(2100) } });
    expect(!huge.ok && huge.issues).toEqual(['details: larger than 4096 bytes']);
    expect(validateHiveAuditRecord({ ...record, id: `hiveskills:audit:${'x'.repeat(201)}` }).ok).toBe(false);
    expect(validateHiveAuditRecord({ ...record, action: `a.${'b'.repeat(127)}` }).ok).toBe(false);
  });
});

describe('validateHiveAuditPage', () => {
  it('checks the page shape, the size and every record', () => {
    expect(validateHiveAuditPage({ data: [record], nextCursor: 'abc' })).toEqual({ ok: true, value: { data: [record], nextCursor: 'abc' } });
    expect(validateHiveAuditPage({ data: [], nextCursor: null }).ok).toBe(true);
    expect(validateHiveAuditPage({ data: [], nextCursor: 'abc' }).ok).toBe(true);
    expect(validateHiveAuditPage({ data: [record] })).toEqual({ ok: false, issues: ['$: expected { data: [], nextCursor: string | null }'] });
    expect(validateHiveAuditPage({ data: [], nextCursor: '' }).ok).toBe(false);
    expect(validateHiveAuditPage(null).ok).toBe(false);
    const issues = validateHiveAuditPage({ data: [...Array.from({ length: 200 }, () => record), { ...record, outcome: 'x' }], nextCursor: null });
    expect(!issues.ok && issues.issues).toEqual(['data: at most 200 records', 'nextCursor: required when data has records', 'data[200].outcome: expected success or failure']);
  });
});

describe('building records', () => {
  it('auditRecordId joins the product and native ID', () => {
    expect(auditRecordId('hivemem', 'op_1')).toBe('hivemem:audit:op_1');
    expect(auditRecordId('hiveskills', 42)).toBe('hiveskills:audit:42');
    expect(() => auditRecordId('hivemem', 'has space')).toThrow(TypeError);
    expect(() => auditRecordId('Hive', '1')).toThrow(TypeError);
  });

  it('auditAction normalises stored names', () => {
    expect(auditAction('skill.create')).toBe('skill.create');
    expect(auditAction('Login')).toBe('audit.login');
    expect(auditAction('deployment.prepared')).toBe('deployment.prepared');
    expect(auditAction('Agent Rename..done!')).toBe('agent_rename.done_');
    expect(auditAction('', 'studio')).toBe('studio.unknown');
    expect(auditAction('x', '!!')).toBe('audit.x');
    expect(auditAction(`a.${'b'.repeat(200)}`).length).toBe(128);
    expect(auditAction(`${'a'.repeat(127)}.b`)).toBe('a'.repeat(127));
  });

  it('auditDetails flattens, redacts and bounds details', () => {
    const details = auditDetails({
      version: '1.2.0', count: 2, ok: true, none: null, nan: Number.NaN,
      token: 'fixture-token', authorization: 'Bearer abc.def.ghi', note: 'sent Bearer fixture-token-value-123456',
      tags: ['a', 'b', 3], mixed: [{ a: 1 }, 'x'], nested: { deep: true }, body: 'the whole document', tokenCount: 5,
      long: 'x'.repeat(600),
    }, { dropKeys: ['BODY'], allowKeys: ['tokenCount'] });
    expect(details).toEqual({
      version: '1.2.0', count: 2, ok: true, none: null, token: '[REDACTED]', authorization: '[REDACTED]',
      note: expect.stringContaining('[REDACTED]'), tags: 'a,b,3', mixed_count: 2, tokenCount: 5, long: `${'x'.repeat(511)}…`,
    });
    expect(auditDetails('not an object')).toEqual({});
    expect(auditDetails(['a'])).toEqual({});
  });

  it('auditDetails drops the longest values until the details fit', () => {
    const fitted = auditDetails({ a: 'x'.repeat(500), b: 'y'.repeat(100), c: 1 }, { maxBytes: 200 });
    expect(fitted).toEqual({ b: 'y'.repeat(100), c: 1, truncated: true });
    expect(auditDetails({ a: 'x'.repeat(50) }, { maxBytes: 2 })).toEqual({});
    expect(() => auditDetails({}, { maxBytes: 5000 })).toThrow(RangeError);
    expect(() => auditDetails({}, { maxString: 0 })).toThrow(RangeError);
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field_${index}`, 'v'.repeat(100)]));
    const bounded = auditDetails(many);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(HIVE_AUDIT_LIMITS.detailsBytes);
    expect(bounded['truncated']).toBe(true);
  });
});

describe('cursors and queries', () => {
  it('round-trips integer, string and time positions in the shared cursor format', () => {
    for (const position of [{ id: 0 }, { id: 42 }, { id: 'op-1' }, { id: 'op-1', at: '2026-11-20T10:00:00.000Z' }]) {
      expect(decodeAuditCursor(encodeAuditCursor(position))).toEqual(position);
    }
    // The format products already issue: { i } and { t, i }.
    expect(encodeAuditCursor({ id: 7 })).toBe(encodeCursor({ i: 7 }));
    expect(encodeAuditCursor({ id: 'x', at: 't' })).toBe(encodeCursor({ t: 't', i: 'x' }));
  });

  it('refuses positions and cursors it did not issue', () => {
    for (const position of [{ id: -1 }, { id: 1.5 }, { id: '' }, { id: 'x'.repeat(257) }, { id: 1, at: '' }, { id: 1, at: 5 as unknown as string }]) {
      expect(() => encodeAuditCursor(position)).toThrow(TypeError);
    }
    for (const cursor of ['!!', encodeCursor({ id: 1 }), encodeCursor({ i: 1, x: 2 }), encodeCursor({ i: -3 }), encodeCursor({ i: 1, t: 2 }), encodeCursor({ i: 1, t: '' })]) {
      expect(decodeAuditCursor(cursor)).toBeUndefined();
    }
  });

  it('parses the export query with the suite defaults', () => {
    expect(parseAuditExportQuery(new URLSearchParams())).toEqual({ after: undefined, limit: 100 });
    expect(parseAuditExportQuery({ limit: '500', after: encodeAuditCursor({ id: 9 }) })).toEqual({ after: { id: 9 }, limit: 200 });
    expect(parseAuditExportQuery(new URLSearchParams('limit=5'), { defaultLimit: 50, maxLimit: 1000 })).toEqual({ after: undefined, limit: 5 });
    expect(parseAuditExportQuery(new URLSearchParams('limit=999'), { maxLimit: 1000 }).limit).toBe(200);
    expect(() => parseAuditExportQuery(new URLSearchParams(`after=${encodeCursor({ id: 1 })}`))).toThrow(expect.objectContaining({ code: 'invalid_cursor', status: 400 }));
    let error: unknown;
    try { parseAuditExportQuery(new URLSearchParams('limit=0')); } catch (caught) { error = caught; }
    expect(HiveError.is(error, 'invalid_query')).toBe(true);
  });
});

describe('auditExportPage', () => {
  interface Row { readonly id: number; readonly action: string; readonly at: string }
  const rows: Row[] = [
    { id: 1, action: 'skill.create', at: '2026-11-20T10:00:00.000Z' },
    { id: 2, action: 'skip', at: '2026-11-20T10:00:01.000Z' },
    { id: 3, action: 'Bad Action', at: '2026-11-20T10:00:02.000Z' },
    { id: 4, action: 'skill.delete', at: '2026-11-20T10:00:03.000Z' },
  ];
  const toRecord = (row: Row): HiveAuditRecord | undefined => (row.action === 'skip' ? undefined : {
    id: auditRecordId('hiveskills', row.id), product: 'hiveskills', occurredAt: row.at, action: row.action, outcome: 'success',
    actor: { type: 'user', id: 'alice' }, details: {},
  });

  it('maps, validates strictly, skips bad rows and moves the cursor past them', () => {
    const onDropped = vi.fn();
    const page = auditExportPage(rows, { limit: 3, toRecord, position: row => ({ id: row.id }), onDropped });
    expect(page.data.map(item => item.id)).toEqual(['hiveskills:audit:1']);
    expect(decodeAuditCursor(page.nextCursor as string)).toEqual({ id: 3 });
    expect(onDropped).toHaveBeenCalledWith(2);
    expect(validateHiveAuditPage(page, { strict: true }).ok).toBe(true);
    const rest = auditExportPage(rows.slice(3), { limit: 3, toRecord, position: row => ({ id: row.id, at: row.at }), onDropped });
    expect(rest.data).toHaveLength(1);
    expect(decodeAuditCursor(rest.nextCursor as string)).toEqual({ id: 4, at: '2026-11-20T10:00:03.000Z' });
    expect(onDropped).toHaveBeenCalledTimes(1);
  });

  it('returns a null cursor only when nothing was read', () => {
    expect(auditExportPage([], { limit: 10, toRecord, position: row => ({ id: row.id }) })).toEqual({ data: [], nextCursor: null });
    const allSkipped = auditExportPage([rows[1] as Row], { limit: 10, toRecord: () => null, position: row => ({ id: row.id }) });
    expect(allSkipped.data).toEqual([]);
    expect(allSkipped.nextCursor).not.toBeNull();
    expect(() => auditExportPage(rows, { limit: 0, toRecord, position: row => ({ id: row.id }) })).toThrow(RangeError);
    expect(() => auditExportPage(rows, { limit: 201, toRecord, position: row => ({ id: row.id }) })).toThrow(RangeError);
  });

  it('reads lazily from an iterable and stops at the limit', () => {
    let pulled = 0;
    function* source(): Generator<Row> { for (const row of rows) { pulled++; yield row; } }
    auditExportPage(source(), { limit: 2, toRecord, position: row => ({ id: row.id }) });
    expect(pulled).toBe(2);
  });
});
