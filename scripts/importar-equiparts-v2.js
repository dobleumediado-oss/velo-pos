#!/usr/bin/env node
/**
 * importar-equiparts-v2.js — Importador dedicado de la migración v2.
 *
 * Carga los 4 CSV v2.1 (generados desde el BAK) a Velo POS con identidad real:
 *   - Dedup infalible por code / old_id_cliente / old_id_factura / old_id_pago_detalle
 *   - Inventario real → products (enlaza sale_items por código)
 *   - Detalle real por artículo (sale_items con product_id del catálogo)
 *   - ANULADAS EXCLUIDAS (ya filtradas en el CSV; no deben existir)
 *   - payment_method: balance>0 → 'credito' (aparece en Facturas Pendientes,
 *     abonable); balance=0 → 'efectivo' (pagada)
 *   - Balance del cliente = suma de balance_factura con saldo (del BAK)
 *   - Recibos → payments (solo de facturas NO anuladas), SIN recalcular balance
 *   - NCF fiscal real vinculado a factura y cliente
 *
 * IMPORTANTE: correr con el Electron del proyecto (better-sqlite3 está
 * compilado para Electron, no para Node del sistema):
 *
 *   ./node_modules/.bin/electron scripts/importar-equiparts-v2.js --dir=/ruta/a/los/csv
 *
 * Requiere que la Fase 1 (columnas v2) ya esté aplicada.
 * Idempotente: se puede correr varias veces sin duplicar (dedup por old_id_*).
 *
 * CHECKPOINT: se deriva de los propios CSV al final del proceso (suma de
 * `balance` deduplicada por old_id_factura). No hay numero magico: si cambia
 * el BAK, el target cambia solo.
 */

const path = require('path');
const {
  EQUIPARTS_FILES: FILES,
  loadEquipartsCsvSet,
  toNumber: num,
  toIntegerOrNull: intOrNull,
  normalizeName: norm,
  round2,
  validateEquipartsData,
  syncImportedCustomerPhones,
  assertForeignKeyIntegrity,
} = require('../lib/equiparts-import');

// ── Parseo de argumentos ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
// Carpeta donde están los 4 CSV. Por defecto: ./csv_v2 junto al proyecto.
const CSV_DIR = path.resolve(getArg('dir', path.join(__dirname, '..', 'csv_v2')));
const DATA_DIR = getArg('data-dir', '');
const DRY_RUN = args.includes('--dry-run');

// ── Arranque: inicializar la MISMA DB del proyecto ────────────────────
const database = require('../database');
const resolvedDataDir = DATA_DIR ? path.resolve(DATA_DIR) : path.join(__dirname, '..', 'data');
const db = database.initDB(resolvedDataDir);
// El script debe preparar exactamente el mismo esquema que la aplicación.
// Antes solo llamaba initDB(), por lo que una base nueva carecía de tablas
// creadas por versioning (p. ej. financial_accounts) y el primer abono fallaba.
require('../versioning').initVersioning(db, resolvedDataDir);
database.ensureUppercasePersistence();

console.log('════════════════════════════════════════════════════');
console.log(' IMPORTADOR EQUIPARTS v2');
console.log('════════════════════════════════════════════════════');
console.log('CSV dir :', CSV_DIR);
console.log('Data dir:', resolvedDataDir);
console.log('DRY RUN :', DRY_RUN ? 'SÍ (no escribe nada)' : 'no');
console.log('');

// ── Verificar que la Fase 1 está aplicada ─────────────────────────────
const salesCols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
const custCols  = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
const payCols   = db.prepare('PRAGMA table_info(payments)').all().map(c => c.name);
const need = [
  ['sales','old_id_factura', salesCols],
  ['sales','numero_factura', salesCols],
  ['customers','old_id_cliente', custCols],
  ['payments','old_id_pago_detalle', payCols],
  ['payments','numero_recibo', payCols],
];
const missing = need.filter(([t,c,cols]) => !cols.includes(c));
if (missing.length) {
  console.error('❌ FALTAN COLUMNAS (aplica la Fase 1 primero):');
  missing.forEach(([t,c]) => console.error(`   ${t}.${c}`));
  process.exit(1);
}
console.log('✓ Fase 1 verificada (columnas v2 presentes)\n');

