// ══════════════════════════════════════════════
// envios.js — Envíos y Despachos
// VeloPOS v1.5.6
// Soporta: Vehículo propio + Expreso/Parada
// ══════════════════════════════════════════════

let _enviosVehiculos = [];  // caché de vehículos para el handler delegado del botón
let _enviosCache     = [];  // última lista cargada — para Ver/Editar sin re-consultar
let _enviosView      = 'activos'; // los cancelados viven en Historial, no en la operación diaria
let _enviosRoot      = null;

function _eUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}
const _eFmt   = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _eToday = () => new Date().toISOString().split('T')[0];
const _eEsc   = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

async function _eReload() {
  const target = _enviosRoot || document.getElementById('page') ||
    document.getElementById('main-content') || document.querySelector('.main-content');
  if (target) await renderEnvios(target);
  else if (typeof routeTo === 'function') routeTo('envios');
}

const STATUS_ENV = {
  pendiente:  { label:'Pendiente',  color:'#f59e0b', bg:'#fffbeb' },
  en_camino:  { label:'En camino',  color:'#3b82f6', bg:'#eff6ff' },
  entregado:  { label:'Entregado',  color:'#00c07a', bg:'#f0fdf4' },
  cancelado:  { label:'Cancelado',  color:'#ef4444', bg:'#fef2f2' },
};

function _eBadge(status) {
  const s = STATUS_ENV[status] || STATUS_ENV.pendiente;
  return `<span style="font-size:11px;padding:2px 8px;border-radius:100px;background:${s.bg};color:${s.color};font-weight:600;white-space:nowrap">${s.label}</span>`;
}

// ── Expresos y paradas de RD con tarifas por destino ─────────────────────────
const EXPRESOS_RD = {
  'Caribe Tours': {
    rutas: {
      'Santiago':          { tarifa: 380, tiempo: '1h 30min' },
      'La Vega':           { tarifa: 280, tiempo: '45min' },
      'Puerto Plata':      { tarifa: 480, tiempo: '2h' },
      'Moca':              { tarifa: 320, tiempo: '1h' },
      'San Francisco de Macorís': { tarifa: 420, tiempo: '1h 45min' },
      'Bonao':             { tarifa: 220, tiempo: '35min' },
      'Cotui':             { tarifa: 320, tiempo: '1h 10min' },
      'Santo Domingo':     { tarifa: 450, tiempo: '2h' },
      'Jarabacoa':         { tarifa: 350, tiempo: '1h 20min' },
      'Constanza':         { tarifa: 400, tiempo: '1h 50min' },
      'Salcedo':           { tarifa: 350, tiempo: '1h 15min' },
      'Nagua':             { tarifa: 480, tiempo: '2h 15min' },
      'Samaná':            { tarifa: 550, tiempo: '2h 45min' },
      'Baní':              { tarifa: 520, tiempo: '2h 30min' },
      'Azua':              { tarifa: 580, tiempo: '3h' },
      'San Juan de la Maguana': { tarifa: 680, tiempo: '3h 30min' },
      'Barahona':          { tarifa: 780, tiempo: '4h' },
      'Higüey':            { tarifa: 680, tiempo: '3h' },
      'Punta Cana':        { tarifa: 750, tiempo: '3h 30min' },
      'La Romana':         { tarifa: 620, tiempo: '2h 45min' },
      'San Pedro de Macorís': { tarifa: 550, tiempo: '2h 30min' },
    }
  },
  'Metro Bus': {
    rutas: {
      'Santo Domingo':     { tarifa: 430, tiempo: '2h' },
      'Santiago':          { tarifa: 350, tiempo: '1h 30min' },
      'La Vega':           { tarifa: 260, tiempo: '45min' },
      'Puerto Plata':      { tarifa: 450, tiempo: '2h' },
      'San Francisco de Macorís': { tarifa: 400, tiempo: '1h 45min' },
      'Higüey':            { tarifa: 650, tiempo: '3h' },
      'Punta Cana':        { tarifa: 720, tiempo: '3h 30min' },
    }
  },
  'Expreso Bávaro': {
    rutas: {
      'Punta Cana':        { tarifa: 600, tiempo: '3h 30min' },
      'Bávaro':            { tarifa: 580, tiempo: '3h 20min' },
      'Higüey':            { tarifa: 520, tiempo: '2h 45min' },
      'La Romana':         { tarifa: 480, tiempo: '2h 30min' },
      'San Pedro de Macorís': { tarifa: 420, tiempo: '2h' },
      'Santo Domingo':     { tarifa: 380, tiempo: '2h' },
    }
  },
  'Transporte del Cibao': {
    rutas: {
      'Santiago':          { tarifa: 300, tiempo: '1h 15min' },
      'Moca':              { tarifa: 280, tiempo: '55min' },
      'San Francisco de Macorís': { tarifa: 350, tiempo: '1h 30min' },
      'Salcedo':           { tarifa: 300, tiempo: '1h' },
      'Nagua':             { tarifa: 420, tiempo: '2h' },
      'Puerto Plata':      { tarifa: 420, tiempo: '1h 45min' },
      'Bonao':             { tarifa: 200, tiempo: '30min' },
    }
  },
  'Expreso Línea Sur': {
    rutas: {
      'Santo Domingo':     { tarifa: 420, tiempo: '2h' },
      'Baní':              { tarifa: 480, tiempo: '2h 30min' },
      'Azua':              { tarifa: 550, tiempo: '3h' },
      'San Juan de la Maguana': { tarifa: 650, tiempo: '3h 30min' },
      'Barahona':          { tarifa: 750, tiempo: '4h' },
    }
  },
  'Parada Local': {
    rutas: {
      'Dentro de la ciudad': { tarifa: 250, tiempo: '30-60min' },
      'Municipio cercano':   { tarifa: 350, tiempo: '1h' },
    }
  },
  'Moto Mensajero': {
    rutas: {
      'Local (ciudad)':    { tarifa: 250, tiempo: '20-40min' },
      'Zona norte':        { tarifa: 300, tiempo: '30min' },
      'Zona sur':          { tarifa: 300, tiempo: '30min' },
      'Municipio cercano': { tarifa: 450, tiempo: '45-60min' },
    }
  },
  'Otro / No listado': {
    rutas: {}
  }
};

