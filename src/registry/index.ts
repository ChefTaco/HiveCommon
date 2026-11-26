/**
 * A typed client for the Hive Registry API: the installation, its product catalog, and how
 * to reach each product. See the Hive repository's `docs/hive-registry-api.md`.
 */
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isProductId } from '../contracts/index.js';
import { HiveError, parseHiveError } from '../errors/index.js';
import { DEFAULT_MAX_RESPONSE_BYTES, isBoundedFetchError, parseJsonBytes, readBodyBounded } from '../fetch/index.js';
import { isLoopbackHost } from '../oathweave/endpoint.js';

// ---------------------------------------------------------------------------------------
// Response types. Fields marked "credential" appear only with a registry read credential.

export interface RegistryInstallation {
  readonly schema: 1;
  readonly id: string;
  /** IDs of installed products visible at this access level. */
  readonly products: readonly string[];
  // credential
  readonly origin?: string | null;
  readonly profile?: 'core' | 'full' | 'custom' | null;
  readonly release?: { readonly version: string; readonly manifestDigest: string; readonly planDigest: string } | null;
  readonly phase?: string | null;
  readonly revision?: number;
  readonly updatedAt?: string | null;
  readonly hosts?: readonly string[];
}

export interface RegistryProductLinks {
  readonly repository: string | null;
  readonly documentation: string | null;
  readonly license: string | null;
  readonly licenseSpdx: string | null;
}

export interface RegistryProductVersion {
  readonly version: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly storageFormat: string | null;
  readonly release: string | null;
  readonly recordedAt: string;
}

export interface RegistryProductInstallation {
  readonly inventoryHost: string | null;
  readonly version: string | null;
  readonly image: string | null;
  readonly imageDigest: string | null;
  readonly status: 'activating' | 'installed' | 'external' | string;
  readonly installedAt: string | null;
  readonly updatedAt: string | null;
  readonly release: string | null;
}

export interface RegistryProduct {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly links: RegistryProductLinks;
  readonly consoleSection: string | null;
  readonly required: boolean;
  /** True only once activation is recorded (or the product is external). */
  readonly installed: boolean;
  readonly dependencies: readonly string[];
  // credential
  readonly kind?: 'application' | 'datastore' | 'static-ui' | 'ingress' | string;
  readonly source?: string;
  readonly public?: boolean;
  readonly offered?: boolean;
  readonly versions?: readonly RegistryProductVersion[];
  readonly installation?: RegistryProductInstallation | null;
}

export interface RegistryConnection {
  readonly id: string;
  readonly consolePath: string | null;
  readonly browserPrefix: string | null;
  /** Public API base URLs on the console origin, by API name. */
  readonly nativeApis: Readonly<Record<string, string>>;
  readonly documentation: string | null;
  // credential
  readonly inventoryHost?: string | null;
  /** Private-network endpoints, by name. */
  readonly internalEndpoints?: Readonly<Record<string, string>>;
}

/** TLS trust for reaching a product. The registry stores none, so it comes from local configuration. */
export interface ProductTrust {
  /** PEM CA certificate(s) the product's endpoint is signed by. */
  readonly ca?: string | readonly string[];
}

export interface ProductEndpoint {
  readonly productId: string;
  readonly name: string;
  readonly url: string;
  /** True for a private-network endpoint, false for a public native API. */
  readonly internal: boolean;
  readonly trust: ProductTrust;
}

// ---------------------------------------------------------------------------------------
// Fetch with a custom CA

export interface CaFetchOptions {
  /** PEM CA certificate(s) to trust in addition to nothing else: the system store is not used. */
  readonly ca: string | readonly string[];
  /**
   * Deadline for the request and its response body together, combined with the caller's
   * `signal`. 15 000 ms; `0` or `Infinity` sets none (for a long-lived stream, pass a `signal`).
   */
  readonly timeoutMs?: number;
}

/** The default `createCaFetch()` deadline. */
export const DEFAULT_CA_FETCH_TIMEOUT_MS = 15_000;

/**
 * A minimal `fetch` over `node:https` that trusts only the given CA. Supports what this
 * package's clients need: any method, headers, string or byte bodies, `signal`; redirects are
 * returned, never followed. The response resolves once its headers arrive and its body is a
 * stream that is read on demand, never buffered here, so `/fetch` `readBodyBounded()` (and
 * `boundedFetch({ fetch: caFetch })`) stop an oversized body as it arrives. For anything more,
 * inject your own fetch (for example undici's with a custom dispatcher).
 */
