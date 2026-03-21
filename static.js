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
  NOT_MODIFIED: (res, opts) => res.status(304, opts.headers).end(),
  FORBIDDEN: (res, opts) => res.status(403, opts.headers).send('Forbidden'),
  NOT_FOUND: (res, opts) => res.status(404, opts.headers).send('Not Found'),
  NOT_ALLOWED: (res, opts) => res.status(405, { ...opts.headers, 'Allow': 'GET, HEAD' }).end(),
  PRECONDITION_FAILS: (res, opts) => res.status(412, opts.headers).send('Precondition Failed'),
  INTERNAL_ERROR: (res, opts, err) => res.status(500, opts.headers).send(`Internal error: ${err}`),
};

const DEFAULT_OPTIONS = {
  headers: {
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff'
  },
  // setHeader
  fallthrough: false,
  maxage: 0, 
  immutable: false,
  etag: true,
  lastModified: true,
  contentType: null,
  dotfiles: 'hide', // 'allow', 'deny',
  redirect: true,
  indexOf: false,
  // root, will be set by static
}

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


function serveOptions(root, options) {

  if (!root)
    throw new TypeError('root path required')
  else if (typeof root !== 'string')
    throw new TypeError('root path must be a string')

  // copy options
  var opts = { ...DEFAULT_OPTIONS, ...options  };
  opts.fallthrough = opts.fallthrough !== false
  opts.redirect = opts.redirect !== false
  opts.maxage = opts.maxage || opts.maxAge || 0
  opts.root = path.resolve(root)
  return opts;
}

/** Create a page similar to Apache index-of */
function writeIndexOf(queries, path, directoryPath, parentDir, go) 
{
  fs.readdir(directoryPath, (err, files) => {
    if (err) 
      return go(null, err);
    let html = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n';
    html += '<html>\n';
    html += `<head><title>Index of ${path}</title></head>\n`
    html += `<body><h1>Index of ${path}</h1><table>\n`
    // TODO -- OrderBy ?C=N to sorr by Name, ?C=M to sort by modified date, ?C=S to sort by date, ?C=D to sort by description ; ?O=A sort by ascending order, ?O=D sort by desending order ; if already sorted, create link to sort in reverse order. By default is sorted by ascending name
    html += '<tr><th valign="top"><img src="/icons/blank.gif" alt="[ICO]"></th><th><a href="?C=N;O=D">Name</a></th><th><a href="?C=M;O=A">Last modified</a></th><th><a href="?C=S;O=A">Size</a></th><th><a href="?C=D;O=A">Description</a></th></tr>\n'
    html += '<tr><th colspan="5"><hr></th></tr>\n'
    if (parentDir)
      html += `<tr><td valign="top"><img src="/icons/back.gif" alt="[PARENTDIR]"></td><td><a href="${parentDir}">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td><td>&nbsp;</td></tr>\n`
    for (var file of files) {
      // TODO -- sync stat of file... Order by later...
      const stat = fs.statSync(path.join(directoryPath, file));
      const type = mime.lookup(pathname); 
      const alt = stat.isDirectory() ? 'folder' : (type.indexOf('/') > 0 ? type.substr(0, type.indexOf('/')): 'unknown');
      const icon = `/icons/${alt}.gif`; // 'folder', 'text', 'image', 'layout', ...
      const name = file + (stat.isDirectory() ? '/' : '');
      const modified = stat.modified; // '2019-03-26 22:09';
      const size = stat.size; //'25K';
      html += `<tr><td valign="top"><img src="${icon}" alt="${alt}"></td><td><a href="${name}"></a></td><td align="right">${modified}</td><td align="right">${size}</td><td>&nbsp;</td></tr>\n`
    }
    html += '<tr><th colspan="5"><hr></th></tr>\n'
    html += '</table><address>Expediate/2.0.0</address></body></html>\n'
    go(html);
  });
}


function sendIt(req, res, pathname, stat, opts) {
  const len = stat.size
  const etag = createETag(stat)

  if (opts.headers) {
    for (let key in opts.headers) 
      res.setHeader(key, opts.headers[key]);
  }

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
        return HTTP.NOT_MODIFIED(res, opts);
      }
    }
    // return HTTP.PRECONDITION_FAILS(res, opts)
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
    HTTP.INTERNAL_ERROR(res, opts, err.code);
    finished = true;
    destroyReadStream(stream);
  });
  stream.on('end', _ => {
    res.end();
  });
  stream.pipe(res);
}

