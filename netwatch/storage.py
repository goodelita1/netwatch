"""JSON persistence: devices, subnets."""
import json, os
from .config import DEVICES_FILE, SUBNETS_FILE

# Defaults
# ══════════════════════════════════════════════════════════════════════════════
DEFAULT_DEVICES = []

DEFAULT_SUBNETS = []

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