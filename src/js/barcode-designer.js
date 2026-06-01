// ══════════════════════════════════════════════
// barcode-designer.js — Diseñador de etiquetas
// Solo accesible desde el Panel Superadmin.
// Llama renderBarcodeDesigner(container)
// ══════════════════════════════════════════════

async function renderBarcodeDesigner(container) {
  await _loadJsBarcode();

  const settings = await window.api.settings.getAll();
  const rawDesign = settings?.barcode_design;
  let design = rawDesign ? JSON.parse(rawDesign) : _bcDefaultDesign();

  // ── Producto de muestra para preview ─────────
  const sampleProduct = DB.products[0] || {
    id: 1, name: 'Producto de Muestra', brand: 'Marca Ejemplo',
    code: 'PROD-001', barcode: '7501000000000', price: 350.00
  };

  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:0';

  // Header
  const hdr = document.createElement('div');
  hdr.innerHTML = `
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
          <label class="lbl">Columnas/hoja</label>
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
          <label class="lbl">Margen de página (mm)</label>
          <input class="inp" id="bcd-pagemm" type="number" min="0" max="20"
                 value="${design.pageMm}" oninput="_bcdUpdate()"/>
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
      <div id="bcd-preview-wrap" style="
        background:#f0f0f0;
        border-radius:8px;
        padding:16px;
        display:flex;
        justify-content:center;
        align-items:center;
        min-height:180px;
        overflow:hidden;
      ">
        <div id="bcd-preview-label" style="background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15)">
          Cargando...
        </div>
      </div>
      <div id="bcd-preview-info" style="margin-top:8px;font-size:11px;color:var(--muted2);text-align:center"></div>
    </div>

    <!-- Atajos de impresora -->
    <div class="card" style="padding:16px;margin-top:12px">
      <div class="card-title mb8">🖨 Compatibilidad de Impresoras</div>
      <div style="font-size:12px;line-height:1.7;color:var(--ink3)">
        <div>• <strong>Zebra, Honeywell, TSC, SATO</strong>: etiquetas industriales</div>
        <div>• <strong>Brother QL</strong>: 62mm, 89mm, 102mm de ancho</div>
        <div>• <strong>DYMO LabelWriter</strong>: 57mm, 89mm</div>
        <div>• <strong>Bixolon</strong>: 80mm térmico</div>
        <div>• <strong>Cualquier impresora</strong>: modo hoja normal</div>
      </div>
      <div class="alrt b" style="margin-top:10px">
        <div class="alrt-dot b"></div>
        <div style="font-size:11px">
          El admin selecciona la impresora específica desde el módulo de Etiquetas.
          Aquí solo defines el diseño visual.
        </div>
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

  // mm → px a 96dpi para pantalla (1mm ≈ 3.78px)
  const PX = 3.78;
  const lw = d.labelW * PX;
  const lh = d.labelH * PX;

  const barcodeVal = p.barcode || p.code || String(p.id).padStart(8,'0');

  // Construir el label como DOM real (no iframe) para preview instantáneo
  const lbl = document.getElementById('bcd-preview-label');
  if (!lbl) return;

  lbl.style.cssText = `
    width:${lw}px;height:${lh}px;
    padding:${d.paddingMm*PX}px;
    background:${d.bgColor};
    border:${d.showBorder?'1px solid #ccc':'none'};
    border-radius:${d.borderRadius}px;
    display:flex;flex-direction:column;
    align-items:${d.align};
    justify-content:${d.vAlign};
    box-sizing:border-box;
    overflow:hidden;
    font-family:${d.fontFamily};
    color:${d.textColor};
    gap:${d.elemGap*PX}px;
    box-shadow:0 2px 8px rgba(0,0,0,.15);
  `;

  lbl.innerHTML = '';

  if (d.showName && p.name) {
    const n = document.createElement('div');
    n.style.cssText = `font-size:${d.nameFontSize*1.33}px;font-weight:${d.nameBold?'700':'400'};
      text-align:center;line-height:1.1;width:100%;
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis`;
    n.textContent = p.name;
    lbl.appendChild(n);
  }

  if (d.showBrand && p.brand) {
    const br = document.createElement('div');
    br.style.cssText = `font-size:${d.brandFontSize*1.33}px;color:${d.brandColor};text-align:center`;
    br.textContent = p.brand;
    lbl.appendChild(br);
  }

  if (d.showBarcode !== false) {
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svgEl.style.cssText = 'max-width:100%;height:auto;display:block';
    lbl.appendChild(svgEl);
    if (window.JsBarcode) {
      try {
        JsBarcode(svgEl, barcodeVal, {
          format: d.format,
          width: d.barWidth,
          height: d.barHeight,
          fontSize: d.barFontSize,
          margin: 0,
          displayValue: d.showBarcodeText !== false,
          background: 'transparent',
          lineColor: d.barColor,
        });
      } catch (e) {
        svgEl.style.display = 'none';
        const err = document.createElement('div');
        err.style.cssText = 'font-size:10px;color:var(--red);text-align:center;padding:4px';
        err.textContent = `⚠ ${d.format} no soporta "${barcodeVal}"`;
        lbl.appendChild(err);
      }
    }
  }

  if (d.showCode && p.code) {
    const c = document.createElement('div');
    c.style.cssText = `font-size:${d.codeFontSize*1.33}px;font-family:monospace;color:${d.codeColor};text-align:center`;
    c.textContent = p.code;
    lbl.appendChild(c);
  }

  if (d.showPrice) {
    const pr = document.createElement('div');
    pr.style.cssText = `font-size:${d.priceFontSize*1.33}px;font-weight:700;color:${d.priceColor};text-align:center`;
    pr.textContent = fmt(p.price);
    lbl.appendChild(pr);
  }

  if (d.customText) {
    const ct = document.createElement('div');
    ct.style.cssText = `font-size:${d.customFontSize*1.33}px;text-align:center;color:${d.customColor}`;
    ct.textContent = d.customText;
    lbl.appendChild(ct);
  }

  if (info) {
    info.textContent = `${d.labelW}×${d.labelH}mm · ${d.cols} columnas · ${d.format}`;
  }
}

// ── Guardar diseño ─────────────────────────────
async function _bcdSave() {
  const design = _bcdReadDesign();
  window._bcdDesign = design;
  window._bcdDirty  = false;

  try {
    await window.api.settings.set({ key: 'barcode_design', value: JSON.stringify(design) });
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

// ── Restablecer a defecto ─────────────────────
function _bcdReset() {
  window._bcdDesign = _bcDefaultDesign();
  // Volver a renderizar el diseñador completo
  const superadminEl = document.getElementById('page');
  if (superadminEl) renderSuperAdmin(superadminEl);
}

// ── Aplicar preset ────────────────────────────
function _bcdApplyPreset(w, h, cols, label) {
  const lw = document.getElementById('bcd-lw');
  const lh = document.getElementById('bcd-lh');
  const lc = document.getElementById('bcd-cols');
  if (lw) lw.value = w;
  if (lh) lh.value = h;
  if (lc) lc.value = cols;
  _bcdUpdate();
  toast(`Preset aplicado: ${label}`, 'ok');
}
