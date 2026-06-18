# Error Handling

Expediate routes every failure through a single, predictable **error channel**. A middleware can throw, an `async` middleware can reject, or any middleware can call `next(err)` — all three converge on the same path. From there the error flows through an ordered chain of handlers, falls back to a terminal handler, and ultimately **bubbles up to parent routers** until something responds.

This document describes that channel end to end: what enters it, how `error()` and `onError()` differ, the exact resolution order, how bubbling crosses `use()` boundaries, and how `apiBuilder` layers its own handling on top.

---

## What enters the error channel

Three things put an error onto the channel for a given request:

1. **A synchronous throw** inside any middleware or route handler.
2. **A rejected `Promise`** returned by an `async` middleware (or one that returns a promise).
3. **An explicit `next(err)`** call with a non-null argument.

All three are caught by the router's internal `invoke()` wrapper:

```ts
const invoke = (mw, nextFn) => {
  try {
    const ret = mw(req, res, nextFn);
    if (ret instanceof Promise) ret.catch(invokeErrorHandler); // async rejection
  } catch (e) {
    invokeErrorHandler(e);                                     // sync throw
  }
};
```

Calling `next(err)` short-circuits the dispatch loop: remaining route layers for the request are skipped and control jumps straight into the error channel.

```ts
app.use('/protected', (req, _res, next) => {
  if (!req.headers.authorization) return next(new Error('Unauthorized'));
  next(); // no argument → continue normal routing
});
```

> **Async caveat.** Only the promise *returned* by a middleware is tracked. If a middleware calls `next()` and then throws **later** from a detached callback — a `setTimeout`, an event emitter, a stray `.then()` — that throw escapes the framework. Keep error-prone async work in the returned promise chain (use `async`/`await` or `return somePromise`).

---

## Two ways to handle errors

Expediate offers two registration APIs. They compose: `error()` handlers run first as an ordered chain, and `onError()` is the single terminal fallback when the chain does not respond.

### `router.error()` — ordered, escapable chain

`error()` registers an **error middleware**. Unlike a normal middleware, the error value is the **first** argument — a deliberate signal that this function runs on the error channel, not the normal request pipeline.

```ts
type ErrorMiddleware = (
  err:  unknown,
  req:  RouterRequest,
  res:  RouterResponse,
  next: NextFunction,
) => void;

app.error((err, req, res, next) => { /* … */ });
```

Each handler does one of two things:

- **End the response** (`res.status(...).json(...)`, `res.end()`, …) — the error is handled, and the chain stops.
- **Call `next`** to pass control along the error channel:
  - `next()` — forward the **same** error to the next error middleware.
  - `next(newErr)` — forward a **replacement** error instead.

Handlers run in **registration order**. The first one to end the response wins; later ones never run.

```ts
// Run in order. The first to respond ends the chain.
app.error((err, _req, res, next) => {
  if ((err as any)?.status === 404) return res.status(404).json({ error: 'Not Found' });
  next(err);                       // not ours — forward unchanged
});

app.error((err, _req, res, next) => {
  if (err instanceof ValidationError) return res.status(400).json({ fields: err.fields });
  next(err);                       // still not ours — forward
});

app.error((err, _req, res, _next) => {
  res.status((err as any)?.status ?? 500).json({ error: String(err) }); // catch-all
});
```

A throw **inside** an error handler is itself caught and forwarded to the next handler in the chain (with the newly thrown value), so a buggy handler degrades gracefully instead of crashing the request.

```ts
app.error((_err, _req, _res, _next) => { throw new Error('logger exploded'); });
app.error((err, _req, res, _next) => {
  // err is now Error('logger exploded') — the previous handler's throw
  res.status(500).end('recovered');
});
```

You may register as many `error()` handlers as you like; they accumulate.

### `router.onError()` — single terminal fallback

`onError()` registers **one** simple, terminal handler. It has no `next` — it cannot forward, and it does not bubble. It exists for the common case where you want a single catch-all and nothing more.

```ts
type ErrorHandler = (err: unknown, req: RouterRequest, res: RouterResponse) => void;

app.onError((err, _req, res) => {
  const status = (err as any)?.status ?? 500;
  res.status(status).json({ error: String(err) });
});
```

Calling `onError()` again **replaces** the previous handler (only one is ever active). It runs only after the `error()` chain has been exhausted without responding.

