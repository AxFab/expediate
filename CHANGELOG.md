# Changelog

All notable changes to **expediate** are documented here.

---

## [1.1.0] — Unreleased

### Added
- **API Builder v2** (see `docs/api-builder-v2-design.md`):
  - **Controllers** — `defineController()` / `ServiceDefinition.controllers` split an API into per-domain files merged into one router and one OpenAPI document, with prefix joining, global specificity sorting, and build-time duplicate-route detection
  - **Guards** — pre-handler hooks in the `ctx` world at API, controller, and route level (`OperationMeta.guards`); returned objects accumulate into the new `ctx.state` bag
  - **Auth binding** — `ServiceDefinition.auth` auto-registers an `authenticate` middleware and enforces declarative `permission` requirements (`OperationMeta.permission` / controller-level) via a default check matching `jwtPlugin.requirePermission` semantics, overridable for resource-scoped models
  - **Request validation** — `ServiceDefinition.validate` executes the JSON Schemas declared in `requestBody` metadata (subset validator, `$ref` resolved against the new `ServiceDefinition.schemas`); failures return `400` with `{ message, fieldErrors }`
  - **Context ergonomics** — `ctx.params` (alias of `ctx.query.route`) and `ApiContext<TUser, TState>` generics
  - **OpenAPI security output** — secured operations emit `security: [{ bearerAuth: [] }]`, an `x-required-permissions` vendor extension, and `components.securitySchemes`
- **Body parsing** — `raw()` (body as `Buffer`) and `text()` (body as `string`) middleware; Brotli (`br`) request decompression alongside gzip/deflate; new `type` option (string / `string[]` / predicate, with `*` wildcards) to control which requests a parser handles, and a `verify(req, res, buf, encoding)` hook run on the raw body before parsing (throw to reject)
- **Routing** — `router.route(path)` fluent builder for registering several HTTP methods against one path
- **Method handling** — `HEAD` requests are now served by the matching `GET` handler (body suppressed); unhandled `OPTIONS` on a registered path replies `204` with an `Allow` header; the `405`/OPTIONS `Allow` headers advertise `HEAD` (when a `GET` exists) and `OPTIONS`. Explicit `use()`/`all()` handlers and `cors()` still take precedence
- **Routing** — `head()` and `options()` registration helpers (on the router and the `route()` builder) for method-specific `HEAD`/`OPTIONS` handlers
- **Headers** — `req.header(name)` (case-insensitive request-header lookup, `referer`/`referrer` equivalent) and chainable `res.header(field, value)`
- **Cookies** — `res.cookie()` now percent-encodes values (after any `j:`/`s:` wrapping) so semicolons, commas, spaces, quotes, and backslashes transmit safely; cookie parsing de-quotes (RFC 6265 quoted-string) and percent-decodes values before interpreting `j:`/`s:` prefixes. Signed-cookie HMAC remains computed over the unencoded value
- `ErrorHandler` and `RouteInfo` types re-exported from the public API
- `TokenPayload` and `UserRecord` types re-exported from the public API
- `CorsOptions` type re-exported from the public API
- `cors()` middleware documented in README

### Changed
- **Breaking:** a duplicate `(verb, path)` route pair now **throws at build time** in `apiBuilder` / `openApiSpec` (was silent shadowing)
- **Breaking (compile-time):** `ApiContext.user` defaults to `unknown` instead of `any`
- `ServiceDefinition.schemas` supersedes `SpecOptions.schemas` on name conflicts (the spec-options form is kept as a fallback)

### Fixed
- Several minor fixes and test reliability improvements

---

## [1.0.4] — 2025

