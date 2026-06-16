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

import fs from 'fs';
import nodePath from 'path';

import type { RouterRequest, RouterResponse, Middleware } from './router.js';
import mimetypesJson from './mimetypes.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Mimetypes
// ---------------------------------------------------------------------------
export type Mime = {
  lookup: (path: string, fallback: string | null) => string,
  charsets: (mimeType: string) => string | null,
}

const mime_types = new Map<string, string>();
const mime_extensions = new Map<string, string>();
function mime_define(map:string[][]): void {
  for (var type in map) {
    var exts = map[type]!;
    for (var i = 0; i < exts.length; i++)
      mime_types.set(exts[i], type);
    if (!mime_extensions.has(type))
      mime_extensions.set(type, exts[0]);
  }
};

export const mime: Mime = {
  lookup: (path: string, fallback: string | null = null): string => mime_types.get(path.replace(/^.*[\.\/\\]/, '').toLowerCase()) ?? fallback ?? 'application/octet-stream',
  charsets: (mimeType: string): string | null => (/^text\/|^application\/(javascript|json)/).test(mimeType) ? 'UTF-8' : null,
};

mime_define(mimetypesJson as unknown as string[][]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HTTP header map used both in options and as argument to res.status(). */
type HeaderMap = Record<string, string>;

/**
 * Options accepted by {@link serveStatic}, {@link serveFile}, and
 * {@link sendFile}.
 */
export interface StaticOptions {
  /**
   * Extra HTTP headers added to every response (merged with the built-in
   * security headers `Content-Security-Policy` and `X-Content-Type-Options`).
   */
  headers?: HeaderMap;
  /**
   * When `true`, unhandled requests (wrong method, missing file) are passed
   * to the next middleware via `next()` instead of sending an error response.
   * Defaults to `false`.
   */
  fallthrough?: boolean;
  /**
   * Browser cache lifetime for served files, in **milliseconds**.
   * Translated to a `Cache-Control: public, max-age=<seconds>` header.
   * Defaults to `0` (no caching).
   */
  maxage?: number;
  /** Alias for {@link maxage}. */
  maxAge?: number;
  /**
   * When `true`, appends `, immutable` to the `Cache-Control` header,
   * signalling that the response will never change during its `max-age`
   * window. Only meaningful when {@link maxage} is non-zero.
   */
  immutable?: boolean;
  /**
   * When `true` (default), the server generates and sends a weak `ETag`
   * header based on the file's size and last-modification time.
   */
  etag?: boolean;
  /**
   * When `true` (default), the server sends a `Last-Modified` header
   * derived from the file's `mtime`.
   */
  lastModified?: boolean;
  /**
   * Override the auto-detected `Content-Type`.  When set, MIME detection via
   * the `mime` package is skipped entirely.
   */
  contentType?: string | null;
  /**
   * Controls how dot-files (files or directories whose name starts with `.`)
   * are handled:
   * - `'allow'`  — serve them like any other file.
   * - `'deny'`   — respond with 403 Forbidden.
   * - `'hide'`   — respond with 404 Not Found (default).
   */
  dotfiles?: 'allow' | 'deny' | 'hide';
  /**
   * When `true` (default), a request for a directory path is transparently
   * redirected to `index.html` inside that directory.
   * When `false`, directory requests receive a 404 response.
   */
  redirect?: boolean;
  /**
   * When `true`, a request for a directory path that has no `index.html`
   * renders an Apache-style directory listing.
   * Defaults to `false`.
   */
  indexOf?: boolean;
}

/**
 * Fully resolved options used internally after merging caller-supplied values
 * with {@link DEFAULT_OPTIONS}. All optional fields from {@link StaticOptions}
 * are guaranteed to be present.
 */
interface ResolvedOptions extends Required<Omit<StaticOptions, 'maxAge'>> {
  /** Absolute, normalised path to the root directory or file. */
  root: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regular expression that detects a directory-traversal component (`..`) in
 * any position of a URL path, including encoded forms using back-slashes.
 */
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Regular expression that detects any ASCII control character (code point
 * below 32, including the NUL byte). These characters cannot appear in a valid
 * file name and would make fs.stat() throw, so paths containing them are
 * treated as not found.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEXP = /[\x00-\x1f]/;

/** Default security and caching options applied to every response. */
const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'root'> = {
  headers: {
    'Content-Security-Policy': "default-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  },
  fallthrough: false,
  maxage: 0,
  immutable: false,
  etag: true,
  lastModified: true,
  contentType: null,
  dotfiles: 'hide',
  redirect: true,
  indexOf: false,
};

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

/**
 * Collection of pre-built HTTP error/success response helpers.
 * Each helper sets the appropriate status code, merges the caller's custom
 * headers, and terminates the response.
 */
const HTTP = {
  /** 304 Not Modified — sent for conditional GET cache hits. */
  NOT_MODIFIED:       (res: RouterResponse, opts: ResolvedOptions) =>
    { res.status(304, opts.headers).end() },
  /** 400 Bad Request — sent when the URL path contains malformed percent-encoding. */
  BAD_REQUEST:        (res: RouterResponse, opts: ResolvedOptions) =>
    res.status(400, opts.headers).send('Bad Request'),
  /** 403 Forbidden — sent for denied dot-files or path traversal attempts. */
  FORBIDDEN:          (res: RouterResponse, opts: ResolvedOptions) =>
    res.status(403, opts.headers).send('Forbidden'),
  /** 404 Not Found — sent when the requested file does not exist. */
  NOT_FOUND:          (res: RouterResponse, opts: ResolvedOptions) =>
    res.status(404, opts.headers).send('Not Found'),
  /**
   * 405 Method Not Allowed — sent when the HTTP method is neither GET nor
   * HEAD and {@link ResolvedOptions.fallthrough} is `false`.
   * Always includes an `Allow: GET, HEAD` header per RFC 7231 §6.5.5.
   */
  NOT_ALLOWED:        (res: RouterResponse, opts: ResolvedOptions) =>
    { res.status(405, { ...opts.headers, Allow: 'GET, HEAD' }).end() },
  /** 412 Precondition Failed — sent when `If-Match` / `If-Unmodified-Since` fails. */
  PRECONDITION_FAILS: (res: RouterResponse, opts: ResolvedOptions) =>
    res.status(412, opts.headers).send('Precondition Failed'),
  /** 500 Internal Server Error — sent on unexpected filesystem or stream errors. */
  INTERNAL_ERROR:     (res: RouterResponse, opts: ResolvedOptions, err: string) =>
    res.status(500, opts.headers).send(`Internal error: ${err}`),
} as const;

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Safely destroy a `fs.ReadStream`, working around a Node.js core bug where
 * streams that have not yet emitted `'open'` do not close their file
 * descriptor when `destroy()` is called.
 *
 * @param stream - The readable stream to destroy.
 */
function destroyReadStream(stream: fs.ReadStream): void {
  stream.destroy();
  if (typeof (stream as any).close === 'function') {
    // Node.js core bug work-around: if the stream has not yet opened the file,
    // `destroy()` will not close the fd. Listening for 'open' ensures we close
    // it as soon as the fd becomes available.
    stream.on('open', () => {
      if (typeof (stream as any).fd === 'number')
        (stream as any).close();
    });
  }
}

/**
 * Remove all `Content-*` headers from the response, **except**
 * `Content-Location`.
 *
 * Called before sending a 304 Not Modified response, as RFC 7232 §4.1
 * requires that the response body and most content metadata headers be
 * omitted in that case.
 *
 * @param res - The server response whose headers will be mutated.
 */
function removeContentHeaders(res: RouterResponse): void {
  const keys = Object.keys(res.getHeaders() ?? {});
  for (const key of keys) {
    if (key.startsWith('content-') && key !== 'content-location')
      res.removeHeader(key);
  }
}

/**
 * Build a weak ETag string from a file's `stat` metadata.
 *
 * The format is `W/"<size_hex>-<mtime_hex>"`, matching the convention used by
 * Node's `serve-static` and compatible with all major HTTP clients.
 *
 * @param stat - The `fs.Stats` object for the file.
 * @returns A weak ETag string.
 */
function createETag(stat: fs.Stats): string {
  const mtime = stat.mtime.getTime().toString(16);
  const size  = stat.size.toString(16);
  return `W/"${size}-${mtime}"`;
}

/**
 * Parse a comma-separated HTTP token list (e.g. the value of an `ETag` or
 * `Accept` header) into an array of trimmed token strings.
 *
 * Follows the token-list grammar from RFC 7230 §3.2.6: tokens are separated
 * by commas, leading/trailing spaces around each token are ignored.
 *
 * @param str - The raw header value string.
 * @returns An array of individual token strings (may be empty).
 */
function parseTokenList(str: string): string[] {
  const list: string[] = [];
  let start = 0;
  let end   = 0;

  for (let i = 0, len = str.length; i < len; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 0x20 /* space */) {
      if (start === end) start = end = i + 1;
    } else if (ch === 0x2c /* comma */) {
      list.push(str.substring(start, end));
      start = end = i + 1;
    } else {
      end = i + 1;
    }
  }

  // Push the final token (there is always at least one).
  list.push(str.substring(start, end));
  return list;
}

/**
 * Parse an HTTP-date string (e.g. `Thu, 01 Jan 1970 00:00:00 GMT`) into a
 * Unix timestamp in milliseconds.
 *
 * @param date - The raw date string from an HTTP header.
 * @returns A numeric timestamp, or `NaN` if parsing fails.
 */
function parseHttpDate(date: string | undefined): number {
  const timestamp = date ? Date.parse(date) : NaN;
  return typeof timestamp === 'number' ? timestamp : NaN;
}

/**
 * Escape HTML special characters so that a raw string can be safely embedded
 * in HTML text content or attribute values.
 *
 * Handles `&`, `<`, `>`, and `"`.  Single quotes are not escaped because all
 * generated attributes use double-quote delimiters.
 *
 * @param str - The raw string to escape.
 * @returns A string safe for insertion into HTML.
 */
function htmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Percent-encode each segment of a URL path while preserving the `/`
 * separators, so that the result is safe to use as an `href` attribute value.
 *
 * Each segment is passed through {@link encodeURIComponent}, which encodes
 * all characters except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.  The `/` delimiters
 * between segments are kept as literal slashes.
 *
 * @param urlPath - A decoded URL path, e.g. `'/dir with spaces/readme.txt'`.
 * @returns A percent-encoded path, e.g. `'/dir%20with%20spaces/readme.txt'`.
 */
function encodePath(urlPath: string): string {
  return urlPath.split('/').map(s => encodeURIComponent(s)).join('/');
}

/**
 * Return `true` when the request carries at least one conditional header
 * (`If-Match`, `If-Unmodified-Since`, `If-None-Match`, or
 * `If-Modified-Since`).
 *
 * @param headers - The incoming request's header map.
 */
function hasCondition(headers: Record<string, string | string[] | undefined>): boolean {
  return !!(
    headers['if-match'] ||
    headers['if-unmodified-since'] ||
    headers['if-none-match'] ||
    headers['if-modified-since']
  );
}

/**
 * Evaluate precondition headers (`If-Match` / `If-Unmodified-Since`) against
 * the current response headers and return whether the precondition is
 * satisfied.
 *
 * Used to decide whether to proceed with the response (`true`) or send
 * 412 Precondition Failed (`false`).
 *
 * Implements the subset defined in RFC 7232 §6 (step 3 and step 5):
 * - **`If-Match`** — matches when the response ETag equals the request ETag,
 *   or when the request value is `*`.
 * - **`If-Unmodified-Since`** — matches when the file has not been modified
 *   since the given date.
 *
 * @param reqHeaders - Normalised (lowercase) request headers.
 * @param resHeaders - Current response headers (as returned by
 *                     `res.getHeaders()`).
 * @returns `true` if the precondition is satisfied.
 */
function conditionMatch(
  reqHeaders: Record<string, string | string[] | undefined>,
  resHeaders: Record<string, number | string | string[] | undefined>,
): boolean {
  // --- If-Match ---
  const match = reqHeaders['if-match'] as string | undefined;
  if (match) {
    const etag = resHeaders['etag'] as string | undefined;
    if (match === '*' || match === etag) return true;
    for (const tag of parseTokenList(match)) {
      if (tag === etag || `W/${tag}` === etag || tag === `W/${etag}`)
        return true;
    }
    // If-Match was present but none of the tags matched → precondition failed.
    return false;
  }

  // --- If-Unmodified-Since ---
  const lastModified   = parseHttpDate(resHeaders['last-modified'] as string | undefined);
  const unmodifiedSince = parseHttpDate(reqHeaders['if-unmodified-since'] as string | undefined);
  if (!isNaN(unmodifiedSince) && !isNaN(lastModified))
    return lastModified <= unmodifiedSince;

  return false;
}

/**
 * Determine whether a cached response is still fresh by evaluating the
 * `If-None-Match` and `If-Modified-Since` conditional headers.
 *
 * Returns `true` only when the response can safely be replaced by a
 * 304 Not Modified. Returns `false` (stale) when:
 * - No conditional header is present (unconditional request).
 * - `Cache-Control: no-cache` is set.
 * - The ETag or modification time no longer matches.
 *
 * Implements RFC 7232 §6 (steps 4 and 5) and RFC 7234 §5.2.
 *
 * @param reqHeaders - Normalised (lowercase) request headers.
 * @param resHeaders - Current response headers.
 * @returns `true` if the cached response is fresh and a 304 should be sent.
 */
function isCacheFresh(
  reqHeaders: Record<string, string | string[] | undefined>,
  resHeaders: Record<string, number | string | string[] | undefined>,
): boolean {
  const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

  const modifiedSince = reqHeaders['if-modified-since'] as string | undefined;
  const noneMatch     = reqHeaders['if-none-match']     as string | undefined;

  // Unconditional request — always treat as stale.
  if (!modifiedSince && !noneMatch) return false;

  // Explicit no-cache directive forces revalidation even if ETags match.
  const cacheControl = reqHeaders['cache-control'] as string | undefined;
  if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl))
    return false;

  // --- If-None-Match ---
  if (noneMatch && noneMatch !== '*') {
    const etag = resHeaders['etag'] as string | undefined;
    if (!etag) return false;

    let etagStale = true;
    for (const match of parseTokenList(noneMatch)) {
      if (match === etag || `W/${match}` === etag || match === `W/${etag}`) {
        etagStale = false;
        break;
      }
    }
    if (etagStale) return false;
  }

  // --- If-Modified-Since ---
  if (modifiedSince) {
    const lastModified = resHeaders['last-modified'] as string | undefined;
    if (!lastModified) return false;
    if (!(parseHttpDate(lastModified) <= parseHttpDate(modifiedSince)))
      return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Options resolution
// ---------------------------------------------------------------------------

/**
 * Validate and resolve the `root` path and caller-supplied `options` into a
 * fully populated {@link ResolvedOptions} object.
 *
 * Applies the following normalisation steps:
 * - `root` is resolved to an absolute path via `path.resolve()`.
 * - `fallthrough` and `redirect` default to `false` only when explicitly set
 *   to `false`; any other value (including `undefined`) is treated as `true`.
 * - `maxage` falls back to `maxAge` (camelCase alias) and then to `0`.
 *
 * @param root    - The root directory or file path to serve from.
 * @param options - Caller-supplied options (partial, merged with defaults).
 * @returns A fully resolved options object.
 * @throws {TypeError} When `root` is falsy or not a string.
 */
function resolveOptions(root: string, options?: StaticOptions): ResolvedOptions {
  if (!root)
    throw new TypeError('root path required');
  if (typeof root !== 'string')
    throw new TypeError('root path must be a string');

  // Deep-merge headers so caller-supplied headers *extend* the defaults
  // rather than replacing them entirely.
  const mergedHeaders = { ...DEFAULT_OPTIONS.headers, ...(options?.headers ?? {}) };
  const opts = { ...DEFAULT_OPTIONS, ...options, headers: mergedHeaders } as ResolvedOptions;
  opts.fallthrough = options?.fallthrough !== false;
  opts.redirect    = options?.redirect    !== false;
  opts.maxage      = options?.maxage ?? options?.maxAge ?? 0;
  opts.root        = nodePath.resolve(root);
  return opts;
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

/**
 * Callback signature used by {@link writeIndexOf}.
 *
 * On success, `html` contains the rendered HTML page and `err` is `null`.
 * On failure, `html` is `null` and `err` carries the filesystem error.
 */
type IndexCallback = (html: string | null, err: NodeJS.ErrnoException | null) => void;

/**
 * Asynchronously render an Apache-style directory-listing HTML page for the
 * given directory and invoke `callback` with the result.
 *
 * The generated page lists every entry in `directoryPath`, with icons, names,
 * last-modification timestamps, and file sizes. An optional parent-directory
 * link is shown when `parentUrlPath` is provided.
 *
 * **Default order:** directories before files; within each group, entries are
 * sorted alphabetically by name (ascending).
 *
 * **Query-parameter sorting** (`?C=<col>;O=<ord>` — `;` or `&` separator):
 * - `C=N` — sort by name (default)
 * - `C=M` — sort by last-modification time
 * - `C=S` — sort by size (directories always count as 0)
 * - Any other value for `C` → falls back to name order
 * - `O=A` — ascending (default)
 * - `O=D` — descending
 *
 * Column header links are generated dynamically: clicking the **active** column
 * toggles the order; clicking any **other** column resets to ascending.
 *
 * @param urlPath       - The URL path displayed in the page title and heading.
 * @param directoryPath - Absolute filesystem path of the directory to list.
 * @param parentUrlPath - URL of the parent directory, or `null` when at root.
 * @param queryString   - Raw query string from the request URL (without `?`).
 * @param callback      - Called with `(html, null)` on success or
 *                        `(null, err)` on failure.
 */
function writeIndexOf(
  urlPath:       string,
  directoryPath: string,
  parentUrlPath: string | null,
  queryString:   string,
  callback:      IndexCallback,
): void {
  fs.readdir(directoryPath, (err, files) => {
    if (err) return callback(null, err);

    // ── Parse sort parameters ────────────────────────────────────────────────
    // Support both ';' and '&' as separators (Apache style uses ';').
    const params  = new URLSearchParams(queryString.replace(/;/g, '&'));
    const rawCol  = params.get('C') ?? 'N';
    const rawOrd  = params.get('O') ?? 'A';
    const col     = ['N', 'M', 'S'].includes(rawCol) ? rawCol : 'N';
    const ord     = rawOrd === 'D' ? 'D' : 'A';

    // ── Collect entries with stats ───────────────────────────────────────────
    interface Entry {
      file:  string;
      stat:  fs.Stats;
      isDir: boolean;
    }

    const entries: Entry[] = [];
    for (const file of files) {
      const fullPath = nodePath.join(directoryPath, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue; // skip entries that disappeared between readdir and stat
      }
      entries.push({ file, stat, isDir: stat.isDirectory() });
    }

    // ── Sort ─────────────────────────────────────────────────────────────────
    // Directories always come before files. Within each group apply col/ord.
    const sign = ord === 'A' ? 1 : -1;
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (col === 'N')      cmp = a.file.localeCompare(b.file);
      else if (col === 'M') cmp = a.stat.mtime.getTime() - b.stat.mtime.getTime();
      else if (col === 'S') cmp = (a.isDir ? 0 : a.stat.size) - (b.isDir ? 0 : b.stat.size);
      return cmp * sign;
    });

    // ── Dynamic column header link ───────────────────────────────────────────
    // Active column: toggles order. Inactive column: always links to ascending.
    function thLink(c: string, label: string): string {
      const nextOrd = (c === col && ord === 'A') ? 'D' : 'A';
      return `<a href="?C=${c};O=${nextOrd}">${label}</a>`;
    }

    // ── Build HTML ───────────────────────────────────────────────────────────
    // urlPath comes from req.path (user-controlled) and file names come from
    // the filesystem — both must be escaped before insertion into HTML.
    let html = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n';
    html += '<html>\n';
    html += `<head><title>Index of ${htmlEscape(urlPath)}</title></head>\n`;
    html += `<body><h1>Index of ${htmlEscape(urlPath)}</h1><table>\n`;
    html += '<tr>'
      + '<th valign="top"><img src="/icons/blank.gif" alt="[ICO]"></th>'
      + `<th>${thLink('N', 'Name')}</th>`
      + `<th>${thLink('M', 'Last modified')}</th>`
      + `<th>${thLink('S', 'Size')}</th>`
      + '<th><a href="?C=D;O=A">Description</a></th>'
      + '</tr>\n';
    html += '<tr><th colspan="5"><hr></th></tr>\n';

    if (parentUrlPath)
      html += `<tr>`
        + `<td valign="top"><img src="/icons/back.gif" alt="[PARENTDIR]"></td>`
        + `<td><a href="${encodePath(parentUrlPath)}">Parent Directory</a></td>`
        + `<td>&nbsp;</td><td align="right">  - </td><td>&nbsp;</td>`
        + `</tr>\n`;

    for (const { file, stat, isDir } of entries) {
      const fullPath   = nodePath.join(directoryPath, file);
      const mimeType   = mime.lookup(fullPath, '');
      const mediaType  = mimeType.includes('/') ? mimeType.split('/')[0] : '';
      const alt        = isDir ? 'folder' : (mediaType || 'unknown');
      const icon       = `/icons/${alt}.gif`;
      const name       = file + (isDir ? '/' : '');
      // href uses percent-encoding (safe for URL context); display text uses
      // HTML-escaping (safe for HTML text content).
      const hrefName   = encodeURIComponent(file) + (isDir ? '/' : '');
      const displayName = htmlEscape(name);
      const modified   = stat.mtime.toUTCString();
      const size       = isDir ? '-' : String(stat.size);

      html += `<tr>`
        + `<td valign="top"><img src="${icon}" alt="[${alt.toUpperCase()}]"></td>`
        + `<td><a href="${hrefName}">${displayName}</a></td>`
        + `<td align="right">${modified}</td>`
        + `<td align="right">${size}</td>`
        + `<td>&nbsp;</td>`
        + `</tr>\n`;
    }

    html += '<tr><th colspan="5"><hr></th></tr>\n';
    html += '</table><address>Expediate/1.0.0</address></body></html>\n';

    return callback(html, null);
  });
}

// ---------------------------------------------------------------------------
// Core send logic
// ---------------------------------------------------------------------------

/**
 * Set response headers and stream a file to the client.
 *
 * This is the inner send function shared by {@link sendFile} and the
 * {@link serveStatic} middleware. It handles:
 * - Custom and security headers from `opts`.
 * - `Cache-Control` with optional `immutable` directive.
 * - `Last-Modified` and `ETag` generation.
 * - MIME-type detection via the `mime` package.
 * - Conditional GET evaluation (`If-None-Match`, `If-Modified-Since`).
 * - `HEAD` requests (headers sent, no body).
 * - Streaming the file body with proper error handling and stream cleanup.
 *
 * @param req      - The incoming router request.
 * @param res      - The outgoing router response.
 * @param pathname - Absolute filesystem path of the file to send.
 * @param stat     - Pre-fetched `fs.Stats` for `pathname`.
 * @param opts     - Fully resolved static-serving options.
 */
function sendIt(
  req:      RouterRequest,
  res:      RouterResponse,
  pathname: string,
  stat:     fs.Stats,
  opts:     ResolvedOptions,
): void {
  const len  = stat.size;
  const etag = createETag(stat);

  // Apply caller-supplied headers first so they can be overridden by the
  // cache/content headers below if necessary.
  if (opts.headers) {
    for (const [key, value] of Object.entries(opts.headers))
      res.setHeader(key, value);
  }

  // Cache-Control
  if (!res.getHeader('Cache-Control') && opts.maxage) {
    let cacheControl = `public, max-age=${Math.floor(opts.maxage / 1000)}`;
    if (opts.immutable) cacheControl += ', immutable';
    res.setHeader('Cache-Control', cacheControl);
  }

  // Last-Modified
  if (!res.getHeader('Last-Modified') && opts.lastModified !== false)
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

  // ETag
  if (!res.getHeader('ETag') && opts.etag !== false)
    res.setHeader('ETag', etag);

  // Content-Type
  if (!res.getHeader('Content-Type')) {
    if (opts.contentType) {
      res.setHeader('Content-Type', opts.contentType);
    } else {
      const type = mime.lookup(pathname, '');
      if (type) {
        const charset = mime.charsets(type);
        res.setHeader('Content-Type', charset ? `${type}; charset=${charset}` : type);
      }
    }
  }

  // Conditional GET — two independent RFC 7232 mechanisms evaluated in order.

  // 1. Cache-validation headers (If-None-Match / If-Modified-Since).
  //    When the cached response is still fresh, respond with 304 Not Modified.
  //    This must be tested BEFORE the precondition headers so that a browser
  //    performing a normal ETag revalidation is not incorrectly rejected.
  if (isCacheFresh(
    req.headers as Record<string, string | undefined>,
    res.getHeaders(),
  )) {
    removeContentHeaders(res);
    HTTP.NOT_MODIFIED(res, opts); return;
  }

  // 2. Precondition headers (If-Match / If-Unmodified-Since).
  //    Only evaluate when these specific headers are present; If-None-Match and
  //    If-Modified-Since are handled above by isCacheFresh and must NOT trigger
  //    a 412 when conditionMatch returns false (they are cache-validation headers,
  //    not write-precondition headers per RFC 7232).
  const hasPrecondition = !!(
    (req.headers as Record<string, string | undefined>)['if-match'] ||
    (req.headers as Record<string, string | undefined>)['if-unmodified-since']
  );
  if (hasPrecondition && !conditionMatch(
    req.headers as Record<string, string | undefined>,
    res.getHeaders(),
  )) {
    HTTP.PRECONDITION_FAILS(res, opts); return;
  }

  // --- Send the body ---

  res.setHeader('Content-Length', len);

  // HEAD requests: headers only, no body.
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let finished = false;
  const stream = fs.createReadStream(pathname);

  res.on('finish', () => {
    finished = true;
    destroyReadStream(stream);
  });

  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (finished) return;
    console.warn('static stream error:', pathname, err);
    HTTP.INTERNAL_ERROR(res, opts, err.code ?? 'UNKNOWN');
    finished = true;
    destroyReadStream(stream);
  });

  stream.on('end', () => res.end());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a single file from the filesystem as an HTTP response.
 *
 * Unlike the {@link serveStatic} middleware, this function resolves the
 * response for a **specific** `pathname` that has already been determined by
 * the caller. It is useful for custom routing logic where the file path is
 * computed dynamically.
 *
 * Behaviour:
 * - When `pathname` refers to a **regular file**, it is served via
 *   {@link sendIt} (including ETag, Last-Modified, conditional GET, and
 *   MIME-type detection).
 * - When `pathname` refers to a **directory** and `opts.indexOf` is `true`,
 *   an Apache-style directory listing is rendered.
 * - Otherwise, a 404 Not Found response is sent.
 *
 * @param req      - The incoming router request.
 * @param res      - The outgoing router response.
 * @param pathname - Absolute filesystem path of the file to send.
 * @param opts     - Fully resolved static-serving options.
 */
