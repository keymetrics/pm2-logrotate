
var pmx     = require('pmx');
var fs      = require('fs');
var path    = require('path');
var shelljs = require('shelljs');
var pm2 = require('pm2');

var conf = pmx.initModule();


function main() {
  pm2.list(function() {

  });
}

pm2.connect(main);

pmx.action('conf', function(reply) {
  return reply(conf);
});
