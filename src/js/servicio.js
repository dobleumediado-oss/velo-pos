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
      <div class="flex" style="gap:8px"><button class="btn btn-out" id="svc-agenda">${svg('calendar')} Agenda</button><button class="btn btn-out" id="svc-report">${svg('chart')} Indicadores</button>
      ${['admin','superadmin'].includes(user?.role)?`<button class="btn btn-out" id="svc-catalog">Catálogo técnico</button><button class="btn btn-out" id="svc-portal-config">${svg('link')} Portal clientes</button><button class="btn btn-out" id="svc-techs">${svg('users')} Técnicos</button>`:''}
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
  document.getElementById('svc-agenda').onclick = svcOpenAgenda;
  document.getElementById('svc-report').onclick = svcOpenReport;
  document.getElementById('svc-techs')?.addEventListener('click', svcOpenTechnicians);
  document.getElementById('svc-catalog')?.addEventListener('click', svcOpenTechCatalog);
  document.getElementById('svc-portal-config')?.addEventListener('click', svcOpenPortalConfig);
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
  const itemRows=()=>items.length?items.map((item,index)=>`<tr><td>${item.kind==='parte'?'Pieza':'Mano de obra'}</td><td>${svcEsc(item.description)}</td><td>${item.qty}</td><td>${fmt(item.unit_price)}</td><td>${fmt(item.qty*item.unit_price)}</td><td>${item.kind==='parte'?`<span class="badge ${item.reservation_status==='reserved'?'g':item.reservation_status==='waiting'?'a':'n'}">${svcEsc(item.reservation_status||'none')}</span>${item.reservation_status==='waiting'&&item.id?` <button class="btn btn-out btn-sm" data-svc-request="${item.id}">Solicitar</button>`:''}`:'—'}</td>${editable?`<td><button class="btn btn-ghost btn-sm" data-svc-rm="${index}" style="color:var(--red)">${svg('trash')}</button></td>`:'<td></td>'}</tr>`).join(''):`<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:14px">Sin partidas</td></tr>`;
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
    <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0"><div><button class="btn btn-out btn-sm" id="svc-print">${svg('printer')} Documento</button> <button class="btn btn-out btn-sm" id="svc-evidence">📷 Evidencias (${(order.evidence||[]).length})</button> <button class="btn btn-out btn-sm" id="svc-timer">⏱ ${order.time_entries?.some(entry=>entry.status==='running')?'Detener tiempo':'Iniciar tiempo'}</button> <button class="btn btn-out btn-sm" id="svc-portal">${svg('link')} Portal / QR</button> <button class="btn btn-out btn-sm" id="svc-whatsapp">WhatsApp</button></div><div class="tb">Total: <span id="svc-total">${fmt(items.reduce((s,i)=>s+Number(i.qty)*Number(i.unit_price),0))}</span></div></div>
    ${(order.procurement||[]).length?`<div class="alrt b" style="margin:8px 0"><div class="alrt-dot b"></div><div class="alrt-sub">Abastecimiento: ${order.procurement.map(request=>`${svcEsc(request.description)} · ${svcEsc(request.status)}${request.purchase_order_id?` · OC-${String(request.purchase_order_id).padStart(4,'0')}`:''}`).join('<br>')}</div></div>`:''}
    <details style="margin-top:10px"><summary class="tb" style="cursor:pointer">Historial y versiones</summary><div style="margin-top:10px">${svcTimeline(order.events)}</div>${order.estimates?.length?`<div class="ts" style="margin-top:10px">Presupuestos: ${order.estimates.map(e=>`v${e.version} ${e.status} (${fmt(e.amount)})`).join(' · ')}</div>`:''}</details>
    <div class="modal-foot" style="justify-content:space-between"><div>${SVC_ACTIVE.has(order.workflow_status)?`<button class="btn btn-ghost" id="svc-cancel" style="color:var(--red)">Cancelar orden</button>`:''}</div><div class="flex" style="gap:8px"><button class="btn btn-out" onclick="closeModal()">Cerrar</button>${editable?'<button class="btn btn-out" id="svc-save">Guardar</button>':''}${svcActionButton(order,next)}</div></div>`, 'modal-xl');

  const rerender=()=>{document.getElementById('svc-items-body').innerHTML=itemRows();document.querySelectorAll('[data-svc-rm]').forEach(button=>button.onclick=()=>{items.splice(Number(button.dataset.svcRm),1);rerender();});document.querySelectorAll('[data-svc-request]').forEach(button=>button.onclick=()=>svcRequestPart(order,Number(button.dataset.svcRequest)));document.getElementById('svc-total').textContent=fmt(items.reduce((s,i)=>s+Number(i.qty)*Number(i.unit_price),0));};
  if(editable){
    document.getElementById('svc-add-part').onclick=()=>{const pid=Number(document.getElementById('svc-part-product').value),product=products.find(p=>Number(p.id)===pid);if(!product)return toast('Selecciona una pieza','w');items.push({kind:'parte',product_id:product.id,description:product.name,qty:Math.max(1,Number(document.getElementById('svc-part-qty').value)||1),unit_price:Math.max(0,Number(document.getElementById('svc-part-price').value)||Number(product.price)||0),taxable:product.taxable,tax_pct:product.tax_pct,reservation_status:'none'});rerender();};
    document.getElementById('svc-add-labor').onclick=()=>{const description=document.getElementById('svc-labor-desc').value.trim();if(!description)return toast('Describe la mano de obra','w');items.push({kind:'mano_obra',description,qty:Math.max(1,Number(document.getElementById('svc-labor-qty').value)||1),unit_price:Math.max(0,Number(document.getElementById('svc-labor-price').value)||0),taxable:1,tax_pct:Number(CFG.itbis)||18});rerender();};
  }
  rerender();
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
  document.getElementById('svc-evidence').onclick=()=>svcOpenEvidence(order);
  document.getElementById('svc-timer').onclick=()=>svcToggleTimer(order);
  document.getElementById('svc-portal').onclick=()=>svcOpenPortal(order);
  document.getElementById('svc-whatsapp').onclick=()=>svcShareStatus(order);
}

async function svcOpenEvidence(order) {
  const current=await window.api.serviceOrders.getById({id:order.id,requestUserId:user?.id});
  if(!current?.ok)return toast(current?.error||'No se pudieron cargar las evidencias','err');
  order=current.data;
  openModal(`<div class="modal-title">Evidencias y firma</div><div class="modal-sub">${svcEsc(order.number)} · archivos con verificación de integridad.</div>
    <div class="g2" style="margin-top:14px"><div class="fg"><label class="lbl">Etapa</label><select class="inp" id="svc-evidence-type"><option value="recepcion">Recepción</option><option value="diagnostico">Diagnóstico</option><option value="proceso">Proceso</option><option value="entrega">Entrega</option></select></div><div class="fg"><label class="lbl">Nota</label><input class="inp" id="svc-evidence-note" placeholder="Pantalla, carcasa, accesorio…"></div></div>
    <div class="fg"><label class="lbl">Fotografías JPG, PNG o WEBP</label><input class="inp" id="svc-evidence-files" type="file" accept="image/jpeg,image/png,image/webp" multiple></div>
    <button class="btn btn-dark btn-sm" id="svc-evidence-upload">Subir fotografías</button>
    <details style="margin-top:14px"><summary class="tb" style="cursor:pointer">Firma digital del cliente</summary><div style="margin-top:9px"><canvas id="svc-signature" width="720" height="180" style="width:100%;height:180px;border:1px solid var(--line);border-radius:8px;background:#fff;touch-action:none"></canvas><div class="flex" style="gap:8px;margin-top:7px"><button class="btn btn-out btn-sm" id="svc-signature-clear">Limpiar</button><button class="btn btn-dark btn-sm" id="svc-signature-save">Guardar firma</button></div></div></details>
    <div class="tb" style="margin:16px 0 8px">Registro (${(order.evidence||[]).length})</div><div id="svc-evidence-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${(order.evidence||[]).map(evidence=>`<div class="card" style="padding:8px"><div style="aspect-ratio:4/3;background:var(--surface2);border-radius:7px;display:grid;place-items:center;overflow:hidden"><img data-evidence="${evidence.id}" alt="${svcEsc(evidence.evidence_type)}" style="width:100%;height:100%;object-fit:cover"><span class="ts" data-evidence-wait="${evidence.id}">Verificando…</span></div><div class="tb" style="margin-top:6px">${svcEsc(evidence.evidence_type)}</div><div class="ts">${svcEsc(evidence.note||evidence.original_name||'')}<br>${svcEsc(String(evidence.created_at||'').slice(0,16))}<br>SHA-256 ${svcEsc(String(evidence.sha256||'').slice(0,12))}…</div></div>`).join('')||'<div class="ts">Aún no hay evidencias.</div>'}</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="svcOpen(${order.id})">Volver a la orden</button></div>`, 'modal-xl');

  for(const evidence of (order.evidence||[])){
    const result=await window.api.serviceOrders.getEvidenceData({id:order.id,evidence_id:evidence.id,requestUserId:user?.id});
    const image=document.querySelector(`[data-evidence="${evidence.id}"]`),wait=document.querySelector(`[data-evidence-wait="${evidence.id}"]`);
    if(result?.ok&&image){image.src=result.data_url;if(wait)wait.remove();}else if(wait)wait.textContent='No disponible';
  }
  document.getElementById('svc-evidence-upload').onclick=async event=>{
    const files=[...document.getElementById('svc-evidence-files').files];
    if(!files.length)return toast('Selecciona al menos una fotografía','w');
    event.currentTarget.disabled=true;
    for(const file of files){
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
      const result=await window.api.serviceOrders.addEvidence({id:order.id,requestUserId:user?.id,evidence_type:document.getElementById('svc-evidence-type').value,note:document.getElementById('svc-evidence-note').value.trim(),original_name:file.name,data_url:dataUrl});
      if(!result?.ok){toast(result?.error||`No se pudo guardar ${file.name}`,'err');event.currentTarget.disabled=false;return;}
    }
    toast('✓ Evidencias guardadas','ok');svcOpenEvidence(order);
  };
  const canvas=document.getElementById('svc-signature'),ctx=canvas.getContext('2d');ctx.strokeStyle='#111827';ctx.lineWidth=3;ctx.lineCap='round';let drawing=false;
  const point=event=>{const box=canvas.getBoundingClientRect();return{x:(event.clientX-box.left)*canvas.width/box.width,y:(event.clientY-box.top)*canvas.height/box.height};};
  canvas.onpointerdown=event=>{drawing=true;const p=point(event);ctx.beginPath();ctx.moveTo(p.x,p.y);canvas.setPointerCapture(event.pointerId);};
  canvas.onpointermove=event=>{if(!drawing)return;const p=point(event);ctx.lineTo(p.x,p.y);ctx.stroke();};
  canvas.onpointerup=()=>{drawing=false;};canvas.onpointercancel=()=>{drawing=false;};
  document.getElementById('svc-signature-clear').onclick=()=>ctx.clearRect(0,0,canvas.width,canvas.height);
  document.getElementById('svc-signature-save').onclick=async event=>{event.currentTarget.disabled=true;const result=await window.api.serviceOrders.addEvidence({id:order.id,requestUserId:user?.id,evidence_type:'firma_cliente',note:'Firma digital del cliente',original_name:`firma-${order.number}.png`,data_url:canvas.toDataURL('image/png')});if(!result?.ok){toast(result?.error,'err');event.currentTarget.disabled=false;return;}toast('✓ Firma guardada','ok');svcOpenEvidence(order);};
}