| | `error()` | `onError()` |
|---|---|---|
| Argument order | `(err, req, res, next)` | `(err, req, res)` |
| How many | Many (ordered chain) | One (replaces previous) |
| Can forward / escalate | Yes, via `next` | No |
| Participates in bubbling | Yes (forwarding) | No — terminal for its router |
| Typical use | Layered, type-specific handling | A single catch-all |

---

## Resolution order

When an error enters a router's channel, it is resolved through this cascade:

```
error()  →  error()  →  …            (ordered chain; each may respond or forward)
                    │
                    ▼  (chain exhausted, response not ended)
              onError()                (terminal fallback for this router, if set)
                    │
                    ▼  (not set / did not respond)
              done(err)                (bubble to the PARENT router's channel)
                    │
                    ▼  (no parent — top-level router)
              default 500              (console.warn + "Error <method> <url>")
```

Step by step:

1. **`error()` chain.** Each registered error middleware runs in order. If one ends the response, resolution stops.
2. **`onError()` fallback.** If the chain forwards all the way through (or there are no `error()` handlers) without ending the response, the single `onError()` handler runs — if one is registered. If `onError()` itself throws, a plain `500` is sent as a last resort.
3. **Bubble to the parent.** If neither responded **and** this router was mounted inside another via `use()`, the error is handed to the parent router's channel (see below).
4. **Default 500.** A top-level router with nothing left to try logs the error with `console.warn` and sends `Error <method> <url>` with status `500`.

At every step there is a guard: if the response has already been ended (`res.writableEnded`), the channel stops immediately. Handlers are expected to end the response unless they forward via `next`.

---

## Bubbling to parent routers

This is the most important behavior to understand when composing routers. **An error a sub-router does not handle does not die there — it climbs to the router that mounted it.**

Mechanically, when you mount a router with `app.use('/path', child)`, the parent passes its own `next` into the child as the child's `done` callback. When the child's channel is exhausted without responding, it calls `done(err)`, which is the parent's `next(err)` — and that drops the error onto the *parent's* error channel. The same continuation also restores `req.path` and `req.baseUrl` so the parent handler sees the original, un-stripped path.

```ts
const api = createRouter();
api.get('/items/:id', () => { throw new Error('db down'); }); // no handler here

const app = createRouter();
app.use('/api', api);

// The failure raised inside `api` bubbles up to here:
app.error((err, _req, res, _next) =>
  res.status(500).json({ error: String(err) }));
```

Bubbling is transitive — an error climbs through **every** level of nesting until something responds or it reaches the top:

```ts
const grandchild = createRouter();
grandchild.get('/fail', () => { throw new Error('3 levels down'); });

const child = createRouter();
child.use('/gc', grandchild);

const root = createRouter();
root.use('/c', child);
root.error((err, _req, res, _next) => res.status(500).send(String(err)));

// GET /c/gc/fail  →  bubbles grandchild → child → root, handled at root.
```

### A child handler stops the bubble

A sub-router's **own** handlers take precedence. If a child's `error()` chain (or its `onError()`) ends the response, the error never reaches the parent:

```ts
const child = createRouter();
child.error((_err, _req, res, _next) => res.status(400).send('child handled'));
child.get('/x', () => { throw new Error('boom'); });

const parent = createRouter();
parent.error((_err, _req, res, _next) => res.status(500).send('parent')); // never runs for /x
parent.use('/child', child);
```

> **Design note — `onError()` blocks bubbling.** A child's `onError()` is *terminal for that router*: once it responds, nothing bubbles. If you want a sub-router to **log but still escalate**, do not use `onError()` — use an `error()` handler that inspects the error and then calls `next(err)`:
>
> ```ts
> child.error((err, req, _res, next) => {
>   logger.warn({ path: req.path, err });
>   next(err);   // decline to respond → bubble to the parent
> });
> ```

---

## Top-level routers and the default 500

A router becomes "top-level" when it is invoked without a `done` callback — most commonly via `http.createServer(app.listener)` or `app.listen()`. With no parent to bubble to and no handler registered, the default behavior is:

```
console.warn(err);
res.status(500).end(`Error ${method} ${url}`);
```

So even with zero configuration, an uncaught error always produces a `500` rather than a hung request. Registering an `error()` or `onError()` handler on the top-level router lets you replace this default with structured output, logging, error tracking, etc.

---

## `apiBuilder` error handling

`apiBuilder` returns a `Router`, so everything above applies — but it adds its own layer on top, because service handlers signal failure by throwing/rejecting an **`ApiError`** rather than touching `res` directly.

### `ApiError` → HTTP translation

```ts
interface ApiError {
  status?:  number;   // default 500
  data?:    unknown;  // JSON body — takes precedence over message
  message?: string;   // plain-text body
}
```

