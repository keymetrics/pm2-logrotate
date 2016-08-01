var fs      	= require('fs');
var path    	= require('path');
var pmx     	= require('pmx');
var pm2     	= require('pm2');
var moment  	= require('moment-timezone');
var scheduler	= require('node-schedule');
var zlib      = require('zlib');

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

var WORKER_INTERVAL = isNaN(parseInt(conf.workerInterval)) ? 30 * 1000 : 
                            parseInt(conf.workerInterval) * 1000; // default: 30 secs
var SIZE_LIMIT = get_limit_size(); // default : 10MB
var ROTATE_CRON = conf.rotateInterval || "0 0 * * *"; // default : every day at midnight
var RETAIN = isNaN(parseInt(conf.retain))? undefined : parseInt(conf.retain); // All
var COMPRESSION = conf.compress || false; // Do not compress by default
var DATE_FORMAT = conf.dateFormat || 'YYYY-MM-DD_HH-mm-ss';
var WATCHED_FILES = [];
var GZIP = zlib.createGzip({ level: zlib.Z_BEST_COMPRESSION
    , memLevel: zlib.Z_BEST_COMPRESSION });

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
    + moment().format(DATE_FORMAT) + '.log';
  // if compression is enabled, add gz extention
  if (COMPRESSION)
    final_name += ".gz";

	var readStream = fs.createReadStream(file);
	var writeStream = fs.createWriteStream(final_name, {'flags': 'a'});
  
  if (COMPRESSION) {
    readStream.pipe(GZIP).pipe(writeStream);
  } else {
    readStream.pipe(writeStream);
  }
	
	readStream.on('end', function() {
		fs.truncateSync(file, 0);
		console.log('"' + final_name + '" has been created');

		if (RETAIN !== undefined) {
			delete_old(file);
		}
	});
}

function proceed_file(file, force) {
  if (!fs.existsSync(file))
    return;
  
  WATCHED_FILES.push(file);
  var size = fs.statSync(file).size;

  if (size > 0 && (size >= SIZE_LIMIT || force)) {
      console.log("rotate with force " + force)
    proceed(file);
  }
}

function proceed_app(app, force) {
  // Check all log path
  proceed_file(app.pm2_env.pm_out_log_path, force);
  proceed_file(app.pm2_env.pm_err_log_path, force);
  proceed_file(app.pm2_env.pm_log_path, force);
}

// Connect to local PM2
pm2.connect(function(err) {
  if (err) return console.error(err.stack || err);

  // start background task
  setInterval(function() {
    // get list of process managed by pm2
    pm2.list(function(err, apps) {
      if (err) return console.error(err.stack || err);

      // reset the watched files
      WATCHED_FILES = [];

      // rotate log that are bigger than the limit
      apps.forEach(function(app) {
         proceed_app(app, false);
      });
    });

    // rotate pm2 log
    proceed_file(process.env.HOME + '/.pm2/pm2.log', false);
    proceed_file(process.env.HOME + '/.pm2/agent.log', false);
  }, WORKER_INTERVAL);

  // register the cron to force rotate file
  scheduler.scheduleJob(ROTATE_CRON, function () {
    // get list of process managed by pm2
    pm2.list(function(err, apps) {
        if (err) return console.error(err.stack || err);

        // force rotate for each logs
        apps.forEach(function(app) {
          proceed_app(app, true);
        });
      });
  });
})

pmx.action('list files', function(reply) {
  return reply(WATCHED_FILES);
});