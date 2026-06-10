/* Copyright 2021 Fabien Bavent
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
'use strict';

import { Readable } from 'stream';
import zlib from 'zlib';
import type { RouterRequest, RouterResponse, Middleware } from './router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A JSON reviver function, matching the second parameter of `JSON.parse`.
 * Receives each key/value pair during parsing and may return a transformed
 * value.
 */
type Reviver = (key: string, value: unknown) => unknown;

/**
 * Options shared by all body-parsing middleware factories
 * ({@link json}, {@link formData}, {@link parseBody}).
 */
export interface BodyOptions {
  /**
   * When `true` (default), compressed request bodies (`gzip`, `deflate`) are
   * automatically decompressed before parsing.  Set to `false` to reject
   * compressed bodies with 415 Unsupported Media Type.
   */
  inflate?: boolean;
  /**
   * Maximum accepted body size.  Accepts a number (bytes) or a human-readable
   * string such as `'100kb'`, `'2mb'`, or `'1gb'`.
   * Defaults to `'100kb'` (102 400 bytes).
   */
  limit?: string | number;
  /**
   * Optional JSON reviver passed as the second argument to `JSON.parse`.
   * Only meaningful for {@link json} and {@link parseBody} when the body is
   * `application/json`.
   */
  reviver?: Reviver | null;
  /**
   * When `true` (default), JSON parsing is restricted to objects and arrays.
   * Bare primitives (strings, numbers, booleans) at the top level are
   * rejected.  Has no effect on non-JSON bodies.
   *
   * @remarks Currently reserved for future enforcement; not yet applied.
   */
  strict?: boolean;
}

/** Resolved body options with all fields guaranteed to be present. */
type ResolvedBodyOptions = Required<BodyOptions>;

/**
 * Options for the {@link logger} middleware factory.
 */
export interface LoggerOptions {
  /**
   * When `true`, starts a timer per request.  If the response is not finished
   * within {@link trackTimeout} milliseconds, a `LOST` warning line is logged.
   * Recommended for development only — keeping a `setTimeout` per request has
   * a non-trivial memory cost in production.
   * Defaults to `false`.
   */
  track: boolean;
  /**
   * Timeout in milliseconds before a tracked request is considered lost.
   * Only used when {@link track} is `true`.
   * Defaults to `30 000` ms (30 seconds).
   */
  trackTimeout: number;
  /**
   * Extract a user identity string from the request for inclusion in the log
   * line.  Receives the augmented `RouterRequest` and should return a short
   * string (e.g. a username, session ID, or `'-'` for anonymous).
   * Defaults to always returning `'-'`.
   *
   * @example
   * ```ts
   * user: (req) => (req as any).authUser ?? '-'
   * ```
   */
  user: (req: RouterRequest) => string;
  /**
   * BCP 47 locale tag used when formatting the request timestamp.
   * Passed as the first argument to `Intl.DateTimeFormat`.
   * Defaults to `'en-GB'`.
   */
  locale: string;
  /**
   * Date/time format options passed as the second argument to
   * `Intl.DateTimeFormat`.  Override this to change which fields are shown in
   * the timestamp.
   * Defaults to `{ month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }`.
   */
  dateFormat: Intl.DateTimeFormatOptions;
  /**
   *
   */
  json: boolean,
  /**
   * Custom logging function.  Receives the fully-formatted log line as a
   * single string.  Defaults to `console.log`.
   */
  logger: (msg: string|object) => void;
}

/**
 * A single part extracted from a `multipart/form-data` body.
 */
export interface FormPart {
  /**
   * Raw part headers (e.g. `Content-Disposition`, `Content-Type`).
   * Keys are lowercased; values are trimmed.
   */
  headers: Record<string, string>;
  /**
   * Raw binary content of the part (everything after the blank header line).
   */
  content: Buffer;
}

// ---------------------------------------------------------------------------
// Decompression algorithm registry
// ---------------------------------------------------------------------------

/**
 * Maps a supported `Content-Encoding` value to its corresponding `zlib`
 * decompression function.  Only `gzip` and `deflate` are supported.
 */
