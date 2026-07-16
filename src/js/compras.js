// ══════════════════════════════════════════════
// COMPRAS — Órdenes de compra y proveedores
// ══════════════════════════════════════════════

// ── Estado ────────────────────────────────────
let comprasTab   = 'ordenes'; // 'ordenes' | 'proveedores'
let comprasRange = 'all';
let newPOItems   = [];        // items de la orden en construcción

// ── Render principal ──────────────────────────
async function renderCompras(el) {
  el.innerHTML = '';

  // Header
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Compras'),
      h('div', { class: 'sec-sub' }, 'Órdenes de compra y proveedores')
    ),
    h('button', {
      class: 'btn btn-dark btn-sm',
      onclick: () => comprasTab === 'ordenes' ? abrirNuevaOrden() : abrirFormProveedor(null),
      html: comprasTab === 'ordenes'
        ? `${svg('plus')} Nueva orden`
        : `${svg('plus')} Nuevo proveedor`
    })
  ));

  // Tabs
  const tabs = h('div', { class: 'tabs', style: { marginBottom: '16px' } });
  [
    { v: 'ordenes',     l: 'Órdenes de compra' },
    { v: 'proveedores', l: 'Proveedores' },
  ].forEach(o => {
    tabs.appendChild(h('button', {
      class: `tab ${comprasTab === o.v ? 'on' : ''}`,
      onclick: async () => {
        comprasTab = o.v;
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
        event.currentTarget.classList.add('on');
        await renderComprasContenido(el);
      }
    }, o.l));
  });
  el.appendChild(tabs);

  await renderComprasContenido(el);
}

async function renderComprasContenido(el) {
  // Remover contenido previo (mantener header y tabs)
  Array.from(el.children).slice(2).forEach(c => c.remove());

  if (comprasTab === 'ordenes') {
    await renderOrdenes(el);
  } else {
    await renderProveedores(el);
  }
}

