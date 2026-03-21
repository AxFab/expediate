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

function parseBody () {
  return (req, res, next) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        req.body = JSON.parse(data);
      } catch {
        req.body = data;
      }
      next();
    });
  }
}

function json (opts) {
  return (req, res, next) => {
    let data = '';
    res.json = (data) => {
      res.write(JSON.stringify(data));
      res.end();
    };
    req.on('data', chunk => {
       data += chunk;
    });
    req.on('end', () => {
      try {
        req.body = JSON.parse(data);
      } catch (e) {
        if (opts?.fallthrough)
          req.body = data;
        else  
          throw e;
      }
      next();
    });
  }
}

function session (opts) {
  return (req, res, next) => {
    let ssid = req.cookies.ssid;
    req.session = opts.openSession(ssid);
    if (ssid != req.session.ssid)
      res.cookie('ssid', req.session.ssid);
    next();
  };
};


module.exports = { 
    logger,
    parseBody,
    json,
    session,
};
