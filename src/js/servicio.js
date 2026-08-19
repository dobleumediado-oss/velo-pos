'use strict';

// VELO TECH POS · Taller profesional
// Recepción → inspección → diagnóstico → presupuesto versionado → aprobación
// → reserva de piezas → reparación → control de calidad → entrega/garantía.

let svcOrders = [];
let svcTechnicians = [];
let svcStatus = '';
let svcSearch = '';

const SVC_LABEL = {
  recepcion:'Recepción', inspeccion:'Inspección', diagnostico:'Diagnóstico', presupuesto:'Presupuesto',
  esperando_aprobacion:'Esperando aprobación', aprobado:'Aprobado', esperando_pieza:'Esperando pieza',
  reparando:'Reparando', control_calidad:'Control de calidad', listo:'Listo', entregado:'Entregado',
  rechazado:'Rechazado', no_reparable:'No reparable', devuelto_sin_reparar:'Devuelto sin reparar', cancelado:'Cancelado',
};
const SVC_ACTIVE = new Set(['recepcion','inspeccion','diagnostico','presupuesto','esperando_aprobacion','aprobado','esperando_pieza','reparando','control_calidad','listo']);
const svcEsc = value => String(value == null ? '' : value)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const svcJson = (value, fallback) => { try { return JSON.parse(value || ''); } catch { return fallback; } };

function svcBadge(status) {
  const tone = status === 'entregado' ? 'g' : ['cancelado','rechazado','no_reparable'].includes(status) ? 'r'
    : status === 'listo' ? 'b' : ['aprobado','reparando','control_calidad'].includes(status) ? 'a' : 'n';
  return `<span class="badge ${tone}">${svcEsc(SVC_LABEL[status] || status)}</span>`;
}

async function renderServicio(el) {
  if (!window._vertical?.modules?.service_orders) {
    el.innerHTML = '<div class="empty"><p>Servicio técnico no está habilitado en este producto.</p></div>';
    return;
  }
  el.innerHTML = `
    <div class="sec-hdr">
      <div><div class="sec-title">Taller y reparaciones</div><div class="sec-sub">Recepción documentada, presupuesto aprobado, piezas reservadas, calidad y garantía</div></div>
      <div class="flex" style="gap:8px"><button class="btn btn-out" id="svc-report">${svg('chart')} Indicadores</button>
      ${['admin','superadmin'].includes(user?.role)?`<button class="btn btn-out" id="svc-techs">${svg('users')} Técnicos</button>`:''}
      <button class="btn btn-dark" id="svc-new">${svg('plus')} Recibir equipo</button></div>
    </div>
    <div class="metrics" id="svc-metrics" style="grid-template-columns:repeat(5,1fr);margin-bottom:18px"></div>
    <div class="flex" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <div class="inp-ic" style="flex:1;min-width:260px"><div class="ic">${svg('search')}</div>
        <input class="inp" id="svc-search" placeholder="Orden, cliente, equipo, IMEI, serial o técnico" value="${svcEsc(svcSearch)}">
      </div>
      <select class="inp" id="svc-status" style="width:210px"><option value="">Todos los estados</option>
        ${Object.entries(SVC_LABEL).map(([key,label])=>`<option value="${key}" ${svcStatus===key?'selected':''}>${label}</option>`).join('')}
      </select>
    </div><div id="svc-list"><div class="empty"><p>Cargando órdenes…</p></div></div>`;
  document.getElementById('svc-new').onclick = svcOpenNew;
  document.getElementById('svc-report').onclick = svcOpenReport;
  document.getElementById('svc-techs')?.addEventListener('click', svcOpenTechnicians);
  let timer;
  document.getElementById('svc-search').oninput = event => { svcSearch=event.target.value; clearTimeout(timer); timer=setTimeout(svcLoad,180); };
  document.getElementById('svc-status').onchange = event => { svcStatus=event.target.value; svcLoad(); };
  await svcLoadTechnicians();
  await svcLoad();
}

async function svcLoadTechnicians() {
  const res = await window.api.serviceOrders.technicians({requestUserId:user?.id});
  svcTechnicians = res?.ok ? (res.data || []) : [];
}

