# Expediate — Roadmap

This document lists all known defects, missing features, and improvement ideas
for the **expediate** package, grouped by category and ordered by priority
within each section.

---

## Part 1 — Bug Fixes

These are correctness or safety issues that should be resolved before the
package is used in any production environment.

---

### 🔴 Critical

#### FIX-01 · `res.cookie()` overwrites previous cookies

**File:** `src/router.ts` — `updateHttpObjects()`

`res.setHeader('Set-Cookie', txt)` replaces any previously set `Set-Cookie`
header, so only the last cookie survives. Sending multiple cookies on a single
response is impossible today.

**Fix:** use `res.appendHeader('Set-Cookie', txt)` (Node ≥ 18) or accumulate
cookies in an array and call `res.setHeader('Set-Cookie', cookieArray)` once.

---

#### FIX-02 · Async middleware errors are silently swallowed

**File:** `src/router.ts` — `listener()`

The `try/catch` around `next()` only catches synchronous throws. A middleware
that returns a rejected `Promise` without catching it internally produces an
unhandled Promise rejection — no 500 response is sent to the client, the
connection hangs.

**Fix:** wrap the `layer.middleware(...)` call in a `Promise.resolve().then()`
so that async rejections can be caught and forwarded to the 500 handler.

---

#### FIX-03 · Chunked-transfer-encoding bodies are never read

**File:** `src/misc.ts` — `readBody()` and `readReqBody()`

Both functions gate body reading on `Content-Length > 0`. Requests sent with
`Transfer-Encoding: chunked` (no `Content-Length` header) are silently passed
through to `next()` with no body — `req.body` is never set.

**Fix:** treat a missing or zero `Content-Length` as "unknown size" and still
collect `data` events, capping accumulation at `opts.limit`.

---

#### FIX-04 · Wrong HTTP method returns 404 instead of 405

**File:** `src/router.ts` — `listener()`

When a path is registered for `GET` and a `POST` is made to it, the router
falls through all layers and ultimately responds with `404 Cannot POST /path`.
RFC 7231 §6.5.5 requires `405 Method Not Allowed` with an `Allow` header.

**Fix:** during the fallthrough walk, track whether any layer matched the path
but was filtered out by method; if so, respond 405 with the list of allowed
methods in the `Allow` header.

---

### 🟠 High

#### FIX-05 · Signed cookies are non-functional

**File:** `src/router.ts` — `res.cookie()`

When `opts.signed = true`, the code prepends `s:` but then throws
`cookieParser("secret") required for signed cookies` because `req.secret` is
never populated by the framework. The feature is advertised but completely
broken.

**Fix:** either remove the `signed` option until it is implemented, or integrate
an HMAC signing step using a configurable secret passed to the router (similar
to how `createJwtPlugin` takes a secret).

---

#### FIX-06 · Cookie reading ignores `j:` and `s:` prefixes

**File:** `src/router.ts` — `updateHttpObjects()`

The cookie parser returns raw strings including the `j:` and `s:` prefixes
that `res.cookie()` writes. Code reading `req.cookies['name']` gets `j:{"foo":1}`
instead of the parsed object.

**Fix:** strip `s:` and `j:` prefixes on read, JSON-parsing `j:` values.

---

#### FIX-07 · `apiBuilder` `setup()` is not awaited when async

**File:** `src/apis.ts` — `buildModule()`

`service.setup.apply(instance, [])` discards the returned `Promise`. Async
setup work (e.g. loading a database, reading a config file) will not have
completed when the first request arrives, silently serving stale state.

**Fix:** `buildModule` should return a `Promise<TInstance>` and `apiBuilder`
should chain route registration after it resolves. Add a `notReady` guard in
the interim, or document the `throwIfNotReady()` pattern prominently.

---

#### FIX-08 · Refresh token store grows without bound

**File:** `src/jwt-auth.ts` — `DEFAULT_CONFIG`

The default `refreshTokenStore` is an in-process `Map` that is never pruned.
Expired tokens remain in memory indefinitely, causing a slow memory leak in
long-running servers.

**Fix:** add a periodic cleanup (via `setInterval`) that removes entries whose
`expiresAt` is in the past, or replace the default store with an LRU/TTL-aware
structure.

---

#### FIX-09 · `req.json()` rejects with an inconsistent error shape

**File:** `src/router.ts` — `updateHttpObjects()`

