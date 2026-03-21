#!/bin/bash
nginx -c "/Users/valentine/.netwatch/ssl/nginx.conf" -s stop 2>/dev/null && echo "nginx остановлен" || echo "nginx не был запущен"