// ── Render principal ──────────────────────────
async function renderEnvios(el) {
  _enviosRoot = el;
  el.innerHTML = window.experienceLoading?.('Preparando envíos y rutas…') || '<div class="empty"><p>Cargando envíos…</p></div>';
  const user = _eUser();
  if (!user) return;

  if (!window.api?.deliveries) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red,#ef4444)">Módulo de envíos no disponible.</div>';
    return;
  }

  const [sumRes, envRes, vehRes] = await Promise.all([
    window.api.deliveries.getSummary(),
    window.api.deliveries.getAll({ limit: 100 }),
    window.api.vehicles.getAll(),
  ]);

  const summary   = sumRes?.data  || {};
  const envios    = envRes?.data  || [];
  const visibleEnvios = _enviosView === 'historial'
    ? envios.filter(e => e.status === 'cancelado')
    : envios.filter(e => e.status !== 'cancelado');
  const vehiculos = vehRes?.data  || [];
  _enviosVehiculos = vehiculos;  // disponible para el handler delegado
  _enviosCache     = envios;     // para Ver/Editar sin re-consultar

  el.innerHTML = '';

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'sec-hdr';
  hdr.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Envíos y Despachos</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">Control de entregas — Vehículo propio y Expreso/Parada</p>
    </div>
    <button class="btn btn-dark btn-sm" id="btn-nuevo-envio">+ Nuevo envío</button>`;
  el.appendChild(hdr);

  // Métricas
  const metrics = document.createElement('div');
  metrics.className = 'metrics';
  const totalTarifa = envios.filter(e => e.status === 'entregado').reduce((a,e) => a + (e.delivery_fee||0), 0);
  metrics.innerHTML = [
    ['clock', 'a', 'Pendientes', summary.pendiente||0],
    ['truck', 'b', 'En camino', summary.en_camino||0],
    ['check', 'g', 'Entregados', summary.entregado||0],
    ['dollar', 'p', 'Total cobrado', _eFmt(totalTarifa)],
  ].map(([icon, tone, label, val]) => `
    <div class="metric">
      <div class="met-top"><div class="met-icon ${tone}">${svg(icon)}</div></div>
      <div class="met-label">${label}</div>
      <div class="met-val">${val}</div>
    </div>`).join('');
  el.appendChild(metrics);

  const filters = document.createElement('div');
  filters.className = 'envios-viewbar';
  filters.innerHTML = `
    <div class="envios-segments" role="tablist" aria-label="Vista de envíos">
      <button class="envios-segment ${_enviosView === 'activos' ? 'is-active' : ''}" data-envio-view-mode="activos" role="tab" aria-selected="${_enviosView === 'activos'}">
        Vigentes <span>${envios.filter(e => e.status !== 'cancelado').length}</span>
      </button>
      <button class="envios-segment ${_enviosView === 'historial' ? 'is-active' : ''}" data-envio-view-mode="historial" role="tab" aria-selected="${_enviosView === 'historial'}">
        Historial de cancelados <span>${envios.filter(e => e.status === 'cancelado').length}</span>
      </button>
    </div>
    <div class="envios-viewhint">${_enviosView === 'historial' ? 'Solo consulta: un envío cancelado no puede reactivarse.' : 'Los cancelados no se mezclan con la operación diaria.'}</div>`;
  el.appendChild(filters);

  if (!visibleEnvios.length) {
    const empty = document.createElement('div');
    empty.className = 'empty ui-empty-state';
    empty.innerHTML = _enviosView === 'historial'
      ? `<div>${svg('check')}</div><p>Sin envíos cancelados</p><span>El historial está limpio.</span>`
      : `<div>${svg('truck')}</div><p>Sin envíos vigentes</p><span>Registra el primer despacho para comenzar a controlar entregas y tarifas.</span>`;
    el.appendChild(empty);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'card tw ui-table-card';
    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
            <th style="padding:10px 12px;text-align:left">Destino</th>
            <th style="padding:10px 12px;text-align:left">Cliente</th>
            <th style="padding:10px 12px;text-align:left">Vía</th>
            <th style="padding:10px 12px;text-align:right">Distancia</th>
            <th style="padding:10px 12px;text-align:right">Tarifa cobrada</th>
            <th style="padding:10px 12px;text-align:left">Estado</th>
            <th style="padding:10px 12px">Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${visibleEnvios.map(e => {
            // Determinar "Vía" — vehículo propio o expreso
            const via = e.carrier_name
              ? `<span style="color:var(--blue,#3b82f6);font-weight:500">🚌 ${_eEsc(e.carrier_name)}</span>`
              : (e.brand
                ? `<span style="color:var(--muted2)">🚗 ${_eEsc(e.brand)} ${_eEsc(e.model)} ${e.plate?'('+_eEsc(e.plate)+')':''}</span>`
                : '<span style="color:var(--muted2)">—</span>');
            return `
            <tr style="border-bottom:0.5px solid var(--line2)">
              <td style="padding:10px 12px;max-width:180px">
                <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_eEsc(e.dest_address)}</div>
                ${e.carrier_stop ? `<div style="font-size:10px;color:var(--muted2)">Parada: ${_eEsc(e.carrier_stop)}</div>` : ''}
                ${e.carrier_tracking ? `<div style="font-size:10px;color:var(--blue,#3b82f6)">Rastreo: ${_eEsc(e.carrier_tracking)}</div>` : ''}
              </td>
              <td style="padding:10px 12px;color:var(--muted2)">${_eEsc(e.customer_name||'—')}</td>
              <td style="padding:10px 12px">${via}</td>
              <td style="padding:10px 12px;text-align:right;color:var(--muted2)">${e.distance_km ? e.distance_km.toFixed(1)+' km' : '—'}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--green,#00c07a)">${_eFmt(e.delivery_fee)}</td>
              <td style="padding:10px 12px">${_eBadge(e.status)}</td>
              <td style="padding:10px 12px">
                <div class="envios-actions">
                  <button class="env-action env-action-neutral" title="Ver todos los datos" aria-label="Ver envío ${e.id}" data-envio-view="${e.id}">${svg('eye')}<span>Ver</span></button>
                  ${e.status === 'pendiente' ? `<button class="env-action env-action-primary" title="Despachar y marcar en camino" data-envio-id="${e.id}" data-envio-status="en_camino">${svg('truck')}<span>Despachar</span></button>` : ''}
                  ${e.status === 'en_camino' ? `<button class="env-action env-action-success" title="Confirmar que fue entregado" data-envio-id="${e.id}" data-envio-status="entregado">${svg('check')}<span>Entregar</span></button>` : ''}
                  ${['pendiente','en_camino'].includes(e.status) ? `<button class="env-action env-action-neutral env-action-icon" title="Editar envío" aria-label="Editar envío ${e.id}" data-envio-edit="${e.id}">${svg('edit')}</button>` : ''}
                  ${['pendiente','en_camino'].includes(e.status) ? `<button class="env-action env-action-danger env-action-icon" title="Cancelar envío" aria-label="Cancelar envío ${e.id}" data-envio-id="${e.id}" data-envio-status="cancelado">${svg('xmark')}</button>` : ''}
                  ${e.status === 'entregado' ? `<button class="env-action env-action-danger" title="Anular una entrega confirmada" data-envio-id="${e.id}" data-envio-status="cancelado">${svg('xmark')}<span>Anular</span></button>` : ''}
                  ${e.status !== 'cancelado' && e.dest_lat && e.dest_lng ? `<button class="env-action env-action-neutral env-action-icon" title="Abrir destino en el mapa" aria-label="Abrir mapa del envío ${e.id}" data-envio-map="${e.id}">${svg('map-pin')}</button>` : ''}
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    el.appendChild(wrap);
  }

  // Delegación en el contenedor persistente (antes: getElementById tras await,
  // botón quedaba muerto si la vista se re-renderizaba).
  if (!el._enviosDelegated) {
    el._enviosDelegated = true;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('#btn-nuevo-envio')) {
        ev.preventDefault();
        modalNuevoEnvio(el, _enviosVehiculos || []);
        return;
      }
      const viewModeBtn = ev.target.closest('[data-envio-view-mode]');
      if (viewModeBtn) {
        ev.preventDefault();
        _enviosView = viewModeBtn.dataset.envioViewMode === 'historial' ? 'historial' : 'activos';
        _eReload();
        return;
      }
      const viewBtn = ev.target.closest('[data-envio-view]');
      if (viewBtn) { ev.preventDefault(); verEnvio(Number(viewBtn.dataset.envioView)); return; }
      const editBtn = ev.target.closest('[data-envio-edit]');
      if (editBtn) { ev.preventDefault(); editarEnvio(Number(editBtn.dataset.envioEdit)); return; }
      const mapBtn = ev.target.closest('[data-envio-map]');
      if (mapBtn) {
        ev.preventDefault();
        const envio = (_enviosCache || []).find(x => Number(x.id) === Number(mapBtn.dataset.envioMap));
        if (envio?.dest_lat && envio?.dest_lng) abrirMapa(envio.dest_lat, envio.dest_lng, envio.dest_address || '');
        return;
      }
      const statusBtn = ev.target.closest('[data-envio-status]');
      if (statusBtn) {
        ev.preventDefault();
        const id = Number(statusBtn.dataset.envioId);
        const status = statusBtn.dataset.envioStatus;
        if (id && status) window.actualizarEnvio(id, status);
      }
    });
  }
}

