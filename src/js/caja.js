// ══════════════════════════════════════════════
// caja.js — Gestión de Caja
//           · Apertura con fondo inicial
//           · Cierre con cuadre y arqueo
//           · Reporte impreso del día
//           · Historial de sesiones
// ══════════════════════════════════════════════

function renderCaja(el) {
  el.innerHTML = '';

  // ── Header ───────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Caja'),
      h('div', { class: 'sec-sub' },
        cajaOpen
          ? `Abierta por ${cajaSession?.cajero} desde ${fdate(cajaSession?.od)} ${cajaSession?.ot}`
          : 'No hay caja abierta'
      )
    ),
    cajaOpen
      ? h('div', { class: 'flex', style: { gap: '8px' } },
          h('button', {
            class: 'btn btn-out',
            onclick: () => imprimirReporteDia(),
            html: `${svg('print')} Reporte del día`
          }),
          h('button', {
            class: 'btn btn-red',
            onclick: openCierreCajaModal,
            html: `${svg('lock')} Cerrar Caja`
          })
        )
      : h('button', {
          class: 'btn btn-green',
          onclick: openAperturaCajaModal,
          html: `${svg('unlock')} Abrir Caja`
        })
  ));

  // ── Estado actual ─────────────────────────────
  if (cajaOpen && cajaSession) {
    const sesId  = cajaSession.id;
    const tdS    = DB.sales.filter(s =>
      (s.cash_session_id || s.cajaId) === sesId && s.type !== 'devolucion');
    const tdDevs = DB.sales.filter(s => (s.cash_session_id || s.cajaId) === cajaSession.id && s.type === 'devolucion');
    const tdRev  = tdS.reduce((a, s) => a + s.total, 0);
    const tdDev  = tdDevs.reduce((a, s) => a + s.total, 0);
    const tdEfec = tdS.filter(s => (s.payment_method || s.pay) === 'efectivo').reduce((a, s) => a + s.total, 0);
    const tdCard = tdS.filter(s => (s.payment_method || s.pay) === 'tarjeta').reduce((a, s) => a + s.total, 0);
    const tdTrans= tdS.filter(s => (s.payment_method || s.pay) === 'transferencia').reduce((a, s) => a + s.total, 0);
    const tdCred = tdS.filter(s => (s.payment_method || s.pay) === 'credito').reduce((a, s) => a + s.total, 0);
    const tdNet  = tdRev - tdDev;

    const statGrid = h('div', { class: 'metrics', style: { gridTemplateColumns: 'repeat(4,1fr)' } });
    [
      { icon: 'dollar', color: 'g', label: 'Total Vendido',    val: fmt(tdRev) },
      { icon: 'cash',   color: 'b', label: 'Efectivo',         val: fmt(tdEfec) },
      { icon: 'card',   color: 'p', label: 'Tarjeta/Trans.',   val: fmt(tdCard + tdTrans) },
      { icon: 'users',  color: 'a', label: 'Crédito (no cobrado)', val: fmt(tdCred) },
    ].forEach(m => {
      statGrid.appendChild(
        h('div', { class: 'metric' },
          h('div', { class: 'met-top' }, h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })),
          h('div', { class: 'met-label' }, m.label),
          h('div', { class: 'met-val' }, m.val)
        )
      );
    });
    el.appendChild(statGrid);

    // Ventas de sesión
    const sesCard = h('div', { class: 'card mb20' });
    sesCard.appendChild(
      h('div', { class: 'fxb mb8' },
        h('div', { class: 'card-title' }, `Ventas de esta sesión (${tdS.length})`),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => routeTo('ventas'), html: `${svg('list')} Ver historial` })
      )
    );

    if (!tdS.length) {
      sesCard.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, h('p', null, 'Sin ventas en esta sesión')));
    } else {
      const tw = h('div', { class: 'tw' });
      const tbl = h('table', null,
        h('thead', null, h('tr', null, ...['#','Cliente','Artículos','Método','Total'].map(t => h('th', null, t))))
      );
      const tbody = h('tbody', null);
      [...tdS].reverse().slice(0, 10).forEach(s => {
        tbody.appendChild(h('tr', null,
          h('td', { class: 'tm' }, `#${s.id}`),
          h('td', null, h('div', { class: 'tb' }, s.customer_name || s.clientName || 'Consumidor Final')),
          h('td', null, `${s.items.length} art.`),
          h('td', null, h('span', { class: `badge ${s.pay==='efectivo'?'g':s.pay==='tarjeta'?'b':s.pay==='transferencia'?'p':'a'}` }, s.pay)),
          h('td', { style: { fontWeight: 700 } }, fmt(s.total))
        ));
      });
      tbl.appendChild(tbody);
      tw.appendChild(tbl);
      sesCard.appendChild(tw);
    }
    el.appendChild(sesCard);
  }

  // ── Historial ─────────────────────────────────
  const histCard = h('div', { class: 'card' });
  histCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Historial de Sesiones'),
    h('span', { class: 'badge n' }, `${DB.caja.filter(c => c.status === 'closed').length} sesiones`)
  ));

  const closed = DB.caja.filter(c => c.status === 'closed').reverse();
  if (!closed.length) {
    histCard.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, h('p', null, 'Sin sesiones cerradas')));
  } else {
    const tw  = h('div', { class: 'tw' });
    const tbl = h('table', null,
      h('thead', null, h('tr', null,
        ...['Cajero','Apertura','Cierre','Fondo','Ventas','Diferencia',''].map(t => h('th', null, t))
      ))
    );
    const tbody = h('tbody', null);
    closed.forEach(s => {
      const diff = s.diff || 0;
      tbody.appendChild(h('tr', null,
        h('td', null, h('div', { class: 'tb' }, s.cajero)),
        h('td', { class: 'ts' }, `${fdate(s.od)} ${s.ot}`),
        h('td', { class: 'ts' }, `${fdate(s.cd)} ${s.ct}`),
        h('td', null, fmt(s.open)),
        h('td', { style: { fontWeight: 600 } }, fmt(s.total || 0)),
        h('td', null, h('span', { class: `badge ${diff===0?'g':diff>0?'b':'r'}` },
          diff === 0 ? 'Cuadrado' : diff > 0 ? `+${fmt(diff)}` : fmt(diff)
        )),
        h('td', null,
          h('div', { class: 'flex', style: { gap: '4px' } },
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openResumenModal(s), html: `${svg('eye')} Ver` }),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => printResumen(s.id), html: svg('print') })
          )
        )
      ));
    });
    tbl.appendChild(tbody);
    tw.appendChild(tbl);
    histCard.appendChild(tw);
  }
  el.appendChild(histCard);
}

