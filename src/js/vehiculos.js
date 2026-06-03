// ══════════════════════════════════════════════
// vehiculos.js — Vehículos y Mantenimiento
// VeloPOS v1.5.5
// ══════════════════════════════════════════════

function _vUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}

const _vFmt   = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _vDate  = d => d ? new Date(d+'T00:00:00').toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const _vToday = () => new Date().toISOString().split('T')[0];

const TIPO_ICON = { carro:'🚗', camioneta:'🛻', moto:'🏍️', camion:'🚛', furgoneta:'🚐', otro:'🚙' };
const TIPO_LABEL = { carro:'Carro', camioneta:'Camioneta/Pick-up', moto:'Motocicleta', camion:'Camión', furgoneta:'Furgoneta', otro:'Otro' };
const STATUS_V = { activo:'#00c07a', inactivo:'#6b7280', taller:'#f59e0b' };


// ── Base de datos de vehículos populares en RD ───────────────────
const _VDB = {
  carro: {
    'Toyota':   ['Corolla','Camry','Yaris','Avalon','Prius','C-HR','RAV4'],
    'Honda':    ['Civic','Accord','City','Fit','CR-V','HR-V','Pilot'],
    'Hyundai':  ['Tucson','Santa Fe','Elantra','Accent','Sonata','Creta','Venue'],
    'Kia':      ['Rio','Sportage','Sorento','Cerato','Picanto','Stinger','Seltos'],
    'Nissan':   ['Sentra','Altima','Versa','Tiida','March','X-Trail','Juke'],
    'Chevrolet':['Aveo','Cruze','Malibu','Spark','Trax','Equinox','Captiva'],
    'Volkswagen':['Jetta','Passat','Golf','Polo','Tiguan','Vento'],
    'Mazda':    ['Mazda3','Mazda6','CX-3','CX-5','CX-9','MX-5'],
    'Ford':     ['Fiesta','Focus','Fusion','Mustang','EcoSport','Edge'],
    'Mercedes': ['Clase C','Clase E','Clase A','GLA','GLC','CLA'],
    'BMW':      ['Serie 3','Serie 5','X1','X3','X5','Serie 1'],
    'Audi':     ['A3','A4','A6','Q3','Q5','Q7','TT'],
    'Suzuki':   ['Swift','Vitara','Baleno','Ertiga','Jimny'],
    'Mitsubishi':['Mirage','Lancer','Outlander','Eclipse Cross','Galant'],
  },
  camioneta: {
    'Toyota':   ['Hilux','Tacoma','Tundra','Land Cruiser','4Runner','Prado','FJ Cruiser'],
    'Ford':     ['F-150','F-250','F-350','Ranger','Explorer','Expedition','Bronco'],
    'Chevrolet':['Silverado','Colorado','Tahoe','Suburban','Blazer','TrailBlazer'],
    'Nissan':   ['Frontier','Pathfinder','Armada','Navara','Titan','Xterra'],
    'Mitsubishi':['L200','Montero','Outlander Sport','Pajero','Triton'],
    'Jeep':     ['Wrangler','Grand Cherokee','Cherokee','Compass','Renegade'],
    'Dodge':    ['Ram 1500','Ram 2500','Durango','Journey','Charger'],
    'Isuzu':    ['D-Max','MU-X','Trooper'],
    'Mazda':    ['BT-50','CX-50'],
    'Honda':    ['Ridgeline','Passport'],
    'Hyundai':  ['Tucson','Santa Cruz','Palisade'],
    'Kia':      ['Telluride','Sorento','Mohave'],
  },
  moto: {
    'Honda':    ['CB300','CBR600','CRF300','Wave 110','PCX 150','XRE 300','CB500'],
    'Yamaha':   ['YBR 125','MT-07','FZ-25','NMAX 155','R15','Fazer 250','XTZ 250'],
    'Suzuki':   ['GS150','Gixxer','Access 125','Burgman','DR650','Boulevard'],
    'Kawasaki': ['Ninja 300','Ninja 400','Z400','Versys 650','KLX 300'],
    'TVS':      ['Apache 160','Apache 200','Ntorq 125','Raider 125'],
    'Zongshen': ['ZS150','ZS200','ZS250'],
    'Bajaj':    ['Pulsar 150','Pulsar 200','Dominar 400','Boxer'],
    'KTM':      ['Duke 200','Duke 390','RC 200','Adventure 390'],
  },
  camion: {
    'Isuzu':    ['NLR','NMR','NPR','NQR','FRR','FTR','FVR','ELF'],
    'Mitsubishi':['Canter','Fuso Fighter','Fuso Super Great'],
    'Hino':     ['300','500','700','Dutro','Ranger','Profia'],
    'Mercedes': ['Sprinter','Actros','Atego','Axor'],
    'Ford':     ['F-450','F-550','F-650','Cargo'],
    'Chevrolet':['N-Series','W-Series','Express','Kodiak'],
    'Toyota':   ['Dyna','Hiace Cargo','Land Cruiser 70'],
    'Kenworth': ['T680','T800','W900','T270'],
    'Volvo':    ['FH','FM','FE','FL','FMX'],
  },
  furgoneta: {
    'Toyota':   ['HiAce','Proace','Alphard'],
    'Ford':     ['Transit','Transit Connect','E-Series'],
    'Mercedes': ['Vito','Viano','Sprinter Van'],
    'Volkswagen':['Transporter','Crafter','Caravelle'],
    'Hyundai':  ['H-1','Starex','County'],
    'Kia':      ['Carnival','Grand Carnival','Bongo'],
    'Nissan':   ['NV200','NV300','Urvan','Caravan'],
    'Chevrolet':['Express Van','City Express'],
  },
  otro: {
    'Otro': ['Especificar modelo'],
  }
};

