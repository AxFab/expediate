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

#### ~~FIX-01 · `res.cookie()` overwrites previous cookies~~ ✅ Fixed

`res.cookie()` now accumulates `Set-Cookie` entries into an array instead of
overwriting. Multiple cookies on the same response are preserved correctly.
Three new tests cover the multi-cookie case, chaining, and triple-cookie
accumulation (`tests/router.test.ts`).

---

#### ~~FIX-02 · Async middleware errors are silently swallowed~~ ✅ Fixed

The `listener()` dispatch loop now wraps every middleware call in an `invoke()`
helper that catches both synchronous throws and async rejections, forwarding
both to a shared `handleError()` that sends a 500 response (if the response
has not already been written). A new test in `tests/router.test.ts` covers the
async rejection path.

---

#### ~~FIX-03 · Chunked-transfer-encoding bodies are never read~~ ✅ Fixed

`readBody()` and `readReqBody()` in `src/misc.ts` now detect
`Transfer-Encoding: chunked` and skip the `Content-Length` pre-check when
chunked encoding is in use. The size limit is still enforced by accumulation
during streaming. Six new tests in `tests/misc.test.ts` (Suite 6) cover
`json()`, `formData()`, and `parseBody()` with chunked bodies, including the
size-limit enforcement path.

---

#### ~~FIX-04 · Wrong HTTP method returns 404 instead of 405~~ ✅ Fixed

The `listener()` now tracks, for each visited layer, whether the path matched
but the method did not. After the full walk, if any such layer was found the
router responds `405 Method Not Allowed` with an `Allow` header listing every
method that IS registered for that path. Tests updated in `tests/router.test.ts`
(the broken `for...in` loop corrected to `for...of`, expected status updated
from 400 → 405) and two new tests added for the `Allow` header content.

---

### 🟠 High

#### ~~FIX-05 · Signed cookies are non-functional~~ ✅ Fixed

`createRouter()` now accepts a `{ secret }` option. When `res.cookie()` is
called with `{ signed: true }`, the value is HMAC-SHA256 signed using the
router secret and serialised as `s:<value>.<base64url-signature>`. Calling
`res.cookie()` with `{ signed: true }` when no secret was provided throws
immediately (caught by `invoke()` → 500 response). Three new helper functions
(`signCookieValue`, `verifyCookieValue`, `decodeJsonCookie`) are implemented
in `src/router.ts`. The `RouterOptions` type is exported from `src/index.ts`.
`CookieOptions` also gains `httpOnly`, `secure`, and `sameSite` attributes.
Eight new tests in `tests/router.test.ts` cover write format, round-trip,
signed-JSON round-trip, tamper detection, cross-secret rejection, missing-secret
error, and the new `httpOnly`/`secure`/`sameSite` header attributes.

---

#### ~~FIX-06 · Cookie reading ignores `j:` and `s:` prefixes~~ ✅ Fixed

The cookie parser in `updateHttpObjects()` now decodes cookies on read:
- `j:` prefix → JSON-parsed; result is the JS value (object, array, etc.).
- `s:` prefix + router secret → HMAC-verified; on success the inner value
  (possibly `j:`-encoded) is decoded; on failure the cookie is silently omitted.
- `s:` prefix without a router secret → raw value preserved as-is.
- `req.cookies` type updated to `Record<string, unknown>` to accommodate
  non-string JSON values. Four new tests cover each decode path.

---

#### ~~FIX-07 · `apiBuilder` `setup()` is not awaited when async~~ ✅ Fixed

**File:** `src/apis.ts` — `buildModule()`

`service.setup.apply(instance, [])` discards the returned `Promise`. Async
setup work (e.g. loading a database, reading a config file) will not have
completed when the first request arrives, silently serving stale state.

**Fix:** `buildModule` should return a `Promise<TInstance>` and `apiBuilder`
should chain route registration after it resolves. Add a `notReady` guard in
the interim, or document the `throwIfNotReady()` pattern prominently.

---

#### ~~FIX-08 · Refresh token store grows without bound~~ ✅ Fixed

**File:** `src/jwt-auth.ts` — `DEFAULT_CONFIG`

The default `refreshTokenStore` is an in-process `Map` that is never pruned.
Expired tokens remain in memory indefinitely, causing a slow memory leak in
long-running servers.

**Fix:** add a periodic cleanup (via `setInterval`) that removes entries whose
`expiresAt` is in the past, or replace the default store with an LRU/TTL-aware
structure.

---

#### ~~FIX-09 · `req.json()` rejects with an inconsistent error shape~~ ✅ Fixed

