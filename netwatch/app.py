"""Flask application factory."""
import os, threading, time
from flask import Flask
from .db      import init_db, cleanup_ping_history
from .backup  import backup_loop
from .routes  import bp
from .monitor import (_do_monitor_scan, background_auto_ping,
                      background_auto_discovery, background_auto_subnet)

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def create_app() -> Flask:
    # Инициализируем БД до создания Flask-приложения
    init_db()

    app = Flask(
        __name__,
        template_folder=os.path.join(_ROOT, "templates"),
        static_folder=os.path.join(_ROOT, "static"),
    )

    # Secret key — генерируем один раз, храним в файле
    _sk_file = os.path.join(_ROOT, ".secret_key")
    if os.path.exists(_sk_file):
        app.secret_key = open(_sk_file, "rb").read()
    else:
        import secrets as _sec
        key = _sec.token_bytes(32)
        open(_sk_file, "wb").write(key)
        app.secret_key = key

    app.register_blueprint(bp)
    return app


def _cleanup_loop():
    """Очищаем старую ping_history каждый час."""
    while True:
        time.sleep(3600)
        try:
            cleanup_ping_history()
        except Exception as e:
            print(f"[db-cleanup] {e}")


def start_background_tasks():
    """Запускаем все фоновые потоки. Вызвать один раз после create_app()."""
    threading.Thread(target=lambda: _do_monitor_scan(deep=False), daemon=True).start()
    threading.Thread(target=background_auto_ping,      daemon=True).start()
    threading.Thread(target=background_auto_discovery, daemon=True).start()
    threading.Thread(target=background_auto_subnet,    daemon=True).start()
    threading.Thread(target=_cleanup_loop,             daemon=True).start()
    threading.Thread(target=backup_loop,               daemon=True).start()