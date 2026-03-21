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

import * as http from 'http';
import * as https from 'https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A key-value map of arbitrary string values. */
type StringMap = Record<string, string>;

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
   * - `url`   — parameters parsed from the query string.
   * - `route` — named parameters captured from the route pattern.
   */
  queries: {
    url?: StringMap;
    route?: StringMap;
  };
  /** Parsed cookies sent with the request. */
  cookies: StringMap;
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
}

/** Options accepted by `res.cookie()`. */
interface CookieOptions {
  /** Sign the cookie value (requires a secret on the request). */
  signed?: boolean;
  /** Expiry date for the cookie. */
  expires?: Date;
  /** Max age in milliseconds; converted to seconds in the `Set-Cookie` header. */
  maxAge?: number;
  /** Cookie path (defaults to `'/'`). */
  path?: string;
}

/** Options for HTTPS servers passed to `router.listen()`. */
interface TlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
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

/** Callback used to pass control to the next matching middleware. */
type NextFunction = () => void;

/**
 * A value that can be registered as a route handler: a single `Middleware`
 * function, a `Router` instance (whose `listener` will be used), or an array
 * of either. Arrays may not be nested.
 */
type MiddlewareArg = Middleware | Router | (Middleware | Router)[];

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
 * The public interface of the object returned by `createRouter()`.
 *
 * All route-registration methods share the same uniform signature: a mandatory
 * `path` argument followed by any number of `MiddlewareArg` values.
 * A `MiddlewareArg` may be a `Middleware` function, a `Router` instance
 * (whose `listener` is used automatically), or an array of either.
 */
