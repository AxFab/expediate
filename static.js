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

const fs = require('fs'),
    path = require('path');
const mime = require('mime');

// Regular expression to match a path with a directory up component.
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/

const HTTP = {
  NOT_MODIFIED: res => httpSend(res, 304),
  FORBIDDEN: res => httpSend(res, 403, {
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff'
      }, 'Forbidden'),
  NOT_FOUND: res => httpSend(res, 404, {
        // 'Content-Type': 'text/html; charset=UTF-8',
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff'
      }, 'Not Found'),
  NOT_ALLOWED: res => httpSend(res, 405, { 'Allow': 'GET, HEAD' }),
  PRECONDITION_FAILS: res => httpSend(res, 412, {
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff'
      }, 'Precondition Failed'),
  INTERNAL_ERROR: (res, err) => httpSend(res, 500, {
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff'
      }, `Internal error: ${err}`),
};

// Destroy a read stream properly
function destroyReadStream(stream) {
  stream.destroy()
  if (typeof stream.close === 'function') {
    // node.js core bug work-around
    stream.on('open', _ => {
      if (typeof stream.fd === 'number')
        stream.close()
    })
  }
}

function removeContentHeaders(res) {
  var keys = Object.keys(res.getHeaders() || {});
  for (let key of keys) {
    if (key.substr(0, 8) === 'content-' && key != 'content-location')
      res.removeHeader(key)
  }
}

// Create a simple ETag based on file metadata
function createETag(stat) {
  var mtime = stat.mtime.getTime().toString(16)
  var size = stat.size.toString(16)
  return 'W/"' + size + '-' + mtime + '"'
}

// Basic utility for default answers
function httpSend (res, code, headers, body) {
  headers = headers || {}
  body = body || ''
  res.statusCode = code;
  for (let k in headers)
    res.setHeader(k.toString(), headers[k].toString())
  res.setHeader('Content-Length', Buffer.byteLength(body))
  if (body)
    res.write(body);
  res.end();
}

// Parse a HTTP token list.
function parseTokenList (str) {
  var end = 0
  var list = []
  var start = 0

  // gather tokens
  for (var i = 0, len = str.length; i < len; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20: /*   */
        if (start === end) {
          start = end = i + 1
        }
        break
      case 0x2c: /* , */
        list.push(str.substring(start, end))
        start = end = i + 1
        break
      default:
        end = i + 1
        break
    }
  }

  // final token
  list.push(str.substring(start, end))

  return list
}

// Parse an HTTP Date into a number.
function parseHttpDate (date) {
  var timestamp = date && Date.parse(date)

  return typeof timestamp === 'number'
    ? timestamp
    : NaN
}

function hasCondition(req) {
  return req['if-match'] ||
    req['if-unmodified-since'] ||
    req['if-none-match'] ||
    req['if-modified-since']
}

function conditionMatch(req, res) {

  // if-match
  const match = req['if-match']
  if (match) {
    const etag = res['etag']
    if (match === etag || match === '*')
      return true;
    for (let tag of parseTokenList(match))
      if (match === tag || match === 'W/' + tag || 'W/' + match === tag)
        return true;
  }

  // if-unmodified-since
  const lastModified = parseHttpDate(res['last-modified'])
  const unmodifiedSince = parseHttpDate(req['if-modified-since'])
  if (!isNaN(unmodifiedSince) && !isNaN(lastModified))
    return lastModified <= unmodifiedSince


  return false
}

// Check freshness of the response using request and response headers.
function isCacheFresh (req, res) {
  const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/
  // fields
  var modifiedSince = req['if-modified-since']
  var noneMatch = req['if-none-match']

  // unconditional request
  if (!modifiedSince && !noneMatch) {
    return false
  }

  // Always return stale when Cache-Control: no-cache
  // to support end-to-end reload requests
  // https://tools.ietf.org/html/rfc2616#section-14.9.4
  var cacheControl = req['cache-control']
  if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) {
    return false
  }

  // if-none-match
  if (noneMatch && noneMatch !== '*') {
    var etag = res['etag']

    if (!etag) {
      return false
    }

    var etagStale = true
    var matches = parseTokenList(noneMatch)
    for (var i = 0; i < matches.length; i++) {
      var match = matches[i]
      if (match === etag || match === 'W/' + etag || 'W/' + match === etag) {
        etagStale = false
        break
      }
    }

    if (etagStale) {
      return false
    }
  }

  // if-modified-since
  if (modifiedSince) {
    var lastModified = res['last-modified']
    var modifiedStale = !lastModified || !(parseHttpDate(lastModified) <= parseHttpDate(modifiedSince))

    if (modifiedStale) {
      return false
    }
  }

  return true
}