`readReqBody()` in `src/misc.ts` and the `req.json()` extension method in
`src/router.ts` now consistently reject with `{ status, message }` (was
`{ status, message }`). All five rejection sites in `readReqBody` and the
catch path in `req.json()` were updated. Additionally, `req.text()` and
`req.formData()` extension methods were added alongside `req.json()`, all
sharing the same `{ status, message }` rejection shape. Tests added in
`tests/router.test.ts` (Suite 15) verify the rejection shape for all three
methods.

---

### 🟡 Medium

#### ~~FIX-10 · `BodyOptions.strict` is documented but never enforced~~ ✅ Fixed

`readBodyAsJson()` in `src/misc.ts` now checks, after `JSON.parse`, whether
`opts.strict` is true and the result is not an object or array. Bare primitives
(strings, numbers, booleans, null) produce a 400 Bad Request response. JSON
parse errors also changed from 500 to 400 (client error). Eight new tests
cover the strict-mode accept/reject matrix and the 400-on-invalid-JSON case
(`tests/misc.test.ts` Suite 7).

---

#### ~~FIX-11 · Directory listing is not sorted~~ ✅ Fixed

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

#### ~~FIX-13 · Incomplete JSDoc on `gitCreate`~~ ✅ Fixed

**File:** `src/git.ts` — `gitCreate()`

The function has placeholder JSDoc with empty `@param` and `@returns` tags,
making the generated `.d.ts` documentation unhelpful.

**Fix:** fill in `@param gitDirectory`, `@param opt`, and `@returns`.

---

#### ~~FIX-14 · `refreshTokenSecret` is a no-op config field~~ ✅ Fixed

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

#### ~~FEAT-01 · `application/x-www-form-urlencoded` body parser~~ ✅ Implemented

`formEncoded(opts?)` middleware added to `src/misc.ts` and exported from
`src/index.ts`. Repeated keys (`tag=a&tag=b`) produce array values
(`{ tag: ['a', 'b'] }`); single-occurrence keys remain plain strings.
`parseBody()` and the `BODY_READERS` dispatch table were updated to handle this
MIME type automatically. Eight new tests in `tests/misc.test.ts` (Suite 8)
cover simple key/value, arrays, percent-encoding, size limits, and the
auto-detection path via `parseBody()`.

---

#### ~~FEAT-02 · Graceful shutdown~~ ✅ Fixed

There is no way to shut down the server cleanly: drain in-flight requests,
stop accepting new connections, and wait for all handlers to complete. This is
a basic production requirement for container-based deployments.

**Proposal:** expose the underlying `http.Server` from `listen()` (see FIX-12)
and add an optional `router.shutdown(timeout?)` helper that calls
`server.close()` and forcibly destroys idle sockets after the timeout.

---

#### ~~FEAT-03 · Request query-string array support~~ ✅ Implemented

`req.queries.url` type changed from `StringMap` to `Record<string, string | string[]>`.
The parsing loop in `updateHttpObjects()` now accumulates repeated keys into
arrays. The flat `req.params` map retains StringMap semantics by using the first
value for any repeated key. Five new tests in `tests/router.test.ts` (Suite 14)
cover single keys, two-value arrays, three-value arrays, flat-params first-value
semantics, and mixed distinct/repeated keys.

---

#### ~~FEAT-04 · Global error handler hook~~ ✅ Fixed

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

#### ~~FEAT-05 · Response compression middleware~~ ✅ Fixed

There is no way to gzip/brotli-compress response bodies. All responses are sent
uncompressed, which is a significant performance and bandwidth problem for text
content (HTML, JSON, CSS).

**Proposal:** add a `compress(opts?)` middleware that honours the client's
`Accept-Encoding` header and pipes the response through `zlib.createGzip()` or
`zlib.createBrotliCompress()`.

---

### 🟠 High

#### ~~FEAT-06 · Router base path (prefix)~~ ✅ Fixed

Registering a sub-router always requires spelling out the full prefix on every
call. There is no way to create a router that is inherently scoped to a base path.

**Proposal:**

```ts
const v1 = createRouter('/api/v1');
v1.get('/users', handler); // matches /api/v1/users
app.use(v1);
```

---

#### ~~FEAT-07 · `next(err)` error propagation~~ ✅ Fixed

`NextFunction` is `() => void`. Express-style `next(err)` — where passing an
argument skips remaining middleware and routes to the error handler — is not
supported.

**Proposal:** change `NextFunction` to `(err?: unknown) => void` and route
non-null arguments directly to the error handler registered via FEAT-04.

---

#### ~~FEAT-08 · `req.ip` and proxy trust~~ ✅ Fixed

The logger reads `X-Forwarded-For` directly, but no other part of the framework
exposes the client IP in a consistent, configurable way. In a reverse-proxy
setup the raw socket address is always the proxy, not the client.

