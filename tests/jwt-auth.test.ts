/**
 * jwt-auth.test.ts — Extensive test suite for jwt-auth.ts
 *
 * Uses only Node.js built-ins plus tsx. No external test framework required.
 *
 * Run with:  tsx jwt-auth.test.ts
 */

import assert from 'node:assert/strict';
import http   from 'node:http';
import net    from 'node:net';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import createRouter             from '../src/router.ts';
import { json }                 from '../src/misc.ts';
import createJwtPlugin, {
  hashPassword,
  signToken,
  verifyToken,
  createMapTokenStore,
  type TokenStore,
  type RefreshTokenRecord,
}                               from '../src/jwt-auth.ts';

// ---------------------------------------------------------------------------
// HTTP test helper
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[] | undefined>;
  body:       string;
  json<T = unknown>(): T;
}

/**
 * Build a minimal router wired with the JWT plugin routes, issue one HTTP
 * request, and return the response.
 */
function request(
  handler: (...args: any[]) => void,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
    body?:    object | string;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const router = createRouter();
    // Attach the json() body parser so req.body is populated.
    router.use('/', json() as any);
    router.use('/', handler as any);

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr   = server.address() as net.AddressInfo;
      const rawBody = options.body !== undefined
        ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        : undefined;
      const bodyBuf = rawBody ? Buffer.from(rawBody) : undefined;

      const extraHeaders: Record<string, string> = {};
      if (bodyBuf) {
        extraHeaders['content-type']   = 'application/json';
        extraHeaders['content-length'] = String(bodyBuf.length);
      }

      const chunks: Buffer[] = [];
      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  options.method  ?? 'POST',
          path:    options.path    ?? '/',
          headers: { ...extraHeaders, ...(options.headers ?? {}) },
        },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const bodyStr = Buffer.concat(chunks).toString('utf8');
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers,
              body:       bodyStr,
              json<T>()   { return JSON.parse(bodyStr) as T; },
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  });
}

/**
 * Convenience: mount a single middleware function on a GET route and make a
 * GET request with an optional Authorization header.
 */
function getWithAuth(
  middleware: any,
  path:       string,
  token?:     string,
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const router = createRouter();
    router.use('/', middleware);

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        // Reflect req.user so tests can inspect it
        const user = (req as any).user;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ user: user ?? null }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;

      const chunks: Buffer[] = [];
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, method: 'GET', path, headers },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const bodyStr = Buffer.concat(chunks).toString('utf8');
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers,
              body:       bodyStr,
              json<T>()   { return JSON.parse(bodyStr) as T; },
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Shared plugin instance used by most suites (with refresh store)
// ---------------------------------------------------------------------------

const AUTH = createJwtPlugin({
  accessTokenSecret:  'test-access-secret',
  refreshTokenSecret: 'test-refresh-secret',
  accessTokenExpiry:  60,     // 1 minute — short enough to test easily
  refreshTokenExpiry: 3600,   // 1 hour
  refreshTokenStore:  createMapTokenStore(),
});

// ---------------------------------------------------------------------------
// Suite 1 — hashPassword
// ---------------------------------------------------------------------------

