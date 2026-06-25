# Changelog

All notable changes to **expediate** are documented here.

---

## [1.0.6] — 25 June 2026

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
- **Error handling** — `router.error()` registers an ordered, forwardable error-middleware chain (`(err, req, res, next)`); when exhausted it falls back to the single `onError()` handler and then **bubbles to the parent router**, so a root handler can catch failures from deeply nested sub-routers. `apiBuilder` adds a `ServiceDefinition.onError(err, ctx, req)` hook. `ErrorMiddleware` type exported
- **Response helpers** — `res.append()`, `res.vary()`, `res.location()`, `res.clearCookie()`, `res.sendStatus()`, `res.attachment()`, and a per-response `res.locals` object
- **Headers** — `req.header(name)` (case-insensitive request-header lookup, `referer`/`referrer` equivalent) and chainable `res.header(field, value)`
- **Route safety** — `RegExp` routes that use the `g` (global) or `y` (sticky) flag are now rejected at registration; those flags make `exec()` stateful and cause intermittent, hard-to-debug `404`s. Inline `:name(constraint)` patterns are scanned so regex metacharacters inside them are no longer mistaken for glob wildcards
- **Cookies** — `res.cookie()` now percent-encodes values (after any `j:`/`s:` wrapping) so semicolons, commas, spaces, quotes, and backslashes transmit safely; cookie parsing de-quotes (RFC 6265 quoted-string) and percent-decodes values before interpreting `j:`/`s:` prefixes. Signed-cookie HMAC remains computed over the unencoded value
- **Response validation** — `apiBuilder` accepts an optional second argument, `ApiBuilderOptions`, controlling validation. `validateResponses` checks each handler's return against its declared `responses['200']` schema: `true` returns `500 { message, fieldErrors }` when the server would emit an off-spec body, `'warn'` logs the mismatch via `console.warn` and sends the response unchanged. `validateRequests` (default on) toggles the existing request check. `ServiceDefinition.validate` accepts the same `boolean | ApiBuilderOptions` shape
- **MIME types** — bundled `src/mimetypes.json` table expanded with hundreds of additional extensions
- `ErrorHandler` and `RouteInfo` types re-exported from the public API
- `TokenPayload` and `UserRecord` types re-exported from the public API
- `CorsOptions` type re-exported from the public API
- `cors()` middleware documented in README

### Changed
- **Breaking:** a duplicate `(verb, path)` route pair now **throws at build time** in `apiBuilder` / `openApiSpec` (was silent shadowing)
- **Breaking (compile-time):** `ApiContext.user` defaults to `unknown` instead of `any`
- **Breaking (compile-time):** `RouterRequest.body` is now typed `unknown` instead of `any` — narrow it before use (e.g. `req.body as { id: string }`)
- `req.user` is now typed (`TokenPayload`) on `RouterRequest` when the JWT plugin is loaded, instead of requiring an `as any` cast
- `ServiceDefinition.schemas` supersedes `SpecOptions.schemas` on name conflicts (the spec-options form is kept as a fallback)

### Removed
- **Breaking:** `router.setNotFound()` and the not-found handler hook. Register a catch-all layer **last** instead — `app.all('/**', (req, res) => …)` — which matches in registration order and, unlike `setNotFound()`, also fires correctly inside mounted sub-routers. The built-in `Cannot METHOD /path` 404 remains the default fallback

### Performance
- Per-request `req`/`res` helpers are now defined once on shared prototypes and attached via `Object.setPrototypeOf` instead of allocating ~20 closures on every request; the `status()` range check was folded into the single prototype method (removing a second per-request allocation)

### Fixed
- `cors()` with an array `origin` now matches the request's `Origin` header against the allow-list and echoes back only the matching entry (previously it only ever matched a single string origin, so an array never granted access)
- Body parsing no longer returns `415` when a parser's content type doesn't match — it passes through to the next middleware, so parser stacks (`json()` + `formEncoded()` + …) compose correctly
- Static file serving hardened against control characters in the path and corrected path-handling edge cases
- Consistent method-routing behaviour (`HEAD`/`OPTIONS`/`405`) across registered and unregistered paths
- Misc. test-reliability improvements

