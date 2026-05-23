# `serveFile()` — Single-file serving middleware

Middleware factory that serves a **single, fixed file** as the response to every matching request, regardless of the request path. Useful for serving a compiled single-page application's `index.html` as a catch-all route, or for exposing a specific file at a known URL.

## Usage

```ts
import { createRouter, serveFile } from 'expediate';

const app = createRouter();

// Serve dist/index.html for all unmatched routes (SPA pattern)
app.get('/**', serveFile('./dist/index.html'));

// Serve a specific file at a fixed URL
app.get('/robots.txt', serveFile('./public/robots.txt'));

// With caching
app.get('/manifest.json', serveFile('./public/manifest.json', {
  maxAge: 3_600_000,
  etag: true,
}));
```

## Signature

```ts
function serveFile(filePath: string, options?: StaticOptions): Middleware
```

Throws `TypeError` when `filePath` is missing or not a string.

## Options

Accepts the same [`StaticOptions`](./serve-static.md#options) as `serveStatic()`. The most relevant ones for single-file serving are:

| Option | Type | Default | Description |
|---|---|---|---|
| `maxage` / `maxAge` | `number` | `0` | Browser cache lifetime in **milliseconds**. Sets `Cache-Control: public, max-age=<seconds>`. |
| `immutable` | `boolean` | `false` | Append `, immutable` to `Cache-Control`. |
| `etag` | `boolean` | `true` | Generate and send a weak `ETag` from file size and mtime. |
| `lastModified` | `boolean` | `true` | Send `Last-Modified` from the file's `mtime`. |
| `contentType` | `string \| null` | `null` | Override the auto-detected `Content-Type`. |
| `headers` | `Record<string, string>` | `{ 'Content-Security-Policy': "default-src 'self'", 'X-Content-Type-Options': 'nosniff' }` | Extra response headers merged with the built-in security headers. |
| `fallthrough` | `boolean` | `true` | When `true`, wrong-method requests call `next()` instead of returning 405. |

Note: `dotfiles`, `redirect`, `indexOf`, and directory-listing options are not meaningful for single-file serving.

## How it differs from `serveStatic()`

| | `serveStatic(root)` | `serveFile(filePath)` |
|---|---|---|
| Input | A **directory** | A **single file** |
| Path matching | Maps request path to a file within `root` | Always serves the same file regardless of path |
| Directory support | Supports redirects and listings | Returns 500 if `filePath` is a directory |
| Typical use | Serving a `public/` folder | SPA catch-all, serving known individual files |

## Important notes

- Only `GET` and `HEAD` are served. Other methods receive 405 Method Not Allowed (or call `next()` when `fallthrough: true`).
- If `filePath` resolves to a directory, the middleware responds with **500 Internal Server Error**.
- There is no path traversal check because the path is fixed at middleware-creation time rather than derived from the request URL.
- Conditional GET is fully supported: `If-None-Match` and `If-Modified-Since` are evaluated on every request, enabling efficient browser caching.

## Internal overview

At creation time, `filePath` is resolved to an absolute path via `path.resolve()` and stored in `opts.root`. On each request, `fs.stat(opts.root)` is called to get the current file metadata. The stat result is passed directly to `sendIt()`, which sets all caching and content headers and streams the file body.