async function svcToggleTimer(order) {
  const running=(order.time_entries||[]).find(entry=>entry.status==='running');
  if(running){
    const result=await window.api.serviceOrders.stopTimer({entry_id:running.id,requestUserId:user?.id});
    if(!result?.ok)return toast(result?.error,'err');toast(`✓ Tiempo registrado: ${result.data.duration_minutes} min`,'ok');return svcOpen(order.id);
  }
  const techId=Number(order.service_technician_id)||Number(svcTechnicians[0]?.id);
  if(!techId)return toast('Crea y asigna un técnico antes de iniciar el tiempo','w');
  const result=await window.api.serviceOrders.startTimer({id:order.id,technician_id:techId,requestUserId:user?.id});
  if(!result?.ok)return toast(result?.error,'err');toast('⏱ Tiempo iniciado','ok');svcOpen(order.id);
}

async function svcRequestPart(order,itemId) {
  const suppliersResult=await window.api.suppliers.getAll();
  if(!suppliersResult?.ok)return toast(suppliersResult?.error||'No se pudieron cargar proveedores','err');
  const suppliers=suppliersResult.data||[];
  openModal(`<div class="modal-title">Solicitar pieza faltante</div><div class="modal-sub">${svcEsc(order.number)} · crea una solicitud trazable y, si eliges proveedor, una orden de compra enlazada.</div><div class="fg" style="margin-top:14px"><label class="lbl">Proveedor</label><select class="inp" id="svc-request-supplier"><option value="">Solo crear solicitud</option>${suppliers.map(supplier=>`<option value="${supplier.id}">${svcEsc(supplier.name)}</option>`).join('')}</select></div><div class="modal-foot"><button class="btn btn-out" onclick="svcOpen(${order.id})">Volver</button><button class="btn btn-dark" id="svc-request-save">Crear solicitud</button></div>`);
  document.getElementById('svc-request-save').onclick=async event=>{event.currentTarget.disabled=true;const result=await window.api.serviceOrders.requestPart({id:order.id,item_id:itemId,supplier_id:Number(document.getElementById('svc-request-supplier').value)||null,requestUserId:user?.id});if(!result?.ok){toast(result?.error,'err');event.currentTarget.disabled=false;return;}toast(result.data.purchaseOrderId?`✓ OC-${String(result.data.purchaseOrderId).padStart(4,'0')} creada`:'✓ Solicitud creada','ok');svcOpen(order.id);};
}

