# NetWatch

**Network infrastructure monitoring system** — real-time device status, MikroTik management, SNMP analytics, and event notifications. Built with Flask + Socket.IO + SQLite. No cloud, no subscriptions — runs entirely on your local network.

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776ab?style=flat&logo=python)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-3.0-000000?style=flat&logo=flask)](https://flask.palletsprojects.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

---

## Features

| Feature | Description |
|---------|-------------|
| 📡 **Real-time monitoring** | WebSocket-based device status (0ms latency via Socket.IO) |
| 📊 **Dashboard** | Chart.js: 24h ping history, uptime %, latency top-5 |
| 📈 **SLA analytics** | Uptime % for 24h / 7d / 30d with trend ↑↓ |
| 📄 **PDF reports** | Print-ready reports via browser Cmd+P |
| ⬡ **MikroTik** | Hotspot users, Firewall, DHCP leases, Syslog receiver |
| 📡 **SNMP** | Live Tx/Rx per interface (Winbox-style modal) |
| 🛤 **Traceroute** | Visual hop diagram with latency arcs |
| 🕸 **Topology** | D3.js force-directed network map with subnet zones |
| 🔍 **Auto-discovery** | Async scanner finds new hosts every 5 min |
| 🔔 **Notifications** | Telegram · Discord · Email · Webhook |
| 🔒 **Security** | HTTPS/TLS · 2FA TOTP · Brute-force protection · Audit log |
| 💾 **Auto-backup** | Daily ZIP backups of SQLite database |
| 📱 **PWA** | Installable on iPhone and Android home screen |

---

## Project Structure

```
web_UI/
│
├── run.py                      # Entry point — starts Flask + Socket.IO
├── requirements.txt            # Python dependencies
├── generate_icons.py           # PWA icon generator (run once)
├── setup_https.sh              # HTTPS setup script (macOS)
├── start_https.sh              # Start nginx + NetWatch
├── stop_https.sh               # Stop nginx
│
├── netwatch/                   # Python package
│   ├── app.py                  # Flask factory — creates app, registers socketio
│   ├── routes.py               # All HTTP API endpoints (62 routes)
│   ├── monitor.py              # Ping loops, auto-discovery, scan orchestration
│   ├── scanner.py              # Async scanner (ping + ports + MAC + SNMP)
│   ├── oui.py                  # OUI vendor DB, SNMP engine, BER parser
│   ├── reboot.py               # Multi-vendor reboot (MikroTik / Dahua / SSH)
│   ├── mikrotik.py             # MikroTik RouterOS binary API (port 8728)
│   ├── db.py                   # SQLite core — WAL mode, per-thread connections
│   ├── storage.py              # Device & subnet CRUD
│   ├── events.py               # Events, ping history, all notification channels
│   ├── auth.py                 # Session auth + 2FA TOTP (pure stdlib)
│   ├── backup.py               # Auto-backup daemon
│   ├── config.py               # Constants
│   ├── migrate.py              # One-time migration: JSON → SQLite
│   ├── socket_handlers.py      # Socket.IO handlers + emitters
│   └── socketio_instance.py    # Socket.IO singleton
│
├── static/
│   ├── css/main.css            # Dark theme stylesheet
│   ├── js/                     # Frontend — 11 modules
│   │   ├── globals.js          # Globals, device list, settings, init (1300 lines)
│   │   ├── traceroute.js       # Traceroute tab
│   │   ├── topology.js         # Network topology (D3.js)
│   │   ├── groups.js           # Bulk actions
│   │   ├── snmp.js             # SNMP modal
│   │   ├── dashboard.js        # Dashboard charts
│   │   ├── notifications.js    # Discord, Email, Webhook, Sound, Backup, Audit
│   │   ├── twofa.js            # 2FA management
│   │   ├── sla.js              # SLA analytics
│   │   ├── mikrotik.js         # MikroTik tab
│   │   └── websocket.js        # Socket.IO real-time client
│   ├── icons/                  # PWA icons (72px–512px PNG)
│   ├── manifest.json           # PWA manifest
│   └── sw.js                   # Service Worker
│
├── templates/
│   ├── index.html              # Main SPA
│   └── login.html              # Login page (supports 2FA second step)
│
└── netwatch.db                 # SQLite database (auto-created)
```

---

## Quick Start

### macOS

```bash
# 1. Clone
git clone https://github.com/goodelita1/netwatch.git
cd netwatch

# 2. Virtual environment
python3 -m venv venv
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run (HTTP, development)
python run.py
# Open: http://localhost:8000
# Login: admin / netwatch  ← change this immediately!

# 5. Setup HTTPS (recommended)
bash setup_https.sh
bash start_https.sh
# Open: https://YOUR_IP:8443
```

### Linux (Ubuntu/Debian)

```bash
# Install system packages
sudo apt update
sudo apt install python3-venv python3-pip traceroute -y

# Clone and setup
git clone https://github.com/goodelita1/netwatch.git
cd netwatch
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run
python run.py

# HTTPS with nginx (see HTTPS section)
```

#### Systemd auto-start (Linux)

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

### Windows (WSL2)

```powershell
# Enable WSL2
wsl --install -d Ubuntu
```

```bash
# Inside WSL terminal:
sudo apt install python3-venv python3-pip traceroute -y
git clone https://github.com/goodelita1/netwatch.git
cd netwatch
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python run.py
```

Open `http://localhost:8000` in Windows browser.

---

## HTTPS Setup

### macOS (one command)

```bash
bash setup_https.sh
```

Installs nginx, generates RSA-2048 certificate with SAN, configures WebSocket proxy, optionally trusts cert in Keychain.

### Linux (nginx)

```bash
sudo apt install nginx -y

# Generate certificate
sudo mkdir -p /etc/ssl/netwatch
sudo openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /etc/ssl/netwatch/key.pem \
    -out    /etc/ssl/netwatch/cert.pem \
    -days 3650 -subj "/CN=NetWatch"

# Enable site
sudo cp nginx/netwatch.conf /etc/nginx/sites-available/netwatch
sudo ln -s /etc/nginx/sites-available/netwatch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Important:** nginx config must have `map $http_upgrade $connection_upgrade` inside the `http {}` block for WebSocket to work correctly.

---

## Configuration

### Default credentials

Login: `admin` / Password: `netwatch`

> Change in **Settings → Authorization** after first login.

### Power outage detection

Set your router/gateway IP in **Settings → Power indicator**.
If this IP stops responding, NetWatch displays a "NO POWER" banner.
Default: `192.168.88.1` (MikroTik default gateway).

### Telegram setup

1. Create bot: `@BotFather` → `/newbot` → copy token
2. Add bot to your channel/group as admin
3. Get Chat ID: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Enter token + Chat ID in **Settings → Telegram**

### MikroTik API

```
# On MikroTik (SSH or terminal):
/ip service enable api
/ip service set api port=8728
```

Add credentials to the device card, then use the **MikroTik** tab.

### Syslog receiver

```
# On MikroTik:
/system logging action add name=netwatch target=remote \
    remote=NETWATCH_IP remote-port=5140

/system logging add topics=firewall action=netwatch
/system logging add topics=dhcp     action=netwatch
/system logging add topics=wireless action=netwatch
/system logging add topics=system   action=netwatch
```

> macOS: use port **5140** (port 514 requires root). Start receiver in **Settings → MikroTik → Syslog**.

---

## Database

SQLite with WAL mode. File: `netwatch.db` in project root.

| Table | Contents |
|-------|----------|
| `devices` | IP, name, type, MAC, vendor, credentials |
| `subnets` | Subnet registry for scanning |
| `events` | Down/up/reboot/new_host events (max 5,000) |
| `ping_history` | Timestamps for sparklines and SLA (TTL 7 days) |
| `settings` | Telegram, auth, 2FA secret, Discord, Email, Webhook |
| `audit_log` | Login attempts, credential changes (max 10,000) |

### Migration from legacy JSON

```bash
python -m netwatch.migrate
```

Migrates `devices.json`, `events.json`, `subnets.json`, `telegram.json` to SQLite. Original files renamed to `.bak`.

---

## API Reference

All endpoints require authentication (`/login` first).

```bash
# Quick test
curl -c cookies.txt -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"netwatch"}'

