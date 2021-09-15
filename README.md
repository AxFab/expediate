# Expediate

This small library serve as a router facility for a web server.
For compatibility reason it keep the exact same interface as express.js,
however it doesn't intent to provide all the features.

  [![NPM Version][npm-image]][npm-url]
  [![NPM Downloads][downloads-image]][downloads-url]
  [![Linux Build][travis-image]][travis-url]
  [![Windows Build][appveyor-image]][appveyor-url]
  [![Test Coverage][coveralls-image]][coveralls-url]

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


### Middleware

 json => Parse Json body
 static => Serve static files
 urlencdeded => Parse url encoded

```js
var apiApp = expediate()
apiApp.use('/myEndpoint', ...)

var app = expediate();
var app.use('/api', apiApp);

app.listen(80)
app.listen(443, { key: 'xx', cert: 'xx' })
apiApp.listen(8900) // Only api
```



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

