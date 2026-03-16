"""Async network scanner: ping, port probe, MAC lookup, full host scan."""
import asyncio, subprocess, time, re, platform
from .oui import get_mac_from_arp, oui_lookup, fingerprint_device

PROBE_PORTS = [22, 23, 80, 443, 554, 8080, 8291, 37777, 8443, 5000, 445, 139, 548, 62078, 8888, 161]

async def async_tcp_check(ip: str, port: int, timeout: float = 0.6) -> bool:
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=timeout)
        w.close()
        try: await w.wait_closed()
        except: pass
        return True
    except: return False

async def async_ping(ip: str, timeout: float = 1.0):
    """ICMP ping via subprocess, returns (alive, latency_ms)."""
    try:
        t = time.time()
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", "1", ip,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 1.5)
        ms = round((time.time() - t) * 1000, 1)
        if proc.returncode == 0:
            # Try to extract actual RTT from ping output
            m = re.search(r"time[=<]([\d.]+)\s*ms", stdout.decode(errors="ignore"))
            if m: ms = float(m.group(1))
            return True, ms
        return False, None
    except: return False, None

async def async_scan_host(ip: str) -> dict:
    """Full async scan: ping + port scan + MAC + vendor + fingerprint."""
    alive, latency = await async_ping(ip)
    result = {"ip": ip, "alive": alive, "latency": latency,
              "mac": "", "vendor": "", "model": "", "open_ports": [], "suggested_type": ""}
    if not alive:
        return result

    # Parallel port probes
    tasks = [async_tcp_check(ip, p) for p in PROBE_PORTS]
    port_results = await asyncio.gather(*tasks)
    open_ports = [PROBE_PORTS[i] for i, ok in enumerate(port_results) if ok]
    result["open_ports"] = open_ports

    # MAC + vendor (must happen after ping so ARP is populated)
    mac = get_mac_from_arp(ip)
    result["mac"] = mac
    vendor = oui_lookup(mac)
    result["vendor"] = vendor

    # Fingerprint
    fp = fingerprint_device(ip, vendor, open_ports)
    result["model"] = fp["model"]
    result["suggested_type"] = fp["suggested_type"]
    return result

def run_async_scan(ips: list, on_result=None, max_concurrent: int = 80) -> list:
    """Run async scan in a new event loop (thread-safe)."""
    async def _run():
        sem = asyncio.Semaphore(max_concurrent)
        results = []
        async def bounded(ip):
            async with sem:
                r = await async_scan_host(ip)
                if on_result: on_result(r)
                results.append(r)
        await asyncio.gather(*[bounded(ip) for ip in ips])
        return results
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()

# ══════════════════════════════════════════════════════════════════════════════
# Legacy sync ping (fallback for monitor quick-ping)
# ══════════════════════════════════════════════════════════════════════════════
def ping_sync(ip: str):
    p = "-n" if platform.system().lower() == "windows" else "-c"
    w = "-w" if platform.system().lower() == "windows" else "-W"
    try:
        t = time.time()
        r = subprocess.run(["ping", p, "1", w, "1", ip],
                           capture_output=True, text=True, timeout=3)
        ms = round((time.time() - t) * 1000, 1)
        if r.returncode == 0:
            m = re.search(r"time[=<]([\d.]+)\s*ms", r.stdout)
            if m: ms = float(m.group(1))
            return True, ms
        return False, None
    except: return False, None

# ══════════════════════════════════════════════════════════════════════════════