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
import { writeFileSync } from 'fs';

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
  repository: (req: RouterRequest) => string | null | undefined | false | Promise<string | null | undefined | false>;

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

export interface GitCreateOption {
  /**
   * Directory that contains the `git` executable, including a trailing path
   * separator (e.g. `'/usr/lib/git-core/'`).
   *
   * Leave empty (default) to locate the binary via the system `PATH`.
   */
  gitPath?: string;

  /**
   * Human-readable description written to the repository's `description` file.
   *
   * For a bare repository the file is at `<gitDirectory>/description`.
   * For a working-tree repository the file is at `<gitDirectory>/.git/description`.
   *
   * When omitted, no description file is written and Git's default placeholder
   * text is left in place.
   */
  description?: string;

  /**
   * When `true` (the default), the repository is initialised as a **bare**
   * repository — no working tree is created and Git objects are stored directly
   * inside `gitDirectory`.  Bare repositories are the standard choice for
   * server-side hosting because they cannot be accidentally modified by editing
   * files directly.
   *
   * When `false`, a regular repository with a working tree is created (equivalent
   * to running `git init <gitDirectory>` on the command line).
   *
   * @default true
   */
  bare?: boolean;
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
 * | Method | Path               | Purpose                                      |
 * |--------|--------------------|----------------------------------------------|
 * | GET    | `/info/refs`       | Smart HTTP capability advertisement          |
 * | POST   | `/git-upload-pack` | Pack-file negotiation and transfer           |
 * | POST   | `/git-receive-pack`| Pack-file publish and transfer               |
 *
 * **Compression:** gzip-compressed POST bodies are transparently decompressed
 * before being piped to `git-upload-pack`.
 *
 * @param opt - Handler configuration (see {@link GitHandlerOptions}).
 * @returns An Express-compatible middleware function `(req, res) => void`.
 * @throws {TypeError} When `opt.repository` is not a function.
 */
export function gitHandler(opt: GitHandlerOptions): (req: RouterRequest, res: RouterResponse) => void | Promise<void> {
  if (typeof opt.repository !== 'function')
    throw new TypeError('gitHandler: opt.repository must be a function');

  const gitHome = opt.gitPath ?? '';

  return async (req: RouterRequest, res: RouterResponse): Promise<void> => {
    // Resolve the repository path for this request.
    const gitDirectory = await opt.repository(req);
    if (!gitDirectory) {
      res.status(404).send('Repository not found');
      return
    }

    const urlPath = req.path; // sub-path after the mount prefix

    // ── GET /info/refs?service=git-xxxxxx-pack ──────────────────────────
    if (req.method === 'GET' && urlPath === '/info/refs') {

      let args: string[];
      const service = req.queries?.url?.service;
      if (service === 'git-upload-pack')
        args = buildArgs(opt, ['--stateless-rpc', '--advertise-refs', gitDirectory]);
      else if (service === 'git-receive-pack')
        args = ['--stateless-rpc', '--advertise-refs', gitDirectory]
      else {
        res.status(403).send(`Service ${String(service)} is not supported`);
        return
      }

      res.setHeader('Content-Type', `application/x-${service}-advertisement`);
      res.setHeader('Cache-Control', 'no-cache');
      // The Smart HTTP advertisement starts with a PKT-LINE service banner
      // followed by a flush packet (0000), then the git-upload-pack output.
      res.write(pktLine(`# service=${service}\n`));
      res.write(PKT_FLUSH);

      const proc = spawn(gitHome + service, args, {
        env: { ...process.env, GIT_PROTOCOL: (req.headers['git-protocol'] as string) || '' },
      });

      proc.on('error', (err) => {
        console.error(`[${service} GET] spawn error:`, err.message);
        if (!res.writableEnded) res.status(500).send(`${service} unavailable: ${err.message}`);
      });

      proc.stdout.pipe(res);
      proc.stdout.on('error', (err) => {
        console.warn(`[${service} GET] stdout error:`, err.message);
      });

      proc.stderr.on('data', (d: Buffer) =>
        console.error(`[${service} GET]`, d.toString()),
      );

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[${service} GET] exited with code ${code}`);
          if (!res.writableEnded) res.status(500).send(`${service} failed`);
        }
        // When code === 0, proc.stdout has already piped all data and called
        // res.end() automatically (default pipe behaviour).
      });

      return;
    }

    // ── POST /git-upload-pack or /git-receive-pack ──────────────────────
    if (req.method === 'POST' && (urlPath === '/git-upload-pack' || urlPath === '/git-receive-pack')) {
      const contentType = (req.headers['content-type']!) || '';
      const service = urlPath.substring(1);

      if (contentType !== `application/x-${service}-request`) {
        res.status(415).send('Unsupported Media Type');
        return
      }

      let args: string[];
      if (service === 'git-upload-pack')
        args = buildArgs(opt, ['--stateless-rpc', gitDirectory]);
      else if (service === 'git-receive-pack')
        args = ['--stateless-rpc', gitDirectory]
      else {
        res.status(403).send(`Service ${service} is not supported`);
        return
      }

      res.setHeader('Content-Type', `application/x-${service}-result`);
      res.setHeader('Cache-Control', 'no-cache');

      const proc = spawn(gitHome + service, args, {
        env: { ...process.env, GIT_PROTOCOL: (req.headers['git-protocol'] as string) || '' },
      });

      proc.on('error', (err) => {
        console.error(`[${service} POST] spawn error:`, err.message);
        if (!res.writableEnded) res.status(500).send(`${service} unavailable: ${err.message}`);
      });

      // Transparently decompress gzip-encoded request bodies.
      const encoding = (req.headers['content-encoding']);
      if (encoding === 'gzip') {
        const gunzip = createGunzip();
        gunzip.on('error', (err) => {
          console.warn(`[${service} POST] gunzip error:`, err.message);
          if (!res.writableEnded) res.status(400).send('Failed to decompress request body');
        });
        req.pipe(gunzip).pipe(proc.stdin);
      } else {
        req.pipe(proc.stdin);
      }

      proc.stdout.pipe(res);
      proc.stdout.on('error', (err) => {
        console.warn(`[${service} POST] stdout error:`, err.message);
      });

      proc.stderr.on('data', (d: Buffer) =>
        console.error(`[${service} POST]`, d.toString()),
      );

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[${service} POST] exited with code ${code}`);
          if (!res.writableEnded) res.status(500).send(`${service} failed`);
        }
      });

      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE is expected when the client disconnects mid-stream; it is not
        // a server-side fault and does not require an error response.
        if (err.code !== 'EPIPE')
          console.warn(`[${service} POST] stdin error:`, err.message);
      });

      return;
    }

    // Unrecognised path inside the repository mount.
    res.status(404).send('Not found');
  };
}

