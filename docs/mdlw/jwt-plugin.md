# `createJwtPlugin()` — JWT authentication plugin

A self-contained JWT authentication plugin providing login, token refresh, logout, and route protection middleware. Issues short-lived access tokens and signed JWT refresh tokens with JTI-based rotation and revocation. No external dependencies — all cryptography uses Node.js built-in `crypto`.

Supports **symmetric** (HS256 / HS384 / HS512) and **asymmetric** (RS256 / RS384 / RS512 / ES256 / ES384 / ES512) signing algorithms. Refresh tokens are only active when a `refreshTokenStore` is explicitly provided.

## Usage

```ts
import { createRouter, json, createJwtPlugin, createMapTokenStore } from 'expediate';

const app  = createRouter();
const auth = createJwtPlugin({
  accessTokenSecret:  process.env.JWT_ACCESS_SECRET!,
  refreshTokenSecret: process.env.JWT_REFRESH_SECRET!,
  refreshTokenStore:  createMapTokenStore(),
});

app.post('/auth/login',   json(), auth.login);
app.post('/auth/refresh', json(), auth.refresh);
app.post('/auth/logout',  json(), auth.logout);

app.get('/me',       auth.authenticate, auth.authorize, getProfile);
app.delete('/admin', ...auth.requireRole('admin'), deleteHandler);
app.put('/posts',    ...auth.requirePermission('write'), updatePost);
```

## Signatures

```ts
function createJwtPlugin(userConfig?: Partial<JwtConfig>): JwtPlugin
function createMapTokenStore(): TokenStore
```

---

## Configuration (`JwtConfig`)

All fields have development-safe defaults. At minimum set the secrets (or PEM keys) to secure values in production.

