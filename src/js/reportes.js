// ══════════════════════════════════════════════
// reportes.js — Módulo de Reportes
//   · Ingresos, costos y utilidad bruta
//   · Rango personalizado de fechas
//   · Productos más vendidos con ganancia
//   · Ventas por método de pago
//   · Créditos pendientes
//   · Stock bajo
//   · Gráfica de ventas diarias
//   · Exportar PDF completo
// ══════════════════════════════════════════════

let repRange   = 'month';
let repDateFrom = '';
let repDateTo   = '';
let repData     = null;
let repTab      = 'financiero'; // 'financiero' | 'abonos' | 'inventario'

function _repEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderReportes(el) {
  el.innerHTML = '';

  if (window._reportesTabInicial) {
    repTab = window._reportesTabInicial;
    delete window._reportesTabInicial;
  }
  if (window._reportesRangeInicial) {
    repRange = window._reportesRangeInicial;
    delete window._reportesRangeInicial;
  }

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Reportes'),
      h('div', { class: 'sec-sub' }, 'Análisis financiero del negocio')
    ),
    h('button', {
      class: 'btn btn-out btn-sm',
      onclick: exportReportePDF,
      html: `${svg('pdf')} Exportar PDF`
    })
  ));

  // ── Pestañas principales ─────────────────────
  const mainTabs = h('div', { class: 'flex', style: 'gap:8px;margin-bottom:16px' });
  [
    { v: 'financiero', l: 'Financiero' },
    { v: 'abonos',     l: 'Abonos CxC' },
    { v: 'inventario', l: 'Inventario valorizado' },
  ].forEach(t => {
    mainTabs.appendChild(h('button', {
      class: `btn ${repTab === t.v ? 'btn-dark' : 'btn-out'} btn-sm`,
      html: t.l,
      onclick: () => { repTab = t.v; renderReportes(el); }
    }));
  });
  el.appendChild(mainTabs);

  // Si pestaña inventario, renderizar y salir
  if (repTab === 'inventario') {
    await _renderReporteInventario(el);
    return;
  }

  // ── Selector de rango ────────────────────────
  const rangeBar = h('div', { class: 'flex', style: { gap: '8px', marginBottom: '16px', flexWrap: 'wrap' } });

  const tabs = h('div', { class: 'tabs', style: { marginBottom: 0 } });
  [
    { v: 'today',  l: 'Hoy'         },
    { v: 'week',   l: 'Semana'      },
    { v: 'month',  l: 'Este mes'    },
    { v: 'all',    l: 'Histórico'   },
    { v: 'custom', l: 'Personalizado' },
  ].forEach(o => {
    tabs.appendChild(h('button', {
      class: `tab ${repRange === o.v ? 'on' : ''}`,
      onclick: async (ev) => {
        repRange = o.v;
        // Actualizar visual de tabs inmediatamente
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
        ev.currentTarget.classList.add('on');
        if (o.v !== 'custom') await cargarYRenderizar(el);
        else renderRangeInputs();
      }
    }, o.l));
  });
  rangeBar.appendChild(tabs);

  // Inputs de rango personalizado
  const customDiv = h('div', { id: 'rep-custom',
    style: { display: repRange === 'custom' ? 'flex' : 'none', gap: '8px', alignItems: 'center' } });
  customDiv.innerHTML = `
    <input class="inp" id="rep-from" type="date" value="${repDateFrom}"
           style="width:140px" placeholder="Desde"/>
    <span style="color:var(--muted)">—</span>
    <input class="inp" id="rep-to" type="date" value="${repDateTo}"
           style="width:140px" placeholder="Hasta"/>
    <button class="btn btn-dark btn-sm" id="rep-custom-btn">
      Buscar
    </button>`;
  customDiv.querySelector('#rep-custom-btn')?.addEventListener('click', aplicarRangoCustom);
  rangeBar.appendChild(customDiv);
  el.appendChild(rangeBar);

  await cargarYRenderizar(el);
}

function renderRangeInputs() {
  const div = document.getElementById('rep-custom');
  if (div) div.style.display = 'flex';
}

async function aplicarRangoCustom() {
  repDateFrom = document.getElementById('rep-from')?.value || '';
  repDateTo   = document.getElementById('rep-to')?.value   || '';
  if (!repDateFrom || !repDateTo) {
    toast('Selecciona las dos fechas', 'err'); return;
  }
  if (repDateFrom > repDateTo) {
    toast('La fecha inicio debe ser antes que la fecha fin', 'err'); return;
  }
  const el = document.getElementById('page');
  if (el) await cargarYRenderizar(el);
}

async function cargarYRenderizar(el) {
  // Limpiar contenido previo (excepto header y rangeBar)
  const children = Array.from(el.children);
  children.slice(3).forEach(c => c.remove());

  // Loading
  const loading = h('div', { style: { textAlign: 'center', padding: '40px', color: 'var(--muted2)' } },
    'Cargando datos...');
  el.appendChild(loading);

  try {
    const payload = {
      range:         repRange,
      dateFrom:      repDateFrom || null,
      dateTo:        repDateTo   || null,
      requestUserId: user.id,
    };
    const result = repTab === 'abonos'
      ? await window.api.reports.paymentsHistory(payload)
      : await window.api.reports.summary(payload);

    loading.remove();

    if (!result.ok) {
      el.appendChild(h('div', { class: 'alrt r' },
        h('div', { class: 'alrt-dot r' }),
        h('div', null, h('div', { class: 'alrt-title' }, result.error || 'Error al cargar'))
      ));
      return;
    }

    repData = result.data;
    if (repTab === 'abonos') renderAbonosContenido(el, repData);
    else renderReporteContenido(el, repData);

  } catch (e) {
    loading.remove();
    el.appendChild(h('div', { class: 'alrt r' },
      h('div', { class: 'alrt-dot r' }),
      h('div', null, h('div', { class: 'alrt-title' }, 'Error: ' + e.message))
    ));
  }
}