async function svcOpenAgenda() {
  const result=await window.api.serviceOrders.appointments({requestUserId:user?.id});
  if(!result?.ok)return toast(result?.error||'No se pudo cargar la agenda','err');
  const rows=result.data||[];
  openModal(`<div class="fxb"><div><div class="modal-title">Agenda del taller</div><div class="modal-sub">Citas, responsables y estado operativo.</div></div><button class="btn btn-dark btn-sm" id="svc-appointment-new">+ Nueva cita</button></div><div class="tw" style="max-height:520px;margin-top:14px"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Equipo / motivo</th><th>Técnico</th><th>Estado</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${svcEsc(String(row.starts_at||'').replace('T',' ').slice(0,16))}</td><td><b>${svcEsc(row.customer_name||'—')}</b><div class="ts">${svcEsc(row.customer_phone||'')}</div></td><td>${svcEsc(row.device_desc||'')}<div class="ts">${svcEsc(row.reason)}</div></td><td>${svcEsc(row.technician_name||'Sin asignar')}</td><td>${svcEsc(row.status)}</td></tr>`).join('')||'<tr><td colspan="5" class="ts" style="text-align:center;padding:20px">Sin citas programadas</td></tr>'}</tbody></table></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>`, 'modal-xl');
  document.getElementById('svc-appointment-new').onclick=svcNewAppointment;
}

function svcNewAppointment() {
  const customers=(DB.customers||[]).filter(customer=>customer.active!==0);
  openModal(`<div class="modal-title">Nueva cita</div><div class="g2" style="margin-top:14px"><div class="fg"><label class="lbl">Cliente</label><select class="inp" id="svc-appt-customer"><option value="">Sin cliente registrado</option>${customers.map(customer=>`<option value="${customer.id}" data-phone="${svcEsc(customer.phone||'')}">${svcEsc(customer.name)}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Fecha y hora *</label><input class="inp" type="datetime-local" id="svc-appt-start"></div></div><div class="g2"><div class="fg"><label class="lbl">Equipo</label><input class="inp" id="svc-appt-device"></div><div class="fg"><label class="lbl">Técnico</label><select class="inp" id="svc-appt-tech"><option value="">Sin asignar</option>${svcTechnicians.map(tech=>`<option value="${tech.id}">${svcEsc(tech.name)}</option>`).join('')}</select></div></div><div class="fg"><label class="lbl">Motivo *</label><textarea class="inp" id="svc-appt-reason" rows="2"></textarea></div><div class="modal-foot"><button class="btn btn-out" onclick="svcOpenAgenda()">Volver</button><button class="btn btn-dark" id="svc-appt-save">Guardar cita</button></div>`);
  document.getElementById('svc-appt-save').onclick=async event=>{const select=document.getElementById('svc-appt-customer'),customer=(DB.customers||[]).find(row=>Number(row.id)===Number(select.value));event.currentTarget.disabled=true;const result=await window.api.serviceOrders.saveAppointment({requestUserId:user?.id,data:{customer_id:Number(select.value)||null,customer_name:customer?.name||'Cliente por confirmar',customer_phone:customer?.phone||'',starts_at:document.getElementById('svc-appt-start').value,device_desc:document.getElementById('svc-appt-device').value.trim(),technician_id:Number(document.getElementById('svc-appt-tech').value)||null,reason:document.getElementById('svc-appt-reason').value.trim()}});if(!result?.ok){toast(result?.error,'err');event.currentTarget.disabled=false;return;}toast('✓ Cita guardada','ok');svcOpenAgenda();};
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

function svcQrSvg(url) {
  if(!url||typeof qrcode!=='function')return '';
  try{const qr=qrcode(0,'M');qr.addData(url);qr.make();return qr.createSvgTag({cellSize:3,margin:2,scalable:true,alt:'Seguimiento de reparación',title:'Portal de seguimiento'}).replace('<svg ','<svg style="display:block;width:150px;height:150px" ');}catch{return '';}
}

async function svcCopyText(text){
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(String(text||''));return;}
  const area=document.createElement('textarea');area.value=String(text||'');area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();
}

