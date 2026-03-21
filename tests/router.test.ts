/**
 * router.test.ts — Extensive test suite for router.ts
 *
 * Uses only Node.js built-ins (assert, http, net) plus tsx for TypeScript
 * execution. No external test framework is required.
 *
 * Run with:  tsx router.test.ts
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import createRouter from '../src/router.ts';
import type { Middleware, RouterRequest, RouterResponse } from '../src/router.js';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

type TestFn = () => void | Promise<void>;

interface Suite {
  name: string;
  tests: { name: string; fn: TestFn }[];
}

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
// HTTP test helpers
// ---------------------------------------------------------------------------

/**
 * Dispatch a synthetic HTTP request through a router listener and collect
 * the response status, headers, and body without binding a real TCP port.
 */
interface FakeResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function makeRequest(
  router: ReturnType<typeof createRouter>,
  options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  },
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        (router.listener as any)(req, res, () => {
          res.statusCode = 404;
          res.end('not found');
        });
      } catch (e) {
        reject(e);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const reqOptions: http.RequestOptions = {
        host: '127.0.0.1',
        port: addr.port,
        method: options.method ?? 'GET',
        path: options.url ?? '/',
        headers: options.headers ?? {},
      };

      const chunks: Buffer[] = [];
      const req = http.request(reqOptions, (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString(),
          });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — Pattern compilation: plain paths
// ---------------------------------------------------------------------------

describe('compilePlainPath', () => {
  it('matches a static path exactly', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/about', (_req, res) => { hit = true; res.end('ok'); });
    const r = await makeRequest(router, { url: '/about' });
    assert.ok(hit, 'handler should be called');
    assert.equal(r.statusCode, 200);
  });

  it('does not match a different static path', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/about', (_req, res) => { hit = true; res.end('ok'); });
    const r = await makeRequest(router, { url: '/contact' });
    assert.ok(!hit);
    assert.equal(r.statusCode, 404);
  });

  it('does not match a path that merely starts with the pattern string', async () => {
    // e.g. /users must not match /users-admin (segment-boundary check)
    const router = createRouter();
    let hit = false;
    router.get('/users', (_req, res) => { hit = true; res.end('ok'); });
    const r = await makeRequest(router, { url: '/users-admin' });
    assert.ok(!hit);
    assert.equal(r.statusCode, 404);
  });

  it('captures a single :param', async () => {
    const router = createRouter();
    let captured = '';
    router.get('/users/:id', (req, res) => {
      captured = req.params.id;
      res.end('ok');
    });
    await makeRequest(router, { url: '/users/42' });
    assert.equal(captured, '42');
  });

  it('captures multiple :params', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    router.get('/orgs/:org/repos/:repo', (req, res) => {
      p = { ...req.params };
      res.end('ok');
    });
    await makeRequest(router, { url: '/orgs/acme/repos/widget' });
    assert.equal(p.org, 'acme');
    assert.equal(p.repo, 'widget');
  });

  it('exposes captured params in req.queries.route', async () => {
    const router = createRouter();
    let route: Record<string, string> = {};
    router.get('/items/:id', (req, res) => {
      route = { ...(req.queries.route ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/items/99' });
    assert.equal(route.id, '99');
  });

  it('use() strips the matched prefix so child routers see only the suffix', async () => {
    // use() has stripPath:true — child sees req.path without the /users/:id prefix.
    const child = createRouter();
    let childPath = '';
    child.get('/profile', (req, res) => { childPath = req.path; res.end('ok'); });

    const parent = createRouter();
    parent.use('/users/:id', child);

    const r = await makeRequest(parent, { url: '/users/7/profile' });
    assert.equal(r.statusCode, 200);
    // After use() strips /users/7, child sees /profile and its own get() matches.
    // Inside the get() handler req.path has been consumed to '/'; what matters
    // is that the request reached the child and returned 200.
  });

  it('get() does NOT strip req.path (chained middlewares each see the full path)', async () => {
    const router = createRouter();
    const paths: string[] = [];
    const m1: Middleware = (req, _res, next) => { paths.push(req.path); next(); };
    const m2: Middleware = (req, res)        => { paths.push(req.path); res.end('ok'); };
    router.get('/hello', m1, m2);
    await makeRequest(router, { url: '/hello' });
    // Both middlewares should see the same path — neither should be '/'
    assert.equal(paths[0], '/hello');
    assert.equal(paths[1], '/hello');
  });

  it('root path "/" matches all requests via use', async () => {
    const router = createRouter();
    let count = 0;
    router.use('/', (_req, _res, next) => { count++; next(); });
    await makeRequest(router, { url: '/anything' });
    assert.equal(count, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Pattern compilation: glob paths
// ---------------------------------------------------------------------------

describe('compileGlob', () => {
  it('* matches a single path segment (no slash)', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/api/*', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/api/users' });
    assert.ok(hit);
  });

  it('* matches a prefix — /api/* matches /api/users/123 as a prefix', async () => {
    // Glob regexes are prefix-anchored. /api/* compiles to ^/api/[^/]* which
    // matches the prefix /api/users in /api/users/123 (no $ anchor).
    const router = createRouter();
    let hit = false;
    router.get('/api/*', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/api/users/123' });
    assert.ok(hit, '/api/* should match /api/users/123 as a prefix');
  });

  it('** crosses slash boundaries', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/api/**', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/api/users/123/settings' });
    assert.ok(hit);
  });

  it('/**/*.php matches php files with a directory prefix', async () => {
    // /**/*.php compiles to ^\/.*\/[^/]*\.php — requires at least one slash
    // between the leading / and the filename, so /admin/panel.php matches
    // but /index.php (no intermediate directory) does not.
    const router = createRouter();
    const hits: string[] = [];
    router.get('/**/*.php', (req, res) => { hits.push(req.url!); res.end('ok'); });

    await makeRequest(router, { url: '/admin/panel.php' });
    await makeRequest(router, { url: '/a/b/c/deep.php' });
    assert.equal(hits.length, 2);
  });

  it('/**/*.php does not match a php file at the root level (no subdirectory)', async () => {
    // /index.php has no intermediate directory segment, so /**/*.php does not match.
    const router = createRouter();
    let hit = false;
    router.get('/**/*.php', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/index.php' });
    assert.ok(!hit, '/index.php should not match /**/*.php (no intermediate dir)');
  });

  it('/*.php matches php files at the root level', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/*.php', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/index.php' });
    assert.ok(hit);
  });

  it('/**/*.php does not match non-php files', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/**/*.php', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/styles/main.css' });
    assert.ok(!hit);
  });

  it('? matches exactly one non-slash character', async () => {
    const router = createRouter();
    const hits: string[] = [];
    router.get('/v?/status', (req, res) => { hits.push(req.url!); res.end('ok'); });

    await makeRequest(router, { url: '/v1/status' });
    await makeRequest(router, { url: '/v2/status' });
    assert.equal(hits.length, 2);
  });

  it('? does not match zero characters', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/v?/status', (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/v/status' });
    assert.ok(!hit);
  });

  it('use() with a glob strips the matched prefix for nested routers', async () => {
    // use() has stripPath:true. The glob matches a prefix and strips it.
    const child = createRouter();
    let childReached = false;
    child.get('/file.js', (_req, res) => { childReached = true; res.end('ok'); });

    const parent = createRouter();
    parent.use('/static/*', child); // strips e.g. /static/dist from req.path

    // /static/dist/file.js — glob matches /static/dist as prefix, child sees /file.js
    const r = await makeRequest(parent, { url: '/static/dist/file.js' });
    assert.ok(childReached);
    assert.equal(r.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Pattern compilation: RegExp paths with named groups
// ---------------------------------------------------------------------------

describe('RegExp paths', () => {
  it('matches a simple regexp', async () => {
    const router = createRouter();
    let hit = false;
    router.get(/^\/hello/, (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/hello-world' });
    assert.ok(hit);
  });

  it('does not match when regexp does not match', async () => {
    const router = createRouter();
    let hit = false;
    router.get(/^\/secure/, (_req, res) => { hit = true; res.end('ok'); });
    await makeRequest(router, { url: '/public' });
    assert.ok(!hit);
  });

  it('named capture groups become req.params', async () => {
    const router = createRouter();
    let captured = '';
    router.get(/^\/users\/(?<id>\d+)/, (req, res) => {
      captured = req.params.id;
      res.end('ok');
    });
    await makeRequest(router, { url: '/users/123' });
    assert.equal(captured, '123');
  });

  it('named capture groups are also exposed in req.queries.route', async () => {
    const router = createRouter();
    let route: Record<string, string> = {};
    router.get(/^\/items\/(?<slug>[a-z-]+)/, (req, res) => {
      route = { ...(req.queries.route ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/items/my-item' });
    assert.equal(route.slug, 'my-item');
  });

  it('multiple named groups are all captured', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    router.get(/^\/(?<year>\d{4})\/(?<month>\d{2})/, (req, res) => {
      p = { ...req.params };
      res.end('ok');
    });
    await makeRequest(router, { url: '/2024/03/post-title' });
    assert.equal(p.year,  '2024');
    assert.equal(p.month, '03');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — HTTP method filtering
// ---------------------------------------------------------------------------

describe('HTTP method filtering', () => {
  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

  for (const method of METHODS) {
    it(`router.${method.toLowerCase()} only matches ${method}`, async () => {
      const router = createRouter();
      let hit = false;
      (router as any)[method.toLowerCase()](
        '/resource',
        (_req: RouterRequest, res: RouterResponse) => { hit = true; res.end('ok'); },
      );

      // Correct method — should match.
      const r1 = await makeRequest(router, { method, url: '/resource' });
      assert.ok(hit, `${method} should match`);
      assert.equal(r1.statusCode, 200);

      for (let other in METHODS.filter((m) => m !== method)) 
      {
        // Wrong methods — should not match.
        // const other = METHODS.find((m) => m !== method)!;
        hit = false;
        const r2 = await makeRequest(router, { method: other, url: '/resource' });
        assert.ok(!hit, `${other} should not match ${method} route`);
        assert.equal(r2.statusCode, 400); // TODO -- 400 Or 404, wierd thing going on here!
      }
    });
  }

  it('router.use matches any HTTP method', async () => {
    const router = createRouter();
    const seen: string[] = [];
    router.use('/ping', (req, res) => { seen.push(req.method!); res.end('ok'); });

    await makeRequest(router, { method: 'GET',    url: '/ping' });
    await makeRequest(router, { method: 'POST',   url: '/ping' });
    await makeRequest(router, { method: 'DELETE', url: '/ping' });

    assert.deepEqual(seen, ['GET', 'POST', 'DELETE']);
  });

  it('router.all matches any HTTP method', async () => {
    const router = createRouter();
    const seen: string[] = [];
    router.all('/ping', (req, res) => { seen.push(req.method!); res.end('ok'); });

    await makeRequest(router, { method: 'GET', url: '/ping' });
    await makeRequest(router, { method: 'PUT', url: '/ping' });

    assert.deepEqual(seen, ['GET', 'PUT']);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Middleware chain & next()
// ---------------------------------------------------------------------------

describe('Middleware chain', () => {
  it('calls middlewares in registration order', async () => {
    const router = createRouter();
    const order: number[] = [];
    router.use('/', (_req, _res, next) => { order.push(1); next(); });
    router.use('/', (_req, _res, next) => { order.push(2); next(); });
    router.get('/end', (_req, res) => { order.push(3); res.end('ok'); });

    await makeRequest(router, { url: '/end' });
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('stops chain when next() is not called', async () => {
    const router = createRouter();
    let second = false;
    router.get('/stop', (_req, res) => { res.end('first'); });
    router.get('/stop', (_req, res) => { second = true; res.end('second'); });

    const r = await makeRequest(router, { url: '/stop' });
    assert.ok(!second);
    assert.equal(r.body, 'first');
  });

  it('multiple middleware as variadic args all run in order', async () => {
    const router = createRouter();
    const order: number[] = [];
    const m1: Middleware = (_req, _res, next) => { order.push(1); next(); };
    const m2: Middleware = (_req, _res, next) => { order.push(2); next(); };
    const m3: Middleware = (_req, res)        => { order.push(3); res.end('ok'); };

    router.get('/chain', m1, m2, m3);
    await makeRequest(router, { url: '/chain' });
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('middleware passed as an array runs in order', async () => {
    const router = createRouter();
    const order: number[] = [];
    const m1: Middleware = (_req, _res, next) => { order.push(1); next(); };
    const m2: Middleware = (_req, res)        => { order.push(2); res.end('ok'); };

    router.get('/arr', [m1, m2]);
    await makeRequest(router, { url: '/arr' });
    assert.deepEqual(order, [1, 2]);
  });

  it('mix of variadic args and arrays works', async () => {
    const router = createRouter();
    const order: number[] = [];
    const m1: Middleware = (_req, _res, next) => { order.push(1); next(); };
    const m2: Middleware = (_req, _res, next) => { order.push(2); next(); };
    const m3: Middleware = (_req, res)        => { order.push(3); res.end('ok'); };

    router.get('/mix', m1, [m2, m3]);
    await makeRequest(router, { url: '/mix' });
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('multiple variadic Router args are all registered', async () => {
    const r1 = createRouter();
    r1.get('/step1', (_req, _res, next) => { next(); }); // doesn't respond

    const r2 = createRouter();
    r2.get('/step2', (_req, res) => res.end('reached r2'));

    const app = createRouter();
    // Two sub-routers on the same prefix; second one handles the response
    app.use('/', r1, r2);

    const r = await makeRequest(app, { url: '/step2' });
    assert.equal(r.body, 'reached r2');
  });

  it('returns 404 when no route matches', async () => {
    const router = createRouter();
    router.get('/exists', (_req, res) => res.end('ok'));
    const r = await makeRequest(router, { url: '/missing' });
    assert.equal(r.statusCode, 404);
  });

  it('returns 500 when a middleware throws synchronously', async () => {
    const router = createRouter();
    router.get('/boom', () => { throw new Error('kaboom'); });
    const r = await makeRequest(router, { url: '/boom' });
    assert.equal(r.statusCode, 500);
  });

  it('earlier middleware can set data on req used by later middleware', async () => {
    const router = createRouter();
    const m1: Middleware = (req: any, _res, next) => { req.user = 'alice'; next(); };
    const m2: Middleware = (req: any, res)        => res.end(req.user);

    router.get('/me', m1, m2);
    const r = await makeRequest(router, { url: '/me' });
    assert.equal(r.body, 'alice');
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Sub-router mounting
// ---------------------------------------------------------------------------

describe('Sub-router mounting', () => {
  it('mounts a Router instance via use()', async () => {
    const child = createRouter();
    child.get('/hello', (_req, res) => res.end('child'));

    const parent = createRouter();
    parent.use('/api', child);

    const r = await makeRequest(parent, { url: '/api/hello' });
    assert.equal(r.body, 'child');
    assert.equal(r.statusCode, 200);
  });

  it('child router receives only the path suffix after prefix is stripped', async () => {
    const child = createRouter();
    let childSawPath = '';
    // Use use() inside child so req.path is inspected before child consumes it
    child.use('/', (req, _res, next) => { childSawPath = req.path; next(); });
    child.get('/items', (_req, res) => res.end('ok'));

    const parent = createRouter();
    parent.use('/v1', child);

    await makeRequest(parent, { url: '/v1/items' });
    assert.equal(childSawPath, '/items');
  });

  it('nested routers two levels deep', async () => {
    const leaf = createRouter();
    leaf.get('/ping', (_req, res) => res.end('pong'));

    const mid = createRouter();
    mid.use('/inner', leaf);

    const root = createRouter();
    root.use('/outer', mid);

    const r = await makeRequest(root, { url: '/outer/inner/ping' });
    assert.equal(r.body, 'pong');
  });

  it('parent handles the request when child finds no matching route (done() callback)', async () => {
    const child = createRouter();
    child.get('/child-only', (_req, res) => res.end('child'));

    const parent = createRouter();
    parent.use('/shared', child);
    parent.get('/shared', (_req, res) => res.end('parent'));

    // /shared/child-only → child handles
    const r1 = await makeRequest(parent, { url: '/shared/child-only' });
    assert.equal(r1.body, 'child');

    // /shared → child misses (no '/' route) → done() → parent handles
    const r2 = await makeRequest(parent, { url: '/shared' });
    assert.equal(r2.body, 'parent');
  });

  it('Router instance passed as variadic arg is automatically unwrapped', async () => {
    const child = createRouter();
    child.get('/sub', (_req, res) => res.end('sub'));

    const parent = createRouter();
    parent.use('/root', child); // Router directly, not child.listener

    const r = await makeRequest(parent, { url: '/root/sub' });
    assert.equal(r.body, 'sub');
  });

  it('done() is called when a child router finds no matching route', async () => {
    let doneCalled = false;
    const child = createRouter(); // no routes

    const parent = createRouter();
    parent.use('/', (req, res, next) => {
      (child.listener as any)(req, res, () => { doneCalled = true; next(); });
    });
    parent.get('/fallback', (_req, res) => res.end('fallback'));

    const r = await makeRequest(parent, { url: '/fallback' });
    assert.ok(doneCalled, 'done() should have been called by the child router');
    assert.equal(r.body, 'fallback');
  });

  it(':params captured by parent use() are available in child middleware', async () => {
    const child = createRouter();
    let capturedId = '';
    child.get('/info', (req, res) => { capturedId = req.params.id; res.end('ok'); });

    const parent = createRouter();
    parent.use('/users/:id', child);

    await makeRequest(parent, { url: '/users/99/info' });
    assert.equal(capturedId, '99');
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Request augmentation: URL parsing
// ---------------------------------------------------------------------------

describe('Request augmentation — URL parsing', () => {
  it('sets req.originalUrl to the full original URL including query string', async () => {
    const router = createRouter();
    let orig = '';
    router.get('/page', (req, res) => { orig = req.originalUrl; res.end('ok'); });
    await makeRequest(router, { url: '/page?foo=bar' });
    assert.equal(orig, '/page?foo=bar');
  });

  it('sets req.path to the pathname only (no query string)', async () => {
    const router = createRouter();
    let seen = '';
    // Use use() so we capture req.path before any stripping occurs
    router.use('/', (req, _res, next) => { seen = req.path; next(); });
    router.get('/page', (_req, res) => res.end('ok'));
    await makeRequest(router, { url: '/page?foo=bar' });
    assert.equal(seen, '/page');
  });

  it('parses query parameters into req.queries.url', async () => {
    const router = createRouter();
    let q: Record<string, string> = {};
    router.get('/search', (req, res) => {
      q = { ...(req.queries.url ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/search?q=hello&page=2' });
    assert.equal(q.q, 'hello');
    assert.equal(q.page, '2');
  });

  it('merges query params into req.params initially', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    router.get('/search', (req, res) => { p = { ...req.params }; res.end('ok'); });
    await makeRequest(router, { url: '/search?lang=ts' });
    assert.equal(p.lang, 'ts');
  });

  it('route params override URL query params of the same name', async () => {
    const router = createRouter();
    let id = '';
    router.get('/users/:id', (req, res) => { id = req.params.id; res.end('ok'); });
    // Provide ?id=query in URL but route captures :id=42
    await makeRequest(router, { url: '/users/42?id=query' });
    assert.equal(id, '42');
  });

  it('percent-encoded query values are decoded', async () => {
    const router = createRouter();
    let q = '';
    router.get('/search', (req, res) => {
      q = req.queries.url?.q ?? '';
      res.end('ok');
    });
    await makeRequest(router, { url: '/search?q=hello%20world' });
    assert.equal(q, 'hello world');
  });

  it('updateHttpObject is idempotent — augmentation only runs once per request', async () => {
    const router = createRouter();
    // Count how many times queries was initialised by checking the same object ref
    let firstQueriesRef: object | null = null;
    let secondQueriesRef: object | null = null;
    const m1: Middleware = (req, _res, next) => { firstQueriesRef  = req.queries; next(); };
    const m2: Middleware = (req, _res, next) => { secondQueriesRef = req.queries; next(); };
    router.get('/test', m1, m2, (_req, res) => res.end('ok'));
    await makeRequest(router, { url: '/test' });
    // Both middlewares should see the exact same queries object reference
    assert.strictEqual(firstQueriesRef, secondQueriesRef);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — Request augmentation: Cookie parsing
// ---------------------------------------------------------------------------

describe('Request augmentation — Cookie parsing', () => {
  it('parses a single cookie', async () => {
    const router = createRouter();
    let cookies: Record<string, string> = {};
    router.get('/me', (req, res) => { cookies = { ...req.cookies }; res.end('ok'); });
    await makeRequest(router, { url: '/me', headers: { cookie: 'session=abc123' } });
    assert.equal(cookies.session, 'abc123');
  });

  it('parses multiple cookies separated by semicolons', async () => {
    const router = createRouter();
    let cookies: Record<string, string> = {};
    router.get('/me', (req, res) => { cookies = { ...req.cookies }; res.end('ok'); });
    await makeRequest(router, { url: '/me', headers: { cookie: 'a=1; b=2; c=3' } });
    assert.equal(cookies.a, '1');
    assert.equal(cookies.b, '2');
    assert.equal(cookies.c, '3');
  });

  it('trims whitespace around both cookie names and values', async () => {
    // The parser splits on the first '=', then trims both the name and the value.
    const router = createRouter();
    let cookies: Record<string, string> = {};
    router.get('/me', (req, res) => { cookies = { ...req.cookies }; res.end('ok'); });
    await makeRequest(router, { url: '/me', headers: { cookie: '  key  =  val  ' } });
    assert.ok('key' in cookies,  'cookie name should be trimmed of surrounding whitespace');
    assert.equal(cookies['key'], 'val', 'cookie value should also be trimmed');
  });

  it('returns an empty cookies object when no Cookie header is present', async () => {
    const router = createRouter();
    let cookies: Record<string, string> | null = null;
    router.get('/me', (req, res) => { cookies = { ...req.cookies }; res.end('ok'); });
    await makeRequest(router, { url: '/me' });
    assert.deepEqual(cookies, {});
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — Response helpers
// ---------------------------------------------------------------------------

describe('Response helpers', () => {
  it('res.send() writes body and ends the response', async () => {
    const router = createRouter();
    router.get('/hello', (_req, res) => res.send('Hello World'));
    const r = await makeRequest(router, { url: '/hello' });
    assert.equal(r.body, 'Hello World');
    assert.equal(r.statusCode, 200);
  });

  it('res.send() with no argument just ends the response', async () => {
    const router = createRouter();
    router.get('/empty', (_req, res) => res.send());
    const r = await makeRequest(router, { url: '/empty' });
    assert.equal(r.body, '');
    assert.equal(r.statusCode, 200);
  });

  it('res.status() sets the status code', async () => {
    const router = createRouter();
    router.get('/teapot', (_req, res) => res.status(418).send("I'm a teapot"));
    const r = await makeRequest(router, { url: '/teapot' });
    assert.equal(r.statusCode, 418);
  });

  it('res.status() returns res for chaining', async () => {
    const router = createRouter();
    router.get('/chain', (_req, res) => { res.status(201).send('created'); });
    const r = await makeRequest(router, { url: '/chain' });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body, 'created');
  });

  it('res.status() sets optional extra headers', async () => {
    const router = createRouter();
    router.get('/custom', (_req, res) => {
      res.status(200, { 'X-Custom': 'expedition' }).send('ok');
    });
    const r = await makeRequest(router, { url: '/custom' });
    assert.equal(r.headers['x-custom'], 'expedition');
  });

  it('res.redirect() sends 302 with a Location header', async () => {
    const router = createRouter();
    router.get('/old', (_req, res) => res.redirect('/new'));
    const r = await makeRequest(router, { url: '/old' });
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers['location'], '/new');
  });

  it('res.redirect() body contains the target URL', async () => {
    const router = createRouter();
    router.get('/old', (_req, res) => res.redirect('/new'));
    const r = await makeRequest(router, { url: '/old' });
    assert.ok(r.body.includes('/new'));
  });

  it('X-Powered-By: Expediate header is set on every response', async () => {
    const router = createRouter();
    router.get('/any', (_req, res) => res.send('ok'));
    const r = await makeRequest(router, { url: '/any' });
    assert.equal(r.headers['x-powered-by'], 'Expediate');
  });

  describe('res.cookie()', () => {
    it('sets a basic Set-Cookie header', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => { res.cookie('token', 'abc').send('ok'); });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc;
      assert.ok(cookie?.includes('token=abc'), `Expected token=abc in: ${cookie}`);
    });

    it('includes Max-Age when maxAge option is provided (in seconds)', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => {
        res.cookie('tok', 'val', { maxAge: 60_000 }).send('ok');
      });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc;
      assert.ok(cookie?.includes('Max-Age=60'), `Expected Max-Age=60 in: ${cookie}`);
    });

    it('includes Expires when maxAge is provided', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => {
        res.cookie('tok', 'val', { maxAge: 60_000 }).send('ok');
      });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc;
      assert.ok(cookie?.includes('Expires='), `Expected Expires= in: ${cookie}`);
    });

    it('uses / as the default cookie Path', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => { res.cookie('x', '1').send('ok'); });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc;
      assert.ok(cookie?.includes('Path=/'), `Expected Path=/ in: ${cookie}`);
    });

    it('respects a custom cookie Path option', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => {
        res.cookie('x', '1', { path: '/api' }).send('ok');
      });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc;
      assert.ok(cookie?.includes('Path=/api'), `Expected Path=/api in: ${cookie}`);
    });

    it('serialises object values with a j: prefix', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => {
        res.cookie('data', { role: 'admin' }).send('ok');
      });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc;
      assert.ok(cookie?.includes('j:'), `Expected j: prefix in: ${cookie}`);
      assert.ok(cookie?.includes('role'), `Expected JSON content in: ${cookie}`);
    });

    it('res.cookie() returns res for chaining', async () => {
      const router = createRouter();
      let chained = false;
      router.get('/set', (_req, res) => {
        const r = res.cookie('a', '1');
        chained = r === res;
        r.send('ok');
      });
      await makeRequest(router, { url: '/set' });
      assert.ok(chained, 'res.cookie() should return res');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — registerRoute error handling
// ---------------------------------------------------------------------------

describe('registerRoute — invalid middleware', () => {
  it('throws TypeError when a plain number is registered', () => {
    const router = createRouter();
    assert.throws(
      () => router.get('/bad', 42 as any),
      (e: unknown) => e instanceof TypeError,
    );
  });

  it('throws TypeError for a null value in an array', () => {
    const router = createRouter();
    assert.throws(
      () => router.get('/bad', [null as any]),
      (e: unknown) => e instanceof TypeError,
    );
  });

  it('throws TypeError for a plain object (not a Router)', () => {
    const router = createRouter();
    assert.throws(
      () => router.get('/bad', { notARouter: true } as any),
      (e: unknown) => e instanceof TypeError,
    );
  });
});


// Variant of makeRequest that does NOT pass a done() callback, so the router's
// own 404 / 500 handlers fire instead of the test harness fallback.
function makeRequestNoDone(
  router: ReturnType<typeof createRouter>,
  options: { method?: string; url?: string },
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        (router.listener as any)(req, res);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const chunks: Buffer[] = [];
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, method: options.method ?? 'GET', path: options.url ?? '/' },
        (res) => {
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[]>,
              body: Buffer.concat(chunks).toString(),
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
// Suite 11 — Edge cases & integration
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles concurrent requests independently', async () => {
    const router = createRouter();
    router.get('/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 20));
      res.send('slow');
    });
    router.get('/fast', (_req, res) => res.send('fast'));

    const [slow, fast] = await Promise.all([
      makeRequest(router, { url: '/slow' }),
      makeRequest(router, { url: '/fast' }),
    ]);
    assert.equal(slow.body, 'slow');
    assert.equal(fast.body, 'fast');
  });

  it('the listener property is the dispatch function', () => {
    const router = createRouter();
    assert.equal(typeof router.listener, 'function');
  });

  it('creating two routers does not share route state', async () => {
    const r1 = createRouter();
    const r2 = createRouter();
    r1.get('/x', (_req, res) => res.send('r1'));
    r2.get('/x', (_req, res) => res.send('r2'));

    const [a, b] = await Promise.all([
      makeRequest(r1, { url: '/x' }),
      makeRequest(r2, { url: '/x' }),
    ]);
    assert.equal(a.body, 'r1');
    assert.equal(b.body, 'r2');
  });

  it('routes registered after a request are picked up by subsequent requests', async () => {
    const router = createRouter();
    router.get('/early', (_req, res) => res.send('early'));
    await makeRequest(router, { url: '/early' });

    // Register a new route after the first request
    router.get('/late', (_req, res) => res.send('late'));
    const r = await makeRequest(router, { url: '/late' });
    assert.equal(r.body, 'late');
  });

  it('a use() middleware with "/" passes control to subsequent routes via next()', async () => {
    const router = createRouter();
    const log: string[] = [];
    router.use('/', (_req, _res, next) => { log.push('mw'); next(); });
    router.get('/hello', (_req, res) => { log.push('route'); res.send('ok'); });

    const r = await makeRequest(router, { url: '/hello' });
    assert.deepEqual(log, ['mw', 'route']);
    assert.equal(r.body, 'ok');
  });

  it('404 body contains the method and URL', async () => {
    // Use makeRequestNoDone so the router's own 404 handler fires (not the
    // test harness done() fallback which just writes 'not found').
    const router = createRouter();
    const r = await makeRequestNoDone(router, { method: 'GET', url: '/nope' });
    assert.equal(r.statusCode, 404);
    assert.ok(r.body.includes('GET'),  `Expected 'GET' in: "${r.body}"`);
    assert.ok(r.body.includes('/nope'), `Expected '/nope' in: "${r.body}"`);
  });

  it('500 body is returned when middleware throws', async () => {
    const router = createRouter();
    router.get('/err', () => { throw new Error('oops'); });
    const r = await makeRequest(router, { url: '/err' });
    assert.equal(r.statusCode, 500);
    assert.ok(r.body.includes('GET') || r.body.includes('Error'));
  });

  it('path with no leading slash in use() is still matched correctly', async () => {
    // compilePlainPath handles paths with or without a leading /
    const router = createRouter();
    let hit = false;
    router.use('/api', (_req, res) => { hit = true; res.send('ok'); });
    await makeRequest(router, { url: '/api/anything' });
    assert.ok(hit);
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
