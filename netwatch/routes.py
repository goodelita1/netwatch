from html import escape as _esc
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
                        deep_scan, quick_scan, _on_ping_result,
                        auto_discovery_state, auto_subnet_state,
                        disc, run_discovery, sn_scan, run_subnet_scan)
from .reboot   import reboot_device
from .scanner  import ping_sync
from .events   import (load_events, save_events, add_event, add_audit,
                       load_audit, record_ping, load_ping_history_from_db,
                       ping_history, _ph_lock,
                       load_tg, save_tg, tg_send, tg_send_to,
                       load_discord, save_discord, discord_send_test,
                       load_email_cfg, save_email_cfg, email_send_test,
                       load_webhook_cfg, save_webhook_cfg, webhook_send_test)
from .auth     import (login_required, check_credentials, change_credentials,
                        get_username, totp_is_enabled, totp_verify,
                        totp_get_secret, totp_enable, totp_disable,
                        totp_generate_secret, totp_provisioning_uri)

import collections as _coll, time as _time_mod
_login_attempts: dict = {}   # ip → deque[ts]
_LOGIN_MAX    = 5
_LOGIN_WINDOW = 300   # 5 min
_LOGIN_BLOCK  = 900   # 15 min

def _check_rate_limit(ip: str) -> bool:
    now = _time_mod.time()
    q   = _login_attempts.setdefault(ip, _coll.deque())
    while q and now - q[0] > _LOGIN_BLOCK: q.popleft()
    if sum(1 for t in q if now - t < _LOGIN_WINDOW) >= _LOGIN_MAX:
        return False
    q.append(now)
    return True

bp = Blueprint("api", __name__)

# ── Auth routes ───────────────────────────────────────────────────────────────
@bp.route("/login", methods=["GET"])
def login_page():
    if session.get("logged_in"):
        return redirect(url_for("api.index"))
    return render_template("login.html")

@bp.route("/login", methods=["POST"])
def login_post():
    client_ip = request.remote_addr or "?"
    data      = request.get_json(silent=True) or {}
    username  = data.get("username", "").strip()
    password  = data.get("password", "")
    totp_code = data.get("totp_code", "").strip()

    # ── Step 2: TOTP verification (password already passed) ──
    if session.get("awaiting_2fa") and session.get("pre2fa_user") == username:
        secret = totp_get_secret()
        if totp_verify(secret, totp_code):
            session.pop("awaiting_2fa", None)
            session.pop("pre2fa_user", None)
            session["logged_in"] = True
            session["username"]  = username
            add_audit("login_ok_2fa", username, client_ip)
            return jsonify({"ok": True})
        else:
            add_audit("login_fail_2fa", username, client_ip, "bad TOTP")
            return jsonify({"ok": False, "error": "Неверный код 2FA", "need_2fa": True}), 401

    # ── Step 1: password check ────────────────────────────────
    if not _check_rate_limit(client_ip):
        add_audit("login_blocked", username, client_ip, "rate limit")
        return jsonify({"ok": False,
                        "error": "Занадто багато спроб. Зачекайте 15 хвилин."}), 429
    if not check_credentials(username, password):
        add_audit("login_fail", username, client_ip, "bad credentials")
        return jsonify({"ok": False, "error": "Невірний логін або пароль"}), 401

    # Password OK — regenerate session to prevent session fixation
    old_data = dict(session)
    session.clear()
    session.update(old_data)

    # Check if 2FA required
    if totp_is_enabled():
        session["awaiting_2fa"] = True
        session["pre2fa_user"]  = username
        return jsonify({"ok": False, "need_2fa": True,
                        "message": "Введите код из приложения аутентификатора"})

    # No 2FA — login complete
    session["logged_in"] = True
    session["username"]  = username
    add_audit("login_ok", username, client_ip)
    return jsonify({"ok": True})

@bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})

@bp.route("/api/auth/me")
def auth_me():
    if session.get("logged_in"):
        return jsonify({"logged_in": True, "username": session.get("username")})
    return jsonify({"logged_in": False}), 401

@bp.route("/api/ws-token")
@login_required
def get_ws_token():
    """Issue a short-lived token for WebSocket auth (5 min TTL)."""
    from .socket_handlers import generate_ws_token
    token = generate_ws_token(session.get("username", ""))
    return jsonify({"token": token})

