// ══════════════════════════════════════════════
// app.js — Render principal, Login, Sidebar,
//           Topbar y Router de páginas
// ══════════════════════════════════════════════

// ── Bootstrap ────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Cargar versión de la app para mostrar en login y config
  try {
    const vr = await window.api.version.getInfo();
    window._appVersion = vr?.ok ? vr.data?.appVersion : '1.4.1';
  } catch { window._appVersion = '1.5.1'; }

  // Cargar todos los datos vía IPC
  await loadAppData();

  // Restaurar sesión de sessionStorage
  const saved = sessionStorage.getItem('vp_user');
  if (saved) {
    try { user = JSON.parse(saved); } catch {}
  }
  if (user) renderApp();
  else      renderLogin();

  // ── Suscribirse a eventos del updater ──────────────────────────
  // onProgress: progreso de descarga (barra flotante)
  // onState: cualquier cambio de estado (panel de config + barra flotante)
  if (window.api?.updater?.onProgress) {
    window.api.updater.onProgress((data) => {
      _updFloatingBar({ status: 'downloading', progress: data });
    });
  }
  if (window.api?.updater?.onState) {
    window.api.updater.onState((state) => {
      _updState = state;
      _updFloatingBar(state);
      const card = document.getElementById('upd-card');
      if (card) _renderUpdPanel(card, state);
    });
  }
});

