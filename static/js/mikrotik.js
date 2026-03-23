// NetWatch — MikroTik RouterOS tab

// MIKROTIK TAB
// ══════════════════════════════════════════════════════════════════════════════

let _mtIp       = '';   // selected router IP
let _mtDhcpAll  = [];   // full DHCP lease list for client-side filter
let _mtSyslogTimer = null;

// ── Device selector ───────────────────────────────────────────────────────────
function mtPopulateDevices() {
  const sel = document.getElementById('mtDevSel');
  if (!sel) return;
  const cur = sel.value;
  const routers = allDevices.filter(d =>
    d.type === 'router' || d.type === 'ap' || (d.vendor||'').toLowerCase().includes('mikrotik')
  );
  sel.innerHTML = '<option value="">— оберіть роутер —</option>' +
    allDevices.map(d =>
      `<option value="${d.ip}">${d.name} (${d.ip})${d.cred_login ? '' : ' ⚠️ немає пароля'}</option>`
    ).join('');
  if (cur) sel.value = cur;
  else if (routers.length) sel.value = routers[0].ip;
}

function mtSelectDevice() {
  _mtIp = document.getElementById('mtDevSel')?.value || '';
  _setText('mtConnStatus', '');
  document.getElementById('mtResBar').style.display = 'none';
}

function mtOpenDeviceCard() {
  // Find device in allDevices and open edit modal
  const ip = document.getElementById('mtDevSel')?.value;
  if (!ip) { _setText('mtConnStatus', '⚠️ Спочатку оберіть пристрій'); return; }
  const dev = allDevices.find(d => d.ip === ip);
  if (!dev) { _setText('mtConnStatus', '⚠️ Пристрій не найдено в базе'); return; }
  // Switch to monitor tab and open modal
  switchTab('monitor', document.querySelector('.tab'));
  setTimeout(() => openEditModal(dev.id), 100);
}

async function mtConnect() {
  _mtIp = document.getElementById('mtDevSel')?.value || '';
  if (!_mtIp) { _setText('mtConnStatus', '⚠️ Оберіть пристрій'); return; }
  const st = document.getElementById('mtConnStatus');
  st.textContent = '⟳ Підключення...'; st.style.color = 'var(--muted)';

  // First check what credentials are stored
  try {
    const cr = await fetch(`/api/mt/${encodeURIComponent(_mtIp)}/check-creds`);
    const crd = await cr.json();
    if (!crd.has_login || !crd.has_password) {
      st.style.color = 'var(--red)';
      st.innerHTML = `❌ Немає облікових даних. 
        <span style="color:var(--yel)">Відкрийте карточку пристроїва → заполните Логін и Пароль</span>`;
      return;
    }
    // Show which login is being used
    st.textContent = `⟳ Подключение как «${crd.login}»...`;
  } catch(e) {}

  try {
    const r = await fetch(`/api/mt/${encodeURIComponent(_mtIp)}/status`);
    const d = await r.json();
    if (d.ok) {
      st.style.color = 'var(--green)';
      st.textContent = `✅ ${d.identity || _mtIp}`;
      _mtRenderResource(d.resource);
      const active = document.querySelector('.mst-active');
      const tab = active?.id?.replace('mst-','') || 'hotspot';
      mtSubTab(tab, document.getElementById('mst-'+tab));
    } else {
      st.style.color = 'var(--red)';
      // Provide helpful hints based on error
      let hint = '';
      const err = d.error || '';
      if (err.includes('invalid user') || err.includes('password')) {
        hint = ' — проверьте логин/пароль в карточке пристроїва';
      } else if (err.includes('закрито') || err.includes('8728')) {
        hint = ' — виконайте на MikroTik: /ip service enable api';
      } else if (err.includes('Таймаут')) {
        hint = ' — роутер недоступен або API вимкнений';
      }
      st.innerHTML = `❌ ${err}<span style="color:var(--yel);font-size:10px">${hint}</span>`;
    }
  } catch(e) {
    st.style.color = 'var(--red)';
    st.textContent = '❌ ' + e;
  }
}

