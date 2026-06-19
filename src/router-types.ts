/* Copyright 2021 Fabien Bavent
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
'use strict';

// ---------------------------------------------------------------------------
// Shared router type declarations
// ---------------------------------------------------------------------------
// Extracted from router.ts. Pure type/interface declarations with no runtime
// footprint; the namespace imports below are `import type` so this module emits
// nothing at runtime (and forms no runtime dependency cycle with ./misc).

import type * as http  from 'http';
import type * as https from 'https';
import type * as http2 from 'http2';
import type { BodyOptions, FormPart } from './misc.js';

/** A key-value map of arbitrary string values. */
export type StringMap = Record<string, string>;

/**
 * Options accepted by `createRouter()`.
 */
export interface RouterOptions {
  /**
   * Secret string used to sign and verify signed cookies.
   *
   * Required when any route calls `res.cookie(name, val, { signed: true })`.
   * When absent, attempting to set a signed cookie throws at runtime.
   *
   * @example
   * ```ts
   * const app = createRouter({ secret: process.env.COOKIE_SECRET });
   * app.get('/set', (_req, res) =>
   *   res.cookie('session', 'user-id', { signed: true }).send('ok'));
   * ```
   */
  secret?: string;

  /**
   * Global request timeout in milliseconds.
   *
   * When a request handler does not start writing a response within this
   * period, the socket is marked idle and a **408 Request Timeout** response
   * is sent automatically.  The timeout is reset on every response write.
   *
   * Set to `0` or omit to disable the timeout entirely.
   *
   * @example
   * ```ts
   * const app = createRouter({ timeout: 30_000 }); // 30 s
   * ```
   */
  timeout?: number;

  /**
   * Trust the `X-Forwarded-For` header when resolving `req.ip`.
   *
   * When `true`, `req.ip` is set to the **first** (leftmost) value in the
   * `X-Forwarded-For` header, which is the IP address reported by the
   * outermost client.  This is the correct setting when the server sits behind
   * a reverse proxy (e.g. nginx, AWS ALB) that injects this header.
   *
   * When `false` (default), `req.ip` contains the raw socket remote address
   * and the `X-Forwarded-For` header is ignored.  Use this mode when the
   * server is directly internet-facing to prevent IP spoofing.
   *
   * @default false
   *
   * @example
   * ```ts
   * // Behind a trusted reverse proxy
   * const app = createRouter({ trustProxy: true });
   * app.get('/me', (req, res) => res.send(req.ip));
   * ```
   */
  trustProxy?: boolean;
}

/**
 * Extended HTTP incoming message that carries parsed routing metadata.
 * Augments the standard `http.IncomingMessage` with fields populated by
 * the router before any middleware is invoked.
 */
export interface RouterRequest extends http.IncomingMessage {
  /** The original, unmodified URL string from the HTTP request. */
  originalUrl: string;
  /**
   * The current path being matched. Prefix-style layers (`use`)
   * rewrite this field after matching so that nested routers only see the
   * remaining suffix. Exact-method layers (`all`, `get`, `post`, etc.) leave it
   * untouched so that chained middlewares sharing the same path each match.
   */
  path: string;
  /**
   * Aggregated parameters from all sources.
   * URL query parameters are merged first; named route parameters (from both
   * plain-string and RegExp patterns) override them when a route matches.
   */
  params: StringMap;
  /**
   * Structured query buckets:
   * - `url`   — parameters parsed from the query string.  Repeated keys
   *             (e.g. `?tag=a&tag=b`) produce an array value.
   * - `route` — named parameters captured from the route pattern.
   */
  queries: {
    url?: Record<string, string | string[]>;
    route?: StringMap;
  };
  /**
   * Parsed cookies sent with the request.
   *
   * Values are decoded automatically:
   * - `j:` prefixed values are JSON-parsed and returned as their JS type.
   * - `s:` prefixed values are HMAC-verified using the router secret; if
   *   valid, the inner value (decoded in turn) is returned.  Cookies that
   *   fail verification are **not** included in this map.
   * - Plain string values are returned unchanged.
   */
  cookies: Record<string, unknown>;
  /**
   * The parsed request body, or `undefined` until something populates it.
   *
   * It is set by a body-parsing middleware run ahead of the handler
   * (`json()`, `formData()`, `formEncoded()`, `parseBody()`, …) or, on first
   * call, cached by the promise-based readers {@link RouterRequest.json},
   * {@link RouterRequest.text}, and {@link RouterRequest.formData}.
   *
   * Typed as `unknown` because the shape depends on the parser used (a parsed
   * JS value for JSON, a `string` for text, `FormPart[]` for multipart).
   * Narrow it before use, e.g. `const { name } = req.body as { name: string }`.
   */
  body?: unknown;