// ══════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════
function renderLogin() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.style.cssText = 'width:100%;height:100%;display:flex;';

  // Estado local del login
  let selRole = 'cajero';

  function build() {
    root.innerHTML = '';
    const wrap = h('div', { class: 'login-wrap', style: { width:'100%', height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'20px' } },

      // ── Reloj fuera de la card ──────────────
      h('div', { class: 'login-clock-outer' },
        h('div', { class: 'login-clock-time', id: 'login-clock-time' }, '00:00:00'),
        h('div', { class: 'login-clock-date', id: 'login-clock-date' }, '')
      ),

      // ── Card del formulario ─────────────────
      h('div', { class: 'login-card' },

        // Logo + título
        h('div', { class: 'login-header' },
          h('div', { class: 'login-logo' },
            h('img', {
              src: 'assets/icon.png',
              style: { width:'100%', height:'100%', borderRadius:'13px', objectFit:'cover' }
            })
          ),
          h('div', null,
            h('div', { class: 'login-title' }, 'Velo POS'),
            h('div', { class: 'login-sub' }, 'Gestión comercial · Inventario · Facturación · RD')
          )
        ),

        // Selector de rol
        h('div', { class: 'role-row', style: { marginBottom: '16px', marginTop: '16px' } },
          h('div', {
            class: `role-btn ${selRole === 'cajero' ? 'on' : ''}`,
            onclick: () => { selRole = 'cajero'; build(); }
          },
            h('div', { class: 'role-icon', style: { background: 'var(--blue)' }, html: svg('cash') }),
            h('div', { class: 'role-lbl' }, 'Cajero'),
            h('div', { class: 'role-sub' }, 'Punto de venta')
          ),
          h('div', {
            class: `role-btn ${selRole === 'admin' ? 'on' : ''}`,
            style: { opacity: '0.55' },
            onclick: () => { selRole = 'admin'; build(); }
          },
            h('div', { class: 'role-icon', style: { background: 'var(--ink3)' }, html: svg('settings') }),
            h('div', { class: 'role-lbl', style: { fontSize: '11px', color: 'var(--muted)' } }, 'Supervisor'),
            h('div', { class: 'role-sub' }, 'Acceso avanzado')
          ),
        ),

        // Error placeholder
        h('div', { id: 'lerr' }),

        // Campo usuario
        h('div', { class: 'fg' },
          h('label', { class: 'lbl' }, selRole === 'cajero' ? 'Usuario' : 'Email'),
          h('div', { class: 'inp-ic' },
            h('div', { class: 'ic', html: svg('user') }),
            selRole === 'cajero'
              ? (() => {
                  const cajeros = (window._cachedUsers || []).filter(u => u.role === 'cajero' && u.active);
                  const sel = h('select', { class: 'inp', id: 'luser' });
                  if (!cajeros.length) {
                    const op = document.createElement('option');
                    op.value = 'caja@velopos.do';
                    op.textContent = 'Cajero';
                    sel.appendChild(op);
                  } else {
                    cajeros.forEach(u => {
                      const op = document.createElement('option');
                      op.value = u.email;
                      op.textContent = u.name;
                      sel.appendChild(op);
                    });
                  }
                  return sel;
                })()
              : h('input', { class: 'inp', id: 'luser', type: 'email', placeholder: 'supervisor@velopos.do' })
          )
        ),

        // Contraseña
        h('div', { class: 'fg' },
          h('label', { class: 'lbl' }, 'Contraseña'),
          h('div', { class: 'inp-ic' },
            h('div', { class: 'ic', html: svg('lock') }),
            h('input', { class: 'inp', id: 'lpass', type: 'password', placeholder: '••••••••',
              onkeydown: e => { if (e.key === 'Enter') doLogin(); }
            })
          )
        ),

        // Botón ingresar
        h('button', { class: 'btn btn-dark btn-fw btn-lg', onclick: doLogin, html: `${svg('lock')} Ingresar` }),

        // Versión — leída dinámicamente
        h('div', { style: { textAlign:'center', fontSize:'10px', color:'var(--muted2)', marginTop:'16px' } },
          `Velo POS v${window._appVersion || '1.5.1'}`
        )
      )
    );
    root.appendChild(wrap);
    setTimeout(() => {
      document.getElementById('lpass')?.focus();
      _startLoginClock();
    }, 50);
  }

  // Control de intentos de login
  let loginAttempts = 0;
  const MAX_ATTEMPTS = 5;
  let loginBlocked = false;

  async function doLogin() {
    if (loginBlocked) {
      document.getElementById('lerr').innerHTML =
        `<div class="err">Demasiados intentos. Espera 30 segundos.</div>`;
      return;
    }

    const lerr   = document.getElementById('lerr');
    const passEl = document.getElementById('lpass');
    const userEl = document.getElementById('luser');
    if (!passEl) return;

    const pass = passEl.value.trim();
    if (!pass) {
      lerr.innerHTML = `<div class="err">Ingresa tu contraseña.</div>`;
      return;
    }

    let email = '';
    if (selRole === 'cajero') {
      email = userEl?.value?.trim() || '';
    } else {
      email = userEl?.value?.trim().toLowerCase() || '';
    }

    lerr.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px 0">Verificando...</div>`;

    const result = await window.api.auth.login({ email, password: pass });

    if (!result.ok) {
      loginAttempts++;
      const restantes = MAX_ATTEMPTS - loginAttempts;
      if (loginAttempts >= MAX_ATTEMPTS) {
        loginBlocked = true;
        lerr.innerHTML = `<div class="err">Demasiados intentos fallidos. Espera 30 segundos.</div>`;
        setTimeout(() => { loginAttempts = 0; loginBlocked = false; lerr.innerHTML = ''; }, 30000);
      } else {
        lerr.innerHTML = `<div class="err">
          Usuario o contraseña incorrectos.
          ${restantes <= 2 ? `<br><span style="font-size:10px">Intentos restantes: ${restantes}</span>` : ''}
        </div>`;
      }
      passEl.value = '';
      passEl.focus();
      return;
    }

    if (selRole === 'cajero' && result.user.role !== 'cajero') {
      lerr.innerHTML = `<div class="err">Este usuario no tiene rol de cajero.</div>`; return;
    }
    if (selRole === 'admin' && !['admin','superadmin'].includes(result.user.role)) {
      lerr.innerHTML = `<div class="err">Este usuario no tiene acceso de supervisor.</div>`; return;
    }

    loginAttempts = 0;
    loginBlocked  = false;

    user = result.user;
    sessionStorage.setItem('vp_user', JSON.stringify(user));
    await loadAppData();
    renderApp();

    // ── Verificar primer login / cambio de contraseña obligatorio ──
    const settings   = await window.api.settings.getAll();
    const sinConfig  = !settings.biz_name || settings.biz_name === 'Mi Negocio';

    // Superadmin nunca se bloquea
    if (user.role === 'superadmin') return;

    // Verificar si ESTE usuario ya cambió su contraseña
    // Leemos el flag del usuario actual, no el global del sistema
    const userInfo   = await window.api.users.getById
      ? await window.api.users.getById(user.id).catch(() => null)
      : null;
    const pwdChanged = userInfo
      ? (userInfo.password_changed === '1' || userInfo.password_changed === 1)
      : (settings.password_changed === '1'); // fallback al setting global

    if (!pwdChanged) {
      window._pwdChangeRequired = true;

      if (sinConfig && user.role === 'admin') {
        // Primera vez: wizard completo de configuración
        setTimeout(() => renderAsistentePrimerLogin(), 400);
      } else {
        // Contraseña sin cambiar — aplica a admin Y cajero
        setTimeout(() => renderCambioContrasenaObligatorio(), 400);
      }
    } else {
      window._pwdChangeRequired = false;
    }
  }

  build();
}