// Rendimiento estimado por tipo y combustible (km/galón)
function _estimarRendimiento(tipo, fuelGrade) {
  const base = {
    carro:     { premium: 38, regular: 35, diesel: 45 },
    camioneta: { premium: 28, regular: 26, diesel: 32 },
    moto:      { premium: 65, regular: 60, diesel: 0  },
    camion:    { premium: 0,  regular: 0,  diesel: 14 },
    furgoneta: { premium: 22, regular: 20, diesel: 28 },
    otro:      { premium: 30, regular: 28, diesel: 35 },
  };
  return base[tipo]?.[fuelGrade] || 30;
}

// ── Render principal ──────────────────────────
async function renderVehiculos(el) {
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Cargando vehículos...</div>';
  const user = _vUser();
  if (!user) return;

  if (!window.api?.vehicles) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red,#ef4444)">Módulo de vehículos no disponible. Reinicia la aplicación.</div>';
    return;
  }

  const [vehRes, pendRes] = await Promise.all([
    window.api.vehicles.getAll(),
    window.api.maintenance.getPending(),
  ]);
  const vehiculos = vehRes?.data || [];
  const pendientes = pendRes?.data || [];

  el.innerHTML = '';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px';
  hdr.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Vehículos y Mantenimiento</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">${vehiculos.length} vehículo${vehiculos.length!==1?'s':''} registrado${vehiculos.length!==1?'s':''}</p>
    </div>
    <button class="btn btn-dark btn-sm" id="btn-nuevo-vehiculo">+ Nuevo vehículo</button>`;
  el.appendChild(hdr);

  // Alertas de mantenimiento próximo
  if (pendientes.length) {
    const alert = document.createElement('div');
    alert.style.cssText = 'background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#92400e';
    alert.innerHTML = `⚠ <strong>${pendientes.length} mantenimiento${pendientes.length>1?'s':''} próximo${pendientes.length>1?'s':''}</strong>: 
      ${pendientes.slice(0,3).map(p=>`${p.brand} ${p.model} — ${p.type} (${_vDate(p.next_date)})`).join(' · ')}`;
    el.appendChild(alert);
  }

  if (!vehiculos.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:48px;color:var(--muted2)';
    empty.innerHTML = '<div style="font-size:40px">🚗</div><div style="margin-top:8px;font-size:13px">Sin vehículos registrados</div><div style="font-size:11px;margin-top:4px">Agrega el primer vehículo de la empresa</div>';
    el.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px';
    vehiculos.forEach(v => {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg2);border-radius:12px;border:0.5px solid var(--line2);overflow:hidden';
      card.innerHTML = `
        <div style="padding:14px 16px;border-bottom:1px solid var(--line2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div style="font-size:20px">${TIPO_ICON[v.type]||'🚗'}</div>
            <span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${STATUS_V[v.status]||'#6b7280'}22;color:${STATUS_V[v.status]||'#6b7280'};font-weight:600">${v.status}</span>
          </div>
          <div style="font-size:15px;font-weight:600;color:var(--ink)">${v.brand} ${v.model}</div>
          <div style="font-size:11px;color:var(--muted2)">${v.year||''} ${v.plate?'· '+v.plate:''} ${v.color?'· '+v.color:''}</div>
        </div>
        <div style="padding:10px 16px;font-size:12px;color:var(--muted2)">
          <div>⛽ ${v.fuel_grade} · ${v.km_per_gallon} km/gal</div>
          <div>📍 Odómetro: ${(v.odometer||0).toLocaleString()} km</div>
        </div>
        <div style="padding:8px 12px;display:flex;gap:6px;border-top:0.5px solid var(--line2)">
          <button class="btn btn-ghost btn-sm" style="flex:1" onclick="verMantenimiento(${v.id},'${v.brand} ${v.model}')">🔧 Mantenimiento</button>
          <button class="btn btn-ghost btn-sm" onclick="editarVehiculo(${v.id})">✏️</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red,#ef4444)" onclick="eliminarVehiculo(${v.id})">🗑</button>
        </div>`;
      grid.appendChild(card);
    });
    el.appendChild(grid);
  }


  // ── Autocomplete de marca y modelo ──────────────────────────────
  setTimeout(() => {
    const typeEl  = document.getElementById('v-type');
    const brandEl = document.getElementById('v-brand');
    const modelEl = document.getElementById('v-model');
    const kmgEl   = document.getElementById('v-kmg');
    const kmgHint = document.getElementById('v-kmg-hint');
    const fuelTypeEl  = document.getElementById('v-fuel-type');
    const fuelGradeEl = document.getElementById('v-fuel-grade');
    const brandList = document.getElementById('v-brand-list');
    const modelList = document.getElementById('v-model-list');
    if (!typeEl || !brandEl || !modelEl) return;

    // Función para mostrar dropdown
    function showDropdown(el, list, items) {
      if (!items.length) { list.style.display = 'none'; return; }
      list.innerHTML = items.map(item =>
        `<div data-val="${item}" style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:0.5px solid var(--line2)" 
         onmouseenter="this.style.background='var(--bg2)'" 
         onmouseleave="this.style.background=''"
         onclick="document.getElementById('${el.id}').value='${item}';document.getElementById('${list.id}').style.display='none';document.getElementById('${list.id}').dispatchEvent(new Event('selected'))">${item}</div>`
      ).join('');
      list.style.display = 'block';
    }

    // Actualizar marcas disponibles según tipo
    function updateBrands(tipo, filter = '') {
      const db = _VDB[tipo] || _VDB.carro;
      const marcas = Object.keys(db).filter(m => m.toLowerCase().includes(filter.toLowerCase()));
      showDropdown(brandEl, brandList, marcas);
    }

    // Actualizar modelos según marca seleccionada
    function updateModels(tipo, marca, filter = '') {
      const db = _VDB[tipo] || _VDB.carro;
      const modelos = (db[marca] || []).filter(m => m.toLowerCase().includes(filter.toLowerCase()));
      showDropdown(modelEl, modelList, modelos);
    }

    // Calcular rendimiento automático
    function autoRendimiento() {
      if (kmgEl.value && kmgEl.dataset.manual === '1') return; // usuario lo editó
      const tipo  = typeEl.value;
      const grade = fuelGradeEl?.value || 'premium';
      const ftype = fuelTypeEl?.value || 'gasolina';
      if (ftype === 'electrico') { kmgEl.value = ''; kmgHint.textContent = 'Eléctrico — sin consumo de combustible'; return; }
      const est = _estimarRendimiento(tipo, ftype === 'diesel' ? 'diesel' : grade);
      kmgEl.value = est;
      kmgHint.textContent = `Estimado para ${TIPO_LABEL[tipo]||tipo} con ${grade} · puedes ajustarlo`;
    }

    // Si gasoil seleccionado, cambiar grade a diesel automáticamente
    fuelTypeEl?.addEventListener('change', () => {
      if (fuelTypeEl.value === 'diesel') {
        if (fuelGradeEl) fuelGradeEl.value = 'diesel';
      } else if (fuelTypeEl.value === 'electrico') {
        if (fuelGradeEl) fuelGradeEl.value = 'premium';
      }
      autoRendimiento();
    });
    fuelGradeEl?.addEventListener('change', autoRendimiento);
    typeEl?.addEventListener('change', () => {
      brandEl.value = ''; modelEl.value = '';
      autoRendimiento();
      updateBrands(typeEl.value);
    });

    brandEl?.addEventListener('input', () => {
      const tipo = typeEl.value;
      const filter = brandEl.value;
      updateBrands(tipo, filter);
    });

    brandEl?.addEventListener('focus', () => updateBrands(typeEl.value, brandEl.value));

    brandList?.addEventListener('selected', () => {
      // Cuando se selecciona una marca, cargar modelos
      updateModels(typeEl.value, brandEl.value);
    });

    modelEl?.addEventListener('input', () => {
      updateModels(typeEl.value, brandEl.value, modelEl.value);
    });

    modelEl?.addEventListener('focus', () => {
      updateModels(typeEl.value, brandEl.value, modelEl.value);
    });

    kmgEl?.addEventListener('input', () => { kmgEl.dataset.manual = '1'; });

    // Cerrar dropdowns al hacer click fuera
    document.addEventListener('click', (e) => {
      if (!brandEl?.contains(e.target) && !brandList?.contains(e.target)) {
        if (brandList) brandList.style.display = 'none';
      }
      if (!modelEl?.contains(e.target) && !modelList?.contains(e.target)) {
        if (modelList) modelList.style.display = 'none';
      }
    }, { once: false });

    // Tooltip del odómetro
    document.getElementById('v-odo-help')?.addEventListener('click', () => {
      alert('El odómetro es el número de kilómetros que muestra el tablero del vehículo. Se usa para programar mantenimientos. Ejemplo: cambiar aceite cada 5,000 km.');
    });

    // Calcular rendimiento inicial
    autoRendimiento();
  }, 150);

  document.getElementById('btn-nuevo-vehiculo')?.addEventListener('click', () => modalNuevoVehiculo(el));
}

// ── Modal nuevo/editar vehículo ───────────────
function modalNuevoVehiculo(parentEl, vehiculo = null) {
  const user = _vUser();
  const title = vehiculo ? 'Editar vehículo' : 'Nuevo vehículo';
  const v = vehiculo || {};
  const tipos = ['carro','camioneta','moto','camion','furgoneta','otro'];

  const html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Tipo *</label>
        <select class="inp" id="v-type">
          ${tipos.map(t => `<option value="${t}" ${(v.type||'carro')===t?'selected':''}>${TIPO_LABEL[t]}</option>`).join('')}
        </select></div>
      <div class="fg"><label class="lbl">Estado</label>
        <select class="inp" id="v-status">
          <option value="activo" ${(v.status||'activo')==='activo'?'selected':''}>Activo</option>
          <option value="inactivo" ${v.status==='inactivo'?'selected':''}>Inactivo</option>
          <option value="taller" ${v.status==='taller'?'selected':''}>En taller</option>
        </select></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Marca *</label>
        <input class="inp" id="v-brand" placeholder="Escribe o selecciona..." value="${v.brand||''}" autocomplete="off">
        <div id="v-brand-list" style="display:none;position:absolute;z-index:999;background:var(--bg);border:1px solid var(--line2);border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 4px 12px #0002;width:200px"></div>
      </div>
      <div class="fg"><label class="lbl">Modelo *</label>
        <input class="inp" id="v-model" placeholder="Escribe o selecciona..." value="${v.model||''}" autocomplete="off">
        <div id="v-model-list" style="display:none;position:absolute;z-index:999;background:var(--bg);border:1px solid var(--line2);border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 4px 12px #0002;width:200px"></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Año</label>
        <input class="inp" id="v-year" type="number" placeholder="${new Date().getFullYear()}" value="${v.year||''}"></div>
      <div class="fg"><label class="lbl">Placa</label>
        <input class="inp" id="v-plate" placeholder="A123456" value="${v.plate||''}"></div>
      <div class="fg"><label class="lbl">Color</label>
        <input class="inp" id="v-color" placeholder="Blanco" value="${v.color||''}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Tipo de combustible</label>
        <select class="inp" id="v-fuel-type">
          <option value="gasolina" ${(v.fuel_type||'gasolina')==='gasolina'?'selected':''}>Gasolina</option>
          <option value="diesel" ${v.fuel_type==='diesel'?'selected':''}>Gasoil / Diesel</option>
          <option value="electrico" ${v.fuel_type==='electrico'?'selected':''}>Eléctrico</option>
          <option value="hibrido" ${v.fuel_type==='hibrido'?'selected':''}>Híbrido</option>
        </select></div>
      <div class="fg"><label class="lbl">Grado de gasolina</label>
        <select class="inp" id="v-fuel-grade">
          <option value="premium" ${(v.fuel_grade||'premium')==='premium'?'selected':''}>Premium</option>
          <option value="regular" ${v.fuel_grade==='regular'?'selected':''}>Regular</option>
          <option value="diesel" ${v.fuel_grade==='diesel'?'selected':''}>Gasoil</option>
        </select></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Rendimiento (km/galón)</label>
        <input class="inp" id="v-kmg" type="number" step="0.1" placeholder="35" value="${v.km_per_gallon||''}">
        <div id="v-kmg-hint" style="font-size:10px;color:var(--muted2);margin-top:2px">Se calcula automáticamente según el tipo y combustible</div>
      </div>
      <div class="fg">
        <label class="lbl" style="display:flex;align-items:center;gap:6px">
          Odómetro actual (km)
          <span id="v-odo-help" title="El odómetro es el contador de kilómetros del tablero del vehículo. Se usa para alertas de mantenimiento." style="cursor:help;color:var(--muted2);font-size:11px;border:1px solid var(--line2);border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center">?</span>
        </label>
        <input class="inp" id="v-odo" type="number" placeholder="0" value="${v.odometer||0}">
        <div style="font-size:10px;color:var(--muted2);margin-top:2px">Km actuales del tablero del vehículo</div>
      </div>
    </div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="v-notes" rows="2">${v.notes||''}</textarea></div>`;

  _vModal(title, html, async (overlay) => {
    const brand = overlay.querySelector('#v-brand')?.value.trim();
    const model = overlay.querySelector('#v-model')?.value.trim();
    const tipo  = overlay.querySelector('#v-type')?.value || 'carro';
    const grade = overlay.querySelector('#v-fuel-grade')?.value || 'premium';
    const kmgVal = overlay.querySelector('#v-kmg')?.value;
    const kmg = kmgVal ? parseFloat(kmgVal) : _estimarRendimiento(tipo, grade);
    if (!brand || !model) throw new Error('Marca y modelo son obligatorios');
    if (kmg <= 0) throw new Error('El rendimiento debe ser mayor a 0');

    const data = {
      type:         overlay.querySelector('#v-type')?.value,
      brand, model,
      year:         parseInt(overlay.querySelector('#v-year')?.value) || null,
      plate:        overlay.querySelector('#v-plate')?.value.trim(),
      color:        overlay.querySelector('#v-color')?.value.trim(),
      fuel_type:    overlay.querySelector('#v-fuel-type')?.value,
      fuel_grade:   overlay.querySelector('#v-fuel-grade')?.value,
      km_per_gallon: kmg,
      odometer:     parseFloat(overlay.querySelector('#v-odo')?.value) || 0,
      status:       overlay.querySelector('#v-status')?.value,
      notes:        overlay.querySelector('#v-notes')?.value,
    };

    let res;
    if (vehiculo) {
      res = await window.api.vehicles.update({ id: vehiculo.id, data, requestUserId: user.id });
    } else {
      res = await window.api.vehicles.create({ data, requestUserId: user.id });
    }
    if (!res.ok) throw new Error(res.error);
    _vToast(`✓ Vehículo ${vehiculo ? 'actualizado' : 'registrado'}`);
    renderVehiculos(parentEl.closest('#main-content') || parentEl);
  }, vehiculo ? 'Guardar cambios' : 'Registrar vehículo');
}

