'use strict';

// ════════════════════════════════════════════════════════════════════════════
// VELO TECH POS · Servicio / reparación (R6)
// recepción → diagnóstico → presupuesto → aprobado → reparando → listo → entrega
// ════════════════════════════════════════════════════════════════════════════

let svcOrders = [];
let svcStatus = '';
let svcSearch = '';

const SVC_FLOW = ['recepcion','diagnostico','presupuesto','aprobado','reparando','listo','entregado'];
const SVC_LABEL = {
  recepcion:'Recepción', diagnostico:'Diagnóstico', presupuesto:'Presupuesto',
  aprobado:'Aprobado', reparando:'Reparando', listo:'Listo', entregado:'Entregado', cancelado:'Cancelado',
};
const svcEsc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function svcBadge(status) {
  const tone = status === 'entregado' ? 'g' : status === 'cancelado' ? 'r'
    : status === 'listo' ? 'b' : ['aprobado','reparando'].includes(status) ? 'a' : 'n';
  return `<span class="badge ${tone}">${svcEsc(SVC_LABEL[status] || status)}</span>`;
}
async function renderServicio(el) {
  if (!window._vertical?.modules?.service_orders) {
    el.innerHTML = '<div class="empty"><p>Servicio técnico no está habilitado en este producto.</p></div>';
    return;
  }
  el.innerHTML = `
    <div class="sec-hdr">
      <div><div class="sec-title">Servicio técnico</div><div class="sec-sub">Recepción, diagnóstico, reparación y entrega facturada</div></div>
      <button class="btn btn-dark" id="svc-new">${svg('plus')} Nueva orden</button>
    </div>
    <div class="metrics" id="svc-metrics" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px"></div>
    <div class="flex" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <div class="inp-ic" style="flex:1;min-width:240px"><div class="ic">${svg('search')}</div>
        <input class="inp" id="svc-search" placeholder="Orden, cliente, equipo o IMEI" value="${svcEsc(svcSearch)}">
      </div>
      <select class="inp" id="svc-status" style="width:180px">
        <option value="">Todos los estados</option>
        ${[...SVC_FLOW,'cancelado'].map(s => `<option value="${s}" ${svcStatus===s?'selected':''}>${SVC_LABEL[s]}</option>`).join('')}
      </select>
    </div>
    <div id="svc-list"><div class="empty"><p>Cargando órdenes…</p></div></div>`;
  document.getElementById('svc-new').onclick = svcOpenNew;
  let timer;
  document.getElementById('svc-search').oninput = e => {
    svcSearch = e.target.value;
    clearTimeout(timer); timer = setTimeout(svcLoad, 180);
  };
  document.getElementById('svc-status').onchange = e => { svcStatus = e.target.value; svcLoad(); };
  await svcLoad();
}

async function svcLoad() {
  const list = document.getElementById('svc-list');
  if (!list) return;
  const res = await window.api.serviceOrders.list({ status:svcStatus, search:svcSearch, requestUserId:user?.id });
  if (!res?.ok) { list.innerHTML = `<div class="alrt r"><div class="alrt-dot r"></div><div>${svcEsc(res?.error || 'No se pudieron cargar las órdenes')}</div></div>`; return; }
  svcOrders = res.data || [];
  const counts = {
    abiertas: svcOrders.filter(o => !['entregado','cancelado'].includes(o.status)).length,
    diagnostico: svcOrders.filter(o => ['recepcion','diagnostico','presupuesto'].includes(o.status)).length,
    taller: svcOrders.filter(o => ['aprobado','reparando'].includes(o.status)).length,
    listo: svcOrders.filter(o => o.status === 'listo').length,
  };
  const metrics = document.getElementById('svc-metrics');
  if (metrics) metrics.innerHTML = [
    ['settings','b','Órdenes abiertas',counts.abiertas], ['search','n','Por diagnosticar',counts.diagnostico],
    ['pkg','a','En reparación',counts.taller], ['check','g','Listos para entregar',counts.listo],
  ].map(([icon,tone,label,val]) => `<div class="metric"><div class="met-top"><div class="met-icon ${tone}">${svg(icon)}</div></div><div class="met-label">${label}</div><div class="met-val">${val}</div></div>`).join('');
  if (!svcOrders.length) {
    list.innerHTML = `<div class="empty"><div>${svg('settings')}</div><p>Sin órdenes en esta vista</p><span>Crea una recepción para comenzar.</span></div>`;
    return;
  }
  list.innerHTML = `<div class="card"><div class="tw"><table><thead><tr><th>Orden</th><th>Cliente / equipo</th><th>IMEI</th><th>Problema</th><th>Estado</th><th>Total</th><th></th></tr></thead><tbody>
    ${svcOrders.map(o => `<tr>
      <td><div class="tb">${svcEsc(o.number)}</div><div class="ts">${fdate(String(o.created_at||'').slice(0,10))}</div></td>
      <td><div class="tb">${svcEsc(o.customer_name)}</div><div class="ts">${svcEsc(o.device_desc)}</div></td>
      <td class="tm" style="font-size:11px">${svcEsc(o.imei || '—')}</td>
      <td style="max-width:260px"><div class="ts">${svcEsc(o.problem)}</div></td>
      <td>${svcBadge(o.status)}</td><td class="tb">${fmt(o.items_total || o.quote_amount || 0)}</td>
      <td><button class="btn btn-ghost btn-sm" data-svc-open="${o.id}">${svg('edit')} Abrir</button></td>
    </tr>`).join('')}
  </tbody></table></div></div>`;
  list.querySelectorAll('[data-svc-open]').forEach(b => b.onclick = () => svcOpen(Number(b.dataset.svcOpen)));
}

