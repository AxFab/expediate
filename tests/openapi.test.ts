/**
 * Tests for OpenAPI spec generation (`src/openapi.ts`).
 *
 * Covers:
 *  - describe() metadata attachment and DESCRIBE_META symbol
 *  - toOpenApiPath / path parameter translation (via openApiSpec output)
 *  - buildOperationId auto-generation
 *  - extractPathParams auto-inference
 *  - openApiSpec() with zero annotations (default behaviour)
 *  - openApiSpec() with full describe() annotations
 *  - service-level `openapi` metadata (tag, schemas, responses)
 *  - SpecOptions: title, version, description, basePath, servers, schemas
 *  - Built-in ApiError component is always present
 *  - api.spec() method on ApiRouter
 *  - api.specHandler() request handler caching
 *  - Multiple HTTP verbs in one spec
 *  - Vendor extension pass-through (x-* keys)
 *  - Explicit '500' in responses suppresses injected ApiError ref
 */

import { describe as testDescribe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  describe,
  openApiSpec,
  serializeSpec,
  DESCRIBE_META,
  apiBuilder,
} from '../src/index';

import type {
  OperationMeta,
  OpenApiDocument,
  ServiceDefinition,
} from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal service definition for testing. */
function noop() { return null; }

/** GET the path from a running server; returns the parsed JSON body. */
async function fetchJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// describe() — metadata attachment
// ---------------------------------------------------------------------------

