// NetWatch — SLA tab (uptime analytics)

// SLA TAB
// ══════════════════════════════════════════════════════════════════════════════

let _slaData     = [];
let _slaPeriod   = '7d';
let _slaSortKey  = 'uptime';
let _slaSortAsc  = true;
let _slaCharts   = {};

async function loadSLA() {
  document.getElementById('slaTableBody').innerHTML =
    '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted)">⟳ Завантаження...</td></tr>';
  try {
    const r = await fetch('/api/sla');
    _slaData = await r.json();
    renderSLASummary();
    renderSLATable();
    _populateSLADevSelect();
    if (_slaData.length) renderSLAChart();
  } catch(e) {
    document.getElementById('slaTableBody').innerHTML =
      `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--red)">❌ ${e}</td></tr>`;
  }
}

function setSLAPeriod(p) {
  _slaPeriod = p;
  ['1d','7d','30d'].forEach(x => {
    const b = document.getElementById('slaPeriod'+x);
    if(b) b.className = x === p ? 'btn btn-acc' : 'btn btn-ghost';
    if(b) b.style.fontSize = '11px';
    if(b) b.style.padding  = '4px 10px';
  });
  renderSLASummary();
  renderSLATable();
  renderSLAChart();
}

function renderSLASummary() {
  const items  = _slaData;
  const upList = items.map(d => d[_slaPeriod]?.uptime).filter(u => u != null);
  const avg    = upList.length ? (upList.reduce((a,b)=>a+b,0)/upList.length).toFixed(1) : null;
  _setText('slaAvgUp',   avg != null ? avg+'%' : '—');
  _setText('slaGreen',   upList.filter(u => u >= 99).length);
  _setText('slaYellow',  upList.filter(u => u >= 95 && u < 99).length);
  _setText('slaRed',     upList.filter(u => u < 95).length);
  _setText('slaNoData',  items.filter(d => d[_slaPeriod]?.uptime == null).length);
  const note = document.getElementById('slaNote');
  if(note) note.textContent = `${items.length} пристроїв · період: ${_slaPeriod}`;
}

function sortSLA(key) {
  if(_slaSortKey === key) _slaSortAsc = !_slaSortAsc;
  else { _slaSortKey = key; _slaSortAsc = key !== 'uptime'; }
  renderSLATable();
}

function renderSLATable() {
  const q    = (document.getElementById('slaSearch')?.value || '').toLowerCase();
  let rows   = _slaData.filter(d =>
    !q || d.name.toLowerCase().includes(q) || d.ip.includes(q)
  );
  const key  = _slaSortKey;
  const asc  = _slaSortAsc;
  rows.sort((a, b) => {
    let av, bv;
    if(key === 'name')      { av = a.name; bv = b.name; }
    else if(key === 'uptime')    { av = a[_slaPeriod]?.uptime ?? -1;   bv = b[_slaPeriod]?.uptime ?? -1; }
    else if(key === 'avg_ms')    { av = a[_slaPeriod]?.avg_ms ?? 9999; bv = b[_slaPeriod]?.avg_ms ?? 9999; }
    else if(key === 'incidents') { av = a.incidents_30d ?? 0;           bv = b.incidents_30d ?? 0; }
    else { av = 0; bv = 0; }
    if(typeof av === 'string') return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return asc ? av - bv : bv - av;
  });

  const TREND = { up:'↑', down:'↓', stable:'→', new:'·' };
  const TREND_COL = { up:'var(--green)', down:'var(--red)', stable:'var(--muted)', new:'var(--muted)' };

  const tbody = document.getElementById('slaTableBody');
  if(!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">Немає даних</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((d, i) => {
    const pd   = d[_slaPeriod] || {};
    const u    = pd.uptime;
    const col  = u == null ? 'var(--muted)' : u >= 99 ? 'var(--green)' : u >= 95 ? 'var(--yel)' : u >= 80 ? '#ff9800' : 'var(--red)';
    const barW = u != null ? u : 0;
    const trend = d.trend || 'new';
    const online = d.online;
    const dotCol = online === true ? 'var(--green)' : online === false ? 'var(--red)' : 'var(--muted)';
    return `<tr style="border-top:1px solid var(--bd);cursor:pointer"
              onmouseover="this.style.background='var(--sf2)'"
              onmouseout="this.style.background=''"
              onclick="selectSLADevice('${d.ip}')">
      <td style="padding:7px 8px;font-weight:600;font-size:12px">${d.name}</td>
      <td style="padding:7px 8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)">${d.ip}</td>
      <td style="padding:7px 8px;text-align:center">
        <div style="font-size:13px;font-weight:700;color:${col}">${u != null ? u+'%' : '—'}</div>
        <div style="height:5px;background:var(--sf2);border-radius:3px;margin-top:3px;overflow:hidden">
          <div style="height:100%;width:${barW}%;background:${col};border-radius:3px"></div>
        </div>
      </td>
      <td style="padding:7px 8px;text-align:center;font-weight:700;color:${TREND_COL[trend]};font-size:14px">${TREND[trend]}</td>
      <td style="padding:7px 8px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px">
        ${pd.avg_ms != null ? pd.avg_ms+' мс' : '—'}
      </td>
      <td style="padding:7px 8px;text-align:center">
        ${d.incidents_30d > 0
          ? `<span style="background:var(--rd);color:var(--red);padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700">${d.incidents_30d}</span>`
          : '<span style="color:var(--muted)">0</span>'}
      </td>
      <td style="padding:7px 8px;text-align:center;color:var(--muted);font-size:10px">${pd.samples || '—'}</td>
      <td style="padding:7px 8px;text-align:center">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotCol}"></span>
      </td>
    </tr>`;
  }).join('');
}