The rejection value uses `{ status, message }` (lowercase `status`) while the
rest of the framework uses `{ httpStatus, message }` (e.g. `ApiError`). Code
that catches `req.json()` rejections and tries to forward them as HTTP errors
must know which shape to expect.

**Fix:** align on one shape — `{ httpStatus, message }` — throughout.

---

### 🟡 Medium

#### FIX-10 · `BodyOptions.strict` is documented but never enforced

**File:** `src/misc.ts` — `readBodyAsJson()`

The option is marked in the JSDoc as restricting JSON to top-level
objects/arrays, but the check is never applied. The field silently has no
effect.

**Fix:** after `JSON.parse`, check `typeof result !== 'object' || result === null`
when `opts.strict` is `true` and send a 400 if a bare primitive is received.

---

#### FIX-11 · Directory listing is not sorted

**File:** `src/static.ts` — `writeIndexOf()`

Files and directories are listed in the order returned by the filesystem
(`fs.readdirSync`), which is unspecified and varies across OS. Users expect
alphabetical or directories-first ordering.

**Fix:** sort entries — directories first, then files, each group alphabetically.

---

#### ~~FIX-12 · `listen()` exposes no server handle~~ ✅ Fixed

`router.listen()` now returns the underlying `http.Server` or `https.Server`
instance, enabling graceful shutdown, error listeners, and ephemeral port
discovery. Four new tests cover the server handle, port discovery, clean
shutdown, and end-to-end request serving.

---

#### FIX-13 · Incomplete JSDoc on `gitCreate`

**File:** `src/git.ts` — `gitCreate()`

The function has placeholder JSDoc with empty `@param` and `@returns` tags,
making the generated `.d.ts` documentation unhelpful.

**Fix:** fill in `@param gitDirectory`, `@param opt`, and `@returns`.

---

#### FIX-14 · `refreshTokenSecret` is a no-op config field

**File:** `src/jwt-auth.ts` — `JwtConfig`

The field is present and documented as "reserved", but there is no code path
that reads it. It should either be removed from the public `JwtConfig`
interface or implemented.

**Fix:** implement signed refresh tokens (using `refreshTokenSecret`) or
mark the field `@internal` and keep it out of the public type until it is ready.

---

## Part 2 — Missing Features

These are capabilities commonly expected of a production HTTP server framework
that expediate currently lacks entirely.

---

### 🔴 Critical (production blockers)

#### FEAT-01 · `application/x-www-form-urlencoded` body parser

HTML `<form method="POST">` submissions use `application/x-www-form-urlencoded`
by default. The framework has no parser for this MIME type, so standard HTML
form submissions are unreadable without custom middleware.

**Proposal:** add `formEncoded(opts?)` middleware (or extend `parseBody`) that
decodes `key=value&key2=value2` bodies and assigns the result to `req.body`.

---

#### FEAT-02 · Graceful shutdown

There is no way to shut down the server cleanly: drain in-flight requests,
stop accepting new connections, and wait for all handlers to complete. This is
a basic production requirement for container-based deployments.

**Proposal:** expose the underlying `http.Server` from `listen()` (see FIX-12)
and add an optional `router.shutdown(timeout?)` helper that calls
`server.close()` and forcibly destroys idle sockets after the timeout.

---

#### FEAT-03 · Request query-string array support

Multiple values for the same parameter (`?ids=1&ids=2` or `?ids[]=1&ids[]=2`)
are silently collapsed to the last value by the `URLSearchParams` iteration in
`updateHttpObjects`. This makes it impossible to accept list-type query params.

**Proposal:** expose `req.queries.url` as `Record<string, string | string[]>`
and parse repeated keys into arrays.

---

#### FEAT-04 · Global error handler hook

Unlike Express, there is no 4-argument error middleware `(err, req, res, next)`.
Errors not caught synchronously in the try/catch produce raw 500 responses with
no customisation possible (no JSON error body, no logging, no metrics).

**Proposal:** allow registering an error handler on the router:

```ts
router.onError((err, req, res) => {
  res.status(err.status ?? 500).json({ error: err.message });
});
```

---

#### FEAT-05 · Response compression middleware

There is no way to gzip/brotli-compress response bodies. All responses are sent
uncompressed, which is a significant performance and bandwidth problem for text
content (HTML, JSON, CSS).

