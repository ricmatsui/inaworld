// ======================
// OPTIONS
DEBUG = true
process.env.DEBUG = 'monk:*'
var PASSPHRASE_TTL = DEBUG ? 60 : 15 * 60;
var ROOM_TTL = DEBUG ? 5*60 : 24*60*60;
var WRITER_TTL = DEBUG ? 5*60 : 24*60*60;
console.log(PASSPHRASE_TTL);

// ======================
// REQUIRES
require('newrelic');
require('datejs');
var express = require("express");
var logfmt = require("logfmt");
var monk = require('monk');
var path = require('path');
var Chance = require('chance');
var debug = require('debug')('inaworld');
var async = require('async');

// ======================
// ERRORS
var ERROR_TOO_MANY_PEOPLE = 'Oops, there are too many people playing, please try again later.';
var ERROR_UNKNOWN = 'Oops, we ran into a problem. Please try again.';
var ERROR_PASSPHRASE_TAKEN = 'Uh oh, someone has taken that passphrase for now, please try being more creative!';
var ERROR_GONE = 'Oops, we couldn\'t find this game.'
var ERROR_INCORRECT_PASSPHRASE = 'Oops, we couldn\'t find a game with that passphrase.'

// ======================
// DATABASE
var mongoUri = process.env.MONGOLAB_URI ||
  process.env.MONGOHQ_URL ||
  'mongodb://localhost/inaworld';
  
var db = monk(mongoUri);

// -----------
// COLLECTIONS
var passphrases = db.get('passphrases');
passphrases.ensureIndex('name', {unique: true});
passphrases.ensureIndex('expireAt', {expireAfterSeconds: 0});

var rooms = db.get('rooms');
rooms.ensureIndex('uid', {unique: true});
rooms.ensureIndex('expireAt', {expireAfterSeconds: 0});

var writers = db.get('writers');
writers.ensureIndex('uid', {unique: true});
writers.ensureIndex('expireAt', {expireAfterSeconds: 0});

// ======================
// RANDOM
var random = new Chance();

var unique_opts = {
  pool: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  length: 16
};

function make_uid() {
  return random.string(unique_opts);
}

// ======================
// APP
var app = express();

app.use(logfmt.requestLogger());
app.use(express.static(path.join(__dirname, 'static')));
app.use(express.favicon());
app.use(express.bodyParser());

app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'jade');

// INDEX

app.get('/', function(req, res) {
  res.render('index')
});

// JOIN

app.get('/join', function(req, res) {
  res.render('join')
});
app.post('/join', function(req, res) {
  passphrases.findOne({
    name: req.param('passphrase')
  }).on('error', function(e) {
    res.render('join', {error: ERROR_INCORRECT_PASSPHRASE});
  }).on('success', function(passphrase_doc) {
    if(passphrase_doc) {
      writers.insert({
        uid: make_uid(),
        is_owner: false,
        room_uid: passphrase_doc.room_uid,
        name: 'Anonymous',
        expireAt: (new Date()).add(WRITER_TTL).second()
      }).on('error', function(e) {
        res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
      }).on('success', function(writer_doc) {
        res.redirect('/join/'+passphrase_doc.room_uid+'/'+writer_doc.uid+'/');
      });
    } else {
      res.render('join', {error: ERROR_INCORRECT_PASSPHRASE});
    }
  });
});

// JOIN ROOM

app.get('/join/:room/:writer/', function(req, res) {
  res.render('join_room');
});
app.post('/join/:room/:writer/', function(req, res) {
  writers.update({
    uid: req.param('writer'),
  }, {
    $set: { name: req.param('name') }
  }).on('error', function(e) {
    res.render('join_room', {error: ERROR_UNKNOWN});
  }).on('success', function() {
    res.redirect('/lobby/'+req.param('room')+'/'+req.param('writer')+'/');
  });
});

// LOBBY