const DECOMPRESS_ALGO: Record<string, (buf: Buffer, cb: zlib.CompressCallback) => void> = {
  gzip:    zlib.gunzip,
  deflate: zlib.inflate,
};

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable byte-size string into a number of bytes.
 *
 * Supported suffixes (case-insensitive): `b`, `kb`, `mb`, `gb`.
 * The suffix is optional; a bare number is treated as bytes.
 *
 * @param value - The size string to parse (e.g. `'100kb'`, `'2.5mb'`).
 * @returns The size in bytes, or `0` if the input cannot be parsed.
 *
 * @example
 * ```ts
 * readSize('100kb')  // 102400
 * readSize('2mb')    // 2097152
 * readSize('1024')   // 1024
 * readSize('bad')    // 0
 * ```
 */
function readSize(value: string | number): number {
  if (typeof value === 'number') return value;
  const fmt = /^(\d+(\.\d+)?)([kmg]?b?)?$/i.exec(value);
  if (!fmt) return 0;
  const num = parseFloat(fmt[1] ?? '0');
  const sfx = (fmt[3] ?? 'b').toLowerCase();
  if (sfx[0] === 'k') return num * 1024;
  if (sfx[0] === 'm') return num * 1024 * 1024;
  if (sfx[0] === 'g') return num * 1024 * 1024 * 1024;
  return num;
}

/**
 * Split a `Buffer` on every occurrence of a `delimiter` buffer, returning an
 * array of sub-buffers between delimiters (the delimiters themselves are not
 * included in the output).
 *
 * Behaves like `String.prototype.split` but operates on raw binary data,
 * making it safe for multipart bodies that may contain arbitrary byte
 * sequences.
 *
 * @param buffer    - The source buffer to split.
 * @param delimiter - The byte sequence to split on.
 * @returns An array of buffer slices; always contains at least one element.
 */
function splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  let index: number;

  while ((index = buffer.indexOf(delimiter, start)) !== -1) {
    result.push(buffer.slice(start, index));
    start = index + delimiter.length;
  }

  result.push(buffer.slice(start));
  return result;
}

/**
 * Extract the `charset` parameter from a `Content-Type` header value.
 *
 * Handles optional whitespace around the semicolon-separated parameters.
 * Falls back to `'utf8'` when no `charset` parameter is found.
 *
 * @param contentType - The raw `Content-Type` header value
 *                      (e.g. `'text/plain; charset=iso-8859-1'`).
 * @returns A Node.js-compatible encoding name (e.g. `'utf8'`, `'iso-8859-1'`).
 */
export function extractCharset(contentType: string): string {
  const param = contentType
    .split(';')
    .map((s) => s.replace(/^\s+|\s+$/g, ''))
    .find((s) => s.startsWith('charset='));
  return param ? param.substring('charset='.length) : 'utf8';
}

// ---------------------------------------------------------------------------
// Body collection
// ---------------------------------------------------------------------------

/**
 * Collect the full request body into a single `Buffer`, enforce size limits,
 * optionally decompress, and validate the `Content-Type` against an expected
 * MIME type.
 *
 * When the body is successfully collected and validated, `callback` is invoked
 * with the raw `Content-Type` header value and the (possibly decompressed)
 * body buffer.  In all error cases the appropriate HTTP error response is sent
 * and `callback` is never called.
 *
 * Callers that need to pass control to the next middleware when there is no
 * body should rely on the `next()` call that this function makes when
 * `Content-Length` is `0` or absent and `Transfer-Encoding` is not `chunked`.
 *
 * @param req       - The incoming request.
 * @param res       - The outgoing response.
 * @param opts      - Resolved body-parsing options.
 * @param mimetype  - Expected MIME type (e.g. `'application/json'`), or `null`
 *                    to accept any content type.
 * @param next      - The next middleware callback; called when the body is
 *                    empty or absent.
 * @param callback  - Invoked with `(contentType, body)` on success.
 */
