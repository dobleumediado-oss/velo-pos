'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeCustomerPhone } = require('./customer-phone');
const { canonicalizeLegacyNcf } = require('./ncf-sequences');

const EQUIPARTS_FILES = Object.freeze({
  clientes: '2_clientes_v2.csv',
  inventario: '1_inventario_v2.csv',
  ventas: '3_ventas_v2.csv',
  recibos: '4_recibos_v2.csv',
});

const REQUIRED_HEADERS = Object.freeze({
  clientes: ['old_id_cliente', 'name', 'rnc', 'phone', 'address', 'email', 'credit_days'],
  inventario: ['code', 'barcode', 'name', 'cost', 'price', 'wholesale', 'taxable', 'tax_pct', 'stock', 'stock_min', 'category', 'brand', 'unit'],
  ventas: ['old_id_factura', 'numero_factura', 'numero_factura_fmt', 'ncf', 'customer_name', 'old_id_cliente', 'date', 'total', 'balance', 'payment_method', 'status', 'product_code', 'product_name', 'qty', 'unit_price', 'line_total'],
  recibos: ['old_id_pago_detalle', 'old_id_factura', 'old_id_cliente', 'customer_name', 'date', 'amount', 'method', 'numero_recibo', 'notes'],
});

function parseCsv(text, source = 'CSV') {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    const next = input[i + 1];
    if (inQuotes) {
      if (current === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (current === '"') {
        inQuotes = false;
      } else {
        field += current;
      }
    } else if (current === '"') {
      if (field) throw new Error(`${source}: comilla inesperada dentro de un campo`);
      inQuotes = true;
    } else if (current === ',') {
      row.push(field);
      field = '';
    } else if (current === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (current !== '\r') {
      field += current;
    }
  }
  if (inQuotes) throw new Error(`${source}: hay un campo entre comillas sin cerrar`);
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(values => values.some(value => String(value).trim() !== ''));
}

function loadCsvText(text, filename) {
  const parsed = parseCsv(text, filename);
  if (!parsed.length) throw new Error(`${filename}: el archivo está vacío`);
  const headers = parsed.shift().map(header => String(header || '').trim());
  if (!headers.length || headers.some(header => !header)) {
    throw new Error(`${filename}: encabezado vacío o incompleto`);
  }
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length) {
    throw new Error(`${filename}: encabezados duplicados (${[...new Set(duplicates)].join(', ')})`);
  }
  const rows = parsed.map((values, rowIndex) => {
    if (values.length > headers.length && values.slice(headers.length).some(value => String(value).trim())) {
      throw new Error(`${filename}: la fila ${rowIndex + 2} tiene más columnas que el encabezado`);
    }
    const record = {};
    headers.forEach((header, index) => {
      record[header] = String(values[index] ?? '').trim();
    });
    return record;
  });
  Object.defineProperty(rows, '_headers', { value: headers, enumerable: false });
  return rows;
}

function loadCsvFile(dir, filename) {
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) throw new Error(`No se encontró el CSV: ${filename}`);
  return loadCsvText(fs.readFileSync(filePath, 'utf8'), filename);
}

function loadEquipartsCsvSet(dir) {
  return Object.fromEntries(
    Object.entries(EQUIPARTS_FILES).map(([kind, filename]) => [kind, loadCsvFile(dir, filename)])
  );
}

function loadEquipartsCsvPayload(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('No se recibieron los CSV de Equiparts');
  }
  let totalBytes = 0;
  const result = {};
  for (const [kind, filename] of Object.entries(EQUIPARTS_FILES)) {
    const text = files[filename];
    if (typeof text !== 'string') throw new Error(`No se recibió el CSV: ${filename}`);
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > 8 * 1024 * 1024) {
      throw new Error('Los CSV superan 8 MB; ejecuta la migración directamente en la PC Servidor');
    }
    if (text.includes('\0')) throw new Error(`${filename}: contiene datos binarios inválidos`);
    result[kind] = loadCsvText(text, filename);
  }
  return result;
}

