// ══════════════════════════════════════════════
// ventas.js — Historial de Ventas via IPC
//            · Filtros por fecha y método
//            · Anulación controlada (solo admin)
//            · Devoluciones
// ══════════════════════════════════════════════

let ventasSearch = '';
let ventasRange  = 'today';
let ventasPay    = '';

function renderVentas(el) {
  el.innerHTML = '';

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Historial de Ventas'),
      h('div', { class: 'sec-sub' }, 'Todas las transacciones registradas')
    ),
    h('button', {
      class: 'btn btn-out btn-sm',
      onclick: exportVentasPDF,
      html: `${svg('pdf')} Exportar`
    })
  ));

  // Filtros
  el.appendChild(
    h('div', { class: 'flex', style: { marginBottom: '14px', gap: '8px', flexWrap: 'wrap' } },
      h('div', { class: 'inp-ic', style: { flex: 1, minWidth: '200px' } },
        h('div', { class: 'ic', html: svg('search') }),
        h('input', {
          class: 'inp', type: 'text',
          placeholder: 'Buscar por cliente, # factura...',
          value: ventasSearch,
          oninput: e => { ventasSearch = e.target.value; refreshVentas(el); }
        })
      ),
      (() => {
        const sel = h('select', {
          class: 'inp', style: { width: '130px' },
          onchange: e => { ventasRange = e.target.value; refreshVentas(el); }
        });
        [
          { v: 'today',  l: 'Hoy'         },
          { v: 'week',   l: 'Esta semana' },
          { v: 'month',  l: 'Este mes'    },
          { v: 'all',    l: 'Todas'       },
        ].forEach(o => {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.l;
          op.selected = o.v === ventasRange;
          sel.appendChild(op);
        });
        return sel;
      })(),
      (() => {
        const sel = h('select', {
          class: 'inp', style: { width: '130px' },
          onchange: e => { ventasPay = e.target.value; refreshVentas(el); }
        });
        [
          { v: '',              l: 'Todos'         },
          { v: 'efectivo',      l: 'Efectivo'      },
          { v: 'tarjeta',       l: 'Tarjeta'       },
          { v: 'transferencia', l: 'Transferencia' },
          { v: 'credito',       l: 'Crédito'       },
        ].forEach(o => {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.l;
          op.selected = o.v === ventasPay;
          sel.appendChild(op);
        });
        return sel;
      })()
    )
  );

  const resWrap   = h('div', { id: 'ventas-resumen' });
  const tableWrap = h('div', { id: 'ventas-table-wrap' });
  el.appendChild(resWrap);
  el.appendChild(tableWrap);

  refreshVentas(el);
}

async function refreshVentas(el) {
  // Recargar ventas desde IPC
  await reloadSales({ range: ventasRange });
  renderVentasTable();
}