function selectSLADevice(ip) {
  const sel = document.getElementById('slaChartDev');
  if(sel) { sel.value = ip; renderSLAChart(); }
  document.getElementById('slaTimelineChart')?.scrollIntoView({behavior:'smooth',block:'center'});
}

function _populateSLADevSelect() {
  const sel = document.getElementById('slaChartDev');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— оберіть пристрій —</option>' +
    _slaData.map(d => `<option value="${d.ip}">${d.name} (${d.ip})</option>`).join('');
  if(cur) sel.value = cur;
  else if(_slaData.length) sel.value = _slaData[0].ip;
}

async function renderSLAChart() {
  const ip = document.getElementById('slaChartDev')?.value;
  if(!ip) return;
  const hours = _slaPeriod === '1d' ? 24 : _slaPeriod === '7d' ? 168 : 720;

  // Destroy old chart
  if(_slaCharts['slaTimeline']) { _slaCharts['slaTimeline'].destroy(); delete _slaCharts['slaTimeline']; }

  try {
    const r   = await fetch(`/api/ping_history/${encodeURIComponent(ip)}/db?hours=${hours}`);
    const pts = await r.json();
    if(!pts.length) return;

    // Aggregate into hourly buckets
    const dev    = _slaData.find(d => d.ip === ip);
    const buckets = _hourlyBuckets(pts, hours);
    const labels  = buckets.map(b => {
      const d = new Date(b.ts * 1000);
      return d.getDate()+'.'+(d.getMonth()+1)+' '+d.getHours()+':00';
    });
    const ctx = document.getElementById('slaTimelineChart');
    _slaCharts['slaTimeline'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Uptime %',
          data:   buckets.map(b => b.uptime),
          backgroundColor: buckets.map(b =>
            b.uptime == null ? '#1e2430' :
            b.uptime >= 99   ? 'rgba(0,230,118,.7)' :
            b.uptime >= 95   ? 'rgba(255,179,0,.7)' : 'rgba(255,61,87,.7)'),
          borderWidth: 0, borderRadius: 2,
        }]
      },
      options: {
        ...CHART_DEFAULTS,
        scales: {
          x: { ticks: { color:'#4a5568', font:{size:8,family:'JetBrains Mono'}, maxTicksLimit: hours <= 24 ? 12 : 14 }, grid:{color:'#1e2430'} },
          y: { min:0, max:100, ticks:{color:'#4a5568',font:{size:9},callback:v=>v+'%'}, grid:{color:'#1e2430'} }
        },
        plugins: { ...CHART_DEFAULTS.plugins, tooltip:{ callbacks:{
          label: ctx => ctx.parsed.y != null ? ctx.parsed.y+'% uptime' : 'немає даних'
        }}}
      }
    });
  } catch(e) { console.error('SLA chart:', e); }
}

function _hourlyBuckets(pts, hours) {
  const now   = Date.now() / 1000;
  const step  = hours <= 24 ? 3600 : hours <= 168 ? 3600 * 3 : 3600 * 6;
  const start = now - hours * 3600;
  const buckets = [];
  for(let t = start; t < now; t += step) {
    const slice = pts.filter(p => p.ts >= t && p.ts < t + step);
    if(!slice.length) { buckets.push({ts: t, uptime: null}); continue; }
    const up = slice.filter(p => p.alive).length;
    buckets.push({ts: t, uptime: Math.round(up / slice.length * 100)});
  }
  return buckets;
}



// ══════════════════════════════════════════════════════════════════════════════
