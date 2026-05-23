# `cors()` — Cross-Origin Resource Sharing

Adds CORS response headers and handles `OPTIONS` preflight requests. Supports wildcard origins, credentials, and custom preflight logic.

## Usage

```ts
import { createRouter, cors } from 'expediate';

const app = createRouter();

// Open CORS (wildcard — public API)
app.use(cors());

// Restricted origin
app.use(cors({
  origin: 'https://app.example.com',
  allowCredentials: true,
}));

// Multiple allowed origins
app.use(cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
}));
```

## Options

All options are optional (`Partial<CorsOptions>`):

| Option | Type | Default | Description |
|---|---|---|---|
| `origin` | `string \| string[]` | `'*'` | Value for `Access-Control-Allow-Origin`. Pass an array for multiple origins. |
| `allowHeaders` | `string \| string[]` | `'Accept, Content-Type, Authorization'` | Value for `Access-Control-Allow-Headers` (preflight only). |
| `allowMethods` | `string \| string[]` | `'GET,HEAD,PUT,PATCH,POST,DELETE'` | Value for `Access-Control-Allow-Methods` (preflight only). |
| `allowCredentials` | `boolean \| undefined` | `undefined` | When `true`, sets `Access-Control-Allow-Credentials: true`. Omit for non-credentialed requests. |
| `maxAge` | `number \| undefined` | `undefined` | Value for `Access-Control-Max-Age` (seconds). Tells the browser how long to cache the preflight result. |
| `vary` | `string \| string[] \| undefined` | `undefined` | Sets the `Vary` header on non-OPTIONS responses (useful when `origin` is dynamic). |
| `optionsStatus` | `number` | `204` | HTTP status code returned for successful preflight responses. |
| `preflight` | `((req) => boolean) \| undefined` | `undefined` | Custom gating function. Return `false` to block: OPTIONS → 403, others → 400. |

## Behaviour

CORS headers are only set when the request includes an `Origin` header. Requests without `Origin` (e.g. direct server-to-server calls) pass through unchanged.

For `OPTIONS` preflight requests the middleware responds immediately (without calling `next()`) and includes `Allow-Headers`, `Allow-Methods`, and optionally `Allow-Credentials` and `Max-Age`.

For all other methods, only `Access-Control-Allow-Origin` (and `Vary` if configured) is added to the response before `next()` is called.

## Important notes

- **Order matters**: register `cors()` before any authentication or routing middleware so that preflight requests from browsers are handled even for protected routes.
- Passing an **array** to `origin` sets the header to all values joined by `, `. To implement per-request dynamic origins, use a small wrapper middleware that calls `res.setHeader` and then delegates to `next()`.
- `allowCredentials: true` requires `origin` to be a specific domain, not `'*'`, to comply with the CORS specification.
