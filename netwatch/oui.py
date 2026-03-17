"""OUI vendor database + device fingerprinting + HTTP banner + SNMP."""
import re, subprocess, socket

OUI_DB = {
    # ── MikroTik ──────────────────────────────────────────────────────────────
    "4C:5E:0C": "MikroTik", "B8:69:F4": "MikroTik", "6C:3B:6B": "MikroTik",
    "DC:2C:6E": "MikroTik", "E4:8D:8C": "MikroTik", "CC:2D:E0": "MikroTik",
    "18:FD:74": "MikroTik", "48:8F:5A": "MikroTik", "08:55:31": "MikroTik",
    "D4:CA:6D": "MikroTik", "2C:C8:1B": "MikroTik", "74:4D:28": "MikroTik",
    "B4:CE:F6": "MikroTik", "64:D1:54": "MikroTik", "00:0C:42": "MikroTik",
    "D4:01:C3": "MikroTik",
    # ── Ubiquiti ──────────────────────────────────────────────────────────────
    "24:A4:3C": "Ubiquiti", "78:8A:20": "Ubiquiti", "FC:EC:DA": "Ubiquiti",
    "80:2A:A8": "Ubiquiti", "00:27:22": "Ubiquiti", "04:18:D6": "Ubiquiti",
    "44:D9:E7": "Ubiquiti", "68:72:51": "Ubiquiti", "E0:63:DA": "Ubiquiti",
    "F0:9F:C2": "Ubiquiti", "B4:FB:E4": "Ubiquiti", "18:E8:29": "Ubiquiti",
    "DC:9F:DB": "Ubiquiti", "74:83:C2": "Ubiquiti", "F4:E2:C6": "Ubiquiti",
    # ── Hikvision ─────────────────────────────────────────────────────────────
    "C8:02:8F": "Hikvision", "BC:AD:28": "Hikvision", "44:19:B6": "Hikvision",
    "54:C4:15": "Hikvision", "A0:AC:22": "Hikvision", "E4:24:6C": "Hikvision",
    "D0:C0:BF": "Hikvision", "28:57:BE": "Hikvision", "70:83:F1": "Hikvision",
    "18:68:CB": "Hikvision", "2C:05:47": "Hikvision", "AC:1D:DF": "Hikvision",
    # ── Dahua ─────────────────────────────────────────────────────────────────
    "90:02:A9": "Dahua", "40:6B:AE": "Dahua", "3C:EF:8C": "Dahua",
    "C4:2F:90": "Dahua", "E0:50:8B": "Dahua", "BC:32:B2": "Dahua",
    "70:85:C4": "Dahua", "48:EA:63": "Dahua",
    # ── ASUS ──────────────────────────────────────────────────────────────────
    "00:11:2F": "ASUS", "04:92:26": "ASUS", "08:60:6E": "ASUS",
    "10:BF:48": "ASUS", "14:DA:E9": "ASUS", "1C:87:2C": "ASUS",
    "2C:4D:54": "ASUS", "2C:56:DC": "ASUS", "30:85:A9": "ASUS",
    "38:D5:47": "ASUS", "40:16:7E": "ASUS", "50:46:5D": "ASUS",
    "60:45:CB": "ASUS", "70:4D:7B": "ASUS", "74:D0:2B": "ASUS",
    "78:24:AF": "ASUS", "A8:5E:45": "ASUS", "AC:22:0B": "ASUS",
    "B0:6E:BF": "ASUS", "F8:32:E4": "ASUS",
    # ── Apple ─────────────────────────────────────────────────────────────────
    "00:17:F2": "Apple", "00:1B:63": "Apple", "00:1E:C2": "Apple",
    "00:1F:F3": "Apple", "00:21:E9": "Apple", "00:22:41": "Apple",
    "00:23:12": "Apple", "00:23:32": "Apple", "00:24:36": "Apple",
    "00:25:00": "Apple", "00:25:4B": "Apple", "00:25:BC": "Apple",
    "00:26:08": "Apple", "00:26:4A": "Apple", "00:26:B0": "Apple",
    "00:26:BB": "Apple", "28:CF:DA": "Apple", "3C:07:54": "Apple",
    "40:A6:D9": "Apple", "44:2A:60": "Apple", "58:55:CA": "Apple",
    "60:F8:1D": "Apple", "68:A8:6D": "Apple", "6C:40:08": "Apple",
    "70:56:81": "Apple", "78:4F:43": "Apple", "7C:6D:62": "Apple",
    "8C:00:6D": "Apple", "90:60:F0": "Apple", "98:FE:94": "Apple",
    "A8:66:7F": "Apple", "AC:CF:85": "Apple", "B8:53:AC": "Apple",
    "D8:A2:5E": "Apple", "E4:CE:8F": "Apple",
    # ── Samsung ───────────────────────────────────────────────────────────────
    "00:12:47": "Samsung", "00:15:99": "Samsung", "00:16:32": "Samsung",
    "00:17:C9": "Samsung", "00:1A:8A": "Samsung", "00:1D:25": "Samsung",
    "00:21:19": "Samsung", "00:23:39": "Samsung", "08:08:C2": "Samsung",
    "10:1D:C0": "Samsung", "18:3A:2D": "Samsung", "1C:62:B8": "Samsung",
    "20:64:32": "Samsung", "28:BA:B5": "Samsung", "30:CD:A7": "Samsung",
    "34:14:5F": "Samsung", "38:AA:3C": "Samsung", "40:0E:85": "Samsung",
    "44:4E:1A": "Samsung", "50:01:BB": "Samsung", "54:92:BE": "Samsung",
    "5C:49:79": "Samsung", "60:6B:BD": "Samsung", "8C:C8:CD": "Samsung",
    "A0:07:98": "Samsung", "B8:BC:1B": "Samsung", "C4:62:EA": "Samsung",
    "CC:07:AB": "Samsung", "D0:22:BE": "Samsung", "E4:40:E2": "Samsung",
    # ── TP-Link ───────────────────────────────────────────────────────────────
    "00:1D:0F": "TP-Link", "14:CC:20": "TP-Link", "1C:3B:F3": "TP-Link",
    "50:C7:BF": "TP-Link", "54:A7:03": "TP-Link", "60:32:B1": "TP-Link",
    "64:70:02": "TP-Link", "70:4F:57": "TP-Link", "74:EA:3A": "TP-Link",
    "90:F6:52": "TP-Link", "98:DA:C4": "TP-Link", "A0:F3:C1": "TP-Link",
    "B0:95:75": "TP-Link", "B4:B0:24": "TP-Link", "C0:25:E9": "TP-Link",
    "D8:07:B6": "TP-Link", "E8:DE:27": "TP-Link", "F4:F2:6D": "TP-Link",
    "30:DE:4B": "TP-Link", "6C:5A:B5": "TP-Link", "AC:84:C6": "TP-Link",
    "50:91:E3": "TP-Link", "3C:52:A1": "TP-Link",
    # ── Cisco ─────────────────────────────────────────────────────────────────
    "00:00:0C": "Cisco", "00:01:42": "Cisco", "00:01:43": "Cisco",
    "00:01:64": "Cisco", "00:01:96": "Cisco", "00:01:97": "Cisco",
    "00:02:17": "Cisco", "00:03:6B": "Cisco", "00:04:DD": "Cisco",
    "00:05:DC": "Cisco", "00:06:28": "Cisco", "00:07:0D": "Cisco",
    "00:0A:8A": "Cisco", "00:0B:45": "Cisco", "00:0C:85": "Cisco",
    "00:0D:28": "Cisco", "00:0E:38": "Cisco", "00:0F:23": "Cisco",
    "00:10:0B": "Cisco", "00:11:BB": "Cisco", "00:12:DA": "Cisco",
    "00:1B:2B": "Cisco", "58:AC:78": "Cisco", "70:69:5A": "Cisco",
    # ── Huawei ────────────────────────────────────────────────────────────────
    "00:18:82": "Huawei", "00:1E:10": "Huawei", "00:25:9E": "Huawei",
    "04:BD:70": "Huawei", "0C:37:DC": "Huawei", "10:1B:54": "Huawei",
    "18:C5:8A": "Huawei", "20:F3:A3": "Huawei", "28:31:52": "Huawei",
    "2C:AB:00": "Huawei", "34:6B:D3": "Huawei", "38:F8:89": "Huawei",
    "40:4D:8E": "Huawei", "4C:1F:CC": "Huawei", "50:9F:27": "Huawei",
    "54:51:1B": "Huawei", "5C:C3:07": "Huawei", "68:89:C1": "Huawei",
    "6C:8D:C1": "Huawei", "70:72:CF": "Huawei", "74:A0:EE": "Huawei",
    "78:1D:BA": "Huawei", "84:A1:D1": "Huawei", "88:E3:AB": "Huawei",
    "90:17:AC": "Huawei", "94:77:2B": "Huawei", "9C:52:F8": "Huawei",
    "A8:CA:7B": "Huawei", "AC:E2:15": "Huawei", "B8:08:D7": "Huawei",
    "BC:76:70": "Huawei", "C4:9A:02": "Huawei", "CC:96:A0": "Huawei",
    "D0:7A:B5": "Huawei", "D4:6A:A8": "Huawei", "E4:68:A3": "Huawei",
    # ── Xiaomi ────────────────────────────────────────────────────────────────
    "28:6C:07": "Xiaomi", "50:8F:4C": "Xiaomi", "64:09:80": "Xiaomi",
    "74:23:44": "Xiaomi", "8C:BE:BE": "Xiaomi", "F8:A2:D6": "Xiaomi",
    "00:9E:C8": "Xiaomi", "0C:1D:AF": "Xiaomi", "18:59:36": "Xiaomi",
    "20:34:FB": "Xiaomi", "34:80:B3": "Xiaomi", "3C:BD:D8": "Xiaomi",
    "58:44:98": "Xiaomi", "6C:EF:C6": "Xiaomi", "78:11:DC": "Xiaomi",
    "A4:C1:38": "Xiaomi", "B0:E2:35": "Xiaomi", "D4:97:0B": "Xiaomi",
    # ── D-Link ────────────────────────────────────────────────────────────────
    "00:05:5D": "D-Link", "00:0D:88": "D-Link", "00:11:95": "D-Link",
    "00:13:46": "D-Link", "00:15:E9": "D-Link", "00:17:9A": "D-Link",
    "00:19:5B": "D-Link", "00:1B:11": "D-Link", "00:1C:F0": "D-Link",
    "00:1E:58": "D-Link", "00:21:91": "D-Link", "00:22:B0": "D-Link",
    "00:24:01": "D-Link", "1C:7E:E5": "D-Link", "28:10:7B": "D-Link",
    "34:08:04": "D-Link", "84:C9:B2": "D-Link", "90:94:E4": "D-Link",
    "B8:A3:86": "D-Link", "C8:BE:19": "D-Link",
    # ── Netgear ───────────────────────────────────────────────────────────────
    "00:09:5B": "Netgear", "00:0F:B5": "Netgear", "00:14:6C": "Netgear",
    "00:18:4D": "Netgear", "00:1B:2F": "Netgear", "00:1E:2A": "Netgear",
    "00:22:3F": "Netgear", "00:24:B2": "Netgear", "20:4E:7F": "Netgear",
    "28:C6:8E": "Netgear", "2C:B0:5D": "Netgear", "30:46:9A": "Netgear",
    "4C:60:DE": "Netgear", "6C:B0:CE": "Netgear", "84:1B:5E": "Netgear",
    "A0:21:B7": "Netgear", "C0:3F:0E": "Netgear",
    # ── ZyXEL ─────────────────────────────────────────────────────────────────
    "00:13:49": "ZyXEL", "00:19:CB": "ZyXEL", "00:A0:C5": "ZyXEL",
    "1C:74:0D": "ZyXEL", "28:28:5D": "ZyXEL", "40:4A:03": "ZyXEL",
    "50:67:F0": "ZyXEL", "54:B8:0A": "ZyXEL", "70:72:8B": "ZyXEL",
    "84:AA:9C": "ZyXEL", "BC:F3:12": "ZyXEL", "D0:60:8C": "ZyXEL",
    "E8:37:7A": "ZyXEL", "F0:90:FA": "ZyXEL",
    # ── Reolink ───────────────────────────────────────────────────────────────
    "EC:71:DB": "Reolink", "A8:D4:E9": "Reolink",
    "54:EF:44": "Reolink", "BC:92:6B": "Reolink",
    # ── Axis ──────────────────────────────────────────────────────────────────
    "00:40:8C": "Axis", "AC:CC:8E": "Axis",
    "B8:A4:4F": "Axis", "00:0A:E4": "Axis",
    # ── Synology ──────────────────────────────────────────────────────────────
    "00:11:32": "Synology", "00:1A:A6": "Synology",
    # ── QNAP ──────────────────────────────────────────────────────────────────
    "00:08:9B": "QNAP", "00:50:43": "QNAP", "24:5E:BE": "QNAP",
    "28:25:BA": "QNAP", "B8:7C:BC": "QNAP",
    # ── VMware ────────────────────────────────────────────────────────────────
    "00:0C:29": "VMware", "00:50:56": "VMware", "00:05:69": "VMware",
    # ── Intel ─────────────────────────────────────────────────────────────────
    "00:02:B3": "Intel", "00:03:47": "Intel", "00:07:E9": "Intel",
    "00:0E:0C": "Intel", "00:12:F0": "Intel", "00:13:20": "Intel",
    "00:15:17": "Intel", "00:16:76": "Intel", "00:19:D1": "Intel",
    "00:1B:21": "Intel", "00:1C:C0": "Intel", "00:1D:E0": "Intel",
    "00:1E:64": "Intel", "00:1E:67": "Intel", "00:21:5C": "Intel",
    "00:22:FB": "Intel", "00:24:D7": "Intel",
    # ── Realtek ───────────────────────────────────────────────────────────────
    "00:E0:4C": "Realtek", "52:54:00": "Realtek",
    # ── Raspberry Pi ──────────────────────────────────────────────────────────
    "B8:27:EB": "Raspberry Pi", "DC:A6:32": "Raspberry Pi",
    "E4:5F:01": "Raspberry Pi",
    # ── Google ────────────────────────────────────────────────────────────────
    "00:1A:11": "Google", "18:B4:30": "Google", "20:DF:B9": "Google",
    "3C:5A:B4": "Google", "54:60:09": "Google", "A4:77:33": "Google",
    "F4:F5:D8": "Google",
    # ── Amazon ────────────────────────────────────────────────────────────────
    "00:FC:8B": "Amazon", "0C:47:C9": "Amazon", "18:74:2E": "Amazon",
    "28:EF:01": "Amazon", "34:D2:70": "Amazon", "44:65:0D": "Amazon",
    "68:37:E9": "Amazon", "74:75:48": "Amazon", "84:D6:D0": "Amazon",
    "B4:7C:9C": "Amazon", "F0:27:2D": "Amazon", "FC:A1:83": "Amazon",
    # ── HP ────────────────────────────────────────────────────────────────────
    "00:01:E6": "HP", "00:02:A5": "HP", "00:04:EA": "HP",
    "00:08:02": "HP", "00:0B:CD": "HP", "00:0E:7F": "HP",
    "00:11:0A": "HP", "00:13:21": "HP", "00:14:38": "HP",
    "00:15:60": "HP", "00:16:35": "HP", "00:17:08": "HP",
    "00:18:71": "HP", "00:19:BB": "HP", "00:1A:4B": "HP",
    "00:1C:C4": "HP", "00:1E:0B": "HP", "00:21:5A": "HP",
    # ── Dell ─────────────────────────────────────────────────────────────────
    "00:06:5B": "Dell", "00:08:74": "Dell", "00:0B:DB": "Dell",
    "00:0D:56": "Dell", "00:0F:1F": "Dell", "00:11:43": "Dell",
    "00:12:3F": "Dell", "00:13:72": "Dell", "00:14:22": "Dell",
    "00:15:C5": "Dell", "00:16:F0": "Dell", "00:18:8B": "Dell",
    "00:19:B9": "Dell", "00:1A:A0": "Dell", "00:1C:23": "Dell",
    "00:1D:09": "Dell", "00:1E:4F": "Dell", "00:21:70": "Dell",
    "18:A9:9B": "Dell", "1C:40:24": "Dell", "24:B6:FD": "Dell",
    "B0:83:FE": "Dell", "F8:DB:88": "Dell",
    # ── Lenovo ────────────────────────────────────────────────────────────────
    "00:07:3A": "Lenovo", "28:D2:44": "Lenovo", "34:73:5A": "Lenovo",
    "40:8D:5C": "Lenovo", "48:4D:7E": "Lenovo", "54:EE:75": "Lenovo",
    "60:02:92": "Lenovo", "60:EB:69": "Lenovo", "70:5A:0F": "Lenovo",
    "84:2B:2B": "Lenovo", "88:70:8C": "Lenovo", "98:FA:9B": "Lenovo",
    "AC:B5:7D": "Lenovo", "E8:6A:64": "Lenovo",
    # ── Tenda ─────────────────────────────────────────────────────────────────
    "C8:3A:35": "Tenda", "E8:94:F6": "Tenda", "1C:1B:0D": "Tenda",
    "48:EE:0C": "Tenda", "D0:76:8F": "Tenda",
    # ── GL.iNet ───────────────────────────────────────────────────────────────
    "94:83:C4": "GL.iNet", "B4:0E:DE": "GL.iNet",
    # ── Grandstream ───────────────────────────────────────────────────────────
    "00:0B:82": "Grandstream", "C0:74:AD": "Grandstream",
    "6C:2C:06": "Grandstream",
    # ── Yealink ───────────────────────────────────────────────────────────────
    "00:15:65": "Yealink", "80:5E:C0": "Yealink",
    # ── Fortinet ─────────────────────────────────────────────────────────────
    "00:09:0F": "Fortinet", "70:4C:A5": "Fortinet", "90:6C:AC": "Fortinet",
    # ── Palo Alto ─────────────────────────────────────────────────────────────
    "00:1B:17": "Palo Alto", "3C:08:F1": "Palo Alto",
    # ── Juniper ───────────────────────────────────────────────────────────────
    "00:05:85": "Juniper", "00:10:DB": "Juniper", "00:12:1E": "Juniper",
    "00:17:CB": "Juniper", "00:19:E2": "Juniper", "2C:6B:F5": "Juniper",
    "78:19:F7": "Juniper",
    # ── Aruba (HPE) ───────────────────────────────────────────────────────────
    "00:0B:86": "Aruba", "00:1A:1E": "Aruba", "24:DE:C6": "Aruba",
    "40:E3:D6": "Aruba", "6C:F3:7F": "Aruba", "84:D4:7E": "Aruba",
    "AC:A3:1E": "Aruba", "D8:C7:C8": "Aruba",
    # ── Sagemcom ──────────────────────────────────────────────────────────────
    "54:2A:1B": "Sagemcom", "E4:BF:FA": "Sagemcom", "E8:1E:27": "Sagemcom",
    # ── Technicolor ───────────────────────────────────────────────────────────
    "00:14:7F": "Technicolor", "00:1C:A2": "Technicolor",
    "48:D7:05": "Technicolor",
    # ── Hanwha ────────────────────────────────────────────────────────────────
    "00:09:18": "Hanwha", "14:55:36": "Hanwha",
    # ── Bosch Security ────────────────────────────────────────────────────────
    "00:40:AE": "Bosch",
    # ── Panasonic ─────────────────────────────────────────────────────────────
    "00:04:75": "Panasonic", "00:08:45": "Panasonic", "00:09:7C": "Panasonic",
    "00:0F:0E": "Panasonic", "00:13:E9": "Panasonic", "00:17:34": "Panasonic",
    "00:1B:FB": "Panasonic",
    # ── Sony ──────────────────────────────────────────────────────────────────
    "00:01:4A": "Sony", "00:04:1F": "Sony", "00:13:A9": "Sony",
    "00:19:C5": "Sony", "00:1A:80": "Sony", "00:24:BE": "Sony",
    "30:17:C8": "Sony", "70:2A:D5": "Sony", "A8:0C:A3": "Sony",
    # ── Fibaro ────────────────────────────────────────────────────────────────
    "38:54:7D": "Fibaro",
    # ── Mercusys ──────────────────────────────────────────────────────────────
    "B0:BE:76": "Mercusys", "9C:A6:15": "Mercusys", "DC:7B:94": "Mercusys",
}

