"""Multi-vendor reboot engine: MikroTik / Hikvision / Dahua / ASUS / SSH."""
import socket, base64, ssl, struct, subprocess, time
import urllib.request, urllib.parse
try:
    import paramiko
    HAS_PARAMIKO = True
except ImportError:
    HAS_PARAMIKO = False


_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

def _http(url, method="GET", data=None, headers=None, login="", password="",
          timeout=8, auth="basic") -> tuple:
    """HTTP/HTTPS request with optional basic auth. Returns (status_code, body)."""
    req = urllib.request.Request(url, method=method)
    if login and auth == "basic":
        creds = base64.b64encode(f"{login}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")
    if headers:
        for k, v in headers.items(): req.add_header(k, v)
    if data:
        req.data = data.encode() if isinstance(data, str) else data
        req.add_header("Content-Type", "application/json")
    try:
        if login and auth == "digest":
            pwd_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
            pwd_mgr.add_password(None, url, login, password)
            opener = urllib.request.build_opener(
                urllib.request.HTTPDigestAuthHandler(pwd_mgr),
                urllib.request.HTTPSHandler(context=_ssl_ctx),
            )
            with opener.open(req, timeout=timeout) as r:
                return r.status, r.read().decode(errors="ignore")
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as r:
            return r.status, r.read().decode(errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="ignore")
    except Exception as ex:
        return 0, str(ex)


def _reboot_mikrotik(ip, login, password) -> dict:
    """MikroTik RouterOS REST API reboot (v7+) with HTTP fallback (v6)."""
    # Try REST API (RouterOS 7.x)
    for scheme in ("https", "http"):
        url = f"{scheme}://{ip}/rest/system/reboot"
        st, body = _http(url, method="POST", data="{}", login=login, password=password)
        if st in (200, 201, 204):
            return {"ok": True, "method": f"MikroTik REST ({scheme})", "detail": "Команда отправлена"}
    # Fallback: MikroTik API port 8728 (binary protocol)
    try:
        result = _mikrotik_api_reboot(ip, login, password)
        if result: return {"ok": True, "method": "MikroTik API (8728)", "detail": "Команда отправлена"}
    except Exception:
        pass
    return {"ok": False, "method": "MikroTik", "detail": "Не удалось подключиться. Проверьте логин/пароль и включите REST API."}


def _mikrotik_api_encode(word: str) -> bytes:
    """Encode one word for MikroTik binary API."""
    enc = word.encode("utf-8")
    length = len(enc)
    if length < 0x80:        prefix = bytes([length])
    elif length < 0x4000:    prefix = bytes([((length >> 8) | 0x80), length & 0xFF])
    else:                    prefix = struct.pack("!I", length | 0xC0000000)
    return prefix + enc

def _mikrotik_api_sentence(words: list) -> bytes:
    return b"".join(_mikrotik_api_encode(w) for w in words) + b"\x00"

