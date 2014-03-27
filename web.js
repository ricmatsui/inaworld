// ======================
// CONSTANTS
var ONE_SECOND = 1;
var ONE_MINUTE = 60*ONE_SECOND;
var FIVE_MINUTES = 5*ONE_MINUTE;
var FIFTEEN_MINUTES = 15*ONE_MINUTE;
var ONE_HOUR = 60*ONE_MINUTE;
var ONE_DAY = 24*ONE_HOUR;
var ONE_WEEK = 7*ONE_DAY;

// ======================
// OPTIONS
DEBUG = false
process.env.DEBUG = 'monk:*'
var PASSPHRASE_TTL = DEBUG ? ONE_MINUTE : FIFTEEN_MINUTES;
var ROOM_TTL = DEBUG ? FIVE_MINUTES : ONE_DAY;
var WRITER_TTL = DEBUG ? FIVE_MINUTES : ONE_DAY;
var STORY_TTL = DEBUG ? FIVE_MINUTES : ONE_WEEK;
var LONG_POLL_TIMEOUT = (DEBUG ? 2*ONE_SECOND : 20*ONE_SECOND)*1000;
var APP_ID = '1415436845376960'
var BASE_URL = 'https://inaworld.herokuapp.com';
var PUNCTUATION = ['.', ',', '?'];

// ======================
// ERRORS
var ERROR_TOO_MANY_PEOPLE = 'Oops, there are too many people playing, please try again later.';
var ERROR_UNKNOWN = 'Oops, we ran into a problem. Please try again.';
var ERROR_PASSPHRASE_TAKEN = 'Uh oh, someone has taken that passphrase for now, please try being more creative!';
var ERROR_ROOM_NOT_FOUND = 'Oops, we couldn\'t find this game.'
var ERROR_INCORRECT_PASSPHRASE = 'Oops, we couldn\'t find a game with that passphrase.'
var ERROR_STORY_NOT_FOUND = 'Oops, we couldn\'t find this story.';

function render_404(res, error) {
  res.status(404).render('404', {error: error});
}

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
var util = require('util');

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
// REDIS
var redisURL = require('redis-url');
var redis = redisURL.connect(process.env.REDISTOGO_URL);
var password, database, url = require('url');
var parsedUrl  = url.parse(process.env.REDISTOGO_URL || '');
var parsedAuth = (parsedUrl.auth || '').split(':');

function create_pub_sub_redis() {
  var redis = require('redis').createClient(parsedUrl.port, parsedUrl.hostname);

  if (password = parsedAuth[1]) {
      redis.auth(password, function(err) {
          if (err) throw err;
      });
  }
  
  return redis;
}
var redis_pub = create_pub_sub_redis();
var redis_sub = create_pub_sub_redis();
var redis_uid = make_uid();

function setup_long_polling(sub_channel, callback) {
  var sub_channel_key = redis_uid+'_'+sub_channel;
  redis.setex(sub_channel_key, ROOM_TTL, 0, callback);
}
function subscribe_long_polling(req, sub_channel, 
    accept_message_callback, message_callback, 
    immediate_callback, poll_timeout_callback) {
  var sub_channel_key = redis_uid+'_'+sub_channel;
  var incremented = false;
  var timeout;
  var unsub = function() {
    clearTimeout(timeout);
    req.removeListener('close', unsub);
    redis_sub.removeListener('message', on_message);
    if(incremented) {
      redis.decr(sub_channel_key, function(err, value) {
        if(value == 0) {
          redis_sub.unsubscribe(sub_channel);
        }
      });
    }
  };
  var on_message = function(channel, message_str) {
    message = JSON.parse(message_str);
    if(channel == sub_channel && accept_message_callback(message)) {
      unsub();
      message_callback(message);
    }
  };
  req.on('close', unsub);
  async.series([
    function(complete) {
      redis.incr(sub_channel_key, function(err, value) {
        incremented = true;
        complete();
      });
    },
    function(complete) {
      redis_sub.on('message', on_message);
      redis_sub.subscribe(sub_channel, function() {
        complete();
      });
    },
    function(complete) {
      immediate_callback(function() {
        unsub();
        complete();
      }, function() {
        timeout = setTimeout(function() {
          unsub();
          poll_timeout_callback(function() {
            complete();
          });
        }, LONG_POLL_TIMEOUT);
      });
    }
  ]);
}

