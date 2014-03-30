require('datejs');

/*
 * Returns a new expiration date
 */
exports.make_expire_at = function(seconds_in_future) {
  return (new Date()).add(seconds_in_future).second();
}