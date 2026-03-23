// NetWatch — Globals, utilities, device list, subnets, discovery, init, settings

const TL={router:'Роутер',ap:'WiFi AP',camera:'Камера',client:'Клієнт',mobile:'Мобільний',server:'Сервер'};
const TC={router:'tr2',ap:'ta',camera:'tc',client:'tk',mobile:'tm',server:'ts'};

let allDevices=[], allSubnets=[], currentFilter='all', searchQuery='', scanning=false, deepScanning=false;
let selectedIds=new Set();
let pageSize=50, currentPage=0;
let discPoll=null, snScanPoll=null;
let autoCountdown=60, autoTimer=null;

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tp').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  if(name==='subnets'||name==='discovery') renderSubnetUI();
  if(name==='events'){ fetchEvents(); _refreshEvTestSelect(); }
  // settings loaded via switchTab extension below
}

// ── Auto-ping countdown ───────────────────────────────────────────────────────
function startAutoCountdown(){
  autoCountdown=60;
  if(autoTimer) clearInterval(autoTimer);
  autoTimer=setInterval(()=>{
    autoCountdown--;
    document.getElementById('autoBadgeText').textContent=`⏱ авто-пінг ${autoCountdown}с`;
    if(autoCountdown<=0){
      autoCountdown=60;
      fetchDevices(); // refresh after server auto-ping fires
    }
  },1000);
}

// ── Latency helpers ───────────────────────────────────────────────────────────
function latClass(ms){
  if(ms===null||ms===undefined) return '';
  if(ms<50) return 'lat-good';
  if(ms<150) return 'lat-ok';
  return 'lat-bad';
}
function latBarClass(ms){
  if(ms===null||ms===undefined) return '';
  if(ms<50) return 'lat-good-b';
  if(ms<150) return 'lat-ok-b';
  return 'lat-bad-b';
}
function latBarWidth(ms){
  if(ms===null||ms===undefined) return 0;
  // 0ms=0% 300ms=100%
  return Math.min(100, Math.round(ms/3));
}

// ── Power status (based on 192.168.88.1) ─────────────────────────────────────
const POWER_IP = '192.168.88.1';

function updatePowerBanner(devices){
  const gw = devices.find(d=>d.ip===POWER_IP);
  const banner = document.getElementById('powerBanner');
  const icon   = document.getElementById('powerIcon');
  const title  = document.getElementById('powerTitle');
  const sub    = document.getElementById('powerSub');
  if(!gw || gw.online===null || gw.online===undefined){
    banner.className='power-banner power-unk';
    icon.textContent='⚡'; title.textContent='Статус питания: незвестно';
    sub.textContent=`Ожидание пінга ${POWER_IP}`;
  } else if(gw.online===true){
    banner.className='power-banner power-on';
    icon.textContent='⚡'; title.textContent='Є світло — живлення в нормі';
    sub.textContent=`${POWER_IP} відповідає${gw.latency!=null?' · пінг '+gw.latency+' мс':''}`;
  } else {
    banner.className='power-banner power-off';
    icon.textContent='🔴'; title.textContent='НЕМАЄ СВІТЛА — питание відсутствует!';
    sub.textContent=`${POWER_IP} не відповідає · вероятно відключення електроенергії`;
  }
}

// ── Sort state ────────────────────────────────────────────────────────────────
let sortKey='ip', sortDir='asc';

const SORT_KEYS = {
  ip:      (d)=>d.ip.split('.').map(n=>n.padStart(3,'0')).join('.'),
  name:    (d)=>(d.name||'').toLowerCase(),
  location:(d)=>(d.location||'').toLowerCase(),
  type:    (d)=>d.type||'',
  status:  (d)=>d.online===true?0:d.online===false?1:2,
  latency: (d)=>d.latency??99999,
};

function setSortFromSelect(){
  const val = document.getElementById('sortSelect').value;
  const [k, dir] = val.split('-');
  sortKey = k; sortDir = dir||'asc';
  render();
}

function setSortFromHeader(key){
  if(sortKey===key){ sortDir = sortDir==='asc'?'desc':'asc'; }
  else { sortKey=key; sortDir='asc'; }
  // sync dropdown
  const sel = document.getElementById('sortSelect');
  const target = key+'-'+sortDir;
  for(let o of sel.options){ if(o.value===target){sel.value=target;break;} }
  render();
}

function sortDevices(devs){
  const fn = SORT_KEYS[sortKey] || SORT_KEYS.ip;
  return [...devs].sort((a,b)=>{
    const av=fn(a), bv=fn(b);
    if(av<bv) return sortDir==='asc'?-1:1;
    if(av>bv) return sortDir==='asc'?1:-1;
    return 0;
  });
}

function thSpan(label, key){
  let cls='';
  if(sortKey===key) cls = sortDir==='asc'?' sort-asc':' sort-desc';
  return `<span class="${cls}" onclick="setSortFromHeader('${key}')">${label}</span>`;
}

// ── Monitor render ────────────────────────────────────────────────────────────
function pfx(ip){return ip.split('.').slice(0,3).join('.');}
function sc(d){return d.online===true?'on':d.online===false?'off':'unk';}

// ── Sparkline helpers ─────────────────────────────────────────────────────────
const sparkCache = {};   // ip → svg string