  /**
   * Alias for `req.queries.url` — the parsed URL query-string parameters.
   * Mirrors the Express `req.query` property.
   */
  query: Record<string, string | string[]>;

  /**
   * The hostname derived from the `Host` (or `X-Forwarded-Host` when
   * `trustProxy` is enabled) header, with any port suffix stripped.
   */
  hostname: string;

  /**
   * The request protocol: `'https'` when the connection is encrypted (TLS or
   * `X-Forwarded-Proto: https` with `trustProxy` enabled), `'http'` otherwise.
   */
  protocol: string;

  /**
   * `true` when `req.protocol === 'https'`.
   */
  secure: boolean;

  /**
   * Array of IP addresses from the `X-Forwarded-For` header (when
   * `trustProxy` is enabled), ordered from the originating client to the
   * nearest proxy.  Empty array when the header is absent or `trustProxy` is
   * disabled.
   */
  ips: string[];

  /**
   * The URL prefix matched by the nearest `use()` mount point.  Mirrors the
   * Express `req.baseUrl` property.  Starts as `''` and accumulates each
   * stripped prefix as the request traverses nested `use()` routers.
   */
  baseUrl: string;

  /**
   * Read and parse the request body as JSON.
   *
   * Returns the parsed value, or `null` when the request has no body.
   * Rejects with `{ status, message }` on parse or transport errors.
   */
  json(opts?: BodyOptions): Promise<unknown>;

  /**
   * The IP address of the remote client.
   *
   * - When the router is created with `{ trustProxy: true }`, this is the
   *   **first** value from the `X-Forwarded-For` header (the originating
   *   client address as reported by the proxy chain).
   * - Otherwise this is the raw TCP socket remote address
   *   (`req.socket?.remoteAddress`), which cannot be spoofed by the client.
   *
   * Always an empty string when neither source is available.
   */
  ip: string;

  /**
   * Read and decode the request body as plain text.
   *
   * Returns the body string (decoded using the charset in `Content-Type`,
   * defaulting to UTF-8), or `null` when the request has no body.
   * Rejects with `{ status, message }` on transport errors.
   */
  text(opts?: BodyOptions): Promise<string | null>;

  /**
   * Read and parse the request body as `multipart/form-data`.
   *
   * Returns an array of {@link FormPart} objects, or `null` when the request
   * has no body.  Rejects with `{ status, message }` on parse or transport
   * errors.
   */
  formData(opts?: BodyOptions): Promise<FormPart[] | null>;

  /**
   * Return the value of a request header by name (case-insensitive).
   *
   * A thin convenience over `req.headers`: the lookup is lowercased, and the
   * `Referer`/`Referrer` spelling variants are treated as equivalent. Returns
   * `undefined` when the header is absent.
   *
   * @param name - The header name (any case).
   * @returns The header value (`string`, or `string[]` for repeated headers
   *          like `Set-Cookie`), or `undefined`.
   *
   * @example
   * ```ts
   * const ua = req.header('User-Agent');
   * ```
   */
  header(name: string): string | string[] | undefined;
}

/**
 * Extended HTTP server response with convenience helpers.
 * Augments the standard `http.ServerResponse`.
 */
