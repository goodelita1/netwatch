// NetWatch — Traceroute tab

// TRACEROUTE
// ══════════════════════════════════════════════════════════════════════════════

function initTraceDevSelect() {
  const sel = document.getElementById('traceDevSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">— з бази —</option>' +
    allDevices.map(d => `<option value="${d.ip}">${d.name} (${d.ip})</option>`).join('');
}

async function runTraceroute() {
  const ip = document.getElementById('traceIp').value.trim();
  if (!ip) { alert('Введите IP'); return; }

  document.getElementById('traceEmpty').style.display = 'none';
  document.getElementById('traceResult').style.display = 'none';
  document.getElementById('traceError').style.display = 'none';
  document.getElementById('traceProgress').style.display = 'block';
  document.getElementById('traceProgressLbl').textContent = `Traceroute → ${ip} (до 30 сек)...`;

  const btn = document.getElementById('traceBtn');
  btn.disabled = true; btn.textContent = '⟳ Виконується...';

  try {
    const r = await fetch('/api/traceroute/' + encodeURIComponent(ip));
    const data = await r.json();
    document.getElementById('traceProgress').style.display = 'none';
    btn.disabled = false; btn.textContent = '▶ Запустити';

    if (data.error && (!data.hops || !data.hops.length)) {
      document.getElementById('traceError').style.display = 'block';
      document.getElementById('traceError').textContent = '❌ Помилка: ' + data.error;
      return;
    }
    renderTraceroute(data);
  } catch (e) {
    document.getElementById('traceProgress').style.display = 'none';
    btn.disabled = false; btn.textContent = '▶ Запустити';
    document.getElementById('traceError').style.display = 'block';
    document.getElementById('traceError').textContent = '❌ Помилка сети: ' + e;
  }
}

function renderTraceroute(data) {
  const hops = data.hops || [];
  const target = data.target;
  const source = data.source || '';

  document.getElementById('traceResult').style.display = 'block';
  document.getElementById('traceResultTitle').textContent = `Маршрут: ${source} → ${target}`;

  const reachable = hops.filter(h => h.ip !== '*');
  const timeouts  = hops.filter(h => h.ip === '*').length;
  const maxMs     = Math.max(...reachable.map(h => h.ms || 0), 1);
  document.getElementById('traceResultStats').textContent =
    `${hops.length} хопов · ${reachable.length} відветабо · ${timeouts} таймаутов`;

  // ── Vertical path diagram ─────────────────────────────────────────────────
  const vis = document.getElementById('traceVisual');
  const TC = { router:'#ff6030', ap:'#00d4ff', camera:'#a855f7',
               client:'#4a5568', mobile:'#00e676', server:'#ffb300' };

  const ROW_H = 72, PAD_TOP = 20, NODE_R = 18;
  const totalH = PAD_TOP + hops.length * ROW_H + 20;
  const W = 680;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%"
    viewBox="0 0 ${W} ${totalH}" style="display:block;max-width:900px">`;

  // Subnet zone bands (alternating background for subnet groups)
  const subnetGroups = {};
  hops.forEach((h,i) => {
    if(h.ip === '*') return;
    const pfx = h.ip.split('.').slice(0,3).join('.');
    if(!subnetGroups[pfx]) subnetGroups[pfx] = {start: i, end: i, color: ''};
    subnetGroups[pfx].end = i;
  });
  const subnetColors = ['#3d7fff0a','#00e6760a','#a855f70a','#ffb3000a'];
  let snColorIdx = 0;
  const snColorMap = {};
  Object.keys(subnetGroups).forEach(pfx => {
    snColorMap[pfx] = subnetColors[snColorIdx++ % subnetColors.length];
  });

  // Draw subnet zone bands
  Object.entries(subnetGroups).forEach(([pfx, {start, end}]) => {
    const y1 = PAD_TOP + start * ROW_H - 10;
    const y2 = PAD_TOP + end * ROW_H + ROW_H - 10;
    svg += `<rect x="10" y="${y1}" width="${W-20}" height="${y2-y1}" rx="8"
      fill="${snColorMap[pfx]}" stroke="${snColorMap[pfx].replace('0a','30')}"
      stroke-width="1"/>`;
    svg += `<text x="28" y="${y1+14}" font-size="9" fill="#ffffff20"
      font-family="JetBrains Mono,monospace">${pfx}.0/24</text>`;
  });

  hops.forEach((h, i) => {
    const cy = PAD_TOP + i * ROW_H + ROW_H / 2;
    const timeout = h.ip === '*';
    const isFirst = i === 0;
    const isLast  = i === hops.length - 1;
    const col = timeout ? '#2a3a4a' : (TC[h.type] || '#3d7fff');
    const latCol = h.ms == null ? '#4a5568' :
                   h.ms < 10   ? '#00e676' :
                   h.ms < 50   ? '#8bc34a' :
                   h.ms < 150  ? '#ffb300' : '#ff3d57';

    // Vertical connector line above this node
    if(i > 0) {
      const prevTimeout = hops[i-1].ip === '*';
      const prevCy = PAD_TOP + (i-1) * ROW_H + ROW_H / 2;
      svg += `<line x1="54" y1="${prevCy + NODE_R + 2}" x2="54" y2="${cy - NODE_R - 2}"
        stroke="${prevTimeout || timeout ? '#1e2a3a' : col+'60'}"
        stroke-width="${isLast ? 3 : 2}"
        stroke-dasharray="${prevTimeout || timeout ? '5,3' : 'none'}"/>`;
      // Arrow pointing down
      if(!timeout) {
        svg += `<polygon points="54,${cy-NODE_R-2} 50,${cy-NODE_R-8} 58,${cy-NODE_R-8}"
          fill="${col}80"/>`;
      }
    }

    // Latency arc ring around node
    if(!timeout && h.ms != null) {
      const r2 = NODE_R + 6;
      const circ = 2 * Math.PI * r2;
      const pct  = Math.min(h.ms / maxMs, 1);
      const dash = circ * pct;
      svg += `<circle cx="54" cy="${cy}" r="${r2}" fill="none"
        stroke="${latCol}25" stroke-width="4"/>`;
      svg += `<circle cx="54" cy="${cy}" r="${r2}" fill="none"
        stroke="${latCol}" stroke-width="2.5" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${(circ-dash).toFixed(1)}"
        stroke-dashoffset="${(circ/4).toFixed(1)}"/>`;
    }

    // Node circle
    const online = h.online;
    const borderCol = online === true ? col :
                      online === false ? '#ff3d57' : col;
    svg += `<circle cx="54" cy="${cy}" r="${NODE_R}" 
      fill="${timeout ? '#111827' : col+'18'}"
      stroke="${borderCol}" stroke-width="${timeout ? 1 : 2}"/>`;

    // Online status dot
    if(!timeout) {
      const dotCol = online===true?'#00e676':online===false?'#ff3d57':'#4a5568';
      svg += `<circle cx="${54+NODE_R-4}" cy="${cy-NODE_R+4}" r="4"
        fill="${dotCol}" stroke="#0a0c10" stroke-width="1.5"/>`;
    }

    // Hop number or ? in node
    svg += `<text x="54" y="${cy+1}" text-anchor="middle" dominant-baseline="central"
      font-size="10" font-weight="700"
      fill="${timeout ? '#2a3a4a' : col}"
      font-family="JetBrains Mono,monospace">${timeout ? '?' : h.hop}</text>`;

    // Right side: IP + name + vendor
    const rightX = 90;
    if(timeout) {
      svg += `<text x="${rightX}" y="${cy}" dominant-baseline="central"
        font-size="11" fill="#2a3a4a" font-family="JetBrains Mono,monospace">* * *  Таймаут</text>`;
    } else {
      // IP
      svg += `<text x="${rightX}" y="${cy-9}" font-size="12" font-weight="700"
        fill="${col}" font-family="JetBrains Mono,monospace">${h.ip}</text>`;
      // Name / model
      const nameStr = h.name || h.model || (isFirst ? 'NetWatch сервер' : isLast ? 'Ціль' : '');
      if(nameStr) {
        svg += `<text x="${rightX}" y="${cy+7}" font-size="10"
          fill="#8899aa" font-family="JetBrains Mono,monospace"
          >${nameStr.slice(0,38)}</text>`;
      }
      // Vendor badge
      if(h.vendor) {
        const bw = h.vendor.length * 6.5 + 12;
        svg += `<rect x="${rightX}" y="${cy+14}" width="${bw}" height="13" rx="3"
          fill="${col}22" stroke="${col}50" stroke-width="1"/>`;
        svg += `<text x="${rightX+6}" y="${cy+23}" font-size="8.5"
          fill="${col}" font-family="JetBrains Mono,monospace">${h.vendor}</text>`;
      }
      // Latency on right side
      if(h.ms != null) {
        const msStr = h.ms === 0 ? '0 мс' : h.ms + ' мс';
        svg += `<text x="${W-20}" y="${cy}" text-anchor="end" dominant-baseline="central"
          font-size="13" font-weight="700"
          fill="${latCol}" font-family="JetBrains Mono,monospace">${msStr}</text>`;
        // Cumulative latency bar
        const barW = Math.min((h.ms / maxMs) * 120, 120);
        svg += `<rect x="${W-150}" y="${cy-4}" width="120" height="8" rx="4"
          fill="#1e2a3a"/>`;
        svg += `<rect x="${W-150}" y="${cy-4}" width="${barW.toFixed(1)}" height="8" rx="4"
          fill="${latCol}"/>`;
      }
    }

    // Special markers
    if(isFirst) {
      svg += `<text x="${W/2}" y="${cy}" text-anchor="middle" dominant-baseline="central"
        font-size="9" fill="#3d7fff80" font-family="JetBrains Mono,monospace">◀ СТАРТ</text>`;
    }
    if(isLast && !timeout) {
      svg += `<text x="${W/2}" y="${cy}" text-anchor="middle" dominant-baseline="central"
        font-size="9" fill="${col}80" font-family="JetBrains Mono,monospace">▶ ЦІЛЬ</text>`;
    }
  });

  svg += '</svg>';
  vis.innerHTML = svg;

  // ── Table ─────────────────────────────────────────────────────────────────
  const tb = document.getElementById('traceTable');
  tb.innerHTML = `
    <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin:14px 0 7px">Детали хопов</div>
    <div class="trace-table">
      <div class="trace-th">
        <span>#</span><span>IP</span><span>Назва / Модель</span>
        <span>Вендор</span><span>Затримка</span><span>График</span>
      </div>
      ${hops.map((h,i) => {
        const timeout = h.ip === '*';
        const latCol = timeout ? 'var(--muted)' :
          h.ms === 0 ? 'var(--muted)' :
          h.ms < 10  ? 'var(--green)' :
          h.ms < 50  ? '#8bc34a' :
          h.ms < 150 ? 'var(--yel)' : 'var(--red)';
        const barW = timeout ? 0 : Math.min(Math.round((h.ms||0) / maxMs * 100), 100);
        const isFirst = i === 0;
        return `<div class="trace-row ${timeout?'trace-timeout':''} ${h.known?'trace-known':''}">
          <span class="trace-hop">${h.hop}</span>
          <span class="trace-ip">${timeout?'* * *':h.ip}</span>
          <span style="font-size:11px">${h.name||(timeout?'Таймаут':isFirst?'NetWatch сервер':'—')}${h.model&&h.model!==h.name?`<br><span style="font-size:9px;color:var(--muted)">${h.model.slice(0,30)}</span>`:''}</span>
          <span style="font-size:10px;color:var(--muted)">${h.vendor||'—'}</span>
          <span style="font-size:11px;font-weight:700;color:${latCol}">${timeout?'—':h.ms===0?'<1 мс':h.ms+' мс'}</span>
          <span>${timeout?'':`<div class="trace-bar-wrap">
            <div class="trace-bar" style="width:${barW}%;background:${latCol}"></div>
          </div>`}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
