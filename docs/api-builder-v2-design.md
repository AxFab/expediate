# API Builder v2 — Composition, Guards, and Auth Binding

**Status:** Draft / design discussion
**Date:** 2026-06-10
**Scope:** `src/apis.ts`, `src/openapi.ts`, touch points with `src/jwt-auth.ts`
**Compatibility:** breaking changes allowed (target: v2.0)

---

## 1. Context

A real consumer of `apiBuilder` (the DevLab project) was reviewed as a field
study. Its single `api-service.ts` is **3,480 lines** and contains:

- **~92 routes** in one `ServiceDefinition` across `GET` / `POST` / `PUT` / `DELETE`
- **13 injected services** passed as positional factory arguments
- ~70 routes sharing the `/p/:proj` prefix
- hand-rolled authorization helpers (`requireAdmin`, `requirePerm`) called
  manually at the top of nearly every handler
- manual body validation duplicating the JSON Schemas already declared in
  `describe()` metadata
- the `scope` / `data` / `methods` service-instance model entirely unused —
  every dependency is a closure capture

None of this is bad client code. It is the *only* shape the current API
allows: `ServiceDefinition` is the sole unit of grouping, and it owns the
whole API. When the API grows, the file grows with it. The framework offers
no seam along which to cut.

## 2. Pain points (evidence)

### PP1 — No composition unit

`apiBuilder(service)` accepts exactly one definition. There is no supported
way to define the Wiki routes in `wiki.controller.ts` and the Issues routes
in `issues.controller.ts` and merge them into one router with one OpenAPI
document. Mounting several `apiBuilder()` routers under `app.use()` *almost*
works, but each router produces its own spec, owns its own 503 guard and
instance cache, and route specificity sorting is no longer global.

### PP2 — Prefix repetition

`'/p/:proj/...'` is typed ~70 times. Any rename of the URL scheme is a
70-site edit.

### PP3 — Repeated cross-cutting preamble

The same four lines open almost every handler. The Wiki group repeats this
block six times, Snippets four times, Issues/MRs use a variant ~15 times:

```ts
'/p/:proj/wiki/pages/:slug': describe(async function (ctx: ApiContext): Promise<WikiPage> {
  const projectName = ctx.query.route.proj;
  await requirePerm(ctx, projectName, 'wiki.read')
  const proj = await projectService.openProject(projectName);
  if (!proj.wikiEnabled) throw HttpErr.NotFound('Wiki is not enabled for this project');
  return wikiService.readPage(projectName, ctx.query.route.slug);
}, { ... }),
```

Authorization, resource loading, and feature-flag checks are cross-cutting
concerns, but the API Builder gives handlers no "before" hook — the only
middleware seam is the raw router level, *outside* the `ctx` world.

### PP4 — Permissions are disconnected from the JWT plugin

`createJwtPlugin` ships `requireRole` / `requirePermission` middleware, but
they are unusable inside `apiBuilder` handlers: they live in the
`(req, res, next)` world while service methods live in the `(ctx, body)`
world. The client reimplements the entire authorization layer
(`requireAdmin`, `requirePerm`, `authService`) and types `ctx.user` as
`any`, with `(ctx.user as any).ipAddress` casts scattered around.

### PP5 — Declared schemas are write-only

Every route carries a `requestBody` JSON Schema for the OpenAPI spec — and
then validates the body *again* by hand (`applySettingsBody` is 150 lines of
manual field checks; milestone creation re-implements `pattern` and
`required`). The framework already holds machine-readable validation rules
and never executes them.

### PP6 — Context verbosity

`ctx.query.route.proj` is the most-typed expression in the file. The
namespacing is correct (route vs URL params must not collide) but the common
case deserves a shorthand.

## 3. Goals and non-goals

**Goals**

1. Let a client split one API into per-domain files that merge into a single
   router and a single OpenAPI document, with global route sorting and
   build-time conflict detection.
2. Provide a declarative authorization seam inside the `ctx` world, bridged
   to `jwt-auth` out of the box and overridable for resource-scoped checks.
3. Execute the JSON Schemas the client already writes.
4. Keep zero runtime dependencies and the data-first, no-decorator style.

