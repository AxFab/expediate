# API Builder and OpenAPI

`apiBuilder` lets you define REST endpoints as a controller-style service object. It handles instance scoping, lifecycle, method binding, route specificity sorting, and error translation automatically. Since v2 it also supports **multi-file composition** (controllers), **guards**, a declarative **auth binding**, and **runtime request validation** from the JSON Schemas you already declare for the spec. The companion `describe()` helper annotates handlers with OpenAPI metadata so a full spec can be generated without duplication.

---

## `apiBuilder(service)`

```ts
import { createRouter, json, apiBuilder } from 'expediate';
import type { ServiceDefinition, ApiContext } from 'expediate';

interface State {
  items: Record<string, { title: string; done: boolean }>;
  nextId: number;
}

const todoService: ServiceDefinition<State> = {
  data: () => ({ items: {}, nextId: 1 }),

  methods: {
    findOrThrow(this: State, id: string) {
      const item = this.items[id];
      if (!item) throw { status: 404, message: 'Not found' };
      return item;
    },
  },

  GET: {
    '/todos':     function (this: State) {
      return Object.entries(this.items).map(([id, v]) => ({ id, ...v }));
    },
    '/todos/:id': function (this: State, ctx: ApiContext) {
      return this.findOrThrow(ctx.params.id);
    },
  },

  POST: {
    '/todos': function (this: State, _ctx: ApiContext, body: any) {
      const id = String(this.nextId++);
      this.items[id] = { title: body.title, done: false };
      return { id, ...this.items[id] };
    },
  },

  DELETE: {
    '/todos/:id': function (this: State, ctx: ApiContext) {
      this.findOrThrow(ctx.params.id);
      delete this.items[ctx.params.id];
    },  // no return → 201 No Content
  },
};

const app = createRouter();
app.use('/', json());
app.use('/api', apiBuilder(todoService));
app.listen(3000);
```

### Handler signature and `ApiContext`

Handlers are called with `this` bound to the service instance and receive `(ctx, body)`:

```ts
interface ApiContext<TUser = unknown, TState = Record<string, unknown>> {
  query: {
    route: Record<string, string>;            // named :params from the path
    url:   Record<string, string | string[]>; // ?query=string parameters
  };
  params: Record<string, string>;  // shorthand alias for query.route
  path:   string;                  // request path (after parent use() stripping)
  user?:  TUser;                   // set by an authenticate middleware
  state:  TState;                  // values produced by guards
}
```

`ctx.params` is the dominant access pattern; the namespaced `ctx.query.route` / `ctx.query.url` forms remain for collision cases. Type `user` and `state` explicitly when you need strict access:

```ts
import type { TokenPayload } from 'expediate';

'/me': (ctx: ApiContext<TokenPayload>) => ({ name: ctx.user?.sub }),
```

### Handler conventions

| Return value | HTTP response |
|---|---|
| Truthy value (`object`, `string`, `number`, `true`) | `200 OK` with JSON body |
| `undefined`, `null`, `false`, `0`, `''` | `201 No Content` |
| Throw `{ status, message }` | `<status>` with plain-text body |
| Throw `{ status, data }` | `<status>` with JSON body |
| Throw anything else | `500 Internal Server Error` |

### Route specificity sorting

All routes — root-level and controller-level together — are sorted **globally** before registration so that more-specific paths are registered first and cannot be shadowed:

```
score = (segment_count × 100) − (param_count × 10)
```

`/items/special` (score 200) is registered before `/items/:id` (score 190), so you do not need to care about declaration order, even across controllers.

### ServiceDefinition structure

