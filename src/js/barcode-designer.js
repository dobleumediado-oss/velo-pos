// ══════════════════════════════════════════════
// barcode-designer.js — Diseñador de etiquetas
// Solo accesible desde el Panel Superadmin.
// Llama renderBarcodeDesigner(container)
// ══════════════════════════════════════════════

async function renderBarcodeDesigner(container, options = {}) {
  await _loadJsBarcode();

  const settings = await window.api.settings.getAll();
  const rawDesign = settings?.barcode_design;
  let design = options.initialDesign ||
    (rawDesign ? JSON.parse(rawDesign) : _bcDefaultDesign());
  const activeLabelType = settings?.barcode_label_type || 'interno';

  // Impresora seleccionada en el módulo Etiquetas → el preview "detecta" el
  // medio real (ancho/DPI) para presentarse fiel a lo que va a salir.
  const detPrinter = settings?.barcode_printer || '';
  const installedPrinters = typeof printerMonitorRefresh === 'function'
    ? await printerMonitorRefresh({ reason: 'label-designer-open' })
    : await window.api.print.getPrinters().catch(() => []);
  const installedPrinter = (Array.isArray(installedPrinters) ? installedPrinters : [])
    .find(printer => printer.name === detPrinter);
  const detected = detPrinter && typeof detectLabelPrinter === 'function'
    ? detectLabelPrinter(installedPrinter || detPrinter, settings)
    : null;
  const detProfile = detected || ((typeof resolvePrinterProfile === 'function')
    ? resolvePrinterProfile(detPrinter, 'barcode', settings)
    : { widthMm: Number(settings?.barcode_media_width_mm) || 50,
        dpi: Number(settings?.barcode_printer_dpi) || 203, label: 'Etiquetas' });
  window._bcdPrinter = {
    name: detPrinter,
    widthMm: Math.round((Number(detProfile.widthMm) || 50) * 10) / 10,
    printableWidthMm: Math.round((Number(detProfile.printableWidthMm || detProfile.widthMm) || 50) * 10) / 10,
    dpi: Number(detProfile.dpi) || 203,
    label: detProfile.label || 'Etiquetas',
    confidence: detected?.confidence || 'configured',
    reason: detected?.reason || 'Perfil y medidas configurados manualmente',
    installed: !!installedPrinter,
  };

  // ── Producto de muestra para preview ─────────
  const sampleProduct = DB.products[0] || {
    id: 1, name: 'Producto de Muestra', brand: 'Marca Ejemplo',
    code: 'PROD-001', barcode: '7501000000000', price: 350.00
  };

  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:0';
  window._bcdContainer = container;
  window._bcdOptions = options;

  // Header
  const hdr = document.createElement('div');
  hdr.innerHTML = options.embedded === true ? `
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:12px 0">
      <button class="btn btn-out btn-sm" onclick="_bcdReset()">Restablecer</button>
      <button class="btn btn-green btn-sm" onclick="_bcdSave()">
        ${svg('check')} Guardar diseño
      </button>
    </div>` : `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div>
        <div style="font-weight:700;font-size:15px;color:var(--ink)">Diseñador de Etiquetas</div>
        <div style="font-size:12px;color:var(--muted2);margin-top:2px">
          Configura el diseño que verá el administrador al imprimir
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-out btn-sm" onclick="_bcdReset()">Restablecer</button>
        <button class="btn btn-green btn-sm" onclick="_bcdSave()">
          ${svg('check')} Guardar diseño
        </button>
      </div>
    </div>`;
  wrap.appendChild(hdr);

  // Layout: controles izquierda, preview derecha
  const layout = document.createElement('div');
  layout.style.cssText = 'display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start';

  // ── Panel de controles ────────────────────────
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-direction:column;gap:12px';

  controls.innerHTML = `
    <!-- Tamaño de etiqueta -->
    <div class="card" style="padding:16px">
      <div class="card-title mb8">📐 Tamaño de Etiqueta</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div class="fg" style="margin:0">
          <label class="lbl">Ancho (mm)</label>
          <input class="inp" id="bcd-lw" type="number" min="20" max="150"
                 value="${design.labelW}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Alto (mm)</label>
          <input class="inp" id="bcd-lh" type="number" min="10" max="100"
                 value="${design.labelH}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Columnas deseadas</label>
          <input class="inp" id="bcd-cols" type="number" min="1" max="8"
                 value="${design.cols}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Padding interno (mm)</label>
          <input class="inp" id="bcd-pad" type="number" min="0" max="10" step="0.5"
                 value="${design.paddingMm}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Separación (mm)</label>
          <input class="inp" id="bcd-gap" type="number" min="0" max="20" step="0.5"
                 value="${design.gapMm}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Margen lateral del medio (mm)</label>
          <input class="inp" id="bcd-pagemm" type="number" min="0" max="20"
                 value="${design.pageMm}" oninput="_bcdUpdate()"/>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line2)">
        <div style="font-size:12px;font-weight:700;margin-bottom:6px">🎯 Calibración de posición</div>
        <div style="font-size:11px;color:var(--muted2);margin-bottom:8px">Empuja el contenido para centrarlo en TU etiqueta. Positivo = derecha / abajo; negativo = izquierda / arriba.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end">
          <div class="fg" style="margin:0">
            <label class="lbl">Ajuste horizontal (mm)</label>
            <input class="inp" id="bcd-offx" type="number" min="-30" max="30" step="0.5"
                   value="${Number(design.offsetXmm) || 0}" oninput="_bcdUpdate()"/>
          </div>
          <div class="fg" style="margin:0">
            <label class="lbl">Ajuste vertical (mm)</label>
            <input class="inp" id="bcd-offy" type="number" min="-30" max="30" step="0.5"
                   value="${Number(design.offsetYmm) || 0}" oninput="_bcdUpdate()"/>
          </div>
          <button class="btn btn-out btn-sm" onclick="_bcdPrintCalibration()" title="Imprime un marco del tamaño de la etiqueta con cruz al centro para verificar la posición">${svg('print')} Prueba</button>
        </div>
      </div>
    </div>

    <!-- Código de barras -->
    <div class="card" style="padding:16px">
      <div class="card-title mb8">▌ Código de Barras</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg" style="margin:0">
          <label class="lbl">Formato</label>
          <select class="inp" id="bcd-format" onchange="_bcdUpdate()">
            ${['CODE128','CODE39','EAN13','EAN8','UPC','ITF14','MSI','pharmacode']
              .map(f => `<option value="${f}" ${design.format===f?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Color barras</label>
          <input class="inp" type="color" id="bcd-barcolor" value="${design.barColor||'#000000'}"
                 oninput="_bcdUpdate()" style="height:38px;padding:4px;cursor:pointer"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Ancho de línea</label>
          <input class="inp" type="range" id="bcd-barw" min="1" max="4" step="0.5"
                 value="${design.barWidth}" oninput="_bcdUpdate()" style="height:38px"/>
          <div style="font-size:10px;color:var(--muted2);text-align:center" id="bcd-barw-val">${design.barWidth}px</div>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Alto barras (px)</label>
          <input class="inp" type="number" id="bcd-barh" min="10" max="60"
                 value="${design.barHeight}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0;grid-column:1/-1">
          <label class="lbl">Tamaño texto bajo barras (pt)</label>
          <input class="inp" type="number" id="bcd-barfs" min="0" max="12"
                 value="${design.barFontSize}" oninput="_bcdUpdate()"/>
        </div>
        <div style="grid-column:1/-1;display:flex;gap:12px;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="bcd-show-barcode" ${design.showBarcode!==false?'checked':''}
                   onchange="_bcdUpdate()"/>
            Mostrar código de barras
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="bcd-show-bartext" ${design.showBarcodeText!==false?'checked':''}
                   onchange="_bcdUpdate()"/>
            Texto bajo el código
          </label>
        </div>
      </div>
    </div>

    <!-- Elementos de la etiqueta -->
    <div class="card" style="padding:16px">
      <div class="card-title mb8">🏷 Elementos de la Etiqueta</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">

        <div style="border:1px solid var(--line);border-radius:8px;padding:10px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;font-size:12px;margin-bottom:8px">
            <input type="checkbox" id="bcd-show-name" ${design.showName?'checked':''}
                   onchange="_bcdUpdate()"/>
            Nombre del producto
          </label>
          <div class="fg" style="margin:0;margin-bottom:6px">
            <label class="lbl">Tamaño (pt)</label>
            <input class="inp" type="number" id="bcd-namefs" min="4" max="16"
                   value="${design.nameFontSize}" oninput="_bcdUpdate()"/>
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
            <input type="checkbox" id="bcd-name-bold" ${design.nameBold?'checked':''}
                   onchange="_bcdUpdate()"/>
            Negrita
          </label>
        </div>

        <div style="border:1px solid var(--line);border-radius:8px;padding:10px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;font-size:12px;margin-bottom:8px">
            <input type="checkbox" id="bcd-show-price" ${design.showPrice?'checked':''}
                   onchange="_bcdUpdate()"/>
            Precio
          </label>
          <div class="fg" style="margin:0;margin-bottom:6px">
            <label class="lbl">Tamaño (pt)</label>
            <input class="inp" type="number" id="bcd-pricefs" min="4" max="18"
                   value="${design.priceFontSize}" oninput="_bcdUpdate()"/>
          </div>
          <div class="fg" style="margin:0">
            <label class="lbl">Color</label>
            <input class="inp" type="color" id="bcd-pricecolor" value="${design.priceColor||'#000000'}"
                   oninput="_bcdUpdate()" style="height:32px;padding:3px;cursor:pointer"/>
          </div>
        </div>

        <div style="border:1px solid var(--line);border-radius:8px;padding:10px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;font-size:12px;margin-bottom:8px">
            <input type="checkbox" id="bcd-show-brand" ${design.showBrand?'checked':''}
                   onchange="_bcdUpdate()"/>
            Marca
          </label>
          <div class="fg" style="margin:0">
            <label class="lbl">Tamaño (pt)</label>
            <input class="inp" type="number" id="bcd-brandfs" min="4" max="12"
                   value="${design.brandFontSize}" oninput="_bcdUpdate()"/>
          </div>
        </div>

        <div style="border:1px solid var(--line);border-radius:8px;padding:10px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;font-size:12px;margin-bottom:8px">
            <input type="checkbox" id="bcd-show-code" ${design.showCode?'checked':''}
                   onchange="_bcdUpdate()"/>
            Código interno
          </label>
          <div class="fg" style="margin:0">
            <label class="lbl">Tamaño (pt)</label>
            <input class="inp" type="number" id="bcd-codefs" min="4" max="12"
                   value="${design.codeFontSize}" oninput="_bcdUpdate()"/>
          </div>
        </div>
      </div>
    </div>

    <!-- Estilo general -->
    <div class="card" style="padding:16px">
      <div class="card-title mb8">🎨 Estilo General</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="fg" style="margin:0">
          <label class="lbl">Fondo etiqueta</label>
          <input class="inp" type="color" id="bcd-bg" value="${design.bgColor||'#ffffff'}"
                 oninput="_bcdUpdate()" style="height:38px;padding:4px;cursor:pointer"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Color texto</label>
          <input class="inp" type="color" id="bcd-textcolor" value="${design.textColor||'#000000'}"
                 oninput="_bcdUpdate()" style="height:38px;padding:4px;cursor:pointer"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Borde redondeado (px)</label>
          <input class="inp" type="number" id="bcd-radius" min="0" max="20"
                 value="${design.borderRadius}" oninput="_bcdUpdate()"/>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Fuente</label>
          <select class="inp" id="bcd-font" onchange="_bcdUpdate()">
            ${['Arial, sans-serif','Georgia, serif','Courier New, monospace',
               'Trebuchet MS, sans-serif','Verdana, sans-serif','Tahoma, sans-serif']
              .map(f => `<option value="${f}" ${design.fontFamily===f?'selected':''}>${f.split(',')[0]}</option>`).join('')}
          </select>
        </div>
        <div class="fg" style="margin:0">
          <label class="lbl">Alineación H</label>
          <select class="inp" id="bcd-align" onchange="_bcdUpdate()">
            ${['center','flex-start','flex-end'].map(a => `
              <option value="${a}" ${design.align===a?'selected':''}>${
                a==='center'?'Centro':a==='flex-start'?'Izquierda':'Derecha'}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:13px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="bcd-show-border" ${design.showBorder?'checked':''}
                   onchange="_bcdUpdate()"/>
            Mostrar borde
          </label>
        </div>
      </div>

      <!-- Texto personalizado -->
      <div class="fg" style="margin-top:10px;margin-bottom:0">
        <label class="lbl">Texto personalizado (ej: "Precio incluye ITBIS")</label>
        <input class="inp" id="bcd-custom-text" type="text"
               value="${design.customText||''}"
               placeholder="Dejar vacío para no mostrar"
               oninput="_bcdUpdate()"/>
      </div>
    </div>

    <!-- Presets rápidos -->
    <div class="card" style="padding:16px">
      <div class="card-title mb8">⚡ Presets Rápidos</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${[
          {label:'Etiqueta pequeña 40×20', w:40,h:20,cols:5},
          {label:'Estándar 50×25', w:50,h:25,cols:4},
          {label:'Mediana 60×30', w:60,h:30,cols:3},
          {label:'Grande 100×50', w:100,h:50,cols:2},
          {label:'Carta ancha 89×36 (Brother)', w:89,h:36,cols:2},
          {label:'DYMO 57×32', w:57,h:32,cols:2},
        ].map(p => `
          <button class="btn btn-out btn-sm" onclick="_bcdApplyPreset(${p.w},${p.h},${p.cols},'${p.label}')">
            ${p.label}
          </button>`).join('')}
      </div>
    </div>
  `;

  layout.appendChild(controls);

  // ── Preview en vivo ───────────────────────────
  const previewCol = document.createElement('div');
  previewCol.style.cssText = 'position:sticky;top:16px';
  previewCol.innerHTML = `
    <div class="card" style="padding:16px">
      <div class="card-title mb8">👁 Preview en Vivo</div>
      <div style="font-size:11px;color:var(--muted2);margin-bottom:8px">
        Usando: <strong>${sampleProduct.name}</strong>
      </div>
      <div style="font-size:10.5px;color:var(--muted2);margin-bottom:8px">
        Vista del diseño personalizado. En Producción está activo:
        <strong>${activeLabelType === 'proveedor' ? 'Proveedor · sin precio'
          : activeLabelType === 'personalizado' ? 'Personalizado'
          : 'Interno · con precio'}</strong>.
      </div>
      <div id="bcd-detect" style="font-size:10.5px;color:var(--muted2);background:var(--surface2);border-radius:7px;padding:7px 9px;margin-bottom:8px;line-height:1.5">
        <div id="bcd-device-line"><strong>Impresora:</strong> ${detPrinter
          ? `${typeof _bcEsc === 'function' ? _bcEsc(detPrinter) : detPrinter}${window._bcdPrinter.installed ? '' : ' · no disponible en esta Mac'}`
          : 'Ninguna seleccionada · simulación local'}</div>
        <div><strong>${detPrinter ? 'Perfil del medio' : 'Medio configurado'}:</strong> ${window._bcdPrinter.widthMm} mm · ${window._bcdPrinter.dpi} dpi</div>
      </div>
      <div id="bcd-detect-warn" style="display:none;font-size:10.5px;margin-bottom:8px;background:#fff7ed;border:1px solid #fcd9a5;color:#92400e;border-radius:7px;padding:7px 9px"></div>
      <div id="bcd-preview-wrap" style="
        background:#eef1f4;
        border-radius:8px;
        padding:16px;
        display:flex;
        justify-content:center;
        align-items:center;
        min-height:150px;
        overflow:hidden;
      ">
        <div id="bcd-preview-media" style="background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15)">
          Cargando...
        </div>
      </div>
      <div id="bcd-preview-info" style="margin-top:8px;font-size:11px;color:var(--muted2);text-align:center"></div>
    </div>

    <!-- Estado real de impresora -->
    <div class="card" style="padding:16px;margin-top:12px">
      <div class="card-title mb8">🖨 Diagnóstico de esta salida</div>
      <div style="font-size:11.5px;line-height:1.65;color:var(--ink3)">
        <div><strong>Dispositivo:</strong> <span id="bcd-device-state">${detPrinter
          ? (window._bcdPrinter.installed
            ? (detected?.runtime?.reportedIssue ? 'Cola con incidencia' : 'Cola disponible')
            : 'Cola guardada, no disponible')
          : 'Pendiente de asignar'}</span></div>
        <div><strong>Perfil:</strong> ${typeof _bcEsc === 'function' ? _bcEsc(window._bcdPrinter.label) : window._bcdPrinter.label}</div>
        <div><strong>Detección:</strong> ${typeof _bcEsc === 'function' ? _bcEsc(window._bcdPrinter.reason) : window._bcdPrinter.reason}</div>
        <div><strong>Controlador:</strong> salida universal del sistema</div>
      </div>
      <div style="font-size:10.5px;color:var(--muted2);margin-top:9px;padding-top:9px;border-top:1px solid var(--line)">
        La prueba visual funciona sin impresora. La calibración física se guarda por dispositivo cuando conectes la etiquetadora del cliente.
      </div>
    </div>
  `;
  layout.appendChild(previewCol);

  wrap.appendChild(layout);
  container.appendChild(wrap);

  // Guardar referencia al producto de muestra y diseño actual en window para callbacks
  window._bcdDesign  = design;
  window._bcdSample  = sampleProduct;
  window._bcdDirty   = false;

  // Renderizar preview inicial
  _bcdUpdatePreview();
}

// ── Leer diseño desde los controles ──────────
function _bcdReadDesign() {
  const g = id => document.getElementById(id);
  const gv = id => g(id)?.value;
  const gc = id => g(id)?.checked;
  const gi = id => parseFloat(gv(id)) || 0;

  return {
    labelW:        gi('bcd-lw'),
    labelH:        gi('bcd-lh'),
    cols:          parseInt(gv('bcd-cols')) || 4,
    paddingMm:     gi('bcd-pad'),
    gapMm:         gi('bcd-gap'),
    pageMm:        gi('bcd-pagemm'),
    offsetXmm:     parseFloat(gv('bcd-offx')) || 0,
    offsetYmm:     parseFloat(gv('bcd-offy')) || 0,
    elemGap:       1,

    format:        gv('bcd-format') || 'CODE128',
    barColor:      gv('bcd-barcolor') || '#000000',
    barWidth:      gi('bcd-barw'),
    barHeight:     gi('bcd-barh'),
    barFontSize:   gi('bcd-barfs'),
    showBarcode:   gc('bcd-show-barcode'),
    showBarcodeText: gc('bcd-show-bartext'),

    showName:      gc('bcd-show-name'),
    nameFontSize:  gi('bcd-namefs'),
    nameBold:      gc('bcd-name-bold'),

    showPrice:     gc('bcd-show-price'),
    priceFontSize: gi('bcd-pricefs'),
    priceColor:    gv('bcd-pricecolor') || '#000000',

    showBrand:     gc('bcd-show-brand'),
    brandFontSize: gi('bcd-brandfs'),
    brandColor:    '#666666',

    showCode:      gc('bcd-show-code'),
    codeFontSize:  gi('bcd-codefs'),
    codeColor:     '#555555',

    bgColor:       gv('bcd-bg') || '#ffffff',
    textColor:     gv('bcd-textcolor') || '#000000',
    borderRadius:  gi('bcd-radius'),
    showBorder:    gc('bcd-show-border'),
    fontFamily:    gv('bcd-font') || 'Arial, sans-serif',
    align:         gv('bcd-align') || 'center',
    vAlign:        'center',

    customText:    gv('bcd-custom-text') || '',
    customFontSize: 6,
    customColor:   '#444444',

    fontSize:      8,
  };
}

// ── Actualizar preview ─────────────────────────
function _bcdUpdate() {
  // Actualizar label del slider barWidth
  const bw = document.getElementById('bcd-barw');
  const bwv = document.getElementById('bcd-barw-val');
  if (bw && bwv) bwv.textContent = parseFloat(bw.value) + 'px';

  window._bcdDesign = _bcdReadDesign();
  window._bcdDirty = true;
  _bcdUpdatePreview();
}

function _bcdUpdatePreview() {
  const wrap  = document.getElementById('bcd-preview-wrap');
  const info  = document.getElementById('bcd-preview-info');
  if (!wrap) return;

  const d = window._bcdDesign;
  const p = window._bcdSample;
  if (!d || !p) return;
  const det = window._bcdPrinter || {};
  const profile = {
    widthMm: Number(det.widthMm) || Number(d.labelW) || 50,
    printableWidthMm: Number(det.printableWidthMm || det.widthMm) || Number(d.labelW) || 50,
    dpi: Number(det.dpi) || 203,
  };
  const layout = typeof calculateLabelLayout === 'function'
    ? calculateLabelLayout(d, profile)
    : { labelW: d.labelW, labelH: d.labelH, mediaWidthMm: profile.widthMm,
        pageMm: d.pageMm || 0, gapMm: d.gapMm || 0, cols: d.cols || 1,
        requestedCols: d.cols || 1, rowHeightMm: d.labelH + (d.gapMm || 0), fitsMedia: true };
  const media = document.getElementById('bcd-preview-media');
  if (!media) return;

  const PX = 3.78;
  const naturalWidth = layout.mediaWidthMm * PX;
  const scale = Math.min(1, 286 / Math.max(1, naturalWidth));
  media.style.cssText = `
    width:${layout.mediaWidthMm}mm;
    min-height:${layout.rowHeightMm}mm;
    padding:0 ${layout.pageMm}mm;
    display:grid;
    grid-template-columns:repeat(${layout.cols}, ${layout.labelW}mm);
    column-gap:${layout.gapMm}mm;
    justify-content:center;
    align-content:start;
    box-sizing:border-box;
    overflow:hidden;
    background:#fff;
    outline:1px dashed #9ca6b4;
    box-shadow:0 2px 8px rgba(0,0,0,.15);
    zoom:${scale};
  `;
  media.innerHTML = Array.from({ length: layout.cols }, () =>
    typeof _bcBuildLabelMarkup === 'function'
      ? _bcBuildLabelMarkup(p, d, profile)
      : '<div style="padding:12px">Vista previa no disponible</div>'
  ).join('');
  media.querySelectorAll('.vp-label').forEach(label => {
    label.style.outline = '1px dotted #c6ccd5';
    label.style.outlineOffset = '-1px';
  });
  wrap.style.minHeight = `${Math.max(150, (layout.rowHeightMm * PX * scale) + 34)}px`;

  if (info) {
    const distribution = layout.requestedCols === layout.cols
      ? `${layout.cols} columna(s)`
      : `${layout.requestedCols} solicitadas → ${layout.cols} efectivas`;
    info.textContent = `Etiqueta ${layout.labelW}×${layout.labelH} mm · medio ${layout.mediaWidthMm} mm · ${distribution} · ${d.format}`;
  }

  const warn = document.getElementById('bcd-detect-warn');
  if (!warn) return;
  warn.style.background = '#fff7ed';
  warn.style.borderColor = '#fcd9a5';
  warn.style.color = '#92400e';
  if (!layout.fitsMedia) {
    warn.style.display = 'block';
    warn.innerHTML = `⚠ La etiqueta de <strong>${layout.labelW} mm</strong> no cabe en los <strong>${layout.availableWidthMm.toFixed(1)} mm útiles</strong>.
      Reduce el ancho, el margen lateral o configura el medio correcto.`;
  } else if (layout.adjusted) {
    warn.style.display = 'block';
    warn.innerHTML = `Velo protege la impresión: en este medio caben <strong>${layout.cols}</strong> de las <strong>${layout.requestedCols}</strong> columnas solicitadas.
      <button class="btn btn-out btn-sm" style="margin-top:5px" onclick="_bcdUseEffectiveColumns(${layout.cols})">Guardar ${layout.cols} columna(s)</button>`;
  } else if (!det.name) {
    warn.style.display = 'block';
    warn.style.background = 'var(--blue-bg)';
    warn.style.borderColor = 'var(--blue-line)';
    warn.style.color = 'var(--blue)';
    warn.innerHTML = `Simulación con un medio configurado de <strong>${layout.mediaWidthMm} mm</strong>. Conecta la impresora del cliente para confirmar sensor y desplazamiento.`;
  } else {
    warn.style.display = 'none';
  }
}

function _bcdUseEffectiveColumns(cols) {
  const el = document.getElementById('bcd-cols');
  if (!el) return;
  el.value = Math.max(1, Number(cols) || 1);
  _bcdUpdate();
}

// ── Guardar diseño ─────────────────────────────
async function _bcdSave() {
  const design = _bcdReadDesign();
  window._bcdDesign = design;
  window._bcdDirty  = false;

  try {
    await window.api.settings.set({ key: 'barcode_design', value: JSON.stringify(design) });
    if (_bcState && typeof _bcState === 'object') _bcState.design = { ...design };
    if (DB?.settings) DB.settings.barcode_design = JSON.stringify(design);
    toast('✓ Diseño de etiquetas guardado', 'ok');

    // Log auditoría
    window.api.audit?.log?.({
      action: 'barcode_design_update', entity: 'settings',
      entityId: null, detail: `${design.labelW}×${design.labelH}mm · ${design.format}`,
      userId: user?.id
    }).catch(() => {});
  } catch(e) {
    toast('Error al guardar: ' + e.message, 'e');
  }
}

// ── Prueba de calibración ─────────────────────
// Imprime un marco del tamaño exacto de la etiqueta + cruz al centro, con el
// ajuste fino aplicado. El usuario compara el marco con su etiqueta física:
// si no calza, ajusta "Ajuste vertical/horizontal" hasta centrarlo.
async function _bcdPrintCalibration() {
  const d = window._bcdDesign || _bcdReadDesign();
  const lw = Number(window._bcdPrinter?.widthMm) || Number(d.labelW) || 50;
  const lh = Number(d.labelH) || 30;
  const gap = Number.isFinite(Number(d.gapMm)) ? Number(d.gapMm) : 2;
  const ox = Number(d.offsetXmm) || 0;
  const oy = Number(d.offsetYmm) || 0;
  const pageH = lh + gap;
  const printerName = (window._bcdPrinter && window._bcdPrinter.name) || '';
  if (typeof printLabelBatch !== 'function' || typeof buildLabelCalibrationHTML !== 'function') {
    toast('No se pudo imprimir la prueba de calibración', 'err');
    return;
  }
  const html = buildLabelCalibrationHTML({
    widthMm: lw,
    labelWidthMm: Number(d.labelW) || 50,
    labelHeightMm: lh,
    gapMm: gap,
    pageMm: Number(d.pageMm) || 0,
    cols: Math.max(1, Number(d.cols) || 1),
    offsetXmm: ox,
    offsetYmm: oy,
    printerLabel: window._bcdPrinter?.name || '',
  });
  try {
    const result = await printLabelBatch({
      html, printerName, widthMm: lw, heightMm: pageH,
      userId: user?.id, referenceId: Math.floor(Date.now() / 1000),
    });
    if (result?.ok === false) throw new Error(result.error || 'La impresora rechazó la prueba');
    toast('✓ Prueba enviada · compara el marco y ajusta si hace falta', 'ok');
  } catch (e) {
    toast('No se pudo imprimir la prueba: ' + e.message, 'err');
  }
}

// ── Restablecer a defecto ─────────────────────
function _bcdReset() {
  const host = window._bcdContainer;
  if (host) renderBarcodeDesigner(host, {
    ...(window._bcdOptions || {}),
    initialDesign: _bcDefaultDesign(),
  });
}

// ── Aplicar preset ────────────────────────────
function _bcdApplyPreset(w, h, cols, label) {
  const lw = document.getElementById('bcd-lw');
  const lh = document.getElementById('bcd-lh');
  const lc = document.getElementById('bcd-cols');
  if (lw) lw.value = w;
  if (lh) lh.value = h;
  if (lc) {
    const current = _bcdReadDesign();
    current.labelW = w;
    current.labelH = h;
    current.cols = Math.max(1, Number(cols) || 1);
    const profile = {
      widthMm: Number(window._bcdPrinter?.widthMm) || w,
      printableWidthMm: Number(window._bcdPrinter?.printableWidthMm || window._bcdPrinter?.widthMm) || w,
    };
    const layout = typeof calculateLabelLayout === 'function'
      ? calculateLabelLayout({ ...current, cols: 8 }, profile)
      : { maxCols: 1 };
    lc.value = layout.maxCols;
  }
  _bcdUpdate();
  toast(`Preset aplicado: ${label}`, 'ok');
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
document.addEventListener('velo:printers-changed', event => {
  const state = document.getElementById('bcd-device-state');
  const line = document.getElementById('bcd-device-line');
  if (!state || !line || !window._bcdPrinter) return;
  const name = window._bcdPrinter.name || '';
  const printer = (event.detail?.printers || []).find(item => item.name === name);
  const available = !!printer;
  const runtime = printer && typeof getPrinterRuntimeState === 'function'
    ? getPrinterRuntimeState(printer) : null;
  window._bcdPrinter.installed = available;
  state.textContent = name
    ? (available
      ? (runtime?.reportedIssue ? 'Cola con incidencia' : 'Cola disponible')
      : 'Cola guardada, no disponible')
    : 'Pendiente de asignar';
  line.innerHTML = `<strong>Impresora:</strong> ${name
    ? `${typeof _bcEsc === 'function' ? _bcEsc(name) : name}${available ? '' : ' · no disponible en esta computadora'}`
    : 'Ninguna seleccionada · simulación local'}`;
});
}