// ── Modal nuevo envío ─────────────────────────
function modalNuevoEnvio(parentEl, vehiculos) {
  const user = _eUser();
  const expresoOpts = Object.keys(EXPRESOS_RD)
    .map(e => `<option value="${e}">${e}</option>`).join('');

  const html = `
    <!-- Tipo de envío -->
    <div class="fg">
      <label class="lbl">Tipo de envío *</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="tipo-envio-wrap">
        <div id="tipo-propio" onclick="selTipoEnvio('propio')"
          style="border:2px solid var(--green,#00c07a);border-radius:10px;padding:12px;cursor:pointer;background:rgba(0,192,122,.07);text-align:center">
          <div style="font-size:20px">🚗</div>
          <div style="font-size:12px;font-weight:600;margin-top:4px;color:var(--green,#00c07a)">Vehículo propio</div>
          <div style="font-size:10px;color:var(--muted2)">Flota de la empresa</div>
        </div>
        <div id="tipo-expreso" onclick="selTipoEnvio('expreso')"
          style="border:2px solid var(--line2);border-radius:10px;padding:12px;cursor:pointer;text-align:center">
          <div style="font-size:20px">🚌</div>
          <div style="font-size:12px;font-weight:600;margin-top:4px">Expreso / Parada</div>
          <div style="font-size:10px;color:var(--muted2)">Caribe Tours, Metro, etc.</div>
        </div>
      </div>
    </div>
    <input type="hidden" id="e-tipo" value="propio">

    <!-- Destino (solo vehículo propio — en expreso el destino es la parada) -->
    <div class="fg" id="e-dest-wrap">
      <label class="lbl">Dirección de destino *</label>
      <input class="inp" id="e-dest" placeholder="Ej: Av. Independencia 123, Santiago, RD" autocomplete="off">
      <button class="btn btn-ghost btn-sm" id="btn-geocode" style="margin-top:6px;width:100%">
        🔍 Buscar dirección y marcarla en el mapa
      </button>
      <!-- Mapa (solo vehículo propio): buscar arriba mueve el pin; clic en el mapa lo fija -->
      <div id="e-map-wrap" style="margin-top:8px">
        <div id="e-map" style="height:280px;border-radius:12px;overflow:hidden;border:1px solid var(--line2);background:var(--bg2)"></div>
        <div id="e-map-hint" style="font-size:11px;color:var(--muted2);margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between">
          <span>🏪 <b id="e-origin-label">Tu negocio</b> · 📍 clic en el mapa = destino</span>
          <span style="display:flex;gap:6px">
            <button type="button" class="btn btn-ghost btn-sm" id="btn-origin-detect" style="font-size:10px;padding:2px 8px">📡 Detectar mi ubicación</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-origin-set" style="font-size:10px;padding:2px 8px">✏️ Fijar mi negocio</button>
          </span>
        </div>
      </div>
      <div id="e-map-result" style="display:none;background:var(--bg2);border-radius:8px;padding:9px 12px;font-size:12px;margin-top:8px;border:0.5px solid var(--line2)"></div>
    </div>

    <!-- Cliente — buscador sobre los clientes del sistema -->
    <div class="fg" style="position:relative">
      <label class="lbl">Cliente</label>
      <input class="inp" id="e-customer" placeholder="Busca un cliente o escribe un nombre libre..." autocomplete="off">
      <input type="hidden" id="e-customer-id">
      <div id="e-customer-list" style="display:none;position:absolute;z-index:999;background:var(--bg,#fff);border:1px solid var(--line2,#e5e7eb);border-radius:8px;max-height:220px;overflow-y:auto;box-shadow:0 4px 20px #0003;width:100%;left:0;top:100%"></div>
      <div id="e-customer-info" style="font-size:11px;margin-top:4px;min-height:14px;color:var(--muted2)"></div>
    </div>

    <!-- SECCIÓN VEHÍCULO PROPIO -->
    <div id="sec-propio">
      <div class="fg">
        <label class="lbl">Vehículo de entrega</label>
        <select class="inp" id="e-vehicle">
          <option value="">— Sin vehículo asignado —</option>
          ${vehiculos.filter(v => v.status === 'activo').map(v =>
            `<option value="${v.id}">${v.brand} ${v.model} ${v.plate?'('+v.plate+')':''} · ${v.km_per_gallon}km/gal · ${v.fuel_grade}</option>`
          ).join('')}
        </select>
      </div>
      <div id="e-fuel-result" style="display:none;background:#fef9c3;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:8px;border:0.5px solid #fde68a"></div>
    </div>

    <!-- SECCIÓN EXPRESO/PARADA -->
    <div id="sec-expreso" style="display:none">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg">
          <label class="lbl">Expreso / Parada *</label>
          <select class="inp" id="e-carrier" onchange="onCarrierChange()">
            ${expresoOpts}
          </select>
        </div>
        <div class="fg">
          <label class="lbl">Destino en la parada *</label>
          <select class="inp" id="e-carrier-dest" onchange="onCarrierDestChange()">
            <option value="">— Selecciona destino —</option>
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg">
          <label class="lbl">Parada de origen</label>
          <input class="inp" id="e-carrier-stop" placeholder="Ej: Parada La Vega centro">
        </div>
        <div class="fg">
          <label class="lbl">Número de rastreo / encomienda</label>
          <input class="inp" id="e-carrier-tracking" placeholder="Opcional">
        </div>
      </div>
      <div id="e-carrier-info" style="display:none;background:rgba(59,130,246,.07);border:1px solid var(--blue,#3b82f6);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:8px">
        <div style="font-weight:600;color:var(--blue,#3b82f6);margin-bottom:4px" id="e-carrier-info-title"></div>
        <div id="e-carrier-info-body" style="color:var(--muted2)"></div>
      </div>
    </div>

    <!-- Tarifa y fecha -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg">
        <label class="lbl">Tarifa del envío (RD$) *</label>
        <input class="inp" id="e-fee" type="number" min="0" placeholder="0" style="font-size:16px;font-weight:600">
        <div style="font-size:10px;color:var(--muted2);margin-top:2px" id="e-fee-hint">Ingresa cuánto cobras por este envío</div>
      </div>
      <div class="fg">
        <label class="lbl">Fecha programada</label>
        <input class="inp" id="e-date" type="date" value="${_eToday()}">
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Notas</label>
      <textarea class="inp" id="e-notes" rows="2" placeholder="Instrucciones de entrega, contacto, referencias..."></textarea>
    </div>

    <input type="hidden" id="e-lat">
    <input type="hidden" id="e-lng">
    <input type="hidden" id="e-distance">`;

  const overlay = _eModal('Nuevo envío', html, async (ov) => {
    const tipo  = ov.querySelector('#e-tipo')?.value || 'propio';
    const fee   = parseFloat(ov.querySelector('#e-fee')?.value) || 0;
    if (!fee)  throw new Error('Ingresa la tarifa del envío');

    // Destino según el tipo: vehículo propio usa la dirección escrita/mapa;
    // expreso usa la parada de destino (la dirección física no aplica).
    let dest;
    if (tipo === 'propio') {
      dest = ov.querySelector('#e-dest')?.value.trim();
      if (!dest) throw new Error('La dirección de destino es obligatoria');
    } else {
      const carrier = ov.querySelector('#e-carrier')?.value || '';
      const cdest   = ov.querySelector('#e-carrier-dest')?.value || '';
      if (!carrier) throw new Error('Selecciona el expreso/parada');
      if (!cdest)   throw new Error('Selecciona el destino en la parada');
      dest = cdest;
    }

    // Cliente: si se seleccionó de la lista va vinculado por id; si solo se
    // escribió un nombre (cliente NO registrado) se guarda el texto tal cual.
    const custId   = parseInt(ov.querySelector('#e-customer-id')?.value) || null;
    const custName = String(ov.querySelector('#e-customer')?.value || '').trim();
    const data = {
      dest_address:     dest,
      customer_id:      custId,
      customer_name:    custId ? '' : custName,
      dest_lat:         parseFloat(ov.querySelector('#e-lat')?.value)      || null,
      dest_lng:         parseFloat(ov.querySelector('#e-lng')?.value)      || null,
      distance_km:      parseFloat(ov.querySelector('#e-distance')?.value) || null,
      delivery_fee:     fee,
      scheduled_at:     ov.querySelector('#e-date')?.value || null,
      notes:            ov.querySelector('#e-notes')?.value || '',
      delivery_type:    tipo,
    };

    if (tipo === 'propio') {
      data.vehicle_id = parseInt(ov.querySelector('#e-vehicle')?.value) || null;
      data.driver_id  = user.id;
    } else {
      data.carrier_name     = ov.querySelector('#e-carrier')?.value || '';
      data.carrier_stop     = ov.querySelector('#e-carrier-stop')?.value.trim() || '';
      data.carrier_tracking = ov.querySelector('#e-carrier-tracking')?.value.trim() || '';
      data.carrier_dest     = ov.querySelector('#e-carrier-dest')?.value || '';
      // Datos como lat/lng/distancia solo aplican a vehículo propio
      data.dest_lat = null; data.dest_lng = null; data.distance_km = null;
    }

    const res = await window.api.deliveries.create({ data, requestUserId: user.id });
    if (!res.ok) throw new Error(res.error);
    _eToast('✓ Envío registrado');
    await _eReload();
  }, 'Registrar envío');

  // ── Lógica interactiva del modal ─────────────────────────────────────────
  setTimeout(() => {

    // Selector de tipo de envío
    window.selTipoEnvio = (tipo) => {
      document.getElementById('e-tipo').value = tipo;
      const propioEl   = document.getElementById('tipo-propio');
      const expresoEl  = document.getElementById('tipo-expreso');
      const secPropio  = document.getElementById('sec-propio');
      const secExpreso = document.getElementById('sec-expreso');
      const destWrap = document.getElementById('e-dest-wrap');
      const mapRes = document.getElementById('e-map-result');
      if (tipo === 'propio') {
        propioEl.style.cssText  += ';border-color:var(--green,#00c07a);background:rgba(0,192,122,.07)';
        expresoEl.style.cssText += ';border-color:var(--line2);background:';
        secPropio.style.display  = 'block';
        secExpreso.style.display = 'none';
        document.getElementById('e-fee-hint').textContent = 'Lo que cobras al cliente por el envío';
        // Vehículo propio: dirección + mapa SÍ aplican (destino exacto + distancia).
        if (destWrap) destWrap.style.display = '';
        // Reactivar el mapa (recalcula tamaño; lo monta si aún no existe).
        if (window._enviosInitMap) window._enviosInitMap();
      } else {
        expresoEl.style.cssText += ';border-color:var(--blue,#3b82f6);background:rgba(59,130,246,.07)';
        propioEl.style.cssText  += ';border-color:var(--line2);background:';
        secPropio.style.display  = 'none';
        secExpreso.style.display = 'block';
        document.getElementById('e-fee-hint').textContent = 'Tarifa que cobra el expreso (manual)';
        // Expreso/Parada: la dirección física no aplica — el destino es la parada.
        // Se oculta el bloque completo (input + botón buscar + mapa).
        if (destWrap) destWrap.style.display = 'none';
        if (mapRes)  mapRes.style.display  = 'none';
        onCarrierChange();
      }
    };

    // ── Buscador de clientes del sistema ───────────────────────────────────
    const custInp  = document.getElementById('e-customer');
    const custIdEl = document.getElementById('e-customer-id');
    const custList = document.getElementById('e-customer-list');
    const custInfo = document.getElementById('e-customer-info');
    const _custEsc  = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const _custNorm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    // Refrescar la caché de clientes en segundo plano (el modal no espera)
    if (window.api?.customers?.getAll) {
      window.api.customers.getAll()
        .then(r => { if (Array.isArray(r)) DB.customers = r; })
        .catch(() => {});
    }

    function _custSelect(c) {
      custInp.value  = c.name;
      custIdEl.value = c.id;
      const parts = [];
      if (c.phone)   parts.push(`📞 ${_custEsc(c.phone)}`);
      if (c.address) parts.push(`📍 ${_custEsc(c.address)}`);
      custInfo.innerHTML = `<span style="color:var(--green,#00c07a)">✓ Cliente vinculado</span>${parts.length ? ' · ' + parts.join(' · ') : ''}`;
      custList.style.display = 'none';
      // Vehículo propio: si el cliente tiene dirección y aún no escribiste una, se usa la suya
      const destInp = document.getElementById('e-dest');
      if (document.getElementById('e-tipo')?.value === 'propio' && c.address && destInp && !destInp.value.trim()) {
        destInp.value = c.address;
      }
    }

    function _custRender(filter) {
      if (!custList) return;
      const raw = String(filter || '').trim();
      const q = _custNorm(raw);
      const all = (DB?.customers || []).filter(c => c.active !== 0);
      const matches = q
        ? all.filter(c => _custNorm(c.name).includes(q) ||
                          String(c.phone || '').includes(raw) ||
                          String(c.rnc   || '').includes(raw))
        : all;
      if (!matches.length) { custList.style.display = 'none'; return; }
      custList.innerHTML = matches.slice(0, 8).map(c => `
        <div data-cid="${c.id}" style="padding:9px 14px;cursor:pointer;border-bottom:0.5px solid var(--line2,#eee)"
             onmouseenter="this.style.background='var(--bg2,#f5f5f5)'" onmouseleave="this.style.background=''">
          <div style="font-size:13px;font-weight:500">${_custEsc(c.name)}</div>
          <div style="font-size:10px;color:var(--muted2,#888)">${[c.phone, c.rnc].filter(Boolean).map(_custEsc).join(' · ') || 'Sin datos de contacto'}</div>
        </div>`).join('');
      custList.style.display = 'block';
      custList.querySelectorAll('[data-cid]').forEach(div => {
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const c = (DB?.customers || []).find(x => x.id === Number(div.dataset.cid));
          if (c) _custSelect(c);
        });
      });
    }

    custInp?.addEventListener('input', () => {
      // Al editar el texto se pierde el vínculo — debe re-seleccionar de la lista
      custIdEl.value = '';
      custInfo.innerHTML = custInp.value.trim()
        ? '<span style="color:var(--muted2,#6b7280)">Se guardará como cliente no registrado — selecciónalo de la lista si quieres vincularlo</span>'
        : '';
      _custRender(custInp.value);
    });
    custInp?.addEventListener('focus', () => _custRender(custInp.value));
    document.addEventListener('mousedown', (e) => {
      if (custList && !custInp?.contains(e.target) && !custList.contains(e.target)) {
        custList.style.display = 'none';
      }
    });

    // Cambio de expreso — cargar destinos
    window.onCarrierChange = () => {
      const carrier = document.getElementById('e-carrier')?.value;
      const destSel = document.getElementById('e-carrier-dest');
      if (!destSel) return;
      const rutas = EXPRESOS_RD[carrier]?.rutas || {};
      // Solo el nombre del destino — la tarifa de expreso/parada se ingresa MANUAL.
      destSel.innerHTML = '<option value="">— Selecciona destino —</option>' +
        Object.keys(rutas).map(d => `<option value="${d}">${d}</option>`).join('');
      document.getElementById('e-carrier-info').style.display = 'none';
    };

    // Cambio de destino — la tarifa es MANUAL para expresos/paradas (no se rellena).
    window.onCarrierDestChange = () => {
      const carrier = document.getElementById('e-carrier')?.value;
      const dest    = document.getElementById('e-carrier-dest')?.value;
      const infoBox = document.getElementById('e-carrier-info');
      if (!carrier || !dest) { if (infoBox) infoBox.style.display = 'none'; return; }
      infoBox.style.display = 'block';
      document.getElementById('e-carrier-info-title').textContent = `${carrier} → ${dest}`;
      document.getElementById('e-carrier-info-body').innerHTML =
        'Ingresa manualmente la tarifa que cobró el expreso por esta encomienda.';
      const feeInp = document.getElementById('e-fee');
      if (feeInp) feeInp.focus();
    };

    // Geocoding
    const btnGeo  = document.getElementById('btn-geocode');
    const vSelect = document.getElementById('e-vehicle');

    const calcular = async () => {
      const addr = document.getElementById('e-dest')?.value.trim();
      if (!addr) { alert('Ingresa una dirección primero'); return; }
      btnGeo.disabled = true;
      btnGeo.textContent = '⏳ Buscando...';
      const mapResult = document.getElementById('e-map-result');
      try {
        // El geocoding corre en el proceso main (vía IPC): el CSP del renderer
        // bloquea los fetch externos, por eso antes daba "Failed to fetch".
        const res = await window.api.deliveries.geocode({ address: addr });
        if (!res?.ok) throw new Error(res?.error || 'No se pudo buscar la dirección');
        const { lat, lng, display_name } = res;
        // UNIFICADO con el mapa: centrar y soltar el pin. setDestPin se encarga de la
        // dirección, la distancia real por carretera y el combustible — mismo camino
        // que hacer clic en el mapa (una sola fuente de verdad, sin cajita aparte).
        if (_map) {
          _map.setView([lat, lng], 15);
          await setDestPin(lat, lng);
        } else {
          // Fallback sin mapa (offline): resultado de texto.
          document.getElementById('e-lat').value = lat;
          document.getElementById('e-lng').value = lng;
          const distKm = res.distance_km != null ? String(res.distance_km) : null;
          if (distKm != null) document.getElementById('e-distance').value = distKm;
          mapResult.style.display = 'block';
          mapResult.style.background = 'var(--bg2)'; mapResult.style.borderColor = 'var(--line2)';
          mapResult.innerHTML = `📍 <strong>${(display_name || '').split(',').slice(0,3).join(', ')}</strong>${distKm != null ? ` · 📏 <strong>${distKm} km</strong>` : ''}`;
          if ((document.getElementById('e-tipo')?.value) === 'propio' && distKm != null) await calcularCombustible(distKm, vSelect?.value);
        }
      } catch(err) {
        mapResult.style.display = 'block';
        mapResult.style.background = '#fef2f2';
        mapResult.style.borderColor = '#fecaca';
        mapResult.innerHTML = `⚠ ${err.message}`;
      } finally {
        btnGeo.disabled = false;
        btnGeo.textContent = '🔍 Buscar dirección y marcarla en el mapa';
      }
    };

    const calcularCombustible = async (distKm, vehicleIdRaw) => {
      const vehicleId = parseInt(vehicleIdRaw);
      const fuelResult = document.getElementById('e-fuel-result');
      if (!vehicleId || !distKm || !fuelResult) return;
      const vehicleObj = vehiculos.find(v => v.id === vehicleId);
      try {
        const fuelRes = await window.api.vehicles.calcFuel({ vehicleId, distanceKm: parseFloat(distKm), requestUserId: user.id });
        if (!fuelRes?.ok) return;
        const d = fuelRes.data;
        const prices   = window._fuelPrices || { premium: 335.10, regular: 307.50, diesel: 287.10 };
        const precio   = prices[d.fuel_grade] || prices.premium;
        const costoFuel= (d.gallons * 2) * precio;
        fuelResult.style.display = 'block';
        fuelResult.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div>
              <div style="font-size:10px;color:var(--muted2);font-weight:600">⛽ COSTO COMBUSTIBLE (ida y vuelta)</div>
              <div style="font-size:15px;font-weight:700;color:var(--red,#ef4444)">${_eFmt(costoFuel)}</div>
              <div style="font-size:10px;color:var(--muted2)">${(d.gallons*2).toFixed(2)} gal · ${d.fuel_grade} a ${_eFmt(precio)}/gal</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:10px;color:var(--muted2);font-weight:600">💡 REFERENCIA</div>
              <div style="font-size:11px;color:var(--muted2)">Incluye ida y vuelta<br>La tarifa es lo que cobras al cliente</div>
            </div>
          </div>`;
      } catch(e) { console.warn('[Envíos] Combustible:', e.message); }
    };

    btnGeo?.addEventListener('click', calcular);
    vSelect?.addEventListener('change', () => {
      const distKm = document.getElementById('e-distance')?.value;
      if (distKm) calcularCombustible(distKm, vSelect.value);
    });

    // ── Mapa interactivo (Leaflet) para vehículo propio ──────────────────────
    let _map = null, _destMarker = null, _originMarker = null, _setOriginMode = false;
    let _origin = { lat: 19.2207, lng: -70.5291, label: 'RD' };
    const _pinIcon = (emoji) => window.L.divIcon({
      html: `<div style="font-size:26px;line-height:26px;filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))">${emoji}</div>`,
      className: '', iconSize: [26, 26], iconAnchor: [13, 24],
    });
    const _setOriginLabel = (txt) => { const el = document.getElementById('e-origin-label'); if (el) el.textContent = txt; };

    // Fija el ORIGEN (tu negocio): mueve el marcador 🏪, lo guarda de forma
    // persistente y recalcula la distancia si ya hay un destino puesto.
    const applyOrigin = (lat, lng, { save = true, reverseLabel = true } = {}) => {
      _origin = { lat, lng, label: _origin.label, fallback: false };
      if (_originMarker) _originMarker.setLatLng([lat, lng]);
      if (_map) _map.setView([lat, lng], Math.max(_map.getZoom ? _map.getZoom() : 14, 14));
      if (save) window.api.deliveries.setOrigin({ lat, lng }).catch(() => {});
      if (reverseLabel) {
        window.api.deliveries.reverseGeocode({ lat, lng }).then(r => {
          if (r?.ok) _setOriginLabel((r.address || '').split(',').slice(0, 2).join(', ') || 'Mi negocio');
        }).catch(() => {});
      }
      if (_destMarker) { const p = _destMarker.getLatLng(); setDestPin(p.lat, p.lng); } // recalcular
    };

    // Detectar ubicación actual (geolocalización). En PC de escritorio no hay GPS →
    // suele ser aproximada o fallar; si falla, se guía a fijarla manualmente (exacto).
    const detectLocation = () => {
      const btn = document.getElementById('btn-origin-detect');
      const restore = () => { if (btn) { btn.disabled = false; btn.textContent = '📡 Detectar mi ubicación'; } };
      if (btn) { btn.disabled = true; btn.textContent = '📡 Detectando…'; }

      // Fallback: geolocalización por IP (aproximada) → centra el mapa en tu zona.
      const tryIP = async () => {
        if (btn) btn.textContent = '📡 Buscando por internet…';
        try {
          const r = await window.api.deliveries.ipLocate();
          restore();
          if (r?.ok) {
            applyOrigin(r.lat, r.lng);
            if (_map) _map.setView([r.lat, r.lng], 15);
            alert(`📍 Ubicación aproximada por internet${r.city ? ` (${r.city})` : ''}.\n\n⚠ Es solo la ZONA. ARRASTRA el pin 🏪 al punto EXACTO de tu local para que la distancia sea precisa (queda guardado).`);
          } else {
            alert('No se pudo detectar la ubicación.\n\nUsa "✏️ Fijar mi negocio" y haz clic en tu local en el mapa — así queda exacto.');
          }
        } catch { restore(); alert('No se pudo detectar. Usa "✏️ Fijar mi negocio".'); }
      };

      // 1) Intentar la geolocalización del navegador (más precisa si el equipo la tiene).
      if (!navigator.geolocation) { tryIP(); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => { applyOrigin(pos.coords.latitude, pos.coords.longitude); restore();
          if (_map) _map.setView([pos.coords.latitude, pos.coords.longitude], 16);
          alert('📍 Ubicación detectada. Verifica el pin 🏪 y arrástralo si no cayó exacto sobre tu local.'); },
        () => { tryIP(); },   // navegador falló (sin GPS) → IP
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    };

    const setDestPin = async (lat, lng) => {
      if (!_map) return;
      if (_destMarker) _destMarker.setLatLng([lat, lng]);
      else {
        _destMarker = window.L.marker([lat, lng], { icon: _pinIcon('📍'), draggable: true }).addTo(_map);
        _destMarker.on('dragend', (ev) => { const p = ev.target.getLatLng(); setDestPin(p.lat, p.lng); });
      }
      document.getElementById('e-lat').value = lat;
      document.getElementById('e-lng').value = lng;
      const mr = document.getElementById('e-map-result');
      mr.style.display = 'block'; mr.style.background = 'var(--bg2)'; mr.style.borderColor = 'var(--line2)';
      mr.innerHTML = '⏳ Calculando dirección y distancia…';
      // Dirección (geocodificación inversa) — rellena el campo si está vacío.
      window.api.deliveries.reverseGeocode({ lat, lng }).then(r => {
        if (r?.ok) {
          const di = document.getElementById('e-dest');
          if (di && !di.value.trim()) di.value = (r.address || '').split(',').slice(0, 3).join(', ');
        }
      }).catch(() => {});
      // Distancia real por carretera desde el negocio.
      try {
        const rt = await window.api.deliveries.route({ originLat: _origin.lat, originLng: _origin.lng, destLat: lat, destLng: lng });
        const distKm = (rt?.ok && rt.distance_km != null) ? rt.distance_km : null;
        if (distKm != null) document.getElementById('e-distance').value = distKm;
        mr.innerHTML = distKm != null
          ? `📍 Destino fijado · 📏 <strong>${distKm} km</strong> por carretera${rt.duration_min ? ` · ⏱ ~${rt.duration_min} min` : ''}`
          : '📍 Destino fijado (no se pudo calcular la distancia — revisa la conexión)';
        if (distKm != null) await calcularCombustible(String(distKm), document.getElementById('e-vehicle')?.value);
      } catch { mr.innerHTML = '📍 Destino fijado (sin distancia — sin conexión)'; }
    };

    const initMap = async () => {
      const el = document.getElementById('e-map');
      // Sin Leaflet (offline/no cargó) → ocultar el mapa; queda el buscador por texto.
      if (!window.L || !el) { const w = document.getElementById('e-map-wrap'); if (w) w.style.display = 'none'; return; }
      if (_map) { setTimeout(() => _map.invalidateSize(), 60); return; }
      try {
        const oRes = await window.api.deliveries.getOrigin();
        if (oRes?.ok) _origin = oRes;
      } catch {}
      _setOriginLabel(_origin.fallback ? '⚠ ajusta tu negocio →' : (_origin.label || 'Tu negocio'));
      _map = window.L.map(el, { zoomControl: true, attributionControl: true }).setView([_origin.lat, _origin.lng], 13);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19,
      }).addTo(_map);
      // Marcador de ORIGEN (negocio) — arrastrable: soltar = fijar/guardar origen.
      _originMarker = window.L.marker([_origin.lat, _origin.lng], { icon: _pinIcon('🏪'), draggable: true }).addTo(_map)
        .bindTooltip('Tu negocio — arrástrame para ajustar la ubicación');
      _originMarker.on('dragend', (ev) => { const p = ev.target.getLatLng(); applyOrigin(p.lat, p.lng); });
      // Clic en el mapa: en modo "fijar negocio" mueve el origen; si no, pone destino.
      _map.on('click', (e) => {
        if (_setOriginMode) {
          _setOriginMode = false;
          applyOrigin(e.latlng.lat, e.latlng.lng);
        } else {
          setDestPin(e.latlng.lat, e.latlng.lng);
        }
      });
      // Botones de origen.
      document.getElementById('btn-origin-detect')?.addEventListener('click', detectLocation);
      document.getElementById('btn-origin-set')?.addEventListener('click', () => {
        _setOriginMode = true;
        alert('Haz clic en el mapa sobre la ubicación EXACTA de tu negocio. Quedará guardada.');
      });
      // El contenedor pudo renderizarse oculto → recalcular tamaño de tiles.
      setTimeout(() => _map.invalidateSize(), 250);
    };
    // Exponer para que selTipoEnvio reactive el mapa al volver a "propio".
    window._enviosInitMap = initMap;

    // Inicializar destinos del primer expreso
    onCarrierChange();
    // El tipo por defecto es "propio" → montar el mapa.
    initMap();

  }, 150);
}

// ── Ver detalle del envío (todos los estados) ─────────────────────────────────
function verEnvio(id) {
  const e = (_enviosCache || []).find(x => Number(x.id) === Number(id));
  if (!e) { _eToast('No se encontró el envío'); return; }
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const st  = STATUS_ENV[e.status] || { label: e.status, color: 'var(--muted2)', bg: 'var(--bg2)' };
  const esExpreso = e.delivery_type === 'expreso' || !!e.carrier_name;
  const fila = (lbl, val) => val ? `
    <div style="display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:0.5px solid var(--line2)">
      <span style="color:var(--muted2);flex-shrink:0">${lbl}</span>
      <span style="text-align:right;font-weight:500">${val}</span>
    </div>` : '';
  const fecha = v => v ? String(v).replace('T', ' ').slice(0, 16) : '';
  const html = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="background:${st.bg};color:${st.color};font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">${st.label}</span>
      <span style="font-size:12px;color:var(--muted2)">${esExpreso ? '🚌 Expreso/Parada' : '🚗 Vehículo propio'}</span>
    </div>
    <div style="font-size:12.5px">
      ${fila('Destino', esc(e.dest_address))}
      ${fila('Parada', esc(e.carrier_stop))}
      ${fila('Expreso', esc(e.carrier_name))}
      ${fila('Rastreo', esc(e.carrier_tracking))}
      ${fila('Cliente', esc(e.customer_name))}
      ${fila('Vehículo', e.brand ? esc(`${e.brand} ${e.model || ''} ${e.plate ? '(' + e.plate + ')' : ''}`) : '')}
      ${fila('Distancia', e.distance_km ? e.distance_km.toFixed(1) + ' km' : '')}
      ${fila('Combustible est.', e.fuel_cost ? _eFmt(e.fuel_cost) + (e.fuel_used ? ` · ${e.fuel_used.toFixed(2)} gal` : '') : '')}
      ${fila('Tarifa cobrada', `<span style="color:var(--green,#00c07a);font-weight:700">${_eFmt(e.delivery_fee)}</span>`)}
      ${fila('Gasto vinculado', e.expense_id ? `Gasto #${e.expense_id} (módulo Gastos)` : '')}
      ${fila('Creado', fecha(e.created_at))}
      ${fila('Programado', fecha(e.scheduled_at))}
      ${fila('Entregado', fecha(e.delivered_at))}
      ${fila('Notas', esc(e.notes))}
    </div>`;
  const ov = _eModal(`Envío #${id} — Detalle`, html, async () => {}, 'Cerrar');
  ov.querySelector('#em-cancel')?.remove();
}

// ── Editar envío (solo pendiente / en camino) ─────────────────────────────────
function editarEnvio(id) {
  const e = (_enviosCache || []).find(x => Number(x.id) === Number(id));
  if (!e) { _eToast('No se encontró el envío'); return; }
  if (!['pendiente', 'en_camino'].includes(e.status)) {
    _eToast('Solo se pueden editar envíos pendientes o en camino'); return;
  }
  const user = _eUser();
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const esExpreso = e.delivery_type === 'expreso' || !!e.carrier_name;
  const feeLocked = !!e.expense_id;
  const nombreOriginal = e.customer_name || '';
  const html = `
    <div class="fg">
      <label class="lbl">Destino *</label>
      <input class="inp" id="ee-dest" value="${esc(e.dest_address)}">
    </div>
    <div class="fg">
      <label class="lbl">Cliente</label>
      <input class="inp" id="ee-customer" value="${esc(nombreOriginal)}" placeholder="Nombre del cliente (libre)">
      <div style="font-size:10px;color:var(--muted2);margin-top:3px">Si lo cambias se guarda como cliente no registrado</div>
    </div>
    <div class="fg">
      <label class="lbl">Tarifa cobrada (RD$)</label>
      <input class="inp" id="ee-fee" type="number" min="0" step="0.01" value="${e.delivery_fee || 0}" ${feeLocked ? 'disabled' : ''}>
      ${feeLocked ? '<div style="font-size:10px;color:var(--amber,#f59e0b);margin-top:3px">Bloqueada: este envío ya generó un gasto</div>' : ''}
    </div>
    ${esExpreso ? `
    <div class="fg">
      <label class="lbl">No. de rastreo</label>
      <input class="inp" id="ee-tracking" value="${esc(e.carrier_tracking)}">
    </div>` : ''}
    <div class="fg">
      <label class="lbl">Fecha programada</label>
      <input class="inp" id="ee-date" type="date" value="${String(e.scheduled_at || '').split('T')[0].split(' ')[0]}">
    </div>
    <div class="fg">
      <label class="lbl">Notas</label>
      <textarea class="inp" id="ee-notes" rows="2">${esc(e.notes)}</textarea>
    </div>`;
  _eModal(`Editar envío #${id}`, html, async (ov) => {
    const dest = ov.querySelector('#ee-dest')?.value.trim();
    if (!dest) throw new Error('El destino es obligatorio');
    const nombre = ov.querySelector('#ee-customer')?.value.trim() || '';
    const data = {
      dest_address: dest,
      notes:        ov.querySelector('#ee-notes')?.value || '',
      scheduled_at: ov.querySelector('#ee-date')?.value || null,
    };
    // Cliente: solo se toca si cambió el texto — cambiarlo desvincula el
    // cliente registrado y guarda el nombre libre.
    if (nombre !== nombreOriginal) { data.customer_name = nombre; data.customer_id = null; }
    if (!feeLocked) data.delivery_fee = parseFloat(ov.querySelector('#ee-fee')?.value) || 0;
    if (esExpreso) data.carrier_tracking = ov.querySelector('#ee-tracking')?.value.trim() || '';
    const res = await window.api.deliveries.update({ id, data, requestUserId: user.id });
    if (!res?.ok) throw new Error(res?.error || 'No se pudo guardar');
    _eToast('✓ Envío actualizado');
    await _eReload();
  }, 'Guardar cambios');
}

// ── Actualizar estado del envío ───────────────
window.actualizarEnvio = async (id, status) => {
  const user   = _eUser();
  const env    = (_enviosCache || []).find(x => Number(x.id) === Number(id));
  const labels = {
    en_camino: '¿Marcar como En camino?',
    entregado: '¿Confirmar entrega?',
    cancelado: env?.status === 'entregado'
      ? '¿Anular este envío ENTREGADO? Si generó un gasto (combustible/mensajería), se anulará y sus asientos se reversarán.'
      : '¿Cancelar este envío? Si ya generó un gasto, se anulará también.'
  };
  if (!confirm(labels[status] || '¿Actualizar estado?')) return;

  const res = await window.api.deliveries.updateStatus({ id, status, requestUserId: user.id });
  if (!res.ok) { alert(res.error); return; }

  // El gasto del envío lo registra el proceso main (deliveries:updateStatus):
  // expreso → tarifa al despachar; vehículo propio → combustible al entregar.
  // Antes se creaba aquí y quedaba mal: categoría ignorada y estado "pagado"
  // sin ningún pago real registrado.
  const labels2 = { en_camino: 'En camino 🚚', entregado: 'Entregado ✅', cancelado: 'Cancelado' };
  if (res.expenseWarning) {
    _eToast(`⚠ Envío actualizado, pero el gasto: ${res.expenseWarning}`);
  } else if (res.expenseId) {
    _eToast(`✓ Envío ${labels2[status] || status} · gasto registrado en Gastos`);
  } else {
    _eToast(`✓ Envío marcado como: ${labels2[status] || status}`);
  }

  // Recargar en tiempo real
  await _eReload();
};

window.abrirMapa = (lat, lng, address) => {
  const url = `https://www.google.com/maps?q=${lat},${lng}`;
  if (window.api?.shell?.openExternal) window.api.shell.openExternal(url);
  else window.open(url, '_blank');
};

function _eModal(titulo, html, onConfirm, confirmLabel = 'Guardar') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:600px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2);position:sticky;top:0;background:var(--bg);z-index:1">
        <div style="font-size:15px;font-weight:600">${titulo}</div>
        <button id="em-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px" id="em-body">${html}</div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:var(--bg)">
        <button class="btn btn-ghost" id="em-cancel">Cancelar</button>
        <button class="btn btn-dark" id="em-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // Protección de datos sin guardar (misma lógica global que openModal):
  // snapshot inicial + cierre inteligente. _snapshotForm/_formIsDirty/etc. son
  // globales (definidos en app.js) y se invocan en tiempo de click.
  const _snap = (typeof _snapshotForm === 'function') ? _snapshotForm(overlay) : null;
  const box   = overlay.firstElementChild;
  const tryClose = async () => {
    if (_snap && typeof _formIsDirty === 'function' && _formIsDirty(_snap)) {
      if (typeof _confirmDiscard === 'function' && !(await _confirmDiscard())) return;
    }
    overlay.remove();
  };
  // Click en el backdrop: cierra solo si está limpio; si hay datos, shake y no cierra.
  overlay.addEventListener('click', e => {
    if (e.target !== overlay) return;
    if (_snap && typeof _formIsDirty === 'function' && _formIsDirty(_snap)) {
      if (typeof _shakeEl === 'function') _shakeEl(box);
      return;
    }
    overlay.remove();
  });
  overlay.querySelector('#em-close')?.addEventListener('click',  tryClose);
  overlay.querySelector('#em-cancel')?.addEventListener('click', tryClose);
  overlay.querySelector('#em-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#em-confirm');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try { await onConfirm(overlay); overlay.remove(); }
    catch(e) { btn.disabled = false; btn.textContent = confirmLabel; alert(e.message); }
  });
  return overlay;
}

function _eToast(msg) {
  if (typeof toast === 'function') { toast(msg); return; }
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:8px;font-size:13px;z-index:99999';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
