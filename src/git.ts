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
'use strict';

import { spawn }       from 'child_process';
import { createGunzip } from 'zlib';

import type { RouterRequest, RouterResponse } from './router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration options for {@link gitHandler}.
 */
export interface GitHandlerOptions {
  /**
   * Resolve the absolute filesystem path of the Git repository for an
   * incoming request.
   *
   * Return a non-empty string to serve that repository, or a falsy value
   * (`''`, `null`, `undefined`) to respond with **404 Repository not found**.
   *
   * This is the only required option; all others have defaults.
   *
   * @example
   * ```ts
   * repository: (req) => path.join('/srv/git', req.params.repo + '.git')
   * ```
   */
  repository: (req: RouterRequest) => string | null | undefined | false;

  /**
   * Directory that contains the `git-upload-pack` executable, including a
   * trailing path separator (e.g. `'/usr/lib/git-core/'`).
   *
   * Leave empty (default) to locate the binary via the system `PATH`.
   */
  gitPath?: string;

  /**
   * When `true`, the `--strict` flag is passed to `git-upload-pack`.
   * This causes the process to exit with an error when the resolved path is
   * not a bare Git repository.
   *
   * Defaults to `false` (non-strict / `--no-strict`).
   */
  strict?: boolean;

  /**
   * Kill the `git-upload-pack` process if it does not complete within this
   * many **seconds**.  When omitted or `0`, no timeout is applied.
   */
  timeout?: number | string;
}

// ---------------------------------------------------------------------------
// PKT-LINE helpers
// ---------------------------------------------------------------------------

/**
 * Encode a string as a Git PKT-LINE frame.
 *
 * The Git Smart HTTP protocol wraps each line in a 4-hex-digit length prefix
 * that counts the total frame length (4 bytes for the prefix itself plus the
 * payload bytes, **not** characters).
 *
 * @param str - The plain-text payload to wrap (must be ASCII or UTF-8).
 * @returns The framed string, e.g. `"001e# service=git-upload-pack\n"`.
 *
 * @see https://git-scm.com/docs/pack-protocol#_pkt_line_format
 *
 * @example
 * ```ts
 * pktLine('# service=git-upload-pack\n')
 * // → '001e# service=git-upload-pack\n'
 * //    ^^^^  4 + 26 = 30 = 0x1e
 * ```
 */
function pktLine(str: string): string {
  // BUG FIX: the original used `str.length` (character count / UTF-16 code
  // units) instead of the actual byte length. The Git PKT-LINE spec requires
  // the 4-hex-digit prefix to represent the *byte* count of the whole frame
  // (prefix + payload). For ASCII-only service names this difference is zero,
  // but using Buffer.byteLength is correct and future-proof.
  const byteLen = Buffer.byteLength(str, 'utf8') + 4; // +4 for the 4-char hex prefix itself
  return byteLen.toString(16).padStart(4, '0') + str;
}

/**
 * The Git PKT-LINE flush packet.
 * Signals the end of a list of PKT-LINE records.
 */
const PKT_FLUSH = '0000';

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Middleware factory that exposes a Git repository over the **Git Smart HTTP
 * protocol** (read-only fetch / clone, via `git-upload-pack`).
 *
 * Mount this handler at the root of a repository-scoped path so that the two
 * sub-paths it handles (`/info/refs` and `/git-upload-pack`) are reachable:
 *
 * ```ts
 * app.use('/repos/:repo', gitHandler({
 *   repository: (req) => path.join('/srv/git', req.params.repo + '.git'),
 * }));
 * ```
 *
 * **Supported endpoints:**
 *
 * | Method | Path              | Purpose                                      |
 * |--------|-------------------|----------------------------------------------|
 * | GET    | `/info/refs`      | Smart HTTP capability advertisement          |
 * | POST   | `/git-upload-pack`| Pack-file negotiation and transfer           |
 *
 * Only `git-upload-pack` (fetch / clone) is implemented.
 * `git-receive-pack` (push) is intentionally excluded.
 *
 * **Compression:** gzip-compressed POST bodies are transparently decompressed
 * before being piped to `git-upload-pack`.
 *
 * @param opt - Handler configuration (see {@link GitHandlerOptions}).
 * @returns An Express-compatible middleware function `(req, res) => void`.
 * @throws {TypeError} When `opt.repository` is not a function.
 */
