#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (condition, message) => {
  if (condition) { passed++; console.log('  ✓', message); }
  else { failed++; console.error('  ✗', message); }
};

const tempDir = path.join(os.tmpdir(), `velo_service_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const admin = db.prepare("SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();

console.log('== R6 · órdenes de servicio y entrega facturada ==');

const partId = DB.productsRepo.create({
  code:'REP-PANT', name:'Pantalla de reemplazo', cost:2500, price:4500,
  stock:5, taxable:1, tax_pct:18,
});
const order = DB.serviceOrdersRepo.create({
  customer_id:1, device_desc:'iPhone 13', imei:'359999999999999',
  problem:'Pantalla rota', notes:'Recibido sin cargador',
}, admin);
ok(order.number === 'SRV-000001' && order.status === 'recepcion', 'crea la recepción con número estable');

let current = DB.serviceOrdersRepo.advance(order.id, 'diagnostico', admin);
ok(current.status === 'diagnostico', 'avanza a diagnóstico');

let blocked = false;
try { DB.serviceOrdersRepo.advance(order.id, 'presupuesto', admin); } catch { blocked = true; }
ok(blocked, 'impide presupuestar sin diagnóstico');

current = DB.serviceOrdersRepo.update(order.id, {
  diagnosis:'Display OLED quebrado; placa y batería funcionales',
  items:[
    { kind:'parte', product_id:partId, description:'Pantalla OLED', qty:1, unit_price:4500 },
    { kind:'mano_obra', description:'Instalación y pruebas', qty:1, unit_price:1200, taxable:1, tax_pct:18 },
  ],
});
ok(current.items.length === 2 && Number(current.quote_amount) === 5700, 'guarda piezas, mano de obra y total del presupuesto');

for (const status of ['presupuesto','aprobado','reparando','listo']) {
  current = DB.serviceOrdersRepo.advance(order.id, status, admin);
}
ok(current.status === 'listo' && !!current.approved_at, 'recorre aprobación, reparación y queda listo');

const stockBefore = DB.productsRepo.getById(partId).stock;
const delivered = DB.serviceOrdersRepo.deliver(order.id, { method:'efectivo' }, admin, null);
current = delivered.order;
ok(current.status === 'entregado' && !!current.sale_id && !!current.delivered_at, 'entrega enlazada a una venta real');
const sale = DB.salesRepo.getById(current.sale_id);
ok(sale.items.length === 2 && sale.items.some(i => i.product_id == null && i.product_code === 'SERVICIO'), 'factura contiene pieza y mano de obra no inventariable');
ok(Number(sale.total) === 5700, 'la factura conserva el total del presupuesto');
ok(DB.productsRepo.getById(partId).stock === stockBefore - 1, 'la pieza descuenta inventario una sola vez');

DB.settingsRepo.set('module_contabilidad', '1');
DB.accountingRepo.generateSaleEntry({ saleId:current.sale_id, userId:admin.id });
const entry = db.prepare("SELECT id FROM accounting_entries WHERE source_module='venta' AND source_id=?").get(current.sale_id);
const balance = entry ? db.prepare('SELECT ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM accounting_entry_lines WHERE entry_id=?').get(entry.id) : null;
ok(balance && Number(balance.debit) === Number(balance.credit), 'la venta de servicio genera asiento contable cuadrado');

const salesCount = db.prepare('SELECT COUNT(*) n FROM sales').get().n;
const repeated = DB.serviceOrdersRepo.deliver(order.id, { method:'efectivo' }, admin, null);
ok(repeated.order.sale_id === current.sale_id && db.prepare('SELECT COUNT(*) n FROM sales').get().n === salesCount, 'reintentar la entrega no duplica la factura');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed ? 1 : 0);
