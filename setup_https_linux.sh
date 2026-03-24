#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  NetWatch — HTTPS Setup (Linux: Ubuntu/Debian/CentOS/Arch)
#
#  Usage:
#    chmod +x setup_https_linux.sh
#    bash setup_https_linux.sh     # sudo needed for nginx + port 443
#
#  After setup:
#    bash start_https_linux.sh     # start nginx + NetWatch
#    bash stop_https_linux.sh      # stop nginx
# ═══════════════════════════════════════════════════════════════
set -e

CERT_DIR="/etc/netwatch/ssl"
CERT_DAYS=3650
NETWATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
NGINX_CONF="/etc/netwatch/nginx.conf"
NGINX_PID="/var/run/netwatch-nginx.pid"
NGINX_LOG="/var/log/netwatch"

# ── Detect package manager ────────────────────────────────────
detect_pm() {
    if command -v apt-get &>/dev/null; then echo "apt"
    elif command -v dnf &>/dev/null;   then echo "dnf"
    elif command -v yum &>/dev/null;   then echo "yum"
    elif command -v pacman &>/dev/null; then echo "pacman"
    else echo "unknown"
    fi
}

PM=$(detect_pm)

# ── Detect local IP ───────────────────────────────────────────
SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP="127.0.0.1"

echo "╔══════════════════════════════════════════════╗"
echo "║   NetWatch HTTPS Setup (Linux)               ║"
echo "║   Server IP:  $SERVER_IP"
echo "║   Package mgr: $PM"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Check root ────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: Run as root or with sudo"
    echo "  sudo bash setup_https_linux.sh"
    exit 1
fi

# ── 1. Install nginx ──────────────────────────────────────────
echo "[1/4] Checking nginx..."
if ! command -v nginx &>/dev/null; then
    echo "      Installing nginx..."
    case "$PM" in
        apt)    apt-get update -qq && apt-get install -y nginx openssl ;;
        dnf)    dnf install -y nginx openssl ;;
        yum)    yum install -y nginx openssl ;;
        pacman) pacman -Sy --noconfirm nginx openssl ;;
        *)      echo "ERROR: Unknown package manager. Install nginx manually."; exit 1 ;;
    esac
    # Disable default nginx service (we run our own instance)
    systemctl disable nginx 2>/dev/null || true
    systemctl stop nginx 2>/dev/null || true
fi
echo "      nginx $(nginx -v 2>&1 | grep -o '[0-9.]*' | head -1) OK"

# ── 2. Create directories ─────────────────────────────────────
echo "[2/4] Creating directories..."
mkdir -p "$CERT_DIR"
mkdir -p "$NGINX_LOG"
chmod 755 /etc/netwatch

# ── 3. Generate TLS certificate ───────────────────────────────
echo "[3/4] Generating RSA-2048 certificate ($CERT_DAYS days)..."

cat > "$CERT_DIR/openssl.cnf" << CNFEOF
[ req ]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_ca

[ dn ]
CN = NetWatch
O  = NetWatch Local
C  = UA

[ v3_ca ]
subjectAltName     = @alt_names
basicConstraints   = CA:FALSE
keyUsage           = digitalSignature, keyEncipherment
extendedKeyUsage   = serverAuth

[ alt_names ]
IP.1  = $SERVER_IP
IP.2  = 127.0.0.1
DNS.1 = localhost
DNS.2 = netwatch.local
CNFEOF

openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/key.pem" \
    -out    "$CERT_DIR/cert.pem" \
    -days   $CERT_DAYS \
    -config "$CERT_DIR/openssl.cnf" \
    -extensions v3_ca 2>/dev/null

chmod 600 "$CERT_DIR/key.pem"
chmod 644 "$CERT_DIR/cert.pem"

echo "      cert: $CERT_DIR/cert.pem"
echo "      valid until: $(openssl x509 -noout -enddate -in $CERT_DIR/cert.pem | cut -d= -f2)"

# ── 4. Write nginx config ─────────────────────────────────────
echo "[4/4] Writing nginx config..."

# Find nginx modules path
NGINX_MODULES=""
for p in /usr/share/nginx/modules /etc/nginx/modules; do
    [ -d "$p" ] && NGINX_MODULES="include $p/*.conf;" && break
done

cat > "$NGINX_CONF" << NGXEOF
worker_processes auto;
error_log  $NGINX_LOG/error.log warn;
pid        $NGINX_PID;
$NGINX_MODULES