export function sendFile(
  req:      RouterRequest,
  res:      RouterResponse,
  pathname: string,
  opts:     ResolvedOptions,
): void {
  fs.stat(pathname, (err, stat) => {
    if (err) {
      if (
        err.code === 'ENOENT' ||
        err.code === 'ENAMETOOLONG' ||
        err.code === 'ENOTDIR'
      ) return HTTP.NOT_FOUND(res, opts);
      return HTTP.INTERNAL_ERROR(res, opts, err.code ?? 'UNKNOWN');
    }

    if (stat.isDirectory()) {
      if (opts.indexOf) {
        const parentUrl   = req.path !== '/' ? nodePath.dirname(req.path) : null;
        const queryString = (req.url ?? '').split('?')[1] ?? '';
        return writeIndexOf(req.path, pathname, parentUrl, queryString, (html, indexErr) => {
          if (indexErr)
            return HTTP.INTERNAL_ERROR(res, opts, indexErr.code ?? 'UNKNOWN');
          return res.status(200, opts.headers).send(html!);
        });
      }
      // Directory listing is disabled — treat as not found.
      return HTTP.NOT_FOUND(res, opts);
    }

    sendIt(req, res, pathname, stat, opts);
  });
}

/**
 * Middleware factory that serves files from a directory on the filesystem.
 *
 * Mount this middleware with a path prefix to expose a public directory:
 * ```ts
 * app.use('/public', serveStatic('./dist'));
 * ```
 *
 * Features:
 * - **Method filtering** — only `GET` and `HEAD` are served; other methods
 *   receive 405 Method Not Allowed (or are forwarded to `next()` when
 *   `fallthrough` is `true`).
 * - **Directory traversal protection** — any path containing `..` is
 *   rejected with 403 Forbidden.
 * - **Dot-file handling** — configurable via the `dotfiles` option
 *   (`'allow'`, `'deny'`, or `'hide'`).
 * - **Directory redirect** — a path resolving to a directory is automatically
 *   redirected to its `index.html` when `redirect` is `true`.
 * - **Conditional GET** — ETag and Last-Modified headers enable browser and
 *   proxy caching with proper revalidation.
 * - **Cache-Control** — configurable via `maxage` / `immutable` options.
 * - **MIME-type detection** — via the `mime` npm package.
 *
 * @param root    - Path to the directory containing the files to serve.
 *                  Resolved to an absolute path internally.
 * @param options - Optional configuration (see {@link StaticOptions}).
 * @returns An Express-compatible middleware function.
 * @throws {TypeError} When `root` is missing or not a string.
 */
