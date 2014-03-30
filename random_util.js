var Chance = require('chance');
var random = new Chance();

var unique_opts = {
  pool: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  length: 16
};

exports.make_uid = function() {
  return random.string(unique_opts);
}