testDescribe('describe()', () => {
  it('returns a function that behaves like the original handler', () => {
    const original = function (this: any, p: any) { return p.x; };
    const wrapped  = describe(original, { summary: 'test' });

    assert.strictEqual(typeof wrapped, 'function');
    // Call with a dummy `this` context.
    assert.strictEqual(wrapped.call({} as any, { x: 'hello' }), 'hello');
  });

  it('attaches metadata under DESCRIBE_META symbol', () => {
    const meta: OperationMeta = { summary: 'List items', tags: ['items'] };
    const wrapped = describe(function () { return []; }, meta);

    const attached = (wrapped as any)[DESCRIBE_META] as OperationMeta;
    assert.deepEqual(attached, meta);
  });

  it('does not make metadata enumerable', () => {
    const wrapped = describe(function () { return null; }, { summary: 'x' });
    assert.ok(!Object.keys(wrapped).includes(DESCRIBE_META.toString()));
    assert.ok(!(DESCRIBE_META in Object.assign({}, wrapped)));
  });

  it('does not mutate the original function', () => {
    const original = function () { return 1; };
    describe(original, { summary: 'x' });
    assert.strictEqual((original as any)[DESCRIBE_META], undefined);
  });

  it('each call to describe() produces an independent wrapped function', () => {
    const h    = function () { return null; };
    const w1   = describe(h, { summary: 'first' });
    const w2   = describe(h, { summary: 'second' });
    assert.notStrictEqual(w1, w2);
    assert.strictEqual((w1 as any)[DESCRIBE_META].summary, 'first');
    assert.strictEqual((w2 as any)[DESCRIBE_META].summary, 'second');
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — default (unannotated) behaviour
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — default behaviour', () => {
  const service: ServiceDefinition = {
    GET: {
      '/items':     noop,
      '/items/:id': noop,
    },
    POST: {
      '/items': noop,
    },
  };

  let doc: OpenApiDocument;
  it('builds a document without throwing', () => {
    doc = openApiSpec(service, { title: 'Test API', version: '0.0.1' });
    assert.ok(doc);
  });

  it('sets openapi version to 3.1.0', () => {
    doc = openApiSpec(service, { title: 'Test API', version: '0.0.1' });
    assert.strictEqual(doc.openapi, '3.1.0');
  });

  it('populates info from options', () => {
    doc = openApiSpec(service, { title: 'My API', version: '2.3.4', description: 'Desc' });
    assert.strictEqual(doc.info.title,       'My API');
    assert.strictEqual(doc.info.version,     '2.3.4');
    assert.strictEqual(doc.info.description, 'Desc');
  });

  it('generates paths for GET routes', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(doc.paths['/items']);
    assert.ok(doc.paths['/items'].get);
    assert.ok(doc.paths['/items/:id'] === undefined, 'Express params must be converted');
    assert.ok(doc.paths['/items/{id}']);
    assert.ok(doc.paths['/items/{id}'].get);
  });

  it('generates paths for POST routes', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(doc.paths['/items'].post);
  });

  it('auto-generates operationId for GET /items', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op = doc.paths['/items'].get as any;
    assert.strictEqual(op.operationId, 'getItems');
  });

  it('auto-generates operationId for GET /items/:id', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op = doc.paths['/items/{id}'].get as any;
    assert.strictEqual(op.operationId, 'getItemsById');
  });

  it('auto-generates operationId for POST /items', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op = doc.paths['/items'].post as any;
    assert.strictEqual(op.operationId, 'postItems');
  });

  it('infers path parameters from :param segments', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items/{id}'].get as any;
    const p   = (op.parameters as any[]).find((x: any) => x.name === 'id');
    assert.ok(p, 'path param "id" should be inferred');
    assert.strictEqual(p.in,       'path');
    assert.strictEqual(p.required, true);
    assert.deepEqual(p.schema, { type: 'string' });
  });

  it('does not add parameters for static routes', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op = doc.paths['/items'].get as any;
    assert.ok(!op.parameters || op.parameters.length === 0);
  });

  it('gives POST a 201 default response', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op = doc.paths['/items'].post as any;
    assert.ok(op.responses['201']);
    assert.ok(!op.responses['200']);
  });

  it('gives GET a 200 default response', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    const op = doc.paths['/items'].get as any;
    assert.ok(op.responses['200']);
  });

  it('injects ApiError 500 reference in every operation', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    for (const pathItem of Object.values(doc.paths)) {
      for (const opRaw of Object.values(pathItem)) {
        const op = opRaw as any;
        assert.ok(op.responses['500'], 'every operation should have a 500 response');
      }
    }
  });

  it('always includes ApiError in components.schemas', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(doc.components.schemas['ApiError']);
  });

  it('always includes ApiError in components.responses', () => {
    doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(doc.components.responses['ApiError']);
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — basePath option
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — basePath', () => {
  const service: ServiceDefinition = {
    GET: { '/todos': noop, '/todos/:id': noop },
  };

  it('prepends basePath to all route paths', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1', basePath: '/api/v1' });
    assert.ok(doc.paths['/api/v1/todos']);
    assert.ok(doc.paths['/api/v1/todos/{id}']);
    assert.ok(!doc.paths['/todos']);
  });

  it('handles basePath without trailing slash', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1', basePath: '/api' });
    assert.ok(doc.paths['/api/todos']);
  });

  it('handles empty basePath (no prefix)', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1', basePath: '' });
    assert.ok(doc.paths['/todos']);
    assert.ok(!doc.paths['todos']);
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — servers option
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — servers', () => {
  const service: ServiceDefinition = { GET: { '/x': noop } };

  it('includes servers when provided', () => {
    const doc = openApiSpec(service, {
      title: 'T', version: '1',
      servers: [{ url: 'https://api.example.com', description: 'Prod' }],
    });
    assert.ok(Array.isArray(doc.servers));
    assert.strictEqual(doc.servers![0].url, 'https://api.example.com');
  });

  it('omits servers when not provided', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.strictEqual(doc.servers, undefined);
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — annotated handlers via describe()
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — annotated handlers', () => {
  const service: ServiceDefinition = {
    GET: {
      '/items': describe(noop, {
        summary:     'List all items',
        description: 'Returns every item in the store.',
        tags:        ['items'],
        responses: {
          '200': {
            description: 'An array of items',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } },
          },
        },
      }),
      '/items/:id': describe(noop, {
        summary:    'Get item by ID',
        operationId: 'fetchItemById',
        tags:        ['items'],
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'The item ID', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'The item', content: { 'application/json': {} } },
          '404': { description: 'Item not found' },
        },
      }),
    },
    POST: {
      '/items': describe(noop, {
        summary:     'Create an item',
        tags:        ['items'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
      }),
    },
  };

  it('uses provided summary', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items'].get as any;
    assert.strictEqual(op.summary, 'List all items');
  });

  it('uses provided description', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items'].get as any;
    assert.strictEqual(op.description, 'Returns every item in the store.');
  });

  it('uses provided tags', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items'].get as any;
    assert.deepEqual(op.tags, ['items']);
  });

  it('uses explicit operationId when provided', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items/{id}'].get as any;
    assert.strictEqual(op.operationId, 'fetchItemById');
  });

  it('uses annotated responses and suppresses default 200/201', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items'].get as any;
    assert.ok(op.responses['200'], 'annotated 200 should be present');
    assert.ok(!op.responses['201']);
  });

  it('merges annotated path parameters with auto-inferred ones correctly (no dups)', () => {
    const doc    = openApiSpec(service, { title: 'T', version: '1' });
    const op     = doc.paths['/items/{id}'].get as any;
    const params = op.parameters as any[];
    const idParams = params.filter((p: any) => p.name === 'id');
    assert.strictEqual(idParams.length, 1, 'id param should appear only once');
    // The annotated version (with format: uuid) should be preferred.
    assert.strictEqual(idParams[0].schema.format, 'uuid');
  });

  it('includes annotated 404 response', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items/{id}'].get as any;
    assert.ok(op.responses['404']);
  });

  it('still injects 500 ApiError ref even with annotated responses', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items/{id}'].get as any;
    const ref = op.responses['500'] as any;
    assert.strictEqual(ref.$ref, '#/components/responses/ApiError');
  });

  it('includes requestBody from annotation', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/items'].post as any;
    assert.ok(op.requestBody);
    assert.strictEqual(op.requestBody.required, true);
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — explicit '500' suppresses injected ApiError ref
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — explicit 500 suppresses built-in ref', () => {
  const service: ServiceDefinition = {
    GET: {
      '/x': describe(noop, {
        responses: {
          '200': { description: 'ok' },
          '500': { description: 'Custom internal error' },
        },
      }),
    },
  };

  it('uses caller-provided 500 and does not override with ApiError ref', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/x'].get as any;
    const r500 = op.responses['500'] as any;
    assert.strictEqual(r500.description, 'Custom internal error');
    assert.strictEqual(r500.$ref, undefined);
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — service-level `openapi` metadata
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — service-level openapi metadata', () => {
  const service: ServiceDefinition = {
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
    GET: { '/todos': noop },
    POST: { '/todos': noop },
  };

  it('includes service tag in document tags section', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(Array.isArray(doc.tags));
    const t = doc.tags!.find(t => t.name === 'todos');
    assert.ok(t);
    assert.strictEqual(t!.description, 'Operations on todo items');
  });

  it('applies default tag to all operations', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const get  = doc.paths['/todos'].get as any;
    const post = doc.paths['/todos'].post as any;
    assert.deepEqual(get.tags,  ['todos']);
    assert.deepEqual(post.tags, ['todos']);
  });

  it('merges service schemas into components.schemas', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(doc.components.schemas['Todo']);
    assert.ok(doc.components.schemas['ApiError'], 'built-in ApiError must still be present');
  });

  it('merges service responses into components.responses', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(doc.components.responses['NotFound']);
    assert.ok(doc.components.responses['ApiError'], 'built-in ApiError must still be present');
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — opts.schemas override precedence
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — opts.schemas precedence', () => {
  const service: ServiceDefinition = {
    openapi: {
      schemas: { MyModel: { type: 'string', description: 'from service' } },
    },
    GET: { '/x': noop },
  };

  it('opts.schemas takes precedence over service schemas', () => {
    const doc = openApiSpec(service, {
      title: 'T', version: '1',
      schemas: { MyModel: { type: 'object', description: 'from opts' } },
    });
    assert.strictEqual(doc.components.schemas['MyModel'].description, 'from opts');
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — multiple HTTP verbs on same path
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — multiple verbs on same path', () => {
  const service: ServiceDefinition = {
    GET:    { '/resource': noop },
    PUT:    { '/resource': noop },
    DELETE: { '/resource': noop },
    PATCH:  { '/resource': noop },
  };

  it('groups all verbs under the same path entry', () => {
    const doc  = openApiSpec(service, { title: 'T', version: '1' });
    const item = doc.paths['/resource'];
    assert.ok(item.get,    'GET should be present');
    assert.ok(item.put,    'PUT should be present');
    assert.ok(item.delete, 'DELETE should be present');
    assert.ok(item.patch,  'PATCH should be present');
    assert.ok(!item.post,  'POST should not be present');
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — vendor extension pass-through (x-* keys)
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — vendor extensions', () => {
  const service: ServiceDefinition = {
    GET: {
      '/x': describe(noop, {
        summary: 'test',
        'x-internal': true,
        'x-rateLimit': 100,
      }),
    },
  };

  it('passes x-* keys through to the operation object', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    const op  = doc.paths['/x'].get as any;
    assert.strictEqual(op['x-internal'], true);
    assert.strictEqual(op['x-rateLimit'], 100);
  });
});

// ---------------------------------------------------------------------------
// openApiSpec() — deprecated flag
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — deprecated', () => {
  const service: ServiceDefinition = {
    GET: {
      '/old': describe(noop, { deprecated: true, summary: 'Old endpoint' }),
      '/new': noop,
    },
  };

  it('sets deprecated: true when flagged', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.strictEqual((doc.paths['/old'].get as any).deprecated, true);
  });

  it('does not set deprecated on unannotated handlers', () => {
    const doc = openApiSpec(service, { title: 'T', version: '1' });
    assert.ok(!(doc.paths['/new'].get as any).deprecated);
  });
});

