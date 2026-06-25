# API Builder v3 — Response Control, Auth Escape Hatches, and Error Unification

**Status:** Draft / design discussion
**Date:** 2026-06-25
**Scope:** `src/apis.ts`, `src/http-objects.ts`, touch points with `src/router.ts`
**Compatibility:** additive except where noted; one optional breaking change is flagged separately

---

## 1. Context

A second field study — independent from the DevLab review behind
`api-builder-v2-design.md` — evaluated `apiBuilder` for a project built around
hand-rolled, cookie-based session authentication (`createSessionMiddleware`
reading `req.headers.cookie` / writing `res.setHeader('Set-Cookie', ...)` /
attaching `req.session`) and a class-based `AppError` hierarchy
(`.status`/`.code`, caught once via `instanceof AppError`). The project ended
up using plain `createRouter()` routers instead of `apiBuilder`, for three
reasons:

1. `ApiContext` carries no path to the response object, so nothing in the
   `apiBuilder` pipeline can refresh a sliding-expiration session cookie or
   otherwise write a header mid-pipeline.
2. The truthy/falsy return convention (`200` / `201` no-body) doesn't cover
   `201 Created` *with* a body, or `204 No Content` on `DELETE` — both
   needed routes existed.
3. `ApiError` is an anonymous `{ status, data, message }` shape; bridging it
   to an `AppError` class hierarchy with `.code` would mean writing the same
   `instanceof AppError` translation twice — once for `service.onError`, once
   for the app's own `router.error()` (for the routes that aren't behind
   `apiBuilder`).

A fourth complaint — that the `scope`/`data`/`methods` instance model is
incompatible with a pure-function, closure-injected style — does **not**
require a framework change. All three fields are optional; a service with
none of them is a singleton instance (`{ $key: 'singleton' }`) that handlers
are free to ignore entirely. Arrow-function handlers closing over
injected dependencies already work today and are shown in
`api-builder-v2-design.md` §9 (`wikiController = (wikiService) =>
defineController({ ... })`). The actual gap is that `docs/api-builder.md`
opens with the `data()`/`this`/`methods` example, which reads as if the
instance model were mandatory. That is a documentation fix (§5 below), not a
design problem.

## 2. Pain points (evidence)

### PP1 — No write path to the response inside the pipeline

Guards already receive `(ctx, req)` — enough to read `req.session` or
`req.headers['x-cinema-id']` and turn `requireRole`/`resolveCinemaId` into
ordinary guards. What guards (and `auth.check`) cannot do is **write** to the
response: there is no `res` anywhere in the guard or auth-check signatures,
so a sliding-expiration cookie refresh, or any header that must be set
*before* the handler runs, has no seam. Separately, `ctx.user` is hardwired
to `req.user` in `apis.ts` (`user: req.user` in `buildRoutes`), which is a
JWT-plugin convention (`req.user` is typed `TokenPayload` via module
augmentation in `jwt-auth.ts`) — a session-based identity has to either
write into `req.user` itself (works, but fights the JWT typing) or be
inaccessible from `ctx.user`.

### PP2 — Binary return contract

Truthy → `200`, falsy → what the docs call "`201 No Content`" — which is
itself a minor existing inaccuracy: `201 Created` conventionally carries a
representation of the created resource; a bodyless success is `204 No
Content`. The binary convention has no slot for `201 Created` *with* a body
on `POST`, or an explicit `204` on `DELETE` alongside a plain `200` on `GET`
— exactly the three-way mapping a typical REST resource needs.

### PP3 — Disconnected error hierarchies

