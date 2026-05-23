# `createJwtPlugin()` — JWT authentication plugin

A self-contained JWT authentication plugin providing login, token refresh, logout, and route protection middleware. Issues short-lived access tokens (HS256/HS384/HS512 JWTs) and long-lived opaque refresh tokens with automatic rotation. No external dependencies — all cryptography uses Node.js built-in `crypto`.

## Usage

```ts
import { createRouter, json, createJwtPlugin } from 'expediate';

const app = createRouter();
const auth = createJwtPlugin({
  accessTokenSecret: process.env.JWT_SECRET!,
});

// Auth endpoints
app.post('/auth/login',   json(), auth.login);
app.post('/auth/refresh', json(), auth.refresh);
app.post('/auth/logout',  json(), auth.logout);

// Protected routes
app.get('/me',     auth.authenticate, auth.authorize, getProfile);
app.delete('/admin', ...auth.requireRole('admin'), deleteHandler);
app.put('/posts',  ...auth.requirePermission('write'), updatePost);
```

## Signature

```ts
function createJwtPlugin(userConfig?: Partial<JwtConfig>): JwtPlugin
```

## Configuration (`JwtConfig`)

All fields have development-safe defaults. At minimum set `accessTokenSecret` to a secure random value in production.

| Field | Type | Default | Description |
|---|---|---|---|
| `accessTokenSecret` | `string` | `'access-secret-change-in-production'` | HMAC secret used to sign access tokens. |
| `refreshTokenSecret` | `string` | `'refresh-secret-change-in-production'` | Reserved for future use (refresh tokens are currently opaque strings, not JWTs). |
| `accessTokenExpiry` | `number` | `900` (15 min) | Access token lifetime in **seconds**. |
| `refreshTokenExpiry` | `number` | `604800` (7 days) | Refresh token lifetime in **seconds**. |
| `issuer` | `string` | `'jwt-auth'` | Value placed in the JWT `iss` claim. |
| `checkIssuer` | `boolean` | `false` | When `true`, `authenticate` rejects tokens whose `iss` claim doesn't match `issuer`. |
| `alg` | `'HS256' \| 'HS384' \| 'HS512'` | `'HS256'` | JWT signing algorithm. |
| `fetchUser` | `(username) => UserRecord \| undefined` | Built-in `userDatabase` | Look up a user record by username. |
| `isPasswordValid` | `(user, password) => boolean` | SHA-256 comparison | Validate a plain-text password against a user record. |
| `payload` | `(user) => Partial<TokenPayload>` | Copies `sub`, `username`, `roles`, `permissions` | Build the JWT payload for a user. `iss`, `iat`, `exp` are added automatically. |
| `refreshTokenStore` | `TokenStore` | In-process `Map` | Store for active refresh tokens. Replace with a Redis adapter for multi-instance deployments. |
| `username` | `(user) => string` | `(user) => user.username` | Extract the login username from a user record. |

## Route handlers

Mount these handlers with a body-parsing middleware (`json()`) registered first:

### `auth.login` — `POST /auth/login`

Expects: `{ username: string, password: string }`

Success (200):
```json
{
  "message": "Authentication successful",
  "accessToken": "<jwt>",
  "refreshToken": "<opaque-hex>",
  "expiresIn": 900,
  "tokenType": "Bearer"
}
```

Failure: 400 (missing fields) or 401 (wrong credentials).

### `auth.refresh` — `POST /auth/refresh`

Expects: `{ username: string, refreshToken: string }`

On success, the old refresh token is **immediately invalidated** (rotation) and a fresh pair is issued. Success response matches `login`.

Failure: 400 (missing fields) or 401 (invalid/expired/unknown token).

### `auth.logout` — `POST /auth/logout`

Expects: `{ refreshToken?: string }` (optional)

Always responds 200. Revokes the refresh token when provided. Revoking an already-revoked token is a no-op.

## Middleware

### `auth.authenticate`

Validates the `Authorization: Bearer <token>` header and populates `req.user` with the decoded `TokenPayload` on success. **Non-blocking**: always calls `next()` even when the token is missing or invalid — authentication failure does not by itself reject the request. Use `auth.authorize` after this to enforce login.

At the start of each call `req.user` is explicitly cleared to prevent stale data from leaking across requests.

### `auth.authorize`

Rejects unauthenticated requests with **401** `{ error: 'Authentication required' }`. Place after `auth.authenticate`:

```ts
app.get('/me', auth.authenticate, auth.authorize, handler);
```

### `auth.requireRole(...roles)`

Returns `[authenticate, roleCheck]` — spread it into the route:

```ts
app.delete('/admin', ...auth.requireRole('admin'), handler);
```

The user must have **at least one** of the specified roles. Responds 401 when unauthenticated, 403 when the role is missing.

### `auth.requirePermission(...permissions)`

Returns `[authenticate, permCheck]`:

```ts
app.put('/posts', ...auth.requirePermission('write'), handler);
```

The user must have **all** of the specified permissions. Responds 401 when unauthenticated, 403 when any permission is missing.

## Default user database

For development and testing, a built-in `userDatabase` (`Map<string, UserRecord>`) contains three demo accounts:

| Username | Password | Roles | Permissions |
|---|---|---|---|
| `alice` | `password123` | `admin`, `editor` | `read`, `write`, `delete`, `manage_users` |
| `bob` | `secret456` | `editor` | `read`, `write` |
| `charlie` | `pass789` | `viewer` | `read` |

Replace the database by providing a custom `fetchUser` function in config.

## `TokenPayload` (decoded `req.user`)

```ts
interface TokenPayload {
  sub:          string;    // user ID or username
  username:     string;
  iss:          string;    // issuer
  iat:          number;    // issued-at (Unix seconds)
  exp:          number;    // expiration (Unix seconds)
  roles?:       string[];
  permissions?: string[];
  [key: string]: unknown;  // custom claims from config.payload()
}
```

## Important notes

- **SHA-256 password hashing is not production-safe.** Replace `isPasswordValid` with a bcrypt or argon2 check before going live.
- **Default secrets must be changed.** The built-in secrets (`'access-secret-change-in-production'`, etc.) are public and provide no security.
- **Refresh token storage is in-process.** The default `Map` is lost on restart and not shared across server instances. Provide a `refreshTokenStore` backed by Redis or a database for production.
- **Refresh token rotation**: every call to `auth.refresh` invalidates the presented token before issuing a new pair. A stolen refresh token can only be used once.
- **`authenticate` never rejects**: this is intentional. It allows optional authentication patterns where some fields are public and others are private within the same handler.
- **RS*, ES*, PS* algorithms are not supported.** Only `HS256`, `HS384`, and `HS512` are implemented.

## Internal overview

`createJwtPlugin()` merges `userConfig` over `DEFAULT_CONFIG` into a single `config` object. All handlers and middleware close over this config.

JWT operations are fully manual: Base64URL encoding/decoding via `Buffer`, HMAC signing via `crypto.createHmac()`, and timing-safe signature comparison via `crypto.timingSafeEqual()`. Refresh tokens are 64 random bytes encoded as 128-character hex strings.

`authenticate` parses the `Authorization` header, calls `verifyToken()` (which checks structure, algorithm, signature, and expiry), and assigns the decoded payload to `req.user`. `authorize`, `requireRole`, and `requirePermission` read `req.user` to make their access decisions.
