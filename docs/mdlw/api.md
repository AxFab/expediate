# `apiBuilder()` — Service-oriented API router

Builds a pre-configured `Router` from a single **service definition** object. A service definition declares the instance's initial state, helper methods, lifecycle hooks, and HTTP route handlers in one cohesive structure. The framework manages instantiation, method binding, async setup, and request dispatching so that route handlers can focus entirely on business logic.

## Usage

```ts
import { createRouter, json, apiBuilder } from 'expediate';

const app = createRouter();

const itemsApi = apiBuilder({
  data: () => ({ items: {} as Record<string, unknown> }),

  methods: {
    find(this: any, id: string) {
      const item = this.items[id];
      if (!item) throw { status: 404, message: 'Not found' };
      return item;
    },
  },

  GET: {
    '/items':     function (this: any)       { return Object.values(this.items); },
    '/items/:id': function (this: any, p: any) { return this.find(p.id); },
  },

  POST: {
    '/items': function (this: any, _p: any, body: any) {
      const id = crypto.randomUUID();
      this.items[id] = body;
      // falsy return → 201 No Content
    },
  },
});

// Mount with use() so the path prefix is stripped inside the sub-router
app.use('/api', json(), itemsApi);
```

## Signature

```ts
function apiBuilder<TInstance extends ServiceInstance = ServiceInstance>(
  service: ServiceDefinition<TInstance>,
): Router
```

The generic `TInstance` describes the shape of the service's state object. TypeScript infers it from `service.data` when provided.

---

## `ServiceDefinition<TInstance>`

The single argument to `apiBuilder`. All fields are optional except at least one route map (`GET`, `POST`, etc.) to do anything useful.

```ts
interface ServiceDefinition<TInstance extends ServiceInstance> {
  scope?:   (req: RouterRequest) => string | null;
  data?:    (key: string | null) => Partial<TInstance>;
  setup?:   (this: TInstance) => void | Promise<void>;
  methods?: ServiceMethods<TInstance>;
  GET?:     RouteMap<TInstance>;
  POST?:    RouteMap<TInstance>;
  PUT?:     RouteMap<TInstance>;
  DELETE?:  RouteMap<TInstance>;
  PATCH?:   RouteMap<TInstance>;
}
```

### `scope` — Instance scoping strategy

```ts
scope?: (req: RouterRequest) => string | null
```

Controls how many instances exist and how they are cached. The framework picks a scoping mode based on whether `scope` is present and what it returns:

| `scope` field | Mode | Behaviour |
|---|---|---|
| Absent / not a function | **Singleton** | One global instance shared by all requests. Created eagerly at `apiBuilder()` call time. |
| Returns a non-empty string | **Keyed** | One instance per key, cached indefinitely. First request for a key triggers creation; subsequent requests reuse it. |
| Returns `null` | **Ephemeral** | A fresh instance is created for every request and discarded afterwards. |

```ts
// Keyed: one instance per authenticated user
scope: (req) => (req as any).user?.id ?? null,

// Ephemeral: stateless, one-shot instance
scope: () => null,
```

### `data` — Initial state factory

```ts
data?: (key: string | null) => Partial<TInstance>
```

Called once per new instance. Returns the initial **data** portion of the service state. The return type is `Partial<TInstance>` because the helper methods declared in `methods` are mixed in immediately after `data()` returns, completing the full `TInstance` shape.

The `key` argument is the scope key that will identify this instance:
- `'singleton'` for singleton services
- `null` for ephemeral instances
- The string returned by `scope()` for keyed instances

When `data` is omitted, the instance is initialised as `{ $key: key }`.

```ts
data: (key) => ({
  id:      key,
  counter: 0,
  cache:   new Map<string, unknown>(),
}),
```

### `setup` — Async-safe initialisation hook

```ts
setup?: (this: TInstance) => void | Promise<void>
```

Called once after the instance is created and methods are mixed in. Both synchronous and asynchronous `setup` functions are supported. When `setup` returns a `Promise`, the framework **awaits it** before the instance is considered ready.

```ts
setup: async function (this: any) {
  this.db = await connectToDatabase(process.env.DB_URL!);
  this.ready = true;
},
```

