"""
Telegram notifications, event log (events.json), ping history for sparklines.
"""
import json, os, time, threading, collections
import urllib.request as _ureq
from .config import TG_FILE, EVENTS_FILE, PHIST_MAX

def load_tg():
    if os.path.exists(TG_FILE):
        with open(TG_FILE) as f: return json.load(f)
    return {"token": "", "recipients": [],
            "enabled": False, "notify_power": True,
            "notify_device": True, "notify_new_host": True, "down_min": 5}

def save_tg(cfg):
    with open(TG_FILE, "w") as f: json.dump(cfg, f, ensure_ascii=False, indent=2)

def tg_send(text: str):
    """Send message to ALL configured recipients."""
    cfg = load_tg()
    if not cfg.get("enabled") or not cfg.get("token"): return
    # Collect all active chat_ids
    recipients = cfg.get("recipients", [])
    # backward-compat: migrate old single chat_id field
    if not recipients and cfg.get("chat_id"):
        recipients = [{"chat_id": cfg["chat_id"], "label": "Default", "active": True}]
    active = [r["chat_id"] for r in recipients if r.get("active", True) and r.get("chat_id")]
    if not active: return
    url = f"https://api.telegram.org/bot{cfg['token']}/sendMessage"
    for chat_id in active:
        try:
            data = json.dumps({"chat_id": chat_id, "text": text,
                               "parse_mode": "HTML"}).encode()
            _ureq.urlopen(_ureq.Request(url, data=data,
                          headers={"Content-Type": "application/json"}), timeout=8)
        except Exception as e:
            print(f"[tg] {chat_id}: {e}")

def tg_send_to(text: str, chat_id: str):
    """Send test message to a specific chat_id."""
    cfg = load_tg()
    if not cfg.get("token"): return False
    try:
        url = f"https://api.telegram.org/bot{cfg['token']}/sendMessage"
        data = json.dumps({"chat_id": chat_id, "text": text,
                           "parse_mode": "HTML"}).encode()
        _ureq.urlopen(_ureq.Request(url, data=data,
                      headers={"Content-Type": "application/json"}), timeout=8)
        return True
    except Exception as e:
        print(f"[tg] test to {chat_id}: {e}")
        return False

# ── Event log ──────────────────────────────────────────────────────────────────
_ev_lock = threading.Lock()

def load_events():
    if os.path.exists(EVENTS_FILE):
        with open(EVENTS_FILE) as f: return json.load(f)
    return []

def save_events(evs):
    with open(EVENTS_FILE,"w") as f: json.dump(evs[-1000:],f,ensure_ascii=False,indent=2)

def add_event(kind:str, ip:str, name:str, detail:str="", notify:bool=False):
    ev={"ts":time.time(),"kind":kind,"ip":ip,"name":name,"detail":detail}
    with _ev_lock:
        evs=load_events(); evs.append(ev); save_events(evs)
    if notify:
        icons={"down":"🔴","up":"🟢","power_off":"⚡🔴","power_on":"⚡🟢","reboot":"🔄","new_host":"🆕","down_alert":"⚠️"}
        icon=icons.get(kind,"ℹ️")
        threading.Thread(target=tg_send,args=(f"{icon} <b>NetWatch</b>\n<b>{name}</b> ({ip})\n{detail}",),daemon=True).start()

# ── Ping history (sparkline, ~2.4h at 60s interval) ───────────────────────────
PHIST_MAX = 144   # 144 × 60s = 144 min
ping_history: dict = {}   # ip → deque[{ts,ms,alive}]
_ph_lock = threading.Lock()

def record_ping(ip:str, alive:bool, ms):
    with _ph_lock:
        if ip not in ping_history:
            ping_history[ip]=collections.deque(maxlen=PHIST_MAX)
        ping_history[ip].append({"ts":time.time(),"ms":ms,"alive":alive})

# tracks when each device went down (for delayed alert)
_down_since: dict = {}

# ══════════════════════════════════════════════════════════════════════════════
# OUI Database — top vendors seen in networks (prefix → vendor)