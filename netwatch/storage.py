"""
NetWatch — Device and subnet persistence (SQLite backend).

Публичный интерфейс не изменился — все функции возвращают те же
структуры dict/list что и раньше. Остальной код проекта не требует
правок при замене JSON → SQLite.
"""

import json
from .db import _execute, init_db


# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _row_to_device(row) -> dict:
    return {
        "id":            row["id"],
        "ip":            row["ip"],
        "name":          row["name"],
        "location":      row["location"],
        "type":          row["type"],
        "mac":           row["mac"],
        "vendor":        row["vendor"],
        "model":         row["model"],
        "cred_login":    row["cred_login"],
        "cred_password": row["cred_password"],
    }


def _row_to_subnet(row) -> dict:
    return {
        "prefix": row["prefix"],
        "label":  row["label"],
        "scan":   bool(row["scan"]),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Devices
# ══════════════════════════════════════════════════════════════════════════════

def load_devices() -> list:
    init_db()
    rows = _execute("SELECT * FROM devices ORDER BY id", fetch="all")
    return [_row_to_device(r) for r in rows]


def save_devices(devices: list):
    """
    Full replace — used by deep_scan to bulk-update mac/vendor/model.
    For single-record ops prefer add_device / update_device / delete_device.
    Uses UPSERT to avoid wiping records that weren't in the list.
    """
    init_db()
    from .db import get_conn
    conn = get_conn()
    for d in devices:
        conn.execute("""
            INSERT INTO devices
                (id, ip, name, location, type, mac, vendor, model,
                 cred_login, cred_password)
            VALUES
                (:id, :ip, :name, :location, :type, :mac, :vendor, :model,
                 :cred_login, :cred_password)
            ON CONFLICT(id) DO UPDATE SET
                ip            = excluded.ip,
                name          = excluded.name,
                location      = excluded.location,
                type          = excluded.type,
                mac           = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE mac END,
                vendor        = CASE WHEN excluded.vendor != '' THEN excluded.vendor ELSE vendor END,
                model         = CASE WHEN excluded.model != '' THEN excluded.model ELSE model END,
                cred_login    = excluded.cred_login,
                cred_password = excluded.cred_password
        """, {
            "id":            d.get("id"),
            "ip":            d["ip"],
            "name":          d.get("name", ""),
            "location":      d.get("location", ""),
            "type":          d.get("type", "client"),
            "mac":           d.get("mac", ""),
            "vendor":        d.get("vendor", ""),
            "model":         d.get("model", ""),
            "cred_login":    d.get("cred_login", ""),
            "cred_password": d.get("cred_password", ""),
        })
    conn.commit()


def add_device(data: dict) -> dict:
    """Insert a new device. Returns the created device with auto id."""
    init_db()
    new_id = _execute("""
        INSERT INTO devices (ip, name, location, type, mac, vendor, model,
                             cred_login, cred_password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data["ip"],
        data.get("name", ""),
        data.get("location", ""),
        data.get("type", "client"),
        data.get("mac", ""),
        data.get("vendor", ""),
        data.get("model", ""),
        data.get("cred_login", ""),
        data.get("cred_password", ""),
    ))
    ensure_subnet_exists(data["ip"])
    row = _execute("SELECT * FROM devices WHERE id = ?", (new_id,), fetch="one")
    return _row_to_device(row)


def update_device(device_id: int, data: dict) -> dict | None:
    """Update an existing device. Returns updated record or None if not found."""
    init_db()
    row = _execute("SELECT * FROM devices WHERE id = ?", (device_id,), fetch="one")
    if not row:
        return None
    merged = dict(row)
    merged.update({k: v for k, v in data.items() if k != "id"})
    _execute("""
        UPDATE devices SET
            ip = ?, name = ?, location = ?, type = ?,
            mac = ?, vendor = ?, model = ?,
            cred_login = ?, cred_password = ?
        WHERE id = ?
    """, (
        merged["ip"], merged["name"], merged["location"], merged["type"],
        merged["mac"], merged["vendor"], merged["model"],
        merged["cred_login"], merged["cred_password"],
        device_id,
    ))
    ensure_subnet_exists(merged["ip"])
    row = _execute("SELECT * FROM devices WHERE id = ?", (device_id,), fetch="one")
    return _row_to_device(row)


def delete_device(device_id: int):
    init_db()
    _execute("DELETE FROM devices WHERE id = ?", (device_id,))


# ══════════════════════════════════════════════════════════════════════════════
# Subnets
# ══════════════════════════════════════════════════════════════════════════════

def load_subnets() -> list:
    init_db()
    rows = _execute("SELECT * FROM subnets ORDER BY prefix", fetch="all")
    return [_row_to_subnet(r) for r in rows]


def save_subnets(subnets: list):
    """Full replace of subnets table."""
    init_db()
    from .db import get_conn
    conn = get_conn()
    # Keep existing, upsert all from list
    for s in subnets:
        conn.execute("""
            INSERT INTO subnets (prefix, label, scan)
            VALUES (?, ?, ?)
            ON CONFLICT(prefix) DO UPDATE SET
                label = excluded.label,
                scan  = excluded.scan
        """, (s["prefix"], s.get("label", s["prefix"] + ".0/24"), 1 if s.get("scan", True) else 0))
    conn.commit()


def add_subnet(prefix: str, label: str = "", scan: bool = True) -> dict:
    label = label or f"{prefix}.0/24"
    _execute(
        "INSERT OR IGNORE INTO subnets (prefix, label, scan) VALUES (?, ?, ?)",
        (prefix, label, 1 if scan else 0)
    )
    row = _execute("SELECT * FROM subnets WHERE prefix = ?", (prefix,), fetch="one")
    return _row_to_subnet(row)


def update_subnet(prefix: str, data: dict) -> dict | None:
    row = _execute("SELECT * FROM subnets WHERE prefix = ?", (prefix,), fetch="one")
    if not row:
        return None
    merged = dict(row)
    merged.update(data)
    _execute(
        "UPDATE subnets SET label = ?, scan = ? WHERE prefix = ?",
        (merged["label"], 1 if merged.get("scan", True) else 0, prefix)
    )
    row = _execute("SELECT * FROM subnets WHERE prefix = ?", (prefix,), fetch="one")
    return _row_to_subnet(row)


def delete_subnet(prefix: str):
    _execute("DELETE FROM subnets WHERE prefix = ?", (prefix,))


# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════

def ip_to_prefix(ip: str) -> str | None:
    parts = ip.strip().split(".")
    return ".".join(parts[:3]) if len(parts) == 4 else None


def ensure_subnet_exists(ip: str):
    prefix = ip_to_prefix(ip)
    if not prefix:
        return
    _execute(
        "INSERT OR IGNORE INTO subnets (prefix, label, scan) VALUES (?, ?, 1)",
        (prefix, f"{prefix}.0/24")
    )