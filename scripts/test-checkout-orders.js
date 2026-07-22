#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log('  ✓', message); }
  else { fail++; console.log('  ✗ FALLO:', message); }
}
function throws(fn, message) {
  try { fn(); ok(false, `${message} (no lanzo)`); }
  catch { ok(true, message); }
}

const tempDir = path.join(os.tmpdir(), `velo_checkout_${Date.now()}`);
const DB = require('../database');
const { ensureCheckoutOrdersSchema } = require('../src/main/checkout-orders-repo');
DB.initDB(tempDir);
const db = DB.getDB();
const userRow = db.prepare("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const user = { id: userRow.id, name: userRow.name };
ok(DB.settingsRepo.get('module_preventa') === '1', 'el módulo de preventa queda activado por defecto');
ok(DB.settingsRepo.get('module_preventa_roles') === 'admin,cajero', 'administrador y cajero reciben acceso inicial');
ok(DB.settingsRepo.get('checkout_notifications_sound') === '1', 'los avisos de nuevas órdenes quedan activos por defecto');
DB.settingsRepo.set('module_preventa', '0');
ensureCheckoutOrdersSchema(db);
ok(DB.settingsRepo.get('module_preventa') === '0', 'el arranque respeta un módulo desactivado por el usuario');
db.prepare("DELETE FROM settings WHERE key='module_preventa_roles'").run();
ensureCheckoutOrdersSchema(db);
ok(DB.settingsRepo.get('module_preventa_roles') === 'admin,cajero', 'una base ya existente recibe el permiso modular faltante');
DB.settingsRepo.set('module_preventa', '1');
const customerId = DB.customersRepo.create({ name: 'Cliente Mostrador', credit_limit: 10000 });
const customer = { id: customerId, name: 'Cliente Mostrador', rnc: '00100000001' };
const productId = DB.productsRepo.create({
  code: 'PV-001', name: 'Producto Preventa', cost: 50, price: 118,
  stock: 5, taxable: 1, tax_pct: 18,
});
const item = qty => ({
  product_id: productId, product_code: 'PV-001', product_name: 'Producto Preventa',
  unit_price: 118, qty, taxable: 1, tax_pct: 18,
});
const createOrder = qty => DB.checkoutOrdersRepo.create({
  customer, items: [item(qty)], discountPct: 0, priceMode: 'retail',
  createdBy: user.id, createdByName: user.name, terminalId: 'despacho-1',
  reservationMinutes: 30,
});

console.log('\n== A. Crear y compartir orden ==');
const first = createOrder(3);
ok(/^OC-\d{6}$/.test(first.number), 'genera numero operativo OC-000001');
ok(first.status === 'pending' && first.items.length === 1, 'queda pendiente con su detalle');
ok(first.total === 354 && first.tax_amt === 54, 'calcula total e ITBIS incluido');
ok(DB.checkoutOrdersRepo.list({ statuses:['pending'] }).length === 1, 'aparece en la cola compartida');
ok(Number(DB.productsRepo.getAll().find(p => p.id === productId).reserved_stock) === 3,
  'el POS puede mostrar la disponibilidad reservada en tiempo real');

console.log('\n== B. Reserva real de disponibilidad ==');
throws(() => createOrder(3), 'impide reservar mas unidades de las disponibles');
throws(() => DB.salesRepo.create({
  customer, items:[item(3)], payment:{ method:'efectivo' }, user, type:'factura'
}), 'una venta directa no puede consumir inventario ya reservado');
const direct = DB.salesRepo.create({
  customer, items:[item(2)], payment:{ method:'efectivo' }, user, type:'factura'
});
ok(!!direct.saleId && DB.productsRepo.getById(productId).stock === 3,
  'una venta directa si puede usar la disponibilidad libre');

console.log('\n== C. Cobro atomico en caja ==');
const paid = DB.checkoutOrdersRepo.pay({
  id:first.id, payment:{ method:'efectivo' }, session:null, user, terminalId:'caja-1'
});
ok(!!paid.saleId && paid.order.status === 'paid', 'el cobro convierte la orden en venta');
ok(DB.productsRepo.getById(productId).stock === 0, 'descuenta el stock una sola vez al cobrar');
ok(paid.order.paid_terminal_id === 'caja-1' && paid.order.origin_terminal_id === 'despacho-1',
  'conserva terminal de origen y terminal de cobro');
throws(() => DB.checkoutOrdersRepo.pay({
  id:first.id, payment:{ method:'efectivo' }, session:null, user, terminalId:'caja-2'
}), 'impide cobrar dos veces la misma orden');
const dispatched = DB.checkoutOrdersRepo.markDispatched({ id:first.id, user });
ok(dispatched.status === 'dispatched', 'despacho confirma la entrega despues del pago');
DB.salesRepo.cancel(paid.saleId, 'Prueba de anulacion', user.id, user.name);
ok(DB.checkoutOrdersRepo.getById(first.id).status === 'cancelled',
  'anular la factura tambien retira la orden del flujo de despacho');

console.log('\n== D. Cancelacion y vencimiento liberan reserva ==');
const product2 = DB.productsRepo.create({
  code:'PV-002', name:'Reserva Temporal', cost:10, price:50, stock:2, taxable:0, tax_pct:0,
});
const item2 = { product_id:product2, product_code:'PV-002', product_name:'Reserva Temporal', unit_price:50, qty:2, taxable:0, tax_pct:0 };
const second = DB.checkoutOrdersRepo.create({ customer, items:[item2], createdBy:user.id, createdByName:user.name, terminalId:'despacho-1' });
const cancelled = DB.checkoutOrdersRepo.cancel({ id:second.id, reason:'Cliente desistio', user });
ok(cancelled.status === 'cancelled', 'cancelar libera la reserva');
const third = DB.checkoutOrdersRepo.create({ customer, items:[item2], createdBy:user.id, createdByName:user.name, terminalId:'despacho-1' });
db.prepare("UPDATE checkout_orders SET expires_at=datetime('now','localtime','-1 minute') WHERE id=?").run(third.id);
DB.checkoutOrdersRepo.expireStale();
ok(DB.checkoutOrdersRepo.getById(third.id).status === 'expired', 'vence automaticamente una reserva atrasada');
const history = DB.checkoutOrdersRepo.list({ statuses:['cancelled','expired'] });
ok(history[0]?.id === third.id, 'el historial muestra primero la actividad mas reciente');
const fourth = DB.checkoutOrdersRepo.create({ customer, items:[item2], createdBy:user.id, createdByName:user.name, terminalId:'despacho-2' });
ok(fourth.status === 'pending', 'el inventario vencido vuelve a estar disponible');

db.close();
try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch {}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
