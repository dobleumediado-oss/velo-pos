// ══════════════════════════════════════════════
// ventas.js — Historial de Ventas via IPC
//            · Filtros por fecha y método
//            · Anulación controlada (solo admin)
//            · Devoluciones
//            · Envío e-CF (MSeller)
// ══════════════════════════════════════════════

let ventasSearch = '';
let ventasRange  = 'today';
let ventasPay    = '';
let ventasTab    = 'facturas'; // 'facturas' | 'cotizaciones'

function ventasRound2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function ventasTaxPct(item, fallback = CFG?.itbis ?? 18) {
  const n = parseFloat(item?.tax_pct ?? fallback ?? 18);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 18;
}

function ventasTaxable(item) {
  return item?.taxable !== 0 && item?.taxable !== false && item?.taxable !== '0';
}

function ventasCalcIncludedTotals(items, { type = 'factura', discPct = 0 } = {}) {
  const disc = Math.min(100, Math.max(0, parseFloat(discPct) || 0));
  const grossSubtotal = ventasRound2((items || []).reduce((a, i) => a + ((Number(i.unit_price || i.price) || 0) * (Number(i.qty) || 0)), 0));
  const discAmt = ventasRound2(grossSubtotal * (disc / 100));
  const total = ventasRound2(grossSubtotal - discAmt);
  const factor = 1 - (disc / 100);
  let taxAcc = 0;
  (items || []).forEach(item => {
    if (type !== 'factura' || !ventasTaxable(item)) return;
    const pct = ventasTaxPct(item);
    if (pct <= 0) return;
    const line = ((Number(item.unit_price || item.price) || 0) * (Number(item.qty) || 0)) * factor;
    taxAcc += line - (line / (1 + (pct / 100)));
  });
  const taxAmt = type === 'factura' ? ventasRound2(taxAcc) : 0;
  const subtotal = ventasRound2(total - taxAmt);
  return { subtotal, grossSubtotal, discAmt, taxAmt, total };
}

function ventasEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// En el historial operativo conservamos la referencia corta que el personal
// ya reconoce (#2499, por ejemplo). Para documentos migrados se antepone el
// número histórico real de FabPro; el correlativo fiscal/documental de Velo se
// muestra como identidad secundaria, nunca se pierde.
function ventasHistoryReference(sale) {
  if (!sale) return '';
  const imported = !!String(sale.import_source || '').trim();
  if (imported) {
    const historicalFmt = String(sale.numero_factura_fmt || '').trim();
    if (historicalFmt) return `#${historicalFmt}`;
    if (sale.numero_factura != null && sale.numero_factura !== '') {
      return `#${String(sale.numero_factura).padStart(8, '0')}`;
    }
    if (sale.old_id_factura != null && sale.old_id_factura !== '') {
      return `#${sale.old_id_factura}`;
    }
  }
  if (
    sale.document_kind === 'factura_historica' ||
    (
      sale.numero_factura_fmt &&
      /^\d+$/.test(String(sale.document_number_fmt || sale.numero_factura_fmt).trim())
    )
  ) {
    return `#${String(sale.document_number_fmt || sale.numero_factura_fmt).trim()}`;
  }
  const id = sale.id != null ? sale.id : (sale.sale_id != null ? sale.sale_id : sale.saleId);
  return `#${String(id != null ? id : '')}`;
}

function ventasOriginalHistoryReference(sale) {
  if (!sale) return '';
  return ventasHistoryReference({
    id: sale.original_sale_id,
    document_kind: sale.original_document_kind,
    document_number_fmt: sale.original_document_number_fmt,
    import_source: sale.original_import_source,
    numero_factura: sale.original_numero_factura,
    numero_factura_fmt: sale.original_numero_factura_fmt,
    old_id_factura: sale.original_old_id_factura,
  });
}

function ventasImportSourceLabel(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'equiparts_bak') return 'Importada de FabPro';
  return normalized ? 'Documento importado' : '';
}