app.get('/lobby/:room/:writer/', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    res.render('lobby', {error: ERROR_GONE});
  }).on('success', function(room_doc) {
    if(room_doc) {
      writers.find({
        room_uid: room_doc.uid
      }).on('error', function(e) {
        res.render('lobby', {error: ERROR_GONE});      
      }).on('success', function(writer_docs) {
        writers.findOne({
          uid: req.param('writer')
        }).on('error', function(e) {
          res.render('lobby', {error: ERROR_GONE});
        }).on('success', function(user_doc) {
          if(user_doc) {
            res.render('lobby', {writers: writer_docs, room: room_doc, user: user_doc});
          } else {
            res.render('lobby', {error: ERROR_GONE});
          }
        });
      });
    } else {
      res.render('lobby', {error: ERROR_GONE});    
    }
  });
});
app.post('/lobby/:room/:writer/', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    res.render('lobby', {error: ERROR_GONE});
  }).on('success', function(room_doc) {
    if(room_doc) {
      writers.find({
        room_uid: room_doc.uid
      }).on('error', function(e) {
        res.render('lobby', {error: ERROR_GONE});
      }).on('success', function(writer_docs) {
        writers.findOne({
          uid: req.param('writer')
        }).on('error', function(e) {
          res.render('lobby', {error: ERROR_GONE});
        }).on('success', function(user_doc) {
          if(user_doc.is_owner) {
            async.each(writer_docs, function(writer_doc, complete) {
              if('action_remove_'+writer_doc.uid in req.body) {
                writers.remove({
                  uid: writer_doc.uid
                }, function() {
                  console.log(arguments);
                  complete();
                });
              } else {
                complete();
              }
            }, function() {
              if(req.param('action_start') && user_doc.is_owner) {
                res.redirect('/play/'+req.param('room')+'/'+req.param('writer')+'/');
              } else {
                writers.find({
                  room_uid: room_doc.uid
                }).on('error', function(e) {
                  res.render('lobby', {error: ERROR_GONE});
                }).on('success', function(writer_docs) {
                  res.render('lobby', {writers: writer_docs, room: room_doc, user: user_doc});
                });
              }
            });
          } else {
            res.render('lobby', {writers: writer_docs, room: room_doc, user: user_doc});
          }
        });
      });
    } else {
      res.render('lobby', {error: ERROR_GONE});
    }
  });
});

// CREATE

app.get('/create', function(req, res) {
  res.render('create')
});
app.post('/create', function(req, res) {
  console.log(new Date());
  console.log(req.param('passphrase'));
  // Add passphrase
  passphrases.insert({
    name: req.param('passphrase'),
    expireAt: (new Date()).add(PASSPHRASE_TTL).second()
  }).on('error', function(e) {
    // Passphrase still in DB
    console.log('CREATE: Duplicate, attempting to update');
    passphrases.findAndModify({
      name: req.param('passphrase'),
      expireAt: { $lt: new Date() }
    }, {
      $set: { expireAt: (new Date()).add(PASSPHRASE_TTL).second() }
    }).on('error', function(e) {
      // Unknown error
      console.log('CREATE: Error updating');
      res.render('create', {'error': ERROR_UNKNOWN});
    }).on('success', function(passphrase_doc) {
      if(passphrase_doc) {
        // Passphrase already expired
        console.log('CREATE: Success');
        create_room(req, res, passphrase_doc);
      } else {
        // Passphrase not expired yet
        console.log('CREATE: Not expired');
        res.render('create', {'error': ERROR_PASSPHRASE_TAKEN});
      }
    });
  }).on('success', function(passphrase_doc) {
    // New passphrase
    console.log('CREATE: Success');
    create_room(req, res, passphrase_doc);
  });
});

function create_room(req, res, passphrase_doc) {
  rooms.insert({
    uid: make_uid(),
    expireAt: (new Date()).add(ROOM_TTL).second(),
    passphrase: passphrase_doc.name
  }).on('error', function(e) {
    console.log('CREATE ROOM: Error');
    res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
  }).on('success', function(room_doc) {
    writers.insert({
      uid: make_uid(),
      is_owner: true,
      room_uid: room_doc.uid,
      name: 'Anonymous',
      expireAt: (new Date()).add(WRITER_TTL).second()
    }).on('error', function(e) {
      console.log('CREATE ROOM: Writer error');
      res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
    }).on('success', function(writer_doc) {
      passphrases.updateById(passphrase_doc._id, {
        $set: { room_uid: room_doc.uid }
      }).on('error', function(e) {
        console.log('CREATE ROOM: Update passphrase error');
        res.render('create', {'error': ERROR_UNKNOWN});
      }).on('success', function() {
        //res.render('create', {'error': ERROR_UNKNOWN});
        res.redirect('/join/'+room_doc.uid+'/'+writer_doc.uid+'/');
      });
    });
  });
  
}

// RUN

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  console.log("Listening on " + port);
});
