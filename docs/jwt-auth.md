# JWT Authentication

`createJwtPlugin()` returns a self-contained authentication plugin built on Node.js `crypto` — no external JWT library is required.

Features: HMAC / RSA / ECDSA algorithms, refresh token rotation, role and permission guards, pluggable user database, pluggable token store.

---

## Quick start

```ts
import { createRouter, json, createJwtPlugin, createMapTokenStore } from 'expediate';

const app  = createRouter();
const auth = createJwtPlugin({
  accessTokenSecret: process.env.JWT_SECRET!,
  refreshTokenStore: createMapTokenStore(), // omit to disable refresh tokens entirely
});

// Auth endpoints (all require the json() body parser)
app.post('/auth/login',   json(), auth.login);
app.post('/auth/refresh', json(), auth.refresh);
app.post('/auth/logout',  json(), auth.logout);

// Protected route
app.get('/me', auth.authenticate, auth.authorize, (req, res) => {
  res.json((req as any).user);
});
```

Refresh tokens are opt-in: `auth.login` only includes a `refreshToken` in its
response when `refreshTokenStore` is configured, and `auth.refresh` responds
`501 Not Implemented` otherwise.

---

## Auth endpoints

### `POST /auth/login`

```json
// Request
{ "username": "alice", "password": "password123" }

// Response 200 (refreshToken present only when refreshTokenStore is configured)
{
  "accessToken":  "eyJ...",
  "refreshToken": "eyJ...",
  "expiresIn":    900,
  "tokenType":    "Bearer"
}
```

### `POST /auth/refresh`

```json
// Request
{ "refreshToken": "eyJ..." }

// Response 200 — new token pair (old refresh token is invalidated immediately)
{ "accessToken": "eyJ...", "refreshToken": "eyJ...", "expiresIn": 900, "tokenType": "Bearer" }
```

Refresh tokens are **rotated** on every use — the old token is invalidated before the new pair is issued, so a stolen refresh token can only be used once. Responds `501 Not Implemented` if no `refreshTokenStore` was configured.

### `POST /auth/logout`

```json
// Request
{ "refreshToken": "b9c2..." }

// Response 200 — refresh token revoked
{ "message": "Logged out successfully" }
```

---

## Protecting routes

```ts
// authenticate — populates req.user; calls next() silently on failure
// authorize   — rejects with 401 Unauthorized if req.user is not set
app.get('/profile', auth.authenticate, auth.authorize, handler);
```

`authenticate` always clears `req.user` at the start of the middleware call to prevent stale data leaking across requests. This split design means you can optionally inspect `req.user` in middleware before requiring it.

`req.user` shape when authenticated:

```ts
interface TokenPayload {
  sub:          string;    // user ID
  username:     string;
  iss:          string;    // issuer
  iat:          number;    // issued at (Unix seconds)
  exp:          number;    // expires at (Unix seconds)
  roles?:       string[];
  permissions?: string[];
}
```

---

## Role and permission guards

Both helpers return `[authenticate, guard]` — spread them into route registration:

```ts
// Require at least ONE of the listed roles
app.delete('/admin/users/:id', ...auth.requireRole('admin'), deleteUser);
app.get('/reports',           ...auth.requireRole('admin', 'editor'), getReports);

// Require ALL of the listed permissions
app.put('/posts/:id', ...auth.requirePermission('write', 'publish'), updatePost);
```

---

## Configuration reference