// ══════════════════════════════════════════════
// ÓRDENES DE COMPRA
// ══════════════════════════════════════════════
async function renderOrdenes(el) {
  const result = await window.api.purchases.getAll({ range: comprasRange });
  if (!result.ok) {
    el.appendChild(h('div', { class: 'alrt r' },
      h('div', { class: 'alrt-dot r' }),
      h('div', null, h('div', { class: 'alrt-title' }, result.error))
    ));
    return;
  }

  const orders = result.data || [];

  // Stats rápidas
  const pending  = orders.filter(o => o.status === 'pendiente').length;
  const partial  = orders.filter(o => o.status === 'parcial').length;
  const received = orders.filter(o => o.status === 'recibido').length;
  const totalAmt = orders.reduce((s, o) => s + (o.total || 0), 0);

  const stats = h('div', { class: 'metrics',
    style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '18px' } });
  [
    { icon: 'clock',   color: 'a', label: 'Pendientes',     val: pending },
    { icon: 'alert',   color: 'b', label: 'Parciales',      val: partial },
    { icon: 'check',   color: 'g', label: 'Recibidas',      val: received },
    { icon: 'dollar',  color: 'p', label: 'Total comprado', val: fmt(totalAmt) },
  ].forEach(({ icon, color, label, val }) => {
    stats.appendChild(
      h('div', { class: 'metric' },
        h('div', { class: 'met-top' },
          h('div', { class: `met-icon ${color}`, html: svg(icon) })
        ),
        h('div', { class: 'met-label' }, label),
        h('div', { class: 'met-val' }, String(val))
      )
    );
  });
  el.appendChild(stats);

  if (!orders.length) {
    el.appendChild(h('div', { class: 'empty-state' },
      h('div', { style: { fontSize: '32px', marginBottom: '8px' } }, '📦'),
      h('div', { class: 'empty-title' }, 'Sin órdenes de compra'),
      h('div', { class: 'empty-sub' }, 'Crea tu primera orden para registrar compras a proveedores')
    ));
    return;
  }

  // Tabla de órdenes
  const card = h('div', { class: 'card' });
  const tbl  = h('table', { class: 'tbl' });
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>#OC</th><th>Proveedor</th><th>Fecha</th>
        <th>Items</th><th>Total</th><th>Estado</th><th></th>
      </tr>
    </thead>`;
  const tbody = h('tbody');
  orders.forEach(o => {
    const statusColor = {
      pendiente: 'a', recibido: 'g', parcial: 'b', cancelado: 'r'
    }[o.status] || 'a';
    const tr = h('tr', { style: { cursor: 'pointer' }, onclick: () => verOrden(o.id) });
    tr.innerHTML = `
      <td><b>OC-${String(o.id).padStart(4,'0')}</b></td>
      <td>${o.supplier_name || o.supplier_name_join || 'Sin proveedor'}</td>
      <td>${fdate((o.created_at||'').slice(0,10))}</td>
      <td>${o.items_count || '—'}</td>
      <td><b>${fmt(o.total)}</b></td>
      <td><span class="badge ${statusColor}">${o.status}</span></td>
      <td>
        ${o.status === 'pendiente' || o.status === 'parcial'
          ? `<button class="btn btn-sm btn-out" onclick="event.stopPropagation();recibirOrden(${o.id})">
               ${svg('download')} Recibir
             </button>`
          : ''}
      </td>`;
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  el.appendChild(card);
}

// ── Ver detalle de orden ──────────────────────
async function verOrden(id) {
  const result = await window.api.purchases.getById({ id });
  if (!result.ok || !result.data) { toast('Error al cargar orden', 'err'); return; }
  const po = result.data;

  const statusColor = { pendiente: 'a', recibido: 'g', parcial: 'b', cancelado: 'r' }[po.status] || 'a';

  const totalExtra = (po.freight_cost || 0) + (po.customs_cost || 0)
    + (po.transport_cost || 0) + (po.other_cost || 0);
  const itemsHtml = (po.items || []).map(i => `
    <tr>
      <td>${i.product_code || '—'}</td>
      <td>${i.product_name}</td>
      <td>${fmt(i.unit_cost)}</td>
      <td>${i.landed_unit_cost ? fmt(i.landed_unit_cost) : '—'}</td>
      <td>${i.allocated_extra_cost ? fmt(i.allocated_extra_cost) : '—'}</td>
      <td>${i.qty_ordered}</td>
      <td>${i.qty_received}</td>
      <td>${fmt(i.subtotal)}</td>
    </tr>`).join('');

  openModal(`
    <div class="fxb mb8">
      <div>
        <div class="modal-title">OC-${String(po.id).padStart(4,'0')}</div>
        <div class="modal-sub">${po.supplier_name || 'Sin proveedor'} · ${fdate((po.created_at||'').slice(0,10))}</div>
      </div>
      <span class="badge ${statusColor}" style="font-size:13px">${po.status}</span>
    </div>

    <table class="tbl" style="margin-bottom:12px">
      <thead><tr><th>Código</th><th>Producto</th><th>Costo base</th><th>Costo real</th><th>Gastos</th><th>Ordenado</th><th>Recibido</th><th>Subtotal</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    ${totalExtra > 0 ? `
      <div class="tr"><span>Gastos aplicados a mercancía</span><span>${fmt(totalExtra)}</span></div>
    ` : ''}
    <div class="tr grand"><span>Total</span><span>${fmt(po.total)}</span></div>
    ${po.notes ? `<div style="font-size:12px;color:var(--muted2);margin-top:8px">Nota: ${po.notes}</div>` : ''}

    <div class="modal-foot">
      ${po.status !== 'cancelado' && po.status !== 'recibido'
        ? `<button class="btn btn-out" onclick="cancelarOrden(${po.id})">Cancelar OC</button>`
        : ''}
      ${po.status === 'pendiente' || po.status === 'parcial'
        ? `<button class="btn btn-dark" onclick="closeModal();recibirOrden(${po.id})">${svg('download')} Recibir mercancía</button>`
        : `<button class="btn btn-out" onclick="closeModal()">Cerrar</button>`}
    </div>
  `, 'modal-xl');
}

// ── Nueva orden de compra ─────────────────────
async function abrirNuevaOrden() {
  newPOItems = [];
  const suppResult = await window.api.suppliers.getAll();
  const suppliers  = suppResult.ok ? (suppResult.data || []) : [];

  const suppOpts = suppliers.map(s =>
    `<option value="${s.id}">${s.name}</option>`
  ).join('');

  openModal(`
    <div class="modal-title">Nueva orden de compra</div>

    <div class="g2" style="margin-bottom:12px">
      <div class="fg">
        <label class="lbl">Proveedor</label>
        <select class="inp" id="po-supplier">
          <option value="">— Sin proveedor —</option>
          ${suppOpts}
        </select>
      </div>
      <div class="fg">
        <label class="lbl">Notas</label>
        <input class="inp" id="po-notes" type="text" placeholder="Observaciones opcionales"/>
      </div>
    </div>

    <div class="fg" style="margin-bottom:12px">
      <label class="lbl">Agregar producto</label>
      <div style="display:flex;gap:8px">
        <input class="inp" id="po-prod-search" type="text"
               placeholder="Buscar por nombre o código..."
               oninput="buscarProductoPO(this.value)"
               style="flex:1"/>
        <input class="inp" id="po-prod-qty" type="number" min="1" value="1"
               placeholder="Cant." style="width:80px"/>
        <input class="inp" id="po-prod-cost" type="number" min="0" step="0.01"
               placeholder="Costo" style="width:100px"/>
        <button class="btn btn-dark btn-sm" onclick="agregarItemPO()">
          ${svg('plus')} Agregar
        </button>
      </div>
      <div id="po-prod-dd" style="display:none;background:var(--surface);border:1px solid var(--line);
           border-radius:var(--r-sm);margin-top:4px;max-height:150px;overflow-y:auto"></div>
    </div>

    <div id="po-items-list" style="margin-bottom:12px"></div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="guardarOrdenCompra()">
        ${svg('check')} Crear orden
      </button>
    </div>
  `, 'modal-xl');

  renderPOItemsList();
}

function buscarProductoPO(q) {
  const dd = document.getElementById('po-prod-dd');
  if (!q || q.length < 2) { dd.style.display = 'none'; return; }

  const qNorm = searchNorm(q);
  const matches = DB.products.filter(p =>
    p.active !== 0 && (
      matchText(p.name, qNorm) ||
      matchText(p.code, qNorm) ||
      matchText(p.barcode, qNorm) ||
      matchText(p.model, qNorm)
    )
  ).slice(0, 8);

  if (!matches.length) { dd.style.display = 'none'; return; }

  dd.innerHTML = matches.map(p => `
    <div class="cli-opt" onclick="seleccionarProductoPO(${p.id})">
      <div class="cli-opt-name">${p.name}</div>
      <div class="cli-opt-meta">${p.code} · Costo actual: ${fmt(p.cost)}</div>
    </div>`).join('');
  dd.style.display = 'block';
}

function seleccionarProductoPO(id) {
  const prod = DB.products.find(p => p.id === id);
  if (!prod) return;
  document.getElementById('po-prod-search').value = prod.name;
  document.getElementById('po-prod-search').dataset.pid = id;
  document.getElementById('po-prod-cost').value  = prod.cost || 0;
  document.getElementById('po-prod-dd').style.display = 'none';
}

function agregarItemPO() {
  const search = document.getElementById('po-prod-search');
  let   pid    = parseInt(search?.dataset?.pid);
  const qty    = parseInt(document.getElementById('po-prod-qty')?.value) || 1;
  const cost   = parseFloat(document.getElementById('po-prod-cost')?.value) || 0;

  // Si no hay pid pero hay texto, buscar por nombre o código exacto
  if (!pid && search?.value?.trim()) {
    const q    = search.value.trim().toLowerCase();
    const prod = DB.products.find(p =>
      p.active !== 0 && (
        p.name?.toLowerCase() === q ||
        p.code?.toLowerCase() === q ||
        p.name?.toLowerCase().includes(q)
      )
    );
    if (prod) {
      pid = prod.id;
      search.dataset.pid = prod.id;
      if (!document.getElementById('po-prod-cost')?.value) {
        document.getElementById('po-prod-cost').value = prod.cost || 0;
      }
    }
  }

  if (!pid) { toast('Selecciona un producto de la lista', 'err'); return; }
  if (qty <= 0) { toast('La cantidad debe ser mayor a 0', 'err'); return; }
  if (cost <= 0) { toast('El costo debe ser mayor a 0', 'err'); return; }

  const prod = DB.products.find(p => p.id === pid);
  if (!prod) return;

  // Si ya está en la lista, actualizar cantidad
  const existing = newPOItems.find(i => i.product_id === pid);
  if (existing) {
    existing.qty_ordered += qty;
    existing.subtotal = existing.unit_cost * existing.qty_ordered;
  } else {
    newPOItems.push({
      product_id:   pid,
      product_code: prod.code,
      product_name: prod.name,
      unit_cost:    cost,
      qty_ordered:  qty,
      subtotal:     cost * qty,
    });
  }

  // Limpiar campos
  search.value = '';
  delete search.dataset.pid;
  document.getElementById('po-prod-qty').value  = 1;
  document.getElementById('po-prod-cost').value = '';
  renderPOItemsList();
}

function renderPOItemsList() {
  const el = document.getElementById('po-items-list');
  if (!el) return;
  if (!newPOItems.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--muted2);padding:12px;font-size:13px">
      Agrega productos a la orden</div>`;
    return;
  }

  const total = newPOItems.reduce((s, i) => s + i.subtotal, 0);
  el.innerHTML = `
    <table class="tbl">
      <thead><tr><th>Producto</th><th>Costo</th><th>Cant.</th><th>Subtotal</th><th></th></tr></thead>
      <tbody>
        ${newPOItems.map((i, idx) => `
          <tr>
            <td>${i.product_name}<br><span style="font-size:11px;color:var(--muted2)">${i.product_code}</span></td>
            <td>${fmt(i.unit_cost)}</td>
            <td>${i.qty_ordered}</td>
            <td>${fmt(i.subtotal)}</td>
            <td><button class="btn btn-sm" style="color:var(--red)"
                onclick="quitarItemPO(${idx})">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="tr grand" style="margin-top:8px">
      <span>Total orden</span><span>${fmt(total)}</span>
    </div>`;
}

function quitarItemPO(idx) {
  newPOItems.splice(idx, 1);
  renderPOItemsList();
}

async function guardarOrdenCompra() {
  if (!newPOItems.length) { toast('Agrega al menos un producto', 'err'); return; }

  const supplierEl = document.getElementById('po-supplier');
  const suppId     = parseInt(supplierEl?.value) || null;
  const suppName   = supplierEl?.options[supplierEl.selectedIndex]?.text || '';
  const notes      = document.getElementById('po-notes')?.value?.trim() || '';

  const result = await window.api.purchases.create({
    supplierId:   suppId,
    supplierName: suppId ? suppName : (suppName === '— Sin proveedor —' ? '' : suppName),
    items:        newPOItems,
    notes,
    userId:       user.id,
    cajero:       user.name,
  });

  if (!result.ok) { toast(result.error || 'Error al crear orden', 'err'); return; }

  closeModal();
  toast(`✓ OC-${String(result.poId).padStart(4,'0')} creada`, 'ok');
  renderCompras(document.getElementById('page'));
}

// ── Recibir mercancía ─────────────────────────
async function recibirOrden(id) {
  const result = await window.api.purchases.getById({ id });
  if (!result.ok || !result.data) { toast('Error al cargar orden', 'err'); return; }
  const po = result.data;
  window._recepcionPO = po;

  const itemsHtml = (po.items || [])
    .filter(i => i.qty_received < i.qty_ordered)
    .map(i => `
      <tr>
        <td>${i.product_name}<br>
            <span style="font-size:11px;color:var(--muted2)">${i.product_code}</span></td>
        <td style="text-align:center">${i.qty_ordered}</td>
        <td style="text-align:center">${i.qty_received}</td>
        <td style="text-align:center">
          <input class="inp recv-qty" type="number" min="0"
                 max="${i.qty_ordered - i.qty_received}"
                 value="${i.qty_ordered - i.qty_received}"
                 id="recv-${i.id}" data-item-id="${i.id}"
                 oninput="actualizarCostosRecepcion()"
                 style="width:70px;text-align:center"/>
        </td>
        <td style="text-align:center;font-size:11px;color:var(--muted2)" id="cost-preview-${i.id}">
          ${(() => {
            const prod      = DB.products.find(p => p.id === i.product_id);
            const stockAct  = prod ? prod.stock : 0;
            const costoAct  = prod ? prod.cost  : 0;
            const qtyRecib  = i.qty_ordered - i.qty_received;
            const total     = stockAct + qtyRecib;
            const promedio  = total > 0 && i.unit_cost > 0
              ? Math.round(((stockAct * costoAct) + (qtyRecib * i.unit_cost)) / total * 100) / 100
              : i.unit_cost;
            const color = promedio > costoAct ? '#d97706' : promedio < costoAct ? '#16a34a' : '#6b7280';
            return '<div>Actual: ' + fmt(costoAct) + '</div>'
              + '<div>Nuevo: ' + fmt(i.unit_cost) + '</div>'
              + '<div style="font-weight:700;color:' + color + '">Prom: ' + fmt(promedio) + '</div>';
          })()}
        </td>
      </tr>`).join('');

  openModal(`
    <div class="modal-title">Recibir mercancía</div>
    <div class="modal-sub">OC-${String(id).padStart(4,'0')} · ${po.supplier_name || 'Sin proveedor'}</div>

    <div style="display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;margin:12px 0">
      <div class="fg">
        <label class="lbl">Flete</label>
        <input class="inp recv-extra-cost" id="recv-freight" type="number" min="0" step="0.01" value="0"
               oninput="actualizarCostosRecepcion()"/>
      </div>
      <div class="fg">
        <label class="lbl">Aduana</label>
        <input class="inp recv-extra-cost" id="recv-customs" type="number" min="0" step="0.01" value="0"
               oninput="actualizarCostosRecepcion()"/>
      </div>
      <div class="fg">
        <label class="lbl">Transporte</label>
        <input class="inp recv-extra-cost" id="recv-transport" type="number" min="0" step="0.01" value="0"
               oninput="actualizarCostosRecepcion()"/>
      </div>
      <div class="fg">
        <label class="lbl">Otros gastos</label>
        <input class="inp recv-extra-cost" id="recv-other" type="number" min="0" step="0.01" value="0"
               oninput="actualizarCostosRecepcion()"/>
      </div>
    </div>
    <div id="recv-cost-summary" class="alrt b" style="margin-bottom:12px"></div>

    <table class="tbl" style="margin:12px 0">
      <thead>
        <tr><th>Producto</th><th>Ordenado</th><th>Ya recibido</th><th>Recibir ahora</th><th>Costo real estimado</th></tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="alrt b" style="margin-bottom:12px">
      <div class="alrt-dot b"></div>
      <div class="alrt-sub">Al confirmar, el stock de cada producto se actualiza automáticamente.</div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="confirmarRecepcion(${id})">
        ${svg('check')} Confirmar recepción
      </button>
    </div>
  `, 'modal-xl');
  actualizarCostosRecepcion();
}

function _recvNum(id) {
  return Math.max(0, parseFloat(document.getElementById(id)?.value || '0') || 0);
}

function calcularCostosRecepcion(po) {
  const pending = (po?.items || []).filter(i => i.qty_received < i.qty_ordered);
  const rows = pending.map(i => {
    const qty = Math.max(0, parseInt(document.getElementById(`recv-${i.id}`)?.value || '0', 10) || 0);
    const baseLine = Math.round(((i.unit_cost || 0) * qty) * 100) / 100;
    return { item: i, qty, baseLine };
  }).filter(r => r.qty > 0);

  const costs = {
    freight: _recvNum('recv-freight'),
    customs: _recvNum('recv-customs'),
    transport: _recvNum('recv-transport'),
    other: _recvNum('recv-other'),
  };
  const extraTotal = Math.round((costs.freight + costs.customs + costs.transport + costs.other) * 100) / 100;
  const baseTotal = Math.round(rows.reduce((s, r) => s + r.baseLine, 0) * 100) / 100;
  let assigned = 0;
  rows.forEach((r, idx) => {
    let extra = 0;
    if (extraTotal > 0 && baseTotal > 0) {
      extra = idx === rows.length - 1
        ? Math.round((extraTotal - assigned) * 100) / 100
        : Math.round((extraTotal * (r.baseLine / baseTotal)) * 100) / 100;
      assigned = Math.round((assigned + extra) * 100) / 100;
    }
    r.allocatedExtra = extra;
    r.landedLine = Math.round((r.baseLine + extra) * 100) / 100;
    r.landedUnit = r.qty > 0 ? Math.round((r.landedLine / r.qty) * 100) / 100 : (r.item.unit_cost || 0);
  });
  return { rows, costs, extraTotal, baseTotal, landedTotal: Math.round((baseTotal + extraTotal) * 100) / 100 };
}

function actualizarCostosRecepcion() {
  const po = window._recepcionPO;
  if (!po) return;
  const calc = calcularCostosRecepcion(po);
  const byId = new Map(calc.rows.map(r => [String(r.item.id), r]));
  (po.items || []).forEach(i => {
    const el = document.getElementById(`cost-preview-${i.id}`);
    if (!el) return;
    const row = byId.get(String(i.id));
    const prod = DB.products.find(p => p.id === i.product_id);
    const stockAct = prod ? prod.stock : 0;
    const costoAct = prod ? prod.cost : 0;
    const qtyRecib = row?.qty || 0;
    const unitReal = row?.landedUnit || i.unit_cost || 0;
    const total = stockAct + qtyRecib;
    const promedio = total > 0 && unitReal > 0
      ? Math.round(((stockAct * costoAct) + (qtyRecib * unitReal)) / total * 100) / 100
      : unitReal;
    const color = promedio > costoAct ? '#d97706' : promedio < costoAct ? '#16a34a' : '#6b7280';
    el.innerHTML = '<div>Actual: ' + fmt(costoAct) + '</div>'
      + '<div>Base: ' + fmt(i.unit_cost || 0) + '</div>'
      + '<div>Gastos línea: ' + fmt(row?.allocatedExtra || 0) + '</div>'
      + '<div>Real unit.: ' + fmt(unitReal) + '</div>'
      + '<div style="font-weight:700;color:' + color + '">Prom: ' + fmt(promedio) + '</div>';
  });

  const summary = document.getElementById('recv-cost-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="alrt-dot b"></div>
      <div>
        <div style="font-weight:700;font-size:12px">Costo real de la recepción: ${fmt(calc.landedTotal)}</div>
        <div class="alrt-sub">Mercancía: ${fmt(calc.baseTotal)} · Gastos distribuidos: ${fmt(calc.extraTotal)} · Se reparte proporcional al valor de cada línea.</div>
      </div>`;
  }
}

