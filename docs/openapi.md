# OpenAPI Spec Generation

Expediate can generate an OpenAPI 3.1.0 document straight from your route definitions — no separate spec to hand-maintain. Annotate handlers with `describe()`, then call `openApiSpec()` (or `apiBuilder`'s `api.spec()` / `api.specHandler()`) to produce the document. Routes that aren't backed by a `ServiceDefinition` at all — e.g. JWT auth endpoints mounted directly with `app.post(...)` — can still be documented and merged into the same spec via a spec-only `ServiceOpenApi` source.

---

## Quick start

```ts
import { apiBuilder, describe } from 'expediate';
import type { ServiceDefinition, ApiContext } from 'expediate';

const service: ServiceDefinition<State> = {
  GET: {
    '/items/:id': describe(
      function (this: State, ctx: ApiContext) { return this.findOrThrow(ctx.params.id); },
      {
        summary: 'Get an item by ID',
        tags:    ['items'],
        responses: {
          '200': { description: 'The item' },
          '404': { description: 'Not found' },
        },
      },
    ),
  },
};

const api = apiBuilder(service);
app.use('/api', api);
app.get('/openapi.json', api.specHandler({ title: 'Items API', version: '1.0.0' }));
app.get('/openapi.yaml', api.specHandler({ title: 'Items API', version: '1.0.0' }, 'yaml'));
```

---

## `describe(handler, meta)`

Annotates a service method handler with OpenAPI operation metadata. The returned function behaves identically to `handler` — it can be used directly in a `ServiceDefinition` route map. Metadata is attached via a non-enumerable property keyed by the `DESCRIBE_META` symbol, so it never pollutes `Object.keys()` or `JSON.stringify()` output.

```ts
GET: {
  '/todos/:id': describe(
    function (this: State, ctx) { return this.findOrThrow(ctx.params.id); },
    {
      summary:    'Get a todo by ID',
      tags:       ['todos'],
      permission: 'todo.read',          // → auth.check + security in the spec
      responses: {
        '200': { description: 'The todo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Todo' } } } },
        '404': { description: 'Not found' },
      },
    },
  ),
}
```

`OperationMeta` fields:

| Field | Type | Description |
|---|---|---|
| `summary` | `string` | Short summary shown in UI tooling |
| `description` | `string` | Longer description (Markdown supported) |
| `operationId` | `string` | Overrides the auto-generated id (e.g. `getTodosById`) |
| `tags` | `string[]` | UI grouping; falls back to controller `tags`, then the source's default tag |
| `parameters` | `ParameterObject[]` | Merged with auto-detected path params by `name`; query/header/cookie params must be listed here — never auto-inferred |
| `requestBody` | `RequestBodyObject` | Provide when the operation consumes a body |
| `responses` | `Record<string, ResponseObject>` | Replaces the default response set entirely; a `'500'` reference to the built-in `ApiError` component is injected unless you supply your own `'500'` key |
| `deprecated` | `boolean` | Marks the operation deprecated |
| `guards` | `Guard[]` | Request-pipeline guards (ignored by spec generation) |
| `permission` | `string \| string[]` | Overrides the controller-level `permission`; emits `security` + the permissions vendor extension |
| `x-*` | `unknown` | Any other vendor extension is passed straight through |

Unspecified fields are inferred: path parameters auto-detected from the route pattern, default responses assigned by HTTP verb (`POST` → `201`, others → `200`), and `operationId` generated from the verb + path.

---

## `openApiSpec(service, opts)`

The free function underlying `api.spec()` — use it when you have a definition but not (or not only) a router built by `apiBuilder`.

```ts
import { openApiSpec } from 'expediate';

const doc = openApiSpec(todoService, {
  title:    'Todo API',
  version:  '1.0.0',
  basePath: '/api',
});
```

Controllers merge into the same document as the root route map — see [API Builder](api-builder.md) for `controllers`, `guards`, and `auth`. The generated document always includes an `ApiError` schema (`{ status?, message?, data? }`) in `components.schemas` and a matching `500` reference in `components.responses`.

### `SpecOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | **required** | API title |
| `version` | `string` | **required** | API version |
| `description` | `string` | — | API description |
| `basePath` | `string` | — | Prefix prepended to every path |
| `servers` | `{ url, description? }[]` | — | OpenAPI server objects |
| `schemas` | `Record<string, JsonSchema>` | — | Extra component schemas (superseded by a source's own `schemas` on name conflicts) |

### `api.spec(opts)` and `api.specHandler(opts, format?)`

The router returned by `apiBuilder` can introspect its own definition — controllers included:

```ts
const api = apiBuilder(service);

app.use('/api', api);
app.get('/openapi.json', api.specHandler({ title: 'Todo API', version: '1.0.0' }));
app.get('/openapi.yaml', api.specHandler({ title: 'Todo API', version: '1.0.0' }, 'yaml'));

// Or get the document object directly:
const doc = api.spec({ title: 'Todo API', version: '1.0.0', basePath: '/api' });
```

`specHandler` generates the spec once and caches it on the returned handler's first call. Both methods document the single `ServiceDefinition` passed to `apiBuilder` — for merging in routes from elsewhere, use `openApiSpec()` directly with multiple sources (below).

---

## Multiple sources

`openApiSpec()` accepts a single source **or an array of sources**, merged into one document. This is how routes with no `ServiceDefinition` at all — most notably the JWT plugin's `/auth/login`, `/auth/refresh`, `/auth/logout`, typically mounted directly with `app.post(...)` — get documented alongside a real API:

```ts
import { openApiSpec } from 'expediate';
import type { ServiceOpenApi } from 'expediate';

const authDocs: ServiceOpenApi = {
  openapi: { tag: 'auth' },
  POST: {
    '/auth/login':   { summary: 'Log in',          requestBody: loginBody },
    '/auth/refresh': { summary: 'Refresh a token',  requestBody: refreshBody },
    '/auth/logout':  { summary: 'Log out' },
  },
};

const spec = openApiSpec([authDocs, todoService], { title: 'Todo API', version: '1.0.0' });
```

`ServiceOpenApi` is a spec-only counterpart to `ServiceDefinition`: same shape (`controllers`, root route maps, `schemas`, `auth`, service-level `openapi` metadata) but route map values are `OperationMeta` objects directly instead of handler functions, since there's no handler to call. `guards` and `validate` are accepted for structural parity only — spec generation ignores both, as there's no request pipeline to run them against. `ControllerOpenApi` and `RouteOpenApi` are the equivalent spec-only counterparts to `ControllerDefinition` and a handler route map.

`OpenApiSource = ServiceDefinition<any> | ServiceOpenApi` is the type accepted by `openApiSpec()`, so a real service and a `ServiceOpenApi` mix in the same array with no casts needed.

### Merge rules

- **Routes** — every source's root route map and `controllers` are flattened into one globally-sorted route table (same specificity scoring as `apiBuilder`'s `collectRoutes`). A duplicate `(verb, path)` pair throws, even when the two routes come from different sources.
- **Tags and `x-required-permissions`** — each route resolves its default tag (`openapi.tag`) and permissions vendor-extension name (`auth.permissionsExtension`) from **its own** originating source, not a single global value.
- **`components.securitySchemes.bearerAuth`** — taken from the first source in array order that declares a custom `auth.scheme`; falls back to the default HTTP bearer/JWT scheme if none do.
- **`components.schemas` / `components.responses`** — merged source by source in array order, so a later source's `schemas` wins on a name conflict. For a single source this reproduces the original precedence exactly: built-ins ← `openapi.schemas` ← `opts.schemas` ← the source's own `schemas`.

Passing a single source (not wrapped in an array) behaves identically to the pre-multi-source API — `openApiSpec(service, opts)` and `openApiSpec([service], opts)` produce the same document.

This merge logic (`collectOpenApiRoutes`) is entirely separate from `apiBuilder`'s request-handling pipeline — it only inspects route shapes to build documentation and never invokes a handler, so adding spec-only sources cannot affect runtime routing.

---

## Security output

Routes carrying a `permission` (route- or controller-level) automatically receive `security: [{ bearerAuth: [] }]` and an `x-required-permissions: [...]` vendor extension (name overridable via `auth.permissionsExtension`). `components.securitySchemes.bearerAuth` is emitted once, only when at least one operation declares a permission, defaulting to:

```json
{ "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
```

---

## `serializeSpec(doc, format?)`

Serialize an `OpenApiDocument` to a JSON or YAML string (both zero-dependency):

```ts
import { serializeSpec } from 'expediate';

const json = serializeSpec(doc);          // JSON (default), 2-space indented
const yaml = serializeSpec(doc, 'yaml');  // block-style YAML 1.2
```
