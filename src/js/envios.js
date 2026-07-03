// ══════════════════════════════════════════════
// envios.js — Envíos y Despachos
// VeloPOS v1.5.6
// Soporta: Vehículo propio + Expreso/Parada
// ══════════════════════════════════════════════

let _enviosVehiculos = [];  // caché de vehículos para el handler delegado del botón

function _eUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}
const _eFmt   = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _eToday = () => new Date().toISOString().split('T')[0];

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
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Cargando envíos...</div>';
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
  const vehiculos = vehRes?.data  || [];
  _enviosVehiculos = vehiculos;  // disponible para el handler delegado

  el.innerHTML = '';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px';
  hdr.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Envíos y Despachos</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">Control de entregas — Vehículo propio y Expreso/Parada</p>
    </div>
    <button class="btn btn-dark btn-sm" id="btn-nuevo-envio">+ Nuevo envío</button>`;
  el.appendChild(hdr);

  // Métricas
  const metrics = document.createElement('div');
  metrics.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px';
  const totalTarifa = envios.filter(e => e.status === 'entregado').reduce((a,e) => a + (e.delivery_fee||0), 0);
  metrics.innerHTML = [
    ['📦 Pendientes', summary.pendiente||0, '#f59e0b'],
    ['🚚 En camino',  summary.en_camino||0, '#3b82f6'],
    ['✅ Entregados', summary.entregado||0, '#00c07a'],
    ['💰 Total cobrado', _eFmt(totalTarifa), '#8b5cf6'],
  ].map(([label, val, color]) => `
    <div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:0.5px solid var(--line2)">
      <div style="font-size:11px;color:var(--muted2);margin-bottom:4px">${label}</div>
      <div style="font-size:18px;font-weight:600;color:${color}">${val}</div>
    </div>`).join('');
  el.appendChild(metrics);

  if (!envios.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:48px;color:var(--muted2);background:var(--bg2);border-radius:10px;border:0.5px solid var(--line2)';
    empty.innerHTML = '<div style="font-size:36px">📦</div><div style="margin-top:8px;font-size:13px">Sin envíos registrados</div>';
    el.appendChild(empty);
  } else {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;background:var(--bg2);border-radius:10px;border:0.5px solid var(--line2)';
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
          ${envios.map(e => {
            // Determinar "Vía" — vehículo propio o expreso
            const via = e.carrier_name
              ? `<span style="color:var(--blue,#3b82f6);font-weight:500">🚌 ${e.carrier_name}</span>`
              : (e.brand
                ? `<span style="color:var(--muted2)">🚗 ${e.brand} ${e.model} ${e.plate?'('+e.plate+')':''}</span>`
                : '<span style="color:var(--muted2)">—</span>');
            return `
            <tr style="border-bottom:0.5px solid var(--line2)">
              <td style="padding:10px 12px;max-width:180px">
                <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.dest_address}</div>
                ${e.carrier_stop ? `<div style="font-size:10px;color:var(--muted2)">Parada: ${e.carrier_stop}</div>` : ''}
                ${e.carrier_tracking ? `<div style="font-size:10px;color:var(--blue,#3b82f6)">Rastreo: ${e.carrier_tracking}</div>` : ''}
              </td>
              <td style="padding:10px 12px;color:var(--muted2)">${e.customer_name||'—'}</td>
              <td style="padding:10px 12px">${via}</td>
              <td style="padding:10px 12px;text-align:right;color:var(--muted2)">${e.distance_km ? e.distance_km.toFixed(1)+' km' : '—'}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--green,#00c07a)">${_eFmt(e.delivery_fee)}</td>
              <td style="padding:10px 12px">${_eBadge(e.status)}</td>
              <td style="padding:10px 12px">
                <div style="display:flex;gap:4px">
                  ${e.status === 'pendiente' ? `<button class="btn btn-ghost btn-sm" style="color:var(--blue)" title="Marcar en camino" data-envio-id="${e.id}" data-envio-status="en_camino">🚚</button>` : ''}
                  ${e.status === 'en_camino' ? `<button class="btn btn-ghost btn-sm" style="color:var(--green)" title="Confirmar entrega" data-envio-id="${e.id}" data-envio-status="entregado">✅</button>` : ''}
                  ${e.status === 'pendiente' ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" title="Cancelar" data-envio-id="${e.id}" data-envio-status="cancelado">✗</button>` : ''}
                  ${e.dest_lat && e.dest_lng ? `<button class="btn btn-ghost btn-sm" title="Ver en mapa" onclick="abrirMapa(${e.dest_lat},${e.dest_lng},'${(e.dest_address||'').replace(/'/g,'')}')">🗺</button>` : ''}
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

    <!-- Destino -->
    <div class="fg">
      <label class="lbl">Dirección de destino *</label>
      <input class="inp" id="e-dest" placeholder="Ej: Av. Independencia 123, Santiago, RD" autocomplete="off">
      <button class="btn btn-ghost btn-sm" id="btn-geocode" style="margin-top:6px;width:100%">
        📍 Buscar dirección y calcular distancia
      </button>
    </div>
    <div id="e-map-result" style="display:none;background:var(--bg2);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:10px;border:0.5px solid var(--line2)"></div>

    <!-- Cliente -->
    <div class="fg">
      <label class="lbl">Cliente</label>
      <input class="inp" id="e-customer" placeholder="Nombre del cliente (opcional)">
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
    const dest  = ov.querySelector('#e-dest')?.value.trim();
    const tipo  = ov.querySelector('#e-tipo')?.value || 'propio';
    const fee   = parseFloat(ov.querySelector('#e-fee')?.value) || 0;
    if (!dest) throw new Error('La dirección de destino es obligatoria');
    if (!fee)  throw new Error('Ingresa la tarifa del envío');

    const data = {
      dest_address:     dest,
      customer_id:      null,
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
    }

    const res = await window.api.deliveries.create({ data, requestUserId: user.id });
    if (!res.ok) throw new Error(res.error);
    _eToast('✓ Envío registrado');
    renderEnvios(document.getElementById('main-content') || parentEl);
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
      if (tipo === 'propio') {
        propioEl.style.cssText  += ';border-color:var(--green,#00c07a);background:rgba(0,192,122,.07)';
        expresoEl.style.cssText += ';border-color:var(--line2);background:';
        secPropio.style.display  = 'block';
        secExpreso.style.display = 'none';
        document.getElementById('e-fee-hint').textContent = 'Lo que cobras al cliente por el envío';
      } else {
        expresoEl.style.cssText += ';border-color:var(--blue,#3b82f6);background:rgba(59,130,246,.07)';
        propioEl.style.cssText  += ';border-color:var(--line2);background:';
        secPropio.style.display  = 'none';
        secExpreso.style.display = 'block';
        document.getElementById('e-fee-hint').textContent = 'Tarifa que cobra el expreso (editable)';
        onCarrierChange();
      }
    };

    // Cambio de expreso — cargar destinos
    window.onCarrierChange = () => {
      const carrier = document.getElementById('e-carrier')?.value;
      const destSel = document.getElementById('e-carrier-dest');
      if (!destSel) return;
      const rutas = EXPRESOS_RD[carrier]?.rutas || {};
      destSel.innerHTML = '<option value="">— Selecciona destino —</option>' +
        Object.keys(rutas).map(d =>
          `<option value="${d}">${d} — ${_eFmt(rutas[d].tarifa)} · ${rutas[d].tiempo}</option>`
        ).join('');
      document.getElementById('e-carrier-info').style.display = 'none';
    };

    // Cambio de destino — llenar tarifa automática
    window.onCarrierDestChange = () => {
      const carrier = document.getElementById('e-carrier')?.value;
      const dest    = document.getElementById('e-carrier-dest')?.value;
      const feeInp  = document.getElementById('e-fee');
      const infoBox = document.getElementById('e-carrier-info');
      if (!carrier || !dest) return;
      const ruta = EXPRESOS_RD[carrier]?.rutas[dest];
      if (!ruta) return;
      if (feeInp) feeInp.value = ruta.tarifa;
      // Mostrar info del expreso
      infoBox.style.display = 'block';
      document.getElementById('e-carrier-info-title').textContent =
        `${carrier} → ${dest}`;
      document.getElementById('e-carrier-info-body').innerHTML =
        `Tiempo estimado: ${ruta.tiempo} · Tarifa estándar: ${_eFmt(ruta.tarifa)}<br>
         <span style="font-size:10px">Puedes modificar la tarifa si el expreso cobró diferente</span>`;
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
        const distKm = res.distance_km != null ? String(res.distance_km) : null;
        document.getElementById('e-lat').value = lat;
        document.getElementById('e-lng').value = lng;
        if (distKm != null) document.getElementById('e-distance').value = distKm;
        mapResult.style.display = 'block';
        mapResult.style.background = 'var(--bg2)';
        mapResult.style.borderColor = 'var(--line2)';
        mapResult.innerHTML = `
          📍 <strong>${(display_name || '').split(',').slice(0,3).join(', ')}</strong><br>
          ${distKm != null ? `📏 Distancia estimada: <strong>${distKm} km</strong>` : ''}
          <br><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank"
            style="color:var(--blue);font-size:11px">Ver en Google Maps ↗</a>`;
        // Si es vehículo propio, calcular combustible
        const tipo = document.getElementById('e-tipo')?.value;
        if (tipo === 'propio') {
          await calcularCombustible(distKm, vSelect?.value);
        }
      } catch(err) {
        mapResult.style.display = 'block';
        mapResult.style.background = '#fef2f2';
        mapResult.style.borderColor = '#fecaca';
        mapResult.innerHTML = `⚠ ${err.message}`;
      } finally {
        btnGeo.disabled = false;
        btnGeo.textContent = '📍 Buscar dirección y calcular distancia';
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

    // Inicializar destinos del primer expreso
    onCarrierChange();

  }, 150);
}

