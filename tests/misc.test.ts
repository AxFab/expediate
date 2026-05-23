/**
 * misc.test.ts — Extensive test suite for misc.ts
 *
 * Uses only Node.js built-ins plus tsx. No external test framework required.
 *
 * Run with:  tsx misc.test.ts
 */

import assert from 'node:assert/strict';
import http   from 'node:http';
import zlib   from 'node:zlib';
import net    from 'node:net';

import createRouter from '../src/router.ts';
import { json, formData, formEncoded, parseBody, logger, streamFormData } from '../src/misc.js';
import type { LoggerOptions } from '../src/misc.ts';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

type TestFn = () => void | Promise<void>;
interface Suite { name: string; tests: { name: string; fn: TestFn }[] }

const suites: Suite[] = [];
let currentSuite: Suite | null = null;

function describe(name: string, body: () => void) {
  const suite: Suite = { name, tests: [] };
  suites.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  body();
  currentSuite = prev;
}

function it(name: string, fn: TestFn) {
  if (!currentSuite) throw new Error('it() called outside describe()');
  currentSuite.tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// HTTP test helper
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[] | undefined>;
  body:       string;
}

/**
 * Send a request through a middleware stack mounted on a temporary server and
 * return the collected response.  The request body (if any) is supplied as a
 * `Buffer`; headers are passed verbatim.
 */
function request(
  middleware: (...args: any[]) => void,
  options: {
    method?:      string;
    path?:        string;
    headers?:     Record<string, string>;
    body?:        Buffer;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const router = createRouter();
    router.use('/', middleware as any);

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        res.statusCode = 200;
        res.end('next() called');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const body   = options.body;
      const chunks: Buffer[] = [];

      const extraHeaders: Record<string, string> = {};
      if (body) extraHeaders['content-length'] = String(body.length);

      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  options.method  ?? 'POST',
          path:    options.path    ?? '/',
          headers: { ...extraHeaders, ...(options.headers ?? {}) },
        },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers,
              body:       Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  });
}

