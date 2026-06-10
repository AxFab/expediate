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

Node.js ≥ 18 is required. The package ships as native ESM with full TypeScript declarations and a CommonJS compatibility bundle.

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

### Response helpers

```ts
res.send('Hello');                   // write and end
res.json({ ok: true });              // JSON body + Content-Type
res.status(201).send('Created');     // set status code (integer 100–999)
res.redirect('/new-url');            // 302 Found
res.type('text/csv').send(data);     // set Content-Type
res.etag('v1').json(payload);        // weak ETag W/"v1"
res.cookie('session', 'abc', { ... }); // Set-Cookie
res.clearCookie('session');          // Max-Age=0 + Expires=epoch
res.download('/path/file.pdf');      // Content-Disposition: attachment
res.attachment('report.pdf').send(buf); // set disposition + Content-Type
res.sendStatus(200);                 // status + standard text body
res.append('X-Custom', 'v1');        // append to header
res.vary('Accept');                  // add to Vary header
res.location('/new-path');           // set Location
res.locals['user'] = currentUser;    // request-scoped storage
```

### Error handling

```ts
app.onError((err, _req, res) => {
  const status = (err as any)?.status ?? 500;
  res.status(status).json({ error: String(err) });
});

app.setNotFound((_req, res) => res.status(404).json({ error: 'Not Found' }));
```

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
import { json, formData, formEncoded, parseBody } from 'expediate';

app.use(json());        // application/json → req.body
app.use(formEncoded()); // application/x-www-form-urlencoded → req.body
app.use(formData());    // multipart/form-data → req.body as FormPart[]

// Or catch everything at once (415 for unsupported types)
app.use(parseBody());
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
| `inflate` | `true` | Accept gzip/deflate encoded bodies |
| `reviver` | `null` | JSON.parse reviver |

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
import type { ServiceDefinition } from 'expediate';

interface State { items: string[]; }

const service: ServiceDefinition<State> = {
  data: () => ({ items: [] }),

  GET: {
    '/items': function (this: State) { return this.items; },
  },
  POST: {
    '/items': function (this: State, _p, body: any) {
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

---

## OpenAPI spec generation

→ Full reference: [docs/api-builder.md#openapi-spec-generation](docs/api-builder.md#openapi-spec-generation)

```ts
import { describe, openApiSpec } from 'expediate';

const annotatedService = describe({
  summary: 'Items API',
  GET: {
    '/items': {
      summary:   'List items',
      responses: { 200: { description: 'Item array' } },
      handler:   function (this: State) { return this.items; },
    },
  },
});

app.use('/api', apiBuilder(annotatedService));
app.get('/openapi.json', openApiSpec(annotatedService, { title: 'Items API', version: '1.0.0' }));
app.get('/openapi.yaml', openApiSpec(annotatedService, { title: 'Items API', version: '1.0.0', format: 'yaml' }));
```

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
  OperationMeta, OpenApiServiceMeta, SpecOptions, OpenApiDocument,
} from 'expediate';

// Git
import type { GitHandlerOptions } from 'expediate';
```

---

## License

MIT © 2021 Fabien Bavent
