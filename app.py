"""
NetWatch — Network Monitor
Features:
  • Async parallel scanner (50× faster via asyncio + ThreadPoolExecutor)
  • Auto-ping every 60 seconds (background loop)
  • Ping latency display in monitor table
  • MAC address lookup from ARP table
  • OUI vendor identification (offline, built-in DB)
  • Device model fingerprinting (MikroTik / Hikvision / Ubiquiti / etc.)
  • Subnet registry + host discovery + subnet range scanner
"""

from flask import Flask, jsonify, request, render_template_string
import subprocess, threading, json, os, time, platform, asyncio
import re, socket
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__)
DEVICES_FILE  = "devices.json"
SUBNETS_FILE  = "subnets.json"

# ══════════════════════════════════════════════════════════════════════════════
# OUI Database — top vendors seen in networks (prefix → vendor)
# ══════════════════════════════════════════════════════════════════════════════
OUI_DB = {
    # MikroTik
    "4C:5E:0C": "MikroTik", "B8:69:F4": "MikroTik", "6C:3B:6B": "MikroTik",
    "DC:2C:6E": "MikroTik", "E4:8D:8C": "MikroTik", "CC:2D:E0": "MikroTik",
    "18:FD:74": "MikroTik", "48:8F:5A": "MikroTik", "08:55:31": "MikroTik",
    "D4:CA:6D": "MikroTik", "2C:C8:1B": "MikroTik",
    # Ubiquiti
    "24:A4:3C": "Ubiquiti",  "78:8A:20": "Ubiquiti",  "FC:EC:DA": "Ubiquiti",
    "80:2A:A8": "Ubiquiti",  "00:27:22": "Ubiquiti",  "04:18:D6": "Ubiquiti",
    "44:D9:E7": "Ubiquiti",  "68:72:51": "Ubiquiti",  "E0:63:DA": "Ubiquiti",
    "F0:9F:C2": "Ubiquiti",  "B4:FB:E4": "Ubiquiti",
    # Hikvision
    "C8:02:8F": "Hikvision", "BC:AD:28": "Hikvision", "44:19:B6": "Hikvision",
    "54:C4:15": "Hikvision", "A0:AC:22": "Hikvision", "E4:24:6C": "Hikvision",
    "D0:C0:BF": "Hikvision", "28:57:BE": "Hikvision",
    # Dahua
    "90:02:A9": "Dahua",     "40:6B:AE": "Dahua",     "E4:24:6C": "Dahua",
    "3C:EF:8C": "Dahua",     "C4:2F:90": "Dahua",
    # ASUS
    "00:11:2F": "ASUS",      "04:92:26": "ASUS",      "08:60:6E": "ASUS",
    "10:BF:48": "ASUS",      "14:DA:E9": "ASUS",      "1C:87:2C": "ASUS",
    "2C:4D:54": "ASUS",      "2C:56:DC": "ASUS",      "30:85:A9": "ASUS",
    "38:D5:47": "ASUS",      "40:16:7E": "ASUS",      "50:46:5D": "ASUS",
    "60:45:CB": "ASUS",      "70:4D:7B": "ASUS",      "74:D0:2B": "ASUS",
    "78:24:AF": "ASUS",      "A8:5E:45": "ASUS",      "AC:22:0B": "ASUS",
    "B0:6E:BF": "ASUS",
    # Apple
    "00:17:F2": "Apple",     "00:1B:63": "Apple",     "00:1E:C2": "Apple",
    "00:1F:F3": "Apple",     "00:21:E9": "Apple",     "00:22:41": "Apple",
    "00:23:12": "Apple",     "00:23:32": "Apple",     "00:23:6C": "Apple",
    "00:24:36": "Apple",     "00:25:00": "Apple",     "00:25:4B": "Apple",
    "00:25:BC": "Apple",     "00:26:08": "Apple",     "00:26:4A": "Apple",
    "00:26:B0": "Apple",     "00:26:BB": "Apple",     "28:CF:DA": "Apple",
    "3C:07:54": "Apple",     "40:A6:D9": "Apple",     "44:2A:60": "Apple",
    "58:55:CA": "Apple",     "60:F8:1D": "Apple",     "68:A8:6D": "Apple",
    "6C:40:08": "Apple",     "70:56:81": "Apple",     "78:4F:43": "Apple",
    "7C:6D:62": "Apple",     "8C:00:6D": "Apple",     "90:60:F0": "Apple",
    "98:FE:94": "Apple",     "A8:66:7F": "Apple",     "AC:CF:85": "Apple",
    "B8:53:AC": "Apple",     "D8:A2:5E": "Apple",     "E4:CE:8F": "Apple",
    # Samsung
    "00:12:47": "Samsung",   "00:15:99": "Samsung",   "00:16:32": "Samsung",
    "00:17:C9": "Samsung",   "00:1A:8A": "Samsung",   "00:1D:25": "Samsung",
    "00:21:19": "Samsung",   "00:23:39": "Samsung",   "08:08:C2": "Samsung",
    "10:1D:C0": "Samsung",   "18:3A:2D": "Samsung",   "1C:62:B8": "Samsung",
    "20:64:32": "Samsung",   "28:BA:B5": "Samsung",   "30:CD:A7": "Samsung",
    "34:14:5F": "Samsung",   "38:AA:3C": "Samsung",   "40:0E:85": "Samsung",
    "44:4E:1A": "Samsung",   "50:01:BB": "Samsung",   "54:92:BE": "Samsung",
    "5C:49:79": "Samsung",   "60:6B:BD": "Samsung",   "8C:C8:CD": "Samsung",
    "A0:07:98": "Samsung",   "B8:BC:1B": "Samsung",   "C4:62:EA": "Samsung",
    "CC:07:AB": "Samsung",   "D0:22:BE": "Samsung",   "E4:40:E2": "Samsung",
    # TP-Link
    "00:1D:0F": "TP-Link",   "14:CC:20": "TP-Link",   "1C:3B:F3": "TP-Link",
    "50:C7:BF": "TP-Link",   "54:A7:03": "TP-Link",   "60:32:B1": "TP-Link",
    "64:70:02": "TP-Link",   "70:4F:57": "TP-Link",   "74:EA:3A": "TP-Link",
    "90:F6:52": "TP-Link",   "98:DA:C4": "TP-Link",   "A0:F3:C1": "TP-Link",
    "B0:95:75": "TP-Link",   "B4:B0:24": "TP-Link",   "C0:25:E9": "TP-Link",
    "D8:07:B6": "TP-Link",   "E8:DE:27": "TP-Link",   "F4:F2:6D": "TP-Link",
    # Cisco
    "00:00:0C": "Cisco",     "00:01:42": "Cisco",     "00:01:43": "Cisco",
    "00:01:64": "Cisco",     "00:01:96": "Cisco",     "00:01:97": "Cisco",
    "00:02:17": "Cisco",     "00:03:6B": "Cisco",     "00:04:DD": "Cisco",
    "00:05:DC": "Cisco",     "00:06:28": "Cisco",     "00:07:0D": "Cisco",
    "00:0A:8A": "Cisco",     "00:0B:45": "Cisco",     "00:0C:85": "Cisco",
    "00:0D:28": "Cisco",     "00:0E:38": "Cisco",     "00:0F:23": "Cisco",
    "00:10:0B": "Cisco",     "00:11:BB": "Cisco",     "00:12:DA": "Cisco",
    # VMware
    "00:0C:29": "VMware",    "00:50:56": "VMware",    "00:05:69": "VMware",
    # Reolink
    "EC:71:DB": "Reolink",   "A8:D4:E9": "Reolink",
    # Axis (cameras)
    "00:40:8C": "Axis",      "AC:CC:8E": "Axis",
    # Synology NAS
    "00:11:32": "Synology",
    # Xiaomi
    "28:6C:07": "Xiaomi",    "50:8F:4C": "Xiaomi",    "64:09:80": "Xiaomi",
    "74:23:44": "Xiaomi",    "8C:BE:BE": "Xiaomi",    "F8:A2:D6": "Xiaomi",
}

# ══════════════════════════════════════════════════════════════════════════════
# Device model fingerprinting by open ports + vendor
# ══════════════════════════════════════════════════════════════════════════════
def fingerprint_device(ip: str, vendor: str, open_ports: list) -> dict:
    """Return guessed model/role based on vendor + port profile."""
    ports = set(open_ports)
    model = ""
    device_type = ""

    if vendor == "MikroTik":
        device_type = "router"
        if 8291 in ports:  model = "MikroTik RouterOS (Winbox)"
        elif 80 in ports:  model = "MikroTik RouterOS"
        else:              model = "MikroTik RouterOS"
    elif vendor == "Ubiquiti":
        if 22 in ports and 443 in ports: model = "Ubiquiti UniFi AP"
        elif 8080 in ports:              model = "Ubiquiti UniFi Controller"
        else:                            model = "Ubiquiti Device"
        device_type = "ap"
    elif vendor == "Hikvision":
        model = "Hikvision IP Camera"
        device_type = "camera"
        if 554 in ports: model = "Hikvision NVR/Camera (RTSP)"
    elif vendor == "Dahua":
        model = "Dahua IP Camera"
        device_type = "camera"
        if 37777 in ports: model = "Dahua NVR/Camera"
    elif vendor == "ASUS":
        if 80 in ports or 443 in ports: model = "ASUS Router/AP"
        else:                           model = "ASUS Device"
        device_type = "ap"
    elif vendor == "Apple":
        model = "Apple Device"
        device_type = "mobile"
        if 5000 in ports: model = "Apple TV / HomePod"
        elif 62078 in ports: model = "Apple iPhone/iPad"
        elif 548 in ports: model = "Apple Mac (AFP)"
    elif vendor == "VMware":
        model = "VMware Virtual Machine"
        device_type = "server"
    elif vendor == "Synology":
        model = "Synology NAS"
        device_type = "server"
    elif vendor == "TP-Link":
        if 80 in ports: model = "TP-Link Router/AP"
        device_type = "router"
    elif vendor == "Cisco":
        if 22 in ports: model = "Cisco Switch/Router"
        else:           model = "Cisco Device"
        device_type = "router"
    elif vendor == "Reolink":
        model = "Reolink IP Camera"
        device_type = "camera"
    elif vendor == "Axis":
        model = "Axis IP Camera"
        device_type = "camera"

    # Port-based fallback if vendor unknown
    if not model:
        if 554 in ports and (80 in ports or 8080 in ports):
            model = "IP Camera (RTSP)"; device_type = "camera"
        elif 8291 in ports:
            model = "MikroTik RouterOS"; device_type = "router"
        elif 8080 in ports and 554 in ports:
            model = "NVR / Camera System"; device_type = "camera"
        elif 22 in ports and 80 in ports and 443 in ports:
            model = "Network Device"; device_type = "router"
        elif 445 in ports or 139 in ports:
            model = "Windows / Samba Host"; device_type = "client"
        elif 548 in ports:
            model = "macOS / AFP Server"; device_type = "client"

    return {"model": model, "suggested_type": device_type}