function readBody(
  req:      RouterRequest,
  res:      RouterResponse,
  opts:     ResolvedBodyOptions,
  mimetype: string | null,
  next:     () => void,
  callback: (contentType: string, body: Buffer) => void,
): void {

  const length = parseInt((req.headers['content-length'] as string) ?? '0', 10);

  // Detect chunked transfer encoding — no Content-Length is present in this case.
  const isChunked = (req.headers['transfer-encoding'] as string | undefined)
    ?.split(',').map((v) => v.trim()).some((v) => v.toLowerCase() === 'chunked') ?? false;

  // No body declared and not chunked — skip to next middleware.
  if (!isChunked && (!length || length === 0)) return next();

  const maxLength = readSize(opts.limit) || 102_400;

  // For requests with a known Content-Length we can reject upfront.
  if (!isChunked && length > maxLength)
    return void res.status(413).send('Content Too Large');

  // Compression handling.
  const encoding = req.headers['content-encoding'] as string | undefined;
  if (encoding && (opts.inflate === false || !DECOMPRESS_ALGO[encoding]))
    return void res.status(415).send('Unsupported Media Type: Wrong Content-Encoding');

  // eslint-disable-next-line @typescript-eslint/ban-types
  const decompress =
    (encoding ? DECOMPRESS_ALGO[encoding] : undefined) ?? ((d: Buffer, c: zlib.CompressCallback) => c(null, d as any));

  // Content-Type validation.
  // When a specific mimetype is expected and the request carries a different one,
  // pass through to the next middleware (Express-compatible composable behaviour).
  // Returning 415 here would break parser stacking: json() + formEncoded() + …
  const contentType = (req.headers['content-type'] as string) ?? '';
  if (mimetype && contentType.split(';')[0].trim() !== mimetype)
    return next();

  // Stream collection.
  let data: Buffer | null = Buffer.alloc(0);

  req.on('data', (chunk: Buffer) => {
    if (data === null) return; // already aborted

    const next_ = Buffer.concat([data, chunk]);
    if (next_.length > maxLength) {
      data = null;
      res.status(413).send('Content Too Large');
      return;
    }
    data = next_;
  });

  req.on('end', () => {
    if (data === null) return; // aborted during streaming

    // zlib types require NonSharedBuffer; Buffer satisfies this at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    decompress(data as any, (err, decompressed) => {
      if (err) return void res.status(500).send(err.message);
      callback(contentType, decompressed as Buffer);
    });
  });
}


export type BodyContent = {
  mimetype : string,
  content: Buffer,
}
// TODO
export function readReqBody(req: RouterRequest, opts :ResolvedBodyOptions, mimetype: string | null,):Promise<BodyContent|null> {

  return new Promise((resolve, reject) => {

    const length = parseInt((req.headers['content-length'] as string) ?? '0', 10);

    // Detect chunked transfer encoding — no Content-Length is present in this case.
    const isChunked = (req.headers['transfer-encoding'] as string | undefined)
      ?.split(',').map((v) => v.trim()).some((v) => v.toLowerCase() === 'chunked') ?? false;

    // No body declared and not chunked — resolve with null.
    if (!isChunked && (!length || length === 0)) return resolve(null);

    const maxLength = readSize(opts.limit) || 102_400;

    // For requests with a known Content-Length we can reject upfront.
    if (!isChunked && length > maxLength)
      return reject({ status: 413, message: 'Content Too Large' });

    // Compression handling.
    const encoding = req.headers['content-encoding'] as string | undefined;
    if (encoding && (opts.inflate === false || !DECOMPRESS_ALGO[encoding]))
      return reject({ status: 415, message: 'Unsupported Media Type: Wrong Content-Encoding' });

    // eslint-disable-next-line @typescript-eslint/ban-types
    const decompress =
      (encoding ? DECOMPRESS_ALGO[encoding] : undefined) ?? ((d: Buffer, c: zlib.CompressCallback) => c(null, d as any));

    // Content-Type validation.
    const contentType = (req.headers['content-type'] as string) ?? '';
    if (mimetype && contentType.split(';')[0].trim() !== mimetype)
      return reject({ status: 415, message: 'Unsupported Media Type: Wrong Content-Type' });

    // Stream collection.
    let data: Buffer | null = Buffer.alloc(0);

    req.on('data', (chunk: Buffer) => {
      if (data === null) return; // already aborted

      const next_ = Buffer.concat([data, chunk]);
      if (next_.length > maxLength) {
        data = null;
        reject({ status: 413, message: 'Content Too Large' });
        return;
      }
      data = next_;
    });

    req.on('end', () => {
      if (data === null) return; // aborted during streaming

      // zlib types require NonSharedBuffer; Buffer satisfies this at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decompress(data as any, (err, decompressed) => {
        if (err) return reject({ status: 500, message: err.message });
        resolve({ mimetype: contentType ?? '', content: decompressed as Buffer });
      });
    });

  })
}

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

/**
 * Parse a collected body buffer as plain text, decode it using the charset
 * declared in `contentType`, and assign the result to `req.body`.
 *
 * On success, calls `next()`.  On failure, sends a 500 Internal Server Error.
 *
 * @param req         - The incoming request (mutated: `req.body` is set).
 * @param res         - The outgoing response.
 * @param next        - Called on successful parsing.
 * @param contentType - The raw `Content-Type` header value.
 * @param data        - The raw body buffer.
 */
