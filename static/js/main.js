const TL={router:'Роутер',ap:'WiFi AP',camera:'Камера',client:'Клиент',mobile:'Мобильный',server:'Сервер'};
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
    document.getElementById('autoBadgeText').textContent=`⏱ авто-пинг ${autoCountdown}с`;
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
    icon.textContent='⚡'; title.textContent='Статус питания: неизвестно';
    sub.textContent=`Ожидание пинга ${POWER_IP}`;
  } else if(gw.online===true){
    banner.className='power-banner power-on';
    icon.textContent='⚡'; title.textContent='Свет есть — питание в норме';
    sub.textContent=`${POWER_IP} отвечает${gw.latency!=null?' · пинг '+gw.latency+' мс':''}`;
  } else {
    banner.className='power-banner power-off';
    icon.textContent='🔴'; title.textContent='НЕТ СВЕТА — питание отсутствует!';
    sub.textContent=`${POWER_IP} не отвечает · вероятно отключение электроэнергии`;
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
    ?`<span class="cred-badge cred-ok" title="Учётные данные сохранены">🔑</span>`
    :`<span class="cred-badge cred-no" title="Нет учётных данных">🔒</span>`;
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
        <input type="checkbox" id="${chkId}" ${allSelected&&devs.length?'checked':''} onchange="toggleSelectSubnet('${p}',this.checked)" title="Выбрать подсеть" style="cursor:pointer;accent-color:var(--acc);margin-right:4px">
        <span class="sn-badge">${label}</span>
        <span style="font-size:11px;color:var(--muted)">${devs.length} уст.</span>
        <span style="font-size:10px;color:var(--green);margin-left:auto">${onCnt} онлайн</span>
      </div>
      <div class="th">
        <span></span><span></span>
        ${thSpan('IP','ip')}
        ${thSpan('Название','name')}
        ${thSpan('Расположение','location')}
        <span>Вендор / Модель</span>
        ${thSpan('Тип','type')}
        ${thSpan('Пинг','latency')}
        <span>Действия</span>
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
          <button class="btn-reboot" id="reboot_${d.id}" onclick="rebootDevice(${d.id})" ${d.has_creds?'':' title="Нет учётных данных" style="opacity:.4"'}>⟳</button>
          <button class="btn btn-ghost" onclick="openEditModal(${d.id})" style="padding:3px 7px;font-size:11px">✏</button>
          <button class="btn btn-del" onclick="delDevice(${d.id})" style="padding:3px 7px;font-size:11px">✕</button>
        </div>
      </div>`;
    });
    html+=`</div></div>`;
  });

  if(!html) html=`<div style="text-align:center;padding:50px;color:var(--muted)">Устройства не найдены</div>`;
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
  let html=`<span>${from}–${to} из ${total}</span>`;
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
  btn.textContent='⟳ Пинг...'; btn.classList.add('spin');
  await fetch('/api/scan',{method:'POST'});
  let tries=0;
  const p=setInterval(async()=>{
    await fetchDevices(); tries++;
    if(tries>15){clearInterval(p);scanning=false;btn.textContent='▶ Пинг';btn.classList.remove('spin');}
  },2000);
  startAutoCountdown();
}

async function triggerDeepScan(){
  if(deepScanning)return; deepScanning=true;
  const btn=document.getElementById('deepBtn');
  btn.textContent='🔬 Сканирование...'; btn.classList.add('spin');
  await fetch('/api/deep_scan',{method:'POST'});
  // Deep scan takes time — poll until last_scan updates
  let prev=0; let tries=0;
  const p=setInterval(async()=>{
    const r=await fetch('/api/devices'); const data=await r.json();
    tries++;
    if(data.last_scan!==prev||tries>60){
      allDevices=data.devices; render(); prev=data.last_scan;
    }
    if(tries>60){clearInterval(p);deepScanning=false;btn.textContent='🔬 Глубокий скан';btn.classList.remove('spin');}
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
          <span>Сканировать</span>
        </label>
        <button class="btn btn-del" onclick="deleteSubnet('${s.prefix}')">✕</button>
      </div>`).join('');

  const checks=document.getElementById('discChecks');
  checks.innerHTML=allSubnets.length===0
    ?'<span style="font-size:11px;color:var(--muted)">Нет подсетей</span>'
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
  if(!r.ok){alert('Неверный формат. Например: 192.168.99 или 192.168.99.0/24');return;}
  document.getElementById('snInput').value='';
  await fetchSubnets(); renderSubnetUI(); render();
}