function buildSparkline(pts){
  // pts: [{ts,ms,alive}] — latest at end
  const W=120, H=22, pad=2;
  if(!pts||pts.length<2) return '';
  const vals=pts.map(p=>p.ms!=null?p.ms:null);
  const alive=pts.map(p=>p.alive);
  const valid=vals.filter(v=>v!=null);
  if(!valid.length) return '';
  const vmin=Math.min(...valid), vmax=Math.max(...valid,vmin+1);
  const n=vals.length;
  // build polyline points
  let segs=[], cur=[];
  for(let i=0;i<n;i++){
    const x=pad+(i/(n-1||1))*(W-2*pad);
    if(vals[i]==null||!alive[i]){
      if(cur.length>1) segs.push({pts:cur.slice(),down:false});
      cur=[];
    } else {
      const y=H-pad-((vals[i]-vmin)/(vmax-vmin||1))*(H-2*pad);
      cur.push([x,y]);
    }
    if(!alive[i]&&i>0&&alive[i-1]){
      // mark down gap
      segs.push({pts:[[x,H-pad],[x,pad]],down:true});
    }
  }
  if(cur.length>1) segs.push({pts:cur,down:false});
  let svg=`<svg class="sparkline" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">`;
  // draw offline drop lines
  segs.filter(s=>s.down).forEach(s=>{
    svg+=`<line x1="${s.pts[0][0]}" y1="${s.pts[0][1]}" x2="${s.pts[1][0]}" y2="${s.pts[1][1]}" stroke="var(--red)" stroke-width="1" stroke-dasharray="2,2" opacity=".5"/>`;
  });
  // draw lines
  segs.filter(s=>!s.down).forEach(s=>{
    const d=s.pts.map((p,i)=>(i===0?'M':'L')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    svg+=`<path d="${d}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round" opacity=".8"/>`;
    // last dot
    const lp=s.pts[s.pts.length-1];
    svg+=`<circle cx="${lp[0].toFixed(1)}" cy="${lp[1].toFixed(1)}" r="2" fill="var(--green)"/>`;
  });
  svg+='</svg>';
  return svg;
}

// ip→history, fetched lazily
const pingHist={};
const pingHistPending=new Set();

async function ensureHistory(ip){
  if(pingHist[ip]||pingHistPending.has(ip)) return;
  pingHistPending.add(ip);
  try{
    const r=await fetch('/api/ping_history/'+ip);
    pingHist[ip]=await r.json();
  }catch(e){}
}

function pingCell(d){
  const ms=d.latency;
  const hist=pingHist[d.ip]||[];
  if(!pingHist[d.ip]) ensureHistory(d.ip);  // lazy load, re-renders on next cycle

  if(d.online===false){
    const spark=buildSparkline(hist);
    return `<div class="ping-cell">
      <span style="font-size:10px;color:var(--red)">недост.</span>
      ${spark?`<div class="spark-wrap">${spark}</div>`:''}
    </div>`;
  }
  if(ms===null||ms===undefined) return `<div class="ping-cell"><span style="font-size:10px;color:var(--muted)">—</span></div>`;
  const lc=latClass(ms); const lb=latBarClass(ms); const bw=latBarWidth(ms);
  const spark=buildSparkline(hist);
  return `<div class="ping-cell">
    <div style="display:flex;align-items:center;gap:5px">
      <span class="latency-val ${lc}">${ms} мс</span>
    </div>
    ${spark?`<div class="spark-wrap">${spark}</div>`
           :`<div class="latency-bar-wrap"><div class="latency-bar ${lb}" style="width:${bw}%"></div></div>`}
  </div>`;
}

function vendorCell(d){
  const v=d.vendor||''; const m=d.model||''; const mac=d.mac||'';
  if(!v&&!m&&!mac) return `<div class="vendor-cell"><span style="font-size:10px;color:var(--muted)">—</span></div>`;
  const credBadge=d.has_creds
    ?`<span class="cred-badge cred-ok" title="Облікові дані збережено">🔑</span>`
    :`<span class="cred-badge cred-no" title="Немає облікових даних">🔒</span>`;
  return `<div class="vendor-cell">
    <div style="display:flex;align-items:center;gap:4px">${v?`<span class="vendor-name">${v}</span>`:''}${credBadge}</div>
    ${m?`<span class="model-name" title="${m}">${m}</span>`:''}
    ${mac?`<span class="mac-text">${mac}</span>`:''}
  </div>`;
}

function render(){
  const el=document.getElementById('devList');
  let filtered=allDevices;
  if(currentFilter==='online') filtered=allDevices.filter(d=>d.online===true);
  else if(currentFilter==='offline') filtered=allDevices.filter(d=>d.online===false);
  else if(['router','ap','camera','client','mobile','server'].includes(currentFilter))
    filtered=allDevices.filter(d=>d.type===currentFilter);
  if(searchQuery) filtered=filtered.filter(matchesSearch);
  filtered=sortDevices(filtered);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const total=filtered.length;
  const ps=pageSize||total;
  const totalPages=ps?Math.ceil(total/ps):1;
  if(currentPage>=totalPages) currentPage=Math.max(0,totalPages-1);
  const pageStart=currentPage*ps;
  const pageEnd=ps?Math.min(pageStart+ps,total):total;
  const pageSlice=filtered.slice(pageStart,pageEnd);

  // Group by subnet (from pageSlice only)
  const groups={};
  pageSlice.forEach(d=>{const p=pfx(d.ip);if(!groups[p])groups[p]=[];groups[p].push(d);});
  const knownPfx=allSubnets.map(s=>s.prefix);
  const keys=[...knownPfx.filter(p=>groups[p]),...Object.keys(groups).filter(p=>!knownPfx.includes(p))];

  let html='';
  keys.forEach(p=>{
    const devs=groups[p];
    const sn=allSubnets.find(s=>s.prefix===p);
    const label=sn?sn.label:p+'.0/24';
    const onCnt=devs.filter(d=>d.online===true).length;
    const allSelected=devs.every(d=>selectedIds.has(d.id));
    const chkId='chkAll_'+p.replace(/\./g,'_');
    html+=`<div class="sn-sec">
      <div class="sn-hdr">
        <input type="checkbox" id="${chkId}" ${allSelected&&devs.length?'checked':''} onchange="toggleSelectSubnet('${p}',this.checked)" title="Вибрати підмережа" style="cursor:pointer;accent-color:var(--acc);margin-right:4px">
        <span class="sn-badge">${label}</span>
        <span style="font-size:11px;color:var(--muted)">${devs.length} уст.</span>
        <span style="font-size:10px;color:var(--green);margin-left:auto">${onCnt} онлайн</span>
      </div>
      <div class="th">
        <span></span><span></span>
        ${thSpan('IP','ip')}
        ${thSpan('Назва','name')}
        ${thSpan('Розташування','location')}
        <span>Вендор / Модель</span>
        ${thSpan('Тип','type')}
        ${thSpan('Пінг','latency')}
        <span>Дії</span>
      </div>
      <div class="dg">`;
    devs.forEach(d=>{
      const s=sc(d);
      const sel=selectedIds.has(d.id);
      html+=`<div class="dr ${s}${sel?' dr-selected':''}">
        <input type="checkbox" ${sel?'checked':''} onchange="toggleSelect(${d.id},this.checked)"
          style="cursor:pointer;accent-color:var(--acc);flex-shrink:0">
        <div class="dot ${s}"></div>
        <div class="dev-ip">${d.ip}</div>
        <div class="dev-name">${d.name}</div>
        <div class="dev-loc">${d.location||'—'}</div>
        ${vendorCell(d)}
        <div><span class="type-badge ${TC[d.type]||'tk'}">${TL[d.type]||d.type}</span></div>
        ${pingCell(d)}
        <div class="dev-act">
          <button class="btn-ping" id="ping_${d.id}" onclick="singlePing(${d.id},'${d.ip}')">⚡</button>
          <button class="btn-snmp" onclick="openSnmpModal('${d.ip}','${d.name||d.ip}')" title="SNMP статистика">📊</button>
          <button class="btn-reboot" id="reboot_${d.id}" onclick="rebootDevice(${d.id})" ${d.has_creds?'':' title="Немає облікових даних" style="opacity:.4"'}>⟳</button>
          <button class="btn btn-ghost" onclick="openEditModal(${d.id})" style="padding:3px 7px;font-size:11px">✏</button>
          <button class="btn btn-del" onclick="delDevice(${d.id})" style="padding:3px 7px;font-size:11px">✕</button>
        </div>
      </div>`;
    });
    html+=`</div></div>`;
  });

  if(!html) html=`<div style="text-align:center;padding:50px;color:var(--muted)">Пристроїв не знайдено</div>`;
  el.innerHTML=html;

  // ── Pagination controls ───────────────────────────────────────────────────
  renderPagination(total, totalPages, pageStart, pageEnd);

  const lats=allDevices.filter(d=>d.latency!=null&&d.online===true).map(d=>d.latency);
  const avgPing=lats.length?Math.round(lats.reduce((a,b)=>a+b,0)/lats.length):null;
  document.getElementById('sTotal').textContent=allDevices.length;
  document.getElementById('sOnline').textContent=allDevices.filter(d=>d.online===true).length;
  document.getElementById('sOffline').textContent=allDevices.filter(d=>d.online===false).length;
  document.getElementById('sUnknown').textContent=allDevices.filter(d=>d.online==null).length;
  document.getElementById('sAvgPing').textContent=avgPing?avgPing+' мс':'—';
  updatePowerBanner(allDevices);
  updateGroupBar();
}

function renderPagination(total, totalPages, pageStart, pageEnd){
  let pager=document.getElementById('pagerBar');
  if(!pager){
    pager=document.createElement('div');
    pager.id='pagerBar';
    pager.style.cssText='display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap;font-size:11px;color:var(--muted)';
    document.getElementById('devList').after(pager);
  }
  if(totalPages<=1&&total<=50){pager.innerHTML='';return;}
  const from=total?pageStart+1:0, to=Math.min(pageEnd,total);
  let html=`<span>${from}–${to} з ${total}</span>`;
  html+=`<button class="fbtn" onclick="gotoPage(0)" ${currentPage===0?'disabled':''} style="padding:3px 8px">«</button>`;
  html+=`<button class="fbtn" onclick="gotoPage(${currentPage-1})" ${currentPage===0?'disabled':''} style="padding:3px 8px">‹</button>`;
  // window of pages
  const win=3;
  for(let i=Math.max(0,currentPage-win);i<=Math.min(totalPages-1,currentPage+win);i++){
    html+=`<button class="fbtn${i===currentPage?' active':''}" onclick="gotoPage(${i})" style="padding:3px 9px">${i+1}</button>`;
  }
  html+=`<button class="fbtn" onclick="gotoPage(${currentPage+1})" ${currentPage>=totalPages-1?'disabled':''} style="padding:3px 8px">›</button>`;
  html+=`<button class="fbtn" onclick="gotoPage(${totalPages-1})" ${currentPage>=totalPages-1?'disabled':''} style="padding:3px 8px">»</button>`;
  pager.innerHTML=html;
}

function gotoPage(p){
  currentPage=p;
  render();
  window.scrollTo({top:document.getElementById('devList').offsetTop-20,behavior:'smooth'});
}

function setPageSize(n){
  pageSize=n;
  currentPage=0;
  render();
}

async function fetchDevices(){
  const r=await fetch('/api/devices'); const data=await r.json();
  allDevices=data.devices;
  if(data.last_scan){
    const d=new Date(data.last_scan*1000);
    document.getElementById('lastScan').textContent='Скан: '+d.toLocaleTimeString('ru-RU');
  }
  render();
  // refresh sparkline history for all visible devices
  for(const d of allDevices) ensureHistory(d.ip);
}

async function refreshAllHistory(){
  for(const d of allDevices){
    try{
      const r=await fetch('/api/ping_history/'+d.ip);
      pingHist[d.ip]=await r.json();
    }catch(e){}
  }
  render();
}

async function triggerScan(){
  if(scanning)return; scanning=true;
  const btn=document.getElementById('scanBtn');
  btn.textContent='⟳ Пінг...'; btn.classList.add('spin');
  await fetch('/api/scan',{method:'POST'});
  let tries=0;
  const p=setInterval(async()=>{
    await fetchDevices(); tries++;
    if(tries>15){clearInterval(p);scanning=false;btn.textContent='▶ Пінг';btn.classList.remove('spin');}
  },2000);
  startAutoCountdown();
}

async function triggerDeepScan(){
  if(deepScanning)return; deepScanning=true;
  const btn=document.getElementById('deepBtn');
  btn.textContent='🔬 Сканування...'; btn.classList.add('spin');
  await fetch('/api/deep_scan',{method:'POST'});
  // Deep scan takes time — poll until last_scan updates
  let prev=0; let tries=0;
  const p=setInterval(async()=>{
    const r=await fetch('/api/devices'); const data=await r.json();
    tries++;
    if(data.last_scan!==prev||tries>60){
      allDevices=data.devices; render(); prev=data.last_scan;
    }
    if(tries>60){clearInterval(p);deepScanning=false;btn.textContent='🔬 Глибокий скан';btn.classList.remove('spin');}
  },3000);
}

async function singlePing(id,ip){
  const btn=document.getElementById('ping_'+id);
  if(btn){btn.textContent='...';btn.classList.add('pinging');}
  try{
    const r=await fetch('/api/ping/'+ip);
    if(!r.ok){
      console.error('ping error',r.status, await r.text());
      if(btn){btn.textContent='⚡';btn.classList.remove('pinging');}
      return;
    }
    const data=await r.json();
    // Update allDevices cache
    const dev=allDevices.find(d=>d.id===id);
    if(dev){dev.online=data.alive;dev.latency=data.latency;}
    // Push to local history so sparkline updates immediately
    _pushPingHist(ip, data.alive, data.latency);
    // In-place DOM update — no full re-render needed
    _updatePingCell(id, data);
    _updateRowStatus(id, data.alive);
    _updateStats();
  }catch(e){console.error('singlePing',e);}
  if(btn){btn.textContent='⚡';btn.classList.remove('pinging');}
}

function _pushPingHist(ip, alive, ms){
  if(!pingHist[ip]) pingHist[ip]=[];
  // Keep max 144 points
  pingHist[ip].push({ts:Date.now()/1000, ms:ms, alive:alive});
  if(pingHist[ip].length>144) pingHist[ip].shift();
}

function _updatePingCell(id, data){
  const btn=document.getElementById('ping_'+id);
  if(!btn) return;
  const row=btn.closest('.dr');
  if(!row) return;
  const dev=allDevices.find(d=>d.id===id);
  if(!dev) return;
  // pingCell() returns a <div class="ping-cell"> — find its wrapper div in the row
  // The wrapper is the direct child of .dr that contains .ping-cell (or is the cell itself)
  const existing=row.querySelector('.ping-cell');
  if(existing){
    // Replace the ping-cell div directly
    const tmp=document.createElement('div');
    tmp.innerHTML=pingCell(dev);
    existing.replaceWith(tmp.firstElementChild||tmp);
  } else {
    // ping-cell doesn't exist yet — find the slot by position (before .dev-act)
    const actDiv=row.querySelector('.dev-act');
    if(!actDiv) return;
    const slot=actDiv.previousElementSibling;
    if(!slot) return;
    const tmp=document.createElement('div');
    tmp.innerHTML=pingCell(dev);
    slot.replaceWith(tmp.firstElementChild||tmp);
  }
}

function _updateRowStatus(id, alive){
  const row=document.getElementById('ping_'+id)?.closest('.dr');
  if(!row) return;
  const s=alive===true?'on':alive===false?'off':'unk';
  row.className=`dr ${s}${row.classList.contains('dr-selected')?' dr-selected':''}`;
  // dot has class .dot — find it explicitly
  const dot=row.querySelector('.dot');
  if(dot) dot.className=`dot ${s}`;
}


function _updateStats(){
  const lats=allDevices.filter(d=>d.latency!=null&&d.online===true).map(d=>d.latency);
  const avgPing=lats.length?Math.round(lats.reduce((a,b)=>a+b,0)/lats.length):null;
  document.getElementById('sTotal').textContent=allDevices.length;
  document.getElementById('sOnline').textContent=allDevices.filter(d=>d.online===true).length;
  document.getElementById('sOffline').textContent=allDevices.filter(d=>d.online===false).length;
  document.getElementById('sUnknown').textContent=allDevices.filter(d=>d.online==null).length;
  document.getElementById('sAvgPing').textContent=avgPing?avgPing+' мс':'—';
  updatePowerBanner(allDevices);
}
function setFilter(f,el){
  currentFilter=f;
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active'); render();
}

// ── Search ────────────────────────────────────────────────────────────────────
function setSearch(val){
  searchQuery=val.trim().toLowerCase();
  document.getElementById('searchClear').style.display=searchQuery?'block':'none';
  render();
}

function clearSearch(){
  searchQuery='';
  document.getElementById('searchInput').value='';
  document.getElementById('searchClear').style.display='none';
  render();
}

function matchesSearch(d){
  if(!searchQuery) return true;
  const q=searchQuery;
  return (d.ip||'').includes(q)
    ||(d.name||'').toLowerCase().includes(q)
    ||(d.location||'').toLowerCase().includes(q)
    ||(d.vendor||'').toLowerCase().includes(q)
    ||(d.model||'').toLowerCase().includes(q)
    ||(d.mac||'').toLowerCase().includes(q)
    ||(d.type||'').toLowerCase().includes(q);
}

// ── Subnets ───────────────────────────────────────────────────────────────────
async function fetchSubnets(){const r=await fetch('/api/subnets');allSubnets=await r.json();}

function renderSubnetUI(){
  const list=document.getElementById('snList');
  list.innerHTML=allSubnets.length===0
    ?'<div style="color:var(--muted);font-size:12px;padding:6px 0">Подсетей пока нет</div>'
    :allSubnets.map(s=>`
      <div class="sn-row">
        <div class="dot alive"></div>
        <div class="sn-lbl">${s.label}</div>
        <span class="sn-cnt">${s.device_count||0} уст.</span>
        <label class="toggle-wrap">
          <input type="checkbox" ${s.scan?'checked':''} onchange="toggleSnScan('${s.prefix}',this.checked)">
          <span>Сканувати</span>
        </label>
        <button class="btn btn-del" onclick="deleteSubnet('${s.prefix}')">✕</button>
      </div>`).join('');

  const checks=document.getElementById('discChecks');
  checks.innerHTML=allSubnets.length===0
    ?'<span style="font-size:11px;color:var(--muted)">Немає підмереж</span>'
    :allSubnets.map(s=>{
      const id='dchk_'+s.prefix.replace(/\./g,'_');
      return `<div class="chk-wrap">
        <input type="checkbox" id="${id}" value="${s.prefix}" ${s.scan?'checked':''}>
        <label for="${id}">${s.label}</label>
      </div>`;
    }).join('');
}

async function addSubnet(){
  const val=document.getElementById('snInput').value.trim();
  if(!val)return;
  const r=await fetch('/api/subnets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix:val,scan:true})});
  if(r.status===409){alert('Уже есть');return;}
  if(!r.ok){alert('Невірний формат. Наприклад: 192.168.99 або 192.168.99.0/24');return;}
  document.getElementById('snInput').value='';
  await fetchSubnets(); renderSubnetUI(); render();
}

async function deleteSubnet(prefix){
  if(!confirm(`Видалити ${prefix}.0/24?\nПристроїва останутся в базе.`))return;
  await fetch('/api/subnets/'+prefix,{method:'DELETE'});
  await fetchSubnets(); renderSubnetUI(); render();
}

async function toggleSnScan(prefix,val){
  await fetch('/api/subnets/'+prefix,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scan:val})});
  await fetchSubnets(); renderSubnetUI();
}

