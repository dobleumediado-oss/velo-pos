#!/usr/bin/env node
/**
 * test-financial-core.js — Regresión del núcleo financiero (dev-only)
 *
 * Valida los cálculos de dinero, inventario y crédito de salesRepo /
 * customersRepo contra una base de datos FRESCA Y AISLADA en el temp del SO.
 * NUNCA toca la BD real: llama initDB(tempDir) con un directorio desechable.
 *
 * Cubre las invariantes que una refactorización JAMÁS debe romper:
 *  - subtotal / ITBIS 18% / total de una factura
 *  - descuento porcentual
 *  - descuento de stock al facturar
 *  - la cotización NO lleva ITBIS ni mueve inventario
 *  - venta a crédito sube el balance del cliente
 *  - abono baja el balance y el sobrepago se rechaza
 *  - los registros de 'Importación histórica' quedan fuera de las ventas vivas
 *
 * Correr con el Node de Electron (ABI de better-sqlite3):
 *   npm run test:financial
 *
 * Exit code: 0 = todo OK; 1 = algún fallo.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FALLO:', msg); }
}
function near(a, b) { return Math.abs(a - b) < 0.005; }
function throws(fn, msg) {
  try { fn(); ok(false, msg + ' (no lanzó)'); }
  catch { ok(true, msg); }
}

// ── BD aislada y desechable ──
const tmpDir = path.join(os.tmpdir(), `velo_fintest_${Date.now()}`);
const DB = require('../database');
DB.initDB(tmpDir);
const db = DB.getDB();

// Ajustes deterministas: ITBIS 18%, sin fiscal (evita NCF)
db.prepare("INSERT INTO settings(key,value) VALUES('tax_pct','18') ON CONFLICT(key) DO UPDATE SET value='18'").run();
db.prepare("INSERT INTO settings(key,value) VALUES('fiscal_enabled','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();

// Usuario para auditoría (usar el admin seed id=1 si existe, si no crear)
let userId = (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() || {}).id;
if (!userId) userId = DB.usersRepo.create({ name: 'Test', email: 't@t.co', password: 'x', role: 'admin' });
const user = { id: userId, name: 'Test' };

const prodId = DB.productsRepo.create({ code: 'P1', name: 'Filtro Aceite', cost: 50, price: 100, stock: 10 });
const custId = DB.customersRepo.create({ name: 'Taller Pérez', credit_limit: 100000 });
const item = (qty) => ({ product_id: prodId, product_code: 'P1', product_name: 'Filtro Aceite', unit_cost: 50, unit_price: 100, qty });

console.log('\n== A. Factura: subtotal / ITBIS 18% / total + stock ==');
const a = DB.salesRepo.create({ customer: { id: custId, name: 'Taller Pérez' }, items: [item(2)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(a.subtotal, 200), `subtotal 200 (obtuvo ${a.subtotal})`);
ok(near(a.taxAmt, 36), `ITBIS 36 = 18% de 200 (obtuvo ${a.taxAmt})`);
ok(near(a.total, 236), `total 236 (obtuvo ${a.total})`);
ok(DB.productsRepo.getById(prodId).stock === 8, `stock 10→8 tras vender 2 (obtuvo ${DB.productsRepo.getById(prodId).stock})`);

console.log('\n== B. Descuento porcentual ==');
const b = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1)], payment: { method: 'efectivo', disc: 10 }, user, type: 'factura' });
ok(near(b.discAmt, 10), `descuento 10 = 10% de 100 (obtuvo ${b.discAmt})`);
ok(near(b.taxAmt, 16.2), `ITBIS 16.2 = 18% de (100-10) (obtuvo ${b.taxAmt})`);
ok(near(b.total, 106.2), `total 106.2 (obtuvo ${b.total})`);

console.log('\n== C. Cotización: sin ITBIS, sin mover stock ==');
const stockBefore = DB.productsRepo.getById(prodId).stock;
const c = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1)], payment: { method: 'efectivo' }, user, type: 'cotizacion' });
ok(near(c.taxAmt, 0), `cotización sin ITBIS (obtuvo ${c.taxAmt})`);
ok(near(c.total, 100), `cotización total = subtotal 100 (obtuvo ${c.total})`);
ok(DB.productsRepo.getById(prodId).stock === stockBefore, `stock intacto en cotización (${stockBefore})`);

console.log('\n== D. Venta a crédito sube el balance del cliente ==');
const balBefore = DB.customersRepo.getById(custId).balance;
const d = DB.salesRepo.create({ customer: { id: custId, name: 'Taller Pérez' }, items: [item(1)], payment: { method: 'credito' }, user, type: 'factura' });
const balAfter = DB.customersRepo.getById(custId).balance;
ok(near(balAfter - balBefore, d.total), `balance +${d.total} tras venta a crédito (Δ=${(balAfter - balBefore).toFixed(2)})`);

console.log('\n== E. Abono baja el balance y el sobrepago se rechaza ==');
const preAbono = DB.customersRepo.getById(custId).balance;
DB.customersRepo.addPayment({ customerId: custId, amount: 50, method: 'efectivo', note: 'abono test', userId });
ok(near(DB.customersRepo.getById(custId).balance, preAbono - 50), `balance -50 tras abono (obtuvo ${DB.customersRepo.getById(custId).balance.toFixed(2)})`);
throws(() => DB.customersRepo.addPayment({ customerId: custId, amount: 9e9, method: 'efectivo', userId }), 'rechaza abono mayor al balance');

console.log('\n== F. Exclusión de "Importación histórica" ==');
db.prepare(`INSERT INTO sales(customer_id,customer_name,type,status,subtotal,total,cajero,user_id,created_at)
            VALUES(?,?,'factura','completed',500,590,'Importación histórica',?,datetime('now','localtime'))`).run(custId, 'Hist', userId);
const vivas = db.prepare("SELECT COUNT(*) c FROM sales WHERE date(created_at)=date('now','localtime') AND cajero!='Importación histórica'").get().c;
const hist  = db.prepare("SELECT COUNT(*) c FROM sales WHERE cajero='Importación histórica'").get().c;
ok(hist === 1, `1 venta histórica insertada (obtuvo ${hist})`);
ok(vivas >= 3 && vivas < 100, `las ventas vivas de hoy EXCLUYEN la histórica (obtuvo ${vivas})`);

console.log('\n== G. Normalizadores financieros (lib/normalize-financial) ==');
const { normalizeFinAcct, normalizeFinMov } = require('../lib/normalize-financial');
const na = normalizeFinAcct({ id: 1, current_balance: 250.5, active: 1 });
ok(na.balance === 250.5 && na.is_active === true, 'cuenta: current_balance→balance, active=1→is_active true');
ok(normalizeFinAcct({ current_balance: 0, active: 0 }).is_active === false, 'cuenta: active=0→is_active false');
ok(normalizeFinAcct(null) === null, 'cuenta: null → null');
ok(normalizeFinMov({ type: 'deposito' }).type === 'ingreso', "movimiento: deposito→ingreso");
ok(normalizeFinMov({ type: 'retiro' }).type === 'egreso' && normalizeFinMov({ type: 'retiro' }).is_outflow === true, 'movimiento: retiro→egreso, is_outflow true');
ok(normalizeFinMov({ type: 'deposito' }).db_type === 'deposito', 'movimiento: conserva db_type original');

// ── Limpieza ──
db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