function ventasLoadResaleCart() {
  try {
    const raw = sessionStorage.getItem('vp_resale_cart');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

let ventasResaleCart = ventasLoadResaleCart();

function ventasSaveResaleCart() {
  try { sessionStorage.setItem('vp_resale_cart', JSON.stringify(ventasResaleCart)); } catch {}
}

function ventasFindResaleProduct(item) {
  const pid = Number(item?.product_id || item?.pid || 0);
  if (pid) {
    const direct = DB.products.find(p => Number(p.id) === pid && p.active !== 0);
    if (direct) return direct;
  }
  const code = String(item?.product_code || item?.code || '').trim().toLowerCase();
  if (code) {
    return DB.products.find(p => p.active !== 0 && String(p.code || '').trim().toLowerCase() === code) || null;
  }
  return null;
}

function ventasResaleProductQty(productId, exceptUid = '') {
  return ventasResaleCart.reduce((sum, item) => {
    if (item.uid === exceptUid) return sum;
    return Number(item.product_id) === Number(productId) ? sum + (Number(item.qty) || 0) : sum;
  }, 0);
}

function ventasResaleLineKey(saleId, item, idx, productId, price) {
  return [saleId, item?.id || idx, productId, ventasRound2(price)].join(':');
}

function ventasLineFinalUnitPrice(item, sale) {
  const fiscal = ventasLineFiscal(item, sale || {});
  const qty = Math.max(1, Number(fiscal.qty || item?.qty) || 1);
  const gross = Number(fiscal.gross);
  if (Number.isFinite(gross) && gross > 0) return ventasRound2(gross / qty);
  return ventasRound2(Number(item?.unit_price ?? item?.price) || 0);
}

function ventasSameResaleCustomer() {
  const keyed = ventasResaleCart
    .map(i => {
      const id = Number(i.customer_id || 0);
      const name = String(i.customer_name || '').trim().toLowerCase();
      const rnc = String(i.customer_rnc || '').replace(/\D/g, '');
      if (id && id !== 1) return `id:${id}`;
      if (name || rnc) return `cf:${name}|${rnc}`;
      return '';
    })
    .filter(Boolean);
  const keys = [...new Set(keyed)];
  if (keys.length !== 1) return null;
  const first = ventasResaleCart.find(i => {
    const id = Number(i.customer_id || 0);
    const name = String(i.customer_name || '').trim().toLowerCase();
    const rnc = String(i.customer_rnc || '').replace(/\D/g, '');
    const key = id && id !== 1 ? `id:${id}` : (name || rnc ? `cf:${name}|${rnc}` : '');
    return key === keys[0];
  });
  return {
    id: first.customer_id || 1,
    name: first.customer_name || '',
    rnc: first.customer_rnc || '',
  };
}

function renderVentasResaleCart() {
  const pageEl = document.getElementById('page');
  document.getElementById('ventas-resale-cart')?.remove();
  if (!pageEl || (typeof page !== 'undefined' && page !== 'ventas') || !ventasResaleCart.length) return;

  const totalQty = ventasResaleCart.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const total = ventasRound2(ventasResaleCart.reduce((a, i) => a + ((Number(i.unit_price) || 0) * (Number(i.qty) || 0)), 0));
  const box = document.createElement('div');
  box.id = 'ventas-resale-cart';
  box.style.cssText = [
    'position:fixed', 'right:22px', 'bottom:22px', 'z-index:500',
    'width:min(390px,calc(100vw - 44px))', 'background:var(--surface)',
    'border:1px solid var(--line)', 'border-radius:10px', 'box-shadow:0 14px 42px #0003',
    'overflow:hidden'
  ].join(';');
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--surface2)">
      <div style="width:30px;height:30px;border-radius:8px;background:var(--green-bg);color:var(--green);display:flex;align-items:center;justify-content:center">${svg('return')}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:800;font-size:13px">Carrito de reventa</div>
        <div style="font-size:11px;color:var(--muted2)">${totalQty} artículo${totalQty !== 1 ? 's' : ''} · ${fmt(total)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-resale-action="clear" title="Vaciar">${svg('trash')}</button>
    </div>
    <div style="max-height:270px;overflow:auto;padding:8px 10px">
      ${ventasResaleCart.map(item => {
        const prod = DB.products.find(p => Number(p.id) === Number(item.product_id));
        const stock = Number(prod?.stock || 0);
        const reserved = ventasResaleProductQty(item.product_id, item.uid);
        const sourceMax = Number.parseInt(item.source_qty, 10) || Number(item.qty) || 1;
        const max = Math.max(0, Math.min(sourceMax, stock - reserved));
        const qtyValue = Math.max(1, Math.min(Number(item.qty) || 1, Math.max(1, max)));
        return `
          <div data-uid="${ventasEsc(item.uid)}" style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line2)">
            <div style="min-width:0">
              <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ventasEsc(item.product_name)}</div>
              <div style="font-size:10px;color:var(--muted2)">Venta #${String(item.source_sale_id).padStart(5,'0')} · ${fmt(item.unit_price)} · stock ${stock}</div>
            </div>
            <input class="inp" data-resale-action="qty" type="number" min="1" max="${Math.max(1, max)}" value="${qtyValue}"
              style="width:58px;padding:4px 6px;text-align:center;font-size:12px" ${max <= 0 ? 'disabled' : ''}/>
            <button class="btn btn-ghost btn-sm" data-resale-action="remove" style="color:var(--red)" title="Quitar">×</button>
          </div>`;
      }).join('')}
    </div>
    <div style="display:flex;gap:8px;align-items:center;padding:10px 12px;border-top:1px solid var(--line);background:var(--surface)">
      <button class="btn btn-out btn-sm" data-resale-action="keep" style="flex:0 0 auto">Seguir eligiendo</button>
      <button class="btn btn-dark btn-sm" data-resale-action="send" style="flex:1">${svg('cash')} Enviar a punto de venta</button>
    </div>`;

  box.addEventListener('click', e => {
    const action = e.target.closest('[data-resale-action]')?.dataset.resaleAction;
    const row = e.target.closest('[data-uid]');
    if (action === 'remove' && row) ventasRemoveResaleItem(row.dataset.uid);
    if (action === 'clear') ventasClearResaleCart();
    if (action === 'send') ventasSendResaleToPOS();
    if (action === 'keep') toast('Abre otra venta y agrega más artículos', 'ok');
  });
  box.addEventListener('change', e => {
    if (e.target?.dataset?.resaleAction !== 'qty') return;
    const row = e.target.closest('[data-uid]');
    if (row) ventasSetResaleQty(row.dataset.uid, e.target.value);
  });
  pageEl.appendChild(box);
}

function ventasAddResaleItem(saleId, idx) {
  const cache = window._ventasDetalleCache?.[saleId];
  const item = cache?.items?.[idx];
  if (!item) { toast('No se encontró la línea de venta', 'err'); return; }
  const prod = ventasFindResaleProduct(item);
  if (!prod) { toast('Ese artículo no está vinculado a un producto activo', 'err'); return; }
  if ((Number(prod.stock) || 0) <= 0) { toast(`"${prod.name}" no tiene stock disponible`, 'w'); return; }

  const detail = cache.detail || {};
  const input = document.querySelector(`[data-resale-qty="${saleId}:${idx}"]`);
  const requested = Math.max(1, Number.parseInt(input?.value, 10) || 1);
  const soldQty = Math.max(1, Number.parseInt(item.qty, 10) || 1);
  const unitPrice = ventasLineFinalUnitPrice(item, detail);
  if (unitPrice <= 0) { toast('La línea no tiene precio de venta válido', 'err'); return; }

  const uid = ventasResaleLineKey(saleId, item, idx, prod.id, unitPrice);
  const existing = ventasResaleCart.find(x => x.uid === uid);
  const alreadyOther = ventasResaleProductQty(prod.id, uid);
  const currentQty = existing ? Number(existing.qty) || 0 : 0;
  const available = Math.max(0, (Number(prod.stock) || 0) - alreadyOther - currentQty);
  const remainingFromSource = Math.max(0, soldQty - currentQty);
  const addQty = Math.min(requested, remainingFromSource, available);
  if (addQty <= 0) { toast('No hay stock libre para agregar más de ese producto', 'w'); return; }

  const lineTaxable = (detail.type || 'factura') === 'factura' && ventasTaxable(item);
  const payload = {
    uid,
    product_id: prod.id,
    product_code: prod.code || ventasItemCode(item),
    product_name: item.product_name || item.name || prod.name,
    unit_price: unitPrice,
    qty: addQty,
    source_qty: soldQty,
    source_sale_id: saleId,
    source_item_id: item.id || idx,
    customer_id: detail.customer_id || detail.clientId || 0,
    customer_name: detail.customer_name || detail.clientName || '',
    customer_rnc: detail.customer_rnc || detail.clientCedula || '',
    taxable: lineTaxable ? 1 : 0,
    tax_pct: lineTaxable ? ventasTaxPct(item, detail.tax_pct ?? CFG.itbis ?? 18) : 0,
  };
  if (existing) existing.qty += addQty;
  else ventasResaleCart.push(payload);
  ventasSaveResaleCart();
  renderVentasResaleCart();
  toast(`✓ ${payload.product_name} agregado a reventa`);
}

function ventasSetResaleQty(uid, qtyRaw) {
  const item = ventasResaleCart.find(i => i.uid === uid);
  if (!item) return;
  const prod = DB.products.find(p => Number(p.id) === Number(item.product_id));
  const reserved = ventasResaleProductQty(item.product_id, uid);
  const sourceMax = Number.parseInt(item.source_qty, 10) || Number(item.qty) || 1;
  const max = Math.max(1, Math.min(sourceMax, (Number(prod?.stock) || 0) - reserved));
  item.qty = Math.max(1, Math.min(Number.parseInt(qtyRaw, 10) || 1, max));
  ventasSaveResaleCart();
  renderVentasResaleCart();
}

function ventasRemoveResaleItem(uid) {
  ventasResaleCart = ventasResaleCart.filter(i => i.uid !== uid);
  ventasSaveResaleCart();
  renderVentasResaleCart();
}

function ventasClearResaleCart(silent = false) {
  ventasResaleCart = [];
  ventasSaveResaleCart();
  renderVentasResaleCart();
  if (!silent) toast('Carrito de reventa vacío');
}

function ventasBuildResalePayload() {
  return {
    items: ventasResaleCart.map(i => ({ ...i })),
    customer: ventasSameResaleCustomer(),
  };
}

function ventasSendResaleToPOS() {
  if (!ventasResaleCart.length) { toast('No hay artículos para enviar', 'w'); return; }
  const payload = ventasBuildResalePayload();
  window._pendingPOSResaleCart = payload;
  document.getElementById('ventas-resale-cart')?.remove();
  if (typeof closeModal === 'function') closeModal();
  routeTo('pos');
  setTimeout(() => {
    if (
      window._pendingPOSResaleCart === payload &&
      typeof window.posLoadResaleCart === 'function' &&
      document.getElementById('cart-wrap')
    ) {
      window._pendingPOSResaleCart = null;
      window.posLoadResaleCart(payload);
    }
  }, 180);
}

window.ventasClearResaleCart = ventasClearResaleCart;
window.ventasAddResaleItem = ventasAddResaleItem;

function ventasItemCode(item) {
  const direct = item?.product_code || item?.code || item?.sku;
  if (direct) return direct;
  const prod = (DB?.products || []).find(p => p.id === item?.product_id);
  return prod?.code || '';
}

function ventasDisplayProductName(value) {
  const clean = String(value || 'Producto').trim();
  return clean
    .replace(/^["'“”]+/, '')
    .replace(/["'“”]+$/, '')
    .trim() || 'Producto';
}

function ventasLineFiscal(item, sale) {
  const qty = Number(item?.qty) || 0;
  const unit = Number(item?.unit_price ?? item?.price) || 0;
  const storedSubtotal = Number(item?.subtotal);
  const hasSnapshot =
    (item?.net_subtotal !== null && item?.net_subtotal !== undefined) ||
    (item?.tax_amt !== null && item?.tax_amt !== undefined);

  if (hasSnapshot) {
    const gross = Number.isFinite(storedSubtotal) ? storedSubtotal : ventasRound2(unit * qty);
    const tax = ventasRound2(Number(item?.tax_amt) || 0);
    const net = item?.net_subtotal !== null && item?.net_subtotal !== undefined
      ? ventasRound2(Number(item.net_subtotal) || 0)
      : ventasRound2(gross - tax);
    return {
      qty,
      unitNet: qty ? ventasRound2(net / qty) : 0,
      net,
      tax,
      gross: ventasRound2(net + tax),
    };
  }

  const disc = Math.min(100, Math.max(0, parseFloat(sale?.discount_pct || sale?.disc || 0) || 0));
  const factor = 1 - (disc / 100);
  // Línea legacy/importada sin desglose guardado: el precio es FINAL con ITBIS
  // INCLUIDO (convención del sistema y del POS viejo). El impuesto se EXTRAE del
  // precio (1,200 = 1,016.95 + 183.05) — sumarlo encima inflaría el total cobrado.
  const gross = ventasRound2((Number.isFinite(storedSubtotal) ? storedSubtotal : unit * qty) * factor);
  const isFactura = (sale?.type || 'factura') === 'factura';
  const rawPct = item?.tax_pct ?? sale?.tax_pct;
  const pct = isFactura && ventasTaxable(item)
    ? Math.max(0, Math.min(100, parseFloat(rawPct) || 0)) : 0;
  const net = pct > 0 ? ventasRound2(gross / (1 + pct / 100)) : gross;
  const tax = ventasRound2(gross - net);
  return {
    qty,
    unitNet: qty ? ventasRound2(net / qty) : unit,
    net,
    tax,
    gross,
  };
}

function renderVentas(el) {
  el.innerHTML = '';

  // Respetar tab inicial desde dashboard
  if (window._ventasTabInicial) {
    ventasTab = window._ventasTabInicial;
    delete window._ventasTabInicial;
  }

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

  // ── Tabs ──────────────────────────────────────
  el.appendChild(h('div', { class: 'tabs', style: { marginBottom: '12px' } },
    h('button', {
      class: `tab ${ventasTab === 'facturas' ? 'on' : ''}`,
      onclick: () => { ventasTab = 'facturas'; renderVentas(el); }
    }, 'Facturas / Recibos'),
    h('button', {
      class: `tab ${ventasTab === 'cotizaciones' ? 'on' : ''}`,
      onclick: () => { ventasTab = 'cotizaciones'; renderVentas(el); }
    }, 'Cotizaciones')
  ));

  // ── Filtros ───────────────────────────────────
  el.appendChild(
    h('div', { class: 'flex', style: { marginBottom: '14px', gap: '8px', flexWrap: 'wrap' } },
      h('div', { class: 'inp-ic', style: { flex: 1, minWidth: '200px' } },
        h('div', { class: 'ic', html: svg('search') }),
        h('input', {
          class: 'inp', type: 'text',
          placeholder: 'Buscar por cliente, # factura, RNC, teléfono, producto, modelo...',
          value: ventasSearch,
          oninput: e => {
            ventasSearch = e.target.value;
            clearTimeout(window._ventasSearchTimer);
            window._ventasSearchTimer = setTimeout(() => refreshVentas(el), 150);
          }
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
      ventasTab === 'facturas' ? (() => {
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
      })() : null
    )
  );

  const resWrap   = h('div', { id: 'ventas-resumen' });
  const tableWrap = h('div', { id: 'ventas-table-wrap' });
  el.appendChild(resWrap);
  el.appendChild(tableWrap);
  renderVentasResaleCart();

  refreshVentas(el);
}

async function refreshVentas(el) {
  // La vista de Ventas excluye anuladas y notas de crédito, pero conserva la
  // factura original cuando está ajustada para que nunca "desaparezca".
  await reloadSales({ range: ventasRange, view: 'sales' });
  renderVentasTable();
}

function ventasEffectiveTotal(sale) {
  if (
    sale?.type === 'factura' &&
    sale?.correction_kind !== 'product_addition' &&
    (
      Number(sale?.adjustment_addition_total || 0) > 0.005 ||
      Number(sale?.operation_credit_total || 0) > 0.005
    )
  ) {
    return ventasOperationTotal(sale);
  }
  return Math.max(0, ventasRound2(
    Number(sale?.total || 0) - Number(sale?.adjustment_credit_total || 0)
  ));
}

function ventasOperationTotal(sale) {
  return Math.max(0, ventasRound2(
    Number(sale?.total || 0) +
    Number(sale?.adjustment_addition_total || 0) -
    Number(sale?.operation_credit_total ?? sale?.adjustment_credit_total ?? 0)
  ));
}

function ventasHasAdjustedCopy(sale) {
  return sale?.type === 'factura' &&
    sale?.correction_kind !== 'product_addition' &&
    Array.isArray(sale?.adjusted_items) &&
    (
      Number(sale?.adjustment_addition_total || 0) > 0.005 ||
      Number(sale?.operation_credit_total || 0) > 0.005
    );
}

function renderVentasTable() {
  const resWrap   = document.getElementById('ventas-resumen');
  const tableWrap = document.getElementById('ventas-table-wrap');
  if (!tableWrap) return;

  const q = ventasSearch.trim();
  const qNorm   = searchNorm(q);
  const qDigits = digitsOf(q);
  const esCotizTab = ventasTab === 'cotizaciones';

  let sales = DB.sales.filter(s => {
    const method = s.payment_method || s.pay || '';
    const name   = s.customer_name  || s.clientName || '';
    const rnc    = s.customer_rnc   || s.clientCedula || '';

    // Filtrar por tab
    if (esCotizTab) {
      if (s.type !== 'cotizacion') return false;
      if (s.status === 'cancelled') return false;
    } else {
      if (s.type === 'cotizacion') return false;
      if (s.type === 'devolucion') return false;
      // La factura original permanece visible aun con devolución total; solo una
      // anulación la retira del historial operativo de Ventas.
      if (!['completed','returned'].includes(s.status)) return false;
    }

    // Filtro de método (solo facturas)
    const matchPay = esCotizTab || !ventasPay || method === ventasPay;

    // Búsqueda extendida: #, cliente, RNC, teléfono, producto (código/nombre/modelo)
    const matchQ = !qNorm ||
      String(s.id).includes(q) ||
      matchText(facturaLabel(s), qNorm) ||
      matchText(ventasHistoryReference(s), qNorm) ||
      matchText(facturaLabelOriginal(s), qNorm) ||
      matchText(ventasOriginalHistoryReference(s), qNorm) ||
      matchText(name, qNorm) ||
      matchText(rnc, qNorm) ||
      matchText(s.customer_contact_name, qNorm) ||
      matchText(s.customer_contact_role, qNorm) ||
      matchDigits(s.customer_contact_phone, qDigits) ||
      matchDigits(rnc, qDigits) ||
      // Teléfono del cliente — solo si la búsqueda trae dígitos (anti falso positivo)
      (() => {
        const cli = DB.customers.find(c => c.id === (s.customer_id || s.clientId));
        return cli && matchDigits(cli.phone, qDigits);
      })() ||
      // Nombre, código o modelo del producto en los items.
      // getAll() entrega items_summary (string "Prod x2 | Otro x1") cuando
      // items[] no está cargado; lo usamos como respaldo para no perder el match.
      (s.items && s.items.length
        ? s.items.some(i =>
            matchText(i.product_name || i.name, qNorm) ||
            matchText(i.product_code || i.code, qNorm) ||
            (() => {
              const prod = DB.products.find(p => p.id === i.product_id);
              return matchText(prod?.model, qNorm);
            })()
          )
        : matchText(s.items_summary, qNorm));

    return matchPay && matchQ;
  });

  // Resumen
  if (resWrap) {
    resWrap.innerHTML = '';
    const total = sales.reduce((a, s) => a + ventasEffectiveTotal(s), 0);

    const resGrid = h('div', { class: 'metrics',
      style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '16px' } });

    const metItems = esCotizTab ? [
      { icon: 'list',   color: 'p', label: 'Cotizaciones',   val: sales.length },
      { icon: 'dollar', color: 'g', label: 'Valor Total',    val: fmt(total) },
      { icon: 'clock',  color: 'a', label: 'Pendientes hoy', val: sales.filter(s => (s.sale_date||'').slice(0,10) === today()).length },
      { icon: 'check',  color: 'b', label: 'Convertibles',   val: sales.filter(s => s.status !== 'cancelled').length },
    ] : [
      { icon: 'list',  color: 'b', label: 'Documentos', val: sales.length },
      { icon: 'dollar',color: 'g', label: 'Total neto documentos', val: fmt(total) },
      { icon: 'cash',  color: 'g', label: 'Efectivo neto', val: fmt(sales.filter(s => (s.payment_method||s.pay) === 'efectivo').reduce((a,s)=>a+ventasEffectiveTotal(s),0)) },
      { icon: 'card',  color: 'p', label: 'Tarj/Trans neto', val: fmt(sales.filter(s => ['tarjeta','transferencia'].includes(s.payment_method||s.pay||'')).reduce((a,s)=>a+ventasEffectiveTotal(s),0)) },
    ];

    metItems.forEach(m => {
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
      h('p', null, esCotizTab ? 'Sin cotizaciones en este período' : 'Sin ventas en este período')
    ));
    return;
  }

  const card  = h('div', { class: 'card' });
  const tw    = h('div', { class: 'tw' });
  const tbl   = h('table', null,
    h('thead', null,
      h('tr', null,
        ...['Documento','Fecha','Cliente','Método','ITBIS','Total',''].map(t =>
          h('th', null, t)
        )
      )
    )
  );
  const tbody = h('tbody', null);

  // Mantener preparada la agrupación de cada factura con sus respaldos de
  // aumento. La vista normal solo recibe la raíz; auditoría conserva la familia.
  const operationId = row => row.correction_kind === 'product_addition' && row.original_sale_id
    ? Number(row.original_sale_id) : Number(row.id);
  const operationDates = new Map();
  sales.forEach(row => {
    const key = operationId(row);
    const date = String(row.sale_date || row.created_at || '');
    if (date > String(operationDates.get(key) || '')) operationDates.set(key, date);
  });
  [...sales].sort((a, b) => {
    const rootA = operationId(a);
    const rootB = operationId(b);
    if (rootA !== rootB) {
      return String(operationDates.get(rootB) || '').localeCompare(String(operationDates.get(rootA) || '')) ||
        rootB - rootA;
    }
    const aSupplement = a.correction_kind === 'product_addition' ? 1 : 0;
    const bSupplement = b.correction_kind === 'product_addition' ? 1 : 0;
    return aSupplement - bSupplement || Number(a.id) - Number(b.id);
  }).forEach(s => {
    const method    = s.payment_method || s.pay || '';
    const cliName   = s.customer_name  || s.clientName || 'Consumidor Final';
    const fecha     = (s.sale_date || s.date || '').split('T')[0].split(' ')[0];
    const hora      = s.created_at
      ? new Date(s.created_at).toLocaleTimeString('es-DO',
          { hour: '2-digit', minute: '2-digit' })
      : (s.time || '');
    // Legacy/importada sin ITBIS en cabecera: extraerlo del total (precio final
    // con impuesto incluido), igual que el detalle y la impresión.
    let taxAmt = s.tax_amt || s.itbis || 0;
    if (!taxAmt && (s.type || 'factura') === 'factura' && Number(s.tax_pct) > 0 && Number(s.total) > 0) {
      taxAmt = ventasRound2(s.total - s.total / (1 + Number(s.tax_pct) / 100));
    }
    const tieneNcf  = !!(s.ncf);
    const ecfOk     = s.ecf_status === 'Aceptado';
    const adjusted = Number(s.has_product_correction) === 1 || Number(s.has_active_return) === 1 ||
      s.correction_kind === 'product_addition';
    const isSupplement = s.correction_kind === 'product_addition' && s.original_sale_id;
    const effectiveTotal = ventasEffectiveTotal(s);
    const operationTotal = !isSupplement && adjusted ? ventasOperationTotal(s) : effectiveTotal;

    // Badge e-CF en la columna # (junto al tipo)
    const ecfBadge = tieneNcf
      ? h('div', {
          style: { fontSize: '9px', marginTop: '2px' },
          html: ecfOk
            ? `<span class="badge g" style="font-size:9px;padding:1px 5px">e-CF ✓</span>`
            : `<span class="badge n" style="font-size:9px;padding:1px 5px">e-CF</span>`
        })
      : null;

    tbody.appendChild(
      h('tr', { class: isSupplement ? 'sale-supplement-row' : adjusted ? 'sale-operation-row' : '' },
        h('td', null,
          h('span', { class: 'tm', style: { fontSize: '12px' } }, ventasHistoryReference(s)),
          h('div', { class: 'sale-document-identity' },
            s.import_source
              ? ventasImportSourceLabel(s.import_source)
              : s.document_kind === 'factura_historica'
                ? 'Numeración histórica continuada'
                : (s.document_number_fmt ? `Velo · ${s.document_number_fmt}` : 'Velo')),
          h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } },
            isSupplement
              ? `Aumento vinculado a ${ventasOriginalHistoryReference(s)}`
              : s.type === 'factura' ? (s.import_source ? 'Factura histórica' : 'Factura original') : s.type),
          adjusted
            ? h('div', {
                style: { marginTop: '3px' },
                html: `<span class="badge a" style="font-size:9px;padding:1px 5px">${
                  s.status === 'returned' ? 'Devuelta total' :
                  s.correction_kind === 'product_addition' ? 'Aumento vinculado' : 'Ajustada'
                }</span>`
              })
            : null,
          ecfBadge
        ),
        h('td', null,
          h('div', { style: { fontSize: '12px', fontWeight: 500 } }, fdate(fecha)),
          h('div', { class: 'ts' }, hora)
        ),
        h('td', null,
          h('div', { class: 'tb' }, cliName),
          h('div', { class: 'ts' }, s.cajero || ''),
          s.salesperson_name
            ? h('div', { class: 'ts', style: { color: 'var(--green)' } },
                `Vendedor: ${s.salesperson_code ? s.salesperson_code + ' · ' : ''}${s.salesperson_name}`)
            : null,
          // Badges de modelos únicos en esta venta
          (() => {
            const models = [...new Set(
              (s.items||[]).map(i => {
                const p = DB.products.find(x => x.id === i.product_id);
                return p?.model || '';
              }).filter(Boolean)
            )];
            if (!models.length) return null;
            const wrap = h('div', { style: { display:'flex',flexWrap:'wrap',gap:'3px',marginTop:'4px' } });
            models.slice(0,3).forEach(m => {
              wrap.appendChild(h('span', {
                style: { fontSize:'10px',fontWeight:'600',color:'var(--blue)',
                         background:'var(--blue-bg,#eff6ff)',padding:'1px 6px',
                         borderRadius:'20px',display:'inline-block' }
              }, m));
            });
            if (models.length > 3) wrap.appendChild(h('span',{
              style:{fontSize:'10px',color:'var(--muted2)'}
            }, `+${models.length-3}`));
            return wrap;
          })()
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
          h('span', { style: { fontWeight: 700, fontSize: '14px' } }, fmt(operationTotal)),
          !isSupplement && adjusted
            ? h('div', { class: 'ts' },
                `Operación: original ${fmt(s.total)} + aumentos ${fmt(s.adjustment_addition_total || 0)} − créditos ${fmt(s.operation_credit_total || 0)}`)
            : isSupplement
              ? h('div', { class: 'ts' }, `Documento relacionado · ${fmt(effectiveTotal)}`)
              : null
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
            // Botón e-CF — solo si tiene NCF y no está ya aceptado
            tieneNcf && !ecfOk
              ? h('button', {
                  class: 'btn btn-sm',
                  style: { background: '#0066cc', color: '#fff', border: 'none' },
                  title: `Enviar e-CF para factura ${s.ncf}`,
                  onclick: () => enviarEcf(s.id),
                  html: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg> e-CF`
                })
              : null,
            // Botón convertir cotización → venta
            (s.type === 'cotizacion' || s.itype === 'cotizacion') && s.status !== 'cancelled'
              ? h('button', {
                  class: 'btn btn-green btn-sm',
                  title: 'Convertir cotización en venta',
                  onclick: () => convertirCotizacionAVenta(s),
                  html: `${svg('check')} Convertir`
                })
              : null,
            s.status === 'completed' && s.type === 'cotizacion'
              ? h('button', {
                  class: 'btn btn-ghost btn-sm',
                  style: { color: 'var(--red)' },
                  title: 'Eliminar cotización',
                  onclick: () => eliminarCotizacion(s),
                  html: `${svg('trash')} Eliminar`
                })
              : null,
            ['admin','superadmin'].includes(user?.role) &&
            s.status === 'completed' && s.type !== 'cotizacion'
              ? h('button', {
                  class: 'btn btn-ghost btn-sm',
                  style: { color: 'var(--red)' },
                  title: 'Anular venta',
                  onclick: () => openAnulacionModal(s),
                  html: `${svg('xmark')} Anular`
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

// ── Enviar e-CF ───────────────────────────────
async function enviarEcf(saleId) {
  const sale = DB.sales.find(s => s.id === saleId);
  if (!sale) { toast('Venta no encontrada', 'err'); return; }
  if (!sale.ncf) { toast('Esta venta no tiene NCF asignado', 'w'); return; }
  if (sale.ecf_status === 'Aceptado') { toast('Ya tiene e-CF emitido', 'w'); return; }

  confirmModal(
    `¿Enviar e-CF para la factura <strong>${facturaLabel(sale)}</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       NCF: <strong>${sale.ncf}</strong> · Total: <strong>${fmt(sale.total)}</strong>
       <br>Se enviará a la DGII vía MSeller ECF.
     </span>`,
    async () => {
      // Mostrar estado de carga en el modal
      const modalBody = document.querySelector('.modal-body, .modal');
      if (modalBody) {
        modalBody.innerHTML = `
          <div style="text-align:center;padding:32px">
            <div style="font-size:13px;color:var(--muted);margin-bottom:8px">Enviando e-CF a DGII...</div>
            <div style="font-size:11px;color:var(--muted2)">NCF: ${sale.ncf}</div>
          </div>`;
      }

      const result = await window.api.ecf.emit({ saleId, requestUserId: user.id });

      if (!result.ok) {
        closeModal();
        toast(result.error || 'Error al enviar e-CF', 'err');
        return;
      }

      closeModal();

      // Recargar para reflejar el nuevo ecf_status
      await reloadSales({ range: ventasRange, view: 'sales' });
      renderVentasTable();

      // Toast de éxito con QR si está disponible
      toast(`✓ e-CF enviado — ${result.encf || sale.ncf}`);

      // Si hay QR, ofrecer verlo
      if (result.qr || result.pdf) {
        setTimeout(() => openEcfResultModal(result, sale), 300);
      }
    },
    'Enviar e-CF',
    'btn-primary'
  );
}

function openEcfResultModal(result, sale) {
  const qrHtml = result.qr
    ? `<div style="text-align:center;margin:16px 0">
         <img src="${result.qr}" alt="QR e-CF"
              style="width:160px;height:160px;border:1px solid var(--border);border-radius:8px"/>
         <div class="ts" style="margin-top:6px">Código QR del comprobante</div>
       </div>`
    : '';

  const pdfBtn = result.pdf
    ? `<a href="${result.pdf}" target="_blank" class="btn btn-out" style="text-decoration:none">
         ${svg('pdf')} Ver PDF
       </a>`
    : '';

  openModal(`
    <div class="modal-title" style="color:var(--green)">✓ e-CF Emitido</div>
    <div class="modal-sub">Comprobante fiscal electrónico aceptado por la DGII</div>
    <div class="card" style="background:var(--surface2);margin:14px 0">
      <div class="tr"><span>e-NCF</span><span style="font-family:monospace;font-weight:700">${result.encf || sale.ncf}</span></div>
      <div class="tr"><span>Factura</span><span>${facturaLabel(sale)}</span></div>
      <div class="tr"><span>Cliente</span><span>${sale.customer_name || 'Consumidor Final'}</span></div>
      <div class="tr grand"><span>Total</span><span>${fmt(sale.total)}</span></div>
    </div>
    ${qrHtml}
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      ${pdfBtn}
    </div>
  `);
}

// ── Detalle de venta ──────────────────────────
async function convertirCotizacionAVenta(s) {
  const sale = await window.api.sales.getById({ id: s.id });
  if (!sale) { toast('Cotización no encontrada', 'err'); return; }

  // Estado editable de la conversión
  const estadoPrev = window._convEstado;
  const estado = estadoPrev && window._convSale?.id === s.id ? estadoPrev : {
    items: (sale.items || []).map(i => ({
      product_id:   i.product_id,
      product_code: i.product_code || '',
      product_name: i.product_name || i.name || '',
        unit_cost:    i.unit_cost  || 0,
        unit_price:   i.unit_price || i.price || 0,
        taxable:      i.taxable ?? 1,
        tax_pct:      i.tax_pct ?? CFG.itbis ?? 18,
        qty:          i.qty || 1,
        _stock:       DB.products.find(p => p.id === i.product_id)?.stock ?? null,
      })),
    pay:      'efectivo',
    discount: sale.discount_pct || 0,
  };
  window._convEstado = estado;
  window._convSale   = sale;
  window._convOrigId = s.id;

  // Calcular totales
    const { subtotal, discAmt, taxAmt, total } = ventasCalcIncludedTotals(
      estado.items,
      { type: 'factura', discPct: estado.discount }
    );

  const itemsHTML = estado.items.map((it, idx) => {
    const stockOk = it._stock === null || it._stock >= it.qty;
    const stockLabel = it._stock === null
      ? '<span style="color:var(--muted2);font-size:10px">—</span>'
      : it._stock === 0
        ? '<span style="color:var(--red);font-size:10px;font-weight:600">Sin stock</span>'
        : it._stock < it.qty
          ? `<span style="color:var(--amber);font-size:10px">Stock: ${it._stock} ⚠</span>`
          : `<span style="color:var(--green);font-size:10px">Stock: ${it._stock} ✓</span>`;

    return `
      <tr style="background:${!stockOk && it._stock !== null && it._stock >= 0 ? 'rgba(245,158,11,.06)' : ''}">
        <td style="padding:6px 8px">
          <div style="font-weight:500;font-size:13px">${it.product_name}</div>
          ${stockLabel}
        </td>
        <td style="padding:6px;text-align:center">
          <div style="display:flex;align-items:center;gap:4px;justify-content:center">
            <button onclick="convCotizQty(${idx},-1)"
              style="width:24px;height:24px;border:1px solid var(--line);border-radius:4px;
                     background:var(--surface2);cursor:pointer;font-size:14px;line-height:1">−</button>
            <input id="conv-qty-${idx}" type="number" min="0" value="${it.qty}"
              style="width:50px;text-align:center;border:1px solid var(--line);
                     border-radius:4px;padding:3px;font-size:13px"
              oninput="if(window._convEstado)window._convEstado.items[${idx}].qty=Math.max(0,parseInt(this.value)||0)"/>
            <button onclick="convCotizQty(${idx},1)"
              style="width:24px;height:24px;border:1px solid var(--line);border-radius:4px;
                     background:var(--surface2);cursor:pointer;font-size:14px;line-height:1">+</button>
          </div>
        </td>
        <td style="padding:6px 8px;text-align:right;font-size:13px">${fmt(it.unit_price)}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:600;font-size:13px">${fmt(it.unit_price * it.qty)}</td>
        <td style="padding:6px;text-align:center">
          <button onclick="convCotizRemove(${idx})"
            style="background:none;border:none;color:var(--red);cursor:pointer;font-size:18px;line-height:1"
            title="Eliminar">×</button>
        </td>
      </tr>`;
  }).join('');

  const hayStockBajo = estado.items.some(it =>
    it._stock !== null && it._stock >= 0 && it._stock < it.qty && it.qty > 0);

  openModal(`
    <div class="modal-title">Convertir Cotización ${facturaLabel(sale)} en Venta</div>
    <div class="modal-sub">
      Cliente: <strong>${sale.customer_name || 'Consumidor Final'}</strong> ·
      ${sale.sale_date || ''}
    </div>

    ${hayStockBajo ? `
      <div class="alrt a" style="margin-bottom:10px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Stock insuficiente en algunos productos</div>
          <div class="alrt-sub">Ajusta las cantidades o elimina los que no puedas despachar ahora.</div>
        </div>
      </div>` : ''}

    <div style="border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:12px">
      <div style="overflow-y:auto;max-height:280px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface2)">
              <th style="padding:8px;text-align:left;font-size:11px;border-bottom:1px solid var(--line)">Producto</th>
              <th style="padding:8px;text-align:center;font-size:11px;border-bottom:1px solid var(--line)">Cant.</th>
              <th style="padding:8px;text-align:right;font-size:11px;border-bottom:1px solid var(--line)">Precio</th>
              <th style="padding:8px;text-align:right;font-size:11px;border-bottom:1px solid var(--line)">Total</th>
              <th style="padding:8px;border-bottom:1px solid var(--line)"></th>
            </tr>
          </thead>
          <tbody id="conv-items">${itemsHTML}</tbody>
        </table>
      </div>
    </div>

    <div class="g2" style="margin-bottom:10px">
      <div class="fg" style="margin-bottom:0">
        <label class="lbl">Método de pago</label>
        <select class="inp" id="conv-pay"
                onchange="if(window._convEstado)window._convEstado.pay=this.value">
          ${['efectivo','tarjeta','transferencia','credito'].map(m =>
            `<option value="${m}" ${estado.pay===m?'selected':''}>${m.charAt(0).toUpperCase()+m.slice(1)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="fg" style="margin-bottom:0">
        <label class="lbl">Descuento (%)</label>
        <input class="inp" type="number" min="0" max="100"
               value="${estado.discount}" id="conv-disc"
               oninput="if(window._convEstado)window._convEstado.discount=Math.min(100,Math.max(0,parseFloat(this.value)||0))"/>
      </div>
    </div>

    <div class="card" style="background:var(--surface2);margin-bottom:12px">
        <div class="tr"><span>Subtotal sin ITBIS</span><span>${fmt(subtotal)}</span></div>
        ${estado.discount > 0 ? `<div class="tr"><span>Descuento (${estado.discount}%)</span><span>−${fmt(discAmt)}</span></div>` : ''}
        ${taxAmt > 0 ? `<div class="tr"><span>ITBIS (${CFG.itbis || 18}%)</span><span>${fmt(taxAmt)}</span></div>` : ''}
        <div class="tr grand"><span>TOTAL ESTIMADO</span><span>${fmt(total)}</span></div>
        <div style="font-size:10px;color:var(--muted2);margin-top:4px">El total usa precio final; el ITBIS se extrae de los artículos gravados.</div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal();delete window._convEstado;delete window._convSale">Cancelar</button>
      <button class="btn btn-green" onclick="confirmarConversionCotizacion()">
        ✓ Confirmar venta
      </button>
    </div>
  `, 'modal-lg');
}

// Handlers inline del modal de conversión
function convCotizQty(idx, delta) {
  const est = window._convEstado;
  if (!est || !est.items[idx]) return;
  // Guardar valores actuales de inputs antes de re-abrir
  est.items.forEach((it, i) => {
    const el = document.getElementById('conv-qty-' + i);
    if (el) it.qty = Math.max(0, parseInt(el.value)||0);
  });
  est.items[idx].qty = Math.max(0, est.items[idx].qty + delta);
  const origSale = { id: window._convOrigId };
  convertirCotizacionAVenta(origSale);
}

function convCotizRemove(idx) {
  const est = window._convEstado;
  if (!est) return;
  est.items.forEach((it, i) => {
    const el = document.getElementById('conv-qty-' + i);
    if (el) it.qty = Math.max(0, parseInt(el.value)||0);
  });
  est.items.splice(idx, 1);
  convertirCotizacionAVenta({ id: window._convOrigId });
}

async function confirmarConversionCotizacion() {
  const est  = window._convEstado;
  const sale = window._convSale;
  const cotizId = window._convOrigId;
  if (!est || !sale) return;

  // Leer valores finales de inputs
  est.items.forEach((it, idx) => {
    const input = document.getElementById('conv-qty-' + idx);
    if (input) it.qty = Math.max(0, parseInt(input.value)||0);
  });
  const payEl  = document.getElementById('conv-pay');
  const discEl = document.getElementById('conv-disc');
  if (payEl)  est.pay      = payEl.value;
  if (discEl) est.discount = Math.min(100, Math.max(0, parseFloat(discEl.value)||0));

  const itemsValidos = est.items.filter(i => i.qty > 0 && i.product_id);
  if (!itemsValidos.length) { toast('Agrega al menos un producto con cantidad mayor a 0', 'err'); return; }

  // Verificar stock en tiempo real contra DB actual
  await reloadProducts();
  const sinStock = itemsValidos.filter(i => {
    const prod = DB.products.find(p => p.id === i.product_id);
    return prod && prod.stock < i.qty;
  });
  if (sinStock.length) {
    const nombres = sinStock.map(i => {
      const prod = DB.products.find(p => p.id === i.product_id);
      return `${i.product_name} (disponible: ${prod?.stock ?? 0})`;
    }).join(', ');
    toast(`Stock insuficiente: ${nombres}`, 'err');
    return;
  }

  const priceAuthOk = await posEnsureSalePriceAuthorization(
    est,
    itemsValidos,
    `Cotización ${facturaLabel(sale)}`
  );
  if (!priceAuthOk) {
    convertirCotizacionAVenta({ id: cotizId });
    return;
  }

  const account = DB.customers.find(c => c.id === sale.customer_id);
  const currentContact = (account?.contacts || []).find(c => Number(c.id) === Number(sale.customer_contact_id));
  const customer = account ? {
    ...account,
    contact_id: currentContact?.id || null,
  } : { id: 1, name: sale.customer_name || 'Consumidor Final', rnc: sale.customer_rnc || '' };

  const result = await window.api.sales.create({
    saleData: {
      customer,
      items: itemsValidos.map(i => ({
        product_id:   i.product_id,
        product_code: i.product_code || '',
          product_name: i.product_name,
          unit_cost:    i.unit_cost || 0,
          unit_price:   i.unit_price,
          taxable:      ventasTaxable(i) ? 1 : 0,
          tax_pct:      ventasTaxable(i) ? ventasTaxPct(i) : 0,
          qty:          i.qty,
        })),
      payment: {
        method:    est.pay,
        disc:      est.discount,
        priceMode: sale.price_mode || 'retail',
        priceChangeAuthToken: est.priceChangeAuthToken || null,
      },
      type:    'factura',
      session: cajaSession,
    },
    requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al convertir', 'err'); return; }

  const removedQuote = await window.api.sales.deleteQuote({
    id: cotizId,
    requestUserId: user.id,
  });
  if (!removedQuote?.ok) {
    toast(`La factura se creó, pero la cotización original no pudo eliminarse: ${removedQuote?.error || 'error desconocido'}`, 'w');
  }

	  await reloadSales({ range: 'all', view: 'sales' });
	  await reloadProducts();
	  const convertedSale = await window.api.sales.getById({ id: result.saleId }).catch(() => null);
	  const convertedItems = convertedSale?.items?.length
	    ? convertedSale.items.map(i => ({
	        product_code: ventasItemCode(i),
	        product_name: i.product_name,
	        qty: i.qty,
	        unit_price: i.unit_price,
	        unit_cost: i.unit_cost || 0,
	        subtotal: i.subtotal,
	        taxable: i.taxable,
	        tax_pct: i.tax_pct,
	        tax_amt: i.tax_amt,
	        net_subtotal: i.net_subtotal,
	      }))
	    : itemsValidos;
	  closeModal();
  delete window._convEstado;
  delete window._convSale;
  delete window._convOrigId;

  toast(`✓ Cotización convertida → ${facturaLabel(convertedSale || {
    id: result.saleId,
    document_number_fmt: result.documentNumberFmt,
  })}`);
  printReceipt({
    id:             result.saleId,
    document_kind:  convertedSale?.document_kind || result.documentKind || '',
    document_number: convertedSale?.document_number || result.documentNumber,
    document_number_fmt: convertedSale?.document_number_fmt || result.documentNumberFmt || '',
    type:           'factura',
    customer_name:  convertedSale?.customer_name || sale.customer_name || 'Consumidor Final',
    customer_rnc:   convertedSale?.customer_rnc || sale.customer_rnc || '',
    customer_address: convertedSale?.customer_address || sale.customer_address || '',
    customer_phone: convertedSale?.customer_phone || sale.customer_phone || '',
    customer_email: convertedSale?.customer_email || sale.customer_email || '',
    customer_contact_id: convertedSale?.customer_contact_id || sale.customer_contact_id || null,
    customer_contact_name: convertedSale?.customer_contact_name || sale.customer_contact_name || '',
    customer_contact_document: convertedSale?.customer_contact_document || sale.customer_contact_document || '',
    customer_contact_role: convertedSale?.customer_contact_role || sale.customer_contact_role || '',
    customer_contact_phone: convertedSale?.customer_contact_phone || sale.customer_contact_phone || '',
    customer_contact_email: convertedSale?.customer_contact_email || sale.customer_contact_email || '',
	    items:          convertedItems,
      subtotal:       result.subtotal || ventasCalcIncludedTotals(itemsValidos, { type:'factura', discPct: est.discount }).subtotal,
      discount_pct:   est.discount,
      discount_amt:   result.discAmt || ventasCalcIncludedTotals(itemsValidos, { type:'factura', discPct: est.discount }).discAmt,
      tax_amt:        result.taxAmt || 0,
      tax_pct:        result.taxPct ?? CFG.itbis,
      total:          result.total  || 0,
    payment_method: est.pay,
    cajero:         user.name,
    date:           today(),
    time:           nowt(),
  });

  renderVentas(document.getElementById('page'));
}


async function openDetalleVentaModal(s) {
  const sale  = await window.api.sales.getById({ id: s.id });
  const detail = sale || s || {};
  const adjustedCopy = ventasHasAdjustedCopy(detail);
  const items = adjustedCopy ? detail.adjusted_items : (sale?.items || []);
  window._ventasDetalleCache = window._ventasDetalleCache || {};
  window._ventasDetalleCache[s.id] = { detail, items };

  // Refrescar productos ANTES de pintar la columna Revender: el stock que se
  // muestra/valida sale de DB.products, y ese cache es del arranque — tras
  // ventas, compras o ajustes quedaba viejo y "Revender" no veía el stock real.
  try { await reloadProducts(); } catch { /* si falla, se usa el cache */ }

  const itemsFiscal = items.map(i => ventasLineFiscal(i, detail));
  const saleType = detail.type || 'factura';
  const saleStatus = detail.status || 'completed';
  const canResell = saleType !== 'cotizacion'
    && saleType !== 'devolucion'
    && saleStatus === 'completed';
  const itemsRows = items.map((i, idx) => {
    const f = itemsFiscal[idx];
    const resaleProd = ventasFindResaleProduct(i);
    const soldQty = Math.max(1, Number.parseInt(i.qty, 10) || 1);
    const resalePrice = ventasLineFinalUnitPrice(i, detail);
    const resaleUid = resaleProd ? ventasResaleLineKey(s.id, i, idx, resaleProd.id, resalePrice) : '';
    const alreadyInCart = resaleUid
      ? (ventasResaleCart.find(x => x.uid === resaleUid)?.qty || 0)
      : 0;
    const alreadyProduct = resaleProd ? ventasResaleProductQty(resaleProd.id, resaleUid) : 0;
    const stockAvailable = resaleProd ? Math.max(0, Number(resaleProd.stock || 0) - alreadyProduct - alreadyInCart) : 0;
    const maxAdd = resaleProd ? Math.max(0, Math.min(soldQty - alreadyInCart, stockAvailable)) : 0;
    const resaleCell = !canResell ? ''
      : resaleProd && resalePrice > 0 && maxAdd > 0
      ? `<td style="text-align:right;white-space:nowrap">
           <div style="display:flex;gap:4px;align-items:center;justify-content:flex-end">
             <input class="inp" data-resale-qty="${s.id}:${idx}" type="number" min="1" max="${maxAdd}" value="1"
               style="width:40px;padding:3px 4px;text-align:center;font-size:11px"/>
             <button class="btn btn-out btn-sm" data-resale-add="${s.id}:${idx}" title="Revender: agregar al carrito"
               style="padding:4px 7px">${svg('plus')}</button>
           </div>
           <div style="font-size:9px;color:var(--muted2);margin-top:2px">disp. ${stockAvailable} · vta ${soldQty}</div>
         </td>`
      : `<td style="text-align:right;color:var(--muted2);font-size:10.5px">
           ${!resaleProd ? 'No vinc.' : resalePrice <= 0 ? 'Sin precio' : 'Sin stock'}
         </td>`;
    return `
      <tr>
        <td style="font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap">
          ${ventasEsc(ventasItemCode(i) || '—')}
        </td>
        <td style="min-width:120px">${ventasEsc(ventasDisplayProductName(i.product_name || i.name))}</td>
        <td style="text-align:right">${fmt(f.unitNet)}</td>
        <td style="text-align:center;font-weight:700">${f.qty}</td>
        <td style="text-align:right;color:var(--muted)">${fmt(f.net)}</td>
        <td style="text-align:right;color:${f.tax > 0 ? 'var(--amber)' : 'var(--muted2)'}">${fmt(f.tax)}</td>
        <td style="text-align:right;font-weight:700">${fmt(f.gross)}</td>
        ${resaleCell}
      </tr>`;
  }).join('');

  const method  = detail.payment_method || detail.pay || '';
  const cardLast4 = String(detail.card_last4 || '').replace(/\D/g, '').slice(-4);
  const paymentDetail = method === 'tarjeta'
    ? `Tarjeta${detail.card_brand ? ' ' + detail.card_brand : ''}${cardLast4 ? ' •••• ' + cardLast4 : ''}`
    : method;
  const currencyDetail = String(detail.payment_currency || '').toUpperCase() === 'USD' && Number(detail.account_amount) > 0
    ? ` · US$${Number(detail.account_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} @ RD$${Number(detail.exchange_rate || 0).toFixed(2)}`
    : '';
  const fecha   = (detail.sale_date || detail.date || '').split('T')[0].split(' ')[0];
  // Legacy/importada sin ITBIS en cabecera: usar el desglose extraído de las
  // líneas (incluido en el precio) para que el modal cuadre con la impresión.
  const lineTaxSum = ventasRound2(itemsFiscal.reduce((a, f) => a + (f.tax || 0), 0));
  const lineNetSum = ventasRound2(itemsFiscal.reduce((a, f) => a + (f.net || 0), 0));
  const headerTax  = Number(
    adjustedCopy ? detail.adjusted_tax_amt : (detail.tax_amt || detail.itbis || 0)
  );
  const taxAmt   = headerTax > 0 ? headerTax : lineTaxSum;
  const detailSubtotal = adjustedCopy ? detail.adjusted_subtotal : detail.subtotal;
  const detailTotal = adjustedCopy ? detail.operation_total : detail.total;
  const netShown = headerTax > 0 ? (detailSubtotal ?? lineNetSum) : (lineTaxSum > 0 ? lineNetSum : (detailSubtotal ?? lineNetSum));
  const discAmt = adjustedCopy ? 0 : (detail.discount_amt || detail.discAmt || 0);
  const discPct = adjustedCopy ? 0 : (detail.discount_pct || detail.disc || 0);
  const tieneNcf = !!(detail.ncf);
  const ecfOk    = detail.ecf_status === 'Aceptado';
  const isSupplement = detail.correction_kind === 'product_addition' && detail.original_sale_id;
  const hasOperationAdjustments = !isSupplement && (
    Number(detail.adjustment_addition_total || 0) > 0.005 ||
    Number(detail.operation_credit_total || 0) > 0.005
  );
  const relatedOperationSection = isSupplement ? `
    <div class="alrt a" style="margin-bottom:12px">
      <div><div class="alrt-title">Documento interno de aumento</div>
      <div class="alrt-sub">Este documento agrega productos o cantidades a ${ventasEsc(ventasOriginalHistoryReference(detail))}. No reemplaza la factura original.</div></div>
    </div>` : hasOperationAdjustments ? `
    <div class="card sale-operation-summary" style="background:var(--surface2);margin-bottom:12px">
      <div class="lbl" style="margin-bottom:8px">Operación completa después de correcciones</div>
      <div class="g3">
        <div><span class="lbl">Factura original</span><strong>${fmt(detail.total || 0)}</strong></div>
        <div><span class="lbl">Aumentos</span><strong style="color:var(--green)">+${fmt(detail.adjustment_addition_total || 0)}</strong></div>
        <div><span class="lbl">Notas de crédito</span><strong style="color:var(--red)">-${fmt(detail.operation_credit_total || 0)}</strong></div>
      </div>
      <div class="tr grand" style="margin-top:8px"><span>Total neto de la operación</span><span>${fmt(detail.operation_total || detail.total || 0)}</span></div>
    </div>` : '';

  // Sección e-CF en el detalle
  const ecfSection = tieneNcf ? `
    <div class="card" style="background:${ecfOk ? 'var(--green-bg,#f0fdf4)' : 'var(--surface2)'};margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Comprobante Fiscal Electrónico</div>
          <div style="font-family:monospace;font-weight:700;font-size:13px">${detail.ncf}</div>
          ${ecfOk
            ? `<div style="font-size:10px;color:var(--green);margin-top:2px">✓ Aceptado por DGII</div>`
            : `<div style="font-size:10px;color:var(--muted2);margin-top:2px">Pendiente de envío</div>`}
        </div>
        ${!ecfOk
          ? `<button class="btn btn-sm" style="background:#0066cc;color:#fff;border:none"
               onclick="closeModal();enviarEcf(${s.id})">
               <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>
               Enviar e-CF
             </button>`
          : `${detail.ecf_qr
              ? `<img src="${detail.ecf_qr}" style="width:56px;height:56px;border-radius:4px" title="QR e-CF"/>`
              : ''}`}
      </div>
    </div>` : '';

  openModal(`
    <div class="modal-title">${documentTypeLabel(detail)} ${ventasEsc(ventasHistoryReference(detail))}</div>
    <div class="modal-sub">
      ${detail.import_source
        ? `${ventasEsc(ventasImportSourceLabel(detail.import_source))} · `
        : (detail.document_number_fmt ? `Documento Velo ${ventasEsc(detail.document_number_fmt)} · ` : '')}
      ${fdate(fecha)} · Cajero: ${detail.cajero || '—'}
      ${detail.salesperson_name ? ` · Vendedor: ${ventasEsc(detail.salesperson_code ? detail.salesperson_code + ' · ' : '')}${ventasEsc(detail.salesperson_name)}` : ''}
    </div>
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <div class="g3">
        <div><div class="lbl">Fecha original</div><strong>${fdate(detail.original_sale_date || fecha)}</strong></div>
        <div><div class="lbl">Fecha operativa actual</div><strong>${fdate(detail.sale_date || fecha)}</strong></div>
        <div><div class="lbl">Fecha fiscal</div><strong>${detail.fiscal_issued_at ? fdate(String(detail.fiscal_issued_at).slice(0,10)) : 'No aplica'}</strong></div>
      </div>
      ${detail.date_modified_at ? `<div class="ts" style="margin-top:8px">Fecha modificada: ${ventasEsc(detail.date_change_reason || 'Motivo auditado')} · ${ventasEsc(detail.date_modified_at)}</div>` : ''}
    </div>
    <div class="g2" style="margin-bottom:14px">
      <div>
        <div class="lbl">Cliente</div>
        <div style="font-weight:600">${detail.customer_name || detail.clientName || 'Consumidor Final'}</div>
        <div class="ts">${detail.customer_rnc || detail.clientCedula || 'Sin RNC'}</div>
        ${detail.customer_phone ? `<div class="ts">${detail.customer_phone_type === 'celular' ? 'Celular' : detail.customer_phone_type === 'flota' ? 'Flota' : 'Teléfono'}: ${ventasEsc(detail.customer_phone)}</div>` : ''}
        ${detail.customer_contact_name ? `<div class="ts" style="margin-top:4px">Solicitado por: <strong>${ventasEsc(detail.customer_contact_name)}</strong>${detail.customer_contact_role ? ` · ${ventasEsc(detail.customer_contact_role)}` : ''}</div>` : ''}
      </div>
      <div>
        <div class="lbl">Comprobante</div>
        <div style="font-weight:600">${documentTypeLabel(detail)}</div>
        ${detail.type === 'cotizacion'
          ? '<div class="ts">Sin cobro · sin movimiento de inventario</div>'
          : `<div class="ts">Pago: ${ventasEsc(paymentDetail)}${ventasEsc(currencyDetail)}</div>`}
        ${detail.payment_reference
          ? `<div class="ts">Referencia: ${ventasEsc(detail.payment_reference)}</div>` : ''}
      </div>
    </div>
    ${relatedOperationSection}
    ${adjustedCopy ? `
      <div class="alrt g" style="margin-bottom:12px">
        <div><div class="alrt-title">Vista consolidada de la factura ajustada</div>
        <div class="alrt-sub">Aquí aparecen las cantidades vigentes. Las notas de crédito y documentos de aumento permanecen únicamente en el historial de auditoría.</div></div>
      </div>` : ''}
    ${ecfSection}
    <div class="tw" style="margin-bottom:12px">
      <table>
        <thead><tr>
          <th>Código</th>
          <th>Nombre artículo</th>
          <th style="text-align:right">Precio venta</th>
          <th style="text-align:center">Cantidad</th>
          <th style="text-align:right">Monto bruto</th>
          <th style="text-align:right">ITBIS</th>
          <th style="text-align:right">Importe</th>
          ${canResell ? '<th style="text-align:right">Revender</th>' : ''}
        </tr></thead>
        <tbody>${itemsRows || `<tr><td colspan="${canResell ? 8 : 7}" style="color:var(--muted2);text-align:center">Sin detalle</td></tr>`}</tbody>
      </table>
    </div>
    ${(detail.charges || []).length ? `
      <div class="card" style="margin-bottom:12px">
        <div class="lbl" style="margin-bottom:6px">Cargos agregados a la factura</div>
        ${(detail.charges || []).map(charge => `
          <div class="tr"><span>${ventasEsc(charge.description || 'Cargo adicional')}</span><span>${fmt(charge.amount)}</span></div>
        `).join('')}
      </div>` : ''}
    <div class="card" style="background:var(--surface2)">
        <div class="tr"><span>Monto bruto</span><span>${fmt(netShown)}</span></div>
      ${discPct > 0
        ? `<div class="tr"><span>Descuento (${discPct}%)</span>
           <span>-${fmt(discAmt)}</span></div>` : ''}
        ${taxAmt > 0
          ? `<div class="tr"><span>ITBIS (${detail.tax_pct || CFG.itbis || 18}%)</span><span>${fmt(taxAmt)}</span></div>` : ''}
      ${Number(detail.additional_charges_total || 0) > 0
        ? `<div class="tr"><span>Cargos adicionales</span><span>${fmt(detail.additional_charges_total)}</span></div>` : ''}
      <div class="tr grand"><span>${adjustedCopy ? 'Total vigente de la operación' : 'Importe / Total'}</span><span>${fmt(detailTotal)}</span></div>
      ${String(detail.display_currency || '').toUpperCase() === 'USD' && Number(detail.display_exchange_rate) > 0
        ? `<div class="tr"><span>Equivalente USD · tasa RD$${Number(detail.display_exchange_rate).toFixed(2)}</span><strong>US$${Number(detailTotal / detail.display_exchange_rate).toFixed(2)}</strong></div>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-out" onclick="reimprimirVenta(${s.id})">
        ${svg('print')} ${adjustedCopy ? 'Reimprimir factura ajustada' : 'Reimprimir documento'}
      </button>
      <button class="btn btn-out" onclick="guardarVentaPDF(${s.id})">
        ${svg('pdf')} Guardar PDF
      </button>
      ${detail.type === 'factura'
        ? `<button class="btn btn-dark" onclick="closeModal();openFacturaCorreccion(${s.id})">${svg('calendar')} Corregir / ajustar factura</button>`
        : ''}
      <button class="btn btn-out" style="background:#25D366;color:#fff;border-color:#25D366"
              onclick="ventaWhatsApp(${s.id})"
              title="Enviar resumen de texto por WhatsApp">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="flex-shrink:0">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/>
        </svg>
        WhatsApp texto
      </button>
      <button class="btn btn-out" style="color:#128C7E;border-color:#25D366"
              onclick="ventaWhatsAppPDF(${s.id})"
              title="Preparar el documento PDF y abrir WhatsApp">
        ${svg('pdf')} PDF por WhatsApp
      </button>
      ${CFG.module_conduce === '1' && s.type === 'factura' && s.status === 'completed'
        ? `<button class="btn btn-out" onclick="generarConduceVenta(${s.id})"
                   title="Crear el conduce de esta factura, guardarlo en Conduces e imprimirlo">
             ${svg('truck')} Generar conduce
           </button>`
        : ''}
      ${s.type === 'factura' && s.status === 'completed'
        ? `<button class="btn btn-amber" onclick="closeModal();iniciarDevolucionDesdeVenta(${s.id})">
             ${svg('return')} Devolver
           </button>`
        : ''}
      ${s.status === 'completed' && s.type === 'cotizacion'
        ? `<button class="btn btn-red" onclick="closeModal();eliminarCotizacion(DB.sales.find(x=>x.id===${s.id}))">
             ${svg('trash')} Eliminar cotización
           </button>`
        : ''}
      ${['admin','superadmin'].includes(user?.role) && s.status === 'completed' && s.type !== 'cotizacion'
        ? `<button class="btn btn-red" onclick="closeModal();openAnulacionModal(DB.sales.find(x=>x.id===${s.id}))">
             ${s.type === 'devolucion' ? 'Anular devolución' : 'Anular'}
           </button>`
        : ''}
    </div>
  `, 'modal-xxl mtw sale-detail-modal');

  setTimeout(() => {
    const modal = document.getElementById('modal-ov');
    modal?.querySelectorAll('[data-resale-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [saleId, itemIdx] = String(btn.dataset.resaleAdd || '').split(':').map(Number);
        ventasAddResaleItem(saleId, itemIdx);
      });
    });
  }, 0);
}

function eliminarCotizacion(s) {
  if (!s || s.type !== 'cotizacion') {
    toast('Cotización no encontrada', 'err');
    return;
  }
  confirmModal(
    `¿Eliminar definitivamente la cotización <strong>${facturaLabel(s)}</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       Se quitará inmediatamente de Ventas. Su número no se reutilizará y la acción quedará auditada.
     </span>`,
    async () => {
      const result = await window.api.sales.deleteQuote({
        id: s.id,
        requestUserId: user.id,
      });
      closeModal();
      if (!result?.ok) {
        toast(result?.error || 'No se pudo eliminar la cotización', 'err');
        return;
      }
      await Promise.all([
        reloadSales({ range: ventasRange, view: 'sales' }),
        reloadProducts(),
        reloadCustomers(),
      ]);
      renderVentasTable();
      toast(`✓ Cotización ${result.documentNumber || facturaLabel(s)} eliminada`);
    },
    'Eliminar ahora',
    'btn-red'
  );
}

// ── Anulación (solo admin) ────────────────────
function openAnulacionModal(s) {
  if (!s) { toast('Documento no encontrado', 'err'); return; }
  const isReturn = s.type === 'devolucion';
  const isMonetaryCredit = isReturn && s.correction_kind === 'monetary_credit';
  openModal(`
    <div class="modal-title">Anular ${isMonetaryCredit ? 'Nota de crédito' : isReturn ? 'Devolución' : 'Venta'} ${facturaLabel(s)}</div>
    <div class="modal-sub" style="color:var(--red)">
      ${isMonetaryCredit
        ? 'Se revertirá el reembolso o la reducción de la cuenta por cobrar. El inventario permanecerá intacto.'
        : isReturn
        ? 'Se retirará del inventario la mercancía repuesta y se restaurará la cuenta por cobrar cuando corresponda.'
        : 'Esta acción revierte inventario, caja y contabilidad. El documento dejará de aparecer en Ventas.'}
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
  const targetSale = (DB.sales || []).find(row => Number(row.id) === Number(saleId));
  const isMonetaryCredit = targetSale?.type === 'devolucion' &&
    targetSale?.correction_kind === 'monetary_credit';
  const reason = document.getElementById('anul-reason')?.value?.trim();
  if (!reason) { toast('El motivo es requerido', 'err'); return; }

  const result = await window.api.sales.cancel({
    id: saleId, reason, requestUserId: user.id
  });

  if (!result.ok) { toast(result.error || 'Error al anular', 'err'); return; }

  await reloadSales(result.isReturn
    ? { range: 'all' }
    : { range: ventasRange, view: 'sales' });
  await reloadProducts();
  if (result.isReturn) await reloadCustomers();
  closeModal();
  toast(`✓ ${isMonetaryCredit ? 'Nota de crédito' : result.isReturn ? 'Devolución' : 'Venta'} ${facturaLabel(targetSale || { id: saleId })} anulada`);
  if (result.overpayment > 0) {
    toast(`⚠ El cliente ya había pagado de más por esta factura — excedente de ${fmt(result.overpayment)} a revisar manualmente (reembolso o crédito)`, 'w');
  }
  if (result.isReturn) renderDevoluciones(document.getElementById('page'));
  else renderVentas(document.getElementById('page'));
}

// ── Iniciar devolución desde historial ────────
async function iniciarDevolucionDesdeVenta(saleId) {
  window._devolucionFromSaleId = saleId;
  routeTo('devoluciones');
}

// ── Reimprimir ────────────────────────────────
async function reimprimirVenta(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('Venta no encontrada', 'err'); return; }
  const adjustedCopy = ventasHasAdjustedCopy(sale);

  confirmModal(
    `¿Reimprimir ${adjustedCopy ? 'la factura ajustada' : documentTypeLabel(sale).toLowerCase()} <strong>${ventasHistoryReference(sale)}</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       ${adjustedCopy
         ? 'Se imprimirán los productos, cantidades y total vigentes en una sola copia consolidada. No sustituye los comprobantes fiscales relacionados.'
         : 'Quedará registrado en el log de auditoría como reimpresión.'}
     </span>`,
    () => {
      printReceipt(ventasPrintPayload(sale), true);
    },
    adjustedCopy ? 'Imprimir ajustada' : 'Reimprimir',
    'btn-dark'
  );
}

function ventasPrintPayload(sale) {
  const fecha = sale.original_sale_date || (sale.created_at || '').split('T')[0];
  const hora  = sale.created_at
    ? new Date(sale.created_at).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }) : '';
  const _custPdf = (DB.customers || []).find(c => c.id === sale.customer_id);
  const adjustedCopy = ventasHasAdjustedCopy(sale);
  const printItems = adjustedCopy ? sale.adjusted_items : (sale.items || []);
  const relatedDocuments = adjustedCopy
    ? (sale.adjustment_documents || []).map(document => facturaLabel(document)).filter(Boolean)
    : [];
  return {
    id: sale.id, date: fecha, time: hora, type: sale.type,
    adjusted_copy: adjustedCopy,
    adjusted_reference: adjustedCopy ? ventasHistoryReference(sale) : '',
    adjusted_reference_ncf: adjustedCopy ? (sale.ncf || '') : '',
    related_documents: relatedDocuments,
    correction_kind: sale.correction_kind || '',
    document_kind: sale.document_kind || '',
    document_number: sale.document_number,
    document_number_fmt: sale.document_number_fmt || '',
    receipt_document_number: sale.receipt_document_number,
    receipt_document_number_fmt: sale.receipt_document_number_fmt || '',
    numero_factura: sale.numero_factura, numero_factura_fmt: sale.numero_factura_fmt,
    due_date: sale.due_date || null, customer_id: sale.customer_id || null,
    customer_name: sale.customer_name || 'Consumidor Final', customer_rnc: sale.customer_rnc || _custPdf?.rnc || '',
    customer_address: sale.customer_address || _custPdf?.address || '',
    customer_phone: sale.customer_phone || _custPdf?.phone || '',
    customer_phone_type: sale.customer_phone_type || 'telefono',
    customer_email: sale.customer_email || _custPdf?.billing_email || _custPdf?.email || '',
    customer_type: sale.customer_type || _custPdf?.customer_type || 'person',
    customer_trade_name: sale.customer_trade_name || _custPdf?.trade_name || '',
    customer_contact_id: sale.customer_contact_id || null,
    customer_contact_name: sale.customer_contact_name || '',
    customer_contact_document: sale.customer_contact_document || '',
    customer_contact_role: sale.customer_contact_role || '',
    customer_contact_phone: sale.customer_contact_phone || '',
    customer_contact_email: sale.customer_contact_email || '',
	    items: printItems.map(i => ({
	      product_code: ventasItemCode(i),
	      product_name: ventasDisplayProductName(i.product_name), qty: i.qty, unit_price: i.unit_price, unit_cost: i.unit_cost || 0,
	      subtotal: i.subtotal, taxable: i.taxable, tax_pct: i.tax_pct,
	      tax_amt: i.tax_amt, net_subtotal: i.net_subtotal,
	    })),
    charges: sale.charges || [],
    additional_charges_total: sale.additional_charges_total || 0,
    display_currency: sale.display_currency || 'DOP',
    display_exchange_rate: sale.display_exchange_rate || 1,
    display_amount: sale.display_amount || 0,
    subtotal: adjustedCopy ? sale.adjusted_subtotal : sale.subtotal,
    discount_pct: adjustedCopy ? 0 : (sale.discount_pct || 0),
    discount_amt: adjustedCopy ? 0 : (sale.discount_amt || 0),
    tax_amt: adjustedCopy ? sale.adjusted_tax_amt : (sale.tax_amt || 0),
    total: adjustedCopy ? sale.operation_total : sale.total,
    payment_method: adjustedCopy && Number(sale.adjustment_addition_total || 0) > 0
      ? 'varios'
      : sale.payment_method,
    payment_amount: sale.payment_amount, balance_after_payment: sale.balance_after_payment,
    receipt_number: sale.last_receipt_number, receipt_numbers: sale.receipt_numbers,
    transaction_number: adjustedCopy
      ? `${ventasHistoryReference(sale)} · ${sale.document_number_fmt || ''}`.trim()
      : (sale.document_number_fmt || sale.id),
    notes: adjustedCopy
      ? `Copia consolidada de la operación ajustada. ${relatedDocuments.length ? `Documentos relacionados: ${relatedDocuments.join(', ')}.` : ''}`
      : (sale.notes || ''),
    cajero: sale.cajero, ncf: sale.ncf || '', tax_pct: sale.tax_pct, modifies_ncf: sale.modifies_ncf || '',
    salesperson_id: sale.salesperson_id || null,
    salesperson_name: sale.salesperson_name || '',
    salesperson_code: sale.salesperson_code || '',
    original_sale_id: sale.original_sale_id || null,
    original_document_number_fmt: sale.original_document_number_fmt || '',
    original_numero_factura: sale.original_numero_factura,
    original_numero_factura_fmt: sale.original_numero_factura_fmt,
  };
}

function ventasCorrectionKey(kind, saleId) {
  if (globalThis.crypto?.randomUUID) return `${kind}:${saleId}:${crypto.randomUUID()}`;
  return `${kind}:${saleId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function ventasCorrectionAction({ icon, title, description, enabled, onclick, tone = '' }) {
  return `
    <button type="button" class="btn btn-out" ${enabled ? `onclick="${onclick}"` : 'disabled'}
      style="height:auto;min-height:76px;text-align:left;display:flex;align-items:flex-start;gap:10px;padding:12px;${enabled ? '' : 'opacity:.55'}">
      <span style="color:${tone || 'var(--blue)'};margin-top:2px">${svg(icon)}</span>
      <span><strong style="display:block;margin-bottom:3px">${ventasEsc(title)}</strong>
      <small style="display:block;white-space:normal;line-height:1.35;color:var(--muted2)">${ventasEsc(description)}</small></span>
    </button>`;
}

async function openFacturaCorreccion(saleId) {
  const preview = await window.api.sales.corrections.getImpact({
    id: saleId,
    requestUserId: user.id,
  });
  if (!preview?.ok) return toast(preview?.error || 'No se pudo evaluar la factura', 'err');
  const ctx = preview.data;
  const sale = ctx.sale;
  const perms = new Set(ctx.permissions || []);
  const active = sale.type === 'factura' && sale.status === 'completed';
  const correctable = sale.type === 'factura' && sale.status !== 'cancelled';
  const canCorrect = perms.has('sales.correct');
  const canReturn = perms.has('sales.request_return') && active;
  const canCancel = perms.has('sales.cancel') && active;
  const canAudit = perms.has('sales.view_audit');
  const fiscalLocked = !!ctx.fiscal;

  openModal(`
    <div class="modal-title">Corregir / ajustar factura</div>
    <div class="modal-sub">${facturaLabel(sale)} · ${ventasEsc(sale.ncf || 'Sin NCF')} · ${ventasEsc(sale.customer_name || 'Consumidor Final')}</div>
    <div class="alrt a" style="margin-bottom:14px">
      <div>
        <div class="alrt-title">La factura emitida no se sobrescribe</div>
        <div class="alrt-sub">Cada acción conserva el comprobante, los datos originales y las fechas reales de pagos, caja, contabilidad y emisión fiscal.</div>
      </div>
    </div>
    <div class="g2" style="gap:8px">
      ${ventasCorrectionAction({
        icon: 'calendar', title: 'Cambiar fecha de venta',
        description: active && perms.has('sales.change_date')
          ? 'Mueve la factura en Ventas, dashboards, reportes comerciales e inventario operativo.'
          : 'Requiere una factura activa y el permiso sales.change_date.',
        enabled: canCorrect && active && perms.has('sales.change_date'),
        onclick: `closeModal();openVentaDateModal(${sale.id})`,
      })}
      ${ventasCorrectionAction({
        icon: 'edit', title: 'Editar información administrativa',
        description: 'Notas internas, orden, chofer, ruta, entrega y etiquetas; nunca datos fiscales o totales.',
        enabled: canCorrect && perms.has('sales.edit_internal_data') && sale.status !== 'cancelled',
        onclick: `closeModal();openVentaAdminModal(${sale.id})`,
      })}
      ${ventasCorrectionAction({
        icon: 'return', title: 'Corregir productos o cantidades',
        description: canCorrect && correctable
          ? 'Agrega, aumenta, reduce o quita productos en una sola pantalla; Velo genera los documentos relacionados.'
          : 'Requiere una factura disponible y permiso para corregir.',
        enabled: canCorrect && correctable,
        onclick: `closeModal();openVentaProductCorrection(${sale.id})`,
        tone: 'var(--amber)',
      })}
      ${ventasCorrectionAction({
        icon: 'dollar', title: 'Aplicar descuento posterior',
        description: canReturn
          ? 'Emite una nota de crédito por importe, reembolsa o reduce la cuenta del cliente y no mueve inventario.'
          : 'No disponible para este estado o permiso.',
        enabled: canReturn && perms.has('sales.issue_credit_note'),
        onclick: `closeModal();openVentaMonetaryCredit(${sale.id})`,
        tone: 'var(--amber)',
      })}
      ${ventasCorrectionAction({
        icon: 'return', title: 'Registrar devolución o reembolso',
        description: canReturn ? 'Permite devolución parcial o total y su compensación de inventario/CxC.' : 'No disponible para este estado o permiso.',
        enabled: canReturn,
        onclick: `closeModal();iniciarDevolucionDesdeVenta(${sale.id})`,
        tone: 'var(--amber)',
      })}
      ${ventasCorrectionAction({
        icon: 'card', title: 'Cambiar método de pago',
        description: 'Bloqueado: los pagos emitidos conservan su fecha y método real; debe hacerse mediante un proceso de reembolso y nuevo cobro.',
        enabled: false,
      })}
      ${ventasCorrectionAction({
        icon: 'list', title: 'Registrar nota de crédito',
        description: canReturn ? 'Crea una nota de crédito monetaria vinculada (B04 cuando corresponde), sin registrar una devolución física.' : 'Requiere permiso sales.issue_credit_note y factura activa.',
        enabled: canReturn && perms.has('sales.issue_credit_note'),
        onclick: `closeModal();openVentaMonetaryCredit(${sale.id})`,
        tone: 'var(--amber)',
      })}
      ${ventasCorrectionAction({
        icon: 'plus', title: 'Nota de débito / cargo posterior',
        description: fiscalLocked
          ? 'Bloqueado para e-CF emitido: debe emitirse un documento fiscal de cargo en el proveedor fiscal.'
          : 'No se altera el total original; emite una nueva factura vinculada desde el POS.',
        enabled: false,
      })}
      ${ventasCorrectionAction({
        icon: 'xmark', title: 'Anular factura',
        description: canCancel ? 'Genera reversos controlados sin borrar el documento ni reutilizar su secuencia.' : 'Requiere permiso sales.cancel y factura activa.',
        enabled: canCancel,
        onclick: `closeModal();openVentaCancellationFromCorrection(${sale.id})`,
        tone: 'var(--red)',
      })}
      ${ventasCorrectionAction({
        icon: 'edit', title: 'Sustituir factura',
        description: 'Bloqueado en edición directa: primero debe compensarse la factura original y luego emitirse una nueva con el cliente/comprobante correcto.',
        enabled: false,
      })}
      ${ventasCorrectionAction({
        icon: 'list', title: 'Ver historial de cambios',
        description: canAudit ? 'Línea de tiempo inmutable con valores anteriores, nuevos, usuarios y documentos.' : 'Requiere permiso sales.view_audit.',
        enabled: canAudit,
        onclick: `closeModal();openVentaCorrectionsHistory(${sale.id})`,
      })}
    </div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>
  `, 'modal-xl');
}

async function openVentaMonetaryCredit(saleId) {
  const response = await window.api.sales.corrections.getMonetaryCreditModel({
    id: saleId,
    requestUserId: user.id,
  });
  if (!response?.ok) return toast(response?.error || 'No se pudo preparar la nota de crédito', 'err');
  const model = response.data;
  if (Number(model.availableCredit || 0) <= 0) {
    return toast('La factura ya no tiene saldo disponible para otra nota de crédito', 'w');
  }
  window._ventaMonetaryCredit = {
    model,
    idempotencyKey: ventasCorrectionKey('monetary-credit', model.root.id),
  };
  const settlement = String(model.root.payment_method || '').toLowerCase() === 'credito'
    ? 'El importe reducirá la cuenta por cobrar del cliente.'
    : ['efectivo', 'mixto'].includes(String(model.root.payment_method || '').toLowerCase())
      ? 'El importe se registrará como reembolso; para la parte en efectivo debes tener la caja abierta.'
      : 'El reembolso se registrará por el mismo medio financiero de la factura.';
  openModal(`
    <div class="modal-title">Nota de crédito por descuento o ajuste</div>
    <div class="modal-sub">${facturaLabel(model.root)} · ajuste monetario sin devolución de productos</div>
    <div class="alrt g" style="margin-bottom:12px">
      <div><div class="alrt-title">El inventario no cambiará</div>
      <div class="alrt-sub">Esta opción sirve para descuentos posteriores, bonificaciones o errores de importe. Si el cliente entrega mercancía, usa “Registrar devolución”.</div></div>
    </div>
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <div class="g3">
        <div><span class="lbl">Total original</span><strong>${fmt(model.root.total || 0)}</strong></div>
        <div><span class="lbl">Ya acreditado</span><strong>-${fmt(model.creditedTotal || 0)}</strong></div>
        <div><span class="lbl">Máximo disponible</span><strong>${fmt(model.availableCredit || 0)}</strong></div>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Importe final de la nota de crédito *</label>
        <input class="inp" id="vmc-amount" type="number" min="0.01"
          max="${Number(model.availableCredit || 0).toFixed(2)}" step="0.01"
          placeholder="0.00" autofocus/>
        <div class="ts">Incluye el ITBIS proporcional de la factura original.</div>
      </div>
      <div class="fg">
        <label class="lbl">Motivo específico *</label>
        <input class="inp" id="vmc-reason" maxlength="500"
          placeholder="Ej.: descuento comercial acordado después de facturar"/>
      </div>
    </div>
    <div class="alrt a" style="margin-top:12px">
      <div><div class="alrt-title">Cómo queda la operación</div>
      <div class="alrt-sub">${ventasEsc(settlement)} La factura original y su NCF no se reemplazan.</div></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="ventasConfirmMonetaryCredit()">${svg('check')} Revisar y emitir</button>
    </div>
  `, 'modal-lg');
}

function ventasConfirmMonetaryCredit() {
  const state = window._ventaMonetaryCredit;
  if (!state?.model) return;
  const amount = ventasRound2(Number(document.getElementById('vmc-amount')?.value || 0));
  const reason = document.getElementById('vmc-reason')?.value?.trim() || '';
  if (amount <= 0) return toast('Escribe un importe mayor que cero', 'w');
  if (amount > Number(state.model.availableCredit || 0) + 0.005) {
    return toast(`El máximo disponible es ${fmt(state.model.availableCredit || 0)}`, 'w');
  }
  if (reason.length < 5) return toast('Escribe un motivo específico', 'w');
  state.pendingAmount = amount;
  state.pendingReason = reason;
  confirmModal(
    `<strong>Emitir nota de crédito monetaria</strong><br/><br/>
     Importe: <strong>${fmt(amount)}</strong><br/>
     Inventario: <strong>sin movimiento</strong><br/>
     Motivo: <strong>${ventasEsc(reason)}</strong><br/><br/>
     <span style="font-size:11px;color:var(--muted)">La factura original permanecerá intacta y la nota quedará vinculada.</span>`,
    () => ventasSubmitMonetaryCredit(),
    'Emitir nota de crédito',
    'btn-dark'
  );
}

async function ventasSubmitMonetaryCredit() {
  const state = window._ventaMonetaryCredit;
  if (!state?.model) return;
  const result = await window.api.sales.corrections.createMonetaryCredit({
    id: state.model.root.id,
    amount: state.pendingAmount,
    reason: state.pendingReason,
    expectedRevision: Number(state.model.root.revision || 0),
    idempotencyKey: state.idempotencyKey,
    requestUserId: user.id,
  });
  if (!result?.ok) return toast(result?.error || 'No se pudo emitir la nota de crédito', 'err');
  await Promise.all([
    reloadSales({ range: 'all' }),
    reloadProducts(),
    reloadCustomers(),
  ]);
  renderVentas(document.getElementById('page'));
  ventasOpenProductCorrectionResult(result, state.model.root.id);
  toast('✓ Nota de crédito emitida sin movimiento de inventario');
}

function ventasProductLineUnitTotal(line) {
  const originalQty = Number(line?.original_qty || 0);
  const snapshotTotal = Number(line?.net_subtotal || 0) + Number(line?.tax_amt || 0);
  if (originalQty > 0 && snapshotTotal > 0) return ventasRound2(snapshotTotal / originalQty);
  return ventasRound2(Number(line?.unit_price || 0));
}

function ventasProductCorrectionSummary() {
  const state = window._ventaProductCorrection;
  if (!state?.model) return { credit: 0, addition: 0, net: 0, changed: false };
  let credit = 0;
  let addition = 0;
  let changed = false;
  state.model.lines.forEach((line, index) => {
    const input = document.getElementById(`vpc-line-${index}`);
    const target = Math.max(0, Number.parseInt(input?.value, 10) || 0);
    const current = Number(line.current_qty || 0);
    const unit = ventasProductLineUnitTotal(line);
    if (target < current) {
      credit += (current - target) * unit;
      changed = true;
    } else if (target > current) {
      addition += (target - current) * unit;
      changed = true;
    }
  });
  (state.addedItems || []).forEach((row, index) => {
    const qty = Math.max(0, Number.parseInt(document.getElementById(`vpc-added-qty-${index}`)?.value, 10) || row.qty || 0);
    const price = Math.max(0, Number.parseFloat(document.getElementById(`vpc-added-price-${index}`)?.value) || 0);
    if (qty > 0) {
      addition += qty * price;
      changed = true;
    }
  });
  return {
    credit: ventasRound2(credit),
    addition: ventasRound2(addition),
    net: ventasRound2(addition - credit),
    changed,
  };
}

function ventasRefreshProductCorrectionSummary() {
  const summary = ventasProductCorrectionSummary();
  const target = document.getElementById('vpc-summary');
  if (!target) return;
  const netLabel = summary.net > 0
    ? `Cliente paga ${fmt(summary.net)} más`
    : summary.net < 0
      ? `Cliente recibe crédito/reembolso de ${fmt(Math.abs(summary.net))}`
      : 'La diferencia neta es cero';
  target.innerHTML = `
    <div class="g3">
      <div><span class="lbl">A favor del cliente</span><strong style="color:var(--red)">-${fmt(summary.credit)}</strong></div>
      <div><span class="lbl">Productos agregados</span><strong style="color:var(--green)">${fmt(summary.addition)}</strong></div>
      <div><span class="lbl">Resultado</span><strong>${ventasEsc(netLabel)}</strong></div>
    </div>
    <div class="ts" style="margin-top:7px">
      Velo conservará el documento original, aplicará los respaldos internos necesarios y mostrará una sola factura Ajustada en Ventas.
    </div>`;
  const paymentWrap = document.getElementById('vpc-payment-wrap');
  if (paymentWrap) paymentWrap.style.display = summary.addition > 0 ? '' : 'none';
  const save = document.getElementById('vpc-save');
  if (save) save.disabled = !summary.changed;
}

function ventasAdjustProductCorrectionQty(index, delta) {
  const input = document.getElementById(`vpc-line-${index}`);
  if (!input) return;
  input.value = Math.max(0, (Number.parseInt(input.value, 10) || 0) + Number(delta || 0));
  ventasRefreshProductCorrectionSummary();
}

function ventasRenderAddedCorrectionItems() {
  const state = window._ventaProductCorrection;
  const target = document.getElementById('vpc-added-items');
  if (!state || !target) return;
  target.innerHTML = (state.addedItems || []).length
    ? state.addedItems.map((row, index) => `
        <div style="display:grid;grid-template-columns:minmax(160px,1fr) 72px 110px 36px;gap:7px;align-items:end;padding:8px 0;border-top:1px solid var(--line2)">
          <div><span class="lbl">Producto nuevo</span><strong>${ventasEsc(ventasDisplayProductName(row.product.name))}</strong>
            <div class="ts">${ventasEsc(row.product.code || '')} · disponibles ${Number(row.product.stock || 0)}</div>
          </div>
          <div><label class="lbl">Cantidad</label><input class="inp" id="vpc-added-qty-${index}" type="number" min="1" max="999999" value="${row.qty || 1}" oninput="ventasRefreshProductCorrectionSummary()"/></div>
          <div><label class="lbl">Precio final</label><input class="inp" id="vpc-added-price-${index}" type="number" min="0" step="0.01" value="${Number(row.unitPrice || 0).toFixed(2)}" oninput="ventasRefreshProductCorrectionSummary()"/></div>
          <button type="button" class="btn btn-out" style="color:var(--red);padding:8px" onclick="ventasRemoveAddedCorrectionItem(${index})">${svg('xmark')}</button>
        </div>`).join('')
    : '<div class="ts" style="padding:9px 0">No has agregado productos nuevos.</div>';
  ventasRefreshProductCorrectionSummary();
}

function ventasAddCorrectionProduct() {
  const state = window._ventaProductCorrection;
  const search = document.getElementById('vpc-product-search');
  const typed = String(search?.value || '').trim();
  const productId = Number(typed.match(/^(\d+)\s+·/)?.[1] || 0);
  const product = state?.model?.products?.find(row => Number(row.id) === productId);
  if (!product) return toast('Escribe el nombre o código y selecciona un producto de la lista', 'w');

  const existingIndex = state.model.lines.findIndex(line => Number(line.product_id) === productId);
  if (existingIndex >= 0) {
    ventasAdjustProductCorrectionQty(existingIndex, 1);
    if (search) search.value = '';
    toast('Cantidad aumentada en la línea existente');
    return;
  }
  const addedIndex = (state.addedItems || []).findIndex(row => Number(row.product.id) === productId);
  if (addedIndex >= 0) {
    const qtyInput = document.getElementById(`vpc-added-qty-${addedIndex}`);
    if (qtyInput) qtyInput.value = (Number.parseInt(qtyInput.value, 10) || 0) + 1;
    if (search) search.value = '';
    ventasRefreshProductCorrectionSummary();
    return;
  }
  const price = state.model.root.price_mode === 'wholesale'
    ? Number(product.wholesale || product.price || 0)
    : Number(product.price || 0);
  state.addedItems.push({ product, qty: 1, unitPrice: price });
  ventasRenderAddedCorrectionItems();
  if (search) search.value = '';
}

function ventasRemoveAddedCorrectionItem(index) {
  const state = window._ventaProductCorrection;
  if (!state) return;
  state.addedItems.splice(index, 1);
  ventasRenderAddedCorrectionItems();
}

async function openVentaProductCorrection(saleId) {
  const response = await window.api.sales.corrections.getProductModel({
    id: saleId,
    requestUserId: user.id,
  });
  if (!response?.ok) return toast(response?.error || 'No se pudo preparar la corrección', 'err');
  const model = response.data;
  window._ventaProductCorrection = {
    model,
    addedItems: [],
    idempotencyKey: ventasCorrectionKey('products', model.root.id),
  };
  const defaultMethod = ['efectivo','tarjeta','transferencia','credito'].includes(model.root.payment_method)
    ? model.root.payment_method : 'efectivo';
  const lineGroups = new Map();
  model.lines.forEach((line, index) => {
    const key = `${line.source_sale_id}:${line.source_document_number}`;
    if (!lineGroups.has(key)) lineGroups.set(key, []);
    lineGroups.get(key).push({ line, index });
  });
  const existingRows = [...lineGroups.values()].map(group => {
    const source = group[0].line;
    return `
      <section class="vpc-document-group">
        <div class="vpc-document-head">
          <strong>${source.source_kind === 'original' ? 'Factura original' : 'Aumento anterior'}</strong>
          <span>${ventasEsc(source.source_document_number)}</span>
        </div>
        ${group.map(({ line, index }) => `
          <div class="vpc-product-row">
            <div class="vpc-product-info">
              <strong>${ventasEsc(ventasDisplayProductName(line.product_name))}</strong>
              <div class="ts">${ventasEsc(line.product_code || '')}</div>
              <div class="ts">Importe unitario final (ITBIS incluido): ${fmt(ventasProductLineUnitTotal(line))}</div>
            </div>
            <div class="vpc-qty">
              <button type="button" class="btn btn-out" onclick="ventasAdjustProductCorrectionQty(${index},-1)">−</button>
              <input class="inp" id="vpc-line-${index}" type="number" min="0" max="999999"
                value="${Number(line.current_qty || 0)}" aria-label="Cantidad corregida"
                oninput="ventasRefreshProductCorrectionSummary()"/>
              <button type="button" class="btn btn-out" onclick="ventasAdjustProductCorrectionQty(${index},1)">+</button>
            </div>
            <div class="ts vpc-qty-help">
              Facturado: <strong>${Number(line.current_qty || 0)}</strong><br/>
              Usa 0 para retirar; aumenta para agregar unidades.
            </div>
          </div>`).join('')}
      </section>`;
  }).join('');
  const options = (model.products || []).map(product =>
    `<option value="${product.id} · ${ventasEsc(product.code || '')} · ${ventasEsc(ventasDisplayProductName(product.name))}">${fmt(product.price || 0)} · stock ${Number(product.stock || 0)}</option>`
  ).join('');
  const warningTitles = {
    FISCAL_DOCUMENT_PRESERVED: 'Documento fiscal original protegido',
    NCF_PRESERVED: 'NCF original protegido',
    MIXED_PAYMENT: 'Pago mixto',
  };
  const fiscalWarning = (model.warnings || []).find(warning =>
    ['FISCAL_DOCUMENT_PRESERVED', 'NCF_PRESERVED'].includes(warning.code)
  );
  const visibleWarnings = (model.warnings || []).filter(warning =>
    !['FISCAL_DOCUMENT_PRESERVED', 'NCF_PRESERVED'].includes(warning.code)
  );

  openModal(`
    <div class="vpc-head">
      <div class="modal-title">Corregir productos de la factura</div>
      <div class="modal-sub">${facturaLabel(model.root)} · ajusta cantidades o agrega productos.</div>
    </div>
    <div class="vpc-scroll">
      <div class="alrt a" style="margin-bottom:12px">
        <div><div class="alrt-title">La factura original no se modifica</div>
        <div class="alrt-sub">Reducir crea una nota de crédito; aumentar crea un respaldo interno vinculado. En Ventas se mantendrá una sola factura Ajustada.${fiscalWarning ? ` ${ventasEsc(fiscalWarning.message)}` : ''}</div></div>
      </div>
      ${visibleWarnings.map(warning => `
        <div class="alrt ${warning.severity === 'high' ? 'r' : 'a'}" style="margin-bottom:8px">
          <div><div class="alrt-title">${ventasEsc(warningTitles[warning.code] || 'Aviso importante')}</div><div class="alrt-sub">${ventasEsc(warning.message)}</div></div>
        </div>`).join('')}
      <div class="card vpc-current" style="margin-bottom:12px">
        <div class="lbl" style="margin-bottom:7px">Documentos y productos vigentes</div>
        ${existingRows || '<div class="ts">Todos los productos originales fueron retirados. Puedes agregar otros nuevos.</div>'}
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="lbl" style="margin-bottom:7px">Agregar otro producto</div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:7px">
          <input class="inp" id="vpc-product-search" list="vpc-products-list"
            placeholder="Escribe el código, nombre o escanea el producto"
            onkeydown="if(event.key==='Enter'){event.preventDefault();ventasAddCorrectionProduct()}"/>
          <datalist id="vpc-products-list">${options}</datalist>
          <button type="button" class="btn btn-dark" onclick="ventasAddCorrectionProduct()">${svg('plus')} Agregar</button>
        </div>
        <div id="vpc-added-items"></div>
      </div>
      <div class="card" id="vpc-summary" style="background:var(--surface2);margin-bottom:12px"></div>
      <div class="g2 vpc-fields">
        <div class="fg">
          <label class="lbl">Motivo de la corrección *</label>
          <input class="inp" id="vpc-reason" maxlength="500" placeholder="Ej.: se facturó una cantidad incorrecta"/>
        </div>
        <div class="fg" id="vpc-payment-wrap" style="display:none">
          <label class="lbl">Cómo cobrar lo agregado</label>
          <select class="inp" id="vpc-payment-method">
            <option value="efectivo" ${defaultMethod === 'efectivo' ? 'selected' : ''}>Efectivo</option>
            <option value="tarjeta" ${defaultMethod === 'tarjeta' ? 'selected' : ''}>Tarjeta</option>
            <option value="transferencia" ${defaultMethod === 'transferencia' ? 'selected' : ''}>Transferencia</option>
            ${Number(model.root.customer_id) !== 1 ? `<option value="credito" ${defaultMethod === 'credito' ? 'selected' : ''}>Cuenta por cobrar</option>` : ''}
          </select>
        </div>
      </div>
    </div>
    <div class="modal-foot vpc-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" id="vpc-save" disabled onclick="ventasConfirmProductCorrection()">${svg('check')} Revisar y aplicar</button>
    </div>
  `, 'modal-xxl vpc-modal');
  ventasRenderAddedCorrectionItems();
}

function ventasConfirmProductCorrection() {
  const state = window._ventaProductCorrection;
  if (!state?.model) return;
  const reason = document.getElementById('vpc-reason')?.value?.trim() || '';
  if (reason.length < 5) return toast('Escribe un motivo específico', 'w');
  const summary = ventasProductCorrectionSummary();
  if (!summary.changed) return toast('No hay cambios de productos', 'w');
  state.pendingReason = reason;
  state.pendingPaymentMethod = document.getElementById('vpc-payment-method')?.value || 'efectivo';
  state.pendingLines = state.model.lines.map((line, index) => ({
    sourceSaleId: Number(line.source_sale_id),
    productId: Number(line.product_id),
    targetQty: Math.max(0, Number.parseInt(document.getElementById(`vpc-line-${index}`)?.value, 10) || 0),
  }));
  state.pendingAddedItems = (state.addedItems || []).map((row, index) => ({
    productId: Number(row.product.id),
    qty: Math.max(0, Number.parseInt(document.getElementById(`vpc-added-qty-${index}`)?.value, 10) || row.qty || 0),
    unitPrice: Math.max(0, Number.parseFloat(document.getElementById(`vpc-added-price-${index}`)?.value) || 0),
  })).filter(row => row.qty > 0);
  confirmModal(
    `<strong>Resultado de la corrección</strong><br/><br/>
     Nota de crédito: <strong>${fmt(summary.credit)}</strong><br/>
     Aumento aplicado: <strong>${fmt(summary.addition)}</strong><br/>
     Diferencia neta: <strong>${fmt(summary.net)}</strong><br/><br/>
     <span style="font-size:11px;color:var(--muted)">En Ventas permanecerá una sola factura marcada como Ajustada, lista para reimprimir con su estado vigente.</span>`,
    () => ventasSubmitProductCorrection(),
    'Aplicar corrección',
    'btn-dark'
  );
}

async function ventasSubmitProductCorrection() {
  const state = window._ventaProductCorrection;
  if (!state?.model) return;
  const result = await window.api.sales.corrections.correctProducts({
    id: state.model.root.id,
    lines: state.pendingLines || [],
    addedItems: state.pendingAddedItems || [],
    reason: state.pendingReason,
    additionPaymentMethod: state.pendingPaymentMethod,
    expectedRevision: Number(state.model.root.revision || 0),
    idempotencyKey: state.idempotencyKey,
    requestUserId: user.id,
  });
  if (!result?.ok) return toast(result?.error || 'No se pudo aplicar la corrección', 'err');
  await Promise.all([
    reloadSales({ range: 'all' }),
    reloadProducts(),
    reloadCustomers(),
  ]);
  renderVentas(document.getElementById('page'));
  ventasOpenProductCorrectionResult(result, state.model.root.id);
  toast('✓ Corrección aplicada y documentos listos para imprimir');
}

async function ventasPrintGeneratedCorrectionDocument(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) return toast('No se pudo cargar el documento', 'err');
  printReceipt(ventasPrintPayload(sale), false);
}

function ventasOpenOriginalAfterCorrection(saleId) {
  const sale = (DB.sales || []).find(row => Number(row.id) === Number(saleId));
  if (!sale) return toast('Factura original no encontrada', 'err');
  closeModal();
  openDetalleVentaModal(sale);
}

function ventasOpenProductCorrectionResult(result, originalSaleId) {
  const isMonetaryCredit = result.creditKind === 'monetary';
  openModal(`
    <div class="modal-title">${isMonetaryCredit ? 'Nota de crédito emitida' : 'Corrección aplicada'}</div>
    <div class="modal-sub">En Ventas permanece una sola factura y ahora aparece marcada como Ajustada.</div>
    <div class="alrt g" style="margin-bottom:12px">
      <div><div class="alrt-title">Documentos creados correctamente</div>
      <div class="alrt-sub">
        Crédito: ${fmt(result.creditTotal || 0)} · Cargos agregados: ${fmt(result.additionTotal || 0)} ·
        Diferencia: ${fmt(result.netDifference || 0)}${isMonetaryCredit ? ' · Inventario sin cambios' : ''}
      </div></div>
    </div>
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <strong style="display:block;margin-bottom:5px">¿Qué deseas imprimir?</strong>
      <div class="ts">
        Entrega al cliente la factura ajustada: contiene los productos, cantidades y total vigentes en una sola copia.
      </div>
      <div style="display:grid;gap:7px;margin-top:10px">
        <button class="btn btn-dark" onclick="closeModal();reimprimirVenta(${originalSaleId})">
          ${svg('print')} Reimprimir factura ajustada
        </button>
      </div>
    </div>
    <div class="alrt a">
      <div><div class="alrt-title">Sin ventas duplicadas</div>
      <div class="alrt-sub">Las notas de crédito y aumentos vinculados quedan disponibles en el historial de auditoría, pero no aparecen como ventas independientes.</div></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="ventasOpenOriginalAfterCorrection(${originalSaleId})">${svg('eye')} Ver factura ajustada</button>
      <button class="btn btn-dark" onclick="closeModal()">Terminar</button>
    </div>
  `, 'modal-lg');
}

function ventasOpenSimpleCorrectionResult(saleId, message) {
  openModal(`
    <div class="modal-title">Corrección guardada</div>
    <div class="modal-sub">${ventasEsc(message || 'La corrección quedó registrada con auditoría.')}</div>
    <div class="alrt g" style="margin-bottom:12px">
      <div><div class="alrt-title">La factura original permanece intacta</div>
      <div class="alrt-sub">Puedes entregar un resumen actualizado o reimprimir una copia del documento original.</div></div>
    </div>
    <div style="display:grid;gap:8px">
      <button class="btn btn-dark" onclick="imprimirVentaResumenActualizado(${saleId})">
        ${svg('print')} Imprimir resumen actualizado
      </button>
      <button class="btn btn-out" onclick="closeModal();reimprimirVenta(${saleId})">
        ${svg('print')} Reimprimir factura original
      </button>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="ventasOpenOriginalAfterCorrection(${saleId})">${svg('eye')} Ver factura</button>
      <button class="btn btn-dark" onclick="closeModal()">Terminar</button>
    </div>
  `, 'modal-lg');
}

async function openVentaCancellationFromCorrection(saleId) {
  const cached = (DB.sales || []).find(row => Number(row.id) === Number(saleId));
  const sale = cached || await window.api.sales.getById({ id: saleId });
  if (!sale) return toast('Factura no encontrada', 'err');
  openAnulacionModal(sale);
}

async function openVentaDateModal(saleId) {
  const preview = await window.api.sales.corrections.getImpact({
    id: saleId,
    requestUserId: user.id,
  });
  if (!preview?.ok) return toast(preview?.error || 'No se pudo cargar el impacto', 'err');
  const ctx = preview.data;
  const sale = ctx.sale;
  const current = String(sale.sale_date || '').slice(0, 10);
  window._ventaDateCorrection = {
    saleId,
    revision: Number(sale.revision || 0),
    idempotencyKey: ventasCorrectionKey('change-date', saleId),
  };
  openModal(`
    <div class="modal-title">Cambiar fecha operativa de venta</div>
    <div class="modal-sub">${facturaLabel(sale)} · NCF: ${ventasEsc(sale.ncf || 'No aplica')} · ${ventasEsc(sale.customer_name || 'Consumidor Final')}</div>
    <div class="g3" style="margin-bottom:12px">
      <div><label class="lbl">Fecha original</label><strong>${fdate(sale.original_sale_date || current)}</strong></div>
      <div><label class="lbl">Fecha operativa actual</label><strong>${fdate(current)}</strong></div>
      <div><label class="lbl">Fecha fiscal</label><strong>${sale.fiscal_issued_at ? fdate(String(sale.fiscal_issued_at).slice(0,10)) : 'No aplica'}</strong></div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Nueva fecha *</label>
        <input class="inp" id="venta-new-date" type="date" value="${ventasEsc(current)}"
          onchange="ventasRefreshDateImpact(${saleId})"/>
      </div>
      <div class="fg">
        <label class="lbl">Motivo obligatorio *</label>
        <input class="inp" id="venta-date-reason" maxlength="500"
          placeholder="Ej.: error al seleccionar la fecha"/>
      </div>
    </div>
    <div class="alrt a">
      <div><div class="alrt-title">Acción auditada y no destructiva</div>
      <div class="alrt-sub">La factura se moverá en los reportes comerciales. La fecha original permanecerá guardada. Pagos, cierres, asientos y fecha fiscal conservarán su fecha real.</div></div>
    </div>
    <div id="venta-date-impact">${ventasRenderDateImpact(ctx)}</div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" id="venta-date-save" onclick="guardarVentaDate(${saleId})">${svg('check')} Confirmar cambio</button>
    </div>
  `, 'modal-lg');
}

function ventasRenderDateImpact(ctx) {
  const sale = ctx.sale || {};
  const warnings = ctx.warnings || [];
  return `
    <div class="card" style="margin-top:12px;background:var(--surface2)">
      <div class="g3">
        <div><span class="lbl">Total</span><strong>${fmt(sale.total || 0)}</strong></div>
        <div><span class="lbl">Pago</span><strong>${ventasEsc(sale.payment_method || '—')}</strong></div>
        <div><span class="lbl">Caja original</span><strong>${ctx.cash ? `#${ctx.cash.id} · ${ventasEsc(ctx.cash.status)}` : 'Sin caja'}</strong></div>
      </div>
      ${(ctx.modules || []).map(module => `
        <div style="padding:7px 0;border-top:1px solid var(--line2)">
          <strong style="font-size:11px">${ventasEsc(module.label)}</strong>
          <div class="ts">${ventasEsc(module.effect)}</div>
        </div>`).join('')}
    </div>
    ${warnings.map(warning => `
      <div class="alrt ${warning.severity === 'high' ? 'r' : 'a'}" style="margin-top:8px">
        <div><div class="alrt-title">${ventasEsc(warning.code.replace(/_/g, ' '))}</div>
        <div class="alrt-sub">${ventasEsc(warning.message)}${warning.permitted === false ? ` · ${ventasEsc(warning.requiresPermission || 'Permiso adicional requerido')}` : ''}</div></div>
      </div>`).join('')}`;
}

async function ventasRefreshDateImpact(saleId) {
  const saleDate = document.getElementById('venta-new-date')?.value || '';
  const target = document.getElementById('venta-date-impact');
  if (!target || !saleDate) return;
  target.innerHTML = '<div class="ts" style="padding:12px">Evaluando impacto…</div>';
  const preview = await window.api.sales.corrections.getImpact({
    id: saleId,
    saleDate,
    requestUserId: user.id,
  });
  target.innerHTML = preview?.ok
    ? ventasRenderDateImpact(preview.data)
    : `<div class="alrt r"><div><div class="alrt-title">No se puede evaluar</div><div class="alrt-sub">${ventasEsc(preview?.error || 'Error')}</div></div></div>`;
  const save = document.getElementById('venta-date-save');
  if (save) save.disabled = !preview?.ok || (preview.data?.warnings || []).some(w => w.permitted === false);
}

async function guardarVentaDate(saleId) {
  const state = window._ventaDateCorrection;
  const saleDate = document.getElementById('venta-new-date')?.value || '';
  const reason = document.getElementById('venta-date-reason')?.value?.trim() || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) return toast('Selecciona una fecha válida', 'w');
  if (reason.length < 5) return toast('Escribe un motivo específico', 'w');
  const button = document.getElementById('venta-date-save');
  if (button) button.disabled = true;
  const result = await window.api.sales.corrections.changeDate({
    id: saleId,
    saleDate,
    reason,
    requestUserId: user.id,
    authorizedByUserId: user.id,
    expectedRevision: state?.revision,
    idempotencyKey: state?.idempotencyKey || ventasCorrectionKey('change-date', saleId),
  });
  if (!result?.ok) {
    if (button) button.disabled = false;
    return toast(result?.error || 'No se pudo cambiar la fecha', 'err');
  }
  closeModal();
  await reloadSales({ range: ventasRange, view: ventasTab === 'cotizaciones' ? undefined : 'sales' });
  renderVentas(document.getElementById('page'));
  ventasOpenSimpleCorrectionResult(
    result.data.id,
    `${facturaLabel(result.data)} movida al ${fdate(saleDate)} sin alterar pagos ni fecha fiscal.`
  );
  toast('✓ Fecha operativa corregida');
}

async function openVentaAdminModal(saleId) {
  const preview = await window.api.sales.corrections.getImpact({ id: saleId, requestUserId: user.id });
  if (!preview?.ok) return toast(preview?.error || 'No se pudo cargar la factura', 'err');
  const sale = preview.data.sale;
  const data = sale.administrative_data || {};
  window._ventaAdminCorrection = {
    revision: Number(sale.revision || 0),
    idempotencyKey: ventasCorrectionKey('administrative', saleId),
  };
  openModal(`
    <div class="modal-title">Información administrativa</div>
    <div class="modal-sub">${facturaLabel(sale)} · estos campos no cambian el comprobante, cliente fiscal ni importes.</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Referencia de pedido</label><input class="inp" id="vac-order" maxlength="500" value="${ventasEsc(data.order_reference || '')}"/></div>
      <div class="fg"><label class="lbl">Orden de compra</label><input class="inp" id="vac-po" maxlength="500" value="${ventasEsc(data.purchase_order || '')}"/></div>
      <div class="fg"><label class="lbl">Chofer</label><input class="inp" id="vac-driver" maxlength="500" value="${ventasEsc(data.driver || '')}"/></div>
      <div class="fg"><label class="lbl">Ruta</label><input class="inp" id="vac-route" maxlength="500" value="${ventasEsc(data.route || '')}"/></div>
      <div class="fg"><label class="lbl">Etiquetas</label><input class="inp" id="vac-tags" maxlength="500" value="${ventasEsc(data.tags || '')}"/></div>
      <div class="fg"><label class="lbl">Contacto no fiscal</label><input class="inp" id="vac-contact" maxlength="500" value="${ventasEsc(data.non_fiscal_contact || '')}"/></div>
    </div>
    <div class="fg"><label class="lbl">Nota interna</label><textarea class="inp" id="vac-note" rows="2" maxlength="500">${ventasEsc(data.internal_note || '')}</textarea></div>
    <div class="fg"><label class="lbl">Información de entrega</label><textarea class="inp" id="vac-delivery" rows="2" maxlength="1000">${ventasEsc(data.delivery_info || '')}</textarea></div>
    <div class="fg"><label class="lbl">Motivo del cambio *</label><input class="inp" id="vac-reason" maxlength="500" placeholder="Motivo administrativo específico"/></div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="guardarVentaAdmin(${saleId})">${svg('check')} Guardar con auditoría</button>
    </div>
  `, 'modal-lg');
}

async function guardarVentaAdmin(saleId) {
  const reason = document.getElementById('vac-reason')?.value?.trim() || '';
  if (reason.length < 5) return toast('Escribe un motivo específico', 'w');
  const state = window._ventaAdminCorrection || {};
  const result = await window.api.sales.corrections.updateAdministrative({
    id: saleId,
    values: {
      order_reference: document.getElementById('vac-order')?.value || '',
      purchase_order: document.getElementById('vac-po')?.value || '',
      driver: document.getElementById('vac-driver')?.value || '',
      route: document.getElementById('vac-route')?.value || '',
      tags: document.getElementById('vac-tags')?.value || '',
      non_fiscal_contact: document.getElementById('vac-contact')?.value || '',
      internal_note: document.getElementById('vac-note')?.value || '',
      delivery_info: document.getElementById('vac-delivery')?.value || '',
    },
    reason,
    requestUserId: user.id,
    expectedRevision: state.revision,
    idempotencyKey: state.idempotencyKey || ventasCorrectionKey('administrative', saleId),
  });
  if (!result?.ok) return toast(result?.error || 'No se pudo guardar', 'err');
  closeModal();
  await reloadSales({ range: ventasRange, view: 'sales' });
  renderVentas(document.getElementById('page'));
  ventasOpenSimpleCorrectionResult(saleId, 'Información administrativa guardada con auditoría.');
  toast('✓ Información administrativa corregida');
}

async function openVentaCorrectionsHistory(saleId) {
  const result = await window.api.sales.corrections.getHistory({ id: saleId, requestUserId: user.id });
  if (!result?.ok) return toast(result?.error || 'No se pudo cargar el historial', 'err');
  const data = result.data;
  const sale = data.sale;
  const events = [
    {
      date: sale.created_at,
      title: 'Factura creada',
      detail: `Fecha original: ${fdate(sale.original_sale_date)} · Total: ${fmt(sale.total)}${sale.ncf ? ` · NCF ${sale.ncf}` : ''}`,
    },
    ...(data.payments || []).map(payment => ({
      date: payment.created_at,
      title: 'Pago recibido',
      detail: `${fmt(payment.amount)} · ${payment.method || 'efectivo'} · fecha real conservada`,
    })),
    ...(data.corrections || []).map(correction => ({
      date: correction.created_at,
      title: correction.action === 'change_sale_date'
        ? 'Fecha operativa modificada'
        : correction.action === 'correct_products'
          ? 'Productos corregidos'
          : correction.action === 'create_monetary_credit'
            ? 'Nota de crédito monetaria'
            : 'Información administrativa modificada',
      detail: correction.action === 'change_sale_date'
        ? `${fdate(correction.before_data.sale_date)} → ${fdate(correction.after_data.sale_date)} · ${correction.reason} · Autorizó: ${correction.authorized_by_name || '—'}`
        : correction.action === 'correct_products'
          ? `Crédito: ${fmt(correction.metadata.creditTotal || 0)} · agregado: ${fmt(correction.metadata.additionTotal || 0)} · ${correction.reason}`
          : correction.action === 'create_monetary_credit'
            ? `Crédito: ${fmt(correction.metadata.creditTotal || 0)} · inventario sin movimiento · ${correction.reason}`
            : `${correction.reason} · ${correction.affected_modules.join(', ')}`,
    })),
    ...(data.relatedDocuments || []).map(document => ({
      date: document.created_at,
      title: document.type === 'devolucion'
        ? (document.correction_kind === 'monetary_credit' ? 'Nota de crédito monetaria' : 'Nota de crédito por devolución')
        : document.document_role === 'supplemental_invoice'
          ? 'Documento interno de aumento'
          : 'Documento relacionado',
      detail: `${document.document_number_fmt || document.numero_factura_fmt || '#' + document.id} · ${fmt(document.total)} · ${document.status}`,
    })),
    ...(data.commissionAdjustments || []).map(adjustment => ({
      date: adjustment.created_at,
      title: 'Ajuste de comisión',
      detail: `${fdate(adjustment.previous_sale_date)} → ${fdate(adjustment.new_sale_date)} · ${fmt(adjustment.commission_amount)} · ${adjustment.status}`,
    })),
    ...(data.accountingEntries || []).map(entry => ({
      date: entry.created_at,
      title: entry.status === 'reversado' ? 'Ajuste contable / reverso' : 'Asiento contable',
      detail: `${entry.number || '#' + entry.id} · fecha contable ${entry.date} · ${entry.status}`,
    })),
    ...(data.auditEvents || [])
      .filter(event => ![
        'fecha_operativa_venta_cambiada',
        'datos_administrativos_venta_cambiados',
        'productos_venta_corregidos',
        'nota_credito_monetaria_registrada',
      ].includes(event.action))
      .map(event => ({
        date: event.created_at,
        title: event.action.replace(/_/g, ' '),
        detail: `${event.user_name || 'Sistema'} · ${event.detail || ''}`,
      })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  openModal(`
    <div class="modal-title">Historial de correcciones</div>
    <div class="modal-sub">${facturaLabel(sale)} · registro inmutable</div>
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <div class="g3">
        <div><span class="lbl">Total original</span><strong>${fmt(sale.total)}</strong></div>
        <div><span class="lbl">Fecha original</span><strong>${fdate(sale.original_sale_date)}</strong></div>
        <div><span class="lbl">Fecha operativa</span><strong>${fdate(sale.sale_date)}</strong></div>
      </div>
    </div>
    <div style="display:grid;gap:8px;max-height:470px;overflow:auto">
      ${events.map(event => `
        <div style="display:grid;grid-template-columns:135px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line2)">
          <div class="ts">${ventasEsc(event.date || '')}</div>
          <div><strong style="font-size:12px">${ventasEsc(event.title)}</strong><div class="ts" style="margin-top:3px">${ventasEsc(event.detail)}</div></div>
        </div>`).join('') || '<div class="empty"><p>Sin eventos</p></div>'}
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-dark" onclick="imprimirVentaResumenActualizado(${sale.id})">${svg('print')} Imprimir resumen actualizado</button>
    </div>
  `, 'modal-lg');
}

async function imprimirVentaResumenActualizado(saleId) {
  const result = await window.api.sales.corrections.getHistory({ id: saleId, requestUserId: user.id });
  if (!result?.ok) return toast(result?.error || 'No se pudo preparar el resumen', 'err');
  const data = result.data;
  const sale = data.sale;
  const creditTotal = (data.relatedDocuments || [])
    .filter(document => document.type === 'devolucion' && document.status !== 'cancelled')
    .reduce((sum, document) => sum + Number(document.total || 0), 0);
  const debitTotal = (data.relatedDocuments || [])
    .filter(document => document.document_role === 'supplemental_invoice' && document.status !== 'cancelled')
    .reduce((sum, document) => sum + Number(document.total || 0), 0);
  const netTotal = Math.max(0, Number(sale.total || 0) - creditTotal + debitTotal);
  const paymentTotal = (data.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const paymentState = creditTotal > 0 || debitTotal > 0
    ? 'Distribuido entre la factura original y sus documentos relacionados'
    : sale.payment_method === 'credito'
    ? (paymentTotal >= netTotal ? 'Pagada' : `Pendiente: ${fmt(Math.max(0, netTotal - paymentTotal))}`)
    : 'Pagada / cobrada en su fecha real';
  const rows = (data.corrections || []).map(correction => `
    <tr><td>${ventasEsc(correction.created_at)}</td><td>${ventasEsc(correction.action)}</td>
    <td>${ventasEsc(correction.reason)}</td><td>${ventasEsc(correction.authorized_by_name || '—')}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;color:#111827;margin:28px;font-size:12px}
    h1{font-size:20px;margin:0 0 4px}.muted{color:#6b7280}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}
    .box{border:1px solid #e5e7eb;border-radius:7px;padding:10px}.box span{display:block;color:#6b7280;font-size:10px;text-transform:uppercase}
    .box strong{display:block;font-size:15px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{text-align:left;border-bottom:1px solid #e5e7eb;padding:7px}th{background:#f3f4f6;font-size:10px;text-transform:uppercase}
    .notice{margin-top:22px;border:1px solid #f59e0b;background:#fffbeb;padding:11px;border-radius:7px;font-weight:700}
  </style></head><body>
    <h1>Resumen actualizado de operación</h1>
    <div class="muted">${ventasEsc(facturaLabel(sale))}${sale.ncf ? ` · NCF ${ventasEsc(sale.ncf)}` : ''} · ${ventasEsc(sale.customer_name || 'Consumidor Final')}</div>
    <div class="grid">
      <div class="box"><span>Total original</span><strong>${fmt(sale.total)}</strong></div>
      <div class="box"><span>Notas de crédito / devoluciones</span><strong>-${fmt(creditTotal)}</strong></div>
      <div class="box"><span>Aumentos vinculados</span><strong>+${fmt(debitTotal)}</strong></div>
      <div class="box"><span>Total neto comercial</span><strong>${fmt(netTotal)}</strong></div>
      <div class="box"><span>Fecha original</span><strong>${fdate(sale.original_sale_date)}</strong></div>
      <div class="box"><span>Fecha operativa actual</span><strong>${fdate(sale.sale_date)}</strong></div>
      <div class="box"><span>Fecha fiscal</span><strong>${sale.fiscal_issued_at ? fdate(String(sale.fiscal_issued_at).slice(0,10)) : 'No aplica'}</strong></div>
    </div>
    <div class="box"><span>Estado de pago</span><strong>${ventasEsc(paymentState)}</strong></div>
    <table><thead><tr><th>Fecha</th><th>Acción</th><th>Motivo</th><th>Autorizó</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">Sin correcciones aplicadas</td></tr>'}</tbody></table>
    <div class="notice">Este documento es un resumen comercial y no sustituye la factura ni los documentos fiscales relacionados.</div>
  </body></html>`;
  if (typeof printHTML === 'function') {
    await printHTML(html, 'factura');
  } else {
    toast('Servicio de impresión no disponible', 'err');
  }
}

// Generar (o reutilizar) el conduce de una venta ya realizada, guardarlo en el
// módulo Conduces e imprimirlo. Idempotente: si ya existe, reimprime el mismo.
async function generarConduceVenta(saleId) {
  const res = await window.api.conduce.fromSale({ saleId, requestUserId: user.id });
  if (!res?.ok || !res.data) { toast(res?.error || 'No se pudo generar el conduce', 'err'); return; }
  closeModal();
  if (typeof printConduceDoc === 'function') printConduceDoc(res.data);
  toast(`✓ Conduce ${res.data.number} guardado en Conduces`);
}

// ── Guardar venta como PDF (bajo demanda) ─────
async function guardarVentaPDF(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('Venta no encontrada', 'err'); return; }
  const payload = ventasPrintPayload(sale);
  const label = sale.type === 'cotizacion' ? 'Cotizacion' : sale.type === 'devolucion' ? 'Devolucion' : 'Factura';
  if (typeof guardarDocumentoPDF === 'function') {
    guardarDocumentoPDF(() => printReceipt(payload, true), `${label}-${facturaLabel(sale).replace(/^#/, '')}`);
  } else {
    toast('Guardar PDF no disponible', 'err');
  }
}

// ── WhatsApp ──────────────────────────────────
async function ventaWhatsApp(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('No se pudo cargar la venta', 'e'); return; }

  const items   = sale.items || [];
  const fecha   = (sale.sale_date || sale.date || '').split('T')[0].split(' ')[0];
  const tipo    = sale.type === 'cotizacion' ? 'COTIZACION' : 'FACTURA';
  const cliente = sale.customer_name || 'Consumidor Final';
  const taxAmt  = sale.tax_amt || 0;
  const ncf     = sale.ncf || '';

  const itemLines = items.map(function(i) {
    return '  - ' + (i.product_name || i.name) + ' x' + i.qty +
           ' - ' + fmt((i.unit_price || i.price) * i.qty);
  }).join('\n');

  const parts = [
    tipo + ' ' + facturaLabel(sale) + ' - ' + CFG.biz,
    'Fecha: ' + fdate(fecha),
    'Cliente: ' + cliente,
    '',
    'Detalle:',
    itemLines,
    '',
    taxAmt > 0 ? 'ITBIS (' + CFG.itbis + '%): ' + fmt(taxAmt) : '',
    'TOTAL: ' + fmt(sale.total || 0),
    ncf ? 'NCF: ' + ncf : '',
    '',
    CFG.biz,
    CFG.phone ? 'Tel: ' + CFG.phone : '',
    'Gracias por su preferencia',
  ];
  const msg = parts.filter(function(l){ return l !== null && l !== undefined && l !== ''; }).join('\n');

  const client   = DB.customers.find(function(c){ return c.name === sale.customer_name; });
  const defPhone = client && client.phone
    ? client.phone.replace(/[^0-9]/g, '')
    : (CFG.phone || '').replace(/[^0-9]/g, '');

  openWhatsAppModal(msg, defPhone, cliente);
}

async function ventaWhatsAppPDF(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('No se pudo cargar el documento', 'err'); return; }
  if (typeof enviarDocumentoPDFWhatsApp !== 'function') {
    toast('Envío de PDF no disponible', 'err');
    return;
  }
  const cliente = sale.customer_name || 'Consumidor Final';
  const client = (DB.customers || []).find(c => Number(c.id) === Number(sale.customer_id));
  const phone = (
    sale.customer_contact_phone ||
    sale.customer_phone ||
    client?.phone ||
    ''
  ).replace(/\D/g, '');
  const typeName = documentTypeLabel(sale);
  const message = [
    `${typeName} ${facturaLabel(sale)} · ${CFG.biz}`,
    `Cliente: ${cliente}`,
    `Total: ${fmt(sale.total || 0)}`,
    'Adjuntamos el documento en formato PDF.',
    'Gracias por su preferencia.',
  ].join('\n');
  const fileLabel = `${typeName.replace(/\s+/g, '-')}-${facturaLabel(sale).replace(/^#/, '')}`;
  enviarDocumentoPDFWhatsApp(
    () => printReceipt(ventasPrintPayload(sale), true),
    fileLabel,
    { message, phone, clientName: cliente }
  );
}

// ── Exportar PDF ventas ───────────────────────
function exportVentasPDF() {
  const rangeLabels = {
    today: 'Hoy', week: 'Esta semana', month: 'Este mes', all: 'Todas'
  };

  const sales = DB.sales.filter(s => s.status !== 'cancelled');
  const total = sales.reduce((a, s) => a + (s.total || 0), 0);

  const rows = [...sales].sort((a, b) => (b.id || 0) - (a.id || 0)).map(s => {
    const fecha  = (s.sale_date || s.date || '').split('T')[0].split(' ')[0];
    const method = s.payment_method || s.pay || '';
    const name   = s.customer_name  || 'Consumidor Final';
    return `
      <tr>
        <td>${facturaLabel(s)}</td>
        <td>${fdate(fecha)}</td>
        <td>${_esc(name)}</td>
        <td style="text-transform:capitalize">${_esc(method)}</td>
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
</style></head><body>
  <h2>Historial de Ventas — ${_esc(CFG.biz)}</h2>
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
  <div class="foot">${_esc(CFG.biz)} · ${_esc(CFG.phone)} · ${_esc(CFG.addr)}</div>
</body></html>`;

  printHTML(html, 'reporte');
}

// ══════════════════════════════════════════════
// DEVOLUCIONES
// ══════════════════════════════════════════════
async function renderDevoluciones(el) {
  // Devoluciones tiene su propia carga completa. No reutiliza la colección
  // filtrada de Ventas, porque allí las notas de crédito se excluyen adrede.
  el.innerHTML = '<div class="empty"><p>Cargando devoluciones...</p></div>';
  await reloadSales({ range: 'all' });
  if (page !== 'devoluciones' || !el.isConnected) return;
  el.innerHTML = '';

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Devoluciones y notas de crédito'),
      h('div', { class: 'sec-sub' }, 'Devuelve productos o consulta ajustes monetarios emitidos')
    )
  ));

  const searchCard = h('div', { class: 'card mb20' });
  searchCard.appendChild(
    h('div', { style: { fontWeight: 700, fontSize: '13px', marginBottom: '12px' } },
      'Buscar factura para devolver productos')
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

  // Auto-búsqueda si viene desde el historial de ventas
  if (window._devolucionFromSaleId) {
    const fromId = window._devolucionFromSaleId;
    window._devolucionFromSaleId = null;
    setTimeout(() => {
      const inp = document.getElementById('dev-search-inp');
      if (inp) {
        inp.value = String(fromId);
        buscarFacturaDevolucion();
      }
    }, 100);
  }

  // Historial devoluciones
  const devs = DB.sales.filter(s => s.type === 'devolucion');
  const histCard = h('div', { class: 'card' });
  histCard.appendChild(h('div', { class: 'fxb mb8' },
        h('div', { class: 'card-title' }, `Historial de créditos (${devs.length})`)
  ));

  if (!devs.length) {
    histCard.appendChild(h('div', { class: 'empty', style: { padding: '24px' } },
      h('div', { html: svg('return'), style: { color: 'var(--muted2)' } }),
      h('p', null, 'Sin devoluciones ni notas de crédito registradas')
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
      const fecha = (d.sale_date || d.date || '').split('T')[0].split(' ')[0];
      tbody.appendChild(h('tr', { style: { background: 'var(--red-bg)' } },
        h('td', { class: 'tm' }, facturaLabel(d)),
        h('td', { class: 'ts' }, fdate(fecha)),
        h('td', null,
          h('div', { class: 'tb' }, d.customer_name || d.clientName || '—'),
          h('div', { class: 'ts' },
            d.correction_kind === 'monetary_credit' ? 'Ajuste monetario' : 'Devolución de productos')
        ),
        h('td', { class: 'tm' }, d.original_sale_id ? facturaLabelOriginal(d) : '—'),
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

  const qNum    = parseInt(q) || null;
  const qNorm   = searchNorm(q);
  const qDigits = digitsOf(q);
  const matches = DB.sales.filter(s => {
    if (s.type === 'devolucion' || s.status === 'cancelled' || s.status === 'returned') return false;
    if (!q) return true;
    // Cliente de la venta (para teléfono)
    const cli = DB.customers.find(c => c.id === (s.customer_id || s.clientId));
    return (
      (qNum && s.id === qNum) ||
      String(s.id).padStart(5, '0').includes(q) ||
      String(s.id).includes(q) ||
      matchText(s.customer_name, qNorm) ||
      matchText(s.customer_rnc, qNorm) ||
      matchText(s.customer_contact_name, qNorm) ||
      matchDigits(s.customer_rnc, qDigits) ||
      matchDigits(s.customer_contact_phone, qDigits) ||
      matchDigits(cli?.phone, qDigits) ||
      // Producto dentro de la factura: items[] si está cargado, si no items_summary
      (s.items && s.items.length
        ? s.items.some(i =>
            matchText(i.product_name || i.name, qNorm) ||
            matchText(i.product_code || i.code, qNorm) ||
            matchText(DB.products.find(p => p.id === i.product_id)?.model, qNorm)
          )
        : matchText(s.items_summary, qNorm))
    );
  });

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
    const items = (saleCompleto?.items || []).filter(i =>
      Number(i.returnable_qty ?? i.qty) > 0
    );
    if (!items.length) continue;
    const fecha = (s.sale_date || '').split('T')[0].split(' ')[0];

    const card = h('div', { class: 'card', style: { marginBottom: '8px' } });
    card.appendChild(h('div', { class: 'fxb', style: { marginBottom: '8px' } },
      h('div', null,
        h('span', { style: { fontWeight: 700 } }, `Factura ${facturaLabel(s)}`),
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
            `${item.returnable_qty ?? item.qty} disponible(s) de ${item.qty} · ${fmt(item.unit_price || item.price)} c/u`)
        ),
        h('input', {
          class: 'inp', type: 'number',
          id: `dev-qty-${s.id}-${idx}`,
          value: item.returnable_qty ?? item.qty, min: 1, max: item.returnable_qty ?? item.qty,
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
          taxable:      item.taxable,
          tax_pct:      item.tax_pct,
          tax_amt:      item.tax_amt,
          net_subtotal: item.net_subtotal,
          original_qty: item.qty,
          qty: Math.min(
            parseInt(qtyEl?.value) || (item.returnable_qty ?? item.qty),
            item.returnable_qty ?? item.qty
          ),
        });
      }
  });

  if (!returnItems.length) {
    toast('Selecciona al menos un artículo', 'err'); return;
  }

  const taxPct   = originalSale.type === 'factura'
    ? (originalSale.tax_pct != null ? originalSale.tax_pct : (CFG.itbis ?? 18))
    : 0;
    const hasIncludedTaxSnapshot = returnItems.some(i =>
      i.taxable !== null && i.taxable !== undefined ||
      i.tax_pct !== null && i.tax_pct !== undefined ||
      i.tax_amt !== null && i.tax_amt !== undefined ||
      i.net_subtotal !== null && i.net_subtotal !== undefined
    );
    const totals = hasIncludedTaxSnapshot
      ? (() => {
          const subtotal = ventasRound2(returnItems.reduce((sum, i) => {
            const ratio = i.original_qty ? i.qty / i.original_qty : 0;
            return sum + (Number(i.net_subtotal) || 0) * ratio;
          }, 0));
          const taxAmt = ventasRound2(returnItems.reduce((sum, i) => {
            const ratio = i.original_qty ? i.qty / i.original_qty : 0;
            return sum + (Number(i.tax_amt) || 0) * ratio;
          }, 0));
          return { subtotal, taxAmt, total: ventasRound2(subtotal + taxAmt) };
        })()
      : (() => {
          return ventasCalcIncludedTotals(returnItems, {
            type: originalSale.type,
            discPct: originalSale.discount_pct || originalSale.disc || 0,
          });
        })();
    const total = totals.total;

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
      if (result.overpayment > 0) {
        toast(`⚠ El cliente ya había pagado de más por esta factura — excedente de ${fmt(result.overpayment)} a revisar manualmente (reembolso o crédito)`, 'w');
      }
      closeModal();
      renderDevoluciones(document.getElementById('page'));
    },
    'Confirmar Devolución',
    'btn-red'
  );
}