function _mtRenderResource(res) {
  if (!res) return;
  const bar = document.getElementById('mtResBar');
  const cards = document.getElementById('mtResCards');
  if (!bar || !cards) return;
  bar.style.display = 'flex';
  const uptime = res['uptime'] || '—';
  const cpu    = res['cpu-load'] != null ? res['cpu-load'] + '%' : '—';
  const memT   = res['total-memory'];
  const memF   = res['free-memory'];
  const memPct = memT && memF ? Math.round((1 - memF/memT)*100) + '%' : '—';
  const ver    = res['version'] || '';
  const board  = res['board-name'] || '';
  cards.innerHTML = [
    ['⏱ Uptime', uptime, 'var(--green)'],
    ['⚙️ CPU', cpu, parseInt(cpu)>80?'var(--red)':parseInt(cpu)>50?'var(--yel)':'var(--green)'],
    ['💾 RAM', memPct, 'var(--cyan)'],
    ['📋 RouterOS', ver, 'var(--muted)'],
    ['🖥 Board', board, 'var(--muted)'],
  ].map(([l,v,c]) => `
    <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;
                padding:8px 12px;min-width:100px">
      <div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">${l}</div>
      <div style="font-size:13px;font-weight:700;color:${c}">${v}</div>
    </div>`).join('');
}

// ── Sub-tabs ──────────────────────────────────────────────────────────────────
function mtSubTab(name, el) {
  document.querySelectorAll('.mt-panel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('[id^="mst-"]').forEach(b => {
    b.style.borderBottomColor = 'transparent';
    b.style.color = 'var(--muted)';
    b.style.fontWeight = 'normal';
    b.classList.remove('mst-active');
  });
  const panel = document.getElementById('mt-' + name);
  const btn   = document.getElementById('mst-' + name);
  if (panel) panel.style.display = 'block';
  if (btn) {
    btn.style.borderBottomColor = 'var(--acc)';
    btn.style.color = 'var(--text)';
    btn.style.fontWeight = '700';
    btn.classList.add('mst-active');
  }
  if (!_mtIp) return;
  if (name === 'hotspot')  mtLoadHotspot();
  if (name === 'firewall') mtLoadFirewall();
  if (name === 'dhcp')     mtLoadDhcp();
  if (name === 'syslog')   mtLoadSyslog();
}

// ── HOTSPOT ───────────────────────────────────────────────────────────────────
async function mtLoadHotspot() {
  if (!_mtIp) return;
  const [sr, ur] = await Promise.all([
    fetch(`/api/mt/${_mtIp}/hotspot/active`).then(r=>r.json()).catch(()=>({ok:false,sessions:[]})),
    fetch(`/api/mt/${_mtIp}/hotspot/users`).then(r=>r.json()).catch(()=>({ok:false,users:[],profiles:[]})),
  ]);
  _mtRenderSessions(sr.sessions || []);
  _mtRenderUsers(ur.users || [], ur.profiles || []);
}

function _mtRenderSessions(sessions) {
  const el = document.getElementById('mtSessions');
  if (!sessions.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">Немає активних сесій</div>';
    return;
  }
  el.innerHTML = sessions.map(s => {
    const uptime = s['uptime'] || '—';
    const bytes  = s['bytes-in'] ? Math.round(+s['bytes-in']/1048576*10)/10 + ' МБ' : '—';
    return `<div style="display:flex;align-items:center;gap:7px;padding:7px 9px;
                background:var(--sf2);border-radius:7px;border:1px solid var(--bd)">
      <div style="width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s['user']||'—'}</div>
        <div style="font-size:10px;color:var(--muted)">${s['address']||''} · ${uptime} · ↓${bytes}</div>
      </div>
      <button onclick="mtKickSession('${s['.id']||''}')"
        style="background:var(--rd);border:1px solid var(--red);color:var(--red);
               padding:2px 8px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">
        Отключить
      </button>
    </div>`;
  }).join('');
}

function _mtRenderUsers(users, profiles) {
  const el  = document.getElementById('mtUsers');
  const sel = document.getElementById('mtNewProfile');
  if (sel && profiles.length) {
    sel.innerHTML = profiles.map(p => `<option value="${p.name||p['name']}">${p.name||p['name']}</option>`).join('');
  }
  if (!users.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">Немає користувачів</div>';
    return;
  }
  el.innerHTML = users.map(u => {
    const disabled = u['disabled'] === 'true';
    const limit    = u['rate-limit'] || '';
    const uptime   = u['limit-uptime'] || '';
    return `<div style="display:flex;align-items:center;gap:7px;padding:6px 9px;
                border-radius:6px;border:1px solid var(--bd);opacity:${disabled?0.4:1}">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:11px">${u['name']||'—'}</div>
        <div style="font-size:9px;color:var(--muted)">${u['profile']||''} ${limit?'· '+limit:''} ${uptime?'· '+uptime:''}</div>
      </div>
      <button onclick="mtDelUser('${u['.id']||''}')"
        style="background:none;border:1px solid var(--bd);color:var(--muted);
               padding:2px 6px;border-radius:4px;font-size:10px;cursor:pointer;font-family:inherit">
        🗑
      </button>
    </div>`;
  }).join('');
}

