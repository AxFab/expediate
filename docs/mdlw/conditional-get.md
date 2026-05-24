# `conditionalGet()` — Conditional GET / 304 Not Modified middleware

Transparently handles `If-None-Match` and `If-Modified-Since` request headers (RFC 7232). When the response carries an `ETag` or `Last-Modified` header and the client's cached copy is still fresh, the middleware short-circuits with **304 Not Modified** — stripping the response body and content-related headers — instead of sending the full response.

Route handlers call `res.etag()`, `res.json()`, `res.send()`, etc. as usual. The middleware intercepts the outgoing writes invisibly and decides whether to replace the response with a 304.

## Usage

```ts
import { createRouter, conditionalGet, json } from 'expediate';

const app = createRouter();

// ETag-based conditional GET
app.get('/api/user/:id', conditionalGet(), (req, res) => {
  const user = getUser(req.params.id);
  res.etag(user.updatedAt.toISOString()); // set ETag before sending
  res.json(user);                          // → 304 if client's copy is current
});

// Last-Modified-based conditional GET
app.get('/report', conditionalGet(), (_req, res) => {
  const report = generateReport();
  res.setHeader('Last-Modified', report.generatedAt.toUTCString());
  res.json(report);
});

// Chain res.etag() for brevity
app.get('/items', conditionalGet(), (_req, res) => {
  res.etag('v42').json(items);
});
```

## Signature

```ts
function conditionalGet(): Middleware
```

## `res.etag(value, strong?)` helper

`conditionalGet()` works alongside the `res.etag()` helper that is available on every response object:

```ts
function etag(value: string, strong?: boolean): this
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `value` | `string` | — | Opaque ETag value, without quotes or `W/` prefix. |
| `strong` | `boolean` | `false` | When `true`, produces a strong ETag (`"value"`). When `false` (default), produces a weak ETag (`W/"value"`). |

Returns `this` for chaining.

```ts
// Weak ETag (default) — appropriate for most dynamic responses
res.etag('2024-06-01T12:00:00Z').json(data);

// Strong ETag — use when the body is content-addressed (e.g. SHA-256 hash)
res.etag(sha256Hex, true).send(fileContent);
```

**Weak vs strong ETags:**
- A **weak** ETag (`W/"value"`) indicates that two representations are semantically equivalent but not necessarily byte-for-byte identical. This is the correct choice for dynamic JSON responses where whitespace or field order may vary.
- A **strong** ETag (`"value"`) asserts byte-level identity and is required when byte-range requests must be validated (e.g. resumable downloads).

## Freshness rules (RFC 7232)

The middleware evaluates freshness in strict priority order:

1. **`If-None-Match`** — compared against the `ETag` response header using **weak comparison** (the `W/` prefix is stripped from both sides before matching). The special value `*` matches any ETag.
2. **`If-Modified-Since`** — only consulted when `If-None-Match` is absent. The response is considered fresh when `Last-Modified ≤ If-Modified-Since`.

When neither condition applies (no `ETag`, no `Last-Modified`, no matching request headers), the full response is sent.

## 304 response headers

Per RFC 7232 §4.1, a 304 response **must not** include a message body. The middleware strips the following headers when sending 304:

| Stripped | Retained |
|---|---|
| `Content-Type` | `ETag` |
| `Content-Length` | `Cache-Control` |
| `Content-Encoding` | `Vary` |
| | `Last-Modified` |

## Important notes

- **Mount before the handler.** `conditionalGet()` must be registered before the route handler it protects, not after. The middleware intercepts the response writes made by the handler.
- **Only GET and HEAD are eligible for 304.** POST, PUT, PATCH, and DELETE requests are passed through unchanged, even when `If-None-Match` is present.
- **The handler always runs.** Even when the response will be 304, the route handler executes normally — computing the ETag and calling `res.json()` as usual. The body is buffered and then discarded if freshness is confirmed. This keeps handler code simple but means expensive work (e.g. a database query) is not skipped. If avoiding that work is important, read `req.headers['if-none-match']` explicitly and return early.
- **Pair with `cacheControl()`.** `conditionalGet()` handles the revalidation side of caching; `cacheControl()` handles the initial `Cache-Control` and `Expires` headers. Use both together for a complete caching strategy.
- **No automatic ETag generation.** The middleware does not hash the response body. You are responsible for computing a meaningful ETag value — typically a version identifier, hash, or last-modified timestamp.

## Combining with `cacheControl()`

```ts
import { createRouter, conditionalGet, cacheControl } from 'expediate';

const app = createRouter();

app.get('/api/products', 
  cacheControl({ maxAge: 60, public: true }), // tell caches to store for 60 s
  conditionalGet(),                            // handle revalidation requests
  (_req, res) => {
    const products = getProducts();
    res.etag(products.version);
    res.json(products);
  },
);
```

## Internal overview

When mounted, `conditionalGet()` overrides `res.write` and `res.end` on the response object. All body data written by downstream handlers is buffered in memory. When `res.end()` is called, the middleware reads the `ETag` and `Last-Modified` headers that were set by the handler, evaluates freshness against the incoming request headers, and either flushes the buffered body (normal response) or discards it and sends a bare 304. The overrides are applied per-request and have no effect on subsequent requests.