# ══════════════════════════════════════════════════════════════════════════════
# MAC & ARP helpers
# ══════════════════════════════════════════════════════════════════════════════
def get_mac_from_arp(ip: str) -> str:
    """Read MAC from /proc/net/arp (Linux) or arp -n output."""
    # Linux: /proc/net/arp
    try:
        with open("/proc/net/arp") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip:
                    mac = parts[3]
                    if mac != "00:00:00:00:00:00":
                        return mac.upper()
    except Exception:
        pass
    # Fallback: arp -n
    try:
        out = subprocess.check_output(["arp", "-n", ip], stderr=subprocess.DEVNULL,
                                      timeout=3, text=True)
        m = re.search(r"([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}", out)
        if m:
            return m.group(0).upper().replace("-", ":")
    except Exception:
        pass
    return ""

def oui_lookup(mac: str) -> str:
    """Return vendor name for MAC address using built-in OUI table."""
    if not mac: return ""
    oui = mac[:8].upper()
    return OUI_DB.get(oui, "")

# ══════════════════════════════════════════════════════════════════════════════
# Async fast port scanner
# ══════════════════════════════════════════════════════════════════════════════
PROBE_PORTS = [22, 23, 80, 443, 554, 8080, 8291, 37777, 8443, 5000, 445, 139, 548, 62078, 8888, 161]

async def async_tcp_check(ip: str, port: int, timeout: float = 0.6) -> bool:
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=timeout)
        w.close()
        try: await w.wait_closed()
        except: pass
        return True
    except: return False

async def async_ping(ip: str, timeout: float = 1.0):
    """ICMP ping via subprocess, returns (alive, latency_ms)."""
    try:
        t = time.time()
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", "1", ip,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 1.5)
        ms = round((time.time() - t) * 1000, 1)
        if proc.returncode == 0:
            # Try to extract actual RTT from ping output
            m = re.search(r"time[=<]([\d.]+)\s*ms", stdout.decode(errors="ignore"))
            if m: ms = float(m.group(1))
            return True, ms
        return False, None
    except: return False, None

async def async_scan_host(ip: str) -> dict:
    """Full async scan: ping + port scan + MAC + vendor + fingerprint."""
    alive, latency = await async_ping(ip)
    result = {"ip": ip, "alive": alive, "latency": latency,
              "mac": "", "vendor": "", "model": "", "open_ports": [], "suggested_type": ""}
    if not alive:
        return result

    # Parallel port probes
    tasks = [async_tcp_check(ip, p) for p in PROBE_PORTS]
    port_results = await asyncio.gather(*tasks)
    open_ports = [PROBE_PORTS[i] for i, ok in enumerate(port_results) if ok]
    result["open_ports"] = open_ports

    # MAC + vendor (must happen after ping so ARP is populated)
    mac = get_mac_from_arp(ip)
    result["mac"] = mac
    vendor = oui_lookup(mac)
    result["vendor"] = vendor

    # Fingerprint
    fp = fingerprint_device(ip, vendor, open_ports)
    result["model"] = fp["model"]
    result["suggested_type"] = fp["suggested_type"]
    return result

def run_async_scan(ips: list, on_result=None, max_concurrent: int = 80) -> list:
    """Run async scan in a new event loop (thread-safe)."""
    async def _run():
        sem = asyncio.Semaphore(max_concurrent)
        results = []
        async def bounded(ip):
            async with sem:
                r = await async_scan_host(ip)
                if on_result: on_result(r)
                results.append(r)
        await asyncio.gather(*[bounded(ip) for ip in ips])
        return results
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()

# ══════════════════════════════════════════════════════════════════════════════
# Legacy sync ping (fallback for monitor quick-ping)
# ══════════════════════════════════════════════════════════════════════════════
def ping_sync(ip: str):
    p = "-n" if platform.system().lower() == "windows" else "-c"
    w = "-w" if platform.system().lower() == "windows" else "-W"
    try:
        t = time.time()
        r = subprocess.run(["ping", p, "1", w, "1", ip],
                           capture_output=True, text=True, timeout=3)
        ms = round((time.time() - t) * 1000, 1)
        if r.returncode == 0:
            m = re.search(r"time[=<]([\d.]+)\s*ms", r.stdout)
            if m: ms = float(m.group(1))
            return True, ms
        return False, None
    except: return False, None

# ══════════════════════════════════════════════════════════════════════════════
# Defaults
# ══════════════════════════════════════════════════════════════════════════════
DEFAULT_DEVICES = [
    {"id": 1,  "ip": "192.168.88.1",   "name": "Main Router",       "location": "Серверная",     "type": "router"},
    {"id": 2,  "ip": "192.168.88.114", "name": "MikroTik #2",       "location": "Офис 1",        "type": "router"},
    {"id": 3,  "ip": "192.168.88.116", "name": "MikroTik #3",       "location": "Офис 2",        "type": "router"},
    {"id": 4,  "ip": "192.168.88.146", "name": "MikroTik #4",       "location": "Склад",         "type": "router"},
    {"id": 5,  "ip": "192.168.88.151", "name": "MikroTik #5",       "location": "Улица",         "type": "router"},
    {"id": 6,  "ip": "192.168.88.24",  "name": "ASUS AP #1",        "location": "Зал А",         "type": "ap"},
    {"id": 7,  "ip": "192.168.88.25",  "name": "ASUS AP #2",        "location": "Зал Б",         "type": "ap"},
    {"id": 8,  "ip": "192.168.88.26",  "name": "ASUS AP #3",        "location": "Коридор",       "type": "ap"},
    {"id": 9,  "ip": "192.168.88.200", "name": "ASUS AP #4",        "location": "Переговорная",  "type": "ap"},
    {"id": 10, "ip": "192.168.88.202", "name": "ASUS AP #5",        "location": "Склад",         "type": "ap"},
    {"id": 11, "ip": "192.168.88.203", "name": "ASUS AP #6",        "location": "Входная зона",  "type": "ap"},
    {"id": 12, "ip": "192.168.88.248", "name": "ASUS AP #7",        "location": "Улица",         "type": "ap"},
    {"id": 13, "ip": "192.168.88.22",  "name": "IP Камера #1",      "location": "Вход",          "type": "camera"},
    {"id": 14, "ip": "192.168.88.23",  "name": "IP Камера #2",      "location": "Парковка",      "type": "camera"},
    {"id": 15, "ip": "192.168.88.45",  "name": "IP Камера #3",      "location": "Склад",         "type": "camera"},
    {"id": 16, "ip": "192.168.88.152", "name": "IP Камера #4",      "location": "Серверная",     "type": "camera"},
    {"id": 17, "ip": "192.168.88.17",  "name": "Apple iPhone",      "location": "Мобильный",     "type": "mobile"},
    {"id": 18, "ip": "192.168.83.1",   "name": "MikroTik Gateway",  "location": "Филиал 1",      "type": "router"},
    {"id": 19, "ip": "192.168.83.134", "name": "MikroTik VPN",      "location": "Филиал 1",      "type": "router"},
    {"id": 20, "ip": "192.168.83.165", "name": "ASUS Network Dev",  "location": "Филиал 1",      "type": "ap"},
    {"id": 21, "ip": "192.168.83.151", "name": "Mac Computer",      "location": "Офис Филиал 1", "type": "client"},
    {"id": 22, "ip": "192.168.21.3",   "name": "VMware Server #1",  "location": "ЦОД",           "type": "server"},
    {"id": 23, "ip": "192.168.21.4",   "name": "VMware Server #2",  "location": "ЦОД",           "type": "server"},
    {"id": 24, "ip": "192.168.21.10",  "name": "IP Камера ЦОД",     "location": "ЦОД",           "type": "camera"},
]

DEFAULT_SUBNETS = [
    {"prefix": "192.168.88", "label": "192.168.88.0/24", "scan": True},
    {"prefix": "192.168.83", "label": "192.168.83.0/24", "scan": True},
    {"prefix": "192.168.21", "label": "192.168.21.0/24", "scan": True},
]

# ══════════════════════════════════════════════════════════════════════════════
# Persistence
# ══════════════════════════════════════════════════════════════════════════════
def load_devices():
    if os.path.exists(DEVICES_FILE):
        with open(DEVICES_FILE) as f: return json.load(f)
    save_devices(DEFAULT_DEVICES); return DEFAULT_DEVICES

def save_devices(d):
    with open(DEVICES_FILE, "w") as f: json.dump(d, f, ensure_ascii=False, indent=2)

def load_subnets():
    if os.path.exists(SUBNETS_FILE):
        with open(SUBNETS_FILE) as f: return json.load(f)
    save_subnets(DEFAULT_SUBNETS); return DEFAULT_SUBNETS

def save_subnets(s):
    with open(SUBNETS_FILE, "w") as f: json.dump(s, f, ensure_ascii=False, indent=2)

def ip_to_prefix(ip):
    parts = ip.strip().split(".")
    return ".".join(parts[:3]) if len(parts) == 4 else None

def ensure_subnet_exists(ip):
    prefix = ip_to_prefix(ip)
    if not prefix: return
    subnets = load_subnets()
    if not any(s["prefix"] == prefix for s in subnets):
        subnets.append({"prefix": prefix, "label": f"{prefix}.0/24", "scan": True})
        save_subnets(subnets)

# ══════════════════════════════════════════════════════════════════════════════
# Reboot engine — multi-vendor HTTP/API reboot
# ══════════════════════════════════════════════════════════════════════════════
import urllib.request, urllib.parse, base64, ssl, hashlib, struct

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

def _http(url, method="GET", data=None, headers=None, login="", password="",
          timeout=8) -> tuple:
    """HTTP/HTTPS request with optional basic auth. Returns (status_code, body)."""
    req = urllib.request.Request(url, method=method)
    if login:
        creds = base64.b64encode(f"{login}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")
    if headers:
        for k, v in headers.items(): req.add_header(k, v)
    if data:
        req.data = data.encode() if isinstance(data, str) else data
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as r:
            return r.status, r.read().decode(errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="ignore")
    except Exception as ex:
        return 0, str(ex)


