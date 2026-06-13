/**
 * Property-based fuzzing of static-file path traversal protection.
 *
 * Attack class covered (see ../docs/THREAT_MODEL.md):
 *   - FS-1 path traversal — no request path, however crafted (raw `..`,
 *     percent-encoded `%2e%2e`, encoded slashes, null bytes, backslashes,
 *     mixed depth), may cause serveStatic to read a file outside its root.
 *
 * Strategy: serve a `public/` directory while a sentinel file containing a
 * unique marker lives in its parent. We fire thousands of adversarial paths at
 * a real HTTP server and assert the marker is never returned.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import fc from 'fast-check';
import { createRouter, serveStatic } from '../src/index.js';

const MARKER = 'TOP_SECRET_MARKER_8f3a';

let server: http.Server;
let port: number;
let tmpRoot: string;

before(() => {
  // tmpRoot/public is served; tmpRoot/secret.txt sits one level above it.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-sec-'));
  const publicDir = path.join(tmpRoot, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>public</h1>');
  fs.writeFileSync(path.join(publicDir, 'ok.txt'), 'PUBLIC_OK');
  fs.writeFileSync(path.join(tmpRoot, 'secret.txt'), MARKER);

  const app = createRouter();
  app.use(serveStatic(publicDir));

  server = http.createServer(app.listener as http.RequestListener);
  server.listen(0);
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Issue a raw GET with the path sent verbatim (no client-side normalisation). */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Building blocks an attacker combines to escape the served root. */
const traversalToken = fc.constantFrom(
  '..',
  '../',
  '..%2f',
  '%2e%2e',
  '%2e%2e%2f',
  '%2e%2e/',
  '....//',
  '..\\',
  '%5c',
  '%00',
  'secret.txt',
  'public',
  'ok.txt',
);

describe('static path traversal fuzzing', () => {
  it('FS-1: the sentinel above the root is never served', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(traversalToken, { minLength: 1, maxLength: 8 }), async (tokens) => {
        const rawPath = '/' + tokens.join('/');
        const { body } = await rawGet(rawPath);
        assert.ok(!body.includes(MARKER), `traversal escaped root via ${rawPath}`);
      }),
      { numRuns: 600 },
    );
  });

  it('FS-1: a few canonical traversal payloads are blocked', async () => {
    const payloads = [
      '/../secret.txt',
      '/../../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/....//secret.txt',
      '/public/../../secret.txt',
    ];
    for (const p of payloads) {
      const { body } = await rawGet(p);
      assert.ok(!body.includes(MARKER), `leaked via ${p}`);
    }
  });

  it('sanity: a legitimate file is still served', async () => {
    const { status, body } = await rawGet('/ok.txt');
    assert.equal(status, 200);
    assert.equal(body, 'PUBLIC_OK');
  });
});
