
var expediate = require('expediate')
var app = expediate();
var fs = require('fs');

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

// List all availables services
for (var dir of fs.readdirSync('./src')) {
  if (/\./.test(dir))
    continue;
  if (fs.existsSync(`./src/${dir}/api.js`)) {
    // console.log('IMPORT', `./src/${dir}/api.js`, 'at', `/api/${dir}/...`);
    var srv = require(`./src/${dir}/api.js`);
    if (!srv.name) srv.name = dir;
    var api = apiBuilder(srv);
    // console.log(mod);
    app.use(`/api/${dir}`, expediate.parseBody());
    app.use(`/api/${dir}`, api);
  }
}

// If not authenticate -> 401 WWW-Authenticate: Basic realm="Git"
// GitHub utilise un format  username:JWT !




app.get('/hello', function (req, res) {
  res.send('Hello World')
})


app.use('/', expediate.static(__dirname + '/dist'));

app.listen(8080, () => console.log(`Server ready at http://localhost:8080`));
