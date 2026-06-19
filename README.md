<p align="center">
  <img src="docs/expediate.png" alt="expediate" width="260" />
</p>

<p align="center">
  A lightweight, zero-dependency TypeScript HTTP routing framework for Node.js.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/expediate"><img src="https://img.shields.io/npm/v/expediate.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node ≥ 18" />
  <a href="https://npmcharts.com/compare/expediate?minimal=true"><img src="https://img.shields.io/npm/dm/expediate.svg" alt="npm downloads" /></a>
</p>

---

**Expediate** provides an Express-compatible API surface with full TypeScript types, built-in body parsing, static file serving, JWT authentication, multipart form handling, a Git Smart HTTP gateway, and a suite of production-ready middleware — all with **zero runtime dependencies** beyond Node.js itself.

---

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Why Expediate?](#why-expediate)
- [Router](#router)
- [Body parsing](#body-parsing)
- [Static files](#static-files)
- [Middleware suite](#middleware-suite)
- [JWT authentication](#jwt-authentication)
- [API service builder](#api-service-builder)
- [OpenAPI spec generation](#openapi-spec-generation)
- [Git Smart HTTP gateway](#git-smart-http-gateway)
- [TypeScript types](#typescript-types)

---

## Installation

```bash
npm install expediate
```

Node.js ≥ 18.20.0 is required — the floor where `with { type: 'json' }` JSON import attributes exist (the ESM build uses one for `mimetypes.json`); on 18.20.0–18.20.4, 20.10.0–20.18.2, and all of 21.x, Node logs an `ExperimentalWarning` for that syntax but runs fine. For a warning-free run, use Node ≥ 18.20.5, ≥ 20.18.3, or ≥ 22.12.0. The package ships as native ESM with full TypeScript declarations and a CommonJS compatibility bundle (the CJS build is bundled with esbuild specifically so this JSON import works under `require()` too).

**Bun / Deno:** not officially tested, but likely to work with caveats. Both runtimes support `with { type: 'json' }` and the package's `exports` map resolves cleanly under either. The main risk area is `src/router.ts`'s use of `node:http2.createSecureServer` and raw socket fields (`req.socket.setTimeout`, `req.socket.remoteAddress`, `req.socket.encrypted`) for HTTP/2 + TLS: Bun's `node:http2` server support has known gaps (no `allowHTTP1`, no `enableConnectProtocol`, no ALPN-based push), and Deno's `node:http2` compatibility, while improving, is newer and less battle-tested than its `node:http`. Plain HTTP/HTTPS routes are the safer bet on either runtime.

---

## Quick start

```ts
import { createRouter, json, logger } from 'expediate';

const app = createRouter();

app.use(logger());
app.use(json());

app.get('/hello/:name', (req, res) => {
  res.send(`Hello, ${req.params.name}!`);
});

app.post('/echo', (req, res) => {
  res.json((req as any).body);
});

app.listen(3000, () => console.log('Listening on :3000'));
```

---

## Why Expediate?

- **Zero runtime dependencies.** The entire framework — router, body parsers, static files, compression, JWT, Git gateway, OpenAPI — uses only Node.js built-ins.
- **TypeScript-first.** Strict compiler settings, full type declarations for every public API.
- **Express-compatible API.** Familiar route registration, `req`/`res` helpers, middleware signature, signed cookies, and error handling — easy migration path.
- **Real HTTP testing.** The test suite spins up live servers on ephemeral ports rather than mocking. Behaviour you see in tests is behaviour you get in production.
- **ESM + CJS dual output.** Works with both `import` and `require`.

---

## Router

→ Full reference: [docs/router.md](docs/router.md)

```ts
import { createRouter } from 'expediate';

const app = createRouter({
  secret:     process.env.COOKIE_SECRET,
  timeout:    30_000,    // 408 if no response starts within 30 s
  trustProxy: true,      // trust X-Forwarded-* headers
});
```

### Route registration

```ts
app.get('/users',        listUsers);         // endpoint match (GET only)
app.post('/users',       createUser);
app.put('/users/:id',    updateUser);
app.delete('/users/:id', deleteUser);
app.all('/health',       handler);           // any method, endpoint match
app.use('/api',          apiRouter);         // prefix mount — strips /api from req.path
```

`use()` strips the matched prefix from `req.path` and sets `req.baseUrl` for nested routers. Method routes (`get`, `post`, etc.) use **endpoint matching** — `get('/users')` matches `/users` but not `/users/42`.

To register several methods against one path without repeating it, use the chainable `route()` builder:

```ts
app.route('/users/:id')
  .get(getUser)
  .put(replaceUser)
  .delete(removeUser);
```

Each call forwards to the matching method (`get`, `post`, …) with the cached path and returns the builder, so behaviour is identical to calling those methods directly.

**Method handling.** `HEAD` requests are served by the matching `GET` handler (Node strips the response body). An unhandled `OPTIONS` request on a registered path automatically returns `204 No Content` with an `Allow` header, and a method mismatch on a registered path returns `405 Method Not Allowed` with `Allow` (both list `HEAD` when a `GET` exists, plus `OPTIONS`). Register `app.head(path, …)` or `app.options(path, …)` (also on the `route()` builder) for method-specific handlers; explicit handlers and `cors()` run first, so they override these defaults.

### Path patterns

```ts
app.get('/users/:id',           handler);   // named param
app.get('/items/:id(\\d+)',     handler);   // inline regex constraint (digits only)
app.get('/api/**',              handler);   // glob — any depth
app.get(/^\/v\d+\/status/,      handler);   // RegExp (no /g or /y flags)
```

### Request fields

Every request is augmented before middleware runs:

| Field | Description |
|---|---|
| `req.params` | Named route params + flat URL query params |
| `req.query` | URL query params (repeated keys → arrays) |
| `req.path` | Current path (stripped by `use()` layers) |
| `req.baseUrl` | Accumulated prefix from parent `use()` mounts |
| `req.hostname` | `Host` header with port stripped |
| `req.protocol` | `'http'` or `'https'` |
| `req.secure` | `true` when protocol is `https` |
| `req.ip` | Remote IP (respects `X-Forwarded-For` when `trustProxy: true`) |
| `req.ips` | Full XFF chain as an array |
| `req.cookies` | Parsed cookies; `s:` values are HMAC-verified |
| `req.json()` | Parse body as JSON (Promise) |
| `req.text()` | Read body as text (Promise) |
| `req.formData()` | Parse body as multipart (Promise) |
| `req.header(name)` | Read a request header by name (case-insensitive) |

The `req.json()`, `req.text()`, and `req.formData()` helpers accept the same `BodyOptions` as the parser middleware, including `limit`, `inflate`, and the `verify` hook (a throw rejects the returned promise with the error's `status`, default `403`).

### Response helpers

```ts
res.send('Hello');                   // write and end
res.json({ ok: true });              // JSON body + Content-Type
res.status(201).send('Created');     // set status code (integer 100–999)
res.redirect('/new-url');            // 302 Found
res.type('text/csv').send(data);     // set Content-Type
res.etag('v1').json(payload);        // weak ETag W/"v1"
res.cookie('session', 'abc', { ... }); // Set-Cookie (value percent-encoded)
res.clearCookie('session');          // Max-Age=0 + Expires=epoch
res.download('/path/file.pdf');      // Content-Disposition: attachment
res.attachment('report.pdf').send(buf); // set disposition + Content-Type
res.sendStatus(200);                 // status + standard text body
res.header('Cache-Control', 'no-store'); // set a header (replaces)
res.append('X-Custom', 'v1');        // append to header
res.vary('Accept');                  // add to Vary header
res.location('/new-path');           // set Location
res.locals['user'] = currentUser;    // request-scoped storage
```

### Error handling

→ Full reference: [docs/errors.md](docs/errors.md)

Any error thrown by a middleware — synchronous throw, rejected `async` middleware, or an explicit `next(err)` — enters the router's **error channel**.

Register ordered error middleware with `app.error()`. The error value is the **first** argument (to distinguish it from a normal middleware). Each handler either ends the response or calls `next` to pass control along — `next()` forwards the same error, `next(err)` replaces it:

```ts
app.error((err, _req, res, next) => {
  if ((err as any)?.status === 404) return res.status(404).json({ error: 'Not Found' });
  next(err); // not ours — let the next handler (or the parent router) deal with it
});

app.error((err, _req, res, _next) => {
  res.status((err as any)?.status ?? 500).json({ error: String(err) });
});
```

**Bubbling.** When a router's `error()` chain is exhausted without ending the response, the error falls back to that router's `onError()` handler (if any), and otherwise **bubbles up to the parent router** that mounted it via `use()`. This means a single handler on the root router can catch failures raised deep inside nested sub-routers. A top-level router with no handler sends a plain `500`.

```ts
const api = createRouter();
api.get('/items/:id', () => { throw new Error('boom'); });

const app = createRouter();
app.use('/api', api);                       // api has no error handler…
app.error((err, _req, res) =>               // …so the failure bubbles up to here
  res.status(500).json({ error: String(err) }));
```

`onError()` remains available as a simple, single terminal fallback `(err, req, res)` with no `next` — handy when you only want one catch-all and no bubbling.

> Caveat: only the returned promise is tracked. A middleware that calls `next()` and *then* throws later from a detached callback (`setTimeout`, an event emitter) is outside the framework's reach.

For a custom 404, register a catch-all as the **last** layer. Layers match in registration order, so it only runs when no earlier route claimed the request (`/**` matches any path, and `all()` matches any method):

```ts
app.all('/**', (_req, res) => res.status(404).json({ error: 'Not Found' }));
```

Without one, unmatched requests fall back to the built-in `Cannot METHOD /path` 404.

### Server

```ts
const server = app.listen(3000, () => console.log('Ready'));

// HTTPS
app.listen(443, { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') });

// HTTP/2
app.listen(443, { key, cert, http2: true });

// Graceful shutdown
process.on('SIGTERM', () => app.shutdown(10_000));
```

---

## Body parsing

→ Full reference: [docs/body-parsing.md](docs/body-parsing.md)

Typed parsers call `next()` when the request content-type does not match, so it is safe to stack them globally:

```ts
import { json, formData, formEncoded, raw, text, parseBody } from 'expediate';

app.use(json());        // application/json → req.body
app.use(formEncoded()); // application/x-www-form-urlencoded → req.body
app.use(formData());    // multipart/form-data → req.body as FormPart[]
app.use(text());        // text/plain → req.body as string
app.use(raw());         // application/octet-stream → req.body as Buffer

// Or catch everything at once (415 for unsupported types)
app.use(parseBody());
```

Request bodies encoded with `gzip`, `deflate`, or `br` (Brotli) are decompressed automatically (disable with `inflate: false`).

Override which requests a parser handles with `type`, and inspect the raw bytes before parsing with `verify` (throw to reject — handy for webhook signature checks):

```ts
app.post('/webhook',
  json({
    type:   'application/*',                // string, string[], or (req) => boolean
    verify: (req, res, buf) => verifySignature(req, buf), // throw → 403 (or err.status)
  }),
  handler,
);
```

Streaming multipart:

```ts
import { streamFormData } from 'expediate';

app.post('/upload', async (req, res) => {
  for await (const part of streamFormData(req)) {
    for await (const chunk of part.stream) { /* consume */ }
  }
  res.send('ok');
});
```

| Option | Default | Description |
|---|---|---|
| `limit` | `'100kb'` | Maximum body size |
| `inflate` | `true` | Accept gzip/deflate/br encoded bodies |
| `reviver` | `null` | JSON.parse reviver |
| `type` | per parser | Content-type matcher: string, string[], or `(req) => boolean` (supports `*` wildcards) |
| `verify` | `null` | Hook `(req, res, buf, encoding)` run on the raw body before parsing; throw to reject |

---

## Static files

→ Full reference: [docs/static.md](docs/static.md)

```ts
import { serveStatic, serveFile, sendFile } from 'expediate';

// Serve a directory
app.use('/public', serveStatic('./dist', { maxAge: 86_400_000 }));

// SPA catch-all
app.get('/**', serveFile('./dist/index.html'));

// Dynamic path
app.get('/files/:name', (req, res) => {
  sendFile(req as any, res as any, path.join('./files', req.params.name));
});
```

Features: weak ETags, `Last-Modified`, `304 Not Modified`, `Cache-Control`, dot-file policies, path traversal protection, HTML-escaped directory listings, `400` for malformed percent-encoded paths.

---

## Middleware suite

→ Full reference: [docs/middleware.md](docs/middleware.md)

| Middleware | Purpose |
|---|---|
| `compress()` | Brotli / gzip / deflate response compression |
| `conditionalGet()` | `If-None-Match` / `If-Modified-Since` → 304 |
| `cacheControl()` | `Cache-Control`, `Expires`, `Vary` headers |
| `requestId()` | Unique `req.id` + response header |
| `rateLimit()` | Sliding-window in-memory rate limiting |
| `csrf()` | Double-submit cookie CSRF protection |
| `securityHeaders()` | HSTS, X-Frame-Options, CSP baseline, etc. |
| `cors()` | Cross-Origin Resource Sharing headers |
| `logger()` | One-line request log with timing |

```ts
import {
  compress, conditionalGet, cacheControl, requestId,
  rateLimit, csrf, securityHeaders, cors, logger,
} from 'expediate';

app.use(compress());
app.use(securityHeaders());
app.use(cors({ origin: 'https://example.com' }));
app.use(requestId());
app.use(logger());
app.use(rateLimit({ windowMs: 60_000, max: 100 }));
```

---

## JWT authentication

→ Full reference: [docs/jwt-auth.md](docs/jwt-auth.md)

```ts
import { createRouter, json, createJwtPlugin } from 'expediate';

const app  = createRouter();
const auth = createJwtPlugin({
  accessTokenSecret: process.env.JWT_SECRET!,
  fetchUser:         (username) => db.users.findOne({ username }),
  isPasswordValid:   (user, pw) => bcrypt.compare(pw, user.passwordHash),
});

app.post('/auth/login',   json(), auth.login);
app.post('/auth/refresh', json(), auth.refresh);
app.post('/auth/logout',  json(), auth.logout);

// Protect routes
app.get('/me',           auth.authenticate, auth.authorize, meHandler);
app.delete('/admin/:id', ...auth.requireRole('admin'),      deleteUser);
app.put('/posts/:id',    ...auth.requirePermission('write'), updatePost);
```

Supported algorithms: `HS256/384/512`, `RS256/384/512`, `ES256/384/512`. Refresh tokens rotate on every use. Fully implemented with Node.js `crypto` — no third-party JWT library.

> **Security note:** always supply `fetchUser` and `isPasswordValid`. The defaults use demo credentials and SHA-256 password hashing, which are unsuitable for production.

---

## API service builder

→ Full reference: [docs/api-builder.md](docs/api-builder.md)

Define REST endpoints as a controller-style service object with automatic scoping, lifecycle management, and error translation:

```ts
import { createRouter, json, apiBuilder } from 'expediate';
import type { ServiceDefinition, ApiContext } from 'expediate';

interface State { items: string[]; }

const service: ServiceDefinition<State> = {
  data: () => ({ items: [] }),

  GET: {
    '/items':     function (this: State) { return this.items; },
    '/items/:id': function (this: State, ctx: ApiContext) { return this.items[+ctx.params.id]; },
  },
  POST: {
    '/items': function (this: State, _ctx: ApiContext, body: any) {
      this.items.push(body.name);
      return this.items;
    },
  },
};

const app = createRouter();
app.use('/', json());
app.use('/api', apiBuilder(service));
app.listen(3000);
```

Three scoping modes: **singleton** (one global instance), **keyed** (one instance per key), **ephemeral** (new instance per request). Routes are automatically sorted by specificity so declaration order does not matter.

Errors thrown by a handler, guard, auth check, or validation are translated to HTTP automatically (`{ status, message | data }`, else `500`). Add a `service.onError` hook to log or reshape them before that translation — return nothing to keep the default, return an `ApiError` to override the response, or throw to escalate the error to the surrounding app's error channel (`app.error()`):

```ts
const service: ServiceDefinition<State> = {
  onError(err, ctx, _req) {
    metrics.increment('api.error', { path: ctx.path });
    if (err instanceof DbTimeout) return { status: 503, message: 'Try again shortly' };
    // return nothing → default translation; throw → bubble up to app.error()
  },
  // …routes…
};
```

Large APIs split into per-domain **controllers** that merge into one router and one OpenAPI document — with **guards**, a declarative **auth binding** bridged to the JWT plugin, and **runtime request validation** from declared JSON Schemas:

```ts
import { apiBuilder, defineController, describe, createJwtPlugin } from 'expediate';

const jwt = createJwtPlugin({ accessTokenSecret: SECRET });

const wikiController = defineController({
  prefix: '/p/:proj/wiki',
  tags:   ['Wiki'],
  permission: 'wiki.read',                   // auth.check() runs for every route
  guards: [loadProject],                     // pre-handler hooks; results land in ctx.state

  GET: {
    '/pages/:slug': describe(
      (ctx) => wiki.readPage(ctx.params.proj, ctx.params.slug),
      { summary: 'Read a wiki page' }),
  },
  PUT: {
    '/pages/:slug': describe(
      (ctx, body) => wiki.writePage(ctx.params.proj, ctx.params.slug, body),
      { summary: 'Create or update a page', permission: 'wiki.write' }),
  },
});

const api = apiBuilder({
  auth:     { authenticate: jwt.authenticate },  // default check reads ctx.user.permissions
  validate: true,                                // enforce declared requestBody schemas (400 + fieldErrors)
  controllers: [wikiController /* , issuesController, … */],
});
```

Duplicate `(verb, path)` pairs across controllers **throw at build time** instead of silently shadowing.

`apiBuilder(service, options?)` takes an optional second argument (`ApiBuilderOptions`) to control validation. When provided it overrides `service.validate`: `validateRequests` defaults **on** (cancel with `{ validateRequests: false }`) and `validateResponses` opts in to checking each handler's return against its declared `200` schema — `true` returns `500` on a mismatch (the server's fault), `'warn'` only logs it:

```ts
apiBuilder(service, { validateResponses: true }); // validate both incoming bodies and outgoing responses
```

---

## OpenAPI spec generation

→ Full reference: [docs/api-builder.md#openapi-spec-generation](docs/api-builder.md#openapi-spec-generation)

```ts
import { apiBuilder, describe } from 'expediate';

const service: ServiceDefinition<State> = {
  GET: {
    '/items': describe(
      function (this: State) { return this.items; },
      { summary: 'List items', responses: { '200': { description: 'Item array' } } },
    ),
  },
};

const api = apiBuilder(service);
app.use('/api', api);
app.get('/openapi.json', api.specHandler({ title: 'Items API', version: '1.0.0' }));
app.get('/openapi.yaml', api.specHandler({ title: 'Items API', version: '1.0.0' }, 'yaml'));
```

Controllers merge into a single document. Routes carrying a `permission` automatically emit `security: [{ bearerAuth: [] }]`, an `x-required-permissions` vendor extension, and the matching `components.securitySchemes` entry.

---

## Git Smart HTTP gateway

→ Full reference: [docs/git.md](docs/git.md)

Serve Git repositories over HTTP — supports clone, fetch, and push:

```ts
import { createRouter, gitHandler, gitCreate } from 'expediate';
import path from 'path';

const app = createRouter();

app.use('/repos/:repo', gitHandler({
  repository: (req) => {
    const name = req.params.repo;
    if (!/^[\w.-]+$/.test(name)) return null;
    return path.join('/srv/git', name + '.git');
  },
}));

app.listen(3000);
```

```bash
git clone http://localhost:3000/repos/myproject
git push  http://localhost:3000/repos/myproject HEAD:main
```

Create new repositories programmatically:

```ts
await gitCreate('/srv/git/newrepo.git', { description: 'New repository' });
```

---

## TypeScript types

Full declarations are included. Key exports:

```ts
// Router
import type {
  Router, RouterOptions, RouterRequest, RouterResponse,
  Middleware, MiddlewareArg, NextFunction, ErrorHandler,
  Layer, RouteInfo, CookieOptions, TlsOptions, StringMap,
} from 'expediate';

// Body parsing
import type { BodyOptions, FormPart, FormPartStream, LoggerOptions } from 'expediate';

// Static files
import type { StaticOptions, Mime } from 'expediate';

// Middleware
import type {
  CompressOptions, RequestIdOptions, RateLimitOptions,
  CacheControlOptions, CsrfOptions, SecurityHeadersOptions,
} from 'expediate';

// JWT
import type {
  JwtConfig, JwtPlugin, TokenPayload, TokenStore,
  UserRecord, RefreshTokenRecord,
} from 'expediate';

// API builder + OpenAPI
import type {
  ServiceDefinition, ServiceMethod, ServiceMethods, RouteMap, ApiError,
  ApiContext, ControllerDefinition, Guard, AuthBinding, ApiBuilderOptions,
  OperationMeta, OpenApiServiceMeta, SpecOptions, OpenApiDocument,
} from 'expediate';

// Git
import type { GitHandlerOptions } from 'expediate';
```

---

## License

MIT © 2021 Fabien Bavent