export interface RouterResponse extends http.ServerResponse {
  /**
   * Write `data` (if provided) and end the response.
   * Equivalent to `res.write(data); res.end()`.
   */
  send(data?: string): void;

  /** Serialise `data` as JSON, set `Content-Type: application/json`, and end. */
  json(data: unknown): void;

  /**
   * Set the HTTP status code and optional response headers, then return
   * `this` so calls can be chained (e.g. `res.status(404).end(...)`).
   */
  status(code: number, headers?: StringMap): this;

  /** Redirect the client to `url` with a 302 Found response. */
  redirect(url: string): void;

  /**
   * Append a `Set-Cookie` header for the given `name`/`value` pair.
   * Returns `this` to allow chaining.
   */
  cookie(name: string, value: string | object, options?: CookieOptions): this;

  /**
   * Trigger a file download in the client's browser.
   *
   * Sets the `Content-Disposition: attachment` header (which prompts a
   * "Save As" dialog in browsers), then streams the file at `filepath` using
   * {@link sendFile}.
   *
   * @param filepath - Absolute or relative filesystem path to the file to send.
   * @param filename - Override the file name advertised to the browser.
   *   Defaults to `path.basename(filepath)`.
   *
   * @example
   * ```ts
   * app.get('/invoice', (_req, res) =>
   *   res.download('/var/reports/2024-Q1.pdf', 'invoice-2024-Q1.pdf'));
   * ```
   */
  download(filepath: string, filename?: string): void;

  /**
   * Set the `Content-Type` response header and return `this` for chaining.
   *
   * The value is set verbatim — include the charset when needed
   * (e.g. `'text/html; charset=utf-8'`).
   *
   * @param mime - The MIME type string to set.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * res.type('text/csv').send(csvData);
   * res.type('application/octet-stream').send(binaryData);
   * ```
   */
  type(mime: string): this;

  /**
   * Set the `ETag` response header.
   *
   * By default a **weak** ETag is produced (`W/"value"`), which indicates that
   * the two representations are semantically equivalent but not byte-for-byte
   * identical.  Pass `true` as the second argument for a **strong** ETag
   * (`"value"`), which implies byte-level equivalence and is required when
   * byte-range requests must be validated.
   *
   * Returns `this` so calls can be chained before `res.send()` or `res.json()`.
   *
   * @param value  - The opaque ETag value (without quotes or `W/` prefix).
   * @param strong - When `true`, produce a strong ETag.  Defaults to `false`.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * // Weak ETag (default) — most appropriate for dynamic responses
   * res.etag(user.updatedAt.toISOString()).json(user);
   *
   * // Strong ETag — use when the response body is content-addressed
   * res.etag(sha256hex, true).send(fileContent);
   * ```
   */
  etag(value: string, strong?: boolean): this;

  /**
   * Set a response header to `value`, replacing any existing value.
   * A chainable wrapper over the native `res.setHeader()`, consistent with the
   * other `res.*` helpers (and matching Fastify's `reply.header()`).
   * Returns `this` for chaining.
   *
   * @param field - The header name.
   * @param value - The header value (`string`, or `string[]` for multi-value
   *                headers like `Set-Cookie`).
   *
   * @example
   * ```ts
   * res.header('Cache-Control', 'no-store').json(data);
   * ```
   */
  header(field: string, value: string | number | string[]): this;

  /**
   * Append a value to a response header, creating it if it does not exist.
   * When the header already exists, the new value is appended (comma-joined
   * for most headers; `Set-Cookie` accumulates as an array).
   * Returns `this` for chaining.
   */
  append(field: string, value: string | string[]): this;

  /**
   * Add the given field(s) to the `Vary` response header.
   * Existing values are preserved; duplicates are skipped.
   * Returns `this` for chaining.
   */
  vary(field: string | string[]): this;

  /**
   * Set the `Location` response header.
   * Returns `this` for chaining.
   */
  location(url: string): this;

  /**
   * Clear a cookie by name by setting its `Max-Age` to `0` and `Expires` to
   * the Unix epoch.  Any `path` or `domain` options passed must match those
   * used when the cookie was originally set.
   * Returns `this` for chaining.
   */
  clearCookie(name: string, options?: CookieOptions): this;

