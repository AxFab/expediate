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
 * - Stateless access tokens signed with HS256/HS384/HS512 (shared secret) or
 *   RS256/RS384/RS512/ES256/ES384/ES512 (asymmetric PEM key pairs).
 * - Signed JWT refresh tokens with JTI-based server-side revocation.
 * - Route handlers for login, token refresh, and logout.
 * - Middleware for token validation, authorisation, role checks, and
 *   permission checks.
 * - A `createMapTokenStore()` factory for in-process token storage.
 *
 * Security notes:
 * - Passwords are hashed with SHA-256 for demonstration purposes only.
 *   Replace with bcrypt / argon2 in production.
 * - The default secrets are placeholders — always override them in production.
 * - `createMapTokenStore()` is an in-process store; replace with a Redis or
 *   database adapter for multi-instance deployments.
 * - Refresh tokens are only issued when `refreshTokenStore` is configured.
 *   Absence of a store disables refresh-token support entirely.
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
  passwordHash?:  string;
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
 * successful authentication.  The `sub` claim identifies the user (typically
 * the username or a stable user ID).  Custom claims returned by
 * `config.payload` are carried in the index-signature field.
 */
export interface TokenPayload {
  /** JWT subject — the user identifier (username or stable ID). */
  sub:          string;
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

/**
 * Metadata stored in the token store for each active refresh token.
 * The key used to address this record is the token's `jti` (JWT ID) claim.
 */
export interface RefreshTokenRecord {
  /** Subject the refresh token was issued to (`sub` from the access token). */
  sub:       string;
  /** Unix millisecond timestamp of issuance. */
  issuedAt:  number;
  /** Unix millisecond timestamp after which the token must be rejected. */
  expiresAt: number;
}

/**
 * Async-compatible interface for the refresh-token store.
 *
 * The store is addressed by JWT ID (`jti`) — a UUID v4 unique to each
 * issued refresh token.  Every method may return its result either directly
 * or as a Promise, enabling both synchronous (Map) and asynchronous (Redis,
 * database) implementations.
 *
 * Cleanup of expired records is the store's responsibility.  The built-in
 * {@link createMapTokenStore} performs lazy cleanup on `get()`.
 */
export interface TokenStore {
  /**
   * Persist a new refresh-token record.
   * @param jti    - Unique JWT ID of the issued refresh token.
   * @param record - Metadata to store alongside the token.
   */
  set(jti: string, record: RefreshTokenRecord): void | Promise<void>;

  /**
   * Retrieve the record for a given JTI, or `undefined` if not found or
   * expired.  Implementations are encouraged to delete expired records lazily
   * here rather than in a background job.
   * @param jti - JWT ID to look up.
   */
  get(jti: string): RefreshTokenRecord | undefined | Promise<RefreshTokenRecord | undefined>;

  /**
   * Remove a single record by JTI.  Idempotent — deleting a non-existent
   * key is not an error.
   * @param jti - JWT ID to remove.
   */
  delete(jti: string): void | Promise<void>;

  /**
   * Revoke **all** refresh tokens belonging to a given subject (user).
   * Optional — when absent, per-JTI revocation still works but bulk logout
   * ("log out all sessions") is not available.
   * @param sub - The subject identifier to revoke tokens for.
   */
  deleteBySubject?(sub: string): void | Promise<void>;
}

/**
 * Supported JWT signing algorithms.
 *
 * - **HS256 / HS384 / HS512** — HMAC-SHA family.  Uses a shared secret string
 *   (`accessTokenSecret` / `refreshTokenSecret`).
 * - **RS256 / RS384 / RS512** — RSA PKCS#1 v1.5 + SHA family.  Requires PEM
 *   private key for signing and PEM public key for verification.
 * - **ES256 / ES384 / ES512** — ECDSA + SHA family.  Requires a PEM private
 *   key (P-256 / P-384 / P-521 curve respectively) for signing and the
 *   corresponding PEM public key for verification.  Signatures are encoded in
 *   the compact IEEE P1363 (JOSE) format rather than ASN.1 DER.
 */
export type JwtAlgorithm =
  | 'HS256' | 'HS384' | 'HS512'
  | 'RS256' | 'RS384' | 'RS512'
  | 'ES256' | 'ES384' | 'ES512';

/**
 * Full configuration object for {@link createJwtPlugin}.
 * All fields except `accessTokenSecret` and `refreshTokenSecret` have defaults.
 */
export interface JwtConfig {
  /** HMAC secret used to sign access tokens (HS* algorithms). **Change in production.** */
  accessTokenSecret:  string;
  /** HMAC secret used to sign refresh tokens (HS* algorithms). **Change in production.** */
  refreshTokenSecret: string;

