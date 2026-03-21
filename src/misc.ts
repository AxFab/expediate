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
  track?: boolean;
  /**
   * Timeout in milliseconds before a tracked request is considered lost.
   * Only used when {@link track} is `true`.
   * Defaults to `30 000` ms (30 seconds).
   */
  trackTimeout?: number;
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
  user?: (req: RouterRequest) => string;
  /**
   * BCP 47 locale tag used when formatting the request timestamp.
   * Passed as the first argument to `Intl.DateTimeFormat`.
   * Defaults to `'en-GB'`.
   */
  locale?: string;
  /**
   * Date/time format options passed as the second argument to
   * `Intl.DateTimeFormat`.  Override this to change which fields are shown in
   * the timestamp.
   * Defaults to `{ month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }`.
   */
  dateFormat?: Intl.DateTimeFormatOptions;
  /**
   * Custom logging function.  Receives the fully-formatted log line as a
   * single string.  Defaults to `console.log`.
   */
  logger?: (msg: string) => void;
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
function extractCharset(contentType: string): string {
  // BUG FIX: the original regex `'s+$` was a literal quote followed by `s+$`
  // instead of `\s+$`. The trim therefore left leading/trailing whitespace on
  // every parameter, breaking charset detection. Corrected to `\s+$`.
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
 * `Content-Length` is `0` or absent.
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
  // BUG FIX: HTTP/1.1 header names are always lowercased by Node.js.
  // The original code used mixed-case keys ('Content-Length', 'Content-Encoding',
  // 'Content-Type') which always evaluated to undefined.

  const length = parseInt((req.headers['content-length'] as string) ?? '0', 10);

  // No body declared — skip to next middleware.
  if (!length || length === 0) return next();

  const maxLength = readSize(opts.limit) || 102_400;

  if (length > maxLength)
    return void res.status(413).send('Content Too Large');

  // Compression handling.
  const encoding = req.headers['content-encoding'] as string | undefined;
  if (encoding && (opts.inflate === false || !DECOMPRESS_ALGO[encoding]))
    return void res.status(415).send('Unsupported Media Type: Wrong Content-Encoding');

  // eslint-disable-next-line @typescript-eslint/ban-types
  const decompress =
    (encoding ? DECOMPRESS_ALGO[encoding] : undefined) ?? ((d: Buffer, c: zlib.CompressCallback) => c(null, d as any));

  // Content-Type validation.
  const contentType = (req.headers['content-type'] as string) ?? '';
  if (mimetype && contentType.split(';')[0].trim() !== mimetype)
    return void res.status(415).send('Unsupported Media Type: Wrong Content-Type');

  // Stream collection.
  let data: Buffer | null = Buffer.alloc(0);

  req.on('data', (chunk: Buffer) => {
    if (data === null) return; // already aborted

    // BUG FIX: the size check must happen AFTER concatenating the new chunk,
    // not before. Checking before allowed a stream of (maxLength-1)-byte chunks
    // to bypass the limit entirely.
    // BUG FIX: the original code referenced `chink` (typo) instead of `chunk`.
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
    (req as any).body = JSON.parse(
      data.toString(charset as BufferEncoding),
      opts.reviver ?? undefined,
    );
    next();
  } catch (ex) {
    res.status(500).send((ex as Error).message);
  }
}

/**
 * Parse a collected body buffer as `multipart/form-data`, split it on the
 * boundary declared in `contentType`, parse each part's headers, and assign
 * an array of {@link FormPart} objects to `req.body`.
 *
 * On success, calls `next()`.  On failure (missing boundary, malformed parts),
 * sends a 500 Internal Server Error.
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
  // BUG FIX: the original regex used `'s+$` (literal quote) instead of `\s+$`.
  const boundary = contentType
    .split(';')
    .map((s) => s.replace(/^\s+|\s+$/g, ''))
    .find((s) => s.startsWith('boundary='))
    ?.substring('boundary='.length);

  if (!boundary)
    return void res.status(400).send('Bad Request: missing multipart boundary');

  try {
    // Wire-level delimiter: each part (after the preamble) is preceded by
    // \r\n--boundary.  We split on this sequence so every resulting slice is
    // the raw content of one part (headers + blank line + body), without any
    // leading delimiter bytes.
    // BUG FIX: the original code passed `buffer` (undefined) instead of `data`.
    const delimiter = Buffer.from(`\r\n--${boundary}`);

    // Prepend \r\n so the very first part is also cleanly split.
    const normalized = Buffer.concat([Buffer.from('\r\n'), data]);
    const rawParts   = splitBuffer(normalized, delimiter);

    const parts: FormPart[] = [];

    for (const part of rawParts) {
      // The closing delimiter ends with '--'; skip it.
      // BUG FIX: the original check `buf.length == 2 && buf.toString() == '--'`
      // was incorrect. After splitting on \r\n--boundary, the terminal entry
      // is '--\r\n' (or just '--'), not a 2-byte '--'. Use startsWith.
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

    (req as any).body = parts;
    next();
  } catch (ex) {
    res.status(500).send((ex as Error).message);
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
  'multipart/form-data': (req, res, next, _opts, ct, data) =>
    readBodyAsFormData(req, res, next, ct, data),
  'application/json':   (req, res, next,  opts, ct, data) =>
    readBodyAsJson(req, res, next, opts, ct, data),
  'text/plain':         (req, res, next, _opts, ct, data) =>
    readBodyAsPlainText(req, res, next, ct, data),
};

// ---------------------------------------------------------------------------
// Public middleware factories
// ---------------------------------------------------------------------------

/**
 * Middleware factory that parses a `application/json` request body and
 * assigns the parsed value to `req.body`.
 *
 * Also attaches a `res.json(data)` helper to the response object so that
 * handlers can send JSON responses conveniently:
 * ```ts
 * res.json({ ok: true });
 * ```
 *
 * Behaviour:
 * - Requests without a body (`Content-Length: 0` or absent) are passed
 *   through to `next()` without touching `req.body`.
 * - Bodies larger than `opts.limit` receive **413 Content Too Large**.
 * - Bodies with an unsupported `Content-Encoding` receive
 *   **415 Unsupported Media Type**.
 * - Bodies whose `Content-Type` is not `application/json` receive
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
    // Attach a JSON response helper so handlers can call res.json(data).
    (res as any).json = (data: unknown): void => {
      res.write(JSON.stringify(data));
      res.end();
    };
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
 * Middleware factory that auto-detects the `Content-Type` of the request body
 * and parses it using the appropriate parser.
 *
 * Supported MIME types:
 * - `application/json`    → parsed as JSON; result is a JS value.
 * - `multipart/form-data` → parsed as multipart; result is `FormPart[]`.
 * - `text/plain`          → decoded as text; result is a string.
 *
 * Requests with an unsupported MIME type receive **415 Unsupported Media Type**.
 * All other error conditions behave identically to {@link json} and
 * {@link formData}.
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
export function logger(opts?: LoggerOptions): Middleware {
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
    const ip = (req.headers['x-forwarded-for'] as string | undefined)
      ?? (req as any).socket?.remoteAddress
      ?? '-';
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

      const elapsed = Date.now() - receivedAt;
      // BUG FIX: Math.floor is more explicit and correct than parseInt for
      // integer division. Both work, but parseInt(200/100) has a subtle
      // coercion to string first. Math.floor is semantically clearer.
      const statusClass = Math.floor(res.statusCode / 100);
      const colour      = STATUS_COLORS[statusClass] ?? STATUS_COLORS[0];
      const statusStr   = `${colour}${res.statusCode}${ANSI_RESET}`;
      const contentLen  = res.getHeader('content-length') ?? '-';

      log(`${timestamp} ${statusStr} ${req.method} ${requestPath} ${ip} <${user}> ${elapsed}ms (${contentLen})`);
    });

    next();
  };
}

export default { json, formData, parseBody, logger };
