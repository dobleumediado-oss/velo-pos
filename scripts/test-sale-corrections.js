#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log('  ✓', message); }
  else { fail++; console.log('  ✗ FALLO:', message); }
}
function expectThrow(fn, pattern, message) {
  try {
    fn();
    ok(false, `${message} (no lanzó)`);
  } catch (error) {
    ok(!pattern || pattern.test(error.message), `${message}${pattern && !pattern.test(error.message) ? ` (${error.message})` : ''}`);
  }
}

const tmpDir = path.join(os.tmpdir(), `velo_sale_corrections_${Date.now()}`);
const DB = require('../database');
DB.initDB(tmpDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tmpDir);

const admin = db.prepare("SELECT id,name,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const superadmin = db.prepare("SELECT id,name,role FROM users WHERE role='superadmin' ORDER BY id LIMIT 1").get();
const password = db.prepare('SELECT password FROM users WHERE id=?').get(admin.id).password;
const cashierId = Number(db.prepare(`
  INSERT INTO users(name,email,password,role,active)
  VALUES('Cajero Prueba','cashier-corrections@test.local',?,'cajero',1)
`).run(password).lastInsertRowid);
const cashier = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(cashierId);

db.prepare("UPDATE settings SET value='1' WHERE key='fiscal_enabled'").run();
db.prepare(`
  INSERT INTO ncf_sequences(type,prefix,from_num,to_num,current,active,alert_at)
  VALUES('B02','B02',1,9999,0,1,10)
`).run();
db.prepare(`
  INSERT INTO ncf_sequences(type,prefix,from_num,to_num,current,active,alert_at)
  VALUES('B04','B04',1,9999,0,1,10)
`).run();

const customerId = DB.customersRepo.create({ name: 'Cliente Correcciones', rnc: '00100000001', credit_days: 30 });
db.prepare('UPDATE customers SET credit_limit=100000,credit_days=30 WHERE id=?').run(customerId);
const productId = DB.productsRepo.create({
  code: 'COR-001', name: 'Producto corrección', cost: 60, price: 118,
  stock: 100, taxable: 1, tax_pct: 18,
});
const cashId = DB.cashRepo.open({
  userId: admin.id, cajero: admin.name, openAmount: 5000, openBills: {}, terminalId: 'corrections-test',
});

function createSale({ date, method = 'efectivo', qty = 2 } = {}) {
  return DB.salesRepo.create({
    customer: { id: customerId },
    items: [{
      product_id: productId, product_code: 'COR-001', product_name: 'Producto corrección',
      unit_cost: 60, unit_price: 118, taxable: 1, tax_pct: 18, qty,
    }],
    payment: { method, saleDate: date },
    session: { id: cashId },
    user: admin,
    type: 'factura',
  });
}

function change(sale, date, actor = admin, suffix = '') {
  const current = DB.salesRepo.getById(sale.saleId || sale.id);
  return DB.saleCorrectionsRepo.changeDate({
    saleId: current.id,
    newSaleDate: date,
    reason: `Corrección controlada ${suffix || date}`,
    userId: actor.id,
    authorizedByUserId: actor.id,
    expectedRevision: current.revision,
    idempotencyKey: `correction-${current.id}-${date}-${suffix || Date.now()}`,
    terminalId: 'test-terminal',
  });
}

console.log('\n== A. Fechas separadas y datos fiscales ==');
const paid = createSale({ date: '2025-01-10', method: 'efectivo', qty: 4 });
const original = DB.salesRepo.getById(paid.saleId);
const originalMovement = db.prepare(
  "SELECT id,created_at FROM cash_movements WHERE reference_id=? AND type='venta' ORDER BY id LIMIT 1"
).get(original.id);
const originalInventory = db.prepare(
  "SELECT id,created_at,operational_sale_date FROM inventory_movements WHERE sale_id=? ORDER BY id LIMIT 1"
).get(original.id);
const originalNcf = db.prepare('SELECT ncf,issued_at FROM ncf_log WHERE sale_id=?').get(original.id);
db.prepare(`
  INSERT INTO payments(customer_id,sale_id,amount,method,note,cajero,user_id,cash_session_id,created_at)
  VALUES(?,?,?,?,?,?,?,?,?)
`).run(customerId, original.id, 25, 'transferencia', 'Abono de prueba', admin.name, admin.id, cashId, '2025-01-12 10:30:00');
const paymentBefore = db.prepare('SELECT created_at FROM payments WHERE sale_id=? ORDER BY id DESC LIMIT 1').get(original.id);

const firstChange = change(paid, '2025-01-11', admin, 'same-month');
const corrected = DB.salesRepo.getById(original.id);
ok(corrected.sale_date === '2025-01-11', 'cambia la fecha operativa de factura pagada');
ok(corrected.original_sale_date === '2025-01-10', 'conserva original_sale_date inmutable');
ok(corrected.created_at === original.created_at, 'conserva created_at técnico real');
ok(corrected.ncf === original.ncf && corrected.total === original.total, 'conserva NCF y total originales');
ok(corrected.fiscal_issued_at === original.fiscal_issued_at, 'conserva fecha fiscal');
ok(db.prepare('SELECT created_at FROM cash_movements WHERE id=?').get(originalMovement.id).created_at === originalMovement.created_at,
  'conserva fecha real del movimiento de caja');
ok(db.prepare('SELECT created_at FROM payments WHERE sale_id=? ORDER BY id DESC LIMIT 1').get(original.id).created_at === paymentBefore.created_at,
  'conserva fecha real del pago');
const inventoryAfter = db.prepare('SELECT created_at,operational_sale_date FROM inventory_movements WHERE id=?').get(originalInventory.id);
ok(inventoryAfter.created_at === originalInventory.created_at && inventoryAfter.operational_sale_date === '2025-01-11',
  'conserva fecha física de inventario y mueve solo su fecha operativa');
const ncfAfter = db.prepare('SELECT ncf,issued_at FROM ncf_log WHERE sale_id=?').get(original.id);
ok(ncfAfter.ncf === originalNcf.ncf && ncfAfter.issued_at === originalNcf.issued_at,
  'no refecha ni reemplaza el registro fiscal');

console.log('\n== B. Reportes comerciales, fiscal y períodos ==');
const oldSummary = DB.reportsRepo.summary('custom', '2025-01-10', '2025-01-10');
const newSummary = DB.reportsRepo.summary('custom', '2025-01-11', '2025-01-11');
ok(oldSummary.totalRev === 0 && newSummary.totalRev === original.total,
  'mueve la venta del día anterior al nuevo día comercial');
change(paid, '2025-02-05', admin, 'other-month');
ok(DB.salesRepo.getById(original.id).sale_date === '2025-02-05', 'cambia la factura a otro mes');
change(paid, '2024-12-31', admin, 'other-year');
ok(DB.salesRepo.getById(original.id).sale_date === '2024-12-31', 'cambia la factura a otro año y fecha anterior');
expectThrow(() => change(paid, '2099-01-01', admin, 'future'), /futuras/i,
  'bloquea fecha futura cuando la configuración no la permite');
ok(db.prepare('SELECT issued_at FROM ncf_log WHERE sale_id=?').get(original.id).issued_at === originalNcf.issued_at,
  'el reporte fiscal sigue anclado a issued_at');

db.prepare(`
  INSERT INTO cash_sessions(user_id,cajero,open_date,open_time,close_date,close_time,status)
  VALUES(?,?,?,?,?,?,'closed')
`).run(admin.id, admin.name, '2025-01-15', '08:00:00', '2025-01-15', '18:00:00');
const cashImpact = DB.saleCorrectionsRepo.impact(original.id, '2025-01-15', admin.id);
ok(cashImpact.warnings.some(w => w.code === 'CLOSED_CASH'), 'advierte cuando la fecha destino tiene caja cerrada');
change(paid, '2025-01-15', admin, 'closed-cash');
ok(db.prepare("SELECT status FROM cash_sessions WHERE open_date='2025-01-15'").get().status === 'closed',
  'no sobrescribe el cierre de caja cerrado');

db.prepare(`
  INSERT INTO accounting_periods(name,date_from,date_to,status)
  VALUES('Marzo cerrado','2025-03-01','2025-03-31','cerrado')
`).run();
expectThrow(() => change(paid, '2025-03-10', admin, 'closed-period'), /sales\.override_closed_period/i,
  'exige permiso especial para período contable cerrado');
change(paid, '2025-03-10', superadmin, 'closed-period-override');
ok(DB.salesRepo.getById(original.id).sale_date === '2025-03-10', 'superadmin autorizado mueve la fecha sin reabrir el período');

console.log('\n== C. Contabilidad, e-CF y comisiones ==');
db.prepare("UPDATE settings SET value='1' WHERE key='module_contabilidad'").run();
change(paid, '2025-04-01', superadmin, 'open-accounting-period');
const entry = DB.accountingRepo.generateSaleEntry({ saleId: original.id, userId: admin.id });
const accountingBefore = entry
  ? db.prepare('SELECT date,status FROM accounting_entries WHERE id=?').get(entry.entryId || entry.id)
  : null;
db.prepare(`
  INSERT INTO ecf_log(sale_id,encf,tipo,estado,emitido_at)
  VALUES(?,?,?,'Aceptado',?)
`).run(original.id, original.ncf, '32', original.fiscal_issued_at);
const ecfImpact = DB.saleCorrectionsRepo.impact(original.id, '2025-04-02', superadmin.id);
ok(ecfImpact.warnings.some(w => w.code === 'FISCAL_DATE_IMMUTABLE'),
  'advierte que un e-CF aceptado conserva fecha fiscal');
change(paid, '2025-04-02', superadmin, 'accepted-ecf');
const accountingAfter = accountingBefore
  ? db.prepare('SELECT date,status FROM accounting_entries WHERE id=?').get(entry.entryId || entry.id)
  : null;
ok(!accountingBefore || (accountingAfter.date === accountingBefore.date && accountingAfter.status === accountingBefore.status),
  'conserva fecha y estado del asiento contabilizado');

const salespersonId = Number(db.prepare(`
  INSERT INTO salespeople(code,name,seller_type,status,commission_mode,commission_rate,commission_frequency)
  VALUES('COR-SELL','Vendedor Corrección','ambulante','activo','percent_sales',5,'mensual')
`).run().lastInsertRowid);
db.prepare('UPDATE sales SET salesperson_id=? WHERE id=?').run(salespersonId, original.id);
const runId = Number(db.prepare(`
  INSERT INTO seller_commission_runs(
    salesperson_id,date_from,date_to,frequency,calculation_mode,rate,
    sales_total,margin_total,commission_total,status
  ) VALUES(?,?,?,?,?,?,?,?,?,'pagado')
`).run(salespersonId, '2025-04-01', '2025-04-30', 'mensual', 'porcentaje_venta', 5,
  original.total, original.total - 240, original.total * 0.05).lastInsertRowid);
db.prepare(`
  INSERT INTO seller_commission_lines(
    commission_run_id,source_type,source_id,sale_date,reference,customer_name,
    sale_amount,cost_amount,commission_base,commission_amount
  ) VALUES(?,'sistema',?,?,?,?,?,?,?,?)
`).run(runId, original.id, '2025-04-02', original.document_number_fmt, original.customer_name,
  original.total, 240, original.total, original.total * 0.05);
change(paid, '2025-05-03', superadmin, 'paid-commission');
ok(db.prepare('SELECT status FROM seller_commission_runs WHERE id=?').get(runId).status === 'pagado',
  'no elimina ni reabre una comisión pagada');
ok(db.prepare('SELECT COUNT(*) count FROM commission_adjustments WHERE sale_id=?').get(original.id).count === 1,
  'genera ajuste de comisión al mover una venta ya pagada');

console.log('\n== D. Crédito, permisos, idempotencia y concurrencia ==');
const credit = createSale({ date: '2025-06-01', method: 'credito', qty: 1 });
const balanceBefore = db.prepare('SELECT balance,credit_due FROM customers WHERE id=?').get(customerId);
change(credit, '2025-06-15', admin, 'credit-sale');
const balanceAfter = db.prepare('SELECT balance,credit_due FROM customers WHERE id=?').get(customerId);
ok(balanceAfter.balance === balanceBefore.balance && balanceAfter.credit_due === balanceBefore.credit_due,
  'mueve factura a crédito sin duplicar saldo ni recalcular vencimiento silenciosamente');
expectThrow(() => change(credit, '2025-06-16', cashier, 'no-permission'), /sales\.correct/i,
  'bloquea cambio de fecha sin permisos');

const concurrent = createSale({ date: '2025-07-01', method: 'efectivo', qty: 1 });
const concurrentSnapshot = DB.salesRepo.getById(concurrent.saleId);
const idempotencyKey = `same-request-${concurrent.saleId}-${Date.now()}`;
const once = DB.saleCorrectionsRepo.changeDate({
  saleId: concurrent.saleId, newSaleDate: '2025-07-02', reason: 'Prueba idempotente',
  userId: admin.id, expectedRevision: concurrentSnapshot.revision, idempotencyKey,
});
const twice = DB.saleCorrectionsRepo.changeDate({
  saleId: concurrent.saleId, newSaleDate: '2025-07-02', reason: 'Prueba idempotente',
  userId: admin.id, expectedRevision: concurrentSnapshot.revision, idempotencyKey,
});
ok(!once.idempotent && twice.idempotent && once.correctionId === twice.correctionId,
  'un doble clic reutiliza la misma corrección idempotente');
expectThrow(() => DB.saleCorrectionsRepo.changeDate({
  saleId: concurrent.saleId, newSaleDate: '2025-07-03', reason: 'Segundo usuario concurrente',
  userId: admin.id, expectedRevision: concurrentSnapshot.revision,
  idempotencyKey: `concurrent-${Date.now()}`,
}), /modificada por otro usuario/i, 'rechaza escritura concurrente con revisión obsoleta');
ok(DB.salesRepo.getById(concurrent.saleId).sale_date === '2025-07-02',
  'un conflicto revierte toda la segunda transacción');

console.log('\n== E. Administración, devoluciones y auditoría ==');
const beforeAdmin = DB.salesRepo.getById(concurrent.saleId);
DB.saleCorrectionsRepo.updateAdministrativeData({
  saleId: concurrent.saleId,
  values: { internal_note: 'Entregar por puerta lateral', order_reference: 'PED-99', route: 'Norte' },
  reason: 'Completar datos de entrega',
  userId: admin.id,
  expectedRevision: beforeAdmin.revision,
  idempotencyKey: `admin-${concurrent.saleId}-${Date.now()}`,
});
const afterAdmin = DB.salesRepo.getById(concurrent.saleId);
ok(afterAdmin.total === beforeAdmin.total && afterAdmin.ncf === beforeAdmin.ncf &&
  JSON.parse(afterAdmin.administrative_data).order_reference === 'PED-99',
  'edita solo campos administrativos y conserva datos fiscales/financieros');
const history = DB.saleCorrectionsRepo.history(concurrent.saleId, admin.id);
ok(history.corrections.length === 2 && history.dateHistory.length === 1,
  'expone línea de tiempo con fecha y cambio administrativo');
expectThrow(() => db.prepare('DELETE FROM sale_corrections WHERE sale_id=?').run(concurrent.saleId),
  /inmutable/i, 'impide borrar el historial desde la base');
expectThrow(() => db.prepare('UPDATE sales SET original_sale_date=? WHERE id=?').run('2020-01-01', concurrent.saleId),
  /inmutable/i, 'impide sobrescribir la fecha original');
expectThrow(() => db.prepare('UPDATE sales SET created_at=? WHERE id=?').run('2020-01-01 00:00:00', concurrent.saleId),
  /inmutable/i, 'impide sobrescribir created_at');

const returnSource = createSale({ date: '2025-07-05', method: 'efectivo', qty: 3 });
const stockAfterSale = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
const partial = DB.returnsRepo.create({
  originalSaleId: returnSource.saleId,
  items: [{ product_id: productId, qty: 1 }],
  session: { id: cashId },
  user: admin,
  reason: 'Devolución parcial de prueba',
});
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === stockAfterSale + 1,
  'devolución parcial crea entrada compensatoria de inventario');
