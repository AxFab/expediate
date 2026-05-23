/**
 * middleware.test.ts — Test suite for src/middleware.ts
 *
 * Uses Node.js built-in test runner (node:test) and real HTTP servers
 * to exercise all six middleware factories end-to-end.
 *
 * Run with:
 *   node --import tsx --test tests/middleware.test.ts
 */

import assert from 'node:assert/strict';
import http   from 'node:http';
import net    from 'node:net';
import zlib   from 'node:zlib';
import { describe, it } from 'node:test';

import createRouter from '../src/router.ts';
import {
  compress,
  requestId,
  rateLimit,
  cacheControl,
  csrf,
  securityHeaders,
} from '../src/middleware.ts';

// ---------------------------------------------------------------------------
// HTTP test helpers
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[]>;
  body:       string;
  rawBody:    Buffer;
}

interface RequestOptions {
  method?:    string;
  path?:      string;
  headers?:   Record<string, string>;
  body?:      Buffer | string;
}

/**
 * Spin up a real HTTP server bound to an ephemeral port, make one request,
 * collect the response, then tear down the server.
 */
function request(
  router: ReturnType<typeof createRouter>,
  opts:   RequestOptions = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const body   = opts.body
        ? (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body))
        : undefined;

      const extraHeaders: Record<string, string> = {};
      if (body) extraHeaders['content-length'] = String(body.length);

      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  opts.method  ?? 'GET',
          path:    opts.path    ?? '/',
          headers: { ...extraHeaders, ...(opts.headers ?? {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const rawBody = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers as Record<string, string | string[]>,
              body:       rawBody.toString(),
              rawBody,
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

// ---------------------------------------------------------------------------
// Suite 1 — compress
// ---------------------------------------------------------------------------

describe('compress() — response compression middleware', () => {
  it('does not compress when Accept-Encoding is absent', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0 }));
    router.get('/', (_req, res) => res.send('hello'));

    const r = await request(router, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.ok(!r.headers['content-encoding'], 'should not set content-encoding');
    assert.equal(r.body, 'hello');
  });

  it('compresses with gzip when client accepts gzip', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0 }));
    router.get('/', (_req, res) => res.send('hello world from gzip middleware test'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    const decompressed = zlib.gunzipSync(r.rawBody).toString();
    assert.equal(decompressed, 'hello world from gzip middleware test');
  });

  it('compresses with deflate when client accepts deflate but not gzip or br', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0 }));
    router.get('/', (_req, res) => res.send('hello deflate'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'deflate' },
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-encoding'], 'deflate');
    const decompressed = zlib.inflateSync(r.rawBody).toString();
    assert.equal(decompressed, 'hello deflate');
  });

  it('prefers br over gzip when client accepts both', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0 }));
    router.get('/', (_req, res) => res.send('hello brotli'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip, br' },
    });

    assert.equal(r.headers['content-encoding'], 'br');
    const decompressed = zlib.brotliDecompressSync(r.rawBody).toString();
    assert.equal(decompressed, 'hello brotli');
  });

  it('falls back to gzip when br is disabled', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0, br: false }));
    router.get('/', (_req, res) => res.send('no brotli'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip, br' },
    });

    assert.equal(r.headers['content-encoding'], 'gzip');
  });

  it('does not compress a response below the threshold', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 10_000 })); // 10 KB threshold
    router.get('/', (_req, res) => res.send('tiny'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.ok(!r.headers['content-encoding'], 'below threshold — should not compress');
    assert.equal(r.body, 'tiny');
  });

  it('compresses a response that exceeds the threshold', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 10 }));
    const big = 'x'.repeat(100);
    router.get('/', (_req, res) => res.send(big));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.equal(r.headers['content-encoding'], 'gzip');
    const decompressed = zlib.gunzipSync(r.rawBody).toString();
    assert.equal(decompressed, big);
  });

  it('sets Vary: Accept-Encoding when compressing', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0 }));
    router.get('/', (_req, res) => res.send('vary test'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.ok(
      (r.headers['vary'] as string)?.toLowerCase().includes('accept-encoding'),
      `Expected Vary: Accept-Encoding, got: ${r.headers['vary']}`,
    );
  });

  it('skips compression when the filter returns false', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0, filter: () => false }));
    router.get('/', (_req, res) => res.send('no compress'));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.ok(!r.headers['content-encoding']);
    assert.equal(r.body, 'no compress');
  });

  it('works correctly with res.json()', async () => {
    const router = createRouter();
    router.use(compress({ threshold: 0 }));
    router.get('/', (_req, res) => res.json({ ok: true }));

    const r = await request(router, {
      path:    '/',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.equal(r.headers['content-encoding'], 'gzip');
    const body = JSON.parse(zlib.gunzipSync(r.rawBody).toString());
    assert.deepEqual(body, { ok: true });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — requestId
// ---------------------------------------------------------------------------

describe('requestId() — request ID middleware', () => {
  it('generates a UUID and sets it on req.id', async () => {
    const router = createRouter();
    let capturedId = '';
    router.use(requestId());
    router.get('/', (req, res) => { capturedId = req.id ?? ''; res.end('ok'); });

    await request(router, { path: '/' });
    assert.ok(capturedId.length > 0, 'req.id should be set');
    // Basic UUID format check
    assert.match(capturedId, /^[0-9a-f-]{36}$/, `Expected UUID, got: ${capturedId}`);
  });

  it('echoes req.id back in the X-Request-ID response header', async () => {
    const router = createRouter();
    router.use(requestId());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(r.headers['x-request-id'], 'X-Request-ID header should be present');
    assert.match(r.headers['x-request-id'] as string, /^[0-9a-f-]{36}$/);
  });

  it('reuses the ID from the incoming X-Request-ID header (allowFromHeader: true)', async () => {
    const router = createRouter();
    let capturedId = '';
    router.use(requestId());
    router.get('/', (req, res) => { capturedId = req.id ?? ''; res.end('ok'); });

    const r = await request(router, {
      path:    '/',
      headers: { 'x-request-id': 'client-provided-id' },
    });

    assert.equal(capturedId, 'client-provided-id');
    assert.equal(r.headers['x-request-id'], 'client-provided-id');
  });

  it('ignores incoming header when allowFromHeader is false', async () => {
    const router = createRouter();
    let capturedId = '';
    router.use(requestId({ allowFromHeader: false }));
    router.get('/', (req, res) => { capturedId = req.id ?? ''; res.end('ok'); });

    await request(router, {
      path:    '/',
      headers: { 'x-request-id': 'client-provided-id' },
    });

    assert.notEqual(capturedId, 'client-provided-id', 'Should not use client-provided ID');
    assert.ok(capturedId.length > 0);
  });

  it('uses a custom generator when provided', async () => {
    let n = 0;
    const router = createRouter();
    router.use(requestId({ generator: () => `req-${++n}` }));
    router.get('/', (_req, res) => res.end('ok'));

    const r1 = await request(router, { path: '/' });
    const r2 = await request(router, { path: '/' });

    assert.equal(r1.headers['x-request-id'], 'req-1');
    assert.equal(r2.headers['x-request-id'], 'req-2');
  });

  it('supports a custom header name', async () => {
    const router = createRouter();
    router.use(requestId({ header: 'x-trace-id' }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(r.headers['x-trace-id'], 'Custom header should be present');
    assert.ok(!r.headers['x-request-id'], 'Default header should NOT be present');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — rateLimit
// ---------------------------------------------------------------------------

describe('rateLimit() — sliding-window rate limiter', () => {
  it('allows requests below the limit', async () => {
    const router = createRouter();
    router.use(rateLimit({ windowMs: 60_000, max: 10 }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.statusCode, 200);
  });

  it('returns 429 after exceeding the limit', async () => {
    // Use a fresh router per test to avoid shared state.
    const router = createRouter();
    const rl = rateLimit({ windowMs: 60_000, max: 2 });
    router.use(rl);
    router.get('/', (_req, res) => res.end('ok'));

    // First two requests should succeed.
    await request(router, { path: '/' });
    await request(router, { path: '/' });

    // Third request exceeds max.
    const r = await request(router, { path: '/' });
    assert.equal(r.statusCode, 429, `Expected 429, got ${r.statusCode}`);
  });

  it('sets X-RateLimit-* headers on every response', async () => {
    const router = createRouter();
    router.use(rateLimit({ windowMs: 60_000, max: 5 }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(r.headers['x-ratelimit-limit'],     'X-RateLimit-Limit missing');
    assert.ok(r.headers['x-ratelimit-remaining'], 'X-RateLimit-Remaining missing');
    assert.ok(r.headers['x-ratelimit-reset'],     'X-RateLimit-Reset missing');
    assert.equal(r.headers['x-ratelimit-limit'], '5');
  });

  it('X-RateLimit-Remaining decrements with each request', async () => {
    const router = createRouter();
    const rl = rateLimit({ windowMs: 60_000, max: 3 });
    router.use(rl);
    router.get('/', (_req, res) => res.end('ok'));

    const r1 = await request(router, { path: '/' });
    const r2 = await request(router, { path: '/' });

    const rem1 = parseInt(r1.headers['x-ratelimit-remaining'] as string, 10);
    const rem2 = parseInt(r2.headers['x-ratelimit-remaining'] as string, 10);
    assert.ok(rem2 < rem1, `Remaining should decrease: ${rem1} → ${rem2}`);
  });

  it('omits rate-limit headers when headers: false', async () => {
    const router = createRouter();
    router.use(rateLimit({ windowMs: 60_000, max: 10, headers: false }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(!r.headers['x-ratelimit-limit'], 'X-RateLimit-Limit should be absent');
  });

  it('uses a custom key extractor', async () => {
    const router = createRouter();
    // Key by a fixed value — all requests share the same bucket.
    const rl = rateLimit({ windowMs: 60_000, max: 1, keyBy: () => 'shared' });
    router.use(rl);
    router.get('/', (_req, res) => res.end('ok'));

    await request(router, { path: '/' }); // uses the 1 allowed request
    const r = await request(router, { path: '/' }); // second should be blocked
    assert.equal(r.statusCode, 429);
  });

  it('sets a custom 429 message', async () => {
    const router = createRouter();
    const rl = rateLimit({ windowMs: 60_000, max: 0, message: 'Slow down!' });
    router.use(rl);
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.statusCode, 429);
    assert.equal(r.body, 'Slow down!');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — cacheControl
// ---------------------------------------------------------------------------

describe('cacheControl() — Cache-Control header middleware', () => {
  it('sets max-age directive', async () => {
    const router = createRouter();
    router.use(cacheControl({ maxAge: 300 }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(
      (r.headers['cache-control'] as string)?.includes('max-age=300'),
      `Got: ${r.headers['cache-control']}`,
    );
  });

  it('sets multiple directives', async () => {
    const router = createRouter();
    router.use(cacheControl({ public: true, maxAge: 3600, immutable: true }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    const cc = r.headers['cache-control'] as string;
    assert.ok(cc.includes('public'),       `Missing public: ${cc}`);
    assert.ok(cc.includes('max-age=3600'), `Missing max-age: ${cc}`);
    assert.ok(cc.includes('immutable'),    `Missing immutable: ${cc}`);
  });

  it('sets no-store', async () => {
    const router = createRouter();
    router.use(cacheControl({ noStore: true }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok((r.headers['cache-control'] as string)?.includes('no-store'));
  });

  it('sets the Expires header when maxAge is provided', async () => {
    const router = createRouter();
    router.use(cacheControl({ maxAge: 60 }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(r.headers['expires'], 'Expires header should be set');
  });

  it('sets the Vary header from an array', async () => {
    const router = createRouter();
    router.use(cacheControl({ vary: ['Accept-Encoding', 'Accept-Language'] }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(
      (r.headers['vary'] as string)?.includes('Accept-Encoding'),
      `Got Vary: ${r.headers['vary']}`,
    );
    assert.ok(
      (r.headers['vary'] as string)?.includes('Accept-Language'),
      `Got Vary: ${r.headers['vary']}`,
    );
  });

  it('sets s-maxage for CDN', async () => {
    const router = createRouter();
    router.use(cacheControl({ sMaxAge: 86400 }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok((r.headers['cache-control'] as string)?.includes('s-maxage=86400'));
  });

  it('sets no Cache-Control header when called with empty options', async () => {
    const router = createRouter();
    router.use(cacheControl({}));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    // Empty options → no directives → header value is empty → not set.
    assert.ok(
      !r.headers['cache-control'] || r.headers['cache-control'] === '',
      `Unexpected Cache-Control: ${r.headers['cache-control']}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — csrf
// ---------------------------------------------------------------------------

describe('csrf() — CSRF protection middleware', () => {
  it('allows GET requests without a CSRF token', async () => {
    const router = createRouter();
    router.use(csrf());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.statusCode, 200);
  });

  it('allows HEAD requests without a CSRF token', async () => {
    const router = createRouter();
    router.use(csrf());
    // Use all() so the router accepts both GET and HEAD methods.
    router.all('/', (_req, res) => res.end('ok'));

    const r = await request(router, { method: 'HEAD', path: '/' });
    assert.equal(r.statusCode, 200);
  });

  it('sets a _csrf cookie on first GET', async () => {
    const router = createRouter();
    router.use(csrf());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    const setCookie = r.headers['set-cookie'];
    assert.ok(setCookie, 'Set-Cookie header should be present');
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    assert.ok(
      cookies.some((c) => c.startsWith('_csrf=')),
      `_csrf cookie not found in: ${JSON.stringify(cookies)}`,
    );
  });

  it('exposes req.csrfToken() to handlers on GET', async () => {
    const router = createRouter();
    let token = '';
    router.use(csrf());
    router.get('/', (req, res) => { token = req.csrfToken?.() ?? ''; res.end('ok'); });

    await request(router, { path: '/' });
    assert.ok(token.length > 0, 'csrfToken() should return a non-empty string');
  });

  it('blocks POST when X-CSRF-Token header is absent', async () => {
    const router = createRouter();
    router.use(csrf());
    router.post('/', (_req, res) => res.end('ok'));

    const r = await request(router, { method: 'POST', path: '/' });
    assert.equal(r.statusCode, 403);
  });

  it('blocks POST when X-CSRF-Token header is wrong', async () => {
    const router = createRouter();
    router.use(csrf());
    router.post('/', (_req, res) => res.end('ok'));

    const r = await request(router, {
      method:  'POST',
      path:    '/',
      headers: { 'x-csrf-token': 'wrong-token' },
    });
    assert.equal(r.statusCode, 403);
  });

  it('allows POST when X-CSRF-Token matches the cookie', async () => {
    // 1. Perform a GET to obtain the generated token from the cookie.
    const router = createRouter();
    let csrfToken = '';
    router.use(csrf());
    router.get('/form', (req, res) => {
      csrfToken = req.csrfToken?.() ?? '';
      res.end('ok');
    });
    router.post('/submit', (_req, res) => res.end('submitted'));

    await request(router, { path: '/form' });
    assert.ok(csrfToken.length > 0, 'Token should have been captured');

    // 2. Replay the cookie + header on a POST.
    const r = await request(router, {
      method:  'POST',
      path:    '/submit',
      headers: {
        'cookie':       `_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'submitted');
  });

  it('uses a custom cookie name', async () => {
    const router = createRouter();
    router.use(csrf({ cookieName: 'myToken' }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    const cookies = [r.headers['set-cookie']].flat();
    assert.ok(
      cookies.some((c) => typeof c === 'string' && c.startsWith('myToken=')),
      `Expected myToken= cookie, got: ${JSON.stringify(cookies)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — securityHeaders
// ---------------------------------------------------------------------------

describe('securityHeaders() — security response headers', () => {
  it('sets all six default headers', async () => {
    const router = createRouter();
    router.use(securityHeaders());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(r.headers['strict-transport-security'], 'HSTS missing');
    assert.ok(r.headers['x-frame-options'],           'X-Frame-Options missing');
    assert.ok(r.headers['x-content-type-options'],    'X-Content-Type-Options missing');
    assert.ok(r.headers['referrer-policy'],            'Referrer-Policy missing');
    assert.ok(r.headers['permissions-policy'],         'Permissions-Policy missing');
    assert.ok(r.headers['x-xss-protection'],           'X-XSS-Protection missing');
  });

  it('HSTS default contains max-age and includeSubDomains', async () => {
    const router = createRouter();
    router.use(securityHeaders());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    const hsts = r.headers['strict-transport-security'] as string;
    assert.ok(hsts.includes('max-age='),          `HSTS: ${hsts}`);
    assert.ok(hsts.includes('includeSubDomains'), `HSTS: ${hsts}`);
  });

  it('X-Frame-Options defaults to SAMEORIGIN', async () => {
    const router = createRouter();
    router.use(securityHeaders());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  });

  it('X-Content-Type-Options is nosniff', async () => {
    const router = createRouter();
    router.use(securityHeaders());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  it('X-XSS-Protection defaults to 0', async () => {
    const router = createRouter();
    router.use(securityHeaders());
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.headers['x-xss-protection'], '0');
  });

  it('omits HSTS when hsts: false', async () => {
    const router = createRouter();
    router.use(securityHeaders({ hsts: false }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(!r.headers['strict-transport-security'], 'HSTS should be absent');
  });

  it('omits X-Frame-Options when frameOptions: false', async () => {
    const router = createRouter();
    router.use(securityHeaders({ frameOptions: false }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(!r.headers['x-frame-options']);
  });

  it('sets frameOptions to DENY', async () => {
    const router = createRouter();
    router.use(securityHeaders({ frameOptions: 'DENY' }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.headers['x-frame-options'], 'DENY');
  });

  it('allows custom Referrer-Policy value', async () => {
    const router = createRouter();
    router.use(securityHeaders({ referrerPolicy: 'no-referrer' }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  });

  it('allows custom Permissions-Policy value', async () => {
    const router = createRouter();
    router.use(securityHeaders({ permissionsPolicy: 'payment=(self)' }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.equal(r.headers['permissions-policy'], 'payment=(self)');
  });

  it('omits X-XSS-Protection when xssProtection: false', async () => {
    const router = createRouter();
    router.use(securityHeaders({ xssProtection: false }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    assert.ok(!r.headers['x-xss-protection']);
  });

  it('supports custom HSTS options', async () => {
    const router = createRouter();
    router.use(securityHeaders({ hsts: { maxAge: 31536000, preload: true } }));
    router.get('/', (_req, res) => res.end('ok'));

    const r = await request(router, { path: '/' });
    const hsts = r.headers['strict-transport-security'] as string;
    assert.ok(hsts.includes('max-age=31536000'), `HSTS: ${hsts}`);
    assert.ok(hsts.includes('preload'),           `HSTS: ${hsts}`);
  });
});