function renderVentasTable() {
  const resWrap   = document.getElementById('ventas-resumen');
  const tableWrap = document.getElementById('ventas-table-wrap');
  if (!tableWrap) return;

  const q = ventasSearch.toLowerCase().trim();

  let sales = DB.sales.filter(s => {
    const method = s.payment_method || s.pay || '';
    const name   = s.customer_name  || s.clientName || '';
    const matchPay = !ventasPay || method === ventasPay;
    const matchQ   = !q ||
      String(s.id).includes(q) ||
      name.toLowerCase().includes(q) ||
      (s.customer_rnc || s.clientCedula || '').includes(q);
    // Excluir devoluciones — tienen su propio módulo
    return matchPay && matchQ && s.status !== 'cancelled' && s.type !== 'devolucion';
  });

  // Resumen
  if (resWrap) {
    resWrap.innerHTML = '';
    const total = sales.reduce((a, s) => a + (s.total || 0), 0);
    const byPay = {};
    sales.forEach(s => {
      const m = s.payment_method || s.pay || 'efectivo';
      byPay[m] = (byPay[m] || 0) + (s.total || 0);
    });

    const resGrid = h('div', { class: 'metrics',
      style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '16px' } });

    [
      { icon: 'list',  color: 'b', label: 'Transacciones', val: sales.length },
      { icon: 'dollar',color: 'g', label: 'Total',         val: fmt(total) },
      { icon: 'cash',  color: 'g', label: 'Efectivo',      val: fmt(byPay['efectivo'] || 0) },
      { icon: 'card',  color: 'p', label: 'Tarj/Trans',
        val: fmt((byPay['tarjeta']||0) + (byPay['transferencia']||0)) },
    ].forEach(m => {
      resGrid.appendChild(
        h('div', { class: 'metric' },
          h('div', { class: 'met-top' },
            h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
          ),
          h('div', { class: 'met-label' }, m.label),
          h('div', { class: 'met-val' }, String(m.val))
        )
      );
    });
    resWrap.appendChild(resGrid);
  }

  tableWrap.innerHTML = '';

  if (!sales.length) {
    tableWrap.appendChild(h('div', { class: 'empty' },
      h('div', { html: svg('list'), style: { color: 'var(--muted2)' } }),
      h('p', null, 'Sin ventas en este período')
    ));
    return;
  }

  const card  = h('div', { class: 'card' });
  const tw    = h('div', { class: 'tw' });
  const tbl   = h('table', null,
    h('thead', null,
      h('tr', null,
        ...['#','Fecha','Cliente','Método','ITBIS','Total',''].map(t =>
          h('th', null, t)
        )
      )
    )
  );
  const tbody = h('tbody', null);

  [...sales].reverse().forEach(s => {
    const method    = s.payment_method || s.pay || '';
    const cliName   = s.customer_name  || s.clientName || 'Consumidor Final';
    const fecha     = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
    const hora      = s.created_at
      ? new Date(s.created_at).toLocaleTimeString('es-DO',
          { hour: '2-digit', minute: '2-digit' })
      : (s.time || '');
    const taxAmt    = s.tax_amt || s.itbis || 0;

    tbody.appendChild(
      h('tr', null,
        h('td', null,
          h('span', { class: 'tm', style: { fontSize: '11px' } }, `#${s.id}`),
          h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } }, s.type || 'factura')
        ),
        h('td', null,
          h('div', { style: { fontSize: '12px', fontWeight: 500 } }, fdate(fecha)),
          h('div', { class: 'ts' }, hora)
        ),
        h('td', null,
          h('div', { class: 'tb' }, cliName),
          h('div', { class: 'ts' }, s.cajero || '')
        ),
        h('td', null,
          h('span', { class: `badge ${
            method === 'efectivo'      ? 'g' :
            method === 'tarjeta'       ? 'b' :
            method === 'transferencia' ? 'p' :
            method === 'credito'       ? 'a' : 'n'
          }` }, method)
        ),
        h('td', { style: { fontSize: '12px', color: 'var(--muted)' } },
          taxAmt > 0 ? fmt(taxAmt) : '—'
        ),
        h('td', null,
          h('span', { style: { fontWeight: 700, fontSize: '14px' } }, fmt(s.total))
        ),
        h('td', null,
          h('div', { class: 'flex', style: { gap: '3px' } },
            h('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => openDetalleVentaModal(s),
              html: `${svg('eye')} Ver`
            }),
            h('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => reimprimirVenta(s.id),
              html: svg('print')
            }),
            // Botón convertir cotización → venta
            (s.type === 'cotizacion' || s.itype === 'cotizacion') && s.status !== 'cancelled'
              ? h('button', {
                  class: 'btn btn-green btn-sm',
                  title: 'Convertir cotización en venta',
                  onclick: () => convertirCotizacionAVenta(s),
                  html: `${svg('check')} Convertir`
                })
              : null,
            user?.role === 'admin'
              ? h('button', {
                  class: 'btn btn-ghost btn-sm',
                  style: { color: 'var(--red)' },
                  onclick: () => openAnulacionModal(s),
                  html: svg('xmark')
                })
              : null
          )
        )
      )
    );
  });

  tbl.appendChild(tbody);
  tw.appendChild(tbl);
  card.appendChild(tw);
  tableWrap.appendChild(card);
}