`service.onError(err, ctx, req)` can reshape any thrown value into an
`ApiError`, but only for routes registered through that one `apiBuilder`
call. An application also has routes outside `apiBuilder` (static files,
the JWT plugin's `/auth/*` endpoints, ad hoc routers) whose failures flow
through `router.error()` / `onError()` instead — a structurally different
hook (`(err, req, res, next)` vs `(err, ctx, req) => void | ApiError`). A
custom `Error` subclass hierarchy with its own `.status`/`.code` has to be
translated at both seams, by hand, with no shared code between them.

## 3. Goals and non-goals

**Goals**

1. Give the pipeline (guards, `auth.check`) a way to reach the response
   object for the narrow set of cases that need it (cookie/header
   mid-pipeline writes), without reintroducing `res` into the handler's
   pure-business-logic contract.
2. Let a handler opt into an explicit status code (and, for `201`, a body)
   on a per-call basis, without changing the default truthy/falsy
   convention for the common case.
3. Let one error-translation function serve both `apiBuilder` and
   plain-router error handling, so a custom error hierarchy is mapped to
   `ApiError` exactly once.
4. Decouple `ctx.user` population from the `req.user` / JWT convention.

**Non-goals**

- Reopening `ctx.req`/`ctx.res` as handler-level fields. The v2 design
  rejected this for handlers ("handlers that need raw objects should be
  plain router middleware") and that reasoning still holds for the
  *handler* layer — the routes that actually need raw `req`/`res` access
  in this field study are auth/session concerns, which already run as
  guards or `authenticate` middleware, not as `apiBuilder` route handlers.
  This document proposes giving **guards and `auth.check`** a path to
  `res` (§4), which is narrower and keeps the handler contract intact. If
  a future case needs `res` *inside a handler* specifically, that should be
  reconsidered on its own evidence rather than folded in here.
- A generic response-shaping/serialization hook. `withStatus()` (§5) covers
  status + body; content negotiation, headers, streaming, etc. remain a job
  for plain middleware in front of or instead of `apiBuilder`.
- Changing the default falsy-return status from `201` to the more correct
  `204` as part of this round — flagged in §7 as a separate, optional
  breaking change for the maintainer to schedule deliberately.

---

## 4. P1 — Reaching the response from guards and `auth.check`

### `req.res` linking

Node's `http.ServerResponse` already exposes `res.req` back to the request
that produced it; expediate does not currently set the mirror `req.res`.
Adding it is a one-line change in `updateHttpObjects()` (`src/http-objects.ts`)
plus a type augmentation, and immediately gives every function that already
receives `req` — guards, and `auth.check` once it gains a `req` parameter
(below) — a path to `res` with no new parameter threaded through the whole
pipeline:

```ts
// src/http-objects.ts, inside updateHttpObjects()
rReq.res = res;
```

```ts
// router-types.ts (or wherever RouterRequest is declared)
interface RouterRequest {
  // ...
  /** Back-reference to the response for this request, mirroring Node's `res.req`. */
  res?: RouterResponse;
}
```

### `auth.check` gains `req`

`AuthBinding.check` currently has no `req` parameter at all — guards get
`(ctx, req)`, but the primary authorization hook doesn't, which is an
inconsistency independent of this field study. Adding it (as a third,
optional-to-use parameter) is additive:

```ts
export interface AuthBinding<TUser = unknown> {
  authenticate?: Middleware;
  check?: (ctx: ApiContext<TUser>, required: string[], req: RouterRequest) => void | Promise<void>;
  scheme?: Record<string, unknown>;
  permissionsExtension?: string;
}
```

A resource-scoped check that needs to slide a session's expiry on every
authorized request can now do so:

```ts
auth: {
  authenticate: sessionMiddleware,
  check: async (ctx, required, req) => {
    if (!req.session?.userId) throw { status: 401, message: 'Authentication required' };
    requireCinemaAccess(req.session, req.headers['x-cinema-id'] as string, required);
    req.res?.cookie('sid', req.session.id, { signed: true, maxAge: 3600 }); // slide expiry
  },
},
```

This is deliberately presented as an advanced path, not the default one:
guards and `check` should still prefer **throw / return state / return
void** wherever possible (see `docs/errors.md` and `api-builder-v2-design.md`
§5) — reaching into `req.res` bypasses that declarative contract and should
be reserved for cases with no other seam, exactly like the session-cookie
refresh above.

### `resolveUser` — decoupling `ctx.user` from `req.user`

```ts
export interface AuthBinding<TUser = unknown> {
  // ...
  /**
   * Extract the authenticated identity for `ctx.user`. Defaults to
   * `(req) => req.user`, the JWT-plugin convention. Override when the
   * identity lives elsewhere (e.g. `req.session.user`).
   */
  resolveUser?: (req: RouterRequest) => TUser | undefined;
}
```

`buildRoutes` reads `service.auth?.resolveUser?.(req) ?? req.user` instead of
the hardcoded `req.user`. A session-based `authenticate` middleware no longer
needs to write into the JWT-typed `req.user` field just to populate
`ctx.user`:

```ts
auth: {
  authenticate: sessionMiddleware,
  resolveUser: (req) => req.session?.user,
},
```

---

## 5. P2 — `withStatus()`: an opt-in response-status escape hatch

```ts
const API_RESULT: unique symbol = Symbol('expediate.apiResult');

export interface ApiResult<T = unknown> {
  readonly [API_RESULT]: true;
  status: number;
  body?: T;
}

/**
 * Return from a service method to send a specific status code (and,
 * optionally, a JSON body) instead of the default truthy → 200 / falsy → 201
 * convention. Useful for `201 Created` with a body, or an explicit `204 No
 * Content`.
 */
export function withStatus<T>(status: number, body?: T): ApiResult<T> {
  return { [API_RESULT]: true, status, body };
}

function isApiResult(value: unknown): value is ApiResult {
  return typeof value === 'object' && value !== null && API_RESULT in value;
}
```

In `buildRoutes`, the response step becomes:

```ts
const val = await route.handler.apply(instance, [ctx, body]);
if (isApiResult(val)) {
  if (val.body !== undefined) {
    if (validateResponses && route.meta?.responses)
      validateResponseBody(route.meta.responses, val.status, val.body, schemaComponents, validateResponses);
    sendJson(res, val.body);
    res.statusCode = val.status; // set before send, or sendJson(res, val.body, val.status)
  } else {
    res.status(val.status).end();
  }
} else if (val !== undefined && val !== null && val !== false && val !== 0 && val !== '') {
  // unchanged: existing truthy → 200 path
} else {
  res.status(201).end(); // unchanged default; see §7 for the 201→204 question
}
```

(`sendJson` needs the status set before `res.send()` — the sketch above
needs the actual ordering fixed at implementation time; shown here to
illustrate the branch, not as final code.)

Usage:

```ts
POST: {
  '/items': (ctx, body) => withStatus(201, createItem(body)),  // 201 Created + body
},
DELETE: {
  '/items/:id': (ctx) => { deleteItem(ctx.params.id); return withStatus(204); },
},
GET: {
  '/items': () => listItems(),  // unchanged: truthy → 200
},
```

This is purely additive — existing handlers returning plain values are
untouched. Response-schema validation (`validateResponseBody`), which today
hardcodes status `200`, is generalized to validate against whichever status
was actually sent.

---

## 6. P3 — `errorTranslator()`: one mapping, two seams

```ts
/**
 * Build a single err → ApiError mapping usable both as a `service.onError`
 * hook and as a `router.error()` middleware, so an application-specific
 * error hierarchy is translated exactly once regardless of which seam a
 * given route falls through.
 */
export function errorTranslator(
  translate: (err: unknown) => ApiError | undefined,
): {
  /** Plug into `ServiceDefinition.onError`. */
  onError: (err: unknown) => ApiError | undefined;
  /** Plug into `router.error()`, for routes outside this `apiBuilder` call. */
  middleware: ErrorMiddleware;
} {
  return {
    onError: translate,
    middleware: (err, _req, res, next) => {
      const apiErr = translate(err);
      if (!apiErr) return next(err); // not ours — forward, let other handlers/bubbling decide
      const status = apiErr.status ?? 500;
      if (apiErr.data !== undefined) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(status).send(JSON.stringify(apiErr.data));
      } else {
        res.status(status).send(apiErr.message ?? 'Internal error');
      }
    },
  };
}
```

Usage — the `AppError → ApiError` mapping is written once:

```ts
const errors = errorTranslator(err =>
  err instanceof AppError ? { status: err.status, data: { code: err.code, message: err.message } } : undefined);

const api = apiBuilder({
  onError: err => errors.onError(err),
  // ...
});

app.use('/api', api);
app.error(errors.middleware);   // catches AppError thrown by routes outside apiBuilder
```

`.code` is preserved end to end (inside `apiErr.data`), so structured clients
keep working without the project giving up its own error hierarchy.

---

## 7. Open question: should the falsy-return default move from `201` to `204`?

Independent of `withStatus()`, the existing default for a falsy return is
`res.status(201).end()` with no body — which doesn't match `201 Created`'s
conventional meaning (a representation of the created resource, often with
`Location`). `204 No Content` is the status that means "succeeded, nothing
to send." `withStatus()` already lets any handler opt into the *correct*
status today; this section is only about whether the **default** should
change.

This is a behavioural break for any existing handler relying on a bare
falsy return meaning `201` (status code visible to clients changes from 201
to 204). Given `apiBuilder` has shipped two minor versions with `201` as the
documented default, this is listed as an open question for a deliberately
scheduled breaking change rather than bundled into this round.

---

## 8. Documentation fix (no code change)

Add a "Stateless services" example to `docs/api-builder.md`, alongside the
existing `data()`/`this`/`methods` one, showing a service with none of
`scope`/`data`/`methods` — just closures over injected dependencies and
arrow-function handlers — to make explicit what `api-builder-v2-design.md`
§9 already demonstrates in passing. This addresses PP-stateful-model from
§1 without touching `src/`.

---

## 9. Breaking-changes summary

| Change | Impact |
|---|---|
| `req.res` link on every request | additive |
| `AuthBinding.check` gains a third `req` parameter | additive (existing two-arg checks keep compiling) |
| `AuthBinding.resolveUser` | additive; default preserves current `req.user` behaviour |
| `withStatus()` / `ApiResult` | additive; existing return-value handlers unchanged |
| `validateResponseBody` validates against the actual sent status, not a hardcoded `200` | additive (only changes behaviour for handlers using `withStatus()`, which are new) |
| `errorTranslator()` | additive, new export |
| Falsy-return default `201` → `204` | **not** part of this round — open question, §7 |

## 10. Implementation order

1. **`req.res` link** — trivial, isolated (`http-objects.ts`). Test: a guard
   reading `req.res` inside a request and setting a header that the test
   asserts on the actual HTTP response.
2. **`AuthBinding.check(req)` + `resolveUser`** — `apis.ts` pipeline change.
   Tests: `check` reading `req`, `resolveUser` overriding `ctx.user`
   population, default behaviour unchanged when neither is supplied.
3. **`withStatus()`** — new export + `buildRoutes` response branch. Tests:
   `201` with body, `204` without body, existing truthy/falsy paths
   unchanged, response-schema validation against the dynamic status.
4. **`errorTranslator()`** — new export. Tests: `onError` usage, `middleware`
   usage standalone on a plain router, `.code`/custom fields preserved,
   forwarding (`next(err)`) when `translate` returns `undefined`.
5. **Docs** — stateless-services example in `api-builder.md`; new sections
   for `req.res`, `resolveUser`, `withStatus()`, `errorTranslator()`;
   `docs/errors.md` gains a recipe showing `errorTranslator()` bridging
   `apiBuilder` and `router.error()`.

Per the project's development checklist: full JSDoc on every new export,
re-export from `src/index.ts`, tests in `tests/apis.test.ts` /
`tests/api-guards.test.ts` per step, README and `docs/api-builder.md` /
`docs/errors.md` updates after implementation.