// ══════════════════════════════════════════════
// APERTURA
// ══════════════════════════════════════════════
function openAperturaCajaModal() {
  // ── Detectar sesión huérfana de día anterior ──────────────────────────
  // Si hay una caja 'open' de un día distinto a hoy, ofrecemos cerrarla primero
  const sesionAnterior = DB.caja.find(c => {
    if (c.status !== 'open') return false;
    const fechaSesion = c.open_date || c.od || '';
    const hoy = new Date().toISOString().split('T')[0];
    return fechaSesion && fechaSesion !== hoy;
  });

  if (sesionAnterior) {
    const cajeroAnterior = sesionAnterior.cajero || 'cajero anterior';
    const fechaAnterior  = sesionAnterior.open_date || sesionAnterior.od || 'fecha desconocida';
    openModal(`
      <div class="modal-title">⚠ Caja sin cerrar</div>
      <div class="modal-sub">Se encontró una sesión abierta del día anterior</div>
      <div class="alrt a" style="margin:14px 0">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Sesión de ${cajeroAnterior} — ${fechaAnterior}</div>
          <div class="alrt-sub">Esta sesión nunca fue cerrada. Debes cerrarla antes de abrir una nueva.</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-red" onclick="cerrarSesionHuerfana(${sesionAnterior.id})">
          ${svg('lock')} Cerrar sesión anterior y continuar
        </button>
      </div>
    `);
    return;
  }

  const billRows = DENS.map(d => `
    <div class="bill-row">
      <span class="bill-den">RD$ ${d.toLocaleString()}</span>
      <input class="bill-inp" type="number" min="0" value="0"
             id="open-bill-${d}" oninput="calcOpenTotal()"/>
      <span class="bill-sub" id="open-sub-${d}">RD$ 0</span>
    </div>`).join('');

  openModal(`
    <div class="modal-title">Abrir Caja</div>
    <div class="modal-sub">Ingresa el fondo inicial por denominación</div>
    <div class="bill-grid">${billRows}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;
                padding:10px 0;border-top:1px solid var(--line);margin-top:4px">
      <span style="font-weight:700;font-size:13px">Total Fondo</span>
      <span id="open-total" style="font-weight:800;font-size:18px;color:var(--green)">RD$ 0.00</span>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="confirmarApertura()">
        ${svg('unlock')} Abrir Caja
      </button>
    </div>
  `);
  calcOpenTotal();
}