# ══════════════════════════════════════════════════════════════════════════════
# Expanded probe ports (26 total, was 16)
# ══════════════════════════════════════════════════════════════════════════════
PROBE_PORTS = [
    22, 23, 80, 443, 554, 8080, 8291, 37777, 8443, 5000,
    445, 139, 548, 62078, 8888, 161,
    9000,   # Hikvision SDK
    2000,   # MikroTik Bandwidth Test
    8728,   # MikroTik API binary
    7547,   # TR-069
    5985,   # WinRM HTTP
    3389,   # RDP
    3306,   # MySQL
    5432,   # PostgreSQL
    6443,   # Kubernetes API
    49152,  # UPnP
]

# ══════════════════════════════════════════════════════════════════════════════
# Device model fingerprinting
# ══════════════════════════════════════════════════════════════════════════════
def fingerprint_device(ip: str, vendor: str, open_ports: list) -> dict:
    ports = set(open_ports)
    model = ""
    device_type = ""
    v = vendor

    if v == "MikroTik":
        device_type = "router"
        if 8291 in ports and 8728 in ports: model = "MikroTik RouterOS (Winbox+API)"
        elif 8291 in ports:                 model = "MikroTik RouterOS (Winbox)"
        elif 8728 in ports:                 model = "MikroTik RouterOS (API)"
        else:                               model = "MikroTik RouterOS"
    elif v == "Ubiquiti":
        device_type = "ap"
        if 8080 in ports and 8443 in ports: model = "Ubiquiti UniFi Controller"
        elif 22 in ports and 443 in ports:  model = "Ubiquiti UniFi AP"
        else:                               model = "Ubiquiti Device"
    elif v == "Hikvision":
        device_type = "camera"
        if 9000 in ports and 554 in ports:  model = "Hikvision NVR (SDK+RTSP)"
        elif 9000 in ports:                 model = "Hikvision NVR (SDK)"
        elif 554 in ports:                  model = "Hikvision NVR/Camera (RTSP)"
        else:                               model = "Hikvision IP Camera"
    elif v == "Dahua":
        device_type = "camera"
        if 37777 in ports and 554 in ports: model = "Dahua NVR (SDK+RTSP)"
        elif 37777 in ports:                model = "Dahua NVR/Camera"
        elif 554 in ports:                  model = "Dahua IP Camera (RTSP)"
        else:                               model = "Dahua IP Camera"
    elif v == "ASUS":
        if 80 in ports or 443 in ports:     model = "ASUS Router/AP"; device_type = "router"
        else:                               model = "ASUS Device"; device_type = "ap"
    elif v == "Huawei":
        device_type = "router"
        if 80 in ports or 443 in ports:     model = "Huawei Router/Switch"
        elif 22 in ports:                   model = "Huawei Network Device"
        else:                               model = "Huawei Device"
    elif v == "Apple":
        device_type = "mobile"
        if 5000 in ports:    model = "Apple TV / HomePod"
        elif 62078 in ports: model = "Apple iPhone/iPad"
        elif 548 in ports:   model = "Apple Mac (AFP)"
        elif 22 in ports:    model = "Apple Mac (SSH)"; device_type = "client"
        else:                model = "Apple Device"
    elif v == "VMware":
        model = "VMware Virtual Machine"; device_type = "server"
    elif v == "Synology":
        model = "Synology NAS"; device_type = "server"
    elif v == "QNAP":
        model = "QNAP NAS"; device_type = "server"
    elif v == "TP-Link":
        model = "TP-Link Router/AP" if (80 in ports or 443 in ports) else "TP-Link Device"
        device_type = "router"
    elif v == "D-Link":
        model = "D-Link Router/AP" if (80 in ports or 443 in ports) else "D-Link Device"
        device_type = "router"
    elif v == "Netgear":
        model = "Netgear Router/AP" if (80 in ports or 443 in ports) else "Netgear Device"
        device_type = "router"
    elif v == "ZyXEL":
        model = "ZyXEL Router/Modem"; device_type = "router"
    elif v == "Tenda":
        model = "Tenda Router/AP"; device_type = "router"
    elif v == "GL.iNet":
        model = "GL.iNet OpenWrt Router"; device_type = "router"
    elif v == "Cisco":
        device_type = "router"
        if 22 in ports:   model = "Cisco Switch/Router"
        elif 23 in ports: model = "Cisco Device (Telnet)"
        else:             model = "Cisco Device"
    elif v == "Juniper":
        model = "Juniper Network Device"; device_type = "router"
    elif v == "Fortinet":
        model = "Fortinet FortiGate"; device_type = "router"
    elif v == "Palo Alto":
        model = "Palo Alto Firewall"; device_type = "router"
    elif v == "Aruba":
        model = "Aruba Controller/AP" if (8080 in ports or 443 in ports) else "Aruba Network Device"
        device_type = "ap"
    elif v == "Reolink":
        model = "Reolink IP Camera (RTSP)" if 554 in ports else "Reolink IP Camera"
        device_type = "camera"
    elif v == "Axis":
        model = "Axis IP Camera"; device_type = "camera"
    elif v == "Hanwha":
        model = "Hanwha IP Camera"; device_type = "camera"
    elif v == "Bosch":
        model = "Bosch IP Camera"; device_type = "camera"
    elif v == "Raspberry Pi":
        device_type = "server"
        if 22 in ports:   model = "Raspberry Pi (SSH)"
        elif 80 in ports: model = "Raspberry Pi (Web)"
        else:             model = "Raspberry Pi"
    elif v == "Google":
        device_type = "client"
        if 8008 in ports: model = "Chromecast"
        elif 80 in ports: model = "Google Home / Nest Hub"
        else:             model = "Google Device"
    elif v == "Amazon":
        model = "Amazon Echo / Fire TV"; device_type = "client"
    elif v in ("HP", "Dell", "Lenovo"):
        if 3389 in ports:               model = f"{v} PC (RDP)"; device_type = "client"
        elif 5985 in ports:             model = f"{v} Server (WinRM)"; device_type = "server"
        elif 22 in ports:               model = f"{v} Server (SSH)"; device_type = "server"
        else:                           model = f"{v} Device"; device_type = "client"
    elif v == "Intel":
        model = "Intel NUC / PC"; device_type = "client"
    elif v in ("Grandstream", "Yealink"):
        model = f"{v} IP Phone"; device_type = "client"
    elif v == "Samsung":
        model = "Samsung Smart TV" if 8080 in ports else "Samsung Device"
        device_type = "client"
    elif v == "Xiaomi":
        model = "Xiaomi Router/Device" if 80 in ports else "Xiaomi Device"
        device_type = "router" if 80 in ports else "mobile"
    elif v == "Fibaro":
        model = "Fibaro Smart Home Hub"; device_type = "server"

    # ── Port-only fallback ────────────────────────────────────────────────────
    if not model:
        if 8291 in ports and 8728 in ports:
            model = "MikroTik RouterOS (Winbox+API)"; device_type = "router"
        elif 8291 in ports:
            model = "MikroTik RouterOS"; device_type = "router"
        elif 8728 in ports:
            model = "MikroTik RouterOS (API)"; device_type = "router"
        elif 37777 in ports and 554 in ports:
            model = "Dahua NVR/Camera"; device_type = "camera"
        elif 9000 in ports and 554 in ports:
            model = "Hikvision NVR"; device_type = "camera"
        elif 554 in ports and (80 in ports or 8080 in ports):
            model = "IP Camera (RTSP)"; device_type = "camera"
        elif 8080 in ports and 8443 in ports:
            model = "UniFi Controller"; device_type = "ap"
        elif 5985 in ports or 3389 in ports:
            model = "Windows Host"; device_type = "server"
        elif 3306 in ports or 5432 in ports:
            model = "Database Server"; device_type = "server"
        elif 6443 in ports:
            model = "Kubernetes Node"; device_type = "server"
        elif 22 in ports and 80 in ports and 443 in ports:
            model = "Linux Server"; device_type = "server"
        elif 22 in ports and 80 in ports:
            model = "Network Device"; device_type = "router"
        elif 445 in ports or 139 in ports:
            model = "Windows / Samba Host"; device_type = "client"
        elif 548 in ports:
            model = "macOS / AFP Server"; device_type = "client"
        elif 49152 in ports:
            model = "UPnP Device"; device_type = "client"
        elif 7547 in ports:
            model = "ISP Router (TR-069)"; device_type = "router"
        elif 23 in ports:
            model = "Legacy Network Device (Telnet)"; device_type = "router"

    return {"model": model, "suggested_type": device_type}


