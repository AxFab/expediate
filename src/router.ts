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

import * as http   from 'http';
import * as https  from 'https';
import * as http2  from 'http2';
import * as net    from 'net';
import { updateHttpObjects } from './http-objects.js';
import type {
  StringMap,
  RouterOptions,
  RouterRequest,
  RouterResponse,
  TlsOptions,
  Middleware,
  NextFunction,
  ErrorHandler,
  ErrorMiddleware,
  MiddlewareArg,
  RouteInfo,
  Layer,
  RouteBuilder,
  Router,
} from './router-types.js';

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
      { cause: e },
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
  // A HEAD request is served by a matching GET layer (RFC 7231 §4.3.2); Node
  // suppresses the response body for HEAD automatically, so the GET handler can
  // run unchanged.
  if (
    layer.method &&
    layer.method !== req.method &&
    !(req.method === 'HEAD' && layer.method === 'GET')
  )
    return false;

  const m = layer.regex.exec(path);
  if (m === null) return false;

  const captured: StringMap = (m.groups) ?? {};

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
  } else if (arg && typeof (arg).listener === 'function') {
    // Router instance — unwrap its listener.
    routes.push(buildRouteLayer(method, path, (arg).listener, stripPath));
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
  return (arg).prefix;
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
 *
 * // Custom 404: register a catch-all as the LAST layer. Because layers match
 * // in registration order, it only runs when nothing earlier claimed the
 * // request. Use `all('/**', …)` (glob) to match any method and path.
 * app.all('/**', (_req, res) => res.status(404).json({ error: 'Not Found' }));
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

  /** Ordered error-handling middlewares registered via `router.error()`. */
  const errorHandlers: ErrorMiddleware[] = [];
  /** Terminal fallback registered via `router.onError()`, or `undefined`. */
  let errorHandler:    ErrorHandler | undefined;

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
   * - **404** — no layer's path matched (register a catch-all last to customise).
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
    //
    // Resolution order:
    //   1. Each error() middleware in turn (it may end the response or forward).
    //   2. The onError() terminal fallback, if registered.
    //   3. Bubble to the parent router's error channel via done(err).
    //   4. Top-level router with no handler → default 500.
    const invokeErrorHandler = (e: unknown): void => {
      if (res.writableEnded) return;

      let i = 0;
      const runNext = (err: unknown): void => {
        if (res.writableEnded) return;

        // 1. Ordered error() middleware chain.
        if (i < errorHandlers.length) {
          const handler = errorHandlers[i++];
          try {
            // `next()` forwards the same error; `next(newErr)` replaces it.
            handler(err, req, res, (nextErr?: unknown) =>
              runNext(nextErr ?? err));
          } catch (e2) {
            runNext(e2);
          }
          return;
        }

        // 2. onError() terminal fallback for this router.
        if (errorHandler) {
          try {
            errorHandler(err, req, res);
          } catch {
            if (!res.writableEnded) res.status(500).end(`Error ${method} ${url}`);
          }
          return;
        }

        // 3. Bubble to the parent router's error channel (when mounted via use()).
        if (done) {
          done(err);
          return;
        }

        // 4. Top-level router with no handler: default 500.
        res.status(500).end(`Error ${method} ${url}`);
      };

      runNext(e);
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
            // The continuation doubles as the sub-router's `done`: it runs both
            // when the sub-router falls through (no error) and when it bubbles an
            // error up. Forward `err` so a bubbled error reaches this router's
            // error channel instead of being silently dropped.
            invoke(layer.middleware, (err?: unknown) => {
              req.path    = pathBefore;
              req.baseUrl = baseUrlBefore;
              next(err);
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
        // The path is registered, just not for this method.  Build the Allow
        // header, advertising HEAD (served by GET) and OPTIONS (handled here)
        // alongside the explicitly registered methods.
        if (allowedMethods.has('GET')) allowedMethods.add('HEAD');
        allowedMethods.add('OPTIONS');
        const allow = [...allowedMethods].sort().join(', ');

        // Automatic OPTIONS: when nothing claimed the request (no explicit
        // OPTIONS route, no cors() middleware), reply 204 with the Allow header.
        if (method === 'OPTIONS') {
          res.status(204, { Allow: allow }).end();
          return;
        }

        // Otherwise the method is genuinely not allowed for this path.
        res.status(405, { Allow: allow }).end(`Cannot ${method} ${url}`);
        return;
      }

      // Genuine 404 — delegate to the parent router, or send the default 404.
      // To customise, register a catch-all layer last (e.g. `app.all('/**', …)`);
      // it matches in registration order after every real route.
      if (done) return done();

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
      const inferredPath = extractRouterPrefix(pathOrFirst) ?? '/';
      registerRoute(routes, null, inferredPath, pathOrFirst, true);
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
    delete:  makeRegister('DELETE',  false),
    patch:   makeRegister('PATCH',   false),
    head:    makeRegister('HEAD',    false),
    options: makeRegister('OPTIONS', false),

    // ── route ────────────────────────────────────────────────────────────────
    route(path: string | RegExp): RouteBuilder {
      // Each method forwards to the router's own registration helper with the
      // cached path and returns the builder so calls can be chained.
      const builder: RouteBuilder = {
        all(...args)     { router.all(path, ...args);     return builder; },
        get(...args)     { router.get(path, ...args);     return builder; },
        put(...args)     { router.put(path, ...args);     return builder; },
        post(...args)    { router.post(path, ...args);    return builder; },
        delete(...args)  { router.delete(path, ...args);  return builder; },
        patch(...args)   { router.patch(path, ...args);   return builder; },
        head(...args)    { router.head(path, ...args);    return builder; },
        options(...args) { router.options(path, ...args); return builder; },
      };
      return builder;
    },

    // ── onError ─────────────────────────────────────────────────────────────
    onError(handler: ErrorHandler): void {
      errorHandler = handler;
    },

    // ── error ────────────────────────────────────────────────────────────────
    error(handler: ErrorMiddleware): void {
      errorHandlers.push(handler);
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

      const tlsOpts = opts;

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
  ErrorMiddleware,
  Layer,
  RouteInfo,
  RouteBuilder,
  CookieOptions,
  TlsOptions,
  StringMap,
} from './router-types.js';
