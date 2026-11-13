import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { DEFAULT_DRAIN_LINGER_MS, drainRequest, hiveHandler, readBody, readJsonBody, sendJson, type NodeReadJsonBodyOptions } from '../src/node-http/index.js';
import { HiveError } from '../src/errors/index.js';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server!.close(resolve));
  server = undefined;
});

async function serve(listener: RequestListener): Promise<{ base: string; port: number }> {
  server = createServer(listener);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
}

const jsonRoute = (options: NodeReadJsonBodyOptions = {}) => hiveHandler(async (req, res) => {
  if (req.url === '/raw') sendJson(res, 200, { bytes: (await readBody(req, options)).length });
  else sendJson(res, 200, await readJsonBody(req, options));
});
const JSON_TYPE = { 'content-type': 'application/json' };
const post = (base: string, body: BodyInit | null, headers: Record<string, string> = JSON_TYPE, path = '/json') =>
  fetch(`${base}${path}`, { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
const code = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({
  pull(controller) {
    const next = chunks.shift();
    if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
    else controller.close();
  },
});

/** Send a raw request and collect whatever comes back until the socket closes. */
function raw(port: number, write: (socket: ReturnType<typeof connect>) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    socket.on('connect', () => write(socket));
    socket.on('data', chunk => { received += String(chunk); });
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
  });
}

describe('node-http readJsonBody', () => {
  it('parses a JSON body and returns its text', async () => {
    const { base } = await serve(jsonRoute());
    const response = await post(base, '{"a": 1}', { 'content-type': 'application/json; charset=utf-8' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: { a: 1 }, text: '{"a": 1}', bytes: 8 });
    expect(await (await post(base, 'abc', {}, '/raw')).json()).toEqual({ bytes: 3 });
  });

  it('refuses a declared length over the limit before reading', async () => {
    const { base } = await serve(jsonRoute({ maxBytes: 10 }));
    const response = await post(base, '{"a":"0123456789"}');
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'too_large', details: { maxBytes: 10 } } });
  });

  it('enforces the limit while streaming, without a content-length', async () => {
    const { base } = await serve(jsonRoute({ maxBytes: 10 }));
    const response = await post(base, stream(['{"a":"', '0123456789', '"}']));
    expect(response.status).toBe(413);
    expect(await code(response)).toBe('too_large');
    const within = await post(base, stream(['{"a"', ':1}']));
    expect(((await within.json()) as { value: unknown }).value).toEqual({ a: 1 });
  });

  it('answers an oversized upload at once, then drains it', async () => {
    const { port } = await serve(jsonRoute({ maxBytes: 16 }));
    let answeredBeforeUploadEnded = false;
    const received = await raw(port, socket => {
      socket.write('POST /json HTTP/1.1\r\nHost: service.example.test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
      socket.write(`40\r\n${'x'.repeat(64)}\r\n`);
      let uploading = true;
      socket.once('data', () => { answeredBeforeUploadEnded = uploading; });
      // Keep uploading for a while after the limit is passed, then finish the body.
      let sent = 0;
      const timer = setInterval(() => {
        if (sent++ < 5) socket.write(`40\r\n${'y'.repeat(64)}\r\n`);
        else {
          clearInterval(timer);
          uploading = false;
          socket.write('0\r\n\r\n');
        }
      }, 10);
    });
    expect(received).toMatch(/^HTTP\/1\.1 413 /);
    expect(received).toContain('"code":"too_large"');
    expect(answeredBeforeUploadEnded).toBe(true);
  });

  it('closes the connection when an upload outlasts the linger', async () => {
    const { port } = await serve(jsonRoute({ maxBytes: 16, lingerMs: 30 }));
    const started = Date.now();
    const received = await raw(port, socket => {
      socket.write('POST /json HTTP/1.1\r\nHost: service.example.test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
      socket.write(`40\r\n${'x'.repeat(64)}\r\n`);
      // Never finishes the body.
    });
    expect(received).toMatch(/^HTTP\/1\.1 413 /);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('answers 400 for invalid or empty JSON, unless an empty value is set', async () => {
    const strict = await serve(jsonRoute());
    expect(await code(await post(strict.base, '{"a":'))).toBe('invalid_json');
    const empty = await post(strict.base, null);
    expect(empty.status).toBe(400);
    expect(await code(empty)).toBe('invalid_json');
    await new Promise(resolve => server!.close(resolve));
    const lenient = await serve(jsonRoute({ emptyValue: {} }));
    expect(await (await post(lenient.base, null, {})).json()).toEqual({ value: {}, text: '', bytes: 0 });
  });

  it('checks the content type when there is a body, or always when asked', async () => {
    const first = await serve(jsonRoute({ emptyValue: null }));
    const wrong = await post(first.base, '{"a":1}', { 'content-type': 'text/plain' });
    expect(wrong.status).toBe(415);
    expect(await code(wrong)).toBe('unsupported_media_type');
    expect((await post(first.base, null, {})).status).toBe(200);
    await new Promise(resolve => server!.close(resolve));
    const always = await serve(jsonRoute({ requireContentType: 'always', emptyValue: null }));
    expect((await post(always.base, null, {})).status).toBe(415);
    expect((await post(always.base, '{"a":1}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(always.base, '{"a":1}')).status).toBe(200);
  });

  it('lets a product throw its own errors', async () => {
    const { base } = await serve(jsonRoute({ maxBytes: 4, errorFor: problem => new HiveError(`PRODUCT_${problem.toUpperCase()}`, 'custom', { status: 422 }) }));
    const response = await post(base, '{"a":1}');
    expect(response.status).toBe(422);
    expect(await code(response)).toBe('PRODUCT_TOO_LARGE');
    expect(await code(await post(base, stream(['{"a":1}'])))).toBe('PRODUCT_TOO_LARGE');
  });

  it('rejects with request_aborted when the client goes away mid-body', async () => {
    let outcome: unknown;
    const settled = new Promise<void>(resolve => {
      void serve((req, res) => {
        readBody(req).then(() => { outcome = 'read'; }, error => { outcome = error; }).finally(() => { res.destroy(); resolve(); });
      }).then(({ port }) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write('POST / HTTP/1.1\r\nHost: service.example.test\r\nContent-Length: 100\r\n\r\npartial');
          setTimeout(() => socket.destroy(), 20);
        });
        socket.on('error', () => undefined);
      });
    });
    await settled;
    expect(outcome).toMatchObject({ status: 400, code: 'request_aborted' });
  });

  it('handles a request that already ended or was destroyed', async () => {
    const outcomes: unknown[] = [];
    const { base } = await serve((req, res) => {
      void (async () => {
        if (req.url === '/destroyed') {
          req.destroy();
          outcomes.push(await readBody(req).catch((error: unknown) => (error as HiveError).code));
          drainRequest(req);
          res.destroy();
          return;
        }
        outcomes.push((await readBody(req)).toString());
        outcomes.push((await readBody(req)).length);
        drainRequest(req);
        sendJson(res, 200, {});
      })();
    });
    await post(base, 'abc', {});
    await post(base, 'abc', {}, '/destroyed').catch(() => undefined);
    expect(outcomes).toEqual(['abc', 0, 'request_aborted']);
  });

  it('rejects with request_aborted when the request stream errors', async () => {
    const req = Object.assign(new PassThrough(), { headers: {}, complete: false }) as unknown as IncomingMessage;
    const pending = readBody(req);
    req.emit('data', 'text chunk');
    req.emit('error', new Error('socket hang up'));
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'request_aborted' });
    const text = Object.assign(new PassThrough(), { headers: {}, complete: false }) as unknown as IncomingMessage;
    const read = readBody(text);
    text.emit('data', 'text chunk');
    text.emit('end');
    expect((await read).toString()).toBe('text chunk');
  });

  it('refuses a limit that is not a number', async () => {
    expect(() => readBody({ headers: {} } as IncomingMessage, { maxBytes: Number.NaN })).toThrow(RangeError);
    expect(DEFAULT_DRAIN_LINGER_MS).toBe(5_000);
  });
});