# ══════════════════════════════════════════════════════════════════════════════
# HTTP Banner grabbing
# ══════════════════════════════════════════════════════════════════════════════
import urllib.request, ssl as _ssl

_ssl_ctx = _ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = _ssl.CERT_NONE

HTTP_BANNER_SIGNATURES = [
    ("micro_httpd",  "MikroTik",  "MikroTik RouterOS"),
    ("RomPager",     "MikroTik",  "MikroTik RouterOS"),
    ("App-webs",     "Hikvision", "Hikvision NVR/Camera"),
    ("DNVRS-Webs",   "Hikvision", "Hikvision NVR/Camera"),
    ("Hikvision",    "Hikvision", "Hikvision NVR/Camera"),
    ("DahuaHTTP",    "Dahua",     "Dahua NVR/Camera"),
    ("Dahua",        "Dahua",     "Dahua NVR/Camera"),
    ("airOS",        "Ubiquiti",  "Ubiquiti airOS AP"),
    ("TP-LINK",      "TP-Link",   "TP-Link Router"),
    ("DSL-",         "D-Link",    "D-Link Router"),
    ("Reolink",      "Reolink",   "Reolink IP Camera"),
    ("lighttpd",     "Ubiquiti",  "Ubiquiti Device"),
]

def grab_http_banner(ip: str, open_ports: list, timeout: float = 3.0) -> dict:
    """Try HTTP on open ports, return vendor/model hints from Server header and body."""
    result = {"server_header": "", "title": "", "vendor": "", "model": ""}
    port_order = [p for p in (80, 8080, 443, 8443, 8888) if p in open_ports]
    if not port_order:
        return result
    for port in port_order:
        scheme = "https" if port in (443, 8443) else "http"
        try:
            req = urllib.request.Request(
                f"{scheme}://{ip}:{port}/",
                headers={"User-Agent": "NetWatch/1.0"},
                method="GET"
            )
            with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as r:
                server = r.headers.get("Server", "")
                body = r.read(4096).decode(errors="ignore")
                result["server_header"] = server
                m = re.search(r"<title[^>]*>([^<]{1,80})</title>", body, re.I)
                if m:
                    result["title"] = m.group(1).strip()
                for sig, vendor, model in HTTP_BANNER_SIGNATURES:
                    if sig.lower() in server.lower() or sig.lower() in body[:1024].lower():
                        result["vendor"] = vendor
                        result["model"] = model
                        return result
                return result
        except Exception:
            continue
    return result


