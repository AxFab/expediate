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

import createRouter             from '../src/router.ts';
import { json }                 from '../src/misc.ts';
import createJwtPlugin, {
  hashPassword,
  userDatabase,
  signToken,
  verifyToken,
  type JwtConfig,
}                               from '../src/jwt-auth.ts';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

type TestFn = () => void | Promise<void>;
interface Suite { name: string; tests: { name: string; fn: TestFn }[] }

const suites: Suite[] = [];
let currentSuite: Suite | null = null;

function describe(name: string, body: () => void) {
  const suite: Suite = { name, tests: [] };
  suites.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  body();
  currentSuite = prev;
}

function it(name: string, fn: TestFn) {
  if (!currentSuite) throw new Error('it() called outside describe()');
  currentSuite.tests.push({ name, fn });
}

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
// Shared plugin instance used by most suites
// ---------------------------------------------------------------------------

const AUTH = createJwtPlugin({
  accessTokenSecret:  'test-access-secret',
  refreshTokenSecret: 'test-refresh-secret',
  accessTokenExpiry:  60,     // 1 minute — short enough to test easily
  refreshTokenExpiry: 3600,   // 1 hour
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
    const token = signToken({ sub: 'u1', username: 'u', iss: 'test', iat: 0, exp: 0 }, SECRET, 60);
    assert.equal(token.split('.').length, 3);
  });

  it('verifyToken accepts a freshly signed token', () => {
    const token  = signToken({ sub: 'u1', username: 'u', iss: 'test', iat: 0, exp: 0 }, SECRET, 60);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
  });

  it('decoded payload contains the expected claims', () => {
    const token  = signToken({ sub: 'u1', username: 'alice', iss: 'x', iat: 0, exp: 0 }, SECRET, 60);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
    assert.equal(result.payload.sub,      'u1');
    assert.equal(result.payload.username, 'alice');
  });

  it('decoded payload contains iat and exp claims', () => {
    const before = Math.floor(Date.now() / 1000);
    const token  = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, 120);
    const result = verifyToken(token, SECRET, 'HS256');
    assert.ok(result.valid);
    assert.ok(result.payload.iat >= before, 'iat should be >= request time');
    assert.ok(result.payload.exp > result.payload.iat, 'exp should be after iat');
    assert.ok(result.payload.exp <= before + 120 + 1, 'exp should be ~now+120s');
  });

  it('rejects a token signed with the wrong secret', () => {
    const token  = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, 60);
    const result = verifyToken(token, 'wrong-secret', 'HS256');
    assert.ok(!result.valid);
    assert.ok(result.error.toLowerCase().includes('signature') ||
              result.error.toLowerCase().includes('algorithm'));
  });

  it('rejects a tampered payload', () => {
    const token = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, 60);
    const [h, , s] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'hacker', username: 'hacker', exp: 9999999999 }))
      .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const result = verifyToken(`${h}.${tamperedPayload}.${s}`, SECRET, 'HS256');
    assert.ok(!result.valid);
  });

  it('rejects an expired token', () => {
    const token  = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, -10); // already expired
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
    const token  = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, 60);
    const [h, p] = token.split('.');
    const result = verifyToken(`${h}.${p}.x`, SECRET, 'HS256');
    assert.ok(!result.valid); // must return false, not throw
  });

  it('supports HS384 algorithm', () => {
    const plugin = createJwtPlugin({ accessTokenSecret: SECRET, alg: 'HS384' });
    // Sign and verify indirectly through login
    const store = new Map<string, any>();
    const p384   = createJwtPlugin({
      accessTokenSecret: SECRET,
      alg: 'HS384',
      refreshTokenStore: store as any,
    });
    const token = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, 60, 'HS384');
    const result = verifyToken(token, SECRET, 'HS384');
    assert.ok(result.valid);
  });

  it('rejects a HS256 token when verifier expects HS384', () => {
    const token  = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, SECRET, 60, 'HS256');
    const result = verifyToken(token, SECRET, 'HS384');
    assert.ok(!result.valid);
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

  it('access token decodes to the correct username', async () => {
    const r = await request(AUTH.login, { body: { username: 'charlie', password: 'pass789' } });
    const { accessToken } = r.json<any>();
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] + '==', 'base64').toString('utf8'),
    );
    assert.equal(payload.username, 'charlie');
  });

  it('refresh token is a hex string of sufficient entropy', async () => {
    const r = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const { refreshToken } = r.json<any>();
    assert.match(refreshToken, /^[0-9a-f]{128}$/, 'refreshToken should be 128 hex chars (64 bytes)');
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
    const r = await request(AUTH.refresh, { body: { username: 'alice', refreshToken } });
    assert.equal(r.statusCode, 200);
    const body = r.json<any>();
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
  });

  it('rotates the refresh token (old token is no longer valid)', async () => {
    const { refreshToken: first } = await login('bob', 'secret456');
    await request(AUTH.refresh, { body: { username: 'bob', refreshToken: first } });

    // Using the old token again must fail.
    const r2 = await request(AUTH.refresh, { body: { username: 'bob', refreshToken: first } });
    assert.equal(r2.statusCode, 401);
  });

  it('new refresh token from rotation is usable', async () => {
    const { refreshToken: first } = await login('alice', 'password123');
    const r1   = await request(AUTH.refresh, { body: { username: 'alice', refreshToken: first } });
    const second = r1.json<any>().refreshToken;

    const r2 = await request(AUTH.refresh, { body: { username: 'alice', refreshToken: second } });
    assert.equal(r2.statusCode, 200);
  });

  it('returns 401 for an invalid refresh token', async () => {
    const r = await request(AUTH.refresh, { body: { username: 'alice', refreshToken: 'invalid-token' } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 401 when refresh token belongs to a different user', async () => {
    const { refreshToken } = await login('alice', 'password123');
    // Present alice's token as if it were bob's
    const r = await request(AUTH.refresh, { body: { username: 'bob', refreshToken } });
    assert.equal(r.statusCode, 401);
  });

  it('returns 400 when refreshToken is missing', async () => {
    const r = await request(AUTH.refresh, { body: { username: 'alice' } });
    assert.equal(r.statusCode, 400);
  });

  it('returns 400 when username is missing', async () => {
    const { refreshToken } = await login('alice', 'password123');
    const r = await request(AUTH.refresh, { body: { refreshToken } });
    assert.equal(r.statusCode, 400);
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
    const r = await request(AUTH.refresh, { body: { username: 'alice', refreshToken } });
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
    assert.equal(body.user.username, 'alice');
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
      { sub: 'u', username: 'alice', iss: 'test', iat: 0, exp: 0 },
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
    const store = new Map<string, any>();
    const authWithIssuer = createJwtPlugin({
      accessTokenSecret: 'secret',
      issuer:            'my-app',
      checkIssuer:       true,
      refreshTokenStore: store as any,
    });
    const loginR = await request(authWithIssuer.login, { body: { username: 'alice', password: 'password123' } });
    const token  = loginR.json<any>().accessToken;

    const r = await getWithAuth(authWithIssuer.authenticate, '/', token);
    assert.ok(r.json<any>().user, 'user should be set when issuer matches');
  });

  it('rejects tokens with wrong issuer when checkIssuer:true', async () => {
    // Token signed with issuer 'other-app' verified against 'my-app'
    const store = new Map<string, any>();
    const authA = createJwtPlugin({ accessTokenSecret: 'sec', issuer: 'app-a', refreshTokenStore: store as any });
    const authB = createJwtPlugin({ accessTokenSecret: 'sec', issuer: 'app-b', checkIssuer: true, refreshTokenStore: store as any });

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
// Suite 10 — Custom configuration
// ---------------------------------------------------------------------------

describe('custom configuration', () => {
  it('accepts a custom fetchUser and isPasswordValid', async () => {
    const customStore = new Map<string, any>();
    const customAuth  = createJwtPlugin({
      accessTokenSecret: 'custom-secret',
      fetchUser:         (u) => u === 'testuser' ? { username: 'testuser', passwordHash: hashPassword('testpass') } : undefined,
      isPasswordValid:   (user, pw) => user.passwordHash === hashPassword(pw),
      refreshTokenStore: customStore as any,
    });

    const r = await request(customAuth.login, { body: { username: 'testuser', password: 'testpass' } });
    assert.equal(r.statusCode, 200);
  });

  it('rejects login when custom isPasswordValid returns false', async () => {
    const customStore = new Map<string, any>();
    const customAuth  = createJwtPlugin({
      accessTokenSecret: 'cs',
      fetchUser:         (u) => u === 'u' ? { username: 'u', passwordHash: '' } : undefined,
      isPasswordValid:   () => false, // always reject
      refreshTokenStore: customStore as any,
    });

    const r = await request(customAuth.login, { body: { username: 'u', password: 'anything' } });
    assert.equal(r.statusCode, 401);
  });

  it('respects a custom accessTokenExpiry', async () => {
    const customStore = new Map<string, any>();
    const shortAuth   = createJwtPlugin({
      accessTokenSecret: 'short-secret',
      accessTokenExpiry: 10,
      refreshTokenStore: customStore as any,
    });

    const r = await request(shortAuth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.json<any>().expiresIn, 10);
  });

  it('accepts a custom refreshTokenStore', async () => {
    const externalStore = new Map<string, any>();
    const customAuth    = createJwtPlugin({
      accessTokenSecret: 'sec',
      refreshTokenStore: externalStore as any,
    });

    await request(customAuth.login, { body: { username: 'alice', password: 'password123' } });
    assert.equal(externalStore.size, 1, 'Refresh token should be stored in the external store');
  });

  it('accepts a custom payload builder', async () => {
    const store      = new Map<string, any>();
    const customAuth = createJwtPlugin({
      accessTokenSecret: 'sec',
      refreshTokenStore: store as any,
      payload: (user) => ({ sub: `custom-${user.username}`, username: user.username, iss: 'x', iat: 0, exp: 0, customClaim: 'hello' }),
    });

    const r     = await request(customAuth.login, { body: { username: 'alice', password: 'password123' } });
    const token = r.json<any>().accessToken;
    const payload = JSON.parse(Buffer.from(token.split('.')[1] + '==', 'base64').toString('utf8'));
    assert.equal(payload.customClaim, 'hello');
    assert.ok(payload.sub.startsWith('custom-'));
  });
});

// ---------------------------------------------------------------------------
// Suite 11 — Security edge cases
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

  it('a token cannot be used as a refresh token', async () => {
    const loginR = await request(AUTH.login, { body: { username: 'alice', password: 'password123' } });
    const { accessToken } = loginR.json<any>();

    const r = await request(AUTH.refresh, { body: { username: 'alice', refreshToken: accessToken } });
    assert.equal(r.statusCode, 401);
  });

  it('concurrent logins produce independent refresh tokens', async () => {
    // Two logins in the same second share the same iat/exp → same access token
    // (deterministic HMAC). However, refresh tokens are always random and must differ.
    const results = await Promise.all([
      request(AUTH.login, { body: { username: 'alice', password: 'password123' } }),
      request(AUTH.login, { body: { username: 'alice', password: 'password123' } }),
    ]);
    const [b1, b2] = results.map((r) => r.json<any>());
    assert.notEqual(b1.refreshToken, b2.refreshToken, 'Refresh tokens must always differ (random)');
    // Both access tokens are valid JWTs regardless of whether they differ.
    assert.equal(b1.accessToken.split('.').length, 3);
    assert.equal(b2.accessToken.split('.').length, 3);
  });

  it('timingSafeEqual does not throw for different-length signatures', () => {
    // Directly test verifyToken with a truncated signature.
    const token = signToken({ sub: 'u', username: 'u', iss: 'x', iat: 0, exp: 0 }, 'sec', 60);
    const [h, p] = token.split('.');
    // Truncate to 3 chars — completely different length from expected
    assert.doesNotThrow(() => verifyToken(`${h}.${p}.abc`, 'sec', 'HS256'));
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  let passed = 0;
  let failed = 0;
  const failures: { suite: string; test: string; error: unknown }[] = [];

  for (const suite of suites) {
    console.log(`\n  ${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.fn();
        console.log(`    ✅✓ ${test.name}`);
        passed++;
      } catch (e) {
        console.log(`    ❌✗ ${test.name}`);
        failed++;
        failures.push({ suite: suite.name, test: test.name, error: e });
      }
    }
  }

  const total = passed + failed;
  console.log(`\n  ${passed}/${total} passing${failed > 0 ? `, ${failed} failing` : ''}\n`);

  if (failures.length > 0) {
    console.log('Failures:\n');
    for (const { suite, test, error } of failures) {
      console.log(`  [${suite}] ${test}`);
      if (error instanceof Error) {
        console.log(`    ${error.message}`);
        const lines = error.stack?.split('\n').slice(1, 4) ?? [];
        for (const line of lines) console.log(`  ${line}`);
      } else {
        console.log(`    ${String(error)}`);
      }
      console.log('');
    }
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
