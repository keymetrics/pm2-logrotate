var fs      = require('fs');
var path    = require('path');
var pmx     = require('pmx');
var pm2     = require('pm2');
var moment  = require('moment');
var Rolex   = require('rolex');

var conf = pmx.initModule({

  widget : {
    type             : 'generic',
    logo             : 'http://web.townsendsecurity.com/Portals/15891/images/logging.png',
    theme            : ['#111111', '#1B2228', '#31C2F1', '#807C7C'],
    el : {
      probes  : false,
      actions : false
    },

    block : {
      issues  : false,
      cpu: false,
      mem: false,
      actions : true
    }
  }
});


var WORKER_INTERVAL = moment.duration(50, 'seconds').asMilliseconds();
var SIZE_LIMIT = get_limit_size(); // 10MB
var INTERVAL_UNIT = conf.interval_unit || 'DD'; // MM = months, DD = days, mm = minutes
var INTERVAL = parseInt(conf.interval) || 1; // INTERVAL:1 day
var RETAIN = isNaN(parseInt(conf.retain))? undefined: parseInt(conf.retain); // All
var WHITE_LIST = conf.white_list || '';

var NOW = parseInt(moment().format(INTERVAL_UNIT));
var DATE_FORMAT = 'YYYY-MM-DD-HH-mm';
var durationLegend = {
  MM: 'M',
  DD: 'd',
  mm: 'm'
};

var gl_file_list = [];

function get_limit_size() {
  if (conf.max_size == '')
    return (1024 * 1024 * 10);
  if (typeof(conf.max_size) !== 'string')
      conf.max_size = conf.max_size.toString();
  if (conf.max_size.slice(-1) === 'G')
    return (parseInt(conf.max_size) * 1024 * 1024 * 1024);
  if (conf.max_size.slice(-1) === 'M')
    return (parseInt(conf.max_size) * 1024 * 1024);
  if (conf.max_size.slice(-1) === 'K')
    return (parseInt(conf.max_size) * 1024);
  return parseInt(conf.max_size);
}

function delete_old(file) {
  var fileBaseName = file.substr(0, file.length - 4) + '__';
  var readPath = path.join(path.dirname(fileBaseName), "/");

  fs.readdir(readPath, function(err, files) {
    var rotated_files = []
    for (var i = 0, len = files.length; i < len; i++) {
      if (fileBaseName === ((readPath + files[i]).substr(0, fileBaseName.length))) {
        rotated_files.push(readPath + files[i])
      }
    }
    rotated_files.sort().reverse();

    for (var i = rotated_files.length - 1; i >= 0; i--) {
      if (RETAIN > i) { break; }
      fs.unlink(rotated_files[i]);
      console.log('"' + rotated_files[i] + '" has been deleted');
    };
  });
}

function proceed(file) {
  var final_name = file.substr(0, file.length - 4) + '__'
    + moment().subtract(1, durationLegend[INTERVAL_UNIT]).format(DATE_FORMAT) + '.log';

    function pipeNew(final_name) {
        // if log-file is big, pipe duration will longer than interval-time
        var readStream = fs.createReadStream(file);
        var writeStream = fs.createWriteStream(final_name, {'flags': 'a'});
        readStream.pipe(writeStream);
        readStream.on('end', function() {
            fs.truncateSync(file, 0);
            console.log('"' + final_name + '" has been created');

            if (RETAIN !== undefined) {
                delete_old(file);
            }
        });
    }

    //app-pid__2016-06-16-14-44
    var fileName = final_name.slice(final_name.lastIndexOf('/') + 1, final_name.length).replace('.log', '');
    var path = file.slice(0, final_name.lastIndexOf('/'));
    fs.readdir(path, function(err, files) {
        //get log versions
        var versions = files.map(function(f) {
            var reg = new RegExp(fileName + '(__(\\d+))?\\.log');
            var matchs = f.match(reg);
            if (matchs && matchs.length == 3) {
                return parseInt(matchs[2] || 0);
            }
            return ''
        }).filter(function(i) {
            return i !== '' && !isNaN(i);
        }).sort(function(a, b) {
            return a < b
        });

        if (versions.length) {
            //app-pid__2016-06-15__1.log
            final_name = path + '/' + fileName + '__' + (versions[0] + 1) + '.log';
        }

        pipeNew(final_name);
    });

    /*
    fs.rename(file, final_name, function() {
        fs.writeFile(file, '', 'utf8', function() {
            pm2.flush()
            console.log('"' + final_name + '" has been created');
            if (RETAIN !== undefined) {
                delete_old(file);
            }
        })
    });
    */
}

function proceed_file(file, force) {
  if (!fs.existsSync(file))
    return;

  gl_file_list.push(file);

  var size = fs.statSync(file).size;

  if (size > 0 && (size >= SIZE_LIMIT || force)) {
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
        apps.forEach(function(app) {
          if (WHITE_LIST && WHITE_LIST.indexOf(app.name) > -1) return;
          proceed_app(app, true)
        });
      else
        apps.forEach(function(app) {
          if (WHITE_LIST && WHITE_LIST.indexOf(app.name) > -1) return;
          proceed_app(app, false)
        });
    });
  };

  setTimeout(function() {
    setInterval(function(){
      gl_file_list = [];
      worker();
    }, WORKER_INTERVAL);
  }, (WORKER_INTERVAL - (Date.now() % WORKER_INTERVAL)));
});

pmx.action('list files', function(reply) {
  return reply(gl_file_list);
});
