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
import { describe, it } from 'node:test';

import createRouter from '../src/router.ts';
import type { Middleware, RouterRequest, RouterResponse } from '../src/router.js';
import { json, parseBody, formData } from '../src/misc.ts';


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

  it('method routes match the endpoint, not a longer path prefix', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/users', (_req, res) => { hit = true; res.end('ok'); });

    const r = await makeRequest(router, { url: '/users/42' });
    assert.ok(!hit, 'GET /users must not handle /users/42');
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
// Suite 1b — compilePlainPath: inline regex constraints  (:name(pattern))
// ---------------------------------------------------------------------------

describe('compilePlainPath — inline constraints', () => {
  it('matches when the segment satisfies the constraint', async () => {
    const router = createRouter();
    let captured = '';
    router.get('/users/:id(\\d+)', (req, res) => {
      captured = req.params.id;
      res.end('ok');
    });
    const r = await makeRequest(router, { url: '/users/42' });
    assert.equal(r.statusCode, 200);
    assert.equal(captured, '42');
  });

  it('does NOT match when the segment violates the constraint', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/users/:id(\\d+)', (_req, res) => { hit = true; res.end('ok'); });
    const r = await makeRequest(router, { url: '/users/abc' });
    assert.ok(!hit, 'handler must not be called for a non-numeric segment');
    assert.equal(r.statusCode, 404);
  });

  it('a constrained and an unconstrained route can coexist — constrained wins for digits', async () => {
    const router = createRouter();
    const hits: string[] = [];
    router.get('/items/:id(\\d+)',  (_req, res) => { hits.push('numeric'); res.end('ok'); });
    router.get('/items/:slug',      (_req, res) => { hits.push('slug');    res.end('ok'); });

    await makeRequest(router, { url: '/items/99' });
    assert.deepEqual(hits, ['numeric']);

    hits.length = 0;
    await makeRequest(router, { url: '/items/hello' });
    assert.deepEqual(hits, ['slug']);
  });

  it('captures the constrained value in req.params', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    // The literal suffix '\\.txt' after the constraint means only segments
    // ending with '.txt' match; req.params.name holds the stem only.
    router.get('/files/:name([\\w-]+\\.txt)', (req, res) => {
      p = { ...req.params };
      res.end('ok');
    });
    const r = await makeRequest(router, { url: '/files/my-file.txt' });
    assert.equal(r.statusCode, 200);
    assert.equal(p.name, 'my-file.txt');
  });

  it('supports multiple constrained params in one route', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    router.get('/org/:org([a-z]+)/repo/:num(\\d+)', (req, res) => {
      p = { ...req.params };
      res.end('ok');
    });
    await makeRequest(router, { url: '/org/acme/repo/7' });
    assert.equal(p.org, 'acme');
    assert.equal(p.num, '7');
  });

  it('does not match when any one constrained param fails', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/org/:org([a-z]+)/repo/:num(\\d+)', (_req, res) => {
      hit = true; res.end('ok');
    });
    // 'ACME' fails [a-z]+
    const r = await makeRequest(router, { url: '/org/ACME/repo/7' });
    assert.ok(!hit);
    assert.equal(r.statusCode, 404);
  });

  it('supports nested parentheses in the constraint (alternation groups)', async () => {
    const router = createRouter();
    let captured = '';
    router.get('/mode/:m((dark|light))', (req, res) => {
      captured = req.params.m;
      res.end('ok');
    });
    await makeRequest(router, { url: '/mode/dark' });
    assert.equal(captured, 'dark');

    const r = await makeRequest(router, { url: '/mode/blue' });
    assert.equal(r.statusCode, 404);
  });

  it('mixed: constrained and plain params in the same route', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    // Constrained :ver must be digits; :resource is unconstrained.
    router.get('/v/:ver(\\d+)/:resource', (req, res) => {
      p = { ...req.params };
      res.end('ok');
    });
    const r = await makeRequest(router, { url: '/v/2/users' });
    assert.equal(r.statusCode, 200);
    assert.equal(p.ver, '2');
    assert.equal(p.resource, 'users');
  });

  it('throws SyntaxError for unbalanced parentheses', () => {
    assert.throws(
      () => createRouter().get('/x/:id(\\d+', (_req, res) => res.end()),
      (e: unknown) => e instanceof SyntaxError,
    );
  });

  it('treats trailing literal characters after the closing paren as a regex suffix', async () => {
    // ':id(\\d+)px' compiles to '(?<id>\\d+)px', matching e.g. '42px'
    const router = createRouter();
    let captured = '';
    router.get('/size/:id(\\d+)px', (req, res) => {
      captured = req.params.id;
      res.end('ok');
    });
    const hit  = await makeRequest(router, { url: '/size/42px' });
    const miss = await makeRequest(router, { url: '/size/42' });
    assert.equal(hit.statusCode, 200);
    assert.equal(captured, '42');
    assert.equal(miss.statusCode, 404);
  });

  it('throws SyntaxError when constraint contains a named capture group', () => {
    assert.throws(
      () => createRouter().get('/x/:id((?<inner>\\d+))', (_req, res) => res.end()),
      (e: unknown) => e instanceof SyntaxError,
    );
  });

  it('throws SyntaxError for an invalid regex in the constraint', () => {
    assert.throws(
      () => createRouter().get('/x/:id([invalid)', (_req, res) => res.end()),
      (e: unknown) => e instanceof SyntaxError,
    );
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

  it('* on a method route does not match a longer path prefix', async () => {
    const router = createRouter();
    let hit = false;
    router.get('/api/*', (_req, res) => { hit = true; res.end('ok'); });
    const r = await makeRequest(router, { url: '/api/users/123' });
    assert.ok(!hit, '/api/* should not handle /api/users/123 on a method route');
    assert.equal(r.statusCode, 404);
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

      for (const other of METHODS.filter((m) => m !== method)) {
        // Wrong methods — path matches but method doesn't → 405 Method Not Allowed.
        hit = false;
        const r2 = await makeRequestNoDone(router, { method: other, url: '/resource' });
        assert.ok(!hit, `${other} should not match ${method} route`);
        assert.equal(r2.statusCode, 405, `Expected 405 when ${other} hits a ${method}-only route`);
      }
    });
  }

  it('returns 405 with Allow header when path matches but method does not', async () => {
    const router = createRouter();
    router.get('/resource', (_req, res) => res.end('ok'));

    const r = await makeRequestNoDone(router, { method: 'POST', url: '/resource' });
    assert.equal(r.statusCode, 405);
    assert.ok(r.headers['allow'], 'Allow header should be present on 405 response');
    assert.ok(
      (r.headers['allow'] as string).includes('GET'),
      `Expected GET in Allow: ${r.headers['allow']}`,
    );
  });

  it('does not return 405 when only a longer path prefix matches', async () => {
    const router = createRouter();
    router.get('/resource', (_req, res) => res.end('ok'));

    const r = await makeRequestNoDone(router, { method: 'POST', url: '/resource/extra' });
    assert.equal(r.statusCode, 404);
  });

  it('Allow header on 405 lists all registered methods for that path', async () => {
    const router = createRouter();
    router.get('/data',  (_req, res) => res.end('ok'));
    router.post('/data', (_req, res) => res.end('ok'));

    const r = await makeRequestNoDone(router, { method: 'DELETE', url: '/data' });
    assert.equal(r.statusCode, 405);
    const allow = (r.headers['allow'] as string ?? '')
      .split(',').map((m) => m.trim());
    assert.ok(allow.includes('GET'),  `Expected GET in Allow: ${r.headers['allow']}`);
    assert.ok(allow.includes('POST'), `Expected POST in Allow: ${r.headers['allow']}`);
  });

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

  it('returns 500 when an async middleware rejects (FIX-02)', async () => {
    // Before FIX-02, this produced an unhandled rejection instead of a 500 response.
    const router = createRouter();
    router.get('/async-err', async () => {
      throw new Error('async kaboom');
    });
    const r = await makeRequest(router, { url: '/async-err' });
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

    it('multiple res.cookie() calls produce multiple Set-Cookie headers (FIX-01)', async () => {
      // Before FIX-01, each call overwrote the previous Set-Cookie header value.
      const router = createRouter();
      router.get('/multi', (_req, res) => {
        res.cookie('a', '1').cookie('b', '2').send('ok');
      });
      const r = await makeRequest(router, { url: '/multi' });
      const sc = r.headers['set-cookie'];
      assert.ok(Array.isArray(sc), `Expected array of Set-Cookie headers, got: ${JSON.stringify(sc)}`);
      assert.equal(sc.length, 2, `Expected 2 Set-Cookie entries, got ${sc.length}: ${JSON.stringify(sc)}`);
      assert.ok(sc.some((c) => c.includes('a=1')), `Expected a=1 cookie in: ${JSON.stringify(sc)}`);
      assert.ok(sc.some((c) => c.includes('b=2')), `Expected b=2 cookie in: ${JSON.stringify(sc)}`);
    });

    it('three res.cookie() calls accumulate all three Set-Cookie headers', async () => {
      const router = createRouter();
      router.get('/triple', (_req, res) => {
        res.cookie('x', 'one').cookie('y', 'two').cookie('z', 'three').send('ok');
      });
      const r = await makeRequest(router, { url: '/triple' });
      const sc = r.headers['set-cookie'];
      assert.ok(Array.isArray(sc), 'Expected array');
      assert.equal(sc.length, 3);
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
// Suite 10 — Cookie encoding / decoding (FIX-05 + FIX-06)
// ---------------------------------------------------------------------------

describe('Cookie encoding and decoding (FIX-05 + FIX-06)', () => {
  // ── FIX-06: j: prefix decoding on read ──────────────────────────────────

  describe('JSON cookie round-trip (j: prefix)', () => {
    it('reading a j: prefixed cookie returns the parsed JS object', async () => {
      const router = createRouter();
      let captured: unknown;
      router.get('/me', (req, res) => { captured = req.cookies['data']; res.send('ok'); });
      // Send the j: prefix manually in the Cookie header
      await makeRequest(router, {
        url:     '/me',
        headers: { cookie: 'data=j:{"role":"admin","level":3}' },
      });
      assert.deepEqual(captured, { role: 'admin', level: 3 });
    });

    it('writing an object cookie and reading it back returns the object (FIX-06)', async () => {
      // Write side: res.cookie with object value produces j:... on the wire.
      // Read side: the j: prefix is decoded so req.cookies gets the JS object.
      const router = createRouter();
      let setHeader = '';
      let readBack: unknown;

      // Route 1: set the cookie, capture the Set-Cookie header
      router.get('/set', (_req, res) => {
        res.cookie('prefs', { theme: 'dark' }).send('ok');
      });
      // Route 2: read the cookie (simulated by re-sending the header value)
      router.get('/read', (req, res) => {
        readBack = req.cookies['prefs'];
        res.send('ok');
      });

      const setResp = await makeRequest(router, { url: '/set' });
      const sc = setResp.headers['set-cookie'];
      const cookieHeader = Array.isArray(sc) ? sc[0] : sc ?? '';
      // Extract just the name=value part (before the first ';')
      setHeader = cookieHeader.split(';')[0].trim();

      await makeRequest(router, { url: '/read', headers: { cookie: setHeader } });
      assert.deepEqual(readBack, { theme: 'dark' });
    });

    it('j: cookie with invalid JSON falls back to the raw string', async () => {
      const router = createRouter();
      let captured: unknown;
      router.get('/me', (req, res) => { captured = req.cookies['bad']; res.send('ok'); });
      await makeRequest(router, {
        url:     '/me',
        headers: { cookie: 'bad=j:{not valid json}' },
      });
      // Malformed JSON — the raw value (including j: prefix) is returned
      assert.equal(typeof captured, 'string');
      assert.ok((captured as string).startsWith('j:'));
    });

    it('plain string cookies are returned unchanged', async () => {
      const router = createRouter();
      let captured: unknown;
      router.get('/me', (req, res) => { captured = req.cookies['tok']; res.send('ok'); });
      await makeRequest(router, {
        url:     '/me',
        headers: { cookie: 'tok=abc123' },
      });
      assert.equal(captured, 'abc123');
    });
  });

  // ── FIX-05: Signed cookie write + read ──────────────────────────────────

  describe('Signed cookies (FIX-05)', () => {
    const SECRET = 'test-secret-do-not-use-in-prod';

    it('res.cookie() with signed:true produces an s: prefixed Set-Cookie value', async () => {
      const router = createRouter({ secret: SECRET });
      router.get('/set', (_req, res) => {
        res.cookie('session', 'user-42', { signed: true }).send('ok');
      });
      const r = await makeRequest(router, { url: '/set' });
      const sc = r.headers['set-cookie'];
      const cookie = Array.isArray(sc) ? sc[0] : sc ?? '';
      const val = cookie.split(';')[0].split('=').slice(1).join('=');
      assert.ok(val.startsWith('s:'), `Expected s: prefix, got: ${val}`);
    });

    it('signed cookie round-trip: written value is readable via req.cookies', async () => {
      // Set on one request, read on the next (simulated).
      const router = createRouter({ secret: SECRET });
      let readBack: unknown;

      router.get('/set',  (_req, res) => res.cookie('sid', 'user-7', { signed: true }).send('ok'));
      router.get('/read', (req,  res) => { readBack = req.cookies['sid']; res.send('ok'); });

      const setResp = await makeRequest(router, { url: '/set' });
      const sc = setResp.headers['set-cookie'];
      const cookieHeader = Array.isArray(sc) ? sc[0] : sc ?? '';
      const rawPair = cookieHeader.split(';')[0].trim(); // "sid=s:user-7.SIG"

      await makeRequest(router, { url: '/read', headers: { cookie: rawPair } });
      // After verification, req.cookies should contain the plain inner value
      assert.equal(readBack, 'user-7');
    });

    it('signed JSON cookie round-trip: object survives write → verify → decode', async () => {
      const router = createRouter({ secret: SECRET });
      let readBack: unknown;

      router.get('/set',  (_req, res) => res.cookie('prefs', { lang: 'fr' }, { signed: true }).send('ok'));
      router.get('/read', (req,  res) => { readBack = req.cookies['prefs']; res.send('ok'); });

      const setResp = await makeRequest(router, { url: '/set' });
      const sc = setResp.headers['set-cookie'];
      const cookieHeader = Array.isArray(sc) ? sc[0] : sc ?? '';
      const rawPair = cookieHeader.split(';')[0].trim();

      await makeRequest(router, { url: '/read', headers: { cookie: rawPair } });
      assert.deepEqual(readBack, { lang: 'fr' });
    });

    it('tampered signed cookie is silently omitted from req.cookies', async () => {
      const router = createRouter({ secret: SECRET });
      let captured: unknown = 'PRESENT'; // sentinel — should be overwritten to undefined

      router.get('/read', (req, res) => {
        captured = req.cookies['tok'];
        res.send('ok');
      });

      // Build a valid signed value then corrupt the signature
      const tampered = 's:legitimate-value.INVALIDSIGNATUREXXXXXX';
      await makeRequest(router, {
        url:     '/read',
        headers: { cookie: `tok=${tampered}` },
      });
      assert.equal(captured, undefined, 'Tampered cookie should not appear in req.cookies');
    });

    it('different signature key → tampered → cookie omitted', async () => {
      const routerA = createRouter({ secret: 'secret-A' });
      const routerB = createRouter({ secret: 'secret-B' });
      let capturedB: unknown = 'PRESENT';

      // Sign with A
      routerA.get('/set', (_req, res) => res.cookie('x', 'val', { signed: true }).send('ok'));
      // Read with B (wrong secret)
      routerB.get('/read', (req, res) => { capturedB = req.cookies['x']; res.send('ok'); });

      const setResp = await makeRequest(routerA, { url: '/set' });
      const sc = setResp.headers['set-cookie'];
      const rawPair = ((Array.isArray(sc) ? sc[0] : sc) ?? '').split(';')[0].trim();

      await makeRequest(routerB, { url: '/read', headers: { cookie: rawPair } });
      assert.equal(capturedB, undefined, 'Cookie signed with a different key should be omitted');
    });

    it('calling res.cookie() with signed:true without a secret throws synchronously', async () => {
      // createRouter() without a secret — signed cookies should throw
      const router = createRouter(); // no secret
      router.get('/set', (_req, res) => {
        // This throw is caught by the router's invoke() wrapper → 500 response
        res.cookie('x', 'val', { signed: true }).send('ok');
      });
      const r = await makeRequest(router, { url: '/set' });
      assert.equal(r.statusCode, 500);
    });

    it('s: prefixed cookie without a router secret is preserved as raw string', async () => {
      // Without a secret the router cannot verify, so the raw value is kept.
      const router = createRouter(); // no secret
      let captured: unknown;
      router.get('/read', (req, res) => { captured = req.cookies['raw']; res.send('ok'); });
      await makeRequest(router, {
        url:     '/read',
        headers: { cookie: 'raw=s:something.fakesig' },
      });
      assert.equal(captured, 's:something.fakesig');
    });
  });

  // ── Additional CookieOptions attributes ─────────────────────────────────

  describe('CookieOptions — httpOnly / secure / sameSite', () => {
    it('httpOnly:true adds HttpOnly to Set-Cookie', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => res.cookie('x', '1', { httpOnly: true }).send('ok'));
      const r = await makeRequest(router, { url: '/set' });
      const sc = (Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie']) ?? '';
      assert.ok(sc.includes('HttpOnly'), `Expected HttpOnly in: ${sc}`);
    });

    it('secure:true adds Secure to Set-Cookie', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => res.cookie('x', '1', { secure: true }).send('ok'));
      const r = await makeRequest(router, { url: '/set' });
      const sc = (Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie']) ?? '';
      assert.ok(sc.includes('Secure'), `Expected Secure in: ${sc}`);
    });

    it('sameSite:Strict adds SameSite=Strict to Set-Cookie', async () => {
      const router = createRouter();
      router.get('/set', (_req, res) => res.cookie('x', '1', { sameSite: 'Strict' }).send('ok'));
      const r = await makeRequest(router, { url: '/set' });
      const sc = (Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie']) ?? '';
      assert.ok(sc.includes('SameSite=Strict'), `Expected SameSite=Strict in: ${sc}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 11 — router.listen() return value
// ---------------------------------------------------------------------------

/**
 * Start the router on an ephemeral port and return the bound port number.
 * The caller is responsible for closing the server.
 */
function listenEphemeral(router: ReturnType<typeof createRouter>): Promise<{ server: ReturnType<typeof router.listen>, port: number }> {
  return new Promise((resolve) => {
    const server = router.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe('router.listen() server handle', () => {
  it('returns an object with .close() and .address() methods', async () => {
    const router = createRouter();
    router.get('/', (_req, res) => res.end('ok'));
    const { server } = await listenEphemeral(router);
    assert.ok(server, 'listen() must return a value');
    assert.equal(typeof (server as any).close,   'function', 'returned object must have .close()');
    assert.equal(typeof (server as any).address, 'function', 'returned object must have .address()');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('exposes the OS-assigned ephemeral port via server.address()', async () => {
    const router = createRouter();
    router.get('/', (_req, res) => res.end('ok'));
    const { server, port } = await listenEphemeral(router);
    assert.ok(typeof port === 'number', 'port must be a number');
    assert.ok(port > 0, 'OS-assigned port must be greater than 0');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('can gracefully shut down via server.close()', async () => {
    const router = createRouter();
    router.get('/', (_req, res) => res.end('ok'));
    const { server } = await listenEphemeral(router);
    // server.close() resolves cleanly — if it rejects, the test fails
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('serves real HTTP requests on the returned server', async () => {
    const router = createRouter();
    router.get('/ping', (_req, res) => res.send('pong'));
    const { server, port } = await listenEphemeral(router);

    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: '/ping' },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.on('error', reject);
      req.end();
    });

    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(body, 'pong');
  });
});

// ---------------------------------------------------------------------------
// Suite 12 — registerRoute error handling
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
// Uses router.listen(0) directly now that listen() returns the server instance.
function makeRequestNoDone(
  router: ReturnType<typeof createRouter>,
  options: { method?: string; url?: string },
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    // router.listen() now returns the underlying server — no need to create
    // one manually.  The 'listening' event fires once the OS has bound the port.
    const server = router.listen(0);
    server.on('listening', () => {
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
// Suite 13 — Edge cases & integration
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
// Suite 14 — FEAT-03: Repeated query-string keys produce arrays
// ---------------------------------------------------------------------------

describe('FEAT-03: repeated query-string keys', () => {
  it('single key → plain string in queries.url', async () => {
    const router = createRouter();
    let q: Record<string, string | string[]> = {};
    router.get('/q', (req, res) => {
      q = { ...(req.queries.url ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/q?color=red' });
    assert.equal(q.color, 'red');
    assert.ok(!Array.isArray(q.color), 'single key must be a plain string');
  });

  it('two occurrences of same key → array in queries.url', async () => {
    const router = createRouter();
    let q: Record<string, string | string[]> = {};
    router.get('/q', (req, res) => {
      q = { ...(req.queries.url ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/q?tag=a&tag=b' });
    assert.deepEqual(q.tag, ['a', 'b']);
  });

  it('three occurrences produce a three-element array', async () => {
    const router = createRouter();
    let q: Record<string, string | string[]> = {};
    router.get('/q', (req, res) => {
      q = { ...(req.queries.url ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/q?x=1&x=2&x=3' });
    assert.deepEqual(q.x, ['1', '2', '3']);
  });

  it('repeated key uses first value in flat req.params', async () => {
    const router = createRouter();
    let p: Record<string, string> = {};
    router.get('/q', (req, res) => {
      p = { ...req.params };
      res.end('ok');
    });
    await makeRequest(router, { url: '/q?item=first&item=second' });
    // req.params is StringMap — only first value is stored
    assert.equal(p.item, 'first');
  });

  it('different keys are not affected by array logic', async () => {
    const router = createRouter();
    let q: Record<string, string | string[]> = {};
    router.get('/q', (req, res) => {
      q = { ...(req.queries.url ?? {}) };
      res.end('ok');
    });
    await makeRequest(router, { url: '/q?a=1&b=2&a=3' });
    assert.deepEqual(q.a, ['1', '3']);
    assert.equal(q.b, '2');
  });
});

// ---------------------------------------------------------------------------
// Suite 15 — req.text() / req.formData() extension methods (Task #18)
// ---------------------------------------------------------------------------

/**
 * Make an HTTP POST request carrying a body through a given router, returning
 * the collected response.  Used by extension-method tests.
 */
function makeBodyRequest(
  router: ReturnType<typeof createRouter>,
  options: {
    method?:  string;
    url?:     string;
    headers?: Record<string, string>;
    body?:    Buffer;
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
          path:    options.url     ?? '/',
          headers: { ...extraHeaders, ...(options.headers ?? {}) },
        },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers as Record<string, string | string[]>,
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

describe('req.text() / req.formData() extension methods (Task #18)', () => {
  it('req.text() reads and returns the raw body as a string', async () => {
    const router = createRouter();
    router.post('/', async (req, res) => {
      const txt = await req.text();
      (res as any).status(200).send(txt ?? '(null)');
    });
    const r = await makeBodyRequest(router, {
      body:    Buffer.from('hello extension'),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'hello extension');
  });

  it('req.text() returns null when there is no body', async () => {
    const router = createRouter();
    router.get('/', async (req, res) => {
      const txt = await req.text();
      (res as any).status(200).send(txt === null ? 'null' : 'not-null');
    });
    const r = await makeRequest(router, { url: '/' });
    assert.equal(r.body, 'null');
  });

  it('req.json() returns the parsed object', async () => {
    const router = createRouter();
    let parsed: unknown;
    router.post('/', async (req, res) => {
      parsed = await req.json();
      (res as any).status(200).send('ok');
    });
    const r = await makeBodyRequest(router, {
      body:    Buffer.from('{"ext":true}'),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parsed, { ext: true });
  });

  it('req.json() returns null when there is no body', async () => {
    const router = createRouter();
    router.get('/', async (req, res) => {
      const val = await req.json();
      (res as any).status(200).send(val === null ? 'null' : 'not-null');
    });
    const r = await makeRequest(router, { url: '/' });
    assert.equal(r.body, 'null');
  });

  it('req.json() rejects with { status: 400 } for invalid JSON', async () => {
    const router = createRouter();
    let errorStatus = 0;
    router.post('/', async (req, res) => {
      try {
        await req.json();
      } catch (e: any) {
        errorStatus = e.status ?? 0;
      }
      (res as any).status(200).send('caught');
    });
    await makeBodyRequest(router, {
      body:    Buffer.from('{bad json}'),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(errorStatus, 400, 'FIX-09: should reject with status 400');
  });

  it('req.formData() parses multipart body and returns FormPart[]', async () => {
    const boundary = 'ExtBoundary';
    const part1    = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--${boundary}--\r\n`);

    const router = createRouter();
    let parts: unknown;
    router.post('/', async (req, res) => {
      parts = await req.formData();
      (res as any).status(200).send('ok');
    });
    const r = await makeBodyRequest(router, {
      body:    part1,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.equal(r.statusCode, 200);
    assert.ok(Array.isArray(parts), 'formData() should return an array');
    assert.equal((parts as any[])[0].content.toString(), 'value');
  });

  it('req.formData() returns null when there is no body', async () => {
    const router = createRouter();
    router.post('/', async (req, res) => {
      const val = await req.formData();
      (res as any).status(200).send(val === null ? 'null' : 'not-null');
    });
    const r = await makeBodyRequest(router, {
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
    });
    assert.equal(r.body, 'null');
  });

  it('req.text() rejects with { status: 413 } when body exceeds limit', async () => {
    const router = createRouter();
    let errorStatus = 0;
    router.post('/', async (req, res) => {
      try {
        await req.text({ limit: '5b' });
      } catch (e: any) {
        errorStatus = e.status ?? 0;
      }
      (res as any).status(200).send('caught');
    });
    await makeBodyRequest(router, {
      body:    Buffer.from('way too large for 5 bytes'),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(errorStatus, 413, 'FIX-09: should reject with status 413');
  });

  it('req.json() returns cached req.body when json() middleware already ran', async () => {
    const router = createRouter();
    let result: unknown;
    router.post('/', json(), async (req, res) => {
      // Body stream already consumed by json() middleware — req.json() must return the cached value.
      result = await (req as any).json();
      (res as any).status(200).send('ok');
    });
    await makeBodyRequest(router, {
      body:    Buffer.from('{"cached":true}'),
      headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual(result, { cached: true });
  });

  it('req.text() returns cached req.body when parseBody() middleware already ran', async () => {
    const router = createRouter();
    let result: unknown;
    router.post('/', parseBody(), async (req, res) => {
      result = await (req as any).text();
      (res as any).status(200).send('ok');
    });
    await makeBodyRequest(router, {
      body:    Buffer.from('hello cached'),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(result, 'hello cached');
  });

  it('req.formData() returns cached req.body when formData() middleware already ran', async () => {
    const boundary = 'CachedBoundary';
    const part     = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="f"\r\n\r\ncached\r\n--${boundary}--\r\n`);
    const router   = createRouter();
    let result: unknown;
    router.post('/', formData(), async (req, res) => {
      result = await (req as any).formData();
      (res as any).status(200).send('ok');
    });
    await makeBodyRequest(router, {
      body:    part,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.ok(Array.isArray(result));
    assert.equal((result as any[])[0].content.toString(), 'cached');
  });
});

// ---------------------------------------------------------------------------
// Suite 16 — router.onError()
// ---------------------------------------------------------------------------

describe('router.onError()', () => {
  it('onError handler is called instead of the default 500 when middleware throws', async () => {
    const router = createRouter();
    let caughtErr: unknown;
    router.onError((err, _req, res) => {
      caughtErr = err;
      res.status(500).send('caught');
    });
    router.get('/boom', () => { throw new Error('kaboom'); });

    const r = await makeRequest(router, { url: '/boom' });
    assert.equal(r.statusCode, 500);
    assert.equal(r.body, 'caught');
    assert.ok(caughtErr instanceof Error, 'error handler should receive the thrown Error');
  });

  it('onError handler is called when an async middleware rejects', async () => {
    const router = createRouter();
    let caughtMsg = '';
    router.onError((err, _req, res) => {
      caughtMsg = String(err);
      res.status(500).send('async caught');
    });
    router.get('/async-err', async () => { throw new Error('async boom'); });

    const r = await makeRequest(router, { url: '/async-err' });
    assert.equal(r.statusCode, 500);
    assert.equal(r.body, 'async caught');
    assert.ok(caughtMsg.includes('async boom'));
  });

  it('onError handler is called when next(err) is used', async () => {
    const router = createRouter();
    let seen: unknown;
    router.onError((err, _req, res) => { seen = err; res.status(422).send('from next'); });
    router.get('/fail', (_req, _res, next) => next('validation error'));

    const r = await makeRequest(router, { url: '/fail' });
    assert.equal(r.statusCode, 422);
    assert.equal(r.body, 'from next');
    assert.equal(seen, 'validation error');
  });

  it('next(err) skips remaining middleware and goes straight to error handler', async () => {
    const router = createRouter();
    let secondCalled = false;
    router.onError((_err, _req, res) => res.status(500).send('error'));
    router.get('/fail', (_req, _res, next) => next(new Error('stop')));
    router.get('/fail', (_req, res) => { secondCalled = true; res.send('should not reach here'); });

    await makeRequest(router, { url: '/fail' });
    assert.ok(!secondCalled, 'second handler must not be called after next(err)');
  });

  it('calling onError again replaces the previous handler', async () => {
    const router = createRouter();
    router.onError((_err, _req, res) => res.status(500).send('first'));
    router.onError((_err, _req, res) => res.status(500).send('second'));
    router.get('/boom', () => { throw new Error('x'); });

    const r = await makeRequest(router, { url: '/boom' });
    assert.equal(r.body, 'second');
  });

  it('without onError, sync throws still produce a 500', async () => {
    const router = createRouter();
    router.get('/boom', () => { throw new Error('raw'); });
    const r = await makeRequest(router, { url: '/boom' });
    assert.equal(r.statusCode, 500);
  });
});

// ---------------------------------------------------------------------------
// Suite 17 — router.setNotFound()
// ---------------------------------------------------------------------------

describe('router.setNotFound()', () => {
  it('setNotFound handler fires instead of default 404 when no route matches', async () => {
    const router = createRouter();
    router.setNotFound((_req, res) => res.status(404).send('custom 404'));
    router.get('/exists', (_req, res) => res.send('ok'));

    const r = await makeRequestNoDone(router, { url: '/missing' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body, 'custom 404');
  });

  it('setNotFound handler is NOT called when a route matches', async () => {
    const router = createRouter();
    let notFoundCalled = false;
    router.setNotFound((_req, res) => { notFoundCalled = true; res.status(404).send('nf'); });
    router.get('/exists', (_req, res) => res.send('found'));

    const r = await makeRequestNoDone(router, { url: '/exists' });
    assert.equal(r.statusCode, 200);
    assert.ok(!notFoundCalled, 'setNotFound must not be called when a route matches');
  });

  it('done() callback takes precedence over setNotFound (sub-router behaviour)', async () => {
    // When the router is used as a sub-router (has a done()), the done() is
    // called on no-match rather than setNotFound — the parent is responsible.
    const child = createRouter();
    let childNotFound = false;
    child.setNotFound((_req, res) => { childNotFound = true; res.status(404).send('child nf'); });

    const parent = createRouter();
    let doneCalled = false;
    parent.use('/', (req, res, next) => {
      (child.listener as any)(req, res, () => { doneCalled = true; next(); });
    });
    parent.get('/fallback', (_req, res) => res.send('parent fallback'));

    const r = await makeRequest(parent, { url: '/fallback' });
    assert.ok(doneCalled, 'done() should be called when child has no match');
    assert.ok(!childNotFound, 'child setNotFound must not fire when done() is available');
    assert.equal(r.body, 'parent fallback');
  });

  it('setNotFound handler can send JSON', async () => {
    const router = createRouter();
    router.setNotFound((_req, res) => res.status(404).json({ error: 'not found' }));

    const r = await makeRequestNoDone(router, { url: '/ghost' });
    assert.equal(r.statusCode, 404);
    assert.ok(r.headers['content-type']?.includes('application/json'));
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  });
});

// ---------------------------------------------------------------------------
// Suite 18 — router.routes()
// ---------------------------------------------------------------------------

describe('router.routes()', () => {
  it('returns an empty array for a fresh router', () => {
    const router = createRouter();
    assert.deepEqual(router.routes(), []);
  });

  it('returns one entry per registered layer', () => {
    const router = createRouter();
    router.get('/a', (_req, res) => res.send('ok'));
    router.post('/b', (_req, res) => res.send('ok'));
    assert.equal(router.routes().length, 2);
  });

  it('returned entries have correct method and path', () => {
    const router = createRouter();
    router.get('/users', (_req, res) => res.send('ok'));
    router.post('/items', (_req, res) => res.send('ok'));

    const info = router.routes();
    assert.ok(info.some((r) => r.method === 'GET'  && r.path === '/users'));
    assert.ok(info.some((r) => r.method === 'POST' && r.path === '/items'));
  });

  it('use() layers have stripPath: true; method layers have stripPath: false', () => {
    const router = createRouter();
    router.use('/prefix', (_req, _res, next) => next());
    router.get('/exact', (_req, res) => res.send('ok'));

    const info = router.routes();
    const prefixEntry = info.find((r) => r.path === '/prefix');
    const exactEntry  = info.find((r) => r.path === '/exact');
    assert.ok(prefixEntry?.stripPath  === true,  'use() layer must have stripPath true');
    assert.ok(exactEntry?.stripPath   === false, 'get() layer must have stripPath false');
  });

  it('use() with null method; get() with method GET', () => {
    const router = createRouter();
    router.use('/mw', (_req, _res, next) => next());
    router.get('/route', (_req, res) => res.send('ok'));

    const info = router.routes();
    assert.equal(info.find((r) => r.path === '/mw')?.method,    null);
    assert.equal(info.find((r) => r.path === '/route')?.method, 'GET');
  });

  it('routes() returns a snapshot — adding routes later updates future calls', () => {
    const router = createRouter();
    router.get('/first', (_req, res) => res.send('ok'));
    const snap1 = router.routes();

    router.post('/second', (_req, res) => res.send('ok'));
    const snap2 = router.routes();

    assert.equal(snap1.length, 1);
    assert.equal(snap2.length, 2);
  });

  it('mutating the returned array does not affect the live route table', () => {
    const router = createRouter();
    router.get('/x', (_req, res) => res.send('ok'));

    const snap = router.routes();
    snap.splice(0); // clear the snapshot

    assert.equal(router.routes().length, 1, 'Live route table must be unaffected');
  });
});

// ---------------------------------------------------------------------------
// Suite 19 — createRouter(prefix) + app.use(v1) shorthand
// ---------------------------------------------------------------------------

describe('createRouter(prefix) + app.use(v1)', () => {
  it('createRouter stores the prefix on router.prefix', () => {
    const v1 = createRouter('/api/v1');
    assert.equal(v1.prefix, '/api/v1');
  });

  it('createRouter() without prefix has undefined router.prefix', () => {
    const r = createRouter();
    assert.equal(r.prefix, undefined);
  });

  it('app.use(v1) mounts the sub-router at v1.prefix automatically', async () => {
    const v1 = createRouter('/api/v1');
    v1.get('/users', (_req, res) => res.send('users'));

    const app = createRouter();
    app.use(v1); // no explicit path — uses v1.prefix

    const r = await makeRequest(app, { url: '/api/v1/users' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'users');
  });

  it('a request outside the prefix returns 404', async () => {
    const v1 = createRouter('/api/v1');
    v1.get('/users', (_req, res) => res.send('users'));

    const app = createRouter();
    app.use(v1);

    const r = await makeRequest(app, { url: '/api/v2/users' });
    assert.equal(r.statusCode, 404);
  });

  it('prefix can be combined with options', () => {
    const r = createRouter('/api/v1', { secret: 'shhh' });
    assert.equal(r.prefix, '/api/v1');
  });

  it('sub-router routes receive the stripped path suffix', async () => {
    const v1 = createRouter('/api/v1');
    let seenPath = '';
    v1.get('/items', (req, res) => { seenPath = req.path; res.send('ok'); });

    const app = createRouter();
    app.use(v1);

    await makeRequest(app, { url: '/api/v1/items' });
    assert.equal(seenPath, '/items');
  });

  it('multiple prefixed sub-routers are all reachable', async () => {
    const v1 = createRouter('/v1');
    v1.get('/ping', (_req, res) => res.send('v1'));

    const v2 = createRouter('/v2');
    v2.get('/ping', (_req, res) => res.send('v2'));

    const app = createRouter();
    app.use(v1);
    app.use(v2);

    const r1 = await makeRequest(app, { url: '/v1/ping' });
    const r2 = await makeRequest(app, { url: '/v2/ping' });
    assert.equal(r1.body, 'v1');
    assert.equal(r2.body, 'v2');
  });

  it('app.use(v1) without a prefix defaults to mounting at /', async () => {
    const child = createRouter(); // no prefix
    child.get('/hello', (_req, res) => res.send('hello'));

    const app = createRouter();
    app.use(child); // should mount at '/'

    const r = await makeRequest(app, { url: '/hello' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Suite 20 — router.shutdown()
// ---------------------------------------------------------------------------

describe('router.shutdown()', () => {
  it('shutdown() resolves immediately when listen() was never called', async () => {
    const router = createRouter();
    // Should not throw or hang.
    await assert.doesNotReject(router.shutdown());
  });

  it('shutdown() stops the server from accepting new connections', async () => {
    const router = createRouter();
    router.get('/ping', (_req, res) => res.send('pong'));

    const server = await new Promise<ReturnType<typeof router.listen>>((resolve) => {
      const s = router.listen(0, () => resolve(s));
    });
    const addr = server.address() as net.AddressInfo;
    const port = addr.port;

    // Verify server is up.
    const body1 = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const req = http.request({ host: '127.0.0.1', port, path: '/ping' }, (res) => {
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body1, 'pong');

    // Shut down.
    await router.shutdown(200);
    assert.ok(!(server as any).listening, 'Server should no longer be listening after shutdown');
  });

  it('shutdown() with timeout 0 still closes the server', async () => {
    const router = createRouter();
    router.get('/', (_req, res) => res.send('ok'));

    await new Promise<void>((resolve) => { router.listen(0, () => resolve()); });
    // timeout=0 means no forced socket destroy, but close() is still called
    await assert.doesNotReject(router.shutdown(0));
  });
});

// ---------------------------------------------------------------------------
// Suite 21 — router.timeout option (request timeout → 408)
// ---------------------------------------------------------------------------

describe('RouterOptions.timeout — request timeout', () => {
  it('sends 408 when a handler never responds within the timeout window', async () => {
    const router = createRouter({ timeout: 60 }); // 60 ms
    router.get('/stall', () => {
      // Deliberately does nothing — handler never calls res.end().
    });

    const r = await makeRequest(router, { url: '/stall' });
    assert.equal(r.statusCode, 408, `Expected 408 Request Timeout, got ${r.statusCode}`);
  });

  it('does NOT send 408 when a handler responds before the timeout', async () => {
    const router = createRouter({ timeout: 500 }); // generous timeout
    router.get('/fast', (_req, res) => res.send('quick'));

    const r = await makeRequest(router, { url: '/fast' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'quick');
  });

  it('without a timeout option, slow handlers are not interrupted', async () => {
    const router = createRouter(); // no timeout
    router.get('/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 80));
      res.send('eventually');
    });

    const r = await makeRequest(router, { url: '/slow' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'eventually');
  });
});

// ---------------------------------------------------------------------------
// Suite 22 — res.json() Content-Type header
// ---------------------------------------------------------------------------

describe('res.json() sets Content-Type: application/json', () => {
  it('res.json() includes application/json in the Content-Type header', async () => {
    const router = createRouter();
    router.get('/data', (_req, res) => res.json({ ok: true }));
    const r = await makeRequest(router, { url: '/data' });
    assert.ok(
      (r.headers['content-type'] as string)?.includes('application/json'),
      `Expected application/json in Content-Type, got: ${r.headers['content-type']}`,
    );
  });
});

describe('req.ip — client IP resolution', () => {
  it('defaults to socket remoteAddress when trustProxy is not set', async () => {
    const router = createRouter();
    let capturedIp = '';
    router.get('/ip', (req, res) => { capturedIp = req.ip; res.end('ok'); });
    await makeRequest(router, { url: '/ip' });
    // Real HTTP server: remoteAddress is '127.0.0.1' or '::ffff:127.0.0.1'.
    assert.ok(capturedIp !== '', 'req.ip should be non-empty');
    assert.ok(
      capturedIp.includes('127.0.0.1') || capturedIp === '::1',
      `Expected loopback address, got: ${capturedIp}`,
    );
  });

  it('defaults to socket remoteAddress when trustProxy is false', async () => {
    const router = createRouter({ trustProxy: false });
    let capturedIp = '';
    router.get('/ip', (req, res) => { capturedIp = req.ip; res.end('ok'); });
    await makeRequest(router, { url: '/ip' });
    assert.ok(capturedIp !== '', 'req.ip should be non-empty');
    assert.ok(
      capturedIp.includes('127.0.0.1') || capturedIp === '::1',
      `Expected loopback address, got: ${capturedIp}`,
    );
  });

  it('ignores X-Forwarded-For when trustProxy is false', async () => {
    const router = createRouter({ trustProxy: false });
    let capturedIp = '';
    router.get('/ip', (req, res) => { capturedIp = req.ip; res.end('ok'); });
    await makeRequest(router, {
      url: '/ip',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    assert.ok(
      capturedIp.includes('127.0.0.1') || capturedIp === '::1',
      `Expected loopback (not 1.2.3.4), got: ${capturedIp}`,
    );
  });

  it('uses first X-Forwarded-For entry when trustProxy is true', async () => {
    const router = createRouter({ trustProxy: true });
    let capturedIp = '';
    router.get('/ip', (req, res) => { capturedIp = req.ip; res.end('ok'); });
    await makeRequest(router, {
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    assert.equal(capturedIp, '203.0.113.5');
  });

  it('falls back to socket address when X-Forwarded-For is absent and trustProxy is true', async () => {
    const router = createRouter({ trustProxy: true });
    let capturedIp = '';
    router.get('/ip', (req, res) => { capturedIp = req.ip; res.end('ok'); });
    await makeRequest(router, { url: '/ip' });
    assert.ok(capturedIp !== '', 'req.ip should be non-empty');
    assert.ok(
      capturedIp.includes('127.0.0.1') || capturedIp === '::1',
      `Expected loopback, got: ${capturedIp}`,
    );
  });

  it('handles a single-value X-Forwarded-For header correctly', async () => {
    const router = createRouter({ trustProxy: true });
    let capturedIp = '';
    router.get('/ip', (req, res) => { capturedIp = req.ip; res.end('ok'); });
    await makeRequest(router, {
      url: '/ip',
      headers: { 'x-forwarded-for': '198.51.100.42' },
    });
    assert.equal(capturedIp, '198.51.100.42');
  });
});

// ---------------------------------------------------------------------------
// Suite 24 — res.type()
// ---------------------------------------------------------------------------

describe('res.type() — set Content-Type header', () => {
  it('sets the Content-Type header to the provided MIME type', async () => {
    const router = createRouter();
    router.get('/csv', (_req, res) => {
      res.type('text/csv').send('a,b\n1,2');
    });
    const r = await makeRequest(router, { url: '/csv' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'text/csv');
  });

  it('returns this for chaining with send()', async () => {
    const router = createRouter();
    router.get('/xml', (_req, res) => {
      res.type('application/xml').send('<root/>');
    });
    const r = await makeRequest(router, { url: '/xml' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/xml');
    assert.equal(r.body, '<root/>');
  });

  it('can be used with res.status() and res.type() chaining', async () => {
    const router = createRouter();
    router.get('/data', (_req, res) => {
      res.status(201).type('text/plain').send('created');
    });
    const r = await makeRequest(router, { url: '/data' });
    assert.equal(r.statusCode, 201);
    assert.equal(r.headers['content-type'], 'text/plain');
    assert.equal(r.body, 'created');
  });

  it('overrides a previously set Content-Type', async () => {
    const router = createRouter();
    router.get('/override', (_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.type('application/octet-stream').send('bytes');
    });
    const r = await makeRequest(router, { url: '/override' });
    assert.equal(r.headers['content-type'], 'application/octet-stream');
  });
});

// ---------------------------------------------------------------------------
// Suite 25 — res.download()
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('res.download() — file download with Content-Disposition', () => {
  // Create a temporary file shared across tests in this suite.
  const tmpDir  = mkdtempSync(join(tmpdir(), 'expediate-test-'));
  const tmpFile = join(tmpDir, 'hello.txt');
  writeFileSync(tmpFile, 'hello download');

  it('sets Content-Disposition: attachment with the basename as filename', async () => {
    const router = createRouter();
    router.get('/dl', (_req, res) => res.download(tmpFile));
    const r = await makeRequest(router, { url: '/dl' });
    assert.equal(r.statusCode, 200);
    assert.ok(
      r.headers['content-disposition']?.includes('attachment'),
      `Expected attachment, got: ${r.headers['content-disposition']}`,
    );
    assert.ok(
      r.headers['content-disposition']?.includes('hello.txt'),
      `Expected filename="hello.txt", got: ${r.headers['content-disposition']}`,
    );
  });

  it('streams the file body correctly', async () => {
    const router = createRouter();
    router.get('/dl', (_req, res) => res.download(tmpFile));
    const r = await makeRequest(router, { url: '/dl' });
    assert.equal(r.body, 'hello download');
  });

  it('uses a custom filename when provided', async () => {
    const router = createRouter();
    router.get('/dl', (_req, res) => res.download(tmpFile, 'custom-name.txt'));
    const r = await makeRequest(router, { url: '/dl' });
    assert.ok(
      r.headers['content-disposition']?.includes('custom-name.txt'),
      `Expected custom-name.txt, got: ${r.headers['content-disposition']}`,
    );
  });

  it('responds 404 when the file does not exist', async () => {
    const router = createRouter();
    router.get('/missing', (_req, res) => res.download(join(tmpDir, 'no-such-file.txt')));
    const r = await makeRequest(router, { url: '/missing' });
    assert.equal(r.statusCode, 404);
    // Clean up after last test in this suite.
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