function readBodyAsPlainText(
  req:         RouterRequest,
  res:         RouterResponse,
  next:        () => void,
  contentType: string,
  data:        Buffer,
): void {
  const charset = extractCharset(contentType);
  try {
    (req as any).body = data.toString(charset as BufferEncoding);
    next();
  } catch (ex) {
    res.status(500).send((ex as Error).message);
  }
}

/**
 * Parse a collected body buffer as JSON, decode it using the charset declared
 * in `contentType`, apply an optional `reviver`, and assign the result to
 * `req.body`.
 *
 * On success, calls `next()`.  On failure (invalid JSON or unsupported charset),
 * sends a 500 Internal Server Error.
 *
 * @param req         - The incoming request (mutated: `req.body` is set).
 * @param res         - The outgoing response.
 * @param next        - Called on successful parsing.
 * @param opts        - Resolved options; `opts.reviver` is passed to `JSON.parse`.
 * @param contentType - The raw `Content-Type` header value.
 * @param data        - The raw body buffer.
 */
function readBodyAsJson(
  req:         RouterRequest,
  res:         RouterResponse,
  next:        () => void,
  opts:        ResolvedBodyOptions,
  contentType: string,
  data:        Buffer,
): void {
  const charset = extractCharset(contentType);
  try {
    const parsed = JSON.parse(
      data.toString(charset as BufferEncoding),
      opts.reviver ?? undefined,
    );
    // FIX-10: strict mode — reject bare primitives (strings, numbers, booleans)
    // at the top level; only objects and arrays are accepted.
    if (opts.strict && (typeof parsed !== 'object' || parsed === null)) {
      return void res.status(400).send('Bad Request: JSON body must be an object or array');
    }
    (req as any).body = parsed;
    next();
  } catch (ex) {
    // Invalid JSON is a client error (400), not a server error.
    res.status(400).send('Bad Request: ' + (ex as Error).message);
  }
}

/**
 * Parse a raw `multipart/form-data` body buffer into an array of
 * {@link FormPart} objects.
 *
 * This is the shared parsing kernel used by both the {@link formData}
 * middleware and the `req.formData()` extension method on the request object.
 *
 * **Multipart wire format recap:**
 * ```
 * --boundary\r\n
 * Header: value\r\n
 * \r\n
 * <binary content>
 * --boundary\r\n
 * ...
 * --boundary--\r\n
 * ```
 * The boundary string in `Content-Type` does **not** include the leading `--`;
 * actual part delimiters on the wire are `\r\n--boundary`.
 *
 * @param contentType - The raw `Content-Type` header value (must include
 *                      `boundary=<value>`).
 * @param data        - The fully-collected raw body buffer.
 * @returns An array of parsed {@link FormPart} objects.
 * @throws `{ status: 400, message }` when the `boundary` parameter is absent.
 */
export function parseMultipartBody(contentType: string, data: Buffer): FormPart[] {
  const boundary = contentType
    .split(';')
    .map((s) => s.replace(/^\s+|\s+$/g, ''))
    .find((s) => s.startsWith('boundary='))
    ?.substring('boundary='.length);

  if (!boundary)
    throw { status: 400, message: 'Bad Request: missing multipart boundary' };

  // Wire-level delimiter: each part (after the preamble) is preceded by
  // \r\n--boundary.  We split on this sequence so every resulting slice is
  // the raw content of one part (headers + blank line + body), without any
  // leading delimiter bytes.
  const delimiter = Buffer.from(`\r\n--${boundary}`);

  // Prepend \r\n so the very first part is also cleanly split.
  const normalized = Buffer.concat([Buffer.from('\r\n'), data]);
  const rawParts   = splitBuffer(normalized, delimiter);

  const parts: FormPart[] = [];

  for (const part of rawParts) {
    // The closing delimiter ends with '--'; skip it.
    if (part.toString('utf8', 0, 2) === '--') continue;

    // Each part begins with \r\n (from after the delimiter), then headers,
    // then \r\n\r\n (blank line), then content.
    // Skip the leading \r\n.
    const partContent = part.slice(2);
    const blankLine   = Buffer.from('\r\n\r\n');
    const blankIdx    = partContent.indexOf(blankLine);

    if (blankIdx === -1) continue; // malformed part — skip

    const headerSection = partContent.slice(0, blankIdx).toString('utf8');
    const content       = partContent.slice(blankIdx + blankLine.length);
    const headers: Record<string, string> = {};

    for (const line of headerSection.split('\r\n')) {
      if (!line) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key   = line.substring(0, colonIdx).replace(/^\s+|\s+$/g, '').toLowerCase();
      const value = line.substring(colonIdx + 1).replace(/^\s+|\s+$/g, '');
      headers[key] = value;
    }

    parts.push({ headers, content });
  }

  return parts;
}

