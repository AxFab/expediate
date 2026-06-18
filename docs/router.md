# Router

The core of Expediate is a zero-dependency HTTP router built on top of Node.js `http`/`https`. It supports named parameters, glob wildcards, regular expressions, nested sub-routers, signed cookies, per-request timeouts, and graceful shutdown.

---

## Creating a router

```ts
import { createRouter } from 'expediate';

const app = createRouter();
// or with options:
const app = createRouter({
  secret:     process.env.COOKIE_SECRET,   // for signed cookies
  timeout:    30_000,                       // ms; 0 = disabled
  trustProxy: true,                         // trust X-Forwarded-* headers
});
```

`createRouter()` returns a `Router` which is itself a middleware function (`router.listener`), so it can be nested inside any other router.

---

## Route registration

### HTTP method routes

```ts
router.get(path,    ...middleware)
router.post(path,   ...middleware)
router.put(path,    ...middleware)
router.delete(path, ...middleware)
router.patch(path,  ...middleware)
router.all(path,    ...middleware)   // matches any HTTP method
```

Method routes use **endpoint matching**: the pattern must match the entire path (up to an optional trailing slash). `get('/users')` matches `/users` and `/users/` but **not** `/users/42`.

### Prefix / mount routes

```ts
router.use(path, ...middleware)
```

`use()` uses **prefix matching**: the pattern is tested as a prefix, and the matched portion is **stripped from `req.path`** before the middleware is called. After the middleware calls `done()`, `req.path` is restored so sibling layers see the original path.

This makes `use()` the correct mount mechanism for sub-routers and global middleware.

### Middleware argument shapes

Each slot accepts a `Middleware` function, a `Router` instance, or an array of either:

```ts
app.get('/admin', authGuard, adminHandler);
app.get('/multi', [guard, logger], handler);
app.use('/api',   apiRouter);             // Router instance
app.use('/api',   apiRouter.listener);    // equivalent
```

---

## Path patterns

### Plain strings with `:param` segments

```ts
app.get('/users/:id',             handler);  // req.params.id
app.get('/orgs/:org/repos/:repo', handler);  // req.params.org, .repo
```

#### Inline regex constraints

Append a constraint in parentheses to restrict what a parameter segment matches. Only requests whose segment passes the constraint reach the handler — others fall through:

```ts
app.get('/items/:id(\\d+)',        handler);  // digits only
app.get('/files/:name([\\w-]+)',   handler);  // word chars + hyphens
app.get('/v:ver(\\d+)/api',       handler);  // literal suffix after constraint
```

Named capture groups inside constraints are not allowed (they conflict with the outer `(?<name>…)` wrapper).

### Glob patterns

```ts
app.use('/static/**', handler);  // any depth under /static/
app.get('/api/*',     handler);  // exactly one path segment
app.get('/**/*.php',  handler);  // PHP files anywhere
app.get('/v?/status', handler);  // one character wildcard
```

Glob rules: `?` → one non-slash character; `*` → any non-slash characters; `**` → any characters including slashes (cross-segment).

### Regular expressions

Named capture groups become `req.params` entries:

```ts
app.get(/^\/users\/(?<id>\d+)/, handler);
```

> **Restriction:** RegExp patterns with the `g` (global) or `y` (sticky) flag are **rejected at registration time** with a `TypeError`. These flags make `exec()` stateful, causing intermittent routing failures across requests.

---

## Request fields

The router augments every incoming request before any middleware runs. The augmentation is idempotent — safe across nested routers sharing the same request object.

