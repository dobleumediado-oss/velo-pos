// ══════════════════════════════════════════════
// wizard.js — Asistente de primer login y
//             cambio de contraseña obligatorio
// Separado de app.js para mantenibilidad
// ══════════════════════════════════════════════

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
  const logs = await window.api.audit.getLogs({ limit: 300, requestUserId: user?.id });
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
  window._pwdChangeRequired = false;
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

  await window.api.settings.set({ key: 'biz_name',  value: biz,   requestUserId: user.id });
  await window.api.settings.set({ key: 'biz_rnc',   value: rnc,   requestUserId: user.id });
  await window.api.settings.set({ key: 'biz_phone', value: phone, requestUserId: user.id });
  await window.api.settings.set({ key: 'biz_addr',  value: addr,  requestUserId: user.id });

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
  window._pwdChangeRequired = false;
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

  await window.api.settings.set({ key: 'biz_logo', value: b64, requestUserId: user.id });
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
      await window.api.settings.set({ key: 'biz_logo', value: '', requestUserId: user.id });
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
