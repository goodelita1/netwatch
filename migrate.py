#!/usr/bin/env python3
"""
NetWatch — Migration: JSON files → SQLite

Запустить ОДИН РАЗ перед первым стартом с новым кодом:
    cd /path/to/netwatch
    python -m netwatch.migrate

Что делает:
  1. Создаёт netwatch.db и все таблицы
  2. Переносит devices.json, subnets.json, events.json, telegram.json
  3. Переименовывает исходные файлы в *.bak (не удаляет)
  4. Если БД уже содержит данные — пропускает (безопасно запускать повторно)

Если JSON файлов нет — просто создаёт пустую БД (первый запуск).
"""

import json
import os
import sys
import time

# Позволяет запускать и как `python migrate.py` и как `python -m netwatch.migrate`
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from netwatch.db import init_db, _execute, get_conn, DB_PATH

# ── Пути к старым файлам ──────────────────────────────────────────────────────
DEVICES_FILE  = os.path.join(_ROOT, "devices.json")
SUBNETS_FILE  = os.path.join(_ROOT, "subnets.json")
EVENTS_FILE   = os.path.join(_ROOT, "events.json")
TG_FILE       = os.path.join(_ROOT, "telegram.json")
AUTH_FILE     = os.path.join(_ROOT, "auth.json")


def _load_json(path: str, default):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"  ⚠️  Не удалось прочитать {path}: {e}")
    return default


def _backup(path: str):
    if os.path.exists(path):
        bak = path + ".bak"
        os.rename(path, bak)
        print(f"  📦  {os.path.basename(path)} → {os.path.basename(bak)}")


def migrate_devices(conn) -> int:
    devices = _load_json(DEVICES_FILE, [])
    if not devices:
        print("  — devices.json пустой или не найден, пропускаем")
        return 0

    # Проверяем не мигрировали ли уже
    existing = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
    if existing > 0:
        print(f"  ⏭  devices: уже есть {existing} записей, пропускаем")
        return existing

    count = 0
    for d in devices:
        conn.execute("""
            INSERT OR IGNORE INTO devices
                (id, ip, name, location, type, mac, vendor, model,
                 cred_login, cred_password)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            d.get("id"),
            d.get("ip", ""),
            d.get("name", ""),
            d.get("location", ""),
            d.get("type", "client"),
            d.get("mac", ""),
            d.get("vendor", ""),
            d.get("model", ""),
            d.get("cred_login", ""),
            d.get("cred_password", ""),
        ))
        count += 1

    conn.commit()
    print(f"  ✅  devices: перенесено {count} устройств")
    return count


def migrate_subnets(conn) -> int:
    subnets = _load_json(SUBNETS_FILE, [])
    if not subnets:
        print("  — subnets.json пустой или не найден, пропускаем")
        return 0

    existing = conn.execute("SELECT COUNT(*) FROM subnets").fetchone()[0]
    if existing > 0:
        print(f"  ⏭  subnets: уже есть {existing} записей, пропускаем")
        return existing

    count = 0
    for s in subnets:
        conn.execute("""
            INSERT OR IGNORE INTO subnets (prefix, label, scan)
            VALUES (?, ?, ?)
        """, (
            s.get("prefix", ""),
            s.get("label", ""),
            1 if s.get("scan", True) else 0,
        ))
        count += 1

    conn.commit()
    print(f"  ✅  subnets: перенесено {count} подсетей")
    return count


def migrate_events(conn) -> int:
    events = _load_json(EVENTS_FILE, [])
    if not events:
        print("  — events.json пустой или не найден, пропускаем")
        return 0

    existing = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    if existing > 0:
        print(f"  ⏭  events: уже есть {existing} записей, пропускаем")
        return existing

    # Берём последние 5000 событий если их больше
    if len(events) > 5000:
        print(f"  ℹ️   events: {len(events)} → берём последние 5000")
        events = events[-5000:]

    count = 0
    for ev in events:
        conn.execute("""
            INSERT INTO events (ts, kind, ip, name, detail)
            VALUES (?, ?, ?, ?, ?)
        """, (
            ev.get("ts", time.time()),
            ev.get("kind", ""),
            ev.get("ip", ""),
            ev.get("name", ""),
            ev.get("detail", ""),
        ))
        count += 1

    conn.commit()
    print(f"  ✅  events: перенесено {count} событий")
    return count


def migrate_settings(conn) -> int:
    count = 0

    # Telegram config
    tg = _load_json(TG_FILE, None)
    if tg:
        existing = conn.execute(
            "SELECT COUNT(*) FROM settings WHERE key = 'telegram'"
        ).fetchone()[0]
        if existing == 0:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('telegram', ?)",
                (json.dumps(tg, ensure_ascii=False),)
            )
            print("  ✅  telegram.json → settings['telegram']")
            count += 1
        else:
            print("  ⏭  settings['telegram'] уже есть, пропускаем")

    # Auth config
    auth = _load_json(AUTH_FILE, None)
    if auth:
        existing = conn.execute(
            "SELECT COUNT(*) FROM settings WHERE key = 'auth'"
        ).fetchone()[0]
        if existing == 0:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('auth', ?)",
                (json.dumps(auth, ensure_ascii=False),)
            )
            print("  ✅  auth.json → settings['auth']")
            count += 1
        else:
            print("  ⏭  settings['auth'] уже есть, пропускаем")

    conn.commit()
    return count


def backup_json_files():
    print("\n📦  Создаём .bak копии исходных файлов...")
    for path in (DEVICES_FILE, SUBNETS_FILE, EVENTS_FILE, TG_FILE, AUTH_FILE):
        _backup(path)


def main():
    print("=" * 55)
    print("  NetWatch — Migration JSON → SQLite")
    print("=" * 55)
    print(f"\n📁  БД: {DB_PATH}\n")

    # Инициализируем схему
    init_db()
    conn = get_conn()

    print("📋  Устройства:")
    migrate_devices(conn)

    print("\n🗂  Подсети:")
    migrate_subnets(conn)

    print("\n📋  События:")
    migrate_events(conn)

    print("\n⚙️   Настройки:")
    migrate_settings(conn)

    # Финальная статистика
    print("\n" + "─" * 55)
    stats = {
        "devices":      conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0],
        "subnets":      conn.execute("SELECT COUNT(*) FROM subnets").fetchone()[0],
        "events":       conn.execute("SELECT COUNT(*) FROM events").fetchone()[0],
        "ping_history": conn.execute("SELECT COUNT(*) FROM ping_history").fetchone()[0],
        "settings":     conn.execute("SELECT COUNT(*) FROM settings").fetchone()[0],
    }
    for table, cnt in stats.items():
        print(f"  {table:<16} {cnt:>6} записей")

    db_size = os.path.getsize(DB_PATH) / 1024
    print(f"\n  Размер БД: {db_size:.1f} КБ")

    backup_json_files()

    print("\n✅  Миграция завершена!")
    print("   Запускайте NetWatch как обычно: python run.py\n")


if __name__ == "__main__":
    main()