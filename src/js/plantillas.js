// ══════════════════════════════════════════════
// plantillas.js — Sistema de Plantillas de Impresión
// Detección inteligente + 8 plantillas + vista previa
// Solo accesible por Super Admin
// ══════════════════════════════════════════════

// ── Escape HTML para evitar XSS en recibos ───
function _esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Detección de tipo de impresora ────────────
function detectPrinterType(printerName) {
  if (!printerName) return 'unknown';
  const n = printerName.toLowerCase();

  if (/58|mini|port|pocket|handheld|bt.*print|print.*bt/.test(n)) return '58mm';

  if (/80|thermal|termi|receipt|pos|ticket|aokia|epson.?tm|star.?tsp|bixolon|sewoo|xprint|citizen|rongta|hprt|zjiang|iposp|goojprt|rpp|srp|scp|tsp|tm-t|tm-u|eu-t/.test(n)) return '80mm';

  if (/laser|inkjet|officejet|laserjet|pixma|envy|deskjet|ecotank|l-series|brother|canon|hp |ricoh|xerox|kyocera|samsung.*ml|samsung.*clp|pdf|fax|onenote|xps/.test(n)) return 'carta';

  if (/a4|a3|ledger|legal/.test(n)) return 'carta';

  // Default: si no se reconoce, asumir 80mm (la más común en POS)
  return '80mm';
}