@bp.route("/api/auth/change", methods=["POST"])
@login_required
def auth_change():
    data  = request.json or {}
    new_u = data.get("username", "").strip()
    new_p = data.get("password", "")
    if not new_u or not new_p:
        return jsonify({"error": "Логін та пароль обов'язкові"}), 400
    change_credentials(new_u, new_p)
    session["username"] = new_u
    add_audit("credentials_changed", new_u, request.remote_addr or "")
    return jsonify({"ok": True})


# ── 2FA management ────────────────────────────────────────────────────────────

@bp.route("/api/2fa/status")
@login_required
def fa2_status():
    return jsonify({"enabled": totp_is_enabled()})


@bp.route("/api/2fa/setup", methods=["POST"])
@login_required
def fa2_setup():
    """Generate new TOTP secret, store pending in session.
    2FA is NOT active until /api/2fa/confirm called with valid code."""
    secret   = totp_generate_secret()
    session["pending_totp"] = secret
    username = session.get("username", "admin")
    uri      = totp_provisioning_uri(secret, username)
    return jsonify({"secret": secret, "uri": uri, "username": username})


@bp.route("/api/2fa/confirm", methods=["POST"])
@login_required
def fa2_confirm():
    """Verify TOTP code against pending secret → activate 2FA."""
    code   = (request.json or {}).get("code", "").strip()
    secret = session.get("pending_totp", "")
    if not secret:
        return jsonify({"ok": False, "error": "Спочатку запустіть налаштування 2FA"}), 400
    if not totp_verify(secret, code):
        return jsonify({"ok": False, "error": "Невірний код — додаток не синхронізований"}), 400
    totp_enable(secret)
    session.pop("pending_totp", None)
    add_audit("2fa_enabled", session.get("username", ""), request.remote_addr or "")
    return jsonify({"ok": True})


@bp.route("/api/2fa/disable", methods=["POST"])
@login_required
def fa2_disable():
    """Disable 2FA — requires current TOTP code as confirmation."""
    code = (request.json or {}).get("code", "").strip()
    if totp_is_enabled() and not totp_verify(totp_get_secret(), code):
        return jsonify({"ok": False,
                        "error": "Введіть поточний код 2FA для відключення"}), 400
    totp_disable()
    add_audit("2fa_disabled", session.get("username", ""), request.remote_addr or "")
    return jsonify({"ok": True})

# ── Main page ──────────────────────────────────────────────────────────────────
@bp.route("/")
@login_required
def index(): return render_template("index.html", username=session.get("username",""))

@bp.route("/static/sw.js")
def service_worker():
    """Serve SW with correct headers — must be at root scope."""
    from flask import send_from_directory, current_app
    resp = send_from_directory(
        current_app.static_folder, "sw.js",
        mimetype="application/javascript"
    )
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp

@bp.route("/static/manifest.json")
def pwa_manifest():
    from flask import send_from_directory, current_app
    resp = send_from_directory(
        current_app.static_folder, "manifest.json",
        mimetype="application/manifest+json"
    )
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp

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
    # Update caches via _on_ping_result so events fire correctly
    mac_cache[ip]    = result.get("mac", "")
    vendor_cache[ip] = result.get("vendor", "")
    model_cache[ip]  = result.get("model", "")
    ports_cache[ip]  = result.get("open_ports", [])
    devices = load_devices()
    dbip    = {d["ip"]: d for d in devices}
    _on_ping_result(ip, bool(result.get("alive", False)),
                    result.get("latency"), dbip)
    return jsonify(result)

@bp.route("/api/ping/<ip>")
@login_required
def ping_single(ip):
    """Single device quick ping — updates cache, history AND fires events."""
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
    sc = status_cache  # alias for test_event
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
                  f"Перезавантаження: {result.get('method','')}")
        add_audit("reboot", session.get("username","?"), request.remote_addr or "",
                  f"{device.get('name', device['ip'])} ({device['ip']})")
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
            "online": status_cache.get(ip, None)   # read-only, GIL protects scalar reads
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


# ── Discord ──────────────────────────────────────────────────────────────────
@bp.route("/api/discord", methods=["GET"])
@login_required
def get_discord():
    cfg = load_discord(); cfg.pop("webhook_url", None); return jsonify(cfg)

@bp.route("/api/discord", methods=["POST"])
@login_required
def set_discord():
    data = request.json or {}
    cfg  = load_discord()
    for k in ("webhook_url","enabled","notify_power","notify_device","notify_new_host"):
        if k in data: cfg[k] = data[k]
    save_discord(cfg)
    return jsonify({"ok": True})

