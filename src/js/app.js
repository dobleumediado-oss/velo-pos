// ══════════════════════════════════════════════
// app.js — Render principal, Login, Sidebar,
//           Topbar y Router de páginas
// ══════════════════════════════════════════════

// Manejadores globales de error del renderer (Fase 2): registran en el log
// persistente sin interrumpir la app. Ayudan a diagnosticar pantallas rotas.
window.addEventListener('error', (e) => {
  try {
    window.api?.log?.error('renderer',
      e.message || 'error', { src: e.filename, line: e.lineno, col: e.colno })?.catch?.(() => {});
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    // No re-loguear nuestros propios errores de red (evita cualquier cascada).
    if (r && (r.message === 'SERVER_OFFLINE' || r.offline)) return;
    window.api?.log?.error('renderer-promise',
      r?.message || String(r), { stack: r?.stack })?.catch?.(() => {});
  } catch {}
});

// ── Sesión única por usuario (multi-terminal) — heartbeat ──
// Mantiene viva la sesión de esta terminal en el servidor. Sin heartbeat por
// unos minutos, otra terminal puede tomar el control (evita bloqueo por caída).
let _sessionHbInterval = null;
function _sessionTerminalId() {
  return (typeof CFG !== 'undefined' && CFG.terminalId)
      || (typeof TERMINAL_ID !== 'undefined' && TERMINAL_ID) || '';
}
function _startSessionHeartbeat() {
  _stopSessionHeartbeat();
  _sessionHbInterval = setInterval(() => {
    try {
      const tid = _sessionTerminalId();
      if (user && tid && window.api?.auth?.heartbeat) {
        window.api.auth.heartbeat({ userId: user.id, terminalId: tid });
      }
    } catch {}
  }, 60000);
}
function _stopSessionHeartbeat() {
  if (_sessionHbInterval) { clearInterval(_sessionHbInterval); _sessionHbInterval = null; }
}

// ── Bootstrap ────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Cargar versión de la app para mostrar en login y config
  try {
    const vr = await window.api.version.getInfo();
    window._appVersion = vr?.ok ? vr.data?.appVersion : '1.4.1';
  } catch { window._appVersion = '1.5.5'; }

  // ── Multi-terminal: preflight de servidor en modo CLIENTE ──────────────────
  // Si estamos en modo cliente y el servidor NO responde, mostrar la pantalla de
  // recuperación en vez de intentar cargar datos (cada llamada se reenvía al
  // servidor y colgaría/rompería la app). En modo local esto no hace nada.
  try {
    const pf = await window.api.connection?.clientPreflight?.();
    if (pf && pf.mode === 'client' && (!pf.reachable || !pf.authorized)) {
      renderClientOffline(pf);
      return;
    }
  } catch (e) { /* si el preflight falla, seguir normal (nunca bloquear modo local) */ }

  // Cargar todos los datos vía IPC
  await loadAppData();

  // Multi-negocio se elige desde el login. Si cambia el negocio activo,
  // main reinicia Velo POS para montar la base de datos correcta.

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
async function selectBusinessFromLogin(bizId, label, opts = {}) {
  const nextId = bizId || '';
  const currentId = CFG.activeBusinessId || '';
  if (nextId === currentId) return { ok: true, changed: false };

  const name = label || (nextId ? 'este negocio' : 'Negocio Principal');
  const isClientMode = CFG.connectionMode === 'client';
  const restartText = isClientMode
    ? 'solo esta terminal se reiniciará; las demás continuarán trabajando'
    : 'Velo POS se reiniciará automáticamente';
  if (!confirm(`Abrir "${name}" ahora? ${restartText}.`)) {
    return { ok: false, cancelled: true };
  }

  const msg = opts.messageEl || document.getElementById('login-biz-msg') || document.getElementById('lerr');
  const control = opts.controlEl || null;
  const setMsg = (text, type = 'info') => {
    if (!msg) return;
    const color = type === 'err' ? 'var(--red)' : 'rgba(255,255,255,.55)';
    if (msg.id === 'lerr') {
      msg.innerHTML = '';
      const line = document.createElement('div');
      if (type === 'err') line.className = 'err';
      else line.style.cssText = 'color:var(--muted);font-size:12px;padding:8px 0';
      line.textContent = text;
      msg.appendChild(line);
    } else {
      msg.textContent = text;
      msg.style.color = color;
    }
  };

  try {
    if (control) control.disabled = true;
    setMsg('Abriendo negocio...');
    sessionStorage.removeItem('vp_user');
    user = null;
    window._currentUser = null;

    const r = await window.api.business.selectForLogin({ bizId: nextId || null });
    if (r?.ok) {
      if (r.relaunching) {
        setMsg(isClientMode ? 'Reiniciando esta terminal...' : 'Reiniciando Velo POS...');
      } else {
        setMsg('Negocio activo.');
        location.reload();
      }
      return r;
    }

    setMsg(r?.error || 'No se pudo abrir el negocio.', 'err');
    if (control) control.disabled = false;
    return r || { ok: false };
  } catch (e) {
    setMsg(e?.message || 'No se pudo abrir el negocio.', 'err');
    if (control) control.disabled = false;
    return { ok: false, error: e?.message || 'Error' };
  }
}

