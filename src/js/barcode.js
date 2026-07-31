// ══════════════════════════════════════════════
// barcode.js — Módulo de Etiquetas de Código de Barras
// Acceso: admin y superadmin
// El superadmin configura el diseño en su panel.
// El admin crea y manda a imprimir desde aquí.
// Usa JsBarcode local (src/vendor/jsbarcode) cargado dinámicamente.
// ══════════════════════════════════════════════

// ── Estado local del módulo ───────────────────
let _bcState = {
  selected: {},      // { productId: qty }
  design: null,      // diseño cargado de settings
  printers: [],
  selPrinter: '',
  profileId: '',
  mediaWidthMm: 100,
  printerDpi: 203,
  mediaMode: 'gap',
  calibrations: {},
  detection: null,
};

function _bcCalibrationKey(printerName) {
  return String(printerName || '').trim().toLowerCase();
}

function _bcParseCalibrations(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function _bcLabelBindings(raw, printerName) {
  let bindings = {};
  try { bindings = JSON.parse(raw || '{}') || {}; } catch {}
  bindings.etiquetas = String(printerName || '').trim();
  return JSON.stringify(bindings);
}

function _bcLabelProfiles(raw, profileId) {
  let profiles = {};
  try { profiles = JSON.parse(raw || '{}') || {}; } catch {}
  profiles.etiquetas = String(profileId || '').trim();
  return JSON.stringify(profiles);
}

function _bcSelectedPrinterInfo(name = _bcState.selPrinter) {
  return (_bcState.printers || []).find(p => p.name === name) ||
    (name ? { name, displayName: name, description: '', isDefault: false, status: 0 } : null);
}

function _bcDetectPrinter(name = _bcState.selPrinter) {
  const info = _bcSelectedPrinterInfo(name);
  const settings = {
    barcode_printer_profile: _bcState.profileId,
    barcode_media_width_mm: _bcState.mediaWidthMm,
    barcode_printer_dpi: _bcState.printerDpi,
  };
  if (typeof detectLabelPrinter === 'function') {
    return detectLabelPrinter(info || '', settings);
  }
  const profile = _bcPrinterProfile();
  return {
    ...profile,
    printerName: name || '',
    displayName: name || 'Sin impresora de etiquetas configurada',
    confidence: 'low',
    reason: 'Confirma las medidas con una prueba',
    isDefault: info?.isDefault === true,
    status: Number(info?.status) || 0,
  };
}

function _bcCurrentCalibration(printerName = _bcState.selPrinter) {
  return _bcState.calibrations?.[_bcCalibrationKey(printerName)] || null;
}

function _bcSyncMediaControls() {
  const printer = document.getElementById('bc-printer-sel');
  const profile = document.getElementById('bc-profile');
  const width = document.getElementById('bc-media-width');
  const dpi = document.getElementById('bc-dpi');
  const mode = document.getElementById('bc-media-mode');
  if (printer) printer.value = _bcState.selPrinter || '';
  if (profile) profile.value = _bcState.profileId || '';
  if (width) width.value = String(_bcState.mediaWidthMm);
  if (dpi) dpi.value = String(_bcState.printerDpi);
  if (mode) mode.value = _bcState.mediaMode || 'gap';
}

function _bcApplySavedCalibration(printerName = _bcState.selPrinter) {
  const saved = _bcCurrentCalibration(printerName);
  if (!saved) return false;
  _bcState.profileId = saved.profileId || _bcState.profileId || '';
  _bcState.mediaWidthMm = Number(saved.widthMm) || _bcState.mediaWidthMm;
  _bcState.printerDpi = Number(saved.dpi) || _bcState.printerDpi;
  _bcState.mediaMode = saved.mediaMode || _bcState.mediaMode || 'gap';
  _bcSyncMediaControls();
  return true;
}

// ── Cargar JsBarcode una sola vez ─────────────
// SIEMPRE local (vendorizado en src/vendor): el CDN estaba bloqueado por el CSP
// (script-src 'self') y además esta app corre offline — nunca cargaba y las
// etiquetas salían sin código de barras en todos los formatos.
function _loadJsBarcode() {
  return new Promise((res) => {
    if (window.JsBarcode) { res(true); return; }
    const s = document.createElement('script');
    s.src = 'vendor/jsbarcode/JsBarcode.all.min.js';
    s.onload = () => res(!!window.JsBarcode);
    s.onerror = () => {
      console.error('[Etiquetas] No se pudo cargar JsBarcode local');
      res(false);
    };
    document.head.appendChild(s);
  });
}

// Pre-renderiza el código de barras como SVG EN LA APP (donde JsBarcode ya está
// cargado) y devuelve el markup listo. Así el HTML generado no necesita scripts
// ni red: funciona igual en el iframe de vista previa y en la ventana de
// impresión, sin depender del CSP de cada contexto.
function _bcRenderSvg(value, d) {
  if (!window.JsBarcode) return '';
  const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(tmp, String(value), {
      format:       d.format || 'CODE128',
      width:        d.barWidth || 1.5,
      height:       d.barHeight || 20,
      fontSize:     d.barFontSize || 8,
      margin:       0,
      displayValue: d.showBarcodeText !== false,
      background:   'transparent',
      lineColor:    d.barColor || '#000000',
    });
  } catch (e) {
    // Valor inválido para el formato elegido (ej. EAN13 exige 12-13 dígitos):
    // reintentar en CODE128, que acepta cualquier texto — mejor una etiqueta
    // legible que un hueco en blanco.
    try {
      JsBarcode(tmp, String(value), {
        format: 'CODE128', width: d.barWidth || 1.5, height: d.barHeight || 20,
        fontSize: d.barFontSize || 8, margin: 0,
        displayValue: d.showBarcodeText !== false,
        background: 'transparent', lineColor: d.barColor || '#000000',
      });
    } catch { return ''; }
  }
  // JsBarcode fija width/height absolutos y NO pone viewBox, así el SVG no
  // escala: si es más ancho que su contenedor (p.ej. al aplicar un margen),
  // overflow:hidden lo RECORTA en vez de encogerlo. Le añadimos un viewBox y
  // ancho 100% para que SIEMPRE escale al contenedor y nunca se corte.
  const wAttr = parseFloat(tmp.getAttribute('width')) || 0;
  const hAttr = parseFloat(tmp.getAttribute('height')) || 0;
  if (wAttr && hAttr) {
    if (!tmp.getAttribute('viewBox')) tmp.setAttribute('viewBox', `0 0 ${wAttr} ${hAttr}`);
    tmp.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    tmp.removeAttribute('width');
    tmp.removeAttribute('height');
    tmp.setAttribute('style', 'width:100%;height:auto;display:block');
  } else {
    tmp.setAttribute('style', 'max-width:100%;height:auto');
  }
  return tmp.outerHTML;
}

