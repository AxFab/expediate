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
// Holds `updateHttpObjects()` — which prepares each req/res pair for router
// middleware — together with the cookie encode/decode/sign/verify helpers it
// depends on.
//
// Performance note (the reason this file looks the way it does):
// the Express-compatible req/res helpers (`send`, `json`, `status`, `cookie`,
// `download`, `text`, `formData`, …) are defined ONCE on two shared prototype
// objects, not re-allocated as closures on every request. `updateHttpObjects`
// only sets the genuinely per-request DATA fields (path, params, cookies, ip…)
// and then splices the shared prototype into the object's chain via
// `Object.setPrototypeOf`. The helpers read `this` instead of capturing the
// `req`/`res`/`secret` in a closure, so nothing per-helper is allocated.
// The only per-request state the helpers cannot read from `this` directly —
// the cookie-signing secret — is stashed on the response under a private
// symbol; `res.download` reaches the request through Node's standard `res.req`.

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
// Per-request state carried on the object (not via closures)
// ---------------------------------------------------------------------------

/**
 * Private key under which the cookie-signing secret is stashed on each
 * response.  The shared prototype's `cookie()` reads it from `this` instead of
 * closing over a per-request `secret` variable.
 */
const kSecret: unique symbol = Symbol('expediate.secret');

/** Response shape once the signing secret has been attached. */
interface SecretCarrier { [kSecret]?: string | undefined; }

/**
 * Private key linking a request back to its response.  `req.json()/text()/
 * formData()` pass it to {@link readReqBody} so the optional `verify` hook is
 * invoked with `(req, res, buf)` — Node's `IncomingMessage` has no `res`
 * backlink of its own, so the router threads it on here.
 */
const kRes: unique symbol = Symbol('expediate.res');

/** Request shape once the response backlink has been attached. */
interface ResCarrier { [kRes]?: RouterResponse | undefined; }

/**
 * Resolve user-supplied {@link BodyOptions} into the concrete option object
 * expected by {@link readReqBody}.  A free function (no per-request closure):
 * it depends only on its `opts` argument.
 */
function resolveReqOpts(opts?: BodyOptions) {
  return {
    limit:   opts?.limit   ?? '100kb',
    inflate: opts?.inflate ?? true,
    reviver: null,
    strict:  opts?.strict  ?? false,
    // readReqBody takes its expected mimetype as an explicit argument, so the
    // type matcher here is unused; null keeps the object shape-compatible.
    type:    null,
    verify:  opts?.verify  ?? null,
  };
}

