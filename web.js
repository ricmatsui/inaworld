// ======================
// OPTIONS
DEBUG = false
process.env.DEBUG = 'monk:*'
var PASSPHRASE_TTL = DEBUG ? 60 : 15 * 60;
var ROOM_TTL = DEBUG ? 5*60 : 24*60*60;
var WRITER_TTL = DEBUG ? 5*60 : 24*60*60;
var LONG_POLL_TIMEOUT = DEBUG ? 2000 : 20000;
console.log(PASSPHRASE_TTL);

// ======================
// ERRORS
var ERROR_TOO_MANY_PEOPLE = 'Oops, there are too many people playing, please try again later.';
var ERROR_UNKNOWN = 'Oops, we ran into a problem. Please try again.';
var ERROR_PASSPHRASE_TAKEN = 'Uh oh, someone has taken that passphrase for now, please try being more creative!';
var ERROR_GONE = 'Oops, we couldn\'t find this game.'
var ERROR_INCORRECT_PASSPHRASE = 'Oops, we couldn\'t find a game with that passphrase.'

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
// REDIS
var redisURL = require('redis-url');
var redis = redisURL.connect(process.env.REDISTOGO_URL);
var password, database, url = require('url');
var parsedUrl  = url.parse(process.env.REDISTOGO_URL || '');
var parsedAuth = (parsedUrl.auth || '').split(':');

function create_redis() {
  var redis = require('redis').createClient(parsedUrl.port, parsedUrl.hostname);

  if (password = parsedAuth[1]) {
      redis.auth(password, function(err) {
          if (err) throw err;
      });
  }
  
  return redis;
}

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
      res.redirect('/join/'+passphrase_doc.room_uid+'/'+make_uid()+'/');
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
  rooms.findAndModify({
    uid: req.param('room'),
  }, {
    $push: { writers: { uid: req.param('writer'), name: req.param('name') }}
  }, {
    new: true
  }).on('error', function(e) {
    res.render('join_room', {error: ERROR_UNKNOWN});
  }).on('success', function(room_doc) {
    client = create_redis();
    client.publish('room_lobby_'+req.param('room'), JSON.stringify({
      writers: room_doc.writers
    }), function() { client.end() });
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
      res.render('lobby', {room: room_doc, user_uid: req.param('writer')});
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
      if(room_doc.owner_uid == req.param('writer')) {
        async.series([
          function(complete) {
            async.map(room_doc.writers, function(writer, complete) {
              complete(null, writer.uid);
            }, function(err, writer_uids) {
              async.filter(writer_uids, function(writer_uid, complete) {
                complete('action_remove_'+writer_uid in req.body);
              }, function(writer_uids_to_remove) {
                if(writer_uids_to_remove) {
                  console.log('remove', writer_uids_to_remove);
                  rooms.findAndModify({
                    uid: req.param('room')
                  }, {
                    $pull: { writers: { uid: { $in: writer_uids_to_remove }}}
                  }, {
                    new: true
                  }).on('error', function(e) {
                    console.log(e);
                    res.render('lobby', {error: ERROR_GONE});
                    complete();
                  }).on('success', function(new_room_doc) {
                    room_doc = new_room_doc;
                    complete();
                  });
                } else {
                  complete();
                }
              });
            });
          },
          function(complete) {
            if('action_start' in req.body) {
              redis.setex('room_status_'+req.param('room'), ROOM_TTL, true, function(e, result) {
                client = create_redis();
                client.publish('room_lobby_'+req.param('room'), JSON.stringify({
                  'status': true
                }), function() { client.end() });
                if(e) {
                  res.render('lobby', {error: ERROR_GONE});
                  complete();
                } else {
                  res.redirect('/play/'+req.param('room')+'/'+req.param('writer')+'/');
                  complete(null, 'redirected');
                }
              });
            } else {
              complete();
            }
          }
        ], function(err, results) {
          if(results.indexOf('redirected') == -1) {
            res.render('lobby', {room: room_doc, user_uid: req.param('writer')});
          }
        });
      }
    } else {
      res.render('lobby', {error: ERROR_GONE});
    }
  });
});
app.get('/api/1/polling/lobby/:room/', function(req, res) {
  var client = create_redis();
  client.on('message', function(channel, message) {
    client.end();
    res.json({'result': JSON.parse(message)});
  });
  client.subscribe('room_lobby_'+req.param('room'));
  redis.get('room_status_'+req.param('room'), function(e, result) {
    if(e) {
      client.end();
      res.json(500, {'result': 'error'});
    } else if(result) {        
      client.end();
      res.json({'result': {'status': true}});
    } else {
      setTimeout(function() {
        client.end();
        rooms.findOne({
          uid: req.param('room')
        }).on('error', function(e) {
          res.json(500, {'result': 'error'});
        }).on('success', function(room_doc) {
          if(room_doc) {
            res.json({'result': {'status': false, 'writers': room_doc.writers}});
          } else {
            res.json(500, {'result': 'error'});
          }
        });
      }, LONG_POLL_TIMEOUT);
    }
  });
});

// PLAY

app.get('/play/:room/:writer/', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    res.render('play', {error: ERROR_GONE});
  }).on('success', function(room_doc) {
    res.render('play', {room: room_doc, user_uid: req.param('writer')});
  });
});
app.post('/api/1/add-word/:room/:writer/', function(req, res) {
  rooms.findAndModify({
    uid: req.param('room')
  }, {
    $push: { story: req.param('word') }
  }, {
    new: true,
    fields: { story: 1 }
  }).on('error', function(e) {
    res.json(500, {result: 'error'});
  }).on('success', function(room_doc) {
    client = create_redis();
    client.publish('room_play_'+req.param('room'), 
        JSON.stringify(room_doc.story), function() { client.end() });
    res.json({result: room_doc.story});
  });
});
app.get('/api/1/polling/play/:room/', function(req, res) {
  var client = create_redis();
  client.on('message', function(channel, message) {
    client.end();
    res.json({'result': JSON.parse(message)});
  });
  client.subscribe('room_play_'+req.param('room'));  
  setTimeout(function() {
    client.end();
    rooms.findOne({
      uid: req.param('room')
    }, {
      story: 1
    }).on('error', function(e) {
      res.json(500, {'result': 'error'});
    }).on('success', function(room_doc) {
      if(room_doc) {
        res.json({'result': room_doc.story});
      } else {
        res.json(500, {'result': 'error'});
      }
    });
  }, LONG_POLL_TIMEOUT);
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
  owner_uid = make_uid();
  rooms.insert({
    uid: make_uid(),
    expireAt: (new Date()).add(ROOM_TTL).second(),
    passphrase: passphrase_doc.name,
    story: ['In', 'a', 'world'],
    writers: [],
    owner_uid: owner_uid
  }).on('error', function(e) {
    console.log('CREATE ROOM: Error');
    res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
  }).on('success', function(room_doc) {
    passphrases.updateById(passphrase_doc._id, {
      $set: { room_uid: room_doc.uid }
    }).on('error', function(e) {
      console.log('CREATE ROOM: Update passphrase error');
      res.render('create', {'error': ERROR_UNKNOWN});
    }).on('success', function() {
      res.redirect('/join/'+room_doc.uid+'/'+owner_uid+'/');
    });
  });
}

// RUN

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  console.log("Listening on " + port);
});
