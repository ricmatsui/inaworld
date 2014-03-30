/*global process: false, require: false */

// ======================
// OPTIONS
var DEBUG = false;
process.env.DEBUG = (DEBUG ? 'monk:*,' : '') + 'inaworld:*';

// ======================
// ERRORS
var ERROR_TOO_MANY_PEOPLE = 'Oops, there are too many people playing, please try again later.';
var ERROR_UNKNOWN = 'Oops, we ran into a problem. Please try again.';
var ERROR_PASSPHRASE_TAKEN = 'Uh oh, someone has taken that passphrase for now, please try being more creative!';
var ERROR_ROOM_NOT_FOUND = 'Oops, we couldn\'t find this game.';
var ERROR_INCORRECT_PASSPHRASE = 'Oops, we couldn\'t find a game with that passphrase.';
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
var debug = require('debug')('inaworld');
var async = require('async');
var util = require('util');

var models = require('./models.js');
var constants = require('./constants.js')(DEBUG);
var random_util = require('./random_util.js');
var date_util = require('./date_util.js');

// ======================
// REDIS
var url = require('url');
var redisURL = url.parse(process.env.REDISCLOUD_URL || '');

function create_redis() {
  var redis = require('redis').createClient(redisURL.port, redisURL.hostname, {no_ready_check: true});
  redis.auth((redisURL.auth || '').split(':')[1]);
  return redis;
}

var redis = create_redis();
var redis_pub = create_redis();
var redis_sub = create_redis();
var redis_uid = random_util.make_uid();

function setup_long_polling(sub_channel, callback) {
  var sub_channel_key = redis_uid+'_'+sub_channel;
  redis.setex(sub_channel_key, constants.ROOM_TTL, 0, callback);
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
        }, constants.LONG_POLL_TIMEOUT);
      });
    }
  ]);
}

function critical_section(key, lock_callback, fail_callback) {
  redis.multi().getset(key, 1)
      .expire(key, constants.ROOM_TTL)
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
app.use(express.static(path.join(__dirname, 'static'), {maxAge: constants.ONE_WEEK*1000}));
app.use(express.favicon(path.join(__dirname + '/favicon.ico')));
app.use(express.bodyParser());

app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'jade');

var create = require('./create.js')(rooms, passphrases, {
  setup_long_polling: setup_long_polling
}, constants);

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
        app_id: constants.APP_ID,
        link: encodeURIComponent(constants.BASE_URL+req.path),
        redirect_uri: constants.BASE_URL+req.originalUrl,
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
  rooms.findOne({
    uid: req.param('room')
  }, {
    next_room: 1
  }).on('error', function(error) {
    res.render('index', {error: ERROR_UNKNOWN});
  }).on('success', function(room_doc) {
    if(room_doc) {
      res.redirect(util.format('/join/%s/%s/',
        room_doc.next_room, req.param('writer')));
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
      res.redirect('/join/'+passphrase_doc.room_uid+'/'+random_util.make_uid()+'/');
    } else {
      res.render('join', {error: ERROR_INCORRECT_PASSPHRASE});
    }
  });
});

// JOIN ROOM

var join = require('./join.js')(rooms, { redis_pub: redis_pub });

/**
 * Get join room view
 */
app.get('/join/:room/:writer/', function(req, res) {
  res.render('join_room');
});
/**
 * Process join room view
 */
app.post('/join/:room/:writer/', function(req, res) {
  join.join_room(req.param('room'), req.param('writer'), req.param('name'), 
      function(error) {
    if(error) {
      res.render('join_room', {error: ERROR_UNKNOWN});
    } else {
      res.redirect('/lobby/'+req.param('room')+'/'+req.param('writer')+'/');
    }
  });
});
/**
 * Join rom API
 */
app.post('/api/1/join/:room/:writer/', function(req, res) {
  join.join_room(req.param('room'), req.param('writer'), req.param('name'),
      function(error) {
    if(error) {
      res.json(500, {'result': error});
    } else {
      res.json({'result': 'success'});
    }
  });
});

// LOBBY

var lobby = require('./lobby.js')(rooms, { redis_pub: redis_pub });

/*
 * Get lobby view
 */
app.get('/lobby/:room/:writer/', function(req, res) {
  lobby.lobby(req.param('room'), function(error, room_doc) {
    if(error) {
      if(error === 'not-found') {
        render_404(res, ERROR_ROOM_NOT_FOUND);
      } else if(error === 'unknown') {
        res.render('lobby', {error: ERROR_UNKNOWN});
      }
    } else {
      res.render('lobby', {room: room_doc, user_uid: req.param('writer')});
    }
  });
});
/*
 * Get lobby api view
 */
