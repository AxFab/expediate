/* Copyright 2021 Fabien Bavent
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
/**
 * jwt-auth.ts
 *
 * JWT authentication plugin for the Expediate router.
 *
 * Provides:
 * - Stateless access tokens (HS256 / HS384 / HS512 HMAC-signed JWTs).
 * - Opaque refresh tokens with server-side storage and automatic rotation.
 * - Route handlers for login, token refresh, and logout.
 * - Middleware for token validation, authorisation, role checks, and
 *   permission checks.
 *
 * Security notes:
 * - Passwords are hashed with SHA-256 for demonstration purposes only.
 *   Replace with bcrypt / argon2 in production.
 * - The default secrets are placeholders — always override them in production.
 * - Refresh token storage defaults to an in-process Map; replace with a
 *   persistent store (Redis, database) for multi-instance deployments.
 */

import crypto from 'crypto';
import type { RouterRequest, RouterResponse, Middleware } from './router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user record as stored in (or returned by) the user database. */
export interface UserRecord {
  /** Stable unique identifier (used as JWT `sub` claim when present). */
  id?:           string;
  /** Login username. */
  username:      string;
  /**
   * SHA-256 hex digest of the user's password.
   * Replace with a bcrypt/argon2 hash in production.
   */
  passwordHash:  string;
  /** Role labels assigned to this user (e.g. `'admin'`, `'editor'`). */
  roles?:        string[];
  /**
   * Fine-grained permission strings assigned to this user
   * (e.g. `'read'`, `'write'`, `'delete'`).
   */
  permissions?:  string[];
  /** Any additional fields the application wants to carry. */
  [key: string]: unknown;
}

/**
 * The decoded JWT access-token payload attached to `req.user` after
 * successful authentication.
 */
export interface TokenPayload {
  /** JWT subject — typically the user's stable ID. */
  sub:          string;
  /** Username extracted from the user record. */
  username:     string;
  /** Issuer claim, set to `config.issuer`. */
  iss:          string;
  /** Issued-at timestamp (Unix seconds). */
  iat:          number;
  /** Expiration timestamp (Unix seconds). */
  exp:          number;
  /** Roles copied from the user record. */
  roles?:       string[];
  /** Permissions copied from the user record. */
  permissions?: string[];
  /** Any additional claims produced by `config.payload`. */
  [key: string]: unknown;
}

/** Internal metadata stored alongside each active refresh token. */
interface RefreshTokenData {
  /** Username the refresh token was issued to. */
  username:  string;
  /** Unix ms timestamp of issuance. */
  issuedAt:  number;
  /** Unix ms timestamp after which the token must be rejected. */
  expiresAt: number;
}

/**
 * Minimal interface for the refresh-token store.
 * Any object implementing these four methods is accepted (Map, Redis client
 * adapter, database wrapper, etc.).
 */
export interface TokenStore {
  set(key: string, value: RefreshTokenData): void;
  get(key: string): RefreshTokenData | undefined;
  delete(key: string): void;
  has(key: string): boolean;
}

/**
 * Supported HMAC-SHA signing algorithms for JWT.
 * RS*, ES*, and PS* families are not yet implemented.
 */
export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512';

/**
 * Full configuration object for {@link createJwtPlugin}.
 * All fields have defaults; override only what you need.
 */
