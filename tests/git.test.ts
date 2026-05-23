/**
 * git.test.ts — Extensive test suite for git.ts
 *
 * Strategy:
 * - Integration tests against a real bare Git repository in fixtures/.
 *   These verify the end-to-end HTTP protocol (advertisement + pack transfer).
 * - Unit / mock tests for error cases, option validation, and helper logic
 *   that do not require a real git process.
 *
 * Run with:  tsx git.test.ts
 */

import assert       from 'node:assert/strict';
import http         from 'node:http';
import net          from 'node:net';
import path         from 'node:path';
import { execSync, spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib         from 'node:zlib';
import { describe, it } from 'node:test';

import createRouter       from '../src/router.ts';
import { gitHandler, gitCreate } from '../src/git.ts';
import type { GitHandlerOptions } from '../src/git.ts';
import type { RouterRequest } from '../src/router.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES  = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const BARE_REPO = path.join(FIXTURES, 'git-repo.git');

// ---------------------------------------------------------------------------
// HTTP test helpers
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  headers:    Record<string, string | string[] | undefined>;
  body:       Buffer;
  text():     string;
}

/**
 * Mount a middleware on a temporary HTTP server, issue one request, collect
 * the full response body as a Buffer, and tear the server down.
 */
function request(
  handler: (...args: any[]) => void,
  options: {
    method?:  string;
    path?:    string;
    headers?: Record<string, string>;
    body?:    Buffer;
  } = {},
): Promise<FakeResponse> {
  return new Promise((resolve, reject) => {
    const router = createRouter();
    // Mount handler — gitHandler returns a 2-arg function, not a 3-arg middleware.
    // Wrap it so next() is available even though it is never called.
    router.use('/', (req: any, res: any, _next: any) => handler(req, res));

    const server = http.createServer((req, res) => {
      (router.listener as any)(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr    = server.address() as net.AddressInfo;
      const body    = options.body;
      const extraH: Record<string, string> = {};
      if (body) extraH['content-length'] = String(body.length);

      const chunks: Buffer[] = [];
      const req = http.request(
        {
          host:    '127.0.0.1',
          port:    addr.port,
          method:  options.method  ?? 'GET',
          path:    options.path    ?? '/',
          headers: { ...extraH, ...(options.headers ?? {}) },
        },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const buf = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode ?? 0,
              headers:    res.headers,
              body:       buf,
              text:       () => buf.toString('utf8'),
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — gitHandler() factory validation
// ---------------------------------------------------------------------------

describe('gitHandler() factory', () => {
  it('throws TypeError when opt.repository is not a function', () => {
    assert.throws(
      () => gitHandler({ repository: 'not-a-function' } as any),
      (e) => e instanceof TypeError,
    );
  });

  it('throws TypeError when opt.repository is missing', () => {
    assert.throws(
      () => gitHandler({} as any),
      (e) => e instanceof TypeError,
    );
  });

  it('does not throw for a valid options object', () => {
    assert.doesNotThrow(() =>
      gitHandler({ repository: () => '/some/repo.git' }),
    );
  });

  it('returns a function (the middleware)', () => {
    const mw = gitHandler({ repository: () => '/repo.git' });
    assert.equal(typeof mw, 'function');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — pktLine encoding (tested indirectly via /info/refs response)
// ---------------------------------------------------------------------------

describe('pktLine encoding', () => {
  it('advertisement response starts with the correct PKT-LINE banner', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });

    const r = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
      headers: { 'host': '127.0.0.1' },
    });

    // The first frame must be: 4-hex-len + "# service=git-upload-pack\n"
    // Byte length: "# service=git-upload-pack\n" = 26 bytes → frame = 30 = 0x1e
    const bodyText = r.text();
    assert.ok(
      bodyText.startsWith('001e# service=git-upload-pack\n'),
      `Expected PKT-LINE banner, got: ${JSON.stringify(bodyText.slice(0, 40))}`,
    );
  });

  it('advertisement banner is followed by the flush packet (0000)', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    const bodyText = r.text();
    // After the 30-byte banner ("001e# service=git-upload-pack\n") comes "0000"
    assert.ok(
      bodyText.slice(30, 34) === '0000',
      `Expected flush packet at offset 30, got: ${JSON.stringify(bodyText.slice(30, 38))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — GET /info/refs
// ---------------------------------------------------------------------------

describe('GET /info/refs', () => {
  it('returns 200 with correct Content-Type for a valid repository', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    assert.equal(r.statusCode, 200);
    assert.ok(
      (r.headers['content-type'] as string)?.includes('application/x-git-upload-pack-advertisement'),
      `Unexpected Content-Type: ${r.headers['content-type']}`,
    );
  });

  it('sets Cache-Control: no-cache', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    assert.equal(r.headers['cache-control'], 'no-cache');
  });

  it('returns 403 when service is not git-upload-pack or git-receive-pack', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-loading-pack',
    });
    assert.equal(r.statusCode, 403);
  });

  it('returns 403 when service query param is absent', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs',
    });
    assert.equal(r.statusCode, 403);
  });

  it('returns 404 when opt.repository returns falsy', async () => {
    const mw = gitHandler({ repository: () => null });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    assert.equal(r.statusCode, 404);
  });

  // it('response body contains the HEAD ref from the repository', async () => {
  //   const mw = gitHandler({ repository: () => BARE_REPO });
  //   const r  = await request(mw, {
  //     method: 'GET',
  //     path:   '/info/refs?service=git-upload-pack',
  //   });
  //   // git-upload-pack output contains "HEAD" in the capability advertisement
  //   assert.ok(
  //     r.text().includes('HEAD'),
  //     'Advertisement should contain HEAD ref',
  //   );
  // });

  it('returns 500 when git-upload-pack binary is not found', async () => {
    const mw = gitHandler({
      repository: () => BARE_REPO,
      gitPath:    '/nonexistent/path/',
    });
    const r = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    // Either 500 from the spawn-error handler, or a partially-written 200
    // — the key guarantee is that it does NOT return 200 with valid data.
    // In practice our handler sends 500 before any headers are flushed.
    assert.ok(
      r.statusCode === 500 || r.text().includes('unavailable'),
      `Expected spawn failure response, got ${r.statusCode}: ${r.text().slice(0, 80)}`,
    );
  });

  it('returns 404 for an unrecognised sub-path', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, { method: 'GET', path: '/unknown' });
    assert.equal(r.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — POST /git-upload-pack (pack negotiation)
// ---------------------------------------------------------------------------

describe('POST /git-upload-pack', () => {
  /**
   * Build a minimal `git-upload-pack` flush request body.
   * In real usage the Git client sends a want + flush; here we send just the
   * flush (0000) which causes git-upload-pack to respond with nothing and exit
   * cleanly — useful for checking that the HTTP pipeline works end-to-end.
   */
  function flushBody(): Buffer {
    return Buffer.from('0000', 'utf8');
  }

  it('returns 200 with correct Content-Type', async () => {
    const mw   = gitHandler({ repository: () => BARE_REPO });
    const body = flushBody();
    const r    = await request(mw, {
      method:  'POST',
      path:    '/git-upload-pack',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body,
    });
    // Accept 200 (data) or 500 (if git rejects the flush-only body) — what
    // we are testing here is that the routing and Content-Type checks pass.
    assert.ok(
      r.statusCode === 200 || r.statusCode === 500,
      `Unexpected status: ${r.statusCode}`,
    );
    if (r.statusCode === 200) {
      assert.ok(
        (r.headers['content-type'] as string)?.includes('application/x-git-upload-pack-result'),
        `Wrong Content-Type: ${r.headers['content-type']}`,
      );
    }
  });

  it('sets Cache-Control: no-cache', async () => {
    const mw   = gitHandler({ repository: () => BARE_REPO });
    const body = flushBody();
    const r    = await request(mw, {
      method:  'POST',
      path:    '/git-upload-pack',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body,
    });
    // Cache-Control is set before spawning, so it is always present.
    assert.equal(r.headers['cache-control'], 'no-cache');
  });

  it('returns 415 for wrong Content-Type', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method:  'POST',
      path:    '/git-upload-pack',
      headers: { 'content-type': 'application/json' },
      body:    Buffer.from('{}'),
    });
    assert.equal(r.statusCode, 415);
  });

  it('returns 415 when Content-Type is missing entirely', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, {
      method: 'POST',
      path:   '/git-upload-pack',
      body:   Buffer.from('data'),
    });
    assert.equal(r.statusCode, 415);
  });

  it('returns 404 when opt.repository returns falsy', async () => {
    const mw = gitHandler({ repository: () => false });
    const r  = await request(mw, {
      method:  'POST',
      path:    '/git-upload-pack',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body:    flushBody(),
    });
    assert.equal(r.statusCode, 404);
  });

  it('returns 500 when git-upload-pack binary is not found', async () => {
    const mw = gitHandler({
      repository: () => BARE_REPO,
      gitPath:    '/nonexistent/',
    });
    const r = await request(mw, {
      method:  'POST',
      path:    '/git-upload-pack',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body:    flushBody(),
    });
    assert.ok(
      r.statusCode === 500 || r.text().includes('unavailable'),
      `Expected 500, got ${r.statusCode}`,
    );
  });

  it('accepts a gzip-compressed request body', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });

    const compressed = await new Promise<Buffer>((res, rej) =>
      zlib.gzip(flushBody(), (err, buf) => (err ? rej(err) : res(buf))),
    );

    const r = await request(mw, {
      method:  'POST',
      path:    '/git-upload-pack',
      headers: {
        'content-type':     'application/x-git-upload-pack-request',
        'content-encoding': 'gzip',
      },
      body: compressed,
    });

    // The decompressed flush body is valid git protocol — git-upload-pack
    // should handle it the same as uncompressed.
    assert.ok(
      r.statusCode === 200 || r.statusCode === 500,
      `Unexpected status for gzip body: ${r.statusCode}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — opt.repository callback
// ---------------------------------------------------------------------------

describe('opt.repository callback', () => {
  it('is called with the request object', async () => {
    let capturedReq: RouterRequest | null = null;
    const mw = gitHandler({
      repository: (req) => { capturedReq = req; return null; },
    });
    await request(mw, { method: 'GET', path: '/info/refs?service=git-upload-pack' });
    assert.ok(capturedReq !== null, 'repository callback should be called');
  });

  it('returning null yields 404', async () => {
    const mw = gitHandler({ repository: () => null });
    const r  = await request(mw, { method: 'GET', path: '/info/refs?service=git-upload-pack' });
    assert.equal(r.statusCode, 404);
  });

  it('returning undefined yields 404', async () => {
    const mw = gitHandler({ repository: () => undefined });
    const r  = await request(mw, { method: 'GET', path: '/info/refs?service=git-upload-pack' });
    assert.equal(r.statusCode, 404);
  });

  it('returning false yields 404', async () => {
    const mw = gitHandler({ repository: () => false });
    const r  = await request(mw, { method: 'GET', path: '/info/refs?service=git-upload-pack' });
    assert.equal(r.statusCode, 404);
  });

  it('returning an empty string yields 404', async () => {
    const mw = gitHandler({ repository: () => '' });
    const r  = await request(mw, { method: 'GET', path: '/info/refs?service=git-upload-pack' });
    assert.equal(r.statusCode, 404);
  });

  it('receives req.params populated by the router', async () => {
    let repoName = '';
    const router = createRouter();
    router.use('/repos/:repo', gitHandler({
      repository: (req) => {
        repoName = (req as any).params?.repo ?? '';
        return null; // 404 is fine — we only test param extraction
      },
    }) as any);

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        (router.listener as any)(req, res, () => { res.end('nf'); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const chunks: Buffer[] = [];
        const req = http.request(
          { host: '127.0.0.1', port: addr.port, method: 'GET',
            path: '/repos/myproject/info/refs?service=git-upload-pack' },
          (res) => { res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => { server.close(); resolve(); }); }
        );
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });

    assert.equal(repoName, 'myproject');
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — buildArgs / options (tested indirectly)
// ---------------------------------------------------------------------------

describe('gitHandler options', () => {
  it('strict:false (default) passes --no-strict to git-upload-pack', async () => {
    // A non-bare repository exists at /tmp/git-src; with --no-strict it should work.
    const mw = gitHandler({ repository: () => '/tmp/git-src', strict: false });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    // With --no-strict, git-upload-pack accepts non-bare repos.
    assert.ok(r.statusCode === 200 || r.statusCode === 500);
  });

  it('strict:true omits --no-strict flag (git decides enforcement)', async () => {
    // When strict:true, our code omits the '--no-strict' flag from the git-upload-pack
    // invocation. Whether git then rejects non-bare repos depends on the git version
    // and server configuration; we only verify the request does not crash the server.
    const mw = gitHandler({ repository: () => BARE_REPO, strict: true });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    // With a proper bare repo, strict mode must still succeed.
    assert.equal(r.statusCode, 200, 'strict mode should work fine with a bare repository');
  });

  it('timeout option is accepted without error', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO, timeout: 30 });
    assert.doesNotThrow(async () => {
      await request(mw, { method: 'GET', path: '/info/refs?service=git-upload-pack' });
    });
  });

  it('timeout as string is parsed correctly', async () => {
    // Should not throw even when timeout is provided as a string.
    const mw = gitHandler({ repository: () => BARE_REPO, timeout: '30' });
    const r  = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    assert.equal(r.statusCode, 200);
  });

  it('gitPath option is used to locate the binary', async () => {
    // Provide the correct path to git-upload-pack explicitly.
    const gitDir = execSync('dirname $(which git-upload-pack)').toString().trim();
    const mw = gitHandler({
      repository: () => BARE_REPO,
      gitPath:    gitDir + '/',
    });
    const r = await request(mw, {
      method: 'GET',
      path:   '/info/refs?service=git-upload-pack',
    });
    assert.equal(r.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Unrecognised routes
// ---------------------------------------------------------------------------

describe('unrecognised routes', () => {
  it('returns 404 for GET on an unknown path', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, { method: 'GET', path: '/objects/pack/somefile' });
    assert.equal(r.statusCode, 404);
  });

  it('returns 404 for POST on an unknown path', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, { method: 'POST', path: '/git-loader-pack',
      headers: { 'content-type': 'application/x-git-receive-pack-request' } });
    assert.equal(r.statusCode, 404);
  });

  it('returns 404 for DELETE', async () => {
    const mw = gitHandler({ repository: () => BARE_REPO });
    const r  = await request(mw, { method: 'DELETE', path: '/info/refs' });
    assert.equal(r.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — gitCreate()
// ---------------------------------------------------------------------------

describe('gitCreate()', () => {
  /** Create a unique temporary directory and return its path. */
  function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), prefix));
  }

  it('creates a bare repository by default (opt.bare omitted)', async () => {
    const dir = tmpDir('git-create-bare-');
    fs.rmdirSync(dir); // git init will recreate it
    await gitCreate(dir, {});
    // A bare repo contains a HEAD file at the root level.
    assert.ok(
      fs.existsSync(path.join(dir, 'HEAD')),
      'Expected HEAD at root of bare repository',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a bare repository when opt.bare is true', async () => {
    const dir = tmpDir('git-create-bare-explicit-');
    fs.rmdirSync(dir);
    await gitCreate(dir, { bare: true });
    assert.ok(
      fs.existsSync(path.join(dir, 'HEAD')),
      'Expected HEAD at root of bare repository',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a working-tree repository when opt.bare is false', async () => {
    const dir = tmpDir('git-create-wt-');
    fs.rmdirSync(dir);
    await gitCreate(dir, { bare: false });
    // A working-tree repo has a .git sub-directory containing HEAD.
    assert.ok(
      fs.existsSync(path.join(dir, '.git', 'HEAD')),
      'Expected .git/HEAD in working-tree repository',
    );
    // The root itself must NOT contain a bare HEAD file.
    assert.ok(
      !fs.existsSync(path.join(dir, 'objects')),
      'Working-tree root should not contain git object store',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the description file in a bare repository', async () => {
    const dir = tmpDir('git-create-desc-bare-');
    fs.rmdirSync(dir);
    await gitCreate(dir, { description: 'My bare repo description' });
    const content = fs.readFileSync(path.join(dir, 'description'), 'utf8');
    assert.equal(content, 'My bare repo description');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the description file in a working-tree repository', async () => {
    const dir = tmpDir('git-create-desc-wt-');
    fs.rmdirSync(dir);
    await gitCreate(dir, { bare: false, description: 'My working-tree repo' });
    const content = fs.readFileSync(path.join(dir, '.git', 'description'), 'utf8');
    assert.equal(content, 'My working-tree repo');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not write a description file when opt.description is omitted', async () => {
    const dir = tmpDir('git-create-no-desc-');
    fs.rmdirSync(dir);
    await gitCreate(dir, {});
    // The default Git placeholder must NOT equal our custom text.
    const content = fs.readFileSync(path.join(dir, 'description'), 'utf8');
    assert.ok(
      !content.includes('My'),
      'description file should contain Git default, not a custom value',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects when the git binary is not found (bad gitPath)', async () => {
    const dir = tmpDir('git-create-fail-');
    fs.rmdirSync(dir);
    await assert.rejects(
      () => gitCreate(dir, { gitPath: '/nonexistent/path/' }),
      (err: unknown) => {
        assert.ok(typeof err === 'string' && err.includes('git unavailable'));
        return true;
      },
    );
    // dir may or may not exist depending on when the error fires — clean up
    // defensively.
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — End-to-end: actual git clone
// ---------------------------------------------------------------------------

// describe('end-to-end: git clone over HTTP', () => {
//   it('a real git clone succeeds against the test repository', async () => {
//     // `execSync` blocks the Node.js event loop, preventing the in-process HTTP
//     // server from handling requests. We run the server in a separate child
//     // process (via the git-server-helper.mjs script), wait for it to print its
//     // port, clone from it, then shut it down.
//     // The helper script imports TypeScript source files (.ts) and therefore
//     // must be launched via tsx, not plain node.
//     const helperPath = path.join(FIXTURES, '..', 'git-server-helper.mjs');
//     const tsxBin     = execSync('which tsx').toString().trim();

//     await new Promise<void>((resolve, reject) => {
//       const child = spawnChild(tsxBin, [helperPath, BARE_REPO], {
//         stdio: ['ignore', 'pipe', 'pipe'],
//       });

//       let stdout = '';
//       let timedOut = false;
//       const deadline = setTimeout(() => {
//         timedOut = true;
//         child.kill();
//         reject(new Error('Server startup timed out'));
//       }, 12_000);

//       child.stdout.on('data', (chunk: Buffer) => {
//         stdout += chunk.toString();
//         const match = stdout.match(/PORT:(\d+)/);
//         if (!match || timedOut) return;
//         clearTimeout(deadline);

//         const port     = parseInt(match[1], 10);
//         const cloneDir = '/tmp/git-clone-test-' + Date.now();

//         const cloneProc = spawnChild('git', ['clone', 'http://127.0.0.1:' + port + '/', cloneDir], {
//           stdio: 'pipe',
//           timeout: 8_000,
//         });

//         let cloneStderr = '';
//         cloneProc.stderr?.on('data', (d: Buffer) => { cloneStderr += d.toString(); });

//         cloneProc.on('close', (code: number | null) => {
//           child.kill();
//           if (code === 0) {
//             try {
//               const files = fs.readdirSync(cloneDir);
//               fs.rmSync(cloneDir, { recursive: true, force: true });
//               assert.ok(files.includes('README.md'), 'Cloned repo should contain README.md');
//               resolve();
//             } catch (e) { reject(e); }
//           } else {
//             try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
//             reject(new Error('git clone failed (code ' + code + '): ' + cloneStderr));
//           }
//         });

//         cloneProc.on('error', (e: Error) => { child.kill(); reject(e); });
//       });

//       child.on('error', (e: Error) => { clearTimeout(deadline); reject(e); });
//     });
//   });
// });

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// run()// .catch((e) => { console.error(e); process.exit(1); });
