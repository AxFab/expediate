# `cacheControl()` — Response caching header middleware

Sets `Cache-Control`, `Expires`, and `Vary` response headers based on the supplied options. Mount globally for a site-wide caching policy or on individual routes to override it per endpoint.

## Usage

```ts
import { createRouter, cacheControl, serveStatic } from 'expediate';

const app = createRouter();

// Global default: 5-minute browser cache for public API responses
app.use(cacheControl({ maxAge: 300, public: true }));

// No caching for authenticated API routes
app.use('/api', cacheControl({ noStore: true }));

// Cache-forever for fingerprinted static assets
app.get('/static/:hash.js',
  cacheControl({ maxAge: 31_536_000, immutable: true }),
  serveStatic('public'),
);
```

## Signature

```ts
function cacheControl(opts?: CacheControlOptions): Middleware
```

## Options

All options are optional. Only the directives you specify are included in the `Cache-Control` header.

| Option | Type | Description |
|---|---|---|
| `maxAge` | `number` | Sets `max-age=<seconds>`. Also sets the `Expires` header to `Date.now() + maxAge * 1000`. |
| `sMaxAge` | `number` | Sets `s-maxage=<seconds>`. Overrides `max-age` for shared caches (CDNs). |
| `private` | `boolean` | Adds the `private` directive — only the end-user's browser may cache the response. |
| `public` | `boolean` | Adds the `public` directive — any cache, including shared CDN caches, may store the response. |
| `noStore` | `boolean` | Adds `no-store` — the response must not be stored in any cache. |
| `noCache` | `boolean` | Adds `no-cache` — caches must revalidate with the origin before serving a stored response. |
| `mustRevalidate` | `boolean` | Adds `must-revalidate` — stale responses may not be served; the cache must revalidate. |
| `immutable` | `boolean` | Adds `immutable` — signals that the response body will never change during its `max-age` window. Ideal for content-addressed assets. |
| `vary` | `string \| string[]` | Sets the `Vary` header for correct cache keying on negotiated content. |

## Important notes

- Calling `cacheControl()` with no options sets no headers and calls `next()` immediately — it is a no-op until at least one option is provided.
- `private` and `public` are mutually exclusive per the HTTP specification. Setting both will include both directives in the header — the browser will interpret `private` as taking precedence, but this is a configuration error.
- `noStore` and `noCache` have different semantics: `no-store` prohibits caching entirely, while `no-cache` permits caching but requires revalidation before serving a stored response.
- `Expires` is only set when `maxAge` is provided (not when only `sMaxAge` is set), because `Expires` is a client-side concept and CDN shared caches use `s-maxage` instead.

## Internal overview

All `Cache-Control` directive strings are pre-computed once at middleware-creation time and stored in a `const cacheControlValue` string. The `Vary` header value is similarly pre-joined. On each request, the middleware sets the pre-computed headers and always calls `next()`. This avoids redundant string allocation per request.