  /**
   * Send a response whose body is the standard HTTP status message for `code`.
   * Sets the status code, `Content-Type: text/plain`, and ends the response.
   */
  sendStatus(code: number): void;

  /**
   * Set `Content-Disposition: attachment` with an optional filename.
   * When `filename` is provided, the `Content-Type` header is also set based
   * on the file extension.
   * Returns `this` for chaining.
   */
  attachment(filename?: string): this;

  /**
   * A plain object for storing response-scoped data shared between middleware
   * and route handlers within a single request/response cycle.
   * Mirrors the Express `res.locals` property.
   */
  locals: Record<string, unknown>;
}

/** Options accepted by `res.cookie()`. */
export interface CookieOptions {
  /**
   * Sign the cookie value with HMAC-SHA256 using the router's `secret`.
   * Requires `secret` to be passed to `createRouter()`.
   */
  signed?: boolean;
  /** Expiry date for the cookie. */
  expires?: Date;
  /** Max age in milliseconds; converted to seconds in the `Set-Cookie` header. */
  maxAge?: number;
  /** Cookie path (defaults to `'/'`). */
  path?: string;
  /** Marks the cookie as `HttpOnly` (not accessible via `document.cookie`). */
  httpOnly?: boolean;
  /** Marks the cookie as `Secure` (only sent over HTTPS). */
  secure?: boolean;
  /** `SameSite` attribute value (`'Strict'`, `'Lax'`, or `'None'`). */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Options for HTTPS / HTTP/2 servers passed to `router.listen()`.
 *
 * When both `key` and `cert` are present, `listen()` creates a TLS server.
 * Setting `http2: true` additionally upgrades to HTTP/2 (`http2.createSecureServer`).
 */
export interface TlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  /**
   * When `true`, an HTTP/2 secure server (`http2.createSecureServer`) is
   * created instead of an HTTPS/1.1 server.  Requires `key` and `cert`.
   * The existing middleware API is compatible with HTTP/2 request/response
   * objects at runtime.
   */
  http2?: boolean;
  [key: string]: unknown;
}

/**
 * A middleware function. Receives the current request and response objects
 * and a `next` callback to hand control to the next registered middleware.
 */
export type Middleware = (
  req: RouterRequest,
  res: RouterResponse,
  next: NextFunction,
) => void;

/**
 * Callback used to pass control to the next matching middleware.
 *
 * When called **without** arguments (or with `undefined`), the router
 * continues to the next matching layer as usual.
 *
 * When called **with** a non-null argument, the argument is treated as an
 * error: remaining middleware and routes are skipped and the handler
 * registered via {@link Router.onError} is invoked.  If no error handler
 * has been registered, a plain **500** response is sent.
 *
 * @example
 * ```ts
 * router.use('/protected', (req, _res, next) => {
 *   if (!req.headers.authorization) return next(new Error('Unauthorized'));
 *   next(); // proceed normally
 * });
 * ```
 */
export type NextFunction = (err?: unknown) => void;

/**
 * Handler invoked when a middleware throws, an async middleware rejects,
 * or `next(err)` is called with a non-null argument.
 *
 * Register it with {@link Router.onError}.
 *
 * @param err - The thrown value or the argument passed to `next()`.
 * @param req - The current request.
 * @param res - The current response (not yet ended — the handler must end it).
 */
export type ErrorHandler = (
  err: unknown,
  req: RouterRequest,
  res: RouterResponse,
) => void;

