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
  if(name==='events') fetchEvents();
  if(name==='settings') loadTg();
}

// ── Auto-ping countdown ───────────────────────────────────────────────────────
function startAutoCountdown(){
  autoCountdown=60;
  if(autoTimer) clearInterval(autoTimer);
  autoTimer=setInterval(()=>{
    autoCountdown--;
    document.getElementById('autoBadge').textContent=`⏱ авто-пинг ${autoCountdown}с`;
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

function renderAutoScan(d){
  const disc=d.discovery, sn=d.subnet;
  const panel=document.getElementById('autoscanPanel');

  // Timers
  const discPulse=document.getElementById('discPulse');
  const discLbl=document.getElementById('discTimerLbl');
  if(disc.running){
    discPulse.classList.remove('idle');
    discLbl.textContent='Хосты: сканирование...';
  } else if(disc.last_run){
    discPulse.classList.add('idle');
    const el=Math.round(Date.now()/1000-disc.last_run);
    discLbl.textContent='Хосты: '+fmtAgo(disc.last_run)+' · след. '+fmtCountdown(300,el);
  } else {
    discPulse.classList.add('idle');
    discLbl.textContent='Хосты: ожидание запуска...';
  }

  const snPulse=document.getElementById('snPulse');
  const snLbl=document.getElementById('snTimerLbl');
  if(sn.running){
    snPulse.classList.remove('idle');
    snLbl.textContent='Подсети: сканирование...';
  } else if(sn.last_run){
    snPulse.classList.add('idle');
    const el=Math.round(Date.now()/1000-sn.last_run);
    snLbl.textContent='Подсети: '+fmtAgo(sn.last_run)+' · след. '+fmtCountdown(900,el);
  } else {
    snPulse.classList.add('idle');
    snLbl.textContent='Подсети: ожидание запуска...';
  }

  panel.classList.toggle('has-new',(disc.new_count>0)||(sn.new_count>0));

  // Unregistered hosts
  const discEl=document.getElementById('autoDiscList');
  if(disc.running){
    discEl.innerHTML='<div class="autoscan-empty">⟳ Сканирование...</div>';
  } else if(!disc.last_run){
    discEl.innerHTML='<div class="autoscan-empty">Ожидание первого скана (~90с после старта)</div>';
  } else if(disc.new_count===0){
    discEl.innerHTML='<div class="autoscan-empty" style="color:var(--green)">✅ Все хосты зарегистрированы</div>';
  } else {
    discEl.innerHTML=disc.new_devices.map(ip=>`
      <div class="autoscan-ip">
        <div class="dot" style="background:var(--yel);box-shadow:0 0 6px var(--yel);width:8px;height:8px;border-radius:50%;flex-shrink:0"></div>
        <span class="ip-txt">${ip}</span>
        <span class="sn-txt">${ip.split('.').slice(0,3).join('.')}.0/24</span>
        <button class="btn btn-yel" style="padding:2px 8px;font-size:10px" onclick="openAddModal('${ip}')">+ Добавить</button>
      </div>`).join('');
  }

  // New subnets
  const snEl=document.getElementById('autoSnList');
  if(sn.running){
    snEl.innerHTML='<div class="autoscan-empty">⟳ Сканирование...</div>';
  } else if(!sn.last_run){
    snEl.innerHTML='<div class="autoscan-empty">Ожидание первого скана (~3м после старта)</div>';
  } else if(sn.new_count===0){
    snEl.innerHTML='<div class="autoscan-empty" style="color:var(--green)">✅ Новых подсетей не найдено</div>';
  } else {
    snEl.innerHTML=sn.new_subnets.map(x=>`
      <div class="autoscan-ip">
        <div style="background:var(--pur);box-shadow:0 0 6px var(--pur);width:8px;height:8px;border-radius:50%;flex-shrink:0"></div>
        <span class="ip-txt">192.168.${x}.0/24</span>
        <span class="sn-txt">шлюз .${x}.1</span>
        <button class="btn btn-yel" style="padding:2px 8px;font-size:10px" onclick="addAutoSubnet(${x})">+ Реестр</button>
      </div>`).join('');
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
  }catch(e){}
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
  setInterval(fetchEvents,30000);        // refresh events every 30s
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

// ── Patch switchTab to handle new tabs ───────────────────────────────────────
{
  const _orig = switchTab;
  window.switchTab = function(name, el) {
    _orig(name, el);
    if (name === 'topology') loadTopology();
    if (name === 'traceroute') initTraceDevSelect();
  };
}

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

async function openSnmpModal(ip, name){
  const modal=document.getElementById('snmpModal');
  document.getElementById('snmpModalTitle').textContent=`📊 SNMP — ${name} (${ip})`;
  document.getElementById('snmpModalBody').innerHTML=
    '<div style="text-align:center;padding:30px;color:var(--muted);font-size:12px">⟳ Опрос SNMP...</div>';
  modal.classList.add('open');

  try{
    const r=await fetch('/api/snmp/'+encodeURIComponent(ip));
    const d=await r.json();
    renderSnmpModal(d, ip);
  }catch(e){
    document.getElementById('snmpModalBody').innerHTML=
      `<div style="color:var(--red);font-size:12px;padding:12px">❌ Ошибка: ${e}</div>`;
  }
}

function closeSnmpModal(){
  document.getElementById('snmpModal').classList.remove('open');
}

function renderSnmpModal(d, ip){
  const body=document.getElementById('snmpModalBody');
  if(!d.ok){
    body.innerHTML=`
      <div style="padding:12px;background:var(--rd);border:1px solid #ff3d5740;border-radius:8px;color:var(--red);font-size:12px;margin-bottom:12px">
        ⚠️ ${d.error||'Устройство не ответило на SNMP'}
      </div>
      <div class="hint" style="font-size:10px;line-height:1.9">
        <b>Возможные причины:</b><br>
        • SNMP не включён на устройстве<br>
        • Community строка не совпадает (по умолчанию <code>public</code>)<br>
        • Firewall блокирует UDP/161<br><br>
        <b>MikroTik:</b> IP → SNMP → включить, community = public<br>
        <b>Cisco:</b> <code>snmp-server community public RO</code><br>
        <b>Linux:</b> <code>apt install snmpd</code>
      </div>`;
    return;
  }

  // Uptime / sysname
  let html=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">`;
  const cards=[
    ['🕐 Uptime', d.uptime_str||'—'],
    ['🖥 Имя',    d.sysname||'—'],
  ];
  if(d.cpu_pct!=null) cards.push(['⚙️ CPU', `${d.cpu_pct}%`]);
  if(d.mem_total_kb!=null){
    const mb=Math.round(d.mem_total_kb/1024);
    cards.push(['💾 RAM (total)', `${mb} МБ`]);
  }
  cards.forEach(([lbl,val])=>{
    html+=`<div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px">${lbl}</div>
      <div style="font-size:14px;font-weight:700;color:var(--text)">${val}</div>
    </div>`;
  });
  html+=`</div>`;

  // CPU bar
  if(d.cpu_pct!=null){
    const col=d.cpu_pct<50?'var(--green)':d.cpu_pct<80?'var(--yel)':'var(--red)';
    html+=`<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:4px">
        <span>Загрузка CPU</span><span style="color:${col};font-weight:700">${d.cpu_pct}%</span>
      </div>
      <div style="background:var(--bd);border-radius:4px;height:8px;overflow:hidden">
        <div style="height:100%;border-radius:4px;background:${col};width:${d.cpu_pct}%;transition:width .5s"></div>
      </div>
    </div>`;
  }

  // sysDescr
  if(d.sysdescr){
    html+=`<div style="margin-bottom:14px;padding:9px 12px;background:var(--sf2);border:1px solid var(--bd);border-radius:8px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">sysDescr</div>
      <div style="font-size:10px;color:var(--text);line-height:1.6;word-break:break-all">${d.sysdescr.slice(0,300)}</div>
    </div>`;
  }

  // Interfaces
  if(d.interfaces && d.interfaces.length){
    html+=`<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:7px">Интерфейсы</div>`;
    html+=`<div style="display:flex;flex-direction:column;gap:4px">`;
    d.interfaces.forEach(iface=>{
      const up=iface.status==='up';
      const inMb=iface.in_octets!=null?(iface.in_octets/1048576).toFixed(1):'—';
      const outMb=iface.out_octets!=null?(iface.out_octets/1048576).toFixed(1):'—';
      const speedStr=iface.speed_bps?_fmtSpeed(iface.speed_bps):'';
      html+=`<div style="display:grid;grid-template-columns:8px 1fr auto auto auto;align-items:center;gap:8px;
                         background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:7px 10px">
        <div style="width:8px;height:8px;border-radius:50%;background:${up?'var(--green)':'var(--red)'};box-shadow:0 0 5px ${up?'var(--green)':'var(--red)'}"></div>
        <span style="font-size:11px;font-weight:600">${iface.name}</span>
        <span style="font-size:10px;color:var(--muted)">${speedStr}</span>
        <span style="font-size:10px;color:var(--cyan)">↓ ${inMb} МБ</span>
        <span style="font-size:10px;color:var(--green)">↑ ${outMb} МБ</span>
      </div>`;
    });
    html+=`</div>`;
  }

  // Refresh button
  html+=`<div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
    <button class="btn btn-ghost" style="font-size:11px" onclick="openSnmpModal('${ip}',document.getElementById('snmpModalTitle').textContent.split('—')[1]?.trim()||'')">↻ Обновить</button>
    <button class="btn btn-cancel" style="font-size:11px" onclick="closeSnmpModal()">Закрыть</button>
  </div>`;

  body.innerHTML=html;
}

function _fmtSpeed(bps){
  if(bps>=1e9) return (bps/1e9).toFixed(1)+' Гбит/с';
  if(bps>=1e6) return (bps/1e6).toFixed(0)+' Мбит/с';
  if(bps>=1e3) return (bps/1e3).toFixed(0)+' Кбит/с';
  return bps+' б/с';
}