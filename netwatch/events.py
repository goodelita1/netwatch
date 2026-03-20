"""
NetWatch — Events, ping history, Telegram, settings (SQLite backend).

Публичный интерфейс сохранён полностью:
  add_event(), load_events(), save_events()
  record_ping(), ping_history, _ph_lock, _down_since
  load_tg(), save_tg(), tg_send(), tg_send_to()
"""

import json, time, threading, collections
import urllib.request as _ureq
from .db import _execute, init_db, get_conn

# ══════════════════════════════════════════════════════════════════════════════
# Settings helpers  (telegram, auth, etc. — stored as JSON in settings table)
# ══════════════════════════════════════════════════════════════════════════════

def _get_setting(key: str, default=None):
    init_db()
    row = _execute("SELECT value FROM settings WHERE key = ?", (key,), fetch="one")
    if row:
        try:
            return json.loads(row["value"])
        except Exception:
            return default
    return default


def _set_setting(key: str, value):
    init_db()
    _execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False))
    )


# ══════════════════════════════════════════════════════════════════════════════
# Telegram
# ══════════════════════════════════════════════════════════════════════════════

_TG_DEFAULT = {
    "token": "", "recipients": [],
    "enabled": False, "notify_power": True,
    "notify_device": True, "notify_new_host": True, "down_min": 5,
}


def load_tg() -> dict:
    return _get_setting("telegram", _TG_DEFAULT)


def save_tg(cfg: dict):
    _set_setting("telegram", cfg)


def tg_send(text: str):
    cfg = load_tg()
    if not cfg.get("enabled") or not cfg.get("token"):
        return
    recipients = cfg.get("recipients", [])
    if not recipients and cfg.get("chat_id"):
        recipients = [{"chat_id": cfg["chat_id"], "label": "Default", "active": True}]
    active = [r["chat_id"] for r in recipients if r.get("active", True) and r.get("chat_id")]
    if not active:
        return
    url = f"https://api.telegram.org/bot{cfg['token']}/sendMessage"
    for chat_id in active:
        try:
            data = json.dumps({"chat_id": chat_id, "text": text,
                               "parse_mode": "HTML"}).encode()
            _ureq.urlopen(
                _ureq.Request(url, data=data,
                              headers={"Content-Type": "application/json"}),
                timeout=8
            )
        except Exception as e:
            print(f"[tg] {chat_id}: {e}")


def tg_send_to(text: str, chat_id: str) -> bool:
    cfg = load_tg()
    if not cfg.get("token"):
        return False
    try:
        url  = f"https://api.telegram.org/bot{cfg['token']}/sendMessage"
        data = json.dumps({"chat_id": chat_id, "text": text,
                           "parse_mode": "HTML"}).encode()
        _ureq.urlopen(
            _ureq.Request(url, data=data,
                          headers={"Content-Type": "application/json"}),
            timeout=8
        )
        return True
    except Exception as e:
        print(f"[tg] test to {chat_id}: {e}")
        return False


# ══════════════════════════════════════════════════════════════════════════════
# Event log
# ══════════════════════════════════════════════════════════════════════════════

_ev_lock = threading.Lock()

_EV_ICONS = {
    "down": "🔴", "up": "🟢",
    "power_off": "⚡🔴", "power_on": "⚡🟢",
    "reboot": "🔄", "new_host": "🆕", "down_alert": "⚠️",
}


def load_events(limit: int = 1000) -> list:
    """Return last `limit` events, newest first."""
    init_db()
    rows = _execute(
        "SELECT * FROM events ORDER BY ts DESC LIMIT ?",
        (limit,), fetch="all"
    )
    # Return chronological order (oldest first) to match old JSON behaviour
    result = [dict(r) for r in rows]
    result.reverse()
    return result