curl -b cookies.txt http://localhost:8000/api/devices
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/devices` | GET | All devices with live status |
| `/api/devices` | POST | Add device |
| `/api/devices/<id>` | PUT/DELETE | Update/delete device |
| `/api/ping/<ip>` | GET | Single ping + fires events |
| `/api/snmp/<ip>/traffic` | GET | Live Tx/Rx bps |
| `/api/traceroute/<ip>` | GET | Traceroute |
| `/api/topology` | GET | Network graph |
| `/api/sla` | GET | SLA data (1d/7d/30d) |
| `/api/report/html?period=7d` | GET | Printable HTML report |
| `/api/dashboard` | GET | Dashboard charts data |
| `/api/mt/<ip>/hotspot/active` | GET | MikroTik Hotspot sessions |
| `/api/mt/<ip>/dhcp` | GET | DHCP leases |
| `/api/audit` | GET | Audit log |
| `/api/backup` | POST | Create backup now |
| `/api/export/devices.csv` | GET | CSV export |

---

## WebSocket Events

Connect to the same URL. Authentication via session or `?token=` query param.

| Event | Direction | Description |
|-------|-----------|-------------|
| `connected` | → Client | Snapshot of all devices on connect |
| `device_update` | → Client | Single device status/latency change |
| `new_event` | → Client | New log event (down/up/reboot) |
| `scan_done` | → Client | Ping scan cycle completed |
| `ping_request` | Client → | Request immediate ping for IP |

---

## Troubleshooting

**MikroTik API: "wrong password"**
```bash
nc -zv 192.168.88.1 8728    # check port is open
# On MikroTik:
/ip service print            # verify api is enabled
/user print detail where name=admin  # check allowed-address is empty
```

**WebSocket shows "Poll" not "Live"**
- Check nginx has `map $http_upgrade $connection_upgrade` **inside** `http {}`
- Check `proxy_read_timeout 3600s` is set
- Browser extension errors in console (TronLink, Polkadot, MetaMask) are **not** NetWatch errors — safely ignore them

**manifest.json 403/404**
- Remove `location ~ \.(json|db|bak)$` from nginx
- Use only `location ~ \.(db|bak)$` — JSON files must pass through to Flask

**Syslog: no entries**
- Verify MikroTik logging action was created: `/system logging action print`
- Test: `/log info message="test"` on MikroTik
- Check port 5140 is not blocked

**"Not Secure" browser warning**
- Normal for self-signed certificate
- To remove: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.netwatch/ssl/cert.pem`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.11, Flask 3.0, Flask-SocketIO 5.3, Eventlet |
| Database | SQLite (WAL mode, per-thread connections) |
| Frontend | Vanilla JS ES2022, 11 modules (~3900 lines) |
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