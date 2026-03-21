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

const router = require('./router.js')

function buildModule(service, key) {
  const module = service.data ? service.data(key) : { $key: key };

  // LIFECYCLE
  // setup(), beforeCreate(), !, created(), !CompileTemplate?,
  // beforeMount(), !Rendering, mounted(), !MOUNTED
  //   [ beforeUpdate, !RenderPatch, updated(), !MOUNTED ],
  // beforeUnmount(), !UNMOUNTED, unmounted()

  // Clone methods
  if (service.methods) {
    for (let methodName in service.methods) {
      const method = service.methods[methodName];
      module[methodName] = () => method.apply(module, arguments);
    }
  }

  if (service.setup)
    service.setup.apply(module, []);

  return module;
} 

// Handler for an API controller
function apiBuilder(service) {

  const api = router();
  const modules = {};
  if (typeof service.scope !== 'function')
    modules.singleton = buildModule(service);

  function buildRoutes(calls, register) {
    if (!calls)
      return;
    for (let path in calls) {
      const method = calls[path];

      register(path, (req, res) => {
        const args = [ req.params, req.body ];
        try {
          // Handling instance depending of scope
          const key = typeof service.scope === 'function' ? service.key(req) : 'singleton';
          const instance = (key ? modules[key] : null) ?? buildModule(service, key);
          if (key && !modules[key])
            modules[key] = instance;
          // Call the method and write result
          const ret = method.apply(instance, args);
          if (ret instanceof Promise) {
            ret.then(val => {
              if (val)
                res.send(JSON.stringify(val));
              else
                res.status(201).end();
            }).catch(err => {
              res.status(err?.httpStatus ?? 500).send(err?.data ? JSON.stringify(err.data) : err?.message ?? 'Internal error');
            });
          } else {
            if (ret)
              res.send(JSON.stringify(ret));
            else
              res.status(201).end();
          }
        } catch (err) {
          res.status(err?.httpStatus ?? 500).send(err?.data ? JSON.stringify(err.data) : err?.message ?? 'Internal error');
        }
      });
    }
  }

  // Place api as route (GET / POST / PUT / DELETE / PATCH)
  buildRoutes(service.GET, (path, handler) => api.get(path, handler));
  buildRoutes(service.POST, (path, handler) => api.post(path, handler));
  buildRoutes(service.PUT, (path, handler) => api.put(path, handler));
  buildRoutes(service.DELETE, (path, handler) => api.delete(path, handler));
  buildRoutes(service.PATCH, (path, handler) => api.patch(path, handler));
  return api;
}

module.exports = { apiBuilder };