function svcDocumentHtml(order,access={}) {
  const items=order.items||[],accessories=svcJson(order.accessories_received,[]),biz=DB?.settings?.biz_name||CFG.biz||'Velo Tech POS';
  const qr=svcQrSvg(access.url||'');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial;color:#172033;margin:28px;font-size:12px}h1{font-size:22px;margin:0}.muted{color:#667085}.head{display:flex;justify-content:space-between;border-bottom:2px solid #2368d8;padding-bottom:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.box{border:1px solid #d9dee8;border-radius:8px;padding:10px}table{width:100%;border-collapse:collapse}th,td{padding:7px;border-bottom:1px solid #ddd;text-align:left}.sign{display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:55px}.line{border-top:1px solid #222;text-align:center;padding-top:5px}.portal{display:flex;gap:14px;align-items:center;margin-top:18px;padding:12px;border:1px solid #d9dee8;border-radius:8px;word-break:break-all}</style></head><body><div class="head"><div><h1>${svcEsc(biz)}</h1><div class="muted">Orden de servicio técnico</div></div><div><strong>${svcEsc(order.number)}</strong><br>${svcEsc(String(order.created_at||'').slice(0,16))}</div></div><div class="grid"><div class="box"><strong>Cliente</strong><br>${svcEsc(order.customer_name)}<br>${svcEsc(order.customer_phone||'')}</div><div class="box"><strong>Equipo</strong><br>${svcEsc(order.device_desc)} · ${svcEsc([order.brand,order.model].filter(Boolean).join(' '))}<br>IMEI/Serial: ${svcEsc(order.imei||order.serial||'—')}</div><div class="box"><strong>Problema reportado</strong><br>${svcEsc(order.problem)}</div><div class="box"><strong>Condición y accesorios</strong><br>${svcEsc(order.intake_condition||'—')}<br>${svcEsc(accessories.join(', ')||'Sin accesorios')}</div></div><div class="box"><strong>Diagnóstico</strong><br>${svcEsc(order.diagnosis||'Pendiente')}</div>${items.length?`<h3>Presupuesto / trabajo</h3><table><thead><tr><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Total</th></tr></thead><tbody>${items.map(i=>`<tr><td>${svcEsc(i.description)}</td><td>${i.qty}</td><td>${fmt(i.unit_price)}</td><td>${fmt(i.qty*i.unit_price)}</td></tr>`).join('')}</tbody></table><h2 style="text-align:right">Total ${fmt(items.reduce((s,i)=>s+Number(i.qty)*Number(i.unit_price),0))}</h2>`:''}<p class="muted">Estado: ${svcEsc(SVC_LABEL[order.workflow_status]||order.workflow_status)} · Garantía de reparación: ${order.service_warranty_days||0} días${order.warranty_until?` hasta ${svcEsc(order.warranty_until)}`:''}.</p>${access.url?`<div class="portal">${qr}<div><strong>Seguimiento privado</strong><br><span class="muted">Escanea el QR o visita:</span><br>${svcEsc(access.url)}</div></div>`:''}<div class="sign"><div class="line">Firma del cliente</div><div class="line">Recibido / entregado por</div></div></body></html>`;
}
async function svcPrintDocument(order){const res=await window.api.serviceOrders.getPublicAccess({id:order.id,requestUserId:user?.id});printHTML(svcDocumentHtml(order,res?.ok?res.data:{}),'reporte');}

