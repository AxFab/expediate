
const expediate = require('./index.js')
    app = expediate();


app.use('/', expediate.logger())
app.use('/', expediate.static('.'))
app.listen(80)

