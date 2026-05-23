# `formData()` — Multipart form-data parser

Parses incoming `multipart/form-data` request bodies (file uploads, multi-field forms) and exposes the result as `req.body`.

## Usage

```ts
import { createRouter, formData } from 'expediate';

const app = createRouter();

app.post('/upload', formData(), (req, res) => {
  const parts = req.body as FormPart[];
  for (const part of parts) {
    const disposition = part.headers['content-disposition'];
    // part.content is a Buffer with the raw file / field bytes
    console.log(disposition, part.content.length, 'bytes');
  }
  res.json({ count: parts.length });
});
```

## Options

Accepts `BodyOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Maximum accepted body size before decompression. |
| `inflate` | `boolean` | `true` | Accept `gzip` / `deflate` compressed request bodies. |

(`reviver` and `strict` have no effect on multipart bodies.)

## Result shape — `FormPart[]`

`req.body` is set to an array of `FormPart` objects:

```ts
interface FormPart {
  /** Lowercased, trimmed part headers (e.g. 'content-disposition', 'content-type'). */
  headers: Record<string, string>;
  /** Raw binary content of the part as a Buffer. */
  content: Buffer;
}
```

Each element corresponds to one part separated by the multipart boundary.

## Important notes

- Only processes requests whose `Content-Type` starts with `multipart/form-data`. Other types pass through.
- The boundary parameter must be present in the `Content-Type` header; a missing boundary produces **400**.
- All parts are buffered in memory. For large file uploads consider [`streamFormData()`](./stream-form-data.md) instead.
- Field names and file names are embedded in each part's `content-disposition` header — parse them manually:
  ```ts
  const cd = part.headers['content-disposition'] ?? '';
  const name = /name="([^"]+)"/.exec(cd)?.[1];
  const filename = /filename="([^"]+)"/.exec(cd)?.[1];
  ```

## Internal overview

1. `readReqBody` collects the full body into a `Buffer` enforcing the size limit.
2. `parseMultipartBody` splits the buffer on `\r\n--<boundary>` delimiters.
3. Each segment is split at the first `\r\n\r\n` to separate headers from content.
4. Parts with malformed headers are silently skipped.
