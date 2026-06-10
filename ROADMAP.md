# Expediate Roadmap

Date: 2026-06-08

This roadmap is distilled from the full audit in [AUDIT.md](AUDIT.md). Keep
`AUDIT.md` as the detailed reasoning document and this file as the execution
checklist.

## Milestone 1 - Hardening And Compatibility Baseline

Goal: remove the highest-risk correctness issues before adding broad new API
surface.

Success criteria:

- Existing `npm test` suite still passes.
- New regression tests cover every item below.
- Body-parser behavior is consistent across source, tests, README, and docs.
- A first `docs/compatibility.md` matrix exists.

Tasks:

- [x] Fix method route endpoint matching so `get('/users')` does not match
  `/users/42`, while `use('/users')` still acts as a prefix mount.
- [x] Catch malformed percent encodings in `serveStatic()` and return a
  controlled `400 Bad Request`.
- [x] Escape text and attributes in `writeIndexOf()` directory listings.
- [ ] Fix or remove the `json()` middleware override of `res.json()` so JSON
  responses always set `Content-Type`.
- [ ] Decide body parser content-type policy: Express-style pass-through or
  strict `415`; update tests and docs accordingly.
- [ ] Reset or reject global/sticky user RegExp route patterns.
- [ ] Add `test:coverage` using Node's native test coverage.

## Milestone 2 - Express Migration Ergonomics

Goal: make small Express apps easier to port without compromising Expediate's
small core.

Success criteria:

- Common Express request/response helpers work.
- A documented migration example runs on Expediate with minimal edits.

Tasks:

- [ ] Add `req.query` alias to `req.queries.url`.
- [ ] Add `req.get()` / `req.header()`.
- [ ] Add `req.hostname`, `req.protocol`, `req.secure`, and `req.ips`.
- [ ] Track `req.baseUrl` through nested routers.
- [ ] Add `res.set()` / `res.header()` and `res.get()`.
- [ ] Add `res.append()`, `res.vary()`, `res.location()`, `res.clearCookie()`,
  `res.sendStatus()`, `res.attachment()`, and `res.locals`.
- [ ] Validate `res.status()` codes as integers in the `100..999` range.
- [ ] Add `router.route(path).get(...).post(...)`.
- [ ] Decide and document `HEAD`, `OPTIONS`, and automatic `405` behavior.

## Milestone 3 - Error And Middleware Model

Goal: close the biggest semantic gap in Express middleware composition.

Success criteria:

- Error behavior can be scoped to routers.
- Express-style error middleware examples can be ported.

Tasks:

- [ ] Add ordered error middleware support, either by 4-argument arity or an
  explicit `router.useError()` API.
- [ ] Preserve `router.onError()` as a simple fallback.
- [ ] Implement or explicitly reject `next('route')`.
- [ ] Implement or explicitly reject `next('router')`.
- [ ] Add `router.param(name, handler)`.
- [ ] Add nested router tests for error propagation and route skipping.

## Milestone 4 - Parser And Static Completeness

Goal: make request parsing and file serving production-complete while staying
dependency-light.

Tasks:

- [ ] Add `raw()` middleware.
- [ ] Add exported `text()` middleware.
- [ ] Add Brotli request decompression.
- [ ] Add parser `type` option and optional verify hook.
- [ ] Improve cookie encoding/decoding for semicolons, quotes, spaces, and
  percent-encoded values.
- [ ] Consider byte-range support for `serveStatic()`, `serveFile()`, and
  `res.download()`.
- [ ] Consider a richer `trustProxy` option beyond boolean.

## Milestone 5 - Measurement And Assurance

Goal: make "lightweight" and "safe" measurable.

Tasks:

- [ ] Add a benchmark harness comparing Expediate, Node `http`, and Express.
- [ ] Cover scenarios: hello world, JSON, params, middleware chains, body
  parsing, static files, compression, 404, and 304.
- [ ] Add stress tests for concurrency, keep-alive, slow uploads, aborted
  uploads, rate-limit key growth, compression thresholds, and static files.
- [ ] Add a security request corpus for malformed URLs, traversal, cookies,
  CORS, CSRF, JWT, multipart, and request-smuggling-adjacent cases.
- [ ] Add package smoke tests for ESM import, CJS require, declarations, and
  `npm pack --dry-run`.
- [ ] Add CI matrix across supported Node versions.

## Later Product Ideas

These are useful, but should wait until the hardening and compatibility baseline
is in place.

- [ ] WebSocket or HTTP upgrade hooks.
- [ ] `create-expediate` / `npx expediate init` scaffold.
- [ ] OpenAPI-backed request and response validation.
- [ ] Keyed `apiBuilder` instance eviction and dispose hooks.
- [ ] Git Smart HTTP auth examples and full clone/fetch/push integration
  tests with valid bare repository fixtures.
- [ ] Cluster or multi-process helper.