async function mtAddUser() {
  const name  = document.getElementById('mtNewUser')?.value.trim();
  const pass  = document.getElementById('mtNewPass')?.value;
  const rate  = document.getElementById('mtNewRate')?.value.trim();
  const prof  = document.getElementById('mtNewProfile')?.value;
  const st    = document.getElementById('mtUserStatus');
  if (!name) { st.textContent = '⚠️ Введите логин'; return; }
  st.textContent = '⟳ Добавление...'; st.style.color = 'var(--muted)';
  const r = await fetch(`/api/mt/${_mtIp}/hotspot/users`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name, password: pass, profile: prof, rate_limit: rate}),
  });
  const d = await r.json();
  if (d.ok) {
    st.style.color = 'var(--green)'; st.textContent = '✅ Добавлен';
    document.getElementById('mtNewUser').value = '';
    document.getElementById('mtNewPass').value = '';
    setTimeout(() => mtLoadHotspot(), 500);
  } else {
    st.style.color = 'var(--red)'; st.textContent = '❌ ' + d.error;
  }
  setTimeout(() => st.textContent = '', 4000);
}

async function mtDelUser(id) {
  if (!confirm('Видалити користувача?')) return;
  const r = await fetch(`/api/mt/${_mtIp}/hotspot/users/${id}`, {method:'DELETE'});
  const d = await r.json();
  if (d.ok) mtLoadHotspot();
  else alert(d.error);
}

async function mtKickSession(id) {
  const r = await fetch(`/api/mt/${_mtIp}/hotspot/sessions/${id}`, {method:'DELETE'});
  const d = await r.json();
  if (d.ok) mtLoadHotspot();
  else alert(d.error);
}

// ── FIREWALL ──────────────────────────────────────────────────────────────────
async function mtLoadFirewall() {
  if (!_mtIp) return;
  const [fr, ar] = await Promise.all([
    fetch(`/api/mt/${_mtIp}/firewall/filter`).then(r=>r.json()).catch(()=>({ok:false,rules:[]})),
    fetch(`/api/mt/${_mtIp}/firewall/address-list`).then(r=>r.json()).catch(()=>({ok:false,entries:[]})),
  ]);
  _mtRenderFwRules(fr.rules || []);
  _mtRenderAddrList(ar.entries || []);
}

