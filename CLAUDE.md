# CLAUDE.md — Expediate Project Reference

This file captures architectural knowledge, non-obvious design decisions, known
limitations, and development patterns for the **expediate** package. It is
intended for future conversations — read this before touching any source file.

---

## 1. Project Overview

**Expediate** is a zero-dependency TypeScript HTTP server framework with an
Express-compatible API surface. It wraps Node.js built-in `http`/`https` modules
only. There are no runtime npm dependencies whatsoever.

- **Package type:** CommonJS (`"type": "commonjs"`)
- **Version:** 1.0.4
- **Build:** `tsc` → outputs to `./dist/`
- **Test runner:** `node --import tsx --test 'tests/*.test.ts'`
- **TypeScript version:** 5.9.3 (strict mode, isolatedModules)
- **tsconfig target:** ESNext, module NodeNext
- **Outputs:** `.js`, `.d.ts`, `.d.ts.map`, `.js.map` files in `dist/`

Source files live in `src/`. Only `src/**/*` is compiled (tsconfig.json).
Test files in `tests/` use `tsx` at runtime and are never compiled.

---

## 2. Module Map

| Source file       | Exports (from `src/index.ts`)                                              |
|-------------------|----------------------------------------------------------------------------|
| `router.ts`       | `createRouter`, types: `Router`, `RouterRequest`, `RouterResponse`, `Middleware`, `MiddlewareArg`, `NextFunction`, `Layer`, `CookieOptions`, `TlsOptions`, `StringMap` |
| `static.ts`       | `serveStatic`, `serveFile`, `sendFile`, `mime`, types: `StaticOptions`, `Mime` |
| `misc.ts`         | `json`, `formData`, `parseBody`, `logger`, `cors`, types: `BodyOptions`, `LoggerOptions`, `FormPart` |
| `jwt-auth.ts`     | `createJwtPlugin`, types: `JwtPlugin`, `JwtConfig`                         |
| `git.ts`          | `gitHandler`, `gitCreate`, types: `GitHandlerOptions`                      |
| `apis.ts`         | `apiBuilder`, types: `ApiError`, `ServiceMethod`, `ServiceInstance`, `ServiceMethods`, `RouteMap`, `ServiceDefinition` |

Note: `cors` is exported from `misc` but **not documented in the README**. Same
for `gitCreate`. `extractCharset` and `readReqBody` are exported from `misc.ts`
directly but not re-exported through `index.ts` — they are implementation
details also used by `router.ts`.

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
   - Literal segments are regex-escaped
   - Pattern ends with `(?=/|$)` to avoid partial segment matches (so `/users` does NOT match `/users-admin`)
   - Anchored at `^`

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
- `cookies` — parsed from `Cookie` header (naive `; `-split, `=`-split)
- `json(opts)` — Promise-based JSON body reader (uses `readReqBody` from misc.ts)

Fields added to `res`:
- `send(data?)` — writes data and calls `res.end()`
- `json(data)` — serialises to JSON and ends
- `status(code, headers?)` — sets status code and optional headers, **returns `this`** for chaining
- `redirect(url)` — 302 with `location` header
- `cookie(name, val, opts)` — appends `Set-Cookie` header, **returns `this`** for chaining

The `X-Powered-By: Expediate` header is set on every response in `updateHttpObjects`.

### Cookie helpers — known limitations

- Cookie **reading**: the parser is naive (splits on `;` then `=`). It does not
  yet decode `s:` (signed) or `j:` (JSON-encoded) cookie prefixes — there is a
  `TODO` comment in the code.
- Cookie **writing**: objects get `j:` prefix. `opts.signed = true` prepends
  `s:` but the actual signing is not implemented (the code checks for a
  `req.secret` field that is never set by the framework).

### Error handling in `listener`

Uncaught synchronous exceptions in middleware are caught with a try/catch and
produce `500 Error METHOD URL`. There is **no async error catching** — if a
middleware returns a rejected Promise without handling it, Node.js will produce
an unhandled rejection.

### `router.listen()` signature

```ts
listen(port: number, opts?: TlsOptions | (() => void), cb?: () => void): void
```

When `opts` is a function it is treated as the callback. HTTPS is used when
`opts.key` and `opts.cert` are both present.

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

