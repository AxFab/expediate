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

import * as crypto from 'crypto';
import * as http   from 'http';
import * as zlib   from 'zlib';

import type { RouterRequest, RouterResponse, NextFunction } from './router.js';

/** Shorthand for a standard middleware function. */
type Middleware = (req: RouterRequest, res: RouterResponse, next: NextFunction) => void;

// ---------------------------------------------------------------------------
// Module augmentation — fields added to req by specific middleware
// ---------------------------------------------------------------------------

declare module './router.js' {
  interface RouterRequest {
    /**
     * Unique identifier for this request.
     * Set by the {@link requestId} middleware.
     */
    id?: string;

    /**
     * Returns the current CSRF token for this request.
     * Available after the {@link csrf} middleware has run.
     *
     * Include the returned value in an `X-CSRF-Token` header (or `_csrf`
     * body field) on every state-mutating request (POST / PUT / PATCH / DELETE).
     */
    csrfToken?: () => string;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a string or Buffer value to a `Buffer`.
 *
 * @param chunk    - The data to convert.
 * @param encoding - Character encoding to use when `chunk` is a string.
 * @returns        A `Buffer` containing the bytes of `chunk`.
 */
function toBuffer(chunk: string | Buffer, encoding: BufferEncoding = 'utf8'): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
}

// ===========================================================================
// 1 · compress — response compression middleware
// ===========================================================================

/**
 * Options for the {@link compress} middleware.
 */
export interface CompressOptions {
  /**
   * Minimum response body size in bytes before compression is applied.
   * Responses whose total body is smaller than this value are sent
   * uncompressed to avoid the overhead of compressing tiny payloads.
   *
   * @default 1024
   */
  threshold?: number;

  /**
   * Enable Brotli (`br`) encoding when the client declares support for it.
   * Brotli achieves better compression ratios than gzip for text content and
   * is supported by all modern browsers.
   *
   * @default true
   */
  br?: boolean;

  /**
   * Compression quality for Brotli (0 – 11).  Higher values produce smaller
   * output but are slower.  A value of 4 is a good balance for on-the-fly
   * web serving.
   *
   * @default 4
   */
  brotliQuality?: number;

  /**
   * Compression level for gzip / deflate (1 – 9, or
   * `zlib.constants.Z_DEFAULT_COMPRESSION`).  Higher values compress more
   * but use more CPU.
   *
   * @default zlib.constants.Z_DEFAULT_COMPRESSION
   */
  gzipLevel?: number;