// ── Actualizar estado del envío ───────────────
window.actualizarEnvio = async (id, status) => {
  const user   = _eUser();
  const labels = {
    en_camino: '¿Marcar como En camino?',
    entregado: '¿Confirmar entrega?',
    cancelado: '¿Cancelar este envío?'
  };
  if (!confirm(labels[status] || '¿Actualizar estado?')) return;

  const res = await window.api.deliveries.updateStatus({ id, status, requestUserId: user.id });
  if (!res.ok) { alert(res.error); return; }

  // ── Registrar gasto cuando sale el envío (En camino) ─────────────────────
  // Se usa la tarifa del envío — es lo que realmente se paga
  if (status === 'en_camino' && CFG.module_gastos === '1' && window.api?.expenses) {
    try {
      const allRes = await window.api.deliveries.getAll({ limit: 200 });
      const envio  = (allRes?.data || []).find(e => e.id === id);
      if (envio && envio.delivery_fee > 0) {
        const esExpreso  = envio.delivery_type === 'expreso' || envio.carrier_name;
        const categoria  = esExpreso ? 'Envíos — Expreso/Parada' : 'Envíos — Vehículo Propio';
        const descripcion = esExpreso
          ? `Envío #${id} vía ${envio.carrier_name||'Expreso'} → ${envio.dest_address}`
          : `Envío #${id} → ${envio.dest_address}`;
        await window.api.expenses.create({
          data: {
            category:    categoria,
            description: descripcion,
            amount:      envio.delivery_fee,
            date:        new Date().toISOString().split('T')[0],
            status:      'pagado',
            notes:       envio.carrier_tracking
              ? `Rastreo: ${envio.carrier_tracking}`
              : 'Registrado automáticamente al despachar',
          },
          requestUserId: user.id,
        });
      }
    } catch(e) { console.warn('[Envíos] Gasto:', e.message); }
  }

  const labels2 = { en_camino: 'En camino 🚚', entregado: 'Entregado ✅', cancelado: 'Cancelado' };
  _eToast(`✓ Envío marcado como: ${labels2[status] || status}`);

  // Recargar en tiempo real
  const mainEl = document.getElementById('main-content') ||
                 document.querySelector('.main-content');
  if (mainEl) await renderEnvios(mainEl);
  else if (typeof routeTo === 'function') routeTo('envios');
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