export interface JwtConfig {
  /** HMAC secret used to sign access tokens. **Change in production.** */
  accessTokenSecret:  string;
  /** HMAC secret used to sign refresh tokens (currently unused — refresh   *
   * tokens are opaque random strings, not JWTs). Reserved for future use. */
  refreshTokenSecret: string;
  /** Access token lifetime in **seconds**. Defaults to 15 minutes. */
  accessTokenExpiry:  number;
  /** Refresh token lifetime in **seconds**. Defaults to 7 days. */
  refreshTokenExpiry: number;
  /** Value placed in the JWT `iss` claim. */
  issuer:             string;
  /**
   * When `true`, the `authenticate` middleware rejects tokens whose `iss`
   * claim does not match `config.issuer`.
   * Defaults to `false` (issuer not checked).
   */
  checkIssuer:        boolean;
  /** JWT signing algorithm. Defaults to `'HS256'`. */
  alg:                JwtAlgorithm;
  /**
   * Extract the login username from a user record.
   * Defaults to `(user) => user.username`.
   */
  username:           (user: UserRecord) => string;
  /**
   * Fetch a user record by username.
   * Return `undefined` (or any falsy value) when the user does not exist.
   */
  fetchUser:          (username: string) => UserRecord | undefined;
  /**
   * Return `true` when the supplied plain-text `password` is valid for
   * `user`, `false` otherwise.
   *
   * The default implementation compares SHA-256 hashes; replace with a
   * timing-safe bcrypt/argon2 check in production.
   */
  isPasswordValid:    (user: UserRecord, password: string) => boolean;
  /**
   * Build the JWT payload for a user.
   * The `iss`, `iat`, `exp`, and `sub` claims are added automatically.
   * Returning a partial object is fine — the plugin merges the rest.
   */
  payload:            (user: UserRecord) => Partial<TokenPayload>;
  /**
   * Active refresh-token store.
   * Defaults to an in-process `Map` (lost on restart; not suitable for
   * multi-instance deployments).
   */
  refreshTokenStore:  TokenStore;
}

/** Result returned by internal authentication / token-issue functions. */
type AuthResult =
  | { success: true;  accessToken: string; refreshToken: string;
      expiresIn: number; tokenType: 'Bearer' }
  | { success: false; error: string };

/** Result returned by {@link verifyToken}. */
type VerifyResult =
  | { valid: true;  payload: TokenPayload }
  | { valid: false; error: string };

// ---------------------------------------------------------------------------
// Sample user database (replace or extend for real applications)
// ---------------------------------------------------------------------------

/**
 * Hash a plain-text password with SHA-256 and return the hex digest.
 *
 * > **⚠ Warning:** SHA-256 is fast and therefore unsuitable for password
 * > hashing in production.  Use bcrypt or argon2 instead.
 *
 * @param password - The plain-text password to hash.
 * @returns A 64-character lowercase hex string.
 */
export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Default in-memory user database used when no custom `fetchUser` is
 * provided.  Contains three demo accounts: alice (admin), bob (editor),
 * charlie (viewer).
 *
 * Replace or ignore this map entirely when you supply your own `fetchUser`.
 */
export const userDatabase = new Map<string, UserRecord>([
  ['alice', {
    id:           'usr_001',
    username:     'alice',
    passwordHash: hashPassword('password123'),
    roles:        ['admin', 'editor'],
    permissions:  ['read', 'write', 'delete', 'manage_users'],
  }],
  ['bob', {
    id:           'usr_002',
    username:     'bob',
    passwordHash: hashPassword('secret456'),
    roles:        ['editor'],
    permissions:  ['read', 'write'],
  }],
  ['charlie', {
    id:           'usr_003',
    username:     'charlie',
    passwordHash: hashPassword('pass789'),
    roles:        ['viewer'],
    permissions:  ['read'],
  }],
]);

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: JwtConfig = {
  accessTokenSecret:  'access-secret-change-in-production',
  refreshTokenSecret: 'refresh-secret-change-in-production',
  accessTokenExpiry:  15 * 60,         // 15 minutes
  refreshTokenExpiry: 7 * 24 * 3600,   // 7 days
  issuer:             'jwt-auth',
  checkIssuer:        false,
  alg:                'HS256',

  username:    (user) => user.username,
  fetchUser:   (username) => userDatabase.get(username),

  isPasswordValid: (user, password) => user.passwordHash === hashPassword(password),

  payload: (user) => ({
    sub:         user.id,
    username:    user.username,
    roles:       user.roles,
    permissions: user.permissions,
  }),

  refreshTokenStore: new Map<string, RefreshTokenData>(),
};

// ---------------------------------------------------------------------------
// JWT utilities — manual Base64URL implementation
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary object as a Base64URL-encoded JSON string, suitable
 * for use as a JWT header or payload segment.
 *
 * @param data - Any JSON-serialisable value.
 * @returns A Base64URL string with no padding characters.
 */