  /**
   * Custom filter called for every request.  Return `false` to skip
   * compression for that specific request (e.g. to exempt already-compressed
   * formats).
   *
   * @example
   * ```ts
   * compress({
   *   filter: (_req, res) => {
   *     const ct = res.getHeader('content-type') as string ?? '';
   *     return /^text\/|application\/(json|xml|javascript)/.test(ct);
   *   },
   * })
   * ```
   */
  filter?: (req: RouterRequest, res: RouterResponse) => boolean;
}

/**
 * Response compression middleware.
 *
 * Reads the `Accept-Encoding` request header and transparently compresses the
 * response body using Brotli, gzip, or deflate (tested in that preference
 * order).  Responses whose total body is smaller than `threshold` bytes are
 * sent uncompressed to avoid wasting CPU on tiny payloads.
 *
 * The middleware monkey-patches `res.write` and `res.end` so that all
 * downstream code (including `res.json`, `res.send`, and manual writes)
 * passes through the compressor without any changes to handler code.
 *
 * The `Content-Encoding` and `Vary: Accept-Encoding` headers are set
 * automatically.  `Content-Length` is removed because the compressed length
 * cannot be known in advance.
 *
 * @param opts - Optional compression settings.
 * @returns    An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * const app = createRouter();
 * app.use(compress());                     // at the top — must come first
 * app.get('/api/data', (_req, res) => res.json(bigPayload));
 * ```
 */
export function compress(opts?: CompressOptions): Middleware {
  const threshold    = opts?.threshold    ?? 1024;
  const brEnabled    = opts?.br           !== false;
  const brotliQuality = opts?.brotliQuality ?? 4;
  const gzipLevel    = opts?.gzipLevel    ?? zlib.constants.Z_DEFAULT_COMPRESSION;

  return (req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    // User-supplied filter.
    if (opts?.filter && !opts.filter(req, res)) return next();

    const ae = (req.headers['accept-encoding']!) ?? '';

    // Negotiate encoding: Brotli > gzip > deflate.
    let compressor: zlib.BrotliCompress | zlib.Gzip | zlib.Deflate | null = null;
    let encoding = '';

    if (brEnabled && /\bbr\b/.test(ae)) {
      compressor = zlib.createBrotliCompress({
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality },
      });
      encoding = 'br';
    } else if (/\bgzip\b/.test(ae)) {
      compressor = zlib.createGzip({ level: gzipLevel });
      encoding = 'gzip';
    } else if (/\bdeflate\b/.test(ae)) {
      compressor = zlib.createDeflate({ level: gzipLevel });
      encoding = 'deflate';
    }

    if (!compressor) return next();

    const comp   = compressor;
    const rawRes = res as unknown as http.ServerResponse;

    // Capture original write / end before we override them.
    const origWrite = rawRes.write.bind(rawRes);
    const origEnd   = rawRes.end.bind(rawRes);

    // Route compressor output back to the raw socket.
    comp.on('data',  (chunk: Buffer) => { origWrite(chunk); });
    comp.on('end',   ()              => { origEnd(); });
    comp.on('error', (e: Error)      => {
      console.error('[compress] stream error:', e.message);
      if (!rawRes.writableEnded) origEnd();
    });

    // Buffer incoming data so we can decide compress vs bypass at end().
    const pending: Buffer[] = [];
    let totalBytes = 0;
    let decided    = false; // true once we committed to compress or bypass
    let doCompress = false;

    /**
     * Commit to compression: flush all buffered pending data to the compressor
     * and mark `decided = true, doCompress = true`.
     *
     * @param andEnd - When `true`, also call `comp.end()` to flush and close
     *                 the compressor after writing pending data.
     */
    const startCompressing = (andEnd: boolean): void => {
      decided    = true;
      doCompress = true;
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      for (const buf of pending) comp.write(buf);
      if (andEnd) comp.end();
    };

    /**
     * Commit to bypassing compression (total bytes below threshold).
     * Undoes the tentative headers and writes buffered data directly.
     */
    const skipCompression = (): void => {
      decided    = true;
      doCompress = false;
      comp.destroy();
      if (totalBytes > 0) res.setHeader('Content-Length', totalBytes);
      for (const buf of pending) origWrite(buf);
    };

    // Override res.write.
    (res as any).write = (
      chunk: string | Buffer,
      encOrCb?: BufferEncoding | ((err?: Error | null) => void),
      _cb?: (err?: Error | null) => void,
    ): boolean => {
      const enc = typeof encOrCb === 'string' ? encOrCb : 'utf8';
      const buf = toBuffer(chunk, enc);

      if (decided) {
        // Already committed — write directly to the right destination.
        return doCompress ? comp.write(buf) : origWrite(buf);
      }

      pending.push(buf);
      totalBytes += buf.length;

      // Crossed threshold mid-stream: start compression now.
      if (totalBytes >= threshold) startCompressing(false);

      return true;
    };

    // Override res.end.
    (res as any).end = (
      chunk?: string | Buffer | (() => void),
      encOrCb?: BufferEncoding | (() => void),
      _cb?: () => void,
    ): http.ServerResponse => {
      if (typeof chunk   === 'function') chunk   = undefined;
      if (typeof encOrCb === 'function') encOrCb = undefined;

      if (chunk != null) {
        const enc = typeof encOrCb === 'string' ? encOrCb : 'utf8';
        const buf = toBuffer(chunk, enc);

        if (decided) {
          if (doCompress) comp.write(buf);
          else            origWrite(buf);
        } else {
          pending.push(buf);
          totalBytes += buf.length;
        }
      }

      if (!decided) {
        if (totalBytes >= threshold) startCompressing(true);
        else { skipCompression(); origEnd(); }
      } else if (doCompress) {
        comp.end();
      } else {
        origEnd();
      }

      return rawRes;
    };

    next();
  };
}

