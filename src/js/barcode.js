// ══════════════════════════════════════════════
// barcode.js — Módulo de Etiquetas de Código de Barras
// Acceso: admin y superadmin
// El superadmin configura el diseño en su panel.
// El admin crea y manda a imprimir desde aquí.
// Usa JsBarcode (CDN) cargado dinámicamente.
// ══════════════════════════════════════════════

// ── Estado local del módulo ───────────────────
let _bcState = {
  selected: {},      // { productId: qty }
  design: null,      // diseño cargado de settings
  printers: [],
  selPrinter: '',
};

// ── Cargar JsBarcode una sola vez ─────────────
function _loadJsBarcode() {
  return new Promise((res) => {
    if (window.JsBarcode) { res(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    s.onload = res;
    s.onerror = res; // si falla, continuamos sin crash
    document.head.appendChild(s);
  });
}

// ══════════════════════════════════════════════
// RENDER PRINCIPAL
// ══════════════════════════════════════════════
async function renderBarcode(el) {
  if (!['admin', 'superadmin'].includes(user?.role)) {
    routeTo('dash'); return;
  }

  await _loadJsBarcode();

  // Cargar diseño guardado
  const settings    = await window.api.settings.getAll();
  const rawDesign   = settings?.barcode_design;
  _bcState.design   = rawDesign ? JSON.parse(rawDesign) : _bcDefaultDesign();
  _bcState.selected = {};

  // Impresoras disponibles
  // getPrinters retorna el array directamente (no { ok, data })
  _bcState.printers = await window.api.print.getPrinters().catch(() => []);
  if (!Array.isArray(_bcState.printers)) _bcState.printers = [];
  _bcState.selPrinter = settings?.barcode_printer || settings?.printer || '';

  el.innerHTML = '';
  el.style.overflowY = 'auto';
  el.style.paddingBottom = '60px';

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Etiquetas de Código de Barras'),
      h('div', { class: 'sec-sub' }, 'Selecciona productos, define cantidad e imprime')
    ),
    h('div', { style: 'display:flex;gap:8px' },
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

  // Card impresora
  const prCard = h('div', { class: 'card' });
  prCard.innerHTML = `
    <div class="card-title mb8">Impresora de Etiquetas</div>
    <div class="fg">
      <label class="lbl">Seleccionar impresora</label>
      <select class="inp" id="bc-printer-sel" onchange="bcSavePrinter(this.value)">
        <option value="">— Impresora del sistema —</option>
        ${_bcState.printers.map(p => `
          <option value="${p.name}" ${p.name === _bcState.selPrinter ? 'selected' : ''}>
            ${p.name}${_bcLabelType(p.name) ? ' · ' + _bcLabelType(p.name) : ''}
          </option>`).join('')}
      </select>
    </div>
    <div id="bc-printer-badge" style="margin-top:4px"></div>
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
    ${user?.role === 'superadmin' ? `
    <button class="btn btn-out btn-sm" style="margin-top:10px;width:100%"
            onclick="routeTo('superadmin')">
      ${svg('settings')} Cambiar diseño en Panel Dev
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
        <div style="font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div style="font-size:11px;color:var(--muted2)">${p.code||'—'} ${p.barcode?'· '+p.barcode:''}</div>
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
        <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</div>
        <div style="font-weight:700;color:var(--blue);margin-left:8px;flex-shrink:0">×${_bcState.selected[id]}</div>
      </div>`;
  });
  html += `</div>`;
  body.innerHTML = html;
}

// ── Impresora ─────────────────────────────────
async function bcSavePrinter(name) {
  _bcState.selPrinter = name;
  await window.api.settings.set({ key: 'barcode_printer', value: name }).catch(() => {});
  _bcUpdatePrinterBadge();
}

function _bcUpdatePrinterBadge() {
  const badge = document.getElementById('bc-printer-badge');
  if (!badge) return;
  const p = _bcState.selPrinter;
  if (!p) {
    badge.innerHTML = `<div class="badge n">Sin impresora específica — usa la del sistema</div>`;
    return;
  }
  const tipo = _bcLabelType(p);
  badge.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center">
      <div class="badge g">${svg('check')} ${p}</div>
      ${tipo ? `<div class="badge b">${tipo}</div>` : ''}
    </div>`;
}

function _bcLabelType(name) {
  if (!name) return '';
  const n = name.toLowerCase();
  if (/zebra|zpl/.test(n))    return 'Zebra · ZPL';
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

// ══════════════════════════════════════════════
// GENERACIÓN DE HTML DE ETIQUETAS
// ══════════════════════════════════════════════
function _bcBuildLabelsHTML(items) {
  // items = [{ product, qty }]
  const d = _bcState.design;
  if (!d) return '';

  const lw  = d.labelW || 50;      // mm
  const lh  = d.labelH || 25;      // mm
  const gap = d.gapMm || 2;        // mm entre etiquetas
  const cols = d.cols || 2;

  let allLabels = [];
  items.forEach(({ product: p, qty }) => {
    for (let i = 0; i < qty; i++) {
      allLabels.push(p);
    }
  });

  const labelHTML = (p) => {
    // Generar ID único para canvas del barcode
    const uid = `bc-${p.id}-${Math.random().toString(36).slice(2,7)}`;
    const barcodeVal = p.barcode || p.code || String(p.id).padStart(8,'0');

    return `
      <div class="vp-label" style="
        width:${lw}mm;height:${lh}mm;
        padding:${d.paddingMm||2}mm;
        background:${d.bgColor||'#ffffff'};
        border:${d.showBorder?'1px solid #ccc':'none'};
        border-radius:${d.borderRadius||2}px;
        display:flex;flex-direction:column;
        align-items:${d.align||'center'};
        justify-content:${d.vAlign||'center'};
        box-sizing:border-box;
        overflow:hidden;
        font-family:${d.fontFamily||'Arial,sans-serif'};
        color:${d.textColor||'#000000'};
        gap:${d.elemGap||1}mm;
        page-break-inside:avoid;
      ">
        ${d.showName && p.name ? `
          <div style="font-size:${d.nameFontSize||7}pt;font-weight:${d.nameBold?'700':'400'};
               text-align:center;line-height:1.1;width:100%;
               overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
            ${_bcEsc(p.name)}
          </div>` : ''}
        ${d.showBrand && p.brand ? `
          <div style="font-size:${d.brandFontSize||6}pt;color:${d.brandColor||'#666'};
               text-align:center;line-height:1">
            ${_bcEsc(p.brand)}
          </div>` : ''}
        ${d.showBarcode !== false ? `
          <svg id="${uid}" style="max-width:100%;height:auto"></svg>
          <script>
            (function(){
              var el = document.getElementById('${uid}');
              if(!el||!window.JsBarcode) return;
              try {
                JsBarcode(el,'${barcodeVal}',{
                  format:'${d.format||'CODE128'}',
                  width:${d.barWidth||1.5},
                  height:${d.barHeight||20},
                  fontSize:${d.barFontSize||8},
                  margin:0,
                  displayValue:${d.showBarcodeText!==false},
                  background:'transparent',
                  lineColor:'${d.barColor||'#000000'}'
                });
              } catch(e){ el.style.display='none'; }
            })();
          <\/script>` : ''}
        ${d.showCode && p.code ? `
          <div style="font-size:${d.codeFontSize||6}pt;font-family:monospace;
               color:${d.codeColor||'#555'};text-align:center">
            ${_bcEsc(p.code)}
          </div>` : ''}
        ${d.showPrice ? `
          <div style="font-size:${d.priceFontSize||9}pt;font-weight:700;
               color:${d.priceColor||'#000'};text-align:center">
            ${fmt(p.price)}
          </div>` : ''}
        ${d.customText ? `
          <div style="font-size:${d.customFontSize||6}pt;text-align:center;
               color:${d.customColor||'#444'}">
            ${_bcEsc(d.customText)}
          </div>` : ''}
      </div>`;
  };

  const styles = `
    <style>
      @page { margin: ${d.pageMm||5}mm; }
      body  { margin:0;padding:0;background:#fff; }
      .vp-label-grid {
        display:grid;
        grid-template-columns: repeat(${cols}, ${lw}mm);
        gap:${gap}mm;
        justify-content:center;
      }
      @media print {
        .no-print { display:none!important; }
      }
    </style>`;

  const preview = `
    <div class="no-print" style="padding:12px;background:#f5f5f5;border-bottom:1px solid #ddd;display:flex;gap:8px;align-items:center">
      <button onclick="window.print()" style="padding:6px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">
        🖨 Imprimir
      </button>
      <span style="font-size:12px;color:#666">${allLabels.length} etiqueta(s) · ${cols} col · ${lw}×${lh}mm</span>
    </div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
    ${styles}
    </head><body>
    ${preview}
    <div class="vp-label-grid">
      ${allLabels.map(p => labelHTML(p)).join('\n')}
    </div>
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
    const html = _bcBuildLabelsHTML([{ product: sample, qty: 2 }]);
    _bcShowPreviewModal(html, 'Vista previa — diseño actual');
    return;
  }
  const items = ids.map(id => ({
    product: DB.products.find(p => p.id == id),
    qty: _bcState.selected[id] || 1
  })).filter(i => i.product);

  const html = _bcBuildLabelsHTML(items);
  _bcShowPreviewModal(html, 'Vista previa');
}

function _bcShowPreviewModal(html, title) {
  openModal(`
    <div class="modal-title">${title}</div>
    <div class="modal-sub">Revisa antes de imprimir</div>
    <iframe id="bc-preview-iframe"
            style="width:100%;height:500px;border:1px solid var(--line);border-radius:8px;background:#fff;margin-top:12px"
            srcdoc="${html.replace(/"/g, '&quot;')}">
    </iframe>
    <div class="modal-foot" style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-green" onclick="closeModal();_bcPrint()">
        ${svg('print')} Imprimir ahora
      </button>
    </div>
  `, 'modal-xl');
}

// ══════════════════════════════════════════════
// IMPRESIÓN
// ══════════════════════════════════════════════
async function _bcPrint() {
  const ids = Object.keys(_bcState.selected);
  if (!ids.length) {
    toast('Selecciona al menos un producto', 'w');
    return;
  }
  const items = ids.map(id => ({
    product: DB.products.find(p => p.id == id),
    qty: _bcState.selected[id] || 1
  })).filter(i => i.product);

  const total = items.reduce((s, i) => s + i.qty, 0);
  const html  = _bcBuildLabelsHTML(items);
  const d     = _bcState.design;

  try {
    const result = await window.api.print.html({
      html,
      printerName:  _bcState.selPrinter || '',
      printerWidth: `${d.labelW || 50}mm`,
      jobType:      'barcode_labels',
      referenceId:  null,
      userId:       user?.id,
      silent:       true,
    });
    if (result?.ok !== false) {
      toast(`✓ ${total} etiqueta(s) enviadas a imprimir`, 'ok');
      // Log de auditoría
      window.api.audit?.log?.({ action: 'barcode_print', entity: 'products',
        entityId: null, detail: `${total} etiquetas (${items.length} productos)`,
        userId: user?.id }).catch(() => {});
    } else {
      toast('Error al imprimir: ' + (result?.error || 'desconocido'), 'e');
    }
  } catch (e) {
    toast('Error de impresión: ' + e.message, 'e');
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
    cols:         4,
    pageMm:       5,
    elemGap:      1,

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