function base64UrlEncode(data: object): string {
  return Buffer.from(JSON.stringify(data))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Decode a Base64URL-encoded JWT segment and parse it as JSON.
 *
 * @param str - A Base64URL string (padding optional).
 * @returns The parsed JSON value.
 * @throws When the string is not valid Base64URL JSON.
 */
function base64UrlDecode(str: string): unknown {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return JSON.parse(
    Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  );
}

/**
 * Compute the Base64URL-encoded HMAC signature for a JWT.
 *
 * Receives the **already-encoded** header and payload strings (i.e. the
 * first two dot-separated segments of the token) and signs the
 * `"<header>.<payload>"` string with the given secret.
 *
 * Currently supports the HS (HMAC-SHA) family: `HS256`, `HS384`, `HS512`.
 *
 * @param encodedHeader  - Base64URL-encoded JWT header string.
 * @param encodedPayload - Base64URL-encoded JWT payload string.
 * @param secret         - HMAC secret key.
 * @param alg            - Algorithm identifier (must be HS256, HS384, or HS512).
 * @returns A Base64URL-encoded signature string.
 * @throws {Error} When `alg` is not a supported HS algorithm.
 */
function createSignature(
  encodedHeader:  string,
  encodedPayload: string,
  secret:         string,
  alg:            JwtAlgorithm,
): string {
  const shaVariant = `sha${alg.substring(2)}`; // 'sha256', 'sha384', 'sha512'
  return crypto
    .createHmac(shaVariant, secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Sign a payload object and return a compact JWT string.
 *
 * Automatically adds the `iat` (issued-at) and `exp` (expiration) claims.
 * Any claims already present in `payload` are preserved and take precedence
 * over `iat`/`exp` (use this to override expiry if needed).
 *
 * @param payload   - JWT payload claims (must be JSON-serialisable).
 * @param secret    - HMAC secret used to sign the token.
 * @param expiresIn - Validity window in **seconds** from the current time.
 * @param alg       - Signing algorithm. Defaults to `'HS256'`.
 * @returns A compact JWT string in the form `header.payload.signature`.
 */
function signToken(
  payload:   Partial<TokenPayload>,
  secret:    string,
  expiresIn: number,
  alg:       JwtAlgorithm = 'HS256',
): string {
  const now           = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlEncode({ alg, typ: 'JWT' });
  const fullPayload   = base64UrlEncode({ ...payload, iat: now, exp: now + expiresIn });
  const signature     = createSignature(encodedHeader, fullPayload, secret, alg);
  return `${encodedHeader}.${fullPayload}.${signature}`;
}

/**
 * Verify a compact JWT string and return its decoded payload on success.
 *
 * Performs the following checks in order:
 * 1. Structural validity (exactly three dot-separated segments).
 * 2. Algorithm consistency (header `alg` matches the expected `alg`).
 * 3. Signature integrity (timing-safe HMAC comparison).
 * 4. Expiration (`exp` claim is in the future).
 *
 * All errors are returned as `{ valid: false, error }` — no exception is
 * thrown to the caller.
 *
 * @param token  - The compact JWT string to verify.
 * @param secret - HMAC secret that was used to sign the token.
 * @param alg    - Expected signing algorithm.
 * @returns A {@link VerifyResult} discriminated union.
 */
function verifyToken(token: string, secret: string, alg: JwtAlgorithm): VerifyResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 3)
      return { valid: false, error: 'Invalid token format' };

    const [encodedHeader, encodedPayload, signature] = parts;

    const decodedHeader = base64UrlDecode(encodedHeader) as { alg?: string; typ?: string };
    if (decodedHeader.alg !== alg)
      return { valid: false, error: 'Unauthorised signing algorithm' };

    const expectedSig = createSignature(encodedHeader, encodedPayload, secret, alg);

    const sigBuf      = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return { valid: false, error: 'Invalid signature' };
    }

    const payload = base64UrlDecode(encodedPayload) as TokenPayload;
    const now     = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now)
      return { valid: false, error: 'Token expired' };

    return { valid: true, payload };
  } catch {
    return { valid: false, error: 'Malformed token' };
  }
}

/**
 * Generate a cryptographically secure opaque refresh token.
 *
 * The token is 128 hex characters (64 random bytes), providing 512 bits of
 * entropy — far beyond any brute-force threat.
 *
 * @returns A 128-character lowercase hex string.
 */
function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

/**
 * Authenticate a user by username and password and, on success, issue a new
 * access + refresh token pair.
 *
 * @param username - The username supplied by the client.
 * @param password - The plain-text password supplied by the client.
 * @param config   - Resolved plugin configuration.
 * @returns An {@link AuthResult} discriminated union.
 */
