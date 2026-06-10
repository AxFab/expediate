# `serveStatic()` — Static file serving middleware

Serves files from a directory on the filesystem. Supports conditional GET (ETag / Last-Modified), directory index redirects, dot-file handling, and path traversal protection. Only `GET` and `HEAD` requests are served.

## Usage

```ts
import { createRouter, serveStatic } from 'expediate';

const app = createRouter();

// Serve all files from ./public under /static
app.use('/static', serveStatic('./public'));

// Serve with caching headers and directory listings
app.use('/assets', serveStatic('./dist', {
  maxAge: 3_600_000,   // 1 hour in ms
  immutable: true,
  indexOf: true,
}));
```

### SPA catch-all with fallthrough

```ts
// API routes first; anything unmatched falls through to the static handler
app.use('/api', apiRouter);
app.use(serveStatic('./public', { fallthrough: true }));
```

## Signature

```ts
function serveStatic(root: string, options?: StaticOptions): Middleware
```

Throws `TypeError` when `root` is missing or not a string.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `fallthrough` | `boolean` | `true` | When `true`, unmatched requests (wrong method, missing file) call `next()` instead of sending an error response. |
| `maxage` / `maxAge` | `number` | `0` | Browser cache lifetime in **milliseconds**. Translated to `Cache-Control: public, max-age=<seconds>`. |
| `immutable` | `boolean` | `false` | Append `, immutable` to `Cache-Control`. Only meaningful when `maxage` is non-zero. |
| `etag` | `boolean` | `true` | Generate and send a weak `ETag` header based on file size and mtime. |
| `lastModified` | `boolean` | `true` | Send a `Last-Modified` header derived from the file's `mtime`. |
| `contentType` | `string \| null` | `null` | Override the auto-detected `Content-Type`. Skips MIME detection when set. |
| `dotfiles` | `'allow' \| 'deny' \| 'hide'` | `'hide'` | How to handle dot-files: `'allow'` serves them, `'deny'` returns 403, `'hide'` returns 404. |
| `redirect` | `boolean` | `true` | When `true`, a directory path is redirected to its `index.html`. |
| `indexOf` | `boolean` | `false` | When `true`, requests for directories without an `index.html` render an Apache-style directory listing. |
| `headers` | `Record<string, string>` | `{ 'Content-Security-Policy': "default-src 'self'", 'X-Content-Type-Options': 'nosniff' }` | Extra response headers merged with (and extending) the built-in security headers. |

## Conditional GET / HTTP caching

ETags use the format `W/"<size_hex>-<mtime_hex>"`. The middleware evaluates:

- `If-None-Match` against the ETag → 304 Not Modified
- `If-Modified-Since` against the file's `mtime` → 304 Not Modified
- `Cache-Control: no-cache` in the request forces a full response even when the ETag matches.
- `If-Match` / `If-Unmodified-Since` → 412 Precondition Failed when the condition fails.

## Path traversal protection

Any request path containing `..` (in any position, including with back-slashes) is rejected with **403 Forbidden** before reaching the filesystem. After `path.resolve()`, the result is also checked to confirm it falls within the declared `root`; anything that resolves outside returns **403**.

## Malformed percent-encoding

Request paths with invalid percent-encoded characters (e.g. `/%zz`, `/%a`) are rejected with **400 Bad Request** rather than causing an internal error.

## Directory listing security

When `indexOf: true`, all user-controlled content interpolated into the HTML listing (URL path, parent directory path, filenames) is HTML-escaped before rendering, and link `href` values use `encodeURIComponent`. This prevents XSS when a directory contains files with HTML-significant characters.

## Method filtering

Only `GET` and `HEAD` are served. Other methods receive **405 Method Not Allowed** (with an `Allow: GET, HEAD` header) when `fallthrough` is `false`, or are passed to the next middleware when `fallthrough` is `true`.

## Internal overview

On each request the middleware:

1. Rejects non-GET/HEAD methods (fallthrough or 405).
2. Decodes the URL path — returns **400** on malformed percent-encoding — then applies the traversal guard and root containment check.
3. Applies dot-file rules.
4. Calls `fs.stat()` on the resolved absolute filesystem path.
5. For directories, redirects to `index.html` (or renders a listing when `indexOf: true`).
6. For regular files, delegates to `sendIt()` which sets ETag, Last-Modified, Content-Type, and Cache-Control headers, evaluates conditional GET, then streams the file body via `fs.createReadStream().pipe(res)`.
