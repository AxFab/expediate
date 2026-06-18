/**
 * apis.test.ts — Extensive test suite for apis.ts
 *
 * Tests every aspect of the apiBuilder framework:
 * - Singleton, keyed, and ephemeral scoping
 * - Synchronous and async route handlers
 * - Return-value conventions (truthy → 200+JSON, falsy → 201)
 * - Error handling (thrown ApiError, rejected Promise, plain Error)
 * - Method injection and correct `this` binding
 * - buildModule lifecycle (data(), methods, setup())
 * - All five HTTP verbs (GET, POST, PUT, DELETE, PATCH)
 * - Content-Type header on JSON responses
 *
 * Run with:  tsx apis.test.ts
 */

import assert from 'node:assert/strict';
import http   from 'node:http';
import net    from 'node:net';
import { describe, it } from 'node:test';

import createRouter         from '../src/router.ts';
import { json }             from '../src/misc.ts';
import apiBuilder, { defineController } from '../src/apis.ts';
import type { ServiceDefinition, ApiError, ServiceInstance, ApiContext } from '../src/apis.ts';

// ---------------------------------------------------------------------------
// HTTP test helper
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[] | undefined>;
  body:       string;
  json<T = unknown>(): T;
}

/**
 * Mount an apiBuilder router on a temporary HTTP server (with JSON body
 * parsing), issue a single request, and return the response.
 */
function request(
  service: ServiceDefinition<any>,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
    body?:    object;
    // Optionally inject session/cookie data onto the request
    session?: Record<string, string>;
  } = {},
): Promise<FakeResponse> {
  return requestRouter(apiBuilder(service), options);
}

/**
 * Like `request()` but accepts a pre-built Router so that multiple calls can
 * share the same service instance (needed for singleton / keyed scope tests).
 *
 * IMPORTANT: The api Router is mounted as the top-level handler (NOT via
 * router.use()) to avoid path stripping. `use()` sets stripPath:true, which
 * would cause `/items/1` to be seen as `/1` inside the api's sub-router,
 * breaking any route that registers both `/items` and `/items/:id`.
 */
function requestRouter(
  api: any,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
    body?:    object;
    session?: Record<string, string>;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    // Build a thin wrapper router that only handles json parsing + session injection,
    // then delegates to the api listener without any path stripping.
    const wrapper = createRouter();
    wrapper.use('/', json() as any);

    if (options.session) {
      const sess = options.session;
      wrapper.use('/', (req: any, _res: any, next: any) => {
        req.session = sess;
        next();
      });
    }

    // Delegate to api.listener via next() — no use() so no path stripping.
    wrapper.use('/', (req: any, res: any, next: any) => {
      (api.listener as any)(req, res, next);
    });

    const router = wrapper;

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const rawBody = options.body ? Buffer.from(JSON.stringify(options.body)) : undefined;
      const extraH: Record<string, string> = {};
      if (rawBody) {
        extraH['content-type']   = 'application/json';
        extraH['content-length'] = String(rawBody.length);
      }

      const chunks: Buffer[] = [];
      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  options.method  ?? 'GET',
          path:    options.path    ?? '/',
          headers: { ...extraH, ...(options.headers ?? {}) },
        },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const bodyStr = Buffer.concat(chunks).toString('utf8');
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers,
              body:       bodyStr,
              json<T>()   { return JSON.parse(bodyStr) as T; },
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (rawBody) req.write(rawBody);
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — Singleton scoping
// ---------------------------------------------------------------------------

