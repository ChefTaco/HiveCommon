import { describe, expect, it } from 'vitest';
import { formatReprDigest, parseByteRange, parseReprDigest, selectRendition, type Rendition } from '../src/artifact/index.js';

const ORIGINAL: Rendition = { sha256: 'a'.repeat(64), role: 'original', mime: 'image/png', size: 9_000_000, has_alpha: true };
const PREVIEW: Rendition = { sha256: 'b'.repeat(64), role: 'preview', mime: 'image/webp', size: 400_000, has_alpha: false };
const PREVIEW_PNG: Rendition = { sha256: 'c'.repeat(64), role: 'preview', mime: 'image/png', size: 900_000, has_alpha: true };
const MODEL: Rendition = { sha256: 'd'.repeat(64), role: 'model_input', mime: 'image/png', size: 300_000, has_alpha: true };

describe('selectRendition', () => {
  const all = [ORIGINAL, PREVIEW, PREVIEW_PNG, MODEL];
  it('always downloads the original', () => {
    expect(selectRendition(all, { purpose: 'download', maxBytes: 1 })).toBe(ORIGINAL);
    expect(selectRendition([PREVIEW], { purpose: 'download' })).toBeUndefined();
  });
  it('prefers the role for the purpose, within the constraints', () => {
    expect(selectRendition(all, { purpose: 'display' })).toBe(PREVIEW_PNG);
    expect(selectRendition(all, { purpose: 'display', needsAlpha: false, maxBytes: 500_000 })).toBe(PREVIEW);
    expect(selectRendition(all, { purpose: 'display', acceptMime: ['image/webp'] })).toBe(PREVIEW);
    expect(selectRendition(all, { purpose: 'display', acceptMime: ['image/*'], needsAlpha: true })).toBe(PREVIEW_PNG);
    expect(selectRendition(all, { purpose: 'model_input' })).toBe(MODEL);
    expect(selectRendition([ORIGINAL, PREVIEW], { purpose: 'model_input' })).toBe(PREVIEW);
  });
  it('falls back to the original, even when it does not fit', () => {
    expect(selectRendition([ORIGINAL], { purpose: 'display' })).toBe(ORIGINAL);
    expect(selectRendition([ORIGINAL, PREVIEW], { purpose: 'display', acceptMime: ['application/pdf'] })).toBe(ORIGINAL);
  });
});

describe('digests and ranges', () => {
  it('round-trips Repr-Digest', () => {
    const hex = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    const header = formatReprDigest(hex);
    expect(header).toBe('sha-256=:n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=:');
    expect(parseReprDigest(`sha-512=:x:, ${header}`)).toBe(hex);
    expect(parseReprDigest('sha-256=:short:')).toBeUndefined();
    expect(parseReprDigest(undefined)).toBeUndefined();
    expect(() => formatReprDigest('XYZ')).toThrow(TypeError);
  });
  it('parses single byte ranges', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=1000-', 1000)).toBeNull();
    expect(parseByteRange('bytes=-0', 1000)).toBeNull();
    expect(parseByteRange('bytes=5-1', 1000)).toBeNull();
    for (const header of [undefined, 'items=0-1', 'bytes=0-1,5-6', 'bytes=-']) expect(parseByteRange(header, 1000)).toBeUndefined();
  });
});