# ══════════════════════════════════════════════════════════════════════════════
# SNMP v1 sysDescr grab
# ══════════════════════════════════════════════════════════════════════════════
def grab_snmp_sysdescr(ip: str, community: str = "public", timeout: float = 2.0) -> str:
    """Send SNMPv1 GetRequest for sysDescr.0, return string or empty."""
    try:
        def enc_len(l):
            if l < 128: return bytes([l])
            return bytes([0x81, l]) if l < 256 else bytes([0x82, l >> 8, l & 0xFF])

        def enc_oid(s):
            p = list(map(int, s.split(".")))
            body = bytes([40 * p[0] + p[1]])
            for x in p[2:]:
                if x < 128:
                    body += bytes([x])
                else:
                    enc = []
                    while x:
                        enc.append(x & 0x7F); x >>= 7
                    enc.reverse()
                    body += bytes([b | (0x80 if i < len(enc)-1 else 0) for i, b in enumerate(enc)])
            return b"\x06" + enc_len(len(body)) + body

        comm = community.encode()
        comm_tlv = b"\x04" + enc_len(len(comm)) + comm
        oid_tlv = enc_oid("1.3.6.1.2.1.1.1.0")
        varbind = b"\x30" + enc_len(len(oid_tlv) + 2) + oid_tlv + b"\x05\x00"
        vblist  = b"\x30" + enc_len(len(varbind)) + varbind
        pdu_body = b"\x02\x01\x01\x02\x01\x00\x02\x01\x00" + vblist
        pdu = b"\xa0" + enc_len(len(pdu_body)) + pdu_body
        msg_body = b"\x02\x01\x00" + comm_tlv + pdu
        msg = b"\x30" + enc_len(len(msg_body)) + msg_body

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        sock.sendto(msg, (ip, 161))
        data, _ = sock.recvfrom(4096)
        sock.close()

        idx = data.find(b"\x04", 40)
        if idx != -1 and idx + 1 < len(data):
            length = data[idx + 1]
            if idx + 2 + length <= len(data):
                return data[idx + 2: idx + 2 + length].decode(errors="ignore").strip()
    except Exception:
        pass
    return ""


