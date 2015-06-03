
## Description

PM2 module to automatically rotate logs of processes managed by PM2.

## Install

`pm2 install pm2-logrotate`

## Configure

There are 3 values that you need to configure :

- max_size (Defaults to 10MB): When a file size becomes higher than this value it will split it.
- interval (Defaults to 1):
- interval_unit (Defaults to 'DD'): interval and interval_unit works together, it means if you have interval_unit='DD' and interval=3, it will split the logs every 3 days.

Possible values for interval_unit are 'MM' (months), 'DD' (days), 'mm' (minutes).
eg: interval:9, interval_unit:'mm' will split the logs every 9 minutes.

How to set these values ?

- After having installed the module you have to type :
`pm2 set pm2-logrotate:<param> <value>`

e.g: `pm2 set pm2-logrotate:max_size 1024` (1KB)
`pm2 set pm2-logrotate:interval_unit 'MM'` (Months)
