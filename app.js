var fs      = require('fs');
var pmx     = require('pmx');
var pm2     = require('pm2');
var moment  = require('moment');

var conf = pmx.initModule();
var WORKER_INTERVAL = 1000 * 10; // 10seconds
var SIZE_LIMIT = 1024 * 1024 * 5; // 5MB
var TODAY = moment().format('DD');

function proceed(file) {
  var final_name = file.substr(0, file.length - 4) + '__'
    + moment().format('MM-DD-YYYY-HH-mm-ss') + '.log';

  var buffer = fs.readFileSync(file);
  fs.writeFileSync(final_name, buffer);
  buffer = null;

  fs.truncateSync(file, 0);

  console.log('"' + final_name + '" has been created');
}

function proceed_file(file, force) {
  var size = fs.statSync(file).size;

  if (size >= SIZE_LIMIT || force) {
    proceed(file);
  }
}

function proceed_app(app, force) {
  // Get error and out file
  var out_file = app.pm2_env.pm_out_log_path;
  var err_file = app.pm2_env.pm_err_log_path;

  proceed_file(out_file, force);
  proceed_file(err_file, force);
}

function day_has_changed() {
  if (TODAY === moment().format('DD')) {
    return false;
  }
  else {
    TODAY = moment().format('DD');
    return true;
  }
}

// Connect to local PM2
pm2.connect(function(err) {
  if (err) return console.error(err.stack || err);

  function worker() {
    // Get process list managed by PM2
    pm2.list(function(err, apps) {
      if (err) return console.error(err.stack || err);

      if (day_has_changed())
        apps.forEach(function(app) {proceed_app(app, true)});
      else
        apps.forEach(function(app) {proceed_app(app, false)});
    });
    setTimeout(worker, WORKER_INTERVAL);
  };
  worker();
});