**Proposal:** add a `compress(opts?)` middleware that honours the client's
`Accept-Encoding` header and pipes the response through `zlib.createGzip()` or
`zlib.createBrotliCompress()`.

---

### 🟠 High

#### FEAT-06 · Router base path (prefix)

Registering a sub-router always requires spelling out the full prefix on every
call. There is no way to create a router that is inherently scoped to a base path.

**Proposal:**

```ts
const v1 = createRouter('/api/v1');
v1.get('/users', handler); // matches /api/v1/users
app.use(v1);
```

---

#### FEAT-07 · `next(err)` error propagation

`NextFunction` is `() => void`. Express-style `next(err)` — where passing an
argument skips remaining middleware and routes to the error handler — is not
supported.

**Proposal:** change `NextFunction` to `(err?: unknown) => void` and route
non-null arguments directly to the error handler registered via FEAT-04.

---

#### FEAT-08 · `req.ip` and proxy trust

The logger reads `X-Forwarded-For` directly, but no other part of the framework
exposes the client IP in a consistent, configurable way. In a reverse-proxy
setup the raw socket address is always the proxy, not the client.

**Proposal:** add a `trustProxy` option to the router; when enabled, expose
`req.ip` as the first `X-Forwarded-For` value. When disabled, use the raw
socket address.

---

#### FEAT-09 · Request ID middleware

Distributed tracing and log correlation require a unique request ID attached to
every request. Today this must be implemented ad-hoc by every application.

**Proposal:** add a `requestId(opts?)` middleware that attaches `req.id` (either
from an incoming `X-Request-ID` header or a generated UUID) and echoes it back
in the response `X-Request-ID` header.

---

#### FEAT-10 · `res.download(filepath, filename?)` helper

There is no convenient way to serve a file as an attachment (i.e. prompt the
browser to download it). The workaround requires setting `Content-Disposition`
manually and then calling `sendFile`.

**Proposal:** add `res.download(filepath, filename?)` that sets
`Content-Disposition: attachment; filename="..."` and streams the file.

---

#### FEAT-11 · Multipart streaming (large file uploads)

`formData()` buffers the entire multipart body into memory before parsing. Large
file uploads will exhaust the server's memory or be rejected by the size limit.

**Proposal:** add a streaming variant `formDataStream(opts?)` that exposes
each part as a readable stream, allowing callers to pipe them directly to disk
or object storage without buffering.

---

#### FEAT-12 · Route introspection

There is currently no way to enumerate the routes registered on a router — not
for debugging, not for generating documentation, and not for OpenAPI generation.

**Proposal:** expose `router.routes()` returning the internal `Layer[]` array
(or a sanitised summary), so tooling can inspect registered paths and methods.

---

### 🟡 Medium

#### FEAT-13 · ESM / dual-package build

The package is CommonJS-only (`"type": "commonjs"`). Modern Node.js projects
(and Bun, Deno) increasingly use ESM. A dual CJS+ESM build (or an ESM-first
build with a CJS shim) would make the package usable without import workarounds.

**Proposal:** add a second `tsconfig.esm.json` targeting `NodeNext` modules
with `moduleResolution: bundler` and publish both under the `exports` field in
`package.json`.

---

#### FEAT-14 · `res.type(mimeType)` convenience helper

Setting the response content type requires the verbose
`res.setHeader('Content-Type', 'application/json')`. A shorthand would improve
handler ergonomics.

**Proposal:** add `res.type(mime)` as an alias for
`res.setHeader('Content-Type', mime)`, returning `this` for chaining.

---

#### FEAT-15 · Path parameter type constraints

Route parameters are always captured as raw strings. There is no way to
constrain them to a pattern (e.g. `/:id(\\d+)`) or to receive automatic
coercion (e.g. `req.params.id` as a `number`).

**Proposal:** support inline regex constraints in path patterns, e.g.
`:id(\\d+)`, so that `/users/abc` does not match a route declared as
`/users/:id(\\d+)`. Coercion can be opt-in via an options object.

---

#### FEAT-16 · JWT algorithm expansion (RS256 / ES256)

Only HMAC algorithms (`HS256`, `HS384`, `HS512`) are supported. Asymmetric
algorithms (`RS256`, `ES256`) are needed for distributed systems where the
token is verified by a service that should not know the signing secret.

**Proposal:** add `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512` to
`JwtAlgorithm` using Node.js `crypto.sign()`/`crypto.verify()` with PEM keys.

