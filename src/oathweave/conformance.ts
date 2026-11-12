/**
 * Oathweave verifier conformance. The package ships `test-vectors/oathweave/vectors.json`:
 * a test JWKS and pre-signed tokens with expected outcomes, evaluated at a fixed clock so
 * the vectors never rot. Each product runs them against its own verifier:
 *
 *   const report = await runOathweaveConformance((token, ctx) => myVerify(token, ctx));
 */
import { readFile } from 'node:fs/promises';
import type { JSONWebKeySet } from 'jose';
import type { PrincipalKind } from './claims.js';
import type { OathweaveFailureReason } from './errors.js';
import { createOathweaveVerifier } from './verifier.js';

export type ConformanceExpectation =
  | {
    readonly outcome: 'accept';
    readonly kind: PrincipalKind;
    readonly subject: string;
    readonly clientId: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
    readonly scopes: readonly string[];
  }
  | { readonly outcome: 'reject'; readonly status: 401 | 403 | 503; readonly reason: OathweaveFailureReason };

export interface ConformanceVector {
  readonly name: string;
  readonly description: string;
  /** The principal kind the token claims to be, for products with separate user and service verifiers. */
  readonly principal: PrincipalKind;
  readonly token: string;
  readonly expect: ConformanceExpectation;
}

export interface ConformanceVectors {
  readonly schema: 1;
  readonly issuer: string;
  /** Native issuer identifiers the verifier under test must be configured to accept. */
  readonly nativeIssuers?: readonly string[];
  readonly audience: string;
  readonly jwksUrl: string;
  readonly userinfoUrl: string;
  /** The fixed evaluation time, RFC 3339. */
  readonly now: string;
  readonly jwks: JSONWebKeySet;
  readonly vectors: readonly ConformanceVector[];
}

export interface ConformanceContext {
  readonly issuer: string;
  /**
   * Native issuer identifiers (such as `hive-iam`) to configure alongside `issuer`, for service
   * tokens. Empty when the vectors have none.
   */
  readonly nativeIssuers: readonly string[];
  readonly audience: string;
  readonly jwks: JSONWebKeySet;
  readonly jwksUrl: string;
  readonly userinfoUrl: string;
  /** The fixed clock. Verifiers must evaluate time claims at this instant. */
  readonly now: Date;
  readonly nowMs: number;
  readonly principal: PrincipalKind;
  readonly vector: ConformanceVector;
  /**
   * A fetch that serves `jwksUrl` and `userinfoUrl` for the vectors, for verifiers that only
   * take URLs. Userinfo answers with the bearer token's own subject, as an active session would.
   */
  readonly fetch: typeof fetch;
}

/** Verify `token` with the product's verifier. Resolve on acceptance, reject on refusal. */
export type ConformanceVerify = (token: string, context: ConformanceContext) => Promise<unknown>;

export interface ConformanceResult {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: ConformanceExpectation['outcome'];
  readonly actual: 'accept' | 'reject';
  /** Why a vector failed. */
  readonly problem?: string;
}

export interface ConformanceReport {
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly ConformanceResult[];
}

export interface ConformanceOptions {
  /** Use these vectors instead of the shipped file. */
  readonly vectors?: ConformanceVectors;
  /** Also require a matching `reason` on refusals (HiveCommon's OathweaveError has one). */
  readonly strictReasons?: boolean;
  /** Throw when any vector fails. Defaults to true, so a test fails with a readable message. */
  readonly throwOnFailure?: boolean;
  /** Run only vectors with these names. */
  readonly only?: readonly string[];
}

/** Load the shipped vectors. */
export async function loadOathweaveVectors(): Promise<ConformanceVectors> {
  const file = new URL('../../test-vectors/oathweave/vectors.json', import.meta.url);
  return JSON.parse(await readFile(file, 'utf8')) as ConformanceVectors;
}

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function vectorFetch(vectors: ConformanceVectors): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === vectors.jwksUrl) return Response.json(vectors.jwks);
    if (url === vectors.userinfoUrl) {
      const header = new Headers(init?.headers).get('authorization') ?? '';
      const token = /^Bearer (.+)$/.exec(header)?.[1];
      if (!token) return new Response('', { status: 401 });
      const payload = decodePayload(token);
      return Response.json({ sub: payload['sub'], name: 'Conformance User' });
    }
    return new Response('', { status: 404 });
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

