# API Builder and OpenAPI

`apiBuilder` lets you define REST endpoints as a controller-style service object. It handles instance scoping, lifecycle, method binding, route specificity sorting, and error translation automatically. The companion `describe()` helper annotates a service with OpenAPI metadata so a full spec can be generated without duplication.

---

## `apiBuilder(service)`

```ts
import { createRouter, json, apiBuilder } from 'expediate';
import type { ServiceDefinition } from 'expediate';

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
    '/todos/:id': function (this: State, params) {
      return this.findOrThrow(params.id);
    },
  },

  POST: {
    '/todos': function (this: State, _params, body: any) {
      const id = String(this.nextId++);
      this.items[id] = { title: body.title, done: false };
      return { id, ...this.items[id] };
    },
  },

  DELETE: {
    '/todos/:id': function (this: State, params) {
      this.findOrThrow(params.id);
      delete this.items[params.id];
    },  // no return → 201 No Content
  },
};

const app = createRouter();
app.use('/', json());
app.use('/api', apiBuilder(todoService));
app.listen(3000);
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

Routes within each HTTP method are automatically sorted before registration so that more-specific paths are registered first and cannot be shadowed:

```
score = (segment_count × 100) − (param_count × 10)
```

`/items` (score 100) is registered before `/items/:id` (score 90), so you do not need to care about declaration order within a method map.

### ServiceDefinition structure

```ts
interface ServiceDefinition<TInstance> {
  scope?:   (req: RouterRequest) => string | null;
  data?:    (key: string) => TInstance;
  setup?:   (this: TInstance) => void | Promise<void>;
  methods?: Record<string, (this: TInstance, ...args: any[]) => any>;
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

---

## Async setup

`setup()` is called after `data()` and methods are bound. If it returns a `Promise`, the module is not put into service until the promise resolves. Guard methods with a readiness check during startup:

```ts
const service: ServiceDefinition<State> = {
  data: () => ({ ready: false, db: null as any }),

  setup: async function (this: State) {
    this.db = await connectToDatabase();
    this.ready = true;
  },

  methods: {
    assertReady(this: State) {
      if (!this.ready)
        throw { status: 503, message: 'Service initialising — retry shortly' };
    },
  },

  GET: {
    '/items': function (this: State) {
      this.assertReady();
      return this.db.query('SELECT * FROM items');
    },
  },
};
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

### `describe(service)`

Wraps a service definition with OpenAPI operation metadata. The result is a valid `ServiceDefinition` that can be passed to both `apiBuilder` and `openApiSpec`:

```ts
import { describe, openApiSpec, apiBuilder } from 'expediate';

const todoService = describe({
  summary:     'Todo list API',
  description: 'Manage todos',

  GET: {
    '/todos': {
      summary:   'List all todos',
      responses: { 200: { description: 'Array of todo items' } },
      handler:   function (this: State) {
        return Object.values(this.items);
      },
    },
    '/todos/:id': {
      summary:    'Get a todo',
      parameters: [{ name: 'id', in: 'path', required: true }],
      responses:  { 200: { description: 'Todo item' }, 404: { description: 'Not found' } },
      handler:    function (this: State, params) {
        return this.findOrThrow(params.id);
      },
    },
  },

  POST: {
    '/todos': {
      summary:     'Create a todo',
      requestBody: { required: true, description: 'Todo to create' },
      responses:   { 200: { description: 'Created todo' } },
      handler:     function (this: State, _params, body: any) {
        const id = String(this.nextId++);
        this.items[id] = { title: body.title, done: false };
        return { id, ...this.items[id] };
      },
    },
  },
});

const app = createRouter();
app.use('/', json());
app.use('/api', apiBuilder(todoService));
app.get('/openapi.json', openApiSpec(todoService, { title: 'Todo API', version: '1.0.0' }));
app.get('/openapi.yaml', openApiSpec(todoService, {
  title:   'Todo API',
  version: '1.0.0',
  format:  'yaml',
}));
```

### `serializeSpec(doc, format?)`

Serialize an `OpenApiDocument` to a JSON or YAML string:

```ts
import { serializeSpec } from 'expediate';

const json = serializeSpec(doc);          // JSON (default)
const yaml = serializeSpec(doc, 'yaml');  // YAML
```

### SpecOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | **required** | API title |
| `version` | `string` | **required** | API version |
| `format` | `'json' \| 'yaml'` | `'json'` | Serialization format for the served spec |
| `description` | `string` | — | API description |
| `servers` | `ServerObject[]` | — | OpenAPI server objects |
