// NetWatch — SNMP modal (Winbox-style, live Tx/Rx)

// SNMP STATS MODAL
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// SNMP MODAL — Winbox-style full interface table + live Tx/Rx
// ══════════════════════════════════════════════════════════════════════════════

let _snmpTrafficInterval = null;
let _snmpCurrentIp = null;
let _snmpCommunity = 'public';
let _snmpTrafficData = {};  // index → {rx_bps, tx_bps, rx_pps, tx_pps}

async function openSnmpModal(ip, name) {
  _snmpCurrentIp = ip;
  const modal = document.getElementById('snmpModal');
  document.getElementById('snmpModalTitle').textContent = `📊 ${name} (${ip})`;
  document.getElementById('snmpModalBody').innerHTML =
    '<div style="text-align:center;padding:30px;color:var(--muted);font-size:12px">⟳ Опрос SNMP...</div>';
  modal.classList.add('open');
  _stopSnmpTraffic();

  try {
    const r = await fetch(`/api/snmp/${encodeURIComponent(ip)}?community=${_snmpCommunity}`);
    const d = await r.json();
    renderSnmpModal(d, ip);
    if (d.ok && d.interfaces.length) {
      _startSnmpTraffic(ip);
    }
  } catch(e) {
    document.getElementById('snmpModalBody').innerHTML =
      `<div style="color:var(--red);font-size:12px;padding:12px">❌ Помилка: ${e}</div>`;
  }
}

function closeSnmpModal() {
  _stopSnmpTraffic();
  _snmpCurrentIp = null;
  document.getElementById('snmpModal').classList.remove('open');
}

function _stopSnmpTraffic() {
  if (_snmpTrafficInterval) { clearInterval(_snmpTrafficInterval); _snmpTrafficInterval = null; }
}

function _startSnmpTraffic(ip) {
  // Poll traffic endpoint (takes ~2s per call due to two-sample measurement)
  const poll = async () => {
    if (!_snmpCurrentIp || _snmpCurrentIp !== ip) return;
    try {
      const r = await fetch(`/api/snmp/${encodeURIComponent(ip)}/traffic?community=${_snmpCommunity}`);
      const d = await r.json();
      if (d.traffic) {
        _snmpTrafficData = d.traffic;
        _updateTrafficCells();
      }
    } catch(e) {}
  };
  poll(); // immediate first call
  _snmpTrafficInterval = setInterval(poll, 4000);
}

function _updateTrafficCells() {
  Object.entries(_snmpTrafficData).forEach(([idx, t]) => {
    const rxEl  = document.getElementById(`snmp_rx_${idx}`);
    const txEl  = document.getElementById(`snmp_tx_${idx}`);
    const rxpEl = document.getElementById(`snmp_rxp_${idx}`);
    const txpEl = document.getElementById(`snmp_txp_${idx}`);
    if (rxEl && t.rx_bps != null) rxEl.textContent = _fmtBps(t.rx_bps);
    if (txEl && t.tx_bps != null) txEl.textContent = _fmtBps(t.tx_bps);
    if (rxpEl && t.rx_pps != null) rxpEl.textContent = t.rx_pps.toFixed(0) + ' p/s';
    if (txpEl && t.tx_pps != null) txpEl.textContent = t.tx_pps.toFixed(0) + ' p/s';
    // Highlight active interfaces
    const row = document.getElementById(`snmp_row_${idx}`);
    if (row && (t.rx_bps > 0 || t.tx_bps > 0)) {
      row.style.background = 'var(--gd)';
      setTimeout(() => { if(row) row.style.background = ''; }, 800);
    }
  });
}

function _fmtBps(bps) {
  if (bps == null) return '—';
  if (bps === 0)   return '0 bps';
  if (bps >= 1e9)  return (bps/1e9).toFixed(2) + ' Gbps';
  if (bps >= 1e6)  return (bps/1e6).toFixed(1) + ' Mbps';
  if (bps >= 1e3)  return (bps/1e3).toFixed(0) + ' Kbps';
  return bps + ' bps';
}

function _fmtOctets(n) {
  if (n == null) return '—';
  if (n >= 1073741824) return (n/1073741824).toFixed(2) + ' ГБ';
  if (n >= 1048576)    return (n/1048576).toFixed(1) + ' МБ';
  if (n >= 1024)       return (n/1024).toFixed(0) + ' КБ';
  return n + ' Б';
}

function _fmtSpeed(bps) {
  if (!bps) return '';
  if (bps >= 1e9)  return (bps/1e9).toFixed(0) + ' Гбит';
  if (bps >= 1e6)  return (bps/1e6).toFixed(0) + ' Мбит';
  if (bps >= 1e3)  return (bps/1e3).toFixed(0) + ' Кбит';
  return bps + ' б/с';
}