ok(DB.salesRepo.getById(returnSource.saleId).status === 'completed' &&
  DB.salesRepo.getById(partial.returnId).original_sale_id === returnSource.saleId,
  'devolución parcial conserva factura original y enlaza nota de crédito');
const full = DB.returnsRepo.create({
  originalSaleId: returnSource.saleId,
  items: [{ product_id: productId, qty: 2 }],
  session: { id: cashId },
  user: admin,
  reason: 'Devolución total restante',
});
ok(DB.salesRepo.getById(returnSource.saleId).status === 'returned',
  'devolución total marca compensada sin eliminar la factura');
ok(DB.salesRepo.getById(full.returnId).ncf.startsWith('B04'),
  'nota de crédito fiscal usa secuencia B04 y referencia la factura');

console.log('\n== F. Corrección simple de productos y cantidades ==');
const addedProductId = DB.productsRepo.create({
  code: 'COR-002', name: 'Producto agregado', cost: 35, price: 59,
  stock: 50, taxable: 1, tax_pct: 18,
});
const productSource = createSale({ date: '2025-07-10', method: 'efectivo', qty: 3 });
const productOriginalBefore = DB.salesRepo.getById(productSource.saleId);
const productOriginalStock = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
const firstProductModel = DB.saleCorrectionsRepo.productCorrectionModel(productSource.saleId, admin.id);
const reduceKey = `products-reduce-${productSource.saleId}-${Date.now()}`;
const reduced = DB.saleCorrectionsRepo.correctProducts({
  saleId: productSource.saleId,
  lines: firstProductModel.lines.map(line => ({
    sourceSaleId: line.source_sale_id,
    productId: line.product_id,
    targetQty: line.product_id === productId ? 2 : line.current_qty,
  })),
  addedItems: [],
  reason: 'Cliente solicitó una unidad menos',
  userId: admin.id,
  expectedRevision: firstProductModel.root.revision,
  idempotencyKey: reduceKey,
  session: { id: cashId },
  additionPaymentMethod: 'efectivo',
});
ok(reduced.returnIds.length === 1 && !reduced.additionSaleId,
  'reducir cantidad genera solo una nota de crédito');
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === productOriginalStock + 1,
  'reducir cantidad repone exactamente la diferencia al inventario');