// ── Cargar los CSV ────────────────────────────────────────────────────
const { clientes, inventario, ventas, recibos } = loadEquipartsCsvSet(CSV_DIR);
const validation = validateEquipartsData({ clientes, inventario, ventas, recibos });
console.log(`Cargados: ${clientes.length} clientes, ${inventario.length} productos, ${ventas.length} líneas de venta, ${recibos.length} recibos\n`);

// ══════════════════════════════════════════════════════════════════════
// TRANSACCIÓN ÚNICA — todo o nada
// ══════════════════════════════════════════════════════════════════════
const stats = {
  prod_new: 0, prod_skip: 0,
  cli_new: 0, cli_skip: 0,
  fac_new: 0, fac_skip: 0, fac_cancel: 0, items: 0,
  rec_new: 0, rec_skip: 0,
};

const runImport = db.transaction(() => {

  // ── 0) INVENTARIO (#5) — productos reales, dedup por code ────────────
  const findProdByCode = db.prepare(`SELECT id FROM products WHERE code = ? LIMIT 1`);
  const insProd = db.prepare(`
    INSERT INTO products(code, barcode, name, brand, category, cost, price, wholesale, taxable, tax_pct, stock, stock_min, unit, active)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const p of inventario) {
    const code = (p.code || '').trim();
    if (!code) continue;
    if (findProdByCode.get(code)) { stats.prod_skip++; continue; }
    // ITBIS por artículo (viene de articulo.itbis en faprodb).
    // El CSV trae taxable 1/0; tax_pct siempre 18 (el único artículo al 15%
    // se normalizó a 18, y los exentos conservan 18 para que marcar la
    // casilla en Velo calcule bien sin editar el porcentaje a mano).
    // Si el CSV no trae las columnas (formato viejo) → gravado al 18%.
    const taxable = (String(p.taxable).trim() === '0') ? 0 : 1;
    const taxPct  = num(p.tax_pct) || 18;
    insProd.run(
      code,
      (p.barcode || code).trim(),
      (p.name || 'Producto').trim(),
      (p.brand || 'GENERICA').trim(),
      (p.category || 'GENERICO').trim(),
      num(p.cost), num(p.price), num(p.wholesale),
      taxable, taxPct,
      parseInt(p.stock, 10) || 0,
      parseInt(p.stock_min, 10) || 5,
      (p.unit || 'UNIDAD').trim()
    );
    stats.prod_new++;
  }
  // Mapa code → product_id (para enlazar sale_items al catálogo real, #4)
  const prodByCode = new Map(db.prepare(`SELECT id, code FROM products WHERE active=1`).all()
    .map(x => [x.code, x.id]));

  // ── 1) CLIENTES ─────────────────────────────────────────────────────
  // Mapa old_id_cliente → customer_id de Velo.
  const mapCli = new Map();
  const insCli = db.prepare(`
    INSERT INTO customers(name, rnc, phone, address, email, credit_days, balance, active, old_id_cliente, import_source)
    VALUES(?, ?, ?, ?, ?, ?, 0, 1, ?, 'equiparts_bak')
  `);
  const findCliByOld = db.prepare(`SELECT id FROM customers WHERE old_id_cliente = ? LIMIT 1`);
  for (const c of clientes) {
    const oldId = intOrNull(c.old_id_cliente);
    if (oldId == null) continue;
    const tel = (c.phone   || '').trim();
    const cel = (c.celular || '').trim();
    // dedup por old_id_cliente
    const exist = findCliByOld.get(oldId);
    if (exist) {
      syncImportedCustomerPhones(db, exist.id, tel, cel);
      mapCli.set(oldId, exist.id);
      stats.cli_skip++;
      continue;
    }
    if (norm(c.name) === norm('Consumidor Final')) {
      db.prepare(`
        UPDATE customers SET old_id_cliente=?,import_source='equiparts_bak',rnc=?,address=?,email=?,credit_days=?
        WHERE id=1
      `).run(oldId, c.rnc || '', c.address || '', c.email || '', intOrNull(c.credit_days) || 30);
      syncImportedCustomerPhones(db, 1, tel, cel);
      mapCli.set(oldId, 1);
      stats.cli_skip++;
      continue;
    }
    const r = insCli.run(
      c.name || 'Cliente',
      c.rnc || '', '', c.address || '', c.email || '',
      intOrNull(c.credit_days) || 30,
      oldId
    );
    syncImportedCustomerPhones(db, Number(r.lastInsertRowid), tel, cel);
    mapCli.set(oldId, r.lastInsertRowid);
    stats.cli_new++;
  }

  // Resolver customer_id: por old_id_cliente, luego por nombre, luego Consumidor Final (1)
  const custByName = new Map(db.prepare(`SELECT id, name FROM customers WHERE active=1`).all()
    .map(x => [norm(x.name), x.id]));
  const resolveCust = (oldId, name) => {
    if (oldId != null && mapCli.has(oldId)) return mapCli.get(oldId);
    const byOld = oldId != null ? findCliByOld.get(oldId) : null;
    if (byOld) return byOld.id;
    const byName = custByName.get(norm(name));
    if (byName) return byName.id;
    return 1; // Consumidor Final
  };

  // ── 2) VENTAS (agrupadas por old_id_factura) ────────────────────────
  const findSaleByOld = db.prepare(`SELECT id FROM sales WHERE old_id_factura = ? LIMIT 1`);
  const insSale = db.prepare(`
    INSERT INTO sales(
      cash_session_id, customer_id, customer_name, customer_rnc,
      type, status, subtotal, discount_pct, discount_amt,
      tax_pct, tax_amt, total, payment_method, price_mode,
      cajero, user_id, ncf, notes, created_at,
      numero_factura, numero_factura_fmt, old_id_factura, source_balance, import_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'retail', 'Importación histórica', NULL, ?, ?, ?, ?, ?, ?, ?, 'equiparts_bak')
  `);
  // product_id se enlaza al catálogo real por código (#4, #2). Si no existe, NULL.
  const insItem = db.prepare(`
    INSERT INTO sale_items(sale_id, product_id, product_code, product_name, unit_cost, unit_price, qty, subtotal,
      taxable,tax_pct,tax_amt,net_subtotal)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);
  const facturas = validation.invoices;

  // Acumular balance por cliente (SOLO facturas Pendientes → CxC real)
  const balByCust = new Map();

  for (const f of facturas.values()) {
    // dedup infalible
    if (findSaleByOld.get(f.old_id_factura)) { stats.fac_skip++; continue; }

    const custId = resolveCust(f.old_id_cliente, f.customer_name);
    const dt = (f.date || new Date().toISOString().split('T')[0]) + ' 00:00:00';
    const fmt = f.numero_factura_fmt || (f.numero_factura != null ? String(f.numero_factura).padStart(8,'0') : '');
    const notes = (f.numero_factura != null
      ? `Factura #${fmt}${f.ncf ? ' | NCF:' + f.ncf : ''}` : 'Factura importada')
      + (f.factura_nota ? ' | ' + f.factura_nota : '');
    const customer = db.prepare('SELECT rnc FROM customers WHERE id=?').get(custId);
    const items = f.items.length ? f.items
      : [{ product_code: 'IMP', product_name: 'Factura importada', qty: 1, unit_price: f.total, line_total: f.total, taxable: 1, tax_pct: 18 }];
    const fiscalItems = items.map(item => {
      const lineGross = round2(item.line_total || item.unit_price * item.qty);
      const taxPct = item.taxable ? (Number(item.tax_pct) || 18) : 0;
      const taxAmt = taxPct > 0 ? round2(lineGross - lineGross / (1 + taxPct / 100)) : 0;
      return { ...item, lineGross, taxPct, taxAmt, netSubtotal: round2(lineGross - taxAmt) };
    });
    const taxAmt = round2(fiscalItems.reduce((sum, item) => sum + item.taxAmt, 0));
    const netSubtotal = round2(f.total - taxAmt);
    const taxRates = [...new Set(fiscalItems.filter(item => item.taxPct > 0).map(item => item.taxPct))];
    const saleTaxPct = taxRates.length === 1 ? taxRates[0] : 0;

    const r = insSale.run(
      null, custId, f.customer_name, customer?.rnc || '', 'factura', f.status,
      netSubtotal, saleTaxPct, taxAmt, f.total, f.payment_method,
      f.ncf, notes, dt,
      f.numero_factura, fmt, f.old_id_factura, f.balance
    );
    const saleId = r.lastInsertRowid;

    // items (detalle real). Si no hay, una línea genérica.
    for (const it of fiscalItems) {
      const pid = prodByCode.get((it.product_code || '').trim()) || null;
      insItem.run(saleId, pid, it.product_code, it.product_name, it.unit_price, it.qty,
        it.lineGross, it.taxable ? 1 : 0, it.taxPct, it.taxAmt, it.netSubtotal);
      stats.items++;
    }

    stats.fac_new++;
    // Balance del cliente = suma de balance_factura con saldo pendiente.
    // Anuladas ya fueron excluidas en el CSV, así que toda factura con
    // balance>0 aquí es CxC real cobrable.
    if (f.balance > 0) {
      balByCust.set(custId, (balByCust.get(custId) || 0) + f.balance);
    }
  }

  // ── 3) RECIBOS → un payment por recibo/método, varias allocations ───
  const sourceBalances = new Map([...mapCli.values()].map(customerId => [Number(customerId), 0]));
  for (const invoice of facturas.values()) {
    const customerId = resolveCust(invoice.old_id_cliente, invoice.customer_name);
    sourceBalances.set(customerId, round2((sourceBalances.get(customerId) || 0) + invoice.balance));
  }
  const findPayByOld = db.prepare(`SELECT id FROM payments WHERE old_id_pago_detalle = ? LIMIT 1`);
  const findLegacyDetail = db.prepare(`
    SELECT payment_id FROM legacy_payment_details
    WHERE import_source='equiparts_bak' AND old_id_pago_detalle=?
  `);
  const findSaleForRec = db.prepare(`SELECT id, customer_id FROM sales WHERE old_id_factura = ? LIMIT 1`);
  const insPay = db.prepare(`
    INSERT INTO payments(customer_id, sale_id, amount, method, note,
      balance_before, balance_after, cajero, user_id, created_at,
      numero_recibo, old_id_pago_detalle, import_source)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'Importación histórica', NULL, ?, ?, ?, 'equiparts_bak')
  `);
  const insAllocation = db.prepare(`
    INSERT OR IGNORE INTO payment_allocations(payment_id,sale_id,amount,invoice_balance_before,invoice_balance_after)
    VALUES(?,?,?,?,?)
  `);
  const insLegacyDetail = db.prepare(`
    INSERT OR IGNORE INTO legacy_payment_details(import_source,old_id_pago_detalle,payment_id,sale_id,amount,method)
    VALUES('equiparts_bak',?,?,?,?,?)
  `);
  const receiptBalances = new Map();
  const receiptsByInvoice = new Map();
  for (const receipt of recibos) {
    const invoiceId = intOrNull(receipt.old_id_factura);
    if (!receiptsByInvoice.has(invoiceId)) receiptsByInvoice.set(invoiceId, []);
    receiptsByInvoice.get(invoiceId).push(receipt);
  }
  for (const [invoiceId, rows] of receiptsByInvoice.entries()) {
    let after = round2(facturas.get(invoiceId)?.balance || 0);
    const ordered = [...rows].sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) ||
      (intOrNull(a.old_id_pago_detalle) - intOrNull(b.old_id_pago_detalle))
    );
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const receipt = ordered[index];
      const before = round2(after + num(receipt.amount));
      receiptBalances.set(String(receipt.old_id_pago_detalle), { before, after });
      after = before;
    }
  }

  const groupCustomerBalances = new Map();
  const groupsByCustomer = new Map();
  for (const group of validation.receiptGroups.values()) {
    const customerId = resolveCust(group.old_id_cliente, group.customer_name);
    if (!groupsByCustomer.has(customerId)) groupsByCustomer.set(customerId, []);
    groupsByCustomer.get(customerId).push(group);
  }
  for (const [customerId, groups] of groupsByCustomer.entries()) {
    let after = round2(sourceBalances.get(customerId) || 0);
    const ordered = [...groups].sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) ||
      ((a.numero_recibo ?? 0) - (b.numero_recibo ?? 0)) || a.key.localeCompare(b.key)
    );
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const group = ordered[index];
      const before = round2(after + group.amount);
      groupCustomerBalances.set(group.key, { before, after });
      after = before;
    }
  }

  for (const group of validation.receiptGroups.values()) {
    const mappedPaymentIds = [...new Set(group.rows
      .map(row => findLegacyDetail.get(row.old_id_pago_detalle)?.payment_id)
      .filter(Boolean))];
    if (mappedPaymentIds.length > 1) {
      throw new Error(`Recibo ${group.numero_recibo}: sus aplicaciones ya apuntan a pagos diferentes`);
    }
    if (mappedPaymentIds.length === 1) {
      stats.rec_skip++;
      continue;
    }
    // Compatibilidad con una ejecución de la versión anterior: el primer
    // detalle estaba guardado directamente en payments.old_id_pago_detalle.
    const legacyPayment = findPayByOld.get(group.rows[0].old_id_pago_detalle);
    if (legacyPayment) {
      stats.rec_skip++;
      continue;
    }

    const allocationBySale = new Map();
    for (const row of group.rows) {
      const sale = findSaleForRec.get(intOrNull(row.old_id_factura));
      if (!sale) throw new Error(`Recibo ${group.numero_recibo || row.old_id_pago_detalle}: la factura importada no existe`);
      const detailBalance = receiptBalances.get(String(row.old_id_pago_detalle)) || { before: 0, after: 0 };
      const allocation = allocationBySale.get(sale.id) || {
        saleId: sale.id, customerId: sale.customer_id, amount: 0,
        before: detailBalance.before, after: detailBalance.after, rows: [],
      };
      allocation.amount = round2(allocation.amount + row.amount);
      allocation.before = Math.max(allocation.before, detailBalance.before);
      allocation.after = Math.min(allocation.after, detailBalance.after);
      allocation.rows.push(row);
      allocationBySale.set(sale.id, allocation);
    }
    const allocations = [...allocationBySale.values()];
    if (allocations.some(allocation => allocation.customerId !== allocations[0].customerId)) {
      throw new Error(`Recibo ${group.numero_recibo}: contiene facturas de clientes diferentes`);
    }
    const balances = groupCustomerBalances.get(group.key) || { before: 0, after: 0 };
    const note = [`Recibo #${group.numero_recibo || ''}`, ...group.notes].filter(Boolean).join(' | ');
    const dt = (group.date || new Date().toISOString().split('T')[0]) + ' 00:00:00';
    const payment = insPay.run(
      allocations[0].customerId, allocations[0].saleId, group.amount, group.method,
      note, balances.before, balances.after, dt, group.numero_recibo, group.rows[0].old_id_pago_detalle
    );
    const paymentId = Number(payment.lastInsertRowid);
    for (const allocation of allocations) {
      insAllocation.run(paymentId, allocation.saleId, allocation.amount, allocation.before, allocation.after);
      for (const row of allocation.rows) {
        insLegacyDetail.run(row.old_id_pago_detalle, paymentId, allocation.saleId, row.amount, group.method);
      }
    }
    stats.rec_new++;
  }

  // ── 4) BALANCE DEL CLIENTE = suma de balance_factura pendientes (BAK) ─
  // El balance manda desde el BAK, NO se recalcula restando abonos.
  const dueByCust = new Map();
  const creditDays = new Map(db.prepare('SELECT id,COALESCE(credit_days,30) days FROM customers').all().map(row => [row.id, row.days]));
  for (const invoice of facturas.values()) {
    const customerId = resolveCust(invoice.old_id_cliente, invoice.customer_name);
    if (invoice.balance > 0 && invoice.date) {
      const due = new Date(`${invoice.date}T12:00:00`);
      due.setDate(due.getDate() + (parseInt(creditDays.get(customerId), 10) || 30));
      const dueText = due.toISOString().slice(0, 10);
      if (!dueByCust.has(customerId) || dueText < dueByCust.get(customerId)) dueByCust.set(customerId, dueText);
    }
  }
  const setBal = db.prepare(`UPDATE customers SET balance = ?, credit_due = ? WHERE id = ?`);
  for (const [custId, balance] of sourceBalances.entries()) {
    const amount = round2(balance);
    setBal.run(amount, amount > 0 ? (dueByCust.get(custId) || null) : null, custId);
  }

  const cxc = round2(db.prepare(`SELECT COALESCE(SUM(balance),0) total FROM customers WHERE active=1 AND balance>0`).get().total);
  if (Math.abs(cxc - validation.targetCxc) >= 0.01) {
    throw new Error(`CxC no cuadra: Velo RD$${cxc.toFixed(2)} / CSV RD$${validation.targetCxc.toFixed(2)}`);
  }
  assertForeignKeyIntegrity(db);

  return balByCust;
});

