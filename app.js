
var pmx     = require('pmx');
var pm2     = require('pm2');

var conf = pmx.initModule();

// Connect to local PM2
pm2.connect(function() {

  setInterval(function() {

    // Get process list managed by PM2
    pm2.list(function(err, apps) {

      apps.forEach(function(app) {

        // Get error and out file
        var out_file = app.pm2_env.pm_out_log_path;
        var err_file = app.pm2_env.pm_err_log_path;

        // Do some processing
        console.log(out_file, err_file);
      });

    });
  }, 1000);

});