function toNumber(value, label = 'valor') {
  if (value === '' || value == null) return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed)) throw new Error(`${label}: número inválido (${value})`);
  return parsed;
}

function toIntegerOrNull(value, label = 'valor') {
  if (value === '' || value == null) return null;
  const parsed = Number(String(value).trim());
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}: entero inválido (${value})`);
  return parsed;
}

function normalizeName(value) {
  return String(value || '').trim().toLocaleLowerCase('es-DO').normalize('NFC');
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function assertIsoDate(value, label) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label}: fecha inválida (${value || 'vacía'})`);
  const parsed = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label}: fecha inválida (${value})`);
  }
  return text;
}

function headersFor(rows) {
  return Array.isArray(rows?._headers) ? rows._headers : Object.keys(rows?.[0] || {});
}

function assertHeaders(kind, rows) {
  const available = new Set(headersFor(rows));
  const missing = REQUIRED_HEADERS[kind].filter(header => !available.has(header));
  if (missing.length) {
    throw new Error(`${EQUIPARTS_FILES[kind]}: faltan columnas obligatorias (${missing.join(', ')})`);
  }
}

function assertUnique(rows, field, label) {
  const found = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const value = String(rows[index][field] ?? '').trim();
    if (!value) throw new Error(`${label}: fila ${index + 2} sin ${field}`);
    if (found.has(value)) throw new Error(`${label}: ${field} duplicado (${value})`);
    found.add(value);
  }
}

function groupInvoices(ventas) {
  const invoices = new Map();
  for (let index = 0; index < ventas.length; index += 1) {
    const row = ventas[index];
    const invoiceId = toIntegerOrNull(row.old_id_factura, `ventas fila ${index + 2}.old_id_factura`);
    if (invoiceId == null) throw new Error(`3_ventas_v2.csv: fila ${index + 2} sin old_id_factura`);
    const total = toNumber(row.total, `factura ${invoiceId}.total`);
    const balance = toNumber(row.balance, `factura ${invoiceId}.balance`);
    // Algunos BAK antiguos exportan total=0 aunque las líneas sí conservan el
    // importe. La relación balance<=total se valida después de reconstruir el
    // total desde el detalle; los totales no-cero siguen siendo autoritativos.
    if (total < 0 || balance < 0 || (total > 0 && balance - total > 0.01)) {
      throw new Error(`Factura ${invoiceId}: total/balance fuera de rango`);
    }
    const rawNcf = String(row.ncf || '').trim().toUpperCase();
    const ncf = rawNcf ? canonicalizeLegacyNcf(rawNcf) : '';
    if (rawNcf && !ncf) throw new Error(`Factura ${invoiceId}: NCF histórico inválido (${rawNcf})`);
    const metadata = {
      numero_factura: toIntegerOrNull(row.numero_factura, `factura ${invoiceId}.numero_factura`),
      numero_factura_fmt: String(row.numero_factura_fmt || '').trim(),
      ncf,
      customer_name: String(row.customer_name || 'Consumidor Final').trim(),
      old_id_cliente: toIntegerOrNull(row.old_id_cliente, `factura ${invoiceId}.old_id_cliente`),
      date: assertIsoDate(row.date, `factura ${invoiceId}.date`),
      total: round2(total),
      balance: round2(balance),
      payment_method: String(row.payment_method || 'efectivo').trim().toLowerCase(),
      status: String(row.status || 'completed').trim().toLowerCase() === 'cancelled' ? 'cancelled' : 'completed',
      factura_nota: String(row.factura_nota || '').trim(),
      estado_origen: String(row.estado_origen || '').trim(),
    };
    const existing = invoices.get(invoiceId);
    if (existing) {
      const fields = ['numero_factura', 'numero_factura_fmt', 'ncf', 'customer_name', 'old_id_cliente', 'date', 'total', 'balance', 'payment_method', 'status'];
      const conflict = fields.find(field => String(existing[field] ?? '') !== String(metadata[field] ?? ''));
      if (conflict) throw new Error(`Factura ${invoiceId}: ${conflict} cambia entre líneas del CSV`);
    } else {
      invoices.set(invoiceId, { old_id_factura: invoiceId, ...metadata, items: [] });
    }
    const productName = String(row.product_name || '').trim();
    const hasDetailValues = [row.qty, row.unit_price, row.line_total]
      .some(value => String(value ?? '').trim() !== '');
    if (productName && hasDetailValues) {
      const qty = toNumber(row.qty, `factura ${invoiceId}.qty`);
      const unitPrice = toNumber(row.unit_price, `factura ${invoiceId}.unit_price`);
      const lineTotal = toNumber(row.line_total, `factura ${invoiceId}.line_total`);
      if (qty <= 0 || unitPrice < 0 || lineTotal < 0) throw new Error(`Factura ${invoiceId}: detalle con valores inválidos`);
      const taxable = String(row.taxable ?? '').trim() === '' ? 1 : (String(row.taxable).trim() === '0' ? 0 : 1);
      const taxPct = taxable ? (toNumber(row.tax_pct, `factura ${invoiceId}.tax_pct`) || 18) : 0;
      invoices.get(invoiceId).items.push({
        product_code: String(row.product_code || 'IMP').trim() || 'IMP',
        product_name: productName,
        qty,
        unit_price: round2(unitPrice),
        line_total: round2(lineTotal || unitPrice * qty),
        taxable,
        tax_pct: taxPct,
      });
    }
  }
  for (const invoice of invoices.values()) {
    const detailTotal = round2(invoice.items.reduce((sum, item) => sum + item.line_total, 0));
    invoice.detail_total = detailTotal;
    invoice.declared_total = invoice.total;
    invoice.discount_amt = 0;
    invoice.discount_pct = 0;
    if (invoice.items.length && invoice.total === 0 && detailTotal > 0) {
      invoice.total = detailTotal;
      invoice.total_recovered_from_detail = true;
    } else if (invoice.items.length && invoice.total > 0 && detailTotal - invoice.total > 0.10) {
      // El BAK de Equiparts no exporta una columna de descuento. Cuando el
      // detalle bruto supera al total de cabecera, la diferencia es el descuento
      // aplicado a la factura (p. ej. 588,000 - 583,296 = 4,704 = 0.8%).
      invoice.discount_amt = round2(detailTotal - invoice.total);
      invoice.discount_pct = round6((invoice.discount_amt / detailTotal) * 100);
      invoice.discount_recovered_from_totals = true;
    } else if (invoice.items.length && invoice.total > 0 && invoice.total - detailTotal > 0.10) {
      // El detalle suma MENOS que el total de cabecera (un renglón que el export
      // del sistema viejo no trajo). No se escala ningún precio real: el faltante
      // se registrará como una línea de conciliación transparente en
      // calculateInvoiceFiscalBreakdown, y el total autoritativo queda intacto.
      invoice.reconciliation_amt = round2(invoice.total - detailTotal);
      invoice.reconciliation_from_shortfall = true;
    }
  }
  return invoices;
}

// Tasa gravada dominante (por valor bruto) entre los items reales. Se usa para
// que la línea de conciliación herede el régimen de ITBIS del grueso de la
// factura y la extracción de impuesto de cabecera siga cuadrando.
function dominantTaxableRate(items) {
  const grossByRate = new Map();
  for (const item of items) {
    if (!item.taxable) continue;
    const rate = Number(item.tax_pct) || 18;
    const gross = round2(item.line_total || (item.unit_price * item.qty));
    grossByRate.set(rate, round2((grossByRate.get(rate) || 0) + gross));
  }
  let bestRate = 0;
  let bestGross = -1;
  for (const [rate, gross] of grossByRate) {
    if (gross > bestGross) { bestRate = rate; bestGross = gross; }
  }
  return bestRate;
}

function calculateInvoiceFiscalBreakdown(invoice, sourceItems = invoice?.items || []) {
  const baseItems = sourceItems.length ? sourceItems : [{
    product_code: 'IMP', product_name: 'Factura importada', qty: 1,
    unit_price: invoice?.total || 0, line_total: invoice?.total || 0,
    taxable: 1, tax_pct: 18,
  }];
  const grossOf = (item) => round2(item.line_total || (item.unit_price * item.qty));
  const detailTotal = round2(baseItems.reduce((sum, item) => sum + grossOf(item), 0));
  const discountAmt = round2(invoice?.discount_amt || 0);
  const targetGross = Number(invoice?.total) > 0
    ? round2(invoice.total)
    : round2(Math.max(0, detailTotal - discountAmt));

  // Caso "falta en detalle": el total de cabecera supera la suma de las líneas
  // reales y NO hay descuento legado. No se escala el precio de ningún producto
  // real ni se inventa mercancía; el faltante se registra en UNA línea de
  // conciliación transparente (sin código → product_id nulo, no toca inventario).
  // Los otros dos caminos quedan intactos: total=0 (recuperado del detalle) y
  // detalle>total (descuento legado reconstruido).
  const reconciliationAmt = round2(targetGross - detailTotal);
  const needsReconciliation = discountAmt === 0 && reconciliationAmt > 0.10;
  let items = baseItems;
  if (needsReconciliation) {
    // Régimen dominante: si el grueso del detalle es gravado, la diferencia
    // también lo es (a la tasa gravada dominante); si es exento, queda exenta.
    const taxableGross = round2(baseItems.reduce(
      (sum, item) => sum + (item.taxable ? grossOf(item) : 0), 0));
    const reconTaxable = taxableGross > 0 && taxableGross >= round2(detailTotal - taxableGross);
    items = [...baseItems, {
      product_code: '',
      product_name: 'Diferencia no detallada (sistema anterior)',
      qty: 1,
      unit_price: reconciliationAmt,
      line_total: reconciliationAmt,
      taxable: reconTaxable ? 1 : 0,
      tax_pct: reconTaxable ? (dominantTaxableRate(baseItems) || 18) : 0,
      is_reconciliation: true,
    }];
  }

  // Con la línea de conciliación, el detalle efectivo iguala exactamente el
  // total → factor = 1: los items reales conservan su line_total sin escalar.
  const effectiveDetailTotal = needsReconciliation
    ? round2(detailTotal + reconciliationAmt)
    : detailTotal;
  const factor = effectiveDetailTotal > 0 ? targetGross / effectiveDetailTotal : 1;
  let allocatedGross = 0;

  const fiscalItems = items.map((item, index) => {
    const lineGross = round2(item.line_total || (item.unit_price * item.qty));
    // La última línea absorbe únicamente el residuo de centavos para que la suma
    // sea exactamente igual al total de cabecera, sin alterar precios/cantidades.
    const lineAfterDiscount = index === items.length - 1
      ? round2(targetGross - allocatedGross)
      : round2(lineGross * factor);
    allocatedGross = round2(allocatedGross + lineAfterDiscount);
    const taxPct = item.taxable ? (Number(item.tax_pct) || 18) : 0;
    const lineTax = taxPct > 0
      ? round2(lineAfterDiscount - lineAfterDiscount / (1 + taxPct / 100)) : 0;
    return {
      ...item,
      lineGross,
      lineAfterDiscount,
      taxPct,
      lineTax,
      lineNet: round2(lineAfterDiscount - lineTax),
    };
  });
  const taxAmt = round2(fiscalItems.reduce((sum, item) => sum + item.lineTax, 0));
  const total = round2(invoice?.total || targetGross);
  const taxRates = [...new Set(fiscalItems.filter(item => item.taxPct > 0).map(item => item.taxPct))];
  return {
    fiscalItems,
    detailTotal,
    reconciliationAmt: needsReconciliation ? reconciliationAmt : 0,
    discountAmt,
    discountPct: Number(invoice?.discount_pct) || 0,
    taxAmt,
    netSubtotal: round2(total - taxAmt),
    saleTaxPct: taxRates.length === 1 ? taxRates[0] : 0,
    total,
  };
}

function computeTargetCxc(ventas) {
  return round2([...groupInvoices(ventas).values()]
    .filter(invoice => invoice.status !== 'cancelled')
    .reduce((sum, invoice) => sum + Math.max(0, invoice.balance), 0));
}

function groupReceipts(recibos) {
  const groups = new Map();
  for (let index = 0; index < recibos.length; index += 1) {
    const row = recibos[index];
    const detailId = toIntegerOrNull(row.old_id_pago_detalle, `recibo fila ${index + 2}.old_id_pago_detalle`);
    const receiptNumber = toIntegerOrNull(row.numero_recibo, `recibo ${detailId}.numero_recibo`);
    const customerId = toIntegerOrNull(row.old_id_cliente, `recibo ${detailId}.old_id_cliente`);
    const method = String(row.method || 'efectivo').trim().toLowerCase();
    const date = assertIsoDate(row.date, `recibo ${detailId}.date`);
    // Un pago del sistema viejo puede tener varias facturas. Efectivo y
    // descuento se separan porque solo el primero representa entrada de caja.
    const key = receiptNumber == null ? `detalle:${detailId}` : `recibo:${receiptNumber}|${method}`;
    const metadata = {
      key,
      numero_recibo: receiptNumber,
      old_id_cliente: customerId,
      customer_name: String(row.customer_name || '').trim(),
      method,
      date,
    };
    const group = groups.get(key);
    if (group) {
      const fields = ['old_id_cliente', 'customer_name', 'method', 'date'];
      const conflict = fields.find(field => String(group[field] ?? '') !== String(metadata[field] ?? ''));
      if (conflict) throw new Error(`Recibo ${receiptNumber}: ${conflict} cambia entre aplicaciones`);
    } else {
      groups.set(key, { ...metadata, rows: [], amount: 0, notes: [] });
    }
    const target = groups.get(key);
    const amount = toNumber(row.amount, `recibo ${detailId}.amount`);
    target.rows.push({ ...row, old_id_pago_detalle: detailId, amount });
    target.amount = round2(target.amount + amount);
    const note = String(row.notes || '').trim();
    if (note && !target.notes.includes(note)) target.notes.push(note);
  }
  return groups;
}

function validateEquipartsData(data) {
  for (const kind of Object.keys(EQUIPARTS_FILES)) {
    if (!Array.isArray(data?.[kind])) throw new Error(`No se cargó ${EQUIPARTS_FILES[kind]}`);
    assertHeaders(kind, data[kind]);
  }
  if (!data.clientes.length) throw new Error('2_clientes_v2.csv: no contiene clientes');
  if (!data.inventario.length) throw new Error('1_inventario_v2.csv: no contiene productos');
  if (!data.ventas.length) throw new Error('3_ventas_v2.csv: no contiene ventas');

  assertUnique(data.clientes, 'old_id_cliente', '2_clientes_v2.csv');
  assertUnique(data.inventario, 'code', '1_inventario_v2.csv');
  assertUnique(data.recibos, 'old_id_pago_detalle', '4_recibos_v2.csv');

  data.clientes.forEach((row, index) => {
    toIntegerOrNull(row.old_id_cliente, `cliente fila ${index + 2}.old_id_cliente`);
    const days = toIntegerOrNull(row.credit_days, `cliente ${row.old_id_cliente}.credit_days`);
    if (days != null && (days < 0 || days > 3650)) throw new Error(`Cliente ${row.old_id_cliente}: días de crédito fuera de rango`);
  });
  data.inventario.forEach((row, index) => {
    ['cost', 'price', 'wholesale', 'tax_pct', 'stock', 'stock_min'].forEach(field => {
      const value = toNumber(row[field], `inventario fila ${index + 2}.${field}`);
      if (value < 0) throw new Error(`Producto ${row.code}: ${field} no puede ser negativo`);
    });
  });

  const customerIds = new Set(data.clientes.map(row => String(toIntegerOrNull(row.old_id_cliente, 'old_id_cliente'))));
  const invoices = groupInvoices(data.ventas);
  const invoiceIds = new Set([...invoices.keys()].map(String));
  const ncfOwner = new Map();
  const warnings = [];
  for (const invoice of invoices.values()) {
    if (invoice.old_id_cliente != null && !customerIds.has(String(invoice.old_id_cliente))) {
      throw new Error(`Factura ${invoice.old_id_factura}: cliente ${invoice.old_id_cliente} no existe en 2_clientes_v2.csv`);
    }
    if (invoice.ncf) {
      const owner = ncfOwner.get(invoice.ncf);
      if (owner && owner !== invoice.old_id_factura) throw new Error(`NCF duplicado ${invoice.ncf} en facturas ${owner} y ${invoice.old_id_factura}`);
      ncfOwner.set(invoice.ncf, invoice.old_id_factura);
    }
    if (invoice.balance - invoice.total > 0.01) {
      throw new Error(`Factura ${invoice.old_id_factura}: balance RD$${invoice.balance.toFixed(2)} supera el total recuperado RD$${invoice.total.toFixed(2)}`);
    }
    if (invoice.items.length) {
      const detailTotal = invoice.detail_total;
      if (invoice.reconciliation_from_shortfall) {
        // El detalle suma menos que el total; NO se rechaza ni se escalan
        // precios reales: el faltante se registra como línea de conciliación
        // (ver calculateInvoiceFiscalBreakdown). Queda como advertencia auditable.
        warnings.push({
          code: 'INVOICE_SHORTFALL_RECONCILED',
          invoiceId: invoice.old_id_factura,
          message: `Factura ${invoice.old_id_factura}: el detalle RD$${detailTotal.toFixed(2)} suma menos que el total RD$${invoice.total.toFixed(2)}; se agregará una línea de conciliación por RD$${invoice.reconciliation_amt.toFixed(2)}.`,
        });
      }
      if (invoice.total_recovered_from_detail) {
        warnings.push({
          code: 'INVOICE_TOTAL_RECOVERED_FROM_DETAIL',
          invoiceId: invoice.old_id_factura,
          message: `Factura ${invoice.old_id_factura}: el CSV declaró total RD$0.00; se recuperó RD$${detailTotal.toFixed(2)} desde sus líneas.`,
        });
      }
      if (invoice.discount_recovered_from_totals) {
        warnings.push({
          code: 'INVOICE_DISCOUNT_RECOVERED_FROM_TOTALS',
          invoiceId: invoice.old_id_factura,
          message: `Factura ${invoice.old_id_factura}: se reconstruyó descuento de RD$${invoice.discount_amt.toFixed(2)} (${invoice.discount_pct.toFixed(2)}%) desde detalle RD$${detailTotal.toFixed(2)} y total RD$${invoice.total.toFixed(2)}.`,
        });
      }
    }
  }
  for (let index = 0; index < data.recibos.length; index += 1) {
    const receipt = data.recibos[index];
    const invoiceId = toIntegerOrNull(receipt.old_id_factura, `recibo fila ${index + 2}.old_id_factura`);
    if (invoiceId == null || !invoiceIds.has(String(invoiceId))) {
      throw new Error(`Recibo ${receipt.old_id_pago_detalle}: factura ${receipt.old_id_factura || '(vacía)'} no existe en 3_ventas_v2.csv`);
    }
    if (toNumber(receipt.amount, `recibo ${receipt.old_id_pago_detalle}.amount`) <= 0) {
      throw new Error(`Recibo ${receipt.old_id_pago_detalle}: monto debe ser mayor que cero`);
    }
    const receiptCustomerId = toIntegerOrNull(receipt.old_id_cliente, `recibo ${receipt.old_id_pago_detalle}.old_id_cliente`);
    const invoice = invoices.get(invoiceId);
    if (receiptCustomerId != null && invoice?.old_id_cliente != null && receiptCustomerId !== invoice.old_id_cliente) {
      throw new Error(`Recibo ${receipt.old_id_pago_detalle}: el cliente no coincide con la factura ${invoiceId}`);
    }
  }
  const receiptGroups = groupReceipts(data.recibos);
  return {
    invoices,
    receiptGroups,
    warnings,
    targetCxc: round2([...invoices.values()].reduce((sum, invoice) => sum + Math.max(0, invoice.balance), 0)),
  };
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function syncImportedCustomerPhones(db, customerId, telephone, mobile) {
  const desired = [];
  const add = (phoneType, value) => {
    const phone = normalizeCustomerPhone(value).slice(0, 40);
    if (phone && !desired.some(row => row.phone === phone)) desired.push({ phoneType, phone });
  };
  add('telefono', telephone);
  add('celular', mobile);

  if (!tableExists(db, 'customer_phones')) {
    if (desired[0]) db.prepare('UPDATE customers SET phone=? WHERE id=?').run(desired[0].phone, customerId);
    return desired;
  }

  const existing = db.prepare(`
    SELECT id,phone_type,phone,is_primary,active
    FROM customer_phones WHERE customer_id=? ORDER BY active DESC,is_primary DESC,id
  `).all(customerId);
  const byPhone = new Map();
  for (const row of existing) {
    const normalized = normalizeCustomerPhone(row.phone).slice(0, 40);
    if (normalized && !byPhone.has(normalized)) byPhone.set(normalized, row);
  }
  const insert = db.prepare(`
    INSERT INTO customer_phones(customer_id,phone_type,phone,is_primary,active)
    VALUES(?,?,?,0,1)
  `);
  const update = db.prepare(`
    UPDATE customer_phones SET phone_type=?,phone=?,active=1,updated_at=datetime('now','localtime')
    WHERE id=?
  `);
  for (const item of desired) {
    const match = byPhone.get(item.phone);
    if (match) {
      update.run(item.phoneType, item.phone, match.id);
      match.active = 1;
      match.phone = item.phone;
    } else {
      const result = insert.run(customerId, item.phoneType, item.phone);
      byPhone.set(item.phone, { id: Number(result.lastInsertRowid), active: 1, is_primary: 0, phone: item.phone });
    }
  }
  const active = db.prepare(`
    SELECT id,phone,is_primary FROM customer_phones
    WHERE customer_id=? AND active=1 ORDER BY is_primary DESC,id
  `).all(customerId);
  const currentPrimary = active.find(row => row.is_primary);
  const desiredPrimary = desired[0] ? byPhone.get(desired[0].phone) : null;
  const primary = currentPrimary || desiredPrimary || active[0] || null;
  db.prepare('UPDATE customer_phones SET is_primary=0 WHERE customer_id=? AND active=1').run(customerId);
  if (primary) db.prepare('UPDATE customer_phones SET is_primary=1 WHERE id=?').run(primary.id);
  db.prepare('UPDATE customers SET phone=? WHERE id=?').run(primary?.phone || '', customerId);
  return db.prepare(`
    SELECT id,phone_type,phone,is_primary FROM customer_phones
    WHERE customer_id=? AND active=1 ORDER BY is_primary DESC,id
  `).all(customerId);
}

function assertForeignKeyIntegrity(db) {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    const sample = violations.slice(0, 5).map(row => `${row.table}#${row.rowid}→${row.parent}`).join(', ');
    throw new Error(`La importación dejaría referencias huérfanas (${sample})`);
  }
}

