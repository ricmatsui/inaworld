// web.js
require('newrelic')
var express = require("express");
var logfmt = require("logfmt");
var path = require('path');
var app = express();

app.use(logfmt.requestLogger());
app.use(express.static(path.join(__dirname, 'static')));
app.use(express.favicon());

app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'jade');

app.get('/', function(req, res) {
  res.render('index')
});

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  console.log("Listening on " + port);
});