async function deleteSubnet(prefix){
  if(!confirm(`Удалить ${prefix}.0/24?\nУстройства останутся в базе.`))return;
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
  if(!subnets.length){alert('Выберите подсеть');return;}
  document.getElementById('discPanels').style.display='none';
  document.getElementById('discStats').style.display='none';
  document.getElementById('discProg').classList.add('show');
  document.getElementById('dProgFill').style.width='0%';
  document.getElementById('dProgPct').textContent='0%';
  document.getElementById('dProgLbl').textContent='Запуск...';
  const btn=document.getElementById('discBtn'); btn.textContent='⟳ Сканирование...'; btn.disabled=true;
  await fetch('/api/discovery/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subnets})});
  if(discPoll)clearInterval(discPoll);
  discPoll=setInterval(pollDisc,1500);
}

async function pollDisc(){
  const r=await fetch('/api/discovery/status'); const d=await r.json();
  document.getElementById('dProgFill').style.width=d.progress+'%';
  document.getElementById('dProgPct').textContent=d.progress+'%';
  if(d.running){
    document.getElementById('dProgLbl').textContent=`${d.done}/${d.total} адресов · ${d.alive_count} живых`;
  } else {
    document.getElementById('dProgLbl').textContent=`✅ ${d.alive_count} активных хостов`;
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
    const btn=document.getElementById('discBtn'); btn.textContent='🔍 Запустить'; btn.disabled=false;
  }
}

function renderDiscLists(d){
  const devMap={}; allDevices.forEach(dev=>{devMap[dev.ip]=dev;});
  document.getElementById('dNewCnt').textContent=d.new_count;
  document.getElementById('dNewList').innerHTML=d.new_devices.length===0
    ?`<div class="empty">${d.running?'Ищем...<br>':''}Всё зарегистрировано 🎉</div>`
    :d.new_devices.map(ip=>`
      <div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">${ip}</div>
        <span class="badge b-new">Новый</span>
        <button class="btn btn-yel" onclick="openAddModal('${ip}')">+ В базу</button>
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
        <span class="badge b-known">В базе</span>
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
  const btn=document.getElementById('snScanBtn'); btn.textContent='⟳ Сканирование...'; btn.classList.add('spin'); btn.disabled=true;
  await fetch('/api/subnet_scan/start',{method:'POST'});
  if(snScanPoll)clearInterval(snScanPoll);
  snScanPoll=setInterval(pollSnScan,1500);
}

async function pollSnScan(){
  const r=await fetch('/api/subnet_scan/status'); const d=await r.json();
  document.getElementById('snProgFill').style.width=d.progress+'%';
  document.getElementById('snProgPct').textContent=d.progress+'%';
  document.getElementById('snProgLbl').textContent=d.running
    ?`${d.done}/256 подсетей · живых: ${d.alive_count}`
    :`✅ Завершено — ${d.alive_count} активных подсетей`;
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
    const btn=document.getElementById('snScanBtn'); btn.textContent='🛰 Сканировать'; btn.classList.remove('spin'); btn.disabled=false;
  }
}

function renderSnLists(d){
  const snMap={}; allSubnets.forEach(s=>{snMap[s.prefix]=s;});
  document.getElementById('snNewCnt').textContent=d.new_subnets.length;
  document.getElementById('snNewList').innerHTML=d.new_subnets.length===0
    ?`<div class="empty">${d.running?'Поиск...<br>':''}Все живые подсети в реестре 🎉</div>`
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
    ?`<div class="empty">${d.running?'Поиск...<br>':''}Не найдено</div>`
    :d.known_subnets.map(x=>{
      const sn=snMap[`192.168.${x}`]||{};
      return `<div class="ip-row">
        <div class="dot alive"></div>
        <div class="ip-a">192.168.${x}.0/24</div>
        <div class="ip-meta">${sn.device_count||0} уст.</div>
        <span class="badge b-known">В реестре</span>
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
  document.getElementById('mTitle').textContent='Добавить устройство';
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
  document.getElementById('mTitle').textContent='Изменить устройство';
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
  if (!ip) { alert('Сначала введите IP адрес'); return; }

  const btn    = document.getElementById('mScanBtn');
  const status = document.getElementById('mScanStatus');
  const ports  = document.getElementById('mScanPorts');

  btn.disabled = true;
  btn.textContent = '⟳ Сканирование...';
  btn.classList.add('spin');
  status.textContent = `Сканируем ${ip}...`;
  status.style.color = 'var(--muted)';
  ports.style.display = 'none';

  try {
    const r = await fetch('/api/scan_host/' + encodeURIComponent(ip));
    const d = await r.json();

    if (!d.alive) {
      status.textContent = `⚠️ Хост ${ip} не отвечает на пинг — данные могут быть неполными`;
      status.style.color = 'var(--yel)';
    } else {
      status.textContent = `✅ Скан завершён · пинг ${d.latency ?? '?'} мс`;
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
        macEl.placeholder = 'Недоступен (устройство за роутером)';
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
      ports.innerHTML = `<span style="color:var(--acc)">Открытые порты:</span> ` +
        d.open_ports.map(p =>
          `<span style="background:var(--ad);color:var(--acc);padding:1px 5px;border-radius:3px;font-weight:700">${p}</span>`
        ).join(' ');
    } else if (d.alive) {
      ports.style.display = 'block';
      ports.innerHTML = '<span style="color:var(--muted)">Открытых портов не обнаружено</span>';
    }

    // Flash filled fields
    ['mMac','mVendor','mModel'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.value) { el.style.borderColor='var(--green)'; setTimeout(()=>el.style.borderColor='',2000); }
    });

  } catch(e) {
    status.textContent = '❌ Ошибка: ' + e;
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
  if(!ip){alert('Введите IP адрес');return;}
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
    alert('Ошибка сохранения: '+(e.error||r.status));
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
    alert(`Устройство "${dev.name}" не имеет сохранённых учётных данных.\nОткройте редактирование (✏) и добавьте логин и пароль.`);
    return;
  }
  if(!confirm(`Перезагрузить "${dev.name}" (${dev.ip})?\n\nУстройство будет недоступно ~30-120 секунд.`)) return;
  const btn=document.getElementById('reboot_'+id);
  if(btn){btn.textContent='⟳...';btn.classList.add('rebooting');btn.disabled=true;}
  try{
    const r=await fetch('/api/reboot/'+id,{method:'POST'});
    const d=await r.json();
    if(btn){btn.textContent='⟳ Reboot';btn.classList.remove('rebooting');btn.disabled=false;}
    if(d.ok){
      alert(`✅ ${dev.name}\n\nМетод: ${d.method}\n${d.detail}\n\nУстройство перезагружается...`);
      // Mark as offline temporarily
      const dv=allDevices.find(x=>x.id===id);
      if(dv) dv.online=false;
      render();
    } else {
      alert(`❌ Ошибка перезагрузки\n\nМетод: ${d.method}\n${d.detail}`);
    }
  } catch(e){
    if(btn){btn.textContent='⟳ Reboot';btn.classList.remove('rebooting');btn.disabled=false;}
    alert('Ошибка сети: '+e);
  }
}

