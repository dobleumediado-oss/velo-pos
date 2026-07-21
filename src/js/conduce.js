// ══════════════════════════════════════════════
// conduce.js — Conduces / Notas de Entrega
//   · Documento de entrega/despacho de mercancía.
//   · NO fiscal: sin NCF, sin ITBIS, sin CxC.
//   · NO mueve inventario por sí mismo (el stock sale en la factura).
//   · Estados: borrador → preparado → despachado → entregado/parcial → facturado
//     (+ anulado / devuelto). La UI solo muestra acciones válidas por estado.
// ══════════════════════════════════════════════

function _cndUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}
function _cndIsAdmin() {
  const u = _cndUser();
  return u && ['admin', 'superadmin'].includes(u.role);
}

const _CND_ST = {
  borrador:   { label: 'Borrador',   badge: '',  },
  preparado:  { label: 'Preparado',  badge: 'b', },
  despachado: { label: 'Despachado', badge: 'a', },
  parcial:    { label: 'Parcial',    badge: 'a', },
  entregado:  { label: 'Entregado',  badge: 'g', },
  facturado:  { label: 'Facturado',  badge: 'g', },
  anulado:    { label: 'Anulado',    badge: 'r', },
  devuelto:   { label: 'Devuelto',   badge: 'r', },
};
const _cndStLabel = s => (_CND_ST[s]?.label || s);
const _cndBadge   = s => `<span class="badge ${_CND_ST[s]?.badge || ''}">${_cndStLabel(s)}</span>`;

let _cndFilterStatus = '';
let _cndSearch       = '';
let _cndFormItems    = [];   // líneas del formulario en edición

// ── Render principal (listado) ────────────────
async function renderConduce(el) {
  el.innerHTML = window.experienceLoading?.('Preparando conduces…') || '<div class="empty"><p>Cargando conduces…</p></div>';
  if (!window.api?.conduce) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red,#ef4444)">Módulo de conduces no disponible. Reinicia la aplicación.</div>';
    return;
  }
  const res  = await window.api.conduce.getAll({});
  const list = res?.data || [];
  _cndRenderList(el, list);
}

function _cndRenderList(el, list) {
  el.innerHTML = '';

  // Header
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Conduces / Notas de Entrega'),
      h('div', { class: 'sec-sub' }, `${list.length} conduce${list.length !== 1 ? 's' : ''} · documento no fiscal`)
    ),
    h('div', { class: 'flex', style: { gap: '8px' } },
      h('button', { class: 'btn btn-out', onclick: () => _cndReports(), html: `${svg('chart')} Reportes` }),
      h('button', { class: 'btn btn-dark', onclick: () => _cndOpenForm(), html: `${svg('plus')} Nuevo conduce` })
    )
  ));

  // Métricas por estado
  const counts = {};
  list.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
  const metrics = h('div', { class: 'metrics metrics-five' });
  [
    { k: '',           l: 'Total',       v: list.length },
    { k: 'despachado', l: 'Despachados', v: counts.despachado || 0 },
    { k: 'entregado',  l: 'Entregados',  v: counts.entregado || 0 },
    { k: 'facturado',  l: 'Facturados',  v: counts.facturado || 0 },
    { k: 'anulado',    l: 'Anulados',    v: counts.anulado || 0 },
  ].forEach(m => {
    metrics.appendChild(h('div', {
      class: 'metric', style: { cursor: 'pointer', outline: _cndFilterStatus === m.k ? '2px solid var(--accent)' : 'none' },
      onclick: () => { _cndFilterStatus = m.k; renderConduce(document.getElementById('page')); }
    },
      h('div', { class: 'met-label' }, m.l),
      h('div', { class: 'met-val' }, String(m.v))
    ));
  });
  el.appendChild(metrics);

  // Búsqueda
  const bar = h('div', { class: 'flex', style: { marginBottom: '12px', gap: '8px' } });
  bar.appendChild(h('div', { class: 'inp-ic', style: { flex: '1' } },
    h('div', { class: 'ic' }, { html: svg('search') }),
    h('input', {
      class: 'inp', type: 'text', placeholder: 'Buscar por número o cliente...', value: _cndSearch,
      oninput: e => { _cndSearch = e.target.value; _cndRenderRows(); }
    })
  ));
  el.appendChild(bar);

  // Tabla
  const card = h('div', { class: 'card' });
  card.innerHTML = `
    <div class="tw">
      <table>
        <thead><tr>
          <th>Número</th><th>Cliente</th><th>Fecha</th><th>Origen</th>
          <th>Líneas</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody id="cnd-tbody"></tbody>
      </table>
    </div>`;
  el.appendChild(card);
  window.__cndList = list;
  _cndRenderRows();
}

