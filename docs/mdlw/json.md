# `json()` — JSON body parser

Parses incoming request bodies with `Content-Type: application/json` and exposes the result as `req.body`.

## Usage

```ts
import { createRouter, json } from 'expediate';

const app = createRouter();

// Apply globally
app.use(json());

// Or per route
app.post('/data', json(), (req, res) => {
  console.log(req.body); // parsed object
  res.json({ received: true });
});
```

## Options

All options are optional and come from the shared `BodyOptions` interface.

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Maximum accepted body size. Strings accept `'100kb'`, `'2mb'`, `'1gb'` (case-insensitive). |
| `inflate` | `boolean` | `true` | Accept `gzip` / `deflate` compressed bodies. When `false`, compressed bodies are rejected with **415**. |
| `reviver` | `Reviver \| null` | `null` | Optional `JSON.parse` reviver function for custom value transformation. |
| `strict` | `boolean` | `true` | Reserved — will restrict top-level JSON to objects/arrays only. Not yet enforced. |

## Behaviour

- Only processes requests whose `Content-Type` header contains `application/json`. Other content types pass through to `next()` without modification.
- Body size is checked **after** decompression. A 100 KB gzip body that decompresses to 2 MB will be rejected if the `limit` is `'100kb'`.
- On a parse error, the middleware rejects with `{ status: 400, message: '...' }` — if an `onError` handler is registered it will be called; otherwise a **400** response is sent automatically.
- On a size-limit violation, the response is **413 Content Too Large**.
- On an unsupported `Content-Encoding`, the response is **415 Unsupported Media Type**.

## Important notes

- `json()` must be registered **before** any route handler that reads `req.body`.
- It does **not** set a `Content-Type` response header — use `res.json()` for that.
- Alternatively, `req.json(opts?)` is available on every request as a promise-based body reader that does not require middleware to be pre-registered.

## Internal overview

Internally `json()` delegates to `readReqBody(req, opts, 'application/json')`, which:

1. Checks `Content-Type` — skips to `next()` if it doesn't match.
2. Collects raw chunks from the request stream while enforcing the size limit.
3. If `Content-Encoding` is `gzip` or `deflate`, decompresses with `zlib`.
4. Calls `JSON.parse(body, reviver)` and assigns the result to `(req as any).body`.