function checkAccepted(expect: Extract<ConformanceExpectation, { outcome: 'accept' }>, value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  // Only fields the verifier exposes are compared, so differently-shaped results still pass.
  if (typeof result['kind'] === 'string' && result['kind'] !== expect.kind) return `kind ${String(result['kind'])}, expected ${expect.kind}`;
  if (typeof result['subject'] === 'string' && result['subject'] !== expect.subject) return 'subject differs';
  for (const field of ['roles', 'permissions', 'scopes'] as const) {
    const actual = result[field];
    if (Array.isArray(actual) && !sameSet(actual as string[], expect[field])) return `${field} differ`;
  }
  return undefined;
}

function checkRejected(expect: Extract<ConformanceExpectation, { outcome: 'reject' }>, error: unknown, strict: boolean): string | undefined {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const status = record['status'] ?? record['statusCode'];
  if (typeof status === 'number' && status !== expect.status) return `status ${status}, expected ${expect.status}`;
  if (strict && record['reason'] !== expect.reason) return `reason ${String(record['reason'])}, expected ${expect.reason}`;
  return undefined;
}

/**
 * Run every vector through `verify` at the vectors' fixed clock. A vector expecting acceptance
 * passes when `verify` resolves (and any `kind`, `subject`, `roles`, `permissions` or `scopes`
 * on the result match); one expecting refusal passes when it rejects (and any numeric
 * `status` on the error matches, plus `reason` with `strictReasons`).
 */
export async function runOathweaveConformance(verify: ConformanceVerify, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const vectors = options.vectors ?? await loadOathweaveVectors();
  const fixed = new Date(vectors.now);
  const fetcher = vectorFetch(vectors);
  const results: ConformanceResult[] = [];
  for (const vector of vectors.vectors) {
    if (options.only && !options.only.includes(vector.name)) continue;
    const context: ConformanceContext = {
      issuer: vectors.issuer,
      nativeIssuers: vectors.nativeIssuers ?? [],
      audience: vectors.audience,
      jwks: vectors.jwks,
      jwksUrl: vectors.jwksUrl,
      userinfoUrl: vectors.userinfoUrl,
      now: new Date(fixed),
      nowMs: fixed.getTime(),
      principal: vector.principal,
      vector,
      fetch: fetcher,
    };
    let actual: 'accept' | 'reject';
    let problem: string | undefined;
    try {
      const value = await verify(vector.token, context);
      actual = 'accept';
      if (vector.expect.outcome === 'accept') problem = checkAccepted(vector.expect, value);
      else problem = `accepted a token that must be refused (${vector.expect.reason})`;
    } catch (error) {
      actual = 'reject';
      if (vector.expect.outcome === 'reject') problem = checkRejected(vector.expect, error, options.strictReasons ?? false);
      else problem = `refused a valid token: ${error instanceof Error ? error.message : String(error)}`;
    }
    results.push({ name: vector.name, passed: problem === undefined, expected: vector.expect.outcome, actual, ...(problem ? { problem } : {}) });
  }
  const failed = results.filter(result => !result.passed);
  const report = { passed: results.length - failed.length, failed: failed.length, results };
  if (failed.length && (options.throwOnFailure ?? true)) {
    throw new Error(`Oathweave conformance failed for ${failed.length} of ${results.length} vectors:\n${failed.map(result => `- ${result.name}: ${result.problem}`).join('\n')}`);
  }
  return report;
}

/** A `ConformanceVerify` for this package's own verifier, for products that adopt it as is. */
export function hiveCommonConformanceVerify(): ConformanceVerify {
  return (token, context) => createOathweaveVerifier({
    issuer: context.issuer,
    nativeIssuers: context.nativeIssuers,
    audience: context.audience,
    keys: context.jwks,
    now: () => context.nowMs,
    accept: 'any',
  }).verify(token);
}
