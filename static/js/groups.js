// NetWatch — Group selection & bulk actions

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
    cnt+' '+_plural(cnt,'пристрій','пристроїва','пристроїв')+' вибрано';
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
  prog.textContent=`Пінг 0/${ids.length}...`;
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
      prog.textContent=`Пінг ${done}/${ids.length}...`;
    }));
  }
  prog.textContent=`✅ Гвідово — ${done} пристроїв`;
  // Light stats update without full DOM rebuild
  _updateStats();
  setTimeout(()=>{prog.style.display='none';},3000);
}

async function groupReboot(){
  const ids=[...selectedIds];
  if(!ids.length) return;
  const withCreds=ids.filter(id=>{const d=allDevices.find(x=>x.id===id);return d&&d.has_creds;});
  const noCreds=ids.length-withCreds.length;
  let msg=`Перезавантажити ${withCreds.length} пристроїв?`;
  if(noCreds) msg+=`\n⚠️ ${noCreds} пристроїв без облікових даних — будуть пропущені.`;
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
  prog.textContent=`✅ ${ok} перезавантаженийо${fail?`, ❌ ${fail} ошибок`:''}`;
  render();
  setTimeout(()=>{prog.style.display='none';},5000);
}

// ══════════════════════════════════════════════════════════════════════════════
