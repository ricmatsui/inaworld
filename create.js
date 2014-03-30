var async = require('async');
require('datejs');
var debug = require('debug')('inaworld:create');

var date_util = require('./date_util.js');
var random_util = require('./random_util.js');

module.exports = function(rooms, passphrases, redis_util, constants) {
  /**
   * Makes a new room with owner and default values
   */
  var make_room = function(owner_uid) {
    return {
      uid: random_util.make_uid(),
      expireAt: date_util.make_expire_at(constants.ROOM_TTL),
      story: ['In', ' a', ' world'],
      writers: [],
      turns: [],
      turn: 1,
      started: false,
      finished: false,
      owner_uid: owner_uid
    };
  };

  /**
   * Creates a new room and updates the passphrase to link to it.
   */
  var create_room = function(passphrase_doc, complete) {
    // Create a new owner UID
    var owner_uid = random_util.make_uid();

    async.waterfall([
      // Insert new room
      function(complete) {
        var room = make_room(owner_uid);
        room.passphrase = passphrase_doc.name;
        rooms.insert(room).on('error', function(error) {
          complete('full');
        }).on('success', function(room_doc) {
          complete(null, room_doc);
        });
      },
      // Update passphrase
      function(room_doc, complete) {
        passphrases.updateById(passphrase_doc._id, {
          $set: { room_uid: room_doc.uid }
        }).on('error', function(error) {
          complete('unknown');
        }).on('success', function() {
          complete(null, room_doc);
        });
      },
      // Set up long polling
      function(room_doc, complete) {
        async.map(['room_lobby_'+room_doc.uid, 'room_play_'+room_doc.uid], 
            function(item, complete) {
          redis_util.setup_long_polling(item, function(e, result) {
            complete();
          });
        }, function(e, results) {
          complete(null, room_doc);
        });
      }
    ], function(error, room_doc) {
      if(error) {
        debug('error creating room: '+error);
        complete(error);
      } else {
        complete(null, room_doc, owner_uid);
      }
    });
  }
  
  var create_room_with_passphrase = function(passphrase, complete) {
    var room_passphrase_doc = null;
    async.series([
      // Try to register new passphrase
      function(complete) {
        passphrases.insert({
          name: passphrase,
          expireAt: date_util.make_expire_at(constants.PASSPHRASE_TTL)
        }).on('error', function(error) {
          debug('duplicate passphrase, attempting to update');
          complete();
        }).on('success', function(passphrase_doc) {
          room_passphrase_doc = passphrase_doc;
          complete();
        });
      },
      // If not successful, try updating current if expired
      function(complete) {
        if(room_passphrase_doc) {
          complete();
        } else {
          // Find if expired
          passphrases.findAndModify({
            name: passphrase,
            expireAt: { $lt: new Date() }
          }, {
            $set: { expireAt: date_util.make_expire_at(constants.PASSPHRASE_TTL) }
          }).on('error', function(e) {
            complete('unknown');
          }).on('success', function(passphrase_doc) {
            if(passphrase_doc) {
              // Passphrase already expired
              room_passphrase_doc = passphrase_doc;
            }
            complete();
          });
        }
      }
    ], function(error, results) {
      if(error) {
        debug('error registering passphrase: '+error);
        complete(error);
      } else if(room_passphrase_doc) {
        create_room(room_passphrase_doc, complete);
      } else {
        debug('passphrase not expired');
        complete('taken');
      }
    });
  };
  
  return {
    make_room: make_room,
    create_room: create_room,
    create_room_with_passphrase: create_room_with_passphrase
  };
}