**Proposal:** add a `trustProxy` option to the router; when enabled, expose
`req.ip` as the first `X-Forwarded-For` value. When disabled, use the raw
socket address.

---

#### ~~FEAT-09 · Request ID middleware~~ ✅ Fixed

Distributed tracing and log correlation require a unique request ID attached to
every request. Today this must be implemented ad-hoc by every application.

**Proposal:** add a `requestId(opts?)` middleware that attaches `req.id` (either
from an incoming `X-Request-ID` header or a generated UUID) and echoes it back
in the response `X-Request-ID` header.

---

#### ~~FEAT-10 · `res.download(filepath, filename?)` helper~~ ✅ Fixed

There is no convenient way to serve a file as an attachment (i.e. prompt the
browser to download it). The workaround requires setting `Content-Disposition`
manually and then calling `sendFile`.

**Proposal:** add `res.download(filepath, filename?)` that sets
`Content-Disposition: attachment; filename="..."` and streams the file.

---

#### ~~FEAT-11 · Multipart streaming (large file uploads)~~ ✅ Implemented

`streamFormData(req, opts?)` async generator function added to `src/misc.ts`
and exported from `src/index.ts`. It reads the full body via `for await` over
the raw request, splits on the multipart boundary using the existing
`parseMultipartBody()` helper, and yields `{ headers, stream: Readable }` per
part (content exposed as a `Readable.from(buffer)` stream). Note: the body is
still fully buffered before parts are yielded; true non-buffered streaming would
require a more complex incremental parser. `parseMultipartBody()` was extracted
from `readBodyAsFormData()` and exported for reuse. Four new tests in
`tests/misc.test.ts` (Suite 9) cover part count, content streaming, lowercased
headers, and the 413 size-limit throw.

---

#### ~~FEAT-12 · Route introspection~~ ✅ Fixed

There is currently no way to enumerate the routes registered on a router — not
for debugging, not for generating documentation, and not for OpenAPI generation.

**Proposal:** expose `router.routes()` returning the internal `Layer[]` array
(or a sanitised summary), so tooling can inspect registered paths and methods.

---

### 🟡 Medium

#### ~~FEAT-13 · ESM / dual-package build~~ ✅ Fixed

The package is CommonJS-only (`"type": "commonjs"`). Modern Node.js projects
(and Bun, Deno) increasingly use ESM. A dual CJS+ESM build (or an ESM-first
build with a CJS shim) would make the package usable without import workarounds.

**Proposal:** add a second `tsconfig.esm.json` targeting `NodeNext` modules
with `moduleResolution: bundler` and publish both under the `exports` field in
`package.json`.

---

#### ~~FEAT-14 · `res.type(mimeType)` convenience helper~~ ✅ Fixed

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

#### ~~FEAT-16 · JWT algorithm expansion (RS256 / ES256)~~ ✅ Fixed

Only HMAC algorithms (`HS256`, `HS384`, `HS512`) are supported. Asymmetric
algorithms (`RS256`, `ES256`) are needed for distributed systems where the
token is verified by a service that should not know the signing secret.

**Proposal:** add `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512` to
`JwtAlgorithm` using Node.js `crypto.sign()`/`crypto.verify()` with PEM keys.

---

#### ~~FEAT-17 · Persistent / pluggable refresh token store~~ ✅ Fixed

The default token store is an in-memory `Map` — not suitable for multi-instance
deployments (tokens issued on instance A are invisible to instance B). While
`JwtConfig.refreshTokenStore` is already pluggable, there is no documented
adapter pattern or example implementation.

**Proposal:** document the `TokenStore` interface clearly and provide a
reference Redis adapter (optionally, as a separate optional peer dependency or
an example in the README).

---

#### ~~FEAT-18 · Built-in request timeout~~ ✅ Fixed

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

#### ~~NTH-01 · OpenAPI / Swagger spec generation~~ ✅ Fixed

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

#### ~~NTH-03 · HTTP/2 support~~ ✅ Fixed

The `listen()` helper hard-codes `http.createServer` / `https.createServer`.
HTTP/2 (`http2.createSecureServer`) is not available at all.

**Proposal:** add an `http2` flag to `TlsOptions` that switches to
`http2.createSecureServer()`. The existing middleware API is already compatible
with HTTP/2's request/response objects.

---

#### ~~NTH-04 · Rate limiting middleware~~ ✅ Fixed

No built-in protection against request floods. Applications must integrate a
third-party library (which conflicts with the zero-dependency philosophy).

**Proposal:** add a `rateLimit({ windowMs, max, keyBy? })` middleware factory
using an in-memory sliding window counter — no external dependency required.

---

#### ~~NTH-05 · Response caching middleware~~ ✅ Fixed

