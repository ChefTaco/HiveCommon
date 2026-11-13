/**
 * A typed client for the Hive Registry API: the installation, its product catalog, and how
 * to reach each product. See the Hive repository's `docs/hive-registry-api.md`.
 */
import { request as httpsRequest } from 'node:https';
import { isProductId } from '../contracts/index.js';
import { HiveError, parseHiveErrorResponse } from '../errors/index.js';
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
  readonly timeoutMs?: number;
}

/**
 * A minimal `fetch` over `node:https` that trusts only the given CA. Supports what this
 * package's clients need: any method, headers, string or byte bodies, `signal`; redirects are
 * returned, never followed. For anything more, inject your own fetch (for example undici's
 * with a custom dispatcher).
 */
export function createCaFetch(options: CaFetchOptions): typeof fetch {
  const ca = typeof options.ca === 'string' ? [options.ca] : [...options.ca];
  if (!ca.length || ca.some(pem => !pem.includes('-----BEGIN CERTIFICATE-----'))) throw new TypeError('ca must be PEM certificates');
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:') { reject(new TypeError('createCaFetch only supports https URLs')); return; }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      reject(new TypeError('createCaFetch supports string and byte bodies only')); return;
    }
    const signals = [init?.signal, options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    if (signal?.aborted) { reject(signal.reason); return; }
    const request = httpsRequest(url, { method: init?.method ?? 'GET', headers, ca, ...(signal ? { signal } : {}) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        const status = response.statusCode ?? 502;
        const nullBody = status === 204 || status === 304 || init?.method === 'HEAD';
        resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, statusText: response.statusMessage ?? '', headers: responseHeaders }));
      });
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
  const request: typeof fetch = options.fetch
    ?? (options.ca ? createCaFetch({ ca: options.ca }) : (input, init) => fetch(input, init));

  async function get(path: string, notFoundIsUndefined = false): Promise<unknown> {
    const response = await request(`${prefix}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...options.headers?.(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (notFoundIsUndefined && response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!response.ok) throw await parseHiveErrorResponse(response);
    try {
      return await response.json();
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