export function createCaFetch(options: CaFetchOptions): typeof fetch {
  const ca = typeof options.ca === 'string' ? [options.ca] : [...options.ca];
  if (!ca.length || ca.some(pem => !pem.includes('-----BEGIN CERTIFICATE-----'))) throw new TypeError('ca must be PEM certificates');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_FETCH_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be a non-negative number');
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:') { reject(new TypeError('createCaFetch only supports https URLs')); return; }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      reject(new TypeError('createCaFetch supports string and byte bodies only')); return;
    }
    const deadline = timeoutMs > 0 && Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals = [init?.signal, deadline].filter((s): s is AbortSignal => !!s);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    if (signal?.aborted) { reject(signal.reason); return; }
    const request = httpsRequest(url, { method: init?.method ?? 'GET', headers, ca, ...(signal ? { signal } : {}) }, response => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      const status = response.statusCode ?? 502;
      const nullBody = status === 204 || status === 205 || status === 304 || init?.method === 'HEAD';
      if (nullBody) response.resume();
      // A web stream over the socket: the caller reads (and so buffers) only what it wants, and
      // cancelling it (or the signal aborting) destroys the connection.
      const stream = nullBody ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(stream, { status, statusText: response.statusMessage ?? '', headers: responseHeaders }));
    });
    request.on('error', error => reject(signal?.aborted ? signal.reason : error));
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

// ---------------------------------------------------------------------------------------
// Client

export interface RegistryClientOptions {
  /**
   * The registry base URL: the native service (`http://hive-registry:8095` on the private
   * network, which needs `allowHttp`) or the ingress prefix (`https://hive.example.com/api/registry`).
   */
  readonly baseUrl: string;
  /** The read credential. Omit for the public view. Never use it in browser code. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
  /** PEM CA for an https registry signed by a private CA. Ignored when `fetch` is given. */
  readonly ca?: string | readonly string[];
  /** Allow plain http to a non-loopback host, for the registry's private Compose network. */
  readonly allowHttp?: boolean;
  readonly timeoutMs?: number;
  /** The largest registry response read, success or error. 1 MiB. */
  readonly maxResponseBytes?: number;
  /** TLS trust per product, returned by `endpoint()`. */
  readonly trust?: Readonly<Record<string, ProductTrust>> | ((productId: string) => ProductTrust | undefined);
  /** Extra headers on every request, such as `outboundHeaders()` from `/context`. */
  readonly headers?: () => Record<string, string>;
}

export interface EndpointLookup {
  /** Endpoint name. Defaults to the only one, or to one named after the product. */
  readonly name?: string;
  /** Prefer internal endpoints (default, needs a credential) or public native APIs. */
  readonly prefer?: 'internal' | 'native';
}