// ===========================================================================
// 2 · requestId — unique request ID middleware
// ===========================================================================

/**
 * Options for the {@link requestId} middleware.
 */
export interface RequestIdOptions {
  /**
   * HTTP header name used to read (from the client) and write (to the
   * response) the request ID.
   *
   * @default 'x-request-id'
   */
  header?: string;

  /**
   * When `true`, reuse the ID supplied by the client in the header instead of
   * generating a new one.  Set to `false` in security-sensitive environments
   * where client-supplied IDs must not be trusted.
   *
   * @default true
   */
  allowFromHeader?: boolean;

  /**
   * Custom ID generator.  Must return a unique string for every call.
   *
   * @default () => crypto.randomUUID()
   */
  generator?: () => string;
}

/**
 * Request ID middleware.
 *
 * Attaches a unique identifier to every request as `req.id` and echoes it
 * back in the response header (default: `X-Request-ID`).  The ID is taken
 * from the incoming header when `allowFromHeader` is `true` (the default);
 * otherwise a new UUID is generated with `crypto.randomUUID()`.
 *
 * Use `req.id` in log statements and error responses to correlate distributed
 * traces back to a single originating request.
 *
 * @param opts - Optional configuration.
 * @returns    An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * app.use(requestId());
 * app.use(logger()); // logger can now include req.id in output
 * app.get('/health', (req, res) => res.json({ id: req.id, status: 'ok' }));
 * ```
 */
export function requestId(opts?: RequestIdOptions): Middleware {
  const header         = (opts?.header ?? 'x-request-id').toLowerCase();
  const allowFromHeader = opts?.allowFromHeader !== false;
  const generator      = opts?.generator ?? (() => crypto.randomUUID());

  return (req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    const incoming = req.headers[header] as string | undefined;
    const id = (allowFromHeader && incoming) ? incoming : generator();

    req.id = id;
    res.setHeader(header, id);

    next();
  };
}

// ===========================================================================
// 3 · rateLimit — in-memory sliding-window rate limiter
// ===========================================================================

/**
 * Options for the {@link rateLimit} middleware.
 */
export interface RateLimitOptions {
  /**
   * Duration of the sliding time window in milliseconds.
   *
   * @example 60_000  // 1 minute window
   */
  windowMs: number;

  /**
   * Maximum number of requests allowed per client key within `windowMs`.
   * The (windowMs + 1)-th request receives a **429 Too Many Requests** response.
   */
  max: number;

  /**
   * Function that extracts a rate-limit key from the request.  All requests
   * sharing the same key count against the same bucket.
   *
   * @default (req) => req.ip   // one bucket per client IP
   */
  keyBy?: (req: RouterRequest) => string;

  /**
   * Plain-text body of the 429 response.
   *
   * @default 'Too Many Requests'
   */
  message?: string;

  /**
   * HTTP status code returned when the limit is exceeded.
   *
   * @default 429
   */
  statusCode?: number;

  /**
   * When `true`, set informational `X-RateLimit-*` headers on every response:
   * - `X-RateLimit-Limit`     — the configured `max`.
   * - `X-RateLimit-Remaining` — how many requests remain in the window.
   * - `X-RateLimit-Reset`     — Unix epoch (seconds) when the window resets.
   *
   * @default true
   */
  headers?: boolean;
}

/**
 * In-memory sliding-window rate limiting middleware.
 *
 * Uses a `Map<key, timestamp[]>` to track request timestamps per client.
 * On each request the list is pruned to the current window, then checked
 * against `max`.  No external dependencies are required.
 *
 * **Caveats:**
 * - State is held in memory and is lost on process restart.
 * - Not suitable for multi-process deployments without a shared store.
 *
 * @param opts - Rate-limit configuration.  `windowMs` and `max` are required.
 * @returns    An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * // Max 100 requests per minute per IP:
 * app.use(rateLimit({ windowMs: 60_000, max: 100 }));
 *
 * // Stricter limit on a specific route:
 * app.post('/auth/login', rateLimit({ windowMs: 60_000, max: 5 }), loginHandler);
 * ```
 */
