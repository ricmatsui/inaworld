module.exports = function(rooms, redis_util) {
  var join = {}
  join.join_room = function(room_uid, writer_uid, name, complete) {
    rooms.findAndModify({
      uid: room_uid,
    }, {
      $push: { writers: { uid: writer_uid, name: name }}
    }, {
      new: true
    }).on('error', function(e) {
      complete('unknown');
    }).on('success', function(room_doc) {
      redis_util.redis_pub.publish('room_lobby_'+room_uid, JSON.stringify({
        writers: room_doc.writers
      }));
      complete();
    });
  };
  return join
};