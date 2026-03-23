"""
NetWatch — Socket.IO event handlers.

События от клиента:
  connect          — проверка авторизации, клиент входит в room "monitors"
  disconnect       — логирование
  ping_request     — клиент просит немедленный пинг конкретного IP

События от сервера (emit):
  connected        → подтверждение + текущий snapshot всех устройств
  device_update    → изменился статус / latency устройства
  new_event        → новое событие (down/up/reboot/...)
  autoscan_update  → новые хосты / подсети при авто-скане
  scan_done        → глубокий скан завершён
"""
import time as _time
from flask import request, session
from flask_socketio import emit, join_room, disconnect as sock_disconnect

# ── WS token (lightweight auth for eventlet WS handshake) ────────────────────
_ws_tokens: dict = {}   # token → expiry_ts

def generate_ws_token(username: str) -> str:
    """Generate a short-lived token for WS auth. Called from routes.py."""
    import secrets
    token = secrets.token_hex(16)
    _ws_tokens[token] = (_time.time() + 300, username)  # 5 min TTL
    # Cleanup expired
    now = _time.time()
    expired = [t for t, (exp, _) in _ws_tokens.items() if exp < now]
    for t in expired:
        del _ws_tokens[t]
    return token

def _validate_ws_token(token: str) -> bool:
    entry = _ws_tokens.get(token)
    if not entry:
        return False
    exp, _ = entry
    return _time.time() < exp

from .socketio_instance import socketio
from .monitor import status_cache, latency_cache, mac_cache, vendor_cache, model_cache
from .storage import load_devices


# ── Connection lifecycle ──────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    """Accept connection using Flask session OR token query param."""
    # Try Flask session first (works with polling transport)
    logged_in = session.get("logged_in", False)

    # Fallback: token passed as ?token=... query param
    if not logged_in:
        token = request.args.get("token", "")
        if token and _validate_ws_token(token):
            logged_in = True

    print(f"[ws] connect {request.sid} auth={logged_in}")

    if not logged_in:
        emit("auth_required", {})
        return

    join_room("monitors")

    # Log which transport is being used
    transport = getattr(request, 'environ', {}).get('HTTP_UPGRADE', 'polling')
    print(f"[ws] transport: {'websocket' if transport == 'websocket' else 'polling'}")

    devices  = load_devices()
    snapshot = []
    for d in devices:
        ip = d["ip"]
        snapshot.append({
            "ip":      ip,
            "id":      d["id"],
            "name":    d.get("name", ip),
            "online":  status_cache.get(ip),
            "latency": latency_cache.get(ip),
            "mac":     mac_cache.get(ip, d.get("mac", "")),
            "vendor":  vendor_cache.get(ip, d.get("vendor", "")),
            "model":   model_cache.get(ip, d.get("model", "")),
        })
    emit("connected", {"devices": snapshot})
    print(f"[ws] snapshot sent: {len(snapshot)} devices")


@socketio.on("disconnect")
def on_disconnect():
    print(f"[ws] client disconnected: {request.sid}")


# ── Client-initiated actions ──────────────────────────────────────────────────

@socketio.on("ping_request")
def on_ping_request(data):
    """Client asks for immediate ping of one IP. Fire and forget."""
    if not session.get("logged_in", False):
        return
    ip = (data or {}).get("ip", "")
    if not ip:
        return

    import threading
    from .scanner     import async_ping
    from .storage     import load_devices
    from .monitor     import _on_ping_result
    import asyncio

    def _do():
        loop = asyncio.new_event_loop()
        try:
            alive, ms = loop.run_until_complete(async_ping(ip))
        finally:
            loop.close()
        devices  = load_devices()
        dbip     = {d["ip"]: d for d in devices}
        _on_ping_result(ip, alive, ms, dbip)

    threading.Thread(target=_do, daemon=True).start()


# ── Server → Client emitters (called from monitor.py / events.py) ────────────

def emit_device_update(ip: str, online: bool, latency, name: str = ""):
    """
    Push status/latency change to all connected monitors.
    Thread-safe — uses socketio.emit (not the request-context version).
    """
    try:
        socketio.emit("device_update", {
            "ip":      ip,
            "name":    name,
            "online":  online,
            "latency": latency,
        }, room="monitors")
    except Exception as e:
        print(f"[ws] emit_device_update error: {e}")


def emit_new_event(kind: str, ip: str, name: str, detail: str, ts: float):
    """Push a new log event to all monitors."""
    try:
        socketio.emit("new_event", {
            "kind":   kind,
            "ip":     ip,
            "name":   name,
            "detail": detail,
            "ts":     ts,
        }, room="monitors")
    except Exception as e:
        print(f"[ws] emit_new_event error: {e}")


def emit_scan_done(online: int, total: int):
    """Notify that an auto-scan cycle completed."""
    try:
        socketio.emit("scan_done", {
            "online": online,
            "total":  total,
        }, room="monitors")
    except Exception as e:
        print(f"[ws] emit_scan_done error: {e}")


def emit_autoscan_update(new_hosts: list, new_subnets: list):
    """Notify that auto-discovery found something."""
    try:
        socketio.emit("autoscan_update", {
            "new_hosts":   new_hosts,
            "new_subnets": new_subnets,
        }, room="monitors")
    except Exception as e:
        print(f"[ws] emit_autoscan_update error: {e}")