/**
 * An ordered error-handling middleware, registered with {@link Router.error}.
 *
 * Unlike a regular {@link Middleware}, the error value is the **first**
 * argument — a deliberate signal that this function runs on the error channel,
 * not the normal request pipeline.
 *
 * The handler may either end the response (handling the error) or call `next`
 * to pass control along the error channel:
 * - `next()` — forward the **same** error to the next error middleware.
 * - `next(newErr)` — forward a **replacement** error instead.
 *
 * When the error-middleware chain is exhausted without ending the response,
 * the router falls back to the {@link Router.onError} handler (if any), and
 * otherwise bubbles the error to the parent router's error channel. A
 * top-level router with no handler sends a plain **500**.
 *
 * @param err  - The thrown value, rejection reason, or `next(err)` argument.
 * @param req  - The current request.
 * @param res  - The current response (not yet ended — the handler must end it
 *   unless it forwards via `next`).
 * @param next - Forward control along the error channel.
 *
 * @example
 * ```ts
 * app.error((err, _req, res, next) => {
 *   if ((err as any)?.status === 404) return res.status(404).end('Not here');
 *   next(err); // not ours — let the next handler (or the parent) deal with it
 * });
 * ```
 */
export type ErrorMiddleware = (
  err: unknown,
  req: RouterRequest,
  res: RouterResponse,
  next: NextFunction,
) => void;

/**
 * A value that can be registered as a route handler: a single `Middleware`
 * function, a `Router` instance (whose `listener` will be used), or an array
 * of either. Arrays may not be nested.
 */
export type MiddlewareArg = Middleware | Router | (Middleware | Router)[];

/**
 * Sanitised description of a single registered route, as returned by
 * {@link Router.routes}.
 */
export interface RouteInfo {
  /** HTTP method this layer is restricted to, or `null` for any method. */
  method: string | null;
  /** The original path pattern as supplied by the caller. */
  path: string | RegExp;
  /**
   * `true` for prefix-style (`use`) registrations where the matched prefix
   * is stripped from `req.path`; `false` for exact-method routes.
   */
  stripPath: boolean;
}

/**
 * Internal representation of a single registered route.
 * One layer is created per middleware function for every `router.get(...)` /
 * `router.use(...)` etc. call, and stored in the route table.
 */
export interface Layer {
  /** HTTP method this layer is restricted to, or `null` for any method. */
  method: string | null;
  /** The original path pattern supplied by the caller. */
  path: string | RegExp;
  /**
   * The compiled `RegExp` used for matching, regardless of whether the
   * original `path` was a plain string, a glob, or already a `RegExp`.
   *
   * - Plain strings (e.g. `'/users/:id'`) are compiled with named capture
   *   groups so that `:id` becomes `(?<id>[^/]+)`.
   * - Glob strings (e.g. `'/**\/*.php'`) are compiled following `.gitignore`
   *   wildcard rules.
   * - `RegExp` values are stored as-is; named groups are surfaced directly
   *   as route parameters.
   */
  regex: RegExp;
  /**
   * When `true`, the portion of `req.path` consumed by `layer.regex` is
   * stripped before invoking the middleware, exposing only the remaining
   * suffix to nested routers.
   *
   * Set to `true` for prefix-style registrations (`use`) and
   * `false` for exact-method routes (`all`, `get`, `post`, etc.). Stripping on
   * exact-match routes would break chained middlewares sharing the same path,
   * because each subsequent layer would see a truncated path that no longer
   * matches its own pattern.
   */
  stripPath: boolean;
  /** The middleware function to invoke when the layer matches. */
  middleware: Middleware;
}

/**
 * Fluent helper returned by {@link Router.route} that registers several
 * HTTP-method handlers against a single, cached path.
 *
 * Each method forwards to the equivalent {@link Router} registration function
 * with the captured path and returns the same builder, so calls can be chained.
 *
 * ```ts
 * app.route('/users/:id')
 *   .get(getUser)
 *   .put(replaceUser)
 *   .delete(removeUser);
 * ```
 */
