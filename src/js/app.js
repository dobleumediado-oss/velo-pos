// ══════════════════════════════════════════════
// app.js — Render principal, Login, Sidebar,
//           Topbar y Router de páginas
// ══════════════════════════════════════════════

// ── Bootstrap ────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Cargar todos los datos vía IPC
  await loadAppData();

  // Restaurar sesión de sessionStorage
  const saved = sessionStorage.getItem('vp_user');
  if (saved) {
    try { user = JSON.parse(saved); } catch {}
  }
  if (user) renderApp();
  else      renderLogin();

  // ── Barra de progreso de actualización ─────────────────────────────
  // Se muestra en la esquina inferior derecha cuando hay una descarga activa
  if (window.api?.updater?.onProgress) {
    window.api.updater.onProgress(({ percent, bytesPerSecond }) => {
      let bar = document.getElementById('update-progress-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'update-progress-bar';
        bar.style.cssText = [
          'position:fixed', 'bottom:16px', 'right:16px', 'z-index:99999',
          'background:var(--surface)', 'border:1px solid var(--line)',
          'border-radius:10px', 'padding:10px 14px', 'min-width:220px',
          'box-shadow:0 4px 16px rgba(0,0,0,.15)', 'font-size:12px',
        ].join(';');
        document.body.appendChild(bar);
      }
      const mb = (bytesPerSecond / 1024 / 1024).toFixed(1);
      bar.innerHTML = `
        <div style="font-weight:700;margin-bottom:6px;color:var(--text)">
          Descargando actualización…
        </div>
        <div style="background:var(--line);border-radius:4px;height:6px;margin-bottom:5px">
          <div style="background:var(--green);height:6px;border-radius:4px;width:${percent}%;transition:.3s"></div>
        </div>
        <div style="color:var(--muted)">${percent}% · ${mb} MB/s</div>
      `;
      if (percent >= 100) setTimeout(() => bar?.remove(), 2000);
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
    const wrap = h('div', { class: 'login-wrap', style: { width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center' } },
      h('div', { class: 'login-card' },

        // Logo
        h('div', { class: 'login-logo', html: svg('wrench') }),
        h('div', { class: 'login-title' }, 'Velo POS'),
        h('div', { class: 'login-sub' }, 'Sistema para micro negocios de auto parts'),

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

        // Versión
        h('div', { style: { textAlign:'center', fontSize:'10px', color:'var(--muted2)', marginTop:'16px' } },
          'Velo POS v1.0.0'
        )
      )
    );
    root.appendChild(wrap);
    setTimeout(() => { document.getElementById('lpass')?.focus(); }, 50);
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

    // Verificar primer login / cambio de contraseña obligatorio
    const settings   = await window.api.settings.getAll();
    const sinConfig  = !settings.biz_name || settings.biz_name === 'Mi Negocio';
    const pwdChanged = settings.password_changed === '1';

    if (user.role === 'superadmin') {
      // Superadmin nunca se bloquea (es el instalador del sistema)
      return;
    }

    if (!pwdChanged) {
      // Contraseña por defecto — bloqueo total, debe cambiarla ahora
      if (sinConfig && user.role === 'admin') {
        // Primera vez en el sistema: wizard completo
        setTimeout(() => renderAsistentePrimerLogin(), 600);
      } else {
        // Ya configurado pero contraseña sin cambiar: solo paso de contraseña
        setTimeout(() => renderCambioContrasenaObligatorio(), 600);
      }
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
  const bizName = DB?.settings?.biz_name || CFG?.biz || 'Mi Negocio';
  const brand = h('div', { class: 'sb-brand' },
    h('div', { class: 'sb-logo', html: svg('wrench') }),
    h('div', null,
      h('div', { class: 'sb-name' }, bizName),
      h('div', { class: 'sb-tag' }, 'POS v1.0.0')
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
    const ni = h('div', {
      class: `nav-item ${page === it.key ? 'on' : ''}`,
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
    dash:         'Dashboard',
    pos:          'Punto de Venta',
    inventario:   'Inventario',
    compras:      'Compras',
    clientes:     'Clientes',
    ventas:       'Ventas',
    devoluciones: 'Devoluciones',
    caja:         'Caja',
    reportes:       'Reportes',
    configuracion:  'Configuración',
  };

  // Toggle sidebar
  const tog = h('button', {
    class: 'tb-toggle',
    onclick: () => { sbSm = !sbSm; buildSidebar(); buildTopbar(); },
    html: svg('menu')
  });

  const title = h('span', { class: 'tb-title' }, titles[page] || 'Velo POS');

  const right = h('div', { class: 'tb-right' });

  // Pill estado caja
  right.appendChild(
    h('div', {
      class: `pill ${cajaOpen ? 'open' : 'closed'}`,
      html: cajaOpen ? `${svg('check')} Caja Abierta` : `${svg('xmark')} Caja Cerrada`
    })
  );

  // Fecha/hora
  right.appendChild(
    h('div', { class: 'pill', html: `${svg('clock')} ${fdate(today())}` })
  );

  // Bell con alertas de crédito
  const alerts = getCreditAlerts();
  const bell = h('div', { class: 'ib', onclick: () => routeTo('clientes') },
    h('div', { html: svg('bell') })
  );
  if (alerts.length) {
    const dot = h('span', { class: 'dot' });
    bell.appendChild(dot);
  }
  right.appendChild(bell);

  tb.appendChild(tog);
  tb.appendChild(title);
  tb.appendChild(right);
}

// ══════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════
function routeTo(p) {
  page = p;

  // Cajero no puede acceder a rutas admin
  if (user?.role === 'cajero') {
    const allowed = ['pos', 'clientes', 'ventas', 'caja'];
    if (!allowed.includes(p)) { page = 'pos'; }
  }

  buildSidebar();
  buildTopbar();

  const el = document.getElementById('page');
  if (!el) return;
  el.className = 'page fi';

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
async function renderConfiguracion(el) {
  el.innerHTML = '';

  // Cargar settings, versión y licencia
  const settings    = await window.api.settings.getAll();
  const versionInfo = await window.api.version.getInfo().catch(() => ({ ok: false }));
  const info        = versionInfo.ok ? versionInfo.data : {};
  const licResult   = await window.api.license.getStatus().catch(() => ({ ok: false }));
  const lic         = licResult.ok ? licResult.data : null;

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Configuración'),
      h('div', { class: 'sec-sub' }, `Velo POS v${info.appVersion || '1.0.0'}`)
    ),
    h('button', {
      class: 'btn btn-green',
      onclick: guardarConfiguracion,
      html: `${svg('check')} Guardar cambios`
    })
  ));

  const grid = h('div', { class: 'gg2', style: { alignItems: 'start' } });

  // ── Datos del negocio ───────────────────────
  const bizCard = h('div', { class: 'card' });
  bizCard.innerHTML = `
    <div class="card-title mb8">Datos del Negocio</div>
    <div class="fg">
      <label class="lbl">Nombre comercial *</label>
      <input class="inp" id="cfg-biz-name" type="text"
             placeholder="Mi Auto Parts" value="${settings.biz_name || ''}"/>
    </div>
    <div class="fg">
      <label class="lbl">RNC</label>
      <input class="inp" id="cfg-biz-rnc" type="text"
             placeholder="130-00000-0" value="${settings.biz_rnc || ''}"/>
    </div>
    <div class="fg">
      <label class="lbl">Dirección</label>
      <input class="inp" id="cfg-biz-addr" type="text"
             placeholder="Calle Principal #1" value="${settings.biz_addr || ''}"/>
    </div>
    <div class="fg">
      <label class="lbl">Teléfono</label>
      <input class="inp" id="cfg-biz-phone" type="tel"
             placeholder="809-000-0000" value="${settings.biz_phone || ''}"/>
    </div>
    <div class="fg">
      <label class="lbl">Mensaje en recibos</label>
      <input class="inp" id="cfg-receipt-msg" type="text"
             placeholder="Gracias por su compra"
             value="${settings.receipt_msg || ''}"/>
    </div>
    <div class="fg">
      <label class="lbl">ITBIS (%)</label>
      <input class="inp" id="cfg-tax" type="number" min="0" max="100"
             placeholder="18" value="${settings.tax_pct || '18'}"/>
    </div>`;
  grid.appendChild(bizCard);

  // ── Sistema y backups ───────────────────────
  const sysCard = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });

  // Info del sistema
  const infoCard = h('div', { class: 'card' });
  infoCard.innerHTML = `
    <div class="card-title mb8">Sistema</div>
    <div class="tr" style="font-size:12px">
      <span>Versión</span>
      <span style="font-family:var(--mono);font-weight:600">v${info.appVersion || '1.0.0'}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Instalado</span>
      <span>${info.installedAt ? info.installedAt.split('T')[0] : '—'}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Último backup</span>
      <span style="color:${info.lastBackup && info.lastBackup === today() ? 'var(--green)' : 'var(--amber)'}">
        ${info.lastBackup || 'Nunca'}
      </span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Backups guardados</span>
      <span>${info.backupsCount || 0}</span>
    </div>`;
  sysCard.appendChild(infoCard);

  // ── Importar datos ──────────────────────────
  const importCard = h('div', { class: 'card' });
  importCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, '📂 Importar datos'),
    h('span', { style: { fontSize: '11px', color: 'var(--muted2)' } }, 'Excel, CSV, JSON, SQLite')
  ));
  importCard.appendChild(h('div', { class: 'alrt b', style: { marginBottom: '12px' } },
    h('div', { class: 'alrt-dot b' }),
    h('div', null,
      h('div', { class: 'alrt-title' }, 'Importación con IA'),
      h('div', { class: 'alrt-sub' },
        'La IA detecta automáticamente las columnas de tu archivo y las mapea a Velo POS.')
    )
  ));
  importCard.appendChild(
    h('button', {
      class: 'btn btn-dark btn-fw',
      onclick: abrirImportarDesdeConfig,
      html: '✨ Importar productos o clientes'
    })
  );
  rightCol.appendChild(importCard);

  // Backups
  const backupCard = h('div', { class: 'card' });
  backupCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Backups'),
    h('span', { style: { fontSize: '11px', color: 'var(--muted2)' } },
      `${info.backupsCount || 0} backups guardados`)
  ));
  backupCard.appendChild(
    h('div', { class: 'alrt b', style: { marginBottom: '12px' } },
      h('div', { class: 'alrt-dot b' }),
      h('div', null,
        h('div', { class: 'alrt-title' }, 'Backup automático activo'),
        h('div', { class: 'alrt-sub' },
          'Se crea un backup automático cada vez que inicia la app.')
      )
    )
  );
  backupCard.appendChild(
    h('div', { class: 'flex', style: { gap: '8px', marginBottom: '12px' } },
      h('button', {
        class: 'btn btn-out btn-fw',
        onclick: hacerBackupManual,
        html: `${svg('download')} Crear backup ahora`
      }),
      h('button', {
        class: 'btn btn-ghost btn-fw',
        style: { color: 'var(--amber)' },
        onclick: restaurarBackup,
        html: `${svg('return')} Restaurar último`
      })
    )
  );

  // Lista completa de backups con botón de restaurar individual
  if (info.backups?.length) {
    const bList = h('div', null);
    bList.appendChild(
      h('div', { style: { fontSize: '11px', fontWeight: 700,
        color: 'var(--muted)', marginBottom: '8px',
        textTransform: 'uppercase', letterSpacing: '.05em' } },
        'Backups disponibles')
    );
    info.backups.forEach((b, i) => {
      const nombre   = typeof b === 'string' ? b : b.name || b;
      const fechaStr = nombre.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
      const esHoy    = fechaStr === today();
      const row      = h('div', { class: 'fxb', style: {
        padding: '8px 0',
        borderBottom: '1px solid var(--line2)',
      }});
      row.appendChild(
        h('div', null,
          h('div', { style: { fontSize: '12px', fontFamily: 'var(--mono)',
            color: esHoy ? 'var(--green)' : 'var(--ink)' } },
            nombre),
          h('div', { style: { fontSize: '10px', color: 'var(--muted2)' } },
            esHoy ? 'Hoy' : fechaStr ? fdate(fechaStr) : '')
        ),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          style: { color: 'var(--amber)', fontSize: '11px' },
          html: `${svg('return')} Restaurar`,
          onclick: () => restaurarBackupEspecifico(nombre)
        })
      );
      bList.appendChild(row);
    });
    backupCard.appendChild(bList);
  } else {
    backupCard.appendChild(
      h('div', { style: { fontSize: '12px', color: 'var(--muted2)',
        padding: '8px 0' } }, 'Sin backups disponibles todavía')
    );
  }
  sysCard.appendChild(backupCard);

  // ── Licencia — solo superadmin ─────────────
  if (user?.role === 'superadmin') {
  const licCard = h('div', { class: 'card' });
  const licColor = !lic ? 'var(--muted)' :
    lic.blocked   ? 'var(--red)'   :
    lic.inGrace   ? 'var(--amber)' :
    lic.warningSoon ? 'var(--amber)' : 'var(--green)';
  const licLabel = !lic ? 'No disponible' :
    lic.blocked      ? 'Sin licencia — bloqueado' :
    lic.inGrace      ? `Período de gracia — ${lic.graceDaysLeft}d restantes` :
    lic.warningSoon  ? `Vence en ${lic.daysLeft} días` :
    lic.licensed     ? `Activa${lic.expiry === 'Perpetua' ? ' (Perpetua)' : ' — Vence: ' + lic.expiry}` :
    'Desconocido';

  licCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Licencia del Sistema</div>
      <span class="badge ${lic?.licensed ? 'g' : lic?.inGrace ? 'a' : 'r'}"
            style="font-size:11px">
        ${lic?.licensed ? 'Activa' : lic?.inGrace ? 'Gracia' : 'Sin licencia'}
      </span>
    </div>
    <div class="tr" style="font-size:12px;margin-bottom:6px">
      <span>Estado</span>
      <span style="font-weight:600;color:${licColor}">${licLabel}</span>
    </div>
    ${lic?.business ? `
      <div class="tr" style="font-size:12px;margin-bottom:6px">
        <span>Negocio</span>
        <span style="font-weight:600">${lic.business}</span>
      </div>` : ''}
    <div class="tr" style="font-size:11px;color:var(--muted);margin-bottom:12px">
      <span>ID de máquina</span>
      <span style="font-family:var(--mono);font-size:10px">${lic?.machineId || '—'}</span>
    </div>
    ${lic?.inGrace || lic?.blocked || !lic?.licensed ? `
      <div class="alrt a" style="margin-bottom:12px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Activar licencia</div>
          <div class="alrt-sub">
            Contacta al proveedor con el ID de máquina para obtener tu clave.
          </div>
        </div>
      </div>
      <div class="fg" style="margin-bottom:8px">
        <label class="lbl">Clave de licencia</label>
        <input class="inp" id="lic-key" type="text"
               placeholder="1|ABCD...|Negocio|2027-01-01|HASH"
               style="font-family:var(--mono);font-size:11px"/>
      </div>
      <button class="btn btn-green btn-fw" onclick="activarLicencia()">
        ${svg('check')} Activar licencia
      </button>` : `
      <button class="btn btn-out btn-sm" onclick="openModal('<div class=\\'modal-title\\'>ID de Máquina</div><div style=\\'font-family:monospace;font-size:13px;padding:14px;background:var(--surface2);border-radius:8px;word-break:break-all\\'>${lic?.machineId}</div><div class=\\'modal-foot\\'><button class=\\'btn btn-out\\' onclick=\\'closeModal()\\'>Cerrar</button></div>')">
        Ver ID de máquina
      </button>`}`;
  sysCard.appendChild(licCard);
  } // end superadmin license

  // ── Selector de Plantillas de Impresión ──────
  const plantCard = h('div', { class: 'card', style: { marginBottom: '16px' } });
  const printerSaved = settings?.printer || '';
  const printerType  = detectPrinterType(printerSaved);
  const plantillas   = getPlantillasByTipo(printerType === 'unknown' ? '80mm' : printerType);
  const plantActual  = settings?.print_template || plantillas[0]?.id || 'termica_80_clasica';

  plantCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Plantillas de Impresión</div>
      <span class="badge b" style="font-size:11px">${
        printerType === '58mm' ? 'Térmica 58mm' :
        printerType === '80mm' ? 'Térmica 80mm' :
        printerType === 'carta' ? 'Carta / A4' : 'Auto'
      }</span>
    </div>
    <div class="alrt b" style="margin-bottom:12px">
      <div class="alrt-dot b"></div>
      <div>
        <div class="alrt-title">Impresora: ${printerSaved || 'No configurada'}</div>
        <div class="alrt-sub">
          Tipo detectado: ${printerType === '58mm' ? 'Térmica 58mm' : printerType === '80mm' ? 'Térmica 80mm' : printerType === 'carta' ? 'Carta / A4' : 'No reconocida — usando 80mm por defecto'}
        </div>
      </div>
    </div>
    <div id="plantillas-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:12px">
      ${plantillas.map(p => `
        <div onclick="seleccionarPlantilla('${p.id}')"
             id="plant-card-${p.id}"
             style="border:2px solid ${plantActual === p.id ? 'var(--green)' : 'var(--line)'};
                    border-radius:10px;padding:10px;cursor:pointer;transition:.15s;
                    background:${plantActual === p.id ? 'var(--green-bg)' : 'var(--surface)'}">
          <div style="font-size:20px;margin-bottom:4px">${p.icono}</div>
          <div style="font-weight:700;font-size:12px;margin-bottom:2px">${p.nombre}</div>
          <div style="font-size:10px;color:var(--muted2);line-height:1.3">${p.desc}</div>
          ${plantActual === p.id ? '<div style="font-size:10px;color:var(--green);font-weight:700;margin-top:4px">✓ Activa</div>' : ''}
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-dark" onclick="previsualizarPlantilla()">
        ${svg('eye')} Vista previa
      </button>
      <button class="btn btn-out" onclick="imprimirPruebaPlantilla()">
        ${svg('print')} Imprimir prueba
      </button>
    </div>
    <div id="plant-preview" style="display:none;margin-top:12px">
      <div style="font-size:11px;font-weight:700;margin-bottom:6px;color:var(--muted)">
        VISTA PREVIA — ${plantillas.find(p=>p.id===plantActual)?.nombre||''}
      </div>
      <iframe id="plant-iframe" style="width:100%;height:400px;border:1px solid var(--line);
              border-radius:6px;background:#fff"></iframe>
    </div>`;
  el.appendChild(plantCard);

  // ── Impresora térmica (superadmin) ────────────
  if (user?.role === 'superadmin') {
  const printerCard = h('div', { class: 'card' });
  printerCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Impresora Térmica</div>
    </div>
    <div class="tr" style="font-size:12px;margin-bottom:10px">
      <span>Impresora guardada</span>
      <span style="font-weight:600;color:${settings.printer ? 'var(--green)' : 'var(--muted2)'}">
        ${settings.printer ? settings.printer.slice(0,26) : 'No configurada'}
      </span>
    </div>
    <div class="alrt b" style="margin-bottom:12px">
      <div class="alrt-dot b"></div>
      <div>
        <div class="alrt-title">Impresora Térmica — ${detectPrinterType(settings.printer||'') === '58mm' ? '58mm detectada' : '80mm (default)'}</div>
        <div class="alrt-sub">
          Conecta la impresora por USB y asegúrate de que esté instalada en Windows.
          Luego haz clic en "Configurar impresora" para seleccionarla de la lista.
          El sistema detecta automáticamente si es 58mm o 80mm por el nombre.
        </div>
      </div>
    </div>
    <div class="flex" style="gap:8px">
      <button class="btn btn-dark btn-fw" onclick="openPrinterConfig()">
        ${svg('settings')} Configurar impresora
      </button>
      <button class="btn btn-out btn-fw" onclick="testPrint()">
        ${svg('print')} Prueba de impresión
      </button>
    </div>`;
  sysCard.appendChild(printerCard);

  // ── Logo del negocio ─────────────────────────
  const logoCard = h('div', { class: 'card' });
  const logoActual = settings.biz_logo || '';
  logoCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Logo en Tickets</div>
      ${logoActual
        ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)"
                   onclick="eliminarLogo()">Eliminar logo</button>`
        : ''}
    </div>
    ${logoActual
      ? `<div style="text-align:center;margin-bottom:12px">
           <img src="${logoActual}"
                style="max-width:160px;max-height:60px;
                       filter:grayscale(100%) contrast(150%);
                       border:1px solid var(--line);border-radius:6px;padding:8px"/>
           <div style="font-size:11px;color:var(--muted);margin-top:4px">
             Así aparecerá en blanco y negro en el ticket
           </div>
         </div>`
      : `<div class="alrt b" style="margin-bottom:12px">
           <div class="alrt-dot b"></div>
           <div>
             <div class="alrt-title">Sin logo configurado</div>
             <div class="alrt-sub">
               Sube una imagen PNG o JPG. Se convierte a blanco y negro automáticamente.
               Tamaño recomendado: 300x100px máximo.
             </div>
           </div>
         </div>`}
    <div class="fg" style="margin-bottom:0">
      <label class="lbl">Subir logo (PNG, JPG)</label>
      <input type="file" id="logo-input" accept="image/png,image/jpeg,image/jpg"
             style="display:none" onchange="previewLogo(this)"/>
      <button class="btn btn-out btn-fw" onclick="document.getElementById('logo-input').click()">
        ${svg('download')} ${logoActual ? 'Cambiar logo' : 'Seleccionar imagen'}
      </button>
    </div>
    <div id="logo-preview" style="margin-top:10px;display:none;text-align:center">
      <img id="logo-preview-img" style="max-width:160px;max-height:60px;
           filter:grayscale(100%) contrast(150%);border:1px solid var(--line);
           border-radius:6px;padding:8px"/>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Vista previa</div>
      <button class="btn btn-green btn-sm" style="margin-top:8px" onclick="guardarLogo()">
        ${svg('check')} Guardar logo
      </button>
    </div>`;
  sysCard.appendChild(logoCard);
  } // end superadmin printer/logo

  // Usuarios
  const usersCard = h('div', { class: 'card' });
  usersCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Usuarios del sistema'),
    h('button', {
      class: 'btn btn-dark btn-sm',
      onclick: openNuevoCajeroModal,
      html: `${svg('plus')} Nuevo cajero`
    })
  ));

  const users = (window._cachedUsers || []).filter(u => u.role !== 'superadmin');
  if (!users.length) {
    usersCard.appendChild(
      h('div', { style: { color: 'var(--muted2)', fontSize: '12px' } }, 'Sin usuarios')
    );
  } else {
    users.forEach(u => {
      const row = h('div', { class: 'fxb', style: {
        padding: '10px 0', borderBottom: '1px solid var(--line2)'
      }});
      row.appendChild(
        h('div', { class: 'flex', style: { gap: '8px' } },
          h('div', { class: 'sb-av', style: {
            width: '32px', height: '32px', fontSize: '11px',
            opacity: u.active ? '1' : '0.4'
          }}, u.avatar || u.name?.[0] || 'U'),
          h('div', null,
            h('div', { style: { fontSize: '13px', fontWeight: 600,
              color: u.active ? 'var(--ink)' : 'var(--muted)' }}, u.name),
            h('div', { class: 'ts' }, u.email)
          )
        )
      );
      const actions = h('div', { class: 'flex', style: { gap: '5px' }});
      actions.appendChild(h('span', { class: `badge ${u.role === 'admin' ? 'b' : 'g'}` }, u.role));
      actions.appendChild(h('span', { class: `badge ${u.active ? 'g' : 'r'}` }, u.active ? 'Activo' : 'Inactivo'));
      if (!(u.role === 'admin' && u.id === user?.id)) {
        actions.appendChild(h('button', {
          class: 'btn btn-ghost btn-sm', title: 'Editar',
          html: svg('edit'), onclick: () => openEditarUsuarioModal(u)
        }));
        if (u.role !== 'admin') {
          actions.appendChild(h('button', {
            class: 'btn btn-ghost btn-sm',
            title: u.active ? 'Desactivar' : 'Activar',
            style: { color: u.active ? 'var(--red)' : 'var(--green)' },
            html: u.active ? svg('lock') : svg('check'),
            onclick: () => toggleUsuario(u)
          }));
        }
      }
      row.appendChild(actions);
      usersCard.appendChild(row);
    });
  }
  sysCard.appendChild(usersCard);

  grid.appendChild(sysCard);
  el.appendChild(grid);
}