/**
 * Parse a collected body buffer as `multipart/form-data`, split it on the
 * boundary declared in `contentType`, parse each part's headers, and assign
 * an array of {@link FormPart} objects to `req.body`.
 *
 * On success, calls `next()`.  On failure (missing boundary, malformed parts),
 * sends the appropriate HTTP error.
 *
 * @param req         - The incoming request (mutated: `req.body` is set).
 * @param res         - The outgoing response.
 * @param next        - Called on successful parsing.
 * @param contentType - The raw `Content-Type` header value (must include
 *                      `boundary=<value>`).
 * @param data        - The raw body buffer.
 */
function readBodyAsFormData(
  req:         RouterRequest,
  res:         RouterResponse,
  next:        () => void,
  contentType: string,
  data:        Buffer,
): void {
  try {
    (req as any).body = parseMultipartBody(contentType, data);
    next();
  } catch (ex: any) {
    const status = (ex as any).status ?? 500;
    res.status(status).send((ex as any).message ?? String(ex));
  }
}

/**
 * Parse a collected body buffer as `application/x-www-form-urlencoded` and
 * assign the result to `req.body`.
 *
 * Repeated keys (e.g. `tags=a&tags=b`) produce an array value:
 * `{ tags: ['a', 'b'] }`.  Single-occurrence keys produce a plain string.
 *
 * @param req         - The incoming request (mutated: `req.body` is set).
 * @param res         - The outgoing response.
 * @param next        - Called on successful parsing.
 * @param contentType - The raw `Content-Type` header value.
 * @param data        - The raw body buffer.
 */
