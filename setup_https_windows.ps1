# ═══════════════════════════════════════════════════════════════
#  NetWatch — HTTPS Setup (Windows 10/11)
#
#  Prerequisites:
#    - Python 3.11+ from python.org (NOT Microsoft Store)
#    - Git for Windows (optional)
#
#  Usage (PowerShell as Administrator):
#    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#    .\setup_https_windows.ps1
#
#  After setup:
#    .\start_https_windows.ps1    # start nginx + NetWatch
#    .\stop_https_windows.ps1     # stop nginx
# ═══════════════════════════════════════════════════════════════

param(
    [int]$HttpsPort = 8443,
    [int]$HttpPort  = 8080,
    [int]$FlaskPort = 8000
)

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────
$NetwatchDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CertDir     = "$env:USERPROFILE\.netwatch\ssl"
$NginxDir    = "$env:USERPROFILE\.netwatch\nginx"
$NginxExe    = "$NginxDir\nginx.exe"
$NginxConf   = "$CertDir\nginx.conf"
$CertDays    = 3650

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   NetWatch HTTPS Setup (Windows)             ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Check admin ───────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warning "Not running as Administrator. Some features may not work (firewall rules, port < 1024)."
    Write-Host "  To restart as admin: Start-Process powershell -Verb RunAs -ArgumentList '-File $PSCommandPath'" -ForegroundColor Yellow
}

# ── Detect local IP ───────────────────────────────────────────
$ServerIP = (
    Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.' } |
    Select-Object -First 1
).IPAddress
if (-not $ServerIP) { $ServerIP = "127.0.0.1" }
Write-Host "[info] Server IP: $ServerIP" -ForegroundColor Green

# ── 1. Check Python ───────────────────────────────────────────
Write-Host ""
Write-Host "[1/4] Checking Python..." -NoNewline
$PythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.(1[1-9]|[2-9]\d)") {
            $PythonCmd = $cmd
            break
        }
    } catch {}
}
if (-not $PythonCmd) {
    Write-Host " NOT FOUND" -ForegroundColor Red
    Write-Host ""
    Write-Host "Install Python 3.11+ from https://python.org/downloads" -ForegroundColor Yellow
    Write-Host "Make sure to check 'Add Python to PATH' during install" -ForegroundColor Yellow
    exit 1
}
Write-Host " $( & $PythonCmd --version )" -ForegroundColor Green

# ── 2. Download nginx for Windows ─────────────────────────────
Write-Host "[2/4] Checking nginx..." -NoNewline
if (-not (Test-Path $NginxExe)) {
    Write-Host " Downloading..." -ForegroundColor Yellow

    # Get latest nginx stable version
    $NginxVersion = "1.26.2"
    $NginxUrl     = "https://nginx.org/download/nginx-$NginxVersion.zip"
    $NginxZip     = "$env:TEMP\nginx.zip"

    Write-Host "      Downloading nginx $NginxVersion..."
    try {
        Invoke-WebRequest -Uri $NginxUrl -OutFile $NginxZip -UseBasicParsing
    } catch {
        Write-Host "      Download failed. Try manually:" -ForegroundColor Red
        Write-Host "      1. Download $NginxUrl" -ForegroundColor Yellow
        Write-Host "      2. Extract to $NginxDir" -ForegroundColor Yellow
        exit 1
    }

    New-Item -ItemType Directory -Force -Path $NginxDir | Out-Null
    Expand-Archive -Path $NginxZip -DestinationPath "$env:TEMP\nginx_extract" -Force

    # Find extracted nginx folder
    $ExtractedDir = Get-ChildItem "$env:TEMP\nginx_extract" -Directory | Select-Object -First 1
    Copy-Item "$($ExtractedDir.FullName)\*" -Destination $NginxDir -Recurse -Force
    Remove-Item $NginxZip -Force
    Remove-Item "$env:TEMP\nginx_extract" -Recurse -Force
    Write-Host "      nginx extracted to $NginxDir" -ForegroundColor Green
} else {
    $ver = & $NginxExe -v 2>&1
    Write-Host " $ver" -ForegroundColor Green
}

# ── 3. Generate TLS certificate (using OpenSSL or PowerShell) ─
Write-Host "[3/4] Generating TLS certificate..."
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

$CertFile = "$CertDir\cert.pem"
$KeyFile  = "$CertDir\key.pem"

# Try OpenSSL first (comes with Git for Windows)
$OpenSSL = $null
foreach ($path in @(
    "openssl",
    "C:\Program Files\Git\usr\bin\openssl.exe",
    "C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
    "C:\OpenSSL-Win64\bin\openssl.exe"
)) {
    try {
        & $path version 2>&1 | Out-Null
        $OpenSSL = $path; break
    } catch {}
}