function renderReporteContenido(el, d) {
  const {
    byMethod, totalRev, totalCost, totalTax, totalDisc,
    totalUnits, totalSales, grossProfit, netRev, margin,
    topProducts, dailySales, devolucion, abonos
  } = d;

  // Si todas las ventas fueron importadas sin precio de costo, no calcular margen
  const noCostData = totalCost === 0 && totalRev > 0;

  // ── Métricas principales ─────────────────────
  const metWrap = h('div', { class: 'metrics',
    style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '20px' } });
  [
    { icon: 'dollar',  color: 'g', label: 'Ingresos Totales',  val: fmt(totalRev),      sub: `${totalSales} facturas` },
    { icon: 'trend',   color: 'b', label: 'Utilidad Bruta',
      val: noCostData ? '—' : fmt(grossProfit),
      sub: noCostData ? 'Sin datos de costo' : `Margen: ${margin.toFixed(1)}%` },
    { icon: 'receipt', color: 'p', label: 'ITBIS Generado',    val: fmt(totalTax),      sub: `Impuesto ${CFG?.itbis ?? 18}%` },
    { icon: 'box',     color: 'a', label: 'Unidades Vendidas', val: String(totalUnits), sub: `${devolucion.count} devueltas` },
  ].forEach(m => {
    metWrap.appendChild(
      h('div', { class: 'metric' },
        h('div', { class: 'met-top' },
          h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
        ),
        h('div', { class: 'met-label' }, m.label),
        h('div', { class: 'met-val' }, m.val),
        h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } }, m.sub)
      )
    );
  });
  el.appendChild(metWrap);

  // ── Métricas secundarias ─────────────────────
  const sec = h('div', { class: 'metrics',
    style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '20px' } });
  [
    { label: 'Costo de ventas',   val: noCostData ? '—' : fmt(totalCost),    color: 'var(--red)' },
    { label: 'Ingresos netos',    val: fmt(netRev),       color: 'var(--green)' },
    { label: 'Descuentos dados',  val: fmt(totalDisc),    color: 'var(--amber)' },
    { label: 'Abonos recibidos',  val: fmt(abonos.total), color: 'var(--blue)', sub: abonos.count > 0 ? `${abonos.count} abono${abonos.count !== 1 ? 's' : ''}` : 'Sin abonos en el período' },
  ].forEach(m => {
    sec.appendChild(
      h('div', { class: 'metric', style: { padding: '10px 14px' } },
        h('div', { class: 'met-label' }, m.label),
        h('div', { style: { fontSize: '18px', fontWeight: 800, color: m.color } }, m.val),
        m.sub ? h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } }, m.sub) : null
      )
    );
  });
  el.appendChild(sec);

  // ── Grid de reportes ─────────────────────────
  const grid = h('div', { class: 'gg2', style: { gap: '16px', alignItems: 'start' } });

  // ── Ventas por método ────────────────────────
  const payCard = h('div', { class: 'card' });
  payCard.appendChild(h('div', { class: 'card-title mb8' }, 'Por Método de Pago'));

  const payColors = {
    efectivo: 'var(--green)', tarjeta: 'var(--blue)',
    transferencia: 'var(--purple)', credito: 'var(--amber)', mixto: 'var(--ink3)',
  };

  if (!byMethod.length) {
    payCard.appendChild(h('div', { style: { color: 'var(--muted2)', fontSize: '12px', padding: '14px 0' } },
      'Sin ventas en este período'));
  } else {
    byMethod.sort((a, b) => b.total - a.total).forEach(m => {
      const pct = totalRev > 0 ? (m.total / totalRev) * 100 : 0;
      payCard.appendChild(
        h('div', { style: { marginBottom: '12px' } },
          h('div', { class: 'fxb', style: { marginBottom: '4px' } },
            h('span', { style: { fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' } },
              m.payment_method || 'efectivo'),
            h('div', { class: 'flex', style: { gap: '6px' } },
              h('span', { style: { fontSize: '12px', fontWeight: 700 } }, fmt(m.total)),
              h('span', { class: 'badge n', style: { fontSize: '10px' } },
                `${m.count} fact.`),
              h('span', { style: { fontSize: '10px', color: 'var(--muted2)' } },
                `${Math.round(pct)}%`)
            )
          ),
          h('div', { class: 'prog' },
            h('div', { class: 'prog-f', style: {
              width: `${pct}%`,
              background: payColors[m.payment_method] || 'var(--muted)'
            }})
          )
        )
      );
    });
  }
  grid.appendChild(payCard);

  // ── Productos más vendidos ───────────────────
  const prodCard = h('div', { class: 'card' });
  prodCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Productos Más Vendidos'),
    h('span', { style: { fontSize: '10px', color: 'var(--muted2)' } }, 'Con ganancia real')
  ));

  if (!topProducts.length) {
    prodCard.appendChild(h('div', { style: { color: 'var(--muted2)', fontSize: '12px', padding: '14px 0' } },
      'Sin datos'));
  } else {
    const maxQty = topProducts[0]?.total_qty || 1;
    topProducts.forEach((p, i) => {
      const pct       = (p.total_qty / maxQty) * 100;
      const hasCost   = p.total_cost > 0;
      const margin    = hasCost && p.total_rev > 0
        ? ((p.total_profit / p.total_rev) * 100).toFixed(0) : null;
      prodCard.appendChild(
        h('div', { style: { marginBottom: '11px' } },
          h('div', { class: 'fxb', style: { marginBottom: '3px' } },
            h('div', { class: 'flex', style: { gap: '6px', minWidth: 0, flex: 1 } },
              h('span', { style: {
                width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
                background: i < 3 ? 'var(--green)' : 'var(--surface3)',
                color: i < 3 ? '#fff' : 'var(--muted)',
                fontSize: '9px', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}, String(i + 1)),
              h('span', { style: { fontSize: '12px', fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                p.product_name)
            ),
            h('div', { class: 'flex', style: { gap: '6px', flexShrink: 0 } },
              h('span', { style: { fontSize: '11px', color: 'var(--muted2)' } },
                `${p.total_qty} und`),
              h('span', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--green)' } },
                hasCost ? fmt(p.total_profit) : '—'),
              h('span', { class: 'badge g', style: { fontSize: '9px' } },
                margin !== null ? `${margin}%` : 'N/A')
            )
          ),
          h('div', { class: 'prog' },
            h('div', { class: 'prog-f', style: {
              width: `${pct}%`,
              background: i < 3 ? 'var(--green)' : 'var(--blue)'
            }})
          )
        )
      );
    });
  }
  grid.appendChild(prodCard);

  // ── Créditos pendientes ──────────────────────
  const creditClients = DB.customers.filter(c => c.balance > 0 && c.id !== 1);
  const totalCredit   = creditClients.reduce((a, c) => a + c.balance, 0);
  const alerts        = getCreditAlerts();
  const alertMap      = {};
  alerts.forEach(a => { alertMap[a.client.id] = a; });

  const creditCard = h('div', { class: 'card' });
  creditCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Cuentas por Cobrar'),
    h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: exportReporteCreditoPDF,
      html: `${svg('pdf')} PDF`
    })
  ));

  creditCard.appendChild(
    h('div', { class: 'g2', style: { marginBottom: '12px' } },
      h('div', { class: 'card', style: { background: 'var(--red-bg)', borderColor: 'var(--red-line)' } },
        h('div', { class: 'met-label' }, 'Total por Cobrar'),
        h('div', { class: 'met-val', style: { color: 'var(--red)' } }, fmt(totalCredit))
      ),
      h('div', { class: 'card', style: { background: 'var(--surface2)' } },
        h('div', { class: 'met-label' }, 'Clientes con Deuda'),
        h('div', { class: 'met-val' }, String(creditClients.length)),
        alerts.length
          ? h('div', { style: { fontSize: '11px', color: 'var(--red)', marginTop: '3px' } },
              `${alerts.length} alerta(s)`)
          : h('div', { style: { fontSize: '11px', color: 'var(--green)', marginTop: '3px' } },
              '✓ Sin alertas')
      )
    )
  );

  creditClients.sort((a, b) => b.balance - a.balance).slice(0, 5).forEach(c => {
    const alert = alertMap[c.id];
    const pct   = c.credit_limit > 0
      ? Math.min((c.balance / c.credit_limit) * 100, 100) : 100;
    creditCard.appendChild(
      h('div', { style: { marginBottom: '10px' } },
        h('div', { class: 'fxb', style: { marginBottom: '3px' } },
          h('div', null,
            h('span', { style: { fontSize: '12px', fontWeight: 600 } }, c.name),
            alert?.status === 'overdue'
              ? h('span', { class: 'badge r', style: { fontSize: '9px', marginLeft: '5px' } }, 'Vencido')
              : alert?.status === 'soon'
              ? h('span', { class: 'badge a', style: { fontSize: '9px', marginLeft: '5px' } }, 'Por vencer')
              : null
          ),
          h('span', { style: { fontSize: '12px', fontWeight: 700, color: 'var(--red)' } },
            fmt(c.balance))
        ),
        h('div', { class: 'prog' },
          h('div', { class: 'prog-f', style: {
            width: `${pct}%`,
            background: pct > 90 ? 'var(--red)' : pct > 60 ? 'var(--amber)' : 'var(--green)'
          }})
        )
      )
    );
  });
  grid.appendChild(creditCard);

  // ── Stock bajo ───────────────────────────────
  const lowStock  = DB.products.filter(p => p.stock <= (p.stock_min || 5));
  const outStock  = lowStock.filter(p => p.stock === 0);
  const stockCard = h('div', { class: 'card' });
  stockCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', null,
      h('div', { class: 'card-title' }, `Stock Bajo (${lowStock.length})`),
      outStock.length
        ? h('div', { style: { fontSize: '11px', color: 'var(--red)', marginTop: '2px' } },
            `${outStock.length} sin stock`)
        : null
    ),
    h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => routeTo('inventario'),
      html: `${svg('box')} Ver inventario`
    })
  ));

  if (!lowStock.length) {
    stockCard.appendChild(h('div', { class: 'alrt g' },
      h('div', { class: 'alrt-dot g' }),
      h('div', null,
        h('div', { class: 'alrt-title' }, 'Todo en orden'),
        h('div', { class: 'alrt-sub' }, 'No hay productos con stock bajo')
      )
    ));
  } else {
    lowStock.slice(0, 7).forEach(p => {
      const stockMin = p.stock_min || 5;
      const pct      = p.stock === 0 ? 0 : Math.min((p.stock / stockMin) * 100, 100);
      stockCard.appendChild(
        h('div', { style: { marginBottom: '10px' } },
          h('div', { class: 'fxb', style: { marginBottom: '3px' } },
            h('span', { style: { fontSize: '12px', fontWeight: 600 } }, p.name),
            h('span', { class: `badge ${p.stock === 0 ? 'r' : 'a'}` },
              p.stock === 0 ? 'Sin stock' : `${p.stock} ${p.unit||'und'}`)
          ),
          h('div', { class: 'prog' },
            h('div', { class: 'prog-f', style: {
              width: `${pct}%`,
              background: p.stock === 0 ? 'var(--red)' : 'var(--amber)'
            }})
          ),
          h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } },
            `Mínimo: ${stockMin} · ${p.code}`)
        )
      );
    });
  }
  grid.appendChild(stockCard);
  el.appendChild(grid);

  // ── Gráfica de ventas diarias ────────────────
  if (dailySales.length > 0) {
    const chartCard = h('div', { class: 'card', style: { marginTop: '16px' } });
    chartCard.appendChild(h('div', { class: 'fxb mb8' },
      h('div', null,
        h('div', { class: 'card-title' }, 'Ventas Diarias'),
        h('div', { style: { fontSize: '11px', color: 'var(--muted2)' } },
          `${dailySales.length} días con ventas`)
      ),
      h('div', { class: 'flex', style: { gap: '10px' } },
        h('div', { class: 'flex', style: { gap: '4px', alignItems: 'center' } },
          h('div', { style: { width: '10px', height: '10px', borderRadius: '2px',
            background: 'var(--green)' }}),
          h('span', { style: { fontSize: '10px', color: 'var(--muted)' } }, 'Ingresos')
        ),
        h('div', { class: 'flex', style: { gap: '4px', alignItems: 'center' } },
          h('div', { style: { width: '10px', height: '10px', borderRadius: '2px',
            background: 'var(--red)', opacity: '0.6' }}),
          h('span', { style: { fontSize: '10px', color: 'var(--muted)' } }, 'Costo')
        )
      )
    ));

    const maxVal = Math.max(...dailySales.map(d => d.total), 1);
    const barChart = h('div', { class: 'bar-chart', style: { height: '120px' } });

    // Si hay más de 30 días mostrar solo los últimos 30
    const days = dailySales.slice(-30);
    days.forEach(d => {
      const pctRev  = Math.max((d.total / maxVal) * 100, d.total > 0 ? 3 : 0);
      const pctCost = Math.max(((d.cost || 0) / maxVal) * 100, 0);
      const isToday = d.day === today();
      const label   = d.day?.slice(8); // día del mes

      barChart.appendChild(
        h('div', { class: 'bc', title: `${fdate(d.day)}: ${fmt(d.total)}` },
          h('div', { style: {
            position: 'relative', width: '100%', height: '100%',
            display: 'flex', alignItems: 'flex-end', gap: '1px'
          }},
            h('div', { class: 'bb', style: {
              flex: 1, height: `${pctRev}%`,
              background: isToday ? 'var(--green)' : 'var(--blue)',
              opacity: d.total > 0 ? '1' : '0.15'
            }}),
            pctCost > 0
              ? h('div', { style: {
                  flex: 1, height: `${pctCost}%`,
                  background: 'var(--red)', opacity: '0.5'
                }})
              : null
          ),
          h('div', { class: 'bl', style: {
            color: isToday ? 'var(--ink)' : 'var(--muted2)',
            fontWeight: isToday ? '700' : '400',
            fontSize: '8px'
          }}, label || '')
        )
      );
    });

    chartCard.appendChild(barChart);
    el.appendChild(chartCard);
  }
}

