"""OUI vendor database + device fingerprinting."""
import re, subprocess

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