async function guardarConfiguracion() {
  const fields = [
    ['biz_name',    'cfg-biz-name'],
    ['biz_rnc',     'cfg-biz-rnc'],
    ['biz_addr',    'cfg-biz-addr'],
    ['biz_phone',   'cfg-biz-phone'],
    ['receipt_msg', 'cfg-receipt-msg'],
    ['tax_pct',     'cfg-tax'],
  ];

  for (const [key, id] of fields) {
    const val = document.getElementById(id)?.value?.trim() || '';
    await window.api.settings.set({ key, value: val });
  }

  // Recargar CFG en memoria
  const settings = await window.api.settings.getAll();
  CFG.biz   = settings.biz_name  || CFG.biz;
  CFG.rnc   = settings.biz_rnc   || CFG.rnc;
  CFG.addr  = settings.biz_addr  || CFG.addr;
  CFG.phone = settings.biz_phone || CFG.phone;
  CFG.itbis = parseFloat(settings.tax_pct) || 18;

  toast('✓ Configuración guardada');
}

// ── Editar usuario ────────────────────────────
function openEditarUsuarioModal(u) {
  openModal(`
    <div class="modal-title">Editar Usuario</div>
    <div class="modal-sub">${u.name} · ${u.role}</div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Nombre completo *</label>
        <input class="inp" id="eu-name" type="text" value="${u.name || ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">Email *</label>
        <input class="inp" id="eu-email" type="email" value="${u.email || ''}"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Nueva contraseña</label>
        <input class="inp" id="eu-pass" type="password"
               placeholder="Dejar vacío para no cambiar"/>
      </div>
      <div class="fg">
        <label class="lbl">Iniciales (avatar)</label>
        <input class="inp" id="eu-avatar" type="text"
               value="${u.avatar || ''}" maxlength="2"/>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="guardarEdicionUsuario(${u.id})">
        ${svg('check')} Guardar cambios
      </button>
    </div>
  `);
}