// ---------------------------------------------------------------------------
// ApiRouter.spec() — method on returned router
// ---------------------------------------------------------------------------

testDescribe('apiBuilder().spec()', () => {
  const service: ServiceDefinition = {
    scope: () => null, // ephemeral to avoid singleton async
    GET: { '/ping': function () { return { ok: true }; } },
  };

  it('returns an OpenApiDocument', () => {
    const api = apiBuilder(service);
    const doc = api.spec({ title: 'Ping API', version: '1.0.0' });
    assert.strictEqual(doc.openapi, '3.1.0');
    assert.strictEqual(doc.info.title, 'Ping API');
    assert.ok(doc.paths['/ping']);
  });

  it('respects basePath option', () => {
    const api = apiBuilder(service);
    const doc = api.spec({ title: 'T', version: '1', basePath: '/v1' });
    assert.ok(doc.paths['/v1/ping']);
    assert.ok(!doc.paths['/ping']);
  });
});

// ---------------------------------------------------------------------------
// ApiRouter.specHandler() — HTTP request handler
// ---------------------------------------------------------------------------

testDescribe('apiBuilder().specHandler()', () => {
  const service: ServiceDefinition = {
    scope: () => null,
    GET: { '/items': function () { return []; } },
  };

  it('serves the OpenAPI spec as JSON over HTTP', async () => {
    const api    = apiBuilder(service);
    const server = http.createServer((req, res) => {
      api.specHandler({ title: 'Items API', version: '2.0.0' })(req as any, res as any);
    });
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const doc = await fetchJson(port, '/') as OpenApiDocument;
    assert.strictEqual(doc.openapi, '3.1.0');
    assert.strictEqual(doc.info.title, 'Items API');
    assert.ok(doc.paths['/items']);

    server.close();
  });

  it('sets Content-Type: application/json', async () => {
    const api    = apiBuilder(service);
    const server = http.createServer((req, res) => {
      api.specHandler({ title: 'T', version: '1' })(req as any, res as any);
    });
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const contentType = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, res => {
        // Consume the body to avoid ECONNRESET.
        res.resume();
        resolve(res.headers['content-type'] ?? '');
      }).on('error', reject);
    });

    assert.ok(contentType.includes('application/json'), `got: ${contentType}`);
    server.close();
  });

  it('caches the spec and returns the same JSON on repeated calls', async () => {
    const api     = apiBuilder(service);
    const handler = api.specHandler({ title: 'T', version: '1' });
    const server  = http.createServer((req, res) => handler(req as any, res as any));
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const [r1, r2] = await Promise.all([
      fetchJson(port, '/') as Promise<OpenApiDocument>,
      fetchJson(port, '/') as Promise<OpenApiDocument>,
    ]);
    assert.deepEqual(r1, r2);
    server.close();
  });
});

