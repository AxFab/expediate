# `rateLimit()` — In-memory sliding-window rate limiter

Limits the number of requests a client can make within a rolling time window. Uses an in-memory `Map` of timestamp arrays — no external dependencies or infrastructure required. Responds with **429 Too Many Requests** when the limit is exceeded and optionally sets informational `X-RateLimit-*` headers.

## Usage

```ts
import { createRouter, rateLimit } from 'expediate';

const app = createRouter();

// Max 100 requests per minute per IP (global)
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// Stricter limit on login endpoint
app.post('/auth/login',
  rateLimit({ windowMs: 60_000, max: 5, message: 'Too many login attempts' }),
  loginHandler,
);
```

### Custom key function

```ts
// Rate-limit by API key header instead of IP
app.use(rateLimit({
  windowMs: 60_000,
  max: 1000,
  keyBy: (req) => req.headers['x-api-key'] as string ?? req.ip,
}));
```

## Signature

```ts
function rateLimit(opts: RateLimitOptions): Middleware
```

## Options

`windowMs` and `max` are required. All others are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | `number` | *(required)* | Duration of the sliding time window in milliseconds. |
| `max` | `number` | *(required)* | Maximum number of requests allowed per client key within `windowMs`. |
| `keyBy` | `(req) => string` | `(req) => req.ip` | Function that extracts the rate-limit bucket key from the request. |
| `message` | `string` | `'Too Many Requests'` | Plain-text body of the 429 response. |
| `statusCode` | `number` | `429` | HTTP status code returned when the limit is exceeded. |
| `headers` | `boolean` | `true` | When `true`, set `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on every response. |

## Response headers

When `headers: true` (the default), the following headers are added to every response (including non-limited ones):

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | The configured `max` value. |
| `X-RateLimit-Remaining` | Requests remaining in the current window. |
| `X-RateLimit-Reset` | Unix epoch (seconds) when the oldest request in the window expires. |

When the limit is exceeded, a `Retry-After` header is also set to `ceil(windowMs / 1000)` seconds.

## Important notes

- **In-memory only**: state is held in a `Map` within the process. It is lost on restart and is **not shared across multiple processes or server instances**. For clustered deployments, use a shared store (Redis, etc.) and implement your own middleware.
- **No automatic pruning**: expired entries are pruned per-key on each incoming request. If a key becomes completely idle, its map entry is overwritten on the next request from that key.
- The default `keyBy` uses `req.ip`. When the server is behind a proxy, enable `trustProxy: true` on `createRouter()` so that `req.ip` resolves to the real client IP from `X-Forwarded-For`, not the proxy address.

## Internal overview

Each call to `rateLimit()` creates a private `Map<string, number[]>` store. On every request:

1. `keyBy(req)` is called to obtain the bucket key.
2. The timestamp array for the key is pruned to remove entries older than `now - windowMs`.
3. The current timestamp is appended.
4. The `X-RateLimit-*` headers are set based on the updated array length.
5. If `count > max`, the middleware responds immediately with the configured status code, a `Retry-After` header, and the message body — `next()` is **not** called.
6. Otherwise, `next()` is called normally.
