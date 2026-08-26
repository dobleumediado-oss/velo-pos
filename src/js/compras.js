// ══════════════════════════════════════════════
// COMPRAS — Órdenes de compra y proveedores
// ══════════════════════════════════════════════

// ── Estado ────────────────────────────────────
let comprasTab   = 'ordenes'; // 'ordenes' | 'proveedores' | 'particulares' (TECH)
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
      onclick: () => comprasTab === 'ordenes' ? abrirNuevaOrden()
        : comprasTab === 'particulares' ? abrirCompraParticular() : abrirFormProveedor(null),
      html: comprasTab === 'ordenes' ? `${svg('plus')} Nueva orden`
        : comprasTab === 'particulares' ? `${svg('plus')} Comprar equipo usado`
        : `${svg('plus')} Nuevo proveedor`
    })
  ));

  // Tabs
  const tabs = h('div', { class: 'tabs', style: { marginBottom: '16px' } });
  [
    { v: 'ordenes',     l: 'Órdenes de compra' },
    { v: 'proveedores', l: 'Proveedores' },
    ...((window._vertical?.id==='tech')?[{v:'particulares',l:'Equipos comprados a personas'}]:[]),
  ].forEach(o => {
    tabs.appendChild(h('button', {
      class: `tab ${comprasTab === o.v ? 'on' : ''}`,
      onclick: async () => {
        comprasTab = o.v;
        // Volver a dibujar también el encabezado: su botón principal cambia de
        // acción según la pestaña (OC, proveedor o compra de equipo usado).
        await renderCompras(el);
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
  } else if (comprasTab === 'proveedores') {
    await renderProveedores(el);
  } else {
    await renderComprasParticulares(el);
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
  `, 'modal-xxl mtw');
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
    .map(i => {
      const product = DB.products.find(p => p.id === i.product_id);
      const serialized = Number(product?.serialized) === 1;
      const remaining = i.qty_ordered - i.qty_received;
      return `
      <tr>
        <td>${i.product_name}<br>
            <span style="font-size:11px;color:var(--muted2)">${i.product_code}</span>
            ${serialized ? `
              <div class="alrt b" style="margin-top:8px;padding:8px;display:block">
                <b style="font-size:11px">Equipos por IMEI/serial</b>
                <textarea class="inp recv-units" id="recv-units-${i.id}" rows="4"
                  placeholder="Pega o escanea uno por línea…"
                  oninput="actualizarRecepcionSerializada(${i.id},${remaining})"
                  style="margin-top:6px;width:100%;font-family:monospace;font-size:12px"></textarea>
                <div id="recv-units-count-${i.id}" style="font-size:11px;margin-top:4px;color:var(--muted2)">
                  0 de ${remaining} equipos
                </div>
              </div>` : ''}
        </td>
        <td style="text-align:center">${i.qty_ordered}</td>
        <td style="text-align:center">${i.qty_received}</td>
        <td style="text-align:center">
          <input class="inp recv-qty" type="number" min="0"
                 max="${remaining}"
                 value="${serialized ? 0 : remaining}"
                 id="recv-${i.id}" data-item-id="${i.id}"
                 oninput="actualizarCostosRecepcion()"
                 ${serialized ? 'readonly title="La cantidad se calcula con los IMEI/seriales ingresados"' : ''}
                 style="width:70px;text-align:center"/>
        </td>
        <td style="text-align:center;font-size:11px;color:var(--muted2)" id="cost-preview-${i.id}">
          ${(() => {
            const prod      = DB.products.find(p => p.id === i.product_id);
            const stockAct  = prod ? Number(prod.effective_stock ?? prod.stock) : 0;
            const costoAct  = prod ? prod.cost  : 0;
            const qtyRecib  = serialized ? 0 : remaining;
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
      </tr>`;
    }).join('');

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
      <div class="alrt-sub">Los productos normales actualizan su cantidad. Los equipos serializados se cuentan exclusivamente por sus IMEI/seriales para evitar inventario fantasma.</div>
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

function _parseReceiptUnits(itemId) {
  const value = String(document.getElementById(`recv-units-${itemId}`)?.value || '');
  return value.split(/[\n,;]+/).map(value => value.trim()).filter(Boolean).map(value => {
    const parts = value.split('|').map(part => part.trim());
    const identifier = parts[0] || '';
    const isImei = /^\d{14,16}$/.test(identifier.replace(/[\s-]/g, ''));
    return {
      imei:isImei ? identifier.replace(/[\s-]/g, '') : '',
      serial:isImei ? (parts[1] || '') : identifier.replace(/^SERIAL\s*:\s*/i, ''),
      color:parts[2] || '', capacity:parts[3] || '', condition:parts[4] || 'nuevo',
      grade:parts[5] || '', battery_health:parts[6] || null,
      supplier_warranty_until:parts[7] || null,
    };
  });
}

function actualizarRecepcionSerializada(itemId, maxUnits) {
  const units = _parseReceiptUnits(itemId);
  const quantity = document.getElementById(`recv-${itemId}`);
  const count = document.getElementById(`recv-units-count-${itemId}`);
  if (quantity) quantity.value = String(Math.min(units.length, maxUnits));
  if (count) {
    count.textContent = `${units.length} de ${maxUnits} equipos${units.length > maxUnits ? ' · elimina los sobrantes' : ''}`;
    count.style.color = units.length > maxUnits ? 'var(--red)' : (units.length === maxUnits ? 'var(--green)' : 'var(--muted2)');
  }
  actualizarCostosRecepcion();
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
    const stockAct = prod ? Number(prod.effective_stock ?? prod.stock) : 0;
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
      units: Number(DB.products.find(p => p.id === i.product_id)?.serialized) === 1
        ? _parseReceiptUnits(i.id) : [],
    }))
    .filter(i => i.qty_received > 0);

  if (!items.length) { toast('Ingresa al menos una cantidad', 'err'); return; }
  for (const item of items) {
    const product = DB.products.find(p => p.id === item.product_id);
    if (Number(product?.serialized) === 1 && item.units.length !== item.qty_received) {
      toast(`${product.name}: revisa la cantidad de IMEI/seriales`, 'err');
      return;
    }
  }

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

// ══════════════════════════════════════════════
// VELO TECH POS · Compra documentada a particulares
// ══════════════════════════════════════════════
const techPurchaseEsc=value=>String(value==null?'':value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));

async function renderComprasParticulares(el){
  const res=await window.api.techPrivatePurchases.list({requestUserId:user?.id});
  if(!res?.ok){el.appendChild(h('div',{class:'alrt r'},res?.error||'No se pudieron cargar las compras'));return;}
  const rows=res.data||[];
  const total=rows.filter(row=>row.status==='completada').reduce((sum,row)=>sum+Number(row.amount||0),0);
  const summary=h('div',{class:'metrics',style:{gridTemplateColumns:'repeat(3,1fr)',marginBottom:'18px'}});
  summary.innerHTML=`<div class="metric"><div class="met-label">Equipos adquiridos</div><div class="met-val">${rows.length}</div></div><div class="metric"><div class="met-label">En inventario</div><div class="met-val">${rows.filter(row=>row.unit_status==='en_stock').length}</div></div><div class="metric"><div class="met-label">Valor comprado</div><div class="met-val">${fmt(total)}</div></div>`;
  el.appendChild(summary);
  if(['admin','superadmin'].includes(user?.role))el.appendChild(h('div',{class:'flex',style:{justifyContent:'flex-end',marginBottom:'10px'}},h('button',{class:'btn btn-out btn-sm',onclick:abrirConfigCompraParticular},'Términos y garantía')));
  if(!rows.length){el.appendChild(h('div',{class:'empty-state'},h('div',{style:{fontSize:'32px'}},'📱'),h('div',{class:'empty-title'},'Sin equipos comprados a particulares'),h('div',{class:'empty-sub'},'Registra la identidad, procedencia, estado, pago y firmas en una sola operación.')));return;}
  const card=h('div',{class:'card'});card.innerHTML=`<div class="tw"><table><thead><tr><th>Documento</th><th>Vendedor</th><th>Equipo / IMEI</th><th>Compra</th><th>Inventario</th><th></th></tr></thead><tbody>${rows.map(row=>`<tr><td><b>${techPurchaseEsc(row.number)}</b><div class="ts">${fdate(String(row.created_at||'').slice(0,10))}</div></td><td>${techPurchaseEsc(row.seller_name)}<div class="ts">${techPurchaseEsc(row.seller_document)}</div></td><td>${techPurchaseEsc(row.product_name)}<div class="ts">${techPurchaseEsc(row.imei||row.serial)}</div></td><td><b>${fmt(row.amount)}</b><div class="ts">${techPurchaseEsc(row.payment_method)}</div></td><td><span class="badge ${row.unit_status==='en_stock'?'g':'n'}">${techPurchaseEsc(row.unit_status)}</span></td><td><button class="btn btn-ghost btn-sm" data-private-purchase="${row.id}">${svg('eye')} Abrir</button></td></tr>`).join('')}</tbody></table></div>`;
  card.querySelectorAll('[data-private-purchase]').forEach(button=>button.onclick=()=>verCompraParticular(Number(button.dataset.privatePurchase)));
  el.appendChild(card);
}

async function abrirCompraParticular(){
  const [configRes,accountsRes]=await Promise.all([window.api.techPrivatePurchases.getConfig({requestUserId:user?.id}),window.api.financial.getAll()]);
  if(!configRes?.ok)return toast(configRes?.error||'No se pudo preparar el contrato','err');
  const products=(DB.products||[]).filter(product=>product.active!==0&&product.serialized);
  if(!products.length)return toast('Primero registra el modelo como producto controlado por IMEI/serial','w');
  const descriptions=configRes.data.descriptions||[],accounts=(accountsRes?.data||[]).filter(account=>account.active&&account.type==='banco');
  openModal(`<div class="modal-title">Compra de equipo usado a una persona</div><div class="modal-sub">La operación crea el equipo en inventario y conserva las declaraciones y términos firmados.</div><div class="tb" style="margin:14px 0 8px">1. Identidad del vendedor</div><div class="g3"><div class="fg"><label class="lbl">Nombre completo *</label><input class="inp" id="tpp-name"></div><div class="fg"><label class="lbl">Cédula / pasaporte *</label><input class="inp" id="tpp-document" data-uppercase="off"></div><div class="fg"><label class="lbl">Teléfono *</label><input class="inp" id="tpp-phone" data-uppercase="off"></div></div><div class="g2"><div class="fg"><label class="lbl">Dirección *</label><input class="inp" id="tpp-address"></div><div class="fg"><label class="lbl">Correo</label><input class="inp no-uppercase" id="tpp-email" data-uppercase="off" type="email"></div></div><div class="tb" style="margin:12px 0 8px">2. Equipo y evaluación</div><div class="g2"><div class="fg"><label class="lbl">Producto / modelo *</label><select class="inp" id="tpp-product">${products.map(product=>`<option value="${product.id}">${techPurchaseEsc(product.name)} · ${techPurchaseEsc(product.code)}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Nombre del equipo</label><input class="inp" id="tpp-device" placeholder="IPHONE 13 128GB"></div></div><div class="g3"><div class="fg"><label class="lbl">IMEI *</label><input class="inp" id="tpp-imei" data-uppercase="off"></div><div class="fg"><label class="lbl">Serial</label><input class="inp" id="tpp-serial" data-uppercase="off"></div><div class="fg"><label class="lbl">Color</label><input class="inp" id="tpp-color"></div></div><div class="g3"><div class="fg"><label class="lbl">Capacidad</label><input class="inp" id="tpp-capacity" placeholder="128GB"></div><div class="fg"><label class="lbl">Condición batería (%)</label><input class="inp" id="tpp-health" type="number" min="0" max="100"></div><div class="fg"><label class="lbl">Capacidad batería (mAh)</label><input class="inp" id="tpp-mah" type="number" min="0" max="100000"></div></div><div class="fg"><label class="lbl">Condición física y pruebas *</label><textarea class="inp" id="tpp-condition" rows="2" placeholder="PANTALLA, CARCASA, CÁMARAS, CARGA, BLOQUEOS, HUMEDAD..."></textarea></div><div class="fg"><label class="lbl">Descripción que saldrá en la factura al venderlo</label><input class="inp" id="tpp-description" list="tpp-description-list"><datalist id="tpp-description-list">${descriptions.map(row=>`<option value="${techPurchaseEsc(row.description)}">${techPurchaseEsc(row.name)}</option>`).join('')}</datalist></div><div class="tb" style="margin:12px 0 8px">3. Pago y firmas</div><div class="g3"><div class="fg"><label class="lbl">Precio de compra *</label><input class="inp" id="tpp-amount" type="number" min="0.01" step="0.01"></div><div class="fg"><label class="lbl">Forma de pago</label><select class="inp" id="tpp-method"><option value="efectivo">Efectivo desde caja</option><option value="transferencia">Transferencia</option><option value="cheque">Cheque</option></select></div><div class="fg" id="tpp-account-wrap" style="display:none"><label class="lbl">Cuenta bancaria</label><select class="inp" id="tpp-account"><option value="">Seleccionar…</option>${accounts.map(account=>`<option value="${account.id}">${techPurchaseEsc(account.name)} · ${techPurchaseEsc(account.currency)}</option>`).join('')}</select></div></div><div class="fg"><label class="lbl">Referencia del pago</label><input class="inp" id="tpp-reference"></div><div class="g2"><div class="fg"><label class="lbl">Nombre que firma como vendedor *</label><input class="inp" id="tpp-seller-sign"></div><div class="fg"><label class="lbl">Encargado del negocio que firma *</label><input class="inp" id="tpp-business-sign" value="${techPurchaseEsc(user?.name||'')}"></div></div><label style="display:flex;gap:8px;margin:8px 0"><input type="checkbox" id="tpp-owner"> El vendedor declara que es propietario legítimo del equipo.</label><label style="display:flex;gap:8px;margin:8px 0"><input type="checkbox" id="tpp-origin"> El vendedor declara que el equipo tiene procedencia lícita y no está reportado, bloqueado, financiado ni reclamado por terceros.</label><details style="margin-top:10px"><summary class="tb">Ver términos que quedarán congelados en este contrato</summary><div class="ts" style="white-space:pre-wrap;padding:10px">${techPurchaseEsc(configRes.data.terms)}</div></details><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-dark" id="tpp-save">Registrar compra y equipo</button></div>`,'modal-xl');
  document.getElementById('tpp-method').onchange=event=>document.getElementById('tpp-account-wrap').style.display=event.target.value==='efectivo'?'none':'block';
  const descriptionField=document.getElementById('tpp-description')?.closest('.fg');
  descriptionField?.insertAdjacentHTML('beforebegin',`<div class="fg"><label class="lbl">Accesorios entregados</label><div style="display:flex;gap:14px;flex-wrap:wrap;padding:9px;border:1px solid var(--line);border-radius:8px"><label><input type="checkbox" class="tpp-accessory" value="CARGADOR"> Cargador</label><label><input type="checkbox" class="tpp-accessory" value="CABLE"> Cable</label><label><input type="checkbox" class="tpp-accessory" value="CAJA"> Caja</label><label><input type="checkbox" class="tpp-accessory" value="FUNDA"> Funda</label><input class="inp" id="tpp-accessory-other" placeholder="OTRO ACCESORIO" style="min-width:180px;flex:1"></div></div>`);
  document.getElementById('tpp-save').onclick=async event=>{
    event.currentTarget.disabled=true;
    const product=products.find(row=>Number(row.id)===Number(document.getElementById('tpp-product').value));
    const accessories=[...document.querySelectorAll('.tpp-accessory:checked')].map(input=>input.value);
    const otherAccessory=document.getElementById('tpp-accessory-other')?.value?.trim();
    if(otherAccessory)accessories.push(otherAccessory);
    const data={seller_name:document.getElementById('tpp-name').value,seller_document:document.getElementById('tpp-document').value,seller_phone:document.getElementById('tpp-phone').value,seller_address:document.getElementById('tpp-address').value,seller_email:document.getElementById('tpp-email').value,product_id:product?.id,device_name:document.getElementById('tpp-device').value||product?.name,brand:product?.brand,model:product?.model,imei:document.getElementById('tpp-imei').value,serial:document.getElementById('tpp-serial').value,color:document.getElementById('tpp-color').value,capacity:document.getElementById('tpp-capacity').value,battery_health:document.getElementById('tpp-health').value,battery_capacity_mah:document.getElementById('tpp-mah').value,physical_condition:document.getElementById('tpp-condition').value,sale_description:document.getElementById('tpp-description').value,accessories,amount:Number(document.getElementById('tpp-amount').value),payment_method:document.getElementById('tpp-method').value,financial_account_id:Number(document.getElementById('tpp-account').value)||null,payment_reference:document.getElementById('tpp-reference').value,ownership_declared:document.getElementById('tpp-owner').checked,lawful_origin_declared:document.getElementById('tpp-origin').checked,seller_signature_name:document.getElementById('tpp-seller-sign').value,business_signature_name:document.getElementById('tpp-business-sign').value,terms_snapshot:configRes.data.terms};
    const saved=await window.api.techPrivatePurchases.create({requestUserId:user?.id,data});
    if(!saved?.ok){event.currentTarget.disabled=false;return toast(saved?.error||'No se pudo registrar','err');}
    toast(`✓ ${saved.number} registrada y equipo agregado al inventario`,'ok');
    await reloadProducts();
    verCompraParticular(saved.purchaseId);
  };
}

function techPrivatePurchaseDocument(row){
  const accessories=(()=>{try{return JSON.parse(row.accessories||'[]')}catch{return[]}})();
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font-family:Arial;color:#172033;font-size:11px;line-height:1.45}h1{font-size:21px;margin:0}.head{display:flex;justify-content:space-between;border-bottom:2px solid #245fd1;padding-bottom:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:14px 0}.box{border:1px solid #d8dee8;border-radius:8px;padding:9px}.label{font-size:9px;color:#667085;text-transform:uppercase}.value{font-weight:700}.terms{white-space:pre-wrap;text-align:justify}.sign{display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:55px}.line{border-top:1px solid #222;text-align:center;padding-top:5px}.page-break{break-before:page;page-break-before:always}</style></head><body><div class="head"><div><h1>${techPurchaseEsc(DB?.settings?.biz_name||CFG.biz||'VELO TECH POS')}</h1><div>Contrato de compra de equipo usado a particular</div></div><div><b>${techPurchaseEsc(row.number)}</b><br>${techPurchaseEsc(String(row.created_at||'').slice(0,16))}</div></div><div class="grid"><div class="box"><div class="label">Vendedor</div><div class="value">${techPurchaseEsc(row.seller_name)}</div>${techPurchaseEsc(row.seller_document)}<br>${techPurchaseEsc(row.seller_phone)}<br>${techPurchaseEsc(row.seller_address)}</div><div class="box"><div class="label">Equipo adquirido</div><div class="value">${techPurchaseEsc(row.device_name||row.product_name)}</div>${techPurchaseEsc([row.brand,row.model,row.capacity,row.color].filter(Boolean).join(' · '))}<br>IMEI: ${techPurchaseEsc(row.imei||'—')} · SERIAL: ${techPurchaseEsc(row.serial||'—')}</div><div class="box"><div class="label">Evaluación</div>${techPurchaseEsc(row.physical_condition)}<br>Batería: ${row.battery_health==null?'No medida':`${Number(row.battery_health)}%`}${row.battery_capacity_mah?` · ${Number(row.battery_capacity_mah)} mAh`:''}<br>Accesorios: ${techPurchaseEsc(accessories.join(', ')||'Ninguno')}</div><div class="box"><div class="label">Pago</div><div class="value">${fmt(row.amount)}</div>${techPurchaseEsc(row.payment_method)} ${row.payment_reference?`· ${techPurchaseEsc(row.payment_reference)}`:''}</div></div><div class="box"><div class="label">Descripción comercial para una futura venta</div>${techPurchaseEsc(row.sale_description||'Sin descripción adicional')}</div><div class="sign"><div class="line">${techPurchaseEsc(row.seller_signature_name)}<br>Vendedor</div><div class="line">${techPurchaseEsc(row.business_signature_name)}<br>Representante del negocio</div></div><div class="page-break"><h1>Declaraciones, garantía de procedencia y condiciones</h1><p class="terms">${techPurchaseEsc(row.terms_snapshot)}</p><div class="box"><b>Declaraciones aceptadas:</b><br>✓ Propiedad legítima del vendedor.<br>✓ Procedencia lícita y ausencia de reporte, bloqueo, financiamiento o reclamación de terceros.<br>✓ Autorización para revisar, reparar, reacondicionar y revender el equipo.</div><div class="sign"><div class="line">${techPurchaseEsc(row.seller_signature_name)}<br>Vendedor</div><div class="line">${techPurchaseEsc(row.business_signature_name)}<br>Representante del negocio</div></div></div></body></html>`;
}

async function verCompraParticular(id){const res=await window.api.techPrivatePurchases.getById({id,requestUserId:user?.id});if(!res?.ok||!res.data)return toast(res?.error||'Compra no encontrada','err');const row=res.data;openModal(`<div class="modal-title">${techPurchaseEsc(row.number)}</div><div class="modal-sub">Contrato y entrada de inventario vinculados · unidad #${row.product_unit_id}</div><div class="g2" style="margin-top:14px"><div class="card" style="padding:12px"><div class="tb">Vendedor</div><div>${techPurchaseEsc(row.seller_name)}</div><div class="ts">${techPurchaseEsc(row.seller_document)} · ${techPurchaseEsc(row.seller_phone)}</div></div><div class="card" style="padding:12px"><div class="tb">Equipo</div><div>${techPurchaseEsc(row.product_name)}</div><div class="ts">${techPurchaseEsc(row.imei||row.serial)} · ${techPurchaseEsc(row.unit_status)}</div></div></div><div class="alrt b"><div class="alrt-dot b"></div><div class="alrt-sub">Se generan dos páginas con las mismas condiciones congeladas y espacios de firma para ambas partes.</div></div><div class="modal-foot"><button class="btn btn-out" onclick="renderCompras(document.getElementById('page'))">Atrás</button><button class="btn btn-dark" id="tpp-print">${svg('printer')} Imprimir contrato (2 hojas)</button></div>`);document.getElementById('tpp-print').onclick=()=>printHTML(techPrivatePurchaseDocument(row),'reporte');}

async function abrirConfigCompraParticular(){const res=await window.api.techPrivatePurchases.getConfig({requestUserId:user?.id});if(!res?.ok)return toast(res?.error,'err');openModal(`<div class="modal-title">Términos de compra y garantía del taller</div><div class="modal-sub">Los contratos nuevos guardan una copia inmutable de estos términos. Los anteriores no cambian.</div><div class="fg" style="margin-top:14px"><label class="lbl">Términos predeterminados para compra a particulares</label><textarea class="inp" id="tpp-terms" rows="10">${techPurchaseEsc(res.data.terms)}</textarea></div><div class="fg"><label class="lbl">Garantía predeterminada del servicio técnico (días)</label><input class="inp" id="tpp-warranty-default" type="number" min="0" max="3650" value="${Number(res.data.default_warranty_days)||30}"></div><div class="alrt a"><div class="alrt-dot a"></div><div class="alrt-sub">Estos términos son una base operativa y no sustituyen la revisión de un abogado según las políticas del negocio y la legislación aplicable.</div></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-dark" id="tpp-config-save">Guardar</button></div>`,'modal-lg');document.getElementById('tpp-config-save').onclick=async()=>{const saved=await window.api.techPrivatePurchases.saveConfig({requestUserId:user?.id,terms:document.getElementById('tpp-terms').value,default_warranty_days:Number(document.getElementById('tpp-warranty-default').value)||0});if(!saved?.ok)return toast(saved?.error||'No se pudo guardar','err');toast('✓ Términos actualizados para contratos futuros','ok');closeModal();};}
