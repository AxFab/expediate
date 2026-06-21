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
import type { RouterRequest, RouterResponse, Router, Middleware, NextFunction } from './router.js';
import { openApiSpec, serializeSpec, DESCRIBE_META } from './openapi.js';
import type {
  SpecOptions,
  SpecFormat,
  OpenApiDocument,
  OperationMeta,
  JsonSchema,
  RequestBodyObject,
  ResponseObject,
} from './openapi.js';

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
 *     const id  = ctx.params.id;        // ':id' from the path pattern
 *     const fmt = ctx.query.url.format; // '?format=json' from the query string
 *     return getItem(id, fmt);
 *   },
 * }
 * ```
 *
 * @template TUser  - The shape of the authenticated user payload (e.g.
 *                    `TokenPayload` from the JWT plugin). Defaults to
 *                    `unknown`, forcing explicit typing for safe access.
 * @template TState - The shape of the guard-produced `state` bag.
 */
export interface ApiContext<TUser = unknown, TState = Record<string, unknown>> {
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
   * Shorthand alias for {@link ApiContext.query}.route — the named parameters
   * captured from the route pattern.  This is the dominant access pattern;
   * the namespaced form remains available for collision cases.
   */
  params: Record<string, string>;
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
  user?: TUser;
  /**
   * Values produced by guards (loaded resources, resolved roles, …).
   *
   * Each guard that returns an object has that object shallow-merged into
   * this bag before the next guard (or the handler) runs.  Starts as `{}`
   * for every request.
   */
  state: TState;
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
export type ServiceMethods<TInstance extends ServiceInstance = ServiceInstance> = Record<string, (this: TInstance, ...args: unknown[]) => unknown>;

/**
 * A route map: keys are Express-style path patterns, values are handler
 * functions that are invoked with `this` bound to the service instance.
 */
export type RouteMap<TInstance extends ServiceInstance = ServiceInstance> = Record<string, ServiceMethod<TInstance>>;

/**
 * A pre-handler hook running in the `ctx` world.
 *
 * Guards attach at three levels — API (`ServiceDefinition.guards`),
 * controller (`ControllerDefinition.guards`), and route
 * (`OperationMeta.guards` via `describe()`) — and run outermost-first:
 *
 * ```
 * auth.authenticate → auth.check → api guards → controller guards → route guards → handler
 * ```
 *
 * A guard may:
 * - **throw / reject** an {@link ApiError} → translated to an HTTP error response;
 * - **return an object** → shallow-merged into `ctx.state`;
 * - **return void** → pure check.
 *
 * Guards are loosely typed on purpose (`ctx.user` is `any` here); declare
 * `ApiContext<TUser, TState>` explicitly in handlers for strict typing.
 *
 * @example
 * ```ts
 * const requireAdmin: Guard = (ctx) => {
 *   if (!ctx.user?.isAdmin) throw { status: 403, message: 'Admin access required' };
 *   return { admin: true };   // → ctx.state.admin
 * };
 * ```
 */
export type Guard = (
  ctx: ApiContext<any, Record<string, unknown>>,
  req: RouterRequest,
) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;

/**
 * A group of routes sharing a path prefix, default OpenAPI tags, guards, and
 * a default permission requirement.
 *
 * Controllers are *route organisation*, not isolation boundaries: handlers in
 * every controller run with `this` bound to the same service instance (the
 * instance lifecycle — `scope` / `data` / `setup` / `methods` — stays at the
 * {@link ServiceDefinition} level).
 *
 * @template TInstance - The shape of the service's state object.
 */
export interface ControllerDefinition<TInstance extends ServiceInstance = ServiceInstance> {
  /** Path prefix prepended to every route in this controller (may contain params). */
  prefix?: string;
  /** Default OpenAPI tags applied to routes that do not declare their own. */
  tags?: string[];
  /** Guards run before every handler of this controller (see {@link Guard}). */
  guards?: Guard[];
  /**
   * Default permission requirement for every route of this controller.
   * Route-level `OperationMeta.permission` overrides it.  When set, the
   * pipeline runs `auth.check(ctx, required)` before the guards.
   */
  permission?: string | string[];

  /** Route handlers for `GET` requests (paths relative to `prefix`). */
  GET?:    RouteMap<TInstance>;
  /** Route handlers for `POST` requests (paths relative to `prefix`). */
  POST?:   RouteMap<TInstance>;
  /** Route handlers for `PUT` requests (paths relative to `prefix`). */
  PUT?:    RouteMap<TInstance>;
  /** Route handlers for `DELETE` requests (paths relative to `prefix`). */
  DELETE?: RouteMap<TInstance>;
  /** Route handlers for `PATCH` requests (paths relative to `prefix`). */
  PATCH?:  RouteMap<TInstance>;
}

/**
 * Identity helper for type inference and discoverability when declaring a
 * {@link ControllerDefinition} in its own file.
 *
 * @example
 * ```ts
 * export const wikiController = defineController({
 *   prefix: '/p/:proj/wiki',
 *   tags: ['Wiki'],
 *   permission: 'wiki.read',
 *   GET: { '/tree': (ctx) => listPages(ctx.params.proj) },
 * });
 * ```
 */
export function defineController<TInstance extends ServiceInstance = ServiceInstance>(
  c: ControllerDefinition<TInstance>,
): ControllerDefinition<TInstance> { return c; }

/**
 * Authentication / authorization binding connecting an auth layer (typically
 * the JWT plugin) to the API Builder pipeline.
 *
 * @example
 * ```ts
 * const jwt = createJwtPlugin({ accessTokenSecret: SECRET });
 * const api = apiBuilder({
 *   auth: { authenticate: jwt.authenticate },  // default check() reads ctx.user.permissions
 *   controllers: [ ... ],
 * });
 * ```
 *
 * @template TUser - The shape of the authenticated user payload.
 */
export interface AuthBinding<TUser = unknown> {
  /**
   * Router middleware run before any guard or handler — typically
   * `jwtPlugin.authenticate`.  Registered by `apiBuilder` on its internal
   * router, so the client no longer wires it per-mount.
   */
  authenticate?: Middleware;

  /**
   * Enforce a permission requirement for the current request.
   *
   * Default implementation: require `ctx.user` (else `401`) and check that
   * `ctx.user.permissions` contains **all** required entries (else `403`) —
   * i.e. the exact semantics of `jwtPlugin.requirePermission`, but in the
   * `ctx` world.  Override for resource-scoped models (per-project roles,
   * ownership, …); the override may load resources and share them through
   * `ctx.state`.
   *
   * Failure is signalled by throwing / rejecting an {@link ApiError}.
   */
  check?: (ctx: ApiContext<TUser>, required: string[]) => void | Promise<void>;

  /**
   * OpenAPI security scheme emitted into `components.securitySchemes.bearerAuth`
   * when at least one route declares a `permission`.
   *
   * Default: `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`.
   */
  scheme?: Record<string, unknown>;

  /**
   * Name of the vendor extension listing the required permissions on each
   * secured operation in the generated OpenAPI document.
   *
   * Default: `'x-required-permissions'`.
   */
  permissionsExtension?: string;
}

/**
 * Validation controls for {@link apiBuilder}.
 *
 * Used both as the factory's optional second argument and as the object form of
 * the {@link ServiceDefinition.validate} field. When passed as the second
 * argument it is authoritative and overrides `service.validate`:
 *
 * ```ts
 * apiBuilder(service);                                 // follows service.validate
 * apiBuilder(service, {});                              // validate requests (default), not responses
 * apiBuilder(service, { validateRequests: false });    // validate nothing
 * apiBuilder(service, { validateResponses: true });    // requests + responses (500 on mismatch)
 * apiBuilder(service, { validateResponses: 'warn' });  // requests + responses (log only, no 500)
 * ```
 */
export interface ApiBuilderOptions {
  /**
   * Validate incoming request bodies against each route's declared
   * `OperationMeta.requestBody` schema. Failures produce `400` with
   * `{ message, fieldErrors }`.
   *
   * @default true — pass `false` to cancel the incoming-data check.
   */
  validateRequests?: boolean;

  /**
   * Validate each handler's return value against the route's declared
   * `OperationMeta.responses['200']` schema before it is sent.
   *
   * - `true`  — a mismatch is a server-contract breach: the off-spec body is
   *   **not** sent; instead a `500` with `{ message, fieldErrors }` is returned.
   * - `'warn'` — a mismatch is logged server-side via `console.warn` and the
   *   response is sent unchanged (handy in development).
   * - `false` — no response checking.
   *
   * Only truthy returns (sent as `200` JSON) are checked; falsy returns
   * (`201 No Content`) and routes without a declared `200` response schema are
   * skipped.
   *
   * @default false
   */
  validateResponses?: boolean | 'warn';
}

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

  /**
   * Sub-controllers merged into this API.
   *
   * Each controller's routes are rewritten to `joinPath(prefix, path)`, then
   * all routes of all controllers (plus the root-level route maps below) are
   * concatenated and sorted by specificity **globally**.  A duplicate
   * `(verb, joined path)` pair across controllers **throws at build time**.
   *
   * All controllers share the single service instance lifecycle declared at
   * this level — controllers organise routes, they do not isolate state.
   */
  controllers?: ControllerDefinition<TInstance>[];

  /** Guards run before every handler of the whole API (see {@link Guard}). */
  guards?: Guard[];

  /** Authentication / authorization binding (see {@link AuthBinding}). */
  auth?: AuthBinding;

  /**
   * Enable runtime validation of declared schemas.
   *
   * - `true` — validate request bodies against each route's
   *   `OperationMeta.requestBody` schema (`400` with `{ message, fieldErrors }`
   *   on failure).
   * - An {@link ApiBuilderOptions} object — fine-grained control over request
   *   and response validation.
   *
   * Overridden when an {@link ApiBuilderOptions} object is passed as the second
   * argument to {@link apiBuilder}.
   */
  validate?: boolean | ApiBuilderOptions;

  /**
   * Reusable JSON Schema components, shared by request validation and spec
   * generation.  `$ref: '#/components/schemas/Name'` references in operation
   * metadata are resolved against this map by the validator, and the map is
   * merged into `components.schemas` of the generated OpenAPI document
   * (taking precedence over `SpecOptions.schemas`).
   */
  schemas?: Record<string, JsonSchema>;

  /**
   * Hook invoked whenever a handler, guard, auth check, or validation step
   * throws or rejects — before the default {@link ApiError} → HTTP translation.
   *
   * Use it to log the failure and/or shape a better response:
   * - **Return nothing** (`undefined`) → the error is left untouched and the
   *   built-in translation runs (`{ status, message | data }`, else `500`).
   *   Ideal for log-only use.
   * - **Return an {@link ApiError}** → that value is sent instead of the
   *   original (e.g. to hide internals behind a generic message, or attach a
   *   correlation id).
   * - **Throw** → the thrown value is escalated to the surrounding app's error
   *   channel (`router.error()` / `onError`) instead of being answered here,
   *   letting a process-wide handler take over.
   *
   * @param err - The caught value (thrown or rejected).
   * @param ctx - The {@link ApiContext} for the failing request.
   * @param req - The underlying request.
   * @returns An {@link ApiError} to override the response, or nothing to keep
   *   the default translation.
   */
  onError?(err: unknown, ctx: ApiContext<any>, req: RouterRequest): void | ApiError;

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
// Route collection (controller merge)
// ---------------------------------------------------------------------------

/** The five HTTP verbs supported by `apiBuilder`. */
const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

/** One of the five HTTP verbs supported by `apiBuilder`. */
export type ApiVerb = typeof VERBS[number];

/**
 * One merged route entry produced by {@link collectRoutes}.
 *
 * Records per-route provenance — effective tags, composed guard chain, and
 * permission requirement — consumed by both the request pipeline
 * (`apiBuilder`) and the spec generator (`openApiSpec`).
 *
 * @template TInstance - The shape of the service's state object.
 */
export interface CollectedRoute<TInstance extends ServiceInstance = ServiceInstance> {
  /** HTTP verb of the route. */
  verb: ApiVerb;
  /** Full path after joining the controller prefix (Express-style pattern). */
  path: string;
  /** The route handler (possibly `describe()`-wrapped). */
  handler: ServiceMethod<TInstance>;
  /** Operation metadata attached via `describe()`, when present. */
  meta?: OperationMeta;
  /** Effective tags: route-level `meta.tags`, else the controller's `tags`. */
  tags?: string[];
  /** Composed guard chain: API guards, then controller guards, then route guards. */
  guards: Guard[];
  /** Normalised permission requirement (route-level overrides controller-level). */
  permission?: string[];
  /** Human-readable controller identifier used in diagnostics. */
  controller: string;
}

/**
 * Join a controller prefix and a route path into a single normalised pattern.
 *
 * Duplicate slashes are collapsed and a trailing slash is stripped (except
 * for the root path), so `joinPath('/p/:proj/wiki', '/')` → `'/p/:proj/wiki'`.
 *
 * Exported for use by `openapi.ts` (multi-definition spec merging); not part
 * of the public package API.
 *
 * @param prefix - The controller prefix (may be empty).
 * @param path   - The route path relative to the prefix.
 */
export function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * Compute the specificity score of a route pattern.
 *
 * `score = (segment count × 100) − (parameter count × 10)`.  Higher scores
 * are registered first so that more precise patterns (more segments, fewer
 * parameters) cannot be shadowed by prefix matches.
 *
 * Exported for use by `openapi.ts` (multi-definition spec merging); not part
 * of the public package API.
 */
export function routeScore(path: string): number {
  const segs = path.split('/').filter(s => s.length > 0);
  return segs.length * 100 - segs.filter(s => s.startsWith(':')).length * 10;
}

/**
 * Normalise a `permission` declaration (`string | string[]`) to an array,
 * or `undefined` when absent.
 *
 * Exported for use by `openapi.ts` (multi-definition spec merging); not part
 * of the public package API.
 */
export function normalizePermission(permission: string | string[] | undefined): string[] | undefined {
  if (permission === undefined) return undefined;
  return Array.isArray(permission) ? permission : [permission];
}

/**
 * Build the merged route table for a service definition.
 *
 * The algorithm (see `docs/api-builder-v2-design.md` §4):
 * 1. Normalises the root-level route maps into an anonymous controller
 *    (`prefix: ''`) so v1 single-definition services keep working.
 * 2. Rewrites each controller route to `joinPath(prefix, path)`.
 * 3. Concatenates all routes of all controllers, then sorts them by
 *    decreasing specificity **globally** (the score is computed on the
 *    joined path, so prefix parameters are accounted for).
 * 4. **Throws** on a duplicate `(verb, joined path)` pair, naming both
 *    declaring controllers.
 * 5. Records per-route provenance (tags, guards, permission) consumed by
 *    both the request pipeline and `openApiSpec()`.
 *
 * Exported for use by `openapi.ts`; not part of the public package API.
 *
 * @param service - The service definition to collect routes from.
 * @returns The merged, globally sorted route table.
 * @throws  Error on duplicate `(verb, path)` declarations.
 */
export function collectRoutes<TInstance extends ServiceInstance = ServiceInstance>(
  service: ServiceDefinition<TInstance>,
): CollectedRoute<TInstance>[] {
  // 1. Root route maps form an implicit, anonymous controller.
  const rootController: ControllerDefinition<TInstance> = {
    prefix: '',
    GET:    service.GET,
    POST:   service.POST,
    PUT:    service.PUT,
    DELETE: service.DELETE,
    PATCH:  service.PATCH,
  };
  const controllers: ControllerDefinition<TInstance>[] =
    [rootController, ...(service.controllers ?? [])];

  /** Human-readable controller name for diagnostics. */
  const nameOf = (c: ControllerDefinition<TInstance>, index: number): string =>
    index === 0 ? '<root>' : (c.tags?.[0] ?? c.prefix ?? `#${index}`);

  const routes: CollectedRoute<TInstance>[] = [];
  /** Duplicate detection: `"VERB /joined/path"` → declaring controller name. */
  const seen = new Map<string, string>();

  controllers.forEach((controller, index) => {
    const controllerName = nameOf(controller, index);
    const prefix         = controller.prefix ?? '';

    for (const verb of VERBS) {
      const routeMap = controller[verb];
      if (!routeMap) continue;

      for (const [pattern, handler] of Object.entries(routeMap)) {
        const path = joinPath(prefix, pattern);

        // 4. Loud failure on duplicates — silent shadowing is unacceptable
        // with multi-file composition.
        const dupKey   = `${verb} ${path}`;
        const declarer = seen.get(dupKey);
        if (declarer !== undefined) {
          throw new Error(
            `apiBuilder: duplicate route ${verb} ${path}\n` +
            `  declared by controllers '${declarer}' and '${controllerName}'`);
        }
        seen.set(dupKey, controllerName);

        const meta = (handler as { [DESCRIBE_META]?: OperationMeta })[DESCRIBE_META];

        routes.push({
          verb,
          path,
          handler,
          meta,
          tags:       meta?.tags ?? controller.tags,
          guards:     [
            ...(service.guards ?? []),
            ...(controller.guards ?? []),
            ...(meta?.guards ?? []),
          ],
          permission: normalizePermission(meta?.permission ?? controller.permission),
          controller: controllerName,
        });
      }
    }
  });

  // 3. Global specificity sort across all controllers.
  routes.sort((a, b) =>
    routeScore(b.path) - routeScore(a.path) || b.path.localeCompare(a.path));

  return routes;
}