function readBodyAsFormEncoded(
  req:         RouterRequest,
  res:         RouterResponse,
  next:        () => void,
  contentType: string,
  data:        Buffer,
): void {
  const charset = extractCharset(contentType);
  try {
    const params = new URLSearchParams(data.toString(charset as BufferEncoding));
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of params.entries()) {
      const existing = result[key];
      if (existing === undefined) {
        result[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    }
    (req as any).body = result;
    next();
  } catch (ex) {
    res.status(400).send('Bad Request: ' + (ex as Error).message);
  }
}

/**
 * Dispatch table mapping a MIME type to its body-parser function.
 * Used by {@link parseBody} to select the appropriate parser at runtime.
 */
const BODY_READERS: Record<
  string,
  (req: RouterRequest, res: RouterResponse, next: () => void, opts: ResolvedBodyOptions, contentType: string, data: Buffer) => void
> = {
  'multipart/form-data':               (req, res, next, _opts, ct, data) =>
    readBodyAsFormData(req, res, next, ct, data),
  'application/json':                  (req, res, next,  opts, ct, data) =>
    readBodyAsJson(req, res, next, opts, ct, data),
  'application/x-www-form-urlencoded': (req, res, next, _opts, ct, data) =>
    readBodyAsFormEncoded(req, res, next, ct, data),
  'text/plain':                        (req, res, next, _opts, ct, data) =>
    readBodyAsPlainText(req, res, next, ct, data),
};

// ---------------------------------------------------------------------------
// Public middleware factories
// ---------------------------------------------------------------------------

/**
 * Middleware factory that parses an `application/json` request body and
 * assigns the parsed value to `req.body`.
 *
 * Behaviour:
 * - Requests without a body (`Content-Length: 0` or absent) are passed
 *   through to `next()` without touching `req.body`.
 * - Requests whose `Content-Type` is not `application/json` are also passed
 *   through to `next()` unchanged, allowing other parsers to handle them
 *   (Express-compatible composable behaviour).
 * - Bodies larger than `opts.limit` receive **413 Content Too Large**.
 * - Bodies with an unsupported `Content-Encoding` receive
 *   **415 Unsupported Media Type**.
 * - Parse errors receive **500 Internal Server Error**.
 *
 * @param opts - Optional configuration (see {@link BodyOptions}).
 * @returns An Express-compatible middleware function.
 */
export function json(opts?: BodyOptions): Middleware {
  const resolved: ResolvedBodyOptions = {
    inflate:  true,
    limit:    '100kb',
    reviver:  null,
    strict:   true,
    ...opts,
  };

  return (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    readBody(req, res, resolved, 'application/json', next, (contentType, body) => {
      readBodyAsJson(req, res, next, resolved, contentType, body);
    });
  };
}

/**
 * Middleware factory that parses a `multipart/form-data` request body and
 * assigns an array of {@link FormPart} objects to `req.body`.
 *
 * Each element in `req.body` exposes:
 * - `headers` — the part's MIME headers (e.g. `Content-Disposition`).
 * - `content` — the raw binary content of the part as a `Buffer`.
 *
 * Behaviour:
 * - Requests without a body are passed through to `next()`.
 * - Bodies larger than `opts.limit` receive **413 Content Too Large**.
 * - Bodies with a missing or malformed `boundary` parameter receive
 *   **400 Bad Request**.
 * - Parse errors receive **500 Internal Server Error**.
 *
 * @param opts - Optional configuration (see {@link BodyOptions}).
 * @returns An Express-compatible middleware function.
 */
export function formData(opts?: BodyOptions): Middleware {
  const resolved: ResolvedBodyOptions = {
    inflate:  true,
    limit:    '100kb',
    reviver:  null,
    strict:   true,
    ...opts,
  };

  return (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    readBody(req, res, resolved, 'multipart/form-data', next, (contentType, body) => {
      readBodyAsFormData(req, res, next, contentType, body);
    });
  };
}

/**
 * Middleware factory that parses an `application/x-www-form-urlencoded`
 * request body and assigns the decoded fields to `req.body`.
 *
 * Repeated keys (e.g. `tags=a&tags=b`) produce an array value:
 * `{ tags: ['a', 'b'] }`.  Single-occurrence keys produce a plain string.
 *
 * Behaviour:
 * - Requests without a body are passed through to `next()`.
 * - Bodies larger than `opts.limit` receive **413 Content Too Large**.
 * - Requests whose `Content-Type` is not `application/x-www-form-urlencoded`
 *   are passed through to `next()` unchanged (Express-compatible composable behaviour).
 * - Parse errors receive **400 Bad Request**.
 *
 * @param opts - Optional configuration (see {@link BodyOptions}).
 * @returns An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * app.post('/form', formEncoded(), (req, res) => {
 *   const { username, tags } = req.body as any;
 *   res.json({ username, tags }); // tags may be string | string[]
 * });
 * ```
 */
export function formEncoded(opts?: BodyOptions): Middleware {
  const resolved: ResolvedBodyOptions = {
    inflate:  true,
    limit:    '100kb',
    reviver:  null,
    strict:   true,
    ...opts,
  };

  return (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    readBody(req, res, resolved, 'application/x-www-form-urlencoded', next, (contentType, body) => {
      readBodyAsFormEncoded(req, res, next, contentType, body);
    });
  };
}

/**
 * Middleware factory that auto-detects the `Content-Type` of the request body
 * and parses it using the appropriate parser.
 *
 * Supported MIME types:
 * - `application/json`                  → parsed as JSON; result is a JS value.
 * - `multipart/form-data`               → parsed as multipart; result is `FormPart[]`.
 * - `application/x-www-form-urlencoded` → decoded as key/value pairs; result is
 *                                         `Record<string, string | string[]>`.
 * - `text/plain`                        → decoded as text; result is a string.
 *
 * Requests with an unsupported MIME type receive **415 Unsupported Media Type**.
 * All other error conditions behave identically to {@link json}, {@link formData},
 * and {@link formEncoded}.
 *
 * @param opts - Optional configuration (see {@link BodyOptions}).
 * @returns An Express-compatible middleware function.
 */
export function parseBody(opts?: BodyOptions): Middleware {
  const resolved: ResolvedBodyOptions = {
    inflate:  true,
    limit:    '100kb',
    reviver:  null,
    strict:   true,
    ...opts,
  };

  return (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    readBody(req, res, resolved, null, next, (contentType, body) => {
      const mimetype = contentType.split(';')[0].trim();
      if (!BODY_READERS[mimetype])
        return res.status(415).send('Unsupported Media Type');
      BODY_READERS[mimetype](req, res, next, resolved, contentType, body);
    });
  };
}

// ---------------------------------------------------------------------------
// Streaming multipart (FEAT-11)
// ---------------------------------------------------------------------------

/**
 * A single part from a `multipart/form-data` body, with its content exposed
 * as a Node.js `Readable` stream instead of a pre-collected `Buffer`.
 *
 * Yielded by {@link streamFormData}.
 */
export type FormPartStream = {
  /**
   * Raw part headers (e.g. `Content-Disposition`, `Content-Type`).
   * Keys are lowercased; values are trimmed.
   */
  headers: Record<string, string>;
  /**
   * Readable stream of the part's binary content.  The stream yields the full
   * part content as a single chunk and then ends.
   */
  stream: Readable;
};

/**
 * Async generator that yields each part of a `multipart/form-data` request
 * body as a {@link FormPartStream} object.
 *
 * Unlike {@link formData} (which must be installed as middleware before a
 * handler), `streamFormData` can be called directly inside any handler and
 * returns an async iterable of parts:
 *
 * ```ts
 * app.post('/upload', async (req, res) => {
 *   for await (const part of streamFormData(req)) {
 *     const name = part.headers['content-disposition'];
 *     const chunks: Buffer[] = [];
 *     for await (const chunk of part.stream) chunks.push(chunk);
 *     const content = Buffer.concat(chunks);
 *     // ... process content
 *   }
 *   res.send('ok');
 * });
 * ```
 *
 * **Note:** the full request body is buffered before parts are yielded,
 * because the multipart boundary must span the entire body.  For very large
 * uploads, prefer streaming directly from the raw request.
 *
 * @param req  - The incoming request (must be a `multipart/form-data` request).
 * @param opts - Optional configuration — only `limit` and `inflate` are used.
 * @throws `{ status: 400, message }` when the `boundary` parameter is absent.
 * @throws `{ status: 413, message }` when the body exceeds the size limit.
 */
export async function* streamFormData(
  req:  RouterRequest,
  opts?: BodyOptions,
): AsyncGenerator<FormPartStream> {
  const maxSize = (opts?.limit !== undefined ? readSize(opts.limit) : 0) || 102_400;

  // Collect all chunks from the raw request stream.
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    totalSize += chunk.length;
    if (totalSize > maxSize) throw { status: 413, message: 'Content Too Large' };
    chunks.push(chunk);
  }

  const body        = Buffer.concat(chunks);
  const contentType = (req.headers['content-type'] as string) ?? '';
  const parts       = parseMultipartBody(contentType, body);

  for (const part of parts) {
    // Expose each part's Buffer content as a Readable stream so callers can
    // pipe, pipeline, or iterate it uniformly.
    yield { headers: part.headers, stream: Readable.from(part.content) };
  }
}