async function svcLoad() {
  const list=document.getElementById('svc-list'); if(!list)return;
  const res=await window.api.serviceOrders.list({status:svcStatus,search:svcSearch,requestUserId:user?.id});
  if(!res?.ok){list.innerHTML=`<div class="alrt r"><div class="alrt-dot r"></div><div>${svcEsc(res?.error||'No se pudieron cargar las órdenes')}</div></div>`;return;}
  svcOrders=res.data||[];
  const count = status => svcOrders.filter(order => status.includes(order.workflow_status)).length;
  const metrics=document.getElementById('svc-metrics');
  if(metrics)metrics.innerHTML=[
    ['settings','b','Abiertas',svcOrders.filter(o=>SVC_ACTIVE.has(o.workflow_status)).length],
    ['search','n','Por diagnosticar',count(['recepcion','inspeccion','diagnostico'])],
    ['clock','a','Esperando',count(['esperando_aprobacion','esperando_pieza'])],
    ['pkg','a','En taller',count(['aprobado','reparando','control_calidad'])],
    ['check','g','Listas',count(['listo'])],
  ].map(([icon,tone,label,value])=>`<div class="metric"><div class="met-top"><div class="met-icon ${tone}">${svg(icon)}</div></div><div class="met-label">${label}</div><div class="met-val">${value}</div></div>`).join('');
  if(!svcOrders.length){list.innerHTML=`<div class="empty"><div>${svg('settings')}</div><p>Sin órdenes en esta vista</p><span>Recibe un equipo para comenzar.</span></div>`;return;}
  list.innerHTML=`<div class="card"><div class="tw"><table><thead><tr><th>Orden</th><th>Cliente / equipo</th><th>Identificador</th><th>Problema</th><th>Técnico</th><th>Estado</th><th>Total</th><th></th></tr></thead><tbody>
    ${svcOrders.map(order=>`<tr><td><div class="tb">${svcEsc(order.number)}</div><div class="ts">${fdate(String(order.created_at||'').slice(0,10))}${Number(order.age_days)>0?` · ${order.age_days}d`:''}</div></td>
      <td><div class="tb">${svcEsc(order.customer_name)}</div><div class="ts">${svcEsc(order.device_desc)}</div></td>
      <td class="tm" style="font-size:11px">${svcEsc(order.imei||order.serial||order.imei2||'—')}</td>
      <td style="max-width:220px"><div class="ts">${svcEsc(order.problem)}</div></td><td class="ts">${svcEsc(order.technician_name||'Sin asignar')}</td>
      <td>${svcBadge(order.workflow_status)}</td><td class="tb">${fmt(order.items_total||order.quote_amount||0)}</td>
      <td><button class="btn btn-ghost btn-sm" data-svc-open="${order.id}">${svg('eye')} Abrir</button></td></tr>`).join('')}
  </tbody></table></div></div>`;
  list.querySelectorAll('[data-svc-open]').forEach(button=>button.onclick=()=>svcOpen(Number(button.dataset.svcOpen)));
}

function svcAccessoryChecks() {
  return ['Cargador','Cable','Funda','SIM / memoria','Batería removible','Control remoto','Otro']
    .map((label,index)=>`<label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" class="svc-accessory" value="${svcEsc(label)}"> ${svcEsc(label)}</label>`).join('');
}