const productOriginalAfterReduction = DB.salesRepo.getById(productSource.saleId);
ok(productOriginalAfterReduction.items[0].qty === 3 &&
  productOriginalAfterReduction.total === productOriginalBefore.total &&
  productOriginalAfterReduction.ncf === productOriginalBefore.ncf,
  'la reducción conserva líneas, total y NCF de la factura original');
const reducedAgain = DB.saleCorrectionsRepo.correctProducts({
  saleId: productSource.saleId,
  lines: [],
  addedItems: [],
  reason: 'Cliente solicitó una unidad menos',
  userId: admin.id,
  expectedRevision: firstProductModel.root.revision,
  idempotencyKey: reduceKey,
  session: { id: cashId },
  additionPaymentMethod: 'efectivo',
});
ok(reducedAgain.idempotent && reducedAgain.correctionId === reduced.correctionId,
  'doble confirmación de productos no duplica documentos ni inventario');

const increaseModel = DB.saleCorrectionsRepo.productCorrectionModel(productSource.saleId, admin.id);
const stockBeforeIncrease = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
const increased = DB.saleCorrectionsRepo.correctProducts({
  saleId: productSource.saleId,
  lines: increaseModel.lines.map((line, index) => ({
    sourceSaleId: line.source_sale_id,
    productId: line.product_id,
    targetQty: index === 0 ? line.current_qty + 2 : line.current_qty,
  })),
  addedItems: [],
  reason: 'Faltaban dos unidades en la factura',
  userId: admin.id,
  expectedRevision: increaseModel.root.revision,
  idempotencyKey: `products-increase-${productSource.saleId}-${Date.now()}`,
  session: { id: cashId },
  additionPaymentMethod: 'efectivo',
});
const supplement = DB.salesRepo.getById(increased.additionSaleId);
ok(!increased.returnIds.length && supplement.correction_kind === 'product_addition' &&
  supplement.original_sale_id === productSource.saleId,
  'aumentar cantidad crea una factura complementaria vinculada');
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === stockBeforeIncrease - 2,
  'aumentar cantidad descuenta únicamente las unidades adicionales');