describe('Singleton scoping', () => {
  it('service with no scope is a singleton — state is shared across requests', async () => {
    let callCount = 0;
    const service: ServiceDefinition = {
      // No `scope` → singleton
      data: () => ({ count: 0 }),
      GET: {
        '/count': function (this: any) { this.count++; callCount++; return { count: this.count }; },
      },
    };

    // Both requests must share the SAME apiBuilder instance so the singleton
    // module cache is reused between calls.
    const api = apiBuilder(service);
    const r1 = await requestRouter(api, { path: '/count' });
    const r2 = await requestRouter(api, { path: '/count' });
    assert.equal(r1.json<any>().count, 1);
    assert.equal(r2.json<any>().count, 2); // same instance → count accumulates
    assert.equal(callCount, 2);
  });

  it('singleton buildModule is called once at construction time', async () => {
    let buildCount = 0;
    const service: ServiceDefinition = {
      data: () => { buildCount++; return {}; },
      GET: { '/': function () { return { ok: true }; } },
    };

    // Constructing the api runs buildModule once for the singleton.
    apiBuilder(service);
    assert.equal(buildCount, 1, 'data() should be called exactly once for a singleton');
  });

  it('singleton buildModule passes "singleton" as the key to data()', async () => {
    let receivedKey: unknown = undefined;
    const service: ServiceDefinition = {
      data: (key) => { receivedKey = key; return {}; },
      GET: { '/': function () { return {}; } },
    };
    apiBuilder(service);
    assert.equal(receivedKey, 'singleton');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Keyed scoping
// ---------------------------------------------------------------------------

describe('Keyed scoping', () => {
  it('requests with the same scope key share an instance', async () => {
    const service: ServiceDefinition<any> = {
      scope: (req: any) => req.session?.ssid ?? null,
      data:  () => ({ hits: 0 }),
      GET: {
        '/hit': function (this: any) { this.hits++; return { hits: this.hits }; },
      },
    };

    // All three requests must share the same apiBuilder so the module cache persists.
    const api = apiBuilder(service);
    const r1 = await requestRouter(api, { path: '/hit', session: { ssid: 'abc' } });
    const r2 = await requestRouter(api, { path: '/hit', session: { ssid: 'abc' } });
    const r3 = await requestRouter(api, { path: '/hit', session: { ssid: 'xyz' } });

    assert.equal(r1.json<any>().hits, 1);
    assert.equal(r2.json<any>().hits, 2, 'same session key → same instance');
    assert.equal(r3.json<any>().hits, 1, 'different session key → separate instance');
  });

  it('scope() receives the request object', async () => {
    let capturedReq: any = null;
    const service: ServiceDefinition = {
      scope: (req: any) => { capturedReq = req; return 'key1'; },
      GET: { '/': function () { return {}; } },
    };
    await request(service, { path: '/' });
    assert.ok(capturedReq !== null, 'scope() should receive the request');
    assert.ok(capturedReq.method, 'request should have a method property');
  });

  it('a new instance is built on the first access for a given key', async () => {
    let buildCount = 0;
    const service: ServiceDefinition<any> = {
      scope: () => 'fixed-key',
      data:  () => { buildCount++; return {}; },
      GET: { '/': function () { return {}; } },
    };

    // Reuse the same apiBuilder so the module cache is shared across calls.
    const api = apiBuilder(service);
    await requestRouter(api, { path: '/' });
    await requestRouter(api, { path: '/' });
    // Same key → built once, reused on second request.
    assert.equal(buildCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Ephemeral scoping (scope returns null)
// ---------------------------------------------------------------------------

describe('Ephemeral scoping (scope returns null)', () => {
  it('each request gets a fresh instance when scope() returns null', async () => {
    let buildCount = 0;
    const service: ServiceDefinition<any> = {
      scope: () => null,           // ephemeral
      data:  () => { buildCount++; return { hits: 0 }; },
      GET: {
        '/hit': function (this: any) { this.hits++; return { hits: this.hits }; },
      },
    };

    const r1 = await request(service, { path: '/hit' });
    const r2 = await request(service, { path: '/hit' });

    assert.equal(r1.json<any>().hits, 1);
    assert.equal(r2.json<any>().hits, 1, 'ephemeral → always starts at 0');
    assert.equal(buildCount, 2, 'data() should be called once per request');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — buildModule lifecycle
// ---------------------------------------------------------------------------

describe('buildModule lifecycle', () => {
  it('data() initialises state — properties are accessible on this', async () => {
    const service: ServiceDefinition<any> = {
      data: () => ({ value: 42 }),
      GET: { '/val': function (this: any) { return { value: this.value }; } },
    };
    const r = await request(service, { path: '/val' });
    assert.equal(r.json<any>().value, 42);
  });

  it('setup() is called after data() — can modify state', async () => {
    const service: ServiceDefinition<any> = {
      data:  () => ({ ready: false }),
      setup: function (this: any) { this.ready = true; },
      GET: {
        '/ready': function (this: any) { return { ready: this.ready }; },
      },
    };
    const r = await request(service, { path: '/ready' });
    assert.equal(r.json<any>().ready, true);
  });

  it('methods are mixed in and callable from route handlers', async () => {
    const service: ServiceDefinition<any> = {
      data: () => ({ base: 10 }),
      methods: {
        double(this: any): number { return this.base * 2; },
      },
      GET: {
        '/double': function (this: any) { return { result: this.double() }; },
      },
    };
    const r = await request(service, { path: '/double' });
    assert.equal(r.json<any>().result, 20);
  });

  it('methods receive arguments correctly (arrow-function bug is fixed)', async () => {
    const service: ServiceDefinition<any> = {
      data: () => ({}),
      methods: {
        add(this: any, a: number, b: number): number { return a + b; },
      },
      GET: {
        '/add': function (this: any) { return { result: this.add(3, 4) }; },
      },
    };
    const r = await request(service, { path: '/add' });
    assert.equal(r.json<any>().result, 7);
  });

  it('methods can call other methods on the same instance', async () => {
    const service: ServiceDefinition<any> = {
      data: () => ({ x: 5 }),
      methods: {
        double(this: any): number { return this.triple() - this.x; }, // 15 - 5 = 10
        triple(this: any): number { return this.x * 3; },
      },
      GET: {
        '/calc': function (this: any) { return { result: this.double() }; },
      },
    };
    const r = await request(service, { path: '/calc' });
    assert.equal(r.json<any>().result, 10);
  });

  it('setup() has access to mixed-in methods', async () => {
    const service: ServiceDefinition<any> = {
      data:  () => ({ initValue: 0 }),
      methods: {
        init(this: any) { this.initValue = 99; },
      },
      setup: function (this: any) { this.init(); },
      GET: {
        '/val': function (this: any) { return { v: this.initValue }; },
      },
    };
    const r = await request(service, { path: '/val' });
    assert.equal(r.json<any>().v, 99);
  });

  it('data() without scope receives the key passed by the framework', async () => {
    let keyReceived: unknown = 'not-set';
    const service: ServiceDefinition<any> = {
      scope: () => 'my-key',
      data:  (key) => { keyReceived = key; return {}; },
      GET: { '/': function () { return {}; } },
    };
    await request(service, { path: '/' });
    assert.equal(keyReceived, 'my-key');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Return value conventions
// ---------------------------------------------------------------------------

describe('Return value conventions', () => {
  it('truthy return → 200 with JSON body', async () => {
    const service: ServiceDefinition = {
      GET: { '/': function () { return { hello: 'world' }; } },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { hello: 'world' });
  });

  it('undefined return → 201 No Content', async () => {
    const service: ServiceDefinition = {
      GET: { '/': function () { return undefined; } },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body, '');
  });

  it('null return → 201 No Content', async () => {
    const service: ServiceDefinition = {
      GET: { '/': function () { return null; } },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 201);
  });

  it('false return → 201 No Content', async () => {
    const service: ServiceDefinition = {
      GET: { '/': function () { return false; } },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 201);
  });

  it('async handler resolving a truthy value → 200 with JSON body', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () {
          return Promise.resolve({ async: true });
        },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { async: true });
  });

  it('async handler resolving undefined → 201 No Content', async () => {
    const service: ServiceDefinition = {
      GET: { '/': function () { return Promise.resolve(undefined); } },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 201);
  });

  it('response body has Content-Type: application/json', async () => {
    const service: ServiceDefinition = {
      GET: { '/': function () { return { ok: true }; } },
    };
    const r = await request(service, { path: '/' });
    assert.ok(
      (r.headers['content-type'] as string)?.includes('application/json'),
      `Expected application/json, got: ${r.headers['content-type']}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Error handling
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  it('thrown { status, message } → correct HTTP status and plain-text body', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () {
          throw { status: 404, message: 'Not found' } satisfies ApiError;
        },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body, 'Not found');
  });

  it('thrown { status, data } → correct status and JSON body', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () {
          throw { status: 422, data: { field: 'email', reason: 'invalid' } } satisfies ApiError;
        },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 422);
    assert.deepEqual(r.json(), { field: 'email', reason: 'invalid' });
  });

  it('thrown ApiError without status → 500', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () { throw { message: 'oops' }; },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 500);
    assert.equal(r.body, 'oops');
  });

  it('thrown plain Error (no status) → 500 with message', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () { throw new Error('Something broke'); },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 500);
    assert.equal(r.body, 'Something broke');
  });

  it('rejected Promise { status, message } → correct HTTP error', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () {
          return Promise.reject({ status: 503, message: 'Service unavailable' });
        },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.body, 'Service unavailable');
  });

  it('rejected Promise { status, data } → JSON error body', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () {
          return Promise.reject({ status: 404, data: { message: 'Not found', key: 'abc' } });
        },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.json(), { message: 'Not found', key: 'abc' });
  });

  it('rejected Promise without status → 500', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': function () { return Promise.reject(new Error('async boom')); },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 500);
  });

  it('method-level throwIfNotReady pattern works correctly', async () => {
    const service: ServiceDefinition<any> = {
      data:  () => ({ ready: false }),
      methods: {
        throwIfNotReady(this: any) {
          if (!this.ready) throw { status: 503, message: 'Not ready' };
        },
      },
      GET: {
        '/': function (this: any) {
          this.throwIfNotReady();
          return { ok: true };
        },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.body, 'Not ready');
  });
});

// ---------------------------------------------------------------------------
// Suite 6b — service.onError hook
// ---------------------------------------------------------------------------

describe('service.onError hook', () => {
  it('is invoked with the error, ctx, and req when a handler throws', async () => {
    let seenErr: unknown;
    let seenPath = '';
    const service: ServiceDefinition<any> = {
      onError(err, ctx, _req) { seenErr = err; seenPath = ctx.path; },
      GET: { '/boom': function () { throw new Error('kaboom'); } },
    };
    const r = await request(service, { path: '/boom' });
    // Returns nothing → default translation still runs (plain Error → 500).
    assert.equal(r.statusCode, 500);
    assert.equal(r.body, 'kaboom');
    assert.ok(seenErr instanceof Error && seenErr.message === 'kaboom');
    assert.equal(seenPath, '/boom');
  });

  it('returning an ApiError overrides the response', async () => {
    const service: ServiceDefinition<any> = {
      onError(_err, _ctx, _req) {
        return { status: 502, data: { error: 'masked', ref: 'abc123' } } satisfies ApiError;
      },
      GET: { '/boom': function () { throw new Error('internal detail'); } },
    };
    const r = await request(service, { path: '/boom' });
    assert.equal(r.statusCode, 502);
    assert.deepEqual(r.json(), { error: 'masked', ref: 'abc123' });
  });

  it('returning nothing leaves the default ApiError translation intact', async () => {
    const service: ServiceDefinition<any> = {
      onError() { /* log only */ },
      GET: { '/boom': function () { throw { status: 404, message: 'Not found' } satisfies ApiError; } },
    };
    const r = await request(service, { path: '/boom' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body, 'Not found');
  });

  it('a hook that throws escalates to the surrounding app error channel', async () => {
    let appCaught: unknown;
    const service: ServiceDefinition<any> = {
      onError(err, _ctx, _req) { throw err; }, // decline → escalate
      GET: { '/boom': function () { throw new Error('escalated failure'); } },
    };

    // Mount the api under an app that owns an error() handler.
    const app = createRouter();
    app.use('/', json() as any);
    app.error((err, _req, res, _next) => { appCaught = err; res.status(500).send('app handled'); });
    app.use('/', apiBuilder(service));

    const r = await requestRouter(app, { path: '/boom' });
    assert.equal(r.body, 'app handled');
    assert.ok(appCaught instanceof Error && appCaught.message === 'escalated failure');
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Route parameters and request body
// ---------------------------------------------------------------------------

describe('Route parameters and request body', () => {
  it('route :params are available via ctx.query.route', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/items/:id': function (ctx: ApiContext) {
          return { id: ctx.query.route.id };
        },
      },
    };
    const r = await request(service, { path: '/items/42' });
    assert.equal(r.json<any>().id, '42');
  });

  it('URL query-string parameters are available via ctx.query.url', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/search': function (ctx: ApiContext) {
          return { q: ctx.query.url.q };
        },
      },
    };
    const r = await request(service, { path: '/search?q=hello' });
    assert.equal(r.json<any>().q, 'hello');
  });

  it('ctx.path contains the request path', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/ping': function (ctx: ApiContext) {
          return { path: ctx.path };
        },
      },
    };
    const r = await request(service, { path: '/ping' });
    assert.equal(r.json<any>().path, '/ping');
  });

  it('POST body is passed as the second argument', async () => {
    const service: ServiceDefinition = {
      POST: {
        '/echo': function (_ctx: ApiContext, body: any) {
          return { received: body };
        },
      },
    };
    const r = await request(service, {
      method: 'POST',
      path:   '/echo',
      body:   { name: 'alice', age: 30 },
    });
    assert.deepEqual(r.json<any>().received, { name: 'alice', age: 30 });
  });

  it('route params and body are both accessible in the same handler', async () => {
    const service: ServiceDefinition = {
      PUT: {
        '/items/:id': function (ctx: ApiContext, body: any) {
          return { id: ctx.query.route.id, ...body };
        },
      },
    };
    const r = await request(service, {
      method: 'PUT',
      path:   '/items/7',
      body:   { name: 'widget' },
    });
    const json = r.json<any>();
    assert.equal(json.id, '7');
    assert.equal(json.name, 'widget');
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — All five HTTP verbs
// ---------------------------------------------------------------------------

describe('All five HTTP verbs', () => {
  const makeService = (verb: string): ServiceDefinition => ({
    [verb]: { '/test': function () { return { verb }; } },
  } as any);

  for (const [method, verb] of [
    ['GET',    'GET'],
    ['POST',   'POST'],
    ['PUT',    'PUT'],
    ['DELETE', 'DELETE'],
    ['PATCH',  'PATCH'],
  ]) {
    it(`${method} routes are registered and callable`, async () => {
      const service = makeService(verb);
      const r = await request(service, { method, path: '/test' });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json<any>().verb, verb);
    });
  }

  it('undefined route map sections are silently skipped', async () => {
    // A service with only GET routes should not crash when POST arrives.
    const service: ServiceDefinition = {
      GET: { '/': function () { return { ok: true }; } },
      // POST, PUT, DELETE, PATCH all absent
    };
    // Path '/' exists for GET — a POST to it gets 405 Method Not Allowed (FIX-04).
    // The router correctly identifies the path matches but the method is not allowed.
    const r = await request(service, { method: 'POST', path: '/' });
    assert.equal(r.statusCode, 405);
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — Multiple routes on the same service
// ---------------------------------------------------------------------------

describe('Multiple routes on the same service', () => {
  const multiService: ServiceDefinition<any> = {
    data: () => ({ items: { '1': { name: 'alpha' }, '2': { name: 'beta' } } }),
    GET: {
      '/items': function (this: any) { return Object.values(this.items); },
      '/items/:id': function (this: any, ctx: ApiContext) {
        if (!this.items[ctx.query.route.id]) throw { status: 404, message: 'Not found' };
        return this.items[ctx.query.route.id];
      },
    },
    POST: {
      '/items': function (this: any, _ctx: ApiContext, body: any) {
        const id = String(Object.keys(this.items).length + 1);
        this.items[id] = body;
        return undefined; // 201
      },
    },
    DELETE: {
      '/items/:id': function (this: any, ctx: ApiContext) {
        if (!this.items[ctx.query.route.id]) throw { status: 404, message: 'Not found' };
        delete this.items[ctx.query.route.id];
        return undefined; // 201
      },
    },
  };

  const multiApi = apiBuilder(multiService);

  it('GET /items returns all items', async () => {
    const r = await requestRouter(multiApi, { path: '/items' });
    assert.equal(r.statusCode, 200);
    const items = r.json<any[]>();
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 2);
  });

  it('GET /items/:id returns a specific item', async () => {
    const r = await requestRouter(multiApi, { path: '/items/1' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().name, 'alpha');
  });

  it('GET /items/:id returns 404 for unknown id', async () => {
    const r = await requestRouter(multiApi, { path: '/items/99' });
    assert.equal(r.statusCode, 404);
  });

  it('POST /items creates an item and returns 201', async () => {
    const r = await requestRouter(multiApi, {
      method: 'POST',
      path:   '/items',
      body:   { name: 'gamma' },
    });
    assert.equal(r.statusCode, 201);
  });

  it('DELETE /items/:id deletes an item and returns 201', async () => {
    const r = await requestRouter(multiApi, { method: 'DELETE', path: '/items/2' });
    assert.equal(r.statusCode, 201);
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — Async setup() and service readiness
// ---------------------------------------------------------------------------

describe('Async setup() and service readiness', () => {
  it('synchronous setup makes the service immediately ready', async () => {
    const service: ServiceDefinition<any> = {
      data:  () => ({ ready: false }),
      setup: function (this: any) { this.ready = true; },
      GET: {
        '/': function (this: any) { return { ready: this.ready }; },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().ready, true);
  });

  it('async setup() returning a Promise is awaited — state is correct when routes run', async () => {
    // setup() uses await Promise.resolve() (a microtask), which resolves before
    // any I/O callback fires — so this.ready is true by the time the server
    // is listening and the HTTP request arrives.
    const service: ServiceDefinition<any> = {
      data:  () => ({ ready: false }),
      setup: async function (this: any) {
        await Promise.resolve(); // microtask-level async
        this.ready = true;
      },
      GET: {
        '/': function (this: any) { return { ready: this.ready }; },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().ready, true, 'async setup should be awaited before routes run');
  });

  it('singleton with pending async setup returns 503 from the guard', async () => {
    // setup() returns a Promise that never resolves — the guard permanently
    // blocks all requests with 503.
    const service: ServiceDefinition<any> = {
      data:  () => ({}),
      setup: async function () {
        await new Promise<void>(() => {}); // never resolves
      },
      GET: {
        '/': function () { return { ok: true }; },
      },
    };
    // Build the api and fire immediately — setup is still pending.
    const api = apiBuilder(service);
    const r = await requestRouter(api, { path: '/' });
    assert.equal(r.statusCode, 503, 'guard should return 503 while setup is pending');
  });

  it('singleton guard clears once async setup resolves', async () => {
    // Use a manually controlled promise so we can fire a request both before
    // and after setup resolves.
    let resolveSetup!: () => void;
    const service: ServiceDefinition<any> = {
      data:  () => ({ value: 42 }),
      setup: async function () {
        await new Promise<void>(resolve => { resolveSetup = resolve; });
      },
      GET: {
        '/': function (this: any) { return { value: this.value }; },
      },
    };

    const api = apiBuilder(service);

    // Before setup resolves: guard fires 503.
    const r1 = await requestRouter(api, { path: '/' });
    assert.equal(r1.statusCode, 503, 'should be 503 before setup resolves');

    // Release setup and wait for the microtask + promise chain to complete.
    resolveSetup();
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    // After setup resolves: routes work normally.
    const r2 = await requestRouter(api, { path: '/' });
    assert.equal(r2.statusCode, 200, 'should be 200 after setup resolves');
    assert.equal(r2.json<any>().value, 42);
  });

  it('keyed instance async setup is awaited before the handler runs', async () => {
    const service: ServiceDefinition<any> = {
      scope: () => 'k1',
      data:  () => ({ ready: false }),
      setup: async function (this: any) {
        await Promise.resolve();
        this.ready = true;
      },
      GET: {
        '/': function (this: any) { return { ready: this.ready }; },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().ready, true, 'keyed instance setup should be awaited');
  });

  it('ephemeral instance async setup is awaited before the handler runs', async () => {
    const service: ServiceDefinition<any> = {
      scope: () => null, // ephemeral
      data:  () => ({ ready: false }),
      setup: async function (this: any) {
        await Promise.resolve();
        this.ready = true;
      },
      GET: {
        '/': function (this: any) { return { ready: this.ready }; },
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().ready, true, 'ephemeral instance setup should be awaited');
  });
});

// ---------------------------------------------------------------------------
// Suite 11 — ctx.params alias (v2)
// ---------------------------------------------------------------------------

describe('ctx.params alias', () => {
  it('ctx.params is a shorthand for ctx.query.route', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/items/:id': function (ctx: ApiContext) {
          return { short: ctx.params.id, long: ctx.query.route.id, same: ctx.params === ctx.query.route };
        },
      },
    };
    const r = await request(service, { path: '/items/42' });
    assert.equal(r.json<any>().short, '42');
    assert.equal(r.json<any>().long, '42');
    assert.equal(r.json<any>().same, true, 'params should alias the same object');
  });
});

// ---------------------------------------------------------------------------
// Suite 12 — Controllers and composition (v2)
// ---------------------------------------------------------------------------

describe('Controllers and composition', () => {
  it('controller prefix is prepended to every route', async () => {
    const service: ServiceDefinition = {
      controllers: [defineController({
        prefix: '/p/:proj/wiki',
        GET: {
          '/pages/:slug': (ctx) => ({ proj: ctx.params.proj, slug: ctx.params.slug }),
        },
      })],
    };
    const r = await request(service, { path: '/p/demo/wiki/pages/home' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { proj: 'demo', slug: 'home' });
  });

  it("a '/' route joined with a prefix maps to the prefix itself", async () => {
    const service: ServiceDefinition = {
      controllers: [defineController({
        prefix: '/p/:proj/wiki',
        GET: { '/': (ctx) => ({ proj: ctx.params.proj }) },
      })],
    };
    const r = await request(service, { path: '/p/demo/wiki' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().proj, 'demo');
  });

  it('root route maps and controllers coexist in one router', async () => {
    const service: ServiceDefinition = {
      GET: { '/health': () => ({ root: true }) },
      controllers: [defineController({
        prefix: '/api',
        GET: { '/items': () => ({ controller: true }) },
      })],
    };
    const api = apiBuilder(service);
    const r1 = await requestRouter(api, { path: '/health' });
    const r2 = await requestRouter(api, { path: '/api/items' });
    assert.equal(r1.json<any>().root, true);
    assert.equal(r2.json<any>().controller, true);
  });

  it('specificity sorting is global across controllers', async () => {
    // Root declares the parameterised route; the controller declares a more
    // specific literal route under the same prefix. The literal route must
    // win even though it lives in a different controller.
    const service: ServiceDefinition = {
      GET: { '/items/:id': (ctx) => ({ matched: 'param', id: ctx.params.id }) },
      controllers: [defineController({
        prefix: '/items',
        GET: { '/special': () => ({ matched: 'literal' }) },
      })],
    };
    const api = apiBuilder(service);
    const lit = await requestRouter(api, { path: '/items/special' });
    const par = await requestRouter(api, { path: '/items/7' });
    assert.equal(lit.json<any>().matched, 'literal');
    assert.equal(par.json<any>().matched, 'param');
  });

  it('handlers in every controller share the same service instance', async () => {
    const service: ServiceDefinition<any> = {
      data: () => ({ count: 0 }),
      controllers: [
        defineController<any>({
          prefix: '/a',
          GET: { '/inc': function (this: any) { this.count++; return { count: this.count }; } },
        }),
        defineController<any>({
          prefix: '/b',
          GET: { '/read': function (this: any) { return { count: this.count }; } },
        }),
      ],
    };
    const api = apiBuilder(service);
    await requestRouter(api, { path: '/a/inc' });
    const r = await requestRouter(api, { path: '/b/read' });
    assert.equal(r.json<any>().count, 1, 'controllers must share one instance');
  });

  it('duplicate (verb, path) across controllers throws at build time', () => {
    const service: ServiceDefinition = {
      controllers: [
        defineController({ prefix: '/p/:proj', tags: ['Settings'], GET: { '/settings': () => ({}) } }),
        defineController({ prefix: '/p/:proj', tags: ['Projects'], GET: { '/settings': () => ({}) } }),
      ],
    };
    assert.throws(() => apiBuilder(service), (err: Error) => {
      assert.ok(err.message.includes('duplicate route GET /p/:proj/settings'), err.message);
      assert.ok(err.message.includes("'Settings'"), 'should name the first declarer');
      assert.ok(err.message.includes("'Projects'"), 'should name the second declarer');
      return true;
    });
  });

  it('duplicate path between root routes and a controller throws too', () => {
    const service: ServiceDefinition = {
      GET: { '/items': () => ({}) },
      controllers: [defineController({ prefix: '', GET: { '/items': () => ({}) } })],
    };
    assert.throws(() => apiBuilder(service), /duplicate route GET \/items/);
  });

  it('the same path on different verbs is NOT a duplicate', async () => {
    const service: ServiceDefinition = {
      controllers: [defineController({
        prefix: '/items',
        GET:  { '/': () => ({ verb: 'GET' }) },
        POST: { '/': () => ({ verb: 'POST' }) },
      })],
    };
    const api = apiBuilder(service);
    const g = await requestRouter(api, { path: '/items' });
    const p = await requestRouter(api, { method: 'POST', path: '/items', body: {} });
    assert.equal(g.json<any>().verb, 'GET');
    assert.equal(p.json<any>().verb, 'POST');
  });
});