async function svcShareStatus(order){
  const waiting=order.workflow_status==='esperando_aprobacion';
  const type=order.workflow_status==='listo'?'listo':order.workflow_status==='entregado'?'entregado':'estado';
  const res=waiting
    ?await window.api.serviceOrders.preparePublicApproval({id:order.id,requestUserId:user?.id})
    :await window.api.serviceOrders.getSharePayload({id:order.id,type,requestUserId:user?.id});
  if(!res?.ok)return toast(res?.error||'No se pudo preparar el mensaje','err');
  if(!res.data.configured)toast('Configura primero la URL de Tailscale Funnel en Portal clientes','w');
  const messageConfig=await window.api.serviceOrders.getMessagingConfig({requestUserId:user?.id});
  if(messageConfig?.ok&&messageConfig.data.mode==='whatsapp_cloud'){
    const sent=await window.api.serviceOrders.sendNotification({id:order.id,type:waiting?'presupuesto':type,phone:res.data.phone||order.customer_phone||'',message:res.data.message,requestUserId:user?.id});
    if(!sent?.ok)return toast(sent?.error||'WhatsApp Cloud rechazó el mensaje','err');
    toast('✓ WhatsApp aceptó el mensaje para envío','ok');
  }else{
    if(typeof openWhatsAppModal==='function')openWhatsAppModal(res.data.message,res.data.phone||order.customer_phone||'',order.customer_name);
    await window.api.serviceOrders.markNotificationSent({id:order.id,type:waiting?'presupuesto':type,requestUserId:user?.id});
  }
}

async function svcOpenPortal(order){
  const res=await window.api.serviceOrders.getPublicAccess({id:order.id,requestUserId:user?.id});
  if(!res?.ok)return toast(res?.error||'No se pudo crear el enlace','err');
  const access=res.data,url=access.url||access.relativePath,qr=svcQrSvg(access.url||'');
  openModal(`<div class="modal-title">Portal del cliente</div><div class="modal-sub">${svcEsc(order.number)} · enlace secreto, revocable y con vencimiento.</div>${access.configured?'':`<div class="alrt a" style="margin-top:12px"><div class="alrt-dot a"></div><div><div class="alrt-title">Falta configurar Tailscale Funnel</div><div class="alrt-sub">El enlace relativo ya existe, pero no podrá abrirse fuera de VELO hasta guardar la URL pública.</div></div></div>`}<div style="display:grid;grid-template-columns:180px 1fr;gap:18px;align-items:center;margin:18px 0"><div style="display:grid;place-items:center;background:white;border:1px solid var(--line);border-radius:12px;padding:10px">${qr||'<div class="ts">QR disponible al configurar la URL</div>'}</div><div><div class="lbl">Enlace del cliente</div><div class="card" style="padding:10px;word-break:break-all;font-size:12px">${svcEsc(url)}</div><div class="ts">Vence: ${svcEsc(access.expires_at||'sin vencimiento')} · Consultas: ${Number(access.access_count)||0}</div></div></div><div class="modal-foot" style="justify-content:space-between"><div><button class="btn btn-ghost" id="svc-portal-revoke" style="color:var(--red)">Revocar</button><button class="btn btn-out" id="svc-portal-renew">Regenerar</button></div><div class="flex" style="gap:8px">${['admin','superadmin'].includes(user?.role)?'<button class="btn btn-out" id="svc-portal-settings">Configurar</button>':''}<button class="btn btn-out" id="svc-portal-copy">Copiar</button>${access.url?'<button class="btn btn-dark" id="svc-portal-open">Abrir portal</button>':''}</div></div>`, 'modal-lg');
  document.getElementById('svc-portal-copy').onclick=async()=>{try{await svcCopyText(url);toast('✓ Enlace copiado','ok');}catch{toast('No se pudo copiar; selecciona el enlace manualmente','err');}};
  document.getElementById('svc-portal-open')?.addEventListener('click',()=>window.api.shell.openExternal(access.url));
  document.getElementById('svc-portal-settings')?.addEventListener('click',svcOpenPortalConfig);
  document.getElementById('svc-portal-renew').onclick=async()=>{const next=await window.api.serviceOrders.regeneratePublicAccess({id:order.id,requestUserId:user?.id});if(!next?.ok)return toast(next?.error,'err');toast('✓ Enlace anterior invalidado','ok');svcOpenPortal(order);};
  document.getElementById('svc-portal-revoke').onclick=async()=>{const out=await window.api.serviceOrders.revokePublicAccess({id:order.id,requestUserId:user?.id});if(!out?.ok)return toast(out?.error,'err');toast('Enlace revocado','ok');closeModal();};
}