def _mikrotik_api_reboot(ip: str, login: str, password: str) -> bool:
    """Minimal MikroTik binary API: login + /system/reboot."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(6)
    try:
        s.connect((ip, 8728))
        # Send /login
        s.send(_mikrotik_api_sentence(["/login", f"=name={login}", f"=password={password}"]))
        resp = s.recv(512).decode(errors="ignore")
        if "!done" not in resp and "!trap" not in resp:
            # try challenge-response (older RouterOS)
            pass
        if "!trap" in resp:
            return False
        # Send /system/reboot
        s.send(_mikrotik_api_sentence(["/system/reboot"]))
        time.sleep(0.3)
        return True
    except Exception:
        return False
    finally:
        s.close()


def _reboot_hikvision(ip, login, password) -> dict:
    """Hikvision ISAPI reboot."""
    for scheme in ("http", "https"):
        url = f"{scheme}://{ip}/ISAPI/System/reboot"
        st, body = _http(url, method="PUT", data="<reboot/>",
                         headers={"Content-Type": "application/xml"},
                         login=login, password=password)
        if st in (200, 201, 204):
            return {"ok": True, "method": f"Hikvision ISAPI ({scheme})", "detail": "Команда отправлена"}
    return {"ok": False, "method": "Hikvision", "detail": "Ошибка — проверьте учётные данные и ISAPI"}


def _reboot_dahua(ip, login, password) -> dict:
    """Dahua HTTP API reboot."""
    for scheme in ("http", "https"):
        url = f"{scheme}://{ip}/cgi-bin/magicBox.cgi?action=reboot"
        st, body = _http(url, login=login, password=password, auth="digest")
        if st == 200 and ("OK" in body or "ok" in body.lower()):
            return {"ok": True, "method": f"Dahua HTTP CGI ({scheme})", "detail": "Команда отправлена"}
    return {"ok": False, "method": "Dahua", "detail": "Ошибка — проверьте учётные данные"}


def _reboot_asus(ip, login, password) -> dict:
    """ASUS router HTTP reboot."""
    for scheme in ("http", "https"):
        # ASUS AsusWRT API
        url = f"{scheme}://{ip}/apply.cgi"
        data = "action_mode=apply&action_script=reboot"
        st, _ = _http(url, method="POST", data=data,
                      headers={"Content-Type": "application/x-www-form-urlencoded"},
                      login=login, password=password)
        if st in (200, 302):
            return {"ok": True, "method": f"ASUS HTTP ({scheme})", "detail": "Команда отправлена"}
    return {"ok": False, "method": "ASUS", "detail": "Ошибка — попробуйте через SSH"}


def _reboot_generic_http(ip, login, password) -> dict:
    """Try common HTTP reboot endpoints for unknown devices."""
    endpoints = [
        ("POST", "http",  "/api/system/reboot",    "{}"),
        ("POST", "https", "/api/system/reboot",    "{}"),
        ("GET",  "http",  "/cgi-bin/reboot.cgi",   None),
        ("POST", "http",  "/cgi-bin/reboot.cgi",   ""),
        ("POST", "http",  "/reboot",               "{}"),
        ("GET",  "http",  "/system/reboot",        None),
    ]
    for method, scheme, path, data in endpoints:
        url = f"{scheme}://{ip}{path}"
        st, body = _http(url, method=method, data=data, login=login, password=password, timeout=5)
        if st in (200, 201, 204, 302):
            return {"ok": True, "method": f"HTTP {method} {path}", "detail": f"HTTP {st}"}
    return {"ok": False, "method": "Generic HTTP", "detail": "Нет ответа от известных reboot-эндпоинтов"}


def _reboot_via_ssh(ip, login, password) -> dict:
    """SSH reboot via subprocess (requires ssh binary + sshpass or key auth)."""
    # Try with sshpass if available
    for ssh_cmd in (["sshpass", "-p", password, "ssh"], None):
        if ssh_cmd is None:
            cmd = ["ssh", "-o", "StrictHostKeyChecking=no",
                   "-o", "ConnectTimeout=5", f"{login}@{ip}", "reboot"]
        else:
            cmd = ssh_cmd + ["-o", "StrictHostKeyChecking=no",
                             "-o", "ConnectTimeout=5", f"{login}@{ip}", "reboot"]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=10)
            if r.returncode in (0, 1):  # 1 = connection closed after reboot = ok
                return {"ok": True, "method": "SSH", "detail": "Команда reboot отправлена"}
        except FileNotFoundError:
            continue
        except Exception as ex:
            return {"ok": False, "method": "SSH", "detail": str(ex)}
    return {"ok": False, "method": "SSH", "detail": "SSH недоступен на этом сервере"}


VENDOR_REBOOT = {
    "mikrotik":  _reboot_mikrotik,
    "hikvision": _reboot_hikvision,
    "dahua":     _reboot_dahua,
    "asus":      _reboot_asus,
    "ubiquiti":  _reboot_mikrotik,   # Ubiquiti also supports REST-like APIs
}

def reboot_device(device: dict) -> dict:
    """Dispatch reboot by vendor, fallback to generic HTTP then SSH."""
    ip       = device.get("ip", "")
    login    = device.get("cred_login", "admin")
    password = device.get("cred_password", "")
    vendor   = (device.get("vendor") or "").lower().strip()

    if not login:  login = "admin"
    if not password:
        return {"ok": False, "method": "—", "detail": "Пароль не задан. Добавьте учётные данные в настройках устройства."}

    # Vendor-specific first
    fn = None
    for key, func in VENDOR_REBOOT.items():
        if key in vendor:
            fn = func; break

    if fn:
        result = fn(ip, login, password)
        if result["ok"]: return result

    # Generic HTTP fallback
    result = _reboot_generic_http(ip, login, password)
    if result["ok"]: return result

    # SSH last resort
    return _reboot_via_ssh(ip, login, password)


# ══════════════════════════════════════════════════════════════════════════════