function _cndRenderRows() {
  const tbody = document.getElementById('cnd-tbody');
  if (!tbody) return;
  const q = (_cndSearch || '').toLowerCase().trim();
  let rows = window.__cndList || [];
  if (_cndFilterStatus) rows = rows.filter(c => c.status === _cndFilterStatus);
  if (q) rows = rows.filter(c =>
    (c.number || '').toLowerCase().includes(q) || (c.customer_name || '').toLowerCase().includes(q));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:22px">Sin conduces</td></tr>`;
    return;
  }
  const origen = { manual: 'Manual', cotizacion: 'Cotización', factura: 'Factura' };
  tbody.innerHTML = rows.map(c => `
    <tr style="cursor:pointer" data-id="${c.id}">
      <td class="tm" style="font-weight:700">${c.number}</td>
      <td>${_cndEsc(c.customer_name || 'Consumidor Final')}</td>
      <td style="font-size:12px;color:var(--muted)">${fdate(c.issue_date)}</td>
      <td style="font-size:11px;color:var(--muted2)">${origen[c.source_type] || c.source_type}${c.source_id ? ' #' + c.source_id : ''}</td>
      <td style="text-align:center">${c.item_count || 0}</td>
      <td>${_cndBadge(c.status)}</td>
      <td style="text-align:right"><button class="btn btn-ghost btn-sm" data-view="${c.id}">${svg('eye')} Ver</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-id]').forEach(tr => {
    tr.addEventListener('click', () => _cndOpenDetail(Number(tr.dataset.id)));
  });
}

function _cndEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Detalle ───────────────────────────────────
async function _cndOpenDetail(id) {
  const res = await window.api.conduce.getById({ id });
  const dn  = res?.data;
  if (!dn) { toast('Conduce no encontrado', 'err'); return; }

  const itemsRows = (dn.items || []).map(it => `
    <tr>
      <td class="tm" style="font-size:11px">${_cndEsc(it.sku || '')}</td>
      <td>${_cndEsc(it.description)}</td>
      <td style="text-align:center">${it.requested_qty}</td>
      <td style="text-align:center">${it.delivered_qty || 0}</td>
      <td style="text-align:center;color:${it.pending_qty > 0 ? 'var(--amber)' : 'var(--muted2)'}">${it.pending_qty || 0}</td>
      <td style="text-align:center;font-size:11px;color:var(--muted2)">${_cndEsc(it.unit || 'und')}</td>
    </tr>`).join('');

  const facturadas = (dn.invoice_links || []).length;

  openModal(`
    <div class="fxb mb8">
      <div>
        <div class="modal-title">${dn.number} ${_cndBadge(dn.status)}</div>
        <div class="modal-sub">${_cndEsc(dn.customer_name)} · ${fdate(dn.issue_date)}</div>
      </div>
    </div>

    <div class="card" style="background:var(--surface2);margin-bottom:12px;font-size:12px">
      ${dn.customer_rnc ? `<div class="tr"><span>RNC/Céd.</span><span>${_cndEsc(dn.customer_rnc)}</span></div>` : ''}
      ${dn.delivery_address ? `<div class="tr"><span>Dirección</span><span>${_cndEsc(dn.delivery_address)}</span></div>` : ''}
      ${dn.driver_name ? `<div class="tr"><span>Chofer</span><span>${_cndEsc(dn.driver_name)}${dn.vehicle_plate ? ' · ' + _cndEsc(dn.vehicle_plate) : ''}</span></div>` : ''}
      ${dn.dispatch_date ? `<div class="tr"><span>Despachado</span><span>${dn.dispatch_date}</span></div>` : ''}
      ${dn.received_by_name ? `<div class="tr"><span>Recibió</span><span>${_cndEsc(dn.received_by_name)}${dn.received_by_document ? ' · ' + _cndEsc(dn.received_by_document) : ''}</span></div>` : ''}
      ${dn.invoice_id ? `<div class="tr"><span>Factura</span><span>#${dn.invoice_id}</span></div>` : ''}
      ${dn.status === 'anulado' ? `<div class="tr"><span style="color:var(--red)">Anulado</span><span>${_cndEsc(dn.cancellation_reason)}</span></div>` : ''}
      ${dn.notes ? `<div class="tr"><span>Notas</span><span>${_cndEsc(dn.notes)}</span></div>` : ''}
    </div>

    <div class="tw" style="max-height:34vh;overflow:auto;margin-bottom:12px">
      <table>
        <thead><tr><th>SKU</th><th>Descripción</th><th>Solic.</th><th>Entreg.</th><th>Pend.</th><th>Unid.</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
    </div>
    ${facturadas ? `<div style="font-size:11px;color:var(--muted2);margin-bottom:8px">Enlaces a factura: ${facturadas}</div>` : ''}

    <div class="modal-foot" style="flex-wrap:wrap;gap:6px" id="cnd-detail-actions"></div>
  `, 'modal-lg');

  _cndRenderActions(dn);
}

// Botones según estado (nunca se muestran acciones inválidas)
function _cndRenderActions(dn) {
  const box = document.getElementById('cnd-detail-actions');
  if (!box) return;
  const isAdmin = _cndIsAdmin();
  const btns = [];

  btns.push(`<button class="btn btn-out btn-sm" onclick="_cndPrint(${dn.id})">${svg('print')} Imprimir</button>`);
  btns.push(`<button class="btn btn-out btn-sm" onclick="_cndSavePDF(${dn.id})">${svg('pdf')} Guardar PDF</button>`);

  if (dn.status === 'borrador') {
    btns.push(`<button class="btn btn-out btn-sm" onclick="_cndOpenForm(${dn.id})">${svg('edit')} Editar</button>`);
    btns.push(`<button class="btn btn-dark btn-sm" onclick="_cndTransition(${dn.id},'preparado')">Preparar</button>`);
    btns.push(`<button class="btn btn-green btn-sm" onclick="_cndDispatch(${dn.id})">${svg('truck')} Despachar</button>`);
  }
  if (dn.status === 'preparado') {
    btns.push(`<button class="btn btn-green btn-sm" onclick="_cndDispatch(${dn.id})">${svg('truck')} Despachar</button>`);
  }
  if (dn.status === 'despachado' || dn.status === 'parcial') {
    btns.push(`<button class="btn btn-dark btn-sm" onclick="_cndDeliver(${dn.id})">${svg('check')} Confirmar entrega</button>`);
    btns.push(`<button class="btn btn-green btn-sm" onclick="_cndInvoice(${dn.id})">${svg('receipt')} Facturar</button>`);
  }
  if (dn.status === 'entregado') {
    btns.push(`<button class="btn btn-green btn-sm" onclick="_cndInvoice(${dn.id})">${svg('receipt')} Facturar</button>`);
  }
  // Anular: solo admin y si no está anulado/facturado
  if (isAdmin && !['anulado', 'facturado'].includes(dn.status)) {
    btns.push(`<button class="btn btn-red btn-sm" onclick="_cndCancel(${dn.id})">${svg('xmark')} Anular</button>`);
  }
  box.innerHTML = btns.join('');
}

// ── Acciones de estado ────────────────────────
async function _cndTransition(id, status, data = {}) {
  const u = _cndUser();
  const r = await window.api.conduce.setStatus({ id, status, data, requestUserId: u?.id });
  if (!r.ok) { toast(r.error || 'No se pudo cambiar el estado', 'err'); return; }
  toast(`✓ Conduce ${_cndStLabel(status)}`);
  closeModal();
  renderConduce(document.getElementById('page'));
}

function _cndDispatch(id) {
  openModal(`
    <div class="modal-title">Despachar conduce</div>
    <div class="modal-sub">La mercancía sale del almacén (documental).</div>
    <div class="fg"><label class="lbl">Chofer / Responsable</label><input class="inp" id="cnd-driver" placeholder="Nombre"/></div>
    <div class="fg"><label class="lbl">Placa / Vehículo</label><input class="inp" id="cnd-plate" placeholder="A123456"/></div>
    <div class="fg"><label class="lbl">Dirección de entrega</label><input class="inp" id="cnd-addr" placeholder="Opcional"/></div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="_cndDoDispatch(${id})">${svg('truck')} Despachar</button>
    </div>
  `);
}
async function _cndDoDispatch(id) {
  const data = {
    driver_name:      document.getElementById('cnd-driver')?.value?.trim() || '',
    vehicle_plate:    document.getElementById('cnd-plate')?.value?.trim() || '',
    delivery_address: document.getElementById('cnd-addr')?.value?.trim() || '',
  };
  await _cndTransition(id, 'despachado', data);
}

function _cndDeliver(id) {
  openModal(`
    <div class="modal-title">Confirmar entrega</div>
    <div class="modal-sub">Registra quién recibió la mercancía.</div>
    <div class="fg"><label class="lbl">Recibido por</label><input class="inp" id="cnd-rcv-name" placeholder="Nombre de quien recibe"/></div>
    <div class="fg"><label class="lbl">Cédula (opcional)</label><input class="inp" id="cnd-rcv-doc" placeholder="000-0000000-0"/></div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="_cndDoDeliver(${id})">${svg('check')} Confirmar</button>
    </div>
  `);
}
async function _cndDoDeliver(id) {
  const data = {
    received_by_name:     document.getElementById('cnd-rcv-name')?.value?.trim() || '',
    received_by_document: document.getElementById('cnd-rcv-doc')?.value?.trim() || '',
  };
  await _cndTransition(id, 'entregado', data);
}

function _cndCancel(id) {
  openModal(`
    <div class="modal-title" style="color:var(--red)">Anular conduce</div>
    <div class="modal-sub">Esta acción queda en auditoría. Requiere motivo.</div>
    <div class="fg"><label class="lbl">Motivo de anulación *</label>
      <textarea class="inp" id="cnd-cancel-reason" rows="3" placeholder="Explica por qué se anula"></textarea></div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-red" onclick="_cndDoCancel(${id})">${svg('xmark')} Anular</button>
    </div>
  `);
}
async function _cndDoCancel(id) {
  const reason = document.getElementById('cnd-cancel-reason')?.value?.trim() || '';
  if (!reason) { toast('Indica el motivo de anulación', 'err'); return; }
  const u = _cndUser();
  const r = await window.api.conduce.cancel({ id, reason, requestUserId: u?.id });
  if (!r.ok) { toast(r.error || 'No se pudo anular', 'err'); return; }
  toast('✓ Conduce anulado');
  closeModal();
  renderConduce(document.getElementById('page'));
}

// ── Facturar desde conduce ────────────────────
async function _cndInvoice(id) {
  const res = await window.api.conduce.invoiceable({ id });
  const lines = (res?.data || []).filter(l => l.invoiceable > 0);
  if (!lines.length) { toast('No hay cantidades pendientes por facturar', 'err'); return; }

  const rows = lines.map(l => `
    <tr>
      <td>${_cndEsc(l.description)}</td>
      <td style="text-align:center;color:var(--muted2)">${l.invoiceable}</td>
      <td style="text-align:center">
        <input class="inp" type="number" min="0" max="${l.invoiceable}" value="${l.invoiceable}"
               data-item="${l.id}" style="width:80px;text-align:center;padding:4px"/>
      </td>
    </tr>`).join('');

  openModal(`
    <div class="modal-title">Facturar conduce</div>
    <div class="modal-sub">Se creará una <strong>factura</strong> (descuenta inventario). Puedes ajustar cantidades para facturar parcialmente.</div>
    <div class="tw" style="max-height:34vh;overflow:auto;margin:10px 0">
      <table>
        <thead><tr><th>Descripción</th><th>Disponible</th><th>A facturar</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="fg"><label class="lbl">Método de pago</label>
      <select class="inp" id="cnd-inv-pay">
        <option value="efectivo">Efectivo</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="transferencia">Transferencia</option>
        <option value="credito">Crédito</option>
      </select>
    </div>
    <div class="fg"><label class="lbl">Precio</label>
      <select class="inp" id="cnd-inv-price">
        <option value="retail">Detalle</option>
        <option value="wholesale">Mayorista</option>
      </select>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="_cndDoInvoice(${id})">${svg('receipt')} Generar factura</button>
    </div>
  `, 'modal-lg');
}
async function _cndDoInvoice(id) {
  const lines = [...document.querySelectorAll('[data-item]')]
    .map(inp => ({ itemId: Number(inp.dataset.item), qty: parseFloat(inp.value) || 0 }))
    .filter(l => l.qty > 0);
  if (!lines.length) { toast('Indica al menos una cantidad a facturar', 'err'); return; }
  const u = _cndUser();
  const r = await window.api.conduce.invoice({
    id, lines,
    payment:   { method: document.getElementById('cnd-inv-pay')?.value || 'efectivo' },
    priceMode: document.getElementById('cnd-inv-price')?.value || 'retail',
    requestUserId: u?.id,
  });
  if (!r.ok) { toast(r.error || 'No se pudo facturar', 'err'); return; }
  toast(`✓ Factura #${r.saleId} generada${r.ncf ? ' · NCF ' + r.ncf : ''}`);
  closeModal();
  renderConduce(document.getElementById('page'));
}