function calcOpenTotal() {
  let total = 0;
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`open-bill-${d}`)?.value || 0);
    const sub = qty * d;
    total += sub;
    const subEl = document.getElementById(`open-sub-${d}`);
    if (subEl) subEl.textContent = `RD$ ${sub.toLocaleString()}`;
  });
  const totEl = document.getElementById('open-total');
  if (totEl) totEl.textContent = fmt(total);
}

async function confirmarApertura() {
  let fondo = 0;
  const bills = {};
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`open-bill-${d}`)?.value || 0);
    bills[d] = qty;
    fondo += qty * d;
  });

  const result = await window.api.cash.open({
    openAmount: fondo,
    openBills:  bills,
    requestUserId: user.id,
  });

  if (!result.ok) {
    toast(result.error || 'Error al abrir caja', 'err');
    return;
  }

  await chkCaja();
  closeModal();
  toast('✓ Caja abierta');
  renderCaja(document.getElementById('page'));
  buildTopbar();
  buildSidebar();
}

// ══════════════════════════════════════════════
// CIERRE DE SESIÓN HUÉRFANA
// Se llama cuando hay una caja abierta de un día anterior
// ══════════════════════════════════════════════
async function cerrarSesionHuerfana(sessionId) {
  const result = await window.api.cash.close({
    sessionId,
    closeAmount: 0,
    closeBills:  {},
    expected:    0,
    notes:       'Cierre automático — sesión sin cerrar del día anterior',
    requestUserId: user.id,
  });

  if (!result.ok) {
    toast(result.error || 'Error al cerrar sesión anterior', 'err');
    return;
  }

  // Recargar datos y abrir modal de apertura nueva
  await window.api.cash.getSessions().then(sessions => {
    DB.caja = sessions || [];
  });
  await chkCaja();
  closeModal();
  toast('Sesión anterior cerrada — ahora puedes abrir caja', 'ok');
  setTimeout(() => openAperturaCajaModal(), 300);
}

