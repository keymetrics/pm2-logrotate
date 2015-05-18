

var stream = require('logrotate-stream')
, toLogFile = stream({ file: './test.log', size: '100k', keep: 3 });

var pm2 = require('pm2');
var fs = require('fs');

function copyFile(source, target, cb) {
  var cbCalled = false;

  var rd = fs.createReadStream(source);
  rd.on("error", function(err) {
    done(err);
  });
  var wr = fs.createWriteStream(target, {'flags': 'a'});
  wr.on("error", function(err) {
    done(err);
  });
  wr.on("close", function(ex) {
    done();
  });
  rd.pipe(wr);

  function done(err) {
    if (!cbCalled) {
      cb(err);
      cbCalled = true;
    }
  }
}
function main() {

  setInterval(function() {
    pm2.list(function(err, apps) {
      var out_file = apps[0].pm2_env.pm_out_log_path;
      var size = fs.statSync(out_file).size;

      console.log(size);
      if (size > 1000) {
        console.log(out_file);
        copyFile(out_file, out_file + '-log', function() {
          fs.truncate(out_file, 0, function(){
            console.log('done');
          });
        });
        // fs.createReadStream(out_file).pipe(fs.createWriteStream(out_file + '-log'));

      }
      //console.log(apps[0].pm2_env.pm_err_log_path);
    });
  }, 1000);
}

pm2.connect(main);


//someStream.pipe(toLogFile);
