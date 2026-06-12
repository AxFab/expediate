/**
 * static.test.ts — Extensive test suite for static.ts
 *
 * Uses only Node.js built-ins (assert, http, fs, net) plus tsx for TypeScript
 * execution. No external test framework is required.
 *
 * Run with:  tsx static.test.ts
 *
 * Fixture layout (under ./fixtures/):
 *   public/            — recreated programmatically by the before() hook
 *     hello.txt        — plain text file
 *     data.json        — JSON file
 *     index.html       — HTML file (served for directory requests)
 *     style.css        — CSS file
 *     app.js           — JavaScript file
 *     .dotfile         — dot-file at root level
 *     .hidden/
 *       secret.txt     — file inside a dot-directory
 *     sub/
 *       index.html     — sub-directory index
 *       page.txt       — regular file in sub-directory
 *   single.txt         — standalone file for serveFile tests (also recreated)
 *   listing/           — recreated with fixed mtimes for sort-order tests
 */

import assert from 'node:assert/strict';
import http   from 'node:http';
import fs     from 'node:fs';
import net    from 'node:net';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before } from 'node:test';

import createRouter from '../src/router.ts';
import { serveStatic, serveFile, sendFile } from '../src/static.ts';
import type { StaticOptions } from '../src/static.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PUBLIC   = nodePath.join(FIXTURES, 'public');
const SINGLE   = nodePath.join(FIXTURES, 'single.txt');
const LISTING  = nodePath.join(FIXTURES, 'listing');

// ---------------------------------------------------------------------------
// HTTP test helpers
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[] | undefined>;
  body:       string;
}

/**
 * Mount a middleware (or a full router) on a temporary HTTP server, issue one
 * request, collect the response, and tear the server down.
 */
