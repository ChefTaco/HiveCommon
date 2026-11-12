/**
 * Secret redaction for logs and diagnostics. Follows the suite pattern (secret-looking keys
 * are masked, strings are scrubbed of credentials) and adds headers, JWTs, URL credentials,
 * provider token formats and cycle-safe traversal.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 10;

/** Key fragments, compared after lowercasing and removing `-`, `_` and `.`. */
const SENSITIVE_KEY_PARTS = [
  'authorization', 'cookie', 'password', 'passwd', 'passphrase', 'secret', 'token',
  'apikey', 'privatekey', 'accesskey', 'signingkey', 'credential', 'webhookurl', 'sessionid',
];
/** Keys that end in "key" but are not secret. */
const NON_SECRET_KEYS = new Set(['publickey', 'idempotencykey', 'cachekey', 'sortkey', 'partitionkey', 'primarykey', 'foreignkey']);

/** True for a key whose value should never be logged. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_.\s]/g, '');
  if (NON_SECRET_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEY_PARTS.some(part => normalized.includes(part))) return true;
  // key, apiKey, signing_key, x-api-key, keyMaterial...; not "keys", "monkey" is accepted collateral.
  return normalized === 'key' || normalized.endsWith('key') || normalized.startsWith('keymaterial');
}

const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Authorization schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${REDACTED}`],
  // JWT / JWS compact serialisations (header.payload.signature, signature may be empty).
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Provider key formats.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // Credentials in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Secret-looking query parameters and key=value / key: value pairs.
  [/([?&](?:access_token|refresh_token|id_token|token|code|client_secret|api_key|apikey|key|password|sig|signature)=)[^&#\s]+/gi, `$1${REDACTED}`],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|private[_-]?key)["']?\s*[:=]\s*["']?)[^"',\s}&]+/gi, `$1${REDACTED}`],
];

/** Scrub credentials out of free text. */
export function redactText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of TEXT_RULES) text = text.replace(pattern, replacement);
  return text;
}

export interface RedactOptions {
  /** Extra keys to mask, compared case-insensitively and exactly. */
  readonly keys?: readonly string[];
}

/**
 * A deep copy of `value` with secrets masked. Sensitive keys holding strings, objects or
 * arrays are replaced by `[REDACTED]`; numbers and booleans under such keys (token counts,
 * `hasPassword` flags) are kept. Strings everywhere are scrubbed with `redactText()`.
 * Errors become `{ name, message, code? }`; cycles become `[Circular]`.
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const extra = new Set((options.keys ?? []).map(key => key.toLowerCase()));
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return redactText(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(item);
    try {
      if (item instanceof Date) return Number.isNaN(item.getTime()) ? null : item.toISOString();
      if (item instanceof Error) {
        const code = (item as { code?: unknown }).code;
        return { name: item.name, message: redactText(item.message), ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) };
      }
      if (typeof (item as { forEach?: unknown }).forEach === 'function' && typeof (item as { entries?: unknown }).entries === 'function'
        && typeof (item as { get?: unknown }).get === 'function' && !(item instanceof Map)) {
        // fetch Headers and similar.
        const record: Record<string, string> = {};
        (item as { forEach(callback: (value: string, key: string) => void): void }).forEach((headerValue, key) => { record[key] = headerValue; });
        return visit(record, depth);
      }
      if (item instanceof Map) return visit(Object.fromEntries(item), depth);
      if (item instanceof Set) return visit([...item], depth);
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return `[Binary ${item.byteLength} bytes]`;
      if (Array.isArray(item)) return item.map(element => visit(element, depth + 1));
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        const sensitive = isSensitiveKey(key) || extra.has(key.toLowerCase());
        result[key] = sensitive && (typeof child === 'string' || (typeof child === 'object' && child !== null))
          ? REDACTED
          : visit(child, depth + 1);
      }
      return result;
    } finally {
      seen.delete(item);
    }
  };
  return visit(value, 0) as T;
}

/** Mask sensitive request or response headers, keeping the others. */
export function redactHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>> | Headers): Record<string, unknown> {
  return redact(headers as unknown as Record<string, unknown>);
}