@bp.route("/api/discord/test", methods=["POST"])
@login_required
def test_discord():
    ok = discord_send_test()
    return jsonify({"ok": ok})

# ── Email ─────────────────────────────────────────────────────────────────────
@bp.route("/api/email", methods=["GET"])
@login_required
def get_email():
    cfg = load_email_cfg()
    safe = dict(cfg); safe["smtp_password"] = "••••" if safe.get("smtp_password") else ""
    return jsonify(safe)

@bp.route("/api/email", methods=["POST"])
@login_required
def set_email():
    data = request.json or {}
    cfg  = load_email_cfg()
    for k in ("smtp_host","smtp_port","smtp_user","smtp_password","smtp_from",
              "smtp_to","use_tls","enabled","notify_power","notify_device","notify_new_host"):
        if k in data: cfg[k] = data[k]
    # Don't overwrite password if placeholder sent
    if data.get("smtp_password") == "••••":
        data.pop("smtp_password", None)
    save_email_cfg(cfg)
    return jsonify({"ok": True})

@bp.route("/api/email/test", methods=["POST"])
@login_required
def test_email():
    ok = email_send_test()
    return jsonify({"ok": ok})

# ── Generic Webhook ───────────────────────────────────────────────────────────
@bp.route("/api/webhook", methods=["GET"])
@login_required
def get_webhook():
    return jsonify(load_webhook_cfg())

@bp.route("/api/webhook", methods=["POST"])
@login_required
def set_webhook():
    data = request.json or {}
    cfg  = load_webhook_cfg()
    for k in ("url","enabled","notify_power","notify_device","notify_new_host"):
        if k in data: cfg[k] = data[k]
    save_webhook_cfg(cfg)
    return jsonify({"ok": True})

@bp.route("/api/webhook/test", methods=["POST"])
@login_required
def test_webhook():
    ok = webhook_send_test()
    return jsonify({"ok": ok})

# ── Audit log ─────────────────────────────────────────────────────────────────
@bp.route("/api/audit")
@login_required
def get_audit():
    limit = int(request.args.get("limit", 200))
    return jsonify(load_audit(limit))

# ── CSV export ────────────────────────────────────────────────────────────────
@bp.route("/api/export/devices.csv")
@login_required
def export_devices_csv():
    import csv, io
    devices = load_devices()
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=[
        "id","ip","name","location","type","mac","vendor","model"
    ])
    w.writeheader()
    for d in devices:
        w.writerow({k: d.get(k,"") for k in w.fieldnames})
    from flask import Response
    return Response(
        "﻿" + out.getvalue(),   # BOM for Excel
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=devices.csv"}
    )

@bp.route("/api/export/events.csv")
@login_required
def export_events_csv():
    import csv, io
    from datetime import datetime
    evs = load_events(limit=5000)
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=["datetime","kind","ip","name","detail"])
    w.writeheader()
    for e in reversed(evs):
        e2 = dict(e)
        e2["datetime"] = datetime.fromtimestamp(e2.pop("ts")).strftime("%Y-%m-%d %H:%M:%S")
        w.writerow({k: e2.get(k,"") for k in w.fieldnames})
    from flask import Response
    return Response(
        "﻿" + out.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=events.csv"}
    )

# ── SLA / uptime analytics ────────────────────────────────────────────────────

