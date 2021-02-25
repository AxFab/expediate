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

const http = require('http'), https = require('https');

const Router = {};

/**
 * Prepare an layer object to define a new route
 *
 * @param {String} method
 * @param {String} [path]
 * @param {Listener} listener
 * @return {Layer}
 */
Router.buildLayer = function (method, path, listener) {
  if (method)
    method = method.toUpperCase();
  if (typeof path === 'function') {
    listener = path;
    path = '/';
  }
  let parts = path.split('/').filter(x => x.length > 0);
  return { method, path, parts, listener };
};

/**
 * Check if a request match the current route(layer)
 *
 * In case the request match the route, we update the request
 * path field and the queries.route map depending on route parameters
 *
 * @param {Layer} layer
 * @param {http.ClientRequest} req
 * @param {String[]} parts
 * @return {Bool}
 */
Router.matchLayer = function (layer, req, parts) {
  if (layer.method && layer.method != req.method)
    return false;
  let params = {}
  for (let i = 0; ; ++i) {
    if (layer.parts.length <= i) {
      req.path = '/' + parts.slice(i).join('/');
      req.queries.route = params;
      return true;
    } else if (parts.length <= i)
      return false;
    else if (layer.parts[i][0] == ':')
      params[layer.parts[i].substring(1)] = parts[i];
    else if (layer.parts[i] != parts[i])
      return false;
  }
};

/**
 * Extends the request and response object of a http request
 * with parameters and helper.
 *
 * @param {http.ClientRequest} req
 * @param {http.ServerResponse} res
 */
Router.updateReq = function (req, res) {
  if (req.queries)
    return
  req.queries = {};

  let qry = new URL(`http://${req.headers.host}${req.url}`)
  req.path = qry.pathname

  // Parse URL-encoded data
  let params = {};
  for(var pair of qry.searchParams.entries())
    params[pair[0]] = pair[1];
  req.queries.url = params;

  // Parse cookies
  if (req.cookies == null) {
    req.cookies = {};
    var cookies = req.headers.cookie;
    if (cookies) {
      cookies = cookies.split(';')
        .map(x => x.replace(/^\s+|\s+$/g, '').split('='));
      for (var k in cookies) {
        let key = cookies[k][0]
        let val = cookies[k][1]
        req.cookies[key] = val;
        if (typeof val == 'string') {
          // TODO s: Cookie is signed, j: Cookie is a JSON
        }
      }
    }
  }


  res.setHeader('X-Powered-By', 'Expediate');

  res.send = (data) => {
    res.write(data);
    res.end();
  }

  res.status = (code, headers) => {
    if (headers)
      for (var k in headers)
        res.setHeader(k, headers[k])
    res.writeHead(code)
    return res;
  };

  res.redirect = (url) => {
    let status = 302;
    res.setHeader('location', url);
    res.writeHead(status)
    res.write(`Found. Redirecting to ${url}`);
    res.end();
  };

  res.cookie = function (name, value, options) {
    var opts = options || {};

    if (opts.signed && !res.req.secret)
      throw new Error('cookieParser("secret") required for signed cookies');

    var val = typeof value === 'object'
      ? 'j:' + JSON.stringify(value)
      : String(value);

    if (opts.signed)
      val = 's:' + sign(val, res.req.secret);

    let txt = `${name}=${String(val)}`

    if ('maxAge' in opts) {
      opts.expires = new Date(Date.now() + opts.maxAge);
      opts.maxAge /= 1000;
    }

    if (opts.path == null)
      opts.path = '/';

    res.setHeader('Set-Cookie', txt);
    return res;
  };

  res.sendFile = function sendFile(path, options, callback) {
    var done = callback;
    var req = this.req;
    var res = this;
    var next = req.next;
    var opts = options || {};

    if (!path) {
      throw new TypeError('path argument is required to res.sendFile');
    }

    if (typeof path !== 'string') {
      throw new TypeError('path must be a string to res.sendFile')
    }

    // support function as second arg
    if (typeof options === 'function') {
      done = options;
      opts = {};
    }

    if (!opts.root && !isAbsolute(path)) {
      throw new TypeError('path must be absolute or specify root to res.sendFile');
    }

    // create file stream
    var pathname = encodeURI(path);
    var file = send(req, pathname, opts);

    // transfer
    sendfile(res, file, opts, function (err) {
      if (done) return done(err);
      if (err && err.code === 'EISDIR') return next();

      // next() all but write errors
      if (err && err.code !== 'ECONNABORTED' && err.syscall !== 'write') {
        next(err);
      }
    });
  };

};

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

module.exports = NewRouter;

/**
 * This function create a new router function as a web listener.
 */
function NewRouter() {

  const routes = [];

  const listener = function(req, res, done) {
    const method = req.method;
    const url = req.url;
    let idx = 0;
    Router.updateReq(req, res);
    const parts = req.path.split('/').filter(x => x.length > 0);

    const next = () => {
      while (idx < routes.length) {
        let layer = routes[idx++];
        if (Router.matchLayer(layer, req, parts))
          return layer.listener(req, res, next);
      }

      if (done)
        return done();
      return res.status(404).end(`Cannot ${method} ${url}`);
    }

    try {
      next();
    } catch (e) {
      console.warn(e)
      res.status(500).end(`Error ${method} ${url}`)
    }
  };

  listener.use = (p, l) => routes.push(Router.buildLayer(null, p, l));
  listener.all = (p, l) => routes.push(Router.buildLayer(null, p, l));
  listener.get = (p, l) => routes.push(Router.buildLayer('GET', p, l));
  listener.put = (p, l) => routes.push(Router.buildLayer('PUT', p, l));
  listener.post = (p, l) => routes.push(Router.buildLayer('POST', p, l));
  listener.delete = (p, l) => routes.push(Router.buildLayer('DELETE', p, l));
  listener.patch = (p, l) => routes.push(Router.buildLayer('PATCH', p, l));

  listener.listen = (port, opts) => {
    if (opts && opts.key && opts.cert)
      https.createServer(opts, listener).listen(port);
    else
      http.createServer(listener).listen(port);
  };

  return listener;
};

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

NewRouter.logger = () => {
  return (req, res, next) => {
    const nclr = '\x1b[0m';
    const colors = [
      '\x1b[31m', '\x1b[33m', '\x1b[32m', '\x1b[33m', '\x1b[31m', '\x1b[91m'];
    const rec = new Intl.DateTimeFormat('en-GB', {
      month: 'short',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit'}).format();
    const path = req.path;
    req.received = new Date().getTime();
    res.on('finish', ev => {
      req.elapsed = new Date().getTime() - req.received;
      const clr = colors[parseInt(res.statusCode / 100)];
      const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      const user = req.session ? `${req.session.username}/${req.session.ssid}` : '-'
      const status = `${clr}${res.statusCode}${nclr}`
      const elp = `${req.elapsed} ms`
      console.log(`${rec} ${status} ${req.method} ${path} ${ip} <${user}> ${elp}`);
    })
    next();
  };
};

// NewRouter.static = (root) => {
//   return (req, res, next) => {
//   };
// };

NewRouter.session = (opts) => {
  return (req, res, next) => {
    let ssid = req.cookies.ssid;
    req.session = opts.openSession(ssid);
    if (ssid != req.session.ssid)
      res.cookie('ssid', req.session.ssid);
    next();
  };
};