ok(supplement.items[0].qty === 2 &&
  supplement.items[0].unit_price === productOriginalBefore.items[0].unit_price,
  'el aumento conserva el precio histórico de la línea');

const mixedModel = DB.saleCorrectionsRepo.productCorrectionModel(productSource.saleId, admin.id);
const originalLine = mixedModel.lines.find(line =>
  line.source_kind === 'original' && Number(line.product_id) === Number(productId));
const stockBeforeMixedOriginal = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
const stockBeforeMixedAdded = db.prepare('SELECT stock FROM products WHERE id=?').get(addedProductId).stock;
const mixed = DB.saleCorrectionsRepo.correctProducts({
  saleId: productSource.saleId,
  lines: mixedModel.lines.map(line => ({
    sourceSaleId: line.source_sale_id,
    productId: line.product_id,
    targetQty: line === originalLine ? line.current_qty - 1 : line.current_qty,
  })),
  addedItems: [{ productId: addedProductId, qty: 2, unitPrice: 59 }],
  reason: 'Cambiar una unidad por otro producto',
  userId: admin.id,
  expectedRevision: mixedModel.root.revision,
  idempotencyKey: `products-mixed-${productSource.saleId}-${Date.now()}`,
  session: { id: cashId },
  additionPaymentMethod: 'efectivo',
});
ok(mixed.returnIds.length === 1 && mixed.additionSaleId,
  'una corrección mixta genera crédito y factura complementaria en una operación');
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === stockBeforeMixedOriginal + 1 &&
  db.prepare('SELECT stock FROM products WHERE id=?').get(addedProductId).stock === stockBeforeMixedAdded - 2,
  'la corrección mixta compensa inventario en ambas direcciones');
