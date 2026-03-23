"""
NetWatch — SocketIO singleton.

Отдельный модуль чтобы избежать circular imports:
  app.py создаёт socketio
  monitor.py и events.py импортируют socketio отсюда
  routes.py регистрирует handlers
"""
from flask_socketio import SocketIO

# async_mode='eventlet' — лучшая производительность с threading=True
# cors_allowed_origins="*" — nginx проксирует, CORS не нужен в prod
socketio = SocketIO(
    async_mode="eventlet",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
    ping_timeout=60,      # seconds before declaring connection dead
    ping_interval=25,     # send ping every 25s
)