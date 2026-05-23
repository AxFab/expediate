# `formEncoded()` — URL-encoded form body parser

Parses incoming request bodies with `Content-Type: application/x-www-form-urlencoded` and exposes the result as `req.body`.

## Usage

```ts
import { createRouter, formEncoded } from 'expediate';

const app = createRouter();

app.post('/submit', formEncoded(), (req, res) => {
  const body = req.body as Record<string, string>;
  console.log(body.username, body.password);
  res.json({ ok: true });
});
```

## Options

Accepts `BodyOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `string \| number` | `'100kb'` | Maximum accepted body size. |
| `inflate` | `boolean` | `true` | Accept compressed request bodies. |

## Result shape

`req.body` is set to a plain `Record<string, string>` built from `URLSearchParams` parsing. Repeated keys produce the last seen value.

## Important notes

- Only processes requests whose `Content-Type` is `application/x-www-form-urlencoded`. Others pass through to `next()`.
- Values are automatically percent-decoded by the underlying `URLSearchParams` parser.
- Does **not** handle nested keys (e.g. `user[name]=alice`) — values are flat strings only.
- For HTML forms that also upload files use [`formData()`](./form-data.md) instead.
