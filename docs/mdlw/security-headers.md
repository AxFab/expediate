# `securityHeaders()` — Security-hardening response headers

Sets a baseline of HTTP response headers that reduce the attack surface for common web vulnerabilities including clickjacking, MIME-type sniffing, and protocol downgrade attacks. Every header can be individually disabled or overridden.

## Usage

```ts
import { createRouter, securityHeaders } from 'expediate';

const app = createRouter();

// Apply all defaults — register once at the top
app.use(securityHeaders());

// Disable HSTS on a local HTTP development server
app.use(securityHeaders({ hsts: false }));

// Deny all framing (stricter than the SAMEORIGIN default)
app.use(securityHeaders({ frameOptions: 'DENY' }));

// Custom Permissions-Policy
app.use(securityHeaders({
  permissionsPolicy: 'geolocation=(), payment=(self)',
}));
```

## Signature

```ts
function securityHeaders(opts?: SecurityHeadersOptions): Middleware
```

## Default headers

| Header | Default value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` | Force HTTPS for 180 days, including sub-domains. |
| `X-Frame-Options` | `SAMEORIGIN` | Prevent clickjacking by restricting framing to same origin. |
| `X-Content-Type-Options` | `nosniff` | Prevent browsers from MIME-sniffing the content type. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer information sent to cross-origin requests. |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=()` | Disable geolocation, microphone, and camera access for the page. |
| `X-XSS-Protection` | `0` | Disable the legacy IE XSS filter (it can introduce vulnerabilities in modern browsers). |

## Options

Pass `false` to omit a header entirely. Pass an object or string to override the value.

### `hsts`

```ts
hsts?: false | {
  maxAge?: number;            // default: 15_552_000 (180 days)
  includeSubDomains?: boolean; // default: true
  preload?: boolean;           // default: false
}
```

Pass `false` to omit `Strict-Transport-Security` entirely (recommended for plain HTTP servers).

### `frameOptions`

```ts
frameOptions?: false | 'DENY' | 'SAMEORIGIN'   // default: 'SAMEORIGIN'
```

### `contentTypeOptions`

```ts
contentTypeOptions?: boolean   // default: true (sets 'nosniff')
```

### `referrerPolicy`

```ts
referrerPolicy?: false | string   // default: 'strict-origin-when-cross-origin'
```

Pass any valid [Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy) value as a string.

### `permissionsPolicy`

```ts
permissionsPolicy?: false | string   // default: 'geolocation=(), microphone=(), camera=()'
```

Pass any valid [Permissions-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy) directive string.

### `xssProtection`

```ts
xssProtection?: false | string   // default: '0'
```

The default value of `'0'` disables the legacy IE XSS filter, which is the recommended modern setting. Pass `false` to omit the header entirely.

## Important notes

- **Register at the top of the middleware stack** so that security headers are applied to every response, including error responses from route handlers registered below.
- **HSTS and plain HTTP**: if your server operates without TLS (development, behind an HTTPS-terminating load balancer that does not forward TLS headers), set `hsts: false` to avoid telling browsers to always use HTTPS for a domain that does not yet support it.
- **`Content-Security-Policy` is not included** in this middleware. CSP policies are highly application-specific; use `res.setHeader('Content-Security-Policy', '...')` or a dedicated middleware to add them.
- **HSTS preload**: to apply for [HSTS preloading](https://hstspreload.org/), set `hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true }` and ensure your site fully supports HTTPS before submitting.

## Internal overview

All header name/value pairs are computed once at middleware-creation time and stored as a `[string, string][]` array. On each request the middleware iterates the array and calls `res.setHeader(name, value)` for each entry, then calls `next()`. No per-request computation is performed.
