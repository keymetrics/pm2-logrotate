pm2 set pm2-logrotate:max_size 30K
pm2 set pm2-logrotate:interval 1
pm2 set pm2-logrotate:interval_unit "mm"
pm2 set pm2-logrotate:retain 4
pm2 set pm2-logrotate:white_list ["pm2-logrotate","other-do-not-cut-log-app"]