`writeIndexOf()` generates an Apache-style HTML directory listing with file
names, sizes, and modification dates. There is a TODO about sorting entries.

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
- Signatures via Node.js `crypto.createHmac()` with `sha256`/`sha384`/`sha512`
- Verification uses `crypto.timingSafeEqual()` to prevent timing attacks
- Supported algorithms: `HS256` | `HS384` | `HS512` only (no RS*, ES*, PS*)

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
    if (!this.ready) throw { httpStatus: 503, message: 'Not ready' };
  }
}
```

### Route handler conventions

- **Truthy return value** → JSON response, status 200
- **Falsy return value** (`undefined`, `null`, `false`, `0`, `''`) → 201 No Content
- **Throw / reject with `ApiError`** → HTTP error response:
  ```ts
  interface ApiError {
    httpStatus?: number;  // default: 500
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

## 9. Test Harness and Patterns

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
| `router.test.ts`      | compilePlainPath, compileGlob, RegExp, methods, chain, sub-router, URL parsing, cookies, response helpers, registerRoute errors, edge cases |
| `misc.test.ts`        | json(), formData(), parseBody(), readSize (via limit), logger()         |
| `apis.test.ts`        | singleton/keyed/ephemeral, buildModule, return conventions, error handling, route params, HTTP verbs, multiple routes, async setup |
| `static.test.ts`      | validation, basic serving, security headers, caching (304/ETag), method filter, dot-files, traversal, directory redirect, contentType, fallthrough, serveFile, sendFile, ETag stability, concurrency |
| `jwt-auth.test.ts`    | hashPassword, signToken/verifyToken, login, refresh (rotation), logout, authenticate, authorize, requireRole, requirePermission, custom config, security edge cases |
| `git.test.ts`         | factory validation, pktLine, GET /info/refs, POST /git-upload-pack, repository callback, options (strict/timeout/gitPath), unrecognised routes |

### Known test quirk

In `router.test.ts` there is a comment: `// 400 Or 404, wierd thing going on here` for the case where a wrong HTTP method is used. The router falls through to a
404 when no route matches — it does NOT return 405. This is a deliberate (if
imperfect) design.

---

## 10. Known Issues and TODOs

All identified from source comments:

1. **Cookie decoding** (`router.ts`): The cookie parser does not decode `s:`
   (signed) or `j:` (JSON) prefixes when reading cookies. Only writing uses those prefixes.

2. **Signed cookies** (`router.ts`): `res.cookie(..., { signed: true })` prepends
   `s:` but does not actually sign the value. Requires a `req.secret` that is
   never set. Signing integration is an unfilled TODO.

3. **`strict` body option** (`misc.ts`): `BodyOptions.strict` is documented to
   restrict JSON to top-level objects/arrays but the enforcement is marked
   `@remarks Currently reserved for future enforcement; not yet applied.`

4. **`refreshTokenSecret`** (`jwt-auth.ts`): Field exists in `JwtConfig` but
   refresh tokens are opaque strings, not JWTs. The field is reserved for future
   use when refresh tokens might be signed JWTs.

5. **Directory listing sort** (`static.ts`): `writeIndexOf()` lists directory
   entries in filesystem order. There is a TODO about sorting them.

6. **`async setup()` not awaited** (`apis.ts`): `buildModule()` calls
   `setup.apply(instance)` synchronously. If `setup` is async, the returned
   Promise is ignored. Pattern: use a `throwIfNotReady()` guard in methods.

7. **Unhandled async errors** (`router.ts`): The try/catch in `listener` only
   catches synchronous throws. Async middleware that reject unhandled will
   produce Node.js `UnhandledPromiseRejection` warnings.

8. **`gitCreate` JSDoc** (`git.ts`): The `gitCreate` function has an incomplete
   JSDoc comment (the `@param` and `@returns` tags are missing).

---

## 11. Exported API Surface (from `src/index.ts`)

### Functions

```ts
// Router
createRouter(): Router

// Static
serveStatic(root: string, opts?: StaticOptions): Middleware
serveFile(filepath: string, opts?: StaticOptions): Middleware
sendFile(filepath: string, req: RouterRequest, res: RouterResponse): void
mime: Mime  // MIME type lookup object

// Body / misc
json(opts?: BodyOptions): Middleware
formData(opts?: BodyOptions): Middleware
parseBody(opts?: BodyOptions): Middleware
logger(opts?: Partial<LoggerOptions>): Middleware
cors(opts?: Partial<CorsOptions>): Middleware

// JWT
createJwtPlugin(userConfig?: Partial<JwtConfig>): JwtPlugin

// Git
gitHandler(opt: GitHandlerOptions): (req, res) => void
gitCreate(gitDirectory: string, opt: GitCreateOption): Promise<void>

// API builder
apiBuilder<TInstance>(service: ServiceDefinition<TInstance>): Router
```

### Key types

```ts
// Router
type Middleware       = (req: RouterRequest, res: RouterResponse, next: NextFunction) => void
type NextFunction     = () => void
type MiddlewareArg    = Middleware | Router | (Middleware | Router)[]

interface RouterRequest  // extends http.IncomingMessage
interface RouterResponse // extends http.ServerResponse
interface Router         // the return type of createRouter()
interface Layer          // internal route entry
interface CookieOptions
interface TlsOptions

// Body parsing
interface BodyOptions
interface LoggerOptions
interface FormPart       // multipart part: { headers, content: Buffer }

// JWT
interface JwtConfig
interface JwtPlugin
interface UserRecord
interface TokenPayload
interface TokenStore

// APIs
interface ApiError
interface ServiceDefinition<TInstance>
type ServiceMethod<TInstance>
type ServiceInstance
type ServiceMethods<TInstance>
type RouteMap<TInstance>

// Git
interface GitHandlerOptions
```

---

## 12. Development Workflow

```bash
# Build TypeScript → dist/
npm run build

# Run all tests
npm test

# Run specific test file (no build needed — tsx handles it)
node --import tsx --test tests/router.test.ts

# Install devDependencies only (no prod deps to install)
npm install
```

The `dist/` directory is the published artifact. Always run `npm run build`
before checking that exported types match expectations.

### Adding a new feature checklist

1. Write source in `src/` with full JSDoc (all public exports must be documented)
2. Export from `src/index.ts` (value + type)
3. Write tests in `tests/<module>.test.ts` using real HTTP servers
4. Build and verify `dist/` compiles without errors
5. Update `README.md` (user-facing documentation)

---

## 13. Architecture Notes

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