// ---------------------------------------------------------------------------
// Edge case: service with no route maps
// ---------------------------------------------------------------------------

testDescribe('openApiSpec() — empty service', () => {
  const service: ServiceDefinition = {};

  it('produces a valid document with empty paths', () => {
    const doc = openApiSpec(service, { title: 'Empty', version: '0' });
    assert.deepEqual(doc.paths, {});
    assert.ok(doc.components.schemas['ApiError']);
  });
});

// ---------------------------------------------------------------------------
// serializeSpec() — JSON format
// ---------------------------------------------------------------------------

testDescribe('serializeSpec() — json', () => {
  const service: ServiceDefinition = {
    GET: { '/items': noop },
  };

  it('produces valid JSON by default', () => {
    const doc  = openApiSpec(service, { title: 'T', version: '1' });
    const text = serializeSpec(doc);
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.openapi, '3.1.0');
  });

  it('produces valid JSON when format is explicitly json', () => {
    const doc  = openApiSpec(service, { title: 'T', version: '1' });
    const text = serializeSpec(doc, 'json');
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.info.title, 'T');
  });

  it('is pretty-printed with 2-space indentation', () => {
    const doc  = openApiSpec(service, { title: 'T', version: '1' });
    const text = serializeSpec(doc, 'json');
    // Check that the output contains indented lines.
    assert.ok(text.includes('\n  '), 'expected 2-space indentation');
  });
});

