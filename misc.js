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

const zlib = require('zlib');
const uncompressAlgo = {
  gzip: zlib.gunzip,
  deflate: zlib.inflate,
}

function readSize(value) {
  const fmt = /^(\d+(\.\d+)?)([kmg]?b?)?$/i.exec(value);
  if (!fmt)
    return 0;
  const num = parseFloat(fmt[1] || '0');
  const sfx = fmt[3]?.toLowerCase() || 'b';
  if (sfx[0] == 'k')
    return num * 1024;
  if (sfx[0] == 'm')
    return num * 1024 * 1024;
  if (sfx[0] == 'g')
    return num * 1024 * 1024 * 1024;
  return num;
}

function splitBuffer(buffer, delimiter) {
  const result = [];
  let start = 0;
  let index;

  while ((index = buffer.indexOf(delimiter, start)) !== -1) {
    result.push(buffer.slice(start, index));
    start = index + delimiter.length;
  }

  // Push the final segment
  result.push(buffer.slice(start));
  return result;
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

// Function to read body data of a HTTP request
function readBody(req, res, opts, mimetype, next, callback) {
  // Check if we have a body
  const length = parseInt(req.headers['Content-Length'] || 0);
  if (length == 0)
    return next();
  const maxLength = readSize(opts.limit) || 102_400;
  if (length > maxLength)
    return res.status(413).send('Content Too Large');
  // Look if we support compression
  const compress = req.headers['Content-Encoding'];
  if (compress && (opts.inflate === false || !uncompressAlgo[compress]))
    return res.status(415).send('Unsupported Media Type: Wrong Content-Encoding');
  const uncompress = uncompressAlgo[compress] || ((d,c) => c(null,d));
  // Check mimetype
  const mime = req.headers['Content-Type'] || '';
  if (mimetype && mime.split(';')[0] !== mimetype)
    return res.status(415).send('Unsupported Media Type: Wrong Content-Type');
  let data = Buffer.from('');
  req.on('data', chunk => {
    // Double-check we don't exceed buffer size limit
    if (data == null || data.length > maxLength) {
      data = null;
      return res.status(413).send('Content Too Large');
    }
    // Concat buffer
    data = Buffer.concat([data, chunk]);
  });
  req.on('end', () => {
    if (data == null)
      return;
    return uncompress(data, (err, decompressed) => {
      if (err) return res.status(500).send(err.message);
      callback(mime, decompressed);
    });
  });
}


function readBodyAsPlainText(req, res, next, opts, mime, data) {
  const charset = mime.split(';').map(x => x.replace(/^\s+|'s+$/g, '')).find(x => x.startsWith('charset='))?.substring(8) || 'utf8';
  try {
    req.body = data.toString(charset);
    next();
  } catch (ex) {
    res.status(500).send(ex.message);
  }
}

function readBodyAsJson(req, res, next, opts, mime, data) {
  const charset = mime.split(';').map(x => x.replace(/^\s+|'s+$/g, '')).find(x => x.startsWith('charset='))?.substring(8) || 'utf8';
  try {
    req.body = JSON.parse(data.toString(charset), opts.reviver);
    next();
  } catch (ex) {
    res.status(500).send(ex.message);
  }
}

function readBodyAsFormData(req, res, next, opts, mime, data) {
  const boundary = mime.split(';').map(x => x.replace(/^\s+|'s+$/g, '')).find(x => x.startsWith('boundary='))?.substring(9);
  try {
    const multiparts = splitBuffer(buffer, Buffer.from(boundary));
    req.body = multiparts.map(buf => {
      if (buf.length == 2 && buf.toString() == '--')
        return null; // Last part
      const headers = {};
      const headBufs = splitBuffer(buf, Buffer.from('\r\n')); 
      let headerLength = 2;
      for (let i = 0; i < headBufs.length; ++i) {
        if (headBufs[i].length == 0) {
          const content = buf.slice(headerLength);
          return { content, headers };
        }
        headerLength += headBufs[i].length + 2;
        const head = headBufs[i].toString('utf8');
        const idx = head.indexOf(':');
        const key = head.substring(0, idx).replace(/^\s+|'s+$/g, '');
        const value = head.substring(idx+1).replace(/^\s+|'s+$/g, '');
        headers[key] = value;
      }
    }).filter(x => x != null);
    next();  
  } catch (ex) {
    res.status(500).send(ex.message);
  }
}

const bodyReaders = {
  'multipart/form-data': (req, res, next, opts, mime, data) => readBodyAsFormData(req, res, next, opts, mime, data),
  'application/json': (req, res, next, opts, mime, data) => readBodyAsJson(req, res, next, opts, mime, data),
  'text/plain': (req, res, next, opts, mime, data) => readBodyAsPlainText(req, res, next, opts, mime, data),
};

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/** 
 * Middleware factory to parse JSON body 
 * 
 * @param {*} opts Options
 * @returns A middleware function
 * */
function json(opts) {
  opts = {
    inflate: true, 
    limit: '100kb',
    reviver: null, 
    strict: true,
    ...opts
  };
  return (req, res, next) => {
    res.json = (data) => {
      res.write(JSON.stringify(data));
      res.end();
    };
    readBody(req, res, opts, 'application/json', next, (mime, data) => {
      readBodyAsJson(req, res, next, opts, mime, data);
    });
  }
}

/** 
 * Middleware factory to parse multipart/form-data body 
 * 
 * @param {*} opts Options
 * @returns A middleware function
*/
function formData(opts) {
  opts = {
    inflate: true, 
    limit: '100kb',
    reviver: null, 
    strict: true,
    ...opts
  }
  return (req, res, next) => {
    readBody(req, res, opts, 'multipart/form-data', next, (mime, buffer) => {
      readBodyAsFormData(req, res, next, opts, mime, data);
    });
  }
}

/** 
 * Middleware which try to parse any body, as long as we support the mimetype 
 * 
 * @param {*} opts Options
 * @returns A middleware function
*/
function parseBody(opts) {
  opts = {
    inflate: true, 
    limit: '100kb',
    reviver: null, 
    strict: true,
    ...opts
  }
  return (req, res, next) => {
    readBody(req, res, opts, null, next, (mime, buffer) => {
      const mimetype = mime.split(';')[0];
      if (!bodyReaders[mimetype])
        return res.status(415, 'Unsupported Media Type')
      bodyReaders[mimetype](req, res, next, opts, mime, data);
    });
  }
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=


/**
 * This logger middleware print a single line per request, once completed...
 * It allow to monitor traffic.
 * Note that it can also track lost requests (if server forget about them, usage might be coslty, use in development is advise)
 * 
 * Usage:
 * app.use('/', logger({
 *   track: true, // Recommand for developement only, track lost requests
 *   trackTimeout: 30_000, // Default value
 *   user: (req) => req.authUser ?? '-', // Search username or ssid to identify client
 *   locale: 'en-GB', // Overwrite locale for date format
 *   dateFormat: {}, // Overwrite date format (2nd parameter to Intl.DateTimeFormat)
 *   logger: (msg) => console.log(msg), // Overwrite output of message
 * });
 * 
 * @param {*} opts Options
 * @returns A middleware function
 */
function logger (opts) {
  if (!opts) opts = {};
  const log = opts.logger ?? console.log
  return (req, res, next) => {
    const nclr = '\x1b[0m';
    const colors = [ '\x1b[31m', '\x1b[33m', '\x1b[32m', '\x1b[33m', '\x1b[31m', '\x1b[91m'];
    const rec = new Intl.DateTimeFormat(opts.locale ?? 'en-GB', opts.dateFormat ?? {
      month: 'short',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit'}).format();
    const path = req.path;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const user = opts?.user(req) ?? '-';
    req.received = new Date().getTime();

    const tracker = opts.track === true ? setTimeout(() => {
      log(`${rec} LOST ${req.method} ${path} ${ip} <${user}>`);
    }, opts.trackTimeout || 30_000) : null;

    res.on('finish', ev => {
      if (opts.track === true)
        clearTimeout(tracker);
      req.elapsed = new Date().getTime() - req.received;
      const clr = colors[parseInt(res.statusCode / 100)];
      const status = `${clr}${res.statusCode}${nclr}`
      const elp = `${req.elapsed} ms`
      const len = res.getHeader('content-length') ? res.getHeader('content-length') : '-';
      log(`${rec} ${status} ${req.method} ${path} ${ip} <${user}> ${elp} (${len})`);
    });
    next();
  };
};


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

module.exports = { 
    logger,
    json,
    formData,
    parseBody,
};