```ts
interface ServiceDefinition<TInstance> {
  // Instance lifecycle (API-wide, shared by all controllers)
  scope?:   (req: RouterRequest) => string | null;
  data?:    (key: string | null) => Partial<TInstance>;
  setup?:   (this: TInstance) => void | Promise<void>;
  methods?: ServiceMethods<TInstance>;

  // v2 — composition, guards, auth, validation
  controllers?: ControllerDefinition<TInstance>[];
  guards?:      Guard[];
  auth?:        AuthBinding;
  validate?:    boolean | ApiBuilderOptions;
  schemas?:     Record<string, JsonSchema>;

  // Root route maps (form an implicit controller with no prefix)
  GET?:     RouteMap<TInstance>;
  POST?:    RouteMap<TInstance>;
  PUT?:     RouteMap<TInstance>;
  DELETE?:  RouteMap<TInstance>;
  PATCH?:   RouteMap<TInstance>;
}
```

---

## Scoping

Control how many instances of the service state are created:

| `scope` field value | Behaviour |
|---|---|
| Absent (no `scope`) | **Singleton** — one global instance for all requests |
| Returns a `string` | **Keyed** — one instance per key, cached indefinitely |
| Returns `null` | **Ephemeral** — fresh instance per request, discarded afterwards |

The key is stored at `this.$key` on the instance.

```ts
const service: ServiceDefinition<State> = {
  // Per-session scope
  scope: (req) => (req as any).session?.id ?? null,

  // Per-request (ephemeral)
  scope: () => null,

  data: () => ({ /* initial state */ }),
};
```

The instance lifecycle stays at the top level: **one lifecycle for the whole API, shared by all controllers**. Controllers organise routes; they do not isolate state.

---

## Async setup

`setup()` is called after `data()` and methods are bound. If it returns a `Promise`, it is awaited before the module is put into service. For singletons, requests arriving while setup is in progress receive **503 Service not ready**; for keyed/ephemeral instances, the handler awaits instance creation per request.

```ts
const service: ServiceDefinition<State> = {
  data: () => ({ db: null as any }),

  setup: async function (this: State) {
    this.db = await connectToDatabase();
  },

  GET: {
    '/items': function (this: State) {
      return this.db.query('SELECT * FROM items');
    },
  },
};
```

---

## Controllers and composition

Split a large API into per-domain files. Each file exports a `ControllerDefinition`; the composition root merges them into **one router** and **one OpenAPI document**.

```ts
interface ControllerDefinition<TInstance> {
  prefix?:     string;             // prepended to every route (may contain :params)
  tags?:       string[];           // default OpenAPI tags for untagged routes
  guards?:     Guard[];            // run before every handler of this controller
  permission?: string | string[];  // default permission (route meta overrides)

  GET?: RouteMap<TInstance>; POST?: ...; PUT?: ...; DELETE?: ...; PATCH?: ...;
}
```

`defineController()` is an identity helper providing type inference when declaring a controller in its own file:

```ts
// wiki.controller.ts
import { defineController, describe } from 'expediate';

export const wikiController = defineController({
  prefix: '/p/:proj/wiki',
  tags:   ['Wiki'],
  permission: 'wiki.read',

  GET: {
    '/tree': describe(
      (ctx) => wikiService.listPages(ctx.params.proj),
      { summary: 'List all wiki pages' }),

    '/pages/:slug': describe(
      (ctx) => wikiService.readPage(ctx.params.proj, ctx.params.slug),
      { summary: 'Read a wiki page' }),
  },

  PUT: {
    '/pages/:slug': describe(
      (ctx, body) => wikiService.writePage(ctx.params.proj, ctx.params.slug, body),
      { summary: 'Create or update a page', permission: 'wiki.write' }),
  },
});
```

```ts
// index.ts — composition root
const api = apiBuilder({
  controllers: [wikiController, issuesController, adminController],
});
```

### Merge rules

- Each controller route is rewritten to `joinPath(prefix, path)` (duplicate slashes normalised; a `'/'` route + prefix `/p/:proj/wiki` → `/p/:proj/wiki`).
- Root-level route maps form an implicit controller with no prefix, so v1 single-definition services keep working unchanged.
- Routes of all controllers are concatenated and specificity-sorted **globally**.
- A duplicate `(verb, joined path)` pair **throws at build time**, naming both declaring controllers:

  ```
  Error: apiBuilder: duplicate route GET /p/:proj/settings
    declared by controllers 'Settings' and 'Projects'
  ```

