"""Flask route definitions."""
import threading
from flask import (Blueprint, jsonify, request, render_template,
                   session, redirect, url_for)
from .storage  import (load_devices, save_devices,
                        load_subnets,  save_subnets,
                        add_device,    update_device,   delete_device,
                        add_subnet,    update_subnet,   delete_subnet,
                        ip_to_prefix,  ensure_subnet_exists)
from .monitor  import (status_cache, latency_cache, mac_cache, vendor_cache,
                        model_cache, ports_cache, last_scan_time,
                        deep_scan, quick_scan,
                        auto_discovery_state, auto_subnet_state,
                        disc, run_discovery, sn_scan, run_subnet_scan)
from .reboot   import reboot_device
from .scanner  import ping_sync
from .events   import (load_events, save_events, add_event,
                       load_tg, save_tg, tg_send, tg_send_to,
                       ping_history, _ph_lock)
from .auth     import login_required, check_credentials, change_credentials, get_username

bp = Blueprint("api", __name__)

# ── Auth routes ───────────────────────────────────────────────────────────────
@bp.route("/login", methods=["GET"])
def login_page():
    if session.get("logged_in"):
        return redirect(url_for("api.index"))
    return render_template("login.html")

@bp.route("/login", methods=["POST"])
def login_post():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    if check_credentials(username, password):
        session["logged_in"] = True
        session["username"]  = username
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Неверный логин или пароль"}), 401

@bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})

@bp.route("/api/auth/me")
def auth_me():
    if session.get("logged_in"):
        return jsonify({"logged_in": True, "username": session.get("username")})
    return jsonify({"logged_in": False}), 401

@bp.route("/api/auth/change", methods=["POST"])
@login_required
def auth_change():
    data = request.json or {}
    new_u = data.get("username", "").strip()
    new_p = data.get("password", "")
    if not new_u or not new_p:
        return jsonify({"error": "Логин и пароль обязательны"}), 400
    change_credentials(new_u, new_p)
    session["username"] = new_u
    return jsonify({"ok": True})

# ── Main page ──────────────────────────────────────────────────────────────────
@bp.route("/")
@login_required
def index(): return render_template("index.html", username=session.get("username",""))

@bp.route("/api/devices")
@login_required
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

@bp.route("/api/scan", methods=["POST"])
@login_required
def trigger_scan():
    """Quick ping scan."""
    quick_scan()
    return jsonify({"status": "scanning"})

@bp.route("/api/deep_scan", methods=["POST"])
@login_required
def trigger_deep_scan():
    """Full scan: ping + ports + vendor + model."""
    deep_scan()
    return jsonify({"status": "deep_scanning"})

@bp.route("/api/scan_host/<ip>")
@login_required
def scan_single_host(ip):
    """Full async scan of a single IP: ping + ports + MAC + vendor + model."""
    import asyncio
    from .scanner import async_scan_host
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(async_scan_host(ip))
    finally:
        loop.close()
    # Update caches
    mac_cache[ip]    = result.get("mac", "")
    vendor_cache[ip] = result.get("vendor", "")
    model_cache[ip]  = result.get("model", "")
    ports_cache[ip]  = result.get("open_ports", [])
    status_cache[ip] = result.get("alive", None)
    latency_cache[ip]= result.get("latency", None)
    return jsonify(result)

@bp.route("/api/ping/<ip>")
@login_required
def ping_single(ip):
    """Single device quick ping — updates cache, history AND fires events."""
    from .monitor import _on_ping_result
    alive, ms = ping_sync(ip)
    # Load device map so _on_ping_result can resolve name
    devices   = load_devices()
    dbip      = {d["ip"]: d for d in devices}
    # This updates cache + history + fires down/up events
    _on_ping_result(ip, alive, ms, dbip)
    return jsonify({"ip": ip, "alive": alive, "latency": ms})