// ══════════════════════════════════════════════
// RENDER PRINCIPAL
// ══════════════════════════════════════════════
async function renderBarcode(el, options = {}) {
  const canOperate = ['admin', 'superadmin'].includes(user?.role)
    || (user?.role === 'cajero' && window._bcEnabled
      && String(CFG?.barcode_enabled_roles || 'admin').includes('cajero'));
  if (!canOperate) {
    routeTo('dash'); return;
  }
  const embedded = options?.embedded === true;

  const barcodeReady = await _loadJsBarcode();
  if (!barcodeReady) {
    el.innerHTML = `<div class="alrt r"><div class="alrt-dot r"></div><div>
      <div class="alrt-title">No se pudo cargar el generador de códigos de barras</div>
      <div class="alrt-sub">Reinicia Velo. La impresión fue detenida para evitar etiquetas en blanco.</div>
    </div></div>`;
    return;
  }

  // Cargar diseño guardado
  const settings    = await window.api.settings.getAll();
  const rawDesign   = settings?.barcode_design;
  _bcState.design   = rawDesign ? JSON.parse(rawDesign) : _bcDefaultDesign();
  _bcState.selected = {};
  _bcState.calibrations = _bcParseCalibrations(settings?.barcode_calibrations);

  // Impresoras disponibles
  // getPrinters retorna el array directamente (no { ok, data })
  _bcState.printers = typeof printerMonitorRefresh === 'function'
    ? await printerMonitorRefresh({ reason: 'labels-open' })
    : await window.api.print.getPrinters().catch(() => []);
  if (!Array.isArray(_bcState.printers)) _bcState.printers = [];
  const savedLabelPrinter = String(settings?.barcode_printer || '').trim();
  const labelChoice = typeof chooseLabelPrinter === 'function'
    ? chooseLabelPrinter(_bcState.printers, savedLabelPrinter, settings)
    : { printerName: savedLabelPrinter, autoDetected: false,
        classified: _bcState.printers.map(printer => ({ ...printer,
          labelDetection: _bcDetectPrinter(printer.name) })) };
  _bcState.printers = labelChoice.classified;
  _bcState.selPrinter = savedLabelPrinter || labelChoice.printerName;
  if (!savedLabelPrinter && labelChoice.autoDetected) {
    const bindingRaw = _bcLabelBindings(
      settings?.printer_channel_bindings || DB?.settings?.printer_channel_bindings,
      _bcState.selPrinter
    );
    await window.api.settings.set({
      key: 'barcode_printer',
      value: _bcState.selPrinter,
      requestUserId: user?.id,
    }).catch(() => {});
    await window.api.settings.set({
      key: 'printer_channel_bindings',
      value: bindingRaw,
      requestUserId: user?.id,
    }).catch(() => {});
    settings.barcode_printer = _bcState.selPrinter;
    settings.printer_channel_bindings = bindingRaw;
    if (DB?.settings) Object.assign(DB.settings, {
      barcode_printer: _bcState.selPrinter,
      printer_channel_bindings: bindingRaw,
    });
  }
  _bcState.labelType  = settings?.barcode_label_type || 'interno';
  _bcState.profileId = settings?.barcode_printer_profile ||
    (settings?.barcode_paper_72mm === '1' ? 'label_generic' : '');
  _bcState.mediaWidthMm = Number(settings?.barcode_media_width_mm) ||
    (settings?.barcode_paper_72mm === '1' ? 72 : 100);
  _bcState.printerDpi = Number(settings?.barcode_printer_dpi) || 203;
  _bcState.mediaMode = settings?.barcode_media_mode || 'gap';
  const hasSavedCalibration = _bcApplySavedCalibration();
  _bcState.detection = _bcDetectPrinter();
  if (!hasSavedCalibration) {
    if (!_bcState.profileId && _bcState.detection?.id === 'label_2connect_108') {
      _bcState.profileId = _bcState.detection.id;
      _bcState.mediaWidthMm = _bcState.detection.widthMm;
      _bcState.printerDpi = _bcState.detection.dpi;
    }
  }

  el.innerHTML = '';
  el.style.overflowY = 'auto';
  el.style.paddingBottom = '60px';

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', {
    class: embedded ? 'card' : 'sec-hdr',
    style: embedded ? 'margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px' : ''
  },
    h('div', null,
      h('div', { class: embedded ? 'card-title' : 'sec-title' }, 'Producción de etiquetas'),
      h('div', {
        class: embedded ? '' : 'sec-sub',
        style: embedded ? 'font-size:11px;color:var(--muted2);margin-top:3px' : ''
      }, 'Selecciona productos, define cantidad e imprime')
    ),
    h('div', { style: 'display:flex;gap:8px' },
      h('button', {
        class: 'btn btn-out btn-sm',
        style: ['admin','superadmin'].includes(user?.role) ? '' : 'display:none',
        onclick: () => pcOpenLabelDesigner(),
        html: `${svg('settings')} Diseñar`
      }),
      h('button', {
        class: 'btn btn-out btn-sm',
        onclick: () => _bcOpenPreview(),
        html: `${svg('eye')} Vista Previa`
      }),
      h('button', {
        class: 'btn btn-green',
        onclick: () => _bcPrint(),
        html: `${svg('print')} Imprimir Etiquetas`
      })
    )
  ));

  // ── Layout principal ─────────────────────────
  const grid = h('div', { style: 'display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start' });

  // Columna izquierda: selección de productos
  const leftCol = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  // Card selector de productos
  const prodCard = h('div', { class: 'card' });
  prodCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Seleccionar Productos</div>
      <div style="display:flex;gap:6px;align-items:center">
        <div class="inp-ic" style="width:200px">
          <div class="ic">${svg('search')}</div>
          <input class="inp" id="bc-search" placeholder="Buscar producto..." oninput="bcFilterProducts(this.value)"/>
        </div>
        <button class="btn btn-out btn-sm" onclick="bcSelectAll()">Todos</button>
        <button class="btn btn-out btn-sm" onclick="bcClearAll()">Limpiar</button>
      </div>
    </div>
    <div id="bc-prod-list" style="max-height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:8px">
    </div>`;
  leftCol.appendChild(prodCard);
  grid.appendChild(leftCol);

  // Columna derecha: config de impresión + resumen
  const rightCol = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  // Card tipo de etiqueta
  const typeCard = h('div', { class: 'card' });
  const _lt = _bcState.labelType;
  typeCard.innerHTML = `
    <div class="card-title mb8">Tipo de Etiqueta</div>
    <div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
        <input type="radio" name="bc-ltype" value="interno" ${_lt === 'interno' ? 'checked' : ''}
               onchange="bcSetLabelType(this.value)" style="margin-top:2px"/>
        <span><b>Interno</b><br><span style="color:var(--muted2);font-size:11px">Nombre, código, precio y código de barras</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
        <input type="radio" name="bc-ltype" value="proveedor" ${_lt === 'proveedor' ? 'checked' : ''}
               onchange="bcSetLabelType(this.value)" style="margin-top:2px"/>
        <span><b>Proveedor</b><br><span style="color:var(--muted2);font-size:11px">Nombre, código y código de barras (sin precio)</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
        <input type="radio" name="bc-ltype" value="personalizado" ${_lt === 'personalizado' ? 'checked' : ''}
               onchange="bcSetLabelType(this.value)" style="margin-top:2px"/>
        <span><b>Personalizado</b><br><span style="color:var(--muted2);font-size:11px">Según el diseño configurado en el panel</span></span>
      </label>
    </div>`;
  rightCol.appendChild(typeCard);

  // Card impresora
  const prCard = h('div', { class: 'card' });
  const detectedNow = _bcState.detection || _bcDetectPrinter();
  const detectionTone = detectedNow.confidence === 'high' ? 'var(--green)'
    : detectedNow.confidence === 'medium' ? 'var(--blue)' : 'var(--orange)';
  const detectionLabel = detectedNow.confidence === 'high' ? 'Modelo reconocido'
    : detectedNow.confidence === 'medium' ? 'Familia reconocida' : 'Requiere prueba';
  prCard.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Impresora de Etiquetas</div>
      <button class="btn btn-out btn-sm" onclick="_bcOpenCalibrationWizard()">
        ${svg('settings')} Detectar y calibrar
      </button>
    </div>
    <div class="fg">
      <label class="lbl">Seleccionar impresora</label>
      <select class="inp" id="bc-printer-sel" onchange="bcSavePrinter(this.value)">
        ${_bcPrinterOptions()}
      </select>
    </div>
    <div id="bc-printer-badge" style="margin-top:4px"></div>
    <div id="bc-detection-summary" style="margin-top:8px;padding:8px 10px;border:1px solid var(--line);
         border-left:3px solid ${detectionTone};border-radius:7px;background:var(--surface2);
         font-size:11px;line-height:1.45;color:var(--muted2)">
      <div style="font-weight:700;color:var(--ink3)">${detectionLabel} · ${detectedNow.widthMm} mm · ${detectedNow.dpi} DPI</div>
      <div>${_bcEsc(detectedNow.reason || '')}</div>
      ${_bcCurrentCalibration() ? '<div style="color:var(--green);font-weight:700">✓ Calibración guardada para esta impresora</div>' : ''}
    </div>
    <div class="fg" style="margin-top:12px">
      <label class="lbl">Perfil del medio</label>
      <select class="inp" id="bc-profile" onchange="bcSetPrinterProfile(this.value)">
        <option value="" ${!_bcState.profileId?'selected':''}>Automático según impresora</option>
        <option value="label_2connect_108" ${_bcState.profileId==='label_2connect_108'?'selected':''}>2Connect 2C-LP427B · 108 mm · 203 dpi</option>
        <option value="label_generic" ${_bcState.profileId==='label_generic'?'selected':''}>Universal · ancho configurable</option>
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="fg" style="margin:0">
        <label class="lbl">Ancho del rollo / medio (mm)</label>
        <input class="inp" id="bc-media-width" type="number" min="20" max="150" step="0.1"
               value="${_bcState.mediaWidthMm}" onchange="bcSaveMediaConfig()"/>
      </div>
      <div class="fg" style="margin:0">
        <label class="lbl">Resolución (DPI)</label>
        <input class="inp" id="bc-dpi" type="number" min="100" max="1200"
               value="${_bcState.printerDpi}" onchange="bcSaveMediaConfig()"/>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted2);margin-top:5px">
      Este valor describe el <b>papel o soporte físico</b>. El tamaño de cada etiqueta se define aparte en el diseñador y nunca se estira automáticamente.
    </div>
    <div class="fg" style="margin-top:8px">
      <label class="lbl">Avance del papel</label>
      <select class="inp" id="bc-media-mode" onchange="bcSaveMediaConfig()">
        <option value="gap" ${_bcState.mediaMode==='gap'?'selected':''}>Etiquetas con espacio / sensor (una fila por avance)</option>
        <option value="mark" ${_bcState.mediaMode==='mark'?'selected':''}>Marca negra / sensor (una fila por avance)</option>
        <option value="continuous" ${_bcState.mediaMode==='continuous'?'selected':''}>Rollo continuo</option>
      </select>
      <div style="font-size:11px;color:var(--muted2);margin-top:5px">
        Envío universal por el controlador del sistema. Compatible con equipos que internamente emulan ZPL/TSPL/EPS/EPL/DPL.
      </div>
    </div>
    <div class="fg" style="margin-top:12px">
      <label class="lbl">Copias por producto (global)</label>
      <input class="inp" id="bc-global-qty" type="number" min="1" max="999" value="1"
             oninput="bcApplyGlobalQty(this.value)" style="width:100px"/>
    </div>`;
  rightCol.appendChild(prCard);

  // Card resumen de selección
  const sumCard = h('div', { class: 'card', id: 'bc-summary-card' });
  sumCard.innerHTML = `
    <div class="card-title mb8">Resumen de Impresión</div>
    <div id="bc-summary-body">
      <div style="color:var(--muted2);font-size:12px;padding:12px 0">
        Ningún producto seleccionado
      </div>
    </div>`;
  rightCol.appendChild(sumCard);

  // Card diseño (solo lectura para admin, link a superadmin)
  const dsnCard = h('div', { class: 'card' });
  const d = _bcState.design;
  dsnCard.innerHTML = `
    <div class="card-title mb8">Diseño Actual</div>
    <div style="background:var(--surface2);border-radius:8px;padding:12px;font-size:12px">
      <div class="tr" style="margin-bottom:6px">
        <span style="color:var(--muted2)">Tamaño</span>
        <span style="font-weight:700">${d.labelW}×${d.labelH} mm</span>
      </div>
      <div class="tr" style="margin-bottom:6px">
        <span style="color:var(--muted2)">Medio</span>
        <span style="font-weight:700">${_bcState.mediaWidthMm} mm</span>
      </div>
      <div class="tr" style="margin-bottom:6px">
        <span style="color:var(--muted2)">Tipo código</span>
        <span>${d.format}</span>
      </div>
      <div class="tr" style="margin-bottom:6px">
        <span style="color:var(--muted2)">Fuente</span>
        <span>${d.fontSize}px ${d.fontFamily}</span>
      </div>
      <div class="tr">
        <span style="color:var(--muted2)">Elementos</span>
        <span>${[d.showName?'Nombre':'',d.showPrice?'Precio':'',d.showBrand?'Marca':'',d.showCode?'Código':''].filter(Boolean).join(', ')||'—'}</span>
      </div>
    </div>
    ${['admin','superadmin'].includes(user?.role) ? `
    <button class="btn btn-out btn-sm" style="margin-top:10px;width:100%"
            onclick="pcOpenLabelDesigner()">
      ${svg('settings')} Editar diseño de etiqueta
    </button>` : `
    <div style="font-size:11px;color:var(--muted2);margin-top:8px">
      El diseño lo configura el administrador del sistema
    </div>`}`;
  rightCol.appendChild(dsnCard);

  grid.appendChild(rightCol);
  el.appendChild(grid);

  // Renderizar lista de productos
  _bcRenderProductList();

  // Badge de impresora
  _bcUpdatePrinterBadge();
}

