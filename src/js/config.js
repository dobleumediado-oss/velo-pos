// ══════════════════════════════════════════════
// config.js — Módulo de Configuración
// ══════════════════════════════════════════════

async function renderConfiguracion(el) {
  el.innerHTML = '';

  // ── Cargar datos necesarios ─────────────────
  const settings    = await window.api.settings.getAll();
  const versionInfo = await window.api.version.getInfo().catch(() => ({ ok: false }));
  const info        = versionInfo.ok ? versionInfo.data : {};
  const licResult   = await window.api.license.getStatus().catch(() => ({ ok: false }));
  const lic         = licResult.ok ? licResult.data : null;
  const isSA        = user?.role === 'superadmin';

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Configuración'),
      h('div', { class: 'sec-sub' }, `Velo POS v${info.appVersion || window._appVersion || '1.4.4'}`)
    ),
    h('button', {
      class: 'btn btn-green',
      onclick: guardarConfiguracion,
      html: `${svg('check')} Guardar cambios`
    })
  ));

  // ── Columnas ─────────────────────────────────
  const colLeft  = h('div', { style: 'display:flex;flex-direction:column;gap:16px;min-width:0' });
  const colRight = h('div', { style: 'display:flex;flex-direction:column;gap:16px;width:400px;flex-shrink:0' });
  const grid     = h('div', { style: 'display:grid;grid-template-columns:1fr 400px;gap:20px;align-items:start' });

  // ══════════════════════
  // COLUMNA IZQUIERDA
  // ══════════════════════

  // ── Plantillas de impresión ──────────────────
  const printerSaved = settings?.printer || '';
  const printerType  = detectPrinterType(printerSaved);
  const plantillas   = getPlantillasByTipo(printerType === 'unknown' ? '80mm' : printerType);
  const plantActual  = settings?.print_template || plantillas[0]?.id || 'termica_80_clasica';

  const plantCard = h('div', { class: 'card' });
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
        <div class="alrt-sub">Tipo detectado: ${
          printerType === '58mm' ? 'Térmica 58mm' :
          printerType === '80mm' ? 'Térmica 80mm' :
          printerType === 'carta' ? 'Carta / A4' : 'No reconocida — usando 80mm por defecto'
        }</div>
      </div>
    </div>
    <div id="plantillas-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:12px">
      ${plantillas.map(p => `
        <div onclick="seleccionarPlantilla('${p.id}')" id="plant-card-${p.id}"
             style="border:2px solid ${plantActual===p.id?'var(--green)':'var(--line)'};
                    border-radius:10px;padding:10px;cursor:pointer;transition:.15s;
                    background:${plantActual===p.id?'var(--green-bg)':'var(--surface)'}">
          <div style="font-size:20px;margin-bottom:4px">${p.icono}</div>
          <div style="font-weight:700;font-size:12px;margin-bottom:2px">${p.nombre}</div>
          <div style="font-size:10px;color:var(--muted2);line-height:1.3">${p.desc}</div>
          ${plantActual===p.id?'<div style="font-size:10px;color:var(--green);font-weight:700;margin-top:4px">✓ Activa</div>':''}
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
      <iframe id="plant-iframe" style="width:100%;height:400px;border:1px solid var(--line);border-radius:6px;background:#fff"></iframe>
    </div>`;
  colLeft.appendChild(plantCard);

  // ── Datos del negocio ────────────────────────
  const bizCard = h('div', { class: 'card' });
  bizCard.innerHTML = `
    <div class="card-title mb8">Datos del Negocio</div>
    <div class="fg">
      <label class="lbl">Nombre comercial *</label>
      <input class="inp" id="cfg-biz-name" type="text" placeholder="Mi Negocio" value="${settings.biz_name||''}"/>
    </div>
    <div class="fg">
      <label class="lbl">RNC</label>
      <input class="inp" id="cfg-biz-rnc" type="text" placeholder="130-00000-0" value="${settings.biz_rnc||''}"/>
    </div>
    <div class="fg">
      <label class="lbl">Dirección</label>
      <input class="inp" id="cfg-biz-addr" type="text" placeholder="Calle Principal #1" value="${settings.biz_addr||''}"/>
    </div>
    <div class="fg">
      <label class="lbl">Teléfono / WhatsApp</label>
      <input class="inp" id="cfg-biz-phone" type="tel" placeholder="18091234567" value="${settings.biz_phone||''}"/>
      <div style="font-size:10px;color:var(--muted2);margin-top:3px">
        💡 Con código de país (ej: 18091234567). Se usa como destino por defecto al enviar por WhatsApp.
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Mensaje en recibos</label>
      <input class="inp" id="cfg-receipt-msg" type="text" placeholder="¡Gracias por su compra!" value="${settings.receipt_msg||''}"/>
    </div>
    <div class="fg">
      <label class="lbl">ITBIS (%)</label>
      <input class="inp" id="cfg-tax" type="number" min="0" max="100" placeholder="18" value="${settings.tax_pct||'18'}"/>
    </div>`;
  colLeft.appendChild(bizCard);

  // ── Logo (solo superadmin) ───────────────────
  if (isSA) {
    const logoActual = settings.biz_logo || '';
    const logoCard   = h('div', { class: 'card' });
    logoCard.innerHTML = `
      <div class="fxb mb8">
        <div class="card-title">Logo en Tickets</div>
        ${logoActual ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="eliminarLogo()">Eliminar</button>` : ''}
      </div>
      ${logoActual
        ? `<div style="text-align:center;margin-bottom:12px">
             <img src="${logoActual}" style="max-width:160px;max-height:60px;filter:grayscale(100%) contrast(150%);border:1px solid var(--line);border-radius:6px;padding:8px"/>
             <div style="font-size:11px;color:var(--muted);margin-top:4px">Así aparecerá en B&N en el ticket</div>
           </div>`
        : `<div class="alrt b" style="margin-bottom:12px">
             <div class="alrt-dot b"></div>
             <div>
               <div class="alrt-title">Sin logo configurado</div>
               <div class="alrt-sub">PNG o JPG, 300×100px recomendado.</div>
             </div>
           </div>`}
      <input type="file" id="logo-input" accept="image/png,image/jpeg,image/jpg" style="display:none" onchange="previewLogo(this)"/>
      <button class="btn btn-out btn-fw" onclick="document.getElementById('logo-input').click()">
        ${svg('download')} ${logoActual ? 'Cambiar logo' : 'Seleccionar imagen'}
      </button>
      <div id="logo-preview" style="margin-top:10px;display:none;text-align:center">
        <img id="logo-preview-img" style="max-width:160px;max-height:60px;filter:grayscale(100%) contrast(150%);border:1px solid var(--line);border-radius:6px;padding:8px"/>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">Vista previa</div>
        <button class="btn btn-green btn-sm" style="margin-top:8px" onclick="guardarLogo()">
          ${svg('check')} Guardar logo
        </button>
      </div>`;
    colLeft.appendChild(logoCard);
  }

  // ── Impresora (solo superadmin) ──────────────
  if (isSA) {
    const printerCard = h('div', { class: 'card' });
    printerCard.innerHTML = `
      <div class="fxb mb8"><div class="card-title">Impresora Térmica</div></div>
      <div class="tr" style="font-size:12px;margin-bottom:10px">
        <span>Impresora guardada</span>
        <span style="font-weight:600;color:${settings.printer?'var(--green)':'var(--muted2)'}">
          ${settings.printer ? settings.printer.slice(0,30) : 'No configurada'}
        </span>
      </div>
      <div class="alrt b" style="margin-bottom:12px">
        <div class="alrt-dot b"></div>
        <div>
          <div class="alrt-title">${detectPrinterType(settings.printer||'')==='58mm'?'Térmica 58mm detectada':'Térmica 80mm (default)'}</div>
          <div class="alrt-sub">Conecta por USB, instala en Windows y configura aquí.</div>
        </div>
      </div>
      <div class="flex" style="gap:8px">
        <button class="btn btn-dark btn-fw" onclick="openPrinterConfig()">${svg('settings')} Configurar</button>
        <button class="btn btn-out btn-fw" onclick="testPrint()">${svg('print')} Prueba</button>
      </div>`;
    colLeft.appendChild(printerCard);
  }

  // ══════════════════════
  // COLUMNA DERECHA
  // ══════════════════════

  // ── Actualizaciones ──────────────────────────
  const updCard = h('div', { class: 'card', id: 'upd-card' });
  _renderUpdPanel(updCard);
  if (window.api?.updater?.onState) {
    window.api.updater.onState((state) => {
      const c = document.getElementById('upd-card');
      if (c) _renderUpdPanel(c, state);
      _updFloatingBar(state);
    });
  }
  colRight.appendChild(updCard);

  // ── Sistema ──────────────────────────────────
  const infoCard = h('div', { class: 'card' });
  infoCard.innerHTML = `
    <div class="card-title mb8">Sistema</div>
    <div class="tr" style="font-size:12px">
      <span>Versión</span>
      <span style="font-family:var(--mono);font-weight:600">v${info.appVersion||window._appVersion||'1.4.1'}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Instalado</span>
      <span>${info.installedAt?info.installedAt.split('T')[0]:'—'}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Último backup</span>
      <span style="color:${info.lastBackup&&info.lastBackup===today()?'var(--green)':'var(--amber)'}">
        ${info.lastBackup||'Nunca'}
      </span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Backups guardados</span>
      <span>${info.backupsCount||0}</span>
    </div>`;
  colRight.appendChild(infoCard);

  // ── Importar datos ───────────────────────────
  const importCard = h('div', { class: 'card' });
  importCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, '📂 Importar datos'),
    h('span', { style: 'font-size:11px;color:var(--muted2)' }, 'Excel, CSV, JSON, SQLite')
  ));
  importCard.appendChild(h('div', { class: 'alrt b', style: 'margin-bottom:12px' },
    h('div', { class: 'alrt-dot b' }),
    h('div', null,
      h('div', { class: 'alrt-title' }, 'Importación con IA'),
      h('div', { class: 'alrt-sub' }, 'La IA detecta automáticamente las columnas de tu archivo.')
    )
  ));
  importCard.appendChild(h('button', {
    class: 'btn btn-dark btn-fw',
    onclick: abrirImportarDesdeConfig,
    html: '✨ Importar productos o clientes'
  }));
  colRight.appendChild(importCard);

  // ── Backups ──────────────────────────────────
  const backupCard = h('div', { class: 'card' });
  backupCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Backups'),
    h('span', { style: 'font-size:11px;color:var(--muted2)' }, `${info.backupsCount||0} guardados`)
  ));
  backupCard.appendChild(h('div', { class: 'alrt b', style: 'margin-bottom:12px' },
    h('div', { class: 'alrt-dot b' }),
    h('div', null,
      h('div', { class: 'alrt-title' }, 'Backup automático activo'),
      h('div', { class: 'alrt-sub' }, 'Se crea automáticamente cada vez que inicia la app.')
    )
  ));
  backupCard.appendChild(h('div', { class: 'flex', style: 'gap:8px;margin-bottom:12px' },
    h('button', { class: 'btn btn-out btn-fw', onclick: hacerBackupManual, html: `${svg('download')} Crear ahora` }),
    h('button', { class: 'btn btn-ghost btn-fw', style: 'color:var(--amber)', onclick: restaurarBackup, html: `${svg('return')} Restaurar último` })
  ));
  if (info.backups?.length) {
    const bList = h('div');
    bList.appendChild(h('div', { style: 'font-size:11px;font-weight:700;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em' }, 'Backups disponibles'));
    info.backups.forEach(b => {
      const nombre   = typeof b === 'string' ? b : b.name || b;
      const fechaStr = nombre.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
      const esHoy    = fechaStr === today();
      const row      = h('div', { class: 'fxb', style: 'padding:8px 0;border-bottom:1px solid var(--line2)' });
      row.appendChild(h('div', null,
        h('div', { style: `font-size:12px;font-family:var(--mono);color:${esHoy?'var(--green)':'var(--ink)'}` }, nombre),
        h('div', { style: 'font-size:10px;color:var(--muted2)' }, esHoy ? 'Hoy' : fechaStr ? fdate(fechaStr) : '')
      ));
      row.appendChild(h('button', {
        class: 'btn btn-ghost btn-sm',
        style: 'color:var(--amber);font-size:11px',
        html: `${svg('return')} Restaurar`,
        onclick: () => restaurarBackupEspecifico(nombre)
      }));
      bList.appendChild(row);
    });
    backupCard.appendChild(bList);
  } else {
    backupCard.appendChild(h('div', { style: 'font-size:12px;color:var(--muted2);padding:8px 0' }, 'Sin backups todavía'));
  }
  colRight.appendChild(backupCard);

  // ── Licencia (solo superadmin) ───────────────
  if (isSA) {
    const licColor = !lic ? 'var(--muted)' :
      lic.blocked     ? 'var(--red)'   :
      lic.inGrace     ? 'var(--amber)' :
      lic.warningSoon ? 'var(--amber)' : 'var(--green)';
    const licLabel = !lic ? 'No disponible' :
      lic.blocked      ? 'Sin licencia — bloqueado' :
      lic.inGrace      ? `Período de gracia — ${lic.graceDaysLeft}d restantes` :
      lic.warningSoon  ? `Vence en ${lic.daysLeft} días` :
      lic.licensed     ? `Activa${lic.expiry==='Perpetua'?' (Perpetua)':' — Vence: '+lic.expiry}` : 'Desconocido';

    const licCard = h('div', { class: 'card' });
    licCard.innerHTML = `
      <div class="fxb mb8">
        <div class="card-title">Licencia del Sistema</div>
        <span class="badge ${lic?.licensed?'g':lic?.inGrace?'a':'r'}" style="font-size:11px">
          ${lic?.licensed?'Activa':lic?.inGrace?'Gracia':'Sin licencia'}
        </span>
      </div>
      <div class="tr" style="font-size:12px;margin-bottom:6px">
        <span>Estado</span>
        <span style="font-weight:600;color:${licColor}">${licLabel}</span>
      </div>
      ${lic?.business ? `<div class="tr" style="font-size:12px;margin-bottom:6px">
        <span>Negocio</span><span style="font-weight:600">${lic.business}</span>
      </div>` : ''}
      <div class="tr" style="font-size:11px;color:var(--muted);margin-bottom:12px">
        <span>ID de máquina</span>
        <span style="font-family:var(--mono);font-size:10px">${lic?.machineId||'—'}</span>
      </div>
      ${lic?.inGrace||lic?.blocked||!lic?.licensed ? `
        <div class="alrt a" style="margin-bottom:12px">
          <div class="alrt-dot a"></div>
          <div>
            <div class="alrt-title">Activar licencia</div>
            <div class="alrt-sub">Contacta al proveedor con el ID de máquina.</div>
          </div>
        </div>
        <div class="fg" style="margin-bottom:8px">
          <label class="lbl">Clave de licencia</label>
          <input class="inp" id="lic-key" type="text" placeholder="2|ABCD...|Negocio|2027-01-01|FIRMA"
                 style="font-family:var(--mono);font-size:11px"/>
        </div>
        <button class="btn btn-green btn-fw" onclick="activarLicencia()">
          ${svg('check')} Activar licencia
        </button>` : `
        <button class="btn btn-out btn-sm" onclick="openModal('<div class=\\'modal-title\\'>ID de Máquina</div><div style=\\'font-family:monospace;font-size:12px;padding:14px;background:var(--surface2);border-radius:8px;word-break:break-all\\'>${lic?.machineId}</div><div class=\\'modal-foot\\'><button class=\\'btn btn-out\\' onclick=\\'closeModal()\\'>Cerrar</button></div>')">
          Ver ID de máquina
        </button>`}`;
    colRight.appendChild(licCard);
  }

  // ── Categorías (scroll interno) ──────────────
  const catCard = h('div', { class: 'card' });
  catCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Categorías'),
    h('button', { class: 'btn btn-dark btn-sm', onclick: openNuevaCategoriaModal, html: `${svg('plus')} Nueva` })
  ));
  const catScroll = h('div', { style: 'max-height:220px;overflow-y:auto;overflow-x:hidden' });
  const catListEl = h('div', { id: 'cat-list' });
  _renderCatList(catListEl);
  catScroll.appendChild(catListEl);
  catCard.appendChild(catScroll);
  colRight.appendChild(catCard);

  // ── Usuarios ─────────────────────────────────
  const usersCard = h('div', { class: 'card' });
  usersCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Usuarios del sistema'),
    h('button', { class: 'btn btn-dark btn-sm', onclick: openNuevoCajeroModal, html: `${svg('plus')} Nuevo cajero` })
  ));
  const users = (window._cachedUsers || []).filter(u => u.role !== 'superadmin');
  if (!users.length) {
    usersCard.appendChild(h('div', { style: 'color:var(--muted2);font-size:12px' }, 'Sin usuarios'));
  } else {
    users.forEach(u => {
      const row = h('div', { class: 'fxb', style: 'padding:10px 0;border-bottom:1px solid var(--line2)' });
      row.appendChild(h('div', { class: 'flex', style: 'gap:8px' },
        h('div', { class: 'sb-av', style: `width:32px;height:32px;font-size:11px;opacity:${u.active?1:0.4}` }, u.avatar||u.name?.[0]||'U'),
        h('div', null,
          h('div', { style: `font-size:13px;font-weight:600;color:${u.active?'var(--ink)':'var(--muted)'}` }, u.name),
          h('div', { class: 'ts' }, u.email)
        )
      ));
      const actions = h('div', { class: 'flex', style: 'gap:5px' });
      actions.appendChild(h('span', { class: `badge ${u.role==='admin'?'b':'g'}` }, u.role));
      actions.appendChild(h('span', { class: `badge ${u.active?'g':'r'}` }, u.active?'Activo':'Inactivo'));
      if (!(u.role==='admin' && u.id===user?.id)) {
        actions.appendChild(h('button', { class: 'btn btn-ghost btn-sm', title: 'Editar', html: svg('edit'), onclick: () => openEditarUsuarioModal(u) }));
        if (u.role !== 'admin') {
          actions.appendChild(h('button', {
            class: 'btn btn-ghost btn-sm',
            title: u.active ? 'Desactivar' : 'Activar',
            style: `color:${u.active?'var(--red)':'var(--green)'}`,
            html: u.active ? svg('lock') : svg('check'),
            onclick: () => toggleUsuario(u)
          }));
        }
      }
      row.appendChild(actions);
      usersCard.appendChild(row);
    });
  }
  colRight.appendChild(usersCard);

  // ── Ensamblar ────────────────────────────────
  grid.appendChild(colLeft);
  grid.appendChild(colRight);
  el.appendChild(grid);
}

// ══════════════════════════════════════════════
// GUARDAR CONFIGURACIÓN
// ══════════════════════════════════════════════
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
  const s = await window.api.settings.getAll();
  CFG.biz   = s.biz_name  || CFG.biz;
  CFG.rnc   = s.biz_rnc   || CFG.rnc;
  CFG.addr  = s.biz_addr  || CFG.addr;
  CFG.phone = s.biz_phone || CFG.phone;
  CFG.itbis = parseFloat(s.tax_pct) || 18;
  toast('✓ Configuración guardada');
}

// ══════════════════════════════════════════════
// USUARIOS
// ══════════════════════════════════════════════
function openEditarUsuarioModal(u) {
  openModal(`
    <div class="modal-title">Editar Usuario</div>
    <div class="modal-sub">${u.name} · ${u.role}</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nombre completo *</label>
        <input class="inp" id="eu-name" type="text" value="${u.name||''}"/></div>
      <div class="fg"><label class="lbl">Email *</label>
        <input class="inp" id="eu-email" type="email" value="${u.email||''}"/></div>
    </div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nueva contraseña</label>
        <input class="inp" id="eu-pass" type="password" placeholder="Dejar vacío para no cambiar"/></div>
      <div class="fg"><label class="lbl">Iniciales (avatar)</label>
        <input class="inp" id="eu-avatar" type="text" value="${u.avatar||''}" maxlength="2"/></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="guardarEdicionUsuario(${u.id})">${svg('check')} Guardar</button>
    </div>`);
}

async function guardarEdicionUsuario(id) {
  const name   = document.getElementById('eu-name')?.value?.trim();
  const email  = document.getElementById('eu-email')?.value?.trim();
  const pass   = document.getElementById('eu-pass')?.value;
  const avatar = document.getElementById('eu-avatar')?.value?.trim().toUpperCase() || '';
  if (!name)  { toast('El nombre es requerido', 'err'); return; }
  if (!email) { toast('El email es requerido', 'err');  return; }
  if (pass && pass.length < 6) { toast('Mínimo 6 caracteres', 'err'); return; }
  const existing = (window._cachedUsers||[]).find(u=>u.id===id);
  const data = { name, email, role: existing?.role||'cajero', avatar: avatar||name[0].toUpperCase(), active: existing?.active??1 };
  const result = await window.api.users.update({ id, data, requestUserId: user.id });
  if (!result.ok) { toast(result.error||'Error', 'err'); return; }
  if (pass) {
    await window.api.users.changePassword({ id, password: pass, requestUserId: user.id });
  }
  window._cachedUsers = await window.api.users.getAll() || [];
  closeModal();
  toast(`✓ Usuario ${name} actualizado`);
  renderConfiguracion(document.getElementById('page'));
}

async function toggleUsuario(u) {
  confirmModal(`¿Deseas ${u.active?'desactivar':'activar'} a <strong>${u.name}</strong>?`,
    async () => {
      const result = await window.api.users.update({ id: u.id, data: {...u, active: u.active?0:1}, requestUserId: user.id });
      if (!result.ok) { toast(result.error||'Error', 'err'); return; }
      window._cachedUsers = await window.api.users.getAll() || [];
      toast(`✓ Usuario ${u.active?'desactivado':'activado'}`);
      renderConfiguracion(document.getElementById('page'));
    },
    u.active ? 'Desactivar' : 'Activar',
    u.active ? 'btn-red' : 'btn-green'
  );
}

// ══════════════════════════════════════════════
// BACKUPS
// ══════════════════════════════════════════════
async function hacerBackupManual() {
  const result = await window.api.backup.create({ requestUserId: user.id });
  if (result.ok) {
    toast(`✓ Backup creado`);
    renderConfiguracion(document.getElementById('page'));
  } else {
    toast(result.error||'Error al crear backup', 'err');
  }
}

async function restaurarBackup() {
  confirmModal('Al restaurar el último backup, los datos actuales serán reemplazados. ¿Continuar?',
    async () => {
      const result = await window.api.backup.restore({ requestUserId: user.id });
      if (result.ok) { toast('✓ Restaurando...'); setTimeout(() => location.reload(), 1500); }
      else toast(result.error||'Error al restaurar', 'err');
    }, 'Restaurar', 'btn-red');
}

async function restaurarBackupEspecifico(nombre) {
  confirmModal(`¿Restaurar <strong>${nombre}</strong>?<br><span style="font-size:11px;color:var(--muted)">Los datos actuales serán reemplazados.</span>`,
    async () => {
      const result = await window.api.backup.restore({ fileName: nombre, requestUserId: user.id });
      if (result.ok) { toast('✓ Restaurando...'); setTimeout(() => location.reload(), 1500); }
      else toast(result.error||'Error al restaurar', 'err');
    }, 'Restaurar este backup', 'btn-red');
}

// ══════════════════════════════════════════════
// NUEVO CAJERO
// ══════════════════════════════════════════════
function openNuevoCajeroModal() {
  const isSA = user?.role === 'superadmin';
  openModal(`
    <div class="modal-title">Nuevo Usuario</div>
    <div class="modal-sub">Crear cuenta de acceso</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nombre completo *</label>
        <input class="inp" id="uc-name" type="text" placeholder="Juan Pérez"/></div>
      <div class="fg"><label class="lbl">Email *</label>
        <input class="inp" id="uc-email" type="email" placeholder="cajero@negocio.do"/></div>
    </div>
    <div class="g2">
      <div class="fg"><label class="lbl">Contraseña *</label>
        <input class="inp" id="uc-pass" type="password" placeholder="Mínimo 6 caracteres"/></div>
      <div class="fg"><label class="lbl">Iniciales (avatar)</label>
        <input class="inp" id="uc-avatar" type="text" placeholder="JP" maxlength="2"/></div>
    </div>
    <div class="fg">
      <label class="lbl">Rol</label>
      <select class="inp" id="uc-role">
        <option value="cajero">Cajero / Vendedor</option>
        ${isSA ? '<option value="admin">Administrador</option>' : ''}
      </select>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="crearCajero()">${svg('check')} Crear usuario</button>
    </div>`);
}

async function crearCajero() {
  const name   = document.getElementById('uc-name')?.value?.trim();
  const email  = document.getElementById('uc-email')?.value?.trim();
  const pass   = document.getElementById('uc-pass')?.value;
  const avatar = document.getElementById('uc-avatar')?.value?.trim().toUpperCase() || '';
  const role   = user?.role==='superadmin' ? (document.getElementById('uc-role')?.value||'cajero') : 'cajero';
  if (!name)  { toast('El nombre es requerido', 'err'); return; }
  if (!email) { toast('El email es requerido', 'err');  return; }
  if (!pass||pass.length<6) { toast('Mínimo 6 caracteres', 'err'); return; }
  const result = await window.api.users.create({ data: { name, email, password: pass, role, avatar }, requestUserId: user.id });
  if (!result.ok) { toast(result.error||'Error al crear', 'err'); return; }
  window._cachedUsers = await window.api.users.getAll() || [];
  closeModal();
  toast(`✓ ${role==='admin'?'Administrador':'Cajero'} ${name} creado`);
  renderConfiguracion(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// CATEGORÍAS
// ══════════════════════════════════════════════
async function _renderCatList(el) {
  if (!el) return;
  const r    = await window.api.categories.getAll().catch(() => ({ ok: false }));
  const cats = r?.ok ? r.data : [];
  if (!cats.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--muted2);padding:8px 0">Sin categorías — agrega la primera</div>`;
    return;
  }
  el.innerHTML = '';
  cats.forEach(c => {
    const row = h('div', { class: 'fxb', style: 'padding:7px 0;border-bottom:1px solid var(--line2)' });
    row.appendChild(h('span', { style: 'font-size:13px' }, c.name));
    row.appendChild(h('button', {
      class: 'btn btn-ghost btn-sm',
      style: 'color:var(--red);font-size:11px',
      html: `${svg('trash')} Eliminar`,
      onclick: () => eliminarCategoria(c.id, c.name)
    }));
    el.appendChild(row);
  });
}

