// ══════════════════════════════════════════════
// dashboard.js — Dashboard principal
//               Usa campos SQLite correctamente
// ══════════════════════════════════════════════

const _DASH_WIDGETS = [
  { id:'pulse', label:'Pulso ejecutivo', help:'Salud operativa, caja y prioridades' },
  { id:'credits', label:'Cuentas por cobrar', help:'Clientes con balances y vencimientos' },
  { id:'metrics', label:'Indicadores comerciales', help:'Ventas, ganancia, créditos y cotizaciones' },
  { id:'cashflow', label:'Ventas y abonos', help:'Composición del efectivo cobrado' },
  { id:'expenses', label:'Gastos y cuentas por pagar', help:'Egresos y compromisos del período' },
  { id:'fiscal', label:'Resumen fiscal', help:'ITBIS, secuencias y alertas NCF' },
  { id:'analysis', label:'Análisis y operación', help:'Gráficas, inventario y actividad reciente' },
];

function _dashLayoutKey() {
  return `velo:dashboard-layout:v1:${CFG?.biz || 'business'}:${user?.id || 'user'}`;
}

function _dashDefaultLayout() {
  return _DASH_WIDGETS.map(x => ({ id:x.id, visible:true }));
}

function _dashLoadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(_dashLayoutKey()) || '[]');
    const map = new Map(saved.map(x => [x.id, x]));
    const ordered = saved.filter(x => _DASH_WIDGETS.some(w => w.id === x.id));
    _DASH_WIDGETS.forEach(w => { if (!map.has(w.id)) ordered.push({ id:w.id, visible:true }); });
    return ordered.map(x => ({ id:x.id, visible:x.visible !== false }));
  } catch (_) { return _dashDefaultLayout(); }
}

function _dashSaveLayout(layout) {
  localStorage.setItem(_dashLayoutKey(), JSON.stringify(layout));
}

function _dashWidget(el, id) {
  if (el) el.dataset.dashboardWidget = id;
  return el;
}

function _dashApplyLayout(root) {
  const layout = _dashLoadLayout();
  layout.forEach(item => {
    root.querySelectorAll(`[data-dashboard-widget="${item.id}"]`).forEach(node => {
      node.hidden = !item.visible;
      root.appendChild(node);
    });
  });
}

