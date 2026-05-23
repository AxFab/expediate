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

import type { ServiceMethod, ServiceInstance, ServiceDefinition } from './apis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object (subset of draft-07 / OpenAPI 3.1 Schema Object).
 *
 * Only the properties most commonly used to describe API request/response
 * bodies are listed; the index signature allows any additional keyword.
 */
export interface JsonSchema {
  type?:                 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  format?:               string;
  description?:          string;
  example?:              unknown;
  enum?:                 unknown[];
  properties?:           Record<string, JsonSchema>;
  required?:             string[];
  items?:                JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  allOf?:                JsonSchema[];
  anyOf?:                JsonSchema[];
  oneOf?:                JsonSchema[];
  $ref?:                 string;
  [key: string]:         unknown;
}

/**
 * An OpenAPI 3.1 Parameter Object describing a single parameter (path, query,
 * header, or cookie).
 */
export interface ParameterObject {
  name:        string;
  in:          'path' | 'query' | 'header' | 'cookie';
  required?:   boolean;
  description?: string;
  schema?:     JsonSchema;
  example?:    unknown;
  [key: string]: unknown;
}

/**
 * An OpenAPI 3.1 Request Body Object.
 */
export interface RequestBodyObject {
  description?: string;
  required?:    boolean;
  content:      Record<string, { schema?: JsonSchema; example?: unknown }>;
}

/**
 * An OpenAPI 3.1 Response Object (value in the `responses` map).
 */
export interface ResponseObject {
  description: string;
  content?:    Record<string, { schema?: JsonSchema; example?: unknown }>;
  headers?:    Record<string, { description?: string; schema?: JsonSchema }>;
}

/**
 * Per-operation metadata that can be attached to a service method handler
 * via {@link describe}.
 *
 * All fields are optional — any subset can be provided. Unspecified fields are
 * inferred from the route definition (path params auto-detected, default
 * responses assigned by HTTP verb).
 */
export interface OperationMeta {
  /** Short summary of what the operation does (shown in UI tooling). */
  summary?: string;
  /** Longer description (Markdown supported). */
  description?: string;
  /** Override the auto-generated `operationId`. */
  operationId?: string;
  /** Tag group names (used for UI grouping). */
  tags?: string[];
  /**
   * Parameter overrides / additions.
   *
   * Parameters provided here are merged with the auto-detected path
   * parameters by `name`. Query, header, and cookie parameters must be
   * provided here — they are never auto-inferred.
   */
  parameters?: ParameterObject[];
  /** Request body descriptor. Provide when the method consumes a body. */
  requestBody?: RequestBodyObject;
  /**
   * Response descriptors keyed by HTTP status code string.
   *
   * When provided, these replace the default response set entirely. The
   * framework always injects a `'500'` reference to the built-in `ApiError`
   * component unless you explicitly supply a `'500'` key here.
   */
  responses?: Record<string, ResponseObject>;
  /** Mark as deprecated in the generated spec. */
  deprecated?: boolean;
  /** Additional vendor extensions (keys should start with `x-`). */
  [key: string]: unknown;
}

/**
 * Service-level OpenAPI metadata declared in the `openapi` field of a
 * {@link ServiceDefinition}.
 *
 * These fields contribute to the top-level `info`, `tags`, `servers`, and
 * `components` sections of the generated document, as well as a default tag
 * that is applied to every operation produced from the service definition.
 */
export interface OpenApiServiceMeta {
  /** Default tag applied to all operations from this service. */
  tag?: string;
  /** Description shown alongside the tag in UI tooling. */
  tagDescription?: string;
  /**
   * Reusable JSON Schema definitions merged into `components.schemas`.
   * Use `{ $ref: '#/components/schemas/MyModel' }` in operation metadata to
   * reference them.
   */
  schemas?: Record<string, JsonSchema>;
  /**
   * Reusable response definitions merged into `components.responses`.
   * Use `{ $ref: '#/components/responses/NotFound' }` in `responses` to
   * reference them.
   */
  responses?: Record<string, ResponseObject>;
}

