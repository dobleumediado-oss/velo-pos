// Preventa y despacho: flujo compartido entre preparación, caja y entrega.

let _preventaRoot = null;
let _preventaLoading = false;
let _preventaView = 'auto';
let _preventaSearch = '';
let _preventaRows = [];

function preventaCanAccess() {
  if (typeof CFG === 'undefined' || CFG.module_preventa !== '1' || !user) return false;
  if (user.role === 'superadmin') return true;
  const roles = String(CFG.module_preventa_roles || 'admin,cajero')
    .split(',').map(role => role.trim()).filter(Boolean);
  return roles.includes(user.role);
}

function _pvEsc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[ch]));
}

function _pvWhen(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('es-DO', {
    day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
  });
}

function _pvElapsed(value) {
  if (!value) return { minutes: 0, label: 'Ahora', urgency: '' };
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return { minutes: 0, label: '', urgency: '' };
  const minutes = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  const label = minutes < 1 ? 'Ahora' : minutes < 60 ? `Hace ${minutes} min` :
    minutes < 1440 ? `Hace ${Math.floor(minutes / 60)} h` : `Hace ${Math.floor(minutes / 1440)} d`;
  return { minutes, label, urgency: minutes >= 20 ? 'is-late' : minutes >= 10 ? 'is-waiting' : '' };
}