function togglePwd(){
  const inp=document.getElementById('mPassword');
  const btn=document.getElementById('eyeBtn');
  if(inp.type==='password'){inp.type='text';btn.textContent='🙈';}
  else{inp.type='password';btn.textContent='👁';}
}

async function delDevice(id){
  if(!confirm('Удалить устройство?'))return;
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

  // ── Незарег. хосты ────────────────────────────────────────────────────────
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
            onclick="openAddModal('${ip}');toggleAutoscanDropdown()">+ В базу</button>
        </div>`).join('');
    }
  }

  // ── Новые подсети ─────────────────────────────────────────────────────────
  const snEl = document.getElementById('autoSnList');
  if(snEl){
    if(sn.running){
      snEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">⟳ сканирование...</div>';
    } else if(!sn.last_run){
      snEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">~3м после старта</div>';
    } else if(!sn.new_count){
      snEl.innerHTML = '<div style="font-size:11px;color:var(--green)">✅ нет новых</div>';
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
const EV_LABELS={down:'Недоступен',up:'Онлайн',power_off:'Свет отключён',power_on:'Свет восстановлен',
                 reboot:'Перезагрузка',new_host:'Новый хост',down_alert:'Долго недоступен'};

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
  sel.innerHTML='<option value="">— выберите устройство —</option>'+
    allDevices.map(d=>{
      const status=d.online===true?'🟢':d.online===false?'🔴':'⚪';
      return `<option value="${d.ip}">${status} ${d.name} (${d.ip})</option>`;
    }).join('');
  if(cur) sel.value=cur;
}

async function testEvent(kind){
  const ip=document.getElementById('evTestIp').value;
  const st=document.getElementById('evTestStatus');
  if(!ip){st.textContent='⚠️ Выберите устройство';return;}
  st.textContent='⟳ Отправка...';
  try{
    const r=await fetch('/api/test/event',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ip, kind})
    });
    const d=await r.json();
    if(d.ok){
      st.style.color='var(--green)';
      st.textContent=`✅ Событие "${kind}" для ${ip} создано`;
      setTimeout(()=>fetchEvents(), 500);  // refresh list
    } else {
      st.style.color='var(--red)';
      st.textContent='❌ '+(d.error||'Ошибка');
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
  cntEl.textContent=evs.length+' событий';
  if(!evs.length){el.innerHTML='<div class="ev-empty">Нет событий</div>';return;}
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
  if(!confirm('Очистить весь журнал событий?'))return;
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
      <label class="tg-toggle" style="margin:0" title="${r.active?'Активен':'Выключен'}">
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
    alert(d.error||'Ошибка добавления');
  }
}

async function deleteRecipient(chat_id){
  if(!confirm('Удалить получателя '+chat_id+'?'))return;
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
  alert(d.status==='sent'?'✅ Сообщение отправлено в '+chat_id:'❌ Ошибка отправки');
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
  if(d.status==='saved'){st.className='tg-status tg-ok';st.textContent='✅ Сохранено';}
  else{st.className='tg-status tg-err';st.textContent='❌ Ошибка';}
  setTimeout(()=>st.textContent='',3000);
}

function savePowerIp(){
  const v=document.getElementById('powerIpInp').value.trim();
  if(v){ window.POWER_IP=v; alert('IP обновлён до '+v+'\n(Действует до перезагрузки страницы)'); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function changeAuth(){
  const u=document.getElementById('newUsername').value.trim();
  const p=document.getElementById('newPassword').value;
  const p2=document.getElementById('newPassword2').value;
  const st=document.getElementById('authStatus');
  if(!u||!p){st.className='tg-status tg-err';st.textContent='❌ Заполните все поля';setTimeout(()=>st.textContent='',3000);return;}
  if(p!==p2){st.className='tg-status tg-err';st.textContent='❌ Пароли не совпадают';setTimeout(()=>st.textContent='',3000);return;}
  const r=await fetch('/api/auth/change',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u,password:p})});
  const d=await r.json();
  if(d.ok){
    st.className='tg-status tg-ok';st.textContent='✅ Данные обновлены';
    document.getElementById('newUsername').value='';
    document.getElementById('newPassword').value='';
    document.getElementById('newPassword2').value='';
  }else{st.className='tg-status tg-err';st.textContent='❌ '+(d.error||'Ошибка');}
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
  setInterval(fetchDevices,15000);
  setInterval(fetchAutoScan,10000);
  setInterval(refreshAllHistory,60000);  // refresh sparklines every 60s
  setInterval(()=>{ if(document.getElementById('tab-dashboard').classList.contains('active')) loadDashboard(); }, 120000);
  setInterval(fetchEvents,10000);        // refresh events every 10s
})();
// ══════════════════════════════════════════════════════════════════════════════
// TRACEROUTE
// ══════════════════════════════════════════════════════════════════════════════

function initTraceDevSelect() {
  const sel = document.getElementById('traceDevSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">— из базы —</option>' +
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
  btn.disabled = true; btn.textContent = '⟳ Выполняется...';

  try {
    const r = await fetch('/api/traceroute/' + encodeURIComponent(ip));
    const data = await r.json();
    document.getElementById('traceProgress').style.display = 'none';
    btn.disabled = false; btn.textContent = '▶ Запустить';

    if (data.error && (!data.hops || !data.hops.length)) {
      document.getElementById('traceError').style.display = 'block';
      document.getElementById('traceError').textContent = '❌ Ошибка: ' + data.error;
      return;
    }
    renderTraceroute(data);
  } catch (e) {
    document.getElementById('traceProgress').style.display = 'none';
    btn.disabled = false; btn.textContent = '▶ Запустить';
    document.getElementById('traceError').style.display = 'block';
    document.getElementById('traceError').textContent = '❌ Ошибка сети: ' + e;
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
    `${hops.length} хопов · ${reachable.length} ответили · ${timeouts} таймаутов`;

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
      const nameStr = h.name || h.model || (isFirst ? 'NetWatch сервер' : isLast ? 'Цель' : '');
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
        font-size="9" fill="${col}80" font-family="JetBrains Mono,monospace">▶ ЦЕЛЬ</text>`;
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
        <span>#</span><span>IP</span><span>Название / Модель</span>
        <span>Вендор</span><span>Задержка</span><span>График</span>
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
        ${d.online === true ? 'Онлайн' : d.online === false ? 'Оффлайн' : 'Неизвестно'}</span><br>
      ${d.latency != null ? `Пинг: <span style="color:${latCol};font-weight:700">${d.latency} мс</span><br>` : ''}
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
// GROUP SELECTION & ACTIONS
// ══════════════════════════════════════════════════════════════════════════════

function toggleSelect(id, checked){
  if(checked) selectedIds.add(id);
  else selectedIds.delete(id);
  updateGroupBar();
  // update subnet checkbox state without full re-render
  const dev=allDevices.find(d=>d.id===id);
  if(dev){
    const p=pfx(dev.ip);
    const inSubnet=allDevices.filter(d=>pfx(d.ip)===p);
    const allSel=inSubnet.every(d=>selectedIds.has(d.id));
    const chk=document.getElementById('chkAll_'+p.replace(/\./g,'_'));
    if(chk) chk.checked=allSel;
  }
}

function toggleSelectSubnet(prefix, checked){
  allDevices.filter(d=>pfx(d.ip)===prefix).forEach(d=>{
    if(checked) selectedIds.add(d.id);
    else selectedIds.delete(d.id);
  });
  render();
}

function clearSelection(){
  selectedIds.clear();
  render();
}

function updateGroupBar(){
  const bar=document.getElementById('groupBar');
  const cnt=selectedIds.size;
  bar.style.display=cnt>0?'flex':'none';
  document.getElementById('groupBarCount').textContent=
    cnt+' '+_plural(cnt,'устройство','устройства','устройств')+' выбрано';
}

function _plural(n, a, b, c){
  const m=n%100;
  if(m>=11&&m<=14) return c;
  const r=n%10;
  if(r===1) return a;
  if(r>=2&&r<=4) return b;
  return c;
}

async function groupPing(){
  const ids=[...selectedIds];
  if(!ids.length) return;
  const prog=document.getElementById('groupProgress');
  prog.style.display='block';
  let done=0;
  prog.textContent=`Пинг 0/${ids.length}...`;
  // Run pings in parallel batches of 10
  const BATCH=10;
  for(let i=0;i<ids.length;i+=BATCH){
    const batch=ids.slice(i,i+BATCH);
    await Promise.all(batch.map(async id=>{
      const dev=allDevices.find(d=>d.id===id);
      if(!dev) return;
      try{
        const r=await fetch('/api/ping/'+dev.ip);
        const data=await r.json();
        dev.online=data.alive;
        dev.latency=data.latency;
        _pushPingHist(dev.ip, data.alive, data.latency);
        _updatePingCell(id, data);
        _updateRowStatus(id, data.alive);
      }catch(e){}
      done++;
      prog.textContent=`Пинг ${done}/${ids.length}...`;
    }));
  }
  prog.textContent=`✅ Готово — ${done} устройств`;
  // Light stats update without full DOM rebuild
  _updateStats();
  setTimeout(()=>{prog.style.display='none';},3000);
}

async function groupReboot(){
  const ids=[...selectedIds];
  if(!ids.length) return;
  const withCreds=ids.filter(id=>{const d=allDevices.find(x=>x.id===id);return d&&d.has_creds;});
  const noCreds=ids.length-withCreds.length;
  let msg=`Перезагрузить ${withCreds.length} устройств?`;
  if(noCreds) msg+=`\n⚠️ ${noCreds} устройств без учётных данных — будут пропущены.`;
  if(!confirm(msg)) return;
  const prog=document.getElementById('groupProgress');
  prog.style.display='block';
  let ok=0, fail=0;
  for(const id of withCreds){
    const dev=allDevices.find(d=>d.id===id);
    if(!dev) continue;
    prog.textContent=`Reboot ${dev.name||dev.ip}...`;
    try{
      const r=await fetch('/api/reboot/'+id,{method:'POST'});
      const d=await r.json();
      if(d.ok){ok++;dev.online=false;}
      else fail++;
    }catch(e){fail++;}
  }
  prog.textContent=`✅ ${ok} перезагружено${fail?`, ❌ ${fail} ошибок`:''}`;
  render();
  setTimeout(()=>{prog.style.display='none';},5000);
}

// ══════════════════════════════════════════════════════════════════════════════
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
      `<div style="color:var(--red);font-size:12px;padding:12px">❌ Ошибка: ${e}</div>`;
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
        ⚠️ ${d.error || 'Устройство не ответило на SNMP'}
      </div>
      <div style="font-size:11px;color:var(--muted);line-height:2">
        <b>На MikroTik включить SNMP:</b><br>
        IP → SNMP → Enable = yes, Community = public<br>
        или: <code>/snmp set enabled=yes</code><br><br>
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
    <div id="snmpTrafficStatus" style="font-size:10px;color:var(--muted)">⟳ live трафик включён</div>
  </div>`;

  // ── Interface table ───────────────────────────────────────────────────────
  if (d.interfaces.length) {
    html += `
    <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">
      Интерфейсы (${d.interfaces.length})
      <span style="font-size:9px;color:var(--acc);margin-left:6px">• живой трафик обновляется каждые 4с</span>
    </div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
          <th style="padding:4px 6px;text-align:left;font-weight:500;white-space:nowrap">Интерфейс</th>
          <th style="padding:4px 6px;text-align:center;font-weight:500">Статус</th>
          <th style="padding:4px 6px;text-align:right;font-weight:500">Скорость</th>
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
    html += `<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px">Интерфейсы не обнаружены</div>`;
  }

  html += `
  <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;align-items:center">
    <span style="font-size:10px;color:var(--muted)">${d.is_mikrotik ? '⬡ MikroTik RouterOS' : ''}</span>
    <button class="btn btn-ghost" style="font-size:11px" onclick="openSnmpModal('${ip}',document.getElementById('snmpModalTitle').textContent.replace('📊 ','').split('(')[0].trim())">↻ Полный ресcan</button>
    <button class="btn btn-cancel" style="font-size:11px" onclick="closeSnmpModal()">Закрыть</button>
  </div>`;

  body.innerHTML = html;
}



