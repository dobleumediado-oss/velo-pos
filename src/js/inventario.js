// ══════════════════════════════════════════════
// inventario.js — Gestión de Inventario
//   · CRUD productos → SQLite
//   · Kardex por producto (historial completo)
//   · Entrada de mercancía rápida
//   · Ajuste con motivo obligatorio
//   · Reporte de stock bajo
//   · Exportar inventario PDF
// ══════════════════════════════════════════════

let invSearch = '';
let invCat    = '';
let invSort   = 'name';
let invTab    = 'todos'; // todos | bajo | sin_stock

function renderInventario(el) {
  el.innerHTML = '';

  const prods    = DB.products;
  const lowStock = prods.filter(p => p.stock > 0 && p.stock <= (p.stock_min || 5));
  const outStock = prods.filter(p => p.stock === 0);
  const totalVal = prods.reduce((a, p) => a + p.stock * p.cost, 0);

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Inventario'),
      h('div', { class: 'sec-sub' },
        `${prods.length} productos · Valor costo: ${fmt(totalVal)} · ` +
        `${lowStock.length} bajo mínimo · ${outStock.length} sin stock`
      )
    ),
    h('div', { class: 'flex', style: { gap: '8px' } },
      h('button', {
        class: 'btn btn-out btn-sm',
        onclick: exportInventarioPDF,
        html: `${svg('pdf')} Exportar`
      }),
      h('button', {
        class: 'btn btn-out btn-sm',
        onclick: openEntradaMercanciaModal,
        html: `${svg('download')} Entrada`
      }),
      h('button', {
        class: 'btn btn-dark',
        onclick: () => openProductoModal(),
        html: `${svg('plus')} Nuevo Producto`
      })
    )
  ));

  // ── Métricas ─────────────────────────────────
  const metWrap = h('div', { class: 'metrics',
    style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '18px' } });
  [
    { icon: 'box',    color: 'b', label: 'Productos',        val: prods.length },
    { icon: 'dollar', color: 'g', label: 'Valor Inventario', val: fmt(totalVal) },
    { icon: 'alert',  color: 'a', label: 'Stock Bajo',       val: lowStock.length },
    { icon: 'trash',  color: 'r', label: 'Sin Stock',        val: outStock.length },
  ].forEach(m => {
    metWrap.appendChild(
      h('div', { class: 'metric',
        style: m.color === 'r' && outStock.length > 0 ? { cursor:'pointer' } : {},
        onclick: m.color === 'r' && outStock.length > 0
          ? () => { invTab = 'sin_stock'; renderInvTable(); }
          : m.color === 'a' && lowStock.length > 0
          ? () => { invTab = 'bajo';      renderInvTable(); }
          : null
      },
        h('div', { class: 'met-top' },
          h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
        ),
        h('div', { class: 'met-label' }, m.label),
        h('div', { class: 'met-val' }, String(m.val))
      )
    );
  });
  el.appendChild(metWrap);

  // ── Filtros y tabs ───────────────────────────
  el.appendChild(
    h('div', { class: 'flex', style: { marginBottom: '10px', gap: '8px', flexWrap: 'wrap' } },
      h('div', { class: 'tabs', style: { marginBottom: 0 } },
        ...[
          { k: 'todos',     l: 'Todos' },
          { k: 'bajo',      l: `Stock bajo (${lowStock.length})` },
          { k: 'sin_stock', l: `Sin stock (${outStock.length})` },
        ].map(t => h('button', {
          class: `tab ${invTab === t.k ? 'on' : ''}`,
          onclick: () => { invTab = t.k; renderInvTable(); }
        }, t.l))
      )
    )
  );

  el.appendChild(
    h('div', { class: 'flex', style: { marginBottom: '14px', gap: '8px', flexWrap: 'wrap' } },
      h('div', { class: 'inp-ic', style: { flex: 1, minWidth: '200px' } },
        h('div', { class: 'ic', html: svg('search') }),
        h('input', {
          class: 'inp', type: 'text',
          placeholder: 'Buscar por nombre, código, marca...',
          value: invSearch,
          oninput: e => { invSearch = e.target.value; renderInvTable(); }
        })
      ),
      (() => {
        const sel = h('select', {
          class: 'inp', style: { width: '160px' },
          onchange: e => { invCat = e.target.value; renderInvTable(); }
        });
        [{ v:'', l:'Todas las categorías' }, ...CATS.map(c => ({ v:c, l:c }))].forEach(o => {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.l; op.selected = o.v === invCat;
          sel.appendChild(op);
        });
        return sel;
      })(),
      (() => {
        const sel = h('select', {
          class: 'inp', style: { width: '130px' },
          onchange: e => { invSort = e.target.value; renderInvTable(); }
        });
        [
          { v:'name',  l:'Nombre A-Z'   },
          { v:'stock', l:'Menor stock'  },
          { v:'price', l:'Mayor precio' },
          { v:'cat',   l:'Categoría'    },
        ].forEach(o => {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.l; op.selected = o.v === invSort;
          sel.appendChild(op);
        });
        return sel;
      })()
    )
  );

  const tableWrap = h('div', { id: 'inv-table-wrap' });
  el.appendChild(tableWrap);
  renderInvTable();
}

