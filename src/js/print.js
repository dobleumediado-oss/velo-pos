// ══════════════════════════════════════════════
// print.js — Servicio de Impresión
//   · Tickets térmicos de ancho configurable (58/72/80/108mm y personalizados)
//   · Etiquetas mediante el controlador universal del sistema
//   · Factura A4 previsualización
//   · Reimpresión auditada
//   · Usa impresora guardada en settings
//   · Si falla impresión, NO duplica la venta
// ══════════════════════════════════════════════

// ── Utilidades de texto térmico ──────────────
const THERMAL = { cols: 42 };

const tline  = (ch = '─') => ch.repeat(THERMAL.cols);
const tlineD = ()          => '═'.repeat(THERMAL.cols);

function tCenter(text, cols = THERMAL.cols) {
  const t   = String(text || '');
  const pad = Math.max(0, Math.floor((cols - t.length) / 2));
  return ' '.repeat(pad) + t;
}

function tRow(left, right, cols = THERMAL.cols) {
  const r    = String(right || '');
  const l    = String(left  || '');
  const maxL = cols - r.length - 1;
  const lTrunc = l.length > maxL ? l.slice(0, maxL - 1) + '.' : l;
  const gap    = cols - lTrunc.length - r.length;
  return lTrunc + ' '.repeat(Math.max(1, gap)) + r;
}

function _escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _ensureUtf8HTML(html) {
  const source = String(html || '');
  if (/<meta\s+[^>]*charset=/i.test(source)) return source;
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, '<head$1><meta charset="UTF-8"/>');
  }
  return `<meta charset="UTF-8"/>${source}`;
}

// ── Encabezado de logo(s) para documentos ─────
// Renderiza 1 o 2 logos con un layout seguro y compartido por TODOS los
// documentos imprimibles (tickets térmicos, facturas carta, conduces, etc.).
//
//  · 1 logo  → mismo tamaño/posición que antes (perW = maxW).
//  · 2 logos → fila con gap, object-fit:contain, sin deformar, sin montarse.
//              En térmica (o split:true) cada logo se limita a la mitad del
//              ancho para no salirse del área imprimible. En documentos carta
//              cada logo conserva su tamaño natural (hay ancho de sobra).
//
// opts: { unit:'px'|'mm', maxH, maxW, filter, align:'center'|'left'|'right',
//         marginBottom, split, br }
// Devuelve '' si no hay ningún logo.
function buildLogoHeader(logo1, logo2, opts = {}) {
  const unit         = opts.unit || 'px';
  // Escala opcional (Tamaño del logo en factura): 0.6 pequeño · 1 mediano · 1.4 grande.
  const scale        = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
  const maxH         = Math.round((opts.maxH != null ? opts.maxH : 60) * scale);
  const maxW         = Math.round((opts.maxW != null ? opts.maxW : 180) * scale);
  const filter       = opts.filter || '';
  const align        = opts.align  || 'center';
  const marginBottom = opts.marginBottom || 0;
  const br           = !!opts.br;

  const l1   = (typeof logo1 === 'string' ? logo1 : '').trim();
  const l2   = (typeof logo2 === 'string' ? logo2 : '').trim();
  const list = [l1, l2].filter(Boolean);
  if (!list.length) return '';

  const two   = list.length === 2;
  // Por defecto se reparte el ancho solo en térmica (mm); en px (carta) los
  // logos conservan su tamaño natural salvo que se pida split explícito.
  const split = opts.split != null ? opts.split : (unit === 'mm');
  const gapN  = unit === 'mm' ? 2 : 10;
  const gap   = `${gapN}${unit}`;
  const perWn = (two && split) ? Math.max(1, (maxW - gapN) / 2) : maxW;
  const perW  = unit === 'mm' ? `${Number(perWn.toFixed(1))}mm` : `${Math.floor(perWn)}px`;
  const maxHs = `${maxH}${unit}`;
  const just  = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const filt  = filter ? `filter:${filter};` : '';
  const mb    = marginBottom ? `margin-bottom:${marginBottom}px;` : '';
  const auto  = align === 'center' ? 'margin-left:auto;margin-right:auto;' : '';

  const imgs = list.map(src =>
    `<img src="${src}" style="max-height:${maxHs};max-width:${perW};width:auto;height:auto;object-fit:contain;${filt}"/>`
  ).join('');

  const html = `<div style="display:flex;align-items:center;justify-content:${just};` +
               `gap:${gap};max-width:100%;${auto}${mb}">${imgs}</div>`;
  return br ? html + '<br/>' : html;
}

// ── Obtener impresora guardada ────────────────
function _getSavedPrinter() {
  return (DB?.settings?.printer || CFG?.printer || '').trim();
}

function _getTicketPrinterProfile(printerName = _getSavedPrinter()) {
  if (typeof resolvePrinterProfile === 'function') {
    return resolvePrinterProfile(printerName, 'ticket');
  }
  const type = typeof detectPrinterType === 'function' ? detectPrinterType(printerName) : '80mm';
  const widthMm = type === '58mm' ? 58 : type === '72mm' ? 72 : type === '108mm' ? 108 : 80;
  return { id: `ticket_${widthMm}`, kind: type === 'carta' ? 'sheet' : 'continuous',
    widthMm, printableWidthMm: Math.max(20, widthMm - 4), dpi: 203 };
}

// ══════════════════════════════════════════════
// CONFIGURACIÓN DE IMPRESIÓN POR MÓDULO/DOCUMENTO
// ══════════════════════════════════════════════
// Categorías de documento — cada una puede tener su propia impresora,
// vista previa forzada, y (solo "ticket") impresión automática tras venta.
// Si una categoría no tiene override, cae a la impresora global guardada.
const PRINT_CATEGORIES = {
  ticket:       { label: 'Facturas y ventas',         autoPrintDefault: false, previewDefault: true,  media: 'any'   },
  cotizacion:   { label: 'Cotizaciones',               autoPrintDefault: false, previewDefault: true,  media: 'any'   },
  pago:         { label: 'Pagos y abonos',             autoPrintDefault: false, previewDefault: true,  media: 'any'   },
  conduce:      { label: 'Conduces y entregas',        autoPrintDefault: false, previewDefault: true,  media: 'any'   },
  caja:         { label: 'Caja, arqueos y cierres',    autoPrintDefault: false, previewDefault: true,  media: 'sheet' },
  inventario:   { label: 'Inventario y etiquetas de anaquel', autoPrintDefault: false, previewDefault: true, media: 'sheet' },
  compras:      { label: 'Compras y recepciones',      autoPrintDefault: false, previewDefault: true,  media: 'sheet' },
  contabilidad: { label: 'Contabilidad',               autoPrintDefault: false, previewDefault: true,  media: 'sheet' },
  bancos:       { label: 'Bancos',                     autoPrintDefault: false, previewDefault: true,  media: 'sheet' },
  reporte:      { label: 'Reportes',                   autoPrintDefault: false, previewDefault: true,  media: 'sheet' },
};

const PRINT_CHANNELS = {
  ventas:    { label: 'Caja · ventas',       icon: 'cash',    accepts: 'document' },
  pagos:     { label: 'Caja · pagos',        icon: 'dollar',  accepts: 'document' },
  caja:      { label: 'Administración · caja', icon: 'ledger', accepts: 'document' },
  oficina:   { label: 'Oficina',             icon: 'print',   accepts: 'document' },
  almacen:   { label: 'Almacén y despacho',  icon: 'box',     accepts: 'document' },
  etiquetas: { label: 'Etiquetas',           icon: 'barcode', accepts: 'label' },
};

const _DEFAULT_PRINT_CHANNEL = {
  ticket: 'ventas',
  cotizacion: 'ventas',
  pago: 'pagos',
  caja: 'caja',
  conduce: 'almacen',
  inventario: 'almacen',
  compras: 'almacen',
  contabilidad: 'oficina',
  bancos: 'oficina',
  reporte: 'oficina',
};

// jobType (el identificador interno de cada función de impresión) → categoría
const _JOB_TYPE_CATEGORY = {
  ticket: 'ticket', factura: 'ticket', test: 'ticket', prueba_plantilla: 'ticket',
  cotizacion: 'cotizacion', conduce: 'conduce',
  abono: 'pago', pago_proveedor: 'pago',
  cierre: 'caja',
};
function _categoryForJobType(jobType) {
  return _JOB_TYPE_CATEGORY[jobType] || jobType || 'reporte';
}

function _getPrintConfig() {
  try {
    return JSON.parse(DB?.settings?.print_route_config || DB?.settings?.print_config || '{}');
  } catch { return {}; }
}

function _getPrinterBindings() {
  let saved = {};
  try { saved = JSON.parse(DB?.settings?.printer_channel_bindings || '{}') || {}; } catch {}
  const fallback = DB?.settings?.printer || '';
  const value = (channel, legacy) => Object.prototype.hasOwnProperty.call(saved, channel)
    ? String(saved[channel] || '').trim() : String(legacy || '').trim();
  return {
    ventas: value('ventas', fallback),
    pagos: value('pagos', fallback),
    caja: value('caja', fallback),
    oficina: value('oficina', fallback),
    almacen: value('almacen', fallback),
    etiquetas: value('etiquetas', DB?.settings?.barcode_printer || ''),
  };
}

function _getPrinterChannelProfiles() {
  let saved = {};
  try { saved = JSON.parse(DB?.settings?.printer_channel_profiles || '{}') || {}; } catch {}
  return saved && typeof saved === 'object' ? saved : {};
}

function _getCategoryConfig(category) {
  const all = _getPrintConfig();
  const cat = all[category] || {};
  const definition = PRINT_CATEGORIES[category] || {};
  const channel = PRINT_CHANNELS[cat.channel] ? cat.channel : (_DEFAULT_PRINT_CHANNEL[category] || 'oficina');
  const bindings = _getPrinterBindings();
  const profiles = _getPrinterChannelProfiles();
  const hasExplicitProfile = Object.prototype.hasOwnProperty.call(profiles, channel);
  let hasExplicitBinding = false;
  try {
    const rawBindings = JSON.parse(DB?.settings?.printer_channel_bindings || '{}') || {};
    hasExplicitBinding = Object.prototype.hasOwnProperty.call(rawBindings, channel);
  } catch {}
  return {
    channel,
    bindingConfigured: hasExplicitBinding,
    profileConfigured: hasExplicitProfile,
    // `cat.printer` conserva rutas creadas por versiones anteriores. Al guardar
    // desde el Centro nuevo queda reemplazada por channel + binding local.
    printer:   String(hasExplicitBinding ? bindings[channel] : (cat.printer || bindings[channel] || '')).trim(),
    template:  (cat.template || '').trim(),
    profileId: String(cat.profileId || profiles[channel] || '').trim(),
    copies:    Math.max(1, Math.min(9, parseInt(cat.copies, 10) || 1)),
    preview: true,
    autoPrint: false,
  };
}

function _printProductCode(item) {
  const direct = item?.product_code || item?.code || item?.sku;
  if (direct) return direct;
  const prod = (DB?.products || []).find(p => p.id === item?.product_id);
  return prod?.code || '';
}

// ══════════════════════════════════════════════
// MONITOR LOCAL DE IMPRESORAS
// ══════════════════════════════════════════════
// Electron no expone un evento universal de conexión/desconexión para todas las
// marcas. VELO mantiene una fotografía local, la refresca mientras la app está
// visible y también al recuperar foco o antes de imprimir.
const PRINTER_MONITOR_INTERVAL_MS = 4000;
let _printerMonitorTimer = null;
let _printerMonitorInFlight = null;
let _printerMonitorState = {
  printers: [],
  initialized: false,
  checkedAt: 0,
  error: '',
};

function printerMonitorGetState() {
  return {
    ..._printerMonitorState,
    printers: [...(_printerMonitorState.printers || [])],
  };
}