// ── Lista de productos ────────────────────────
function _bcRenderProductList(filter = '') {
  const list = document.getElementById('bc-prod-list');
  if (!list) return;

  const prods = DB.products.filter(p => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return p.name.toLowerCase().includes(q) ||
           (p.code || '').toLowerCase().includes(q) ||
           (p.barcode || '').toLowerCase().includes(q);
  });

  list.innerHTML = '';

  if (!prods.length) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted2);font-size:13px">Sin resultados</div>`;
    return;
  }

  prods.forEach(p => {
    const qty   = _bcState.selected[p.id] || 0;
    const isOn  = qty > 0;
    const row   = document.createElement('div');
    row.style.cssText = `
      display:flex;align-items:center;gap:10px;padding:10px 12px;
      border-bottom:1px solid var(--line);cursor:pointer;
      background:${isOn ? 'var(--blue-bg)' : 'transparent'};
      transition:background .1s;
    `;
    row.innerHTML = `
      <div style="width:18px;height:18px;border-radius:4px;border:2px solid ${isOn?'var(--blue)':'var(--line)'};
                  background:${isOn?'var(--blue)':'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${isOn ? `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_bcEsc(p.name)}</div>
        <div style="font-size:11px;color:var(--muted2)">${_bcEsc(p.code)||'—'} ${p.barcode?'· '+_bcEsc(p.barcode):''}</div>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--ink3);flex-shrink:0">${fmt(p.price)}</div>
      ${isOn ? `
        <div onclick="event.stopPropagation()" style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          <button onclick="_bcQtyChange(${p.id},-1)"
                  style="width:24px;height:24px;border:1px solid var(--line);border-radius:4px;background:var(--surface);cursor:pointer;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center">−</button>
          <input  id="bc-qty-${p.id}" type="number" min="1" max="999"
                  value="${qty}"
                  onchange="_bcQtySet(${p.id}, this.value)"
                  style="width:44px;height:24px;text-align:center;border:1px solid var(--line);border-radius:4px;font-size:12px;font-weight:700;padding:0 4px;background:var(--surface);color:var(--ink)"/>
          <button onclick="_bcQtyChange(${p.id},+1)"
                  style="width:24px;height:24px;border:1px solid var(--line);border-radius:4px;background:var(--surface);cursor:pointer;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center">+</button>
        </div>` : ''}
    `;
    row.addEventListener('click', () => {
      if (!isOn) {
        const globalQty = parseInt(document.getElementById('bc-global-qty')?.value || '1') || 1;
        _bcState.selected[p.id] = globalQty;
      } else {
        delete _bcState.selected[p.id];
      }
      _bcRenderProductList(document.getElementById('bc-search')?.value || '');
      _bcUpdateSummary();
    });
    list.appendChild(row);
  });
}

function bcFilterProducts(v) { _bcRenderProductList(v); }

function bcSelectAll() {
  const gQty = parseInt(document.getElementById('bc-global-qty')?.value || '1') || 1;
  DB.products.forEach(p => { _bcState.selected[p.id] = gQty; });
  _bcRenderProductList(document.getElementById('bc-search')?.value || '');
  _bcUpdateSummary();
}

function bcClearAll() {
  _bcState.selected = {};
  _bcRenderProductList(document.getElementById('bc-search')?.value || '');
  _bcUpdateSummary();
}

function bcApplyGlobalQty(v) {
  const qty = Math.max(1, parseInt(v) || 1);
  Object.keys(_bcState.selected).forEach(id => {
    _bcState.selected[id] = qty;
  });
  _bcRenderProductList(document.getElementById('bc-search')?.value || '');
  _bcUpdateSummary();
}

function _bcQtyChange(id, delta) {
  const cur = _bcState.selected[id] || 0;
  const nv  = Math.max(1, cur + delta);
  _bcState.selected[id] = nv;
  const input = document.getElementById(`bc-qty-${id}`);
  if (input) input.value = nv;
  _bcUpdateSummary();
}

function _bcQtySet(id, v) {
  _bcState.selected[id] = Math.max(1, parseInt(v) || 1);
  _bcUpdateSummary();
}

// ── Resumen ───────────────────────────────────
function _bcUpdateSummary() {
  const body = document.getElementById('bc-summary-body');
  if (!body) return;
  const ids = Object.keys(_bcState.selected);
  if (!ids.length) {
    body.innerHTML = `<div style="color:var(--muted2);font-size:12px;padding:12px 0">Ningún producto seleccionado</div>`;
    return;
  }
  const total = ids.reduce((s, id) => s + (_bcState.selected[id] || 0), 0);
  let html = `<div style="font-size:11px;color:var(--muted2);margin-bottom:8px">${ids.length} producto(s) · ${total} etiqueta(s) total</div>`;
  html += `<div style="max-height:200px;overflow-y:auto;border:1px solid var(--line);border-radius:6px">`;
  ids.forEach(id => {
    const p = DB.products.find(x => x.id == id);
    if (!p) return;
    html += `
      <div style="display:flex;justify-content:space-between;padding:7px 10px;border-bottom:1px solid var(--line);font-size:12px">
        <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_bcEsc(p.name)}</div>
        <div style="font-weight:700;color:var(--blue);margin-left:8px;flex-shrink:0">×${_bcState.selected[id]}</div>
      </div>`;
  });
  html += `</div>`;
  body.innerHTML = html;
}

// ── Impresora ─────────────────────────────────
async function bcSavePrinter(name) {
  _bcState.selPrinter = name;
  const hasSaved = _bcApplySavedCalibration(name);
  _bcState.detection = _bcDetectPrinter(name);
  if (!hasSaved && _bcState.detection?.confidence === 'high') {
    _bcState.profileId = _bcState.detection.id;
    _bcState.mediaWidthMm = _bcState.detection.widthMm;
    _bcState.printerDpi = _bcState.detection.dpi;
  }
  _bcSyncMediaControls();
  const bindingRaw = _bcLabelBindings(DB?.settings?.printer_channel_bindings, name);
  await Promise.all([
    window.api.settings.set({ key: 'barcode_printer', value: name, requestUserId: user?.id }),
    window.api.settings.set({ key: 'printer_channel_bindings', value: bindingRaw, requestUserId: user?.id }),
    window.api.settings.set({ key: 'barcode_printer_profile', value: _bcState.profileId || '', requestUserId: user?.id }),
    window.api.settings.set({ key: 'barcode_media_width_mm', value: String(_bcState.mediaWidthMm), requestUserId: user?.id }),
    window.api.settings.set({ key: 'barcode_printer_dpi', value: String(_bcState.printerDpi), requestUserId: user?.id }),
  ]).catch(() => {});
  if (DB?.settings) Object.assign(DB.settings, {
    barcode_printer: name,
    printer_channel_bindings: bindingRaw,
  });
  _bcUpdatePrinterBadge();
  _bcRenderDetectionSummary();
}

// ── Tipo de etiqueta y papel térmico ──────────
async function bcSetLabelType(v) {
  _bcState.labelType = v;
  await window.api.settings.set({
    key: 'barcode_label_type', value: v, requestUserId: user?.id
  }).catch(() => {});
}
async function bcSetPrinterProfile(id) {
  _bcState.profileId = id || '';
  if (id === 'label_2connect_108') {
    _bcState.mediaWidthMm = 108;
    _bcState.printerDpi = 203;
    const width = document.getElementById('bc-media-width');
    const dpi = document.getElementById('bc-dpi');
    if (width) width.value = '108';
    if (dpi) dpi.value = '203';
  }
  await bcSaveMediaConfig();
  _bcUpdatePrinterBadge();
}

async function bcSaveMediaConfig() {
  _bcState.mediaWidthMm = Math.min(150, Math.max(20,
    Number(document.getElementById('bc-media-width')?.value) || _bcState.mediaWidthMm || 100));
  _bcState.printerDpi = Math.min(1200, Math.max(100,
    Number(document.getElementById('bc-dpi')?.value) || _bcState.printerDpi || 203));
  _bcState.mediaMode = document.getElementById('bc-media-mode')?.value || _bcState.mediaMode || 'gap';
  const calibration = _bcCurrentCalibration();
  if (calibration) {
    calibration.profileId = _bcState.profileId || calibration.profileId;
    calibration.widthMm = _bcState.mediaWidthMm;
    calibration.dpi = _bcState.printerDpi;
    calibration.mediaMode = _bcState.mediaMode;
    calibration.updatedAt = new Date().toISOString();
  }
  // El ancho del medio y el ancho de cada etiqueta son medidas distintas.
  // Cambiar el rollo nunca debe estirar ni sobrescribir el diseño guardado.
  const channelProfiles = _bcLabelProfiles(
    DB?.settings?.printer_channel_profiles,
    _bcState.profileId
  );
  const saves = [
    window.api.settings.set({ key: 'barcode_printer_profile', value: _bcState.profileId || '', requestUserId: user?.id }),
    window.api.settings.set({
      key: 'printer_channel_profiles',
      value: channelProfiles,
      requestUserId: user?.id,
    }),
    window.api.settings.set({ key: 'barcode_media_width_mm', value: String(_bcState.mediaWidthMm), requestUserId: user?.id }),
    window.api.settings.set({ key: 'barcode_printer_dpi', value: String(_bcState.printerDpi), requestUserId: user?.id }),
    window.api.settings.set({ key: 'barcode_media_mode', value: _bcState.mediaMode, requestUserId: user?.id }),
  ];
  if (calibration) {
    saves.push(window.api.settings.set({
      key: 'barcode_calibrations',
      value: JSON.stringify(_bcState.calibrations),
      requestUserId: user?.id,
    }));
  }
  await Promise.all(saves).catch(() => {});
  if (DB?.settings) DB.settings.printer_channel_profiles = channelProfiles;
  _bcState.detection = _bcDetectPrinter();
  _bcUpdatePrinterBadge();
  _bcRenderDetectionSummary();
}

// Diseño EFECTIVO para generar/imprimir: aplica el tipo de etiqueta elegido
// (interno = con precio, proveedor = sin precio) sobre el diseño base, y el
// 'personalizado' respeta el diseño tal cual lo configuró el panel.
function _bcEffectiveDesign() {
  const d = { ...(_bcState.design || _bcDefaultDesign()) };
  const calibration = _bcCurrentCalibration();
  if (calibration) {
    d.labelH = Number(calibration.labelHeightMm) || d.labelH;
    d.gapMm = Number.isFinite(Number(calibration.gapMm)) ? Number(calibration.gapMm) : d.gapMm;
    d.offsetXmm = Number(calibration.offsetXmm) || 0;
    d.offsetYmm = Number(calibration.offsetYmm) || 0;
  }
  const t = _bcState.labelType || 'interno';
  if (t === 'interno')   Object.assign(d, { showName: true, showCode: true, showPrice: true,  showBarcode: true });
  if (t === 'proveedor') Object.assign(d, { showName: true, showCode: true, showPrice: false, showBarcode: true });
  // Se HONRA el "Margen de página" configurado en el diseñador: la etiqueta se
  // inset por ese margen (lw = ancho - 2·margen) para dejar aire alrededor del
  // contenido. Se acota para que nunca deje la etiqueta sin espacio útil.
  d.pageMm = Math.max(0, Math.min(Number(d.pageMm) || 0, ((Number(d.labelW) || 50) / 2) - 5));
  return d;
}

function _bcPrinterProfile() {
  const settings = {
    barcode_printer_profile: _bcState.profileId,
    barcode_media_width_mm: _bcState.mediaWidthMm,
    barcode_printer_dpi: _bcState.printerDpi,
  };
  return typeof resolvePrinterProfile === 'function'
    ? resolvePrinterProfile(_bcState.selPrinter, 'barcode', settings)
    : { id: 'label_generic', label: 'Etiquetas', kind: 'labels',
        widthMm: _bcState.mediaWidthMm || 100, printableWidthMm: _bcState.mediaWidthMm || 100,
        dpi: _bcState.printerDpi || 203, languages: ['Driver'] };
}

function _bcUpdatePrinterBadge() {
  const badge = document.getElementById('bc-printer-badge');
  if (!badge) return;
  const p = _bcState.selPrinter;
  if (!p) {
    badge.innerHTML = `<div class="badge o">Selecciona una impresora de etiquetas</div>
      <div style="font-size:10.5px;color:var(--muted2);margin-top:5px">
        Velo no usará la impresora de facturas ni la predeterminada del sistema.
      </div>`;
    return;
  }
  const tipo = _bcLabelType(p);
  const profile = _bcPrinterProfile();
  const printerInfo = (_bcState.printers || []).find(printer => printer.name === p);
  const available = !!printerInfo;
  const runtime = printerInfo && typeof getPrinterRuntimeState === 'function'
    ? getPrinterRuntimeState(printerInfo) : null;
  const ready = available && !runtime?.reportedIssue;
  badge.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center">
      <div class="badge ${ready ? 'g' : available ? 'o' : 'r'}">${ready ? svg('check') : svg('alert')} ${p}</div>
      ${tipo ? `<div class="badge b">${tipo}</div>` : ''}
      <div class="badge n">${profile.widthMm}mm · ${profile.dpi}dpi</div>
      ${_bcCurrentCalibration() ? '<div class="badge g">Calibrada</div>' : ''}
    </div>
    ${!available ? `<div style="font-size:10.5px;color:var(--red);margin-top:5px">
      La cola guardada no está disponible. VELO no enviará el trabajo hasta que vuelva o selecciones otra.
    </div>` : runtime?.reportedIssue ? `<div style="font-size:10.5px;color:var(--orange);margin-top:5px">
      El controlador reporta: ${_bcEsc(runtime.stateReason || 'no acepta trabajos')}.
    </div>` : ''}`;
}

