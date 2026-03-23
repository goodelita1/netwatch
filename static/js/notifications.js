// NetWatch — Notifications: Discord, Email, Webhook, Sound, Backup, Audit

// DISCORD
// ══════════════════════════════════════════════════════════════════════════════
async function loadDiscord() {
  try {
    const r = await fetch('/api/discord'); const d = await r.json();
    document.getElementById('discordEnabled').checked   = !!d.enabled;
    document.getElementById('discordPower').checked     = d.notify_power !== false;
    document.getElementById('discordDevice').checked    = d.notify_device !== false;
    document.getElementById('discordHost').checked      = d.notify_new_host !== false;
  } catch(e) {}
}
async function saveDiscord() {
  const d = {
    webhook_url:    document.getElementById('discordUrl').value.trim(),
    enabled:        document.getElementById('discordEnabled').checked,
    notify_power:   document.getElementById('discordPower').checked,
    notify_device:  document.getElementById('discordDevice').checked,
    notify_new_host:document.getElementById('discordHost').checked,
  };
  const r = await fetch('/api/discord', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)});
  const res = await r.json();
  const st = document.getElementById('discordStatus');
  st.textContent = res.ok ? '✅ Збережено' : '❌ Помилка';
  setTimeout(()=>st.textContent='', 3000);
}
async function testDiscord() {
  const st = document.getElementById('discordTestStatus');
  st.textContent = '⟳ Надсилання...';
  const r = await fetch('/api/discord/test', {method:'POST'});
  const d = await r.json();
  st.textContent = d.ok ? '✅ Надіслано!' : '❌ Помилка';
  setTimeout(()=>st.textContent='', 4000);
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════════════════════════════
async function loadEmail() {
  try {
    const r = await fetch('/api/email'); const d = await r.json();
    document.getElementById('smtpHost').value    = d.smtp_host || '';
    document.getElementById('smtpPort').value    = d.smtp_port || 587;
    document.getElementById('smtpUser').value    = d.smtp_user || '';
    document.getElementById('smtpFrom').value    = d.smtp_from || '';
    document.getElementById('smtpTo').value      = d.smtp_to || '';
    document.getElementById('smtpTls').checked   = d.use_tls !== false;
    document.getElementById('emailEnabled').checked = !!d.enabled;
  } catch(e) {}
}
async function saveEmail() {
  const d = {
    smtp_host:    document.getElementById('smtpHost').value.trim(),
    smtp_port:    parseInt(document.getElementById('smtpPort').value) || 587,
    smtp_user:    document.getElementById('smtpUser').value.trim(),
    smtp_password:document.getElementById('smtpPass').value,
    smtp_from:    document.getElementById('smtpFrom').value.trim(),
    smtp_to:      document.getElementById('smtpTo').value.trim(),
    use_tls:      document.getElementById('smtpTls').checked,
    enabled:      document.getElementById('emailEnabled').checked,
  };
  const r = await fetch('/api/email', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)});
  const res = await r.json();
  const st = document.getElementById('emailStatus');
  st.textContent = res.ok ? '✅ Збережено' : '❌ Помилка';
  setTimeout(()=>st.textContent='', 3000);
}
async function testEmail() {
  const st = document.getElementById('emailTestStatus');
  st.textContent = '⟳ Надсилання...';
  const r = await fetch('/api/email/test', {method:'POST'});
  const d = await r.json();
  st.textContent = d.ok ? '✅ Надіслано!' : '❌ Помилка (проверьте консоль сервера)';
  setTimeout(()=>st.textContent='', 5000);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════════════════════════════════════════════
async function loadWebhook() {
  try {
    const r = await fetch('/api/webhook'); const d = await r.json();
    document.getElementById('webhookUrl').value         = d.url || '';
    document.getElementById('webhookEnabled').checked   = !!d.enabled;
    document.getElementById('webhookPower').checked     = d.notify_power !== false;
    document.getElementById('webhookDevice').checked    = d.notify_device !== false;
    document.getElementById('webhookHost').checked      = d.notify_new_host !== false;
  } catch(e) {}
}
async function saveWebhook() {
  const d = {
    url:            document.getElementById('webhookUrl').value.trim(),
    enabled:        document.getElementById('webhookEnabled').checked,
    notify_power:   document.getElementById('webhookPower').checked,
    notify_device:  document.getElementById('webhookDevice').checked,
    notify_new_host:document.getElementById('webhookHost').checked,
  };
  const r = await fetch('/api/webhook', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)});
  const res = await r.json();
  const st = document.getElementById('webhookTestStatus');
  st.textContent = res.ok ? '✅ Збережено' : '❌ Помилка';
  setTimeout(()=>st.textContent='', 3000);
}
async function testWebhook() {
  const st = document.getElementById('webhookTestStatus');
  st.textContent = '⟳ Надсилання...';
  const r = await fetch('/api/webhook/test', {method:'POST'});
  const d = await r.json();
  st.textContent = d.ok ? '✅ Надіслано!' : '❌ Помилка';
  setTimeout(()=>st.textContent='', 4000);
}

// ══════════════════════════════════════════════════════════════════════════════
// SOUND (Web Audio API — никаких файлов, синтез в браузере)
// ══════════════════════════════════════════════════════════════════════════════
let _soundCtx = null;
let _soundSettings = { enabled: false, up: false, volume: 0.5 };

function _getSoundCtx() {
  if (!_soundCtx) _soundCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _soundCtx;
}

