# `compress()` — Response compression middleware

Transparently compresses HTTP response bodies using Brotli, gzip, or deflate based on the client's `Accept-Encoding` header. Responses smaller than a configurable threshold are sent uncompressed to avoid wasting CPU on tiny payloads.

## Usage

```ts
import { createRouter, compress } from 'expediate';

const app = createRouter();

// Register at the very top so all downstream handlers are covered
app.use(compress());

app.get('/api/data', (_req, res) => res.json(bigPayload));
```

### Custom options

```ts
// Disable Brotli, lower threshold
app.use(compress({
  br: false,
  threshold: 512,
  gzipLevel: 6,
}));

// Skip compression for already-compressed image types
app.use(compress({
  filter: (_req, res) => {
    const ct = res.getHeader('content-type') as string ?? '';
    return !/^image\//.test(ct);
  },
}));
```

## Signature

```ts
function compress(opts?: CompressOptions): Middleware
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | `number` | `1024` | Minimum body size in bytes before compression is applied. |
| `br` | `boolean` | `true` | Enable Brotli (`br`) encoding when the client supports it. |
| `brotliQuality` | `number` | `4` | Brotli quality level (0–11). Higher = smaller output, slower CPU. |
| `gzipLevel` | `number` | `zlib.constants.Z_DEFAULT_COMPRESSION` | gzip / deflate compression level (1–9). |
| `filter` | `(req, res) => boolean` | `undefined` | Custom per-request filter. Return `false` to skip compression for that request. |

## Encoding preference

Encodings are tested in the following preference order:

1. **Brotli (`br`)** — best compression ratio for text; supported by all modern browsers. Only used when `br: true` (default) and the client includes `br` in `Accept-Encoding`.
2. **gzip** — widely supported, good compression for text and JSON.
3. **deflate** — fallback when `gzip` is not in the client's `Accept-Encoding`.

If none of these encodings is advertised by the client, the middleware calls `next()` without modifying the response.

## Headers set automatically

| Header | Value |
|---|---|
| `Content-Encoding` | `br`, `gzip`, or `deflate` |
| `Vary` | `Accept-Encoding` |
| `Content-Length` | **removed** — compressed length is unknown in advance |

## Important notes

- **Register first**: place `compress()` at the top of the middleware stack, before route handlers, so it can intercept `res.write` and `res.end` before they are called.
- **Threshold behaviour**: data is buffered until the response ends (or until the total exceeds `threshold` mid-stream). If the final body is below the threshold, the buffer is flushed directly and compression is skipped.
- **Not suitable for streaming large files alongside `serveStatic`**: the threshold buffer will hold the entire response in memory for small files and compress large ones, which is correct for JSON/HTML but wasteful for binary blobs. Use the `filter` option to exempt binary content types.

## Internal overview

The middleware monkey-patches `res.write` and `res.end` on each request. All data written by downstream handlers is accumulated in a `Buffer[]` array (`pending`). When the total buffered size crosses `threshold`, compression starts immediately (committed for compression). At `res.end()` time:

- If not yet decided and total bytes ≥ threshold → `startCompressing(andEnd: true)` flushes all buffered chunks to the compressor, sets `Content-Encoding` / `Vary`, and removes `Content-Length`.
- If not yet decided and total bytes < threshold → `skipCompression()` restores `Content-Length` and writes buffered data directly through the original `res.write`.
- If already decided → routes data to the compressor or directly to the socket.

Compressor output is piped back to the original, unpatched `res.write` / `res.end` functions captured before patching.
