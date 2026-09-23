#!/usr/bin/env node
'use strict';

// Regresión de anulación de facturas con abonos. Usa una base temporal aislada;
// nunca abre ni copia data/velo.db.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getPendingInvoices } = require('../lib/pending-invoices');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log('  ✓', message); }
  else { fail++; console.error('  ✗ FALLO:', message); }
}
function near(actual, expected) {
  return Math.abs(Number(actual || 0) - Number(expected || 0)) < 0.005;
}

const tmpDir = path.join(os.tmpdir(), `velo_cancel_payments_${Date.now()}`);
const DB = require('../database');
DB.initDB(tmpDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tmpDir);
db.prepare("UPDATE settings SET value='1' WHERE key='module_contabilidad'").run();

const user = db.prepare("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const productId = DB.productsRepo.create({
  code: 'ANU-AB-001', name: 'Artículo anulación con abonos',
  cost: 60, price: 100, stock: 100, taxable: 0, tax_pct: 0,
});
let cashSessionId = DB.cashRepo.open({
  userId: user.id, cajero: user.name, openAmount: 0, openBills: {},
  terminalId: 'cancel-payments-original',
});

function customer(name) {
  const id = DB.customersRepo.create({ name, credit_days: 30, credit_limit: 10000 });
  db.prepare('UPDATE customers SET credit_limit=10000 WHERE id=?').run(id);
  return id;
}

function creditSale(customerId) {
  const sale = DB.salesRepo.create({
    customer: { id: customerId },
    items: [{
      product_id: productId, product_code: 'ANU-AB-001',
      product_name: 'Artículo anulación con abonos', unit_cost: 60,
      unit_price: 100, qty: 1, taxable: 0, tax_pct: 0,
    }],
    payment: { method: 'credito' },
    session: { id: cashSessionId }, user, type: 'factura',
  });
  DB.accountingRepo.generateSaleEntry({ saleId: sale.saleId, userId: user.id });
  return sale;
}

function payment(customerId, amount, allocations) {
  const result = DB.customersRepo.addPayment({
    customerId, amount, allocations, method: 'efectivo', note: 'Abono de prueba',
    cajero: user.name, userId: user.id, sessionId: cashSessionId,
    operationId: `test-payment-${customerId}-${Date.now()}-${Math.random()}`,
  });
  DB.accountingRepo.generatePaymentEntry({ paymentId: result.paymentId, userId: user.id });
  return result;
}

function cancel(saleId, disposition, operationId, targetSaleId = null, reversalSessionId = cashSessionId) {
  const result = DB.salesRepo.cancel(
    saleId, 'Error de digitación en prueba', user.id, user.name,
    { paymentDisposition: disposition, targetSaleId, operationId, reversalSessionId }
  );
  if (result.resolutionId) {
    DB.accountingRepo.generateSaleCancellationPaymentEntry({
      resolutionId: result.resolutionId, userId: user.id,
    });
  }
  DB.accountingRepo.reverseSourceEntry(
    'venta', saleId, user.id, 'Venta anulada: Error de digitación en prueba'
  );
  return result;
}

function confirmedEntriesBalanced() {
  return db.prepare(`
    SELECT COUNT(*) count FROM accounting_entries
    WHERE status='confirmado' AND ABS(total_debit-total_credit)>0.005
  `).get().count === 0;
}

console.log('\n== 1. Reaplicar a otra factura pendiente ==');
const reapplyCustomer = customer('Cliente Reaplicar');
const reapplySource = creditSale(reapplyCustomer);
const reapplyTarget = creditSale(reapplyCustomer);
const reapplyPayment = payment(reapplyCustomer, 40, [
  { saleId: reapplySource.saleId, amount: 40 },
]);
const reapplyCashBefore = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type='abono' THEN amount WHEN type='salida' THEN -amount ELSE 0 END),0) net
  FROM cash_movements WHERE payment_id=?
