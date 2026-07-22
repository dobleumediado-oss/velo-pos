// ══════════════════════════════════════════════
// superadmin.js — Panel de Super Administrador
// Solo accesible con rol superadmin
// Contiene: renderSuperAdmin y todas sus funciones
// Separado de app.js para mantenibilidad
// ══════════════════════════════════════════════

async function renderSuperAdmin(el) {
  if (user?.role !== 'superadmin') {
    routeTo('dash'); return;
  }

  el.innerHTML = '';
  el.style.overflowY = 'auto';
  el.style.paddingBottom = '60px';

  // Cargar datos primero
  const licResult  = await window.api.license.getStatus().catch(() => ({ ok: false }));
  const lic        = licResult.ok ? licResult.data : null;
  const vInfo      = await window.api.version.getInfo().catch(() => ({ ok: false }));
  const info       = vInfo.ok ? vInfo.data : {};
  const machineId  = lic?.machineId || '';
  const settings   = await window.api.settings.getAll().catch(() => ({}));
  const _saEsc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, '⚡ Panel de Desarrollador'),
      h('div', { class: 'sec-sub' }, 'Acceso exclusivo — no visible para clientes')
    )
  ));

  // ── Contraseña de esta instalación ─────────
  const superPassResult = await window.api.auth.getSuperPass({ requestUserId: user.id }).catch(() => ({ ok: false }));
  const spPass = superPassResult.ok ? superPassResult.pass : '—';
  const spHost = superPassResult.ok ? superPassResult.hostname : '';
  const spCpu  = superPassResult.ok ? (superPassResult.cpu || '').slice(0, 40) : '';

  const superPassCard = h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('div', { class: 'card-title mb8' }, '🔑 Acceso Superadmin — Esta Instalación'),
    h('div', { style: 'font-size:12px;color:var(--muted2);margin-bottom:12px' },
      'Credenciales únicas derivadas del hardware de esta PC — solo tú debes ver esta pantalla'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px' },
      h('div', { style: 'background:var(--surface2);border-radius:8px;padding:12px' },
        h('div', { style: 'font-size:10px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px' }, 'Email'),
        h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          h('span', { style: 'font-family:var(--mono);font-size:13px;font-weight:700;color:var(--ink)' }, 'dev@sistema.do'),
          h('button', {
            style: 'border:none;background:var(--surface);cursor:pointer;color:var(--muted2);font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--line)',
            onclick: () => { navigator.clipboard.writeText('dev@sistema.do'); toast('Copiado', 'ok'); }
          }, 'Copiar')
        )
      ),
      h('div', { style: 'background:var(--surface2);border-radius:8px;padding:12px' },
        h('div', { style: 'font-size:10px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px' }, 'Contraseña'),
        h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          h('span', { style: 'font-family:var(--mono);font-size:15px;font-weight:800;color:var(--green);letter-spacing:.05em' }, spPass),
          superPassResult.ok
            ? h('button', {
                style: 'border:none;background:var(--surface);cursor:pointer;color:var(--muted2);font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--line)',
                onclick: () => { navigator.clipboard.writeText(spPass); toast('Contraseña copiada', 'ok'); }
              }, 'Copiar')
            : null
        )
      )
    ),
    superPassResult.ok
      ? h('div', { style: 'font-size:11px;color:var(--muted2);background:var(--surface2);border-radius:8px;padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px' },
          h('div', null, h('strong', null, 'Host: '), spHost),
          h('div', null, h('strong', null, 'CPU: '),  spCpu)
        )
      : null,
    h('div', { class: 'alrt a', style: 'margin-bottom:0' },
      h('div', { class: 'alrt-dot a' }),
      h('div', { style: 'font-size:11px' },
        'Contraseña ',
        h('strong', null, 'única para esta PC'),
        '. Cambia si el cliente cambia de equipo. No compartir esta pantalla.'
      )
    )
  );
  el.appendChild(superPassCard);

  // ── Contraseña de modo local (terminales cliente) ────────────────────────────
  // Protege el botón "Volver a modo local" de la pantalla de recuperación de las
  // terminales cliente: sin esta contraseña, un cajero podía desconectar la
  // terminal del servidor con un toque accidental. Se genera AQUÍ (PC servidor);
  // cada terminal cliente cachea el hash al conectarse y la exige aun sin red.
  const lgCard = h('div', { class: 'card', style: 'margin-bottom:16px' });
  const _lgRender = (state) => {
    lgCard.innerHTML = '';
    lgCard.appendChild(h('div', { class: 'card-title mb8' }, '🛡 Contraseña de Modo Local — Terminales Cliente'));
    lgCard.appendChild(h('div', { style: 'font-size:12px;color:var(--muted2);margin-bottom:12px' },
      'Protege el botón "Volver a modo local" en las PCs cliente cuando el servidor está apagado. ',
      'Cada terminal la cachea al conectarse, así que funciona aunque no haya red. ',
      'Genérala en la PC servidor y guárdala tú — no se vuelve a mostrar.'));

    if (state.error) {
      lgCard.appendChild(h('div', { class: 'alrt a' }, h('div', { class: 'alrt-dot a' }),
        h('div', { style: 'font-size:11px' }, state.error === 'FORBIDDEN' || /servidor/i.test(state.error)
          ? 'Esta gestión solo está disponible en la PC servidor (o en modo local).'
          : state.error)));
      return;
    }

    if (state.password) {
      lgCard.appendChild(h('div', { style: 'background:var(--surface2);border-radius:8px;padding:12px;margin-bottom:12px' },
        h('div', { style: 'font-size:10px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px' }, 'Contraseña generada — cópiala AHORA'),
        h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
          h('span', { style: 'font-family:var(--mono);font-size:18px;font-weight:800;color:var(--green);letter-spacing:.08em' }, state.password),
          h('button', { class: 'btn-ghost', style: 'font-size:11px;padding:3px 10px',
            onclick: () => { navigator.clipboard.writeText(state.password); toast('Contraseña copiada', 'ok'); } }, 'Copiar')),
        h('div', { style: 'font-size:11px;color:var(--muted2);margin-top:8px' },
          'Las terminales cliente la recibirán (solo el hash) en su próxima conexión al servidor.')));
    }

    lgCard.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      h('span', { style: `font-size:12px;font-weight:600;color:${state.configured ? 'var(--green)' : 'var(--muted2)'}` },
        state.configured ? '● Protección activa' : '○ Sin protección configurada'),
      h('button', { class: 'btn', style: 'font-size:12px', onclick: async () => {
        if (state.configured && !confirm('Ya hay una contraseña activa. ¿Generar una nueva? La anterior dejará de funcionar.')) return;
        const r = await window.api.connection.generateLocalPassword({ requestUserId: user.id });
        if (r?.ok) _lgRender({ configured: true, password: r.password });
        else toast(r?.error || 'No se pudo generar', 'err');
      } }, state.configured ? 'Regenerar contraseña' : 'Generar contraseña'),
      state.configured
        ? h('button', { class: 'btn-ghost', style: 'font-size:12px;color:var(--red)', onclick: async () => {
            if (!confirm('¿Quitar la protección? El botón "Volver a modo local" quedará sin contraseña en las terminales.')) return;
            const r = await window.api.connection.generateLocalPassword({ requestUserId: user.id, remove: true });
            if (r?.ok) _lgRender({ configured: false });
            else toast(r?.error || 'No se pudo quitar', 'err');
          } }, 'Quitar protección')
        : null));
  };
  try {
    const lgStatus = await window.api.connection.localGuardStatus({ requestUserId: user.id });
    if (lgStatus?.ok) _lgRender({ configured: !!lgStatus.configured });
    else _lgRender({ error: lgStatus?.error || 'No disponible' });
  } catch (e) {
    // En modo cliente este canal se reenvía y el servidor lo deniega (gestión
    // solo en la PC servidor) → mostrar la pista en vez del error crudo.
    _lgRender({ error: e?.message || 'No disponible' });
  }
  el.appendChild(lgCard);

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
        <textarea class="inp" id="lic-key-out" readonly rows="3"
               style="font-family:var(--mono);font-size:11px;flex:1;resize:none;word-break:break-all"></textarea>
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


  // ── Módulos activables + permisos por rol ──────────────────────────────
  const modsCard = document.createElement('div');
  modsCard.className = 'card';
  modsCard.style.marginBottom = '16px';

  const modsDefs = [
    // Módulos financieros
    { key: 'fiscal_enabled',       icon: '📄', title: 'Módulo Fiscal NCF/DGII',       desc: 'Activa NCF, ITBIS 18% y comprobantes fiscales.',          cajeroCan: false, special: 'fiscal' },
    { key: 'module_gastos',        icon: '💰', title: 'Gastos y Egresos',               desc: 'Registro de gastos, categorías y reportes de egresos.',  cajeroCan: true  },
    { key: 'module_contabilidad',  icon: '📒', title: 'Contabilidad y Bancos',          desc: 'Bancos, catálogo de cuentas, asientos y reportes.',       cajeroCan: false },
    { key: 'module_vendedores',    icon: '🧑‍💼', title: 'Vendedores + Nómina', desc: 'Activa dos áreas conectadas: operación comercial y liquidaciones financieras.', cajeroCan: false },
    // Módulos operativos
    { key: 'barcode_enabled',      icon: '🏷️', title: 'Etiquetas / Código de Barras',  desc: 'Diseñador e impresión de etiquetas con códigos de barras.', cajeroCan: true, special: 'barcode' },
    { key: 'module_preventa',      icon: '🧾', title: 'Preventa y Despacho',             desc: 'Prepara órdenes, reserva inventario y las envía a caja para su cobro y entrega.', cajeroCan: true },
    { key: 'module_sucursales',    icon: '🏪', title: 'Sucursales',                     desc: 'Registro de sucursales (sync en Cloud 2026).',            cajeroCan: true  },
    { key: 'module_vehiculos',     icon: '🚗', title: 'Vehículos',                      desc: 'Registro de vehículos de la empresa.',                    cajeroCan: true  },
    { key: 'module_mantenimiento', icon: '🔧', title: 'Mantenimiento',                  desc: 'Historial de mantenimiento de vehículos.',                cajeroCan: true  },
    { key: 'module_envios',        icon: '📦', title: 'Envíos y Despachos',             desc: 'Control de entregas con cálculo de distancia.',           cajeroCan: true  },
    { key: 'module_conduce',       icon: '🚚', title: 'Conduces / Notas de Entrega',    desc: 'Documento de entrega de mercancía. No fiscal (sin NCF/ITBIS).', cajeroCan: true  },
    { key: 'module_ncf_avanzado',  icon: '📋', title: 'NCF Avanzado',                   desc: 'Gestión de rangos de comprobantes fiscales DGII.',        cajeroCan: false },
    // Módulos avanzados
    { key: 'module_multi_negocio', icon: '🏢', title: 'Multi-negocios',                 desc: 'Múltiples empresas con base de datos separada.',          cajeroCan: false },
  ];

  // Encabezado de la card
  const modsHdr = document.createElement('div');
  modsHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
  modsHdr.innerHTML = `
    <div class="card-title" style="margin-bottom:0">⚙️ Módulos del sistema</div>
    <div style="display:flex;gap:8px;align-items:center">
      <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted2)">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block"></span>Admin
      </span>
      <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted2)">
        <span style="width:8px;height:8px;border-radius:50%;background:#818cf8;display:inline-block"></span>Superadmin <em style="font-style:normal;font-size:10px">(fijo)</em>
      </span>
      <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted2)">
        <span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block"></span>Cajero
      </span>
    </div>`;
  modsCard.appendChild(modsHdr);

  const subHdr = document.createElement('div');
  subHdr.style.cssText = 'font-size:11px;color:var(--muted2);margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--line2)';
  subHdr.textContent = 'Activa cada módulo y configura qué roles pueden acceder. Superadmin siempre tiene acceso total.';
  modsCard.appendChild(subHdr);

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00d48a';

  modsDefs.forEach(mod => {
    const enabled     = settings[mod.key] === '1' || settings[mod.key] === true || settings[mod.key] === 1;
    const rolesVal    = settings[mod.key + '_roles'] || (['module_envios','module_preventa'].includes(mod.key) ? 'admin,cajero' : 'admin');
    const adminOn     = rolesVal.includes('admin');
    const cajeroOn    = rolesVal.includes('cajero');

    const wrapper = document.createElement('div');
    wrapper.dataset.modKey = mod.key;
    wrapper.style.cssText = 'border-bottom:0.5px solid var(--line2);padding:14px 0';

    // ── Fila principal: info + toggle ──
    const mainRow = document.createElement('div');
    mainRow.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px';

    // Info izquierda
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'flex:1;min-width:0';
    infoDiv.innerHTML = `
      <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:2px">${mod.icon} ${mod.title}</div>
      <div style="font-size:11px;color:var(--muted2);line-height:1.4">${mod.desc}</div>`;

    // Toggle derecha
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;flex-shrink:0;margin-top:2px';

    const trackWrap = document.createElement('div');
    trackWrap.style.cssText = 'position:relative;width:44px;height:24px';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.dataset.mod = mod.key;
    input.style.cssText = 'opacity:0;position:absolute;width:100%;height:100%;cursor:pointer;z-index:1;margin:0';
    input.addEventListener('change', function() { saToggleModule(this.dataset.mod, this.checked); });

    const track = document.createElement('div');
    track.className = 'toggle-track';
    track.style.cssText = `position:absolute;inset:0;border-radius:12px;background:${enabled ? accentColor : '#9ca3af'};transition:background .2s`;

    const thumb = document.createElement('div');
    thumb.className = 'toggle-thumb';
    thumb.style.cssText = `position:absolute;top:2px;left:${enabled ? '22px' : '2px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px #0003`;

    const span = document.createElement('span');
    span.style.cssText = `font-size:11px;font-weight:600;min-width:40px;color:${enabled ? accentColor : '#9ca3af'}`;
    span.textContent = enabled ? 'Activo' : 'Inactivo';

    trackWrap.appendChild(input);
    trackWrap.appendChild(track);
    trackWrap.appendChild(thumb);
    label.appendChild(trackWrap);
    label.appendChild(span);

    mainRow.appendChild(infoDiv);
    mainRow.appendChild(label);
    wrapper.appendChild(mainRow);

    // ── Fila de roles (siempre visible) ──
    const rolesRow = document.createElement('div');
    rolesRow.className = `mod-roles-${mod.key}`;
    rolesRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap';

    rolesRow.innerHTML = `<span style="font-size:10px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.05em">Acceso:</span>`;

    // ── Chip Admin — clickeable ──
    const adminChip = document.createElement('button');
    adminChip.dataset.modRoleKey = mod.key;
    adminChip.dataset.role = 'admin';
    adminChip.dataset.roleActive = adminOn ? '1' : '0';
    _saStyleAdminChip(adminChip, adminOn);
    adminChip.addEventListener('click', async function() {
      const nowOn  = this.dataset.roleActive === '1';
      const newOn  = !nowOn;
      const modKey = this.dataset.modRoleKey;
      const cur    = (typeof CFG !== 'undefined' && CFG[modKey + '_roles']) || rolesVal;
      const newRoles = _saToggleRole(cur, 'admin', newOn);
      await window.api.settings.set({ key: modKey + '_roles', value: newRoles, requestUserId: window._currentUser?.id });
      if (typeof CFG !== 'undefined') CFG[modKey + '_roles'] = newRoles;
      this.dataset.roleActive = newOn ? '1' : '0';
      _saStyleAdminChip(this, newOn);
      if (typeof buildSidebar === 'function') buildSidebar();
      toast(`Admin ${newOn ? 'puede' : 'ya no puede'} ver ${modKey.replace('module_','').replace(/_/g,' ')}`, newOn ? 's' : 'w');
    });
    rolesRow.appendChild(adminChip);

    // ── Superadmin chip — fijo, no editable ──
    const saChip = document.createElement('span');
    saChip.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
      font-size:11px;font-weight:600;background:rgba(99,102,241,.1);color:#818cf8;
      border:1px solid rgba(99,102,241,.2);cursor:default;user-select:none`;
    saChip.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4"/></svg> Superadmin ✓`;
    saChip.title = 'El superadmin siempre tiene acceso total';
    rolesRow.appendChild(saChip);

    // ── Chip Cajero — siempre editable ──
    const cajeroChip = document.createElement('button');
    cajeroChip.dataset.modRoleKey = mod.key;
    cajeroChip.dataset.role = 'cajero';
    cajeroChip.dataset.roleActive = cajeroOn ? '1' : '0';
    _saStyleCajeroChip(cajeroChip, cajeroOn);
    cajeroChip.addEventListener('click', async function() {
      const nowOn  = this.dataset.roleActive === '1';
      const newOn  = !nowOn;
      const modKey = this.dataset.modRoleKey;
      const cur    = (typeof CFG !== 'undefined' && CFG[modKey + '_roles']) || rolesVal;
      const newRoles = _saToggleRole(cur, 'cajero', newOn);
      await window.api.settings.set({ key: modKey + '_roles', value: newRoles, requestUserId: window._currentUser?.id });
      if (typeof CFG !== 'undefined') CFG[modKey + '_roles'] = newRoles;
      this.dataset.roleActive = newOn ? '1' : '0';
      _saStyleCajeroChip(this, newOn);
      if (typeof buildSidebar === 'function') buildSidebar();
      toast(`Cajero ${newOn ? 'puede' : 'ya no puede'} ver ${modKey.replace('module_','').replace(/_/g,' ')}`, newOn ? 's' : 'w');
    });
    rolesRow.appendChild(cajeroChip);

    wrapper.appendChild(rolesRow);

    if (mod.key === 'module_preventa') {
      const extra = document.createElement('div');
      extra.style.cssText = 'display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:10px;padding:10px 12px;border-radius:9px;background:var(--surface2);font-size:11px;color:var(--muted)';
      const reservation = Number(settings.checkout_reservation_minutes) || 30;
      const soundEnabled = settings.checkout_notifications_sound !== '0';
      extra.innerHTML = `
        <label style="display:flex;align-items:center;gap:7px;font-weight:600;color:var(--ink3)">
          Reserva de inventario
          <select class="inp" data-pv-setting="reservation" style="width:100px;padding:5px 7px;font-size:11px">
            ${[10,15,20,30,45,60,90,120].map(minutes => `<option value="${minutes}" ${minutes===reservation?'selected':''}>${minutes} min</option>`).join('')}
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:7px;font-weight:600;color:var(--ink3);cursor:pointer">
          <input type="checkbox" data-pv-setting="sound" ${soundEnabled?'checked':''} style="accent-color:var(--green)"/>
          Avisos sonoros en tiempo real
        </label>`;
      extra.querySelector('[data-pv-setting="reservation"]')?.addEventListener('change', async event => {
        const value = String(Math.max(10, Math.min(120, Number(event.target.value) || 30)));
        const result = await window.api.settings.set({ key: 'checkout_reservation_minutes', value, requestUserId: window._currentUser?.id });
        if (!result?.ok) return toast(result?.error || 'No se pudo guardar el tiempo de reserva', 'err');
        DB.settings.checkout_reservation_minutes = value;
        toast(`Reserva de inventario: ${value} minutos`, 's');
      });
      extra.querySelector('[data-pv-setting="sound"]')?.addEventListener('change', async event => {
        const value = event.target.checked ? '1' : '0';
        const result = await window.api.settings.set({ key: 'checkout_notifications_sound', value, requestUserId: window._currentUser?.id });
        if (!result?.ok) {
          event.target.checked = !event.target.checked;
          return toast(result?.error || 'No se pudo guardar el aviso sonoro', 'err');
        }
        DB.settings.checkout_notifications_sound = value;
        toast(event.target.checked ? 'Avisos sonoros activados' : 'Avisos sonoros silenciados', 's');
      });
      wrapper.appendChild(extra);
    }
    modsCard.appendChild(wrapper);
  });

  el.appendChild(modsCard);

  // ── Panel Multi-negocios ──────────────────────────────────────────────────
  const multiEnabled = settings.module_multi_negocio === '1';
  if (multiEnabled) {
    const isClientMode = settings.connection_mode === 'client';
    const multiCard = document.createElement('div');
    multiCard.className = 'card';
    multiCard.style.marginBottom = '16px';
    multiCard.innerHTML = `
      <div class="card-title" style="margin-bottom:12px">🏢 Multi-negocios</div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:14px">
        Cada negocio tiene su propia base de datos. Crea y administra los negocios aquí;
        ${isClientMode
          ? 'desde el login puedes pedir al servidor que abra otro negocio.'
          : 'para entrar a otro negocio, selecciónalo desde el login.'}
      </div>
      <div id="sa-biz-list" style="margin-bottom:12px">
        <div style="font-size:12px;color:var(--muted2)">Cargando negocios...</div>
      </div>
      <button class="btn btn-dark btn-sm" id="btn-nuevo-negocio">+ Crear nuevo negocio</button>`;
    el.appendChild(multiCard);

    // Cargar negocios existentes
    Promise.all([
      window.api.business?.getAll?.().catch(() => null),
      window.api.business?.getActive?.().catch(() => null),
    ]).then(([res, activeRes]) => {
      const list = multiCard.querySelector('#sa-biz-list');
      const businesses = res?.data || [];
      const activeId = activeRes?.data?.id || '';
      const row = (b) => {
        const isPrincipal = !b.id;
        const isActive = isPrincipal ? !activeId : activeId === b.id;
        const label = isPrincipal ? 'Negocio Principal' : _saEsc(b.name || b.id);
        const sub = isPrincipal ? 'Base de datos original' : `ID: ${_saEsc(b.id)}`;
        const btn = isActive
          ? `<span style="font-size:11px;color:var(--green);font-weight:700">Activo</span>`
          : `<span style="font-size:11px;color:var(--muted2);font-weight:700">Disponible en login</span>`;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:var(--bg2);border-radius:8px;margin-bottom:6px;font-size:13px;border:0.5px solid var(--line2)">
            <div style="min-width:0">
              🏢 <strong>${label}</strong>
              <div style="font-size:10px;color:var(--muted2);margin-top:2px">${sub}</div>
            </div>
            ${btn}
          </div>`;
      };

      list.innerHTML = [
        row({ id: '', name: 'Negocio Principal' }),
        ...businesses.map(row),
        !businesses.length
          ? '<div style="font-size:12px;color:var(--muted2);margin-top:6px">No hay negocios secundarios creados.</div>'
          : ''
      ].join('');
    });

    multiCard.querySelector('#btn-nuevo-negocio')?.addEventListener('click', () => {
      // Modal para crear negocio
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
      overlay.innerHTML = `
        <div style="background:var(--bg);border-radius:14px;width:100%;max-width:400px;padding:24px;box-shadow:0 8px 40px #0004">
          <div style="font-size:16px;font-weight:600;margin-bottom:16px">🏢 Crear nuevo negocio</div>
          <div class="fg" style="margin-bottom:12px">
            <label class="lbl">Nombre del negocio *</label>
            <input class="inp" id="new-biz-name" placeholder="Ej: Taller García Herramientas" autofocus>
          </div>
          <div class="fg" style="margin-bottom:16px">
            <label class="lbl">Descripción (opcional)</label>
            <input class="inp" id="new-biz-desc" placeholder="Ej: Venta de herramientas y equipos">
          </div>
          <div style="font-size:11px;color:var(--muted2);margin-bottom:16px;padding:8px 12px;background:var(--bg2);border-radius:8px">
            ⚡ Este negocio tendrá su propia base de datos separada. Aparecerá como opción en el selector del login.
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-ghost" id="new-biz-cancel">Cancelar</button>
            <button class="btn btn-dark" id="new-biz-confirm">Crear negocio</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#new-biz-cancel').onclick = () => overlay.remove();
      overlay.querySelector('#new-biz-confirm').onclick = async () => {
        const name = overlay.querySelector('#new-biz-name').value.trim();
        const desc = overlay.querySelector('#new-biz-desc').value.trim();
        if (!name) { overlay.querySelector('#new-biz-name').style.border='1px solid var(--red)'; return; }
        const btn = overlay.querySelector('#new-biz-confirm');
        btn.disabled = true; btn.textContent = 'Creando...';
        const res = await window.api.business.create({ name, description: desc, requestUserId: user.id });
        if (res.ok) {
          overlay.remove();
          if (typeof toast === 'function') toast(`✓ Negocio "${name}" creado — disponible en el login`);
          renderSuperAdmin(el);
        } else {
          btn.disabled = false; btn.textContent = 'Crear negocio';
          alert('Error: ' + res.error);
        }
      };
      setTimeout(() => overlay.querySelector('#new-biz-name')?.focus(), 100);
    });
  }

  // ── Módulo de Etiquetas de Código de Barras ──
  const bcModCard = h('div', { class: 'card', style: 'margin-bottom:16px' });

  // Leer estado actual del módulo
  const bcEnabled = (settings.barcode_enabled === '1' || settings.barcode_enabled === true);

  bcModCard.innerHTML = `
    <div class="fxb mb8">
      <div>
        <div class="card-title">🏷 Módulo de Etiquetas de Código de Barras</div>
        <div style="font-size:12px;color:var(--muted2);margin-top:2px">
          Activa el módulo para que el administrador pueda crear e imprimir etiquetas
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600">
        <div style="position:relative;width:44px;height:24px">
          <input type="checkbox" id="sa-bc-enabled" ${bcEnabled ? 'checked' : ''}
                 onchange="saToggleBarcodeModule(this.checked)"
                 style="opacity:0;position:absolute;width:100%;height:100%;cursor:pointer;z-index:1;margin:0"/>
          <div id="sa-bc-track" style="
            width:44px;height:24px;border-radius:12px;
            background:${bcEnabled ? 'var(--green)' : 'var(--line)'};
            transition:background .2s;position:relative
          ">
            <div style="
              position:absolute;top:3px;
              left:${bcEnabled ? '23px' : '3px'};
              width:18px;height:18px;border-radius:50%;background:#fff;
              box-shadow:0 1px 4px rgba(0,0,0,.25);transition:left .2s;
              pointer-events:none
            " id="sa-bc-thumb"></div>
          </div>
        </div>
        <span style="color:${bcEnabled ? 'var(--green)' : 'var(--muted)'}" id="sa-bc-label">
          ${bcEnabled ? 'Activo' : 'Inactivo'}
        </span>
      </label>
    </div>

    ${bcEnabled ? `
    <div class="alrt g" style="margin-bottom:12px">
      <div class="alrt-dot g"></div>
      <div>
        <div class="alrt-title">Módulo activo — el admin lo ve en el sidebar</div>
        <div class="alrt-sub">
          Impresoras compatibles: Zebra, Honeywell, TSC, SATO, Bixolon, Brother, DYMO, Argox, Godex y cualquier impresora del sistema.
        </div>
      </div>
    </div>` : `
    <div class="alrt n" style="margin-bottom:12px">
      <div class="alrt-dot n"></div>
      <div>
        <div class="alrt-title">Módulo inactivo</div>
        <div class="alrt-sub">Actívalo para que aparezca "Etiquetas" en el sidebar del administrador.</div>
      </div>
    </div>`}
  `;

  // Contenedor del diseñador (se agrega solo si módulo está activo)
  const bcDesignerContainer = h('div', { id: 'bc-designer-container',
    style: `display:${bcEnabled ? 'block' : 'none'};margin-top:12px;padding-top:12px;border-top:1px solid var(--line)` });
  bcModCard.appendChild(bcDesignerContainer);

  el.appendChild(bcModCard);

  // Renderizar diseñador si ya está activo
  if (bcEnabled && typeof renderBarcodeDesigner === 'function') {
    renderBarcodeDesigner(bcDesignerContainer);
  }

  // ── Plantillas de impresión (diagnóstico) ────
  const plantDiagCard = h('div', { class: 'card' });
  const printerNow    = DB?.settings?.printer || CFG?.printer || '';
  const printerTypeNow = typeof detectPrinterType === 'function'
    ? detectPrinterType(printerNow) : 'unknown';
  const tipoActual    = printerTypeNow === 'carta' ? 'carta'
    : printerTypeNow === '58mm' ? '58mm'
    : printerTypeNow === '72mm' ? '72mm' : '80mm';
  const plantActualId = DB?.settings?.print_template || '';
  const todasPlantillas = typeof PLANTILLAS !== 'undefined' ? PLANTILLAS : [];

  const tipoColor = printerTypeNow === 'carta'  ? 'var(--amber)' :
                    printerTypeNow === '58mm'    ? 'var(--green)'  :
                    printerTypeNow === '72mm'    ? 'var(--green)'  :
                    printerTypeNow === '108mm'   ? 'var(--green)'  :
                    printerTypeNow === '80mm'    ? 'var(--green)'  : 'var(--muted)';
  const tipoLabel = printerTypeNow === 'carta'  ? '📄 Carta / A4' :
                    printerTypeNow === '58mm'    ? '🧾 Térmica 58mm' :
                    printerTypeNow === '72mm'    ? '🧾 Térmica 72mm' :
                    printerTypeNow === '108mm'   ? '🏷 Etiquetas 108mm' :
                    printerTypeNow === '80mm'    ? '🧾 Térmica 80mm' : 'Ancho personalizado';

  // Tipo de la plantilla actualmente activa
  const plantActivaObj   = todasPlantillas.find(p => p.id === plantActualId);
  const tipoPlantActiva  = plantActivaObj?.tipo || '80mm';
  // ¿La plantilla activa coincide con el tipo de impresora detectado?
  const hayConflicto = plantActualId && plantActivaObj && tipoPlantActiva !== tipoActual
                       && printerTypeNow !== 'unknown';

  plantDiagCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">🖨 Diagnóstico de Plantillas</div>
      <span style="font-size:11px;padding:3px 8px;border-radius:100px;
                   background:var(--bg2);color:${tipoColor};font-weight:700">
        ${tipoLabel}
      </span>
    </div>

    ${hayConflicto ? `
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;
                padding:8px 12px;margin-bottom:10px;font-size:12px">
      ⚠ La plantilla activa (<strong>${plantActivaObj?.nombre}</strong>) es de tipo
      <strong>${tipoPlantActiva}</strong> pero la impresora detectada es
      <strong>${tipoActual}</strong>. El cliente verá las plantillas ${tipoActual}
      en Configuración pero se imprimirá con la activa actual.
    </div>` : ''}

    <div style="font-size:12px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line2)">
        <span style="color:var(--muted)">Impresora guardada</span>
        <span style="font-weight:600;color:${printerNow ? 'var(--ink)' : 'var(--red)'}">${printerNow || 'Sin configurar'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line2)">
        <span style="color:var(--muted)">Tipo detectado</span>
        <span style="font-weight:600;color:${tipoColor}">${tipoLabel}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line2)">
        <span style="color:var(--muted)">Plantillas visibles al cliente</span>
        <span style="font-weight:600">${tipoActual === 'carta' ? '📄 Carta / A4' : '🧾 Térmicas 80mm'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:5px 0">
        <span style="color:var(--muted)">Plantilla activa (ID)</span>
        <span id="sa-plant-active-id" style="font-family:var(--mono);font-size:11px;color:var(--green)">
          ${plantActualId || 'termica_80_clasica (default)'}
        </span>
      </div>
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;
                letter-spacing:.05em;margin-bottom:8px">Todas las plantillas disponibles</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${todasPlantillas.map(p => {
        const esActiva = p.id === plantActualId || (!plantActualId && p.id === 'termica_80_clasica');
        // Etiquetar tipo solo de forma informativa, sin confundir
        const tipoTag = p.tipo === 'carta' ? 'carta' : (p.tipo || '80mm');
        return `<div id="sa-plant-row-${p.id}"
                     style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                            border-radius:8px;transition:.15s;
                            background:${esActiva ? 'var(--green-bg, #f0fdf4)' : 'var(--bg2)'};
                            border:1px solid ${esActiva ? 'var(--green)' : 'var(--line2)'}">
          <span style="font-size:16px">${p.icono}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${p.nombre}
              <span class="sa-plant-badge" style="font-size:10px;color:var(--green);font-weight:700;
                    display:${esActiva ? 'inline' : 'none'}">✓ ACTIVA</span>
              <span style="font-size:10px;color:var(--muted);font-weight:400;
                    background:var(--bg2);padding:1px 6px;border-radius:100px">${tipoTag}</span>
            </div>
            <div style="font-size:10px;color:var(--muted2);margin-top:2px">${p.id}</div>
          </div>
          <button class="sa-plant-btn" onclick="saActivarPlantilla('${p.id}')"
            style="font-size:11px;padding:4px 12px;border-radius:6px;cursor:pointer;white-space:nowrap;
                   border:1px solid ${esActiva ? 'var(--green)' : 'var(--line)'};
                   background:${esActiva ? 'var(--green)' : 'transparent'};
                   color:${esActiva ? '#fff' : 'var(--ink)'}">
            ${esActiva ? '✓ Activa' : 'Activar'}
          </button>
        </div>`;
      }).join('')}
    </div>`;
  el.appendChild(plantDiagCard);

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

  if (!machineId) {
    document.getElementById('lic-machine')?.focus();
    toast('Ingresa o copia el ID de máquina del cliente', 'err'); return;
  }
  if (!biz) {
    document.getElementById('lic-biz')?.focus();
    toast('Ingresa el nombre del negocio', 'err'); return;
  }
  if (type === 'perpetual') {
    expiry = 'PERPETUAL';
  } else if (!expiry) {
    toast('Selecciona la fecha de vencimiento', 'err'); return;
  }

  // Generar via IPC con ECDSA v2 (clave privada en main.js)
  const btn = document.querySelector('button[onclick="saGenerarLicencia()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Generando...'; }

  const result = await window.api.license.generate({ machineId, business: biz, expiry, requestUserId: user?.id });

  if (btn) { btn.disabled = false; btn.innerHTML = `${svg('check')} Generar clave de licencia`; }

  if (!result?.ok) {
    toast(result?.error || 'Error al generar licencia', 'err');
    if (result?.error?.includes('Clave privada')) {
      toast('La clave privada vendor-private.pem no está en este equipo', 'err');
    }
    return;
  }

  const licKey = result.licenseKey;
  document.getElementById('lic-key-out').value = licKey;
  document.getElementById('lic-result').style.display = 'block';
  toast(`✓ Licencia ${type === 'perpetual' ? 'Perpetua' : 'hasta ' + expiry} generada`);
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

  const btn = document.querySelector('.btn-red');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Reseteando...'; }

  try {
    // 1. Backup automático antes del reset
    toast('Creando backup de seguridad...', 'w');
    await window.api.backup.create({ requestUserId: user.id }).catch(() => {});

    // 2. Ejecutar el reset real
    const result = await window.api.business.resetData({ requestUserId: user.id });

    if (!result.ok) {
      toast(result.error || 'Error al resetear', 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Resetear todo'; }
      return;
    }

    // 3. Recargar la app desde cero
    toast('✓ Datos eliminados — recargando...', 'ok');
    closeModal();
    setTimeout(() => { location.reload(); }, 1500);

  } catch(e) {
    toast('Error inesperado: ' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Resetear todo'; }
  }
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
  const logs = await window.api.audit.getLogs({ limit: 50, action: 'error', requestUserId: user?.id }) || [];
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
// ROLE CHIP HELPER
// ══════════════════════════════════════════════

function _saToggleRole(rolesStr, role, enable) {
  const parts = (rolesStr || '').split(',').map(r => r.trim()).filter(Boolean);
  if (enable && !parts.includes(role)) parts.push(role);
  if (!enable) { const i = parts.indexOf(role); if (i > -1) parts.splice(i, 1); }
  return parts.join(',');
}

function _saStyleAdminChip(btn, active) {
  btn.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
    border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:none;
    background:${active ? 'rgba(0,212,138,.12)' : 'var(--surface2)'};
    color:${active ? 'var(--accent)' : 'var(--muted2)'};
    border:1px solid ${active ? 'rgba(0,212,138,.25)' : 'var(--line2)'};
    transition:all .15s`;
  btn.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style="opacity:${active?1:.4}"><circle cx="4" cy="4" r="4"/></svg> Admin ${active ? '✓' : '+ agregar'}`;
  btn.title = active ? 'Admin tiene acceso — clic para quitar' : 'Admin sin acceso — clic para dar acceso';
}

function _saStyleCajeroChip(btn, active) {
  btn.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
    border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:none;
    background:${active ? 'rgba(245,158,11,.15)' : 'var(--surface2)'};
    color:${active ? '#f59e0b' : 'var(--muted2)'};
    border:1px solid ${active ? 'rgba(245,158,11,.3)' : 'var(--line2)'};
    transition:all .15s`;
  btn.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style="opacity:${active?1:.4}"><circle cx="4" cy="4" r="4"/></svg> Cajero ${active ? '✓' : '+ agregar'}`;
  btn.title = active ? 'Cajero tiene acceso — clic para quitar' : 'Cajero sin acceso — clic para dar acceso';
}

// ══════════════════════════════════════════════
// TOGGLE MÓDULO DE ETIQUETAS
// ══════════════════════════════════════════════

async function saToggleModule(key, enabled) {
  const user = window._currentUser;
  if (!user || user.role !== 'superadmin') { alert('Solo el superadmin puede cambiar módulos'); return; }

  await window.api.settings.set({ key, value: enabled ? '1' : '0', requestUserId: user.id });

  // Actualizar CFG inmediatamente
  if (typeof CFG !== 'undefined') CFG[key] = enabled ? '1' : '0';

  // Actualizar visual del toggle
  const input = document.querySelector(`input[data-mod="${key}"]`);
  if (input) {
    input.checked = enabled;
    const wrap  = input.parentElement;
    const track = wrap?.querySelector('.toggle-track');
    const thumb = wrap?.querySelector('.toggle-thumb');
    const span  = wrap?.parentElement?.querySelector('span');
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00d48a';
    if (track) track.style.background = enabled ? accentColor : '#9ca3af';
    if (thumb) thumb.style.left = enabled ? '22px' : '2px';
    if (span)  { span.textContent = enabled ? 'Activo' : 'Inactivo'; span.style.color = enabled ? accentColor : '#9ca3af'; }
  }

  // Reglas de dependencia entre módulos
  if (key === 'module_mantenimiento' && enabled) {
    // Mantenimiento requiere Vehículos — activar automáticamente
    await window.api.settings.set({ key: 'module_vehiculos', value: '1', requestUserId: window._currentUser?.id });
    CFG.module_vehiculos = '1';
    // Actualizar visual del toggle de vehículos también
    const vInput = document.querySelector('input[data-mod="module_vehiculos"]');
    if (vInput) {
      vInput.checked = true;
      const vWrap  = vInput.parentElement;
      const vTrack = vWrap?.querySelector('.toggle-track');
      const vThumb = vWrap?.querySelector('.toggle-thumb');
      const vSpan  = vWrap?.parentElement?.querySelector('span');
      const ac = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00d48a';
      if (vTrack) vTrack.style.background = ac;
      if (vThumb) vThumb.style.left = '22px';
      if (vSpan)  { vSpan.textContent = 'Activo'; vSpan.style.color = ac; }
    }
  }

  // Recargar settings completos y reconstruir nav
  // IMPORTANTE: esperar loadAppData antes de buildSidebar para que CFG esté actualizado
  if (typeof loadAppData === 'function') {
    await loadAppData();
  }
  // CFG ya fue actualizado por loadAppData — ahora sí reconstruir el nav
  if (typeof buildSidebar === 'function') buildSidebar();
  if (typeof buildTopbar  === 'function') buildTopbar();
  if (key === 'module_preventa' && typeof preventaConfigureMonitor === 'function') {
    preventaConfigureMonitor();
    if (!enabled && typeof page !== 'undefined' && page === 'preventa' && typeof routeTo === 'function') routeTo('dash');
  }

  if (typeof toast === 'function') toast(`${enabled ? '✓ Módulo activado' : '✗ Módulo desactivado'}: ${key.replace('module_','').replace(/_/g,' ')}`);

  // ── Lógica especial por módulo ──────────────────────────────────────────
  // fiscal_enabled: actualizar CFG.fiscalEnabled e ITBIS
  if (key === 'fiscal_enabled') {
    CFG.fiscalEnabled = enabled;
    CFG.itbis = parseFloat(DB?.settings?.tax_pct) || 18;
  }

  // barcode_enabled: actualizar flag global y sidebar
  if (key === 'barcode_enabled') {
    window._bcEnabled = enabled;
    // Mostrar/ocultar diseñador si está visible en la misma página
    const designer = document.getElementById('bc-designer-container');
    if (designer) {
      designer.style.display = enabled ? 'block' : 'none';
      if (enabled && !designer.children.length && typeof renderBarcodeDesigner === 'function') {
        renderBarcodeDesigner(designer);
      }
    }
  }

  // module_multi_negocio: requiere reinicio
  if (key === 'module_multi_negocio' && enabled) {
    setTimeout(() => alert('⚠️ El módulo Multi-negocios requiere reiniciar Velo POS para activarse completamente.'), 500);
  }
}

async function saToggleBarcodeModule(enabled) {
  // Actualizar setting
  await window.api.settings.set({ key: 'barcode_enabled', value: enabled ? '1' : '0', requestUserId: window._currentUser?.id });

  // Actualizar flag global
  window._bcEnabled = enabled;

  // Actualizar sidebar
  buildSidebar();

  // Actualizar la UI del toggle sin recargar todo el panel
  const track = document.getElementById('sa-bc-track');
  const thumb = document.getElementById('sa-bc-thumb');
  const label = document.getElementById('sa-bc-label');
  if (track) track.style.background = enabled ? 'var(--green)' : 'var(--line)';
  if (thumb) thumb.style.left = enabled ? '23px' : '3px';
  if (label) {
    label.textContent = enabled ? 'Activo' : 'Inactivo';
    label.style.color = enabled ? 'var(--green)' : 'var(--muted)';
  }

  // Mostrar/ocultar el diseñador
  const designer = document.getElementById('bc-designer-container');
  if (designer) {
    designer.style.display = enabled ? 'block' : 'none';
    if (enabled && !designer.children.length && typeof renderBarcodeDesigner === 'function') {
      renderBarcodeDesigner(designer);
    }
  }

  toast(enabled ? '✓ Módulo de etiquetas activado' : 'Módulo de etiquetas desactivado', enabled ? 'ok' : 'w');

  // Log
  window.api.audit?.log?.({
    action: enabled ? 'barcode_module_enabled' : 'barcode_module_disabled',
    entity: 'settings', entityId: null,
    detail: enabled ? 'Módulo de etiquetas activado' : 'Módulo de etiquetas desactivado',
    userId: user?.id
  }).catch(() => {});
}

// ── Activar plantilla desde Panel Dev ────────
async function saActivarPlantilla(id) {
  if (!id) return;
  await window.api.settings.set({ key: 'print_template', value: id, requestUserId: window._currentUser?.id });
  if (DB?.settings) DB.settings.print_template = id;

  // Actualizar UI in-place sin recargar la página (evita scroll al tope)
  document.querySelectorAll('[id^="sa-plant-row-"]').forEach(row => {
    const rowId   = row.id.replace('sa-plant-row-', '');
    const esActiva = rowId === id;
    row.style.background = esActiva ? 'var(--green-bg, #f0fdf4)' : 'var(--bg2)';
    row.style.border      = `1px solid ${esActiva ? 'var(--green)' : 'var(--line2)'}`;
    const badge = row.querySelector('.sa-plant-badge');
    const btn   = row.querySelector('.sa-plant-btn');
    if (badge) badge.style.display = esActiva ? 'inline' : 'none';
    if (btn) {
      btn.textContent  = esActiva ? '✓ Activa' : 'Activar';
      btn.style.background = esActiva ? 'var(--green)' : 'transparent';
      btn.style.color      = esActiva ? '#fff' : 'var(--ink)';
      btn.style.border     = `1px solid ${esActiva ? 'var(--green)' : 'var(--line)'}`;
    }
    // Actualizar ID activa en el label
    const labelId = document.getElementById('sa-plant-active-id');
    if (labelId) {
      labelId.textContent = id;
      labelId.style.color = 'var(--green)';
    }
  });

  toast(`✓ Plantilla activada`);
}
