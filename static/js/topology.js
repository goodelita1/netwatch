// NetWatch — Network topology (D3.js)

// TOPOLOGY (D3.js force-directed graph)
// ══════════════════════════════════════════════════════════════════════════════

let topoShowLabels = true;
let topoSimulation = null;

const TOPO_COLORS = {
  router: '#ff6030', ap: '#00d4ff', camera: '#a855f7',
  client: '#4a5568', mobile: '#00e676', server: '#ffb300'
};
const TOPO_ICONS = {
  router: '⬡', ap: '◈', camera: '◉', client: '○', mobile: '◎', server: '▣'
};

function topoToggleLabels() {
  topoShowLabels = !topoShowLabels;
  d3.selectAll('.topo-label').style('opacity', topoShowLabels ? 1 : 0);
}

function topoResetZoom() {
  const svg = d3.select('#topoSvg');
  svg.transition().duration(500).call(
    d3.zoom().transform, d3.zoomIdentity
  );
}

async function loadTopology() {
  try {
    const r = await fetch('/api/topology');
    const data = await r.json();
    renderTopology(data);
  } catch (e) {
    console.error('Topology load error:', e);
  }
}

function renderTopology(data) {
  const nodes   = data.nodes   || [];
  const edges   = data.edges   || [];
  const subnetMeta = data.subnets || [];  // [{prefix, label, gateway, count}]

  const wrap = document.getElementById('topoWrap');
  const W    = wrap.clientWidth || 800;
  const H    = 580;

  const svg  = d3.select('#topoSvg').attr('viewBox', `0 0 ${W} ${H}`);
  svg.selectAll('*').remove();

  if (!nodes.length) {
    document.getElementById('topoEmpty').style.display = 'flex';
    return;
  }
  document.getElementById('topoEmpty').style.display = 'none';

  // ── Defs ──────────────────────────────────────────────────────────────────
  const defs = svg.append('defs');
  // Arrow marker for backbone/wan edges
  defs.append('marker')
    .attr('id', 'arr-backbone')
    .attr('viewBox', '0 0 8 8').attr('refX', 7).attr('refY', 4)
    .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M1 1L7 4L1 7').attr('fill', 'none')
    .attr('stroke', '#ffb30080').attr('stroke-width', 1.5);

  defs.append('marker')
    .attr('id', 'arr-wan')
    .attr('viewBox', '0 0 8 8').attr('refX', 7).attr('refY', 4)
    .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M1 1L7 4L1 7').attr('fill', 'none')
    .attr('stroke', '#ff6030aa').attr('stroke-width', 1.5);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const g = svg.append('g').attr('class', 'topo-root');
  svg.call(d3.zoom().scaleExtent([0.15, 5])
    .on('zoom', (e) => g.attr('transform', e.transform)));

  // ── Subnet zone colours ───────────────────────────────────────────────────
  const ZONE_COLORS = [
    { fill: '#3d7fff0c', stroke: '#3d7fff30', text: '#3d7fff60' },
    { fill: '#00e6760c', stroke: '#00e67630', text: '#00e67660' },
    { fill: '#a855f70c', stroke: '#a855f730', text: '#a855f760' },
    { fill: '#ffb3000c', stroke: '#ffb30030', text: '#ffb30060' },
    { fill: '#00d4ff0c', stroke: '#00d4ff30', text: '#00d4ff60' },
  ];
  const subnetColorMap = {};
  (subnetMeta.length ? subnetMeta.map(s=>s.prefix) :
   [...new Set(nodes.map(n=>n.subnet))]).forEach((pfx,i) => {
    subnetColorMap[pfx] = ZONE_COLORS[i % ZONE_COLORS.length];
  });

  // ── Subnet zone ellipses (drawn behind everything) ─────────────────────
  const zoneGroup = g.append('g').attr('class', 'subnet-zones');

  // ── Links ─────────────────────────────────────────────────────────────────
  const linkG = g.append('g');
  const link = linkG.selectAll('line')
    .data(edges).enter().append('line')
    .attr('stroke', d =>
      d.type === 'wan'      ? '#ff603050' :
      d.type === 'backbone' ? '#ffb30040' : '#1e2a3a')
    .attr('stroke-width', d =>
      d.type === 'wan' ? 2.5 : d.type === 'backbone' ? 2 : 1.5)
    .attr('stroke-dasharray', d =>
      d.type === 'wan' ? '8,4' : d.type === 'backbone' ? '5,3' : 'none')
    .attr('marker-end', d =>
      d.type === 'wan' ? 'url(#arr-wan)' :
      d.type === 'backbone' ? 'url(#arr-backbone)' : null);

  // Edge labels (backbone / wan only)
  const edgeLabel = linkG.selectAll('text.edge-lbl')
    .data(edges.filter(e => e.type !== 'subnet'))
    .enter().append('text')
    .attr('class', 'edge-lbl')
    .attr('text-anchor', 'middle')
    .attr('font-size', 8)
    .attr('font-family', 'JetBrains Mono, monospace')
    .attr('fill', d => d.type === 'wan' ? '#ff603060' : '#ffb30050')
    .text(d => d.type === 'wan' ? 'WAN' : '');

  // ── Node groups ───────────────────────────────────────────────────────────
  const nodeGroup = g.append('g').selectAll('g')
    .data(nodes).enter().append('g')
    .attr('class', 'topo-node')
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if(!e.active) topoSimulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (e, d) => { d.fx=e.x; d.fy=e.y; })
      .on('end',   (e, d) => { if(!e.active) topoSimulation.alphaTarget(0); d.fx=null; d.fy=null; })
    )
    .on('click', (e, d) => showTopoTooltip(e, d))
    .on('mouseleave', () => {
      setTimeout(() => {
        const tt = document.getElementById('topoTooltip');
        if (tt && !tt.matches(':hover')) tt.style.display = 'none';
      }, 300);
    });

  // Pulse ring for online devices
  nodeGroup.filter(d => d.online === true)
    .append('circle').attr('r', d => nodeRadius(d) + 6)
    .attr('fill', 'none')
    .attr('stroke', d => TOPO_COLORS[d.type] || '#3d7fff')
    .attr('stroke-width', 1).attr('opacity', 0.25);

  // Main node circle
  nodeGroup.append('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => (TOPO_COLORS[d.type] || '#3d7fff') + (d.online===false ? '10' : '20'))
    .attr('stroke', d => nodeStroke(d))
    .attr('stroke-width', d => {
      const isGw = subnetMeta.some(s => s.gateway === d.ip);
      return isGw ? 3 : d.online === true ? 2.5 : 1.5;
    })
    .attr('opacity', d => d.online === false ? 0.4 : 1);

  // Status dot
  nodeGroup.append('circle')
    .attr('r', 4)
    .attr('cx', d => nodeRadius(d) - 3)
    .attr('cy', d => -nodeRadius(d) + 3)
    .attr('fill', d => d.online===true?'#00e676':d.online===false?'#ff3d57':'#4a5568')
    .attr('stroke', '#0a0c10').attr('stroke-width', 1.5);

  // Icon
  nodeGroup.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', d => nodeRadius(d) * 0.9)
    .attr('fill', d => TOPO_COLORS[d.type] || '#3d7fff')
    .attr('opacity', d => d.online === false ? 0.3 : 0.85)
    .text(d => TOPO_ICONS[d.type] || '○');

  // Labels (name + IP)
  nodeGroup.append('text').attr('class', 'topo-label')
    .attr('text-anchor', 'middle').attr('y', d => nodeRadius(d) + 14)
    .attr('font-size', 9).attr('font-family', 'JetBrains Mono, monospace')
    .attr('fill', '#8899aa')
    .style('opacity', topoShowLabels ? 1 : 0)
    .text(d => d.name.length > 16 ? d.name.slice(0,15)+'…' : d.name);

  nodeGroup.append('text').attr('class', 'topo-label')
    .attr('text-anchor', 'middle').attr('y', d => nodeRadius(d) + 25)
    .attr('font-size', 8).attr('font-family', 'JetBrains Mono, monospace')
    .attr('fill', '#3a4a5a')
    .style('opacity', topoShowLabels ? 1 : 0)
    .text(d => d.ip);

  // Gateway crown marker (triangle above gateway nodes)
  nodeGroup.filter(d => subnetMeta.some(s => s.gateway === d.ip))
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('y', d => -nodeRadius(d) - 8)
    .attr('font-size', 9)
    .attr('fill', d => TOPO_COLORS[d.type] || '#3d7fff')
    .attr('opacity', 0.7)
    .text('▲');

  // ── Simulation ────────────────────────────────────────────────────────────
  const simEdges = edges.map(e => ({ source: e.source, target: e.target, type: e.type }));

  // Pre-position: gateways at center, clients around them
  const gwIPs = new Set(subnetMeta.map(s => s.gateway).filter(Boolean));
  const subnetList = [...new Set(nodes.map(n => n.subnet))];
  const snCount = subnetList.length;
  nodes.forEach(n => {
    const snIdx = subnetList.indexOf(n.subnet);
    const angle = (snIdx / Math.max(snCount, 1)) * 2 * Math.PI;
    const isGw = gwIPs.has(n.ip);
    const r = isGw ? W * 0.18 : W * 0.32;
    // scatter within subnet zone
    const scatter = isGw ? 0 : (Math.random() - 0.5) * 80;
    n.x = W/2 + Math.cos(angle) * r + scatter;
    n.y = H/2 + Math.sin(angle) * r + scatter;
  });

  topoSimulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(simEdges).id(d => d.id)
      .distance(d => d.type==='wan' ? 240 : d.type==='backbone' ? 180 : 90)
      .strength(d => d.type==='wan' ? 0.2 : d.type==='backbone' ? 0.4 : 0.7))
    .force('charge', d3.forceManyBody().strength(d => gwIPs.has(d.ip) ? -400 : -200))
    .force('center', d3.forceCenter(W/2, H/2).strength(0.05))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 28))
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

      edgeLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 5);

      nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`);

      // Draw subnet zone ellipses around clustered nodes
      _updateSubnetZones(zoneGroup, nodes, subnetColorMap, subnetMeta);
    });
}

function _updateSubnetZones(zoneGroup, nodes, colorMap, subnetMeta) {
  // Group nodes by subnet, compute bounding ellipse
  const groups = {};
  nodes.forEach(n => {
    if (!groups[n.subnet]) groups[n.subnet] = [];
    groups[n.subnet].push([n.x, n.y]);
  });

  zoneGroup.selectAll('*').remove();

  Object.entries(groups).forEach(([pfx, pts]) => {
    if (pts.length < 1) return;
    const col = colorMap[pfx] || { fill: '#ffffff08', stroke: '#ffffff20', text: '#ffffff30' };
    const meta = subnetMeta.find ? subnetMeta.find(s => s.prefix === pfx) : null;
    const label = meta ? meta.label : pfx + '.0/24';

    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rx = Math.max((Math.max(...xs) - Math.min(...xs)) / 2 + 40, 50);
    const ry = Math.max((Math.max(...ys) - Math.min(...ys)) / 2 + 40, 50);

    zoneGroup.append('ellipse')
      .attr('cx', cx).attr('cy', cy)
      .attr('rx', rx).attr('ry', ry)
      .attr('fill', col.fill)
      .attr('stroke', col.stroke)
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '6,3');

    zoneGroup.append('text')
      .attr('x', cx - rx + 10).attr('y', cy - ry + 14)
      .attr('font-size', 9).attr('font-family', 'JetBrains Mono, monospace')
      .attr('fill', col.text)
      .text(label);
  });
}


function nodeRadius(d) {
  const r = { router: 22, ap: 18, camera: 16, server: 18, client: 13, mobile: 13 };
  return r[d.type] || 13;
}

function nodeStroke(d) {
  if (d.online === true) return TOPO_COLORS[d.type] || '#3d7fff';
  if (d.online === false) return '#ff3d5760';
  return '#1e2a3a';
}

function showTopoTooltip(event, d) {
  const tt = document.getElementById('topoTooltip');
  const latCol = d.latency == null ? 'var(--muted)' :
    d.latency < 20 ? 'var(--green)' : d.latency < 80 ? 'var(--yel)' : 'var(--red)';
  tt.innerHTML = `
    <div style="font-weight:700;font-size:12px;margin-bottom:4px">${d.name}</div>
    <div style="font-size:11px;color:var(--acc);margin-bottom:6px">${d.ip}</div>
    <div style="font-size:10px;color:var(--muted);line-height:1.8">
      Тип: <span style="color:var(--text)">${d.type}</span><br>
      ${d.vendor ? `Вендор: <span style="color:var(--cyan)">${d.vendor}</span><br>` : ''}
      ${d.model ? `Модель: <span style="color:var(--text)">${d.model}</span><br>` : ''}
      Статус: <span style="color:${d.online ? 'var(--green)' : 'var(--red)'}">
        ${d.online === true ? 'Онлайн' : d.online === false ? 'Офлайн' : 'Невідомо'}</span><br>
      ${d.latency != null ? `Пінг: <span style="color:${latCol};font-weight:700">${d.latency} мс</span><br>` : ''}
      Подсеть: <span style="color:var(--text)">${d.subnet}.0/24</span>
    </div>
    <button class="btn btn-ghost" style="font-size:10px;padding:3px 8px;margin-top:8px;width:100%"
      onclick="document.getElementById('traceIp').value='${d.ip}';
               document.querySelector('.tab[onclick*=traceroute]').click()">
      🛤 Traceroute →
    </button>`;
  tt.style.display = 'block';

  const wrap = document.getElementById('topoWrap');
  const rect = wrap.getBoundingClientRect();
  let x = event.clientX - rect.left + 12;
  let y = event.clientY - rect.top + 12;
  if (x + 200 > rect.width) x = event.clientX - rect.left - 212;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}

// switchTab extended below

// ══════════════════════════════════════════════════════════════════════════════
