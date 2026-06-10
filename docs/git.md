# Git Smart HTTP Gateway

`gitHandler` implements the Git Smart HTTP protocol, enabling clients to clone, fetch, and push to Git repositories over plain HTTP. No additional dependencies beyond a working `git` installation are required.

---

## Quick start

```ts
import { createRouter, gitHandler } from 'expediate';
import path from 'path';

const app = createRouter();

app.use('/repos/:repo', gitHandler({
  repository: (req) => {
    const name = req.params.repo;
    // Validate to prevent path confusion
    if (!/^[\w.-]+$/.test(name)) return null;
    return path.join('/srv/git', name + '.git');
  },
}));

app.listen(3000);
```

Clients can now clone, fetch, and push:

```bash
git clone http://localhost:3000/repos/myproject
git push  http://localhost:3000/repos/myproject HEAD:main
```

---

## Supported endpoints

| Method | Path pattern | Git service | Purpose |
|---|---|---|---|
| `GET` | `/info/refs?service=git-upload-pack` | `git-upload-pack` | Capability advertisement (fetch/clone) |
| `POST` | `/git-upload-pack` | `git-upload-pack` | Pack negotiation and transfer (fetch/clone) |
| `GET` | `/info/refs?service=git-receive-pack` | `git-receive-pack` | Capability advertisement (push) |
| `POST` | `/git-receive-pack` | `git-receive-pack` | Pack transfer (push) |

`gitHandler` registers all four endpoints under the mounted prefix.

---

## `gitHandler(options)`

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `repository` | `(req) => string \| null \| false` | **required** | Resolve the absolute path to the bare Git repository. Return a falsy value to send `404` |
| `gitPath` | `string` | `''` | Filesystem path prefix to the `git` binary directory (include trailing `/`) |
| `strict` | `boolean` | `false` | When `true`, passes `--strict` to `git-upload-pack`; rejects non-bare repositories |
| `timeout` | `number \| string` | — | Kill `git-upload-pack` after this many **seconds** if it does not finish |

The `repository` callback receives the augmented `RouterRequest`, so `req.params`, `req.cookies`, and any upstream middleware (e.g. auth) are available:

```ts
gitHandler({
  repository: async (req) => {
    // Auth check using upstream middleware result
    if (!(req as any).user) return null;
    const name = (req as any).user.repoName;
    return path.join('/srv/git', name + '.git');
  },
})
```

### Error handling

| Situation | Response |
|---|---|
| `repository()` returns falsy | `404 Not Found` |
| `git` spawn fails (e.g. not installed) | `500 Internal Server Error` |
| `git` exits with non-zero code | `500 Internal Server Error` |
| Unrecognised path (not a git endpoint) | Calls `next()` (falls through) |

Client disconnections during streaming (`EPIPE` on stdin) are silently ignored.

### Gzip bodies

`POST` bodies with `Content-Encoding: gzip` are decompressed transparently before being piped to the git process.

---

## `gitCreate(gitDirectory, options?)`

Programmatically initialise a new bare Git repository:

```ts
import { gitCreate } from 'expediate';

await gitCreate('/srv/git/myproject.git', {
  description: 'My project repository',
});
```

Runs `git init --bare` and optionally writes a `description` file.

| Option | Type | Description |
|---|---|---|
| `description` | `string` | Contents of the repository's `description` file |
| `gitPath` | `string` | Same as `gitHandler` — directory prefix for the `git` binary |

---

## Access control

`gitHandler` itself does not enforce authentication or authorisation. Wire in upstream middleware before the handler:

```ts
// Require Bearer token for all git operations
const requireToken: Middleware = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).end('Unauthorized');
  next();
};

app.use('/repos/:repo', requireToken, gitHandler({ repository: resolveRepo }));
```

For repository-level read/write separation, inspect `req.path` and `req.method` inside the `repository` callback:

```ts
gitHandler({
  repository: (req) => {
    const name = req.params.repo;
    const isPush = req.path.endsWith('/git-receive-pack') ||
                   (req.path.endsWith('/info/refs') && req.query['service'] === 'git-receive-pack');
    if (isPush && !(req as any).user?.canPush) return null;
    return path.join('/srv/git', name + '.git');
  },
})
```