// ══════════════════════════════════════════════
// CIERRE CON CUADRE
// ══════════════════════════════════════════════
function openCierreCajaModal() {
  if (!cajaSession) return;

  const tdS    = DB.sales.filter(s => (s.cash_session_id || s.cajaId) === cajaSession.id && s.type !== 'devolucion' && s.status !== 'cancelled');
  const tdDevs = DB.sales.filter(s => (s.cash_session_id || s.cajaId) === cajaSession.id && s.type === 'devolucion');
  const tdEfec = tdS.filter(s => (s.payment_method || s.pay) === 'efectivo').reduce((a, s) => a + s.total, 0);
  const tdCard = tdS.filter(s => (s.payment_method || s.pay) === 'tarjeta').reduce((a, s) => a + s.total, 0);
  const tdTrans= tdS.filter(s => (s.payment_method || s.pay) === 'transferencia').reduce((a, s) => a + s.total, 0);
  const tdCred = tdS.filter(s => (s.payment_method || s.pay) === 'credito').reduce((a, s) => a + s.total, 0);
  const tdRev  = tdS.reduce((a, s) => a + s.total, 0);

  // Abonos en efectivo recibidos durante esta sesión
  const tdAbonos = DB.payments
    .filter(p => p.cash_session_id === cajaSession.id || !p.cash_session_id)
    .reduce((a, p) => a + (p.amount || 0), 0);

  // Devoluciones que salieron de caja en efectivo
  const tdDevEfec = tdDevs
    .filter(s => (s.payment_method || s.pay) === 'efectivo')
    .reduce((a, s) => a + s.total, 0);

  // Fórmula correcta:
  // Fondo inicial + ventas efectivo + abonos efectivo - devoluciones efectivo
  const expected = (cajaSession.open_amount || cajaSession.open || 0)
    + tdEfec
    + tdAbonos
    - tdDevEfec;

  const billRows = DENS.map(d => `
    <div class="bill-row">
      <span class="bill-den">RD$ ${d.toLocaleString()}</span>
      <input class="bill-inp" type="number" min="0" value="0"
             id="close-bill-${d}" oninput="calcCloseTotal(${expected})"/>
      <span class="bill-sub" id="close-sub-${d}">RD$ 0</span>
    </div>`).join('');

  openModal(`
    <div class="modal-title">Cerrar Caja — Arqueo Final</div>
    <div class="modal-sub">Cuenta el efectivo en caja y confirma el cierre</div>

    <div class="gg2" style="margin-bottom:14px">
      <div class="card" style="background:var(--surface2)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted2);margin-bottom:8px">Resumen del día</div>
        <div class="tr" style="font-size:12px"><span>Fondo inicial</span><span>${fmt(cajaSession.open_amount || cajaSession.open || 0)}</span></div>
        <div class="tr" style="font-size:12px"><span>Ventas efectivo</span><span style="color:var(--green)">+${fmt(tdEfec)}</span></div>
        ${tdAbonos > 0 ? `<div class="tr" style="font-size:12px"><span>Abonos en efectivo</span><span style="color:var(--green)">+${fmt(tdAbonos)}</span></div>` : ''}
        ${tdDevEfec > 0 ? `<div class="tr" style="font-size:12px"><span>Devoluciones efectivo</span><span style="color:var(--red)">−${fmt(tdDevEfec)}</span></div>` : ''}
        <div class="tr" style="font-size:12px;border-top:1px solid var(--line);padding-top:6px"><span>Ventas tarjeta/trans.</span><span>${fmt(tdCard + tdTrans)}</span></div>
        ${tdCred > 0 ? `
        <div class="tr" style="font-size:12px">
          <span>Ventas a crédito <span style="font-size:10px;color:var(--amber);font-weight:600">(no cobrado)</span></span>
          <span style="color:var(--amber)">${fmt(tdCred)}</span>
        </div>` : ''}
        <div class="tr grand" style="margin-top:6px"><span>Total ventas</span><span>${fmt(tdRev)}</span></div>
        ${tdCred > 0 ? `
        <div class="tr" style="font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:5px;margin-top:4px">
          <span>Cobrado en efectivo/tarjeta</span><span style="font-weight:700;color:var(--text)">${fmt(tdRev - tdCred)}</span>
        </div>` : ''}
      </div>
      <div class="card" style="background:var(--blue-bg);border-color:var(--blue-line)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--blue);margin-bottom:8px">Efectivo esperado</div>
        <div style="font-size:24px;font-weight:800;color:var(--blue)">${fmt(expected)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.6">
          Fondo + ventas efectivo${tdAbonos > 0 ? ' + abonos' : ''}${tdDevEfec > 0 ? ' − devoluciones' : ''}
        </div>
      </div>
    </div>

    <div style="font-weight:700;font-size:13px;margin-bottom:10px">Arqueo de billetes en caja</div>
    <div class="bill-grid">${billRows}</div>

    <div style="display:flex;justify-content:space-between;align-items:center;
                padding:10px 0;border-top:1px solid var(--line);margin-top:4px">
      <span style="font-weight:700;font-size:13px">Total contado</span>
      <span id="close-total" style="font-weight:800;font-size:18px">RD$ 0.00</span>
    </div>
    <div id="close-diff" style="text-align:right;font-size:13px;font-weight:700;margin-top:3px"></div>

    <div class="fg mt14">
      <label class="lbl">Observaciones del cierre</label>
      <textarea class="inp" id="close-obs" rows="2" placeholder="Notas, irregularidades..."></textarea>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-out" onclick="imprimirReporteDia()">
        ${svg('print')} Vista previa reporte
      </button>
      <button class="btn btn-red" onclick="confirmarCierre(${expected})">
        ${svg('lock')} Confirmar Cierre
      </button>
    </div>
  `, 'modal-lg');
  calcCloseTotal(expected);
}

function calcCloseTotal(expected) {
  let total = 0;
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`close-bill-${d}`)?.value || 0);
    const sub = qty * d;
    total += sub;
    const subEl = document.getElementById(`close-sub-${d}`);
    if (subEl) subEl.textContent = `RD$ ${sub.toLocaleString()}`;
  });

  const diff   = total - expected;
  const totEl  = document.getElementById('close-total');
  const diffEl = document.getElementById('close-diff');

  if (totEl) {
    totEl.textContent = fmt(total);
    totEl.style.color = diff === 0 ? 'var(--green)' : diff > 0 ? 'var(--blue)' : 'var(--red)';
  }
  if (diffEl) {
    if (diff === 0)    diffEl.innerHTML = `<span style="color:var(--green)">✓ Caja cuadrada</span>`;
    else if (diff > 0) diffEl.innerHTML = `<span style="color:var(--blue)">Sobrante: ${fmt(diff)}</span>`;
    else               diffEl.innerHTML = `<span style="color:var(--red)">Faltante: ${fmt(Math.abs(diff))}</span>`;
  }
}