export function serveStatic(root: string, options?: StaticOptions): Middleware {
  const opts = resolveOptions(root, options);

  return function (req: RouterRequest, res: RouterResponse, next: () => void): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (opts.fallthrough)
        return next();
      return HTTP.NOT_ALLOWED(res, opts);
    }

    // Decode the current path (after any prefix stripping by parent routers).
    // Malformed percent-sequences (e.g. %zz, trailing %) are rejected immediately
    // because they cannot represent a valid file path and may indicate an attack.
    let originalUrl: string;
    try {
      originalUrl = decodeURIComponent(req.path ?? req.url ?? '/');
    } catch {
      return HTTP.BAD_REQUEST(res, opts);
    }
    let pathname = originalUrl;

    // When the URL ends without a trailing slash but the bare mount point was
    // requested, clear the pathname so the root directory is considered.
    if (pathname === '/' && !originalUrl.endsWith('/'))
      pathname = '';

    // Reject any path containing a control character (code point < 32), most
    // notably the NUL byte. Such characters can never appear in a legitimate
    // file name and would otherwise cause fs.stat() to throw synchronously
    // (TypeError: path must be a string without null bytes), surfacing as a 500.
    if (CONTROL_CHAR_REGEXP.test(pathname)) {
      if (opts.fallthrough)
        return next();
      return HTTP.NOT_FOUND(res, opts);
    }

    // Reject any path containing a directory-traversal component.
    if (UP_PATH_REGEXP.test(pathname))
      return HTTP.FORBIDDEN(res, opts);

    // Resolve to an absolute filesystem path.
    pathname = nodePath.resolve(nodePath.normalize(`${opts.root}/${pathname}`));

    // Defense-in-depth: verify the resolved path remains inside opts.root.
    // This catches edge cases that bypass UP_PATH_REGEXP — e.g. OS-level
    // symlinks, or unusual Unicode normalisation on certain file systems.
    if (pathname !== opts.root && !pathname.startsWith(opts.root + nodePath.sep))
      return HTTP.FORBIDDEN(res, opts);

    // Dot-file handling.
    if (opts.dotfiles !== 'allow' && pathname.includes('/.')) {
      if (opts.dotfiles === 'deny')
        return HTTP.FORBIDDEN(res, opts);
      return HTTP.NOT_FOUND(res, opts);
    }

    fs.stat(pathname, (err, stat) => {
      if (err) {
        if (
          err.code === 'ENOENT' ||
          err.code === 'ENAMETOOLONG' ||
          err.code === 'ENOTDIR'
        ) {
          if (opts.fallthrough)
            return next();
          return HTTP.NOT_FOUND(res, opts);
        }
        return HTTP.INTERNAL_ERROR(res, opts, err.code ?? 'UNKNOWN');
      }

      // When the resolved path is a directory, redirect to its index.html.
      if (stat.isDirectory()) {
        if (!opts.redirect) {
          if (opts.fallthrough)
            return next();
          return HTTP.NOT_FOUND(res, opts);
        }
        return sendFile(req, res, nodePath.join(pathname, 'index.html'), opts);
      }

      sendIt(req, res, pathname, stat, opts);
    });
  };
}

