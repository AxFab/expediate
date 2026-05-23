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

import createRouter from './router.js';
import type { RouterRequest, RouterResponse, Router } from './router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An API error thrown (or rejected) by a service method.
 *
 * When a service method throws or rejects with an object of this shape, the
 * framework translates it into an HTTP error response automatically:
 * - `status` → HTTP status code (defaults to `500`).
 * - `data`       → JSON-serialised response body (takes precedence over `message`).
 * - `message`    → Plain-text response body.
 */
export interface ApiError {
  /** HTTP status code to send (e.g. `404`, `503`). Defaults to `500`. */
  status?: number;
  /** Structured error payload; serialised to JSON when present. */
  data?: unknown;
  /** Human-readable error message used when `data` is absent. */
  message?: string;
}

/**
 * A service method handler.
 *
 * Called with `this` bound to the current service instance.
 *
 * @param params - Route parameters extracted from the URL (e.g. `{ uid: '42' }`),
 *                 merged with URL query-string parameters.
 * @param body   - Parsed request body (populated by a body-parsing middleware
 *                 such as `json()`).
 * @returns The value to send as the JSON response body, a `Promise` of the
 *          same, or `undefined` / `null` / any falsy value to send **201 No
 *          Content** (useful for mutations that produce no response body).
 */
export type ServiceMethod<TInstance = ServiceInstance> = (
  this:   TInstance,
  params: Record<string, string>,
  body?:  unknown,
) => unknown | Promise<unknown>;

/**
 * The runtime state object that backs a service instance.
 *
 * Produced by `service.data()` and extended with the methods from
 * `service.methods` before `service.setup()` is called.  A hidden `$key`
 * property carries the scope key when `data()` is not supplied.
 */
export type ServiceInstance = Record<string, unknown> & {
  /** The scope key used to identify this instance (set by the framework). */
  $key?: string | null;
};

/**
 * A named map of method functions to mix into every service instance.
 *
 * Methods declared here are copied onto the instance object, bound to `this`,
 * so they can call each other and read/write instance state naturally.
 */
export type ServiceMethods<TInstance extends ServiceInstance = ServiceInstance> = {
  [name: string]: (this: TInstance, ...args: unknown[]) => unknown;
};

/**
 * A route map: keys are Express-style path patterns, values are handler
 * functions that are invoked with `this` bound to the service instance.
 */
export type RouteMap<TInstance extends ServiceInstance = ServiceInstance> = {
  [path: string]: ServiceMethod<TInstance>;
};

/**
 * A service definition object — the single argument to {@link apiBuilder}.
 *
 * A service declares its state, helper methods, and HTTP route handlers in
 * one cohesive object.  The framework instantiates the service (once globally
 * for a singleton, or per-scope key), mixes in the helper methods, runs
 * `setup()`, then calls the appropriate route handler for each HTTP request.
 *
 * **Scoping:**
 * - When `scope` is **absent** (or not a function), the service is a
 *   **singleton**: one shared instance handles all requests.
 * - When `scope` returns a **truthy string**, the same instance is reused
 *   for all requests that share that key (e.g. one instance per session).
 * - When `scope` returns **`null`**, a **fresh instance** is created for
 *   every request and discarded afterwards (recommended for stateless services).
 *
 * @template TInstance - The shape of the service's state object.
 */
export interface ServiceDefinition<TInstance extends ServiceInstance = ServiceInstance> {
  /**
   * Determine the scope key for the current request.
   *
   * - Return a **string** → instances are cached by that key (e.g. session ID).
   * - Return **`null`**   → create a new, disposable instance per request.
   * - Omit entirely       → the service is a **singleton** (one global instance).
   *
   * @example
   * ```ts
   * scope: (req) => (req as any).session?.ssid ?? null,
   * ```
   */
  scope?: (req: RouterRequest) => string | null;

  /**
   * Factory that returns the initial state object for a new instance.
   *
   * When omitted, the instance is initialised as `{ $key: key }`.
   *
   * @param key - The scope key passed by the framework (`'singleton'` for
   *              global instances, `null` for ephemeral ones, or the string
   *              returned by `scope()`).
   */
  data?: (key: string | null) => TInstance;

  /**
   * Lifecycle hook called once after an instance is created and its methods
   * are mixed in.
   *
   * May be synchronous or asynchronous.  When asynchronous, the returned
   * `Promise` is not awaited by the framework — use a `throwIfNotReady()`
   * pattern in your methods to guard against premature access.
   */
  setup?: (this: TInstance) => void | Promise<void>;