```ts
const auth = createJwtPlugin({
  // ── Secrets (always set in production) ──────────────────────────────────
  accessTokenSecret:  'change-me',      // shared HMAC secret (HS*)
  refreshTokenSecret: 'change-me-too',  // shared HMAC secret for refresh JWTs (HS*)

  // For asymmetric algorithms (RS*, ES*), supply PEM keys instead:
  // accessTokenPrivateKey: readFileSync('private.pem', 'utf8'),
  // accessTokenPublicKey:  readFileSync('public.pem',  'utf8'),
  // Optional separate key pair for refresh tokens — falls back to the
  // access token keys above when omitted:
  // refreshTokenPrivateKey: readFileSync('refresh-private.pem', 'utf8'),
  // refreshTokenPublicKey:  readFileSync('refresh-public.pem',  'utf8'),

  // ── Algorithm ───────────────────────────────────────────────────────────
  alg: 'HS256',  // 'HS256' | 'HS384' | 'HS512'
                 // 'RS256' | 'RS384' | 'RS512'
                 // 'ES256' | 'ES384' | 'ES512'

  // ── Expiry ──────────────────────────────────────────────────────────────
  accessTokenExpiry:  15 * 60,        // 15 minutes (seconds)
  refreshTokenExpiry: 7 * 24 * 3600,  // 7 days (seconds)

  // ── Claims ──────────────────────────────────────────────────────────────
  issuer:      'my-app',
  checkIssuer: true,  // reject tokens with a different iss claim (default: false)

  // ── User database ───────────────────────────────────────────────────────
  // Replace with a real database query; return null to reject login
  fetchUser: async (username) => {
    return await db.users.findOne({ username });
  },

  // Extracts the subject identifier from a user record (default: user => user.username)
  username: (user) => user.id,

  // ── Password validation ─────────────────────────────────────────────────
  // Default uses SHA-256 — replace with bcrypt/argon2 for production
  isPasswordValid: async (user, password) => {
    return await bcrypt.compare(password, user.passwordHash);
  },

  // ── Custom JWT payload ──────────────────────────────────────────────────
  payload: (user) => ({
    sub:         user.id,
    username:    user.username,
    roles:       user.roles,
    permissions: user.permissions,
  }),

  // ── Token store ─────────────────────────────────────────────────────────
  // Required to enable refresh tokens at all — omit to disable them entirely
  // (auth.login then omits refreshToken, auth.refresh responds 501).
  // createMapTokenStore() is a simple in-memory default; replace with a
  // Redis adapter for multi-instance deployments.
  refreshTokenStore: redisAdapter,
});
```

---

## Token store interface

The store is keyed by JWT ID (`jti`), not by the token string itself — every
issued refresh token carries a unique `jti` claim, and the store maps that ID
to a record. Methods may return their result directly or as a `Promise`:

```ts
interface TokenStore {
  set(jti: string, record: RefreshTokenRecord): void | Promise<void>;
  get(jti: string): RefreshTokenRecord | undefined | Promise<RefreshTokenRecord | undefined>;
  delete(jti: string): void | Promise<void>;
  deleteBySubject?(sub: string): void | Promise<void>;  // optional — "log out all sessions"
}

interface RefreshTokenRecord {
  sub:       string;  // subject the token was issued to
  issuedAt:  number;  // Unix ms timestamp
  expiresAt: number;  // Unix ms timestamp
}
```

A built-in in-memory store is available for testing:

```ts
import { createMapTokenStore } from 'expediate';

const auth = createJwtPlugin({
  accessTokenSecret: 'dev-secret',
  refreshTokenStore: createMapTokenStore(),
});
```

### Refresh token internals

Refresh tokens are signed JWTs, not opaque strings. Their payload carries:

```json
{ "sub": "alice", "jti": "uuid-v4", "type": "refresh", "iss": "my-app", "iat": 0, "exp": 0 }
```

The `jti` (a `crypto.randomUUID()` value) is the token store key. Refresh
tokens are signed with `refreshTokenSecret` (HS*) or `refreshTokenPrivateKey`
/ `refreshTokenPublicKey` (RS*/ES*, falling back to the access-token PEM keys
when omitted) — a distinct key from the access token where configured, so an
access token can never be replayed as a refresh token. On every
`POST /auth/refresh`, the old `jti` is looked up, deleted, then a fresh pair
is issued (rotation).

---

## Algorithms

All algorithms are implemented using Node.js `crypto` — no third-party JWT library:

| Algorithm | Key type | Notes |
|---|---|---|
| `HS256` / `HS384` / `HS512` | Shared HMAC secret string | Default; `accessTokenSecret` |
| `RS256` / `RS384` / `RS512` | RSA PEM key pair | `accessTokenPrivateKey` + `accessTokenPublicKey` |
| `ES256` / `ES384` / `ES512` | ECDSA PEM key pair | DER↔P1363 conversion for standard JWT wire format |

Verification uses `crypto.timingSafeEqual` to prevent timing attacks.

---

## Security notes

- The default password hashing uses SHA-256, which is **not suitable for production**. Always supply an `isPasswordValid` function that uses bcrypt, argon2, or scrypt.
- Calling `createJwtPlugin()` with no `accessTokenSecret` uses a placeholder secret and should only be done in tests or demos.
- Refresh tokens are signed JWTs carrying a `jti` claim, not opaque strings — see [Refresh token internals](#refresh-token-internals). Only the `jti` is stored server-side (in the token store), and it's invalidated on each use.
- Refresh tokens are entirely opt-in: omit `refreshTokenStore` to disable them — `auth.login` then omits `refreshToken` from its response and `auth.refresh` responds `501 Not Implemented`.