function renderInvTable() {
  const wrap = document.getElementById('inv-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const q = invSearch.toLowerCase().trim();

  let prods = DB.products.filter(p => {
    const stockMin = p.stock_min || 5;
    if (invTab === 'bajo'      && !(p.stock > 0 && p.stock <= stockMin)) return false;
    if (invTab === 'sin_stock' && p.stock !== 0) return false;
    const mCat = !invCat || p.category === invCat;
    const mQ   = !q ||
      p.name.toLowerCase().includes(q)  ||
      p.code.toLowerCase().includes(q)  ||
      (p.brand && p.brand.toLowerCase().includes(q));
    return mCat && mQ;
  }).sort((a, b) => {
    if (invSort === 'name')  return a.name.localeCompare(b.name);
    if (invSort === 'stock') return a.stock - b.stock;
    if (invSort === 'price') return b.price - a.price;
    if (invSort === 'cat')   return (a.category||'').localeCompare(b.category||'');
    return 0;
  });

  if (!prods.length) {
    wrap.appendChild(h('div', { class: 'empty' },
      h('div', { html: svg('box'), style: { color: 'var(--muted2)' } }),
      h('p', null, invSearch ? 'Sin resultados' : 'Sin productos en esta vista'),
      h('span', null, invSearch ? 'Prueba otro término' : '')
    ));
    return;
  }

  const card  = h('div', { class: 'card' });
  const tw    = h('div', { class: 'tw' });
  const tbl   = h('table', null,
    h('thead', null,
      h('tr', null,
        ...['Código','Producto','Categoría','Stock','Mín','Precio','Mayorista','Costo',''].map(t =>
          h('th', null, t)
        )
      )
    )
  );
  const tbody = h('tbody', null);

  prods.forEach(p => {
    const stockMin = p.stock_min || 5;
    const isLow    = p.stock > 0 && p.stock <= stockMin;
    const isOut    = p.stock === 0;
    const margin   = p.price > 0
      ? Math.round(((p.price - p.cost) / p.price) * 100) : 0;

    const tr = h('tr', null,
      h('td', { class: 'tm', style: { fontSize: '11px' } }, p.code),
      h('td', null,
        h('div', { class: 'tb' }, p.name),
        h('div', { class: 'ts' }, p.brand || '—')
      ),
      h('td', null, h('span', { class: 'badge n' }, p.category || '—')),
      h('td', null,
        h('div', { style: { fontWeight: 700, fontSize: '14px',
          color: isOut ? 'var(--red)' : isLow ? 'var(--amber)' : 'var(--green)' } },
          String(p.stock)),
        h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } }, p.unit || 'und')
      ),
      h('td', { style: { color: 'var(--muted)', fontSize: '12px' } }, String(stockMin)),
      h('td', null,
        h('div', { style: { fontWeight: 700, fontSize: '13px' } }, fmt(p.price)),
        h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } }, `${margin}% margen`)
      ),
      h('td', { style: { fontSize: '12px', color: 'var(--muted)' } }, fmt(p.wholesale)),
      h('td', { style: { fontSize: '12px', color: 'var(--muted)' } }, fmt(p.cost)),
      h('td', null,
        h('div', { class: 'flex', style: { gap: '3px' } },
          h('button', {
            class: 'btn btn-ghost btn-sm',
            title: 'Ver kardex',
            onclick: () => openKardexModal(p),
            html: svg('chart')
          }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            title: 'Editar producto',
            onclick: () => openProductoModal(p),
            html: svg('edit')
          }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            title: 'Ajustar stock',
            onclick: () => openAjusteModal(p),
            html: `${svg('pkg')} Ajuste`
          }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            style: { color: 'var(--red)' },
            title: 'Eliminar producto',
            onclick: () => confirmModal(
              `¿Eliminar <strong>${p.name}</strong>? El producto quedará inactivo.`,
              () => eliminarProducto(p.id),
              'Eliminar'
            ),
            html: svg('trash')
          })
        )
      )
    );

    if (isOut)      tr.style.background = 'var(--red-bg)';
    else if (isLow) tr.style.background = 'var(--amber-bg)';
    tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  tw.appendChild(tbl);
  card.appendChild(tw);
  wrap.appendChild(card);
}

