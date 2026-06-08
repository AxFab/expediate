# Expediate Package Audit

Date: 2026-06-08

This audit reviews Expediate as a zero-runtime-dependency TypeScript HTTP
framework with an Express-compatible API goal. It covers correctness risks,
Express parity gaps, test coverage, documentation consistency, and whether
benchmark, stress-test, and security-test tooling should become part of the
project.

## Scope And Assumptions

- "Close the gap with Express" is interpreted as Express 5.x compatibility
  where it improves user migration, not as cloning every historical Express
  behavior.
- The zero runtime dependency rule is treated as a product constraint. Dev-time
  tools and optional comparison fixtures may use dev dependencies only when the
  value is high and the dependency does not leak into the published package.
- Source code and tests are the source of truth when docs disagree.
- Current package version in `package.json` is `1.0.5`.

External references used:

- Express 5.x API surface: https://expressjs.com/en/5x/api/
- Express middleware guide: https://expressjs.com/en/guide/using-middleware/
- Express 5 migration guide: https://expressjs.com/en/guide/migrating-5/

## Executive Summary

Expediate is already far beyond a toy Express rewrite. It has a real router,
body parsing, static files, CORS, compression, request IDs, rate limits, CSRF,
security headers, conditional GET, JWT auth, Git Smart HTTP, OpenAPI generation,
ESM/CJS output, and a large native `node:test` suite.

The next step should not be "add more middleware" first. The best next step is
to harden compatibility semantics and establish measurement tooling.

Highest-value work:

1. Fix route matching semantics for method routes. Today `get('/users')` can
   match `/users/42`; this is the biggest Express-compatibility and shadowing
   risk.
2. Harden malformed input paths and generated static directory listings.
3. Resolve body-parser compatibility and documentation mismatches.
4. Add a compatibility matrix and coverage tracking so every future feature is
   measured against Express behavior and current Expediate behavior.
5. Add benchmark, stress-test, and security-test harnesses. These are useful,
   but only if they become repeatable gates rather than one-off scripts.

## Current Strengths

- No runtime dependencies. This is a real differentiator if maintained
  carefully.
- TypeScript-first implementation with strict compiler settings.
- ESM package with a CJS compatibility bundle.
- Broad built-in middleware suite:
  - `compress`
  - `requestId`
  - `rateLimit`
  - `cacheControl`
  - `csrf`
  - `securityHeaders`
  - `conditionalGet`
  - `cors`
  - body parsers
  - static file serving
- Express 5-style async rejection handling is already present in the router.
- `apiBuilder` and OpenAPI generation are distinctive higher-level features
  rather than Express clones.
- Tests are extensive and use real HTTP servers rather than pure mocks.
- Static file serving already covers ETag, Last-Modified, HEAD, dotfiles,
  traversal guards, directory indexes, and concurrency.
- JWT support covers HMAC, RSA, ECDSA, refresh token rotation, and role/permission
  middleware.

## Test Baseline

Command run:

```bash
npm test
```

Result:

- Tests: 696
- Suites: 118
- Passing: 696
- Failing: 0
- Skipped: 0
- Duration: about 5.1 seconds

This is a strong regression suite, but there is no coverage report script and
no compatibility test suite against Express itself.

## Test Coverage Map