// ── Ejecutar ───────────────────────────────────────────────────────────
if (DRY_RUN) {
  console.log('DRY RUN: no se ejecuta la transacción. (Quita --dry-run para importar de verdad.)');
  process.exit(0);
}

const balByCust = runImport();

// ── Reporte ────────────────────────────────────────────────────────────
console.log('──────────────────────────────────────');
console.log('RESULTADO DE LA IMPORTACIÓN');
console.log('──────────────────────────────────────');
console.log(`Productos: ${stats.prod_new} nuevos, ${stats.prod_skip} ya existían`);
console.log(`Clientes:  ${stats.cli_new} nuevos, ${stats.cli_skip} ya existían`);
console.log(`Facturas:  ${stats.fac_new} importadas, ${stats.fac_skip} ya existían`);
console.log(`Items:     ${stats.items} líneas de detalle`);
console.log(`Recibos:   ${stats.rec_new} nuevos, ${stats.rec_skip} ya existían`);
console.log('');

// ── Validación de integridad ───────────────────────────────────────────
const cxc = db.prepare(`
  SELECT
    ROUND(SUM(balance), 2) AS cxc_total,
    COUNT(*)               AS clientes_con_saldo
  FROM customers WHERE balance > 0 AND active = 1
`).get();

const facturasImp = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE import_source='equiparts_bak'`).get().n;
const pendientes  = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE import_source='equiparts_bak' AND status='completed'`).get().n;