interface Router {
  /**
   * Register middleware for all HTTP methods, scoped to `path`.
   * The matched path prefix is stripped from `req.path` before the middleware
   * is invoked, so nested routers only see the remaining suffix.
   * Equivalent to Express's `app.use()`.
   */
  use(path: string | RegExp, ...args: MiddlewareArg[]): void;
  /**
   * Register middleware for all HTTP methods.
   * Unlike `use`, it doesn't strips the matched prefix from `req.path`.
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
   * Start listening on the given port.
   * When `opts` contains both `key` and `cert`, an HTTPS server is created;
   * otherwise a plain HTTP server is used.
   */
  listen(port: number, opts?: TlsOptions | (() => void), cb?: () => void): void;
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
  return /(?<!\\)[*?]/.test(pattern);
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
function compileGlob(glob: string): RegExp {
  // Escape all regex special characters, leaving our wildcard characters intact.
  let src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace in order: `**` must be handled before `*`.
  src = src
    .replace(/\*\*/g, '\x00GLOBSTAR\x00') // temporary placeholder
    .replace(/\*/g, '[^/]*')              // single-segment wildcard
    .replace(/\?/g, '[^/]')              // single-character wildcard
    .replace(/\x00GLOBSTAR\x00/g, '.*'); // cross-segment wildcard

  return new RegExp('^' + src);
}

/**
 * Compile a plain path string with optional `:name` parameter segments into a
 * prefix-anchored `RegExp` that uses named capture groups.
 *
 * Each `:name` segment is converted to `(?<name>[^/]+)`, making named
 * captures available directly on the `RegExp` match result.
 * Literal segments are escaped and matched exactly.
 *
 * The expression matches up to a segment boundary (`/` or end-of-string) so
 * that `/users` never inadvertently matches `/users-admin`.
 *
 * @param path - A plain path string such as `'/users/:id/posts'`.
 * @returns A prefix-anchored `RegExp` with named groups for each parameter.
 *
 * @example
 * ```ts
 * const re = compilePlainPath('/users/:id');
 * re.exec('/users/42/comments')?.groups; // { id: '42' }
 * ```
 */
function compilePlainPath(path: string): RegExp {
  const segments = path.split('/').filter((s) => s.length > 0);
  const src = segments
    .map((seg) =>
      seg.startsWith(':')
        ? `(?<${seg.slice(1)}>[^/]+)` // named parameter segment
        : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&'), // escaped literal
    )
    .join('/');

  // Allow a trailing slash or an additional path segment after the prefix.
  return new RegExp('^/?' + src + '(?=/|$)');
}

/**
 * Convert any supported path pattern into the single canonical `RegExp`
 * used by `matchRouteLayer`.
 *
 * | Input type   | Strategy                                              |
 * |--------------|-------------------------------------------------------|
 * | Glob string  | {@link compileGlob} — `.gitignore`-style wildcards    |
 * | Plain string | {@link compilePlainPath} — `:name` → named groups     |
 * | `RegExp`     | Used as-is; named groups are surfaced as params       |
 *
 * @param path - The raw path pattern supplied by the caller.
 * @returns A `RegExp` suitable for use in `matchRouteLayer`.
 */
function compilePattern(path: string | RegExp): RegExp {
  if (path instanceof RegExp) return path;
  if (isGlobPattern(path))    return compileGlob(path);
  return compilePlainPath(path);
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

  return { method, path, regex: compilePattern(path), stripPath, middleware };
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
 * - `status(code, headers?)`  — set the status code and optional headers.
 * - `redirect(url)`           — issue a 302 redirect.
 * - `cookie(name, val, opts)` — append a `Set-Cookie` header.
 *
 * @param req - The raw incoming message to augment.
 * @param res - The raw server response to augment.
 */
function updateHttpObjects(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const rReq = req as RouterRequest;
  const rRes = res as RouterResponse;

  if (rReq.queries) return; // Already augmented.

  rReq.queries = {};

  const qry = new URL(`http://${req.headers.host}${req.url}`);
  rReq.originalUrl = req.url!;
  rReq.path = qry.pathname;

  // Parse URL query parameters.
  const urlParams: StringMap = {};
  for (const [key, value] of qry.searchParams.entries()) urlParams[key] = value;
  rReq.queries.url = urlParams;
  rReq.params = { ...urlParams };

  // Parse cookies.
  if (rReq.cookies == null) {
    rReq.cookies = {};
    if (req.headers.cookie) {
      for (const raw of req.headers.cookie.split(';')) {
        const eqIdx = raw.indexOf('=');
        if (eqIdx === -1) continue;
        rReq.cookies[raw.slice(0, eqIdx).trim()] = raw.slice(eqIdx + 1).trim();
        // TODO: 's:' prefix → signed cookie, 'j:' prefix → JSON cookie
      }
    }
  }

  rRes.setHeader('X-Powered-By', 'Expediate');

  rRes.send = (data?: string): void => {
    if (data) res.write(data);
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

    if (opts.signed && !(req as any).secret)
      throw new Error('cookieParser("secret") required for signed cookies');

    let val =
      typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);

    if (opts.signed) val = 's:' + val; // sign() integration point

    let txt = `${name}=${val}`;

    if (opts.maxAge != null) {
      opts.expires = new Date(Date.now() + opts.maxAge);
      opts.maxAge = Math.floor(opts.maxAge / 1000);
      txt += `; Max-Age=${opts.maxAge}`;
    }

    if (opts.expires) txt += `; Expires=${opts.expires.toUTCString()}`;
    txt += `; Path=${opts.path ?? '/'}`;

    res.setHeader('Set-Cookie', txt);
    return rRes;
  };
}

// ---------------------------------------------------------------------------
// Route registration
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
 * @param stripPath - Forwarded to `buildRouteLayer`. Pass `true` for prefix-
 *                    style registrations (`use`) so the matched prefix
 *                    is stripped from `req.path`, and `false` for exact-method
 *                    routes so that chained middlewares sharing the same path
 *                    each see the unmodified path.
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
 * ```
 *
 * **Path patterns** accepted by all route-registration methods:
 * - Plain strings with optional `:name` segments — e.g. `'/users/:id'`.
 *   Each `:name` is compiled to a named capture group and exposed in
 *   `req.params` on a match.
 * - Glob strings following `.gitignore` rules — e.g. `'/**\/*.php'`.
 *   Supported wildcards: `?` (one non-slash char), `*` (any non-slash chars),
 *   `**` (any chars, including slashes).
 * - `RegExp` objects — used directly; named groups become route parameters.
 *
 * **Middleware arguments** accept any number of variadic `MiddlewareArg`
 * values, each of which may be:
 * - A `Middleware` function.
 * - A `Router` instance (its `listener` is registered automatically).
 * - An array of either of the above.
 *
 * **Path stripping behaviour:**
 * - `use` — strip the matched path prefix from `req.path` before
 *   invoking middleware. Nested routers therefore only see the remaining suffix.
 * - `all` / `get` / `post` / `put` / `delete` / `patch` — leave `req.path` intact
 *   so that multiple middlewares registered for the same exact path can each
 *   match and be invoked in sequence via `next()`.
 *
 * @returns A fully initialised `Router` ready to register routes and
 *          optionally start an HTTP or HTTPS server.
 *
 * @example
 * ```ts
 * const auth = createRouter();
 * auth.post('/login',  handleLogin);
 * auth.post('/logout', handleLogout);
 *
 * const app = createRouter();
 * app.use('/auth', auth);                              // mount a sub-router
 * app.get('/users/:id', requireAuth, getUser);         // multiple middleware
 * app.get('/**\/*.php', (req, res) =>                 // glob pattern
 *   res.status(403).send('Forbidden'));
 *
 * app.listen(3000, () => console.log('Listening on :3000'));
 * ```
 */
function createRouter(): Router {
  const routes: Layer[] = [];

  /**
   * Core dispatch function. Walks the route table in registration order and
   * invokes the first layer that matches the current request. Falls back to a
   * 404 response when no layer matches and no upstream `done` callback is set.
   */
  const listener: Middleware = (
    req: RouterRequest,
    res: RouterResponse,
    done?: NextFunction,
  ): void => {
    const method = req.method;
    const url = req.url;
    let idx = 0;

    updateHttpObjects(req, res);

    const next: NextFunction = (): void => {
      while (idx < routes.length) {
        const layer = routes[idx++];
        const pathBefore = req.path;
        if (matchRouteLayer(layer, req, req.path)) {
          if (layer.stripPath) {
            // For prefix layers (use), save the pre-strip path so we can
            // restore it if the sub-router calls done() and control returns here.
            // Without restoration, subsequent layers in this router would see
            // the truncated path and fail to match their own patterns.
            const strippedPath = req.path;
            return layer.middleware(req, res, () => {
              req.path = pathBefore; // restore for the next sibling layer
              next();
            });
          }
          return layer.middleware(req, res, next);
        }
      }
      if (done) return done();
      res.status(404).end(`Cannot ${method} ${url}`);
    };

    try {
      next();
    } catch (e) {
      console.warn(e);
      res.status(500).end(`Error ${method} ${url}`);
    }
  };

  // -------------------------------------------------------------------------
  // Internal helper — produce the uniform registration function for a method.
  // -------------------------------------------------------------------------

  /**
   * Return the route-registration function used by all HTTP-method helpers.
   *
   * The produced function accepts a mandatory `path` followed by any number
   * of `MiddlewareArg` values (functions, `Router` instances, or arrays
   * thereof), and delegates each to `registerRoute`.
   *
   * @param method    - HTTP method to restrict layers to, or `null` for any.
   * @param stripPath - Whether the matched path prefix should be stripped from
   *                    `req.path` before middleware is invoked. `true` for
   *                    prefix-style registrations, `false` for exact-method ones.
   * @returns A variadic route-registration function.
   */
  function makeRegister(method: string | null, stripPath: boolean) {
    return (path: string | RegExp, ...args: MiddlewareArg[]): void => {
      for (const arg of args) registerRoute(routes, method, path, arg, stripPath);
    };
  }

  // -------------------------------------------------------------------------
  // Public router API
  // -------------------------------------------------------------------------

  const router: Router = {
    listener,
    use:    makeRegister(null,     true),   // prefix — strip path
    all:    makeRegister(null,     false),  // exact  — keep path
    get:    makeRegister('GET',    false),
    put:    makeRegister('PUT',    false),
    post:   makeRegister('POST',   false),
    delete: makeRegister('DELETE', false),
    patch:  makeRegister('PATCH',  false),

    listen(
      port: number,
      opts?: TlsOptions | (() => void),
      cb?: () => void,
    ): void {
      if (typeof opts === 'function') {
        cb = opts;
        opts = undefined;
      }
      const rawListener = listener as unknown as http.RequestListener;
      if (opts && (opts as TlsOptions).key && (opts as TlsOptions).cert)
        https.createServer(opts as TlsOptions, rawListener).listen(port, cb);
      else
        http.createServer(rawListener).listen(port, cb);
    },
  };

  return router;
}

export default createRouter;
export type {
  Router,
  RouterRequest,
  RouterResponse,
  Middleware,
  MiddlewareArg,
  NextFunction,
  Layer,
  CookieOptions,
  TlsOptions,
  StringMap,
};