app.get('/api/1/lobby/:room/', function(req, res) {
  lobby.lobby(req.param('room'), function(error, room_doc) {
    if(error) {
      res.json(500, {result: error});
    } else {
      res.json({
        'writers': room_doc.writers,
        'passphrase': room_doc.passphrase
      });
    }
  });
});
/* 
 * Process removing writers and starting room
 */
app.post('/lobby/:room/:writer/', function(req, res) {
  async.waterfall([
    // Get room
    function(complete) {
      rooms.findOne({
        uid: req.param('room')
      }).on('error', function(e) {
        complete('not-found');
      }).on('success', function(room_doc) {
        if(room_doc) {
          complete(null, room_doc);
        } else {
          complete('not-found');
        }
      });
    },
    // Process
    function(room_doc, complete) {
      if(room_doc.owner_uid == req.param('writer')) {
        async.series([
          // Process removals
          function(complete) {
            async.waterfall([
              // Get writer uids
              function(complete) {
                async.map(room_doc.writers, function(w, complete) {
                  complete(null, w.uid);
                }, function(err, writer_uids) {
                  complete(null, writer_uids);
                });
              },
              // Filter to remove
              function(writer_uids, complete) {
                async.filter(writer_uids, function(w_uid, complete) {
                  complete('action_remove_'+w_uid in req.body);
                }, function(writer_uids_to_remove) {
                  complete(null, writer_uids_to_remove);
                });
              },
              // Remove writers
              function(writer_uids_to_remove, complete) {
                if(writer_uids_to_remove) {
                  rooms.findAndModify({
                    uid: req.param('room')
                  }, {
                    $pull: { writers: { uid: { $in: writer_uids_to_remove }}}
                  }, {
                    new: true
                  }).on('error', function(error) {
                    complete('unknown');
                  }).on('success', function(new_room_doc) {
                    complete(null, new_room_doc);
                  });
                } else {
                  complete();
                }
              }
            ], function(error, new_room_doc) {
              if(error) {
                complete(error);
              } else if(new_room_doc) {
                room_doc = new_room_doc;
                complete();
              }
            });
          },
          // Process starting
          function(complete) {
            if('action_start' in req.body) {
              async.waterfall([
                // Get writer uids
                function(complete) {
                  async.map(room_doc.writers, function(w, complete) {
                    complete(null, w.uid);
                  }, function(err, writer_uids) {
                    complete(null, writer_uids);
                  });
                },
                function(writer_uids, complete) {
                  rooms.updateById(room_doc._id, {
                    $pushAll: { turns: writer_uids },
                    $set: { started: true }
                  }).on('error', function(error) {
                    complete('unknown');
                  }).on('success', function() {
                    redis_pub.publish('room_lobby_'+room_doc.uid,
                        JSON.stringify({
                      'status': true
                    }));
                    res.redirect(util.format('/play/%s/%s/',
                        room_doc.uid, req.param('writer')));
                    complete('done');
                  });
                }
              ], function(error) {
                if(error) {
                  complete(error);
                } else {
                  complete();
                }
              });
            }
          }
        ], function(error, results) {
          if(error) {
            complete(error);
          } else {
            complete(null, room_doc);
          }
        });
      }
    }
  ], function(error, room_doc) {
    if(error) {
      if(error === 'not-found') {
        render_404(res, ERROR_ROOM_NOT_FOUND);
      } else if(error != 'done') {
        res.render('lobby', {'error': ERROR_UNKNOWN});
      }
    } else {
      res.render('lobby', {room: room_doc, user_uid: req.param('writer')});
    }
  });
});
/*
 * Polling for lobby
 */
app.get('/api/1/polling/lobby/:room/', function(req, res) {
  subscribe_long_polling(req, 'room_lobby_'+req.param('room'), function() {
    return true;
  }, function(result) {
    res.json({'result': result});
  }, function(finish, continue_polling) {
    rooms.findOne({
      uid: req.param('room')
    }, {
      started: 1,
    }).on('error', function(error) {
      finish();
      res.json(500, {'result': 'error'});
    }).on('success', function(room_doc) {
      if(room_doc && room_doc.started) {
        finish();
        res.json({'result': {'status': true}});
      } else {
        continue_polling();
      }
    });
  }, function(complete) {
    rooms.findOne({
      uid: req.param('room')
    }, {
      writers: 1,
      started: 1
    }).on('error', function(e) {
      res.json(500, {'result': 'error'});
      complete();
    }).on('success', function(room_doc) {
      if(room_doc) {
        res.json({'result': {
          'status': room_doc.started,
          'writers': room_doc.writers
        }});
        complete();
      } else {
        res.json(500, {'result': 'error'});
        complete();
      }
    });
  });
});

// PLAY

/*
 * Get play view
 */