// El reset total del ALL IN ONE también limpia los gastos (expenses) y sus pagos
// (expense_payments): no vienen en los CSV y quedaban como referencias huérfanas a
// la caja borrada, abortando la migración ("Nada se importó"). El borrado es
// FK-completo para no romper otras tablas:
//   1) Se desvincula (NULL) el expense_id de las tablas que SOBREVIVEN al reset
//      (activos fijos, mantenimiento de vehículos, nómina): conservan su registro,
//      solo pierden el enlace a un gasto que se va a eliminar.
//   2) Se vacían seller_expense_links (FK NOT NULL a expenses; parte del subsistema
//      de comisiones que el reset ya limpia), expense_payments y expenses.
// (deliveries también referencia expenses, pero ya se vacía en la lista `wipe`).
// Debe correr dentro de la transacción del reset, con las FK desactivadas.
function wipeExpensesFkSafe(db) {
  for (const [table, col] of [['fixed_assets', 'expense_id'], ['vehicle_maintenance', 'expense_id'], ['payroll_items', 'expense_id']]) {
    if (!tableExists(db, table)) continue;
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (cols.includes(col)) db.prepare(`UPDATE ${table} SET ${col}=NULL WHERE ${col} IS NOT NULL`).run();
    } catch (_) { /* esquema antiguo sin esa columna: nada que desvincular */ }
  }
  for (const table of ['seller_expense_links', 'expense_payments', 'expenses']) {
    if (tableExists(db, table)) db.prepare(`DELETE FROM ${table}`).run();
  }
}

