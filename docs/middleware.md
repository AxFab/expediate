# Middleware

Expediate ships a suite of production-ready middleware. All factories return standard `(req, res, next)` functions and can be mounted globally or scoped to specific paths.

---

## `compress()`

Transparent response compression. Must be mounted **before** any middleware that writes response bodies.

Algorithm priority (based on `Accept-Encoding`): Brotli > gzip > deflate.

```ts
import { compress } from 'expediate';

app.use(compress());
app.use(compress({ threshold: 512, brotliQuality: 6 }));
```

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | `number` | `1024` | Minimum response size in bytes before compression is applied |
| `br` | `boolean` | `true` | Enable Brotli compression |
| `brotliQuality` | `number` | `4` | Brotli quality level (0–11) |
| `gzipLevel` | `number` | Node default | gzip/deflate compression level (1–9) |
| `filter` | `(req, res) => boolean` | — | Custom predicate; return `false` to skip compression for a response |

The middleware removes `Content-Length` (size changes after compression) and sets `Content-Encoding` and `Vary: Accept-Encoding`.

---

## `conditionalGet()`

Handles `If-None-Match` and `If-Modified-Since` headers (RFC 7232). When the client's cached response is still fresh, sends `304 Not Modified` with no body instead of the full response.

```ts
import { conditionalGet } from 'expediate';

app.get('/users/:id', conditionalGet(), (req, res) => {
  const user = getUser(req.params.id);
  res.etag(user.updatedAt.toISOString());
  res.json(user);  // → 304 when the client is up to date
});
```

Freshness checks follow RFC 7232 priority: `If-None-Match` (weak comparison, `*` wildcard supported) first, then `If-Modified-Since`. Only GET and HEAD are eligible — other methods pass through unchanged.

A `304` response strips `Content-Type`, `Content-Length`, and `Content-Encoding` but retains `ETag`, `Cache-Control`, `Vary`, and `Last-Modified`.

---

## `cacheControl()`

Sets `Cache-Control`, `Expires`, and `Vary` response headers.

```ts
import { cacheControl } from 'expediate';

app.use('/api',    cacheControl({ noStore: true }));
app.use('/assets', cacheControl({ maxAge: 31_536_000, immutable: true }));
```

| Option | Type | Description |
|---|---|---|
| `maxAge` | `number` | `max-age=<seconds>`. Also sets `Expires` |
| `sMaxAge` | `number` | `s-maxage=<seconds>` for CDN/shared caches |
| `public` | `boolean` | `public` directive |
| `private` | `boolean` | `private` directive |
| `noStore` | `boolean` | `no-store` — disables all caching |
| `noCache` | `boolean` | `no-cache` — requires revalidation |
| `mustRevalidate` | `boolean` | `must-revalidate` |
| `immutable` | `boolean` | `immutable` — response body will never change within `max-age` |
| `vary` | `string \| string[]` | Sets the `Vary` header |

---

## `requestId()`

Attaches a unique ID to every request and echoes it in the response header.

```ts
import { requestId } from 'expediate';

app.use(requestId());

app.get('/health', (req, res) => {
  res.json({ id: req.id, status: 'ok' });
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | `string` | `'x-request-id'` | Header name to read and echo |
| `allowFromHeader` | `boolean` | `true` | Reuse client-supplied ID. Set `false` to always generate a new one |
| `generator` | `() => string` | `crypto.randomUUID` | Custom ID generator |

The ID is exposed as `req.id` on the augmented request object.

---

## `rateLimit()`

In-memory sliding-window rate limiting. State is per-process and lost on restart.

```ts
import { rateLimit } from 'expediate';

// 100 requests per minute per IP (global)
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// Tighter limit on authentication endpoints
app.post('/auth/login', rateLimit({ windowMs: 60_000, max: 5 }), loginHandler);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | `number` | **required** | Sliding window duration in milliseconds |
| `max` | `number` | **required** | Max requests per key within the window |
| `keyBy` | `(req) => string` | `req.ip` | Function to extract the rate-limit key |
| `message` | `string` | `'Too Many Requests'` | Response body when limit is exceeded |
| `statusCode` | `number` | `429` | HTTP status when limit is exceeded |
| `headers` | `boolean` | `true` | Set `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` |

> Not suitable for multi-process deployments without a shared external store.

---

## `csrf()`

CSRF protection via the double-submit cookie pattern. Safe methods (GET, HEAD, OPTIONS, TRACE) are exempted. State-mutating methods must supply the token in the `X-CSRF-Token` header or `_csrf` body field.