ok(db.prepare(`
  SELECT COUNT(*) count FROM sale_correction_documents WHERE correction_id=?
`).get(mixed.correctionId).count === 2,
  'auditoría enlaza los dos documentos generados por la corrección mixta');
const mixedHistory = DB.saleCorrectionsRepo.history(productSource.saleId, admin.id);
ok(mixedHistory.corrections.some(row => row.action === 'correct_products') &&
  mixedHistory.relatedDocuments.some(row => row.document_role === 'supplemental_invoice'),
  'historial presenta la corrección y su factura complementaria');
const groupedSales = DB.salesRepo.getAll({ range: 'all', view: 'sales', limit: 500 });
const groupedOriginal = groupedSales.find(row => row.id === productSource.saleId);
const groupedSupplement = groupedSales.find(row => row.id === mixed.additionSaleId);
ok(groupedOriginal.adjustment_addition_total > 0 && groupedOriginal.operation_credit_total > 0 &&
  groupedOriginal.total + groupedOriginal.adjustment_addition_total - groupedOriginal.operation_credit_total > 0,
  'Ventas recibe cargos, créditos y total neto para presentar la operación agrupada');
ok(!groupedSupplement,
  'Ventas muestra una sola operación ajustada y oculta la complementaria como fila independiente');
const supplementalDetail = DB.salesRepo.getById(mixed.additionSaleId);
ok(supplementalDetail.original_document_number_fmt === productOriginalBefore.document_number_fmt,
  'la complementaria auditada conserva el número documental real de su original');