function _mtRenderFwRules(rules) {
  const el = document.getElementById('mtFwRules');
  if (!rules.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:8px">Нет правил / нет подключения</div>';
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="font-size:9px;color:var(--muted);text-transform:uppercase">
      <th style="padding:4px 6px;text-align:left">#</th>
      <th style="padding:4px 6px;text-align:left">Chain</th>
      <th style="padding:4px 6px;text-align:left">Action</th>
      <th style="padding:4px 6px;text-align:left">Src/Dst</th>
      <th style="padding:4px 6px;text-align:left">Комментарий</th>
      <th style="padding:4px 6px;text-align:center">Вкл</th>
    </tr></thead>
    <tbody>${rules.map((r,i) => {
      const disabled = r['disabled'] === 'true';
      const action   = r['action'] || '—';
      const chain    = r['chain'] || '—';
      const src      = r['src-address'] || r['src-address-list'] || '';
      const dst      = r['dst-address'] || r['dst-address-list'] || '';
      const addr     = [src && '→'+src, dst && '→'+dst].filter(Boolean).join(' ');
      const comment  = r['comment'] || '';
      const aCol = action==='drop'?'var(--red)':action==='accept'?'var(--green)':'var(--yel)';
      return `<tr style="border-top:1px solid var(--bd);opacity:${disabled?0.4:1}">
        <td style="padding:5px 6px;color:var(--muted)">${r['.id']||i}</td>
        <td style="padding:5px 6px;font-family:'JetBrains Mono',monospace;font-size:10px">${chain}</td>
        <td style="padding:5px 6px;color:${aCol};font-weight:700;font-size:10px">${action}</td>
        <td style="padding:5px 6px;font-size:10px;color:var(--muted)">${addr}</td>
        <td style="padding:5px 6px;font-size:10px;color:var(--muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${comment}</td>
        <td style="padding:5px 6px;text-align:center">
          <label style="cursor:pointer">
            <input type="checkbox" ${!disabled?'checked':''} onchange="mtToggleFwRule('${r['.id']||''}',this.checked)"
              style="cursor:pointer">
          </label>
        </td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

async function mtToggleFwRule(id, enabled) {
  const r = await fetch(`/api/mt/${_mtIp}/firewall/filter/${id}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({enabled}),
  });
  const d = await r.json();
  if (!d.ok) { alert(d.error); mtLoadFirewall(); }
}

function _mtRenderAddrList(entries) {
  const el = document.getElementById('mtAddrList');
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:8px;font-size:11px">Список адресов пуст</div>';
    return;
  }
  el.innerHTML = entries.map(e => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:5px;border:1px solid var(--bd);margin-bottom:3px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;flex:1">${e['address']||'—'}</span>
      <span style="font-size:10px;color:var(--yel);padding:1px 7px;background:var(--yd);border-radius:10px">${e['list']||''}</span>
      <span style="font-size:10px;color:var(--muted)">${e['comment']||''}</span>
      <button onclick="mtAddrListDel('${e['.id']||''}')"
        style="background:none;border:1px solid var(--bd);color:var(--muted);padding:1px 6px;
               border-radius:4px;font-size:10px;cursor:pointer;font-family:inherit">✕</button>
    </div>`).join('');
}

async function mtBlockIP() {
  const ip   = document.getElementById('mtBlockIp')?.value.trim();
  const list = document.getElementById('mtBlockList')?.value;
  if (!ip) return;
  const r = await fetch(`/api/mt/${_mtIp}/firewall/address-list`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({address: ip, list, comment: 'Blocked via NetWatch'}),
  });
  const d = await r.json();
  if (d.ok) {
    document.getElementById('mtBlockIp').value = '';
    mtLoadFirewall();
  } else alert(d.error);
}

async function mtAddrListDel(id) {
  const r = await fetch(`/api/mt/${_mtIp}/firewall/address-list/${id}`, {method:'DELETE'});
  const d = await r.json();
  if (d.ok) mtLoadFirewall(); else alert(d.error);
}

// ── DHCP ──────────────────────────────────────────────────────────────────────
async function mtLoadDhcp() {
  if (!_mtIp) return;
  const r = await fetch(`/api/mt/${_mtIp}/dhcp`).then(r=>r.json()).catch(()=>({ok:false,leases:[]}));
  _mtDhcpAll = r.leases || [];
  mtFilterDhcp();
}

function mtFilterDhcp() {
  const q = (document.getElementById('mtDhcpSearch')?.value||'').toLowerCase();
  const rows = q ? _mtDhcpAll.filter(l =>
    (l['mac-address']||'').toLowerCase().includes(q) ||
    (l['address']||'').includes(q) ||
    (l['host-name']||'').toLowerCase().includes(q)
  ) : _mtDhcpAll;
  _mtRenderDhcp(rows);
}

function _mtRenderDhcp(leases) {
  const tbody = document.getElementById('mtDhcpBody');
  if (!leases.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">Нет лзов</td></tr>';
    return;
  }
  tbody.innerHTML = leases.map(l => {
    const isStatic = l['dynamic'] === 'false' || l['type'] === 'static';
    const expires  = l['expires-after'] || '∞';
    const status   = l['status'] || '';
    const dotCol   = status === 'bound' ? 'var(--green)' : 'var(--muted)';
    return `<tr style="border-top:1px solid var(--bd)"
              onmouseover="this.style.background='var(--sf2)'"
              onmouseout="this.style.background=''">
      <td style="padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:10px">${l['mac-address']||'—'}</td>
      <td style="padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:11px">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dotCol};margin-right:5px"></span>
        ${l['address']||'—'}
      </td>
      <td style="padding:6px 8px;font-size:11px">${l['host-name']||'—'}</td>
      <td style="padding:6px 8px;text-align:center">
        <span style="font-size:9px;padding:2px 7px;border-radius:10px;
              background:${isStatic?'var(--ad)':'var(--sf2)'};
              color:${isStatic?'var(--acc)':'var(--muted)'}">
          ${isStatic?'статик':'динамик'}
        </span>
      </td>
      <td style="padding:6px 8px;font-size:10px;color:var(--muted)">${l['server']||'—'}</td>
      <td style="padding:6px 8px;font-size:10px;color:var(--muted)">${expires}</td>
      <td style="padding:6px 8px;text-align:center;white-space:nowrap">
        ${!isStatic ? `<button onclick="mtMakeStatic('${l['.id']||''}')"
          style="background:var(--ad);border:1px solid var(--acc);color:var(--acc);
                 padding:2px 8px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">
          📌 Статик
        </button>` : ''}
        <button onclick="mtDelLease('${l['.id']||''}')"
          style="background:none;border:1px solid var(--bd);color:var(--muted);
                 padding:2px 6px;border-radius:4px;font-size:9px;cursor:pointer;margin-left:3px;font-family:inherit">
          🗑
        </button>
      </td>
    </tr>`;
  }).join('');
}

async function mtMakeStatic(id) {
  const r = await fetch(`/api/mt/${_mtIp}/dhcp/${id}/static`, {method:'POST'});
  const d = await r.json();
  if (d.ok) mtLoadDhcp(); else alert(d.error);
}

async function mtDelLease(id) {
  if (!confirm('Видалити лз?')) return;
  const r = await fetch(`/api/mt/${_mtIp}/dhcp/${id}`, {method:'DELETE'});
  const d = await r.json();
  if (d.ok) mtLoadDhcp(); else alert(d.error);
}

// ── SYSLOG ────────────────────────────────────────────────────────────────────
async function mtLoadSyslog() {
  const topic  = document.getElementById('mtSyslogTopic')?.value || '';
  const src    = document.getElementById('mtSyslogSrc')?.value || '';
  const search = document.getElementById('mtSyslogSearch')?.value || '';
  const r = await fetch(`/api/syslog?topic=${encodeURIComponent(topic)}&src_ip=${encodeURIComponent(src)}&search=${encodeURIComponent(search)}&limit=200`)
    .then(r=>r.json()).catch(()=>({ok:false,running:false,entries:[]}));
  const st = document.getElementById('mtSyslogStatus');
  if (st) {
    st.textContent = r.running ? '🟢 Працює' : '🔴 Остановлен';
    st.style.color = r.running ? 'var(--green)' : 'var(--red)';
  }
  _mtRenderSyslog(r.entries || []);
}

function _mtRenderSyslog(entries) {
  const el = document.getElementById('mtSyslogEntries');
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:10px">Немає записів</div>';
    return;
  }
  const SEV_COL = {emerg:'var(--red)',alert:'var(--red)',crit:'var(--red)',
                   err:'var(--red)',warning:'var(--yel)',notice:'var(--cyan)',
                   info:'var(--muted)',debug:'var(--muted)'};
  el.innerHTML = entries.map(e => {
    const d   = new Date(e.ts * 1000);
    const ts  = d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'}) +
                ' ' + d.toLocaleTimeString('ru-RU');
    const col = SEV_COL[e.severity] || 'var(--muted)';
    return `<div style="display:flex;gap:7px;padding:3px 6px;border-radius:4px;align-items:baseline;
                font-size:11px"
              onmouseover="this.style.background='var(--sf2)'"
              onmouseout="this.style.background=''">
      <span style="color:var(--muted);white-space:nowrap;font-size:10px">${ts}</span>
      <span style="font-size:12px">${e.icon}</span>
      <span style="color:${col};min-width:55px;font-size:10px">${e.severity}</span>
      <span style="color:var(--acc);min-width:45px;font-size:10px">${e.src_ip}</span>
      <span style="color:var(--text)">${e.msg}</span>
    </div>`;
  }).join('');
}

async function mtSyslogStart() {
  const port = parseInt(document.getElementById('mtSyslogPort')?.value) || 514;
  const r = await fetch('/api/syslog/start', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({port}),
  });
  const d = await r.json();
  const st = document.getElementById('mtSyslogStatus');
  if (d.ok) {
    st.textContent = '🟢 Працює на порту ' + port;
    st.style.color = 'var(--green)';
    // Auto-refresh every 3s
    if (_mtSyslogTimer) clearInterval(_mtSyslogTimer);
    _mtSyslogTimer = setInterval(mtLoadSyslog, 3000);
  } else {
    st.textContent = '❌ ' + (d.error || 'Помилка');
    st.style.color = 'var(--red)';
  }
}

async function mtSyslogStop() {
  if (_mtSyslogTimer) { clearInterval(_mtSyslogTimer); _mtSyslogTimer = null; }
  await fetch('/api/syslog/stop', {method:'POST'});
  const st = document.getElementById('mtSyslogStatus');
  if (st) { st.textContent = '🔴 Остановлен'; st.style.color = 'var(--red)'; }
}

async function mtSyslogClear() {
  await fetch('/api/syslog/clear', {method:'DELETE'});
  mtLoadSyslog();
}

// mikrotik handled in main switchTab below


// ══════════════════════════════════════════════════════════════════════════════