async function printerMonitorRefresh(options = {}) {
  if (_printerMonitorInFlight) return _printerMonitorInFlight;
  const run = async () => {
    try {
      const raw = await window.api?.print?.getPrinters?.();
      const next = typeof normalizePrinterSnapshot === 'function'
        ? normalizePrinterSnapshot(raw)
        : (Array.isArray(raw) ? raw : []);
      const diff = typeof diffPrinterSnapshots === 'function'
        ? diffPrinterSnapshots(_printerMonitorState.printers, next)
        : { printers: next, added: [], removed: [], updated: [], changed: true };
      const initial = !_printerMonitorState.initialized;
      _printerMonitorState = {
        printers: diff.printers,
        initialized: true,
        checkedAt: Date.now(),
        error: '',
      };
      if (initial || diff.changed || options.forceEvent === true) {
        document.dispatchEvent(new CustomEvent('velo:printers-changed', {
          detail: {
            ...diff,
            initial,
            reason: options.reason || 'monitor',
            checkedAt: _printerMonitorState.checkedAt,
          },
        }));
      }
      return [...diff.printers];
    } catch (error) {
      _printerMonitorState.error = error?.message || String(error);
      _printerMonitorState.checkedAt = Date.now();
      document.dispatchEvent(new CustomEvent('velo:printer-monitor-error', {
        detail: { error: _printerMonitorState.error, checkedAt: _printerMonitorState.checkedAt },
      }));
      return [...(_printerMonitorState.printers || [])];
    } finally {
      _printerMonitorInFlight = null;
    }
  };
  _printerMonitorInFlight = run();
  return _printerMonitorInFlight;
}

function printerMonitorStart() {
  if (_printerMonitorTimer) return;
  printerMonitorRefresh({ reason: 'startup' });
  _printerMonitorTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      printerMonitorRefresh({ reason: 'interval' });
    }
  }, PRINTER_MONITOR_INTERVAL_MS);
}

function printerMonitorStop() {
  if (_printerMonitorTimer) clearInterval(_printerMonitorTimer);
  _printerMonitorTimer = null;
}

async function printerMonitorEnsureAvailable(printerName, maxAgeMs = 1500) {
  const name = String(printerName || '').trim();
  if (!name) return { available: true, printer: null };
  if (!_printerMonitorState.initialized ||
      (Date.now() - _printerMonitorState.checkedAt) > maxAgeMs) {
    await printerMonitorRefresh({ reason: 'preflight', force: true });
  }
  if (_printerMonitorState.error) {
    return {
      available: null,
      indeterminate: true,
      printer: null,
      error: _printerMonitorState.error,
      checkedAt: _printerMonitorState.checkedAt,
    };
  }
  const printer = (_printerMonitorState.printers || []).find(item => item.name === name);
  const runtime = printer && typeof getPrinterRuntimeState === 'function'
    ? getPrinterRuntimeState(printer) : null;
  return {
    available: !!printer,
    printer: printer || null,
    runtime,
    ready: !!printer && !runtime?.reportedIssue,
    checkedAt: _printerMonitorState.checkedAt,
  };
}

window.addEventListener('focus', () => {
  printerMonitorRefresh({ reason: 'focus' });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') printerMonitorRefresh({ reason: 'visible' });
});
window.addEventListener('beforeunload', printerMonitorStop);

// ── Guard contra impresión duplicada ──────────
// Evita reenviar el mismo documento si el usuario presiona "Imprimir"
// varias veces muy rápido mientras el trabajo anterior sigue en curso.
const _inFlightPrintKeys = new Set();

async function _printDispatch(payload) {
  payload = { ...(payload || {}), userConfirmed: true };
  const key = (payload.jobType && payload.referenceId != null)
    ? `${payload.jobType}:${payload.referenceId}` : null;
  if (key) {
    if (_inFlightPrintKeys.has(key)) {
      return Promise.resolve({ ok: false, duplicate: true, error: 'Ya hay una impresión en curso para este documento' });
    }
    _inFlightPrintKeys.add(key);
  }
  const release = () => { if (key) _inFlightPrintKeys.delete(key); };
  try {
    if (payload.printerName) {
      const check = await printerMonitorEnsureAvailable(payload.printerName);
      if (check.available === false) {
        return {
          ok: false,
          printerUnavailable: true,
          error: `La impresora “${payload.printerName}” ya no está disponible en esta terminal`,
        };
      }
      if (check.runtime?.reportedIssue) {
        return {
          ok: false,
          printerNotReady: true,
          error: `La impresora “${payload.printerName}” reporta una incidencia: ${check.runtime.stateReason || 'no acepta trabajos'}`,
        };
      }
    }
    const result = await window.api.print.html(payload);
    if (!result?.ok && !result?.cancelled && !result?.duplicate) {
      window.VeloExperience?.rememberFailure?.({
        label:'Impresión no completada',
        detail:result?.error || 'La impresora no confirmó el trabajo.',
        module:'impresion',
        retryKey:key ? `print:${key}` : '',
        payload:key ? { jobType:payload.jobType, referenceId:payload.referenceId } : null,
      });
    } else if (result?.ok && key) {
      try {
        const pending = JSON.parse(localStorage.getItem('vp_recoverable_operations_v1') || '[]')
          .find(item => item.retryKey === `print:${key}`);
        if (pending) window.VeloExperience?.resolveFailure?.(pending.id);
      } catch {}
    }
    return result;
  } catch (error) {
    window.VeloExperience?.rememberFailure?.({
      label:'Impresión interrumpida',
      detail:error?.message || 'No se pudo enviar el documento.',
      module:'impresion',
      retryKey:key ? `print:${key}` : '',
      payload:key ? { jobType:payload.jobType, referenceId:payload.referenceId } : null,
    });
    throw error;
  } finally {
    release();
  }
}

// Punto único para trabajos de etiquetas. Conserva las dimensiones exactas
// del medio, evita dobles envíos y mantiene el módulo de etiquetas desacoplado
// del transporte IPC de impresión.
function printLabelBatch({
  html, printerName = '', widthMm, heightMm, userId = null, referenceId = null
}) {
  if (!String(html || '').includes('class="vp-label"')) {
    return Promise.resolve({ ok: false, error: 'El trabajo no contiene etiquetas para imprimir' });
  }
  if (!String(printerName || '').trim()) {
    return Promise.resolve({
      ok: false,
      error: 'Selecciona una impresora de etiquetas; la impresora de documentos no se usa automáticamente',
    });
  }
  return _printDispatch({
    html,
    printerName,
    printerWidth: `${Number(widthMm)}mm`,
    printerHeight: heightMm ? `${Number(heightMm)}mm` : undefined,
    jobType: 'barcode_labels',
    referenceId: referenceId || Math.floor(Date.now() / 1000),
    userId,
    silent: true,
  });
}

// Densidad de impresión térmica (config: thermal_density). Engrosa los glifos
// para que no salgan muy claros. 'normal' no cambia nada.
function _thermalDensityCss() {
  const level = String(DB?.settings?.thermal_density || 'normal').toLowerCase();
  if (level === 'oscura' || level === 'alta') return '*{font-weight:600!important}';
  if (level === 'maxima') return '*{font-weight:700!important;-webkit-text-stroke:0.25px currentColor}';
  return '';
}
function _injectThermalDensity(html) {
  const css = _thermalDensityCss();
  if (!css || typeof html !== 'string') return html;
  const style = `<style>${css}</style>`;
  if (html.includes('</head>')) return html.replace('</head>', style + '</head>');
  if (/<body[^>]*>/.test(html)) return html.replace(/<body[^>]*>/, m => m + style);
  return style + html;
}

