"""JSON persistence: devices, subnets."""
import json, os
from .config import DEVICES_FILE, SUBNETS_FILE

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