**Non-goals**

- A dependency-injection container. Closure capture works well; the missing
  piece is file-level splitting, not DI.
- TypeScript decorators (`@Get('/path')`). They impose compiler options on
  consumers and break the "plain objects" philosophy of the framework.
- App-specific conveniences (pagination parsing, dry-run protocol, audit-log
  hooks). These belong in client helper functions; the framework only needs
  to make such helpers easy to apply (guards, see P2).

---

## 4. P1 — Controllers and composition

### New types

```ts
/** A group of routes sharing a path prefix, tags, and guards. */
export interface ControllerDefinition<TInstance extends ServiceInstance = ServiceInstance> {
  /** Path prefix prepended to every route in this controller (may contain params). */
  prefix?: string;
  /** Default OpenAPI tags applied to routes that do not declare their own. */
  tags?: string[];
  /** Guards run before every handler of this controller (see P2). */
  guards?: Guard[];
  /** Default permission requirement for every route (see P3). Route-level meta overrides. */
  permission?: string | string[];

  GET?:    RouteMap<TInstance>;
  POST?:   RouteMap<TInstance>;
  PUT?:    RouteMap<TInstance>;
  DELETE?: RouteMap<TInstance>;
  PATCH?:  RouteMap<TInstance>;
}

/** Identity helper for type inference and discoverability. */
export function defineController<TInstance extends ServiceInstance = ServiceInstance>(
  c: ControllerDefinition<TInstance>,
): ControllerDefinition<TInstance> { return c; }
```

### Extended `ServiceDefinition`

```ts
export interface ServiceDefinition<TInstance extends ServiceInstance = ServiceInstance> {
  scope?:   (req: RouterRequest) => string | null;
  data?:    (key: string | null) => Partial<TInstance>;
  setup?:   (this: TInstance) => void | Promise<void>;
  methods?: ServiceMethods<TInstance>;

  /** NEW — sub-controllers merged into this API. */
  controllers?: ControllerDefinition<TInstance>[];
  /** NEW — guards run before every handler of the whole API (see P2). */
  guards?: Guard[];
  /** NEW — authentication/authorization binding (see P3). */
  auth?: AuthBinding;
  /** NEW — runtime validation of declared request schemas (see P4). */
  validate?: boolean | ValidateOptions;
  /** NEW — schema components, shared by validation and spec generation. */
  schemas?: Record<string, JsonSchema>;

  // Root-level route maps remain valid — they form an implicit controller
  // with no prefix. Existing v1 definitions therefore still compile.
  GET?: RouteMap<TInstance>; POST?: ...; PUT?: ...; DELETE?: ...; PATCH?: ...;
}
```

The instance model (`scope` / `data` / `setup` / `methods`) stays at the top
level: one instance lifecycle for the whole API, shared by all controllers.
Controllers are *route organisation*, not isolation boundaries — handlers in
every controller run with `this` bound to the same service instance.

### Merge algorithm

At build time, `apiBuilder`:

1. Normalises the root route maps into an anonymous controller
   (`prefix: ''`).
2. For each controller and verb, rewrites each path to
   `joinPath(prefix, path)` (normalising duplicate slashes; `'/'` route +
   prefix `/p/:proj/wiki` → `/p/:proj/wiki`).
3. Concatenates all routes of all controllers per verb, then applies the
   existing specificity sort **globally**. The current score
   (`segments * 100 − params * 10`) already accounts for prefix parameters
   since scoring happens on the joined path.
4. **Throws at build time** on a duplicate `(verb, joined path)` pair:

   ```
   Error: apiBuilder: duplicate route GET /p/:proj/settings
     declared by controllers 'Settings' and 'Projects'
   ```

   Today a duplicate silently shadows; with multi-file composition, loud
   failure becomes essential.
5. Records per-route provenance (controller tags, guards, permission) in a
   merged metadata table consumed by both the request pipeline and
   `openApiSpec()`.

`openApiSpec()` operates on the merged table, so `api.spec()` /
`api.specHandler()` keep producing **one** document. Controller `tags` fill
in `OperationMeta.tags` when a route declares none.

