# `requestId()` — Request ID middleware

Attaches a unique identifier to every request as `req.id` and echoes it back in a response header. The ID is taken from the incoming request header (when trusted) or generated with `crypto.randomUUID()`. Use it in log statements and error responses to correlate distributed traces back to a single originating request.

## Usage

```ts
import { createRouter, requestId, logger } from 'expediate';

const app = createRouter();

// Default: reads X-Request-ID from incoming header or generates a UUID
app.use(requestId());
app.use(logger());

app.get('/health', (req, res) => {
  res.json({ id: req.id, status: 'ok' });
});
```

### Hardened configuration

```ts
// Never trust client-supplied IDs — always generate server-side
app.use(requestId({ allowFromHeader: false }));

// Custom header name and generator
app.use(requestId({
  header: 'x-correlation-id',
  generator: () => `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}));
```

## Signature

```ts
function requestId(opts?: RequestIdOptions): Middleware
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | `string` | `'x-request-id'` | HTTP header name used to read the incoming ID and to echo it in the response. Case-insensitive (lowercased internally). |
| `allowFromHeader` | `boolean` | `true` | When `true`, reuse the ID supplied by the client. Set to `false` in security-sensitive environments to always generate a fresh ID. |
| `generator` | `() => string` | `crypto.randomUUID` | Custom ID generator. Must return a unique string on every call. |

## Fields set on `req`

| Field | Type | Description |
|---|---|---|
| `req.id` | `string` | The unique identifier for this request. |

## Important notes

- **Register before `logger()`** so that log lines can include `req.id`.
- When `allowFromHeader: true` (the default), clients can supply their own ID by sending `X-Request-ID: <value>`. This is useful for end-to-end tracing across services but should be disabled when untrusted clients must not influence the ID.
- The response always echoes the resolved ID in the same header that was configured (default: `X-Request-ID`), whether it was client-supplied or server-generated.

## Internal overview

On each request the middleware reads the configured header from `req.headers`. If `allowFromHeader` is `true` and a non-empty value is present, that value becomes the ID; otherwise `generator()` is called. The ID is assigned to `req.id` and written to the response via `res.setHeader`. The middleware always calls `next()`.