async function confirmarRecepcion(poId) {
  const result = await window.api.purchases.getById({ id: poId });
  if (!result.ok) return;
  const po = result.data;

  const items = (po.items || [])
    .filter(i => i.qty_received < i.qty_ordered)
    .map(i => ({
      id:           i.id,
      product_id:   i.product_id,
      qty_received: parseInt(document.getElementById(`recv-${i.id}`)?.value) || 0,
      unit_cost:    i.unit_cost,
    }))
    .filter(i => i.qty_received > 0);

  if (!items.length) { toast('Ingresa al menos una cantidad', 'err'); return; }

  const costs = {
    freight: _recvNum('recv-freight'),
    customs: _recvNum('recv-customs'),
    transport: _recvNum('recv-transport'),
    other: _recvNum('recv-other'),
  };
  const recvResult = await window.api.purchases.receive({ id: poId, items, userId: user.id, costs });
  if (!recvResult.ok) { toast(recvResult.error || 'Error al recibir', 'err'); return; }

  await reloadProducts();
  closeModal();
  const extraMsg = recvResult.landedCost ? ` · Gastos: ${fmt(recvResult.landedCost)}` : '';
  toast(`✓ Mercancía recibida${extraMsg} — OC ${recvResult.status === 'recibido' ? 'completada' : 'parcial'}`, 'ok');
  renderCompras(document.getElementById('page'));
}