  /**
   * PEM-encoded **private** key used to sign access tokens (RS* / ES* algorithms).
   * Required when `alg` is RS* or ES*.
   */
  accessTokenPrivateKey?: string;
  /**
   * PEM-encoded **public** key used to verify access tokens (RS* / ES* algorithms).
   * Required when `alg` is RS* or ES*.
   */
  accessTokenPublicKey?: string;
  /**
   * PEM-encoded **private** key used to sign refresh tokens (RS* / ES* algorithms).
   * Falls back to `accessTokenPrivateKey` when absent.
   */
  refreshTokenPrivateKey?: string;
  /**
   * PEM-encoded **public** key used to verify refresh tokens (RS* / ES* algorithms).
   * Falls back to `accessTokenPublicKey` when absent.
   */
  refreshTokenPublicKey?: string;

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
   * Used as the fallback `sub` claim when `payload()` does not set one.
   * Defaults to `(user) => user.username`.
   */
  username:           (user: UserRecord) => string;
  /**
   * Fetch a user record by subject (username or stable ID).
   * Return `undefined` (or any falsy value) when the user does not exist.
   */
  fetchUser:          (sub: string) => UserRecord | undefined | Promise<UserRecord | undefined>;
  /**
   * Return `true` when the supplied plain-text `password` is valid for
   * `user`, `false` otherwise.
   *
   * The default implementation compares SHA-256 hashes; replace with a
   * timing-safe bcrypt/argon2 check in production.
   */
  isPasswordValid:    (user: UserRecord, password: string) => boolean | Promise<boolean>;
  /**
   * Build the JWT access-token payload for a user.
   * The `iss`, `iat`, and `exp` claims are added automatically.
   * When `sub` is absent from the returned object, `config.username(user)`
   * is used as the fallback.
   */
  payload:            (user: UserRecord) => Partial<TokenPayload> | Promise<Partial<TokenPayload>>;
  /**
   * Refresh-token store.  When absent, refresh tokens are **not** issued:
   * `POST /auth/login` omits `refreshToken` from its response, and
   * `POST /auth/refresh` responds with `501 Not Implemented`.
   *
   * Use {@link createMapTokenStore} for a simple in-process store, or supply
   * a custom adapter that implements {@link TokenStore}.
   */
  refreshTokenStore?: TokenStore;
}

/** Result returned by internal authentication / token-issue functions. */
type AuthResult =
  | { success: true;  accessToken: string; refreshToken?: string;
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
// Token store factory
// ---------------------------------------------------------------------------

/**
 * Create an in-process {@link TokenStore} backed by a `Map`.
 *
 * Expired records are cleaned up lazily on `get()` — no background timer is
 * needed.  This store is **not** suitable for multi-instance deployments
 * because it is local to the current Node.js process.  Replace with a Redis
 * or database adapter for production use.
 *
 * @returns A new {@link TokenStore} instance.
 */
export function createMapTokenStore(): TokenStore {
  const map = new Map<string, RefreshTokenRecord>();

  return {
    set(jti: string, record: RefreshTokenRecord): void {
      map.set(jti, record);
    },

    get(jti: string): RefreshTokenRecord | undefined {
      const record = map.get(jti);
      if (!record) return undefined;
      // Lazy expiry — clean up the record if it has passed its expiry time.
      if (Date.now() > record.expiresAt) {
        map.delete(jti);
        return undefined;
      }
      return record;
    },

    delete(jti: string): void {
      map.delete(jti);
    },

    deleteBySubject(sub: string): void {
      for (const [jti, record] of map) {
        if (record.sub === sub) map.delete(jti);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/** Default configuration values (refreshTokenStore absent — refresh disabled). */
const DEFAULT_CONFIG: Omit<JwtConfig, 'refreshTokenStore'> = {
  accessTokenSecret:  'access-secret-change-in-production',
  refreshTokenSecret: 'refresh-secret-change-in-production',
  accessTokenExpiry:  15 * 60,         // 15 minutes
  refreshTokenExpiry: 7 * 24 * 3600,   // 7 days
  issuer:             'jwt-auth',
  checkIssuer:        false,
  alg:                'HS256',

  username:  (user) => user.username,
  fetchUser: (sub)  => userDatabase.get(sub),

  isPasswordValid: (user, password) => user.passwordHash === hashPassword(password),

  payload: (user) => ({
    sub:         user.username,
    roles:       user.roles,
    permissions: user.permissions,
  }),
};

// ---------------------------------------------------------------------------
// Algorithm helpers
// ---------------------------------------------------------------------------

/** True for HMAC-based algorithms (HS256 / HS384 / HS512). */
function isHmac(alg: JwtAlgorithm): boolean { return alg.startsWith('H'); }

/** True for ECDSA-based algorithms (ES256 / ES384 / ES512). */
function isEc(alg: JwtAlgorithm): boolean { return alg.startsWith('E'); }

/**
 * Return the Node.js crypto hash algorithm string for a JwtAlgorithm.
 * e.g. 'RS256' → 'SHA256', 'ES384' → 'SHA384'.
 */
function nodeHashAlg(alg: JwtAlgorithm): string { return `SHA${alg.slice(2)}`; }

/**
 * Return the fixed byte length of each scalar (r or s) for an ECDSA curve.
 *
 * | Algorithm | Curve | Byte length |
 * |-----------|-------|-------------|
 * | ES256     | P-256 | 32          |
 * | ES384     | P-384 | 48          |
 * | ES512     | P-521 | 66          |
 */
function ecByteLength(alg: JwtAlgorithm): number {
  if (alg === 'ES256') return 32;
  if (alg === 'ES384') return 48;
  if (alg === 'ES512') return 66;
  throw new Error(`Not an EC algorithm: ${alg}`);
}

// ---------------------------------------------------------------------------
// DER ↔ JOSE signature conversion (ECDSA only)
// ---------------------------------------------------------------------------

/**
 * Encode a DER length field.
 * Uses short form for values < 128, otherwise one- or two-byte long form.
 */
function encodeDerLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, len >> 8, len & 0xff]);
}

/**
 * Convert a DER-encoded ECDSA signature (as produced by Node.js
 * `crypto.sign()`) into the compact IEEE P1363 / JOSE format required by JWT:
 * the concatenation of the fixed-width big-endian encodings of `r` and `s`.
 *
 * DER structure: `SEQUENCE { INTEGER r, INTEGER s }`
 *
 * @param der - DER-encoded ECDSA signature buffer.
 * @param alg - ECDSA algorithm identifier used to determine the byte width.
 * @returns A buffer of length `2 * ecByteLength(alg)`.
 */
function derToJose(der: Buffer, alg: JwtAlgorithm): Buffer {
  const n = ecByteLength(alg);
  let i   = 0;

  // SEQUENCE tag (0x30)
  if (der[i++] !== 0x30) throw new Error('ECDSA DER: expected SEQUENCE tag 0x30');

  // SEQUENCE length (may be multi-byte for ES512)
  if (der[i] & 0x80) i += (der[i] & 0x7f) + 1;
  else i++;

  /** Parse a single DER INTEGER and return its unsigned value as a Buffer. */
  function readInt(): Buffer {
    if (der[i++] !== 0x02) throw new Error('ECDSA DER: expected INTEGER tag 0x02');
    let len = der[i++];
    if (len & 0x80) {
      const nb = len & 0x7f;
      len = 0;
      for (let k = 0; k < nb; k++) len = (len << 8) | der[i++];
    }
    // Skip the leading 0x00 padding byte used to mark a positive integer.
    if (der[i] === 0x00 && len > 1) { i++; len--; }
    const val = der.slice(i, i + len);
    i += len;
    return val;
  }

  const r = readInt();
  const s = readInt();

  const out = Buffer.alloc(2 * n, 0);
  // Right-align within each fixed-width half (leading zeros already in buf).
  r.copy(out, n - r.length);
  s.copy(out, 2 * n - s.length);
  return out;
}

/**
 * Convert a compact IEEE P1363 / JOSE ECDSA signature (as used in JWT) back
 * to the DER format expected by Node.js `crypto.verify()`.
 *
 * @param jose - Buffer of length `2 * ecByteLength(alg)` containing `r || s`.
 * @param alg  - ECDSA algorithm identifier used to determine the byte width.
 * @returns A DER-encoded ECDSA signature buffer.
 */
function joseToDer(jose: Buffer, alg: JwtAlgorithm): Buffer {
  const n = ecByteLength(alg);
  const r = jose.slice(0, n);
  const s = jose.slice(n);

  /**
   * Encode an unsigned integer as a DER INTEGER:
   * strips leading zeros, prepends 0x00 when the MSB would be set,
   * then wraps with tag (0x02) and length.
   */
  function encodeInt(buf: Buffer): Buffer {
    // Trim leading zeros (but keep at least one byte).
    let start = 0;
    while (start < buf.length - 1 && buf[start] === 0x00) start++;
    const trimmed = buf.slice(start);
    // Prepend 0x00 if the MSB would be interpreted as a sign bit.
    const padded = (trimmed[0] & 0x80)
      ? Buffer.concat([Buffer.from([0x00]), trimmed])
      : trimmed;
    return Buffer.concat([Buffer.from([0x02, padded.length]), padded]);
  }

  const rDer      = encodeInt(r);
  const sDer      = encodeInt(s);
  const content   = Buffer.concat([rDer, sDer]);
  const lenBuf    = encodeDerLength(content.length);

  return Buffer.concat([Buffer.from([0x30]), lenBuf, content]);
}

// ---------------------------------------------------------------------------
// JWT utilities — manual Base64URL + sign/verify implementation
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
 * Compute the Base64URL-encoded signature for a JWT signing input
 * (`"<encodedHeader>.<encodedPayload>"`).
 *
 * Dispatches to the correct signing primitive based on `alg`:
 * - **HS*** — `crypto.createHmac()` with `key` as shared secret.
 * - **RS*** — `crypto.sign()` with `key` as PEM RSA private key (PKCS#1 v1.5).
 * - **ES*** — `crypto.sign()` with `key` as PEM EC private key; the resulting
 *   DER-encoded signature is converted to compact JOSE (P1363) format.
 *
 * @param encodedHeader  - Base64URL-encoded JWT header.
 * @param encodedPayload - Base64URL-encoded JWT payload.
 * @param key            - HMAC secret (HS*) or PEM private key (RS* / ES*).
 * @param alg            - JWT algorithm identifier.
 * @returns Base64URL-encoded signature string.
 */
function computeSignature(
  encodedHeader:  string,
  encodedPayload: string,
  key:            string,
  alg:            JwtAlgorithm,
): string {
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  if (isHmac(alg)) {
    return crypto
      .createHmac(`sha${alg.slice(2)}`, key)
      .update(signingInput)
      .digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  // Asymmetric: RS* or ES*
  const hashAlg   = nodeHashAlg(alg); // e.g. 'SHA256'
  const derOrRaw  = crypto.sign(hashAlg, Buffer.from(signingInput), key);
  const sigBytes  = isEc(alg) ? derToJose(derOrRaw, alg) : derOrRaw;

  return sigBytes.toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Verify the signature of a JWT against the provided key.
 *
 * For HS* algorithms: computes the expected HMAC and compares using
 * `crypto.timingSafeEqual()` to prevent timing attacks.
 *
 * For RS* / ES* algorithms: converts the Base64URL signature back to the format
 * expected by Node.js (`raw` for RSA, `DER` for ECDSA) then calls
 * `crypto.verify()`.
 *
 * @param encodedHeader  - Base64URL-encoded JWT header.
 * @param encodedPayload - Base64URL-encoded JWT payload.
 * @param b64sig         - Base64URL-encoded signature from the token.
 * @param key            - HMAC secret (HS*) or PEM public key (RS* / ES*).
 * @param alg            - JWT algorithm identifier.
 * @returns `true` when the signature is valid, `false` otherwise.
 */
function checkSignature(
  encodedHeader:  string,
  encodedPayload: string,
  b64sig:         string,
  key:            string,
  alg:            JwtAlgorithm,
): boolean {
  if (isHmac(alg)) {
    const expected    = computeSignature(encodedHeader, encodedPayload, key, alg);
    const sigBuf      = Buffer.from(b64sig);
    const expectedBuf = Buffer.from(expected);
    return sigBuf.length === expectedBuf.length &&
           crypto.timingSafeEqual(sigBuf, expectedBuf);
  }

  // Asymmetric verification.
  try {
    const hashAlg  = nodeHashAlg(alg);
    const rawSig   = Buffer.from(b64sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const verBuf   = isEc(alg) ? joseToDer(rawSig, alg) : rawSig;
    const input    = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    return crypto.verify(hashAlg, input, key, verBuf);
  } catch {
    return false;
  }
}

/**
 * Sign a payload object and return a compact JWT string.
 *
 * Automatically adds the `iat` (issued-at) and `exp` (expiration) claims,
 * overriding any values already present in `payload`.
 *
 * @param payload   - JWT payload claims (must be JSON-serialisable).
 * @param key       - HMAC secret (HS*) or PEM private key (RS* / ES*).
 * @param expiresIn - Validity window in **seconds** from the current time.
 * @param alg       - Signing algorithm. Defaults to `'HS256'`.
 * @returns A compact JWT string in the form `header.payload.signature`.
 */
function signToken(
  payload:   Partial<TokenPayload>,
  key:       string,
  expiresIn: number,
  alg:       JwtAlgorithm = 'HS256',
): string {
  const now           = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlEncode({ alg, typ: 'JWT' });
  const fullPayload   = base64UrlEncode({ ...payload, iat: now, exp: now + expiresIn });
  const signature     = computeSignature(encodedHeader, fullPayload, key, alg);
  return `${encodedHeader}.${fullPayload}.${signature}`;
}

/**
 * Verify a compact JWT string and return its decoded payload on success.
 *
 * Performs the following checks in order:
 * 1. Structural validity (exactly three dot-separated segments).
 * 2. Algorithm consistency (header `alg` matches the expected `alg`).
 * 3. Signature integrity.
 * 4. Expiration (`exp` claim is in the future).
 *
 * All errors are returned as `{ valid: false, error }` — no exception is
 * thrown to the caller.
 *
 * @param token - The compact JWT string to verify.
 * @param key   - HMAC secret (HS*) or PEM public key (RS* / ES*).
 * @param alg   - Expected signing algorithm.
 * @returns A {@link VerifyResult} discriminated union.
 */
function verifyToken(token: string, key: string, alg: JwtAlgorithm): VerifyResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 3)
      return { valid: false, error: 'Invalid token format' };

    const [encodedHeader, encodedPayload, signature] = parts;

    const decodedHeader = base64UrlDecode(encodedHeader) as { alg?: string; typ?: string };
    if (decodedHeader.alg !== alg)
      return { valid: false, error: 'Unauthorised signing algorithm' };

    if (!checkSignature(encodedHeader, encodedPayload, signature, key, alg))
      return { valid: false, error: 'Invalid signature' };

    const payload = base64UrlDecode(encodedPayload) as TokenPayload;
    const now     = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now)
      return { valid: false, error: 'Token expired' };

    return { valid: true, payload };
  } catch {
    return { valid: false, error: 'Malformed token' };
  }
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

/**
 * Resolve the key used to **sign** access tokens.
 * Returns the PEM private key for RS* / ES* algorithms, or the shared secret
 * for HS* algorithms.
 */
function accessSignKey(cfg: JwtConfig): string {
  return isHmac(cfg.alg)
    ? cfg.accessTokenSecret
    : (cfg.accessTokenPrivateKey!);
}

/**
 * Resolve the key used to **verify** access tokens.
 * Returns the PEM public key for RS* / ES* algorithms, or the shared secret
 * for HS* algorithms.
 */
function accessVerifyKey(cfg: JwtConfig): string {
  return isHmac(cfg.alg)
    ? cfg.accessTokenSecret
    : (cfg.accessTokenPublicKey!);
}

/**
 * Resolve the key used to **sign** refresh tokens.
 * Falls back to the access-token private key when no refresh-specific key
 * is configured.
 */
function refreshSignKey(cfg: JwtConfig): string {
  return isHmac(cfg.alg)
    ? cfg.refreshTokenSecret
    : (cfg.refreshTokenPrivateKey ?? cfg.accessTokenPrivateKey!);
}

/**
 * Resolve the key used to **verify** refresh tokens.
 * Falls back to the access-token public key when no refresh-specific key
 * is configured.
 */
function refreshVerifyKey(cfg: JwtConfig): string {
  return isHmac(cfg.alg)
    ? cfg.refreshTokenSecret
    : (cfg.refreshTokenPublicKey ?? cfg.accessTokenPublicKey!);
}

/**
 * Authenticate a user by username and password and, on success, issue a new
 * access token (and refresh token if a store is configured).
 *
 * @param username - The username supplied by the client.
 * @param password - The plain-text password supplied by the client.
 * @param config   - Resolved plugin configuration.
 * @returns An {@link AuthResult} discriminated union.
 */
async function authenticateUser(username: string, password: string, config: JwtConfig): Promise<AuthResult> {
  const user = await config.fetchUser(username);
  if (!user) return { success: false, error: 'User not found' };

  if (!await config.isPasswordValid(user, password))
    return { success: false, error: 'Incorrect password' };

  return issueTokenPair(user, config);
}

/**
 * Build and store a new access token (and refresh token) for the given user.
 *
 * When `config.refreshTokenStore` is absent no refresh token is issued and
 * the response omits the `refreshToken` field.  When a store is present, a
 * signed JWT refresh token is generated with a UUID v4 `jti` claim, the
 * corresponding record is written to the store, and the full token string is
 * returned.
 *
 * @param user   - The authenticated user record.
 * @param config - Resolved plugin configuration.
 * @returns An {@link AuthResult} with `success: true`.
 */
async function issueTokenPair(user: UserRecord, config: JwtConfig): Promise<AuthResult> {
  const claims = await config.payload(user);

  // Inject standard claims; caller-supplied claims take precedence.
  const fullClaims: Partial<TokenPayload> = {
    sub: config.username(user),   // fallback subject — overridden by payload() if it sets sub
    ...claims,
    iss: config.issuer,
  };

  const accessToken = signToken(fullClaims, accessSignKey(config), config.accessTokenExpiry, config.alg);

  if (!config.refreshTokenStore) {
    // No store configured — issue access token only.
    return { success: true, accessToken, expiresIn: config.accessTokenExpiry, tokenType: 'Bearer' };
  }

  // Issue a signed JWT refresh token identified by a unique JTI.
  const jti = crypto.randomUUID();
  const sub  = fullClaims.sub!;

  const refreshClaims: Partial<TokenPayload> = {
    sub, jti, type: 'refresh', iss: config.issuer,
  };

  const refreshToken = signToken(refreshClaims, refreshSignKey(config), config.refreshTokenExpiry, config.alg);

  await config.refreshTokenStore.set(jti, {
    sub,
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
 * Renew an access token using a valid refresh token JWT.
 *
 * Implements **refresh token rotation**: the presented JTI is always
 * invalidated and a brand-new pair is issued on success.  A stolen refresh
 * token can only be used once before it is invalidated by the legitimate
 * holder's next renewal.
 *
 * @param refreshToken - The signed JWT refresh token string.
 * @param config       - Resolved plugin configuration.
 * @returns An {@link AuthResult} discriminated union.
 */
async function renewAccessToken(refreshToken: string, config: JwtConfig): Promise<AuthResult> {
  if (!config.refreshTokenStore)
    return { success: false, error: 'Refresh tokens are not configured' };

  // Verify the refresh token JWT (uses refreshVerifyKey, not accessVerifyKey).
  const result = verifyToken(refreshToken, refreshVerifyKey(config), config.alg);
  if (!result.valid)
    return { success: false, error: 'Invalid or revoked refresh token' };

  const refreshPayload = result.payload as TokenPayload & { jti?: string; type?: string };
  if (refreshPayload.type !== 'refresh')
    return { success: false, error: 'Invalid token type' };

  const jti = refreshPayload.jti;
  if (!jti)
    return { success: false, error: 'Invalid refresh token: missing jti' };

  // Validate against the store (catches revoked or already-rotated tokens).
  const record = await config.refreshTokenStore.get(jti);
  if (!record)
    return { success: false, error: 'Invalid or revoked refresh token' };

  const user = await config.fetchUser(record.sub);
  if (!user) {
    await config.refreshTokenStore.delete(jti);
    return { success: false, error: 'User not found' };
  }

  // Rotate: invalidate the consumed JTI before issuing a new pair.
  await config.refreshTokenStore.delete(jti);
  return issueTokenPair(user, config);
}

/**
 * Revoke a refresh token by extracting its JTI and removing it from the
 * store.  Idempotent — revoking an already-revoked or malformed token is not
 * an error.
 *
 * @param refreshToken - The signed JWT refresh token string to revoke.
 * @param config       - Resolved plugin configuration.
 */
async function revokeRefreshToken(refreshToken: string, config: JwtConfig): Promise<void> {
  if (!config.refreshTokenStore) return;

  const result = verifyToken(refreshToken, refreshVerifyKey(config), config.alg);
  if (!result.valid) return;

  const jti = (result.payload as any).jti as string | undefined;
  if (jti) await config.refreshTokenStore.delete(jti);
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
 * import { createRouter, json, createJwtPlugin, createMapTokenStore } from 'expediate';
 *
 * const auth = createJwtPlugin({
 *   accessTokenSecret:  process.env.JWT_ACCESS_SECRET!,
 *   refreshTokenSecret: process.env.JWT_REFRESH_SECRET!,
 *   refreshTokenStore:  createMapTokenStore(),
 * });
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
   * On success: responds with `{ accessToken, expiresIn, tokenType }`.
   * When a `refreshTokenStore` is configured, also includes `{ refreshToken }`.
   */
  login: Middleware;
  /**
   * Route handler for `POST /auth/refresh`.
   * Expects a JSON body with `{ refreshToken }`.
   * Returns `501` when no `refreshTokenStore` is configured.
   * On success: responds with a new `{ accessToken, refreshToken, ... }` pair.
   */
  refresh: Middleware;
  /**
   * Route handler for `POST /auth/logout`.
   * Expects a JSON body with `{ refreshToken }` (optional).
   * Always responds with 200; revokes the refresh token if provided and valid.
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
 * For **asymmetric algorithms** (RS* / ES*) you must provide at minimum
 * `accessTokenPrivateKey` and `accessTokenPublicKey` in addition to setting
 * `alg`.  The refresh-token keys fall back to the access-token keys when
 * `refreshTokenPrivateKey` / `refreshTokenPublicKey` are not set.
 *
 * Refresh tokens are only issued when `refreshTokenStore` is provided.
 * Use {@link createMapTokenStore} for a simple in-process store.
 *
 * @param userConfig - Partial {@link JwtConfig} overrides.
 * @returns A {@link JwtPlugin} object exposing handlers and middleware.
 * @throws {Error} When `alg` is RS* or ES* but the required PEM keys are absent.
 */
export function createJwtPlugin(userConfig: Partial<JwtConfig> = {}): JwtPlugin {
  const config: JwtConfig = { ...DEFAULT_CONFIG, ...userConfig };

  // Validate asymmetric key requirements up front.
  if (!isHmac(config.alg)) {
    if (!config.accessTokenPrivateKey || !config.accessTokenPublicKey) {
      throw new Error(
        `Algorithm '${config.alg}' requires both 'accessTokenPrivateKey' and ` +
        `'accessTokenPublicKey' in JwtConfig.`,
      );
    }
  }

  /**
   * Write a JSON response.  Sets `Content-Type` explicitly since the router's
   * `res.send()` does not add it automatically.
   */
  function sendJson(res: RouterResponse, status: number, data: object): void {
    const body = JSON.stringify(data);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).send(body);
  }

  // ── POST /auth/login ────────────────────────────────────────────────────

  /**
   * Login handler.  Reads `{ username, password }` from `req.body` (requires
   * a JSON body-parsing middleware such as `json()` to run first).
   * When `refreshTokenStore` is absent the response omits `refreshToken`.
   */
  const login: Middleware = (req: RouterRequest, res: RouterResponse): void => {
    (async () => {
      const { username, password } = (req as any).body ?? {};

      if (!username || !password) {
        sendJson(res, 400, { error: "Fields 'username' and 'password' are required" });
        return;
      }

      const result = await authenticateUser(username, password, config);

      if (!result.success) {
        sendJson(res, 401, { error: result.error });
        return;
      }

      const body: Record<string, unknown> = {
        message:     'Authentication successful',
        accessToken: result.accessToken,
        expiresIn:   result.expiresIn,
        tokenType:   result.tokenType,
      };
      if (result.refreshToken !== undefined) body.refreshToken = result.refreshToken;

      sendJson(res, 200, body);
    })().catch(() => sendJson(res, 500, { error: 'Internal server error' }));
  };

  // ── POST /auth/refresh ──────────────────────────────────────────────────

  /**
   * Token-renewal handler.  Reads `{ refreshToken }` from `req.body`.
   * Responds with 501 when no `refreshTokenStore` is configured.
   */
  const refresh: Middleware = (req: RouterRequest, res: RouterResponse): void => {
    (async () => {
      if (!config.refreshTokenStore) {
        sendJson(res, 501, { error: 'Refresh tokens are not configured' });
        return;
      }

      const { refreshToken } = (req as any).body ?? {};

      if (!refreshToken) {
        sendJson(res, 400, { error: "Field 'refreshToken' is required" });
        return;
      }

      const result = await renewAccessToken(refreshToken, config);

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
    })().catch(() => sendJson(res, 500, { error: 'Internal server error' }));
  };

  // ── POST /auth/logout ───────────────────────────────────────────────────

  /**
   * Logout handler.  Optionally reads `{ refreshToken }` from `req.body` and
   * revokes it.  Always responds with 200 regardless of whether a token was
   * provided (to avoid leaking information about token existence).
   */
  const logout: Middleware = (req: RouterRequest, res: RouterResponse): void => {
    (async () => {
      const { refreshToken } = (req as any).body ?? {};

      if (refreshToken && config.refreshTokenStore) {
        await revokeRefreshToken(refreshToken, config);
      }

      sendJson(res, 200, { message: 'Logged out successfully' });
    })().catch(() => sendJson(res, 500, { error: 'Internal server error' }));
  };

  // ── authenticate middleware ─────────────────────────────────────────────

  /**
   * Validate the `Authorization: Bearer <token>` header and populate
   * `req.user` with the decoded access-token payload.
   *
   * Designed to be **non-blocking**: missing or invalid tokens cause `next()`
   * to be called without error, deferring the authentication decision to the
   * next middleware (typically {@link authorize} or a custom guard).
   *
   * `req.user` is explicitly cleared at the start of each invocation to
   * prevent stale data from leaking across requests.
   */
  const authenticate: Middleware = (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    // Always clear any previously set user to prevent cross-request contamination.
    delete (req as any).user;

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return next();

    const token  = authHeader.slice(7);
    const result = verifyToken(token, accessVerifyKey(config), config.alg);
    if (!result.valid) return next();

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