```ts
import { csrf } from 'expediate';

app.use(csrf());

// Expose the token to client-side JavaScript
app.get('/form', (req, res) =>
  res.send(`<input type="hidden" name="_csrf" value="${req.csrfToken!()}">`));
// POST /form — token validated automatically
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cookieName` | `string` | `'_csrf'` | Cookie storing the token |
| `headerName` | `string` | `'x-csrf-token'` | Request header carrying the token |
| `fieldName` | `string` | `'_csrf'` | Parsed body field (fallback when header is absent) |
| `secure` | `boolean` | `false` | Mark the CSRF cookie as `Secure` |
| `sameSite` | `'Strict'\|'Lax'\|'None'` | `'Strict'` | `SameSite` attribute of the cookie |

The cookie is **not** `HttpOnly` — client JavaScript must be able to read it to include it in requests.

---

## `securityHeaders()`

Sets a hardened baseline of HTTP security response headers.

```ts
import { securityHeaders } from 'expediate';

app.use(securityHeaders());

// Disable HSTS for plain-HTTP development servers
app.use(securityHeaders({ hsts: false }));
```

| Header | Default value |
|---|---|
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=()` |
| `X-XSS-Protection` | `0` |

Pass `false` to disable a header, or a string to override it:

```ts
app.use(securityHeaders({
  hsts: false,
  frameOptions: 'DENY',
  permissionsPolicy: "geolocation=(self 'https://maps.example.com')",
}));
```

---

## `cors()`

Adds Cross-Origin Resource Sharing headers. Headers are only set when the request includes an `Origin` header (browser-only). `OPTIONS` preflight requests are handled and terminated — `next()` is not called for preflights.

```ts
import { cors } from 'expediate';

app.use(cors({ origin: 'https://example.com' }));

app.use(cors({
  origin:           ['https://app.example.com', 'https://admin.example.com'],
  allowCredentials: true,
  maxAge:           86400,
}));
```

When `origin` is an array, the middleware compares the request `Origin` against the list and echoes the matching origin (or omits the header if no match). `Vary: Origin` is added automatically when origin matching is dynamic.

| Option | Type | Default | Description |
|---|---|---|---|
| `origin` | `string \| string[]` | `'*'` | Allowed origin(s). Array triggers request-origin matching |
| `allowHeaders` | `string \| string[]` | `'Accept, Content-Type, Authorization'` | `Access-Control-Allow-Headers` value |
| `allowMethods` | `string \| string[]` | `'GET,HEAD,PUT,PATCH,POST,DELETE'` | `Access-Control-Allow-Methods` value |
| `allowCredentials` | `boolean` | — | Set `Access-Control-Allow-Credentials: true` |
| `maxAge` | `number` | — | Preflight cache lifetime in seconds |
| `vary` | `string \| string[]` | — | Additional `Vary` header value |
| `optionsStatus` | `number` | `204` | Status code for OPTIONS preflight responses |
| `preflight` | `(req) => boolean` | — | Custom guard; return `false` to reject (OPTIONS → 403, others → 400) |

---

## `logger()`

Logs one line per completed request. Integrated with the request lifecycle — the timer starts when the request arrives and fires when the response finishes.

```ts
import { logger } from 'expediate';

app.use(logger({
  user:   (req) => (req as any).user?.username ?? '-',
  locale: 'en-US',
  logger: (msg) => process.stderr.write(msg + '\n'),
}));
```

Default output format (ANSI-coloured by status class):

```
21 Mar, 14:32  200  GET  /api/users  127.0.0.1  alice  4 ms  (1234)
```

With `json: true`, the logger calls the `logger` function with a structured object instead of a string:

```ts
{
  timestamp: '2024-03-21T14:32:00.000Z',
  status:    200,
  method:    'GET',
  path:      '/api/users',
  ip:        '127.0.0.1',
  user:      'alice',
  elapsed:   4,
  host:      'localhost:3000',
  length:    256,
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `track` | `boolean` | `false` | Emit a `LOST` warning for requests that never complete |
| `trackTimeout` | `number` | `30000` | Milliseconds before emitting the LOST warning |
| `user` | `(req) => string` | `() => '-'` | Extract a user identity from the request |
| `locale` | `string` | `'en-GB'` | BCP 47 locale for the timestamp |
| `dateFormat` | `Intl.DateTimeFormatOptions` | short date+time | Timestamp format options |
| `json` | `boolean` | `false` | Log structured objects instead of formatted strings |
| `logger` | `(msg: string \| object) => void` | `console.log` | Custom logging sink |