---

## 5. P2 — Guards and `ctx.state`

A *guard* is a pre-handler hook living in the `ctx` world:

```ts
/**
 * Runs before the route handler. May:
 * - throw / reject an ApiError  → translated to an HTTP error response;
 * - return an object            → shallow-merged into `ctx.state`;
 * - return void                 → pure check.
 */
export type Guard = (
  ctx: ApiContext,
  req: RouterRequest,
) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
```

Guards attach at three levels and run outermost-first:

```
auth.authenticate  →  auth.check  →  api.guards  →  controller.guards  →  route meta.guards  →  handler
```

Per-route guards ride on `OperationMeta` (the natural per-route metadata
slot we already have; spec generation simply ignores the field):

```ts
describe(handler, { summary: '...', guards: [onlyOwner] })
```

`ApiContext` gains a `state` bag for guard-produced values:

```ts
export interface ApiContext<TUser = unknown, TState = Record<string, unknown>> {
  query: { route: Record<string, string>; url: Record<string, string | string[]> };
  /** Shorthand for `query.route`. */
  params: Record<string, string>;
  path: string;
  user?: TUser;
  /** Values produced by guards (loaded resources, resolved roles, …). */
  state: TState;
}
```

This is the feature that erases PP3: "check the permission, load the
project, check the feature flag" becomes three small reusable guards, and
handlers shrink to their actual business logic. Because a guard can *load
and share* a resource via `ctx.state`, it also removes the duplicated
`openProject` call that today runs once in `requirePerm` and once in the
handler.

Failure mode is the existing `ApiError` contract — guards need no new error
channel.

---

## 6. P3 — Auth binding: connecting `jwt-auth` to the API Builder

### The binding

```ts
export interface AuthBinding<TUser = unknown> {
  /**
   * Router middleware run before any guard or handler — typically
   * `jwtPlugin.authenticate`. Registered by apiBuilder on its internal
   * router, so the client no longer wires it per-mount.
   */
  authenticate?: Middleware;

  /**
   * Enforce a permission requirement for the current request.
   * Default implementation: require `ctx.user` and check
   * `ctx.user.permissions` contains all required entries — i.e. the exact
   * semantics of `jwtPlugin.requirePermission`, but in the ctx world.
   * Override for resource-scoped models (per-project roles, ownership, …).
   */
  check?: (ctx: ApiContext<TUser>, required: string[]) => void | Promise<void>;

  /**
   * OpenAPI security scheme emitted into `components.securitySchemes`.
   * Default: `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`.
   */
  scheme?: Record<string, unknown>;
}
```

### Declarative requirement

`OperationMeta` and `ControllerDefinition` gain `permission`:

```ts
describe(handler, { summary: '...', permission: 'wiki.read' })
// or for a whole controller:
defineController({ prefix: '/admin', permission: 'manage_users', ... })
```

When a route (or its controller) declares `permission`, the pipeline runs
`auth.check(ctx, required)` before the guards. Routes without a
`permission` stay public — authorization is opt-in per route, matching the
`authenticate`/`authorize` split already used by the JWT plugin.

### Out-of-the-box JWT integration

```ts
const jwt = createJwtPlugin({ accessTokenSecret: SECRET });

const api = apiBuilder({
  auth: { authenticate: jwt.authenticate },   // default check() reads ctx.user.permissions
  controllers: [ ... ],
});
```

For DevLab's resource-scoped model the client overrides `check` **once**,
replacing the per-handler `requirePerm` calls:

```ts
auth: {
  authenticate: jwt.authenticate,
  check: async (ctx, required) => {
    const proj = await projectService.openProject(ctx.params.proj);
    for (const p of required)
      authService.requirePermission(ctx.user?.sub ?? null, proj, p as Permission);
    ctx.state.proj = proj;       // share the loaded project with guards/handler
  },
},
```

### OpenAPI output

Routes carrying a `permission` automatically receive
`security: [{ bearerAuth: [] }]` and a vendor extension
`x-required-permissions: [...]` in the generated document, and
`components.securitySchemes.bearerAuth` is emitted once. Today the spec
says nothing about auth at all.