def _reboot_mikrotik(ip, login, password) -> dict:
    """MikroTik RouterOS reboot — REST API → Binary API → SSH (paramiko)."""

    # 1. REST API (RouterOS 7.x)
    for scheme in ("http", "https"):
        url = f"{scheme}://{ip}/rest/system/reboot"
        st, _ = _http(url, method="POST", data="{}", login=login, password=password)
        if st in (200, 201, 204):
            return {"ok": True, "method": f"MikroTik REST ({scheme})", "detail": "Команда отправлена"}

    # 2. Binary API port 8728 (RouterOS 6.x)
    try:
        if _mikrotik_api_reboot(ip, login, password):
            return {"ok": True, "method": "MikroTik API (8728)", "detail": "Команда отправлена"}
    except Exception:
        pass

    # 3. SSH via paramiko
    return _reboot_via_ssh(ip, login, password, command="/system reboot")

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
        st, body = _http(url, login=login, password=password)
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


def _reboot_via_ssh(ip, login, password, command="/system reboot") -> dict:
    """SSH reboot using paramiko — pure Python, no sshpass needed.
    Install: pip install paramiko
    """
    try:
        import paramiko
    except ImportError:
        return {"ok": False, "method": "SSH",
                "detail": "Установите paramiko: pip install paramiko"}

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(ip, port=22, username=login, password=password,
                       timeout=10, allow_agent=False, look_for_keys=False)

        # Try exec_command first — cleaner, works on most RouterOS versions
        stdin, stdout, stderr = client.exec_command(command, timeout=8)
        stdin.close()

        # Give RouterOS time to process and initiate reboot
        time.sleep(2)

        out = stdout.read(512).decode(errors="ignore")
        err = stderr.read(512).decode(errors="ignore")
        exit_code = stdout.channel.recv_exit_status()

        client.close()

        # RouterOS returns exit 0 on success; connection may drop mid-read
        if exit_code in (0, -1):
            return {"ok": True, "method": "SSH (paramiko / exec)",
                    "detail": f'Команда "{command}" принята — устройство перезагружается'}

        # If exec_command gave non-zero, fall back to interactive shell
        raise Exception(f"exec exit={exit_code} err={err.strip()}")

    except Exception as exec_err:
        # Fallback: invoke_shell (some RouterOS versions need interactive mode)
        try:
            client2 = paramiko.SSHClient()
            client2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client2.connect(ip, port=22, username=login, password=password,
                            timeout=10, allow_agent=False, look_for_keys=False)

            shell = client2.invoke_shell(width=200, height=50)
            time.sleep(1.0)                        # wait for RouterOS prompt
            shell.recv(4096)                       # drain welcome banner

            shell.send(command + "\n")
            time.sleep(2.5)                        # wait for RouterOS to process

            # Drain any confirmation prompt and reply y
            if shell.recv_ready():
                resp = shell.recv(1024).decode(errors="ignore")
                if "y/n" in resp.lower() or "confirm" in resp.lower():
                    shell.send("y\n")
                    time.sleep(1.5)

            client2.close()
            return {"ok": True, "method": "SSH (paramiko / shell)",
                    "detail": f'Команда "{command}" отправлена — устройство перезагружается'}

        except paramiko.AuthenticationException:
            return {"ok": False, "method": "SSH (paramiko)",
                    "detail": "Ошибка аутентификации — проверьте логин и пароль"}
        except Exception as shell_err:
            msg = str(shell_err).lower()
            if "reset" in msg or "eof" in msg or "closed" in msg or "broken" in msg:
                # Connection dropped = device is rebooting = success
                return {"ok": True, "method": "SSH (paramiko / shell)",
                        "detail": "Соединение закрыто устройством — устройство перезагружается"}
            return {"ok": False, "method": "SSH (paramiko)",
                    "detail": f"Ошибка: {shell_err}"}
    finally:
        try: client.close()
        except: pass
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

    if not login: login = "admin"
    if not password:
        return {"ok": False, "method": "—",
                "detail": "Пароль не задан. Добавьте учётные данные в настройках устройства."}

    # Vendor-specific (MikroTik already tries REST → API → SSH internally)
    for key, func in VENDOR_REBOOT.items():
        if key in vendor:
            return func(ip, login, password)

    # Unknown vendor: generic HTTP then SSH
    result = _reboot_generic_http(ip, login, password)
    if result["ok"]: return result
    return _reboot_via_ssh(ip, login, password)


# ══════════════════════════════════════════════════════════════════════════════
# Monitor state — status + latency + mac + vendor + model cache
# ══════════════════════════════════════════════════════════════════════════════
status_cache  = {}   # ip → bool
latency_cache = {}   # ip → float ms
mac_cache     = {}   # ip → "AA:BB:CC:DD:EE:FF"
vendor_cache  = {}   # ip → "MikroTik"
model_cache   = {}   # ip → "MikroTik RouterOS"
ports_cache   = {}   # ip → [22, 80, ...]
last_scan_time = 0
auto_ping_running = False

def _do_monitor_scan(deep=False):
    """Scan all known devices. deep=True → also probe ports for fingerprinting."""
    global last_scan_time
    devices = load_devices()
    ips = [d["ip"] for d in devices]
    if not ips: return

    if deep:
        results = run_async_scan(ips, max_concurrent=60)
        for r in results:
            ip = r["ip"]
            status_cache[ip]  = r["alive"]
            latency_cache[ip] = r["latency"]
            if r["mac"]:   mac_cache[ip]    = r["mac"]
            if r["vendor"]: vendor_cache[ip] = r["vendor"]
            if r["model"]:  model_cache[ip]  = r["model"]
            if r["open_ports"]: ports_cache[ip] = r["open_ports"]
    else:
        # Quick ping only (auto every 60s)
        async def quick():
            sem = asyncio.Semaphore(50)
            async def p(ip):
                async with sem:
                    alive, ms = await async_ping(ip)
                    status_cache[ip]  = alive
                    latency_cache[ip] = ms
            await asyncio.gather(*[p(ip) for ip in ips])
        loop = asyncio.new_event_loop()
        try: loop.run_until_complete(quick())
        finally: loop.close()

    last_scan_time = time.time()

def background_auto_ping():
    """Runs forever — quick ping every 60 seconds."""
    global auto_ping_running
    auto_ping_running = True
    while True:
        time.sleep(60)
        try: _do_monitor_scan(deep=False)
        except Exception as e: print(f"[auto-ping] error: {e}")

def deep_scan():
    """Full scan (ping + ports + MAC + vendor + model) — triggered manually."""
    threading.Thread(target=_do_monitor_scan, args=(True,), daemon=True).start()

def quick_scan():
    """Quick ping-only scan — also triggered manually."""
    threading.Thread(target=_do_monitor_scan, args=(False,), daemon=True).start()

# ══════════════════════════════════════════════════════════════════════════════
# Discovery states
# ══════════════════════════════════════════════════════════════════════════════
disc = {"running": False, "progress": 0, "total": 0, "done": 0,
        "results": {}, "started_at": None, "finished_at": None, "subnets": []}

def run_discovery(subnets):
    disc.update({"running": True, "progress": 0, "results": {},
                 "started_at": time.time(), "finished_at": None, "subnets": subnets, "done": 0})
    ips = [f"{s}.{i}" for s in subnets for i in range(1, 255)]
    disc["total"] = len(ips)
    lock = threading.Lock()
    def on_result(r):
        with lock:
            disc["results"][r["ip"]] = r["alive"]
            disc["done"] += 1
            disc["progress"] = int(disc["done"] / disc["total"] * 100)
    run_async_scan(ips, on_result=on_result, max_concurrent=80)
    disc["running"] = False; disc["finished_at"] = time.time()

sn_scan = {"running": False, "progress": 0, "total": 256, "done": 0,
           "results": {}, "started_at": None, "finished_at": None}

def run_subnet_scan():
    sn_scan.update({"running": True, "progress": 0, "results": {},
                    "started_at": time.time(), "finished_at": None, "done": 0, "total": 256})
    ips = [f"192.168.{x}.1" for x in range(256)]
    lock = threading.Lock()
    def on_result(r):
        x = int(r["ip"].split(".")[2])
        with lock:
            sn_scan["results"][x] = r["alive"]
            sn_scan["done"] += 1
            sn_scan["progress"] = int(sn_scan["done"] / 256 * 100)
    run_async_scan(ips, on_result=on_result, max_concurrent=64)
    sn_scan["running"] = False; sn_scan["finished_at"] = time.time()

# ══════════════════════════════════════════════════════════════════════════════
# Routes
# ══════════════════════════════════════════════════════════════════════════════
@app.route("/")
def index(): return render_template_string(HTML)

@app.route("/api/devices")
def get_devices():
    devices = load_devices()
    out = []
    for d in devices:
        ip = d["ip"]
        row = dict(d)
        row["online"]  = status_cache.get(ip, None)
        row["latency"] = latency_cache.get(ip, None)
        row["mac"]     = mac_cache.get(ip, d.get("mac", ""))
        row["vendor"]  = vendor_cache.get(ip, d.get("vendor", ""))
        row["model"]   = model_cache.get(ip, d.get("model", ""))
        row["ports"]   = ports_cache.get(ip, [])
        row["has_creds"] = bool(d.get("cred_login") and d.get("cred_password"))
        # Never expose password in API response
        row.pop("cred_password", None)
        out.append(row)
    return jsonify({"devices": out, "last_scan": last_scan_time})

@app.route("/api/scan", methods=["POST"])
def trigger_scan():
    """Quick ping scan."""
    quick_scan()
    return jsonify({"status": "scanning"})

@app.route("/api/deep_scan", methods=["POST"])
def trigger_deep_scan():
    """Full scan: ping + ports + vendor + model."""
    deep_scan()
    return jsonify({"status": "deep_scanning"})

@app.route("/api/ping/<ip>")
def ping_single(ip):
    """Single device quick ping."""
    alive, ms = ping_sync(ip)
    status_cache[ip]  = alive
    latency_cache[ip] = ms
    return jsonify({"ip": ip, "alive": alive, "latency": ms})

@app.route("/api/reboot/<int:did>", methods=["POST"])
def reboot_device_route(did):
    """Reboot a device using its saved credentials."""
    devices = load_devices()
    device = next((d for d in devices if d["id"] == did), None)
    if not device:
        return jsonify({"ok": False, "detail": "Устройство не найдено"}), 404
    result = reboot_device(device)
    return jsonify(result)