// ══════════════════════════════════════════════
// APP SHELL
// ══════════════════════════════════════════════
function renderApp() {
  const root = document.getElementById('root');
  root.innerHTML = '';

  const shell  = h('div', { class: 'shell' });
  const sb     = h('div', { class: `sidebar ${sbSm ? 'sm' : ''}`, id: 'sidebar' });
  const main   = h('div', { class: 'main' });
  const topbar = h('div', { class: 'topbar', id: 'topbar' });
  const pageEl = h('div', { class: 'page fi', id: 'page' });

  shell.appendChild(sb);
  shell.appendChild(main);
  main.appendChild(topbar);
  main.appendChild(pageEl);
  root.appendChild(shell);

  buildSidebar();
  buildTopbar();
  routeTo(page);
}

// ══════════════════════════════════════════════
// SIDEBAR
// ══════════════════════════════════════════════
function buildSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.className = `sidebar ${sbSm ? 'sm' : ''}`;
  sb.innerHTML = '';

  // Brand
  const bizName = DB?.settings?.biz_name || CFG?.biz || '';
  const brand = h('div', { class: 'sb-brand' },
    h('div', { class: 'sb-logo', html: svg('wrench') }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', overflow: 'hidden' } },
      h('div', { class: 'sb-name' }, 'Velo POS'),
      h('div', { class: 'sb-tag', style: { opacity: '.7', fontSize: '10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
        bizName || 'v1.0.0')
    )
  );
  sb.appendChild(brand);

  // Navegación según rol
  const nav = h('div', { class: 'sb-nav' });

  const creditAlerts = getCreditAlerts();
  const alertBadge   = creditAlerts.length;

  const adminNavItems = [
    { key: 'dash',      icon: 'grid',     label: 'Dashboard',   badge: alertBadge > 0 ? alertBadge : null },
    { key: 'pos',       icon: 'monitor',  label: 'Punto de Venta' },
    { sep: 'Gestión' },
    { key: 'inventario',icon: 'box',      label: 'Inventario' },
    { key: 'compras',   icon: 'truck',    label: 'Compras' },
    { key: 'clientes',  icon: 'users',    label: 'Clientes' },
    { key: 'ventas',    icon: 'list',     label: 'Ventas' },
    { key: 'devoluciones', icon: 'return', label: 'Devoluciones' },
    { sep: 'Finanzas' },
    { key: 'caja',      icon: 'cash',     label: 'Caja' },
    { key: 'reportes',  icon: 'chart',    label: 'Reportes' },
    { sep: 'Sistema' },
    { key: 'etiquetas', icon: 'barcode',  label: 'Etiquetas',
      ...(window._bcEnabled ? {} : { hidden: true }) },
    { key: 'configuracion', icon: 'settings', label: 'Configuración' },
    ...(user?.role === 'superadmin'
      ? [{ key: 'auditoria', icon: 'alert',  label: 'Auditoría' },
         { sep: 'Desarrollador' },
         { key: 'superadmin', icon: 'code',  label: 'Panel Dev' }]
      : []),
  ];

  const cajeroNavItems = [
    { key: 'pos',       icon: 'monitor',  label: 'Punto de Venta' },
    { key: 'clientes',  icon: 'users',    label: 'Clientes',
      badge: alertBadge > 0 ? alertBadge : null },
    { key: 'ventas',    icon: 'list',     label: 'Ventas' },
    { key: 'caja',      icon: 'cash',     label: 'Caja' },
  ];

  const items = ['admin','superadmin'].includes(user?.role) ? adminNavItems : cajeroNavItems;

  items.forEach(it => {
    if (it.sep) {
      nav.appendChild(h('span', { class: 'nav-lbl' }, it.sep));
      return;
    }
    if (it.hidden) return;  // nav items condicionalmente ocultos
    const ni = h('div', {
      class: `nav-item ${page === it.key ? 'on' : ''}`,
      'data-key': it.key,
      onclick: () => routeTo(it.key)
    },
      S(it.icon),
      h('span', { class: 'nav-txt' }, it.label),
      ...(it.badge ? [h('span', { class: 'nav-badge' }, it.badge)] : [])
    );
    nav.appendChild(ni);
  });

  sb.appendChild(nav);

  // Footer usuario
  const foot = h('div', { class: 'sb-foot' },
    h('div', { class: 'sb-user' },
      h('div', { class: 'sb-av' }, user?.avatar || 'U'),
      h('div', { class: 'sb-meta' },
        h('div', { class: 'sb-uname' }, user?.name || 'Usuario'),
        h('div', { class: 'sb-urole' }, user?.role || '')
      )
    ),
    h('div', {
      class: 'nav-item logout',
      onclick: doLogout
    },
      S('logout'),
      h('span', { class: 'nav-txt' }, 'Cerrar sesión')
    )
  );
  sb.appendChild(foot);
}

// ══════════════════════════════════════════════
// TOPBAR
// ══════════════════════════════════════════════
function buildTopbar() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  tb.innerHTML = '';

  const titles = {
    dash:          'Dashboard',
    pos:           'Punto de Venta',
    inventario:    'Inventario',
    compras:       'Compras',
    clientes:      'Clientes',
    ventas:        'Ventas',
    devoluciones:  'Devoluciones',
    caja:          'Caja',
    reportes:      'Reportes',
    configuracion: 'Configuración',
    etiquetas:     'Etiquetas de Código de Barras',
  };

  // ── Izquierda: toggle + título ───────────────
  const left = h('div', { class: 'tb-left' });
  left.appendChild(h('button', {
    class: 'tb-toggle',
    onclick: () => { sbSm = !sbSm; buildSidebar(); buildTopbar(); },
    html: svg('menu')
  }));
  left.appendChild(h('span', { class: 'tb-title' }, titles[page] || 'Velo POS'));

  // ── Centro: reloj digital ────────────────────
  const clockWrap = h('div', { class: 'tb-clock', id: 'tb-clock-wrap' });
  const clockTime = h('div', { class: 'tb-clock-time', id: 'tb-clock-time' });
  const clockDate = h('div', { class: 'tb-clock-date', id: 'tb-clock-date' });
  clockWrap.appendChild(clockTime);
  clockWrap.appendChild(clockDate);

  // ── Derecha: pills + bell ────────────────────
  const right = h('div', { class: 'tb-right' });

  right.appendChild(h('div', {
    class: `pill ${cajaOpen ? 'open' : 'closed'}`,
    html: cajaOpen
      ? `${svg('check')} Caja Abierta`
      : `${svg('xmark')} Caja Cerrada`
  }));

  const alerts = getCreditAlerts();
  const bell = h('div', { class: 'ib', onclick: () => routeTo('clientes') },
    h('div', { html: svg('bell') })
  );
  if (alerts.length) bell.appendChild(h('span', { class: 'dot' }));
  right.appendChild(bell);

  tb.appendChild(left);
  tb.appendChild(clockWrap);
  tb.appendChild(right);

  // Iniciar/reiniciar el ticker del reloj
  _startTopbarClock();
}

