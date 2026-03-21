#!/bin/bash
# NetWatch — HTTPS setup для macOS
# Требования: Homebrew (https://brew.sh)
#
# Запуск (без sudo — brew не любит sudo):
#   chmod +x setup_https.sh
#   bash setup_https.sh

set -e

CERT_DIR="$HOME/.netwatch/ssl"
CERT_DAYS=3650
NETWATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
STATIC_PATH="$NETWATCH_DIR/static"

# Определяем IP на macOS (en0 = WiFi, en1 = Ethernet)
SERVER_IP=$(ipconfig getifaddr en0 2>/dev/null \
         || ipconfig getifaddr en1 2>/dev/null \
         || ipconfig getifaddr en2 2>/dev/null \
         || echo "127.0.0.1")

echo "========================================================"
echo "  NetWatch HTTPS Setup (macOS)"
echo "  IP адрес: $SERVER_IP"
echo "========================================================"
echo ""

# ── 1. Homebrew ────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
    echo "ERROR: Homebrew не найден."
    echo "Установите: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    exit 1
fi
echo "[1/4] Homebrew OK"

# ── 2. nginx ───────────────────────────────────────────────────────────────────
if ! command -v nginx &>/dev/null; then
    echo "[2/4] Устанавливаем nginx..."
    brew install nginx
else
    echo "[2/4] nginx OK ($(nginx -v 2>&1 | grep -o '[0-9.]*'))"
fi

# ── 3. TLS сертификат ─────────────────────────────────────────────────────────
echo "[3/4] Генерируем сертификат RSA-2048 на $CERT_DAYS дней..."
mkdir -p "$CERT_DIR"

# На macOS нет -addext — используем конфиг файл с SAN
OPENSSL_CNF="$CERT_DIR/openssl.cnf"
cat > "$OPENSSL_CNF" << CNFEOF
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
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

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
    -config "$OPENSSL_CNF" \
    -extensions v3_ca

chmod 600 "$CERT_DIR/key.pem"
EXPIRY=$(openssl x509 -noout -enddate -in "$CERT_DIR/cert.pem" | cut -d= -f2)
echo "    cert: $CERT_DIR/cert.pem"
echo "    до:   $EXPIRY"

# ── 4. nginx конфиг ───────────────────────────────────────────────────────────
echo "[4/4] Создаём nginx конфиг..."

NGINX_CONF="$CERT_DIR/nginx.conf"
cat > "$NGINX_CONF" << NGXEOF
worker_processes 1;
error_log  $CERT_DIR/error.log warn;
pid        $CERT_DIR/nginx.pid;

events { worker_connections 256; }

http {
    access_log $CERT_DIR/access.log;

    # HTTP :8080 -> HTTPS :8443
    server {
        listen 8080;
        return 301 https://\$host:8443\$request_uri;
    }

    # HTTPS :8443
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

        # Proxy -> Flask :8000 — включая /static/ (Flask сам отдаёт)
        location / {
            proxy_pass         http://127.0.0.1:8000;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade           \$http_upgrade;
            proxy_set_header   Connection        "upgrade";
            proxy_set_header   Host              \$host;
            proxy_set_header   X-Real-IP         \$remote_addr;
            proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
            proxy_read_timeout 60s;
            proxy_buffering    off;
        }

        location ~ \.(json|db|bak)\$ { deny all; return 403; }
        location /backups/            { deny all; return 403; }
    }
}
NGXEOF

# Проверяем конфиг
nginx -c "$NGINX_CONF" -t 2>&1
echo "    конфиг валиден"

# Останавливаем если уже запущен
nginx -c "$NGINX_CONF" -s stop 2>/dev/null && sleep 1 || true

# Запускаем
nginx -c "$NGINX_CONF"
echo "    nginx запущен"

# ── Генерируем start / stop скрипты ───────────────────────────────────────────
cat > "$NETWATCH_DIR/start_https.sh" << STARTEOF
#!/bin/bash
# Запускает nginx + NetWatch
cd "$NETWATCH_DIR"
nginx -c "$NGINX_CONF" -s stop 2>/dev/null || true
sleep 1
nginx -c "$NGINX_CONF"
echo "OK  nginx: https://$SERVER_IP:8443"
source venv/bin/activate 2>/dev/null || true
python run.py
STARTEOF
chmod +x "$NETWATCH_DIR/start_https.sh"

cat > "$NETWATCH_DIR/stop_https.sh" << STOPEOF
#!/bin/bash
nginx -c "$NGINX_CONF" -s stop 2>/dev/null && echo "nginx остановлен" || echo "nginx не был запущен"
STOPEOF
chmod +x "$NETWATCH_DIR/stop_https.sh"

# ── Добавить сертификат в Keychain? ───────────────────────────────────────────
echo ""
echo "Добавить сертификат в связку ключей macOS?"
echo "(убирает предупреждение 'Небезопасно' в браузере)"
read -r -p "[y/n]: " ADD_KC

if [[ "$ADD_KC" =~ ^[Yy]$ ]]; then
    sudo security add-trusted-cert \
        -d -r trustRoot \
        -k /Library/Keychains/System.keychain \
        "$CERT_DIR/cert.pem" \
    && echo "Сертификат добавлен в System Keychain." \
    || echo "Не удалось. Добавьте вручную (Keychain Access -> System -> Import)."
fi

# ── Итог ───────────────────────────────────────────────────────────────────────
echo ""
echo "========================================================"
echo "  ГОТОВО!"
echo ""
echo "  HTTPS:   https://$SERVER_IP:8443"
echo "  HTTP->:  http://$SERVER_IP:8080  (редирект на 8443)"
echo "  Flask:   http://localhost:8000   (напрямую, без TLS)"
echo ""
echo "  Запуск всего сразу:  bash start_https.sh"
echo "  Остановка nginx:     bash stop_https.sh"
echo "  Конфиг и логи:       $CERT_DIR/"
echo "========================================================"