function _dashSparkline(values, color = '#10b981') {
  const clean = (values || []).map(Number).filter(Number.isFinite);
  if (clean.length < 2 || !clean.some(v => v > 0)) return '<span class="dash-spark-empty">Sin historial suficiente</span>';
  const max = Math.max(...clean, 1);
  const min = Math.min(...clean);
  const span = Math.max(max - min, 1);
  const points = clean.map((v, i) => `${(i / (clean.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  return `<svg class="dash-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label="Tendencia del período"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function dashConfigure() {
  const exp = window.VeloExperience;
  if (!exp?.openDrawer) return;
  let layout = _dashLoadLayout();
  const renderRows = body => {
    body.querySelector('[data-dash-layout-list]').innerHTML = layout.map((item, index) => {
      const meta = _DASH_WIDGETS.find(x => x.id === item.id);
      return `<div class="dash-config-row" data-widget="${item.id}">
        <label><input type="checkbox" ${item.visible ? 'checked' : ''}/><span><strong>${meta?.label || item.id}</strong><small>${meta?.help || ''}</small></span></label>
        <div><button data-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Subir">↑</button><button data-move="down" ${index === layout.length - 1 ? 'disabled' : ''} aria-label="Bajar">↓</button></div>
      </div>`;
    }).join('');
  };
  const body = exp.openDrawer({ id:'dashboard-config', title:'Personaliza tu tablero', subtitle:'El orden y la visibilidad se guardan para tu usuario', width:'500px', content:`
    <div class="dash-config-intro">Organiza el tablero según lo que revisas primero. Los datos y permisos no cambian.</div>
    <div class="dash-config-list" data-dash-layout-list></div>
    <div class="dash-config-actions"><button class="btn btn-out" data-reset>Restablecer</button><button class="btn btn-green" data-save>Guardar diseño</button></div>` });
  renderRows(body);
  body.addEventListener('change', e => {
    const row = e.target.closest('[data-widget]');
    if (!row || e.target.type !== 'checkbox') return;
    const item = layout.find(x => x.id === row.dataset.widget);
    if (item) item.visible = e.target.checked;
  });
  body.addEventListener('click', async e => {
    const row = e.target.closest('[data-widget]');
    const move = e.target.closest('[data-move]')?.dataset.move;
    if (row && move) {
      const index = layout.findIndex(x => x.id === row.dataset.widget);
      const next = move === 'up' ? index - 1 : index + 1;
      if (index >= 0 && next >= 0 && next < layout.length) [layout[index], layout[next]] = [layout[next], layout[index]];
      renderRows(body);
      return;
    }
    if (e.target.closest('[data-reset]')) { layout = _dashDefaultLayout(); renderRows(body); return; }
    if (e.target.closest('[data-save]')) {
      _dashSaveLayout(layout);
      exp.closeDrawer();
      const mainEl = document.getElementById('main-content') || document.getElementById('page');
      if (mainEl) await renderDash(mainEl);
    }
  });
}

async function renderDash(el) {
  // Fluidez: doble-buffer. En vez de `el.innerHTML=''` (destello en blanco),
  // construimos todo en un buffer fuera de pantalla (pero dentro del documento,
  // para que el canvas del chart tenga dimensiones) y hacemos un swap atómico
  // al final. El contenido viejo permanece visible mientras corre el build.
  const root = document.createElement('div');
  root.className = 'module-canvas';
  root.style.cssText = 'position:absolute;left:-99999px;top:0;width:' + (el.clientWidth || 900) + 'px';
  document.body.appendChild(root);

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

  // Nota: la tarifa cobrada por envíos es un INGRESO, no un gasto. Los gastos
  // reales de envíos (mensajería/combustible) entran por el módulo Gastos, que
  // ya está sumado arriba — no se agregan aquí para no duplicar ni distorsionar.

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
    s.status !== 'cancelled' && s.status !== 'returned' && s.type !== 'devolucion');
  const rev    = sales.reduce((a, s) => a + (s.total || 0), 0);
  const itbis  = sales.reduce((a, s) => a + (s.tax_amt || s.itbis || 0), 0);

  // Calcular ganancia bruta del día (precio - costo desde sale_items en memoria)
  const todaySalesIds = new Set(sales.map(s => s.id));
  const cost = DB.sales
    .filter(s => todaySalesIds.has(s.id))
    .reduce((a, s) => a + (s.cost_total || 0), 0);
  const profit    = rev - itbis - cost;
  // Margen sobre ingreso neto (sin ITBIS), criterio contable correcto
  const netRevToday = rev - itbis;
  const margin    = netRevToday > 0 ? ((profit / netRevToday) * 100).toFixed(0) : 0;

  // Ventas del mes
  const today_ = today();
  const monthPfx = today_.slice(0, 7);

  // Estas 4 consultas son independientes entre sí: se piden en paralelo para
  // no encadenar la espera (antes eran 4 await en serie ≈ suma de latencias).
  const [allSales, weekSales, monthSummaryRes, dailyTrendRes] = await Promise.all([
    window.api.sales.getAll({ range: 'month' }),
    window.api.sales.getAll({ range: 'week' }),
    window.api.reports.summary({ range: 'month', requestUserId: user.id }).catch(() => null),
    window.api.reports.dailyTrend({ days: 30, includeHistorical: true, requestUserId: user.id }).catch(() => null),
  ]);

  const isOperationalSale = s =>
    s.status !== 'cancelled' &&
    s.status !== 'returned' &&
    s.type !== 'devolucion';

  const mSales = (allSales || []).filter(isOperationalSale);
  // Ventas del mes vía agregado SQL — exacto sin importar el límite de filas.
  const mRev          = monthSummaryRes?.ok ? monthSummaryRes.data.totalRev          : mSales.reduce((a, s) => a + (s.total || 0), 0);
  const mAbonos       = monthSummaryRes?.ok ? (monthSummaryRes.data.abonos?.total    || 0) : 0;
  const mVentasContado = monthSummaryRes?.ok ? (monthSummaryRes.data.ventasContado   || 0) : 0;
  const mVentasCredito = monthSummaryRes?.ok ? (monthSummaryRes.data.ventasCredito   || 0) : 0;
  // cobradoMes = ventas al contado + abonos de CxC (dinero real recibido en el mes)
  const mCobrado      = monthSummaryRes?.ok ? (monthSummaryRes.data.cobradoMes       || 0) : 0;

  // Agregado diario para los gráficos de 7 y 30 días.
  const dailyByDate = {};
  (dailyTrendRes?.data || []).forEach(r => { dailyByDate[r.day] = r; });

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

  root.appendChild(h('div', { class: 'sec-hdr' },
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
        class: 'btn btn-out btn-sm dash-personalize-btn',
        onclick: dashConfigure,
        html: `⚙ Personalizar`
      }),
      h('button', {
        class: 'btn btn-out btn-sm',
        title: 'Actualizar ahora',
        onclick: async () => {
          const mainEl = document.getElementById('page');
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

  // ── Pulso ejecutivo ─────────────────────────
  // Resume salud y pendientes sin obligar al propietario a interpretar todas
  // las tarjetas. Cada bloque lleva directamente al área que requiere acción.
  const overdueCredits = creditAlerts.filter(a => a.status === 'overdue').length;
  const payablePending = (gastosData?.payable || []).filter(x =>
    !['pagado','anulado','rechazado'].includes(String(x.status || '').toLowerCase())).length;
  const actionCount = lowStock.length + creditAlerts.length + payablePending + (cajaOpen ? 0 : 1);
  const healthScore = Math.max(0, 100
    - Math.min(30, lowStock.length * 3)
    - Math.min(30, overdueCredits * 7)
    - Math.min(20, payablePending * 3)
    - (cajaOpen ? 0 : 12));
  const healthTone = healthScore >= 85 ? 'good' : healthScore >= 65 ? 'warn' : 'risk';

  const executiveStrip = h('section', { class: 'ux-exec-strip' },
    h('div', { class: `ux-exec-health ${healthTone}` },
      h('div', { class: 'ux-exec-ring', style: `--score:${healthScore}` }, h('strong', null, healthScore)),
      h('div', null, h('span', null, 'SALUD OPERATIVA'),
        h('b', null, healthScore >= 85 ? 'Operación saludable' : healthScore >= 65 ? 'Requiere seguimiento' : 'Atención prioritaria'))
    ),
    h('button', { onclick: () => routeTo('caja') },
      h('span', { class: `ux-exec-dot ${cajaOpen ? 'good' : 'risk'}` }),
      h('div', null, h('small', null, 'CAJA'), h('strong', null, cajaOpen ? 'Sesión activa' : 'Pendiente de apertura'))
    ),
    h('button', { onclick: () => window.experienceOpenNotifications?.() },
      h('span', { class: `ux-exec-count ${actionCount ? 'warn' : 'good'}` }, String(actionCount)),
      h('div', null, h('small', null, 'PRIORIDADES'), h('strong', null, actionCount ? 'Revisar pendientes' : 'Todo bajo control'))
    ),
    h('button', { onclick: () => window.experienceOpenQuickActions?.() },
      h('span', { class: 'ux-exec-action', html: svg('plus') }),
      h('div', null, h('small', null, 'ACCIÓN RÁPIDA'), h('strong', null, 'Crear o registrar'))
    )
  );
  root.appendChild(_dashWidget(executiveStrip, 'pulse'));

  // ── Card CxC: Cuentas por Cobrar ─────────────
  if (creditAlerts.length) {
    const cxcClients = DB.customers
      .filter(c => c.id !== 1 && c.active !== 0 && c.balance > 0)
      .sort((a, b) => b.balance - a.balance);
    const totalCxC = cxcClients.reduce((s, c) => s + c.balance, 0);
    const vencidos = creditAlerts.filter(a => a.status === 'overdue').length;

    const cxcBox = h('div', { class: 'card mb20' });

    // Encabezado del card
    cxcBox.appendChild(h('div', { class: 'fxb mb8' },
      h('div', { class: 'flex', style: { gap: '8px', alignItems: 'center' } },
        h('div', { html: svg('dollar'), style: { color: 'var(--red)' } }),
        h('div', null,
          h('div', { style: { fontWeight: 700, fontSize: '14px' } }, 'Cuentas por Cobrar'),
          h('div', { style: { fontSize: '11px', color: 'var(--muted2)' } },
            `${cxcClients.length} clientes · ${vencidos} vencidos`)
        )
      ),
      h('div', { class: 'flex', style: { gap: '6px', alignItems: 'center' } },
        h('div', { style: { fontWeight: 800, fontSize: '15px', color: 'var(--red)' } },
          fmt(totalCxC)
        ),
        h('button', {
          class: 'btn btn-sm btn-out',
          onclick: () => { window._cliTabInicial = 'credito'; routeTo('clientes'); },
          html: `${svg('users')} Ver todos`
        }),
        h('button', {
          class: 'btn btn-out btn-sm',
          onclick: () => exportCreditAlertsPDF(creditAlerts),
          html: `${svg('pdf')} PDF`
        })
      )
    ));

    // Lista scrolleable (máx ~5 filas visibles)
    const listWrap = h('div', { style: {
      maxHeight: '220px', overflowY: 'auto',
      borderTop: '1px solid var(--line)', marginTop: '4px'
    }});

    cxcClients.forEach(c => {
      const alert     = creditAlerts.find(a => a.client.id === c.id);
      const isOverdue = alert?.status === 'overdue';
      const daysLeft  = alert?.daysLeft ?? null;
      const label     = daysLeft === null ? '' :
        isOverdue
          ? `Vencido ${Math.abs(daysLeft)}d`
          : `Vence en ${daysLeft}d`;

      listWrap.appendChild(h('div', {
        class: 'fxb',
        style: {
          padding: '7px 4px',
          borderBottom: '1px solid var(--line)',
          fontSize: '12px'
        }
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            c.name),
          daysLeft !== null
            ? h('div', { style: { fontSize: '10px', color: isOverdue ? 'var(--red)' : 'var(--amber)' } }, label)
            : null
        ),
        h('div', { class: 'flex', style: { gap: '5px', alignItems: 'center' } },
          h('span', { style: { fontWeight: 700, color: 'var(--red)', fontSize: '12px' } },
            fmt(c.balance)),
          h('button', {
            class: 'btn btn-sm btn-out',
            style: { fontSize: '11px', padding: '2px 8px' },
            onclick: () => { closeModal?.(); openAbonoModal(c); },
            html: `${svg('dollar')} Abonar`
          }),
          h('button', {
            class: 'btn btn-sm btn-out',
            style: { fontSize: '11px', padding: '2px 6px' },
            onclick: () => openEstadoCuentaModal(c, 'facturas'),
            html: svg('pdf')
          })
        )
      ));
    });

    cxcBox.appendChild(listWrap);
    root.appendChild(_dashWidget(cxcBox, 'credits'));
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
  root.appendChild(periodBar);

  // Calcular métricas del período — usando filas reales en todos los casos
  // (no solo agregados) porque más abajo se necesita el conteo de
  // transacciones y el detalle de facturas para el panel NCF.
  // '3days'/'week' usan weekSales (rango real de 7 días por SQL) en vez de
  // allSales, que solo cubre el mes en curso y no alcanza estos rangos
  // cerca del inicio del mes.
  let periodSales = sales;
  if (dashPeriod === '3days') {
    const cutoff = new Date(Date.now() - 3*24*60*60*1000).toISOString().split('T')[0];
    periodSales  = (weekSales||[]).filter(s => isOperationalSale(s)
      && (s.created_at||'').slice(0,10) >= cutoff);
  } else if (dashPeriod === 'week') {
    periodSales = (weekSales||[]).filter(isOperationalSale);
  } else if (dashPeriod === 'month') {
    periodSales = mSales;
  }

  const periodRev    = periodSales.reduce((a,s) => a + (s.total||0), 0);
  const periodITBIS  = periodSales.reduce((a,s) => a + (s.tax_amt||0), 0);
  const periodCost   = periodSales.reduce((a,s) => a + (s.cost_total||0), 0);
  const periodProfit = periodRev - periodITBIS - periodCost;
  // Margen sobre ingreso neto (sin ITBIS), igual criterio que Reportes
  const periodNetRev = periodRev - periodITBIS;
  const periodMargin = periodNetRev > 0 ? ((periodProfit/periodNetRev)*100).toFixed(1) : 0;
  const periodLabel  = { today:'Hoy', '3days':'3 días', week:'7 días', month:'Mes' }[dashPeriod];

  // ── Métricas ─────────────────────────────────
  // '3days'/'week' usan weekSales (rango real de 7 días) — allSales solo
  // cubre el mes en curso y no alcanza estos rangos cerca del inicio del mes.
  const cotizSource = (dashPeriod === '3days' || dashPeriod === 'week') ? weekSales : allSales;
  const cotizaciones = (cotizSource || []).filter(s =>
    s.type === 'cotizacion' && s.status !== 'cancelled');
  const cotizPeriod = (() => {
    if (dashPeriod === 'today') {
      return cotizaciones.filter(s => (s.created_at||'').slice(0,10) === today_);
    } else if (dashPeriod === '3days') {
      const c3 = new Date(Date.now()-3*24*60*60*1000).toISOString().split('T')[0];
      return cotizaciones.filter(s => (s.created_at||'').slice(0,10) >= c3);
    } else if (dashPeriod === 'week') {
      return cotizaciones;
    }
    return cotizaciones.filter(s => (s.created_at||'').slice(0,7) === monthPfx);
  })();
  const cotizTotal = cotizPeriod.reduce((a,s) => a+(s.total||0), 0);

  const metWrap = h('div', { class: 'metrics' });
  const trend7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    trend7.push(dailyByDate[d.toISOString().split('T')[0]]?.total || 0);
  }
  [
    { icon: 'dollar', color: 'g', label: `Ventas (${periodLabel})`,
      val: fmt(periodRev), badge: `${periodSales.length} transac.`, badgeType: 'nu', spark:_dashSparkline(trend7) },
    { icon: 'trend',  color: 'g', label: `Ganancia (${periodLabel})`,
      val: fmt(periodProfit > 0 ? periodProfit : 0),
      badge: `${periodMargin}% margen`,
      badgeType: periodProfit > 0 ? 'nu' : 'dn', spark:_dashSparkline(trend7, '#6366f1') },
    { icon: 'chart',  color: 'p', label: 'Ventas del Mes',
      val: fmt(mRev),
      badge: mVentasContado > 0 || mVentasCredito > 0
        ? `${fmt(mVentasContado)} contado · ${fmt(mVentasCredito)} crédito`
        : `${mSales.length} ventas`,
      badgeType: 'nu' },
    { icon: 'dollar', color: 'g', label: 'Ventas / Abonos a Facturas',
      val: fmt(mCobrado), badge: `contado + abonos CxC`, badgeType: 'nu',
      click: () => {
        window._reportesTabInicial = 'abonos';
        window._reportesRangeInicial = 'month';
        routeTo('reportes');
      } },
    { icon: 'card',   color: 'a', label: 'Créditos Pendientes',
      val: fmt(pendCredit), badge: `${totalClients} clientes`,
      badgeType: pendCredit > 0 ? 'dn' : 'nu',
      click: () => { window._cliTabInicial = 'credito'; routeTo('clientes'); } },
    { icon: 'list',   color: 'p', label: `Cotizaciones (${periodLabel})`,
      val: fmt(cotizTotal),
      badge: `${cotizPeriod.length} pendiente${cotizPeriod.length !== 1 ? 's' : ''}`,
      badgeType: cotizPeriod.length > 0 ? 'nu' : 'nu',
      click: () => { window._ventasTabInicial = 'cotizaciones'; routeTo('ventas'); } },
  ].forEach(m => {
    const card = h('div', {
      class: 'metric dash-metric-card',
      style: m.click ? { cursor: 'pointer' } : {},
      ...(m.click ? { onclick: m.click } : {})
    },
      h('div', { class: 'met-top' },
        h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
      ),
      h('div', { class: 'met-label' }, m.label),
      h('div', { class: 'met-val' }, m.val),
      m.spark ? h('div', { class:'dash-metric-spark', html:m.spark }) : null,
      h('div', { class: 'met-foot' },
        h('span', { class: `met-badge ${m.badgeType}` }, m.badge)
      )
    );
    metWrap.appendChild(card);
  });
  root.appendChild(_dashWidget(metWrap, 'metrics'));

  // ── Barra resumen mensual: desglose de cobradoMes ────────────────────────────
  // cobradoMes = ventas al contado + abonos de CxC (dinero real recibido)
  // La barra descompone el cobrado en sus dos fuentes; el total es cobradoMes.
  const mCobradoBase  = Math.max(mCobrado, 1);
  const mContadoPct   = (mVentasContado / mCobradoBase) * 100;
  const mAbonosPct    = (mAbonos        / mCobradoBase) * 100;
  const monthLabel    = new Date().toLocaleString('es-DO', { month: 'long', year: 'numeric' });

  const resumenBar = h('div', {
    style: {
      background: 'var(--surface)', border: '1px solid var(--line)',
      borderRadius: 'var(--r-lg)', padding: '16px 20px',
      boxShadow: 'var(--sh)', marginBottom: '20px', cursor: 'pointer',
    },
    title: 'Ver detalle de abonos en Reportes',
    onclick: () => {
      window._reportesTabInicial = 'abonos';
      window._reportesRangeInicial = 'month';
      routeTo('reportes');
    }
  },
    h('div', { style: { display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'4px' } },
      h('span', { style: { fontSize:'12px', fontWeight:600, color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.5px' } },
        `Ventas / Abonos a Facturas — ${monthLabel}`),
      h('span', { style: { fontSize:'18px', fontWeight:800, color:'var(--ink)', letterSpacing:'-.5px' } },
        fmt(mCobrado))
    ),
    h('div', { style: { fontSize:'11px', color:'var(--muted2)', marginBottom:'10px' } },
      `Facturado: ${fmt(mRev)}`),
    // Barra segmentada: contado (purple) + abonos CxC (green) = cobradoMes
    h('div', { style: { display:'flex', height:'10px', borderRadius:'99px', overflow:'hidden', gap:'2px', marginBottom:'12px', background:'var(--line)' } },
      h('div', { style: { width: `${mContadoPct}%`, background:'var(--purple)', borderRadius:'99px 0 0 99px', transition:'width .4s' } }),
      h('div', { style: { width: `${mAbonosPct}%`, background:'var(--green)',  borderRadius:'0 99px 99px 0', transition:'width .4s' } })
    ),
    // Leyenda
    h('div', { style: { display:'flex', gap:'20px' } },
      h('div', { style: { display:'flex', alignItems:'center', gap:'6px' } },
        h('div', { style: { width:'10px', height:'10px', borderRadius:'3px', background:'var(--purple)', flexShrink:0 } }),
        h('span', { style: { fontSize:'11px', color:'var(--muted)' } }, 'Ventas al contado'),
        h('span', { style: { fontSize:'12px', fontWeight:700, color:'var(--ink)' } }, fmt(mVentasContado))
      ),
      h('div', { style: { display:'flex', alignItems:'center', gap:'6px' } },
        h('div', { style: { width:'10px', height:'10px', borderRadius:'3px', background:'var(--green)', flexShrink:0 } }),
        h('span', { style: { fontSize:'11px', color:'var(--muted)' } }, 'Abonos CxC'),
        h('span', { style: { fontSize:'12px', fontWeight:700, color:'var(--ink)' } }, fmt(mAbonos))
      )
    )
  );
  root.appendChild(_dashWidget(resumenBar, 'cashflow'));

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
    root.appendChild(_dashWidget(gasMetWrap, 'expenses'));
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
    root.appendChild(_dashWidget(ncfMetWrap, 'fiscal'));

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
      root.appendChild(_dashWidget(ncfAlertBox, 'fiscal'));
    }
  }

  // ── Grid principal ────────────────────────────
  const grid = h('div', { class: 'gg2', style: { alignItems: 'start' } });

  // ── Gráfica 7 días — agregado real vía SQL (dailyByDate) ─
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d  = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().split('T')[0];
    days7.push({
      date:  ds,
      label: d.toLocaleDateString('es-DO', { weekday: 'short' }),
      rev:   dailyByDate[ds]?.total || 0,
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
  let chartLabels = [], chartData = [], chartDates = [], chartMeta = {};
  if (chartPeriod === '7d') {
    chartLabels = days7.map(d => d.label);
    chartData   = days7.map(d => d.rev);
    chartDates  = days7.map(d => d.date);
    days7.forEach(d => {
      chartMeta[d.date] = {
        count: dailyByDate[d.date]?.count || 0,
        tax: dailyByDate[d.date]?.tax || 0,
      };
    });
  } else if (chartPeriod === '30d') {
    for (let i = 29; i >= 0; i--) {
      const d  = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      chartLabels.push(d.getDate() + '/' + (d.getMonth()+1));
      chartData.push(dailyByDate[ds]?.total || 0);
      chartDates.push(ds);
      chartMeta[ds] = {
        count: dailyByDate[ds]?.count || 0,
        tax: dailyByDate[ds]?.tax || 0,
      };
    }
  } else {
    // 12 meses — agregado real vía SQL (no depende de allSales, que solo
    // trae el mes en curso, ni del límite de filas de sales:getAll).
    const trendRes = await window.api.reports.monthlyTrend({
      includeHistorical: true,
      requestUserId: user.id
    }).catch(() => null);
    const trendByMonth = {};
    (trendRes?.data || []).forEach(r => {
      trendByMonth[r.month] = r.total;
      chartMeta[r.month] = { count: r.count || 0, tax: r.tax || 0 };
    });
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const mp = d.toISOString().slice(0,7);
      chartLabels.push(d.toLocaleDateString('es-DO',{month:'short'}));
      chartData.push(trendByMonth[mp] || 0);
      chartDates.push(mp);
    }
  }

  // Renderizar Chart.js después de que el DOM esté listo
  _dashRenderChart(canvas.id, chartLabels, chartData, chartDates, chartPeriod, chartDetail, allSales, chartMeta);

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
    .filter(s => s.status !== 'cancelled' && s.status !== 'returned' && s.type !== 'devolucion')
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
  root.appendChild(_dashWidget(grid, 'analysis'));

  _dashApplyLayout(root);

  // ── Swap atómico ────────────────────────────
  // Mover todo lo construido al contenedor real de una sola vez (sin destello).
  // El canvas del chart queda ahora en el DOM vivo; _dashRenderChart (disparado
  // arriba sin await) resuelve su getElementById DESPUÉS de este swap, así que
  // encuentra el canvas ya montado y con dimensiones.
  el.replaceChildren(...Array.from(root.childNodes));
  root.remove();
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
        <td>${_esc(c.name)}</td>
        <td>${_esc(c.phone)||'—'}</td>
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
</style></head><body>
  <h2>Alertas de Crédito — ${_esc(CFG.biz)}</h2>
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
  <div class="foot">${_esc(CFG.biz)} · ${_esc(CFG.phone)} · ${_esc(CFG.addr)}</div>
</body></html>`;

  printHTML(html, 'reporte');
}

// Nota: exportClientCreditPDF() vive en clientes.js (versión completa,
// con historial en vivo vía IPC) — ese archivo carga después y es la
// única definición global.

// ══════════════════════════════════════════════
// CHART.JS — Renderizado del dashboard
// ══════════════════════════════════════════════
function _loadChartJs() {
  return Promise.resolve();
}

async function _dashRenderChart(canvasId, labels, data, dates, period, detailEl, allSales, meta = {}) {
  await _loadChartJs();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Destruir instancia previa si existe
  if (window._dashChartInstance) {
    try { window._dashChartInstance.destroy(); } catch {}
  }

  if (!window.Chart) {
    _dashRenderNativeChart(canvas, labels, data, dates, period, detailEl, allSales, meta);
    return;
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
                 s.status !== 'cancelled' && s.status !== 'returned' &&
                 s.type !== 'devolucion';
        });
        const m = meta[d] || {};
        detailEl.innerHTML = `
          <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;
                      padding:8px;background:var(--surface2);border-radius:8px">
            <span><strong>${period === '12m' ? d : fdate(d)}</strong></span>
            <span style="color:var(--green);font-weight:700">${fmt(rev)}</span>
            <span style="color:var(--muted2)">${m.count ?? daySales.length} transacc.</span>
            <span style="color:var(--muted2)">ITBIS: ${fmt(m.tax ?? daySales.reduce((a,s)=>a+(s.tax_amt||0),0))}</span>
          </div>`;
      }
    }
  });
}

function _dashRenderNativeChart(canvas, labels, data, dates, period, detailEl, allSales, meta = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width || canvas.parentElement?.clientWidth || 640);
  const height = Math.max(180, rect.height || 200);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 44, right: 12, top: 12, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxVal = Math.max(...data, 1);
  const today_ = today();
  const bars = [];

  ctx.font = '10px "DM Sans", Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted2') || '#9ca3af';
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    const value = maxVal - (maxVal / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)), 4, y);
  }

  const gap = Math.max(5, Math.min(12, plotW / Math.max(labels.length, 1) * 0.25));
  const barW = Math.max(5, (plotW - gap * (labels.length - 1)) / Math.max(labels.length, 1));

  labels.forEach((label, i) => {
    const value = data[i] || 0;
    const x = pad.left + i * (barW + gap);
    const hgt = value > 0 ? Math.max(4, (value / maxVal) * plotH) : 2;
    const y = pad.top + plotH - hgt;
    const active = dates[i] === today_ || dates[i] === today_.slice(0, 7);
    ctx.fillStyle = active ? 'rgba(22,163,74,0.85)' : 'rgba(99,102,241,0.65)';
    const r = Math.min(5, barW / 2, hgt / 2);
    _dashRoundRect(ctx, x, y, barW, hgt, r);
    ctx.fill();

    ctx.fillStyle = active ? '#111827' : '#9ca3af';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + barW / 2, height - 13);
    bars.push({ x, y, w: barW, h: hgt, index: i });
  });

  canvas.style.cursor = 'pointer';
  canvas.onclick = (evt) => {
    const box = canvas.getBoundingClientRect();
    const x = evt.clientX - box.left;
    const y = evt.clientY - box.top;
    const hit = bars.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h + 8);
    if (!hit || !detailEl) return;
    const i = hit.index;
    const d = dates[i];
    const rev = data[i] || 0;
    const m = meta[d] || {};
    if (!rev) {
      detailEl.textContent = `${labels[i]} - Sin ventas`;
      return;
    }
    const daySales = (allSales || []).filter(s => {
      const sd = (s.created_at || '').split('T')[0].split(' ')[0];
      return (period === '12m' ? sd.slice(0, 7) === d : sd === d) &&
             s.status !== 'cancelled' && s.status !== 'returned' &&
             s.type !== 'devolucion';
    });
    detailEl.innerHTML = `
      <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;
                  padding:8px;background:var(--surface2);border-radius:8px">
        <span><strong>${period === '12m' ? d : fdate(d)}</strong></span>
        <span style="color:var(--green);font-weight:700">${fmt(rev)}</span>
        <span style="color:var(--muted2)">${m.count ?? daySales.length} transacc.</span>
        <span style="color:var(--muted2)">ITBIS: ${fmt(m.tax ?? daySales.reduce((a,s)=>a+(s.tax_amt||0),0))}</span>
      </div>`;
  };
}

function _dashRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