`).get(reapplyPayment.paymentId).net;
const reapply = cancel(
  reapplySource.saleId, 'reapply', 'cancel-reapply-1', reapplyTarget.saleId
);
ok(near(DB.customersRepo.getById(reapplyCustomer).balance, 60),
  'el balance queda igual al saldo real de la factura destino');
ok(near(DB.salesRepo.getById(reapplyTarget.saleId).payment_amount, 40),
  'la otra factura recibe exactamente el abono');
ok(near(db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type='abono' THEN amount WHEN type='salida' THEN -amount ELSE 0 END),0) net
  FROM cash_movements WHERE payment_id=?
`).get(reapplyPayment.paymentId).net, reapplyCashBefore),
  'reaplicar no cobra ni devuelve dinero en caja');
ok(near(DB.accountingRepo.getAccountByCode('1104').balance,
  DB.customersRepo.getById(reapplyCustomer).balance),
  'CxC contable coincide con el balance del cliente');
const stockAfterReapply = DB.productsRepo.getById(productId).stock;
const reapplyRetry = cancel(
  reapplySource.saleId, 'reapply', 'cancel-reapply-1', reapplyTarget.saleId
);
ok(reapplyRetry.idempotent === true && reapplyRetry.resolutionId === reapply.resolutionId,
  'reintentar la misma operación recupera la resolución existente');
ok(DB.productsRepo.getById(productId).stock === stockAfterReapply,
  'el reintento no repone inventario dos veces');
let alteredRetryRejected = false;
try {
  cancel(reapplySource.saleId, 'favor', 'cancel-reapply-1');
} catch (error) {
  alteredRetryRejected = /otra decisión/.test(error.message);
}
ok(alteredRetryRejected,
  'la idempotencia no permite reutilizar la operación con otra decisión');
const collisionCustomer = customer('Cliente Colisión de Operación');
const collisionSale = creditSale(collisionCustomer);
let crossSaleRetryRejected = false;
try {
  cancel(collisionSale.saleId, 'favor', 'cancel-reapply-1');
} catch (error) {
  crossSaleRetryRejected = /otra factura/.test(error.message);
}
ok(crossSaleRetryRejected,
  'una clave de operación no puede confirmar por accidente otra factura');
cancel(collisionSale.saleId, '', '');

console.log('\n== 2. Dejar dinero anotado a favor ==');
const favorCustomer = customer('Cliente Anotación a Favor');
const favorSale = creditSale(favorCustomer);
const favorPayment = payment(favorCustomer, 40, [
  { saleId: favorSale.saleId, amount: 40 },
]);
const favorCashBefore = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type='abono' THEN amount WHEN type='salida' THEN -amount ELSE 0 END),0) net
  FROM cash_movements WHERE payment_id=?
`).get(favorPayment.paymentId).net;
const favor = cancel(favorSale.saleId, 'favor', 'cancel-favor-1');
const favorRecords = DB.customersRepo.getCancellationCredits(favorCustomer);
ok(near(DB.customersRepo.getById(favorCustomer).balance, 0),
  'la anotación no inventa balance negativo ni crédito disponible');
ok(favorRecords.length === 1 && near(favorRecords[0].amount, 40),
  'el dinero queda fijo y consultable en la cuenta del cliente');
ok(near(db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type='abono' THEN amount WHEN type='salida' THEN -amount ELSE 0 END),0) net
  FROM cash_movements WHERE payment_id=?
`).get(favorPayment.paymentId).net, favorCashBefore),
  'anotarlo a favor conserva el dinero recibido en caja');
ok(near(DB.accountingRepo.getAccountByCode('1104').balance, 60),
  'la CxC contable conserva únicamente la deuda del otro cliente');
ok(near(DB.accountingRepo.getAccountByCode('2103').balance, -40),
  'contabilidad reclasifica el dinero como anticipo del cliente');
ok(db.prepare(`
  SELECT COUNT(*) count FROM audit_logs
  WHERE entity='sales' AND entity_id=? AND action='venta_anulada_abonos_favor'
`).get(favorSale.saleId).count === 1,
  'Auditoría conserva elección, monto y destino');