function sendFile(req, res, pathname, stat, opts) {
  const len = stat.size
  const etag = createETag(stat)

  if (opts.setHeaders)
    opts.setHeaders(res);

  // set cache-control
  if (!res.getHeader('Cache-Control') && opts.maxage) {
    var cacheControl = 'public, max-age=' + Math.floor(opts.maxage / 1000)
    if (opts.immutable === true)
      cacheControl += ', immutable'
    res.setHeader('Cache-Control', cacheControl)
  }

  if (!res.getHeader('Last-Modified') && opts.lastModified !== false)
    res.setHeader('Last-Modified', stat.mtime.toUTCString())

  if (!res.getHeader('ETag') && opts.etag !== false)
    res.setHeader('ETag', etag)

  // set content-type
  if (!res.getHeader('Content-Type')) {
    if (opts.contentType) {
      res.setHeader('Content-Type', opts.contentType)
    } else {
      var type = mime.lookup(pathname)
      if (type) {
        var charset = mime.charsets.lookup(type)
        if (charset)
          res.setHeader('Content-Type', type + '; charset=' + charset)
        else
          res.setHeader('Content-Type', type)
      }
    }
  }

  // Conditionnal GET
  if (hasCondition(req.headers)) {
    if (conditionMatch(req.headers, res.getHeaders())) {

      if (isCacheFresh(req.headers, res.getHeaders())) {
        removeContentHeaders(res);
        return HTTP.NOT_MODIFIED(res);
      }
    }
    // return HTTP.PRECONDITION_FAILS(res)
  }


  // Send data
  res.setHeader('Content-Length', len)
  if (req.method === 'HEAD')
    return res.end()

  let finished = false
  const stream = fs.createReadStream(pathname);
  res.on('finish', _ => {
    finished = true;
    destroyReadStream(stream);
  });
  stream.on('error', err => {
    if (finished) return;
    console.warn('static error', pathname, err)
    HTTP.INTERNAL_ERROR(res, err.code);
    finished = true;
    destroyReadStream(stream);
  });
  stream.on('end', _ => {
    res.end();
  });
  stream.pipe(res);
}

function sendIndex(req, res, pathname, stat, opts) {

  var p = path.join(pathname, 'index.html')
  fs.stat(p, function (err, stat) {
    if (err) {
      if (err.code == 'ENOENT' || err.code == 'ENAMETOOLONG' || err.code == 'ENOTDIR') {
        if (opts.fallthrough)
          return next();
        return HTTP.NOT_FOUND(res)
      }
      return HTTP.INTERNAL_ERROR(res, err.code);
    }

    // index file support
    if (stat.isDirectory()) {
      return HTTP.NOT_FOUND(res);
    }

    sendFile(req, res, p, stat, opts)
  })
}

function serveOptions(root, options) {

  if (!root)
    throw new TypeError('root path required')
  else if (typeof root !== 'string')
    throw new TypeError('root path must be a string')

  // copy options
  var opts = options || {
    fallthrough: true,
    redirect: false,
  };
  opts.fallthrough = opts.fallthrough !== false
  opts.redirect = opts.redirect !== false
  opts.maxage = opts.maxage || opts.maxAge || 0
  opts.root = path.resolve(root)
  if (opts.setHeaders && typeof opts.setHeaders !== 'function')
    throw new TypeError('option setHeaders must be function')

  return opts;
}

function serveStatic (root, options) {

  var opts = serveOptions(root, options);
  return function (req, res, next) {

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (opts.fallthrough)
        return next()
      return HTTP.NOT_ALLOWED(res);
    }

    var originalUrl = decodeURIComponent(/*req.originalUrl || */req.path || req.url)
    var pathname = originalUrl

    // make sure redirect occurs at mount
    if (pathname === '/' && originalUrl.substr(-1) !== '/') {
      pathname = ''
    }

    if (UP_PATH_REGEXP.test(pathname))
      return HTTP.FORBIDDEN(res);

    // resolve the path
    pathname = path.resolve(path.normalize(opts.root + '/' + pathname));

    // dotfile handling
    if (opts.dotfiles != 'allow' && pathname.indexOf('/.') >= 0) {
      if (opts.dotfiles == 'deny')
        return HTTP.FORBIDDEN(res);
      return HTTP.NOT_FOUND(res);
    }

    fs.stat(pathname, function onstat (err, stat) {
      if (err) {
        // console.log('DBG', pathname, err.code, req.originalUrl, req.url, req.path)
        if (err.code == 'ENOENT' || err.code == 'ENAMETOOLONG' || err.code == 'ENOTDIR') {
          if (opts.fallthrough)
            return next();
          console.warn('static error:', err)
          return HTTP.NOT_FOUND(res)
        }
        return HTTP.INTERNAL_ERROR(res, err.code);
      }

      // index file support
      if (stat.isDirectory()) {
        // if (!opts.redirect)
        //   return HTTP.NOT_FOUND(res);
        return sendIndex(req, res, pathname, stat, opts)
      }


      sendFile(req, res, pathname, stat, opts)
    });
  }
}

function serveFile (root, options) {

  var opts = serveOptions(root, options);
  return function (req, res, next) {

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (opts.fallthrough)
        return next()
      return HTTP.NOT_ALLOWED(res);
    }

    const pathname = opts.root;
    fs.stat(pathname, function onstat (err, stat) {
      if (err)
        return HTTP.INTERNAL_ERROR(res, err.code);
      if (stat.isDirectory())
        return HTTP.INTERNAL_ERROR(res, err.code);

      sendFile(req, res, pathname, stat, opts)
    });
  }
}


module.exports = { serveStatic, serveFile, sendFile, sendIndex };