// ── Host discovery ────────────────────────────────────────────────────────────
async function startDiscovery(){
  const subnets=[]; document.querySelectorAll('#discChecks input:checked').forEach(c=>subnets.push(c.value));
  if(!subnets.length){alert('Оберіть підмережу');return;}
  document.getElementById('discPanels').style.display='none';
  document.getElementById('discStats').style.display='none';
  document.getElementById('discProg').classList.add('show');
  document.getElementById('dProgFill').style.width='0%';
  document.getElementById('dProgPct').textContent='0%';
  document.getElementById('dProgLbl').textContent='Запуск...';
  const btn=document.getElementById('discBtn'); btn.textContent='⟳ Сканування...'; btn.disabled=true;
  await fetch('/api/discovery/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subnets})});
  if(discPoll)clearInterval(discPoll);
  discPoll=setInterval(pollDisc,1500);
}

async function pollDisc(){
  const r=await fetch('/api/discovery/status'); const d=await r.json();
  document.getElementById('dProgFill').style.width=d.progress+'%';
  document.getElementById('dProgPct').textContent=d.progress+'%';
  if(d.running){
    document.getElementById('dProgLbl').textContent=`${d.done}/${d.total} адресов · ${d.alive_count} живих`;
  } else {
    document.getElementById('dProgLbl').textContent=`✅ ${d.alive_count} активних хостів`;
  }
  if(d.alive_count>0||!d.running){
    document.getElementById('discStats').style.display='grid';
    document.getElementById('discPanels').style.display='grid';
    document.getElementById('dTotal').textContent=d.total||'—';
    document.getElementById('dAlive').textContent=d.alive_count;
    document.getElementById('dNew').textContent=d.new_count;
    document.getElementById('dKnown').textContent=d.known_count;
    renderDiscLists(d);
  }
  if(!d.running){
    clearInterval(discPoll);
    const btn=document.getElementById('discBtn'); btn.textContent='🔍 Запустити'; btn.disabled=false;
  }
}

function renderDiscLists(d){
  const devMap={}; allDevices.forEach(dev=>{devMap[dev.ip]=dev;});
  document.getElementById('dNewCnt').textContent=d.new_count;
  document.getElementById('dNewList').innerHTML=d.new_devices.length===0
    ?`<div class="empty">${d.running?'Ищем...<br>':''}Все зареєстровано 🎉</div>`
    :d.new_devices.map(ip=>`
      <div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">${ip}</div>
        <span class="badge b-new">Новий</span>
        <button class="btn btn-yel" onclick="openAddModal('${ip}')">+ До бази</button>
      </div>`).join('');
  document.getElementById('dKnownCnt').textContent=d.known_count;
  document.getElementById('dKnownList').innerHTML=d.known_devices.length===0
    ?`<div class="empty">${d.running?'Ищем...<br>':''}Ничего не найдено</div>`
    :d.known_devices.map(ip=>{
      const dev=devMap[ip]||{}; const meta=[dev.name,dev.vendor||dev.location].filter(Boolean).join(' · ');
      return `<div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">${ip}</div>
        <div class="ip-meta" title="${meta}">${meta||'—'}</div>
        <span class="badge b-known">В базі</span>
      </div>`;
    }).join('');
}

// ── Subnet range scanner ──────────────────────────────────────────────────────
async function startSnScan(){
  document.getElementById('snScanPanels').style.display='none';
  document.getElementById('snScanStats').style.display='none';
  document.getElementById('snProg').classList.add('show');
  document.getElementById('snProgFill').style.width='0%';
  document.getElementById('snProgPct').textContent='0%';
  document.getElementById('snProgLbl').textContent='Запуск...';
  const btn=document.getElementById('snScanBtn'); btn.textContent='⟳ Сканування...'; btn.classList.add('spin'); btn.disabled=true;
  await fetch('/api/subnet_scan/start',{method:'POST'});
  if(snScanPoll)clearInterval(snScanPoll);
  snScanPoll=setInterval(pollSnScan,1500);
}

async function pollSnScan(){
  const r=await fetch('/api/subnet_scan/status'); const d=await r.json();
  document.getElementById('snProgFill').style.width=d.progress+'%';
  document.getElementById('snProgPct').textContent=d.progress+'%';
  document.getElementById('snProgLbl').textContent=d.running
    ?`${d.done}/256 подсетей · живих: ${d.alive_count}`
    :`✅ Завершено — ${d.alive_count} активних подсетей`;
  if(d.alive_count>0||!d.running){
    document.getElementById('snScanStats').style.display='grid';
    document.getElementById('snScanPanels').style.display='grid';
    document.getElementById('snStTotal').textContent=256;
    document.getElementById('snStAlive').textContent=d.alive_count;
    document.getElementById('snStNew').textContent=d.new_subnets.length;
    document.getElementById('snStKnown').textContent=d.known_subnets.length;
    renderSnLists(d);
  }
  if(!d.running){
    clearInterval(snScanPoll);
    const btn=document.getElementById('snScanBtn'); btn.textContent='🛰 Сканувати'; btn.classList.remove('spin'); btn.disabled=false;
  }
}

function renderSnLists(d){
  const snMap={}; allSubnets.forEach(s=>{snMap[s.prefix]=s;});
  document.getElementById('snNewCnt').textContent=d.new_subnets.length;
  document.getElementById('snNewList').innerHTML=d.new_subnets.length===0
    ?`<div class="empty">${d.running?'Пошук...<br>':''}Всі живі підмережі в реєстрі 🎉</div>`
    :d.new_subnets.map(x=>`
      <div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">192.168.${x}.0/24</div>
        <div class="ip-meta">192.168.${x}.1 ↓</div>
        <span class="badge b-new">Новая</span>
        <button class="btn btn-yel" onclick="addSnFromScan('192.168.${x}')">+ Реестр</button>
      </div>`).join('');
  document.getElementById('snKnownCnt').textContent=d.known_subnets.length;
  document.getElementById('snKnownList').innerHTML=d.known_subnets.length===0
    ?`<div class="empty">${d.running?'Пошук...<br>':''}Не найдено</div>`
    :d.known_subnets.map(x=>{
      const sn=snMap[`192.168.${x}`]||{};
      return `<div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">192.168.${x}.0/24</div>
        <div class="ip-meta">${sn.device_count||0} уст.</div>
        <span class="badge b-known">В реєстрі</span>
      </div>`;
    }).join('');
}

async function addSnFromScan(prefix){
  await fetch('/api/subnets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix,scan:true})});
  await fetchSubnets(); renderSubnetUI();
  const res=await fetch('/api/subnet_scan/status'); renderSnLists(await res.json());
}

// ── Device modal ──────────────────────────────────────────────────────────────
function openAddModal(ip=''){
  document.getElementById('mTitle').textContent='Додати пристрій';
  document.getElementById('mId').value='';
  document.getElementById('mIp').value=ip;
  document.getElementById('mName').value='';
  document.getElementById('mLoc').value='';
  document.getElementById('mType').value='client';
  document.getElementById('mMac').value='';
  document.getElementById('mVendor').value='';
  document.getElementById('mModel').value='';
  document.getElementById('mLogin').value='';
  document.getElementById('mPassword').value='';
  document.getElementById('devModal').classList.add('open');
}
function openEditModal(id){
  const d=allDevices.find(x=>x.id===id); if(!d)return;
  document.getElementById('mTitle').textContent='Изменить пристрій';
  document.getElementById('mId').value=id;
  document.getElementById('mIp').value=d.ip;
  document.getElementById('mName').value=d.name;
  document.getElementById('mLoc').value=d.location||'';
  document.getElementById('mType').value=d.type||'client';
  document.getElementById('mMac').value=d.mac||'';
  document.getElementById('mVendor').value=d.vendor||'';
  document.getElementById('mModel').value=d.model||'';
  document.getElementById('mLogin').value=d.cred_login||'';
  document.getElementById('mPassword').value='';  // never pre-fill password
  document.getElementById('devModal').classList.add('open');
}
// ── Modal deep-scan autofill ──────────────────────────────────────────────────
async function modalScanHost() {
  const ip = document.getElementById('mIp').value.trim();
  if (!ip) { alert('Сначала введите IP адреса'); return; }

  const btn    = document.getElementById('mScanBtn');
  const status = document.getElementById('mScanStatus');
  const ports  = document.getElementById('mScanPorts');

  btn.disabled = true;
  btn.textContent = '⟳ Сканування...';
  btn.classList.add('spin');
  status.textContent = `Сканируем ${ip}...`;
  status.style.color = 'var(--muted)';
  ports.style.display = 'none';

  try {
    const r = await fetch('/api/scan_host/' + encodeURIComponent(ip));
    const d = await r.json();

    if (!d.alive) {
      status.textContent = `⚠️ Хост ${ip} не відповідає на пінг — дані можуть бути неповними`;
      status.style.color = 'var(--yel)';
    } else {
      status.textContent = `✅ Скан завершено · пінг ${d.latency ?? '?'} мс`;
      status.style.color = 'var(--green)';
    }

    // Autofill fields (only if empty or override)
    if (d.mac)    setIfEmpty('mMac',    d.mac);
    if (d.vendor) setIfEmpty('mVendor', d.vendor);
    if (d.model)  setIfEmpty('mModel',  d.model);

    // If MAC is empty — show explanation
    if (!d.mac && d.alive) {
      const macEl = document.getElementById('mMac');
      if (!macEl.value) {
        macEl.placeholder = 'Недоступний (пристрій за роутером)';
        macEl.style.color = 'var(--muted)';
      }
    }

    // Set type from fingerprint if field is default
    if (d.suggested_type && document.getElementById('mType').value === 'client') {
      document.getElementById('mType').value = d.suggested_type;
    }

    // Autofill name if empty
    if (!document.getElementById('mName').value && d.model) {
      document.getElementById('mName').value = d.model;
    }

    // Show open ports
    if (d.open_ports && d.open_ports.length) {
      ports.style.display = 'block';
      ports.innerHTML = `<span style="color:var(--acc)">Відкриті порти:</span> ` +
        d.open_ports.map(p =>
          `<span style="background:var(--ad);color:var(--acc);padding:1px 5px;border-radius:3px;font-weight:700">${p}</span>`
        ).join(' ');
    } else if (d.alive) {
      ports.style.display = 'block';
      ports.innerHTML = '<span style="color:var(--muted)">Відкритих портів не виявлено</span>';
    }

    // Flash filled fields
    ['mMac','mVendor','mModel'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.value) { el.style.borderColor='var(--green)'; setTimeout(()=>el.style.borderColor='',2000); }
    });

  } catch(e) {
    status.textContent = '❌ Помилка: ' + e;
    status.style.color = 'var(--red)';
  }

  btn.disabled = false;
  btn.textContent = '🔬 Автозаполнить (скан)';
  btn.classList.remove('spin');
}

