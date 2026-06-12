/**
 * Property-based fuzzing of the router for ReDoS / catastrophic backtracking.
 *
 * Attack class covered (see ../THREAT_MODEL.md):
 *   - RT-1 ReDoS — matching an attacker-controlled request path against the
 *     compiled route patterns (plain segments, named params, inline `\d+`
 *     constraints, single- and cross-segment globs) must stay roughly linear:
 *     no input should push request handling past a small time budget.
 *
 * Strategy: register a router exercising every pattern-compilation strategy,
 * then fire long adversarial paths at a real server and assert each response
 * returns well within budget. True catastrophic backtracking would take
 * seconds-to-minutes, so even a generous budget catches it deterministically.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fc from 'fast-check';
import { createRouter } from '../../src/index.js';

/** Generous per-request budget; ReDoS would blow far past this. */
const MAX_MS = 250;

let server: http.Server;
let port: number;

before(() => {
  const app = createRouter();
  app.get('/users/:id(\\d+)', (_req, res) => res.send('user'));
  app.get('/items/:slug', (_req, res) => res.send('item'));
  app.get('/files/**', (_req, res) => res.send('file')); // cross-segment glob
  app.get('/api/*', (_req, res) => res.send('api')); // single-segment glob
  app.get('/a/:x/b/:y/c/:z', (_req, res) => res.send('nested'));
  app.get('/', (_req, res) => res.send('root'));

  server = http.createServer(app.listener as http.RequestListener);
  server.listen(0);
  port = (server.address() as AddressInfo).port;
});

after(() => server.close());

/** Time a single GET; returns elapsed ms (request setup included). */
function timedGet(rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(performance.now() - start));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Adversarial path segments aimed at provoking backtracking. */
const evilSegment = fc.oneof(
  fc.stringMatching(/^[0-9]{1,200}$/), // long digit runs vs the \d+ constraint
  fc.stringMatching(/^[a-z]{1,200}$/),
  fc.constantFrom('users', 'items', 'files', 'api', 'a', 'b', 'c'),
  fc.string({ minLength: 0, maxLength: 64 }).map((s) => encodeURIComponent(s)),
);

describe('router ReDoS fuzzing', () => {
  it('RT-1: arbitrary long paths match in roughly linear time', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(evilSegment, { minLength: 1, maxLength: 30 }), async (segments) => {
        const rawPath = '/' + segments.join('/');
        const elapsed = await timedGet(rawPath);
        assert.ok(elapsed < MAX_MS, `path took ${elapsed.toFixed(1)}ms: ${rawPath.slice(0, 80)}`);
      }),
      { numRuns: 400 },
    );
  });

  it('RT-1: pathological repetition against the \\d+ constraint stays fast', async () => {
    // A long near-digit string ending in a non-digit is the classic ReDoS
    // trigger for naive numeric patterns.
    for (const len of [1000, 5000, 20000]) {
      const elapsed = await timedGet('/users/' + '9'.repeat(len) + 'x');
      assert.ok(elapsed < MAX_MS, `len=${len} took ${elapsed.toFixed(1)}ms`);
    }
  });
});
