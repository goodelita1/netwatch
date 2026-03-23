# NetWatch

**Network infrastructure monitoring system** — real-time device status, MikroTik management, SNMP analytics, and event notifications. Built with Flask + Socket.IO + SQLite. No cloud, no subscriptions — runs entirely on your local network.

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776ab?style=flat&logo=python)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-3.0-000000?style=flat&logo=flask)](https://flask.palletsprojects.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

---

## Features

| Feature | Description |
|---------|-------------|
| 📡 **Real-time monitoring** | WebSocket-based device status via Socket.IO |
| 📊 **Dashboard** | 24h ping history, uptime %, latency top-5 |
| 📈 **SLA analytics** | Uptime % for 24h / 7d / 30d with trend ↑↓ |
| 📄 **PDF reports** | Print-ready reports via browser Cmd+P |
| ⬡ **MikroTik** | Hotspot users, Firewall, DHCP leases, Syslog receiver |
| 📡 **SNMP** | Live Tx/Rx per interface |
| 🛤 **Traceroute** | Visual hop diagram with latency arcs |
| 🕸 **Topology** | D3.js force-directed network map with subnet zones |
| 🔍 **Auto-discovery** | Async scanner finds new hosts every 5 min |
| 🔔 **Notifications** | Telegram · Discord · Email · Webhook |
| 🔒 **Security** | HTTPS/TLS · 2FA TOTP · Brute-force protection · Audit log |
| 💾 **Auto-backup** | Daily ZIP backups of SQLite database |
| 📱 **PWA** | Installable on iPhone and Android home screen |

---

## Quick Start

### macOS / Linux

```bash
# 1. Clone
git clone https://github.com/goodelita1/netwatch.git
cd netwatch

# 2. Virtual environment
python3 -m venv venv
source venv/bin/activate

# 3. Dependencies
pip install -r requirements.txt

# 4. Run
python run.py
# Open: http://localhost:8000
# Login: admin / netwatch  ← change this after first login
```

### Windows (WSL2)

```powershell
wsl --install -d Ubuntu
```

```bash
# Inside WSL:
sudo apt install python3-venv python3-pip traceroute -y
git clone https://github.com/goodelita1/netwatch.git
cd netwatch
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python run.py
```

Open `http://localhost:8000` in your Windows browser.

---

## Database Setup

### How it works

NetWatch uses **SQLite with WAL mode** (`netwatch.db` in the project root).  
The database is **created automatically on first launch** — no setup required.

```
netwatch.db        ← auto-created at startup
backups/           ← daily ZIP backups stored here automatically
```

**Schema:**

| Table | Contents | Cap |
|-------|----------|-----|
| `devices` | IP, name, type, MAC, vendor, credentials | — |
| `subnets` | Subnet registry for auto-scanning | — |
| `events` | Down/up/reboot/new-host events | 5,000 rows |
| `ping_history` | Sparklines + SLA data (7-day TTL) | 50,000/IP |
| `settings` | Auth, 2FA, Telegram, Discord, Email, Webhook | key-value |
| `audit_log` | Login attempts and credential changes | 10,000 rows |

WAL mode allows concurrent reads while writing — safe for multi-threaded Flask.  
Each background thread gets its own SQLite connection via `threading.local()`.

### Migrate from legacy JSON (one-time only)

If upgrading from a version that stored data in JSON files:

```bash
python -m netwatch.migrate
```

Migrates `devices.json`, `events.json`, `subnets.json`, `telegram.json` into SQLite.  
Original files are renamed to `.bak`. Run only once.

### Manual backup

```bash
# Via API (requires browser session cookie):
curl -b cookies.txt -X POST http://localhost:8000/api/backup

# Direct Python backup (safe while server is running — uses sqlite3.backup()):
python3 - <<'EOF'
import sqlite3
src = sqlite3.connect("netwatch.db")
dst = sqlite3.connect("netwatch_manual.db")
src.backup(dst)
dst.close(); src.close()
print("Done")
EOF
```

Automatic daily backups go to `backups/netwatch_YYYY-MM-DD_HH-MM.zip`.  
The last 30 backups are kept; older ones are deleted automatically.

---

## HTTPS Setup

### macOS (one command)

```bash
bash setup_https.sh
# Installs nginx via Homebrew, generates RSA-2048 self-signed cert with SAN,
# configures WebSocket proxy. Run once only.

bash start_https.sh    # start nginx + NetWatch
bash stop_https.sh     # stop nginx
# Open: https://YOUR_IP:8443
```

To trust the certificate and remove the browser warning:

```bash
sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain ~/.netwatch/ssl/cert.pem
```

### Linux (nginx)

```bash
sudo apt install nginx -y

# Generate self-signed certificate
sudo mkdir -p /etc/ssl/netwatch
sudo openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /etc/ssl/netwatch/key.pem \
    -out    /etc/ssl/netwatch/cert.pem \
    -days 3650 -subj "/CN=NetWatch"

# Deploy config
sudo cp netwatch.conf /etc/nginx/sites-available/netwatch
# Edit the /static/ alias path in netwatch.conf to match your install directory
sudo ln -s /etc/nginx/sites-available/netwatch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**Critical:** `map $http_upgrade $connection_upgrade` must be **inside** `http {}` — without it WebSocket falls back to long-polling.

**PWA:** Do **not** block `.json` files in nginx:

```nginx
location ~ \.(db|bak)$  { deny all; }   # ✅ correct
# NOT: \.(json|db|bak)$                 # ❌ breaks manifest.json → PWA fails
```

### Linux systemd (auto-start on boot)

```ini
# /etc/systemd/system/netwatch.service
[Unit]
Description=NetWatch Network Monitor
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/netwatch
ExecStart=/opt/netwatch/venv/bin/python run.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now netwatch
```

---

## Configuration

### Default credentials

`admin` / `netwatch` — change in **Settings → Authorization** after first login.

### Power outage detection

Set your router/gateway IP in **Settings → Power indicator**.  
If this IP goes offline, NetWatch shows a `NO POWER` banner.  
Default: `192.168.88.1` (MikroTik default).

> Note: the frontend also has this IP hardcoded in `static/js/globals.js` line 69.  
> Update both the settings and that constant if your gateway differs.

### Telegram

1. Create bot via `@BotFather` → `/newbot` → copy the token
2. Add the bot to your group/channel as admin
3. Get Chat ID: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Enter token + Chat ID in **Settings → Telegram**

### MikroTik API

```bash
# On MikroTik (Winbox terminal or SSH):
/ip service enable api
/ip service set api port=8728
```

Add credentials to the device card. The MikroTik tab becomes available automatically.

### MikroTik Syslog receiver

```bash
# On MikroTik:
/system logging action add name=netwatch target=remote \
    remote=NETWATCH_IP remote-port=5140

/system logging add topics=firewall action=netwatch
/system logging add topics=dhcp     action=netwatch
/system logging add topics=wireless action=netwatch
/system logging add topics=system   action=netwatch
```

Use port **5140** on macOS (port 514 requires root).  
Start the receiver in **Settings → MikroTik → Syslog**.

RouterOS 7 without `bsd-syslog=yes` sends plain-format UDP packets where multiple log entries are concatenated into one datagram — NetWatch splits these automatically.

---

## API Reference

All endpoints require authentication. Log in first:

```bash
curl -c cookies.txt -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"netwatch"}'
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/devices` | GET | All devices with live status |
| `/api/devices` | POST | Add device |
| `/api/devices/<id>` | PUT/DELETE | Update/delete device |
| `/api/ping/<ip>` | GET | Single ping + fires events |
| `/api/snmp/<ip>/traffic` | GET | Live Tx/Rx bps (2-poll, ~2s) |
| `/api/traceroute/<ip>` | GET | Traceroute hops |
| `/api/topology` | GET | Network graph (nodes + edges) |
| `/api/sla` | GET | SLA data (1d/7d/30d per device) |
| `/api/report/html?period=7d` | GET | Printable HTML report |
| `/api/dashboard` | GET | Dashboard aggregates |
| `/api/mt/<ip>/hotspot/active` | GET | MikroTik active Hotspot sessions |
| `/api/mt/<ip>/dhcp` | GET | MikroTik DHCP leases |
| `/api/audit` | GET | Audit log |
| `/api/backup` | POST | Create backup now |
| `/api/export/devices.csv` | GET | CSV export |

---

## WebSocket Events

Connect to the same base URL. Auth via session cookie or `?token=` query param.

| Event | Direction | Description |
|-------|-----------|-------------|
| `connected` | → Client | Initial snapshot of all devices |
| `device_update` | → Client | Status/latency change for one device |
| `new_event` | → Client | New log event (down/up/reboot) |
| `scan_done` | → Client | Auto-ping cycle completed |
| `ping_request` | Client → | Request immediate ping for one IP |

---

## Troubleshooting

**MikroTik API: "wrong password"**
```bash
nc -zv 192.168.88.1 8728
# On MikroTik:
/ip service print
/user print detail where name=admin   # allowed-address must be empty or include NetWatch IP
```

**WebSocket shows "Poll" not "Live"**
- Confirm nginx has `map $http_upgrade $connection_upgrade` inside `http {}`
- Confirm `proxy_read_timeout 3600s` is set
- Browser extension errors (TronLink, MetaMask, Polkadot) in console are unrelated

**manifest.json 403/404 → PWA broken**
- Check nginx config: `location ~ \.(db|bak)$` — must **not** include `.json`

**Syslog: no entries**
- Check: `/system logging action print` on MikroTik
- Test: `/log info message="test"` on MikroTik
- Confirm port 5140 is not firewalled between MikroTik and the NetWatch host

**"Not Secure" browser warning**
- Normal for self-signed certs. To trust on macOS:
  ```bash
  sudo security add-trusted-cert -d -r trustRoot \
      -k /Library/Keychains/System.keychain ~/.netwatch/ssl/cert.pem
  ```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.11, Flask 3.0, Flask-SocketIO 5.3, Eventlet |
| Database | SQLite (WAL mode, per-thread connections) |
| Frontend | Vanilla JS ES2022, 11 modules (~3900 lines, no bundler) |
| Charts | Chart.js 4.4 |
| Network graph | D3.js 7.8 |
| Real-time | Socket.IO 4.7 (WebSocket transport) |
| MikroTik API | Binary protocol port 8728, pure stdlib |
| 2FA | RFC 6238 TOTP, pure stdlib (no pyotp) |
| Proxy | nginx with WebSocket upgrade |
| PWA | Service Worker, Web App Manifest, 8 icon sizes |

---

## License

MIT — free for personal and commercial use.