// ── Mantenimiento de un vehículo ──────────────
window.verMantenimiento = async (vehicleId, vehicleName) => {
  const user = _vUser();
  const [histRes, typesRes] = await Promise.all([
    window.api.maintenance.getByVehicle({ vehicleId }),
    window.api.maintenance.getTypes(),
  ]);
  const historial = histRes?.data || [];
  const tipos     = typesRes?.data || [];

  const histHtml = historial.length ? `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
        <th style="padding:6px;text-align:left">Fecha</th>
        <th style="padding:6px;text-align:left">Tipo</th>
        <th style="padding:6px;text-align:left">Taller</th>
        <th style="padding:6px;text-align:right">Costo</th>
        <th style="padding:6px;text-align:left">Próximo</th>
      </tr></thead>
      <tbody>${historial.map((m,i) => `
        <tr style="border-bottom:0.5px solid var(--line2);background:${i%2?'var(--bg2)':''}">
          <td style="padding:6px;color:var(--muted2)">${_vDate(m.date_done)}</td>
          <td style="padding:6px;font-weight:500">${m.type}</td>
          <td style="padding:6px;color:var(--muted2)">${m.workshop||'—'}</td>
          <td style="padding:6px;text-align:right">${_vFmt(m.cost)}</td>
          <td style="padding:6px">${m.next_date ? `<span style="color:var(--amber,#f59e0b)">${_vDate(m.next_date)}</span>` : '—'}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div style="text-align:center;padding:24px;color:var(--muted2);font-size:13px">Sin registros de mantenimiento</div>';

  _vModal(`🔧 Mantenimiento — ${vehicleName}`, `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-dark btn-sm" id="btn-nuevo-mant">+ Registrar mantenimiento</button>
    </div>
    ${histHtml}`,
    async () => {}, 'Cerrar');

  setTimeout(() => {
    document.getElementById('btn-nuevo-mant')?.addEventListener('click', () => {
      modalNuevoMantenimiento(vehicleId, vehicleName, tipos, user);
    });
  }, 100);
};

