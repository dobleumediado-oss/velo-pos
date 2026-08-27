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

console.log('\n== Reutilización controlada de factura no fiscal ==');
const consumerSale = DB.salesRepo.create({
  session: null,
  customer: { id: 1, name: 'Consumidor Final', rnc: '' },
  items: [line(1)],
  payment: { method: 'efectivo' },
  user: admin,
  type: 'factura',
});
const consumerBefore = DB.salesRepo.getById(consumerSale.saleId);
DB.salesRepo.cancel(consumerSale.saleId, 'Error de facturación', admin.id, admin.name);
const consumerReplacement = DB.salesRepo.create({
  session: null,
  customer: { id: 1, name: 'Consumidor Final', rnc: '' },
  items: [line(1)],
  payment: {
    method: 'efectivo',
    replacesSaleId: consumerSale.saleId,
  },
  user: admin,
  type: 'factura',
});
const consumerAfter = DB.salesRepo.getById(consumerReplacement.saleId);
ok(
  consumerAfter.document_number_fmt === consumerBefore.document_number_fmt &&
  consumerAfter.replaces_sale_id === consumerSale.saleId,
  'Consumidor Final sin NCF conserva el número comercial al registrarse nuevamente'
);
ok(
  DB.salesRepo.getById(consumerSale.saleId).status === 'cancelled' &&
  db.prepare('SELECT COUNT(*) c FROM document_reuse_log WHERE original_sale_id=? AND replacement_sale_id=?')
    .get(consumerSale.saleId, consumerReplacement.saleId).c === 1,
  'conserva la factura anulada y la cadena de auditoría del reemplazo'
);
ok(
  consumerAfter.receipt_document_number_fmt !== consumerBefore.receipt_document_number_fmt,
  'el recibo nuevo mantiene su propia secuencia y no reutiliza el recibo anulado'
);
let duplicateReplacementBlocked = false;
try {
  DB.salesRepo.create({
    session: null,
    customer: { id: 1, name: 'Consumidor Final', rnc: '' },
    items: [line(1)],
    payment: { method: 'efectivo', replacesSaleId: consumerSale.saleId },
    user: admin,
    type: 'factura',
  });
} catch (error) {
  duplicateReplacementBlocked = /ya fue registrada nuevamente/.test(error.message);
}
ok(duplicateReplacementBlocked, 'impide dos reemplazos vigentes para una misma factura anulada');
const fiscalConsumer = DB.salesRepo.create({
  session: null,
  customer: { id: 1, name: 'Consumidor Final', rnc: '' },
  items: [line(1)],
  payment: { method: 'efectivo' },
  user: admin,
  type: 'factura',
});
db.prepare("UPDATE sales SET ncf='B0200000001' WHERE id=?").run(fiscalConsumer.saleId);
DB.salesRepo.cancel(fiscalConsumer.saleId, 'Error en comprobante', admin.id, admin.name);
let fiscalReplacementBlocked = false;
try {
  DB.salesRepo.create({
    session: null,
    customer: { id: 1, name: 'Consumidor Final', rnc: '' },
    items: [line(1)],
    payment: { method: 'efectivo', replacesSaleId: fiscalConsumer.saleId },
    user: admin,
    type: 'factura',
  });
} catch (error) {
  fiscalReplacementBlocked = /NCF o e-CF/.test(error.message);
}
ok(fiscalReplacementBlocked, 'un comprobante fiscal anulado nunca libera su número');

const registeredCustomerSale = DB.salesRepo.create({
  session: null,
  customer: { id: customerId },
  items: [line(1)],
  payment: { method: 'efectivo' },
  user: admin,
  type: 'factura',
});
DB.salesRepo.cancel(registeredCustomerSale.saleId, 'Error en cliente', admin.id, admin.name);
let registeredCustomerBlocked = false;
try {
  DB.salesRepo.create({
    session: null,
    customer: { id: 1, name: 'Consumidor Final', rnc: '' },
    items: [line(1)],
    payment: { method: 'efectivo', replacesSaleId: registeredCustomerSale.saleId },
    user: admin,
    type: 'factura',
  });
} catch (error) {
  registeredCustomerBlocked = /Consumidor Final/.test(error.message);
}
ok(registeredCustomerBlocked, 'una factura de cliente registrado no reutiliza su correlativo');

console.log('\n== Cargos adicionales en factura y cotización ==');
const stockBeforeChargeDocs = DB.productsRepo.getById(productId).stock;
const extraCharge = { description: 'Envío a domicilio', amount: 250 };
const invoiceWithCharge = DB.salesRepo.create({
  session: null,
  customer: { id: customerId },
  items: [line(1)],
  payment: { method: 'efectivo', charges: [extraCharge] },
  user: admin,
  type: 'factura',
});
const invoiceChargeRow = DB.salesRepo.getById(invoiceWithCharge.saleId);
ok(invoiceChargeRow.total === 368 && invoiceChargeRow.items.length === 1
  && invoiceChargeRow.additional_charges_total === 250,
  'factura suma el cargo sin convertirlo en artículo');
ok(invoiceChargeRow.charges.some(row => row.description === 'Envío a domicilio' && row.amount === 250),
  'el cargo de factura queda guardado en su sección independiente');
ok(DB.productsRepo.getById(productId).stock === stockBeforeChargeDocs - 1,
  'la factura descuenta únicamente el producto físico');
const quoteWithCharge = DB.salesRepo.create({
  session: null,
  customer: { id: customerId },
  items: [line(1)],
  payment: { method: 'cotizacion', charges: [extraCharge] },
  user: admin,
  type: 'cotizacion',
});
const quoteChargeRow = DB.salesRepo.getById(quoteWithCharge.saleId);
ok(quoteChargeRow.total === 368 && quoteChargeRow.items.length === 1
  && quoteChargeRow.additional_charges_total === 250,
  'cotización suma el cargo sin convertirlo en artículo');