- Handlers in every controller run with `this` bound to the same service instance.

---

## Guards and `ctx.state`

A *guard* is a pre-handler hook living in the `ctx` world:

```ts
type Guard = (ctx: ApiContext, req: RouterRequest)
  => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
```

A guard may **throw / reject an `ApiError`** (translated to an HTTP error response), **return an object** (shallow-merged into `ctx.state`), or **return void** (pure check).

Guards attach at three levels and run outermost-first:

```
auth.authenticate → auth.check → api guards → controller guards → route guards → handler
```

Per-route guards ride on the `describe()` metadata:

```ts
import type { Guard } from 'expediate';

/** Require a project feature flag; expects ctx.state.proj loaded earlier. */
const featureEnabled = (flag: string): Guard => (ctx) => {
  const proj = ctx.state.proj as any;
  if (!proj?.[flag]) throw { status: 404, message: 'Feature is not enabled' };
};

/** Load a resource once and share it with later guards and the handler. */
const loadProject: Guard = async (ctx) => ({
  proj: await projectService.openProject(ctx.params.proj),
});

const api = apiBuilder({
  guards: [/* run for every route of the API */],
  controllers: [defineController({
    prefix: '/p/:proj/wiki',
    guards: [loadProject, featureEnabled('wikiEnabled')],
    GET: {
      '/pages/:slug': describe(
        (ctx) => wikiService.readPage(ctx.params.proj, ctx.params.slug),
        { summary: 'Read a wiki page', guards: [/* route-level guards */] }),
    },
  })],
});
```

---

## Auth binding

Connect an authentication layer (typically the JWT plugin) to the API Builder once, then declare permissions per route or per controller:

```ts
interface AuthBinding<TUser = unknown> {
  authenticate?: Middleware;   // registered on the internal router, runs first
  check?: (ctx: ApiContext<TUser>, required: string[]) => void | Promise<void>;
  scheme?: Record<string, unknown>;       // OpenAPI security scheme (default: bearer JWT)
  permissionsExtension?: string;          // default: 'x-required-permissions'
}
```

### Out-of-the-box JWT integration

```ts
import { createJwtPlugin, apiBuilder, describe } from 'expediate';

const jwt = createJwtPlugin({ accessTokenSecret: SECRET });

const api = apiBuilder({
  auth: { authenticate: jwt.authenticate },  // default check() reads ctx.user.permissions
  GET: {
    '/public':  () => ({ ok: true }),                                  // no permission → public
    '/private': describe(handler, { permission: 'write' }),            // 401 / 403 / pass
  },
});
```

The default `check` mirrors `jwtPlugin.requirePermission` semantics in the `ctx` world: `401` when `ctx.user` is absent, `403` when `ctx.user.permissions` is missing **any** required entry. Routes without a `permission` stay public — authorization is opt-in per route.

### Resource-scoped models

Override `check` **once** for per-resource permissions; it may load resources and share them through `ctx.state`:

```ts
auth: {
  authenticate: jwt.authenticate,
  check: async (ctx, required) => {
    const proj = await projectService.openProject(ctx.params.proj);
    for (const p of required)
      authService.requirePermission(ctx.user?.sub ?? null, proj, p);
    ctx.state.proj = proj;   // share the loaded project with guards/handler
  },
},
```

---

## Request validation

Execute the JSON Schemas you already declare in `describe()` metadata:

```ts
const api = apiBuilder({
  validate: true,                       // or { requests: true }
  schemas: {                            // shared by the validator AND the spec
    Item: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', pattern: '^[a-z0-9][a-z0-9.\\-]*$' },
        size: { type: 'integer', minimum: 1 },
      },
    },
  },
  POST: {
    '/items': describe(createItem, {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
      },
    }),
  },
});
```

