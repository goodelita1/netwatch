"""Async network scanner: ping, port probe, MAC lookup, full host scan."""
import asyncio, subprocess, time, re, platform
from .oui import (get_mac_from_arp, oui_lookup, fingerprint_device,
                  grab_http_banner, grab_snmp_sysdescr, parse_snmp_sysdescr,
                  PROBE_PORTS)

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
    """Full async scan: ping + ports + MAC + HTTP banner + SNMP + fingerprint."""
    alive, latency = await async_ping(ip)
    result = {"ip": ip, "alive": alive, "latency": latency,
              "mac": "", "vendor": "", "model": "", "open_ports": [],
              "suggested_type": "", "http_banner": "", "snmp_sysdescr": ""}
    if not alive:
        return result

    # Parallel port probes
    tasks = [async_tcp_check(ip, p) for p in PROBE_PORTS]
    port_results = await asyncio.gather(*tasks)
    open_ports = [PROBE_PORTS[i] for i, ok in enumerate(port_results) if ok]
    result["open_ports"] = open_ports

    # MAC + vendor from ARP/OUI
    mac = get_mac_from_arp(ip)
    result["mac"] = mac
    vendor = oui_lookup(mac)
    result["vendor"] = vendor

    # HTTP banner (non-blocking via executor)
    loop = asyncio.get_event_loop()
    http_info = await loop.run_in_executor(
        None, lambda: grab_http_banner(ip, open_ports, timeout=2.5)
    )
    if http_info.get("server_header"):
        result["http_banner"] = http_info["server_header"]
    if not vendor and http_info.get("vendor"):
        vendor = http_info["vendor"]
        result["vendor"] = vendor
    if not result.get("model") and http_info.get("model"):
        result["model"] = http_info["model"]

    # SNMP sysDescr — only if port 161 open
    if 161 in open_ports:
        sysdescr = await loop.run_in_executor(
            None, lambda: grab_snmp_sysdescr(ip, timeout=2.0)
        )
        if sysdescr:
            result["snmp_sysdescr"] = sysdescr
            snmp = parse_snmp_sysdescr(sysdescr)
            if snmp.get("vendor"):
                vendor = snmp["vendor"]
                result["vendor"] = vendor
            if snmp.get("model"):
                result["model"] = snmp["model"]

    # Port fingerprint — fills model if still unknown
    fp = fingerprint_device(ip, vendor, open_ports)
    if not result["model"]:
        result["model"] = fp["model"]
    result["suggested_type"] = fp["suggested_type"]

    # Vendor fallback from model string (cross-subnet, no MAC)
    if not result["vendor"] and result["model"]:
        KNOWN_VENDORS = [
            "MikroTik", "Ubiquiti", "Hikvision", "Dahua", "ASUS", "Huawei",
            "Apple", "Samsung", "TP-Link", "Cisco", "VMware", "Reolink",
            "Axis", "Synology", "QNAP", "Xiaomi", "D-Link", "Netgear",
            "ZyXEL", "Tenda", "Fortinet", "Juniper", "Aruba",
        ]
        for v in KNOWN_VENDORS:
            if v.lower() in result["model"].lower():
                result["vendor"] = v
                break

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