async function confirmarCierre(expected) {
  if (!cajaSession) return;

  let closeAmt = 0;
  const closeBills = {};
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`close-bill-${d}`)?.value || 0);
    closeBills[d] = qty;
    closeAmt += qty * d;
  });

  const obs  = document.getElementById('close-obs')?.value || '';
  const diff = closeAmt - expected;

  const idx = DB.caja.findIndex(c => c.id === cajaSession.id);
  if (idx !== -1) {
    DB.caja[idx] = {
      ...DB.caja[idx],
      cd: today(), ct: nowt(),
      close: closeAmt, expected, diff,
      status: 'closed', obs, closeBills,
    };
  }

  const sesionCerrada = DB.caja[idx];
  save();
  cajaOpen    = false;
  cajaSession = null;
  closeModal();

  toast('✓ Caja cerrada — Generando reporte...');

  // Imprimir reporte con gastos del día (async)
  await imprimirReporteDia();

  toast('✓ Reporte generado');
  renderCaja(document.getElementById('page'));
  buildTopbar();
  buildSidebar();
}

// ══════════════════════════════════════════════
// REPORTE DEL DÍA (sesión activa)
// ══════════════════════════════════════════════
async function imprimirReporteDia() {
  const ses = cajaSession || DB.caja.filter(c => c.status === 'closed').slice(-1)[0];
  if (!ses) { toast('No hay sesión de caja', 'err'); return; }

  const sesId    = ses.id;
  const ventas   = DB.sales.filter(s =>
    (s.cash_session_id || s.cajaId) === sesId && s.type !== 'devolucion' && s.status !== 'cancelled');
  const devs     = DB.sales.filter(s =>
    (s.cash_session_id || s.cajaId) === sesId && s.type === 'devolucion');
  const abonos   = DB.payments.filter(p =>
    p.cash_session_id === sesId || (!p.cash_session_id));

  const totalEfec  = ventas.filter(s => (s.payment_method||s.pay) === 'efectivo').reduce((a,s) => a+s.total,0);
  const totalCard  = ventas.filter(s => (s.payment_method||s.pay) === 'tarjeta').reduce((a,s) => a+s.total,0);
  const totalTrans = ventas.filter(s => (s.payment_method||s.pay) === 'transferencia').reduce((a,s) => a+s.total,0);
  const totalCred  = ventas.filter(s => (s.payment_method||s.pay) === 'credito').reduce((a,s) => a+s.total,0);
  const totalAbonos     = abonos.reduce((a,p) => a+p.amount,0);
  const totalDevolucion = devs.reduce((a,s) => a+s.total,0);
  const totalVentas     = ventas.reduce((a,s) => a+s.total,0);

  const openAmt  = ses.open_amount || ses.open || 0;
  const expected = openAmt + totalEfec + totalAbonos - totalDevolucion;
  const counted  = ses.close_amount || ses.close || 0;
  const diff     = counted > 0 ? counted - expected : 0;

  // ── Cargar gastos del día si el módulo está activo ──────────────────────────
  let gastosDelDia  = [];
  let totalGastos   = 0;
  let gastosEnvios  = 0;
  const today_      = today();

  if (CFG.module_gastos === '1' && window.api?.expenses) {
    try {
      const gRes = await window.api.expenses.getAll({ date: today_ });
      gastosDelDia = gRes?.ok ? (gRes.data || []) : [];
      totalGastos  = gastosDelDia.reduce((a, g) => a + (g.amount || 0), 0);
    } catch(e) { console.warn('[Caja] gastos:', e.message); }
  }

  // ── Cargar envíos del día como gasto si el módulo está activo ───────────────
  if (CFG.module_envios === '1' && window.api?.deliveries) {
    try {
      const eRes = await window.api.deliveries.getAll({ date: today_, limit: 100 });
      const envios = eRes?.ok ? (eRes.data || []) : [];
      gastosEnvios = envios
        .filter(e => e.status === 'entregado')
        .reduce((a, e) => a + (e.fee || e.tarifa || 0), 0);
      // Agregar envíos a la lista de gastos del día
      envios.filter(e => e.status === 'entregado').forEach(e => {
        gastosDelDia.push({
          category: 'Envíos y Despachos',
          description: `Envío → ${e.address || e.destination || 'Destino'}`,
          amount: e.fee || e.tarifa || 0,
          paid: true,
        });
      });
      totalGastos += gastosEnvios;
    } catch(e) { console.warn('[Caja] envíos:', e.message); }
  }

  printCierreCaja({
    cajero:          ses.cajero,
    openDate:        ses.open_date || ses.od || today(),
    openTime:        ses.open_time || ses.ot || '',
    closeTime:       ses.close_time || ses.ct || nowt(),
    openAmount:      openAmt,
    totalEfec,
    totalCard,
    totalTrans,
    totalCred,
    totalAbonos,
    totalDevolucion,
    expected,
    counted,
    diff,
    salesCount:      ventas.length,
    salesTotal:      totalVentas,
    // Gastos del día
    gastosDelDia,
    totalGastos,
    gastosEnvios,
    gananciaReal:    totalVentas - totalGastos,
  });
}

