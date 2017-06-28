/* eslint-env mocha */

const fs = require('fs')
const path = require('path')
const async = require('async')
const bytes = require('../utils/bytes.js')
require.main.filename = path.resolve(__filename, '..')
const log = require('../app')

describe('Proceed function', () => {
  const matchFile = /test-log-out-0__[a-zA-Z0-9]{5}__[0-9\-_]*.log/
  const matchFileCompress = /test-log-out-0__[a-zA-Z0-9]{5}__[0-9\-_]*.log.gz/

  after(() => {
    fs.unlinkSync(`/tmp/test-log-out-0.log`)
  })

  it('Proceed with wrong file', (done) => {
    const file = `/dev/null`
    const config = {
      maxSize: '100B',
      retain: undefined,
      compress: false,
      dateFormat: 'YYYY-MM-DD_HH-mm-ss',
      workerInterval: '30',
      rotateInterval: '0 0 * * *',
      rotateModule: true
    }

    log.proceed(config, file, false, (err) => {
      if (err) return done()

      return done('File mustn\'t exist')
    })
  })

  it('Proceed with default conf', (done) => {
    const file = `/tmp/test-log-out-0.log`
    const config = {
      maxSize: '100B',
      retain: undefined,
      compress: false,
      dateFormat: 'YYYY-MM-DD_HH-mm-ss',
      workerInterval: 30,
      rotateInterval: '0 0 * * *',
      rotateModule: true
    }

    fs.writeFileSync(file, Buffer.alloc(bytes(config.maxSize)))
    log.proceed(config, file, false, () => {
      const files = fs.readdirSync('/tmp')
      const test = files.filter(file => matchFile.test(file))
      if (fs.statSync(file).size === 0 && test[0]) {
        test.forEach(file => {
          fs.unlinkSync(`/tmp/${file}`)
        })
        return done()
      }
      return done('No file create by proceed function')
    })
  })

  it('Proceed with compress = true', (done) => {
    const file = `/tmp/test-log-out-0.log`
    const config = {
      maxSize: '100B',
      retain: undefined,
      compress: true,
      dateFormat: 'YYYY-MM-DD_HH-mm-ss',
      workerInterval: '30',
      rotateInterval: '0 0 * * *',
      rotateModule: true
    }

    fs.writeFileSync(file, Buffer.alloc(bytes(config.maxSize)))
    log.proceed(config, file, false, () => {
      const files = fs.readdirSync('/tmp')
      const test = files.filter(file => matchFileCompress.test(file))
      if (fs.statSync(file).size === 0 && test[0]) {
        test.forEach(file => {
          fs.unlinkSync(`/tmp/${file}`)
        })
        return done()
      }
      return done('No file create by proceed function')
    })
  })

  it('Proceed with retain = 5', (done) => {
    const file = `/tmp/test-log-out-0.log`
    const config = {
      maxSize: '100B',
      retain: 5,
      compress: false,
      dateFormat: 'YYYY-MM-DD_HH-mm-ss',
      workerInterval: '30',
      rotateInterval: '0 0 * * *',
      rotateModule: true
    }

    async.times(10, (n, next) => {
      fs.writeFileSync(file, Buffer.alloc(100))
      log.proceed(config, file, false, (err, file) => {
        next(err, file)
      })
    }, (err, files) => {
      if (err) return done(err)

      const dir = fs.readdirSync('/tmp')
      const test = dir.filter(file => matchFile.test(file))
      test.forEach(file => {
        fs.unlinkSync(`/tmp/${file}`)
      })
      if (test.length !== 5) return done('Wrong number of files')
      return done()
    })
  })
})