/** Build a multipart/form-data body buffer from an array of parts. */
function buildMultipart(
  boundary: string,
  parts: Array<{ headers: Record<string, string>; body: Buffer | string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`\r\n--${boundary}\r\n`));
    for (const [k, v] of Object.entries(part.headers))
      chunks.push(Buffer.from(`${k}: ${v}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(typeof part.body === 'string' ? Buffer.from(part.body) : part.body);
  }
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  // Remove the leading \r\n from the very first delimiter
  const full = Buffer.concat(chunks);
  return full.slice(2); // strip the leading \r\n we added before the first --boundary
}

// ---------------------------------------------------------------------------
// Suite 1 — json() middleware
// ---------------------------------------------------------------------------

describe('json() middleware', () => {
  it('parses a valid JSON body and sets req.body', async () => {
    const mw  = json();
    const body = Buffer.from('{"hello":"world"}');
    let parsed: unknown;

    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const r = await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, { hello: 'world' });
  });

  it('parses nested JSON objects', async () => {
    const mw  = json();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"a":{"b":[1,2,3]}}');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual((parsed as any)?.a?.b, [1, 2, 3]);
  });

  it('calls next() when Content-Length is 0', async () => {
    const mw = json();
    const r  = await request(mw, {
      body:    Buffer.alloc(0),
      headers: { 'content-type': 'application/json', 'content-length': '0' },
    });
    assert.equal(r.body, 'next() called');
  });

  it('calls next() when no Content-Length header is present', async () => {
    const mw = json();
    const r  = await request(mw, {
      headers: { 'content-type': 'application/json' },
      // No body, no content-length
    });
    assert.equal(r.body, 'next() called');
  });

  it('returns 415 when Content-Type is not application/json', async () => {
    const mw   = json();
    const body = Buffer.from('hello');
    const r    = await request(mw, {
      body,
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(r.statusCode, 415);
  });

  it('returns 413 when body exceeds the limit', async () => {
    const mw   = json({ limit: '10b' });
    const body = Buffer.from('{"a":"this is way too long for a 10 byte limit"}');
    const r    = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 413);
  });

  it('returns 400 for malformed JSON', async () => {
    const mw   = json();
    const body = Buffer.from('{not valid json}');
    const r    = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    // Malformed JSON is a client error — 400 Bad Request (not 500).
    assert.equal(r.statusCode, 400);
  });

  it('applies the reviver function when provided', async () => {
    const reviver = (_key: string, val: unknown) =>
      typeof val === 'string' ? val.toUpperCase() : val;
    const mw  = json({ reviver });
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"msg":"hello"}');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal((parsed as any)?.msg, 'HELLO');
  });

  it('accepts gzip-compressed body when inflate:true (default)', async () => {
    const mw      = json();
    const payload = Buffer.from('{"compressed":true}');
    const gzipped = await new Promise<Buffer>((res, rej) =>
      zlib.gzip(payload, (err, buf) => (err ? rej(err) : res(buf))),
    );

    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const r = await request(router.listener as any, {
      body:    gzipped,
      headers: {
        'content-type':     'application/json',
        'content-encoding': 'gzip',
      },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, { compressed: true });
  });

  it('returns 415 for compressed body when inflate:false', async () => {
    const mw      = json({ inflate: false });
    const payload = Buffer.from('{"x":1}');
    const gzipped = await new Promise<Buffer>((res, rej) =>
      zlib.gzip(payload, (err, buf) => (err ? rej(err) : res(buf))),
    );
    const r = await request(mw, {
      body:    gzipped,
      headers: {
        'content-type':     'application/json',
        'content-encoding': 'gzip',
      },
    });
    assert.equal(r.statusCode, 415);
    assert.ok(r.body.includes('Content-Encoding'));
  });

  it('returns 415 for an unknown Content-Encoding', async () => {
    const mw   = json();
    const body = Buffer.from('{"x":1}');
    const r    = await request(mw, {
      body,
      headers: {
        'content-type':     'application/json',
        'content-encoding': 'br', // brotli — not in DECOMPRESS_ALGO
      },
    });
    assert.equal(r.statusCode, 415);
  });

  it('attaches res.json() helper', async () => {
    const mw = json();
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (_req: any, res: any) => { res.json({ ok: true }); });

    const body = Buffer.from('{}');
    const r    = await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
  });

  it('accepts charset parameter in Content-Type', async () => {
    const mw  = json();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"val":42}', 'utf8');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    assert.equal((parsed as any)?.val, 42);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — formData() middleware
// ---------------------------------------------------------------------------

describe('formData() middleware', () => {
  const BOUNDARY = 'TestBoundary123';
  const CT = `multipart/form-data; boundary=${BOUNDARY}`;

  it('parses a single-part form', async () => {
    const body = buildMultipart(BOUNDARY, [
      {
        headers: { 'Content-Disposition': 'form-data; name="field1"' },
        body:    'value1',
      },
    ]);

    let parts: any;
    const router = createRouter();
    router.use('/', (formData() as any));
    router.post('/', (req: any, res: any) => { parts = req.body; res.end('ok'); });

    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });

    assert.ok(Array.isArray(parts), 'req.body should be an array');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].content.toString(), 'value1');
  });

  it('parses multiple parts', async () => {
    const body = buildMultipart(BOUNDARY, [
      {
        headers: { 'Content-Disposition': 'form-data; name="a"' },
        body:    'alpha',
      },
      {
        headers: { 'Content-Disposition': 'form-data; name="b"' },
        body:    'beta',
      },
    ]);

    let parts: any;
    const router = createRouter();
    router.use('/', (formData() as any));
    router.post('/', (req: any, res: any) => { parts = req.body; res.end('ok'); });

    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0].content.toString(), 'alpha');
    assert.equal(parts[1].content.toString(), 'beta');
  });

  it('exposes part headers (lowercased)', async () => {
    const body = buildMultipart(BOUNDARY, [
      {
        headers: {
          'Content-Disposition': 'form-data; name="f"',
          'Content-Type':        'text/plain',
        },
        body: 'data',
      },
    ]);

    let parts: any;
    const router = createRouter();
    router.use('/', (formData() as any));
    router.post('/', (req: any, res: any) => { parts = req.body; res.end('ok'); });

    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });

    assert.ok('content-disposition' in parts[0].headers);
    assert.ok('content-type' in parts[0].headers);
  });

  it('handles binary part content', async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
    const body = buildMultipart(BOUNDARY, [
      {
        headers: { 'Content-Disposition': 'form-data; name="file"; filename="a.bin"' },
        body:    binaryData,
      },
    ]);

    let parts: any;
    const router = createRouter();
    router.use('/', (formData() as any));
    router.post('/', (req: any, res: any) => { parts = req.body; res.end('ok'); });

    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });

    assert.ok(parts[0].content.equals(binaryData), 'Binary content should be preserved');
  });

  it('returns 415 when Content-Type is not multipart/form-data', async () => {
    const mw = formData();
    const r  = await request(mw, {
      body:    Buffer.from('hello'),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(r.statusCode, 415);
  });

  it('returns 413 when body exceeds limit', async () => {
    const mw   = formData({ limit: '10b' });
    const body = buildMultipart(BOUNDARY, [
      { headers: { 'Content-Disposition': 'form-data; name="x"' }, body: 'way too much data here' },
    ]);
    const r = await request(mw, {
      body,
      headers: { 'content-type': CT },
    });
    assert.equal(r.statusCode, 413);
  });

  it('calls next() when body is absent', async () => {
    const mw = formData();
    const r  = await request(mw, {
      headers: { 'content-type': CT },
    });
    assert.equal(r.body, 'next() called');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — parseBody() middleware
// ---------------------------------------------------------------------------

describe('parseBody() middleware', () => {
  it('auto-parses application/json', async () => {
    const mw  = parseBody();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"auto":true}');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual(parsed, { auto: true });
  });

  it('auto-parses text/plain', async () => {
    const mw  = parseBody();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('plain text content');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(parsed, 'plain text content');
  });

  it('auto-parses multipart/form-data', async () => {
    const boundary = 'AutoBoundary';
    const body = buildMultipart(boundary, [
      { headers: { 'Content-Disposition': 'form-data; name="x"' }, body: 'xval' },
    ]);

    let parts: any;
    const router = createRouter();
    router.use('/', (parseBody() as any));
    router.post('/', (req: any, res: any) => { parts = req.body; res.end('ok'); });

    await request(router.listener as any, {
      body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.ok(Array.isArray(parts));
    assert.equal(parts[0].content.toString(), 'xval');
  });

  it('returns 415 for an unsupported MIME type', async () => {
    const mw = parseBody();
    const r  = await request(mw, {
      body:    Buffer.from('binary data'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(r.statusCode, 415);
  });

  it('calls next() when body is absent', async () => {
    const mw = parseBody();
    const r  = await request(mw, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.body, 'next() called');
  });

  it('respects the limit option', async () => {
    const mw   = parseBody({ limit: '5b' });
    const body = Buffer.from('{"toolong":true}');
    const r    = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 413);
  });

  it('passes reviver to JSON parser', async () => {
    const reviver = (_k: string, v: unknown) =>
      typeof v === 'number' ? v * 2 : v;
    const mw  = parseBody({ reviver });
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"n":21}');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal((parsed as any)?.n, 42);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — readSize() helper (tested indirectly via limit option)
// ---------------------------------------------------------------------------

describe('readSize() — size string parsing (via limit option)', () => {
  const cases: Array<[string, number, boolean]> = [
    // [limit, bodySize, shouldBe413]
    ['10b',   9,  false],
    ['10b',   11, true],
    ['1kb',   1023, false],
    ['1kb',   1025, true],
    ['2mb',   2 * 1024 * 1024 - 1, false],
    ['1gb',   1024, false], // only check it doesn't crash on large unit
  ];

  for (const [limit, size, expect413] of cases) {
    it(`limit '${limit}' with ${size}-byte body → ${expect413 ? '413' : '200'}`, async () => {
      const mw   = json({ limit });
      const body = Buffer.alloc(size, 'x');
      // Wrap in valid JSON quotes to avoid parse errors for large payloads
      const payload = Buffer.from('"' + body.toString().slice(0, size - 2) + '"');
      const r = await request(mw, {
        body:    payload,
        headers: { 'content-type': 'application/json' },
      });
      if (expect413)
        assert.equal(r.statusCode, 413, `Expected 413 for limit=${limit}, size=${size}`);
      else
        assert.notEqual(r.statusCode, 413, `Expected not 413 for limit=${limit}, size=${size}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 5 — logger() middleware
// ---------------------------------------------------------------------------

describe('logger() middleware', () => {
  it('logs one line per completed request', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.equal(lines.length, 1);
  });

  it('log line contains the HTTP method', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'POST', path: '/api' });
    assert.ok(lines[0]?.includes('POST'), `Expected POST in: ${lines[0]}`);
  });

  it('log line contains the request path', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/test-path', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/test-path' });
    assert.ok(lines[0]?.includes('/test-path'), `Expected /test-path in: ${lines[0]}`);
  });

  it('log line contains the status code', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.status(201).send('created'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(lines[0]?.includes('201'), `Expected 201 in: ${lines[0]}`);
  });

  it('log line contains elapsed time in ms', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(lines[0]?.includes('ms'), `Expected 'ms' in: ${lines[0]}`);
  });

  it('uses the custom user function when provided', async () => {
    const lines: string[] = [];
    const mw = logger({
      logger: (m) => lines.push(m),
      user:   () => 'alice',
    });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(lines[0]?.includes('<alice>'), `Expected <alice> in: ${lines[0]}`);
  });

  it('uses "-" as the default user when no user function is set', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(lines[0]?.includes('<->'), `Expected <-> in: ${lines[0]}`);
  });

  it('calls next() so subsequent middleware still runs', async () => {
    const lines: string[] = [];
    let handlerCalled = false;
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => { handlerCalled = true; res.end('ok'); });

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(handlerCalled, 'Route handler should be called after logger');
  });

  it('uses defaults without any options', async () => {
    // logger() with no options should not throw
    assert.doesNotThrow(() => logger());
  });

  it('emits a LOST warning when track:true and response is delayed beyond trackTimeout', async () => {
    const lines: string[] = [];
    const mw = logger({
      logger:       (m) => lines.push(m),
      track:        true,
      trackTimeout: 50, // very short for testing
    });
    const router = createRouter();
    router.use('/', mw as any);
    // Handler that delays beyond the timeout without ending the response
    router.get('/', async (_req: any, res: any) => {
      await new Promise((r) => setTimeout(r, 120));
      res.end('late');
    });

    await request(router.listener as any, { method: 'GET', path: '/' });
    // At this point the response IS finished, so we should have:
    // 1 LOST line (from timeout) + 1 finish line
    const lostLines = lines.filter((l) => l.includes('LOST'));
    assert.equal(lostLines.length, 1, 'Should have exactly one LOST warning line');
  });

  it('does NOT emit LOST when response finishes within trackTimeout', async () => {
    const lines: string[] = [];
    const mw = logger({
      logger:       (m) => lines.push(m),
      track:        true,
      trackTimeout: 1_000, // generous timeout
    });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    const lostLines = lines.filter((l) => l.includes('LOST'));
    assert.equal(lostLines.length, 0, 'No LOST warning should be emitted for fast responses');
  });

  it('honours X-Forwarded-For header for client IP', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, {
      method:  'GET',
      path:    '/',
      headers: { 'x-forwarded-for': '203.0.113.42' },
    });
    assert.ok(lines[0]?.includes('203.0.113.42'), `Expected IP in: ${lines[0]}`);
  });

  it('logs correct colour code for 2xx response (green)', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.end('ok'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    // Green = \x1b[32m
    assert.ok(lines[0]?.includes('\x1b[32m'), `Expected green ANSI in: ${JSON.stringify(lines[0])}`);
  });

  it('logs correct colour code for 4xx response (red)', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => res.status(404).send('Not Found'));

    await request(router.listener as any, { method: 'GET', path: '/' });
    // Red = \x1b[31m
    assert.ok(lines[0]?.includes('\x1b[31m'), `Expected red ANSI in: ${JSON.stringify(lines[0])}`);
  });

  it('logs content-length when present', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    router.get('/', (_req: any, res: any) => {
      // Set Content-Length explicitly so the logger can read it.
      res.setHeader('Content-Length', '5');
      res.end('hello');
    });

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(lines[0]?.includes('(5)'), `Expected (5) in: ${lines[0]}`);
  });

  it('logs "-" for content-length when absent', async () => {
    const lines: string[] = [];
    const mw = logger({ logger: (m) => lines.push(m) });
    const router = createRouter();
    router.use('/', mw as any);
    // end() without setting content-length
    router.get('/', (_req: any, res: any) => { res.end(); });

    await request(router.listener as any, { method: 'GET', path: '/' });
    assert.ok(lines[0]?.includes('(-)'), `Expected (-) in: ${lines[0]}`);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Chunked Transfer-Encoding (FIX-03)
// ---------------------------------------------------------------------------

/**
 * Like `request()` but does NOT set Content-Length, forcing the Node.js HTTP
 * client to use chunked transfer encoding (Transfer-Encoding: chunked).
 * This tests that body parsers correctly read chunked bodies even when there
 * is no upfront Content-Length header.
 */
function requestChunked(
  middleware: (...args: any[]) => void,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
    body?:    Buffer;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const router = createRouter();
    router.use('/', middleware as any);

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        res.statusCode = 200;
        res.end('next() called');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const body   = options.body;
      const chunks: Buffer[] = [];

      // Deliberately omit Content-Length so Node uses chunked encoding.
      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  options.method  ?? 'POST',
          path:    options.path    ?? '/',
          headers: options.headers ?? {},
        },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers,
              body:       Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  });
}

