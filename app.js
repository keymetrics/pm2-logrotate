const pmx = require('pmx')
const pm2 = require('pm2')
const fs = require('graceful-fs')
const path = require('path')
const moment = require('moment-timezone')
const bytes = require('./utils/bytes.js')
const randomString = require('./utils/randomString.js')
const schedule = require('node-schedule')
const zlib = require('zlib')

const WATCHED_FILES = []

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
  }, (err, conf) => {
    if (err) return console.error(err)

    const config = {
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

    const Probe = pmx.probe()

    /** PROB PMX **/
    const metrics = {}
    metrics.totalsize = Probe.metric({
      name: 'Global logs size',
      value: 'N/A'
    })
    metrics.totalcount = Probe.metric({
      name: 'Files count',
      value: 'N/A'
    })

    // Update metrics every 30 secondes
    setInterval(() => {
      // Get files in logs folder
      fs.readdir(`${config.pm2RootPath}/logs`, (err, files) => {
        if (err) return pmx.notify.bind(err)

        let size = 0
        // Number of files
        metrics.totalcount.set(files.length)
        // Size of files
        files.forEach(file => {
          size += fs.statSync(`${config.pm2RootPath}/logs/${file}`).size
        })
        metrics.totalsize.set(bytes(size))
      })
    }, 30000)

    // Connect to local PM2
    pm2.connect(err => {
      if (err) return console.error(err.stack || err)

      if (config.workerInterval !== -1) {
        // start background task
        setInterval(() => {
          // get list of process managed by pm2 and proceed
          worker.getApps(config)
        }, config.workerInterval)
      }
      // cron job
      schedule.scheduleJob(config.rotateCron, () => {
        // get list of process managed by pm2 and proceed
        worker.getApps(config)
      })
    })

    /**  ACTION PMX **/
    pmx.action('list watched logs', reply => {
      const returned = {}
      WATCHED_FILES.forEach(file => {
        returned[file] = fs.statSync(file).size
      })
      return reply(returned)
    })
    pmx.action('list all logs', reply => {
      const returned = {}
      const folder = `${config.pm2RootPath}/logs`
      fs.readdir(folder, (err, files) => {
        if (err) {
          console.error(err.stack || err)
          return reply(0)
        }

        files.forEach(file => {
          returned[file] = fs.statSync(`${folder}/${file}`).size
        })
        return reply(returned)
      })
    })
  })
}

const worker = {
  getApps (config) {
    // Get list of apps
    pm2.list((err, apps) => {
      if (err) return console.error(err.stack || err)

      // Proceed every apps
      apps.forEach(app => {
        if (app.pm2_env.axm_options.isModule && !config.rotateModule) return

        if (config.rotateOut) {
          this.proceed(config, app.pm2_env.pm_out_log_path, false)
        }
        if (config.rotateErr) {
          this.proceed(config, app.pm2_env.pm_err_log_path, false)
        }
        this.proceed(config, app.pm2_env.pm_log_path, false)
      })
    })
    this.proceed(config, config.pm2RootPath + '/pm2.log', false)
    this.proceed(config, config.pm2RootPath + '/agent.log', false)
  },
  proceed (config, file, force, cb) {
    if (!file || file === '/dev/null' || file === 'NULL') {
      return typeof cb === 'function' ? cb(new Error('Wrong file')) : false
    }

    var errHandler = (err) => {
      pmx.notify(err)
      return typeof cb === 'function' ? cb(err) : console.error(err)
    }

    // Get file size
    fs.stat(file, (err, data) => {
      if (err) return errHandler(err)

      if (WATCHED_FILES && WATCHED_FILES.indexOf(file) === -1) {
        WATCHED_FILES.push(file)
      }

      if ((data.size <= 0 || data.size < config.maxSize) && !force) {
        return typeof cb === 'function' ? cb(null, false) : false
      }

      // Name of file create by pm2-logrotate
      let name = `${file.substr(0, file.length - 4)}__${randomString(5)}__${moment().format(config.dateFormat)}.log`
      const dirName = path.dirname(file)

      let gzip
      if (config.compress) {
        gzip = zlib.createGzip()
        name += '.gz'
        gzip.on('error', errHandler)
      }

      // Streams
      const readStream = fs.createReadStream(file)
      readStream.on('error', errHandler)
      const writeStream = fs.createWriteStream(name, {'flags': 'w+'})
      writeStream.on('error', errHandler)

      // Copy
      if (config.compress) {
        readStream.pipe(gzip).pipe(writeStream)
      } else {
        readStream.pipe(writeStream)
      }

      // End of copy
      readStream.on('end', () => {
        // Remove content of old logs
        fs.truncate(file, 0, err => {
          if (err) return errHandler(err)

          // Keep all file if retain = all
          if (!config.retain) {
            return typeof cb === 'function' ? cb(null, file) : false
          }

          // Get files in folder
          fs.readdir(dirName, (err, files) => {
            if (err) return errHandler(err)

            // Base name of create by pm2-logrotate
            const baseName = `${file.substr(0, file.length - 4).split('/').pop()}__`
            // Rotate files and sort reverse
            const rotated = files.filter(file => file.indexOf(baseName) !== -1).sort().reverse()
            // Delete files
            rotated.filter((file, i) => config.retain <= i).forEach(file => {
              fs.unlink(path.join(dirName, file), err => {
                if (err) return errHandler(err)

                console.log(`${file} has been removed`)
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