const groupedDetail = DB.salesRepo.getById(productSource.saleId);
ok(groupedDetail.operation_total === Math.round((
  groupedDetail.total + groupedDetail.adjustment_addition_total - groupedDetail.operation_credit_total
) * 100) / 100, 'el detalle muestra el total neto completo de la operación corregida');
ok(groupedDetail.adjusted_items.some(item => item.product_id === addedProductId && item.qty === 2) &&
  groupedDetail.adjusted_items.some(item => item.product_id === productId && item.qty === 1),
  'la reimpresión ajustada recibe las cantidades vigentes en una sola factura');
expectThrow(() => db.prepare(
  'DELETE FROM sale_correction_documents WHERE correction_id=?'
).run(mixed.correctionId), /inmutables/i,
  'impide borrar la relación auditada entre corrección y documentos');

const rollbackSource = createSale({ date: '2025-07-12', method: 'efectivo', qty: 2 });
const rollbackModel = DB.saleCorrectionsRepo.productCorrectionModel(rollbackSource.saleId, admin.id);
const rollbackStockOriginal = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
const rollbackStockAdded = db.prepare('SELECT stock FROM products WHERE id=?').get(addedProductId).stock;
expectThrow(() => DB.saleCorrectionsRepo.correctProducts({
  saleId: rollbackSource.saleId,
  lines: rollbackModel.lines.map(line => ({
    sourceSaleId: line.source_sale_id,
    productId: line.product_id,
    targetQty: line.current_qty - 1,
  })),
  addedItems: [{ productId: addedProductId, qty: rollbackStockAdded + 1, unitPrice: 59 }],
  reason: 'Prueba de reversión transaccional',
  userId: admin.id,
  expectedRevision: rollbackModel.root.revision,
  idempotencyKey: `products-rollback-${rollbackSource.saleId}-${Date.now()}`,
  session: { id: cashId },
  additionPaymentMethod: 'efectivo',
}), /stock disponible insuficiente/i,
  'si falla un producto agregado se revierte también la nota de crédito');
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === rollbackStockOriginal &&
  db.prepare('SELECT stock FROM products WHERE id=?').get(addedProductId).stock === rollbackStockAdded,
  'un fallo mixto conserva intacto el inventario en ambas direcciones');