**Singleton readiness guard**: for singleton services, requests that arrive while `setup` is still pending receive **503 Service not ready** automatically (see [Singleton lifecycle](#singleton-lifecycle)). For keyed and ephemeral services, the route handler awaits instance creation (including `setup`) before invoking the method.

If `setup` rejects, the error is logged and:
- Singleton: the 503 guard stays active permanently.
- Keyed/ephemeral: the rejection propagates and the route handler returns 500.

### `methods` — Shared helper methods

```ts
methods?: { [name: string]: (this: TInstance, ...args: unknown[]) => unknown }
```

Helper functions mixed into every service instance. They are bound to `this = instance`, so they can read and write state, call each other, and throw `ApiError` objects to trigger HTTP error responses.

```ts
methods: {
  requireAuth(this: any) {
    if (!this.currentUser) throw { status: 401, message: 'Unauthorized' };
  },
  findOrFail(this: any, id: string) {
    const item = this.items[id];
    if (!item) throw { status: 404, message: `Item ${id} not found` };
    return item;
  },
},
```

Methods mixed in this way are callable as `this.methodName()` from route handlers and from `setup`:

```ts
setup: function (this: any) {
  // setup can call methods too
  this.requireAuth();
},
GET: {
  '/items/:id': function (this: any, p: any) {
    return this.findOrFail(p.id);
  },
},
```

### Route maps — `GET`, `POST`, `PUT`, `DELETE`, `PATCH`

```ts
GET?: { [pathPattern: string]: ServiceMethod<TInstance> }
```

Each key is an Express-style path pattern; each value is a **service method** called with `this` bound to the instance:

```ts
type ServiceMethod<TInstance> = (
  this:   TInstance,
  params: Record<string, string>,
  body?:  unknown,
) => unknown | Promise<unknown>;
```

**Arguments:**
- `params` — merged map of URL route parameters and query-string parameters from `req.params`.
- `body` — the parsed request body from `req.body`. Requires a body-parsing middleware (`json()`, `parseBody()`, etc.) registered before the api router.

**Return value conventions:**

| Return value | HTTP response |
|---|---|
| Any truthy value | `200 OK` with JSON body |
| `Promise` resolving to a truthy value | `200 OK` with JSON body |
| `undefined`, `null`, `false`, `0`, `''` | `201 No Content` (empty body) |
| `Promise` resolving to a falsy value | `201 No Content` |

**Error conventions** — throw or reject with an `ApiError`:

```ts
interface ApiError {
  status?:  number;   // HTTP status code, default: 500
  message?: string;   // plain-text response body
  data?:    unknown;  // JSON response body (takes precedence over message)
}
```

```ts
// Plain-text error
throw { status: 404, message: 'Not found' };

// JSON error body
throw { status: 422, data: { field: 'email', reason: 'Invalid format' } };

// 500 with message
throw { message: 'Something went wrong' };

// Async rejection works too
return Promise.reject({ status: 503, message: 'Service unavailable' });
```

Any other thrown value (e.g. a plain `Error`) is caught and results in `500 Internal Server Error` using `err.message`.

---

## Instance lifecycle

For every new instance (singleton at startup, keyed on first access, ephemeral per request) the framework runs these steps in order:

```
data(key)           ← Partial<TInstance> initial state
    ↓
Mix in methods      ← TInstance is now complete
    ↓
await setup()       ← async-safe; awaited before instance is marked ready
    ↓
Instance ready      ← route handlers can now use it
```

---

## Scoping in depth

### Singleton lifecycle

When `scope` is absent, a single instance is shared across all requests. The framework:

1. Registers a **503 guard middleware** on the returned router immediately.
2. Calls `buildModule('singleton')` asynchronously. Even for a synchronous `setup`, this resolves as a microtask — before any I/O callback can deliver an HTTP request. In practice routes are always registered before the first request arrives.
3. On resolution: stores the instance, flips the guard off, and registers all route handlers.
4. On rejection: logs the error; the guard stays active returning 503 permanently.

```ts
// Singleton with async setup — requests before setup resolves get 503 automatically
const api = apiBuilder({
  setup: async function (this: any) {
    this.conn = await openDatabase();
  },
  GET: {
    '/status': function (this: any) {
      return { connected: !!this.conn };
    },
  },
});
```

### Keyed lifecycle

When `scope` returns a string, one instance is cached per key in an internal `Map`. On the first request for a new key, `buildModule(key)` is called and awaited inside the route handler. Concurrent requests for the same new key share the same in-flight `Promise` — only one instance is ever built per key.

```ts
// One instance per tenant, loaded from DB on first access
const api = apiBuilder({
  scope: (req) => (req as any).tenantId,
  data:  (key) => ({ tenantId: key, config: null }),
  setup: async function (this: any) {
    this.config = await loadTenantConfig(this.tenantId);
  },
  GET: {
    '/config': function (this: any) { return this.config; },
  },
});
```

### Ephemeral lifecycle

When `scope` returns `null`, a fresh instance is built for every request and never cached. Suitable for stateless services that use `setup` to perform per-request initialisation (e.g. opening a DB transaction).

```ts
const api = apiBuilder({
  scope: () => null,
  setup: async function (this: any) {
    this.tx = await db.beginTransaction();
  },
  methods: {
    async commit(this: any) { await this.tx.commit(); },
  },
  POST: {
    '/transfer': async function (this: any, _p: any, body: any) {
      await performTransfer(this.tx, body);
      await this.commit();
    },
  },
});
```

---

## Route specificity sorting

Within each HTTP method, routes are sorted by **decreasing specificity** before being registered on the router. This prevents a less-specific pattern from shadowing a more-specific one.

```
specificity(path) = (segment_count × 100) − (parameter_count × 10)
```

Higher score = registered first. Routes with more segments and fewer parameters win:

| Path | Segments | Params | Score | Order |
|---|---|---|---|---|
| `/items/export` | 2 | 0 | 200 | 1st |
| `/items/:id` | 2 | 1 | 190 | 2nd |
| `/items` | 1 | 0 | 100 | 3rd |

This ensures the static segment `/items/export` is checked before the parameterised `/items/:id`, which is checked before the list route `/items`.

---

## OpenAPI spec generation

`apiBuilder` returns an `ApiRouter` — a standard `Router` with two extra methods for generating an OpenAPI 3.1.0 document from the service definition:

| Method | Description |
|---|---|
| `api.spec(opts)` | Return the generated `OpenApiDocument` object. |
| `api.specHandler(opts)` | Return a request handler that serves the spec as JSON (cached after the first call). |

```ts
app.get('/openapi.json', itemsApi.specHandler({
  title:    'Items API',
  version:  '1.0.0',
  basePath: '/api',
}));
```

Route handlers can be annotated with the `describe()` function to attach summary, description, parameter, and response metadata to individual operations. See the [OpenAPI documentation](./openapi.md) for the full reference.

---

## Mounting

`apiBuilder` returns an `ApiRouter`. Always mount it with `app.use()` so that the path prefix is stripped inside the sub-router and its route patterns (e.g. `/items`) are evaluated relative to the mount point:

```ts
// Correct — prefix '/api' is stripped; service sees '/items', '/items/:id'
app.use('/api', apiBuilder(myService));

// Wrong — prefix is not stripped; service would need to register '/api/items'
app.get('/api', apiBuilder(myService));
```

Body-parsing middleware must be registered **before** the api router if your service methods use `body`:

```ts
app.use('/api', json(), apiBuilder(myService));
// or per-route:
app.use('/api/items', json(), itemsApi);
```

---

## Important notes

- **`methods` vs route handlers**: methods declared in `methods` are helpers — they are not directly exposed as HTTP endpoints. Only entries in `GET`, `POST`, `PUT`, `DELETE`, and `PATCH` become routes.
- **`this` binding in methods and handlers**: use regular `function` expressions (not arrow functions). Arrow functions do not have their own `this` and will not receive the instance correctly.
- **`data()` returns `Partial<TInstance>`**: you do not need to pre-declare the methods on the data object — they are mixed in automatically. Only declare the data properties your instance needs.
- **Body parsing is not built-in**: `req.body` is populated by a separate middleware (`json()`, `parseBody()`, etc.). Register it before the api router or `body` will be `undefined`.
- **Async errors in route handlers**: rejected Promises from route handlers are caught and translated to `sendError`. You do not need to add your own `.catch()` — `throw` or `return Promise.reject(apiError)` is sufficient.
- **No 405 Method Not Allowed by default**: if a path is registered for GET but a POST arrives, the router falls through to a 404. To return 405, register explicit handlers for the unsupported methods.

---

## Complete example

```ts
import { createRouter, json, apiBuilder } from 'expediate';
import type { ServiceDefinition } from 'expediate';

interface TodoItem { title: string; done: boolean; }
interface TodoService {
  items: Record<string, TodoItem>;
  nextId(): string;
}

const todoDefinition: ServiceDefinition<TodoService> = {
  // Singleton: one shared list for all requests
  data: () => ({ items: {} }),

  methods: {
    nextId(this: TodoService) {
      return String(Object.keys(this.items).length + 1);
    },
  },

  setup: async function (this: TodoService) {
    // Could seed from a database here
    this.items['1'] = { title: 'Buy milk', done: false };
  },

  GET: {
    '/todos': function (this: TodoService) {
      return Object.entries(this.items).map(([id, item]) => ({ id, ...item }));
    },
    '/todos/:id': function (this: TodoService, p) {
      const item = this.items[p.id];
      if (!item) throw { status: 404, message: 'Todo not found' };
      return { id: p.id, ...item };
    },
  },

  POST: {
    '/todos': function (this: TodoService, _p, body: any) {
      const id = this.nextId();
      this.items[id] = { title: body.title, done: false };
      // undefined return → 201 No Content
    },
  },

  PATCH: {
    '/todos/:id': function (this: TodoService, p, body: any) {
      const item = this.items[p.id];
      if (!item) throw { status: 404, message: 'Todo not found' };
      Object.assign(item, body);
      return { id: p.id, ...item };
    },
  },

  DELETE: {
    '/todos/:id': function (this: TodoService, p) {
      if (!this.items[p.id]) throw { status: 404, message: 'Todo not found' };
      delete this.items[p.id];
      // undefined return → 201 No Content
    },
  },
};

const app = createRouter();
app.use('/api', json(), apiBuilder(todoDefinition));
app.listen(3000);
```
