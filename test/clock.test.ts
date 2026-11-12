/**
 * Default clocks read `Date.now()` on every call, so fake timers work even on objects created
 * before the timers were installed. Nothing here passes a `now` option.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestContext } from '../src/context/index.js';
import { MemoryDedupeStore } from '../src/events/index.js';
import { createHealth, liveness, readiness } from '../src/health/index.js';
import { createLogger } from '../src/log/index.js';
import { createOathweaveVerifier, OathweaveError, watchStreamAuthorization } from '../src/oathweave/index.js';
import { AUDIENCE, ISSUER, mint, NOW_MS, NOW_SEC, stubFetch, testKeys, userClaims, USERINFO_URL } from './helpers.js';

const keys = await testKeys();
const NOW_ISO = new Date(NOW_MS).toISOString();

afterEach(() => { vi.useRealTimers(); });

describe('default clocks under fake timers', () => {
  it('verifier: checks token times against the current fake time', async () => {
    // Created before the fake timers, as a product creates it at startup.
    const verifier = createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: keys.jwks });
    const token = await mint(keys, userClaims());
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    await expect(verifier.verify(token)).resolves.toMatchObject({ subject: 'user-subject' });
    vi.setSystemTime(NOW_MS + 1_000_000);
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('verifier: expires the session cache by the current fake time', async () => {
    const stub = stubFetch({ [USERINFO_URL]: () => Response.json({ sub: 'user-subject', name: 'Alice' }) });
    const verifier = createOathweaveVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: keys.jwks, userinfoUrl: USERINFO_URL, fetch: stub.fetch });
    const token = await mint(keys, userClaims());
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    await verifier.verify(token);
    await verifier.verify(token);
    expect(stub.calls).toHaveLength(1);
    vi.setSystemTime(NOW_MS + 10_001);
    await verifier.verify(token);
    expect(stub.calls).toHaveLength(2);
  });

  it('stream re-check: ends the stream at expiry by the fake clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const onEnd = vi.fn();
    watchStreamAuthorization({ recheck: async () => ({ expiresAt: NOW_SEC + 60 }), expiresAt: NOW_SEC + 60, onEnd, intervalMs: 1_000_000 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((onEnd.mock.calls[0]?.[0] as OathweaveError).reason).toBe('expired');
  });

  it('dedupe store: expires claims by the current fake time', () => {
    const store = new MemoryDedupeStore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    expect(store.claim('a', 1000)).toBe(true);
    expect(store.claim('a', 1000)).toBe(false);
    vi.setSystemTime(NOW_MS + 1000);
    expect(store.claim('a', 1000)).toBe(true);
  });

  it('health: stamps liveness and readiness with the current fake time', async () => {
    const health = createHealth();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    expect(health.live().body.time).toBe(NOW_ISO);
    expect(liveness().body.time).toBe(NOW_ISO);
    expect((await readiness()).body.time).toBe(NOW_ISO);
    expect((await health.ready()).body.time).toBe(NOW_ISO);
  });

  it('logger and request context: use the current fake time', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: line => { lines.push(line); } });
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    logger.info('tick');
    expect(JSON.parse(lines[0] as string)).toMatchObject({ time: NOW_ISO });
    expect(createRequestContext({}).startedAt).toBe(NOW_MS);
  });
});
