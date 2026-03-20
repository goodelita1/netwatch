"""
Monitor state, background ping loops, auto-discovery, scan orchestration.

Event logic:
  prev=None,  alive=False  → записать _down_since, нет события (первый скан)
  prev=None,  alive=True   → нет события (первый скан, уже онлайн)
  prev=False, alive=False  → ничего (всё ещё offline)
  prev=False, alive=True   → событие "up"
  prev=True,  alive=False  → событие "down"
  prev=True,  alive=True   → ничего (всё ещё online)
"""
import asyncio, threading, time, traceback
from .config import POWER_IP, PHIST_MAX
from .scanner import async_ping, run_async_scan
from .storage import load_devices, save_devices, load_subnets
from .events  import add_event, record_ping, load_tg, ping_history, _ph_lock, _down_since

# ── Monitor state ─────────────────────────────────────────────────────────────
status_cache   = {}   # ip → True | False  (None только до первого скана)
latency_cache  = {}   # ip → float | None
mac_cache      = {}
vendor_cache   = {}
model_cache    = {}
ports_cache    = {}
last_scan_time = 0
auto_ping_running = False

_cache_lock = threading.Lock()   # защита от race condition между потоками


def _on_ping_result(ip: str, alive, ms, devices_by_ip: dict, cfg: dict = None):
    """
    Обрабатывает результат одного пинга.
    alive: bool или None (нормализуется в bool).
    Вызывается из авто-пинга, ручного пинга, глубокого скана и тест-endpoint.
    """
    alive = bool(alive)   # None → False, гарантируем bool

    with _cache_lock:
        prev = status_cache.get(ip)   # None | True | False
        status_cache[ip]  = alive
        latency_cache[ip] = ms

    record_ping(ip, alive, ms)   # sparkline history (свой лок внутри)

    if cfg is None:
        cfg = load_tg()

    name  = devices_by_ip.get(ip, {}).get("name", ip)
    is_gw = (ip == POWER_IP)

    if not alive:
        # ── оффлайн ───────────────────────────────────────────────────────────
        if prev is True:
            # Был online → стал offline — генерируем "упал"
            _down_since[ip] = time.time()
            print(f"[events] DOWN  {name} ({ip})")
            add_event("down", ip, name, "Устройство перестало отвечать на пинг")
            if is_gw:
                add_event("power_off", ip, name,
                          "Главный шлюз недоступен — возможно отключение электроэнергии",
                          notify=cfg.get("notify_power", True))
            elif cfg.get("notify_device"):
                thr = cfg.get("down_min", 5) * 60
                def _delayed_alert(ip=ip, name=name, thr=thr):
                    time.sleep(thr)
                    with _cache_lock:
                        still_down = (status_cache.get(ip) is False)
                    if still_down:
                        add_event("down_alert", ip, name,
                                  f"Устройство недоступно более {thr//60} мин",
                                  notify=True)
                threading.Thread(target=_delayed_alert, daemon=True).start()

        elif prev is None:
            # Первый скан — устройство offline, запоминаем время для delta
            _down_since[ip] = time.time()
            print(f"[events] INIT  offline  {name} ({ip})")

        # prev is False → уже оффлайн, ничего не делаем

    else:
        # ── онлайн ────────────────────────────────────────────────────────────
        if prev is False:
            # Был offline → стал online — генерируем "встал"
            down_sec = time.time() - _down_since.pop(ip, time.time())
            mins = int(down_sec // 60)
            detail = f"Снова онлайн (было недоступно {mins} мин)" if mins else "Снова онлайн"
            print(f"[events] UP    {name} ({ip})  down={mins}m")
            add_event("up", ip, name, detail)
            if is_gw:
                add_event("power_on", ip, name,
                          f"Питание восстановлено (отключение {mins} мин)",
                          notify=cfg.get("notify_power", True))

        elif prev is None:
            # Первый скан — устройство online, очищаем возможный стейл
            _down_since.pop(ip, None)
            print(f"[events] INIT  online   {name} ({ip})")

        # prev is True → уже онлайн, ничего не делаем


def _do_monitor_scan(deep=False):
    """
    Сканируем все устройства из базы.
    deep=True  → пинг + порты + MAC + вендор + fingerprint
    deep=False → только пинг (быстро, каждые 60с)
    """
    global last_scan_time
    devices = load_devices()
    if not devices:
        return

    dbip = {d["ip"]: d for d in devices}
    ips  = list(dbip.keys())
    cfg  = load_tg()

    try:
        if deep:
            results = run_async_scan(ips, max_concurrent=60)
            changed = False
            for r in results:
                ip    = r["ip"]
                alive = bool(r.get("alive", False))
                if r.get("mac"):        mac_cache[ip]    = r["mac"]
                if r.get("vendor"):     vendor_cache[ip] = r["vendor"]
                if r.get("model"):      model_cache[ip]  = r["model"]
                if r.get("open_ports"): ports_cache[ip]  = r["open_ports"]
                _on_ping_result(ip, alive, r.get("latency"), dbip, cfg)

            devs = load_devices()
            rm   = {r["ip"]: r for r in results}
            for d in devs:
                r = rm.get(d["ip"])
                if not r:
                    continue
                for fld in ("mac", "vendor", "model"):
                    if r.get(fld) and not d.get(fld):
                        d[fld] = r[fld]
                        changed = True
            if changed:
                save_devices(devs)

        else:
            buf  = []
            lock = threading.Lock()

            async def _ping_all():
                sem = asyncio.Semaphore(50)
                async def _one(ip):
                    async with sem:
                        alive, ms = await async_ping(ip)
                        with lock:
                            buf.append((ip, bool(alive), ms))
                await asyncio.gather(*[_one(ip) for ip in ips])

            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(_ping_all())
            finally:
                loop.close()

            for ip, alive, ms in buf:
                _on_ping_result(ip, alive, ms, dbip, cfg)

    except Exception:
        print("[monitor-scan] unexpected error:")
        traceback.print_exc()

    last_scan_time = time.time()


def background_auto_ping():
    """Бесконечный цикл — быстрый пинг каждые 60 секунд."""
    global auto_ping_running
    auto_ping_running = True
    print("[auto-ping] started")
    while True:
        time.sleep(60)
        try:
            n = len(load_devices())
            print(f"[auto-ping] scanning {n} devices...")
            _do_monitor_scan(deep=False)
            online = sum(1 for v in status_cache.values() if v is True)
            print(f"[auto-ping] done  online={online}/{len(status_cache)}")
        except Exception:
            print("[auto-ping] error:")
            traceback.print_exc()


# ── Auto-discovery ────────────────────────────────────────────────────────────
auto_discovery_state = {
    "last_run": None, "new_count": 0, "new_devices": [],
    "subnets_scanned": [], "running": False
}
auto_subnet_state = {
    "last_run": None, "new_count": 0, "new_subnets": [], "running": False
}


def _run_auto_discovery():
    if auto_discovery_state["running"]:
        return
    auto_discovery_state["running"] = True
    try:
        subnets = [s["prefix"] for s in load_subnets() if s.get("scan")]
        if not subnets:
            return
        reg  = {d["ip"] for d in load_devices()}
        ips  = [f"{s}.{i}" for s in subnets for i in range(1, 255)]
        found_new = []
        lock = threading.Lock()

        def on_result(r):
            if r["alive"] and r["ip"] not in reg:
                with lock:
                    found_new.append(r["ip"])

        run_async_scan(ips, on_result=on_result, max_concurrent=80)
        srt = lambda lst: sorted(lst, key=lambda x: list(map(int, x.split("."))))
        auto_discovery_state.update({
            "last_run": time.time(), "new_count": len(found_new),
            "new_devices": srt(found_new), "subnets_scanned": subnets,
        })
        if found_new:
            print(f"[auto-discovery] {len(found_new)} unregistered: {found_new}")
            cfg = load_tg()
            if cfg.get("notify_new_host"):
                for ip in found_new:
                    add_event("new_host", ip, ip,
                              "Незарегистрированный хост в сети", notify=True)
    except Exception:
        print("[auto-discovery] error:")
        traceback.print_exc()
    finally:
        auto_discovery_state["running"] = False


def _run_auto_subnet_scan():
    if auto_subnet_state["running"]:
        return
    auto_subnet_state["running"] = True
    try:
        reg_prefixes = {s["prefix"] for s in load_subnets()}
        ips = [f"192.168.{x}.1" for x in range(256)]
        alive_xs = []
        lock = threading.Lock()

        def on_result(r):
            if r["alive"]:
                x = int(r["ip"].split(".")[2])
                with lock:
                    alive_xs.append(x)

        run_async_scan(ips, on_result=on_result, max_concurrent=64)
        new_subs = [x for x in alive_xs if f"192.168.{x}" not in reg_prefixes]
        auto_subnet_state.update({
            "last_run": time.time(), "new_count": len(new_subs),
            "new_subnets": sorted(new_subs),
        })
    except Exception:
        print("[auto-subnet] error:")
        traceback.print_exc()
    finally:
        auto_subnet_state["running"] = False


def background_auto_discovery():
    time.sleep(90)
    while True:
        try: _run_auto_discovery()
        except Exception: traceback.print_exc()
        time.sleep(300)


def background_auto_subnet():
    time.sleep(180)
    while True:
        try: _run_auto_subnet_scan()
        except Exception: traceback.print_exc()
        time.sleep(900)


def deep_scan():
    threading.Thread(target=_do_monitor_scan, args=(True,), daemon=True).start()


def quick_scan():
    threading.Thread(target=_do_monitor_scan, args=(False,), daemon=True).start()


# ── Manual discovery ──────────────────────────────────────────────────────────
disc = {
    "running": False, "progress": 0, "total": 0, "done": 0,
    "results": {}, "started_at": None, "finished_at": None, "subnets": []
}


def run_discovery(subnets):
    disc.update({
        "running": True, "progress": 0, "results": {},
        "started_at": time.time(), "finished_at": None,
        "subnets": subnets, "done": 0
    })
    ips = [f"{s}.{i}" for s in subnets for i in range(1, 255)]
    disc["total"] = len(ips)
    lock = threading.Lock()

    def on_result(r):
        with lock:
            disc["results"][r["ip"]] = r["alive"]
            disc["done"] += 1
            disc["progress"] = int(disc["done"] / disc["total"] * 100)

    run_async_scan(ips, on_result=on_result, max_concurrent=80)
    disc["running"] = False
    disc["finished_at"] = time.time()


sn_scan = {
    "running": False, "progress": 0, "total": 256, "done": 0,
    "results": {}, "started_at": None, "finished_at": None
}


def run_subnet_scan():
    sn_scan.update({
        "running": True, "progress": 0, "results": {},
        "started_at": time.time(), "finished_at": None,
        "done": 0, "total": 256
    })
    ips  = [f"192.168.{x}.1" for x in range(256)]
    lock = threading.Lock()

    def on_result(r):
        x = int(r["ip"].split(".")[2])
        with lock:
            sn_scan["results"][x]  = r["alive"]
            sn_scan["done"]       += 1
            sn_scan["progress"]    = int(sn_scan["done"] / 256 * 100)

    run_async_scan(ips, on_result=on_result, max_concurrent=64)
    sn_scan["running"] = False
    sn_scan["finished_at"] = time.time()