| Area | Current coverage | Confidence | Missing coverage to add |
| --- | --- | --- | --- |
| Router pattern compilation | Static paths, params, inline constraints, glob, RegExp | High | Exact method-route matching vs prefix matching; global/sticky RegExp; duplicate params; malformed URLs; HEAD/OPTIONS behavior |
| Middleware dispatch | `use`, method routes, sub-routers, arrays, async errors, `onError`, 404/405 | Medium-high | Express `next('route')`, `next('router')`, 4-arg error middleware, route stack skip behavior |
| Request augmentation | `originalUrl`, `path`, `params`, query arrays, cookies, signed cookies, IP trust | Medium | `req.baseUrl`, `req.query`, `req.get`, `req.protocol`, `req.secure`, `req.hostname`, `req.ips`, malformed Host/URL |
| Response helpers | `send`, `json`, `status`, `redirect`, `cookie`, `download`, `type`, `etag` | Medium | Header append/get/set helpers, `clearCookie`, `sendStatus`, JSON content-type after `json()` middleware, status validation |
| Body parsing | JSON, multipart, urlencoded, text, chunked bodies, gzip/deflate, strict JSON | Medium-high | Brotli request decompression, raw parser, type predicates, verify hook, parser pass-through semantics, stream errors |
| Static files | MIME, caching, dotfiles, traversal, HEAD, directory index, fallthrough | High | Malformed percent-encoding, HTML escaping in directory indexes, root escape property tests, byte ranges |
| Middleware suite | Compression, rate limit, cache, CSRF, security headers, conditional GET | Medium | Vary header preservation, compression streaming/backpressure, rate-limit store cleanup under many keys, CORS origin arrays |
| JWT auth | HMAC/RSA/ECDSA, login, refresh, logout, auth guards, token store | High | Default config safety warnings, timing-safe password comparison, audience/nbf/clock tolerance, key rotation |
| Git Smart HTTP | Advertisements, upload/receive paths, options, gzip body, gitCreate | Medium | Full clone/fetch/push fixtures with a real bare repo, auth hook, repo path confinement, process timeout enforcement |
| API builder | Scopes, async setup, route sorting, return conventions, OpenAPI hooks | Medium-high | Memory lifecycle for keyed scopes, teardown hooks, route collision diagnostics |
| OpenAPI | Metadata, defaults, YAML, spec handler | High | Inline regex parameter translation, glob/RegExp route handling policy, OpenAPI security schemes |
| Packaging | Build scripts, ESM/CJS exports | Medium | Fresh install smoke test, CJS require smoke test, package tarball contents |

## Priority Findings

### P0/P1 - Correctness And Security

#### 1. Method routes use prefix matching, not endpoint matching

Files:

- `src/router.ts`
- `tests/router.test.ts`
- `src/apis.ts`

Current plain paths compile to a prefix-anchored regex with a segment-boundary
lookahead. That means a method route such as:

```ts
app.get('/users', handler);
```

also matches:

```txt
/users/42
```

This is why `apiBuilder` sorts routes by specificity before registration. That
workaround helps service definitions, but hand-written routers still depend on
registration order.

Impact:

- Express users expect method routes to match endpoints, while `app.use()` is
  the prefix-matching mount mechanism.
- Authorization middleware can be accidentally bypassed or applied to the wrong
  route when a broad route is registered first.
- 405 detection can also be distorted because `pathMatchesLayer` uses the same
  prefix regex.

Recommendation:

- Split pattern compilation into two modes:
  - prefix mode for `use()`
  - endpoint mode for `get/post/put/delete/patch/all`
- Endpoint mode should anchor at the end, allowing only optional trailing slash
  if the project intentionally wants non-strict routing.
- Add tests:
  - `get('/users')` does not match `/users/42`
  - `use('/users')` still matches `/users/42`
  - route order no longer determines `/items` vs `/items/:id`
  - 405 detection only fires for exact endpoint matches
- Decide whether to keep the current behavior behind a compatibility option
  if existing users may rely on prefix method routes.

#### 2. `serveStatic` can throw on malformed percent-encoding

File:

- `src/static.ts`

`serveStatic` calls:

```ts
decodeURIComponent(req.path ?? req.url ?? '/')
```

without catching `URIError`. A request path like `/%E0%A4%A` can crash through
the middleware path instead of producing a controlled response.

Impact:

- Bad client input can produce a 500 or uncaught router error.
- This is easy to fuzz and should be treated as an input-hardening issue.

Recommendation:

- Catch decode errors and return `400 Bad Request`.
- Add tests for malformed percent encodings and overlong encodings.
- Run these tests both with direct `serveStatic` and mounted under `app.use()`.

#### 3. Directory listing HTML is not escaped

File:

- `src/static.ts`

`writeIndexOf()` interpolates `urlPath`, `parentUrlPath`, and filesystem entry
names directly into HTML. If `indexOf: true` is enabled and a directory contains
a file name with HTML-significant characters, the generated page can become
scriptable or malformed.

Impact:

- XSS risk for users who enable directory listings on untrusted directories.
- HTML injection through names such as `<script>.txt`, quotes, or `&`.

Recommendation:

- Escape text nodes and attribute values separately.
- URL-encode link `href` values.
- Add tests with filenames containing `<`, `>`, `&`, `"`, and spaces.
- Consider keeping `indexOf` disabled by default, which it already is.

#### 4. Body parser pass-through behavior conflicts with Express and docs

Files:

- `src/misc.ts`
- `docs/mdlw/json.md`
- `docs/mdlw/form-data.md`
- `docs/mdlw/form-encoded.md`
- `tests/misc.test.ts`

Docs say typed body parsers pass through unmatched content types. Current code
and tests return `415 Unsupported Media Type` when a body is present with the
wrong `Content-Type`.

Impact:

- This diverges from Express parser behavior, where `express.json()` and
  related parsers only parse matching request types.
- It makes global parser installation risky. For example, `app.use(json())`
  can reject form posts before form middleware gets a chance.
- Docs are contradictory: README says 415, middleware docs say pass-through.

Recommendation:

- If Express compatibility is the goal, change typed parsers to skip unmatched
  request types and reserve `415` for `parseBody()` or explicit strict mode.
- If current strict parser behavior is intentional, rename/document it clearly
  and add a `type` or `strictContentType` option.
- Add tests for parser composition:
  - `app.use(json(), formEncoded())`
  - `app.use(parseBody())`
  - wrong content type with and without body

#### 5. `json()` middleware overwrites `res.json()` without setting Content-Type

File:

- `src/misc.ts`

The router attaches a `res.json()` helper that sets `Content-Type:
application/json`. The `json()` middleware then replaces it with a helper that
writes JSON but does not set `Content-Type`.

Impact:

- `app.use(json())` can make `res.json()` less correct than router-only usage.
- Existing tests cover the body and helper existence, but not this header case.

Recommendation:

- Remove the `json()` middleware override entirely and rely on the router
  helper, or make it set the same content type.
- Add a regression test:
  - `router.use(json()); router.post('/', (_req, res) => res.json({ ok: true }))`
  - response includes `application/json`

#### 6. Static and dynamic path matching with user-supplied RegExp can be stateful

File:

- `src/router.ts`

User-provided RegExp instances are stored as-is. If a route uses `/pattern/g`
or `/pattern/y`, repeated `exec()` and `test()` calls mutate `lastIndex` and
can create alternating matches and misses across requests.

Impact:

- Hard-to-debug intermittent routing failures.
- 405 detection can also change `lastIndex`.

Recommendation:

- Reset `layer.regex.lastIndex = 0` before `exec()` or `test()`.
- Better: reject global/sticky route regexes at registration time.
- Add tests for `/^\/x/g` and `/^\/x/y`.

#### 7. CORS origin arrays and credentials need stricter semantics

File:

- `src/misc.ts`

`cors({ origin: ['a', 'b'] })` passes the array directly to
`Access-Control-Allow-Origin`. Browsers require a single origin value or `*`.
Also, `Access-Control-Allow-Credentials: true` must not be combined with
`Access-Control-Allow-Origin: *` for browser credentialed requests.

Impact:

- Common CORS configurations silently fail in browsers.
- The API shape suggests array support, but it does not currently implement
  origin matching.

Recommendation:

- If `origin` is an array, compare it to `req.headers.origin` and echo the
  matching origin.