function svcOpenNew() {
  const customers = (DB.customers || []).filter(c => c.active !== 0);
  openModal(`
    <div class="modal-title">Nueva orden de servicio</div>
    <div class="modal-sub">Registra exactamente cómo se recibe el equipo.</div>
    <div class="g2" style="margin-top:14px">
      <div class="fg"><label class="lbl">Cliente *</label><select class="inp" id="svc-customer">${customers.map(c => `<option value="${c.id}">${svcEsc(c.name)}</option>`).join('')}</select></div>
      <div class="fg"><label class="lbl">Equipo *</label><input class="inp" id="svc-device" placeholder="iPhone 13 Pro, Galaxy S23…" data-uppercase="off"></div>
    </div>
    <div class="fg"><label class="lbl">IMEI / Serial</label><input class="inp" id="svc-imei" placeholder="Opcional al recibir" data-uppercase="off"></div>
    <div class="fg"><label class="lbl">Problema reportado *</label><textarea class="inp" id="svc-problem" rows="3" placeholder="Pantalla rota, no carga, se apaga…"></textarea></div>
    <div class="fg"><label class="lbl">Notas de recepción</label><textarea class="inp" id="svc-notes" rows="2" placeholder="Estado físico, accesorios recibidos…"></textarea></div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-dark" id="svc-create">${svg('check')} Crear recepción</button></div>`);
  document.getElementById('svc-create').onclick = async e => {
    e.currentTarget.disabled = true;
    const res = await window.api.serviceOrders.create({ requestUserId:user?.id, data:{
      customer_id:Number(document.getElementById('svc-customer').value),
      device_desc:document.getElementById('svc-device').value.trim(), imei:document.getElementById('svc-imei').value.trim(),
      problem:document.getElementById('svc-problem').value.trim(), notes:document.getElementById('svc-notes').value.trim(),
    }});
    if (!res?.ok) { toast(res?.error || 'No se pudo crear', 'err'); e.currentTarget.disabled=false; return; }
    closeModal(); toast(`✓ ${res.data.number} recibida`, 'ok'); await svcLoad(); svcOpen(res.data.id);
  };
}

async function svcOpen(id) {
  const res = await window.api.serviceOrders.getById({ id, requestUserId:user?.id });
  if (!res?.ok || !res.data) { toast(res?.error || 'Orden no encontrada', 'err'); return; }
  svcRenderDetail(res.data);
}