// ══════════════════════════════════════════════
// MODAL RESUMEN
// ══════════════════════════════════════════════
function openResumenModal(s) {
  const sesVentas = DB.sales.filter(v => v.cajaId === s.id && v.type !== 'devolucion');
  const sesDevs   = DB.sales.filter(v => v.cajaId === s.id && v.type === 'devolucion');
  const byMethod  = {};
  sesVentas.forEach(v => { byMethod[v.pay] = (byMethod[v.pay] || 0) + v.total; });

  const methodRows = Object.entries(byMethod).map(([m, v]) =>
    `<div style="display:flex;justify-content:space-between;padding:5px 0;
                 border-bottom:1px solid var(--line2);font-size:13px">
       <span style="text-transform:capitalize">${m}</span>
       <span style="font-weight:600">${fmt(v)}</span>
     </div>`
  ).join('');

  const billsHtml = s.closeBills
    ? DENS.filter(d => (s.closeBills[d] || 0) > 0).map(d =>
        `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--line2)">
           <span>RD$ ${d.toLocaleString()} × ${s.closeBills[d]}</span>
           <span style="font-family:var(--mono)">${fmt(d * s.closeBills[d])}</span>
         </div>`
      ).join('')
    : '<p style="color:var(--muted2);font-size:12px">Sin detalle de billetes</p>';

  openModal(`
    <div class="modal-title">Resumen de Sesión #${s.id}</div>
    <div class="modal-sub">${s.cajero} · ${fdate(s.od)} ${s.ot} → ${fdate(s.cd || today())} ${s.ct || nowt()}</div>
    <div class="g2" style="margin-bottom:14px">
      <div class="card" style="background:var(--surface2)">
        <div class="met-label">Fondo Inicial</div>
        <div class="met-val">${fmt(s.open)}</div>
      </div>
      <div class="card" style="background:var(--surface2)">
        <div class="met-label">Total Ventas</div>
        <div class="met-val" style="color:var(--green)">${fmt(s.total||0)}</div>
      </div>
    </div>
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <div style="font-weight:700;font-size:12px;margin-bottom:8px">Ventas por método</div>
      ${methodRows || '<p style="color:var(--muted2);font-size:12px">Sin ventas</p>'}
      <div style="display:flex;justify-content:space-between;padding:8px 0 0;font-weight:800;font-size:14px">
        <span>Total</span><span>${fmt(s.total||0)}</span>
      </div>
    </div>
    ${s.closeBills ? `
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <div style="font-weight:700;font-size:12px;margin-bottom:8px">Arqueo de billetes</div>
      ${billsHtml}
      <div style="display:flex;justify-content:space-between;padding:6px 0 0;font-weight:700;font-size:13px">
        <span>Total contado</span><span>${fmt(s.close||0)}</span>
      </div>
    </div>
    ${s.diff !== 0 ? `
    <div class="alrt ${s.diff>0?'b':'r'}">
      <div class="alrt-dot ${s.diff>0?'b':'r'}"></div>
      <div>
        <div class="alrt-title">${s.diff>0?'Sobrante':'Faltante'}: ${fmt(Math.abs(s.diff))}</div>
        ${s.obs?`<div class="alrt-sub">${s.obs}</div>`:''}
      </div>
    </div>` : `
    <div class="alrt g">
      <div class="alrt-dot g"></div>
      <div><div class="alrt-title">Caja cuadrada ✓</div></div>
    </div>`}` : ''}
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-dark" onclick="printResumen(${s.id})">
        ${svg('print')} Imprimir Reporte
      </button>
    </div>
  `, 'modal-lg');
}