SNMP_SIGNATURES = [
    ("RouterOS",    "MikroTik"),
    ("MikroTik",    "MikroTik"),
    ("Cisco IOS",   "Cisco"),
    ("Cisco",       "Cisco"),
    ("Juniper",     "Juniper"),
    ("FortiOS",     "Fortinet"),
    ("Fortinet",    "Fortinet"),
    ("Synology",    "Synology"),
    ("QNAP",        "QNAP"),
    ("Hikvision",   "Hikvision"),
    ("Dahua",       "Dahua"),
    ("Ubiquiti",    "Ubiquiti"),
    ("ArubaOS",     "Aruba"),
    ("HP ProCurve", "HP"),
    ("Huawei",      "Huawei"),
]

def parse_snmp_sysdescr(sysdescr: str) -> dict:
    if not sysdescr:
        return {"vendor": "", "model": "", "sysdescr": ""}
    for sig, vendor in SNMP_SIGNATURES:
        if sig.lower() in sysdescr.lower():
            # Try to extract version number
            ver = re.search(r"(\d+[\d.]+)", sysdescr)
            model = f"{vendor} {ver.group(1)}" if ver else vendor
            return {"vendor": vendor, "model": model, "sysdescr": sysdescr}
    return {"vendor": "", "model": "", "sysdescr": sysdescr}