// ══════════════════════════════════════════════
// TICKET DE VENTA 80MM
// ══════════════════════════════════════════════
function printReceipt(sale, isReprint = false) {
  if (!sale) return;

  // ── Usar sistema de plantillas si está configurado ──
  const jobType = sale.type === 'cotizacion'
    ? 'cotizacion'
    : sale.type === 'abono'
      ? 'abono'
      : 'ticket';
  const routeConfig = _getCategoryConfig(_categoryForJobType(jobType));
  const templateId = sale.print_template_id || routeConfig.template || DB?.settings?.print_template;
  const plantilla  = templateId ? getPlantilla(templateId) : null;

  if (plantilla) {
    // Usar plantilla seleccionada
    const cfg = {
      biz_name:    DB?.settings?.biz_name    || CFG?.biz    || 'Mi Negocio',
      biz_rnc:     DB?.settings?.biz_rnc     || CFG?.rnc    || '',
      biz_addr:    DB?.settings?.biz_addr    || CFG?.addr   || '',
      biz_phone:   DB?.settings?.biz_phone   || CFG?.phone  || '',
      biz_email:   DB?.settings?.biz_email   || '',
      biz_web:     DB?.settings?.biz_web     || '',
      biz_logo:    DB?.settings?.biz_logo    || CFG?.biz_logo || '',
      biz_logo_2:  DB?.settings?.biz_logo_2  || CFG?.biz_logo_2 || '',
      logo_size:   DB?.settings?.logo_size   || 'mediano',
      factura_font_size: DB?.settings?.factura_font_size || 'mediano',
      // Firma promocional VELO POS (QR + texto). enabled por defecto salvo '0'.
      invoice_branding_enabled: DB?.settings?.invoice_branding_enabled ?? '1',
      invoice_branding_url:     DB?.settings?.invoice_branding_url  || 'https://wa.link/39cwoi',
      invoice_branding_text:    DB?.settings?.invoice_branding_text || 'Sistema de facturación impulsado por VELO POS',
      invoice_branding_cta:     DB?.settings?.invoice_branding_cta  || 'Solicita tu demostración',
      receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
      invoice_notes: DB?.settings?.invoice_notes || '',
      // Datos bancarios del negocio (fallback si no hay cuentas registradas)
      biz_bank_name:    DB?.settings?.biz_bank_name    || '',
      biz_bank_account: DB?.settings?.biz_bank_account || '',
      biz_bank_holder:  DB?.settings?.biz_bank_holder  || '',
      biz_bank_iban:    DB?.settings?.biz_bank_iban    || '',
      // Cuentas registradas (Bancos y Cuentas) — fuente preferida para la factura:
      // transferencia → la cuenta que recibió el pago; crédito → todas, para que
      // el cliente sepa a dónde transferir. Solo banco/tarjeta activas.
      bank_accounts: (DB?.financialAccounts || []).filter(a =>
        a.is_active !== false && (a.type === 'banco' || a.type === 'tarjeta')),
      // '0' oculta la columna "Código" de artículos SOLO en la impresión
      print_item_code:  DB?.settings?.print_item_code  || '1',
    };

    const saleForPlant = {
      ...sale,
      isReprint,
      // Tipo de documento — crítico para comportamiento de plantilla
      type:          sale.type || 'recibo',
      date:          sale.date || today(),
      time:          sale.time || nowt(),
      customer_name: sale.customer_name || sale.clientName || 'Consumidor Final',
      customer_rnc:  sale.customer_rnc  || sale.clientCedula || '',
      customer_id:      sale.customer_id      || sale.clientId || null,
      customer_address: sale.customer_address || sale.cust_addr || '',
      customer_phone:   sale.customer_phone   || '',
      customer_phone_type: sale.customer_phone_type || 'telefono',
      customer_email:   sale.customer_email   || '',
      customer_type:    sale.customer_type    || 'person',
      customer_trade_name: sale.customer_trade_name || '',
      customer_contact_id: sale.customer_contact_id || null,
      customer_contact_name: sale.customer_contact_name || '',
      customer_contact_document: sale.customer_contact_document || '',
      customer_contact_role: sale.customer_contact_role || '',
      customer_contact_phone: sale.customer_contact_phone || '',
      customer_contact_email: sale.customer_contact_email || '',
      customer_branch_id: sale.customer_branch_id || null,
      customer_branch_name: sale.customer_branch_name || '',
      customer_branch_code: sale.customer_branch_code || '',
      customer_branch_address: sale.customer_branch_address || '',
      customer_branch_phone: sale.customer_branch_phone || '',
      due_date:         sale.due_date || null,
      applied_invoice:  sale.applied_invoice || null,
      financial_account_id: sale.financial_account_id || null,
      cajero:        sale.cajero || user?.name || '',
      salesperson_id:   sale.salesperson_id || null,
      salesperson_name: sale.salesperson_name || '',
      salesperson_code: sale.salesperson_code || '',
	      items: (sale.items || []).map(i => ({
	        product_code: _printProductCode(i),
	        product_name: i.product_name || i.name || '',
	        qty:          i.qty  || 1,
	        unit_price:   i.unit_price || i.price || 0,
	        subtotal:     i.subtotal,
	        taxable:      i.taxable,
	        tax_pct:      i.tax_pct,
	        tax_amt:      i.tax_amt,
	        net_subtotal: i.net_subtotal,
	      })),
      // Los cargos NO se inyectan como líneas de producto: cada plantilla los
      // muestra en su fila "Cargos adicionales" (a partir de additional_charges_total).
      // Inyectarlos aquí los duplicaba (línea + fila de totales) y descuadraba
      // el subtotal mostrado contra las líneas listadas.
      subtotal:      sale.subtotal     || 0,
      discount_pct:  sale.discount_pct || sale.disc    || 0,
      discount_amt:  sale.discount_amt || sale.discAmt || 0,
      // Usar ?? para no pisar un tax_pct = 0 legítimo (recibos sin ITBIS).
      // Solo cae al valor por defecto cuando viene null/undefined.
      tax_pct:       sale.tax_pct ?? DB?.settings?.tax_pct ?? CFG?.itbis ?? 18,
      tax_amt:       sale.tax_amt      || sale.itbis   || 0,
      total:         sale.total        || 0,
      charges:       Array.isArray(sale.charges) ? sale.charges : [],
      additional_charges_total: sale.additional_charges_total || 0,
      display_currency: sale.display_currency || 'DOP',
      display_exchange_rate: sale.display_exchange_rate || 1,
      display_amount: sale.display_amount || 0,
      payment_method: sale.payment_method || sale.pay || 'efectivo',
      payment_amount: sale.payment_amount ?? sale.paid_amount ?? null,
      paid_amount:    sale.paid_amount ?? sale.payment_amount ?? null,
      balance_after_payment: sale.balance_after_payment ?? sale.balance_after ?? null,
      receipt_number: sale.receipt_number || sale.last_receipt_number || sale.numero_recibo || '',
      receipt_numbers: sale.receipt_numbers || sale._recibos || '',
      transaction_number: sale.transaction_number || sale.transaction_id || sale.id || '',
      notes: sale.notes || '',
      // NCF real de la venta — nunca inventar uno
      ncf:           sale.ncf || '',
      // Pago mixto
      mix_efec:      sale.mix_efec || 0,
      mix_card:      sale.mix_card || 0,
      // Devolución — referencia a la factura original (número real)
      original_sale_id: sale.original_sale_id || null,
      original_numero_factura:     sale.original_numero_factura,
      original_numero_factura_fmt: sale.original_numero_factura_fmt,
    };

    // Cargar estilos personalizados del superadmin para esta plantilla
    let _estilosReal = {};
    try {
      const _rawEstilos = DB?.settings?.[`template_opts_${templateId}`];
      if (_rawEstilos) _estilosReal = JSON.parse(_rawEstilos);
    } catch {}
    const _optsConEstilos = { ...plantilla.opciones, _estilos: _estilosReal };
    let html = plantilla.render(saleForPlant, cfg, _optsConEstilos);
    // Todas las plantillas configurables deben dejar explícito el adelanto y
    // el saldo financiado. carta_recibo ya lo integra dentro de sus totales.
    if (templateId !== 'carta_recibo' &&
        String(saleForPlant.payment_method || '').toLowerCase() === 'credito') {
      const paid = Number(saleForPlant.payment_amount || 0);
      const balance = Number(
        saleForPlant.balance_after_payment != null
          ? saleForPlant.balance_after_payment
          : Math.max(0, Number(saleForPlant.total || 0) - paid)
      );
      const paymentBlock = `<div style="margin:10px 0;padding:8px 10px;border:1px solid #d7dae3;border-radius:6px;font-family:Arial,sans-serif;font-size:11px">
        <div style="display:flex;justify-content:space-between;gap:12px"><span>Pago inicial recibido</span><strong>RD$${paid.toLocaleString('es-DO',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
        <div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px"><span>Balance a crédito</span><strong>RD$${balance.toLocaleString('es-DO',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
      </div>`;
      html = html.includes('</body>') ? html.replace('</body>', paymentBlock + '</body>') : html + paymentBlock;
    }
    if (templateId !== 'carta_recibo' && saleForPlant.notes) {
      const noteBlock = `<div style="margin:8px 0;padding:7px 9px;border:1px solid #e5e7eb;border-radius:5px;font-family:Arial,sans-serif;font-size:10px"><strong>Notas:</strong> ${_escHtml(saleForPlant.notes)}</div>`;
      html = html.includes('</body>') ? html.replace('</body>', noteBlock + '</body>') : html + noteBlock;
    }
    _openPrintWindow(html, jobType, sale.id, isReprint, {
      printerName: sale.print_printer_name || '',
      profileId: sale.print_profile_id || '',
      templateId,
      copies: sale.print_copies || routeConfig.copies || 1,
      preview: sale.print_preview,
    });
    return html;
  }

  // ── Fallback: sistema clásico de líneas ──────
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';
  const isDevolucion = sale.type === 'devolucion';

  const lines = [];
  lines.push(tCenter(CFG.biz));
  if (CFG.rnc) lines.push(tCenter(`RNC: ${CFG.rnc}`));
  if (CFG.addr)  lines.push(tCenter(CFG.addr));
  if (CFG.phone) lines.push(tCenter(`Tel: ${CFG.phone}`));
  lines.push(tline());

  let docLabel = '*** RECIBO DE COMPRA ***';
  if (isFactura)    docLabel = sale.adjusted_copy ? '*** FACTURA AJUSTADA ***' : '*** FACTURA ***';
  if (isCotizacion) docLabel = '*** COTIZACIÓN ***';
  if (isDevolucion) docLabel = '*** NOTA DE CRÉDITO ***';
  lines.push(tCenter(docLabel));
  if (isReprint)    lines.push(tCenter('--- REIMPRESIÓN ---'));
  if (sale.adjusted_copy) {
    lines.push(tCenter('--- COPIA CONSOLIDADA ---'));
    lines.push(tCenter('No sustituye comprobantes fiscales'));
    if (sale.adjusted_reference) lines.push(tCenter(`Ref.: ${sale.adjusted_reference}`));
    if (sale.adjusted_reference_ncf) {
      lines.push(tCenter(`Ref. NCF original: ${sale.adjusted_reference_ncf}`));
    }
    if (Array.isArray(sale.related_documents) && sale.related_documents.length) {
      lines.push(tCenter(`Docs.: ${sale.related_documents.join(', ')}`));
    }
  }

  lines.push(tline());
  lines.push(tRow(`No.: ${facturaLabel(sale)}`, `Fecha: ${sale.date || today()}`));
  lines.push(tRow(`Hora: ${sale.time || nowt()}`, `Cajero: ${(sale.cajero||'').split(' ')[0]}`));
  if (sale.salesperson_name) {
    lines.push(tRow('Vendedor:', `${sale.salesperson_code ? sale.salesperson_code + ' · ' : ''}${sale.salesperson_name}`.slice(0, 28)));
  }

  const cliName = sale.customer_name || sale.clientName || 'Consumidor Final';
  const cliRnc  = sale.customer_rnc  || sale.clientCedula || '';
  lines.push(tRow('Cliente:', cliName.slice(0, 28)));
  if (cliRnc) lines.push(tRow('RNC/Céd:', cliRnc));
  if (sale.customer_phone) {
    const phoneLabel = sale.customer_phone_type === 'celular' ? 'Celular:'
      : sale.customer_phone_type === 'flota' ? 'Flota:' : 'Teléfono:';
    lines.push(tRow(phoneLabel, String(sale.customer_phone).slice(0, 24)));
  }
  if (sale.customer_contact_name) lines.push(tRow('Solicitado por:', String(sale.customer_contact_name).slice(0, 26)));
  if (sale.customer_branch_name) lines.push(tRow('Entregar en:', String(sale.customer_branch_name).slice(0, 26)));

  lines.push(tline());
  lines.push(tRow('DESCRIPCIÓN', 'TOTAL'));
  lines.push(tline('-'));

  const items = sale.items || [];
  items.forEach(item => {
    const name  = item.product_name || item.name || '';
    const price = item.unit_price   || item.price || 0;
    const qty   = item.qty || 1;
    const trunc = name.length > THERMAL.cols - 2
      ? name.slice(0, THERMAL.cols - 5) + '...' : name;
    lines.push(trunc);
    lines.push(tRow(`  ${qty} x ${fmt(price)}`, fmt(qty * price)));
  });

  lines.push(tline());
  const subtotal = sale.subtotal   || 0;
  const discAmt  = sale.discount_amt || sale.discAmt || 0;
  const discPct  = sale.discount_pct || sale.disc    || 0;
  const itbis    = sale.tax_amt    || sale.itbis     || 0;
  const total    = sale.total      || 0;

    lines.push(tRow('Subtotal sin ITBIS:', fmt(subtotal)));
  if (discPct > 0) lines.push(tRow(`Descuento (${discPct}%):`, `-${fmt(discAmt)}`));
  if ((isFactura || isDevolucion) && itbis > 0) lines.push(tRow(`ITBIS (${sale.tax_pct ?? CFG?.itbis ?? 18}%):`, fmt(itbis)));
  if (Number(sale.additional_charges_total || 0) > 0) {
    lines.push(tRow('Cargos adicionales:', fmt(sale.additional_charges_total)));
  }
  lines.push(tlineD());
  lines.push(tRow('TOTAL:', fmt(total)));
  if (String(sale.display_currency || '').toUpperCase() === 'USD' &&
      Number(sale.display_exchange_rate) > 0) {
    const usd = Number(sale.display_amount || (total / Number(sale.display_exchange_rate)));
    lines.push(tRow('Equivalente USD:', `US$${usd.toFixed(2)}`));
  }
  lines.push(tlineD());
  lines.push('');

  const metodo = (sale.payment_method || sale.pay || 'efectivo').toUpperCase();
  if (metodo === 'MIXTO') {
    lines.push(tRow('Método:', 'PAGO MIXTO'));
    if (sale.mix_efec > 0) lines.push(tRow('  Efectivo:', fmt(sale.mix_efec)));
    if (sale.mix_card > 0) lines.push(tRow('  Tarjeta/Trans.:', fmt(sale.mix_card)));
  } else {
    const cardBrand = String(sale.card_brand || '').trim();
    const cardLast4 = String(sale.card_last4 || '').replace(/\D/g, '').slice(-4);
    const methodText = metodo === 'TARJETA'
      ? `TARJETA${cardBrand ? ' ' + cardBrand.toUpperCase() : ''}`
      : metodo;
    lines.push(tRow('Método de pago:', methodText));
    if (metodo === 'TARJETA' && cardLast4) lines.push(tRow('Últimos dígitos:', `**** ${cardLast4}`));
    if (sale.payment_reference) {
      lines.push(tRow(metodo === 'TARJETA' ? 'Autorización:' : 'Referencia:', String(sale.payment_reference)));
    }
  }

  if (String(sale.payment_currency || '').toUpperCase() === 'USD' && Number(sale.account_amount) > 0) {
    const usd = `US$${Number(sale.account_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    lines.push(tRow('Pagado en USD:', usd));
    lines.push(tRow('Tasa USD:', `RD$${Number(sale.exchange_rate || 0).toFixed(2)}`));
    lines.push(tRow('Base factura:', fmt(total)));
  }
  if (sale.notes) {
    lines.push('');
    lines.push('NOTA:');
    String(sale.notes).match(new RegExp(`.{1,${Math.max(12, THERMAL.cols - 2)}}`, 'g'))
      ?.forEach(line => lines.push(line));
  }

  if (isFactura && !isDevolucion && !sale.adjusted_copy && sale.ncf && sale.ncf.trim()) {
    // Usar el NCF real guardado en la venta — nunca fabricar uno.
    // El NCF real se asigna y registra en ncf_log al crear la venta;
    // si no está guardado, no se imprime ninguno.
    lines.push('');
    lines.push(tCenter('Documento con validez fiscal'));
    lines.push(tCenter(`NCF: ${sale.ncf}`));
  }

  if (isDevolucion) {
    if (sale.correction_kind === 'monetary_credit') {
      lines.push(tCenter('AJUSTE MONETARIO — SIN DEVOLUCIÓN DE PRODUCTOS'));
    }
    // Nota de crédito fiscal: si la devolución tiene un B04 asignado, imprimirlo
    // junto con el NCF de la factura que modifica (requisito DGII). Nunca fabricar
    // uno: solo se imprime el B04 realmente guardado en la devolución.
    if (sale.ncf && String(sale.ncf).trim()) {
      lines.push('');
      lines.push(tCenter('NOTA DE CRÉDITO — validez fiscal'));
      lines.push(tCenter(`NCF: ${sale.ncf}`));
      const modNcf = sale.modifies_ncf || sale.original_ncf || '';
      if (modNcf) lines.push(tCenter(`Modifica NCF: ${modNcf}`));
    }
    if (sale.original_sale_id) {
      lines.push('');
      lines.push(tCenter(`Ref. venta original: ${facturaLabelOriginal(sale)}`));
    }
  }

  lines.push('');
  lines.push(tCenter(DB?.settings?.receipt_msg || CFG?.receipt_msg || '¡Gracias por su compra!'));
  lines.push(tCenter('Conserve su comprobante'));
  lines.push(tline());
  lines.push('');
  lines.push('');

  // Se pasa `sale` para que el fallback clásico (sin plantilla) también lleve la
  // firma promocional, gateada por el MISMO criterio que el path de plantillas.
  return _sendToPrinter(lines, 'ticket', sale.id, isReprint, sale);
}

// ══════════════════════════════════════════════
// CONDUCE 80MM (nota de entrega, SIN precios)
// ──────────────────────────────────────────────
// Misma información que la factura pero solo descripción y cantidades —
// nunca precios ni totales. Se imprime opcionalmente después de la factura
// cuando el usuario marca la casilla en el modal de cobro. Documento sin
// valor fiscal; referencia el NCF de la factura si existe.
// ══════════════════════════════════════════════
function printConduce(sale) {
  if (!sale) return;

  const lines = [];
  lines.push(tCenter(CFG.biz));
  if (CFG.rnc)   lines.push(tCenter(`RNC: ${CFG.rnc}`));
  if (CFG.addr)  lines.push(tCenter(CFG.addr));
  if (CFG.phone) lines.push(tCenter(`Tel: ${CFG.phone}`));
  lines.push(tline());

  lines.push(tCenter('*** CONDUCE ***'));
  lines.push(tCenter('(Documento sin valor fiscal)'));
  lines.push(tline());

  lines.push(tRow(`No.: ${facturaLabel(sale)}`, `Fecha: ${sale.date || today()}`));
  lines.push(tRow(`Hora: ${sale.time || nowt()}`, `Cajero: ${(sale.cajero || '').split(' ')[0]}`));

  const cliName = sale.customer_name || sale.clientName || 'Consumidor Final';
  const cliRnc  = sale.customer_rnc  || sale.clientCedula || '';
  lines.push(tRow('Cliente:', cliName.slice(0, 28)));
  if (cliRnc) lines.push(tRow('RNC/Céd:', cliRnc));
  if (sale.customer_contact_name) lines.push(tRow('Solicitado por:', String(sale.customer_contact_name).slice(0, 26)));
  if (sale.customer_branch_name) lines.push(tRow('Entregar en:', String(sale.customer_branch_name).slice(0, 26)));
  // Enlaza el conduce con la factura fiscal, si tiene NCF.
  if (sale.ncf && String(sale.ncf).trim()) lines.push(tRow('Ref. NCF:', String(sale.ncf).trim()));

  lines.push(tline());
  lines.push(tRow('CANT', 'DESCRIPCIÓN'));
  lines.push(tline('-'));

  const items = sale.items || [];
  items.forEach(item => {
    const name = item.product_name || item.name || '';
    const qty  = item.qty || 1;
    const qtyStr  = String(qty);
    const maxName = THERMAL.cols - qtyStr.length - 4;   // "N x  " prefijo
    const nm = name.length > maxName ? name.slice(0, maxName - 1) + '…' : name;
    lines.push(`${qtyStr} x  ${nm}`);   // SIN precios — solo cantidad y descripción
  });

  lines.push(tline());
  const totalUnid = items.reduce((a, i) => a + (i.qty || 1), 0);
  lines.push(tRow('Total de artículos:', String(totalUnid)));
  lines.push('');
  lines.push('');
  lines.push(tCenter('___________________________'));
  lines.push(tCenter('Recibí conforme'));
  lines.push('');
  lines.push(tCenter('Entregado por / Firma'));
  lines.push(tline());
  lines.push('');
  lines.push('');

  _sendToPrinter(lines, 'conduce', sale.id, false);
}

// ══════════════════════════════════════════════
// CONDUCE FORMAL — documento de entrega (del módulo de Conduces)
// ──────────────────────────────────────────────
// Documento profesional para firmar en la entrega. NO fiscal: sin NCF, sin
// ITBIS, sin total a pagar, sin forma de pago, sin balance. Lleva la leyenda
// obligatoria "NO VÁLIDO COMO FACTURA". Precios de referencia: solo si
// conduce_show_prices='1' (apagado por defecto). Pasa por _openPrintWindow,
// así respeta la impresora configurada y la intercepción de "Guardar PDF".
// ══════════════════════════════════════════════
function printConduceDoc(dn) {
  if (!dn) return;
  const s = (typeof DB !== 'undefined' && DB.settings) || {};
  const biz   = s.biz_name || (typeof CFG !== 'undefined' && CFG.biz)   || 'Mi Negocio';
  const rnc   = s.biz_rnc  || (typeof CFG !== 'undefined' && CFG.rnc)   || '';
  const addr  = s.biz_addr || (typeof CFG !== 'undefined' && CFG.addr)  || '';
  const phone = s.biz_phone|| (typeof CFG !== 'undefined' && CFG.phone) || '';
  const logo  = s.biz_logo || '';
  const logo2 = s.biz_logo_2 || '';
  const showPrices = s.conduce_show_prices === '1';
  const esc = _escHtml;

  const STL = {
    borrador:'Borrador', preparado:'Preparado', despachado:'Despachado', parcial:'Parcial',
    entregado:'Entregado', facturado:'Facturado', anulado:'Anulado', devuelto:'Devuelto',
  };
  const origen = { manual:'Manual', cotizacion:'Cotización', factura:'Factura' };

  const itemsRows = (dn.items || []).map((it, i) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td class="mono">${esc(it.sku || '')}</td>
      <td>${esc(it.description || '')}${it.notes ? `<div class="obs">${esc(it.notes)}</div>` : ''}</td>
      <td style="text-align:center">${it.requested_qty}${(it.delivered_qty && it.delivered_qty !== it.requested_qty) ? ` <span class="obs">(entreg. ${it.delivered_qty})</span>` : ''}</td>
      <td style="text-align:center">${esc(it.unit || 'und')}</td>
      ${showPrices ? `<td style="text-align:right">—</td>` : ''}
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Conduce ${esc(dn.number || '')}</title>
<style>
  @page { size: letter; margin: 12mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; font-size:12px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #111; padding-bottom:8px; margin-bottom:10px; }
  .biz { font-size:17px; font-weight:800; }
  .muted { color:#555; font-size:11px; }
  .mono { font-family:'Courier New',monospace; font-size:11px; }
  .doc-title { text-align:right; }
  .doc-title .t { font-size:16px; font-weight:800; letter-spacing:.5px; }
  .doc-title .n { font-size:14px; font-weight:700; }
  .legend { background:#fff7ed; border:1.5px solid #f59e0b; color:#92400e; text-align:center;
            font-weight:800; font-size:12px; padding:7px; border-radius:6px; margin-bottom:12px; letter-spacing:.3px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:4px 18px; margin-bottom:12px; font-size:12px; }
  .grid .k { color:#555; }
  .grid .row { display:flex; gap:6px; }
  .grid .row b { min-width:auto; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:16px; }
  table.items th { background:#f3f4f6; text-align:left; padding:6px 8px; font-size:11px; border-bottom:1px solid #d1d5db; }
  table.items td { padding:6px 8px; border-bottom:1px solid #eee; vertical-align:top; }
  .obs { color:#777; font-size:10px; }
  .signs { display:flex; gap:40px; margin-top:34px; }
  .sign { flex:1; text-align:center; }
  .sign .line { border-top:1px solid #111; margin-top:26px; padding-top:5px; font-size:11px; color:#333; }
  .foot { margin-top:18px; text-align:center; color:#888; font-size:10px; }
</style></head>
<body>
  <div class="head">
    <div style="display:flex; gap:10px; align-items:flex-start">
      ${buildLogoHeader(logo, logo2, { unit:'px', maxW:70, maxH:60, align:'left' })}
      <div>
        <div class="biz">${esc(biz)}</div>
        ${rnc ? `<div class="muted">RNC: ${esc(rnc)}</div>` : ''}
        ${addr ? `<div class="muted">${esc(addr)}</div>` : ''}
        ${phone ? `<div class="muted">Tel: ${esc(phone)}</div>` : ''}
      </div>
    </div>
    <div class="doc-title">
      <div class="t">CONDUCE</div>
      <div class="muted">NOTA DE ENTREGA</div>
      <div class="n">${esc(dn.number || '')}</div>
      <div class="muted">${esc(dn.issue_date || '')}</div>
    </div>
  </div>

  <div class="legend">CONDUCE / NOTA DE ENTREGA — NO VÁLIDO COMO FACTURA. ESTE DOCUMENTO NO TIENE VALOR FISCAL.</div>

  <div class="grid">
    <div class="row"><span class="k">Cliente:</span> <b>${esc(dn.customer_name || 'Consumidor Final')}</b></div>
    <div class="row"><span class="k">Estado:</span> <b>${STL[dn.status] || dn.status}</b></div>
    ${dn.customer_rnc ? `<div class="row"><span class="k">RNC/Céd.:</span> <b>${esc(dn.customer_rnc)}</b></div>` : '<div></div>'}
    ${dn.customer_contact_name ? `<div class="row"><span class="k">Representante:</span> <b>${esc(dn.customer_contact_name)}${dn.customer_contact_role ? ` · ${esc(dn.customer_contact_role)}` : ''}</b></div>` : '<div></div>'}
    ${dn.customer_branch_name ? `<div class="row"><span class="k">Entregar en:</span> <b>${esc(dn.customer_branch_name)}${dn.customer_branch_code ? ` (Est. ${esc(dn.customer_branch_code)})` : ''}</b></div>` : ''}
    <div class="row"><span class="k">Origen:</span> <b>${origen[dn.source_type] || dn.source_type}${dn.source_id ? ' #' + dn.source_id : ''}</b></div>
    ${dn.delivery_address ? `<div class="row" style="grid-column:1/3"><span class="k">Dirección de entrega:</span> <b>${esc(dn.delivery_address)}</b></div>` : ''}
    ${dn.driver_name ? `<div class="row"><span class="k">Chofer:</span> <b>${esc(dn.driver_name)}</b></div>` : ''}
    ${dn.vehicle_plate ? `<div class="row"><span class="k">Vehículo:</span> <b>${esc(dn.vehicle_plate)}</b></div>` : ''}
    ${dn.notes ? `<div class="row" style="grid-column:1/3"><span class="k">Observaciones:</span> <b>${esc(dn.notes)}</b></div>` : ''}
  </div>

  <table class="items">
    <thead><tr>
      <th style="width:28px">#</th><th style="width:90px">Código</th><th>Descripción</th>
      <th style="width:70px;text-align:center">Cantidad</th><th style="width:56px;text-align:center">Unidad</th>
      ${showPrices ? '<th style="width:80px;text-align:right">Ref.</th>' : ''}
    </tr></thead>
    <tbody>${itemsRows || `<tr><td colspan="${showPrices ? 6 : 5}" style="text-align:center;color:#888;padding:16px">Sin artículos</td></tr>`}</tbody>
  </table>

  <div class="signs">
    <div class="sign"><div class="line">Entregado por</div></div>
    <div class="sign">
      <div class="line">Recibido por${dn.received_by_name ? ': ' + esc(dn.received_by_name) : ''}</div>
      <div class="obs" style="margin-top:3px">Cédula: ${esc(dn.received_by_document || '____________________')}</div>
    </div>
  </div>

  <div class="foot">Documento de entrega — sin valor fiscal · Generado por ${esc(biz)}</div>
</body></html>`;

  _openPrintWindow(html, 'conduce', dn.id, false);
}

// ══════════════════════════════════════════════
// RECIBO DE ABONO — usa la MISMA plantilla e impresora configuradas para las
// facturas. Solo Ventas puede cambiar la salida cuando existen varias impresoras.
// ══════════════════════════════════════════════
function printAbono({ payment, customer, cajero, isReprint = false }) {
  if (!payment || !customer) return;
  const paymentNumber = typeof reciboLabel === 'function'
    ? reciboLabel(payment)
    : String(payment.id).padStart(5, '0');
  const amount = Number(payment.amount || 0);
  const cancelled = String(payment.status || 'active').toLowerCase() === 'cancelled';
  const allocations = typeof paymentAllocationsOf === 'function'
    ? paymentAllocationsOf(payment) : [];
  const allocatedAmount = allocations.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const receiptItems = allocations.map(row => {
    const label = typeof paymentAllocationLabel === 'function'
      ? paymentAllocationLabel(row) : `#${row.sale_id}`;
    return {
      product_code: 'ABONO',
      product_name: `Abono a ${label}${row.ncf ? ` · NCF ${row.ncf}` : ''}`,
      qty: 1, unit_price: Number(row.amount || 0), subtotal: Number(row.amount || 0),
      taxable: 0, tax_pct: 0, tax_amt: 0, net_subtotal: Number(row.amount || 0),
    };
  });
  const historicalAmount = Math.max(0, Math.round((amount - allocatedAmount) * 100) / 100);
  if (historicalAmount > 0.005 || !receiptItems.length) {
    receiptItems.push({
      product_code: 'ABONO',
      product_name: 'Aplicación a saldo histórico sin factura identificada',
      qty: 1, unit_price: historicalAmount || amount, subtotal: historicalAmount || amount,
      taxable: 0, tax_pct: 0, tax_amt: 0, net_subtotal: historicalAmount || amount,
    });
  }
  return printReceipt({
    id: payment.id,
    type: 'abono',
    document_kind: payment.document_kind || 'abono',
    document_number: payment.document_number,
    document_number_fmt: payment.document_number_fmt || paymentNumber,
    receipt_number: paymentNumber,
    transaction_number: paymentNumber,
    date: (payment.created_at || today()).split('T')[0].split(' ')[0],
    customer_id: payment.customer_id || customer.id || null,
    customer_name: customer.name || payment.customer_name || '',
    customer_rnc: customer.rnc || payment.customer_rnc || '',
    customer_phone: customer.phone || payment.customer_phone || '',
    customer_contact_id: payment.customer_contact_id || null,
    customer_contact_name: payment.customer_contact_name || '',
    customer_contact_document: payment.customer_contact_document || '',
    customer_contact_role: payment.customer_contact_role || '',
    customer_contact_phone: payment.customer_contact_phone || '',
    cajero: cajero || payment.cajero || '',
    applied_invoice: payment.applied_invoice ||
      (typeof paymentInvoiceSummary === 'function' ? paymentInvoiceSummary(payment) : ''),
    payment_allocations: allocations,
    original_sale_id: payment.sale_id || null,
    items: receiptItems,
    subtotal: amount,
    tax_pct: 0,
    tax_amt: 0,
    total: amount,
    payment_method: payment.method || 'efectivo',
    payment_amount: amount,
    paid_amount: amount,
    balance_before: Number(payment.balance_before || 0),
    balance_after: Number(payment.balance_after || 0),
    balance_after_payment: Number(payment.balance_after || 0),
    status: cancelled ? 'cancelled' : 'completed',
    cancel_reason: cancelled ? (payment.void_reason || 'Abono anulado') : '',
    notes: [
      cancelled ? `ANULADO — ${payment.void_reason || 'Sin motivo registrado'}` : '',
      !cancelled && payment.replaces_payment_id
        ? `Corrige recibo ${payment.replaces_payment_document_number_fmt || '#' + payment.replaces_payment_id}`
        : '',
      payment.note && payment.note !== 'Abono' ? payment.note : '',
    ].filter(Boolean).join(' · '),
    print_template_id: DB?.settings?.print_template || '',
    print_printer_name: DB?.settings?.printer || '',
  }, isReprint);
}

// ══════════════════════════════════════════════
// RECIBO DE PAGO A PROVEEDOR 80MM
// ══════════════════════════════════════════════
function printPagoProveedor({ payment, expense, cajero }) {
  if (!payment || !expense) return;

  const lines = [];
  lines.push(tCenter(CFG.biz));
  if (CFG.rnc)   lines.push(tCenter(`RNC: ${CFG.rnc}`));
  if (CFG.phone) lines.push(tCenter(`Tel: ${CFG.phone}`));
  lines.push(tline());
  lines.push(tCenter('*** PAGO A PROVEEDOR ***'));
  lines.push(tline());
  const paymentNumber = payment.document_number_fmt
    || (payment.document_number ? `PPR-${String(payment.document_number).padStart(6, '0')}` : '')
    || `PPR-${String(payment.id).padStart(6,'0')}`;
  lines.push(tRow(`No.: ${paymentNumber}`,
    `Fecha: ${(payment.created_at || today()).split('T')[0].split(' ')[0]}`));
  lines.push(tRow('Cajero:', (cajero || '').split(' ')[0]));
  lines.push(tline());
  lines.push(tRow('Proveedor:', (expense.supplier_name || 'N/A').slice(0, 28)));
  if (expense.supplier_rnc) lines.push(tRow('RNC:', expense.supplier_rnc));
  lines.push(tRow('Concepto:', (expense.description || '').slice(0, 28)));
  if (expense.invoice_number) lines.push(tRow('Factura No.:', expense.invoice_number));
  lines.push(tline());
  lines.push(tRow('Total del gasto:', fmt(expense.total || 0)));
  lines.push(tRow('Balance anterior:', fmt(payment.balance_before || 0)));
  lines.push(tRow('Monto pagado:', fmt(payment.amount || 0)));
  lines.push(tlineD());
  lines.push(tRow('BALANCE PENDIENTE:', fmt(payment.balance_after || 0)));
  lines.push(tlineD());
  lines.push('');
  lines.push(tRow('Método:', (payment.method || 'efectivo').toUpperCase()));
  if (payment.reference) lines.push(tRow('Referencia:', payment.reference.slice(0, 28)));
  if (payment.notes)     lines.push(tRow('Nota:', payment.notes.slice(0, 30)));
  lines.push('');
  lines.push(tCenter('Comprobante interno de pago'));
  lines.push(tline());
  lines.push('');
  lines.push('');

  _sendToPrinter(lines, 'pago_proveedor', payment.id);
}

// ══════════════════════════════════════════════
// CIERRE DE CAJA 80MM
// ══════════════════════════════════════════════
function printCierreCaja(data) {
  if (!data) return;

  const {
    cajero, openDate, openTime, closeTime,
    openAmount, totalEfec, totalCard, totalTrans,
    totalCred, totalAbonos, totalDevolucion,
    expected, counted, diff,
    salesCount, salesTotal,
  } = data;

  const lines = [];
  lines.push(tCenter(CFG.biz));
  if (CFG.rnc) lines.push(tCenter(`RNC: ${CFG.rnc}`));
  lines.push(tline());
  lines.push(tCenter('*** CIERRE DE CAJA ***'));
  lines.push(tline());
  lines.push(tRow('Cajero:', (cajero || '').slice(0, 28)));
  lines.push(tRow('Apertura:', `${openDate || ''} ${openTime || ''}`));
  lines.push(tRow('Cierre:', `${openDate || ''} ${closeTime || nowt()}`));
  lines.push(tline());
  lines.push(tCenter('RESUMEN DE VENTAS'));
  lines.push(tline('-'));
  lines.push(tRow('Total facturas:', String(salesCount || 0)));
  lines.push(tRow('Total vendido:', fmt(salesTotal || 0)));
  lines.push('');
  lines.push(tRow('Ventas efectivo:', fmt(totalEfec || 0)));
  lines.push(tRow('Ventas tarjeta:', fmt(totalCard || 0)));
  lines.push(tRow('Ventas transferencia:', fmt(totalTrans || 0)));
  lines.push(tRow('Ventas crédito:', fmt(totalCred || 0)));
  if (totalAbonos > 0)
    lines.push(tRow('Abonos recibidos:', fmt(totalAbonos)));
  if (totalDevolucion > 0)
    lines.push(tRow('Devoluciones:', `-${fmt(totalDevolucion)}`));
  lines.push(tline());
  lines.push(tCenter('CUADRE DE CAJA'));
  lines.push(tline('-'));
  lines.push(tRow('Fondo inicial:', fmt(openAmount || 0)));
  lines.push(tRow('Efectivo esperado:', fmt(expected || 0)));
  lines.push(tRow('Efectivo contado:', fmt(counted || 0)));
  lines.push(tlineD());
  const diffAbs = Math.abs(diff || 0);
  const diffLabel = (diff || 0) >= 0 ? 'SOBRANTE:' : 'FALTANTE:';
  lines.push(tRow(diffLabel, fmt(diffAbs)));
  lines.push(tlineD());
  lines.push('');
  lines.push(tCenter(
    (diff || 0) === 0 ? '✓ CAJA CUADRADA'
    : (diff || 0) > 0  ? '▲ SOBRANTE EN CAJA'
                       : '▼ FALTANTE EN CAJA'
  ));
  lines.push('');
  lines.push(tCenter('Firma: _____________________'));
  lines.push(tline());
  lines.push('');
  lines.push('');

  _sendToPrinter(lines, 'cierre', null);
}

// ══════════════════════════════════════════════
// MOTOR INTERNO — ENVIAR A IMPRESORA
// ══════════════════════════════════════════════
function _sendToPrinter(lines, jobType = '', referenceId = null, isReprint = false, brandingSale = null) {
  const categoryPrinter = _getCategoryConfig(_categoryForJobType(jobType)).printer || _getSavedPrinter();
  // Si la impresora es de cartuchos/carta y no se llegó acá desde una plantilla,
  // usar plantilla carta_recibo automáticamente (el contenido de líneas no se adapta bien a carta)
  const _printerTypeCheck = typeof detectPrinterType === 'function'
    ? detectPrinterType(categoryPrinter) : 'unknown';
  if (_printerTypeCheck === 'carta' && typeof getPlantilla === 'function') {
    const _cartaPlant = getPlantilla(DB?.settings?.print_template || 'carta_recibo');
    if (_cartaPlant && _cartaPlant.tipo === 'carta') {
      // Ya hay una plantilla carta activa — no hacer nada, dejar flujo normal
      // (esta función solo se llama desde fallback clásico sin plantilla)
    }
    // No interrumpir — continuar con el HTML adaptado abajo
  }

  const logoB64  = DB?.settings?.biz_logo   || CFG?.biz_logo   || '';
  const logoB64b = DB?.settings?.biz_logo_2 || CFG?.biz_logo_2 || '';

  const logoInner = buildLogoHeader(logoB64, logoB64b, {
    unit: 'px', maxW: 160, maxH: 60, align: 'center', split: true,
    filter: 'grayscale(100%) contrast(150%)',
  });
  const logoHtml = logoInner
    ? `<div style="margin-bottom:6px">${logoInner}</div>`
    : '';

  const content = lines
    .map(l => `<div class="ln">${_escHtml(l)}</div>`)
    .join('');

  const profile = _getTicketPrinterProfile(categoryPrinter);
  const isThermal = profile.kind !== 'sheet';
  const paperWidth = profile.widthMm || 80;
  const printableWidth = Math.min(paperWidth, profile.printableWidthMm || paperWidth - 4);

  // Firma promocional VELO POS también en el ticket clásico (sin plantilla).
  // Mismo gate que el path de plantillas (renderInvoiceBranding → _esFacturaOficial):
  // solo facturas/devoluciones/abonos, nunca cotización/conduce/reporte. Si la
  // librería o el QR fallan, devuelve '' y el ticket se imprime igual.
  let brandingHtml = '';
  if (brandingSale && typeof renderInvoiceBranding === 'function') {
    try {
      brandingHtml = renderInvoiceBranding(
        {
          invoice_branding_enabled: DB?.settings?.invoice_branding_enabled ?? '1',
          invoice_branding_url:     DB?.settings?.invoice_branding_url  || 'https://wa.link/39cwoi',
          invoice_branding_text:    DB?.settings?.invoice_branding_text || 'Sistema de facturación impulsado por VELO POS',
          invoice_branding_cta:     DB?.settings?.invoice_branding_cta  || 'Solicita tu demostración',
        },
        brandingSale,
        isThermal ? 'termica' : 'a4',
        printableWidth
      ) || '';
    } catch (_e) { brandingHtml = ''; }
  }
  const sideMargin = Math.max(0, (paperWidth - printableWidth) / 2);
  const pageCSS = isThermal
    ? `@page { size: ${paperWidth}mm auto; margin: 2mm ${sideMargin}mm 4mm ${sideMargin}mm; }`
    : '@page { size: letter; margin: 15mm 15mm 15mm 15mm; }';
  const bodyCSS = isThermal
    ? `width: ${printableWidth}mm; max-width: ${printableWidth}mm; font-family: 'Courier New', Courier, monospace; font-size: 11.5px; line-height: 1.4;`
    : 'width: 100%; max-width: 180mm; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.5;';
  const mediaCSS = isThermal
    ? `html { width: ${paperWidth}mm; } body { width: ${printableWidth}mm; }`
    : 'html, body { width: 100%; }';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Ticket</title>
<style>
  ${pageCSS}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    ${bodyCSS}
    color: #000; background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .ln { white-space: pre; word-break: break-all; display: block; width: 100%; }
  img { display: block; margin: 0 auto; }
  @media print {
    ${mediaCSS}
    * { -webkit-print-color-adjust: exact !important; }
  }
</style>
</head>
<body>${logoHtml}${content}${brandingHtml}
</body></html>`;

  _openPrintWindow(html, jobType, referenceId, isReprint);
  return html;
}

// ── Abrir ventana de impresión ────────────────
// Cuando está activo, el próximo documento que pase por _openPrintWindow se
// GUARDA como PDF en vez de imprimirse. Es un punto único: cubre factura,
// cotización, conduce, abono, reportes, etc. sin duplicar lógica.
// Se guarda en window.* para compartir un binding único entre todos los scripts.
window._pdfSaveRequest = null;
window._pdfWhatsAppRequest = null;
window._printPreviewJob = null;
window._printPreviewBypass = false;

// Envuelve la llamada de impresión de cualquier documento para guardarlo en PDF.
// Uso: guardarDocumentoPDF(() => printReceipt(sale, true), 'Factura-00123')
function guardarDocumentoPDF(buildAndPrintFn, suggestedName) {
  const request = { name: suggestedName || 'documento' };
  window._pdfSaveRequest = request;

  const finishWithHTML = (html) => {
    // Normalmente _openPrintWindow consume esta solicitud y abre el preview.
    // Si una ruta solo retorna HTML, lo usamos como respaldo para que PDF e
    // impresión siempre partan del mismo documento.
    if (typeof html === 'string' && html.trim() && window._pdfSaveRequest === request) {
      window._pdfSaveRequest = null;
      _openPrintPreview(html, {
        jobType: 'documento',
        mode: 'pdf',
        suggestedName: request.name,
        source: 'html',
      });
      return;
    }
    if (window._pdfSaveRequest === request) window._pdfSaveRequest = null;
  };

  try {
    const result = (typeof buildAndPrintFn === 'function') ? buildAndPrintFn() : buildAndPrintFn;
    if (result && typeof result.then === 'function') {
      result.then(finishWithHTML).catch(e => {
        if (window._pdfSaveRequest === request) window._pdfSaveRequest = null;
        toast(e?.message || 'No se pudo preparar el PDF', 'err');
      });
      return;
    }
    finishWithHTML(result);
  } catch (e) {
    if (window._pdfSaveRequest === request) window._pdfSaveRequest = null;
    toast(e?.message || 'No se pudo preparar el PDF', 'err');
  }
}

// Genera el mismo PDF que se imprime, lo deja temporalmente disponible y abre
// el flujo universal de WhatsApp. WhatsApp Web/Desktop no permite a una URL
// adjuntar archivos automáticamente; por eso se revela el PDF listo para
// arrastrar/adjuntar, sin fingir que fue enviado.
function enviarDocumentoPDFWhatsApp(buildAndPrintFn, suggestedName, options = {}) {
  const request = {
    name: suggestedName || 'documento',
    message: options.message || '',
    phone: options.phone || '',
    clientName: options.clientName || 'cliente',
  };
  window._pdfWhatsAppRequest = request;

  const finishWithHTML = (html) => {
    if (typeof html === 'string' && html.trim() && window._pdfWhatsAppRequest === request) {
      window._pdfWhatsAppRequest = null;
      _prepareWhatsAppPDF(html, request);
      return;
    }
    if (window._pdfWhatsAppRequest === request) window._pdfWhatsAppRequest = null;
  };
  try {
    const result = typeof buildAndPrintFn === 'function' ? buildAndPrintFn() : buildAndPrintFn;
    if (result && typeof result.then === 'function') {
      result.then(finishWithHTML).catch(e => {
        if (window._pdfWhatsAppRequest === request) window._pdfWhatsAppRequest = null;
        toast(e?.message || 'No se pudo preparar el PDF', 'err');
      });
      return;
    }
    finishWithHTML(result);
  } catch (e) {
    if (window._pdfWhatsAppRequest === request) window._pdfWhatsAppRequest = null;
    toast(e?.message || 'No se pudo preparar el PDF', 'err');
  }
}

async function _prepareWhatsAppPDF(html, request) {
  if (!window.api?.print?.toPDF) {
    toast('Generación de PDF no disponible', 'err');
    return;
  }
  const result = await window.api.print.toPDF({
    html,
    suggestedName: request.name,
    temporary: true,
  });
  if (!result?.ok || !result.path) {
    toast(result?.error || 'No se pudo preparar el PDF', 'err');
    return;
  }
  openWhatsAppModal(
    request.message,
    request.phone,
    request.clientName,
    {
      attachmentPath: result.path,
      attachmentName: result.name || (
        String(request.name || 'Documento').toLowerCase().endsWith('.pdf')
          ? request.name : `${request.name}.pdf`
      )
    }
  );
}

async function _guardarPDF(html, suggestedName) {
  if (!window.api?.print?.toPDF) { toast('Guardar PDF no disponible', 'err'); return; }
  const raw = String(html || '');
  const visibleText = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .trim();
  if (!visibleText && !/<img\b/i.test(raw)) {
    toast('El documento no tiene contenido para guardar', 'err');
    return { ok: false, error: 'Documento vacío' };
  }
  const r = await window.api.print.toPDF({ html, suggestedName });
  if (r?.ok) toast('✓ PDF guardado');
  else if (!r?.canceled) toast(r?.error || 'No se pudo guardar el PDF', 'err');
  return r;
}

function _printPreviewLabel(jobType, mode) {
  const category = _categoryForJobType(jobType);
  const label = PRINT_CATEGORIES[category]?.label || 'Documento';
  return mode === 'pdf' ? `Guardar PDF · ${label}` : `Vista previa · ${label}`;
}

function _suggestedPrintName(jobType, referenceId) {
  const base = String(jobType || _categoryForJobType(jobType) || 'documento')
    .replace(/[^\w\-. ]/g, '_') || 'documento';
  return referenceId ? `${base}-${String(referenceId).padStart(5, '0')}` : base;
}

function _htmlForPreview(html) {
  html = _ensureUtf8HTML(html);
  const previewStyle = `
    <style>
      @media screen {
        .no-print, #_velo_toolbar { display:none !important; }
        html { background:#f3f4f6 !important; }
        body { margin-left:auto !important; margin-right:auto !important; }
      }
    </style>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${previewStyle}</head>`)
    : previewStyle + html;
}

function _openPrintPreview(html, opts = {}) {
  if (!html) { toast('No hay contenido para mostrar', 'err'); return; }
  if (typeof openModal !== 'function') {
    if (opts.mode === 'pdf') _guardarPDF(html, opts.suggestedName);
    else _dispatchPrintWindow(html, opts.jobType, opts.referenceId, opts.isReprint);
    return;
  }

  const job = {
    html,
    jobType: opts.jobType || '',
    referenceId: opts.referenceId ?? null,
    isReprint: !!opts.isReprint,
    suggestedName: opts.suggestedName || _suggestedPrintName(opts.jobType, opts.referenceId),
    mode: opts.mode || 'print',
    source: opts.source || 'document',
    printOptions: opts.printOptions || {},
  };
  window._printPreviewJob = job;

  const primaryLabel = job.mode === 'pdf' ? 'Guardar PDF' : 'Imprimir';
  const primaryAction = job.mode === 'pdf' ? '_printPreviewSavePDF()' : '_printPreviewPrint()';
  openModal(`
    <div class="modal-title">${_escHtml(_printPreviewLabel(job.jobType, job.mode))}</div>
    <div class="modal-sub">Revisa el documento antes de imprimir o guardar.</div>
    <div style="border:1px solid var(--line);border-radius:10px;background:#fff;overflow:hidden">
      <iframe id="_print_preview_frame"
        title="Vista previa de impresión"
        style="width:100%;height:min(68vh,720px);border:0;background:#fff;display:block"></iframe>
    </div>
    <div class="modal-foot" style="flex-wrap:wrap">
      <button class="btn btn-out" onclick="_printPreviewClose()">Cerrar</button>
      ${job.mode === 'pdf'
        ? `<button class="btn btn-out" onclick="_printPreviewPrint()">${svg('print')} Imprimir</button>`
        : `<button class="btn btn-out" onclick="_printPreviewSavePDF()">${svg('pdf')} Guardar PDF</button>`}
      <button class="btn btn-dark" onclick="${primaryAction}">
        ${job.mode === 'pdf' ? svg('pdf') : svg('print')} ${primaryLabel}
      </button>
    </div>
  `, 'modal-xl');

  const frame = document.getElementById('_print_preview_frame');
  if (frame) frame.srcdoc = _htmlForPreview(html);
}

function _printPreviewClose() {
  window._printPreviewJob = null;
  window._printAfter = null;   // cerró sin imprimir → cancelar el encadenado (ej. conduce)
  if (typeof closeModal === 'function') closeModal();
}

function _printNeedsReportNumber(job) {
  const category = _categoryForJobType(job?.jobType);
  return ['reporte', 'contabilidad', 'bancos', 'caja'].includes(category);
}

function _injectPrintedDocumentNumber(html, number) {
  if (!number || String(html).includes('data-velo-document-number=')) return html;
  const stamp = `<div data-velo-document-number="${_escHtml(number)}"
    style="font-family:Arial,sans-serif;font-size:9px;color:#6b7280;text-align:right;
           max-width:100%;margin:0 0 6px;padding:0 2px">
    Documento: <strong>${_escHtml(number)}</strong>
  </div>`;
  return String(html).includes('<body')
    ? String(html).replace(/(<body[^>]*>)/i, `$1${stamp}`)
    : stamp + String(html);
}

async function _ensurePrintDocumentNumber(job) {
  if (!job || !_printNeedsReportNumber(job) || job.documentNumber) return job;
  if (!window.api?.documents?.issue) return job;
  const sourceId = `print:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const result = await window.api.documents.issue({
    kind: 'reporte',
    sourceType: 'print_job',
    sourceId,
  });
  if (!result?.ok || !result.data?.formatted_number) {
    throw new Error(result?.error || 'No se pudo asignar el número del reporte');
  }
  job.documentNumber = result.data.formatted_number;
  job.html = _injectPrintedDocumentNumber(job.html, job.documentNumber);
  job.suggestedName = `${job.suggestedName || 'Reporte'}-${job.documentNumber}`;
  return job;
}

async function _printPreviewSavePDF() {
  const job = window._printPreviewJob;
  if (!job) return;
  try {
    await _ensurePrintDocumentNumber(job);
    await _guardarPDF(job.html, job.suggestedName);
  } catch (e) {
    toast(e?.message || 'No se pudo numerar el reporte', 'err');
  }
}

async function _printPreviewPrint() {
  const job = window._printPreviewJob;
  if (!job) return;
  try {
    await _ensurePrintDocumentNumber(job);
  } catch (e) {
    toast(e?.message || 'No se pudo numerar el reporte', 'err');
    return;
  }
  window._printPreviewJob = null;
  if (typeof closeModal === 'function') closeModal();
  window._printPreviewBypass = true;
  try {
    if (job.source === 'html') _dispatchPrintHTML(job.html, job.jobType || 'reporte');
    else _openPrintWindow(job.html, job.jobType, job.referenceId, job.isReprint, job.printOptions || {});
  } finally {
    window._printPreviewBypass = false;
  }
  // Encadenar la siguiente impresión (ej. el conduce DESPUÉS de la factura),
  // ya con el modal de la factura cerrado, para que no se pisen.
  const after = window._printAfter;
  window._printAfter = null;
  if (typeof after === 'function') setTimeout(after, 250);
}

// ── Multi-terminal: elección de destino de impresión ─────────────────────────
// Solo aplica a una terminal CLIENTE sin impresora local. En local/servidor o con
// impresora configurada devuelve false → flujo de impresión normal (sin cambios).
function _shouldOfferServerPrint(jobType = 'ticket') {
  const mode = (typeof CFG !== 'undefined' && CFG.connectionMode) || 'local';
  const category = _categoryForJobType(jobType);
  const route = _getCategoryConfig(category);
  return mode === 'client' && !route.printer;
}

function _offerPrintTarget(html, jobType, referenceId) {
  window._pendingPrint = { html, jobType, referenceId };
  if (typeof openModal !== 'function') { _openPrintWindowFallback(html); return; }
  openModal(`
    <div class="modal-title">¿Dónde imprimir?</div>
    <div class="modal-sub">Esta terminal no tiene impresora configurada.</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">
      <button class="btn btn-dark"  onclick="_printTargetServer()">🖨️ Imprimir en el mostrador (servidor)</button>
      <button class="btn btn-out"   onclick="_printTargetHere()">Imprimir aquí (elegir impresora)</button>
      <button class="btn btn-ghost" onclick="window._pendingPrint=null;closeModal()">Cancelar</button>
    </div>
  `);
}

function _printTargetServer() {
  const pj = window._pendingPrint; window._pendingPrint = null;
  if (typeof closeModal === 'function') closeModal();
  if (!pj) return;
  const route = _getCategoryConfig(_categoryForJobType(pj.jobType));
  window.api.print.onServer({
    html: pj.html,
    jobType: pj.jobType,
    referenceId: pj.referenceId,
    userId: (typeof user !== 'undefined' && user?.id) || null,
    channel: route.channel || '',
    copies: route.copies || 1,
    userConfirmed: true,
  })
    .then(r => toast(r && r.ok ? '✓ Enviado a la impresora del mostrador' : (r && r.error) || 'No se pudo imprimir en el servidor', r && r.ok ? 's' : 'err'))
    .catch(() => toast('Sin conexión al servidor', 'err'));
}

function _printTargetHere() {
  const pj = window._pendingPrint; window._pendingPrint = null;
  if (typeof closeModal === 'function') closeModal();
  if (pj) _openPrintWindowFallback(pj.html);   // flujo normal: ventana con diálogo/impresora
}

function _openPrintWindow(html, jobType = '', referenceId = null, isReprint = false, printOptions = {}) {
  if (window._pdfWhatsAppRequest) {
    const request = window._pdfWhatsAppRequest;
    window._pdfWhatsAppRequest = null;
    _prepareWhatsAppPDF(html, request);
    return;
  }
  // Intercepción: si se pidió guardar en PDF, mostrar preview y guardar desde ahí.
  if (window._pdfSaveRequest) {
    const name = window._pdfSaveRequest.name;
    window._pdfSaveRequest = null;
    _openPrintPreview(html, { jobType, referenceId, isReprint, mode: 'pdf', suggestedName: name, printOptions });
    return;
  }
  const category = _categoryForJobType(jobType);
  const categoryConfig = _getCategoryConfig(category);
  // Política global: ningún documento se envía automáticamente al spooler.
  // Confirmar una operación solo abre el display; imprimir exige el botón
  // explícito del usuario dentro de esa vista previa.
  const shouldPreview = true;
  if (!window._printPreviewBypass && shouldPreview) {
    _openPrintPreview(html, { jobType, referenceId, isReprint, mode: 'print', printOptions });
    return;
  }

  _dispatchPrintWindow(html, jobType, referenceId, isReprint, printOptions);
  // En el flujo VELO directo no hay modal que dispare el documento encadenado.
  // Dar tiempo al spooler antes de enviar, por ejemplo, el conduce posterior.
  const after = window._printAfter;
  window._printAfter = null;
  if (typeof after === 'function') setTimeout(after, 1200);
}

function _dispatchPrintWindow(html, jobType = '', referenceId = null, isReprint = false, printOptions = {}) {
  // Multi-terminal: terminal cliente SIN impresora física → ofrecer imprimir en
  // el servidor (mostrador) o aquí eligiendo impresora. En local/servidor o con
  // impresora configurada, no aplica (flujo normal).
  if (_shouldOfferServerPrint(jobType)) {
    _offerPrintTarget(html, jobType, referenceId);
    return;
  }

  const category = _categoryForJobType(jobType);
  const catCfg    = _getCategoryConfig(category);

  const printerName = printOptions.printerName || catCfg.printer
    || (catCfg.bindingConfigured ? '' : _getSavedPrinter());
  const selectedProfileId = printOptions.profileId || catCfg.profileId || '';
  const profile = selectedProfileId && typeof resolvePrinterProfile === 'function'
    ? resolvePrinterProfile(printerName, 'ticket', {
        ...(DB?.settings || {}),
        printer_profile: selectedProfileId,
      })
    : (catCfg.profileConfigured && typeof resolvePrinterProfile === 'function'
      ? resolvePrinterProfile(printerName, 'ticket', {
          ...(DB?.settings || {}),
          printer_profile: '',
          printer_type: '',
        })
      : _getTicketPrinterProfile(printerName));
  let printerType = typeof printerProfileLegacyType === 'function'
    ? printerProfileLegacyType(profile)
    : (typeof detectPrinterType === 'function' ? detectPrinterType(printerName) : 'unknown');

  // Si el cobro fijó una plantilla explícita, el PAPEL lo manda la plantilla
  // (carta vs térmica), no el perfil adivinado de la impresora. Evita mandar
  // una factura de hoja a una térmica (o al revés) al elegir salida en el POS.
  if (printOptions.templateId && typeof getPlantilla === 'function') {
    const _tpl = getPlantilla(printOptions.templateId);
    if (_tpl) printerType = _tpl.tipo === 'carta' ? 'carta' : 'thermal';
  }

  // Térmica: aplicar la densidad configurada (glifos más gruesos/oscuros) para
  // que no salga muy clara. Complementa la densidad del driver de la impresora.
  if (printerType !== 'carta') html = _injectThermalDensity(html);

  // ── Impresoras carta/cartuchos ────────────────────────────────────────────
  // silent:false → Electron abre diálogo con vista previa
  // Pasar printerName para usar la impresora guardada (no la predeterminada)
  // NO pasar printerWidth → main.js detecta isThermal=false → pageSize:Letter
  if (printerType === 'carta') {
    const _activeTemplateId = printOptions.templateId || DB?.settings?.print_template || '';
    const _pageHint = _activeTemplateId === 'media_carta' ? 'half-letter' : undefined;
    if (window.api?.print?.html) {
      _printDispatch({
        html,
        printerName:  printerName || undefined,
        // sin printerWidth → isThermal=false en main.js
        pageHint:     _pageHint,
        jobType,
        referenceId,
        userId: user?.id || null,
        copies: Math.max(1, parseInt(printOptions.copies || catCfg.copies, 10) || 1),
      }).then(result => {
        if (!result?.ok && !result?.duplicate) {
          if (result?.error && result.error !== 'Impresión cancelada o fallida') {
            toast(`Error de impresión: ${result.error}`, 'err');
          }
          _openPrintWindowFallback(html);
        }
      }).catch(() => _openPrintWindowFallback(html));
      return;
    }
    _openPrintWindowFallback(html);
    return;
  }

  // ── Impresora no reconocida (unknown) ─────────────────────────────────────
  // Si la plantilla activa es tipo carta → flujo carta
  // Si no → fallback (window.open con botón Imprimir)
  if (printerType === 'unknown') {
    const _activePlant = (typeof getPlantilla === 'function' && DB?.settings?.print_template)
      ? getPlantilla(DB.settings.print_template) : null;
    if (_activePlant && _activePlant.tipo === 'carta') {
      const _pageHint = DB.settings.print_template === 'media_carta' ? 'half-letter' : undefined;
      if (window.api?.print?.html) {
        _printDispatch({
          html,
          printerName:  printerName || undefined,
          pageHint:     _pageHint,
          jobType, referenceId,
          userId: user?.id || null,
          copies: Math.max(1, parseInt(printOptions.copies || catCfg.copies, 10) || 1),
        }).then(result => {
          if (!result?.ok && !result?.duplicate) _openPrintWindowFallback(html);
        }).catch(() => _openPrintWindowFallback(html));
        return;
      }
    }
    _openPrintWindowFallback(html);
    return;
  }

  // ── Impresoras térmicas (58mm / 80mm): API nativa Electron, silent:true ──
  const printerWidth = Math.round((profile.widthMm || 80) * 1000);

  if (window.api?.print?.html) {
    _printDispatch({
      html,
      printerName:  printerName || undefined,
      // También se pasa sin impresora elegida: Electron abre el diálogo, pero
      // conserva el tamaño real del rollo en lugar de asumir una hoja Letter.
      printerWidth,
      jobType,
      referenceId,
      userId: user?.id || null,
      copies: Math.max(1, parseInt(printOptions.copies || catCfg.copies, 10) || 1),
    }).then(result => {
      if (!result?.ok && !result?.duplicate) {
        if (result?.error && result.error !== 'Impresión cancelada o fallida') {
          toast(`Error de impresión: ${result.error}`, 'err');
        }
        _openPrintWindowFallback(html);
      }
    }).catch(() => _openPrintWindowFallback(html));
    return;
  }

  _openPrintWindowFallback(html);
}

function _openPrintWindowFallback(html) {
  html = _ensureUtf8HTML(html);
  // Inyectar botones de control en el HTML.
  //  · Barra fija ABAJO-derecha para no tapar el encabezado del documento
  //    (la caja "FACTURA N." / número vive arriba-derecha).
  //  · @media print → la barra NUNCA se imprime ni se hornea al "Guardar PDF"
  //    desde el diálogo de impresión del sistema.
  const toolbar = `
    <style>
      #_velo_toolbar { position:fixed; bottom:14px; left:14px; z-index:2147483647;
        display:flex; gap:8px; }
      #_velo_toolbar button { border:none; padding:9px 18px; border-radius:8px;
        font-size:13px; font-weight:700; cursor:pointer; font-family:Arial,sans-serif;
        box-shadow:0 4px 14px rgba(0,0,0,.22); }
      @media print { #_velo_toolbar { display:none !important; } }
    </style>
    <div id="_velo_toolbar">
      <button onclick="window.print()" style="background:#16a34a;color:#fff">🖨️ Imprimir</button>
      <button onclick="window.close()" style="background:#6b7280;color:#fff">Cerrar</button>
    </div>`;
  const htmlConBoton = html.includes('</body>')
    ? html.replace('</body>', `${toolbar}</body>`)
    : html + toolbar;

  // window.open estándar — abre ventana visible con botón Imprimir/Cerrar
  try {
    const win = window.open('', '_blank',
      'width=794,height=900,scrollbars=yes,resizable=yes');
    if (win) {
      win.document.open('text/html', 'replace');
      win.document.write(htmlConBoton);
      win.document.close();
      win.focus();
      return;
    }
  } catch(e) { console.warn('[print] window.open falló, usando iframe:', e.message); }

  // Último recurso: crear iframe oculto y imprimir
  _printViaIframe(htmlConBoton);
}

function _printViaIframe(html) {
  // Eliminar iframe previo si existe
  const prev = document.getElementById('_velo_print_frame');
  if (prev) prev.remove();

  const iframe = document.createElement('iframe');
  iframe.id = '_velo_print_frame';
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:794px;height:900px;border:none;';
  document.body.appendChild(iframe);

  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch(e) {
        toast('Error al imprimir. Intenta de nuevo.', 'err');
      }
    }, 300);
  };

  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
}

