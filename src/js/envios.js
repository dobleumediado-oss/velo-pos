// ══════════════════════════════════════════════
// envios.js — Módulo de Envíos
// VeloPOS v1.5.5
// ══════════════════════════════════════════════

function _eUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}

const _eFmt   = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _eDate  = d => d ? new Date(d).toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const _eToday = () => new Date().toISOString().split('T')[0];

const STATUS_ENV = {
  pendiente:  { label:'Pendiente',  color:'#f59e0b' },
  en_camino:  { label:'En camino',  color:'#3b82f6' },
  entregado:  { label:'Entregado',  color:'#00c07a' },
  cancelado:  { label:'Cancelado',  color:'#ef4444' },
};

function _eBadge(status) {
  const s = STATUS_ENV[status] || { label: status, color:'#6b7280' };
  return `<span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${s.color}22;color:${s.color};font-weight:600">${s.label}</span>`;
}

// ── Render principal ──────────────────────────
async function renderEnvios(el) {
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Cargando envíos...</div>';
  const user = _eUser();
  if (!user) return;

  if (!window.api?.deliveries) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red,#ef4444)">Módulo de envíos no disponible. Reinicia la aplicación.</div>';
    return;
  }

  const [sumRes, envRes, vehRes] = await Promise.all([
    window.api.deliveries.getSummary(),
    window.api.deliveries.getAll({ limit: 50 }),
    window.api.vehicles.getAll(),
  ]);

  const summary  = sumRes?.data  || {};
  const envios   = envRes?.data  || [];
  const vehiculos = vehRes?.data || [];

  el.innerHTML = '';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px';
  hdr.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Envíos y Despachos</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">Control de entregas y costo de combustible</p>
    </div>
    <button class="btn btn-dark btn-sm" id="btn-nuevo-envio">+ Nuevo envío</button>`;
  el.appendChild(hdr);

  // Métricas
  const metrics = document.createElement('div');
  metrics.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px';
  metrics.innerHTML = `
    ${[
      ['📦 Pendientes',  summary.pendiente||0, '#f59e0b'],
      ['🚚 En camino',   summary.en_camino||0,  '#3b82f6'],
      ['✅ Entregados',  summary.entregado||0,  '#00c07a'],
      ['⛽ Costo combustible', _eFmt(summary.fuel_cost||0), '#ef4444'],
    ].map(([label, val, color]) => `
      <div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:0.5px solid var(--line2)">
        <div style="font-size:11px;color:var(--muted2);margin-bottom:4px">${label}</div>
        <div style="font-size:18px;font-weight:600;color:${color}">${val}</div>
      </div>`).join('')}`;
  el.appendChild(metrics);

  // Tabla de envíos
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
            <th style="padding:10px 12px;text-align:left">Vehículo</th>
            <th style="padding:10px 12px;text-align:right">Distancia</th>
            <th style="padding:10px 12px;text-align:right">Combustible</th>
            <th style="padding:10px 12px;text-align:right">Tarifa</th>
            <th style="padding:10px 12px;text-align:left">Estado</th>
            <th style="padding:10px 12px">Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${envios.map(e => `
            <tr style="border-bottom:0.5px solid var(--line2)">
              <td style="padding:10px 12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">${e.dest_address}</td>
              <td style="padding:10px 12px;color:var(--muted2)">${e.customer_name||'—'}</td>
              <td style="padding:10px 12px;color:var(--muted2)">${e.brand?`${e.brand} ${e.model}`:'—'} ${e.plate?`(${e.plate})`:''}</td>
              <td style="padding:10px 12px;text-align:right">${e.distance_km ? e.distance_km.toFixed(1)+' km' : '—'}</td>
              <td style="padding:10px 12px;text-align:right;color:#ef4444">${e.fuel_cost ? _eFmt(e.fuel_cost) : '—'}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:600">${_eFmt(e.delivery_fee)}</td>
              <td style="padding:10px 12px">${_eBadge(e.status)}</td>
              <td style="padding:10px 12px">
                <div style="display:flex;gap:4px">
                  ${e.status === 'pendiente' ? `<button class="btn btn-ghost btn-sm" style="color:var(--blue)" onclick="actualizarEnvio(${e.id},'en_camino')">🚚</button>` : ''}
                  ${e.status === 'en_camino' ? `<button class="btn btn-ghost btn-sm" style="color:var(--green)" onclick="actualizarEnvio(${e.id},'entregado')">✅</button>` : ''}
                  ${e.status === 'pendiente' ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="actualizarEnvio(${e.id},'cancelado')">✗</button>` : ''}
                  ${e.dest_lat && e.dest_lng ? `<button class="btn btn-ghost btn-sm" onclick="abrirMapa(${e.dest_lat},${e.dest_lng},'${e.dest_address.replace(/'/g,'')}')" title="Ver en mapa">🗺</button>` : ''}
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    el.appendChild(wrap);
  }

  document.getElementById('btn-nuevo-envio')?.addEventListener('click', () => modalNuevoEnvio(el, vehiculos));
}

// ── Tarifa inteligente sugerida ───────────────
function _sugerirTarifa(distKm, vehicleData) {
  // Base: RD$50 por km para distancias cortas, decreciente para largas
  const dist = parseFloat(distKm) || 0;

  // Tarifa base por km según distancia (economía de escala)
  let tarifaKm;
  if (dist <= 5)        tarifaKm = 120;  // entrega local
  else if (dist <= 15)  tarifaKm = 90;
  else if (dist <= 30)  tarifaKm = 70;
  else if (dist <= 60)  tarifaKm = 55;
  else if (dist <= 120) tarifaKm = 45;
  else                  tarifaKm = 35;   // larga distancia

  // Ajuste por tipo de vehículo
  const tipoMult = {
    moto:      0.6,
    carro:     1.0,
    camioneta: 1.4,
    furgoneta: 1.6,
    camion:    2.2,
    otro:      1.0,
  };
  const mult = tipoMult[vehicleData?.type] || 1.0;

  // Costo combustible (ida y vuelta)
  const fuelPrices = window._fuelPrices || { premium: 335.10, regular: 307.50, diesel: 287.10 };
  const grade      = vehicleData?.fuel_grade || 'premium';
  const kmg        = vehicleData?.km_per_gallon || 30;
  const precioGal  = fuelPrices[grade] || fuelPrices.premium;
  const costFuel   = (dist * 2 / kmg) * precioGal;

  // Tarifa = combustible + mano de obra (tarifa por km × tipo)
  const tarifaBase = dist * tarifaKm * mult;
  const tarifa     = Math.max(costFuel + tarifaBase, 200); // mínimo RD$200

  // Redondear a múltiplo de 50
  return Math.round(tarifa / 50) * 50;
}

// ── Modal nuevo envío con geocoding y cálculo ─
function modalNuevoEnvio(parentEl, vehiculos) {
  const user = _eUser();

  const html = `
    <div class="fg"><label class="lbl">Dirección de destino *</label>
      <input class="inp" id="e-dest" placeholder="Ej: Av. Independencia 123, La Vega, RD">
      <button class="btn btn-ghost btn-sm" id="btn-geocode" style="margin-top:6px;width:100%">
        📍 Buscar dirección y calcular distancia
      </button></div>
    <div id="e-map-result" style="display:none;background:var(--bg2);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:10px;border:0.5px solid var(--line2)"></div>
    <div class="fg"><label class="lbl">Cliente</label>
      <input class="inp" id="e-customer" placeholder="Nombre del cliente (opcional)"></div>
    <div class="fg"><label class="lbl">Vehículo de entrega</label>
      <select class="inp" id="e-vehicle">
        <option value="">— Sin vehículo asignado —</option>
        ${vehiculos.filter(v => v.status === 'activo').map(v =>
          `<option value="${v.id}">${v.brand} ${v.model} ${v.plate?'('+v.plate+')':''} · ${v.km_per_gallon}km/gal · ${v.fuel_grade}</option>`
        ).join('')}
      </select></div>
    <div id="e-fuel-result" style="display:none;background:#fef9c3;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:10px;border:0.5px solid #fde68a"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Tarifa del envío (RD$)</label>
        <input class="inp" id="e-fee" type="number" min="0" placeholder="0"></div>
      <div class="fg"><label class="lbl">Fecha programada</label>
        <input class="inp" id="e-date" type="date" value="${_eToday()}"></div>
    </div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="e-notes" rows="2" placeholder="Instrucciones de entrega..."></textarea></div>

    <input type="hidden" id="e-lat">
    <input type="hidden" id="e-lng">
    <input type="hidden" id="e-distance">`;

  const overlay = _eModal('Nuevo envío', html, async (ov) => {
    const dest = ov.querySelector('#e-dest')?.value.trim();
    if (!dest) throw new Error('La dirección de destino es obligatoria');

    const res = await window.api.deliveries.create({
      data: {
        dest_address:  dest,
        customer_id:   null,
        vehicle_id:    parseInt(ov.querySelector('#e-vehicle')?.value) || null,
        driver_id:     user.id,
        dest_lat:      parseFloat(ov.querySelector('#e-lat')?.value) || null,
        dest_lng:      parseFloat(ov.querySelector('#e-lng')?.value) || null,
        distance_km:   parseFloat(ov.querySelector('#e-distance')?.value) || null,
        delivery_fee:  parseFloat(ov.querySelector('#e-fee')?.value) || 0,
        scheduled_at:  ov.querySelector('#e-date')?.value || null,
        notes:         ov.querySelector('#e-notes')?.value,
      },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);

    let msg = '✓ Envío registrado';
    if (res.fuel_cost) msg += ` · Costo combustible estimado: ${_eFmt(res.fuel_cost)}`;
    _eToast(msg);
    renderEnvios(parentEl.closest('#main-content') || parentEl);
  }, 'Registrar envío');

  // Geocoding + cálculo de distancia + combustible
  setTimeout(() => {
    const btnGeo = document.getElementById('btn-geocode');
    const vSelect = document.getElementById('e-vehicle');

    const calcular = async () => {
      const addr = document.getElementById('e-dest')?.value.trim();
      if (!addr) { alert('Ingresa una dirección primero'); return; }

      btnGeo.disabled = true;
      btnGeo.textContent = '⏳ Buscando...';
      const mapResult = document.getElementById('e-map-result');
      const fuelResult = document.getElementById('e-fuel-result');

      try {
        // Geocoding con Nominatim (OpenStreetMap, gratis)
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr + ', República Dominicana')}&format=json&limit=1`;
        const geoRes = await fetch(geoUrl, { headers: { 'User-Agent': 'VeloPOS/1.5' } });
        const geoData = await geoRes.json();

        if (!geoData.length) throw new Error('Dirección no encontrada. Intenta ser más específico.');

        const lat = parseFloat(geoData[0].lat);
        const lng = parseFloat(geoData[0].lon);
        document.getElementById('e-lat').value = lat;
        document.getElementById('e-lng').value = lng;

        // Calcular distancia desde La Vega (origen por defecto) con OSRM
        // Coordenadas de La Vega RD como origen por defecto
        const originLat = 19.2207, originLng = -70.5291;
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${lng},${lat}?overview=false`;
        const osrmRes = await fetch(osrmUrl);
        const osrmData = await osrmRes.json();

        let distKm = null;
        if (osrmData?.routes?.[0]) {
          distKm = (osrmData.routes[0].distance / 1000).toFixed(1);
          document.getElementById('e-distance').value = distKm;
        }

        mapResult.style.display = 'block';
        mapResult.innerHTML = `
          📍 <strong>${geoData[0].display_name.split(',').slice(0,3).join(', ')}</strong><br>
          ${distKm ? `📏 Distancia estimada: <strong>${distKm} km</strong>` : ''}
          <br><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="color:var(--blue);font-size:11px">Ver en Google Maps ↗</a>`;

        // Calcular combustible con precio en tiempo real + sugerir tarifa
        const vehicleId  = parseInt(vSelect?.value);
        const vehicleObj = vehiculos.find(v => v.id === vehicleId);
        if (vehicleId && distKm) {
          const fuelRes = await window.api.vehicles.calcFuel({ vehicleId, distanceKm: parseFloat(distKm), requestUserId: user.id });
          if (fuelRes?.ok && fuelRes.data) {
            const d = fuelRes.data;
            const fuelPrices = window._fuelPrices || { premium: 335.10, regular: 307.50, diesel: 287.10 };
            const precioReal = fuelPrices[d.fuel_grade] || fuelPrices.premium;
            const costoReal  = (d.gallons * 2) * precioReal;

            // Sugerir tarifa inteligente
            const tarifaSugerida = _sugerirTarifa(distKm, vehicleObj);
            const feeInput = document.getElementById('e-fee');
            if (feeInput && (!feeInput.value || feeInput.value === '0')) {
              feeInput.value = tarifaSugerida;
            }

            fuelResult.style.display = 'block';
            fuelResult.innerHTML = `
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                  <div style="font-size:10px;color:var(--muted2);font-weight:600;margin-bottom:3px">⛽ COSTO COMBUSTIBLE (ida y vuelta)</div>
                  <div style="font-size:16px;font-weight:700;color:var(--red,#ef4444)">${_eFmt(costoReal)}</div>
                  <div style="font-size:11px;color:var(--muted2);margin-top:1px">
                    ${(d.gallons*2).toFixed(2)} gal · ${d.fuel_grade} a ${_eFmt(precioReal)}/gal
                    ${window._fuelPrices ? '<span style="color:var(--green,#00c07a)"> · tiempo real ✓</span>' : ''}
                  </div>
                </div>
                <div>
                  <div style="font-size:10px;color:var(--muted2);font-weight:600;margin-bottom:3px">💡 TARIFA SUGERIDA</div>
                  <div style="font-size:16px;font-weight:700;color:var(--green,#00c07a)">${_eFmt(tarifaSugerida)}</div>
                  <div style="font-size:11px;color:var(--muted2);margin-top:1px">combustible + mano de obra · editable</div>
                </div>
              </div>`;
          }
        } else if (distKm) {
          // Sin vehículo — sugerir tarifa solo por distancia
          const tarifaSugerida = _sugerirTarifa(distKm, null);
          const feeInput = document.getElementById('e-fee');
          if (feeInput && (!feeInput.value || feeInput.value === '0')) {
            feeInput.value = tarifaSugerida;
          }
        }
      } catch(err) {
        mapResult.style.display = 'block';
        mapResult.innerHTML = `⚠ ${err.message}`;
        mapResult.style.background = '#fef2f2';
        mapResult.style.borderColor = '#fecaca';
      } finally {
        btnGeo.disabled = false;
        btnGeo.textContent = '📍 Buscar dirección y calcular distancia';
      }
    };

    btnGeo?.addEventListener('click', calcular);

    // Recalcular combustible cuando cambia el vehículo
    vSelect?.addEventListener('change', async () => {
      const vehicleId = parseInt(vSelect.value);
      const distKm = parseFloat(document.getElementById('e-distance')?.value);
      const fuelResult = document.getElementById('e-fuel-result');
      if (!vehicleId || !distKm || !fuelResult) return;
      const vehicleObj2 = vehiculos.find(v => v.id === vehicleId);
      const fuelRes = await window.api.vehicles.calcFuel({ vehicleId, distanceKm: distKm, requestUserId: user.id });
      if (fuelRes?.ok && fuelRes.data) {
        const d = fuelRes.data;
        const fuelPrices = window._fuelPrices || { premium: 335.10, regular: 307.50, diesel: 287.10 };
        const precioReal = fuelPrices[d.fuel_grade] || fuelPrices.premium;
        const costoReal  = (d.gallons * 2) * precioReal;
        const tarifaSugerida = _sugerirTarifa(distKm, vehicleObj2);
        const feeInput = document.getElementById('e-fee');
        if (feeInput) feeInput.value = tarifaSugerida;
        fuelResult.style.display = 'block';
        fuelResult.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <div style="font-size:10px;color:var(--muted2);font-weight:600;margin-bottom:3px">⛽ COSTO COMBUSTIBLE (ida y vuelta)</div>
              <div style="font-size:16px;font-weight:700;color:var(--red,#ef4444)">${_eFmt(costoReal)}</div>
              <div style="font-size:11px;color:var(--muted2);margin-top:1px">
                ${(d.gallons*2).toFixed(2)} gal · ${d.fuel_grade} a ${_eFmt(precioReal)}/gal
              </div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--muted2);font-weight:600;margin-bottom:3px">💡 TARIFA SUGERIDA</div>
              <div style="font-size:16px;font-weight:700;color:var(--green,#00c07a)">${_eFmt(tarifaSugerida)}</div>
              <div style="font-size:11px;color:var(--muted2);margin-top:1px">combustible + mano de obra · editable</div>
            </div>
          </div>`;
      }
    });
  }, 200);
}

window.actualizarEnvio = async (id, status) => {
  const user = _eUser();
  const labels = { en_camino: '¿Marcar como En camino?', entregado: '¿Confirmar entrega?', cancelado: '¿Cancelar este envío?' };
  if (!confirm(labels[status] || '¿Actualizar estado?')) return;
  const res = await window.api.deliveries.updateStatus({ id, status, requestUserId: user.id });
  if (!res.ok) return alert(res.error);
  _eToast(`✓ Envío marcado como: ${STATUS_ENV[status]?.label || status}`);
  const el = document.getElementById('main-content');
  if (el) renderEnvios(el);
};

window.abrirMapa = (lat, lng, address) => {
  const url = `https://www.google.com/maps?q=${lat},${lng}`;
  if (window.api?.shell?.openExternal) {
    window.api.shell.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
};

function _eModal(titulo, html, onConfirm, confirmLabel='Guardar') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2)">
        <div style="font-size:15px;font-weight:600">${titulo}</div>
        <button id="em-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px">${html}</div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="em-cancel">Cancelar</button>
        <button class="btn btn-dark" id="em-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#em-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#em-cancel')?.addEventListener('click', () => overlay.remove());
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
  setTimeout(() => t.remove(), 3500);
}