function _bcRenderDetectionSummary() {
  const box = document.getElementById('bc-detection-summary');
  if (!box) return;
  const detected = _bcState.detection || _bcDetectPrinter();
  const available = !!_bcState.selPrinter &&
    (_bcState.printers || []).some(printer => printer.name === _bcState.selPrinter);
  const tone = detected.runtime?.reportedIssue ? 'var(--red)'
    : detected.confidence === 'high' ? 'var(--green)'
    : detected.confidence === 'medium' ? 'var(--blue)' : 'var(--orange)';
  const label = detected.runtime?.reportedIssue ? 'Incidencia reportada'
    : detected.confidence === 'high' ? 'Modelo reconocido'
    : detected.confidence === 'medium' ? 'Familia reconocida' : 'Requiere prueba';
  box.style.borderLeftColor = tone;
  box.innerHTML = `
    <div style="font-weight:700;color:var(--ink3)">${label} · ${detected.widthMm} mm · ${detected.dpi} DPI</div>
    <div>${_bcEsc(detected.reason || '')}</div>
    ${detected.runtime?.model ? `<div>Modelo del controlador: ${_bcEsc(detected.runtime.model)}</div>` : ''}
    ${detected.runtime?.stateReason ? `<div>Estado: ${_bcEsc(detected.runtime.stateReason)}</div>` : ''}
    ${_bcState.selPrinter ? `<div style="color:${available ? 'var(--green)' : 'var(--red)'};font-weight:700">
      ${available ? '✓ Cola disponible en esta terminal' : '⚠ Cola no disponible en esta terminal'}
    </div>` : ''}
    ${_bcCurrentCalibration() ? '<div style="color:var(--green);font-weight:700">✓ Calibración guardada para esta impresora</div>' : ''}`;
}