/** Status-line reason phrases used by `res.sendStatus()` (hoisted, shared). */
const STATUS_MESSAGES: Record<number, string> = {
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

// ---------------------------------------------------------------------------
// Shared request helpers (defined once; spliced onto each req via prototype)
// ---------------------------------------------------------------------------

const requestHelpers = {
  /** Read and parse the request body as JSON (cached after first read). */
  json(this: RouterRequest, opts?: BodyOptions): Promise<unknown> {
    // If a body-parsing middleware already consumed the stream, return the cached value.
    if ('body' in this) return Promise.resolve((this as { body?: unknown }).body ?? null);
    return readReqBody(this, resolveReqOpts(opts), 'application/json', (this as RouterRequest & ResCarrier)[kRes])
      .then(ret => {
        if (ret == null) return null;
        const charset = extractCharset(ret.mimetype);
        try {
          const parsed: unknown = JSON.parse(
            ret.content.toString(charset as BufferEncoding),
            opts?.reviver ?? undefined,
          );
          (this as { body?: unknown }).body = parsed;
          return parsed;
        } catch (ex) {
          return Promise.reject({ status: 400, message: 'Bad Request: ' + (ex as Error).message });
        }
      });
  },

  /** Read and decode the request body as plain text (cached after first read). */
  text(this: RouterRequest, opts?: BodyOptions): Promise<string | null> {
    const cached = (this as { body?: unknown }).body;
    if (typeof cached === 'string') return Promise.resolve(cached);
    return readReqBody(this, resolveReqOpts(opts), null, (this as RouterRequest & ResCarrier)[kRes])
      .then(ret => {
        if (ret == null) return null;
        const charset = extractCharset(ret.mimetype);
        return ret.content.toString(charset as BufferEncoding);
      });
  },

  /** Read and parse the request body as `multipart/form-data` (cached). */
  formData(this: RouterRequest, opts?: BodyOptions): Promise<FormPart[] | null> {
    const cached = (this as { body?: unknown }).body;
    if (Array.isArray(cached)) return Promise.resolve(cached as FormPart[]);
    return readReqBody(this, resolveReqOpts(opts), 'multipart/form-data', (this as RouterRequest & ResCarrier)[kRes])
      .then(ret => {
        if (ret == null) return null;
        try {
          const parts = parseMultipartBody(ret.mimetype, ret.content);
          (this as { body?: unknown }).body = parts;
          return parts;
        } catch (ex) {
          const e = ex as { status?: number; message?: string };
          return Promise.reject({ status: e.status ?? 500, message: e.message ?? String(ex) });
        }
      });
  },

  /** Read a request header by name (case-insensitive; referer/referrer alias). */
  header(this: RouterRequest, name: string): string | string[] | undefined {
    const key = name.toLowerCase();
    // Express treats the two spellings of the referer header as equivalent.
    if (key === 'referer' || key === 'referrer')
      return this.headers.referer ?? this.headers.referrer;
    return this.headers[key];
  },
};

// ---------------------------------------------------------------------------
// Shared response helpers (defined once; spliced onto each res via prototype)
// ---------------------------------------------------------------------------

const responseHelpers = {
  send(this: RouterResponse, data?: string): void {
    if (data) this.write(data);
    this.end();
  },

  json(this: RouterResponse, data: unknown): void {
    this.setHeader('Content-Type', 'application/json');
    this.write(JSON.stringify(data));
    this.end();
  },

  status(this: RouterResponse, code: number, headers?: StringMap): RouterResponse {
    if (!Number.isInteger(code) || code < 100 || code > 999)
      throw new RangeError(`Invalid status code: ${code}. Must be an integer between 100 and 999.`);
    this.statusCode = code;
    if (headers)
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    return this;
  },

  redirect(this: RouterResponse, url: string): void {
    this.setHeader('location', url);
    this.writeHead(302);
    this.write(`Found. Redirecting to ${url}`);
    this.end();
  },

  cookie(
    this: RouterResponse,
    name: string,
    value: string | object,
    options?: CookieOptions,
  ): RouterResponse {
    const opts: CookieOptions = options ?? {};

    // Serialise: objects get the j: prefix so the reader can JSON-decode them.
    let val =
      typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);

    if (opts.signed) {
      const secret = (this as RouterResponse & SecretCarrier)[kSecret];
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
    const existing = this.getHeader('Set-Cookie');
    if (existing == null) {
      this.setHeader('Set-Cookie', txt);
    } else if (Array.isArray(existing)) {
      this.setHeader('Set-Cookie', [...existing, txt]);
    } else {
      this.setHeader('Set-Cookie', [existing as string, txt]);
    }

    return this;
  },

  download(this: RouterResponse, filepath: string, filename?: string): void {
    const rReq = this.req as RouterRequest;
    const name = filename ?? path.basename(filepath);
    // Use double-quotes and escape any double-quote in the filename per RFC 6266.
    const safeName = name.replace(/"/g, '\\"');
    this.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    // Guard: return 404 when the file does not exist (serveFile would send 500
    // for any stat error; we want the conventional 404 for downloads).
    fs.access(filepath, fs.constants.F_OK, (err) => {
      if (err) {
        if (!this.writableEnded) this.status(404).end('Not Found');
        return;
      }
      serveFile(filepath)(rReq, this, () => { /* no-op */ });
    });
  },

  type(this: RouterResponse, mimeType: string): RouterResponse {
    this.setHeader('Content-Type', mimeType);
    return this;
  },

  etag(this: RouterResponse, value: string, strong = false): RouterResponse {
    this.setHeader('ETag', strong ? `"${value}"` : `W/"${value}"`);
    return this;
  },

  header(this: RouterResponse, field: string, value: string | number | string[]): RouterResponse {
    this.setHeader(field, value);
    return this;
  },

  append(this: RouterResponse, field: string, value: string | string[]): RouterResponse {
    const existing = this.getHeader(field);
    if (existing == null) {
      this.setHeader(field, value);
    } else if (field.toLowerCase() === 'set-cookie') {
      // Set-Cookie must accumulate as an array (multiple values not comma-joinable).
      const prev = Array.isArray(existing) ? existing : [String(existing)];
      const next = Array.isArray(value) ? value : [value];
      this.setHeader(field, [...prev, ...next]);
    } else {
      const prev = Array.isArray(existing) ? existing.join(', ') : String(existing);
      const added = Array.isArray(value) ? value.join(', ') : value;
      this.setHeader(field, `${prev}, ${added}`);
    }
    return this;
  },

  vary(this: RouterResponse, field: string | string[]): RouterResponse {
    const fields = Array.isArray(field) ? field : [field];
    const existing = this.getHeader('Vary');
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
    this.setHeader('Vary', current.join(', '));
    return this;
  },

  location(this: RouterResponse, url: string): RouterResponse {
    this.setHeader('Location', url);
    return this;
  },

  clearCookie(this: RouterResponse, name: string, options?: CookieOptions): RouterResponse {
    const opts: CookieOptions = { ...options, expires: new Date(0), maxAge: 0 };
    // Remove signed flag — clearing does not need signing.
    delete opts.signed;
    this.cookie(name, '', opts);
    return this;
  },

  sendStatus(this: RouterResponse, code: number): void {
    this.setHeader('Content-Type', 'text/plain');
    this.statusCode = code;
    this.end(STATUS_MESSAGES[code] ?? String(code));
  },

  attachment(this: RouterResponse, filename?: string): RouterResponse {
    if (filename) {
      const mimeType = mime.lookup(filename, 'application/octet-stream');
      this.setHeader('Content-Type', mimeType);
      const safeName = path.basename(filename).replace(/"/g, '\\"');
      this.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    } else {
      this.setHeader('Content-Disposition', 'attachment');
    }
    return this;
  },
};

// ---------------------------------------------------------------------------
// Prototype derivation — one custom prototype per native base, cached
// ---------------------------------------------------------------------------

/**
 * Cache of derived prototypes keyed by the object's native prototype. There is
 * one entry per transport kind (HTTP/1 request, HTTP/1 response, HTTP/2
 * request, HTTP/2 response), so these maps hold at most a handful of entries
 * for the lifetime of the process.
 */
const reqProtoCache = new WeakMap<object, object>();
const resProtoCache = new WeakMap<object, object>();

/**
 * Return a prototype that layers `helpers` on top of `obj`'s current native
 * prototype, creating and caching it on first use. The returned prototype keeps
 * every native method (it chains to the original prototype) and adds ours.
 */
function ensureProto(cache: WeakMap<object, object>, obj: object, helpers: object): object {
  const base = Object.getPrototypeOf(obj) as object;
  let proto = cache.get(base);
  if (proto === undefined) {
    proto = Object.assign(Object.create(base) as object, helpers);
    cache.set(base, proto);
  }
  return proto;
}

// ---------------------------------------------------------------------------
// HTTP object augmentation
// ---------------------------------------------------------------------------

/**
 * Prepare a raw `http.IncomingMessage` / `http.ServerResponse` pair for router
 * middleware: attach the shared helper prototypes and populate the per-request
 * data fields the helpers (and the router) rely on.
 *
 * This function is idempotent — it exits immediately when `req.queries` is
 * already defined, so it is safe to call multiple times on the same pair (as
 * happens with nested routers sharing one request object).
 *
 * **Fields added to `req`:** `originalUrl`, `path`, `params`, `query`,
 * `queries`, `cookies`, `ip`, `ips`, `protocol`, `secure`, `hostname`,
 * `baseUrl`.  Helper methods (`json`, `text`, `formData`, `header`) come from
 * the shared request prototype.
 *
 * **Fields added to `res`:** `locals` and the cookie-signing secret (under a
 * private symbol).  Helper methods (`send`, `json`, `status`, `cookie`,
 * `download`, …) come from the shared response prototype.
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

  // Splice the shared helper prototypes into the chain once, before any other
  // mutation. The helpers read `this`, so no per-request closures are created.
  Object.setPrototypeOf(req, ensureProto(reqProtoCache, req, requestHelpers));
  Object.setPrototypeOf(res, ensureProto(resProtoCache, res, responseHelpers));

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
    rReq.protocol = (req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http';
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

  // Stash the signing secret so res.cookie()/clearCookie() can read it from the
  // object rather than from a captured closure variable, and link req → res so
  // the body readers can forward the response to readReqBody's verify hook.
  (rRes as RouterResponse & SecretCarrier)[kSecret] = secret;
  (rReq as RouterRequest & ResCarrier)[kRes] = rRes;
  rRes.locals = {};
  rRes.setHeader('X-Powered-By', 'Expediate');
}