- Add `Vary: Origin` automatically when origin is dynamic.
- Reject or warn when `allowCredentials: true` and origin is `*`.
- Add tests for allowed, denied, wildcard, and credentialed origins.

#### 8. Default JWT auth config is convenient but unsafe as a production default

File:

- `src/jwt-auth.ts`

`createJwtPlugin()` can be called with no config and will use placeholder
secrets plus demo users. The source comments warn users, but a production
package should make insecure defaults harder to deploy accidentally.

Impact:

- A user can publish an app with known default secrets and demo credentials.
- The package README describes production-ready middleware, which raises the
  bar for safe defaults.

Recommendation:

- Require explicit `accessTokenSecret` and `refreshTokenSecret` unless an
  explicit `demo: true` or `unsafeDefaults: true` option is passed.
- Move demo users into docs/tests or a named `createDemoJwtPlugin()` helper.
- Compare password hashes with a timing-safe helper even if the default hash is
  documented as demo-only.

### P2 - Express Parity And API Completeness

#### 9. Missing Express router features

Express 5 exposes `router.param()`, `router.route()`, `router.all()`,
`router.METHOD()`, and `router.use()`. Expediate currently has `all`, method
helpers, and `use`, but not param preprocessors or chainable route objects.

Recommendations:

- Add `router.route(path).get(...).post(...)` for migration ergonomics.
- Add `router.param(name, handler)` with clear ordering semantics.
- Consider `next('route')` and `next('router')` support. Express documents both
  route and router skipping in its middleware guide.
- Add compatibility tests copied from documented Express examples.

#### 10. Missing request helpers and properties

Express documents many request fields and helpers:

- `req.app`
- `req.baseUrl`
- `req.body`
- `req.cookies`
- `req.fresh`
- `req.host`
- `req.hostname`
- `req.ip`
- `req.ips`
- `req.originalUrl`
- `req.params`
- `req.path`
- `req.protocol`
- `req.query`
- `req.route`
- `req.secure`
- `req.signedCookies`
- `req.stale`
- `req.subdomains`
- `req.xhr`
- `req.accepts()`
- `req.acceptsCharsets()`
- `req.acceptsEncodings()`
- `req.acceptsLanguages()`
- `req.get()`
- `req.is()`
- `req.range()`

Expediate has a useful subset, but migration from Express apps will be blocked
by missing helpers.

Recommendation:

- Prioritize:
  1. `req.query` alias to `req.queries.url`
  2. `req.get(name)` / `req.header(name)`
  3. `req.baseUrl` during nested `use()` mounts
  4. `req.protocol`, `req.secure`, `req.hostname`
  5. `req.ips` when `trustProxy` is enabled
  6. `req.fresh` / `req.stale` using existing conditional GET logic
- Leave content negotiation helpers for a later compatibility milestone unless
  users request them.

#### 11. Missing response helpers and properties

Express response APIs include:

- `res.append()`
- `res.attachment()`
- `res.clearCookie()`
- `res.cookie()`
- `res.download()`
- `res.format()`
- `res.get()`
- `res.json()`
- `res.jsonp()`
- `res.links()`
- `res.location()`
- `res.redirect()`
- `res.render()`
- `res.send()`
- `res.sendFile()`
- `res.sendStatus()`
- `res.set()`
- `res.status()`
- `res.type()`
- `res.vary()`
- `res.locals`

Expediate has `send`, `json`, `status`, `redirect`, `cookie`, `download`,
`type`, and `etag`. The next migration blockers are mostly simple helpers.

Recommendation:

- Add low-risk helpers first:
  - `res.set()` / `res.header()`
  - `res.get()`
  - `res.append()`
  - `res.vary()`
  - `res.location()`
  - `res.sendStatus()`
  - `res.clearCookie()`
  - `res.attachment()`
  - `res.locals`
- Validate `res.status()` codes as Express 5 does: integer in the `100..999`
  range.
