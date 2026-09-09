'use strict';

var path = require('path');
var zlib = require('zlib');
var pipeline = require('stream').pipeline;

// Share one rotator between size-based checks and scheduled rotations.
module.exports = function createRotator(fs) {
  var rotating = new Set();

  return function rotate(file, destination, compress, callback) {
    var key = path.resolve(file);
    if (rotating.has(key)) return false;
    rotating.add(key);

    function complete(err) {
      rotating.delete(key);
      callback(err);
    }

    // Exclusive creation avoids overwriting a completed archive when two
    // sequential rotations resolve to the same formatted timestamp.
    fs.open(destination, 'wx', function(err, fd) {
      if (err) return complete(err);

      var streams = [];
      var output;

      function discard(error) {
        fs.unlink(destination, function(unlinkError) {
          if (unlinkError && unlinkError.code !== 'ENOENT') {
            error.cleanupError = unlinkError;
          }
          complete(error);
        });
      }

      try {
        output = fs.createWriteStream(destination, { fd: fd, autoClose: true });
        streams.push(output);
        // Ownership of fd has transferred to output.
        fd = null;
        if (compress) {
          streams.unshift(zlib.createGzip({
            level: zlib.Z_BEST_COMPRESSION,
            memLevel: zlib.Z_BEST_COMPRESSION
          }));
        }
        streams.unshift(fs.createReadStream(file));
      } catch (setupError) {
        // A constructor may throw before pipeline can own/destroy the streams.
        var pending = streams.length + (fd !== null ? 1 : 0);
        function closed(closeError) {
          if (closeError) setupError.closeError = closeError;
          if (--pending === 0) discard(setupError);
        }
        if (pending === 0) return discard(setupError);
        streams.forEach(function(stream) {
          stream.on('error', function() {});
          stream.once('close', closed);
          stream.destroy();
        });
        if (fd !== null) fs.close(fd, closed);
        return;
      }

      pipeline(streams, function(copyError) {
        // pipeline closes every stream before reporting a copy failure.
        if (copyError) return discard(copyError);
        // Keep a completed archive if truncation fails. Never truncate on a
        // failed copy, and hold the lock until truncation has finished.
        fs.truncate(file, 0, complete);
      });
    });
    return true;
  };
};