async function svcOpenPortalConfig(){
  const [res,messaging]=await Promise.all([window.api.serviceOrders.getPortalConfig({requestUserId:user?.id}),window.api.serviceOrders.getMessagingConfig({requestUserId:user?.id})]);
  if(!res?.ok)return toast(res?.error||'No se pudo leer la configuración','err');
  const cfg=res.data;
  const health=cfg.local_status||{};
  const msg=messaging?.data||{};
  openModal(`<div class="modal-title">Portal y mensajería del taller</div>
    <div class="modal-sub">La base sigue dentro de la PC servidor; el portal publica solo el seguimiento privado.</div>
    <div class="alrt ${health.online?'b':'a'}" style="margin-top:14px"><div class="alrt-dot ${health.online?'b':'a'}"></div><div>
      <div class="alrt-title">Portal local: ${health.online?'activo':'sin respuesta'}</div>
      <div class="alrt-sub">${health.online?`Respondió en ${Number(health.response_ms)||0} ms en 127.0.0.1.`:`${svcEsc(health.detail||'No disponible')}. Verifica que VELO Server Service esté iniciado.`}<br><b>Este estado no confirma que el celular del cliente pueda entrar por Internet.</b></div>
    </div></div>
    <div class="card" style="padding:12px;margin-top:12px"><div class="tb">Publicar con Tailscale Funnel · 2 pasos</div>
      <div class="ts" style="line-height:1.65;margin-top:6px"><b>1. Habilitar una sola vez:</b> si Tailscale muestra <code>https://login.tailscale.com/f/funnel?node=...</code>, abre ese enlace y autoriza Funnel. Ese enlace <b>no</b> se guarda en VELO.<br>
      <b>2. Publicar y copiar:</b> vuelve a ejecutar <code>${svcEsc(cfg.funnel_command)}</code> y copia únicamente el dominio de la línea <code>Available on the internet: https://...ts.net</code>.</div>
    </div>
    <div class="fg" style="margin-top:12px"><label class="lbl">URL pública HTTPS entregada por Tailscale</label>
      <input class="inp no-uppercase" id="svc-portal-base" data-uppercase="off" placeholder="https://velo-servidor.tu-tailnet.ts.net" value="${svcEsc(cfg.base_url||'')}">
      <div class="ts">Solo el dominio base: sin barra final, sin /r, sin número de orden y sin pegar el comando.</div>
    </div>
    <div id="svc-portal-public-result" class="alrt a"><div class="alrt-dot a"></div><div><div class="alrt-title">Acceso público: ${cfg.base_url?'no probado en esta sesión':'sin URL guardada'}</div><div class="alrt-sub">${cfg.base_url?'Pulsa “Probar acceso público” para consultar manualmente la URL guardada.':'Guarda primero el dominio público entregado por Tailscale.'}</div></div></div>
    <div class="g2"><div class="fg"><label class="lbl">Vigencia de cada enlace (días)</label><input class="inp" id="svc-portal-days" type="number" min="1" max="3650" value="${Number(cfg.link_days)||365}"></div><label style="display:flex;align-items:center;gap:8px;margin-top:24px"><input type="checkbox" id="svc-portal-enabled" ${cfg.enabled?'checked':''}> Portal habilitado</label></div>
    <div class="card" style="padding:12px"><div class="tb">Dirección local del portal</div><div class="ts">http://127.0.0.1:${Number(cfg.port)||8787}/health · Negocio: ${svcEsc(cfg.business_id)}</div></div>
    <details style="margin-top:12px"><summary class="tb" style="cursor:pointer">WhatsApp Business Cloud API (opcional)</summary><div class="alrt a" style="margin-top:10px"><div class="alrt-dot a"></div><div class="alrt-sub">El modo asistido abre WhatsApp. El modo Cloud envía por la API oficial y registra aceptación o error; la entrega final requiere webhooks de Meta.</div></div><div class="g2"><div class="fg"><label class="lbl">Modo</label><select class="inp" id="svc-msg-mode"><option value="assisted" ${msg.mode!=='whatsapp_cloud'?'selected':''}>Asistido</option><option value="whatsapp_cloud" ${msg.mode==='whatsapp_cloud'?'selected':''}>WhatsApp Cloud</option></select></div><div class="fg"><label class="lbl">Versión Graph</label><input class="inp no-uppercase" id="svc-msg-version" data-uppercase="off" placeholder="v23.0" value="${svcEsc(msg.graph_version||'')}"></div></div><div class="fg"><label class="lbl">Phone Number ID</label><input class="inp no-uppercase" id="svc-msg-phone-id" data-uppercase="off" value="${svcEsc(msg.phone_number_id||'')}"></div><div class="fg"><label class="lbl">Token permanente ${msg.has_token?'(ya existe; deja vacío para conservarlo)':''}</label><input class="inp no-uppercase" id="svc-msg-token" data-uppercase="off" type="password" autocomplete="new-password"></div></details>
    <div class="modal-foot" style="justify-content:space-between"><div class="flex" style="gap:8px"><button class="btn btn-out" id="svc-portal-refresh">Revisar portal local</button><button class="btn btn-out" id="svc-portal-public-test">Probar acceso público</button></div><div><button class="btn btn-out" onclick="closeModal()">Cerrar</button> <button class="btn btn-dark" id="svc-portal-save">Guardar configuración</button></div></div>`, 'modal-lg');
  document.getElementById('svc-portal-refresh').onclick=svcOpenPortalConfig;
  document.getElementById('svc-portal-public-test').onclick=async event=>{
    const currentInput=document.getElementById('svc-portal-base').value.trim().replace(/\/+$/,'');
    const savedBase=String(cfg.base_url||'').trim().replace(/\/+$/,'');
    if(currentInput!==savedBase)return toast('Guarda primero la URL antes de probarla','w');
    const host=document.getElementById('svc-portal-public-result');
    event.currentTarget.disabled=true;
    host.className='alrt b';
    host.innerHTML='<div class="alrt-dot b"></div><div><div class="alrt-title">Probando la ruta pública…</div><div class="alrt-sub">Esta comprobación manual puede tardar unos segundos.</div></div>';
    const tested=await window.api.serviceOrders.testPublicAccess({requestUserId:user?.id});
    event.currentTarget.disabled=false;
    if(!tested?.ok){host.className='alrt a';host.innerHTML=`<div class="alrt-dot a"></div><div><div class="alrt-title">Acceso público: no disponible</div><div class="alrt-sub">${svcEsc(tested?.error||'No se pudo ejecutar la prueba')}</div></div>`;return;}
    const status=tested.data||{};
    host.className=`alrt ${status.online?'b':'a'}`;
    host.innerHTML=`<div class="alrt-dot ${status.online?'b':'a'}"></div><div><div class="alrt-title">Acceso público: ${status.online?'confirmado':'con problema'}</div><div class="alrt-sub">${status.reachable?`La URL pública respondió HTTP ${Number(status.status_code)||0} en ${Number(status.response_ms)||0} ms.`:`${svcEsc(status.detail||'No respondió')} (${Number(status.response_ms)||0} ms).`} Esta prueba usa el dominio público, no 127.0.0.1; confirma también desde un celular con datos móviles.</div></div>`;
  };
  document.getElementById('svc-portal-save').onclick=async()=>{const saved=await window.api.serviceOrders.savePortalConfig({requestUserId:user?.id,base_url:document.getElementById('svc-portal-base').value.trim(),link_days:Number(document.getElementById('svc-portal-days').value),enabled:document.getElementById('svc-portal-enabled').checked});if(!saved?.ok)return toast(saved?.error||'No se pudo guardar','err');const savedMessaging=await window.api.serviceOrders.saveMessagingConfig({requestUserId:user?.id,mode:document.getElementById('svc-msg-mode').value,graph_version:document.getElementById('svc-msg-version').value.trim(),phone_number_id:document.getElementById('svc-msg-phone-id').value.trim(),access_token:document.getElementById('svc-msg-token').value.trim()});if(!savedMessaging?.ok)return toast(savedMessaging?.error||'No se pudo guardar mensajería','err');toast('✓ Portal y mensajería configurados','ok');closeModal();};
}

