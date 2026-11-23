/**
 * Artifact transfer v2 vocabulary and rendition selection.
 *
 * Isomorphic: no Node built-ins and no runtime dependencies.
 *
 * An original is never rewritten. A preview or model-input rendition is a separate artifact
 * with its own digest that names the original it was derived from; a consumer chooses the
 * rendition that suits its purpose and can always reach the original.
 */

/** The capability URN a runtime advertises when it serves transfer v2. */
export const ARTIFACT_TRANSFER_V2_URN = 'urn:hive:artifact-transfer:2';
/** The media type of an A2A data part that carries a v2 descriptor. */
export const ARTIFACT_TRANSFER_V2_MEDIA_TYPE = 'application/vnd.hive.artifact-transfer.v2+json';
/** The largest artifact the v1 (single-response) team transfer carries. */
export const ARTIFACT_TRANSFER_V1_MAX_BYTES = 2 * 1024 * 1024;

/** Stable outcome codes of a transfer that did not complete. */
export const ARTIFACT_TRANSFER_ERRORS = {
  /** The peer does not advertise v2 and the artifact is larger than the v1 limit. */
  requiresV2: 'TRANSFER_REQUIRES_V2',
  /** The received bytes do not hash to the declared digest. */
  digestMismatch: 'DIGEST_MISMATCH',
  /** The artifact is larger than the negotiated limit. */
  tooLarge: 'TRANSFER_TOO_LARGE',
  /** The source no longer serves the artifact (revoked or expired). */
  gone: 'TRANSFER_SOURCE_GONE',
} as const;

export type RenditionRole = 'original' | 'preview' | 'model_input';
export type RenditionPurpose = 'display' | 'model_input' | 'download';

/** One available form of an artifact. */
export interface Rendition {
  readonly sha256: string;
  readonly role: RenditionRole;
  readonly mime: string;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly has_alpha?: boolean;
}

export interface RenditionRequest {
  readonly purpose: RenditionPurpose;
  /** The largest rendition the consumer can take. Ignored for `download`. */
  readonly maxBytes?: number;
  /** Media types the consumer can render. An entry ending in `/*` matches a family. */
  readonly acceptMime?: readonly string[];
  /** The consumer needs transparency preserved (for example a PNG map overlay). */
  readonly needsAlpha?: boolean;
}

function accepts(mime: string, accept: readonly string[] | undefined): boolean {
  if (!accept?.length) return true;
  return accept.some(entry => entry === mime || (entry.endsWith('/*') && mime.startsWith(entry.slice(0, -1))));
}

/**
 * The rendition that suits `request`: `download` always gives the original; `display` prefers
 * a preview, `model_input` a model-input rendition, each falling back to the original. Among
 * candidates that fit `maxBytes`, `acceptMime` and `needsAlpha`, the largest wins. Undefined
 * only when nothing fits and there is no original.
 */
export function selectRendition(renditions: readonly Rendition[], request: RenditionRequest): Rendition | undefined {
  const original = renditions.find(item => item.role === 'original');
  if (request.purpose === 'download') return original;
  const preferred: RenditionRole = request.purpose === 'display' ? 'preview' : 'model_input';
  const fits = (item: Rendition) => (request.maxBytes === undefined || item.size <= request.maxBytes)
    && accepts(item.mime, request.acceptMime) && (!request.needsAlpha || item.has_alpha !== false);
  const pick = (role: RenditionRole) => renditions.filter(item => item.role === role && fits(item)).sort((a, b) => b.size - a.size)[0];
  return pick(preferred) ?? (request.purpose === 'model_input' ? pick('preview') : undefined) ?? (original && fits(original) ? original : undefined) ?? original;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** The `Repr-Digest` header value (RFC 9530) for a hex SHA-256 digest. */
export function formatReprDigest(sha256Hex: string): string {
  if (!HEX_SHA256.test(sha256Hex)) throw new TypeError('A SHA-256 digest is 64 lowercase hex characters');
  let binary = '';
  for (let index = 0; index < 64; index += 2) binary += String.fromCharCode(Number.parseInt(sha256Hex.slice(index, index + 2), 16));
  return `sha-256=:${btoa(binary)}:`;
}

/** The hex SHA-256 in a `Repr-Digest` header, or undefined. */
export function parseReprDigest(value: string | null | undefined): string | undefined {
  const match = typeof value === 'string' ? /(?:^|,)\s*sha-256=:([A-Za-z0-9+/]{43}=):/.exec(value) : null;
  if (!match?.[1]) return undefined;
  try {
    return Array.from(atob(match[1]), char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/** A single byte range request: `bytes=<start>-` or `bytes=<start>-<end>`. */
export interface ByteRange { readonly start: number; readonly end: number }

/**
 * The byte range a `Range` header asks for within `size` bytes, `null` when it is
 * unsatisfiable (answer 416), or undefined when there is no usable single range (serve all).
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | null | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (!first && !last) return undefined;
  if (!first) {
    const suffix = Number(last);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  if (start >= size || end < start) return null;
  return { start, end };
}
