"""
NetWatch — MikroTik RouterOS API client.

Реализует бинарный протокол MikroTik API (порт 8728, plaintext).
Поддерживает RouterOS 6.x и 7.x.
Без внешних зависимостей — только stdlib.

Покрытые команды:
  /ip/hotspot/active/print         — активные сессии
  /ip/hotspot/user/print|add|remove — пользователи
  /ip/firewall/filter/print|set    — правила firewall
  /ip/firewall/address-list/print|add|remove — блок-листы
  /ip/dhcp-server/lease/print|make-static    — DHCP лизы
  /system/resource/print            — CPU/RAM/uptime
  /interface/print                  — интерфейсы
"""

import socket, struct, hashlib, time
from typing import Generator


# ══════════════════════════════════════════════════════════════════════════════
# Low-level binary protocol
# ══════════════════════════════════════════════════════════════════════════════

def _encode_word(word: str) -> bytes:
    enc = word.encode("utf-8")
    n   = len(enc)
    if n < 0x80:
        pfx = bytes([n])
    elif n < 0x4000:
        pfx = bytes([(n >> 8) | 0x80, n & 0xFF])
    elif n < 0x200000:
        pfx = bytes([(n >> 16) | 0xC0, (n >> 8) & 0xFF, n & 0xFF])
    else:
        pfx = struct.pack(">I", n | 0xE0000000)
    return pfx + enc


def _encode_sentence(words: list) -> bytes:
    return b"".join(_encode_word(w) for w in words) + b"\x00"