// ---------------------------------------------------------------------------
// Request-body validation (JSON Schema subset)
// ---------------------------------------------------------------------------

/**
 * Resolve a `$ref` of the form `#/components/schemas/Name` against the
 * service's schema components, following chained references with a small
 * depth guard against accidental reference cycles.
 *
 * Unknown references resolve to the empty schema `{}` (accepts anything),
 * mirroring the permissive behaviour of the spec generator.
 */
function resolveRef(schema: JsonSchema, components: Record<string, JsonSchema>): JsonSchema {
  let current = schema;
  for (let depth = 0; depth < 16 && current.$ref; depth++) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(current.$ref);
    const next  = match ? components[match[1]] : undefined;
    if (!next) return {};
    current = next;
  }
  return current;
}

/** Append a field error, keeping the first message reported for each path. */
function addError(errors: Record<string, string>, path: string, message: string): void {
  const key = path || '$';
  if (!(key in errors)) errors[key] = message;
}

/** Join a parent path and a child key into a dotted field-error path. */
function childPath(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

/** Map a runtime value to its JSON Schema type name. */
function jsonTypeOf(value: unknown): string {
  if (value === null)      return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate a value against a JSON Schema subset, collecting field errors.
 *
 * Supported keywords: `type`, `required`, `properties`, `items`, `enum`,
 * `pattern`, `minLength` / `maxLength`, `minimum` / `maximum`,
 * `additionalProperties`, `allOf` / `anyOf` / `oneOf`, and `$ref` (resolved
 * against `components`, i.e. `ServiceDefinition.schemas`).
 *
 * Field-error paths are dotted (`name`, `address.city`, `tags.0`); errors on
 * the value itself are keyed `'$'`.
 *
 * Exported for testing; not part of the public package API.
 *
 * @param value      - The value to validate.
 * @param schema     - The schema to validate against.
 * @param components - Reusable schemas for `$ref` resolution.
 * @param path       - Current field path (used in recursion; omit at the root).
 * @param errors     - Accumulator (used in recursion; omit at the root).
 * @returns A map of field path → first error message (empty when valid).
 */
export function validateSchema(
  value:      unknown,
  schema:     JsonSchema,
  components: Record<string, JsonSchema> = {},
  path        = '',
  errors:     Record<string, string> = {},
): Record<string, string> {
  const s = resolveRef(schema, components);

  // ── Combinators ───────────────────────────────────────────────────────────
  if (s.allOf) {
    for (const sub of s.allOf) validateSchema(value, sub, components, path, errors);
  }
  if (s.anyOf) {
    const passes = s.anyOf.some(sub =>
      Object.keys(validateSchema(value, sub, components, path, {})).length === 0);
    if (!passes) addError(errors, path, 'does not match any of the expected schemas (anyOf)');
  }
  if (s.oneOf) {
    const matches = s.oneOf.filter(sub =>
      Object.keys(validateSchema(value, sub, components, path, {})).length === 0).length;
    if (matches !== 1)
      addError(errors, path, `must match exactly one schema (oneOf), matched ${matches}`);
  }

  // ── type ─────────────────────────────────────────────────────────────────
  if (s.type !== undefined) {
    const actual = jsonTypeOf(value);
    const ok = s.type === 'integer'
      ? actual === 'number' && Number.isInteger(value)
      : actual === s.type;
    if (!ok) {
      addError(errors, path, `must be of type ${s.type}`);
      return errors;     // further keyword checks would be meaningless
    }
  }

  // ── enum ─────────────────────────────────────────────────────────────────
  if (s.enum && !s.enum.some(e => e === value ||
      (typeof e === 'object' && JSON.stringify(e) === JSON.stringify(value)))) {
    addError(errors, path, `must be one of: ${s.enum.map(e => JSON.stringify(e)).join(', ')}`);
  }

  // ── string keywords ──────────────────────────────────────────────────────
  if (typeof value === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value))
      addError(errors, path, `does not match pattern ${s.pattern}`);
    if (typeof s.minLength === 'number' && value.length < s.minLength)
      addError(errors, path, `must be at least ${s.minLength} characters`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength)
      addError(errors, path, `must be at most ${s.maxLength} characters`);
  }

  // ── number keywords ──────────────────────────────────────────────────────
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      addError(errors, path, `must be >= ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum)
      addError(errors, path, `must be <= ${s.maximum}`);
  }

  // ── array keywords ───────────────────────────────────────────────────────
  if (Array.isArray(value) && s.items) {
    value.forEach((item, i) =>
      validateSchema(item, s.items!, components, childPath(path, i), errors));
  }

  // ── object keywords ──────────────────────────────────────────────────────
  if (jsonTypeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;

    if (s.required) {
      for (const prop of s.required) {
        if (obj[prop] === undefined)
          addError(errors, childPath(path, prop), 'is required');
      }
    }

    if (s.properties) {
      for (const [prop, sub] of Object.entries(s.properties)) {
        if (obj[prop] !== undefined)
          validateSchema(obj[prop], sub, components, childPath(path, prop), errors);
      }
    }

    if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
      const known = new Set(Object.keys(s.properties ?? {}));
      for (const prop of Object.keys(obj)) {
        if (known.has(prop)) continue;
        if (s.additionalProperties === false)
          addError(errors, childPath(path, prop), 'unknown property');
        else
          validateSchema(obj[prop], s.additionalProperties,
            components, childPath(path, prop), errors);
      }
    }
  }

  return errors;
}

/**
 * Validate a request body against a route's declared `requestBody` schema.
 *
 * - Missing body + `requestBody.required` → `400`.
 * - Missing body, not required → skipped.
 * - Schema violations → `400` with `{ message, fieldErrors }` (see
 *   {@link validateSchema} for the `fieldErrors` shape).
 *
 * The `application/json` content entry is preferred; the first declared
 * content entry is used as a fallback.
 *
 * @throws An {@link ApiError} (`status: 400`) on validation failure.
 */
function validateRequestBody(
  requestBody: RequestBodyObject,
  body:        unknown,
  components:  Record<string, JsonSchema>,
): void {
  const content = requestBody.content?.['application/json']
    ?? Object.values(requestBody.content ?? {})[0];
  const schema  = content?.schema;

  if (body === undefined || body === null) {
    if (requestBody.required) {
      throw {
        status: 400,
        data: {
          message:     'Request body validation failed',
          fieldErrors: { $: 'request body is required' },
        },
      } satisfies ApiError;
    }
    return;
  }

  if (!schema) return;

  const fieldErrors = validateSchema(body, schema, components);
  if (Object.keys(fieldErrors).length > 0) {
    throw {
      status: 400,
      data: { message: 'Request body validation failed', fieldErrors },
    } satisfies ApiError;
  }
}

/**
 * Validate a handler's return value against the route's declared response
 * schema for `status`.
 *
 * Only acts when the route declares a response for that status with a content
 * schema (the `application/json` entry is preferred, otherwise the first
 * declared content entry). A violation means the server is about to emit a body
 * that breaks its own published contract:
 *
 * - `mode === true`  → raise a `500` {@link ApiError} (the off-spec body is not
 *   sent).
 * - `mode === 'warn'` → log via `console.warn` and return so the response is
 *   sent unchanged.
 *
 * @throws An {@link ApiError} (`status: 500`) when `mode === true` and the
 *   value fails validation.
 */
function validateResponseBody(
  responses:  Record<string, ResponseObject>,
  status:     number,
  value:      unknown,
  components: Record<string, JsonSchema>,
  mode:       true | 'warn',
): void {
  const response = responses[String(status)] ?? responses.default;
  const content  = response?.content?.['application/json']
    ?? Object.values(response?.content ?? {})[0];
  const schema   = content?.schema;
  if (!schema) return;

  const fieldErrors = validateSchema(value, schema, components);
  if (Object.keys(fieldErrors).length === 0) return;

  if (mode === 'warn') {
    console.warn('[apiBuilder] response body validation failed:', fieldErrors);
    return;
  }
  throw {
    status: 500,
    data: { message: 'Response body validation failed', fieldErrors },
  } satisfies ApiError;
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
    return modules.singleton;
  }

  const key = service.scope(req);

  if (key === null) {
    // Ephemeral — create a fresh, uncached instance for every request.
    return buildModule(service, null);
  }

  // Keyed — retrieve from resolved cache or initiate (and deduplicate) a build.
  if (modules[key]) return modules[key];

  building[key] ??= buildModule(service, key).then(instance => {
    modules[key] = instance;
    delete building[key];
    return instance;
  });

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
 * **Validation:**
 * - With no `options`, validation follows the {@link ServiceDefinition.validate}
 *   field.
 * - With `options`, request validation defaults **on** (cancel via
 *   `{ validateRequests: false }`) and response validation can be enabled with
 *   `{ validateResponses: true }` (500 on mismatch) or `{ validateResponses:
 *   'warn' }` (log only). See {@link ApiBuilderOptions}.
 *
 * @param service - The service definition (see {@link ServiceDefinition}).
 * @param options - Optional validation controls (see {@link ApiBuilderOptions}).
 *   When provided, it overrides the legacy `service.validate` field.
 * @returns A router instance pre-configured with all declared routes.
 */
export function apiBuilder<TInstance extends ServiceInstance = ServiceInstance>(
  service: ServiceDefinition<TInstance>,
  options?: ApiBuilderOptions,
): ApiRouter {
  const api      = createRouter() as ApiRouter;
  /** Resolved instance cache: populated once setup completes for a given key. */
  const modules: Record<string, TInstance>           = {};
  /** In-flight build promises: deduplicates concurrent keyed instance builds. */
  const building: Record<string, Promise<TInstance>> = {};

  // Merge controllers and root route maps into the global route table.
  // Throws here — at build time — on duplicate (verb, path) declarations.
  const routes = collectRoutes(service);

  // ── Auth binding ─────────────────────────────────────────────────────────
  // Register the authenticate middleware first so it runs before the 503
  // readiness guard, every guard, and every handler.
  if (service.auth?.authenticate)
    api.use('/', service.auth.authenticate);

  /**
   * Default permission check: mirrors `jwtPlugin.requirePermission` semantics
   * in the `ctx` world — `401` when unauthenticated, `403` when any required
   * permission is missing from `ctx.user.permissions`.
   */
  const defaultCheck = (ctx: ApiContext<any>, required: string[]): void => {
    const user = ctx.user as { permissions?: string[] } | undefined;
    if (!user)
      throw { status: 401, message: 'Authentication required' } satisfies ApiError;
    const perms = user.permissions ?? [];
    if (!required.every(p => perms.includes(p))) {
      throw {
        status:  403,
        message: `Insufficient permissions. Required: ${required.join(', ')}`,
      } satisfies ApiError;
    }
  };
  const check = service.auth?.check ?? defaultCheck;

  // ── Validation configuration ─────────────────────────────────────────────
  // The second argument, when given, is authoritative; otherwise fall back to
  // the `service.validate` field. Both share the ApiBuilderOptions shape:
  // request validation defaults ON for an options object, responses default OFF.
  // A bare `service.validate: true` enables requests only; absent means neither.
  const validation = options ?? service.validate;
  const validateRequests =
    validation === true ||
    (typeof validation === 'object' && validation.validateRequests !== false);
  const validateResponses: boolean | 'warn' =
    typeof validation === 'object' ? validation.validateResponses ?? false : false;
  /** Schema components shared by the validator and the spec generator. */
  const schemaComponents: Record<string, JsonSchema> = {
    ...service.openapi?.schemas,
    ...service.schemas,
  };

  /**
   * Register a set of collected routes for one HTTP verb.
   *
   * Each registered handler runs the full pipeline:
   * 1. Resolves the correct service instance (awaiting setup when needed).
   * 2. Builds an {@link ApiContext} from the incoming request
   *    (`params` aliases `query.route`; `state` starts empty).
   * 3. Runs `auth.check(ctx, required)` when the route declares a `permission`.
   * 4. Validates the request body against the declared schema (when enabled).
   * 5. Runs the guard chain (API → controller → route), shallow-merging any
   *    returned objects into `ctx.state`.
   * 6. Invokes the service method with `(ctx, body)`.
   * 7. Sends the return value as JSON (or 201 if falsy).
   * 8. Catches thrown / rejected {@link ApiError} objects from any stage and
   *    translates them into the appropriate HTTP error response.
   *
   * @param verbRoutes - Pre-sorted routes for the verb being registered.
   * @param register   - Registers a handler on the router for that verb.
   */
  function buildRoutes(
    verbRoutes: CollectedRoute<TInstance>[],
    register:   (path: string, handler: (req: RouterRequest, res: RouterResponse, next: NextFunction) => void) => void,
  ): void {
    for (const route of verbRoutes) {
      register(route.path, (req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
        const routeParams = req.queries?.route ?? {};
        const ctx: ApiContext<any> = {
          query: {
            route: routeParams,
            url:   req.queries?.url ?? {},
          },
          params: routeParams,
          path:   req.path,
          user:   req.user,
          state:  {},
        };
        const body = req.body;

        // Await instance resolution (no-op microtask for singletons; may
        // trigger async buildModule for keyed / ephemeral instances).
        resolveInstance(service, modules, building, req)
          .then(async instance => {
            // 3. Declarative authorization (opt-in per route / controller).
            if (route.permission)
              await check(ctx, route.permission);

            // 4. Request-body validation from the declared schema.
            if (validateRequests && route.meta?.requestBody)
              validateRequestBody(route.meta.requestBody, body, schemaComponents);

            // 5. Guard chain — outermost first; returned objects accumulate
            // into ctx.state for downstream guards and the handler.
            for (const guard of route.guards) {
              const produced = await guard(ctx, req);
              if (produced && typeof produced === 'object')
                Object.assign(ctx.state, produced);
            }

            // 6 + 7. Handler invocation and response conventions.
            const val = await route.handler.apply(instance, [ctx, body]);
            if (val !== undefined && val !== null && val !== false && val !== 0 && val !== '') {
              // Optional response-schema validation (server-contract check).
              if (validateResponses && route.meta?.responses)
                validateResponseBody(route.meta.responses, 200, val, schemaComponents, validateResponses);
              sendJson(res, val);
            } else {
              res.status(201).end();
            }
          })
          .catch(err => {
            // Optional service-level hook: inspect/log and optionally remap the
            // error before the default ApiError → HTTP translation.
            if (service.onError) {
              let override: void | ApiError;
              try {
                override = service.onError(err, ctx, req);
              } catch (hookErr) {
                // The hook re-threw → escalate to the surrounding app's error
                // channel (router.error() / onError) instead of answering here.
                next(hookErr);
                return;
              }
              if (override !== undefined) {
                sendError(res, override);
                return;
              }
            }
            sendError(res, err);
          });
      });
    }
  }

  /** Convenience wrapper to register routes for all five HTTP verbs. */
  function registerAllRoutes(): void {
    buildRoutes(routes.filter(r => r.verb === 'GET'),    (path, h) => api.get(path,    h));
    buildRoutes(routes.filter(r => r.verb === 'POST'),   (path, h) => api.post(path,   h));
    buildRoutes(routes.filter(r => r.verb === 'PUT'),    (path, h) => api.put(path,    h));
    buildRoutes(routes.filter(r => r.verb === 'DELETE'), (path, h) => api.delete(path, h));
    buildRoutes(routes.filter(r => r.verb === 'PATCH'),  (path, h) => api.patch(path,  h));
  }

  if (typeof service.scope !== 'function') {
    // ── Singleton ─────────────────────────────────────────────────────────
    // Register a "not ready" guard first so that requests arriving while
    // setup is in progress receive 503 rather than 404.
    let ready = false;
    api.use('/', (_req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
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
        modules.singleton = instance;
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
      cached ??= serializeSpec(openApiSpec(service, opts), format);
      res.setHeader('Content-Type', contentType);
      res.end(cached);
    };
  };

  return api;
}

export default apiBuilder;