### Typed user

`ApiContext<TUser>` replaces `user?: any`. `jwt-auth` exports
`TokenPayload`, so DevLab writes `ApiContext<TokenPayload>` and the
`(ctx.user as any)` casts disappear.

---

## 7. P4 — Request validation from declared schemas

```ts
export interface ValidateOptions {
  /** Validate request bodies against `meta.requestBody` schemas. Default true. */
  requests?: boolean;
  /** Validation failure response: 400 with `{ message, fieldErrors }`. */
}
```

When `validate` is enabled and a route's `OperationMeta.requestBody`
declares a schema, the body is checked before the handler runs. Failures
produce `400` with a body mirroring the client's existing `fieldErrors`
convention:

```json
{ "message": "Request body validation failed",
  "fieldErrors": { "name": "does not match pattern ^[a-z0-9][a-z0-9.\\-]*$" } }
```

Implementation: a small internal validator covering the pragmatic subset of
the already-exported `JsonSchema` type — `type`, `required`, `properties`,
`items`, `enum`, `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`,
`additionalProperties`, `allOf`/`anyOf`/`oneOf`, and `$ref` resolved against
`ServiceDefinition.schemas`. Roughly 150 lines, zero dependencies, shared
with nothing else (no ajv-style compilation needed at these traffic levels).

`schemas` moves the component map from `SpecOptions` (doc-generation time)
to the service definition (build time), so one declaration feeds both the
spec and the validator; `openApiSpec()` reads it from the service when
present.

This deletes most of the client's hand-rolled checks: the milestone
`NAME_RE` test, the `applySettingsBody` type/enum/length checks, the
"must be a string array" guards — all already expressible in the schemas
the client writes anyway.

---

## 8. P5 — Context ergonomics

Small, mechanical additions to `ApiContext` (all shown in §5):

- `ctx.params` — alias of `ctx.query.route`. The dominant access pattern
  deserves the short name; the namespaced form remains for collisions.
- `ctx.state` — guard-produced values (see P2).
- `ApiContext<TUser, TState>` generics — typed `user` and `state`.

Rejected: built-in pagination parsing (`start`/`count` conventions are
app-specific), a response-shaping hook (the `Edition`/dry-run protocol is
DevLab domain logic), and `ctx.req`/`ctx.res` escape hatches (handlers that
need the raw objects should be plain router middleware).

---

## 9. Worked example — refactoring the DevLab monolith

Target layout (one file per domain, ~150–400 lines each):

```
api/
  index.ts                  — composition root (apiBuilder call, auth binding)
  guards.ts                 — featureEnabled(), loadProject(), requireAdmin
  auth.controller.ts        — /auth/*
  projects.controller.ts    — /projects, /p/:proj, /p/:proj/settings
  git.controller.ts         — commits, refs, files, git-update hooks
  wiki.controller.ts        — /p/:proj/wiki/*
  snippets.controller.ts    — /p/:proj/snippets/*
  issues.controller.ts      — issues, comments, reactions
  merge-requests.controller.ts
  pipelines.controller.ts   — pipelines + CI runner helpers
  releases.controller.ts    — releases, milestones promote
  admin.controller.ts       — /admin/namespaces, /users
  notifications.controller.ts
```

### `guards.ts`

```ts
import type { Guard } from 'expediate';
import { HttpErr } from './utils';

/** Require a project feature flag; expects ctx.state.proj loaded by auth.check(). */
export const featureEnabled = (flag: 'wikiEnabled' | 'snippetsEnabled'): Guard =>
  (ctx) => {
    const proj = ctx.state.proj as DbProject;
    if (!proj?.[flag]) throw HttpErr.NotFound('Feature is not enabled for this project');
  };

/** Require a system administrator. */
export const requireAdmin: Guard = (ctx) => {
  const username = ctx.user?.sub;
  if (!username) throw HttpErr.Unauthorized('Authentication required');
  const user = userService.listUsers().find(u => u.username === username);
  if (!user?.isAdmin) throw HttpErr.Forbidden('Admin access required');
  return { username };          // → ctx.state.username
};
```

### `wiki.controller.ts` — before vs after