async function svcOpenTechnicians(){await svcLoadTechnicians();openModal(`<div class="modal-title">Técnicos del taller</div><div class="modal-sub">Asignación, especialidad y comisión de referencia.</div><div style="display:grid;gap:7px;margin:12px 0">${svcTechnicians.map(t=>`<div class="card" style="padding:10px;display:flex;justify-content:space-between"><div><div class="tb">${svcEsc(t.name)}</div><div class="ts">${svcEsc(t.specialty||'General')} · ${Number(t.commission_pct)||0}%</div></div></div>`).join('')||'<div class="ts">No hay técnicos registrados.</div>'}</div><div class="g2"><div class="fg"><label class="lbl">Nombre *</label><input class="inp" id="svc-tech-name"></div><div class="fg"><label class="lbl">Teléfono</label><input class="inp" id="svc-tech-phone"></div></div><div class="g2"><div class="fg"><label class="lbl">Especialidad</label><input class="inp" id="svc-tech-specialty" placeholder="Celulares, laptops, TV…"></div><div class="fg"><label class="lbl">Comisión %</label><input class="inp" id="svc-tech-commission" type="number" min="0" max="100" value="0"></div></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button><button class="btn btn-dark" id="svc-tech-save">Guardar técnico</button></div>`);
  document.getElementById('svc-tech-save').onclick=async()=>{const res=await window.api.serviceOrders.saveTechnician({requestUserId:user?.id,data:{name:document.getElementById('svc-tech-name').value.trim(),phone:document.getElementById('svc-tech-phone').value.trim(),specialty:document.getElementById('svc-tech-specialty').value.trim(),commission_pct:Number(document.getElementById('svc-tech-commission').value)||0}});if(!res?.ok)return toast(res?.error,'err');toast('✓ Técnico guardado','ok');await svcLoadTechnicians();svcOpenTechnicians();};
}

