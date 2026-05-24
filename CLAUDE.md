# CLAUDE.md — Expediate Project Reference

This file captures architectural knowledge, non-obvious design decisions, known
limitations, and development patterns for the **expediate** package. It is
intended for future conversations — read this before touching any source file.

---

## 1. Project Overview

**Expediate** is a zero-dependency TypeScript HTTP server framework with an
Express-compatible API surface. It wraps Node.js built-in `http`/`https` modules
only. There are no runtime npm dependencies whatsoever.

- **Package type:** ESM-first (`"type": "module"`) with a CJS compatibility shim
- **Version:** 1.0.4
- **Build:** `tsc` (ESM) + `node scripts/build-cjs.cjs` (CJS bundle via esbuild) → outputs to `./dist/`
- **Test runner:** `node --import tsx --test 'tests/*.test.ts'`
- **TypeScript version:** 5.9.3 (strict mode, isolatedModules, esModuleInterop)
- **tsconfig target:** ESNext, module NodeNext
- **Outputs:**
  - ESM: `.js`, `.d.ts`, `.d.ts.map`, `.js.map` files in `dist/` (tree-shakeable, one file per module)
  - CJS: single bundled `dist/cjs/index.js` + `dist/cjs/package.json` (`{"type":"commonjs"}`)

Source files live in `src/`. Only `src/**/*` is compiled (tsconfig.json).
Test files in `tests/` use `tsx` at runtime and are never compiled.

---

## 2. Module Map

| Source file       | Exports (from `src/index.ts`)                                              |
|-------------------|----------------------------------------------------------------------------|
| `router.ts`       | `createRouter`, types: `Router`, `RouterOptions`, `RouterRequest`, `RouterResponse`, `Middleware`, `MiddlewareArg`, `NextFunction`, `ErrorHandler`, `Layer`, `RouteInfo`, `CookieOptions`, `TlsOptions`, `StringMap` |
| `static.ts`       | `serveStatic`, `serveFile`, `sendFile`, `mime`, types: `StaticOptions`, `Mime` |
| `misc.ts`         | `json`, `formData`, `formEncoded`, `parseBody`, `streamFormData`, `logger`, `cors`, `parseMultipartBody`, types: `BodyOptions`, `LoggerOptions`, `FormPart`, `FormPartStream` |
| `middleware.ts`   | `compress`, `requestId`, `rateLimit`, `cacheControl`, `csrf`, `securityHeaders`, `conditionalGet`, types: `CompressOptions`, `RequestIdOptions`, `RateLimitOptions`, `CacheControlOptions`, `CsrfOptions`, `SecurityHeadersOptions` |
| `jwt-auth.ts`     | `createJwtPlugin`, `createMapTokenStore`, types: `JwtPlugin`, `JwtConfig`, `TokenStore`, `RefreshTokenRecord` |
| `git.ts`          | `gitHandler`, `gitCreate`, types: `GitHandlerOptions`                      |
| `apis.ts`         | `apiBuilder`, types: `ApiError`, `ServiceMethod`, `ServiceInstance`, `ServiceMethods`, `RouteMap`, `ServiceDefinition`, `ApiRouter`, `ApiRouterExtensions` |
| `openapi.ts`      | `describe`, `openApiSpec`, `serializeSpec`, `DESCRIBE_META`, types: `JsonSchema`, `ParameterObject`, `RequestBodyObject`, `ResponseObject`, `OperationMeta`, `OpenApiServiceMeta`, `SpecOptions`, `SpecFormat`, `OpenApiDocument` |

Note: `cors` is exported from `misc` but **not documented in the README**. `extractCharset`
and `readReqBody` are exported from `misc.ts` directly but not re-exported through `index.ts` —
they are implementation details also used by `router.ts`.

---

## 3. Core Router (`src/router.ts`)

### Path pattern compilation

Three strategies, chosen automatically by `compilePattern()`:

1. **Glob string** — contains `*` or `?` (unescaped) → `compileGlob()`
   - `?` → `[^/]` (one non-slash char)
   - `*` → `[^/]*` (any non-slash chars, zero or more)
   - `**` → `.*` (any chars including slashes — cross-segment)
   - Result is anchored at `^`, no `$` (prefix match)