console.log('══════════════════════════════════════');
console.log('VALIDACIÓN DE INTEGRIDAD (CxC)');
console.log('══════════════════════════════════════');
console.log(`CxC total en Velo:    RD$${(cxc.cxc_total || 0).toLocaleString('en-US', {minimumFractionDigits:2})}`);
console.log(`Clientes con saldo:   ${cxc.clientes_con_saldo}`);
console.log(`Facturas importadas:  ${facturasImp}`);
console.log('');

// Target DINAMICO: sale de los propios CSV, no de una constante. El campo
// `balance` se repite en cada item de una misma factura (identificada por
// old_id_factura), asi que se toma UNA sola vez por factura y se suman solo
// las que tienen balance > 0. Mismo criterio que el ALL IN ONE en main.js.
const balancePorFactura = new Map();
for (const row of ventas) {
  const oid = row.old_id_factura;
  if (!balancePorFactura.has(oid)) balancePorFactura.set(oid, num(row.balance));
}
let targetCxc = 0;
for (const bal of balancePorFactura.values()) if (bal > 0) targetCxc += bal;
targetCxc = Math.round(targetCxc * 100) / 100;
const targetPend = [...balancePorFactura.values()].filter(b => b > 0).length;

console.log(`TARGET (desde el CSV): RD$${targetCxc.toLocaleString('en-US', {minimumFractionDigits:2})} / ${targetPend} facturas pendientes`);

const diff = Math.abs(Math.round((cxc.cxc_total || 0) * 100) / 100 - targetCxc);
if (diff < 0.01) {
  console.log('\n✅ CxC CUADRA con el total del CSV. Importación correcta.');
} else {
  console.log(`\n⚠️  CxC difiere del target por RD$${diff.toFixed(2)}. Revisar antes de dar por buena la carga.`);
}

process.exit(0);
