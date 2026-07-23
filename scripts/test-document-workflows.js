#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓', message);
  } else {
    failed++;
    console.error('  ✗', message);
  }
}

const tempDir = path.join(os.tmpdir(), `velo_documents_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const admin = db.prepare("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();

const customerId = DB.customersRepo.create({
  name: 'Cliente secuencias',
  rnc: '00100000099',
  credit_limit: 10000,
  credit_days: 30,
});
const productId = DB.productsRepo.create({
  code: 'DOC-001', name: 'Producto documental', cost: 50,
  price: 118, stock: 20, taxable: 1, tax_pct: 18,
});
const line = qty => ({
  product_id: productId,
  product_code: 'DOC-001',
  product_name: 'Producto documental',
  unit_cost: 50,
  unit_price: 118,
  qty,
  taxable: 1,
  tax_pct: 18,
});
const create = (method, type = 'factura') => DB.salesRepo.create({
  session: null,
  customer: { id: customerId },
  items: [line(1)],
  payment: { method },
  user: admin,
  type,
});

console.log('\n== Secuencias independientes ==');
const cash = create('efectivo');
const credit = create('credito');
const quote = create('credito', 'cotizacion');
const cashRow = DB.salesRepo.getById(cash.saleId);
const creditRow = DB.salesRepo.getById(credit.saleId);
const quoteRow = DB.salesRepo.getById(quote.saleId);
ok(/^FAC-000001$/.test(cashRow.document_number_fmt), 'factura al contado inicia FAC independiente');
ok(/^FCR-000001$/.test(creditRow.document_number_fmt), 'factura a crédito inicia FCR independiente');
ok(/^COT-000001$/.test(quoteRow.document_number_fmt), 'cotización inicia COT independiente');
ok(cashRow.receipt_document_number_fmt === 'REC-000001',
  'el recibo de una venta cobrada usa una secuencia REC separada');
ok(!creditRow.receipt_document_number_fmt,
  'la factura a crédito no fabrica un recibo antes de recibir un pago');

console.log('\n== Cotización no financiera ==');
ok(quoteRow.payment_method === 'cotizacion', 'normaliza el método a cotización');
ok(DB.productsRepo.getById(productId).stock === 18, 'la cotización no descuenta inventario');
ok(DB.customersRepo.getById(customerId).balance === 118, 'la cotización no aumenta la cuenta por cobrar');
ok(db.prepare("SELECT COUNT(*) c FROM cash_movements WHERE reference_id=?").get(quote.saleId).c === 0,
  'la cotización no crea movimientos de caja');
const summary = DB.reportsRepo.summary('all');
ok(summary.totalSales === 2 && summary.totalRev === 236,
  'los reportes financieros excluyen cotizaciones y cuentan solo facturas');

console.log('\n== Eliminación inmediata y no reutilización ==');
DB.salesRepo.deleteQuote(quote.saleId, admin.id, admin.name);
ok(DB.salesRepo.getById(quote.saleId) === null, 'elimina físicamente la cotización');
ok(db.prepare("SELECT status FROM document_issues WHERE kind='cotizacion' AND source_id=?")
  .get(String(quote.saleId)).status === 'deleted', 'conserva el correlativo como eliminado para auditoría');
const quote2 = create('efectivo', 'cotizacion');
ok(DB.salesRepo.getById(quote2.saleId).document_number_fmt === 'COT-000002',
  'el correlativo eliminado no vuelve a utilizarse');

console.log('\n== Abono, conduce y reporte ==');
const payment = DB.customersRepo.addPayment({
  customerId, amount: 18, method: 'efectivo',
  cajero: admin.name, userId: admin.id,
});
ok(payment.document_number_fmt === 'ABO-000001', 'abono usa su secuencia ABO');
const noteId = DB.conduceRepo.create({
  header: { customer_id: customerId },
  items: [{ product_id: productId, description: 'Producto documental', qty: 1 }],
  userId: admin.id,
});
ok(DB.conduceRepo.getById(noteId).number === 'CON-000001', 'conduce usa su secuencia CON');
const report = DB.documentNumberRepo.issue('reporte', 'print_job', 'test-report');
ok(report.formatted_number === 'REP-000001', 'reporte usa su secuencia REP');
const expenseId = DB.expensesRepo.create({
  type: 'gasto',
  description: 'Prueba de secuencia de proveedor',
  amount: 100,
  total: 100,
  payment_method: 'efectivo',
  payment_source: 'pendiente',
  issue_date: '2026-07-23',
  user_id: admin.id,
  status: 'pendiente_pago',
});
const supplierPayment = DB.expensesRepo.pay({
  expenseId,
  amount: 100,
  payment_method: 'efectivo',
  payment_source: 'caja_chica',
  userId: admin.id,
  userName: admin.name,
});
ok(supplierPayment.documentNumberFmt === 'PPR-000001',
  'pago a proveedor usa su secuencia PPR');

try { db.close(); } catch {}
try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
