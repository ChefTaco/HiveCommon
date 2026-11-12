import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestContext, runWithRequestContext } from '../src/context/index.js';
import { createLogger, isSensitiveKey, redact, redactHeaders, redactText, REDACTED } from '../src/log/index.js';

// Built at runtime so this file holds no credential-shaped literals.
const jwt = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ1c2VyLTEyMyJ9', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
const providerKey = `sk-${'A1b2'.repeat(6)}`;
const githubToken = `ghp_${'x'.repeat(36)}`;
const npmToken = `npm_${'y'.repeat(36)}`;
const slackToken = `xoxb-${'1234567890'.repeat(2)}`;
const awsKey = `AKIA${'Z'.repeat(16)}`;
const pemLabel = ['PRIVATE', 'KEY-----'].join(' ');
const pem = [`-----BEGIN ${pemLabel}`, 'MIIEvQIBADANBg', `-----END ${pemLabel}`].join('\n');

describe('redactText', () => {
  it.each([
    ['bearer header', 'Authorization: Bearer abc.def-ghi', 'Bearer [REDACTED]'],
    ['basic header', 'Basic dXNlcjpwYXNz', 'Basic [REDACTED]'],
    ['JWT', `token was ${jwt} ok`, `token was ${REDACTED} ok`],
    ['provider key', `key ${providerKey}`, REDACTED],
    ['GitHub token', githubToken, REDACTED],
    ['npm token', npmToken, REDACTED],
    ['Slack token', slackToken, REDACTED],
    ['AWS key', awsKey, REDACTED],
    ['private key', `x ${pem} y`, `x ${REDACTED} y`],
    ['URL credentials', 'https://user:pa55@db.example.com/x', `https://${REDACTED}@db.example.com/x`],
    ['query token', 'GET /cb?code=abc123&state=s&access_token=zzz', `code=${REDACTED}&state=s&access_token=${REDACTED}`],
    ['assignment', 'password=hunter2 user=bob', `password=${REDACTED} user=bob`],
    ['json-ish assignment', '{"client_secret": "abc"}', `"client_secret": "${REDACTED}"`],
  ])('masks a %s', (_name, input, expected) => {
    const output = redactText(input);
    expect(output).toContain(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(redactText('Agent finished 3 tasks for project alpha')).toBe('Agent finished 3 tasks for project alpha');
  });
});

describe('redact', () => {
  it('masks sensitive keys and scrubs strings deeply', () => {
    const input = {
      headers: { authorization: 'Bearer x', Cookie: 'sid=1', 'set-cookie': ['a=b'], accept: 'json', 'x-api-key': 'k' },
      user: { password: 'p', name: 'Alice', profile: { apiKey: 'k', signing_key: 'k', publicKey: 'pk', idempotencyKey: 'ik' } },
      token: 'abc', tokens: 1234, inputTokens: 55, hasPassword: true, clientSecret: 'c', webhookUrl: 'https://chat.example.com/hooks/x',
      note: `see ${jwt}`,
      list: [{ secret: 's' }, 'Bearer zzzz'],
    };
    expect(redact(input)).toEqual({
      headers: { authorization: REDACTED, Cookie: REDACTED, 'set-cookie': REDACTED, accept: 'json', 'x-api-key': REDACTED },
      user: { password: REDACTED, name: 'Alice', profile: { apiKey: REDACTED, signing_key: REDACTED, publicKey: 'pk', idempotencyKey: 'ik' } },
      token: REDACTED, tokens: 1234, inputTokens: 55, hasPassword: true, clientSecret: REDACTED, webhookUrl: REDACTED,
      note: `see ${REDACTED}`,
      list: [{ secret: REDACTED }, `Bearer ${REDACTED}`],
    });
    expect(input.user.password).toBe('p');
  });

  it('handles special values', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    const shared = { a: 1 };
    expect(redact(cyclic)).toEqual({ name: 'x', self: '[Circular]' });
    expect(redact({ one: shared, two: shared })).toEqual({ one: { a: 1 }, two: { a: 1 } });
    expect(redact(10n)).toBe('10');
    expect(redact(null)).toBeNull();
    expect(redact(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(redact(new Date(Number.NaN))).toBeNull();
    expect(redact(Object.assign(new Error('password=abc'), { code: 'E1' }))).toEqual({ name: 'Error', message: `password=${REDACTED}`, code: 'E1' });
    expect(redact(new Error('plain'))).toEqual({ name: 'Error', message: 'plain' });
    expect(redact(new Map([['token', 'x'], ['ok', 'y']]))).toEqual({ token: REDACTED, ok: 'y' });
    expect(redact(new Set(['Bearer abcd']))).toEqual([`Bearer ${REDACTED}`]);
    expect(redact(new Uint8Array(4))).toBe('[Binary 4 bytes]');
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 15; i++) { deep['n'] = {}; deep = deep['n'] as Record<string, unknown>; }
    expect(JSON.stringify(redact(root))).toContain('[Truncated]');
  });

  it('masks extra keys and fetch Headers', () => {
    expect(redact({ ssn: '123', other: 'x' }, { keys: ['SSN'] })).toEqual({ ssn: REDACTED, other: 'x' });
    expect(redactHeaders(new Headers({ Authorization: 'Bearer x', Accept: 'json' }))).toEqual({ authorization: REDACTED, accept: 'json' });
    expect(redactHeaders({ cookie: 'a', host: 'example.com' })).toEqual({ cookie: REDACTED, host: 'example.com' });
  });

  it('classifies keys', () => {
    for (const key of ['Authorization', 'x-api-key', 'refresh_token', 'privateKey', 'key', 'session_id', 'AWS_SECRET_ACCESS_KEY', 'credentials']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['name', 'publicKey', 'idempotency-key', 'keys', 'kid', 'id']) expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('logger', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const capture = () => {
    const lines: Array<Record<string, unknown>> = [];
    return { lines, write: (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>); } };
  };

  it('writes one JSON line per entry with level, time and bindings', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write, now: () => 0, bindings: { service: 'hivemem' } });
    logger.info('started', { port: 8080 });
    expect(sink.lines).toEqual([{ service: 'hivemem', port: 8080, time: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'started' }]);
  });

  it('filters by level', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write, level: 'warn' });
    logger.trace('a'); logger.debug('b'); logger.info('c'); logger.warn('d'); logger.error('e'); logger.fatal('f');
    expect(sink.lines.map(line => line['level'])).toEqual(['warn', 'error', 'fatal']);
    expect(logger.isLevelEnabled('info')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
    const silent = capture();
    createLogger({ write: silent.write, level: 'silent' }).fatal('x');
    expect(silent.lines).toHaveLength(0);
  });

  it('reads LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');
    expect(createLogger().level).toBe('debug');
    vi.stubEnv('LOG_LEVEL', 'nonsense');
    expect(createLogger().level).toBe('info');
  });

  it('adds child bindings without losing parent ones', () => {
    const sink = capture();
    const child = createLogger({ write: sink.write, bindings: { service: 's' } }).child({ component: 'sync' });
    child.child({ job: 'j1' }).warn('slow');
    expect(sink.lines[0]).toMatchObject({ service: 's', component: 'sync', job: 'j1', msg: 'slow' });
  });

  it('adds the request ID and trace ID from the context, with context bindings', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write });
    const context = createRequestContext({ 'x-request-id': 'req-7' });
    context.bindings['tenant'] = 't1';
    runWithRequestContext(context, () => logger.info('handled'));
    expect(sink.lines[0]).toMatchObject({ requestId: 'req-7', traceId: context.trace.traceId, tenant: 't1' });
    logger.info('outside');
    expect(sink.lines[1]).not.toHaveProperty('requestId');
  });

  it('redacts secrets in fields and messages, and serialises errors', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write, redactKeys: ['ssn'] });
    const error = Object.assign(new Error(`failed with ${jwt}`), { code: 'E_AUTH', status: 401 });
    logger.error(`login Bearer ${'q'.repeat(10)}`, { err: error, headers: { authorization: 'Bearer x' }, ssn: '1' });
    expect(sink.lines[0]).toMatchObject({
      msg: `login Bearer ${REDACTED}`,
      err: { name: 'Error', message: `failed with ${REDACTED}`, code: 'E_AUTH', status: 401 },
      headers: { authorization: REDACTED },
      ssn: REDACTED,
    });
    expect(sink.lines[0]?.['err']).not.toHaveProperty('stack');
  });

  it('can include stacks and skip redaction', () => {
    const sink = capture();
    createLogger({ write: sink.write, stacks: true, redact: false }).error('x', { err: new Error('password=1'), token: 't' });
    expect(sink.lines[0]).toMatchObject({ token: 't', err: { message: 'password=1' } });
    expect((sink.lines[0]?.['err'] as Record<string, unknown>)['stack']).toBeTypeOf('string');
  });

  it('keeps reserved fields from being forged and survives unserialisable values', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write, redact: false });
    logger.info('real', { level: 'fatal', msg: 'forged', big: 5n });
    expect(sink.lines[0]).toMatchObject({ level: 'info', msg: 'real', big: '5' });
    const lines: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    createLogger({ write: line => lines.push(line), redact: false }).info('x', { cyclic });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ msg: 'log entry could not be serialised' });
  });

  it('writes to stdout by default', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createLogger({ level: 'info' }).info('hello');
      expect(String(spy.mock.calls[0]?.[0])).toMatch(/"msg":"hello"\}\n$/);
    } finally {
      spy.mockRestore();
    }
  });
});