@bp.route("/api/test/event", methods=["POST"])
@login_required
def test_event():
    """
    Dev helper — manually inject a down/up event for testing.
    POST JSON: {"ip": "x.x.x.x", "kind": "down"}   kind = down | up
    """
    from .monitor import _on_ping_result, status_cache as sc
    data = request.json or {}
    ip   = data.get("ip", "")
    kind = data.get("kind", "down")   # "down" or "up"
    if not ip:
        return jsonify({"error": "ip required"}), 400
    devices = load_devices()
    dbip    = {d["ip"]: d for d in devices}
    if kind == "down":
        # Force prev=True so event fires
        sc[ip] = True
        _on_ping_result(ip, False, None, dbip)
    else:
        # Force prev=False so event fires
        sc[ip] = False
        _on_ping_result(ip, True, 1.0, dbip)
    return jsonify({"ok": True, "injected": kind, "ip": ip})

@bp.route("/api/reboot/<int:did>", methods=["POST"])
@login_required
def reboot_device_route(did):
    """Reboot a device using its saved credentials."""
    devices = load_devices()
    device = next((d for d in devices if d["id"] == did), None)
    if not device:
        return jsonify({"ok": False, "detail": "Устройство не найдено"}), 404
    result = reboot_device(device)
    if result.get("ok"):
        add_event("reboot", device["ip"], device.get("name", device["ip"]),
                  f"Перезагрузка: {result.get('method','')}")
    return jsonify(result)

@bp.route("/api/events")
@login_required
def get_events():
    limit = int(request.args.get("limit", 200))
    evs = load_events()
    return jsonify(list(reversed(evs[-limit:])))

@bp.route("/api/events", methods=["DELETE"])
@login_required
def clear_events():
    from .db import _execute as _dbexec
    _dbexec("DELETE FROM events")
    return jsonify({"status": "cleared"})

@bp.route("/api/ping_history/<ip>")
@login_required
def get_ping_history(ip):
    # Return in-memory ring buffer (fast, covers last 2.4h)
    with _ph_lock:
        h = list(ping_history.get(ip, []))
    return jsonify(h)

@bp.route("/api/ping_history/<ip>/db")
@login_required
def get_ping_history_db(ip):
    """Return up to 24h of ping history from SQLite (for dashboard)."""
    hours = int(request.args.get("hours", 24))
    return jsonify(load_ping_history_from_db(ip, hours=hours))

@bp.route("/api/dashboard")
@login_required
def get_dashboard():
    """
    Aggregate data for the dashboard:
    - Per-device: ping history (last 144 points), uptime %, avg/min/max latency
    - Global: timeline of down events for the last 24h
    - Top-5 slowest devices (by avg latency)
    - Top-5 most unstable (by downtime %)
    """
    import time as _t
    devices  = load_devices()
    now      = _t.time()
    day_ago  = now - 86400

    # Load all events for uptime calc
    evs = load_events()

    with _ph_lock:
        ph_snapshot = {ip: list(dq) for ip, dq in ping_history.items()}

    result = {"devices": [], "timeline": [], "top_slow": [], "top_unstable": []}

    for d in devices:
        ip   = d["ip"]
        name = d.get("name", ip)
        hist = ph_snapshot.get(ip, [])

        # Filter to last 24h
        hist24 = [p for p in hist if p["ts"] >= day_ago]

        if not hist24:
            result["devices"].append({
                "ip": ip, "name": name,
                "uptime_pct": None, "avg_ms": None,
                "min_ms": None, "max_ms": None,
                "history": [], "online": status_cache.get(ip, None)
            })
            continue

        total   = len(hist24)
        up_cnt  = sum(1 for p in hist24 if p["alive"])
        latencies = [p["ms"] for p in hist24 if p["alive"] and p["ms"] is not None]

        uptime_pct = round(up_cnt / total * 100, 1) if total else None
        avg_ms     = round(sum(latencies) / len(latencies), 1) if latencies else None
        min_ms     = round(min(latencies), 1) if latencies else None
        max_ms     = round(max(latencies), 1) if latencies else None

        # Downsample history to max 144 points for chart
        result["devices"].append({
            "ip": ip, "name": name,
            "uptime_pct": uptime_pct,
            "avg_ms": avg_ms, "min_ms": min_ms, "max_ms": max_ms,
            "history": [{"ts": p["ts"], "ms": p["ms"], "alive": p["alive"]}
                        for p in hist24],
            "online": status_cache.get(ip, None)
        })

    # Global down events timeline (last 24h, group by hour)
    hour_buckets = [0] * 24
    for ev in evs:
        if ev.get("kind") == "down" and ev["ts"] >= day_ago:
            h = int((now - ev["ts"]) / 3600)
            if 0 <= h < 24:
                hour_buckets[23 - h] += 1
    result["timeline"] = hour_buckets

    # Top-5 slowest
    ranked_lat = sorted(
        [d for d in result["devices"] if d["avg_ms"] is not None],
        key=lambda x: x["avg_ms"], reverse=True
    )[:5]
    result["top_slow"] = [
        {"name": d["name"], "ip": d["ip"], "avg_ms": d["avg_ms"]}
        for d in ranked_lat
    ]

    # Top-5 most unstable (lowest uptime)
    ranked_up = sorted(
        [d for d in result["devices"] if d["uptime_pct"] is not None],
        key=lambda x: x["uptime_pct"]
    )[:5]
    result["top_unstable"] = [
        {"name": d["name"], "ip": d["ip"], "uptime_pct": d["uptime_pct"]}
        for d in ranked_up
    ]

    # Summary stats
    all_up  = [d["uptime_pct"] for d in result["devices"] if d["uptime_pct"] is not None]
    all_lat = [d["avg_ms"]    for d in result["devices"] if d["avg_ms"] is not None]
    result["summary"] = {
        "total":     len(devices),
        "online":    sum(1 for v in status_cache.values() if v is True),
        "offline":   sum(1 for v in status_cache.values() if v is False),
        "avg_uptime_pct": round(sum(all_up) / len(all_up), 1) if all_up else None,
        "avg_latency_ms": round(sum(all_lat) / len(all_lat), 1) if all_lat else None,
    }

    return jsonify(result)