function setIfEmpty(id, val) {
  const el = document.getElementById(id);
  if (el && !el.value) el.value = val;
}

function closeModal(){document.getElementById('devModal').classList.remove('open');}
async function saveDevice(){
  const id=document.getElementById('mId').value;
  const pwd=document.getElementById('mPassword').value;
  const ip=document.getElementById('mIp').value.trim();
  if(!ip){alert('Введіть IP адресау');return;}
  const payload={
    ip,
    name:document.getElementById('mName').value,
    location:document.getElementById('mLoc').value,
    type:document.getElementById('mType').value,
    mac:document.getElementById('mMac').value,
    vendor:document.getElementById('mVendor').value,
    model:document.getElementById('mModel').value,
    cred_login:document.getElementById('mLogin').value
  };
  if(pwd) payload.cred_password=pwd;

  const r=await fetch(id?'/api/devices/'+id:'/api/devices',{
    method:id?'PUT':'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  if(!r.ok){
    const e=await r.json().catch(()=>({}));
    alert('Помилка збереження: '+(e.error||r.status));
    return;
  }
  closeModal();
  // Sequential: wait for each to complete so globals are updated before render
  await fetchSubnets();
  await fetchDevices();
  renderSubnetUI();
  // Refresh discovery list if that tab is open
  if(document.getElementById('tab-discovery').classList.contains('active')){
    try{
      const ds=await fetch('/api/discovery/status');
      const dd=await ds.json();
      if(dd.total>0) renderDiscLists(dd);
    }catch(e){}
  }
}
async function rebootDevice(id){
  const dev=allDevices.find(d=>d.id===id);
  if(!dev) return;
  if(!dev.has_creds){
    alert(`Пристрій "${dev.name}" не має збережених облікових даних.\nВідкрийте редагувание (✏) и добавьте логин и пароль.`);
    return;
  }
  if(!confirm(`Перезавантажити "${dev.name}" (${dev.ip})?\n\nПристрій будет недоступно ~30-120 секунд.`)) return;
  const btn=document.getElementById('reboot_'+id);
  if(btn){btn.textContent='⟳...';btn.classList.add('rebooting');btn.disabled=true;}
  try{
    const r=await fetch('/api/reboot/'+id,{method:'POST'});
    const d=await r.json();
    if(btn){btn.textContent='⟳ Reboot';btn.classList.remove('rebooting');btn.disabled=false;}
    if(d.ok){
      alert(`✅ ${dev.name}\n\nМетод: ${d.method}\n${d.detail}\n\nПристрій перезагружается...`);
      // Mark as offline temporarily
      const dv=allDevices.find(x=>x.id===id);
      if(dv) dv.online=false;
      render();
    } else {
      alert(`❌ Помилка перезавантаження\n\nМетод: ${d.method}\n${d.detail}`);
    }
  } catch(e){
    if(btn){btn.textContent='⟳ Reboot';btn.classList.remove('rebooting');btn.disabled=false;}
    alert('Помилка сети: '+e);
  }
}

function togglePwd(){
  const inp=document.getElementById('mPassword');
  const btn=document.getElementById('eyeBtn');
  if(inp.type==='password'){inp.type='text';btn.textContent='🙈';}
  else{inp.type='password';btn.textContent='👁';}
}

async function delDevice(id){
  if(!confirm('Видалити пристрій?'))return;
  await fetch('/api/devices/'+id,{method:'DELETE'}); fetchDevices();
}

// ── Auto-scan dashboard ───────────────────────────────────────────────────────
function fmtAgo(ts){
  if(!ts) return 'никогда';
  const s=Math.round((Date.now()/1000)-ts);
  if(s<60) return s+'с назад';
  if(s<3600) return Math.floor(s/60)+'м назад';
  return Math.floor(s/3600)+'ч назад';
}
function fmtCountdown(total, elapsed){
  const left=Math.max(0,total-elapsed);
  if(left<60) return 'через '+left+'с';
  return 'через '+Math.floor(left/60)+'м '+left%60+'с';
}

async function fetchAutoScan(){
  try{
    const r=await fetch('/api/auto_scan/status');
    const d=await r.json();
    renderAutoScan(d);
  }catch(e){}
}

let _autoscanOpen = false;

function toggleAutoscanDropdown(){
  _autoscanOpen = !_autoscanOpen;
  const dd  = document.getElementById('autoscanDropdown');
  const arr = document.getElementById('autoBadgeArrow');
  dd.style.display  = _autoscanOpen ? 'block' : 'none';
  if(arr) arr.style.transform = _autoscanOpen ? 'rotate(180deg)' : '';
  // Close on outside click
  if(_autoscanOpen){
    setTimeout(()=>{
      document.addEventListener('click', _closeAutoscanOutside, {once:true});
    }, 50);
  }
}

function _closeAutoscanOutside(e){
  const dd = document.getElementById('autoscanDropdown');
  const btn = document.getElementById('autoBadge');
  if(dd && !dd.contains(e.target) && btn && !btn.contains(e.target)){
    _autoscanOpen = false;
    dd.style.display = 'none';
    const arr = document.getElementById('autoBadgeArrow');
    if(arr) arr.style.transform = '';
  } else if(_autoscanOpen){
    // re-attach if click was inside dropdown
    setTimeout(()=>{
      document.addEventListener('click', _closeAutoscanOutside, {once:true});
    }, 50);
  }
}

function renderAutoScan(d){
  const disc = d.discovery, sn = d.subnet;
  const totalNew = (disc.new_count||0) + (sn.new_count||0);

  // ── Badge counter ────────────────────────────────────────────────────────
  const cnt = document.getElementById('autoBadgeCount');
  const btn = document.getElementById('autoBadge');
  if(cnt){
    if(totalNew > 0){
      cnt.style.display = 'inline';
      cnt.textContent   = totalNew;
      if(btn) btn.style.borderColor = '#ffb30060';
    } else {
      cnt.style.display = 'none';
      if(btn) btn.style.borderColor = '#00e67630';
    }
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  const discPulse = document.getElementById('discPulse');
  const discLbl   = document.getElementById('discTimerLbl');
  if(discPulse && discLbl){
    if(disc.running){
      discPulse.style.background   = 'var(--green)';
      discPulse.style.animation    = 'blink 1s infinite';
      discLbl.textContent = 'сканирование...';
    } else if(disc.last_run){
      discPulse.style.background   = 'var(--muted)';
      discPulse.style.animation    = 'none';
      const el = Math.round(Date.now()/1000 - disc.last_run);
      discLbl.textContent = fmtAgo(disc.last_run) + ' · ' + fmtCountdown(300, el);
    } else {
      discPulse.style.background = 'var(--muted)';
      discLbl.textContent = 'ожидание запуска...';
    }
  }

  const snPulse = document.getElementById('snPulse');
  const snLbl   = document.getElementById('snTimerLbl');
  if(snPulse && snLbl){
    if(sn.running){
      snPulse.style.background  = 'var(--pur)';
      snPulse.style.animation   = 'blink 1s infinite';
      snLbl.textContent = 'сканирование...';
    } else if(sn.last_run){
      snPulse.style.background  = 'var(--muted)';
      snPulse.style.animation   = 'none';
      const el = Math.round(Date.now()/1000 - sn.last_run);
      snLbl.textContent = fmtAgo(sn.last_run) + ' · ' + fmtCountdown(900, el);
    } else {
      snPulse.style.background = 'var(--muted)';
      snLbl.textContent = 'ожидание запуска...';
    }
  }

  // ── Незарег. хости ────────────────────────────────────────────────────────
  const discEl = document.getElementById('autoDiscList');
  if(discEl){
    if(disc.running){
      discEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">⟳ сканирование...</div>';
    } else if(!disc.last_run){
      discEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">~90с после старта</div>';
    } else if(!disc.new_count){
      discEl.innerHTML = '<div style="font-size:11px;color:var(--green)">✅ все зарег.</div>';
    } else {
      discEl.innerHTML = disc.new_devices.map(ip => `
        <div style="display:flex;align-items:center;gap:5px;padding:4px 0;border-bottom:1px solid var(--bd)">
          <div style="width:6px;height:6px;border-radius:50%;background:var(--yel);flex-shrink:0"></div>
          <span style="font-size:11px;font-family:'JetBrains Mono',monospace;flex:1">${ip}</span>
          <button class="btn btn-yel" style="padding:1px 7px;font-size:9px"
            onclick="openAddModal('${ip}');toggleAutoscanDropdown()">+ До бази</button>
        </div>`).join('');
    }
  }

  // ── Нові підмережі ─────────────────────────────────────────────────────────
  const snEl = document.getElementById('autoSnList');
  if(snEl){
    if(sn.running){
      snEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">⟳ сканирование...</div>';
    } else if(!sn.last_run){
      snEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">~3м после старта</div>';
    } else if(!sn.new_count){
      snEl.innerHTML = '<div style="font-size:11px;color:var(--green)">✅ немає нових</div>';
    } else {
      snEl.innerHTML = sn.new_subnets.map(x => `
        <div style="display:flex;align-items:center;gap:5px;padding:4px 0;border-bottom:1px solid var(--bd)">
          <div style="width:6px;height:6px;border-radius:50%;background:var(--pur);flex-shrink:0"></div>
          <span style="font-size:11px;font-family:'JetBrains Mono',monospace;flex:1">192.168.${x}.0/24</span>
          <button class="btn btn-yel" style="padding:1px 7px;font-size:9px"
            onclick="addAutoSubnet(${x})">+ Реестр</button>
        </div>`).join('');
    }
  }
}

async function addAutoSubnet(x){
  await fetch('/api/subnets',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({prefix:'192.168.'+x,scan:true})});
  await fetchSubnets(); renderSubnetUI(); fetchAutoScan();
}

// ── Events tab ────────────────────────────────────────────────────────────────
let allEvents=[];
let evFilter='all';

const EV_ICONS={down:'🔴',up:'🟢',power_off:'⚡🔴',power_on:'⚡🟢',reboot:'🔄',new_host:'🆕',down_alert:'⚠️'};
const EV_LABELS={down:'Недоступний',up:'Онлайн',power_off:'Світло відключено',power_on:'Світло відновлено',
                 reboot:'Перезавантаження',new_host:'Новий хост',down_alert:'Долго недоступен'};

async function fetchEvents(){
  try{
    const r=await fetch('/api/events?limit=300');
    allEvents=await r.json();
    renderEvents();
    _checkNewEventsForSound(allEvents);
  }catch(e){}
  // Also refresh device list in test select
  _refreshEvTestSelect();
}

function _refreshEvTestSelect(){
  const sel=document.getElementById('evTestIp');
  if(!sel||!allDevices.length) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">— оберіть пристрій —</option>'+
    allDevices.map(d=>{
      const status=d.online===true?'🟢':d.online===false?'🔴':'⚪';
      return `<option value="${d.ip}">${status} ${d.name} (${d.ip})</option>`;
    }).join('');
  if(cur) sel.value=cur;
}

async function testEvent(kind){
  const ip=document.getElementById('evTestIp').value;
  const st=document.getElementById('evTestStatus');
  if(!ip){st.textContent='⚠️ Оберіть пристрій';return;}
  st.textContent='⟳ Надсилання...';
  try{
    const r=await fetch('/api/test/event',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ip, kind})
    });
    const d=await r.json();
    if(d.ok){
      st.style.color='var(--green)';
      st.textContent=`✅ Подія "${kind}" для ${ip} создано`;
      setTimeout(()=>fetchEvents(), 500);  // refresh list
    } else {
      st.style.color='var(--red)';
      st.textContent='❌ '+(d.error||'Помилка');
    }
  }catch(e){
    st.style.color='var(--red)';
    st.textContent='❌ '+e;
  }
  setTimeout(()=>{st.textContent='';st.style.color='';},5000);
}

