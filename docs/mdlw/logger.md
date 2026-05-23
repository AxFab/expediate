# `logger()` — HTTP request logger

Logs one line per request on response finish, including method, path, status code, client IP, response time, and content length.

## Usage

```ts
import { createRouter, logger } from 'expediate';

const app = createRouter();

// Default: human-readable coloured output to console.log
app.use(logger());

// Custom options
app.use(logger({
  user: (req) => (req as any).authUser ?? '-',
  track: true,
  trackTimeout: 10_000,
}));

// Structured JSON logging (for log aggregators)
app.use(logger({
  json: true,
  logger: (obj) => process.stdout.write(JSON.stringify(obj) + '\n'),
}));
```

## Options

All options are optional (`Partial<LoggerOptions>`):

| Option | Type | Default | Description |
|---|---|---|---|
| `track` | `boolean` | `false` | Enable lost-request tracking. Logs a `LOST` warning if a response is not finished within `trackTimeout` ms. |
| `trackTimeout` | `number` | `30000` | Milliseconds before an in-flight request is considered lost. Requires `track: true`. |
| `user` | `(req) => string` | `() => '-'` | Extract a user identity string from the request for inclusion in the log line. |
| `locale` | `string` | `'en-GB'` | BCP 47 locale tag for timestamp formatting (`Intl.DateTimeFormat`). |
| `dateFormat` | `Intl.DateTimeFormatOptions` | `{ month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }` | Date/time format options. |
| `json` | `boolean` | `false` | Emit structured JSON objects instead of formatted strings. |
| `logger` | `(msg: string \| object) => void` | `console.log` | Custom sink function. Receives the formatted string or structured object. |

## Log format

**Default text output (ANSI coloured):**

```
23 May, 14:32 200 GET /api/users 203.0.113.5 <alice> 12ms (1.2kb)
```

Fields: `timestamp  STATUS  METHOD  path  ip  <user>  elapsed  (content-length)`

Status is coloured green (2xx), yellow (3xx/4xx), or red (5xx).

**JSON output (`json: true`):**

```json
{
  "timestamp": "2024-05-23T14:32:00.000Z",
  "status": 200,
  "method": "GET",
  "path": "/api/users",
  "ip": "203.0.113.5",
  "user": "alice",
  "elapsed": 12,
  "host": "example.com",
  "length": 1234
}
```

**Lost-request warning (when `track: true`):**

```
23 May, 14:32 LOST GET /api/slow 203.0.113.5 <alice>
```

## Important notes

- `logger()` must be placed **before** route handlers so it can attach a `response.finish` listener before the response is sent.
- `req.ip` is used for the client address. When the server sits behind a proxy, enable `trustProxy: true` on the router to resolve the real client IP from `X-Forwarded-For`.
- `track: true` keeps one `setTimeout` alive per open request. Use only in development or low-traffic environments.
- The timestamp and path are captured at request-arrival time so path mutations from prefix-stripping (`use()`) do not affect the logged value.

## Internal overview

1. On each request, the logger immediately captures the current timestamp, `req.path`, and `req.ip`.
2. It attaches a `response.finish` listener that fires when `res.end()` is called.
3. Elapsed time is computed as `Date.now() - arrivedAt`.
4. If `track` is enabled, a `setTimeout(trackTimeout)` is also started. It is cleared in the `finish` listener if the response arrives in time; otherwise the LOST line is emitted.