function critical_section(key, lock_callback, fail_callback) {
  redis.multi().getset(key, 1)
      .expire(key, ROOM_TTL)
      .exec(function(e, results) {
    old_value = results[0];
    if(e) {
      fail_callback(e);
    } else if(old_value) {
      fail_callback();
    } else {
      lock_callback(function(complete) {
        redis.del(key, function(e, result) {
          complete();
        });
      });
    }
  });
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

var stories = db.get('stories');
stories.ensureIndex('uid', {unique: true});
stories.ensureIndex('expireAt', {expireAfterSeconds: 0});

// ======================
// APP
var app = express();

app.use(logfmt.requestLogger());
app.use(express.compress());
app.use(express.static(path.join(__dirname, 'static'), {maxAge: ONE_WEEK*1000}));
app.use(express.favicon(path.join(__dirname + '/favicon.ico')));
app.use(express.bodyParser());

app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'jade');

// INDEX

app.get('/', function(req, res) {
  res.render('index')
});

// STORY

app.get('/story/:story/', function(req, res) {
  stories.findOne({
    uid: req.param('story')
  }).on('error', function(e) {
    render_404(res, ERROR_STORY_NOT_FOUND);
  }).on('success', function(story_doc) {
    if(story_doc) {
      writers = story_doc.writers.slice(0, -1).join(', ') 
          + ' & ' + story_doc.writers.slice(-1);
      res.render('story', {
        story: story_doc,
        writers: writers,
        beginning: story_doc.text.slice(0, 30).trim()+'...',
        app_id: APP_ID,
        link: encodeURIComponent(BASE_URL+req.path),
        redirect_uri: BASE_URL+req.originalUrl,
        room: req.param('room'),
        writer: req.param('writer')
      });
    } else {
      render_404(res, ERROR_STORY_NOT_FOUND);
    }
  });
});

// PLAY AGAIN

app.get('/play-again/:room/:writer/', function(req, res) {
  redis.get('room_next_room_'+req.param('room'),
      function(e, next_room) {
    if(e) {
      res.render('index', {error: ERROR_UNKNOWN});
    } else if(next_room) {
      res.redirect('/join/'+next_room+'/'+req.param('writer')+'/');
    } else {
      res.render('index', {error: ERROR_ROOM_NOT_FOUND});
    }
  });
});

// JOIN

app.get('/join/', function(req, res) {
  res.render('join')
});
app.post('/join/', function(req, res) {
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
    redis_pub.publish('room_lobby_'+req.param('room'), JSON.stringify({
      writers: room_doc.writers
    }));
    res.redirect('/lobby/'+req.param('room')+'/'+req.param('writer')+'/');
  });
});

// LOBBY

app.get('/lobby/:room/:writer/', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    render_404(res, ERROR_ROOM_NOT_FOUND);
  }).on('success', function(room_doc) {
    if(room_doc) {
      res.render('lobby', {room: room_doc, user_uid: req.param('writer')});
    } else {
      render_404(res, ERROR_ROOM_NOT_FOUND);
    }
  });
});
app.post('/lobby/:room/:writer/', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    render_404(res, ERROR_ROOM_NOT_FOUND);
  }).on('success', function(room_doc) {
    if(room_doc) {
      if(room_doc.owner_uid == req.param('writer')) {
        async.map(room_doc.writers, function(writer, complete) {
          complete(null, writer.uid);
        }, function(err, writer_uids) {
          async.series([
            function(complete) {
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
                    render_404(res, ERROR_ROOM_NOT_FOUND);
                    complete(null, 'responded');
                  }).on('success', function(new_room_doc) {
                    room_doc = new_room_doc;
                    complete(null, 'responded');
                  });
                } else {
                  complete();
                }
              });
            },
            function(complete) {
              if('action_start' in req.body) {
                rooms.updateById(room_doc._id, {
                  $pushAll: { turns: writer_uids }
                }).on('error', function(e) {
                  res.render('lobby', {error: ERROR_UNKNOWN});
                  complete(null, 'responded');
                }).on('success', function() {
                  redis.setex('room_status_'+req.param('room'), ROOM_TTL, true, function(e, result) {
                    if(e) {
                      render_404(res, ERROR_ROOM_NOT_FOUND);
                      complete(null, 'responded');
                    } else {
                      redis_pub.publish('room_lobby_'+req.param('room'), JSON.stringify({
                        'status': true
                      }));
                      res.redirect('/play/'+req.param('room')+'/'+req.param('writer')+'/');
                      complete(null, 'responded');
                    }
                  });
                });
              } else {
                complete();
              }
            }
          ], function(err, results) {
            if(results.indexOf('responded') == -1) {
              res.render('lobby', {room: room_doc, user_uid: req.param('writer')});
            }
          });
        });
      }
    } else {
      render_404(res, ERROR_ROOM_NOT_FOUND);
    }
  });
});
app.get('/api/1/polling/lobby/:room/', function(req, res) {
  subscribe_long_polling(req, 'room_lobby_'+req.param('room'), function() {
    return true;
  }, function(result) {
    res.json({'result': result});
  }, function(finish, continue_polling) {
    redis.get('room_status_'+req.param('room'), function(e, result) {
      if(e) {
        finish();
        res.json(500, {'result': 'error'});
      } else if(result) {        
        finish();
        res.json({'result': {'status': true}});
      } else {
        continue_polling();
      }
    });
  }, function(complete) {
    rooms.findOne({
      uid: req.param('room')
    }).on('error', function(e) {
      res.json(500, {'result': 'error'});
      complete();
    }).on('success', function(room_doc) {
      if(room_doc) {
        res.json({'result': {'status': false, 'writers': room_doc.writers}});
        complete();
      } else {
        res.json(500, {'result': 'error'});
        complete();
      }
    });
  });
});