function setEvFilter(f,el){
  evFilter=f;
  document.querySelectorAll('.ev-filter-bar .fbtn').forEach(b=>b.classList.remove('active'));
  if(el) el.classList.add('active');
  renderEvents();
}

function renderEvents(){
  const el=document.getElementById('evList');
  const cntEl=document.getElementById('evCount');
  let evs=allEvents;
  if(evFilter!=='all'){
    if(evFilter==='power_off') evs=evs.filter(e=>e.kind==='power_off'||e.kind==='power_on');
    else evs=evs.filter(e=>e.kind===evFilter||e.kind===evFilter+'_alert');
  }
  cntEl.textContent=evs.length+' подій';
  if(!evs.length){el.innerHTML='<div class="ev-empty">Немає подій</div>';return;}
  el.innerHTML=evs.map(e=>{
    const d=new Date(e.ts*1000);
    const ts=d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('ru-RU');
    return `<div class="ev-row ${e.kind}">
      <div class="ev-icon">${EV_ICONS[e.kind]||'ℹ️'}</div>
      <div class="ev-body">
        <div style="display:flex;align-items:baseline;gap:7px;flex-wrap:wrap">
          <span class="ev-name">${e.name}</span>
          <span class="ev-ip">${e.ip}</span>
          <span style="font-size:10px;color:var(--muted)">${EV_LABELS[e.kind]||e.kind}</span>
        </div>
        ${e.detail?`<div class="ev-detail">${e.detail}</div>`:''}
      </div>
      <div class="ev-ts">${ts}</div>
    </div>`;
  }).join('');
}

