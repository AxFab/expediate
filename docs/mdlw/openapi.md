# OpenAPI spec generation

Expediate can generate a fully-formed **OpenAPI 3.1.0** document from any `ServiceDefinition` created with `apiBuilder()`. No external code-generation tool is required — the document is built at runtime from the service's route maps, optional per-handler annotations, and an optional service-level metadata block.

## Quick start

```ts
import { createRouter, json, apiBuilder } from 'expediate';

const itemsApi = apiBuilder({
  GET: {
    '/items':     function () { return []; },
    '/items/:id': function (p) { return { id: p.id }; },
  },
});

const app = createRouter();
app.use('/api', json(), itemsApi);

// Serve the spec at GET /openapi.json
app.get('/openapi.json', itemsApi.specHandler({
  title:    'Items API',
  version:  '1.0.0',
  basePath: '/api',
}));

app.listen(3000);
```

`apiBuilder()` returns an `ApiRouter` — a standard `Router` with two extra methods:

| Method | Description |
|---|---|
| `.spec(opts)` | Generate and return the `OpenApiDocument` object. |
| `.specHandler(opts)` | Return a request handler that serves the spec as JSON. The spec is generated once and cached. |

---

## `SpecOptions`

Passed to `.spec()` or `.specHandler()` to control the top-level document.

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | ✓ | API title placed in `info.title`. |
| `version` | `string` | ✓ | Semver version string placed in `info.version`. |
| `description` | `string` | — | Optional Markdown description for `info.description`. |
| `basePath` | `string` | — | Prefix prepended to every route path (e.g. `'/api/v1'`). |
| `servers` | `Array<{ url, description? }>` | — | OpenAPI server list. Omit to produce a document with no `servers` block. |
| `schemas` | `Record<string, JsonSchema>` | — | Extra schemas merged into `components.schemas` at the highest precedence. |

---

## Automatic behaviour (no annotations needed)

When route handlers carry no annotations, the framework infers sensible defaults.

### Path conversion

Express-style `:param` segments are converted to `{param}` in the OpenAPI path. The optional `basePath` from `SpecOptions` is prepended:

```
/items/:id  +  basePath '/api'  →  /api/items/{id}
```

### `operationId` generation

An `operationId` is derived from the HTTP verb and path pattern:

| Route | `operationId` |
|---|---|
| `GET /items` | `getItems` |
| `GET /items/:id` | `getItemsById` |
| `POST /items` | `postItems` |
| `DELETE /users/:uid/posts/:pid` | `deleteUsersByUidPostsByPid` |

### Path parameter inference

Every `:param` segment in the path automatically produces a parameter entry in the operation:

```json
{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }
```

### Default responses

| HTTP verb | Default success response |
|---|---|
| `POST` | `201 Created` |
| All others | `200 OK` with `application/json` content |