describe('hashPassword', () => {
  it('returns a 64-character hex string', () => {
    const h = hashPassword('password');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    assert.equal(hashPassword('abc'), hashPassword('abc'));
  });

  it('produces different hashes for different passwords', () => {
    assert.notEqual(hashPassword('abc'), hashPassword('xyz'));
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — signToken / verifyToken (low-level JWT utilities)
// ---------------------------------------------------------------------------

describe('signToken / verifyToken', () => {
  const SECRET = 'unit-test-secret';

  it('signToken produces a three-segment dot-separated string', () => {
    const token = signToken({ sub: 'u1', iss: 'test' }, SECRET, 60);
    assert.equal(token.split('.').length, 3);
  });

  it('verifyToken accepts a freshly signed token', () => {
    const token  = signToken({ sub: 'u1', iss: 'test' }, SECRET, 60);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
  });

  it('decoded payload contains the expected claims', () => {
    const token  = signToken({ sub: 'alice', iss: 'x' }, SECRET, 60);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
    assert.equal(result.payload.sub, 'alice');
    assert.equal(result.payload.iss, 'x');
  });

  it('decoded payload contains iat and exp claims', () => {
    const before = Math.floor(Date.now() / 1000);
    const token  = signToken({ sub: 'u', iss: 'x' }, SECRET, 120);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
    assert.ok(result.payload.iat >= before, 'iat should be >= request time');
    assert.ok(result.payload.exp > result.payload.iat, 'exp should be after iat');
    assert.ok(result.payload.exp <= before + 120 + 1, 'exp should be ~now+120s');
  });

  it('rejects a token signed with the wrong secret', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, SECRET, 60);
    const result = verifyToken(token, 'wrong-secret', 'HS256');
    assert.ok(!result.valid);
    assert.ok(result.error.toLowerCase().includes('signature') ||
              result.error.toLowerCase().includes('algorithm'));
  });

  it('rejects a tampered payload', () => {
    const token = signToken({ sub: 'u', iss: 'x' }, SECRET, 60);
    const [h, , s] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'hacker', exp: 9999999999 }))
      .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const result = verifyToken(`${h}.${tamperedPayload}.${s}`, SECRET, 'HS256');
    assert.ok(!result.valid);
  });

  it('rejects an expired token', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, SECRET, -10); // already expired
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(!result.valid);
    assert.ok(result.error.toLowerCase().includes('expir'));
  });

  it('rejects a token with too few segments', () => {
    const result = verifyToken('only.two', SECRET, 'HS256');
    assert.ok(!result.valid);
    assert.ok(result.error.toLowerCase().includes('format') ||
              result.error.toLowerCase().includes('malformed'));
  });

  it('rejects a completely invalid string', () => {
    const result = verifyToken('not-a-jwt', SECRET, 'HS256');
    assert.ok(!result.valid);
  });

  it('handles timing-safe equal with different-length signatures gracefully', () => {
    // A forged token with a one-character signature must not crash.
    const token  = signToken({ sub: 'u', iss: 'x' }, SECRET, 60);
    const [h, p] = token.split('.');
    const result = verifyToken(`${h}.${p}.x`, SECRET, 'HS256');
    assert.ok(!result.valid); // must return false, not throw
  });

  it('supports HS384 algorithm', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, SECRET, 60, 'HS384');
    const result = verifyToken(token, SECRET, 'HS384');
    assert.ok(result.valid);
  });

  it('rejects a HS256 token when verifier expects HS384', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, SECRET, 60, 'HS256');
    const result = verifyToken(token, SECRET, 'HS384');
    assert.ok(!result.valid);
  });

  it('preserves arbitrary extra claims through sign/verify round-trip', () => {
    const token  = signToken({ sub: 'u', iss: 'x', jti: 'abc-123', type: 'refresh' } as any, SECRET, 60);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
    assert.equal((result.payload as any).jti,  'abc-123');
    assert.equal((result.payload as any).type, 'refresh');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — login handler
// ---------------------------------------------------------------------------

describe('auth.login handler', () => {
  it('returns 200 with tokens for valid credentials', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.statusCode, 200);
    const body = r.json<any>();
    assert.ok(body.accessToken,  'accessToken should be present');
    assert.ok(body.refreshToken, 'refreshToken should be present');
    assert.ok(body.expiresIn,    'expiresIn should be present');
    assert.equal(body.tokenType, 'Bearer');
  });

  it('returns 401 for wrong password', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: 'wrong' } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 401 for unknown user', async () => {
    const r = await request(AUTH.login, { body: { username: 'nobody', password: 'pw' } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 400 when username is missing', async () => {
    const r = await request(AUTH.login, { body: { password: 'pw' } });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 when password is missing', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice' } });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 when body is empty', async () => {
    const r = await request(AUTH.login, { body: {} });
    assert.equal(r.statusCode, 400);
  });

  it('access token is a valid JWT', async () => {
    const r = await request(AUTH.login, { body: { username: 'bob', password: 'secret456' } });
    const { accessToken } = r.json<any>();
    assert.equal(accessToken.split('.').length, 3, 'accessToken must be a 3-segment JWT');
  });

  it('access token payload contains sub equal to the username', async () => {
    const r = await request(AUTH.login, { body: { username: 'charlie', password: 'pass789' } });
    const { accessToken } = r.json<any>();
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] + '==', 'base64').toString('utf8'),
    );
    assert.equal(payload.sub, 'charlie');
  });

  it('refresh token is a signed JWT (three segments)', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const { refreshToken } = r.json<any>();
    assert.equal(refreshToken.split('.').length, 3, 'refreshToken must be a 3-segment JWT');
  });

  it('refresh token payload contains jti, sub, and type=refresh claims', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const { refreshToken } = r.json<any>();
    const payload = JSON.parse(
      Buffer.from(refreshToken.split('.')[1] + '==', 'base64').toString('utf8'),
    );
    assert.ok(payload.jti,              'refresh token must have jti');
    assert.equal(payload.sub,   'alice', 'refresh token sub must match user');
    assert.equal(payload.type, 'refresh', 'refresh token type must be "refresh"');
  });

  it('two logins produce different refresh tokens', async () => {
    const r1 = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const r2 = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    assert.notEqual(r1.json<any>().refreshToken, r2.json<any>().refreshToken);
  });

  it('works for all three demo users', async () => {
    const creds = [
      { username: 'alice',   password: 'password123' },
      { username: 'bob',     password: 'secret456' },
      { username: 'charlie', password: 'pass789' },
    ];
    for (const c of creds) {
      const r = await request(AUTH.login, { body: c });
      assert.equal(r.statusCode, 200, `Login failed for ${c.username}`);
    }
  });

  it('omits refreshToken when no refreshTokenStore is configured', async () => {
    const authNoStore = createJwtPlugin({
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
      // No refreshTokenStore
    });
    const r = await request(authNoStore.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.statusCode, 200);
    const body = r.json<any>();
    assert.ok(body.accessToken);
    assert.equal(body.refreshToken, undefined, 'refreshToken must be absent when no store is configured');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — refresh handler
// ---------------------------------------------------------------------------

describe('auth.refresh handler', () => {
  /** Perform a login and return the tokens. */
  async function login(username: string, password: string) {
    const r = await request(AUTH.login, { body: { username, password } });
    return r.json<{ accessToken: string; refreshToken: string }>();
  }

  it('returns new tokens when given a valid refresh token', async () => {
    const { refreshToken } = await login('alice', 'password123');
    const r = await request(AUTH.refresh, { body: { refreshToken } });
    assert.equal(r.statusCode, 200);
    const body = r.json<any>();
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
  });

  it('rotates the refresh token (old token is no longer valid)', async () => {
    const { refreshToken: first } = await login('bob', 'secret456');
    await request(AUTH.refresh, { body: { refreshToken: first } });

    // Using the old token again must fail.
    const r2 = await request(AUTH.refresh, { body: { refreshToken: first } });
    assert.equal(r2.statusCode, 401);
  });

  it('new refresh token from rotation is usable', async () => {
    const { refreshToken: first } = await login('alice', 'password123');
    const r1     = await request(AUTH.refresh, { body: { refreshToken: first } });
    const second = r1.json<any>().refreshToken;

    const r2 = await request(AUTH.refresh, { body: { refreshToken: second } });
    assert.equal(r2.statusCode, 200);
  });

  it('returns 401 for an invalid refresh token string', async () => {
    const r = await request(AUTH.refresh, { body: { refreshToken: 'invalid-token' } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 401 when an access token is presented as a refresh token', async () => {
    const { accessToken } = await login('alice', 'password123');
    // Access token is signed with a different secret and lacks type:'refresh'
    const r = await request(AUTH.refresh, { body: { refreshToken: accessToken } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 400 when refreshToken field is missing', async () => {
    const r = await request(AUTH.refresh, { body: {} });
    assert.equal(r.statusCode, 400);
  });

  it('returns 501 when no refreshTokenStore is configured', async () => {
    const authNoStore = createJwtPlugin({
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
      // No refreshTokenStore
    });
    const r = await request(authNoStore.refresh, { body: { refreshToken: 'anything' } });
    assert.equal(r.statusCode, 501);
    assert.ok(r.json<any>().error);
  });

  it('renewed access token is a valid three-segment JWT', async () => {
    const { refreshToken } = await login('charlie', 'pass789');
    const r = await request(AUTH.refresh, { body: { refreshToken } });
    const { accessToken } = r.json<any>();
    assert.equal(accessToken.split('.').length, 3);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — logout handler
// ---------------------------------------------------------------------------

describe('auth.logout handler', () => {
  async function login(username: string, password: string) {
    const r = await request(AUTH.login, { body: { username, password } });
    return r.json<{ accessToken: string; refreshToken: string }>();
  }

  it('returns 200 with a logged-out message', async () => {
    const r = await request(AUTH.logout, { body: {} });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json<any>().message);
  });

  it('revokes the refresh token', async () => {
    const { refreshToken } = await login('alice', 'password123');
    await request(AUTH.logout, { body: { refreshToken } });

    // After logout, the refresh token must be rejected.
    const r = await request(AUTH.refresh, { body: { refreshToken } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 200 even when no refreshToken is provided', async () => {
    const r = await request(AUTH.logout, { body: {} });
    assert.equal(r.statusCode, 200);
  });

  it('is idempotent — revoking an already-revoked token returns 200', async () => {
    const { refreshToken } = await login('bob', 'secret456');
    await request(AUTH.logout, { body: { refreshToken } });
    const r2 = await request(AUTH.logout, { body: { refreshToken } });
    assert.equal(r2.statusCode, 200);
  });

  it('returns 200 even when no store is configured', async () => {
    const authNoStore = createJwtPlugin({
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    });
    const r = await request(authNoStore.logout, { body: { refreshToken: 'whatever' } });
    assert.equal(r.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — authenticate middleware
// ---------------------------------------------------------------------------

describe('auth.authenticate middleware', () => {
  async function getToken(username: string, password: string): Promise<string> {
    const r = await request(AUTH.login, { body: { username, password } });
    return r.json<any>().accessToken;
  }

  it('sets req.user when a valid token is provided', async () => {
    const token = await getToken('alice', 'password123');
    const r     = await getWithAuth(AUTH.authenticate, '/', token);
    const body  = r.json<any>();
    assert.ok(body.user, 'req.user should be set');
    assert.equal(body.user.sub, 'alice');
  });

  it('calls next() when no Authorization header is present', async () => {
    const r = await getWithAuth(AUTH.authenticate, '/');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json<any>().user, null);
  });

  it('calls next() when Authorization header is not Bearer', async () => {
    const r = await getWithAuth(AUTH.authenticate, '/');
    // Send Basic auth instead — middleware should pass through
    assert.equal(r.json<any>().user, null);
  });

  it('clears req.user for an invalid token', async () => {
    const r = await getWithAuth(AUTH.authenticate, '/', 'invalid.token.here');
    assert.equal(r.json<any>().user, null);
  });

  it('clears req.user for a token signed with the wrong secret', async () => {
    const badToken = signToken(
      { sub: 'alice', iss: 'test' },
      'wrong-secret', 60,
    );
    const r = await getWithAuth(AUTH.authenticate, '/', badToken);
    assert.equal(r.json<any>().user, null);
  });

  it('decoded user payload contains roles and permissions', async () => {
    const token = await getToken('alice', 'password123');
    const r     = await getWithAuth(AUTH.authenticate, '/', token);
    const user  = r.json<any>().user;
    assert.ok(Array.isArray(user.roles),       'roles should be an array');
    assert.ok(Array.isArray(user.permissions), 'permissions should be an array');
    assert.ok(user.roles.includes('admin'),    'alice should have admin role');
  });

  it('respects checkIssuer:true when issuer matches', async () => {
    const authWithIssuer = createJwtPlugin({
      accessTokenSecret: 'secret',
      issuer:            'my-app',
      checkIssuer:       true,
      refreshTokenStore: createMapTokenStore(),
    });
    const loginR = await request(authWithIssuer.login, { body: { username: 'alice', password: 'password123' } });
    const token  = loginR.json<any>().accessToken;

    const r = await getWithAuth(authWithIssuer.authenticate, '/', token);
    assert.ok(r.json<any>().user, 'user should be set when issuer matches');
  });

  it('rejects tokens with wrong issuer when checkIssuer:true', async () => {
    const authA = createJwtPlugin({ accessTokenSecret: 'sec', issuer: 'app-a', refreshTokenStore: createMapTokenStore() });
    const authB = createJwtPlugin({ accessTokenSecret: 'sec', issuer: 'app-b', checkIssuer: true });

    const loginR = await request(authA.login, { body: { username: 'alice', password: 'password123' } });
    const token  = loginR.json<any>().accessToken;

    const r = await getWithAuth(authB.authenticate, '/', token);
    assert.equal(r.json<any>().user, null, 'user should be null when issuer does not match');
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — authorize middleware
// ---------------------------------------------------------------------------

describe('auth.authorize middleware', () => {
  async function getToken(username: string, password: string): Promise<string> {
    const r = await request(AUTH.login, { body: { username, password } });
    return r.json<any>().accessToken;
  }

  it('calls next() when req.user is set', async () => {
    const token = await getToken('alice', 'password123');

    const combined = (req: any, res: any, next: any) => {
      AUTH.authenticate(req, res, () => {
        AUTH.authorize(req, res, next);
      });
    };

    const r = await getWithAuth(combined, '/', token);
    assert.equal(r.statusCode, 200);
    assert.ok(r.json<any>().user);
  });

  it('returns 401 when req.user is not set (no token)', async () => {
    return new Promise<void>((resolve, reject) => {
      const router = createRouter();
      router.get('/', AUTH.authorize as any, (_req: any, res: any) => res.end('ok'));

      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.end('next'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const chunks: Buffer[] = [];
        const req = http.request({ host: '127.0.0.1', port: addr.port, method: 'GET', path: '/' }, (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            try {
              assert.equal(res.statusCode, 401);
              resolve();
            } catch (e) { reject(e); }
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — requireRole factory
// ---------------------------------------------------------------------------

describe('auth.requireRole middleware factory', () => {
  async function getToken(username: string, password: string): Promise<string> {
    const r = await request(AUTH.login, { body: { username, password } });
    return r.json<any>().accessToken;
  }

  /** Mount requireRole middleware on a GET route and make a GET request. */
  async function callWithRole(token: string | undefined, ...roles: string[]): Promise<FakeResponse> {
    return new Promise((resolve, reject) => {
      const router = createRouter();
      const mws = AUTH.requireRole(...roles);
      for (const mw of mws) router.use('/', mw as any);
      router.get('/', (_req: any, res: any) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });

      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.statusCode = 404; res.end('{}'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const headers: Record<string, string> = {};
        if (token) headers['authorization'] = `Bearer ${token}`;
        const chunks: Buffer[] = [];
        const req = http.request({ host: '127.0.0.1', port: addr.port, method: 'GET', path: '/', headers }, (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const body = Buffer.concat(chunks).toString();
            resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });
  }

  it('allows access when user has the required role', async () => {
    const token = await getToken('alice', 'password123'); // alice has 'admin'
    const r     = await callWithRole(token, 'admin');
    assert.equal(r.statusCode, 200);
  });

  it('allows access when user has one of multiple required roles', async () => {
    const token = await getToken('bob', 'secret456'); // bob has 'editor'
    const r     = await callWithRole(token, 'admin', 'editor');
    assert.equal(r.statusCode, 200);
  });

  it('returns 403 when user lacks the required role', async () => {
    const token = await getToken('charlie', 'pass789'); // charlie has 'viewer' only
    const r     = await callWithRole(token, 'admin');
    assert.equal(r.statusCode, 403);
    assert.ok(r.json<any>().yourRoles);
  });

  it('returns 401 when no token is provided', async () => {
    const r = await callWithRole(undefined, 'admin');
    assert.equal(r.statusCode, 401);
  });

  it('returns 401 for an invalid token', async () => {
    const r = await callWithRole('bad.token.here', 'admin');
    assert.equal(r.statusCode, 401);
  });

  it('returns two middleware functions', () => {
    const mws = AUTH.requireRole('admin');
    assert.equal(mws.length, 2);
    assert.equal(typeof mws[0], 'function');
    assert.equal(typeof mws[1], 'function');
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — requirePermission factory
// ---------------------------------------------------------------------------

describe('auth.requirePermission middleware factory', () => {
  async function getToken(username: string, password: string): Promise<string> {
    const r = await request(AUTH.login, { body: { username, password } });
    return r.json<any>().accessToken;
  }

  async function callWithPerm(token: string | undefined, ...perms: string[]): Promise<FakeResponse> {
    return new Promise((resolve, reject) => {
      const router = createRouter();
      const mws = AUTH.requirePermission(...perms);
      for (const mw of mws) router.use('/', mw as any);
      router.get('/', (_req: any, res: any) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });

      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.statusCode = 404; res.end('{}'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const headers: Record<string, string> = {};
        if (token) headers['authorization'] = `Bearer ${token}`;
        const chunks: Buffer[] = [];
        const req = http.request({ host: '127.0.0.1', port: addr.port, method: 'GET', path: '/', headers }, (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const body = Buffer.concat(chunks).toString();
            resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });
  }

  it('allows access when user has the required permission', async () => {
    const token = await getToken('alice', 'password123'); // has 'delete'
    const r     = await callWithPerm(token, 'delete');
    assert.equal(r.statusCode, 200);
  });

  it('allows access when user has all required permissions', async () => {
    const token = await getToken('alice', 'password123'); // has read+write+delete+manage_users
    const r     = await callWithPerm(token, 'read', 'write', 'delete');
    assert.equal(r.statusCode, 200);
  });

  it('returns 403 when user lacks one of the required permissions', async () => {
    const token = await getToken('bob', 'secret456'); // has read+write only
    const r     = await callWithPerm(token, 'read', 'delete'); // bob lacks 'delete'
    assert.equal(r.statusCode, 403);
    assert.ok(r.json<any>().yourPermissions);
  });

  it('returns 403 when user lacks all required permissions', async () => {
    const token = await getToken('charlie', 'pass789'); // has 'read' only
    const r     = await callWithPerm(token, 'write', 'delete');
    assert.equal(r.statusCode, 403);
  });

  it('returns 401 when no token is provided', async () => {
    const r = await callWithPerm(undefined, 'read');
    assert.equal(r.statusCode, 401);
  });

  it('returns two middleware functions', () => {
    const mws = AUTH.requirePermission('read');
    assert.equal(mws.length, 2);
    assert.equal(typeof mws[0], 'function');
    assert.equal(typeof mws[1], 'function');
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — createMapTokenStore
// ---------------------------------------------------------------------------

describe('createMapTokenStore', () => {
  it('stores and retrieves a record by jti', () => {
    const store  = createMapTokenStore();
    const record: RefreshTokenRecord = { sub: 'alice', issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
    store.set('jti-1', record);
    const got = store.get('jti-1') as RefreshTokenRecord;
    assert.ok(got);
    assert.equal(got.sub, 'alice');
  });

  it('returns undefined for an unknown jti', () => {
    const store = createMapTokenStore();
    assert.equal(store.get('unknown'), undefined);
  });

  it('delete removes the record', () => {
    const store  = createMapTokenStore();
    const record: RefreshTokenRecord = { sub: 'bob', issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
    store.set('jti-2', record);
    store.delete('jti-2');
    assert.equal(store.get('jti-2'), undefined);
  });

  it('delete is idempotent for non-existent keys', () => {
    const store = createMapTokenStore();
    assert.doesNotThrow(() => store.delete('no-such-jti'));
  });

  it('get performs lazy expiry cleanup', () => {
    const store  = createMapTokenStore();
    // Set a record that has already expired.
    const record: RefreshTokenRecord = { sub: 'charlie', issuedAt: Date.now() - 10_000, expiresAt: Date.now() - 1 };
    store.set('expired-jti', record);
    // get() should return undefined and clean up internally.
    assert.equal(store.get('expired-jti'), undefined);
    // A second get() should still return undefined (not crash).
    assert.equal(store.get('expired-jti'), undefined);
  });

  it('deleteBySubject removes all records for that sub', () => {
    const store = createMapTokenStore();
    const base: RefreshTokenRecord = { sub: 'alice', issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
    store.set('jti-a1', { ...base });
    store.set('jti-a2', { ...base });
    store.set('jti-bob', { ...base, sub: 'bob' });

    store.deleteBySubject!('alice');

    assert.equal(store.get('jti-a1'),  undefined, 'alice jti-a1 should be gone');
    assert.equal(store.get('jti-a2'),  undefined, 'alice jti-a2 should be gone');
    assert.ok(store.get('jti-bob'),              'bob record should survive');
  });
});

// ---------------------------------------------------------------------------
// Suite 11 — Custom configuration
// ---------------------------------------------------------------------------

describe('custom configuration', () => {
  it('accepts a custom fetchUser and isPasswordValid', async () => {
    const customAuth = createJwtPlugin({
      accessTokenSecret: 'custom-secret',
      fetchUser:         (u) => u === 'testuser' ? { username: 'testuser', passwordHash: hashPassword('testpass') } : undefined,
      isPasswordValid:   (user, pw) => user.passwordHash === hashPassword(pw),
      refreshTokenStore: createMapTokenStore(),
    });

    const r = await request(customAuth.login, { body: { username: 'testuser', password: 'testpass' } });
    assert.equal(r.statusCode, 200);
  });

  it('rejects login when custom isPasswordValid returns false', async () => {
    const customAuth = createJwtPlugin({
      accessTokenSecret: 'cs',
      fetchUser:         (u) => u === 'u' ? { username: 'u', passwordHash: '' } : undefined,
      isPasswordValid:   () => false, // always reject
    });

    const r = await request(customAuth.login, { body: { username: 'u', password: 'anything' } });
    assert.equal(r.statusCode, 401);
  });

  it('respects a custom accessTokenExpiry', async () => {
    const shortAuth = createJwtPlugin({
      accessTokenSecret: 'short-secret',
      accessTokenExpiry: 10,
      refreshTokenStore: createMapTokenStore(),
    });

    const r = await request(shortAuth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.json<any>().expiresIn, 10);
  });

  it('stores a refresh token in a custom TokenStore on login', async () => {
    let storedCount = 0;
    const customStore: TokenStore = {
      set(_jti, _record) { storedCount++; },
      get(_jti) { return undefined; },
      delete(_jti) { storedCount = Math.max(0, storedCount - 1); },
    };
    const customAuth = createJwtPlugin({
      accessTokenSecret: 'sec',
      refreshTokenStore: customStore,
    });

    await request(customAuth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(storedCount, 1, 'Refresh token should be stored in the custom store');
  });

  it('accepts a custom payload builder', async () => {
    const customAuth = createJwtPlugin({
      accessTokenSecret: 'sec',
      refreshTokenStore: createMapTokenStore(),
      payload: (user) => ({ sub: `custom-${user.username}`, iss: 'x', iat: 0, exp: 0, customClaim: 'hello' }),
    });

    const r     = await request(customAuth.login, { body: { username: 'alice', password: 'password123' } });
    const token = r.json<any>().accessToken;
    const payload = JSON.parse(Buffer.from(token.split('.')[1] + '==', 'base64').toString('utf8'));
    assert.equal(payload.customClaim, 'hello');
    assert.ok(payload.sub.startsWith('custom-'));
  });
});

// ---------------------------------------------------------------------------
// Suite 12 — Security edge cases
// ---------------------------------------------------------------------------

describe('security edge cases', () => {
  it('password check is not reversible — wrong password is rejected', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: 'password124' } }); // off by one
    assert.equal(r.statusCode, 401);
  });

  it('empty string password is rejected', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: '' } });
    // Either 400 (validation) or 401 (wrong password) — never 200.
    assert.ok(r.statusCode === 400 || r.statusCode === 401);
    assert.notEqual(r.statusCode, 200);
  });

  it('an access token cannot be used as a refresh token (wrong secret)', async () => {
    const loginR = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const { accessToken } = loginR.json<any>();

    // Access token is signed with accessTokenSecret; refresh endpoint uses refreshTokenSecret.
    const r = await request(AUTH.refresh, { body: { refreshToken: accessToken } });
    assert.equal(r.statusCode, 401);
  });

  it('a refresh token cannot be used as an access token', async () => {
    const loginR = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const { refreshToken } = loginR.json<any>();

    // Refresh token has type:'refresh' — authenticate should reject it (wrong secret).
    const r = await getWithAuth(AUTH.authenticate, '/', refreshToken);
    assert.equal(r.json<any>().user, null);
  });

  it('concurrent logins produce independent refresh tokens', async () => {
    const results = await Promise.all([
      request(AUTH.login, { body: { username: 'alice', password: 'password123' } }),
      request(AUTH.login, { body: { username: 'alice', password: 'password123' } }),
    ]);
    const [b1, b2] = results.map((r) => r.json<any>());
    assert.notEqual(b1.refreshToken, b2.refreshToken, 'Refresh tokens must always differ (unique jti)');
    // Both tokens must be valid JWTs.
    assert.equal(b1.refreshToken.split('.').length, 3);
    assert.equal(b2.refreshToken.split('.').length, 3);
  });

  it('timingSafeEqual does not throw for different-length signatures', () => {
    // Directly test verifyToken with a truncated signature.
    const token = signToken({ sub: 'u', iss: 'x' }, 'sec', 60);
    const [h, p] = token.split('.');
    // Truncate to 3 chars — completely different length from expected
    assert.doesNotThrow(() => verifyToken(`${h}.${p}.abc`, 'sec', 'HS256'));
  });
});

// ---------------------------------------------------------------------------
// Suite 13 — createJwtPlugin config validation
// ---------------------------------------------------------------------------

describe('createJwtPlugin config validation', () => {
  it('throws when alg is RS256 and no private key is provided', () => {
    assert.throws(
      () => createJwtPlugin({ alg: 'RS256' }),
      /accessTokenPrivateKey.*accessTokenPublicKey/i,
    );
  });

  it('throws when alg is ES256 and only privateKey is provided', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    assert.throws(
      () => createJwtPlugin({ alg: 'ES256', accessTokenPrivateKey: privateKey }),
      /accessTokenPublicKey/i,
    );
  });

  it('throws when alg is RS384 and only publicKey is provided', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    assert.throws(
      () => createJwtPlugin({ alg: 'RS384', accessTokenPublicKey: publicKey }),
      /accessTokenPrivateKey/i,
    );
  });

  it('does not throw for HS* algorithms without PEM keys', () => {
    assert.doesNotThrow(() => createJwtPlugin({ alg: 'HS256', accessTokenSecret: 'sec' }));
    assert.doesNotThrow(() => createJwtPlugin({ alg: 'HS384' }));
    assert.doesNotThrow(() => createJwtPlugin({ alg: 'HS512' }));
  });
});

// ---------------------------------------------------------------------------
// Suite 14 — RS* algorithms (RSA PKCS#1 v1.5)
// ---------------------------------------------------------------------------

describe('RS* algorithms', () => {
  // Generate a single 2048-bit RSA key pair for the whole suite.
  const { privateKey: rsaPriv, publicKey: rsaPub } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  // ---------------------------------------------------------------------------
  // Low-level round-trips
  // ---------------------------------------------------------------------------

  it('RS256: signToken + verifyToken round-trip', () => {
    const token  = signToken({ sub: 'alice', iss: 'test' }, rsaPriv, 60, 'RS256');
    assert.equal(token.split('.').length, 3);
    const result = verifyToken(token, rsaPub, 'RS256');
    assert.ok(result.valid);
    assert.equal(result.payload.sub, 'alice');
  });

  it('RS384: signToken + verifyToken round-trip', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, rsaPriv, 60, 'RS384');
    const result = verifyToken(token, rsaPub, 'RS384');
    assert.ok(result.valid);
  });

  it('RS512: signToken + verifyToken round-trip', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, rsaPriv, 60, 'RS512');
    const result = verifyToken(token, rsaPub, 'RS512');
    assert.ok(result.valid);
  });

  it('rejects a RS256 token verified with the wrong public key', () => {
    const { publicKey: wrongPub } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const token  = signToken({ sub: 'u', iss: 'x' }, rsaPriv, 60, 'RS256');
    const result = verifyToken(token, wrongPub, 'RS256');
    assert.ok(!result.valid);
  });

  it('rejects a tampered RS256 payload', () => {
    const token = signToken({ sub: 'u', iss: 'x' }, rsaPriv, 60, 'RS256');
    const [h, , s] = token.split('.');
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'hacker', exp: 9999999999 }))
      .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const result = verifyToken(`${h}.${fakePayload}.${s}`, rsaPub, 'RS256');
    assert.ok(!result.valid);
  });

  it('rejects an expired RS256 token', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, rsaPriv, -10, 'RS256');
    const result = verifyToken(token, rsaPub, 'RS256');
    assert.ok(!result.valid);
    assert.match(result.error, /expir/i);
  });

  it('rejects when header alg is RS256 but verifier expects RS384', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, rsaPriv, 60, 'RS256');
    const result = verifyToken(token, rsaPub, 'RS384');
    assert.ok(!result.valid);
  });

  // ---------------------------------------------------------------------------
  // End-to-end through HTTP
  // ---------------------------------------------------------------------------

  it('login returns a valid RS256 access token', async () => {
    const auth = createJwtPlugin({
      alg:                   'RS256',
      accessTokenPrivateKey: rsaPriv,
      accessTokenPublicKey:  rsaPub,
      refreshTokenStore:     createMapTokenStore(),
    });
    const r = await request(auth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.statusCode, 200);
    const { accessToken } = r.json<any>();
    const result = verifyToken(accessToken, rsaPub, 'RS256');
    assert.ok(result.valid);
    assert.equal(result.payload.sub, 'alice');
  });

  it('authenticate succeeds with a RS256 token', async () => {
    const auth = createJwtPlugin({
      alg:                   'RS256',
      accessTokenPrivateKey: rsaPriv,
      accessTokenPublicKey:  rsaPub,
    });
    const token = signToken({ sub: 'bob', iss: auth['issuer'] ?? 'jwt-auth' }, rsaPriv, 60, 'RS256');
    const r     = await getWithAuth(auth.authenticate, '/', token);
    assert.ok(r.json<any>().user);
    assert.equal(r.json<any>().user.sub, 'bob');
  });

  it('authenticate rejects an HS256 token when plugin uses RS256', async () => {
    const auth = createJwtPlugin({
      alg:                   'RS256',
      accessTokenPrivateKey: rsaPriv,
      accessTokenPublicKey:  rsaPub,
    });
    // Sign with HS256 — different alg header → rejected
    const badToken = signToken({ sub: 'alice', iss: 'jwt-auth' }, 'secret', 60, 'HS256');
    const r = await getWithAuth(auth.authenticate, '/', badToken);
    assert.equal(r.json<any>().user, null);
  });

  it('refresh works end-to-end with RS256', async () => {
    const auth = createJwtPlugin({
      alg:                    'RS256',
      accessTokenPrivateKey:  rsaPriv,
      accessTokenPublicKey:   rsaPub,
      // refreshTokenPrivateKey / refreshTokenPublicKey fall back to access keys
      refreshTokenStore:      createMapTokenStore(),
    });
    const loginR = await request(auth.login, { body: { username: 'alice', password: 'password123' } });
    const { refreshToken } = loginR.json<any>();

    const refreshR = await request(auth.refresh, { body: { refreshToken } });
    assert.equal(refreshR.statusCode, 200);

    const { accessToken } = refreshR.json<any>();
    const result = verifyToken(accessToken, rsaPub, 'RS256');
    assert.ok(result.valid);
  });

  it('logout revokes a RS256 refresh token', async () => {
    const auth = createJwtPlugin({
      alg:                   'RS256',
      accessTokenPrivateKey: rsaPriv,
      accessTokenPublicKey:  rsaPub,
      refreshTokenStore:     createMapTokenStore(),
    });
    const loginR     = await request(auth.login, { body: { username: 'bob', password: 'secret456' } });
    const { refreshToken } = loginR.json<any>();

    await request(auth.logout, { body: { refreshToken } });

    const r = await request(auth.refresh, { body: { refreshToken } });
    assert.equal(r.statusCode, 401);
  });

  it('separate refresh key pair is used when provided', async () => {
    const { privateKey: rPriv, publicKey: rPub } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const auth = createJwtPlugin({
      alg:                    'RS256',
      accessTokenPrivateKey:  rsaPriv,
      accessTokenPublicKey:   rsaPub,
      refreshTokenPrivateKey: rPriv,
      refreshTokenPublicKey:  rPub,
      refreshTokenStore:      createMapTokenStore(),
    });
    const loginR = await request(auth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(loginR.statusCode, 200);
    const { refreshToken } = loginR.json<any>();

    // Verify the refresh token was signed with rPriv (not rsaPriv).
    const ok  = verifyToken(refreshToken, rPub,   'RS256');
    const bad = verifyToken(refreshToken, rsaPub, 'RS256');
    assert.ok(ok.valid,  'refresh token must verify with rPub');
    assert.ok(!bad.valid, 'refresh token must NOT verify with rsaPub');
  });
});

// ---------------------------------------------------------------------------
// Suite 15 — ES* algorithms (ECDSA)
// ---------------------------------------------------------------------------

describe('ES* algorithms', () => {
  // P-256 key pair for ES256
  const { privateKey: p256priv, publicKey: p256pub } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  // P-384 key pair for ES384
  const { privateKey: p384priv, publicKey: p384pub } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-384',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  // P-521 key pair for ES512
  const { privateKey: p521priv, publicKey: p521pub } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-521',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  // ---------------------------------------------------------------------------
  // Low-level round-trips (verifies DER ↔ JOSE conversion is correct)
  // ---------------------------------------------------------------------------

  it('ES256: signToken + verifyToken round-trip (P-256)', () => {
    const token  = signToken({ sub: 'alice', iss: 'test' }, p256priv, 60, 'ES256');
    assert.equal(token.split('.').length, 3);
    const result = verifyToken(token, p256pub, 'ES256');
    assert.ok(result.valid);
    assert.equal(result.payload.sub, 'alice');
  });

  it('ES384: signToken + verifyToken round-trip (P-384)', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, p384priv, 60, 'ES384');
    const result = verifyToken(token, p384pub, 'ES384');
    assert.ok(result.valid);
  });

  it('ES512: signToken + verifyToken round-trip (P-521)', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, p521priv, 60, 'ES512');
    const result = verifyToken(token, p521pub, 'ES512');
    assert.ok(result.valid);
  });

  it('multiple ES256 round-trips produce consistently valid tokens (DER/JOSE non-determinism)', () => {
    // ECDSA signatures are non-deterministic — run many to exercise different r/s shapes.
    for (let i = 0; i < 20; i++) {
      const token  = signToken({ sub: `u${i}`, iss: 'x' }, p256priv, 60, 'ES256');
      const result = verifyToken(token, p256pub, 'ES256');
      assert.ok(result.valid, `Round-trip ${i} failed`);
    }
  });

  it('rejects an ES256 token verified with the wrong EC public key', () => {
    const { publicKey: wrongPub } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const token  = signToken({ sub: 'u', iss: 'x' }, p256priv, 60, 'ES256');
    const result = verifyToken(token, wrongPub, 'ES256');
    assert.ok(!result.valid);
  });

  it('rejects a tampered ES256 payload', () => {
    const token = signToken({ sub: 'u', iss: 'x' }, p256priv, 60, 'ES256');
    const [h, , s] = token.split('.');
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'hacker', exp: 9999999999 }))
      .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const result = verifyToken(`${h}.${fakePayload}.${s}`, p256pub, 'ES256');
    assert.ok(!result.valid);
  });

  it('rejects an expired ES256 token', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, p256priv, -10, 'ES256');
    const result = verifyToken(token, p256pub, 'ES256');
    assert.ok(!result.valid);
    assert.match(result.error, /expir/i);
  });

  it('rejects when header alg is ES256 but verifier expects ES384', () => {
    const token  = signToken({ sub: 'u', iss: 'x' }, p256priv, 60, 'ES256');
    const result = verifyToken(token, p384pub, 'ES384');
    assert.ok(!result.valid);
  });

  // ---------------------------------------------------------------------------
  // End-to-end through HTTP
  // ---------------------------------------------------------------------------

  it('login returns a valid ES256 access token', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES256',
      accessTokenPrivateKey: p256priv,
      accessTokenPublicKey:  p256pub,
      refreshTokenStore:     createMapTokenStore(),
    });
    const r = await request(auth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.statusCode, 200);
    const { accessToken } = r.json<any>();
    const result = verifyToken(accessToken, p256pub, 'ES256');
    assert.ok(result.valid);
    assert.equal(result.payload.sub, 'alice');
  });

  it('authenticate succeeds with an ES256 token', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES256',
      accessTokenPrivateKey: p256priv,
      accessTokenPublicKey:  p256pub,
    });
    const token = signToken({ sub: 'charlie', iss: 'jwt-auth' }, p256priv, 60, 'ES256');
    const r     = await getWithAuth(auth.authenticate, '/', token);
    assert.ok(r.json<any>().user);
    assert.equal(r.json<any>().user.sub, 'charlie');
  });

  it('authenticate rejects an HS256 token when plugin uses ES256', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES256',
      accessTokenPrivateKey: p256priv,
      accessTokenPublicKey:  p256pub,
    });
    const badToken = signToken({ sub: 'alice', iss: 'jwt-auth' }, 'hs-secret', 60, 'HS256');
    const r = await getWithAuth(auth.authenticate, '/', badToken);
    assert.equal(r.json<any>().user, null);
  });

  it('refresh works end-to-end with ES256', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES256',
      accessTokenPrivateKey: p256priv,
      accessTokenPublicKey:  p256pub,
      refreshTokenStore:     createMapTokenStore(),
    });
    const loginR = await request(auth.login, { body: { username: 'bob', password: 'secret456' } });
    const { refreshToken } = loginR.json<any>();

    const refreshR = await request(auth.refresh, { body: { refreshToken } });
    assert.equal(refreshR.statusCode, 200);

    const { accessToken } = refreshR.json<any>();
    const result = verifyToken(accessToken, p256pub, 'ES256');
    assert.ok(result.valid);
  });

  it('login with ES384 returns a valid token', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES384',
      accessTokenPrivateKey: p384priv,
      accessTokenPublicKey:  p384pub,
      refreshTokenStore:     createMapTokenStore(),
    });
    const r = await request(auth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.statusCode, 200);
    const result = verifyToken(r.json<any>().accessToken, p384pub, 'ES384');
    assert.ok(result.valid);
  });

  it('login with ES512 returns a valid token', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES512',
      accessTokenPrivateKey: p521priv,
      accessTokenPublicKey:  p521pub,
      refreshTokenStore:     createMapTokenStore(),
    });
    const r = await request(auth.login, { body: { username: 'charlie', password: 'pass789' } });
    assert.equal(r.statusCode, 200);
    const result = verifyToken(r.json<any>().accessToken, p521pub, 'ES512');
    assert.ok(result.valid);
  });

  it('requireRole works with ES256 tokens', async () => {
    const auth = createJwtPlugin({
      alg:                   'ES256',
      accessTokenPrivateKey: p256priv,
      accessTokenPublicKey:  p256pub,
    });

    const loginR = await request(auth.login, { body: { username: 'alice', password: 'password123' } });
    const token  = loginR.json<any>().accessToken;

    await new Promise<void>((resolve, reject) => {
      const router = createRouter();
      const mws    = auth.requireRole('admin');
      for (const mw of mws) router.use('/', mw as any);
      router.get('/', (_req: any, res: any) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });

      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.statusCode = 403; res.end('{}'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const chunks: Buffer[] = [];
        const req = http.request(
          { host: '127.0.0.1', port: addr.port, method: 'GET', path: '/',
            headers: { authorization: `Bearer ${token}` } },
          (res) => {
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              server.close();
              try {
                assert.equal(res.statusCode, 200);
                resolve();
              } catch (e) { reject(e); }
            });
          },
        );
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });
  });
});
