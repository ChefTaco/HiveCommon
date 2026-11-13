import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCaFetch, createRegistryClient } from '../src/registry/index.js';
import { HiveError } from '../src/errors/index.js';
import { stubFetch } from './helpers.js';

const BASE = 'https://hive.example.com/api/registry';

const product = {
  id: 'emberpath', displayName: 'Emberpath', description: 'Model gateway',
  links: { repository: null, documentation: null, license: null, licenseSpdx: 'Apache-2.0' },
  consoleSection: 'models', required: false, installed: true, dependencies: ['oathweave'],
};
const connection = {
  id: 'emberpath', consolePath: null, browserPrefix: '/api/emberpath', nativeApis: { model: 'https://hive.example.com/v1' },
  documentation: null, inventoryHost: 'node-a', internalEndpoints: { emberpath: 'https://emberpath.internal.example.com:8443', admin: 'https://admin.internal.example.com' },
};

function client(routes: Parameters<typeof stubFetch>[0], options: Partial<Parameters<typeof createRegistryClient>[0]> = {}) {
  const stub = stubFetch(routes);
  return { stub, registry: createRegistryClient({ baseUrl: `${BASE}/`, fetch: stub.fetch, ...options }) };
}

describe('configuration', () => {
  it('requires https or explicit http', () => {
    expect(() => createRegistryClient({ baseUrl: 'http://hive-registry:8095' })).toThrow(/https/);
    expect(() => createRegistryClient({ baseUrl: 'http://hive-registry:8095', allowHttp: true })).not.toThrow();
    expect(() => createRegistryClient({ baseUrl: 'http://127.0.0.1:8095' })).not.toThrow();
    expect(() => createRegistryClient({ baseUrl: 'https://u:p@hive.example.com' })).toThrow(/plain URL/);
    expect(() => createRegistryClient({ baseUrl: 'https://hive.example.com/?x=1' })).toThrow(/plain URL/);
    expect(() => createRegistryClient({ baseUrl: BASE, token: 'two words' })).toThrow(/single bearer/);
  });
});

