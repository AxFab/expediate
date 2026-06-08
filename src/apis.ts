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
import { openApiSpec, serializeSpec } from './openapi.js';
import type { SpecOptions, SpecFormat, OpenApiDocument } from './openapi.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context object passed as the first argument to every service method handler.
 *
 * Replaces the old flat `params` map: route parameters, URL query parameters,
 * and other request-scoped data are now namespaced to avoid collisions and to
 * make each data source explicit.
 *
 * @example
 * ```ts
 * GET: {
 *   '/items/:id': function (ctx: ApiContext) {
 *     const id  = ctx.query.route.id;   // ':id' from the path pattern
 *     const fmt = ctx.query.url.format; // '?format=json' from the query string
 *     return getItem(id, fmt);
 *   },
 * }
 * ```
 */
export interface ApiContext {
  /** Route and URL query parameters, separated by origin. */
  query: {
    /**
     * Named parameters captured from the route pattern.
     *
     * For example, a route registered as `/items/:id` matched against
     * `/items/42` produces `{ id: '42' }`.
     */
    route: Record<string, string>;
    /**
     * Parameters decoded from the URL query string.
     *
     * Repeated keys are preserved as string arrays.
     * For example, `?q=hello&tag=a&tag=b` → `{ q: 'hello', tag: ['a', 'b'] }`.
     */
    url: Record<string, string | string[]>;
  };
  /**
   * The request path as seen by this API router, after any prefix stripping
   * performed by a parent `use()` mount.
   */
  path: string;
  /**
   * Authentication data attached to the request, if present.
   *
   * Populated when a middleware (e.g. a JWT `authenticate` middleware) sets
   * `req.user` before the service method is called.  `undefined` when no
   * authentication data has been attached.
   */
  user?: any;
}

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
 * @param ctx  - Request context containing route parameters, URL query
 *               parameters, the request path, and optional auth data.
 *               See {@link ApiContext}.
 * @param body - Parsed request body (populated by a body-parsing middleware
 *               such as `json()`).
 * @returns The value to send as the JSON response body, a `Promise` of the
 *          same, or `undefined` / `null` / any falsy value to send **201 No
 *          Content** (useful for mutations that produce no response body).
 */
export type ServiceMethod<TInstance = ServiceInstance, TResponse = any, TBody = any> = (
  this:  TInstance,
  ctx:   ApiContext,
  body?: TBody,
) => TResponse | Promise<TResponse>;

/**
 * The runtime state object that backs a service instance.
 *
 * Produced by `service.data()` (which returns `Partial<TInstance>`) and
 * extended with the methods from `service.methods` before `service.setup()`
 * is called.  A hidden `$key` property carries the scope key when `data()` is
 * not supplied.
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
 * Extra methods attached to the router returned by {@link apiBuilder}.
 *
 * These allow the service's route definitions to be introspected and
 * serialised as an OpenAPI 3.1.0 document.
 */
export interface ApiRouterExtensions {
  /**
   * Generate an OpenAPI 3.1.0 document from the service definition.
   *
   * @param opts - Top-level spec options (title, version, basePath, …).
   * @returns A plain-object OpenAPI document ready to be serialised with
   *          `JSON.stringify`.
   */
  spec(opts: SpecOptions): OpenApiDocument;

  /**
   * Return a request handler that serves the OpenAPI spec on `GET`.
   *
   * The spec is generated once and cached as a serialised string on the first
   * call to the returned handler.
   *
   * ```ts
   * // JSON (default)
   * app.get('/openapi.json', itemsApi.specHandler({ title: 'Items API', version: '1.0.0' }));
   *
   * // YAML
   * app.get('/openapi.yaml', itemsApi.specHandler({ title: 'Items API', version: '1.0.0' }, 'yaml'));
   * ```
   *
   * @param opts   - Top-level spec options (title, version, basePath, …).
   * @param format - Output format: `'json'` (default) or `'yaml'`.
   * @returns An Express-compatible middleware handler.
   */
  specHandler(opts: SpecOptions, format?: SpecFormat): (req: RouterRequest, res: RouterResponse) => void;
}

/**
 * The return type of {@link apiBuilder}: a standard {@link Router} augmented
 * with OpenAPI introspection helpers ({@link ApiRouterExtensions}).
 */