// ── Detalle de venta ──────────────────────────
async function convertirCotizacionAVenta(s) {
  const sale = await window.api.sales.getById({ id: s.id });
  if (!sale) { toast('Cotización no encontrada', 'err'); return; }

  confirmModal(
    `¿Convertir la cotización <strong>#${String(s.id).padStart(5,'0')}</strong> en una venta real?
     <br><span style="font-size:11px;color:var(--muted)">
       Se descontará el inventario y se registrará el movimiento de caja.
     </span>`,
    async () => {
      // Crear nueva venta a partir de la cotización
      const customer = DB.customers.find(c => c.id === sale.customer_id) ||
        { id: 1, name: sale.customer_name || 'Consumidor Final', rnc: '' };

      const items = (sale.items || []).map(i => ({
        product_id:   i.product_id,
        product_code: i.product_code || '',
        product_name: i.product_name,
        unit_cost:    i.unit_cost  || 0,
        unit_price:   i.unit_price,
        qty:          i.qty,
      }));

      const result = await window.api.sales.create({
        saleData: {
          customer,
          items,
          payment: {
            method:    'efectivo',
            disc:      sale.discount_pct || 0,
            priceMode: sale.price_mode   || 'retail',
          },
          type:    'factura',
          session: cajaSession,
        },
        requestUserId: user.id,
      });

      if (!result.ok) { toast(result.error || 'Error al convertir', 'err'); return; }

      // Anular la cotización original
      await window.api.sales.cancel({
        id: s.id, reason: `Convertida en factura #${result.saleId}`,
        requestUserId: user.id,
      });

      await reloadSales({ range: 'all' });
      await reloadProducts();
      closeModal();
      toast(`✓ Cotización convertida — Factura #${String(result.saleId).padStart(5,'0')}`);

      // Imprimir ticket de la nueva venta
      printReceipt({
        id:             result.saleId,
        type:           'factura',
        customer_name:  sale.customer_name || 'Consumidor Final',
        customer_rnc:   sale.customer_rnc  || '',
        items,
        subtotal:       sale.subtotal,
        discount_pct:   sale.discount_pct || 0,
        discount_amt:   sale.discount_amt || 0,
        tax_amt:        sale.tax_amt      || 0,
        total:          sale.total,
        payment_method: 'efectivo',
        cajero:         user.name,
        date:           today(),
        time:           nowt(),
      });

      renderVentas(document.getElementById('page'));
    },
    'Convertir en venta',
    'btn-green'
  );
}

async function openDetalleVentaModal(s) {
  // Cargar items completos
  const sale = await window.api.sales.getById({ id: s.id });
  const items = sale?.items || [];

  const itemsRows = items.map(i => `
    <tr>
      <td>${i.product_name || i.name}</td>
      <td style="text-align:center">${i.qty}</td>
      <td style="text-align:right">${fmt(i.unit_price || i.price)}</td>
      <td style="text-align:right;font-weight:600">
        ${fmt((i.unit_price || i.price) * i.qty)}</td>
    </tr>`).join('');

  const method  = s.payment_method || s.pay || '';
  const fecha   = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
  const taxAmt  = s.tax_amt  || s.itbis    || 0;
  const discAmt = s.discount_amt || s.discAmt || 0;
  const discPct = s.discount_pct || s.disc   || 0;

  openModal(`
    <div class="modal-title">Venta #${s.id}</div>
    <div class="modal-sub">
      ${fdate(fecha)} · Cajero: ${s.cajero || '—'}
    </div>
    <div class="g2" style="margin-bottom:14px">
      <div>
        <div class="lbl">Cliente</div>
        <div style="font-weight:600">${s.customer_name || s.clientName || 'Consumidor Final'}</div>
        <div class="ts">${s.customer_rnc || s.clientCedula || 'Sin RNC'}</div>
      </div>
      <div>
        <div class="lbl">Comprobante</div>
        <div style="font-weight:600;text-transform:capitalize">${s.type || 'factura'}</div>
        <div class="ts">Pago: ${method}</div>
      </div>
    </div>
    <div class="tw" style="margin-bottom:12px">
      <table>
        <thead><tr>
          <th>Producto</th>
          <th style="text-align:center">Cant.</th>
          <th style="text-align:right">Precio</th>
          <th style="text-align:right">Subtotal</th>
        </tr></thead>
        <tbody>${itemsRows || '<tr><td colspan="4" style="color:var(--muted2);text-align:center">Sin detalle</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card" style="background:var(--surface2)">
      <div class="tr"><span>Subtotal</span><span>${fmt(s.subtotal)}</span></div>
      ${discPct > 0
        ? `<div class="tr"><span>Descuento (${discPct}%)</span>
           <span>-${fmt(discAmt)}</span></div>` : ''}
      ${taxAmt > 0
        ? `<div class="tr"><span>ITBIS 18%</span><span>${fmt(taxAmt)}</span></div>` : ''}
      <div class="tr grand"><span>TOTAL</span><span>${fmt(s.total)}</span></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-out" onclick="reimprimirVenta(${s.id})">
        ${svg('print')} Reimprimir
      </button>
      ${user?.role === 'admin'
        ? `<button class="btn btn-red" onclick="closeModal();openAnulacionModal(DB.sales.find(x=>x.id===${s.id}))">
             Anular
           </button>`
        : ''}
    </div>
  `, 'modal-lg');
}