@bp.route("/api/telegram", methods=["GET"])
@login_required
def get_tg():
    cfg = load_tg()
    safe = dict(cfg)
    safe.pop("token", None)   # never expose token in GET
    return jsonify(safe)

@bp.route("/api/telegram", methods=["POST"])
@login_required
def set_tg():
    data = request.json or {}
    cfg = load_tg()
    for k in ("token", "enabled", "notify_power", "notify_device",
              "notify_new_host", "down_min"):
        if k in data: cfg[k] = data[k]
    if "recipients" in data:
        cfg["recipients"] = data["recipients"]
    save_tg(cfg)
    return jsonify({"status": "saved"})

@bp.route("/api/telegram/recipients", methods=["GET"])
@login_required
def get_recipients():
    cfg = load_tg()
    return jsonify(cfg.get("recipients", []))

@bp.route("/api/telegram/recipients", methods=["POST"])
@login_required
def add_recipient():
    """Add a new recipient {chat_id, label}."""
    data = request.json or {}
    chat_id = data.get("chat_id", "").strip()
    label   = data.get("label", chat_id).strip() or chat_id
    if not chat_id:
        return jsonify({"error": "chat_id required"}), 400
    cfg = load_tg()
    recipients = cfg.get("recipients", [])
    if any(r["chat_id"] == chat_id for r in recipients):
        return jsonify({"error": "already exists"}), 409
    recipients.append({"chat_id": chat_id, "label": label, "active": True})
    cfg["recipients"] = recipients
    save_tg(cfg)
    return jsonify({"ok": True, "recipients": recipients})

@bp.route("/api/telegram/recipients/<chat_id>", methods=["PUT"])
@login_required
def update_recipient(chat_id):
    data = request.json or {}
    cfg = load_tg()
    for r in cfg.get("recipients", []):
        if r["chat_id"] == chat_id:
            if "label"  in data: r["label"]  = data["label"]
            if "active" in data: r["active"] = data["active"]
            save_tg(cfg)
            return jsonify(r)
    return jsonify({"error": "not found"}), 404

@bp.route("/api/telegram/recipients/<chat_id>", methods=["DELETE"])
@login_required
def delete_recipient(chat_id):
    cfg = load_tg()
    cfg["recipients"] = [r for r in cfg.get("recipients", [])
                         if r["chat_id"] != chat_id]
    save_tg(cfg)
    return jsonify({"ok": True})

