// ════════════════════════════════════════════════════════════════════════════
// experience.js — Experiencia transversal de Velo POS
// Preferencias visuales, drawers, alertas, acciones rápidas y tablas inteligentes.
// No contiene reglas de negocio: consume el estado y las APIs públicas existentes.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  const PREF_KEY = 'vp_ui_preferences_v2';
  const WORKSPACE_KEY = 'vp_ui_workspace_v1';
  const DEFAULTS = { theme: 'light', density: 'comfortable', motion: 'full' };
  const ROUTES = {
    dash:{ label:'Dashboard', icon:'grid', group:'Resumen' }, pos:{ label:'Punto de Venta', icon:'monitor', group:'Operación' },
    inventario:{ label:'Inventario', icon:'box', group:'Gestión' }, compras:{ label:'Compras', icon:'truck', group:'Gestión' },
    clientes:{ label:'Clientes', icon:'users', group:'Gestión' }, ventas:{ label:'Ventas', icon:'list', group:'Gestión' },
    devoluciones:{ label:'Devoluciones', icon:'return', group:'Gestión' }, vendedores:{ label:'Vendedores', icon:'users', group:'Equipo' },
    comisiones:{ label:'Comisiones', icon:'trend', group:'Equipo' }, nomina:{ label:'Nómina', icon:'calendar', group:'Finanzas' },
    caja:{ label:'Caja', icon:'cash', group:'Finanzas' }, gastos:{ label:'Gastos', icon:'dollar', group:'Finanzas' },
    bancos:{ label:'Bancos y Cuentas', icon:'bank', group:'Finanzas' }, contabilidad:{ label:'Contabilidad', icon:'ledger', group:'Finanzas' },
    vehiculos:{ label:'Vehículos', icon:'car', group:'Operación' }, envios:{ label:'Envíos', icon:'truck', group:'Operación' },
    conduce:{ label:'Conduces', icon:'pkg', group:'Operación' }, preventa:{ label:'Preventa y Despacho', icon:'cash', group:'Operación' }, sucursales:{ label:'Sucursales', icon:'building', group:'Operación' },
    reportes:{ label:'Reportes', icon:'chart', group:'Análisis' }, etiquetas:{ label:'Etiquetas', icon:'barcode', group:'Sistema' },
    configuracion:{ label:'Configuración', icon:'settings', group:'Sistema' }, auditoria:{ label:'Auditoría', icon:'alert', group:'Sistema' },
    superadmin:{ label:'Panel Dev', icon:'code', group:'Sistema' },
  };
  let observer = null;

  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const stateDB = () => { try { return typeof DB !== 'undefined' ? DB : (window.DB || {}); } catch { return {}; } };
  const stateCFG = () => { try { return typeof CFG !== 'undefined' ? CFG : (window.CFG || {}); } catch { return {}; } };
  const currentUser = () => {
    try {
      if (typeof user !== 'undefined' && user) return user;
      if (window._currentUser) return window._currentUser;
      return JSON.parse(sessionStorage.getItem('vp_user') || 'null');
    } catch { return null; }
  };
  const cashIsOpen = () => { try { return typeof cajaOpen !== 'undefined' ? !!cajaOpen : false; } catch { return false; } };

  function loadPreferences() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
    catch { return { ...DEFAULTS }; }
  }

  function applyPreferences(next = null) {
    const prefs = next ? { ...loadPreferences(), ...next } : loadPreferences();
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
    document.body.classList.toggle('ui-dark', prefs.theme === 'dark');
    document.body.classList.toggle('ui-compact', prefs.density === 'compact');
    document.body.classList.toggle('ui-reduced-motion', prefs.motion === 'reduced');
    document.documentElement.style.colorScheme = prefs.theme === 'dark' ? 'dark' : 'light';
    return prefs;
  }

  function loadWorkspace() {
    try { return { favorites:[], recent:[], ...JSON.parse(localStorage.getItem(workspaceStorageKey()) || '{}') }; }
    catch { return { favorites:[], recent:[] }; }
  }

  function workspaceStorageKey() {
    const who = currentUser()?.id || currentUser()?.email || 'terminal';
    const business = stateCFG().activeBusinessId || 'principal';
    return `${WORKSPACE_KEY}:${business}:${who}`;
  }

  function saveWorkspace(next) {
    const safe = {
      favorites:[...new Set((next.favorites || []).filter(x => ROUTES[x]))].slice(0,6),
      recent:[...new Set((next.recent || []).filter(x => ROUTES[x]))].slice(0,6),
    };
    try { localStorage.setItem(workspaceStorageKey(), JSON.stringify(safe)); } catch {}
    return safe;
  }

  function accessibleRoutes() {
    const keys = [...document.querySelectorAll('.nav-item[data-key]')].map(x => x.dataset.key).filter(x => ROUTES[x]);
    if (keys.length) return [...new Set(keys)];
    return ['dash','pos','inventario','clientes','ventas','caja'];
  }

  function onRoute(route) {
    if (!ROUTES[route]) return;
    const state = loadWorkspace();
    state.recent = [route, ...state.recent.filter(x => x !== route)];
    saveWorkspace(state);
  }

  function toggleFavorite(route) {
    if (!ROUTES[route] || !accessibleRoutes().includes(route)) return loadWorkspace();
    const state = loadWorkspace();
    state.favorites = state.favorites.includes(route)
      ? state.favorites.filter(x => x !== route)
      : [route, ...state.favorites];
    return saveWorkspace(state);
  }

  function goRoute(route) {
    closeDrawer();
    try { if (typeof _closeGSearch === 'function') _closeGSearch(); } catch {}
    if (accessibleRoutes().includes(route) && typeof routeTo === 'function') routeTo(route);
  }

  function routeCards(keys, state, compact = false) {
    return keys.filter(key => ROUTES[key]).map(key => {
      const item = ROUTES[key];
      const favorite = state.favorites.includes(key);
      return `<div class="ux-work-route ${compact ? 'compact' : ''}">
        <button data-ux-route="${key}" data-gsearch-item><span>${svg(item.icon)}</span><span><strong>${esc(item.label)}</strong><small>${esc(item.group)}</small></span></button>
        <button class="ux-favorite ${favorite ? 'on' : ''}" data-ux-toggle-fav="${key}" title="${favorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}">${favorite ? '★' : '☆'}</button>
      </div>`;
    }).join('');
  }

  function searchHome() {
    const state = loadWorkspace();
    const allowed = accessibleRoutes();
    const favorites = state.favorites.filter(x => allowed.includes(x));
    const recent = state.recent.filter(x => allowed.includes(x) && !favorites.includes(x)).slice(0,4);
    const suggested = allowed.filter(x => !favorites.includes(x) && !recent.includes(x)).slice(0,6);
    return `<div class="ux-search-home">
      <div class="ux-search-welcome"><span>${svg('search')}</span><div><strong>¿A dónde quieres ir?</strong><small>Busca información o navega por todo Velo POS.</small></div></div>
      ${favorites.length ? `<section><div class="ux-section-label">Favoritos</div><div class="ux-route-grid">${routeCards(favorites,state,true)}</div></section>` : ''}
      ${recent.length ? `<section><div class="ux-section-label">Usados recientemente</div><div class="ux-route-grid">${routeCards(recent,state,true)}</div></section>` : ''}
      <section><div class="ux-section-label">Módulos disponibles</div><div class="ux-route-grid">${routeCards(suggested,state,true)}</div></section>
      <div class="ux-search-tip"><kbd>⌘</kbd><kbd>J</kbd><span>para crear rápidamente</span><button data-ux-command-center data-gsearch-item>Ver centro de mando →</button></div>
    </div>`;
  }

  function bindSearchHome(root) {
    if (!root) return;
    root.querySelectorAll('[data-ux-route]').forEach(btn => btn.onclick = () => goRoute(btn.dataset.uxRoute));
    root.querySelectorAll('[data-ux-toggle-fav]').forEach(btn => btn.onclick = e => {
      e.stopPropagation(); toggleFavorite(btn.dataset.uxToggleFav); root.innerHTML = searchHome(); bindSearchHome(root);
    });
    const center = root.querySelector('[data-ux-command-center]');
    if (center) center.onclick = () => { try { _closeGSearch(); } catch {} openCommandCenter(); };
  }

  function money(value) {
    try { return typeof fmt === 'function' ? fmt(Number(value || 0)) : new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(value || 0); }
    catch { return `RD$${Number(value || 0).toFixed(2)}`; }
  }

  function operationalSnapshot(items = []) {
    const db = stateDB();
    const products = (db.products || []).filter(x => x.active !== 0);
    const stockRisk = products.filter(x => Number(x.stock || 0) <= Number(x.stock_min || 5)).length;
    const sales = (db.sales || []).filter(x => x.status !== 'cancelled' && x.type !== 'devolucion' && x.type !== 'cotizacion');
    const salesTotal = sales.reduce((sum,x) => sum + Number(x.total || 0), 0);
    const receivable = (db.customers || []).reduce((sum,x) => sum + Math.max(0,Number(x.balance || 0)), 0);
    const severe = items.filter(x => x.priority === 1).length;
    const medium = items.filter(x => x.priority === 2).length;
    const score = Math.max(35, Math.min(100, 100 - severe * 12 - medium * 5 - Math.min(stockRisk,10)));
    return { products:products.length, stockRisk, sales:sales.length, salesTotal, receivable, score,
      tone:score >= 85 ? 'good' : score >= 65 ? 'warn' : 'risk',
      label:score >= 85 ? 'Operación saludable' : score >= 65 ? 'Requiere seguimiento' : 'Atención prioritaria' };
  }

  async function openCommandCenter() {
    const body = openDrawer({ id:'command-center', title:'Centro de mando', subtitle:'Tu negocio, prioridades y accesos en un solo lugar', width:'570px', content:loading('Preparando resumen ejecutivo…') });
    const items = await collectNotifications();
    if (!body?.isConnected) return;
    const snap = operationalSnapshot(items);
    const state = loadWorkspace();
    const allowed = accessibleRoutes();
    const favorites = state.favorites.filter(x => allowed.includes(x));
    const recent = state.recent.filter(x => allowed.includes(x) && !favorites.includes(x)).slice(0,5);
    body.innerHTML = `<div class="ux-command-hero ${snap.tone}">
      <div class="ux-command-ring" style="--score:${snap.score}"><span>${snap.score}</span></div>
      <div><small>SALUD OPERATIVA</small><h3>${esc(snap.label)}</h3><p>${items.length ? `${items.length} asunto${items.length === 1 ? '' : 's'} identificado${items.length === 1 ? '' : 's'} para revisar.` : 'No se detectaron pendientes importantes.'}</p></div>
      <button data-ux-quick>${svg('plus')} Crear</button>
    </div>
    <div class="ux-command-stats">
      <button data-ux-route="ventas"><small>VENTAS CARGADAS</small><strong>${money(snap.salesTotal)}</strong><span>${snap.sales} transacciones</span></button>
      <button data-ux-route="inventario"><small>INVENTARIO</small><strong>${snap.products}</strong><span class="${snap.stockRisk ? 'risk' : ''}">${snap.stockRisk} en riesgo</span></button>
      <button data-ux-route="clientes"><small>POR COBRAR</small><strong>${money(snap.receivable)}</strong><span>balance abierto</span></button>
    </div>
    <section class="ux-command-section"><div class="ux-command-title"><div><small>SIGUIENTE MEJOR ACCIÓN</small><strong>${items.length ? 'Prioridades recomendadas' : 'Operación al día'}</strong></div><button data-ux-notifications>Ver todas</button></div>
      ${items.length ? `<div class="ux-command-priorities">${items.slice(0,4).map((item,index) => `<button class="ux-command-priority ux-tone-${item.tone}" data-priority-index="${index}"><span>${svg(item.icon)}</span><div><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div><b>›</b></button>`).join('')}</div>` : `<div class="ux-command-clear">${svg('check')} Todo bajo control. Puedes concentrarte en vender y atender clientes.</div>`}
    </section>
    <section class="ux-command-section"><div class="ux-command-title"><div><small>MI ESPACIO</small><strong>Favoritos y recientes</strong></div><span>${favorites.length}/6 favoritos</span></div>
      <div class="ux-command-routes">${routeCards(favorites.length ? favorites : recent,state,true) || '<p class="ux-command-empty">Abre la búsqueda con ⌘K y marca módulos con ☆ para personalizar este espacio.</p>'}</div>
      ${favorites.length && recent.length ? `<div class="ux-command-recent"><span>Recientes</span>${recent.map(key => `<button data-ux-route="${key}">${esc(ROUTES[key].label)}</button>`).join('')}</div>` : ''}
    </section>`;
    body.querySelectorAll('[data-ux-route]').forEach(btn => btn.onclick = () => goRoute(btn.dataset.uxRoute));
    body.querySelectorAll('[data-ux-toggle-fav]').forEach(btn => btn.onclick = e => { e.stopPropagation(); toggleFavorite(btn.dataset.uxToggleFav); openCommandCenter(); });
    body.querySelectorAll('[data-priority-index]').forEach(btn => btn.onclick = () => goNotification(items[Number(btn.dataset.priorityIndex)]));
    body.querySelector('[data-ux-notifications]')?.addEventListener('click',openNotifications);
    body.querySelector('[data-ux-quick]')?.addEventListener('click',openQuickActions);
  }

  function loading(label = 'Preparando información…') {
    return `<div class="ux-loading" role="status" aria-live="polite">
      <div class="ux-skeleton ux-skeleton-title"></div>
      <div class="ux-skeleton-grid">${Array.from({ length: 4 }, () => '<div class="ux-skeleton ux-skeleton-card"></div>').join('')}</div>
      <div class="ux-skeleton ux-skeleton-table"></div><span>${esc(label)}</span>
    </div>`;
  }

  function closeDrawer() {
    const layer = document.getElementById('ux-drawer-layer');
    if (!layer) return;
    layer.classList.add('closing');
    setTimeout(() => layer.remove(), 150);
  }

  function openDrawer({ title, subtitle = '', content = '', width = '430px', id = '' }) {
    closeDrawer();
    const layer = document.createElement('div');
    layer.className = 'ux-drawer-layer';
    layer.id = 'ux-drawer-layer';
    layer.dataset.drawer = id;
    layer.innerHTML = `<div class="ux-drawer-backdrop" data-ux-close></div>
      <aside class="ux-drawer" style="--ux-drawer-width:${esc(width)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="ux-drawer-head"><div><div class="ux-drawer-title">${esc(title)}</div>
          ${subtitle ? `<div class="ux-drawer-sub">${esc(subtitle)}</div>` : ''}</div>
          <button class="ux-icon-btn" data-ux-close aria-label="Cerrar">${typeof svg === 'function' ? svg('xmark') : '×'}</button></header>
        <div class="ux-drawer-body"></div>
      </aside>`;
    const body = layer.querySelector('.ux-drawer-body');
    if (content instanceof Node) body.appendChild(content);
    else body.innerHTML = content;
    layer.addEventListener('click', e => { if (e.target.closest('[data-ux-close]')) closeDrawer(); });
    document.body.appendChild(layer);
    requestAnimationFrame(() => layer.classList.add('open'));
    return body;
  }

  function notificationCount() {
    const db = stateDB();
    const low = (db.products || []).filter(p => p.active !== 0 && Number(p.stock || 0) <= Number(p.stock_min || 5)).length;
    const credit = typeof getCreditAlerts === 'function' ? getCreditAlerts().length : 0;
    return low + credit + (cashIsOpen() ? 0 : 1);
  }

  async function collectNotifications() {
    const items = [];
    const cfg = stateCFG();
    const products = (stateDB().products || []).filter(p => p.active !== 0);
    const out = products.filter(p => Number(p.stock || 0) <= 0);
    const low = products.filter(p => Number(p.stock || 0) > 0 && Number(p.stock || 0) <= Number(p.stock_min || 5));
    if (out.length) items.push({ tone:'red', icon:'box', title:`${out.length} producto${out.length === 1 ? '' : 's'} sin existencia`,
      detail:'No pueden venderse hasta registrar una entrada.', route:'inventario', tab:'sin_stock', priority:1 });
    if (low.length) items.push({ tone:'amber', icon:'alert', title:`${low.length} producto${low.length === 1 ? '' : 's'} con stock bajo`,
      detail:'Conviene preparar reposición antes de agotar existencias.', route:'inventario', tab:'bajo', priority:2 });

    const credits = typeof getCreditAlerts === 'function' ? getCreditAlerts() : [];
    const overdue = credits.filter(a => a.status === 'overdue');
    const soon = credits.filter(a => a.status === 'soon');
    if (overdue.length) items.push({ tone:'red', icon:'dollar', title:`${overdue.length} crédito${overdue.length === 1 ? '' : 's'} vencido${overdue.length === 1 ? '' : 's'}`,
      detail:'Revisa las cuentas por cobrar y programa seguimiento.', route:'clientes', tab:'credito', priority:1 });
    if (soon.length) items.push({ tone:'amber', icon:'calendar', title:`${soon.length} crédito${soon.length === 1 ? '' : 's'} próximo${soon.length === 1 ? '' : 's'} a vencer`,
      detail:'Vencen dentro de los próximos cinco días.', route:'clientes', tab:'credito', priority:2 });
    if (!cashIsOpen()) items.push({ tone:'blue', icon:'cash', title:'Caja pendiente de apertura',
      detail:'Abre una sesión para comenzar a cobrar ventas.', route:'caja', priority:2 });

    if (window.api?.expenses && cfg.module_gastos === '1') {
      try {
        const res = await window.api.expenses.getPayable({ requestUserId: currentUser()?.id });
        const payable = res?.data || [];
        const pending = payable.filter(x => !['pagado','anulado','rechazado'].includes(String(x.status || '').toLowerCase()));
        const overduePayable = pending.filter(x => x.due_date && x.due_date < (typeof today === 'function' ? today() : new Date().toISOString().slice(0,10)));
        if (overduePayable.length) items.push({ tone:'red', icon:'receipt', title:`${overduePayable.length} cuenta${overduePayable.length === 1 ? '' : 's'} por pagar vencida${overduePayable.length === 1 ? '' : 's'}`,
          detail:'Obligaciones vencidas que requieren programación de pago.', route:'gastos', expenseTab:'por_pagar', priority:1 });
        else if (pending.length) items.push({ tone:'purple', icon:'receipt', title:`${pending.length} cuenta${pending.length === 1 ? '' : 's'} pendiente${pending.length === 1 ? '' : 's'}`,
          detail:'Compromisos registrados en cuentas por pagar.', route:'gastos', expenseTab:'por_pagar', priority:3 });
      } catch {}
    }

    if (window.api?.salespeople && cfg.module_vendedores === '1') {
      try {
        const [comm, payroll] = await Promise.all([
          window.api.salespeople.getCommissionRuns({}), window.api.salespeople.getPayrollRuns()
        ]);
        const pendingComm = (comm?.data || []).filter(x => x.status === 'borrador').length;
        const pendingPayroll = (payroll?.data || []).filter(x => ['borrador','aprobado'].includes(x.status)).length;
        if (pendingComm) items.push({ tone:'purple', icon:'trend', title:`${pendingComm} comisión${pendingComm === 1 ? '' : 'es'} por aprobar`,
          detail:'Liquidaciones calculadas pendientes de validación.', route:'comisiones', commissionTab:'liquidaciones', priority:2 });
        if (pendingPayroll) items.push({ tone:'blue', icon:'calendar', title:`${pendingPayroll} nómina${pendingPayroll === 1 ? '' : 's'} pendiente${pendingPayroll === 1 ? '' : 's'}`,
          detail:'Borradores o pagos aprobados aún sin completar.', route:'nomina', payrollTab:'periodos', priority:2 });
      } catch {}
    }
    return items.sort((a,b) => a.priority - b.priority);
  }

  function goNotification(item) {
    closeDrawer();
    if (item.tab && item.route === 'inventario') { try { invTab = item.tab; } catch {} }
    if (item.tab === 'credito' && item.route === 'clientes') window._cliTabInicial = 'credito';
    if (item.expenseTab) { try { _gastosTab = item.expenseTab; } catch {} }
    if (typeof routeTo === 'function') routeTo(item.route);
    if (item.sellerTab) setTimeout(() => window._venSetTab?.(item.sellerTab), 350);
    if (item.commissionTab) setTimeout(() => window._comSetTab?.(item.commissionTab), 350);
    if (item.payrollTab) setTimeout(() => window._nomSetTab?.(item.payrollTab), 350);
  }

  async function openNotifications() {
    const body = openDrawer({ id:'notifications', title:'Centro de notificaciones',
      subtitle:'Prioridades conectadas con la operación real', content:loading('Analizando el negocio…') });
    const items = await collectNotifications();
    if (!body?.isConnected) return;
    body.innerHTML = items.length ? `<div class="ux-notice-summary"><strong>${items.length}</strong><span>asuntos requieren atención</span></div>
      <div class="ux-notice-list"></div>` : `<div class="ux-drawer-empty"><div>${svg('check')}</div><h3>Todo bajo control</h3><p>No hay alertas operativas pendientes.</p></div>`;
    const list = body.querySelector('.ux-notice-list');
    items.forEach((item, index) => {
      const row = document.createElement('button');
      row.className = `ux-notice ux-tone-${item.tone}`;
      row.innerHTML = `<span class="ux-notice-icon">${svg(item.icon)}</span><span class="ux-notice-copy"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span><span class="ux-notice-arrow">›</span>`;
      row.onclick = () => goNotification(item);
      row.style.setProperty('--delay', `${index * 25}ms`);
      list.appendChild(row);
    });
  }

  function quickActions() {
    const cfg = stateCFG();
    const admin = ['admin','superadmin'].includes(currentUser()?.role);
    return [
      { key:'sale', icon:'monitor', title:'Nueva venta', sub:'Abrir el punto de venta', show:true },
      { key:'product', icon:'box', title:'Nuevo producto', sub:'Registrar en inventario', show:admin },
      { key:'customer', icon:'users', title:'Nuevo cliente', sub:'Crear perfil y crédito', show:true },
      { key:'expense', icon:'dollar', title:'Registrar gasto', sub:'Egreso o cuenta por pagar', show:cfg.module_gastos === '1' },
      { key:'seller', icon:'user', title:'Nuevo vendedor', sub:'Fijo o ambulante', show:admin && cfg.module_vendedores === '1' },
      { key:'shipment', icon:'truck', title:'Nuevo envío', sub:'Crear despacho', show:cfg.module_envios === '1' },
      { key:'delivery', icon:'pkg', title:'Nuevo conduce', sub:'Nota de entrega', show:cfg.module_conduce === '1' },
    ].filter(x => x.show);
  }

  function runQuickAction(key) {
    closeDrawer();
    const later = fn => setTimeout(fn, 320);
    if (key === 'sale') return routeTo('pos');
    if (key === 'product') { routeTo('inventario'); return later(() => window.openProductoModal?.()); }
    if (key === 'customer') { routeTo('clientes'); return later(() => window.openClienteModal?.()); }
    if (key === 'expense') { routeTo('gastos'); return later(() => window.modalNuevoGasto?.(document.getElementById('page'), currentUser())); }
    if (key === 'seller') { routeTo('vendedores'); return later(() => window.vendedoresOpenSeller?.()); }
    if (key === 'shipment') { routeTo('envios'); return later(() => window.modalNuevoEnvio?.(document.getElementById('page'), window._enviosVehiculos || [])); }
    if (key === 'delivery') { routeTo('conduce'); return later(() => window._cndOpenForm?.()); }
  }

  function openQuickActions() {
    const actions = quickActions();
    const body = openDrawer({ id:'quick', title:'Crear rápidamente', subtitle:'Acciones frecuentes desde cualquier módulo',
      width:'390px', content:`<div class="ux-quick-grid">${actions.map(a => `<button class="ux-quick-action" data-quick="${a.key}">
        <span>${svg(a.icon)}</span><strong>${esc(a.title)}</strong><small>${esc(a.sub)}</small></button>`).join('')}</div>
        <div class="ux-key-hint"><kbd>⌘</kbd><kbd>J</kbd><span>abre este centro desde cualquier pantalla</span></div>` });
    body.querySelectorAll('[data-quick]').forEach(btn => btn.onclick = () => runQuickAction(btn.dataset.quick));
  }

  function preferenceOptions(group, options, current) {
    return `<div class="ux-pref-options">${options.map(o => `<button class="ux-pref-option ${current === o.value ? 'on' : ''}" data-pref="${group}" data-value="${o.value}">
      <span class="ux-pref-preview ${o.preview || ''}"></span><strong>${o.label}</strong><small>${o.sub}</small></button>`).join('')}</div>`;
  }

  function openAppearance() {
    const prefs = loadPreferences();
    const body = openDrawer({ id:'appearance', title:'Apariencia y comodidad', subtitle:'Preferencias guardadas en esta terminal', width:'460px', content:`
      <section class="ux-pref-section"><h3>Tema</h3>${preferenceOptions('theme',[
        {value:'light',label:'Claro',sub:'Máxima luminosidad',preview:'light'}, {value:'dark',label:'Oscuro',sub:'Menor fatiga nocturna',preview:'dark'}],prefs.theme)}</section>
      <section class="ux-pref-section"><h3>Densidad</h3>${preferenceOptions('density',[
        {value:'comfortable',label:'Cómoda',sub:'Más aire y lectura',preview:'comfortable'}, {value:'compact',label:'Compacta',sub:'Más datos visibles',preview:'compact'}],prefs.density)}</section>
      <section class="ux-pref-section"><h3>Movimiento</h3>${preferenceOptions('motion',[
        {value:'full',label:'Suave',sub:'Transiciones discretas',preview:'motion-full'},
        {value:'reduced',label:'Reducido',sub:'Sin animaciones',preview:'motion-reduced'}],prefs.motion)}</section>
      <div class="ux-pref-note">Los cambios se aplican inmediatamente y no afectan a otros usuarios o terminales.</div>
      <button class="ux-pref-guide" data-guide-open>${svg('help')}<span><strong>Guía y recorridos</strong><small>Conoce las mejoras o repasa un flujo</small></span><b>›</b></button>` });
    body.querySelectorAll('[data-pref]').forEach(btn => btn.onclick = () => {
      const next = applyPreferences({ [btn.dataset.pref]: btn.dataset.value });
      body.querySelectorAll(`[data-pref="${btn.dataset.pref}"]`).forEach(x => x.classList.toggle('on', x.dataset.value === next[btn.dataset.pref]));
    });
    body.querySelector('[data-guide-open]')?.addEventListener('click',() => window.experienceOpenGuide?.());
  }

  function sortTable(table, column, th) {
    const tbody = table.tBodies?.[0];
    if (!tbody) return;
    const asc = th.dataset.sortDirection !== 'asc';
    table.querySelectorAll('th').forEach(x => { delete x.dataset.sortDirection; x.classList.remove('ux-sort-asc','ux-sort-desc'); });
    th.dataset.sortDirection = asc ? 'asc' : 'desc';
    th.classList.add(asc ? 'ux-sort-asc' : 'ux-sort-desc');
    const parse = text => {
      const clean = text.trim().replace(/RD\$|US\$|[$,%]/g,'').replace(/,/g,'');
      const n = Number(clean); return clean && Number.isFinite(n) ? n : text.trim().toLocaleLowerCase('es');
    };
    [...tbody.rows].sort((a,b) => {
      const av = parse(a.cells[column]?.innerText || ''); const bv = parse(b.cells[column]?.innerText || '');
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv),'es',{numeric:true});
      return asc ? cmp : -cmp;
    }).forEach(row => tbody.appendChild(row));
  }

  function openTableColumns(table) {
    const headers = [...table.querySelectorAll('thead th')];
    const body = openDrawer({ id:'columns', title:'Vista de la tabla', subtitle:'Elige las columnas visibles en esta pantalla', width:'390px', content:`
      <div class="ux-column-list">${headers.map((th,i) => `<label><input type="checkbox" data-col="${i}" ${th.hidden ? '' : 'checked'} ${headers.length <= 2 ? 'disabled' : ''}>
        <span>${esc(th.innerText.trim() || `Columna ${i+1}`)}</span></label>`).join('')}</div>
      <div class="ux-pref-note">Puedes ordenar los datos haciendo clic en cualquier encabezado.</div>` });
    body.querySelectorAll('[data-col]').forEach(input => input.onchange = () => {
      const idx = Number(input.dataset.col);
      [...table.rows].forEach(row => { if (row.cells[idx]) row.cells[idx].hidden = !input.checked; });
    });
  }

  function enhanceTable(table) {
    if (table.dataset.uxEnhanced || !table.tHead || !table.tBodies.length) return;
    table.dataset.uxEnhanced = '1';
    table.classList.add('ux-smart-table');
    [...table.querySelectorAll('thead th')].forEach((th,index) => {
      if (!th.innerText.trim()) return;
      th.classList.add('ux-sortable'); th.title = 'Ordenar por esta columna'; th.tabIndex = 0;
      const run = () => sortTable(table,index,th);
      th.addEventListener('click',run); th.addEventListener('keydown',e => { if (e.key === 'Enter') run(); });
    });
    const wrap = table.closest('.tw');
    if (!wrap || wrap.querySelector(':scope > .ux-table-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'ux-table-bar';
    const rows = table.tBodies[0]?.rows.length || 0;
    bar.innerHTML = `<span>${rows} registro${rows === 1 ? '' : 's'}</span><button type="button">${svg('filter')} Columnas</button>`;
    bar.querySelector('button').onclick = () => openTableColumns(table);
    wrap.insertBefore(bar, table);
  }

  function enhancePage(root = document.getElementById('page')) {
    if (!root) return;
    root.querySelectorAll('.tw table').forEach(enhanceTable);
  }

  function mount() {
    applyPreferences();
    const page = document.getElementById('page');
    if (!page) return;
    observer?.disconnect();
    observer = new MutationObserver(() => enhancePage(page));
    observer.observe(page, { childList:true, subtree:true });
    enhancePage(page);
  }

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); openQuickActions(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCommandCenter(); }
    if (e.key === 'Escape' && document.getElementById('ux-drawer-layer')) closeDrawer();
  });

  applyPreferences();
  window.VeloExperience = { mount, enhancePage, openDrawer, closeDrawer, openNotifications, openQuickActions,
    openAppearance, openCommandCenter, notificationCount, loading, applyPreferences, loadPreferences, collectNotifications,
    onRoute, searchHome, bindSearchHome, loadWorkspace, toggleFavorite };
  window.experienceOpenNotifications = openNotifications;
  window.experienceOpenQuickActions = openQuickActions;
  window.experienceOpenAppearance = openAppearance;
  window.experienceOpenCommandCenter = openCommandCenter;
  window.experienceCloseDrawer = closeDrawer;
  window.experienceLoading = loading;
})();
