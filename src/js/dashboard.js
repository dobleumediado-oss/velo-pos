// ══════════════════════════════════════════════
// dashboard.js — Dashboard principal
//               Usa campos SQLite correctamente
// ══════════════════════════════════════════════

async function renderDash(el) {
  el.innerHTML = '';

  // ── Auto-refresh cada 60 segundos ──────────────────────────────────────────
  // Limpiar intervalo anterior si existe (evitar múltiples timers)
  if (window._dashRefreshInterval) {
    clearInterval(window._dashRefreshInterval);
    window._dashRefreshInterval = null;
  }
  // Solo activar si el dashboard está visible
  window._dashRefreshInterval = setInterval(async () => {
    const mainEl = document.getElementById('main-content');
    if (mainEl && page === 'dash') {
      await renderDash(mainEl);
    } else {
      clearInterval(window._dashRefreshInterval);
      window._dashRefreshInterval = null;
    }
  }, 60000);

  // Recargar datos frescos
  const [,,,versionInfo] = await Promise.all([
    reloadProducts(),
    reloadCustomers(),
    reloadSales({ range: 'today' }),
    window.api.version.getInfo().then(r => r?.data || null).catch(() => null),
  ]);

  // ── Datos de Gastos (si módulo activo) ──────────────────────────────────────
  let gastosData = null;
  if (CFG.module_gastos === '1' && window.api?.expenses) {
    try {
      const month = today().slice(0,7);
      const [sumRes, payRes] = await Promise.all([
        window.api.expenses.getSummary({ month }),
        window.api.expenses.getPayable({ requestUserId: user?.id }),
      ]);
      gastosData = {
        summary:  sumRes?.ok  ? sumRes.data  : null,
        payable:  payRes?.ok  ? payRes.data  : [],
      };
    } catch(e) { console.warn('[Dash] gastos:', e.message); }
  }

  // ── Envíos como gasto (si módulo activo, independiente de module_gastos) ────
  let enviosGasto = 0;
  let enviosCount = 0;
  if (CFG.module_envios === '1' && window.api?.deliveries) {
    try {
      const eRes = await window.api.deliveries.getSummary();
      if (eRes?.ok && eRes.data) {
        // Solo envíos completados del mes actual
        enviosGasto = eRes.data.total_fee_month  || eRes.data.totalFeeMonth  || 0;
        enviosCount = eRes.data.total_count_month || eRes.data.totalMonth    || 0;
      }
    } catch(e) { console.warn('[Dash] envíos gasto:', e.message); }
  }

  // Si hay envíos pero no hay módulo de gastos, crear gastosData virtual
  if (enviosGasto > 0 && !gastosData) {
    gastosData = {
      summary: { total_pagado: enviosGasto, total_pendiente: 0, count: enviosCount },
      payable: [],
      soloEnvios: true,
    };
  } else if (enviosGasto > 0 && gastosData?.summary) {
    // Sumar envíos a los gastos existentes
    gastosData.summary.total_pagado = (gastosData.summary.total_pagado || 0) + enviosGasto;
    gastosData.summary.count        = (gastosData.summary.count        || 0) + enviosCount;
    gastosData._enviosGasto = enviosGasto;
    gastosData._enviosCount = enviosCount;
  }

  // ── Datos NCF (si fiscal activo) ────────────────────────────────────────────
  let ncfData = null;
  if (CFG.fiscalEnabled && window.api?.ncf) {
    try {
      const [seqRes, alertRes] = await Promise.all([
        window.api.ncf.getSequences(),
        window.api.ncf.getAlerts(),
      ]);
      ncfData = {
        sequences: seqRes?.ok  ? seqRes.data  : [],
        alerts:    alertRes?.ok ? alertRes.data : [],
      };
    } catch(e) { console.warn('[Dash] ncf:', e.message); }
  }

  const sales  = DB.sales.filter(s =>
    s.status !== 'cancelled' && s.type !== 'devolucion');
  const rev    = sales.reduce((a, s) => a + (s.total || 0), 0);
  const itbis  = sales.reduce((a, s) => a + (s.tax_amt || s.itbis || 0), 0);

  // Calcular ganancia bruta del día (precio - costo desde sale_items en memoria)
  const todaySalesIds = new Set(sales.map(s => s.id));
  const cost = DB.sales
    .filter(s => todaySalesIds.has(s.id))
    .reduce((a, s) => a + (s.cost_total || 0), 0);
  const profit    = rev - itbis - cost;
  const margin    = rev > 0 ? ((profit / rev) * 100).toFixed(0) : 0;

  // Ventas del mes
  const today_ = today();
  const monthPfx = today_.slice(0, 7);
  const allSales = await window.api.sales.getAll({ range: 'month' });
  const mSales = (allSales || []).filter(s =>
    s.status !== 'cancelled' && s.type !== 'devolucion');
  const mRev   = mSales.reduce((a, s) => a + (s.total || 0), 0);

  // Filtrar stock bajo y deduplicar por nombre para evitar mostrar duplicados de importaciones
  const _lowStockRaw = DB.products.filter(p => p.stock <= (p.stock_min || 5));
  const _lowStockSeen = new Set();
  const lowStock = _lowStockRaw.filter(p => {
    const key = p.name?.trim().toLowerCase();
    if (_lowStockSeen.has(key)) return false;
    _lowStockSeen.add(key);
    return true;
  });
  const creditAlerts = getCreditAlerts();
  const pendCredit = DB.customers.reduce((a, c) =>
    a + (c.id !== 1 ? (c.balance || 0) : 0), 0);
  const totalClients = DB.customers.filter(c => c.id !== 1 && c.active !== 0).length;

  // ── Header ──────────────────────────────────
  const nowStr = new Date().toLocaleTimeString('es-DO', { hour:'2-digit', minute:'2-digit' });
  const greeting = new Date().getHours() < 12 ? 'Buenos días' :
                   new Date().getHours() < 19 ? 'Buenas tardes' : 'Buenas noches';

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' },
        `${greeting}, ${user?.name?.split(' ')[0]} 👋`),
      h('div', { class: 'sec-sub', style: { display:'flex', alignItems:'center', gap:'10px' } },
        h('span', null, `${fdate(today_)} · ${cajaOpen ? '🟢 Caja abierta' : '🔴 Caja cerrada'}`),
        h('span', {
          style: 'font-size:10px;background:rgba(0,192,122,.12);color:var(--green,#00c07a);' +
                 'padding:2px 8px;border-radius:100px;font-weight:600'
        }, `● EN VIVO · ${nowStr}`)
      )
    ),
    h('div', { style: 'display:flex;gap:6px' },
      h('button', {
        class: 'btn btn-out btn-sm',
        title: 'Actualizar ahora',
        onclick: async () => {
          const mainEl = document.getElementById('main-content');
          if (mainEl) await renderDash(mainEl);
        },
        html: `↻ Actualizar`
      }),
      h('button', {
        class: 'btn btn-out btn-sm',
        onclick: () => routeTo('reportes'),
        html: `${svg('chart')} Reportes`
      })
    )
  ));

  // ── Alertas de crédito ───────────────────────
  if (creditAlerts.length) {
    const alertBox = h('div', { class: 'card mb20',
      style: { borderColor: 'var(--red-line)', background: 'var(--red-bg)' } });

    alertBox.appendChild(h('div', { class: 'fxb mb8' },
      h('div', { class: 'flex' },
        h('div', { style: { color: 'var(--red)', marginRight: '6px' },
          html: svg('alert') }),
        h('span', { style: { fontWeight: 700, fontSize: '14px', color: 'var(--red)' } },
          `${creditAlerts.length} alerta${creditAlerts.length > 1 ? 's' : ''} de crédito`)
      ),
      h('div', { class: 'flex', style: { gap: '6px' } },
        h('button', {
          class: 'btn btn-sm',
          style: { background: 'var(--red)', color: '#fff' },
          onclick: () => routeTo('clientes'),
          html: `${svg('users')} Ver clientes`
        }),
        h('button', {
          class: 'btn btn-out btn-sm',
          onclick: () => exportCreditAlertsPDF(creditAlerts),
          html: `${svg('pdf')} PDF`
        })
      )
    ));

    creditAlerts.forEach(a => {
      const { client: c, daysLeft, status } = a;
      const isOverdue = status === 'overdue';
      const creditDue = c.credit_due || c.creditDueDate || null;
      const label = isOverdue
        ? `Vencido hace ${Math.abs(daysLeft)} día${Math.abs(daysLeft) !== 1 ? 's' : ''}`
        : `Vence en ${daysLeft} día${daysLeft !== 1 ? 's' : ''}`;

      alertBox.appendChild(h('div', {
        class: `alrt ${isOverdue ? 'r' : 'a'}`,
        style: { marginBottom: '5px' }
      },
        h('div', { class: `alrt-dot ${isOverdue ? 'r' : 'a'}` }),
        h('div', { style: { flex: 1 } },
          h('div', { class: 'alrt-title' }, c.name),
          h('div', { class: 'alrt-sub' },
            `${fmt(c.balance)} pendiente · ${label}` +
            (creditDue ? ` · Límite: ${fdate(creditDue)}` : '')
          )
        ),
        h('div', { class: 'flex', style: { gap: '5px' } },
          h('button', {
            class: 'btn btn-sm btn-out',
            onclick: () => routeTo('clientes'),
            html: `${svg('dollar')} Abonar`
          }),
          h('button', {
            class: 'btn btn-sm btn-out',
            onclick: () => exportClientCreditPDF(c),
            html: svg('pdf')
          })
        )
      ));
    });
    el.appendChild(alertBox);
  }

  // ── Selector de período ──────────────────────
  const dashPeriod = window._dashPeriod || 'today';
  const periodBar  = h('div', { class: 'flex', style: { gap: '6px', marginBottom: '14px' } });
  [
    { v: 'today', l: 'Hoy' },
    { v: '3days', l: '3 días' },
    { v: 'week',  l: '7 días' },
    { v: 'month', l: 'Este mes' },
  ].forEach(p => {
    periodBar.appendChild(h('button', {
      class: `btn btn-sm ${dashPeriod === p.v ? 'btn-dark' : 'btn-out'}`,
      onclick: async () => { window._dashPeriod = p.v; await renderDash(el); }
    }, p.l));
  });
  el.appendChild(periodBar);

  // Calcular métricas del período — filtrando desde allSales ya cargado (sin llamadas extra)
  let periodSales = sales;
  if (dashPeriod === '3days') {
    const cutoff = new Date(Date.now() - 3*24*60*60*1000).toISOString().split('T')[0];
    periodSales  = (allSales||[]).filter(s => s.status !== 'cancelled' && s.type !== 'devolucion'
      && (s.created_at||'').slice(0,10) >= cutoff);
  } else if (dashPeriod === 'week') {
    const cutoff7 = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    periodSales   = (allSales||[]).filter(s => s.status !== 'cancelled' && s.type !== 'devolucion'
      && (s.created_at||'').slice(0,10) >= cutoff7);
  } else if (dashPeriod === 'month') {
    periodSales = mSales;
  }

  const periodRev    = periodSales.reduce((a,s) => a + (s.total||0), 0);
  const periodITBIS  = periodSales.reduce((a,s) => a + (s.tax_amt||0), 0);
  const periodCost   = periodSales.reduce((a,s) => a + (s.cost_total||0), 0);
  const periodProfit = periodRev - periodITBIS - periodCost;
  const periodMargin = periodRev > 0 ? ((periodProfit/periodRev)*100).toFixed(1) : 0;
  const periodLabel  = { today:'Hoy', '3days':'3 días', week:'7 días', month:'Mes' }[dashPeriod];

  // ── Métricas ─────────────────────────────────
  const metWrap = h('div', { class: 'metrics' });
  [
    { icon: 'dollar', color: 'g', label: `Ventas (${periodLabel})`,
      val: fmt(periodRev), badge: `${periodSales.length} transac.`, badgeType: 'nu' },
    { icon: 'trend',  color: 'g', label: `Ganancia (${periodLabel})`,
      val: fmt(periodProfit > 0 ? periodProfit : 0),
      badge: `${periodMargin}% margen`,
      badgeType: periodProfit > 0 ? 'nu' : 'dn' },
    { icon: 'chart',  color: 'p', label: 'Ventas del Mes',
      val: fmt(mRev), badge: `${mSales.length} ventas`, badgeType: 'nu' },
    { icon: 'card',   color: 'a', label: 'Créditos Pendientes',
      val: fmt(pendCredit), badge: `${totalClients} clientes`,
      badgeType: pendCredit > 0 ? 'dn' : 'nu',
      click: () => routeTo('clientes') },
  ].forEach(m => {
    const card = h('div', {
      class: 'metric',
      style: m.click ? { cursor: 'pointer' } : {},
      ...(m.click ? { onclick: m.click } : {})
    },
      h('div', { class: 'met-top' },
        h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
      ),
      h('div', { class: 'met-label' }, m.label),
      h('div', { class: 'met-val' }, m.val),
      h('div', { class: 'met-foot' },
        h('span', { class: `met-badge ${m.badgeType}` }, m.badge)
      )
    );
    metWrap.appendChild(card);
  });
  el.appendChild(metWrap);

  // ── Cards de Gastos (si módulo activo) ───────────────────────────────────────
  if (gastosData?.summary) {
    const gs = gastosData.summary;
    const gastosTotal   = gs.total_pagado    || 0;
    const gastosPend    = gs.total_pendiente || 0;
    const gastosCount   = gs.count           || 0;
    const gastosOverdue = (gastosData.payable || []).filter(g => {
      const due = g.due_date || g.fecha_vencimiento;
      return due && due < today();
    }).length;

    const gasMetWrap = h('div', { class: 'metrics', style: { marginTop: '0' } });
    [
      { icon: 'dollar', color: 'r',
        label: `Gastos (${periodLabel})`,
        val: fmt(gastosTotal),
        badge: `${gastosCount} registros`,
        badgeType: 'nu',
        click: () => routeTo('gastos') },
      { icon: 'cash', color: gastosOverdue > 0 ? 'r' : 'a',
        label: 'Por Pagar',
        val: fmt(gastosPend),
        badge: gastosOverdue > 0 ? `${gastosOverdue} vencidos` : 'Al día',
        badgeType: gastosOverdue > 0 ? 'dn' : 'nu',
        click: () => routeTo('gastos') },
      // Card de envíos como gasto si módulo activo y hay envíos
      ...(gastosData._enviosGasto > 0 ? [{
        icon: 'truck', color: 'a',
        label: 'Gastos de Envíos (mes)',
        val: fmt(gastosData._enviosGasto),
        badge: `${gastosData._enviosCount} envíos completados`,
        badgeType: 'nu',
        click: () => routeTo('envios'),
      }] : []),
    ].forEach(m => {
      const card = h('div', {
        class: 'metric',
        style: { cursor: 'pointer', borderTop: '3px solid var(--red,#ef4444)' },
        onclick: m.click
      },
        h('div', { class: 'met-top' },
          h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) }),
          h('span', { style: 'font-size:10px;color:var(--muted2);margin-left:auto' }, 'Gastos')
        ),
        h('div', { class: 'met-label' }, m.label),
        h('div', { class: 'met-val' }, m.val),
        h('div', { class: 'met-foot' },
          h('span', { class: `met-badge ${m.badgeType}` }, m.badge)
        )
      );
      gasMetWrap.appendChild(card);
    });
    el.appendChild(gasMetWrap);
  }

  // ── Cards de NCF (si fiscal activo) ──────────────────────────────────────────
  if (ncfData) {
    const seqs     = ncfData.sequences || [];
    const alerts   = ncfData.alerts    || [];
    const activeSeq = seqs.filter(s => s.active).length;
    const ncfITBIS = periodSales.reduce((a,s) => a + (s.tax_amt||s.itbis||0), 0);
    const ncfFacturas = periodSales.filter(s => s.type === 'factura').length;

    const ncfMetWrap = h('div', { class: 'metrics', style: { marginTop: '0' } });
    [
      { icon: 'chart', color: 'p',
        label: `ITBIS Generado (${periodLabel})`,
        val: fmt(ncfITBIS),
        badge: `${ncfFacturas} facturas fiscales`,
        badgeType: 'nu' },
      { icon: 'list', color: alerts.length > 0 ? 'r' : 'g',
        label: 'Secuencias NCF',
        val: `${activeSeq} activa${activeSeq !== 1 ? 's' : ''}`,
        badge: alerts.length > 0 ? `${alerts.length} alerta${alerts.length > 1 ? 's' : ''}` : 'Sin alertas',
        badgeType: alerts.length > 0 ? 'dn' : 'nu',
        click: () => routeTo('configuracion') },
    ].forEach(m => {
      const card = h('div', {
        class: 'metric',
        style: { cursor: m.click ? 'pointer' : 'default',
                 borderTop: '3px solid var(--purple,#8b5cf6)' },
        ...(m.click ? { onclick: m.click } : {})
      },
        h('div', { class: 'met-top' },
          h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) }),
          h('span', { style: 'font-size:10px;color:var(--muted2);margin-left:auto' }, 'NCF · DGII')
        ),
        h('div', { class: 'met-label' }, m.label),
        h('div', { class: 'met-val' }, m.val),
        h('div', { class: 'met-foot' },
          h('span', { class: `met-badge ${m.badgeType}` }, m.badge)
        )
      );
      ncfMetWrap.appendChild(card);
    });
    el.appendChild(ncfMetWrap);

    // Alertas NCF si las hay
    if (alerts.length > 0) {
      const ncfAlertBox = h('div', { class: 'card mb20',
        style: { borderColor: 'var(--purple,#8b5cf6)', background: 'rgba(139,92,246,.05)' } });
      ncfAlertBox.appendChild(h('div', { class: 'fxb mb8' },
        h('span', { style: 'font-weight:700;font-size:13px;color:var(--purple,#8b5cf6)' },
          `⚠ ${alerts.length} alerta${alerts.length > 1 ? 's' : ''} NCF`),
        h('button', {
          class: 'btn btn-sm',
          style: 'background:var(--purple,#8b5cf6);color:#fff',
          onclick: () => routeTo('configuracion')
        }, 'Gestionar NCF')
      ));
      alerts.slice(0,3).forEach(a => {
        ncfAlertBox.appendChild(h('div', { class: 'alrt a', style: { marginBottom: '4px' } },
          h('div', { class: 'alrt-dot a' }),
          h('div', null,
            h('div', { class: 'alrt-title' }, a.message || `Secuencia ${a.type}: quedan ${a.remaining} NCF`),
            h('div', { class: 'alrt-sub' }, `Desde: ${a.from_num || ''} — Hasta: ${a.to_num || ''}`)
          )
        ));
      });
      el.appendChild(ncfAlertBox);
    }
  }

  // ── Grid principal ────────────────────────────
  const grid = h('div', { class: 'gg2', style: { alignItems: 'start' } });

  // ── Gráfica 7 días — usar allSales ya cargado ─
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d  = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().split('T')[0];
    const daySales = (allSales || []).filter(s => {
      const sd = (s.created_at || '').split('T')[0].split(' ')[0];
      return sd === ds && s.status !== 'cancelled' && s.type !== 'devolucion';
    });
    days7.push({
      date:  ds,
      label: d.toLocaleDateString('es-DO', { weekday: 'short' }),
      rev:   daySales.reduce((a, s) => a + (s.total || 0), 0),
    });
  }

  // ── Gráfica Chart.js ─────────────────────────
  const chartCard = h('div', { class: 'card' });

  // Tabs de período de la gráfica
  const chartPeriod = window._chartPeriod || '7d';
  const chartTabBar = h('div', { class: 'fxb mb8' },
    h('div', null,
      h('div', { class: 'card-title' },
        chartPeriod === '7d' ? 'Ventas últimos 7 días' :
        chartPeriod === '30d' ? 'Ventas últimos 30 días' : 'Ventas por mes'),
      h('div', { class: 'card-sub' }, 'Ingresos · haz clic en la barra para detalles')
    ),
    h('div', { style: 'display:flex;gap:5px' },
      ...['7d','30d','12m'].map(p =>
        h('button', {
          class: `btn btn-sm ${chartPeriod === p ? 'btn-dark' : 'btn-out'}`,
          onclick: async () => { window._chartPeriod = p; await renderDash(el); }
        }, p === '7d' ? '7 días' : p === '30d' ? '30 días' : '12 meses')
      )
    )
  );
  chartCard.appendChild(chartTabBar);

  // Canvas para Chart.js
  const canvasWrap = h('div', { style: 'position:relative;height:200px' });
  const canvas = document.createElement('canvas');
  canvas.id = 'dash-chart-' + Date.now();
  canvas.style.cssText = 'width:100%;height:200px';
  canvasWrap.appendChild(canvas);
  chartCard.appendChild(canvasWrap);

  // Tooltip de detalle al hacer clic en barra
  const chartDetail = h('div', { id: 'chart-detail',
    style: 'min-height:24px;margin-top:10px;font-size:12px;color:var(--muted2);text-align:center' },
    'Haz clic en una barra para ver el detalle del día');
  chartCard.appendChild(chartDetail);
  grid.appendChild(chartCard);

  // Calcular datos según período
  let chartLabels = [], chartData = [], chartDates = [];
  if (chartPeriod === '7d') {
    chartLabels = days7.map(d => d.label);
    chartData   = days7.map(d => d.rev);
    chartDates  = days7.map(d => d.date);
  } else if (chartPeriod === '30d') {
    for (let i = 29; i >= 0; i--) {
      const d  = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const daySales = (allSales||[]).filter(s => {
        const sd = (s.created_at||'').split('T')[0].split(' ')[0];
        return sd === ds && s.status !== 'cancelled' && s.type !== 'devolucion';
      });
      chartLabels.push(d.getDate() + '/' + (d.getMonth()+1));
      chartData.push(daySales.reduce((a,s) => a+(s.total||0), 0));
      chartDates.push(ds);
    }
  } else {
    // 12 meses
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const mp = d.toISOString().slice(0,7);
      const mSalesF = (allSales||[]).filter(s =>
        (s.created_at||'').slice(0,7) === mp &&
        s.status !== 'cancelled' && s.type !== 'devolucion');
      chartLabels.push(d.toLocaleDateString('es-DO',{month:'short'}));
      chartData.push(mSalesF.reduce((a,s) => a+(s.total||0), 0));
      chartDates.push(mp);
    }
  }

  // Renderizar Chart.js después de que el DOM esté listo
  _dashRenderChart(canvas.id, chartLabels, chartData, chartDates, chartPeriod, chartDetail, allSales);

  // ── Columna derecha ───────────────────────────
  const rightCol = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

  // Stock bajo
  const stockCard = h('div', { class: 'card' });
  stockCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, `Stock Bajo (${lowStock.length})`),
    h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => routeTo('inventario'),
      html: `${svg('box')} Ver todo`
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
    lowStock.slice(0, 5).forEach(p => {
      const stockMin = p.stock_min || p.min || 5;
      const pct = Math.min((p.stock / stockMin) * 100, 100);
      stockCard.appendChild(h('div', { style: { marginBottom: '10px' } },
        h('div', { class: 'fxb mb8', style: { marginBottom: '4px' } },
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, p.name),
          h('span', { class: `badge ${p.stock === 0 ? 'r' : 'a'}` },
            p.stock === 0 ? 'Sin stock' : `${p.stock} ${p.unit || 'und'}`)
        ),
        h('div', { class: 'prog' },
          h('div', { class: 'prog-f', style: {
            width: `${pct}%`,
            background: p.stock === 0 ? 'var(--red)' : 'var(--amber)'
          }})
        ),
        h('div', { style: { fontSize: '10px', color: 'var(--muted2)', marginTop: '2px' } },
          `Mínimo: ${stockMin} · ${p.code}`)
      ));
    });
  }
  rightCol.appendChild(stockCard);

  // ── Estado del backup ────────────────────────
  const lastBackup   = versionInfo?.lastBackup || null;
  const backupCount  = versionInfo?.backupsCount || 0;
  const dbSize       = versionInfo?.dbSize || '—';
  const appVer       = versionInfo?.appVersion || '1.0.0';

  // Calcular si el backup está al dia
  const hoy          = today();
  const backupOk     = lastBackup === hoy;
  const backupAyer   = lastBackup === (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();
  const backupColor  = backupOk ? 'g' : backupAyer ? 'a' : 'r';
  const backupMsg    = backupOk
    ? 'Backup realizado hoy'
    : backupAyer
      ? 'Último backup: ayer'
      : lastBackup
        ? `Último backup: ${fdate(lastBackup)}`
        : 'Sin backup registrado';

  const backupCard = h('div', { class: 'card' });
  backupCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Estado del sistema'),
    h('span', { class: `badge ${backupColor}` }, backupOk ? '✓ Al día' : backupAyer ? 'Reciente' : '⚠ Revisar')
  ));

  // Fila backup
  backupCard.appendChild(h('div', { class: 'alrt ' + backupColor, style: { marginBottom: '8px' } },
    h('div', { class: 'alrt-dot ' + backupColor }),
    h('div', null,
      h('div', { class: 'alrt-title' }, backupMsg),
      h('div', { class: 'alrt-sub' }, `${backupCount} backup${backupCount !== 1 ? 's' : ''} guardados`)
    )
  ));

  // Info técnica
  [
    { label: 'Versión', val: `v${appVer}` },
    { label: 'Tamaño BD', val: dbSize },
  ].forEach(({ label, val }) => {
    backupCard.appendChild(h('div', {
      style: { display: 'flex', justifyContent: 'space-between',
               fontSize: '12px', padding: '4px 0',
               borderBottom: '1px solid var(--line2)' }
    },
      h('span', { style: { color: 'var(--muted)' } }, label),
      h('span', { style: { fontWeight: 600 } }, val)
    ));
  });

  rightCol.appendChild(backupCard);

  // Últimas ventas
  const lastCard = h('div', { class: 'card' });
  lastCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Últimas Ventas'),
    h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => routeTo('ventas'),
      html: `${svg('list')} Historial`
    })
  ));

  const last5 = [...DB.sales]
    .filter(s => s.status !== 'cancelled' && s.type !== 'devolucion')
    .reverse().slice(0, 5);

  if (!last5.length) {
    lastCard.appendChild(h('div', { class: 'empty', style: { padding: '18px' } },
      h('p', null, 'Sin ventas registradas')
    ));
  } else {
    last5.forEach(s => {
      const fecha   = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
      const cliName = s.customer_name || s.clientName || 'Consumidor Final';
      lastCard.appendChild(h('div', { class: 'fxb', style: {
        padding: '8px 0', borderBottom: '1px solid var(--line2)'
      } },
        h('div', null,
          h('div', { style: { fontSize: '12px', fontWeight: 600 } }, cliName),
          h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } },
            `${fdate(fecha)} · ${s.type || 'factura'}`)
        ),
        h('div', { style: { fontWeight: 700, fontSize: '13px' } }, fmt(s.total))
      ));
    });
  }
  rightCol.appendChild(lastCard);

  grid.appendChild(rightCol);
  el.appendChild(grid);
}

