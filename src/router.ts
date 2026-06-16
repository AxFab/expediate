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

import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as http   from 'http';
import * as https  from 'https';
import * as http2  from 'http2';
import * as net    from 'net';
import * as path   from 'path';
import { BodyOptions, FormPart, parseMultipartBody, extractCharset, readReqBody } from './misc.js';
import { mime, serveFile } from './static.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A key-value map of arbitrary string values. */
type StringMap = Record<string, string>;

/**
 * Options accepted by `createRouter()`.
 */
interface RouterOptions {
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
interface RouterRequest extends http.IncomingMessage {
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
   *
   */
  body?: any;

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
  json(opts?: BodyOptions): Promise<unknown | null>;

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
}

/**
 * Extended HTTP server response with convenience helpers.
 * Augments the standard `http.ServerResponse`.
 */
interface RouterResponse extends http.ServerResponse {
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
interface CookieOptions {
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
interface TlsOptions {
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
type Middleware = (
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
type NextFunction = (err?: unknown) => void;

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
type ErrorHandler = (
  err: unknown,
  req: RouterRequest,
  res: RouterResponse,
) => void;

/**
 * A value that can be registered as a route handler: a single `Middleware`
 * function, a `Router` instance (whose `listener` will be used), or an array
 * of either. Arrays may not be nested.
 */
type MiddlewareArg = Middleware | Router | (Middleware | Router)[];

/**
 * Sanitised description of a single registered route, as returned by
 * {@link Router.routes}.
 */
interface RouteInfo {
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
interface Layer {
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
interface RouteBuilder {
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
}

/**
 * The public interface of the object returned by `createRouter()`.
 *
 * All route-registration methods share the same uniform signature: a mandatory
 * `path` argument followed by any number of `MiddlewareArg` values.
 * A `MiddlewareArg` may be a `Middleware` function, a `Router` instance
 * (whose `listener` is used automatically), or an array of either.
 */
interface Router {
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
   * Register a custom handler for requests that match no registered route.
   *
   * When no route matches and no `done()` callback was supplied to the
   * listener, this handler is invoked instead of the built-in
   * `Cannot METHOD /path` 404 response.
   *
   * Registering a not-found handler is an explicit, documented alternative to
   * the `app.all('*', handler)` workaround — without the subtle path-stripping
   * interactions that glob `use()` layers introduce.
   *
   * @example
   * ```ts
   * app.setNotFound((_req, res) =>
   *   res.status(404).json({ error: 'Not Found' }));
   * ```
   */
  setNotFound(handler: Middleware): void;

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

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

/**
 * Determine whether a path string contains glob characters (`*` or `?`).
 *
 * A pattern is considered a glob when it contains at least one unescaped
 * `*` or `?` character, following the same convention as `.gitignore`.
 *
 * @param pattern - The path string to inspect.
 * @returns `true` if the pattern should be treated as a glob.
 */
function isGlobPattern(pattern: string): boolean {
  // Walk character-by-character, skipping over :name(constraint) segments so
  // that regex metacharacters (e.g. '?') inside inline constraints are not
  // mistaken for glob wildcards.
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') { i += 2; continue; }          // escaped — skip next char
    if (ch === ':') {
      i++;
      while (i < pattern.length && /\w/.test(pattern[i])) i++; // skip param name
      if (i < pattern.length && pattern[i] === '(') {
        // Skip balanced constraint parens so their '?' / '*' are not counted.
        let depth = 1; i++;
        while (i < pattern.length && depth > 0) {
          if (pattern[i] === '\\') { i += 2; continue; }
          if (pattern[i] === '(') depth++;
          else if (pattern[i] === ')') depth--;
          i++;
        }
      }
      continue;
    }
    if (ch === '*' || ch === '?') return true;
    i++;
  }
  return false;
}

/**
 * Compile a `.gitignore`-style glob string into a prefix-anchored `RegExp`.
 *
 * Supported wildcard syntax:
 * - `?`  — matches exactly one character that is not `/`.
 * - `*`  — matches zero or more characters that are not `/`.
 * - `**` — matches zero or more path segments (any characters including `/`).
 *
 * The returned expression is anchored at the start (`^`) so it always matches
 * a prefix of the current path; the matched portion is stripped by
 * `matchRouteLayer` when `layer.stripPath` is `true`.
 *
 * @param glob - The glob pattern to compile.
 * @returns A prefix-anchored `RegExp`.
 *
 * @example
 * ```ts
 * compileGlob('/**\/*.php').test('/admin/index.php'); // true
 * compileGlob('/api/*')    .test('/api/users');       // true
 * compileGlob('/api/*')    .test('/api/users/123');   // false
 * ```
 */
function compileGlob(glob: string, exact = false): RegExp {
  // Escape all regex special characters, leaving our wildcard characters intact.
  let src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace in order: `**` must be handled before `*`.
  src = src
    .replace(/\*\*/g, '\x00GLOBSTAR\x00') // temporary placeholder
    .replace(/\*/g, '[^/]*')              // single-segment wildcard
    .replace(/\?/g, '[^/]')              // single-character wildcard
    .replace(/\x00GLOBSTAR\x00/g, '.*'); // cross-segment wildcard

  return new RegExp('^' + src + (exact ? '$' : ''));
}

/**
/**
 * Extract the content between a balanced pair of parentheses starting at
 * `openIdx` in `str`, skipping backslash-escaped characters.
 *
 * Returns the inner pattern and the index of the closing `)` so callers can
 * inspect any literal suffix that follows the constraint (e.g. `\.txt` in
 * `:name([\w-]+)\.txt`).
 *
 * @param str     - The full segment string, e.g. `':id(\\d+)'`.
 * @param openIdx - Index of the opening `(`.
 * @returns `{ pattern, closeIdx }` — the inner pattern string and the index
 *   of the matching `)`.
 * @throws {SyntaxError} When parentheses are unbalanced.
 */
function extractInlinePattern(str: string, openIdx: number): { pattern: string; closeIdx: number } {
  let depth = 0;
  let i = openIdx;
  for (; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; } // skip escape sequences
    if (str[i] === '(')  { depth++; continue; }
    if (str[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0)
    throw new SyntaxError(`Unbalanced parentheses in route segment '${str}'`);
  return { pattern: str.slice(openIdx + 1, i), closeIdx: i };
}

/**
 * Compile a plain path string with optional `:name` parameter segments into a
 * prefix-anchored `RegExp` that uses named capture groups.
 *
 * **Basic parameters** — Each `:name` segment is converted to
 * `(?<name>[^/]+)`, matching any non-slash sequence.
 *
 * **Inline constraints** — A parameter may optionally be followed by a
 * parenthesised regex pattern: `:name(pattern)`. The pattern replaces the
 * default `[^/]+` body, so only paths where that segment matches the
 * constraint will be routed to the handler.
 *
 * ```
 * :id          →  (?<id>[^/]+)      (any non-slash value)
 * :id(\d+)     →  (?<id>\d+)        (digits only)
 * :slug([\w-]+) → (?<slug>[\w-]+)   (word chars and hyphens)
 * ```
 *
 * Literal segments are regex-escaped and matched exactly. The expression
 * matches up to a segment boundary (`/` or end-of-string) so that `/users`
 * never inadvertently matches `/users-admin`.
 *
 * @param path - A plain path string such as `'/users/:id(\d+)/posts'`.
 * @returns A prefix-anchored `RegExp` with named groups for each parameter.
 * @throws {SyntaxError} When an inline constraint is malformed, contains
 *   named capture groups (which conflict with the outer wrapper), or produces
 *   an invalid `RegExp`.
 *
 * @example
 * ```ts
 * const re = compilePlainPath('/users/:id(\\d+)');
 * re.test('/users/42');  // true
 * re.test('/users/abc'); // false
 * re.exec('/users/7')?.groups; // { id: '7' }
 * ```
 */
function compilePlainPath(path: string, exact = false): RegExp {
  const segments = path.split('/').filter((s) => s.length > 0);
  const src = segments
    .map((seg) => {
      if (!seg.startsWith(':'))
        return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escaped literal

      // Parameter segment: extract name and optional inline constraint.
      const parenIdx = seg.indexOf('(', 1);
      if (parenIdx === -1) {
        // Plain :name — match any non-slash sequence.
        return `(?<${seg.slice(1)}>[^/]+)`;
      }

      // :name(pattern) — optionally followed by a literal suffix, e.g. \.txt
      const name = seg.slice(1, parenIdx);
      if (!name)
        throw new SyntaxError(`Route parameter missing name before '(' in segment '${seg}'`);

      const { pattern, closeIdx } = extractInlinePattern(seg, parenIdx);

      // Named capture groups inside the constraint conflict with the outer
      // (?<name>…) wrapper and would cause duplicate-group errors.
      if (/\(\?<[^>]+>/.test(pattern))
        throw new SyntaxError(
          `Inline constraint for ':${name}' must not contain named capture groups.`,
        );

      // Any literal characters after the closing ')' are regex-escaped and
      // appended — e.g. ':name([\\w-]+)\\.txt' → '(?<name>[\\w-]+)\\.txt'.
      const suffix        = seg.slice(closeIdx + 1);
      const escapedSuffix = suffix.replace(/[.+^${}()|[\]\\]/g, '\\$&');

      return `(?<${name}>${pattern})${escapedSuffix}`;
    })
    .join('/');

  // Validate and return — surface any regex syntax errors as SyntaxError.
  try {
    return new RegExp(exact
      ? '^/?' + src + (src ? '/?' : '') + '$'
      : '^/?' + src + '(?=/|$)');
  } catch (e) {
    throw new SyntaxError(
      `Invalid inline regex constraint in path '${path}': ${(e as Error).message}`,
    );
  }
}

/**
 * Convert any supported path pattern into the single canonical `RegExp`
 * used by `matchRouteLayer`.
 *
 * | Input type   | Strategy                                              |
 * |--------------|-------------------------------------------------------|
 * | Glob string  | {@link compileGlob} — `.gitignore`-style wildcards    |
 * | Plain string | {@link compilePlainPath} — `:name` or `:name(re)` → named groups |
 * | `RegExp`     | Used as-is; named groups are surfaced as params       |
 *
 * @param path - The raw path pattern supplied by the caller.
 * @returns A `RegExp` suitable for use in `matchRouteLayer`.
 */
function compilePattern(path: string | RegExp, exact = false): RegExp {
  if (path instanceof RegExp) return path;
  if (isGlobPattern(path))    return compileGlob(path, exact);
  return compilePlainPath(path, exact);
}

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/**
 * Build a `Layer` that represents a single registered route entry.
 *
 * The `path` argument may be a plain string with `:name` parameters, a glob
 * string, or a `RegExp`. In all three cases the pattern is pre-compiled into
 * a single `RegExp` stored as `layer.regex`.
 *
 * @param method     - HTTP method to restrict this layer to (uppercased), or
 *                     `null` to match any method.
 * @param path       - URL path pattern (plain string, glob, or `RegExp`).
 * @param middleware - The middleware function to invoke on a match.
 * @param stripPath  - When `true`, the matched prefix is stripped from
 *                     `req.path` before the middleware runs. Pass `true` for
 *                     prefix/`use` registrations and `false` for exact-method
 *                     routes so that chained middlewares sharing the same path
 *                     can each match in turn.
 * @returns A fully initialised `Layer` ready to be pushed into the route table.
 * @throws {TypeError} When `middleware` is not a callable function.
 */
function buildRouteLayer(
  method: string | null,
  path: string | RegExp,
  middleware: Middleware,
  stripPath: boolean,
): Layer {
  if (typeof middleware !== 'function')
    throw new TypeError('Incorrect middleware type: expected a function');

  // Reject RegExp patterns with the global (g) or sticky (y) flag.
  // Both flags make RegExp.exec()/test() stateful: lastIndex advances after
  // each match, so the same regex object alternates match/no-match across
  // requests, causing intermittent 404s that are nearly impossible to debug.
  // Express 4 silently allowed this (a known footgun); we reject it early.
  if (path instanceof RegExp && (path.global || path.sticky))
    throw new TypeError(
      `Route RegExp /${path.source}/${path.flags} must not use the g (global) or y (sticky) flag — ` +
      'these flags make exec() stateful and cause intermittent routing failures.',
    );

  return { method, path, regex: compilePattern(path, !stripPath), stripPath, middleware };
}

// ---------------------------------------------------------------------------
// Layer matching
// ---------------------------------------------------------------------------

/**
 * Test whether an incoming request matches the given layer and, on success,
 * mutate `req` to reflect the match.
 *
 * All pattern types (plain string, glob, `RegExp`) are handled identically
 * through `layer.regex`. Named capture groups in the match result are merged
 * into `req.params` and `req.queries.route`.
 *
 * Path stripping is conditional on `layer.stripPath`:
 * - `true`  (prefix routes) — the matched prefix is removed from `req.path`
 *   so nested routers only see the remaining suffix.
 * - `false` (exact-method routes) — `req.path` is left unchanged so that
 *   subsequent chained middlewares sharing the same pattern can still match.
 *
 * @param layer - The layer to test.
 * @param req   - The incoming request (mutated in-place on a successful match).
 * @param path  - The current value of `req.path` to test against.
 * @returns `true` if the layer matches and `req` has been updated;
 *          `false` otherwise.
 */
function matchRouteLayer(
  layer: Layer,
  req: RouterRequest,
  path: string,
): boolean {
  if (layer.method && layer.method !== req.method) return false;

  const m = layer.regex.exec(path);
  if (m === null) return false;

  const captured: StringMap = (m.groups as StringMap | undefined) ?? {};

  // Only rewrite req.path for prefix-style (use) registrations.
  // Exact-method routes leave req.path intact so chained middlewares
  // sharing the same path each see the full, unmodified path.
  if (layer.stripPath) {
    req.path = path.slice(m[0].length) || '/';
  }

  req.queries.route = captured;
  Object.assign(req.params, captured);

  return true;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Decode a raw cookie value, stripping the `j:` prefix and JSON-parsing the
 * payload when present.  Plain string values are returned unchanged.
 *
 * @param raw - The raw cookie value as it appears after the `=` in the header.
 * @returns The decoded value: a JS value for `j:` cookies, or the raw string.
 */
function decodeJsonCookie(raw: string): unknown {
  if (!raw.startsWith('j:')) return raw;
  try {
    return JSON.parse(raw.slice(2));
  } catch {
    return raw; // malformed JSON — fall back to raw string
  }
}

/**
 * Percent-encode a cookie value for safe transport in a `Set-Cookie` header.
 *
 * RFC 6265 forbids whitespace, double quotes, commas, semicolons, and
 * backslashes in a bare cookie value.  `encodeURIComponent` escapes all of
 * these (and the `:` / `{` / `}` / `"` produced by the `s:` and `j:` wire
 * formats), and {@link decodeCookieValue} reverses it on the way in.
 *
 * @param value - The raw cookie value (may include an `s:`/`j:` prefix).
 * @returns The percent-encoded value.
 */
function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Decode a raw cookie value taken from a `Cookie` request header.
 *
 * Strips an optional surrounding double-quoted form (RFC 6265 quoted-string),
 * then percent-decodes the result.  Malformed percent-sequences fall back to
 * the (de-quoted) raw string so a single bad cookie never throws.
 *
 * @param raw - The raw value as it appears after `=` in the header.
 * @returns The decoded value, ready for `s:`/`j:` interpretation.
 */
function decodeCookieValue(raw: string): string {
  let val = raw;
  if (val.length >= 2 && val.charCodeAt(0) === 0x22 && val.charCodeAt(val.length - 1) === 0x22)
    val = val.slice(1, -1); // strip surrounding double quotes
  try {
    return decodeURIComponent(val);
  } catch {
    return val; // malformed percent-encoding — use the raw (de-quoted) string
  }
}

/**
 * Sign a cookie value with HMAC-SHA256.
 *
 * The produced string follows the `cookie-signature` wire format:
 * `s:<value>.<base64url-HMAC>`, where `<value>` is the raw (possibly
 * `j:`-prefixed) string and the HMAC is computed over that raw string.
 *
 * @param value  - The raw cookie value to sign (may include a `j:` prefix).
 * @param secret - The HMAC secret.
 * @returns The signed cookie string with the `s:` prefix.
 */
function signCookieValue(value: string, secret: string): string {
  const sig = crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url');
  return `s:${value}.${sig}`;
}

/**
 * Verify and decode a signed cookie value.
 *
 * The input must start with `s:` and follow the format produced by
 * {@link signCookieValue}: `s:<value>.<base64url-HMAC>`.
 *
 * Uses `crypto.timingSafeEqual` to prevent timing-based signature attacks.
 *
 * @param signed - The raw `Set-Cookie` value including the `s:` prefix.
 * @param secret - The HMAC secret to verify against.
 * @returns The inner value string on success, or `false` when the signature
 *          is absent or does not match (indicating a tampered cookie).
 */
function verifyCookieValue(signed: string, secret: string): string | false {
  if (!signed.startsWith('s:')) return false;
  const withoutPrefix = signed.slice(2);
  const lastDot       = withoutPrefix.lastIndexOf('.');
  if (lastDot === -1) return false;

  const value    = withoutPrefix.slice(0, lastDot);
  const received = withoutPrefix.slice(lastDot + 1);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url');

  const receivedBuf = Buffer.from(received, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');

  if (receivedBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) return false;
  return value;
}

// ---------------------------------------------------------------------------
// HTTP object augmentation
// ---------------------------------------------------------------------------

/**
 * Augment a raw `http.IncomingMessage` / `http.ServerResponse` pair with the
 * additional fields and helpers expected by router middleware.
 *
 * This function is idempotent — it exits immediately when `req.queries` is
 * already defined, so it is safe to call multiple times on the same pair.
 *
 * **Fields added to `req`:**
 * - `originalUrl` — the unmodified URL string.
 * - `path`        — the pathname portion of the URL.
 * - `params`      — merged map initialised from URL query parameters.
 * - `queries`     — structured query buckets (`url`, `route`).
 * - `cookies`     — parsed `Cookie` header values.
 *
 * **Helpers added to `res`:**
 * - `send(data?)`             — write `data` and end the response.
 * - `json(data)`              — serialise to JSON and end.
 * - `status(code, headers?)`  — set the status code and optional headers.
 * - `redirect(url)`           — issue a 302 redirect.
 * - `cookie(name, val, opts)` — append a `Set-Cookie` header.
 *
 * @param req         - The raw incoming message to augment.
 * @param res         - The raw server response to augment.
 * @param secret      - Optional cookie-signing secret.
 * @param trustProxy  - When `true`, resolve `req.ip` from `X-Forwarded-For`.
 */
function updateHttpObjects(
  req:         http.IncomingMessage,
  res:         http.ServerResponse,
  secret:      string | undefined,
  trustProxy?: boolean,
): void {
  const rReq = req as RouterRequest;
  const rRes = res as RouterResponse;

  if (rReq.queries) return; // Already augmented.

  rReq.queries = {};

  // Resolve the client IP address and proxy-related fields.
  // When trustProxy is true the leftmost value in X-Forwarded-For is used
  // (the originating client behind the proxy chain).  Otherwise we read the
  // raw TCP remote address directly from the socket, which cannot be spoofed.
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const xffStr = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
    rReq.ips = xffStr ? xffStr.split(',').map(s => s.trim()) : [];
    rReq.ip  = rReq.ips[0] ?? req.socket?.remoteAddress ?? '';

    const xProto = req.headers['x-forwarded-proto'];
    rReq.protocol = (Array.isArray(xProto) ? xProto[0] : xProto)?.split(',')[0].trim() ?? 'http';

    const xHost = req.headers['x-forwarded-host'];
    const hostHeader = (Array.isArray(xHost) ? xHost[0] : xHost) ?? req.headers.host ?? '';
    rReq.hostname = hostHeader.replace(/:\d+$/, '');
  } else {
    rReq.ip       = req.socket?.remoteAddress ?? '';
    rReq.ips      = [];
    rReq.protocol = (req.socket as any)?.encrypted ? 'https' : 'http';
    rReq.hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  }
  rReq.secure  = rReq.protocol === 'https';
  rReq.baseUrl = rReq.baseUrl ?? '';

  const qry = new URL(`http://${req.headers.host}${req.url}`);
  rReq.originalUrl = req.url!;
  rReq.path = qry.pathname;

  // Parse URL query parameters.
  // FEAT-03: repeated keys (e.g. ?tag=a&tag=b) accumulate into arrays.
  const urlParams: Record<string, string | string[]> = {};
  for (const [key, value] of qry.searchParams.entries()) {
    const existing = urlParams[key];
    if (existing === undefined) {
      urlParams[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      urlParams[key] = [existing, value];
    }
  }
  rReq.queries.url = urlParams;
  // params stays StringMap — use first value for repeated keys.
  const flatParams: StringMap = {};
  for (const [key, value] of Object.entries(urlParams)) {
    flatParams[key] = Array.isArray(value) ? value[0] : value;
  }
  rReq.params = flatParams;
  rReq.query  = urlParams;

  // Parse cookies.
  if (rReq.cookies == null) {
    rReq.cookies = {};
    if (req.headers.cookie) {
      for (const part of req.headers.cookie.split(';')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const name   = part.slice(0, eqIdx).trim();
        // De-quote and percent-decode before interpreting s:/j: prefixes, so
        // values containing semicolons, commas, quotes, or spaces round-trip.
        const rawVal = decodeCookieValue(part.slice(eqIdx + 1).trim());

        if (rawVal.startsWith('s:')) {
          // Signed cookie — verify the HMAC signature.
          if (secret) {
            const inner = verifyCookieValue(rawVal, secret);
            if (inner === false) continue; // tampered — silently omit
            rReq.cookies[name] = decodeJsonCookie(inner);
          } else {
            // No secret configured — include the raw value so the application
            // can at least inspect that a signed cookie was sent.
            rReq.cookies[name] = rawVal;
          }
        } else {
          // Plain or JSON-encoded cookie.
          rReq.cookies[name] = decodeJsonCookie(rawVal);
        }
      }
    }
  }

  const resolvedReqOpts = (opts?: BodyOptions) => ({
    limit:   opts?.limit   ?? '100kb',
    inflate: opts?.inflate ?? true,
    reviver: null as null,
    strict:  opts?.strict  ?? false,
    // readReqBody takes its expected mimetype as an explicit argument, so the
    // type matcher here is unused; null keeps the object shape-compatible.
    type:    null,
    verify:  opts?.verify  ?? null,
  });

  rReq.json = (opts?: BodyOptions): Promise<unknown | null> => {
    // If a body-parsing middleware already consumed the stream, return the cached value.
    if ('body' in (rReq as any)) return Promise.resolve((rReq as any).body ?? null);
    return readReqBody(rReq, resolvedReqOpts(opts), 'application/json', rRes)
      .then(ret => {
        if (ret == null) return null;
        const charset = extractCharset(ret.mimetype);
        try {
          const parsed = JSON.parse(
            ret.content.toString(charset as BufferEncoding),
            opts?.reviver ?? undefined,
          );
          (rReq as any).body = parsed;
          return parsed;
        } catch (ex) {
          return Promise.reject({ status: 400, message: 'Bad Request: ' + (ex as Error).message });
        }
      });
  };

  rReq.text = (opts?: BodyOptions): Promise<string | null> => {
    // If a body-parsing middleware already consumed the stream, return the cached string.
    const cached = (rReq as any).body;
    if (typeof cached === 'string') return Promise.resolve(cached);
    return readReqBody(rReq, resolvedReqOpts(opts), null, rRes)
      .then(ret => {
        if (ret == null) return null;
        const charset = extractCharset(ret.mimetype);
        return ret.content.toString(charset as BufferEncoding);
      });
  };

  rReq.formData = (opts?: BodyOptions): Promise<FormPart[] | null> => {
    // If a body-parsing middleware already consumed the stream, return the cached parts.
    const cached = (rReq as any).body;
    if (Array.isArray(cached)) return Promise.resolve(cached as FormPart[]);
    return readReqBody(rReq, resolvedReqOpts(opts), 'multipart/form-data', rRes)
      .then(ret => {
        if (ret == null) return null;
        try {
          const parts = parseMultipartBody(ret.mimetype, ret.content);
          (rReq as any).body = parts;
          return parts;
        } catch (ex: any) {
          // console.error('Body Err', ex)
          return Promise.reject({ status: ex.status ?? 500, message: ex.message ?? String(ex) });
        }
      });
  };

  rRes.setHeader('X-Powered-By', 'Expediate');

  rRes.send = (data?: string): void => {
    if (data) res.write(data);
    res.end();
  };

  rRes.json = (data: unknown): void => {
    res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify(data));
    res.end();
  };

  rRes.status = (code: number, headers?: StringMap): typeof rRes => {
    res.statusCode = code;
    if (headers)
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return rRes;
  };

  rRes.redirect = (url: string): void => {
    res.setHeader('location', url);
    res.writeHead(302);
    res.write(`Found. Redirecting to ${url}`);
    res.end();
  };

  rRes.cookie = (
    name: string,
    value: string | object,
    options?: CookieOptions,
  ): typeof rRes => {
    const opts: CookieOptions = options ?? {};

    // Serialise: objects get the j: prefix so the reader can JSON-decode them.
    let val =
      typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);

    if (opts.signed) {
      if (!secret)
        throw new Error(
          'Signed cookies require a secret — pass { secret } to createRouter()',
        );
      val = signCookieValue(val, secret);
    }

    // Percent-encode the final value (after any j:/s: wrapping) so special
    // characters are transmitted safely; decodeCookieValue() reverses it.
    let txt = `${name}=${encodeCookieValue(val)}`;

    if (opts.maxAge != null) {
      const maxAgeMs  = opts.maxAge;
      const maxAgeSec = Math.floor(maxAgeMs / 1000);
      // Only derive Expires from maxAge when maxAge > 0; a zero maxAge is used
      // for clearing cookies and the caller may have already set opts.expires
      // to the epoch — do not overwrite it.
      if (maxAgeMs > 0) opts.expires = new Date(Date.now() + maxAgeMs);
      txt += `; Max-Age=${maxAgeSec}`;
    }

    if (opts.expires)  txt += `; Expires=${opts.expires.toUTCString()}`;
    txt += `; Path=${opts.path ?? '/'}`;
    if (opts.httpOnly) txt += '; HttpOnly';
    if (opts.secure)   txt += '; Secure';
    if (opts.sameSite) txt += `; SameSite=${opts.sameSite}`;

    // Append rather than overwrite so multiple cookies can be set on the same
    // response.  res.setHeader() would replace any previously set Set-Cookie
    // header; instead, accumulate into an array.
    const existing = res.getHeader('Set-Cookie');
    if (existing == null) {
      res.setHeader('Set-Cookie', txt);
    } else if (Array.isArray(existing)) {
      res.setHeader('Set-Cookie', [...existing, txt]);
    } else {
      res.setHeader('Set-Cookie', [existing as string, txt]);
    }

    return rRes;
  };

  rRes.download = (filepath: string, filename?: string): void => {
    const name = filename ?? path.basename(filepath);
    // Use double-quotes and escape any double-quote in the filename per RFC 6266.
    const safeName = name.replace(/"/g, '\\"');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    // Guard: return 404 when the file does not exist (serveFile would send 500
    // for any stat error; we want the conventional 404 for downloads).
    fs.access(filepath, fs.constants.F_OK, (err) => {
      if (err) {
        if (!rRes.writableEnded) rRes.status(404).end('Not Found');
        return;
      }
      serveFile(filepath)(rReq, rRes, () => { /* no-op */ });
    });
  };

  rRes.type = (mime: string): typeof rRes => {
    res.setHeader('Content-Type', mime);
    return rRes;
  };

  rRes.etag = (value: string, strong = false): typeof rRes => {
    res.setHeader('ETag', strong ? `"${value}"` : `W/"${value}"`);
    return rRes;
  };

  rRes.locals = {};

  rRes.append = (field: string, value: string | string[]): typeof rRes => {
    const existing = res.getHeader(field);
    if (existing == null) {
      res.setHeader(field, value);
    } else if (field.toLowerCase() === 'set-cookie') {
      // Set-Cookie must accumulate as an array (multiple values not comma-joinable).
      const prev = Array.isArray(existing) ? existing : [String(existing)];
      const next = Array.isArray(value) ? value : [value];
      res.setHeader(field, [...prev, ...next]);
    } else {
      const prev = Array.isArray(existing) ? existing.join(', ') : String(existing);
      const added = Array.isArray(value) ? value.join(', ') : value;
      res.setHeader(field, `${prev}, ${added}`);
    }
    return rRes;
  };

  rRes.vary = (field: string | string[]): typeof rRes => {
    const fields = Array.isArray(field) ? field : [field];
    const existing = res.getHeader('Vary');
    const current: string[] = existing
      ? (Array.isArray(existing) ? existing : [String(existing)])
          .join(', ')
          .split(',')
          .map(s => s.trim().toLowerCase())
      : [];
    for (const f of fields) {
      if (!current.includes(f.toLowerCase())) {
        current.push(f.toLowerCase());
      }
    }
    res.setHeader('Vary', current.join(', '));
    return rRes;
  };

  rRes.location = (url: string): typeof rRes => {
    res.setHeader('Location', url);
    return rRes;
  };

  rRes.clearCookie = (name: string, options?: CookieOptions): typeof rRes => {
    const opts: CookieOptions = { ...options, expires: new Date(0), maxAge: 0 };
    // Remove signed flag — clearing does not need signing.
    delete opts.signed;
    rRes.cookie(name, '', opts);
    return rRes;
  };

  rRes.sendStatus = (code: number): void => {
    const messages: Record<number, string> = {
      100: 'Continue', 101: 'Switching Protocols', 102: 'Processing',
      200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
      206: 'Partial Content', 207: 'Multi-Status',
      300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found',
      303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect',
      308: 'Permanent Redirect',
      400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
      403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
      406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
      410: 'Gone', 411: 'Length Required', 413: 'Payload Too Large',
      415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error', 501: 'Not Implemented',
      502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    };
    res.setHeader('Content-Type', 'text/plain');
    res.statusCode = code;
    res.end(messages[code] ?? String(code));
  };

  rRes.attachment = (filename?: string): typeof rRes => {
    if (filename) {
      const mimeType = mime.lookup(filename, 'application/octet-stream');
      res.setHeader('Content-Type', mimeType);
      const safeName = path.basename(filename).replace(/"/g, '\\"');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    } else {
      res.setHeader('Content-Disposition', 'attachment');
    }
    return rRes;
  };

  // Wrap status() to validate code is an integer in 100–999.
  const _statusOrig = rRes.status.bind(rRes);
  rRes.status = (code: number, headers?: StringMap): typeof rRes => {
    if (!Number.isInteger(code) || code < 100 || code > 999)
      throw new RangeError(`Invalid status code: ${code}. Must be an integer between 100 and 999.`);
    return _statusOrig(code, headers);
  };
}

/**
 * Test whether a layer's path pattern matches the given path string,
 * **ignoring the HTTP method**.  Does NOT mutate `req`.
 *
 * Used exclusively for **405 Method Not Allowed** detection: when
 * `matchRouteLayer` returns `false` due to a method mismatch, calling this
 * function lets the dispatcher confirm that the path itself is registered
 * (just under a different method) so it can respond with 405 and an
 * `Allow` header instead of the generic 404.
 *
 * @param layer - The layer whose path pattern to test.
 * @param path  - The current value of `req.path`.
 * @returns `true` when the path pattern matches, regardless of method.
 */
function pathMatchesLayer(layer: Layer, path: string): boolean {
  return layer.regex.test(path);
}

// ---------------------------------------------------------------------------
// Route registration helpers
// ---------------------------------------------------------------------------

/**
 * Recursively resolve a `MiddlewareArg` value down to individual `Middleware`
 * functions and push one `Layer` per function into the route table.
 *
 * Accepted input shapes (processed recursively):
 * - A `Middleware` function → pushed directly as a layer.
 * - A `Router` instance    → its `listener` is unwrapped and pushed.
 * - An array of either     → each element is processed recursively.
 *
 * @param routes    - The mutable route table to push into.
 * @param method    - HTTP method string or `null` for method-agnostic layers.
 * @param path      - URL pattern (plain string, glob, or `RegExp`).
 * @param arg       - The middleware value(s) to register.
 * @param stripPath - Forwarded to `buildRouteLayer`.
 * @throws {TypeError} When `arg` contains a value that cannot be resolved to
 *                     a `Middleware` function.
 */
function registerRoute(
  routes: Layer[],
  method: string | null,
  path: string | RegExp,
  arg: MiddlewareArg,
  stripPath: boolean,
): void {
  if (Array.isArray(arg)) {
    for (const item of arg) registerRoute(routes, method, path, item, stripPath);
  } else if (typeof arg === 'function') {
    routes.push(buildRouteLayer(method, path, arg, stripPath));
  } else if (arg && typeof (arg as Router).listener === 'function') {
    // Router instance — unwrap its listener.
    routes.push(buildRouteLayer(method, path, (arg as Router).listener, stripPath));
  } else {
    throw new TypeError(
      'Unexpected value registered as middleware: expected a Middleware ' +
      'function, a Router instance, or an array of either',
    );
  }
}

/**
 * If `arg` is a `Router` instance, return its configured {@link Router.prefix};
 * otherwise return `undefined`.
 *
 * Used by `router.use()` to infer the mount path when no explicit path is
 * provided:
 * ```ts
 * const v1 = createRouter('/api/v1');
 * app.use(v1); // prefix '/api/v1' is inferred automatically
 * ```
 *
 * @param arg - The first argument passed to `router.use()`.
 * @returns The router's prefix string, or `undefined`.
 */
function extractRouterPrefix(arg: MiddlewareArg): string | undefined {
  if (Array.isArray(arg) || typeof arg === 'function') return undefined;
  return (arg as Router).prefix;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create and return a new `Router` instance.
 *
 * The returned object exposes an Express-compatible routing API and doubles
 * as a middleware function itself (via `router.listener`), so it can be
 * mounted inside another router:
 * ```ts
 * parent.use('/api', child);
 * // or, if child has a prefix:
 * parent.use(child);
 * ```
 *
 * **Prefix shorthand:**
 * Pass a path string as the first argument to associate a prefix with this
 * router.  The prefix is used automatically when the router is mounted via
 * `parent.use(child)`:
 * ```ts
 * const v1 = createRouter('/api/v1');
 * v1.get('/users', handler);   // handler is reached at /api/v1/users
 * app.use(v1);                  // same as app.use('/api/v1', v1)
 * ```
 *
 * **Path patterns** accepted by all route-registration methods:
 * - Plain strings with optional `:name` segments — e.g. `'/users/:id'`.
 * - Glob strings following `.gitignore` rules — e.g. `'/**\/*.php'`.
 * - `RegExp` objects — used directly; named groups become route parameters.
 *
 * **Error handling:**
 * Register a global error handler with `router.onError()`.  It is called
 * when any middleware throws, rejects, or calls `next(err)`.
 *
 * **Graceful shutdown:**
 * Call `router.shutdown()` to stop the server created by `router.listen()`.
 *
 * @param prefixOrOpts - Optional path prefix string (e.g. `'/api/v1'`) **or**
 *                       an {@link RouterOptions} object.
 * @param opts         - Options when `prefixOrOpts` is a string.
 * @returns A fully initialised `Router`.
 *
 * @example
 * ```ts
 * const app = createRouter({ secret: process.env.COOKIE_SECRET, timeout: 30_000 });
 *
 * const v1 = createRouter('/api/v1');
 * v1.get('/users', handler);
 *
 * app.use(v1);
 * app.onError((err, _req, res) => res.status(500).json({ error: String(err) }));
 * app.setNotFound((_req, res) => res.status(404).json({ error: 'Not Found' }));
 *
 * app.listen(3000, () => console.log('Listening'));
 * process.on('SIGTERM', () => app.shutdown(10_000));
 * ```
 */
function createRouter(
  prefixOrOpts?: string | RouterOptions,
  opts?: RouterOptions,
): Router {
  // Resolve overloaded first argument.
  const routerPrefix = typeof prefixOrOpts === 'string' ? prefixOrOpts : undefined;
  const options      = typeof prefixOrOpts === 'object' ? prefixOrOpts : (opts ?? {});

  const secret      = options.secret;
  const timeoutMs   = options.timeout;
  const trustProxy  = options.trustProxy ?? false;

  const routes: Layer[] = [];

  /** Currently registered error handler, or `undefined` for the default 500. */
  let errorHandler:    ErrorHandler | undefined;
  /** Currently registered not-found handler, or `undefined` for the default 404. */
  let notFoundHandler: Middleware   | undefined;

  /** Server created by `router.listen()`, used by `router.shutdown()`. */
  let activeServer: http.Server | https.Server | http2.Http2SecureServer | null = null;
  /** All open sockets tracked for forced teardown on shutdown. */
  const activeSockets = new Set<net.Socket>();

  // ──────────────────────────────────────────────────────────────────────────
  // Core dispatch listener
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Core dispatch function. Walks the route table in registration order and
   * invokes the first layer that matches the current request.
   *
   * - **404** (or custom `setNotFound` handler) — no layer's path matched.
   * - **405 Method Not Allowed** — a layer's path matched but no layer
   *   accepted the HTTP method.  The `Allow` header lists all registered methods.
   * - **500** (or custom `onError` handler) — a middleware threw or rejected,
   *   or `next(err)` was called with a non-null error.
   */
  const listener: Middleware = (
    req: RouterRequest,
    res: RouterResponse,
    done?: NextFunction,
  ): void => {
    const method = req.method;
    const url    = req.url;
    let idx = 0;

    updateHttpObjects(req, res, secret, trustProxy);

    // ── Optional per-request timeout ──────────────────────────────────────
    // Uses both a socket-level idle timeout (as the transport boundary) and a
    // wall-clock setTimeout guard.  The wall-clock timer is the primary
    // mechanism because it is unaffected by the OS socket buffer state;
    // socket.setTimeout is set in addition so the idle signal propagates down
    // to keep-alive connections that would otherwise hold the socket open.
    if (timeoutMs) {
      if (req.socket) req.socket.setTimeout(timeoutMs);
      const timer = setTimeout((): void => {
        if (!res.writableEnded) res.status(408).end('Request Timeout');
      }, timeoutMs);
      res.once('finish', () => {
        clearTimeout(timer);
        if (req.socket) req.socket.setTimeout(0);
      });
    }

    // ── Centralised error dispatch ─────────────────────────────────────────
    // Invoked for sync throws, async rejections, and next(err) calls.
    const invokeErrorHandler = (e: unknown): void => {
      if (res.writableEnded) return;
      if (errorHandler) {
        try {
          errorHandler(e, req, res);
        } catch (e2) {
          // console.error('Root Err', e2)
          if (!res.writableEnded) res.status(500).end(`Error ${method} ${url}`);
        }
      } else {
        console.warn(e);
        res.status(500).end(`Error ${method} ${url}`);
      }
    };

    // ── Safe middleware invocation ─────────────────────────────────────────
    // Catches sync throws AND async rejections, routing both to invokeErrorHandler.
    const invoke = (mw: Middleware, nextFn: NextFunction): void => {
      try {
        const ret = mw(req, res, nextFn) as unknown;
        if (ret instanceof Promise) ret.catch(invokeErrorHandler);
      } catch (e) {
        invokeErrorHandler(e);
      }
    };

    // Accumulate methods from layers whose path matched but whose method
    // did not, for a 405 response with an accurate Allow header.
    const allowedMethods = new Set<string>();

    // ── Main dispatch loop ─────────────────────────────────────────────────
    const next: NextFunction = (err?: unknown): void => {
      // If an error is passed, skip remaining routes and call error handler.
      if (err != null) {
        invokeErrorHandler(err);
        return;
      }

      while (idx < routes.length) {
        const layer      = routes[idx++];
        const pathBefore = req.path;

        if (matchRouteLayer(layer, req, req.path)) {
          if (layer.stripPath) {
            // For prefix layers (use), restore req.path and req.baseUrl after
            // the sub-router calls done() so subsequent sibling layers see the
            // original values.
            const baseUrlBefore = req.baseUrl;
            const strippedPrefix = pathBefore.slice(0, pathBefore.length - req.path.length);
            req.baseUrl = baseUrlBefore + strippedPrefix;
            invoke(layer.middleware, () => {
              req.path    = pathBefore;
              req.baseUrl = baseUrlBefore;
              next();
            });
            return;
          }
          invoke(layer.middleware, next);
          return;
        }

        // Path matched but method did not → remember for 405 detection.
        if (layer.method !== null && pathMatchesLayer(layer, pathBefore)) {
          allowedMethods.add(layer.method);
        }
      }

      // All layers exhausted without a full match.
      if (allowedMethods.size > 0) {
        // Path is registered, but not for this method.
        const allow = [...allowedMethods].sort().join(', ');
        res.status(405, { Allow: allow }).end(`Cannot ${method} ${url}`);
        return;
      }

      // Genuine 404 — delegate to parent router, not-found handler, or default.
      if (done) return done();

      if (notFoundHandler) {
        try {
          notFoundHandler(req, res, () => { /* no-op: not-found handler owns response */ });
        } catch (e) {
          invokeErrorHandler(e);
        }
        return;
      }

      res.status(404).end(`Cannot ${method} ${url}`);
    };

    try {
      next();
    } catch (e) {
      invokeErrorHandler(e);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Registration helper for method-specific routes
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Return the route-registration function used by all HTTP-method helpers.
   *
   * @param method    - HTTP method to restrict layers to, or `null` for any.
   * @param stripPath - Whether the matched path prefix should be stripped.
   */
  function makeRegister(method: string | null, stripPath: boolean) {
    return (path: string | RegExp, ...args: MiddlewareArg[]): void => {
      for (const arg of args) registerRoute(routes, method, path, arg, stripPath);
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // `use()` — supports both path-first and no-path (Router-first) forms
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register prefix-style middleware.  Accepts:
   * 1. `use(path, ...middlewares)` — explicit path.
   * 2. `use(routerOrMiddleware, ...more)` — infers path from Router.prefix or '/'.
   */
  const use = (
    pathOrFirst: string | RegExp | MiddlewareArg,
    ...args: MiddlewareArg[]
  ): void => {
    if (typeof pathOrFirst === 'string' || pathOrFirst instanceof RegExp) {
      // Normal form: explicit path string or RegExp.
      for (const arg of args) registerRoute(routes, null, pathOrFirst, arg, true);
    } else {
      // No explicit path: the first argument is itself a middleware / Router.
      // Infer mount path from the Router's prefix, or default to '/'.
      const inferredPath = extractRouterPrefix(pathOrFirst as MiddlewareArg) ?? '/';
      registerRoute(routes, null, inferredPath, pathOrFirst as MiddlewareArg, true);
      for (const arg of args) registerRoute(routes, null, '/', arg, true);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Public router object
  // ──────────────────────────────────────────────────────────────────────────

  const router: Router = {
    prefix: routerPrefix,
    listener,

    use,
    all:    makeRegister(null,     false),
    get:    makeRegister('GET',    false),
    put:    makeRegister('PUT',    false),
    post:   makeRegister('POST',   false),
    delete: makeRegister('DELETE', false),
    patch:  makeRegister('PATCH',  false),

    // ── route ────────────────────────────────────────────────────────────────
    route(path: string | RegExp): RouteBuilder {
      // Each method forwards to the router's own registration helper with the
      // cached path and returns the builder so calls can be chained.
      const builder: RouteBuilder = {
        all(...args)    { router.all(path, ...args);    return builder; },
        get(...args)    { router.get(path, ...args);    return builder; },
        put(...args)    { router.put(path, ...args);    return builder; },
        post(...args)   { router.post(path, ...args);   return builder; },
        delete(...args) { router.delete(path, ...args); return builder; },
        patch(...args)  { router.patch(path, ...args);  return builder; },
      };
      return builder;
    },

    // ── onError ─────────────────────────────────────────────────────────────
    onError(handler: ErrorHandler): void {
      errorHandler = handler;
    },

    // ── setNotFound ──────────────────────────────────────────────────────────
    setNotFound(handler: Middleware): void {
      notFoundHandler = handler;
    },

    // ── routes ───────────────────────────────────────────────────────────────
    routes(): RouteInfo[] {
      return routes.map((l) => ({
        method:    l.method,
        path:      l.path,
        stripPath: l.stripPath,
      }));
    },

    // ── shutdown ─────────────────────────────────────────────────────────────
    shutdown(timeout = 5000): Promise<void> {
      if (!activeServer) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        // Stop accepting new connections.  Resolves when all existing
        // connections have been closed (or when forcibly destroyed below).
        activeServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });

        // Forcibly destroy any remaining idle sockets after the grace period.
        if (timeout > 0) {
          setTimeout(() => {
            for (const socket of activeSockets) socket.destroy();
            activeSockets.clear();
          }, timeout);
        }
      });
    },

    // ── listen ───────────────────────────────────────────────────────────────
    listen(
      port: number,
      opts?: TlsOptions | (() => void),
      cb?: () => void,
    ): http.Server | https.Server | http2.Http2SecureServer {
      if (typeof opts === 'function') {
        cb   = opts;
        opts = undefined;
      }

      const rawListener = listener as unknown as http.RequestListener;
      let server: http.Server | https.Server | http2.Http2SecureServer;

      const tlsOpts = opts as TlsOptions | undefined;

      if (tlsOpts?.key && tlsOpts?.cert) {
        if (tlsOpts.http2) {
          // HTTP/2 secure server — same TLS options, different factory.
          server = http2.createSecureServer(tlsOpts as http2.SecureServerOptions, rawListener as any);
        } else {
          server = https.createServer(tlsOpts as https.ServerOptions, rawListener);
        }
      } else {
        server = http.createServer(rawListener);
      }

      // Track open sockets so shutdown() can forcibly destroy them.
      server.on('connection', (socket: net.Socket) => {
        activeSockets.add(socket);
        socket.once('close', () => activeSockets.delete(socket));
      });

      activeServer = server;
      server.listen(port, cb);
      return server;
    },
  };

  return router;
}

export default createRouter;
export type {
  Router,
  RouterOptions,
  RouterRequest,
  RouterResponse,
  Middleware,
  MiddlewareArg,
  NextFunction,
  ErrorHandler,
  Layer,
  RouteInfo,
  RouteBuilder,
  CookieOptions,
  TlsOptions,
  StringMap,
};