export type ApiRouter = Router & ApiRouterExtensions;

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
   * Factory that returns the **initial data** portion of a new instance.
   *
   * The return type is `Partial<TInstance>` because the methods declared in
   * {@link ServiceDefinition.methods} are mixed in *after* `data()` is called,
   * completing the instance shape.  By the time any route handler or
   * `setup()` runs the instance is fully initialised.
   *
   * When omitted, the instance is initialised as `{ $key: key }`.
   *
   * @param key - The scope key passed by the framework (`'singleton'` for
   *              global instances, `null` for ephemeral ones, or the string
   *              returned by `scope()`).
   */
  data?: (key: string | null) => Partial<TInstance>;

  /**
   * Lifecycle hook called once after an instance is created and its methods
   * are mixed in.
   *
   * May be synchronous or **asynchronous**.  When asynchronous, the framework
   * now awaits the returned `Promise` before marking the instance as ready:
   * - For **singleton** services, route handlers are only registered (and
   *   requests served) once setup resolves.  Requests that arrive while setup
   *   is in progress receive **503 Service not ready**.
   * - For **keyed / ephemeral** services, the route handler awaits instance
   *   creation (including setup) per request before invoking the method.
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
 * Instantiate a new service module for the given scope `key` and await its
 * setup lifecycle hook.
 *
 * The lifecycle is:
 * 1. **`data(key)`** — create the initial data object (`Partial<TInstance>`);
 *    methods are mixed in next to complete the shape.
 * 2. **Mix in methods** — each entry in `service.methods` is copied onto the
 *    instance as a regular function bound to `this = instance`.
 * 3. **`await setup()`** — if `setup` returns a `Promise`, it is fully
 *    awaited before the instance is returned.  Any rejection propagates to
 *    the caller.
 *
 * @param service - The service definition.
 * @param key     - The scope key (`'singleton'`, `null`, or a session ID).
 * @returns A Promise resolving to a fully initialised service instance.
 */
async function buildModule<TInstance extends ServiceInstance>(
  service: ServiceDefinition<TInstance>,
  key:     string | null,
): Promise<TInstance> {
  // `data()` returns Partial<TInstance>; methods are mixed in below to complete
  // the instance shape.  The cast is intentional and safe — by the time this
  // function returns the instance IS a full TInstance.
  const instance: TInstance = service.data
    ? service.data(key) as TInstance
    : ({ $key: key } as unknown as TInstance);

  // Mix service methods into the instance, bound to `this = instance`.
  // Regular function expressions are used (not arrow functions) so that each
  // method has its own `arguments` object and `this` binding works correctly.
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

  // Await setup so that async initialisation (DB connections, config fetches,
  // etc.) completes before the instance is considered ready.
  if (service.setup)
    await service.setup.apply(instance, [] as []);

  return instance;
}

/**
 * Resolve the correct service instance for an incoming request.
 *
 * Instance lifecycle by scope:
 * - **Singleton** (`scope` absent): always returns `modules['singleton']`.
 *   The singleton is guaranteed to be fully initialised before routes run,
 *   so this path is synchronous within the async wrapper.
 * - **Keyed** (`scope` returns a string): look up `modules[key]`; on first
 *   access, build and cache the instance (in-flight builds for the same key
 *   are deduplicated via `building` to avoid concurrent double-builds).
 * - **Ephemeral** (`scope` returns `null`): create a fresh, uncached instance
 *   for every request.
 *
 * @param service  - The service definition.
 * @param modules  - The resolved-instance cache (mutated on first keyed access).
 * @param building - In-flight build-promise cache; prevents duplicate builds
 *                   for the same key under concurrent requests.
 * @param req      - The incoming request.
 * @returns A Promise resolving to the service instance for this request.
 */
