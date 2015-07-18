var fs      = require('fs');
var pmx     = require('pmx');
var pm2     = require('pm2');
var moment  = require('moment');

var conf = pmx.initModule();
var WORKER_INTERVAL = 1000 * 20; // 20seconds
var SIZE_LIMIT = parseInt(conf.max_size) || 1024 * 1024 * 10; // 10MB
var INTERVAL_UNIT = conf.interval_unit || 'DD'; // MM = months, DD = days, mm = minutes
var INTERVAL = parseInt(conf.interval) || 1; // INTERVAL:1 * INTERVAL_UNIT:days
                  // means it will cut files every 24H
                  // eg : INTERVAL:2 and INTERVAL_UNIT:'mm' will cut files every 2 minutes

var NOW = parseInt(moment().format(INTERVAL_UNIT));
var DATE_FORMAT = 'YYYY-MM-DD-HH-mm';
var durationLegend = {
  MM: 'M',
  DD: 'd',
  mm: 'm'
};
function proceed(file) {
  var final_name = file.substr(0, file.length - 4) + '__'
    + moment().subtract(1, durationLegend[INTERVAL_UNIT]).format(DATE_FORMAT.substring(0, DATE_FORMAT.lastIndexOf(INTERVAL_UNIT)+2)) + '.log';

  var buffer = fs.readFileSync(file);
  fs.writeFileSync(final_name, buffer);
  buffer = null;

  fs.truncateSync(file, 0);

  console.log('"' + final_name + '" has been created');
}

function proceed_file(file, force) {
  if (!fs.existsSync(file))
    return;

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

function is_it_time_yet() {
  var max_value = INTERVAL_UNIT == 'MM' ? 12 : 60;

  if (NOW + INTERVAL == parseInt(moment().format(INTERVAL_UNIT))
      || NOW + INTERVAL == parseInt(moment().format(INTERVAL_UNIT)) - max_value) {
    NOW = parseInt(moment().format(INTERVAL_UNIT));
    return true;
  }
  else {
    return false;
  }
}

// Connect to local PM2
pm2.connect(function(err) {
  if (err) return console.error(err.stack || err);

  function worker() {
    // Get process list managed by PM2
    pm2.list(function(err, apps) {
      if (err) return console.error(err.stack || err);

      proceed_file(process.env.HOME + '/.pm2/pm2.log', false);
      proceed_file(process.env.HOME + '/.pm2/agent.log', false);

      if (is_it_time_yet())
        apps.forEach(function(app) {proceed_app(app, true)});
      else
        apps.forEach(function(app) {proceed_app(app, false)});
    });
    setTimeout(worker, (WORKER_INTERVAL - (Date.now() % WORKER_INTERVAL)));
  };
  worker();
});