@bp.route("/api/telegram/test", methods=["POST"])
@login_required
def test_tg():
    """Test — send to all, or to specific chat_id if provided."""
    data = request.json or {}
    chat_id = data.get("chat_id", "").strip()
    msg = "✅ <b>NetWatch</b>\nТестовое уведомление — Telegram настроен правильно!"
    if chat_id:
        ok = tg_send_to(msg, chat_id)
        return jsonify({"status": "sent" if ok else "error"})
    threading.Thread(target=tg_send, args=(msg,), daemon=True).start()
    return jsonify({"status": "sent"})

@bp.route("/api/devices", methods=["POST"])
@login_required
def add_device_route():
    data = request.json or {}
    if not data.get("ip"):
        return jsonify({"error": "ip required"}), 400
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in data.items()}
    from .storage import add_device as _add
    device = _add(data)
    device["has_creds"] = bool(device.get("cred_login"))
    return jsonify(device), 201

@bp.route("/api/devices/<int:did>", methods=["PUT"])
@login_required
def update_device_route(did):
    data = request.json or {}
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in data.items()}
    from .storage import update_device as _upd
    device = _upd(did, data)
    if not device:
        return jsonify({"error": "not found"}), 404
    device["has_creds"] = bool(device.get("cred_login"))
    return jsonify(device)

@bp.route("/api/devices/<int:did>", methods=["DELETE"])
@login_required
def delete_device_route(did):
    from .storage import delete_device as _del
    _del(did)
    return jsonify({"status": "deleted"})

@bp.route("/api/subnets")
@login_required
def get_subnets():
    subnets = load_subnets(); devices = load_devices()
    for s in subnets:
        s["device_count"] = sum(1 for d in devices if ip_to_prefix(d["ip"]) == s["prefix"])
    return jsonify(subnets)

@bp.route("/api/subnets", methods=["POST"])
@login_required
def add_subnet_route():
    data = request.json or {}
    raw = data.get("prefix", "").strip()
    if "/" in raw: raw = ".".join(raw.split("/")[0].split(".")[:3])
    prefix = raw
    if not prefix or len(prefix.split(".")) != 3:
        return jsonify({"error": "invalid prefix"}), 400
    from .storage import add_subnet as _add_sn
    existing = load_subnets()
    if any(s["prefix"] == prefix for s in existing):
        return jsonify({"error": "already exists"}), 409
    entry = _add_sn(prefix, data.get("label", f"{prefix}.0/24"), bool(data.get("scan", True)))
    return jsonify(entry)

@bp.route("/api/subnets/<path:prefix>", methods=["PUT"])
@login_required
def update_subnet_route(prefix):
    from .storage import update_subnet as _upd_sn
    result = _upd_sn(prefix, {k: v for k, v in (request.json or {}).items()
                               if k in ("label", "scan")})
    if not result: return jsonify({"error": "not found"}), 404
    return jsonify(result)

@bp.route("/api/subnets/<path:prefix>", methods=["DELETE"])
@login_required
def delete_subnet_route(prefix):
    from .storage import delete_subnet as _del_sn
    _del_sn(prefix)
    return jsonify({"status": "deleted"})

@bp.route("/api/discovery/start", methods=["POST"])
@login_required
def start_discovery():
    if disc["running"]: return jsonify({"error": "already running"}), 400
    data = request.json or {}
    subnets = data.get("subnets") or [s["prefix"] for s in load_subnets() if s.get("scan")]
    threading.Thread(target=run_discovery, args=(subnets,), daemon=True).start()
    return jsonify({"status": "started"})

@bp.route("/api/discovery/status")
@login_required
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

@bp.route("/api/subnet_scan/start", methods=["POST"])
@login_required
def start_subnet_scan():
    if sn_scan["running"]: return jsonify({"error": "already running"}), 400
    threading.Thread(target=run_subnet_scan, daemon=True).start()
    return jsonify({"status": "started"})

@bp.route("/api/auto_scan/status")
@login_required
def auto_scan_status():
    """Returns auto-discovery + auto-subnet state for the dashboard panel."""
    return jsonify({"discovery": auto_discovery_state, "subnet": auto_subnet_state})

@bp.route("/api/subnet_scan/status")
@login_required
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

# ── Traceroute ────────────────────────────────────────────────────────────────
import subprocess, re as _re

