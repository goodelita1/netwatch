"""
NetWatch — Authentication + 2FA TOTP.

Хранение: SQLite settings table, key='auth'.
2FA: RFC 6238 TOTP реализован через stdlib (hmac + hashlib + base64).
Никаких внешних зависимостей.

Поля в auth config:
  username, salt, hash               — логин/пароль
  totp_enabled  bool                 — включён ли 2FA
  totp_secret   str (base32)         — секрет TOTP (генерируется при включении)
"""
import json, os, hmac, hashlib, struct, time, base64, secrets
from functools import wraps
from flask import session, request, redirect, url_for, jsonify


# ══════════════════════════════════════════════════════════════════════════════
# Storage helpers
# ══════════════════════════════════════════════════════════════════════════════

def _load() -> dict:
    try:
        from .db import _execute, init_db
        init_db()
        row = _execute("SELECT value FROM settings WHERE key = 'auth'", fetch="one")
        if row:
            return json.loads(row["value"])
    except Exception:
        pass
    if os.path.exists("auth.json"):
        try:
            with open("auth.json") as f:
                cfg = json.load(f)
            _save(cfg)
            return cfg
        except Exception:
            pass
    salt = secrets.token_hex(16)
    cfg  = {"username": "admin", "salt": salt,
            "hash": _hash_pw("netwatch", salt),
            "totp_enabled": False, "totp_secret": ""}
    _save(cfg)
    return cfg


def _save(cfg: dict):
    try:
        from .db import _execute, init_db
        init_db()
        _execute(
            "INSERT INTO settings (key, value) VALUES ('auth', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (json.dumps(cfg, ensure_ascii=False),)
        )
    except Exception as e:
        print(f"[auth] DB save failed: {e}")
        with open("auth.json", "w") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)


# ══════════════════════════════════════════════════════════════════════════════
# Password
# ══════════════════════════════════════════════════════════════════════════════

def _hash_pw(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()


def check_credentials(username: str, password: str) -> bool:
    cfg = _load()
    return (username == cfg["username"] and
            _hash_pw(password, cfg["salt"]) == cfg["hash"])


def change_credentials(new_username: str, new_password: str):
    cfg  = _load()
    salt = secrets.token_hex(16)
    cfg.update({"username": new_username, "salt": salt,
                "hash": _hash_pw(new_password, salt)})
    _save(cfg)


def get_username() -> str:
    return _load().get("username", "admin")


# ══════════════════════════════════════════════════════════════════════════════
# TOTP — RFC 6238, pure stdlib
# ══════════════════════════════════════════════════════════════════════════════

def _hotp(key_bytes: bytes, counter: int) -> str:
    """HMAC-based OTP (RFC 4226)."""
    msg = struct.pack(">Q", counter)
    h   = hmac.new(key_bytes, msg, hashlib.sha1).digest()
    offset = h[-1] & 0x0F
    code   = struct.unpack(">I", h[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % 1_000_000).zfill(6)


def _totp_now(secret_b32: str) -> str:
    """Return current TOTP code for given base32 secret."""
    key = base64.b32decode(secret_b32.upper().replace(" ", ""))
    return _hotp(key, int(time.time()) // 30)


def totp_verify(secret_b32: str, code: str) -> bool:
    """
    Verify code against current window ±1 step (±30s tolerance).
    Accepts 6-digit string with or without spaces.
    """
    code = code.replace(" ", "").strip()
    if len(code) != 6 or not code.isdigit():
        return False
    key = base64.b32decode(secret_b32.upper().replace(" ", ""))
    t   = int(time.time()) // 30
    for delta in (-1, 0, 1):
        if hmac.compare_digest(_hotp(key, t + delta), code):
            return True
    return False


def totp_generate_secret() -> str:
    """Generate a new random base32 TOTP secret."""
    return base64.b32encode(secrets.token_bytes(20)).decode()


def totp_provisioning_uri(secret: str, username: str,
                          issuer: str = "NetWatch") -> str:
    """Build otpauth:// URI for QR code generation."""
    from urllib.parse import quote
    return (f"otpauth://totp/{quote(issuer)}:{quote(username)}"
            f"?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1"
            f"&digits=6&period=30")


def totp_is_enabled() -> bool:
    cfg = _load()
    return bool(cfg.get("totp_enabled") and cfg.get("totp_secret"))


def totp_enable(secret: str):
    cfg = _load()
    cfg["totp_enabled"] = True
    cfg["totp_secret"]  = secret
    _save(cfg)


def totp_disable():
    cfg = _load()
    cfg["totp_enabled"] = False
    cfg["totp_secret"]  = ""
    _save(cfg)


def totp_get_secret() -> str:
    return _load().get("totp_secret", "")


# ══════════════════════════════════════════════════════════════════════════════
# Login flow helpers
# ══════════════════════════════════════════════════════════════════════════════

def login_required(f):
    """Decorator: blocks unauthenticated requests.
    Also blocks fully-logged-in checks when 2FA is pending."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("api.login_page"))
        return f(*args, **kwargs)
    return decorated