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
  if (typeof resolvePrinterProfile === 'function') {
    return printerProfileLegacyType(resolvePrinterProfile(printerName, 'ticket'));
  }
  // Override explícito del usuario (Configuración → Impresora → Tipo).
  // Tiene prioridad sobre la auto-detección: evita que una impresora láser/carta
  // con nombre no reconocido caiga al default '80mm' (térmica) y reciba trabajos
  // de 80mm en silencio → hojas en blanco.
  try {
    const forced = (typeof DB !== 'undefined' && DB?.settings?.printer_type) ||
                   (typeof CFG !== 'undefined' && CFG?.printer_type) || '';
    if (['58mm', '72mm', '80mm', '108mm', 'carta'].includes(forced)) return forced;
  } catch {}

  if (!printerName) return 'unknown';
  const n = printerName.toLowerCase();

  if (/58|mini|port|pocket|handheld|bt.*print|print.*bt/.test(n)) return '58mm';

  if (/2\s*connect|2c[-_ ]?lp427|lp[-_ ]?427/.test(n)) return '108mm';
  if (/72\s*mm/.test(n)) return '72mm';
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

  // ═══════════════ 72mm ═══════════════
  // Para papel térmico de 72mm o impresoras de 80mm cuya área imprimible real
  // es ~72mm (los bordes salían recortados con las plantillas de 80). El
  // contenido se renderiza a 68mm, con margen de seguridad en ambos casos.
  {
    id:        'termica_72_clasica',
    nombre:    'Clásica 72mm',
    tipo:      '72mm',
    icono:     '🧾',
    desc:      'Ticket térmico para papel de 72mm (o impresoras de 80mm que recortan los bordes).',
    opciones: {
      logo: true, rnc: true, ncf: true, mensaje: true,
      cedula: true, codigoBarra: false,
    },
    render: (sale, cfg, opts) => renderTermica(sale, cfg, opts, 68),
  },

  // ═══════════════ Carta/A4 ═══════════════
  {
    id:        'carta_recibo',
    nombre:    'Factura A4 Moderna',
    tipo:      'carta',
    icono:     '📄',
    desc:      'Factura A4/Carta moderna, compacta y modular. Soporta muchos artículos, dos logos, contado/crédito/abono y datos bancarios. Ideal para PDF e impresión física.',
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

function getPlantilla(id) {
  return PLANTILLAS.find(p => p.id === id) || PLANTILLAS[1]; // default: clásica 80mm
}

// ── Datos de muestra para vista previa ────────
function getSampleSale(cfg) {
  const _tp = 18;
  return {
    id:             1,
    customer_id:    191,
    type:           'factura',
    date:           new Date().toISOString().split('T')[0],
    time:           new Date().toLocaleTimeString('es-DO', { hour:'2-digit', minute:'2-digit' }),
    due_date:       new Date(Date.now() + 30*86400000).toISOString().split('T')[0],
    customer_name:  'Cliente Ejemplo S.R.L.',
    customer_rnc:   '130-12345-6',
    customer_address:'Calle Duarte #45, Local 1, Santiago',
    customer_phone: '(809) 000-0000',
    customer_email: 'ventas@cliente.com',
    customer_type: 'company',
    customer_trade_name: 'Cliente Ejemplo',
    customer_contact_name: 'María Rodríguez',
    customer_contact_role: 'Encargada de compras',
    customer_contact_phone: '(809) 555-0101',
    cajero:         'Cajero Demo',
    // NCF de muestra (solo para la vista previa) — deriva "B01 Crédito Fiscal"
	    ncf:            'B0100000237',
	    items: [
	      { product_code: 'SRV-001', product_name: 'Servicio de instalación y configuración del sistema', qty: 1, unit_price: 472, subtotal: 472, tax_pct: 18, tax_amt: 72, net_subtotal: 400, taxable: 1 },
	      { product_code: 'SRV-002', product_name: 'Migración y validación de datos iniciales',           qty: 2, unit_price: 177, subtotal: 354, tax_pct: 18, tax_amt: 54, net_subtotal: 300, taxable: 1 },
	      { product_code: 'SRV-003', product_name: 'Soporte técnico y ajustes de plantilla A4',           qty: 1, unit_price: 47.20, subtotal: 47.20, tax_pct: 18, tax_amt: 7.20, net_subtotal: 40, taxable: 1 },
	    ],
	    subtotal:        740,
    discount_pct:    0,
    discount_amt:    0,
    tax_pct:         _tp,
    tax_amt:         133.20,
    total:           873.20,
    payment_method:  'transferencia',
  };
}

// ══════════════════════════════════════════════
// HELPER — NCF y tipo de documento
// ══════════════════════════════════════════════

// Devuelve el NCF real de la venta, o string vacío si no aplica.
// NUNCA fabricar uno: el NCF real ya se asigna y registra en ncf_log
// al crear la venta (database.js). Inventar uno aquí imprimiría un
// comprobante fiscal que no existe en el sistema.
function _getNcf(sale) {
  if (sale.type !== 'factura') return '';
  return (sale.ncf && sale.ncf.trim()) ? sale.ncf.trim() : '';
}

// Etiqueta del tipo de documento
function _docLabel(sale) {
  if (sale.type === 'cotizacion') return 'COTIZACIÓN';
  if (sale.type === 'devolucion') return 'NOTA DE DEVOLUCIÓN';
  if (sale.type === 'factura')    return 'FACTURA';
  return 'RECIBO DE COMPRA';
}

function _lineGross(i) {
  const qty = Number(i.qty || 1);
  if (i.subtotal !== undefined && i.subtotal !== null) return Number(i.subtotal || 0);
  return Number(i.unit_price || i.price || 0) * qty;
}

function _lineTax(i, sale) {
  if (i.tax_amt !== undefined && i.tax_amt !== null) return Number(i.tax_amt || 0);
  if (i.taxable === 0 || i.taxable === false || i.taxable === '0') return 0;
  const taxPct = Number(i.tax_pct != null ? i.tax_pct : (sale?.tax_pct != null ? sale.tax_pct : 0));
  if (!taxPct || taxPct <= 0) return 0;
  // Línea legacy/importada sin desglose guardado: el precio es FINAL con ITBIS
  // INCLUIDO (convención del sistema y del POS viejo). El impuesto se EXTRAE del
  // precio (1,200 = 1,016.95 + 183.05) — nunca se suma encima, o la reimpresión
  // inflaría el total realmente cobrado (1,200 → 1,416).
  const gross = _lineGross(i);
  return gross - (gross / (1 + taxPct / 100));
}

function _lineNet(i, sale) {
  if (i.net_subtotal !== undefined && i.net_subtotal !== null) return Number(i.net_subtotal || 0);
  return _lineGross(i) - _lineTax(i, sale);
}

function _lineNetUnit(i, sale) {
  const qty = Number(i.qty || 1) || 1;
  return _lineNet(i, sale) / qty;
}

function _lineImporte(i, sale) {
  return _lineNet(i, sale) + _lineTax(i, sale);
}

function _sumLines(sale, fn) {
  return (sale.items || []).reduce((sum, item) => sum + Number(fn(item, sale) || 0), 0);
}

function _displayTaxAmt(sale) {
  const headerTax = Number(sale.tax_amt || sale.itbis || 0);
  if (headerTax > 0) return headerTax;
  if (sale.type !== 'factura') return 0;
  return _sumLines(sale, _lineTax);
}

function _displaySubtotal(sale) {
  const headerSubtotal = Number(sale.subtotal || 0);
  const headerTax = Number(sale.tax_amt || sale.itbis || 0);
  // Con ITBIS en cabecera, el subtotal guardado ya es neto y coherente.
  if (headerSubtotal > 0 && (headerTax > 0 || sale.type !== 'factura')) return headerSubtotal;
  // Legacy/importada: si el ITBIS se extrae de las líneas, el subtotal guardado
  // suele ser el bruto (= total) — el neto real sale de las líneas.
  const lineTax = _sumLines(sale, _lineTax);
  if (lineTax > 0) return _sumLines(sale, _lineNet);
  return headerSubtotal > 0 ? headerSubtotal : _sumLines(sale, _lineNet);
}

function _displayDiscount(sale) {
  return Number(sale.discount_amt || sale.discAmt || 0);
}

function _displayTotal(sale) {
  // El total guardado es lo que el cliente pagó realmente — es la autoridad.
  // Reinterpretar el ITBIS (incluido vs añadido) jamás debe cambiar el total.
  const headerTotal = Number(sale.total || 0);
  if (headerTotal > 0) return headerTotal;
  return _displaySubtotal(sale) - _displayDiscount(sale) + _displayTaxAmt(sale);
}

// ¿Mostrar ITBIS? En facturas con ITBIS guardado o calculable desde líneas legacy.
function _showItbis(sale) {
  return sale.type === 'factura' && _displayTaxAmt(sale) > 0;
}

// ¿Imprimir la columna "Código" de los artículos? Configurable por negocio:
// settings.print_item_code = '0' la oculta SOLO en los documentos impresos
// (dentro del sistema el código siempre se ve).
function _showCode(cfg) {
  return (cfg?.print_item_code ?? '1') !== '0';
}

function _receiptNumber(sale) {
  return sale.receipt_number || sale.last_receipt_number || sale.numero_recibo
    || sale.receipt_numbers || sale._recibos || '';
}

function _paidAmount(sale) {
  if (sale.payment_amount != null) return Number(sale.payment_amount || 0);
  if (sale.paid_amount != null) return Number(sale.paid_amount || 0);
  if ((sale.payment_method || '').toLowerCase() !== 'credito' && sale.type === 'factura') {
    return _displayTotal(sale);
  }
  return 0;
}

function _balanceAfterPayment(sale) {
  if (sale.balance_after_payment != null) return Number(sale.balance_after_payment || 0);
  if (sale.balance_after != null) return Number(sale.balance_after || 0);
  if ((sale.payment_method || '').toLowerCase() !== 'credito' && sale.type === 'factura') return 0;
  return Math.max(0, _displayTotal(sale) - _paidAmount(sale));
}

function _paymentStatusLabel(sale) {
  if (sale.status === 'cancelled') return 'Anulada';
  if (sale.type === 'cotizacion') return 'Pendiente';
  if (sale.type === 'devolucion') return 'Aplicada';
  if (_balanceAfterPayment(sale) <= 0.005 && _paidAmount(sale) > 0) return 'Pagada';
  if ((sale.payment_method || '').toLowerCase() !== 'credito' && sale.type === 'factura') return 'Pagada';
  return 'Pendiente';
}

// ¿Mostrar NCF? Solo en facturas con NCF disponible
function _showNcf(sale, opts) {
  return opts.ncf && sale.type === 'factura' && _getNcf(sale) !== '';
}

// ══════════════════════════════════════════════
// HELPERS MODULARES — Plantilla A4 moderna
// ══════════════════════════════════════════════

// Número de dos decimales estilo es-DO ("1,234.50")
function _n2(x) {
  return Number(x || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Tipo de comprobante fiscal derivado del NCF / e-CF (prefijo).
// NUNCA inventa: si no hay NCF real, devuelve ''.
function _tipoComprobante(ncf) {
  const n = (ncf || '').trim().toUpperCase();
  if (!n) return '';
  const p = n.slice(0, 3);
  const MAP = {
    B01: 'B01 Crédito Fiscal', B02: 'B02 Consumo', B03: 'B03 Nota de Débito',
    B04: 'B04 Nota de Crédito', B11: 'B11 Comprobante de Compras',
    B12: 'B12 Registro Único de Ingresos', B13: 'B13 Gastos Menores',
    B14: 'B14 Régimen Especial', B15: 'B15 Gubernamental',
    B16: 'B16 Exportaciones', B17: 'B17 Pagos al Exterior',
    E31: 'E31 e-CF Crédito Fiscal', E32: 'E32 e-CF Consumo',
    E34: 'E34 e-CF Nota de Crédito', E44: 'E44 e-CF Régimen Especial',
    E45: 'E45 e-CF Gubernamental',
  };
  return MAP[p] || (n.startsWith('E') ? `${p} e-CF` : p);
}

// Etiqueta legible del método de pago
function _metodoPagoLabel(m) {
  const map = {
    efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta',
    cheque: 'Cheque', credito: 'Crédito', deposito: 'Depósito', mixto: 'Mixto', otro: 'Otro',
  };
  const k = (m || '').toLowerCase();
  return map[k] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : 'Efectivo');
}

function _pagoDetalleLabel(sale) {
  const method = (sale?.payment_method || '').toLowerCase();
  if (method !== 'tarjeta') return _metodoPagoLabel(method);
  const brand = String(sale?.card_brand || '').trim();
  const last4 = String(sale?.card_last4 || '').replace(/\D/g, '').slice(-4);
  return `Tarjeta${brand ? ' ' + brand : ''}${last4 ? ' •••• ' + last4 : ''}`;
}

function _pagoResumenTexto(sale) {
  const parts = [_pagoDetalleLabel(sale)];
  if (String(sale?.payment_currency || '').toUpperCase() === 'USD' && Number(sale?.account_amount) > 0) {
    const usd = Number(sale.account_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    parts.push(`US$${usd} @ RD$${Number(sale.exchange_rate || 0).toFixed(2)}`);
  }
  if (sale?.payment_reference) {
    parts.push(`${String(sale.payment_method).toLowerCase() === 'tarjeta' ? 'Aut.' : 'Ref.'} ${sale.payment_reference}`);
  }
  return parts.join(' · ');
}

// ¿El método de pago implica datos bancarios?
function _esPagoBancario(m) {
  // Tarjeta muestra marca/autorización; la cuenta de liquidación es interna y no
  // debe imprimirse como si el cliente hubiese realizado una transferencia.
  return ['transferencia', 'deposito', 'cheque'].includes((m || '').toLowerCase());
}

// Texto de una cuenta registrada (Bancos y Cuentas) para la factura.
function _a4CuentaText(acc) {
  if (!acc) return '';
  const parts = [];
  if (acc.bank_name) parts.push(`Banco: <small>${_esc(acc.bank_name)}</small>`);
  const sub = { ahorros: 'Ahorros', corriente: 'Corriente' }[acc.account_subtype] || '';
  if (acc.account_number) parts.push(`Cuenta${sub ? ' ' + sub : ''}: <small>${_esc(acc.account_number)}</small>`);
  else if (sub) parts.push(`Tipo: <small>${sub}</small>`);
  if (acc.currency && acc.currency !== 'DOP') parts.push(`Moneda: <small>${_esc(acc.currency)}</small>`);
  // El nombre de la cuenta suele ser el titular en estos negocios.
  if (acc.name) parts.push(`Titular: <small>${_esc(acc.name)}</small>`);
  return parts.join(' &nbsp;·&nbsp; ');
}

// Distingue el documento del cliente por longitud (formato RD):
//   · 9 dígitos  → RNC    (persona jurídica / empresa)
//   · 11 dígitos → Cédula (persona física)
//   · otro       → genérico "RNC/Céd." (dato incompleto o extranjero)
function _docKind(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 9)  return { label: 'RNC',      digits: d, kind: 'rnc' };
  if (d.length === 11) return { label: 'Cédula',   digits: d, kind: 'cedula' };
  return { label: 'RNC/Céd.', digits: d, kind: 'unknown' };
}

// Tipo de facturación: Contado / Crédito / Abono
function _tipoFacturacion(sale) {
  if (sale.type === 'abono') return 'Abono';
  if ((sale.payment_method || '').toLowerCase() === 'credito') return 'Crédito';
  return 'Contado';
}

// Título dinámico del documento A4
function _a4DocTitle(sale) {
  switch (sale.type) {
    case 'cotizacion': return 'COTIZACIÓN';
    case 'devolucion': return 'NOTA DE DEVOLUCIÓN';
    case 'abono':      return 'RECIBO DE ABONO';
    case 'conduce':    return 'CONDUCE';
    case 'reporte':    return 'REPORTE';
    case 'factura':    return 'FACTURA';
    default:           return 'RECIBO';
  }
}

// Fecha larga legible: "miércoles, 08 julio 2026". Cae a la fecha cruda si falla.
function _fechaLarga(d) {
  try {
    const dt = new Date(`${String(d).slice(0, 10)}T12:00:00`);
    if (isNaN(dt)) return _esc(d || '');
    return dt.toLocaleDateString('es-DO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  } catch { return _esc(d || ''); }
}
function _fechaCorta(d) {
  try {
    const dt = new Date(`${String(d).slice(0, 10)}T12:00:00`);
    if (isNaN(dt)) return _esc(d || '');
    return dt.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return _esc(d || ''); }
}

// Íconos SVG monocromos en línea (imprimen bien, sin recursos externos)
function _a4ic(type) {
  const s = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  const P = {
    doc:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    cal:  '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    pay:  '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    bank: '<path d="M3 21h18"/><path d="M5 21V10M9 21V10M15 21V10M19 21V10"/><path d="M12 3l9 5H3z"/>',
    ref:  '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  };
  return `<svg ${s}>${P[type] || P.doc}</svg>`;
}

// ══════════════════════════════════════════════
// RENDERIZADORES DE PLANTILLAS
// ══════════════════════════════════════════════

function _termicaHeader(cfg, opts, widthMm) {
  const cols = widthMm <= 52 ? 32 : 42;
  const sep  = '─'.repeat(cols);
  const lines = [];

  if (opts.logo) {
    const logoHdr = buildLogoHeader(cfg.biz_logo, cfg.biz_logo_2, {
      unit: 'mm', maxW: widthMm - 4, maxH: 14, align: 'center', marginBottom: 4,
      filter: 'grayscale(100%) contrast(150%)',
    });
    if (logoHdr) lines.push(logoHdr);
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
  ${isDevolucion && sale.original_sale_id ? `<div style="text-align:center">Ref. venta ${facturaLabelOriginal(sale)}</div>` : ''}
  <div style="text-align:center">${sep}</div>
  <div style="display:flex;justify-content:space-between">
    <span>No.: ${facturaLabel(sale)}</span>
    <span>Fecha: ${sale.date}</span>
  </div>
  <div style="display:flex;justify-content:space-between">
    <span>Hora: ${sale.time}</span>
    <span>Cajero: ${_esc((sale.cajero||'').split(' ')[0])}</span>
  </div>
  ${sale.salesperson_name ? `<div style="display:flex;justify-content:space-between"><span>Vendedor:</span><span>${_esc((sale.salesperson_code ? sale.salesperson_code + ' · ' : '') + sale.salesperson_name)}</span></div>` : ''}
  <div style="display:flex;justify-content:space-between">
    <span>Cliente:</span>
    <span>${_esc(sale.customer_name||'Consumidor Final')}</span>
  </div>
  ${opts.cedula && sale.customer_rnc ? `<div style="display:flex;justify-content:space-between"><span>Cédula/RNC:</span><span>${_esc(sale.customer_rnc)}</span></div>` : ''}
  ${sale.customer_contact_name ? `<div style="display:flex;justify-content:space-between"><span>Solicitado por:</span><span>${_esc(sale.customer_contact_name)}${sale.customer_contact_role ? ` · ${_esc(sale.customer_contact_role)}` : ''}</span></div>` : ''}
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
  ${sale.discount_amt > 0 ? `<div style="display:flex;justify-content:space-between"><span>Descuento (${Math.round((sale.discount_pct||0)*100)/100}%):</span><span>-RD$${Number(sale.discount_amt).toLocaleString('es-DO')}</span></div>` : ''}
  ${_showItbis(sale) ? `<div style="display:flex;justify-content:space-between"><span>ITBIS (${sale.tax_pct||18}%):</span><span>RD$${(Math.round(_displayTaxAmt(sale)*100)/100).toLocaleString('es-DO')}</span></div>` : ''}
  <div style="text-align:center">${sepD}</div>
  <div style="display:flex;justify-content:space-between;font-weight:700;font-size:${widthMm<=52?'12px':'13px'}">
    <span>TOTAL:</span><span>RD$${Number(sale.total||0).toLocaleString('es-DO')}</span>
  </div>
  <div style="text-align:center">${sepD}</div>
  ${sale.payment_method === 'mixto' ? `
  <div style="display:flex;justify-content:space-between"><span>Método:</span><span>MIXTO</span></div>
  ${sale.mix_efec > 0 ? `<div style="display:flex;justify-content:space-between"><span>  Efectivo:</span><span>RD$${Number(sale.mix_efec).toLocaleString('es-DO')}</span></div>` : ''}
  ${sale.mix_card > 0 ? `<div style="display:flex;justify-content:space-between"><span>  Tarjeta/Trans.:</span><span>RD$${Number(sale.mix_card).toLocaleString('es-DO')}</span></div>` : ''}
  ` : `<div style="display:flex;justify-content:space-between"><span>Método de pago:</span><span>${_esc(_pagoResumenTexto(sale))}</span></div>`}
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
  ${opts.logo ? buildLogoHeader(cfg.biz_logo, cfg.biz_logo_2, { unit:'mm', maxW:widthMm-4, maxH:14, align:'center', marginBottom:4, filter:'grayscale(100%) contrast(150%)' }) : ''}
  <div class="title">${_esc(cfg.biz_name||'Mi Negocio')}</div>
  ${opts.rnc && cfg.biz_rnc ? `<div class="center" style="font-size:10px">RNC: ${_esc(cfg.biz_rnc)}</div>` : ''}
  ${cfg.biz_addr ? `<div class="center" style="font-size:10px">${_esc(cfg.biz_addr)} · Tel: ${_esc(cfg.biz_phone||'')}</div>` : ''}
  <hr class="sep-d"/>
  <div class="center" style="font-size:13px;font-weight:700;letter-spacing:1px">
    ◆ ${_docLabel(sale)} ◆
    ${isDevolucion && sale.original_sale_id ? `<div style="font-size:10px;text-align:center">Ref. venta ${facturaLabelOriginal(sale)}</div>` : ''}
  </div>
  <hr class="sep"/>
  <div class="row"><span>No.:</span><span style="font-weight:700">${facturaLabel(sale)}</span></div>
  <div class="row"><span>Fecha:</span><span>${sale.date} ${sale.time}</span></div>
  <div class="row"><span>Cliente:</span><span>${_esc(sale.customer_name||'Consumidor Final')}</span></div>
  ${sale.customer_contact_name ? `<div class="row"><span>Solicitado por:</span><span>${_esc(sale.customer_contact_name)}${sale.customer_contact_role ? ` · ${_esc(sale.customer_contact_role)}` : ''}</span></div>` : ''}
  <div class="row"><span>Cajero:</span><span>${_esc(sale.cajero||'')}</span></div>
  ${sale.salesperson_name ? `<div class="row"><span>Vendedor:</span><span>${_esc((sale.salesperson_code ? sale.salesperson_code + ' · ' : '') + sale.salesperson_name)}</span></div>` : ''}
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
  ${_showItbis(sale) ? `<div class="row"><span>ITBIS (${sale.tax_pct||18}%)</span><span>RD$${(Math.round(_displayTaxAmt(sale)*100)/100).toLocaleString('es-DO')}</span></div>` : ''}
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
  ` : `<div class="row"><span>Forma de pago:</span><span>${_esc(_pagoResumenTexto(sale))}</span></div>`}
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
  <div style="text-align:center;font-size:9px;margin-bottom:4px">${sale.date} ${sale.time} · ${facturaLabel(sale)}</div>
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
  <div style="text-align:center;font-size:9px;margin-top:3px">${_esc(_pagoResumenTexto(sale))} · ${isCotizacion ? 'Cotización sin valor fiscal' : 'Gracias'}</div>
</body></html>`;
}

// Plantilla 4 — Factura A4 Moderna (modular, compacta, paginable)
// Reemplaza la antigua "Recibo Simple". Título dinámico por tipo de documento,
// franja modular de campos condicionales, tabla protagonista, totales compactos.
function renderCartaRecibo(sale, cfg, opts) {
  const _ec  = opts._estilos || {};
  const _mtc = _ec.marginTop    || '12mm';
  const _mbc = _ec.marginBottom || '10mm';
  const _mlc = _ec.marginLeft   || '12mm';
  const _mrc = _ec.marginRight  || '12mm';

  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';
  const isAbono      = sale.type === 'abono';
  const isConduce    = sale.type === 'conduce';
  const isReporte    = sale.type === 'reporte';

  const ncf       = _getNcf(sale);
  const method    = (sale.payment_method || 'efectivo').toLowerCase();
  const paymentLabel = _pagoDetalleLabel(sale);
  const showTax   = _showItbis(sale);
  const taxPct    = Number(sale.tax_pct != null ? sale.tax_pct : 18);
  const displaySubtotal = _displaySubtotal(sale);
  const displayTax      = _displayTaxAmt(sale);
  const displayDiscount = _displayDiscount(sale);
  const displayTotal    = _displayTotal(sale);
  const paidAmount      = _paidAmount(sale);
  const balanceAfter    = _balanceAfterPayment(sale);
  const receiptNo       = _receiptNumber(sale);
  const statusLabel     = _paymentStatusLabel(sale);
  // Documentos monetarios (todos menos conduce/reporte sin importe)
  const showMoney = !isConduce && !isReporte;

  const paidReceipt = isFactura && statusLabel === 'Pagada';
  const docWord   = paidReceipt ? 'RECIBO DE PAGO' : _a4DocTitle(sale);
  const docNum    = facturaLabel(sale).replace(/^#/, '');
  const showNum   = !isReporte;

  // ── Filas de artículos ──────────────────────────────
  const showCode = _showCode(cfg);
  const rows = (sale.items || []).map((i, idx) => {
    const qty   = Number(i.qty || 1);
    const code  = i.product_code || i.code || i.sku || '—';
    const unitNet = showTax ? _lineNetUnit(i, sale) : Number(i.unit_price || i.price || 0);
    const lineNet = showTax ? _lineNet(i, sale) : (qty * unitNet);
    const lineTax = showTax ? _lineTax(i, sale) : 0;
    const importe = showTax ? _lineImporte(i, sale) : (qty * unitNet);
    return `
    <tr>
      ${showCode ? `<td class="c-code">${_esc(code)}</td>` : ''}
      <td class="c-desc">${_esc(i.product_name || i.name || '')}</td>
      ${showMoney ? `<td class="c-num">${_n2(unitNet)}</td>` : ''}
      <td class="c-num">${qty.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      ${showMoney ? `<td class="c-num">${_n2(lineNet)}</td>
      ${showTax ? `<td class="c-num">${_n2(lineTax)}</td>` : ''}
      <td class="c-num it-total">${_n2(importe)}</td>` : ''}
    </tr>`;
  }).join('');

  // ── Franja modular de campos condicionales ──────────
  const cells = [];
  if (_showNcf(sale, opts)) {
    cells.push(`<div class="cell"><span class="ic">${_a4ic('doc')}</span><div><div class="k">Comprobante fiscal</div><div class="v">${_esc(_tipoComprobante(ncf))}</div><div class="v" style="margin-top:2px"><small>NCF: ${_esc(ncf)}</small></div></div></div>`);
  }
  if (showMoney && !isCotizacion) {
    cells.push(`<div class="cell"><span class="ic">${_a4ic('card')}</span><div><div class="k">Tipo de facturación</div><div class="v">${_tipoFacturacion(sale)}</div></div></div>`);
  }
  if (method === 'credito' && sale.due_date) {
    cells.push(`<div class="cell"><span class="ic">${_a4ic('cal')}</span><div><div class="k">Vencimiento</div><div class="v">${_fechaCorta(sale.due_date)}</div></div></div>`);
  }
  if (showMoney) {
    cells.push(`<div class="cell"><span class="ic">${_a4ic('pay')}</span><div><div class="k">Método de pago</div><div class="v">${_esc(paymentLabel)}</div></div></div>`);
  }
  if (showMoney && method === 'tarjeta' && sale.payment_reference) {
    cells.push(`<div class="cell"><span class="ic">${_a4ic('ref')}</span><div><div class="k">Autorización de tarjeta</div><div class="v">${_esc(sale.payment_reference)}</div></div></div>`);
  }
  if (showMoney && method === 'transferencia' && sale.payment_reference) {
    cells.push(`<div class="cell"><span class="ic">${_a4ic('ref')}</span><div><div class="k">Referencia bancaria</div><div class="v">${_esc(sale.payment_reference)}</div></div></div>`);
  }
  if (showMoney && String(sale.payment_currency || '').toUpperCase() === 'USD' && Number(sale.account_amount) > 0) {
    const usd = Number(sale.account_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const rate = Number(sale.exchange_rate || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    cells.push(`<div class="cell cell-wide"><span class="ic">${_a4ic('pay')}</span><div><div class="k">Pago recibido en dólares</div><div class="v">US$${usd} <small>· Tasa RD$${rate} por US$1 · Base fiscal RD$${_n2(sale.total)}</small></div></div></div>`);
  }
  if (isAbono && (sale.original_sale_id || sale.applied_invoice)) {
    const ap = sale.applied_invoice || facturaLabelOriginal(sale);
    cells.push(`<div class="cell"><span class="ic">${_a4ic('ref')}</span><div><div class="k">Factura aplicada</div><div class="v">${_esc(ap)}</div></div></div>`);
  }
  // Datos bancarios en el strip — SOLO para pago bancario contado (transferencia/
  // depósito/cheque). Preferir la cuenta registrada que recibió el pago;
  // si no hay, caer a los datos bancarios de Configuración (compatibilidad).
  // El crédito NO va aquí: sus cuentas se listan completas al pie (ver abajo).
  const bankAccounts = Array.isArray(cfg.bank_accounts) ? cfg.bank_accounts : [];
  const saleAccount  = sale.financial_account_id
    ? bankAccounts.find(a => Number(a.id) === Number(sale.financial_account_id))
    : null;
  const hasCfgBank = cfg.biz_bank_name || cfg.biz_bank_account || cfg.biz_bank_iban;
  if (_esPagoBancario(method) && method !== 'credito') {
    if (saleAccount) {
      const line1 = _a4CuentaText(saleAccount);
      cells.push(`<div class="cell cell-wide"><span class="ic">${_a4ic('bank')}</span><div><div class="k">Cuenta de pago</div><div class="v">${line1}</div></div></div>`);
    } else if (hasCfgBank) {
      const parts = [];
      if (cfg.biz_bank_name)    parts.push(`Banco: <small>${_esc(cfg.biz_bank_name)}</small>`);
      if (cfg.biz_bank_account) parts.push(`Cuenta: <small>${_esc(cfg.biz_bank_account)}</small>`);
      if (cfg.biz_bank_holder)  parts.push(`Titular: <small>${_esc(cfg.biz_bank_holder)}</small>`);
      const line1 = parts.join(' &nbsp;·&nbsp; ');
      const line2 = cfg.biz_bank_iban ? `<div class="v" style="margin-top:2px">IBAN: <small>${_esc(cfg.biz_bank_iban)}</small></div>` : '';
      cells.push(`<div class="cell cell-wide"><span class="ic">${_a4ic('bank')}</span><div><div class="k">Datos bancarios</div><div class="v">${line1}</div>${line2}</div></div>`);
    }
  }
  const strip = cells.length
    ? `<div class="strip">${cells.join('')}</div>` : '';

  // ── Fila resumen compacta ───────────────────────────
  // "Artículos" = total de unidades de la factura (40 unidades de un solo
  // producto → 40). El RNC/cédula NO va aquí: sale en el bloque CLIENTE.
  const totalUnits = (sale.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const sumItems = [
    ['Moneda', 'DOP'],
    ['Líneas', String((sale.items || []).length)],
    ['Fecha', _fechaCorta(sale.date)],
    ['Artículos', Number.isInteger(totalUnits) ? String(totalUnits) : _n2(totalUnits)],
    showMoney ? ['Pago', _esc(paymentLabel)] : ['Tipo', docWord],
    ['Página', '<span class="a4-cur">1</span>/<span class="a4-tot">1</span>'],
  ];
  const summary = `<div class="summary">${sumItems.map(([k, v]) =>
    `<div class="s"><div class="sk">${k}</div><div class="sv">${v}</div></div>`).join('')}</div>`;

  const paySummary = showMoney && !isCotizacion ? `
    <div class="legacy-pay">
      <div><b>Representante</b><span>${_esc(sale.salesperson_name || sale.cajero || '')}</span></div>
      <div><b>Forma de pago</b><span>${_esc(paymentLabel)}</span></div>
      <div><b>Tipo de factura</b><span>${_esc(_tipoFacturacion(sale))}</span></div>
      <div class="lp-wide"><b>Observaciones</b><span>${_esc(sale.notes || 'No aceptamos devoluciones. Cambios solamente antes de 24 horas.')}</span></div>
      <div><b>Número transacción</b><span>${_esc(sale.transaction_number || sale.id || '—')}</span></div>
    </div>` : '';

  // ── Bloque de cliente (campos ocultos si faltan) ────
  const cliLines = [];
  if (opts.cedula && sale.customer_rnc) {
    const _dk = _docKind(sale.customer_rnc);
    cliLines.push(`${_dk.label}: ${_esc(sale.customer_rnc)}`);
  }
  if (sale.customer_address) cliLines.push(_esc(sale.customer_address));
  if (sale.customer_phone)   cliLines.push(_esc(sale.customer_phone));
  if (sale.customer_email)   cliLines.push(_esc(sale.customer_email));
  if (sale.customer_contact_name) {
    cliLines.push(`Solicitado por: ${_esc(sale.customer_contact_name)}${sale.customer_contact_role ? ` · ${_esc(sale.customer_contact_role)}` : ''}`);
  }

  // ── Contacto del negocio ────────────────────────────
  const bizContact = [];
  if (cfg.biz_phone) bizContact.push(`Tel: ${_esc(cfg.biz_phone)}`);
  if (cfg.biz_email) bizContact.push(_esc(cfg.biz_email));

  // ── Cuadro de totales (compacto) ────────────────────
  const totalsBox = showMoney ? `
    <div class="foot-wrap">
      <div class="totals">
        <div class="tr"><span>Sub Total sin impuestos</span><span>${_n2(displaySubtotal)}</span></div>
        ${showTax ? `<div class="tr"><span>Total ITBIS</span><span>${_n2(displayTax)}</span></div>` : ''}
        <div class="tr"><span>Descuento</span><span>${displayDiscount > 0 ? '-' : ''}${_n2(displayDiscount)}</span></div>
        <div class="tr grand"><span>Total con impuestos</span><span>${_n2(displayTotal)}</span></div>
        ${!isCotizacion ? `<div class="tr"><span>Su pago</span><span>${_n2(paidAmount)}</span></div>` : ''}
        ${!isCotizacion ? `<div class="tr"><span>Balance después del pago</span><span>${_n2(balanceAfter)}</span></div>` : ''}
      </div>
    </div>` : '';

  // ── Firma para conduce ──────────────────────────────
  const firma = isConduce ? `
    <div class="sign-row">
      <div class="sign"><div class="sign-line"></div>Entregado por</div>
      <div class="sign"><div class="sign-line"></div>Recibido por</div>
    </div>` : '';

  // ── Cuentas para transferir (ventas a CRÉDITO) ──────
  // En una factura a crédito el cliente pagará después: se listan TODAS las
  // cuentas registradas para que sepa a dónde transferir. Fallback: datos
  // bancarios de Configuración si aún no hay cuentas registradas.
  let cuentasPago = '';
  if (showMoney && method === 'credito') {
    const rowsAcc = bankAccounts.map(a => `<div class="pay-acc">${_a4CuentaText(a)}</div>`);
    if (!rowsAcc.length && hasCfgBank) {
      const p = [];
      if (cfg.biz_bank_name)    p.push(`Banco: <small>${_esc(cfg.biz_bank_name)}</small>`);
      if (cfg.biz_bank_account) p.push(`Cuenta: <small>${_esc(cfg.biz_bank_account)}</small>`);
      if (cfg.biz_bank_holder)  p.push(`Titular: <small>${_esc(cfg.biz_bank_holder)}</small>`);
      if (cfg.biz_bank_iban)    p.push(`IBAN: <small>${_esc(cfg.biz_bank_iban)}</small>`);
      if (p.length) rowsAcc.push(`<div class="pay-acc">${p.join(' &nbsp;·&nbsp; ')}</div>`);
    }
    if (rowsAcc.length) {
      cuentasPago = `<div class="pay-accounts">
        <div class="pay-accounts-t">Cuentas para transferir su pago</div>
        ${rowsAcc.join('')}
      </div>`;
    }
  }

  const footMsg = (opts.mensaje && cfg.receipt_msg && !isCotizacion) ? _esc(cfg.receipt_msg) : '';
  const footWeb = cfg.biz_web ? _esc(cfg.biz_web) : (bizContact.length ? bizContact.join(' · ') : '');
  const noteFiscal = isCotizacion
    ? 'Esta cotización no tiene valor fiscal.'
    : (isDevolucion && sale.original_sale_id ? `Ref. factura original: ${facturaLabelOriginal(sale)}` : '');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  @page { size: letter; margin: ${_mtc} ${_mrc} ${_mbc} ${_mlc}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; color:#1f2430; line-height:1.42; }
  .hdr { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; }
  .hdr-l { flex:1; min-width:0; }
  .hdr-r { width:46%; max-width:330px; }
  .logos { margin-bottom:10px; }
  .biz-name { font-size:16px; font-weight:700; letter-spacing:.2px; }
  .biz-line { font-size:11px; color:#4b5263; margin-top:2px; }
  .biz-contact { font-size:11px; color:#4b5263; margin-top:7px; }
  .biz-contact span { margin-right:16px; }
  .titlebox { border:1px solid #d8dbe3; border-radius:8px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; }
  .titlebox .t { font-size:15px; font-weight:800; letter-spacing:.5px; }
  .titlebox .n { font-size:16px; font-weight:800; }
  .paid-state { text-align:right; font-size:14px; font-weight:800; margin-top:7px; }
  .receipt-line { text-align:right; font-size:11px; color:#4b5263; margin-top:2px; }
  .datebox { border:1px solid #eceef3; border-radius:8px; padding:8px 16px; display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:11px; }
  .datebox b { font-weight:700; }
  .client { margin-top:14px; }
  .client .cl-lbl { font-size:10px; font-weight:700; letter-spacing:1px; color:#8a90a0; }
  .client .cl-name { font-size:13px; font-weight:700; margin-top:3px; }
  .client .cl-line { font-size:11px; color:#4b5263; margin-top:2px; }
  .strip { display:flex; border:1px solid #eceef3; border-radius:8px; overflow:hidden; margin-top:18px; }
  .strip .cell { flex:1; padding:9px 12px; border-left:1px solid #f0f1f5; display:flex; gap:8px; align-items:flex-start; }
  .strip .cell:first-child { border-left:none; }
  .strip .cell-wide { flex:1.7; }
  .strip .ic { color:#9aa0b0; flex-shrink:0; margin-top:1px; }
  .strip .k { font-size:9px; font-weight:700; letter-spacing:.4px; color:#8a90a0; text-transform:uppercase; }
  .strip .v { font-size:11px; font-weight:600; margin-top:3px; }
  .strip .v small { font-weight:400; color:#5b6273; }
  .summary { display:flex; border:1px solid #eceef3; border-radius:8px; overflow:hidden; margin-top:10px; }
  .summary .s { flex:1; padding:7px 6px; text-align:center; border-left:1px solid #f0f1f5; }
  .summary .s:first-child { border-left:none; }
  .summary .sk { font-size:8.5px; font-weight:700; color:#9aa0b0; text-transform:uppercase; letter-spacing:.3px; }
  .summary .sv { font-size:11px; font-weight:600; margin-top:3px; }
  table.items { width:100%; border-collapse:collapse; margin-top:16px; }
  table.items thead { display:table-header-group; }
  table.items th { background:#f4f5f8; font-size:8.8px; font-weight:700; text-transform:uppercase; letter-spacing:.25px; color:#5b6273; padding:8px 7px; text-align:left; border-bottom:1px solid #e4e6ed; }
  table.items td { padding:8px 7px; border-bottom:1px solid #eef0f4; vertical-align:top; font-size:10.5px; }
  table.items tr { break-inside:avoid; page-break-inside:avoid; }
  /* Encabezado y valores numéricos alineados a la derecha (quedan uno bajo el otro) */
  table.items th.c-num, table.items td.c-num { text-align:right; white-space:nowrap; }
  .c-code { width:70px; color:#5b6273; font-family:'Courier New',monospace; font-size:9.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .c-desc { word-break:break-word; }
  /* Anchos fijos para espaciado parejo: [Código,] Artículo, Precio, Cantidad,
     Monto bruto, ITBIS, Importe. En conduce solo existen [Código/]Artículo/Cant.
     Si el código está oculto (print_item_code='0') las columnas corren una posición. */
  table.items th:nth-child(${3 - (showCode ? 0 : 1)}), table.items td:nth-child(${3 - (showCode ? 0 : 1)}) { width:${showMoney ? '84px' : '70px'}; }
  table.items th:nth-child(${4 - (showCode ? 0 : 1)}), table.items td:nth-child(${4 - (showCode ? 0 : 1)}) { width:${showMoney ? '58px' : '78px'}; }
  table.items th:nth-child(${5 - (showCode ? 0 : 1)}), table.items td:nth-child(${5 - (showCode ? 0 : 1)}) { width:92px; }
  table.items th:nth-child(${6 - (showCode ? 0 : 1)}), table.items td:nth-child(${6 - (showCode ? 0 : 1)}) { width:78px; }
  table.items th:nth-child(${7 - (showCode ? 0 : 1)}), table.items td:nth-child(${7 - (showCode ? 0 : 1)}) { width:96px; }
  .it-total { font-weight:700; }
  .foot-wrap { display:flex; justify-content:flex-end; margin-top:16px; break-inside:avoid; page-break-inside:avoid; }
  .totals { width:300px; border:1px solid #eceef3; border-radius:8px; padding:10px 14px; }
  .totals .tr { display:flex; justify-content:space-between; padding:4px 0; font-size:11px; }
  .totals .tr span:first-child { color:#5b6273; }
  .totals .tr.grand { border-top:1.5px solid #cfd3dd; margin-top:5px; padding-top:8px; font-size:14px; font-weight:800; }
  .totals .tr.grand span:first-child { color:#1f2430; }
  .legacy-pay { margin-top:16px; border-top:2px solid #2f3440; border-bottom:2px solid #2f3440; display:grid; grid-template-columns:1fr 1fr 1fr 2fr 1fr; break-inside:avoid; page-break-inside:avoid; }
  .legacy-pay div { padding:7px 8px; text-align:center; border-left:1px solid #d7dae3; }
  .legacy-pay div:first-child { border-left:none; }
  .legacy-pay b { display:block; text-transform:uppercase; font-size:9px; color:#5b6273; margin-bottom:4px; }
  .legacy-pay span { font-size:10.5px; font-weight:600; }
  .legacy-pay .lp-wide span { font-weight:500; }
  .sign-row { display:flex; justify-content:space-around; gap:40px; margin-top:44px; break-inside:avoid; }
  .sign { flex:1; text-align:center; font-size:10px; color:#5b6273; }
  .sign-line { border-top:1px solid #b8bcc8; margin-bottom:6px; }
  .note { margin-top:12px; font-size:10.5px; color:#8a90a0; font-style:italic; }
  .docfoot { margin-top:26px; padding-top:12px; border-top:1px solid #eceef3; text-align:center; color:#8a90a0; font-size:10.5px; break-inside:avoid; }
  .docfoot .sep { margin:0 10px; color:#cfd3dd; }
  img { max-width:100%; height:auto; }
  .pay-accounts { margin-top:12px; border:1px solid #d8dbe3; border-radius:8px; padding:10px 14px; background:#f9fafb; page-break-inside:avoid; }
  .pay-accounts-t { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; color:#4b5263; margin-bottom:6px; }
  .pay-acc { font-size:11px; color:#1f2430; padding:3px 0; border-top:1px solid #eceef3; }
  .pay-acc:first-of-type { border-top:none; }
  .pay-acc small { color:#4b5263; }
</style></head><body>
  <div class="hdr">
    <div class="hdr-l">
      ${opts.logo ? `<div class="logos">${buildLogoHeader(cfg.biz_logo, cfg.biz_logo_2, { unit:'px', maxW:150, maxH:56, align:'left', marginBottom:0 })}</div>` : ''}
      <div class="biz-name">${_esc(cfg.biz_name || 'Mi Negocio')}</div>
      ${opts.rnc && cfg.biz_rnc ? `<div class="biz-line">RNC: ${_esc(cfg.biz_rnc)}</div>` : ''}
      ${cfg.biz_addr ? `<div class="biz-line">${_esc(cfg.biz_addr)}</div>` : ''}
      ${bizContact.length ? `<div class="biz-contact">${bizContact.map(c => `<span>${c}</span>`).join('')}</div>` : ''}
    </div>
    <div class="hdr-r">
      <div class="titlebox">
        <div class="t">${docWord}${showNum && !paidReceipt ? ' N.' : ''}</div>
        ${showNum ? `<div class="n">${paidReceipt ? 'Factura # ' : ''}${_esc(docNum)}</div>` : ''}
      </div>
      <div class="paid-state">${_esc(statusLabel)}</div>
      ${receiptNo ? `<div class="receipt-line">Recibo #: <b>${_esc(receiptNo)}</b></div>` : ''}
      <div class="datebox"><b>Fecha:</b> <span>${_fechaLarga(sale.date)}</span></div>
      ${!isReporte ? `
      <div class="client">
        <div class="cl-lbl">CLIENTE</div>
        <div class="cl-name">${_esc(sale.customer_name || 'Consumidor Final')}</div>
        ${cliLines.map(l => `<div class="cl-line">${l}</div>`).join('')}
      </div>` : ''}
    </div>
  </div>

  ${strip}
  ${summary}

  <table class="items">
    <thead><tr>
      ${showCode ? '<th class="c-code">Código</th>' : ''}
      <th>Nombre artículo</th>
      ${showMoney ? '<th class="c-num">Precio venta</th>' : ''}
      <th class="c-num">Cantidad</th>
	      ${showMoney ? `<th class="c-num">Monto bruto</th>${showTax ? '<th class="c-num">ITBIS</th>' : ''}<th class="c-num">Importe</th>` : ''}
    </tr></thead>
    <tbody>${rows || `<tr>${showCode ? '<td class="c-code"></td>' : ''}<td colspan="${showMoney ? (showTax ? 6 : 5) : 2}" style="color:#9aa0b0">Sin artículos</td></tr>`}</tbody>
  </table>

  ${totalsBox}
  ${cuentasPago}
  ${paySummary}
  ${firma}
  ${noteFiscal ? `<div class="note">${noteFiscal}</div>` : ''}

  ${(footMsg || footWeb) ? `<div class="docfoot">${footMsg}${footMsg && footWeb ? '<span class="sep">|</span>' : ''}${footWeb}</div>` : ''}

  <script>
    (function () {
      try {
        // Estima el total de páginas (alto del contenido / alto útil de la hoja Carta).
        var dpi = 96;
        var pageH = dpi * 11;                       // Carta = 11in
        var margTop = ${parseFloat(_mtc) || 12}, margBot = ${parseFloat(_mbc) || 10};
        var usable = pageH - ((margTop + margBot) / 25.4) * dpi;
        var total = Math.max(1, Math.ceil(document.body.scrollHeight / usable));
        document.querySelectorAll('.a4-tot').forEach(function (e) { e.textContent = String(total); });
      } catch (e) {}
    })();
  </script>
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
  const showTax = _showItbis(sale);
  const displaySubtotal = _displaySubtotal(sale);
  const displayTax = _displayTaxAmt(sale);
  const displayTotal = _displayTotal(sale);
  const displayDiscount = _displayDiscount(sale);
  const showCode = _showCode(cfg);
  const rows = (sale.items||[]).map((i,idx) => {
    const qty = Number(i.qty || 1);
    const unitNet = showTax ? _lineNetUnit(i, sale) : Number(i.unit_price || i.price || 0);
    const lineNet = showTax ? _lineNet(i, sale) : (qty * unitNet);
    const lineTax = showTax ? _lineTax(i, sale) : 0;
    const importe = showTax ? _lineImporte(i, sale) : (qty * unitNet);
    return `
    <tr style="${idx%2===0?'background:#f9fafb':''}">
      ${showCode ? `<td style="padding:8px 8px;font-family:'Courier New',monospace;font-size:10px;color:#555">${_esc(i.product_code || i.code || '—')}</td>` : ''}
      <td style="padding:8px 8px">${_esc(i.product_name||i.name)}</td>
      <td style="text-align:center;padding:8px">${i.qty}</td>
      <td style="text-align:right;padding:8px">RD$${_n2(unitNet)}</td>
      <td style="text-align:right;padding:8px">RD$${_n2(lineNet)}</td>
      ${showTax ? `<td style="text-align:right;padding:8px">RD$${_n2(lineTax)}</td>` : ''}
      <td style="text-align:right;padding:8px;font-weight:600">RD$${_n2(importe)}</td>
    </tr>`;
  }).join('');

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
      ${opts.logo ? buildLogoHeader(cfg.biz_logo, cfg.biz_logo_2, { unit:'px', maxW:160, maxH:45, align:'left', marginBottom:4, filter:'brightness(10)', br:true }) : ''}
      <div class="biz-name">${_esc(cfg.biz_name||'Mi Negocio')}</div>
      <div style="font-size:11px;opacity:.8">
        ${opts.rnc && cfg.biz_rnc ? `RNC: ${_esc(cfg.biz_rnc)} · ` : ''}${_esc(cfg.biz_addr||'')} · ${_esc(cfg.biz_phone||'')}
      </div>
    </div>
    <div style="text-align:right">
      <div class="doc-label">${_docLabel(sale)}</div>
      <div class="doc-num">${facturaLabel(sale)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <label>Cliente</label>
      <strong>${_esc(sale.customer_name||'Consumidor Final')}</strong>
      ${opts.cedula && sale.customer_rnc ? `<br/><span style="font-size:11px;color:#666">RNC/Cédula: ${_esc(sale.customer_rnc)}</span>` : ''}
      ${sale.customer_contact_name ? `<br/><span style="font-size:11px;color:#444">Solicitado por: ${_esc(sale.customer_contact_name)}${sale.customer_contact_role ? ` · ${_esc(sale.customer_contact_role)}` : ''}</span>` : ''}
    </div>
    <div class="info-box">
      <label>Detalles</label>
      <div>Fecha: <strong>${sale.date}</strong></div>
      <div>Cajero: ${_esc(sale.cajero||'')}</div>
      ${sale.salesperson_name ? `<div>Vendedor: ${_esc((sale.salesperson_code ? sale.salesperson_code + ' · ' : '') + sale.salesperson_name)}</div>` : ''}
      <div>Pago: ${_esc(_pagoResumenTexto(sale))}</div>
    </div>
  </div>

  <table>
    <thead><tr>
      ${showCode ? '<th>Código</th>' : ''}
      <th>Nombre artículo</th>
      <th style="text-align:center">Cant.</th>
      <th style="text-align:right">Precio Unit.</th>
      <th style="text-align:right">Monto bruto</th>
      ${showTax ? '<th style="text-align:right">ITBIS</th>' : ''}
      <th style="text-align:right">Importe</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals-box">
    <div class="total-row"><span>Sub Total sin impuestos</span><span>RD$${_n2(displaySubtotal)}</span></div>
    ${showTax ? `<div class="total-row"><span>Total ITBIS</span><span>RD$${_n2(displayTax)}</span></div>` : ''}
    ${displayDiscount > 0 ? `<div class="total-row"><span>Descuento</span><span style="color:#dc2626">-RD$${_n2(displayDiscount)}</span></div>` : ''}
    <div class="total-row grand-total"><span>Total con impuestos</span><span>RD$${_n2(displayTotal)}</span></div>
  </div>

  ${isDevolucion && sale.original_sale_id ? `<div style="margin-top:8px;font-size:11px;color:#555">Ref. venta original: ${facturaLabelOriginal(sale)}</div>` : ''}
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
  const showTax = _showItbis(sale);
  const displaySubtotal = _displaySubtotal(sale);
  const displayTax = _displayTaxAmt(sale);
  const displayTotal = _displayTotal(sale);
  const displayDiscount = _displayDiscount(sale);
  const showCode = _showCode(cfg);
  const rows = (sale.items||[]).map(i => {
    const qty = Number(i.qty || 1);
    const unitNet = showTax ? _lineNetUnit(i, sale) : Number(i.unit_price || i.price || 0);
    const lineNet = showTax ? _lineNet(i, sale) : (qty * unitNet);
    const lineTax = showTax ? _lineTax(i, sale) : 0;
    const importe = showTax ? _lineImporte(i, sale) : (qty * unitNet);
    return `
    <tr>
      ${showCode ? `<td style="padding:7px 6px;font-family:'Courier New',monospace;font-size:10px">${_esc(i.product_code || i.code || '—')}</td>` : ''}
      <td style="padding:7px 6px">${_esc(i.product_name||i.name)}</td>
      <td style="text-align:center;padding:7px">${i.qty}</td>
      <td style="text-align:right;padding:7px 6px">RD$${_n2(unitNet)}</td>
      <td style="text-align:right;padding:7px 6px">RD$${_n2(lineNet)}</td>
      ${showTax ? `<td style="text-align:right;padding:7px 6px">RD$${_n2(lineTax)}</td>` : ''}
      <td style="text-align:right;padding:7px 6px;font-weight:700">RD$${_n2(importe)}</td>
    </tr>`;
  }).join('');

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
      ${opts.logo ? buildLogoHeader(cfg.biz_logo, cfg.biz_logo_2, { unit:'px', maxW:180, maxH:50, align:'left', marginBottom:4, filter:'grayscale(100%) contrast(150%)', br:true }) : ''}
      <strong style="font-size:14px">${_esc(cfg.biz_name||'Mi Negocio')}</strong><br/>
      RNC: <strong>${_esc(cfg.biz_rnc||'---')}</strong><br/>
      ${_esc(cfg.biz_addr||'')}<br/>Tel: ${_esc(cfg.biz_phone||'')}
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#666">Factura No.</div>
      <div style="font-size:20px;font-weight:700">${facturaLabel(sale)}</div>
      <div>Cajero: ${_esc(sale.cajero||'')}</div>
      ${sale.salesperson_name ? `<div>Vendedor: ${_esc((sale.salesperson_code ? sale.salesperson_code + ' · ' : '') + sale.salesperson_name)}</div>` : ''}
      <div>Método: ${_esc(_pagoResumenTexto(sale))}</div>
    </div>
  </div>

  <div style="background:#f3f4f6;padding:7px 12px;border-radius:4px;margin-bottom:8px">
    <strong>Cliente:</strong> ${_esc(sale.customer_name||'Consumidor Final')}
    ${opts.cedula && sale.customer_rnc ? ` &nbsp;|&nbsp; <strong>RNC/Cédula:</strong> ${_esc(sale.customer_rnc)}` : ''}
    ${sale.customer_contact_name ? `<br/><strong>Solicitado por:</strong> ${_esc(sale.customer_contact_name)}${sale.customer_contact_role ? ` · ${_esc(sale.customer_contact_role)}` : ''}` : ''}
  </div>

  <table>
    <thead><tr>
      ${showCode ? '<th>Código</th>' : ''}<th>Nombre artículo</th><th style="text-align:center">Cant.</th>
      <th style="text-align:right">Precio</th><th style="text-align:right">Monto bruto</th>
      ${showTax ? '<th style="text-align:right">ITBIS</th>' : ''}
      <th style="text-align:right">Importe</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total-section">
    <table class="total-table">
      <tr><td>Sub Total sin impuestos</td><td style="text-align:right">RD$${_n2(displaySubtotal)}</td></tr>
      ${showTax ? `<tr><td>Total ITBIS</td><td style="text-align:right">RD$${_n2(displayTax)}</td></tr>` : ''}
      ${displayDiscount > 0 ? `<tr><td>Descuento</td><td style="text-align:right;color:red">-RD$${_n2(displayDiscount)}</td></tr>` : ''}
      <tr class="grand"><td>Total con impuestos</td><td style="text-align:right">RD$${_n2(displayTotal)}</td></tr>
    </table>
  </div>

  ${isDevolucion && sale.original_sale_id ? `<div style="margin-top:6px;font-size:11px;color:#555">Ref. venta original: ${facturaLabelOriginal(sale)}</div>` : ''}
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
      ${opts.logo ? buildLogoHeader(cfg.biz_logo, cfg.biz_logo_2, { unit:'px', maxW:140, maxH:35, align:'left', marginBottom:3, filter:'grayscale(100%) contrast(150%)', br:true }) : ''}
      <strong style="font-size:12px">${_esc(cfg.biz_name||'Mi Negocio')}</strong><br/>
      ${opts.rnc && cfg.biz_rnc ? `RNC: ${_esc(cfg.biz_rnc)}<br/>` : ''}
      ${_esc(cfg.biz_addr||'')} · Tel: ${_esc(cfg.biz_phone||'')}
    </div>
    <div style="text-align:right">
      <strong style="font-size:14px">${facturaLabel(sale)}</strong><br/>
      ${sale.date}<br/>
      ${_docLabel(sale)}
    </div>
  </div>
  <div style="background:#f3f4f6;padding:4px 8px;margin-bottom:6px;border-radius:3px;font-size:10px">
    Cliente: <strong>${_esc(sale.customer_name||'Consumidor Final')}</strong>
    ${sale.customer_contact_name ? ` · Solicitado por: <strong>${_esc(sale.customer_contact_name)}</strong>` : ''}
  </div>
  <table>
    <thead><tr><th>Producto</th><th style="text-align:center">Q</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td style="padding:3px">Subtotal</td><td style="text-align:right;padding:3px">RD$${Number(sale.subtotal||0).toLocaleString('es-DO')}</td></tr>
    ${_showItbis(sale) ? `<tr><td style="padding:3px">ITBIS (${sale.tax_pct||18}%)</td><td style="text-align:right;padding:3px">RD$${(Math.round(_displayTaxAmt(sale)*100)/100).toLocaleString('es-DO')}</td></tr>` : ''}
    <tr style="font-size:13px;font-weight:700;border-top:2px solid #000">
      <td style="padding:4px">TOTAL</td>
      <td style="text-align:right;padding:4px">RD$${Number(sale.total||0).toLocaleString('es-DO')}</td>
    </tr>
  </table>
  ${_showNcf(sale, opts) ? `<div style="font-size:9px;color:#555;margin-top:4px">NCF: ${ncf}</div>` : ''}
  ${isCotizacion ? `<div style="font-size:9px;color:#888;font-style:italic;margin-top:2px">Sin valor fiscal</div>` : ''}
  <div style="text-align:center;font-size:9px;color:#666;margin-top:6px">
    ${_esc(_pagoResumenTexto(sale))} · ${opts.mensaje && cfg.receipt_msg && !isCotizacion ? cfg.receipt_msg : 'Gracias por su compra'}
  </div>
</body></html>`;
}