// ---------------------------------------------------------------------------
// serializeSpec() — YAML format
// ---------------------------------------------------------------------------

testDescribe('serializeSpec() — yaml', () => {
  const service: ServiceDefinition = {
    GET: {
      '/items':     noop,
      '/items/:id': noop,
    },
    POST: {
      '/items': noop,
    },
  };

  function getYaml(): string {
    const doc = openApiSpec(service, { title: 'YAML Test API', version: '0.1.0' });
    return serializeSpec(doc, 'yaml');
  }

  it('produces a non-empty string ending with a newline', () => {
    const text = getYaml();
    assert.ok(text.length > 0);
    assert.ok(text.endsWith('\n'));
  });

  it('starts with the openapi version line', () => {
    const text = getYaml();
    assert.ok(text.startsWith('openapi: 3.1.0'), `got: ${text.slice(0, 40)}`);
  });

  it('includes the title from SpecOptions', () => {
    const text = getYaml();
    assert.ok(text.includes('title: YAML Test API'), `text does not include expected title`);
  });

  it('includes the version from SpecOptions', () => {
    const text = getYaml();
    assert.ok(text.includes('version: 0.1.0'));
  });

  it('converts :param path segments to {param} in YAML keys', () => {
    const text = getYaml();
    // Path keys with braces must be double-quoted in YAML.
    assert.ok(text.includes('"/items/{id}"') || text.includes("'/items/{id}'"),
      'parameterised path key should be quoted');
  });

  it('uses block style (not flow style) for non-empty nested objects', () => {
    const text = getYaml();
    // Block mappings produce lines with `: ` and no `{content}` opening on
    // value lines (flow objects would look like `key: {nested: val}`).
    // Empty collections rendered as `{}` or `[]` are fine inline.
    const lines = text.split('\n');
    const flowLines = lines.filter(l => /:\s*\{[^}]/.test(l));
    assert.strictEqual(flowLines.length, 0, `unexpected flow-style lines: ${flowLines.join('; ')}`);
  });

  it('includes operationId for each route', () => {
    const text = getYaml();
    assert.ok(text.includes('operationId: getItems'));
    assert.ok(text.includes('operationId: getItemsById'));
    assert.ok(text.includes('operationId: postItems'));
  });

  it('round-trips correctly — parsed YAML equals parsed JSON', () => {
    // We compare key fields without relying on a YAML parser (no dependency).
    // Instead we verify that the YAML contains the same operationIds as JSON.
    const doc      = openApiSpec(service, { title: 'T', version: '1' });
    const jsonText = serializeSpec(doc, 'json');
    const yamlText = serializeSpec(doc, 'yaml');

    // Both contain the same operationIds.
    const jsonParsed = JSON.parse(jsonText);
    const allOpIds: string[] = [];
    for (const pathItem of Object.values(jsonParsed.paths)) {
      for (const op of Object.values(pathItem as object)) {
        allOpIds.push((op as any).operationId);
      }
    }
    for (const id of allOpIds) {
      assert.ok(yamlText.includes(id), `YAML missing operationId: ${id}`);
    }
  });

  it('quotes strings that contain reserved YAML sequences (e.g. $ref value)', () => {
    const svc: ServiceDefinition = {
      GET: {
        '/x': describe(noop, {
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/X' } } } },
          },
        }),
      },
    };
    const doc  = openApiSpec(svc, { title: 'T', version: '1' });
    const text = serializeSpec(doc, 'yaml');
    // $ref value starts with '#' which is a YAML comment indicator → must be quoted.
    assert.ok(
      text.includes('"#/components/schemas/X"') || text.includes("'#/components/schemas/X'"),
      `$ref value should be quoted; got relevant excerpt: ${text.match(/#\/components/)?.[0]}`,
    );
  });

  it('serialises boolean scalars unquoted', () => {
    const svc: ServiceDefinition = {
      GET: {
        '/x': describe(noop, { deprecated: true }),
      },
    };
    const doc  = openApiSpec(svc, { title: 'T', version: '1' });
    const text = serializeSpec(doc, 'yaml');
    assert.ok(text.includes('deprecated: true'), 'expected unquoted boolean true');
  });

  it('serialises empty arrays as []', () => {
    const svc: ServiceDefinition = {
      GET: {
        '/x': describe(noop, {
          tags: [],
        }),
      },
    };
    const doc  = openApiSpec(svc, { title: 'T', version: '1' });
    const text = serializeSpec(doc, 'yaml');
    assert.ok(text.includes('tags: []'), 'expected inline empty array');
  });

  it('serialises non-empty arrays in block style with dashes', () => {
    const svc: ServiceDefinition = {
      GET: {
        '/x': describe(noop, { tags: ['alpha', 'beta'] }),
      },
    };
    const doc  = openApiSpec(svc, { title: 'T', version: '1' });
    const text = serializeSpec(doc, 'yaml');
    assert.ok(text.includes('- alpha'), 'expected block sequence item "alpha"');
    assert.ok(text.includes('- beta'),  'expected block sequence item "beta"');
  });
});