ok(quoteChargeRow.charges.some(row => row.description === 'Envío a domicilio' && row.amount === 250),
  'el cargo de cotización queda guardado y disponible para convertirla');
ok(DB.productsRepo.getById(productId).stock === stockBeforeChargeDocs - 1,
  'cotizar con cargos no mueve inventario');

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
const cancelledNote = DB.conduceRepo.cancel(noteId, { userId: admin.id, reason: 'Documento de prueba' });
ok(cancelledNote.status === 'anulado' && cancelledNote.cancellation_reason === 'Documento de prueba',
  'anular conduce conserva el documento, su número y el motivo');

const stockBeforeConduce = DB.productsRepo.getById(productId).stock;
const chargedNoteId = DB.conduceRepo.create({
  header: { customer_id: customerId },
  items: [{ product_id: productId, description: 'Producto documental', qty: 2 }],
  charges: [{ description: 'Envío del conduce', amount: 250 }],
  userId: admin.id,
});
const chargedNote = DB.conduceRepo.getById(chargedNoteId);
ok(chargedNote.charges.length === 1 && chargedNote.charges[0].amount === 250,
  'el conduce guarda el cargo separado de sus artículos');
ok(DB.productsRepo.getById(productId).stock === stockBeforeConduce,
  'crear el conduce con cargo no mueve inventario');
DB.conduceRepo.setStatus(chargedNoteId, 'despachado', { userId: admin.id });
const sourceLine = DB.conduceRepo.invoiceableLines(chargedNoteId)[0];
const firstConduceSale = DB.salesRepo.create({
  operationId: 'test:conduce:partial:1',
  session: null,
  customer: { id: customerId },
  items: [{ ...line(1), sourceConduceItemId: sourceLine.id }],
  payment: {
    method: 'efectivo', sourceConduceId: chargedNoteId,
    charges: [{ description: 'Envío del conduce', amount: 250 }],
  },
  user: admin,
  type: 'factura',
});
const partiallyConverted = DB.conduceRepo.getById(chargedNoteId);
ok(firstConduceSale.total === 368 && firstConduceSale.additionalChargesTotal === 250,
  'la primera venta del conduce suma su cargo pendiente al total');
ok(partiallyConverted.status === 'despachado' && partiallyConverted.invoice_links.length === 1,
  'la conversión parcial enlaza la factura sin cerrar cantidades pendientes');
ok(partiallyConverted.charges[0].invoice_id === firstConduceSale.saleId,
  'el cargo queda consumido por una sola factura del conduce');
const retriedConduceSale = DB.salesRepo.create({
  operationId: 'test:conduce:partial:1',
  session: null,
  customer: { id: customerId },
  items: [{ ...line(1), sourceConduceItemId: sourceLine.id }],
  payment: {
    method: 'efectivo', sourceConduceId: chargedNoteId,
    charges: [{ description: 'Envío del conduce', amount: 250 }],
  },
  user: admin,
  type: 'factura',
});
ok(retriedConduceSale.saleId === firstConduceSale.saleId && retriedConduceSale.idempotent,
  'reintentar la confirmación no duplica la venta ni el cargo del conduce');
const secondConduceSale = DB.salesRepo.create({
  session: null,
  customer: { id: customerId },
  items: [{ ...line(1), sourceConduceItemId: sourceLine.id }],
  payment: { method: 'efectivo', sourceConduceId: chargedNoteId, charges: [] },
  user: admin,
  type: 'factura',
});
const fullyConverted = DB.conduceRepo.getById(chargedNoteId);
ok(secondConduceSale.total === 118 && secondConduceSale.additionalChargesTotal === 0,
  'la venta final no vuelve a sumar el cargo ya facturado');
ok(fullyConverted.status === 'facturado' && fullyConverted.invoice_links.length === 2,
  'al completar las cantidades el conduce queda facturado y conserva ambos enlaces');
DB.salesRepo.cancel(secondConduceSale.saleId, 'Corrección de prueba', admin.id, admin.name);
const reopenedConduce = DB.conduceRepo.getById(chargedNoteId);
ok(reopenedConduce.status === 'despachado' && reopenedConduce.invoice_links.length === 1,
  'anular una factura reabre solo la cantidad de conduce enlazada a esa factura');
ok(reopenedConduce.charges[0].invoice_id === firstConduceSale.saleId,
  'anular una factura parcial posterior no libera un cargo usado por la primera venta');
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

console.log('\n== Continuidad de numeración histórica importada ==');
db.prepare(`
  INSERT INTO sales(
    customer_id,customer_name,type,status,subtotal,total,payment_method,cajero,
    numero_factura,numero_factura_fmt,old_id_factura,import_source,
    original_sale_date,sale_date,created_at,updated_at
  ) VALUES(?,?,'factura','completed',100,100,'efectivo','Importación histórica',
           2363,'00002363',253202,'equiparts_bak',
           '2026-07-21','2026-07-21','2026-07-21 00:00:00','2026-07-21 00:00:00')
`).run(customerId, 'Cliente histórico');
const continuedCash = DB.salesRepo.getById(create('efectivo').saleId);
const continuedCredit = DB.salesRepo.getById(create('credito').saleId);
ok(continuedCash.document_kind === 'factura_historica' &&
  continuedCash.document_number_fmt === '00002364' &&
  continuedCash.numero_factura_fmt === '00002364',
  'con datos importados la factura continúa en 00002364');
ok(continuedCredit.document_kind === 'factura_historica' &&
  continuedCredit.document_number_fmt === '00002365',
  'contado y crédito comparten la secuencia histórica');

try { db.close(); } catch {}
try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