// ══════════════════════════════════════════════
// KARDEX — Historial de movimientos por producto
// ══════════════════════════════════════════════
async function openKardexModal(p) {
  // Cargar movimientos desde SQLite
  const movs = await window.api.products.getMovements({ productId: p.id });

  const typeLabel = {
    entrada:    { l: 'Entrada',    c: 'var(--green)' },
    salida:     { l: 'Venta',      c: 'var(--red)'   },
    ajuste:     { l: 'Ajuste',     c: 'var(--blue)'  },
    devolucion: { l: 'Devolución', c: 'var(--amber)' },
    dano:       { l: 'Daño',       c: 'var(--red)'   },
    perdida:    { l: 'Pérdida',    c: 'var(--red)'   },
  };

  const rows = movs.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:var(--muted2);padding:20px">
         Sin movimientos registrados</td></tr>`
    : movs.map(m => {
        const t    = typeLabel[m.type] || { l: m.type, c: 'var(--muted)' };
        const sign = ['entrada','devolucion'].includes(m.type) ? '+' : '';
        const fecha = (m.created_at || '').split('T')[0].split(' ')[0];
        return `
          <tr>
            <td style="font-size:11px;color:var(--muted)">${fdate(fecha)}</td>
            <td><span style="font-size:11px;font-weight:700;color:${t.c}">${t.l}</span></td>
            <td style="text-align:center;font-weight:700;color:${t.c}">
              ${sign}${m.qty}
            </td>
            <td style="text-align:center">${m.qty_before}</td>
            <td style="text-align:center;font-weight:700">${m.qty_after}</td>
            <td style="font-size:11px;color:var(--muted2);max-width:180px">
              ${m.reason || '—'}<br>
              <span style="font-size:10px">${m.user_name || ''}</span>
            </td>
          </tr>`;
      }).join('');

  openModal(`
    <div class="modal-title">Kardex — ${p.name}</div>
    <div class="modal-sub">
      ${p.code} · Stock actual: <strong>${p.stock} ${p.unit || 'und'}</strong>
    </div>

    <div class="metrics" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="metric">
        <div class="met-label">Stock actual</div>
        <div class="met-val" style="color:${p.stock > 0 ? 'var(--green)' : 'var(--red)'}">
          ${p.stock}
        </div>
      </div>
      <div class="metric">
        <div class="met-label">Stock mínimo</div>
        <div class="met-val">${p.stock_min || 5}</div>
      </div>
      <div class="metric">
        <div class="met-label">Movimientos</div>
        <div class="met-val">${movs.length}</div>
      </div>
    </div>

    <div class="tw" style="max-height:380px;overflow-y:auto">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th style="text-align:center">Cant.</th>
            <th style="text-align:center">Antes</th>
            <th style="text-align:center">Después</th>
            <th>Motivo / Usuario</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-dark" onclick="closeModal();openAjusteModal(
        DB.products.find(x=>x.id===${p.id})||{id:${p.id},name:'${p.name.replace(/'/g,"\\'")}',stock:${p.stock},unit:'${p.unit||'und'}',stock_min:${p.stock_min||5}}
      )">
        ${svg('pkg')} Ajustar stock
      </button>
    </div>
  `, 'modal-lg');
}

// ══════════════════════════════════════════════
// ENTRADA DE MERCANCÍA RÁPIDA
// ══════════════════════════════════════════════
function openEntradaMercanciaModal() {
  const prodOpts = DB.products
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(p => `<option value="${p.id}">[${p.code}] ${p.name} — Stock: ${p.stock}</option>`)
    .join('');

  openModal(`
    <div class="modal-title">Entrada de Mercancía</div>
    <div class="modal-sub">Registrar compra o reposición de inventario</div>

    <div class="fg">
      <label class="lbl">Producto *</label>
      <select class="inp" id="em-prod" onchange="emUpdateInfo()">
        <option value="">Selecciona un producto...</option>
        ${prodOpts}
      </select>
    </div>

    <div id="em-info" style="display:none" class="alrt b" style="margin:10px 0">
      <div class="alrt-dot b"></div>
      <div id="em-info-txt"></div>
    </div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Cantidad que entra *</label>
        <input class="inp" id="em-qty" type="number" min="1" placeholder="0"
               oninput="emCalcPreview()"/>
        <div id="em-preview" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
      </div>
      <div class="fg">
        <label class="lbl">Nuevo costo unitario (opcional)</label>
        <input class="inp" id="em-cost" type="number" min="0"
               placeholder="Dejar vacío para mantener el actual"/>
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Proveedor / Referencia</label>
      <input class="inp" id="em-supplier" type="text"
             placeholder="Nombre del proveedor o número de factura del proveedor"/>
    </div>

    <div class="fg">
      <label class="lbl">Notas adicionales</label>
      <input class="inp" id="em-note" type="text"
             placeholder="Observaciones de la entrada..."/>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="confirmarEntrada()">
        ${svg('download')} Registrar Entrada
      </button>
    </div>
  `, 'modal-lg');
}

function emUpdateInfo() {
  const id   = parseInt(document.getElementById('em-prod')?.value);
  const info = document.getElementById('em-info');
  const txt  = document.getElementById('em-info-txt');
  if (!id || !info || !txt) return;

  const p = DB.products.find(x => x.id === id);
  if (!p) return;

  info.style.display = 'flex';
  txt.innerHTML = `
    <strong>${p.name}</strong> · Código: ${p.code}<br>
    <span style="font-size:11px">
      Stock actual: <strong>${p.stock} ${p.unit||'und'}</strong> ·
      Mínimo: ${p.stock_min||5} ·
      Costo actual: ${fmt(p.cost)}
    </span>`;

  const costField = document.getElementById('em-cost');
  if (costField && !costField.value) costField.placeholder = `Actual: ${fmt(p.cost)}`;
  emCalcPreview();
}

function emCalcPreview() {
  const id  = parseInt(document.getElementById('em-prod')?.value);
  const qty = parseInt(document.getElementById('em-qty')?.value) || 0;
  const el  = document.getElementById('em-preview');
  if (!el || !id) return;
  const p = DB.products.find(x => x.id === id);
  if (!p) return;
  const nuevo = p.stock + qty;
  el.textContent = qty > 0
    ? `Stock resultante: ${p.stock} + ${qty} = ${nuevo} ${p.unit||'und'}`
    : '';
  el.style.color = nuevo >= (p.stock_min||5) ? 'var(--green)' : 'var(--amber)';
}

async function confirmarEntrada() {
  const id       = parseInt(document.getElementById('em-prod')?.value);
  const qty      = parseInt(document.getElementById('em-qty')?.value) || 0;
  const newCost  = parseFloat(document.getElementById('em-cost')?.value) || 0;
  const supplier = document.getElementById('em-supplier')?.value?.trim() || '';
  const note     = document.getElementById('em-note')?.value?.trim() || '';

  if (!id)      { toast('Selecciona un producto', 'err'); return; }
  if (qty <= 0) { toast('Ingresa una cantidad válida', 'err'); return; }

  const reason = [
    'Entrada de mercancía',
    supplier ? `Proveedor: ${supplier}` : '',
    note     ? note : '',
  ].filter(Boolean).join(' · ');

  const result = await window.api.products.adjustStock({
    id, qty, type: 'entrada', reason, requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al registrar', 'err'); return; }

  // Si se actualizó el costo, también actualizar el producto
  if (newCost > 0) {
    const p = DB.products.find(x => x.id === id);
    if (p) {
      await window.api.products.update({
        id, data: { ...p, cost: newCost }, requestUserId: user.id,
      });
    }
  }

  await reloadProducts();
  closeModal();
  const p = DB.products.find(x => x.id === id);
  toast(`✓ Entrada registrada — Stock: ${result.after} ${p?.unit||'und'}`);
  renderInventario(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// MODAL PRODUCTO (crear / editar)
// ══════════════════════════════════════════════
function openProductoModal(p = null) {
  const isEdit   = !!p?.id;
  const stockMin = p?.stock_min || 5;

  const catOpts = CATS.map(c =>
    `<option value="${c}" ${isEdit && p.category === c ? 'selected' : ''}>${c}</option>`
  ).join('');

  openModal(`
    <div class="modal-title">${isEdit ? 'Editar Producto' : 'Nuevo Producto'}</div>
    <div class="modal-sub">${isEdit ? p.name : 'Registrar en inventario'}</div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Nombre *</label>
        <input class="inp" id="pf-name" type="text" placeholder="Filtro de aceite Toyota"
               value="${isEdit ? p.name : ''}"
               oninput="pfAutoCode(this.value)"/>
      </div>
      <div class="fg">
        <label class="lbl">Código *
          <span style="font-size:10px;color:var(--muted);font-weight:400;margin-left:4px">
            — se genera automáticamente o escribe uno
          </span>
        </label>
        <input class="inp" id="pf-code" type="text" placeholder="FLT-001"
               value="${isEdit ? p.code : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">
          Código de barras
          <span style="font-weight:400;color:var(--muted2);font-size:11px">
            — escanea o escribe el EAN/UPC
          </span>
        </label>
        <div style="position:relative">
          <input class="inp" id="pf-barcode" type="text"
                 placeholder="7501234567890"
                 value="${isEdit ? (p.barcode||'') : ''}"
                 style="padding-left:32px"/>
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);
                        color:var(--muted2);font-size:14px">⊟</span>
        </div>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Marca</label>
        <input class="inp" id="pf-brand" type="text" placeholder="Denso, NGK..."
               value="${isEdit ? (p.brand || '') : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">Categoría</label>
        <select class="inp" id="pf-cat">${catOpts}</select>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Descripción</label>
        <input class="inp" id="pf-desc" type="text" placeholder="Descripción opcional"
               value="${isEdit ? (p.description||'') : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">Unidad</label>
        <select class="inp" id="pf-unit">
          ${['und','par','kit','set','gal','litro','metro','caja','rollo'].map(u =>
            `<option value="${u}" ${isEdit && p.unit === u ? 'selected':''}>${u}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <hr style="margin:12px 0;border:none;border-top:1px solid var(--line)"/>
    <div style="font-weight:700;font-size:12px;margin-bottom:10px">Precios</div>
    <div class="g3">
      <div class="fg">
        <label class="lbl">Costo (RD$) *</label>
        <input class="inp" id="pf-cost" type="number" min="0" placeholder="0"
               value="${isEdit ? p.cost : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">Precio Detalle *</label>
        <input class="inp" id="pf-price" type="number" min="0" placeholder="0"
               value="${isEdit ? p.price : ''}" oninput="pfCalcMargen()"/>
      </div>
      <div class="fg">
        <label class="lbl">Precio Mayorista</label>
        <input class="inp" id="pf-wholesale" type="number" min="0" placeholder="0"
               value="${isEdit ? p.wholesale : ''}"/>
      </div>
    </div>
    <div id="pf-margen" style="font-size:11px;color:var(--muted);margin-top:-6px;margin-bottom:10px"></div>

    <hr style="margin:12px 0;border:none;border-top:1px solid var(--line)"/>
    <div style="font-weight:700;font-size:12px;margin-bottom:10px">Stock</div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Stock actual ${isEdit ? '(usa Ajuste para cambiar)' : '*'}</label>
        <input class="inp" id="pf-stock" type="number" min="0" placeholder="0"
               value="${isEdit ? p.stock : ''}" ${isEdit ? 'readonly style="opacity:0.6"' : ''}/>
      </div>
      <div class="fg">
        <label class="lbl">Stock mínimo (alerta)</label>
        <input class="inp" id="pf-min" type="number" min="0" placeholder="5"
               value="${stockMin}"/>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="guardarProducto(${isEdit ? p.id : 'null'})">
        ${svg('check')} ${isEdit ? 'Guardar cambios' : 'Registrar producto'}
      </button>
    </div>
  `, 'modal-lg');

  if (isEdit) pfCalcMargen();
}