| Field | Type | Description |
|---|---|---|
| `req.originalUrl` | `string` | Raw URL string, never modified |
| `req.path` | `string` | Pathname; rewritten by `use()` layers for sub-routers |
| `req.params` | `Record<string, string>` | Merged URL query params + named route params (flat, first-value for repeated keys) |
| `req.query` | `Record<string, string \| string[]>` | URL query parameters; repeated keys produce arrays. Alias for `req.queries.url` |
| `req.queries.url` | same as above | Structured query string bucket |
| `req.queries.route` | `Record<string, string>` | Named route parameters from the matched pattern |
| `req.cookies` | `Record<string, unknown>` | Parsed `Cookie` header. `j:` values are JSON-decoded; `s:` values are HMAC-verified (requires `secret`) |
| `req.ip` | `string` | Remote client IP. With `trustProxy: true`: first `X-Forwarded-For` value |
| `req.ips` | `string[]` | Full `X-Forwarded-For` chain (oldest first). Empty when `trustProxy` is disabled |
| `req.hostname` | `string` | `Host` header with port stripped. With `trustProxy: true`: taken from `X-Forwarded-Host` |
| `req.protocol` | `string` | `'http'` or `'https'`. With `trustProxy: true`: taken from `X-Forwarded-Proto` |
| `req.secure` | `boolean` | `true` when `req.protocol === 'https'` |
| `req.baseUrl` | `string` | Accumulated path prefix stripped by parent `use()` mounts. `''` at the root level |
| `req.json(opts?)` | `Promise<unknown\|null>` | Parse request body as JSON. Returns cached value if body already parsed |
| `req.text(opts?)` | `Promise<string\|null>` | Decode request body as plain text |
| `req.formData(opts?)` | `Promise<FormPart[]\|null>` | Parse request body as `multipart/form-data` |

### Cookies

Cookie values are decoded automatically:

- Plain strings are returned as-is.
- `j:<json>` prefixed values are JSON-parsed.
- `s:<sig>.<value>` prefixed values are HMAC-SHA256 verified; cookies that fail verification are silently dropped. Requires `secret` option on `createRouter()`.

---

## Response helpers

Every response is augmented with convenience methods. All chainable helpers return `this`.

```ts
res.send('Hello');                      // write string body and end
res.send();                             // end with no body
res.json({ ok: true });                 // set Content-Type: application/json and end
res.status(404).send('Not Found');      // set status code (validated 100–999)
res.status(201, { 'X-Id': '42' }).end(); // set status + headers
res.redirect('/new-path');              // 302 Found

res.type('text/csv').send(data);        // set Content-Type (chainable)
res.etag('v1').json(payload);           // weak ETag W/"v1" (chainable)
res.etag(sha256, true).send(buf);       // strong ETag "sha256"

res.cookie('session', 'abc', {
  maxAge:   3_600_000,                  // ms; also sets Expires
  path:     '/api',
  httpOnly: true,
  secure:   true,
  sameSite: 'Strict',
  signed:   true,                       // HMAC-sign (requires router secret)
});
res.clearCookie('session');             // Max-Age=0, Expires=epoch
res.clearCookie('tok', { path: '/admin' }); // match original options

res.download('/path/file.pdf');         // Content-Disposition: attachment
res.download('/path/file.pdf', 'invoice.pdf'); // custom filename
res.attachment('report.pdf').send(buf); // set disposition + Content-Type, no file I/O

res.append('X-Custom', 'v1');           // append to header (comma-joins; Set-Cookie accumulates)
res.vary('Accept');                     // add to Vary header, deduplicating
res.vary(['Accept', 'Accept-Encoding']);
res.location('/new-path');              // set Location header
res.sendStatus(200);                    // set status + send standard text body

res.locals['user'] = currentUser;       // request-scoped storage for middleware chains
```

### `res.status()` validation

The code must be an integer in the range `100–999`. Passing a non-integer or out-of-range value throws a `RangeError` at call time, which is caught by the router error handler.

### Cookies — writing

Setting a cookie with `signed: true` produces an `s:<hmac>.<value>` string. The router's `secret` is required. Objects are serialised with a `j:` prefix and JSON-decoded on read.

---

## Error handling

→ Full reference: [errors.md](errors.md)

Synchronous throws, async rejections, and `next(err)` calls all enter the router's **error channel**, which resolves through an ordered `error()` chain, an `onError()` fallback, and finally **bubbles to parent routers** before defaulting to `500`.

### Ordered error handlers (`error()`)