Every operation always receives a `500` entry pointing to the built-in `ApiError` component (see [Built-in components](#built-in-components)).

---

## Annotating handlers with `describe()`

`describe()` wraps a handler with OpenAPI operation metadata. The returned function is otherwise identical to the original and can be used directly in a route map.

```ts
import { describe, apiBuilder } from 'expediate';

const todosApi = apiBuilder({
  GET: {
    '/todos': describe(
      function (this: TodoService) {
        return Object.values(this.items);
      },
      {
        summary: 'List all todos',
        tags:    ['todos'],
        responses: {
          '200': {
            description: 'An array of todo items',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Todo' },
                },
              },
            },
          },
        },
      },
    ),

    '/todos/:id': describe(
      function (this: TodoService, p) {
        const item = this.items[p.id];
        if (!item) throw { status: 404, message: 'Not found' };
        return item;
      },
      {
        summary:     'Get a todo by ID',
        operationId: 'getTodoById',
        parameters: [
          {
            name:     'id',
            in:       'path',
            required: true,
            description: 'The todo ID',
            schema:   { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'The todo item', content: { 'application/json': {} } },
          '404': { description: 'Not found' },
        },
      },
    ),
  },
});
```

### `OperationMeta` fields

| Field | Type | Description |
|---|---|---|
| `summary` | `string` | Short one-line description shown in UI tooling. |
| `description` | `string` | Longer Markdown description. |
| `operationId` | `string` | Override the auto-generated `operationId`. |
| `tags` | `string[]` | Tag groups for UI categorisation. |
| `parameters` | `ParameterObject[]` | Path, query, header, or cookie parameters. Path params listed here take precedence over auto-inferred ones (no duplicates). |
| `requestBody` | `RequestBodyObject` | Request body descriptor (use for POST/PUT/PATCH). |
| `responses` | `Record<string, ResponseObject>` | Explicit response map by status code. Replaces the default 200/201. A `500` entry is always injected unless you provide one explicitly. |
| `deprecated` | `boolean` | Mark the operation as deprecated. |
| `x-*` | `unknown` | Any vendor extension key is passed through to the generated operation object. |

### Parameter merging

When `parameters` are provided, path parameters already listed by name are **not** duplicated from auto-inference. Query, header, and cookie parameters are never auto-inferred — they must be declared explicitly.

---

## Service-level metadata (`openapi` field)

Attach an `openapi` block to your `ServiceDefinition` to contribute metadata to the document's top-level sections:

```ts
const todosApi = apiBuilder({
  openapi: {
    tag:            'todos',
    tagDescription: 'Operations on todo items',
    schemas: {
      Todo: {
        type: 'object',
        properties: {
          id:    { type: 'string' },
          title: { type: 'string' },
          done:  { type: 'boolean' },
        },
        required: ['id', 'title', 'done'],
      },
    },
    responses: {
      NotFound: { description: '404 Not Found' },
    },
  },
  GET: { /* … */ },
  POST: { /* … */ },
});
```

### `OpenApiServiceMeta` fields

| Field | Type | Description |
|---|---|---|
| `tag` | `string` | Default tag applied to every operation generated from this service. Added to the document's top-level `tags` array. |
| `tagDescription` | `string` | Description shown alongside the tag in UI tooling. |
| `schemas` | `Record<string, JsonSchema>` | Reusable schemas merged into `components.schemas`. `SpecOptions.schemas` takes precedence when the same key appears in both. |
| `responses` | `Record<string, ResponseObject>` | Reusable responses merged into `components.responses`. |

---

## Built-in components

The generated document always contains:

### `components.schemas.ApiError`

```json
{
  "type": "object",
  "properties": {
    "status":  { "type": "integer", "description": "HTTP status code" },
    "message": { "type": "string",  "description": "Human-readable error message" },
    "data":    { "description": "Structured error payload (overrides message when present)" }
  }
}
```

### `components.responses.ApiError`

```json
{
  "description": "API error response",
  "content": {
    "application/json": {
      "schema": { "$ref": "#/components/schemas/ApiError" }
    }
  }
}
```

Every operation's `responses` object contains a `500` entry:

```json
{ "$ref": "#/components/responses/ApiError" }
```

You can override this by providing an explicit `'500'` key in `OperationMeta.responses`.

---

## Serving the spec

### `api.specHandler(opts, format?)` — recommended

Returns an Express-compatible handler that generates the spec once, caches it as a serialised string, and serves it on every subsequent call. Mount it on any `GET` route:

```ts
// JSON (default)
app.get('/openapi.json', itemsApi.specHandler({
  title:    'Items API',
  version:  '1.0.0',
  basePath: '/api',
}));

// YAML
app.get('/openapi.yaml', itemsApi.specHandler({
  title:    'Items API',
  version:  '1.0.0',
  basePath: '/api',
}, 'yaml'));
```

The `format` argument controls both the serialisation and the `Content-Type` header:

| `format` | `Content-Type` |
|---|---|
| `'json'` (default) | `application/json; charset=utf-8` |
| `'yaml'` | `application/yaml; charset=utf-8` |

### `api.spec(opts)` — programmatic access

Returns the `OpenApiDocument` object directly. Useful when you need to merge multiple service specs, post-process the document, or embed it elsewhere:

```ts
const doc = itemsApi.spec({ title: 'Items API', version: '1.0.0', basePath: '/api' });
// Spread onto another document, cache yourself, etc.
```

### `openApiSpec(service, opts)` — standalone function

The same function used internally by `.spec()`. Accepts any `ServiceDefinition` directly:

```ts
import { openApiSpec } from 'expediate';

const doc = openApiSpec(myServiceDefinition, {
  title:   'My API',
  version: '1.0.0',
});
```

### `serializeSpec(doc, format?)` — standalone serialiser

Serialise any `OpenApiDocument` to a string without going through an `ApiRouter`:

```ts
import { openApiSpec, serializeSpec } from 'expediate';

const doc  = openApiSpec(myServiceDefinition, { title: 'My API', version: '1.0.0' });
const json = serializeSpec(doc);           // JSON (default)
const yaml = serializeSpec(doc, 'yaml');   // YAML
```

The YAML serialiser is built into expediate with no external dependencies. It produces block-style YAML 1.2: objects use block mappings, arrays use block sequences, and strings are quoted only when necessary (e.g. when they would be misinterpreted as numbers, booleans, or `null`, or when they contain YAML flow indicators like `{`, `}`, or start with `#`).

---

## Complete example

```ts
import { createRouter, json, apiBuilder, describe } from 'expediate';
import type { ServiceDefinition } from 'expediate';

interface TodoItem { title: string; done: boolean; }
interface TodoService { items: Record<string, TodoItem> }

const todoDefinition: ServiceDefinition<TodoService> = {
  openapi: {
    tag:     'todos',
    schemas: {
      Todo: {
        type: 'object',
        properties: {
          id:    { type: 'string' },
          title: { type: 'string' },
          done:  { type: 'boolean' },
        },
        required: ['id', 'title', 'done'],
      },
    },
  },

  data: () => ({ items: {} }),

  GET: {
    '/todos': describe(
      function (this: TodoService) {
        return Object.entries(this.items).map(([id, item]) => ({ id, ...item }));
      },
      {
        summary: 'List todos',
        responses: {
          '200': {
            description: 'Array of todos',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Todo' } } } },
          },
        },
      },
    ),
    '/todos/:id': describe(
      function (this: TodoService, p) {
        const item = this.items[p.id];
        if (!item) throw { status: 404, message: 'Not found' };
        return { id: p.id, ...item };
      },
      {
        summary: 'Get todo by ID',
        responses: {
          '200': { description: 'The todo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Todo' } } } },
          '404': { description: 'Not found' },
        },
      },
    ),
  },

  POST: {
    '/todos': describe(
      function (this: TodoService, _p, body: any) {
        const id = String(Object.keys(this.items).length + 1);
        this.items[id] = { title: body.title, done: false };
      },
      {
        summary:     'Create a todo',
        requestBody: {
          required: true,
          content:  { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } },
        },
      },
    ),
  },
};

const app     = createRouter();
const todoApi = apiBuilder(todoDefinition);

app.use('/api', json(), todoApi);

// OpenAPI spec endpoint
app.get('/openapi.json', todoApi.specHandler({
  title:    'Todo API',
  version:  '1.0.0',
  basePath: '/api',
  servers:  [{ url: 'http://localhost:3000', description: 'Local' }],
}));

app.listen(3000);
```

---

## Important notes

- **`describe()` wraps the function**: it returns a new function, not the original. The original handler is untouched. Use the return value of `describe()` in the route map.
- **Use regular functions, not arrow functions**: all service methods (including those passed to `describe()`) must be regular `function` expressions so that `this` is bound correctly to the service instance at call time.
- **Tags on annotated handlers**: if a handler supplies its own `tags`, the service-level `openapi.tag` default is **not** applied to that operation — the explicit tags are used as-is.
- **No runtime dependency on a JSON Schema validator**: the framework does not validate that your `JsonSchema` objects are well-formed. They are passed through to the generated document as-is.
- **`specHandler` caches per handler instance**: the cached JSON string is scoped to the specific handler closure returned by `api.specHandler(opts)`. If you call `api.specHandler(opts)` twice, each invocation has its own cache.