@app.route("/api/devices", methods=["POST"])
def add_device():
    devices = load_devices(); data = request.json
    new_id = max((d["id"] for d in devices), default=0) + 1
    device = {"id": new_id, "ip": data["ip"], "name": data["name"],
              "location": data.get("location", ""), "type": data.get("type", "client"),
              "mac": data.get("mac", ""), "vendor": data.get("vendor", ""),
              "model": data.get("model", ""),
              "cred_login": data.get("cred_login", ""),
              "cred_password": data.get("cred_password", "")}
    devices.append(device); save_devices(devices)
    ensure_subnet_exists(data["ip"])
    return jsonify(device)

@app.route("/api/devices/<int:did>", methods=["PUT"])
def update_device(did):
    devices = load_devices()
    for d in devices:
        if d["id"] == did:
            d.update(request.json); d["id"] = did
            save_devices(devices); ensure_subnet_exists(d["ip"]); return jsonify(d)
    return jsonify({"error": "not found"}), 404

@app.route("/api/devices/<int:did>", methods=["DELETE"])
def delete_device(did):
    save_devices([d for d in load_devices() if d["id"] != did])
    return jsonify({"status": "deleted"})

@app.route("/api/subnets")
def get_subnets():
    subnets = load_subnets(); devices = load_devices()
    for s in subnets:
        s["device_count"] = sum(1 for d in devices if ip_to_prefix(d["ip"]) == s["prefix"])
    return jsonify(subnets)

@app.route("/api/subnets", methods=["POST"])
def add_subnet():
    data = request.json; raw = data.get("prefix", "").strip()
    if "/" in raw: raw = ".".join(raw.split("/")[0].split(".")[:3])
    prefix = raw
    if not prefix or len(prefix.split(".")) != 3:
        return jsonify({"error": "invalid prefix"}), 400
    subnets = load_subnets()
    if any(s["prefix"] == prefix for s in subnets):
        return jsonify({"error": "already exists"}), 409
    entry = {"prefix": prefix, "label": f"{prefix}.0/24", "scan": data.get("scan", True)}
    subnets.append(entry); save_subnets(subnets); return jsonify(entry)

@app.route("/api/subnets/<path:prefix>", methods=["PUT"])
def update_subnet(prefix):
    subnets = load_subnets()
    for s in subnets:
        if s["prefix"] == prefix:
            s.update(request.json); s["prefix"] = prefix
            save_subnets(subnets); return jsonify(s)
    return jsonify({"error": "not found"}), 404

@app.route("/api/subnets/<path:prefix>", methods=["DELETE"])
def delete_subnet(prefix):
    save_subnets([s for s in load_subnets() if s["prefix"] != prefix])
    return jsonify({"status": "deleted"})

@app.route("/api/discovery/start", methods=["POST"])
def start_discovery():
    if disc["running"]: return jsonify({"error": "already running"}), 400
    data = request.json or {}
    subnets = data.get("subnets") or [s["prefix"] for s in load_subnets() if s.get("scan")]
    threading.Thread(target=run_discovery, args=(subnets,), daemon=True).start()
    return jsonify({"status": "started"})

@app.route("/api/discovery/status")
def discovery_status():
    reg = {d["ip"] for d in load_devices()}
    alive = [ip for ip, up in disc["results"].items() if up]
    srt = lambda lst: sorted(lst, key=lambda x: list(map(int, x.split("."))))
    new_dev = srt([ip for ip in alive if ip not in reg])
    known_dev = srt([ip for ip in alive if ip in reg])
    return jsonify({"running": disc["running"], "progress": disc["progress"],
                    "total": disc["total"], "done": disc["done"],
                    "alive_count": len(alive), "new_count": len(new_dev),
                    "known_count": len(known_dev), "new_devices": new_dev,
                    "known_devices": known_dev, "started_at": disc["started_at"],
                    "finished_at": disc["finished_at"], "subnets": disc["subnets"]})

@app.route("/api/subnet_scan/start", methods=["POST"])
def start_subnet_scan():
    if sn_scan["running"]: return jsonify({"error": "already running"}), 400
    threading.Thread(target=run_subnet_scan, daemon=True).start()
    return jsonify({"status": "started"})

@app.route("/api/subnet_scan/status")
def subnet_scan_status():
    reg_prefixes = {s["prefix"] for s in load_subnets()}
    alive_xs = sorted([x for x, up in sn_scan["results"].items() if up])
    new_subs = [x for x in alive_xs if f"192.168.{x}" not in reg_prefixes]
    known_subs = [x for x in alive_xs if f"192.168.{x}" in reg_prefixes]
    return jsonify({"running": sn_scan["running"], "progress": sn_scan["progress"],
                    "total": sn_scan["total"], "done": sn_scan["done"],
                    "alive_count": len(alive_xs), "new_subnets": new_subs,
                    "known_subnets": known_subs, "started_at": sn_scan["started_at"],
                    "finished_at": sn_scan["finished_at"]})

# ══════════════════════════════════════════════════════════════════════════════
# HTML
# ══════════════════════════════════════════════════════════════════════════════
HTML = r"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>NetWatch</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0c10;--sf:#111318;--sf2:#161a22;--bd:#1e2430;
  --green:#00e676;--gd:#00e67618;--gd2:#00e67630;
  --red:#ff3d57;--rd:#ff3d5718;
  --yel:#ffb300;--yd:#ffb30018;--yd2:#ffb30030;
  --text:#e0e6f0;--muted:#4a5568;
  --acc:#3d7fff;--ad:#3d7fff18;--ad2:#3d7fff30;
  --pur:#a855f7;--pd:#a855f718;
  --cyan:#00d4ff;--cyd:#00d4ff18;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;min-height:100vh;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);
  background-size:40px 40px;opacity:.27;}
.wrap{position:relative;z-index:1;max-width:1320px;margin:0 auto;padding:20px 16px;}

header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;}
.logo{display:flex;align-items:center;gap:12px;}
.logo-icon{width:40px;height:40px;background:var(--acc);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px;}
.logo h1{font-family:'Syne',sans-serif;font-size:23px;font-weight:800;letter-spacing:-.5px;}
.logo span{color:var(--acc);}
.hdr-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.last-scan{font-size:11px;color:var(--muted);}
.auto-badge{font-size:10px;background:var(--gd);color:var(--green);border:1px solid #00e67630;padding:2px 8px;border-radius:4px;}

.tabs{display:flex;border-bottom:1px solid var(--bd);margin-bottom:20px;overflow-x:auto;}
.tab{padding:9px 20px;cursor:pointer;font-size:13px;font-weight:600;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .2s;white-space:nowrap;}
.tab:hover{color:var(--text);}
.tab.active{color:var(--acc);border-bottom-color:var(--acc);}
.tp{display:none;}.tp.active{display:block;}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:20px;}
.sc{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:13px 15px;}
.sc-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
.sc-val{font-size:24px;font-weight:700;font-family:'Syne',sans-serif;}
.g{color:var(--green);}.r{color:var(--red);}.t{color:var(--text);}.y{color:var(--yel);}.p{color:var(--pur);}.c{color:var(--cyan);}