// ══════════════════════════════════════════════
// printHTML — Para reportes A4 (se mantiene igual)
// ══════════════════════════════════════════════
function printHTML(html, category = 'reporte') {
  html = _ensureUtf8HTML(html);
  if (window._pdfWhatsAppRequest) {
    const request = window._pdfWhatsAppRequest;
    window._pdfWhatsAppRequest = null;
    _prepareWhatsAppPDF(html, request);
    return;
  }
  // Intercepción para "Guardar PDF" (mismo mecanismo que _openPrintWindow).
  if (window._pdfSaveRequest) {
    const name = window._pdfSaveRequest.name;
    window._pdfSaveRequest = null;
    _openPrintPreview(html, { jobType: category, mode: 'pdf', suggestedName: name, source: 'html' });
    return;
  }
  const resolvedCategory = _categoryForJobType(category);
  // Los reportes, estados y cierres obedecen la misma política que facturas:
  // primero se muestran; solo el botón Imprimir del display despacha el trabajo.
  if (!window._printPreviewBypass) {
    _openPrintPreview(html, { jobType: category, mode: 'print', source: 'html' });
    return;
  }

  _dispatchPrintHTML(html, resolvedCategory);
}

function _dispatchPrintHTML(html, category = 'reporte') {
  category = _categoryForJobType(category);
  // Multi-terminal: reportes también respetan la elección de destino (cliente sin
  // impresora → servidor / aquí).
  if (_shouldOfferServerPrint(category)) { _offerPrintTarget(html, category, null); return; }
  const catCfg = _getCategoryConfig(category);

  if (window.api?.print?.html) {
    _printDispatch({
      html,
      printerName: catCfg.printer || (catCfg.bindingConfigured ? '' : _getSavedPrinter()) || undefined,
      jobType: category,
      referenceId: null,
      userId: user?.id,
      copies: catCfg.copies || 1,
    })
      .then(result => {
        if (!result?.ok && !result?.duplicate) _openPrintWindowFallback(html);
      })
      .catch(() => _openPrintWindowFallback(html));
    return;
  }
  _openPrintWindowFallback(html);
}

