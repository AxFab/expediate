# `streamFormData()` — Streaming multipart form-data reader

An async generator that yields each part of a `multipart/form-data` request body as a `FormPartStream` object. Unlike [`formData()`](./form-data.md), this is called directly inside a handler rather than registered as middleware.

## Usage

```ts
import { createRouter, streamFormData } from 'expediate';

const app = createRouter();

app.post('/upload', async (req, res) => {
  for await (const part of streamFormData(req)) {
    const cd = part.headers['content-disposition'] ?? '';
    const name     = /name="([^"]+)"/.exec(cd)?.[1];
    const filename = /filename="([^"]+)"/.exec(cd)?.[1];

    // Collect the part content from its Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of part.stream) chunks.push(chunk);
    const content = Buffer.concat(chunks);

    console.log(`Field: ${name}, File: ${filename}, Size: ${content.length}`);
  }
  res.json({ ok: true });
});
```

## Signature

```ts
async function* streamFormData(
  req:  RouterRequest,
  opts?: BodyOptions,
): AsyncGenerator<FormPartStream>
```

### `FormPartStream`

```ts
type FormPartStream = {
  /** Lowercased, trimmed part headers. */
  headers: Record<string, string>;
  /** Part content as a Node.js Readable stream (yields the full part as a single chunk then ends). */
  stream: Readable;
};
```

## Options

Accepts `BodyOptions` (only `limit` and `inflate` are meaningful):

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Maximum accepted total body size. |
| `inflate` | `boolean` | `true` | Accept compressed request bodies. |

## Important notes

- **Not a middleware** — call `streamFormData(req, opts)` directly inside `async` handlers.
- Despite the "streaming" name, the **entire request body is still buffered in memory** before parts are yielded. This is required because the multipart boundary must span the whole body. For very large uploads, read from `req` as a raw `AsyncIterable<Buffer>` instead.
- The `stream` on each `FormPartStream` is a `Readable` created from the pre-buffered part content. Its main benefit is a uniform streaming API that can be piped to `fs.createWriteStream`, `pipeline`, etc.
- Throws `{ status: 400 }` when the `boundary` parameter is missing from the `Content-Type` header.
- Throws `{ status: 413 }` when the body exceeds `limit`.
- Malformed parts (missing `\r\n\r\n` header separator) are silently skipped.

## When to use `streamFormData` vs `formData()`

| Scenario | Recommended |
|---|---|
| Simple field/file collection with known, bounded sizes | `formData()` middleware |
| Async handler that needs to process parts lazily or pipe to streams | `streamFormData()` |
| File uploads expected to exceed memory constraints | Raw `req` streaming (bypasses both) |