// ── Anulación (solo admin) ────────────────────
function openAnulacionModal(s) {
  openModal(`
    <div class="modal-title">Anular Venta #${s.id}</div>
    <div class="modal-sub" style="color:var(--red)">
      Esta acción revierte el inventario y no puede deshacerse.
    </div>
    <div class="fg mt14">
      <label class="lbl">Motivo de anulación *</label>
      <input class="inp" id="anul-reason" type="text"
             placeholder="Error en factura, devolución total..."/>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-red" onclick="confirmarAnulacion(${s.id})">
        ${svg('xmark')} Confirmar Anulación
      </button>
    </div>
  `);
}

async function confirmarAnulacion(saleId) {
  const reason = document.getElementById('anul-reason')?.value?.trim();
  if (!reason) { toast('El motivo es requerido', 'err'); return; }

  const result = await window.api.sales.cancel({
    id: saleId, reason, requestUserId: user.id
  });

  if (!result.ok) { toast(result.error || 'Error al anular', 'err'); return; }

  await reloadSales({ range: ventasRange });
  await reloadProducts();
  closeModal();
  toast(`✓ Venta #${saleId} anulada`);
  renderVentas(document.getElementById('page'));
}

// ── Reimprimir ────────────────────────────────
async function reimprimirVenta(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('Venta no encontrada', 'err'); return; }

  const fecha = (sale.created_at || '').split('T')[0];
  const hora  = sale.created_at
    ? new Date(sale.created_at).toLocaleTimeString('es-DO',
        { hour: '2-digit', minute: '2-digit' })
    : '';

  confirmModal(
    `¿Reimprimir la factura <strong>#${String(saleId).padStart(5,'0')}</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       Quedará registrado en el log de auditoría como reimpresión.
     </span>`,
    () => {
      printReceipt({
        id:              sale.id,
        date:            fecha,
        time:            hora,
        type:            sale.type,
        customer_name:   sale.customer_name  || 'Consumidor Final',
        customer_rnc:    sale.customer_rnc   || '',
        items:           (sale.items || []).map(i => ({
          product_name: i.product_name,
          qty:          i.qty,
          unit_price:   i.unit_price,
          unit_cost:    i.unit_cost || 0,
        })),
        subtotal:        sale.subtotal,
        discount_pct:    sale.discount_pct || 0,
        discount_amt:    sale.discount_amt || 0,
        tax_amt:         sale.tax_amt      || 0,
        total:           sale.total,
        payment_method:  sale.payment_method,
        cajero:          sale.cajero,
      }, true); // true = isReprint
    },
    'Reimprimir',
    'btn-dark'
  );
}

