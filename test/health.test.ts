import { describe, expect, it } from 'vitest';
import { createHealth, HEALTH_PATHS, healthPaths, LEGACY_HEALTH_ALIASES, liveness, readiness, resolveHealthPath } from '../src/health/index.js';

const now = () => Date.UTC(2026, 0, 1);

describe('liveness', () => {
  it('is always 200 and never runs checks', () => {
    const response = liveness({ service: 'hivemem', version: '1.2.3', now, checks: [{ name: 'db', check: () => { throw new Error('x'); } }] });
    expect(response).toEqual({
      status: 200,
      body: { status: 'live', service: 'hivemem', version: '1.2.3', time: '2026-01-01T00:00:00.000Z' },
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
    expect(liveness().body).not.toHaveProperty('service');
  });

  it('serves a product body object as is', () => {
    const published = { status: 'ok' };
    const response = liveness({ service: 'studio', now, liveBody: published });
    expect(response).toEqual({
      status: 200,
      body: { status: 'ok' },
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
    expect(response.body).not.toBe(published);
    const typed: { status: string } = response.body;
    expect(typed.status).toBe('ok');
  });

  it('builds a product body from the standard one on every call', () => {
    let calls = 0;
    const options = {
      service: 'hive-skills', version: '1.3.5', now,
      liveBody: (standard: { service?: string; version?: string }) => ({ version: standard.version, status: 'ok', service: standard.service, protocol: 1, call: ++calls }),
    };
    expect(liveness(options).body).toEqual({ version: '1.3.5', status: 'ok', service: 'hive-skills', protocol: 1, call: 1 });
    expect(liveness(options).body.call).toBe(2);
  });

  it('refuses a liveBody that is not an object or a function', () => {
    for (const value of ['ok', 1, null, ['ok']]) {
      expect(() => liveness({ liveBody: value as never })).toThrow(/liveBody/);
      expect(() => createHealth({ liveBody: value as never })).toThrow(/liveBody/);
    }
  });

  it('leaves readiness unchanged', async () => {
    const health = createHealth({ now, liveBody: { status: 'ok' } });
    expect(health.live().body).toEqual({ status: 'ok' });
    expect(await health.handle('/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect((await health.ready()).body).toEqual({ status: 'ready', time: '2026-01-01T00:00:00.000Z', checks: {} });
  });
});

describe('readiness', () => {
  it('is ready with no checks', async () => {
    expect((await readiness({ now })).body).toEqual({ status: 'ready', time: '2026-01-01T00:00:00.000Z', checks: {} });
  });

  it('reports each check, accepting void, true and ok objects', async () => {
    const response = await readiness({
      now,
      checks: [
        { name: 'void', check: () => undefined },
        { name: 'true', check: async () => true },
        { name: 'object', check: () => ({ ok: true, details: { pending: 2 } }) },
        { name: 'implicit', check: () => ({ details: { x: 1 } }) },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks['object']).toEqual({ status: 'up', critical: true, latencyMs: 0, details: { pending: 2 } });
    expect(response.body.checks['implicit']?.status).toBe('up');
  });

  it('is 503 when a critical check is down, 200 degraded for a non-critical one', async () => {
    const down = await readiness({ checks: [{ name: 'db', check: () => false }, { name: 'cache', check: () => true }] });
    expect(down.status).toBe(503);
    expect(down.body.status).toBe('not_ready');
    expect(down.body.checks['db']).toMatchObject({ status: 'down', error: 'failed' });

    const degraded = await readiness({ checks: [{ name: 'search', critical: false, check: () => ({ ok: false }) }] });
    expect(degraded.status).toBe(200);
    expect(degraded.body.status).toBe('degraded');
    expect(degraded.body.checks['search']).toMatchObject({ status: 'down', critical: false });
  });

  it('hides error messages unless asked', async () => {
    const check = { name: 'db', check: () => { throw new Error('connect ECONNREFUSED db.internal.example.test'); } };
    expect((await readiness({ checks: [check] })).body.checks['db']?.error).toBe('failed');
    expect((await readiness({ checks: [check], exposeErrors: true })).body.checks['db']?.error).toMatch(/ECONNREFUSED/);
    const blank = { name: 'x', check: () => { throw new Error(''); } };
    expect((await readiness({ checks: [blank], exposeErrors: true })).body.checks['x']?.error).toBe('failed');
  });

  it('times out slow checks and aborts their signal', async () => {
    let aborted = false;
    const started = Date.now();
    const response = await readiness({
      timeoutMs: 1000,
      checks: [{
        name: 'slow',
        timeoutMs: 20,
        check: signal => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; }); setTimeout(resolve, 5_000); }),
      }],
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.status).toBe(503);
    expect(response.body.checks['slow']).toMatchObject({ status: 'down', error: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('runs checks concurrently', async () => {
    const started = Date.now();
    const wait = () => new Promise<void>(resolve => setTimeout(resolve, 50));
    await readiness({ checks: [{ name: 'a', check: wait }, { name: 'b', check: wait }, { name: 'c', check: wait }] });
    expect(Date.now() - started).toBeLessThan(140);
  });

  it('requires unique names', async () => {
    await expect(readiness({ checks: [{ name: 'a', check: () => true }, { name: 'a', check: () => true }] })).rejects.toThrow(/unique/);
    await expect(readiness({ checks: [{ name: '', check: () => true }] })).rejects.toThrow(/unique/);
  });
});

describe('paths', () => {
  it('resolves standard paths and, when enabled, aliases', () => {
    expect(resolveHealthPath('/health/live')).toBe('live');
    expect(resolveHealthPath('/health/ready/')).toBe('ready');
    expect(resolveHealthPath('/healthz')).toBeUndefined();
    expect(resolveHealthPath('/healthz', true)).toBe('live');
    expect(resolveHealthPath('/readyz', true)).toBe('ready');
    expect(resolveHealthPath('/custom', { ready: ['/custom'] })).toBe('ready');
    expect(resolveHealthPath('/custom', { live: ['/custom'] })).toBe('live');
    expect(resolveHealthPath('/', true)).toBeUndefined();
    expect(healthPaths(true).live).toEqual([HEALTH_PATHS.live, ...LEGACY_HEALTH_ALIASES.live]);
    expect(healthPaths()).toEqual({ live: ['/health/live'], ready: ['/health/ready'] });
  });

  it('serves through createHealth', async () => {
    const health = createHealth({ aliases: true, checks: [{ name: 'db', check: () => false }] });
    expect((await health.handle('/healthz'))?.status).toBe(200);
    expect((await health.handle('/ready'))?.status).toBe(503);
    expect(health.handle('/v1/things')).toBeUndefined();
    expect(health.live().status).toBe(200);
    expect((await health.ready()).status).toBe(503);
    expect(health.paths.ready).toContain('/readyz');
  });
});