- Defer `res.render()` unless template engine support is a deliberate product
  direction.
- Defer `jsonp()` unless supporting legacy JSONP is important.

#### 12. Body parser feature gaps

Express 5 built-ins include `express.json()`, `express.raw()`,
`express.text()`, `express.urlencoded()`, and `express.static()`. Express 5
also documents Brotli decompression support for request body parsers.

Expediate has JSON, multipart, urlencoded, text via `parseBody()`/`req.text()`,
and static files, but lacks:

- `raw()` middleware
- Brotli request decompression (`Content-Encoding: br`)
- configurable parser `type`
- parser `verify` hook
- richer urlencoded options
- parser error objects with consistent shape

Recommendation:

- Add `raw(opts)` and public `text(opts)` middleware.
- Add Brotli request decompression if Node version support is acceptable.
- Add a parser `type` option accepting string, string array, or predicate.
- Keep urlencoded `extended: false` as default if maintaining zero dependencies.
  Document that nested `qs` behavior is intentionally unsupported unless users
  bring their own parser.

#### 13. App-level settings are missing

Express apps support settings such as `app.set`, `app.get(name)`, `app.enable`,
`app.disable`, and derived behavior for trust proxy, strict routing, and case
sensitive routing.

Expediate currently uses `createRouter(options)` and does not expose a settings
registry.

Recommendation:

- Do not add a full settings registry unless migration demand is real.
- Add targeted options instead:
  - `caseSensitiveRouting`
  - `strictRouting`
  - `xPoweredBy`
  - richer `trustProxy` modes
- If the API grows, then introduce `router.set/get/enable/disable`.

#### 14. Error middleware model is less composable than Express

Expediate has a single global `onError(handler)`. Express supports ordered
4-argument error middleware in the same stack model as regular middleware.

Impact:

- Users cannot have sub-router-specific error behavior.
- Library middleware cannot expose its own error-handling layer.
- Migration from Express code with `app.use((err, req, res, next) => ...)` is
  blocked.

Recommendation:

- Add error middleware registration with `(err, req, res, next)` arity or an
  explicit `router.useError(path?, handler)` API.
- Preserve `onError` as a convenience fallback.
- Add tests for ordered error middleware, nested routers, and async rejections.

#### 15. HEAD and OPTIONS behavior needs an explicit policy

Express normally routes HEAD through GET handlers when a HEAD route is absent.
It does not automatically produce a full 405 matrix for application routes.
Expediate currently has explicit static HEAD support and router-level 405
detection.

Recommendation:

- Decide and document:
  - Should `GET /x` imply `HEAD /x`?
  - Should router automatically answer `OPTIONS` with `Allow`?
  - Should 405 be default, opt-in, or Express-compat opt-out?
- Add compatibility tests for `HEAD`, `OPTIONS`, and 405 behavior.

## Expediate-Specific Product Opportunities

These are not Express parity tasks, but they could make Expediate better than
Express for its intended audience.

### 1. First-class OpenAPI and validation

`apiBuilder` and `openapi.ts` are strong differentiators. The natural next step
is request/response validation based on the same metadata.

Recommendations:

- Add optional schema validation hooks to `describe()` metadata.
- Keep the validator zero-dependency and narrow at first:
  - required object properties
  - primitive types
  - arrays
  - enums
  - min/max length
  - numeric min/max
- Let users swap in a custom validator for full JSON Schema coverage.
- Generate better default OpenAPI from inline regex constraints.

### 2. Better service lifecycle

`apiBuilder` now awaits async setup. Keyed service scopes can still grow forever.

Recommendations:

- Add optional keyed instance eviction:
  - max instances
  - idle TTL
  - explicit `dispose()` hook
- Add diagnostics for current instance count.
- Add tests for concurrent first access and setup failures.

### 3. Git Smart HTTP hardening

Git Smart HTTP is rare in lightweight frameworks and can be a differentiator.

Recommendations:

- Add auth/authorization examples for read vs write access.
- Add repository root confinement helper to prevent path confusion in user
  callbacks.
- Enforce child-process timeout for both upload-pack and receive-pack. Current
  timeout option is passed to `git-upload-pack`, but there is no parent-side
  kill timer for hung child processes.
- Add full clone/fetch/push integration tests with a valid bare fixture when
  `git` is available.

### 4. Production diagnostics

Recommendations:

- Add optional debug logging namespaces or a small diagnostics hook:
  - route match misses
  - parser rejections
  - static cache hits
  - compression decisions
  - rate-limit rejections
- Add a route table formatter for `router.routes()`.
- Add a startup banner only as an opt-in helper, not default behavior.

## Tooling Recommendations

### Benchmark tooling

Yes, benchmark tooling is worth creating.

Why:

- Expediate's main promise is low overhead and zero dependencies.
- Without a benchmark, "lightweight" remains a belief rather than an invariant.
- Compression, static files, and body parsing can regress quietly.

What to build:

- `bench/servers/expediate.ts`
- `bench/servers/express.ts`
- `bench/servers/node-http.ts`
- `bench/runner.ts`
- `bench/scenarios/*.ts`

Initial scenarios:

- hello world plain text
- JSON response
- route param extraction
- 404
- middleware chain of 1, 5, and 20 handlers
- JSON body parsing at 1 KB, 100 KB, and limit rejection
- static file 1 KB, 100 KB, and 1 MB
- compression on/off
- conditional GET 200 vs 304

Metrics:

- requests per second
- latency percentiles p50/p95/p99
- memory RSS
- event loop delay
- CPU time if easy to collect
- package cold-start time

Implementation note:

- Use a Node-based runner first to keep the repo self-contained.
- Optionally support `autocannon` as a dev-only dependency later because it is
  a standard Node HTTP benchmarking tool.
- Record results as JSON and keep a short Markdown summary out of git unless
  intentionally updating baseline numbers.

### Stress-test tooling

Yes, stress-test tooling is useful and different from benchmarks.

Why:

- Benchmarks measure speed under friendly traffic.
- Stress tests find leaks, bad backpressure, request lifecycle bugs, and
  timeout behavior under hostile or long-running traffic.

Initial scenarios:

- 10k sequential requests against one server.
- 1k concurrent keep-alive requests.
- slow body upload with router timeout enabled.
- chunked request without `Content-Length`.
- aborted uploads.
- large rejected bodies at exactly limit, limit+1, and much larger.
- many distinct rate-limit keys to observe map growth.
- compression of many near-threshold responses.
- static file concurrency.
- Git child process failure loops.

Recommended output:

- pass/fail assertions, not just printed metrics.
- memory before/after.
- active handles before/after.
- timeout if the process does not exit cleanly.

### Security and pen-test tooling

Yes, but define it as repeatable security regression testing rather than broad
"penetration testing." A package test suite can catch classes of web framework
bugs, but it cannot certify an app as secure.

Initial security corpus:

- malformed percent encodings
- encoded and raw traversal sequences
- backslash traversal
- NUL bytes in paths and headers where Node allows them
- invalid Host header cases
- double `Content-Length`
- `Content-Length` plus `Transfer-Encoding`
- decompression bombs
- multipart malformed boundaries
- multipart header injection
- static directory listing XSS names
- cookie values with semicolon, comma, spaces, quotes, percent encoding
- signed cookie tampering
- CORS wildcard plus credentials
- CSRF missing, wrong, reused, and body-field variants
- JWT algorithm confusion, expired, not-before, wrong issuer, wrong key
- RegExp route with global/sticky flags

Tooling shape:

- `security/corpus/*.json` for request fixtures.
- `security/runner.ts` to replay requests against minimal test apps.
- Optional OWASP ZAP baseline documentation for user applications, not as a
  default package test.

## Documentation Audit

The documentation is broad, but several areas need tightening.