/**
 * Top-level options passed to {@link openApiSpec}.
 *
 * Controls the `info` block and optionally overrides default servers or
 * merges additional components into the generated document.
 */
export interface SpecOptions {
  /** API title (required by the OpenAPI spec). */
  title:        string;
  /** Semver version string (e.g. `'1.0.0'`). */
  version:      string;
  /** Optional API description (Markdown supported). */
  description?: string;
  /**
   * Base path prefix prepended to every route when converting service
   * patterns to OpenAPI paths (e.g. `'/api/v1'`).
   */
  basePath?:    string;
  /** Server list (defaults to `[{ url: '/' }]` when absent). */
  servers?:     Array<{ url: string; description?: string }>;
  /**
   * Additional schemas merged into `components.schemas` (takes precedence
   * over service-level `openapi.schemas` of the same name).
   */
  schemas?:     Record<string, JsonSchema>;
}

/**
 * A minimal OpenAPI 3.1.0 document as produced by {@link openApiSpec}.
 *
 * Only the sections generated by the framework are typed here; extra sections
 * (e.g. `security`, `externalDocs`) can be added by spreading the result.
 */
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title:        string;
    version:      string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?:    Array<{ name: string; description?: string }>;
  paths:    Record<string, Record<string, unknown>>;
  components: {
    schemas:   Record<string, JsonSchema>;
    responses: Record<string, ResponseObject>;
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * The output format for a serialised OpenAPI document.
 *
 * - `'json'` — compact, widely supported, default.
 * - `'yaml'` — human-readable block YAML 1.2 (no external dependencies).
 */
export type SpecFormat = 'json' | 'yaml';

// ── YAML serialiser (zero-dependency, block-style) ────────────────────────────

/**
 * YAML reserved keywords that must be quoted as scalars so that YAML parsers
 * do not interpret them as the corresponding typed values.
 */
const YAML_KW: Set<string> = new Set([
  'true', 'false', 'yes', 'no', 'on', 'off', 'null', '~',
]);

/**
 * Pattern for "safe" plain scalars: they can be represented without quoting.
 * A scalar is safe when it:
 * - contains only letters, digits, `_`, `-`, `.` or `/`
 * - starts with a letter, `_`, `/`, or `$`
 * - is not a YAML reserved keyword
 * - does not look like a number
 */
const SAFE_SCALAR = /^[a-zA-Z$_/][a-zA-Z0-9$_\-./]*$/;

/** Pattern matching integer and floating-point number strings. */
const LOOKS_LIKE_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$/;

/**
 * Serialise a string as a YAML scalar value or key.
 *
 * The string is returned unquoted when it is a valid YAML plain scalar —
 * i.e. it cannot be misinterpreted as another type and does not contain
 * characters that would confuse a YAML parser.
 *
 * Otherwise the value is wrapped in double quotes with control characters,
 * backslashes, and `"` escaped so the output is always valid YAML 1.2.
 *
 * @param s - The string to serialise.
 */
function yamlString(s: string): string {
  if (s === '') return '""';

  const needsQuote =
    // Would be misinterpreted as a YAML typed value.
    YAML_KW.has(s.toLowerCase()) ||
    LOOKS_LIKE_NUMBER.test(s) ||
    // Starts with a YAML indicator that has special meaning at the start of a
    // plain scalar (block context).
    /^[-?:,[\]{}#&*!|>'"%@`~]/.test(s) ||
    // Inline sequences that break block-mapping parsing.
    s.includes(': ') ||
    s.endsWith(':') ||
    s.includes(' #') ||
    // Leading / trailing whitespace.
    s !== s.trim() ||
    // Flow indicator characters anywhere — present in path patterns such as
    // `/items/{id}` and must be quoted to avoid flow-collection ambiguity.
    /[{}\[\]]/.test(s) ||
    // Control characters.
    /[\x00-\x1f\x7f]/.test(s);

  if (!needsQuote) return s;

  // Double-quoted style: always valid, handles all edge cases.
  return '"' +
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c =>
        `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    + '"';
}

/**
 * Serialise a mapping key as a YAML scalar.
 *
 * Uses the same quoting rules as {@link yamlString}.  Numbers as keys
 * (e.g. HTTP status codes `200`, `500`) are always quoted so that YAML
 * parsers do not interpret them as integer keys.
 */
function yamlKey(key: string): string {
  return yamlString(key);
}

/**
 * Recursively serialise a JSON-compatible value into an array of YAML block
 * notation lines.
 *
 * Each returned line has **no leading indentation** — it is the caller's
 * responsibility to prefix nested lines with `'  '` (two spaces) when
 * embedding them inside a mapping value or sequence item.
 *
 * @param value - The value to serialise.
 */
function toYamlLines(value: unknown): string[] {
  // ── Scalars ─────────────────────────────────────────────────────────────────
  if (value === null || value === undefined) return ['null'];
  if (typeof value === 'boolean')            return [String(value)];
  if (typeof value === 'number')             return [isFinite(value) ? String(value) : '.inf'];
  if (typeof value === 'string')             return [yamlString(value)];

  // ── Sequences ────────────────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]'];
    const lines: string[] = [];
    for (const item of value) {
      const itemLines = toYamlLines(item);
      // First line of the item goes on the same line as the dash.
      lines.push(`- ${itemLines[0]}`);
      // Subsequent lines are indented by two spaces (relative to the `-`).
      for (const l of itemLines.slice(1)) lines.push(`  ${l}`);
    }
    return lines;
  }

  // ── Mappings ─────────────────────────────────────────────────────────────────
  if (typeof value === 'object') {
    const obj     = value as Record<string, unknown>;
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return ['{}'];

    const lines: string[] = [];
    for (const [key, val] of entries) {
      const k        = yamlKey(key);
      const valLines = toYamlLines(val);

      // Inline only when the value is a scalar, null, or an empty collection
      // (`{}` / `[]`).  Non-empty objects and arrays — even when they happen
      // to serialise to a single line (e.g. `$ref: "#/..."`) — must go block
      // style; inlining them produces ambiguous YAML like `key: $ref: "..."`.
      const isComplex = typeof val === 'object' && val !== null;
      const isEmptyCollection = valLines.length === 1 &&
        (valLines[0] === '{}' || valLines[0] === '[]');

      if (!isComplex || isEmptyCollection) {
        // Scalar or empty collection: fits on the same line as the key.
        lines.push(`${k}: ${valLines[0]}`);
      } else {
        // Block style: key on its own line, value indented below.
        lines.push(`${k}:`);
        for (const l of valLines) lines.push(`  ${l}`);
      }
    }
    return lines;
  }

  return [String(value)];
}

/**
 * Serialise an {@link OpenApiDocument} to either JSON or YAML.
 *
 * - `'json'` — pretty-printed with 2-space indentation.
 * - `'yaml'` — block-style YAML 1.2, produced by a zero-dependency serialiser
 *   built into expediate.
 *
 * @param doc    - The document to serialise.
 * @param format - Output format (`'json'` by default).
 */
export function serializeSpec(doc: OpenApiDocument, format: SpecFormat = 'json'): string {
  if (format === 'yaml') return toYamlLines(doc).join('\n') + '\n';
  return JSON.stringify(doc, null, 2);
}

// ---------------------------------------------------------------------------
// Symbol for attaching metadata to handler functions
// ---------------------------------------------------------------------------

/**
 * Unique symbol used as a non-enumerable property key on handler functions
 * that have been annotated via {@link describe}.
 *
 * Using a `unique symbol` (rather than a plain string key) prevents accidental
 * collisions with user-defined properties on handler objects.
 */
export const DESCRIBE_META: unique symbol = Symbol('expediate.openapi.meta');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Annotate a service method handler with OpenAPI operation metadata.
 *
 * The metadata is attached to the returned function via a non-enumerable
 * property keyed by {@link DESCRIBE_META}.  The returned function is otherwise
 * identical to `handler` — it can be used directly in a `ServiceDefinition`
 * route map.
 *
 * ```ts
 * GET: {
 *   '/items/:id': describe(
 *     function (this: TodoService, p) {
 *       return this.findOrFail(p.id);
 *     },
 *     {
 *       summary: 'Get a single item by ID',
 *       tags: ['items'],
 *       parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
 *       responses: {
 *         '200': { description: 'The item', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
 *         '404': { description: 'Not found' },
 *       },
 *     },
 *   ),
 * }
 * ```
 *
 * @param handler - The service method to annotate.
 * @param meta    - OpenAPI operation metadata.
 * @returns The same handler function, with metadata attached.
 */
export function describe<TInstance extends ServiceInstance = ServiceInstance>(
  handler: ServiceMethod<TInstance>,
  meta:    OperationMeta,
): ServiceMethod<TInstance> {
  // Wrap the handler so we have a fresh function object to attach metadata to,
  // avoiding unexpected mutations of functions shared across route maps.
  const described: ServiceMethod<TInstance> = function (
    this:   TInstance,
    params: Record<string, string>,
    body?:  unknown,
  ): unknown {
    return handler.apply(this, [params, body]);
  };

  // Attach metadata as a non-enumerable property so it is invisible to
  // Object.keys() / JSON.stringify() and does not pollute the function's
  // "own" enumerable surface.
  Object.defineProperty(described, DESCRIBE_META, {
    value:        meta,
    enumerable:   false,
    configurable: true,
    writable:     false,
  });

  return described;
}

// ---------------------------------------------------------------------------
// Internal path-translation helpers
// ---------------------------------------------------------------------------

/**
 * Convert an Express-style path pattern to an OpenAPI path pattern.
 *
 * - `:param` segments become `{param}`.
 * - An optional `basePath` prefix is prepended (with duplicate-slash guards).
 *
 * @example
 * ```ts
 * toOpenApiPath('/items/:id', '/api/v1') // → '/api/v1/items/{id}'
 * toOpenApiPath('/items',     '')         // → '/items'
 * ```
 */
function toOpenApiPath(pattern: string, basePath: string): string {
  const converted = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
  if (!basePath) return converted;
  const base = basePath.replace(/\/+$/, '');
  const path = converted.replace(/^\/+/, '/');
  return base + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Extract named path parameters from an Express-style pattern as
 * {@link ParameterObject} entries with `in: 'path'` and `required: true`.
 *
 * Parameters already listed in `annotated` (by name) are skipped to avoid
 * duplicates when the caller has provided explicit metadata for them.
 *
 * @param pattern   - Express-style route pattern (e.g. `/items/:id`).
 * @param annotated - Explicit parameters provided by the caller (may be empty).
 */
function extractPathParams(
  pattern:   string,
  annotated: ParameterObject[],
): ParameterObject[] {
  const annotatedNames = new Set(annotated.map(p => p.name));
  const params: ParameterObject[] = [];

  for (const match of pattern.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1];
    if (!annotatedNames.has(name)) {
      params.push({
        name,
        in:       'path',
        required: true,
        schema:   { type: 'string' },
      });
    }
  }

  return params;
}

/**
 * Build an `operationId` string from an HTTP verb and a path pattern.
 *
 * The algorithm:
 * 1. Lowercase the verb (e.g. `'GET'` → `'get'`).
 * 2. Split the pattern on `/` and `:` (and `{` / `}` for pre-translated paths).
 * 3. CamelCase each non-empty segment (first-letter uppercase).
 * 4. Prefix each path-param segment with `'By'`.
 * 5. Join everything into a single camelCase string.
 *
 * @example
 * ```ts
 * buildOperationId('GET',    '/items')     // → 'getItems'
 * buildOperationId('GET',    '/items/:id') // → 'getItemsById'
 * buildOperationId('DELETE', '/a/:b/:c')   // → 'deleteAByBByC'
 * ```
 */
function buildOperationId(verb: string, pattern: string): string {
  const parts  = pattern.split(/[/:{} ]+/).filter(Boolean);
  let   result = verb.toLowerCase();

  for (const part of parts) {
    const isParam = pattern.includes(`:${part}`) || pattern.includes(`{${part}}`);
    const pascal  = part.charAt(0).toUpperCase() + part.slice(1);
    result += isParam ? `By${pascal}` : pascal;
  }

  return result;
}

/**
 * Build the default responses for an operation when none are provided by the
 * caller.
 *
 * - `POST` → `201 No Content` (successful write with no response body).
 * - All other verbs → `200 OK` with a generic JSON response.
 * - `500` → always added as a reference to the built-in `ApiError` component.
 */
function buildDefaultResponses(verb: string): Record<string, ResponseObject | { $ref: string }> {
  const ok: ResponseObject = verb === 'POST'
    ? { description: 'Created' }
    : { description: 'OK', content: { 'application/json': {} } };

  return {
    [verb === 'POST' ? '201' : '200']: ok,
    '500': { $ref: '#/components/responses/ApiError' },
  };
}

/**
 * Convert caller-provided `responses` metadata into the OpenAPI responses
 * map, injecting the built-in `ApiError` reference for `500` unless the
 * caller has explicitly provided one.
 */
function buildAnnotatedResponses(
  responses: Record<string, ResponseObject>,
): Record<string, ResponseObject | { $ref: string }> {
  const result: Record<string, ResponseObject | { $ref: string }> = { ...responses };
  if (!result['500']) {
    result['500'] = { $ref: '#/components/responses/ApiError' };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core spec generator
// ---------------------------------------------------------------------------

/** The five HTTP verbs supported by `apiBuilder`. */
const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type Verb = typeof VERBS[number];

/**
 * Generate an OpenAPI 3.1.0 document from a {@link ServiceDefinition}.
 *
 * Route handlers that have been annotated with {@link describe} contribute
 * rich operation metadata (summary, description, parameters, requestBody,
 * responses).  Unannotated handlers receive sensible defaults automatically.
 *
 * The generated document always includes:
 * - An `ApiError` schema (shape: `{ status?, message?, data? }`) in
 *   `components.schemas`.
 * - An `ApiError` response (`500` reference) in `components.responses`.
 *
 * Caller-supplied `opts.schemas` and service-level `openapi.schemas` are
 * deep-merged on top of the built-in components (caller schemas take
 * precedence over service schemas, which take precedence over built-ins).
 *
 * @param service - The service definition to document.
 * @param opts    - Top-level spec options (title, version, basePath, …).
 * @returns A fully-formed OpenAPI 3.1.0 document object.
 *
 * @example
 * ```ts
 * const spec = openApiSpec(todoDefinition, {
 *   title:    'Todo API',
 *   version:  '1.0.0',
 *   basePath: '/api',
 * });
 *
 * app.get('/openapi.json', (_req, res) => {
 *   res.json(spec);
 * });
 * ```
 */
export function openApiSpec<TInstance extends ServiceInstance = ServiceInstance>(
  service: ServiceDefinition<TInstance>,
  opts:    SpecOptions,
): OpenApiDocument {
  const basePath    = opts.basePath ?? '';
  const svcMeta     = (service as any).openapi as OpenApiServiceMeta | undefined;
  const defaultTag  = svcMeta?.tag;

  // ── Components ──────────────────────────────────────────────────────────────
  const builtinSchemas: Record<string, JsonSchema> = {
    ApiError: {
      type: 'object',
      properties: {
        status:  { type: 'integer', description: 'HTTP status code' },
        message: { type: 'string',  description: 'Human-readable error message' },
        data:    { description: 'Structured error payload (overrides message when present)' },
      },
    },
  };

  const builtinResponses: Record<string, ResponseObject> = {
    ApiError: {
      description: 'API error response',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
      },
    },
  };

  // Merge schemas: built-ins ← service-level ← caller-level (last wins).
  const schemas: Record<string, JsonSchema> = {
    ...builtinSchemas,
    ...svcMeta?.schemas,
    ...opts.schemas,
  };

  const responses: Record<string, ResponseObject> = {
    ...builtinResponses,
    ...svcMeta?.responses,
  };

  // ── Tags ─────────────────────────────────────────────────────────────────────
  const tags: Array<{ name: string; description?: string }> = [];
  if (defaultTag) {
    tags.push({ name: defaultTag, description: svcMeta?.tagDescription });
  }

  // ── Paths ────────────────────────────────────────────────────────────────────
  const paths: Record<string, Record<string, unknown>> = {};

  for (const verb of VERBS) {
    const routeMap = service[verb];
    if (!routeMap) continue;

    for (const [pattern, handler] of Object.entries(routeMap)) {
      const openApiPath = toOpenApiPath(pattern, basePath);
      if (!paths[openApiPath]) paths[openApiPath] = {};

      // Retrieve attached metadata (if any).
      const meta: OperationMeta | undefined =
        (handler as any)[DESCRIBE_META] as OperationMeta | undefined;

      // ── Parameters ─────────────────────────────────────────────────────────
      const annotatedParams: ParameterObject[] = meta?.parameters ?? [];
      const inferredParams  = extractPathParams(pattern, annotatedParams);
      const parameters      = [...annotatedParams, ...inferredParams];

      // ── Responses ──────────────────────────────────────────────────────────
      const operationResponses = meta?.responses
        ? buildAnnotatedResponses(meta.responses)
        : buildDefaultResponses(verb);

      // ── Operation object ───────────────────────────────────────────────────
      const operation: Record<string, unknown> = {
        operationId: meta?.operationId ?? buildOperationId(verb, pattern),
        ...(meta?.summary     && { summary:     meta.summary }),
        ...(meta?.description && { description: meta.description }),
        ...(meta?.deprecated  && { deprecated:  true }),
        ...(parameters.length > 0 && { parameters }),
        ...(meta?.requestBody && { requestBody: meta.requestBody }),
        responses: operationResponses,
      };

      // Apply default tag when the operation has no explicit tags.
      const opTags = meta?.tags ?? (defaultTag ? [defaultTag] : undefined);
      if (opTags) operation['tags'] = opTags;

      // Carry through any vendor extensions (x-* keys).
      if (meta) {
        for (const [k, v] of Object.entries(meta)) {
          if (k.startsWith('x-')) operation[k] = v;
        }
      }

      paths[openApiPath][verb.toLowerCase()] = operation;
    }
  }

  // ── Assemble document ────────────────────────────────────────────────────────
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title:   opts.title,
      version: opts.version,
      ...(opts.description && { description: opts.description }),
    },
    ...(opts.servers && { servers: opts.servers }),
    ...(tags.length > 0 && { tags }),
    paths,
    components: { schemas, responses },
  };

  return doc;
}

// ---------------------------------------------------------------------------
// Module augmentation — add `openapi?` to ServiceDefinition
// ---------------------------------------------------------------------------

declare module './apis.js' {
  interface ServiceDefinition<TInstance extends ServiceInstance> {
    /**
     * Service-level OpenAPI metadata.
     *
     * When provided, contributes a default tag (applied to all operations),
     * reusable schema definitions, and reusable response definitions to the
     * generated spec document.
     *
     * @see {@link OpenApiServiceMeta}
     */
    openapi?: OpenApiServiceMeta;
  }
}