// PLAY

app.get('/play/:room/:writer/', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    render_404(res, ERROR_ROOM_NOT_FOUND);
  }).on('success', function(room_doc) {
    if(room_doc) {
      redis.get('room_turn_'+req.param('room'), 
          function(e, turn) {
        if(e) {
          render_404(res, ERROR_ROOM_NOT_FOUND);
        } else if(turn) {
          position = room_doc.turns.indexOf(req.param('writer'));
          if(position == 0) {
            status = '';
          } else {
            if(room_doc.turns.length > 2) {
              status = '('+position+')';
            } else {
              status = '(waiting)';
            }
          }
          res.render('play', {
            room: room_doc, 
            user_uid: req.param('writer'),
            status: status,
            turn: turn
          });
        } else {
          render_404(res, ERROR_ROOM_NOT_FOUND);
        }
      });
    } else {
      render_404(res, ERROR_ROOM_NOT_FOUND);
    }
  });
});
app.post('/play/:room/:writer', function(req, res) {
  rooms.findOne({
    uid: req.param('room')
  }).on('error', function(e) {
    render_404(res, ERROR_ROOM_NOT_FOUND);
  }).on('success', function(room_doc) {
    if(room_doc) {
      if('action_finish' in req.body 
          && room_doc.owner_uid == req.param('writer')) {
        async.map(room_doc.writers, function(writer, complete) {
          complete(null, writer.name);
        }, function(err, writer_names) {
          stories.insert({
            uid: make_uid(),
            expireAt: (new Date()).add(STORY_TTL).second(),
            text: room_doc.story.join(''),
            writers: writer_names
          }).on('error', function(e) {
            res.render('play', {'error': ERROR_TOO_MANY_STORIES});
          }).on('success', function(story_doc) {
            redis.setex('room_finished_story_'+req.param('room'), 
                ROOM_TTL, story_doc.uid, function(e, result) {
              redis_pub.publish('room_play_'+req.param('room'), 
                  JSON.stringify({
                'finished_story': story_doc.uid
              }));
              owner_uid = make_uid();
              rooms.insert({
                uid: make_uid(),
                expireAt: (new Date()).add(ROOM_TTL).second(),
                story: ['In', ' a', ' world'],
                writers: [],
                turns: [],
                owner_uid: owner_uid
              }).on('error', function(e) {
                console.log('CREATE ROOM: Error');
                res.render('play', {'error': ERROR_TOO_MANY_PEOPLE});
              }).on('success', function(next_room_doc) {
                redis.setex('room_turn_'+next_room_doc.uid, ROOM_TTL, 
                    1, function(e, result) {
                  if(e) {
                    res.render('play', {'error': ERROR_TOO_MANY_PEOPLE});
                  } else {
                    redis.setex('room_next_room_'+room_doc.uid, ROOM_TTL,
                        next_room_doc.uid, function(e, result) {
                      if(e) {
                        res.render('play', {'error': ERROR_TOO_MANY_PEOPLE});
                      } else {
                        async.map(['room_lobby_'+req.param('room'), 'room_play_'+req.param('room')], 
                            function(item, complete) {
                          setup_long_polling(item, function(e, result) {
                            complete();
                          });      
                        }, function(err, results) {
                          res.redirect(util.format('/story/%s/?room=%s&writer=%s',
                              story_doc.uid, room_doc.uid, owner_uid));
                        });
                      }
                    });
                  }
                });
              });
            });
          });
        });
      }
    }
  });
});
app.post('/api/1/add-word/:room/:writer/', function(req, res) {
  words = req.param('word').split(/\s/);
  if(words && words[0]) {
    first_word = words[0];
    if(PUNCTUATION.indexOf(first_word[0]) == -1) {
      word = ' '+first_word;
    } else {
      if(words.length == 1) {
        word = first_word;
      } else {
        word = first_word + ' ' + words[1];
      }
    }
    critical_section('room_adding_word_'+req.param('room'), 
        function(release) {
      rooms.findAndModify({
        uid: req.param('room'),
        "turns.0": req.param('writer')
      }, {
        $push: { 
          story: word,
          turns: req.param('writer')
        }
      }, {
        fields: { _id: 1}
      }).on('error', function(e) {
        release(function() {
          res.json(500, {result: 'error'});
        });
      }).on('success', function(room_doc) {
        if(room_doc) {
          rooms.findAndModify({
            _id: room_doc._id
          }, {
            $pop: { turns: -1 }
          }, {
            new: true,
            fields: { story: 1, turns: 1}
          }).on('error', function(e) {
            release(function() {
              res.json(500, {result: 'error'});
            });
          }).on('success', function(room_doc) {
            redis.incr('room_turn_'+req.param('room'), 
                function(e, turn) {
              console.log(arguments);
              if(e) {
                release(function() {
                  res.json(500, {result: 'error'});
                });
              } else {
                release(function() {
                  var payload = {
                    story: room_doc.story, 
                    turns: room_doc.turns,
                    turn: turn,
                    writer: req.param('writer')
                  };
                  redis_pub.publish('room_play_'+req.param('room'), 
                      JSON.stringify(payload));
                  res.json({result: payload});
                });
              }
            });
          });
        } else {
          release(function() {
            res.json({result: 'wrong-turn'});
          });
        }
      });
    }, function(e) {
      if(e) {
        res.json(500, {result: 'error'});
      } else {
        res.json({result: 'wrong-turn'});
      }
    });
  } else {
    res.json({result: 'empty-word'});
  }
});
app.get('/api/1/polling/play/:room/:writer/:turn/', function(req, res) {
  subscribe_long_polling(req, 'room_play_'+req.param('room'), function(result) {
    return result.writer != req.param('writer');
  }, function(result) {
    res.json({'result': result});
  }, function(finish, continue_polling) {
    redis.get('room_finished_story_'+req.param('room'),
        function(e, finished_story) {
      if(e) {
        res.json(500, {'result': 'error'});
        finish();
      } else if(finished_story) {
        res.json({'result': {'finished_story': finished_story}});
      } else {
        redis.get('room_turn_'+req.param('room'), 
            function(e, turn) {
          if(e) {
            res.json(500, {'result': 'error'});
            finish();
          } else if(turn) {
            if(turn == req.param('turn')) {
              continue_polling();
            } else {
              rooms.findOne({
                uid: req.param('room')
              }, {
                story: 1,
                turns: 1
              }).on('error', function(e) {
                res.json(500, {'result': 'error'});
                finish();
              }).on('success', function(room_doc) {
                if(room_doc) {
                  var payload = {
                    story: room_doc.story, 
                    turns: room_doc.turns,
                    turn: turn
                  };
                  res.json({'result': payload});
                  finish();
                } else {
                  res.json(500, {'result': 'error'});
                  finish();
                }
              });
            }
          } else {
            res.json(500, {'result': 'error'});
            finish();
          }
        });
      }
    });
  }, function(complete) {
    rooms.findOne({
      uid: req.param('room')
    }, {
      story: 1,
      turns: 1
    }).on('error', function(e) {
      res.json(500, {'result': 'error'});
      complete();
    }).on('success', function(room_doc) {
      if(room_doc) {
        redis.get('room_turn_'+req.param('room'), 
            function(e, turn) {
          if(e) {
            res.json(500, {'result': 'error'});
            complete();
          } else if(turn) {
            var payload = {
              story: room_doc.story, 
              turns: room_doc.turns,
              turn: turn
            };
            res.json({'result': payload});
            complete();
          } else {
            complete();
          }
        });
      } else {
        res.json(500, {'result': 'error'});
        complete();
      }
    });
  });
});