Any value thrown or rejected by a handler, **guard**, **auth check**, or **request validation** is translated automatically:

- `{ status, data }` → that `status`, with `data` serialized as a JSON body.
- `{ status, message }` → that `status`, with `message` as a plain-text body.
- Anything else (a bare `Error`, a string, …) → `500`, body `message` if present, else `"Internal error"`.

```ts
const service: ServiceDefinition<State> = {
  GET: {
    '/items/:id': function (this: State, ctx) {
      const item = this.items[ctx.params.id];
      if (!item) throw { status: 404, message: 'Not found' } satisfies ApiError;
      return item; // truthy → 200 + JSON
    },
  },
};
```

### The `service.onError` hook

Add an `onError` hook to the service definition to **inspect, log, or reshape** errors *before* the default translation runs. Unlike a router-level `error()` handler, this hook receives the full `ApiContext`, so it has access to `ctx.path`, `ctx.params`, `ctx.user`, `ctx.state`, and the request.

```ts
onError?(err: unknown, ctx: ApiContext<any>, req: RouterRequest): void | ApiError;
```

Its return value decides what happens next:

| Hook does… | Result |
|---|---|
| **returns `undefined`** | The original error proceeds to the default `ApiError` → HTTP translation. Ideal for **log-only**. |
| **returns an `ApiError`** | That value is sent **instead** of the original — reshape, mask internals, attach a correlation id, downgrade a status, etc. |
| **throws** | The thrown value is **escalated** to the surrounding app's error channel (`router.error()` / `onError()`) via `next(err)`, instead of being answered locally. |

```ts
const service: ServiceDefinition<State> = {
  onError(err, ctx, req) {
    metrics.increment('api.error', { path: ctx.path });
    logger.error({ reqId: req.id, user: ctx.user, err });

    if (err instanceof DbTimeout)
      return { status: 503, message: 'Please retry shortly' }; // reshape

    if (err instanceof FatalConfigError)
      throw err;            // escalate to app.error() — let a process-wide handler decide

    // return nothing → default ApiError translation
  },
  // …routes, guards, auth…
};
```

This gives you a three-way choice at the boundary of every API: handle-and-translate (the default), handle-and-reshape (return), or defer to the wider application (throw). Because the hook runs inside the per-route `catch` where `ctx` is still in scope, the escalation path threads through the same router bubbling described above: a thrown hook → `next(err)` on the api router → (no api-level handler) → bubble to the parent app's `error()` chain.

---

## Recipes

### Structured JSON errors at the top level

```ts
app.error((err, req, res, _next) => {
  const status = (err as any)?.status ?? 500;
  res.status(status).json({
    error:   (err as any)?.message ?? 'Internal Server Error',
    path:    req.path,
    status,
  });
});
```

### Type-specific handlers, ordered

```ts
app.error((err, _req, res, next) =>
  err instanceof NotFoundError ? res.status(404).json({ error: 'Not Found' }) : next(err));

app.error((err, _req, res, next) =>
  err instanceof AuthError ? res.status(401).json({ error: 'Unauthorized' }) : next(err));

app.error((err, _req, res, _next) =>
  res.status(500).json({ error: String(err) })); // fallback
```

### Log in a sub-router, respond at the root

```ts
child.error((err, req, _res, next) => { logger.warn({ path: req.path, err }); next(err); });

root.use('/child', child);
root.error((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
```

### Mask internal errors but keep real ones in an API

```ts
const service: ServiceDefinition = {
  onError(err) {
    if ((err as ApiError)?.status) return;          // intentional ApiError → pass through
    return { status: 500, message: 'Something went wrong' }; // hide unexpected internals
  },
  // …
};
```

---

## Quick reference

| Concern | API |
|---|---|
| Ordered, forwardable error handlers | `app.error((err, req, res, next) => …)` |
| Single terminal fallback | `app.onError((err, req, res) => …)` |
| Raise an error from a middleware | `next(err)` (non-null argument) |
| Custom 404 (no route matched) | `app.setNotFound((req, res) => …)` |
| API error → HTTP response | `throw { status, message }` / `throw { status, data }` |
| Inspect / reshape / escalate API errors | `service.onError(err, ctx, req)` |

**Resolution order:** `error()` chain → `onError()` fallback → bubble to parent → default `500`.

See also: [router.md](router.md) for sub-router mounting and `req.baseUrl`, and [api-builder.md](api-builder.md) for the full service pipeline.