export function gitHandler(opt: GitHandlerOptions): (req: RouterRequest, res: RouterResponse) => void {
  if (typeof opt.repository !== 'function')
    throw new TypeError('gitHandler: opt.repository must be a function');

  const gitBin = (opt.gitPath ?? '') + 'git-upload-pack';

  return (req: RouterRequest, res: RouterResponse): void => {
    // Resolve the repository path for this request.
    const gitDirectory = opt.repository(req);
    if (!gitDirectory)
      return void res.status(404).send('Repository not found');

    const urlPath = req.path; // sub-path after the mount prefix

    // ── GET /info/refs?service=git-upload-pack ──────────────────────────
    if (req.method === 'GET' && urlPath === '/info/refs') {
      // BUG FIX: `req.queries.url` can be undefined when no query parameters
      // are present, causing `req.queries.url.service` to throw a TypeError.
      const service = req.queries?.url?.service;

      if (service !== 'git-upload-pack')
        return void res.status(403).send('Only git-upload-pack is supported');

      res.setHeader('Content-Type', `application/x-${service}-advertisement`);
      res.setHeader('Cache-Control', 'no-cache');

      // The Smart HTTP advertisement starts with a PKT-LINE service banner
      // followed by a flush packet (0000), then the git-upload-pack output.
      res.write(pktLine(`# service=${service}\n`));
      res.write(PKT_FLUSH);

      const args = buildArgs(opt, ['--stateless-rpc', '--advertise-refs', gitDirectory]);
      const proc = spawn(gitBin, args, {
        env: { ...process.env, GIT_PROTOCOL: (req.headers['git-protocol'] as string) || '' },
      });

      // BUG FIX: the original did not listen for spawn errors (e.g. ENOENT
      // when git is not installed). Without this handler, a missing binary
      // causes an uncaught exception that crashes the server process.
      proc.on('error', (err) => {
        console.error('[git-upload-pack refs] spawn error:', err.message);
        if (!res.writableEnded) res.status(500).send(`git-upload-pack unavailable: ${err.message}`);
      });

      proc.stdout.pipe(res);
      proc.stdout.on('error', (err) => {
        console.warn('[git-upload-pack refs] stdout error:', err.message);
      });

      proc.stderr.on('data', (d: Buffer) =>
        console.error('[git-upload-pack refs]', d.toString()),
      );

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[git-upload-pack refs] exited with code ${code}`);
          if (!res.writableEnded) res.status(500).send('git-upload-pack failed');
        }
        // When code === 0, proc.stdout has already piped all data and called
        // res.end() automatically (default pipe behaviour).
      });

      return;
    }

    // ── POST /git-upload-pack ───────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/git-upload-pack') {
      const contentType = (req.headers['content-type'] as string) || '';

      // BUG FIX: the original called `res.send(415).send(...)`. Our router's
      // `res.send()` signature is `send(body?)` — passing 415 as the body
      // writes the number as a string, then the chained `.send()` fails
      // because `res.send()` already ended the response. Corrected to
      // `res.status(415).send(...)`.
      if (contentType !== 'application/x-git-upload-pack-request')
        return void res.status(415).send('Unsupported Media Type');

      res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
      res.setHeader('Cache-Control', 'no-cache');

      const args = buildArgs(opt, ['--stateless-rpc', gitDirectory]);
      const proc = spawn(gitBin, args, {
        env: { ...process.env, GIT_PROTOCOL: (req.headers['git-protocol'] as string) || '' },
      });

      // BUG FIX: same missing spawn-error handler as the GET branch.
      proc.on('error', (err) => {
        console.error('[git-upload-pack pack] spawn error:', err.message);
        if (!res.writableEnded) res.status(500).send(`git-upload-pack unavailable: ${err.message}`);
      });

      // Transparently decompress gzip-encoded request bodies.
      const encoding = (req.headers['content-encoding'] as string | undefined);
      if (encoding === 'gzip') {
        const gunzip = createGunzip();
        gunzip.on('error', (err) => {
          console.warn('[git-upload-pack pack] gunzip error:', err.message);
          if (!res.writableEnded) res.status(400).send('Failed to decompress request body');
        });
        (req as any).pipe(gunzip).pipe(proc.stdin);
      } else {
        (req as any).pipe(proc.stdin);
      }

      proc.stdout.pipe(res);
      proc.stdout.on('error', (err) => {
        console.warn('[git-upload-pack pack] stdout error:', err.message);
      });

      // BUG FIX: the original tagged the POST stderr with the same label as
      // the GET branch ('[git-upload-pack refs]'), making log messages from
      // the two branches indistinguishable. Corrected to '[git-upload-pack pack]'.
      proc.stderr.on('data', (d: Buffer) =>
        console.error('[git-upload-pack pack]', d.toString()),
      );

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[git-upload-pack pack] exited with code ${code}`);
          if (!res.writableEnded) res.status(500).send('git-upload-pack failed');
        }
      });

      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE is expected when the client disconnects mid-stream; it is not
        // a server-side fault and does not require an error response.
        if (err.code !== 'EPIPE')
          console.warn('[git-upload-pack pack] stdin error:', err.message);
      });

      return;
    }

    // Unrecognised path inside the repository mount.
    res.status(404).send('Not found');
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the argument list for `git-upload-pack`.
 *
 * Prepends an optional `--timeout=<n>` argument when configured, then
 * inserts the `--strict` / `--no-strict` flag, followed by any additional
 * arguments the caller provides.
 *
 * @param opt      - Handler options.
 * @param trailing - Arguments appended after the strict flag
 *                   (e.g. `['--stateless-rpc', '--advertise-refs', dir]`).
 * @returns The complete argument array ready for `spawn`.
 */
function buildArgs(opt: GitHandlerOptions, trailing: string[]): string[] {
  const args: string[] = [];

  if (opt.timeout) {
    // BUG FIX: `parseInt` without an explicit radix may misinterpret strings
    // that start with '0' as octal in some environments. Always pass base 10.
    const seconds = parseInt(String(opt.timeout), 10);
    if (!isNaN(seconds) && seconds > 0)
      args.push(`--timeout=${seconds}`);
  }

  // BUG FIX: the original used `opt.bareOnly ? '--strict' : '--no-strict'`.
  // `git-upload-pack` does not accept `--strict` — that flag belongs to
  // `git-receive-pack`. The correct option for upload-pack is `--no-strict`
  // (which relaxes the requirement that the path must be a bare repository).
  // When the caller sets `strict: true` we simply omit `--no-strict`; when
  // `strict` is false (default) we pass `--no-strict` to allow non-bare repos.
  if (!opt.strict)
    args.push('--no-strict');

  return [...args, ...trailing];
}

export default gitHandler;