// ── Reloj del topbar ──────────────────────────
// Un solo intervalo global que actualiza solo el texto, sin reconstruir el DOM
let _clockInterval = null;

function _startTopbarClock() {
  // Limpiar intervalo anterior si existía
  if (_clockInterval) clearInterval(_clockInterval);

  function _tick() {
    const timeEl = document.getElementById('tb-clock-time');
    const dateEl = document.getElementById('tb-clock-date');
    if (!timeEl || !dateEl) { clearInterval(_clockInterval); return; }

    const now  = new Date();
    const h24  = now.getHours();
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12  = h24 % 12 || 12;
    const hh   = String(h12).padStart(2, '0');
    const mm   = String(now.getMinutes()).padStart(2, '0');
    const ss   = String(now.getSeconds()).padStart(2, '0');
    const dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const meses= ['Ene','Feb','Mar','Abr','May','Jun',
                  'Jul','Ago','Sep','Oct','Nov','Dic'];
    const dia  = dias[now.getDay()];
    const d    = now.getDate();
    const mes  = meses[now.getMonth()];

    timeEl.innerHTML =
      `${hh}<span class="tb-clock-sep">:</span>${mm}` +
      `<span class="tb-clock-sep">:</span>` +
      `<span class="tb-clock-sec">${ss}</span>` +
      `<span class="tb-clock-ampm">${ampm}</span>`;
    dateEl.textContent = `${dia} ${d} ${mes}`;
  }

  _tick(); // inmediato para evitar el primer segundo en blanco
  _clockInterval = setInterval(_tick, 1000);
}

// ── Reloj del login ───────────────────────────
let _loginClockInterval = null;