// ── Exportar PDF ventas ───────────────────────
function exportVentasPDF() {
  const rangeLabels = {
    today: 'Hoy', week: 'Esta semana', month: 'Este mes', all: 'Todas'
  };

  const sales = DB.sales.filter(s => s.status !== 'cancelled');
  const total = sales.reduce((a, s) => a + (s.total || 0), 0);

  const rows = [...sales].reverse().map(s => {
    const fecha  = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
    const method = s.payment_method || s.pay || '';
    const name   = s.customer_name  || 'Consumidor Final';
    return `
      <tr>
        <td>#${s.id}</td>
        <td>${fdate(fecha)}</td>
        <td>${name}</td>
        <td style="text-transform:capitalize">${method}</td>
        <td style="text-align:right">${fmt(s.total)}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Ventas</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;padding:20px}
  h2{margin-bottom:2px}.sub{color:#666;margin-bottom:14px;font-size:11px}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:7px 10px;text-align:left;font-size:11px}
  td{padding:7px 10px;border-bottom:1px solid #e5e7eb}
  .total{font-weight:700;font-size:14px;margin-top:10px;text-align:right}
  .foot{margin-top:14px;font-size:10px;color:#9ca3af}
  .no-print{margin-bottom:12px;text-align:right}
  @media print{.no-print{display:none}}
</style></head><body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;
             border-radius:6px;font-size:12px;cursor:pointer">Imprimir</button>
  </div>
  <h2>Historial de Ventas — ${CFG.biz}</h2>
  <div class="sub">
    Período: ${rangeLabels[ventasRange]||ventasRange} ·
    ${sales.length} transacciones · ${fdate(today())}
  </div>
  <table>
    <thead><tr>
      <th>#</th><th>Fecha</th><th>Cliente</th>
      <th>Método</th><th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="total">Total: ${fmt(total)}</div>
  <div class="foot">${CFG.biz} · ${CFG.phone} · ${CFG.addr}</div>
</body></html>`;

  const win = window.open('','_blank','width=860,height=650,scrollbars=yes');
  if (!win) { toast('Activa ventanas emergentes', 'w'); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}

// ══════════════════════════════════════════════
// DEVOLUCIONES
// ══════════════════════════════════════════════
function renderDevoluciones(el) {
  el.innerHTML = '';

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Devoluciones'),
      h('div', { class: 'sec-sub' }, 'Procesar devolución por número de factura')
    )
  ));

  const searchCard = h('div', { class: 'card mb20' });
  searchCard.appendChild(
    h('div', { style: { fontWeight: 700, fontSize: '13px', marginBottom: '12px' } },
      'Buscar factura para devolver')
  );

  const searchRow = h('div', { class: 'flex', style: { gap: '8px' } },
    h('div', { class: 'inp-ic', style: { flex: 1 } },
      h('div', { class: 'ic', html: svg('search') }),
      h('input', {
        class: 'inp', type: 'text', id: 'dev-search-inp',
        placeholder: 'Buscar por # factura (ej: 3), nombre o cédula del cliente...',
        onkeydown: e => { if (e.key === 'Enter') buscarFacturaDevolucion(); }
      })
    ),
    h('button', {
      class: 'btn btn-dark',
      onclick: buscarFacturaDevolucion,
      html: `${svg('search')} Buscar`
    })
  );
  searchCard.appendChild(searchRow);
  searchCard.appendChild(h('div', { id: 'dev-result', style: { marginTop: '14px' } }));
  el.appendChild(searchCard);

  // Historial devoluciones
  const devs = DB.sales.filter(s => s.type === 'devolucion');
  const histCard = h('div', { class: 'card' });
  histCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, `Historial (${devs.length})`)
  ));

  if (!devs.length) {
    histCard.appendChild(h('div', { class: 'empty', style: { padding: '24px' } },
      h('div', { html: svg('return'), style: { color: 'var(--muted2)' } }),
      h('p', null, 'Sin devoluciones registradas')
    ));
  } else {
    const tw  = h('div', { class: 'tw' });
    const tbl = h('table', null,
      h('thead', null,
        h('tr', null,
          ...['#','Fecha','Cliente','Factura Orig.','Total',''].map(t => h('th', null, t))
        )
      )
    );
    const tbody = h('tbody', null);
    [...devs].reverse().forEach(d => {
      const fecha = (d.created_at || d.date || '').split('T')[0].split(' ')[0];
      tbody.appendChild(h('tr', { style: { background: 'var(--red-bg)' } },
        h('td', { class: 'tm' }, `#${d.id}`),
        h('td', { class: 'ts' }, fdate(fecha)),
        h('td', null, h('div', { class: 'tb' }, d.customer_name || d.clientName || '—')),
        h('td', { class: 'tm' }, d.original_sale_id ? `#${d.original_sale_id}` : '—'),
        h('td', null, h('span', { style: { fontWeight: 700, color: 'var(--red)' } },
          `-${fmt(d.total)}`)),
        h('td', null,
          h('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => openDetalleVentaModal(d),
            html: `${svg('eye')} Ver`
          })
        )
      ));
    });
    tbl.appendChild(tbody);
    tw.appendChild(tbl);
    histCard.appendChild(tw);
  }
  el.appendChild(histCard);
}

