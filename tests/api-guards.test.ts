/**
 * api-guards.test.ts — Tests for the API Builder v2 pipeline features.
 *
 * Covers (see docs/api-builder-v2-design.md):
 * - Guards: ordering (api → controller → route), ctx.state merging,
 *   ApiError translation, async guards, req access
 * - Auth binding: default check (401 / 403 / pass), controller-level and
 *   route-level permission, custom check override, authenticate
 *   auto-registration, end-to-end with createJwtPlugin
 * - Request validation: each supported JSON Schema keyword (unit level via
 *   validateSchema), 400 { message, fieldErrors } shape, required body,
 *   $ref resolution, opt-out
 *
 * Run with:  node --import tsx --test tests/api-guards.test.ts
 */

import assert from 'node:assert/strict';
import http   from 'node:http';
import net    from 'node:net';
import { describe as testDescribe, it } from 'node:test';

import createRouter             from '../src/router.ts';
import { json }                 from '../src/misc.ts';
import apiBuilder, { defineController, validateSchema } from '../src/apis.ts';
import { describe }             from '../src/openapi.ts';
import createJwtPlugin, { signToken } from '../src/jwt-auth.ts';
import type { ServiceDefinition, Guard, ApiContext } from '../src/apis.ts';
import type { JsonSchema }      from '../src/openapi.ts';

// ---------------------------------------------------------------------------
// HTTP test helper (same pattern as apis.test.ts)
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[] | undefined>;
  body:       string;
  json<T = unknown>(): T;
}

/**
 * Mount a pre-built api Router behind a json() wrapper (no path stripping),
 * issue a single request, and return the response.
 */