---

#### FEAT-17 · Persistent / pluggable refresh token store

The default token store is an in-memory `Map` — not suitable for multi-instance
deployments (tokens issued on instance A are invisible to instance B). While
`JwtConfig.refreshTokenStore` is already pluggable, there is no documented
adapter pattern or example implementation.

**Proposal:** document the `TokenStore` interface clearly and provide a
reference Redis adapter (optionally, as a separate optional peer dependency or
an example in the README).

---

#### FEAT-18 · Built-in request timeout

Long-running or stalled requests tie up server resources indefinitely. Without
a configurable global timeout the server is vulnerable to slow-client attacks.

**Proposal:** add a `timeout` option to the router that sets
`req.socket.setTimeout(ms)` and calls `res.status(408).end()` if it fires
before `res.end()` is called.

---

---

## Part 3 — Nice-to-Have

Ideas that would make the package more ergonomic or feature-complete but are
not strictly necessary for correctness or stability.

---

#### NTH-01 · OpenAPI / Swagger spec generation

`apiBuilder` already has enough structural information (HTTP methods, path
patterns, service definitions) to generate an OpenAPI 3.x spec automatically.
This would enable Swagger UI, client SDK generation, and contract testing with
no extra work from the application developer.

---

#### NTH-02 · WebSocket upgrade support

The router has no hook for the HTTP `upgrade` event, making WebSocket servers
impossible to co-locate with the HTTP API on the same port.

**Proposal:** expose `router.ws(path, handler)` that intercepts the upgrade
handshake and manages the WebSocket lifecycle, or at minimum expose
`router.onUpgrade(fn)` to give the raw event to the caller.

---

#### NTH-03 · HTTP/2 support

The `listen()` helper hard-codes `http.createServer` / `https.createServer`.
HTTP/2 (`http2.createSecureServer`) is not available at all.

**Proposal:** add an `http2` flag to `TlsOptions` that switches to
`http2.createSecureServer()`. The existing middleware API is already compatible
with HTTP/2's request/response objects.

---

#### NTH-04 · Rate limiting middleware

No built-in protection against request floods. Applications must integrate a
third-party library (which conflicts with the zero-dependency philosophy).

**Proposal:** add a `rateLimit({ windowMs, max, keyBy? })` middleware factory
using an in-memory sliding window counter — no external dependency required.

---

#### NTH-05 · Response caching middleware

A `cacheControl(opts)` middleware that sets `Cache-Control`, `Expires`, and
`Vary` headers on responses based on configurable rules would simplify CDN
integration.

---

#### NTH-06 · CSRF protection middleware

Session-based applications need CSRF token generation and validation. A
lightweight `csrf()` middleware using the synchronizer-token pattern (or
double-submit cookie) would make expediate suitable for server-rendered apps.

---

#### NTH-07 · Helmet-style security headers middleware

A `helmet()` middleware that sets a sensible default security-header baseline
(`Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`) with per-header opt-out options.

---

#### NTH-08 · `ETag` / conditional-GET support for dynamic responses

Static file serving already has ETag + `If-None-Match` / `If-Modified-Since`
support. Dynamic route handlers have no equivalent — every `GET /api/resource`
is a full response even when the data has not changed.

**Proposal:** add a `res.etag(value)` helper and a middleware factory
`conditionalGet()` that checks `If-None-Match` against `res.getHeader('ETag')`
and short-circuits with 304 when they match.

---

#### NTH-09 · `router.all('*', notFoundHandler)` catch-all convention

The built-in 404 sends a plain-text `Cannot METHOD /path`. Applications that
return JSON errors from their API need to replace this with a custom handler.
While this is already possible via `app.all('*', handler)`, it is not
documented and glob matching interacts with the `use()` path-stripping logic
in non-obvious ways.

**Proposal:** document (and test) the canonical pattern for overriding the
built-in 404 response, and consider exposing `router.setNotFound(handler)` as
an explicit API.

---

#### NTH-10 · CLI scaffold (`npx expediate init`)

A `create-expediate` CLI or an `npx expediate init` command that scaffolds a
minimal server project (TypeScript config, entry point, a sample route) would
significantly lower the time-to-first-request for new users.

---

#### NTH-11 · Request body schema validation hook

`apiBuilder` service methods receive the parsed body as-is. Adding an optional
`schema` field per route (compatible with a simple hand-rolled validator or an
external library like Zod or Valibot) would enable automatic 400 responses for
malformed input before the handler is ever called.