// ── Formulario (crear / editar borrador) ──────
function _cndOpenForm(id = null) {
  _cndFormItems = [];
  const doRender = (dn) => {
    if (dn) {
      _cndFormItems = (dn.items || []).map(it => ({
        product_id: it.product_id, sku: it.sku, description: it.description,
        unit: it.unit, qty: it.requested_qty,
      }));
    }
    openModal(`
      <div class="modal-title">${dn ? 'Editar conduce ' + dn.number : 'Nuevo conduce'}</div>
      <div class="modal-sub">Documento de entrega — no fiscal.</div>
      <div class="g2">
        <div class="fg"><label class="lbl">Cliente</label>
          <input class="inp" id="cnd-f-name" list="cnd-cli-list" placeholder="Nombre del cliente"
                 value="${dn ? _cndEsc(dn.customer_name) : ''}" oninput="_cndFillCustomer(this.value)"/>
          <datalist id="cnd-cli-list">${(DB.customers || []).map(c => `<option value="${_cndEsc(c.name)}">`).join('')}</datalist>
        </div>
        <div class="fg"><label class="lbl">RNC / Cédula</label>
          <input class="inp" id="cnd-f-rnc" placeholder="Opcional" value="${dn ? _cndEsc(dn.customer_rnc || '') : ''}"/>
        </div>
      </div>
      <div class="fg"><label class="lbl">Dirección de entrega</label>
        <input class="inp" id="cnd-f-addr" placeholder="Opcional" value="${dn ? _cndEsc(dn.delivery_address || '') : ''}"/></div>
      <input type="hidden" id="cnd-f-cliid" value="${dn ? (dn.customer_id || '') : ''}"/>

      <div style="font-weight:700;font-size:12px;margin:10px 0 6px">Productos</div>
      <div style="position:relative;margin-bottom:8px">
        <div class="inp-ic">
          <div class="ic">${svg('search')}</div>
          <input class="inp" id="cnd-f-prod" autocomplete="off" placeholder="Buscar producto para agregar..."
                 oninput="_cndProdSearch(this.value)"
                 onblur="setTimeout(()=>{document.getElementById('cnd-prod-dd')?.classList.remove('show')},180)"/>
        </div>
        <div id="cnd-prod-dd" class="cli-dropdown"></div>
      </div>
      <div class="tw" style="max-height:26vh;overflow:auto;margin-bottom:8px">
        <table><thead><tr><th>Descripción</th><th style="width:90px">Cant.</th><th></th></tr></thead>
          <tbody id="cnd-items-body"></tbody></table>
      </div>

      <div class="fg"><label class="lbl">Notas</label>
        <textarea class="inp" id="cnd-f-notes" rows="2" placeholder="Observaciones">${dn ? _cndEsc(dn.notes || '') : ''}</textarea></div>

      <div class="modal-foot">
        <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-green" onclick="_cndSave(${dn ? dn.id : 'null'})">${svg('check')} ${dn ? 'Guardar cambios' : 'Guardar borrador'}</button>
      </div>
    `, 'modal-lg');
    _cndRenderFormItems();
  };

  if (id) {
    window.api.conduce.getById({ id }).then(r => doRender(r?.data));
  } else {
    doRender(null);
  }
}