A `cacheControl(opts)` middleware that sets `Cache-Control`, `Expires`, and
`Vary` headers on responses based on configurable rules would simplify CDN
integration.

---

#### ~~NTH-06 · CSRF protection middleware~~ ✅ Fixed

Session-based applications need CSRF token generation and validation. A
lightweight `csrf()` middleware using the synchronizer-token pattern (or
double-submit cookie) would make expediate suitable for server-rendered apps.

---

#### ~~NTH-07 · Helmet-style security headers middleware~~ ✅ Fixed

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

#### ~~NTH-09 · `router.all('*', notFoundHandler)` catch-all convention~~ ✅ Fixed

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
|~~FIX-01~~| Bug         | ✅       | `res.cookie()` overwrites previous cookies      |
|~~FIX-02~~| Bug         | ✅       | Async middleware errors unhandled               |
|~~FIX-03~~| Bug         | ✅       | Chunked-encoding bodies never read              |
|~~FIX-04~~| Bug         | ✅       | Wrong method returns 404 instead of 405         |
|~~FIX-05~~| Bug         | ✅       | Signed cookies non-functional                   |
|~~FIX-06~~| Bug         | ✅       | Cookie reading ignores `j:`/`s:` prefixes       |
|~~FIX-07~~| Bug         | ✅       | `async setup()` not awaited in apiBuilder       |
|~~FIX-08~~| Bug         | ✅       | Refresh token store grows without bound         |
|~~FIX-09~~| Bug         | ✅       | `req.json()` rejects with wrong error shape     |
|~~FIX-10~~| Bug         | ✅       | `BodyOptions.strict` not enforced               |
|~~FIX-11~~| Bug         | ✅       | Directory listing unsorted                      |
|~~FIX-12~~| Bug         | ✅       | `listen()` exposes no server handle             |
|~~FIX-13~~| Bug         | ✅       | Incomplete JSDoc on `gitCreate`                 |
|~~FIX-14~~| Bug         | ✅       | `refreshTokenSecret` is a no-op field           |
|~~FEAT-01~~| Feature    | ✅       | `application/x-www-form-urlencoded` parser      |
|~~FEAT-02~~| Feature    | ✅       | Graceful shutdown                               |
|~~FEAT-03~~| Feature    | ✅       | Query-string array support                      |
|~~FEAT-04~~| Feature    | ✅       | Global error handler hook                       |
|~~FEAT-05~~| Feature    | ✅       | Response compression middleware                 |
|~~FEAT-06~~| Feature    | ✅       | Router base path / prefix                       |
|~~FEAT-07~~| Feature    | ✅       | `next(err)` error propagation                   |
|~~FEAT-08~~| Feature    | ✅       | `req.ip` and proxy trust setting                |
|~~FEAT-09~~| Feature    | ✅       | Request ID middleware                           |
|~~FEAT-10~~| Feature    | ✅       | `res.download()` helper                         |
|~~FEAT-11~~| Feature    | ✅       | Multipart streaming for large uploads           |
|~~FEAT-12~~| Feature    | ✅       | Route introspection (`router.routes()`)         |
|~~FEAT-13~~| Feature    | ✅       | ESM / dual-package build                        |
|~~FEAT-14~~| Feature    | ✅       | `res.type()` convenience helper                 |
| FEAT-15  | Feature     | 🟡       | Path parameter type constraints                 |
|~~FEAT-16~~| Feature    | ✅       | JWT asymmetric algorithm support                |
|~~FEAT-17~~| Feature    | ✅       | Documented pluggable refresh token store        |
|~~FEAT-18~~| Feature    | ✅       | Built-in request timeout                        |
|~~NTH-01~~| Nice-to-have| ✅       | OpenAPI / Swagger spec generation               |
| NTH-02   | Nice-to-have| —        | WebSocket upgrade support                       |
|~~NTH-03~~| Nice-to-have| ✅       | HTTP/2 support                                  |
|~~NTH-04~~| Nice-to-have| ✅       | Rate limiting middleware                        |
|~~NTH-05~~| Nice-to-have| ✅       | Response caching middleware                     |
|~~NTH-06~~| Nice-to-have| ✅       | CSRF protection middleware                      |
|~~NTH-07~~| Nice-to-have| ✅       | Helmet-style security headers middleware        |
| NTH-08   | Nice-to-have| —        | ETag / conditional-GET for dynamic responses    |
|~~NTH-09~~| Nice-to-have| ✅       | Documented 404 override pattern                 |
| NTH-10   | Nice-to-have| —        | CLI scaffold (`npx expediate init`)             |
| NTH-11   | Nice-to-have| —        | Request body schema validation hook             |
| NTH-12   | Nice-to-have| —        | Cluster / multi-process helper                  |