describe('Chunked Transfer-Encoding (FIX-03)', () => {
  it('json() parses a chunked JSON body without Content-Length', async () => {
    // Before FIX-03, readBody() returned next() immediately because
    // Content-Length was absent. With FIX-03, Transfer-Encoding: chunked
    // is detected and the body is streamed normally.
    const mw  = json();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"chunked":true}');
    const r = await requestChunked(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, { chunked: true });
  });

  it('json() calls next() when Transfer-Encoding is chunked but body is empty', async () => {
    const mw = json();
    // No body at all — should pass through even with chunked headers.
    const r  = await requestChunked(mw, {
      headers: { 'content-type': 'application/json' },
    });
    // Empty chunked bodies should be treated as "no body" and call next().
    assert.equal(r.body, 'next() called');
  });

  it('formData() parses a chunked multipart body without Content-Length', async () => {
    const boundary = 'ChunkedBoundary42';
    const body = buildMultipart(boundary, [
      { headers: { 'Content-Disposition': 'form-data; name="field"' }, body: 'chunkval' },
    ]);
    let parts: any;
    const router = createRouter();
    router.use('/', (formData() as any));
    router.post('/', (req: any, res: any) => { parts = req.body; res.end('ok'); });

    const r = await requestChunked(router.listener as any, {
      body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.equal(r.statusCode, 200);
    assert.ok(Array.isArray(parts), 'req.body should be an array of FormPart');
    assert.equal(parts[0].content.toString(), 'chunkval');
  });

  it('parseBody() auto-parses a chunked application/json body', async () => {
    const mw  = parseBody();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"via":"chunked"}');
    await requestChunked(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual(parsed, { via: 'chunked' });
  });

  it('parseBody() auto-parses a chunked text/plain body', async () => {
    const mw  = parseBody();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('plain chunked text');
    await requestChunked(router.listener as any, {
      body,
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(parsed, 'plain chunked text');
  });

  it('json() enforces size limit even for chunked bodies', async () => {
    // The size limit is enforced during streaming, so it still applies
    // even when there is no upfront Content-Length to check.
    const mw   = json({ limit: '10b' });
    const body = Buffer.from('{"too":"large for a 10b limit"}');
    const r    = await requestChunked(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 413);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — json() strict mode (FIX-10)
// ---------------------------------------------------------------------------

describe('json() strict mode (FIX-10)', () => {
  it('accepts an object body when strict:true (default)', async () => {
    const mw  = json({ strict: true });
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('{"x":1}');
    const r = await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, { x: 1 });
  });

  it('accepts an array body when strict:true', async () => {
    const mw  = json({ strict: true });
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('[1,2,3]');
    const r = await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, [1, 2, 3]);
  });

  it('returns 400 for a bare string when strict:true', async () => {
    const mw  = json({ strict: true });
    const body = Buffer.from('"just a string"');
    const r = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 400);
    assert.ok(r.body.includes('object or array'), `Expected error message in: ${r.body}`);
  });

  it('returns 400 for a bare number when strict:true', async () => {
    const mw  = json({ strict: true });
    const body = Buffer.from('42');
    const r = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 for a bare boolean when strict:true', async () => {
    const mw  = json({ strict: true });
    const body = Buffer.from('true');
    const r = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 for null when strict:true', async () => {
    const mw  = json({ strict: true });
    const body = Buffer.from('null');
    const r = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 400);
  });

  it('accepts a bare string when strict:false', async () => {
    const mw  = json({ strict: false });
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('"just a string"');
    const r = await request(router.listener as any, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(parsed, 'just a string');
  });

  it('returns 400 for invalid JSON (not 500)', async () => {
    const mw  = json();
    const body = Buffer.from('{ bad json }');
    const r = await request(mw, {
      body,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — formEncoded() middleware (FEAT-01)
// ---------------------------------------------------------------------------

describe('formEncoded() middleware (FEAT-01)', () => {
  const CT = 'application/x-www-form-urlencoded';

  it('parses a simple key=value body', async () => {
    const mw  = formEncoded();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('name=Alice&age=30');
    const r = await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, { name: 'Alice', age: '30' });
  });

  it('accumulates repeated keys into an array', async () => {
    const mw  = formEncoded();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('tag=a&tag=b&tag=c');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });
    assert.deepEqual((parsed as any).tag, ['a', 'b', 'c']);
  });

  it('keeps single-occurrence keys as plain strings', async () => {
    const mw  = formEncoded();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('single=value');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });
    assert.equal(typeof (parsed as any).single, 'string');
    assert.equal((parsed as any).single, 'value');
  });

  it('decodes percent-encoded values', async () => {
    const mw  = formEncoded();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('msg=hello+world&path=%2Fhome');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });
    // + is decoded as space by URLSearchParams; %2F is decoded as /
    assert.equal((parsed as any).msg, 'hello world');
    assert.equal((parsed as any).path, '/home');
  });

  it('calls next() when body is absent', async () => {
    const mw = formEncoded();
    const r  = await request(mw, {
      headers: { 'content-type': CT },
    });
    assert.equal(r.body, 'next() called');
  });

  it('returns 415 when Content-Type is not form-urlencoded', async () => {
    const mw = formEncoded();
    const r  = await request(mw, {
      body:    Buffer.from('{"key":"val"}'),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 415);
  });

  it('returns 413 when body exceeds the limit', async () => {
    const mw   = formEncoded({ limit: '10b' });
    const body = Buffer.from('key=a_very_long_value_that_exceeds_limit');
    const r    = await request(mw, {
      body,
      headers: { 'content-type': CT },
    });
    assert.equal(r.statusCode, 413);
  });

  it('parseBody() auto-parses application/x-www-form-urlencoded', async () => {
    const mw  = parseBody();
    let parsed: unknown;
    const router = createRouter();
    router.use('/', mw as any);
    router.post('/', (req: any, res: any) => { parsed = req.body; res.end('ok'); });

    const body = Buffer.from('auto=1&auto=2');
    await request(router.listener as any, {
      body,
      headers: { 'content-type': CT },
    });
    assert.deepEqual((parsed as any).auto, ['1', '2']);
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — streamFormData() (FEAT-11)
// ---------------------------------------------------------------------------

describe('streamFormData() (FEAT-11)', () => {
  const BOUNDARY = 'StreamBoundary99';
  const CT = `multipart/form-data; boundary=${BOUNDARY}`;

  it('yields one FormPartStream per multipart part', async () => {
    const body = buildMultipart(BOUNDARY, [
      { headers: { 'Content-Disposition': 'form-data; name="a"' }, body: 'alpha' },
      { headers: { 'Content-Disposition': 'form-data; name="b"' }, body: 'beta' },
    ]);

    let partCount = 0;
    const router = createRouter();
    router.post('/', async (req: any, res: any) => {
      for await (const _part of streamFormData(req)) partCount++;
      res.end('ok');
    });

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => { res.statusCode = 200; res.end('next()'); });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const req  = http.request({
          host: '127.0.0.1', port: addr.port, method: 'POST', path: '/',
          headers: { 'content-type': CT, 'content-length': String(body.length) },
        }, (res) => {
          res.resume();
          res.on('end', () => { server.close(); resolve(); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(body); req.end();
      });
    });

    assert.equal(partCount, 2, 'Should yield exactly 2 parts');
  });

  it('exposes part content via a Readable stream', async () => {
    const body = buildMultipart(BOUNDARY, [
      { headers: { 'Content-Disposition': 'form-data; name="file"' }, body: 'stream content' },
    ]);

    let collected = '';
    const router = createRouter();
    router.post('/', async (req: any, res: any) => {
      for await (const part of streamFormData(req)) {
        const chunks: Buffer[] = [];
        for await (const chunk of part.stream) chunks.push(chunk as Buffer);
        collected = Buffer.concat(chunks).toString();
      }
      res.end('ok');
    });

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => { res.statusCode = 200; res.end('next()'); });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const req  = http.request({
          host: '127.0.0.1', port: addr.port, method: 'POST', path: '/',
          headers: { 'content-type': CT, 'content-length': String(body.length) },
        }, (res) => {
          res.resume();
          res.on('end', () => { server.close(); resolve(); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(body); req.end();
      });
    });

    assert.equal(collected, 'stream content');
  });

  it('exposes lowercased part headers', async () => {
    const body = buildMultipart(BOUNDARY, [
      {
        headers: {
          'Content-Disposition': 'form-data; name="f"',
          'Content-Type':        'text/plain',
        },
        body: 'data',
      },
    ]);

    let seen: Record<string, string> = {};
    const router = createRouter();
    router.post('/', async (req: any, res: any) => {
      for await (const part of streamFormData(req)) seen = part.headers;
      res.end('ok');
    });

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => { res.statusCode = 200; res.end('next()'); });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const req  = http.request({
          host: '127.0.0.1', port: addr.port, method: 'POST', path: '/',
          headers: { 'content-type': CT, 'content-length': String(body.length) },
        }, (res) => {
          res.resume();
          res.on('end', () => { server.close(); resolve(); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(body); req.end();
      });
    });

    assert.ok('content-disposition' in seen, 'content-disposition should be lowercased');
    assert.ok('content-type' in seen, 'content-type should be lowercased');
  });

  it('throws { httpStatus: 413 } when body exceeds the limit', async () => {
    const body = buildMultipart(BOUNDARY, [
      { headers: { 'Content-Disposition': 'form-data; name="f"' }, body: 'too large' },
    ]);

    let thrown: unknown = null;
    const router = createRouter();
    router.post('/', async (req: any, res: any) => {
      try {
        for await (const _part of streamFormData(req, { limit: '5b' })) { /* consume */ }
      } catch (e) {
        thrown = e;
      }
      res.status((thrown as any)?.httpStatus ?? 200).end('done');
    });

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => { res.statusCode = 200; res.end('next()'); });
    });

    const statusCode = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const req  = http.request({
          host: '127.0.0.1', port: addr.port, method: 'POST', path: '/',
          headers: { 'content-type': CT, 'content-length': String(body.length) },
        }, (res) => {
          res.resume();
          res.on('end', () => { server.close(); resolve(res.statusCode ?? 0); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(body); req.end();
      });
    });

    assert.equal(statusCode, 413);
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  let passed = 0;
  let failed = 0;
  const failures: { suite: string; test: string; error: unknown }[] = [];

  for (const suite of suites) {
    console.log(`\n  ${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.fn();
        console.log(`    ✅✓ ${test.name}`);
        passed++;
      } catch (e) {
        console.log(`    ❌✗ ${test.name}`);
        failed++;
        failures.push({ suite: suite.name, test: test.name, error: e });
      }
    }
  }

  const total = passed + failed;
  console.log(`\n  ${passed}/${total} passing${failed > 0 ? `, ${failed} failing` : ''}\n`);

  if (failures.length > 0) {
    console.log('Failures:\n');
    for (const { suite, test, error } of failures) {
      console.log(`  [${suite}] ${test}`);
      if (error instanceof Error) {
        console.log(`    ${error.message}`);
        const lines = error.stack?.split('\n').slice(1, 4) ?? [];
        for (const line of lines) console.log(`  ${line}`);
      } else {
        console.log(`    ${String(error)}`);
      }
      console.log('');
    }
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
