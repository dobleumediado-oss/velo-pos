// ══════════════════════════════════════════════
// app.js — Render principal, Login, Sidebar,
//           Topbar y Router de páginas
// ══════════════════════════════════════════════

// Manejadores globales de error del renderer (Fase 2): registran en el log
// persistente sin interrumpir la app. Ayudan a diagnosticar pantallas rotas.
window.addEventListener('error', (e) => {
  try {
    window.api?.log?.error('renderer',
      e.message || 'error', { src: e.filename, line: e.lineno, col: e.colno });
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    window.api?.log?.error('renderer-promise',
      r?.message || String(r), { stack: r?.stack });
  } catch {}
});

// ── Bootstrap ────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Cargar versión de la app para mostrar en login y config
  try {
    const vr = await window.api.version.getInfo();
    window._appVersion = vr?.ok ? vr.data?.appVersion : '1.4.1';
  } catch { window._appVersion = '1.5.5'; }

  // Cargar todos los datos vía IPC
  await loadAppData();

  // ── Multi-negocios: mostrar selector si hay negocios adicionales ──
  if (CFG.module_multi_negocio === '1' && window.api?.business) {
    try {
      const bizRes = await window.api.business.getAll();
      const businesses = bizRes?.data || [];
      if (businesses.length > 0) {
        // Hay negocios secundarios — mostrar selector antes del login
        renderBusinessSelector(businesses);
        return; // el selector se encarga del resto del flujo
      }
    } catch(e) { console.warn('[Business] Error cargando negocios:', e.message); }
  }

  // Restaurar sesión de sessionStorage
  const saved = sessionStorage.getItem('vp_user');
  if (saved) {
    try { user = JSON.parse(saved); window._currentUser = user; } catch {}
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
// ── Selector de negocio (multi-negocios) ─────────────────────────────
function renderBusinessSelector(businesses) {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.style.cssText = 'width:100%;height:100%;display:flex;';

  // Usar exactamente las mismas clases CSS del login para consistencia visual
  const wrap = h('div', {
    class: 'login-wrap',
    style: { width:'100%', height:'100%', display:'flex', flexDirection:'column',
             alignItems:'center', justifyContent:'center', gap:'20px' }
  },
    // Reloj igual al del login
    h('div', { class: 'login-clock-outer' },
      h('div', { class: 'login-clock-time', id: 'biz-clock-time' }, '00:00:00'),
      h('div', { class: 'login-clock-date', id: 'biz-clock-date' }, '')
    ),

    // Card con mismo estilo que login-card
    h('div', { class: 'login-card', style: { width:'420px' } },

      // Header igual al login
      h('div', { class: 'login-header' },
        h('div', { class: 'login-logo' },
          h('img', { src: 'assets/icon.png',
            style: { width:'100%', height:'100%', borderRadius:'13px', objectFit:'cover' } })
        ),
        h('div', null,
          h('div', { class: 'login-title' }, 'Velo POS'),
          h('div', { class: 'login-sub' }, 'Selecciona con qué negocio trabajar')
        )
      ),

      // Lista de negocios como "role-row" estilo
      h('div', { style: { display:'flex', flexDirection:'column', gap:'8px', marginBottom:'8px' } },

        // Negocio principal — estilo role-btn on
        h('div', {
          id: 'biz-principal',
          class: 'role-btn on',
          style: { display:'flex', alignItems:'center', gap:'12px', padding:'12px 14px',
                   textAlign:'left', cursor:'pointer' },
          onclick: () => {
            window._activeBizId = null;
            sessionStorage.removeItem('vp_active_biz');
            clearInterval(window._bizClock);
            renderLogin();
          }
        },
          h('div', { class: 'role-icon', style: { background:'var(--accent)', flexShrink:'0', width:'32px', height:'32px' },
            html: svg('home') }),
          h('div', { style: { flex:'1' } },
            h('div', { class: 'role-lbl' }, 'Negocio Principal'),
            h('div', { class: 'role-sub' }, 'Base de datos original')
          ),
          h('div', { style: { color:'rgba(255,255,255,.3)' },
            html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>` })
        ),

        // Separador
        businesses.length ? h('div', {
          style: { display:'flex', alignItems:'center', gap:'8px', padding:'2px 0' }
        },
          h('div', { style: { flex:'1', height:'1px', background:'rgba(255,255,255,.08)' } }),
          h('div', { style: { fontSize:'10px', color:'rgba(255,255,255,.25)', fontWeight:'600',
                               textTransform:'uppercase', letterSpacing:'.05em' } }, 'Otros negocios'),
          h('div', { style: { flex:'1', height:'1px', background:'rgba(255,255,255,.08)' } })
        ) : null,

        // Negocios secundarios
        ...businesses.map(b => h('div', {
          class: 'role-btn',
          dataset: { bizid: b.id },
          style: { display:'flex', alignItems:'center', gap:'12px', padding:'12px 14px',
                   textAlign:'left', cursor:'pointer' },
          onclick: async function() {
            root.querySelectorAll('.role-btn').forEach(el => {
              el.style.pointerEvents = 'none'; el.style.opacity = '.5';
            });
            this.style.opacity = '1';
            this.style.borderColor = 'rgba(22,163,74,.6)';
            await window.api.settings.set({ key: '_active_biz', value: b.id });
            window._activeBizId = b.id;
            sessionStorage.setItem('vp_active_biz', b.id);
            clearInterval(window._bizClock);
            await loadAppData();
            renderLogin();
          }
        },
          h('div', { class: 'role-icon', style: { background:'rgba(255,255,255,.12)', flexShrink:'0', width:'32px', height:'32px' },
            html: svg('building') }),
          h('div', { style: { flex:'1', minWidth:'0' } },
            h('div', { class: 'role-lbl',
              style: { overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' } }, b.name),
            h('div', { class: 'role-sub' }, b.description || 'Base de datos independiente')
          ),
          h('div', { style: { color:'rgba(255,255,255,.3)' },
            html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>` })
        ))
      ),

      // Versión al pie
      h('div', { style: { textAlign:'center', marginTop:'4px' } },
        h('div', { style: { fontSize:'11px', color:'rgba(255,255,255,.2)' } },
          `Velo POS v${window._appVersion||'1.5.5'}`)
      )
    )
  );

  root.appendChild(wrap);

  // Reloj — mismo código que el login
  function tickBiz() {
    const now = new Date();
    const hh  = String(now.getHours()%12||12).padStart(2,'0');
    const mm  = String(now.getMinutes()).padStart(2,'0');
    const ss  = String(now.getSeconds()).padStart(2,'0');
    const ampm = now.getHours() >= 12 ? 'PM' : 'AM';
    const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
                    'septiembre','octubre','noviembre','diciembre'];
    const ct = document.getElementById('biz-clock-time');
    const cd = document.getElementById('biz-clock-date');
    if (ct) ct.innerHTML = `${hh}<span class="lc-sep">:</span>${mm}<span class="lc-sec">:${ss}</span><span class="lc-ampm">${ampm}</span>`;
    if (cd) cd.textContent = `${days[now.getDay()]}, ${now.getDate()} de ${months[now.getMonth()]} ${now.getFullYear()}`;
  }
  tickBiz();
  window._bizClock = setInterval(tickBiz, 1000);
}

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

        // ← Botón retroceder al selector (solo si multi-negocios activo y hay negocios)
        ...(CFG.module_multi_negocio === '1' ? [
          h('div', {
            style: { marginBottom:'8px', marginTop:'4px' }
          },
            h('button', {
              style: `display:inline-flex;align-items:center;gap:6px;background:none;border:none;
                      color:rgba(255,255,255,.4);font-size:12px;cursor:pointer;padding:4px 0;
                      transition:color .15s`,
              onmouseenter: function() { this.style.color='rgba(255,255,255,.75)'; },
              onmouseleave: function() { this.style.color='rgba(255,255,255,.4)'; },
              onclick: async () => {
                try {
                  const bizRes = await window.api.business.getAll();
                  const businesses = bizRes?.data || [];
                  if (businesses.length > 0) {
                    window._activeBizId = null;
                    sessionStorage.removeItem('vp_active_biz');
                    await window.api.settings.set({ key: '_active_biz', value: '' });
                    await loadAppData();
                    renderBusinessSelector(businesses);
                    return;
                  }
                } catch(e) { console.warn('[Business] Error cargando negocios secundarios:', e.message); }
                // Si no hay negocios secundarios, simplemente recargar login
                renderLogin();
              },
              html: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg> Cambiar negocio`
            })
          )
        ] : []),

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
          `Velo POS v${window._appVersion || '1.5.5'}`
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
    window._currentUser = user;  // accesible desde módulos externos
    sessionStorage.setItem('vp_user', JSON.stringify(user));
    await loadAppData();
    renderApp();

    // ── Verificar primer login / cambio de contraseña obligatorio ──
    const settings   = await window.api.settings.getAll();
    const sinConfig  = !settings.biz_name || settings.biz_name === 'Mi Negocio';

    // Superadmin nunca se bloquea
    if (user.role === 'superadmin') return;

    // El backend indica si esta cuenta sigue usando la contraseña demo
    // predeterminada (admin123 / caja123). Solo en ese caso se obliga el
    // cambio. Usuarios creados por el negocio nunca se bloquean.
    if (result.mustChangePassword) {
      window._pwdChangeRequired = true;

      if (sinConfig && user.role === 'admin') {
        // Primera vez: wizard completo de configuración
        setTimeout(() => renderAsistentePrimerLogin(), 400);
      } else {
        // Contraseña por defecto sin cambiar — aplica a admin Y cajero
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
    ...(_adminPuede('module_gastos') ? [{ key: 'gastos', icon: 'dollar', label: 'Gastos' }] : []),
    ...(_adminPuede('module_contabilidad') ? [
      { key: 'bancos',       icon: 'bank',    label: 'Bancos y Cuentas' },
      { key: 'contabilidad', icon: 'ledger',  label: 'Contabilidad' },
    ] : []),
    ...(_adminPuede('module_sucursales')    ? [{ key: 'sucursales', icon: 'building', label: 'Sucursales'    }] : []),
    ...((_adminPuede('module_vehiculos') || _adminPuede('module_mantenimiento')) ? [{ key: 'vehiculos', icon: 'car', label: 'Vehículos' }] : []),
    ...(_adminPuede('module_envios')        ? [{ key: 'envios',     icon: 'truck',    label: 'Envíos'        }] : []),
    ...(_adminPuede('module_conduce')       ? [{ key: 'conduce',    icon: 'pkg',      label: 'Conduces'      }] : []),
    { key: 'reportes',  icon: 'chart',    label: 'Reportes' },
    { sep: 'Sistema' },
    { key: 'etiquetas', icon: 'barcode',  label: 'Etiquetas',
      ...(window._bcEnabled && (CFG.barcode_enabled_roles || 'admin').includes('admin') ? {} : { hidden: true }) },
    { key: 'configuracion', icon: 'settings', label: 'Configuración' },
    ...(user?.role === 'superadmin'
      ? [{ key: 'auditoria', icon: 'alert',  label: 'Auditoría' },
         { sep: 'Desarrollador' },
         { key: 'superadmin', icon: 'code',  label: 'Panel Dev' }]
      : []),
  ];

  // Verifica si un módulo está activo Y el rol tiene permiso
  function _adminPuede(modKey) {
    return CFG[modKey] === '1' && (CFG[modKey + '_roles'] || 'admin').includes('admin');
  }
  function _cajeroPuede(modKey) {
    return CFG[modKey] === '1' && (CFG[modKey + '_roles'] || 'admin').includes('cajero');
  }

  const cajeroNavItems = [
    { key: 'pos',       icon: 'monitor',  label: 'Punto de Venta' },
    { key: 'clientes',  icon: 'users',    label: 'Clientes',
      badge: alertBadge > 0 ? alertBadge : null },
    { key: 'ventas',    icon: 'list',     label: 'Ventas' },
    { key: 'caja',      icon: 'cash',     label: 'Caja' },
    ...(_cajeroPuede('module_gastos')     ? [{ key: 'gastos',     icon: 'dollar',  label: 'Gastos' }]      : []),
    ...(_cajeroPuede('module_envios')     ? [{ key: 'envios',     icon: 'truck',   label: 'Envíos' }]      : []),
    ...(_cajeroPuede('module_conduce')    ? [{ key: 'conduce',    icon: 'pkg',     label: 'Conduces' }]    : []),
    ...(_cajeroPuede('module_sucursales') ? [{ key: 'sucursales', icon: 'building',label: 'Sucursales' }]  : []),
    ...((_cajeroPuede('module_vehiculos') || _cajeroPuede('module_mantenimiento'))
                                          ? [{ key: 'vehiculos',  icon: 'car',     label: 'Vehículos' }]  : []),
    ...(window._bcEnabled && (CFG.barcode_enabled_roles || 'admin').includes('cajero')
                                          ? [{ key: 'etiquetas',  icon: 'barcode', label: 'Etiquetas' }]  : []),
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
    gastos:        'Gastos y Cuentas por Pagar',
    vehiculos:     'Vehículos y Mantenimiento',
    envios:        'Envíos y Despachos',
    sucursales:    'Sucursales',
    reportes:      'Reportes',
    configuracion: 'Configuración',
    etiquetas:     'Etiquetas de Código de Barras',
    bancos:        'Bancos y Cuentas Financieras',
    contabilidad:  'Contabilidad',
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

  // ── Buscador global ⌘K ─────────────────────
  right.appendChild(h('button', {
    class: 'btn btn-ghost',
    title: 'Búsqueda global (⌘K / Ctrl+K)',
    style: { fontSize: '12px', padding: '5px 10px', gap: '5px',
             border: '1px solid var(--line)', borderRadius: '8px' },
    onclick: _openGSearch,
    html: `${svg('search')} <span style="font-size:11px;color:var(--muted)">⌘K</span>`
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
  // Limpiar auto-refresh si salimos del dashboard
  if (p !== 'dash' && window._dashRefreshInterval) {
    clearInterval(window._dashRefreshInterval);
    window._dashRefreshInterval = null;
  }
  // Bloquear navegación si hay cambio de contraseña obligatorio pendiente
  if (window._pwdChangeRequired && p !== 'configuracion') {
    toast('Debes cambiar tu contraseña antes de continuar', 'w');
    renderCambioContrasenaObligatorio();
    return;
  }
  page = p;

  // Admin: rutas base + módulos opcionales con permiso admin
  if (user?.role === 'admin') {
    const baseAdmin = ['dash','pos','inventario','compras','clientes','ventas','devoluciones','caja','reportes','configuracion'];
    const modRoutesAdmin = {
      gastos:       ['module_gastos'],
      bancos:       ['module_contabilidad'],
      contabilidad: ['module_contabilidad'],
      sucursales:   ['module_sucursales'],
      vehiculos:    ['module_vehiculos', 'module_mantenimiento'],
      envios:       ['module_envios'],
      conduce:      ['module_conduce'],
      etiquetas:    ['barcode_enabled'],
    };
    const allowedAdmin = [...baseAdmin];
    Object.entries(modRoutesAdmin).forEach(([route, keys]) => {
      const active  = keys.some(k => CFG[k] === '1' || (k === 'barcode_enabled' && window._bcEnabled));
      const permit  = keys.some(k => (CFG[k + '_roles'] || 'admin').includes('admin'));
      if (active && permit) allowedAdmin.push(route);
    });
    if (!allowedAdmin.includes(p)) { page = 'dash'; }
  }

  // Cajero: rutas base + módulos con permiso cajero
  if (user?.role === 'cajero') {
    const allowed = ['pos', 'clientes', 'ventas', 'caja'];
    const modRoutes = {
      gastos:     ['module_gastos'],
      envios:     ['module_envios'],
      conduce:    ['module_conduce'],
      sucursales: ['module_sucursales'],
      vehiculos:  ['module_vehiculos', 'module_mantenimiento'],
      etiquetas:  ['barcode_enabled'],
    };
    Object.entries(modRoutes).forEach(([route, keys]) => {
      const active  = keys.some(k => CFG[k] === '1' || (k === 'barcode_enabled' && window._bcEnabled));
      const permit  = keys.some(k => (CFG[k + '_roles'] || 'admin').includes('cajero'));
      if (active && permit) allowed.push(route);
    });
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
    case 'gastos':       renderGastos(el);         break;
    case 'bancos':       renderBancos(el);         break;
    case 'contabilidad': renderContabilidad(el);   break;
    case 'vehiculos':    renderVehiculos(el);      break;
    case 'envios':       renderEnvios(el);         break;
    case 'conduce':      renderConduce(el);        break;
    case 'sucursales':   renderSucursales(el);     break;
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
  // Limpiar auto-refresh del dashboard
  if (window._dashRefreshInterval) {
    clearInterval(window._dashRefreshInterval);
    window._dashRefreshInterval = null;
  }
  if (user) {
    await window.api.auth.logout({ userId: user.id, userName: user.name });
  }
  user = null;
  window._currentUser = null;
  page = 'dash';
  resetInvoices();
  sessionStorage.removeItem('vp_user');

  // Si multi-negocios está activo y hay negocios, volver al selector
  if (CFG.module_multi_negocio === '1' && window.api?.business) {
    try {
      const bizRes = await window.api.business.getAll();
      const businesses = bizRes?.data || [];
      if (businesses.length > 0) {
        // Limpiar negocio activo al cerrar sesión
        window._activeBizId = null;
        sessionStorage.removeItem('vp_active_biz');
        await window.api.settings.set({ key: '_active_biz', value: '' });
        await loadAppData();
        renderBusinessSelector(businesses);
        return;
      }
    } catch(e) { console.warn('[Logout] Error cargando negocios:', e.message); }
  }
  renderLogin();
}

// ══════════════════════════════════════════════
// MODAL HELPERS (usados por todos los módulos)
// ══════════════════════════════════════════════
function openModal(html, cls = '') {
  closeModal();
  const ov = h('div', { class: 'ov', id: 'modal-ov',
    // Click en el backdrop: solo cierra si el modal está LIMPIO. Si el usuario
    // ya escribió/cambió algo, NO se cierra (protege su trabajo) y hace un shake.
    onclick: e => {
      if (e.target !== ov) return;
      if (_formIsDirty(ov._snap)) { _shakeEl(m); return; }
      closeModal();
    }
  });
  const m = h('div', {
    class: `modal ${cls}`,
    style: { maxHeight: 'calc(100vh - 60px)', overflowY: 'auto' },
    html
  });
  ov.appendChild(m);
  document.body.appendChild(ov);
  _bindModalSafeActions(m);
  // Snapshot del estado inicial de los campos para detectar cambios ("sucio").
  ov._snap = _snapshotForm(m);
}

function closeModal() {
  document.getElementById('modal-ov')?.remove();
}

// ══════════════════════════════════════════════
// LÓGICA DE MODALES "SUCIOS" (protección de datos sin guardar)
// Genérico: sirve tanto para openModal como para overlays propios (envíos).
// ══════════════════════════════════════════════
function _fieldSig(el) {
  return (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '0') : (el.value ?? '');
}

// Captura el valor inicial de todos los campos editables del modal.
function _snapshotForm(root) {
  const map = new Map();
  if (!root) return map;
  root.querySelectorAll('input, textarea, select').forEach(el => {
    if (el.type === 'hidden' || el.disabled || el.readOnly) return;
    map.set(el, _fieldSig(el));
  });
  return map;
}

// ¿Algún campo cambió respecto al snapshot inicial? ("algo escrito, aunque sea una letra")
function _formIsDirty(snapshot) {
  if (!snapshot || !snapshot.size) return false;
  for (const [el, sig] of snapshot) {
    if (!document.body.contains(el)) continue;  // campo removido dinámicamente
    if (_fieldSig(el) !== sig) return true;
  }
  return false;
}

// Sacudida sutil para dar feedback cuando se ignora un click fuera con datos.
function _shakeEl(el) {
  try {
    el.animate(
      [{ transform:'translateX(0)' }, { transform:'translateX(-6px)' }, { transform:'translateX(6px)' },
       { transform:'translateX(-4px)' }, { transform:'translateX(4px)' }, { transform:'translateX(0)' }],
      { duration: 250, easing: 'ease-in-out' }
    );
  } catch {}
}

// Confirmación "¿Descartar cambios?" que se dibuja ENCIMA sin destruir el modal
// actual (openModal sí destruiría el modal, perdiendo lo escrito). Devuelve Promise<bool>.
function _confirmDiscard() {
  return new Promise(resolve => {
    const ov = h('div', { class: 'ov', style: { zIndex: '10001' },
      onclick: e => { if (e.target === ov) { ov.remove(); resolve(false); } } });
    const box = h('div', { class: 'modal', style: { maxWidth: '380px' }, html: `
      <div class="modal-title">¿Descartar cambios?</div>
      <div class="modal-sub">Tienes información sin guardar en este formulario. Si cierras, se perderá.</div>
      <div class="modal-foot">
        <button class="btn btn-out" id="_dc-no">Seguir editando</button>
        <button class="btn btn-red" id="_dc-yes">Descartar y cerrar</button>
      </div>` });
    ov.appendChild(box);
    document.body.appendChild(ov);
    box.querySelector('#_dc-no') .addEventListener('click', () => { ov.remove(); resolve(false); });
    box.querySelector('#_dc-yes').addEventListener('click', () => { ov.remove(); resolve(true);  });
  });
}

// Cierre solicitado por el usuario (botón Cancelar): si hay cambios, pregunta.
async function _requestCloseModal() {
  const ov = document.getElementById('modal-ov');
  if (ov && _formIsDirty(ov._snap)) {
    const ok = await _confirmDiscard();
    if (!ok) return;   // "Seguir editando" → no cerrar
  }
  closeModal();
}

function _bindModalSafeActions(root) {
  if (!root) return;

  const bind = (el, handler) => {
    el.removeAttribute('onclick');
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { await handler(ev); }
      catch (e) { toast(e?.message || 'No se pudo completar la acción', 'err'); }
    });
  };

  root.querySelectorAll('[onclick]').forEach(el => {
    const raw = (el.getAttribute('onclick') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/;+$/, '');

    if (raw === 'closeModal()') {
      // Botón Cancelar: pasa por el cierre inteligente (pregunta si hay cambios).
      bind(el, () => _requestCloseModal());
      return;
    }

    if (raw === 'closeModal();delete window._convEstado;delete window._convSale') {
      bind(el, () => {
        closeModal();
        delete window._convEstado;
        delete window._convSale;
      });
      return;
    }

    const fallback = raw.match(/^closeModal\(\);window\._fallbackResolve\((true|false)\)$/);
    if (fallback) {
      bind(el, () => {
        closeModal();
        if (typeof window._fallbackResolve === 'function') {
          window._fallbackResolve(fallback[1] === 'true');
          delete window._fallbackResolve;
        }
      });
      return;
    }

    const cancelarOrdenMatch = raw.match(/^cancelarOrden\((\d+)\)$/);
    if (cancelarOrdenMatch && typeof window.cancelarOrden === 'function') {
      bind(el, () => window.cancelarOrden(Number(cancelarOrdenMatch[1])));
      return;
    }

    const recibirOrdenMatch = raw.match(/^closeModal\(\);recibirOrden\((\d+)\)$/);
    if (recibirOrdenMatch && typeof window.recibirOrden === 'function') {
      bind(el, () => {
        closeModal();
        return window.recibirOrden(Number(recibirOrdenMatch[1]));
      });
      return;
    }

    // Caso genérico seguro: onclick que llama a UNA función global sin argumentos
    // (ej. "confirmarApertura()", "confirmarCierre()"). Estos botones antes
    // quedaban muertos porque no estaban en la lista blanca y se les quitaba el
    // onclick sin re-enganchar nada. Solo se permite el patrón `nombreFn()` puro
    // — nada con argumentos, punto y coma, ni expresiones — para no ejecutar
    // código arbitrario.
    const simpleCall = raw.match(/^([a-zA-Z_$][\w$]*)\(\)$/);
    if (simpleCall && typeof window[simpleCall[1]] === 'function') {
      bind(el, () => window[simpleCall[1]]());
      return;
    }
  });
}

// ── Render un modal de confirmación genérico ──
function confirmModal(msg, onOk, okLabel = 'Confirmar', okClass = 'btn-red') {
  openModal(`
    <div class="modal-title">Confirmar acción</div>
    <div class="modal-sub">${msg}</div>
    <div class="modal-foot">
      <button class="btn btn-out" id="cm-cancel">Cancelar</button>
      <button class="btn ${okClass}" id="cm-ok">${okLabel}</button>
    </div>
  `);
  document.getElementById('cm-cancel')?.addEventListener('click', closeModal);
  document.getElementById('cm-ok')?.addEventListener('click', () => { closeModal(); onOk(); });
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

// ══════════════════════════════════════════════
// BUSCADOR GLOBAL ⌘K / Ctrl+K
// Busca simultáneamente en productos, facturas
// y clientes. Resultados navegables con clic.
// ══════════════════════════════════════════════
let _gSearchOpen = false;

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    _gSearchOpen ? _closeGSearch() : _openGSearch();
  }
  if (e.key === 'Escape' && _gSearchOpen) _closeGSearch();
});

function _openGSearch() {
  if (_gSearchOpen) return;
  _gSearchOpen = true;

  const ov = h('div', {
    id: 'gsearch-ov',
    style: {
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-start',
      justifyContent: 'center', paddingTop: '80px',
    },
    onclick: e => { if (e.target === ov) _closeGSearch(); }
  });

  const box = h('div', {
    style: {
      width: '600px', maxWidth: '95vw',
      background: 'var(--surface)', borderRadius: '14px',
      boxShadow: '0 24px 64px rgba(0,0,0,.4)',
      overflow: 'hidden',
      border: '1px solid var(--line)',
    }
  });

  // Input
  const inp = h('input', {
    class: 'inp',
    type: 'text',
    placeholder: '🔍  Buscar producto, modelo, código, cliente o factura...',
    style: {
      width: '100%', fontSize: '16px', padding: '16px 20px',
      border: 'none', borderBottom: '1px solid var(--line)',
      borderRadius: 0, background: 'transparent',
    },
    oninput: e => _runGSearch(e.target.value, results),
  });

  const results = h('div', {
    id: 'gsearch-results',
    style: { maxHeight: '420px', overflowY: 'auto', padding: '8px 0' }
  });

  const footer = h('div', {
    style: {
      padding: '8px 16px', fontSize: '11px', color: 'var(--muted2)',
      borderTop: '1px solid var(--line)',
      display: 'flex', gap: '16px',
    },
    html: '<span>↵ Abrir</span><span>Esc Cerrar</span><span>⌘K Alternar</span>'
  });

  results.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted2);font-size:13px">
    Empieza a escribir para buscar en todo el sistema</div>`;

  box.appendChild(inp);
  box.appendChild(results);
  box.appendChild(footer);
  ov.appendChild(box);
  document.body.appendChild(ov);
  setTimeout(() => inp.focus(), 50);
}

function _closeGSearch() {
  document.getElementById('gsearch-ov')?.remove();
  _gSearchOpen = false;
}

let _gSearchSeq = 0;
async function _runGSearch(q, resultsEl) {
  if (!q || q.trim().length < 2) {
    resultsEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted2);font-size:13px">
      Empieza a escribir para buscar en todo el sistema</div>`;
    return;
  }
  const ql = q.trim();
  const qNorm   = searchNorm(ql);
  const qDigits = digitsOf(ql);
  const seq = ++_gSearchSeq;  // token anti-condición de carrera

  // ── Productos (en memoria, catálogo completo) ──
  const prods = (DB.products || []).filter(p => p.active !== 0 && (
    matchText(p.name, qNorm) ||
    matchText(p.code, qNorm) ||
    matchText(p.barcode, qNorm) ||
    matchText(p.model, qNorm) ||
    matchText(p.brand, qNorm) ||
    matchText(p.category, qNorm)
  )).slice(0, 5);

  // ── Clientes (en memoria, lista completa) ──
  const clientes = (DB.customers || []).filter(c => c.id !== 1 && c.active !== 0 && (
    matchText(c.name, qNorm) ||
    matchText(c.phone, qNorm) ||
    matchDigits(c.phone, qDigits) ||
    matchText(c.rnc, qNorm) ||
    matchDigits(c.rnc, qDigits)
  )).slice(0, 3);

  // ── Facturas: búsqueda en TODO el historial vía backend ──
  // Incluye ventas históricas y de importación, no solo las de hoy en memoria.
  let facturas = [];
  try {
    facturas = await window.api.sales.search({ q: ql, limit: 4 }) || [];
  } catch (e) {
    // Respaldo: si el backend no responde, busca en lo que haya en memoria.
    facturas = (DB.sales || []).filter(s =>
      s.status !== 'cancelled' && s.type !== 'devolucion' && (
        String(s.id).includes(ql) ||
        matchText(s.customer_name, qNorm) ||
        matchText(s.items_summary, qNorm)
      )
    ).slice(0, 4);
  }

  // Si el usuario siguió escribiendo, descartar este resultado (llegó tarde).
  if (seq !== _gSearchSeq) return;

  const total = prods.length + facturas.length + clientes.length;

  if (!total) {
    resultsEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted2)">
      Sin resultados para "<strong>${_escHtml(q)}</strong>"</div>`;
    return;
  }

  const sections = [];

  if (prods.length) {
    sections.push(`<div style="padding:6px 16px 2px;font-size:10px;font-weight:700;
                               color:var(--muted);text-transform:uppercase;letter-spacing:.06em">
      Productos (${prods.length})</div>`);
    prods.forEach(p => {
      sections.push(`
        <div onclick="closeModal&&closeModal();_closeGSearch();routeTo('inventario');setTimeout(()=>openProductoModal(DB.products.find(x=>x.id===${p.id})),300)"
             style="padding:10px 16px;cursor:pointer;display:flex;justify-content:space-between;
                    align-items:center;transition:background .1s"
             onmouseenter="this.style.background='var(--surface2)'"
             onmouseleave="this.style.background=''">
          <div>
            <div style="font-weight:600;font-size:13px">${_escHtml(p.name)}</div>
            <div style="font-size:11px;color:var(--muted)">
              ${_escHtml(p.code)}${p.model?` · <span style="color:var(--blue);font-weight:600">${_escHtml(p.model)}</span>`:''}
              ${p.brand?` · ${_escHtml(p.brand)}`:''}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;margin-left:12px">
            <div style="font-weight:700">${typeof fmt==='function'?fmt(p.price):p.price}</div>
            <div style="font-size:11px;color:${p.stock===0?'var(--red)':'var(--muted2)'}">
              Stock: ${p.stock} ${p.unit||'und'}
            </div>
          </div>
        </div>`);
    });
  }

  if (facturas.length) {
    sections.push(`<div style="padding:6px 16px 2px;font-size:10px;font-weight:700;
                               color:var(--muted);text-transform:uppercase;letter-spacing:.06em;
                               border-top:1px solid var(--line);margin-top:4px">
      Facturas (${facturas.length})</div>`);
    facturas.forEach(s => {
      const fecha = (s.created_at||'').split('T')[0].split(' ')[0];
      // Modelos: si la venta trae items los usa; si no, intenta del summary.
      const models = [...new Set((s.items||[])
        .map(i => DB.products?.find(p=>p.id===i.product_id)?.model)
        .filter(Boolean))];
      sections.push(`
        <div onclick="_closeGSearch();_openVentaGlobal(${s.id})"
             style="padding:10px 16px;cursor:pointer;display:flex;justify-content:space-between;
                    align-items:center"
             onmouseenter="this.style.background='var(--surface2)'"
             onmouseleave="this.style.background=''">
          <div>
            <div style="font-weight:600;font-size:13px">
              #${String(s.id).padStart(5,'0')} · ${_escHtml(s.customer_name||'Consumidor Final')}
            </div>
            <div style="font-size:11px;color:var(--muted)">
              ${typeof fdate==='function'?fdate(fecha):fecha}
              ${models.map(m=>`<span style="color:var(--blue);font-weight:600;margin-left:4px">${_escHtml(m)}</span>`).join('')}
            </div>
          </div>
          <div style="font-weight:700;flex-shrink:0;margin-left:12px">
            ${typeof fmt==='function'?fmt(s.total):s.total}
          </div>
        </div>`);
    });
  }

  if (clientes.length) {
    sections.push(`<div style="padding:6px 16px 2px;font-size:10px;font-weight:700;
                               color:var(--muted);text-transform:uppercase;letter-spacing:.06em;
                               border-top:1px solid var(--line);margin-top:4px">
      Clientes (${clientes.length})</div>`);
    clientes.forEach(c => {
      sections.push(`
        <div onclick="_closeGSearch();routeTo('clientes');setTimeout(()=>openEstadoCuentaModal&&openEstadoCuentaModal(DB.customers.find(x=>x.id===${c.id})),300)"
             style="padding:10px 16px;cursor:pointer;display:flex;justify-content:space-between;
                    align-items:center"
             onmouseenter="this.style.background='var(--surface2)'"
             onmouseleave="this.style.background=''">
          <div>
            <div style="font-weight:600;font-size:13px">${_escHtml(c.name)}</div>
            <div style="font-size:11px;color:var(--muted)">${_escHtml(c.phone||'')} ${c.rnc?'· '+_escHtml(c.rnc):''}</div>
          </div>
          ${c.balance>0?`<div style="font-weight:700;color:var(--red);flex-shrink:0;margin-left:12px">
            ${typeof fmt==='function'?fmt(c.balance):c.balance}</div>`:''}
        </div>`);
    });
  }

  resultsEl.innerHTML = sections.join('');
}

// Abre el detalle de una venta desde el buscador global. Si la venta no está
// en memoria (es histórica o de otra fecha), la carga del backend por id.
async function _openVentaGlobal(id) {
  let sale = (DB.sales || []).find(x => x.id === id);
  if (!sale) {
    try {
      sale = await window.api.sales.getById({ id });
    } catch (e) {
      sale = null;
    }
  }
  if (!sale) {
    if (typeof toast === 'function') toast('No se pudo cargar la venta', 'err');
    return;
  }
  routeTo('ventas');
  setTimeout(() => {
    if (typeof openDetalleVentaModal === 'function') openDetalleVentaModal(sale);
  }, 300);
}
