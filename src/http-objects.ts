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

// ---------------------------------------------------------------------------
// HTTP request/response augmentation
// ---------------------------------------------------------------------------
// Extracted from router.ts. Holds `updateHttpObjects()` — which attaches all
// the Express-compatible req/res helpers — together with the cookie
// encode/decode/sign/verify helpers it depends on.

import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as http   from 'http';
import * as path   from 'path';
import { mime, serveFile } from './static.js';
import { parseMultipartBody, extractCharset, readReqBody } from './misc.js';
import type { BodyOptions, FormPart } from './misc.js';
import type { RouterRequest, RouterResponse, CookieOptions, StringMap } from './router-types.js';

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Decode a raw cookie value, stripping the `j:` prefix and JSON-parsing the
 * payload when present.  Plain string values are returned unchanged.
 *
 * @param raw - The raw cookie value as it appears after the `=` in the header.
 * @returns The decoded value: a JS value for `j:` cookies, or the raw string.
 */
function decodeJsonCookie(raw: string): unknown {
  if (!raw.startsWith('j:')) return raw;
  try {
    return JSON.parse(raw.slice(2));
  } catch {
    return raw; // malformed JSON — fall back to raw string
  }
}

/**
 * Percent-encode a cookie value for safe transport in a `Set-Cookie` header.
 *
 * RFC 6265 forbids whitespace, double quotes, commas, semicolons, and
 * backslashes in a bare cookie value.  `encodeURIComponent` escapes all of
 * these (and the `:` / `{` / `}` / `"` produced by the `s:` and `j:` wire
 * formats), and {@link decodeCookieValue} reverses it on the way in.
 *
 * @param value - The raw cookie value (may include an `s:`/`j:` prefix).
 * @returns The percent-encoded value.
 */
function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Decode a raw cookie value taken from a `Cookie` request header.
 *
 * Strips an optional surrounding double-quoted form (RFC 6265 quoted-string),
 * then percent-decodes the result.  Malformed percent-sequences fall back to
 * the (de-quoted) raw string so a single bad cookie never throws.
 *
 * @param raw - The raw value as it appears after `=` in the header.
 * @returns The decoded value, ready for `s:`/`j:` interpretation.
 */
function decodeCookieValue(raw: string): string {
  let val = raw;
  if (val.length >= 2 && val.charCodeAt(0) === 0x22 && val.charCodeAt(val.length - 1) === 0x22)
    val = val.slice(1, -1); // strip surrounding double quotes
  try {
    return decodeURIComponent(val);
  } catch {
    return val; // malformed percent-encoding — use the raw (de-quoted) string
  }
}

/**
 * Sign a cookie value with HMAC-SHA256.
 *
 * The produced string follows the `cookie-signature` wire format:
 * `s:<value>.<base64url-HMAC>`, where `<value>` is the raw (possibly
 * `j:`-prefixed) string and the HMAC is computed over that raw string.
 *
 * @param value  - The raw cookie value to sign (may include a `j:` prefix).
 * @param secret - The HMAC secret.
 * @returns The signed cookie string with the `s:` prefix.
 */
function signCookieValue(value: string, secret: string): string {
  const sig = crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url');
  return `s:${value}.${sig}`;
}

/**
 * Verify and decode a signed cookie value.
 *
 * The input must start with `s:` and follow the format produced by
 * {@link signCookieValue}: `s:<value>.<base64url-HMAC>`.
 *
 * Uses `crypto.timingSafeEqual` to prevent timing-based signature attacks.
 *
 * @param signed - The raw `Set-Cookie` value including the `s:` prefix.
 * @param secret - The HMAC secret to verify against.
 * @returns The inner value string on success, or `false` when the signature
 *          is absent or does not match (indicating a tampered cookie).
 */