describe('reads', () => {
  it('reads the installation with the credential, no redirects and extra headers', async () => {
    const { registry, stub } = client({ [`${BASE}/v1/installation`]: () => Response.json({ schema: 1, id: 'home', products: ['oathweave'] }) },
      { token: 'fixture-registry-token', headers: () => ({ 'x-request-id': 'r1' }) });
    expect(await registry.installation()).toEqual({ schema: 1, id: 'home', products: ['oathweave'] });
    const init = stub.calls[0]?.init;
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-registry-token', 'x-request-id': 'r1', accept: 'application/json' });
  });

  it('sends no credential for the public view', async () => {
    const { registry, stub } = client({ [`${BASE}/v1/installation`]: () => Response.json({ schema: 1, id: 'home', products: [] }) });
    await registry.installation();
    expect(stub.calls[0]?.init?.headers).not.toHaveProperty('authorization');
  });

  it('lists products with and without the installed filter', async () => {
    const { registry, stub } = client({
      [`${BASE}/v1/products`]: () => Response.json({ schema: 1, products: [product, { ...product, id: 'hivemem', installed: false }] }),
      [`${BASE}/v1/products?installed=true`]: () => Response.json({ schema: 1, products: [product] }),
      [`${BASE}/v1/products?installed=false`]: () => Response.json({ schema: 1, products: [] }),
    });
    expect((await registry.products()).map(item => item.id)).toEqual(['emberpath', 'hivemem']);
    expect(await registry.installedProducts()).toEqual([product]);
    expect(await registry.products({ installed: false })).toEqual([]);
    expect(stub.calls.map(call => call.url)).toEqual([`${BASE}/v1/products`, `${BASE}/v1/products?installed=true`, `${BASE}/v1/products?installed=false`]);
  });

  it('looks up one product and its connection, with 404 as undefined', async () => {
    const { registry } = client({
      [`${BASE}/v1/products/emberpath`]: () => Response.json(product),
      [`${BASE}/v1/products/emberpath/connection`]: () => Response.json(connection),
    });
    expect(await registry.product('emberpath')).toEqual(product);
    expect(await registry.connection('emberpath')).toEqual(connection);
    expect(await registry.product('missing')).toBeUndefined();
    expect(await registry.connection('missing')).toBeUndefined();
    await expect(registry.product('../etc')).rejects.toMatchObject({ code: 'invalid_product_id', status: 400 });
  });

  it('reports readiness', async () => {
    const { registry } = client({ [`${BASE}/health/ready`]: () => Response.json({ status: 'ready', readOnly: false }) });
    expect(await registry.ready()).toEqual({ status: 'ready', readOnly: false });
  });

  it('turns registry errors into HiveErrors', async () => {
    const { registry } = client({
      [`${BASE}/v1/installation`]: () => Response.json({ error: { code: 'invalid_credential', message: 'Registry credential was not accepted' } }, { status: 401 }),
    });
    const error = await registry.installation().catch((e: unknown) => e) as HiveError;
    expect(error).toBeInstanceOf(HiveError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credential', shape: 'envelope' });
  });

  it.each([
    ['installation', `${BASE}/v1/installation`, { schema: 2 }, (r: ReturnType<typeof createRegistryClient>) => r.installation()],
    ['product list', `${BASE}/v1/products`, { schema: 1, products: [{ id: 'X' }] }, (r: ReturnType<typeof createRegistryClient>) => r.products()],
    ['product list shape', `${BASE}/v1/products`, { products: {} }, (r: ReturnType<typeof createRegistryClient>) => r.products()],
    ['product', `${BASE}/v1/products/emberpath`, { ...product, installed: 'yes' }, (r: ReturnType<typeof createRegistryClient>) => r.product('emberpath')],
    ['connection', `${BASE}/v1/products/emberpath/connection`, { ...connection, internalEndpoints: [] }, (r: ReturnType<typeof createRegistryClient>) => r.connection('emberpath')],
    ['readiness', `${BASE}/health/ready`, {}, (r: ReturnType<typeof createRegistryClient>) => r.ready()],
  ])('rejects an unexpected %s', async (_name, url, body, call) => {
    const { registry } = client({ [url]: () => Response.json(body) });
    await expect(call(registry)).rejects.toMatchObject({ code: 'invalid_registry_response', status: 502 });
  });

  it('rejects a non-JSON success body', async () => {
    const { registry } = client({ [`${BASE}/v1/installation`]: () => new Response('<html>') });
    await expect(registry.installation()).rejects.toMatchObject({ code: 'invalid_registry_response' });
  });
});

describe('endpoints and trust', () => {
  const routes = { [`${BASE}/v1/products/emberpath/connection`]: () => Response.json(connection) };
  const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';

  it('prefers internal endpoints named after the product, with configured trust', async () => {
    const { registry } = client(routes, { trust: { emberpath: { ca } } });
    expect(await registry.endpoint('emberpath')).toEqual({
      productId: 'emberpath', name: 'emberpath', url: 'https://emberpath.internal.example.com:8443', internal: true, trust: { ca },
    });
  });

  it('selects by name, falls back to native APIs, and can prefer native', async () => {
    const { registry } = client(routes, { trust: id => (id === 'emberpath' ? { ca } : undefined) });
    expect((await registry.endpoint('emberpath', { name: 'admin' }))?.url).toBe('https://admin.internal.example.com');
    expect(await registry.endpoint('emberpath', { name: 'model' })).toMatchObject({ url: 'https://hive.example.com/v1', internal: false });
    expect(await registry.endpoint('emberpath', { prefer: 'native' })).toMatchObject({ name: 'model', internal: false });
    expect(await registry.endpoint('emberpath', { name: 'nope' })).toBeUndefined();
    expect(await registry.endpoint('missing')).toBeUndefined();
  });

  it('resolves only endpoints the registry listed, never prototype members', async () => {
    const { registry } = client(routes);
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await registry.endpoint('emberpath', { name })).toBeUndefined();
    }
  });

  it('refuses endpoint maps, dependencies and product lists that are not strings', async () => {
    const bad = (body: unknown) => client({
      [`${BASE}/v1/products/emberpath/connection`]: () => Response.json(body),
      [`${BASE}/v1/products/emberpath`]: () => Response.json(body),
      [`${BASE}/v1/installation`]: () => Response.json(body),
    }).registry;
    const invalid = { code: 'invalid_registry_response', status: 502 };
    await expect(bad({ ...connection, internalEndpoints: { emberpath: { href: 'https://x.example.com' } } }).endpoint('emberpath')).rejects.toMatchObject(invalid);
    await expect(bad({ ...connection, nativeApis: { model: 42 } }).connection('emberpath')).rejects.toMatchObject(invalid);
    await expect(bad({ ...product, dependencies: [{ id: 'oathweave' }] }).product('emberpath')).rejects.toMatchObject(invalid);
    await expect(bad({ schema: 1, id: 'inst', products: [1] }).installation()).rejects.toMatchObject(invalid);
  });

  it('returns empty trust and handles the public view without internal endpoints', async () => {
    const { internalEndpoints: _i, inventoryHost: _h, ...publicConnection } = connection;
    const { registry } = client({ [`${BASE}/v1/products/emberpath/connection`]: () => Response.json(publicConnection) });
    expect(await registry.endpoint('emberpath')).toMatchObject({ name: 'model', internal: false, trust: {} });
  });
});

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasOpenssl)('createCaFetch against a loopback TLS server', () => {
  let directory = '';
  let server: Server;
  let url = '';
  let cert = '';

  beforeAll(async () => {
    // A throwaway self-signed certificate, generated per run and deleted afterwards.
    directory = mkdtempSync(join(tmpdir(), 'hive-common-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', join(directory, 'k'), '-out', join(directory, 'c')], { stdio: 'ignore' });
    cert = readFileSync(join(directory, 'c'), 'utf8');
    server = createServer({ key: readFileSync(join(directory, 'k')), cert }, (req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
      if (req.url === '/slow') { setTimeout(() => res.end('late'), 2000); return; }
      if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
        res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  it('trusts the given CA and returns a Response', async () => {
    const caFetch = createCaFetch({ ca: cert });
    const response = await caFetch(`${url}/echo`, { method: 'POST', body: 'hello', headers: { authorization: 'Bearer t' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'POST', body: 'hello', auth: 'Bearer t' });
    expect(response.headers.get('set-cookie')).toContain('a=1');
    expect((await caFetch(new URL(`${url}/empty`))).status).toBe(204);
    expect((await caFetch(new Request(`${url}/echo`), { body: new TextEncoder().encode('bytes'), method: 'PUT' })).status).toBe(200);
  });

  it('works as the registry client transport', async () => {
    const registry = createRegistryClient({ baseUrl: url, ca: [cert] });
    await expect(registry.ready()).rejects.toMatchObject({ code: 'invalid_registry_response' });
  });

  it('does not follow redirects', async () => {
    expect((await createCaFetch({ ca: cert })(`${url}/redirect`)).status).toBe(302);
  });

  it('refuses servers signed by another CA, plain http and unsupported bodies', async () => {
    const other = cert.replace(/[A-Za-z0-9+/]{20}(?=\n)/, 'AAAAAAAAAAAAAAAAAAAA');
    await expect(createCaFetch({ ca: other })(`${url}/echo`)).rejects.toThrow();
    await expect(createCaFetch({ ca: cert })('http://127.0.0.1/')).rejects.toThrow(/https/);
    await expect(createCaFetch({ ca: cert })(`${url}/echo`, { method: 'POST', body: new Blob(['x']) })).rejects.toThrow(/bodies/);
    expect(() => createCaFetch({ ca: 'not a cert' })).toThrow(/PEM/);
    expect(() => createCaFetch({ ca: [] })).toThrow(/PEM/);
  });

  it('times out and honours abort signals', async () => {
    await expect(createCaFetch({ ca: cert, timeoutMs: 50 })(`${url}/slow`)).rejects.toMatchObject({ name: 'TimeoutError' });
    const controller = new AbortController();
    controller.abort();
    await expect(createCaFetch({ ca: cert })(`${url}/echo`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