### Internal / Tooling
- Split the ~2,200-line `src/router.ts` into `router.ts` + `router-types.ts` (type declarations) + `http-objects.ts` (req/res augmentation and cookie helpers); the public API and exports are unchanged
- Added a type-aware ESLint flat config (`eslint.config.js`) and `tsconfig.eslint.json`; `npm run lint` now passes. Reduced `any` usage across `src/`
- Bumped `esbuild` (build-time dev dependency) to resolve security advisories; pruned stale repo files (`AUDIT.md`, duplicate `docs/middlewares.md`)
- Documentation overhaul: corrected the JWT refresh-token description (signed JWT keyed by `jti`, opt-in via `refreshTokenStore`, `501` when absent — was documented as an always-on opaque hex token), the Brotli request-decompression support (was documented as unsupported), `static.md`'s conditional-request coverage (`If-Match`/`If-Unmodified-Since` → `412`), and `git.md`'s `gitCreate` `bare` option; documented `router.route()`, `raw()`, and `text()`. Removed `ROADMAP.md`, `AUDIT.md` (disposable, point-in-time planning/audit artifacts), and the `docs/mdlw/` directory (20 one-function-per-file pages that duplicated the topic docs in `docs/`) — `docs/wiki.json` updated to drop the now-removed entries

---

## [1.0.5] — 8 June 2026

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

## [1.0.4] — May 2026

### Added
- **OpenAPI spec generation** — `describe()`, `openApiSpec()`, and `serializeSpec()` (JSON and YAML) for annotating API service routes with schema metadata
- **API service builder** — `apiBuilder()` for defining scoped (singleton / keyed / ephemeral) HTTP services with automatic JSON error handling and route priority sorting
- **Middleware suite** — `compress()` (Brotli/gzip/deflate), `requestId()`, `rateLimit()`, `cacheControl()`, `csrf()` (double-submit cookie), `securityHeaders()`, `conditionalGet()`
- **CORS support** — `cors()` middleware with origin, credentials, preflight guard, and `Vary` header support

### Fixed
- Common error schema standardised to `{ status, message }` across all built-in error responses
- Git Smart HTTP handler corrected and end-to-end tested

---

## [1.0.3] — Mars 2026

### Added
- **JWT authentication plugin** — `createJwtPlugin()` with login, refresh (token rotation), logout, `authenticate`, `authorize`, `requireRole`, and `requirePermission` middleware; HMAC HS256/384/512 support
- **TypeScript rewrite** — entire codebase converted to strict TypeScript (ESNext target, `isolatedModules`)
- **Router interface improvements** — `router.routes()`, `router.onError()`, sub-router path stripping, and `req`/`res` helper augmentation (`req.json()`, `req.text()`, `res.status()`, `res.cookie()`, `res.redirect()`, `res.download()`, `res.type()`)

---

## [1.0.2] — Mars 2026

### Added
- **Git Smart HTTP gateway** — `gitHandler()` serves `git clone`, `git fetch`, and `git push` over HTTP; `gitCreate()` initialises bare repositories programmatically
- **Body parsing** — `json()`, `formData()`, `formEncoded()`, `parseBody()`, `streamFormData()` with size limits, gzip/deflate decompression, and multipart boundary parsing
- **Request logger** — `logger()` middleware with ANSI-coloured output, structured JSON mode, and lost-request tracking
- **RegExp routes** — route paths may be `RegExp` instances; named capture groups populate `req.params`
- **Glob patterns** — `*`, `**`, `?` wildcard support in route paths

---

## [1.0.1] — Mars 2026

### Added
- Initial release
- `createRouter()` — zero-dependency HTTP/HTTPS/HTTP2 server with Express-compatible `use()`, `get()`, `post()`, `put()`, `delete()`, `patch()`, `all()` route registration
- Named route parameters (`:name`, `:id(\d+)`)
- `serveStatic()`, `serveFile()`, `sendFile()` for static file serving with ETag caching, dotfile protection, and path traversal guards
- MIME type detection via `src/mimetypes.json`
- Dual CJS + ESM output via `tsc` + `esbuild`

---

## [1.0.0] — Mars 2026

_Not documented_

## [0.0.3] — 2022

_Not documented_

## [0.0.2] — 2021

_Not documented_

## [0.0.1] — 2021

_Not documented_