export function rateLimit(opts: RateLimitOptions): Middleware {
  const windowMs   = opts.windowMs;
  const max        = opts.max;
  const keyBy      = opts.keyBy ?? ((req) => req.ip ?? '');
  const message    = opts.message    ?? 'Too Many Requests';
  const statusCode = opts.statusCode ?? 429;
  const sendHeaders = opts.headers !== false;

  // Map<clientKey, requestTimestamps[]>
  const store = new Map<string, number[]>();

  return (req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    const key = keyBy(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Prune expired timestamps for this key.
    const timestamps = (store.get(key) ?? []).filter((t) => t > windowStart);
    timestamps.push(now);
    store.set(key, timestamps);

    const count     = timestamps.length;
    const remaining = Math.max(0, max - count);
    // Reset = when the oldest request in the current window will fall out.
    const resetAt   = timestamps.length > 0
      ? Math.ceil((timestamps[0] + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    if (sendHeaders) {
      res.setHeader('X-RateLimit-Limit',     String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset',     String(resetAt));
    }

    if (count > max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.statusCode = statusCode;
      res.end(message);
      return;
    }

    next();
  };
}

// ===========================================================================
// 4 · cacheControl — response caching header middleware
// ===========================================================================

/**
 * Options for the {@link cacheControl} middleware.
 */
export interface CacheControlOptions {
  /**
   * Sets the `max-age` directive (seconds).  Browsers will serve the cached
   * response without hitting the server for this many seconds.
   */
  maxAge?: number;

  /**
   * Sets the `s-maxage` directive (seconds).  Overrides `max-age` for shared
   * caches such as CDNs.
   */
  sMaxAge?: number;

  /**
   * Adds the `private` directive — the response may only be cached by the
   * end-user's browser, not by a shared cache.
   */
  private?: boolean;

  /**
   * Adds the `public` directive — the response may be cached by any cache,
   * including shared CDN caches.
   */
  public?: boolean;

  /**
   * Adds `no-store` — the response must not be stored in any cache.
   */
  noStore?: boolean;

  /**
   * Adds `no-cache` — the cache must revalidate with the origin before
   * serving a stored response.
   */
  noCache?: boolean;

  /**
   * Adds `must-revalidate` — stale responses may not be served;
   * the cache must revalidate with the origin.
   */
  mustRevalidate?: boolean;

  /**
   * Adds `immutable` — indicates the response body will not change.
   * Ideal for content-addressed / fingerprinted assets.
   */
  immutable?: boolean;

  /**
   * Sets the `Vary` header to allow correct cache keying for negotiated
   * content.  Accepts a single string or an array of header names.
   *
   * @example ['Accept-Encoding', 'Accept-Language']
   */
  vary?: string | string[];
}

/**
 * Response caching header middleware.
 *
 * Sets `Cache-Control`, and optionally `Expires` and `Vary` response headers
 * based on the supplied options.  All directives are optional — only the
 * ones you specify are included in the header value.
 *
 * Mount at the router level for a global default, or on individual routes to
 * apply per-route caching policies.
 *
 * @param opts - Cache policy options.
 * @returns    An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * // Global: 5-minute browser cache, CDN-agnostic
 * app.use(cacheControl({ maxAge: 300, public: true }));
 *
 * // Per-route: content-addressed asset, cache forever
 * app.get('/static/app.:hash.js', cacheControl({ maxAge: 31_536_000, immutable: true }), serveStatic('public'));
 *
 * // No caching at all
 * app.use('/api', cacheControl({ noStore: true }));
 * ```
 */
export function cacheControl(opts: CacheControlOptions = {}): Middleware {
  // Pre-compute the Cache-Control value — it is the same for every response.
  const directives: string[] = [];

  if (opts.private)        directives.push('private');
  if (opts.public)         directives.push('public');
  if (opts.noStore)        directives.push('no-store');
  if (opts.noCache)        directives.push('no-cache');
  if (opts.mustRevalidate) directives.push('must-revalidate');
  if (opts.immutable)      directives.push('immutable');
  if (opts.maxAge  != null) directives.push(`max-age=${opts.maxAge}`);
  if (opts.sMaxAge != null) directives.push(`s-maxage=${opts.sMaxAge}`);

  const cacheControlValue = directives.join(', ');
  const varyValue = Array.isArray(opts.vary)
    ? opts.vary.join(', ')
    : (opts.vary ?? null);

  return (_req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    if (cacheControlValue) res.setHeader('Cache-Control', cacheControlValue);

    if (opts.maxAge != null) {
      const expires = new Date(Date.now() + opts.maxAge * 1000);
      res.setHeader('Expires', expires.toUTCString());
    }

    if (varyValue) res.setHeader('Vary', varyValue);

    next();
  };
}

// ===========================================================================
// 5 · csrf — CSRF protection middleware (double-submit cookie pattern)
// ===========================================================================

/**
 * Options for the {@link csrf} middleware.
 */
export interface CsrfOptions {
  /**
   * Name of the cookie that stores the CSRF token.
   *
   * @default '_csrf'
   */
  cookieName?: string;

  /**
   * Request header that the client must send the CSRF token in for
   * state-mutating requests.
   *
   * @default 'x-csrf-token'
   */
  headerName?: string;

  /**
   * Parsed request-body field name to check as an alternative to the header.
   * Only consulted when the header is absent.  Requires a body-parsing
   * middleware (e.g. `json()` or `parseBody()`) to run before `csrf()`.
   *
   * @default '_csrf'
   */
  fieldName?: string;

  /**
   * Mark the CSRF cookie as `Secure` (only sent over HTTPS).
   *
   * @default false
   */
  secure?: boolean;

  /**
   * `SameSite` attribute of the CSRF cookie.
   *
   * @default 'Strict'
   */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** HTTP methods that do not mutate server state and require no CSRF check. */
const SAFE_CSRF_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * CSRF protection middleware (double-submit cookie pattern).
 *
 * On every request the middleware:
 * 1. Reads (or generates) a random 256-bit hex token stored in a cookie.
 * 2. Attaches `req.csrfToken()` so handlers can embed the token in forms /
 *    single-page applications.
 * 3. For state-mutating requests (POST / PUT / PATCH / DELETE) it validates
 *    that the `X-CSRF-Token` header (or `_csrf` body field) matches the
 *    cookie value, responding **403** on mismatch.
 *
 * The cookie is **not** `HttpOnly` so that browser JavaScript can read the
 * value and include it in subsequent AJAX request headers.
 *
 * @param opts - Optional configuration.
 * @returns    An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * app.use(csrf());
 * app.get('/form', (req, res) =>
 *   res.send(`<input type="hidden" name="_csrf" value="${req.csrfToken!()}">`));
 * app.post('/submit', (req, res) => res.send('ok')); // validated automatically
 * ```
 */
export function csrf(opts?: CsrfOptions): Middleware {
  const cookieName = opts?.cookieName ?? '_csrf';
  const headerName = (opts?.headerName ?? 'x-csrf-token').toLowerCase();
  const fieldName  = opts?.fieldName  ?? '_csrf';
  const secure     = opts?.secure     ?? false;
  const sameSite   = opts?.sameSite   ?? 'Strict';

  return (req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    // Generate or reuse existing token from the incoming cookie.
    const existing = req.cookies?.[cookieName] as string | undefined;
    const token    = (typeof existing === 'string' && existing.length > 0)
      ? existing
      : crypto.randomBytes(32).toString('hex');

    // Refresh the cookie when we generated a new token.
    if (!existing) {
      let cookieStr = `${cookieName}=${token}; Path=/; SameSite=${sameSite}`;
      if (secure) cookieStr += '; Secure';
      // Append without clobbering other Set-Cookie headers.
      const prev = res.getHeader('Set-Cookie');
      if (prev == null)             res.setHeader('Set-Cookie', cookieStr);
      else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookieStr]);
      else                          res.setHeader('Set-Cookie', [prev as string, cookieStr]);
    }

    // Expose helper so handlers can embed the token in responses.
    req.csrfToken = () => token;

    // Safe methods skip validation entirely.
    if (SAFE_CSRF_METHODS.has(req.method ?? '')) return next();

    // Validate: prefer header, fall back to parsed body field.
    const submitted =
      (req.headers[headerName] as string | undefined) ??
      ((req.body as Record<string, string> | undefined)?.[fieldName]) ??
      '';

    if (!submitted || submitted !== token) {
      res.statusCode = 403;
      res.end('Forbidden: invalid CSRF token');
      return;
    }

    next();
  };
}

// ===========================================================================
// 6 · securityHeaders — security-hardening response headers
// ===========================================================================

/**
 * Options for the {@link securityHeaders} middleware.
 *
 * Every option defaults to a safe value.  Pass `false` to disable a specific
 * header, or an object/string to override the default value.
 */
export interface SecurityHeadersOptions {
  /**
   * `Strict-Transport-Security` — instructs browsers to always use HTTPS.
   *
   * Pass `false` to omit the header entirely (e.g. on plain HTTP servers).
   *
   * @default { maxAge: 15_552_000, includeSubDomains: true }
   *   (180 days, includes sub-domains)
   */
  hsts?: false | {
    /** Max age in seconds.  @default 15_552_000 (180 days) */
    maxAge?: number;
    /** Include `includeSubDomains` directive.  @default true */
    includeSubDomains?: boolean;
    /** Include `preload` directive.  @default false */
    preload?: boolean;
  };

  /**
   * `X-Frame-Options` — prevents the page from being embedded in a frame.
   *
   * Pass `false` to omit the header.
   *
   * @default 'SAMEORIGIN'
   */
  frameOptions?: false | 'DENY' | 'SAMEORIGIN';

  /**
   * `X-Content-Type-Options: nosniff` — prevents browsers from MIME-sniffing
   * the content type.
   *
   * Pass `false` to omit the header.
   *
   * @default true
   */
  contentTypeOptions?: boolean;

  /**
   * `Referrer-Policy` — controls how much referrer information is sent with
   * requests.
   *
   * Pass `false` to omit the header.
   *
   * @default 'strict-origin-when-cross-origin'
   */
  referrerPolicy?: false | string;

  /**
   * `Permissions-Policy` — restricts browser features available to the page.
   *
   * Pass `false` to omit the header.
   *
   * @default 'geolocation=(), microphone=(), camera=()'
   */
  permissionsPolicy?: false | string;

  /**
   * `X-XSS-Protection` — legacy IE header.  Modern browsers have built-in
   * XSS protection and this header should be set to `'0'` to disable the
   * old IE heuristic (which can actually introduce vulnerabilities).
   *
   * Pass `false` to omit the header entirely.
   *
   * @default '0'
   */
  xssProtection?: false | string;
}

/**
 * Security-hardening response headers middleware.
 *
 * Sets a sensible baseline of HTTP response headers that reduce the attack
 * surface for common web vulnerabilities (clickjacking, MIME sniffing, XSS,
 * etc.).  Every header can be individually disabled or overridden.
 *
 * Mount once at the top of the router so all responses are covered:
 *
 * ```ts
 * app.use(securityHeaders());
 * ```
 *
 * **Headers set by default:**
 *
 * | Header                    | Default value                              |
 * |---------------------------|--------------------------------------------|
 * | Strict-Transport-Security | max-age=15552000; includeSubDomains        |
 * | X-Frame-Options           | SAMEORIGIN                                 |
 * | X-Content-Type-Options    | nosniff                                    |
 * | Referrer-Policy           | strict-origin-when-cross-origin            |
 * | Permissions-Policy        | geolocation=(), microphone=(), camera=()   |
 * | X-XSS-Protection          | 0                                          |
 *
 * @param opts - Per-header overrides.  Omit to use all defaults.
 * @returns    An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * // Disable HSTS on a plain-HTTP development server:
 * app.use(securityHeaders({ hsts: false }));
 *
 * // Deny all framing (not just same-origin):
 * app.use(securityHeaders({ frameOptions: 'DENY' }));
 *
 * // Custom Permissions-Policy:
 * app.use(securityHeaders({
 *   permissionsPolicy: 'geolocation=(), payment=(self)',
 * }));
 * ```
 */
// ===========================================================================
// 7 · conditionalGet — RFC 7232 conditional GET / 304 Not Modified
// ===========================================================================

/**
 * Determine whether a cached response is still fresh according to RFC 7232.
 *
 * Evaluation priority:
 * 1. **`If-None-Match`** — compared against the `ETag` header using weak
 *    comparison (the `W/` prefix is stripped from both sides before matching).
 *    The wildcard `*` matches any ETag.
 * 2. **`If-Modified-Since`** — only consulted when `If-None-Match` is absent.
 *    The response is fresh when `Last-Modified ≤ If-Modified-Since`.
 *
 * Returns `false` when neither condition applies so the full response is sent.
 *
 * @param etag         - The current value of the `ETag` response header.
 * @param lastModified - The current value of the `Last-Modified` response header.
 * @param ifNoneMatch  - The `If-None-Match` request header value (or array).
 * @param ifModSince   - The `If-Modified-Since` request header value (or array).
 */
function isFreshResponse(
  etag:         string | undefined,
  lastModified: string | undefined,
  ifNoneMatch:  string | string[] | undefined,
  ifModSince:   string | string[] | undefined,
): boolean {
  const inm = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch;

  if (inm) {
    if (!etag) return false;
    // `*` is a wildcard that matches any entity-tag.
    if (inm.trim() === '*') return true;
    // Weak comparison: strip the W/ prefix before comparing quoted tag values.
    const normalize = (tag: string) => tag.startsWith('W/') ? tag.slice(2) : tag;
    const tags = inm.split(',').map((t) => normalize(t.trim()));
    return tags.includes(normalize(etag));
  }

  const ims = Array.isArray(ifModSince) ? ifModSince[0] : ifModSince;
  if (ims && lastModified) {
    const imsMs = new Date(ims).getTime();
    const lmMs  = new Date(lastModified).getTime();
    if (!isNaN(imsMs) && !isNaN(lmMs)) return lmMs <= imsMs;
  }

  return false;
}

/**
 * Conditional GET middleware (RFC 7232).
 *
 * Transparently handles `If-None-Match` and `If-Modified-Since` request
 * headers.  When the response carries an `ETag` or `Last-Modified` header and
 * the client's cached copy is still fresh, the middleware short-circuits with
 * **304 Not Modified** — stripping the response body and content-related
 * headers — instead of sending the full response.
 *
 * Mount this middleware **before** the route handler. The route handler runs
 * normally and can call `res.etag()` / `res.json()` / `res.send()` as usual;
 * the middleware intercepts the outgoing writes and decides whether to replace
 * the response with a 304.
 *
 * ```ts
 * app.get('/api/user/:id', conditionalGet(), (req, res) => {
 *   const user = getUser(req.params.id);
 *   res.etag(user.updatedAt.toISOString());
 *   res.json(user); // → 304 if ETag matches If-None-Match
 * });
 * ```
 *
 * **RFC 7232 compliance:**
 * - `If-None-Match` is evaluated first (takes priority over `If-Modified-Since`).
 * - Weak comparison is used for ETag matching (the `W/` prefix is ignored).
 * - 304 responses strip `Content-Type`, `Content-Length`, and
 *   `Content-Encoding`, but retain `ETag`, `Cache-Control`, `Vary`, and
 *   `Last-Modified`.
 * - Only GET and HEAD are eligible for 304 responses; other methods are
 *   passed through unchanged.
 *
 * @returns An Express-compatible middleware function.
 *
 * @example
 * ```ts
 * // With ETag
 * app.get('/resource', conditionalGet(), (req, res) => {
 *   res.etag('v1.0').json({ value: 42 });
 * });
 *
 * // With Last-Modified
 * app.get('/file', conditionalGet(), (req, res) => {
 *   res.setHeader('Last-Modified', new Date().toUTCString());
 *   res.send(fileContent);
 * });
 * ```
 */
export function conditionalGet(): Middleware {
  return (req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    // Only GET and HEAD can yield a 304 Not Modified.
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return next();

    const rawRes = res as unknown as http.ServerResponse;
    const origWrite = rawRes.write.bind(rawRes);
    const origEnd   = rawRes.end.bind(rawRes);

    // Buffer all outgoing body data until we can check freshness at end().
    const pending: Buffer[] = [];

    (res as any).write = (
      chunk: string | Buffer,
      encOrCb?: BufferEncoding | ((err?: Error | null) => void),
      _cb?: (err?: Error | null) => void,
    ): boolean => {
      const enc = typeof encOrCb === 'string' ? encOrCb : 'utf8';
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
      pending.push(buf);
      return true;
    };

    (res as any).end = (
      chunk?: string | Buffer | (() => void),
      encOrCb?: BufferEncoding | (() => void),
      _cb?: () => void,
    ): http.ServerResponse => {
      if (typeof chunk   === 'function') chunk   = undefined;
      if (typeof encOrCb === 'function') encOrCb = undefined;

      // Buffer any final chunk passed directly to end().
      if (chunk != null) {
        const enc = typeof encOrCb === 'string' ? encOrCb : 'utf8';
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
        pending.push(buf);
      }

      // Read the freshness-relevant headers set by the route handler.
      const etag        = rawRes.getHeader('etag')          as string | undefined;
      const lastMod     = rawRes.getHeader('last-modified') as string | undefined;
      const ifNoneMatch = req.headers['if-none-match'];
      const ifModSince  = req.headers['if-modified-since'];

      if (isFreshResponse(etag, lastMod, ifNoneMatch, ifModSince)) {
        // RFC 7232 §4.1: 304 response MUST NOT include a message body.
        // Strip content-related headers; retain ETag, Cache-Control, Vary, Last-Modified.
        rawRes.removeHeader('content-type');
        rawRes.removeHeader('content-length');
        rawRes.removeHeader('content-encoding');
        rawRes.statusCode = 304;
        origEnd();
      } else {
        // Not fresh — flush buffered body and end normally.
        for (const buf of pending) origWrite(buf);
        origEnd();
      }

      return rawRes;
    };

    next();
  };
}

export function securityHeaders(opts?: SecurityHeadersOptions): Middleware {
  // Pre-compute all header values once at middleware-creation time.
  const headers: [string, string][] = [];

  // Strict-Transport-Security
  const hsts = opts?.hsts;
  if (hsts !== false) {
    const h = typeof hsts === 'object' ? hsts : {};
    const maxAge   = h.maxAge           ?? 15_552_000;
    const subdomain = h.includeSubDomains !== false;
    let value = `max-age=${maxAge}`;
    if (subdomain)  value += '; includeSubDomains';
    if (h.preload)  value += '; preload';
    headers.push(['Strict-Transport-Security', value]);
  }

  // X-Frame-Options
  const fo = opts?.frameOptions;
  if (fo !== false) {
    headers.push(['X-Frame-Options', fo ?? 'SAMEORIGIN']);
  }

  // X-Content-Type-Options
  if (opts?.contentTypeOptions !== false) {
    headers.push(['X-Content-Type-Options', 'nosniff']);
  }

  // Referrer-Policy
  const rp = opts?.referrerPolicy;
  if (rp !== false) {
    headers.push(['Referrer-Policy', typeof rp === 'string' ? rp : 'strict-origin-when-cross-origin']);
  }

  // Permissions-Policy
  const pp = opts?.permissionsPolicy;
  if (pp !== false) {
    headers.push(['Permissions-Policy', typeof pp === 'string' ? pp : 'geolocation=(), microphone=(), camera=()']);
  }

  // X-XSS-Protection
  const xxp = opts?.xssProtection;
  if (xxp !== false) {
    headers.push(['X-XSS-Protection', typeof xxp === 'string' ? xxp : '0']);
  }

  return (_req: RouterRequest, res: RouterResponse, next: NextFunction): void => {
    for (const [name, value] of headers) res.setHeader(name, value);
    next();
  };
}