function verifyCookieValue(signed: string, secret: string): string | false {
  if (!signed.startsWith('s:')) return false;
  const withoutPrefix = signed.slice(2);
  const lastDot       = withoutPrefix.lastIndexOf('.');
  if (lastDot === -1) return false;

  const value    = withoutPrefix.slice(0, lastDot);
  const received = withoutPrefix.slice(lastDot + 1);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url');

  const receivedBuf = Buffer.from(received, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');

  if (receivedBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) return false;
  return value;
}

// ---------------------------------------------------------------------------
// HTTP object augmentation
// ---------------------------------------------------------------------------

/**
 * Augment a raw `http.IncomingMessage` / `http.ServerResponse` pair with the
 * additional fields and helpers expected by router middleware.
 *
 * This function is idempotent — it exits immediately when `req.queries` is
 * already defined, so it is safe to call multiple times on the same pair.
 *
 * **Fields added to `req`:**
 * - `originalUrl` — the unmodified URL string.
 * - `path`        — the pathname portion of the URL.
 * - `params`      — merged map initialised from URL query parameters.
 * - `queries`     — structured query buckets (`url`, `route`).
 * - `cookies`     — parsed `Cookie` header values.
 *
 * **Helpers added to `res`:**
 * - `send(data?)`             — write `data` and end the response.
 * - `json(data)`              — serialise to JSON and end.
 * - `status(code, headers?)`  — set the status code and optional headers.
 * - `redirect(url)`           — issue a 302 redirect.
 * - `cookie(name, val, opts)` — append a `Set-Cookie` header.
 *
 * @param req         - The raw incoming message to augment.
 * @param res         - The raw server response to augment.
 * @param secret      - Optional cookie-signing secret.
 * @param trustProxy  - When `true`, resolve `req.ip` from `X-Forwarded-For`.
 */
export function updateHttpObjects(
  req:         http.IncomingMessage,
  res:         http.ServerResponse,
  secret:      string | undefined,
  trustProxy?: boolean,
): void {
  const rReq = req as RouterRequest;
  const rRes = res as RouterResponse;

  if (rReq.queries) return; // Already augmented.

  rReq.queries = {};

  // Resolve the client IP address and proxy-related fields.
  // When trustProxy is true the leftmost value in X-Forwarded-For is used
  // (the originating client behind the proxy chain).  Otherwise we read the
  // raw TCP remote address directly from the socket, which cannot be spoofed.
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const xffStr = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
    rReq.ips = xffStr ? xffStr.split(',').map(s => s.trim()) : [];
    rReq.ip  = rReq.ips[0] ?? req.socket?.remoteAddress ?? '';

    const xProto = req.headers['x-forwarded-proto'];
    rReq.protocol = (Array.isArray(xProto) ? xProto[0] : xProto)?.split(',')[0].trim() ?? 'http';

    const xHost = req.headers['x-forwarded-host'];
    const hostHeader = (Array.isArray(xHost) ? xHost[0] : xHost) ?? req.headers.host ?? '';
    rReq.hostname = hostHeader.replace(/:\d+$/, '');
  } else {
    rReq.ip       = req.socket?.remoteAddress ?? '';
    rReq.ips      = [];
    rReq.protocol = (req.socket as any)?.encrypted ? 'https' : 'http';
    rReq.hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  }
  rReq.secure  = rReq.protocol === 'https';
  rReq.baseUrl = rReq.baseUrl ?? '';

  const qry = new URL(`http://${req.headers.host}${req.url}`);
  rReq.originalUrl = req.url!;
  rReq.path = qry.pathname;

  // Parse URL query parameters.
  // FEAT-03: repeated keys (e.g. ?tag=a&tag=b) accumulate into arrays.
  const urlParams: Record<string, string | string[]> = {};
  for (const [key, value] of qry.searchParams.entries()) {
    const existing = urlParams[key];
    if (existing === undefined) {
      urlParams[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      urlParams[key] = [existing, value];
    }
  }
  rReq.queries.url = urlParams;
  // params stays StringMap — use first value for repeated keys.
  const flatParams: StringMap = {};
  for (const [key, value] of Object.entries(urlParams)) {
    flatParams[key] = Array.isArray(value) ? value[0] : value;
  }
  rReq.params = flatParams;
  rReq.query  = urlParams;

  // Parse cookies.
  if (rReq.cookies == null) {
    rReq.cookies = {};
    if (req.headers.cookie) {
      for (const part of req.headers.cookie.split(';')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const name   = part.slice(0, eqIdx).trim();
        // De-quote and percent-decode before interpreting s:/j: prefixes, so
        // values containing semicolons, commas, quotes, or spaces round-trip.
        const rawVal = decodeCookieValue(part.slice(eqIdx + 1).trim());

        if (rawVal.startsWith('s:')) {
          // Signed cookie — verify the HMAC signature.
          if (secret) {
            const inner = verifyCookieValue(rawVal, secret);
            if (inner === false) continue; // tampered — silently omit
            rReq.cookies[name] = decodeJsonCookie(inner);
          } else {
            // No secret configured — include the raw value so the application
            // can at least inspect that a signed cookie was sent.
            rReq.cookies[name] = rawVal;
          }
        } else {
          // Plain or JSON-encoded cookie.
          rReq.cookies[name] = decodeJsonCookie(rawVal);
        }
      }
    }
  }

  const resolvedReqOpts = (opts?: BodyOptions) => ({
    limit:   opts?.limit   ?? '100kb',
    inflate: opts?.inflate ?? true,
    reviver: null,
    strict:  opts?.strict  ?? false,
    // readReqBody takes its expected mimetype as an explicit argument, so the
    // type matcher here is unused; null keeps the object shape-compatible.
    type:    null,
    verify:  opts?.verify  ?? null,
  });

  rReq.json = (opts?: BodyOptions): Promise<unknown> => {
    // If a body-parsing middleware already consumed the stream, return the cached value.
    if ('body' in (rReq as any)) return Promise.resolve((rReq as any).body ?? null);
    return readReqBody(rReq, resolvedReqOpts(opts), 'application/json', rRes)
      .then(ret => {
        if (ret == null) return null;
        const charset = extractCharset(ret.mimetype);
        try {
          const parsed = JSON.parse(
            ret.content.toString(charset as BufferEncoding),
            opts?.reviver ?? undefined,
          );
          (rReq as any).body = parsed;
          return parsed;
        } catch (ex) {
          return Promise.reject({ status: 400, message: 'Bad Request: ' + (ex as Error).message });
        }
      });
  };

  rReq.text = (opts?: BodyOptions): Promise<string | null> => {
    // If a body-parsing middleware already consumed the stream, return the cached string.
    const cached = (rReq as any).body;
    if (typeof cached === 'string') return Promise.resolve(cached);
    return readReqBody(rReq, resolvedReqOpts(opts), null, rRes)
      .then(ret => {
        if (ret == null) return null;
        const charset = extractCharset(ret.mimetype);
        return ret.content.toString(charset as BufferEncoding);
      });
  };

  rReq.formData = (opts?: BodyOptions): Promise<FormPart[] | null> => {
    // If a body-parsing middleware already consumed the stream, return the cached parts.
    const cached = (rReq as any).body;
    if (Array.isArray(cached)) return Promise.resolve(cached as FormPart[]);
    return readReqBody(rReq, resolvedReqOpts(opts), 'multipart/form-data', rRes)
      .then(ret => {
        if (ret == null) return null;
        try {
          const parts = parseMultipartBody(ret.mimetype, ret.content);
          (rReq as any).body = parts;
          return parts;
        } catch (ex: any) {
          // console.error('Body Err', ex)
          return Promise.reject({ status: ex.status ?? 500, message: ex.message ?? String(ex) });
        }
      });
  };

  rReq.header = (name: string): string | string[] | undefined => {
    const key = name.toLowerCase();
    // Express treats the two spellings of the referer header as equivalent.
    if (key === 'referer' || key === 'referrer')
      return req.headers.referer ?? req.headers.referrer;
    return req.headers[key];
  };

  rRes.setHeader('X-Powered-By', 'Expediate');

  rRes.send = (data?: string): void => {
    if (data) res.write(data);
    res.end();
  };

  rRes.json = (data: unknown): void => {
    res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify(data));
    res.end();
  };

  rRes.status = (code: number, headers?: StringMap): typeof rRes => {
    res.statusCode = code;
    if (headers)
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return rRes;
  };

  rRes.redirect = (url: string): void => {
    res.setHeader('location', url);
    res.writeHead(302);
    res.write(`Found. Redirecting to ${url}`);
    res.end();
  };

  rRes.cookie = (
    name: string,
    value: string | object,
    options?: CookieOptions,
  ): typeof rRes => {
    const opts: CookieOptions = options ?? {};

    // Serialise: objects get the j: prefix so the reader can JSON-decode them.
    let val =
      typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);

    if (opts.signed) {
      if (!secret)
        throw new Error(
          'Signed cookies require a secret — pass { secret } to createRouter()',
        );
      val = signCookieValue(val, secret);
    }

    // Percent-encode the final value (after any j:/s: wrapping) so special
    // characters are transmitted safely; decodeCookieValue() reverses it.
    let txt = `${name}=${encodeCookieValue(val)}`;

    if (opts.maxAge != null) {
      const maxAgeMs  = opts.maxAge;
      const maxAgeSec = Math.floor(maxAgeMs / 1000);
      // Only derive Expires from maxAge when maxAge > 0; a zero maxAge is used
      // for clearing cookies and the caller may have already set opts.expires
      // to the epoch — do not overwrite it.
      if (maxAgeMs > 0) opts.expires = new Date(Date.now() + maxAgeMs);
      txt += `; Max-Age=${maxAgeSec}`;
    }

    if (opts.expires)  txt += `; Expires=${opts.expires.toUTCString()}`;
    txt += `; Path=${opts.path ?? '/'}`;
    if (opts.httpOnly) txt += '; HttpOnly';
    if (opts.secure)   txt += '; Secure';
    if (opts.sameSite) txt += `; SameSite=${opts.sameSite}`;

    // Append rather than overwrite so multiple cookies can be set on the same
    // response.  res.setHeader() would replace any previously set Set-Cookie
    // header; instead, accumulate into an array.
    const existing = res.getHeader('Set-Cookie');
    if (existing == null) {
      res.setHeader('Set-Cookie', txt);
    } else if (Array.isArray(existing)) {
      res.setHeader('Set-Cookie', [...existing, txt]);
    } else {
      res.setHeader('Set-Cookie', [existing as string, txt]);
    }

    return rRes;
  };

  rRes.download = (filepath: string, filename?: string): void => {
    const name = filename ?? path.basename(filepath);
    // Use double-quotes and escape any double-quote in the filename per RFC 6266.
    const safeName = name.replace(/"/g, '\\"');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    // Guard: return 404 when the file does not exist (serveFile would send 500
    // for any stat error; we want the conventional 404 for downloads).
    fs.access(filepath, fs.constants.F_OK, (err) => {
      if (err) {
        if (!rRes.writableEnded) rRes.status(404).end('Not Found');
        return;
      }
      serveFile(filepath)(rReq, rRes, () => { /* no-op */ });
    });
  };

  rRes.type = (mime: string): typeof rRes => {
    res.setHeader('Content-Type', mime);
    return rRes;
  };

  rRes.etag = (value: string, strong = false): typeof rRes => {
    res.setHeader('ETag', strong ? `"${value}"` : `W/"${value}"`);
    return rRes;
  };

  rRes.locals = {};

  rRes.header = (field: string, value: string | number | string[]): typeof rRes => {
    res.setHeader(field, value);
    return rRes;
  };

  rRes.append = (field: string, value: string | string[]): typeof rRes => {
    const existing = res.getHeader(field);
    if (existing == null) {
      res.setHeader(field, value);
    } else if (field.toLowerCase() === 'set-cookie') {
      // Set-Cookie must accumulate as an array (multiple values not comma-joinable).
      const prev = Array.isArray(existing) ? existing : [String(existing)];
      const next = Array.isArray(value) ? value : [value];
      res.setHeader(field, [...prev, ...next]);
    } else {
      const prev = Array.isArray(existing) ? existing.join(', ') : String(existing);
      const added = Array.isArray(value) ? value.join(', ') : value;
      res.setHeader(field, `${prev}, ${added}`);
    }
    return rRes;
  };

  rRes.vary = (field: string | string[]): typeof rRes => {
    const fields = Array.isArray(field) ? field : [field];
    const existing = res.getHeader('Vary');
    const current: string[] = existing
      ? (Array.isArray(existing) ? existing : [String(existing)])
          .join(', ')
          .split(',')
          .map(s => s.trim().toLowerCase())
      : [];
    for (const f of fields) {
      if (!current.includes(f.toLowerCase())) {
        current.push(f.toLowerCase());
      }
    }
    res.setHeader('Vary', current.join(', '));
    return rRes;
  };

  rRes.location = (url: string): typeof rRes => {
    res.setHeader('Location', url);
    return rRes;
  };

  rRes.clearCookie = (name: string, options?: CookieOptions): typeof rRes => {
    const opts: CookieOptions = { ...options, expires: new Date(0), maxAge: 0 };
    // Remove signed flag — clearing does not need signing.
    delete opts.signed;
    rRes.cookie(name, '', opts);
    return rRes;
  };

  rRes.sendStatus = (code: number): void => {
    const messages: Record<number, string> = {
      100: 'Continue', 101: 'Switching Protocols', 102: 'Processing',
      200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
      206: 'Partial Content', 207: 'Multi-Status',
      300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found',
      303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect',
      308: 'Permanent Redirect',
      400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
      403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
      406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
      410: 'Gone', 411: 'Length Required', 413: 'Payload Too Large',
      415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error', 501: 'Not Implemented',
      502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    };
    res.setHeader('Content-Type', 'text/plain');
    res.statusCode = code;
    res.end(messages[code] ?? String(code));
  };

  rRes.attachment = (filename?: string): typeof rRes => {
    if (filename) {
      const mimeType = mime.lookup(filename, 'application/octet-stream');
      res.setHeader('Content-Type', mimeType);
      const safeName = path.basename(filename).replace(/"/g, '\\"');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    } else {
      res.setHeader('Content-Disposition', 'attachment');
    }
    return rRes;
  };

  // Wrap status() to validate code is an integer in 100–999.
  const _statusOrig = rRes.status.bind(rRes);
  rRes.status = (code: number, headers?: StringMap): typeof rRes => {
    if (!Number.isInteger(code) || code < 100 || code > 999)
      throw new RangeError(`Invalid status code: ${code}. Must be an integer between 100 and 999.`);
    return _statusOrig(code, headers);
  };
}