/**
 * Initialise a new Git repository at `gitDirectory` by running `git init`.
 *
 * By default a **bare** repository is created (no working tree), which is the
 * conventional layout for server-side hosting.  Pass `{ bare: false }` to
 * create a standard repository with a working tree instead.
 *
 * @param gitDirectory - Absolute filesystem path of the directory in which
 *   the repository will be created.  The directory is created by Git if it
 *   does not already exist.
 * @param opt - Creation options.  All fields are optional.
 * @param opt.gitPath - Directory containing the `git` binary (with trailing
 *   separator).  Defaults to `''` so that the system `PATH` is used.
 * @param opt.bare - When `true` (default) a bare repository is created
 *   (`git init --bare`).  When `false` a regular working-tree repository is
 *   created (`git init`).
 * @param opt.description - Text written to the repository's `description`
 *   file after initialisation.  Bare: `<gitDirectory>/description`;
 *   non-bare: `<gitDirectory>/.git/description`.  Skipped when omitted.
 * @returns A `Promise` that resolves when the repository has been
 *   successfully created, or rejects with an error message string when the
 *   `git` process fails to start or exits with a non-zero code.
 *
 * @example
 * ```ts
 * // Create a bare repository (default — suitable for server hosting)
 * await gitCreate('/srv/git/myproject.git', { description: 'My project' });
 *
 * // Create a regular repository with a working tree
 * await gitCreate('/home/user/myproject', { bare: false });
 * ```
 */
export function gitCreate(gitDirectory: string, opt: GitCreateOption): Promise<void> {

  return new Promise((resolve, reject) => {

    const gitHome = opt.gitPath ?? '';
    const isBare  = opt.bare !== false; // default true
    const args    = isBare
      ? ['init', '--bare', gitDirectory]
      : ['init', gitDirectory];

    const proc = spawn(gitHome + 'git', args, {
      env: { ...process.env },
    });

    proc.on('error', (err) => {
      console.error(`[git init] spawn error:`, err.message);
      reject(`git unavailable: ${err.message}`);
    });

    proc.stdout.on('error', (err) => {
      console.warn(`[git init] stdout error:`, err.message);
    });

    proc.stderr.on('data', (d: Buffer) =>
      console.error(`[git init]`, d.toString()),
    );

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject('git failed');
      }
      if (opt.description) {
        // Bare repos store the description at the root; working-tree repos
        // store it inside the hidden .git sub-directory.
        const descPath = isBare
          ? `${gitDirectory}/description`
          : `${gitDirectory}/.git/description`;
        writeFileSync(descPath, opt.description);
      }
      resolve();
    });

  });
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
    const seconds = parseInt(String(opt.timeout), 10);
    if (!isNaN(seconds) && seconds > 0)
      args.push(`--timeout=${seconds}`);
  }

  if (!opt.strict)
    args.push('--no-strict');

  return [...args, ...trailing];
}

export default gitHandler;