def save_events(evs: list):
    """
    Совместимость с кодом который делает save_events([]) для очистки.
    При пустом списке — удаляем всё.
    При непустом — upsert (используется редко).
    """
    init_db()
    if not evs:
        _execute("DELETE FROM events")
        return
    conn = get_conn()
    for ev in evs:
        conn.execute("""
            INSERT OR IGNORE INTO events (ts, kind, ip, name, detail)
            VALUES (?, ?, ?, ?, ?)
        """, (ev["ts"], ev["kind"], ev.get("ip",""), ev.get("name",""), ev.get("detail","")))
    conn.commit()


def add_event(kind: str, ip: str, name: str, detail: str = "", notify: bool = False):
    """Write event to DB and optionally send Telegram notification."""
    init_db()
    ts = time.time()
    with _ev_lock:
        _execute(
            "INSERT INTO events (ts, kind, ip, name, detail) VALUES (?, ?, ?, ?, ?)",
            (ts, kind, ip, name, detail)
        )
        # Keep max 5000 events (trim oldest)
        _execute("""
            DELETE FROM events WHERE id IN (
                SELECT id FROM events ORDER BY ts ASC
                LIMIT MAX(0, (SELECT COUNT(*) FROM events) - 5000)
            )
        """)
    if notify:
        icon = _EV_ICONS.get(kind, "ℹ️")
        msg  = f"{icon} <b>NetWatch</b>\n<b>{name}</b> ({ip})\n{detail}"
        threading.Thread(target=tg_send, args=(msg,), daemon=True).start()


# ══════════════════════════════════════════════════════════════════════════════
# Ping history
# In-memory ring buffer (fast for sparklines) + async flush to SQLite
# ══════════════════════════════════════════════════════════════════════════════

PHIST_MAX    = 144          # 144 × 60s = 2.4h  in memory
_ph_lock     = threading.Lock()
ping_history: dict = {}     # ip → deque[{ts, ms, alive}]

# Write-behind buffer: фlushed to DB every 5 min or 500 records
_ph_write_buf: list = []
_ph_buf_lock  = threading.Lock()
_PH_FLUSH_EVERY = 300       # seconds
_PH_FLUSH_SIZE  = 500       # records
_ph_last_flush  = 0.0


def record_ping(ip: str, alive: bool, ms):
    """
    1. Обновляет in-memory ring buffer (для sparklines — быстро).
    2. Добавляет в write-behind buffer для последующей записи в SQLite.
    """
    ts = time.time()

    with _ph_lock:
        if ip not in ping_history:
            ping_history[ip] = collections.deque(maxlen=PHIST_MAX)
        ping_history[ip].append({"ts": ts, "ms": ms, "alive": alive})

    with _ph_buf_lock:
        _ph_write_buf.append((ip, ts, ms, 1 if alive else 0))
        should_flush = (
            len(_ph_write_buf) >= _PH_FLUSH_SIZE or
            ts - _ph_last_flush >= _PH_FLUSH_EVERY
        )

    if should_flush:
        threading.Thread(target=_flush_ping_history, daemon=True).start()


def _flush_ping_history():
    """Write buffered ping points to SQLite in one transaction."""
    global _ph_last_flush
    with _ph_buf_lock:
        batch = list(_ph_write_buf)
        _ph_write_buf.clear()
        _ph_last_flush = time.time()

    if not batch:
        return
    try:
        init_db()
        conn = get_conn()
        conn.executemany(
            "INSERT INTO ping_history (ip, ts, ms, alive) VALUES (?, ?, ?, ?)",
            batch
        )
        conn.commit()
    except Exception as e:
        print(f"[db] ping_history flush error: {e}")


def load_ping_history_from_db(ip: str, hours: int = 24) -> list:
    """
    Load ping history from SQLite for dashboard / analytics.
    Returns list of {ts, ms, alive} dicts.
    """
    init_db()
    since = time.time() - hours * 3600
    rows = _execute(
        "SELECT ts, ms, alive FROM ping_history WHERE ip = ? AND ts >= ? ORDER BY ts ASC",
        (ip, since), fetch="all"
    )
    return [{"ts": r["ts"], "ms": r["ms"], "alive": bool(r["alive"])} for r in rows]


# ── Compatibility: tracks when each device went down ─────────────────────────
_down_since: dict = {}