/**
 * Middleware factory that serves a **single, fixed file** as the response to
 * every request, regardless of the request path.
 *
 * Use this when you want every route to return the same file — for example,
 * serving a compiled single-page application's `index.html` as a catch-all:
 * ```ts
 * app.get('/**', serveFile('./dist/index.html'));
 * ```
 *
 * Features:
 * - **Method filtering** — only `GET` and `HEAD` are served.
 * - **Conditional GET** — ETag and Last-Modified are generated from the file
 *   metadata on every request.
 * - **MIME-type detection** — via the `mime` npm package.
 *
 * @param filePath - Path to the file to serve. Resolved to an absolute path.
 * @param options  - Optional configuration (see {@link StaticOptions}).
 * @returns An Express-compatible middleware function.
 * @throws {TypeError} When `filePath` is missing or not a string.
 */
export function serveFile(filePath: string, options?: StaticOptions): Middleware {
  const opts = resolveOptions(filePath, options);

  return function (req: RouterRequest, res: RouterResponse, next: () => void): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (opts.fallthrough)
        return next();
      return HTTP.NOT_ALLOWED(res, opts);
    }

    const pathname = opts.root;
    fs.stat(pathname, (err, stat) => {
      if (err)
        return HTTP.INTERNAL_ERROR(res, opts, err.code ?? 'UNKNOWN');

      if (stat.isDirectory())
        return HTTP.INTERNAL_ERROR(res, opts, 'EISDIR');

      sendIt(req, res, pathname, stat, opts);
    });
  };
}

export default { serveStatic, serveFile, sendFile };