// ── Pantalla de recuperación: modo cliente sin servidor ──────────────────────
// Se muestra al arrancar si connection_mode='client' y el servidor no responde.
// Evita el cuelgue/brick: no se intenta cargar datos; se ofrece reintentar o
// volver a modo local (sin necesidad de login ni herramientas externas).
function renderClientOffline(pf) {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.style.cssText = 'width:100%;height:100%;display:flex;';
  const dest = `${(pf && pf.host) || 'servidor'}${pf && pf.port ? ':' + pf.port : ''}`;
  // Dos causas distintas: servidor inalcanzable vs servidor OK pero terminal no autorizado.
  const unauth = pf && pf.reachable && !pf.authorized;
  const titulo = unauth ? 'Este terminal no está autorizado' : 'No se pudo conectar al servidor';
  const icono  = unauth ? '🔒' : '📡';
  const detalle = unauth
    ? `El servidor ${dest} respondió, pero rechazó este terminal. Falta autorizarlo (o la llave de acceso no coincide).`
    : `Esta PC está en modo Cliente y no logró comunicarse con ${dest}.`;
  const ayuda = unauth
    ? 'En la PC servidor: Config → Conexión → agrega el ID de este terminal a los autorizados, y verifica que la llave sea la misma.'
    : 'Verifica que la PC servidor esté encendida, con Velo POS abierto en modo Servidor y el puerto permitido en el firewall.';

  const card = h('div', { style: { maxWidth: '480px', margin: 'auto', textAlign: 'center', padding: '32px',
    background: 'var(--surface, #fff)', border: '1px solid var(--line2, #e5e7eb)', borderRadius: '16px' } },
    h('div', { style: { fontSize: '40px', marginBottom: '10px' } }, icono),
    h('div', { style: { fontSize: '17px', fontWeight: '700', marginBottom: '8px' } }, titulo),
    h('div', { style: { fontSize: '13px', color: 'var(--muted2, #6b7280)', marginBottom: '4px' } }, detalle),
    h('div', { style: { fontSize: '12px', color: 'var(--muted2, #6b7280)', marginBottom: '14px' } }, ayuda),
    (pf && pf.terminalId)
      ? h('div', { style: { fontSize: '11px', color: 'var(--ink,#111)', background: 'var(--line,#f3f4f6)', borderRadius: '8px', padding: '8px 10px', marginBottom: '16px', wordBreak: 'break-all' } },
          h('div', { style: { color: 'var(--muted2,#6b7280)', marginBottom: '2px' } }, 'ID de este terminal (dáselo al servidor):'),
          h('div', { style: { fontWeight: '700', fontFamily: 'monospace' } }, pf.terminalId))
      : null,
    h('div', { id: 'co-msg', style: { fontSize: '12px', minHeight: '16px', marginBottom: '12px', color: 'var(--muted2,#6b7280)' } }, ''),
    h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' } },
      h('button', { class: 'btn', id: 'co-retry' }, '🔄 Reintentar'),
      h('button', { class: 'btn-ghost', id: 'co-local' }, '🏠 Volver a modo local')
    ),
    h('div', { style: { fontSize: '11px', color: 'var(--muted2,#9ca3af)', marginTop: '16px' } },
      'En modo local esta PC funciona de forma independiente con sus propios datos.')
  );
  root.appendChild(h('div', { style: { width: '100%', height: '100%', display: 'flex' } }, card));

  document.getElementById('co-retry').onclick = async () => {
    const msg = document.getElementById('co-msg');
    msg.textContent = 'Reintentando…';
    try {
      const r = await window.api.connection.clientPreflight();
      if (r && r.reachable) { location.reload(); return; }
      msg.textContent = 'El servidor sigue sin responder. Revisa la conexión e intenta de nuevo.';
    } catch { msg.textContent = 'El servidor sigue sin responder.'; }
  };
  // Volver a modo local es una acción seria (la PC queda con datos propios,
  // separados del servidor) → siempre modal de confirmación, y si el dev
  // configuró contraseña de modo local (panel dev del servidor), se exige aquí.
  document.getElementById('co-local').onclick = () => _confirmLocalMode(pf);
}