function pfCalcMargen() {
  const cost  = parseFloat(document.getElementById('pf-cost')?.value)  || 0;
  const price = parseFloat(document.getElementById('pf-price')?.value) || 0;
  const el    = document.getElementById('pf-margen');
  if (!el) return;
  if (price > 0 && cost > 0) {
    const margen = ((price - cost) / price * 100).toFixed(1);
    const ganancia = price - cost;
    el.textContent = `Margen: ${margen}% · Ganancia por unidad: ${fmt(ganancia)}`;
    el.style.color = margen >= 20 ? 'var(--green)' : 'var(--amber)';
  } else {
    el.textContent = '';
  }
}

// Generar código automático a partir del nombre
// Ejemplo: "Filtro Aceite Toyota" → "FIL-ACE-001"
// Compatible con lectores de código de barras (texto limpio)
function pfAutoCode(nombre) {
  const codeEl = document.getElementById('pf-code');
  if (!codeEl || codeEl.dataset.manual === '1') return;

  if (!nombre || nombre.trim().length < 2) {
    codeEl.value = '';
    return;
  }

  // Tomar las primeras 3 letras de cada palabra significativa
  const stopWords = ['de','la','el','los','las','del','un','una','y','e','o'];
  const words = nombre.trim().split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.includes(w.toLowerCase()));

  let prefix = '';
  if (words.length >= 2) {
    prefix = words.slice(0, 2).map(w => w.slice(0, 3).toUpperCase()).join('-');
  } else {
    prefix = words[0].slice(0, 6).toUpperCase();
  }

  // Buscar el próximo número disponible
  const existing = DB.products
    .map(p => p.code)
    .filter(c => c.startsWith(prefix));

  let num = 1;
  while (existing.includes(`${prefix}-${String(num).padStart(3,'0')}`)) {
    num++;
  }

  codeEl.value = `${prefix}-${String(num).padStart(3,'0')}`;
}