function _startLoginClock() {
  if (_loginClockInterval) clearInterval(_loginClockInterval);

  function _tick() {
    const timeEl = document.getElementById('login-clock-time');
    const dateEl = document.getElementById('login-clock-date');
    if (!timeEl || !dateEl) { clearInterval(_loginClockInterval); return; }

    const now  = new Date();
    const h24  = now.getHours();
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12  = h24 % 12 || 12;
    const hh   = String(h12).padStart(2, '0');
    const mm   = String(now.getMinutes()).padStart(2, '0');
    const ss   = String(now.getSeconds()).padStart(2, '0');
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const meses= ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

    timeEl.innerHTML =
      `${hh}<span class="lc-sep">:</span>${mm}` +
      `<span class="lc-sep">:</span>` +
      `<span class="lc-sec">${ss}</span>` +
      `<span class="lc-ampm">${ampm}</span>`;
    dateEl.textContent =
      `${dias[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]} ${now.getFullYear()}`;
  }

  _tick();
  _loginClockInterval = setInterval(_tick, 1000);
}

// ══════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════
function routeTo(p) {
  // Bloquear navegación si hay cambio de contraseña obligatorio pendiente
  if (window._pwdChangeRequired && p !== 'configuracion') {
    toast('Debes cambiar tu contraseña antes de continuar', 'w');
    renderCambioContrasenaObligatorio();
    return;
  }
  page = p;

  // Cajero no puede acceder a rutas admin
  if (user?.role === 'cajero') {
    const allowed = ['pos', 'clientes', 'ventas', 'caja'];
    if (!allowed.includes(p)) { page = 'pos'; }
  }

  // Actualizar solo el item activo sin reconstruir todo el sidebar
  document.querySelectorAll('.nav-item').forEach(ni => {
    ni.classList.remove('on');
    if (ni.dataset.key === page) ni.classList.add('on');
  });
  buildTopbar();

  const el = document.getElementById('page');
  if (!el) return;
  el.className = 'page fi';
  // Reset estilos inline que el POS establece (padding:0, overflow:hidden)
  // Sin esto, todos los módulos que vienen después del POS pierden su padding
  el.style.cssText = '';

  switch (page) {
    case 'dash':         renderDash(el);          break;
    case 'pos':          renderPOS(el);            break;
    case 'inventario':   renderInventario(el);     break;
    case 'compras':      renderCompras(el);         break;
    case 'clientes':     renderClientes(el);       break;
    case 'ventas':       renderVentas(el);         break;
    case 'devoluciones': renderDevoluciones(el);   break;
    case 'caja':         renderCaja(el);           break;
    case 'reportes':     renderReportes(el);       break;
    case 'auditoria':
      if (user?.role !== 'superadmin') { renderDash(el); break; }
      renderAuditoria(el); break;
    case 'configuracion':renderConfiguracion(el);  break;
    case 'etiquetas':
      if (!window._bcEnabled && user?.role !== 'superadmin') { renderDash(el); break; }
      renderBarcode(el); break;
    case 'superadmin':   renderSuperAdmin(el);     break;
    default:             renderDash(el);
  }
}

// ══════════════════════════════════════════════
// LOGOUT
// ══════════════════════════════════════════════
async function doLogout() {
  if (user) {
    await window.api.auth.logout({ userId: user.id, userName: user.name });
  }
  user = null;
  page = 'dash';
  resetInvoices();
  sessionStorage.removeItem('vp_user');
  renderLogin();
}

// ══════════════════════════════════════════════
// MODAL HELPERS (usados por todos los módulos)
// ══════════════════════════════════════════════
function openModal(html, cls = '') {
  closeModal();
  const ov = h('div', { class: 'ov', id: 'modal-ov',
    onclick: e => { if (e.target === ov) closeModal(); }
  });
  const m = h('div', {
    class: `modal ${cls}`,
    style: { maxHeight: 'calc(100vh - 60px)', overflowY: 'auto' },
    html
  });
  ov.appendChild(m);
  document.body.appendChild(ov);
}

function closeModal() {
  document.getElementById('modal-ov')?.remove();
}

// ── Render un modal de confirmación genérico ──
function confirmModal(msg, onOk, okLabel = 'Confirmar', okClass = 'btn-red') {
  openModal(`
    <div class="modal-title">Confirmar acción</div>
    <div class="modal-sub">${msg}</div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn ${okClass}" id="cm-ok">${okLabel}</button>
    </div>
  `);
  document.getElementById('cm-ok').onclick = () => { closeModal(); onOk(); };
}

// ══════════════════════════════════════════════
// CONFIGURACIÓN DEL NEGOCIO
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
// NOTA: Las siguientes funciones están en módulos separados:
//   config.js      — renderConfiguracion y toda la configuración
//   wizard.js      — wizard de primer login y cambio de contraseña
//   superadmin.js  — panel del super administrador
//   updater-ui.js  — panel de actualizaciones y plantillas de impresión
// ══════════════════════════════════════════════