// Modal de confirmación (pre-login, sin dependencias de openModal) para volver
// a modo local desde la pantalla de recuperación.
function _confirmLocalMode(pf) {
  const needsPwd = !!(pf && pf.localGuard);
  const overlay = h('div', { style: {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,.55)', zIndex: '9999',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' } });

  const msgEl = h('div', { style: { fontSize: '12px', minHeight: '16px', color: 'var(--red,#ef4444)', marginBottom: '10px' } }, '');
  const pwdInput = needsPwd
    ? h('input', { class: 'inp', type: 'password', placeholder: 'Contraseña de modo local',
        style: { width: '100%', marginBottom: '10px', textAlign: 'center', letterSpacing: '.1em' } })
    : null;

  const doConfirm = async () => {
    if (needsPwd && !pwdInput.value.trim()) { msgEl.textContent = 'Ingresa la contraseña.'; return; }
    msgEl.style.color = 'var(--muted2,#6b7280)';
    msgEl.textContent = 'Cambiando a modo local…';
    try {
      const r = await window.api.connection.setMode({ mode: 'local', password: needsPwd ? pwdInput.value.trim() : undefined });
      if (r && r.ok) { location.reload(); return; }
      msgEl.style.color = 'var(--red,#ef4444)';
      msgEl.textContent = r?.error === 'PASSWORD_INCORRECT' ? 'Contraseña incorrecta.'
                        : r?.error === 'PASSWORD_REQUIRED'  ? 'Se requiere la contraseña.'
                        : (r?.error || 'No se pudo cambiar el modo.');
    } catch (e) {
      msgEl.style.color = 'var(--red,#ef4444)';
      msgEl.textContent = e.message || 'Error al cambiar el modo.';
    }
  };

  const card = h('div', { style: { maxWidth: '420px', width: '100%', background: 'var(--surface,#fff)',
    border: '1px solid var(--line2,#e5e7eb)', borderRadius: '14px', padding: '24px', textAlign: 'center' } },
    h('div', { style: { fontSize: '34px', marginBottom: '8px' } }, '⚠️'),
    h('div', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' } }, '¿Volver a modo local?'),
    h('div', { style: { fontSize: '12px', color: 'var(--muted2,#6b7280)', marginBottom: '12px', textAlign: 'left' } },
      'Esta PC dejará de trabajar con los datos del servidor y pasará a usar su propia base LOCAL (vacía o desactualizada). ',
      h('strong', null, 'Lo que registres en modo local NO se sincroniza con el servidor'),
      ', y para volver a conectarla habrá que configurarla de nuevo. Úsalo solo si el servidor no va a volver pronto.'),
    pwdInput,
    msgEl,
    h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } },
      h('button', { class: 'btn-ghost', onclick: () => overlay.remove() }, 'Cancelar'),
      h('button', { class: 'btn', style: { background: 'var(--red,#ef4444)', borderColor: 'var(--red,#ef4444)' },
        onclick: doConfirm }, 'Sí, volver a modo local')
    )
  );
  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  if (pwdInput) {
    pwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doConfirm(); });
    setTimeout(() => pwdInput.focus(), 50);
  }
}