async function resolveInstance<TInstance extends ServiceInstance>(
  service:  ServiceDefinition<TInstance>,
  modules:  Record<string, TInstance>,
  building: Record<string, Promise<TInstance>>,
  req:      RouterRequest,
): Promise<TInstance> {
  if (typeof service.scope !== 'function') {
    // Singleton — routes only run after setup is complete, so this is safe.
    return modules['singleton'];
  }

  const key = service.scope(req);

  if (key === null) {
    // Ephemeral — create a fresh, uncached instance for every request.
    return buildModule(service, null);
  }

  // Keyed — retrieve from resolved cache or initiate (and deduplicate) a build.
  if (modules[key]) return modules[key];

  if (!building[key]) {
    building[key] = buildModule(service, key).then(instance => {
      modules[key] = instance;
      delete building[key];
      return instance;
    });
  }

  return building[key];
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
  // console.error('Api Err', err)
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
 * **Singleton setup lifecycle:**
 * When `service.scope` is absent the service is a singleton.  The framework
 * pre-builds the instance eagerly and registers a **503 Service not ready**
 * guard middleware on the router immediately.  Route handlers are registered
 * only once `setup()` resolves (or immediately, for sync setup).  Any request
 * that arrives before setup completes receives a 503 response.
 *
 * **Keyed / ephemeral setup lifecycle:**
 * Route handlers are registered immediately.  For each request,
 * `resolveInstance()` is awaited inside the handler, so `setup()` is always
 * complete before the service method is invoked.
 *
 * **Route handlers** declared in `service.GET`, `service.POST`, etc. are
 * called with `this` bound to the service instance.  They receive two
 * arguments:
 * 1. `ctx`  — an {@link ApiContext} object containing `ctx.query.route`
 *    (named route parameters), `ctx.query.url` (URL query-string parameters),
 *    `ctx.path` (the request path), and `ctx.user` (optional auth data).
 * 2. `body` — the parsed request body from `req.body` (requires a
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
): ApiRouter {
  const api      = createRouter() as ApiRouter;
  /** Resolved instance cache: populated once setup completes for a given key. */
  const modules: Record<string, TInstance>           = {};
  /** In-flight build promises: deduplicates concurrent keyed instance builds. */
  const building: Record<string, Promise<TInstance>> = {};

  /**
   * Register all route handlers from a route map for a given HTTP method.
   *
   * Each handler:
   * 1. Resolves the correct service instance (awaiting setup when needed).
   * 2. Builds an {@link ApiContext} from the incoming request.
   * 3. Invokes the service method with `(ctx, body)`.
   * 4. Sends the return value as JSON (or 201 if falsy).
   * 5. Catches thrown / rejected {@link ApiError} objects and translates them
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
        const ctx: ApiContext = {
          query: {
            route: req.queries?.route ?? {},
            url:   req.queries?.url   ?? {},
          },
          path: req.path,
          user: (req as any).user,
        };
        const body = (req as any).body;

        // Await instance resolution (no-op microtask for singletons; may
        // trigger async buildModule for keyed / ephemeral instances).
        resolveInstance(service, modules, building, req)
          .then(instance => {
            const ret = method.apply(instance, [ctx, body]);

            if (ret instanceof Promise) {
              return ret
                .then(val => {
                  if (val !== undefined && val !== null && val !== false && val !== 0 && val !== '')
                    sendJson(res, val);
                  else
                    res.status(201).end();
                })
                .catch(err => {
                  // console.error(err)
                  sendError(res, err)
                });
            }

            if (ret !== undefined && ret !== null && ret !== false && ret !== 0 && ret !== '')
              sendJson(res, ret);
            else
              res.status(201).end();
          })
          .catch(err =>  {
            // console.error(err)
            sendError(res, err)
          });
      });
    }
  }

  /** Convenience wrapper to register routes for all five HTTP verbs. */
  function registerAllRoutes(): void {
    buildRoutes(service.GET,    (path, h) => api.get(path,    h as any));
    buildRoutes(service.POST,   (path, h) => api.post(path,   h as any));
    buildRoutes(service.PUT,    (path, h) => api.put(path,    h as any));
    buildRoutes(service.DELETE, (path, h) => api.delete(path, h as any));
    buildRoutes(service.PATCH,  (path, h) => api.patch(path,  h as any));
  }

  if (typeof service.scope !== 'function') {
    // ── Singleton ─────────────────────────────────────────────────────────
    // Register a "not ready" guard first so that requests arriving while
    // setup is in progress receive 503 rather than 404.
    let ready = false;
    api.use('/', (_req: RouterRequest, res: RouterResponse, next: any): void => {
      if (!ready) {
        res.statusCode = 503;
        res.end('Service not ready');
        return;
      }
      next();
    });

    // Build the singleton asynchronously, then flip the guard and register
    // routes.  Even for synchronous setup() functions, buildModule() is async
    // (it uses await internally), so route registration happens in a microtask
    // that runs before any I/O callbacks — routes are always in place by the
    // time the first HTTP request can be processed.
    buildModule(service, 'singleton')
      .then(instance => {
        modules['singleton'] = instance;
        ready = true;
        registerAllRoutes();
      })
      .catch(err => {
        // setup() rejected — log the error; the guard permanently returns 503.
        console.error('[apiBuilder] singleton setup() rejected:', err);
      });
  } else {
    // ── Keyed / ephemeral ─────────────────────────────────────────────────
    // Register routes immediately.  Each handler awaits resolveInstance(),
    // which in turn awaits buildModule() for first-time keyed instances.
    registerAllRoutes();
  }

  // ── OpenAPI introspection ──────────────────────────────────────────────────

  /**
   * Generate an OpenAPI 3.1.0 document from the service definition.
   * Delegates to {@link openApiSpec} from `openapi.ts`.
   */
  api.spec = function (opts: SpecOptions): OpenApiDocument {
    return openApiSpec(service, opts);
  };

  /**
   * Return a middleware handler that serves the OpenAPI spec as JSON or YAML.
   * The spec is generated once and cached on the first call to the returned handler.
   */
  api.specHandler = function (opts: SpecOptions, format: SpecFormat = 'json'): (req: RouterRequest, res: RouterResponse) => void {
    let cached: string | null = null;
    const contentType = format === 'yaml'
      ? 'application/yaml; charset=utf-8'
      : 'application/json; charset=utf-8';
    return function (_req: RouterRequest, res: RouterResponse): void {
      if (!cached) cached = serializeSpec(openApiSpec(service, opts), format);
      res.setHeader('Content-Type', contentType);
      res.end(cached);
    };
  };

  return api;
}

export default apiBuilder;