@bp.route("/api/traceroute/<ip>")
@login_required
def traceroute(ip):
    """Run traceroute to target IP, return list of hops enriched with device data."""
    if not _re.match(r'^[\d.]+$', ip):
        return jsonify({"error": "invalid ip"}), 400

    devices = load_devices()
    dev_map  = {d["ip"]: d for d in devices}

    def enrich(hop_ip, hop_num, ms):
        dev = dev_map.get(hop_ip)
        return {
            "hop":    hop_num,
            "ip":     hop_ip,
            "ms":     ms,
            "name":   dev["name"]            if dev else "",
            "vendor": dev.get("vendor", "")  if dev else "",
            "model":  dev.get("model",  "")  if dev else "",
            "type":   dev.get("type",   "")  if dev else "",
            "known":  bool(dev),
            "online": status_cache.get(hop_ip, None) if dev else None,
        }

    # Hop 0 — the NetWatch server itself (local interface toward target)
    import socket as _sock
    try:
        local_ip = _sock.gethostbyname(_sock.gethostname())
    except Exception:
        local_ip = "127.0.0.1"
    hops = [enrich(local_ip, 0, 0)]

    try:
        result = subprocess.run(
            ["traceroute", "-n", "-m", "20", "-w", "1", "-q", "2", ip],
            capture_output=True, text=True, timeout=35
        )
        lines = result.stdout.strip().split("\n")
        for line in lines[1:]:
            # Match line with at least one timing: "  1  192.168.1.1  1.234 ms"
            m = _re.match(r'\s*(\d+)\s+(\S+)\s+([\d.]+)\s*ms', line)
            if m:
                hop_num = int(m.group(1))
                hop_ip  = m.group(2)
                # Average multiple probes if present
                times = [float(x) for x in _re.findall(r'([\d.]+)\s*ms', line)]
                ms = round(sum(times) / len(times), 3) if times else float(m.group(3))
                hops.append(enrich(hop_ip, hop_num, ms))
            else:
                m2 = _re.match(r'\s*(\d+)\s+\*', line)
                if m2:
                    hops.append({"hop": int(m2.group(1)), "ip": "*", "ms": None,
                                 "name": "", "vendor": "", "model": "", "type": "",
                                 "known": False, "online": None})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout", "hops": hops, "target": ip})
    except FileNotFoundError:
        return jsonify({"error": "traceroute_not_found", "hops": hops, "target": ip})
    except Exception as e:
        return jsonify({"error": str(e), "hops": hops, "target": ip})

    return jsonify({"hops": hops, "target": ip, "source": local_ip})

# ── Topology ──────────────────────────────────────────────────────────────────
from .monitor import status_cache, latency_cache