function renderLogin() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.style.cssText = 'width:100%;height:100%;display:flex;';

  // Estado local del login
  let selRole = 'cajero';
  let loginBiz = { loaded: false, loading: false, businesses: [], error: '' };

  async function loadLoginBusinesses() {
    if (loginBiz.loading || loginBiz.loaded) return;
    loginBiz = { ...loginBiz, loading: true, error: '' };
    try {
      const res = await window.api.business?.getAll?.();
      loginBiz = {
        loaded: true,
        loading: false,
        businesses: res?.data || [],
        error: res?.ok === false ? (res.error || '') : '',
      };
    } catch (e) {
      loginBiz = { loaded: true, loading: false, businesses: [], error: e?.message || 'Error' };
    }
    build();
  }

  function businessLoginControl() {
    if (CFG.module_multi_negocio !== '1') return null;
    const isClientMode = CFG.connectionMode === 'client';

    if (!loginBiz.loaded && !loginBiz.loading) loadLoginBusinesses();

    if (loginBiz.loading) {
      return h('div', { class: 'fg', style: { marginTop: '14px', marginBottom: '4px' } },
        h('label', { class: 'lbl' }, isClientMode ? 'Negocio del servidor' : 'Negocio'),
        h('div', { class: 'inp', style: { display: 'flex', alignItems: 'center', color: 'var(--muted2)' } }, 'Cargando negocios...')
      );
    }

    const options = [
      { id: '', name: 'Negocio Principal', description: 'Base de datos original' },
      ...loginBiz.businesses,
    ];
    if (options.length <= 1 && !CFG.activeBusinessId) return null;

    const activeId = CFG.activeBusinessId || '';
    const select = h('select', {
      class: 'inp',
      id: 'login-business-select',
      onchange: async (e) => {
        const nextId = e.target.value || '';
        const chosen = options.find(o => (o.id || '') === nextId);
        const result = await selectBusinessFromLogin(nextId, chosen?.name || 'Negocio', {
          controlEl: e.target,
          messageEl: document.getElementById('login-biz-msg'),
        });
        if (!result?.ok || result.cancelled) e.target.value = activeId;
      }
    });
    options.forEach((b) => {
      const op = document.createElement('option');
      op.value = b.id || '';
      op.textContent = b.name || b.id || 'Negocio';
      if ((b.id || '') === activeId) op.selected = true;
      select.appendChild(op);
    });

    return h('div', { class: 'fg', style: { marginTop: '14px', marginBottom: '4px' } },
      h('label', { class: 'lbl' }, isClientMode ? 'Negocio del servidor' : 'Negocio'),
      h('div', { class: 'inp-ic' },
        h('div', { class: 'ic', html: svg('building') }),
        select
      ),
      h('div', {
        id: 'login-biz-msg',
        style: { minHeight: '14px', marginTop: '5px', fontSize: '10px', color: 'rgba(255,255,255,.38)' }
      }, loginBiz.error
        ? `No se pudo cargar la lista: ${loginBiz.error}`
        : (isClientMode ? 'La selección aplica solo a esta terminal; no cambia las demás cajas.' : ''))
    );
  }

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
            h('div', { class: 'login-sub' }, 'Gestión comercial · Inventario · Facturación · RD'),
            CFG.activeBusinessId
              ? h('div', {
                  style: {
                    marginTop: '5px', fontSize: '11px', color: 'rgba(255,255,255,.55)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '250px'
                  }
                }, `Negocio activo: ${CFG.activeBusinessName || CFG.biz}`)
              : null
          )
        ),

        businessLoginControl(),

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

    // El login puede RECHAZAR (modo cliente: el servidor no responde o rechaza). Sin
    // este try/catch la pantalla se quedaba colgada en "Verificando..." sin avisar.
    let result;
    try {
      const terminalId = (typeof ensureTerminalId === 'function') ? await ensureTerminalId() : '';
      result = await window.api.auth.login({ email, password: pass, terminalId });
    } catch (e) {
      lerr.innerHTML = `<div class="err">No se pudo verificar el acceso.
        <br><span style="font-size:10px">${(e && e.message) === 'SERVER_OFFLINE'
          ? 'El servidor no responde. Revisa la conexión o entra como administrador para volver a modo local.'
          : ((e && e.message) || 'Error de conexión con el servidor')}</span></div>`;
      passEl.value = ''; passEl.focus();
      return;
    }

    // Sesión única: el usuario ya está activo en otra terminal.
    if (!result.ok && result.activeSession) {
      lerr.innerHTML = `<div class="err">Este usuario ya tiene una sesión activa en otra terminal.
        <br><span style="font-size:10px">Cierra sesión en la otra máquina o espera unos minutos.</span></div>`;
      passEl.value = ''; passEl.focus();
      return;
    }

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
    _startSessionHeartbeat();    // mantiene viva la sesión única de esta terminal
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
  // Mantiene el indicador de Preventa ligado a la cola real incluso en modo
  // local (sin eventos SSE) y permite retirar reservas vencidas del badge.
  if (typeof preventaConfigureMonitor === 'function') preventaConfigureMonitor();
  window.VeloExperience?.mount();
  window.VeloTour?.maybeOffer?.();
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
    ...(preventaCanAccess() ? [{ key: 'preventa', icon: 'cash', label: 'Preventa y Despacho', badge: window._preventaPendingCount || null }] : []),
    { sep: 'Gestión' },
    { key: 'inventario',icon: 'box',      label: 'Inventario' },
    { key: 'compras',   icon: 'truck',    label: 'Compras' },
    { key: 'clientes',  icon: 'users',    label: 'Clientes' },
    { key: 'ventas',    icon: 'list',     label: 'Ventas' },
    { key: 'devoluciones', icon: 'return', label: 'Devoluciones' },
    ...(_adminPuede('module_vendedores') ? [{ key: 'vendedores', icon: 'users', label: 'Vendedores' }] : []),
    ...(_adminPuede('module_vendedores') ? [{ key: 'comisiones', icon: 'trend', label: 'Comisiones' }] : []),
    { sep: 'Finanzas' },
    { key: 'caja',      icon: 'cash',     label: 'Caja' },
    ...(_adminPuede('module_gastos') ? [{ key: 'gastos', icon: 'dollar', label: 'Gastos' }] : []),
    ...(_adminPuede('module_vendedores') ? [{ key: 'nomina', icon: 'calendar', label: 'Nómina' }] : []),
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
    ...(preventaCanAccess() ? [{ key: 'preventa', icon: 'cash', label: 'Preventa y Despacho', badge: window._preventaPendingCount || null }] : []),
    { key: 'clientes',  icon: 'users',    label: 'Clientes',
      badge: alertBadge > 0 ? alertBadge : null },
    { key: 'ventas',    icon: 'list',     label: 'Ventas' },
    { key: 'caja',      icon: 'cash',     label: 'Caja' },
    ...(_cajeroPuede('module_gastos')     ? [{ key: 'gastos',     icon: 'dollar',  label: 'Gastos' }]      : []),
    ...(_cajeroPuede('module_vendedores') ? [{ key: 'vendedores', icon: 'users',   label: 'Vendedores' }]   : []),
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
    preventa:      'Preventa y Despacho',
    inventario:    'Inventario',
    compras:       'Compras',
    clientes:      'Clientes',
    ventas:        'Ventas',
    devoluciones:  'Devoluciones',
    vendedores:    'Vendedores',
    comisiones:     'Comisiones',
    nomina:        'Nómina',
    caja:          'Caja',
    gastos:        'Gastos y Cuentas por Pagar',
    vehiculos:     'Vehículos y Mantenimiento',
    envios:        'Envíos y Despachos',
    sucursales:    'Sucursales',
    conduce:       'Conduces y Entregas',
    reportes:      'Reportes',
    auditoria:     'Auditoría del Sistema',
    configuracion: 'Configuración',
    etiquetas:     'Etiquetas de Código de Barras',
    bancos:        'Bancos y Cuentas Financieras',
    contabilidad:  'Contabilidad',
    superadmin:    'Panel de Desarrollador',
  };

  // ── Izquierda: toggle + título ───────────────
  const left = h('div', { class: 'tb-left' });
  left.appendChild(h('button', {
    class: 'tb-toggle',
    onclick: () => { sbSm = !sbSm; buildSidebar(); buildTopbar(); },
    html: svg('menu')
  }));
  left.appendChild(h('span', { class: 'tb-title' }, titles[page] || 'Velo POS'));

  // ── Centro: reloj digital + banner de tasas ──
  // El .tb-clock trae flex:1 del CSS (era el centro elástico del topbar);
  // aquí el elástico pasa a ser centerWrap y el reloj vuelve a tamaño natural.
  const clockWrap = h('div', { class: 'tb-clock', id: 'tb-clock-wrap', style: { flex: '0 0 auto' } });
  const clockTime = h('div', { class: 'tb-clock-time', id: 'tb-clock-time' });
  const clockDate = h('div', { class: 'tb-clock-date', id: 'tb-clock-date' });
  clockWrap.appendChild(clockTime);
  clockWrap.appendChild(clockDate);

  // Banner multifuncional: tasa del dólar (Banreservas) + combustible a elegir,
  // con flechas de variación vs el valor anterior (▲ verde subió · ▼ roja bajó)
  const ratesWrap = h('div', {
    id: 'tb-rates',
    style: { display: 'flex', alignItems: 'center', gap: '8px' }
  });
  const centerWrap = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '16px', justifyContent: 'center', flex: '1', minWidth: '0' }
  });
  centerWrap.appendChild(clockWrap);
  centerWrap.appendChild(ratesWrap);

  // ── Derecha: pills + bell ────────────────────
  const right = h('div', { class: 'tb-right' });

  if (CFG.activeBusinessId) {
    right.appendChild(h('div', {
      class: 'pill',
      title: `Negocio activo: ${CFG.activeBusinessName || CFG.biz}`,
      style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    }, `Negocio: ${CFG.activeBusinessName || CFG.biz}`));
  }

  right.appendChild(h('div', {
    class: `pill ${cajaOpen ? 'open' : 'closed'}`,
    html: cajaOpen
      ? `${svg('check')} Caja Abierta`
      : `${svg('xmark')} Caja Cerrada`
  }));

  // ── Acciones rápidas globales ────────────────
  right.appendChild(h('button', {
    class: 'ib ux-top-action',
    'aria-label': 'Crear rápidamente',
    title: 'Crear rápidamente (⌘J / Ctrl+J)',
    onclick: () => window.experienceOpenQuickActions?.(),
    html: svg('plus')
  }));

  // ── Buscador global ⌘K ─────────────────────
  right.appendChild(h('button', {
    class: 'btn btn-ghost',
    'aria-label': 'Buscar en todo el sistema',
    title: 'Búsqueda global (⌘K / Ctrl+K)',
    style: { fontSize: '12px', padding: '5px 10px', gap: '5px',
             border: '1px solid var(--line)', borderRadius: '8px' },
    onclick: _openGSearch,
    html: `${svg('search')} <span style="font-size:11px;color:var(--muted)">⌘K</span>`
  }));

  right.appendChild(h('button', {
    class: 'ib ux-command-trigger',
    'aria-label': 'Abrir centro de mando',
    title: 'Centro de mando (⌘⇧P / Ctrl+Shift+P)',
    onclick: () => window.experienceOpenCommandCenter?.(),
    html: svg('chart')
  }));

  const alerts = getCreditAlerts();
  const experienceAlerts = window.VeloExperience?.notificationCount?.() || alerts.length;
  const bell = h('button', {
    class: 'ib', title: 'Centro de notificaciones',
    'aria-label': 'Abrir centro de notificaciones',
    onclick: () => window.experienceOpenNotifications?.()
  },
    h('div', { html: svg('bell') })
  );
  if (experienceAlerts) bell.appendChild(h('span', { class: 'ib-badge' }, experienceAlerts > 99 ? '99+' : String(experienceAlerts)));
  right.appendChild(bell);

  right.appendChild(h('button', {
    class: 'ib', title: 'Apariencia y densidad',
    'aria-label': 'Cambiar apariencia y densidad',
    onclick: () => window.experienceOpenAppearance?.(),
    html: svg('half')
  }));

  right.appendChild(h('button', {
    class: 'ib ux-guide-trigger', title: 'Guía y recorridos',
    'aria-label': 'Abrir guía y recorridos',
    onclick: () => window.experienceOpenGuide?.(),
    html: svg('help')
  }));

  tb.appendChild(left);
  tb.appendChild(centerWrap);
  tb.appendChild(right);

  // Iniciar/reiniciar el ticker del reloj y el banner de tasas
  _startTopbarClock();
  _startTopbarRates();
}