app.get('/play/:room/:writer/', function(req, res) {
  async.waterfall([
    // Get room
    function(complete) {
      rooms.findOne({
        uid: req.param('room')
      }).on('error', function(e) {
        complete('not-found');
      }).on('success', function(room_doc) {
        if(room_doc) {
          complete(null, room_doc);
        } else {
          complete('not-found');
        }
      });
    },
    // Calculate status
    function(room_doc, complete) {
      var position = room_doc.turns.indexOf(req.param('writer'));
      var status = '';
      if(position != 0) {
        if(room_doc.turns.length > 2) {
          status = '('+position+')';
        } else {
          status = '(waiting)';
        }
      }
      complete(null, room_doc, status);
    }
  ], function(error, room_doc, status) {
    if(error) {
      if(error === 'not-found') {
        render_404(res, ERROR_ROOM_NOT_FOUND);
      } else {
        res.render('play', {'error': ERROR_UNKNOWN});
      }
    } else {
      res.render('play', {
        room: room_doc,
        user_uid: req.param('writer'),
        status: status
      });
    }
  });
});

/*
 * Finish a story and set up next room
 */
function finish_story(res, room_doc, complete) {
  async.map(room_doc.writers, function(writer, complete) {
    complete(null, writer.name);
  }, function(err, writer_names) {
    async.waterfall([
      // Make story
      function(complete) {
        stories.insert({
          uid: random_util.make_uid(),
          expireAt: date_util.make_expire_at(constants.STORY_TTL),
          text: room_doc.story.join(''),
          writers: writer_names
        }).on('error', function(e) {
          complete('full');
        }).on('success', function(story_doc) {
          complete(null, story_doc);
        });
      },
      // Finish room
      function(story_doc, complete) {
        rooms.findAndModify({
          uid: room_doc.uid,
        }, {
          $set: { finished: story_doc.uid }
        }).on('error', function(e) {
          complete('unknown');
        }).on('success', function(room_doc) {
          if(room_doc) {
            complete(null, story_doc, room_doc);
          } else {
            complete('not-found');
          }
        });
      },
      // Publish finished
      function(story_doc, room_doc, complete) {
        redis_pub.publish('room_play_'+room_doc.uid,
            JSON.stringify({
          'finished_story': story_doc.uid
        }));
        complete(null, story_doc);
      },
      // Make next room
      function(story_doc, complete) {
        var owner_uid = random_util.make_uid();
        var room = create.make_room(owner_uid);
        rooms.insert(room).on('error', function(error) {
          complete('full');
        }).on('success', function(next_room_doc) {
          complete(null, story_doc, next_room_doc);
        });
      },
      // Set up long polling
      function(story_doc, next_room_doc, complete) {
        async.map([
            'room_lobby_'+next_room_doc.uid, 
            'room_play_'+next_room_doc.uid
          ], function(item, complete) {
          setup_long_polling(item, function(e, result) {
            complete();
          });
        }, function(e, results) {
          complete(null, story_doc, next_room_doc);
        });
      },
      // Set next room
      function(story_doc, next_room_doc, complete) {
        rooms.findAndModify({
          uid: room_doc.uid,
        }, {
          $set: { next_room: next_room_doc.uid }
        }).on('error', function(e) {
          complete('unknown');
        }).on('success', function(room_doc) {
          if(room_doc) {
            complete(null, story_doc, next_room_doc);
          } else {
            complete('not-found');
          }
        });
      }
    ], function(error, story_doc, next_room_doc) {
      if(error) {
        complete(error);
      } else {
        res.redirect(util.format('/story/%s/?room=%s&writer=%s',
            story_doc.uid, room_doc.uid, next_room_doc.owner_uid));
        complete('done');
      }
    });
  });
}
/*
 * Finishing story
 */
app.post('/play/:room/:writer', function(req, res) {
  async.waterfall([
    // Get room
    function(complete) {
      rooms.findOne({
        uid: req.param('room')
      }).on('error', function(error) {
        complete('unknown');
      }).on('success', function(room_doc) {
        if(room_doc) {
          complete(null, room_doc);
        } else {
          complete('not-found');
        }
      });
    },
    // Process request
    function(room_doc, complete) {
      // If finish room
      if('action_finish' in req.body 
          && room_doc.owner_uid == req.param('writer')) {
        finish_story(res, room_doc, complete);
      }
    }
  ], function(error) {
    if(error) {
      if(error === 'full') {
        res.render('play', {'error': ERROR_TOO_MANY_STORIES});
      } else if(error === 'unknown') {
        res.render('play', {'error': ERROR_UNKNOWN});
      } else if(error === 'not-found') {
        render_404(res, ERROR_ROOM_NOT_FOUND);
      }
    }
  });
});
/*
 * Posting new word
 */