# ══════════════════════════════════════════════════════════════════════════════
# MAC & ARP helpers
# ══════════════════════════════════════════════════════════════════════════════
def get_mac_from_arp(ip: str) -> str:
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
    if not mac:
        return ""
    return OUI_DB.get(mac[:8].upper(), "")


# ══════════════════════════════════════════════════════════════════════════════
# SNMP full stats: CPU, RAM, uptime, interfaces
# ══════════════════════════════════════════════════════════════════════════════

# Standard MIB-2 OIDs
SNMP_OIDS = {
    "sysDescr":     "1.3.6.1.2.1.1.1.0",
    "sysUpTime":    "1.3.6.1.2.1.1.3.0",
    "sysName":      "1.3.6.1.2.1.1.5.0",
    # HOST-RESOURCES-MIB (hrProcessorLoad — per-CPU average, walk first instance)
    "cpuLoad":      "1.3.6.1.2.1.25.3.3.1.2.1",
    # HOST-RESOURCES-MIB memory
    "hrMemSize":    "1.3.6.1.2.1.25.2.2.0",   # total RAM in KB
    # UCD-SNMP / net-snmp CPU (Linux)
    "ucpuIdle":     "1.3.6.1.4.1.2021.11.11.0",
    # ifTable first 8 interfaces (ifInOctets / ifOutOctets)
    # We walk .1.3.6.1.2.1.2.2.1.2 (ifDescr) indexes 1-8
    "ifDescr1":     "1.3.6.1.2.1.2.2.1.2.1",
    "ifDescr2":     "1.3.6.1.2.1.2.2.1.2.2",
    "ifDescr3":     "1.3.6.1.2.1.2.2.1.2.3",
    "ifDescr4":     "1.3.6.1.2.1.2.2.1.2.4",
    "ifInOctets1":  "1.3.6.1.2.1.2.2.1.10.1",
    "ifInOctets2":  "1.3.6.1.2.1.2.2.1.10.2",
    "ifInOctets3":  "1.3.6.1.2.1.2.2.1.10.3",
    "ifInOctets4":  "1.3.6.1.2.1.2.2.1.10.4",
    "ifOutOctets1": "1.3.6.1.2.1.2.2.1.16.1",
    "ifOutOctets2": "1.3.6.1.2.1.2.2.1.16.2",
    "ifOutOctets3": "1.3.6.1.2.1.2.2.1.16.3",
    "ifOutOctets4": "1.3.6.1.2.1.2.2.1.16.4",
    "ifOperStatus1":"1.3.6.1.2.1.2.2.1.8.1",
    "ifOperStatus2":"1.3.6.1.2.1.2.2.1.8.2",
    "ifOperStatus3":"1.3.6.1.2.1.2.2.1.8.3",
    "ifOperStatus4":"1.3.6.1.2.1.2.2.1.8.4",
    "ifSpeed1":     "1.3.6.1.2.1.2.2.1.5.1",
    "ifSpeed2":     "1.3.6.1.2.1.2.2.1.5.2",
    "ifSpeed3":     "1.3.6.1.2.1.2.2.1.5.3",
    "ifSpeed4":     "1.3.6.1.2.1.2.2.1.5.4",
    # MikroTik specific CPU (walks .1.3.6.1.2.1.25.3.3.1.2)
    "mtCpuLoad":    "1.3.6.1.2.1.25.3.3.1.2.1",
}