if ($OpenSSL) {
    # Generate via OpenSSL
    $OpensslCnf = "$CertDir\openssl.cnf"
    @"
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
IP.1  = $ServerIP
IP.2  = 127.0.0.1
DNS.1 = localhost
DNS.2 = netwatch.local
"@ | Set-Content $OpensslCnf -Encoding ASCII

    & $OpenSSL req -x509 -newkey rsa:2048 -nodes `
        -keyout $KeyFile `
        -out    $CertFile `
        -days   $CertDays `
        -config $OpensslCnf `
        -extensions v3_ca 2>&1 | Out-Null

    Write-Host "      Certificate generated via OpenSSL OK" -ForegroundColor Green
} else {
    # Fallback: use PowerShell built-in (Windows 10+)
    Write-Host "      OpenSSL not found, using PowerShell New-SelfSignedCertificate..." -ForegroundColor Yellow

    $Cert = New-SelfSignedCertificate `
        -Subject "CN=NetWatch" `
        -DnsName "localhost", "netwatch.local" `
        -IPAddress $ServerIP, "127.0.0.1" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddDays($CertDays) `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyUsage DigitalSignature, KeyEncipherment `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")

    # Export to PEM
    $CertBytes = $Cert.RawData
    $PemCert   = "-----BEGIN CERTIFICATE-----`n"
    $PemCert  += [Convert]::ToBase64String($CertBytes, [Base64FormattingOptions]::InsertLineBreaks)
    $PemCert  += "`n-----END CERTIFICATE-----"
    Set-Content -Path $CertFile -Value $PemCert -Encoding ASCII

    # Export private key
    $KeyBytes = $Cert.PrivateKey.ExportPkcs8PrivateKey()
    $PemKey   = "-----BEGIN PRIVATE KEY-----`n"
    $PemKey  += [Convert]::ToBase64String($KeyBytes, [Base64FormattingOptions]::InsertLineBreaks)
    $PemKey  += "`n-----END PRIVATE KEY-----"
    Set-Content -Path $KeyFile -Value $PemKey -Encoding ASCII

    Write-Host "      Certificate generated via PowerShell OK" -ForegroundColor Green
}

# ── 4. Write nginx config ─────────────────────────────────────
Write-Host "[4/4] Writing nginx config..."

# Escape backslashes for nginx config
$CertFileNginx = $CertFile  -replace '\\', '/'
$KeyFileNginx  = $KeyFile   -replace '\\', '/'

@"
worker_processes 1;

events { worker_connections 256; }

http {
    include       mime.types;
    default_type  application/octet-stream;

    map `$http_upgrade `$connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen $HttpPort;
        return 301 https://`$host:${HttpsPort}`$request_uri;
    }

    server {
        listen ${HttpsPort} ssl;

        ssl_certificate     $CertFileNginx;
        ssl_certificate_key $KeyFileNginx;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
        ssl_session_cache   shared:SSL:10m;
        ssl_session_timeout 1d;

        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Content-Type-Options    "nosniff"          always;
        add_header X-Frame-Options           "SAMEORIGIN"       always;

        location / {
            proxy_pass         http://127.0.0.1:${FlaskPort};
            proxy_http_version 1.1;
            proxy_set_header   Upgrade           `$http_upgrade;
            proxy_set_header   Connection        `$connection_upgrade;
            proxy_set_header   Host              `$host;
            proxy_set_header   X-Real-IP         `$remote_addr;
            proxy_set_header   X-Forwarded-For   `$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto `$scheme;
            proxy_read_timeout    3600s;
            proxy_send_timeout    3600s;
            proxy_connect_timeout   10s;
            proxy_buffering    off;
        }

        location ~ \.(db|bak)$ { deny all; return 403; }
        location /backups/      { deny all; return 403; }
    }
}
"@ | Set-Content -Path $NginxConf -Encoding ASCII

Write-Host "      nginx config written OK" -ForegroundColor Green

# Test and start nginx
Push-Location $NginxDir
try {
    & $NginxExe -c $NginxConf -t 2>&1 | Write-Host
    # Stop if running
    try { & $NginxExe -c $NginxConf -s stop 2>&1 | Out-Null; Start-Sleep 1 } catch {}
    & $NginxExe -c $NginxConf
    Write-Host "      nginx started OK" -ForegroundColor Green
} finally {
    Pop-Location
}