function _bcLabelType(name) {
  if (!name) return '';
  const n = name.toLowerCase();
  if (/zebra|zpl/.test(n))    return 'Zebra · ZPL';
  if (/2\s*connect|2c[-_ ]?lp427|lp[-_ ]?427/.test(n)) return '2Connect · ZPL/TSPL';
  if (/honeyw/.test(n))       return 'Honeywell';
  if (/tsc/.test(n))          return 'TSC';
  if (/sato/.test(n))         return 'SATO';
  if (/bixolon|srp/.test(n))  return 'Bixolon';
  if (/brother|ql/.test(n))   return 'Brother';
  if (/dymo/.test(n))         return 'DYMO';
  if (/godex/.test(n))        return 'Godex';
  if (/argox/.test(n))        return 'Argox';
  return '';
}

function _bcPrinterOptions() {
  const printers = _bcState.printers || [];
  const dedicated = printers.filter(p =>
    ['high', 'medium'].includes(p.labelDetection?.confidence)
  );
  const manual = printers.filter(p =>
    !['high', 'medium'].includes(p.labelDetection?.confidence)
  );
  const render = p => {
    const type = _bcLabelType(p.name);
    const suffix = type || p.labelDetection?.confidence === 'high'
      ? (type || 'Modelo reconocido')
      : 'Selección manual';
    return `<option value="${_bcEsc(p.name)}" ${p.name === _bcState.selPrinter ? 'selected' : ''}>
      ${_bcEsc(p.displayName || p.name)} · ${_bcEsc(suffix)}
    </option>`;
  };
  return `
    <option value="">— Selecciona la impresora de etiquetas —</option>
    ${_bcState.selPrinter && !printers.some(p => p.name === _bcState.selPrinter)
      ? `<option value="${_bcEsc(_bcState.selPrinter)}" selected disabled>${_bcEsc(_bcState.selPrinter)} · no disponible</option>`
      : ''}
    ${dedicated.length ? `<optgroup label="Impresoras de etiquetas detectadas">${dedicated.map(render).join('')}</optgroup>` : ''}
    ${manual.length ? `<optgroup label="Otras impresoras (selección manual)">${manual.map(render).join('')}</optgroup>` : ''}
  `;
}

async function _bcHandlePrinterSnapshot(printers) {
  const settings = {
    barcode_printer_profile: _bcState.profileId,
    barcode_media_width_mm: _bcState.mediaWidthMm,
    barcode_printer_dpi: _bcState.printerDpi,
  };
  _bcState.printers = typeof classifyLabelPrinters === 'function'
    ? classifyLabelPrinters(printers, settings)
    : (Array.isArray(printers) ? printers : []);
  const select = document.getElementById('bc-printer-sel');
  if (!select) return;

  if (!_bcState.selPrinter && typeof chooseLabelPrinter === 'function') {
    const choice = chooseLabelPrinter(_bcState.printers, '', settings);
    _bcState.printers = choice.classified;
    if (choice.autoDetected && choice.printerName) {
      await bcSavePrinter(choice.printerName);
      toast(`✓ Etiquetadora detectada: ${choice.printerName}`, 'ok');
    }
  }
  select.innerHTML = _bcPrinterOptions();
  select.value = _bcState.selPrinter || '';
  _bcState.detection = _bcDetectPrinter();
  _bcUpdatePrinterBadge();
  _bcRenderDetectionSummary();
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('velo:printers-changed', event => {
    _bcHandlePrinterSnapshot(event.detail?.printers || []).catch(() => {});
  });
}

// ══════════════════════════════════════════════
// ASISTENTE DE DETECCIÓN Y CALIBRACIÓN
// ══════════════════════════════════════════════
function _bcOpenCalibrationWizard() {
  if (!_bcState.selPrinter) {
    toast('Selecciona primero la impresora de etiquetas', 'w');
    document.getElementById('bc-printer-sel')?.focus();
    return;
  }
  const detected = _bcDetectPrinter();
  const saved = _bcCurrentCalibration();
  const d = _bcState.design || _bcDefaultDesign();
  window._bcCalWizard = {
    printerName: _bcState.selPrinter || '',
    detected,
    profileId: saved?.profileId || _bcState.profileId || detected.id || 'label_generic',
    widthMm: Number(saved?.widthMm) || Number(_bcState.mediaWidthMm) || detected.widthMm || 50,
    labelWidthMm: Number(d.labelW) || 50,
    labelHeightMm: Number(saved?.labelHeightMm) || Number(d.labelH) || 25,
    gapMm: Number.isFinite(Number(saved?.gapMm)) ? Number(saved.gapMm) : (Number(d.gapMm) || 0),
    pageMm: Number(d.pageMm) || 0,
    cols: Math.max(1, Number(d.cols) || 1),
    dpi: Number(saved?.dpi) || Number(_bcState.printerDpi) || detected.dpi || 203,
    mediaMode: saved?.mediaMode || _bcState.mediaMode || 'gap',
    offsetXmm: saved && Number.isFinite(Number(saved.offsetXmm))
      ? Number(saved.offsetXmm) : (Number(d.offsetXmm) || 0),
    offsetYmm: saved && Number.isFinite(Number(saved.offsetYmm))
      ? Number(saved.offsetYmm) : (Number(d.offsetYmm) || 0),
  };

  const confidenceText = detected.confidence === 'high' ? 'Alta'
    : detected.confidence === 'medium' ? 'Media' : 'Por confirmar';
  const confidenceColor = detected.confidence === 'high' ? 'var(--green)'
    : detected.confidence === 'medium' ? 'var(--blue)' : 'var(--orange)';
  const printerTitle = detected.displayName || detected.printerName;

  openModal(`
    <div class="modal-title">Detectar y calibrar impresora de etiquetas</div>
    <div class="modal-sub">Una prueba corta guarda las medidas y la posición únicamente para esta impresora.</div>

    <div style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(280px,.85fr);gap:14px;margin-top:14px">
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--surface2)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div>
              <div style="font-size:11px;color:var(--muted2);font-weight:700;text-transform:uppercase">1 · Detección</div>
              <div style="font-size:13px;font-weight:700;color:var(--ink);margin-top:3px">${_bcEsc(printerTitle)}</div>
              <div style="font-size:11px;color:var(--muted2);margin-top:3px">${_bcEsc(detected.reason || '')}</div>
            </div>
            <div class="badge ${detected.confidence === 'high' ? 'g' : detected.confidence === 'medium' ? 'b' : 'o'}">
              Confianza ${confidenceText.toLowerCase()}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:9px;font-size:11px">
            <span class="badge n">${detected.label || detected.id}</span>
            <span class="badge n">${detected.widthMm} mm</span>
            <span class="badge n">${detected.dpi} DPI</span>
            ${detected.isDefault ? '<span class="badge g">Predeterminada</span>' : ''}
          </div>
          ${detected.confidence !== 'low' ? `
            <button class="btn btn-out btn-sm" style="margin-top:9px" onclick="_bcCalUseDetected()">
              Usar valores detectados
            </button>` : `
            <div style="font-size:10.5px;color:${confidenceColor};margin-top:8px">
              El controlador no informa el tamaño físico. Confírmalo con la etiqueta de prueba.
            </div>`}
        </div>

        <div style="border:1px solid var(--line);border-radius:10px;padding:12px">
          <div style="font-size:11px;color:var(--muted2);font-weight:700;text-transform:uppercase;margin-bottom:9px">2 · Medio y etiqueta física</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px">
            <div class="fg" style="margin:0">
              <label class="lbl">Ancho del medio</label>
              <input class="inp" id="bc-cal-width" type="number" min="20" max="150" step="0.1"
                     value="${window._bcCalWizard.widthMm}" oninput="_bcCalRender()">
            </div>
            <div class="fg" style="margin:0">
              <label class="lbl">Ancho etiqueta</label>
              <input class="inp" id="bc-cal-label-width" type="number" min="10" max="150" step="0.5"
                     value="${window._bcCalWizard.labelWidthMm}" oninput="_bcCalRender()">
            </div>
            <div class="fg" style="margin:0">
              <label class="lbl">Alto etiqueta</label>
              <input class="inp" id="bc-cal-height" type="number" min="8" max="300" step="0.5"
                     value="${window._bcCalWizard.labelHeightMm}" oninput="_bcCalRender()">
            </div>
            <div class="fg" style="margin:0">
              <label class="lbl">Separación (mm)</label>
              <input class="inp" id="bc-cal-gap" type="number" min="0" max="30" step="0.5"
                     value="${window._bcCalWizard.gapMm}" oninput="_bcCalRender()">
            </div>
            <div class="fg" style="margin:0">
              <label class="lbl">Resolución</label>
              <select class="inp" id="bc-cal-dpi" onchange="_bcCalRender()">
                ${[203,300,600].map(v => `<option value="${v}" ${Number(window._bcCalWizard.dpi)===v?'selected':''}>${v} DPI</option>`).join('')}
              </select>
            </div>
            <div class="fg" style="margin:0;grid-column:span 2">
              <label class="lbl">Sensor / avance</label>
              <select class="inp" id="bc-cal-mode" onchange="_bcCalRender()">
                <option value="gap" ${window._bcCalWizard.mediaMode==='gap'?'selected':''}>Espacio entre etiquetas</option>
                <option value="mark" ${window._bcCalWizard.mediaMode==='mark'?'selected':''}>Marca negra</option>
                <option value="continuous" ${window._bcCalWizard.mediaMode==='continuous'?'selected':''}>Rollo continuo</option>
              </select>
            </div>
          </div>
        </div>

        <div style="border:1px solid var(--line);border-radius:10px;padding:12px">
          <div style="font-size:11px;color:var(--muted2);font-weight:700;text-transform:uppercase">3 · Centrar contenido</div>
          <div style="font-size:11px;color:var(--muted2);margin:4px 0 10px">Imprime la prueba. Después mueve el contenido en la dirección que necesite el papel.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="lbl">Horizontal X</label>
              <div style="display:flex;gap:4px;align-items:center">
                <button class="btn btn-out btn-sm" onclick="_bcCalAdjust('x',-0.5)">←</button>
                <input class="inp" id="bc-cal-x" type="number" min="-30" max="30" step="0.5"
                       value="${window._bcCalWizard.offsetXmm}" oninput="_bcCalRender()" style="text-align:center">
                <button class="btn btn-out btn-sm" onclick="_bcCalAdjust('x',0.5)">→</button>
              </div>
            </div>
            <div>
              <label class="lbl">Vertical Y</label>
              <div style="display:flex;gap:4px;align-items:center">
                <button class="btn btn-out btn-sm" onclick="_bcCalAdjust('y',-0.5)">↑</button>
                <input class="inp" id="bc-cal-y" type="number" min="-30" max="30" step="0.5"
                       value="${window._bcCalWizard.offsetYmm}" oninput="_bcCalRender()" style="text-align:center">
                <button class="btn btn-out btn-sm" onclick="_bcCalAdjust('y',0.5)">↓</button>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px">
            <button class="btn btn-out btn-sm" onclick="_bcCalResetPosition()">Centrar en 0,0</button>
            <button class="btn btn-dark btn-sm" onclick="_bcCalPrintTest()">${svg('print')} Imprimir prueba</button>
          </div>
          <div id="bc-cal-result" style="font-size:11px;color:var(--muted2);margin-top:8px">
            La prueba debe mostrar marco, cuatro esquinas, cruz central y medidas.
          </div>
        </div>
      </div>

      <div style="border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;flex-direction:column">
        <div style="font-size:11px;color:var(--muted2);font-weight:700;text-transform:uppercase">Vista de calibración</div>
        <div id="bc-cal-sheet" style="margin-top:10px;flex:1;min-height:260px;background:#e5e7eb;border-radius:8px;
             display:flex;align-items:flex-start;justify-content:center;padding:18px;overflow:hidden">
          <div id="bc-cal-preview" style="position:relative;background:#fff;border:2px solid #111;box-sizing:border-box">
            <div style="position:absolute;left:50%;top:10%;bottom:10%;border-left:1px dashed #111"></div>
            <div style="position:absolute;top:50%;left:8%;right:8%;border-top:1px dashed #111"></div>
            <div style="position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px;border-radius:50%;background:#111"></div>
            <div style="position:absolute;left:0;right:0;top:10px;text-align:center;font-size:11px;font-weight:700">PRUEBA DE ETIQUETA</div>
            <div id="bc-cal-preview-meta" style="position:absolute;left:4px;right:4px;bottom:6px;text-align:center;font-size:9px"></div>
          </div>
        </div>
        <div id="bc-cal-page-info" style="font-size:11px;color:var(--muted2);text-align:center;margin-top:8px"></div>
        <div class="alrt b" style="margin-top:10px">
          <div class="alrt-dot b"></div>
          <div>
            <div class="alrt-title">La detección propone; la prueba confirma</div>
            <div class="alrt-sub">El controlador puede identificar el modelo, pero no siempre sabe qué rollo está colocado.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-foot" style="margin-top:14px">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="_bcCalSave()">${svg('check')} Guardar calibración</button>
    </div>
  `, 'modal-xl');
  _bcCalRender();
}

