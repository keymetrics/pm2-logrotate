var MB = '';

for (var i = 0; i < 1024 * 1024; ++i)
  MB += '1';

setInterval(function() {
  process.stdout.write(MB);
  process.stderr.write(MB);
}, 1000);