@bp.route("/api/sla")
@login_required
def get_sla():
    """
    Aggregate uptime % + avg latency for each device over multiple periods.
    Returns per-device SLA for: 1d, 7d, 30d  (from ping_history table).
    Also returns trend: compare last 7d vs prev 7d → up/down/stable.
    """
    import time as _t
    from .db import _execute as _db, get_conn
    devices  = load_devices()
    now      = _t.time()
    periods  = {"1d": 86400, "7d": 604800, "30d": 2592000}
    result   = []

    for d in devices:
        ip   = d["ip"]
        name = d.get("name", ip)
        row  = {"ip": ip, "name": name, "type": d.get("type","client"),
                "online": status_cache.get(ip)}
        for label, secs in periods.items():
            since = now - secs
            try:
                r = _db(
                    "SELECT COUNT(*) as total, SUM(alive) as up_cnt, "
                    "AVG(CASE WHEN alive=1 AND ms IS NOT NULL THEN ms END) as avg_ms "
                    "FROM ping_history WHERE ip=? AND ts>=?",
                    (ip, since), fetch="one"
                )
                total   = r["total"] or 0
                up_cnt  = int(r["up_cnt"] or 0)
                avg_ms  = round(r["avg_ms"], 1) if r["avg_ms"] else None
                uptime  = round(up_cnt / total * 100, 2) if total > 0 else None
            except Exception:
                total = up_cnt = 0; avg_ms = None; uptime = None

            row[label] = {"uptime": uptime, "avg_ms": avg_ms, "samples": total}

        # Trend: last 7d vs previous 7d
        try:
            cur_up  = row["7d"]["uptime"]
            prev_r  = _db(
                "SELECT COUNT(*) as total, SUM(alive) as up_cnt "
                "FROM ping_history WHERE ip=? AND ts>=? AND ts<?",
                (ip, now - 1209600, now - 604800), fetch="one"
            )
            p_total = prev_r["total"] or 0
            p_up    = int(prev_r["up_cnt"] or 0)
            prev_up = round(p_up / p_total * 100, 2) if p_total > 0 else None
            if cur_up is None or prev_up is None:
                row["trend"] = "new"
            elif cur_up > prev_up + 0.5:
                row["trend"] = "up"
            elif cur_up < prev_up - 0.5:
                row["trend"] = "down"
            else:
                row["trend"] = "stable"
            row["prev_7d_uptime"] = prev_up
        except Exception:
            row["trend"] = "new"
            row["prev_7d_uptime"] = None

        # Incident count (down events) for 30d
        try:
            inc_r = _db(
                "SELECT COUNT(*) as cnt FROM events "
                "WHERE ip=? AND kind='down' AND ts>=?",
                (ip, now - 2592000), fetch="one"
            )
            row["incidents_30d"] = inc_r["cnt"] if inc_r else 0
        except Exception:
            row["incidents_30d"] = 0

        result.append(row)

    # Sort: worst uptime first (30d)
    result.sort(key=lambda x: (x["30d"]["uptime"] or 101))
    return jsonify(result)


# ── PDF / Print Report ─────────────────────────────────────────────────────────

