# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## What This Project Is

**NetWatch** — a self-hosted network monitoring system built with Flask + Socket.IO + SQLite. It runs on a local network and monitors devices via ICMP ping, SNMP, and MikroTik RouterOS API. No cloud dependency.

## Commands

### Setup
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Run (development)
```bash
python run.py
# App available at http://localhost:8000
# Default credentials: admin / netwatch
```

### HTTPS (macOS)
```bash
bash setup_https.sh    # one-time: installs nginx, generates self-signed cert
bash start_https.sh    # start nginx + NetWatch
bash stop_https.sh     # stop nginx
# App available at https://YOUR_IP:8443
```

### Migration (JSON → SQLite, run once if upgrading from legacy)
```bash
python -m netwatch.migrate
```

### MikroTik API connectivity test
```bash
python test_mt.py   # hardcoded IP/credentials — edit before running
```

There is no test suite or linting configuration in this project.

## Architecture

### Backend: `netwatch/` Python package

The app uses a **Flask application factory** (`app.py`) with a single Blueprint (`routes.py`). Flask-SocketIO with **eventlet** async backend powers WebSocket real-time updates.

**Startup sequence** (`run.py` → `app.py`):
1. `init_db()` creates SQLite schema if not present
2. Flask app + ProxyFix middleware created
3. Blueprint registered → SocketIO initialized → socket handlers imported (side-effect)
4. `start_background_tasks()` launches six daemon threads

**Background threads** (all daemon, started in `app.py`):
- `background_auto_ping` — fast ping cycle every 60 s (`monitor.py`)
- `background_auto_discovery` — subnet host scan every 5 min (`monitor.py`)
- `background_auto_subnet` — scans `192.168.x.1` for new subnets every 15 min (`monitor.py`)
- `_cleanup_loop` — prunes `ping_history` table hourly (`app.py` → `db.py`)
- `backup_loop` — daily ZIP backup of `netwatch.db` (`backup.py`)
- Initial scan thread — one `_do_monitor_scan(deep=False)` at startup

**Data flow for a status change:**
`background_auto_ping` → `_do_monitor_scan()` → `_on_ping_result()` (in `monitor.py`) → `record_ping()` (SQLite) + `emit_device_update()` (WebSocket) + `add_event()` if state changed → notification channels (Telegram/Discord/Email/Webhook)

**Module responsibilities:**
- `db.py` — SQLite layer. One connection per thread via `threading.local()`. WAL mode. `_execute()` is the only function that touches sqlite3 directly. Other modules use it via `storage.py` and `events.py`.
- `storage.py` — Device and subnet CRUD, returns plain `dict`/`list`.
- `events.py` — Events log, `ping_history`, in-memory ping ring buffer (`ping_history` dict), and all notification channel logic (Telegram, Discord, SMTP, Webhook). Settings (telegram config, auth, etc.) are stored as JSON blobs in the `settings` table.
- `monitor.py` — In-memory `status_cache` and `latency_cache` (dicts, protected by `_cache_lock`). These are the **source of truth for live device status** — the database only has historical data.
- `scanner.py` — Async scanning using `asyncio` + `subprocess ping`. Runs in fresh event loops created per-scan (thread-safe). `run_async_scan()` is the main entry point.
- `oui.py` — OUI vendor DB, SNMP BER parser (pure stdlib, no net-snmp), HTTP banner grabbing, device fingerprinting.
- `mikrotik.py` — MikroTik RouterOS binary API client, port 8728, pure stdlib sockets.
- `auth.py` — Session auth + RFC 6238 TOTP (pure stdlib, no pyotp). Credentials stored in `settings` table under key `'auth'`.
- `socket_handlers.py` — Socket.IO event handlers + outbound emitters. Exports `emit_device_update`, `emit_new_event`, `emit_scan_done`. WebSocket auth supports both Flask session cookies and short-lived tokens (`?token=`).
- `socketio_instance.py` — SocketIO singleton to break circular imports between `app.py`, `monitor.py`, and `socket_handlers.py`.
- `reboot.py` — Multi-vendor reboot: MikroTik API, Dahua HTTP, SSH via paramiko.
- `config.py` — Constants only. `POWER_IP` (gateway used as power-outage indicator), `PHIST_MAX`.

### Frontend: `static/js/` (Vanilla JS, ~3900 lines)

Single-page app in `templates/index.html`. All JS is split into 11 modules loaded as separate `<script>` tags (no bundler). `globals.js` is loaded first and sets up globals, the device list, and init logic.

Real-time updates arrive via `websocket.js` (Socket.IO client), which patches the in-memory device list and calls render functions in other modules.

### Database schema (`netwatch.db`)

Six tables: `devices`, `subnets`, `events`, `ping_history`, `settings`, `audit_log`.  
`settings` is a key-value store: keys include `'auth'`, `'telegram'`, `'discord'`, `'email'`, `'webhook'`.  
`ping_history` TTL: 7 days, max 50,000 rows per IP (cleaned hourly).  
`events` capped at 5,000 rows; `audit_log` at 10,000.

### HTTPS / Deployment

nginx is used as a TLS-terminating reverse proxy. The critical requirement is `map $http_upgrade $connection_upgrade` **inside** the `http {}` block — without it WebSocket falls back to polling. Reference config in `netwatch.conf` (Linux `/etc/nginx/sites-available/`) and `setup_https.sh` / `start_https.sh` (macOS).

The `manifest.json` and `sw.js` serve the PWA. nginx must **not** block `.json` files — use `location ~ \.(db|bak)$` to block database/backup files, not `\.(json|db|bak)$`.