function openNuevaCategoriaModal() {
  openModal(`
    <div class="modal-title">Nueva Categoría</div>
    <div class="fg">
      <label class="lbl">Nombre *</label>
      <input class="inp" id="cat-name" type="text" placeholder="Ej: Herramientas, Aceites..."
             onkeydown="if(event.key==='Enter') crearCategoria()"/>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="crearCategoria()">${svg('check')} Crear</button>
    </div>`);
  setTimeout(() => document.getElementById('cat-name')?.focus(), 100);
}

async function crearCategoria() {
  const name = document.getElementById('cat-name')?.value?.trim();
  if (!name) { toast('El nombre es requerido', 'err'); return; }
  const r = await window.api.categories.create({ name, requestUserId: user.id });
  if (!r.ok) { toast(r.error||'Error al crear', 'err'); return; }
  await reloadCategories();
  closeModal();
  toast(`✓ Categoría "${name}" creada`);
  const el = document.getElementById('cat-list');
  if (el) _renderCatList(el);
}

function eliminarCategoria(id, name) {
  confirmModal(`¿Eliminar la categoría <strong>${name}</strong>?<br>
    <span style="font-size:11px;color:var(--muted)">Los productos quedarán sin categoría.</span>`,
    async () => {
      const r = await window.api.categories.delete({ id, requestUserId: user.id });
      if (!r.ok) { toast(r.error||'Error', 'err'); return; }
      await reloadCategories();
      toast('✓ Categoría eliminada');
      const el = document.getElementById('cat-list');
      if (el) _renderCatList(el);
    }, 'Eliminar', 'btn-red');
}