function _cndFillCustomer(name) {
  const c = (DB.customers || []).find(x => x.name === name);
  if (c) {
    const rnc = document.getElementById('cnd-f-rnc');
    const addr = document.getElementById('cnd-f-addr');
    const cid = document.getElementById('cnd-f-cliid');
    if (cid) cid.value = c.id;
    if (rnc && !rnc.value) rnc.value = c.rnc || '';
    if (addr && !addr.value) addr.value = c.address || '';
  }
}

function _cndProdSearch(q) {
  const dd = document.getElementById('cnd-prod-dd');
  if (!dd) return;
  q = (q || '').toLowerCase().trim();
  if (!q) { dd.classList.remove('show'); dd.innerHTML = ''; return; }
  const matches = (DB.products || []).filter(p =>
    (p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)).slice(0, 8);
  dd.innerHTML = matches.map(p =>
    `<div class="cli-opt" onmousedown="_cndAddProduct(${p.id})">
       <div class="cli-opt-name">${_cndEsc(p.name)}</div>
       <div class="cli-opt-meta">${_cndEsc(p.code)} · stock ${p.stock}</div>
     </div>`).join('') || '<div class="cli-opt" style="color:var(--muted2)">Sin resultados</div>';
  dd.classList.add('show');
}
function _cndAddProduct(pid) {
  const p = (DB.products || []).find(x => x.id === pid);
  if (!p) return;
  const existing = _cndFormItems.find(i => i.product_id === pid);
  if (existing) existing.qty += 1;
  else _cndFormItems.push({ product_id: p.id, sku: p.code, description: p.name, unit: p.unit || 'und', qty: 1 });
  const inp = document.getElementById('cnd-f-prod'); if (inp) inp.value = '';
  const dd = document.getElementById('cnd-prod-dd'); if (dd) { dd.classList.remove('show'); dd.innerHTML = ''; }
  _cndRenderFormItems();
}
function _cndRenderFormItems() {
  const body = document.getElementById('cnd-items-body');
  if (!body) return;
  if (!_cndFormItems.length) {
    body.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--muted2);padding:14px">Agrega productos arriba</td></tr>`;
    return;
  }
  body.innerHTML = _cndFormItems.map((it, i) => `
    <tr>
      <td>${_cndEsc(it.description)}</td>
      <td><input class="inp" type="number" min="0" value="${it.qty}" data-i="${i}"
                 oninput="_cndSetQty(${i}, this.value)" style="width:80px;text-align:center;padding:4px"/></td>
      <td style="text-align:right"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="_cndDelItem(${i})">${svg('trash')}</button></td>
    </tr>`).join('');
}
function _cndSetQty(i, v) { if (_cndFormItems[i]) _cndFormItems[i].qty = parseFloat(v) || 0; }
function _cndDelItem(i) { _cndFormItems.splice(i, 1); _cndRenderFormItems(); }

