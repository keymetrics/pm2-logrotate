var fs      	= require('graceful-fs');
var path    	= require('path');
var pmx     	= require('pmx');
var pm2     	= require('pm2');
var moment  	= require('moment-timezone');
var scheduler	= require('node-schedule');
var zlib      = require('zlib');

var conf = pmx.initModule({
  widget : {
    type             : 'generic',
    logo             : 'https://raw.githubusercontent.com/pm2-hive/pm2-logrotate/master/pres/logo.png',
    theme            : ['#111111', '#1B2228', '#31C2F1', '#807C7C'],
    el : {
      probes  : false,
      actions : false
    },
    block : {
      issues  : true,
      cpu: true,
      mem: true,
      actions : true,
      main_probes : ['Global logs size', 'Files count']
    }
  }
});

var PM2_ROOT_PATH = '';
var Probe = pmx.probe();

if (process.env.PM2_HOME)
  PM2_ROOT_PATH = process.env.PM2_HOME;
else if (process.env.HOME && !process.env.HOMEPATH)
  PM2_ROOT_PATH = path.resolve(process.env.HOME, '.pm2');
else if (process.env.HOME || process.env.HOMEPATH)
  PM2_ROOT_PATH = path.resolve(process.env.HOMEDRIVE, process.env.HOME || process.env.HOMEPATH, '.pm2');

var WORKER_INTERVAL = isNaN(parseInt(conf.workerInterval)) ? 30 * 1000 : 
                            parseInt(conf.workerInterval) * 1000; // default: 30 secs
var SIZE_LIMIT = get_limit_size(); // default : 10MB
var ROTATE_CRON = conf.rotateInterval || "0 0 * * *"; // default : every day at midnight
var RETAIN = isNaN(parseInt(conf.retain)) ? undefined : parseInt(conf.retain); // All
var COMPRESSION = JSON.parse(conf.compress) || false; // Do not compress by default
var DATE_FORMAT = conf.dateFormat || 'YYYY-MM-DD_HH-mm-ss';
var TZ = conf.TZ;
var ROTATE_MODULE = JSON.parse(conf.rotateModule) || true;
var WATCHED_FILES = [];

function get_limit_size() {
  if (conf.max_size === '')
    return (1024 * 1024 * 10);
  if (typeof(conf.max_size) !== 'string')
      conf.max_size = conf.max_size + "";
  if (conf.max_size.slice(-1) === 'G')
    return (parseInt(conf.max_size) * 1024 * 1024 * 1024);
  if (conf.max_size.slice(-1) === 'M')
    return (parseInt(conf.max_size) * 1024 * 1024);
  if (conf.max_size.slice(-1) === 'K')
    return (parseInt(conf.max_size) * 1024);
  return parseInt(conf.max_size);
}

function delete_old(file) {
  if (file === "/dev/null") return;
  var fileBaseName = file.substr(0, file.length - 4).split('/').pop() + "__";
  var dirName = path.dirname(file);

  fs.readdir(dirName, function(err, files) {
    var i, len;
    if (err) return pmx.notify(err);

    var rotated_files = [];
    for (i = 0, len = files.length; i < len; i++) {
      if (files[i].indexOf(fileBaseName) >= 0)
        rotated_files.push(files[i]);
    }
    rotated_files.sort().reverse();

    for (i = rotated_files.length - 1; i >= RETAIN; i--) {
      (function(i) {
        fs.unlink(path.resolve(dirName, rotated_files[i]), function (err) {
          if (err) return console.error(err);
          console.log('"' + rotated_files[i] + '" has been deleted');
        });
      })(i);
    }
  });
}


/**
 * Apply the rotation process of the log file.
 *
 * @param {string} file 
 */
function proceed(file) {
  // set default final time
  var final_time = moment().format(DATE_FORMAT);
  // check for a timezone
  if (TZ) {
    try {
      final_time = moment().tz(TZ).format(DATE_FORMAT);
    } catch(err) {
      // use default
    }
  }
  var final_name = file.substr(0, file.length - 4) + '__' + final_time + '.log';
  // if compression is enabled, add gz extention and create a gzip instance
  if (COMPRESSION) {
    var GZIP = zlib.createGzip({ level: zlib.Z_BEST_COMPRESSION, memLevel: zlib.Z_BEST_COMPRESSION });
    final_name += ".gz";
  }

  // create our read/write streams
	var readStream = fs.createReadStream(file);
	var writeStream = fs.createWriteStream(final_name, {'flags': 'w+'});

  // pipe all stream
  if (COMPRESSION)
    readStream.pipe(GZIP).pipe(writeStream);
  else 
    readStream.pipe(writeStream);
  

  // listen for error
  readStream.on('error', pmx.notify.bind(pmx));
  writeStream.on('error', pmx.notify.bind(pmx));
  if (COMPRESSION) {
    GZIP.on('error', pmx.notify.bind(pmx));
  }

 // when the read is done, empty the file and check for retain option
  writeStream.on('finish', function() {
    if (GZIP) {
      GZIP.close();
    }
    readStream.close();
    writeStream.close();
    fs.truncate(file, function (err) {
      if (err) return pmx.notify(err);
      console.log('"' + final_name + '" has been created');

      if (typeof(RETAIN) === 'number') 
        delete_old(file);
    });
  });
}


/**
 * Apply the rotation process if the `file` size exceeds the `SIZE_LIMIT`.
 * 
 * @param {string} file
 * @param {boolean} force - Do not check the SIZE_LIMIT and rotate everytime.
 */