  /**
   * Helper methods mixed into every service instance.
   *
   * All methods are bound to the instance (`this` = instance), so they can
   * read and write state, call other methods, and throw {@link ApiError}
   * objects to trigger HTTP error responses.
   */
  methods?: ServiceMethods<TInstance>;

  /** Route handlers for `GET` requests. */
  GET?:    RouteMap<TInstance>;
  /** Route handlers for `POST` requests. */
  POST?:   RouteMap<TInstance>;
  /** Route handlers for `PUT` requests. */
  PUT?:    RouteMap<TInstance>;
  /** Route handlers for `DELETE` requests. */
  DELETE?: RouteMap<TInstance>;
  /** Route handlers for `PATCH` requests. */
  PATCH?:  RouteMap<TInstance>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Instantiate a new service module for the given scope `key`.
 *
 * The lifecycle is:
 * 1. **`data(key)`** — create the initial state object (or use `{ $key: key }`
 *    when `data` is not defined).
 * 2. **Mix in methods** — each entry in `service.methods` is copied onto the
 *    instance as a regular function bound to `this`.
 * 3. **`setup()`** — called once on the new instance; may be async.
 *
 * @param service - The service definition.
 * @param key     - The scope key (`'singleton'`, `null`, or a session ID).
 * @returns A fully initialised service instance.
 */
function buildModule<TInstance extends ServiceInstance>(
  service: ServiceDefinition<TInstance>,
  key:     string | null,
): TInstance {
  const instance: TInstance = service.data
    ? service.data(key)
    : ({ $key: key } as unknown as TInstance);

  // Mix service methods into the instance, bound to `this = instance`.
  // Arrow functions do NOT have their own `arguments` object — they inherit it
  // from the enclosing `buildModule` scope (which holds `(service, key)`).
  // Any arguments forwarded to the method were therefore silently dropped.
  // Corrected to a regular function expression that captures its own `arguments`
  // via a rest parameter spread.
  if (service.methods) {
    for (const methodName of Object.keys(service.methods)) {
      const method = service.methods[methodName];
      (instance as Record<string, unknown>)[methodName] = function (
        this: TInstance,
        ...args: unknown[]
      ): unknown {
        return method.apply(instance, args);
      };
    }
  }

  if (service.setup)
    service.setup.apply(instance, [] as []);

  return instance;
}

/**
 * Resolve the correct service instance for an incoming request.
 *
 * Instance lifecycle by scope:
 * - **Singleton** (`scope` absent): always returns `modules['singleton']`.
 * - **Keyed** (`scope` returns a string): look up `modules[key]`; create and
 *   cache a new instance on first access.
 * - **Ephemeral** (`scope` returns `null`): create a fresh instance every time;
 *   never cached.
 *
 * @param service - The service definition.
 * @param modules - The instance cache (mutated when a new keyed instance is created).
 * @param req     - The incoming request.
 * @returns The service instance to use for this request.
 */
function resolveInstance<TInstance extends ServiceInstance>(
  service: ServiceDefinition<TInstance>,
  modules: Record<string, TInstance>,
  req:     RouterRequest,
): TInstance {
  if (typeof service.scope !== 'function') {
    // Singleton — always the same global instance.
    return modules['singleton'];
  }

  const key = service.scope(req);

  if (key === null) {
    // Ephemeral — create a fresh, uncached instance for every request.
    return buildModule(service, null);
  }

  // Keyed — retrieve from cache or create and store.
  if (!modules[key])
    modules[key] = buildModule(service, key);

  return modules[key];
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON response with the appropriate `Content-Type` header.
 *
 * @param res  - The outgoing response.
 * @param data - Any JSON-serialisable value.
 */
function sendJson(res: RouterResponse, data: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data));
}

/**
 * Translate a caught error (thrown or rejected by a service method) into an
 * HTTP error response.
 *
 * Expected shape: `{ status?, data?, message? }` (see {@link ApiError}).
 * Any other thrown value is treated as an opaque 500 Internal Server Error.
 *
 * @param res - The outgoing response.
 * @param err - The caught value.
 */