// Triggers de inmutabilidad fiscal que bloquean CUALQUIER DELETE sobre las
// tablas de correcciones (ver src/main/sale-corrections-repo.js). El reset total
// del ALL IN ONE necesita vaciar esas tablas; como los triggers no se pueden
// desactivar en SQLite (a diferencia de las foreign keys), se retiran antes del
// borrado y se recrean después. Todo ocurre dentro de la transacción atómica del
// import: si algo falla y se revierte, el DROP también se revierte y los triggers
// vuelven intactos.
const CORRECTION_IMMUTABILITY_TRIGGERS = Object.freeze([
  { name: 'trg_sale_corrections_no_delete', table: 'sale_corrections', message: 'El historial de correcciones es inmutable' },
  { name: 'trg_sale_date_history_no_delete', table: 'sale_date_history', message: 'El historial de fechas es inmutable' },
  { name: 'trg_sale_correction_documents_no_delete', table: 'sale_correction_documents', message: 'Los documentos de una corrección son inmutables' },
]);

function dropCorrectionImmutabilityTriggers(db) {
  for (const trg of CORRECTION_IMMUTABILITY_TRIGGERS) {
    db.prepare(`DROP TRIGGER IF EXISTS ${trg.name}`).run();
  }
}

function restoreCorrectionImmutabilityTriggers(db) {
  for (const trg of CORRECTION_IMMUTABILITY_TRIGGERS) {
    if (!tableExists(db, trg.table)) continue;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${trg.name}
      BEFORE DELETE ON ${trg.table}
      BEGIN
        SELECT RAISE(ABORT, '${trg.message.replace(/'/g, "''")}');
      END;
    `);
  }
}

module.exports = {
  EQUIPARTS_FILES,
  REQUIRED_HEADERS,
  parseCsv,
  loadCsvFile,
  loadEquipartsCsvSet,
  loadEquipartsCsvPayload,
  toNumber,
  toIntegerOrNull,
  normalizeName,
  round2,
  calculateInvoiceFiscalBreakdown,
  groupInvoices,
  groupReceipts,
  computeTargetCxc,
  validateEquipartsData,
  wipeExpensesFkSafe,
  syncImportedCustomerPhones,
  assertForeignKeyIntegrity,
  CORRECTION_IMMUTABILITY_TRIGGERS,
  dropCorrectionImmutabilityTriggers,
  restoreCorrectionImmutabilityTriggers,
};
