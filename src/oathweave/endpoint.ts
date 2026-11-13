/** Oathweave issuer and endpoint URL validation. */

export interface EndpointOptions {
  /**
   * Allow `http:` for loopback hosts (`localhost`, `127.0.0.0/8`, `::1`). For tests and local
   * development only; never enable it in production configuration.
   */
  readonly allowInsecureLoopback?: boolean;
}

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || LOOPBACK_V4.test(host);
}

/** Why a URL is not an acceptable Oathweave endpoint, or undefined when it is. */
export function endpointProblem(value: string, options: EndpointOptions = {}): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a valid URL';
  }
  if (url.username || url.password) return 'must not contain credentials';
  if (url.hash) return 'must not contain a fragment';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && options.allowInsecureLoopback && isLoopbackHost(url.hostname)) return undefined;
  return url.protocol === 'http:' ? 'must use https (plain http is allowed only for loopback in tests)' : 'must use https';
}

/** Oathweave endpoints carry bearer tokens, so only verified HTTPS is acceptable. */
export function isOathweaveEndpoint(value: string, options: EndpointOptions = {}): boolean {
  return endpointProblem(value, options) === undefined;
}

/** Throw a configuration error naming the setting when `value` is not an acceptable endpoint. */
export function assertOathweaveEndpoint(value: string, name: string, options: EndpointOptions = {}): void {
  const problem = endpointProblem(value, options);
  if (problem) throw new TypeError(`Oathweave ${name} ${problem}`);
}

/**
 * What a native issuer identifier must look like: a lowercase name such as `hive-iam`, never a
 * URL, so it cannot be confused with an https issuer.
 */
export const OATHWEAVE_NATIVE_ISSUER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Validate configured native issuer identifiers and return them de-duplicated. `name` labels errors. */
export function nativeIssuerList(value: readonly string[] | undefined, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (const issuer of value as readonly unknown[]) {
    if (typeof issuer !== 'string' || !OATHWEAVE_NATIVE_ISSUER_PATTERN.test(issuer)) {
      throw new TypeError(`${name} entries must be lowercase identifiers such as hive-iam`);
    }
  }
  return [...new Set(value)];
}
