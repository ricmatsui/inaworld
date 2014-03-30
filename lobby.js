module.exports = function(rooms, redis_util) {
  var lobby = {}
  lobby.lobby = function(room_uid, complete) {
    rooms.findOne({
      uid: room_uid
    }).on('error', function(e) {
      complete('unknown');
    }).on('success', function(room_doc) {
      if(room_doc) {
        complete(null, room_doc);
      } else {
        complete('not-found');
      }
    });
  };
  return lobby;
};