export interface RouteBuilder {
  /** Register middleware for all HTTP methods (see {@link Router.all}). */
  all(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `GET` requests. */
  get(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `PUT` requests. */
  put(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `POST` requests. */
  post(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `DELETE` requests. */
  delete(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `PATCH` requests. */
  patch(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `HEAD` requests. */
  head(...args: MiddlewareArg[]): RouteBuilder;
  /** Register middleware for `OPTIONS` requests. */
  options(...args: MiddlewareArg[]): RouteBuilder;
}

/**
 * The public interface of the object returned by `createRouter()`.
 *
 * All route-registration methods share the same uniform signature: a mandatory
 * `path` argument followed by any number of `MiddlewareArg` values.
 * A `MiddlewareArg` may be a `Middleware` function, a `Router` instance
 * (whose `listener` is used automatically), or an array of either.
 */
export interface Router {
  /**
   * The path prefix this router was created with, if any.
   *
   * Set by passing a string as the first argument to `createRouter()`:
   * ```ts
   * const v1 = createRouter('/api/v1');
   * console.log(v1.prefix); // '/api/v1'
   * ```
   * When a prefixed router is passed to `parent.use(v1)`, the parent uses
   * this prefix as the mount path automatically.
   */
  readonly prefix?: string;

  /**
   * Register prefix-style middleware scoped to `path`.
   *
   * The matched path prefix is stripped from `req.path` before the middleware
   * runs, so nested routers only see the remaining suffix.
   * Equivalent to Express's `app.use()`.
   *
   * **No-path shortcut:** when the first argument is a `Router` or `Middleware`
   * (not a string or RegExp), the path defaults to the router's own
   * {@link prefix} (or `'/'` if no prefix was set).  This lets you mount a
   * prefixed sub-router without repeating the path:
   *
   * ```ts
   * const v1 = createRouter('/api/v1');
   * v1.get('/users', handler);
   * app.use(v1); // same as app.use('/api/v1', v1)
   * ```
   */
  use(path: string | RegExp | MiddlewareArg, ...args: MiddlewareArg[]): void;

  /**
   * Register middleware for all HTTP methods without stripping `req.path`.
   * Unlike `use`, the full path remains visible to every chained middleware.
   */
  all(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /** Register middleware for `GET` requests. */
  get(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /** Register middleware for `PUT` requests. */
  put(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /** Register middleware for `POST` requests. */
  post(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /** Register middleware for `DELETE` requests. */
  delete(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /** Register middleware for `PATCH` requests. */
  patch(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /**
   * Register middleware for `HEAD` requests.
   *
   * Note: `HEAD` requests are already served automatically by a matching `GET`
   * route (with the body suppressed).  Register a `head()` handler only when
   * you need `HEAD`-specific behaviour; if both exist, the one registered first
   * wins.
   */
  head(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /**
   * Register middleware for `OPTIONS` requests.
   *
   * Takes precedence over the automatic `204` + `Allow` response, which only
   * fires when no `OPTIONS` layer (or `cors()`/`use()` middleware) handled the
   * request.
   */
  options(path: string | RegExp, ...args: MiddlewareArg[]): void;

  /**
   * Return a {@link RouteBuilder} bound to `path` for registering several
   * HTTP-method handlers without repeating the path.
   *
   * The builder simply forwards each call to the matching method-registration
   * function (`get`, `post`, …) with the cached `path`, so the routing
   * behaviour is identical to calling those methods directly.
   *
   * @param path - Path pattern shared by all handlers registered on the builder.
   *
   * @example
   * ```ts
   * app.route('/users/:id')
   *   .get(getUser)
   *   .put(replaceUser)
   *   .delete(removeUser);
   * ```
   */
  route(path: string | RegExp): RouteBuilder;

  /**
   * Register a global error handler for this router.
   *
   * The handler is called whenever:
   * - A middleware throws synchronously.
   * - An `async` middleware returns a rejected `Promise`.
   * - Any middleware calls `next(err)` with a non-null argument.
   *
   * Only one handler is active at a time; subsequent calls replace the
   * previous one.  The handler **must** end the response.
   *
   * @example
   * ```ts
   * app.onError((err, _req, res) => {
   *   const status = (err as any)?.status ?? 500;
   *   res.status(status).json({ error: String(err) });
   * });
   * ```
   */
  onError(handler: ErrorHandler): void;

  /**
   * Register an ordered error-handling middleware for this router.
   *
   * Error middlewares run, in registration order, whenever a middleware throws,
   * an `async` middleware rejects, or `next(err)` is called. Each handler may
   * end the response or call `next` to forward control along the error channel
   * (see {@link ErrorMiddleware}).
   *
   * Resolution order when an error occurs:
   * 1. Every `error()` handler in turn, until one ends the response.
   * 2. If the chain is exhausted, the {@link Router.onError} fallback (if set).
   * 3. Otherwise the error **bubbles to the parent router** (the one that
   *    mounted this router via `use()`), entering its error channel.
   * 4. A top-level router with no handler sends a plain **500**.
   *
   * This bubbling is what lets a single error handler on the root router catch
   * failures raised deep inside nested sub-routers.
   *
   * @example
   * ```ts
   * // Child: handle only what it owns, let the rest bubble up.
   * child.error((err, _req, res, next) => {
   *   if ((err as any)?.code === 'CHILD') return res.status(400).end('bad');
   *   next(err);
   * });
   *
   * // Root: final safety net for everything that bubbled up.
   * app.error((err, _req, res) =>
   *   res.status((err as any)?.status ?? 500).json({ error: String(err) }));
   * ```
   */
  error(handler: ErrorMiddleware): void;

  /**
   * Return a read-only snapshot of all routes registered on this router.
   *
   * Useful for tooling, documentation generation, and debugging.  The array
   * is a fresh copy — mutating it does not affect the live route table.
   *
   * @returns An array of {@link RouteInfo} objects, one per registered layer,
   *   in registration order.
   *
   * @example
   * ```ts
   * app.get('/users', handler);
   * app.post('/users', handler);
   * console.log(app.routes());
   * // [
   * //   { method: 'GET',  path: '/users', stripPath: false },
   * //   { method: 'POST', path: '/users', stripPath: false },
   * // ]
   * ```
   */
  routes(): RouteInfo[];

  /**
   * Gracefully shut down the HTTP(S) server created by `router.listen()`.
   *
   * Stops accepting new connections and waits for all existing connections to
   * close naturally.  After `timeout` milliseconds, any remaining sockets are
   * forcibly destroyed so the process is not kept alive indefinitely.
   *
   * If `router.listen()` was never called on this router (e.g. it is a
   * sub-router mounted inside a parent), `shutdown()` resolves immediately
   * without doing anything.
   *
   * @param timeout - Grace period in milliseconds before sockets are forcibly
   *   destroyed.  Defaults to `5000`.  Pass `0` to skip the forced teardown.
   * @returns A `Promise` that resolves when the server has fully stopped.
   *
   * @example
   * ```ts
   * const app = createRouter();
   * app.listen(3000);
   * process.on('SIGTERM', () => app.shutdown(10_000));
   * ```
   */
  shutdown(timeout?: number): Promise<void>;

  /**
   * Start listening on the given port and return the underlying server instance.
   *
   * When `opts` contains both `key` and `cert`:
   * - An **HTTPS** server is created (TLS, HTTP/1.1).
   * - Setting `opts.http2 = true` additionally upgrades to **HTTP/2**
   *   (`http2.createSecureServer`).
   *
   * When `opts` is absent or contains neither key nor cert, a plain **HTTP**
   * server is used.
   *
   * @returns The underlying server instance.  Use it for graceful shutdown,
   *   port discovery, or attaching additional event listeners.
   *
   * @example
   * ```ts
   * // Discover the OS-assigned ephemeral port
   * const server = router.listen(0, () => {
   *   const { port } = server.address() as AddressInfo;
   *   console.log(`Listening on port ${port}`);
   * });
   * ```
   */
  listen(
    port: number,
    opts?: TlsOptions | (() => void),
    cb?: () => void,
  ): http.Server | https.Server | http2.Http2SecureServer;

  /**
   * The underlying `(req, res, next)` function, allowing this router to be
   * mounted as middleware inside another router:
   * `parent.use('/api', child)`.
   */
  readonly listener: Middleware;
}