@bp.route("/api/report/html")
@login_required
def get_report_html():
    """
    Generate a print-ready HTML report (SLA + events).
    period: 7d | 30d (query param)
    Browser opens this in new tab → Ctrl+P / Cmd+P to print/save as PDF.
    """
    import time as _t
    from datetime import datetime
    from .db import _execute as _db

    period_label = request.args.get("period", "7d")
    period_secs  = 604800 if period_label == "7d" else 2592000
    devices      = load_devices()
    now          = _t.time()
    since        = now - period_secs

    # Build SLA table
    rows = []
    for d in devices:
        ip = d["ip"]
        try:
            r = _db(
                "SELECT COUNT(*) as total, SUM(alive) as up_cnt, "
                "AVG(CASE WHEN alive=1 AND ms IS NOT NULL THEN ms END) as avg_ms "
                "FROM ping_history WHERE ip=? AND ts>=?",
                (ip, since), fetch="one"
            )
            total  = r["total"] or 0
            up_cnt = int(r["up_cnt"] or 0)
            uptime = round(up_cnt / total * 100, 2) if total > 0 else None
            avg_ms = round(r["avg_ms"], 1) if r["avg_ms"] else None
        except Exception:
            total = up_cnt = 0; uptime = None; avg_ms = None

        inc_r = _db(
            "SELECT COUNT(*) as cnt FROM events WHERE ip=? AND kind='down' AND ts>=?",
            (ip, since), fetch="one"
        )
        incidents = inc_r["cnt"] if inc_r else 0
        rows.append({
            "ip":       ip,
            "name":     d.get("name", ip),
            "type":     d.get("type", "—"),
            "location": d.get("location", ""),
            "uptime":   uptime,
            "avg_ms":   avg_ms,
            "samples":  total,
            "incidents":incidents,
            "online":   status_cache.get(ip),
        })
    rows.sort(key=lambda x: (x["uptime"] or 101))

    # Events for period
    evs_r = _db(
        "SELECT ts, kind, ip, name, detail FROM events WHERE ts>=? ORDER BY ts DESC LIMIT 500",
        (since,), fetch="all"
    )
    events = [dict(e) for e in evs_r] if evs_r else []

    period_name = "7 дней" if period_label == "7d" else "30 дней"
    generated   = datetime.now().strftime("%d.%m.%Y %H:%M")
    online_cnt  = sum(1 for v in status_cache.values() if v is True)
    offline_cnt = sum(1 for v in status_cache.values() if v is False)

    def uptime_color(u):
        if u is None:    return "#888"
        if u >= 99:      return "#00c853"
        if u >= 95:      return "#ffab00"
        if u >= 80:      return "#ff6d00"
        return "#d50000"

    def ev_icon(kind):
        return {"down":"🔴","up":"🟢","power_off":"⚡","power_on":"⚡",
                "reboot":"🔄","new_host":"🆕","down_alert":"⚠️"}.get(kind,"ℹ️")

    # Build HTML
    rows_html = ""
    for r in rows:
        u     = r["uptime"]
        col   = uptime_color(u)
        u_str = f"{u}%" if u is not None else "—"
        bar   = f'<div style="width:{u or 0}%;height:6px;background:{col};border-radius:3px"></div>' if u else ""
        rows_html += f"""
        <tr>
          <td>{_esc(r["name"])}</td>
          <td style="font-family:monospace;font-size:11px">{r["ip"]}</td>
          <td>{r["type"]}</td>
          <td>{_esc(r["location"]) if r["location"] else "—"}</td>
          <td style="text-align:center">
            <span style="color:{col};font-weight:700">{u_str}</span>
            <div style="background:#e0e0e0;border-radius:3px;margin-top:3px">{bar}</div>
          </td>
          <td style="text-align:center">{str(r["avg_ms"])+" мс" if r["avg_ms"] else "—"}</td>
          <td style="text-align:center">{r["incidents"]}</td>
          <td style="text-align:center">{r["samples"]}</td>
        </tr>"""

    evs_html = ""
    for e in events[:200]:
        dt  = datetime.fromtimestamp(e["ts"]).strftime("%d.%m %H:%M")
        evs_html += f"""
        <tr>
          <td style="font-size:11px;white-space:nowrap">{dt}</td>
          <td>{ev_icon(e["kind"])} {e["kind"]}</td>
          <td>{e["name"]}</td>
          <td style="font-family:monospace;font-size:11px">{e["ip"]}</td>
          <td style="font-size:11px">{_esc(e["detail"])}</td>
        </tr>"""

    avg_up_all = [r["uptime"] for r in rows if r["uptime"] is not None]
    avg_up_str = f"{round(sum(avg_up_all)/len(avg_up_all),1)}%" if avg_up_all else "—"

    html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>NetWatch — Отчёт {period_name}</title>