Before (current code, **one of six** near-identical handlers):

```ts
'/p/:proj/wiki/pages/:slug': describe(async function (ctx: ApiContext): Promise<WikiPage> {
  const projectName = ctx.query.route.proj;
  await requirePerm(ctx, projectName, 'wiki.read')
  const proj = await projectService.openProject(projectName);
  if (!proj.wikiEnabled) throw HttpErr.NotFound('Wiki is not enabled for this project');
  return wikiService.readPage(projectName, ctx.query.route.slug);
}, {
  summary: 'Read a wiki page',
  operationId: 'getWikiPage',
  tags: ['Wiki'],
  responses: ok(ref('WikiPage')),
}),
```

After (whole controller):

```ts
import { defineController, describe } from 'expediate';
import { featureEnabled } from './guards';

export const wikiController = (wikiService: WikiService) => defineController({
  prefix: '/p/:proj/wiki',
  tags: ['Wiki'],
  permission: 'wiki.read',                 // auth.check() runs for every route
  guards: [featureEnabled('wikiEnabled')], // proj already loaded by auth.check()

  GET: {
    '/tree': describe(
      (ctx) => wikiService.listPages(ctx.params.proj),
      { summary: 'List all wiki pages', operationId: 'getWikiTree',
        responses: ok(arrayOf('WikiTreeItem')) }),

    '/pages/:slug': describe(
      (ctx) => wikiService.readPage(ctx.params.proj, ctx.params.slug),
      { summary: 'Read a wiki page', operationId: 'getWikiPage',
        responses: ok(ref('WikiPage')) }),

    '/pages/:slug/revisions': describe(
      (ctx) => wikiService.pageRevisions(ctx.params.proj, ctx.params.slug),
      { summary: 'List revision history', operationId: 'getWikiPageRevisions',
        responses: ok(arrayOf('WtRevision')) }),

    '/pages/:slug/revisions/:version': describe(
      (ctx) => wikiService.pageAtRevision(ctx.params.proj, ctx.params.slug, ctx.params.version),
      { summary: 'Read a page at a revision', operationId: 'getWikiPageAtRevision',
        responses: ok({ type: 'string' }) }),
  },

  POST: {
    '/search': describe(
      (ctx, body: WikiSearchRequest) =>
        wikiService.searchPages(ctx.params.proj, body.query ?? '', body.caseSensitive ?? false),
      { summary: 'Full-text wiki search', operationId: 'searchWiki',
        permission: 'wiki.read',
        requestBody: jsonBody(ref('WikiSearchRequest')),
        responses: ok(arrayOf('WikiSearchResult')) }),
  },

  PUT: {
    '/pages/:slug': describe(
      (ctx, body) => wikiService.writePage(ctx.params.proj, ctx.params.slug, body, ctx.user!.sub),
      { summary: 'Create or update a wiki page', operationId: 'putWikiPage',
        permission: 'wiki.write',          // route-level override
        requestBody: jsonBody(ref('WikiPageUpdate')),
        responses: ok(ref('WikiPage')) }),
  },
});
```

Each handler is now one expression. The six-line preamble exists exactly
once — in the auth binding and one guard.

### `issues.controller.ts` (excerpt)

The mutation routes keep their domain logic (edit service, notifications,
audit logs are app concerns) but lose the auth/loading preamble:

```ts
export const issuesController = (deps: Deps) => defineController({
  prefix: '/p/:proj/issues',
  tags: ['Issues'],

  POST: {
    '/:uid/comments': describe(async (ctx, body) => {
      const { proj } = ctx.state;          // loaded by auth.check()
      const user = await deps.userService.readUser(ctx.user!.sub);
      const edit = await itemEdition<DataIssue>(ctx.params.proj, 'issue', ctx.params.uid,
        !!body.dryRun, (item, ec) => deps.editService.editAddComment(item, body, user, nowISO(), ec));
      if (edit.success && edit.data)
        deps.notificationService.onComment(ctx.params.proj, 'issue',
          edit.data.uid, edit.data.title, user, edit.data.participants);
      return { ...edit, data: edit.data ? deps.mapper.mapDtoIssueFull(edit.data, proj, []) : null };
    }, {
      summary: 'Add a comment to an issue', operationId: 'commentIssue',
      permission: 'issue.comment',
      requestBody: jsonBody(ref('CommentUpdate')),
      responses: ok(editionOf('DtoIssueFull')),
    }),
  },
});
```

