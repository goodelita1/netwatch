// NetWatch — Dashboard (Chart.js charts)

// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

let _dashData = null;
let _dashCharts = {};   // chart instances to destroy on re-render

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 400 },
  plugins: { legend: { display: false } },
};

function _chartColor(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

async function loadDashboard() {
  // Show loading state in summary cards
  ['dashTotal','dashOnline','dashOffline','dashUptime','dashAvgLat']
    .forEach(id => { const el=document.getElementById(id); if(el) el.textContent='…'; });

  try {
    const r = await fetch('/api/dashboard');
    _dashData = await r.json();
    renderDashboard(_dashData);
  } catch(e) {
    console.error('Dashboard load error:', e);
  }
}

function renderDashboard(d) {
  if (!d) return;
  const s = d.summary || {};

  // ── Summary cards ────────────────────────────────────────────────────────
  _setText('dashTotal',   s.total ?? '—');
  _setText('dashOnline',  s.online ?? '—');
  _setText('dashOffline', s.offline ?? '—');
  _setText('dashUptime',  s.avg_uptime_pct != null ? s.avg_uptime_pct + '%' : '—');
  _setText('dashAvgLat',  s.avg_latency_ms != null ? s.avg_latency_ms + ' мс' : '—');

  // ── Down events timeline ─────────────────────────────────────────────────
  _destroyChart('dashTimelineChart');
  const tlCtx = document.getElementById('dashTimelineChart');
  if (tlCtx) {
    const now = new Date();
    const labels = Array.from({length: 24}, (_, i) => {
      const h = new Date(now - (23 - i) * 3600000);
      return h.getHours().toString().padStart(2,'0') + ':00';
    });
    _dashCharts['dashTimelineChart'] = new Chart(tlCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: d.timeline || Array(24).fill(0),
          backgroundColor: (d.timeline||[]).map(v =>
            v === 0 ? 'rgba(0,230,118,0.15)' : 'rgba(255,61,87,0.7)'
          ),
          borderColor: (d.timeline||[]).map(v =>
            v === 0 ? 'rgba(0,230,118,0.3)' : 'rgba(255,61,87,1)'
          ),
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: {
        ...CHART_DEFAULTS,
        scales: {
          x: {
            ticks: { color: '#4a5568', font: { size: 9, family: 'JetBrains Mono' },
                     maxTicksLimit: 8 },
            grid: { color: '#1e2430' }
          },
          y: {
            ticks: { color: '#4a5568', font: { size: 9 }, stepSize: 1 },
            grid: { color: '#1e2430' },
            beginAtZero: true,
          }
        },
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: {
            callbacks: {
              label: ctx => ctx.parsed.y === 0 ? 'Все ок' : `${ctx.parsed.y} падений`
            }
          }
        }
      }
    });
  }

  // ── Top-5 latency horizontal bar ─────────────────────────────────────────
  _destroyChart('dashTopLatChart');
  const latCtx = document.getElementById('dashTopLatChart');
  if (latCtx && d.top_slow && d.top_slow.length) {
    const items = d.top_slow.slice().reverse();
    _dashCharts['dashTopLatChart'] = new Chart(latCtx, {
      type: 'bar',
      data: {
        labels: items.map(x => x.name.length > 14 ? x.name.slice(0,13)+'…' : x.name),
        datasets: [{
          data: items.map(x => x.avg_ms),
          backgroundColor: items.map(x =>
            x.avg_ms < 20  ? 'rgba(0,230,118,0.6)' :
            x.avg_ms < 80  ? 'rgba(255,179,0,0.6)' : 'rgba(255,61,87,0.6)'
          ),
          borderColor: items.map(x =>
            x.avg_ms < 20  ? '#00e676' :
            x.avg_ms < 80  ? '#ffb300' : '#ff3d57'
          ),
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: {
        ...CHART_DEFAULTS,
        indexAxis: 'y',
        scales: {
          x: {
            ticks: { color: '#4a5568', font: { size: 9, family: 'JetBrains Mono' } },
            grid: { color: '#1e2430' },
            beginAtZero: true,
          },
          y: {
            ticks: { color: '#e0e6f0', font: { size: 10, family: 'JetBrains Mono' } },
            grid: { color: 'transparent' }
          }
        },
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: {
            callbacks: { label: ctx => ctx.parsed.x + ' мс' }
          }
        }
      }
    });
  } else if (latCtx) {
    const p = latCtx.getContext('2d');
    p.fillStyle = '#4a5568';
    p.font = '12px JetBrains Mono';
    p.textAlign = 'center';
    p.fillText('Немає даних — зачекайте першого авто-пінгу', latCtx.width/2, 70);
  }

  // ── Uptime bars per device ────────────────────────────────────────────────
  const ul = document.getElementById('dashUptimeList');
  const note = document.getElementById('dashUptimeNote');
  if (ul && d.devices) {
    const sorted = [...d.devices].sort((a, b) =>
      (a.uptime_pct ?? 101) - (b.uptime_pct ?? 101)
    );
    const noData = sorted.filter(x => x.uptime_pct == null);
    const withData = sorted.filter(x => x.uptime_pct != null);

    if (note) note.textContent = `${withData.length} пристроїв з даними за 24г`;

    ul.innerHTML = [...withData, ...noData].map(dev => {
      if (dev.uptime_pct == null) {
        return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;opacity:.4">
          <div style="font-size:11px;width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'JetBrains Mono',monospace">${dev.name}</div>
          <div style="flex:1;height:14px;background:var(--sf2);border-radius:3px"></div>
          <div style="font-size:10px;color:var(--muted);width:45px;text-align:right">немає даних</div>
        </div>`;
      }
      const pct = dev.uptime_pct;
      const col = pct >= 99 ? '#00e676' : pct >= 95 ? '#ffb300' : pct >= 80 ? '#ff9800' : '#ff3d57';
      const bg  = pct >= 99 ? '#00e67618' : pct >= 95 ? '#ffb30018' : '#ff3d5718';
      return `<div style="display:flex;align-items:center;gap:10px;padding:4px 0;cursor:pointer"
        onclick="selectDashDevice('${dev.ip}')"
        onmouseover="this.style.background='var(--sf2)'"
        onmouseout="this.style.background=''">
        <div style="font-size:11px;width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'JetBrains Mono',monospace;color:var(--text)">${dev.name}</div>
        <div style="flex:1;height:14px;background:var(--sf2);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${col};border-radius:3px;transition:width .5s"></div>
        </div>
        <div style="font-size:11px;font-weight:700;color:${col};width:45px;text-align:right">${pct}%</div>
        <div style="font-size:9px;color:var(--muted);width:65px;text-align:right">
          ${dev.avg_ms != null ? dev.avg_ms + ' мс' : ''}
        </div>
      </div>`;
    }).join('');
  }

  // ── Populate device select ─────────────────────────────────────────────────
  const sel = document.getElementById('dashDevSelect');
  if (sel && d.devices) {
    const cur = sel.value;
    const withHistory = d.devices.filter(x => x.history && x.history.length > 0);
    sel.innerHTML = '<option value="">— оберіть пристрій —</option>' +
      withHistory.map(dev =>
        `<option value="${dev.ip}">${dev.name} (${dev.ip})</option>`
      ).join('');
    // Auto-select first device if nothing selected
    if (!cur && withHistory.length) {
      sel.value = withHistory[0].ip;
    } else if (cur) {
      sel.value = cur;
    }
    renderDashPingChart();
  }
}

function selectDashDevice(ip) {
  const sel = document.getElementById('dashDevSelect');
  if (sel) { sel.value = ip; renderDashPingChart(); }
  // Scroll to ping chart
  const el = document.getElementById('dashPingChart');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderDashPingChart() {
  if (!_dashData) return;
  const sel = document.getElementById('dashDevSelect');
  const ip  = sel ? sel.value : '';
  if (!ip) return;

  const dev = _dashData.devices.find(d => d.ip === ip);
  if (!dev || !dev.history.length) return;

  _destroyChart('dashPingChart');
  const ctx = document.getElementById('dashPingChart');
  if (!ctx) return;

  const pts = dev.history;
  const labels = pts.map(p => {
    const d = new Date(p.ts * 1000);
    return d.getHours().toString().padStart(2,'0') + ':' +
           d.getMinutes().toString().padStart(2,'0');
  });

  const msData    = pts.map(p => p.alive && p.ms != null ? p.ms : null);
  const downData  = pts.map(p => !p.alive ? 0 : null);  // zero line when down

  _dashCharts['dashPingChart'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Пінг (мс)',
          data: msData,
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0,212,255,0.07)',
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 3,
          fill: true,
          tension: 0.3,
          spanGaps: false,
        },
        {
          label: 'Офлайн',
          data: downData,
          borderColor: 'rgba(255,61,87,0)',
          backgroundColor: 'rgba(255,61,87,0.25)',
          borderWidth: 0,
          pointRadius: 0,
          fill: true,
          stepped: true,
        }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: {
            color: '#4a5568',
            font: { size: 9, family: 'JetBrains Mono' },
            maxTicksLimit: 12,
          },
          grid: { color: '#1e2430' }
        },
        y: {
          ticks: {
            color: '#4a5568',
            font: { size: 9, family: 'JetBrains Mono' },
            callback: v => v == null ? '' : v + ' мс',
          },
          grid: { color: '#1e2430' },
          beginAtZero: true,
        }
      },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex === 1) return ctx.raw != null ? '🔴 Офлайн' : null;
              return ctx.raw != null ? `${ctx.raw} мс` : '🔴 Офлайн';
            }
          },
          filter: item => item.raw != null,
        }
      }
    }
  });

  // Stats below chart
  const statsEl = document.getElementById('dashPingStats');
  if (statsEl) {
    const upCol = dev.uptime_pct >= 99 ? 'var(--green)' : dev.uptime_pct >= 95 ? 'var(--yel)' : 'var(--red)';
    statsEl.innerHTML = [
      dev.uptime_pct != null ? `<span>Uptime: <b style="color:${upCol}">${dev.uptime_pct}%</b></span>` : '',
      dev.avg_ms != null ? `<span>Середній: <b style="color:var(--cyan)">${dev.avg_ms} мс</b></span>` : '',
      dev.min_ms != null ? `<span>Мін: <b style="color:var(--green)">${dev.min_ms} мс</b></span>` : '',
      dev.max_ms != null ? `<span>Макс: <b style="color:var(--red)">${dev.max_ms} мс</b></span>` : '',
      `<span>Точок: <b>${pts.length}</b></span>`,
    ].filter(Boolean).join('');
  }
}

function _destroyChart(id) {
  if (_dashCharts[id]) {
    _dashCharts[id].destroy();
    delete _dashCharts[id];
  }
}

function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ══════════════════════════════════════════════════════════════════════════════