// ---------------------------------------------------------------------------
// Logger middleware
// ---------------------------------------------------------------------------

/**
 * ANSI terminal colour codes indexed by HTTP status class (1xx–5xx).
 *
 * Index 0 is unused (no HTTP 0xx class).
 * - 1xx → yellow  (`\x1b[33m`)
 * - 2xx → green   (`\x1b[32m`)
 * - 3xx → yellow  (`\x1b[33m`)
 * - 4xx → red     (`\x1b[31m`)
 * - 5xx → bright red (`\x1b[91m`)
 */
const STATUS_COLORS: string[] = [
  '\x1b[0m',   // 0 — fallback / unknown
  '\x1b[33m',  // 1xx — informational (yellow)
  '\x1b[32m',  // 2xx — success (green)
  '\x1b[33m',  // 3xx — redirection (yellow)
  '\x1b[31m',  // 4xx — client error (red)
  '\x1b[91m',  // 5xx — server error (bright red)
];

/** ANSI reset escape sequence. */
const ANSI_RESET = '\x1b[0m';

/**
 * Middleware factory that logs one line per completed HTTP request to the
 * console (or a custom logger function).
 *
 * Each log line contains:
 * - Timestamp (formatted with `Intl.DateTimeFormat`).
 * - HTTP status code (ANSI-coloured by status class).
 * - HTTP method and request path.
 * - Client IP address (honours `X-Forwarded-For`).
 * - User identity (from `opts.user` or `'-'`).
 * - Elapsed time in milliseconds.
 * - Response `Content-Length` (or `'-'` when absent).
 *
 * **Lost-request tracking:** when `opts.track` is `true`, a timer is started
 * for each request.  If the response is not finished within `opts.trackTimeout`
 * milliseconds, a `LOST` warning line is emitted.  This is useful in
 * development to surface handlers that never call `res.end()`.
 *
 * @param opts - Optional configuration (see {@link LoggerOptions}).
 * @returns An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * app.use('/', logger({
 *   track:        true,
 *   trackTimeout: 30_000,
 *   user:         (req) => (req as any).authUser ?? '-',
 *   locale:       'en-US',
 *   logger:       (msg) => process.stderr.write(msg + '\n'),
 * }));
 * ```
 */