function renderAbonosContenido(el, d) {
  const summary = d?.summary || {};
  const byMonth = d?.byMonth || [];
  const byDay = d?.byDay || [];
  const byMethod = d?.byMethod || [];
  const rows = d?.rows || [];
  const rangeLabel = {
    today: 'Hoy',
    week: 'Esta semana',
    month: 'Este mes',
    all: 'Histórico completo',
    custom: `${repDateFrom || '...'} → ${repDateTo || '...'}`,
  }[repRange] || repRange;

  const metWrap = h('div', {
    class: 'metrics',
    style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '20px' }
  });
  [
    { label: 'Abonos recibidos', val: fmt(summary.total || 0), sub: `${summary.count || 0} registros`, color: 'var(--green)' },
    { label: 'Clientes con abono', val: String(summary.customers || 0), sub: rangeLabel, color: 'var(--blue)' },
    { label: 'Importación histórica', val: fmt(summary.importedTotal || 0), sub: 'registrado sin tocar caja actual', color: 'var(--amber)' },
    { label: 'Abonos operativos', val: fmt(summary.currentTotal || 0), sub: 'hechos desde el POS', color: 'var(--purple)' },
  ].forEach(m => {
    metWrap.appendChild(h('div', { class: 'metric' },
      h('div', { class: 'met-label' }, m.label),
      h('div', { style: { fontSize: '20px', fontWeight: 800, color: m.color } }, m.val),
      h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } }, m.sub)
    ));
  });
  el.appendChild(metWrap);

  const grid = h('div', { class: 'gg2', style: { gap: '16px', alignItems: 'start' } });

  const methodCard = h('div', { class: 'card' });
  methodCard.appendChild(h('div', { class: 'card-title mb8' }, 'Abonos por método'));
  if (!byMethod.length) {
    methodCard.appendChild(h('div', { style: 'font-size:12px;color:var(--muted2);padding:12px 0' }, 'Sin abonos en este período'));
  } else {
    const maxMethod = Math.max(...byMethod.map(m => m.total || 0), 1);
    byMethod.forEach(m => {
      const pct = ((m.total || 0) / maxMethod) * 100;
      methodCard.appendChild(h('div', { style: { marginBottom: '12px' } },
        h('div', { class: 'fxb', style: { marginBottom: '4px' } },
          h('span', { style: { fontSize: '12px', fontWeight: 700, textTransform: 'capitalize' } }, m.method || 'efectivo'),
          h('span', { style: { fontSize: '12px', fontWeight: 800 } }, fmt(m.total || 0))
        ),
        h('div', { class: 'prog' },
          h('div', { class: 'prog-f', style: { width: `${pct}%`, background: 'var(--green)' } })
        ),
        h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } },
          `${m.count || 0} abono${m.count === 1 ? '' : 's'}`)
      ));
    });
  }
  grid.appendChild(methodCard);

  const monthCard = h('div', { class: 'card' });
  monthCard.appendChild(h('div', { class: 'card-title mb8' }, 'Mes por mes'));
  if (!byMonth.length) {
    monthCard.appendChild(h('div', { style: 'font-size:12px;color:var(--muted2);padding:12px 0' }, 'Sin meses con abonos'));
  } else {
    const maxMonth = Math.max(...byMonth.map(m => m.total || 0), 1);
    byMonth.slice(0, 18).forEach(m => {
      const pct = ((m.total || 0) / maxMonth) * 100;
      const label = new Date(`${m.month}-02T12:00:00`).toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
      monthCard.appendChild(h('div', {
        style: { marginBottom: '12px', cursor: 'pointer' },
        title: 'Ver este mes',
        onclick: async () => {
          repRange = 'custom';
          repDateFrom = `${m.month}-01`;
          const last = new Date(`${m.month}-01T12:00:00`);
          last.setMonth(last.getMonth() + 1);
          last.setDate(0);
          repDateTo = last.toISOString().split('T')[0];
          await renderReportes(document.getElementById('page'));
        }
      },
        h('div', { class: 'fxb', style: { marginBottom: '4px' } },
          h('span', { style: { fontSize: '12px', fontWeight: 700, textTransform: 'capitalize' } }, label),
          h('span', { style: { fontSize: '12px', fontWeight: 800 } }, fmt(m.total || 0))
        ),
        h('div', { class: 'prog' },
          h('div', { class: 'prog-f', style: { width: `${pct}%`, background: 'var(--blue)' } })
        ),
        h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } },
          `${m.count || 0} abonos · histórico ${fmt(m.imported_total || 0)} · POS ${fmt(m.current_total || 0)}`)
      ));
    });
  }
  grid.appendChild(monthCard);
  el.appendChild(grid);

  const dayCard = h('div', { class: 'card', style: { marginTop: '16px' } });
  dayCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', null,
      h('div', { class: 'card-title' }, 'Día por día'),
      h('div', { style: { fontSize: '11px', color: 'var(--muted2)' } },
        `${byDay.length} día${byDay.length === 1 ? '' : 's'} con abonos`)
    ),
    h('span', { style: { fontSize: '12px', fontWeight: 800, color: 'var(--green)' } },
      fmt(summary.total || 0))
  ));
  if (!byDay.length) {
    dayCard.appendChild(h('div', { style: 'font-size:12px;color:var(--muted2);padding:12px 0' }, 'Sin abonos en este período'));
  } else {
    const maxDay = Math.max(...byDay.map(dy => dy.total || 0), 1);
    byDay.slice(0, 45).forEach(dy => {
      const pct = ((dy.total || 0) / maxDay) * 100;
      dayCard.appendChild(h('div', { style: { marginBottom: '10px' } },
        h('div', { class: 'fxb', style: { marginBottom: '4px' } },
          h('div', null,
            h('span', { style: { fontSize: '12px', fontWeight: 700 } }, fdate(dy.day)),
            h('span', { style: { fontSize: '10px', color: 'var(--muted2)', marginLeft: '8px' } },
              `${dy.count || 0} abono${dy.count === 1 ? '' : 's'}`)
          ),
          h('span', { style: { fontSize: '12px', fontWeight: 800 } }, fmt(dy.total || 0))
        ),
        h('div', { class: 'prog' },
          h('div', { class: 'prog-f', style: { width: `${pct}%`, background: 'var(--green)' } })
        )
      ));
    });
  }
  el.appendChild(dayCard);

  const tableCard = h('div', { class: 'card', style: { marginTop: '16px' } });
  tableCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', null,
      h('div', { class: 'card-title' }, 'Detalle de abonos'),
      h('div', { style: { fontSize: '11px', color: 'var(--muted2)' } },
        rows.length >= 5000 ? 'Mostrando los primeros 5,000 registros' : `${rows.length} registros`)
    )
  ));

  const rowsHtml = rows.length ? rows.map(p => {
    const fecha = (p.created_at || '').split('T')[0].split(' ')[0];
    const factura = p.sale_id ? `#${String(p.sale_id).padStart(5, '0')}` : 'Sin factura';
    const source = p.imported ? 'Histórico' : 'POS';
    return `<tr>
      <td>${fdate(fecha)}</td>
      <td>
        <div style="font-weight:700">${_repEsc(p.customer_name || 'Cliente eliminado')}</div>
        <div style="font-size:10px;color:var(--muted2)">${_repEsc(p.customer_rnc || '')}</div>
      </td>
      <td>
        <div>${factura}</div>
        <div style="font-size:10px;color:var(--muted2)">${_repEsc(p.note || 'Abono')}</div>
      </td>
      <td><span class="badge g">${_repEsc(p.method || 'efectivo')}</span></td>
      <td><span class="badge ${p.imported ? 'a' : 'b'}">${source}</span></td>
      <td style="text-align:right;font-weight:800;color:var(--green)">${fmt(p.amount || 0)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--muted2);padding:18px">Sin abonos en este período</td></tr>`;

  tableCard.appendChild(h('div', { class: 'tw', style: { maxHeight: '420px', overflow: 'auto' },
    html: `<table>
      <thead><tr>
        <th>Fecha</th><th>Cliente</th><th>Factura / Nota</th><th>Método</th><th>Origen</th><th style="text-align:right">Monto</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`
  }));
  el.appendChild(tableCard);
}

function exportAbonosPDF() {
  if (!repData) { toast('Carga los datos primero', 'w'); return; }
  const d = repData;
  const summary = d.summary || {};
  const rangeLabel = {
    today: 'Hoy',
    week: 'Esta semana',
    month: 'Este mes',
    all: 'Histórico',
    custom: `${repDateFrom ? fdate(repDateFrom) : ''} — ${repDateTo ? fdate(repDateTo) : ''}`,
  }[repRange] || repRange;

  const rows = (d.rows || []).slice(0, 1000).map(p => {
    const fecha = (p.created_at || '').split('T')[0].split(' ')[0];
    return `<tr>
      <td>${fdate(fecha)}</td>
      <td>${_repEsc(p.customer_name || 'Cliente eliminado')}</td>
      <td>${p.sale_id ? '#' + String(p.sale_id).padStart(5, '0') : 'Sin factura'}</td>
      <td>${_repEsc(p.method || 'efectivo')}</td>
      <td>${p.imported ? 'Histórico' : 'POS'}</td>
      <td style="text-align:right;font-weight:700">${fmt(p.amount || 0)}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Reporte de abonos — ${_repEsc(CFG.biz)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:20px}
  h2{margin-bottom:2px;font-size:16px}
  .sub{color:#666;margin-bottom:14px;font-size:11px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .met{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px}
  .met-l{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;margin-bottom:4px}
  .met-v{font-size:16px;font-weight:800}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
  td{padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top}
  .no-print{margin-bottom:14px;text-align:right}
  @media print{.no-print{display:none}}
</style>
</head><body>
  <div class="no-print">
    <button onclick="window.print()" style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:700">
      Imprimir / Guardar PDF
    </button>
  </div>
  <h2>Reporte de Abonos CxC — ${_repEsc(CFG.biz)}</h2>
  <div class="sub">Período: <strong>${rangeLabel}</strong> · Generado: ${fdate(today())} a las ${nowt()}</div>
  <div class="metrics">
    <div class="met"><div class="met-l">Total abonado</div><div class="met-v">${fmt(summary.total || 0)}</div></div>
    <div class="met"><div class="met-l">Registros</div><div class="met-v">${summary.count || 0}</div></div>
    <div class="met"><div class="met-l">Histórico</div><div class="met-v">${fmt(summary.importedTotal || 0)}</div></div>
    <div class="met"><div class="met-l">POS</div><div class="met-v">${fmt(summary.currentTotal || 0)}</div></div>
  </div>
  <table>
    <thead><tr><th>Fecha</th><th>Cliente</th><th>Factura</th><th>Método</th><th>Origen</th><th style="text-align:right">Monto</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:18px">Sin abonos</td></tr>`}</tbody>
  </table>
</body></html>`;

  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
}

// ══════════════════════════════════════════════
// EXPORTAR PDF REPORTE COMPLETO
// ══════════════════════════════════════════════
function exportReportePDF() {
  if (!repData) { toast('Carga los datos primero', 'w'); return; }
  if (repTab === 'abonos') {
    exportAbonosPDF();
    return;
  }

  const d = repData;
  const rangeLabel = {
    today: 'Hoy', week: 'Esta semana', month: 'Este mes',
    all: 'Histórico',
    custom: `${repDateFrom ? fdate(repDateFrom) : ''} — ${repDateTo ? fdate(repDateTo) : ''}`
  }[repRange] || repRange;

  const payRows = (d.byMethod || []).map(m => `
    <tr>
      <td style="text-transform:capitalize">${m.payment_method || 'efectivo'}</td>
      <td style="text-align:center">${m.count}</td>
      <td style="text-align:right">${fmt(m.total)}</td>
      <td style="text-align:right">${d.totalRev > 0 ? Math.round((m.total/d.totalRev)*100) : 0}%</td>
    </tr>`).join('');

  const prodRows = (d.topProducts || []).map((p, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${_esc(p.product_name)}</td>
      <td style="text-align:center">${p.total_qty}</td>
      <td style="text-align:right">${fmt(p.total_rev)}</td>
      <td style="text-align:right">${fmt(p.total_cost)}</td>
      <td style="text-align:right;color:#16a34a;font-weight:700">${fmt(p.total_profit)}</td>
      <td style="text-align:right">${p.total_rev > 0 ? ((p.total_profit/p.total_rev)*100).toFixed(0) : 0}%</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Reporte — ${_esc(CFG.biz)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:20px}
  h2{margin-bottom:2px;font-size:16px}
  h3{margin:16px 0 8px;font-size:12px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280}
  .sub{color:#666;margin-bottom:14px;font-size:11px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .met{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px}
  .met-l{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;margin-bottom:4px}
  .met-v{font-size:16px;font-weight:800}
  .met-s{font-size:10px;color:#9ca3af;margin-top:2px}
  .highlight{background:#f0fdf4;border-color:#bbf7d0}
  .warn{background:#fef2f2;border-color:#fecaca}
  table{width:100%;border-collapse:collapse;margin-bottom:10px}
  th{background:#f3f4f6;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
  td{padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:middle}
  .total-row{font-weight:700;background:#f9fafb}
  .foot{margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af}
  .no-print{margin-bottom:14px;text-align:right}
  @media print{.no-print{display:none}}
</style>
</head><body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;
             border-radius:6px;font-size:12px;cursor:pointer;font-weight:700">
      Imprimir / Guardar PDF
    </button>
  </div>

  <h2>Reporte Financiero — ${_esc(CFG.biz)}</h2>
  <div class="sub">
    Período: <strong>${rangeLabel}</strong> ·
    Generado: ${fdate(today())} a las ${nowt()} ·
    RNC: ${_esc(CFG.rnc)}
  </div>

  <div class="metrics">
    <div class="met highlight">
      <div class="met-l">Ingresos Totales</div>
      <div class="met-v" style="color:#16a34a">${fmt(d.totalRev)}</div>
      <div class="met-s">${d.totalSales} facturas · ${d.totalUnits} unidades</div>
    </div>
    <div class="met">
      <div class="met-l">Costo de Ventas</div>
      <div class="met-v" style="color:#dc2626">${fmt(d.totalCost)}</div>
      <div class="met-s">Costo histórico</div>
    </div>
    <div class="met highlight">
      <div class="met-l">Utilidad Bruta</div>
      <div class="met-v" style="color:#16a34a">${fmt(d.grossProfit)}</div>
      <div class="met-s">Margen: ${d.margin.toFixed(1)}%</div>
    </div>
    <div class="met">
      <div class="met-l">ITBIS (${CFG?.itbis ?? 18}%)</div>
      <div class="met-v">${fmt(d.totalTax)}</div>
      <div class="met-s">Descuentos: ${fmt(d.totalDisc)}</div>
    </div>
  </div>

  <h3>Por Método de Pago</h3>
  <table>
    <thead><tr>
      <th>Método</th><th style="text-align:center">Facturas</th>
      <th style="text-align:right">Total</th><th style="text-align:right">%</th>
    </tr></thead>
    <tbody>
      ${payRows}
      <tr class="total-row">
        <td>TOTAL</td>
        <td style="text-align:center">${d.totalSales}</td>
        <td style="text-align:right">${fmt(d.totalRev)}</td>
        <td style="text-align:right">100%</td>
      </tr>
    </tbody>
  </table>

  <h3>Productos Más Vendidos</h3>
  <table>
    <thead><tr>
      <th>#</th><th>Producto</th>
      <th style="text-align:center">Unidades</th>
      <th style="text-align:right">Ingresos</th>
      <th style="text-align:right">Costo</th>
      <th style="text-align:right">Ganancia</th>
      <th style="text-align:right">Margen</th>
    </tr></thead>
    <tbody>${prodRows || '<tr><td colspan="7" style="text-align:center;color:#9ca3af">Sin datos</td></tr>'}</tbody>
  </table>

  <div class="foot">
    ${_esc(CFG.biz)} · RNC: ${_esc(CFG.rnc)} · Tel: ${_esc(CFG.phone)} · ${_esc(CFG.addr)}
  </div>
</body></html>`;

  printHTML(html);
}

// ── Exportar PDF créditos ─────────────────────
function exportReporteCreditoPDF() {
  const clients  = DB.customers.filter(c => c.balance > 0 && c.id !== 1)
    .sort((a, b) => b.balance - a.balance);
  const total    = clients.reduce((a, c) => a + (c.balance || 0), 0);
  const alerts   = getCreditAlerts();
  const alertMap = {};
  alerts.forEach(a => { alertMap[a.client.id] = a; });

  const rows = clients.map(c => {
    const alert  = alertMap[c.id];
    const estado = alert?.status === 'overdue' ? '⚠ VENCIDO' :
                   alert?.status === 'soon'    ? '↗ Por vencer' : '✓ Activo';
    const color  = alert?.status === 'overdue' ? '#dc2626' :
                   alert?.status === 'soon'    ? '#d97706' : '#16a34a';
    return `
      <tr>
        <td><strong>${_esc(c.name)}</strong></td>
        <td>${_esc(c.rnc)||'—'}</td>
        <td>${_esc(c.phone)||'—'}</td>
        <td style="text-align:right;font-weight:700;color:#dc2626">${fmt(c.balance)}</td>
        <td style="text-align:right">${fmt(c.credit_limit || 0)}</td>
        <td>${c.credit_due ? fdate(c.credit_due) : '—'}</td>
        <td style="color:${color};font-weight:600">${estado}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Créditos — ${_esc(CFG.biz)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;padding:20px}
  h2{margin-bottom:2px}
  .sub{color:#666;margin-bottom:14px;font-size:11px}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase}
  td{padding:7px 8px;border-bottom:1px solid #f3f4f6}
  .total{font-weight:700;font-size:13px;margin-top:10px;text-align:right;
         padding:8px;background:#fef2f2;border-radius:4px;color:#dc2626}
  .foot{margin-top:14px;font-size:10px;color:#9ca3af}
  .no-print{margin-bottom:12px;text-align:right}
  @media print{.no-print{display:none}}
</style></head><body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;
             border-radius:6px;font-size:12px;cursor:pointer;font-weight:700">
      Imprimir / PDF
    </button>
  </div>
  <h2>Cuentas por Cobrar — ${_esc(CFG.biz)}</h2>
  <div class="sub">${clients.length} clientes con deuda · ${fdate(today())}</div>
  <table>
    <thead><tr>
      <th>Cliente</th><th>RNC</th><th>Teléfono</th>
      <th style="text-align:right">Balance</th>
      <th style="text-align:right">Límite</th>
      <th>Vencimiento</th><th>Estado</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:14px">Sin deudas pendientes</td></tr>'}</tbody>
  </table>
  <div class="total">Total por cobrar: ${fmt(total)}</div>
  <div class="foot">${_esc(CFG.biz)} · ${_esc(CFG.phone)} · ${_esc(CFG.addr)}</div>
</body></html>`;

  printHTML(html);
}

// ══════════════════════════════════════════════
// REPORTE DE INVENTARIO VALORIZADO
// ══════════════════════════════════════════════
async function _renderReporteInventario(el) {
  const prods    = DB.products.filter(p => p.active !== 0);
  const total    = prods.reduce((a, p) => a + ((p.stock||0) * (p.cost||0)), 0);
  const units    = prods.reduce((a, p) => a + (p.stock||0), 0);
  const lowStock = prods.filter(p => (p.stock||0) <= (p.stock_min||5));
  const noPrice  = prods.filter(p => !p.cost || p.cost === 0);

  // ── Métricas resumen ─────────────────────────
  const metWrap = h('div', { class: 'metrics' });
  [
    { icon: 'dollar', color: 'g', label: 'Valor total inventario',
      val: fmt(total), badge: 'Al costo promedio' },
    { icon: 'box',    color: 'b', label: 'Unidades en stock',
      val: units.toLocaleString('es-DO'), badge: `${prods.length} productos activos` },
    { icon: 'alert',  color: 'r', label: 'Bajo stock mínimo',
      val: lowStock.length.toString(), badge: 'Requieren reorden',
      badgeType: lowStock.length > 0 ? 'dn' : 'nu' },
    { icon: 'xmark',  color: 'a', label: 'Sin costo definido',
      val: noPrice.length.toString(), badge: 'No incluidos en valor',
      badgeType: noPrice.length > 0 ? 'dn' : 'nu' },
  ].forEach(m => {
    metWrap.appendChild(h('div', { class: 'metric' },
      h('div', { class: 'met-top' },
        h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
      ),
      h('div', { class: 'met-label' }, m.label),
      h('div', { class: 'met-val' }, m.val),
      h('div', { class: 'met-foot' },
        h('span', { class: `met-badge ${m.badgeType||'nu'}` }, m.badge)
      )
    ));
  });
  el.appendChild(metWrap);

  // ── Tabla de inventario ──────────────────────
  const card = h('div', { class: 'card', style: 'margin-top:16px' });

  // Filtros
  const filterRow = h('div', { class: 'fxb mb8', style: 'flex-wrap:wrap;gap:8px' });
  let invFilter = 'todos';
  const filterBtns = h('div', { class: 'flex', style: 'gap:6px;flex-wrap:wrap' });
  [
    { v: 'todos',   l: 'Todos' },
    { v: 'bajo',    l: `⚠ Bajo stock (${lowStock.length})` },
    { v: 'sinCosto',l: `Sin costo (${noPrice.length})` },
  ].forEach(f => {
    filterBtns.appendChild(h('button', {
      class: `btn btn-sm ${invFilter===f.v?'btn-dark':'btn-out'}`,
      id: `inv-filter-${f.v}`,
      html: f.l,
      onclick: () => {
        invFilter = f.v;
        filterBtns.querySelectorAll('button').forEach(b => b.classList.replace('btn-dark','btn-out'));
        document.getElementById(`inv-filter-${f.v}`)?.classList.replace('btn-out','btn-dark');
        renderTable(f.v);
      }
    }));
  });

  filterRow.appendChild(filterBtns);
  filterRow.appendChild(h('button', {
    class: 'btn btn-out btn-sm',
    html: `${svg('pdf')} Exportar PDF`,
    onclick: () => exportInventarioValorizadoPDF(prods)
  }));
  card.appendChild(filterRow);

  const tableWrap = h('div', { id: 'inv-table-wrap' });
  card.appendChild(tableWrap);
  el.appendChild(card);

  function renderTable(filter) {
    let rows = [...prods].sort((a,b) =>
      ((b.stock||0)*(b.cost||0)) - ((a.stock||0)*(a.cost||0)));

    if (filter === 'bajo')     rows = rows.filter(p => (p.stock||0) <= (p.stock_min||5));
    if (filter === 'sinCosto') rows = rows.filter(p => !p.cost || p.cost === 0);

    const tw = document.getElementById('inv-table-wrap');
    if (!tw) return;
    tw.innerHTML = '';

    if (!rows.length) {
      tw.appendChild(h('div', { style: 'color:var(--muted2);font-size:13px;padding:16px 0;text-align:center' },
        'No hay productos que coincidan con el filtro'));
      return;
    }

    // Tabla scrollable
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';
    tbl.innerHTML = `
      <thead>
        <tr style="border-bottom:2px solid var(--line);color:var(--muted);font-weight:600;text-align:left">
          <th style="padding:8px 6px">Código</th>
          <th style="padding:8px 6px">Producto</th>
          <th style="padding:8px 6px">Categoría</th>
          <th style="padding:8px 6px;text-align:right">Costo unit.</th>
          <th style="padding:8px 6px;text-align:right">Stock</th>
          <th style="padding:8px 6px;text-align:right">Mín.</th>
          <th style="padding:8px 6px;text-align:right;color:var(--green)">Valor total</th>
          <th style="padding:8px 6px;text-align:center">Estado</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(p => {
          const val    = (p.stock||0) * (p.cost||0);
          const isBajo = (p.stock||0) <= (p.stock_min||5);
          const isZero = (p.stock||0) === 0;
          return `
            <tr style="border-bottom:1px solid var(--line2);${isBajo?'background:var(--amber-bg)':''}"
                onmouseover="this.style.background='var(--surface2)'"
                onmouseout="this.style.background='${isBajo?'var(--amber-bg)':''}'">
              <td style="padding:8px 6px;font-family:var(--mono);color:var(--muted)">${p.code||'—'}</td>
              <td style="padding:8px 6px;font-weight:500">${p.name}</td>
              <td style="padding:8px 6px;color:var(--muted)">${p.category||'—'}</td>
              <td style="padding:8px 6px;text-align:right">${fmt(p.cost||0)}</td>
              <td style="padding:8px 6px;text-align:right;font-weight:700;color:${isZero?'var(--red)':isBajo?'var(--amber)':'var(--ink)'}">${p.stock||0}</td>
              <td style="padding:8px 6px;text-align:right;color:var(--muted)">${p.stock_min||5}</td>
              <td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--green)">${fmt(val)}</td>
              <td style="padding:8px 6px;text-align:center">
                ${isZero ? '<span class="badge r">Sin stock</span>' :
                  isBajo ? '<span class="badge a">Bajo</span>' :
                  '<span class="badge g">OK</span>'}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid var(--line);font-weight:700;background:var(--surface2)">
          <td colspan="4" style="padding:10px 6px;text-align:right;color:var(--muted)">
            TOTAL (${rows.length} productos)
          </td>
          <td style="padding:10px 6px;text-align:right">${rows.reduce((a,p)=>a+(p.stock||0),0)}</td>
          <td></td>
          <td style="padding:10px 6px;text-align:right;color:var(--green);font-size:14px">
            ${fmt(rows.reduce((a,p)=>a+((p.stock||0)*(p.cost||0)),0))}
          </td>
          <td></td>
        </tr>
      </tfoot>`;
    tw.appendChild(tbl);
  }

  renderTable('todos');
}

// ── Exportar inventario a PDF ─────────────────
function exportInventarioValorizadoPDF(prods) {
  const today_ = today();
  const total   = prods.reduce((a,p) => a + ((p.stock||0)*(p.cost||0)), 0);
  const sorted  = [...prods].sort((a,b) =>
    ((b.stock||0)*(b.cost||0)) - ((a.stock||0)*(a.cost||0)));

  const html = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;color:#111;margin:20px}
      h1{font-size:16px;margin-bottom:2px}
      .sub{color:#888;font-size:11px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse}
      th{background:#111;color:#fff;padding:7px 8px;text-align:left;font-size:10px;text-transform:uppercase}
      td{padding:6px 8px;border-bottom:1px solid #eee}
      tr:nth-child(even){background:#f9f9f9}
      .r{text-align:right}
      .total{font-weight:700;background:#f0f0f0!important;border-top:2px solid #111}
      .badge-bajo{color:#b45309;font-weight:700}
      .badge-ok{color:#16a34a}
    </style>
  </head><body>
    <h1>${_esc(CFG.biz)} — Inventario Valorizado</h1>
    <div class="sub">Generado: ${fdate(today_)} · Total: ${fmt(total)} · ${sorted.length} productos</div>
    <table>
      <thead><tr>
        <th>Código</th><th>Producto</th><th>Categoría</th>
        <th class="r">Costo</th><th class="r">Stock</th><th class="r">Valor</th><th class="r">Estado</th>
      </tr></thead>
      <tbody>
        ${sorted.map(p => `
          <tr>
            <td>${_esc(p.code)||'—'}</td>
            <td>${_esc(p.name)}</td>
            <td>${_esc(p.category)||'—'}</td>
            <td class="r">$${(p.cost||0).toFixed(2)}</td>
            <td class="r">${p.stock||0}</td>
            <td class="r">$${((p.stock||0)*(p.cost||0)).toFixed(2)}</td>
            <td class="r ${(p.stock||0)<=(p.stock_min||5)?'badge-bajo':'badge-ok'}">
              ${(p.stock||0)===0?'SIN STOCK':(p.stock||0)<=(p.stock_min||5)?'BAJO':'OK'}
            </td>
          </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr class="total">
          <td colspan="4">TOTAL (${sorted.length} productos)</td>
          <td class="r">${sorted.reduce((a,p)=>a+(p.stock||0),0)}</td>
          <td class="r">$${total.toFixed(2)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  </body></html>`;

  printHTML(html);
}
