// ══════════════════════════════════════════════
// caja.js — Gestión de Caja
//           · Apertura con fondo inicial
//           · Cierre con cuadre y arqueo
//           · Reporte impreso del día
//           · Historial de sesiones
// ══════════════════════════════════════════════

// Usuario actual (mismo patrón que el resto de módulos). Antes las funciones
// de caja usaban `user` sin definirlo → ReferenceError que rompía el botón
// "Abrir Caja", el cierre y el reporte.
function _cajaUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}

function cajaAwaitAction(operation, timeoutMs = 12000) {
  const testTimeout = Number(window.__VELO_TEST_CASH_TIMEOUT_MS || 0);
  const effectiveTimeout = testTimeout > 0 ? testTimeout : timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CASH_ACTION_TIMEOUT')), effectiveTimeout);
    Promise.resolve(operation).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function cajaTerminalId() {
  return (typeof TERMINAL_ID !== 'undefined' && TERMINAL_ID)
    || (typeof CFG !== 'undefined' && CFG.terminalId) || undefined;
}

let _cajaIncomeState = { sessionId:null, rows:[], loading:false };
// Recibos de egreso de la sesión: pagos de gastos hechos con el efectivo de
// esta caja, se registren desde Caja o desde Gastos.
let _cajaExpenseState = { sessionId:null, rows:[], loading:false };
let _cajaExpenseHistory = {
  loaded:false, loading:false, rows:[], truncated:false,
  totals:{ active:0, cancelled:0 },
  filters:{ from:'', to:'', query:'', includeCancelled:true },
};
function _cajaEsc(value) {
  return String(value == null ? '' : value).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function _cajaUsd(value) {
  return 'US$' + Number(value || 0).toLocaleString('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function _cajaIncomeType(value) {
  return ({ otro_ingreso:'Otro ingreso', aporte_capital:'Aporte de capital', prestamo:'Préstamo recibido', reembolso:'Reembolso / recuperación' })[value] || 'Otro ingreso';
}
// El historial vive aparte de la caja abierta: un recibo sigue siendo un
// documento consultable y reimprimible después de cerrar la sesión.
let _cajaIncomeHistory = {
  loaded:false, loading:false, rows:[], truncated:false,
  totals:{ active:0, cancelled:0 },
  filters:{ from:'', to:'', query:'', includeCancelled:true },
};

function _cajaDefaultHistoryRange() {
  const to = typeof today === 'function' ? today() : new Date().toISOString().slice(0,10);
  return { from:`${String(to).slice(0,7)}-01`, to };
}

function cajaIncomeHistoryInvalidate() {
  _cajaIncomeHistory.loaded = false;
}

function cajaIncomeHistoryCard() {
  if (!_cajaIncomeHistory.filters.from) {
    Object.assign(_cajaIncomeHistory.filters, _cajaDefaultHistoryRange());
  }
  const f = _cajaIncomeHistory.filters;
  const card = h('div', { class:'card mb20', id:'caja-income-history' });
  card.innerHTML = `
    <div class="fxb mb8">
      <div><div class="card-title">Historial de recibos de ingreso</div>
        <div class="ts">Todas las sesiones, abiertas y cerradas. Desde aquí se consulta y se reimprime.</div></div>
    </div>
    <div class="caja-mobile-history-filters" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:13px;margin-bottom:10px">
      <div class="fg"><label class="lbl">Desde</label><input class="inp" id="caja-income-from" type="date" value="${_cajaEsc(f.from)}"/></div>
      <div class="fg"><label class="lbl">Hasta</label><input class="inp" id="caja-income-to" type="date" value="${_cajaEsc(f.to)}"/></div>
      <div class="fg"><label class="lbl">Buscar</label><input class="inp" id="caja-income-query" placeholder="Recibo, persona, concepto o referencia" value="${_cajaEsc(f.query)}"/></div>
      <div class="fg"><label class="lbl">&nbsp;</label>
        <button class="btn btn-dark" style="width:100%" onclick="cajaSearchIncomeHistory()">${svg('search')} Buscar</button></div>
    </div>
    <label class="ts" style="display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:10px">
      <input id="caja-income-cancelled" type="checkbox" ${f.includeCancelled ? 'checked' : ''} onchange="cajaSearchIncomeHistory()"/>
      Incluir recibos anulados
    </label>
    <div id="caja-income-history-body" class="mobile-list-card"></div>`;
  return card;
}

function cajaRenderIncomeHistoryBody() {
  const body = document.getElementById('caja-income-history-body');
  if (!body) return;
  const state = _cajaIncomeHistory;
  if (state.loading) {
    body.innerHTML = `<div class="empty" style="padding:18px"><p>Cargando historial…</p></div>`;
    return;
  }
  if (!state.rows.length) {
    body.innerHTML = `<div class="empty" style="padding:18px"><p>Sin recibos de ingreso en el período seleccionado</p></div>`;
    return;
  }
  const isAdmin = ['admin','superadmin'].includes(_cajaUser()?.role);
  const rows = state.rows.map(r => {
    const cancelled = r.status === 'cancelled';
    return `<tr role="row"${cancelled ? ' style="opacity:.62"' : ''}>
      <td role="cell" class="tm mobile-card-title">${_cajaEsc(r.document_number_fmt || `RIN-${r.id}`)}</td>
      <td role="cell" class="ts" data-label="Fecha">${_cajaEsc(typeof fdate === 'function' ? fdate(String(r.created_at || '').slice(0,10)) : String(r.created_at || '').slice(0,10))}</td>
      <td role="cell" data-label="Recibido de"><div class="tb">${_cajaEsc(r.payer_name)}</div><div class="ts">${_cajaEsc(_cajaIncomeType(r.income_type))}</div></td>
      <td role="cell" data-label="Concepto">${_cajaEsc(r.concept)}</td>
      <td role="cell" data-label="Método"><span class="badge ${r.method === 'efectivo' ? 'g' : 'b'}">${_cajaEsc(r.method)}</span></td>
      <td role="cell" data-label="Monto" style="font-weight:800;color:${cancelled ? 'var(--muted)' : 'var(--green)'}">${cancelled ? '−' : ''}${fmt(r.amount)}
        ${String(r.payment_currency || 'DOP').toUpperCase() === 'USD'
          ? `<div class="ts" style="font-weight:600">${_cajaUsd(r.currency_amount || 0)} · Tasa ${Number(r.exchange_rate || 0).toFixed(2)}</div>`
          : ''}</td>
      <td role="cell" data-label="Estado"><span class="badge ${cancelled ? 'r' : 'g'}">${cancelled ? 'Anulado' : 'Vigente'}</span></td>
      <td role="cell" class="mobile-card-actions"><div class="flex" style="gap:3px">
        <button class="btn btn-ghost btn-sm" title="Ver detalle" onclick="cajaOpenIncomeHistoryDetail(${Number(r.id)})">${svg('eye')}</button>
        <button class="btn btn-ghost btn-sm" title="Reimprimir" onclick="cajaReprintIncomeReceipt(${Number(r.id)})">${svg('print')}</button>
        ${isAdmin && !cancelled ? `<button class="btn btn-ghost btn-sm" title="Modificar" onclick="cajaEditIncomeFromHistory(${Number(r.id)})">${svg('edit')}</button>` : ''}
        ${isAdmin && !cancelled ? `<button class="btn btn-ghost btn-sm" title="Anular" onclick="cajaCancelIncomeFromHistory(${Number(r.id)})">${svg('xmark')}</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
  body.innerHTML = `<div class="tw"><table class="mobile-card-table" role="table">
      <thead role="rowgroup"><tr role="row">${['Recibo','Fecha','Recibido de','Concepto','Método','Monto','Estado',''].map(t =>
        `<th scope="col"${t ? '' : ' aria-label="Acciones"'}>${t}</th>`).join('')}</tr></thead>
      <tbody role="rowgroup">${rows}</tbody>
    </table></div>
    <div class="ts" style="margin-top:9px;display:flex;gap:16px;flex-wrap:wrap">
      <span>Vigentes: <strong style="color:var(--green)">${fmt(state.totals.active || 0)}</strong></span>
      ${state.totals.cancelled ? `<span>Anulados: <strong>${fmt(state.totals.cancelled)}</strong></span>` : ''}
      <span>${state.rows.length} recibo${state.rows.length === 1 ? '' : 's'}</span>
      ${state.truncated ? '<span style="color:var(--red)">Se muestran los más recientes: acota el período para ver el resto.</span>' : ''}
    </div>`;
}

async function cajaSearchIncomeHistory() {
  const state = _cajaIncomeHistory;
  state.filters = {
    from: document.getElementById('caja-income-from')?.value || state.filters.from,
    to: document.getElementById('caja-income-to')?.value || state.filters.to,
    query: document.getElementById('caja-income-query')?.value || '',
    includeCancelled: document.getElementById('caja-income-cancelled')
      ? !!document.getElementById('caja-income-cancelled').checked : state.filters.includeCancelled,
  };
  state.loading = true;
  state.loaded = true;
  cajaRenderIncomeHistoryBody();
  try {
    const result = await window.api.cash.searchIncomeReceipts({
      ...state.filters, requestUserId:_cajaUser()?.id,
    });
    if (!result?.ok) throw new Error(result?.error || 'No se pudo cargar el historial');
    state.rows = result.data?.rows || [];
    state.truncated = !!result.data?.truncated;
    state.totals = result.data?.totals || { active:0, cancelled:0 };
  } catch (error) {
    state.rows = []; state.truncated = false; state.totals = { active:0, cancelled:0 };
    toast(error?.message || 'No se pudo cargar el historial','err');
  }
  state.loading = false;
  cajaRenderIncomeHistoryBody();
}

function cajaIncomeHistoryRow(id) {
  return _cajaIncomeHistory.rows.find(row => Number(row.id) === Number(id)) || null;
}

function cajaReprintIncomeReceipt(id) {
  const receipt = cajaIncomeHistoryRow(id);
  if (!receipt) return toast('Recibo no encontrado','err');
  printIncomeReceipt(receipt);
}

function cajaCancelIncomeFromHistory(id) {
  const receipt = cajaIncomeHistoryRow(id);
  if (!receipt) return toast('Recibo no encontrado','err');
  openCancelIncomeReceiptModal(receipt);
}

function cajaOpenIncomeHistoryDetail(id) {
  const r = cajaIncomeHistoryRow(id);
  if (!r) return toast('Recibo no encontrado','err');
  const cancelled = r.status === 'cancelled';
  const field = (label, value) => `<div><span class="lbl">${label}</span><div class="tb">${_cajaEsc(value || '—')}</div></div>`;
  openModal(`<div class="modal-title">${_cajaEsc(r.document_number_fmt || `RIN-${r.id}`)}</div>
    <div class="modal-sub">${_cajaEsc(_cajaIncomeType(r.income_type))} · ${cancelled ? 'Anulado' : 'Vigente'}</div>
    <div class="alrt ${cancelled ? 'r' : 'g'}" style="margin:12px 0"><div>
      <div class="alrt-title">${cancelled ? 'Recibo anulado' : 'Monto recibido'}: ${fmt(r.amount)}</div>
      <div class="alrt-sub">${cancelled
        ? `Motivo: ${_cajaEsc(r.cancel_reason || 'sin motivo registrado')}`
        : 'Documento interno · No sustituye comprobante fiscal'}</div></div></div>
    <div class="g2" style="gap:11px">
      ${field('Recibido de', r.payer_name)}
      ${field('Cédula / RNC', r.payer_document)}
      ${field('Fecha', typeof fdate === 'function' ? fdate(String(r.created_at || '').slice(0,10)) : r.created_at)}
      ${field('Método', r.method)}
      ${field('Moneda recibida', String(r.payment_currency || 'DOP').toUpperCase() === 'USD'
        ? `${_cajaUsd(r.currency_amount || 0)} · Tasa ${Number(r.exchange_rate || 0).toFixed(2)}`
        : 'Pesos (RD$)')}
      ${field('Cuenta receptora', r.financial_account_name)}
      ${field('Referencia', r.reference)}
      ${field('Registrado por', r.user_name)}
      ${field('Caja', [r.cash_session_cajero, r.cash_session_open_date].filter(Boolean).join(' · '))}
    </div>
    <div class="fg" style="margin-top:12px"><label class="lbl">Concepto</label><div class="tb">${_cajaEsc(r.concept)}</div></div>
    ${r.notes ? `<div class="fg"><label class="lbl">Notas</label><div class="ts">${_cajaEsc(r.notes)}</div></div>` : ''}
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-dark" onclick="cajaReprintIncomeReceipt(${Number(r.id)})">${svg('print')} Reimprimir</button></div>`, 'modal-lg caja-mobile-modal');
}

// Caja leía las ventas de su sesión desde DB.sales, la misma colección que
// pagina Ventas. Quien la cargara de último decidía lo que veía Caja, y el
// resumen de una sesión ya cerrada casi nunca encontraba sus ventas ahí. Ahora
// Caja consulta las suyas y DB.sales queda libre para seguir la página abierta.
let _cajaSessionSales = { sessionId:null, rows:[], loading:false };

async function cajaFetchSessionSales(sessionId) {
  const rows = await window.api.cash.getSessionSales({ sessionId });
  return (rows || []).map(row =>
    typeof normalizeSaleRow === 'function' ? normalizeSaleRow(row) : row);
}

function cajaLoadSessionSales(sessionId, el) {
  if (!sessionId || _cajaSessionSales.loading ||
      Number(_cajaSessionSales.sessionId) === Number(sessionId)) return;
  const requestState = { sessionId:Number(sessionId), rows:[], loading:true };
  _cajaSessionSales = requestState;
  cajaFetchSessionSales(sessionId).then(rows => {
    if (_cajaSessionSales !== requestState) return;
    _cajaSessionSales.rows = rows;
    _cajaSessionSales.loading = false;
    if (document.body.contains(el) && typeof page !== 'undefined' && page === 'caja') {
      veloRepaint(() => renderCaja(el));
    }
  }).catch(() => { if (_cajaSessionSales === requestState) { _cajaSessionSales.loading = false; _cajaSessionSales.sessionId = null; } });
}

let _cajaSessionPayments = { sessionId:null, rows:[], loading:false };

async function cajaFetchSessionPayments(sessionId) {
  const result = await window.api.cash.getSessionPayments({ sessionId });
  if (result && result.ok === false) throw new Error(result.error || 'No se pudieron leer los abonos de la caja');
  return (result && Array.isArray(result.data) ? result.data : (Array.isArray(result) ? result : []));
}

function cajaLoadSessionPayments(sessionId, el) {
  if (!sessionId || _cajaSessionPayments.loading ||
      Number(_cajaSessionPayments.sessionId) === Number(sessionId)) return;
  const requestState = { sessionId:Number(sessionId), rows:[], loading:true };
  _cajaSessionPayments = requestState;
  cajaFetchSessionPayments(sessionId).then(rows => {
    if (_cajaSessionPayments !== requestState) return;
    _cajaSessionPayments.rows = rows;
    _cajaSessionPayments.loading = false;
    if (document.body.contains(el) && typeof page !== 'undefined' && page === 'caja') {
      veloRepaint(() => renderCaja(el));
    }
  }).catch(() => { if (_cajaSessionPayments === requestState) { _cajaSessionPayments.loading = false; _cajaSessionPayments.sessionId = null; } });
}

function cajaPaymentsForSession(sessionId) {
  if (Number(_cajaSessionPayments.sessionId) === Number(sessionId) && !_cajaSessionPayments.loading) {
    return _cajaSessionPayments.rows;
  }
  return (DB.payments || []).filter(row =>
    Number(row.cash_session_id) === Number(sessionId) && !isImportedRecord(row));
}

function cajaInvalidateSessionSales() {
  _cajaSessionSales = { sessionId:null, rows:[], loading:false };
  _cajaSessionPayments = { sessionId:null, rows:[], loading:false };
}

// Mientras llega la consulta propia se usa lo que haya en memoria: nunca peor
// que el comportamiento anterior, y exacto en cuanto responde.
function cajaSalesForSession(sessionId) {
  if (Number(_cajaSessionSales.sessionId) === Number(sessionId) && !_cajaSessionSales.loading) {
    return _cajaSessionSales.rows;
  }
  return (DB.sales || []).filter(row =>
    Number(row.cash_session_id || row.cajaId) === Number(sessionId));
}

function cajaLoadIncomeReceipts(sessionId, el) {
  if (!sessionId || _cajaIncomeState.loading || Number(_cajaIncomeState.sessionId) === Number(sessionId)) return;
  _cajaIncomeState = { sessionId:Number(sessionId), rows:[], loading:true };
  window.api.cash.getIncomeReceipts({ sessionId }).then(result => {
    if (Number(_cajaIncomeState.sessionId) !== Number(sessionId)) return;
    _cajaIncomeState.rows = result?.ok ? (result.data || []) : [];
    _cajaIncomeState.loading = false;
    if (document.body.contains(el) && typeof page !== 'undefined' && page === 'caja') renderCaja(el);
  }).catch(() => { _cajaIncomeState.loading = false; });
}

function cajaLoadExpenseReceipts(sessionId, el) {
  if (!sessionId || !cajaCanIssueExpenseReceipt()) return;
  if (_cajaExpenseState.loading || Number(_cajaExpenseState.sessionId) === Number(sessionId)) return;
  _cajaExpenseState = { sessionId:Number(sessionId), rows:[], loading:true };
  window.api.expenses.getCashReceipts({ sessionId, requestUserId:_cajaUser()?.id }).then(result => {
    if (Number(_cajaExpenseState.sessionId) !== Number(sessionId)) return;
    _cajaExpenseState.rows = result?.ok ? (result.data || []) : [];
    _cajaExpenseState.loading = false;
    if (document.body.contains(el) && typeof page !== 'undefined' && page === 'caja') renderCaja(el);
  }).catch(() => { _cajaExpenseState.loading = false; });
}

// Gastos llama esto al pagar o anular, para que Caja vuelva a consultar.
function cajaExpenseReceiptsInvalidate() {
  _cajaExpenseState = { sessionId:null, rows:[], loading:false };
  _cajaExpenseHistory.loaded = false;
}

// El recibo de egreso registra un gasto pagado: requiere el módulo Gastos y,
// por decisión del negocio, solo lo hace el administrador.
function cajaCanIssueExpenseReceipt() {
  return typeof CFG !== 'undefined' && CFG.module_gastos === '1'
    && ['admin','superadmin'].includes(_cajaUser()?.role);
}

async function cajaOpenWithRecovery(payload) {
  try {
    return await cajaAwaitAction(window.api.cash.open(payload));
  } catch (originalError) {
    try {
      const existing = await cajaAwaitAction(
        window.api.cash.getOpen({ terminalId: payload.terminalId }), 3000
      );
      const sameUser = Number(existing?.user_id) === Number(payload.requestUserId);
      const sameAmount = Math.abs(Number(existing?.open_amount || 0) - Number(payload.openAmount || 0)) < 0.005;
      if (existing && sameUser && sameAmount) {
        return { ok: true, id: existing.id, session: existing, recovered: true };
      }
    } catch {}
    throw originalError;
  }
}

async function cajaCloseWithRecovery(payload) {
  try {
    return await cajaAwaitAction(window.api.cash.close(payload));
  } catch (originalError) {
    try {
      const sessions = await cajaAwaitAction(window.api.cash.getSessions(), 3000);
      const closed = (sessions || []).find(row =>
        Number(row.id) === Number(payload.sessionId) && row.status === 'closed'
      );
      if (closed) return { ok: true, recovered: true, session: closed };
    } catch {}
    throw originalError;
  }
}

function cajaTableHeader(labels) {
  return h('thead', { role: 'rowgroup' },
    h('tr', { role: 'row' }, labels.map(label =>
      h('th', { scope: 'col', 'aria-label': label ? null : 'Acciones' }, label))));
}

function renderCaja(el) {
  el.innerHTML = '';
  const otherOpenSessions = (DB.caja || []).filter(session =>
    session.status === 'open' && Number(session.id) !== Number(cajaSession?.id)
  );
  if (cajaOpen && cajaSession?.id) {
    cajaLoadIncomeReceipts(cajaSession.id, el);
    cajaLoadExpenseReceipts(cajaSession.id, el);
    cajaLoadSessionSales(cajaSession.id, el);
    cajaLoadSessionPayments(cajaSession.id, el);
  }

  // ── Header ───────────────────────────────────
  el.appendChild(h('div', { class: `sec-hdr mobile-module-heading${cajaOpen ? '' : ' caja-mobile-closed'}` },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Caja'),
      h('div', { class: 'sec-sub' },
        cajaOpen
          ? `Abierta por ${cajaSession?.cajero} desde ${fdate(cajaSession?.open_date)} ${cajaSession?.open_time}`
          : otherOpenSessions.length
            ? `Esta terminal está cerrada · ${otherOpenSessions.length === 1 ? 'hay otra caja abierta' : `hay ${otherOpenSessions.length} cajas abiertas`}`
            : 'No hay caja abierta'
      )
    ),
    cajaOpen
      ? h('div', { class: 'flex mobile-module-actions', style: { gap: '8px' } },
          h('button', {
            class: 'btn btn-out',
            onclick: () => imprimirReporteDia(),
            html: `${svg('print')} Reporte del día`
          }),
          h('button', {
            class: 'btn btn-out',
            onclick: () => guardarDocumentoExcel(imprimirReporteDia, 'Reporte-Caja-Diario', 'Reporte de caja'),
            html: `${svg('download')} Excel`
          }),
          h('button', {
            class: 'btn btn-green',
            onclick: openIncomeReceiptModal,
            html: `${svg('plus')} Recibo de ingreso`
          }),
          cajaCanIssueExpenseReceipt() ? h('button', {
            class: 'btn btn-out',
            onclick: openExpenseReceiptModal,
            html: `${svg('dollar')} Recibo de egreso`
          }) : null,
          h('button', {
            class: 'btn btn-red',
            onclick: openCierreCajaModal,
            html: `${svg('lock')} Cerrar Caja`
          })
        )
      : h('button', {
          class: 'btn btn-green caja-mobile-open-button',
          onclick: openAperturaCajaModal,
          html: `${svg('unlock')} Abrir Caja`
      })
  ));

  if (otherOpenSessions.length) {
    const otherCard = h('div', { class: 'card mobile-list-card', style: { borderColor: 'var(--amber-line)', marginBottom: '14px' } });
    otherCard.appendChild(h('div', { class: 'fxb mb8 caja-mobile-list-heading' },
      h('div', null,
        h('div', { class: 'card-title' }, 'Cajas abiertas en otras terminales'),
        h('div', { class: 'ts' }, 'La barra superior muestra por separado el estado de esta terminal.')
      ),
      h('button', {
        class: 'btn btn-out btn-sm',
        onclick: async () => {
          await chkCaja();
          renderCaja(el);
          buildTopbar();
        },
        html: `${svg('refresh')} Actualizar estado`,
      })
    ));
    otherCard.appendChild(h('div', { class: 'alrt a', style: { marginBottom: '10px' } },
      h('div', { class: 'alrt-dot a' }),
      h('div', null,
        h('div', { class: 'alrt-title' }, 'ALL IN ONE permanecerá protegido'),
        h('div', { class: 'alrt-sub' }, 'Cierra estas sesiones desde la terminal correspondiente antes de reemplazar los datos operativos.')
      )
    ));
    const otherWrap = h('div', { class: 'tw' });
    const otherTable = h('table', { class: 'mobile-card-table', role: 'table' },
      cajaTableHeader(['Cajero', 'Apertura', 'Terminal', 'Estado']));
    const otherBody = h('tbody', { role: 'rowgroup' });
    otherOpenSessions.forEach(raw => {
      const session = _normCaja(raw);
      const terminalLabel = raw.terminal_name
        || (raw.terminal_id ? `Terminal ${String(raw.terminal_id).slice(0, 8)}` : 'Terminal anterior');
      otherBody.appendChild(h('tr', { role: 'row' },
        h('td', { role: 'cell', class: 'mobile-card-title' }, h('div', { class: 'tb' }, session.cajero || 'Sin identificar')),
        h('td', { role: 'cell', class: 'ts', 'data-label': 'Apertura' }, `${fdate(session.od)} ${session.ot || ''}`.trim()),
        h('td', { role: 'cell', 'data-label': 'Terminal' }, terminalLabel),
        h('td', { role: 'cell', 'data-label': 'Estado' }, h('span', { class: 'badge a' }, 'Abierta'))
      ));
    });
    otherTable.appendChild(otherBody);
    otherWrap.appendChild(otherTable);
    otherCard.appendChild(otherWrap);
    el.appendChild(otherCard);
  }

  // ── Estado actual ─────────────────────────────
  if (cajaOpen && cajaSession) {
    const sesId  = cajaSession.id;
    const sesSales = cajaSalesForSession(sesId);
    const tdS    = sesSales.filter(s =>
      s.type !== 'devolucion' && s.status !== 'returned' && s.status !== 'cancelled');
    const tdDevs = sesSales.filter(s => s.type === 'devolucion');
    const tdPaymentsAll = cajaPaymentsForSession(sesId).filter(p => !isImportedRecord(p));
    const tdPayments = tdPaymentsAll.filter(
      p => String(p.status || 'active').toLowerCase() !== 'cancelled'
    );
    const tdIncomeReceipts = Number(_cajaIncomeState.sessionId) === Number(sesId) ? _cajaIncomeState.rows : [];
    const tdRev  = tdS.reduce((a, s) => a + s.total, 0);
    const tdDev  = tdDevs.reduce((a, s) => a + s.total, 0);
    const tdEfec = tdS.filter(s => (s.payment_method || s.pay) === 'efectivo').reduce((a, s) => a + s.total, 0)
      + tdPayments.filter(p => (p.method || 'efectivo') === 'efectivo').reduce((a,p)=>a+Number(p.amount||0),0)
      + tdIncomeReceipts.filter(r => r.method === 'efectivo').reduce((a,r)=>a+Number(r.amount||0),0);
    const tdCard = tdS.filter(s => (s.payment_method || s.pay) === 'tarjeta').reduce((a, s) => a + s.total, 0)
      + tdPayments.filter(p => p.method === 'tarjeta').reduce((a,p)=>a+Number(p.amount||0),0)
      + tdIncomeReceipts.filter(r => r.method === 'tarjeta').reduce((a,r)=>a+Number(r.amount||0),0);
    const tdTrans= tdS.filter(s => (s.payment_method || s.pay) === 'transferencia').reduce((a, s) => a + s.total, 0)
      + tdPayments.filter(p => ['transferencia','cheque'].includes(p.method)).reduce((a,p)=>a+Number(p.amount||0),0)
      + tdIncomeReceipts.filter(r => ['transferencia','cheque'].includes(r.method)).reduce((a,r)=>a+Number(r.amount||0),0);
    const tdCred = tdS.filter(s => (s.payment_method || s.pay) === 'credito')
      .reduce((a, s) => a + Number(s.balance_after_payment ?? s.total ?? 0), 0);
    const tdNet  = tdRev - tdDev;

    // Las barras comparan los cobros entre sí. También incluyen abonos e ingresos.
    const receivedByCardAndTransfer = tdCard + tdTrans;
    const largestReceived = Math.max(Math.abs(tdEfec), Math.abs(receivedByCardAndTransfer)) || 1;
    const statGrid = h('div', { class: 'metrics mobile-summary-metrics', style: { gridTemplateColumns: 'repeat(4,1fr)' } });
    [
      { place: 'featured', icon: 'dollar', color: 'g', label: 'Total Vendido', val: tdRev },
      { place: 'bar', icon: 'cash', color: 'b', label: 'Efectivo recibido', val: tdEfec },
      { place: 'bar', icon: 'card', color: 'p', label: 'Tarjeta/Trans. recibidas', val: receivedByCardAndTransfer },
      { place: 'total', icon: 'users', color: 'a', label: 'Crédito pendiente', val: tdCred },
    ].forEach(m => {
      const metric = h('div', { class: `metric mobile-summary-${m.place}` },
        h('div', { class: 'met-top' }, h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })),
        h('div', { class: 'met-label' }, m.label),
        h('div', { class: 'met-val' }, fmt(m.val))
      );
      if (m.place === 'bar') {
        metric.style.setProperty('--mobile-bar-size', `${100 * Math.abs(m.val) / largestReceived}%`);
      }
      statGrid.appendChild(metric);
    });
    el.appendChild(statGrid);

    const fundCard = h('div', { class: 'card mb20' });
    fundCard.innerHTML = `<div class="fxb mb8"><div><div class="card-title">Fondo de apertura</div>
      <div class="ts">Gastos pagados en efectivo desde esta caja. Las ventas se reflejan aparte en el efectivo esperado de cierre.</div></div>
      <button class="btn btn-out btn-sm" type="button" data-fund-refresh>Actualizar</button></div>
      <div class="metrics" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        <div class="metric"><div class="met-label">Fondo inicial</div><div class="met-val" data-fund-opening>…</div></div>
        <div class="metric"><div class="met-label">Gastos desde caja</div><div class="met-val" data-fund-expenses>…</div></div>
        <div class="metric"><div class="met-label">Fondo restante</div><div class="met-val" data-fund-remaining>…</div></div>
      </div>`;
    el.appendChild(fundCard);
    const refreshFund = async () => {
      const result = await window.api.cash.getSessionCashSummary({ sessionId: sesId }).catch(() => null);
      if (!fundCard.isConnected || Number(cajaSession?.id) !== Number(sesId)) return;
      for (const [selector, value] of [
        ['[data-fund-opening]', result?.openAmount],
        ['[data-fund-expenses]', result?.pettyExpenseCash],
        ['[data-fund-remaining]', result?.openingFundRemaining],
      ]) fundCard.querySelector(selector).textContent = Number.isFinite(value) ? fmt(value) : 'No disponible';
    };
    fundCard.querySelector('[data-fund-refresh]').addEventListener('click', refreshFund);
    void refreshFund();

    // Ventas de sesión
    const sesCard = h('div', { class: 'card mb20 mobile-list-card' });
    sesCard.appendChild(
      h('div', { class: 'fxb mb8 caja-mobile-list-heading' },
        h('div', { class: 'card-title' }, `Ventas de esta sesión (${tdS.length})`),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => routeTo('ventas'), html: `${svg('list')} Ver historial` })
      )
    );

    if (!tdS.length) {
      sesCard.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, h('p', null, 'Sin ventas en esta sesión')));
    } else {
      const tw = h('div', { class: 'tw' });
      const tbl = h('table', { class: 'mobile-card-table', role: 'table' },
        cajaTableHeader(['#','Cliente','Artículos','Método','Total','']));
      const tbody = h('tbody', { role: 'rowgroup' });
      [...tdS].reverse().slice(0, 10).forEach(s => {
        tbody.appendChild(h('tr', { role: 'row' },
          h('td', { role: 'cell', class: 'tm mobile-card-title' }, facturaLabel(s)),
          h('td', { role: 'cell', 'data-label': 'Cliente' }, h('div', { class: 'tb' }, s.customer_name || s.clientName || 'Consumidor Final')),
          h('td', { role: 'cell', 'data-label': 'Artículos' }, `${Number(s.item_qty_total || 0)} art.`),
          h('td', { role: 'cell', 'data-label': 'Método' },
            h('span', { class: `badge ${(s.payment_method||s.pay)==='efectivo'?'g':(s.payment_method||s.pay)==='tarjeta'?'b':(s.payment_method||s.pay)==='transferencia'?'p':'a'}` }, s.payment_method||s.pay),
            (s.payment_method||s.pay)==='credito'
              ? h('div',{class:'ts'},`Pagado ${fmt(s.payment_amount||0)} · Pendiente ${fmt(s.balance_after_payment??s.total)}`)
              : null),
          h('td', { role: 'cell', 'data-label': 'Total', style: { fontWeight: 700 } }, fmt(s.total)),
          h('td', { role: 'cell', class: 'mobile-card-actions' },h('div',{class:'flex',style:{gap:'3px'}},
            h('button',{class:'btn btn-ghost btn-sm','aria-label':'Ver venta',onclick:()=>openDetalleVentaModal(s),html:svg('eye')}),
            h('button',{class:'btn btn-ghost btn-sm','aria-label':'Reimprimir venta',onclick:()=>reimprimirVenta(s.id),html:svg('print')})))
        ));
      });
      tbl.appendChild(tbody);
      tw.appendChild(tbl);
      sesCard.appendChild(tw);
    }
    el.appendChild(sesCard);

    // Abonos vigentes de esta sesión, incluidos pagos iniciales de facturas a
    // crédito. Los anulados permanecen auditables desde «Ver historial», pero
    // no deben ocupar la vista operativa de Caja.
    const payCard = h('div', { class: 'card mb20 mobile-list-card' });
    payCard.appendChild(h('div',{class:'fxb mb8 caja-mobile-list-heading'},
      h('div',{class:'card-title'},`Abonos y pagos iniciales (${tdPayments.length})`),
      h('button',{class:'btn btn-ghost btn-sm',onclick:()=>{ window._ventasTabInicial='abonos'; routeTo('ventas'); },html:`${svg('list')} Ver historial`})));
    if (!tdPayments.length) {
      payCard.appendChild(h('div',{class:'empty',style:{padding:'18px'}},h('p',null,'Sin abonos en esta sesión')));
    } else {
      const rows = [...tdPayments].reverse().map(p => {
        return h('tr', { role: 'row' },
          h('td', { role: 'cell', class: 'tm mobile-card-title' }, reciboLabel(p)),
          h('td', { role: 'cell', 'data-label': 'Cliente' },
            h('div', { class: 'tb' }, p.customer_name || DB.customers.find(c => Number(c.id) === Number(p.customer_id))?.name || 'Cliente')),
          h('td', { role: 'cell', class: 'tm', 'data-label': 'Factura' }, paymentInvoiceSummary(p)),
          h('td', { role: 'cell', 'data-label': 'Método' },
            h('span', { class: `badge ${(p.method || '') === 'efectivo' ? 'g' : 'b'}` }, p.method || 'efectivo')),
          h('td', { role: 'cell', 'data-label': 'Estado' }, h('span', { class: 'badge g' }, 'Vigente')),
          h('td', { role: 'cell', 'data-label': 'Monto', style: { fontWeight: 800, color: 'var(--green)' } }, fmt(p.amount)),
          h('td', { role: 'cell', class: 'mobile-card-actions' }, h('div', { class: 'flex', style: { gap: '3px' } },
            h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Ver abono', onclick: () => openAbonoDetalleModal(p), html: svg('eye') }),
            h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Reimprimir abono', onclick: () => reimprimirAbono(p.id), html: svg('print') }))));
      });
      payCard.appendChild(h('div', { class: 'tw' }, h('table', { class: 'mobile-card-table', role: 'table' },
        cajaTableHeader(['Recibo','Cliente','Factura','Método','Estado','Monto','']),
        h('tbody', { role: 'rowgroup' }, ...rows))));
    }
    el.appendChild(payCard);

    const incomeCard = h('div', { class:'card mb20 mobile-list-card' });
    incomeCard.appendChild(h('div',{class:'fxb mb8 caja-mobile-list-heading'},
      h('div',null,h('div',{class:'card-title'},`Recibos de ingreso (${tdIncomeReceipts.length})`),
        h('div',{class:'ts'},'Entradas de dinero no asociadas a ventas ni abonos')),
      h('button',{class:'btn btn-green btn-sm',onclick:openIncomeReceiptModal,html:`${svg('plus')} Nuevo ingreso`})));
    if (_cajaIncomeState.loading) {
      incomeCard.appendChild(h('div',{class:'empty',style:{padding:'18px'}},h('p',null,'Cargando ingresos…')));
    } else if (!tdIncomeReceipts.length) {
      incomeCard.appendChild(h('div',{class:'empty',style:{padding:'18px'}},h('p',null,'Sin recibos de ingreso en esta sesión')));
    } else {
      const rows = tdIncomeReceipts.map(r => h('tr', { role: 'row' },
        h('td', { role: 'cell', class: 'tm mobile-card-title' }, r.document_number_fmt || `RIN-${r.id}`),
        h('td', { role: 'cell', 'data-label': 'Recibido de' },
          h('div', { class: 'tb' }, r.payer_name), h('div', { class: 'ts' }, _cajaIncomeType(r.income_type))),
        h('td', { role: 'cell', 'data-label': 'Concepto' }, r.concept),
        h('td', { role: 'cell', 'data-label': 'Método' }, h('span', { class: `badge ${r.method === 'efectivo' ? 'g' : 'b'}` }, r.method)),
        h('td', { role: 'cell', 'data-label': 'Monto', style: { fontWeight: 800, color: 'var(--green)' } }, fmt(r.amount)),
        h('td', { role: 'cell', class: 'mobile-card-actions' },h('div',{class:'flex',style:{gap:'3px'}},
          h('button',{class:'btn btn-ghost btn-sm','aria-label':'Reimprimir ingreso',onclick:()=>printIncomeReceipt(r),html:svg('print')}),
          ['admin','superadmin'].includes(_cajaUser()?.role) ? h('button',{class:'btn btn-ghost btn-sm',title:'Modificar',onclick:()=>openEditIncomeReceiptModal(r),html:svg('edit')}) : null,
          ['admin','superadmin'].includes(_cajaUser()?.role) ? h('button',{class:'btn btn-ghost btn-sm',title:'Anular',onclick:()=>openCancelIncomeReceiptModal(r),html:svg('xmark')}) : null
        ))));
      incomeCard.appendChild(h('div', { class: 'tw' }, h('table', { class: 'mobile-card-table', role: 'table' },
        cajaTableHeader(['Recibo','Recibido de','Concepto','Método','Monto','']),
        h('tbody', { role: 'rowgroup' }, ...rows))));
    }
    el.appendChild(incomeCard);

    if (cajaCanIssueExpenseReceipt()) {
      const tdExpenseReceipts = Number(_cajaExpenseState.sessionId) === Number(sesId) ? _cajaExpenseState.rows : [];
      const expenseCard = h('div', { class:'card mb20' });
      expenseCard.appendChild(h('div',{class:'fxb mb8'},
        h('div',null,h('div',{class:'card-title'},`Recibos de egreso (${tdExpenseReceipts.length})`),
          h('div',{class:'ts'},'Gastos pagados con el efectivo de esta caja')),
        h('button',{class:'btn btn-out btn-sm',onclick:openExpenseReceiptModal,html:`${svg('dollar')} Nuevo egreso`})));
      if (_cajaExpenseState.loading) {
        expenseCard.appendChild(h('div',{class:'empty',style:{padding:'18px'}},h('p',null,'Cargando egresos…')));
      } else if (!tdExpenseReceipts.length) {
        expenseCard.appendChild(h('div',{class:'empty',style:{padding:'18px'}},h('p',null,'Sin recibos de egreso en esta sesión')));
      } else {
        const rows = tdExpenseReceipts.map(r => h('tr',null,
          h('td',{class:'tm'},r.document_number_fmt || `EGR-${r.id}`),
          h('td',null,h('div',{class:'tb'},r.beneficiary_name || r.supplier_name || '—'),
            h('div',{class:'ts'},r.category_name || 'Sin categoría')),
          h('td',null,r.description || ''),
          h('td',{style:{fontWeight:800,color:'var(--red)'}},`−${fmt(r.amount)}`),
          h('td',null,h('div',{class:'flex',style:{gap:'3px'}},
            h('button',{class:'btn btn-ghost btn-sm',title:'Reimprimir',
              onclick:()=>cajaReprintExpenseReceipt(r),html:svg('print')}),
            cajaExpenseCancellableHere(r, sesId)
              ? h('button',{class:'btn btn-ghost btn-sm',title:'Anular',onclick:()=>openCancelExpenseReceiptModal(r),html:svg('xmark')})
              : h('span',{class:'ts',title:'Este pago es parte de un gasto con otros pagos: anúlalo desde Gastos'},'Desde Gastos')))));
        expenseCard.appendChild(h('div',{class:'tw'},h('table',{class:'mobile-card-table mobile-card-auto'},
          h('thead',null,h('tr',null,...['Recibo','Pagado a','Concepto','Monto',''].map(x=>h('th',null,x)))),h('tbody',null,...rows))));
      }
      el.appendChild(expenseCard);
    }

    // Devoluciones de esta sesión (visibilidad para el cajero) ─────────
    if (tdDevs.length) {
      const devCard = h('div', { class: 'card mb20 mobile-list-card' });
      devCard.appendChild(
        h('div', { class: 'fxb mb8 caja-mobile-list-heading' },
          h('div', { class: 'card-title' }, `Devoluciones de esta sesión (${tdDevs.length})`)
        )
      );
      const dtw = h('div', { class: 'tw' });
      const dtbl = h('table', { class: 'mobile-card-table', role: 'table' },
        cajaTableHeader(['#','Cliente','Factura orig.','Total']));
      const dtbody = h('tbody', { role: 'rowgroup' });
      [...tdDevs].reverse().forEach(s => {
        dtbody.appendChild(h('tr', { role: 'row' },
          h('td', { role: 'cell', class: 'tm mobile-card-title' }, facturaLabel(s)),
          h('td', { role: 'cell', 'data-label': 'Cliente' }, h('div', { class: 'tb' }, s.customer_name || s.clientName || 'Consumidor Final')),
          h('td', { role: 'cell', class: 'tm', 'data-label': 'Factura original' }, s.original_sale_id ? facturaLabelOriginal(s) : '—'),
          h('td', { role: 'cell', 'data-label': 'Total', style: { fontWeight: 700, color: 'var(--red)' } }, `−${fmt(s.total)}`)
        ));
      });
      dtbl.appendChild(dtbody);
      dtw.appendChild(dtbl);
      devCard.appendChild(dtw);
      el.appendChild(devCard);
    }
  }

  // ── Historial de recibos de ingreso ───────────
  el.appendChild(cajaIncomeHistoryCard());
  if (!_cajaIncomeHistory.loaded) cajaSearchIncomeHistory();
  else cajaRenderIncomeHistoryBody();

  // ── Historial de recibos de egreso ────────────
  if (cajaCanIssueExpenseReceipt()) {
    el.appendChild(cajaExpenseHistoryCard());
    if (!_cajaExpenseHistory.loaded) cajaSearchExpenseHistory();
    else cajaRenderExpenseHistoryBody();
  }

  // ── Historial ─────────────────────────────────
  const histCard = h('div', { class: 'card mobile-list-card' });
  histCard.appendChild(h('div', { class: 'fxb mb8 caja-mobile-list-heading' },
    h('div', { class: 'card-title' }, 'Historial de Sesiones'),
    h('span', { class: 'badge n' }, `${DB.caja.filter(c => c.status === 'closed').length} sesiones`)
  ));

  const closed = DB.caja.filter(c => c.status === 'closed').reverse();
  if (!closed.length) {
    histCard.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, h('p', null, 'Sin sesiones cerradas')));
  } else {
    const tw  = h('div', { class: 'tw' });
    const tbl = h('table', { class: 'mobile-card-table', role: 'table' },
      cajaTableHeader(['Cajero','Apertura','Cierre','Fondo','Ventas','Diferencia','']));
    const tbody = h('tbody', { role: 'rowgroup' });
    closed.forEach(raw => {
      const s    = _normCaja(raw);
      const diff = s.diff || 0;
      tbody.appendChild(h('tr', { role: 'row' },
        h('td', { role: 'cell', class: 'mobile-card-title' }, h('div', { class: 'tb' }, s.cajero)),
        h('td', { role: 'cell', class: 'ts', 'data-label': 'Apertura' }, `${fdate(s.od)} ${s.ot}`),
        h('td', { role: 'cell', class: 'ts', 'data-label': 'Cierre' }, `${fdate(s.cd)} ${s.ct}`),
        h('td', { role: 'cell', 'data-label': 'Fondo' }, fmt(s.open)),
        h('td', { role: 'cell', 'data-label': 'Ventas', style: { fontWeight: 600 } }, fmt(s.total || 0)),
        h('td', { role: 'cell', 'data-label': 'Diferencia' }, h('span', { class: `badge ${diff===0?'g':diff>0?'b':'r'}` },
          diff === 0 ? 'Cuadrado' : diff > 0 ? `+${fmt(diff)}` : fmt(diff)
        )),
        h('td', { role: 'cell', class: 'mobile-card-actions' },
          h('div', { class: 'flex', style: { gap: '4px' } },
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openResumenModal(s), html: `${svg('eye')} Ver` }),
            h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Imprimir resumen', onclick: () => printResumen(s.id), html: svg('print') })
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

async function openIncomeReceiptModal() {
  if (!cajaOpen || !cajaSession?.id) { toast('Abre la caja antes de registrar un ingreso','w'); return; }
  let accounts = [];
  try {
    const result = await window.api.financial.getAll();
    accounts = (result?.ok ? result.data : []).filter(a => a.active && ['banco','tarjeta'].includes(a.type));
  } catch {}
  openModal(`<div class="modal-title">Nuevo recibo de ingreso</div><div class="modal-sub">Registra dinero recibido fuera de una venta o abono de cliente.</div>
    <div class="g2"><div class="fg" style="position:relative"><label class="lbl">Recibido de *</label>
      <input class="inp" id="cash-income-payer" autocomplete="off" placeholder="Escribe y elige un cliente, o un nombre nuevo"
             oninput="cajaIncomeFilterPayer(this.value)"
             onblur="setTimeout(() => document.getElementById('cash-income-payer-dd')?.classList.remove('show'), 180)"/>
      <input type="hidden" id="cash-income-customer"/>
      <div id="cash-income-payer-dd" class="cli-dropdown"></div>
      <div class="ts" id="cash-income-payer-hint" style="margin-top:4px">&nbsp;</div>
    </div><div class="fg"><label class="lbl">Cédula / RNC</label><input class="inp" id="cash-income-document" placeholder="Opcional"/></div></div>
    <div class="fg"><label class="lbl">Concepto *</label><input class="inp" id="cash-income-concept" placeholder="Motivo por el que se recibe el dinero"/></div>
    <div class="g2"><div class="fg"><label class="lbl">Tipo de ingreso</label><select class="inp" id="cash-income-type"><option value="otro_ingreso">Otro ingreso</option><option value="aporte_capital">Aporte de capital</option><option value="prestamo">Préstamo recibido</option><option value="reembolso">Reembolso / recuperación</option></select></div>${cajaIncomeCurrencySelect('cash-income')}</div>
    ${cajaIncomeCurrencyFields('cash-income')}
    <div class="g2"><div class="fg"><label class="lbl">Método</label><select class="inp" id="cash-income-method" onchange="cajaIncomeMethodChanged()"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option><option value="cheque">Cheque</option></select></div><div class="fg" id="cash-income-account-wrap" style="display:none"><label class="lbl">Cuenta receptora *</label><select class="inp" id="cash-income-account"><option value="">Seleccionar cuenta…</option>${accounts.map(a=>`<option value="${a.id}">${_cajaEsc(a.name)}${a.account_number?` · ${_cajaEsc(a.account_number)}`:''}</option>`).join('')}</select></div></div>
    <div class="fg"><label class="lbl">Referencia</label><input class="inp" id="cash-income-reference" placeholder="Transferencia, cheque o referencia interna"/></div>
    <div class="fg"><label class="lbl">Notas para el recibo</label><textarea class="inp" id="cash-income-notes" rows="3" placeholder="Opcional"></textarea></div>
    <div class="ven-callout">El efectivo aumenta el cuadre de esta caja. Transferencias, tarjetas y cheques aumentan la cuenta financiera seleccionada.</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" id="cash-income-save" onclick="confirmIncomeReceipt()">${svg('check')} Registrar e imprimir</button></div>`, 'modal-lg caja-mobile-modal');
}

// La tasa se propone desde la del día que ya muestra la barra superior y queda
// editable: el recibo debe registrar la tasa realmente acordada.
function cajaCurrentUsdRate() {
  const rate = Number((typeof _ratesData !== 'undefined' && _ratesData?.usd?.venta?.value) || 0);
  return rate > 0 ? Math.round(rate * 100) / 100 : 0;
}

function cajaIncomeCurrencyFields(prefix, current = {}) {
  const currency = String(current.payment_currency || 'DOP').toUpperCase();
  const rate = Number(current.exchange_rate || 0);
  const amount = Number(current.currency_amount || current.amount || 0);
  return `<div class="g2">
      <div class="fg"><label class="lbl" id="${prefix}-amount-label">Monto (${currency === 'USD' ? 'US$' : 'RD$'}) *</label>
        <input class="inp" id="${prefix}-amount" type="number" min="0.01" step="0.01"
          value="${amount > 0 ? amount : ''}" oninput="cajaIncomeRecalcEquivalent('${prefix}')"/></div>
      <div class="fg" id="${prefix}-rate-wrap" style="display:${currency === 'USD' ? '' : 'none'}">
        <label class="lbl">Tasa aplicada *</label>
        <input class="inp" id="${prefix}-rate" type="number" min="20" max="500" step="0.01"
          value="${currency === 'USD' && rate > 0 ? rate.toFixed(2) : ''}" placeholder="Tasa del día"
          oninput="cajaIncomeRecalcEquivalent('${prefix}')"/></div>
    </div>
    <div class="ts" id="${prefix}-equivalent" style="margin:-3px 0 10px"></div>`;
}

function cajaIncomeCurrencySelect(prefix, current = 'DOP') {
  const currency = String(current || 'DOP').toUpperCase();
  return `<div class="fg"><label class="lbl">Moneda recibida</label>
    <select class="inp" id="${prefix}-currency" onchange="cajaIncomeCurrencyChanged('${prefix}')">
      <option value="DOP"${currency === 'DOP' ? ' selected' : ''}>Pesos (RD$)</option>
      <option value="USD"${currency === 'USD' ? ' selected' : ''}>Dólares (US$)</option>
    </select></div>`;
}

function cajaIncomeCurrencyChanged(prefix) {
  const currency = document.getElementById(`${prefix}-currency`)?.value || 'DOP';
  const wrap = document.getElementById(`${prefix}-rate-wrap`);
  const label = document.getElementById(`${prefix}-amount-label`);
  const rateInput = document.getElementById(`${prefix}-rate`);
  if (wrap) wrap.style.display = currency === 'USD' ? '' : 'none';
  if (label) label.textContent = currency === 'USD' ? 'Monto (US$) *' : 'Monto (RD$) *';
  if (currency === 'USD' && rateInput && !Number(rateInput.value)) {
    const cached = cajaCurrentUsdRate();
    if (cached > 0) rateInput.value = cached.toFixed(2);
    else {
      window.api?.banner?.getRates?.().then(result => {
        const live = Number(result?.data?.usd?.venta?.value || 0);
        const input = document.getElementById(`${prefix}-rate`);
        if (live > 0 && input && !Number(input.value)) {
          input.value = live.toFixed(2);
          cajaIncomeRecalcEquivalent(prefix);
        }
      }).catch(() => {});
    }
  }
  cajaIncomeRecalcEquivalent(prefix);
}

function cajaIncomeRecalcEquivalent(prefix) {
  const target = document.getElementById(`${prefix}-equivalent`);
  if (!target) return;
  const currency = document.getElementById(`${prefix}-currency`)?.value || 'DOP';
  if (currency !== 'USD') { target.textContent = ''; return; }
  const amount = Number(document.getElementById(`${prefix}-amount`)?.value) || 0;
  const rate = Number(document.getElementById(`${prefix}-rate`)?.value) || 0;
  target.innerHTML = amount > 0 && rate > 0
    ? `Equivalente en pesos: <strong>${fmt(Math.round(amount * rate * 100) / 100)}</strong> · Tasa ${rate.toFixed(2)}`
    : 'Indica el monto en dólares y la tasa aplicada.';
}

function cajaIncomeMethodChanged() {
  const method = document.getElementById('cash-income-method')?.value || 'efectivo';
  const wrap = document.getElementById('cash-income-account-wrap');
  if (wrap) wrap.style.display = method === 'efectivo' ? 'none' : '';
}

async function confirmIncomeReceipt() {
  const actor = _cajaUser();
  const button = document.getElementById('cash-income-save');
  if (button) button.disabled = true;
  const data = {
    cash_session_id:cajaSession?.id,
    payer_name:document.getElementById('cash-income-payer')?.value,
    payer_document:document.getElementById('cash-income-document')?.value,
    customer_id:Number(document.getElementById('cash-income-customer')?.value) || null,
    concept:document.getElementById('cash-income-concept')?.value,
    income_type:document.getElementById('cash-income-type')?.value,
    amount:document.getElementById('cash-income-amount')?.value,
    payment_currency:document.getElementById('cash-income-currency')?.value || 'DOP',
    exchange_rate:document.getElementById('cash-income-rate')?.value || 1,
    method:document.getElementById('cash-income-method')?.value,
    financial_account_id:document.getElementById('cash-income-account')?.value || null,
    reference:document.getElementById('cash-income-reference')?.value,
    notes:document.getElementById('cash-income-notes')?.value,
  };
  try {
    const result = await window.api.cash.createIncomeReceipt({ data, requestUserId:actor?.id });
    if (!result?.ok) { toast(result?.error || 'No se pudo registrar el ingreso','err'); if(button)button.disabled=false; return; }
    closeModal();
    _cajaIncomeState.sessionId = Number(cajaSession.id);
    _cajaIncomeState.rows = [result.data, ..._cajaIncomeState.rows.filter(r=>Number(r.id)!==Number(result.data.id))];
    cajaIncomeHistoryInvalidate();
    cajaInvalidateSessionSales();
    toast(`✓ Ingreso registrado · ${result.data.document_number_fmt}`);
    printIncomeReceipt(result.data);
    veloRepaint(() => renderCaja(document.getElementById('page')));
  } catch (e) {
    toast(e?.message || 'No se pudo registrar el ingreso','err');
    if (button) button.disabled = false;
  }
}

// El recibo de ingreso usa la plantilla elegida en el Centro de impresión:
// carta profesional, carta compacta o térmica de 80 mm. Sin selección explícita
// conserva el diseño de carta que ya usaban los negocios.
function _cajaIncomeReceiptSettings(override = null) {
  const route = typeof _getCategoryConfig === 'function' ? _getCategoryConfig('ingreso') : {};
  const selected = override || {};
  const options = { ...(route.options || {}), ...(selected.options || {}) };
  return {
    template: selected.template || route.template || 'ingreso_carta_profesional',
    showLogo: options.showLogo !== false,
    showBusinessDetails: options.showBusinessDetails !== false,
    showNotes: options.showNotes !== false,
    showSignatures: options.showSignatures !== false,
  };
}

function buildIncomeReceiptHTML(receipt, override = null) {
  const settings = _cajaIncomeReceiptSettings(override);
  const thermal = settings.template === 'ingreso_termica_80';
  const compact = settings.template === 'ingreso_carta_compacta';
  const logo = settings.showLogo && typeof buildLogoHeader === 'function'
    ? buildLogoHeader(CFG.biz_logo, CFG.biz_logo_2, {
        unit: 'px', maxH: thermal ? 40 : 62, maxW: thermal ? 150 : 190, align: 'left',
      })
    : '';
  const date = String(receipt.created_at || today()).slice(0, 10);
  const pageRule = thermal ? 'size:80mm auto;margin:4mm'
    : compact ? 'size:letter;margin:10mm' : 'size:letter;margin:16mm';
  const bodySize = thermal ? '10px' : compact ? '11px' : '12px';
  const pageMin = thermal ? '0' : compact ? '120mm' : '240mm';
  const isUsd = String(receipt.payment_currency || 'DOP').toUpperCase() === 'USD';
  const rate = Number(receipt.exchange_rate || 0);
  const currencyAmount = Number(receipt.currency_amount || receipt.amount || 0);
  // El recibo presenta la tasa como un dato más del cobro. Nunca indica si se
  // ajustó respecto a la referencia del día: solo su número.
  const amountBlock = isUsd
    ? `<div class="amount"><span>Monto recibido</span><strong>${_cajaUsd(currencyAmount)}</strong>
        <div class="fx">Tasa ${rate.toFixed(2)} · Equivalente ${fmt(receipt.amount)}</div></div>`
    : `<div class="amount"><span>Monto recibido</span><strong>${fmt(receipt.amount)}</strong></div>`;
  const businessBlock = settings.showBusinessDetails
    ? `<h1>${_cajaEsc(CFG.biz || 'VELO POS')}</h1><div class="muted">${_cajaEsc([CFG.rnc && `RNC ${CFG.rnc}`, CFG.phone, CFG.addr].filter(Boolean).join(' · '))}</div>`
    : '';
  const notesBlock = settings.showNotes && receipt.notes
    ? `<div class="note"><strong>Notas</strong><br>${_cajaEsc(receipt.notes)}</div>` : '';
  const signaturesBlock = settings.showSignatures
    ? `<div class="signatures"><div class="sign">Entregado por<br><span class="muted">${_cajaEsc(receipt.payer_name)}</span></div><div class="sign">Recibido por<br><span class="muted">${_cajaEsc(receipt.user_name || '')}</span></div></div>`
    : '';
  const style = `@page{${pageRule}}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;margin:0;font-size:${bodySize};${thermal ? 'width:72mm;' : ''}}`
    + `.page{min-height:${pageMin};position:relative}`
    + `.head{display:flex;justify-content:space-between;gap:${thermal ? '8px' : '24px'};border-bottom:${thermal ? '2px' : '3px'} solid #0f766e;padding-bottom:${thermal ? '7px' : '13px'}}`
    + `.brand h1{font-size:${thermal ? '14px' : '20px'};margin:5px 0}.brand img{max-width:${thermal ? '42mm' : '190px'} !important;max-height:${thermal ? '16mm' : '62px'} !important}`
    + `.muted{color:#64748b}.doc{text-align:right}.doc strong{display:block;color:#0f766e;font-size:${thermal ? '11px' : '18px'}}`
    + `.title{text-align:center;font-size:${thermal ? '12px' : compact ? '17px' : '19px'};margin:${thermal ? '12px 0 10px' : compact ? '18px 0 14px' : '28px 0 20px'}}`
    + `.grid{display:grid;grid-template-columns:${thermal ? '1fr' : '1fr 1fr'};gap:${thermal ? '5px' : '10px 28px'};background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:${thermal ? '8px' : '15px'}}`
    + `.amount{margin:${thermal ? '12px 0' : '22px 0'};padding:${thermal ? '10px' : '18px'};border:2px solid #0f766e;border-radius:10px;text-align:center}`
    + `.amount span{display:block;color:#64748b;text-transform:uppercase;font-size:${thermal ? '9px' : '10px'}}.amount strong{display:block;font-size:${thermal ? '18px' : '28px'};color:#0f766e;margin-top:5px}`
    + `.amount .fx{margin-top:5px;color:#334155;font-size:${thermal ? '9px' : '11px'}}`
    + `.concept{padding:${thermal ? '9px' : '14px'};border-left:4px solid #0f766e;background:#f8fafc;white-space:pre-wrap}`
    + `.note{margin-top:${thermal ? '9px' : '14px'};padding:${thermal ? '9px' : '12px'};border:1px solid #e2e8f0;white-space:pre-wrap}`
    + `.signatures{display:grid;grid-template-columns:${thermal ? '1fr' : '1fr 1fr'};gap:${thermal ? '26px' : '70px'};margin-top:${thermal ? '34px' : compact ? '45px' : '75px'}}`
    + `.sign{border-top:1px solid #334155;text-align:center;padding-top:7px}`
    + `.foot{${thermal ? 'margin-top:16px' : 'position:absolute;bottom:0;left:0;right:0'};border-top:1px solid #cbd5e1;padding-top:8px;color:#64748b;font-size:${thermal ? '8px' : '10px'};display:flex;justify-content:space-between;gap:8px}`;
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${_cajaEsc(receipt.document_number_fmt || 'Recibo de ingreso')}</title><style>${style}</style></head><body><section class="page">`
    + `<header class="head"><div class="brand">${logo}${businessBlock}</div><div class="doc"><strong>RECIBO DE INGRESO</strong><span>${_cajaEsc(receipt.document_number_fmt || '')}</span></div></header>`
    + `<h2 class="title">Constancia de dinero recibido</h2>`
    + `<div class="grid"><div><span class="muted">Recibido de</span><br><strong>${_cajaEsc(receipt.payer_name)}</strong></div>`
    + `<div><span class="muted">Cédula / RNC</span><br><strong>${_cajaEsc(receipt.payer_document || '—')}</strong></div>`
    + `<div><span class="muted">Fecha</span><br><strong>${_cajaEsc(typeof fdate === 'function' ? fdate(date) : date)}</strong></div>`
    + `<div><span class="muted">Método</span><br><strong>${_cajaEsc(receipt.method || 'efectivo')}</strong></div>`
    + `<div><span class="muted">Tipo</span><br><strong>${_cajaEsc(_cajaIncomeType(receipt.income_type))}</strong></div>`
    + `<div><span class="muted">Referencia</span><br><strong>${_cajaEsc(receipt.reference || '—')}</strong></div></div>`
    + amountBlock
    + `<div class="concept"><strong>Concepto</strong><br>${_cajaEsc(receipt.concept)}</div>${notesBlock}${signaturesBlock}`
    + `<footer class="foot"><span>${_cajaEsc(CFG.biz || '')}</span><span>Documento interno · No sustituye comprobante fiscal</span></footer>`
    + `</section></body></html>`;
}

function printIncomeReceipt(receipt, override = null) {
  if (!receipt) return;
  printHTML(buildIncomeReceiptHTML(receipt, override), 'recibo_ingreso');
}

// Vista previa del Centro de impresión: datos de ejemplo, nunca un ingreso real.
function cajaPreviewIncomeReceipt(settings = null) {
  const sample = {
    document_number_fmt: 'RIN-000123',
    payer_name: 'PERSONA O EMPRESA DE EJEMPLO',
    payer_document: '001-0000000-1',
    created_at: today(),
    method: 'efectivo',
    income_type: 'otro_ingreso',
    reference: 'REF-EJEMPLO',
    amount: 15000,
    concept: 'Ejemplo de dinero recibido fuera de una venta o abono.',
    notes: 'Nota editable al registrar el ingreso.',
    user_name: (typeof user !== 'undefined' && user?.name) || 'Administrador',
  };
  const html = buildIncomeReceiptHTML(sample, settings);
  if (typeof _openPrintPreview === 'function') {
    _openPrintPreview(html, {
      jobType: 'recibo_ingreso', mode: 'print', source: 'html',
      suggestedName: 'Recibo-ingreso-ejemplo',
    });
    return;
  }
  printHTML(html, 'recibo_ingreso');
}

// ══════════════════════════════════════════════
// RECIBO DE EGRESO
// ══════════════════════════════════════════════
// Constancia del dinero que sale para pagar un gasto. Es el espejo del recibo
// de ingreso y lo usan Caja y Gastos (printPagoProveedor en print.js).
const _CAJA_EXPENSE_TEMPLATES = ['egreso_carta_profesional','egreso_carta_compacta','egreso_termica_80','egreso_ticket_pos'];

// Sin plantilla elegida se respeta el papel que ya usaba el negocio para estos
// recibos (la plantilla de Facturas y ventas): carta sigue en carta, 72/80 mm
// pasa a la térmica de 80 mm y 58 mm conserva el formato anterior, que sí
// cabe en ese rollo.
function cajaExpenseReceiptTemplate(override = null) {
  const route = typeof _getCategoryConfig === 'function' ? _getCategoryConfig('egreso') : {};
  const chosen = (override && override.template) || route.template || '';
  if (_CAJA_EXPENSE_TEMPLATES.includes(chosen)) return chosen;
  const ticket = (typeof _getCategoryConfig === 'function' ? _getCategoryConfig('ticket').template : '')
    || (typeof DB !== 'undefined' && DB?.settings?.print_template) || 'termica_80_clasica';
  if (String(ticket).startsWith('carta')) return 'egreso_carta_profesional';
  if (String(ticket).startsWith('termica_58')) return 'egreso_ticket_pos';
  return 'egreso_termica_80';
}

function _cajaExpenseReceiptSettings(override = null) {
  const route = typeof _getCategoryConfig === 'function' ? _getCategoryConfig('egreso') : {};
  const selected = override || {};
  const options = { ...(route.options || {}), ...(selected.options || {}) };
  return {
    template: cajaExpenseReceiptTemplate(override),
    showLogo: options.showLogo !== false,
    showBusinessDetails: options.showBusinessDetails !== false,
    showNotes: options.showNotes !== false,
    showSignatures: options.showSignatures !== false,
  };
}

function _cajaExpenseMethod(value) {
  return ({ efectivo:'Efectivo', transferencia:'Transferencia', tarjeta:'Tarjeta', cheque:'Cheque' })[value] || (value || 'Efectivo');
}

function buildExpenseReceiptHTML(receipt, override = null) {
  const settings = _cajaExpenseReceiptSettings(override);
  const thermal = settings.template === 'egreso_termica_80';
  const compact = settings.template === 'egreso_carta_compacta';
  const accent = '#b42318';
  const logo = settings.showLogo && typeof buildLogoHeader === 'function'
    ? buildLogoHeader(CFG.biz_logo, CFG.biz_logo_2, {
        unit: 'px', maxH: thermal ? 40 : 62, maxW: thermal ? 150 : 190, align: 'left',
      })
    : '';
  const date = String(receipt.created_at || today()).slice(0, 10);
  const pageRule = thermal ? 'size:80mm auto;margin:4mm'
    : compact ? 'size:letter;margin:10mm' : 'size:letter;margin:16mm';
  const bodySize = thermal ? '10px' : compact ? '11px' : '12px';
  const pageMin = thermal ? '0' : compact ? '120mm' : '240mm';
  const amount = Number(receipt.amount || 0);
  const expenseTotal = Number(receipt.expense_total || amount);
  const balanceAfter = Number(receipt.balance_after || 0);
  // Un pago parcial lo dice en el recibo: quien firma sabe que queda saldo.
  const partialBlock = balanceAfter > 0.009
    ? `<div class="fx">Total del gasto ${fmt(expenseTotal)} · Saldo pendiente ${fmt(balanceAfter)}</div>` : '';
  const businessBlock = settings.showBusinessDetails
    ? `<h1>${_cajaEsc(CFG.biz || 'VELO POS')}</h1><div class="muted">${_cajaEsc([CFG.rnc && `RNC ${CFG.rnc}`, CFG.phone, CFG.addr].filter(Boolean).join(' · '))}</div>`
    : '';
  const notesBlock = settings.showNotes && receipt.notes
    ? `<div class="note"><strong>Notas</strong><br>${_cajaEsc(receipt.notes)}</div>` : '';
  const signaturesBlock = settings.showSignatures
    ? `<div class="signatures"><div class="sign">Entregado por<br><span class="muted">${_cajaEsc(receipt.user_name || '')}</span></div><div class="sign">Recibido por<br><span class="muted">${_cajaEsc(receipt.paid_to_name || '')}${receipt.paid_to_document ? ` · ${_cajaEsc(receipt.paid_to_document)}` : ''}</span></div></div>`
    : '';
  const reference = [receipt.reference, receipt.invoice_number && `Factura ${receipt.invoice_number}`].filter(Boolean).join(' · ');
  const style = `@page{${pageRule}}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;margin:0;font-size:${bodySize};${thermal ? 'width:72mm;' : ''}}`
    + `.page{min-height:${pageMin};position:relative}`
    + `.head{display:flex;justify-content:space-between;gap:${thermal ? '8px' : '24px'};border-bottom:${thermal ? '2px' : '3px'} solid ${accent};padding-bottom:${thermal ? '7px' : '13px'}}`
    + `.brand h1{font-size:${thermal ? '14px' : '20px'};margin:5px 0}.brand img{max-width:${thermal ? '42mm' : '190px'} !important;max-height:${thermal ? '16mm' : '62px'} !important}`
    + `.muted{color:#64748b}.doc{text-align:right}.doc strong{display:block;color:${accent};font-size:${thermal ? '11px' : '18px'}}.doc em{display:block;font-style:normal;color:#64748b;font-size:${thermal ? '8px' : '10px'};margin-top:3px}`
    + `.title{text-align:center;font-size:${thermal ? '12px' : compact ? '17px' : '19px'};margin:${thermal ? '12px 0 10px' : compact ? '18px 0 14px' : '28px 0 20px'}}`
    + `.grid{display:grid;grid-template-columns:${thermal ? '1fr' : '1fr 1fr'};gap:${thermal ? '5px' : '10px 28px'};background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:${thermal ? '8px' : '15px'}}`
    + `.amount{margin:${thermal ? '12px 0' : '22px 0'};padding:${thermal ? '10px' : '18px'};border:2px solid ${accent};border-radius:10px;text-align:center}`
    + `.amount span{display:block;color:#64748b;text-transform:uppercase;font-size:${thermal ? '9px' : '10px'}}.amount strong{display:block;font-size:${thermal ? '18px' : '28px'};color:${accent};margin-top:5px}`
    + `.amount .fx{margin-top:5px;color:#334155;font-size:${thermal ? '9px' : '11px'}}`
    + `.concept{padding:${thermal ? '9px' : '14px'};border-left:4px solid ${accent};background:#f8fafc;white-space:pre-wrap}`
    + `.note{margin-top:${thermal ? '9px' : '14px'};padding:${thermal ? '9px' : '12px'};border:1px solid #e2e8f0;white-space:pre-wrap}`
    + `.signatures{display:grid;grid-template-columns:${thermal ? '1fr' : '1fr 1fr'};gap:${thermal ? '26px' : '70px'};margin-top:${thermal ? '34px' : compact ? '45px' : '75px'}}`
    + `.sign{border-top:1px solid #334155;text-align:center;padding-top:7px}`
    + `.foot{${thermal ? 'margin-top:16px' : 'position:absolute;bottom:0;left:0;right:0'};border-top:1px solid #cbd5e1;padding-top:8px;color:#64748b;font-size:${thermal ? '8px' : '10px'};display:flex;justify-content:space-between;gap:8px${thermal ? ';flex-direction:column' : ''}}`;
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${_cajaEsc(receipt.document_number_fmt || 'Recibo de egreso')}</title><style>${style}</style></head><body><section class="page">`
    + `<header class="head"><div class="brand">${logo}${businessBlock}</div><div class="doc"><strong>RECIBO DE EGRESO</strong><span>${_cajaEsc(receipt.document_number_fmt || '')}</span>${receipt.is_reprint ? '<em>Reimpresión</em>' : ''}</div></header>`
    + `<h2 class="title">Constancia de dinero entregado</h2>`
    + `<div class="grid"><div><span class="muted">Pagado a</span><br><strong>${_cajaEsc(receipt.paid_to_name || '—')}</strong></div>`
    + `<div><span class="muted">Cédula / RNC</span><br><strong>${_cajaEsc(receipt.paid_to_document || '—')}</strong></div>`
    + `<div><span class="muted">Fecha</span><br><strong>${_cajaEsc(typeof fdate === 'function' ? fdate(date) : date)}</strong></div>`
    + `<div><span class="muted">Método</span><br><strong>${_cajaEsc(_cajaExpenseMethod(receipt.method))}</strong></div>`
    + `<div><span class="muted">Categoría</span><br><strong>${_cajaEsc(receipt.category_name || 'Sin categoría')}</strong></div>`
    + `<div><span class="muted">Referencia</span><br><strong>${_cajaEsc(reference || '—')}</strong></div></div>`
    + `<div class="amount"><span>Monto pagado</span><strong>${fmt(amount)}</strong>${partialBlock}</div>`
    + `<div class="concept"><strong>Concepto</strong><br>${_cajaEsc(receipt.concept || '')}</div>${notesBlock}${signaturesBlock}`
    + `<footer class="foot"><span>${_cajaEsc(CFG.biz || '')}</span><span>Documento interno · No sustituye comprobante fiscal</span></footer>`
    + `</section></body></html>`;
}

function printExpenseReceipt(receipt, override = null) {
  if (!receipt) return;
  printHTML(buildExpenseReceiptHTML(receipt, override), 'recibo_egreso');
}

// Vista previa del Centro de impresión: datos de ejemplo, nunca un egreso real.
function cajaPreviewExpenseReceipt(settings = null) {
  const sample = {
    document_number_fmt: 'RGE-000123',
    paid_to_name: 'PERSONA O EMPRESA DE EJEMPLO',
    paid_to_document: '001-0000000-1',
    created_at: today(),
    method: 'efectivo',
    category_name: 'Categoría de ejemplo',
    reference: 'REF-EJEMPLO',
    amount: 2500,
    expense_total: 2500,
    balance_after: 0,
    concept: 'Ejemplo de dinero entregado para pagar un gasto.',
    notes: 'Nota editable al registrar el egreso.',
    user_name: _cajaUser()?.name || 'Administrador',
  };
  // «Formato anterior» depende de la plantilla de ventas; la vista previa
  // muestra el diseño de egreso en carta para no confundir.
  const effective = settings && settings.template === 'egreso_ticket_pos'
    ? { ...settings, template: 'egreso_carta_profesional' } : settings;
  const html = buildExpenseReceiptHTML(sample, effective);
  if (typeof _openPrintPreview === 'function') {
    _openPrintPreview(html, {
      jobType: 'recibo_egreso', mode: 'print', source: 'html',
      suggestedName: 'Recibo-egreso-ejemplo',
    });
    return;
  }
  printHTML(html, 'recibo_egreso');
}

function _cajaExpenseCategoryOptions(categories) {
  const active = categories.filter(c => Number(c.active ?? 1) !== 0);
  const parents = active.filter(c => !c.parent_id);
  const groups = parents.map(p => {
    const subs = active.filter(c => Number(c.parent_id) === Number(p.id));
    if (!subs.length) return `<option value="${p.id}">${_cajaEsc(p.name)}</option>`;
    return `<optgroup label="${_cajaEsc(p.name)}">${subs.map(c => `<option value="${c.id}">${_cajaEsc(c.name)}</option>`).join('')}</optgroup>`;
  }).join('');
  return `<option value="">— Sin categoría —</option>${groups}`;
}

async function openExpenseReceiptModal() {
  if (!cajaOpen || !cajaSession?.id) { toast('Abre la caja antes de registrar un egreso','w'); return; }
  if (!cajaCanIssueExpenseReceipt()) { toast('Solo el administrador puede hacer recibos de egreso','w'); return; }
  let categories = [];
  try {
    const result = await window.api.expenses.getCategories();
    categories = result?.ok ? (result.data || []) : [];
  } catch {}
  openModal(`<div class="modal-title">Nuevo recibo de egreso</div><div class="modal-sub">Registra un pago hecho con el efectivo de esta caja. Queda también en Gastos.</div>
    <div class="g2"><div class="fg"><label class="lbl">Pagado a *</label><input class="inp" id="cash-expense-payee" maxlength="120" placeholder="Nombre de quien recibe el dinero"/></div>
      <div class="fg"><label class="lbl">Cédula / RNC *</label><input class="inp" id="cash-expense-document" maxlength="40" placeholder="Documento de quien recibe"/></div></div>
    <div class="g2"><div class="fg"><label class="lbl">Teléfono</label><input class="inp" id="cash-expense-phone" maxlength="40" placeholder="Opcional"/></div>
      <div class="fg"><label class="lbl">Categoría</label><select class="inp" id="cash-expense-category">${_cajaExpenseCategoryOptions(categories)}</select></div></div>
    <div class="fg"><label class="lbl">Concepto *</label><input class="inp" id="cash-expense-concept" maxlength="200" placeholder="Motivo por el que sale el dinero"/></div>
    <div class="g2"><div class="fg"><label class="lbl">Monto (RD$) *</label><input class="inp" id="cash-expense-amount" type="number" min="0.01" step="0.01"/></div>
      <div class="fg"><label class="lbl">Método</label><input class="inp" value="Efectivo de esta caja" disabled/></div></div>
    <div class="fg"><label class="lbl">Notas para el recibo</label><textarea class="inp" id="cash-expense-notes" rows="3" placeholder="Opcional"></textarea></div>
    <div class="ven-callout">El dinero sale del efectivo de esta caja y baja lo esperado en el cuadre. El pago queda registrado en Gastos.</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-red" id="cash-expense-save" onclick="confirmExpenseReceipt()">${svg('check')} Registrar e imprimir</button></div>`, 'modal-lg caja-mobile-modal');
}

async function confirmExpenseReceipt() {
  const actor = _cajaUser();
  const button = document.getElementById('cash-expense-save');
  const value = id => String(document.getElementById(id)?.value || '').trim();
  const payee = value('cash-expense-payee');
  const documentId = value('cash-expense-document');
  const concept = value('cash-expense-concept');
  const amount = Math.round((Number(value('cash-expense-amount')) || 0) * 100) / 100;
  if (!payee) return toast('Indica a quién se le entrega el dinero','w');
  if (!documentId) return toast('Indica la cédula o RNC de quien recibe','w');
  if (!concept) return toast('Indica el concepto del egreso','w');
  if (!(amount > 0)) return toast('El monto debe ser mayor a cero','w');
  if (button) button.disabled = true;
  const notes = value('cash-expense-notes');
  try {
    const result = await window.api.expenses.create({
      data: {
        type: 'gasto',
        description: concept,
        category_id: value('cash-expense-category') || null,
        supplier_id: null,
        beneficiary_name: payee,
        beneficiary_document: documentId,
        beneficiary_phone: value('cash-expense-phone'),
        amount,
        tax_amount: 0,
        total: amount,
        payment_method: 'efectivo',
        payment_source: 'caja',
        pay_now: true,
        from_cash_register: true,
        cash_session_id: cajaSession?.id,
        issue_date: today(),
        notes: notes || null,
      },
      requestUserId: actor?.id,
    });
    if (!result?.ok) { toast(result?.error || 'No se pudo registrar el egreso','err'); if (button) button.disabled = false; return; }
    closeModal();
    cajaExpenseReceiptsInvalidate();
    cajaInvalidateSessionSales();
    if (!result.paid) {
      toast(`El gasto quedó registrado pero no se pudo pagar desde la caja${result.payWarning ? `: ${result.payWarning}` : ''}. Revísalo en Gastos.`,'err');
    } else {
      toast(`✓ Egreso registrado · ${result.documentNumberFmt || ''}`);
      try {
        const expense = await window.api.expenses.getById({ id: result.id });
        if (expense?.ok && expense.data) {
          printPagoProveedor({
            payment: {
              id: result.paymentId,
              document_kind: result.documentKind,
              document_number: result.documentNumber,
              document_number_fmt: result.documentNumberFmt,
              amount,
              method: 'efectivo',
              balance_before: amount,
              balance_after: 0,
              created_at: new Date().toISOString(),
            },
            expense: expense.data,
            cajero: actor?.name || '',
          });
        }
      } catch (error) {
        toast('El egreso quedó registrado, pero no se pudo imprimir. Reimprímelo desde la lista.','w');
      }
    }
    veloRepaint(() => renderCaja(document.getElementById('page')));
  } catch (e) {
    toast(e?.message || 'No se pudo registrar el egreso','err');
    if (button) button.disabled = false;
  }
}

// Anular desde Caja solo cuando el recibo es todo el gasto y salió de esta
// sesión: anular un gasto revierte todos sus pagos y devuelve el dinero a la
// caja donde se pagó. Lo demás se anula desde Gastos, donde se ve completo.
function cajaExpenseCancellableHere(row, sessionId) {
  return Number(row.active_payments) === 1
    && Math.abs(Number(row.expense_total || 0) - Number(row.amount || 0)) < 0.01
    && Number(row.expense_cash_session_id) === Number(sessionId);
}

function openCancelExpenseReceiptModal(row) {
  if (!cajaCanIssueExpenseReceipt()) return toast('Solo el administrador puede anular recibos de egreso','w');
  openModal(`<div class="modal-title">Anular recibo de egreso</div>
    <div class="modal-sub">${_cajaEsc(row.document_number_fmt || '')} · ${_cajaEsc(row.beneficiary_name || row.supplier_name || '')} · ${fmt(row.amount)}</div>
    <div class="alrt a" style="margin:12px 0"><div><div class="alrt-title">El dinero vuelve a esta caja</div>
      <div class="alrt-sub">Se anula también el gasto en Gastos y su registro contable. Esta acción no se puede deshacer.</div></div></div>
    <div class="fg"><label class="lbl">Motivo de la anulación *</label><input class="inp" id="cash-expense-cancel-reason" maxlength="200" placeholder="Por qué se anula este egreso"/></div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-red" id="cash-expense-cancel-save" onclick="confirmCancelExpenseReceipt(${Number(row.expense_id)})">${svg('xmark')} Anular egreso</button></div>`, 'caja-mobile-modal');
}

async function confirmCancelExpenseReceipt(expenseId) {
  const reason = String(document.getElementById('cash-expense-cancel-reason')?.value || '').trim();
  if (!reason) return toast('Indica el motivo de la anulación','w');
  const button = document.getElementById('cash-expense-cancel-save');
  if (button) button.disabled = true;
  try {
    const result = await window.api.expenses.cancel({ expenseId, reason, requestUserId:_cajaUser()?.id });
    if (!result?.ok) { toast(result?.error || 'No se pudo anular el egreso','err'); if (button) button.disabled = false; return; }
    closeModal();
    cajaExpenseReceiptsInvalidate();
    cajaInvalidateSessionSales();
    toast('✓ Egreso anulado · el dinero volvió a la caja');
    veloRepaint(() => renderCaja(document.getElementById('page')));
  } catch (e) {
    toast(e?.message || 'No se pudo anular el egreso','err');
    if (button) button.disabled = false;
  }
}

// Historial de recibos de egreso: todas las sesiones y cuentas, por fechas.
function cajaExpenseHistoryCard() {
  if (!_cajaExpenseHistory.filters.from) {
    Object.assign(_cajaExpenseHistory.filters, _cajaDefaultHistoryRange());
  }
  const f = _cajaExpenseHistory.filters;
  const card = h('div', { class:'card mb20', id:'caja-expense-history' });
  card.innerHTML = `
    <div class="fxb mb8">
      <div><div class="card-title">Historial de recibos de egreso</div>
        <div class="ts">Todos los pagos de gastos, desde Caja o desde Gastos. Desde aquí se consulta y se reimprime.</div></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:13px;margin-bottom:10px">
      <div class="fg"><label class="lbl">Desde</label><input class="inp" id="caja-expense-from" type="date" value="${_cajaEsc(f.from)}"/></div>
      <div class="fg"><label class="lbl">Hasta</label><input class="inp" id="caja-expense-to" type="date" value="${_cajaEsc(f.to)}"/></div>
      <div class="fg"><label class="lbl">Buscar</label><input class="inp" id="caja-expense-query" placeholder="Recibo, persona, concepto o referencia" value="${_cajaEsc(f.query)}"/></div>
      <div class="fg"><label class="lbl">&nbsp;</label>
        <button class="btn btn-dark" style="width:100%" onclick="cajaSearchExpenseHistory()">${svg('search')} Buscar</button></div>
    </div>
    <label class="ts" style="display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:10px">
      <input id="caja-expense-cancelled" type="checkbox" ${f.includeCancelled ? 'checked' : ''} onchange="cajaSearchExpenseHistory()"/>
      Incluir recibos anulados
    </label>
    <div id="caja-expense-history-body"></div>`;
  return card;
}

function cajaRenderExpenseHistoryBody() {
  const body = document.getElementById('caja-expense-history-body');
  if (!body) return;
  const state = _cajaExpenseHistory;
  if (state.loading) {
    body.innerHTML = `<div class="empty" style="padding:18px"><p>Cargando historial…</p></div>`;
    return;
  }
  if (!state.rows.length) {
    body.innerHTML = `<div class="empty" style="padding:18px"><p>Sin recibos de egreso en el período seleccionado</p></div>`;
    return;
  }
  const rows = state.rows.map(r => {
    const cancelled = r.status !== 'pagado';
    const date = String(r.created_local || '').slice(0, 10);
    return `<tr${cancelled ? ' style="opacity:.62"' : ''}>
      <td class="tm">${_cajaEsc(r.document_number_fmt || `EGR-${r.id}`)}</td>
      <td class="ts">${_cajaEsc(typeof fdate === 'function' ? fdate(date) : date)}</td>
      <td><div class="tb">${_cajaEsc(r.beneficiary_name || r.supplier_name || '—')}</div><div class="ts">${_cajaEsc(r.category_name || 'Sin categoría')}</div></td>
      <td>${_cajaEsc(r.description || '')}</td>
      <td><span class="badge ${r.payment_method === 'efectivo' ? 'g' : 'b'}">${_cajaEsc(_cajaExpenseMethod(r.payment_method))}</span></td>
      <td style="font-weight:800;color:${cancelled ? 'var(--muted)' : 'var(--red)'}">${fmt(r.amount)}</td>
      <td><span class="badge ${cancelled ? 'r' : 'g'}">${cancelled ? 'Anulado' : 'Vigente'}</span></td>
      <td>${cancelled ? '' : `<button class="btn btn-ghost btn-sm" title="Reimprimir" onclick="cajaReprintExpenseHistory(${Number(r.id)})">${svg('print')}</button>`}</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<div class="tw"><table class="mobile-card-table mobile-card-auto">
      <thead><tr>${['Recibo','Fecha','Pagado a','Concepto','Método','Monto','Estado',''].map(t => `<th>${t}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="ts" style="margin-top:9px;display:flex;gap:16px;flex-wrap:wrap">
      <span>Vigentes: <strong style="color:var(--red)">${fmt(state.totals.active || 0)}</strong></span>
      ${state.totals.cancelled ? `<span>Anulados: <strong>${fmt(state.totals.cancelled)}</strong></span>` : ''}
      <span>${state.rows.length} recibo${state.rows.length === 1 ? '' : 's'}</span>
      ${state.truncated ? '<span style="color:var(--red)">Se muestran los más recientes: acota el período para ver el resto.</span>' : ''}
    </div>`;
}

async function cajaSearchExpenseHistory() {
  const state = _cajaExpenseHistory;
  state.filters = {
    from: document.getElementById('caja-expense-from')?.value || state.filters.from,
    to: document.getElementById('caja-expense-to')?.value || state.filters.to,
    query: document.getElementById('caja-expense-query')?.value || '',
    includeCancelled: document.getElementById('caja-expense-cancelled')
      ? !!document.getElementById('caja-expense-cancelled').checked : state.filters.includeCancelled,
  };
  state.loading = true;
  state.loaded = true;
  cajaRenderExpenseHistoryBody();
  try {
    const result = await window.api.expenses.searchReceipts({ ...state.filters, requestUserId:_cajaUser()?.id });
    if (!result?.ok) throw new Error(result?.error || 'No se pudo cargar el historial');
    state.rows = result.data?.rows || [];
    state.truncated = !!result.data?.truncated;
    state.totals = result.data?.totals || { active:0, cancelled:0 };
  } catch (error) {
    state.rows = []; state.truncated = false; state.totals = { active:0, cancelled:0 };
    toast(error?.message || 'No se pudo cargar el historial','err');
  }
  state.loading = false;
  cajaRenderExpenseHistoryBody();
}

async function cajaReprintExpenseHistory(paymentId) {
  const row = _cajaExpenseHistory.rows.find(item => Number(item.id) === Number(paymentId));
  if (!row) return toast('Recibo no encontrado','err');
  await cajaReprintExpenseReceipt(row);
}

async function cajaReprintExpenseReceipt(row) {
  if (typeof window.imprimirPagoGasto !== 'function') return toast('La impresión de gastos no está disponible','err');
  await window.imprimirPagoGasto(row.expense_id, row.id);
}

// Modificar un recibo conserva su número: se corrige el mismo documento y solo
// se mueve la diferencia real de dinero.
async function openEditIncomeReceiptModal(receipt) {
  if (!receipt) return toast('Recibo no encontrado','err');
  if (receipt.status === 'cancelled') return toast('Un recibo anulado no se puede modificar','w');
  let accounts = [];
  try {
    const result = await window.api.financial.getAll();
    accounts = (result?.ok ? result.data : []).filter(a => a.active && ['banco','tarjeta'].includes(a.type));
  } catch {}
  const sel = (value, current) => value === current ? ' selected' : '';
  const method = String(receipt.method || 'efectivo');
  openModal(`<div class="modal-title">Modificar ${_cajaEsc(receipt.document_number_fmt || `RIN-${receipt.id}`)}</div>
    <div class="modal-sub">El recibo conserva su número. Solo se ajusta la diferencia de dinero que realmente cambie.</div>
    <div class="g2"><div class="fg"><label class="lbl">Recibido de *</label><input class="inp" id="cash-income-edit-payer" value="${_cajaEsc(receipt.payer_name)}"/></div>
      <div class="fg"><label class="lbl">Cédula / RNC</label><input class="inp" id="cash-income-edit-document" value="${_cajaEsc(receipt.payer_document || '')}"/></div></div>
    <div class="fg"><label class="lbl">Concepto *</label><input class="inp" id="cash-income-edit-concept" value="${_cajaEsc(receipt.concept)}"/></div>
    <div class="g2"><div class="fg"><label class="lbl">Tipo de ingreso</label><select class="inp" id="cash-income-edit-type">
      <option value="otro_ingreso"${sel('otro_ingreso',receipt.income_type)}>Otro ingreso</option>
      <option value="aporte_capital"${sel('aporte_capital',receipt.income_type)}>Aporte de capital</option>
      <option value="prestamo"${sel('prestamo',receipt.income_type)}>Préstamo recibido</option>
      <option value="reembolso"${sel('reembolso',receipt.income_type)}>Reembolso / recuperación</option></select></div>
      ${cajaIncomeCurrencySelect('cash-income-edit', receipt.payment_currency)}</div>
    ${cajaIncomeCurrencyFields('cash-income-edit', receipt)}
    <div class="g2"><div class="fg"><label class="lbl">Método</label><select class="inp" id="cash-income-edit-method" onchange="cajaEditIncomeMethodChanged()">
      <option value="efectivo"${sel('efectivo',method)}>Efectivo</option>
      <option value="transferencia"${sel('transferencia',method)}>Transferencia</option>
      <option value="tarjeta"${sel('tarjeta',method)}>Tarjeta</option>
      <option value="cheque"${sel('cheque',method)}>Cheque</option></select></div>
      <div class="fg" id="cash-income-edit-account-wrap" style="display:${method === 'efectivo' ? 'none' : ''}"><label class="lbl">Cuenta receptora *</label>
        <select class="inp" id="cash-income-edit-account"><option value="">Seleccionar cuenta…</option>
        ${accounts.map(a => `<option value="${a.id}"${Number(a.id) === Number(receipt.financial_account_id) ? ' selected' : ''}>${_cajaEsc(a.name)}${a.account_number ? ` · ${_cajaEsc(a.account_number)}` : ''}</option>`).join('')}</select></div></div>
    <div class="fg"><label class="lbl">Referencia</label><input class="inp" id="cash-income-edit-reference" value="${_cajaEsc(receipt.reference || '')}"/></div>
    <div class="fg"><label class="lbl">Notas para el recibo</label><textarea class="inp" id="cash-income-edit-notes" rows="2">${_cajaEsc(receipt.notes || '')}</textarea></div>
    <div class="fg"><label class="lbl">Motivo de la modificación *</label><input class="inp" id="cash-income-edit-reason" placeholder="Por qué se corrige este recibo"/></div>
    <div class="ven-callout">Si cambia el monto o el método, la diferencia entra o sale por la caja abierta y la cuenta afectada. El asiento contable se regenera.</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" id="cash-income-edit-save" onclick="confirmEditIncomeReceipt(${Number(receipt.id)})">${svg('check')} Guardar cambios</button></div>`, 'modal-lg caja-mobile-modal');
  cajaIncomeRecalcEquivalent('cash-income-edit');
}

function cajaEditIncomeMethodChanged() {
  const method = document.getElementById('cash-income-edit-method')?.value || 'efectivo';
  const wrap = document.getElementById('cash-income-edit-account-wrap');
  if (wrap) wrap.style.display = method === 'efectivo' ? 'none' : '';
}

async function confirmEditIncomeReceipt(id) {
  const actor = _cajaUser();
  const button = document.getElementById('cash-income-edit-save');
  if (button) button.disabled = true;
  const data = {
    payer_name: document.getElementById('cash-income-edit-payer')?.value,
    payer_document: document.getElementById('cash-income-edit-document')?.value,
    concept: document.getElementById('cash-income-edit-concept')?.value,
    income_type: document.getElementById('cash-income-edit-type')?.value,
    amount: document.getElementById('cash-income-edit-amount')?.value,
    payment_currency: document.getElementById('cash-income-edit-currency')?.value || 'DOP',
    exchange_rate: document.getElementById('cash-income-edit-rate')?.value || 1,
    method: document.getElementById('cash-income-edit-method')?.value,
    financial_account_id: document.getElementById('cash-income-edit-account')?.value || null,
    reference: document.getElementById('cash-income-edit-reference')?.value,
    notes: document.getElementById('cash-income-edit-notes')?.value,
    reason: document.getElementById('cash-income-edit-reason')?.value,
  };
  const result = await window.api.cash.updateIncomeReceipt({
    id, data, cashSessionId:cajaSession?.id, requestUserId:actor?.id,
  });
  if (!result?.ok) { toast(result?.error || 'No se pudo modificar el recibo','err'); if (button) button.disabled = false; return; }
  closeModal();
  _cajaIncomeState.rows = _cajaIncomeState.rows.map(row =>
    Number(row.id) === Number(id) ? result.data : row);
  cajaIncomeHistoryInvalidate();
  toast(`✓ ${result.data.document_number_fmt} actualizado`);
  veloRepaint(() => renderCaja(document.getElementById('page')));
}

function cajaEditIncomeFromHistory(id) {
  const receipt = cajaIncomeHistoryRow(id);
  if (!receipt) return toast('Recibo no encontrado','err');
  openEditIncomeReceiptModal(receipt);
}

function openCancelIncomeReceiptModal(receipt) {
  openModal(`<div class="modal-title">Anular ${_cajaEsc(receipt.document_number_fmt)}</div><div class="modal-sub">El ingreso desaparecerá de la vista operativa y se revertirá su impacto financiero.</div><div class="alrt r" style="margin:14px 0"><div><div class="alrt-title">Monto a revertir: ${fmt(receipt.amount)}</div><div class="alrt-sub">Esta acción queda registrada en auditoría.</div></div></div><div class="fg"><label class="lbl">Motivo *</label><textarea class="inp" id="cash-income-cancel-reason" rows="3"></textarea></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-red" onclick="confirmCancelIncomeReceipt(${Number(receipt.id)})">${svg('xmark')} Anular ingreso</button></div>`, 'caja-mobile-modal');
}

async function confirmCancelIncomeReceipt(id) {
  const reason = document.getElementById('cash-income-cancel-reason')?.value || '';
  const actor = _cajaUser();
  const result = await window.api.cash.cancelIncomeReceipt({ id, reason, cashSessionId:cajaSession?.id, requestUserId:actor?.id });
  if (!result?.ok) { toast(result?.error || 'No se pudo anular el ingreso','err'); return; }
  closeModal();
  _cajaIncomeState.rows = _cajaIncomeState.rows.filter(row=>Number(row.id)!==Number(id));
  cajaIncomeHistoryInvalidate();
  toast('✓ Ingreso anulado y retirado de Caja');
  veloRepaint(() => renderCaja(document.getElementById('page')));
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
        <button class="btn btn-red" id="btn-cerrar-huerfana" onclick="cerrarSesionHuerfana(${sesionAnterior.id})">
          ${svg('lock')} Cerrar sesión anterior y continuar
        </button>
      </div>
    `, 'caja-mobile-modal');
    return;
  }

  const billRows = DENS.map(d => `
    <div class="bill-row2">
      <span class="bill-den2">RD$ ${d.toLocaleString()}</span>
      <input class="bill-inp2" type="number" min="0" value="0"
             id="open-bill-${d}" data-den="${d}" data-sub="open"/>
      <span class="bill-sub2" id="open-sub-${d}">RD$ 0</span>
    </div>`).join('');

  openModal(`
    <div class="modal-title">Abrir Caja</div>
    <div class="modal-sub">Ingresa el fondo inicial por denominación</div>
    <div class="bill-grid2" id="open-bill-grid">${billRows}</div>
    <div class="bill-total-row">
      <span class="bill-total-lbl">Total Fondo</span>
      <span id="open-total" class="bill-total-val">RD$ 0.00</span>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" id="btn-cancelar-apertura">Cancelar</button>
      <button class="btn btn-green" id="btn-confirmar-apertura">
        ${svg('unlock')} Abrir Caja
      </button>
    </div>
  `, 'modal-caja caja-mobile-modal');

  // Eventos propios (no dependen de la lista blanca de _bindModalSafeActions
  // ni de oninput inline). Delegación en la grilla para los subtotales.
  const grid = document.getElementById('open-bill-grid');
  if (grid) grid.addEventListener('input', (ev) => {
    if (ev.target.classList.contains('bill-inp2')) calcOpenTotal();
  });
  document.getElementById('btn-cancelar-apertura')?.addEventListener('click', () => closeModal());
  document.getElementById('btn-confirmar-apertura')?.addEventListener('click', () => confirmarApertura());
  calcOpenTotal();
}

function calcOpenTotal() {
  let total = 0;
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`open-bill-${d}`)?.value || 0) || 0;
    const sub = qty * d;
    total += sub;
    const subEl = document.getElementById(`open-sub-${d}`);
    if (subEl) subEl.textContent = `RD$ ${sub.toLocaleString()}`;
  });
  const totEl = document.getElementById('open-total');
  if (totEl) totEl.textContent = fmt(total);
}

async function confirmarApertura() {
  const btn = document.getElementById('btn-confirmar-apertura');
  if (btn?.disabled) return; // evita doble clic
  if (btn) btn.disabled = true;

  const user = _cajaUser();
  if (!user) { if (btn) btn.disabled = false; toast('Sesión no disponible', 'err'); return; }

  let fondo = 0;
  const bills = {};
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`open-bill-${d}`)?.value || 0);
    bills[d] = qty;
    fondo += qty * d;
  });

  let result;
  try {
    result = await cajaOpenWithRecovery({
      openAmount: fondo,
      openBills:  bills,
      requestUserId: user.id,
      terminalId: cajaTerminalId(),
    });
  } catch (e) {
    if (btn) btn.disabled = false;
    toast('Error al abrir caja', 'err');
    return;
  }

  if (!result.ok) {
    if (btn) btn.disabled = false;
    toast(result.error || 'Error al abrir caja', 'err');
    return;
  }

  cajaOpen = true;
  cajaSession = result.session || {
    id: result.id, user_id: user.id, cajero: user.name,
    open_amount: fondo, open_bills: JSON.stringify(bills), status: 'open',
  };
  closeModal();
  toast(result.recovered ? '✓ Caja abierta y confirmada' : '✓ Caja abierta');
  veloRepaint(() => renderCaja(document.getElementById('page')));
  buildTopbar();
  buildSidebar();
  Promise.resolve(chkCaja()).then(() => {
    if (typeof page !== 'undefined' && page === 'caja') veloRepaint(() => renderCaja(document.getElementById('page')));
    buildTopbar();
  }).catch(() => {});
}

// ══════════════════════════════════════════════
// CIERRE DE SESIÓN HUÉRFANA
// Se llama cuando hay una caja abierta de un día anterior
// ══════════════════════════════════════════════
async function cerrarSesionHuerfana(sessionId) {
  const btn = document.getElementById('btn-cerrar-huerfana');
  if (btn?.disabled) return; // evita doble clic
  if (btn) btn.disabled = true;

  const user = _cajaUser();
  if (!user) { if (btn) btn.disabled = false; toast('Sesión no disponible', 'err'); return; }

  let result;
  try {
    result = await cajaCloseWithRecovery({
      sessionId,
      closeAmount: 0,
      closeBills:  {},
      expected:    0,
      notes:       'Cierre automático — sesión sin cerrar del día anterior',
      requestUserId: user.id,
    });
  } catch (e) {
    if (btn) btn.disabled = false;
    toast('Error al cerrar sesión anterior', 'err');
    return;
  }

  if (!result.ok) {
    if (btn) btn.disabled = false;
    toast(result.error || 'Error al cerrar sesión anterior', 'err');
    return;
  }

  cajaOpen = false;
  cajaSession = null;
  closeModal();
  toast('Sesión anterior cerrada — ahora puedes abrir caja', 'ok');
  Promise.allSettled([
    window.api.cash.getSessions().then(sessions => { DB.caja = sessions || []; }),
    chkCaja(),
  ]).catch(() => {});
  setTimeout(() => openAperturaCajaModal(), 300);
}

// Normaliza una fila cruda de cash_sessions (columnas reales de SQLite)
// a los nombres cortos legacy que usa la UI de esta pantalla.
function _normCaja(s) {
  return {
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
    // Los acumulados live vienen calculados desde facturas vigentes. El cache
    // persistido queda como respaldo para servidores anteriores.
    total:      s.live_sales_total ?? s.sales_total ?? s.total ?? 0,
    salesCount: s.live_sales_count ?? s.sales_count ?? 0,
    openBills:  typeof s.open_bills  === 'string' ? JSON.parse(s.open_bills  || '{}') : (s.openBills  || {}),
    closeBills: typeof s.close_bills === 'string' ? JSON.parse(s.close_bills || '{}') : (s.closeBills || {}),
    obs:        s.notes || s.obs || '',
  };
}

// ══════════════════════════════════════════════
// CIERRE CON CUADRE
// ══════════════════════════════════════════════
async function openCierreCajaModal() {
  if (!cajaSession) return;

  // El cuadre no puede depender de lo que otra pantalla dejó en memoria.
  let sesSales;
  try { sesSales = await cajaFetchSessionSales(cajaSession.id); }
  catch { sesSales = cajaSalesForSession(cajaSession.id); }
  const tdS    = sesSales.filter(s => s.type !== 'devolucion' && s.status !== 'cancelled');
  const tdDevs = sesSales.filter(s => s.type === 'devolucion');
  const tdEfec = tdS.filter(s => (s.payment_method || s.pay) === 'efectivo').reduce((a, s) => a + s.total, 0);
  const tdCard = tdS.filter(s => (s.payment_method || s.pay) === 'tarjeta').reduce((a, s) => a + s.total, 0);
  const tdTrans= tdS.filter(s => (s.payment_method || s.pay) === 'transferencia').reduce((a, s) => a + s.total, 0);
  const tdCred = tdS.filter(s => (s.payment_method || s.pay) === 'credito').reduce((a, s) => a + s.total, 0);
  const tdRev  = tdS.reduce((a, s) => a + s.total, 0);

  // ── Abonos en efectivo de ESTA sesión (excluye históricos sin sesión) ──
  // Solo cuenta abonos en efectivo vinculados a esta caja y que no sean
  // de la importación histórica. Los abonos importados de la migración
  // nunca tienen cash_session_id ni method que aplique a caja física.
  let sesPayments;
  try { sesPayments = await cajaFetchSessionPayments(cajaSession.id); }
  catch { sesPayments = cajaPaymentsForSession(cajaSession.id); }
  const tdAbonos = sesPayments
    .filter(p =>
      (p.method || 'efectivo') === 'efectivo' &&
      String(p.status || 'active').toLowerCase() !== 'cancelled' &&
      !isImportedRecord(p)
    )
    .reduce((a, p) => a + (p.amount || 0), 0);

  // Devoluciones que salieron de caja en efectivo
  const tdDevEfec = tdDevs
    .filter(s => (s.payment_method || s.pay) === 'efectivo')
    .reduce((a, s) => a + s.total, 0);

  // ── Efectivo esperado: fuente real = cash_movements (backend) ──
  // Captura ventas efectivo, la porción efectivo de ventas mixtas, abonos
  // efectivo de la sesión, devoluciones, gastos y anulaciones — todo con
  // su signo correcto. Sin este resumen no se puede cerrar con seguridad:
  // el cálculo local no conoce los gastos y podría mostrar un sobrante falso.
  let expected;
  let usandoFuenteReal = false;
  let efectivoReal = null;   // movimiento neto según cash_movements
  try {
    const cashSummary = await window.api.cash.getSessionCashSummary
      ? await window.api.cash.getSessionCashSummary({ sessionId: cajaSession.id })
      : null;
    if (cashSummary && typeof cashSummary.expected === 'number') {
      expected = cashSummary.expected;
      usandoFuenteReal = true;
      efectivoReal = (
        (cashSummary.byMethodNet && cashSummary.byMethodNet.efectivo) ??
        (cashSummary.byMethodIn && cashSummary.byMethodIn.efectivo)
      ) || 0;
    }
  } catch (e) {
    console.error('[cierre] No se pudo consultar el cuadre de caja:', e);
  }
  if (!usandoFuenteReal) {
    toast('No se pudo calcular el efectivo esperado. Actualiza Caja e inténtalo de nuevo.', 'err');
    return;
  }

  // Para el desglose visual usamos el movimiento neto. Un abono anulado en la
  // misma sesión queda en cero y no reaparece como dinero recibido.
  const efectivoEntranteMostrado = usandoFuenteReal && efectivoReal !== null
    ? efectivoReal
    : (tdEfec + tdAbonos);

  const billRows = DENS.map(d => `
    <div class="bill-row2">
      <span class="bill-den2">RD$ ${d.toLocaleString()}</span>
      <input class="bill-inp2" type="number" min="0" value="0"
             id="close-bill-${d}" data-den="${d}"/>
      <span class="bill-sub2" id="close-sub-${d}">RD$ 0</span>
    </div>`).join('');

  openModal(`
    <div class="modal-title">Cerrar Caja — Arqueo Final</div>
    <div class="modal-sub">Cuenta el efectivo en caja y confirma el cierre</div>

    <div class="gg2" style="margin-bottom:14px">
      <div class="card" style="background:var(--surface2)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted2);margin-bottom:8px">Resumen del día</div>
        <div class="tr" style="font-size:12px"><span>Fondo inicial</span><span>${fmt(cajaSession.open_amount || cajaSession.open || 0)}</span></div>
        ${usandoFuenteReal
          ? `<div class="tr" style="font-size:12px"><span>Movimiento neto en efectivo <span style="font-size:10px;color:var(--muted2)">(ventas + abonos − salidas)</span></span><span style="color:${efectivoEntranteMostrado < 0 ? 'var(--red)' : 'var(--green)'}">${efectivoEntranteMostrado >= 0 ? '+' : '−'}${fmt(Math.abs(efectivoEntranteMostrado))}</span></div>`
          : `<div class="tr" style="font-size:12px"><span>Ventas efectivo</span><span style="color:var(--green)">+${fmt(tdEfec)}</span></div>
        ${tdAbonos > 0 ? `<div class="tr" style="font-size:12px"><span>Abonos en efectivo</span><span style="color:var(--green)">+${fmt(tdAbonos)}</span></div>` : ''}`}
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
          ${usandoFuenteReal
            ? 'Fondo + efectivo recibido (incluye parte efectivo de pagos mixtos) − salidas'
            : `Fondo + ventas efectivo${tdAbonos > 0 ? ' + abonos' : ''}${tdDevEfec > 0 ? ' − devoluciones' : ''}`}
        </div>
      </div>
    </div>

    <div style="font-weight:700;font-size:13px;margin-bottom:10px">Arqueo de billetes en caja</div>
    <div class="bill-grid2" id="close-bill-grid">${billRows}</div>

    <div class="bill-total-row">
      <span class="bill-total-lbl">Total contado</span>
      <span id="close-total" class="bill-total-val" style="color:var(--ink)">RD$ 0.00</span>
    </div>
    <label class="mt14"><input type="checkbox" id="close-count-confirmed"/> Confirmo que conté el efectivo físico, incluso si es cero.</label>
    <div id="close-diff" style="text-align:right;font-size:13px;font-weight:700;margin-top:3px"></div>

    <div class="fg mt14">
      <label class="lbl">Observaciones del cierre</label>
      <textarea class="inp" id="close-obs" rows="2" placeholder="Notas, irregularidades..."></textarea>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" id="btn-cancelar-cierre">Cancelar</button>
      <button class="btn btn-out" id="btn-preview-reporte">
        ${svg('print')} Vista previa reporte
      </button>
      <button class="btn btn-red" id="btn-confirmar-cierre">
        ${svg('lock')} Confirmar Cierre
      </button>
    </div>
  `, 'modal-caja modal-lg caja-mobile-modal');

  const cgrid = document.getElementById('close-bill-grid');
  if (cgrid) cgrid.addEventListener('input', (ev) => {
    if (ev.target.classList.contains('bill-inp2')) {
      const confirmed = document.getElementById('close-count-confirmed');
      if (confirmed) confirmed.checked = false;
      calcCloseTotal(expected);
    }
  });
  document.getElementById('btn-cancelar-cierre')?.addEventListener('click', () => closeModal());
  document.getElementById('btn-preview-reporte')?.addEventListener('click', () => imprimirReporteDia());
  document.getElementById('btn-confirmar-cierre')?.addEventListener('click', () => confirmarCierre(expected));
  document.getElementById('close-count-confirmed')?.addEventListener('change', () => calcCloseTotal(expected));
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

  const counted = document.getElementById('close-count-confirmed')?.checked === true;
  if (!counted) {
    if (totEl) { totEl.textContent = fmt(total); totEl.style.color = 'var(--ink)'; }
    if (diffEl) diffEl.textContent = 'Pendiente de confirmar el conteo físico';
    return;
  }
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
  if (document.getElementById('close-count-confirmed')?.checked !== true) {
    toast('Confirma el conteo del efectivo físico antes de cerrar la caja.', 'w');
    return;
  }
  const btn = document.getElementById('btn-confirmar-cierre');
  if (btn?.disabled) return; // evita doble clic
  if (btn) btn.disabled = true;

  const user = _cajaUser();
  if (!user) { if (btn) btn.disabled = false; toast('Sesión no disponible', 'err'); return; }

  let closeAmt = 0;
  const closeBills = {};
  DENS.forEach(d => {
    const qty = parseInt(document.getElementById(`close-bill-${d}`)?.value || 0);
    closeBills[d] = qty;
    closeAmt += qty * d;
  });

  const obs = document.getElementById('close-obs')?.value || '';

  let result;
  try {
    result = await cajaCloseWithRecovery({
      sessionId:     cajaSession.id,
      closeAmount:   closeAmt,
      closeBills,
      expected,
      notes:         obs,
      requestUserId: user.id,
    });
  } catch (e) {
    if (btn) btn.disabled = false;
    toast('Error al cerrar caja', 'err');
    return;
  }

  if (!result.ok) {
    if (btn) btn.disabled = false;
    toast(result.error || 'Error al cerrar caja', 'err');
    return;
  }

  cajaOpen    = false;
  cajaSession = null;
  closeModal();

  toast(result.recovered ? '✓ Caja cerrada y confirmada' : '✓ Caja cerrada');
  veloRepaint(() => renderCaja(document.getElementById('page')));
  buildTopbar();
  buildSidebar();
  // El reporte queda disponible bajo demanda. Cerrar caja nunca abre ni envía
  // una impresión automáticamente.
  window.api.cash.getSessions().then(sessions => {
    DB.caja = sessions || [];
    if (typeof page !== 'undefined' && page === 'caja') veloRepaint(() => renderCaja(document.getElementById('page')));
  }).catch(() => {});
}

// ══════════════════════════════════════════════
// REPORTE DEL DÍA (sesión activa)
// ══════════════════════════════════════════════
async function imprimirReporteDia() {
  const ses = cajaSession || DB.caja.filter(c => c.status === 'closed').slice(-1)[0];
  if (!ses) { toast('No hay sesión de caja', 'err'); return; }

  const sesId    = ses.id;
  const report = await window.api.cash.getSessionReport({ sessionId: sesId });
  if (!report?.session) { toast('No se pudo reconstruir el reporte de caja', 'err'); return; }
  const ventas = (report.sales || []).filter(s => s.type !== 'devolucion');
  const byMethod = report.totals?.bySaleMethod || {};
  const totalEfec  = Number(byMethod.efectivo || 0);
  const totalCard  = Number(byMethod.tarjeta || 0);
  const totalTrans = Number(byMethod.transferencia || 0);
  const totalCred  = Number(byMethod.credito || 0);
  const totalAbonos = Number(report.totals?.payments || 0);
  const totalIngresos = Number(report.totals?.incomeReceipts || 0);
  const totalDevolucion = Number(report.totals?.returns || 0);
  const totalVentas = Number(report.totals?.sales || 0);

  const openAmt  = ses.open_amount || ses.open || 0;
  const expected = Number(report.summary?.expected ?? openAmt);
  const counted  = ses.close_amount || ses.close || 0;
  // Una caja cerrada con RD$0 contado también puede tener un faltante real.
  // Solo la vista previa de una sesión abierta omite la diferencia.
  const diff     = ses.status === 'closed' ? Math.round((counted - expected) * 100) / 100 : 0;

  // ── Cargar gastos del día si el módulo está activo ──────────────────────────
  let gastosDelDia  = [];
  let totalGastos   = 0;
  const today_      = today();

  if (CFG.module_gastos === '1' && window.api?.expenses) {
    try {
      const gRes = await window.api.expenses.getAll({ date: today_ });
      gastosDelDia = gRes?.ok ? (gRes.data || []) : [];
      totalGastos  = gastosDelDia.reduce((a, g) => a + (g.amount || 0), 0);
    } catch(e) { console.warn('[Caja] gastos:', e.message); }
  }

  // Nota: la tarifa cobrada por envíos NO se suma como gasto — es un ingreso.
  // Los gastos reales de envíos (mensajería/combustible) los crea el proceso
  // main como expenses y ya vienen incluidos en la carga de arriba.

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
    totalIngresos,
    totalDevolucion,
    expected,
    counted,
    diff,
    salesCount:      ventas.length,
    salesTotal:      totalVentas,
    // Gastos del día
    gastosDelDia,
    totalGastos,
    gananciaReal:    totalVentas - totalGastos,
  });
}

// ══════════════════════════════════════════════
// MODAL RESUMEN
// ══════════════════════════════════════════════
async function openResumenModal(raw) {
  const s = _normCaja(raw);
  // Una sesión cerrada rara vez tiene sus ventas en la memoria del historial:
  // se consultan por su identificador, que es la fuente exacta.
  let sesSales;
  try { sesSales = await cajaFetchSessionSales(s.id); }
  catch { sesSales = cajaSalesForSession(s.id); }
  const sesVentas = sesSales.filter(v => v.type !== 'devolucion' && v.status !== 'cancelled');
  const sesDevs   = sesSales.filter(v => v.type === 'devolucion' && v.status !== 'cancelled');
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
      <button class="btn btn-out" onclick="guardarDocumentoExcel(()=>printResumen(${s.id}),'Reporte-Caja-${s.id}','Reporte de caja')">
        ${svg('download')} Excel
      </button>
    </div>
  `, 'modal-lg caja-mobile-modal');
}

// ══════════════════════════════════════════════
// IMPRIMIR REPORTE COMPLETO DEL DÍA
// ══════════════════════════════════════════════
async function printResumen(cajaId) {
  const report = await window.api.cash.getSessionReport({ sessionId: cajaId });
  if (!report?.session) { toast('No se encontró la sesión', 'err'); return; }
  const s = _normCaja(report.session);
  const normalizeSale = row => ({
    ...row,
    cajaId: row.cash_session_id,
    clientName: row.customer_name,
    pay: row.payment_method,
    time: String(row.created_at || '').split(' ')[1]?.slice(0, 5) || '',
  });
  const activeSales = (report.sales || []).map(normalizeSale);
  const sesVentas = activeSales.filter(v => v.type !== 'devolucion');
  const sesDevs = activeSales.filter(v => v.type === 'devolucion');
  const byMethod = report.totals?.bySaleMethod || {};
  const totalVentas = Number(report.totals?.sales || 0);
  const totalDevs = Number(report.totals?.returns || 0);
  const totalAbonos = Number(report.totals?.payments || 0);
  const totalIngresos = Number(report.totals?.incomeReceipts || 0);
  const incomeReceipts = report.incomeReceipts || [];
  const totalNeto   = totalVentas - totalDevs;
  const expected = Number(report.summary?.expected || 0);

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
      ${totalAbonos > 0 ? `<tr><td>Abonos vigentes</td>
        <td style="text-align:right">${fmt(totalAbonos)}</td><td></td></tr>` : ''}
      ${totalIngresos > 0 ? `<tr><td>Otros ingresos recibidos</td>
        <td style="text-align:right">${fmt(totalIngresos)}</td><td></td></tr>` : ''}
      <tr class="total-row" style="border-top:2px solid #e5e7eb">
        <td>NETO</td>
        <td style="text-align:right">${fmt(totalNeto)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  ${incomeReceipts.length ? `<h3>Recibos de ingreso (${incomeReceipts.length})</h3><table><thead><tr><th>Recibo</th><th>Recibido de</th><th>Concepto</th><th>Método</th><th style="text-align:right">Monto</th></tr></thead><tbody>${incomeReceipts.map(r=>`<tr><td>${_cajaEsc(r.document_number_fmt)}</td><td>${_cajaEsc(r.payer_name)}</td><td>${_cajaEsc(r.concept)}</td><td>${_cajaEsc(r.method)}</td><td style="text-align:right">${fmt(r.amount)}</td></tr>`).join('')}</tbody></table>`:''}

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
  ${CFG.module_gastos === '1' ? `
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

// ── Recibo de ingreso: a quién se le recibe ──────────────────────────────────
// El campo era texto libre, así que un cliente registrado quedaba escrito a
// mano y el recibo no se podía relacionar con él. Ahora sugiere mientras se
// escribe; quien no esté registrado se sigue escribiendo igual.
function cajaIncomeFilterPayer(texto) {
  const dd = document.getElementById('cash-income-payer-dd');
  const hint = document.getElementById('cash-income-payer-hint');
  const oculto = document.getElementById('cash-income-customer');
  if (!dd) return;
  const consulta = String(texto || '').trim();
  // Si se edita el nombre, el recibo deja de estar enlazado a ese cliente.
  if (oculto && oculto.value) {
    const elegido = (DB.customers || []).find(c => Number(c.id) === Number(oculto.value));
    if (!elegido || searchNorm(elegido.name) !== searchNorm(consulta)) {
      oculto.value = '';
      if (hint) hint.innerHTML = '&nbsp;';
    }
  }
  if (consulta.length < 2) { dd.classList.remove('show'); return; }
  const buscado = searchNorm(consulta);
  const digitos = consulta.replace(/\D/g, '');
  const encontrados = (DB.customers || []).filter(c => c.active !== 0 && (
    searchNorm(c.name).includes(buscado) ||
    (digitos.length >= 3 && String(c.rnc || '').replace(/\D/g, '').includes(digitos))
  )).slice(0, 8);
  if (!encontrados.length) {
    dd.innerHTML = `<div class="cli-opt" style="cursor:default">
      <div class="cli-opt-name" style="color:var(--muted);font-style:italic">"${_escHtml(consulta)}" — no registrado</div>
      <div class="cli-opt-meta" style="color:var(--muted2)">Se guardará con ese nombre, sin enlazarlo a un cliente</div>
    </div>`;
    dd.classList.add('show');
    return;
  }
  dd.innerHTML = encontrados.map(c => `
    <div class="cli-opt" onclick="cajaIncomeSelectPayer(${c.id})">
      <div class="cli-opt-name">${_escHtml(c.name)}</div>
      <div class="cli-opt-meta">${_escHtml(c.rnc || 'Sin RNC/Cédula')}${Number(c.balance) > 0 ? ` · Balance ${fmt(c.balance)}` : ''}</div>
    </div>`).join('');
  dd.classList.add('show');
}

function cajaIncomeSelectPayer(id) {
  const cliente = (DB.customers || []).find(c => Number(c.id) === Number(id));
  if (!cliente) return;
  const nombre = document.getElementById('cash-income-payer');
  const documento = document.getElementById('cash-income-document');
  const oculto = document.getElementById('cash-income-customer');
  const hint = document.getElementById('cash-income-payer-hint');
  const dd = document.getElementById('cash-income-payer-dd');
  if (nombre) nombre.value = cliente.name || '';
  if (documento && !documento.value.trim()) documento.value = cliente.rnc || '';
  if (oculto) oculto.value = String(cliente.id);
  if (hint) hint.textContent = `Recibo enlazado al cliente registrado${cliente.rnc ? ` · ${cliente.rnc}` : ''}`;
  if (dd) dd.classList.remove('show');
}