async function cancelarOrden(id) {
  const r = await window.api.purchases.cancel({ id, userId: user.id });
  if (!r.ok) { toast(r.error || 'Error', 'err'); return; }
  closeModal();
  toast('Orden cancelada');
  renderCompras(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// PROVEEDORES
// ══════════════════════════════════════════════
async function renderProveedores(el) {
  const result = await window.api.suppliers.getAll();
  if (!result.ok) { toast(result.error, 'err'); return; }
  const suppliers = result.data || [];

  if (!suppliers.length) {
    el.appendChild(h('div', { class: 'empty-state' },
      h('div', { style: { fontSize: '32px', marginBottom: '8px' } }, '📦'),
      h('div', { class: 'empty-title' }, 'Sin proveedores'),
      h('div', { class: 'empty-sub' }, 'Registra tus proveedores para asociarlos a las órdenes de compra')
    ));
    return;
  }

  const card = h('div', { class: 'card' });
  const tbl  = h('table', { class: 'tbl' });
  tbl.innerHTML = `
    <thead>
      <tr><th>Nombre</th><th>Contacto</th><th>Teléfono</th><th>RNC</th><th></th></tr>
    </thead>`;
  const tbody = h('tbody');
  suppliers.forEach(s => {
    const tr = h('tr');
    tr.innerHTML = `
      <td><b>${s.name}</b>${s.email ? `<br><span style="font-size:11px;color:var(--muted2)">${s.email}</span>` : ''}</td>
      <td>${s.contact || '—'}</td>
      <td>${s.phone || '—'}</td>
      <td>${s.rnc || '—'}</td>
      <td style="text-align:right">
        <button class="btn btn-sm btn-out" onclick="abrirFormProveedor(${s.id})">
          ${svg('edit')} Editar
        </button>
      </td>`;
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  el.appendChild(card);
}

async function abrirFormProveedor(id) {
  let s = { name:'', contact:'', phone:'', email:'', rnc:'', address:'', notes:'' };
  if (id) {
    const r = await window.api.suppliers.getAll();
    if (r.ok) s = r.data.find(x => x.id === id) || s;
  }

  openModal(`
    <div class="modal-title">${id ? 'Editar proveedor' : 'Nuevo proveedor'}</div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Nombre *</label>
        <input class="inp" id="sp-name" type="text" value="${s.name}" placeholder="Distribuidora XYZ"/>
      </div>
      <div class="fg">
        <label class="lbl">Contacto</label>
        <input class="inp" id="sp-contact" type="text" value="${s.contact||''}" placeholder="Nombre del vendedor"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Teléfono</label>
        <input class="inp" id="sp-phone" type="text" value="${s.phone||''}" placeholder="809-000-0000"/>
      </div>
      <div class="fg">
        <label class="lbl">Email</label>
        <input class="inp" id="sp-email" type="email" value="${s.email||''}" placeholder="ventas@proveedor.com"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">RNC</label>
        <input class="inp" id="sp-rnc" type="text" value="${s.rnc||''}" placeholder="000-00000-0"/>
      </div>
      <div class="fg">
        <label class="lbl">Dirección</label>
        <input class="inp" id="sp-address" type="text" value="${s.address||''}" placeholder="Ciudad, Provincia"/>
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Notas</label>
      <input class="inp" id="sp-notes" type="text" value="${s.notes||''}" placeholder="Observaciones..."/>
    </div>

    <div class="modal-foot">
      ${id ? `<button class="btn btn-out" onclick="eliminarProveedor(${id})">Eliminar</button>` : ''}
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="guardarProveedor(${id || 'null'})">
        ${svg('check')} Guardar
      </button>
    </div>
  `);
}

async function guardarProveedor(id) {
  const name = document.getElementById('sp-name')?.value?.trim();
  if (!name) { toast('El nombre es requerido', 'err'); return; }

  const data = {
    name,
    contact: document.getElementById('sp-contact')?.value?.trim() || '',
    phone:   document.getElementById('sp-phone')?.value?.trim()   || '',
    email:   document.getElementById('sp-email')?.value?.trim()   || '',
    rnc:     document.getElementById('sp-rnc')?.value?.trim()     || '',
    address: document.getElementById('sp-address')?.value?.trim() || '',
    notes:   document.getElementById('sp-notes')?.value?.trim()   || '',
  };

  let result;
  if (id) {
    result = await window.api.suppliers.update({ id, data, requestUserId: user.id });
  } else {
    result = await window.api.suppliers.create({ data, requestUserId: user.id });
  }

  if (!result.ok) { toast(result.error || 'Error al guardar', 'err'); return; }

  closeModal();
  toast(id ? '✓ Proveedor actualizado' : '✓ Proveedor registrado', 'ok');
  renderCompras(document.getElementById('page'));
}

async function eliminarProveedor(id) {
  const result = await window.api.suppliers.delete({ id, requestUserId: user.id });
  if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
  closeModal();
  toast('Proveedor eliminado');
  renderCompras(document.getElementById('page'));
}