### `index.ts` — composition root

```ts
export function useApiService(deps: Deps, jwt: JwtPlugin): ApiRouter {
  return apiBuilder({
    auth: {
      authenticate: jwt.authenticate,
      check: async (ctx, required) => {
        const proj = await deps.projectService.openProject(ctx.params.proj);
        for (const p of required)
          deps.authService.requirePermission(ctx.user?.sub ?? null, proj, p as Permission);
        ctx.state.proj = proj;
      },
    },
    validate: true,
    schemas: dtoSchemas,                    // shared by spec + validator

    controllers: [
      authController(deps),
      projectsController(deps),
      gitController(deps),
      wikiController(deps.wikiService),
      snippetsController(deps),
      issuesController(deps),
      mergeRequestsController(deps),
      pipelinesController(deps),
      releasesController(deps),
      adminController(deps),
      notificationsController(deps),
    ],
  });
}
```

Estimated effect on the monolith: 3,480 lines → ~12 files of 150–400 lines;
roughly 500 lines of repeated preamble and manual validation deleted
outright.

---

## 10. Breaking-changes summary

Although breaking changes are allowed, the design lands as a superset:

| Change | Impact |
|---|---|
| `ApiContext` gains `params`, `state`, generics | additive; `query.route` untouched |
| `ServiceDefinition` gains `controllers`, `guards`, `auth`, `validate`, `schemas` | additive |
| `OperationMeta` gains `guards`, `permission` | additive |
| Duplicate `(verb, path)` now **throws** at build time | behavioural break (was silent shadowing) — intended |
| `SpecOptions.components.schemas` superseded by `ServiceDefinition.schemas` | soft break; spec options form kept as fallback |
| Default `ApiContext.user` type `unknown` instead of `any` | compile-time break for sloppy accesses — intended |

The v1 single-definition style keeps working; v2 is the same API with seams.

## 11. Implementation order

1. **`ctx.params` + generics** — trivial, isolated (`apis.ts`).
2. **Controller merge + conflict detection** — `apis.ts` route collection
   refactor; `openapi.ts` reads the merged table. Tests: prefix joining,
   global sort across controllers, duplicate-route throw, merged spec tags.
3. **Guards + `ctx.state`** — pipeline change in `buildRoutes`. Tests:
   ordering (api → controller → route), state merging, ApiError from guard.
4. **Auth binding** — default `check` against `ctx.user.permissions`
   (jwt-auth semantics), `authenticate` auto-registration, OpenAPI
   `security` emission. Tests with `createJwtPlugin` end-to-end.
5. **Validation** — internal JSON-Schema subset validator + `$ref`
   resolution. Tests: each keyword, `fieldErrors` shape, opt-out.

Per the development checklist: full JSDoc on all new exports, re-export
from `src/index.ts`, tests per step in `tests/apis.test.ts` (and a new
`tests/api-guards.test.ts` if the file grows unwieldy), README and
`docs/api-builder.md` updates after implementation.

## 12. Others implementation decisions

1. **Guard typing of `ctx.state`** — full inference (accumulating state
   types across the guard chain) is possible with tuple types but costly in
   complexity. `TState` must declared explicitly by the client via
   the `ApiContext<TUser, TState>` annotation; guards stay loosely typed.
2. **Controllers don't need their own `scope`?**
   instance lifecycle stays API-wide. A controller needing its own state is
   a sign it should be a separately mounted API.
3. **Response validation** (`validate.responses: 'warn'`) — useful in dev,
   but doubles validator surface. Will be activated only with an options
   give to the apiBuilder.
4. **`x-required-permissions` naming** — vendor extension vs. OpenAPI
   `security` scopes on a custom scheme. Extension is simpler and honest
   (these are not OAuth scopes); the name of the header can be overwrite
   with option provided to the apiBuilder.