---

#### NTH-12 · Cluster / multi-process helper

Node.js `cluster` module integration (fork workers, handle signals, zero-downtime
restarts) is boilerplate that every production server has to write. A thin
`cluster(router, opts)` wrapper would make expediate self-contained for
single-host deployments.

---

## Summary Table

| ID       | Category    | Priority | Title                                          |
|----------|-------------|----------|------------------------------------------------|
| FIX-01   | Bug         | 🔴       | `res.cookie()` overwrites previous cookies      |
| FIX-02   | Bug         | 🔴       | Async middleware errors unhandled               |
| FIX-03   | Bug         | 🔴       | Chunked-encoding bodies never read              |
| FIX-04   | Bug         | 🔴       | Wrong method returns 404 instead of 405         |
| FIX-05   | Bug         | 🟠       | Signed cookies non-functional                   |
| FIX-06   | Bug         | 🟠       | Cookie reading ignores `j:`/`s:` prefixes       |
| FIX-07   | Bug         | 🟠       | `async setup()` not awaited in apiBuilder        |
| FIX-08   | Bug         | 🟠       | Refresh token store grows without bound         |
| FIX-09   | Bug         | 🟠       | `req.json()` rejects with wrong error shape     |
| FIX-10   | Bug         | 🟡       | `BodyOptions.strict` not enforced               |
| FIX-11   | Bug         | 🟡       | Directory listing unsorted                      |
| ~~FIX-12~~| Bug        | ✅       | `listen()` exposes no server handle             |
| FIX-13   | Bug         | 🟡       | Incomplete JSDoc on `gitCreate`                 |
| FIX-14   | Bug         | 🟡       | `refreshTokenSecret` is a no-op field           |
| FEAT-01  | Feature     | 🔴       | `application/x-www-form-urlencoded` parser      |
| FEAT-02  | Feature     | 🔴       | Graceful shutdown                               |
| FEAT-03  | Feature     | 🔴       | Query-string array support                      |
| FEAT-04  | Feature     | 🔴       | Global error handler hook                       |
| FEAT-05  | Feature     | 🔴       | Response compression middleware                 |
| FEAT-06  | Feature     | 🟠       | Router base path / prefix                       |
| FEAT-07  | Feature     | 🟠       | `next(err)` error propagation                   |
| FEAT-08  | Feature     | 🟠       | `req.ip` and proxy trust setting                |
| FEAT-09  | Feature     | 🟠       | Request ID middleware                           |
| FEAT-10  | Feature     | 🟠       | `res.download()` helper                         |
| FEAT-11  | Feature     | 🟠       | Multipart streaming for large uploads           |
| FEAT-12  | Feature     | 🟠       | Route introspection (`router.routes()`)         |
| FEAT-13  | Feature     | 🟡       | ESM / dual-package build                        |
| FEAT-14  | Feature     | 🟡       | `res.type()` convenience helper                 |
| FEAT-15  | Feature     | 🟡       | Path parameter type constraints                 |
| FEAT-16  | Feature     | 🟡       | JWT asymmetric algorithm support                |
| FEAT-17  | Feature     | 🟡       | Documented pluggable refresh token store        |
| FEAT-18  | Feature     | 🟡       | Built-in request timeout                        |
| NTH-01   | Nice-to-have| —        | OpenAPI / Swagger spec generation               |
| NTH-02   | Nice-to-have| —        | WebSocket upgrade support                       |
| NTH-03   | Nice-to-have| —        | HTTP/2 support                                  |
| NTH-04   | Nice-to-have| —        | Rate limiting middleware                        |
| NTH-05   | Nice-to-have| —        | Response caching middleware                     |
| NTH-06   | Nice-to-have| —        | CSRF protection middleware                      |
| NTH-07   | Nice-to-have| —        | Helmet-style security headers middleware        |
| NTH-08   | Nice-to-have| —        | ETag / conditional-GET for dynamic responses    |
| NTH-09   | Nice-to-have| —        | Documented 404 override pattern                 |
| NTH-10   | Nice-to-have| —        | CLI scaffold (`npx expediate init`)             |
| NTH-11   | Nice-to-have| —        | Request body schema validation hook             |
| NTH-12   | Nice-to-have| —        | Cluster / multi-process helper                  |
