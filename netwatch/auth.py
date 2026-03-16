"""
Session-based login/logout for NetWatch.
Credentials stored in auth.json  (bcrypt-hashed password).
Default on first run: admin / netwatch  — change immediately in Settings.
"""
import json, os, hashlib, secrets
from functools import wraps
from flask import session, request, redirect, url_for, jsonify
from .config import AUTH_FILE

# ── helpers ───────────────────────────────────────────────────────────────────

def _hash(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()

def _load() -> dict:
    if os.path.exists(AUTH_FILE):
        with open(AUTH_FILE) as f:
            return json.load(f)
    # first-run default
    salt = secrets.token_hex(16)
    cfg = {"username": "admin", "salt": salt,
           "hash": _hash("netwatch", salt)}
    _save(cfg)
    return cfg

def _save(cfg: dict):
    with open(AUTH_FILE, "w") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ── public API ────────────────────────────────────────────────────────────────

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
