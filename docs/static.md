# Static File Serving

Expediate includes a full static file serving implementation with ETag caching, conditional GET, MIME detection, dot-file policies, path traversal protection, and an optional directory listing.

---

## `serveStatic(root, opts?)`

Serve all files under a directory:

```ts
import { serveStatic } from 'expediate';

app.use('/public', serveStatic('./dist'));
```

### StaticOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `fallthrough` | `boolean` | `true` | Call `next()` instead of 404 for missing files/paths |
| `dotfiles` | `'allow' \| 'deny' \| 'hide'` | `'hide'` | Dot-file access: `allow` serves them, `deny` sends 403, `hide` sends 404 |
| `redirect` | `boolean` | `true` | Redirect bare directory URLs to their trailing-slash form |
| `index` | `string` | `'index.html'` | Default file to serve for directory requests |
| `etag` | `boolean` | `true` | Send weak `ETag` header (`W/"<size_hex>-<mtime_hex>"`) |
| `lastModified` | `boolean` | `true` | Send `Last-Modified` header |
| `maxage` / `maxAge` | `number` | `0` | Cache lifetime in **milliseconds** → `Cache-Control: public, max-age=<s>` |
| `immutable` | `boolean` | `false` | Append `, immutable` to `Cache-Control` |
| `contentType` | `string \| null` | `null` | Override the auto-detected `Content-Type` |
| `headers` | `Record<string, string>` | security defaults | Extra response headers, merged with built-in security headers |
| `indexOf` | `boolean` | `false` | Enable Apache-style directory listing |

### HTTP methods

Only `GET` and `HEAD` are served. Other methods receive **405 Method Not Allowed** (or fall through if `fallthrough: true`).

### Default security headers

Every static response includes these headers by default:

```
Content-Security-Policy: default-src 'self'
X-Content-Type-Options: nosniff
```

### Conditional GET (caching)

`serveStatic` honours `If-None-Match` and `If-Modified-Since` request headers. When the client's cached version is still fresh, a `304 Not Modified` is returned with no body. `Cache-Control: no-cache` forces a full response even when the ETag matches.

---

## `serveFile(filepath, opts?)`

Serve a single fixed file for every request — useful for SPA catch-all routes:

```ts
import { serveFile } from 'expediate';

// Serve dist/index.html for every unmatched path
app.get('/**', serveFile('./dist/index.html'));
```

Accepts the same options as `serveStatic()`. Returns `500 EISDIR` if the path resolves to a directory.

---

## `sendFile(req, res, filepath, opts?)`

Low-level utility for sending a dynamically resolved file path. Does not require middleware wrapping:

```ts
import { sendFile } from 'expediate';

app.get('/downloads/:name', (req, res) => {
  const fp = path.join('./downloads', req.params.name);
  sendFile(req as any, res as any, fp);
});
```

---

## MIME type detection

The `mime` object provides type lookup:

```ts
import { mime } from 'expediate';

mime.lookup('image.png');              // 'image/png'
mime.lookup('archive.tar.gz');         // 'application/gzip'
mime.lookup('file', 'text/plain');     // fallback to 'text/plain' if unknown
mime.charsets('text/html');            // 'UTF-8'
mime.charsets('image/png');            // null
```

MIME types are loaded from a bundled `mimetypes.json` file.

---

## Directory listing

When `indexOf: true`, requesting a directory URL generates an Apache-style HTML listing with sortable columns:

```ts
app.use('/', serveStatic('./public', { indexOf: true }));
```

Sort controls use query parameters: `C` for column (`N`=name, `M`=mtime, `S`=size) and `O` for order (`A`=ascending, `D`=descending). Directories always sort above files regardless of the active column.

All user-controlled content (URL paths, filenames) is **HTML-escaped** before being inserted into the page. Link `href` values use `encodeURIComponent`. This prevents XSS when a directory contains files with HTML-significant names.

---

## Security

### Path traversal protection

All resolved file paths are checked against the declared root. Any path that resolves outside the root is rejected with `403 Forbidden`. This is a defense-in-depth check that runs after the `..` segment guard (`/(\/|^)(\.\.?)(\/|$)/`).

### Malformed percent-encoding

Requests with malformed percent-encoded characters in the path (e.g. `/%zz`, `/%a`) receive `400 Bad Request` instead of a 500 error.

### Dot-file policy

The default `dotfiles: 'hide'` policy responds with `404` for paths that include a dot-file segment, without revealing whether the file exists.
