'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var stream = require('stream');
var vm = require('vm');
var zlib = require('zlib');
var createRotator = require('../lib/rotate');
var tests = [];

function test(name, run) { tests.push({ name: name, run: run }); }
function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
function error(code) { return Object.assign(new Error(code), { code: code }); }
function filesystem(overrides) { return Object.assign({}, fs, overrides); }
function run(rotate, file, dest, compress) {
  return new Promise(function(resolve) {
    assert.strictEqual(rotate(file, dest, !!compress, resolve), true);
  });
}
async function until(check) {
  for (var i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for test condition');
}
function fixture(dir) {
  var file = path.join(dir, 'app.log');
  var data = Buffer.from('log line\n'.repeat(1000));
  fs.writeFileSync(file, data);
  return { file: file, data: data, archive: path.join(dir, 'app__first.log') };
}

test('plain and gzip archives contain the complete input', async function(dir) {
  var f = fixture(dir);
  var rotate = createRotator(fs);
  assert.ifError(await run(rotate, f.file, f.archive));
  assert.deepStrictEqual(fs.readFileSync(f.archive), f.data);
  assert.strictEqual(fs.statSync(f.file).size, 0);
  fs.writeFileSync(f.file, f.data);
  var gzip = path.join(dir, 'app__second.log.gz');
  assert.ifError(await run(rotate, f.file, gzip, true));
  assert.deepStrictEqual(zlib.gunzipSync(fs.readFileSync(gzip)), f.data);
  assert.strictEqual(fs.statSync(f.file).size, 0);
});

test('slow copies reject repeated triggers but allow other files to rotate', async function(dir) {
  var f = fixture(dir);
  var input;
  var rotate = createRotator(filesystem({ createReadStream: function(file) {
    if (file !== f.file) return fs.createReadStream(file);
    input = new stream.PassThrough();
    return input;
  }}));
  var copying = run(rotate, f.file, f.archive);
  await until(function() { return input; });
  input.write(f.data.slice(0, 10));
  for (var i = 0; i < 5; i++) {
    await delay(10);
    assert.strictEqual(rotate(f.file, path.join(dir, 'duplicate-' + i), false,
      function() { throw new Error('Skipped rotation called back'); }), false);
  }
  assert.strictEqual(rotate(path.join(dir, 'unused', '..', 'app.log'),
    path.join(dir, 'alias.log'), false, function() {}), false);
  var other = path.join(dir, 'other.log');
  fs.writeFileSync(other, 'other');
  assert.ifError(await run(rotate, other, path.join(dir, 'other__first.log')));
  input.end(f.data.slice(10));
  assert.ifError(await copying);
  assert.deepStrictEqual(fs.readFileSync(f.archive), f.data);
  assert.strictEqual(fs.readdirSync(dir).filter(function(n) {
    return n.indexOf('duplicate-') === 0 || n === 'alias.log';
  }).length, 0);
});

test('the lock remains held while truncation is pending', async function(dir) {
  var f = fixture(dir), finishTruncate;
  var rotate = createRotator(filesystem({ truncate: function(file, size, cb) {
    finishTruncate = function() { fs.truncate(file, size, cb); };
  }}));
  var pending = run(rotate, f.file, f.archive);
  await until(function() { return finishTruncate; });
  assert.strictEqual(rotate(f.file, path.join(dir, 'duplicate'), false, function() {}), false);
  finishTruncate();
  assert.ifError(await pending);
});

['read', 'write', 'gzip'].forEach(function(kind) {
  test(kind + ' failure closes streams, removes partial output, preserves source and allows retry', async function(dir) {
    var f = fixture(dir), streams = [], inject = true;
    var originalGzip = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
    var api = filesystem({
      createReadStream: function(file) {
        var input = inject && kind === 'read'
          ? new stream.Readable({ read: function() { this.destroy(error('EIO')); } })
          : fs.createReadStream(file);
        streams.push(input);
        return input;
      },
      createWriteStream: function(file, options) {
        var output = fs.createWriteStream(file, options);
        if (inject && kind === 'write') {
          output._write = function(chunk, encoding, cb) { cb(error('ENOSPC')); };
          output._writev = function(chunks, cb) { cb(error('ENOSPC')); };
        }
        streams.push(output);
        return output;
      }
    });
    if (kind === 'gzip') {
      Object.defineProperty(zlib, 'createGzip', { configurable: true, value: function() {
        var gzip = new stream.Transform({ transform: function(chunk, encoding, cb) {
          cb(error('EIO'));
        }});
        streams.push(gzip);
        return gzip;
      }});
    }
    try {
      var rotate = createRotator(api);
      assert.strictEqual((await run(rotate, f.file, f.archive, kind === 'gzip')).code,
        kind === 'write' ? 'ENOSPC' : 'EIO');
      assert(streams.every(function(s) { return s.destroyed; }));
      assert(!fs.existsSync(f.archive));
      assert.deepStrictEqual(fs.readFileSync(f.file), f.data);
      inject = false;
      Object.defineProperty(zlib, 'createGzip', originalGzip);
      assert.ifError(await run(rotate, f.file, f.archive));
    } finally {
      Object.defineProperty(zlib, 'createGzip', originalGzip);
    }
  });
});

['read constructor', 'write constructor'].forEach(function(kind) {
  test(kind + ' failure closes the acquired descriptor and permits retry', async function(dir) {
    var f = fixture(dir), inject = true, acquiredFd;
    var api = filesystem({
      open: function(file, flags, cb) {
        fs.open(file, flags, function(err, fd) { acquiredFd = fd; cb(err, fd); });
      },
      createReadStream: function(file) {
        if (inject && kind === 'read constructor') throw error('ESETUP');
        return fs.createReadStream(file);
      },
      createWriteStream: function(file, options) {
        if (inject && kind === 'write constructor') throw error('ESETUP');
        return fs.createWriteStream(file, options);
      }
    });
    var rotate = createRotator(api);
    assert.strictEqual((await run(rotate, f.file, f.archive)).code, 'ESETUP');
    assert.throws(function() { fs.fstatSync(acquiredFd); }, { code: 'EBADF' });
    assert(!fs.existsSync(f.archive));
    assert.deepStrictEqual(fs.readFileSync(f.file), f.data);
    inject = false;
    assert.ifError(await run(rotate, f.file, f.archive));
  });
});

test('existing destinations and output-open failures preserve data and release the lock', async function(dir) {
  var f = fixture(dir), rotate = createRotator(fs);
  fs.writeFileSync(f.archive, 'existing archive');
  assert.strictEqual((await run(rotate, f.file, f.archive)).code, 'EEXIST');
  assert.strictEqual(fs.readFileSync(f.archive, 'utf8'), 'existing archive');
  assert.strictEqual((await run(rotate, f.file, path.join(dir, 'missing', 'out.log'))).code, 'ENOENT');
  assert.deepStrictEqual(fs.readFileSync(f.file), f.data);
  assert.ifError(await run(rotate, f.file, path.join(dir, 'retry.log')));
});

test('truncation failure retains both source and complete archive and releases the lock', async function(dir) {
  var f = fixture(dir), inject = true;
  var rotate = createRotator(filesystem({ truncate: function(file, size, cb) {
    if (inject) return process.nextTick(function() { cb(error('EACCES')); });
    fs.truncate(file, size, cb);
  }}));
  assert.strictEqual((await run(rotate, f.file, f.archive)).code, 'EACCES');
  assert.deepStrictEqual(fs.readFileSync(f.file), f.data);
  assert.deepStrictEqual(fs.readFileSync(f.archive), f.data);
  inject = false;
  assert.ifError(await run(rotate, f.file, path.join(dir, 'retry.log')));
});

test('cleanup failure reports both errors without keeping the source locked', async function(dir) {
  var f = fixture(dir), inject = true;
  var rotate = createRotator(filesystem({
    createReadStream: function(file) {
      return inject ? new stream.Readable({ read: function() { this.destroy(error('EIO')); } })
        : fs.createReadStream(file);
    },
    unlink: function(file, cb) { process.nextTick(function() { cb(error('EACCES')); }); }
  }));
  var failure = await run(rotate, f.file, f.archive);
  assert.strictEqual(failure.code, 'EIO');
  assert.strictEqual(failure.cleanupError.code, 'EACCES');
  assert.deepStrictEqual(fs.readFileSync(f.file), f.data);
  inject = false;
  assert.ifError(await run(rotate, f.file, path.join(dir, 'retry.log')));
});

test('size and cron entry points share the lock and successful rotation enforces retain', async function(dir) {
  var f = fixture(dir), interval, cron, copying = 0, maxCopying = 0, release;
  var notices = [];
  var api = filesystem({ createReadStream: function() {
    var input = new stream.PassThrough();
    copying++; maxCopying = Math.max(maxCopying, copying);
    input.once('close', function() { copying--; });
    release = function() { input.end(f.data); };
    return input;
  }});
  fs.writeFileSync(path.join(dir, 'app__2000.log'), 'old');
  fs.writeFileSync(path.join(dir, 'app__2001.log'), 'old');
  var app = { name: 'test', pm2_env: { pm_out_log_path: f.file, axm_options: {} } };
  var metric = function() { return { set: function() {} }; };
  var pmx = { initModule: function() { return { max_size: '1K', retain: '1' }; },
    probe: function() { return { metric: metric }; }, action: function() {},
    notify: function(err) { notices.push(err); } };
  var context = {
    require: function(name) {
      if (name === 'graceful-fs') return api;
      if (name === './lib/rotate') return createRotator;
      if (name === 'pmx') return pmx;
      if (name === 'pm2') return { connect: function(cb) { cb(); }, list: function(cb) { cb(null, [app]); } };
      if (name === 'moment-timezone') return function() { return { format: function() { return '2099'; } }; };
      if (name === 'node-schedule') return { scheduleJob: function(spec, cb) { cron = cb; } };
      return require(name);
    },
    process: { env: { PM2_HOME: dir } },
    console: { log: function() {}, error: function(err) { notices.push(err); } },
    setInterval: function(cb) { if (!interval) interval = cb; }
  };
  fs.mkdirSync(path.join(dir, 'logs'));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context);
  interval();
  await until(function() { return release; });
  for (var i = 0; i < 4; i++) { cron(); interval(); await delay(10); }
  assert.strictEqual(maxCopying, 1);
  release();
  await until(function() {
    return fs.statSync(f.file).size === 0 && !fs.existsSync(path.join(dir, 'app__2000.log')) &&
      !fs.existsSync(path.join(dir, 'app__2001.log'));
  });
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'app__2099.log')), f.data);
  assert.strictEqual(notices.length, 0);
});

(async function() {
  for (var entry of tests) {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-rotation-test-'));
    var watchdog = setTimeout(function() {
      console.error('FAIL (timeout): ' + entry.name);
      process.exit(1);
    }, 10000);
    try {
      await entry.run(dir);
      console.log('PASS ' + entry.name);
    } finally {
      clearTimeout(watchdog);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(tests.length + ' tests passed');
})().catch(function(err) { console.error(err); process.exitCode = 1; });