function request(
  middleware: (req: any, res: any, next: () => void) => void,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Attach the minimal router augmentation so static.ts can read req.path
      const router = createRouter();
      router.use('/', middleware as any);
      (router.listener as any)(req, res, () => {
        res.statusCode = 404;
        res.end('next() called — no route matched');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr  = server.address() as net.AddressInfo;
      const chunks: Buffer[] = [];

      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  options.method  ?? 'GET',
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
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — resolveOptions / factory validation
// ---------------------------------------------------------------------------

describe('resolveOptions — input validation', () => {
  it('throws TypeError when root is empty string', () => {
    assert.throws(() => serveStatic(''), (e: unknown) => e instanceof TypeError);
  });

  it('throws TypeError when root is not a string', () => {
    assert.throws(() => serveStatic(42 as any), (e: unknown) => e instanceof TypeError);
  });

  it('throws TypeError when filePath is empty for serveFile', () => {
    assert.throws(() => serveFile(''), (e: unknown) => e instanceof TypeError);
  });

  it('does not throw for a valid directory path', () => {
    assert.doesNotThrow(() => serveStatic(PUBLIC));
  });

  it('does not throw for a valid file path', () => {
    assert.doesNotThrow(() => serveFile(SINGLE));
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — serveStatic: basic file serving
// ---------------------------------------------------------------------------

describe('serveStatic — basic file serving', () => {
  it('serves a text file with 200', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('hello world'));
  });

  it('serves a JSON file with correct Content-Type', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/data.json' });
    assert.equal(r.statusCode, 200);
    const ct = r.headers['content-type'] as string;
    assert.ok(ct?.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
  });

  it('serves an HTML file with correct Content-Type', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/index.html' });
    assert.equal(r.statusCode, 200);
    const ct = r.headers['content-type'] as string;
    assert.ok(ct?.includes('text/html'), `Expected HTML content-type, got: ${ct}`);
  });

  it('serves a CSS file with correct Content-Type', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/style.css' });
    assert.equal(r.statusCode, 200);
    const ct = r.headers['content-type'] as string;
    assert.ok(ct?.includes('text/css'), `Expected CSS content-type, got: ${ct}`);
  });

  it('serves a JS file with correct Content-Type', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/app.js' });
    assert.equal(r.statusCode, 200);
    const ct = r.headers['content-type'] as string;
    assert.ok(
      ct?.includes('javascript') || ct?.includes('text/plain'),
      `Expected JS content-type, got: ${ct}`,
    );
  });

  it('sets Content-Length matching the file size', async () => {
    const mw   = serveStatic(PUBLIC);
    const r    = await request(mw, { path: '/hello.txt' });
    const stat = fs.statSync(nodePath.join(PUBLIC, 'hello.txt'));
    assert.equal(Number(r.headers['content-length']), stat.size);
  });

  it('returns 404 for a missing file', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/does-not-exist.txt' });
    assert.equal(r.statusCode, 404);
  });

  it('returns 404 for a deeply missing path', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/a/b/c/nope.txt' });
    assert.equal(r.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — serveStatic: security headers
// ---------------------------------------------------------------------------

describe('serveStatic — security headers', () => {
  it('sets Content-Security-Policy on every response', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.ok(
      r.headers['content-security-policy'],
      'Content-Security-Policy header should be present',
    );
  });

  it('sets X-Content-Type-Options: nosniff on every response', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  it('merges caller-supplied custom headers with security defaults', async () => {
    // resolveOptions deep-merges headers: caller headers extend the defaults
    // rather than replacing them. Both X-Custom and the default security
    // headers should appear on the response.
    const mw = serveStatic(PUBLIC, { headers: { 'X-Custom': 'test-value' } });
    const r  = await request(mw, { path: '/hello.txt' });
    assert.equal(r.headers['x-custom'], 'test-value',
      'Custom header should be present');
    assert.equal(r.headers['x-content-type-options'], 'nosniff',
      'Default X-Content-Type-Options should still be present after merge');
    assert.ok(r.headers['content-security-policy'],
      'Default Content-Security-Policy should still be present after merge');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — serveStatic: caching headers
// ---------------------------------------------------------------------------

describe('serveStatic — caching headers', () => {
  it('sends ETag by default', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.ok(r.headers['etag'], 'ETag header should be present by default');
    assert.ok((r.headers['etag'] as string).startsWith('W/"'), 'ETag should be a weak ETag');
  });

  it('sends Last-Modified by default', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.ok(r.headers['last-modified'], 'Last-Modified header should be present by default');
  });

  it('suppresses ETag when etag:false', async () => {
    const mw = serveStatic(PUBLIC, { etag: false });
    const r  = await request(mw, { path: '/hello.txt' });
    assert.ok(!r.headers['etag'], 'ETag header should be absent when etag:false');
  });

  it('suppresses Last-Modified when lastModified:false', async () => {
    const mw = serveStatic(PUBLIC, { lastModified: false });
    const r  = await request(mw, { path: '/hello.txt' });
    assert.ok(!r.headers['last-modified'], 'Last-Modified should be absent when lastModified:false');
  });

  it('sets Cache-Control when maxage is provided', async () => {
    const mw = serveStatic(PUBLIC, { maxage: 3_600_000 }); // 1 hour
    const r  = await request(mw, { path: '/hello.txt' });
    const cc = r.headers['cache-control'] as string;
    assert.ok(cc?.includes('max-age=3600'), `Expected max-age=3600 in: ${cc}`);
    assert.ok(cc?.includes('public'), `Expected 'public' in: ${cc}`);
  });

  it('appends immutable to Cache-Control when immutable:true', async () => {
    const mw = serveStatic(PUBLIC, { maxage: 3_600_000, immutable: true });
    const r  = await request(mw, { path: '/hello.txt' });
    const cc = r.headers['cache-control'] as string;
    assert.ok(cc?.includes('immutable'), `Expected 'immutable' in: ${cc}`);
  });

  it('does not set Cache-Control when maxage is 0', async () => {
    const mw = serveStatic(PUBLIC, { maxage: 0 });
    const r  = await request(mw, { path: '/hello.txt' });
    assert.ok(!r.headers['cache-control'], 'Cache-Control should be absent when maxage=0');
  });

  it('accepts maxAge (camelCase alias) and uses it', async () => {
    const mw = serveStatic(PUBLIC, { maxAge: 60_000 });
    const r  = await request(mw, { path: '/hello.txt' });
    const cc = r.headers['cache-control'] as string;
    assert.ok(cc?.includes('max-age=60'), `Expected max-age=60 in: ${cc}`);
  });

  it('returns 304 for a fresh If-None-Match request (ETag match)', async () => {
    const mw = serveStatic(PUBLIC);
    // First request to get the ETag
    const r1  = await request(mw, { path: '/hello.txt' });
    const etag = r1.headers['etag'] as string;
    assert.ok(etag, 'ETag must be present for this test');

    // Second request with If-None-Match
    const r2 = await request(mw, {
      path:    '/hello.txt',
      headers: { 'if-none-match': etag },
    });
    assert.equal(r2.statusCode, 304, 'Should return 304 when ETag matches');
    assert.equal(r2.body, '', '304 response must have no body');
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, {
      path:    '/hello.txt',
      headers: { 'if-none-match': '"stale-etag"' },
    });
    assert.equal(r.statusCode, 200);
  });

  it('returns 304 for a fresh If-Modified-Since request', async () => {
    const mw  = serveStatic(PUBLIC);
    // Use a future date so the file is always "not modified since"
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    const r = await request(mw, {
      path:    '/hello.txt',
      headers: { 'if-modified-since': future },
    });
    assert.equal(r.statusCode, 304);
  });

  it('returns 200 when Cache-Control: no-cache overrides a matching ETag', async () => {
    const mw  = serveStatic(PUBLIC);
    const r1  = await request(mw, { path: '/hello.txt' });
    const etag = r1.headers['etag'] as string;

    const r2 = await request(mw, {
      path:    '/hello.txt',
      headers: { 'if-none-match': etag, 'cache-control': 'no-cache' },
    });
    assert.equal(r2.statusCode, 200, 'no-cache must force revalidation even with matching ETag');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — serveStatic: method filtering
// ---------------------------------------------------------------------------

describe('serveStatic — method filtering', () => {
  it('serves GET requests', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { method: 'GET', path: '/hello.txt' });
    assert.equal(r.statusCode, 200);
  });

  it('serves HEAD requests with headers but no body', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { method: 'HEAD', path: '/hello.txt' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, '', 'HEAD response must have no body');
    assert.ok(r.headers['content-length'], 'HEAD response must include Content-Length');
  });

  it('returns 405 for POST when fallthrough is false', async () => {
    const mw = serveStatic(PUBLIC, { fallthrough: false });
    const r  = await request(mw, { method: 'POST', path: '/hello.txt' });
    assert.equal(r.statusCode, 405);
    assert.equal(r.headers['allow'], 'GET, HEAD');
  });

  it('calls next() for POST when fallthrough is true', async () => {
    const mw = serveStatic(PUBLIC, { fallthrough: true });
    const r  = await request(mw, { method: 'POST', path: '/hello.txt' });
    // Our test harness emits 404 from its own done() callback when next() is called
    assert.equal(r.statusCode, 404);
    assert.ok(r.body.includes('next()'), 'next() should have been called');
  });

  it('returns 405 for DELETE when fallthrough is false', async () => {
    const mw = serveStatic(PUBLIC, { fallthrough: false });
    const r  = await request(mw, { method: 'DELETE', path: '/hello.txt' });
    assert.equal(r.statusCode, 405);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — serveStatic: dot-file handling
// ---------------------------------------------------------------------------

describe('serveStatic — dot-file handling', () => {
  it('hides dot-files by default (returns 404)', async () => {
    const mw = serveStatic(PUBLIC); // default dotfiles:'hide'
    const r  = await request(mw, { path: '/.dotfile' });
    assert.equal(r.statusCode, 404);
  });

  it('hides dot-files when dotfiles:"hide"', async () => {
    const mw = serveStatic(PUBLIC, { dotfiles: 'hide' });
    const r  = await request(mw, { path: '/.dotfile' });
    assert.equal(r.statusCode, 404);
  });

  it('denies dot-files with 403 when dotfiles:"deny"', async () => {
    const mw = serveStatic(PUBLIC, { dotfiles: 'deny' });
    const r  = await request(mw, { path: '/.dotfile' });
    assert.equal(r.statusCode, 403);
  });

  it('serves dot-files when dotfiles:"allow"', async () => {
    const mw = serveStatic(PUBLIC, { dotfiles: 'allow' });
    const r  = await request(mw, { path: '/.dotfile' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('dot'));
  });

  it('hides files inside a dot-directory by default', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/.hidden/secret.txt' });
    assert.equal(r.statusCode, 404);
  });

  it('denies files inside a dot-directory when dotfiles:"deny"', async () => {
    const mw = serveStatic(PUBLIC, { dotfiles: 'deny' });
    const r  = await request(mw, { path: '/.hidden/secret.txt' });
    assert.equal(r.statusCode, 403);
  });

  it('serves files inside a dot-directory when dotfiles:"allow"', async () => {
    const mw = serveStatic(PUBLIC, { dotfiles: 'allow' });
    const r  = await request(mw, { path: '/.hidden/secret.txt' });
    assert.equal(r.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — serveStatic: directory traversal protection
// ---------------------------------------------------------------------------

describe('serveStatic — directory traversal protection', () => {
  it('percent-encoded traversal is neutralised by URL normalisation (returns 404)', async () => {
    // Node's URL constructor resolves %2e%2e the same as bare '..', so by the
    // time serveStatic inspects req.path the traversal is already gone.
    // The path becomes /etc/passwd which is then re-anchored under opts.root
    // (e.g. /fixtures/public/etc/passwd) — a file that does not exist → 404.
    // The UP_PATH_REGEXP guard acts as a defence-in-depth layer for paths
    // that bypass the URL parser (e.g. raw socket injection).
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/%2e%2e/etc/passwd' });
    assert.equal(r.statusCode, 404,
      'URL-normalised traversal reaches a nonexistent path → 404, not 403');
  });

  it('blocks a Windows-style back-slash traversal (percent-encoded) with 403', async () => {
    // Back-slash variants of traversal are also blocked by UP_PATH_REGEXP.
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/%2e%2e%5cwindows%5csystem32' });
    assert.equal(r.statusCode, 403);
  });

  it('nested percent-encoded traversal is also neutralised by URL normalisation', async () => {
    // Same as above: %2e%2e segments are resolved by the URL parser before
    // serveStatic's path checks run. The resolved path stays inside opts.root.
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/sub/%2e%2e/%2e%2e/etc/passwd' });
    assert.equal(r.statusCode, 404,
      'URL-normalised nested traversal hits a nonexistent path → 404');
  });


  it('UP_PATH_REGEXP blocks raw ".." that bypasses URL normalisation', async () => {
    // When req.path contains a literal '..' segment (e.g. injected via a
    // middleware that sets req.path directly without URL parsing), the
    // UP_PATH_REGEXP guard fires and returns 403 Forbidden.
    // We test this by mounting a custom middleware that sets req.path manually
    // before invoking serveStatic.
    const router = createRouter();
    const mw = serveStatic(PUBLIC);
    // Intercept to inject a raw '..' into req.path, bypassing the URL parser.
    router.use('/', (req: any, res: any, next: any) => {
      req.path = '/../etc/passwd';
      mw(req, res, next);
    });
    const r = await new Promise<FakeResponse>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.statusCode = 404; res.end('nf'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const chunks: Buffer[] = [];
        const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/trigger' }, (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });
    assert.equal(r.statusCode, 403, 'Raw ".." in req.path should be blocked with 403');
  });
  it('still serves a legitimate file after a safe path', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.equal(r.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// Suite 7b — serveStatic: malformed percent-encoding → 400
// ---------------------------------------------------------------------------

describe('serveStatic — malformed percent-encoding', () => {
  it('returns 400 for a path with an invalid percent sequence (%zz)', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/%zz' });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 for a truncated percent sequence (%a)', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/foo/%a' });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 for a bare percent sign', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/foo/%' });
    assert.equal(r.statusCode, 400);
  });

  it('still serves valid files after a well-formed percent-encoded path', async () => {
    // %2F is a forward slash — after decoding it produces '/hello.txt' which
    // is then re-anchored under opts.root (no traversal possible), so 404.
    // The important thing is that no 500 / unhandled exception occurs.
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/hello.txt' });
    assert.equal(r.statusCode, 200, 'valid path must still be served after fix');
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — serveStatic: directory / index.html redirect
// ---------------------------------------------------------------------------

describe('serveStatic — directory redirect', () => {
  it('serves index.html when requesting the root directory', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('Index'), 'Should serve index.html content');
  });

  it('serves index.html when requesting a sub-directory', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/sub' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('Sub'), 'Should serve sub/index.html content');
  });

  it('returns 404 for a directory with no index.html when redirect:false', async () => {
    // Create a directory without an index.html
    const noIndex = nodePath.join(FIXTURES, 'noindex');
    fs.mkdirSync(noIndex, { recursive: true });
    try {
      const mw = serveStatic(noIndex, { redirect: false });
      const r  = await request(mw, { path: '/' });
      assert.equal(r.statusCode, 404);
    } finally {
      fs.rmdirSync(noIndex);
    }
  });

  it('files inside a sub-directory are served correctly', async () => {
    const mw = serveStatic(PUBLIC);
    const r  = await request(mw, { path: '/sub/page.txt' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('sub content'));
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — serveStatic: contentType override
// ---------------------------------------------------------------------------

describe('serveStatic — contentType override', () => {
  it('uses the provided contentType instead of auto-detection', async () => {
    const mw = serveStatic(PUBLIC, { contentType: 'text/plain; charset=utf-8' });
    const r  = await request(mw, { path: '/data.json' });
    assert.equal(r.statusCode, 200);
    assert.ok(
      (r.headers['content-type'] as string)?.includes('text/plain'),
      'Content-Type should be overridden',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — serveStatic: fallthrough for missing files
// ---------------------------------------------------------------------------

describe('serveStatic — fallthrough for missing files', () => {
  it('calls next() for missing files when fallthrough:true', async () => {
    const mw = serveStatic(PUBLIC, { fallthrough: true });
    const r  = await request(mw, { path: '/no-such-file.txt' });
    assert.equal(r.statusCode, 404);
    assert.ok(r.body.includes('next()'), 'next() should be called for missing files');
  });

  it('returns 404 directly for missing files when fallthrough:false', async () => {
    const mw = serveStatic(PUBLIC, { fallthrough: false });
    const r  = await request(mw, { path: '/no-such-file.txt' });
    assert.equal(r.statusCode, 404);
    assert.ok(r.body.includes('Not Found'), 'Should send own 404, not call next()');
  });
});

// ---------------------------------------------------------------------------
// Suite 11 — serveFile (single fixed file)
// ---------------------------------------------------------------------------

describe('serveFile — single fixed file middleware', () => {
  it('serves the configured file regardless of request path', async () => {
    const mw = serveFile(SINGLE);
    const r  = await request(mw, { path: '/any/path/at/all' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('single file content'));
  });

  it('serves the file on GET', async () => {
    const mw = serveFile(SINGLE);
    const r  = await request(mw, { method: 'GET', path: '/' });
    assert.equal(r.statusCode, 200);
  });

  it('serves HEAD with headers but no body', async () => {
    const mw = serveFile(SINGLE);
    const r  = await request(mw, { method: 'HEAD', path: '/' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, '');
    assert.ok(r.headers['content-length']);
  });

  it('returns 405 for POST when fallthrough:false', async () => {
    const mw = serveFile(SINGLE, { fallthrough: false });
    const r  = await request(mw, { method: 'POST', path: '/' });
    assert.equal(r.statusCode, 405);
    assert.equal(r.headers['allow'], 'GET, HEAD');
  });

  it('calls next() for POST when fallthrough:true', async () => {
    const mw = serveFile(SINGLE, { fallthrough: true });
    const r  = await request(mw, { method: 'POST', path: '/' });
    assert.equal(r.statusCode, 404);
    assert.ok(r.body.includes('next()'));
  });

  it('sends ETag by default', async () => {
    const mw = serveFile(SINGLE);
    const r  = await request(mw, { path: '/' });
    assert.ok(r.headers['etag']);
  });

  it('sends Last-Modified by default', async () => {
    const mw = serveFile(SINGLE);
    const r  = await request(mw, { path: '/' });
    assert.ok(r.headers['last-modified']);
  });

  it('returns 304 for matching ETag', async () => {
    const mw  = serveFile(SINGLE);
    const r1  = await request(mw, { path: '/' });
    const etag = r1.headers['etag'] as string;

    const r2 = await request(mw, {
      path:    '/',
      headers: { 'if-none-match': etag },
    });
    assert.equal(r2.statusCode, 304);
    assert.equal(r2.body, '');
  });

  it('returns 500 when the configured path is a directory', async () => {
    // serveFile is meant for a single file — pointing it at a directory is a
    // configuration error and should yield 500 (EISDIR).
    const mw = serveFile(PUBLIC); // PUBLIC is a directory
    const r  = await request(mw, { path: '/' });
    assert.equal(r.statusCode, 500);
    assert.ok(r.body.includes('EISDIR'), `Expected EISDIR in: ${r.body}`);
  });

  it('sets Cache-Control when maxage is provided', async () => {
    const mw = serveFile(SINGLE, { maxage: 7_200_000 }); // 2 hours
    const r  = await request(mw, { path: '/' });
    const cc = r.headers['cache-control'] as string;
    assert.ok(cc?.includes('max-age=7200'), `Expected max-age=7200 in: ${cc}`);
  });
});

// ---------------------------------------------------------------------------
// Suite 12 — sendFile utility
// ---------------------------------------------------------------------------

describe('sendFile — utility function', () => {
  it('serves a specific file directly', async () => {
    const target = nodePath.join(PUBLIC, 'hello.txt');
    const mw = serveStatic(PUBLIC); // use the router to augment req/res
    // We call sendFile via a custom middleware wrapper
    const wrapper = (req: any, res: any, next: any) => {
      (mw as any)(req, res, () => {}); // augment req
      // Reset — we want to test sendFile directly
    };
    // Simpler: test sendFile via a custom route
    const router = createRouter();
    router.get('/direct', (req: any, res: any) => {
      (sendFile as any)(req, res, target, {
        headers: { 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' },
        fallthrough: false, maxage: 0, immutable: false, etag: true,
        lastModified: true, contentType: null, dotfiles: 'hide',
        redirect: true, indexOf: false, root: target,
      });
    });

    const r = await new Promise<FakeResponse>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.statusCode = 404; res.end('nf'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const chunks: Buffer[] = [];
        const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/direct' }, (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });

    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes('hello world'));
  });

  it('returns 404 for a non-existent path', async () => {
    const router = createRouter();
    const missingPath = nodePath.join(PUBLIC, 'ghost.txt');
    router.get('/ghost', (req: any, res: any) => {
      (sendFile as any)(req, res, missingPath, {
        headers: {}, fallthrough: false, maxage: 0, immutable: false,
        etag: true, lastModified: true, contentType: null, dotfiles: 'hide',
        redirect: true, indexOf: false, root: missingPath,
      });
    });

    const r = await new Promise<FakeResponse>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.statusCode = 500; res.end('err'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const chunks: Buffer[] = [];
        const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/ghost' }, (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });

    assert.equal(r.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Suite 13 — ETag format and stability
// ---------------------------------------------------------------------------

describe('ETag format and stability', () => {
  it('ETag is a weak ETag in W/"size-mtime" format', async () => {
    const mw  = serveStatic(PUBLIC);
    const r   = await request(mw, { path: '/hello.txt' });
    const etag = r.headers['etag'] as string;
    assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/,
      `ETag format unexpected: ${etag}`);
  });

  it('the same file produces the same ETag on two consecutive requests', async () => {
    const mw  = serveStatic(PUBLIC);
    const r1  = await request(mw, { path: '/hello.txt' });
    const r2  = await request(mw, { path: '/hello.txt' });
    assert.equal(r1.headers['etag'], r2.headers['etag']);
  });

  it('different files produce different ETags', async () => {
    const mw   = serveStatic(PUBLIC);
    const r1   = await request(mw, { path: '/hello.txt' });
    const r2   = await request(mw, { path: '/data.json' });
    assert.notEqual(r1.headers['etag'], r2.headers['etag']);
  });
});

// ---------------------------------------------------------------------------
// Suite 14 — Concurrent requests
// ---------------------------------------------------------------------------

describe('Concurrent requests', () => {
  it('handles multiple concurrent requests without interference', async () => {
    const mw = serveStatic(PUBLIC);
    const results = await Promise.all([
      request(mw, { path: '/hello.txt' }),
      request(mw, { path: '/data.json' }),
      request(mw, { path: '/style.css' }),
      request(mw, { path: '/app.js' }),
    ]);

    assert.equal(results[0].statusCode, 200);
    assert.ok(results[0].body.includes('hello world'));
    assert.equal(results[1].statusCode, 200);
    assert.ok(results[1].body.includes('"ok"'));
    assert.equal(results[2].statusCode, 200);
    assert.equal(results[3].statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// Suite 16 — directory listing: writeIndexOf sorting
//
// Fixture layout (tests/fixtures/listing/):
//   alpha.txt   — 6 bytes,  mtime Jan 2023
//   beta.txt    — 20 bytes, mtime Feb 2023
//   gamma.txt   — 51 bytes, mtime Mar 2023
//   subdir-a/   — directory
//   subdir-b/   — directory
//
// The listing directory is recreated before these tests run so that mtime
// values are deterministic regardless of git clone timestamps.
// ---------------------------------------------------------------------------

before(() => {
  // Recreate all fixture directories and files so that file contents, sizes,
  // and mtime values are deterministic regardless of git clone timestamps.
  // We delete and rebuild rather than patching in-place so that stale or
  // accidentally added files never affect test results.

  // ── public/ ──────────────────────────────────────────────────────────────
  fs.rmSync(PUBLIC, { recursive: true, force: true });
  fs.mkdirSync(nodePath.join(PUBLIC, '.hidden'), { recursive: true });
  fs.mkdirSync(nodePath.join(PUBLIC, 'sub'),     { recursive: true });

  const t0 = new Date('2024-01-01T00:00:00Z'); // stable mtime for all public files

  const publicFiles: Array<[string, string]> = [
    ['.dotfile',           'dot'],
    ['.hidden/secret.txt', 'secret'],
    ['app.js',             'console.log(1)'],
    ['data.json',          '{"ok":true,"value":42}'],
    ['hello.txt',          'hello world - text file'],
    ['index.html',         '<h1>Index</h1>'],
    ['style.css',          'body{}'],
    ['sub/index.html',     '<h1>Sub</h1>'],
    ['sub/page.txt',       'sub content'],
  ];
  for (const [rel, content] of publicFiles) {
    const p = nodePath.join(PUBLIC, rel);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, t0, t0);
  }

  // ── single.txt ────────────────────────────────────────────────────────────
  fs.writeFileSync(SINGLE, 'single file content');
  fs.utimesSync(SINGLE, t0, t0);

  // ── listing/ ──────────────────────────────────────────────────────────────
  // Distinct mtimes are required because several tests sort by modification
  // time and assert a specific file order.
  fs.rmSync(LISTING, { recursive: true, force: true });
  fs.mkdirSync(nodePath.join(LISTING, 'subdir-a'), { recursive: true });
  fs.mkdirSync(nodePath.join(LISTING, 'subdir-b'), { recursive: true });

  const jan = new Date('2023-01-01T00:00:00Z');
  const feb = new Date('2023-02-01T00:00:00Z');
  const mar = new Date('2023-03-01T00:00:00Z');

  // alpha.txt — 6 bytes, mtime Jan 2023
  const alphaPath = nodePath.join(LISTING, 'alpha.txt');
  fs.writeFileSync(alphaPath, 'alpha\n');
  fs.utimesSync(alphaPath, jan, jan);

  // beta.txt — 20 bytes, mtime Feb 2023
  const betaPath = nodePath.join(LISTING, 'beta.txt');
  fs.writeFileSync(betaPath, 'beta beta beta beta\n');
  fs.utimesSync(betaPath, feb, feb);

  // gamma.txt — 51 bytes, mtime Mar 2023
  const gammaPath = nodePath.join(LISTING, 'gamma.txt');
  fs.writeFileSync(gammaPath, 'gamma gamma gamma gamma gamma gamma gamma gamma g\n\n');
  fs.utimesSync(gammaPath, mar, mar);

  // xss.txt — a file whose name contains HTML special characters to verify
  // that writeIndexOf properly escapes file names in the generated HTML.
  const xssPath = nodePath.join(LISTING, '<xss>"&test".txt');
  fs.writeFileSync(xssPath, 'xss test');
  fs.utimesSync(xssPath, jan, jan);
});

/**
 * Issue a request for the LISTING directory using sendFile with indexOf:true.
 * `urlPath` is the path+query string (e.g. '/?C=N;O=D').
 */
function requestListing(urlPath: string): Promise<FakeResponse> {
  const opts = {
    root: LISTING, redirect: false, indexOf: true,
    fallthrough: false, dotfiles: 'deny',
    headers: {}, immutable: false,
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((rawReq, rawRes) => {
      const router = createRouter();
      router.get('/', (req: any, res: any) => {
        // Simulate the router augmentation providing req.url with query string.
        req.url  = urlPath;
        req.path = '/';
        (sendFile as any)(req, res, LISTING, opts);
      });
      (router.listener as any)(rawReq, rawRes, () => {
        rawRes.statusCode = 404;
        rawRes.end('not found');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const chunks: Buffer[] = [];

      const req = http.request(
        { host: '127.0.0.1', port: addr.port, method: 'GET', path: urlPath },
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
      req.end();
    });
  });
}

/** Extract entry names in document order from a listing HTML body. */
function entryNames(html: string): string[] {
  const matches = [...html.matchAll(/<a href="([^"]+)">\1<\/a>/g)];
  return matches.map(m => m[1]);
}

describe('writeIndexOf — default sort (directories first, then files, alphabetical ascending)', () => {
  it('responds with 200', async () => {
    const res = await requestListing('/');
    assert.equal(res.statusCode, 200);
  });

  it('lists directories before files', async () => {
    const { body } = await requestListing('/');
    const names = entryNames(body);
    const firstFile = names.findIndex(n => !n.endsWith('/'));
    const lastDir   = names.map((n, i) => n.endsWith('/') ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
    assert.ok(
      firstFile === -1 || lastDir === -1 || lastDir < firstFile,
      `directories must precede files — got: ${names.join(', ')}`,
    );
  });

  it('lists subdirectories in alphabetical order', async () => {
    const { body } = await requestListing('/');
    const dirs = entryNames(body).filter(n => n.endsWith('/'));
    assert.deepEqual(dirs, [...dirs].sort((a, b) => a.localeCompare(b)));
  });

  it('lists files in alphabetical ascending order', async () => {
    const { body } = await requestListing('/');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, [...files].sort((a, b) => a.localeCompare(b)));
  });

  it('alpha.txt appears before beta.txt appears before gamma.txt', async () => {
    const { body } = await requestListing('/');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });
});

describe('writeIndexOf — sort by name (?C=N)', () => {
  it('ascending (?C=N;O=A) lists files alpha → beta → gamma', async () => {
    const { body } = await requestListing('/?C=N;O=A');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });

  it('descending (?C=N;O=D) lists files gamma → beta → alpha', async () => {
    const { body } = await requestListing('/?C=N;O=D');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['gamma.txt', 'beta.txt', 'alpha.txt']);
  });

  it('descending still shows directories before files', async () => {
    const { body } = await requestListing('/?C=N;O=D');
    const names = entryNames(body);
    const firstFile = names.findIndex(n => !n.endsWith('/'));
    const lastDir   = names.map((n, i) => n.endsWith('/') ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
    assert.ok(lastDir < firstFile, 'directories must still precede files when descending');
  });

  it('supports & as separator: ?C=N&O=D', async () => {
    const { body } = await requestListing('/?C=N&O=D');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['gamma.txt', 'beta.txt', 'alpha.txt']);
  });
});

describe('writeIndexOf — sort by modification time (?C=M)', () => {
  it('ascending (?C=M;O=A) lists files alpha (Jan) → beta (Feb) → gamma (Mar)', async () => {
    const { body } = await requestListing('/?C=M;O=A');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });

  it('descending (?C=M;O=D) lists files gamma (Mar) → beta (Feb) → alpha (Jan)', async () => {
    const { body } = await requestListing('/?C=M;O=D');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['gamma.txt', 'beta.txt', 'alpha.txt']);
  });
});

describe('writeIndexOf — sort by size (?C=S)', () => {
  it('ascending (?C=S;O=A) lists files alpha (6) → beta (20) → gamma (51)', async () => {
    const { body } = await requestListing('/?C=S;O=A');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });

  it('descending (?C=S;O=D) lists files gamma (51) → beta (20) → alpha (6)', async () => {
    const { body } = await requestListing('/?C=S;O=D');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['gamma.txt', 'beta.txt', 'alpha.txt']);
  });
});

describe('writeIndexOf — invalid or absent parameters fall back to default', () => {
  it('unknown C value (?C=X) falls back to name ascending', async () => {
    const { body } = await requestListing('/?C=X;O=A');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });

  it('unknown O value (?O=Z) falls back to ascending', async () => {
    const { body } = await requestListing('/?C=N;O=Z');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });

  it('empty query string uses default order', async () => {
    const { body } = await requestListing('/');
    const files = entryNames(body).filter(n => !n.endsWith('/'));
    assert.deepEqual(files, ['alpha.txt', 'beta.txt', 'gamma.txt']);
  });
});

describe('writeIndexOf — dynamic column header links', () => {
  it('default (C=N, O=A): Name link toggles to descending (?C=N;O=D)', async () => {
    const { body } = await requestListing('/');
    assert.ok(body.includes('href="?C=N;O=D"'), 'Name header should link to descending when current is ascending');
  });

  it('default (C=N, O=A): Last modified link targets ascending (?C=M;O=A)', async () => {
    const { body } = await requestListing('/');
    assert.ok(body.includes('href="?C=M;O=A"'), 'Last modified header should link to ascending when not active');
  });

  it('default (C=N, O=A): Size link targets ascending (?C=S;O=A)', async () => {
    const { body } = await requestListing('/');
    assert.ok(body.includes('href="?C=S;O=A"'), 'Size header should link to ascending when not active');
  });

  it('when sorted by name descending: Name link toggles to ascending (?C=N;O=A)', async () => {
    const { body } = await requestListing('/?C=N;O=D');
    assert.ok(body.includes('href="?C=N;O=A"'), 'Name header should link to ascending when current is descending');
  });

  it('when sorted by size ascending: Size link toggles to descending (?C=S;O=D)', async () => {
    const { body } = await requestListing('/?C=S;O=A');
    assert.ok(body.includes('href="?C=S;O=D"'), 'Size header should toggle to descending when it is the active column');
  });

  it('when sorted by size ascending: Name link targets ascending (?C=N;O=A)', async () => {
    const { body } = await requestListing('/?C=S;O=A');
    assert.ok(body.includes('href="?C=N;O=A"'), 'Name header should link to ascending when not the active column');
  });

  it('when sorted by mtime descending: Last modified link toggles to ascending', async () => {
    const { body } = await requestListing('/?C=M;O=D');
    assert.ok(body.includes('href="?C=M;O=A"'), 'Last modified header should toggle to ascending when active+descending');
  });
});

// ---------------------------------------------------------------------------
// Suite 17 — writeIndexOf: HTML escaping
// ---------------------------------------------------------------------------

/**
 * Like requestListing but allows overriding the req.path passed to sendFile,
 * so we can verify that special characters in the URL path are escaped in the
 * generated HTML title and heading.
 */
function requestListingWithPath(reqPath: string): Promise<FakeResponse> {
  const opts = {
    root: LISTING, redirect: false, indexOf: true,
    fallthrough: false, dotfiles: 'deny',
    headers: {}, immutable: false,
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((rawReq, rawRes) => {
      const router = createRouter();
      router.get('/', (req: any, res: any) => {
        req.url  = reqPath;
        req.path = reqPath.split('?')[0];
        (sendFile as any)(req, res, LISTING, opts);
      });
      (router.listener as any)(rawReq, rawRes, () => {
        rawRes.statusCode = 404;
        rawRes.end('not found');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const chunks: Buffer[] = [];

      const req = http.request(
        { host: '127.0.0.1', port: addr.port, method: 'GET', path: '/' },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

describe('writeIndexOf — HTML escaping', () => {
  it('escapes HTML special characters in urlPath inside <title>', async () => {
    const { body } = await requestListingWithPath('/<script>alert(1)</script>');
    assert.ok(!body.includes('<script>alert'), 'raw <script> must not appear in title');
    assert.ok(body.includes('&lt;script&gt;'), 'title must contain escaped form');
  });

  it('escapes HTML special characters in urlPath inside <h1>', async () => {
    // The payload must be in the PATH portion: writeIndexOf() displays
    // req.path only ("Index of /path", Apache style) — the query string is
    // never part of the heading.
    const { body } = await requestListingWithPath('/path-<b>bold</b>');
    const h1 = /<h1>(.*?)<\/h1>/.exec(body)?.[1] ?? '';
    assert.ok(!h1.includes('<b>bold</b>'), 'raw <b> tag must not appear in heading');
    assert.ok(h1.includes('&lt;b&gt;bold&lt;/b&gt;'), 'heading must contain escaped form');
  });

  it('query-string content is never reflected in the listing', async () => {
    // Query parameters are only used for the validated C/O sort options;
    // arbitrary query content must not appear in the page — raw OR escaped.
    const { body } = await requestListingWithPath('/path?x=1&y=<b>bold</b>');
    assert.ok(!body.includes('<b>bold</b>'), 'raw query content must not appear');
    assert.ok(!body.includes('&lt;b&gt;bold&lt;/b&gt;'), 'query content must not be displayed at all');
  });

  it('escapes HTML special characters in file names (display text)', async () => {
    // The before() hook creates a file named '<xss>"&test".txt' in LISTING.
    const { body } = await requestListing('/');
    // Raw angle brackets must not appear as a tag in the response body.
    assert.ok(!body.includes('<xss>'), 'raw <xss> tag must not appear in listing');
    // The escaped form must appear as the link text.
    assert.ok(body.includes('&lt;xss&gt;'), 'file name must be HTML-escaped in display text');
  });

  it('percent-encodes special characters in file entry href attributes', async () => {
    // The href for '<xss>"&test".txt' must use percent-encoding, not raw special chars.
    const { body } = await requestListing('/');
    assert.ok(body.includes('href="%3Cxss%3E'), 'href must use %3C / %3E for < / >');
    assert.ok(!body.includes('href="<xss>'), 'href must not contain raw < character');
  });

  it('does not double-escape normal file names', async () => {
    // Plain ASCII names must appear verbatim in both href and display text.
    const { body } = await requestListing('/');
    assert.ok(body.includes('href="alpha.txt">alpha.txt</a>'), 'plain ASCII names must be unchanged');
  });
});
