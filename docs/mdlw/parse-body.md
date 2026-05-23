# `parseBody()` — Auto-detecting body parser

Inspects `Content-Type` and automatically routes the request body to the appropriate parser. A convenient single-middleware alternative to registering `json()`, `formData()`, and `formEncoded()` separately.

## Usage

```ts
import { createRouter, parseBody } from 'expediate';

const app = createRouter();

// One middleware handles JSON, multipart, URL-encoded, and plain text
app.use(parseBody());

app.post('/anything', (req, res) => {
  console.log(req.body); // object, FormPart[], or string depending on Content-Type
  res.json({ ok: true });
});
```

## Options

Accepts `BodyOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Maximum accepted body size. |
| `inflate` | `boolean` | `true` | Accept `gzip` / `deflate` compressed bodies. |
| `reviver` | `Reviver \| null` | `null` | JSON.parse reviver (JSON bodies only). |

## Supported content types

| `Content-Type` | `req.body` type | Notes |
|---|---|---|
| `application/json` | `unknown` (parsed JS value) | Delegates to `json()` logic. |
| `multipart/form-data` | `FormPart[]` | Delegates to `formData()` logic. |
| `application/x-www-form-urlencoded` | `Record<string, string>` | Delegates to `formEncoded()` logic. |
| `text/plain` | `string` | Body decoded as UTF-8 (or charset from header). |
| anything else | _(not set)_ | Passes through to `next()` unmodified. |

## Important notes

- When you need fine-grained control over per-route body parsing, use the individual middleware (`json()`, `formData()`, etc.) instead.
- `parseBody()` calls `next()` for unrecognised content types rather than returning an error.
- Error codes (400, 413, 415) follow the same rules as the individual parsers.