// Marcar el código como manual si el usuario lo escribe
document.addEventListener('input', e => {
  if (e.target?.id === 'pf-code') {
    e.target.dataset.manual = '1';
  }
});

async function guardarProducto(id) {
  const name      = document.getElementById('pf-name')?.value?.trim();
  const code      = document.getElementById('pf-code')?.value?.trim();
  const brand     = document.getElementById('pf-brand')?.value?.trim()     || '';
  const category  = document.getElementById('pf-cat')?.value               || '';
  const unit      = document.getElementById('pf-unit')?.value              || 'und';
  const desc      = document.getElementById('pf-desc')?.value?.trim()      || '';
  const barcode   = document.getElementById('pf-barcode')?.value?.trim()   || '';
  const cost      = parseFloat(document.getElementById('pf-cost')?.value)  || 0;
  const price     = parseFloat(document.getElementById('pf-price')?.value) || 0;
  const wholesale = parseFloat(document.getElementById('pf-wholesale')?.value) || price;
  const stock     = parseInt(document.getElementById('pf-stock')?.value)   || 0;
  const stock_min = parseInt(document.getElementById('pf-min')?.value)     || 5;

  if (!name)      { toast('El nombre es requerido', 'err');  return; }
  if (!code)      { toast('El código es requerido', 'err');  return; }
  if (price <= 0) { toast('El precio debe ser mayor a 0', 'err'); return; }

  const data = { code, barcode, name, brand, category, description: desc, unit, cost, price, wholesale, stock, stock_min };

  let result;
  if (id) {
    result = await window.api.products.update({ id, data, requestUserId: user.id });
  } else {
    result = await window.api.products.create({ data, requestUserId: user.id });
  }

  if (!result.ok) { toast(result.error || 'Error al guardar', 'err'); return; }

  await reloadProducts();
  closeModal();
  toast(id ? '✓ Producto actualizado' : '✓ Producto registrado');
  renderInventario(document.getElementById('page'));
}