function svcRenderDetail(order) {
  let items = (order.items || []).map(i => ({...i}));
  const editable = !['entregado','cancelado'].includes(order.status);
  const products = (DB.products || []).filter(p => p.active !== 0 && !p.serialized);
  const itemsHtml = () => items.length ? items.map((i,idx) => `<tr><td>${i.kind==='parte'?'Pieza':'Mano de obra'}</td><td>${svcEsc(i.description)}</td><td>${i.qty}</td><td>${fmt(i.unit_price)}</td><td>${fmt(i.qty*i.unit_price)}</td>${editable?`<td><button class="btn btn-ghost btn-sm" data-svc-rm="${idx}" style="color:var(--red)">${svg('trash')}</button></td>`:''}</tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--muted2);padding:14px">Sin partidas</td></tr>`;
  const next = SVC_FLOW[SVC_FLOW.indexOf(order.status)+1];
  openModal(`
    <div style="display:flex;justify-content:space-between;gap:12px"><div><div class="modal-title">${svcEsc(order.number)}</div><div class="modal-sub">${svcEsc(order.customer_name)} · ${svcEsc(order.device_desc)}${order.imei?` · ${svcEsc(order.imei)}`:''}</div></div>${svcBadge(order.status)}</div>
    <div class="alrt" style="margin:12px 0"><div class="alrt-dot"></div><div><div class="alrt-title">Problema reportado</div><div class="alrt-sub">${svcEsc(order.problem)}</div></div></div>
    <div class="g2">
      <div class="fg"><label class="lbl">Diagnóstico</label><textarea class="inp" id="svc-diagnosis" rows="3" ${editable?'':'disabled'}>${svcEsc(order.diagnosis||'')}</textarea></div>
      <div><div class="fg"><label class="lbl">Presupuesto (RD$)</label><input class="inp" id="svc-quote" type="number" min="0" value="${Number(order.quote_amount)||0}" ${editable?'':'disabled'}></div><div class="fg"><label class="lbl">Notas</label><input class="inp" id="svc-detail-notes" value="${svcEsc(order.notes||'')}" ${editable?'':'disabled'}></div></div>
    </div>
    ${editable?`<div style="font-weight:700;font-size:12px;margin:10px 0 7px">Agregar al presupuesto</div>
      <div style="display:grid;grid-template-columns:1.5fr .6fr .7fr auto;gap:7px;margin-bottom:7px"><select class="inp" id="svc-part-product"><option value="">Seleccionar pieza…</option>${products.map(p=>`<option value="${p.id}">${svcEsc(p.name)} · ${fmt(p.price)}</option>`).join('')}</select><input class="inp" id="svc-part-qty" type="number" min="1" value="1"><input class="inp" id="svc-part-price" type="number" min="0" placeholder="Precio"><button class="btn btn-out" id="svc-add-part">+ Pieza</button></div>
      <div style="display:grid;grid-template-columns:1.5fr .6fr .7fr auto;gap:7px;margin-bottom:10px"><input class="inp" id="svc-labor-desc" placeholder="Mano de obra / servicio"><input class="inp" id="svc-labor-qty" type="number" min="1" value="1"><input class="inp" id="svc-labor-price" type="number" min="0" placeholder="Precio"><button class="btn btn-out" id="svc-add-labor">+ Labor</button></div>`:''}
    <div class="tw" style="max-height:220px"><table><thead><tr><th>Tipo</th><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Total</th><th></th></tr></thead><tbody id="svc-items-body">${itemsHtml()}</tbody></table></div>
    ${order.sale_id?`<div class="alrt g" style="margin-top:12px"><div class="alrt-dot g"></div><div><div class="alrt-title">Entregado y facturado</div><div class="alrt-sub">Venta ${svcEsc(order.sale?.document_number_fmt || order.sale?.numero_factura_fmt || '#'+order.sale_id)}</div></div></div>`:''}
    <div class="modal-foot" style="justify-content:space-between"><div>${editable?`<button class="btn btn-ghost" id="svc-cancel" style="color:var(--red)">Cancelar orden</button>`:''}</div><div class="flex" style="gap:8px"><button class="btn btn-out" onclick="closeModal()">Cerrar</button>${editable?`<button class="btn btn-out" id="svc-save">Guardar</button>${order.status==='listo'?`<button class="btn btn-dark" id="svc-deliver">Entregar y facturar</button>`:(next?`<button class="btn btn-dark" id="svc-next">Pasar a ${svcEsc(SVC_LABEL[next])}</button>`:'')}`:''}</div></div>
  `, 'modal-lg');

  const rerenderItems = () => {
    document.getElementById('svc-items-body').innerHTML = itemsHtml();
    document.querySelectorAll('[data-svc-rm]').forEach(b => b.onclick = () => { items.splice(Number(b.dataset.svcRm),1); rerenderItems(); });
    const total = items.reduce((a,i)=>a+(Number(i.qty)||0)*(Number(i.unit_price)||0),0);
    document.getElementById('svc-quote').value = total.toFixed(2);
  };
  if (editable) {
    document.getElementById('svc-add-part').onclick = () => {
      const pid=Number(document.getElementById('svc-part-product').value); const p=products.find(x=>Number(x.id)===pid);
      if (!p) { toast('Selecciona una pieza', 'w'); return; }
      items.push({kind:'parte',product_id:p.id,description:p.name,qty:Math.max(1,Number(document.getElementById('svc-part-qty').value)||1),unit_price:Math.max(0,Number(document.getElementById('svc-part-price').value)||Number(p.price)||0),taxable:p.taxable,tax_pct:p.tax_pct}); rerenderItems();
    };
    document.getElementById('svc-add-labor').onclick = () => {
      const desc=document.getElementById('svc-labor-desc').value.trim(); if(!desc){toast('Describe la mano de obra','w');return;}
      items.push({kind:'mano_obra',description:desc,qty:Math.max(1,Number(document.getElementById('svc-labor-qty').value)||1),unit_price:Math.max(0,Number(document.getElementById('svc-labor-price').value)||0),taxable:1,tax_pct:Number(CFG.itbis)||18}); rerenderItems();
    };
    const save = async () => {
      const r=await window.api.serviceOrders.update({id:order.id,requestUserId:user?.id,data:{diagnosis:document.getElementById('svc-diagnosis').value.trim(),quote_amount:Number(document.getElementById('svc-quote').value)||0,notes:document.getElementById('svc-detail-notes').value.trim(),items}});
      if(!r?.ok){toast(r?.error||'No se pudo guardar','err');return null;} order=r.data; return r.data;
    };
    document.getElementById('svc-save').onclick=async()=>{const o=await save();if(o){toast('✓ Orden guardada','ok');await svcLoad();svcRenderDetail(o);}};
    if (next && order.status!=='listo') document.getElementById('svc-next').onclick=async()=>{const saved=await save();if(!saved)return;const r=await window.api.serviceOrders.advance({id:order.id,status:next,requestUserId:user?.id});if(!r?.ok){toast(r?.error||'No se pudo avanzar','err');return;}toast(`✓ Estado: ${SVC_LABEL[next]}`,'ok');await svcLoad();svcRenderDetail(r.data);};
    if (order.status==='listo') document.getElementById('svc-deliver').onclick=()=>svcOpenDelivery(order.id,save);
    document.getElementById('svc-cancel').onclick=()=>{const reason=prompt('Motivo de cancelación:');if(reason==null)return;window.api.serviceOrders.cancel({id:order.id,reason,requestUserId:user?.id}).then(async r=>{if(!r?.ok){toast(r?.error||'No se pudo cancelar','err');return;}toast('Orden cancelada','ok');closeModal();await svcLoad();});};
  }
}

function svcOpenDelivery(id, save) {
  openModal(`<div class="modal-title">Entregar y facturar</div><div class="modal-sub">Se creará una venta normal con piezas y mano de obra.</div><div class="fg" style="margin-top:14px"><label class="lbl">Forma de pago</label><select class="inp" id="svc-pay"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option><option value="credito">Crédito</option></select></div><div class="fg"><label class="lbl">Comprobante fiscal</label><select class="inp" id="svc-ncf"><option value="">Sin NCF</option><option value="B02">B02 · Consumo</option><option value="B01">B01 · Crédito fiscal</option></select></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Volver</button><button class="btn btn-dark" id="svc-confirm-delivery">${svg('check')} Confirmar entrega</button></div>`);
  document.getElementById('svc-confirm-delivery').onclick=async e=>{e.currentTarget.disabled=true;const saved=await save();if(!saved){e.currentTarget.disabled=false;return;}const r=await window.api.serviceOrders.deliver({id,requestUserId:user?.id,payment:{method:document.getElementById('svc-pay').value,ncfType:document.getElementById('svc-ncf').value}});if(!r?.ok){toast(r?.error||'No se pudo entregar','err');e.currentTarget.disabled=false;return;}closeModal();toast(`✓ ${r.data.number} entregada y facturada`,'ok');await reloadProducts();await svcLoad();svcRenderDetail(r.data);};
}