console.log('\n== 3. Anular todo, incluido un abono exclusivo ==');
const fullVoidCustomer = customer('Cliente Reverso Completo');
const fullVoidSale = creditSale(fullVoidCustomer);
const fullVoidPayment = payment(fullVoidCustomer, 40, [
  { saleId: fullVoidSale.saleId, amount: 40 },
]);
const fullVoid = cancel(fullVoidSale.saleId, 'void', 'cancel-full-void-1');
const fullVoidedReceipt = db.prepare('SELECT * FROM payments WHERE id=?').get(fullVoidPayment.paymentId);
ok(fullVoidedReceipt.status === 'cancelled' && near(fullVoidedReceipt.amount, 40),
  'el recibo exclusivo queda anulado y conserva su monto histórico');
ok(near(DB.customersRepo.getById(fullVoidCustomer).balance, 0),
  'anular factura y abono deja el balance exactamente en cero');
ok(near(db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type='abono' THEN amount WHEN type='salida' THEN -amount ELSE 0 END),0) net
  FROM cash_movements WHERE payment_id=?
`).get(fullVoidPayment.paymentId).net, 0),
  'el cobro exclusivo queda neutralizado en caja');
ok(db.prepare(`
  SELECT COUNT(*) count FROM audit_logs
  WHERE entity='sales' AND entity_id=? AND action='venta_anulada_abonos_void'
`).get(fullVoidSale.saleId).count === 1 && fullVoid.resolutionId > 0,
  'la anulación completa conserva resolución y auditoría');
creditSale(fullVoidCustomer);
ok(getPendingInvoices(db, fullVoidCustomer).fullyReconcilable === true,
  'un recibo ya anulado no queda contado como abono vigente sin enlazar');

console.log('\n== 4. Anular solo la parte del recibo ligada a la factura ==');
const voidCustomer = customer('Cliente Reverso Parcial');
const voidSource = creditSale(voidCustomer);
const voidOther = creditSale(voidCustomer);
const sharedPayment = payment(voidCustomer, 150, [
  { saleId: voidSource.saleId, amount: 100 },
  { saleId: voidOther.saleId, amount: 50 },
]);
const originalSessionId = cashSessionId;
db.prepare(`
  UPDATE cash_sessions
  SET status='closed',close_date=date('now','localtime'),close_time=time('now','localtime')
  WHERE id=?
`).run(originalSessionId);
cashSessionId = DB.cashRepo.open({
  userId: user.id, cajero: user.name, openAmount: 0, openBills: {},
  terminalId: 'cancel-payments-current',
});
const voided = cancel(voidSource.saleId, 'void', 'cancel-void-1', null, cashSessionId);
const remainingPayment = db.prepare('SELECT * FROM payments WHERE id=?').get(sharedPayment.paymentId);
ok(remainingPayment.status === 'active' && near(remainingPayment.amount, 50),
  'el recibo compartido conserva activa la parte de la otra factura');
ok(near(DB.salesRepo.getById(voidOther.saleId).payment_amount, 50),
  'la factura no anulada conserva su aplicación original');
ok(near(DB.customersRepo.getById(voidCustomer).balance, 50),
  'el balance queda en el saldo real de la factura que permanece');
ok(db.prepare(`
  SELECT COUNT(*) count FROM cash_movements
  WHERE payment_id=? AND type='salida' AND cash_session_id=?
    AND sale_cancellation_resolution_id=?
`).get(sharedPayment.paymentId, cashSessionId, voided.resolutionId).count === 1,
  'el reverso se registra en la caja actual abierta');
ok(db.prepare(`
  SELECT COUNT(*) count FROM cash_movements
  WHERE payment_id=? AND type='salida' AND cash_session_id=?
`).get(sharedPayment.paymentId, originalSessionId).count === 0,
  'el turno cerrado original permanece intacto');
ok(near(db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type='abono' THEN amount WHEN type='salida' THEN -amount ELSE 0 END),0) net
  FROM cash_movements WHERE payment_id=?
`).get(sharedPayment.paymentId).net, 50),
  'caja conserva únicamente el dinero de la aplicación todavía vigente');