async function eliminarProducto(id) {
  const result = await window.api.products.delete({ id, requestUserId: user.id });
  if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
  await reloadProducts();
  toast('Producto inactivado');
  renderInventario(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// AJUSTE DE STOCK
// ══════════════════════════════════════════════
let adjType = 'add';

function openAjusteModal(p) {
  openModal(`
    <div class="modal-title">Ajuste de Stock</div>
    <div class="modal-sub">${p.name} · Stock actual: <strong>${p.stock} ${p.unit || 'und'}</strong></div>

    <div class="fg">
      <label class="lbl">Tipo de movimiento *</label>
      <div class="tabs" style="margin-bottom:0">
        <button class="tab on"  id="adj-type-add" onclick="setAdjType('add')">+ Entrada</button>
        <button class="tab"     id="adj-type-sub" onclick="setAdjType('sub')">− Salida / Merma</button>
        <button class="tab"     id="adj-type-set" onclick="setAdjType('set')">= Establecer</button>
      </div>
    </div>

    <div class="fg mt14">
      <label class="lbl">Cantidad *</label>
      <input class="inp" id="adj-qty" type="number" min="0" placeholder="0"
             oninput="calcAdjPreview(${p.stock})"/>
      <div id="adj-preview" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
    </div>

    <div class="fg">
      <label class="lbl">Motivo * <span style="color:var(--muted);font-weight:400">(requerido para auditoría)</span></label>
      <input class="inp" id="adj-note" type="text"
             placeholder="Ej: Conteo físico, compra urgente, merma, producto dañado..."/>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="confirmarAjuste(${p.id}, ${p.stock})">
        ${svg('check')} Aplicar Ajuste
      </button>
    </div>
  `);
  adjType = 'add';
}

function setAdjType(type) {
  adjType = type;
  ['add','sub','set'].forEach(t => {
    const btn = document.getElementById(`adj-type-${t}`);
    if (btn) btn.className = `tab ${t === type ? 'on' : ''}`;
  });
}

function calcAdjPreview(current) {
  const qty     = parseInt(document.getElementById('adj-qty')?.value) || 0;
  const preview = document.getElementById('adj-preview');
  if (!preview) return;
  let result;
  if (adjType === 'add') result = current + qty;
  if (adjType === 'sub') result = Math.max(0, current - qty);
  if (adjType === 'set') result = qty;
  preview.textContent = `Stock resultante: ${current} → ${result}`;
  preview.style.color = result <= 0 ? 'var(--red)' : result < 5 ? 'var(--amber)' : 'var(--green)';
}

async function confirmarAjuste(id, currentStock) {
  const qty  = parseInt(document.getElementById('adj-qty')?.value) || 0;
  const note = document.getElementById('adj-note')?.value?.trim()  || '';

  if (qty <= 0 && adjType !== 'set') {
    toast('Ingresa una cantidad válida', 'err'); return;
  }
  if (!note) { toast('El motivo es requerido — queda registrado en auditoría', 'err'); return; }

  let delta, type;
  if (adjType === 'add') { delta = qty;                          type = 'entrada'; }
  if (adjType === 'sub') { delta = -Math.min(qty, currentStock); type = 'ajuste';  }
  if (adjType === 'set') { delta = qty - currentStock;           type = 'ajuste';  }

  const result = await window.api.products.adjustStock({
    id, qty: delta, type, reason: note, requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al ajustar', 'err'); return; }

  await reloadProducts();
  closeModal();
  toast(`✓ Stock ajustado: ${result.before} → ${result.after}`);
  renderInventario(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// EXPORTAR INVENTARIO PDF
// ══════════════════════════════════════════════
function exportInventarioPDF() {
  const isAdmin  = user?.role === 'admin' || user?.role === 'superadmin';
  const rows = DB.products.map(p => {
    const stockMin = p.stock_min || 5;
    const isLow    = p.stock > 0 && p.stock <= stockMin;
    const isOut    = p.stock === 0;
    return `
      <tr style="${isOut ? 'background:#fef2f2' : isLow ? 'background:#fffbeb' : ''}">
        <td style="font-family:monospace;font-size:11px">${p.code}</td>
        <td>${p.name}<br><span style="font-size:10px;color:#9ca3af">${p.brand||''}</span></td>
        <td>${p.category || '&#8212;'}</td>
        <td style="text-align:center;font-weight:700;
            color:${isOut ? '#DC2626' : isLow ? '#D97706' : '#16A34A'}">
          ${p.stock} ${p.unit||'und'}
        </td>
        <td style="text-align:center;color:#6b7280">${p.stock_min||5}</td>
        <td style="text-align:right">RD$${p.price.toLocaleString('es-DO')}</td>
        ${isAdmin ? `
          <td style="text-align:right;color:#6b7280">RD$${p.cost.toLocaleString('es-DO')}</td>
          <td style="text-align:right;font-weight:600">
            RD$${(p.stock*p.cost).toLocaleString('es-DO')}
          </td>` : '<td colspan="2"></td>'}
      </tr>`;
  }).join('');

  const totalVal = DB.products.reduce((a, p) => a + p.stock * p.cost, 0);
  const lowCount = DB.products.filter(p => p.stock > 0 && p.stock <= (p.stock_min||5)).length;
  const outCount = DB.products.filter(p => p.stock === 0).length;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Inventario</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;color:#111;padding:20px}
  h2{margin-bottom:2px}
  .sub{color:#666;margin-bottom:4px;font-size:11px}
  .stats{display:flex;gap:24px;margin-bottom:16px;padding:10px;
         background:#f9fafb;border-radius:6px;font-size:12px}
  .stat strong{display:block;font-size:16px}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:7px 10px;text-align:left;
     font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  td{padding:7px 10px;border-bottom:1px solid #e5e7eb;vertical-align:middle}
  .total{font-weight:700;font-size:13px;margin-top:8px;text-align:right;
         padding:8px;background:#f0fdf4;border-radius:4px}
  .foot{margin-top:14px;font-size:10px;color:#9ca3af}
  .no-print{margin-bottom:12px;text-align:right}
  @media print{.no-print{display:none}}
</style></head><body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;
             border-radius:6px;font-size:12px;cursor:pointer">
      Imprimir / Guardar PDF
    </button>
  </div>
  <h2>Inventario &#8212; ${CFG.biz}</h2>
  <div class="sub">Generado el ${fdate(today())} a las ${nowt()}</div>
  <div class="stats">
    <div class="stat"><strong>${DB.products.length}</strong>Productos</div>
    ${isAdmin ? `<div class="stat"><strong style="color:#16a34a">RD$${totalVal.toLocaleString('es-DO')}</strong>Valor total</div>` : ''}
    <div class="stat"><strong style="color:#d97706">${lowCount}</strong>Stock bajo</div>
    <div class="stat"><strong style="color:#dc2626">${outCount}</strong>Sin stock</div>
  </div>
  <table>
    <thead><tr>
      <th>C&#243;digo</th><th>Producto</th><th>Categor&#237;a</th>
      <th style="text-align:center">Stock</th>
      <th style="text-align:center">M&#237;n</th>
      <th style="text-align:right">Precio</th>
      ${isAdmin ? '<th style="text-align:right">Costo</th><th style="text-align:right">Valor</th>' : ''}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${isAdmin ? `<div class="total">Valor total de inventario: RD$${totalVal.toLocaleString('es-DO')}</div>` : ''}
  <div class="foot">${CFG.biz} &#183; ${CFG.phone} &#183; ${CFG.addr}</div>
</body></html>`;

  printHTML(html);
}