export interface RegistryClient {
  installation(): Promise<RegistryInstallation>;
  /** The catalog, optionally filtered by `installed`. */
  products(filter?: { readonly installed?: boolean }): Promise<RegistryProduct[]>;
  /** Installed products only. */
  installedProducts(): Promise<RegistryProduct[]>;
  /** One product, or undefined when the registry does not know it (or hides it at this access level). */
  product(id: string): Promise<RegistryProduct | undefined>;
  connection(id: string): Promise<RegistryConnection | undefined>;
  /** Resolve where to call a product, with its configured TLS trust. Undefined when it has no such endpoint. */
  endpoint(id: string, lookup?: EndpointLookup): Promise<ProductEndpoint | undefined>;
  ready(): Promise<{ readonly status: string; readonly readOnly: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(what: string): HiveError {
  return new HiveError('invalid_registry_response', `The registry returned an unexpected ${what}`, { status: 502 });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** An endpoint map: every value is a URL string. */
function isEndpointMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function checkProduct(value: unknown): RegistryProduct {
  if (!isRecord(value) || !isProductId(value['id']) || typeof value['displayName'] !== 'string' || typeof value['installed'] !== 'boolean'
    || !isStringArray(value['dependencies']) || !isRecord(value['links'])) throw invalid('product');
  return value as unknown as RegistryProduct;
}

function checkConnection(value: unknown): RegistryConnection {
  if (!isRecord(value) || !isProductId(value['id']) || !isEndpointMap(value['nativeApis'])
    || (value['internalEndpoints'] !== undefined && !isEndpointMap(value['internalEndpoints']))) throw invalid('connection');
  return value as unknown as RegistryConnection;
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const base = new URL(options.baseUrl);
  if (base.username || base.password || base.search || base.hash) throw new TypeError('Registry baseUrl must be a plain URL');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && (options.allowHttp || isLoopbackHost(base.hostname)))) {
    throw new TypeError('Registry baseUrl must use https, or set allowHttp for the private network');
  }
  if (options.token !== undefined && !/^[^\s,]+$/.test(options.token)) throw new TypeError('Registry token must be a single bearer credential');
  const prefix = base.href.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('maxResponseBytes must be a non-negative number');
  // The client's own deadline (below) bounds each request, so the CA fetch sets none of its own.
  const request: typeof fetch = options.fetch
    ?? (options.ca ? createCaFetch({ ca: options.ca, timeoutMs: 0 }) : (input, init) => fetch(input, init));

  async function get(path: string, notFoundIsUndefined = false): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await request(`${prefix}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...options.headers?.(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: 'error',
      signal,
    });
    if (notFoundIsUndefined && response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    let body: Uint8Array;
    try {
      body = await readBodyBounded(response, maxBytes, { signal });
    } catch (error) {
      // An error status keeps its status without the body. A success body over the limit is the
      // registry misbehaving; any other failed read is the transport's own error.
      if (!response.ok) body = new Uint8Array();
      else if (isBoundedFetchError(error, 'response_too_large')) throw invalid('body');
      else throw error;
    }
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const retryAfter = response.headers.get('retry-after');
      throw parseHiveError(response.status, body, {
        ...(requestId ? { requestId } : {}),
        ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
      });
    }
    try {
      return parseJsonBytes(body);
    } catch {
      throw invalid('body');
    }
  }

  const productPath = (id: string): string => {
    if (!isProductId(id)) throw new HiveError('invalid_product_id', 'Product IDs are lowercase letters, digits and dashes', { status: 400 });
    return `/v1/products/${id}`;
  };

  const trustFor = (id: string): ProductTrust => {
    const trust = typeof options.trust === 'function' ? options.trust(id) : options.trust?.[id];
    return trust ?? {};
  };

  const client: RegistryClient = {
    async installation() {
      const body = await get('/v1/installation');
      if (!isRecord(body) || body['schema'] !== 1 || typeof body['id'] !== 'string' || !isStringArray(body['products'])) throw invalid('installation');
      return body as unknown as RegistryInstallation;
    },
    async products(filter = {}) {
      const query = filter.installed === undefined ? '' : `?installed=${filter.installed}`;
      const body = await get(`/v1/products${query}`);
      if (!isRecord(body) || body['schema'] !== 1 || !Array.isArray(body['products'])) throw invalid('product list');
      return body['products'].map(checkProduct);
    },
    installedProducts: () => client.products({ installed: true }),
    async product(id) {
      const body = await get(productPath(id), true);
      return body === undefined ? undefined : checkProduct(body);
    },
    async connection(id) {
      const body = await get(`${productPath(id)}/connection`, true);
      return body === undefined ? undefined : checkConnection(body);
    },
    async endpoint(id, lookup = {}) {
      const connection = await client.connection(id);
      if (!connection) return undefined;
      const sources: Array<[boolean, Readonly<Record<string, string>>]> = [
        [true, connection.internalEndpoints ?? {}],
        [false, connection.nativeApis],
      ];
      if (lookup.prefer === 'native') sources.reverse();
      for (const [internal, endpoints] of sources) {
        const names = Object.keys(endpoints);
        const name = lookup.name ?? (names.length === 1 ? names[0] : names.includes(id) ? id : undefined);
        // Own properties only: a name such as `constructor` must not resolve to a prototype member.
        const url = name !== undefined && Object.hasOwn(endpoints, name) ? endpoints[name] : undefined;
        if (name !== undefined && url !== undefined) return { productId: id, name, url, internal, trust: trustFor(id) };
      }
      return undefined;
    },
    async ready() {
      const body = await get('/health/ready');
      if (!isRecord(body) || typeof body['status'] !== 'string') throw invalid('readiness');
      return { status: body['status'], readOnly: body['readOnly'] === true };
    },
  };
  return client;
}