@bp.route("/api/topology")
@login_required
def get_topology():
    """Build network topology: nodes, smart edges, subnet zones."""
    devices  = load_devices()
    subnets  = load_subnets()
    ip_set   = {d["ip"] for d in devices}
    dev_map  = {d["ip"]: d for d in devices}

    # ── Nodes ─────────────────────────────────────────────────────────────────
    nodes = []
    for d in devices:
        pfx = ".".join(d["ip"].split(".")[:3])
        nodes.append({
            "id":      d["ip"],
            "name":    d.get("name", d["ip"]),
            "type":    d.get("type", "client"),
            "vendor":  d.get("vendor", ""),
            "model":   d.get("model", ""),
            "ip":      d["ip"],
            "online":  status_cache.get(d["ip"], None),
            "latency": latency_cache.get(d["ip"], None),
            "subnet":  pfx,
        })

    # ── Group devices by subnet prefix ────────────────────────────────────────
    subnet_devs = {}   # prefix → [ip, ...]
    for d in devices:
        pfx = ".".join(d["ip"].split(".")[:3])
        subnet_devs.setdefault(pfx, []).append(d["ip"])

    # ── Find gateway for each subnet ──────────────────────────────────────────
    # Priority: device with type=router at .1, else any router, else .1 if exists, else lowest IP
    def find_gw(pfx, ips):
        # 1. router/ap at .1
        cand = pfx + ".1"
        if cand in ip_set and dev_map[cand].get("type") in ("router","ap",""):
            return cand
        # 2. any router in subnet
        for ip in sorted(ips):
            if dev_map.get(ip, {}).get("type") in ("router", "ap"):
                return ip
        # 3. .1 even if not router type
        if cand in ip_set:
            return cand
        # 4. lowest IP
        return sorted(ips, key=lambda x: list(map(int, x.split("."))))[0] if ips else None

    subnet_gw = {pfx: find_gw(pfx, ips) for pfx, ips in subnet_devs.items()}

    # ── Build edges ───────────────────────────────────────────────────────────
    edges = []
    edge_set = set()

    def add_edge(src, tgt, etype):
        key = (min(src,tgt), max(src,tgt))
        if key not in edge_set and src in ip_set and tgt in ip_set:
            edge_set.add(key)
            edges.append({"source": src, "target": tgt, "type": etype})

    # 1. Each device → its subnet gateway (star topology within subnet)
    for pfx, ips in subnet_devs.items():
        gw = subnet_gw.get(pfx)
        if not gw: continue
        for ip in ips:
            if ip != gw:
                add_edge(gw, ip, "subnet")

    # 2. Gateway ↔ gateway backbone links
    # Heuristic: gateways in different /24 subnets on the same /16 are likely connected
    # Connect each gateway to the "most likely upstream" router:
    # - routers connect to other routers in different /16 or different /24 that have fewer devices
    gws = [(pfx, gw) for pfx, gw in subnet_gw.items() if gw]
    routers = [(pfx, gw) for pfx, gw in gws
               if dev_map.get(gw, {}).get("type") in ("router", "ap", "")]

    # Build a spanning tree of gateways: each gateway connects to the gateway
    # in the most "different" subnet (different third octet) that has type=router
    # Simple approach: sort gateways by subnet, chain them with backbone links
    gw_ips = sorted(set(gw for _, gw in gws), key=lambda x: list(map(int, x.split("."))))

    # Find cross-subnet router pairs
    def third_octet(ip): return int(ip.split(".")[2])

    # Group gateways by second octet (192.168.X → group by X)
    by_second = {}
    for gw in gw_ips:
        parts = gw.split(".")
        if len(parts) == 4:
            key = (parts[0], parts[1])
            by_second.setdefault(key, []).append(gw)

    # Within each /16 group: connect gateways in a tree
    for group_gws in by_second.values():
        sorted_gws = sorted(group_gws, key=lambda x: list(map(int, x.split("."))))
        # Find routers first
        group_routers = [gw for gw in sorted_gws
                         if dev_map.get(gw, {}).get("type") in ("router", "ap")]
        group_others  = [gw for gw in sorted_gws if gw not in group_routers]

        # Connect routers in a chain
        for i in range(len(group_routers) - 1):
            add_edge(group_routers[i], group_routers[i+1], "backbone")

        # Connect non-router gateways to nearest router
        if group_routers:
            for gw in group_others:
                # nearest router by IP distance
                nearest = min(group_routers,
                    key=lambda r: abs(list(map(int,r.split(".")))[-1] -
                                     list(map(int,gw.split(".")))[-1]))
                add_edge(nearest, gw, "backbone")

    # 3. Cross-/16 backbone (e.g. 192.168.83.x ↔ 192.168.88.x)
    group_keys = sorted(by_second.keys())
    group_reps = []
    for k in group_keys:
        gws_in_group = by_second[k]
        rep = next((gw for gw in sorted(gws_in_group)
                    if dev_map.get(gw,{}).get("type") in ("router","ap")), gws_in_group[0])
        group_reps.append(rep)
    for i in range(len(group_reps) - 1):
        add_edge(group_reps[i], group_reps[i+1], "wan")

    # ── Subnet zone metadata for frontend ────────────────────────────────────
    subnet_info = []
    for s in subnets:
        pfx = s["prefix"]
        gw  = subnet_gw.get(pfx)
        cnt = len(subnet_devs.get(pfx, []))
        subnet_info.append({
            "prefix":  pfx,
            "label":   s.get("label", pfx + ".0/24"),
            "gateway": gw,
            "count":   cnt,
        })

    return jsonify({
        "nodes":   nodes,
        "edges":   edges,
        "subnets": subnet_info,
    })

# ── SNMP Stats endpoint ───────────────────────────────────────────────────────
from .oui import grab_snmp_stats

