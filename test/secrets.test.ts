import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearerMatchesSha256Digest, matchesSha256Digest, readBearerToken, sha256Hex, timingSafeEqualString } from '../src/secrets/index.js';

const TOKEN = 'fixture-token';
const DIGEST = createHash('sha256').update(TOKEN).digest('hex');

describe('timingSafeEqualString', () => {
  it('compares strings by their bytes', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
    expect(timingSafeEqualString('é', 'e')).toBe(false);
    expect(timingSafeEqualString('é', 'é')).toBe(true);
    expect(timingSafeEqualString(undefined as never, 'a')).toBe(false);
    expect(timingSafeEqualString('a', null as never)).toBe(false);
  });
});

describe('matchesSha256Digest', () => {
  it('matches a token against its stored digest', () => {
    expect(sha256Hex(TOKEN)).toBe(DIGEST);
    expect(matchesSha256Digest(TOKEN, DIGEST)).toBe(true);
    expect(matchesSha256Digest('other-token', DIGEST)).toBe(false);
    expect(matchesSha256Digest(TOKEN, DIGEST.toUpperCase())).toBe(false);
    expect(matchesSha256Digest(TOKEN, DIGEST.toUpperCase(), { caseInsensitive: true })).toBe(true);
  });

  it('never matches an unset digest or an empty token', () => {
    expect(matchesSha256Digest(TOKEN, undefined)).toBe(false);
    expect(matchesSha256Digest(TOKEN, '')).toBe(false);
    expect(matchesSha256Digest(TOKEN, null)).toBe(false);
    expect(matchesSha256Digest('', sha256Hex(''))).toBe(false);
    expect(matchesSha256Digest(undefined, DIGEST)).toBe(false);
    expect(matchesSha256Digest(null, DIGEST)).toBe(false);
  });
});

describe('readBearerToken', () => {
  it('reads a single bearer token', () => {
    expect(readBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(readBearerToken(`bearer   ${TOKEN}  `)).toBe(TOKEN);
    expect(readBearerToken([`Bearer ${TOKEN}`])).toBe(TOKEN);
    expect(readBearerToken('Bearer a+b/c=')).toBe('a+b/c=');
  });

  it('is undefined for anything else', () => {
    for (const header of [undefined, null, '', 'Bearer', 'Bearer ', `Basic ${TOKEN}`, 'Bearer a b', TOKEN, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`], [], [5 as never]]) {
      expect(readBearerToken(header)).toBeUndefined();
    }
    expect(readBearerToken(`bearer ${TOKEN}`, { caseSensitiveScheme: true })).toBeUndefined();
    expect(readBearerToken(`Bearer ${TOKEN}`, { caseSensitiveScheme: true })).toBe(TOKEN);
  });

  it('accepts a bare credential only when asked', () => {
    expect(readBearerToken(TOKEN, { allowBare: true })).toBe(TOKEN);
    expect(readBearerToken(` ${TOKEN} `, { allowBare: true })).toBe(TOKEN);
    expect(readBearerToken(`Bearer ${TOKEN}`, { allowBare: true })).toBe(TOKEN);
    expect(readBearerToken('two words', { allowBare: true })).toBeUndefined();
    expect(readBearerToken('  ', { allowBare: true })).toBeUndefined();
  });
});

describe('bearerMatchesSha256Digest', () => {
  it('checks an Authorization header against a stored digest', () => {
    expect(bearerMatchesSha256Digest(`Bearer ${TOKEN}`, DIGEST)).toBe(true);
    expect(bearerMatchesSha256Digest('Bearer other-token', DIGEST)).toBe(false);
    expect(bearerMatchesSha256Digest(undefined, DIGEST)).toBe(false);
    expect(bearerMatchesSha256Digest(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(bearerMatchesSha256Digest(TOKEN, DIGEST)).toBe(false);
    expect(bearerMatchesSha256Digest(TOKEN, DIGEST.toUpperCase(), { allowBare: true, caseInsensitive: true })).toBe(true);
  });
});