// ══════════════════════════════════════════════
// EXPORT PDF — Alertas de crédito
// ══════════════════════════════════════════════
function exportCreditAlertsPDF(alerts) {
  const rows = alerts.map(a => {
    const { client: c, daysLeft, status } = a;
    const balance   = Number(c.balance || 0);
    const creditDue = c.credit_due || c.creditDueDate || null;
    const label     = status === 'overdue'
      ? `Vencido hace ${Math.abs(daysLeft)} días`
      : `Vence en ${daysLeft} días`;
    return `
      <tr>
        <td>${c.name}</td>
        <td>${c.phone || '—'}</td>
        <td style="text-align:right">RD$${balance.toLocaleString('es-DO')}</td>
        <td>${creditDue ? fdate(creditDue) : '—'}</td>
        <td style="color:${status==='overdue'?'#DC2626':'#D97706'};font-weight:600">
          ${label}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Alertas Crédito</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;padding:20px}
  h2{margin-bottom:2px}.sub{color:#666;margin-bottom:14px;font-size:11px}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase}
  td{padding:7px 10px;border-bottom:1px solid #e5e7eb}
  .foot{margin-top:14px;font-size:10px;color:#9ca3af}
  .no-print{margin-bottom:12px;text-align:right}
  @media print{.no-print{display:none}}
</style></head><body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;
             border-radius:6px;font-size:12px;cursor:pointer">Imprimir</button>
  </div>
  <h2>Alertas de Crédito — ${CFG.biz}</h2>
  <div class="sub">
    ${alerts.length} cliente(s) con crédito vencido o por vencer · ${fdate(today())}
  </div>
  <table>
    <thead><tr>
      <th>Cliente</th><th>Teléfono</th>
      <th style="text-align:right">Balance</th>
      <th>Fecha Límite</th><th>Estado</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="foot">${CFG.biz} · ${CFG.phone} · ${CFG.addr}</div>
</body></html>`;

  const win = window.open('','_blank','width=860,height=600,scrollbars=yes');
  if (!win) { toast('Activa ventanas emergentes', 'w'); return; }
  win.document.open(); win.document.write(html); win.document.close(); win.focus();
}

// ══════════════════════════════════════════════
// EXPORT PDF — Estado de cuenta cliente
// ══════════════════════════════════════════════
function exportClientCreditPDF(c) {
  if (!c) return;
  const balance     = Number(c.balance || 0);
  const creditLimit = Number(c.credit_limit || c.creditLimit || 0);
  const creditDays  = Number(c.credit_days  || c.creditDays  || 30);
  const creditDue   = c.credit_due || c.creditDueDate || null;

  const pagos  = DB.payments.filter(p =>
    (p.customer_id || p.clientId) === c.id);
  const ventas = DB.sales.filter(s =>
    (s.customer_id || s.clientId) === c.id &&
    (s.payment_method || s.pay) === 'credito');

  const ventasRows = ventas.map(s => {
    const fecha = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
    return `<tr>
      <td>${fdate(fecha)}</td><td>Factura #${s.id}</td>
      <td style="text-align:right">RD$${Number(s.total||0).toLocaleString('es-DO')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" style="color:#9ca3af">Sin compras</td></tr>';

  const pagosRows = pagos.map(p => {
    const fecha = (p.created_at || '').split('T')[0].split(' ')[0];
    return `<tr>
      <td>${fdate(fecha)}</td><td>${p.note || 'Abono'}</td>
      <td style="text-align:right;color:#16A34A">
        +RD$${Number(p.amount||0).toLocaleString('es-DO')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" style="color:#9ca3af">Sin abonos</td></tr>';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Estado de Cuenta</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;padding:20px}
  h2{margin-bottom:2px}h3{margin:14px 0 6px;font-size:13px}
  .sub{color:#666;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;margin-bottom:10px}
  th{background:#f3f4f6;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase}
  td{padding:7px 10px;border-bottom:1px solid #e5e7eb}
  .total{font-weight:700;font-size:14px;margin-top:10px}
  .foot{margin-top:16px;font-size:10px;color:#9ca3af}
  .no-print{margin-bottom:12px;text-align:right}
  @media print{.no-print{display:none}}
</style></head><body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 16px;
             border-radius:6px;font-size:12px;cursor:pointer">Imprimir</button>
  </div>
  <h2>Estado de Cuenta — ${c.name}</h2>
  <div class="sub">
    RNC: ${c.rnc || '—'} · Tel: ${c.phone || '—'}<br>
    Límite: RD$${creditLimit.toLocaleString('es-DO')} · Plazo: ${creditDays} días
    ${creditDue ? '<br>Fecha límite: ' + fdate(creditDue) : ''}
  </div>
  <h3>Compras a Crédito</h3>
  <table><thead><tr><th>Fecha</th><th>Concepto</th>
    <th style="text-align:right">Monto</th></tr></thead>
    <tbody>${ventasRows}</tbody></table>
  <h3>Abonos Realizados</h3>
  <table><thead><tr><th>Fecha</th><th>Concepto</th>
    <th style="text-align:right">Monto</th></tr></thead>
    <tbody>${pagosRows}</tbody></table>
  <div class="total">Balance pendiente: RD$${balance.toLocaleString('es-DO')}</div>
  <div class="foot">${CFG.biz} · ${CFG.phone} · ${CFG.addr}</div>
</body></html>`;

  const win = window.open('','_blank','width=760,height=650,scrollbars=yes');
  if (!win) { toast('Activa ventanas emergentes', 'w'); return; }
  win.document.open(); win.document.write(html); win.document.close(); win.focus();
}


// ══════════════════════════════════════════════
// CHART.JS — Renderizado del dashboard
// ══════════════════════════════════════════════
function _loadChartJs() {
  return new Promise(res => {
    if (window.Chart) { res(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
    s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  });
}

async function _dashRenderChart(canvasId, labels, data, dates, period, detailEl, allSales) {
  await _loadChartJs();
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;

  // Destruir instancia previa si existe
  if (window._dashChartInstance) {
    try { window._dashChartInstance.destroy(); } catch {}
  }

  const today_ = today();
  const bgColors = dates.map(d =>
    d === today_ || d === today_.slice(0,7)
      ? 'rgba(22,163,74,0.85)'
      : 'rgba(99,102,241,0.6)'
  );
  const borderColors = dates.map(d =>
    d === today_ || d === today_.slice(0,7)
      ? 'rgba(22,163,74,1)'
      : 'rgba(99,102,241,1)'
  );

  const maxVal = Math.max(...data, 1);

  window._dashChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Ventas',
        data,
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 1.5,
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + fmt(ctx.parsed.y),
            title: ctx => {
              const i = ctx[0].dataIndex;
              const d = dates[i];
              if (period === '12m') return labels[i];
              return fdate(d);
            }
          },
          backgroundColor: 'rgba(13,15,18,0.92)',
          titleColor: '#fff',
          bodyColor: '#a1a1aa',
          padding: 10,
          cornerRadius: 8,
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 10 },
            color: 'var(--muted2)',
            maxRotation: period === '30d' ? 45 : 0,
          }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false },
          ticks: {
            font: { size: 10 },
            color: 'var(--muted2)',
            callback: v => v >= 1000 ? (v/1000).toFixed(0)+'k' : v,
          },
          beginAtZero: true,
        }
      },
      onClick: (evt, elements) => {
        if (!elements.length || !detailEl) return;
        const i   = elements[0].index;
        const d   = dates[i];
        const rev = data[i];
        if (!rev) {
          detailEl.textContent = `${labels[i]} — Sin ventas`;
          return;
        }
        // Filtrar ventas del día/mes seleccionado
        const daySales = (allSales||[]).filter(s => {
          const sd = (s.created_at||'').split('T')[0].split(' ')[0];
          return (period === '12m' ? sd.slice(0,7) === d : sd === d) &&
                 s.status !== 'cancelled' && s.type !== 'devolucion';
        });
        detailEl.innerHTML = `
          <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;
                      padding:8px;background:var(--surface2);border-radius:8px">
            <span><strong>${fdate(d)}</strong></span>
            <span style="color:var(--green);font-weight:700">${fmt(rev)}</span>
            <span style="color:var(--muted2)">${daySales.length} transacc.</span>
            <span style="color:var(--muted2)">ITBIS: ${fmt(daySales.reduce((a,s)=>a+(s.tax_amt||0),0))}</span>
          </div>`;
      }
    }
  });
}