// ══════════════════════════════════════════════════════════════════════════════
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
              label: ctx => ctx.parsed.y === 0 ? 'Всё ок' : `${ctx.parsed.y} падений`
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
    p.fillText('Нет данных — подождите первого авто-пинга', latCtx.width/2, 70);
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

    if (note) note.textContent = `${withData.length} устройств с данными за 24ч`;

    ul.innerHTML = [...withData, ...noData].map(dev => {
      if (dev.uptime_pct == null) {
        return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;opacity:.4">
          <div style="font-size:11px;width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'JetBrains Mono',monospace">${dev.name}</div>
          <div style="flex:1;height:14px;background:var(--sf2);border-radius:3px"></div>
          <div style="font-size:10px;color:var(--muted);width:45px;text-align:right">нет данных</div>
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
    sel.innerHTML = '<option value="">— выберите устройство —</option>' +
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
          label: 'Пинг (мс)',
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
          label: 'Оффлайн',
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
              if (ctx.datasetIndex === 1) return ctx.raw != null ? '🔴 Оффлайн' : null;
              return ctx.raw != null ? `${ctx.raw} мс` : '🔴 Оффлайн';
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
      dev.avg_ms != null ? `<span>Средний: <b style="color:var(--cyan)">${dev.avg_ms} мс</b></span>` : '',
      dev.min_ms != null ? `<span>Мин: <b style="color:var(--green)">${dev.min_ms} мс</b></span>` : '',
      dev.max_ms != null ? `<span>Макс: <b style="color:var(--red)">${dev.max_ms} мс</b></span>` : '',
      `<span>Точек: <b>${pts.length}</b></span>`,
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
  st.textContent = res.ok ? '✅ Сохранено' : '❌ Ошибка';
  setTimeout(()=>st.textContent='', 3000);
}
async function testDiscord() {
  const st = document.getElementById('discordTestStatus');
  st.textContent = '⟳ Отправка...';
  const r = await fetch('/api/discord/test', {method:'POST'});
  const d = await r.json();
  st.textContent = d.ok ? '✅ Отправлено!' : '❌ Ошибка';
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
  st.textContent = res.ok ? '✅ Сохранено' : '❌ Ошибка';
  setTimeout(()=>st.textContent='', 3000);
}
async function testEmail() {
  const st = document.getElementById('emailTestStatus');
  st.textContent = '⟳ Отправка...';
  const r = await fetch('/api/email/test', {method:'POST'});
  const d = await r.json();
  st.textContent = d.ok ? '✅ Отправлено!' : '❌ Ошибка (проверьте консоль сервера)';
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
  st.textContent = res.ok ? '✅ Сохранено' : '❌ Ошибка';
  setTimeout(()=>st.textContent='', 3000);
}
async function testWebhook() {
  const st = document.getElementById('webhookTestStatus');
  st.textContent = '⟳ Отправка...';
  const r = await fetch('/api/webhook/test', {method:'POST'});
  const d = await r.json();
  st.textContent = d.ok ? '✅ Отправлено!' : '❌ Ошибка';
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
  // type: 'down' = тревожный нисходящий, 'up' = мягкий восходящий
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
  st.textContent = '⟳ Создаём...';
  try {
    const r = await fetch('/api/backup', {method:'POST'});
    const d = await r.json();
    st.textContent = d.ok ? '✅ Создан: ' + (d.path || '').split('/').pop() : '❌ Ошибка';
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
      el.innerHTML = '<div style="color:var(--muted);font-size:11px">Резервных копий нет</div>';
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
      el.innerHTML = '<div style="color:var(--muted)">Записей нет</div>';
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
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 2FA TOTP management
// ══════════════════════════════════════════════════════════════════════════════

async function load2FAStatus() {
  try {
    const r = await fetch('/api/2fa/status');
    const d = await r.json();
    const enabled = d.enabled;
    document.getElementById('fa2StatusBadge').textContent = enabled ? '🟢 Включена' : '🔴 Отключена';
    document.getElementById('fa2StatusBadge').style.color = enabled ? 'var(--green)' : 'var(--red)';
    document.getElementById('fa2Disabled').style.display = enabled ? 'none' : 'block';
    document.getElementById('fa2Enabled').style.display  = enabled ? 'block' : 'none';
    document.getElementById('fa2Setup').style.display    = 'none';
  } catch(e) {}
}

async function fa2StartSetup() {
  const r = await fetch('/api/2fa/setup', {method: 'POST'});
  const d = await r.json();
  if (!d.secret) return;
  document.getElementById('fa2SecretDisplay').textContent = d.secret;
  document.getElementById('fa2Disabled').style.display = 'none';
  document.getElementById('fa2Setup').style.display    = 'block';
  document.getElementById('fa2ConfirmCode').value = '';
  document.getElementById('fa2SetupStatus').textContent = '';
  // Draw QR code on canvas
  _drawQR(d.uri, document.getElementById('fa2QrCanvas'));
  document.getElementById('fa2ConfirmCode').focus();
}

async function fa2Confirm() {
  const code = document.getElementById('fa2ConfirmCode').value.trim();
  const st   = document.getElementById('fa2SetupStatus');
  if (code.length !== 6) { st.textContent = 'Введите 6-значный код'; st.style.color = 'var(--red)'; return; }
  st.textContent = '⟳ Проверяем...'; st.style.color = 'var(--muted)';
  const r = await fetch('/api/2fa/confirm', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code})
  });
  const d = await r.json();
  if (d.ok) {
    st.style.color = 'var(--green)';
    st.textContent = '✅ 2FA успешно включена!';
    setTimeout(() => load2FAStatus(), 1500);
  } else {
    st.style.color = 'var(--red)';
    st.textContent = '❌ ' + (d.error || 'Неверный код');
    document.getElementById('fa2ConfirmCode').value = '';
    document.getElementById('fa2ConfirmCode').focus();
  }
}

function fa2CancelSetup() {
  document.getElementById('fa2Setup').style.display    = 'none';
  document.getElementById('fa2Disabled').style.display = 'block';
}

async function fa2Disable() {
  const code = document.getElementById('fa2DisableCode').value.trim();
  const st   = document.getElementById('fa2DisableStatus');
  st.textContent = '⟳ Проверяем...'; st.style.color = 'var(--muted)';
  const r = await fetch('/api/2fa/disable', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code})
  });
  const d = await r.json();
  if (d.ok) {
    st.style.color = 'var(--green)';
    st.textContent = '✅ 2FA отключена';
    setTimeout(() => load2FAStatus(), 1200);
  } else {
    st.style.color = 'var(--red)';
    st.textContent = '❌ ' + (d.error || 'Ошибка');
    document.getElementById('fa2DisableCode').value = '';
  }
}

