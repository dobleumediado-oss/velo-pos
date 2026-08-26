#!/usr/bin/env node
'use strict';

// Regresión aislada: un pago de comisión a una persona ajena al negocio debe
// vivir en Gastos, generar RGE y no cambiar el recibo PPR de proveedores.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const ok = (condition, message) => {
  if (condition) { passed += 1; console.log('  ✓', message); }
  else { failed += 1; console.error('  ✗', message); }
};

const tempDir = path.join(os.tmpdir(), `velo_external_expense_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

try {
  console.log('== Gastos · comisión a persona externa ==');
  const admin = db.prepare(
    "SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1"
  ).get();
  const category = db.prepare(`
    SELECT c.id,c.name,p.name parent_name
    FROM expense_categories c
    LEFT JOIN expense_categories p ON p.id=c.parent_id
    WHERE c.name='Comisiones externas' COLLATE NOCASE
    LIMIT 1
  `).get();
  ok(category?.parent_name === 'SERVICIOS PROFESIONALES' ||
    category?.parent_name === 'Servicios profesionales',
  'la actualización crea la categoría Comisiones externas bajo Servicios profesionales');

  const cashSessionId = DB.cashRepo.open({
    userId: admin.id,
    cajero: admin.name,
    openAmount: 5000,
    openBills: {},
    terminalId: 'EXT-COMMISSION-QA',
  });
  const expenseId = DB.expensesRepo.create({
    type: 'gasto',
    category_id: category.id,
    description: 'Comisión por referimiento de cliente',
    beneficiary_name: 'María Pérez',
    beneficiary_document: '001-0000000-1',
    beneficiary_phone: '809-555-0101',
    amount: 1250,
    total: 1250,
    payment_method: 'efectivo',
    payment_source: 'caja',
    issue_date: '2026-08-25',
    user_id: admin.id,
    status: 'pendiente_pago',
  });
  const expense = DB.expensesRepo.getById(expenseId);
  ok(expense.beneficiary_name === 'MARÍA PÉREZ' && expense.supplier_id == null,
    'la persona externa queda identificada sin crearla como proveedor o empleado');

  const payment = DB.expensesRepo.pay({
    expenseId,
    amount: 1250,
    payment_method: 'efectivo',
    payment_source: 'caja',
    cash_session_id: cashSessionId,
    reference: 'COM-REF-001',
    userId: admin.id,
    userName: admin.name,
  });
  ok(payment.documentKind === 'pago_gasto_externo' && /^RGE-\d{6}$/.test(payment.documentNumberFmt),
    'el pago externo usa un recibo RGE independiente');

  const paymentRow = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(payment.paymentId);
  ok(paymentRow.beneficiary_name === 'MARÍA PÉREZ' &&
    paymentRow.beneficiary_document === '001-0000000-1',
  'el pago conserva una copia de los datos del beneficiario');
  const cashMovement = db.prepare(`
    SELECT * FROM cash_movements
    WHERE cash_session_id=? AND reference_id=? AND type='salida'
  `).get(cashSessionId, expenseId);
  ok(Number(cashMovement?.amount) === 1250,
    'la comisión pagada en efectivo descuenta exactamente el monto del cuadre de caja');

  console.log('\n== Compatibilidad · pago a proveedor existente ==');
  const supplierId = DB.suppliersRepo.create({ name: 'Proveedor QA', rnc: '101000001' });
  const supplierExpenseId = DB.expensesRepo.create({
    type: 'gasto',
    description: 'Compra administrativa de prueba',
    supplier_id: supplierId,
    amount: 300,
    total: 300,
    payment_method: 'transferencia',
    payment_source: 'pendiente',
    issue_date: '2026-08-25',
    user_id: admin.id,
    status: 'pendiente_pago',
  });
  const supplierPayment = DB.expensesRepo.pay({
    expenseId: supplierExpenseId,
    amount: 300,
    payment_method: 'transferencia',
    payment_source: 'banco',
    userId: admin.id,
    userName: admin.name,
  });
  ok(supplierPayment.documentKind === 'pago_proveedor' && /^PPR-\d{6}$/.test(supplierPayment.documentNumberFmt),
    'el flujo anterior de proveedores conserva su recibo PPR');
  const summary = DB.expensesRepo.getSummary({ from: '2026-08-25', to: '2026-08-25' });
  ok(Number(summary.from_cash) === 1250,
    'el resumen separa el efectivo de caja de los pagos por banco');

  const expenseUi = fs.readFileSync(path.join(__dirname, '../src/js/gastos.js'), 'utf8');
  const printUi = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const templatesUi = fs.readFileSync(path.join(__dirname, '../src/js/plantillas.js'), 'utf8');
  ok(expenseUi.includes('persona_externa') && expenseUi.includes('gasto-beneficiary-document'),
    'el formulario permite seleccionar persona externa y exige su documento');
  ok(expenseUi.includes('imprimirGasto') && expenseUi.includes('imprimirPagoGasto'),
    'la lista y el historial exponen acciones de impresión y reimpresión');
  ok(printUi.includes('Firma de quien recibe') && printUi.includes('pago_gasto_externo'),
    'el comprobante externo incluye firma de recibido y ruta de impresión propia');
  ok(printUi.includes('return printReceipt({') && printUi.includes('ticketRoute.template'),
    'el recibo reutiliza la plantilla y la ruta configuradas para el Punto de Venta');
  ok(templatesUi.includes("sale.type === 'pago_gasto_externo'") &&
    templatesUi.includes('RECIBO DE PAGO DE GASTO'),
  'las plantillas del POS identifican el documento como gasto y no como factura');

  global.buildLogoHeader = () => '';
  global.facturaLabel = row => row.document_number_fmt || String(row.id || '');
  global.facturaLabelOriginal = () => '';
  vm.runInThisContext(templatesUi);
  const receiptSample = {
    id: payment.paymentId,
    document_number_fmt: payment.documentNumberFmt,
    type: 'pago_gasto_externo',
    date: '2026-08-25', time: '16:30', cajero: admin.name,
    customer_name: 'MARÍA PÉREZ', customer_rnc: '001-0000000-1',
    payment_method: 'efectivo', payment_amount: 1250,
    expense_total: 1250, balance_before: 1250, balance_after_payment: 0,
    subtotal: 1250, total: 1250, tax_pct: 0, tax_amt: 0,
    items: [{ product_name: 'COMISIÓN POR REFERIMIENTO', qty: 1, unit_price: 1250, subtotal: 1250, taxable: 0 }],
  };
  const cfg = { biz_name: 'VELO POS', receipt_msg: 'Gracias' };
  const opts = { logo: false, rnc: true, ncf: true, mensaje: true, cedula: true };
  const a4Receipt = getPlantilla('carta_recibo').render(receiptSample, cfg, opts);
  ok(a4Receipt.includes('RECIBO DE PAGO DE GASTO') && a4Receipt.includes('BENEFICIARIO') &&
    !a4Receipt.includes('Precio venta'),
  'la plantilla A4 del POS muestra beneficiario y concepto sin presentarlo como una venta');
  const ncfReceipt = getPlantilla('carta_ncf').render(receiptSample, cfg, opts);
  ok(ncfReceipt.includes('Sin valor fiscal') && !ncfReceipt.includes('Factura con Valor Fiscal'),
    'la plantilla NCF se protege y rotula el recibo de gasto como documento interno no fiscal');
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas.`);
process.exit(failed ? 1 : 0);
