/**
 * New Relic agent configuration.
 *
 * See lib/config.defaults.js in the agent distribution for a more complete
 * description of configuration variables and their potential values.
 */
exports.config = {
  /**
   * Array of application names.
   */
  app_name : ['In A World'],
  /**
   * Your New Relic license key.
   */
  license_key : 'e8330cad3a26f45fe7e6b2b9f0e147d61cfa8d7d',
  logging : {
    /**
     * Level at which to log. 'trace' is most useful to New Relic when diagnosing
     * issues with the agent, 'info' and higher will impose the least overhead on
     * production applications.
     */
    level : 'trace'
  },
  rules: {
    ignore: [
      '^/api/.*/polling/.*'
    ]
  }
};