<style>
  @page {{ size: A4 landscape; margin: 15mm 10mm; }}
  @media print {{
    .no-print {{ display:none; }}
    body {{ font-size: 11px; }}
    h2 {{ page-break-before: always; }}
    h2:first-of-type {{ page-break-before: avoid; }}
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, Arial, sans-serif; font-size: 12px;
          color: #1a1a1a; background: #fff; padding: 20px; }}
  .header {{ display:flex; justify-content:space-between; align-items:flex-start;
             border-bottom: 2px solid #1a237e; padding-bottom: 12px; margin-bottom: 18px; }}
  .logo {{ font-size: 24px; font-weight: 800; color: #1a237e; }}
  .logo span {{ color: #1976d2; }}
  .meta {{ font-size: 11px; color: #555; text-align: right; line-height: 1.8; }}
  .summary {{ display:flex; gap:16px; margin-bottom: 20px; flex-wrap:wrap; }}
  .sc {{ background: #f5f5f5; border-radius: 8px; padding: 10px 16px; min-width: 100px; }}
  .sc-n {{ font-size: 20px; font-weight: 700; color: #1a237e; }}
  .sc-l {{ font-size: 10px; color: #777; margin-top: 2px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 24px; }}
  th {{ background: #1a237e; color: #fff; padding: 7px 8px; text-align: left;
        font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }}
  td {{ padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: middle; }}
  tr:nth-child(even) td {{ background: #fafafa; }}
  tr:hover td {{ background: #e8eaf6; }}
  h2 {{ font-size: 14px; color: #1a237e; margin: 20px 0 10px;
        padding-bottom: 6px; border-bottom: 1px solid #c5cae9; }}
  .badge {{ display:inline-block; padding: 2px 8px; border-radius: 10px;
            font-size: 10px; font-weight: 600; }}
  .btn-print {{ position:fixed; top:16px; right:16px; background:#1976d2; color:#fff;
               border:none; padding:10px 20px; border-radius:8px; cursor:pointer;
               font-size:13px; font-weight:600; box-shadow:0 2px 8px rgba(0,0,0,.2); }}
  .btn-print:hover {{ background:#1565c0; }}
</style>
</head>
<body>

<button class="btn-print no-print" onclick="window.print()">🖨 Печать / Сохранить PDF</button>

<div class="header">
  <div>
    <div class="logo">Net<span>Watch</span></div>
    <div style="font-size:13px;color:#555;margin-top:4px">Отчёт за {period_name}</div>
  </div>
  <div class="meta">
    Сгенерирован: {generated}<br>
    Период: {datetime.fromtimestamp(since).strftime("%d.%m.%Y")} — {datetime.fromtimestamp(now).strftime("%d.%m.%Y")}<br>
    Устройств: {len(devices)} | Онлайн: {online_cnt} | Оффлайн: {offline_cnt}
  </div>
</div>

<div class="summary">
  <div class="sc"><div class="sc-n">{len(devices)}</div><div class="sc-l">Всего устройств</div></div>
  <div class="sc"><div class="sc-n" style="color:#00897b">{online_cnt}</div><div class="sc-l">Онлайн</div></div>
  <div class="sc"><div class="sc-n" style="color:#e53935">{offline_cnt}</div><div class="sc-l">Оффлайн</div></div>
  <div class="sc"><div class="sc-n" style="color:#1976d2">{avg_up_str}</div><div class="sc-l">Средний uptime</div></div>
  <div class="sc"><div class="sc-n">{len(events)}</div><div class="sc-l">Событий за период</div></div>
</div>

<h2>SLA — доступность устройств</h2>
<table>
  <thead>
    <tr>
      <th>Устройство</th><th>IP</th><th>Тип</th><th>Расположение</th>
      <th>Uptime %</th><th>Ср. пинг</th><th>Инциденты</th><th>Замеров</th>
    </tr>
  </thead>
  <tbody>{rows_html}</tbody>
</table>

<h2>Журнал событий ({len(events)} записей)</h2>
<table>
  <thead>
    <tr><th>Время</th><th>Тип</th><th>Устройство</th><th>IP</th><th>Подробности</th></tr>
  </thead>
  <tbody>{evs_html}</tbody>
</table>

<div style="text-align:center;color:#aaa;font-size:10px;margin-top:20px;padding-top:10px;border-top:1px solid #eee">
  NetWatch — Автоматически сгенерированный отчёт · {generated}
</div>
</body>
</html>"""

    from flask import Response
    return Response(html, mimetype="text/html",
                    headers={"Content-Disposition": "inline"})


# ── Backup ────────────────────────────────────────────────────────────────────
@bp.route("/api/backup", methods=["POST"])
@login_required
def create_backup():
    """Create a manual backup zip of netwatch.db → backups/YYYY-MM-DD_HH-MM.zip"""
    from .backup import do_backup
    path = do_backup()
    if path:
        return jsonify({"ok": True, "path": path})
    return jsonify({"ok": False, "error": "backup failed"}), 500

@bp.route("/api/backup/list")
@login_required
def list_backups():
    from .backup import list_backups as _lb
    return jsonify(_lb())

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

# ══════════════════════════════════════════════════════════════════════════════
# MikroTik API — Hotspot / Firewall / DHCP / Syslog
# ══════════════════════════════════════════════════════════════════════════════

def _mt_device(ip: str):
    """Find device in DB by IP, return (device_dict, login, password) or None."""
    for d in load_devices():
        if d["ip"] == ip:
            return d, d.get("cred_login",""), d.get("cred_password","")
    return None, "", ""


def _mt_api(ip: str, fn):
    """Find device credentials and call fn(api). Returns JSON-able dict."""
    from .mikrotik import _with_api
    d, login, password = _mt_device(ip)
    if not login:
        return {"ok": False, "error": "Немає облікових даних. Додайте логін/пароль до картки пристрою."}
    return _with_api(ip, login, password, fn)


    # Step 2: Read initial data (some RouterOS versions send banner)
    try:
        s.settimeout(1.0)
        banner = s.recv(256)
        step("Initial banner", True, f"получено {len(banner)} байт: {banner[:60].hex()}")
    except _sock.timeout:
        step("Initial banner", True, "немає банера (нормально для RouterOS 7)")
    except Exception as e:
        step("Initial banner", False, str(e))

    # Step 3: Send /login sentence
    def enc_word(w):
        enc = w.encode("utf-8")
        n = len(enc)
        pfx = bytes([n]) if n < 128 else bytes([(n>>8)|0x80, n&0xFF])
        return pfx + enc

    sentence = b"".join(enc_word(w) for w in
                        ["/login", f"=name={login}", f"=password={password}"]) + b"\x00"
    try:
        s.settimeout(5)
        s.sendall(sentence)
        step("Send /login", True, f"отправлено {len(sentence)} байт")
    except Exception as e:
        step("Send /login", False, str(e))
        s.close()
        return jsonify({"steps": steps, "conclusion": "Ошибка отправки"})

    # Step 4: Read response - raw bytes first
    try:
        s.settimeout(5)
        raw = b""
        while True:
            try:
                chunk = s.recv(1024)
                if not chunk:
                    break
                raw += chunk
                if len(raw) > 2048:
                    break
            except _sock.timeout:
                break
        step("Read response raw", True,
             f"{len(raw)} байт: {raw[:80].hex()} | text: {raw[:80]!r}")
    except Exception as e:
        step("Read response raw", False, str(e))
        s.close()
        return jsonify({"steps": steps})

    s.close()

    # Step 5: Parse response — check !trap BEFORE !done
    # RouterOS sends: !trap (error) then !done (end), OR just !done (success)
    conclusion = "Неизвестно"
    raw_str = raw.decode("utf-8", errors="replace")
    if "!trap" in raw_str:
        # Extract message from trap
        import re as _re2
        m = _re2.search(r"message=([^\x00]+)", raw_str)
        msg = m.group(1).strip() if m else raw_str[:100]
        conclusion = f"❌ ЛОГИН ОТКЛОНЁН — {msg}"
        step("Parse response", False, f"!trap: {msg}")
    elif "!done" in raw_str and "!trap" not in raw_str:
        conclusion = "✅ ЛОГИН УСПЕШЕН — только !done, нет !trap"
        step("Parse response", True, "!done без ошибок")
    elif len(raw) > 4:
        conclusion = "⚠️ Старый стиль RouterOS (MD5 challenge) или неожиданный ответ"
        step("Parse response", None, f"raw hex: {raw[:40].hex()}")
    else:
        conclusion = "⚠️ Пустой ответ от роутера"
        step("Parse response", False, "нет данных")

    return jsonify({"steps": steps, "conclusion": conclusion,
                    "raw_hex": raw[:120].hex(), "raw_text": raw[:120].decode("utf-8","replace")})






# ── MikroTik system status ────────────────────────────────────────────────────

@bp.route("/api/mt/<ip>/status")
@login_required
def mt_status(ip):
    """System resource + identity + interfaces."""
    def fn(api):
        res  = api.get_resource()
        name = api.get_identity()
        ifaces = api.get_interfaces()
        return {"ok": True, "resource": res, "identity": name, "interfaces": ifaces}
    return jsonify(_mt_api(ip, fn))


# ── Hotspot sessions ──────────────────────────────────────────────────────────

@bp.route("/api/mt/<ip>/hotspot/active")
@login_required
def mt_hotspot_active(ip):
    return jsonify(_mt_api(ip, lambda api: {"ok": True, "sessions": api.get_hotspot_active()}))


@bp.route("/api/mt/<ip>/hotspot/users")
@login_required
def mt_hotspot_users(ip):
    def fn(api):
        users    = api.get_hotspot_users()
        profiles = api.get_hotspot_profiles()
        return {"ok": True, "users": users, "profiles": profiles}
    return jsonify(_mt_api(ip, fn))


@bp.route("/api/mt/<ip>/hotspot/users", methods=["POST"])
@login_required
def mt_hotspot_add_user(ip):
    data = request.json or {}
    def fn(api):
        return api.add_hotspot_user(
            name        = data.get("name",""),
            password    = data.get("password",""),
            profile     = data.get("profile","default"),
            limit_uptime= data.get("limit_uptime",""),
            rate_limit  = data.get("rate_limit",""),
        )
    result = _mt_api(ip, fn)
    if result.get("ok"):
        add_audit("mt_hotspot_add_user", session.get("username",""), request.remote_addr or "",
                  f"{ip} user={data.get('name','')}")
    return jsonify(result)


@bp.route("/api/mt/<ip>/hotspot/users/<user_id>", methods=["DELETE"])
@login_required
def mt_hotspot_del_user(ip, user_id):
    result = _mt_api(ip, lambda api: api.remove_hotspot_user(user_id))
    if result.get("ok"):
        add_audit("mt_hotspot_del_user", session.get("username",""), request.remote_addr or "", f"{ip}")
    return jsonify(result)


@bp.route("/api/mt/<ip>/hotspot/sessions/<session_id>", methods=["DELETE"])
@login_required
def mt_hotspot_kick(ip, session_id):
    return jsonify(_mt_api(ip, lambda api: api.disconnect_hotspot_session(session_id)))


# ── Firewall ──────────────────────────────────────────────────────────────────

@bp.route("/api/mt/<ip>/firewall/filter")
@login_required
def mt_fw_filter(ip):
    return jsonify(_mt_api(ip, lambda api: {"ok": True, "rules": api.get_firewall_filter()}))


@bp.route("/api/mt/<ip>/firewall/filter/<rule_id>", methods=["PATCH"])
@login_required
def mt_fw_toggle(ip, rule_id):
    enabled = (request.json or {}).get("enabled", True)
    result  = _mt_api(ip, lambda api: api.set_firewall_rule_enabled(rule_id, enabled))
    if result.get("ok"):
        add_audit("mt_fw_toggle", session.get("username",""), request.remote_addr or "",
                  f"{ip} rule={rule_id} enabled={enabled}")
    return jsonify(result)


@bp.route("/api/mt/<ip>/firewall/address-list")
@login_required
def mt_addr_list(ip):
    return jsonify(_mt_api(ip, lambda api: {"ok": True, "entries": api.get_address_lists()}))


@bp.route("/api/mt/<ip>/firewall/address-list", methods=["POST"])
@login_required
def mt_addr_list_add(ip):
    data = request.json or {}
    def fn(api):
        return api.add_to_address_list(
            address   = data.get("address",""),
            list_name = data.get("list","blacklist"),
            comment   = data.get("comment",""),
            timeout   = data.get("timeout",""),
        )
    result = _mt_api(ip, fn)
    if result.get("ok"):
        add_audit("mt_blocklist_add", session.get("username",""), request.remote_addr or "",
                  f"{ip} address={data.get('address','')} list={data.get('list','blacklist')}")
    return jsonify(result)


@bp.route("/api/mt/<ip>/firewall/address-list/<entry_id>", methods=["DELETE"])
@login_required
def mt_addr_list_del(ip, entry_id):
    return jsonify(_mt_api(ip, lambda api: api.remove_from_address_list(entry_id)))


# ── DHCP leases ───────────────────────────────────────────────────────────────

@bp.route("/api/mt/<ip>/dhcp")
@login_required
def mt_dhcp(ip):
    return jsonify(_mt_api(ip, lambda api: {"ok": True, "leases": api.get_dhcp_leases()}))


@bp.route("/api/mt/<ip>/dhcp/<lease_id>/static", methods=["POST"])
@login_required
def mt_dhcp_static(ip, lease_id):
    return jsonify(_mt_api(ip, lambda api: api.make_dhcp_static(lease_id)))


@bp.route("/api/mt/<ip>/dhcp/<lease_id>", methods=["DELETE"])
@login_required
def mt_dhcp_del(ip, lease_id):
    return jsonify(_mt_api(ip, lambda api: api.remove_dhcp_lease(lease_id)))


# ── Syslog ────────────────────────────────────────────────────────────────────

@bp.route("/api/syslog")
@login_required
def syslog_get():
    from .mikrotik import get_syslog_entries, _syslog_running
    topic  = request.args.get("topic","")
    src_ip = request.args.get("src_ip","")
    search = request.args.get("search","")
    limit  = int(request.args.get("limit", 200))
    return jsonify({
        "ok":      True,
        "running": _syslog_running,
        "entries": get_syslog_entries(limit, topic, src_ip, search),
    })


@bp.route("/api/syslog/start", methods=["POST"])
@login_required
def syslog_start():
    from .mikrotik import start_syslog_server
    port = int((request.json or {}).get("port", 514))
    result = start_syslog_server(port)
    return jsonify(result)


@bp.route("/api/syslog/stop", methods=["POST"])
@login_required
def syslog_stop():
    from .mikrotik import stop_syslog_server
    stop_syslog_server()
    return jsonify({"ok": True})


@bp.route("/api/syslog/clear", methods=["DELETE"])
@login_required
def syslog_clear():
    from .mikrotik import clear_syslog
    clear_syslog()
    return jsonify({"ok": True})