// ── Banner de tasas del topbar ────────────────
// Dólar Banreservas (compra/venta) + un combustible a elegir (clic para
// cambiar), ambos con flecha de variación respecto al valor anterior:
// subió → ▲ verde +X · bajó → ▼ roja −X. Datos vía IPC (caché en main).
let _ratesData = null;
let _ratesTs   = 0;
let _ratesInterval = null;
const _RATES_TTL = 30 * 60 * 1000; // refresco cada 30 min

const _BANNER_FUELS = ['premium', 'regular', 'diesel', 'gasoil_regular', 'glp', 'gnv', 'kerosene'];
const _BANNER_FUEL_LABEL = {
  premium: 'G. Premium', regular: 'G. Regular', diesel: 'Gasoil Ópt.',
  gasoil_regular: 'Gasoil Reg.', glp: 'GLP', gnv: 'GNV', kerosene: 'Kerosene',
};

function _bannerArrow(delta) {
  if (!delta) return '';
  const up  = delta > 0;
  const val = Math.abs(delta).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return up
    ? `<span style="color:var(--green,#00c07a);font-weight:700;font-size:10px"> ▲ +${val}</span>`
    : `<span style="color:var(--red,#ef4444);font-weight:700;font-size:10px"> ▼ -${val}</span>`;
}