def _snmp_get_multi(ip: str, oids: list, community: str = "public",
                    timeout: float = 2.0) -> dict:
    """Send one SNMPv1 GetRequest for multiple OIDs, return dict oid→raw_value."""
    try:
        def enc_len(l):
            if l < 128: return bytes([l])
            return bytes([0x81, l]) if l < 256 else bytes([0x82, l >> 8, l & 0xFF])

        def enc_oid(s):
            p = list(map(int, s.split(".")))
            body = bytes([40 * p[0] + p[1]])
            for x in p[2:]:
                if x < 128:
                    body += bytes([x])
                else:
                    enc = []
                    while x: enc.append(x & 0x7F); x >>= 7
                    enc.reverse()
                    body += bytes([b | (0x80 if i < len(enc)-1 else 0)
                                   for i, b in enumerate(enc)])
            return b"\x06" + enc_len(len(body)) + body

        def enc_varbind(oid_str):
            oid = enc_oid(oid_str)
            inner = oid + b"\x05\x00"
            return b"\x30" + enc_len(len(inner)) + inner

        comm = community.encode()
        comm_tlv = b"\x04" + enc_len(len(comm)) + comm
        varbinds = b"".join(enc_varbind(o) for o in oids)
        vblist = b"\x30" + enc_len(len(varbinds)) + varbinds
        pdu_body = b"\x02\x01\x01\x02\x01\x00\x02\x01\x00" + vblist
        pdu = b"\xa0" + enc_len(len(pdu_body)) + pdu_body
        msg_body = b"\x02\x01\x00" + comm_tlv + pdu
        msg = b"\x30" + enc_len(len(msg_body)) + msg_body

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        sock.sendto(msg, (ip, 161))
        data, _ = sock.recvfrom(65535)
        sock.close()
        return _parse_snmp_response(data, oids)
    except Exception:
        return {}