def _read_word(sock: socket.socket) -> str | None:
    """Read one length-prefixed word from socket. Returns None on end-of-sentence."""
    def read_n(n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("socket closed")
            buf += chunk
        return buf

    b0 = read_n(1)[0]
    if b0 == 0:
        return None  # end of sentence
    if b0 < 0x80:
        length = b0
    elif b0 < 0xC0:
        length = ((b0 & 0x3F) << 8) | read_n(1)[0]
    elif b0 < 0xE0:
        rest   = read_n(2)
        length = ((b0 & 0x1F) << 16) | (rest[0] << 8) | rest[1]
    else:
        rest   = read_n(3)
        length = ((b0 & 0x0F) << 24) | (rest[0] << 16) | (rest[1] << 8) | rest[2]

    return read_n(length).decode("utf-8", errors="replace")


def _read_sentence(sock: socket.socket) -> list:
    words = []
    while True:
        w = _read_word(sock)
        if w is None:
            break
        words.append(w)
    return words


def _sentence_to_dict(sentence: list) -> dict:
    """Convert ['!re', '=name=ether1', '=rx-byte=1234'] → {'type':'!re','name':'ether1',...}"""
    result = {}
    for word in sentence:
        if word.startswith("!"):
            result["__type__"] = word
        elif word.startswith("=") and "=" in word[1:]:
            k, _, v = word[1:].partition("=")
            result[k] = v
    return result


# ══════════════════════════════════════════════════════════════════════════════
# Connection class
# ══════════════════════════════════════════════════════════════════════════════

class MikroTikAPI:
    """
    Context-manager based MikroTik API connection.

    Usage:
        with MikroTikAPI(ip, login, password) as api:
            leases = api.get_dhcp_leases()
    """

    def __init__(self, ip: str, login: str, password: str,
                 port: int = 8728, timeout: float = 8.0):
        self.ip       = ip
        self.login    = login
        self.password = password
        self.port     = port
        self.timeout  = timeout
        self._sock    = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.close()

    def connect(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect((self.ip, self.port))
        self._sock = s
        self._login()

    def close(self):
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    # ── Authentication ────────────────────────────────────────────────────────

    def _login(self):
        """Handle both old (MD5 challenge) and new (plain) login."""
        self._send(["/login", f"=name={self.login}", f"=password={self.password}"])
        resp = self._read_response()

        # resp may be empty only if socket closed mid-stream
        if not resp:
            raise ConnectionError("Сокет закрыт до ответа MikroTik API")

        first = resp[0]
        # New-style login (RouterOS 6.43+): responds with only !done on success
        # _read_response now INCLUDES !done in results, so this works correctly
        if first.get("__type__") == "!done":
            return  # success!

        # Old-style: challenge response with MD5
        if "ret" in first:
            challenge = bytes.fromhex(first["ret"])
            h = hashlib.md5()
            h.update(b"\x00")
            h.update(self.password.encode("utf-8"))
            h.update(challenge)
            self._send(["/login",
                        f"=name={self.login}",
                        f"=response=00{h.hexdigest()}"])
            resp2 = self._read_response()
            if resp2 and resp2[0].get("__type__") == "!trap":
                raise PermissionError(resp2[0].get("message", "Login failed"))
            return

        if first.get("__type__") == "!trap":
            raise PermissionError(first.get("message", "Login failed"))

        # Unexpected response — raise to prevent silent auth bypass
        raise ConnectionError(f"Unexpected login response: {first.get('__type__')} {first}")

    # ── Raw send/receive ──────────────────────────────────────────────────────

    def _send(self, words: list):
        self._sock.sendall(_encode_sentence(words))

    def _read_response(self) -> list[dict]:
        """Read sentences until !done or !trap.
        !done IS included in results so _login can detect successful new-style auth.
        BUG WAS: !done was discarded → _login got empty list → raised ConnectionError
        even on successful login (RouterOS 6.43+ returns only !done on success).
        """
        results = []
        while True:
            sentence = _read_sentence(self._sock)
            if not sentence:
                break
            d = _sentence_to_dict(sentence)
            t = d.get("__type__", "")
            if t == "!done":
                results.append(d)   # include !done — critical for login detection
                break
            if t == "!trap":
                results.append(d)
                break
            if t == "!re":
                results.append(d)
        return results

    def _run(self, *words) -> list[dict]:
        self._send(list(words))
        resp = self._read_response()
        for r in resp:
            if r.get("__type__") == "!trap":
                raise RuntimeError(r.get("message", "API error"))
        # Strip !done sentinel — callers only want !re data rows
        return [r for r in resp if r.get("__type__") not in ("!done",)]

    # ══════════════════════════════════════════════════════════════════════════
    # High-level API methods
    # ══════════════════════════════════════════════════════════════════════════

    # ── System ────────────────────────────────────────────────────────────────

    def get_resource(self) -> dict:
        """CPU, RAM, uptime, RouterOS version."""
        rows = self._run("/system/resource/print")
        return rows[0] if rows else {}

    def get_identity(self) -> str:
        rows = self._run("/system/identity/print")
        return rows[0].get("name", "") if rows else ""

    # ── Hotspot ───────────────────────────────────────────────────────────────

    def get_hotspot_active(self) -> list[dict]:
        """List of currently connected Hotspot sessions."""
        return self._run("/ip/hotspot/active/print")

    def get_hotspot_users(self) -> list[dict]:
        return self._run("/ip/hotspot/user/print")

    def add_hotspot_user(self, name: str, password: str,
                         profile: str = "default",
                         limit_uptime: str = "",
                         rate_limit: str = "") -> dict:
        words = ["/ip/hotspot/user/add",
                 f"=name={name}",
                 f"=password={password}",
                 f"=profile={profile}"]
        if limit_uptime: words.append(f"=limit-uptime={limit_uptime}")
        if rate_limit:   words.append(f"=rate-limit={rate_limit}")
        self._send(words)
        resp = self._read_response()
        return {"ok": True, "id": resp[0].get("ret", "")} if resp and resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error") if resp else "no response"}

    def remove_hotspot_user(self, user_id: str) -> dict:
        self._send(["/ip/hotspot/user/remove", f"=.id={user_id}"])
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    def disconnect_hotspot_session(self, session_id: str) -> dict:
        self._send(["/ip/hotspot/active/remove", f"=.id={session_id}"])
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    def get_hotspot_profiles(self) -> list[dict]:
        return self._run("/ip/hotspot/user/profile/print")

    # ── Firewall ──────────────────────────────────────────────────────────────

    def get_firewall_filter(self) -> list[dict]:
        return self._run("/ip/firewall/filter/print")

    def set_firewall_rule_enabled(self, rule_id: str, enabled: bool) -> dict:
        self._send(["/ip/firewall/filter/set",
                    f"=.id={rule_id}",
                    f"=disabled={'no' if enabled else 'yes'}"])
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    def get_address_lists(self) -> list[dict]:
        return self._run("/ip/firewall/address-list/print")

    def add_to_address_list(self, address: str, list_name: str,
                             comment: str = "", timeout: str = "") -> dict:
        words = ["/ip/firewall/address-list/add",
                 f"=address={address}",
                 f"=list={list_name}"]
        if comment: words.append(f"=comment={comment}")
        if timeout: words.append(f"=timeout={timeout}")
        self._send(words)
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    def remove_from_address_list(self, entry_id: str) -> dict:
        self._send(["/ip/firewall/address-list/remove", f"=.id={entry_id}"])
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    # ── DHCP ─────────────────────────────────────────────────────────────────

    def get_dhcp_leases(self) -> list[dict]:
        return self._run("/ip/dhcp-server/lease/print")

    def make_dhcp_static(self, lease_id: str) -> dict:
        self._send(["/ip/dhcp-server/lease/make-static", f"=.id={lease_id}"])
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    def remove_dhcp_lease(self, lease_id: str) -> dict:
        self._send(["/ip/dhcp-server/lease/remove", f"=.id={lease_id}"])
        resp = self._read_response()
        return {"ok": True} if not resp or resp[0].get("__type__") != "!trap" \
               else {"ok": False, "error": resp[0].get("message", "error")}

    # ── Interfaces ────────────────────────────────────────────────────────────

    def get_interfaces(self) -> list[dict]:
        return self._run("/interface/print")


# ══════════════════════════════════════════════════════════════════════════════
# Syslog UDP receiver
# ══════════════════════════════════════════════════════════════════════════════

import threading, re as _re, collections as _col

_syslog_lock    = threading.Lock()
_syslog_entries = _col.deque(maxlen=2000)  # last 2000 log lines in memory
_syslog_thread  = None
_syslog_running = False

_SYSLOG_FACILITY = ["kern","user","mail","daemon","auth","syslog","lpr","news",
                    "uucp","cron","authpriv","ftp","ntp","security","console",
                    "solaris-cron","local0","local1","local2","local3","local4",
                    "local5","local6","local7"]
_SYSLOG_SEVERITY = ["emerg","alert","crit","err","warning","notice","info","debug"]

_MT_TOPICS = {
    "firewall": "🛡", "dhcp": "🔗", "hotspot": "👤", "wireless": "📶",
    "system": "⚙️", "info": "ℹ️", "error": "❌", "warning": "⚠️",
    "ppp": "🔌", "route": "🛤", "interface": "🔌", "script": "📜",
}


def _parse_syslog(data: bytes, addr: tuple) -> dict:
    """Parse RFC 3164 / RFC 5424 syslog message."""
    try:
        text = data.decode("utf-8", errors="replace").strip()
    except Exception:
        text = data.hex()

    pri = 0; msg = text
    m = _re.match(r"^<(\d+)>(.*)", text)
    if m:
        pri = int(m.group(1))
        msg = m.group(2).strip()

    facility = _SYSLOG_FACILITY[pri >> 3] if (pri >> 3) < len(_SYSLOG_FACILITY) else "unknown"
    severity = _SYSLOG_SEVERITY[pri & 0x7]

    # Detect MikroTik topic from message prefix like "firewall,info forward"
    topic = "system"
    for kw in _MT_TOPICS:
        if kw in msg.lower():
            topic = kw
            break

    return {
        "ts":       time.time(),
        "src_ip":   addr[0],
        "facility": facility,
        "severity": severity,
        "topic":    topic,
        "icon":     _MT_TOPICS.get(topic, "ℹ️"),
        "msg":      msg[:500],
    }


def start_syslog_server(port: int = 514):
    """Start UDP syslog receiver in daemon thread."""
    global _syslog_thread, _syslog_running
    if _syslog_running:
        return {"ok": True, "note": "already running"}

    def _listen():
        global _syslog_running
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", port))
            sock.settimeout(1.0)
            _syslog_running = True
            print(f"[syslog] listening UDP:{port}")
            while _syslog_running:
                try:
                    data, addr = sock.recvfrom(4096)
                    entry = _parse_syslog(data, addr)
                    with _syslog_lock:
                        _syslog_entries.appendleft(entry)
                except socket.timeout:
                    continue
                except Exception as e:
                    print(f"[syslog] recv error: {e}")
        except PermissionError:
            print(f"[syslog] permission denied on port {port}. "
                  f"Try: sudo sysctl -w net.inet.udp.recvspace=65536 "
                  f"or use port 5140 and forward from MikroTik")
            _syslog_running = False
        except Exception as e:
            print(f"[syslog] error: {e}")
            _syslog_running = False

    _syslog_thread = threading.Thread(target=_listen, daemon=True)
    _syslog_thread.start()
    time.sleep(0.2)
    return {"ok": _syslog_running}


def stop_syslog_server():
    global _syslog_running
    _syslog_running = False


def get_syslog_entries(limit: int = 200, topic: str = "",
                        src_ip: str = "", search: str = "") -> list:
    with _syslog_lock:
        entries = list(_syslog_entries)
    if topic:  entries = [e for e in entries if e["topic"] == topic]
    if src_ip: entries = [e for e in entries if e["src_ip"] == src_ip]
    if search:
        s = search.lower()
        entries = [e for e in entries if s in e["msg"].lower()]
    return entries[:limit]


def clear_syslog():
    with _syslog_lock:
        _syslog_entries.clear()


# ══════════════════════════════════════════════════════════════════════════════
# Helper: safe API call with error result
# ══════════════════════════════════════════════════════════════════════════════

def _with_api(ip, login, password, fn, port=8728):
    """
    Run fn(api) with a MikroTikAPI connection.
    Returns {"ok": False, "error": "..."} on any exception.
    """
    try:
        with MikroTikAPI(ip, login, password, port=port) as api:
            return fn(api)
    except PermissionError as e:
        return {"ok": False, "error": f"Невірний логін/пароль: {e}"}
    except ConnectionRefusedError:
        return {"ok": False, "error": f"Порт {port} закрыт. Включите: /ip service enable api"}
    except (socket.timeout, TimeoutError):
        return {"ok": False, "error": "Таймаут підключення"}
    except Exception as e:
        return {"ok": False, "error": str(e)}