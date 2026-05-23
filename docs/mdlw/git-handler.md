# `gitHandler()` — Git Smart HTTP middleware

Exposes a Git repository over the **Git Smart HTTP protocol**, enabling `git clone`, `git fetch`, and `git push` over plain HTTP. Spawns `git-upload-pack` (for read operations) and `git-receive-pack` (for push operations) as child processes and proxies the protocol streams between Git and the HTTP client.

## Usage

```ts
import { createRouter, gitHandler } from 'expediate';
import path from 'path';

const app = createRouter();

// Serve a single bare repository
app.use('/myrepo.git', gitHandler({
  repository: () => '/srv/git/myrepo.git',
}));

// Dynamic: resolve repository from a URL parameter
app.use('/repos/:repo', gitHandler({
  repository: (req) => {
    const name = req.params.repo;
    if (!name || name.includes('..')) return null; // return null → 404
    return path.join('/srv/git', name + '.git');
  },
}));
```

### With options

```ts
app.use('/repos/:repo', gitHandler({
  repository: (req) => path.join('/srv/git', req.params.repo + '.git'),
  gitPath: '/usr/lib/git-core/',   // custom binary location
  strict: true,                    // require a bare repository
  timeout: 30,                     // kill upload-pack after 30s
}));
```

## Signature

```ts
function gitHandler(opt: GitHandlerOptions): (req: RouterRequest, res: RouterResponse) => void
```

Throws `TypeError` when `opt.repository` is not a function.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `repository` | `(req) => string \| null \| undefined \| false` | *(required)* | Resolves the absolute filesystem path of the Git repository for this request. Return a non-empty string to serve that repository, or a falsy value to respond with **404 Repository not found**. |
| `gitPath` | `string` | `''` | Directory containing the `git-upload-pack` and `git-receive-pack` binaries, including trailing separator (e.g. `'/usr/lib/git-core/'`). Leave empty to locate via `PATH`. |
| `strict` | `boolean` | `false` | When `true`, passes `--strict` to `git-upload-pack`, causing it to exit with an error if the path is not a bare repository. |
| `timeout` | `number \| string` | `undefined` | Kill timeout in **seconds**. When set, passes `--timeout=<n>` to `git-upload-pack`. `git-receive-pack` is not subject to this timeout. |

## Supported endpoints

| Method | Path | Service | Purpose |
|---|---|---|---|
| `GET` | `/info/refs?service=git-upload-pack` | `git-upload-pack` | Capability advertisement for fetch/clone. |
| `GET` | `/info/refs?service=git-receive-pack` | `git-receive-pack` | Capability advertisement for push. |
| `POST` | `/git-upload-pack` | `git-upload-pack` | Pack-file negotiation and transfer (fetch/clone). |
| `POST` | `/git-receive-pack` | `git-receive-pack` | Pack-file transfer (push). |

Any other path or method returns **403 Forbidden** or **415 Unsupported Media Type** respectively.

## PKT-LINE protocol

The `GET /info/refs` response follows the Git Smart HTTP format: it begins with a PKT-LINE service banner (`# service=<name>\n`) followed by a flush packet (`0000`), then the raw output of the spawned process. PKT-LINE frames are encoded as a 4-hex-digit byte-length prefix followed by the payload.

## Compression

gzip-encoded `POST` request bodies (sent by some Git clients) are transparently decompressed via `zlib.createGunzip()` before being piped to the `git-upload-pack` or `git-receive-pack` process stdin.

## Important notes

- **Mount with `app.use()`**, not `app.get()` or `app.post()`, so that the path prefix is stripped and the handler sees only the sub-path (`/info/refs`, `/git-upload-pack`, etc.).
- **Bare repositories only** for server hosting. Regular repositories work but should be treated with care.
- **No built-in authentication**: add an authentication middleware before `gitHandler()` to protect repositories.
- **`EPIPE` errors on `proc.stdin`** are silently ignored — they occur when the Git client disconnects mid-stream (normal operation).
- **Error handling**: spawn errors and non-zero exit codes result in 500 Internal Server Error, logged to `console.error`.

## `gitCreate()` — Create a repository

A helper to programmatically initialise a new Git repository on disk:

```ts
import { gitCreate } from 'expediate';

await gitCreate('/srv/git/newrepo.git', {
  bare: true,          // default: true
  description: 'My new repository',
});
```

### `gitCreate` signature

```ts
function gitCreate(gitDirectory: string, opt: GitCreateOption): Promise<void>
```

### `GitCreateOption`

| Option | Type | Default | Description |
|---|---|---|---|
| `bare` | `boolean` | `true` | Initialise as a bare repository (no working tree). |
| `gitPath` | `string` | `''` | Directory containing the `git` binary, with trailing separator. |
| `description` | `string` | `undefined` | Written to `<gitDirectory>/description`. Omit to leave the default placeholder. |

## Internal overview

`gitHandler()` returns a function that handles all four endpoint patterns with a single function. On each request:

1. `opt.repository(req)` is called to resolve the repository path. A falsy return triggers a 404.
2. The URL sub-path and HTTP method are matched against the four known patterns.
3. For GET `/info/refs`, the service name is extracted from the `?service=` query parameter. The process is spawned with `--stateless-rpc --advertise-refs`, and the PKT-LINE banner is written to the response before piping `proc.stdout` directly to `res`.
4. For POST requests, the `Content-Type` is validated, the process is spawned with `--stateless-rpc`, and `req` (optionally gunzipped) is piped to `proc.stdin`, while `proc.stdout` is piped to `res`.