async function clearEvents(){
  if(!confirm('Очистити весь журнал подій?'))return;
  await fetch('/api/events',{method:'DELETE'});
  allEvents=[]; renderEvents();
}

// ── Telegram settings (multi-recipient) ──────────────────────────────────────
let _recipients = [];

async function loadTg(){
  try{
    const r=await fetch('/api/telegram');
    const d=await r.json();
    document.getElementById('tgDownMin').value=d.down_min||5;
    document.getElementById('tgPower').checked=d.notify_power!==false;
    document.getElementById('tgDevice').checked=d.notify_device!==false;
    document.getElementById('tgHost').checked=d.notify_new_host!==false;
    document.getElementById('tgEnabled').checked=!!d.enabled;
    document.getElementById('powerIpInp').value=POWER_IP;
    await loadRecipients();
  }catch(e){}
}

async function loadRecipients(){
  try{
    const r=await fetch('/api/telegram/recipients');
    _recipients=await r.json();
    renderRecipients();
  }catch(e){}
}

function renderRecipients(){
  const el=document.getElementById('recipientList');
  if(!_recipients.length){
    el.innerHTML='<div style="font-size:11px;color:var(--muted);padding:6px 0">Нет получателей — добавьте Chat ID ниже</div>';
    return;
  }
  el.innerHTML=_recipients.map(r=>`
    <div style="display:flex;align-items:center;gap:8px;padding:8px 11px;background:var(--sf2);border:1px solid var(--bd);border-radius:8px">
      <div class="dot ${r.active?'on':'off'}" style="flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700">${r.label||r.chat_id}</div>
        <div style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace">${r.chat_id}</div>
      </div>
      <button class="btn btn-cyan" style="padding:3px 9px;font-size:10px" onclick="testRecipient('${r.chat_id}')">📨 Тест</button>
      <label class="tg-toggle" style="margin:0" title="${r.active?'Активний':'Вимкнений'}">
        <input type="checkbox" ${r.active?'checked':''} onchange="toggleRecipient('${r.chat_id}',this.checked)"> вкл
      </label>
      <button class="btn btn-del" style="padding:3px 9px;font-size:10px" onclick="deleteRecipient('${r.chat_id}')">✕</button>
    </div>`).join('');
}