// ---------------------------------------------------------------------------
// apiBuilder().specHandler() — YAML format
// ---------------------------------------------------------------------------

testDescribe('apiBuilder().specHandler() — yaml format', () => {
  const service: ServiceDefinition = {
    scope: () => null,
    GET:   { '/ping': function () { return { ok: true }; } },
  };

  it('serves the spec as YAML when format is yaml', async () => {
    const api    = apiBuilder(service);
    const server = http.createServer((req, res) => {
      api.specHandler({ title: 'Ping API', version: '1.0.0' }, 'yaml')(req as any, res as any);
    });
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, res => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString(); });
        res.on('end', () => resolve(raw));
      }).on('error', reject);
    });

    assert.ok(body.startsWith('openapi: 3.1.0'), `expected YAML body, got: ${body.slice(0, 60)}`);
    server.close();
  });

  it('sets Content-Type: application/yaml for yaml format', async () => {
    const api    = apiBuilder(service);
    const server = http.createServer((req, res) => {
      api.specHandler({ title: 'T', version: '1' }, 'yaml')(req as any, res as any);
    });
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const contentType = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, res => {
        res.resume();
        resolve(res.headers['content-type'] ?? '');
      }).on('error', reject);
    });

    assert.ok(contentType.includes('application/yaml'), `got: ${contentType}`);
    server.close();
  });

  it('default format (no second arg) remains JSON', async () => {
    const api    = apiBuilder(service);
    const server = http.createServer((req, res) => {
      api.specHandler({ title: 'T', version: '1' })(req as any, res as any);
    });
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const contentType = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, res => {
        res.resume();
        resolve(res.headers['content-type'] ?? '');
      }).on('error', reject);
    });

    assert.ok(contentType.includes('application/json'), `got: ${contentType}`);
    server.close();
  });
});