// ── Definición de plantillas ──────────────────
const PLANTILLAS = [
  // ═══════════════ 58mm ═══════════════
  {
    id:        'termica_58_basica',
    nombre:    'Básica 58mm',
    tipo:      '58mm',
    icono:     '🧾',
    desc:      'Compacta y eficiente. Ideal para impresoras portátiles o de bolsillo.',
    opciones: {
      logo: false, rnc: true, ncf: true, mensaje: true,
      cedula: false, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderTermica(sale, cfg, opts, 52),
  },

  // ═══════════════ 80mm ═══════════════
  {
    id:        'termica_80_clasica',
    nombre:    'Clásica 80mm',
    tipo:      '80mm',
    icono:     '🧾',
    desc:      'El diseño estándar de ticket térmico. Funciona en cualquier negocio.',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: true, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderTermica(sale, cfg, opts, 76),
  },
  {
    id:        'termica_80_moderna',
    nombre:    'Moderna 80mm',
    tipo:      '80mm',
    icono:     '🧾',
    desc:      'Diseño con separadores y énfasis visual en el total. Más elegante.',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: true, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderTermicaModerna(sale, cfg, opts, 76),
  },
  {
    id:        'termica_80_minimal',
    nombre:    'Minimalista 80mm',
    tipo:      '80mm',
    icono:     '🧾',
    desc:      'Solo lo esencial. Ideal para cafeterías, comida rápida o ventas rápidas.',
    opciones: {
      logo: false, rnc: false, ncf: true, mensaje: false,
      cedula: false, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderTermicaMinimal(sale, cfg, opts, 76),
  },

  // ═══════════════ Carta/A4 ═══════════════
  {
    id:        'carta_recibo',
    nombre:    'Recibo Simple',
    tipo:      'carta',
    icono:     '📄',
    desc:      'Recibo en hoja carta. Similar al ticket térmico pero en papel normal.',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: true, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderCartaRecibo(sale, cfg, opts),
  },
  {
    id:        'carta_formal',
    nombre:    'Factura Formal',
    tipo:      'carta',
    icono:     '📄',
    desc:      'Factura profesional con tabla, logo grande y datos completos del negocio.',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: true, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderCartaFormal(sale, cfg, opts),
  },
  {
    id:        'carta_ncf',
    nombre:    'Factura NCF Dominicana',
    tipo:      'carta',
    icono:     '📄',
    desc:      'Diseño fiscal con NCF destacado. Para negocios con comprobante fiscal (DGII).',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: true, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderCartaNCF(sale, cfg, opts),
  },
  {
    id:        'media_carta',
    nombre:    'Media Carta',
    tipo:      'carta',
    icono:     '📄',
    desc:      'Hoja carta dividida en dos. Económico — dos facturas por hoja.',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: false, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderMediaCarta(sale, cfg, opts),
  },
];

// ── Obtener plantillas por tipo ───────────────
function getPlantillasByTipo(tipo) {
  return PLANTILLAS.filter(p => p.tipo === tipo);
}

function getPlantilla(id) {
  return PLANTILLAS.find(p => p.id === id) || PLANTILLAS[1]; // default: clásica 80mm
}

// ── Datos de muestra para vista previa ────────
function getSampleSale(cfg) {
  return {
    id:             1,
    type:           'factura',
    date:           new Date().toISOString().split('T')[0],
    time:           new Date().toLocaleTimeString('es-DO', { hour:'2-digit', minute:'2-digit' }),
    customer_name:  'Cliente Ejemplo',
    customer_rnc:   '001-0000000-0',
    cajero:         'Cajero Demo',
    items: [
      { product_name: 'Producto A',    qty: 2, unit_price: 850  },
      { product_name: 'Producto B',    qty: 1, unit_price: 1200 },
      { product_name: 'Servicio XYZ', qty: 1, unit_price: 500  },
    ],
    subtotal:        3400,
    discount_pct:    0,
    discount_amt:    0,
    tax_amt:         612,
    total:           4012,
    payment_method:  'efectivo',
  };
}

// ══════════════════════════════════════════════
// HELPER — NCF y tipo de documento
// ══════════════════════════════════════════════

// Devuelve el NCF real de la venta, o string vacío si no aplica
function _getNcf(sale) {
  if (sale.type !== 'factura') return '';
  if (sale.ncf && sale.ncf.trim()) return sale.ncf.trim();
  // Fallback: solo si no hay NCF guardado
  return `B01${String(sale.id).padStart(9,'0')}`;
}

// Etiqueta del tipo de documento
function _docLabel(sale) {
  if (sale.type === 'cotizacion') return 'COTIZACIÓN';
  if (sale.type === 'devolucion') return 'NOTA DE DEVOLUCIÓN';
  if (sale.type === 'factura')    return 'FACTURA';
  return 'RECIBO DE COMPRA';
}

// ¿Mostrar ITBIS? Solo en facturas con monto > 0
function _showItbis(sale) {
  return sale.type === 'factura' && (sale.tax_amt || 0) > 0;
}

// ¿Mostrar NCF? Solo en facturas con NCF disponible
function _showNcf(sale, opts) {
  return opts.ncf && sale.type === 'factura' && _getNcf(sale) !== '';
}

// ══════════════════════════════════════════════
// RENDERIZADORES DE PLANTILLAS
// ══════════════════════════════════════════════

function _termicaHeader(cfg, opts, widthMm) {
  const cols = widthMm <= 52 ? 32 : 42;
  const sep  = '─'.repeat(cols);
  const lines = [];

  if (opts.logo && cfg.biz_logo) {
    lines.push(`<div style="text-align:center;margin-bottom:4px">
      <img src="${cfg.biz_logo}" style="max-width:${widthMm-4}mm;max-height:14mm;
           filter:grayscale(100%) contrast(150%)"/>
    </div>`);
  }

  lines.push(`<div style="text-align:center;font-weight:700;font-size:${widthMm<=52?'11px':'13px'}">${_esc(cfg.biz_name||'Mi Negocio')}</div>`);
  if (opts.rnc && cfg.biz_rnc) lines.push(`<div style="text-align:center">RNC: ${_esc(cfg.biz_rnc)}</div>`);
  if (cfg.biz_addr) lines.push(`<div style="text-align:center">${_esc(cfg.biz_addr)}</div>`);
  if (cfg.biz_phone) lines.push(`<div style="text-align:center">Tel: ${_esc(cfg.biz_phone)}</div>`);
  lines.push(`<div style="text-align:center">${sep}</div>`);
  return lines.join('');
}

function _termicaItems(items, widthMm) {
  const cols = widthMm <= 52 ? 32 : 42;
  const priceW = 10;
  const nameW  = cols - priceW - 2;
  let html = '';
  items.forEach(i => {
    const name  = _esc((i.product_name || i.name || '').slice(0, nameW));
    const price = `RD$${Number(i.unit_price||0).toLocaleString('es-DO')}`;
    const total = `RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}`;
    html += `<div>${name}</div>`;
    html += `<div style="display:flex;justify-content:space-between;padding-left:8px;color:#555">
      <span>${i.qty} x ${price}</span><span>${total}</span>
    </div>`;
  });
  return html;
}

// Plantilla 1 — Térmica Básica/Clásica
function renderTermica(sale, cfg, opts, widthMm = 76) {
  const cols    = widthMm <= 52 ? 32 : 42;
  const sep     = '─'.repeat(cols);
  const sepD    = '═'.repeat(cols);
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';
  const ncf     = _getNcf(sale);
  // Opciones de estilo personalizables (sobrescriben defaults)
  const estilos = opts._estilos || {};
  const fs      = estilos.fontSize    || (widthMm <= 52 ? '10.5px' : '11.5px');
  const mt      = estilos.marginTop   || '2mm';
  const mb      = estilos.marginBottom|| '4mm';
  const ml      = estilos.marginLeft  || '2mm';
  const mr      = estilos.marginRight || '2mm';
  const lh      = estilos.lineHeight  || '1.45';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: ${widthMm}mm auto; margin: ${mt} ${mr} ${mb} ${ml}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${widthMm-4}mm; font-family:'Courier New',monospace;
         font-size:${fs}; line-height:${lh}; color:#000; }
  img { display:block; margin:0 auto; }
</style></head><body>
  ${_termicaHeader(cfg, opts, widthMm)}
  <div style="text-align:center;font-weight:700">*** ${_docLabel(sale)} ***</div>
  ${sale.isReprint ? '<div style="text-align:center">--- REIMPRESIÓN ---</div>' : ''}
  ${isDevolucion && sale.original_sale_id ? `<div style="text-align:center">Ref. venta #${String(sale.original_sale_id).padStart(5,'0')}</div>` : ''}
  <div style="text-align:center">${sep}</div>
  <div style="display:flex;justify-content:space-between">
    <span>No.: ${String(sale.id).padStart(5,'0')}</span>
    <span>Fecha: ${sale.date}</span>
  </div>
  <div style="display:flex;justify-content:space-between">
    <span>Hora: ${sale.time}</span>
    <span>Cajero: ${_esc((sale.cajero||'').split(' ')[0])}</span>
  </div>
  <div style="display:flex;justify-content:space-between">
    <span>Cliente:</span>
    <span>${_esc(sale.customer_name||'Consumidor Final')}</span>
  </div>
  ${opts.cedula && sale.customer_rnc ? `<div style="display:flex;justify-content:space-between"><span>Cédula/RNC:</span><span>${_esc(sale.customer_rnc)}</span></div>` : ''}
  <div style="text-align:center">${sep}</div>
  <div style="display:flex;justify-content:space-between;font-weight:700">
    <span>DESCRIPCIÓN</span><span>TOTAL</span>
  </div>
  <div style="text-align:center">${sep}</div>
  ${_termicaItems(sale.items||[], widthMm)}
  <div style="text-align:center">${sep}</div>
  <div style="display:flex;justify-content:space-between">
    <span>Subtotal:</span><span>RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</span>
  </div>
  ${sale.discount_amt > 0 ? `<div style="display:flex;justify-content:space-between"><span>Descuento (${sale.discount_pct}%):</span><span>-RD$${Number(sale.discount_amt).toLocaleString('es-DO')}</span></div>` : ''}
  ${_showItbis(sale) ? `<div style="display:flex;justify-content:space-between"><span>ITBIS (${sale.tax_pct||18}%):</span><span>RD$${Number(sale.tax_amt||0).toLocaleString('es-DO')}</span></div>` : ''}
  <div style="text-align:center">${sepD}</div>
  <div style="display:flex;justify-content:space-between;font-weight:700;font-size:${widthMm<=52?'12px':'13px'}">
    <span>TOTAL:</span><span>RD$${Number(sale.total||0).toLocaleString('es-DO')}</span>
  </div>
  <div style="text-align:center">${sepD}</div>
  ${sale.payment_method === 'mixto' ? `
  <div style="display:flex;justify-content:space-between"><span>Método:</span><span>MIXTO</span></div>
  ${sale.mix_efec > 0 ? `<div style="display:flex;justify-content:space-between"><span>  Efectivo:</span><span>RD$${Number(sale.mix_efec).toLocaleString('es-DO')}</span></div>` : ''}
  ${sale.mix_card > 0 ? `<div style="display:flex;justify-content:space-between"><span>  Tarjeta/Trans.:</span><span>RD$${Number(sale.mix_card).toLocaleString('es-DO')}</span></div>` : ''}
  ` : `<div style="display:flex;justify-content:space-between"><span>Método de pago:</span><span>${(sale.payment_method||'efectivo').toUpperCase()}</span></div>`}
  ${_showNcf(sale, opts) ? `
  <div style="text-align:center">${sep}</div>
  <div style="text-align:center">Documento con validez fiscal</div>
  <div style="text-align:center;font-weight:700">NCF: ${ncf}</div>` : ''}
  ${opts.mensaje && cfg.receipt_msg ? `
  <div style="text-align:center">${sep}</div>
  <div style="text-align:center">${cfg.receipt_msg}</div>
  <div style="text-align:center">Conserve su comprobante</div>` : ''}
  <div style="text-align:center">${sep}</div>
</body></html>`;
}

// Plantilla 2 — Térmica Moderna
function renderTermicaModerna(sale, cfg, opts, widthMm = 76) {
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';
  const ncf = _getNcf(sale);

  const _es2 = opts._estilos || {};
  const _fs2 = _es2.fontSize    || '11.5px';
  const _mt2 = _es2.marginTop   || '2mm';
  const _mb2 = _es2.marginBottom|| '4mm';
  const _ml2 = _es2.marginLeft  || '2mm';
  const _mr2 = _es2.marginRight || '2mm';
  const _lh2 = _es2.lineHeight  || '1.5';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: ${widthMm}mm auto; margin: ${_mt2} ${_mr2} ${_mb2} ${_ml2}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${widthMm-4}mm; font-family:'Courier New',monospace;
         font-size:${_fs2}; line-height:${_lh2}; color:#000; }
  .title { text-align:center; font-size:15px; font-weight:900;
           letter-spacing:2px; margin:4px 0; }
  .sep { border:none; border-top:1px solid #000; margin:4px 0; }
  .sep-d { border:none; border-top:3px double #000; margin:4px 0; }
  .row { display:flex; justify-content:space-between; }
  .total-row { display:flex; justify-content:space-between;
               font-size:14px; font-weight:900; }
  .center { text-align:center; }
  img { display:block; margin:0 auto; }
</style></head><body>
  ${opts.logo && cfg.biz_logo ? `<img src="${cfg.biz_logo}" style="max-width:${widthMm-4}mm;max-height:14mm;filter:grayscale(100%) contrast(150%);margin-bottom:4px"/>` : ''}
  <div class="title">${_esc(cfg.biz_name||'Mi Negocio')}</div>
  ${opts.rnc && cfg.biz_rnc ? `<div class="center" style="font-size:10px">RNC: ${_esc(cfg.biz_rnc)}</div>` : ''}
  ${cfg.biz_addr ? `<div class="center" style="font-size:10px">${_esc(cfg.biz_addr)} · Tel: ${_esc(cfg.biz_phone||'')}</div>` : ''}
  <hr class="sep-d"/>
  <div class="center" style="font-size:13px;font-weight:700;letter-spacing:1px">
    ◆ ${_docLabel(sale)} ◆
    ${isDevolucion && sale.original_sale_id ? `<div style="font-size:10px;text-align:center">Ref. venta #${String(sale.original_sale_id).padStart(5,'0')}</div>` : ''}
  </div>
  <hr class="sep"/>
  <div class="row"><span>No.:</span><span style="font-weight:700">${String(sale.id).padStart(5,'0')}</span></div>
  <div class="row"><span>Fecha:</span><span>${sale.date} ${sale.time}</span></div>
  <div class="row"><span>Cliente:</span><span>${_esc(sale.customer_name||'Consumidor Final')}</span></div>
  <div class="row"><span>Cajero:</span><span>${_esc(sale.cajero||'')}</span></div>
  <hr class="sep-d"/>
  ${(sale.items||[]).map(i => `
    <div style="font-weight:600">${_esc(i.product_name||i.name)}</div>
    <div class="row" style="padding-left:6px;color:#333;font-size:10.5px">
      <span>${i.qty} × RD$${Number(i.unit_price||0).toLocaleString('es-DO')}</span>
      <span>RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}</span>
    </div>`).join('')}
  <hr class="sep"/>
  <div class="row"><span>Subtotal</span><span>RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</span></div>
  ${sale.discount_amt > 0 ? `<div class="row"><span>Descuento ${sale.discount_pct}%</span><span style="color:#e00">-RD$${Number(sale.discount_amt).toLocaleString('es-DO')}</span></div>` : ''}
  ${_showItbis(sale) ? `<div class="row"><span>ITBIS (${sale.tax_pct||18}%)</span><span>RD$${Number(sale.tax_amt||0).toLocaleString('es-DO')}</span></div>` : ''}
  <hr class="sep-d"/>
  <div class="total-row">
    <span>▶ TOTAL</span>
    <span>RD$${Number(sale.total||0).toLocaleString('es-DO')}</span>
  </div>
  <hr class="sep-d"/>
  ${sale.payment_method === 'mixto' ? `
  <div class="row"><span>Método:</span><span>MIXTO</span></div>
  ${sale.mix_efec > 0 ? `<div class="row"><span style="padding-left:8px">Efectivo:</span><span>RD$${Number(sale.mix_efec).toLocaleString('es-DO')}</span></div>` : ''}
  ${sale.mix_card > 0 ? `<div class="row"><span style="padding-left:8px">Tarjeta/Trans.:</span><span>RD$${Number(sale.mix_card).toLocaleString('es-DO')}</span></div>` : ''}
  ` : `<div class="row"><span>Forma de pago:</span><span>${(sale.payment_method||'efectivo').toUpperCase()}</span></div>`}
  ${_showNcf(sale, opts) ? `<hr class="sep"/><div class="center" style="font-size:10px">Documento con validez fiscal</div><div class="center" style="font-size:10px;font-weight:700">NCF: ${ncf}</div>` : ''}
  ${opts.mensaje && cfg.receipt_msg && !isCotizacion ? `<hr class="sep"/><div class="center">${cfg.receipt_msg}</div>` : ''}
  <hr class="sep"/>
</body></html>`;
}

// Plantilla 3 — Térmica Minimalista
function renderTermicaMinimal(sale, cfg, opts, widthMm = 76) {
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const ncf = _getNcf(sale);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: ${widthMm}mm auto; margin: 1mm 2mm 3mm 2mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${widthMm-4}mm; font-family:'Courier New',monospace;
         font-size:10.5px; line-height:1.4; color:#000; }
</style></head><body>
  <div style="text-align:center;font-size:12px;font-weight:700;margin-bottom:2px">${_esc(cfg.biz_name||'Mi Negocio')}</div>
  <div style="text-align:center;font-size:9px;margin-bottom:4px">${sale.date} ${sale.time} · #${String(sale.id).padStart(5,'0')}</div>
  <div style="border-top:1px dashed #000;margin:3px 0"></div>
  ${(sale.items||[]).map(i => `
    <div style="display:flex;justify-content:space-between">
      <span>${_esc(i.product_name||i.name)} x${i.qty}</span>
      <span>RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}</span>
    </div>`).join('')}
  <div style="border-top:1px dashed #000;margin:3px 0"></div>
  <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700">
    <span>TOTAL</span>
    <span>RD$${Number(sale.total||0).toLocaleString('es-DO')}</span>
  </div>
  ${_showNcf(sale, opts) ? `<div style="border-top:1px dashed #000;margin:3px 0"></div><div style="text-align:center;font-size:9px">NCF: ${ncf}</div>` : ''}
  <div style="text-align:center;font-size:9px;margin-top:3px">${sale.payment_method||'EFECTIVO'} · ${isCotizacion ? 'Cotización sin valor fiscal' : 'Gracias'}</div>
</body></html>`;
}

// Plantilla 4 — Carta Recibo Simple
function renderCartaRecibo(sale, cfg, opts) {
  const _ec = opts._estilos || {};
  const _fsc = _ec.fontSize    || '11pt';
  const _mtc = _ec.marginTop   || '15mm';
  const _mbc = _ec.marginBottom|| '15mm';
  const _mlc = _ec.marginLeft  || '20mm';
  const _mrc = _ec.marginRight || '20mm';
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';
  const ncf = _getNcf(sale);
  const rows = (sale.items||[]).map(i => `
    <tr>
      <td>${_esc(i.product_name||i.name)}</td>
      <td style="text-align:center">${i.qty}</td>
      <td style="text-align:right">RD$${Number(i.unit_price||0).toLocaleString('es-DO')}</td>
      <td style="text-align:right">RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: letter; margin: ${_mtc} ${_mrc} ${_mbc} ${_mlc}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:12px; color:#000; }
  h1 { font-size:20px; margin-bottom:2px; }
  .header { display:flex; justify-content:space-between; margin-bottom:14px; }
  .biz { flex:1; }
  .doc { text-align:right; }
  .doc .num { font-size:22px; font-weight:700; color:#1a1a1a; }
  table { width:100%; border-collapse:collapse; margin:14px 0; }
  th { background:#f3f4f6; padding:7px 10px; text-align:left; font-size:11px; text-transform:uppercase; }
  td { padding:7px 10px; border-bottom:1px solid #e5e7eb; }
  .totals { margin-left:auto; width:220px; }
  .totals tr td { padding:4px 8px; }
  .totals tr:last-child td { font-weight:700; font-size:14px; border-top:2px solid #000; }
  .footer { margin-top:20px; text-align:center; font-size:11px; color:#666; }
  img { display:block; max-height:55px; max-width:180px; }
</style></head><body>
  <div class="header">
    <div class="biz">
      ${opts.logo && cfg.biz_logo ? `<img src="${cfg.biz_logo}" style="display:block;max-height:55px;max-width:180px;margin:0 auto 8px auto;filter:grayscale(100%) contrast(150%)"/><br/>` : ''}
      <strong style="font-size:16px">${_esc(cfg.biz_name||'Mi Negocio')}</strong><br/>
      ${opts.rnc && cfg.biz_rnc ? `RNC: ${_esc(cfg.biz_rnc)}<br/>` : ''}
      ${_esc(cfg.biz_addr||'')}<br/>
      Tel: ${_esc(cfg.biz_phone||'')}
    </div>
    <div class="doc">
      <div style="font-size:13px;color:#666">${_docLabel(sale)}</div>
      <div class="num">#${String(sale.id).padStart(5,'0')}</div>
      <div>${sale.date}</div>
      <div>Cajero: ${_esc(sale.cajero||'')}</div>
    </div>
  </div>
  <div style="background:#f9fafb;padding:8px 12px;border-radius:4px;margin-bottom:10px">
    <strong>Cliente:</strong> ${_esc(sale.customer_name||'Consumidor Final')}
    ${opts.cedula && sale.customer_rnc ? ` · Cédula/RNC: ${_esc(sale.customer_rnc)}` : ''}
  </div>
  <table>
    <thead><tr><th>Descripción</th><th style="text-align:center">Cant.</th>
    <th style="text-align:right">Precio</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td style="text-align:right">RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</td></tr>
    ${sale.discount_amt > 0 ? `<tr><td>Descuento (${sale.discount_pct}%)</td><td style="text-align:right;color:red">-RD$${Number(sale.discount_amt).toLocaleString('es-DO')}</td></tr>` : ''}
    ${_showItbis(sale) ? `<tr><td>ITBIS (${sale.tax_pct||18}%)</td><td style="text-align:right">RD$${Number(sale.tax_amt||0).toLocaleString('es-DO')}</td></tr>` : ''}
    <tr><td>TOTAL</td><td style="text-align:right">RD$${Number(sale.total||0).toLocaleString('es-DO')}</td></tr>
  </table>
  <div style="margin-top:10px;font-size:12px">
    ${sale.payment_method === 'mixto'
      ? `<strong>Método de pago:</strong> MIXTO
         ${sale.mix_efec > 0 ? `&nbsp;· Efectivo: RD$${Number(sale.mix_efec).toLocaleString('es-DO')}` : ''}
         ${sale.mix_card > 0 ? `&nbsp;· Tarjeta/Trans.: RD$${Number(sale.mix_card).toLocaleString('es-DO')}` : ''}`
      : `<strong>Método de pago:</strong> ${(sale.payment_method||'efectivo').toUpperCase()}`}
  </div>
  ${isDevolucion && sale.original_sale_id ? `<div style="margin-top:6px;font-size:11px;color:#555">Ref. venta original: #${String(sale.original_sale_id).padStart(5,'0')}</div>` : ''}
  ${_showNcf(sale, opts) ? `<div style="margin-top:8px;font-size:11px;color:#555">NCF: <strong>${ncf}</strong> · Documento con validez fiscal</div>` : ''}
  ${isCotizacion ? `<div style="margin-top:8px;font-size:11px;color:#888;font-style:italic">Esta cotización no tiene valor fiscal.</div>` : ''}
  ${opts.mensaje && cfg.receipt_msg && !isCotizacion ? `<div class="footer">${cfg.receipt_msg}</div>` : ''}
</body></html>`;
}

// Plantilla 5 — Carta Formal
function renderCartaFormal(sale, cfg, opts) {
  const _ef = opts._estilos || {};
  const _fsf = _ef.fontSize    || '11pt';
  const _mtf = _ef.marginTop   || '15mm';
  const _mbf = _ef.marginBottom|| '15mm';
  const _mlf = _ef.marginLeft  || '20mm';
  const _mrf = _ef.marginRight || '20mm';
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';
  const ncf = _getNcf(sale);
  const rows = (sale.items||[]).map((i,idx) => `
    <tr style="${idx%2===0?'background:#f9fafb':''}">
      <td style="padding:8px 12px">${_esc(i.product_name||i.name)}</td>
      <td style="text-align:center;padding:8px">${i.qty}</td>
      <td style="text-align:right;padding:8px 12px">RD$${Number(i.unit_price||0).toLocaleString('es-DO')}</td>
      <td style="text-align:right;padding:8px 12px;font-weight:600">RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: letter; margin: 12mm 18mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:12px; color:#111; }
  .header-bar { background:#0d0f12; color:#fff; padding:14px 18px;
                display:flex; justify-content:space-between; align-items:center;
                border-radius:6px; margin-bottom:16px; }
  .biz-name { font-size:18px; font-weight:700; }
  .doc-num { font-size:28px; font-weight:900; }
  .doc-label { font-size:11px; opacity:.7; text-transform:uppercase; }
  .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px; }
  .info-box { background:#f3f4f6; border-radius:6px; padding:10px 14px; }
  .info-box label { font-size:10px; text-transform:uppercase; color:#666; display:block; margin-bottom:2px; }
  table { width:100%; border-collapse:collapse; margin-bottom:14px; }
  thead tr { background:#0d0f12; color:#fff; }
  th { padding:9px 12px; text-align:left; font-size:11px; font-weight:600; }
  td { padding:8px 12px; border-bottom:1px solid #e5e7eb; }
  .totals-box { margin-left:auto; width:240px; background:#f9fafb;
                border-radius:6px; padding:10px 14px; }
  .total-row { display:flex; justify-content:space-between; padding:3px 0; }
  .grand-total { font-size:16px; font-weight:700; border-top:2px solid #000;
                 padding-top:6px; margin-top:4px; }
  img { display:block; max-height:45px; max-width:160px; }
</style></head><body>
  <div class="header-bar">
    <div>
      ${opts.logo && cfg.biz_logo ? `<img src="${cfg.biz_logo}" style="display:block;max-height:45px;max-width:160px;margin:0 0 4px 0;filter:brightness(10)"/><br/>` : ''}
      <div class="biz-name">${_esc(cfg.biz_name||'Mi Negocio')}</div>
      <div style="font-size:11px;opacity:.8">
        ${opts.rnc && cfg.biz_rnc ? `RNC: ${_esc(cfg.biz_rnc)} · ` : ''}${_esc(cfg.biz_addr||'')} · ${_esc(cfg.biz_phone||'')}
      </div>
    </div>
    <div style="text-align:right">
      <div class="doc-label">${_docLabel(sale)}</div>
      <div class="doc-num">#${String(sale.id).padStart(5,'0')}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <label>Cliente</label>
      <strong>${_esc(sale.customer_name||'Consumidor Final')}</strong>
      ${opts.cedula && sale.customer_rnc ? `<br/><span style="font-size:11px;color:#666">RNC/Cédula: ${_esc(sale.customer_rnc)}</span>` : ''}
    </div>
    <div class="info-box">
      <label>Detalles</label>
      <div>Fecha: <strong>${sale.date}</strong></div>
      <div>Cajero: ${_esc(sale.cajero||'')}</div>
      <div>Pago: ${(sale.payment_method||'efectivo').toUpperCase()}</div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th>Descripción</th>
      <th style="text-align:center">Cant.</th>
      <th style="text-align:right">Precio Unit.</th>
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals-box">
    <div class="total-row"><span>Subtotal</span><span>RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</span></div>
    ${sale.discount_amt > 0 ? `<div class="total-row"><span>Descuento ${sale.discount_pct}%</span><span style="color:#dc2626">-RD$${Number(sale.discount_amt).toLocaleString('es-DO')}</span></div>` : ''}
    ${_showItbis(sale) ? `<div class="total-row"><span>ITBIS (${sale.tax_pct||18}%)</span><span>RD$${Number(sale.tax_amt||0).toLocaleString('es-DO')}</span></div>` : ''}
    <div class="total-row grand-total"><span>TOTAL</span><span>RD$${Number(sale.total||0).toLocaleString('es-DO')}</span></div>
  </div>

  ${isDevolucion && sale.original_sale_id ? `<div style="margin-top:8px;font-size:11px;color:#555">Ref. venta original: #${String(sale.original_sale_id).padStart(5,'0')}</div>` : ''}
  ${_showNcf(sale, opts) ? `<div style="margin-top:10px;font-size:11px;background:#fef9c3;padding:6px 10px;border-radius:4px">NCF: <strong>${ncf}</strong> · Documento con validez fiscal</div>` : ''}
  ${isCotizacion ? `<div style="margin-top:8px;font-size:11px;color:#888;font-style:italic;padding:6px 10px;background:#f9fafb;border-radius:4px">Esta cotización no tiene valor fiscal.</div>` : ''}
  ${opts.mensaje && cfg.receipt_msg && !isCotizacion ? `<div style="margin-top:12px;text-align:center;font-size:11px;color:#666">${cfg.receipt_msg}</div>` : ''}
</body></html>`;
}

// Plantilla 6 — NCF Dominicana
function renderCartaNCF(sale, cfg, opts) {
  const _en = opts._estilos || {};
  const _fsn = _en.fontSize    || '10pt';
  const _mtn = _en.marginTop   || '10mm';
  const _mbn = _en.marginBottom|| '10mm';
  const _mln = _en.marginLeft  || '15mm';
  const _mrn = _en.marginRight || '15mm';
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';
  const ncf = _getNcf(sale);
  const rows = (sale.items||[]).map(i => `
    <tr>
      <td style="padding:7px 10px">${_esc(i.product_name||i.name)}</td>
      <td style="text-align:center;padding:7px">${i.qty}</td>
      <td style="text-align:right;padding:7px 10px">RD$${Number(i.unit_price||0).toLocaleString('es-DO')}</td>
      <td style="text-align:right;padding:7px 10px">RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: letter; margin: ${_mtn} ${_mrn} ${_mbn} ${_mln}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:11px; color:#111; }
  .ncf-box { border:3px solid #1a1a1a; border-radius:6px; padding:8px 14px;
             text-align:center; margin-bottom:10px; }
  .ncf-num { font-size:22px; font-weight:900; letter-spacing:2px; }
  .ncf-label { font-size:9px; text-transform:uppercase; color:#555; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; margin:10px 0; font-size:11px; }
  th { background:#1a1a1a; color:#fff; padding:7px 10px; text-align:left; }
  td { padding:6px 10px; border-bottom:1px solid #ddd; }
  .total-section { display:flex; justify-content:flex-end; margin-top:6px; }
  .total-table { width:220px; font-size:11px; }
  .total-table td { padding:3px 8px; }
  .grand { font-size:15px; font-weight:700; border-top:2px solid #000; padding-top:5px; }
  img { display:block; max-height:50px; max-width:180px; }
</style></head><body>
  ${isCotizacion
    ? `<div style="border:2px dashed #aaa;border-radius:6px;padding:8px 14px;text-align:center;margin-bottom:10px">
         <div style="font-size:13px;font-weight:700">COTIZACIÓN</div>
         <div style="font-size:9px;color:#888;text-transform:uppercase">Sin valor fiscal · ${sale.date}</div>
       </div>`
    : `<div class="ncf-box">
         <div class="ncf-label">${isDevolucion ? 'Nota de Devolución' : 'Número de Comprobante Fiscal'}</div>
         <div class="ncf-num">${ncf || '—'}</div>
         <div class="ncf-label">Factura con Valor Fiscal · ${sale.date}</div>
       </div>`
  }

  <div class="header">
    <div>
      ${opts.logo && cfg.biz_logo ? `<img src="${cfg.biz_logo}" style="display:block;max-height:50px;max-width:180px;margin:0 0 4px 0;filter:grayscale(100%) contrast(150%)"/><br/>` : ''}
      <strong style="font-size:14px">${_esc(cfg.biz_name||'Mi Negocio')}</strong><br/>
      RNC: <strong>${_esc(cfg.biz_rnc||'---')}</strong><br/>
      ${_esc(cfg.biz_addr||'')}<br/>Tel: ${_esc(cfg.biz_phone||'')}
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#666">Factura No.</div>
      <div style="font-size:20px;font-weight:700">#${String(sale.id).padStart(5,'0')}</div>
      <div>Cajero: ${_esc(sale.cajero||'')}</div>
      <div>Método: ${(sale.payment_method||'efectivo').toUpperCase()}</div>
    </div>
  </div>

  <div style="background:#f3f4f6;padding:7px 12px;border-radius:4px;margin-bottom:8px">
    <strong>Cliente:</strong> ${_esc(sale.customer_name||'Consumidor Final')}
    ${opts.cedula && sale.customer_rnc ? ` &nbsp;|&nbsp; <strong>RNC/Cédula:</strong> ${_esc(sale.customer_rnc)}` : ''}
  </div>

  <table>
    <thead><tr>
      <th>Descripción</th><th style="text-align:center">Cant.</th>
      <th style="text-align:right">Precio</th><th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total-section">
    <table class="total-table">
      <tr><td>Subtotal</td><td style="text-align:right">RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</td></tr>
      ${sale.discount_amt > 0 ? `<tr><td>Descuento (${sale.discount_pct}%)</td><td style="text-align:right;color:red">-RD$${Number(sale.discount_amt).toLocaleString('es-DO')}</td></tr>` : ''}
      ${_showItbis(sale) ? `<tr><td>ITBIS (${sale.tax_pct||18}%)</td><td style="text-align:right">RD$${Number(sale.tax_amt||0).toLocaleString('es-DO')}</td></tr>` : ''}
      <tr class="grand"><td>TOTAL</td><td style="text-align:right">RD$${Number(sale.total||0).toLocaleString('es-DO')}</td></tr>
    </table>
  </div>

  ${isDevolucion && sale.original_sale_id ? `<div style="margin-top:6px;font-size:11px;color:#555">Ref. venta original: #${String(sale.original_sale_id).padStart(5,'0')}</div>` : ''}
  <div style="margin-top:10px;font-size:10px;color:#666;text-align:center;border-top:1px solid #ddd;padding-top:8px">
    ${isCotizacion
      ? 'Esta cotización no tiene valor fiscal.'
      : `Este documento es un Comprobante Fiscal válido ante la DGII · ${cfg.receipt_msg||''}`}
  </div>
</body></html>`;
}

// Plantilla 7 — Media Carta
function renderMediaCarta(sale, cfg, opts) {
  // Media carta = mitad de hoja carta, diseño compacto
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const ncf = _getNcf(sale);
  const rows = (sale.items||[]).map(i => `
    <tr>
      <td style="padding:5px 8px;font-size:10px">${_esc(i.product_name||i.name)}</td>
      <td style="text-align:center;padding:5px;font-size:10px">${i.qty}</td>
      <td style="text-align:right;padding:5px 8px;font-size:10px">RD$${(Number(i.unit_price||0)*Number(i.qty||1)).toLocaleString('es-DO')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: 5.5in 4.25in; margin: 6mm 10mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:10px; color:#111; }
  .header { display:flex; justify-content:space-between; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; }
  th { background:#111; color:#fff; padding:5px 8px; font-size:9px; text-align:left; }
  td { border-bottom:1px solid #eee; }
  .totals { margin-left:auto; width:180px; margin-top:5px; }
  img { display:block; max-height:35px; max-width:140px; }
</style></head><body>
  <div class="header">
    <div>
      ${opts.logo && cfg.biz_logo ? `<img src="${cfg.biz_logo}" style="display:block;max-height:35px;max-width:140px;margin:0 0 3px 0;filter:grayscale(100%) contrast(150%)"/><br/>` : ''}
      <strong style="font-size:12px">${_esc(cfg.biz_name||'Mi Negocio')}</strong><br/>
      ${opts.rnc && cfg.biz_rnc ? `RNC: ${_esc(cfg.biz_rnc)}<br/>` : ''}
      ${_esc(cfg.biz_addr||'')} · Tel: ${_esc(cfg.biz_phone||'')}
    </div>
    <div style="text-align:right">
      <strong style="font-size:14px">#${String(sale.id).padStart(5,'0')}</strong><br/>
      ${sale.date}<br/>
      ${_docLabel(sale)}
    </div>
  </div>
  <div style="background:#f3f4f6;padding:4px 8px;margin-bottom:6px;border-radius:3px;font-size:10px">
    Cliente: <strong>${_esc(sale.customer_name||'Consumidor Final')}</strong>
  </div>
  <table>
    <thead><tr><th>Producto</th><th style="text-align:center">Q</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td style="padding:3px">Subtotal</td><td style="text-align:right;padding:3px">RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</td></tr>
    ${_showItbis(sale) ? `<tr><td style="padding:3px">ITBIS (${sale.tax_pct||18}%)</td><td style="text-align:right;padding:3px">RD$${Number(sale.tax_amt||0).toLocaleString('es-DO')}</td></tr>` : ''}
    <tr style="font-size:13px;font-weight:700;border-top:2px solid #000">
      <td style="padding:4px">TOTAL</td>
      <td style="text-align:right;padding:4px">RD$${Number(sale.total||0).toLocaleString('es-DO')}</td>
    </tr>
  </table>
  ${_showNcf(sale, opts) ? `<div style="font-size:9px;color:#555;margin-top:4px">NCF: ${ncf}</div>` : ''}
  ${isCotizacion ? `<div style="font-size:9px;color:#888;font-style:italic;margin-top:2px">Sin valor fiscal</div>` : ''}
  <div style="text-align:center;font-size:9px;color:#666;margin-top:6px">
    ${sale.payment_method||'EFECTIVO'} · ${opts.mensaje && cfg.receipt_msg && !isCotizacion ? cfg.receipt_msg : 'Gracias por su compra'}
  </div>
</body></html>`;
}