# ── Generate start/stop scripts ───────────────────────────────
$StartScript = @"
# NetWatch — Start (Windows)
`$NginxDir  = "$NginxDir"
`$NginxExe  = "$NginxExe"
`$NginxConf = "$NginxConf"
`$NetwatchDir = "$NetwatchDir"

Write-Host "Starting nginx..." -ForegroundColor Cyan
Push-Location `$NginxDir
try {
    try { & `$NginxExe -c `$NginxConf -s stop 2>`$null | Out-Null; Start-Sleep 1 } catch {}
    & `$NginxExe -c `$NginxConf
} finally { Pop-Location }
Write-Host "OK  nginx: https://${ServerIP}:${HttpsPort}" -ForegroundColor Green

Write-Host "Starting NetWatch..." -ForegroundColor Cyan
Set-Location `$NetwatchDir

# Activate venv if exists
if (Test-Path "venv\Scripts\Activate.ps1") {
    & "venv\Scripts\Activate.ps1"
}

python run.py
"@
Set-Content -Path "$NetwatchDir\start_https_windows.ps1" -Value $StartScript -Encoding UTF8

$StopScript = @"
# NetWatch — Stop (Windows)
`$NginxExe  = "$NginxExe"
`$NginxConf = "$NginxConf"
Push-Location "$NginxDir"
try {
    & `$NginxExe -c `$NginxConf -s stop 2>`$null
    Write-Host "nginx stopped" -ForegroundColor Green
} catch {
    Write-Host "nginx was not running" -ForegroundColor Yellow
} finally { Pop-Location }
"@
Set-Content -Path "$NetwatchDir\stop_https_windows.ps1" -Value $StopScript -Encoding UTF8

Write-Host "      start_https_windows.ps1 created OK" -ForegroundColor Green
Write-Host "      stop_https_windows.ps1 created OK" -ForegroundColor Green

# ── Add Windows Firewall rules ────────────────────────────────
if ($isAdmin) {
    Write-Host ""
    Write-Host "Adding Windows Firewall rules..." -NoNewline
    try {
        New-NetFirewallRule -DisplayName "NetWatch HTTPS $HttpsPort" `
            -Direction Inbound -Protocol TCP -LocalPort $HttpsPort `
            -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
        New-NetFirewallRule -DisplayName "NetWatch HTTP $HttpPort" `
            -Direction Inbound -Protocol TCP -LocalPort $HttpPort `
            -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
        Write-Host " OK (ports $HttpPort, $HttpsPort opened)" -ForegroundColor Green
    } catch {
        Write-Host " Failed (add manually in Windows Firewall)" -ForegroundColor Yellow
    }
}

# ── Add venv + dependencies ───────────────────────────────────
Write-Host ""
Write-Host "Setting up Python virtual environment..."
Set-Location $NetwatchDir

if (-not (Test-Path "venv")) {
    & $PythonCmd -m venv venv
    Write-Host "      venv created OK" -ForegroundColor Green
}

& "venv\Scripts\python.exe" -m pip install --upgrade pip -q
& "venv\Scripts\pip.exe" install -r requirements.txt -q
Write-Host "      dependencies installed OK" -ForegroundColor Green

# ── Trust certificate ─────────────────────────────────────────
Write-Host ""
Write-Host "Trust certificate in Windows (removes browser warning)? [y/n]: " -NoNewline
$trust = Read-Host
if ($trust -match "^[Yy]") {
    if ($isAdmin) {
        try {
            $CertObj = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertFile)
            $Store   = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")
            $Store.Open("ReadWrite")
            $Store.Add($CertObj)
            $Store.Close()
            Write-Host "Certificate trusted in LocalMachine\Root OK" -ForegroundColor Green
        } catch {
            Write-Host "Failed to trust certificate: $_" -ForegroundColor Red
        }
    } else {
        Write-Host "Requires admin. Run script as Administrator to trust certificate." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  Done! NetWatch HTTPS is ready.                         ║" -ForegroundColor Green
Write-Host "║                                                          ║" -ForegroundColor Green
Write-Host "║  Open:     https://${ServerIP}:${HttpsPort}                    " -ForegroundColor Green
Write-Host "║  Redirect: http://${ServerIP}:${HttpPort}  → https         " -ForegroundColor Green
Write-Host "║                                                          ║" -ForegroundColor Green
Write-Host "║  Start:    .\start_https_windows.ps1                    ║" -ForegroundColor Green
Write-Host "║  Stop:     .\stop_https_windows.ps1                     ║" -ForegroundColor Green
Write-Host "║                                                          ║" -ForegroundColor Green
Write-Host "║  Login:    admin / netwatch  (change in Settings!)      ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
