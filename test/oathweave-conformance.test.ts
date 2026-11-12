import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  hiveCommonConformanceVerify, loadOathweaveVectors, runOathweaveConformance, type ConformanceVectors,
} from '../src/oathweave/conformance.js';
import { createOathweaveVerifier } from '../src/oathweave/index.js';

const REQUIRED = ['valid-user', 'valid-service', 'expired', 'not-yet-valid', 'wrong-audience', 'wrong-issuer',
  'bad-signature', 'unknown-kid', 'alg-none', 'hs256-confusion'];

describe('shipped vectors', () => {
  it('contain every required case, a public-only JWKS and a fixed clock', async () => {
    const vectors = await loadOathweaveVectors();
    expect(vectors.vectors.map(vector => vector.name)).toEqual(expect.arrayContaining(REQUIRED));
    expect(vectors.now).toBe('2026-01-01T00:00:00.000Z');
    for (const key of vectors.jwks.keys) {
      expect(key).not.toHaveProperty('d');
      expect(key).not.toHaveProperty('p');
      expect(key.kty).toBe('RSA');
    }
    const standalone = JSON.parse(readFileSync(new URL('../test-vectors/oathweave/jwks.json', import.meta.url), 'utf8')) as unknown;
    expect(standalone).toEqual(vectors.jwks);
    expect(vectors.issuer).toMatch(/\.example\.test$/);
  });

  it('pass against this package\'s verifier, including reasons', async () => {
    const report = await runOathweaveConformance(hiveCommonConformanceVerify(), { strictReasons: true });
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(REQUIRED.length);
  });

  it('pass through the URL-based context fetch and session check', async () => {
    const report = await runOathweaveConformance((token, context) => createOathweaveVerifier({
      issuer: context.issuer, audience: context.audience, jwksUrl: context.jwksUrl, userinfoUrl: context.userinfoUrl,
      fetch: context.fetch, now: () => context.nowMs, accept: context.principal,
    }).verify(token), { strictReasons: true });
    expect(report.failed).toBe(0);
  });
});

describe('the runner', () => {
  it('fails a verifier that accepts everything, with a readable message', async () => {
    await expect(runOathweaveConformance(async () => ({}))).rejects.toThrow(/alg-none: accepted a token that must be refused/);
    const report = await runOathweaveConformance(async () => ({}), { throwOnFailure: false });
    expect(report.passed).toBe(2);
    expect(report.results.find(result => result.name === 'expired')).toMatchObject({ passed: false, expected: 'reject', actual: 'accept' });
  });

  it('fails a verifier that refuses everything', async () => {
    const report = await runOathweaveConformance(async () => { throw new Error('no'); }, { throwOnFailure: false });
    expect(report.results.find(result => result.name === 'valid-user')?.problem).toMatch(/refused a valid token: no/);
    expect(report.failed).toBe(2);
  });

  it('checks exposed result fields and error statuses', async () => {
    const wrongKind = await runOathweaveConformance(async () => ({ kind: 'other', subject: 'x' }), { only: ['valid-user'], throwOnFailure: false });
    expect(wrongKind.results[0]?.problem).toMatch(/kind other/);
    const wrongSubject = await runOathweaveConformance(async () => ({ subject: 'x' }), { only: ['valid-user'], throwOnFailure: false });
    expect(wrongSubject.results[0]?.problem).toMatch(/subject/);
    const wrongRoles = await runOathweaveConformance(async () => ({ roles: ['ADMIN'] }), { only: ['valid-user'], throwOnFailure: false });
    expect(wrongRoles.results[0]?.problem).toMatch(/roles differ/);
    const wrongStatus = await runOathweaveConformance(async () => { throw Object.assign(new Error('x'), { status: 500 }); }, { only: ['expired'], throwOnFailure: false });
    expect(wrongStatus.results[0]?.problem).toMatch(/status 500/);
    const statusCode = await runOathweaveConformance(async () => { throw Object.assign(new Error('x'), { statusCode: 401 }); }, { only: ['expired'], throwOnFailure: false });
    expect(statusCode.failed).toBe(0);
    const reason = await runOathweaveConformance(async () => { throw Object.assign(new Error('x'), { reason: 'nope' }); }, { only: ['expired'], strictReasons: true, throwOnFailure: false });
    expect(reason.results[0]?.problem).toMatch(/reason nope/);
    const thrownString = await runOathweaveConformance(async () => { throw 'plain'; }, { only: ['valid-user'], throwOnFailure: false });
    expect(thrownString.results[0]?.problem).toMatch(/plain/);
  });

  it('accepts injected vectors and serves the context fetch', async () => {
    const vectors = await loadOathweaveVectors();
    const custom: ConformanceVectors = { ...vectors, vectors: vectors.vectors.slice(0, 1) };
    let seen: Response[] = [];
    const report = await runOathweaveConformance(async (_token, context) => {
      seen = await Promise.all([
        context.fetch(context.jwksUrl),
        context.fetch(new URL(context.userinfoUrl), { headers: { authorization: `Bearer ${context.vector.token}` } }),
        context.fetch(new Request(context.userinfoUrl)),
        context.fetch('https://oathweave.example.test/other'),
      ]);
      return {};
    }, { vectors: custom });
    expect(report.passed).toBe(1);
    expect(seen.map(response => response.status)).toEqual([200, 200, 401, 404]);
  });
});