@bp.route("/api/snmp/<ip>")
@login_required
def snmp_stats(ip):
    """Poll full SNMP stats for a single device."""
    import re as _re2, time as _time
    if not _re2.match(r'^[\d.]+$', ip):
        return jsonify({"error": "invalid ip"}), 400
    community = request.args.get("community", "public")
    result = grab_snmp_stats(ip, community=community)
    return jsonify(result)

@bp.route("/api/snmp/<ip>/traffic")
@login_required
def snmp_traffic(ip):
    """Two SNMP polls 2s apart → compute live bps per interface."""
    import re as _re2, time as _time
    from .oui import (IF_IN_OCT_BASE, IF_OUT_OCT_BASE, IF_IN_UCAST_BASE,
                      IF_OUT_UCAST_BASE, _mk_get_multi, _dec)
    if not _re2.match(r'^[\d.]+$', ip):
        return jsonify({"error": "invalid ip"}), 400
    community = request.args.get("community", "public")

    # Build OID list for up to 32 interfaces
    MAX_IF = 32
    oids = []
    for i in range(1, MAX_IF + 1):
        for base in (IF_IN_OCT_BASE, IF_OUT_OCT_BASE,
                     IF_IN_UCAST_BASE, IF_OUT_UCAST_BASE):
            oids.append(f"{base}.{i}")

    # Poll 1
    t1 = _time.time()
    raw1 = _mk_get_multi(ip, oids, community, timeout=2.0)
    if not raw1:
        return jsonify({"error": "no response"})

    _time.sleep(2.0)  # interval

    # Poll 2
    t2 = _time.time()
    raw2 = _mk_get_multi(ip, oids, community, timeout=2.0)
    if not raw2:
        return jsonify({"error": "no response poll2"})

    dt = t2 - t1
    traffic = {}

    for i in range(1, MAX_IF + 1):
        in_oid  = f"{IF_IN_OCT_BASE}.{i}"
        out_oid = f"{IF_OUT_OCT_BASE}.{i}"
        inp_oid = f"{IF_IN_UCAST_BASE}.{i}"
        outp_oid= f"{IF_OUT_UCAST_BASE}.{i}"

        def val(raw, oid):
            v = raw.get(oid)
            return _dec(v[0], v[1]) if v else None

        in1  = val(raw1, in_oid);  in2  = val(raw2, in_oid)
        out1 = val(raw1, out_oid); out2 = val(raw2, out_oid)
        inp1 = val(raw1, inp_oid); inp2 = val(raw2, inp_oid)
        outp1= val(raw1, outp_oid);outp2= val(raw2, outp_oid)

        if in1 is None and out1 is None:
            continue

        def bps(a, b):
            if a is None or b is None: return None
            diff = b - a
            if diff < 0: diff += 2**32  # counter wrap
            return round(diff * 8 / dt)

        def pps(a, b):
            if a is None or b is None: return None
            diff = b - a
            if diff < 0: diff += 2**32
            return round(diff / dt, 1)

        traffic[i] = {
            "rx_bps":  bps(in1, in2),
            "tx_bps":  bps(out1, out2),
            "rx_pps":  pps(inp1, inp2),
            "tx_pps":  pps(outp1, outp2),
        }

    return jsonify({"traffic": traffic, "interval": round(dt, 2)})

@bp.route("/api/snmp/<ip>/debug")
@login_required
def snmp_debug(ip):
    """Raw SNMP debug — show first 20 OIDs returned for ifDescr walk."""
    import re as _re3
    if not _re3.match(r'^[\d.]+$', ip):
        return jsonify({"error": "invalid ip"}), 400
    from .oui import _snmp_batch, _dec_val, IF_DESCR_BASE
    community = request.args.get("community", "public")
    oids = [f"{IF_DESCR_BASE}.{i}" for i in range(1, 21)]
    raw = _snmp_batch(ip, oids, community, timeout=3.0, batch_size=10)
    out = {}
    for oid, (vtype, rawbytes) in raw.items():
        out[oid] = {"type": hex(vtype), "value": _dec_val(vtype, rawbytes), "hex": rawbytes.hex()}
    return jsonify({"oids_returned": len(raw), "data": out})