ok(near(DB.accountingRepo.getAccountByCode('1104').balance, 210),
  'CxC contable suma exactamente los saldos vigentes de los tres clientes');
ok(confirmedEntriesBalanced(), 'todos los asientos confirmados conservan débitos y créditos iguales');
ok(db.prepare(`
  SELECT COUNT(*) count FROM customers WHERE balance < -0.005
`).get().count === 0, 'ninguna salida produce balances negativos inventados');

const resolutionCount = db.prepare(
  'SELECT COUNT(*) count FROM sale_cancellation_payment_resolutions'
).get().count;
const cashCount = db.prepare(
  'SELECT COUNT(*) count FROM cash_movements WHERE sale_cancellation_resolution_id=?'
).get(voided.resolutionId).count;
const voidRetry = cancel(voidSource.saleId, 'void', 'cancel-void-1', null, cashSessionId);
ok(voidRetry.idempotent === true
  && db.prepare('SELECT COUNT(*) count FROM sale_cancellation_payment_resolutions').get().count === resolutionCount
  && db.prepare('SELECT COUNT(*) count FROM cash_movements WHERE sale_cancellation_resolution_id=?')
    .get(voided.resolutionId).count === cashCount,
  'un reintento no duplica resolución ni movimientos de caja');

console.log('\n== 5. Anular un abono histórico importado ==');
const historicalCustomer = customer('Cliente Histórico');
const historicalSale = creditSale(historicalCustomer);
db.prepare(`
  UPDATE sales
  SET import_source='equiparts_bak',cajero='Importación histórica',document_kind='factura_historica'
  WHERE id=?
`).run(historicalSale.saleId);
const historicalPaymentId = Number(db.prepare(`
  INSERT INTO payments(
    customer_id,sale_id,amount,method,note,cajero,user_id,cash_session_id,
    balance_before,balance_after,status,import_source
  ) VALUES(?,?,40,'efectivo','Abono importado','Importación histórica',?,NULL,100,60,'active','equiparts_bak')
`).run(historicalCustomer, historicalSale.saleId, user.id).lastInsertRowid);
db.prepare('UPDATE customers SET balance=60 WHERE id=?').run(historicalCustomer);
const historicalOptions = DB.salesRepo.getCancellationOptions(historicalSale.saleId);
ok(historicalOptions.canVoidAll === true && historicalOptions.hasImportedPayments === true,
  'la factura histórica permite elegir Anular todo e identifica el origen importado');
const historicalVoid = cancel(
  historicalSale.saleId, 'void', 'cancel-historical-void-1', null, null
);
const historicalReceipt = db.prepare('SELECT * FROM payments WHERE id=?').get(historicalPaymentId);
ok(historicalReceipt.status === 'cancelled' && historicalReceipt.void_cash_session_id == null,
  'el abono histórico queda anulado sin atribuirlo a una caja actual');
ok(db.prepare('SELECT COUNT(*) count FROM cash_movements WHERE payment_id=?')
  .get(historicalPaymentId).count === 0,
  'un pago importado no inventa entrada ni salida de efectivo en VELO');
ok(near(DB.customersRepo.getById(historicalCustomer).balance, 0),
  'anular la factura y su abono histórico deja la cuenta del cliente en cero');
ok(db.prepare(`
  SELECT COUNT(*) count FROM accounting_entries
  WHERE source_module='anulacion_abono_factura' AND source_id=?
`).get(historicalVoid.resolutionId).count === 0,
  'el abono importado no crea un asiento contra una caja que nunca lo recibió');
ok(db.prepare(`
  SELECT cash_breakdown FROM sale_cancellation_payment_lines
  WHERE resolution_id=? AND payment_id=?
`).get(historicalVoid.resolutionId, historicalPaymentId).cash_breakdown.includes('historico'),
  'la resolución conserva que el dinero provenía del historial importado');
ok(confirmedEntriesBalanced(), 'la contabilidad continúa cuadrada tras la anulación histórica');

try { db.close(); } catch {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
if (fail) process.exit(1);