function authenticateUser(username: string, password: string, config: JwtConfig): AuthResult {
  const user = config.fetchUser(username);
  if (!user) return { success: false, error: 'User not found' };

  if (!config.isPasswordValid(user, password))
    return { success: false, error: 'Incorrect password' };

  return issueTokenPair(user, config);
}

/**
 * Build and store a new access + refresh token pair for the given user.
 *
 * The refresh token is stored in `config.refreshTokenStore` with its
 * expiration timestamp so it can be validated on subsequent renewal requests.
 *
 * @param user   - The authenticated user record.
 * @param config - Resolved plugin configuration.
 * @returns An {@link AuthResult} with `success: true`.
 */
function issueTokenPair(user: UserRecord, config: JwtConfig): AuthResult {
  const username = config.username(user);
  const claims   = config.payload(user);

  // Inject standard claims; caller-supplied claims take precedence.
  const fullClaims: Partial<TokenPayload> = {
    sub: username,    // fallback subject — overridden by payload() if it sets sub
    ...claims,
    iss: config.issuer,
  };

  const accessToken  = signToken(fullClaims, config.accessTokenSecret, config.accessTokenExpiry, config.alg);
  const refreshToken = generateRefreshToken();

  config.refreshTokenStore.set(refreshToken, {
    username,
    issuedAt:  Date.now(),
    expiresAt: Date.now() + config.refreshTokenExpiry * 1000,
  });

  return {
    success:      true,
    accessToken,
    refreshToken,
    expiresIn:    config.accessTokenExpiry,
    tokenType:    'Bearer',
  };
}

/**
 * Renew an access token using a valid refresh token.
 *
 * Implements **refresh token rotation**: the presented refresh token is
 * always invalidated and a brand-new pair is issued on success.  This means
 * a stolen refresh token can only be used once before it is invalidated by
 * the legitimate holder's next renewal.
 *
 * @param username     - The username from the renewal request body.
 * @param refreshToken - The opaque refresh token string.
 * @param config       - Resolved plugin configuration.
 * @returns An {@link AuthResult} discriminated union.
 */
function renewAccessToken(username: string, refreshToken: string, config: JwtConfig): AuthResult {
  const tokenData = config.refreshTokenStore.get(refreshToken);

  // Verify the token exists and belongs to the claimed user.
  if (!tokenData || tokenData.username !== username)
    return { success: false, error: 'Invalid or revoked refresh token' };

  if (Date.now() > tokenData.expiresAt) {
    config.refreshTokenStore.delete(refreshToken);
    return { success: false, error: 'Refresh token expired' };
  }

  const user = config.fetchUser(tokenData.username);
  if (!user) {
    config.refreshTokenStore.delete(refreshToken);
    return { success: false, error: 'User not found' };
  }

  // Rotate: invalidate the used token before issuing a new pair.
  config.refreshTokenStore.delete(refreshToken);
  return issueTokenPair(user, config);
}

/**
 * Revoke a refresh token, preventing it from being used to obtain new access
 * tokens.  Idempotent — revoking an already-revoked token is not an error.
 *
 * @param refreshToken - The opaque refresh token string to revoke.
 * @param config       - Resolved plugin configuration.
 * @returns `true` if the token existed and was removed, `false` if it was
 *          already absent.
 */
