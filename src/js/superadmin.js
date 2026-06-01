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

// ══════════════════════════════════════════════
// PANEL DE ACTUALIZACIONES
// ══════════════════════════════════════════════

// Cache del estado del updater en el renderer
let _updState = null;

// Cargar estado inicial al abrir Configuración

// ══════════════════════════════════════════════
// TOGGLE MÓDULO DE ETIQUETAS
// ══════════════════════════════════════════════
async function saToggleBarcodeModule(enabled) {
  // Actualizar setting
  await window.api.settings.set({ key: 'barcode_enabled', value: enabled ? '1' : '0' });

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
