"""
Monitor state, background ping loops, auto-discovery, scan orchestration.
"""
import asyncio, threading, time
from .config import POWER_IP, PHIST_MAX
from .scanner import async_ping, run_async_scan
from .storage import load_devices, save_devices, load_subnets
from .events  import add_event, record_ping, load_tg, ping_history, _ph_lock

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

def _on_ping_result(ip:str, alive:bool, ms, devices_by_ip:dict, cfg:dict=None):
    """Update caches, record history, fire events on state changes."""
    prev = status_cache.get(ip)           # None = unknown (first scan)
    status_cache[ip]  = alive
    latency_cache[ip] = ms
    record_ping(ip, alive, ms)

    if cfg is None: cfg = load_tg()
    name = devices_by_ip.get(ip, {}).get("name", ip)
    is_gw = (ip == POWER_IP)

    if prev is True and not alive:
        # ── just went down ────────────────────────────────────────────────
        _down_since[ip] = time.time()
        add_event("down", ip, name, "Устройство перестало отвечать на пинг")
        if is_gw:
            add_event("power_off", ip, name,
                      "Главный шлюз недоступен — возможно отключение электроэнергии",
                      notify=cfg.get("notify_power", True))
        elif cfg.get("notify_device"):
            thr = cfg.get("down_min", 5) * 60
            def _alert(ip=ip, name=name, thr=thr):
                time.sleep(thr)
                if status_cache.get(ip) is False:
                    add_event("down_alert", ip, name,
                              f"Устройство недоступно более {thr//60} мин", notify=True)
            threading.Thread(target=_alert, daemon=True).start()

    elif prev is False and alive:
        # ── came back up ──────────────────────────────────────────────────
        down_sec = time.time() - _down_since.pop(ip, time.time())
        mins = int(down_sec // 60)
        detail = f"Снова онлайн (было недоступно {mins} мин)" if mins else "Снова онлайн"
        add_event("up", ip, name, detail)
        if is_gw:
            add_event("power_on", ip, name,
                      f"Питание восстановлено (отключение {mins} мин)",
                      notify=cfg.get("notify_power", True))


def _do_monitor_scan(deep=False):
    """Scan all known devices. deep=True → also probe ports for fingerprinting."""
    global last_scan_time
    devices = load_devices()
    ips = [d["ip"] for d in devices]
    if not ips: return

    dbip = {d["ip"]: d for d in devices}
    cfg = load_tg()   # load once for all devices

    if deep:
        results = run_async_scan(ips, max_concurrent=60)
        # Persist mac/vendor/model into devices.json (only fill empty fields)
        changed = False
        for r in results:
            ip = r["ip"]
            if r["mac"]:        mac_cache[ip]    = r["mac"]
            if r["vendor"]:     vendor_cache[ip] = r["vendor"]
            if r["model"]:      model_cache[ip]  = r["model"]
            if r["open_ports"]: ports_cache[ip]  = r["open_ports"]
            _on_ping_result(ip, r["alive"], r["latency"], dbip, cfg)
        devs = load_devices()
        rm = {r["ip"]: r for r in results}
        for d in devs:
            r = rm.get(d["ip"])
            if not r: continue
            for fld in ("mac","vendor","model"):
                if r.get(fld) and not d.get(fld):
                    d[fld] = r[fld]; changed = True
        if changed: save_devices(devs)
    else:
        # Quick ping only (auto every 60s)
        buf = []; lock = threading.Lock()
        async def quick():
            sem = asyncio.Semaphore(50)
            async def p(ip):
                async with sem:
                    alive, ms = await async_ping(ip)
                    with lock: buf.append((ip, alive, ms))
            await asyncio.gather(*[p(ip) for ip in ips])
        loop = asyncio.new_event_loop()
        try: loop.run_until_complete(quick())
        finally: loop.close()
        for ip, alive, ms in buf:
            _on_ping_result(ip, alive, ms, dbip, cfg)

    last_scan_time = time.time()

def background_auto_ping():
    """Runs forever — quick ping every 60 seconds."""
    global auto_ping_running
    auto_ping_running = True
    while True:
        time.sleep(60)
        try: _do_monitor_scan(deep=False)
        except Exception as e: print(f"[auto-ping] error: {e}")

# ── Auto background scan states ──────────────────────────────────────────────
auto_discovery_state = {
    "last_run": None, "new_count": 0, "new_devices": [],
    "subnets_scanned": [], "running": False
}
auto_subnet_state = {
    "last_run": None, "new_count": 0, "new_subnets": [], "running": False
}

def _run_auto_discovery():
    """Scan all registered subnets for unregistered devices (runs every 5 min)."""
    if auto_discovery_state["running"]: return
    auto_discovery_state["running"] = True
    try:
        subnets = [s["prefix"] for s in load_subnets() if s.get("scan")]
        if not subnets: return
        reg = {d["ip"] for d in load_devices()}
        ips = [f"{s}.{i}" for s in subnets for i in range(1, 255)]
        found_new = []
        lock = threading.Lock()
        def on_result(r):
            if r["alive"] and r["ip"] not in reg:
                with lock: found_new.append(r["ip"])
        run_async_scan(ips, on_result=on_result, max_concurrent=80)
        srt = lambda lst: sorted(lst, key=lambda x: list(map(int, x.split("."))))
        auto_discovery_state.update({
            "last_run": time.time(),
            "new_count": len(found_new),
            "new_devices": srt(found_new),
            "subnets_scanned": subnets,
        })
        if found_new:
            print(f"[auto-discovery] {len(found_new)} unregistered hosts: {found_new}")
            cfg = load_tg()
            if cfg.get("notify_new_host"):
                for ip in found_new:
                    add_event("new_host", ip, ip,
                              f"Незарегистрированный хост в сети", notify=True)
    except Exception as e:
        print(f"[auto-discovery] error: {e}")
    finally:
        auto_discovery_state["running"] = False

def _run_auto_subnet_scan():
    """Scan 192.168.0-255.1 for unknown subnets (runs every 15 min)."""
    if auto_subnet_state["running"]: return
    auto_subnet_state["running"] = True
    try:
        reg_prefixes = {s["prefix"] for s in load_subnets()}
        ips = [f"192.168.{x}.1" for x in range(256)]
        alive_xs = []
        lock = threading.Lock()
        def on_result(r):
            if r["alive"]:
                x = int(r["ip"].split(".")[2])
                with lock: alive_xs.append(x)
        run_async_scan(ips, on_result=on_result, max_concurrent=64)
        new_subs = [x for x in alive_xs if f"192.168.{x}" not in reg_prefixes]
        auto_subnet_state.update({
            "last_run": time.time(),
            "new_count": len(new_subs),
            "new_subnets": sorted(new_subs),
        })
        if new_subs:
            print(f"[auto-subnet] {len(new_subs)} new subnets: {new_subs}")
    except Exception as e:
        print(f"[auto-subnet] error: {e}")
    finally:
        auto_subnet_state["running"] = False

def background_auto_discovery():
    """Runs forever — host discovery every 5 minutes."""
    time.sleep(90)  # initial delay
    while True:
        try: _run_auto_discovery()
        except Exception as e: print(f"[auto-discovery] error: {e}")
        time.sleep(300)

def background_auto_subnet():
    """Runs forever — subnet scan every 15 minutes."""
    time.sleep(180)  # initial delay
    while True:
        try: _run_auto_subnet_scan()
        except Exception as e: print(f"[auto-subnet] error: {e}")
        time.sleep(900)

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