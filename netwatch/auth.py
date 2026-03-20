"""
Session-based login/logout for NetWatch.
Credentials stored in settings table (key='auth').
Default on first run: admin / netwatch — change immediately in Settings.
Backward-compat: if auth.json exists and settings['auth'] is empty, reads from file.
"""
import json, os, hashlib, secrets
from functools import wraps
from flask import session, request, redirect, url_for, jsonify


def _hash(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()


def _load() -> dict:
    """Load auth config from SQLite settings, fall back to auth.json."""
    try:
        from .db import _execute, init_db
        init_db()
        row = _execute("SELECT value FROM settings WHERE key = 'auth'", fetch="one")
        if row:
            return json.loads(row["value"])
    except Exception:
        pass

    # Fallback: auth.json (first run or before migration)
    if os.path.exists("auth.json"):
        try:
            with open("auth.json") as f:
                cfg = json.load(f)
            _save(cfg)   # migrate to DB
            return cfg
        except Exception:
            pass

    # First-ever run — create default credentials
    salt = secrets.token_hex(16)
    cfg  = {"username": "admin", "salt": salt, "hash": _hash("netwatch", salt)}
    _save(cfg)
    return cfg


def _save(cfg: dict):
    """Persist auth config to SQLite settings table."""
    try:
        from .db import _execute, init_db
        init_db()
        _execute(
            "INSERT INTO settings (key, value) VALUES ('auth', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (json.dumps(cfg, ensure_ascii=False),)
        )
    except Exception as e:
        # Fallback to file if DB not ready yet
        print(f"[auth] DB save failed, using file: {e}")
        with open("auth.json", "w") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)


# ── Public API ────────────────────────────────────────────────────────────────

def check_credentials(username: str, password: str) -> bool:
    cfg = _load()
    return (username == cfg["username"] and
            _hash(password, cfg["salt"]) == cfg["hash"])


def change_credentials(new_username: str, new_password: str):
    salt = secrets.token_hex(16)
    _save({"username": new_username, "salt": salt,
           "hash": _hash(new_password, salt)})


def get_username() -> str:
    return _load().get("username", "admin")


def login_required(f):
    """Decorator: redirect to /login for browser requests, 401 for API."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("api.login_page"))
        return f(*args, **kwargs)
    return decorated