async function addRecipient(){
  const chat_id=document.getElementById('newChatId').value.trim();
  const label=document.getElementById('newChatLabel').value.trim();
  if(!chat_id){alert('Введите Chat ID');return;}
  const r=await fetch('/api/telegram/recipients',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id,label:label||chat_id})});
  if(r.ok){
    document.getElementById('newChatId').value='';
    document.getElementById('newChatLabel').value='';
    await loadRecipients();
  } else {
    const d=await r.json();
    alert(d.error||'Помилка добавления');
  }
}

async function deleteRecipient(chat_id){
  if(!confirm('Видалити получателя '+chat_id+'?'))return;
  await fetch('/api/telegram/recipients/'+encodeURIComponent(chat_id),{method:'DELETE'});
  await loadRecipients();
}

async function toggleRecipient(chat_id,active){
  await fetch('/api/telegram/recipients/'+encodeURIComponent(chat_id),{
    method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({active})});
  await loadRecipients();
}

async function testRecipient(chat_id){
  const r=await fetch('/api/telegram/test',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id})});
  const d=await r.json();
  alert(d.status==='sent'?'✅ Сообщение відправлено в '+chat_id:'❌ Помилка відправки');
}

async function saveTg(){
  const token=document.getElementById('tgToken').value.trim();
  const payload={
    down_min:parseInt(document.getElementById('tgDownMin').value)||5,
    notify_power:document.getElementById('tgPower').checked,
    notify_device:document.getElementById('tgDevice').checked,
    notify_new_host:document.getElementById('tgHost').checked,
    enabled:document.getElementById('tgEnabled').checked,
  };
  if(token) payload.token=token;
  const r=await fetch('/api/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const d=await r.json();
  const st=document.getElementById('tgStatus');
  if(d.status==='saved'){st.className='tg-status tg-ok';st.textContent='✅ Збережено';}
  else{st.className='tg-status tg-err';st.textContent='❌ Помилка';}
  setTimeout(()=>st.textContent='',3000);
}

function savePowerIp(){
  const v=document.getElementById('powerIpInp').value.trim();
  if(v){ window.POWER_IP=v; alert('IP оновлено до '+v+'\n(Действует до перезавантаження сторінки)'); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function changeAuth(){
  const u=document.getElementById('newUsername').value.trim();
  const p=document.getElementById('newPassword').value;
  const p2=document.getElementById('newPassword2').value;
  const st=document.getElementById('authStatus');
  if(!u||!p){st.className='tg-status tg-err';st.textContent='❌ Заполните все поля';setTimeout(()=>st.textContent='',3000);return;}
  if(p!==p2){st.className='tg-status tg-err';st.textContent='❌ Паролі не збігаються';setTimeout(()=>st.textContent='',3000);return;}
  const r=await fetch('/api/auth/change',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u,password:p})});
  const d=await r.json();
  if(d.ok){
    st.className='tg-status tg-ok';st.textContent='✅ Дані оновлено';
    document.getElementById('newUsername').value='';
    document.getElementById('newPassword').value='';
    document.getElementById('newPassword2').value='';
  }else{st.className='tg-status tg-err';st.textContent='❌ '+(d.error||'Помилка');}
  setTimeout(()=>st.textContent='',4000);
}

async function doLogout(){
  await fetch('/logout',{method:'POST'});
  window.location.href='/login';
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async()=>{
  await Promise.all([fetchDevices(),fetchSubnets()]);
  renderSubnetUI();
  startAutoCountdown();
  fetchAutoScan();
  fetchEvents();
  loadTg();
  // ── WebSocket real-time updates ──────────────────────────────────────────
  _initWebSocket();

  // Fallback polling — значительно реже чем раньше, только если WS недоступен
  setInterval(()=>{ if(!_wsConnected) fetchDevices(); }, 30000);
  setInterval(()=>{ if(!_wsConnected) fetchEvents();  }, 15000);

  // Sparklines и дашборд обновляются только по таймеру (не через WS)
  setInterval(refreshAllHistory, 60000);
  setInterval(fetchAutoScan,    10000);
  setInterval(()=>{ if(document.getElementById('tab-dashboard').classList.contains('active')) loadDashboard(); }, 120000);
})();
// ══════════════════════════════════════════════════════════════════════════════
