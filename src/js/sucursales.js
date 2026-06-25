// ══════════════════════════════════════════════
// sucursales.js — Sucursales y NCF Avanzado
// VeloPOS v1.5.5
// ══════════════════════════════════════════════

function _sUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}

const _sFmt  = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0 });
const _sDate = d => d ? new Date(d+'T00:00:00').toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'}) : '—';

// ══════════════════════════════════════════════
// SUCURSALES
// ══════════════════════════════════════════════
async function renderSucursales(el) {
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Cargando sucursales...</div>';
  const user = _sUser();
  if (!user || !['admin','superadmin'].includes(user.role)) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Sin acceso.</div>';
    return;
  }

  const res = await window.api.branches.getAll();
  const branches = res?.data || [];

  el.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px';
  hdr.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Sucursales</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">${branches.length} sucursal${branches.length!==1?'es':''} registrada${branches.length!==1?'s':''}</p>
    </div>
    <button class="btn btn-dark btn-sm" id="btn-nueva-suc">+ Nueva sucursal</button>`;
  el.appendChild(hdr);

  if (!branches.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:48px;color:var(--muted2);background:var(--bg2);border-radius:10px;border:0.5px solid var(--line2)';
    empty.innerHTML = '<div style="font-size:36px">🏪</div><div style="margin-top:8px;font-size:13px">Sin sucursales registradas</div><div style="font-size:11px;margin-top:4px">Agrega la primera sucursal del negocio</div>';
    el.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px';
    branches.forEach(b => {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg2);border-radius:12px;border:0.5px solid var(--line2);padding:16px';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div style="font-size:15px;font-weight:600;color:var(--ink)">🏪 ${b.name}</div>
          <span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${b.active?'#e6fdf4':'#f3f4f6'};color:${b.active?'#065f46':'#6b7280'};font-weight:600">${b.active?'Activa':'Inactiva'}</span>
        </div>
        ${b.address ? `<div style="font-size:12px;color:var(--muted2);margin-bottom:3px">📍 ${b.address}</div>` : ''}
        ${b.phone   ? `<div style="font-size:12px;color:var(--muted2);margin-bottom:3px">📞 ${b.phone}</div>`   : ''}
        ${b.manager ? `<div style="font-size:12px;color:var(--muted2)">👤 ${b.manager}</div>`                   : ''}
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" style="flex:1" onclick="editarSucursal(${b.id})">✏️ Editar</button>
          ${user.role==='superadmin' ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="eliminarSucursal(${b.id})">🗑</button>` : ''}
        </div>`;
      grid.appendChild(card);
    });
    el.appendChild(grid);
  }

  document.getElementById('btn-nueva-suc')?.addEventListener('click', () => modalSucursal(el));
}

function modalSucursal(parentEl, suc = null) {
  const user = _sUser();
  const s = suc || {};
  const html = `
    <div class="fg"><label class="lbl">Nombre de la sucursal *</label>
      <input class="inp" id="s-name" placeholder="Ej: Sucursal Norte" value="${s.name||''}"></div>
    <div class="fg"><label class="lbl">Dirección</label>
      <input class="inp" id="s-addr" placeholder="Dirección completa" value="${s.address||''}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Teléfono</label>
        <input class="inp" id="s-phone" placeholder="809-000-0000" value="${s.phone||''}"></div>
      <div class="fg"><label class="lbl">Encargado</label>
        <input class="inp" id="s-manager" placeholder="Nombre del encargado" value="${s.manager||''}"></div>
    </div>
    ${suc ? `<div class="fg" style="display:flex;align-items:center;gap:8px;margin-top:4px">
      <input type="checkbox" id="s-active" ${s.active?'checked':''}>
      <label for="s-active" style="font-size:13px">Sucursal activa</label>
    </div>` : ''}`;

  _sModal(suc ? 'Editar sucursal' : 'Nueva sucursal', html, async (ov) => {
    const name = ov.querySelector('#s-name')?.value.trim();
    if (!name) throw new Error('El nombre es obligatorio');
    const data = {
      name,
      address: ov.querySelector('#s-addr')?.value.trim(),
      phone:   ov.querySelector('#s-phone')?.value.trim(),
      manager: ov.querySelector('#s-manager')?.value.trim(),
      active:  suc ? (ov.querySelector('#s-active')?.checked ? 1 : 0) : 1,
    };
    let res;
    if (suc) {
      res = await window.api.branches.update({ id: suc.id, data, requestUserId: user.id });
    } else {
      res = await window.api.branches.create({ data, requestUserId: user.id });
    }
    if (!res.ok) throw new Error(res.error);
    _sToast(`✓ Sucursal ${suc ? 'actualizada' : 'creada'}`);
    renderSucursales(parentEl.closest('#main-content') || parentEl);
  }, suc ? 'Guardar' : 'Crear sucursal');
}

window.editarSucursal = async (id) => {
  const res = await window.api.branches.getAll();
  const s = (res?.data||[]).find(x => x.id === id);
  if (!s) return;
  const el = document.getElementById('main-content');
  modalSucursal(el, s);
};

window.eliminarSucursal = async (id) => {
  if (!confirm('¿Eliminar esta sucursal?')) return;
  const user = _sUser();
  const res = await window.api.branches.delete({ id, requestUserId: user.id });
  if (!res.ok) return alert(res.error);
  _sToast('✓ Sucursal eliminada');
  const el = document.getElementById('main-content');
  if (el) renderSucursales(el);
};

// ══════════════════════════════════════════════
// NCF AVANZADO — integrado en Configuración
// ══════════════════════════════════════════════
async function renderNCFAvanzado(el) {
  el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted2)">Cargando comprobantes...</div>';
  const user = _sUser();
  if (!['admin','superadmin'].includes(user?.role)) {
    el.innerHTML = '<div style="padding:16px;color:var(--muted2)">Sin acceso.</div>';
    return;
  }

  const [seqRes, alertRes] = await Promise.all([
    window.api.ncf.getSequences(),
    window.api.ncf.getAlerts(),
  ]);

  const secuencias = seqRes?.data || [];
  const alertas = alertRes?.data || [];

  el.innerHTML = '';

  // Alertas de comprobantes bajos
  if (alertas.length) {
    const alertDiv = document.createElement('div');
    alertDiv.style.cssText = 'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#991b1b';
    alertDiv.innerHTML = `⚠ <strong>${alertas.length} secuencia${alertas.length>1?'s':''} con pocos comprobantes:</strong> ${alertas.map(a=>`${a.type}: ${a.remaining} restantes`).join(' · ')}`;
    el.appendChild(alertDiv);
  }

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px';
  hdr.innerHTML = `
    <div style="font-size:14px;font-weight:600;color:var(--ink)">Secuencias de comprobantes NCF</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" id="btn-validar-rnc">🔍 Validar RNC</button>
      <button class="btn btn-dark btn-sm" id="btn-nueva-seq">+ Nueva secuencia</button>
    </div>`;
  el.appendChild(hdr);

  if (!secuencias.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:32px;color:var(--muted2);background:var(--bg2);border-radius:10px;border:0.5px solid var(--line2)';
    empty.innerHTML = '<div style="font-size:13px">Sin secuencias de NCF configuradas</div><div style="font-size:11px;margin-top:4px">Agrega los rangos autorizados por la DGII</div>';
    el.appendChild(empty);
  } else {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto';
    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
            <th style="padding:8px;text-align:left">Tipo</th>
            <th style="padding:8px;text-align:left">Prefijo</th>
            <th style="padding:8px;text-align:right">Desde</th>
            <th style="padding:8px;text-align:right">Hasta</th>
            <th style="padding:8px;text-align:right">Actual</th>
            <th style="padding:8px;text-align:right">Restantes</th>
            <th style="padding:8px;text-align:left">Vencimiento</th>
            <th style="padding:8px;text-align:left">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${secuencias.map(s => {
            const remaining = s.to_num - s.current;
            const pct = ((s.current - s.from_num + 1) / (s.to_num - s.from_num + 1) * 100).toFixed(0);
            const color = remaining <= s.alert_at ? '#ef4444' : remaining <= s.alert_at * 3 ? '#f59e0b' : '#00c07a';
            return `<tr style="border-bottom:0.5px solid var(--line2)">
              <td style="padding:8px;font-weight:500">${s.type}</td>
              <td style="padding:8px;color:var(--muted2)">${s.prefix}</td>
              <td style="padding:8px;text-align:right">${s.from_num.toLocaleString()}</td>
              <td style="padding:8px;text-align:right">${s.to_num.toLocaleString()}</td>
              <td style="padding:8px;text-align:right">${s.current.toLocaleString()}</td>
              <td style="padding:8px;text-align:right;font-weight:600;color:${color}">${remaining.toLocaleString()}</td>
              <td style="padding:8px;color:var(--muted2)">${s.expiry_date ? _sDate(s.expiry_date) : '—'}</td>
              <td style="padding:8px">
                <div style="background:var(--line2);border-radius:4px;height:6px;width:80px">
                  <div style="background:${color};border-radius:4px;height:6px;width:${pct}%"></div>
                </div>
                <span style="font-size:10px;color:${color}">${pct}% usado</span>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    el.appendChild(wrap);
  }

  document.getElementById('btn-nueva-seq')?.addEventListener('click', () => modalNuevaSecuencia(el));
  document.getElementById('btn-validar-rnc')?.addEventListener('click', () => modalValidarRNC());
}