// ══════════════════════════════════════════════
// IMPRIMIR REPORTE COMPLETO DEL DÍA
// ══════════════════════════════════════════════
function printResumen(cajaId) {
  // Buscar en DB.caja — campos SQLite
  let s = DB.caja.find(c => c.id === cajaId);
  if (!s) { toast('No se encontró la sesión', 'err'); return; }

  // Normalizar campos SQLite vs legacy
  s = {
    ...s,
    cajero:     s.cajero      || s.user_name || '',
    od:         s.open_date   || s.od  || '',
    ot:         s.open_time   || s.ot  || '',
    cd:         s.close_date  || s.cd  || '',
    ct:         s.close_time  || s.ct  || '',
    open:       s.open_amount || s.open || 0,
    close:      s.close_amount|| s.close || 0,
    expected:   s.expected    || 0,
    diff:       s.difference  || s.diff || 0,
    total:      s.sales_total || s.total || 0,
    openBills:  typeof s.open_bills  === 'string' ? JSON.parse(s.open_bills  || '{}') : (s.openBills  || {}),
    closeBills: typeof s.close_bills === 'string' ? JSON.parse(s.close_bills || '{}') : (s.closeBills || {}),
    obs:        s.notes || s.obs || '',
  };
  if (!s) return;

  const sesVentas = DB.sales.filter(v => v.cajaId === s.id && v.type !== 'devolucion');
  const sesDevs   = DB.sales.filter(v => v.cajaId === s.id && v.type === 'devolucion');
  const byMethod  = {};
  sesVentas.forEach(v => { byMethod[v.pay] = (byMethod[v.pay] || 0) + v.total; });

  const totalVentas = sesVentas.reduce((a, v) => a + v.total, 0);
  const totalDevs   = sesDevs.reduce((a, v) => a + v.total, 0);
  const totalNeto   = totalVentas - totalDevs;
  const efec        = byMethod['efectivo'] || 0;
  const expected    = (s.open || 0) + efec;

  // Tabla de ventas del día
  const ventasRows = sesVentas.map(v =>
    `<tr>
      <td>#${v.id}</td>
      <td>${v.time || '—'}</td>
      <td>${_esc(v.clientName)||'Consumidor Final'}</td>
      <td style="text-transform:capitalize">${_esc(v.pay)}</td>
      <td style="text-align:right">${fmt(v.total)}</td>
    </tr>`
  ).join('');

  // Arqueo de billetes
  const billRows = s.closeBills
    ? DENS.filter(d => (s.closeBills[d] || 0) > 0).map(d =>
        `<tr>
          <td>RD$ ${d.toLocaleString()}</td>
          <td style="text-align:center">${s.closeBills[d]}</td>
          <td style="text-align:right">${fmt(d * s.closeBills[d])}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="3" style="color:#9ca3af">Sin arqueo registrado</td></tr>';

  const diffColor = s.diff === 0 ? '#16A34A' : s.diff > 0 ? '#2563EB' : '#DC2626';
  const diffLabel = s.diff === 0 ? 'CUADRADO ✓' : s.diff > 0 ? `SOBRANTE: ${fmt(s.diff)}` : `FALTANTE: ${fmt(Math.abs(s.diff))}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Reporte de Caja — ${CFG.biz}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:12px; color:#111; padding:24px; }
  .hdr { display:flex; justify-content:space-between; align-items:flex-start;
         border-bottom:2px solid #111; padding-bottom:12px; margin-bottom:16px; }
  .biz { font-size:18px; font-weight:800; color:#16A34A; }
  .biz-sub { font-size:11px; color:#6B7280; margin-top:3px; line-height:1.6; }
  .rep-title { font-size:16px; font-weight:700; text-align:right; }
  .rep-sub { font-size:11px; color:#6B7280; text-align:right; margin-top:3px; line-height:1.6; }
  h3 { font-size:13px; font-weight:700; margin:16px 0 8px;
       border-bottom:1px solid #e5e7eb; padding-bottom:4px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px; }
  .box { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:12px; }
  .box-lbl { font-size:10px; font-weight:700; text-transform:uppercase;
             letter-spacing:.06em; color:#9ca3af; margin-bottom:4px; }
  .box-val { font-size:20px; font-weight:800; }
  table { width:100%; border-collapse:collapse; margin-bottom:12px; }
  th { background:#f3f4f6; padding:7px 10px; text-align:left; font-size:10px;
       font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
  td { padding:7px 10px; border-bottom:1px solid #f3f4f6; }
  .cuadre { background:#f0fdf4; border:2px solid #bbf7d0; border-radius:8px;
             padding:14px; margin:16px 0; text-align:center; }
  .cuadre .val { font-size:22px; font-weight:800; color:${diffColor}; }
  .cuadre .lbl { font-size:12px; color:#6B7280; margin-top:3px; }
  .total-row { font-weight:700; font-size:13px; }
  .foot { margin-top:20px; padding-top:12px; border-top:1px solid #e5e7eb;
          text-align:center; font-size:10px; color:#9ca3af; }
  .no-print { margin-bottom:16px; text-align:right; }
  @media print { .no-print { display:none; } body { padding:12px; } }
</style>
</head>
<body>
  <div class="no-print">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 18px;
             border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;margin-right:6px">
      🖨 Imprimir
    </button>
    <button onclick="window.close()"
      style="background:#f3f4f6;color:#374151;border:none;padding:8px 18px;
             border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">
      Cerrar
    </button>
  </div>

  <div class="hdr">
    <div>
      <div class="biz">${_esc(CFG.biz)}</div>
      <div class="biz-sub">RNC: ${_esc(CFG.rnc)}<br>${_esc(CFG.addr)}<br>Tel: ${_esc(CFG.phone)}</div>
    </div>
    <div>
      <div class="rep-title">REPORTE DE CAJA</div>
      <div class="rep-sub">
        Sesión #${s.id}<br>
        Cajero: ${_esc(s.cajero)}<br>
        ${fdate(s.od)} ${s.ot} → ${fdate(s.cd || today())} ${s.ct || '—'}
      </div>
    </div>
  </div>

  <div class="grid2">
    <div class="box">
      <div class="box-lbl">Fondo Inicial</div>
      <div class="box-val">${fmt(s.open)}</div>
    </div>
    <div class="box">
      <div class="box-lbl">Total Ventas del Día</div>
      <div class="box-val" style="color:#16A34A">${fmt(totalVentas)}</div>
    </div>
    <div class="box">
      <div class="box-lbl">Efectivo Esperado en Caja</div>
      <div class="box-val" style="color:#2563EB">${fmt(expected)}</div>
    </div>
    <div class="box">
      <div class="box-lbl">Total Contado</div>
      <div class="box-val" style="color:${diffColor}">${fmt(s.close || 0)}</div>
    </div>
  </div>

  <h3>Desglose por Método de Pago</h3>
  <table>
    <thead><tr><th>Método</th><th style="text-align:right">Total</th><th style="text-align:right">%</th></tr></thead>
    <tbody>
      ${Object.entries(byMethod).map(([m, v]) => `
        <tr>
          <td style="text-transform:capitalize">${m}</td>
          <td style="text-align:right">${fmt(v)}</td>
          <td style="text-align:right">${totalVentas > 0 ? Math.round((v/totalVentas)*100) : 0}%</td>
        </tr>`).join('')}
      ${sesDevs.length ? `<tr><td style="color:#DC2626">Devoluciones</td>
        <td style="text-align:right;color:#DC2626">−${fmt(totalDevs)}</td><td></td></tr>` : ''}
      <tr class="total-row" style="border-top:2px solid #e5e7eb">
        <td>NETO</td>
        <td style="text-align:right">${fmt(totalNeto)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <h3>Detalle de Ventas (${sesVentas.length})</h3>
  <table>
    <thead><tr><th>#</th><th>Hora</th><th>Cliente</th><th>Método</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>
      ${ventasRows || '<tr><td colspan="5" style="color:#9ca3af;text-align:center">Sin ventas</td></tr>'}
      <tr class="total-row" style="border-top:2px solid #e5e7eb">
        <td colspan="4">TOTAL</td>
        <td style="text-align:right">${fmt(totalVentas)}</td>
      </tr>
    </tbody>
  </table>

  <h3>Arqueo de Billetes</h3>
  <table>
    <thead><tr><th>Denominación</th><th style="text-align:center">Cantidad</th><th style="text-align:right">Subtotal</th></tr></thead>
    <tbody>
      ${billRows}
      <tr class="total-row" style="border-top:2px solid #e5e7eb">
        <td colspan="2">TOTAL CONTADO</td>
        <td style="text-align:right">${fmt(s.close || 0)}</td>
      </tr>
    </tbody>
  </table>

  <div class="cuadre">
    <div class="val">${diffLabel}</div>
    <div class="lbl">Efectivo esperado: ${fmt(expected)} · Contado: ${fmt(s.close || 0)}</div>
    ${s.obs ? `<div style="margin-top:6px;font-size:11px;color:#6B7280">Obs: ${_esc(s.obs)}</div>` : ''}
  </div>

  <!-- Gastos del día — solo si módulo activo -->
  ${CFG.module_gastos === '1' || CFG.module_envios === '1' ? `
  <h3 style="color:#DC2626">Gastos del Día</h3>
  <table id="gastos-table-placeholder">
    <thead><tr>
      <th>Categoría</th><th>Descripción</th>
      <th style="text-align:right">Monto</th>
    </tr></thead>
    <tbody>
      <tr><td colspan="3" style="color:#9ca3af;text-align:center;font-style:italic">
        Cargando gastos del día...
      </td></tr>
    </tbody>
  </table>` : ''}

  <div class="foot">
    ${_esc(CFG.biz)} · RNC: ${_esc(CFG.rnc)} · ${_esc(CFG.phone)} · ${_esc(CFG.addr)}<br>
    Documento generado el ${fdate(today())} ${nowt()}
  </div>
</body></html>`;

  printHTML(html, 'caja');
}