app.post('/api/1/add-word/:room/:writer/', function(req, res) {
  // Split into words
  words = req.param('word').split(/\s/);
  // If not empty
  if(words && words[0]) {
    first_word = words[0];
    // If first letter not punctuation, add a space
    if(constants.PUNCTUATION.indexOf(first_word[0]) == -1) {
      word = ' '+first_word;
    } else {
      // Otherwise, if just punctuation, add it
      if(words.length == 1) {
        word = first_word;
      } else {
        // Otherwise add punctuation and next word
        word = first_word + ' ' + words[1];
      }
    }
    // Critical section for adding word
    critical_section('room_adding_word_'+req.param('room'), 
        function(release) {
      async.waterfall([
        // Add word and next turn if right turn
        function(complete) {
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
            complete('error');
          }).on('success', function(room_doc) {
            complete(null, room_doc);
          });
        },
        // If found, increment turn, and pop current turn
        function(room_doc, complete) {
          if(room_doc) {
            rooms.findAndModify({
              _id: room_doc._id
            }, {
              $pop: { turns: -1 },
              $inc: { turn: 1 }
            }, {
              new: true,
              fields: { 
                turn: 1,
                story: 1, 
                turns: 1
              }
            }).on('error', function(e) {
              complete('error');
            }).on('success', function(room_doc) {
              var payload = {
                story: room_doc.story, 
                turns: room_doc.turns,
                turn: room_doc.turn,
                writer: req.param('writer')
              };
              redis_pub.publish('room_play_'+req.param('room'), 
                  JSON.stringify(payload));
              complete(null, payload);
            });
          } else {
            complete(null, 'wrong-turn');
          }
        }
      ], function(error, result) {
        release(function() {
          if(error) {
            res.json(500, {result: error});
          } else {
            res.json({result: result});
          }
        });
      });
    }, function(error) {
      if(error) {
        res.json(500, {result: 'error'});
      } else {
        res.json({result: 'wrong-turn'});
      }
    });
  } else {
    res.json({result: 'empty-word'});
  }
});
/**
 * Polling for play state
 */
app.get('/api/1/polling/play/:room/:writer/:turn/', function(req, res) {
  subscribe_long_polling(req, 'room_play_'+req.param('room'), function(result) {
    return result.writer !== req.param('writer');
  }, function(result) {
    res.json({'result': result});
  }, function(finish, continue_polling) {
    rooms.findOne({
      uid: req.param('room'),
    }, {
      finished: 1,
      turn: 1,
      story: 1,
      turns: 1
    }).on('error', function(error) {
      res.json(500, {'result': 'error'});
      finish();
    }).on('success', function(room_doc) {
      if(room_doc) {
        if(room_doc.finished) {
          res.json({'result': {'finished_story': room_doc.finished}});
        } else if(room_doc.turn === parseInt(req.param('turn'))) {
          continue_polling();
        } else {
          var payload = {
            story: room_doc.story, 
            turns: room_doc.turns,
            turn: room_doc.turn
          };
          res.json({'result': payload});
          finish();
        }
      } else {
        res.json(500, {'result': 'error'});
        finish();
      }
    });
  }, function(complete) {
    rooms.findOne({
      uid: req.param('room')
    }, {
      turn: 1,
      story: 1,
      turns: 1
    }).on('error', function(e) {
      res.json(500, {'result': 'error'});
      complete();
    }).on('success', function(room_doc) {
      if(room_doc) {
        var payload = {
          story: room_doc.story, 
          turns: room_doc.turns,
          turn: room_doc.turn
        };
        res.json({'result': payload});
      } else {
        res.json(500, {'result': 'error'});
      }
      complete();
    });
  });
});

// CREATE

/*
 * Show create page
 */
app.get('/create/', function(req, res) {
  res.render('create')
});
/* 
 * Process create page
 */
app.post('/create/', function(req, res) {
  create.create_room_with_passphrase(req.param('passphrase'),
      function(error, room_doc, owner_uid) {
    if(error) {
      if(error === 'full') {
        res.render('create', {'error': ERROR_TOO_MANY_PEOPLE});
      } else if(error === 'unknown') {
        res.render('create', {'error': ERROR_UNKNOWN});
      } else if(error === 'taken') {
        res.render('create', {'error': ERROR_PASSPHRASE_TAKEN});
      }
    } else {
      res.redirect(util.format('/join/%s/%s/',
          room_doc.uid, owner_uid));
    }
  });
});
/*
 * Create api
 */
app.post('/api/1/create/', function(req, res) {
  create.create_room_with_passphrase(req.param('passphrase'),
      function(error, room_doc, owner_uid) {
    if(error) {
      res.json(500, {'result': error});
    } else {
      res.json({'room': room_doc.uid, 'owner': owner_uid});
    }
  });
});

// RUN

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  console.log("Listening on " + port);
});
