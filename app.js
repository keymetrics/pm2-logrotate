var pmx = require('pmx')
var pm2 = require('pm2')
var fs = require('graceful-fs')
var path = require('path')
var moment = require('moment-timezone')
var bytes = require('./utils/bytes.js')
var randomString = require('./utils/randomString.js')
var schedule = require('node-schedule')
var zlib = require('zlib')

var WATCHED_FILES = []

if (require.main === module) {
  pmx.initModule({
    widget: {
      type: 'generic',
      logo: 'https://raw.githubusercontent.com/pm2-hive/pm2-logrotate/master/pres/logo.png',
      theme: ['#111111', '#1B2228', '#31C2F1', '#807C7C'],
      el: {
        probes: false,
        actions: false
      },
      block: {
        issues: true,
        cpu: true,
        mem: true,
        actions: true,
        main_probes: ['Global logs size', 'Files count']
      }
    }
  }, function (err, conf) {
    if (err) return console.error(err)

    var config = {
      workerInterval: (conf.workerInterval) ? conf.workerInterval * 1000 : 30000,
      maxSize: (typeof (conf.max_size) !== 'string') ? conf.max_size.toString() : bytes(conf.max_size),
      rotateCron: conf.rotateInterval || '0 0 * * *',
      retain: isNaN(parseInt(conf.retain)) ? undefined : parseInt(conf.retain),
      compress: conf.compress || false,
      dateFormat: (conf.dateFormat === undefined) ? 'YYYY-MM-DD_HH-mm-ss' : conf.dateFormat,
      rotateModule: (conf.rotateModule === undefined) ? false : conf.rotateModule,
      rotateOut: (conf.rotateOut === undefined) ? true : conf.rotateOut,
      rotateErr: (conf.rotateErr === undefined) ? true : conf.rotateErr
    }
    if (process.env.PM2_HOME) {
      config.pm2RootPath = process.env.PM2_HOME
    } else if (process.env.HOME && !process.env.HOMEPATH) {
      config.pm2RootPath = path.join(process.env.HOME, '.pm2')
    } else if (process.env.HOME || process.env.HOMEPATH) {
      config.pm2RootPath = path.join(process.env.HOMEDRIVE, process.env.HOME || process.env.HOMEPATH, '.pm2')
    }

    var Probe = pmx.probe()

    /** PROB PMX **/
    var metrics = {}
    metrics.totalsize = Probe.metric({
      name: 'Global logs size',
      value: 'N/A'
    })
    metrics.totalcount = Probe.metric({
      name: 'Files count',
      value: 'N/A'
    })

    // Update metrics every 30 secondes
    setInterval(function () {
      // Get files in logs folder
      fs.readdir(config.pm2RootPath + '/logs', function (err, files) {
        if (err) return pmx.notify.bind(err)

        var size = 0
        // Number of files
        metrics.totalcount.set(files.length)
        // Size of files
        files.forEach(function (file) {
          size += fs.statSync(config.pm2RootPath + '/logs/' + file).size
        })
        metrics.totalsize.set(bytes(size))
      })
    }, 30000)

    // Connect to local PM2
    pm2.connect(function (err) {
      if (err) return console.error(err.stack || err)

      if (config.workerInterval !== -1) {
        // start background task
        setInterval(function () {
          // get list of process managed by pm2 and proceed
          worker.getApps(config)
        }, config.workerInterval)
      }
      // cron job
      schedule.scheduleJob(config.rotateCron, function () {
        // get list of process managed by pm2 and proceed
        worker.getApps(config)
      })
    })

    /**  ACTION PMX **/
    pmx.action('list watched logs', function (reply) {
      var returned = {}
      WATCHED_FILES.forEach(function (file) {
        returned[file] = fs.statSync(file).size
      })
      return reply(returned)
    })
    pmx.action('list all logs', function (reply) {
      var returned = {}
      var folder = config.pm2RootPath + '/logs'
      fs.readdir(folder, function (err, files) {
        if (err) {
          console.error(err.stack || err)
          return reply(0)
        }

        files.forEach(function (file) {
          returned[file] = fs.statSync(folder + '/' + file).size
        })
        return reply(returned)
      })
    })
  })
}

var worker = {
  getApps: function (config) {
    // Get list of apps
    pm2.list(function (err, apps) {
      if (err) return console.error(err.stack || err)

      // Proceed every apps
      apps.forEach(function (app) {
        if (app.pm2_env.axm_options.isModule && !config.rotateModule) return

        if (config.rotateOut) {
          worker.proceed(config, app.pm2_env.pm_out_log_path, false)
        }
        if (config.rotateErr) {
          worker.proceed(config, app.pm2_env.pm_err_log_path, false)
        }
        worker.proceed(config, app.pm2_env.pm_log_path, false)
      })
    })
    worker.proceed(config, config.pm2RootPath + '/pm2.log', false)
    worker.proceed(config, config.pm2RootPath + '/agent.log', false)
  },
  proceed: function (config, file, force, cb) {
    if (!file || file === '/dev/null' || file === 'NULL') {
      return typeof cb === 'function' ? cb(new Error('Wrong file')) : false
    }

    var errHandler = function (err) {
      pmx.notify(err)
      return typeof cb === 'function' ? cb(err) : console.error(err)
    }

    // Get file size
    fs.stat(file, function (err, data) {
      if (err) return errHandler(err)

      if (WATCHED_FILES && WATCHED_FILES.indexOf(file) === -1) {
        WATCHED_FILES.push(file)
      }

      if ((data.size <= 0 || data.size < config.maxSize) && !force) {
        return typeof cb === 'function' ? cb(null, false) : false
      }

      // Name of file create by pm2-logrotate
      var name = file.substr(0, file.length - 4) + '__' + randomString(5) + '__' + moment().format(config.dateFormat) + '.log'
      var dirName = path.dirname(file)

      var gzip
      if (config.compress) {
        gzip = zlib.createGzip()
        name += '.gz'
        gzip.on('error', errHandler)
      }

      // Streams
      var readStream = fs.createReadStream(file)
      readStream.on('error', errHandler)
      var writeStream = fs.createWriteStream(name, {'flags': 'w+'})
      writeStream.on('error', errHandler)

      // Copy
      if (config.compress) {
        readStream.pipe(gzip).pipe(writeStream)
      } else {
        readStream.pipe(writeStream)
      }

      // End of copy
      readStream.on('end', function () {
        // Remove content of old logs
        fs.truncate(file, 0, function (err) {
          if (err) return errHandler(err)

          // Keep all file if retain = all
          if (!config.retain) {
            return typeof cb === 'function' ? cb(null, file) : false
          }

          // Get files in folder
          fs.readdir(dirName, function (err, files) {
            if (err) return errHandler(err)

            // Base name of create by pm2-logrotate
            var baseName = file.substr(0, file.length - 4).split('/').pop() + '__'
            // Rotate files and sort reverse
            var rotated = files.filter(function (file) {
              return file.indexOf(baseName) !== -1
            }).sort().reverse()
            // Delete files
            rotated.filter(function (file, i) {
              return config.retain <= i
            }).forEach(function (file) {
              fs.unlink(path.join(dirName, file), function (err) {
                if (err) return errHandler(err)

                console.log(file + ' has been removed')
              })
            })
            return typeof cb === 'function' ? cb(null, file) : false
          })
        })
      })
    })
  }
}

module.exports = worker
