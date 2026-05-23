# `csrf()` — CSRF protection middleware

Implements the **double-submit cookie pattern** to protect state-mutating routes from Cross-Site Request Forgery attacks. A random token is stored in a cookie and must be echoed in the `X-CSRF-Token` request header (or a parsed body field) for every `POST`, `PUT`, `PATCH`, and `DELETE` request.

## Usage

```ts
import { createRouter, csrf, json } from 'expediate';

const app = createRouter();

// Apply CSRF protection globally
app.use(csrf());

// Serve a form with the CSRF token embedded
app.get('/form', (req, res) => {
  const token = req.csrfToken!();
  res.send(`
    <form method="POST" action="/submit">
      <input type="hidden" name="_csrf" value="${token}">
      <button type="submit">Submit</button>
    </form>
  `);
});

// Body-field validation: requires a body parser to run first
app.use(json());
app.post('/submit', (req, res) => res.json({ ok: true }));
```

### With AJAX / single-page applications

```ts
// Client JavaScript reads the cookie value and sends it as a header:
// fetch('/api/data', { headers: { 'X-CSRF-Token': getCookie('_csrf') } })

app.use(csrf());
app.post('/api/data', (req, res) => res.json({ saved: true }));
```

### Custom cookie name and security settings

```ts
app.use(csrf({
  cookieName: 'XSRF-TOKEN',   // Angular default
  headerName: 'X-XSRF-TOKEN',
  secure: true,
  sameSite: 'Lax',
}));
```

## Signature

```ts
function csrf(opts?: CsrfOptions): Middleware
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `cookieName` | `string` | `'_csrf'` | Name of the cookie that stores the CSRF token. |
| `headerName` | `string` | `'x-csrf-token'` | Request header the client must send the token in (case-insensitive). |
| `fieldName` | `string` | `'_csrf'` | Parsed request-body field checked as a fallback when the header is absent. Requires a body-parsing middleware (`json()`, `parseBody()`, etc.) to run before `csrf()`. |
| `secure` | `boolean` | `false` | Mark the CSRF cookie as `Secure` (HTTPS-only). |
| `sameSite` | `'Strict' \| 'Lax' \| 'None'` | `'Strict'` | `SameSite` attribute of the CSRF cookie. |

## Fields set on `req`

| Field | Type | Description |
|---|---|---|
| `req.csrfToken` | `() => string` | Returns the current CSRF token for this request. Embed this value in forms or pass it to your client-side framework. |

## Safe methods

The following HTTP methods skip CSRF validation entirely because they are read-only and do not modify server state:

`GET`, `HEAD`, `OPTIONS`, `TRACE`

## Important notes

- **The cookie is not `HttpOnly`**: this is intentional. Browser JavaScript must be able to read the cookie value to include it in AJAX request headers. The security model relies on the fact that cross-origin scripts cannot read cookies from a different domain.
- **Body-field fallback requires a body parser**: if you want to support token submission via a hidden form field rather than a header, a body-parsing middleware (`json()`, `formData()`, `parseBody()`, etc.) must run before `csrf()` so that `req.body` is populated.
- **Register before route handlers**: `csrf()` must run before any state-mutating route so that invalid requests are rejected before business logic executes.
- **Cookie set only once per session**: the middleware reuses the existing token from the incoming cookie when present and only sets a new `Set-Cookie` header when it generates a fresh token.
- **403 on validation failure**: state-mutating requests with a missing or mismatched token receive `403 Forbidden: invalid CSRF token`.

## Internal overview

On every request the middleware reads the `_csrf` cookie (configurable) from `req.cookies`. If a valid token string is already present, it is reused; otherwise `crypto.randomBytes(32).toString('hex')` generates a new 64-character token and a `Set-Cookie` header is appended without overwriting other existing `Set-Cookie` entries.

`req.csrfToken` is set to a closure that returns the token string.

For unsafe methods, the middleware compares the submitted value — first the configured request header, then the configured body field — against the cookie token using a strict `===` comparison. A mismatch or missing submission results in an immediate 403 response.