async function guardarEdicionUsuario(id) {
  const name   = document.getElementById('eu-name')?.value?.trim();
  const email  = document.getElementById('eu-email')?.value?.trim();
  const pass   = document.getElementById('eu-pass')?.value;
  const avatar = document.getElementById('eu-avatar')?.value?.trim().toUpperCase() || '';

  if (!name)  { toast('El nombre es requerido', 'err'); return; }
  if (!email) { toast('El email es requerido', 'err');  return; }
  if (pass && pass.length < 6) {
    toast('La contraseña debe tener mínimo 6 caracteres', 'err'); return;
  }

  const existing = (window._cachedUsers || []).find(u => u.id === id);
  const data = {
    name, email,
    role:   existing?.role   || 'cajero',
    avatar: avatar || name[0].toUpperCase(),
    active: existing?.active ?? 1,
  };

  const result = await window.api.users.update({
    id, data, requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al actualizar', 'err'); return; }

  // Cambiar contraseña si se ingresó una nueva
  if (pass) {
    const passResult = await window.api.users.changePassword({
      id, password: pass, requestUserId: user.id,
    });
    if (!passResult?.ok) {
      toast('Usuario actualizado pero error al cambiar contraseña', 'w');
    }
  }

  window._cachedUsers = await window.api.users.getAll() || [];
  closeModal();
  toast(`✓ Usuario ${name} actualizado`);
  renderConfiguracion(document.getElementById('page'));
}

async function toggleUsuario(u) {
  const accion = u.active ? 'desactivar' : 'activar';
  confirmModal(
    `¿Deseas ${accion} al usuario <strong>${u.name}</strong>?`,
    async () => {
      const data = { ...u, active: u.active ? 0 : 1 };
      const result = await window.api.users.update({
        id: u.id, data, requestUserId: user.id,
      });
      if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
      window._cachedUsers = await window.api.users.getAll() || [];
      toast(`✓ Usuario ${u.active ? 'desactivado' : 'activado'}`);
      renderConfiguracion(document.getElementById('page'));
    },
    u.active ? 'Desactivar' : 'Activar',
    u.active ? 'btn-red' : 'btn-green'
  );
}

async function hacerBackupManual() {
  const result = await window.api.backup.create({ requestUserId: user.id });
  if (result.ok) {
    toast(`✓ Backup guardado en: ${result.path}`);
    renderConfiguracion(document.getElementById('page'));
  } else {
    toast(result.error || 'Error al crear backup', result.error ? 'err' : 'w');
  }
}

async function restaurarBackup() {
  confirmModal(
    'Al restaurar el último backup, los datos actuales serán reemplazados. ¿Continuar?',
    async () => {
      const result = await window.api.backup.restore({ requestUserId: user.id });
      if (result.ok) {
        toast('✓ Backup restaurado. Reiniciando...');
        setTimeout(() => location.reload(), 1500);
      } else {
        toast(result.error || 'Error al restaurar', 'err');
      }
    },
    'Restaurar', 'btn-red'
  );
}

async function restaurarBackupEspecifico(nombre) {
  confirmModal(
    `¿Restaurar el backup <strong>${nombre}</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       Los datos actuales serán reemplazados por este backup.
       Esta acción no se puede deshacer.
     </span>`,
    async () => {
      const result = await window.api.backup.restore({
        fileName: nombre, requestUserId: user.id
      });
      if (result.ok) {
        toast('✓ Backup restaurado correctamente. Reiniciando...');
        setTimeout(() => location.reload(), 1500);
      } else {
        toast(result.error || 'Error al restaurar', 'err');
      }
    },
    'Restaurar este backup', 'btn-red'
  );
}

// ── Modal nuevo cajero/vendedor ───────────────
function openNuevoCajeroModal() {
  const isSuperAdmin = user?.role === 'superadmin';
  openModal(`
    <div class="modal-title">Nuevo Usuario</div>
    <div class="modal-sub">Crear cuenta de acceso</div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Nombre completo *</label>
        <input class="inp" id="uc-name" type="text" placeholder="Juan Pérez"/>
      </div>
      <div class="fg">
        <label class="lbl">Email *</label>
        <input class="inp" id="uc-email" type="email" placeholder="cajero@negocio.do"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Contraseña *</label>
        <input class="inp" id="uc-pass" type="password" placeholder="Mínimo 6 caracteres"/>
      </div>
      <div class="fg">
        <label class="lbl">Iniciales (avatar)</label>
        <input class="inp" id="uc-avatar" type="text" placeholder="JP" maxlength="2"/>
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Rol</label>
      <select class="inp" id="uc-role">
        <option value="cajero">Cajero / Vendedor</option>
        ${isSuperAdmin ? '<option value="admin">Administrador</option>' : ''}
      </select>
      ${!isSuperAdmin ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">Solo el desarrollador puede crear administradores.</div>' : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="crearCajero()">
        ${svg('check')} Crear usuario
      </button>
    </div>
  `);
}

async function crearCajero() {
  const name      = document.getElementById('uc-name')?.value?.trim();
  const email     = document.getElementById('uc-email')?.value?.trim();
  const pass      = document.getElementById('uc-pass')?.value;
  const avatar    = document.getElementById('uc-avatar')?.value?.trim().toUpperCase() || '';
  const roleFinal = user?.role === 'superadmin'
    ? (document.getElementById('uc-role')?.value || 'cajero')
    : 'cajero';

  if (!name)  { toast('El nombre es requerido', 'err'); return; }
  if (!email) { toast('El email es requerido', 'err');  return; }
  if (!pass || pass.length < 6) {
    toast('La contraseña debe tener mínimo 6 caracteres', 'err'); return;
  }

  const result = await window.api.users.create({
    data: { name, email, password: pass, role: roleFinal, avatar },
    requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al crear', 'err'); return; }

  window._cachedUsers = await window.api.users.getAll() || [];
  closeModal();
  toast(`✓ ${roleFinal === 'admin' ? 'Administrador' : 'Cajero'} ${name} creado`);
  renderConfiguracion(document.getElementById('page'));
}
// ══════════════════════════════════════════════
// AUDITORÍA — Log de acciones del sistema
// ══════════════════════════════════════════════
let auditFilter = '';

async function renderAuditoria(el) {
  el.innerHTML = '';

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Auditoría del Sistema'),
      h('div', { class: 'sec-sub' }, 'Registro de todas las acciones realizadas')
    )
  ));

  // Filtros
  const filterRow = h('div', { class: 'flex', style: { gap: '8px', marginBottom: '14px' } });
  filterRow.innerHTML = `
    <div class="inp-ic" style="flex:1;max-width:360px">
      <div class="ic">${svg('search')}</div>
      <input class="inp" id="audit-search" type="text"
             placeholder="Buscar por acción, usuario, detalle..."
             value="${auditFilter}"
             oninput="auditFilter=this.value;renderAuditTable(auditAllLogs)"/>
    </div>
    <select class="inp" style="width:180px" id="audit-entity"
            onchange="renderAuditTable(auditAllLogs)">
      <option value="">Todas las áreas</option>
      <option value="users">Usuarios</option>
      <option value="products">Productos</option>
      <option value="sales">Ventas</option>
      <option value="customers">Clientes</option>
      <option value="cash_sessions">Caja</option>
      <option value="settings">Configuración</option>
    </select>`;
  el.appendChild(filterRow);

  // Tabla
  const tableWrap = h('div', { id: 'audit-table-wrap' });
  el.appendChild(tableWrap);

  // Cargar logs
  tableWrap.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted2)">Cargando...</div>`;
  const logs = await window.api.audit.getLogs({ limit: 300 });
  window.auditAllLogs = logs || [];
  renderAuditTable(window.auditAllLogs);
}

