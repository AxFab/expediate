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

// GIT

const { spawn } = require('child_process');
const { createGunzip } = require('zlib');

// Handler for serving a Git remote repository via the Smart HTTP protocol.
function gitHandler(opt) {
  return (req, res) => {
    const gitDirectory = opt.repository(req);
    const gitUploadPack = (opt.gitPath ?? '') + 'git-upload-pack';
    if (!gitDirectory)
      return res.status(404).send('Repository not found');

    const urlPath = req.path; // sub-path after base root
    // GET /info/refs?service=git-upload-pack
    if (req.method === 'GET' && urlPath === '/info/refs') {
      // const service = req.query.service; -- does this work on expressjs !!?
      // const service = req.params.service; // Work on expediate
      const service = req.queries.url.service; // ?
      if (service !== 'git-upload-pack')
        return res.status(403).send('Only git-upload-pack is supported');

      res.setHeader('Content-Type', `application/x-${service}-advertisement`);
      res.setHeader('Cache-Control', 'no-cache');

      // The Smart HTTP advertisement begins with a pkt-line flush + service header
      const pktLine = (str) => {
        const len = (str.length + 4).toString(16).padStart(4, '0');
        return `${len}${str}`
      }

      res.write(pktLine(`# service=${service}\n`));
      res.write('0000') // flush packet

      const args = [opt.bareOnly ? '--strict' : '--no-strict', '--stateless-rpc', '--advertise-refs', gitDirectory];
      if (opt.timeout)
        args.unshift(`--timeout=${parseInt(opt.timeout)}`)
      const proc = spawn(gitUploadPack, args, {
        env: { ...process.env, GIT_PROTOCOL: req.headers['git-protocol'] || '' }
      });

      proc.stdout.pipe(res);
      proc.stderr.on('data', (d) => console.error('[git-upload-pack refs]', d.toString()));

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`git-upload-pack exited with code ${code}`);
          if (!res.headersSent) res.status(500).send('git-upload-pack failed');
          else res.end();
        }
      });
      return;
    }

    // POST /git-upload-pack
    if (req.method === 'POST' && urlPath === '/git-upload-pack') {
      const contentType = req.headers['content-type'] || '';
      if (contentType !== 'application/x-git-upload-pack-request')
        return res.send(415).send('Unsupported Media Type');

      res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
      res.setHeader('Cache-Control', 'no-cache');

      const args = [opt.bareOnly ? '--strict' : '--no-strict', '--stateless-rpc', gitDirectory];
      if (opt.timeout)
        args.unshift(`--timeout=${parseInt(opt.timeout)}`)
      const proc = spawn(gitUploadPack, args,  {
        env: { ...process.env, GIT_PROTOCOL: req.headers['git-protocol'] || '' }
      });

      // Handle  compressed request bodies transparently
      const encoding = req.headers['content-encoding'];
      const input = encoding === 'gzip' ? req.pipe(createGunzip()) : req;

      input.pipe(proc.stdin);

      proc.stdout.pipe(res);
      proc.stderr.on('data', (d) => console.error('[git-upload-pack refs]', d.toString()));

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`git-upload-pack exited with code ${code}`);
          if (!res.headersSent) res.status(500).send('git-upload-pack failed');
          else res.end();
        }
      });

      proc.stdin.on('error', (err) => {
        // Client disconnected mid-stream - not a server fault
        console.warn('[git-upload-pack] stdin error:', err.message);
      });
      return;
    }

    res.status(404).send('Not found');
  }
}


module.exports = { gitHandler };