```ts
app.error((err, _req, res, next) => {
  if ((err as any)?.status === 404) return res.status(404).json({ error: 'Not Found' });
  next(err); // forward to the next handler, or bubble to the parent router
});

app.error((err, _req, res, _next) =>
  res.status((err as any)?.status ?? 500).json({ error: String(err) }));
```

The error value is the **first** argument. `next()` forwards the same error; `next(err)` replaces it. Handlers run in registration order until one ends the response.

### Single terminal fallback (`onError()`)

```ts
app.onError((err, _req, res) => {
  const status = (err as any)?.status ?? 500;
  res.status(status).json({ error: String(err) });
});
```

`onError()` is the simple, single catch-all. It runs after the `error()` chain is exhausted and, unlike `error()`, does **not** bubble — it is terminal for its router. Without any handler, the default sends `500` and logs to `console.warn`.

### Custom 404 handler

```ts
app.setNotFound((_req, res) => res.status(404).json({ error: 'Not Found' }));
```

### Passing errors through middleware

```ts
app.use('/protected', (req, _res, next) => {
  if (!req.headers.authorization) return next(new Error('Unauthorized'));
  next();
});
```

Calling `next(err)` skips remaining route layers and enters the error channel directly.

---

## Sub-routers and `req.baseUrl`

Routers are fully nestable. The matched prefix is stripped from `req.path` when mounted with `use()`:

```ts
const api = createRouter();
api.get('/users',     listUsers);
api.get('/users/:id', getUser);

const app = createRouter();
app.use('/api/v1', api);  // /api/v1/users → api sees req.path = '/users'
                          //                  req.baseUrl = '/api/v1'
```

`req.baseUrl` accumulates the stripped prefix as the request descends through nested `use()` mounts. It is `''` at the root level and is restored for sibling layers after a sub-router calls `done()`.

### Prefix router creation

```ts
const v1 = createRouter('/api/v1');  // implicitly strips this prefix
app.use(v1);
```

---

## Starting the server

`router.listen()` returns the underlying `http.Server` (or `https.Server`, or `http2.Http2SecureServer`) instance:

```ts
// Plain HTTP
const server = app.listen(3000, () => console.log('Ready'));

// HTTPS
app.listen(443, {
  key:  readFileSync('server.key'),
  cert: readFileSync('server.crt'),
});

// HTTP/2 (requires TLS)
app.listen(443, { key, cert, http2: true });

// Ephemeral port (useful in tests)
const server = app.listen(0, () => {
  const { port } = server.address() as AddressInfo;
  console.log(`Listening on :${port}`);
});
```

### Graceful shutdown

```ts
process.on('SIGTERM', () => app.shutdown(10_000)); // 10 s drain window
```

### Request timeout

```ts
const app = createRouter({ timeout: 30_000 }); // 408 after 30 s of no response
```

---

## Introspecting registered routes

```ts
console.log(app.routes());
// [{ method: 'GET', path: '/users', stripPath: false }, ...]
```

`method` is `null` for `use()` / `all()` layers. `stripPath: true` identifies `use()` layers.

---

## CookieOptions reference

| Option | Type | Default | Description |
|---|---|---|---|
| `signed` | `boolean` | `false` | HMAC-sign the value (requires router `secret`) |
| `expires` | `Date` | — | Expiry date |
| `maxAge` | `number` | — | Max age in **milliseconds** (also derives `Expires`) |
| `path` | `string` | `'/'` | Cookie path |
| `httpOnly` | `boolean` | `false` | Mark `HttpOnly` |
| `secure` | `boolean` | `false` | Mark `Secure` |
| `sameSite` | `'Strict'\|'Lax'\|'None'` | — | `SameSite` attribute |

---

## RouterOptions reference

| Option | Type | Default | Description |
|---|---|---|---|
| `secret` | `string` | — | Cookie-signing secret. Required for signed cookies |
| `timeout` | `number` | `0` (disabled) | Request timeout in milliseconds |
| `trustProxy` | `boolean` | `false` | Trust `X-Forwarded-*` headers |