async function buscarFacturaDevolucion() {
  const q      = document.getElementById('dev-search-inp')?.value?.trim();
  const result = document.getElementById('dev-result');
  if (!result) return;
  result.innerHTML = '<div style="color:var(--muted);font-size:12px">Buscando...</div>';

  await reloadSales({ range: 'all' });

  // Buscar por número (con o sin ceros), nombre de cliente o cédula
  const qNum = parseInt(q) || null;
  const matches = DB.sales.filter(s =>
    s.type !== 'devolucion' && s.status !== 'cancelled' && s.status !== 'returned' && (
      !q ||
      (qNum && s.id === qNum) ||
      String(s.id).padStart(5,'0').includes(q) ||
      (s.customer_name || '').toLowerCase().includes(q.toLowerCase()) ||
      (s.customer_rnc || '').replace(/[-\s]/g,'').includes(q.replace(/[-\s]/g,''))
    )
  );

  result.innerHTML = '';

  if (!matches.length) {
    result.appendChild(h('div', { class: 'alrt a' },
      h('div', { class: 'alrt-dot a' }),
      h('div', null,
        h('div', { class: 'alrt-title' }, q ? 'Sin resultados para esa búsqueda' : 'Sin facturas disponibles'),
        h('div', { class: 'alrt-sub' },
          q
            ? `No se encontró ninguna factura con "${q}". Intenta con el número sin ceros (ej: 3), nombre del cliente o cédula.`
            : 'No hay facturas activas disponibles para devolver. Las devoluciones solo aplican a facturas completadas.'
        )
      )
    ));
    return;
  }

  for (const s of matches) {
    const saleCompleto = await window.api.sales.getById({ id: s.id });
    const items = saleCompleto?.items || [];
    const fecha = (s.created_at || '').split('T')[0].split(' ')[0];

    const card = h('div', { class: 'card', style: { marginBottom: '8px' } });
    card.appendChild(h('div', { class: 'fxb', style: { marginBottom: '8px' } },
      h('div', null,
        h('span', { style: { fontWeight: 700 } }, `Factura #${s.id}`),
        h('span', { class: 'ts', style: { marginLeft: '10px' } },
          `${fdate(fecha)} · ${s.customer_name || 'Consumidor Final'}`)
      ),
      h('div', { style: { fontWeight: 800, fontSize: '15px' } }, fmt(s.total))
    ));

    items.forEach((item, idx) => {
      card.appendChild(h('div', { class: 'devol-item' },
        h('input', { class: 'devol-chk', type: 'checkbox',
          id: `dev-chk-${s.id}-${idx}`, checked: true }),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: '12px', fontWeight: 600 } },
            item.product_name || item.name),
          h('div', { style: { fontSize: '10px', color: 'var(--muted)' } },
            `${item.qty} × ${fmt(item.unit_price || item.price)}`)
        ),
        h('input', {
          class: 'inp', type: 'number',
          id: `dev-qty-${s.id}-${idx}`,
          value: item.qty, min: 1, max: item.qty,
          style: { width: '56px', padding: '4px 6px', fontSize: '12px', textAlign: 'center' }
        })
      ));
    });

    card.appendChild(h('div', { style: { marginTop: '10px' } },
      h('button', {
        class: 'btn btn-red',
        onclick: () => procesarDevolucion(s, items),
        html: `${svg('return')} Procesar Devolución`
      })
    ));
    result.appendChild(card);
  }
}

async function procesarDevolucion(originalSale, items) {
  const returnItems = [];
  items.forEach((item, idx) => {
    const chk   = document.getElementById(`dev-chk-${originalSale.id}-${idx}`);
    const qtyEl = document.getElementById(`dev-qty-${originalSale.id}-${idx}`);
    if (chk?.checked) {
      returnItems.push({
        product_id:   item.product_id,
        product_code: item.product_code || '',
        product_name: item.product_name || item.name,
        unit_cost:    item.unit_cost  || 0,
        unit_price:   item.unit_price || item.price,
        qty: Math.min(parseInt(qtyEl?.value) || item.qty, item.qty),
      });
    }
  });

  if (!returnItems.length) {
    toast('Selecciona al menos un artículo', 'err'); return;
  }

  const subtotal = returnItems.reduce((a, i) => a + i.unit_price * i.qty, 0);
  const taxAmt   = originalSale.type === 'factura' ? subtotal * 0.18 : 0;
  const total    = subtotal + taxAmt;

  confirmModal(
    `¿Procesar devolución de ${returnItems.length} artículo(s) por <strong>${fmt(total)}</strong>?`,
    async () => {
      const result = await window.api.sales.return({
        originalSaleId: originalSale.id,
        items:          returnItems,
        reason:         `Devolución procesada por ${user.name}`,
        requestUserId:  user.id,
      });

      if (!result.ok) { toast(result.error || 'Error al procesar', 'err'); return; }

      await reloadSales({ range: 'all' });
      await reloadProducts();
      await reloadCustomers();
      toast(`✓ Devolución #${result.returnId} registrada — ${fmt(result.total)} devueltos`);
      closeModal();
      renderDevoluciones(document.getElementById('page'));
    },
    'Confirmar Devolución',
    'btn-red'
  );
}