#!/bin/bash
# Запускает nginx + NetWatch
cd "/Users/valentine/Desktop/web_UI"
nginx -c "/Users/valentine/.netwatch/ssl/nginx.conf" -s stop 2>/dev/null || true
sleep 1
nginx -c "/Users/valentine/.netwatch/ssl/nginx.conf"
echo "OK  nginx: https://192.168.83.52:8443"
source venv/bin/activate 2>/dev/null || true
python run.py