### Added
- **ETag / conditional GET** — `res.etag()` response helper and `conditionalGet()` middleware implement RFC 7232 (`If-None-Match`, `If-Modified-Since`) so clients receive 304 Not Modified when their cache is fresh
- **Path parameter type constraints** — inline regex in route patterns (`:id(\d+)`, `:slug([a-z-]+)`) so parameters are validated at the routing level without extra middleware
- **Asymmetric JWT keys** — `createJwtPlugin` now supports RS256/384/512 and ES256/384/512 algorithms via `accessTokenPrivateKey` / `accessTokenPublicKey` PEM options alongside the existing HMAC `accessTokenSecret`
- **Directory listing sort** — `serveStatic` directory index now supports column sort via `?C=N|M|S;O=A|D` query params (directories always listed first)
- **ESM-first with CJS compatibility** — package is now `"type": "module"` with a bundled CJS shim at `dist/cjs/index.js`; dual `exports` field in `package.json` routes consumers to the right build automatically

### Fixed
- Cookie reading and writing: signed cookies (HMAC-SHA256 via `createRouter({ secret })`) and JSON-prefixed cookies (`j:`) now work correctly on both read and write paths
- Async error handling: async middleware rejections are now caught and routed to the error handler (fixes unhandled promise rejections)
- `listen()` now returns the underlying `http.Server` / `https.Server` instance for graceful shutdown and ephemeral port discovery
- Git handler options (`strict`, `timeout`, `gitPath`) documented and applied correctly

---

## [1.0.3] — 2025

### Added
- **OpenAPI spec generation** — `describe()`, `openApiSpec()`, and `serializeSpec()` (JSON and YAML) for annotating API service routes with schema metadata
- **API service builder** — `apiBuilder()` for defining scoped (singleton / keyed / ephemeral) HTTP services with automatic JSON error handling and route priority sorting
- **Middleware suite** — `compress()` (Brotli/gzip/deflate), `requestId()`, `rateLimit()`, `cacheControl()`, `csrf()` (double-submit cookie), `securityHeaders()`, `conditionalGet()`
- **CORS support** — `cors()` middleware with origin, credentials, preflight guard, and `Vary` header support

### Fixed
- Common error schema standardised to `{ status, message }` across all built-in error responses
- Git Smart HTTP handler corrected and end-to-end tested

---

## [1.0.2] — 2025

### Added
- **JWT authentication plugin** — `createJwtPlugin()` with login, refresh (token rotation), logout, `authenticate`, `authorize`, `requireRole`, and `requirePermission` middleware; HMAC HS256/384/512 support
- **TypeScript rewrite** — entire codebase converted to strict TypeScript (ESNext target, `isolatedModules`)
- **Router interface improvements** — `router.routes()`, `router.onError()`, sub-router path stripping, and `req`/`res` helper augmentation (`req.json()`, `req.text()`, `res.status()`, `res.cookie()`, `res.redirect()`, `res.download()`, `res.type()`)

---

## [1.0.1] — 2025

### Added
- **Git Smart HTTP gateway** — `gitHandler()` serves `git clone`, `git fetch`, and `git push` over HTTP; `gitCreate()` initialises bare repositories programmatically
- **Body parsing** — `json()`, `formData()`, `formEncoded()`, `parseBody()`, `streamFormData()` with size limits, gzip/deflate decompression, and multipart boundary parsing
- **Request logger** — `logger()` middleware with ANSI-coloured output, structured JSON mode, and lost-request tracking
- **RegExp routes** — route paths may be `RegExp` instances; named capture groups populate `req.params`
- **Glob patterns** — `*`, `**`, `?` wildcard support in route paths

---

## [1.0.0] — 2025

### Added
- Initial release
- `createRouter()` — zero-dependency HTTP/HTTPS/HTTP2 server with Express-compatible `use()`, `get()`, `post()`, `put()`, `delete()`, `patch()`, `all()` route registration
- Named route parameters (`:name`, `:id(\d+)`)
- `serveStatic()`, `serveFile()`, `sendFile()` for static file serving with ETag caching, dotfile protection, and path traversal guards
- MIME type detection via `src/mimetypes.json`
- Dual CJS + ESM output via `tsc` + `esbuild`