function playSound(type) {
  // type: 'down' = тривожний спадний, 'up' = мягкий восходящий
  const vol = (_soundSettings.volume || 50) / 100;
  if (vol <= 0) return;
  try {
    const ctx = _getSoundCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol * 0.4, ctx.currentTime);
    gain.connect(ctx.destination);
    const freqs = type === 'down' ? [880, 660, 440] : [440, 660, 880];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type === 'down' ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.11);
    });
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  } catch(e) {}
}

function playTestSound(type) { playSound(type); }

function saveSoundSettings() {
  _soundSettings = {
    enabled: document.getElementById('soundEnabled').checked,
    up:      document.getElementById('soundUp').checked,
    volume:  parseInt(document.getElementById('soundVolume').value),
  };
  localStorage.setItem('netwatch_sound', JSON.stringify(_soundSettings));
}

function loadSoundSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('netwatch_sound') || '{}');
    _soundSettings = { enabled: false, up: false, volume: 50, ...s };
    document.getElementById('soundEnabled').checked = !!_soundSettings.enabled;
    document.getElementById('soundUp').checked      = !!_soundSettings.up;
    document.getElementById('soundVolume').value    = _soundSettings.volume;
    document.getElementById('soundVolLbl').textContent = _soundSettings.volume + '%';
  } catch(e) {}
}

// Hook into event stream — play sound when new down/up events arrive
let _lastEventTs = 0;
function _checkNewEventsForSound(events) {
  if (!_soundSettings.enabled || !events.length) return;
  const fresh = events.filter(e => e.ts > _lastEventTs);
  if (!fresh.length) return;
  _lastEventTs = Math.max(...fresh.map(e => e.ts));
  const hasDown = fresh.some(e => e.kind === 'down' || e.kind === 'power_off');
  const hasUp   = fresh.some(e => e.kind === 'up'   || e.kind === 'power_on');
  if (hasDown) playSound('down');
  else if (hasUp && _soundSettings.up) playSound('up');
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKUP
// ══════════════════════════════════════════════════════════════════════════════
async function createBackup() {
  const st = document.getElementById('backupStatus');
  st.textContent = '⟳ Створюємо...';
  try {
    const r = await fetch('/api/backup', {method:'POST'});
    const d = await r.json();
    st.textContent = d.ok ? '✅ Создан: ' + (d.path || '').split('/').pop() : '❌ Помилка';
    loadBackupList();
  } catch(e) { st.textContent = '❌ ' + e; }
  setTimeout(()=>st.textContent='', 5000);
}

async function loadBackupList() {
  try {
    const r = await fetch('/api/backup/list');
    const items = await r.json();
    const el = document.getElementById('backupList');
    if (!items.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:11px">Резервних копій немає</div>';
      return;
    }
    el.innerHTML = items.map(b => {
      const d = new Date(b.created_at * 1000);
      const ts = d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU');
      return `<div style="display:flex;justify-content:space-between;padding:5px 8px;
                background:var(--sf2);border-radius:5px;font-size:11px;
                font-family:'JetBrains Mono',monospace">
        <span style="color:var(--text)">${b.name}</span>
        <span style="color:var(--muted)">${b.size_kb} КБ · ${ts}</span>
      </div>`;
    }).join('');
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ══════════════════════════════════════════════════════════════════════════════
const _AUDIT_ICONS = {
  login_ok:'🟢', login_fail:'🔴', login_blocked:'⛔',
  reboot:'🔄', device_added:'➕', device_deleted:'🗑',
};

async function loadAudit() {
  try {
    const r = await fetch('/api/audit?limit=200');
    const rows = await r.json();
    const el = document.getElementById('auditList');
    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--muted)">Записів немає</div>';
      return;
    }
    el.innerHTML = rows.map(row => {
      const d = new Date(row.ts * 1000);
      const ts = d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})
               + ' ' + d.toLocaleTimeString('ru-RU');
      const icon = _AUDIT_ICONS[row.action] || 'ℹ️';
      const col  = row.action.includes('fail') || row.action.includes('block')
                   ? 'var(--red)' : row.action === 'login_ok' ? 'var(--green)' : 'var(--text)';
      return `<div style="display:flex;gap:8px;padding:3px 6px;border-radius:4px;align-items:baseline">
        <span style="color:var(--muted);white-space:nowrap;font-size:10px">${ts}</span>
        <span>${icon}</span>
        <span style="color:${col};font-weight:700">${row.action}</span>
        <span style="color:var(--muted)">${row.user || ''}</span>
        <span style="color:var(--muted)">${row.client_ip || ''}</span>
        <span style="color:var(--muted);font-size:10px">${row.detail || ''}</span>
      </div>`;
    }).join('');
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// Unified tab init hooks — ONE place for all tab open handlers
// ══════════════════════════════════════════════════════════════════════════════
async function _loadSettingsAll() {
  loadTg();
  loadDiscord();
  loadEmail();
  loadWebhook();
  loadBackupList();
  loadSoundSettings();
  load2FAStatus();
}

// Single switchTab extension covering all custom tabs
{
  const _origSwitchTab = switchTab;
  window.switchTab = function(name, el) {
    _origSwitchTab(name, el);
    if (name === 'topology')   loadTopology();
    if (name === 'traceroute') initTraceDevSelect();
    if (name === 'dashboard')  loadDashboard();
    if (name === 'sla')        loadSLA();
    if (name === 'settings')   _loadSettingsAll();
    if (name === 'mikrotik')  { mtPopulateDevices(); mtSubTab('hotspot', document.getElementById('mst-hotspot')); }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
