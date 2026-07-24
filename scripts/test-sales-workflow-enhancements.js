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
function near(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }
function throws(fn, message) {
  try { fn(); ok(false, `${message} (no lanzó)`); }
  catch { ok(true, message); }
}

const tmpDir = path.join(os.tmpdir(), `velo_sales_workflow_${Date.now()}`);
const DB = require('../database');
DB.initDB(tmpDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tmpDir);
const userRow = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const user = { id: userRow.id, name: userRow.name };

console.log('\n== A. Teléfonos múltiples y snapshot de factura ==');
const customerId = DB.customersRepo.create({
  name: 'Cliente con flota',
  phones: [
    { phone_type: 'telefono', phone: '809-555-1000' },
    { phone_type: 'celular', phone: '829-555-2000', is_primary: true },
    { phone_type: 'flota', phone: '1*2345' },
  ],
});
const customer = DB.customersRepo.getById(customerId);
ok(customer.phones.length === 3, 'conserva varios números en una sola cuenta');
ok(customer.phones.find(p => p.is_primary)?.phone_type === 'celular', 'conserva el tipo y número principal');

const productId = DB.productsRepo.create({
  code: 'WF-001', name: 'Producto flujo', cost: 50, price: 118,
  stock: 20, taxable: 1, tax_pct: 18,
});
const cashId = DB.cashRepo.open({
  userId: user.id, cajero: user.name, openAmount: 1000, openBills: {}, terminalId: 'test-workflow',
});
const flota = customer.phones.find(p => p.phone_type === 'flota');
const sale = DB.salesRepo.create({
  customer: { id: customerId, phone_id: flota.id },
  items: [{
    product_id: productId, product_code: 'WF-001', product_name: 'Producto flujo',
    unit_cost: 50, unit_price: 118, taxable: 1, tax_pct: 18, qty: 4,
  }],
  payment: {
    method: 'efectivo',
    charges: [{ description: 'Envío Santo Domingo', amount: 128 }],
    displayCurrency: 'USD',
    displayExchangeRate: 60,
    saleDate: '2026-07-20',
  },
  session: { id: cashId },
  user,
  type: 'factura',
});
const saved = DB.salesRepo.getById(sale.saleId);
ok(saved.customer_phone === '1*2345' && saved.customer_phone_type === 'flota',
  'la factura guarda el número elegido y su tipo');

console.log('\n== B. Cargo adicional, USD y fecha documental ==');
ok(saved.charges.length === 1 && near(saved.additional_charges_total, 128),
  'guarda el detalle y total del envío');
ok(near(saved.total, 600), 'suma el cargo al total de la factura');
ok(saved.display_currency === 'USD' && near(saved.display_exchange_rate, 60) && near(saved.display_amount, 10),
  'guarda equivalencia USD y tasa histórica editable');
ok(String(saved.created_at).startsWith('2026-07-20 '), 'emite la factura en la fecha seleccionada');
throws(() => DB.salesRepo.create({
  customer: { id: customerId },
  items: [{ product_id: productId, unit_price: 118, qty: 1 }],
  payment: { method: 'efectivo', saleDate: '2026-02-31' },
  user, type: 'factura',
}), 'rechaza fechas calendáricamente imposibles');

console.log('\n== C. Caja, cambio histórico y numeración ==');
const sessionSales = DB.cashRepo.getSessionSales(cashId);
ok(sessionSales[0].item_qty_total === 4, 'la sesión de caja cuenta unidades, no solo líneas');
DB.salesRepo.updateDate(sale.saleId, '2026-07-19');
ok(String(DB.salesRepo.getById(sale.saleId).created_at).startsWith('2026-07-19 '),
  'mueve la venta y su historia a la nueva fecha');
const movement = db.prepare(
  "SELECT created_at FROM cash_movements WHERE reference_id=? AND type='venta' ORDER BY id DESC LIMIT 1"
).get(sale.saleId);
ok(String(movement.created_at).startsWith('2026-07-19 '), 'mantiene alineado el movimiento de caja');

DB.documentNumberRepo.updateSequence('factura_contado', {
  prefix: 'EQ', current: 500, padLength: 7,
});
const issue = DB.documentNumberRepo.issue('factura_contado', 'test', 'next');
ok(issue.formatted_number === 'EQ-0000501', 'personaliza prefijo, correlativo y relleno');
throws(() => DB.documentNumberRepo.updateSequence('factura_contado', {
  prefix: 'EQ', current: 1, padLength: 7,
}), 'impide reutilizar números de factura ya emitidos');

console.log('\n== D. Conduce persistente ==');
const conduce = DB.conduceRepo.createFromSale(sale.saleId, { userId: user.id });
ok(/^CON-/.test(conduce.number), 'genera un número formal de conduce');
ok(conduce.source_type === 'factura' && Number(conduce.source_id) === Number(sale.saleId),
  'vincula el conduce con la factura original');
ok(conduce.status === 'facturado' && conduce.items.length === 1,
  'guarda el conduce y evita volver a facturar sus artículos');

try { db.close(); } catch {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
if (fail) process.exit(1);