function proceed_file(file, force) {
  if (!fs.existsSync(file)) return;
  
  if (!WATCHED_FILES.includes(file)) {
    WATCHED_FILES.push(file);
  }

  fs.stat(file, function (err, data) {
    if (err) return console.error(err);

    if (data.size > 0 && (data.size >= SIZE_LIMIT || force)) 
      proceed(file);
  });
}


/**
 * Apply the rotation process of all log files of `app` where the file size exceeds the`SIZE_LIMIT`.
 * 
 * @param {Object} app
 * @param {boolean} force - Do not check the SIZE_LIMIT and rotate everytime.
 */
function proceed_app(app, force) {
  // Check all log path
  // Note: If same file is defined for multiple purposes, it will be processed once only.
  if (app.pm2_env.pm_out_log_path) {
    proceed_file(app.pm2_env.pm_out_log_path, force);
  }
  if (app.pm2_env.pm_err_log_path && app.pm2_env.pm_err_log_path !== app.pm2_env.pm_out_log_path) {
    proceed_file(app.pm2_env.pm_err_log_path, force);
  }
  if (app.pm2_env.pm_log_path && app.pm2_env.pm_log_path !== app.pm2_env.pm_out_log_path && app.pm2_env.pm_log_path !== app.pm2_env.pm_err_log_path) {
    proceed_file(app.pm2_env.pm_log_path, force);
  }
}

// Connect to local PM2
pm2.connect(function(err) {
  if (err) return console.error(err.stack || err);

  // start background task
  setInterval(function() {
    // get list of process managed by pm2
    pm2.list(function(err, apps) {
      if (err) return console.error(err.stack || err);

      var appMap = {};
      // rotate log that are bigger than the limit
      apps.forEach(function(app) {
          // if its a module and the rotate of module is disabled, ignore
          if (typeof(app.pm2_env.axm_options.isModule) !== 'undefined' && !ROTATE_MODULE) return ;

          // if apps instances are multi and one of the instances has rotated, ignore
          if(app.pm2_env.instances > 1 && appMap[app.name]) return;
          
          appMap[app.name] = app;
          
          proceed_app(app, false);
      });
    });

    // rotate pm2 log
    proceed_file(PM2_ROOT_PATH + '/pm2.log', false);
    proceed_file(PM2_ROOT_PATH + '/agent.log', false);
  }, WORKER_INTERVAL);

  // register the cron to force rotate file
  scheduler.scheduleJob(ROTATE_CRON, function () {
    // get list of process managed by pm2
    pm2.list(function(err, apps) {
        if (err) return console.error(err.stack || err);

        var appMap = {};
        // force rotate for each app
        apps.forEach(function(app) {
          // if its a module and the rotate of module is disabled, ignore
          if (typeof(app.pm2_env.axm_options.isModule) !== 'undefined' && !ROTATE_MODULE) return ;

          // if apps instances are multi and one of the instances has rotated, ignore
          if(app.pm2_env.instances > 1 && appMap[app.name]) return;

          appMap[app.name] = app;

          proceed_app(app, true);
        });
      });
  });
});

/**  ACTION PMX **/
pmx.action('list watched logs', function(reply) {
  var returned = {};
  WATCHED_FILES.forEach(function (file) {
        returned[file] = (fs.statSync(file).size);
  });
  return reply(returned);
});

pmx.action('list all logs', function(reply) {
  var returned = {};
  var folder = PM2_ROOT_PATH + "/logs";
  fs.readdir(folder, function (err, files) {
      if (err) {
        console.error(err.stack || err);
        return reply(0)
      }

      files.forEach(function (file) {
        returned[file] = (fs.statSync(folder + "/" + file).size);
      });
      return reply(returned);
  });
});

/** PROB PMX **/
var metrics = {};
metrics.totalsize = Probe.metric({
    name  : 'Global logs size',
    value : 'N/A'
});

metrics.totalcount = Probe.metric({
    name  : 'Files count',
    value : 'N/A'
});

// update folder size of logs every 10secs
function updateFolderSizeProbe() {
  var returned = 0;
  var folder = PM2_ROOT_PATH + "/logs";
  fs.readdir(folder, function (err, files) {
    if (err) {
         console.error(err.stack || err);
         return metrics.totalsize.set("N/A");
    }

    files.forEach(function (file, idx, arr) {
       returned += fs.statSync(folder + "/" + file).size;
    });

    metrics.totalsize.set(handleUnit(returned, 2));
  });
}
updateFolderSizeProbe();
setInterval(updateFolderSizeProbe, 30000);

// update file count every 10secs
function updateFileCountProbe() {
  fs.readdir(PM2_ROOT_PATH + "/logs", function (err, files) {
      if (err) {
        console.error(err.stack || err);
        return metrics.totalcount.set(0);
      }

      return  metrics.totalcount.set(files.length);
  });
}
updateFileCountProbe();
setInterval(updateFileCountProbe, 30000);

function handleUnit(bytes, precision) {
  var kilobyte = 1024;
  var megabyte = kilobyte * 1024;
  var gigabyte = megabyte * 1024;
  var terabyte = gigabyte * 1024;

  if ((bytes >= 0) && (bytes < kilobyte)) {
    return bytes + ' B';
  } else if ((bytes >= kilobyte) && (bytes < megabyte)) {
    return (bytes / kilobyte).toFixed(precision) + ' KB';
  } else if ((bytes >= megabyte) && (bytes < gigabyte)) {
    return (bytes / megabyte).toFixed(precision) + ' MB';
  } else if ((bytes >= gigabyte) && (bytes < terabyte)) {
    return (bytes / gigabyte).toFixed(precision) + ' GB';
  } else if (bytes >= terabyte) {
    return (bytes / terabyte).toFixed(precision) + ' TB';
  } else {
    return bytes + ' B';
  }
}