High-priority docs fixes:

- Body parser content-type behavior must be made consistent across README,
  `docs/mdlw/json.md`, `docs/mdlw/form-data.md`, and tests.
- `json()` docs should not say it attaches a `res.json()` helper unless that
  helper preserves the router's content-type behavior.
- Static docs should describe `indexOf` escaping once fixed.
- JWT docs should make unsafe demo defaults impossible to miss.
- `serveStatic` docs currently mention "redirect to index.html"; this is not a
  trailing slash redirect like Express static, it serves `index.html` directly.
- Express compatibility should be documented as "inspired by / compatible
  subset" until the parity items above are implemented.

Recommended new docs:

- `docs/compatibility.md`: Express API matrix with Supported / Partial / Not
  supported / Intentionally different.
- `docs/security.md`: safe deployment guidance.
- `docs/performance.md`: benchmark methodology and caveats.
- `docs/testing.md`: how to run unit, coverage, benchmark, stress, and security
  suites.

## Package And Release Process

Current scripts:

```json
{
  "clean": "node -e \"require('fs').rmSync('dist', {recursive:true,force:true})\"",
  "build": "tsc && node scripts/build-cjs.cjs",
  "test": "node --import tsx --test 'tests/*.test.ts'"
}
```

Recommended scripts:

```json
{
  "test:coverage": "node --experimental-test-coverage --import tsx --test 'tests/*.test.ts'",
  "test:compat": "node --import tsx --test 'tests/compat/*.test.ts'",
  "test:security": "node --import tsx --test 'tests/security/*.test.ts'",
  "bench": "node --import tsx bench/runner.ts",
  "stress": "node --import tsx stress/runner.ts",
  "prepack": "npm run clean && npm run build && npm test"
}
```

Packaging checks to add:

- `npm pack --dry-run`
- ESM import smoke test from `dist`
- CJS require smoke test from `dist/cjs`
- Type declaration smoke test
- Node LTS matrix in CI

## Compatibility Matrix

Legend:

- Yes: implemented and tested.
- Partial: useful subset exists, but behavior differs or lacks common options.
- No: not implemented.
- Different: intentionally not Express-like or needs product decision.

| Express feature | Expediate status | Notes |
| --- | --- | --- |
| `app.use` / `router.use` | Partial | Prefix mount exists. No `next('router')`, `req.baseUrl`, or mount event. |
| `app.METHOD` / `router.METHOD` | Partial | Method helpers exist but currently prefix-match instead of endpoint-match. |
| `app.all` / `router.all` | Partial | Exists. Same endpoint matching concern. |
| `router.route()` | No | Useful migration helper. |
| `router.param()` | No | Useful for shared param loading/validation. |
| Ordered error middleware | No | Single `onError` only. |
| Async rejected handlers | Yes | Already similar to Express 5 behavior. |
| `next('route')` | No | Currently treated as error. |
| `next('router')` | No | Currently treated as error. |
| `req.params` | Partial | Exists; merged with query params in `req.params`, which differs from Express. |
| `req.query` | No | Data exists as `req.queries.url`. Add alias for migration. |
| `req.body` | Partial | Exists after body middleware. |
| `req.cookies` | Partial | Exists, signed cookies are folded into same object; no `req.signedCookies`. |
| `req.ip` | Partial | Exists with boolean `trustProxy`; no trust proxy function/subnet modes. |
| `req.ips` | No | Add when trust proxy is enabled. |
| `req.baseUrl` | No | Needed for nested routers. |
| `req.get()` / `req.header()` | No | Low-cost helper. |
| `req.is()` | No | Useful with parser `type` behavior. |
| `req.accepts*()` | No | Defer unless content negotiation is a goal. |
| `res.send()` | Partial | Exists but only accepts string-ish data; Express handles Buffer/object/status legacy changes. |
| `res.json()` | Partial | Exists; header bug when `json()` middleware is installed. |
| `res.status()` | Partial | Chainable, but no status-code validation. |
| `res.redirect()` | Partial | Only 302 signature. |
| `res.cookie()` | Partial | Exists; add encoding and `clearCookie`. |
| `res.download()` | Partial | Exists; lacks full Express options/callbacks. |
| `res.type()` | Yes | Basic behavior implemented. |
| `res.set()` / `res.get()` | No | Easy parity win. |
| `res.append()` / `res.vary()` | No | Useful for middleware composition. |
| `res.sendStatus()` | No | Easy parity win. |
| `res.locals` | No | Needed for template-style middleware chains. |
| `res.render()` | No | Defer unless view engines become a goal. |
| `express.json()` | Partial | JSON parser exists; pass-through/type/options differ. |
| `express.raw()` | No | Add as `raw()`. |
| `express.text()` | Partial | `req.text()` and `parseBody` text exist; no middleware factory exported. |
| `express.urlencoded()` | Partial | Flat parser exists; no `extended` mode. |
| `express.static()` | Partial | Strong static implementation; option names/redirect/range behavior differ. |

