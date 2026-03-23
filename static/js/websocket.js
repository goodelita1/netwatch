// NetWatch — WebSocket real-time updates

// WEBSOCKET — real-time device status updates
// ══════════════════════════════════════════════════════════════════════════════

let _ws         = null;   // socket.io instance
let _wsConnected = false;  // true = WS active, false = fallback polling
let _wsReconnectTimer = null;

async function _initWebSocket() {
  if (typeof io === 'undefined') {
    console.warn('[ws] socket.io not loaded — fallback to polling');
    _startFallbackPolling();
    return;
  }

  // Fetch a short-lived token so WS auth works regardless of eventlet session quirks
  let wsToken = '';
  try {
    const tr = await fetch('/api/ws-token');
    if (tr.ok) { const td = await tr.json(); wsToken = td.token || ''; }
  } catch(e) { console.warn('[ws] token fetch failed:', e); }

  // Try WebSocket upgrade through nginx, fallback to polling
  _ws = io(window.location.origin, {
    transports:        ['websocket', 'polling'],
    upgrade:           true,
    reconnection:      true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout:           15000,
    query:             wsToken ? { token: wsToken } : {},
  });

  // ── Connection lifecycle ────────────────────────────────────────────────────
  _ws.on('connect', () => {
    _wsConnected = true;
    const transport = _ws.io.engine.transport.name;
    console.log('[ws] connected:', _ws.id, 'transport:', transport);
    _wsSetIndicator(true, transport);
  });

  // Log transport upgrades
  _ws.io.engine.on('upgrade', (transport) => {
    console.log('[ws] upgraded to:', transport.name);
    _wsSetIndicator(true, transport.name);
  });

  _ws.on('disconnect', (reason) => {
    _wsConnected = false;
    _wsSetIndicator(false);
    console.warn('[ws] disconnected:', reason);
    // socket.io handles reconnection automatically via reconnection:true
    // do NOT manually call _ws.connect() here — causes double reconnect
  });

  _ws.on('connect_error', (err) => {
    _wsConnected = false;
    _wsSetIndicator(false);
    console.warn('[ws] connect error:', err.message);
  });

  // ── Server events ───────────────────────────────────────────────────────────

  // Server says token missing — reconnect with fresh token
  _ws.on('auth_required', () => {
    console.log('[ws] auth_required — fetching fresh token and reconnecting');
    _ws.disconnect();
    setTimeout(async () => {
      try {
        const tr = await fetch('/api/ws-token');
        if (tr.ok) {
          const td = await tr.json();
          _ws.io.opts.query = { token: td.token };
        }
      } catch(e) {}
      _ws.connect();
    }, 1000);
  });

  // Initial snapshot — server sends current state of all devices on connect
  _ws.on('connected', (data) => {
    try {
      if (!data?.devices) return;
      data.devices.forEach(upd => {
        const dev = allDevices.find(d => d.ip === upd.ip);
        if (dev) {
          if (upd.online  !== undefined) dev.online  = upd.online;
          if (upd.latency !== undefined) dev.latency = upd.latency;
          if (upd.mac)    dev.mac    = upd.mac;
          if (upd.vendor) dev.vendor = upd.vendor;
          if (upd.model)  dev.model  = upd.model;
        }
      });
      render();
      _wsUpdateSummary();
    } catch(e) {
      console.error('[ws] connected handler error:', e);
    }
  });

  // Single device status/latency changed
  _ws.on('device_update', (upd) => {
    try {
      if (!upd?.ip) return;
      const dev = allDevices.find(d => d.ip === upd.ip);
      if (!dev) return;
      const prev = dev.online;
      dev.online  = upd.online;
      dev.latency = upd.latency;
      _updatePingCell(upd.ip, upd.online, upd.latency);
      _wsUpdateSummary();
      if (prev !== upd.online) {
        if (upd.online === false) playSound('down');
        else if (upd.online === true && _soundSettings?.up) playSound('up');
      }
    } catch(e) { console.error('[ws] device_update error:', e); }
  });

  // New log event
  _ws.on('new_event', (ev) => {
    try {
      if (!ev) return;
      allEvents.push(ev);
      if (allEvents.length > 300) allEvents.shift();
      if (document.getElementById('tab-events')?.classList.contains('active')) {
        renderEvents();
      }
      _checkNewEventsForSound([ev]);
      if (ev.kind === 'new_host') fetchAutoScan();
    } catch(e) { console.error('[ws] new_event error:', e); }
  });

  // Auto-scan found new hosts/subnets
  _ws.on('autoscan_update', (data) => {
    fetchAutoScan();  // refresh the autoscan dropdown
  });

  // Scan cycle completed — update summary counters
  _ws.on('scan_done', (data) => {
    _wsUpdateSummary();
  });
}

// ── WS indicator in header ────────────────────────────────────────────────────
function _wsSetIndicator(connected, transport) {
  const el = document.getElementById('wsIndicator');
  if (!el) return;
  if (connected) {
    const isWS = transport === 'websocket';
    el.textContent      = isWS ? '⚡ Live' : '⟳ Live';
    el.title            = isWS ? 'WebSocket — real-time' : 'Polling — оновлення кожні ~25с';
    el.style.background = isWS ? 'rgba(0,230,118,.15)' : 'rgba(61,127,255,.15)';
    el.style.color      = isWS ? 'var(--green)'        : 'var(--acc)';
  } else {
    el.textContent      = '↻ Poll';
    el.title            = 'Немає з\'єднання — fallback polling';
    el.style.background = 'rgba(255,179,0,.15)';
    el.style.color      = 'var(--yel)';
  }
}

// ── Summary counter quick update without full re-render ───────────────────────
function _wsUpdateSummary() {
  const online  = allDevices.filter(d => d.online === true).length;
  const offline = allDevices.filter(d => d.online === false).length;
  _setText('sumOnline',  online);
  _setText('sumOffline', offline);
  _setText('sumTotal',   allDevices.length);

  // Update power banner
  const gw = allDevices.find(d => d.ip === '192.168.88.1');
  const banner = document.getElementById('powerBanner');
  if (banner && gw) {
    banner.style.display = gw.online === false ? 'flex' : 'none';
  }
}

// ── Fallback: if WS never connects, keep original polling ─────────────────────
function _startFallbackPolling() {
  setInterval(fetchDevices, 15000);
  setInterval(fetchEvents,  10000);
}

// ── Expose manual ping via WS (faster than REST round-trip) ──────────────────
function wsPingDevice(ip) {
  if (_ws && _wsConnected) {
    _ws.emit('ping_request', { ip });
  }
}