function revokeRefreshToken(refreshToken: string, config: JwtConfig): boolean {
  const existed = config.refreshTokenStore.has(refreshToken);
  config.refreshTokenStore.delete(refreshToken);
  return existed;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * The object returned by {@link createJwtPlugin}.
 *
 * Mount the handlers on your router and apply the middleware to protected
 * routes:
 *
 * ```ts
 * const auth = createJwtPlugin({ accessTokenSecret: process.env.JWT_SECRET! });
 *
 * app.post('/auth/login',   json(), auth.login);
 * app.post('/auth/refresh', json(), auth.refresh);
 * app.post('/auth/logout',  json(), auth.logout);
 *
 * app.get('/me',    auth.authenticate, auth.authorize, getProfile);
 * app.delete('/admin', ...auth.requireRole('admin'), deleteHandler);
 * app.put('/posts', ...auth.requirePermission('write'), updateHandler);
 * ```
 */
export interface JwtPlugin {
  /**
   * Route handler for `POST /auth/login`.
   * Expects a JSON body with `{ username, password }`.
   * On success: responds with `{ accessToken, refreshToken, expiresIn, tokenType }`.
   */
  login: Middleware;
  /**
   * Route handler for `POST /auth/refresh`.
   * Expects a JSON body with `{ username, refreshToken }`.
   * On success: responds with a new `{ accessToken, refreshToken, ... }` pair.
   */
  refresh: Middleware;
  /**
   * Route handler for `POST /auth/logout`.
   * Expects a JSON body with `{ refreshToken }` (optional).
   * Always responds with 200; revokes the refresh token if provided.
   */
  logout: Middleware;
  /**
   * Middleware that validates the `Authorization: Bearer <token>` header.
   * Sets `req.user` to the decoded {@link TokenPayload} on success.
   * Calls `next()` silently (without error) when the token is absent or invalid,
   * allowing the route to decide how to handle unauthenticated requests.
   */
  authenticate: Middleware;
  /**
   * Middleware that rejects unauthenticated requests with 401.
   * Should be placed **after** {@link authenticate}:
   * `router.get('/me', auth.authenticate, auth.authorize, handler)`.
   */
  authorize: Middleware;
  /**
   * Middleware factory that requires the authenticated user to have at least
   * one of the specified roles.  Returns `[authenticate, roleCheck]` so it
   * can be spread directly into a route registration:
   * `router.get('/admin', ...auth.requireRole('admin'), handler)`.
   * Responds with 401 when unauthenticated, 403 when the role is missing.
   */
  requireRole:       (...roles: string[])       => Middleware[];
  /**
   * Middleware factory that requires the authenticated user to have **all**
   * of the specified permissions.  Returns `[authenticate, permCheck]`.
   * Responds with 401 when unauthenticated, 403 when any permission is missing.
   */
  requirePermission: (...permissions: string[]) => Middleware[];
}

/**
 * Create a JWT authentication plugin pre-configured with the given options.
 *
 * All config fields have safe defaults for development.  At minimum, set
 * `accessTokenSecret` (and `refreshTokenSecret` if you plan to use it) to
 * random values in production.
 *
 * @param userConfig - Partial {@link JwtConfig} overrides.
 * @returns A {@link JwtPlugin} object exposing handlers and middleware.
 */
export function createJwtPlugin(userConfig: Partial<JwtConfig> = {}): JwtPlugin {
  const config: JwtConfig = { ...DEFAULT_CONFIG, ...userConfig };

  // Helper: write a JSON response (our router's res.send() does not add
  // Content-Type automatically, so we set it manually).
  function sendJson(res: RouterResponse, status: number, data: object): void {
    const body = JSON.stringify(data);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).send(body);
  }

  // ── POST /auth/login ────────────────────────────────────────────────────

  /**
   * Login handler.  Reads `{ username, password }` from `req.body` (requires
   * a JSON body-parsing middleware such as `json()` to run first).
   */
  const login: Middleware = (req: RouterRequest, res: RouterResponse): void => {
    const { username, password } = (req as any).body ?? {};

    if (!username || !password) {
      sendJson(res, 400, { error: "Fields 'username' and 'password' are required" });
      return;
    }

    const result = authenticateUser(username, password, config);

    if (!result.success) {
      sendJson(res, 401, { error: result.error });
      return;
    }

    sendJson(res, 200, {
      message:      'Authentication successful',
      accessToken:  result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn:    result.expiresIn,
      tokenType:    result.tokenType,
    });
  };

  // ── POST /auth/refresh ──────────────────────────────────────────────────

  /**
   * Token-renewal handler.  Reads `{ username, refreshToken }` from
   * `req.body`.
   */
  const refresh: Middleware = (req: RouterRequest, res: RouterResponse): void => {
    const { username, refreshToken } = (req as any).body ?? {};

    if (!username || !refreshToken) {
      sendJson(res, 400, { error: "Fields 'username' and 'refreshToken' are required" });
      return;
    }

    const result = renewAccessToken(username, refreshToken, config);

    if (!result.success) {
      sendJson(res, 401, { error: result.error });
      return;
    }

    sendJson(res, 200, {
      message:      'Token renewed successfully',
      accessToken:  result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn:    result.expiresIn,
      tokenType:    result.tokenType,
    });
  };

  // ── POST /auth/logout ───────────────────────────────────────────────────

  /**
   * Logout handler.  Optionally reads `{ refreshToken }` from `req.body` and
   * revokes it.  Always responds with 200 regardless of whether a token was
   * provided (to avoid leaking information about token existence).
   */
  const logout: Middleware = (req: RouterRequest, res: RouterResponse): void => {
    const { refreshToken } = (req as any).body ?? {};

    if (refreshToken) {
      revokeRefreshToken(refreshToken, config);
    }

    sendJson(res, 200, { message: 'Logged out successfully' });
  };

  // ── authenticate middleware ─────────────────────────────────────────────

  /**
   * Validate the `Authorization: Bearer <token>` header and populate
   * `req.user` with the decoded payload.
   *
   * Designed to be **non-blocking**: missing or invalid tokens cause `next()`
   * to be called without error, deferring the authentication decision to the
   * next middleware (typically {@link authorize} or a custom guard).
   *
   * `req.user` is explicitly cleared at the start of each invocation to
   * prevent stale data from leaking across requests in unusual server setups.
   */
  const authenticate: Middleware = (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    // Always clear any previously set user to prevent cross-request contamination.
    delete (req as any).user;

    const authHeader = req.headers['authorization'] as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) return next();

    const token  = authHeader.slice(7);
    const result = verifyToken(token, config.accessTokenSecret, config.alg);
    if (!result.valid) return next();

    // The correct check reads the `iss` claim from the decoded payload.
    if (config.checkIssuer && result.payload.iss !== config.issuer) return next();

    (req as any).user = result.payload;
    next();
  };

  // ── authorize middleware ────────────────────────────────────────────────

  /**
   * Reject the request with 401 when `req.user` is not set.
   * Always place this **after** {@link authenticate}.
   */
  const authorize: Middleware = (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    if (!(req as any).user) {
      sendJson(res, 401, { error: 'Authentication required' });
      return;
    }
    next();
  };

  // ── requireRole factory ─────────────────────────────────────────────────

  /**
   * Return a two-element middleware chain `[authenticate, roleCheck]` that
   * allows the request to proceed only when the authenticated user holds at
   * least one of the specified roles.
   *
   * Responds with 401 when unauthenticated, 403 when none of the required
   * roles are present.
   */
  function requireRole(...roles: string[]): Middleware[] {
    return [
      authenticate,
      (req: RouterRequest, res: RouterResponse, next: () => void): void => {
        const user = (req as any).user as TokenPayload | undefined;
        if (!user) {
          sendJson(res, 401, { error: 'Authentication required' });
          return;
        }
        const userRoles = user.roles ?? [];
        if (!roles.some((r) => userRoles.includes(r))) {
          sendJson(res, 403, {
            error:     `Access denied. Required role(s): ${roles.join(', ')}`,
            yourRoles: userRoles,
          });
          return;
        }
        next();
      },
    ];
  }

  // ── requirePermission factory ───────────────────────────────────────────

  /**
   * Return a two-element middleware chain `[authenticate, permCheck]` that
   * allows the request to proceed only when the authenticated user holds
   * **all** of the specified permissions.
   *
   * Responds with 401 when unauthenticated, 403 when any permission is absent.
   */
  function requirePermission(...permissions: string[]): Middleware[] {
    return [
      authenticate,
      (req: RouterRequest, res: RouterResponse, next: () => void): void => {
        const user = (req as any).user as TokenPayload | undefined;
        if (!user) {
          sendJson(res, 401, { error: 'Authentication required' });
          return;
        }
        const userPerms = user.permissions ?? [];
        if (!permissions.every((p) => userPerms.includes(p))) {
          sendJson(res, 403, {
            error:           `Insufficient permissions. Required: ${permissions.join(', ')}`,
            yourPermissions: userPerms,
          });
          return;
        }
        next();
      },
    ];
  }

  return {
    login,
    refresh,
    logout,
    authenticate,
    authorize,
    requireRole,
    requirePermission,
  };
}

export default createJwtPlugin;

// Re-export low-level utilities for testing and advanced use cases.
export { signToken, verifyToken, hashPassword as _hashPassword };