2. **Plain string** — no wildcards → `compilePlainPath()`
   - Segments starting with `:` become named capture groups `(?<name>[^/]+)`
   - **Inline regex constraints** — `:name(pattern)` replaces the default `[^/]+` body with the given pattern: `:id(\d+)` → `(?<id>\d+)`. A literal suffix after the closing `)` is regex-escaped and appended (e.g. `:id(\d+)px` → `(?<id>\d+)px`). Named capture groups inside constraints are rejected at registration time (they conflict with the outer wrapper).
   - Literal segments are regex-escaped
   - Pattern ends with `(?=/|$)` to avoid partial segment matches (so `/users` does NOT match `/users-admin`)
   - Anchored at `^`
   - `isGlobPattern()` walks character-by-character and explicitly skips over `:name(constraint)` balanced-paren blocks so regex metacharacters (`?`, `*`) inside constraints are never mistaken for glob wildcards

3. **RegExp** — used as-is; named capture groups become `req.params`

### `use()` vs `all/get/post/…` — the critical difference

This is the **most important design detail** in the whole codebase:

- **`use(path, mw)`** → `stripPath: true` — the matched prefix is removed from
  `req.path` before the middleware runs. Nested routers only see the remaining
  suffix. Path is **restored** after the sub-router calls `done()`.

- **`all/get/post/put/delete/patch(path, mw)`** → `stripPath: false` — `req.path`
  is left intact so multiple chained middlewares for the same path each see the
  full unmodified path.

The path restoration logic is in the `listener` function of `createRouter()`:

```ts
const pathBefore = req.path;
if (layer.stripPath) {
  return layer.middleware(req, res, () => {
    req.path = pathBefore;  // restore for the next sibling
    next();
  });
}
```

Without this restoration, sibling layers registered after a `use()` sub-router
would see a truncated path and fail their own pattern matches.

### Request augmentation (`updateHttpObjects`)

Called at the start of every `listener` invocation. **Idempotent** — checks
`rReq.queries` and exits early if already set (important for nested routers
sharing the same request object).

Fields added to `req`:
- `originalUrl` — the raw URL string, never modified
- `path` — pathname portion of the URL; modified by `use()` layers
- `params` — merged map (URL query params first, then named route params on match)
- `queries` — structured object `{ url?: StringMap, route?: StringMap }`
- `cookies` — parsed from `Cookie` header (signed cookies verified with HMAC-SHA256 when `secret` is set)
- `ip` — remote client IP; respects `X-Forwarded-For` when `trustProxy: true`
- `json(opts)` — Promise-based JSON body reader (uses `readReqBody` from misc.ts)
- `text(opts)` — Promise-based plain-text body reader
- `formData(opts)` — Promise-based multipart/form-data body reader

Fields added to `res`:
- `send(data?)` — writes data and calls `res.end()`
- `json(data)` — serialises to JSON and ends
- `status(code, headers?)` — sets status code and optional headers, **returns `this`** for chaining
- `redirect(url)` — 302 with `location` header
- `cookie(name, val, opts)` — appends `Set-Cookie` header, **returns `this`** for chaining
- `download(filepath, filename?)` — sets `Content-Disposition: attachment` then streams the file
- `type(mime)` — sets `Content-Type` header, **returns `this`** for chaining
- `etag(value, strong?)` — sets `ETag` header (`W/"value"` weak by default, `"value"` when `strong=true`), **returns `this`** for chaining

The `X-Powered-By: Expediate` header is set on every response in `updateHttpObjects`.

### Cookie helpers

- Cookie **reading**: `j:` prefixed values are JSON-parsed. `s:` prefixed values are HMAC-SHA256 verified against the router secret when `secret` is configured in `createRouter()`; cookies that fail verification are silently dropped.
- Cookie **writing**: objects get `j:` prefix. `opts.signed = true` triggers HMAC-SHA256 signing (requires `secret` on the router).

### Error handling in `listener`

The `invoke()` helper catches both synchronous throws and async rejections:

```ts
const invoke = (mw: Middleware, nextFn: NextFunction): void => {
  try {
    const ret = mw(req, res, nextFn) as unknown;
    if (ret instanceof Promise) ret.catch(invokeErrorHandler);
  } catch (e) {
    invokeErrorHandler(e);
  }
};
```

A custom error handler registered with `router.onError(handler)` receives the error. Without one, a 500 response is sent. The `next(err)` calling convention skips remaining routes and invokes the error handler directly.

### `router.listen()` signature

```ts
listen(port: number, opts?: TlsOptions | (() => void), cb?: () => void):
  http.Server | https.Server | http2.Http2SecureServer
```

When `opts` is a function it is treated as the callback. HTTPS is used when `opts.key` and `opts.cert` are present. HTTP/2 is used when `opts.http2 = true`. **Returns the underlying server instance** — use it for port discovery (`server.address()`), graceful shutdown, or attaching extra event listeners.

---

## 4. Body Parsing (`src/misc.ts`)

### Middleware factories

Three public factories, all accepting `BodyOptions`:

- **`json(opts?)`** — strict `application/json` only → `req.body` is parsed JS value. Also attaches `res.json(data)` helper (note: router.ts also attaches `res.json` in `updateHttpObjects`, so it's idempotent).
- **`formData(opts?)`** — `multipart/form-data` → `req.body` is `FormPart[]`. Each `FormPart` has `headers: Record<string,string>` and `content: Buffer`.
- **`parseBody(opts?)`** — auto-detects MIME type; supports `application/json`, `multipart/form-data`, `text/plain`.

### `BodyOptions`

```ts
interface BodyOptions {
  inflate?: boolean;      // default: true  — accept gzip/deflate
  limit?:   string|number; // default: '100kb'
  reviver?: Reviver|null; // default: null  — JSON.parse reviver
  strict?:  boolean;      // default: true  — reserved, NOT YET ENFORCED
}
```

`strict` is documented as restricting JSON to top-level objects/arrays, but
the enforcement is not implemented yet (see TODO comment in code).

### Size parsing (`readSize`)

Parses strings like `'100kb'`, `'2mb'`, `'1gb'` (case-insensitive). Returns `0`
on parse failure, which causes the code to fall back to `102_400` bytes (100 KB).

### Compression

Only `gzip` and `deflate` are supported. Unknown `Content-Encoding` values
produce 415 when `inflate: true`.

### Multipart boundary parsing

- Wire delimiter is `\r\n--${boundary}` (not just `--${boundary}`)
- Binary-safe: uses `splitBuffer()` which operates on raw `Buffer`
- The first part is handled by prepending `\r\n` to the body before splitting
- Parts with missing `\r\n\r\n` separator are silently skipped

### `logger()` options

All options are optional. Key fields:

```ts
{
  track:        boolean;                    // per-request timeout tracking
  trackTimeout: number;                     // ms (default: 30_000)
  user:         (req) => string;            // identity extraction
  locale:       string;                     // Intl.DateTimeFormat locale
  dateFormat:   Intl.DateTimeFormatOptions;
  json:         boolean;                    // structured JSON logging (undocumented in README)
  logger:       (msg: string|object) => void; // custom log fn
}
```

When `json: true`, the logger calls `log({timestamp, status, method, path, ip,
user, elapsed, host, length})` instead of a formatted string.

### `cors()` options

```ts
{
  origin:           string | string[];
  allowHeaders:     string | string[];
  allowMethods:     string | string[];
  allowCredentials: boolean | undefined;
  maxAge:           number | undefined;
  vary:             string | string[] | undefined;
  optionsStatus:    number;          // default: 204
  preflight:        ((req) => boolean) | undefined;
}
```

When `preflight` returns `false`, OPTIONS requests get 403, non-OPTIONS get 400.
CORS headers are only set when `req.headers.origin` is present (browser-only).

### Internal helpers not in public API

- `readReqBody(req, opts, mimetype)` → `Promise<{mimetype, content}|null>` — used by `req.json()` attached in router.ts
- `extractCharset(contentType)` → `string` — parses `charset=` from Content-Type header
- Both are exported from `misc.ts` but not from `index.ts`

---

## 5. Static File Serving (`src/static.ts`)

### Functions

- **`serveStatic(root, opts?)`** → middleware that serves files from `root` directory
- **`serveFile(filepath, opts?)`** → middleware that serves a single specific file
- **`sendFile(filepath, req, res)`** → utility that sends a file directly (no middleware wrapping)
- **`mime`** — the MIME type lookup object

### StaticOptions (key fields)

- `fallthrough` — when `true` (default), unmatched paths call `next()` instead of 404
- `dotfiles` — `'allow'` | `'deny'` | `'hide'` (default: `'deny'`)
- `headers` — additional response headers merged with defaults
- `contentType` — override the MIME type
- `index` — index file name (default: `'index.html'`)
- `redirect` — redirect directories to trailing slash (default: `true`)

Default headers include a Content-Security-Policy and `X-Content-Type-Options: nosniff`.

### Conditional GET / HTTP caching

ETags are weak, format: `W/"<size_hex>-<mtime_hex>"`. The router checks:
- `If-None-Match` against the ETag → 304 Not Modified
- `If-Modified-Since` against the file's `mtime` → 304 Not Modified
- `Cache-Control: no-cache` forces full response even when ETag matches

Only GET and HEAD are served; other methods return **405 Method Not Allowed** (with fallthrough to next middleware if enabled).

### Path traversal protection

`UP_PATH_REGEXP = /(\/|^)(\.\.?)(\/|$)/` guards against `..` sequences. The
test file even tests raw injection (`req.path` set to `/../../../../etc/passwd`).

### MIME types

`src/mimetypes.json` is loaded via `require('./mimetypes.json')` — CommonJS.
This is not a generated file; it is committed to the repo.

### Directory listing

`writeIndexOf()` generates an Apache-style HTML directory listing with sortable columns. Sorting is controlled by query parameters:

- `C` — column: `N` (name, default), `M` (mtime), `S` (size)
- `O` — order: `A` (ascending, default), `D` (descending)
- Both `;` and `&` separators are accepted (e.g. `?C=S;O=D` or `?C=S&O=D`)

Directories always sort before files regardless of column or direction. Column header links toggle the sort direction when clicked (active column) or default to ascending (inactive column). Invalid `C`/`O` values silently fall back to name/ascending.

---

## 6. JWT Authentication (`src/jwt-auth.ts`)

### Architecture

The plugin is a factory function returning a `JwtPlugin` object. Everything is
closure-scoped to a single `config` instance.

```ts
const auth = createJwtPlugin({ accessTokenSecret: 'my-secret' });
app.post('/auth/login',   json(), auth.login);
app.post('/auth/refresh', json(), auth.refresh);
app.post('/auth/logout',  json(), auth.logout);
app.get('/me', auth.authenticate, auth.authorize, handler);
app.delete('/admin', ...auth.requireRole('admin'), handler);
app.put('/data',  ...auth.requirePermission('write'), handler);
```

### JWT implementation

Fully manual — no external library:
- Base64URL encode/decode via `Buffer.from(...).toString('base64')` + char replacements
- **HMAC** (`HS256`, `HS384`, `HS512`) — `crypto.createHmac()`, verification with `crypto.timingSafeEqual()`
- **RSA** (`RS256`, `RS384`, `RS512`) — `crypto.createSign/createVerify()` with PEM keys
- **ECDSA** (`ES256`, `ES384`, `ES512`) — `crypto.createSign/createVerify()` with PEM keys; DER-encoded signatures are converted to/from IEEE P1363 format (raw R||S) for standard JWT wire format
- For RS*/ES* algorithms, `accessTokenPrivateKey` and `accessTokenPublicKey` are used instead of `accessTokenSecret`

### Token types

- **Access token**: standard JWT (header.payload.signature), short-lived (default 15 min)
- **Refresh token**: opaque 128-char hex string (64 random bytes), long-lived (default 7 days), stored server-side in a `Map`

`refreshTokenSecret` in `JwtConfig` is **reserved but currently unused**. The
refresh token is opaque, not a JWT.

### Token rotation

`renewAccessToken()` always deletes the old refresh token before issuing a new
pair (rotation). A stolen refresh token can only be used once.

### Scoping of `authenticate`

`authenticate` middleware always **clears `req.user`** at the start, preventing
stale data from leaking across requests. It then calls `next()` silently on
failure — it never rejects the request itself. `authorize` does the rejection
(401). This split design lets you inspect `req.user` optionally.

### `requireRole` and `requirePermission`

Both return `Middleware[]` arrays (two elements: `[authenticate, checker]`) meant
to be spread into route registration:
```ts
app.get('/admin', ...auth.requireRole('admin'), handler);
```

- `requireRole` — user must have **at least one** of the specified roles
- `requirePermission` — user must have **all** of the specified permissions

### Default user database

`userDatabase` (exported) is a `Map<string, UserRecord>` with three demo users:
- `alice` / `password123` — roles: `['admin', 'editor']`, permissions: `['read', 'write', 'delete', 'manage_users']`
- `bob` / `secret456` — roles: `['editor']`, permissions: `['read', 'write']`
- `charlie` / `pass789` — roles: `['viewer']`, permissions: `['read']`

### Password hashing

Default: SHA-256. **Explicitly documented as unsafe for production** in the
source comments. The intent is to replace with bcrypt/argon2.

### Re-exported internals

`signToken` and `verifyToken` are re-exported from `jwt-auth.ts` for testing and
advanced use:
```ts
export { signToken, verifyToken, hashPassword as _hashPassword };
```

---

## 7. API Builder (`src/apis.ts`)

### Purpose

`apiBuilder(service)` returns a pre-configured `Router` for a "service" — an
object that combines state, helper methods, and HTTP route handlers.

### Service definition structure

```ts
interface ServiceDefinition<TInstance> {
  scope?:   (req) => string | null;  // scoping strategy
  data?:    (key) => TInstance;      // factory for initial state
  setup?:   (this: TInstance) => void | Promise<void>;
  methods?: ServiceMethods<TInstance>;
  GET?:     RouteMap<TInstance>;
  POST?:    RouteMap<TInstance>;
  PUT?:     RouteMap<TInstance>;
  DELETE?:  RouteMap<TInstance>;
  PATCH?:   RouteMap<TInstance>;
}
```

### Scoping modes

| `scope` field          | Behaviour                                             |
|------------------------|-------------------------------------------------------|
| Absent (no `scope`)    | **Singleton** — one global instance for all requests  |
| Returns `string`       | **Keyed** — one instance per key, cached in `modules` |
| Returns `null`         | **Ephemeral** — fresh instance per request, discarded |

Singleton key in the cache map is `'singleton'` (literal string).

### `buildModule` lifecycle

1. `data(key)` — creates state object (or `{ $key: key }` if no `data`)
2. Methods mixed in — each `service.methods[name]` is copied as a regular function with `apply(instance, args)` (NOT arrow functions — this was a past bug)
3. `setup()` — called synchronously; if async, the Promise is NOT awaited

The async `setup()` issue means you need a "not ready" pattern in methods:
```ts
setup: async function() {
  // do async init
  this.ready = true;
},
methods: {
  throwIfNotReady() {
    if (!this.ready) throw { status: 503, message: 'Not ready' };
  }
}
```

### Route handler conventions

- **Truthy return value** → JSON response, status 200
- **Falsy return value** (`undefined`, `null`, `false`, `0`, `''`) → 201 No Content
- **Throw / reject with `ApiError`** → HTTP error response:
  ```ts
  interface ApiError {
    status?: number;  // default: 500
    data?:       unknown; // JSON body (takes precedence over message)
    message?:    string;  // plain text body
  }
  ```

### Route specificity sorting

Routes within each HTTP method are sorted before registration:

```
score(path) = (segment_count * 100) - (param_count * 10)
```

Higher score = registered first = wins priority. `/items` (score 100) is
registered before `/items/:id` (score 90). This prevents prefix-match collisions.

### Mounting note

`apiBuilder` returns a `Router`. Mount it with `app.use('/prefix', apiBuilder(...))` —
**not** `app.get()`. If you mount without `use()`, the path prefix is NOT
stripped and route patterns must be absolute. (Tests use `app.use('/', api)`
intentionally to avoid this stripping affecting route resolution in tests.)

### Body access

Service methods receive `body` as `(req as any).body` — a body-parsing middleware
(`json()` etc.) must run before the route handler for `body` to be populated.

---

## 8. Git Smart HTTP (`src/git.ts`)

### Supported endpoints

| Method | Path              | Service            | Purpose                        |
|--------|-------------------|--------------------|--------------------------------|
| GET    | `/info/refs`      | `git-upload-pack`  | Capability advertisement       |
| GET    | `/info/refs`      | `git-receive-pack` | Push capability advertisement  |
| POST   | `/git-upload-pack`| `git-upload-pack`  | Pack negotiation and transfer  |
| POST   | `/git-receive-pack`|`git-receive-pack` | Push pack transfer             |

### PKT-LINE format

```
pktLine(str) = padStart(4, '0') hex of (str.byteLength + 4) + str
PKT_FLUSH    = '0000'
```

Flush packet signals end of a PKT-LINE list. The `GET /info/refs` response
starts with a service banner PKT-LINE then a flush, then the `git-upload-pack`
output piped directly.

### `gitHandler(opt)` config

```ts
interface GitHandlerOptions {
  repository: (req) => string | null | undefined | false;  // REQUIRED
  gitPath?:   string;   // directory prefix for git binaries (with trailing /)
  strict?:    boolean;  // --strict / --no-strict (default: false = --no-strict)
  timeout?:   number | string;  // seconds for --timeout=N
}
```

`buildArgs()` constructs the argument list for `git-upload-pack` only (not for
`git-receive-pack` — receive-pack just gets `[gitDirectory]`).

### `gitCreate(gitDirectory, opt)` → `Promise<void>`

Runs `git init --bare` and optionally writes a description file. Used for
programmatic repository creation.

### Error handling

- Spawn errors → 500
- Non-zero exit codes → 500
- `EPIPE` on stdin is silently ignored (client disconnect mid-stream)
- gzip-encoded POST bodies are decompressed transparently via `zlib.createGunzip()`

### Test fixtures

Git tests use `tests/fixtures/git-repo.git.zip` which is extracted to a
temporary directory. The end-to-end `git clone` test is commented out (requires
git in the test environment).

---

## 9. Middleware (`src/middleware.ts`)

Seven middleware factories, all exported from `src/index.ts`. Each uses the standard `(req, res, next)` signature and imports types from `router.ts` only (no circular dependencies).

### Module augmentation

`middleware.ts` extends the `RouterRequest` interface with fields set by specific middleware:

```ts
declare module './router.js' {
  interface RouterRequest {
    id?:         string;          // set by requestId()
    csrfToken?:  () => string;    // set by csrf()
  }
}
```

### `compress()`

Overrides `res.write` and `res.end` to buffer body data. At `end()` time, if total body ≥ `threshold`, a compressor stream (Brotli > gzip > deflate) is selected and data is flushed through it. Below threshold, data is written directly. `Content-Length` is removed; `Content-Encoding` and `Vary: Accept-Encoding` are set.

### `requestId()`

Reads the configured header from `req.headers`; if `allowFromHeader` is `true` and a value is present it is reused, otherwise `generator()` is called. Sets `req.id` and echoes the ID in the response header.

### `rateLimit()`

Maintains a `Map<key, number[]>` of request timestamps per client. On each request the list is pruned to the current window, then the count is checked against `max`. `X-RateLimit-*` headers are set when `headers: true`.

### `cacheControl()`

Pre-computes the `Cache-Control` string and `Vary` value once at factory time. On each request it sets the headers and always calls `next()`.

### `csrf()`

Double-submit cookie pattern. Reads (or generates) a 256-bit hex token from the cookie, attaches `req.csrfToken()`, then validates the submitted value for state-mutating requests. The cookie is **not** `HttpOnly` so client JavaScript can read it.

### `securityHeaders()`

Pre-computes all header name/value pairs at factory time. On each request it sets them via a `for` loop and always calls `next()`.

### `conditionalGet()`

Overrides `res.write` (buffer to `pending[]`) and `res.end` (check freshness, send 304 or flush buffer). Only GET and HEAD requests participate. Freshness is checked via `isFreshResponse()` using weak ETag comparison per RFC 7232. A 304 response strips `Content-Type`, `Content-Length`, and `Content-Encoding`, retaining `ETag`, `Cache-Control`, `Vary`, `Last-Modified`.

`res.etag(value, strong?)` is implemented in `router.ts` `updateHttpObjects` (not in `middleware.ts`) because it belongs with the other `res.*` helpers. `middleware.ts` reads the header that `res.etag()` sets.

---

## 10. Test Harness and Patterns

### Test runner

Node.js built-in `node:test` (no external framework). Run with:
```bash
node --import tsx --test 'tests/*.test.ts'
```

### Custom `describe`/`it` shim

All test files use a shared pattern:
```ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
```

The harness is Node's native test module — no Jest, no Mocha. `assert.equal`,
`assert.deepEqual`, `assert.ok` etc. from `node:assert`.

### HTTP testing pattern

Tests spin up **real HTTP servers on port `0`** (OS assigns a random free port):
```ts
const server = http.createServer(router.listener as any);
server.listen(0);
const { port } = server.address() as AddressInfo;
// ... make requests with fetch or http.request ...
server.close();
```

No mocking of HTTP. This catches real behaviour including header casing, chunked
encoding, and streaming.

### `requestRouter` pattern in apis tests

`apis.test.ts` mounts the API router at `'/'` with `app.use('/', api)` — NOT at
a sub-path. This avoids path-stripping interference with the route patterns
defined in the service definition.

### LOST tracking in logger tests

Tests for `logger()` set `track: true` with a very short `trackTimeout` to
verify the LOST warning fires. They assert `console.log` was called with a line
containing `'LOST'`.

### Test file structure

| Test file             | Test suites                                                             |
|-----------------------|-------------------------------------------------------------------------|
| `router.test.ts`      | compilePlainPath (incl. inline constraints), compileGlob, RegExp, methods, chain, sub-router, URL parsing, cookies, response helpers, registerRoute errors, edge cases |
| `misc.test.ts`        | json(), formData(), formEncoded(), parseBody(), streamFormData(), readSize (via limit), logger(), chunked transfer, strict mode |
| `middleware.test.ts`  | compress(), requestId(), rateLimit(), cacheControl(), csrf(), securityHeaders(), conditionalGet() |
| `apis.test.ts`        | singleton/keyed/ephemeral, buildModule, return conventions, error handling, route params, HTTP verbs, multiple routes, async setup |
| `static.test.ts`      | validation, basic serving, security headers, caching (304/ETag), method filter, dot-files, traversal, directory redirect, contentType, fallthrough, serveFile, sendFile, ETag stability, concurrency, writeIndexOf sorting |
| `jwt-auth.test.ts`    | hashPassword, signToken/verifyToken (HS*, RS*, ES*), login, refresh (rotation), logout, authenticate, authorize, requireRole, requirePermission, custom config, security edge cases |
| `git.test.ts`         | factory validation, pktLine, GET /info/refs, POST /git-upload-pack, repository callback, options (strict/timeout/gitPath), unrecognised routes |
| `openapi.test.ts`     | describe(), openApiSpec(), serializeSpec(), YAML output, path parameters, request/response schemas |

### Known test quirk

In `router.test.ts` there is a comment: `// 400 Or 404, wierd thing going on here` for the case where a wrong HTTP method is used. The router falls through to a
404 when no route matches — it does NOT return 405. This is a deliberate (if
imperfect) design.

---

## 11. Known Issues and TODOs

Open items identified from source comments:

1. **`strict` body option** (`misc.ts`): `BodyOptions.strict` is documented to
   restrict JSON to top-level objects/arrays but the enforcement is marked
   `@remarks Currently reserved for future enforcement; not yet applied.`

2. **`refreshTokenSecret`** (`jwt-auth.ts`): Field exists in `JwtConfig` but
   refresh tokens are opaque hex strings, not JWTs. The field is reserved for
   future use when refresh tokens might be signed JWTs.

3. **`gitCreate` JSDoc** (`git.ts`): The `gitCreate` function has an incomplete
   JSDoc comment (the `@param` and `@returns` tags are missing).

**Resolved items (no longer open):**

- ~~Cookie reading/writing~~ — Signed cookies are fully implemented: HMAC-SHA256 signing/verification via `createRouter({ secret })`. `j:` prefix handled on both read and write.
- ~~Async error catching~~ — The `invoke()` helper wraps every middleware call; `ret instanceof Promise` catches async rejections and routes them to `invokeErrorHandler`.
- ~~Directory listing sort~~ — `writeIndexOf()` now supports sortable columns via `?C=N;O=D` query params (directories always first).
- ~~`async setup()` not awaited~~ — `buildModule()` now awaits the `Promise` returned by `setup()` before the module is considered ready.

---

## 12. Exported API Surface (from `src/index.ts`)

### Functions

```ts
// Router
createRouter(prefixOrOpts?: string | RouterOptions, opts?: RouterOptions): Router

// Static
serveStatic(root: string, opts?: StaticOptions): Middleware
serveFile(filepath: string, opts?: StaticOptions): Middleware
sendFile(filepath: string, req: RouterRequest, res: RouterResponse): void
mime: Mime  // MIME type lookup object

// Body / misc
json(opts?: BodyOptions): Middleware
formData(opts?: BodyOptions): Middleware
formEncoded(opts?: BodyOptions): Middleware
parseBody(opts?: BodyOptions): Middleware
streamFormData(req: RouterRequest, opts?: BodyOptions): AsyncGenerator<FormPartStream>
logger(opts?: Partial<LoggerOptions>): Middleware
cors(opts?: Partial<CorsOptions>): Middleware

// Middleware
compress(opts?: CompressOptions): Middleware
requestId(opts?: RequestIdOptions): Middleware
rateLimit(opts: RateLimitOptions): Middleware
cacheControl(opts?: CacheControlOptions): Middleware
csrf(opts?: CsrfOptions): Middleware
securityHeaders(opts?: SecurityHeadersOptions): Middleware
conditionalGet(): Middleware

// JWT
createJwtPlugin(userConfig?: Partial<JwtConfig>): JwtPlugin
createMapTokenStore(): TokenStore

// Git
gitHandler(opt: GitHandlerOptions): (req, res) => void
gitCreate(gitDirectory: string, opt: GitCreateOption): Promise<void>

// API builder
apiBuilder<TInstance>(service: ServiceDefinition<TInstance>): Router

// OpenAPI
describe<TInstance>(service: OpenApiServiceMeta<TInstance>): OpenApiServiceMeta<TInstance>
openApiSpec(service: OpenApiServiceMeta<unknown>, opts: SpecOptions): Middleware
serializeSpec(doc: OpenApiDocument, format?: SpecFormat): string
DESCRIBE_META: symbol  // metadata key used to attach OpenAPI annotations
```

### Key types

```ts
// Router
type Middleware       = (req: RouterRequest, res: RouterResponse, next: NextFunction) => void
type NextFunction     = (err?: unknown) => void
type ErrorHandler     = (err: unknown, req: RouterRequest, res: RouterResponse) => void
type MiddlewareArg    = Middleware | Router | (Middleware | Router)[]

interface RouterOptions  // secret, timeout, trustProxy
interface RouterRequest  // extends http.IncomingMessage — adds ip, path, params, queries, cookies, json(), text(), formData()
interface RouterResponse // extends http.ServerResponse — adds send(), json(), status(), redirect(), cookie(), download(), type(), etag()
interface Router         // the return type of createRouter()
interface RouteInfo      // { method, path, stripPath } — returned by router.routes()
interface Layer          // internal route entry
interface CookieOptions
interface TlsOptions

// Body parsing
interface BodyOptions
interface LoggerOptions
interface FormPart        // multipart part: { headers, content: Buffer }
type FormPartStream       // { headers, stream: Readable }

// Middleware
interface CompressOptions
interface RequestIdOptions
interface RateLimitOptions
interface CacheControlOptions
interface CsrfOptions
interface SecurityHeadersOptions

// JWT
interface JwtConfig       // accessTokenSecret, alg, accessTokenPrivateKey/PublicKey, ...
interface JwtPlugin
interface UserRecord
interface TokenPayload
interface TokenStore
interface RefreshTokenRecord

// APIs
interface ApiError         // { status?, message?, data? }
interface ServiceDefinition<TInstance>
type ServiceMethod<TInstance>
type ServiceMethods<TInstance>
type RouteMap<TInstance>

// OpenAPI
interface OperationMeta
interface OpenApiServiceMeta<TInstance>
interface SpecOptions      // { title, version, format?, ... }
type SpecFormat            // 'json' | 'yaml'
interface OpenApiDocument

// Git
interface GitHandlerOptions
```

---

## 13. Development Workflow

```bash
# Build both ESM (tsc) and CJS shim (esbuild) → dist/
npm run build

# Remove all build artefacts (run before a clean build)
npm run clean

# Run all tests
npm test

# Run specific test file (no build needed — tsx handles it)
node --import tsx --test tests/router.test.ts

# Install devDependencies only (no prod deps to install)
npm install
```

The `dist/` directory is the published artifact. Always run `npm run build`
before checking that exported types match expectations.

### Dual-output build

`npm run build` performs two steps:

1. **`tsc`** — compiles `src/` with `tsconfig.json` (`module: NodeNext`) to
   `dist/`. Produces one `.js` file per source file (ESM, tree-shakeable),
   plus `.d.ts` and `.d.ts.map` declarations.

2. **`node scripts/build-cjs.cjs`** — runs esbuild via its Node.js API to
   produce a single bundled CJS file at `dist/cjs/index.js`, then writes
   `dist/cjs/package.json` (`{"type":"commonjs"}`).

esbuild is used for the CJS step (not `tsc`) because `tsc` in `CommonJS` mode
does not support `import ... with { type: 'json' }` syntax, which is required
for the `mimetypes.json` import in `src/static.ts`.

The `package.json` `exports` field routes `import` consumers to `dist/index.js`
and `require` consumers to `dist/cjs/index.js`. The legacy `"main"` field
also points to `dist/cjs/index.js` for tools that do not read `exports`.

`tsconfig.cjs.json` exists for **type-checking only** (`--noEmit`); it is not
used by the build script.

### Adding a new feature checklist

1. Write source in `src/` with full JSDoc (all public exports must be documented)
2. Export from `src/index.ts` (value + type)
3. Write tests in `tests/<module>.test.ts` using real HTTP servers
4. Build and verify `dist/` compiles without errors
5. Update `README.md` (user-facing documentation)

---

## 14. Architecture Notes

### No middleware error handling layer

Unlike Express, there is no 4-argument error middleware `(err, req, res, next)`.
Errors are either caught synchronously by the try/catch in `listener` (→ 500)
or must be handled within each middleware.

### Response helpers added at augmentation time

All `res.*` helpers are attached once in `updateHttpObjects`. If you call
`createRouter` methods on a raw `http.IncomingMessage`/`http.ServerResponse`
without going through the router listener, these helpers won't be available.

### `cors` behavior detail

The `cors()` middleware only sets `Access-Control-Allow-Origin` when
`req.headers.origin` is present. This means it won't set the header for
non-browser fetch calls that don't include an `Origin` header. For OPTIONS
preflight, it always responds and calls `return` (does not call `next()`).

### `listen()` returns the server instance

`router.listen()` returns the underlying `http.Server` (or `https.Server`)
instance, making it possible to perform graceful shutdown, attach error
listeners, or discover the OS-assigned ephemeral port:

```ts
// Graceful shutdown on SIGTERM
const server = router.listen(3000, () => console.log('Listening'));
process.on('SIGTERM', () => server.close());

// Discover the OS-assigned ephemeral port (useful in tests)
const server = router.listen(0, () => {
  const { port } = server.address() as AddressInfo;
  console.log(`Listening on port ${port}`);
});
```

The test files use this when they need a bare server without a custom `done`
callback. Helpers that wrap `router.listener` with a custom done function (e.g.
to inject session data or send a `'next() called'` fallback body) still create
their own `http.createServer()` internally.
