"""Flask application factory."""
import os, threading
from flask import Flask
from .routes  import bp
from .monitor import (_do_monitor_scan, background_auto_ping,
                      background_auto_discovery, background_auto_subnet)

# Root of the project (the folder containing netwatch/ package and run.py)
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=os.path.join(_ROOT, "templates"),
        static_folder=os.path.join(_ROOT, "static"),
    )
    # Secret key for session cookies — generated once and persisted
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


def start_background_tasks():
    """Kick off all daemon threads. Call once after create_app()."""
    threading.Thread(target=lambda: _do_monitor_scan(deep=False), daemon=True).start()
    threading.Thread(target=background_auto_ping,      daemon=True).start()
    threading.Thread(target=background_auto_discovery, daemon=True).start()
    threading.Thread(target=background_auto_subnet,    daemon=True).start()