async function svcOpenTechCatalog(){
  const res=await window.api.serviceOrders.techCatalog({requestUserId:user?.id});
  if(!res?.ok)return toast(res?.error||'No se pudo cargar el catálogo','err');
  const catalog=res.data||{models:[],compatibility:[]};
  const products=(DB.products||[]).filter(p=>p.active!==0);
  openModal(`<div class="modal-title">Catálogo tecnológico</div><div class="modal-sub">Modelos, variantes y repuestos compatibles. Esta relación evita vender o reservar una pieza para el equipo equivocado.</div>
    <div class="g2" style="margin-top:14px"><div class="card" style="padding:12px"><div class="tb">Registrar modelo o variante</div><div class="g2" style="margin-top:9px"><div class="fg"><label class="lbl">Tipo</label><select class="inp" id="svc-cat-type"><option>celular</option><option>tablet</option><option>laptop</option><option>consola</option><option>televisor</option><option>otro</option></select></div><div class="fg"><label class="lbl">Marca *</label><input class="inp" id="svc-cat-brand"></div></div><div class="g2"><div class="fg"><label class="lbl">Modelo *</label><input class="inp" id="svc-cat-model"></div><div class="fg"><label class="lbl">Código / variante</label><input class="inp" id="svc-cat-code" placeholder="A2890, SM-S928B, 256 GB…"></div></div><button class="btn btn-dark btn-fw" id="svc-cat-save">Guardar modelo</button></div>
    <div class="card" style="padding:12px"><div class="tb">Vincular repuesto</div><div class="fg" style="margin-top:9px"><label class="lbl">Producto del inventario *</label><select class="inp" id="svc-cat-product"><option value="">Seleccionar…</option>${products.map(p=>`<option value="${p.id}">${svcEsc(p.name)} · ${svcEsc(p.code||'')}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Equipo compatible *</label><select class="inp" id="svc-cat-device"><option value="">Seleccionar…</option>${catalog.models.map(m=>`<option value="${m.id}">${svcEsc(m.brand)} ${svcEsc(m.model)} ${svcEsc(m.model_code||'')}</option>`).join('')}</select></div><div class="g2"><div class="fg"><label class="lbl">Relación</label><select class="inp" id="svc-cat-relation"><option value="compatible">Compatible</option><option value="original">Original</option><option value="alternativo">Alternativo</option><option value="no_compatible">No compatible</option></select></div><div class="fg"><label class="lbl">Notas</label><input class="inp" id="svc-cat-notes" placeholder="Capacidad, color, revisión…"></div></div><button class="btn btn-dark btn-fw" id="svc-cat-link">Guardar compatibilidad</button></div></div>
    <div class="card" style="padding:12px;margin-top:12px"><div class="tb">Compatibilidades registradas</div><div class="tw" style="max-height:260px;margin-top:8px"><table><thead><tr><th>Repuesto</th><th>Equipo</th><th>Relación</th><th>Notas</th></tr></thead><tbody>${catalog.compatibility.map(c=>`<tr><td>${svcEsc(c.product_name)}<div class="ts">${svcEsc(c.product_code||'')}</div></td><td>${svcEsc(c.brand)} ${svcEsc(c.model)}<div class="ts">${svcEsc(c.model_code||'')}</div></td><td><span class="badge ${c.compatibility_type==='no_compatible'?'r':c.compatibility_type==='original'?'g':'b'}">${svcEsc(c.compatibility_type)}</span></td><td class="ts">${svcEsc(c.notes||'—')}</td></tr>`).join('')||'<tr><td colspan="4" class="ts" style="text-align:center;padding:16px">Todavía no hay relaciones registradas.</td></tr>'}</tbody></table></div></div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>`, 'modal-xl');
  document.getElementById('svc-cat-save').onclick=async()=>{const data={device_type:document.getElementById('svc-cat-type').value,brand:document.getElementById('svc-cat-brand').value.trim(),model:document.getElementById('svc-cat-model').value.trim(),model_code:document.getElementById('svc-cat-code').value.trim()};if(!data.brand||!data.model)return toast('Marca y modelo son obligatorios','w');const saved=await window.api.serviceOrders.saveDeviceModel({requestUserId:user?.id,data});if(!saved?.ok)return toast(saved?.error,'err');toast('✓ Modelo guardado','ok');svcOpenTechCatalog();};
  document.getElementById('svc-cat-link').onclick=async()=>{const data={product_id:Number(document.getElementById('svc-cat-product').value),device_model_id:Number(document.getElementById('svc-cat-device').value),compatibility_type:document.getElementById('svc-cat-relation').value,notes:document.getElementById('svc-cat-notes').value.trim()};if(!data.product_id||!data.device_model_id)return toast('Selecciona el repuesto y el equipo','w');const saved=await window.api.serviceOrders.saveCompatibility({requestUserId:user?.id,data});if(!saved?.ok)return toast(saved?.error,'err');toast('✓ Compatibilidad guardada','ok');svcOpenTechCatalog();};
}

async function svcOpenReport(){const res=await window.api.serviceOrders.report({requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');const r=res.data;openModal(`<div class="modal-title">Indicadores del taller</div><div class="metrics" style="grid-template-columns:repeat(4,1fr);margin:14px 0"><div class="metric"><div class="met-label">Abiertas</div><div class="met-val">${r.open}</div></div><div class="metric"><div class="met-label">Atrasadas</div><div class="met-val">${r.overdue}</div></div><div class="metric"><div class="met-label">Entregadas</div><div class="met-val">${r.delivered}</div></div><div class="metric"><div class="met-label">Días promedio</div><div class="met-val">${r.average_days}</div></div></div><div class="g2"><div class="card" style="padding:12px"><div class="tb">Por estado</div>${r.by_status.map(x=>`<div style="display:flex;justify-content:space-between;padding:5px 0"><span>${svcEsc(SVC_LABEL[x.status]||x.status)}</span><strong>${x.count}</strong></div>`).join('')}</div><div class="card" style="padding:12px"><div class="tb">Productividad por técnico</div>${r.by_technician.map(x=>`<div style="padding:7px 0;border-bottom:1px solid var(--line2)"><div style="display:flex;justify-content:space-between"><span>${svcEsc(x.technician)}</span><strong>${x.count} órdenes</strong></div><div class="ts" style="display:flex;justify-content:space-between;margin-top:3px"><span>${(Number(x.worked_minutes||0)/60).toFixed(2)} h trabajadas · Facturado ${fmt(x.billed)}</span><span>Comisión ${fmt(x.commission||0)}</span></div></div>`).join('')||'<div class="ts">Sin actividad asignada.</div>'}</div></div><div class="alrt b" style="margin-top:12px"><div class="alrt-dot b"></div><div class="alrt-sub">La comisión es una estimación basada en el porcentaje configurado del técnico y la facturación de sus órdenes. Confírmala antes de liquidar nómina.</div></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>`, 'modal-lg');}