// ══════════════════════════════════════════════
// CONFIGURACIÓN DE IMPRESORA — UI helper
// ══════════════════════════════════════════════
async function openPrinterConfig() {
  let printers = [];
  try {
    printers = await window.api.print.getPrinters();
  } catch {}
  const documentPrinters = printers.filter(p => {
    if (p?.name && p.name === DB?.settings?.barcode_printer) return false;
    if (typeof detectLabelPrinter !== 'function') return true;
    return !['high', 'medium'].includes(detectLabelPrinter(p, {}).confidence);
  });

  const saved = _getSavedPrinter();
  const currentProfile = _getTicketPrinterProfile(saved);
  const savedProfile = DB?.settings?.printer_profile || '';

  const options = documentPrinters.length
    ? documentPrinters.map(p => `
        <option value="${_escHtml(p.name)}" ${p.name === saved ? 'selected' : ''}>
          ${_escHtml(p.name)}${p.isDefault ? ' (predeterminada)' : ''}
        </option>`).join('')
    : `<option value="">Sin impresoras de documentos detectadas</option>`;

  openModal(`
    <div class="modal-title">Configurar impresora de documentos</div>
    <div class="modal-sub">Aplica a facturas, recibos y reportes. Las etiquetas se configuran por separado.</div>

    <div class="fg">
      <label class="lbl">Impresora instalada</label>
      <select class="inp" id="sel-printer">${options}</select>
      <div style="font-size:11px;color:var(--muted);margin-top:5px">
        La impresora debe aparecer instalada en el sistema. Esta selección nunca
        cambia la impresora dedicada del módulo Etiquetas.
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Perfil de papel</label>
      <select class="inp" id="sel-printer-profile" onchange="printerProfileFormChanged()">
        <option value="" ${!savedProfile?'selected':''}>Detectar automáticamente</option>
        <option value="ticket_58" ${savedProfile==='ticket_58'?'selected':''}>Ticket térmico · 58 mm</option>
        <option value="ticket_72" ${savedProfile==='ticket_72'?'selected':''}>Ticket térmico · 72 mm</option>
        <option value="ticket_80" ${savedProfile==='ticket_80'?'selected':''}>Ticket térmico · 80 mm</option>
        <option value="continuous_custom" ${savedProfile==='continuous_custom'?'selected':''}>Rollo continuo · ancho personalizado</option>
        <option value="sheet" ${savedProfile==='sheet'?'selected':''}>Carta / A4 · láser o tinta</option>
      </select>
      <div style="font-size:11px;color:var(--muted);margin-top:5px">
        Para rollos de etiquetas usa el módulo <strong>Etiquetas</strong>, donde
        se seleccionan su impresora, medidas, sensor y calibración independientes.
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg">
        <label class="lbl">Ancho del medio (mm)</label>
        <input class="inp" id="sel-printer-width" type="number" min="20" max="150" step="0.1"
               value="${savedProfile === 'continuous_custom' ? (DB?.settings?.printer_width_mm || 80) : (currentProfile.widthMm || 80)}"
               ${savedProfile && savedProfile !== 'continuous_custom' ? 'disabled' : ''}/>
      </div>
      <div class="fg">
        <label class="lbl">Resolución (DPI)</label>
        <input class="inp" id="sel-printer-dpi" type="number" min="100" max="1200"
               value="${currentProfile.dpi || DB?.settings?.printer_dpi || 203}"/>
      </div>
    </div>

    ${!documentPrinters.length ? `
      <div class="alrt w" style="margin-top:8px">
        <div class="alrt-dot w"></div>
        <div>
          <div class="alrt-title">No se detectó una impresora de documentos</div>
          <div class="alrt-sub">Las impresoras reconocidas como etiquetadoras se configuran únicamente en Etiquetas.</div>
        </div>
      </div>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-out" onclick="testPrint()">
        ${svg('print')} Prueba de impresión
      </button>
      <button class="btn btn-dark" onclick="savePrinterConfig()">
        ${svg('check')} Guardar
      </button>
    </div>
  `);
}

async function savePrinterConfig() {
  const sel = document.getElementById('sel-printer');
  if (!sel) return;
  const name = sel.value.trim();
  const profileId = document.getElementById('sel-printer-profile')?.value || '';
  const widthMm = document.getElementById('sel-printer-width')?.value || '';
  const dpi = document.getElementById('sel-printer-dpi')?.value || '203';
  const resolved = typeof resolvePrinterProfile === 'function'
    ? resolvePrinterProfile(name, 'ticket', { printer_profile: profileId, printer_width_mm: widthMm, printer_dpi: dpi })
    : null;
  const ptype = resolved && typeof printerProfileLegacyType === 'function'
    ? printerProfileLegacyType(resolved) : '';
  const result = await window.api.print.savePrinter({
    printerName: name,
    requestUserId: user?.id,
  });
  if (result?.ok) {
    // Guardar también el tipo forzado (override de detectPrinterType)
    try {
      await Promise.all([
        window.api.settings.set({ key: 'printer_profile', value: profileId, requestUserId: user?.id }),
        window.api.settings.set({ key: 'printer_width_mm', value: widthMm, requestUserId: user?.id }),
        window.api.settings.set({ key: 'printer_dpi', value: dpi, requestUserId: user?.id }),
        window.api.settings.set({ key: 'printer_type', value: ptype, requestUserId: user?.id }),
      ]);
    } catch {}
    if (DB.settings) Object.assign(DB.settings, { printer: name, printer_profile: profileId,
      printer_width_mm: widthMm, printer_dpi: dpi, printer_type: ptype });
    if (CFG) Object.assign(CFG, { printer: name, printer_profile: profileId,
      printer_width_mm: widthMm, printer_dpi: dpi, printer_type: ptype });
    toast(name ? `Impresora guardada: ${name}` : 'Impresora limpiada');
    closeModal();
  } else {
    toast(result?.error || 'Error al guardar', 'err');
  }
}

function printerProfileFormChanged() {
  const id = document.getElementById('sel-printer-profile')?.value || '';
  const profile = (typeof PRINTER_PROFILES !== 'undefined' && PRINTER_PROFILES[id]) || null;
  const width = document.getElementById('sel-printer-width');
  const dpi = document.getElementById('sel-printer-dpi');
  if (profile && width) width.value = profile.widthMm;
  if (profile && dpi) dpi.value = profile.dpi;
  if (width) width.disabled = !!profile && id !== 'continuous_custom';
}

function testPrint() {
  // Usar plantilla activa si está configurada
  const templateId = DB?.settings?.print_template;
  const plantilla  = templateId ? getPlantilla(templateId) : null;

  if (plantilla) {
    const cfg = {
      biz_name:    DB?.settings?.biz_name    || CFG?.biz    || 'Mi Negocio',
      biz_rnc:     DB?.settings?.biz_rnc     || CFG?.rnc    || '101-00000-0',
      biz_addr:    DB?.settings?.biz_addr    || CFG?.addr   || 'Calle Principal #1',
      biz_phone:   DB?.settings?.biz_phone   || CFG?.phone  || '809-555-0000',
      biz_email:   DB?.settings?.biz_email   || '',
      biz_web:     DB?.settings?.biz_web     || '',
      biz_logo:    DB?.settings?.biz_logo    || '',
      biz_logo_2:  DB?.settings?.biz_logo_2  || '',
      logo_size:   DB?.settings?.logo_size   || 'mediano',
      factura_font_size: DB?.settings?.factura_font_size || 'mediano',
      // Firma promocional VELO POS (QR + texto). enabled por defecto salvo '0'.
      invoice_branding_enabled: DB?.settings?.invoice_branding_enabled ?? '1',
      invoice_branding_url:     DB?.settings?.invoice_branding_url  || 'https://wa.link/39cwoi',
      invoice_branding_text:    DB?.settings?.invoice_branding_text || 'Sistema de facturación impulsado por VELO POS',
      invoice_branding_cta:     DB?.settings?.invoice_branding_cta  || 'Solicita tu demostración',
      receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
      invoice_notes: DB?.settings?.invoice_notes || '',
      biz_bank_name:    DB?.settings?.biz_bank_name    || 'BANCO DEMO, S.A.',
      biz_bank_account: DB?.settings?.biz_bank_account || '010-000000-0-0',
      biz_bank_holder:  DB?.settings?.biz_bank_holder  || '',
      biz_bank_iban:    DB?.settings?.biz_bank_iban    || 'DO00 0000 0000 0000 0000 0000',
      print_item_code:  DB?.settings?.print_item_code  || '1',
    };
    const sale = getSampleSale(cfg);
    const html = plantilla.render(sale, cfg, plantilla.opciones);
    _openPrintWindow(html, 'test', 0, false);
    return;
  }

  // Fallback: ticket de prueba clásico
  const testProfile = _getTicketPrinterProfile();
  const testLines = [
    tCenter(CFG.biz || 'Mi Negocio'),
    tline(),
    tCenter('*** PRUEBA DE IMPRESIÓN ***'),
    tline(),
    tRow('Impresora:', (_getSavedPrinter() || 'predeterminada').slice(0, 22)),
    tRow('Perfil:', testProfile.label || testProfile.id || 'Automático'),
    tRow('Ancho papel:', `${testProfile.widthMm || 80}mm`),
    tRow('Resolución:', `${testProfile.dpi || 203} DPI`),
    tRow('Columnas:', String(THERMAL.cols)),
    tline('-'),
    tCenter('Texto de prueba'),
    '1234567890123456789012345678901234567890ab',
    tlineD(),
    tCenter('Si lees esto correctamente'),
    tCenter('la impresora funciona bien'),
    tline(),
    '',
    '',
  ];
  _sendToPrinter(testLines, 'test', 0);
}

// ── fin de print.js ──────────────────────────