// CREATE

app.get('/create/', function(req, res) {
  res.render('create')
});
app.post('/create/', function(req, res) {
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
  var owner_uid = make_uid();
  rooms.insert({
    uid: make_uid(),
    expireAt: (new Date()).add(ROOM_TTL).second(),
    passphrase: passphrase_doc.name,
    story: ['In', ' a', ' world'],
    writers: [],
    turns: [],
    owner_uid: owner_uid
  }).on('error', function(e) {
    console.log('CREATE ROOM: Error');
    res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
  }).on('success', function(room_doc) {
    redis.setex('room_turn_'+room_doc.uid, ROOM_TTL, 
        1, function(e, result) {
      if(e) {
        res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
      } else {
        passphrases.updateById(passphrase_doc._id, {
          $set: { room_uid: room_doc.uid }
        }).on('error', function(e) {
          console.log('CREATE ROOM: Update passphrase error');
          res.render('create', {'error': ERROR_UNKNOWN});
        }).on('success', function() {
          async.map(['room_lobby_'+req.param('room'), 'room_play_'+req.param('room')], 
              function(item, complete) {
            setup_long_polling(item, function(e, result) {
              complete();
            });      
          }, function(err, results) {
            res.redirect('/join/'+room_doc.uid+'/'+owner_uid+'/');
          });
        });
      }
    });
  });
}

// RUN

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  console.log("Listening on " + port);
});
