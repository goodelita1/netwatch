#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  NetWatch — HTTPS Setup (macOS)
#  Generates self-signed TLS certificate and configures nginx
#
#  Usage:
#    chmod +x setup_https.sh
#    bash setup_https.sh        # no sudo needed (brew)
#
#  After setup:
#    bash start_https.sh        # start nginx + NetWatch
#    bash stop_https.sh         # stop nginx
# ═══════════════════════════════════════════════════════════════
set -e

CERT_DIR="$HOME/.netwatch/ssl"
CERT_DAYS=3650
NETWATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect local IP (WiFi first, then Ethernet)
SERVER_IP=$(ipconfig getifaddr en0 2>/dev/null \
         || ipconfig getifaddr en1 2>/dev/null \
         || ipconfig getifaddr en2 2>/dev/null \
         || echo "127.0.0.1")

echo "╔══════════════════════════════════════════════╗"
echo "║   NetWatch HTTPS Setup (macOS)               ║"
echo "║   Server IP: $SERVER_IP"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Check Homebrew ─────────────────────────────────────────
if ! command -v brew &>/dev/null; then
    echo "ERROR: Homebrew not found."
    echo "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    exit 1
fi
echo "[1/4] Homebrew OK"

# ── 2. Install nginx ──────────────────────────────────────────
if ! command -v nginx &>/dev/null; then
    echo "[2/4] Installing nginx via Homebrew..."
    brew install nginx
else
    echo "[2/4] nginx OK"
fi

# ── 3. Generate TLS certificate ───────────────────────────────
echo "[3/4] Generating RSA-2048 certificate ($CERT_DAYS days)..."
mkdir -p "$CERT_DIR"

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
echo "    cert: $CERT_DIR/cert.pem"
echo "    valid until: $(openssl x509 -noout -enddate -in $CERT_DIR/cert.pem | cut -d= -f2)"

# ── 4. Write nginx config ─────────────────────────────────────
echo "[4/4] Writing nginx config..."

cat > "$CERT_DIR/nginx.conf" << NGXEOF
worker_processes 1;
error_log  $CERT_DIR/error.log warn;
pid        $CERT_DIR/nginx.pid;

events { worker_connections 256; }

http {
    access_log $CERT_DIR/access.log;

    map \$http_upgrade \$connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen 8080;
        return 301 https://\$host:8443\$request_uri;
    }

    server {
        listen 8443 ssl;

        ssl_certificate     $CERT_DIR/cert.pem;
        ssl_certificate_key $CERT_DIR/key.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
        ssl_session_cache   shared:SSL:10m;
        ssl_session_timeout 1d;

        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Content-Type-Options    "nosniff"          always;
        add_header X-Frame-Options           "SAMEORIGIN"       always;

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

        location ~ \.(db|bak)\$ { deny all; return 403; }
        location /backups/       { deny all; return 403; }
    }
}
NGXEOF

nginx -c "$CERT_DIR/nginx.conf" -t 2>&1
nginx -c "$CERT_DIR/nginx.conf" -s stop 2>/dev/null && sleep 1 || true
nginx -c "$CERT_DIR/nginx.conf"
echo "    nginx running OK"

# ── Generate helper scripts ───────────────────────────────────
cat > "$NETWATCH_DIR/start_https.sh" << STARTEOF
#!/bin/bash
cd "$NETWATCH_DIR"
nginx -c "$CERT_DIR/nginx.conf" -s stop 2>/dev/null || true
sleep 1
nginx -c "$CERT_DIR/nginx.conf"
echo "OK  nginx: https://$SERVER_IP:8443"
source venv/bin/activate 2>/dev/null || true
python run.py
STARTEOF
chmod +x "$NETWATCH_DIR/start_https.sh"

cat > "$NETWATCH_DIR/stop_https.sh" << STOPEOF
#!/bin/bash
nginx -c "$CERT_DIR/nginx.conf" -s stop 2>/dev/null \
    && echo "nginx stopped" \
    || echo "nginx was not running"
STOPEOF
chmod +x "$NETWATCH_DIR/stop_https.sh"

# ── Trust certificate ─────────────────────────────────────────
echo ""
echo "Add certificate to macOS Keychain? (removes 'Not Secure' warning)"
read -r -p "[y/n]: " ADD_KC
if [[ "$ADD_KC" =~ ^[Yy]$ ]]; then
    sudo security add-trusted-cert \
        -d -r trustRoot \
        -k /Library/Keychains/System.keychain \
        "$CERT_DIR/cert.pem" \
    && echo "Trusted in System Keychain OK" \
    || echo "Failed — add manually via Keychain Access"
fi

echo ""
echo "Done! NetWatch HTTPS is ready."
echo ""
echo "  Open:     https://$SERVER_IP:8443"
echo "  Redirect: http://$SERVER_IP:8080 -> https"
echo "  Start:    bash start_https.sh"
echo "  Stop:     bash stop_https.sh"