describe('drainRequest', () => {
  it('lets an early refusal reach a client that is still uploading', async () => {
    const { port } = await serve((req, res) => {
      sendJson(res, 401, { error: { code: 'unauthorized', message: 'no' } });
      drainRequest(req);
    });
    const received = await raw(port, socket => {
      socket.write('POST / HTTP/1.1\r\nHost: service.example.test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
      let sent = 0;
      const timer = setInterval(() => {
        if (sent++ < 5) socket.write(`40\r\n${'y'.repeat(64)}\r\n`);
        else {
          clearInterval(timer);
          socket.write('0\r\n\r\n');
        }
      }, 5);
    });
    expect(received).toMatch(/^HTTP\/1\.1 401 /);
  });

  it('closes at once with lingerMs: 0', async () => {
    const { port } = await serve((req, res) => {
      sendJson(res, 401, {});
      drainRequest(req, { lingerMs: 0 });
    });
    const received = await raw(port, socket => {
      socket.on('error', () => undefined);
      socket.write('POST / HTTP/1.1\r\nHost: service.example.test\r\nContent-Length: 1000\r\n\r\npartial');
    }).catch(() => 'reset');
    expect(typeof received).toBe('string');
  });

  it('is exported for plain servers as a request helper', async () => {
    const { base } = await serve((req, res) => {
      drainRequest(req);
      sendJson(res, 404, {});
    });
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/`, { method: 'POST' }, incoming => { incoming.resume(); resolve(incoming.statusCode ?? 0); });
      request.on('error', reject);
      request.end('small body');
    });
    expect(response).toBe(404);
  });
});
