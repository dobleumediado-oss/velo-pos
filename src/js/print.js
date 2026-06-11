// ══════════════════════════════════════════════
// print.js — Servicio de Impresión
//   · Ticket de venta 80mm (AOKIA AK-3380 USB)
//   · Recibo de abono 80mm
//   · Cierre de caja 80mm
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

// ── Obtener impresora guardada ────────────────
function _getSavedPrinter() {
  return (DB?.settings?.printer || CFG?.printer || '').trim();
}

// ══════════════════════════════════════════════
// TICKET DE VENTA 80MM
// ══════════════════════════════════════════════
function printReceipt(sale, isReprint = false) {
  if (!sale) return;

  // ── Usar sistema de plantillas si está configurado ──
  const templateId = DB?.settings?.print_template;
  const plantilla  = templateId ? getPlantilla(templateId) : null;

  if (plantilla) {
    // Usar plantilla seleccionada
    const cfg = {
      biz_name:    DB?.settings?.biz_name    || CFG?.biz    || 'Mi Negocio',
      biz_rnc:     DB?.settings?.biz_rnc     || CFG?.rnc    || '',
      biz_addr:    DB?.settings?.biz_addr    || CFG?.addr   || '',
      biz_phone:   DB?.settings?.biz_phone   || CFG?.phone  || '',
      biz_logo:    DB?.settings?.biz_logo    || CFG?.biz_logo || '',
      receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
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
      cajero:        sale.cajero || user?.name || '',
      items: (sale.items || []).map(i => ({
        product_name: i.product_name || i.name || '',
        qty:          i.qty  || 1,
        unit_price:   i.unit_price || i.price || 0,
      })),
      subtotal:      sale.subtotal     || 0,
      discount_pct:  sale.discount_pct || sale.disc    || 0,
      discount_amt:  sale.discount_amt || sale.discAmt || 0,
      tax_pct:       sale.tax_pct      || DB?.settings?.tax_pct || CFG?.itbis || 18,
      tax_amt:       sale.tax_amt      || sale.itbis   || 0,
      total:         sale.total        || 0,
      payment_method: sale.payment_method || sale.pay || 'efectivo',
      // NCF real de la venta — nunca inventar uno
      ncf:           sale.ncf || '',
      // Pago mixto
      mix_efec:      sale.mix_efec || 0,
      mix_card:      sale.mix_card || 0,
      // Devolución
      original_sale_id: sale.original_sale_id || null,
    };

    const html = plantilla.render(saleForPlant, cfg, plantilla.opciones);
    _openPrintWindow(html, 'ticket', sale.id, isReprint);
    return;
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
  if (isFactura)    docLabel = '*** FACTURA ***';
  if (isCotizacion) docLabel = '*** COTIZACIÓN ***';
  if (isDevolucion) docLabel = '*** NOTA DE DEVOLUCIÓN ***';
  lines.push(tCenter(docLabel));
  if (isReprint)    lines.push(tCenter('--- REIMPRESIÓN ---'));

  lines.push(tline());
  lines.push(tRow(`No.: ${String(sale.id).padStart(5,'0')}`, `Fecha: ${sale.date || today()}`));
  lines.push(tRow(`Hora: ${sale.time || nowt()}`, `Cajero: ${(sale.cajero||'').split(' ')[0]}`));

  const cliName = sale.customer_name || sale.clientName || 'Consumidor Final';
  const cliRnc  = sale.customer_rnc  || sale.clientCedula || '';
  lines.push(tRow('Cliente:', cliName.slice(0, 28)));
  if (cliRnc) lines.push(tRow('RNC/Céd:', cliRnc));

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

  lines.push(tRow('Subtotal:', fmt(subtotal)));
  if (discPct > 0) lines.push(tRow(`Descuento (${discPct}%):`, `-${fmt(discAmt)}`));
  if (isFactura && itbis > 0) lines.push(tRow(`ITBIS (${sale.tax_pct ?? cfg?.itbis ?? 18}%):`, fmt(itbis)));
  lines.push(tlineD());
  lines.push(tRow('TOTAL:', fmt(total)));
  lines.push(tlineD());
  lines.push('');

  const metodo = (sale.payment_method || sale.pay || 'efectivo').toUpperCase();
  if (metodo === 'MIXTO') {
    lines.push(tRow('Método:', 'PAGO MIXTO'));
    if (sale.mix_efec > 0) lines.push(tRow('  Efectivo:', fmt(sale.mix_efec)));
    if (sale.mix_card > 0) lines.push(tRow('  Tarjeta/Trans.:', fmt(sale.mix_card)));
  } else {
    lines.push(tRow('Método de pago:', metodo));
  }

  if (isFactura && !isDevolucion) {
    lines.push('');
    lines.push(tCenter('Documento con validez fiscal'));
    // Usar el NCF real guardado en la venta — no el ID
    if (sale.ncf && sale.ncf.trim()) {
      lines.push(tCenter(`NCF: ${sale.ncf}`));
    } else if (cfg?.fiscalEnabled || cfg?.fiscal_enabled === '1') {
      // Fallback si por alguna razón no se guardó el NCF
      lines.push(tCenter(`NCF: B01${String(sale.id).padStart(9,'0')}`));
    }
  }

  if (isDevolucion && sale.original_sale_id) {
    lines.push('');
    lines.push(tCenter(`Ref. venta original: #${String(sale.original_sale_id).padStart(5,'0')}`));
  }

  lines.push('');
  lines.push(tCenter(DB?.settings?.receipt_msg || CFG?.receipt_msg || '¡Gracias por su compra!'));
  lines.push(tCenter('Conserve su comprobante'));
  lines.push(tline());
  lines.push('');
  lines.push('');

  _sendToPrinter(lines, 'ticket', sale.id, isReprint);
}

// ══════════════════════════════════════════════
// RECIBO DE ABONO 80MM
// ══════════════════════════════════════════════
function printAbono({ payment, customer, cajero }) {
  if (!payment || !customer) return;

  const lines = [];
  lines.push(tCenter(CFG.biz));
  if (CFG.rnc)   lines.push(tCenter(`RNC: ${CFG.rnc}`));
  if (CFG.phone) lines.push(tCenter(`Tel: ${CFG.phone}`));
  lines.push(tline());
  lines.push(tCenter('*** RECIBO DE ABONO ***'));
  lines.push(tline());
  lines.push(tRow(`No.: ${String(payment.id).padStart(5,'0')}`,
    `Fecha: ${(payment.created_at || today()).split('T')[0].split(' ')[0]}`));
  lines.push(tRow('Cajero:', (cajero || '').split(' ')[0]));
  lines.push(tline());
  lines.push(tRow('Cliente:', customer.name.slice(0, 28)));
  if (customer.rnc) lines.push(tRow('RNC/Céd:', customer.rnc));
  lines.push(tline());
  lines.push(tRow('Balance anterior:', fmt(payment.balance_before || 0)));
  lines.push(tRow('Monto abonado:', fmt(payment.amount || 0)));
  lines.push(tlineD());
  lines.push(tRow('BALANCE PENDIENTE:', fmt(payment.balance_after || 0)));
  lines.push(tlineD());
  lines.push('');
  lines.push(tRow('Método:', (payment.method || 'efectivo').toUpperCase()));
  if (payment.note && payment.note !== 'Abono') {
    lines.push(tRow('Nota:', payment.note.slice(0, 30)));
  }
  lines.push('');
  lines.push(tCenter('Gracias por su pago'));
  lines.push(tline());
  lines.push('');
  lines.push('');

  _sendToPrinter(lines, 'abono', payment.id);
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
function _sendToPrinter(lines, jobType = '', referenceId = null, isReprint = false) {
  // Si la impresora es de cartuchos/carta y no se llegó acá desde una plantilla,
  // usar plantilla carta_recibo automáticamente (el contenido de líneas no se adapta bien a carta)
  const _printerTypeCheck = typeof detectPrinterType === 'function'
    ? detectPrinterType(_getSavedPrinter()) : 'unknown';
  if (_printerTypeCheck === 'carta' && typeof getPlantilla === 'function') {
    const _cartaPlant = getPlantilla(DB?.settings?.print_template || 'carta_recibo');
    if (_cartaPlant && _cartaPlant.tipo === 'carta') {
      // Ya hay una plantilla carta activa — no hacer nada, dejar flujo normal
      // (esta función solo se llama desde fallback clásico sin plantilla)
    }
    // No interrumpir — continuar con el HTML adaptado abajo
  }

  const logoB64 = DB?.settings?.biz_logo || CFG?.biz_logo || '';

  const logoHtml = logoB64
    ? `<div style="text-align:center;margin-bottom:6px">
         <img src="${logoB64}"
              style="max-width:160px;max-height:60px;
                     filter:grayscale(100%) contrast(150%);
                     -webkit-print-color-adjust:exact"/>
       </div>`
    : '';

  const content = lines
    .map(l => `<div class="ln">${_escHtml(l)}</div>`)
    .join('');

  const printerType = typeof detectPrinterType === 'function'
    ? detectPrinterType(_getSavedPrinter()) : 'unknown';
  const isThermal = printerType !== 'unknown' && printerType !== 'carta';
  const pageCSS = isThermal
    ? '@page { size: 80mm auto; margin: 2mm 3mm 4mm 3mm; }'
    : '@page { size: letter; margin: 15mm 15mm 15mm 15mm; }';
  const bodyCSS = isThermal
    ? 'width: 76mm; max-width: 76mm; font-family: \'Courier New\', Courier, monospace; font-size: 11.5px; line-height: 1.4;'
    : 'width: 100%; max-width: 180mm; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.5;';
  const mediaCSS = isThermal
    ? 'html, body { width: 80mm; }'
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
<body>${logoHtml}${content}
</body></html>`;

  _openPrintWindow(html, jobType, referenceId, isReprint);
}

// ── Abrir ventana de impresión ────────────────
function _openPrintWindow(html, jobType = '', referenceId = null, isReprint = false) {
  const printerName  = _getSavedPrinter();
  const printerType  = typeof detectPrinterType === 'function'
    ? detectPrinterType(printerName)
    : 'unknown';

  // Impresoras carta/cartuchos: usar api.print.html con silent:false
  // Esto abre el diálogo de impresión de Electron (con vista previa)
  // window.open/_blank en Electron secundaria llama window.print() nativo
  // de Windows que NO tiene vista previa — por eso se veía el diálogo feo
  if (printerType === 'carta' || printerType === 'unknown') {
    if (window.api?.print?.html) {
      window.api.print.html({
        html,
        // Sin printerName ni printerWidth → main.js usará isThermal=false
        // → silent:false, pageSize:'A4' → diálogo Electron con vista previa
        jobType,
        referenceId,
        userId: user?.id || null,
      }).then(result => {
        if (!result?.ok) {
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

  // Impresoras térmicas: usar API nativa de Electron
  const printerWidth = printerType === '58mm' ? 58000 : 80000;

  if (window.api?.print?.html) {
    window.api.print.html({
      html,
      printerName:  printerName || undefined,
      printerWidth: printerName ? printerWidth : undefined,
      jobType,
      referenceId,
      userId: user?.id || null,
    }).then(result => {
      if (!result?.ok) {
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
  // Inyectar botones de control en el HTML
  const htmlConBoton = html.replace('</body>', `
    <div style="position:fixed;top:8px;right:8px;z-index:9999;display:flex;gap:6px">
      <button onclick="window.print()"
        style="background:#16a34a;color:#fff;border:none;padding:8px 16px;
               border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;
               box-shadow:0 2px 8px rgba(0,0,0,.2)">
        🖨️ Imprimir
      </button>
      <button onclick="window.close()"
        style="background:#6b7280;color:#fff;border:none;padding:8px 16px;
               border-radius:6px;font-size:13px;font-weight:700;cursor:pointer">
        Cerrar
      </button>
    </div>
  </body>`);

  // Intentar primero con la API de Electron (más confiable en Windows)
  if (window.api?.print?.preview) {
    window.api.print.preview({ html: htmlConBoton });
    return;
  }

  // Fallback: window.open estándar
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
  } catch(e) {}

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
function printHTML(html) {
  if (!html.includes('<meta charset')) {
    html = html.replace('<head>', '<head><meta charset="UTF-8"/>');
  }
  if (window.api?.print?.html) {
    window.api.print.html({ html, jobType: 'reporte', referenceId: null, userId: user?.id })
      .then(result => {
        if (!result?.ok) _openPrintWindowFallback(html);
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

  const saved = _getSavedPrinter();

  const options = printers.length
    ? printers.map(p => `
        <option value="${_escHtml(p.name)}" ${p.name === saved ? 'selected' : ''}>
          ${_escHtml(p.name)}${p.isDefault ? ' (predeterminada)' : ''}
        </option>`).join('')
    : `<option value="">Sin impresoras detectadas</option>`;

  openModal(`
    <div class="modal-title">Configurar Impresora</div>
    <div class="modal-sub">Selecciona la impresora térmica AOKIA 80mm</div>

    <div class="fg">
      <label class="lbl">Impresora instalada</label>
      <select class="inp" id="sel-printer">${options}</select>
      <div style="font-size:11px;color:var(--muted);margin-top:5px">
        En Windows: la AOKIA debe aparecer como "AOKIA AK-3380" o similar.
        Si no aparece, instala el driver USB primero y reinicia el sistema.
      </div>
    </div>

    ${!printers.length ? `
      <div class="alrt w" style="margin-top:8px">
        <div class="alrt-dot w"></div>
        <div>
          <div class="alrt-title">No se detectaron impresoras</div>
          <div class="alrt-sub">Verifica que la impresora esté encendida y conectada por USB.</div>
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
  const result = await window.api.print.savePrinter({
    printerName: name,
    requestUserId: user?.id,
  });
  if (result?.ok) {
    if (DB.settings) DB.settings.printer = name;
    if (CFG) CFG.printer = name;
    toast(name ? `Impresora guardada: ${name}` : 'Impresora limpiada');
    closeModal();
  } else {
    toast(result?.error || 'Error al guardar', 'err');
  }
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
      biz_logo:    DB?.settings?.biz_logo    || '',
      receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
    };
    const sale = getSampleSale(cfg);
    const html = plantilla.render(sale, cfg, plantilla.opciones);
    _openPrintWindow(html, 'test', 0, false);
    return;
  }

  // Fallback: ticket de prueba clásico
  const testLines = [
    tCenter(CFG.biz || 'Mi Negocio'),
    tline(),
    tCenter('*** PRUEBA DE IMPRESIÓN ***'),
    tline(),
    tRow('Impresora:', (_getSavedPrinter() || 'predeterminada').slice(0, 22)),
    tRow('Ancho papel:', '80mm'),
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