function _bannerNum(v) {
  return Number(v || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _renderTopbarRates() {
  const wrap = document.getElementById('tb-rates');
  if (!wrap) return;
  const d = _ratesData;
  if (!d) { wrap.innerHTML = ''; return; }

  const chipStyle = 'display:flex;flex-direction:column;justify-content:center;padding:4px 10px;' +
    'background:var(--surface2,var(--bg2));border:1px solid var(--line,var(--line2));border-radius:8px;' +
    'font-size:11px;line-height:1.35;white-space:nowrap';
  const parts = [];

  // ── Dólar Banreservas: compra y venta, cada una con su flecha ──
  if (d.usd?.compra && d.usd?.venta) {
    parts.push(`
      <div style="${chipStyle}" title="Tasa del dólar — Banreservas (${d.usd.source})">
        <div style="font-size:9px;font-weight:700;color:var(--muted2);letter-spacing:.04em">💵 US$ BANRESERVAS</div>
        <div style="color:var(--ink)">
          <b>C:</b> ${_bannerNum(d.usd.compra.value)}${_bannerArrow(d.usd.compra.delta)}
          <span style="color:var(--muted2)"> · </span>
          <b>V:</b> ${_bannerNum(d.usd.venta.value)}${_bannerArrow(d.usd.venta.delta)}
        </div>
      </div>`);
  }

  // ── Combustibles a mostrar ──
  // Fuente: setting banner_fuels (JSON array), configurable desde Configuración
  // → un chip por combustible seleccionado, mostrados lado a lado. Si no hay
  // configuración todavía, se cae al modo legacy: un solo chip (localStorage,
  // clic para rotar). Se filtra a los que realmente traen precio.
  const grades = _bannerSelectedFuels().filter(g => d.fuel?.[g]);
  const legacyMode = grades.length === 0;
  let showGrades = grades;
  if (legacyMode) {
    let g = localStorage.getItem('vp_banner_fuel') || 'premium';
    if (!d.fuel?.[g]) g = _BANNER_FUELS.find(x => d.fuel?.[x]) || null;
    showGrades = g ? [g] : [];
  }

  showGrades.forEach((grade, i) => {
    const f = d.fuel[grade];
    if (!f) return;
    const clickable = legacyMode; // en modo legacy el chip rota; configurado no
    parts.push(`
      <div ${clickable ? 'id="tb-rate-fuel"' : `data-fuel-chip="${grade}"`} style="${chipStyle}${clickable ? ';cursor:pointer' : ''}" title="${clickable ? 'Clic para cambiar de combustible · ' : ''}RD$/galón">
        <div style="font-size:9px;font-weight:700;color:var(--muted2);letter-spacing:.04em">⛽ ${_BANNER_FUEL_LABEL[grade] || grade}</div>
        <div style="color:var(--ink)"><b>RD$${_bannerNum(f.value)}</b>${_bannerArrow(f.delta)}</div>
      </div>`);
  });

  wrap.innerHTML = parts.join('');

  // Modo legacy: clic en el chip único → rotar al siguiente disponible
  document.getElementById('tb-rate-fuel')?.addEventListener('click', () => {
    const avail = _BANNER_FUELS.filter(g => _ratesData?.fuel?.[g]);
    if (!avail.length) return;
    const cur = localStorage.getItem('vp_banner_fuel') || 'premium';
    const next = avail[(avail.indexOf(cur) + 1) % avail.length];
    localStorage.setItem('vp_banner_fuel', next);
    _renderTopbarRates();
  });
}

// Combustibles elegidos para el banner (desde el setting banner_fuels). Devuelve
// [] si no hay configuración → el render usa el modo legacy de un solo chip.
function _bannerSelectedFuels() {
  try {
    const raw = (typeof CFG !== 'undefined' && CFG.banner_fuels) || '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(g => _BANNER_FUELS.includes(g)) : [];
  } catch { return []; }
}

async function _fetchTopbarRates() {
  if (!window.api?.banner?.getRates) return;
  try {
    const res = await window.api.banner.getRates();
    if (res?.ok && res.data) { _ratesData = res.data; _ratesTs = Date.now(); }
  } catch { /* sin internet: se mantiene el último valor */ }
  _renderTopbarRates();
}

function _startTopbarRates() {
  // Pintar de inmediato con lo cacheado; refetch solo si está viejo
  _renderTopbarRates();
  if (!_ratesData || (Date.now() - _ratesTs) > _RATES_TTL) _fetchTopbarRates();
  if (_ratesInterval) clearInterval(_ratesInterval);
  _ratesInterval = setInterval(_fetchTopbarRates, _RATES_TTL);
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
// FLUIDEZ: swap de vista sin pestañeo (Q1)
// ══════════════════════════════════════════════
// Renderiza el contenido nuevo en un contenedor TEMPORAL fuera de pantalla (pero
// dentro del documento, para que getElementById de los sub-renders siga funcionando),
// y hace un SWAP ATÓMICO al final. El usuario ve el contenido anterior hasta que el
// nuevo está listo → sin destello en blanco durante la carga async.
// `buildFn(tmp)` debe rellenar `tmp` (async). Los listeners y nodos se preservan.
async function _swapView(body, buildFn) {
  if (!body) return;
  const tmp = document.createElement('div');
  tmp.style.cssText = `position:absolute;left:-99999px;top:0;width:${body.clientWidth || body.offsetWidth || 900}px`;
  document.body.appendChild(tmp);
  try {
    await buildFn(tmp);
    body.replaceChildren(...Array.from(tmp.childNodes));
  } catch (e) {
    console.error('[swapView]', e);
    // Fallback: si algo falla, renderizar directo (comportamiento anterior).
    body.innerHTML = '';
    try { await buildFn(body); } catch (_) {}
  } finally {
    tmp.remove();
  }
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
  if (p !== 'preventa' && window._preventaRefreshTimer) {
    clearInterval(window._preventaRefreshTimer);
    window._preventaRefreshTimer = null;
  }
  // Bloquear navegación si hay cambio de contraseña obligatorio pendiente
  if (window._pwdChangeRequired && p !== 'configuracion') {
    toast('Debes cambiar tu contraseña antes de continuar', 'w');
    renderCambioContrasenaObligatorio();
    return;
  }
  if (p === 'preventa' && !preventaCanAccess()) {
    p = user?.role === 'cajero' ? 'pos' : 'dash';
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
      vendedores:   ['module_vendedores'],
      comisiones:    ['module_vendedores'],
      nomina:       ['module_vendedores'],
      preventa:     ['module_preventa'],
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
      vendedores: ['module_vendedores'],
      preventa:   ['module_preventa'],
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
  // La ruta queda expuesta como clase y atributo semántico. El sistema visual
  // usa este contrato para dar identidad a cada módulo sin acoplar estilos a
  // su lógica interna ni depender de selectores frágiles por posición.
  el.className = `page fi module-page module-${page}`;
  el.dataset.module = page;
  // Reset estilos inline que el POS establece (padding:0, overflow:hidden)
  // Sin esto, todos los módulos que vienen después del POS pierden su padding
  el.style.cssText = '';

  switch (page) {
    case 'dash':         renderDash(el);          break;
    case 'pos':          renderPOS(el);            break;
    case 'preventa':     renderPreventa(el);       break;
    case 'inventario':   renderInventario(el);     break;
    case 'compras':      renderCompras(el);         break;
    case 'clientes':     renderClientes(el);       break;
    case 'ventas':       renderVentas(el);         break;
    case 'devoluciones': renderDevoluciones(el);   break;
    case 'vendedores':   renderVendedores(el);     break;
    case 'comisiones':    renderComisiones(el);     break;
    case 'nomina':       renderNomina(el);         break;
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
  // Los módulos asíncronos se observan automáticamente; este pase cubre las
  // vistas sincrónicas y habilita orden/columnas desde el primer fotograma.
  requestAnimationFrame(() => window.VeloExperience?.enhancePage?.(el));
  window.VeloExperience?.onRoute?.(page);
}

// ══════════════════════════════════════════════
// LOGOUT
// ══════════════════════════════════════════════
async function doLogout() {
  if (window._preventaBadgeTimer) {
    clearInterval(window._preventaBadgeTimer);
    window._preventaBadgeTimer = null;
  }
  // Limpiar auto-refresh del dashboard
  if (window._dashRefreshInterval) {
    clearInterval(window._dashRefreshInterval);
    window._dashRefreshInterval = null;
  }
  _stopSessionHeartbeat();
  if (user) {
    try {
      await window.api.auth.logout({ userId: user.id, userName: user.name, terminalId: _sessionTerminalId() });
    } catch {}
  }
  user = null;
  window._currentUser = null;
  page = 'dash';
  resetInvoices();
  sessionStorage.removeItem('vp_user');

  await loadAppData();
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

// Reemplazo de prompt(): Electron NO implementa window.prompt (lanza error y el
// flujo muere en silencio). Modal propio → Promise<string|null> (null = canceló).
// Overlay independiente de openModal para poder pedir texto encima de un modal.
function askText(message, { title = 'Confirmar', defaultValue = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let ov;
    const done = (val) => { ov.remove(); resolve(val); };
    const input = h('input', { class: 'inp', value: defaultValue, placeholder,
      style: { width: '100%', marginTop: '12px' } });
    ov = h('div', {
      style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.55)', zIndex: '10000',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' },
      onclick: (e) => { if (e.target === ov) done(null); } },
      h('div', { style: { maxWidth: '420px', width: '100%', background: 'var(--surface,#fff)',
        border: '1px solid var(--line2,#e5e7eb)', borderRadius: '14px', padding: '22px' } },
        h('div', { style: { fontSize: '15px', fontWeight: '700', marginBottom: '6px' } }, title),
        h('div', { style: { fontSize: '12.5px', color: 'var(--muted2,#6b7280)', whiteSpace: 'pre-line' } }, message),
        input,
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' } },
          h('button', { class: 'btn-ghost', onclick: () => done(null) }, 'Cancelar'),
          h('button', { class: 'btn', onclick: () => done(input.value) }, 'Aceptar'))));
    document.body.appendChild(ov);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    setTimeout(() => input.focus(), 30);
  });
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
    class: 'ux-search-overlay',
    style: {
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-start',
      justifyContent: 'center', paddingTop: '80px',
    },
    onclick: e => { if (e.target === ov) _closeGSearch(); }
  });

  const box = h('div', {
    class: 'ux-search-box',
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
    onkeydown: e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); _moveGSearch(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); _moveGSearch(-1); }
      if (e.key === 'Enter') {
        const active = document.querySelector('#gsearch-results [data-gsearch-item].active') || document.querySelector('#gsearch-results [data-gsearch-item]');
        if (active) { e.preventDefault(); active.click(); }
      }
    },
  });

  const results = h('div', {
    id: 'gsearch-results',
    class: 'ux-search-results',
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

  results.innerHTML = window.VeloExperience?.searchHome?.() || `<div class="ux-search-empty">Empieza a escribir para buscar en todo el sistema</div>`;

  box.appendChild(inp);
  box.appendChild(results);
  box.appendChild(footer);
  ov.appendChild(box);
  document.body.appendChild(ov);
  window.VeloExperience?.bindSearchHome?.(results);
  setTimeout(() => inp.focus(), 50);
}

function _closeGSearch() {
  document.getElementById('gsearch-ov')?.remove();
  _gSearchOpen = false;
  _gSearchIndex = -1;
}

let _gSearchSeq = 0;
let _gSearchIndex = -1;
function _moveGSearch(delta) {
  const items = [...document.querySelectorAll('#gsearch-results [data-gsearch-item]')];
  if (!items.length) return;
  _gSearchIndex = (_gSearchIndex + delta + items.length) % items.length;
  items.forEach((item,index) => item.classList.toggle('active',index === _gSearchIndex));
  items[_gSearchIndex].scrollIntoView({ block:'nearest' });
}
async function _runGSearch(q, resultsEl) {
  if (!q || q.trim().length < 2) {
    ++_gSearchSeq;
    _gSearchIndex = -1;
    resultsEl.innerHTML = window.VeloExperience?.searchHome?.() || `<div class="ux-search-empty">Empieza a escribir para buscar en todo el sistema</div>`;
    window.VeloExperience?.bindSearchHome?.(resultsEl);
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
    matchDigits(c.rnc, qDigits) ||
    matchText(c.trade_name, qNorm) ||
    (c.contacts || []).some(contact =>
      matchText(contact.name, qNorm) || matchText(contact.role, qNorm) ||
      matchDigits(contact.phone, qDigits) || matchDigits(contact.document, qDigits)
    )
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
    _gSearchIndex = -1;
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
        <div class="ux-search-result" data-gsearch-item tabindex="-1" onclick="closeModal&&closeModal();_closeGSearch();routeTo('inventario');setTimeout(()=>openProductoModal(DB.products.find(x=>x.id===${p.id})),300)"
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
        <div class="ux-search-result" data-gsearch-item tabindex="-1" onclick="_closeGSearch();_openVentaGlobal(${s.id})"
             style="padding:10px 16px;cursor:pointer;display:flex;justify-content:space-between;
                    align-items:center"
             onmouseenter="this.style.background='var(--surface2)'"
             onmouseleave="this.style.background=''">
          <div>
            <div style="font-weight:600;font-size:13px">
              ${_escHtml(typeof facturaLabel === 'function' ? facturaLabel(s) : (s.numero_factura_fmt ? '#'+s.numero_factura_fmt : '#'+String(s.id).padStart(5,'0')))} · ${_escHtml(s.customer_name||'Consumidor Final')}
            </div>
            <div style="font-size:11px;color:var(--muted)">
              ${typeof fdate==='function'?fdate(fecha):fecha}
              ${s.ncf?`<span style="color:var(--muted2);margin-left:4px">NCF: ${_escHtml(s.ncf)}</span>`:''}
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
      const matchedContact = (c.contacts || []).find(contact =>
        matchText(contact.name, qNorm) || matchText(contact.role, qNorm) ||
        matchDigits(contact.phone, qDigits) || matchDigits(contact.document, qDigits));
      sections.push(`
        <div class="ux-search-result" data-gsearch-item tabindex="-1" onclick="_closeGSearch();routeTo('clientes');setTimeout(()=>openEstadoCuentaModal&&openEstadoCuentaModal(DB.customers.find(x=>x.id===${c.id})),300)"
             style="padding:10px 16px;cursor:pointer;display:flex;justify-content:space-between;
                    align-items:center"
             onmouseenter="this.style.background='var(--surface2)'"
             onmouseleave="this.style.background=''">
          <div>
            <div style="font-weight:600;font-size:13px">${_escHtml(c.name)}</div>
            <div style="font-size:11px;color:var(--muted)">${matchedContact ? `${_escHtml(matchedContact.name)}${matchedContact.role ? ' · '+_escHtml(matchedContact.role) : ''} · ` : ''}${_escHtml(c.phone||'')} ${c.rnc?'· '+_escHtml(c.rnc):''}</div>
          </div>
          ${c.balance>0?`<div style="font-weight:700;color:var(--red);flex-shrink:0;margin-left:12px">
            ${typeof fmt==='function'?fmt(c.balance):c.balance}</div>`:''}
        </div>`);
    });
  }

  _gSearchIndex = -1;
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