def _parse_snmp_response(data: bytes, oids: list) -> dict:
    """Parse SNMPv1 GetResponse, return dict oid→value."""
    result = {}
    try:
        def parse_len(buf, pos):
            if buf[pos] < 128:
                return buf[pos], pos + 1
            n = buf[pos] & 0x7F
            val = int.from_bytes(buf[pos+1:pos+1+n], 'big')
            return val, pos + 1 + n

        def parse_oid(buf, pos, length):
            val = buf[pos:pos+length]
            parts = [val[0] // 40, val[0] % 40]
            i = 1
            while i < len(val):
                if val[i] & 0x80:
                    acc = 0
                    while val[i] & 0x80:
                        acc = (acc << 7) | (val[i] & 0x7F); i += 1
                    acc = (acc << 7) | val[i]; i += 1
                    parts.append(acc)
                else:
                    parts.append(val[i]); i += 1
            return ".".join(map(str, parts))

        pos = 0
        # Skip outer SEQUENCE, version, community, response PDU headers
        # Walk all VarBind objects in the response
        def find_varbinds(buf, start, end):
            items = []
            p = start
            while p < end:
                tag = buf[p]; p += 1
                length, p = parse_len(buf, p)
                content_start = p
                p = content_start + length
                if tag == 0x30:  # SEQUENCE = VarBind
                    inner = buf[content_start:content_start+length]
                    # inner[0] should be OID tag 0x06
                    if len(inner) >= 2 and inner[0] == 0x06:
                        oid_len = inner[1]
                        oid_str = parse_oid(inner, 2, oid_len)
                        val_start = 2 + oid_len
                        if val_start < len(inner):
                            vtype = inner[val_start]
                            vlen, vpos = parse_len(inner, val_start + 1)
                            raw = inner[vpos:vpos+vlen]
                            items.append((oid_str, vtype, raw))
                    elif tag == 0x30:
                        items.extend(find_varbinds(buf, content_start, content_start+length))
            return items

        # Simple linear scan for OctetString (0x04), Integer (0x02), TimeTicks (0x43),
        # Counter32 (0x41), Gauge32 (0x42) after each OID
        i = 0
        oid_idx = 0
        while i < len(data) - 4:
            if data[i] == 0x06:  # OID tag
                oid_len = data[i+1]
                if i + 2 + oid_len <= len(data):
                    try:
                        raw_oid = data[i+2:i+2+oid_len]
                        parts = [raw_oid[0] // 40, raw_oid[0] % 40]
                        j = 1
                        while j < len(raw_oid):
                            if raw_oid[j] & 0x80:
                                acc = 0
                                while raw_oid[j] & 0x80:
                                    acc = (acc << 7) | (raw_oid[j] & 0x7F); j += 1
                                acc = (acc << 7) | raw_oid[j]; j += 1
                                parts.append(acc)
                            else:
                                parts.append(raw_oid[j]); j += 1
                        oid_str = ".".join(map(str, parts))
                        # Read next TLV as value
                        vpos = i + 2 + oid_len
                        if vpos < len(data):
                            vtype = data[vpos]
                            vlen, vstart = parse_len(data, vpos + 1)
                            raw_val = data[vstart:vstart+vlen]
                            result[oid_str] = (vtype, raw_val)
                        i += 2 + oid_len
                        continue
                    except Exception:
                        pass
            i += 1
    except Exception:
        pass
    return result


def _decode_snmp_value(vtype: int, raw: bytes):
    """Decode SNMP value by type tag."""
    if vtype == 0x02:  # Integer
        return int.from_bytes(raw, 'big', signed=True)
    if vtype == 0x04:  # OctetString
        try: return raw.decode('utf-8', errors='replace').strip()
        except: return raw.hex()
    if vtype == 0x41:  # Counter32
        return int.from_bytes(raw, 'big')
    if vtype == 0x42:  # Gauge32
        return int.from_bytes(raw, 'big')
    if vtype == 0x43:  # TimeTicks (1/100 sec)
        return int.from_bytes(raw, 'big')
    if vtype == 0x46:  # Counter64
        return int.from_bytes(raw, 'big')
    if vtype == 0x06:  # OID
        return "OID"
    return None


def grab_snmp_stats(ip: str, community: str = "public") -> dict:
    """
    Full SNMP poll: sysDescr, uptime, sysName, CPU load, RAM, interfaces.
    Returns structured dict ready for JSON serialisation.
    """
    result = {
        "ok": False,
        "sysdescr": "", "sysname": "",
        "uptime_ticks": None, "uptime_str": "",
        "cpu_pct": None,
        "mem_total_kb": None, "mem_used_kb": None, "mem_pct": None,
        "interfaces": [],
        "error": ""
    }

    # Batch 1: system info + CPU + RAM
    batch1_oids = [
        SNMP_OIDS["sysDescr"], SNMP_OIDS["sysUpTime"], SNMP_OIDS["sysName"],
        SNMP_OIDS["cpuLoad"], SNMP_OIDS["ucpuIdle"], SNMP_OIDS["hrMemSize"],
    ]
    raw1 = _snmp_get_multi(ip, batch1_oids, community)
    if not raw1:
        result["error"] = "No SNMP response (community mismatch or SNMP disabled)"
        return result

    result["ok"] = True

    def get(oid_key):
        oid = SNMP_OIDS.get(oid_key, oid_key)
        val = raw1.get(oid)
        if val is None:
            # try with stripped leading 1.
            for k, v in raw1.items():
                if k.endswith(oid.lstrip("1.3.6.1")) or k == oid:
                    return _decode_snmp_value(v[0], v[1])
            return None
        return _decode_snmp_value(val[0], val[1])

    result["sysdescr"] = get("sysDescr") or ""
    result["sysname"]  = get("sysName") or ""

    uptime = get("sysUpTime")
    if isinstance(uptime, int):
        result["uptime_ticks"] = uptime
        s = uptime // 100
        d, s = divmod(s, 86400)
        h, s = divmod(s, 3600)
        m, s = divmod(s, 60)
        if d:   result["uptime_str"] = f"{d}д {h:02d}:{m:02d}:{s:02d}"
        else:   result["uptime_str"] = f"{h:02d}:{m:02d}:{s:02d}"

    # CPU — try hrProcessorLoad first, then ucd-snmp idle
    cpu = get("cpuLoad")
    if isinstance(cpu, int) and 0 <= cpu <= 100:
        result["cpu_pct"] = cpu
    else:
        idle = get("ucpuIdle")
        if isinstance(idle, int) and 0 <= idle <= 100:
            result["cpu_pct"] = 100 - idle

    # RAM
    mem_total = get("hrMemSize")
    if isinstance(mem_total, int) and mem_total > 0:
        result["mem_total_kb"] = mem_total

    # Batch 2: interface descriptors + counters (4 interfaces)
    batch2_oids = []
    for i in range(1, 5):
        for k in (f"ifDescr{i}", f"ifInOctets{i}", f"ifOutOctets{i}",
                  f"ifOperStatus{i}", f"ifSpeed{i}"):
            batch2_oids.append(SNMP_OIDS[k])

    raw2 = _snmp_get_multi(ip, batch2_oids, community)

    def get2(oid_key):
        oid = SNMP_OIDS.get(oid_key, oid_key)
        val = raw2.get(oid)
        if val is None:
            for k, v in raw2.items():
                if k == oid: return _decode_snmp_value(v[0], v[1])
            return None
        return _decode_snmp_value(val[0], val[1])

    for i in range(1, 5):
        descr      = get2(f"ifDescr{i}")
        in_oct     = get2(f"ifInOctets{i}")
        out_oct    = get2(f"ifOutOctets{i}")
        oper       = get2(f"ifOperStatus{i}")
        speed      = get2(f"ifSpeed{i}")
        if descr is None:
            continue
        iface = {
            "index":     i,
            "name":      descr if isinstance(descr, str) else f"if{i}",
            "in_octets": in_oct  if isinstance(in_oct, int)  else None,
            "out_octets":out_oct if isinstance(out_oct, int) else None,
            "status":    "up" if oper == 1 else ("down" if oper == 2 else "unknown"),
            "speed_bps": speed if isinstance(speed, int) else None,
        }
        result["interfaces"].append(iface)

    return result