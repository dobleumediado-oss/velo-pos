// ════════════════════════════════════════════════════════════════════════════
// experience.js — Experiencia transversal de Velo POS
// Preferencias visuales, drawers, alertas, acciones rápidas y tablas inteligentes.
// No contiene reglas de negocio: consume el estado y las APIs públicas existentes.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  const PREF_KEY = 'vp_ui_preferences_v2';
  const WORKSPACE_KEY = 'vp_ui_workspace_v1';
  const AUTOMATION_KEY = 'vp_operational_reminders_v1';
  const FAILURE_KEY = 'vp_recoverable_operations_v1';
  const TABLE_KEY = 'vp_table_preferences_v1';
  const DEFAULTS = {
    theme: 'light',
    density: 'comfortable',
    motion: 'full',
    contrast: 'normal',
    text: 'normal',
  };
  const AUTOMATION_DEFAULTS = {
    lowStock: true,
    overdueCredit: true,
    cashClose: true,
    backup: true,
    printer: true,
    dueSoonDays: 5,
  };
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
    reportes:{ label:'Reportes', icon:'chart', group:'Análisis' }, impresion:{ label:'Centro de impresión', icon:'print', group:'Sistema' },
    configuracion:{ label:'Configuración', icon:'settings', group:'Sistema' }, auditoria:{ label:'Auditoría', icon:'alert', group:'Sistema' },
    superadmin:{ label:'Panel Dev', icon:'code', group:'Sistema' },
  };
  let observer = null;
  let healthCache = null;
  let healthCacheAt = 0;
  let connectionState = { status: 'local', checkedAt: null };

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
    document.body.classList.toggle('ui-high-contrast', prefs.contrast === 'high');
    document.body.classList.toggle('ui-large-text', prefs.text === 'large');
    document.documentElement.style.colorScheme = prefs.theme === 'dark' ? 'dark' : 'light';
    return prefs;
  }

  function loadAutomations() {
    try {
      return {
        ...AUTOMATION_DEFAULTS,
        ...JSON.parse(localStorage.getItem(AUTOMATION_KEY) || '{}'),
      };
    } catch {
      return { ...AUTOMATION_DEFAULTS };
    }
  }

  function saveAutomations(next) {
    const safe = {
      ...AUTOMATION_DEFAULTS,
      ...next,
      dueSoonDays: Math.max(1, Math.min(30, Number(next?.dueSoonDays) || 5)),
    };
    try { localStorage.setItem(AUTOMATION_KEY, JSON.stringify(safe)); } catch {}
    return safe;
  }

  function loadFailures() {
    try {
      return (JSON.parse(localStorage.getItem(FAILURE_KEY) || '[]') || [])
        .filter(item => item && item.id && item.createdAt)
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  function saveFailures(items) {
    try { localStorage.setItem(FAILURE_KEY, JSON.stringify((items || []).slice(0, 20))); } catch {}
  }

  function rememberFailure({ label, detail, module = '', retryKey = '', payload = null }) {
    const failure = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: String(label || 'Operación pendiente').slice(0, 100),
      detail: String(detail || 'No se pudo completar').slice(0, 240),
      module: String(module || '').slice(0, 40),
      retryKey: String(retryKey || '').slice(0, 60),
      payload: payload && typeof payload === 'object' ? payload : null,
      createdAt: new Date().toISOString(),
    };
    const items = [failure, ...loadFailures().filter(item =>
      !(retryKey && item.retryKey === retryKey)
    )].slice(0, 20);
    saveFailures(items);
    updateRecoveryBadge();
    return failure;
  }

  function resolveFailure(id) {
    saveFailures(loadFailures().filter(item => item.id !== id));
    updateRecoveryBadge();
  }

  function clearFailures() {
    saveFailures([]);
    updateRecoveryBadge();
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

  function configuredRoles(action, fallback = 'admin,superadmin') {
    const raw = stateCFG()[`permission_${action}_roles`]
      || stateDB()?.settings?.[`permission_${action}_roles`]
      || fallback;
    return [...new Set(String(raw).split(',').map(x => x.trim()).filter(Boolean))];
  }

  function can(action, fallback) {
    const role = currentUser()?.role;
    return role === 'superadmin' || configuredRoles(action, fallback).includes(role);
  }

  async function getSystemHealth(force = false) {
    const admin = ['admin', 'superadmin'].includes(currentUser()?.role);
    if (!admin || !window.api?.system?.diagnose) return null;
    if (!force && healthCache && Date.now() - healthCacheAt < 5 * 60 * 1000) return healthCache;
    const result = await window.api.system.diagnose({ requestUserId: currentUser()?.id });
    if (!result?.ok) throw new Error(result?.error || 'No se pudo diagnosticar el sistema');
    healthCache = result;
    healthCacheAt = Date.now();
    return result;
  }

  function healthTone(status) {
    return status === 'error' ? 'red' : status === 'warn' ? 'amber' : 'green';
  }

  async function openSystemHealth() {
    const body = openDrawer({
      id: 'system-health',
      title: 'Salud del sistema',
      subtitle: 'Base de datos, respaldos, caja, impresión y equipo',
      width: '570px',
      content: loading('Ejecutando diagnóstico de solo lectura…'),
    });
    try {
      const report = await getSystemHealth(true);
      if (!body?.isConnected) return;
      const results = report?.results || [];
      const healthy = results.filter(item => item.status === 'ok').length;
      body.innerHTML = `<div class="ux-health-summary ux-health-${healthTone(report.score === 'critical' ? 'error' : report.score)}">
        <div><small>ESTADO GENERAL</small><strong>${report.errors ? 'Atención requerida' : report.warns ? 'Operación con avisos' : 'Sistema saludable'}</strong>
          <span>${healthy} correctos · ${report.warns || 0} avisos · ${report.errors || 0} críticos</span></div>
        <button data-health-refresh>${svg('refresh')} Revisar otra vez</button>
      </div>
      <div class="ux-health-list">${results.map(item => `<article class="ux-health-item ux-tone-${healthTone(item.status)}">
        <span>${item.status === 'ok' ? svg('check') : svg('alert')}</span>
        <div><strong>${esc(item.label)}</strong><p>${esc(item.detail)}</p>
          ${item.status !== 'ok' ? `<details><summary>Qué hacer</summary><div>${esc(item.fix || 'Revisar con soporte.')}</div></details>` : ''}
        </div><b>${item.status === 'ok' ? 'Correcto' : item.status === 'warn' ? 'Revisar' : 'Crítico'}</b>
      </article>`).join('')}</div>
      <div class="ux-health-actions">
        <button class="btn btn-out" data-health-backup>${svg('save')} Crear respaldo ahora</button>
        ${currentUser()?.role === 'superadmin' ? `<button class="btn btn-out" data-health-permissions>${svg('lock')} Permisos operativos</button>` : ''}
      </div>`;
      body.querySelector('[data-health-refresh]')?.addEventListener('click', openSystemHealth);
      body.querySelector('[data-health-backup]')?.addEventListener('click', async () => {
        const btn = body.querySelector('[data-health-backup]');
        btn.disabled = true;
        const result = await window.api.backup.create({ requestUserId: currentUser()?.id });
        btn.disabled = false;
        if (result?.error === 'Cancelado') return;
        if (!result?.ok) return toast(result?.error || 'No se pudo crear el respaldo', 'err');
        healthCache = null;
        toast('Respaldo creado correctamente');
        openSystemHealth();
      });
      body.querySelector('[data-health-permissions]')?.addEventListener('click', openActionPermissions);
    } catch (error) {
      if (!body?.isConnected) return;
      body.innerHTML = `<div class="ux-recover-empty">${svg('alert')}<h3>No se pudo completar el diagnóstico</h3>
        <p>${esc(error?.message || 'Error inesperado')}</p><button class="btn btn-dark" data-health-refresh>Reintentar</button></div>`;
      body.querySelector('[data-health-refresh]')?.addEventListener('click', openSystemHealth);
    }
  }

  function updateRecoveryBadge() {
    const btn = document.querySelector('[data-ux-recovery]');
    if (!btn) return;
    const count = loadFailures().length;
    btn.classList.toggle('has-pending', count > 0);
    btn.dataset.count = String(count);
    btn.title = count ? `${count} operación${count === 1 ? '' : 'es'} para revisar` : 'Recuperación de operaciones';
  }

  function retryFailure(item) {
    if (!item) return;
    resolveFailure(item.id);
    if (item.module && accessibleRoutes().includes(item.module)) {
      goRoute(item.module);
      toast('Abre el documento y vuelve a ejecutar la acción', 'w');
    } else {
      toast('Operación retirada de pendientes');
    }
    openRecoveryCenter();
  }

  function openRecoveryCenter() {
    const failures = loadFailures();
    const body = openDrawer({
      id: 'recovery',
      title: 'Recuperación de operaciones',
      subtitle: 'Fallos conservados sin duplicar ventas ni documentos',
      width: '470px',
      content: failures.length ? `<div class="ux-recovery-list">${failures.map(item => `<article class="ux-recovery-item">
        <span>${svg('refresh')}</span><div><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small>
          <time>${new Date(item.createdAt).toLocaleString('es-DO')}</time></div>
        <button data-retry-id="${esc(item.id)}">Revisar</button><button data-dismiss-id="${esc(item.id)}" aria-label="Descartar">×</button>
      </article>`).join('')}</div>
      <button class="ux-clear-recovery" data-clear-recovery>Descartar todos los avisos</button>`
        : `<div class="ux-drawer-empty"><div>${svg('check')}</div><h3>No hay operaciones pendientes</h3>
          <p>Ventas, impresiones y comunicaciones están al día.</p></div>`,
    });
    body.querySelectorAll('[data-retry-id]').forEach(btn => {
      btn.onclick = () => retryFailure(failures.find(item => item.id === btn.dataset.retryId));
    });
    body.querySelectorAll('[data-dismiss-id]').forEach(btn => {
      btn.onclick = () => { resolveFailure(btn.dataset.dismissId); openRecoveryCenter(); };
    });
    body.querySelector('[data-clear-recovery]')?.addEventListener('click', () => {
      clearFailures();
      openRecoveryCenter();
    });
  }

  function updateConnectionChip() {
    const host = document.getElementById('topbar');
    if (!host || !currentUser()) return;
    let chip = document.getElementById('ux-connection-chip');
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'ux-connection-chip';
      chip.className = 'ux-connection-chip';
      chip.onclick = () => {
        if (connectionState.status === 'offline') openRecoveryCenter();
        else if (['admin', 'superadmin'].includes(currentUser()?.role)) openSystemHealth();
      };
      const right = host.querySelector('.tb-right');
      right?.insertBefore(chip, right.firstChild);
    }
    const mode = stateCFG().connectionMode || 'local';
    const status = mode === 'local' ? 'local' : connectionState.status;
    chip.dataset.status = status;
    chip.innerHTML = `<i></i><span>${status === 'offline' ? 'Sin conexión' : status === 'reconnected' ? 'Sincronizado' : mode === 'local' ? 'Este equipo' : 'Conectado'}</span>`;
    chip.setAttribute('aria-label', status === 'offline'
      ? 'Servidor desconectado. Abrir recuperación'
      : 'Estado de conexión correcto');
  }

  function handleSyncEvent(event) {
    if (event?.connection) {
      connectionState = { ...connectionState, ...event.connection };
      updateConnectionChip();
      if (event.connection.status === 'offline') {
        rememberFailure({
          label: 'Terminal sin conexión',
          detail: 'VELO continuará intentando reconectar. No repitas operaciones inciertas.',
          module: '',
          retryKey: 'connection-offline',
        });
      } else {
        const offline = loadFailures().find(item => item.retryKey === 'connection-offline');
        if (offline) resolveFailure(offline.id);
        if (event.connection.status === 'reconnected') toast('Conexión restaurada y datos sincronizados');
      }
    }
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
    const automation = loadAutomations();
    const db = stateDB();
    const low = automation.lowStock
      ? (db.products || []).filter(p => p.active !== 0 && Number(p.stock || 0) <= Number(p.stock_min || 5)).length : 0;
    const credit = automation.overdueCredit && typeof getCreditAlerts === 'function' ? getCreditAlerts().length : 0;
    return low + credit + (automation.cashClose && !cashIsOpen() ? 1 : 0) + loadFailures().length;
  }

  async function collectNotifications() {
    const items = [];
    const cfg = stateCFG();
    const automation = loadAutomations();
    const products = (stateDB().products || []).filter(p => p.active !== 0);
    const out = products.filter(p => Number(p.stock || 0) <= 0);
    const low = products.filter(p => Number(p.stock || 0) > 0 && Number(p.stock || 0) <= Number(p.stock_min || 5));
    if (automation.lowStock && out.length) items.push({ tone:'red', icon:'box', title:`${out.length} producto${out.length === 1 ? '' : 's'} sin existencia`,
      detail:'No pueden venderse hasta registrar una entrada.', route:'inventario', tab:'sin_stock', priority:1 });
    if (automation.lowStock && low.length) items.push({ tone:'amber', icon:'alert', title:`${low.length} producto${low.length === 1 ? '' : 's'} con stock bajo`,
      detail:'Conviene preparar reposición antes de agotar existencias.', route:'inventario', tab:'bajo', priority:2 });

    const dateToday = typeof today === 'function' ? today() : new Date().toISOString().slice(0,10);
    const credits = (stateDB().customers || []).filter(customer =>
      Number(customer.balance || 0) > 0 && customer.id !== 1 && /^\d{4}-\d{2}-\d{2}$/.test(String(customer.credit_due || ''))
    ).map(customer => {
      const daysLeft = typeof daysDiff === 'function'
        ? daysDiff(dateToday, customer.credit_due)
        : Math.ceil((new Date(`${customer.credit_due}T12:00:00`) - new Date(`${dateToday}T12:00:00`)) / 86400000);
      return { client:customer, daysLeft, status:daysLeft < 0 ? 'overdue' : daysLeft <= automation.dueSoonDays ? 'soon' : 'ok' };
    }).filter(alert => alert.status !== 'ok');
    const overdue = credits.filter(a => a.status === 'overdue');
    const soon = credits.filter(a => a.status === 'soon');
    if (automation.overdueCredit && overdue.length) items.push({ tone:'red', icon:'dollar', title:`${overdue.length} crédito${overdue.length === 1 ? '' : 's'} vencido${overdue.length === 1 ? '' : 's'}`,
      detail:'Revisa las cuentas por cobrar y programa seguimiento.', route:'clientes', tab:'credito', priority:1 });
    if (automation.overdueCredit && soon.length) items.push({ tone:'amber', icon:'calendar', title:`${soon.length} crédito${soon.length === 1 ? '' : 's'} próximo${soon.length === 1 ? '' : 's'} a vencer`,
      detail:`Vencen dentro de los próximos ${automation.dueSoonDays} días.`, route:'clientes', tab:'credito', priority:2 });
    if (automation.cashClose && !cashIsOpen()) items.push({ tone:'blue', icon:'cash', title:'Caja pendiente de apertura',
      detail:'Abre una sesión para comenzar a cobrar ventas.', route:'caja', priority:2 });

    const failures = loadFailures();
    if (failures.length) items.push({ tone:'amber', icon:'refresh', title:`${failures.length} operación${failures.length === 1 ? '' : 'es'} por revisar`,
      detail:'Hay impresiones, conexiones o comunicaciones que no se completaron.', action:'recovery', priority:1 });

    if ((automation.backup || automation.printer) && ['admin','superadmin'].includes(currentUser()?.role)) {
      try {
        const report = await getSystemHealth(false);
        const selected = (report?.results || []).filter(result => result.status !== 'ok' && (
          (automation.backup && /respaldo|backup/i.test(`${result.label} ${result.detail}`))
          || (automation.printer && /impres/i.test(`${result.label} ${result.detail}`))
        ));
        if (selected.length) items.push({
          tone:selected.some(x => x.status === 'error') ? 'red' : 'amber', icon:'alert',
          title:`${selected.length} aviso${selected.length === 1 ? '' : 's'} de infraestructura`,
          detail:'Revisa respaldos e impresión desde Salud del sistema.', action:'health', priority:2
        });
      } catch {}
    }

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
    if (item.action === 'recovery') return openRecoveryCenter();
    if (item.action === 'health') return openSystemHealth();
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
      <section class="ux-pref-section"><h3>Accesibilidad visual</h3>${preferenceOptions('contrast',[
        {value:'normal',label:'Contraste normal',sub:'Paleta equilibrada',preview:'contrast-normal'},
        {value:'high',label:'Contraste alto',sub:'Bordes y estados fuertes',preview:'contrast-high'}],prefs.contrast)}
        ${preferenceOptions('text',[
        {value:'normal',label:'Texto normal',sub:'Tamaño estándar',preview:'text-normal'},
        {value:'large',label:'Texto ampliado',sub:'Lectura a distancia',preview:'text-large'}],prefs.text)}</section>
      <div class="ux-pref-note">Los cambios se aplican inmediatamente y no afectan a otros usuarios o terminales.</div>
      <button class="ux-pref-guide" data-automation-open>${svg('bell')}<span><strong>Alertas y recordatorios</strong><small>Elige qué debe vigilar VELO</small></span><b>›</b></button>
      <button class="ux-pref-guide" data-guide-open>${svg('help')}<span><strong>Guía y recorridos</strong><small>Conoce las mejoras o repasa un flujo</small></span><b>›</b></button>` });
    body.querySelectorAll('[data-pref]').forEach(btn => btn.onclick = () => {
      const next = applyPreferences({ [btn.dataset.pref]: btn.dataset.value });
      body.querySelectorAll(`[data-pref="${btn.dataset.pref}"]`).forEach(x => x.classList.toggle('on', x.dataset.value === next[btn.dataset.pref]));
    });
    body.querySelector('[data-automation-open]')?.addEventListener('click',openAutomations);
    body.querySelector('[data-guide-open]')?.addEventListener('click',() => window.experienceOpenGuide?.());
  }

  function openAutomations() {
    const automation = loadAutomations();
    const toggles = [
      ['lowStock','Inventario en riesgo','Sin existencia y bajo el mínimo configurado'],
      ['overdueCredit','Créditos y vencimientos','Cuentas vencidas o próximas a vencer'],
      ['cashClose','Estado de caja','Recuerda abrir caja para iniciar la operación'],
      ['backup','Respaldos','Avisa cuando la protección de datos requiere atención'],
      ['printer','Impresión','Informa configuraciones o equipos que deben revisarse'],
    ];
    const body = openDrawer({ id:'automations', title:'Alertas y recordatorios',
      subtitle:'VELO vigila la operación sin interrumpir al cajero', width:'470px', content:`
      <div class="ux-automation-list">${toggles.map(([key,title,detail]) => `<label>
        <span><strong>${title}</strong><small>${detail}</small></span>
        <input type="checkbox" data-auto="${key}" ${automation[key] ? 'checked' : ''}><i></i>
      </label>`).join('')}</div>
      <label class="ux-number-setting"><span><strong>Aviso previo de vencimiento</strong><small>Días antes de vencer una cuenta por cobrar</small></span>
        <input type="number" min="1" max="30" value="${automation.dueSoonDays}" data-auto-days><b>días</b></label>
      <div class="ux-pref-note">Las preferencias son por usuario y terminal. Los avisos conducen directamente al módulo correspondiente.</div>` });
    const persist = () => {
      const next = { ...loadAutomations() };
      body.querySelectorAll('[data-auto]').forEach(input => { next[input.dataset.auto] = input.checked; });
      next.dueSoonDays = body.querySelector('[data-auto-days]')?.value;
      saveAutomations(next);
    };
    body.querySelectorAll('[data-auto]').forEach(input => input.addEventListener('change', persist));
    body.querySelector('[data-auto-days]')?.addEventListener('change', persist);
  }

  async function openActionPermissions() {
    if (currentUser()?.role !== 'superadmin') return toast('Solo el superadministrador puede cambiar estos permisos', 'err');
    const actions = [
      ['cancel_payment','Anular abonos','Revierte el balance, caja y asientos relacionados'],
      ['restore_backup','Restaurar respaldos','Sustituye los datos operativos por una copia anterior'],
      ['system_health','Ver salud del sistema','Consulta diagnóstico técnico y recomendaciones'],
    ];
    const roles = [
      ['cajero','Cajero'],['admin','Administrador'],['superadmin','Superadministrador']
    ];
    const body = openDrawer({ id:'action-permissions', title:'Permisos operativos',
      subtitle:'Acceso por acción sensible, separado de la navegación', width:'540px', content:`
      <div class="ux-permission-list">${actions.map(([key,title,detail]) => `<section data-permission="${key}">
        <div><strong>${title}</strong><small>${detail}</small></div>
        <div>${roles.map(([role,label]) => `<label><input type="checkbox" value="${role}"
          ${configuredRoles(key).includes(role) ? 'checked' : ''} ${role === 'superadmin' ? 'disabled' : ''}><span>${label}</span></label>`).join('')}</div>
      </section>`).join('')}</div>
      <div class="ux-pref-note">Las correcciones y anulaciones de ventas conservan sus permisos especializados existentes.</div>
      <button class="btn btn-dark ux-save-permissions" data-save-permissions>${svg('check')} Guardar permisos</button>` });
    body.querySelector('[data-save-permissions]')?.addEventListener('click', async () => {
      const button = body.querySelector('[data-save-permissions]');
      button.disabled = true;
      try {
        for (const section of body.querySelectorAll('[data-permission]')) {
          const selected = [...section.querySelectorAll('input:checked')].map(input => input.value);
          if (!selected.includes('superadmin')) selected.push('superadmin');
          const key = `permission_${section.dataset.permission}_roles`;
          const result = await window.api.settings.set({ key, value:selected.join(','), requestUserId:currentUser()?.id });
          if (!result?.ok) throw new Error(result?.error || 'No se pudo guardar');
          stateCFG()[key] = selected.join(',');
          if (stateDB()?.settings) stateDB().settings[key] = selected.join(',');
        }
        toast('Permisos actualizados');
        closeDrawer();
      } catch (error) {
        button.disabled = false;
        toast(error?.message || 'No se pudieron actualizar los permisos', 'err');
      }
    });
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

  function loadTablePreferences() {
    try { return JSON.parse(localStorage.getItem(TABLE_KEY) || '{}') || {}; } catch { return {}; }
  }

  function tableIdentity(table) {
    const module = document.getElementById('page')?.dataset?.module
      || document.querySelector('.module-page')?.className?.match(/module-([\w-]+)/)?.[1]
      || (typeof page !== 'undefined' ? page : 'general');
    const headings = [...table.querySelectorAll('thead th')].map(th => th.innerText.trim()).join('|');
    let hash = 0;
    for (const char of headings) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return `${module}:${Math.abs(hash)}`;
  }

  function saveTablePreference(table, hidden) {
    const all = loadTablePreferences();
    all[tableIdentity(table)] = { hidden:[...new Set(hidden)].sort((a,b) => a-b) };
    try { localStorage.setItem(TABLE_KEY, JSON.stringify(all)); } catch {}
  }

  function applyTablePreference(table) {
    const saved = loadTablePreferences()[tableIdentity(table)];
    if (!saved?.hidden) return;
    [...table.rows].forEach(row => [...row.cells].forEach((cell,index) => {
      cell.hidden = saved.hidden.includes(index);
    }));
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
      const hidden = [...body.querySelectorAll('[data-col]:not(:checked)')].map(item => Number(item.dataset.col));
      saveTablePreference(table, hidden);
    });
  }

  function enhanceTable(table) {
    if (table.dataset.uxEnhanced || !table.tHead || !table.tBodies.length) return;
    table.dataset.uxEnhanced = '1';
    table.classList.add('ux-smart-table');
    applyTablePreference(table);
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

  function normalizedStatus(text) {
    const value = String(text || '').trim().toLowerCase();
    if (/anulad|cancelad|rechazad|vencid|error|fall/.test(value)) return 'danger';
    if (/pendiente|borrador|por vencer|revisar|parcial/.test(value)) return 'warning';
    if (/vigente|pagad|complet|aprob|activo|abiert|correct|cuadra/.test(value)) return 'success';
    if (/crédito|credito|inform|proces/.test(value)) return 'info';
    return '';
  }

  function enhanceStatuses(root) {
    root.querySelectorAll('.badge,.status-badge,.pill-status,.ven-status,.tag').forEach(node => {
      if (node.dataset.uxStatus) return;
      const status = normalizedStatus(node.textContent);
      if (status) node.dataset.uxStatus = status;
    });
  }

  function enhanceModals(root) {
    root.querySelectorAll('.modal').forEach(modal => {
      if (modal.dataset.uxStructured) return;
      modal.dataset.uxStructured = '1';
      modal.classList.add('ux-modal-structured');
      modal.setAttribute('role','dialog');
      modal.setAttribute('aria-modal','true');
      const title = modal.querySelector('.modal-title,h2,h3');
      if (title && !title.id) title.id = `ux-modal-title-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
      if (title) modal.setAttribute('aria-labelledby',title.id);
    });
  }

  function enhanceEmptyStates(root) {
    root.querySelectorAll('.empty,.empty-state,.ui-empty-state,.pv-empty').forEach(node => {
      node.classList.add('ux-empty-enhanced');
      node.setAttribute('role','status');
    });
  }

  function enhancePage(root = document.getElementById('page')) {
    if (!root) return;
    root.querySelectorAll('.tw table').forEach(enhanceTable);
    enhanceStatuses(root);
    enhanceModals(document);
    enhanceEmptyStates(root);
  }

  function refreshShell() {
    updateConnectionChip();
    updateRecoveryBadge();
  }

  function mount() {
    applyPreferences();
    const page = document.getElementById('page');
    if (!page) return;
    observer?.disconnect();
    observer = new MutationObserver(() => enhancePage(page));
    observer.observe(page, { childList:true, subtree:true });
    enhancePage(page);
    if (!window.__veloExperienceSyncBound && window.api?.sync?.onChanged) {
      window.__veloExperienceSyncBound = true;
      window.api.sync.onChanged(handleSyncEvent);
    }
    refreshShell();
  }

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); openQuickActions(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCommandCenter(); }
    if (e.key === 'Escape' && document.getElementById('ux-drawer-layer')) closeDrawer();
  });

  applyPreferences();
  window.VeloExperience = { mount, enhancePage, openDrawer, closeDrawer, openNotifications, openQuickActions,
    openAppearance, openCommandCenter, notificationCount, loading, applyPreferences, loadPreferences, collectNotifications,
    onRoute, searchHome, bindSearchHome, loadWorkspace, toggleFavorite, openSystemHealth, openRecoveryCenter,
    openAutomations, openActionPermissions, rememberFailure, resolveFailure, refreshShell, can };
  window.experienceOpenNotifications = openNotifications;
  window.experienceOpenQuickActions = openQuickActions;
  window.experienceOpenAppearance = openAppearance;
  window.experienceOpenCommandCenter = openCommandCenter;
  window.experienceOpenRecovery = openRecoveryCenter;
  window.experienceOpenSystemHealth = openSystemHealth;
  window.experienceCloseDrawer = closeDrawer;
  window.experienceLoading = loading;
})();