function svcOpenNew() {
  const customers=(DB.customers||[]).filter(c=>c.active!==0);
  openModal(`<div class="modal-title">Recepción profesional de equipo</div><div class="modal-sub">Documenta el estado de entrada para proteger al cliente y al negocio.</div>
    <div class="g2" style="margin-top:14px"><div class="fg"><label class="lbl">Cliente *</label><select class="inp" id="svc-customer">${customers.map(c=>`<option value="${c.id}">${svcEsc(c.name)}</option>`).join('')}</select></div>
      <div class="fg"><label class="lbl">Tipo de servicio</label><select class="inp" id="svc-type"><option value="reparacion">Reparación</option><option value="diagnostico">Solo diagnóstico</option><option value="instalacion">Instalación / configuración</option><option value="visita">Visita técnica</option><option value="garantia">Garantía</option></select></div></div>
    <div class="g3"><div class="fg"><label class="lbl">Equipo *</label><input class="inp" id="svc-device" placeholder="Celular, laptop, TV, consola…"></div><div class="fg"><label class="lbl">Marca</label><input class="inp" id="svc-brand"></div><div class="fg"><label class="lbl">Modelo</label><input class="inp" id="svc-model"></div></div>
    <div class="g3"><div class="fg"><label class="lbl">IMEI 1</label><input class="inp" id="svc-imei" data-uppercase="off"></div><div class="fg"><label class="lbl">IMEI 2</label><input class="inp" id="svc-imei2" data-uppercase="off"></div><div class="fg"><label class="lbl">Serial</label><input class="inp" id="svc-serial" data-uppercase="off"></div></div>
    <div class="g3"><div class="fg"><label class="lbl">Color</label><input class="inp" id="svc-color"></div><div class="fg"><label class="lbl">Prioridad</label><select class="inp" id="svc-priority"><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente</option><option value="baja">Baja</option></select></div><div class="fg"><label class="lbl">Fecha prometida</label><input class="inp" type="datetime-local" id="svc-promised"></div></div>
    <div class="fg"><label class="lbl">Problema reportado *</label><textarea class="inp" id="svc-problem" rows="2" placeholder="Describe las palabras del cliente"></textarea></div>
    <div class="fg"><label class="lbl">Condición física de entrada *</label><textarea class="inp" id="svc-condition" rows="2" placeholder="Rayones, golpes, pantalla, humedad, piezas faltantes…"></textarea></div>
    <div class="fg"><label class="lbl">Accesorios recibidos</label><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:10px;border:1px solid var(--line);border-radius:8px">${svcAccessoryChecks()}</div></div>
    <div class="g2"><div class="fg"><label class="lbl">Prueba al encender</label><select class="inp" id="svc-power"><option value="no_probado">No probado</option><option value="funciona">Funciona</option><option value="falla">Falla</option></select></div><div class="fg"><label class="lbl">Prueba de carga/energía</label><select class="inp" id="svc-charge"><option value="no_probado">No probado</option><option value="funciona">Funciona</option><option value="falla">Falla</option></select></div></div>
    <div class="fg"><label class="lbl">Notas internas</label><textarea class="inp" id="svc-notes" rows="2"></textarea></div>
    <label style="display:flex;gap:9px;align-items:flex-start;padding:10px;background:var(--surface2);border-radius:8px"><input type="checkbox" id="svc-consent"><span style="font-size:12px"><strong>Consentimiento de diagnóstico y manejo del equipo</strong><br><span style="color:var(--muted2)">VELO no guarda PIN ni contraseñas aquí; el cliente desbloquea el equipo cuando sea necesario.</span></span></label>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-dark" id="svc-create">${svg('check')} Crear recepción</button></div>`, 'modal-xl');
  document.getElementById('svc-create').onclick=async event=>{
    const device=document.getElementById('svc-device').value.trim(),problem=document.getElementById('svc-problem').value.trim(),condition=document.getElementById('svc-condition').value.trim();
    if(!device||!problem||!condition){toast('Equipo, problema y condición física son obligatorios','w');return;}
    event.currentTarget.disabled=true;
    const accessories=[...document.querySelectorAll('.svc-accessory:checked')].map(input=>input.value);
    const res=await window.api.serviceOrders.create({requestUserId:user?.id,data:{
      customer_id:Number(document.getElementById('svc-customer').value),service_type:document.getElementById('svc-type').value,
      device_desc:device,brand:document.getElementById('svc-brand').value.trim(),model:document.getElementById('svc-model').value.trim(),
      imei:document.getElementById('svc-imei').value.trim(),imei2:document.getElementById('svc-imei2').value.trim(),serial:document.getElementById('svc-serial').value.trim(),
      device_color:document.getElementById('svc-color').value.trim(),priority:document.getElementById('svc-priority').value,promised_at:document.getElementById('svc-promised').value,
      problem,intake_condition:condition,accessories_received:accessories,intake_checklist:{power:document.getElementById('svc-power').value,charge:document.getElementById('svc-charge').value},
      privacy_consent:document.getElementById('svc-consent').checked,notes:document.getElementById('svc-notes').value.trim(),
    }});
    if(!res?.ok){toast(res?.error||'No se pudo recibir','err');event.currentTarget.disabled=false;return;}
    closeModal();toast(`✓ ${res.data.number} recibida`,'ok');await svcLoad();svcOpen(res.data.id);
  };
}

async function svcOpen(id) {
  const res=await window.api.serviceOrders.getById({id,requestUserId:user?.id});
  if(!res?.ok||!res.data){toast(res?.error||'Orden no encontrada','err');return;}
  svcRenderDetail(res.data);
}

function svcNext(order) {
  return {recepcion:'inspeccion',inspeccion:'diagnostico',diagnostico:'presupuesto',presupuesto:'esperando_aprobacion',aprobado:'reparando',reparando:'control_calidad'}[order.workflow_status]||'';
}

function svcTimeline(events) {
  if(!events?.length)return '<div class="ts">Aún no hay eventos.</div>';
  return `<div style="display:grid;gap:8px">${events.slice(0,15).map(event=>`<div style="display:grid;grid-template-columns:110px 1fr;gap:10px;border-left:2px solid var(--line);padding-left:10px"><div class="ts">${svcEsc(String(event.created_at||'').slice(0,16))}</div><div><div class="tb">${svcEsc(event.title)}</div><div class="ts">${svcEsc([event.user_name,event.detail].filter(Boolean).join(' · '))}</div></div></div>`).join('')}</div>`;
}