function sendError(res: RouterResponse, err: unknown): void {
  const e = err as ApiError | undefined;
  const status = e?.status ?? 500;
  if (e?.data !== undefined) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).send(JSON.stringify(e.data));
  } else {
    res.status(status).send(e?.message ?? 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an Express-compatible router from a service definition object.
 *
 * The returned router is suitable for mounting via `app.use()`:
 *
 * ```ts
 * import myService from './my-service.js';
 *
 * app.use('/api', apiBuilder(myService));
 * ```
 *
 * **Route handlers** declared in `service.GET`, `service.POST`, etc. are
 * called with `this` bound to the service instance.  They receive two
 * arguments:
 * 1. `params` — merged route + query-string parameters from `req.params`.
 * 2. `body`   — the parsed request body from `req.body` (requires a
 *    body-parsing middleware such as `json()` to run first).
 *
 * **Return values:**
 * - A **truthy value** (or a `Promise` resolving to one) → serialised as JSON
 *   with status `200 OK`.
 * - A **falsy value** (`undefined`, `null`, `false`, `0`, `''`) or a
 *   `Promise` resolving to one → `201 No Content` (useful for mutations).
 *
 * **Error handling:**
 * - Throwing or rejecting with `{ status, message }` sends the
 *   corresponding HTTP error.
 * - Throwing or rejecting with `{ status, data }` sends the `data` object
 *   as a JSON body.
 * - Any other thrown value produces `500 Internal Server Error`.
 *
 * @param service - The service definition (see {@link ServiceDefinition}).
 * @returns A router instance pre-configured with all declared routes.
 */
export function apiBuilder<TInstance extends ServiceInstance = ServiceInstance>(
  service: ServiceDefinition<TInstance>,
): Router {
  const api     = createRouter();
  const modules: Record<string, TInstance> = {};

  // Pre-build the singleton instance eagerly so `setup()` runs at startup.
  if (typeof service.scope !== 'function')
    // Corrected to pass `'singleton'` as the canonical key.
    modules['singleton'] = buildModule(service, 'singleton');

  /**
   * Register all route handlers from a route map for a given HTTP method.
   *
   * Each handler:
   * 1. Resolves the correct service instance (singleton / keyed / ephemeral).
   * 2. Invokes the service method with `(params, body)`.
   * 3. Sends the return value as JSON (or 201 if falsy).
   * 4. Catches thrown / rejected {@link ApiError} objects and translates them
   *    into the appropriate HTTP error response.
   *
   * @param routeMap - Map of path patterns to service methods (`undefined` = skip).
   * @param register - Registers a handler on the router for the current HTTP method.
   */
  function buildRoutes(
    routeMap: RouteMap<TInstance> | undefined,
    register: (path: string, handler: (req: RouterRequest, res: RouterResponse) => void) => void,
  ): void {
    if (!routeMap) return;

    // Sort routes by decreasing specificity so that more precise patterns
    // (more segments, fewer parameters) are registered first in the router.
    // Without this, a plain path like '/items' would match '/items/1' as a
    // prefix and steal requests intended for '/items/:id'.
    // Specificity = (segment count * 100) - (parameter count * 10).
    const sortedPaths = Object.keys(routeMap).sort((a, b) => {
      const score = (p: string) => {
        const segs = p.split('/').filter(s => s.length > 0);
        return segs.length * 100 - segs.filter(s => s.startsWith(':')).length * 10;
      };
      return score(b) - score(a) || b.localeCompare(a);
    });

    for (const path of sortedPaths) {
      const method = routeMap[path];

      register(path, (req: RouterRequest, res: RouterResponse): void => {
        const params = req.params as Record<string, string>;
        const body   = (req as any).body;

        try {
          const instance = resolveInstance(service, modules, req);
          const ret      = method.apply(instance, [params, body]);

          if (ret instanceof Promise) {
            ret
              .then((val) => {
                if (val !== undefined && val !== null && val !== false && val !== 0 && val !== '')
                  sendJson(res, val);
                else
                  res.status(201).end();
              })
              .catch((err) => sendError(res, err));
          } else {
            if (ret !== undefined && ret !== null && ret !== false && ret !== 0 && ret !== '')
              sendJson(res, ret);
            else
              res.status(201).end();
          }
        } catch (err) {
          sendError(res, err);
        }
      });
    }
  }

  buildRoutes(service.GET,    (path, h) => api.get(path,    h as any));
  buildRoutes(service.POST,   (path, h) => api.post(path,   h as any));
  buildRoutes(service.PUT,    (path, h) => api.put(path,    h as any));
  buildRoutes(service.DELETE, (path, h) => api.delete(path, h as any));
  buildRoutes(service.PATCH,  (path, h) => api.patch(path,  h as any));

  return api;
}

export default apiBuilder;
