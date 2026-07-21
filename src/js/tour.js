// ════════════════════════════════════════════════════════════════════════════
// tour.js — Guía animada y contextual de Velo POS
// Recorridos por rol, progreso por usuario/negocio y foco visual accesible.
// Nunca ejecuta acciones de negocio: solo navega y explica la interfaz.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  const GUIDE_REV = 'experience-3.2';
  const STORAGE_PREFIX = 'vp_guided_tours_v2';
  let active = null;
  let renderToken = 0;
  let inviteTimer = null;

  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const icon = name => typeof svg === 'function' ? svg(name) : '';
  const getUser = () => {
    try {
      if (typeof user !== 'undefined' && user) return user;
      return window._currentUser || JSON.parse(sessionStorage.getItem('vp_user') || 'null');
    } catch { return null; }
  };
  const getConfig = () => { try { return typeof CFG !== 'undefined' ? CFG : {}; } catch { return {}; } };
  const currentRoute = () => { try { return typeof page !== 'undefined' ? page : 'dash'; } catch { return 'dash'; } };
  const allowedRoutes = () => [...document.querySelectorAll('.nav-item[data-key]')].map(x => x.dataset.key);
  const storageKey = () => {
    const cfg = getConfig();
    const who = getUser()?.id || getUser()?.email || 'terminal';
    return `${STORAGE_PREFIX}:${cfg.activeBusinessId || 'principal'}:${who}`;
  };

  function loadState() {
    try {
      const saved=JSON.parse(localStorage.getItem(storageKey()) || '{}');
      if (saved.revision && saved.revision !== GUIDE_REV) return { revision:GUIDE_REV, completed:[], progress:{}, inviteDismissed:false };
      return { revision:GUIDE_REV, completed:[], progress:{}, inviteDismissed:false, ...saved, revision:GUIDE_REV };
    } catch { return { revision:GUIDE_REV, completed:[], progress:{}, inviteDismissed:false }; }
  }

  function saveState(next) {
    const safe = {
      revision:GUIDE_REV,
      completed:[...new Set(next.completed || [])],
      progress:next.progress || {},
      inviteDismissed:!!next.inviteDismissed,
    };
    try { localStorage.setItem(storageKey(), JSON.stringify(safe)); } catch {}
    return safe;
  }

  const TOURS = {
    upgrade: {
      title:'Novedades de la experiencia',
      subtitle:'Centro de mando, tableros, alertas y operación visual',
      icon:'trend', duration:'3 min', roles:['admin','superadmin','cajero'],
      steps:[
        { title:'Bienvenido a la nueva experiencia', icon:'trend',
          text:'Velo POS ahora te ayuda a encontrar, priorizar y actuar. Este recorrido presenta las herramientas nuevas sin modificar ninguna información.' },
        { title:'Centro de mando', icon:'chart', selector:'.ux-command-trigger',
          text:'Aquí ves la salud operativa, las prioridades y tus accesos favoritos desde cualquier pantalla.', tip:'Atajo: Ctrl/Cmd + Shift + P' },
        { title:'Búsqueda universal', icon:'search', selector:'[aria-label="Buscar en todo el sistema"]',
          text:'Encuentra productos, clientes y facturas, o úsalo como navegador para abrir módulos y guardar favoritos.', tip:'Atajo: Ctrl/Cmd + K' },
        { title:'Crear sin perder el contexto', icon:'plus', selector:'[aria-label="Crear rápidamente"]',
          text:'Registra una venta, cliente, gasto, vendedor, envío o conduce desde cualquier módulo.', tip:'Atajo: Ctrl/Cmd + J' },
        { title:'Prioridades conectadas', icon:'bell', selector:'[aria-label="Abrir centro de notificaciones"]',
          text:'Las alertas de inventario, créditos, caja, gastos y nómina te llevan directamente al lugar donde se resuelven.' },
        { title:'Tu forma de trabajar', icon:'half', selector:'[aria-label="Cambiar apariencia y densidad"]',
          text:'Cambia tema, densidad y movimiento. Las preferencias quedan guardadas en esta terminal.' },
        { title:'Pulso ejecutivo', icon:'grid', route:'dash', selector:'.ux-exec-strip', wait:2400,
          text:'El Dashboard resume salud, caja y asuntos pendientes para comenzar el día con una lectura rápida.' },
        { title:'Un tablero a tu medida', icon:'settings', route:'dash', selector:'.dash-personalize-btn', wait:2200,
          text:'Muestra, oculta y ordena los bloques del Dashboard. Tu diseño se guarda de forma independiente para este usuario y negocio.' },
        { title:'Dirección comercial visual', icon:'users', route:'vendedores', requires:'vendedores', selector:'.ven-nav', wait:2500,
          text:'Perfiles, metas, calendario, flujo de compensación y cobertura ambulante reúnen la operación comercial sin duplicar movimientos.' },
      ],
    },
    owner: {
      title:'Recorrido del administrador',
      subtitle:'Control completo del negocio y sus conexiones',
      icon:'grid', duration:'4 min', roles:['admin','superadmin'],
      steps:[
        { title:'Tu mapa del negocio', icon:'grid', text:'Recorreremos las áreas principales. La guía solamente navega y señala; nunca registra ni modifica datos.' },
        { title:'Navegación organizada', icon:'menu', selector:'.sidebar', text:'Los módulos están agrupados por gestión, finanzas, logística y sistema. El menú se adapta a los permisos habilitados.' },
        { title:'Inventario conectado', icon:'box', selector:'.nav-item[data-key="inventario"]', requires:'inventario', text:'Productos, existencias, costos e historial alimentan ventas, compras, reportes y contabilidad.' },
        { title:'Ventas y devoluciones', icon:'list', selector:'.nav-item[data-key="ventas"]', requires:'ventas', text:'Consulta la operación comercial. Las devoluciones viven en su propio módulo y dejan de mezclarse con las ventas vigentes.' },
        { title:'Vendedores y nómina', icon:'users', selector:'.nav-item[data-key="vendedores"]', requires:'vendedores', text:'Controla fijos y ambulantes, talonarios, comisiones, viáticos y nóminas conectadas con Gastos.' },
        { title:'Gastos y obligaciones', icon:'dollar', selector:'.nav-item[data-key="gastos"]', requires:'gastos', text:'Registra gastos, viáticos, nómina y cuentas por pagar para reflejarlos correctamente en la operación.' },
        { title:'Contabilidad integrada', icon:'ledger', selector:'.nav-item[data-key="contabilidad"]', requires:'contabilidad', text:'Los módulos de origen alimentan los asientos y estados financieros sin exigir doble digitación.' },
        { title:'Reportes para decidir', icon:'chart', selector:'.nav-item[data-key="reportes"]', requires:'reportes', text:'Convierte los movimientos del sistema en indicadores comerciales y financieros para el dueño.' },
        { title:'Todo bajo control', icon:'check', selector:'.ux-command-trigger', text:'El centro de mando reúne las prioridades. Puedes volver a esta guía cuando quieras desde el botón de ayuda.' },
      ],
    },
    cashier: {
      title:'Recorrido de caja y ventas',
      subtitle:'Flujo diario para atender clientes con rapidez',
      icon:'cash', duration:'3 min', roles:['cajero','admin','superadmin'],
      steps:[
        { title:'Tu recorrido operativo', icon:'cash', text:'Esta guía presenta el flujo cotidiano sin abrir formularios ni crear movimientos.' },
        { title:'Punto de Venta', icon:'monitor', selector:'.nav-item[data-key="pos"]', requires:'pos', text:'Busca artículos, prepara varias facturas y cobra con los métodos habilitados por el negocio.' },
        { title:'Clientes y crédito', icon:'users', selector:'.nav-item[data-key="clientes"]', requires:'clientes', text:'Consulta clientes, balances y abonos sin salir del entorno de trabajo.' },
        { title:'Historial de ventas', icon:'list', selector:'.nav-item[data-key="ventas"]', requires:'ventas', text:'Revisa facturas vigentes y abre sus detalles. Las devoluciones procesadas no permanecen como ventas activas.' },
        { title:'Caja por sesión', icon:'cash', selector:'.nav-item[data-key="caja"]', requires:'caja', text:'La apertura, movimientos y cierre permiten cuadrar lo cobrado por esta terminal.' },
        { title:'Trabaja más rápido', icon:'plus', selector:'[aria-label="Crear rápidamente"]', text:'Usa las acciones rápidas o la búsqueda universal para moverte sin perder tiempo.' },
      ],
    },
  };

  function availableTours() {
    const role = getUser()?.role || 'cajero';
    return Object.entries(TOURS).filter(([,tour]) => tour.roles.includes(role));
  }

  function stepsFor(tour) {
    const routes = allowedRoutes();
    return tour.steps.filter(step => !step.requires || routes.includes(step.requires));
  }

  function canStart() {
    if (active || document.getElementById('modal-ov') || document.querySelector('.ov') ||
        document.getElementById('gsearch-ov') || document.getElementById('ux-drawer-layer')) return false;
    if (window._pwdChangeRequired) return false;
    return !!document.getElementById('page');
  }

  function openHub() {
    if (active) return;
    dismissInvite(false);
    const state = loadState();
    const entries = availableTours();
    const body = window.VeloExperience?.openDrawer?.({ id:'guide-hub', title:'Guía y recorridos',
      subtitle:'Aprende Velo POS a tu ritmo', width:'470px', content:`<div class="ux-guide-hero"><span>${icon('wrench')}</span><div><small>CENTRO DE APRENDIZAJE</small><h3>Domina el sistema paso a paso</h3><p>Recorridos breves, seguros y adaptados a tu función.</p></div></div>
      <div class="ux-guide-list">${entries.map(([id,tour]) => {
        const done = state.completed.includes(id); const progress = Number(state.progress[id] || 0);
        return `<article class="ux-guide-card ${done ? 'done' : ''}"><span>${icon(tour.icon)}</span><div><strong>${esc(tour.title)}</strong><small>${esc(tour.subtitle)}</small><div class="ux-guide-meta"><b>${esc(tour.duration)}</b>${done ? '<em>✓ Completado</em>' : progress ? `<em>Paso ${progress + 1}</em>` : '<em>Nuevo</em>'}</div></div><button data-tour-start="${id}">${progress && !done ? 'Continuar' : done ? 'Repetir' : 'Comenzar'}</button></article>`;
      }).join('')}</div><div class="ux-guide-safety">${icon('lock')} La guía no guarda ventas, gastos ni cambios. Solo explica y navega.</div>` });
    body?.querySelectorAll('[data-tour-start]').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.tourStart; const done = state.completed.includes(id);
      window.VeloExperience?.closeDrawer?.();
      setTimeout(() => start(id, done ? 0 : Number(state.progress[id] || 0)), 190);
    });
  }

  function inviteMarkup() {
    return `<div class="ux-tour-invite" id="ux-tour-invite" role="status"><button class="ux-tour-invite-close" aria-label="Cerrar invitación">×</button>
      <div class="ux-tour-orbit"><span>${icon('trend')}</span><i></i><i></i></div><div><small>NUEVA EXPERIENCIA</small><strong>¿Quieres conocer las mejoras?</strong><p>Un recorrido animado de dos minutos.</p><div><button data-tour-later>Después</button><button data-tour-now>Ver guía</button></div></div></div>`;
  }

  function maybeOffer() {
    clearTimeout(inviteTimer);
    const state = loadState();
    if (state.revision !== GUIDE_REV || state.completed.includes('upgrade') || state.inviteDismissed) return;
    inviteTimer = setTimeout(() => {
      if (!canStart() || document.getElementById('ux-tour-invite')) return;
      document.body.insertAdjacentHTML('beforeend',inviteMarkup());
      const invite = document.getElementById('ux-tour-invite');
      invite?.querySelector('[data-tour-now]')?.addEventListener('click',() => { dismissInvite(false); start('upgrade',0); });
      invite?.querySelector('[data-tour-later]')?.addEventListener('click',() => dismissInvite(true));
      invite?.querySelector('.ux-tour-invite-close')?.addEventListener('click',() => dismissInvite(true));
    },1100);
  }

  function dismissInvite(remember = true) {
    const invite = document.getElementById('ux-tour-invite');
    if (invite) { invite.classList.add('leaving'); setTimeout(() => invite.remove(),180); }
    if (remember) { const state = loadState(); state.inviteDismissed = true; saveState(state); }
  }

  async function waitForTarget(selector, timeout = 1700) {
    if (!selector) return null;
    const startAt = Date.now();
    while (Date.now() - startAt < timeout) {
      const target = document.querySelector(selector);
      if (target && target.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0) return target;
      await new Promise(resolve => setTimeout(resolve,70));
    }
    return null;
  }

  function buildLayer() {
    document.getElementById('ux-tour-layer')?.remove();
    const layer = document.createElement('div');
    layer.id = 'ux-tour-layer'; layer.className = 'ux-tour-layer';
    layer.innerHTML = '<div class="ux-tour-backdrop"></div><div class="ux-tour-spotlight"></div><section class="ux-tour-card" role="dialog" aria-modal="true" aria-live="polite" aria-labelledby="ux-tour-title"></section>';
    document.body.appendChild(layer); document.body.classList.add('ux-tour-active');
    return layer;
  }

  async function start(id = 'upgrade', index = 0) {
    if (!TOURS[id] || !availableTours().some(([key]) => key === id)) return;
    dismissInvite(false);
    window.VeloExperience?.closeDrawer?.();
    const steps = stepsFor(TOURS[id]);
    active = { id, tour:TOURS[id], steps, index:Math.max(0,Math.min(index,steps.length - 1)), originalRoute:currentRoute(), layer:buildLayer() };
    window.addEventListener('resize',reposition); document.addEventListener('scroll',reposition,true); document.addEventListener('keydown',onKeydown,true);
    await showStep();
  }

  async function showStep() {
    if (!active) return;
    const token = ++renderToken;
    const step = active.steps[active.index];
    if (step.route && currentRoute() !== step.route && allowedRoutes().includes(step.route) && typeof routeTo === 'function') {
      routeTo(step.route); await new Promise(resolve => setTimeout(resolve,300));
    }
    const target = await waitForTarget(step.selector,step.wait || 1700);
    if (!active || token !== renderToken) return;
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight) { target.scrollIntoView({behavior:motionReduced() ? 'auto' : 'smooth',block:'center'}); await new Promise(resolve => setTimeout(resolve,motionReduced() ? 30 : 260)); }
    }
    active.target = target;
    renderStep(step);
  }

  function motionReduced() { return document.body.classList.contains('ui-reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches; }

  function renderStep(step) {
    const { layer, index, steps } = active;
    const card = layer.querySelector('.ux-tour-card');
    const dots = steps.map((_,i) => `<i class="${i < index ? 'done' : i === index ? 'on' : ''}"></i>`).join('');
    card.innerHTML = `<button class="ux-tour-close" aria-label="Pausar y cerrar guía">×</button><div class="ux-tour-step-icon">${icon(step.icon || active.tour.icon)}</div>
      <div class="ux-tour-counter">PASO ${index + 1} DE ${steps.length}</div><h3 id="ux-tour-title">${esc(step.title)}</h3><p>${esc(step.text)}</p>
      ${step.tip ? `<div class="ux-tour-tip">${icon('trend')} ${esc(step.tip)}</div>` : ''}<div class="ux-tour-progress">${dots}</div>
      <footer><button data-tour-exit>Salir</button><div>${index ? '<button data-tour-prev>Anterior</button>' : ''}<button class="primary" data-tour-next>${index === steps.length - 1 ? 'Finalizar' : 'Siguiente'} ${index === steps.length - 1 ? '✓' : '→'}</button></div></footer>`;
    card.querySelector('.ux-tour-close').onclick = () => pause();
    card.querySelector('[data-tour-exit]').onclick = () => pause();
    card.querySelector('[data-tour-prev]')?.addEventListener('click',prev);
    card.querySelector('[data-tour-next]').onclick = () => index === steps.length - 1 ? finish() : next();
    reposition();
    setTimeout(() => card.querySelector('[data-tour-next]')?.focus({preventScroll:true}),30);
  }

  function reposition() {
    if (!active?.layer) return;
    const spotlight = active.layer.querySelector('.ux-tour-spotlight');
    const card = active.layer.querySelector('.ux-tour-card');
    const target = active.target;
    if (!target) {
      active.layer.classList.remove('targeted'); spotlight.classList.remove('visible'); card.dataset.placement = 'center';
      card.style.cssText = 'left:50%;top:50%;transform:translate(-50%,-50%)'; return;
    }
    const r = target.getBoundingClientRect(); const pad = 7;
    active.layer.classList.add('targeted');
    spotlight.classList.add('visible'); spotlight.style.cssText = `left:${Math.max(5,r.left-pad)}px;top:${Math.max(5,r.top-pad)}px;width:${Math.min(innerWidth-10,r.width+pad*2)}px;height:${Math.min(innerHeight-10,r.height+pad*2)}px`;
    const cw = Math.min(360,innerWidth - 28); const ch = card.offsetHeight || 310; const gap = 18;
    let left, top, placement;
    if (r.right + gap + cw < innerWidth) { left=r.right+gap; top=Math.max(14,Math.min(r.top,innerHeight-ch-14)); placement='right'; }
    else if (r.left - gap - cw > 0) { left=r.left-gap-cw; top=Math.max(14,Math.min(r.top,innerHeight-ch-14)); placement='left'; }
    else if (r.bottom + gap + ch < innerHeight) { left=Math.max(14,Math.min(r.left,innerWidth-cw-14)); top=r.bottom+gap; placement='bottom'; }
    else { left=Math.max(14,Math.min(r.left,innerWidth-cw-14)); top=Math.max(14,r.top-gap-ch); placement='top'; }
    card.dataset.placement=placement; card.style.cssText=`width:${cw}px;left:${left}px;top:${top}px;transform:none`;
  }

  function persistProgress() {
    if (!active) return;
    const state=loadState(); state.progress[active.id]=active.index; saveState(state);
  }
  function next() { if (!active) return; active.index=Math.min(active.steps.length-1,active.index+1); persistProgress(); showStep(); }
  function prev() { if (!active) return; active.index=Math.max(0,active.index-1); persistProgress(); showStep(); }

  function cleanup({ restore=true } = {}) {
    if (!active) return;
    const original=active.originalRoute; active.layer?.remove(); active=null; ++renderToken;
    document.body.classList.remove('ux-tour-active'); window.removeEventListener('resize',reposition); document.removeEventListener('scroll',reposition,true); document.removeEventListener('keydown',onKeydown,true);
    if (restore && original && allowedRoutes().includes(original) && currentRoute() !== original && typeof routeTo === 'function') routeTo(original);
  }

  function pause() { persistProgress(); cleanup(); if (typeof toast === 'function') toast('Guía pausada. Puedes continuarla desde Ayuda.','i'); }

  function finish() {
    if (!active) return;
    const id=active.id; const state=loadState(); state.completed=[...new Set([...state.completed,id])]; delete state.progress[id]; state.inviteDismissed=true; saveState(state);
    const layer=active.layer; layer.classList.add('finishing'); celebrate(layer); const original=active.originalRoute;
    setTimeout(() => { cleanup({restore:false}); if (original && allowedRoutes().includes(original) && typeof routeTo === 'function') routeTo(original); openCompletion(id); },motionReduced()?80:620);
  }

  function celebrate(layer) {
    if (motionReduced()) return;
    const colors=['#10b981','#2563eb','#f59e0b','#7c3aed','#ef4444'];
    for (let i=0;i<28;i++) { const bit=document.createElement('i'); bit.className='ux-tour-confetti'; bit.style.cssText=`--x:${8+Math.random()*84}vw;--delay:${Math.random()*.25}s;--color:${colors[i%colors.length]};--turn:${Math.random()*720-360}deg`; layer.appendChild(bit); }
  }

  function openCompletion(id) {
    const tour=TOURS[id];
    const body=window.VeloExperience?.openDrawer?.({id:'guide-complete',title:'Recorrido completado',subtitle:'Tu progreso quedó guardado',width:'420px',content:`<div class="ux-guide-complete"><span>${icon('check')}</span><small>GUÍA COMPLETADA</small><h3>${esc(tour.title)}</h3><p>Ya conoces las herramientas principales de este recorrido. Puedes repetirlo cuando quieras.</p><button data-guide-hub>Ver otros recorridos</button></div>`});
    body?.querySelector('[data-guide-hub]')?.addEventListener('click',openHub);
  }

  function onKeydown(event) {
    if (!active) return;
    if (event.key === 'Tab') {
      const focusable=[...active.layer.querySelectorAll('.ux-tour-card button:not([disabled])')];
      if (!focusable.length) return;
      const first=focusable[0],last=focusable[focusable.length-1];
      if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
    }
    else if (event.key === 'Escape') { event.preventDefault(); pause(); }
    else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !event.target.closest?.('button'))) { event.preventDefault(); active.index===active.steps.length-1 ? finish() : next(); }
    else if (event.key === 'ArrowLeft' && active.index) { event.preventDefault(); prev(); }
  }

  function reset() { try { localStorage.removeItem(storageKey()); } catch {} }

  window.VeloTour={ maybeOffer, openHub, start, pause, reset, loadState, availableTours };
  window.experienceOpenGuide=openHub;
})();