async function _cndSave(id) {
  const items = _cndFormItems.filter(i => (i.qty || 0) > 0)
    .map(i => ({ product_id: i.product_id, product_code: i.sku, description: i.description, unit: i.unit, qty: i.qty }));
  if (!items.length) { toast('Agrega al menos un producto', 'err'); return; }
  const header = {
    customer_id:      Number(document.getElementById('cnd-f-cliid')?.value) || null,
    customer_name:    document.getElementById('cnd-f-name')?.value?.trim() || 'Consumidor Final',
    customer_rnc:     document.getElementById('cnd-f-rnc')?.value?.trim() || '',
    delivery_address: document.getElementById('cnd-f-addr')?.value?.trim() || '',
    notes:            document.getElementById('cnd-f-notes')?.value?.trim() || '',
  };
  const u = _cndUser();
  let r;
  if (id) r = await window.api.conduce.update({ id, header, items, requestUserId: u?.id });
  else    r = await window.api.conduce.create({ header, items, requestUserId: u?.id });
  if (!r.ok) { toast(r.error || 'No se pudo guardar', 'err'); return; }
  toast(id ? '✓ Conduce actualizado' : `✓ Conduce ${r.data?.number || ''} creado`);
  closeModal();
  renderConduce(document.getElementById('page'));
}