// ══════════════════════════════════════════════
// LOGO
// ══════════════════════════════════════════════
function previewLogo(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById('logo-preview');
    const img  = document.getElementById('logo-preview-img');
    if (prev) prev.style.display = 'block';
    if (img)  img.src = e.target.result;
    window._logoDataUrl = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function guardarLogo() {
  if (!window._logoDataUrl) { toast('Selecciona una imagen primero', 'w'); return; }
  await window.api.settings.set({ key: 'biz_logo', value: window._logoDataUrl });
  CFG.biz_logo = window._logoDataUrl;
  toast('✓ Logo guardado');
  renderConfiguracion(document.getElementById('page'));
}

async function eliminarLogo() {
  confirmModal('¿Eliminar el logo del negocio?',
    async () => {
      await window.api.settings.set({ key: 'biz_logo', value: '' });
      CFG.biz_logo = '';
      toast('✓ Logo eliminado');
      renderConfiguracion(document.getElementById('page'));
    }, 'Eliminar', 'btn-red');
}

// ══════════════════════════════════════════════
// LICENCIA
// ══════════════════════════════════════════════
async function activarLicencia() {
  const key = document.getElementById('lic-key')?.value?.trim();
  if (!key) { toast('Ingresa la clave de licencia', 'err'); return; }
  const result = await window.api.license.activate(key);
  if (result.ok) {
    toast('✓ Licencia activada correctamente');
    renderConfiguracion(document.getElementById('page'));
  } else {
    toast(result.error || 'Licencia inválida', 'err');
  }
}

// ══════════════════════════════════════════════
// AUDITORÍA
// ══════════════════════════════════════════════
let auditFilter = '';