When enabled, the body is checked against the route's `requestBody` schema before the guards run. Failures produce `400`:

```json
{ "message": "Request body validation failed",
  "fieldErrors": { "name": "does not match pattern ^[a-z0-9][a-z0-9.\\-]*$" } }
```

Supported keywords: `type`, `required`, `properties`, `items`, `enum`, `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`, `additionalProperties`, `allOf`/`anyOf`/`oneOf`, and `$ref` resolved against `ServiceDefinition.schemas`. Field-error paths are dotted (`name`, `address.city`, `tags.0`); errors on the body itself are keyed `'$'`.

---

## Builder options: `apiBuilder(service, options?)`

`apiBuilder` takes an optional second argument, `ApiBuilderOptions`, that controls validation. When you pass it, it is authoritative and overrides the `service.validate` field (which accepts the same `boolean | ApiBuilderOptions` shape):

```ts
apiBuilder(service);                                // follows service.validate
apiBuilder(service, {});                             // validate requests (default on), not responses
apiBuilder(service, { validateRequests: false });    // validate nothing
apiBuilder(service, { validateResponses: true });    // requests + responses (500 on mismatch)
apiBuilder(service, { validateResponses: 'warn' });  // requests + responses (log only, no 500)
```

`ApiBuilderOptions`:

| Field               | Type               | Default | Effect |
|---------------------|--------------------|---------|--------|
| `validateRequests`  | `boolean`          | `true`  | Check incoming bodies against `requestBody` schemas. `false` cancels it. Failure → `400`. |
| `validateResponses` | `boolean \| 'warn'`| `false` | Check each handler's return against the route's `responses['200']` schema. `true` → `500` on mismatch (off-spec body not sent); `'warn'` → log via `console.warn` and send anyway. |

Response validation is a **server-contract** check: a handler returning data that violates its own declared `200` schema means the *server* is at fault. With `true`, a mismatch yields `500 { message: 'Response body validation failed', fieldErrors }` instead of emitting an off-spec body; with `'warn'`, it logs server-side and sends the response unchanged (handy in development). Only truthy returns (sent as `200`) are checked — falsy returns (`201 No Content`) and routes with no declared `200` content schema are skipped. It uses the same validator and `fieldErrors` shape as request validation.

```ts
const api = apiBuilder(todoService, { validateResponses: true });
```

---

## Mounting

`apiBuilder` returns a `Router`. Mount it with `app.use()`:

```ts
app.use('/api/v1', apiBuilder(todoService));
```

For tests, mounting at `'/'` avoids path-stripping concerns:

```ts
app.use('/', apiBuilder(todoService));
```

Body-parsing middleware must be registered before the API router for `body` to be populated in handlers.

---

## OpenAPI spec generation

→ Full reference: [docs/openapi.md](openapi.md)

The router returned by `apiBuilder` can introspect its own definition — controllers included, producing **one** document:

```ts
import { describe } from 'expediate';

GET: {
  '/todos/:id': describe(
    function (this: State, ctx) { return this.findOrThrow(ctx.params.id); },
    { summary: 'Get a todo by ID', tags: ['todos'] },
  ),
}

const api = apiBuilder(service);
app.use('/api', api);
app.get('/openapi.json', api.specHandler({ title: 'Todo API', version: '1.0.0' }));
app.get('/openapi.yaml', api.specHandler({ title: 'Todo API', version: '1.0.0' }, 'yaml'));
```

`openApiSpec(service, opts)` is the underlying free function when you have the definition but not the router — it also accepts an array of sources to merge in routes that have no `ServiceDefinition` at all (e.g. JWT auth endpoints). See [docs/openapi.md](openapi.md) for `describe()`, security output, `serializeSpec()`, and multi-source merging.