// ── Reportes de conduce ───────────────────────
async function _cndReports() {
  const res = await window.api.conduce.reports({});
  const r = res?.data;
  if (!r) { toast('No se pudieron cargar los reportes', 'err'); return; }

  const miniTable = (rows, cols) => rows.length
    ? `<div class="tw" style="max-height:150px;overflow:auto"><table><thead><tr>${cols.map(c => `<th>${c.h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row => `<tr>${cols.map(c => `<td style="${c.style || ''}">${c.f(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div style="color:var(--muted2);font-size:12px;padding:8px">Sin registros</div>`;

  const docCols = [
    { h: 'Número', f: x => `<strong>${_cndEsc(x.number)}</strong>`, style: 'font-family:var(--mono);font-size:11px' },
    { h: 'Cliente', f: x => _cndEsc(x.customer_name || '') },
    { h: 'Fecha', f: x => fdate(x.issue_date), style: 'font-size:11px;color:var(--muted)' },
    { h: 'Estado', f: x => _cndBadge(x.status) },
  ];

  const section = (title, count, body) => `
    <div style="font-weight:700;font-size:12px;margin:12px 0 6px">${title} ${count != null ? `<span style="color:var(--muted2)">(${count})</span>` : ''}</div>${body}`;

  openModal(`
    <div class="modal-title">${svg('chart')} Reportes de Conduce</div>
    <div class="modal-sub">Estados, pendientes, por vendedor/cliente y más despachados</div>

    <div class="metrics" style="grid-template-columns:repeat(4,1fr);margin:10px 0 4px">
      ${['despachado','entregado','facturado','anulado'].map(st => {
        const c = (r.byStatus.find(b => b.status === st) || {}).c || 0;
        return `<div class="metric"><div class="met-label">${_cndStLabel(st)}</div><div class="met-val">${c}</div></div>`;
      }).join('')}
    </div>

    ${section('Pendientes de facturar', r.pendientesFacturar.length, miniTable(r.pendientesFacturar, docCols))}
    ${section('Despachados no entregados', r.despachadosNoEntregados.length, miniTable(r.despachadosNoEntregados, docCols))}
    ${section('Entregados no facturados', r.entregadosNoFacturados.length, miniTable(r.entregadosNoFacturados, docCols))}
    ${section('Anulados', r.anulados.length, miniTable(r.anulados, docCols))}
    ${section('Por vendedor', null, miniTable(r.porVendedor, [
      { h: 'Vendedor', f: x => _cndEsc(x.vendedor) }, { h: 'Conduces', f: x => x.c, style: 'text-align:center' }]))}
    ${section('Por cliente', null, miniTable(r.porCliente, [
      { h: 'Cliente', f: x => _cndEsc(x.customer_name) }, { h: 'Conduces', f: x => x.c, style: 'text-align:center' }]))}
    ${section('Productos más despachados', null, miniTable(r.topProductos, [
      { h: 'Producto', f: x => _cndEsc(x.description) },
      { h: 'Cantidad', f: x => x.qty, style: 'text-align:center' },
      { h: 'Conduces', f: x => x.conduces, style: 'text-align:center' }]))}

    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>
  `, 'modal-lg');
}

// ── Impresión / Guardar PDF (usa el servicio central print.js) ──
function _cndDoc(id, save) {
  window.api.conduce.getById({ id }).then(r => {
    const dn = r?.data;
    if (!dn) { toast('Conduce no encontrado', 'err'); return; }
    const build = () => {
      if (typeof printConduceDoc === 'function') printConduceDoc(dn);
      else if (typeof printConduce === 'function') {
        printConduce({
          id: dn.number, date: dn.issue_date, cajero: '', customer_name: dn.customer_name,
          customer_rnc: dn.customer_rnc, items: (dn.items || []).map(it => ({ name: it.description, qty: it.requested_qty })),
        });
      }
    };
    if (save && typeof guardarDocumentoPDF === 'function') {
      guardarDocumentoPDF(build, `Conduce-${dn.number}`);
    } else {
      build();
    }
  });
}
function _cndPrint(id)   { _cndDoc(id, false); }
function _cndSavePDF(id) { _cndDoc(id, true);  }