ok(db.prepare(`
  SELECT COUNT(*) count FROM sales
  WHERE original_sale_id=? AND status!='cancelled'
`).get(rollbackSource.saleId).count === 0 &&
  DB.salesRepo.getById(rollbackSource.saleId).revision === rollbackModel.root.revision,
  'un fallo mixto no deja documentos parciales ni avanza la revisión');

console.log('\n== G. Nota de crédito monetaria sin devolución física ==');
const monetarySource = createSale({ date: '2025-07-15', method: 'efectivo', qty: 2 });
const monetaryModel = DB.saleCorrectionsRepo.monetaryCreditModel(monetarySource.saleId, admin.id);
const monetaryStockBefore = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
const monetaryInventoryBefore = db.prepare(
  'SELECT COUNT(*) count FROM inventory_movements WHERE product_id=?'
).get(productId).count;
const monetaryKey = `monetary-credit-${monetarySource.saleId}-${Date.now()}`;
const monetaryCredit = DB.saleCorrectionsRepo.createMonetaryCredit({
  saleId: monetarySource.saleId,
  amount: 25,
  reason: 'Descuento comercial acordado después de facturar',
  userId: admin.id,
  expectedRevision: monetaryModel.root.revision,
  idempotencyKey: monetaryKey,
  terminalId: 'corrections-test',
  session: { id: cashId },
});
const monetaryNote = DB.salesRepo.getById(monetaryCredit.returnIds[0]);
ok(monetaryNote.type === 'devolucion' && monetaryNote.correction_kind === 'monetary_credit' &&
  monetaryNote.document_kind === 'nota_credito',
  'el descuento posterior crea una nota de crédito monetaria vinculada');
ok(monetaryNote.items.length === 1 && monetaryNote.items[0].product_id == null &&
  monetaryNote.items[0].product_code === 'AJUSTE',
  'la nota monetaria usa una línea de ajuste y no simula un producto devuelto');
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === monetaryStockBefore &&
  db.prepare('SELECT COUNT(*) count FROM inventory_movements WHERE product_id=?').get(productId).count === monetaryInventoryBefore,
  'la nota de crédito monetaria no cambia stock ni crea movimientos de inventario');
ok(DB.salesRepo.getById(monetarySource.saleId).status === 'completed',
  'un descuento monetario no marca la factura como totalmente devuelta');
ok(monetaryCredit.creditTotal === 25 && monetaryCredit.inventoryMoved === false &&
  monetaryNote.subtotal + monetaryNote.tax_amt === monetaryNote.total,
  'el crédito conserva el total solicitado y separa el ITBIS proporcional');
const monetaryAgain = DB.saleCorrectionsRepo.createMonetaryCredit({
  saleId: monetarySource.saleId,
  amount: 25,
  reason: 'Descuento comercial acordado después de facturar',
  userId: admin.id,
  expectedRevision: monetaryModel.root.revision,
  idempotencyKey: monetaryKey,
  terminalId: 'corrections-test',
  session: { id: cashId },
});
ok(monetaryAgain.idempotent && monetaryAgain.returnIds[0] === monetaryCredit.returnIds[0],
  'un doble clic no duplica la nota monetaria ni el reembolso');