function renderAuditTable(logs) {
  const wrap = document.getElementById('audit-table-wrap');
  if (!wrap) return;

  const q      = (auditFilter || '').toLowerCase().trim();
  const entity = document.getElementById('audit-entity')?.value || '';

  const filtered = logs.filter(l => {
    const mEntity = !entity || l.entity === entity;
    const mQ = !q ||
      (l.action     || '').toLowerCase().includes(q) ||
      (l.user_name  || '').toLowerCase().includes(q) ||
      (l.detail     || '').toLowerCase().includes(q) ||
      (l.entity     || '').toLowerCase().includes(q);
    return mEntity && mQ;
  });

  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty">
      <div style="color:var(--muted2)">${svg('alert')}</div>
      <p>Sin registros</p>
      <span>Prueba otro filtro</span>
    </div>`;
    return;
  }

  const actionColor = {
    login:              'var(--blue)',
    logout:             'var(--muted)',
    venta_creada:       'var(--green)',
    venta_anulada:      'var(--red)',
    devolucion_procesada:'var(--amber)',
    apertura_caja:      'var(--green)',
    cierre_caja:        'var(--blue)',
    ajuste_inventario:  'var(--amber)',
    abono_registrado:   'var(--green)',
    producto_creado:    'var(--green)',
    producto_editado:   'var(--blue)',
    producto_inactivado:'var(--red)',
    usuario_creado:     'var(--green)',
    cambio_contrasena:  'var(--amber)',
    backup_creado:      'var(--green)',
    impresora_configurada:'var(--blue)',
  };

  const rows = filtered.map(l => {
    const color = actionColor[l.action] || 'var(--muted)';
    const fecha = (l.created_at || '').replace('T', ' ').slice(0, 16);
    return `
      <tr>
        <td style="font-size:11px;color:var(--muted);white-space:nowrap">${fecha}</td>
        <td style="font-weight:600;font-size:12px">${l.user_name || '—'}</td>
        <td>
          <span style="font-size:11px;font-weight:700;color:${color};
                background:${color}22;padding:2px 7px;border-radius:20px;white-space:nowrap">
            ${l.action || ''}
          </span>
        </td>
        <td style="font-size:11px;color:var(--muted)">${l.entity || '—'}</td>
        <td style="font-size:11px;color:var(--muted2);max-width:260px;
                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${(l.detail||'').replace(/"/g,"'")}">
          ${l.detail || '—'}
        </td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="card" style="padding:0">
      <div style="padding:10px 14px;font-size:11px;color:var(--muted);
                  border-bottom:1px solid var(--line)">
        ${filtered.length} registro${filtered.length !== 1 ? 's' : ''}
        ${q || entity ? ' (filtrados)' : ''}
      </div>
      <div class="tw" style="max-height:calc(100vh - 280px);overflow-y:auto">
        <table>
          <thead>
            <tr>
              <th>Fecha / Hora</th>
              <th>Usuario</th>
              <th>Acción</th>
              <th>Área</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════
// LICENCIA
// ══════════════════════════════════════════════
async function activarLicencia() {
  const key = document.getElementById('lic-key')?.value?.trim();
  if (!key) { toast('Ingresa la clave de licencia', 'err'); return; }

  const result = await window.api.license.activate({
    licenseKey:    key,
    requestUserId: user?.id,
  });

  if (!result.ok) {
    toast(result.error || 'Licencia inválida', 'err'); return;
  }

  toast(`✓ Licencia activada — ${result.business || ''} · Vence: ${result.expiry}`);
  renderConfiguracion(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// CAMBIO DE CONTRASEÑA (primer login y voluntario)
// ══════════════════════════════════════════════
function openCambioPasswordModal(obligatorio = false) {
  openModal(`
    <div class="modal-title">${obligatorio ? 'Cambiar contraseña' : 'Cambiar contraseña'}</div>
    <div class="modal-sub">
      ${obligatorio
        ? 'Estás usando la contraseña predeterminada. Cámbiala antes de continuar.'
        : 'Actualiza tu contraseña de acceso'}
    </div>

    ${obligatorio ? `
      <div class="alrt a" style="margin-bottom:14px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Contraseña por defecto detectada</div>
          <div class="alrt-sub">Por seguridad debes cambiarla antes de usar el sistema.</div>
        </div>
      </div>` : ''}

    <div class="fg">
      <label class="lbl">Nueva contraseña *</label>
      <input class="inp" id="cp-new" type="password"
             placeholder="Mínimo 6 caracteres"
             oninput="cpCheckStrength()"/>
      <div id="cp-strength" style="font-size:11px;margin-top:4px"></div>
    </div>
    <div class="fg">
      <label class="lbl">Confirmar contraseña *</label>
      <input class="inp" id="cp-confirm" type="password"
             placeholder="Repite la contraseña"/>
    </div>

    <div class="modal-foot">
      ${obligatorio ? '' : '<button class="btn btn-out" onclick="closeModal()">Cancelar</button>'}
      <button class="btn btn-green" onclick="confirmarCambioPassword(${obligatorio})">
        ${svg('check')} Cambiar contraseña
      </button>
    </div>
  `);
}

function cpCheckStrength() {
  const pass = document.getElementById('cp-new')?.value || '';
  const el   = document.getElementById('cp-strength');
  if (!el) return;
  if (pass.length === 0)      { el.textContent = ''; return; }
  if (pass.length < 6)        { el.textContent = 'Muy corta'; el.style.color = 'var(--red)'; return; }
  if (pass.length < 8)        { el.textContent = 'Débil — considera añadir números'; el.style.color = 'var(--amber)'; return; }
  if (!/\d/.test(pass))       { el.textContent = 'Aceptable — añade un número'; el.style.color = 'var(--amber)'; return; }
  el.textContent = '✓ Contraseña segura'; el.style.color = 'var(--green)';
}

async function confirmarCambioPassword(obligatorio) {
  const newPass  = document.getElementById('cp-new')?.value;
  const confirm  = document.getElementById('cp-confirm')?.value;

  if (!newPass || newPass.length < 6) {
    toast('La contraseña debe tener mínimo 6 caracteres', 'err'); return;
  }
  if (newPass !== confirm) {
    toast('Las contraseñas no coinciden', 'err'); return;
  }

  const result = await window.api.users.changePassword({
    id:            user.id,
    password:      newPass,
    requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al cambiar contraseña', 'err'); return; }

  toast('✓ Contraseña actualizada correctamente');
  closeModal();

  // Si era obligatorio, marcar como completado en settings
  if (obligatorio) {
    await window.api.settings.set({ key: 'password_changed', value: '1' });
  }
}

// ══════════════════════════════════════════════
// ASISTENTE DE PRIMER LOGIN
// ══════════════════════════════════════════════
let wizardStep = 1;
const WIZARD_TOTAL = 3;

// ══════════════════════════════════════════════
// CAMBIO DE CONTRASEÑA OBLIGATORIO
// Se muestra cuando ya hay config pero la contraseña
// nunca fue cambiada de la que viene por defecto
// ══════════════════════════════════════════════
function renderCambioContrasenaObligatorio() {
  openModal(`
    <div style="text-align:center;margin-bottom:18px">
      <div style="font-size:32px;margin-bottom:8px">🔐</div>
      <div class="modal-title">Cambio de contraseña requerido</div>
      <div class="modal-sub">Por seguridad debes cambiar la contraseña antes de continuar</div>
    </div>

    <div class="alrt r" style="margin-bottom:14px">
      <div class="alrt-dot r"></div>
      <div>
        <div class="alrt-title">Acceso bloqueado</div>
        <div class="alrt-sub">Estás usando una contraseña predeterminada conocida. Cámbiala ahora para proteger el sistema.</div>
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Nueva contraseña *</label>
      <input class="inp" id="oblig-pass1" type="password"
             placeholder="Mínimo 6 caracteres"
             oninput="cpCheckStrengthOblig()"/>
      <div id="oblig-strength" style="font-size:11px;margin-top:4px"></div>
    </div>
    <div class="fg">
      <label class="lbl">Confirmar contraseña *</label>
      <input class="inp" id="oblig-pass2" type="password"
             placeholder="Repite la contraseña"/>
    </div>

    <div class="modal-foot">
      <button class="btn btn-dark btn-fw" onclick="guardarContrasenaObligatoria()">
        ${svg('lock')} Guardar y continuar
      </button>
    </div>
  `, 'modal-lg');

  // No dejar cerrar este modal con Esc ni click afuera
  setTimeout(() => {
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) overlay.onclick = e => e.stopPropagation();
  }, 50);
}

function cpCheckStrengthOblig() {
  const val = document.getElementById('oblig-pass1')?.value || '';
  const el  = document.getElementById('oblig-strength');
  if (!el) return;
  if (val.length === 0)      { el.textContent = ''; return; }
  if (val.length < 6)        { el.style.color = 'var(--red)'; el.textContent = 'Muy corta'; return; }
  if (val.length < 8)        { el.style.color = 'var(--amber)'; el.textContent = 'Aceptable'; return; }
  const strong = /[A-Z]/.test(val) && /[0-9]/.test(val);
  el.style.color = strong ? 'var(--green)' : 'var(--blue)';
  el.textContent = strong ? '✓ Contraseña fuerte' : 'Buena — agrega mayúsculas y números para más seguridad';
}

async function guardarContrasenaObligatoria() {
  const p1 = document.getElementById('oblig-pass1')?.value;
  const p2 = document.getElementById('oblig-pass2')?.value;

  if (!p1 || p1.length < 6) {
    toast('La contraseña debe tener mínimo 6 caracteres', 'err'); return;
  }
  if (p1 !== p2) {
    toast('Las contraseñas no coinciden', 'err'); return;
  }

  const result = await window.api.users.changePassword({
    id: user.id, password: p1, requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error al cambiar contraseña', 'err'); return; }

  await window.api.settings.set({ key: 'password_changed', value: '1' });
  closeModal();
  toast('✓ Contraseña actualizada — acceso desbloqueado', 'ok');
}

function renderAsistentePrimerLogin() {
  wizardStep = 1;
  renderWizardStep();
}

function renderWizardStep() {
  const steps = {
    1: wizardStepNegocio,
    2: wizardStepContrasena,
    3: wizardStepImportar,
    4: wizardStepListo,
  };
  steps[wizardStep]?.();
}

function wizardStepNegocio() {
  openModal(`
    <div style="text-align:center;margin-bottom:18px">
      <div style="font-size:32px;margin-bottom:8px">👋</div>
      <div class="modal-title">¡Bienvenido a Velo POS!</div>
      <div class="modal-sub">Vamos a configurar el sistema en 3 pasos rápidos</div>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:20px;justify-content:center">
      ${[1,2,3].map(i => `
        <div style="width:${i===1?'32px':'10px'};height:6px;border-radius:3px;
             background:${i===1?'var(--green)':'var(--line)'}"></div>
      `).join('')}
    </div>

    <div style="font-weight:700;font-size:13px;margin-bottom:14px">
      Paso 1 de 3 — Datos del negocio
    </div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Nombre del negocio *</label>
        <input class="inp" id="wiz-biz" type="text"
               placeholder="Auto Parts García" autofocus/>
      </div>
      <div class="fg">
        <label class="lbl">RNC (opcional)</label>
        <input class="inp" id="wiz-rnc" type="text" placeholder="101-00000-0"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Teléfono</label>
        <input class="inp" id="wiz-phone" type="tel" placeholder="809-555-0000"/>
      </div>
      <div class="fg">
        <label class="lbl">Dirección</label>
        <input class="inp" id="wiz-addr" type="text" placeholder="Calle Principal #1"/>
      </div>
    </div>

    <div class="modal-foot">
      <div style="font-size:11px;color:var(--muted)">Puedes cambiar esto después en Configuración</div>
      <button class="btn btn-dark" onclick="wizardGuardarNegocio()">
        Continuar ${svg('arrow')}
      </button>
    </div>
  `, 'modal-lg');
}

async function wizardGuardarNegocio() {
  const biz   = document.getElementById('wiz-biz')?.value?.trim();
  const rnc   = document.getElementById('wiz-rnc')?.value?.trim()   || '';
  const phone = document.getElementById('wiz-phone')?.value?.trim() || '';
  const addr  = document.getElementById('wiz-addr')?.value?.trim()  || '';

  if (!biz) { toast('El nombre del negocio es requerido', 'err'); return; }

  await window.api.settings.set({ key: 'biz_name',  value: biz });
  await window.api.settings.set({ key: 'biz_rnc',   value: rnc });
  await window.api.settings.set({ key: 'biz_phone', value: phone });
  await window.api.settings.set({ key: 'biz_addr',  value: addr });

  // Actualizar CFG y DB en memoria
  CFG.biz   = biz;
  CFG.rnc   = rnc;
  CFG.phone = phone;
  CFG.addr  = addr;
  if (DB?.settings) {
    DB.settings.biz_name  = biz;
    DB.settings.biz_rnc   = rnc;
    DB.settings.biz_phone = phone;
    DB.settings.biz_addr  = addr;
  }

  // Actualizar sidebar inmediatamente
  const sbName = document.querySelector('.sb-name');
  if (sbName) sbName.textContent = biz;

  wizardStep = 2;
  renderWizardStep();
}

function wizardStepContrasena() {
  openModal(`
    <div style="text-align:center;margin-bottom:18px">
      <div style="font-size:32px;margin-bottom:8px">🔐</div>
      <div class="modal-title">Cambiar contraseña</div>
      <div class="modal-sub">Reemplaza la contraseña predeterminada por una segura</div>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:20px;justify-content:center">
      ${[1,2,3].map(i => `
        <div style="width:${i===2?'32px':'10px'};height:6px;border-radius:3px;
             background:${i<=2?'var(--green)':'var(--line)'}"></div>
      `).join('')}
    </div>

    <div style="font-weight:700;font-size:13px;margin-bottom:14px">
      Paso 2 de 3 — Contraseña de administrador
    </div>

    <div class="alrt a" style="margin-bottom:14px">
      <div class="alrt-dot a"></div>
      <div>
        <div class="alrt-title">Contraseña actual: admin123</div>
        <div class="alrt-sub">Por seguridad cámbiala ahora.</div>
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Nueva contraseña *</label>
      <input class="inp" id="wiz-pass1" type="password"
             placeholder="Mínimo 6 caracteres"
             oninput="cpCheckStrength()"/>
      <div id="cp-strength" style="font-size:11px;margin-top:4px"></div>
    </div>
    <div class="fg">
      <label class="lbl">Confirmar contraseña *</label>
      <input class="inp" id="wiz-pass2" type="password"
             placeholder="Repite la contraseña"/>
    </div>

    <div class="modal-foot">
      <button class="btn btn-dark" onclick="wizardGuardarPassword()">
        Continuar ${svg('arrow')}
      </button>
    </div>
  `, 'modal-lg');
}

async function wizardGuardarPassword() {
  const p1 = document.getElementById('wiz-pass1')?.value;
  const p2 = document.getElementById('wiz-pass2')?.value;

  if (!p1 || p1.length < 6) {
    toast('La contraseña debe tener mínimo 6 caracteres', 'err'); return;
  }
  if (p1 !== p2) {
    toast('Las contraseñas no coinciden', 'err'); return;
  }

  const result = await window.api.users.changePassword({
    id: user.id, password: p1, requestUserId: user.id,
  });

  if (!result.ok) { toast(result.error || 'Error', 'err'); return; }

  await window.api.settings.set({ key: 'password_changed', value: '1' });
  wizardStep = 3;
  renderWizardStep();
}

async function wizardSkipPassword() {
  // Ya no se puede omitir — el cambio de contraseña es obligatorio
  toast('Debes cambiar la contraseña para continuar', 'err');
}

function wizardStepListo() {
  openModal(`
    <div style="text-align:center;padding:20px 0">
      <div style="font-size:48px;margin-bottom:12px">🎉</div>
      <div class="modal-title">¡Todo listo!</div>
      <div class="modal-sub" style="margin-bottom:24px">
        El sistema está configurado y listo para usar
      </div>

      <div style="display:flex;gap:6px;margin-bottom:24px;justify-content:center">
        ${[1,2,3,4].map(i => `
          <div style="width:28px;height:5px;border-radius:3px;background:var(--green)"></div>
        `).join('')}
      </div>

      <div class="card" style="text-align:left;margin-bottom:16px">
        <div style="font-weight:700;font-size:12px;margin-bottom:10px">Próximos pasos:</div>
        <div class="tr" style="font-size:12px;margin-bottom:8px">
          <span>📂 Importar datos de otro sistema</span>
          <button class="btn btn-ghost btn-sm"
                  onclick="abrirImportarDesdeConfig()">Importar</button>
        </div>
        <div class="tr" style="font-size:12px;margin-bottom:8px">
          <span>${svg('box')} Agregar productos al inventario</span>
          <button class="btn btn-ghost btn-sm"
                  onclick="closeModal();routeTo('inventario')">Ir</button>
        </div>
        <div class="tr" style="font-size:12px;margin-bottom:8px">
          <span>${svg('users')} Crear cajeros</span>
          <button class="btn btn-ghost btn-sm"
                  onclick="closeModal();routeTo('configuracion')">Ir</button>
        </div>
        <div class="tr" style="font-size:12px;margin-bottom:8px">
          <span>${svg('print')} Configurar impresora</span>
          <button class="btn btn-ghost btn-sm"
                  onclick="closeModal();routeTo('configuracion')">Ir</button>
        </div>
        <div class="tr" style="font-size:12px">
          <span>${svg('cash')} Abrir caja y vender</span>
          <button class="btn btn-ghost btn-sm"
                  onclick="closeModal();routeTo('caja')">Ir</button>
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-dark btn-fw" onclick="closeModal()">
        ${svg('check')} Empezar a usar el sistema
      </button>
    </div>
  `, 'modal-lg');
}

// ══════════════════════════════════════════════
// LOGO DEL NEGOCIO
// ══════════════════════════════════════════════
function previewLogo(input) {
  if (!input.files || !input.files[0]) return;
  const file   = input.files[0];
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview    = document.getElementById('logo-preview');
    const previewImg = document.getElementById('logo-preview-img');
    if (preview && previewImg) {
      previewImg.src    = e.target.result;
      preview.style.display = 'block';
      // Guardar temporalmente
      window._logoB64Temp = e.target.result;
    }
  };
  reader.readAsDataURL(file);
}

async function guardarLogo() {
  const b64 = window._logoB64Temp;
  if (!b64) { toast('Selecciona una imagen primero', 'err'); return; }

  // Verificar tamaño — máximo 500KB en base64
  if (b64.length > 700000) {
    toast('La imagen es muy grande. Usa una imagen menor a 500KB', 'err'); return;
  }

  await window.api.settings.set({ key: 'biz_logo', value: b64 });
  if (typeof CFG !== 'undefined') CFG.biz_logo = b64;
  if (DB?.settings) DB.settings.biz_logo = b64;

  window._logoB64Temp = null;
  toast('✓ Logo guardado — aparecerá en todos los tickets');
  renderConfiguracion(document.getElementById('page'));
}

async function eliminarLogo() {
  confirmModal(
    '¿Eliminar el logo del negocio? Los tickets quedarán sin logo.',
    async () => {
      await window.api.settings.set({ key: 'biz_logo', value: '' });
      if (typeof CFG !== 'undefined') CFG.biz_logo = '';
      if (DB?.settings) DB.settings.biz_logo = '';
      toast('Logo eliminado');
      renderConfiguracion(document.getElementById('page'));
    },
    'Eliminar', 'btn-red'
  );
}

// ══════════════════════════════════════════════
// PANEL SUPER ADMIN (solo desarrollador)
// ══════════════════════════════════════════════
async function renderSuperAdmin(el) {
  if (user?.role !== 'superadmin') {
    routeTo('dash'); return;
  }

  el.innerHTML = '';

  // Cargar datos primero
  const licResult  = await window.api.license.getStatus().catch(() => ({ ok: false }));
  const lic        = licResult.ok ? licResult.data : null;
  const vInfo      = await window.api.version.getInfo().catch(() => ({ ok: false }));
  const info       = vInfo.ok ? vInfo.data : {};
  const machineId  = lic?.machineId || '';

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, '⚡ Panel de Desarrollador'),
      h('div', { class: 'sec-sub' }, 'Acceso exclusivo — no visible para clientes')
    )
  ));

  // ── Generador de licencias ───────────────────
  const licCard = h('div', { class: 'card', style: { marginBottom: '16px' } });

  licCard.innerHTML = `
    <div class="card-title mb8">Generador de Licencias</div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">ID de máquina del cliente</label>
        <input class="inp" id="lic-machine" type="text"
               placeholder="Pega aquí el ID de máquina del cliente"
               style="font-family:var(--mono);font-size:11px"/>
        <div style="font-size:10px;color:var(--muted);margin-top:4px">
          ID de esta instalación: <span style="font-family:var(--mono);color:var(--blue)"
          onclick="document.getElementById('lic-machine').value='${machineId}'">${machineId}</span>
          <span style="color:var(--muted2)"> (clic para copiar al campo)</span>
        </div>
      </div>
      <div class="fg">
        <label class="lbl">Nombre del negocio</label>
        <input class="inp" id="lic-biz" type="text" placeholder="Castillo Motors"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Tipo de licencia</label>
        <select class="inp" id="lic-type" onchange="saUpdateExpiry()">
          <option value="1year">1 año</option>
          <option value="2year">2 años</option>
          <option value="perpetual">Perpetua</option>
          <option value="trial">Prueba 30 días</option>
          <option value="custom">Fecha personalizada</option>
        </select>
      </div>
      <div class="fg" id="lic-expiry-wrap">
        <label class="lbl">Fecha de vencimiento</label>
        <input class="inp" id="lic-expiry" type="date"
               value="${new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0]}"/>
      </div>
    </div>
    <button class="btn btn-dark" onclick="saGenerarLicencia()" style="margin-bottom:12px">
      ${svg('check')} Generar clave de licencia
    </button>
    <div id="lic-result" style="display:none">
      <label class="lbl">Clave generada — cópiala y entrégala al cliente</label>
      <div style="display:flex;gap:8px">
        <input class="inp" id="lic-key-out" type="text" readonly
               style="font-family:var(--mono);font-size:11px;flex:1"/>
        <button class="btn btn-out" onclick="navigator.clipboard.writeText(document.getElementById('lic-key-out').value);toast('✓ Copiada')">
          Copiar
        </button>
      </div>
    </div>`;
  el.appendChild(licCard);

  // ── Info del sistema ─────────────────────────
  const infoCard = h('div', { class: 'card', style: { marginBottom: '16px' } });

  infoCard.innerHTML = `
    <div class="card-title mb8">Información del Sistema</div>
    <div class="tr" style="font-size:12px;margin-bottom:6px">
      <span>Versión</span><span style="font-weight:700">${info.appVersion || '1.0.0'}</span>
    </div>
    <div class="tr" style="font-size:12px;margin-bottom:6px">
      <span>ID de esta máquina</span>
      <span style="font-family:var(--mono);font-size:10px">${lic?.machineId || '—'}</span>
    </div>
    <div class="tr" style="font-size:12px;margin-bottom:6px">
      <span>Estado licencia</span>
      <span style="font-weight:700;color:${lic?.licensed?'var(--green)':lic?.inGrace?'var(--amber)':'var(--red)'}">
        ${lic?.licensed ? 'Activa' : lic?.inGrace ? `Gracia (${lic.graceDaysLeft}d)` : 'Sin licencia'}
      </span>
    </div>
    <div class="tr" style="font-size:12px;margin-bottom:6px">
      <span>Backups guardados</span><span>${info.backupsCount || 0}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Productos en DB</span><span>${DB.products.length}</span>
    </div>`;
  el.appendChild(infoCard);

  // ── Herramientas de mantenimiento ───────────
  const toolsCard = h('div', { class: 'card', style: { marginBottom: '16px' } });
  const dbSize = await window.api.version.getInfo().catch(() => ({ ok: false }));
  const dbInfo = dbSize.ok ? dbSize.data : {};

  toolsCard.innerHTML = `
    <div class="card-title mb8">Mantenimiento del Sistema</div>
    <div class="metrics" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="metric">
        <div class="met-label">Tamaño DB</div>
        <div class="met-val" style="font-size:16px">${dbInfo.dbSize || '—'}</div>
      </div>
      <div class="metric">
        <div class="met-label">Backups</div>
        <div class="met-val" style="font-size:16px">${dbInfo.backupsCount || 0}</div>
      </div>
      <div class="metric">
        <div class="met-label">Versión</div>
        <div class="met-val" style="font-size:16px">${dbInfo.appVersion || '1.0.0'}</div>
      </div>
    </div>
    <div class="flex" style="gap:8px;flex-wrap:wrap">
      <button class="btn btn-out" onclick="saVacuum()">
        ${svg('settings')} Compactar DB (VACUUM)
      </button>
      <button class="btn btn-out" onclick="saExportarDB()">
        ${svg('download')} Exportar DB completa
      </button>
      <button class="btn btn-out" onclick="saVerLogs()">
        ${svg('eye')} Ver últimos errores
      </button>
    </div>`;
  el.appendChild(toolsCard);

  // ── Herramientas peligrosas ──────────────────
  const dangerCard = h('div', { class: 'card' });
  dangerCard.innerHTML = `
    <div class="card-title mb8" style="color:var(--red)">⚠ Herramientas Peligrosas</div>
    <div class="alrt r" style="margin-bottom:12px">
      <div class="alrt-dot r"></div>
      <div>
        <div class="alrt-title">Solo para desarrollo y soporte técnico</div>
        <div class="alrt-sub">Estas acciones no se pueden deshacer.</div>
      </div>
    </div>
    <div class="flex" style="gap:8px;flex-wrap:wrap">
      <button class="btn btn-out" style="color:var(--red)" onclick="saResetearDatos()">
        ${svg('trash')} Resetear datos del negocio
      </button>
      <button class="btn btn-out" style="color:var(--red)" onclick="saRevocarLicencia()">
        ${svg('lock')} Revocar licencia
      </button>
    </div>`;
  el.appendChild(dangerCard);
}

function saUpdateExpiry() {
  const type     = document.getElementById('lic-type')?.value;
  const expiryEl = document.getElementById('lic-expiry');
  const expiryWrap = document.getElementById('lic-expiry-wrap');
  if (!expiryEl) return;

  if (type === 'perpetual') {
    if (expiryWrap) expiryWrap.style.display = 'none';
    expiryEl.value = 'PERPETUAL';
    return;
  }

  if (expiryWrap) expiryWrap.style.display = '';
  const now = new Date();
  if (type === '1year')  expiryEl.value = new Date(now.setFullYear(now.getFullYear()+1)).toISOString().split('T')[0];
  if (type === '2year')  expiryEl.value = new Date(now.setFullYear(now.getFullYear()+2)).toISOString().split('T')[0];
  if (type === 'trial')  expiryEl.value = new Date(now.setDate(now.getDate()+30)).toISOString().split('T')[0];
  if (type === 'custom') expiryEl.value = '';
}

async function saGenerarLicencia() {
  const machineId = document.getElementById('lic-machine')?.value?.trim().toUpperCase();
  const biz       = document.getElementById('lic-biz')?.value?.trim();
  const type      = document.getElementById('lic-type')?.value;
  let   expiry    = document.getElementById('lic-expiry')?.value?.trim();

  // Validaciones
  if (!machineId) {
    document.getElementById('lic-machine')?.focus();
    toast('Ingresa o copia el ID de máquina del cliente', 'err'); return;
  }
  if (!biz) {
    document.getElementById('lic-biz')?.focus();
    toast('Ingresa el nombre del negocio', 'err'); return;
  }

  // Para perpetua no necesita fecha
  if (type === 'perpetual') {
    expiry = 'PERPETUAL';
  } else if (!expiry) {
    toast('Selecciona la fecha de vencimiento', 'err'); return;
  }

  // Generar hash con SubtleCrypto del browser
  const secret  = 'velo-pos-2026-rd';
  const data    = `1|${machineId}|${biz}|${expiry}|${secret}`;
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2,'0')).join('')
    .slice(0,16).toUpperCase();

  const licKey = `1|${machineId}|${biz}|${expiry}|${hashHex}`;

  document.getElementById('lic-key-out').value = licKey;
  document.getElementById('lic-result').style.display = 'block';
  toast(`✓ Licencia ${type === 'perpetual' ? 'Perpetua' : `hasta ${expiry}`} generada`);
}

async function saExportarDB() {
  const result = await window.api.backup.create({ requestUserId: user.id });
  if (result.ok) {
    toast(`✓ DB exportada en: ${result.path}`);
  } else {
    toast(result.error || 'Error', 'err');
  }
}

function saResetearDatos() {
  openModal(`
    <div class="modal-title" style="color:var(--red)">⚠ Resetear Datos</div>
    <div class="modal-sub">Esta acción eliminará TODOS los datos del negocio.</div>
    <div class="alrt r" style="margin:14px 0">
      <div class="alrt-dot r"></div>
      <div>
        <div class="alrt-title">Se eliminarán permanentemente:</div>
        <div class="alrt-sub">
          Ventas, productos, clientes, caja, backups, configuración del negocio.<br>
          Los usuarios y la licencia se conservan.
        </div>
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Escribe RESETEAR para confirmar</label>
      <input class="inp" id="reset-confirm" type="text" placeholder="RESETEAR"/>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-red" onclick="saConfirmarReset()">
        Resetear todo
      </button>
    </div>
  `);
}

async function saConfirmarReset() {
  const val = document.getElementById('reset-confirm')?.value?.trim();
  if (val !== 'RESETEAR') {
    toast('Escribe RESETEAR exactamente', 'err'); return;
  }
  // Por ahora solo hacer backup antes del reset
  await window.api.backup.create({ requestUserId: user.id });
  toast('Función en desarrollo — se hizo un backup primero', 'w');
  closeModal();
}

// ── Funciones adicionales Super Admin ─────────

async function saVacuum() {
  const result = await window.api.db.vacuum({ requestUserId: user?.id }).catch(() => ({ ok: false }));
  if (result?.ok) {
    toast('✓ Base de datos compactada correctamente');
    renderSuperAdmin(document.getElementById('page'));
  } else {
    toast(result?.error || 'Error al ejecutar VACUUM', 'err');
  }
}

async function saVerLogs() {
  const logs = await window.api.audit.getLogs({ limit: 50, action: 'error' }) || [];
  const rows = logs.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:var(--muted2);padding:14px">Sin errores registrados</td></tr>'
    : logs.map(l => `
        <tr>
          <td style="font-size:11px;color:var(--muted)">${(l.created_at||'').replace('T',' ').slice(0,16)}</td>
          <td style="font-size:12px">${l.user_name||'sistema'}</td>
          <td style="font-size:11px;color:var(--red)">${l.action||''}</td>
          <td style="font-size:11px;color:var(--muted2);max-width:200px;
              overflow:hidden;text-overflow:ellipsis">${l.detail||'—'}</td>
        </tr>`).join('');

  openModal(`
    <div class="modal-title">Últimos Errores del Sistema</div>
    <div class="modal-sub">Registro de auditoría — últimas 50 entradas de error</div>
    <div class="tw" style="max-height:400px;overflow-y:auto">
      <table>
        <thead><tr>
          <th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
    </div>
  `, 'modal-lg');
}

function saRevocarLicencia() {
  confirmModal(
    `¿Revocar la licencia de esta instalación?
     <br><span style="font-size:11px;color:var(--muted)">
       El sistema entrará en período de gracia de 30 días.
       Útil si el cliente no renueva o transfiere a otra PC.
     </span>`,
    async () => {
      // Eliminar el archivo de licencia
      const result = await window.api.license.revoke({ requestUserId: user.id })
        .catch(() => ({ ok: false }));
      if (result?.ok) {
        toast('✓ Licencia revocada — el sistema entrará en período de gracia');
        renderSuperAdmin(document.getElementById('page'));
      } else {
        toast('Función disponible en próxima versión', 'w');
      }
    },
    'Revocar licencia', 'btn-red'
  );
}

// ══════════════════════════════════════════════
// SELECTOR DE PLANTILLAS DE IMPRESIÓN
// ══════════════════════════════════════════════
let _plantSeleccionada = null;

async function seleccionarPlantilla(id) {
  _plantSeleccionada = id;

  // Actualizar UI — resaltar seleccionada
  document.querySelectorAll('[id^="plant-card-"]').forEach(el => {
    const isSelected = el.id === `plant-card-${id}`;
    el.style.border    = `2px solid ${isSelected ? 'var(--green)' : 'var(--line)'}`;
    el.style.background = isSelected ? 'var(--green-bg)' : 'var(--surface)';
  });

  // Guardar en settings
  await window.api.settings.set({ key: 'print_template', value: id });
  if (DB?.settings) DB.settings.print_template = id;

  toast(`✓ Plantilla "${getPlantilla(id)?.nombre}" seleccionada`);

  // Mostrar vista previa automáticamente
  previsualizarPlantilla(id);
}

function previsualizarPlantilla(id) {
  const plantId  = id || _plantSeleccionada || DB?.settings?.print_template || 'termica_80_clasica';
  const plantilla = getPlantilla(plantId);
  if (!plantilla) return;

  const cfg = {
    biz_name:    DB?.settings?.biz_name    || CFG?.biz    || 'Mi Negocio',
    biz_rnc:     DB?.settings?.biz_rnc     || CFG?.rnc    || '101-00000-0',
    biz_addr:    DB?.settings?.biz_addr    || CFG?.addr   || 'Calle Principal #1',
    biz_phone:   DB?.settings?.biz_phone   || CFG?.phone  || '809-555-0000',
    biz_logo:    DB?.settings?.biz_logo    || CFG?.biz_logo || '',
    receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
  };

  const sale    = getSampleSale(cfg);
  const opts    = plantilla.opciones;
  const html    = plantilla.render(sale, cfg, opts);

  const preview = document.getElementById('plant-preview');
  const iframe  = document.getElementById('plant-iframe');
  if (preview && iframe) {
    preview.style.display = 'block';
    iframe.srcdoc = html;
  }
}

async function imprimirPruebaPlantilla() {
  const plantId   = _plantSeleccionada || DB?.settings?.print_template || 'termica_80_clasica';
  const plantilla = getPlantilla(plantId);
  if (!plantilla) { toast('Selecciona una plantilla primero', 'err'); return; }

  const cfg = {
    biz_name:    DB?.settings?.biz_name    || 'Mi Negocio',
    biz_rnc:     DB?.settings?.biz_rnc     || '101-00000-0',
    biz_addr:    DB?.settings?.biz_addr    || 'Calle Principal #1',
    biz_phone:   DB?.settings?.biz_phone   || '809-555-0000',
    biz_logo:    DB?.settings?.biz_logo    || '',
    receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
  };

  const sale = getSampleSale(cfg);
  const html = plantilla.render(sale, cfg, plantilla.opciones);

  const result = await window.api.print.html({
    html,
    printerName: DB?.settings?.printer || '',
    jobType:     'prueba_plantilla',
    referenceId: 0,
    userId:      user?.id,
  });

  if (result.ok) {
    toast(`✓ Prueba de "${plantilla.nombre}" enviada a la impresora`);
  } else {
    toast(result.error || 'Error al imprimir', 'err');
  }
}