events {
    worker_connections 1024;
    use epoll;
    multi_accept on;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    access_log    $NGINX_LOG/access.log;
    sendfile      on;
    tcp_nopush    on;
    keepalive_timeout 65;
    gzip on;

    # WebSocket upgrade map — must be inside http {}
    map \$http_upgrade \$connection_upgrade {
        default upgrade;
        ''      close;
    }

    # HTTP :80 → HTTPS :443
    server {
        listen 80;
        listen [::]:80;
        return 301 https://\$host\$request_uri;
    }

    # HTTPS :443
    server {
        listen 443 ssl;
        listen [::]:443 ssl;

        ssl_certificate     $CERT_DIR/cert.pem;
        ssl_certificate_key $CERT_DIR/key.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
        ssl_session_cache   shared:SSL:10m;
        ssl_session_timeout 1d;
        ssl_prefer_server_ciphers off;

        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options    "nosniff"   always;
        add_header X-Frame-Options           "SAMEORIGIN" always;
        add_header X-XSS-Protection          "1; mode=block" always;

        # Proxy → Flask :8000 (HTTP + WebSocket)
        location / {
            proxy_pass         http://127.0.0.1:8000;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade           \$http_upgrade;
            proxy_set_header   Connection        \$connection_upgrade;
            proxy_set_header   Host              \$host;
            proxy_set_header   X-Real-IP         \$remote_addr;
            proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
            proxy_read_timeout    3600s;
            proxy_send_timeout    3600s;
            proxy_connect_timeout   10s;
            proxy_buffering    off;
        }

        # Block direct access to database and backup files
        location ~ \.(db|bak)\$ { deny all; return 403; }
        location /backups/       { deny all; return 403; }
    }
}
NGXEOF

nginx -c "$NGINX_CONF" -t
echo "      nginx config valid OK"

# Start nginx
nginx -c "$NGINX_CONF" -s stop 2>/dev/null && sleep 1 || true
nginx -c "$NGINX_CONF"
echo "      nginx running OK"

# ── Generate helper scripts ───────────────────────────────────
cat > "$NETWATCH_DIR/start_https_linux.sh" << STARTEOF
#!/bin/bash
# Start nginx + NetWatch (Linux)
cd "$NETWATCH_DIR"

# Start nginx (requires root for port 443/80)
if [ "\$EUID" -ne 0 ]; then
    echo "Starting nginx requires root: sudo nginx -c $NGINX_CONF"
    sudo nginx -c "$NGINX_CONF" -s stop 2>/dev/null || true
    sleep 1
    sudo nginx -c "$NGINX_CONF"
else
    nginx -c "$NGINX_CONF" -s stop 2>/dev/null || true
    sleep 1
    nginx -c "$NGINX_CONF"
fi

echo "OK  nginx: https://$SERVER_IP"

# Start NetWatch
source venv/bin/activate 2>/dev/null || true
python run.py
STARTEOF
chmod +x "$NETWATCH_DIR/start_https_linux.sh"

cat > "$NETWATCH_DIR/stop_https_linux.sh" << STOPEOF
#!/bin/bash
sudo nginx -c "$NGINX_CONF" -s stop 2>/dev/null \
    && echo "nginx stopped" \
    || echo "nginx was not running"
STOPEOF
chmod +x "$NETWATCH_DIR/stop_https_linux.sh"

# ── Optional: systemd service ─────────────────────────────────
PYTHON_BIN="$NETWATCH_DIR/venv/bin/python"
[ ! -f "$PYTHON_BIN" ] && PYTHON_BIN=$(which python3)
RUN_USER=$(stat -c '%U' "$NETWATCH_DIR" 2>/dev/null || echo "root")

cat > /etc/systemd/system/netwatch.service << SVCEOF
[Unit]
Description=NetWatch Network Monitor
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$NETWATCH_DIR
ExecStart=$PYTHON_BIN $NETWATCH_DIR/run.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
SVCEOF

cat > /etc/systemd/system/netwatch-nginx.service << SVCEOF
[Unit]
Description=NetWatch nginx proxy
After=network.target

[Service]
Type=forking
ExecStart=/usr/sbin/nginx -c $NGINX_CONF
ExecReload=/usr/sbin/nginx -c $NGINX_CONF -s reload
ExecStop=/usr/sbin/nginx -c $NGINX_CONF -s stop
PIDFile=$NGINX_PID
Restart=on-failure

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
echo ""
echo "Systemd services created:"
echo "  sudo systemctl enable --now netwatch"
echo "  sudo systemctl enable --now netwatch-nginx"

# ── Trust certificate (system-wide) ──────────────────────────
echo ""
echo "Add certificate to system trust store? (removes browser warning on this machine)"
read -r -p "[y/n]: " ADD_TRUST
if [[ "$ADD_TRUST" =~ ^[Yy]$ ]]; then
    case "$PM" in
        apt)
            cp "$CERT_DIR/cert.pem" /usr/local/share/ca-certificates/netwatch.crt
            update-ca-certificates
            echo "Certificate trusted (Debian/Ubuntu) OK"
            ;;
        dnf|yum)
            cp "$CERT_DIR/cert.pem" /etc/pki/ca-trust/source/anchors/netwatch.pem
            update-ca-trust extract
            echo "Certificate trusted (RHEL/CentOS) OK"
            ;;
        pacman)
            cp "$CERT_DIR/cert.pem" /etc/ca-certificates/trust-source/anchors/netwatch.pem
            update-ca-trust
            echo "Certificate trusted (Arch) OK"
            ;;
    esac
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Done! NetWatch HTTPS is ready.                         ║"
echo "║                                                          ║"
echo "║  Open:     https://$SERVER_IP                      "
echo "║  Redirect: http://$SERVER_IP → https               "
echo "║                                                          ║"
echo "║  Manual start:  bash start_https_linux.sh               ║"
echo "║  Auto-start:    sudo systemctl enable --now netwatch     ║"
echo "║                 sudo systemctl enable --now netwatch-nginx║"
echo "║  Logs nginx:    $NGINX_LOG/              "
echo "╚══════════════════════════════════════════════════════════╝"