const IF_ICONS = {
  ethernet: '⬡', wifi: '◈', bridge: '⬢', loopback: '○',
  tunnel: '⤳', virtual: '▫', ppp: '⤳', default: '◇'
};

function renderSnmpModal(d, ip) {
  const body = document.getElementById('snmpModalBody');
  if (!d.ok) {
    body.innerHTML = `
      <div style="padding:12px 14px;background:var(--rd);border:1px solid #ff3d5740;border-radius:8px;color:var(--red);font-size:12px;margin-bottom:14px">
        ⚠️ ${d.error || 'Пристрій не відветило на SNMP'}
      </div>
      <div style="font-size:11px;color:var(--muted);line-height:2">
        <b>На MikroTik включить SNMP:</b><br>
        IP → SNMP → Enable = yes, Community = public<br>
        або: <code>/snmp set enabled=yes</code><br><br>
        <b>Cisco:</b> <code>snmp-server community public RO</code>
      </div>`;
    return;
  }

  // ── Header: uptime, name, CPU, RAM ───────────────────────────────────────
  const cpuCol = d.cpu_pct == null ? 'var(--muted)' :
    d.cpu_pct < 50 ? 'var(--green)' : d.cpu_pct < 80 ? 'var(--yel)' : 'var(--red)';
  const memPct = d.mem_used_pct;
  const memCol = memPct == null ? 'var(--muted)' :
    memPct < 60 ? 'var(--green)' : memPct < 85 ? 'var(--yel)' : 'var(--red)';

  let html = `
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:14px">
    <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:9px 11px">
      <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Uptime</div>
      <div style="font-size:12px;font-weight:700;color:var(--green)">${d.uptime_str || '—'}</div>
    </div>
    <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:9px 11px">
      <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Имя</div>
      <div style="font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.sysname || '—'}</div>
    </div>
    <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:9px 11px">
      <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">CPU</div>
      <div style="font-size:14px;font-weight:700;color:${cpuCol}">${d.cpu_pct != null ? d.cpu_pct + '%' : '—'}</div>
      ${d.cpu_pct != null ? `<div style="background:var(--bd);border-radius:2px;height:4px;margin-top:4px;overflow:hidden">
        <div style="height:100%;background:${cpuCol};width:${d.cpu_pct}%"></div>
      </div>` : ''}
    </div>
    <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:9px 11px">
      <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">RAM</div>
      <div style="font-size:11px;font-weight:700;color:${memCol}">
        ${d.mem_used_pct != null ? d.mem_used_pct + '%' : (d.mem_total_mb ? d.mem_total_mb + ' МБ' : '—')}
      </div>
      ${d.mem_total_mb ? `<div style="font-size:9px;color:var(--muted);margin-top:1px">
        ${d.mem_free_mb != null ? `своб. ${d.mem_free_mb} / ${d.mem_total_mb} МБ` : d.mem_total_mb + ' МБ total'}
      </div>` : ''}
      ${memPct != null ? `<div style="background:var(--bd);border-radius:2px;height:4px;margin-top:4px;overflow:hidden">
        <div style="height:100%;background:${memCol};width:${memPct}%"></div>
      </div>` : ''}
    </div>
  </div>`;

  // Extras row (voltage, temp, location)
  const extras = [];
  if (d.voltage_v)  extras.push(`⚡ ${d.voltage_v} В`);
  if (d.temp_c)     extras.push(`🌡 ${d.temp_c} °C`);
  if (d.location)   extras.push(`📍 ${d.location}`);
  if (d.contact)    extras.push(`👤 ${d.contact}`);
  if (extras.length) {
    html += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;font-size:10px;color:var(--muted)">
      ${extras.map(e => `<span style="background:var(--sf2);padding:3px 8px;border-radius:4px;border:1px solid var(--bd)">${e}</span>`).join('')}
    </div>`;
  }

  // sysDescr collapsed
  if (d.sysdescr) {
    html += `<div style="font-size:10px;color:var(--muted);padding:7px 10px;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;margin-bottom:12px;cursor:pointer;line-height:1.5"
      onclick="this.style.whiteSpace=this.style.whiteSpace==='normal'?'nowrap':'normal'"
      style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.sysdescr}</div>`;
  }

  // Community input
  html += `<div style="display:flex;gap:6px;align-items:center;margin-bottom:12px">
    <span style="font-size:10px;color:var(--muted);white-space:nowrap">Community:</span>
    <input id="snmpCommInput" value="${_snmpCommunity}"
      style="background:var(--sf2);border:1px solid var(--bd);color:var(--text);
             padding:4px 8px;border-radius:5px;font-family:inherit;font-size:11px;
             outline:none;width:120px"
      onchange="_snmpCommunity=this.value">
    <div id="snmpTrafficStatus" style="font-size:10px;color:var(--muted)">⟳ live трафік увімкнено</div>
  </div>`;

  // ── Interface table ───────────────────────────────────────────────────────
  if (d.interfaces.length) {
    html += `
    <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">
      Інтерфейси (${d.interfaces.length})
      <span style="font-size:9px;color:var(--acc);margin-left:6px">• живой трафік оновлюється кожні 4с</span>
    </div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
          <th style="padding:4px 6px;text-align:left;font-weight:500;white-space:nowrap">Интерфейс</th>
          <th style="padding:4px 6px;text-align:center;font-weight:500">Статус</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500">Швидкість</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500;color:var(--cyan)">Rx</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500;color:var(--green)">Tx</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500;color:var(--cyan)">Rx p/s</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500;color:var(--green)">Tx p/s</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500">↓ всего</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500">↑ всего</th>
        </tr>
      </thead>
      <tbody>`;

    d.interfaces.forEach(iface => {
      const up    = iface.oper === 'up';
      const adm   = iface.admin === 'up';
      const icon  = IF_ICONS[iface.type] || IF_ICONS.default;
      const dotCol = up ? 'var(--green)' : (adm ? 'var(--yel)' : 'var(--muted)');
      const rowBg  = up ? '' : 'opacity:.5';
      const typeCol = {
        ethernet:'var(--acc)', wifi:'var(--cyan)', bridge:'var(--pur)',
        loopback:'var(--muted)', tunnel:'var(--yel)', virtual:'var(--muted)'
      }[iface.type] || 'var(--muted)';

      // Status badge
      let statusBadge = '';
      if (up && adm)        statusBadge = `<span style="color:var(--green);font-weight:700;font-size:10px">R</span>`;
      else if (!up && adm)  statusBadge = `<span style="color:var(--red);font-size:10px">S</span>`;
      else if (up && !adm)  statusBadge = `<span style="color:var(--yel);font-size:10px">R</span>`;
      else                  statusBadge = `<span style="color:var(--muted);font-size:10px">—</span>`;

      html += `
        <tr id="snmp_row_${iface.index}"
          style="${rowBg};border-top:1px solid var(--bd);transition:background .4s;cursor:default"
          onmouseover="this.style.background='var(--sf2)'"
          onmouseout="this.style.background=''">
          <td style="padding:6px 6px">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="color:${dotCol};font-size:8px">●</span>
              <span style="color:${typeCol};font-size:11px;font-family:'JetBrains Mono',monospace;font-weight:600">${iface.name}</span>
              <span style="font-size:9px;color:var(--muted)">${icon}</span>
            </div>
          </td>
          <td style="padding:6px;text-align:center">${statusBadge}</td>
          <td style="padding:6px;text-align:right;color:var(--muted);font-size:10px">${_fmtSpeed(iface.speed_bps)}</td>
          <td id="snmp_rx_${iface.index}" style="padding:6px;text-align:right;color:var(--cyan);font-weight:600;font-size:10px;font-family:'JetBrains Mono',monospace">—</td>
          <td id="snmp_tx_${iface.index}" style="padding:6px;text-align:right;color:var(--green);font-weight:600;font-size:10px;font-family:'JetBrains Mono',monospace">—</td>
          <td id="snmp_rxp_${iface.index}" style="padding:6px;text-align:right;color:var(--muted);font-size:9px">—</td>
          <td id="snmp_txp_${iface.index}" style="padding:6px;text-align:right;color:var(--muted);font-size:9px">—</td>
          <td style="padding:6px;text-align:right;color:var(--muted);font-size:9px">${_fmtOctets(iface.in_octets)}</td>
          <td style="padding:6px;text-align:right;color:var(--muted);font-size:9px">${_fmtOctets(iface.out_octets)}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
  } else {
    html += `<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px">Інтерфейси не знайдено</div>`;
  }

  html += `
  <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;align-items:center">
    <span style="font-size:10px;color:var(--muted)">${d.is_mikrotik ? '⬡ MikroTik RouterOS' : ''}</span>
    <button class="btn btn-ghost" style="font-size:11px" onclick="openSnmpModal('${ip}',document.getElementById('snmpModalTitle').textContent.replace('📊 ','').split('(')[0].trim())">↻ Повний ресkан</button>
    <button class="btn btn-cancel" style="font-size:11px" onclick="closeSnmpModal()">Закрити</button>
  </div>`;

  body.innerHTML = html;
}



// ══════════════════════════════════════════════════════════════════════════════
