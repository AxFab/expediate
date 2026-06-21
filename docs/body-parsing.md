# Body Parsing

Expediate ships seven body-parsing utilities: middleware factories for the most common content types, an auto-detecting catch-all, and a streaming multipart generator.

All body-parsing middleware must be registered **before** route handlers that read `req.body`.

---

## Content-type pass-through behaviour

Typed parsers (`json()`, `formData()`, `formEncoded()`) follow Express behaviour: when the request carries a `Content-Type` that does not match what the parser handles, the parser calls `next()` and lets subsequent middleware handle the request. This makes it safe to stack parsers globally:

```ts
app.use(json());       // handles application/json
app.use(formEncoded()); // handles application/x-www-form-urlencoded
// A request with Content-Type: multipart/form-data passes both and falls through
```

`parseBody()` is the strict catch-all — it handles all supported types and returns `415 Unsupported Media Type` for anything else.

---

## `json()`

Parses `application/json` bodies and populates `req.body`.

```ts
import { json } from 'expediate';

app.use(json());

app.post('/data', (req, res) => {
  res.json({ received: (req as any).body });
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Max body size. Accepts `'10kb'`, `'2mb'`, `'1gb'`, or bytes |
| `inflate` | `boolean` | `true` | Accept gzip/deflate encoded bodies |
| `reviver` | `Reviver \| null` | `null` | Second argument to `JSON.parse` |
| `strict` | `boolean` | `true` | When `true`, rejects a top-level JSON primitive (bare string, number, boolean, or `null`) with `400 Bad Request`; only objects and arrays are accepted |

**Error responses:**

| Status | Cause |
|---|---|
| `400 Bad Request` | Malformed JSON or parse error |
| `413 Content Too Large` | Body exceeds `limit` |
| `415 Unsupported Media Type` | Unknown `Content-Encoding` (e.g. `br`) |

---

## `formData()`

Parses `multipart/form-data` bodies. Populates `req.body` with an array of `FormPart` objects:

```ts
interface FormPart {
  headers: Record<string, string>;  // part headers, keys lowercased
  content: Buffer;                  // raw part body
}
```

```ts
import { formData } from 'expediate';

app.post('/upload', formData(), (req, res) => {
  const parts = (req as any).body as FormPart[];
  for (const part of parts) {
    const disp = part.headers['content-disposition'];
    console.log(disp, '-', part.content.length, 'bytes');
  }
  res.status(201).end();
});
```

Accepts the same `limit` and `inflate` options as `json()`.

---

## `formEncoded()`

Parses `application/x-www-form-urlencoded` bodies. Repeated keys produce arrays:

```ts
import { formEncoded } from 'expediate';

app.post('/form', formEncoded(), (req, res) => {
  const { username, tags } = (req as any).body;
  // tags: string | string[] (array when key is repeated)
  res.json({ username, tags });
});
```

---

## `raw()`

Reads the request body as a `Buffer` without parsing it, and populates `req.body`.

```ts
import { raw } from 'expediate';

app.post('/upload', raw(), (req, res) => {
  const buf = (req as any).body as Buffer;
  res.json({ bytes: buf.length });
});
```

Defaults to `application/octet-stream`; override with `opts.type` (e.g. `raw({ type: 'image/*' })`). Accepts the same `limit`, `inflate`, `type`, and `verify` options as the other parsers. Requests without a body, or whose `Content-Type` doesn't match, pass through to `next()` unchanged.

---

## `text()`

Decodes the request body as a string (using the charset from `Content-Type`) and populates `req.body`.

```ts
import { text } from 'expediate';

app.post('/note', text(), (req, res) => {
  const body = (req as any).body as string;
  res.send(`received ${body.length} chars`);
});
```

Defaults to `text/plain`; override with `opts.type` (e.g. `text({ type: 'text/*' })`). Requests without a body, or whose `Content-Type` doesn't match, pass through to `next()` unchanged. Bodies over `limit` get `413 Content Too Large`; decoding errors get `500 Internal Server Error`.

---

## `parseBody()`

Auto-detects the `Content-Type` and dispatches to the appropriate parser.

| Content-Type | Result in `req.body` |
|---|---|
| `application/json` | Parsed JS value |
| `multipart/form-data` | `FormPart[]` |
| `application/x-www-form-urlencoded` | `Record<string, string \| string[]>` |
| `text/plain` | Decoded string |
| Anything else | `415 Unsupported Media Type` |

```ts
import { parseBody } from 'expediate';

app.use(parseBody());  // handles all four types; 415 for anything else
```

---

## `streamFormData()`

An async generator that yields each `multipart/form-data` part as a stream, without buffering the entire body first. Ideal for large file uploads.

```ts
import { streamFormData } from 'expediate';
import type { FormPartStream } from 'expediate';

app.post('/upload', async (req, res) => {
  for await (const part of streamFormData(req)) {
    const disp = part.headers['content-disposition'];
    // part.stream is a Readable
    const chunks: Buffer[] = [];
    for await (const chunk of part.stream) chunks.push(chunk);
    const content = Buffer.concat(chunks);
    console.log(disp, content.length, 'bytes');
  }
  res.send('ok');
});
```

`FormPartStream` shape:
```ts
interface FormPartStream {
  headers: Record<string, string>;
  stream:  Readable;
}
```

---

## `req.json()`, `req.text()`, `req.formData()`

These are lower-level request methods attached directly to the request object by the router (no middleware needed). They return a `Promise` and resolve to `null` when the request has no body.

```ts
app.post('/data', async (req, res) => {
  const body = await req.json();         // parse as JSON
  const text = await req.text();         // read as string
  const parts = await req.formData();    // parse as multipart
  res.json({ ok: true });
});
```

When a body-parser middleware has already consumed the stream, these methods return the cached `req.body` value.

### Options (`BodyOptions`)

```ts
interface BodyOptions {
  limit?:   string | number;        // default: '100kb'
  inflate?: boolean;                // default: true — accept gzip/deflate/br
  reviver?: Reviver | null;         // default: null — JSON.parse reviver
  strict?:  boolean;                // default: true — json() only: reject bare top-level primitives
  type?:    BodyTypeMatcher;        // override the content-type this parser matches
  verify?:  VerifyFn;               // (req, res, buf, encoding) => void; throw to reject
}
```

---

## Compression support

Request body decompression is controlled by the `inflate` option (default `true`). Supported `Content-Encoding` values:

- `gzip`
- `deflate`
- `identity` (no-op)

- `br` (Brotli)

Unknown `Content-Encoding` values produce `415 Unsupported Media Type`.