## Recommended Roadmap

### Milestone 1 - Hardening And Compatibility Baseline

Success criteria:

- Existing tests pass.
- New regression tests cover the P1 issues above.
- `docs/compatibility.md` exists.
- `ROADMAP.md` tracks open tasks by priority.

Tasks:

- Fix method route endpoint matching.
- Catch malformed URL decode in static serving.
- Escape directory listing output.
- Fix or remove `json()` middleware `res.json()` override.
- Reset or reject stateful route regexes.
- Resolve body parser pass-through policy and docs.
- Add `test:coverage`.

### Milestone 2 - Express Migration Ergonomics

Success criteria:

- Common Express route and response helpers work.
- A small Express app can be ported with minimal edits.

Tasks:

- Add `req.query`, `req.get`, `req.hostname`, `req.protocol`, `req.secure`.
- Add `req.baseUrl` for mounted routers.
- Add `res.set`, `res.get`, `res.append`, `res.vary`, `res.location`,
  `res.clearCookie`, `res.sendStatus`, `res.attachment`, and `res.locals`.
- Add `router.route()`.
- Add status-code validation.
- Decide HEAD/OPTIONS/405 compatibility policy.

### Milestone 3 - Error And Middleware Model

Success criteria:

- Express-style error middleware can be mounted globally and per-router.
- `next('route')` and `next('router')` behavior is either implemented or
  explicitly documented as unsupported.

Tasks:

- Add ordered error middleware.
- Add route/router skip semantics.
- Add `router.param()`.
- Add nested-router error propagation tests.

### Milestone 4 - Parser And Static Completeness

Success criteria:

- Body parser behavior is predictable, documented, and composition-friendly.
- Static serving supports the most common production requirements.

Tasks:

- Add `raw()` and `text()` middleware factories.
- Add Brotli request decompression.
- Add parser `type` option and optional verify hook.
- Add byte-range support for static/sendFile/download if desired.
- Add better cookie encoding/decoding.

### Milestone 5 - Measurement And Assurance

Success criteria:

- Benchmarks and stress/security suites can be run locally and in CI.
- Performance claims have a repeatable baseline.

Tasks:

- Add benchmark harness.
- Add stress-test harness.
- Add security corpus tests.
- Add packaging smoke tests.
- Add CI matrix.

## Bottom Line

The package is already useful. To close the Express gap, prioritize semantics
and compatibility before adding more features. To make Expediate stand apart,
turn its zero-dependency design into measurable evidence with benchmarks,
stress tests, and security regression tests. The strongest path is:

1. Fix route/static/body-parser correctness issues.
2. Publish an Express compatibility matrix.
3. Add low-cost request/response helper parity.
4. Build benchmark/stress/security tooling.
5. Expand higher-level Expediate-specific features around OpenAPI validation
   and service lifecycle.