export function logger(opts?: Partial<LoggerOptions>): Middleware {
  const options = opts ?? {};
  const log = options.logger ?? console.log;

  const formatter = new Intl.DateTimeFormat(
    options.locale ?? 'en-GB',
    options.dateFormat ?? {
      month:  'short',
      day:    '2-digit',
      hour:   '2-digit',
      minute: '2-digit',
    },
  );

  return (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    // Capture timestamp and path at request-arrival time so they are stable
    // even if later middleware mutates req.path (e.g. prefix stripping).
    const timestamp   = formatter.format(new Date());
    const requestPath = req.path ?? (req as any).url ?? '/';
    const ip = req.ip ?? ''
    const user = options.user?.(req) ?? '-';
    const receivedAt = Date.now();

    // Lost-request tracking.
    const tracker =
      options.track === true
        ? setTimeout(() => {
            log(`${timestamp} LOST ${req.method} ${requestPath} ${ip} <${user}>`);
          }, options.trackTimeout ?? 30_000)
        : null;

    res.on('finish', () => {
      if (tracker !== null) clearTimeout(tracker);

      const host = req.headers.host;
      const elapsed = Date.now() - receivedAt;
      const statusClass = Math.floor(res.statusCode / 100);
      const colour      = STATUS_COLORS[statusClass] ?? STATUS_COLORS[0];
      const statusStr   = `${colour}${res.statusCode}${ANSI_RESET}`;
      const contentLen  = res.getHeader('content-length') ?? '-';

      if (options.json === true)
        log({
          timestamp,
          status: res.statusCode,
          method: req.method,
          path: requestPath,
          ip,
          user,
          elapsed,
          host,
          length: contentLen,
        })
      else
        log(`${timestamp} ${statusStr} ${req.method} ${requestPath} ${ip} <${user}> ${elapsed}ms (${contentLen})`);
    });

    next();
  };
}


// ---------------------------------------------------------------------------
// Cors middleware
// ---------------------------------------------------------------------------

export type CorsOptions = {
  origin: string | string[],
  allowHeaders: string | string[],
  allowMethods: string | string[],
  allowCredentials: boolean | undefined
  maxAge: number | undefined,
  vary: string | string[] | undefined,
  optionsStatus: number,
  preflight: ((req: RouterRequest) => boolean) | undefined
}

export function cors(opts?: Partial<CorsOptions>): Middleware {
  const options:CorsOptions = {
    origin: opts?.origin || '*',
    allowHeaders: opts?.allowHeaders || 'Accept, Content-Type, Authorization',
    allowMethods: opts?.allowMethods || 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowCredentials: opts?.allowCredentials,
    maxAge: opts?.maxAge,
    vary: opts?.vary,
    optionsStatus: opts?.optionsStatus || 204,
    preflight: opts?.preflight,
  };

  return (req: RouterRequest, res: RouterResponse, next: () => void): void => {
    if (options.preflight && !options.preflight(req))
    {
      res.status(req.method == 'OPTIONS' ? 403 : 400).end()
      return
    }
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', options.origin);
      if (options.vary !== undefined)
        res.setHeader('Vary', options.vary)
    }
    if (req.method == 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', options.allowHeaders)
      res.setHeader('Access-Control-Allow-Methods', options.allowMethods)
      if (options.allowCredentials !== undefined)
        res.setHeader('Access-Control-Allow-Credentials', options.allowCredentials ? 'true' : 'false')
      if (options.maxAge !== undefined)
        res.setHeader('Access-Control-Max-Age', options.maxAge.toFixed(0))

      res.status(options.optionsStatus).end()

      return;
    }
    next();
  };
}


export default { json, formData, formEncoded, parseBody, logger, cors, streamFormData };