.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:8px;border:none;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;transition:all .18s;}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;box-shadow:none!important;}
.btn-acc{background:var(--acc);color:#fff;}.btn-acc:hover{background:#5590ff;transform:translateY(-1px);box-shadow:0 4px 16px #3d7fff40;}
.btn-g{background:var(--green);color:#000;}.btn-g:hover{background:#33ef88;transform:translateY(-1px);}
.btn-g.spin,.btn-pur.spin,.btn-cyan.spin{animation:pulse 1s infinite;}
.btn-pur{background:var(--pur);color:#fff;}.btn-pur:hover{background:#c084fc;transform:translateY(-1px);}
.btn-cyan{background:var(--cyan);color:#000;}.btn-cyan:hover{background:#33dfff;transform:translateY(-1px);}
.btn-del{background:transparent;border:1px solid var(--red);color:var(--red);padding:4px 8px;font-size:11px;}.btn-del:hover{background:var(--rd);}
.btn-ghost{background:transparent;border:1px solid var(--bd);color:var(--muted);padding:4px 8px;font-size:11px;}.btn-ghost:hover{border-color:var(--acc);color:var(--acc);}
.btn-yel{background:var(--yd);border:1px solid #ffb30050;color:var(--yel);padding:4px 10px;font-size:11px;font-weight:700;}.btn-yel:hover{background:var(--yd2);}
.btn-gd{background:var(--gd);border:1px solid #00e67650;color:var(--green);padding:4px 10px;font-size:11px;font-weight:700;}
.btn-ping{background:var(--cyd);border:1px solid #00d4ff40;color:var(--cyan);padding:3px 9px;font-size:10px;font-weight:700;border-radius:5px;cursor:pointer;transition:all .15s;font-family:inherit;}
.btn-ping:hover{background:#00d4ff20;}
.btn-ping.pinging{animation:pulse .6s infinite;}
.btn-reboot{background:var(--rd);border:1px solid #ff3d5760;color:var(--red);padding:3px 9px;font-size:10px;font-weight:700;border-radius:5px;cursor:pointer;transition:all .15s;font-family:inherit;}
.btn-reboot:hover{background:#ff3d5730;}
.btn-reboot.rebooting{animation:pulse .5s infinite;}
.btn-reboot:disabled{opacity:.35;cursor:not-allowed;}
.cred-badge{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700;margin-left:3px;}
.cred-ok{background:var(--gd);color:var(--green);border:1px solid #00e67630;}
.cred-no{background:var(--rd);color:var(--red);border:1px solid #ff3d5730;}
.reboot-result{font-size:10px;padding:2px 7px;border-radius:4px;margin-top:2px;}
.reboot-ok{color:var(--green);}.reboot-fail{color:var(--red);}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;}
.filters{display:flex;gap:5px;flex-wrap:wrap;}
.fbtn{background:var(--sf);border:1px solid var(--bd);color:var(--muted);padding:5px 11px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;transition:all .18s;}
.fbtn:hover,.fbtn.active{border-color:var(--acc);color:var(--acc);background:var(--ad);}

/* ── Device table ── */
.sn-sec{margin-bottom:22px;}
.sn-hdr{display:flex;align-items:center;gap:9px;padding:7px 13px;background:var(--sf);border:1px solid var(--bd);border-radius:8px;margin-bottom:7px;}
.sn-badge{font-size:11px;color:var(--acc);background:var(--ad);padding:2px 9px;border-radius:4px;font-weight:600;letter-spacing:.5px;}
/* Columns: status | IP | name | location | vendor/model | type | ping | actions */
.th{display:grid;grid-template-columns:10px 130px 1fr 1fr 155px 85px 75px 180px;gap:9px;padding:4px 13px;margin-bottom:3px;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;align-items:center;}
.dr{display:grid;grid-template-columns:10px 130px 1fr 1fr 155px 85px 75px 180px;align-items:center;gap:9px;background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:9px 13px;transition:all .18s;}
.dr:hover{border-color:#252d3d;background:var(--sf2);}
.dr.on{border-left:3px solid var(--green);}.dr.off{border-left:3px solid var(--red);opacity:.68;}.dr.unk{border-left:3px solid var(--muted);}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.dot.on{background:var(--green);box-shadow:0 0 7px var(--green);animation:blink 2s infinite;}
.dot.off{background:var(--red);}.dot.unk{background:var(--muted);}
.dot.alive{background:var(--green);box-shadow:0 0 6px var(--green);}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
.dev-ip{font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;}
.dev-name{font-size:12px;}
.dev-loc{font-size:11px;color:var(--muted);}
.vendor-cell{display:flex;flex-direction:column;gap:2px;}
.vendor-name{font-size:11px;color:var(--cyan);font-weight:600;}
.model-name{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mac-text{font-size:9px;color:#3a4557;font-family:'JetBrains Mono',monospace;}
.type-badge{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;}
.tr2{background:#ff9a0018;color:#ff9a00;border:1px solid #ff9a0040;}
.ta{background:#00c9ff18;color:#00c9ff;border:1px solid #00c9ff40;}
.tc{background:#bf00ff18;color:#bf00ff;border:1px solid #bf00ff40;}
.tk{background:#fff1;color:#aaa;border:1px solid #fff2;}
.tm{background:#00e67618;color:#00e676;border:1px solid #00e67640;}
.ts{background:#ffb30018;color:#ffb300;border:1px solid #ffb30040;}

/* Ping cell */
.ping-cell{display:flex;flex-direction:column;align-items:flex-start;gap:3px;}
.latency-bar-wrap{width:100%;height:4px;background:var(--bd);border-radius:2px;overflow:hidden;}
.latency-bar{height:100%;border-radius:2px;transition:width .4s;}
.latency-val{font-size:10px;font-weight:700;}
.lat-good{color:var(--green);}.lat-ok{color:var(--yel);}.lat-bad{color:var(--red);}
.latency-bar.lat-good-b{background:var(--green);}
.latency-bar.lat-ok-b{background:var(--yel);}
.latency-bar.lat-bad-b{background:var(--red);}

.dev-act{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap;}
.dg{display:flex;flex-direction:column;gap:4px;}

/* Panels */
.panel{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:18px;margin-bottom:18px;}
.panel-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;}
.panel-hdr h3{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;}
.panel-sub{font-size:11px;color:var(--muted);}
.sn-list{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;}
.sn-row{display:flex;align-items:center;gap:9px;background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:9px 13px;transition:border-color .15s;}
.sn-lbl{font-size:13px;font-weight:600;flex:1;}
.sn-cnt{font-size:11px;color:var(--muted);}
.toggle-wrap{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);cursor:pointer;user-select:none;}
.toggle-wrap input{accent-color:var(--acc);width:13px;height:13px;cursor:pointer;}
.add-row{display:flex;gap:7px;flex-wrap:wrap;}
.sn-inp{flex:1;min-width:150px;background:var(--bg);border:1px solid var(--bd);color:var(--text);padding:8px 11px;border-radius:8px;font-family:inherit;font-size:12px;outline:none;transition:border-color .18s;}
.sn-inp:focus{border-color:var(--acc);}
.sn-inp::placeholder{color:var(--muted);}
.hint{font-size:11px;color:var(--muted);line-height:1.6;}
.divider{border:none;border-top:1px solid var(--bd);margin:18px 0;}

/* Range scanner */
.range-scanner{background:var(--sf);border:1px solid var(--bd);border-radius:12px;overflow:hidden;margin-bottom:18px;}
.range-hdr{padding:14px 18px;background:linear-gradient(135deg,#1a1040,#0e1a30);border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;}
.range-hdr h3{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;}
.range-badge{font-size:11px;background:var(--pd);color:var(--pur);border:1px solid #a855f740;padding:2px 9px;border-radius:4px;font-weight:600;}
.range-body{padding:16px 18px;}
.range-desc{font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.7;}
.range-visual{background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--muted);}

/* Progress */
.prog{margin-top:13px;display:none;}.prog.show{display:block;}
.prog-top{display:flex;justify-content:space-between;margin-bottom:4px;}
.prog-lbl{font-size:11px;color:var(--muted);}
.prog-pct{font-size:11px;font-weight:700;}
.prog-pct.acc{color:var(--acc);}.prog-pct.pur{color:var(--pur);}
.prog-bg{background:var(--sf2);border-radius:5px;height:7px;overflow:hidden;margin-bottom:4px;}
.prog-fill{height:100%;border-radius:5px;transition:width .4s;}
.prog-fill.acc{background:linear-gradient(90deg,var(--acc),var(--green));}
.prog-fill.pur{background:linear-gradient(90deg,var(--pur),var(--acc));}
.prog-detail{font-size:10px;color:var(--muted);}

/* Two-col result panels */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:680px){.two-col{grid-template-columns:1fr;}}
.rpanel{background:var(--sf);border:1px solid var(--bd);border-radius:12px;overflow:hidden;}
.rphdr{padding:11px 15px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--bd);}
.rphdr.new{background:var(--yd);border-bottom-color:#ffb30028;}
.rphdr.known{background:var(--gd);border-bottom-color:#00e67628;}
.rphdr.pur{background:var(--pd);border-bottom-color:#a855f728;}
.rp-title{font-family:'Syne',sans-serif;font-size:13px;font-weight:700;}
.rp-cnt{margin-left:auto;font-size:11px;padding:1px 8px;border-radius:20px;font-weight:700;}
.cnt-new{background:var(--yd);color:var(--yel);}
.cnt-known{background:var(--gd);color:var(--green);}
.ip-list{padding:7px;display:flex;flex-direction:column;gap:3px;max-height:360px;overflow-y:auto;}
.ip-list::-webkit-scrollbar{width:3px;}
.ip-list::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px;}
.ip-row{display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:7px;transition:background .12s;}
.ip-row:hover{background:var(--sf2);}
.ip-a{font-size:12px;font-weight:600;flex:1;}
.ip-meta{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;}
.badge{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700;flex-shrink:0;}
.b-new{background:var(--yd);color:var(--yel);border:1px solid #ffb30040;}
.b-known{background:var(--gd);color:var(--green);border:1px solid #00e67640;}
.empty{text-align:center;padding:26px 10px;color:var(--muted);font-size:11px;line-height:1.8;}

/* Discovery controls */
.disc-ctrl{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:18px;margin-bottom:18px;}
.disc-ctrl h3{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:5px;}
.disc-hint{font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.6;}
.chk-list{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px;}
.chk-wrap{display:flex;align-items:center;gap:6px;background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:7px 12px;cursor:pointer;transition:border-color .18s;user-select:none;}
.chk-wrap:hover{border-color:var(--acc);}
.chk-wrap input{accent-color:var(--acc);width:12px;height:12px;cursor:pointer;}
.chk-wrap label{font-size:12px;cursor:pointer;}

/* Modal */
.modal-ov{display:none;position:fixed;inset:0;background:#00000095;z-index:300;align-items:center;justify-content:center;backdrop-filter:blur(4px);}
.modal-ov.open{display:flex;}
.modal{background:var(--sf);border:1px solid var(--bd);border-radius:14px;padding:22px;width:420px;max-width:95vw;}
.modal h2{font-family:'Syne',sans-serif;font-size:16px;font-weight:800;margin-bottom:14px;}
.fg{margin-bottom:12px;}
.fg label{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
.fg input,.fg select{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--text);padding:8px 12px;border-radius:8px;font-family:inherit;font-size:12px;outline:none;transition:border-color .18s;}
.fg input:focus,.fg select:focus{border-color:var(--acc);}
.modal-act{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}
.btn-cancel{background:transparent;border:1px solid var(--bd);color:var(--muted);}.btn-cancel:hover{border-color:var(--text);color:var(--text);}
.fg-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}

@media(max-width:900px){
  .th,.dr{grid-template-columns:10px 120px 1fr 80px 70px 100px;}
  .th>*:nth-child(4),.dr>*:nth-child(4),
  .th>*:nth-child(5),.dr>*:nth-child(5){display:none;}
}
@media(max-width:600px){
  .th,.dr{grid-template-columns:10px 110px 1fr 70px 90px;}
  .th>*:nth-child(6),.dr>*:nth-child(6),.th>*:nth-child(7),.dr>*:nth-child(7){display:none;}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="logo">
    <div class="logo-icon">⬡</div>
    <div>
      <h1>Net<span>Watch</span></h1>
      <div style="font-size:10px;color:var(--muted)">Мониторинг сетевой инфраструктуры</div>
    </div>
  </div>
  <div class="hdr-r">
    <span class="last-scan" id="lastScan">Ожидание...</span>
    <span class="auto-badge" id="autoBadge">⏱ авто-пинг 60с</span>
    <button class="btn btn-g" id="scanBtn" onclick="triggerScan()">▶ Пинг</button>
    <button class="btn btn-cyan" id="deepBtn" onclick="triggerDeepScan()">🔬 Глубокий скан</button>
    <button class="btn btn-acc" onclick="openAddModal()">+ Устройство</button>
  </div>
</header>

<div class="tabs">
  <div class="tab active" onclick="switchTab('monitor',this)">📡 Мониторинг</div>
  <div class="tab" onclick="switchTab('discovery',this)">🔍 Сканер хостов</div>
  <div class="tab" onclick="switchTab('subnets',this)">🗂 Подсети</div>
</div>

<!-- ════ TAB: MONITOR ════ -->
<div class="tp active" id="tab-monitor">
  <div class="stats">
    <div class="sc"><div class="sc-label">Всего</div><div class="sc-val t" id="sTotal">—</div></div>
    <div class="sc"><div class="sc-label">Онлайн</div><div class="sc-val g" id="sOnline">—</div></div>
    <div class="sc"><div class="sc-label">Оффлайн</div><div class="sc-val r" id="sOffline">—</div></div>
    <div class="sc"><div class="sc-label">Средний пинг</div><div class="sc-val c" id="sAvgPing">—</div></div>
    <div class="sc"><div class="sc-label">Неизвестно</div><div class="sc-val t" id="sUnknown">—</div></div>
  </div>
  <div class="toolbar">
    <div class="filters">
      <button class="fbtn active" onclick="setFilter('all',this)">Все</button>
      <button class="fbtn" onclick="setFilter('online',this)">Онлайн</button>
      <button class="fbtn" onclick="setFilter('offline',this)">Оффлайн</button>
      <button class="fbtn" onclick="setFilter('router',this)">Роутеры</button>
      <button class="fbtn" onclick="setFilter('camera',this)">Камеры</button>
      <button class="fbtn" onclick="setFilter('ap',this)">WiFi AP</button>
    </div>
  </div>
  <div id="devList"></div>
</div>

<!-- ════ TAB: DISCOVERY ════ -->
<div class="tp" id="tab-discovery">
  <div class="disc-ctrl">
    <h3>🔍 Сканер хостов</h3>
    <p class="disc-hint">Async-сканер пингует все адреса (.1–.254) выбранных подсетей параллельно.</p>
    <div class="chk-list" id="discChecks"></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-g" id="discBtn" onclick="startDiscovery()">🔍 Запустить</button>
      <button class="btn btn-ghost" style="font-size:11px" onclick="switchTab('subnets',document.querySelectorAll('.tab')[2])">⚙ Подсети</button>
    </div>
    <div class="prog" id="discProg">
      <div class="prog-top"><span class="prog-lbl" id="dProgLbl">...</span><span class="prog-pct acc" id="dProgPct">0%</span></div>
      <div class="prog-bg"><div class="prog-fill acc" id="dProgFill" style="width:0%"></div></div>
      <div class="prog-detail" id="dProgDetail"></div>
    </div>
  </div>
  <div class="stats" id="discStats" style="display:none">
    <div class="sc"><div class="sc-label">Адресов</div><div class="sc-val t" id="dTotal">—</div></div>
    <div class="sc"><div class="sc-label">Активных</div><div class="sc-val g" id="dAlive">—</div></div>
    <div class="sc"><div class="sc-label">Незарег.</div><div class="sc-val y" id="dNew">—</div></div>
    <div class="sc"><div class="sc-label">В базе</div><div class="sc-val g" id="dKnown">—</div></div>
  </div>
  <div class="two-col" id="discPanels" style="display:none">
    <div class="rpanel">
      <div class="rphdr new"><span style="font-size:16px">⚠️</span>
        <span class="rp-title" style="color:var(--yel)">Незарегистрированные</span>
        <span class="rp-cnt cnt-new" id="dNewCnt">0</span></div>
      <div class="ip-list" id="dNewList"><div class="empty">Запустите сканирование</div></div>
    </div>
    <div class="rpanel">
      <div class="rphdr known"><span style="font-size:16px">✅</span>
        <span class="rp-title" style="color:var(--green)">Зарегистрированные</span>
        <span class="rp-cnt cnt-known" id="dKnownCnt">0</span></div>
      <div class="ip-list" id="dKnownList"><div class="empty">Запустите сканирование</div></div>
    </div>
  </div>
</div>

<!-- ════ TAB: SUBNETS ════ -->
<div class="tp" id="tab-subnets">
  <div class="panel">
    <div class="panel-hdr">
      <div><h3>🗂 Реестр подсетей</h3><div class="panel-sub">Общий источник для мониторинга и сканера</div></div>
    </div>
    <div class="sn-list" id="snList"></div>
    <div class="hint" style="margin-bottom:8px">Добавить вручную (префикс или CIDR):</div>
    <div class="add-row">
      <input class="sn-inp" id="snInput" placeholder="192.168.99  или  192.168.99.0/24" onkeydown="if(event.key==='Enter')addSubnet()">
      <button class="btn btn-acc" onclick="addSubnet()">+ Добавить</button>
    </div>
    <div class="hint" style="margin-top:10px">💡 При добавлении устройства с новым IP подсеть создаётся автоматически.</div>
  </div>

  <hr class="divider">

  <div class="range-scanner">
    <div class="range-hdr">
      <h3>🛰 Сканер диапазона <span class="range-badge">192.168.0–255.0/24</span></h3>
      <button class="btn btn-pur" id="snScanBtn" onclick="startSnScan()">🛰 Сканировать</button>
    </div>
    <div class="range-body">
      <div class="range-desc">Пингует шлюз <strong>.1</strong> всех 256 подсетей диапазона <strong style="color:var(--pur)">192.168.x.0/24</strong>.<br>Показывает какие уже в реестре, а какие обнаружены впервые.</div>
      <div class="range-visual" style="font-size:11px">
        <strong>Проверяется:</strong> 192.168.<strong style="color:var(--pur)">0</strong>.1 ···
        192.168.<strong style="color:var(--pur)">255</strong>.1
        → итого <strong style="color:var(--pur)">256 адресов</strong>
      </div>
      <div class="prog" id="snProg">
        <div class="prog-top"><span class="prog-lbl" id="snProgLbl">...</span><span class="prog-pct pur" id="snProgPct">0%</span></div>
        <div class="prog-bg"><div class="prog-fill pur" id="snProgFill" style="width:0%"></div></div>
        <div class="prog-detail" id="snProgDetail"></div>
      </div>
    </div>
  </div>

  <div class="stats" id="snScanStats" style="display:none">
    <div class="sc"><div class="sc-label">Проверено</div><div class="sc-val t" id="snStTotal">256</div></div>
    <div class="sc"><div class="sc-label">Живых</div><div class="sc-val p" id="snStAlive">—</div></div>
    <div class="sc"><div class="sc-label">Новых</div><div class="sc-val y" id="snStNew">—</div></div>
    <div class="sc"><div class="sc-label">В реестре</div><div class="sc-val g" id="snStKnown">—</div></div>
  </div>
  <div class="two-col" id="snScanPanels" style="display:none">
    <div class="rpanel">
      <div class="rphdr new"><span style="font-size:16px">⚠️</span>
        <span class="rp-title" style="color:var(--yel)">Не в реестре</span>
        <span class="rp-cnt cnt-new" id="snNewCnt">0</span></div>
      <div class="ip-list" id="snNewList"><div class="empty">Результаты появятся здесь</div></div>
    </div>
    <div class="rpanel">
      <div class="rphdr known"><span style="font-size:16px">✅</span>
        <span class="rp-title" style="color:var(--green)">Уже в реестре</span>
        <span class="rp-cnt cnt-known" id="snKnownCnt">0</span></div>
      <div class="ip-list" id="snKnownList"><div class="empty">Результаты появятся здесь</div></div>
    </div>
  </div>
</div>

</div><!-- /wrap -->

<!-- Device modal -->
<div class="modal-ov" id="devModal">
  <div class="modal">
    <h2 id="mTitle">Добавить устройство</h2>
    <input type="hidden" id="mId">
    <div class="fg-row">
      <div class="fg"><label>IP Адрес</label><input id="mIp" placeholder="192.168.88.X"></div>
      <div class="fg"><label>Тип</label>
        <select id="mType">
          <option value="router">Роутер</option><option value="ap">WiFi AP</option>
          <option value="camera">IP Камера</option><option value="client">Клиент</option>
          <option value="mobile">Мобильный</option><option value="server">Сервер</option>
        </select>
      </div>
    </div>
    <div class="fg"><label>Название</label><input id="mName" placeholder="MikroTik #1"></div>
    <div class="fg"><label>Местоположение</label><input id="mLoc" placeholder="Серверная..."></div>
    <div class="fg-row">
      <div class="fg"><label>MAC адрес</label><input id="mMac" placeholder="AA:BB:CC:DD:EE:FF"></div>
      <div class="fg"><label>Производитель</label><input id="mVendor" placeholder="MikroTik"></div>
    </div>
    <div class="fg"><label>Модель</label><input id="mModel" placeholder="MikroTik RouterOS"></div>
    <div style="margin:14px 0 10px;padding-top:12px;border-top:1px solid var(--bd);display:flex;align-items:center;gap:8px;">
      <span style="font-size:11px;font-weight:700;color:var(--muted)">🔑 Учётные данные для перезагрузки</span>
    </div>
    <div class="fg-row">
      <div class="fg"><label>Логин</label><input id="mLogin" placeholder="admin" autocomplete="off"></div>
      <div class="fg"><label>Пароль</label>
        <div style="position:relative">
          <input id="mPassword" type="password" placeholder="••••••••" autocomplete="new-password" style="padding-right:36px">
          <button type="button" onclick="togglePwd()" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;" id="eyeBtn">👁</button>
        </div>
      </div>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:-6px;margin-bottom:10px;">
      Сохраняется локально в devices.json. Используется для перезагрузки через HTTP API / SSH.
    </div>
    <div class="modal-act">
      <button class="btn btn-cancel" onclick="closeModal()">Отмена</button>
      <button class="btn btn-acc" onclick="saveDevice()">Сохранить</button>
    </div>
  </div>
</div>

<script>
const TL={router:'Роутер',ap:'WiFi AP',camera:'Камера',client:'Клиент',mobile:'Мобильный',server:'Сервер'};
const TC={router:'tr2',ap:'ta',camera:'tc',client:'tk',mobile:'tm',server:'ts'};

let allDevices=[], allSubnets=[], currentFilter='all', scanning=false, deepScanning=false;
let discPoll=null, snScanPoll=null;
let autoCountdown=60, autoTimer=null;

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tp').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  if(name==='subnets'||name==='discovery') renderSubnetUI();
}

// ── Auto-ping countdown ───────────────────────────────────────────────────────
function startAutoCountdown(){
  autoCountdown=60;
  if(autoTimer) clearInterval(autoTimer);
  autoTimer=setInterval(()=>{
    autoCountdown--;
    document.getElementById('autoBadge').textContent=`⏱ авто-пинг ${autoCountdown}с`;
    if(autoCountdown<=0){
      autoCountdown=60;
      fetchDevices(); // refresh after server auto-ping fires
    }
  },1000);
}

// ── Latency helpers ───────────────────────────────────────────────────────────
function latClass(ms){
  if(ms===null||ms===undefined) return '';
  if(ms<50) return 'lat-good';
  if(ms<150) return 'lat-ok';
  return 'lat-bad';
}
function latBarClass(ms){
  if(ms===null||ms===undefined) return '';
  if(ms<50) return 'lat-good-b';
  if(ms<150) return 'lat-ok-b';
  return 'lat-bad-b';
}
function latBarWidth(ms){
  if(ms===null||ms===undefined) return 0;
  // 0ms=0% 300ms=100%
  return Math.min(100, Math.round(ms/3));
}

// ── Monitor render ────────────────────────────────────────────────────────────
function pfx(ip){return ip.split('.').slice(0,3).join('.');}
function sc(d){return d.online===true?'on':d.online===false?'off':'unk';}

function pingCell(d){
  const ms=d.latency;
  if(d.online===false) return `<div class="ping-cell"><span style="font-size:10px;color:var(--red)">недост.</span></div>`;
  if(ms===null||ms===undefined) return `<div class="ping-cell"><span style="font-size:10px;color:var(--muted)">—</span></div>`;
  const lc=latClass(ms); const lb=latBarClass(ms); const bw=latBarWidth(ms);
  return `<div class="ping-cell">
    <span class="latency-val ${lc}">${ms} мс</span>
    <div class="latency-bar-wrap"><div class="latency-bar ${lb}" style="width:${bw}%"></div></div>
  </div>`;
}

function vendorCell(d){
  const v=d.vendor||''; const m=d.model||''; const mac=d.mac||'';
  if(!v&&!m&&!mac) return `<div class="vendor-cell"><span style="font-size:10px;color:var(--muted)">—</span></div>`;
  const credBadge=d.has_creds
    ?`<span class="cred-badge cred-ok" title="Учётные данные сохранены">🔑</span>`
    :`<span class="cred-badge cred-no" title="Нет учётных данных">🔒</span>`;
  return `<div class="vendor-cell">
    <div style="display:flex;align-items:center;gap:4px">${v?`<span class="vendor-name">${v}</span>`:''}${credBadge}</div>
    ${m?`<span class="model-name" title="${m}">${m}</span>`:''}
    ${mac?`<span class="mac-text">${mac}</span>`:''}
  </div>`;
}

function render(){
  const el=document.getElementById('devList');
  let filtered=allDevices;
  if(currentFilter==='online') filtered=allDevices.filter(d=>d.online===true);
  else if(currentFilter==='offline') filtered=allDevices.filter(d=>d.online===false);
  else if(['router','ap','camera','client','mobile','server'].includes(currentFilter))
    filtered=allDevices.filter(d=>d.type===currentFilter);

  const groups={};
  filtered.forEach(d=>{const p=pfx(d.ip);if(!groups[p])groups[p]=[];groups[p].push(d);});
  const knownPfx=allSubnets.map(s=>s.prefix);
  const keys=[...knownPfx.filter(p=>groups[p]),...Object.keys(groups).filter(p=>!knownPfx.includes(p))];

  let html='';
  keys.forEach(p=>{
    const devs=groups[p];
    const sn=allSubnets.find(s=>s.prefix===p);
    const label=sn?sn.label:p+'.0/24';
    const onCnt=devs.filter(d=>d.online===true).length;
    html+=`<div class="sn-sec">
      <div class="sn-hdr">
        <span class="sn-badge">${label}</span>
        <span style="font-size:11px;color:var(--muted)">${devs.length} уст.</span>
        <span style="font-size:10px;color:var(--green);margin-left:auto">${onCnt} онлайн</span>
      </div>
      <div class="th"><span></span><span>IP</span><span>Название</span><span>Расположение</span><span>Вендор / Модель</span><span>Тип</span><span>Пинг</span><span>Действия</span></div>
      <div class="dg">`;
    devs.forEach(d=>{
      const s=sc(d);
      html+=`<div class="dr ${s}">
        <div class="dot ${s}"></div>
        <div class="dev-ip">${d.ip}</div>
        <div class="dev-name">${d.name}</div>
        <div class="dev-loc">${d.location||'—'}</div>
        ${vendorCell(d)}
        <div><span class="type-badge ${TC[d.type]||'tk'}">${TL[d.type]||d.type}</span></div>
        ${pingCell(d)}
        <div class="dev-act">
          <button class="btn-ping" id="ping_${d.id}" onclick="singlePing(${d.id},'${d.ip}')">⚡</button>
          <button class="btn-reboot" id="reboot_${d.id}" onclick="rebootDevice(${d.id})" ${d.has_creds?'':' title="Нет учётных данных" style="opacity:.4"'}>⟳ Reboot</button>
          <button class="btn btn-ghost" onclick="openEditModal(${d.id})">✏</button>
          <button class="btn btn-del" onclick="delDevice(${d.id})">✕</button>
        </div>
      </div>`;
    });
    html+=`</div></div>`;
  });
  if(!html) html=`<div style="text-align:center;padding:50px;color:var(--muted)">Устройства не найдены</div>`;
  el.innerHTML=html;

  const lats=allDevices.filter(d=>d.latency!=null&&d.online===true).map(d=>d.latency);
  const avgPing=lats.length?Math.round(lats.reduce((a,b)=>a+b,0)/lats.length):null;
  document.getElementById('sTotal').textContent=allDevices.length;
  document.getElementById('sOnline').textContent=allDevices.filter(d=>d.online===true).length;
  document.getElementById('sOffline').textContent=allDevices.filter(d=>d.online===false).length;
  document.getElementById('sUnknown').textContent=allDevices.filter(d=>d.online==null).length;
  document.getElementById('sAvgPing').textContent=avgPing?avgPing+' мс':'—';
}

async function fetchDevices(){
  const r=await fetch('/api/devices'); const data=await r.json();
  allDevices=data.devices;
  if(data.last_scan){
    const d=new Date(data.last_scan*1000);
    document.getElementById('lastScan').textContent='Скан: '+d.toLocaleTimeString('ru-RU');
  }
  render();
}

async function triggerScan(){
  if(scanning)return; scanning=true;
  const btn=document.getElementById('scanBtn');
  btn.textContent='⟳ Пинг...'; btn.classList.add('spin');
  await fetch('/api/scan',{method:'POST'});
  let tries=0;
  const p=setInterval(async()=>{
    await fetchDevices(); tries++;
    if(tries>15){clearInterval(p);scanning=false;btn.textContent='▶ Пинг';btn.classList.remove('spin');}
  },2000);
  startAutoCountdown();
}

async function triggerDeepScan(){
  if(deepScanning)return; deepScanning=true;
  const btn=document.getElementById('deepBtn');
  btn.textContent='🔬 Сканирование...'; btn.classList.add('spin');
  await fetch('/api/deep_scan',{method:'POST'});
  // Deep scan takes time — poll until last_scan updates
  let prev=0; let tries=0;
  const p=setInterval(async()=>{
    const r=await fetch('/api/devices'); const data=await r.json();
    tries++;
    if(data.last_scan!==prev||tries>60){
      allDevices=data.devices; render(); prev=data.last_scan;
    }
    if(tries>60){clearInterval(p);deepScanning=false;btn.textContent='🔬 Глубокий скан';btn.classList.remove('spin');}
  },3000);
}

async function singlePing(id,ip){
  const btn=document.getElementById('ping_'+id);
  if(btn){btn.textContent='...';btn.classList.add('pinging');}
  const r=await fetch('/api/ping/'+ip);
  const data=await r.json();
  // Update local cache
  const dev=allDevices.find(d=>d.id===id);
  if(dev){dev.online=data.alive;dev.latency=data.latency;}
  if(btn){btn.textContent='⚡ Пинг';btn.classList.remove('pinging');}
  render();
}

function setFilter(f,el){
  currentFilter=f;
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active'); render();
}

// ── Subnets ───────────────────────────────────────────────────────────────────
async function fetchSubnets(){const r=await fetch('/api/subnets');allSubnets=await r.json();}

function renderSubnetUI(){
  const list=document.getElementById('snList');
  list.innerHTML=allSubnets.length===0
    ?'<div style="color:var(--muted);font-size:12px;padding:6px 0">Подсетей пока нет</div>'
    :allSubnets.map(s=>`
      <div class="sn-row">
        <div class="dot alive"></div>
        <div class="sn-lbl">${s.label}</div>
        <span class="sn-cnt">${s.device_count||0} уст.</span>
        <label class="toggle-wrap">
          <input type="checkbox" ${s.scan?'checked':''} onchange="toggleSnScan('${s.prefix}',this.checked)">
          <span>Сканировать</span>
        </label>
        <button class="btn btn-del" onclick="deleteSubnet('${s.prefix}')">✕</button>
      </div>`).join('');

  const checks=document.getElementById('discChecks');
  checks.innerHTML=allSubnets.length===0
    ?'<span style="font-size:11px;color:var(--muted)">Нет подсетей</span>'
    :allSubnets.map(s=>{
      const id='dchk_'+s.prefix.replace(/\./g,'_');
      return `<div class="chk-wrap">
        <input type="checkbox" id="${id}" value="${s.prefix}" ${s.scan?'checked':''}>
        <label for="${id}">${s.label}</label>
      </div>`;
    }).join('');
}

async function addSubnet(){
  const val=document.getElementById('snInput').value.trim();
  if(!val)return;
  const r=await fetch('/api/subnets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix:val,scan:true})});
  if(r.status===409){alert('Уже есть');return;}
  if(!r.ok){alert('Неверный формат. Например: 192.168.99 или 192.168.99.0/24');return;}
  document.getElementById('snInput').value='';
  await fetchSubnets(); renderSubnetUI(); render();
}

async function deleteSubnet(prefix){
  if(!confirm(`Удалить ${prefix}.0/24?\nУстройства останутся в базе.`))return;
  await fetch('/api/subnets/'+prefix,{method:'DELETE'});
  await fetchSubnets(); renderSubnetUI(); render();
}

async function toggleSnScan(prefix,val){
  await fetch('/api/subnets/'+prefix,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scan:val})});
  await fetchSubnets(); renderSubnetUI();
}

// ── Host discovery ────────────────────────────────────────────────────────────
async function startDiscovery(){
  const subnets=[]; document.querySelectorAll('#discChecks input:checked').forEach(c=>subnets.push(c.value));
  if(!subnets.length){alert('Выберите подсеть');return;}
  document.getElementById('discPanels').style.display='none';
  document.getElementById('discStats').style.display='none';
  document.getElementById('discProg').classList.add('show');
  document.getElementById('dProgFill').style.width='0%';
  document.getElementById('dProgPct').textContent='0%';
  document.getElementById('dProgLbl').textContent='Запуск...';
  const btn=document.getElementById('discBtn'); btn.textContent='⟳ Сканирование...'; btn.disabled=true;
  await fetch('/api/discovery/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subnets})});
  if(discPoll)clearInterval(discPoll);
  discPoll=setInterval(pollDisc,1500);
}

async function pollDisc(){
  const r=await fetch('/api/discovery/status'); const d=await r.json();
  document.getElementById('dProgFill').style.width=d.progress+'%';
  document.getElementById('dProgPct').textContent=d.progress+'%';
  if(d.running){
    document.getElementById('dProgLbl').textContent=`${d.done}/${d.total} адресов · ${d.alive_count} живых`;
  } else {
    document.getElementById('dProgLbl').textContent=`✅ ${d.alive_count} активных хостов`;
  }
  if(d.alive_count>0||!d.running){
    document.getElementById('discStats').style.display='grid';
    document.getElementById('discPanels').style.display='grid';
    document.getElementById('dTotal').textContent=d.total||'—';
    document.getElementById('dAlive').textContent=d.alive_count;
    document.getElementById('dNew').textContent=d.new_count;
    document.getElementById('dKnown').textContent=d.known_count;
    renderDiscLists(d);
  }
  if(!d.running){
    clearInterval(discPoll);
    const btn=document.getElementById('discBtn'); btn.textContent='🔍 Запустить'; btn.disabled=false;
  }
}

function renderDiscLists(d){
  const devMap={}; allDevices.forEach(dev=>{devMap[dev.ip]=dev;});
  document.getElementById('dNewCnt').textContent=d.new_count;
  document.getElementById('dNewList').innerHTML=d.new_devices.length===0
    ?`<div class="empty">${d.running?'Ищем...<br>':''}Всё зарегистрировано 🎉</div>`
    :d.new_devices.map(ip=>`
      <div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">${ip}</div>
        <span class="badge b-new">Новый</span>
        <button class="btn btn-yel" onclick="openAddModal('${ip}')">+ В базу</button>
      </div>`).join('');
  document.getElementById('dKnownCnt').textContent=d.known_count;
  document.getElementById('dKnownList').innerHTML=d.known_devices.length===0
    ?`<div class="empty">${d.running?'Ищем...<br>':''}Ничего не найдено</div>`
    :d.known_devices.map(ip=>{
      const dev=devMap[ip]||{}; const meta=[dev.name,dev.vendor||dev.location].filter(Boolean).join(' · ');
      return `<div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">${ip}</div>
        <div class="ip-meta" title="${meta}">${meta||'—'}</div>
        <span class="badge b-known">В базе</span>
      </div>`;
    }).join('');
}

// ── Subnet range scanner ──────────────────────────────────────────────────────
async function startSnScan(){
  document.getElementById('snScanPanels').style.display='none';
  document.getElementById('snScanStats').style.display='none';
  document.getElementById('snProg').classList.add('show');
  document.getElementById('snProgFill').style.width='0%';
  document.getElementById('snProgPct').textContent='0%';
  document.getElementById('snProgLbl').textContent='Запуск...';
  const btn=document.getElementById('snScanBtn'); btn.textContent='⟳ Сканирование...'; btn.classList.add('spin'); btn.disabled=true;
  await fetch('/api/subnet_scan/start',{method:'POST'});
  if(snScanPoll)clearInterval(snScanPoll);
  snScanPoll=setInterval(pollSnScan,1500);
}

async function pollSnScan(){
  const r=await fetch('/api/subnet_scan/status'); const d=await r.json();
  document.getElementById('snProgFill').style.width=d.progress+'%';
  document.getElementById('snProgPct').textContent=d.progress+'%';
  document.getElementById('snProgLbl').textContent=d.running
    ?`${d.done}/256 подсетей · живых: ${d.alive_count}`
    :`✅ Завершено — ${d.alive_count} активных подсетей`;
  if(d.alive_count>0||!d.running){
    document.getElementById('snScanStats').style.display='grid';
    document.getElementById('snScanPanels').style.display='grid';
    document.getElementById('snStTotal').textContent=256;
    document.getElementById('snStAlive').textContent=d.alive_count;
    document.getElementById('snStNew').textContent=d.new_subnets.length;
    document.getElementById('snStKnown').textContent=d.known_subnets.length;
    renderSnLists(d);
  }
  if(!d.running){
    clearInterval(snScanPoll);
    const btn=document.getElementById('snScanBtn'); btn.textContent='🛰 Сканировать'; btn.classList.remove('spin'); btn.disabled=false;
  }
}

function renderSnLists(d){
  const snMap={}; allSubnets.forEach(s=>{snMap[s.prefix]=s;});
  document.getElementById('snNewCnt').textContent=d.new_subnets.length;
  document.getElementById('snNewList').innerHTML=d.new_subnets.length===0
    ?`<div class="empty">${d.running?'Поиск...<br>':''}Все живые подсети в реестре 🎉</div>`
    :d.new_subnets.map(x=>`
      <div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">192.168.${x}.0/24</div>
        <div class="ip-meta">192.168.${x}.1 ↓</div>
        <span class="badge b-new">Новая</span>
        <button class="btn btn-yel" onclick="addSnFromScan('192.168.${x}')">+ Реестр</button>
      </div>`).join('');
  document.getElementById('snKnownCnt').textContent=d.known_subnets.length;
  document.getElementById('snKnownList').innerHTML=d.known_subnets.length===0
    ?`<div class="empty">${d.running?'Поиск...<br>':''}Не найдено</div>`
    :d.known_subnets.map(x=>{
      const sn=snMap[`192.168.${x}`]||{};
      return `<div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">192.168.${x}.0/24</div>
        <div class="ip-meta">${sn.device_count||0} уст.</div>
        <span class="badge b-known">В реестре</span>
      </div>`;
    }).join('');
}

async function addSnFromScan(prefix){
  await fetch('/api/subnets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix,scan:true})});
  await fetchSubnets(); renderSubnetUI();
  const res=await fetch('/api/subnet_scan/status'); renderSnLists(await res.json());
}

// ── Device modal ──────────────────────────────────────────────────────────────
function openAddModal(ip=''){
  document.getElementById('mTitle').textContent='Добавить устройство';
  document.getElementById('mId').value='';
  document.getElementById('mIp').value=ip;
  document.getElementById('mName').value='';
  document.getElementById('mLoc').value='';
  document.getElementById('mType').value='client';
  document.getElementById('mMac').value='';
  document.getElementById('mVendor').value='';
  document.getElementById('mModel').value='';
  document.getElementById('mLogin').value='';
  document.getElementById('mPassword').value='';
  document.getElementById('devModal').classList.add('open');
}
function openEditModal(id){
  const d=allDevices.find(x=>x.id===id); if(!d)return;
  document.getElementById('mTitle').textContent='Изменить устройство';
  document.getElementById('mId').value=id;
  document.getElementById('mIp').value=d.ip;
  document.getElementById('mName').value=d.name;
  document.getElementById('mLoc').value=d.location||'';
  document.getElementById('mType').value=d.type||'client';
  document.getElementById('mMac').value=d.mac||'';
  document.getElementById('mVendor').value=d.vendor||'';
  document.getElementById('mModel').value=d.model||'';
  document.getElementById('mLogin').value=d.cred_login||'';
  document.getElementById('mPassword').value='';  // never pre-fill password
  document.getElementById('devModal').classList.add('open');
}
function closeModal(){document.getElementById('devModal').classList.remove('open');}
async function saveDevice(){
  const id=document.getElementById('mId').value;
  const pwd=document.getElementById('mPassword').value;
  const payload={ip:document.getElementById('mIp').value,name:document.getElementById('mName').value,
    location:document.getElementById('mLoc').value,type:document.getElementById('mType').value,
    mac:document.getElementById('mMac').value,vendor:document.getElementById('mVendor').value,
    model:document.getElementById('mModel').value,
    cred_login:document.getElementById('mLogin').value};
  if(pwd) payload.cred_password=pwd;  // only send if changed
  await fetch(id?'/api/devices/'+id:'/api/devices',{
    method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  closeModal();
  await Promise.all([fetchDevices(),fetchSubnets()]);
  renderSubnetUI();
}
async function rebootDevice(id){
  const dev=allDevices.find(d=>d.id===id);
  if(!dev) return;
  if(!dev.has_creds){
    alert(`Устройство "${dev.name}" не имеет сохранённых учётных данных.\nОткройте редактирование (✏) и добавьте логин и пароль.`);
    return;
  }
  if(!confirm(`Перезагрузить "${dev.name}" (${dev.ip})?\n\nУстройство будет недоступно ~30-120 секунд.`)) return;
  const btn=document.getElementById('reboot_'+id);
  if(btn){btn.textContent='⟳...';btn.classList.add('rebooting');btn.disabled=true;}
  try{
    const r=await fetch('/api/reboot/'+id,{method:'POST'});
    const d=await r.json();
    if(btn){btn.textContent='⟳ Reboot';btn.classList.remove('rebooting');btn.disabled=false;}
    if(d.ok){
      alert(`✅ ${dev.name}\n\nМетод: ${d.method}\n${d.detail}\n\nУстройство перезагружается...`);
      // Mark as offline temporarily
      const dv=allDevices.find(x=>x.id===id);
      if(dv) dv.online=false;
      render();
    } else {
      alert(`❌ Ошибка перезагрузки\n\nМетод: ${d.method}\n${d.detail}`);
    }
  } catch(e){
    if(btn){btn.textContent='⟳ Reboot';btn.classList.remove('rebooting');btn.disabled=false;}
    alert('Ошибка сети: '+e);
  }
}

function togglePwd(){
  const inp=document.getElementById('mPassword');
  const btn=document.getElementById('eyeBtn');
  if(inp.type==='password'){inp.type='text';btn.textContent='🙈';}
  else{inp.type='password';btn.textContent='👁';}
}

async function delDevice(id){
  if(!confirm('Удалить устройство?'))return;
  await fetch('/api/devices/'+id,{method:'DELETE'}); fetchDevices();
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async()=>{
  await Promise.all([fetchDevices(),fetchSubnets()]);
  renderSubnetUI();
  startAutoCountdown();
  // Refresh devices every 15s (to pick up auto-ping results from server)
  setInterval(fetchDevices,15000);
})();
</script>
</body>
</html>"""

if __name__ == "__main__":
    print("🌐 NetWatch → http://0.0.0.0:8000")
    # Initial scan on startup
    threading.Thread(target=lambda: _do_monitor_scan(deep=False), daemon=True).start()
    # Auto-ping background loop every 60s
    threading.Thread(target=background_auto_ping, daemon=True).start()
    app.run(host="0.0.0.0", port=8000, debug=False, threaded=True)
