"""
NetWatch — SQLite database layer.

Единственный файл который знает про sqlite3. Все остальные модули
импортируют отсюда get_conn() или используют storage.py / events.py
как раньше — интерфейс не изменился.

Особенности:
  - check_same_thread=False + WAL mode — безопасно для многопоточного Flask
  - Одно соединение на поток через threading.local()
  - ping_history авто-очищается: хранится 7 дней, не более 50 000 строк на IP
  - settings хранит telegram.json, auth.json и прочие конфиги как JSON в одной таблице
"""

import sqlite3
import threading
import time
import os

# ── Путь к БД ─────────────────────────────────────────────────────────────────
# Ищем от корня проекта (там же где раньше лежали *.json)
_HERE   = os.path.dirname(os.path.abspath(__file__))
_ROOT   = os.path.dirname(_HERE)          # папка выше netwatch/
DB_PATH = os.path.join(_ROOT, "netwatch.db")

_local  = threading.local()              # соединение на поток
_init_lock = threading.Lock()
_initialized = False


# ══════════════════════════════════════════════════════════════════════════════
# Connection
# ══════════════════════════════════════════════════════════════════════════════

def get_conn() -> sqlite3.Connection:
    """Return a per-thread SQLite connection. Creates it on first call."""
    if not getattr(_local, "conn", None):
        _local.conn = sqlite3.connect(
            DB_PATH,
            check_same_thread=False,
            timeout=10,
        )
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")   # concurrent reads + writes
        _local.conn.execute("PRAGMA synchronous=NORMAL")  # fast, safe enough
        _local.conn.execute("PRAGMA foreign_keys=ON")
        _local.conn.execute("PRAGMA cache_size=-8000")    # 8 MB page cache
    return _local.conn


def _execute(sql: str, params=(), *, fetch=None):
    """
    Thread-safe helper.
    fetch=None   → execute (INSERT/UPDATE/DELETE), return lastrowid
    fetch='one'  → fetchone() → sqlite3.Row | None
    fetch='all'  → fetchall() → list[sqlite3.Row]
    """
    conn = get_conn()
    cur  = conn.execute(sql, params)
    if fetch is None:
        conn.commit()
        return cur.lastrowid
    if fetch == "one":
        return cur.fetchone()
    return cur.fetchall()


# ══════════════════════════════════════════════════════════════════════════════
# Schema
# ══════════════════════════════════════════════════════════════════════════════

_SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ip            TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL DEFAULT '',
    location      TEXT    NOT NULL DEFAULT '',
    type          TEXT    NOT NULL DEFAULT 'client',
    mac           TEXT    NOT NULL DEFAULT '',
    vendor        TEXT    NOT NULL DEFAULT '',
    model         TEXT    NOT NULL DEFAULT '',
    cred_login    TEXT    NOT NULL DEFAULT '',
    cred_password TEXT    NOT NULL DEFAULT '',
    created_at    REAL    NOT NULL DEFAULT (unixepoch('now'))
);

CREATE TABLE IF NOT EXISTS subnets (
    prefix  TEXT    PRIMARY KEY,
    label   TEXT    NOT NULL DEFAULT '',
    scan    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     REAL    NOT NULL,
    kind   TEXT    NOT NULL,
    ip     TEXT    NOT NULL DEFAULT '',
    name   TEXT    NOT NULL DEFAULT '',
    detail TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts   DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_ip   ON events(ip);

CREATE TABLE IF NOT EXISTS ping_history (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ip    TEXT    NOT NULL,
    ts    REAL    NOT NULL,
    ms    REAL,
    alive INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ph_ip_ts ON ping_history(ip, ts DESC);

-- key-value store: telegram config, auth, custom settings
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '{}'
);
"""

_PING_HISTORY_TTL_DAYS = 7
_PING_HISTORY_MAX_PER_IP = 50_000


def init_db():
    """Create tables if they don't exist. Call once at startup."""
    global _initialized
    with _init_lock:
        if _initialized:
            return
        conn = get_conn()
        conn.executescript(_SCHEMA)
        conn.commit()
        _initialized = True
        print(f"[db] initialized: {DB_PATH}")


def cleanup_ping_history():
    """
    Удаляет старые записи ping_history.
    Вызывать периодически (раз в час достаточно).
    """
    cutoff = time.time() - _PING_HISTORY_TTL_DAYS * 86400
    _execute("DELETE FROM ping_history WHERE ts < ?", (cutoff,))

    # Если на один IP слишком много строк — оставить последние MAX
    ips = [r[0] for r in _execute(
        "SELECT ip FROM ping_history GROUP BY ip HAVING COUNT(*) > ?",
        (_PING_HISTORY_MAX_PER_IP,), fetch="all"
    )]
    for ip in ips:
        _execute("""
            DELETE FROM ping_history
            WHERE ip = ? AND id NOT IN (
                SELECT id FROM ping_history
                WHERE ip = ?
                ORDER BY ts DESC
                LIMIT ?
            )
        """, (ip, ip, _PING_HISTORY_MAX_PER_IP))