/**
 * Method used to send a static file as a response to a HTTP request
 * Handle HEAD, condtional GET, Etags, and mime-type using 'mime' npm package
 * @param {*} req 
 * @param {*} res 
 * @param {*} pathname filename of the file to send
 * @param {*} opts 
 * @returns 
 */
function sendFile(req, res, pathname, opts) 
{
  fs.stat(pathname, function (err, stat) {
    if (err) {
      if (err.code == 'ENOENT' || err.code == 'ENAMETOOLONG' || err.code == 'ENOTDIR') {
        return HTTP.NOT_FOUND(res, opts)
      }
      return HTTP.INTERNAL_ERROR(res, opts, err.code);
    }

    if (stat.isDirectory()) {
      if (opts.indexOf === true) {
        writeIndexOf(req.queries.url, req.path, pathname, req.path !== '/' ? path.dirname(req.path) : null, (html, err) => {
          if (err)
            return HTTP.INTERNAL_ERROR(res, opts, err.code);
          return res.send(200, { ...opts.headers }).send(html);
        })
      }
      // TODO -- index file support
      return HTTP.NOT_FOUND(res, opts);
    }

    sendIt(req, res, pathname, stat, opts)
  });
}

/**
 * Middleware factory used to serve files in a public directory
 * Handle HEAD, condtional GET, Etags, and mime-type using 'mime' npm package
 * @param {*} root directory containing the files
 * @param {*} options access, cache and response options
 * @returns 
 */
function static (root, options) {

  var opts = serveOptions(root, options);
  return function (req, res, next) {

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (opts.fallthrough)
        return next()
      return HTTP.NOT_ALLOWED(res, opts);
    }

    var originalUrl = decodeURIComponent(/*req.originalUrl || */req.path || req.url)
    var pathname = originalUrl

    // make sure redirect occurs at mount
    if (pathname === '/' && originalUrl.substr(-1) !== '/') {
      pathname = ''
    }

    // Forbid any path part which can be exploited as malveillant access
    if (UP_PATH_REGEXP.test(pathname))
      return HTTP.FORBIDDEN(res, opts);

    // resolve the path
    pathname = path.resolve(path.normalize(opts.root + '/' + pathname));

    // dotfile handling
    if (!opts.dotfiles != 'allow' && pathname.indexOf('/.') >= 0) {
      if (opts.dotfiles == 'deny')
        return HTTP.FORBIDDEN(res, opts);
      return HTTP.NOT_FOUND(res, opts);
    }

    fs.stat(pathname, function onstat (err, stat) {
      if (err) {
        // console.log('DBG', pathname, err.code, req.originalUrl, req.url, req.path)
        if (err.code == 'ENOENT' || err.code == 'ENAMETOOLONG' || err.code == 'ENOTDIR') {
          if (opts.fallthrough)
            return next();
          console.warn('static error:', err)
          return HTTP.NOT_FOUND(res, opts)
        }
        return HTTP.INTERNAL_ERROR(res, opts, err.code);
      }

      // index file support
      if (stat.isDirectory()) {
        if (!opts.redirect)
          return HTTP.NOT_FOUND(res, opts);
        return sendFile(req, res, path.join(pathname, 'index.html'), opts)
      }


      sendIt(req, res, pathname, stat, opts)
    });
  }
}

/**
 * Middleware factory used to serve a unique file as response
 * Handle HEAD, condtional GET, Etags, and mime-type using 'mime' npm package
 * @param {*} root path of the filename to send
 * @param {*} options access, cache and response options
 * @returns 
 */
function file (root, options) {

  var opts = serveOptions(root, options);
  return function (req, res, next) {

    const methOk = req.method !== 'GET' && req.method !== 'HEAD';
    if (!methOk) {
      if (opts.fallthrough)
        return next();
      return HTTP.NOT_ALLOWED(res, opts);
    }

    const pathname = opts.root;
    fs.stat(pathname, function onstat (err, stat) {
      if (err)
        return HTTP.INTERNAL_ERROR(res, opts, err.code);
      if (stat.isDirectory())
        return HTTP.INTERNAL_ERROR(res, opts, err.code);

      sendIt(req, res, pathname, stat, opts)
    });
  }
}


module.exports = { 
  static, 
  file, 
  sendFile
};