const monetaryAfter = DB.saleCorrectionsRepo.monetaryCreditModel(monetarySource.saleId, admin.id);
ok(monetaryAfter.creditedTotal === 25 &&
  monetaryAfter.availableCredit === Math.round((monetaryModel.root.total - 25) * 100) / 100,
  'el máximo disponible descuenta créditos anteriores');
const monetaryAdjustedCopy = DB.salesRepo.getById(monetarySource.saleId);
ok(monetaryAdjustedCopy.adjusted_items.some(item =>
  item.product_code === 'AJUSTE' && item.unit_price === -25
) && monetaryAdjustedCopy.operation_total === monetaryModel.root.total - 25,
  'la reimpresión ajustada presenta la nota monetaria y el total vigente sin descuadrar productos');
expectThrow(() => DB.saleCorrectionsRepo.createMonetaryCredit({
  saleId: monetarySource.saleId,
  amount: monetaryAfter.availableCredit + 1,
  reason: 'Intento por encima del saldo disponible',
  userId: admin.id,
  expectedRevision: monetaryAfter.root.revision,
  idempotencyKey: `monetary-overflow-${monetarySource.saleId}-${Date.now()}`,
  terminalId: 'corrections-test',
  session: { id: cashId },
}), /saldo disponible/i, 'impide acreditar más que el total neto pendiente');

const creditMonetarySource = createSale({ date: '2025-07-16', method: 'credito', qty: 2 });
const balanceBeforeMonetaryCredit = db.prepare('SELECT balance FROM customers WHERE id=?').get(customerId).balance;
const creditMonetaryModel = DB.saleCorrectionsRepo.monetaryCreditModel(creditMonetarySource.saleId, admin.id);
const creditAccountNote = DB.saleCorrectionsRepo.createMonetaryCredit({
  saleId: creditMonetarySource.saleId,
  amount: 30,
  reason: 'Bonificación posterior aplicada a la cuenta',
  userId: admin.id,
  expectedRevision: creditMonetaryModel.root.revision,
  idempotencyKey: `monetary-ar-${creditMonetarySource.saleId}-${Date.now()}`,
  terminalId: 'corrections-test',
  session: null,
});
ok(db.prepare('SELECT balance FROM customers WHERE id=?').get(customerId).balance ===
  Math.round((balanceBeforeMonetaryCredit - 30) * 100) / 100,
  'en una venta a crédito reduce la cuenta por cobrar sin exigir caja');
ok(DB.accountingRepo.generateReturnEntry({
  returnSaleId: monetaryCredit.returnIds[0], userId: admin.id,
}) !== null, 'contabilidad registra la nota monetaria sin reingreso de inventario');
const stockBeforeMonetaryCancel = db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
DB.returnsRepo.cancel(
  creditAccountNote.returnIds[0],
  'Anular bonificación monetaria de prueba',
  admin.id,
  admin.name
);
ok(db.prepare('SELECT balance FROM customers WHERE id=?').get(customerId).balance === balanceBeforeMonetaryCredit,
  'anular una nota monetaria restaura la cuenta por cobrar');
ok(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock === stockBeforeMonetaryCancel &&
  DB.salesRepo.getById(creditAccountNote.returnIds[0]).status === 'cancelled',
  'anular la nota monetaria conserva el inventario y deja rastro cancelado');

console.log('\n== H. Integridad global ==');
ok(db.prepare('SELECT COUNT(*) count FROM sales WHERE id=?').get(original.id).count === 1,
  'cambiar fecha no duplica la venta');
ok(db.prepare("SELECT COUNT(*) count FROM inventory_movements WHERE sale_id=? AND type='salida'").get(original.id).count === 1,
  'cambiar fecha no duplica inventario');
ok(db.prepare('SELECT COUNT(*) count FROM payments WHERE sale_id=?').get(original.id).count === 1,
  'cambiar fecha no duplica pagos');
ok(DB.salesRepo.getById(original.id).original_sale_date === '2025-01-10',
  'la copia original conserva su fecha de emisión comercial original');
ok(firstChange.correctionId > 0 && db.prepare(
  "SELECT COUNT(*) count FROM audit_logs WHERE entity='sales' AND entity_id=? AND action='fecha_operativa_venta_cambiada'"
).get(original.id).count >= 1, 'registra auditoría completa dentro de la transacción');

try { db.close(); } catch {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
if (fail) process.exit(1);