function _pvStatus(order) {
  const map = {
    pending: ['a', 'En caja · por cobrar'], paid: ['g', 'Pagada · por entregar'],
    dispatched: ['b', 'Entregada'], cancelled: ['r', 'Cancelada'], expired: ['n', 'Vencida'],
  };
  const [cls, label] = map[order.status] || ['n', order.status];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function _pvLoad(statuses = ['pending','paid'], limit = 250) {
  const res = await window.api.checkout.list({ statuses, limit, requestUserId: user.id });
  if (!res?.ok) throw new Error(res?.error || 'No se pudieron cargar las órdenes');
  return res.data || [];
}

function _pvSetPendingCount(count) {
  const next = Math.max(0, Number(count) || 0);
  const before = Math.max(0, Number(window._preventaPendingCount) || 0);
  window._preventaPendingCount = next;
  if (before !== next && typeof buildSidebar === 'function') buildSidebar();
  return next;
}

function _pvDefaultView() {
  return (typeof cajaOpen !== 'undefined' && cajaOpen) ? 'cashier' : 'dispatch';
}

function _pvRowsForView(rows, view) {
  const source = Array.isArray(rows) ? rows : [];
  const current = view === 'auto' ? _pvDefaultView() : view;
  if (current === 'cashier') return source.filter(row => row.status === 'pending');
  if (current === 'dispatch') return source.filter(row => row.status === 'paid');
  if (current === 'history') return source
    .filter(row => ['dispatched','cancelled','expired'].includes(row.status))
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  return source.filter(row => ['pending','paid'].includes(row.status));
}

function _pvMatchesSearch(order, query) {
  const term = searchNorm(query);
  const termDigits = digitsOf(query);
  if (!term && !termDigits) return true;
  const text = searchNorm([
    order.number, order.customer_name, order.customer_rnc, order.customer_contact_name,
    order.customer_contact_role, order.customer_contact_phone, order.created_by_name,
    order.paid_by_name, order.salesperson_name, order.items_summary, order.notes,
  ].filter(Boolean).join(' '));
  if (term && text.includes(term)) return true;
  return termDigits.length > 0 && [order.number, order.customer_rnc]
    .some(value => digitsOf(value).includes(termDigits));
}

function _pvFlow(order) {
  if (!['pending','paid','dispatched'].includes(order.status)) return '';
  const level = order.status === 'pending' ? 2 : order.status === 'paid' ? 3 : 4;
  const steps = ['Preparada', 'En caja', 'Pagada', 'Entregada'];
  return `<div class="pv-flow">${steps.map((step, idx) => `
    <div class="pv-flow-step ${idx + 1 < level ? 'done' : idx + 1 === level ? 'current' : ''}">
      <i>${idx + 1 < level ? '✓' : idx + 1}</i><span>${step}</span>
    </div>`).join('')}</div>`;
}

function _pvCard(order) {
  const pending = order.status === 'pending';
  const paid = order.status === 'paid';
  const history = ['dispatched','cancelled','expired'].includes(order.status);
  const elapsed = _pvElapsed(paid ? order.paid_at : order.created_at);
  const timing = history ? _pvWhen(order.updated_at || order.created_at) : elapsed.label;
  return `
    <article class="pv-order ${paid ? 'is-paid' : ''} ${history ? 'is-history' : ''}">
      <div class="pv-order-head">
        <div>
          <div class="pv-number">${_pvEsc(order.number)}</div>
          <div class="pv-meta">Creada por ${_pvEsc(order.created_by_name || '—')} · ${_pvWhen(order.created_at)}</div>
        </div>
        <div class="pv-order-status">${_pvStatus(order)}<span class="pv-age ${elapsed.urgency}">${_pvEsc(timing)}</span></div>
      </div>
      ${_pvFlow(order)}
      <div class="pv-customer">${_pvEsc(order.customer_name || 'Consumidor Final')}</div>
      <div class="pv-customer-meta">${_pvEsc(order.customer_rnc || 'Sin RNC/Cédula')}${order.customer_contact_name ? ` · Solicitó: ${_pvEsc(order.customer_contact_name)}` : ''}${order.salesperson_name ? ` · Vendedor: ${_pvEsc(order.salesperson_name)}` : ''}</div>
      <div class="pv-items">${_pvEsc(order.items_summary || `${order.item_count || 0} artículos`)}</div>
      ${order.notes ? `<div class="pv-note">${svg('edit')} ${_pvEsc(order.notes)}</div>` : ''}
      <div class="pv-order-foot">
        <div>
          <strong>${fmt(order.total)}</strong>
          ${pending ? `<small>Reserva hasta ${_pvWhen(order.expires_at)}</small>` :
            paid ? `<small>Cobrada por ${_pvEsc(order.paid_by_name || '—')} · Factura #${order.sale_id || ''}</small>` :
            order.cancel_reason ? `<small>${_pvEsc(order.cancel_reason)}</small>` : ''}
        </div>
        <div class="pv-actions">
          <button class="btn btn-out btn-sm" onclick="preventaVerDetalle(${order.id})">${svg('eye')} Detalle</button>
          ${pending ? `
            <button class="btn btn-out btn-sm" onclick="preventaCancelar(${order.id})">Cancelar</button>
            <button class="btn btn-green btn-sm" onclick="preventaCobrar(${order.id})">${svg('cash')} Cobrar</button>
          ` : ''}
          ${paid ? `<button class="btn btn-green btn-sm" onclick="preventaDespachar(${order.id})">${svg('check')} Entregar</button>` : ''}
        </div>
      </div>
    </article>`;
}

function _pvPlayNotice(kind = 'pending') {
  if (DB?.settings?.checkout_notifications_sound === '0') return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.34);
    gain.connect(ctx.destination);
    [kind === 'paid' ? 740 : 620, kind === 'paid' ? 920 : 780].forEach((frequency, idx) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(ctx.currentTime + idx * 0.13);
      osc.stop(ctx.currentTime + idx * 0.13 + 0.16);
    });
    setTimeout(() => ctx.close().catch(() => {}), 700);
  } catch {}
}

function _pvTerminalId() {
  return (typeof TERMINAL_ID !== 'undefined' && TERMINAL_ID) || CFG?.terminalId || '';
}

function _pvAnnounce(rows) {
  const active = Array.isArray(rows) ? rows : [];
  const pending = active.filter(row => row.status === 'pending');
  const paid = active.filter(row => row.status === 'paid');
  const pendingIds = new Set(pending.map(row => Number(row.id)));
  const paidIds = new Set(paid.map(row => Number(row.id)));

  if (!(window._preventaKnownPendingIds instanceof Set) || !(window._preventaKnownPaidIds instanceof Set)) {
    window._preventaKnownPendingIds = pendingIds;
    window._preventaKnownPaidIds = paidIds;
    return;
  }

  const terminalId = _pvTerminalId();
  const newPending = pending.filter(row => !window._preventaKnownPendingIds.has(Number(row.id)) &&
    (!terminalId || row.origin_terminal_id !== terminalId));
  const newPaid = paid.filter(row => !window._preventaKnownPaidIds.has(Number(row.id)) &&
    (!terminalId || row.paid_terminal_id !== terminalId));

  if (newPending.length) {
    const order = newPending[0];
    _pvPlayNotice('pending');
    toast(`${newPending.length > 1 ? `${newPending.length} órdenes nuevas` : `Nueva orden ${order.number}`} para cobrar`, 's');
  }
  if (newPaid.length) {
    const order = newPaid[0];
    _pvPlayNotice('paid');
    toast(`${newPaid.length > 1 ? `${newPaid.length} órdenes pagadas` : `${order.number} pagada`} · lista para entregar`, 's');
  }
  window._preventaKnownPendingIds = pendingIds;
  window._preventaKnownPaidIds = paidIds;
}

function preventaSetView(view) {
  if (!['cashier','dispatch','all','history'].includes(view)) return;
  _preventaView = view;
  _pvRenderWorkspace();
}

function preventaSearch(value) {
  _preventaSearch = String(value || '');
  _pvRenderWorkspace();
}

function _pvRenderWorkspace() {
  const pending = _preventaRows.filter(row => row.status === 'pending');
  const paid = _preventaRows.filter(row => row.status === 'paid');
  const historyCount = _preventaRows.filter(row => ['dispatched','cancelled','expired'].includes(row.status)).length;
  _pvSetPendingCount(pending.length + paid.length);

  const metrics = document.getElementById('pv-metrics');
  if (metrics) metrics.innerHTML = `
    <button type="button" onclick="preventaSetView('cashier')"><span>Esperando cobro</span><strong>${pending.length}</strong><small>${fmt(pending.reduce((sum,row)=>sum+Number(row.total||0),0))}</small></button>
    <button type="button" onclick="preventaSetView('dispatch')"><span>Listas para entregar</span><strong>${paid.length}</strong><small>${paid.length ? 'Requieren confirmación' : 'Sin entregas pendientes'}</small></button>
    <div><span>Flujo activo</span><strong>${pending.length + paid.length}</strong><small>Órdenes en proceso</small></div>`;

  const tabs = document.getElementById('pv-tabs');
  if (tabs) {
    const defs = [
      ['cashier', 'Caja', pending.length], ['dispatch', 'Entrega', paid.length],
      ['all', 'Todo activo', pending.length + paid.length], ['history', 'Historial', historyCount],
    ];
    tabs.innerHTML = defs.map(([key,label,count]) => `
      <button class="pv-view-tab ${_preventaView === key ? 'on' : ''}" onclick="preventaSetView('${key}')">
        ${label}<span>${count}</span>
      </button>`).join('');
  }

  const host = document.getElementById('pv-content');
  if (!host) return;
  const visible = _pvRowsForView(_preventaRows, _preventaView)
    .filter(row => _pvMatchesSearch(row, _preventaSearch));
  const labels = {
    cashier: ['Órdenes esperando cobro', 'No hay órdenes esperando en caja', 'Las nuevas órdenes aparecerán aquí automáticamente.'],
    dispatch: ['Pagadas y listas para entregar', 'No hay mercancía pendiente de entrega', 'Al cobrar una orden, aparecerá aquí automáticamente.'],
    all: ['Flujo activo', 'El flujo está al día', 'No hay órdenes pendientes de cobro ni entrega.'],
    history: ['Historial reciente', 'No hay resultados en el historial', 'Las órdenes entregadas, canceladas y vencidas se conservarán aquí.'],
  };
  const [title, emptyTitle, emptySub] = labels[_preventaView] || labels.all;
  host.innerHTML = visible.length
    ? `<div class="pv-section"><h3>${title} · ${visible.length}</h3><div class="pv-grid">${visible.map(_pvCard).join('')}</div></div>`
    : `<div class="pv-empty">${svg('check')}<strong>${_preventaSearch ? 'No se encontraron coincidencias' : emptyTitle}</strong><span>${_preventaSearch ? 'Prueba con el número, cliente, RNC, artículo o vendedor.' : emptySub}</span></div>`;
}

async function renderPreventa(el) {
  _preventaRoot = el;
  if (_preventaView === 'auto') _preventaView = _pvDefaultView();
  if (window._preventaRefreshTimer) clearInterval(window._preventaRefreshTimer);
  window._preventaRefreshTimer = setInterval(() => {
    if (page === 'preventa') _pvRenderContent();
  }, 30000);
  el.innerHTML = `
    <div class="pv-page">
      <div class="pv-hero">
        <div>
          <div class="pv-title">Preventa y despacho</div>
          <div class="pv-sub">Preparación → cobro en caja → entrega confirmada, sincronizado entre terminales.</div>
        </div>
        <button class="btn btn-green" onclick="routeTo('pos')">${svg('plus')} Preparar orden</button>
      </div>
      <div class="pv-metrics" id="pv-metrics"></div>
      <div class="pv-workbar">
        <div class="pv-view-tabs" id="pv-tabs"></div>
        <div class="inp-ic pv-search"><div class="ic">${svg('search')}</div>
          <input class="inp" type="search" value="${_pvEsc(_preventaSearch)}" placeholder="Orden, cliente, RNC, artículo o vendedor..." oninput="preventaSearch(this.value)"/>
        </div>
        <button class="btn btn-out btn-sm" onclick="_pvRenderContent()" title="Actualizar">${svg('refresh')} Actualizar</button>
      </div>
      <div id="pv-content" class="pv-loading">Cargando órdenes compartidas...</div>
    </div>`;
  await _pvRenderContent();
}

async function _pvRenderContent() {
  if (_preventaLoading) return;
  const host = document.getElementById('pv-content');
  if (!host) return;
  _preventaLoading = true;
  try {
    const rows = await _pvLoad(['pending','paid','dispatched','cancelled','expired'], 250);
    _preventaRows = rows;
    _pvAnnounce(rows.filter(row => ['pending','paid'].includes(row.status)));
    if (typeof reloadProducts === 'function') await reloadProducts().catch(() => {});
    _pvRenderWorkspace();
  } catch (e) {
    host.innerHTML = `<div class="alrt r"><div><div class="alrt-title">No se pudo cargar Preventa</div><div class="alrt-sub">${_pvEsc(e.message)}</div></div></div>`;
  } finally {
    _preventaLoading = false;
  }
}

async function preventaHandleSync() {
  if (!preventaCanAccess()) {
    _pvSetPendingCount(0);
    return;
  }
  try {
    if (typeof page !== 'undefined' && page === 'preventa') {
      await _pvRenderContent();
      return;
    }
    const rows = await _pvLoad(['pending','paid']);
    _pvAnnounce(rows);
    _pvSetPendingCount(rows.length);
  } catch {}
}

function preventaConfigureMonitor() {
  if (window._preventaBadgeTimer) {
    clearInterval(window._preventaBadgeTimer);
    window._preventaBadgeTimer = null;
  }
  if (!preventaCanAccess()) {
    _pvSetPendingCount(0);
    return;
  }
  preventaHandleSync();
  window._preventaBadgeTimer = setInterval(preventaHandleSync, 30000);
}

async function preventaVerDetalle(id) {
  const res = await window.api.checkout.getById({ id, requestUserId: user.id });
  if (!res?.ok) return toast(res?.error || 'No se pudo abrir la orden', 'err');
  const order = res.data;
  openModal(`
    <div class="modal-title">${_pvEsc(order.number)} · ${_pvEsc(order.customer_name || 'Consumidor Final')}</div>
    <div class="modal-sub">${_pvStatus(order)} · creada ${_pvWhen(order.created_at)} por ${_pvEsc(order.created_by_name || '—')}</div>
    ${_pvFlow(order)}
    <div class="card" style="background:var(--surface2);margin:14px 0">
      <div class="tr"><span>Cliente</span><strong>${_pvEsc(order.customer_name || 'Consumidor Final')}</strong></div>
      <div class="tr"><span>RNC / Cédula</span><span>${_pvEsc(order.customer_rnc || '—')}</span></div>
      ${order.customer_contact_name ? `<div class="tr"><span>Representante</span><strong>${_pvEsc(order.customer_contact_name)}${order.customer_contact_role ? ` · ${_pvEsc(order.customer_contact_role)}` : ''}</strong></div>` : ''}
      ${order.salesperson_name ? `<div class="tr"><span>Vendedor</span><span>${_pvEsc(order.salesperson_name)}</span></div>` : ''}
      ${order.notes ? `<div class="tr"><span>Nota</span><span>${_pvEsc(order.notes)}</span></div>` : ''}
    </div>
    <div class="tw"><table><thead><tr><th>Código</th><th>Artículo</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead>
      <tbody>${(order.items || []).map(item => `<tr><td>${_pvEsc(item.product_code || '—')}</td><td>${_pvEsc(item.product_name)}</td><td class="num">${item.qty}</td><td class="num">${fmt(item.unit_price)}</td><td class="num">${fmt(Number(item.unit_price) * Number(item.qty))}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="card" style="background:var(--surface2);margin-top:12px">
      ${Number(order.discount_amt) > 0 ? `<div class="tr"><span>Descuento</span><span>−${fmt(order.discount_amt)}</span></div>` : ''}
      <div class="tr"><span>Subtotal sin ITBIS</span><span>${fmt(order.subtotal)}</span></div>
      <div class="tr"><span>ITBIS incluido</span><span>${fmt(order.tax_amt)}</span></div>
      <div class="tr grand"><span>TOTAL</span><span>${fmt(order.total)}</span></div>
    </div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>
  `, 'modal-lg');
}

async function preventaCobrar(id) {
  if (!cajaOpen) {
    toast('Abre la caja de esta terminal antes de cobrar', 'w');
    routeTo('caja');
    return;
  }
  const res = await window.api.checkout.getById({ id, requestUserId: user.id });
  if (!res?.ok || res.data?.status !== 'pending') {
    toast(res?.error || 'La orden ya no está pendiente', 'err');
    await _pvRenderContent();
    return;
  }
  const order = res.data;
  let target = currentInv();
  if (target.cart.length || target.checkoutOrderId) {
    addInvoice();
    target = currentInv();
  }
  const tabId = target.id;
  invoices[activeInvoice] = {
    ...newInvObj(tabId), checkoutOrderId: order.id, checkoutOrderNumber: order.number,
    checkoutLocked: true,
    cart: (order.items || []).map(item => ({
      pid: item.product_id, product_id: item.product_id, code: item.product_code,
      product_code: item.product_code, name: item.product_name, product_name: item.product_name,
      cost: item.unit_cost, unit_cost: item.unit_cost, price: item.unit_price, unit_price: item.unit_price,
      qty: item.qty, taxable: item.taxable, tax_pct: item.tax_pct,
    })),
    cliId: order.customer_id || 1, cliName: order.customer_name || 'Consumidor Final',
    cliCedula: order.customer_rnc || '', pmode: order.price_mode || 'retail',
    cliContactId: order.customer_contact_id || null,
    cliContactName: order.customer_contact_name || '',
    cliContactRole: order.customer_contact_role || '',
    cliContactPhone: order.customer_contact_phone || '',
    disc: Number(order.discount_pct) || 0, salespersonId: order.salesperson_id || null, itype: 'factura',
  };
  routeTo('pos');
  setTimeout(() => openCobroModal(currentInv()), 80);
}

async function preventaCancelar(id) {
  const reason = await askText('La reserva de inventario se liberará inmediatamente.', {
    title: 'Cancelar orden de cobro', placeholder: 'Motivo de cancelación'
  });
  if (reason === null) return;
  const res = await window.api.checkout.cancel({ id, reason, requestUserId: user.id });
  if (!res?.ok) return toast(res?.error || 'No se pudo cancelar', 'err');
  toast('Orden cancelada y reserva liberada');
  await _pvRenderContent();
}

function preventaDespachar(id) {
  confirmModal('¿Confirmar que la mercancía fue entregada al cliente?',
    () => _preventaConfirmarDespacho(id), 'Sí, entregar', 'btn-green');
}

async function _preventaConfirmarDespacho(id) {
  const res = await window.api.checkout.dispatch({ id, requestUserId: user.id });
  if (!res?.ok) return toast(res?.error || 'No se pudo marcar como entregada', 'err');
  toast('✓ Mercancía entregada al cliente');
  await _pvRenderContent();
}