// 2FA status loaded in _loadSettingsAll below

// ── QR code renderer (pure Canvas, no libs) ──────────────────────────────────
// Minimal QR encoder for otpauth:// URIs using a CDN-free approach:
// We render the URI as a data matrix via the open qr-code-styling approach.
// Since we can't use external libs, we use a simple workaround:
// Render the URI as a Google Charts API URL (works offline via canvas img)
// OR use the goqr.me service as fallback img.
function _drawQR(uri, canvas) {
  const ctx  = canvas.getContext('2d');
  const size = canvas.width;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Use a public QR API (internet required) via img element
  const img = new Image();
  const encoded = encodeURIComponent(uri);
  // Try Google Charts API (still works for QR generation)
  img.src = `https://chart.googleapis.com/chart?cht=qr&chs=${size}x${size}&chl=${encoded}&choe=UTF-8`;
  img.onload = () => {
    ctx.drawImage(img, 0, 0, size, size);
  };
  img.onerror = () => {
    // Fallback: show text if QR API unavailable
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#4a5568';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('QR недоступен.', size/2, size/2 - 10);
    ctx.fillText('Введите секрет вручную.', size/2, size/2 + 10);
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SLA TAB
// ══════════════════════════════════════════════════════════════════════════════

let _slaData     = [];
let _slaPeriod   = '7d';
let _slaSortKey  = 'uptime';
let _slaSortAsc  = true;
let _slaCharts   = {};

async function loadSLA() {
  document.getElementById('slaTableBody').innerHTML =
    '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted)">⟳ Загрузка...</td></tr>';
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
  if(note) note.textContent = `${items.length} устройств · период: ${_slaPeriod}`;
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
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">Нет данных</td></tr>';
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
  sel.innerHTML = '<option value="">— выберите устройство —</option>' +
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
          label: ctx => ctx.parsed.y != null ? ctx.parsed.y+'% uptime' : 'нет данных'
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