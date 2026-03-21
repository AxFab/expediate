# Expediate

This small library serve as a router facility for a web server.
For compatibility reason it keep the exact same interface as express.js,
however it doesn't intent to provide all the features.

  [![NPM Version][npm-image]][npm-url]
  [![NPM Downloads][downloads-image]][downloads-url]
<!--
  [![Linux Build][travis-image]][travis-url]
  [![Windows Build][appveyor-image]][appveyor-url]
  [![Test Coverage][coveralls-image]][coveralls-url]
 -->
```js
const expediate = require('expediate')
const app = expediate()

app.get('/', function (req, res) {
  res.send('Hello World')
})

app.listen(3000)
```

The main reason for this package is that expressjs grow to become extra
complicated with tons of dependencies. Expediate aims to keep thing simple
while retaining the most widely used features.

## Installation

This is a [Node.js](https://nodejs.org/en/) module available through the
[npm registry](https://www.npmjs.com/).

Before installing, [download and install Node.js](https://nodejs.org/en/download/).

If this is a brand new project, make sure to create a `package.json` first with
the [`npm init` command](https://docs.npmjs.com/creating-a-package-json-file).

Installation is done using the
[`npm install` command](https://docs.npmjs.com/getting-started/installing-npm-packages-locally):

```bash
$ npm install expediate
```

## Usage

```js
const expediate = require('expediate')
const app = expediate();
// Module can also be exported this way:
// const { createRouter } = expediate();
// const app = createRouter();

// Create a router, which can be mounted as one or more routes
const apiRouter = expediate(); // OR createRouter();
apiRouter.use('/hello', (req, res) => res.send('Hello world'));
var app.use('/api/v1', apiRouter);
var app.use('/api/head', apiRouter);

// Listen on one or multiple ports, using HTTP or HTTPS
app.listen(80)
app.listen(443, { key: 'xx', cert: 'xx' })
// Create an extra server with any router instance.
apiRouter.listen(8900) // Only api
```



Here a complete usage of the expediate router. 

```js
const expediate = require('expediate')
const app = expediate()

const route = expediate()
route.get('/', function (req, res, next) {
  console.log(`New call to API - ${req.method} ${req.path}`);
  next();
});

route.get('/', function (req, res) {
  res.send('Hello World')
})

app.use('/api', route);
app.get('/', function (req, res) {
  res.send(expediate.staticFile('public/index.html'));
});
app.get('/dist', function (req, res) {
  res.send(expediate.static('public/dist'));
});

app.listen(3000)
```

### Middleware

#### `static` Middleware

Two middleware here, `static()` and `file()`. those can be used to serve a basic static HTML website.
First parameter is a path to file present on the server machine.
Second parameter is an optional options object.

```js
const { createRouter, static, file } = expediate();
const app = createRouter();

app.get('/dist', static(__dirname + 'public/dist'), {
  fallthrough: true, // Should routing continue if file doesn't exist
  redirect: false, // Treat a directory path, as don't exist, if false, return an index as HTML
  setHeaders: (req) => {}, // Optional
});

// Used to serve only one file 
app.get('/', file('public/index.html', { exactMatch:true }));

app.listen(8080);
```

### `logger` Middleware

This logger middleware print a single line per request, once completed...
It allow to monitor traffic.
Note that it can also track lost requests (if server forget about them, usage might be coslty, use in development is advise)

```js
const { createRouter, logger } = expediate();
const app = createRouter();

// Parameter is optional
app.get('/dist', logger({
  track: true, // Recommand for developement only, track lost requests
  trackTimeout: 30_000, // Default value
  user: (req) => req.authUser ?? '-', // Search username or ssid to identify client
  locale: 'en-GB', // Overwrite locale for date format
  dateFormat: {}, // Overwrite date format (2 parameter to Intl.DateTimeFormat)
  logger: (msg) => console.log(msg), // Overwrite output of message
});

app.listen(8080);
```

### Api middleware

The API middleware is a clever way of providing a controller like service to implement method, without thinking about the response build.
It also provide a common container for datas.

```js
const { apiBuilder, createRouter } = require('expediate');

const app = createRouter();

app.use('/api', apiBuilder(service))

// --- 

// Here the full definition for an API service.
const service = {
  // This method is optionnal, without it the service is instantiate as a singleton.
  // Provide a unique key if you want to build a new instance, or null is the service must me reinstantiate for every request (recommanded for tiny service class)
  scope(req) => req.session.ssid,
  data: () => {
    // Initialize service state
    return {
      loaded: false,
    }
  },
  setup: function() {
    // At startup, initialize the service if necessary
    // can run either synchronously or asynchronously
    this.loadExtenalData()
      .then(res => {
        this.loaded = true;
      });
  },
  methods: {
    throwIfNotReady() {
      // Usefull if the method 'setup' start asynchronous loading.
      // Unnecessary if the setup method is synchronous!
      if (!this.loaded)
        throw { httpStatus: 503, message: 'Service not ready - try again later' }
    },
    loadExtenalData() {
      return new Promise((resolve, reject) => {
        // ...
      });
    }
  },
  // Create GET routes
  GET: {
    '/object/:uid': function(query) {
      this.throwIfNotReady();
      if (!this.data[query.uid])
        throw { httpStatus: 404, message: 'Not found' }
      // Return requested data...
      return this.data[query.uid];
    },
    '/async/:uid': function(query) {
      this.throwIfNotReady();
      // Method can be either synchronous or asynchronous
      return new Promise((resolve, reject) => {
        if (!this.data[query.uid])
          // You can also replace 'message' by data: { } to return a JSON object
          return reject({ httpStatus: 404, data: { message: 'Not found', key: query.uid }})
        // Return requested data...
        resolve(this.data[query.uid]);
      });
    }
  },
  // Create POST routes
  POST: {
    '/object/:uid': function(query, body) {
      this.throwIfNotReady();
      if (!this.data[query.uid])
        throw { httpStatus: 404, message: 'Not found' }
      // ...
      return undefined; // Will return 201 if the function return evaluate to false.
    }
  }
}
```

### Jwt middleware

Handle creation and verification of JWT token.
Create also refresh token to avoid reconnection, after JWT expiration.


```js
const crypto = require('crypto')
const { createRouter, createJwtPlugin } = require('expediate');
const app = createRouter();

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

const userDatabase = new Map(); // <string: user>
// {
//   username: "alice",
//   passwordHash: hashPassword("password123"),
//   roles: ["admin", "editor"],
//   permissions: ["read", "write", "delete", "manage_users"],
// },

var jwt = createJwtPlugin({
  fetchUser: (username) => userDatabase.get(username),
  checkPassword: (user, password) => user.passwordHash !== hashPassword(password),
});

// Create endpoints to update JWT
app.post('/auth/login', jwt.login);
app.post('/auth/refresh', jwt.refresh);
app.post('/auth/logout', jwt.logout);

// Protect againt non-authenticated user
app.use('/api', jwt.authenticate, jwt.autorize); 
app.use('/api/admin', jwt.requireRole('admin'));
app.use('/api/edit', jwt.requirePermission('write'));

```


### Git middleware

This middleware is used to serve clonable git repositories.

Here is the most simple usage of this middleware

```js
// ...
const { gitHandler, createRouter } = require('expediate');

const app = createRouter();

// Exosition simple d'un repository Git
// git clone http://localhost/git/linux
app.use('/git/linux', gitHandler({ repository: (req) => '/srv/git/linux.git' }));
```

However in most case, this won't be enough so here is a more complete usage.
This one need also an extra middleware to handle authentification.
**Important**: Git credential manager (GCM) require Basic authentication

```js
// List of Git repositories available, with private access and timeout server protection
const repositories = {
  linux: {
    dir: '/src/git/linux.git',
    isPublic: true,
  },
  'secret-lib': {
    dir: '/src/git/secret-lib.git',
    isPublic: false,
    users: ['admin', 'john']
  }
};

app.use('/git/:repoName', gitHandler({
  gitPath: '/mingw64/bin', // Path to find git-upload-pack binary
  bareOnly: true, // Default is 'false'
  timeout: 10, // Default is no timeout
  repository: (req) => {
    const repo = repositories[req.params.repoName];
    const user = req.authUser ?? 'NO AUTH'; // GCM require Basic authentication
    return repo && (repo.isPublic || repo.users.indexOf(user) >= 0) ? repo.dir : null;
  }
}));
```

### Others middleware

We also have `parseBody`, `json` or `session`.


## License

  [MIT](LICENSE)


[npm-image]: https://img.shields.io/npm/v/expediate.svg
[npm-url]: https://npmjs.org/package/expediate
[downloads-image]: https://img.shields.io/npm/dm/expediate.svg
[downloads-url]: https://npmcharts.com/compare/expediate?minimal=true
[travis-image]: https://img.shields.io/travis/axfab/expediate/master.svg?label=linux
[travis-url]: https://travis-ci.org/axfab/expediate
[appveyor-image]: https://img.shields.io/appveyor/ci/axfab/expediate/master.svg?label=windows
[appveyor-url]: https://ci.appveyor.com/project/axfab/expediate
[coveralls-image]: https://img.shields.io/coveralls/axfab/expediate/master.svg
[coveralls-url]: https://coveralls.io/r/axfab/expediate?branch=master

