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

  refreshVentas(el);
}

async function refreshVentas(el) {
  await reloadSales({ range: ventasRange });
  renderVentasTable();
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
      if (s.status === 'cancelled') return false;
    }

    // Filtro de método (solo facturas)
    const matchPay = esCotizTab || !ventasPay || method === ventasPay;

    // Búsqueda extendida: #, cliente, RNC, teléfono, producto (código/nombre/modelo)
    const matchQ = !qNorm ||
      String(s.id).includes(q) ||
      matchText(name, qNorm) ||
      matchText(rnc, qNorm) ||
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
    const total = sales.reduce((a, s) => a + (s.total || 0), 0);

    const resGrid = h('div', { class: 'metrics',
      style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '16px' } });

    const metItems = esCotizTab ? [
      { icon: 'list',   color: 'p', label: 'Cotizaciones',   val: sales.length },
      { icon: 'dollar', color: 'g', label: 'Valor Total',    val: fmt(total) },
      { icon: 'clock',  color: 'a', label: 'Pendientes hoy', val: sales.filter(s => (s.created_at||'').slice(0,10) === today()).length },
      { icon: 'check',  color: 'b', label: 'Convertibles',   val: sales.filter(s => s.status !== 'cancelled').length },
    ] : [
      { icon: 'list',  color: 'b', label: 'Transacciones', val: sales.length },
      { icon: 'dollar',color: 'g', label: 'Total',         val: fmt(total) },
      { icon: 'cash',  color: 'g', label: 'Efectivo',      val: fmt(sales.filter(s => (s.payment_method||s.pay) === 'efectivo').reduce((a,s)=>a+(s.total||0),0)) },
      { icon: 'card',  color: 'p', label: 'Tarj/Trans',    val: fmt(sales.filter(s => ['tarjeta','transferencia'].includes(s.payment_method||s.pay||'')).reduce((a,s)=>a+(s.total||0),0)) },
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
        ...['#','Fecha','Cliente','Método','ITBIS','Total',''].map(t =>
          h('th', null, t)
        )
      )
    )
  );
  const tbody = h('tbody', null);

  // Orden del historial: la venta más reciente arriba (descendente por id,
  // que es el orden de creación), y de ahí bajando a las más antiguas.
  [...sales].sort((a, b) => (b.id || 0) - (a.id || 0)).forEach(s => {
    const method    = s.payment_method || s.pay || '';
    const cliName   = s.customer_name  || s.clientName || 'Consumidor Final';
    const fecha     = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
    const hora      = s.created_at
      ? new Date(s.created_at).toLocaleTimeString('es-DO',
          { hour: '2-digit', minute: '2-digit' })
      : (s.time || '');
    const taxAmt    = s.tax_amt || s.itbis || 0;
    const tieneNcf  = !!(s.ncf);
    const ecfOk     = s.ecf_status === 'Aceptado';

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
      h('tr', null,
        h('td', null,
          h('span', { class: 'tm', style: { fontSize: '11px' } }, `#${s.id}`),
          h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } }, s.type || 'factura'),
          ecfBadge
        ),
        h('td', null,
          h('div', { style: { fontSize: '12px', fontWeight: 500 } }, fdate(fecha)),
          h('div', { class: 'ts' }, hora)
        ),
        h('td', null,
          h('div', { class: 'tb' }, cliName),
          h('div', { class: 'ts' }, s.cajero || ''),
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

      const result = await window.api.ecf.emit({ saleId });

      if (!result.ok) {
        closeModal();
        toast(result.error || 'Error al enviar e-CF', 'err');
        return;
      }

      closeModal();

      // Recargar para reflejar el nuevo ecf_status
      await reloadSales({ range: ventasRange });
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
  const subtotal = estado.items.reduce((a, i) => a + i.unit_price * i.qty, 0);
  const discAmt  = subtotal * (estado.discount / 100);
  const base     = subtotal - discAmt;
  const taxAmt   = 0; // cotización no tiene ITBIS — la factura lo calculará
  const total    = base;

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
    <div class="modal-title">Convertir Cotización #${String(s.id).padStart(5,'0')} en Venta</div>
    <div class="modal-sub">
      Cliente: <strong>${sale.customer_name || 'Consumidor Final'}</strong> ·
      ${(sale.created_at||'').split('T')[0]}
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
      <div class="tr"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
      ${estado.discount > 0 ? `<div class="tr"><span>Descuento (${estado.discount}%)</span><span>−${fmt(discAmt)}</span></div>` : ''}
      <div class="tr grand"><span>TOTAL ESTIMADO</span><span>${fmt(total)}</span></div>
      <div style="font-size:10px;color:var(--muted2);margin-top:4px">El ITBIS se calculará al confirmar según tipo de factura.</div>
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

  const customer = DB.customers.find(c => c.id === sale.customer_id) ||
    { id: 1, name: sale.customer_name || 'Consumidor Final', rnc: '' };

  const result = await window.api.sales.create({
    saleData: {
      customer,
      items: itemsValidos.map(i => ({
        product_id:   i.product_id,
        product_code: i.product_code || '',
        product_name: i.product_name,
        unit_cost:    i.unit_cost || 0,
        unit_price:   i.unit_price,
        qty:          i.qty,
      })),
      payment: {
        method:    est.pay,
        disc:      est.discount,
        priceMode: sale.price_mode || 'retail',
      },
      type:    'factura',
      session: cajaSession,
    },
    requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al convertir', 'err'); return; }

  await window.api.sales.cancel({
    id: cotizId,
    reason: `Convertida en factura #${result.saleId}`,
    requestUserId: user.id,
  });

  await reloadSales({ range: 'all' });
  await reloadProducts();
  closeModal();
  delete window._convEstado;
  delete window._convSale;
  delete window._convOrigId;

  toast(`✓ Cotización convertida → Factura #${String(result.saleId).padStart(5,'0')}`);
  printReceipt({
    id:             result.saleId,
    type:           'factura',
    customer_name:  sale.customer_name || 'Consumidor Final',
    customer_rnc:   sale.customer_rnc  || '',
    items:          itemsValidos,
    subtotal:       itemsValidos.reduce((a,i)=>a+i.unit_price*i.qty,0),
    discount_pct:   est.discount,
    discount_amt:   itemsValidos.reduce((a,i)=>a+i.unit_price*i.qty,0)*(est.discount/100),
    tax_amt:        result.taxAmt || 0,
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
  const tieneNcf = !!(s.ncf);
  const ecfOk    = s.ecf_status === 'Aceptado';

  // Sección e-CF en el detalle
  const ecfSection = tieneNcf ? `
    <div class="card" style="background:${ecfOk ? 'var(--green-bg,#f0fdf4)' : 'var(--surface2)'};margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Comprobante Fiscal Electrónico</div>
          <div style="font-family:monospace;font-weight:700;font-size:13px">${s.ncf}</div>
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
          : `${s.ecf_qr
              ? `<img src="${s.ecf_qr}" style="width:56px;height:56px;border-radius:4px" title="QR e-CF"/>`
              : ''}`}
      </div>
    </div>` : '';

  openModal(`
    <div class="modal-title">Venta ${typeof facturaLabel === 'function' ? facturaLabel(sale || s) : '#'+String(s.id).padStart(5,'0')}</div>
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
    ${ecfSection}
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
      <button class="btn btn-out" onclick="guardarVentaPDF(${s.id})">
        ${svg('pdf')} Guardar PDF
      </button>
      <button class="btn btn-out" style="background:#25D366;color:#fff;border-color:#25D366"
              onclick="ventaWhatsApp(${s.id})"
              title="Enviar resumen por WhatsApp">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="flex-shrink:0">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/>
        </svg>
        WhatsApp
      </button>
      ${s.type !== 'devolucion' && s.status === 'completed'
        ? `<button class="btn btn-amber" onclick="closeModal();iniciarDevolucionDesdeVenta(${s.id})">
             ${svg('return')} Devolver
           </button>`
        : ''}
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
  if (result.overpayment > 0) {
    toast(`⚠ El cliente ya había pagado de más por esta factura — excedente de ${fmt(result.overpayment)} a revisar manualmente (reembolso o crédito)`, 'w');
  }
  renderVentas(document.getElementById('page'));
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

  const fecha = (sale.created_at || '').split('T')[0];
  const hora  = sale.created_at
    ? new Date(sale.created_at).toLocaleTimeString('es-DO',
        { hour: '2-digit', minute: '2-digit' })
    : '';

  confirmModal(
    `¿Reimprimir la factura <strong>${facturaLabel(sale)}</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       Quedará registrado en el log de auditoría como reimpresión.
     </span>`,
    () => {
      printReceipt({
        id:              sale.id,
        // Número real de factura para que la reimpresión muestre #00002311, no el id interno.
        numero_factura:     sale.numero_factura,
        numero_factura_fmt: sale.numero_factura_fmt,
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
        // NCF real de la venta (factura) o nota de crédito B04 (devolución),
        // y el NCF que la nota modifica — antes la reimpresión no los pasaba.
        ncf:             sale.ncf || '',
        tax_pct:         sale.tax_pct,
        modifies_ncf:    sale.modifies_ncf || '',
        // Devolución: referencia a la factura original (número real).
        original_sale_id:            sale.original_sale_id || null,
        original_numero_factura:     sale.original_numero_factura,
        original_numero_factura_fmt: sale.original_numero_factura_fmt,
      }, true); // true = isReprint
    },
    'Reimprimir',
    'btn-dark'
  );
}

// ── Guardar venta como PDF (bajo demanda) ─────
async function guardarVentaPDF(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('Venta no encontrada', 'err'); return; }
  const fecha = (sale.created_at || '').split('T')[0];
  const hora  = sale.created_at
    ? new Date(sale.created_at).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }) : '';
  const payload = {
    id: sale.id, date: fecha, time: hora, type: sale.type,
    numero_factura: sale.numero_factura, numero_factura_fmt: sale.numero_factura_fmt,
    customer_name: sale.customer_name || 'Consumidor Final', customer_rnc: sale.customer_rnc || '',
    items: (sale.items || []).map(i => ({
      product_name: i.product_name, qty: i.qty, unit_price: i.unit_price, unit_cost: i.unit_cost || 0,
    })),
    subtotal: sale.subtotal, discount_pct: sale.discount_pct || 0, discount_amt: sale.discount_amt || 0,
    tax_amt: sale.tax_amt || 0, total: sale.total, payment_method: sale.payment_method,
    cajero: sale.cajero, ncf: sale.ncf || '', tax_pct: sale.tax_pct, modifies_ncf: sale.modifies_ncf || '',
    original_sale_id: sale.original_sale_id || null,
    original_numero_factura: sale.original_numero_factura,
    original_numero_factura_fmt: sale.original_numero_factura_fmt,
  };
  const label = sale.type === 'cotizacion' ? 'Cotizacion' : sale.type === 'devolucion' ? 'Devolucion' : 'Factura';
  if (typeof guardarDocumentoPDF === 'function') {
    guardarDocumentoPDF(() => printReceipt(payload, true), `${label}-${String(sale.id).padStart(5, '0')}`);
  } else {
    toast('Guardar PDF no disponible', 'err');
  }
}

// ── WhatsApp ──────────────────────────────────
async function ventaWhatsApp(saleId) {
  const sale = await window.api.sales.getById({ id: saleId });
  if (!sale) { toast('No se pudo cargar la venta', 'e'); return; }

  const items   = sale.items || [];
  const fecha   = (sale.created_at || sale.date || '').split('T')[0].split(' ')[0];
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

// ── Exportar PDF ventas ───────────────────────
function exportVentasPDF() {
  const rangeLabels = {
    today: 'Hoy', week: 'Esta semana', month: 'Este mes', all: 'Todas'
  };

  const sales = DB.sales.filter(s => s.status !== 'cancelled');
  const total = sales.reduce((a, s) => a + (s.total || 0), 0);

  const rows = [...sales].sort((a, b) => (b.id || 0) - (a.id || 0)).map(s => {
    const fecha  = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
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
        h('td', { class: 'tm' }, facturaLabel(d)),
        h('td', { class: 'ts' }, fdate(fecha)),
        h('td', null, h('div', { class: 'tb' }, d.customer_name || d.clientName || '—')),
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
      matchDigits(s.customer_rnc, qDigits) ||
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
    const items = saleCompleto?.items || [];
    const fecha = (s.created_at || '').split('T')[0].split(' ')[0];

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

  const taxPct   = originalSale.type === 'factura'
    ? (originalSale.tax_pct != null ? originalSale.tax_pct : (CFG.itbis ?? 18))
    : 0;
  const subtotal = Math.round(returnItems.reduce((a, i) => a + i.unit_price * i.qty, 0) * 100) / 100;
  const taxAmt   = Math.round(subtotal * (taxPct / 100) * 100) / 100;
  const total    = Math.round((subtotal + taxAmt) * 100) / 100;

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