function svcRenderDetail(order) {
  let items=(order.items||[]).map(item=>({...item}));
  const editable=['recepcion','inspeccion','diagnostico','presupuesto'].includes(order.workflow_status);
  const products=(DB.products||[]).filter(p=>p.active!==0&&!p.serialized);
  const techOptions=`<option value="">Sin asignar</option>${svcTechnicians.map(t=>`<option value="${t.id}" ${Number(order.service_technician_id)===Number(t.id)?'selected':''}>${svcEsc(t.name)}${t.specialty?` · ${svcEsc(t.specialty)}`:''}</option>`).join('')}`;
  const itemRows=()=>items.length?items.map((item,index)=>`<tr><td>${item.kind==='parte'?'Pieza':'Mano de obra'}</td><td>${svcEsc(item.description)}</td><td>${item.qty}</td><td>${fmt(item.unit_price)}</td><td>${fmt(item.qty*item.unit_price)}</td><td>${item.kind==='parte'?`<span class="badge ${item.reservation_status==='reserved'?'g':item.reservation_status==='waiting'?'a':'n'}">${svcEsc(item.reservation_status||'none')}</span>`:'—'}</td>${editable?`<td><button class="btn btn-ghost btn-sm" data-svc-rm="${index}" style="color:var(--red)">${svg('trash')}</button></td>`:''}</tr>`).join(''):`<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:14px">Sin partidas</td></tr>`;
  const accessories=svcJson(order.accessories_received,[]);
  const next=svcNext(order);
  openModal(`<div style="display:flex;justify-content:space-between;gap:12px"><div><div class="modal-title">${svcEsc(order.number)}</div><div class="modal-sub">${svcEsc(order.customer_name)} · ${svcEsc(order.device_desc)} · ${svcEsc(order.imei||order.serial||'sin identificador')}</div></div>${svcBadge(order.workflow_status)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0"><div class="card" style="padding:12px"><div class="tb">Recepción</div><div class="ts" style="margin-top:5px">${svcEsc(order.intake_condition||'Sin condición documentada')}</div><div class="ts">Accesorios: ${svcEsc(accessories.join(', ')||'ninguno')}</div><div class="ts">Tipo: ${svcEsc(order.service_type)} · Prioridad: ${svcEsc(order.priority)}</div></div>
      <div class="card" style="padding:12px"><div class="tb">Trazabilidad</div><div class="ts" style="margin-top:5px">Catálogo: ${order.product_unit_id?`Unidad #${order.product_unit_id} · ${svcEsc(order.unit_status||'')}`:'Equipo externo/no enlazado'}</div><div class="ts">Prometido: ${svcEsc(order.promised_at||'Sin fecha')}</div><div class="ts">Garantía reparación: ${order.warranty_until?svcEsc(order.warranty_until):`${Number(order.service_warranty_days)||0} días`}</div></div></div>
    <div class="alrt"><div class="alrt-dot"></div><div><div class="alrt-title">Problema reportado</div><div class="alrt-sub">${svcEsc(order.problem)}</div></div></div>
    <div class="g2" style="margin-top:12px"><div class="fg"><label class="lbl">Diagnóstico</label><textarea class="inp" id="svc-diagnosis" rows="3" ${editable?'':'disabled'}>${svcEsc(order.diagnosis||'')}</textarea></div><div><div class="fg"><label class="lbl">Técnico responsable</label><select class="inp" id="svc-technician" ${editable?'':'disabled'}>${techOptions}</select></div><div class="fg"><label class="lbl">Notas</label><input class="inp" id="svc-detail-notes" value="${svcEsc(order.notes||'')}" ${editable?'':'disabled'}></div></div></div>
    ${editable?`<div style="font-weight:700;font-size:12px;margin:8px 0">Partidas del presupuesto</div><div style="display:grid;grid-template-columns:1.5fr .5fr .7fr auto;gap:7px;margin-bottom:7px"><select class="inp" id="svc-part-product"><option value="">Seleccionar pieza…</option>${products.map(p=>`<option value="${p.id}">${svcEsc(p.name)} · libre ${Math.max(0,Number(p.effective_stock??p.stock)-Number(p.reserved_stock||0))}</option>`).join('')}</select><input class="inp" id="svc-part-qty" type="number" min="1" value="1"><input class="inp" id="svc-part-price" type="number" min="0" placeholder="Precio"><button class="btn btn-out" id="svc-add-part">+ Pieza</button></div>
      <div style="display:grid;grid-template-columns:1.5fr .5fr .7fr auto;gap:7px;margin-bottom:10px"><input class="inp" id="svc-labor-desc" placeholder="Mano de obra / servicio"><input class="inp" id="svc-labor-qty" type="number" min="1" value="1"><input class="inp" id="svc-labor-price" type="number" min="0" placeholder="Precio"><button class="btn btn-out" id="svc-add-labor">+ Labor</button></div>`:''}
    <div class="tw" style="max-height:220px"><table><thead><tr><th>Tipo</th><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Total</th><th>Inventario</th><th></th></tr></thead><tbody id="svc-items-body">${itemRows()}</tbody></table></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0"><div><button class="btn btn-out btn-sm" id="svc-print">${svg('printer')} Documento</button> <button class="btn btn-out btn-sm" id="svc-whatsapp">WhatsApp</button></div><div class="tb">Total: <span id="svc-total">${fmt(items.reduce((s,i)=>s+Number(i.qty)*Number(i.unit_price),0))}</span></div></div>
    <details style="margin-top:10px"><summary class="tb" style="cursor:pointer">Historial y versiones</summary><div style="margin-top:10px">${svcTimeline(order.events)}</div>${order.estimates?.length?`<div class="ts" style="margin-top:10px">Presupuestos: ${order.estimates.map(e=>`v${e.version} ${e.status} (${fmt(e.amount)})`).join(' · ')}</div>`:''}</details>
    <div class="modal-foot" style="justify-content:space-between"><div>${SVC_ACTIVE.has(order.workflow_status)?`<button class="btn btn-ghost" id="svc-cancel" style="color:var(--red)">Cancelar orden</button>`:''}</div><div class="flex" style="gap:8px"><button class="btn btn-out" onclick="closeModal()">Cerrar</button>${editable?'<button class="btn btn-out" id="svc-save">Guardar</button>':''}${svcActionButton(order,next)}</div></div>`, 'modal-xl');

  const rerender=()=>{document.getElementById('svc-items-body').innerHTML=itemRows();document.querySelectorAll('[data-svc-rm]').forEach(button=>button.onclick=()=>{items.splice(Number(button.dataset.svcRm),1);rerender();});document.getElementById('svc-total').textContent=fmt(items.reduce((s,i)=>s+Number(i.qty)*Number(i.unit_price),0));};
  if(editable){
    document.getElementById('svc-add-part').onclick=()=>{const pid=Number(document.getElementById('svc-part-product').value),product=products.find(p=>Number(p.id)===pid);if(!product)return toast('Selecciona una pieza','w');items.push({kind:'parte',product_id:product.id,description:product.name,qty:Math.max(1,Number(document.getElementById('svc-part-qty').value)||1),unit_price:Math.max(0,Number(document.getElementById('svc-part-price').value)||Number(product.price)||0),taxable:product.taxable,tax_pct:product.tax_pct,reservation_status:'none'});rerender();};
    document.getElementById('svc-add-labor').onclick=()=>{const description=document.getElementById('svc-labor-desc').value.trim();if(!description)return toast('Describe la mano de obra','w');items.push({kind:'mano_obra',description,qty:Math.max(1,Number(document.getElementById('svc-labor-qty').value)||1),unit_price:Math.max(0,Number(document.getElementById('svc-labor-price').value)||0),taxable:1,tax_pct:Number(CFG.itbis)||18});rerender();};
  }
  const save=async()=>{if(!editable)return order;const res=await window.api.serviceOrders.update({id:order.id,requestUserId:user?.id,data:{diagnosis:document.getElementById('svc-diagnosis').value.trim(),notes:document.getElementById('svc-detail-notes').value.trim(),service_technician_id:Number(document.getElementById('svc-technician').value)||null,items}});if(!res?.ok){toast(res?.error||'No se pudo guardar','err');return null;}order=res.data;return order;};
  document.getElementById('svc-save')?.addEventListener('click',async()=>{const saved=await save();if(saved){toast('✓ Orden guardada','ok');svcRenderDetail(saved);await svcLoad();}});
  document.getElementById('svc-next')?.addEventListener('click',async()=>{const saved=await save();if(!saved)return;const res=await window.api.serviceOrders.advance({id:order.id,status:next,requestUserId:user?.id});if(!res?.ok)return toast(res?.error||'No se pudo avanzar','err');toast(`✓ ${SVC_LABEL[res.data.workflow_status]}`,'ok');await svcLoad();svcRenderDetail(res.data);});
  document.getElementById('svc-approve')?.addEventListener('click',()=>svcOpenDecision(order,true));
  document.getElementById('svc-reject')?.addEventListener('click',()=>svcOpenDecision(order,false));
  document.getElementById('svc-reopen')?.addEventListener('click',()=>svcReopen(order.id));
  document.getElementById('svc-retry')?.addEventListener('click',()=>svcRetryParts(order.id));
  document.getElementById('svc-qc')?.addEventListener('click',()=>svcOpenQuality(order));
  document.getElementById('svc-deliver')?.addEventListener('click',()=>svcOpenDelivery(order));
  document.getElementById('svc-warranty-return')?.addEventListener('click',()=>svcWarrantyReturn(order));
  document.getElementById('svc-cancel')?.addEventListener('click',async()=>{const reason=await askText('Indica el motivo. Las piezas reservadas serán liberadas.',{title:'Cancelar orden'});if(!reason)return;const res=await window.api.serviceOrders.cancel({id:order.id,reason,requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');toast('Orden cancelada','ok');closeModal();await svcLoad();});
  document.getElementById('svc-print').onclick=()=>svcPrintDocument(order);
  document.getElementById('svc-whatsapp').onclick=()=>svcShareStatus(order);
}

function svcActionButton(order,next) {
  if(next)return `<button class="btn btn-dark" id="svc-next">${order.workflow_status==='presupuesto'?'Enviar presupuesto':`Pasar a ${svcEsc(SVC_LABEL[next])}`}</button>`;
  if(order.workflow_status==='esperando_aprobacion')return '<button class="btn btn-out" id="svc-reject">Rechazar</button><button class="btn btn-dark" id="svc-approve">Registrar aprobación</button>';
  if(order.workflow_status==='rechazado')return '<button class="btn btn-dark" id="svc-reopen">Revisar presupuesto</button>';
  if(order.workflow_status==='esperando_pieza')return '<button class="btn btn-dark" id="svc-retry">Reintentar reserva</button>';
  if(order.workflow_status==='control_calidad')return '<button class="btn btn-dark" id="svc-qc">Realizar control de calidad</button>';
  if(order.workflow_status==='listo')return '<button class="btn btn-dark" id="svc-deliver">Entregar y facturar</button>';
  if(order.workflow_status==='entregado'&&order.warranty_until)return '<button class="btn btn-out" id="svc-warranty-return">Reingreso por garantía</button>';
  return '';
}

function svcOpenDecision(order,approved) {
  openModal(`<div class="modal-title">${approved?'Aprobar':'Rechazar'} presupuesto v${order.approval_version}</div><div class="modal-sub">Importe: ${fmt(order.quote_amount)}</div><div class="g2" style="margin-top:14px"><div class="fg"><label class="lbl">Canal *</label><select class="inp" id="svc-decision-method"><option value="presencial">Presencial</option><option value="whatsapp">WhatsApp</option><option value="llamada">Llamada</option><option value="correo">Correo</option><option value="firma">Firma</option></select></div><div class="fg"><label class="lbl">Persona que respondió *</label><input class="inp" id="svc-decision-name" value="${svcEsc(order.customer_name)}"></div></div><div class="fg"><label class="lbl">Evidencia / notas</label><textarea class="inp" id="svc-decision-notes" rows="3"></textarea></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Volver</button><button class="btn ${approved?'btn-dark':'btn-red'}" id="svc-decision-save">Confirmar</button></div>`);
  document.getElementById('svc-decision-save').onclick=async()=>{const res=await window.api.serviceOrders.decideEstimate({id:order.id,requestUserId:user?.id,decision:{approved,method:document.getElementById('svc-decision-method').value,customer_name:document.getElementById('svc-decision-name').value.trim(),notes:document.getElementById('svc-decision-notes').value.trim()}});if(!res?.ok)return toast(res?.error,'err');toast(approved?'✓ Aprobado y piezas procesadas':'Presupuesto rechazado',approved?'ok':'w');await svcLoad();svcRenderDetail(res.data);};
}

async function svcReopen(id){const res=await window.api.serviceOrders.reopenEstimate({id,requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');svcRenderDetail(res.data);await svcLoad();}
async function svcRetryParts(id){const res=await window.api.serviceOrders.retryReservations({id,requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');toast('✓ Piezas reservadas','ok');svcRenderDetail(res.data);await svcLoad();}

function svcOpenQuality(order) {
  const checks=['Encendido y estabilidad','Función reparada','Carga / alimentación','Conectividad y puertos','Audio / imagen','Limpieza y ensamblaje'];
  openModal(`<div class="modal-title">Control de calidad</div><div class="modal-sub">${svcEsc(order.number)} · todas las pruebas deben aprobar.</div><div style="display:grid;gap:8px;margin:14px 0">${checks.map((label,index)=>`<label style="display:flex;gap:9px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:8px"><input type="checkbox" class="svc-qc-check" data-key="check_${index}"><span>${svcEsc(label)}</span></label>`).join('')}</div><div class="fg"><label class="lbl">Notas de prueba</label><textarea class="inp" id="svc-qc-notes" rows="3"></textarea></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Volver</button><button class="btn btn-dark" id="svc-qc-save">Aprobar calidad y dejar listo</button></div>`);
  document.getElementById('svc-qc-save').onclick=async()=>{const boxes=[...document.querySelectorAll('.svc-qc-check')],checklist=Object.fromEntries(boxes.map(box=>[box.dataset.key,box.checked]));const saved=await window.api.serviceOrders.saveQuality({id:order.id,requestUserId:user?.id,data:{checklist,notes:document.getElementById('svc-qc-notes').value.trim()}});if(!saved?.ok)return toast(saved?.error,'err');const advanced=await window.api.serviceOrders.advance({id:order.id,status:'listo',requestUserId:user?.id});if(!advanced?.ok)return toast(advanced?.error,'err');toast('✓ Calidad aprobada; equipo listo','ok');await svcLoad();svcRenderDetail(advanced.data);};
}

function svcOpenDelivery(order) {
  openModal(`<div class="modal-title">Entregar y facturar</div><div class="modal-sub">${svcEsc(order.number)} · las piezas reservadas se consumirán una sola vez.</div><div class="g2" style="margin-top:14px"><div class="fg"><label class="lbl">Forma de pago</label><select class="inp" id="svc-pay"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option><option value="credito">Crédito</option></select></div><div class="fg"><label class="lbl">Comprobante fiscal</label><select class="inp" id="svc-ncf"><option value="">Sin NCF</option><option value="B02">B02 · Consumo</option><option value="B01">B01 · Crédito fiscal</option></select></div></div><div class="fg"><label class="lbl">Garantía de esta reparación (días)</label><input class="inp" id="svc-warranty-days" type="number" min="0" max="3650" value="${Number(order.service_warranty_days)||30}"></div><div class="alrt b"><div class="alrt-dot b"></div><div class="alrt-sub">Confirma la identidad de quien retira y conserva la firma en el documento impreso.</div></div><div class="modal-foot"><button class="btn btn-out" id="svc-delivery-back">Volver</button><button class="btn btn-dark" id="svc-confirm-delivery">${svg('check')} Confirmar entrega</button></div>`);
  document.getElementById('svc-delivery-back').onclick=()=>svcOpen(order.id);
  document.getElementById('svc-confirm-delivery').onclick=async event=>{event.currentTarget.disabled=true;const res=await window.api.serviceOrders.deliver({id:order.id,requestUserId:user?.id,payment:{method:document.getElementById('svc-pay').value,ncfType:document.getElementById('svc-ncf').value,warrantyDays:Number(document.getElementById('svc-warranty-days').value)||0}});if(!res?.ok){toast(res?.error||'No se pudo entregar','err');event.currentTarget.disabled=false;return;}toast(`✓ ${res.data.number} entregada y facturada`,'ok');await reloadProducts();await svcLoad();svcRenderDetail(res.data);};
}

async function svcWarrantyReturn(order){const problem=await askText('Describe el problema que presenta nuevamente.',{title:'Reingreso por garantía'});if(!problem)return;const res=await window.api.serviceOrders.createWarrantyReturn({id:order.id,problem,requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');toast(`✓ Reingreso ${res.data.number}`,'ok');await svcLoad();svcRenderDetail(res.data);}

function svcDocumentHtml(order) {
  const items=order.items||[],accessories=svcJson(order.accessories_received,[]),biz=DB?.settings?.biz_name||CFG.biz||'Velo Tech POS';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial;color:#172033;margin:28px;font-size:12px}h1{font-size:22px;margin:0}.muted{color:#667085}.head{display:flex;justify-content:space-between;border-bottom:2px solid #2368d8;padding-bottom:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.box{border:1px solid #d9dee8;border-radius:8px;padding:10px}table{width:100%;border-collapse:collapse}th,td{padding:7px;border-bottom:1px solid #ddd;text-align:left}.sign{display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:55px}.line{border-top:1px solid #222;text-align:center;padding-top:5px}</style></head><body><div class="head"><div><h1>${svcEsc(biz)}</h1><div class="muted">Orden de servicio técnico</div></div><div><strong>${svcEsc(order.number)}</strong><br>${svcEsc(String(order.created_at||'').slice(0,16))}</div></div><div class="grid"><div class="box"><strong>Cliente</strong><br>${svcEsc(order.customer_name)}<br>${svcEsc(order.customer_phone||'')}</div><div class="box"><strong>Equipo</strong><br>${svcEsc(order.device_desc)} · ${svcEsc([order.brand,order.model].filter(Boolean).join(' '))}<br>IMEI/Serial: ${svcEsc(order.imei||order.serial||'—')}</div><div class="box"><strong>Problema reportado</strong><br>${svcEsc(order.problem)}</div><div class="box"><strong>Condición y accesorios</strong><br>${svcEsc(order.intake_condition||'—')}<br>${svcEsc(accessories.join(', ')||'Sin accesorios')}</div></div><div class="box"><strong>Diagnóstico</strong><br>${svcEsc(order.diagnosis||'Pendiente')}</div>${items.length?`<h3>Presupuesto / trabajo</h3><table><thead><tr><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Total</th></tr></thead><tbody>${items.map(i=>`<tr><td>${svcEsc(i.description)}</td><td>${i.qty}</td><td>${fmt(i.unit_price)}</td><td>${fmt(i.qty*i.unit_price)}</td></tr>`).join('')}</tbody></table><h2 style="text-align:right">Total ${fmt(items.reduce((s,i)=>s+Number(i.qty)*Number(i.unit_price),0))}</h2>`:''}<p class="muted">Estado: ${svcEsc(SVC_LABEL[order.workflow_status]||order.workflow_status)} · Garantía de reparación: ${order.service_warranty_days||0} días${order.warranty_until?` hasta ${svcEsc(order.warranty_until)}`:''}.</p><div class="sign"><div class="line">Firma del cliente</div><div class="line">Recibido / entregado por</div></div></body></html>`;
}
function svcPrintDocument(order){printHTML(svcDocumentHtml(order),'reporte');}
function svcShareStatus(order){const message=`Hola ${order.customer_name}. La orden ${order.number} de ${order.device_desc} está: ${SVC_LABEL[order.workflow_status]||order.workflow_status}.`;if(typeof openWhatsAppModal==='function')openWhatsAppModal(message,order.customer_phone||'',order.customer_name);else toast(message,'ok');}

async function svcOpenTechnicians(){await svcLoadTechnicians();openModal(`<div class="modal-title">Técnicos del taller</div><div class="modal-sub">Asignación, especialidad y comisión de referencia.</div><div style="display:grid;gap:7px;margin:12px 0">${svcTechnicians.map(t=>`<div class="card" style="padding:10px;display:flex;justify-content:space-between"><div><div class="tb">${svcEsc(t.name)}</div><div class="ts">${svcEsc(t.specialty||'General')} · ${Number(t.commission_pct)||0}%</div></div></div>`).join('')||'<div class="ts">No hay técnicos registrados.</div>'}</div><div class="g2"><div class="fg"><label class="lbl">Nombre *</label><input class="inp" id="svc-tech-name"></div><div class="fg"><label class="lbl">Teléfono</label><input class="inp" id="svc-tech-phone"></div></div><div class="g2"><div class="fg"><label class="lbl">Especialidad</label><input class="inp" id="svc-tech-specialty" placeholder="Celulares, laptops, TV…"></div><div class="fg"><label class="lbl">Comisión %</label><input class="inp" id="svc-tech-commission" type="number" min="0" max="100" value="0"></div></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button><button class="btn btn-dark" id="svc-tech-save">Guardar técnico</button></div>`);
  document.getElementById('svc-tech-save').onclick=async()=>{const res=await window.api.serviceOrders.saveTechnician({requestUserId:user?.id,data:{name:document.getElementById('svc-tech-name').value.trim(),phone:document.getElementById('svc-tech-phone').value.trim(),specialty:document.getElementById('svc-tech-specialty').value.trim(),commission_pct:Number(document.getElementById('svc-tech-commission').value)||0}});if(!res?.ok)return toast(res?.error,'err');toast('✓ Técnico guardado','ok');await svcLoadTechnicians();svcOpenTechnicians();};
}

async function svcOpenReport(){const res=await window.api.serviceOrders.report({requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');const r=res.data;openModal(`<div class="modal-title">Indicadores del taller</div><div class="metrics" style="grid-template-columns:repeat(4,1fr);margin:14px 0"><div class="metric"><div class="met-label">Abiertas</div><div class="met-val">${r.open}</div></div><div class="metric"><div class="met-label">Atrasadas</div><div class="met-val">${r.overdue}</div></div><div class="metric"><div class="met-label">Entregadas</div><div class="met-val">${r.delivered}</div></div><div class="metric"><div class="met-label">Días promedio</div><div class="met-val">${r.average_days}</div></div></div><div class="g2"><div class="card" style="padding:12px"><div class="tb">Por estado</div>${r.by_status.map(x=>`<div style="display:flex;justify-content:space-between;padding:5px 0"><span>${svcEsc(SVC_LABEL[x.status]||x.status)}</span><strong>${x.count}</strong></div>`).join('')}</div><div class="card" style="padding:12px"><div class="tb">Por técnico</div>${r.by_technician.map(x=>`<div style="display:flex;justify-content:space-between;padding:5px 0"><span>${svcEsc(x.technician)}</span><strong>${x.count} · ${fmt(x.billed)}</strong></div>`).join('')}</div></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>`, 'modal-lg');}