| Field | Type | Default | Description |
|---|---|---|---|
| `accessTokenSecret` | `string` | `'access-secret-…'` | HMAC secret for HS* access tokens. Ignored for RS* / ES*. |
| `refreshTokenSecret` | `string` | `'refresh-secret-…'` | HMAC secret for HS* refresh tokens. Ignored for RS* / ES*. |
| `accessTokenPrivateKey` | `string` | — | PEM private key for RS* / ES* access token **signing**. **Required** when `alg` is RS* or ES*. |
| `accessTokenPublicKey` | `string` | — | PEM public key for RS* / ES* access token **verification**. **Required** when `alg` is RS* or ES*. |
| `refreshTokenPrivateKey` | `string` | — | PEM private key for RS* / ES* refresh token signing. Falls back to `accessTokenPrivateKey` when absent. |
| `refreshTokenPublicKey` | `string` | — | PEM public key for RS* / ES* refresh token verification. Falls back to `accessTokenPublicKey` when absent. |
| `accessTokenExpiry` | `number` | `900` (15 min) | Access token lifetime in **seconds**. |
| `refreshTokenExpiry` | `number` | `604800` (7 days) | Refresh token lifetime in **seconds**. |
| `issuer` | `string` | `'jwt-auth'` | Value placed in the JWT `iss` claim. |
| `checkIssuer` | `boolean` | `false` | When `true`, `authenticate` rejects tokens whose `iss` claim doesn't match `issuer`. |
| `alg` | `JwtAlgorithm` | `'HS256'` | JWT signing algorithm. See [Algorithms](#algorithms) below. |
| `username` | `(user) => string` | `(u) => u.username` | Extract the subject identifier from a user record. Used as the fallback `sub` claim. |
| `fetchUser` | `(sub) => UserRecord \| undefined` | Built-in `userDatabase` | Look up a user record by subject. |
| `isPasswordValid` | `(user, password) => boolean` | SHA-256 comparison | Validate a plain-text password. |
| `payload` | `(user) => Partial<TokenPayload>` | `{ sub, roles, permissions }` | Build the JWT payload. `iss`, `iat`, `exp` are added automatically. |
| `refreshTokenStore` | `TokenStore` | *absent* | Store for active refresh token records. **When absent, refresh tokens are not issued.** |

---

## Algorithms

`JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512'`

| Family | Algorithms | Key material | Node.js primitive |
|---|---|---|---|
| **HMAC-SHA** | HS256, HS384, HS512 | Shared secret string (`accessTokenSecret`) | `crypto.createHmac()` |
| **RSA PKCS#1 v1.5** | RS256, RS384, RS512 | PEM key pair (`accessTokenPrivateKey` / `accessTokenPublicKey`) | `crypto.sign()` / `crypto.verify()` |
| **ECDSA** | ES256 (P-256), ES384 (P-384), ES512 (P-521) | PEM key pair (`accessTokenPrivateKey` / `accessTokenPublicKey`) | `crypto.sign()` / `crypto.verify()`, JOSE P1363 encoding |

ECDSA signatures are stored in compact IEEE P1363 format (concatenated `r ‖ s` of fixed byte width) rather than DER, as required by the JWT specification.

### Asymmetric key setup

```ts
import crypto from 'crypto';

// RSA key pair (recommended: 2048 bits minimum)
const { privateKey: rsaPriv, publicKey: rsaPub } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

// EC key pair — curve must match the algorithm:
//   ES256 → P-256 | ES384 → P-384 | ES512 → P-521
const { privateKey: ecPriv, publicKey: ecPub } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});
```

### Using an asymmetric algorithm

```ts
const auth = createJwtPlugin({
  alg:                   'ES256',         // or RS256, RS384, RS512, ES384, ES512
  accessTokenPrivateKey: ecPriv,          // PEM — used for signing
  accessTokenPublicKey:  ecPub,           // PEM — used for verification
  // Optional: separate key pair for refresh tokens.
  // Falls back to accessToken keys when absent.
  refreshTokenPrivateKey: ecPriv,
  refreshTokenPublicKey:  ecPub,
  refreshTokenStore: createMapTokenStore(),
});
```

`createJwtPlugin` throws immediately if `alg` is RS* or ES* but the required PEM keys are missing.

---

## `TokenStore` interface

Implement this interface to plug in any storage backend. All methods may return their result directly or as a `Promise`:

```ts
interface TokenStore {
  set(jti: string, record: RefreshTokenRecord): void | Promise<void>;
  get(jti: string): RefreshTokenRecord | undefined | Promise<RefreshTokenRecord | undefined>;
  delete(jti: string): void | Promise<void>;
  deleteBySubject?(sub: string): void | Promise<void>;  // optional
}

interface RefreshTokenRecord {
  sub:       string;   // subject the token was issued to
  issuedAt:  number;   // Unix ms timestamp
  expiresAt: number;   // Unix ms timestamp
}
```

The store is keyed by JWT ID (`jti`) — a UUID v4 unique per issued token. Cleanup of expired records is the store's responsibility. `createMapTokenStore()` performs lazy cleanup on `get()`. The optional `deleteBySubject` enables "log out all sessions" scenarios.

### `createMapTokenStore()`

Built-in in-process store backed by a `Map`. Lazy expiry, no background timer. **Not suitable for multi-instance deployments** — use a Redis or database adapter instead.

---

## Route handlers

All handlers require a body-parsing middleware (`json()`) upstream.

### `auth.login` — `POST /auth/login`

Expects: `{ username: string, password: string }`

Success (200) **with** `refreshTokenStore`:
```json
{
  "message":      "Authentication successful",
  "accessToken":  "<jwt>",
  "refreshToken": "<jwt>",
  "expiresIn":    900,
  "tokenType":    "Bearer"
}
```

Success (200) **without** `refreshTokenStore` (`refreshToken` field absent):
```json
{ "message": "Authentication successful", "accessToken": "<jwt>", "expiresIn": 900, "tokenType": "Bearer" }
```

Errors: `400` (missing fields), `401` (wrong credentials).

### `auth.refresh` — `POST /auth/refresh`

Expects: `{ refreshToken: string }`

On success, the old refresh token is **immediately invalidated** (rotation) and a fresh pair is issued. Response matches the `login` success body.

Returns `501` when no `refreshTokenStore` is configured.

Errors: `400` (missing field), `401` (invalid / expired / revoked), `501` (no store).

### `auth.logout` — `POST /auth/logout`

Expects: `{ refreshToken?: string }` (optional).

Always responds 200. Revokes the refresh token when provided and valid. Idempotent.

---

## Middleware

### `auth.authenticate`

Validates `Authorization: Bearer <token>` and populates `req.user` with the decoded `TokenPayload`. **Always calls `next()`** — never rejects on its own; use `auth.authorize` after it to enforce login.

Clears `req.user` at the start of each call to prevent cross-request leakage.

### `auth.authorize`

Rejects with `401` when `req.user` is absent. Place after `auth.authenticate`:

```ts
app.get('/me', auth.authenticate, auth.authorize, handler);
```

### `auth.requireRole(...roles)`

Returns `[authenticate, roleCheck]`. The user must have **at least one** of the listed roles. Responds 401 / 403.

```ts
app.delete('/admin', ...auth.requireRole('admin'), handler);
```

### `auth.requirePermission(...permissions)`

Returns `[authenticate, permCheck]`. The user must have **all** listed permissions. Responds 401 / 403.

```ts
app.put('/posts', ...auth.requirePermission('write'), handler);
```

---

## Default user database

| Username | Password | Roles | Permissions |
|---|---|---|---|
| `alice` | `password123` | `admin`, `editor` | `read`, `write`, `delete`, `manage_users` |
| `bob` | `secret456` | `editor` | `read`, `write` |
| `charlie` | `pass789` | `viewer` | `read` |

Supply a custom `fetchUser` to use your own data source.

---

## `TokenPayload` (decoded `req.user`)

```ts
interface TokenPayload {
  sub:          string;    // user subject (username or stable ID)
  iss:          string;    // issuer
  iat:          number;    // issued-at (Unix seconds)
  exp:          number;    // expiration (Unix seconds)
  roles?:       string[];
  permissions?: string[];
  [key: string]: unknown;  // custom claims from config.payload()
}
```

---

## Refresh token internals

Refresh tokens are signed JWTs (using `refreshTokenSecret` for HS* or the refresh PEM keys for RS* / ES*) whose payload carries:

```json
{ "sub": "alice", "jti": "uuid-v4", "type": "refresh", "iss": "jwt-auth", "iat": …, "exp": … }
```

The `jti` (UUID v4) is the store key. On each `POST /auth/refresh`, the old JTI is deleted before a new pair is issued (**rotation**). Using a stolen refresh token invalidates it immediately. Because refresh tokens use a distinct secret or key pair, an access token cannot be used as a refresh token and vice versa.

---

## Important notes

- **SHA-256 password hashing is not production-safe.** Replace `isPasswordValid` with bcrypt / argon2.
- **Default secrets must be changed.** The built-in strings are public and provide no security.
- **`createMapTokenStore()` is process-local.** Lost on restart; use Redis for production multi-instance deployments.
- **Refresh tokens are optional.** Omit `refreshTokenStore` to disable them entirely.
- **RS* / ES* require both PEM keys.** `createJwtPlugin` throws at construction time when they are missing.
- **Curve must match the algorithm.** ES256 → P-256, ES384 → P-384, ES512 → P-521. Using the wrong curve will produce tokens that cannot be verified.
- **RS* / ES* algorithms are not supported.** Only HS256 / HS384 / HS512 / RS256 / RS384 / RS512 / ES256 / ES384 / ES512 are implemented. PS* (RSA-PSS) and Ed* (EdDSA) are not yet supported.
- **`authenticate` never rejects.** This is intentional — it allows optional authentication patterns within a single router.
