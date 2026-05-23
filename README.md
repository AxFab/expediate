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

**expediate** provides an Express-compatible API surface with full TypeScript types, built-in body parsing, static file serving, JWT authentication, multipart form handling, and a Git Smart HTTP gateway — all in a single package with no runtime dependencies beyond Node.js itself.


---

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Router](#router)
  - [Creating a router](#creating-a-router)
  - [Route registration](#route-registration)
  - [Path patterns](#path-patterns)
  - [Response helpers](#response-helpers)
  - [Sub-routers](#sub-routers)
  - [Starting the server](#starting-the-server)
- [Body parsing](#body-parsing)
  - [`json()`](#json)
  - [`formData()`](#formdata)
  - [`parseBody()`](#parsebody)
- [Static files](#static-files)
  - [`serveStatic()`](#servestatic)
  - [`serveFile()`](#servefile)
  - [`sendFile()`](#sendfile)
- [Request logging](#request-logging)
- [JWT Authentication](#jwt-authentication)
  - [Setup](#setup)
  - [Protecting routes](#protecting-routes)
  - [Role and permission guards](#role-and-permission-guards)
  - [Configuration reference](#configuration-reference)
- [API service builder](#api-service-builder)
  - [Defining a service](#defining-a-service)
  - [Scoping](#scoping)
  - [Error handling](#error-handling)
- [Git Smart HTTP gateway](#git-smart-http-gateway)
- [TypeScript types](#typescript-types)

---

## Installation

```bash
npm install expediate
```

Node.js ≥ 18 is required. The package ships as native ESM with full TypeScript declarations.

---

## Quick start

```ts
import { createRouter, json, logger } from 'expediate';

const app = createRouter();

app.use('/', logger());
app.use('/', json());

app.get('/hello/:name', (req, res) => {
  res.send(`Hello, ${req.params.name}!`);
});

app.post('/echo', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify((req as any).body));
});

app.listen(3000, () => console.log('Listening on :3000'));
```

---

## Router

### Creating a router

```ts
import { createRouter } from 'expediate';

const app = createRouter();
```

`createRouter()` returns a `Router` object that also acts as a middleware function itself, making it nestable.

### Route registration

All registration methods share the same signature:

```ts
router.METHOD(path, ...middleware)
```

| Method | HTTP verb | Notes |
|---|---|---|
| `router.get(path, ...mw)` | `GET` | Path is not stripped from `req.path` — chained middlewares see the full path |
| `router.post(path, ...mw)` | `POST` | |
| `router.put(path, ...mw)` | `PUT` | |
| `router.delete(path, ...mw)` | `DELETE` | |
| `router.patch(path, ...mw)` | `PATCH` | |
| `router.use(path, ...mw)` | any | **Strips the matched prefix** from `req.path` before calling middleware; used for mounting sub-routers |
| `router.all(path, ...mw)` | any | Matches any method but don't strips the prefix |

Each middleware slot accepts a `Middleware` function, a `Router` instance, or an array of either:

```ts
const guard: Middleware = (req, res, next) => {
  if (!req.headers.authorization) return res.status(401).end();
  next();
};

app.get('/secret', guard, (req, res) => res.send('classified'));
app.get('/multi',  [guard, anotherMiddleware], handler);
```

### Path patterns

Three pattern types are supported:

**Plain strings with `:param` segments**
```ts
app.get('/users/:id',              handler);  // req.params.id
app.get('/orgs/:org/repos/:repo',  handler);  // req.params.org, req.params.repo
```

**Glob patterns** (`.gitignore` wildcard rules)
```ts
app.get('/api/*',       handler);  // one path segment
app.get('/api/**',      handler);  // any depth
app.get('/**/*.php',    handler);  // PHP files in any subdirectory
app.get('/v?/status',   handler);  // one character wildcard
```

**Regular expressions** — named capture groups become `req.params` entries
```ts
app.get(/^\/users\/(?<id>\d+)/, handler);  // req.params.id
```

> **Route specificity:** when using `apiBuilder`, routes are automatically sorted by specificity (more segments / fewer parameters first) to prevent shorter paths from shadowing longer ones.

### Response helpers

Every response object is augmented with convenience methods:

```ts
res.send('Hello');                   // write body and end
res.send();                          // end with no body
res.status(404).send('Not found');   // set status + body (chainable)
res.status(201).end();               // set status and end
res.redirect('/new-url');            // 302 redirect
res.cookie('session', 'abc', {
  maxAge:   3_600_000,               // milliseconds
  path:     '/api',
  signed:   false,
});
```

<!-- Every response also carries `X-Powered-By: Expediate`. -->

### Sub-routers

Routers are fully nestable. Use `router.use()` to mount a child router under a prefix — the prefix is stripped from `req.path` before child middleware runs:

```ts
const api = createRouter();
api.get('/users',     listUsers);
api.get('/users/:id', getUser);
api.post('/users',    createUser);

const app = createRouter();
app.use('/api/v1', api);  // /api/v1/users → api sees /users
```

Pass a `Router` instance directly (no need to unwrap `.listener`):

```ts
app.use('/auth', authRouter);   // Router instance
app.use('/auth', authRouter.listener);  // equivalent
```

### Starting the server

```ts
// HTTP
app.listen(3000, () => console.log('Ready'));

// HTTPS
import { readFileSync } from 'fs';
app.listen(443, {
  key:  readFileSync('server.key'),
  cert: readFileSync('server.crt'),
});
```

---

## Body parsing

All body-parsing middleware must be registered **before** route handlers that need `req.body`.

### `json()`

Parses `application/json` request bodies and populates `req.body`. Also attaches `res.json(data)` for sending JSON responses.

```ts
import { json } from 'expediate';

app.use('/', json());

app.post('/data', (req, res) => {
  const body = (req as any).body;
  res.json({ received: body });
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Maximum body size. Accepts `'10kb'`, `'2mb'`, `'1gb'`, or a number of bytes |
| `inflate` | `boolean` | `true` | Decompress gzip/deflate bodies automatically |
| `reviver` | `Reviver \| null` | `null` | Passed as the second argument to `JSON.parse` |
| `strict` | `boolean` | `true` | Reserved for top-level primitive rejection |

**Status codes returned on error:**
- `413 Content Too Large` — body exceeds `limit`
- `415 Unsupported Media Type` — wrong `Content-Type` or unsupported encoding
- `500 Internal Server Error` — malformed JSON or unsupported charset

### `formData()`

Parses `multipart/form-data` bodies. Populates `req.body` with an array of `FormPart` objects, each exposing:
- `headers` — part headers (lowercased, e.g. `content-disposition`)
- `content` — raw `Buffer` of the part body

```ts
import { formData } from 'expediate';

app.post('/upload', formData(), (req, res) => {
  const parts = (req as any).body as FormPart[];
  for (const part of parts) {
    const disp = part.headers['content-disposition'];
    console.log(disp, '-', part.content.length, 'bytes');
  }
  res.status(201).end();
});
```

Accepts the same `limit` and `inflate` options as `json()`.

### `parseBody()`

Auto-detects the `Content-Type` and dispatches to the appropriate parser. Supports:

| Content-Type | Result in `req.body` |
|---|---|
| `application/json` | Parsed JS value |
| `multipart/form-data` | `FormPart[]` |
| `text/plain` | Decoded string |

```ts
import { parseBody } from 'expediate';

app.use('/', parseBody());
```

Unsupported MIME types receive `415 Unsupported Media Type`.

---

## Static files

### `serveStatic()`

Serve an entire directory of static assets:

```ts
import { serveStatic } from 'expediate';

app.use('/public', serveStatic('./dist'));
```

Features: ETag, Last-Modified, conditional GET (304), Cache-Control, MIME-type detection, dot-file handling, directory index redirect, gzip/deflate decompression.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxage` / `maxAge` | `number` | `0` | Cache lifetime in **milliseconds** → `Cache-Control: public, max-age=<s>` |
| `immutable` | `boolean` | `false` | Appends `, immutable` to `Cache-Control` |
| `etag` | `boolean` | `true` | Send weak `ETag` header |
| `lastModified` | `boolean` | `true` | Send `Last-Modified` header |
| `dotfiles` | `'allow' \| 'deny' \| 'hide'` | `'hide'` | Dot-file access policy |
| `redirect` | `boolean` | `true` | Redirect directory requests to `index.html` |
| `fallthrough` | `boolean` | `true` | Call `next()` instead of sending 404 for missing files |
| `contentType` | `string \| null` | `null` | Override auto-detected `Content-Type` |
| `headers` | `Record<string, string>` | security defaults | Extra response headers merged with built-in CSP / XCTO headers |

### `serveFile()`

Serve a single fixed file for every request — ideal for SPA catch-all routes:

```ts
import { serveFile } from 'expediate';

// Serve dist/index.html for every unmatched route
app.get('/**', serveFile('./dist/index.html'));
```

Supports the same caching and method-filtering options as `serveStatic()`. Returns `500 EISDIR` if the path points to a directory.

### `sendFile()`

Low-level utility for sending an arbitrary file path dynamically:

```ts
import { sendFile } from 'expediate';
import type { StaticOptions } from 'expediate';

const opts: StaticOptions = { etag: true, lastModified: true };

app.get('/downloads/:file', (req, res) => {
  const filePath = path.join('./downloads', req.params.file);
  sendFile(req as any, res as any, filePath, opts as any);
});
```

---

## Request logging

```ts
import { logger } from 'expediate';

app.use('/', logger({
  track:        true,            // warn on requests that never finish (dev only)
  trackTimeout: 30_000,          // ms before emitting a LOST warning
  user:         (req) => (req as any).user?.username ?? '-',
  locale:       'en-US',
  logger:       (msg) => process.stderr.write(msg + '\n'),
}));
```

Output format (one line per completed request, ANSI-coloured by status class):

```
21 Mar, 14:32  200  GET  /api/users  127.0.0.1  <alice>  4 ms  (1234)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `track` | `boolean` | `false` | Enable lost-request detection |
| `trackTimeout` | `number` | `30000` | Timeout in ms before a LOST line is emitted |
| `user` | `(req) => string` | `() => '-'` | Extract a user identity from the request |
| `locale` | `string` | `'en-GB'` | BCP 47 locale for the timestamp |
| `dateFormat` | `Intl.DateTimeFormatOptions` | short date+time | Timestamp format |
| `logger` | `(msg: string) => void` | `console.log` | Custom logging sink |

---

## JWT Authentication

### Setup

```ts
import { createRouter, json, createJwtPlugin } from 'expediate';

const app  = createRouter();
const auth = createJwtPlugin({
  accessTokenSecret:  process.env.JWT_SECRET!,
  refreshTokenSecret: process.env.JWT_REFRESH_SECRET!,
});

// Mount auth endpoints (require json() body parser first)
app.post('/auth/login',   json(), auth.login);
app.post('/auth/refresh', json(), auth.refresh);
app.post('/auth/logout',  json(), auth.logout);
```

#### `POST /auth/login`

```json
// Request body
{ "username": "alice", "password": "password123" }

// Response 200
{
  "accessToken":  "eyJ...",
  "refreshToken": "a3f8...",
  "expiresIn":    900,
  "tokenType":    "Bearer"
}
```

#### `POST /auth/refresh`

```json
// Request body
{ "username": "alice", "refreshToken": "a3f8..." }

// Response 200 — new token pair (old refresh token is invalidated)
{ "accessToken": "eyJ...", "refreshToken": "b9c2...", ... }
```

Refresh tokens are **rotated** on every use — the presented token is always invalidated and a fresh pair is issued.

#### `POST /auth/logout`

```json
{ "refreshToken": "b9c2..." }
// Response 200 — refresh token revoked
```

### Protecting routes

```ts
// authenticate — silently populates req.user; calls next() even on failure
// authorize   — rejects with 401 if req.user is not set
app.get('/me', auth.authenticate, auth.authorize, (req, res) => {
  res.send(`Hello, ${(req as any).user.username}`);
});
```

`req.user` is populated with the decoded `TokenPayload`:

```ts
interface TokenPayload {
  sub:          string;   // user ID
  username:     string;
  iss:          string;   // issuer
  iat:          number;   // issued at (Unix s)
  exp:          number;   // expires at (Unix s)
  roles?:       string[];
  permissions?: string[];
}
```

### Role and permission guards

```ts
// Require at least one of the listed roles
app.delete('/admin/users/:id', ...auth.requireRole('admin'), deleteUser);

// Require ALL listed permissions
app.put('/posts/:id', ...auth.requirePermission('write', 'publish'), updatePost);
```

Both factories return `[authenticate, guard]` — spread them into the route registration:

```ts
app.get('/report', ...auth.requireRole('admin', 'editor'), getReport);
```

### Configuration reference

```ts
const auth = createJwtPlugin({
  // Secrets — always override in production
  accessTokenSecret:  'change-me',
  refreshTokenSecret: 'change-me',

  // Expiry
  accessTokenExpiry:  15 * 60,         // 15 minutes (seconds)
  refreshTokenExpiry: 7 * 24 * 3600,   // 7 days (seconds)

  // Token claims
  issuer:      'my-app',
  checkIssuer: true,                   // reject tokens with wrong iss claim
  alg:         'HS256',                // 'HS256' | 'HS384' | 'HS512'

  // User lookup (replace with a database query) — must override
  // Returned object must have a username field
  fetchUser: async (username) => {
    return await db.users.findOne({ username });
  },

  // Password validation — default look for SHA256(user.passwordHash), replace with bcrypt/argon2
  isPasswordValid: async (user, password) => {
    return await bcrypt.compare(password, user.passwordHash);
  },

  // Custom JWT payload
  payload: (user) => ({
    sub:   user.id,
    email: user.email,
    roles: user.roles,
  }),

  // Custom token store (replace with Redis for multi-instance deployments)
  refreshTokenStore: redisAdapter,
});
```

> **Security note:** the default password hashing uses SHA-256, which is fast and unsuitable for production. Replace `isPasswordValid` with a bcrypt or argon2 implementation.

---

## API service builder

`apiBuilder` lets you define REST endpoints as a controller-style service object, handling scoping, lifecycle, method binding, and error translation automatically.

### Defining a service

```ts
import { createRouter, json, apiBuilder } from 'expediate';
import type { ServiceDefinition } from 'expediate';

interface TodoState {
  items: Record<string, { title: string; done: boolean }>;
  nextId: number;
}

const todoService: ServiceDefinition<TodoState> = {
  // Initial state
  data: () => ({ items: {}, nextId: 1 }),

  // Shared helper methods (bound to `this`)
  methods: {
    findOrThrow(this: TodoState, id: string) {
      const item = this.items[id];
      if (!item) throw { status: 404, message: 'Todo not found' };
      return item;
    },
  },

  GET: {
    '/todos':     function (this: TodoState) { return Object.entries(this.items).map(([id, v]) => ({ id, ...v })); },
    '/todos/:id': function (this: TodoState, params) { return this.findOrThrow(params.id); },
  },

  POST: {
    '/todos': function (this: TodoState, _params, body: any) {
      const id = String(this.nextId++);
      this.items[id] = { title: body.title, done: false };
      return { id, ...this.items[id] };
    },
  },

  DELETE: {
    '/todos/:id': function (this: TodoState, params) {
      this.findOrThrow(params.id);
      delete this.items[params.id];
      return undefined;  // → 201 No Content
    },
  },
};

const app = createRouter();
app.use('/', json());
app.use('/api', apiBuilder(todoService));

app.listen(3000);
```

**Handler conventions:**

| Return value | HTTP response |
|---|---|
| Truthy value or `Promise` resolving to one | `200 OK` with JSON body |
| `undefined`, `null`, `false`, `0`, `''` | `201 No Content` |
| Throw `{ status, message }` | `<status>` with plain-text body |
| Throw `{ status, data }` | `<status>` with JSON body |
| Throw anything else | `500 Internal Server Error` |

### Scoping

Control how many instances of the service state are created:

```ts
const service: ServiceDefinition = {
  // Singleton (default — omit `scope`): one global instance
  // scope: undefined

  // Per-session: same instance reused for all requests sharing the key
  scope: (req) => (req as any).session?.ssid ?? null,

  // Per-request: fresh instance for every request (null key)
  scope: () => null,

  data: () => ({ /* initial state */ }),
};
```

> The key returned by the `scope()` method is store at `this.$key`.

### Error handling

Throw structured errors from any handler or method to send precise HTTP responses:

```ts
// Plain message
throw { status: 404, message: 'Resource not found' };

// JSON body
throw { status: 422, data: { field: 'email', error: 'invalid format' } };

// Guard pattern for async setup
methods: {
  throwIfNotReady(this: any) {
    if (!this.ready)
      throw { status: 503, message: 'Service initialising — try again shortly' };
  },
},
setup: function (this: any) {
  this.loadData().then(() => { this.ready = true; });
},
```

---

## Git Smart HTTP gateway

Serve a Git repository over HTTP (fetch / clone only — push is not supported):

```ts
import { createRouter, gitHandler } from 'expediate';
import path from 'path';

const app = createRouter();

app.use('/repos/:repo', gitHandler({
  repository: (req) => {
    // Resolve the repo path from the request; return falsy to 404
    const name = req.params.repo;
    if (!/^[\w.-]+$/.test(name)) return null;
    return path.join('/srv/git', name + '.git');
  },
}));

app.listen(3000);
```

Clients can now clone with:

```bash
git clone http://localhost:3000/repos/myproject
```

| Option | Type | Default | Description |
|---|---|---|---|
| `repository` | `(req) => string \| null` | **required** | Resolve the absolute path to the bare repository. Return falsy to send 404 |
| `gitPath` | `string` | `''` | Directory prefix for the `git-upload-pack` binary (include trailing `/`) |
| `strict` | `boolean` | `false` | When `true`, omits `--no-strict` — git will reject non-bare repositories |
| `timeout` | `number \| string` | none | Kill `git-upload-pack` after this many **seconds** |

**Supported endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/info/refs?service=git-upload-pack` | Capability advertisement |
| `POST` | `/git-upload-pack` | Pack negotiation and transfer |

Gzip-compressed `POST` bodies are decompressed transparently. Spawn errors (e.g. `git` not installed) return `500` with a descriptive message.

---

## TypeScript types

Full type declarations are included. Key types exported from the package:

```ts
// Router
import type { Router, RouterRequest, RouterResponse, Middleware, MiddlewareArg } from 'expediate';

// Body parsing
import type { BodyOptions, FormPart } from 'expediate';

// Static files
import type { StaticOptions } from 'expediate';

// Logging
import type { LoggerOptions } from 'expediate';

// JWT
import type { JwtConfig, JwtPlugin, TokenPayload, UserRecord, TokenStore } from 'expediate';

// API builder
import type { ServiceDefinition, ServiceMethod, ApiError } from 'expediate';

// Git
import type { GitHandlerOptions } from 'expediate';
```

---

## License

MIT © 2021 Fabien Bavent