function modalNuevaSecuencia(parentEl) {
  const user = _sUser();
  const tipos = [
    { code:'B01', label:'B01 — Crédito Fiscal' },
    { code:'B02', label:'B02 — Consumidor Final' },
    { code:'B14', label:'B14 — Régimen Especial' },
    { code:'B15', label:'B15 — Gubernamental' },
    { code:'B16', label:'B16 — Exportaciones' },
  ];

  const html = `
    <div class="fg"><label class="lbl">Tipo de comprobante *</label>
      <select class="inp" id="ncf-type">
        ${tipos.map(t=>`<option value="${t.code}">${t.label}</option>`).join('')}
      </select></div>
    <div class="fg"><label class="lbl">Prefijo *</label>
      <input class="inp" id="ncf-prefix" placeholder="Ej: B01" value="B01">
      <div style="font-size:10px;color:var(--muted2);margin-top:2px">Generalmente igual al tipo. Ej: B01, E31</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Desde (número) *</label>
        <input class="inp" id="ncf-from" type="number" min="1" placeholder="1"></div>
      <div class="fg"><label class="lbl">Hasta (número) *</label>
        <input class="inp" id="ncf-to" type="number" min="1" placeholder="1000"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Vencimiento</label>
        <input class="inp" id="ncf-exp" type="date"></div>
      <div class="fg"><label class="lbl">Alerta cuando queden menos de</label>
        <input class="inp" id="ncf-alert" type="number" min="1" value="50" placeholder="50"></div>
    </div>`;

  _sModal('Nueva secuencia NCF', html, async (ov) => {
    const type   = ov.querySelector('#ncf-type')?.value;
    const prefix = ov.querySelector('#ncf-prefix')?.value.trim().toUpperCase();
    const from_n = parseInt(ov.querySelector('#ncf-from')?.value);
    const to_n   = parseInt(ov.querySelector('#ncf-to')?.value);
    if (!prefix) throw new Error('El prefijo es obligatorio');
    if (!from_n || !to_n || from_n >= to_n) throw new Error('El rango debe ser válido (desde < hasta)');

    const res = await window.api.ncf.createSequence({
      data: {
        type, prefix, from_num: from_n, to_num: to_n,
        expiry_date: ov.querySelector('#ncf-exp')?.value || null,
        alert_at: parseInt(ov.querySelector('#ncf-alert')?.value) || 50,
      },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    _sToast(`✓ Secuencia ${type} creada: ${(to_n-from_n+1).toLocaleString()} comprobantes`);
    renderNCFAvanzado(parentEl.closest('#main-content') || parentEl.parentElement || parentEl);
  }, 'Crear secuencia');

  // Auto-set prefix when type changes
  setTimeout(() => {
    document.getElementById('ncf-type')?.addEventListener('change', (e) => {
      document.getElementById('ncf-prefix').value = e.target.value;
    });
  }, 100);
}

function modalValidarRNC() {
  // Crear el overlay manualmente para controlar cuándo se cierra
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:480px;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2)">
        <div style="font-size:15px;font-weight:600">🔍 Validar RNC ante la DGII</div>
        <button id="rnc-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px">
        <div class="fg"><label class="lbl">RNC o Cédula *</label>
          <input class="inp" id="rnc-val" placeholder="131-96863-5 o 101-00000-0" maxlength="15" style="margin-bottom:10px">
        </div>
        <div id="rnc-result" style="display:none;padding:12px;border-radius:8px;font-size:13px;margin-top:8px"></div>
      </div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="rnc-cancel">Cerrar</button>
        <button class="btn btn-dark" id="rnc-btn">Validar RNC</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#rnc-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#rnc-cancel')?.addEventListener('click', () => overlay.remove());

  // El botón de validar NO cierra el modal — solo muestra el resultado
  overlay.querySelector('#rnc-btn')?.addEventListener('click', async () => {
    const rnc    = overlay.querySelector('#rnc-val')?.value.trim();
    const result = overlay.querySelector('#rnc-result');
    const btn    = overlay.querySelector('#rnc-btn');

    if (!rnc) {
      overlay.querySelector('#rnc-val').style.border = '1px solid var(--red,#ef4444)';
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Consultando...';
    result.style.display = 'block';
    result.innerHTML = '⏳ Consultando base de datos de la DGII...';
    result.style.cssText = 'display:block;padding:12px;border-radius:8px;font-size:13px;margin-top:8px;background:var(--bg2);border:1px solid var(--line2)';

    try {
      // Toda la lógica de consulta está en main.js usando Electron net.fetch
      // (usa el stack de Chromium, pasa Cloudflare como un navegador real)
      const res = await window.api.ncf.validateRnc({ rnc });
      if (res.ok) {
        // Determinar color del estado
        const estadoColor = res.estado === 'ACTIVO' ? '#065f46' : '#991b1b';
        const estadoBg    = res.estado === 'ACTIVO' ? '#e6fdf4' : '#fef2f2';
        const estadoBord  = res.estado === 'ACTIVO' ? '#00c07a' : '#fecaca';

        result.style.cssText = `display:block;padding:16px;border-radius:10px;font-size:13px;margin-top:8px;background:${estadoBg};border:1px solid ${estadoBord}`;
        result.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <span style="font-size:20px">${res.estado==='ACTIVO'?'✅':'⚠️'}</span>
            <div>
              <div style="font-weight:700;font-size:15px;color:${estadoColor}">${res.nombre}</div>
              ${res.comercial && res.comercial !== res.nombre ? `<div style="font-size:11px;color:#047857;margin-top:1px">Comercial: ${res.comercial}</div>` : ''}
              <div style="font-size:11px;color:#6b7280;margin-top:1px">Fuente: ${res.fuente||'DGII'}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;margin-bottom:10px">
            <div style="background:#fff8;border-radius:6px;padding:6px 10px">
              <div style="color:#6b7280;font-size:10px;margin-bottom:2px">RNC / Cédula</div>
              <div style="font-weight:600;color:${estadoColor}">${res.rnc}</div>
            </div>
            <div style="background:#fff8;border-radius:6px;padding:6px 10px">
              <div style="color:#6b7280;font-size:10px;margin-bottom:2px">Estado DGII</div>
              <div style="font-weight:600;color:${estadoColor}">${res.estado}</div>
            </div>
            ${res.regimen ? `<div style="background:#fff8;border-radius:6px;padding:6px 10px">
              <div style="color:#6b7280;font-size:10px;margin-bottom:2px">Régimen de pago</div>
              <div style="font-weight:500;color:#374151;font-size:11px">${res.regimen}</div>
            </div>` : ''}
            ${res.electronico ? `<div style="background:#fff8;border-radius:6px;padding:6px 10px">
              <div style="color:#6b7280;font-size:10px;margin-bottom:2px">Facturador electrónico</div>
              <div style="font-weight:500;color:#374151;font-size:11px">${res.electronico}</div>
            </div>` : ''}
          </div>
          ${res.categoria ? `<div style="font-size:11px;color:#6b7280;margin-bottom:10px;padding:6px 10px;background:#fff8;border-radius:6px">
            <span style="font-weight:600">Actividad:</span> ${res.categoria.substring(0,100)}
          </div>` : ''}
          ${res.estado === 'ACTIVO' ? `
          <div style="padding-top:10px;border-top:1px solid ${estadoBord}">
            <button id="btn-usar-rnc" class="btn btn-dark btn-sm" style="width:100%;background:#065f46;border-color:#065f46">
              ✓ Usar este RNC en el negocio
            </button>
          </div>` : `
          <div style="padding:8px 10px;background:#fef2f2;border-radius:6px;font-size:11px;color:#991b1b">
            ⚠ Este RNC está ${res.estado} — verifica con la DGII antes de usarlo
          </div>`}`;

        // Botón para aplicar el RNC al negocio
        result.querySelector('#btn-usar-rnc')?.addEventListener('click', async () => {
          const btn = result.querySelector('#btn-usar-rnc');
          btn.disabled = true;
          btn.textContent = '⏳ Aplicando...';

          // Guardar RNC en settings
          const rncRes = await window.api.settings.set({ key: 'biz_rnc', value: res.rnc, requestUserId: user.id });
          if (rncRes.ok && typeof CFG !== 'undefined') CFG.rnc = res.rnc;

          // Actualizar el campo RNC en el formulario de configuración (ID real: cfg-biz-rnc)
          const rncInput = document.getElementById('cfg-biz-rnc');
          if (rncInput) rncInput.value = res.rnc;

          // Actualizar nombre si el campo está vacío (ID real: cfg-biz-name)
          const bizInput = document.getElementById('cfg-biz-name');
          if (bizInput && !bizInput.value.trim() && res.nombre) {
            bizInput.value = res.nombre;
            const nameRes = await window.api.settings.set({ key: 'biz_name', value: res.nombre, requestUserId: user.id });
            if (nameRes.ok && typeof CFG !== 'undefined') CFG.biz = res.nombre;
          }

          // Activar módulo fiscal automáticamente al aplicar RNC (solo superadmin)
          const fiscalRes = await window.api.settings.set({ key: 'fiscal_enabled', value: '1', requestUserId: user.id });
          if (fiscalRes.ok && typeof CFG !== 'undefined') CFG.fiscalEnabled = true;
          if (!fiscalRes.ok) {
            toast('RNC aplicado. Pide a un superadmin que active el módulo fiscal desde Configuración.', 'w');
          }

          // Activar visualmente el switch fiscal si está en pantalla
          const fiscalCheck = document.getElementById('cfg-fiscal-enabled');
          if (fiscalCheck) {
            fiscalCheck.checked = true;
            if (typeof toggleFiscal === 'function') toggleFiscal(true);
          }

          // Guardar configuración automáticamente
          if (typeof guardarConfiguracion === 'function') {
            await guardarConfiguracion(true); // true = silent (sin toast duplicado)
          }

          // Recargar configuración
          if (typeof loadAppData === 'function') await loadAppData();

          btn.textContent = '✓ RNC aplicado y fiscal activo';
          btn.style.background = '#065f46';
          if (typeof toast === 'function') toast('✓ RNC ' + res.rnc + ' aplicado — Módulo fiscal activado');
        });

        btn.textContent = 'Validar otro';
        btn.disabled = false;
        btn.addEventListener('click', () => {
          overlay.querySelector('#rnc-val').value = '';
          result.style.display = 'none';
          overlay.querySelector('#rnc-val').focus();
        }, { once: true });
      } else {
        result.style.cssText = 'display:block;padding:14px;border-radius:10px;font-size:13px;margin-top:8px;background:#fef2f2;border:1px solid #fecaca';
        result.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:18px">❌</span>
            <div>
              <div style="font-weight:600;color:#991b1b">RNC no encontrado en la DGII</div>
              <div style="font-size:11px;color:#b91c1c;margin-top:2px">${res.error}</div>
            </div>
          </div>`;
        btn.textContent = 'Intentar de nuevo';
        btn.disabled = false;
      }
    } catch(e) {
      result.style.cssText = 'display:block;padding:12px;border-radius:8px;font-size:13px;margin-top:8px;background:#fef2f2;border:1px solid #fecaca';
      result.innerHTML = `❌ Error de conexión — verifica tu internet`;
      btn.textContent = 'Reintentar';
      btn.disabled = false;
    }
  });

  // Focus automático en el input
  setTimeout(() => overlay.querySelector('#rnc-val')?.focus(), 100);
}

// ── Utilidades ────────────────────────────────
function _sModal(titulo, html, onConfirm, confirmLabel='Guardar') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2)">
        <div style="font-size:15px;font-weight:600">${titulo}</div>
        <button id="sm-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px">${html}</div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="sm-cancel">Cancelar</button>
        <button class="btn btn-dark" id="sm-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#sm-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#sm-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#sm-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#sm-confirm');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try { await onConfirm(overlay); overlay.remove(); }
    catch(e) { btn.disabled = false; btn.textContent = confirmLabel; alert(e.message); }
  });
  return overlay;
}

function _sToast(msg) {
  if (typeof toast === 'function') { toast(msg); return; }
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:8px;font-size:13px;z-index:99999';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