function requestRouter(
  api: any,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
    body?:    object;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const wrapper = createRouter();
    wrapper.use('/', json() as any);
    wrapper.use('/', (req: any, res: any, next: any) => {
      (api.listener as any)(req, res, next);
    });

    const server = http.createServer((req, res) => {
      (wrapper.listener as any)(req, res, () => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr    = server.address() as net.AddressInfo;
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
          method:  options.method ?? 'GET',
          path:    options.path   ?? '/',
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

/** Build the api and issue a single request against it. */
function request(
  service: ServiceDefinition<any>,
  options: Parameters<typeof requestRouter>[1] = {},
): Promise<FakeResponse> {
  return requestRouter(apiBuilder(service), options);
}

// ---------------------------------------------------------------------------
// Suite 1 — Guards: ordering and ctx.state
// ---------------------------------------------------------------------------

testDescribe('Guards — ordering and ctx.state', () => {
  it('guards run api → controller → route, then the handler', async () => {
    const order: string[] = [];
    const mk = (name: string): Guard => () => { order.push(name); };

    const service: ServiceDefinition = {
      guards: [mk('api')],
      controllers: [defineController({
        prefix: '/c',
        guards: [mk('controller')],
        GET: {
          '/route': describe(() => { order.push('handler'); return { ok: true }; },
            { guards: [mk('route')] }),
        },
      })],
    };

    const r = await request(service, { path: '/c/route' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(order, ['api', 'controller', 'route', 'handler']);
  });

  it('objects returned by guards are shallow-merged into ctx.state', async () => {
    const service: ServiceDefinition = {
      guards: [() => ({ a: 1 })],
      controllers: [defineController({
        prefix: '/c',
        guards: [(ctx) => ({ b: (ctx.state.a as number) + 1 })],   // sees previous state
        GET: {
          '/state': (ctx) => ({ state: ctx.state }),
        },
      })],
    };

    const r = await request(service, { path: '/c/state' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json<any>().state, { a: 1, b: 2 });
  });

  it('ctx.state starts empty and void-returning guards leave it untouched', async () => {
    const service: ServiceDefinition = {
      guards: [() => { /* pure check */ }],
      GET: { '/': (ctx: ApiContext) => ({ state: ctx.state }) },
    };
    const r = await request(service, { path: '/' });
    assert.deepEqual(r.json<any>().state, {});
  });

  it('a guard throwing an ApiError produces the HTTP error and skips the handler', async () => {
    let handlerRan = false;
    const service: ServiceDefinition = {
      guards: [() => { throw { status: 404, message: 'Feature is not enabled' }; }],
      GET: { '/': () => { handlerRan = true; return { ok: true }; } },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body, 'Feature is not enabled');
    assert.equal(handlerRan, false);
  });

  it('an async (rejecting) guard is awaited and translated', async () => {
    const service: ServiceDefinition = {
      GET: {
        '/': describe(() => ({ ok: true }), {
          guards: [async () => {
            await Promise.resolve();
            throw { status: 403, message: 'Forbidden' };
          }],
        }),
      },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body, 'Forbidden');
  });

  it('an async guard can load a resource into ctx.state', async () => {
    const service: ServiceDefinition = {
      controllers: [defineController({
        prefix: '/p/:proj',
        guards: [async (ctx) => ({ proj: { name: ctx.params.proj, wikiEnabled: true } })],
        GET: { '/wiki': (ctx) => ctx.state.proj },
      })],
    };
    const r = await request(service, { path: '/p/demo/wiki' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { name: 'demo', wikiEnabled: true });
  });

  it('guards receive the raw RouterRequest as the second argument', async () => {
    const service: ServiceDefinition = {
      guards: [(_ctx, req) => ({ method: req.method })],
      GET: { '/': (ctx: ApiContext) => ({ method: ctx.state.method }) },
    };
    const r = await request(service, { path: '/' });
    assert.equal(r.json<any>().method, 'GET');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Auth binding: default check
// ---------------------------------------------------------------------------

/** Middleware that injects a fake authenticated user onto the request. */
const fakeAuth = (user: unknown) => (req: any, _res: any, next: any) => {
  req.user = user;
  next();
};

testDescribe('Auth binding — default check', () => {
  it('route with permission and no user → 401', async () => {
    const service: ServiceDefinition = {
      GET: { '/secret': describe(() => ({ ok: true }), { permission: 'read' }) },
    };
    const r = await request(service, { path: '/secret' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.body, 'Authentication required');
  });

  it('route with permission and user lacking it → 403', async () => {
    const service: ServiceDefinition = {
      auth: { authenticate: fakeAuth({ sub: 'bob', permissions: ['read'] }) },
      GET: { '/admin': describe(() => ({ ok: true }), { permission: 'manage_users' }) },
    };
    const r = await request(service, { path: '/admin' });
    assert.equal(r.statusCode, 403);
    assert.ok(r.body.includes('manage_users'));
  });

  it('route with permission and user holding it → 200', async () => {
    const service: ServiceDefinition = {
      auth: { authenticate: fakeAuth({ sub: 'alice', permissions: ['read', 'write'] }) },
      GET: { '/data': describe((ctx: ApiContext<any>) => ({ sub: ctx.user.sub }), { permission: 'read' }) },
    };
    const r = await request(service, { path: '/data' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().sub, 'alice');
  });

  it('multiple permissions require ALL of them', async () => {
    const service: ServiceDefinition = {
      auth: { authenticate: fakeAuth({ permissions: ['read'] }) },
      GET: { '/rw': describe(() => ({ ok: true }), { permission: ['read', 'write'] }) },
    };
    const r = await request(service, { path: '/rw' });
    assert.equal(r.statusCode, 403);
  });

  it('routes without a permission stay public', async () => {
    const service: ServiceDefinition = {
      GET: { '/public': () => ({ ok: true }) },
    };
    const r = await request(service, { path: '/public' });
    assert.equal(r.statusCode, 200);
  });

  it('controller-level permission applies to every route of the controller', async () => {
    const service: ServiceDefinition = {
      controllers: [defineController({
        prefix: '/wiki',
        permission: 'wiki.read',
        GET: { '/tree': () => ({ ok: true }) },
      })],
    };
    const r = await request(service, { path: '/wiki/tree' });
    assert.equal(r.statusCode, 401, 'controller permission should gate unannotated routes');
  });

  it('route-level permission overrides the controller-level one', async () => {
    const service: ServiceDefinition = {
      auth: { authenticate: fakeAuth({ permissions: ['wiki.read'] }) },
      controllers: [defineController({
        prefix: '/wiki',
        permission: 'wiki.read',
        GET: { '/tree': () => ({ ok: true }) },
        PUT: {
          '/pages/:slug': describe(() => ({ ok: true }), { permission: 'wiki.write' }),
        },
      })],
    };
    const ok  = await request(service, { path: '/wiki/tree' });
    assert.equal(ok.statusCode, 200);
    // Same user lacks wiki.write → the override applies, not the controller default.
    const api = apiBuilder(service);
    const ko  = await requestRouter(api, { method: 'PUT', path: '/wiki/pages/home', body: {} });
    assert.equal(ko.statusCode, 403);
  });

  it('permission check runs BEFORE the guards', async () => {
    let guardRan = false;
    const service: ServiceDefinition = {
      guards: [() => { guardRan = true; }],
      GET: { '/secret': describe(() => ({ ok: true }), { permission: 'read' }) },
    };
    const r = await request(service, { path: '/secret' });
    assert.equal(r.statusCode, 401);
    assert.equal(guardRan, false, 'guards must not run when auth.check rejects');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Auth binding: custom check and authenticate registration
// ---------------------------------------------------------------------------

testDescribe('Auth binding — custom check and authenticate', () => {
  it('custom check() receives ctx and the required permissions', async () => {
    let received: string[] | null = null;
    const service: ServiceDefinition = {
      auth: {
        check: (_ctx, required) => { received = required; },
      },
      GET: { '/x': describe(() => ({ ok: true }), { permission: ['a', 'b'] }) },
    };
    const r = await request(service, { path: '/x' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(received, ['a', 'b']);
  });

  it('custom check() can load a resource and share it through ctx.state', async () => {
    const service: ServiceDefinition = {
      auth: {
        check: async (ctx) => {
          (ctx.state as any).proj = { name: ctx.params.proj, loaded: true };
        },
      },
      controllers: [defineController({
        prefix: '/p/:proj',
        permission: 'project.read',
        GET: { '/info': (ctx) => ctx.state.proj },
      })],
    };
    const r = await request(service, { path: '/p/demo/info' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { name: 'demo', loaded: true });
  });

  it('custom check() rejection is translated to an HTTP error', async () => {
    const service: ServiceDefinition = {
      auth: {
        check: async () => { throw { status: 403, message: 'Project access denied' }; },
      },
      GET: { '/x': describe(() => ({ ok: true }), { permission: 'read' }) },
    };
    const r = await request(service, { path: '/x' });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body, 'Project access denied');
  });

  it('auth.authenticate is auto-registered on the api router', async () => {
    const service: ServiceDefinition = {
      auth: { authenticate: fakeAuth({ sub: 'carol' }) },
      GET: { '/me': (ctx: ApiContext<any>) => ({ sub: ctx.user?.sub }) },
    };
    const r = await request(service, { path: '/me' });
    assert.equal(r.json<any>().sub, 'carol');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Auth binding: end-to-end with createJwtPlugin
// ---------------------------------------------------------------------------

testDescribe('Auth binding — createJwtPlugin end-to-end', () => {
  const SECRET = 'test-secret-for-api-builder';
  const jwt    = createJwtPlugin({ accessTokenSecret: SECRET });

  const service: ServiceDefinition = {
    auth: { authenticate: jwt.authenticate },
    GET: {
      '/public':  () => ({ ok: true }),
      '/private': describe((ctx: ApiContext<any>) => ({ sub: ctx.user.sub }),
        { permission: 'write' }),
    },
  };
  const api = apiBuilder(service);

  /** Sign a token the way the plugin does (HS256, 60 s expiry). */
  const token = (payload: object) => signToken(payload as any, SECRET, 60);

  it('valid bearer token with the permission → 200', async () => {
    const r = await requestRouter(api, {
      path:    '/private',
      headers: { authorization: `Bearer ${token({ sub: 'alice', permissions: ['read', 'write'] })}` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().sub, 'alice');
  });

  it('valid bearer token without the permission → 403', async () => {
    const r = await requestRouter(api, {
      path:    '/private',
      headers: { authorization: `Bearer ${token({ sub: 'charlie', permissions: ['read'] })}` },
    });
    assert.equal(r.statusCode, 403);
  });

  it('no token → 401 on the protected route, 200 on the public one', async () => {
    const priv = await requestRouter(api, { path: '/private' });
    assert.equal(priv.statusCode, 401);
    const pub  = await requestRouter(api, { path: '/public' });
    assert.equal(pub.statusCode, 200);
  });

  it('invalid token → jwt.authenticate clears req.user → 401', async () => {
    const r = await requestRouter(api, {
      path:    '/private',
      headers: { authorization: 'Bearer not.a.token' },
    });
    assert.equal(r.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — validateSchema (unit level, keyword by keyword)
// ---------------------------------------------------------------------------

testDescribe('validateSchema — keywords', () => {
  const valid = (v: unknown, s: JsonSchema, c?: Record<string, JsonSchema>) =>
    Object.keys(validateSchema(v, s, c)).length === 0;

  it('type', () => {
    assert.ok(valid('x', { type: 'string' }));
    assert.ok(valid(1.5, { type: 'number' }));
    assert.ok(valid(2,   { type: 'integer' }));
    assert.ok(valid(true, { type: 'boolean' }));
    assert.ok(valid(null, { type: 'null' }));
    assert.ok(valid([],   { type: 'array' }));
    assert.ok(valid({},   { type: 'object' }));
    assert.ok(!valid(1.5, { type: 'integer' }));
    assert.ok(!valid('x', { type: 'object' }));
    assert.ok(!valid(null, { type: 'object' }), 'null is not an object');
    assert.ok(!valid([],   { type: 'object' }), 'an array is not an object');
    const errs = validateSchema('x', { type: 'object' });
    assert.equal(errs['$'], 'must be of type object');
  });

  it('required', () => {
    const s: JsonSchema = { type: 'object', required: ['name'] };
    assert.ok(valid({ name: 'a' }, s));
    const errs = validateSchema({}, s);
    assert.equal(errs['name'], 'is required');
  });

  it('properties (recursion + dotted paths)', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: { address: { type: 'object', properties: { city: { type: 'string' } } } },
    };
    assert.ok(valid({ address: { city: 'Paris' } }, s));
    const errs = validateSchema({ address: { city: 42 } }, s);
    assert.equal(errs['address.city'], 'must be of type string');
  });

  it('items (indexed paths)', () => {
    const s: JsonSchema = { type: 'array', items: { type: 'integer' } };
    assert.ok(valid([1, 2, 3], s));
    const errs = validateSchema([1, 'two'], s);
    assert.equal(errs['1'], 'must be of type integer');
  });

  it('enum', () => {
    const s: JsonSchema = { enum: ['open', 'closed'] };
    assert.ok(valid('open', s));
    assert.ok(!valid('pending', s));
  });

  it('pattern', () => {
    const s: JsonSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9.\\-]*$' };
    assert.ok(valid('my-project.1', s));
    const errs = validateSchema('Bad Name', s);
    assert.equal(errs['$'], 'does not match pattern ^[a-z0-9][a-z0-9.\\-]*$');
  });

  it('minLength / maxLength', () => {
    assert.ok(valid('abc', { type: 'string', minLength: 2, maxLength: 4 }));
    assert.ok(!valid('a',     { type: 'string', minLength: 2 }));
    assert.ok(!valid('abcde', { type: 'string', maxLength: 4 }));
  });

  it('minimum / maximum', () => {
    assert.ok(valid(5, { type: 'number', minimum: 1, maximum: 10 }));
    assert.ok(!valid(0,  { type: 'number', minimum: 1 }));
    assert.ok(!valid(11, { type: 'number', maximum: 10 }));
  });

  it('additionalProperties: false', () => {
    const s: JsonSchema = { type: 'object', properties: { a: {} }, additionalProperties: false };
    assert.ok(valid({ a: 1 }, s));
    const errs = validateSchema({ a: 1, b: 2 }, s);
    assert.equal(errs['b'], 'unknown property');
  });

  it('additionalProperties: schema', () => {
    const s: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } };
    assert.ok(valid({ x: 'a' }, s));
    assert.ok(!valid({ x: 1 }, s));
  });

  it('allOf', () => {
    const s: JsonSchema = { allOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] };
    assert.ok(valid({ a: 1, b: 2 }, s));
    assert.ok(!valid({ a: 1 }, s));
  });

  it('anyOf', () => {
    const s: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    assert.ok(valid('x', s));
    assert.ok(valid(1, s));
    assert.ok(!valid(true, s));
  });

  it('oneOf', () => {
    const s: JsonSchema = { oneOf: [{ type: 'integer' }, { type: 'number' }] };
    assert.ok(valid(1.5, s), 'matches number only');
    assert.ok(!valid(2, s), 'matches both → fails oneOf');
  });

  it('$ref resolution against components', () => {
    const components: Record<string, JsonSchema> = {
      Item: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    };
    const s: JsonSchema = { $ref: '#/components/schemas/Item' };
    assert.ok(valid({ name: 'x' }, s, components));
    const errs = validateSchema({}, s, components);
    assert.equal(errs['name'], 'is required');
  });

  it('unknown $ref accepts anything (permissive)', () => {
    assert.ok(valid({ whatever: true }, { $ref: '#/components/schemas/Missing' }));
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Request validation over HTTP
// ---------------------------------------------------------------------------

testDescribe('Request validation — HTTP pipeline', () => {
  const itemSchema: JsonSchema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', pattern: '^[a-z0-9][a-z0-9.\\-]*$' },
      size: { type: 'integer', minimum: 1 },
    },
  };

  const makeService = (validate: ServiceDefinition['validate']): ServiceDefinition => ({
    validate,
    schemas: { Item: itemSchema },
    POST: {
      '/items': describe((_ctx, body) => ({ created: body }), {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
        },
      }),
    },
  });

  it('valid body passes through to the handler', async () => {
    const r = await request(makeService(true), {
      method: 'POST', path: '/items', body: { name: 'widget', size: 2 },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json<any>().created, { name: 'widget', size: 2 });
  });

  it('invalid body → 400 with { message, fieldErrors }', async () => {
    const r = await request(makeService(true), {
      method: 'POST', path: '/items', body: { name: 'Bad Name', size: 0 },
    });
    assert.equal(r.statusCode, 400);
    const err = r.json<any>();
    assert.equal(err.message, 'Request body validation failed');
    assert.ok(err.fieldErrors.name.includes('does not match pattern'));
    assert.equal(err.fieldErrors.size, 'must be >= 1');
  });

  it('missing required field → fieldErrors entry', async () => {
    const r = await request(makeService(true), {
      method: 'POST', path: '/items', body: { size: 3 },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json<any>().fieldErrors.name, 'is required');
  });

  it('missing body with requestBody.required → 400', async () => {
    const r = await request(makeService(true), { method: 'POST', path: '/items' });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json<any>().fieldErrors['$'], 'request body is required');
  });

  it('validation is opt-in — disabled by default', async () => {
    const r = await request(makeService(undefined), {
      method: 'POST', path: '/items', body: { name: 'Bad Name' },
    });
    assert.equal(r.statusCode, 200, 'no validate option → schema not enforced');
  });

  it('validate: { requests: false } disables request validation', async () => {
    const r = await request(makeService({ requests: false }), {
      method: 'POST', path: '/items', body: { name: 'Bad Name' },
    });
    assert.equal(r.statusCode, 200);
  });

  it('routes without a declared requestBody are not validated', async () => {
    const service: ServiceDefinition = {
      validate: true,
      POST: { '/free': (_ctx, body) => ({ echo: body }) },
    };
    const r = await request(service, { method: 'POST', path: '/free', body: { anything: 1 } });
    assert.equal(r.statusCode, 200);
  });
});