function modalNuevoMantenimiento(vehicleId, vehicleName, tipos, user) {
  const html = `
    <div style="font-size:12px;color:var(--muted2);margin-bottom:12px">Vehículo: <strong>${vehicleName}</strong></div>
    <div class="fg"><label class="lbl">Tipo de mantenimiento *</label>
      <select class="inp" id="m-type">
        <option value="">Selecciona...</option>
        ${tipos.map(t => `<option value="${t.name}">${t.name}</option>`).join('')}
        <option value="__otro">Otro (especificar)</option>
      </select></div>
    <div class="fg" id="m-otro-wrap" style="display:none"><label class="lbl">Especificar</label>
      <input class="inp" id="m-otro" placeholder="Tipo de mantenimiento"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Fecha *</label>
        <input class="inp" id="m-date" type="date" value="${_vToday()}"></div>
      <div class="fg"><label class="lbl">Costo (RD$)</label>
        <input class="inp" id="m-cost" type="number" min="0" placeholder="0"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Odómetro actual (km)</label>
        <input class="inp" id="m-odo" type="number" placeholder="Km al hacer el servicio"></div>
      <div class="fg"><label class="lbl">Próxima fecha</label>
        <input class="inp" id="m-next" type="date"></div>
    </div>
    <div class="fg"><label class="lbl">Taller / Mecánico</label>
      <input class="inp" id="m-workshop" placeholder="Nombre del taller"></div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="m-notes" rows="2"></textarea></div>`;

  _vModal('Registrar mantenimiento', html, async (overlay) => {
    let type = overlay.querySelector('#m-type')?.value;
    if (type === '__otro') type = overlay.querySelector('#m-otro')?.value.trim();
    if (!type) throw new Error('Selecciona el tipo de mantenimiento');

    const res = await window.api.maintenance.create({
      data: {
        vehicle_id:  vehicleId,
        type,
        date_done:   overlay.querySelector('#m-date')?.value,
        cost:        parseFloat(overlay.querySelector('#m-cost')?.value) || 0,
        odometer_at: parseFloat(overlay.querySelector('#m-odo')?.value) || null,
        next_date:   overlay.querySelector('#m-next')?.value || null,
        workshop:    overlay.querySelector('#m-workshop')?.value.trim(),
        notes:       overlay.querySelector('#m-notes')?.value,
      },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    _vToast('✓ Mantenimiento registrado');
    // Refrescar el historial
    const el = document.getElementById('main-content');
    if (el) renderVehiculos(el);
  }, 'Registrar');

  // Toggle "otro"
  setTimeout(() => {
    document.getElementById('m-type')?.addEventListener('change', (e) => {
      document.getElementById('m-otro-wrap').style.display = e.target.value === '__otro' ? 'block' : 'none';
    });
  }, 100);
}

window.editarVehiculo = async (id) => {
  const res = await window.api.vehicles.getAll();
  const v = (res?.data||[]).find(x => x.id === id);
  if (!v) return;
  const el = document.getElementById('main-content');
  modalNuevoVehiculo(el, v);
};

window.eliminarVehiculo = async (id) => {
  if (!confirm('¿Eliminar este vehículo? También se eliminará su historial de mantenimiento.')) return;
  const user = _vUser();
  const res = await window.api.vehicles.delete({ id, requestUserId: user.id });
  if (!res.ok) return alert(res.error);
  _vToast('✓ Vehículo eliminado');
  const el = document.getElementById('main-content');
  if (el) renderVehiculos(el);
};

// ── Utilidades ────────────────────────────────
function _vModal(titulo, html, onConfirm, confirmLabel='Guardar') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2)">
        <div style="font-size:15px;font-weight:600">${titulo}</div>
        <button id="vm-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px" id="vm-body">${html}</div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="vm-cancel">Cancelar</button>
        <button class="btn btn-dark" id="vm-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#vm-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#vm-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#vm-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#vm-confirm');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try { await onConfirm(overlay); overlay.remove(); }
    catch(e) { btn.disabled = false; btn.textContent = confirmLabel; alert(e.message); }
  });
  return overlay;
}

function _vToast(msg) {
  if (typeof toast === 'function') { toast(msg); return; }
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:8px;font-size:13px;z-index:99999;animation:fadeIn .2s';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