function _bcCalNumber(id, fallback, min, max) {
  const value = Number(document.getElementById(id)?.value);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function _bcCalRead() {
  const cal = window._bcCalWizard;
  if (!cal) return null;
  cal.widthMm = _bcCalNumber('bc-cal-width', cal.widthMm, 20, 150);
  cal.labelWidthMm = _bcCalNumber('bc-cal-label-width', cal.labelWidthMm, 10, 150);
  cal.labelHeightMm = _bcCalNumber('bc-cal-height', cal.labelHeightMm, 8, 300);
  cal.gapMm = _bcCalNumber('bc-cal-gap', cal.gapMm, 0, 30);
  cal.dpi = _bcCalNumber('bc-cal-dpi', cal.dpi, 100, 1200);
  cal.offsetXmm = _bcCalNumber('bc-cal-x', cal.offsetXmm, -30, 30);
  cal.offsetYmm = _bcCalNumber('bc-cal-y', cal.offsetYmm, -30, 30);
  cal.mediaMode = document.getElementById('bc-cal-mode')?.value || cal.mediaMode || 'gap';
  return cal;
}

function _bcCalRender() {
  const cal = _bcCalRead();
  if (!cal) return;
  const preview = document.getElementById('bc-cal-preview');
  const meta = document.getElementById('bc-cal-preview-meta');
  const info = document.getElementById('bc-cal-page-info');
  const layout = typeof calculateLabelLayout === 'function'
    ? calculateLabelLayout({
      labelW: cal.labelWidthMm,
      labelH: cal.labelHeightMm,
      gapMm: cal.gapMm,
      pageMm: cal.pageMm,
      cols: cal.cols,
    }, { widthMm: cal.widthMm, printableWidthMm: cal.widthMm })
    : { cols: 1, requestedCols: 1, fitsMedia: true };
  const scale = Math.min(3, 330 / Math.max(20, cal.widthMm));
  if (preview) {
    preview.style.width = `${Math.max(40, cal.labelWidthMm * scale)}px`;
    preview.style.height = `${Math.max(65, cal.labelHeightMm * scale)}px`;
    preview.style.transform = `translate(${cal.offsetXmm * scale}px, ${cal.offsetYmm * scale}px)`;
  }
  if (meta) meta.textContent = `${cal.labelWidthMm}×${cal.labelHeightMm}mm · X ${cal.offsetXmm} / Y ${cal.offsetYmm}`;
  if (info) {
    const pageHeight = cal.mediaMode === 'continuous' ? 'automático' : `${cal.labelHeightMm + cal.gapMm} mm`;
    info.textContent = `Medio: ${cal.widthMm} mm × ${pageHeight} · ${layout.cols}/${layout.requestedCols} columna(s) · ${cal.dpi} DPI`;
    info.style.color = layout.fitsMedia ? 'var(--muted2)' : 'var(--red)';
  }
}

function _bcCalAdjust(axis, delta) {
  const id = axis === 'x' ? 'bc-cal-x' : 'bc-cal-y';
  const input = document.getElementById(id);
  if (!input) return;
  input.value = String(Math.min(30, Math.max(-30, (Number(input.value) || 0) + delta)));
  _bcCalRender();
}

function _bcCalResetPosition() {
  const x = document.getElementById('bc-cal-x');
  const y = document.getElementById('bc-cal-y');
  if (x) x.value = '0';
  if (y) y.value = '0';
  _bcCalRender();
}

function _bcCalUseDetected() {
  const cal = window._bcCalWizard;
  if (!cal?.detected) return;
  const width = document.getElementById('bc-cal-width');
  const dpi = document.getElementById('bc-cal-dpi');
  if (width) width.value = String(cal.detected.widthMm);
  if (dpi) dpi.value = String(cal.detected.dpi);
  cal.profileId = cal.detected.id || cal.profileId;
  _bcCalRender();
}

async function _bcCalPrintTest() {
  const cal = _bcCalRead();
  const resultBox = document.getElementById('bc-cal-result');
  if (!cal || typeof printLabelBatch !== 'function' || typeof buildLabelCalibrationHTML !== 'function') {
    toast('No se pudo preparar la prueba de calibración', 'err');
    return;
  }
  if (!cal.printerName) {
    toast('Selecciona una impresora de etiquetas antes de imprimir la prueba', 'w');
    return;
  }
  if (cal.printerName && !_bcState.printers.some(p => p.name === cal.printerName)) {
    toast('La impresora seleccionada ya no está disponible', 'err');
    return;
  }
  const layout = typeof calculateLabelLayout === 'function'
    ? calculateLabelLayout({
      labelW: cal.labelWidthMm,
      labelH: cal.labelHeightMm,
      gapMm: cal.gapMm,
      pageMm: cal.pageMm,
      cols: cal.cols,
    }, { widthMm: cal.widthMm, printableWidthMm: cal.widthMm })
    : { fitsMedia: true };
  if (layout.fitsMedia === false) {
    toast('La etiqueta no cabe en el medio configurado. Corrige las medidas antes de imprimir la prueba.', 'err');
    return;
  }
  const html = buildLabelCalibrationHTML({
    widthMm: cal.widthMm,
    labelWidthMm: cal.labelWidthMm,
    labelHeightMm: cal.labelHeightMm,
    gapMm: cal.gapMm,
    pageMm: cal.pageMm,
    cols: cal.cols,
    offsetXmm: cal.offsetXmm,
    offsetYmm: cal.offsetYmm,
    printerLabel: cal.detected?.displayName || cal.printerName,
  });
  if (resultBox) {
    resultBox.style.color = 'var(--blue)';
    resultBox.textContent = 'Enviando prueba…';
  }
  try {
    const result = await printLabelBatch({
      html,
      printerName: cal.printerName,
      widthMm: cal.widthMm,
      heightMm: cal.mediaMode === 'continuous' ? null : cal.labelHeightMm + cal.gapMm,
      userId: user?.id,
      referenceId: Math.floor(Date.now() / 1000),
    });
    if (result?.ok === false) throw new Error(result.error || 'La impresora rechazó la prueba');
    if (resultBox) {
      resultBox.style.color = 'var(--green)';
      resultBox.innerHTML = '✓ Prueba enviada. Si el marco no está centrado, usa las flechas y vuelve a imprimir.';
    }
    toast('✓ Prueba de calibración enviada', 'ok');
  } catch (e) {
    if (resultBox) {
      resultBox.style.color = 'var(--red)';
      resultBox.textContent = `No se imprimió: ${e.message}`;
    }
    toast('No se pudo imprimir la prueba: ' + e.message, 'err');
  }
}

async function _bcCalSave() {
  const cal = _bcCalRead();
  if (!cal) return;
  if (!cal.printerName) {
    toast('Selecciona una impresora de etiquetas antes de guardar', 'w');
    return;
  }
  const key = _bcCalibrationKey(cal.printerName);
  const saved = {
    profileId: cal.profileId || 'label_generic',
    widthMm: cal.widthMm,
    labelHeightMm: cal.labelHeightMm,
    gapMm: cal.gapMm,
    dpi: cal.dpi,
    mediaMode: cal.mediaMode,
    offsetXmm: cal.offsetXmm,
    offsetYmm: cal.offsetYmm,
    updatedAt: new Date().toISOString(),
  };
  _bcState.calibrations[key] = saved;
  _bcState.profileId = saved.profileId;
  _bcState.mediaWidthMm = saved.widthMm;
  _bcState.printerDpi = saved.dpi;
  _bcState.mediaMode = saved.mediaMode;

  try {
    const payload = JSON.stringify(_bcState.calibrations);
    const results = await Promise.all([
      window.api.settings.set({ key: 'barcode_calibrations', value: payload, requestUserId: user?.id }),
      window.api.settings.set({ key: 'barcode_printer_profile', value: saved.profileId, requestUserId: user?.id }),
      window.api.settings.set({ key: 'barcode_media_width_mm', value: String(saved.widthMm), requestUserId: user?.id }),
      window.api.settings.set({ key: 'barcode_printer_dpi', value: String(saved.dpi), requestUserId: user?.id }),
      window.api.settings.set({ key: 'barcode_media_mode', value: saved.mediaMode, requestUserId: user?.id }),
    ]);
    const failed = results.find(r => r?.ok === false);
    if (failed) throw new Error(failed.error || 'No se pudo guardar la calibración');
    _bcSyncMediaControls();
    _bcUpdatePrinterBadge();
    _bcRenderDetectionSummary();
    window.api.audit?.log?.({
      action: 'barcode_printer_calibrated',
      entity: 'settings',
      entityId: null,
      detail: `${cal.printerName} · ${saved.widthMm}×${saved.labelHeightMm}mm · X${saved.offsetXmm}/Y${saved.offsetYmm}`,
      userId: user?.id,
    }).catch(() => {});
    closeModal();
    toast('✓ Calibración guardada para esta impresora', 'ok');
  } catch (e) {
    toast('No se pudo guardar la calibración: ' + e.message, 'err');
  }
}

// ══════════════════════════════════════════════
// GENERACIÓN DE HTML DE ETIQUETAS
// ══════════════════════════════════════════════
function _bcBuildLabelMarkup(product, design, profile) {
  const d = design || _bcEffectiveDesign();
  const fallbackModel = {
    product: {
      ...product,
      name: String(product?.name || '').trim(),
      brand: String(product?.brand || '').trim(),
      code: String(product?.code || '').trim(),
    },
    barcodeValue: product?.barcode || product?.code || String(product?.id || '').padStart(8, '0'),
    barcodeVisible: d.showBarcode !== false,
    standaloneCodeVisible: d.showCode === true,
  };
  const model = typeof buildLabelRenderModel === 'function'
    ? buildLabelRenderModel(product, d, profile || _bcPrinterProfile())
    : fallbackModel;
  const p = model.product;

  return `
    <div class="vp-label" data-label-width-mm="${Number(d.labelW) || 50}" style="
      width:${Number(d.labelW) || 50}mm;height:${Number(d.labelH) || 25}mm;
      padding:${Number(d.paddingMm) || 0}mm;
      background:${d.bgColor || '#ffffff'};
      border:${d.showBorder ? '0.25mm solid #bbb' : 'none'};
      border-radius:${Number(d.borderRadius) || 0}px;
      display:flex;flex-direction:column;
      align-items:${d.align || 'center'};
      justify-content:${d.vAlign || 'center'};
      box-sizing:border-box;
      transform:translate(${Number(d.offsetXmm) || 0}mm, ${Number(d.offsetYmm) || 0}mm);
      overflow:hidden;
      font-family:${d.fontFamily || 'Arial,sans-serif'};
      color:${d.textColor || '#000000'};
      gap:${Number(d.elemGap) || 0}mm;
      page-break-inside:avoid;
    ">
      ${d.showName && p.name ? `
        <div class="vp-label-name" style="font-size:${d.nameFontSize || 7}pt;font-weight:${d.nameBold ? '700' : '400'};
             text-align:center;line-height:1.1;width:100%;
             overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
          ${_bcEsc(p.name)}
        </div>` : ''}
      ${d.showBrand && p.brand ? `
        <div class="vp-label-brand" style="font-size:${d.brandFontSize || 6}pt;color:${d.brandColor || '#666'};
             text-align:center;line-height:1;width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
          ${_bcEsc(p.brand)}
        </div>` : ''}
      ${model.barcodeVisible ? `
        <div class="vp-label-barcode" style="width:100%;padding:0 1mm;box-sizing:border-box;overflow:hidden">
          ${_bcRenderSvg(model.barcodeValue, d)}
        </div>` : ''}
      ${model.standaloneCodeVisible ? `
        <div class="vp-label-code" style="font-size:${d.codeFontSize || 6}pt;font-family:monospace;
             color:${d.codeColor || '#555'};text-align:center;width:100%;
             overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
          ${_bcEsc(p.code)}
        </div>` : ''}
      ${d.showPrice ? `
        <div class="vp-label-price" style="font-size:${d.priceFontSize || 9}pt;font-weight:700;
             color:${d.priceColor || '#000'};text-align:center;line-height:1">
          ${fmt(p.price)}
        </div>` : ''}
      ${d.customText ? `
        <div class="vp-label-custom" style="font-size:${d.customFontSize || 6}pt;text-align:center;
             color:${d.customColor || '#444'};width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
          ${_bcEsc(d.customText)}
        </div>` : ''}
    </div>`;
}

function _bcBuildLabelsHTML(items, options = {}) {
  // items = [{ product, qty }]
  const d = options.design || _bcEffectiveDesign();
  if (!d) return '';

  const profile = options.profile || _bcPrinterProfile();
  const layout = typeof calculateLabelLayout === 'function'
    ? calculateLabelLayout(d, profile)
    : { labelW: d.labelW || 50, labelH: d.labelH || 25, gapMm: d.gapMm || 2,
        pageMm: d.pageMm || 0, mediaWidthMm: profile.widthMm || 100, cols: d.cols || 1,
        rowHeightMm: (d.labelH || 25) + (d.gapMm || 2), adjusted: false };
  const cols = layout.cols;
  const lw = layout.labelW;
  const lh = layout.labelH;
  const gap = layout.gapMm;

  const allLabels = [];
  items.forEach(({ product: p, qty }) => {
    for (let i = 0; i < qty; i++) {
      allLabels.push(p);
    }
  });

  const rows = [];
  for (let i = 0; i < allLabels.length; i += cols) rows.push(allLabels.slice(i, i + cols));
  const fixedRows = (options.mediaMode || _bcState.mediaMode) !== 'continuous';
  const preview = options.preview === true;
  // Altura de página = alto de etiqueta + separación (SIN sumarle el margen):
  // el margen se aplica solo como inset horizontal (padding L/R) para no crecer
  // la página verticalmente y evitar deriva entre etiquetas.
  const rowH = layout.rowHeightMm || (lh + gap);
  const styles = `
    <style>
      @page { size:${layout.mediaWidthMm}mm ${fixedRows ? rowH + 'mm' : 'auto'}; margin:0; }
      html,body { width:${layout.mediaWidthMm}mm;margin:0;padding:0;background:#fff; }
      .vp-label-row {
        width:${layout.mediaWidthMm}mm;
        min-height:${fixedRows ? rowH : lh}mm;
        padding:0 ${layout.pageMm}mm;
        display:grid;
        grid-template-columns: repeat(${cols}, ${lw}mm);
        column-gap:${gap}mm;
        justify-content:center;
        align-content:start;
        box-sizing:border-box;
        overflow:hidden;
        ${fixedRows ? 'break-after:page;page-break-after:always;' : ''}
      }
      .vp-label-row:last-child { break-after:auto;page-break-after:auto; }
      @media screen {
        html { width:100%;min-height:100%;background:#eef1f4;padding:14px 0;box-sizing:border-box; }
        body { margin:0 auto;background:transparent; }
        .vp-label-row { background:#fff;outline:1px dashed #aeb6c2;box-shadow:0 3px 12px rgba(15,23,42,.08);margin:0 auto 12px; }
        .vp-label { outline:1px dotted #c6ccd5;outline-offset:-1px; }
      }
      @media print {
        .no-print { display:none!important; }
      }
    </style>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    ${styles}
    </head><body>
    ${rows.map(row => `<div class="vp-label-row">${row.map(p => _bcBuildLabelMarkup(p, d, profile)).join('\n')}</div>`).join('\n')}
    ${preview ? `<div class="no-print" style="font:11px Arial,sans-serif;color:#5f6b7a;text-align:center;padding:2px 8px 12px">
      Línea punteada exterior: medio de ${layout.mediaWidthMm} mm · línea interior: etiqueta de ${lw}×${lh} mm
    </div>` : ''}
    </body></html>`;
}

function _bcEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ══════════════════════════════════════════════
// VISTA PREVIA
// ══════════════════════════════════════════════
function _bcOpenPreview() {
  const ids = Object.keys(_bcState.selected);
  if (!ids.length) {
    // Si nada seleccionado, preview con el primer producto
    const sample = DB.products[0];
    if (!sample) { toast('No hay productos en inventario', 'w'); return; }
    const html = _bcBuildLabelsHTML([{ product: sample, qty: 1 }], { preview: true });
    _bcShowPreviewModal(html, 'Vista previa — producto de muestra');
    return;
  }
  const items = ids.map(id => ({
    product: DB.products.find(p => p.id == id),
    qty: _bcState.selected[id] || 1
  })).filter(i => i.product);

  const html = _bcBuildLabelsHTML(items, { preview: true });
  _bcShowPreviewModal(html, 'Vista previa');
}

function _bcShowPreviewModal(html, title) {
  const d = _bcEffectiveDesign();
  const layout = typeof calculateLabelLayout === 'function'
    ? calculateLabelLayout(d, _bcPrinterProfile())
    : { labelW: d.labelW, labelH: d.labelH, mediaWidthMm: _bcState.mediaWidthMm, cols: d.cols, requestedCols: d.cols };
  const typeName = ({ interno: 'Interno · con precio', proveedor: 'Proveedor · sin precio',
    personalizado: 'Personalizado' })[_bcState.labelType] || 'Interno · con precio';
  const fitMessage = !layout.fitsMedia
    ? `La etiqueta excede el ancho útil por ${layout.overflowMm.toFixed(1)} mm`
    : layout.adjusted
      ? `${layout.requestedCols} columnas solicitadas; Velo imprimirá ${layout.cols} para evitar recortes`
      : `${layout.cols} columna(s) por fila`;
  openModal(`
    <div class="modal-title">${_bcEsc(title)}</div>
    <div class="modal-sub">Representación física del medio, las etiquetas y sus cortes.</div>
    <div class="bc-preview-meta">
      <div><span>Etiqueta</span><strong>${layout.labelW}×${layout.labelH} mm</strong></div>
      <div><span>Medio</span><strong>${layout.mediaWidthMm} mm</strong></div>
      <div><span>Contenido</span><strong>${typeName}</strong></div>
      <div class="${layout.adjusted ? 'warn' : ''}"><span>Distribución</span><strong>${fitMessage}</strong></div>
    </div>
    <iframe id="bc-preview-iframe"
            class="bc-preview-frame" title="Vista previa física de etiquetas">
    </iframe>
    <div class="modal-foot" style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-green" onclick="closeModal();_bcPrint()">
        ${svg('print')} Imprimir ahora
      </button>
    </div>
  `, 'modal-xl');
  const iframe = document.getElementById('bc-preview-iframe');
  if (iframe) {
    iframe.addEventListener('load', () => {
      try {
        const body = iframe.contentDocument?.body;
        const doc = iframe.contentDocument?.documentElement;
        const contentHeight = Math.max(body?.scrollHeight || 0, doc?.scrollHeight || 0);
        iframe.style.height = `${Math.max(170, Math.min(360, contentHeight + 4))}px`;
      } catch {}
    }, { once: true });
    iframe.srcdoc = html;
  }
}

// ══════════════════════════════════════════════
// IMPRESIÓN
// ══════════════════════════════════════════════
async function _bcPrint() {
  if (!_bcState.selPrinter) {
    toast('Selecciona la impresora de etiquetas. Velo no usará la impresora de facturas.', 'w');
    document.getElementById('bc-printer-sel')?.focus();
    return;
  }
  const ids = Object.keys(_bcState.selected);
  if (!ids.length) {
    toast('Selecciona al menos un producto', 'w');
    return;
  }
  const items = ids.map(id => ({
    product: DB.products.find(p => p.id == id),
    qty: _bcState.selected[id] || 1
  })).filter(i => i.product);
  if (!items.length) {
    toast('Los productos seleccionados ya no están disponibles', 'err');
    return;
  }
  if (!window.JsBarcode && !(await _loadJsBarcode())) {
    toast('No se pudo generar el código de barras. No se enviaron etiquetas en blanco.', 'err');
    return;
  }

  const total = items.reduce((s, i) => s + i.qty, 0);
  const html  = _bcBuildLabelsHTML(items);
  const renderedCodes = (html.match(/<svg\b/g) || []).length;
  if (!html || !html.includes('class="vp-label"') || renderedCodes < total) {
    toast(`No se generaron todos los códigos (${renderedCodes}/${total}). Revisa el formato y los códigos de producto.`, 'err');
    return;
  }
  const d     = _bcEffectiveDesign();
  const profile = _bcPrinterProfile();
  const layout = typeof calculateLabelLayout === 'function'
    ? calculateLabelLayout(d, profile)
    : { mediaWidthMm: profile.widthMm || d.labelW || 50, rowHeightMm: (d.labelH || 25) + (d.gapMm || 2) };
  if (layout.fitsMedia === false) {
    toast(`La etiqueta de ${layout.labelW} mm no cabe en los ${layout.availableWidthMm.toFixed(1)} mm útiles del medio. Corrige el diseño o el margen.`, 'err');
    return;
  }

  try {
    const selectedInstalled = _bcState.printers.some(
      printer => printer.name === _bcState.selPrinter
    );
    if (!selectedInstalled) {
      toast('La impresora de etiquetas guardada ya no está instalada. Selecciona otra.', 'err');
      return;
    }
    const result = await printLabelBatch({
      html,
      printerName:  _bcState.selPrinter,
      widthMm: layout.mediaWidthMm,
      heightMm: _bcState.mediaMode === 'continuous' ? null : layout.rowHeightMm,
      userId: user?.id,
      referenceId: Math.floor(Date.now() / 1000),
    });
    if (result?.ok !== false) {
      toast(`✓ ${total} etiqueta(s) enviadas a imprimir`, 'ok');
      // Log de auditoría
      window.api.audit?.log?.({ action: 'barcode_print', entity: 'products',
        entityId: null, detail: `${total} etiquetas (${items.length} productos)`,
        userId: user?.id }).catch(() => {});
    } else {
      toast('Error al imprimir: ' + (result?.error || 'desconocido'), 'err');
    }
  } catch (e) {
    toast('Error de impresión: ' + e.message, 'err');
  }
}

// ══════════════════════════════════════════════
// DISEÑO POR DEFECTO
// ══════════════════════════════════════════════
function _bcDefaultDesign() {
  return {
    // Tamaño de etiqueta
    labelW:       50,      // mm ancho
    labelH:       25,      // mm alto
    paddingMm:    2,
    gapMm:        2,
    cols:         1,
    pageMm:       5,
    elemGap:      1,
    offsetXmm:    0,   // Ajuste fino horizontal (calibración de posición)
    offsetYmm:    0,   // Ajuste fino vertical (calibración de posición)

    // Código de barras
    format:       'CODE128',
    barWidth:     1.5,
    barHeight:    22,
    barFontSize:  7,
    barColor:     '#000000',
    showBarcode:  true,
    showBarcodeText: true,

    // Tipografía
    fontFamily:   'Arial, sans-serif',
    fontSize:     8,
    textColor:    '#000000',

    // Elementos opcionales
    showName:     true,
    showBrand:    false,
    showCode:     false,
    showPrice:    true,
    showBorder:   false,
    borderRadius: 2,
    bgColor:      '#ffffff',

    // Tamaños individuales
    nameFontSize:   7,
    nameBold:       true,
    brandFontSize:  6,
    brandColor:     '#666666',
    codeFontSize:   6,
    codeColor:      '#555555',
    priceFontSize:  9,
    priceColor:     '#000000',

    // Alineación
    align:        'center',
    vAlign:       'center',

    // Texto personalizado
    customText:   '',
    customFontSize: 6,
    customColor:  '#444444',
  };
}
