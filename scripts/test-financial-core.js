#!/usr/bin/env node
/**
 * test-financial-core.js — Regresión del núcleo financiero (dev-only)
 *
 * Valida los cálculos de dinero, inventario y crédito de salesRepo /
 * customersRepo contra una base de datos FRESCA Y AISLADA en el temp del SO.
 * NUNCA toca la BD real: llama initDB(tempDir) con un directorio desechable.
 *
 * Cubre las invariantes que una refactorización JAMÁS debe romper:
 *  - precio final con ITBIS incluido: subtotal neto / ITBIS 18% / total
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

const prodId = DB.productsRepo.create({ code: 'P1', name: 'Filtro Aceite', cost: 50, price: 118, stock: 10, taxable: 1, tax_pct: 18 });
const prodNoTaxId = DB.productsRepo.create({ code: 'P2', name: 'Servicio Exento', cost: 20, price: 100, stock: 10, taxable: 0, tax_pct: 0 });
const custId = DB.customersRepo.create({ name: 'Taller Pérez', credit_limit: 100000 });
const item = (qty, price = 118) => ({ product_id: prodId, product_code: 'P1', product_name: 'Filtro Aceite', unit_cost: 50, unit_price: price, taxable: 1, tax_pct: 18, qty });
const itemNoTax = (qty) => ({ product_id: prodNoTaxId, product_code: 'P2', product_name: 'Servicio Exento', unit_cost: 20, unit_price: 100, taxable: 0, tax_pct: 0, qty });

console.log('\n== A. Factura: precio final incluye ITBIS 18% + stock ==');
const a = DB.salesRepo.create({ customer: { id: custId, name: 'Taller Pérez' }, items: [item(2)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(a.subtotal, 200), `subtotal 200 (obtuvo ${a.subtotal})`);
ok(near(a.taxAmt, 36), `ITBIS 36 incluido en total 236 (obtuvo ${a.taxAmt})`);
ok(near(a.total, 236), `total 236 (obtuvo ${a.total})`);
ok(DB.productsRepo.getById(prodId).stock === 8, `stock 10→8 tras vender 2 (obtuvo ${DB.productsRepo.getById(prodId).stock})`);

console.log('\n== B. Descuento porcentual ==');
const b = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1)], payment: { method: 'efectivo', disc: 10 }, user, type: 'factura' });
ok(near(b.discAmt, 11.8), `descuento 11.8 = 10% de 118 final (obtuvo ${b.discAmt})`);
ok(near(b.subtotal, 90), `subtotal neto 90 después de descuento (obtuvo ${b.subtotal})`);
ok(near(b.taxAmt, 16.2), `ITBIS 16.2 incluido después de descuento (obtuvo ${b.taxAmt})`);
ok(near(b.total, 106.2), `total 106.2 (obtuvo ${b.total})`);

console.log('\n== C. Cotización: sin ITBIS, sin mover stock ==');
const stockBefore = DB.productsRepo.getById(prodId).stock;
const c = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1)], payment: { method: 'efectivo' }, user, type: 'cotizacion' });
ok(near(c.taxAmt, 0), `cotización sin ITBIS (obtuvo ${c.taxAmt})`);
ok(near(c.total, 118), `cotización total = precio final 118 (obtuvo ${c.total})`);
ok(DB.productsRepo.getById(prodId).stock === stockBefore, `stock intacto en cotización (${stockBefore})`);

console.log('\n== C2. Precio final modificado y producto exento ==');
const c2 = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1, 150)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(c2.total, 150), `precio final modificado total 150 (obtuvo ${c2.total})`);
ok(near(c2.subtotal, 127.12), `precio final 150 => neto 127.12 (obtuvo ${c2.subtotal})`);
ok(near(c2.taxAmt, 22.88), `precio final 150 => ITBIS 22.88 (obtuvo ${c2.taxAmt})`);
const stockBeforeReturn = DB.productsRepo.getById(prodId).stock;
const ret = DB.returnsRepo.create({
  originalSaleId: c2.saleId,
  items: [{ ...item(1, 999), qty: 1 }],
  session: null,
  user,
  reason: 'devolución test',
});
ok(near(ret.total, 150), `devolución respeta precio histórico final 150 (obtuvo ${ret.total})`);
ok(near(ret.taxAmt, 22.88), `devolución respeta ITBIS histórico 22.88 (obtuvo ${ret.taxAmt})`);
ok(DB.productsRepo.getById(prodId).stock === stockBeforeReturn + 1, `devolución repone stock ${stockBeforeReturn}→${stockBeforeReturn + 1}`);
const c3 = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [itemNoTax(1)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(c3.total, 100), `producto exento total 100 (obtuvo ${c3.total})`);
ok(near(c3.taxAmt, 0), `producto exento sin ITBIS (obtuvo ${c3.taxAmt})`);

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

console.log('\n== H. Helpers de fecha (lib/dates) ==');
const { todayStr, addDaysStr } = require('../lib/dates');
ok(/^\d{4}-\d{2}-\d{2}$/.test(todayStr()), `todayStr formato YYYY-MM-DD (${todayStr()})`);
ok(addDaysStr('2026-01-31', 1) === '2026-02-01', 'addDaysStr cruza fin de mes: 2026-01-31 +1 = 2026-02-01');
ok(addDaysStr('2026-12-31', 1) === '2027-01-01', 'addDaysStr cruza fin de año: 2026-12-31 +1 = 2027-01-01');
ok(addDaysStr('2024-02-28', 1) === '2024-02-29', 'addDaysStr respeta año bisiesto: 2024-02-28 +1 = 2024-02-29');
ok(addDaysStr('2026-01-01', 30) === '2026-01-31', 'addDaysStr +30 días (crédito): 2026-01-01 → 2026-01-31');

console.log('\n== J. Redondeo monetario (lib/money) ==');
const { round2 } = require('../lib/money');
ok(round2(0.1 + 0.2) === 0.3, 'round2 corrige 0.1+0.2 → 0.3');
ok(round2(1.005 * 100) === 100.5 && round2(236.004) === 236, 'round2 a 2 decimales');
ok(round2(200 * 0.18) === 36, 'round2(200*0.18) = 36 (ITBIS)');
ok(round2(100 / 3) === 33.33, 'round2(100/3) = 33.33');

console.log('\n== I. Normalización de búsqueda (lib/text-normalize) ==');
const { searchNorm, digitsOf } = require('../lib/text-normalize');
ok(searchNorm('Ñoño') === 'nono', "searchNorm quita tildes/Ñ: 'Ñoño'→'nono'");
ok(searchNorm('  José García  ') === 'jose garcia', 'searchNorm minúsculas + trim');
ok(searchNorm(null) === '' && searchNorm(undefined) === '', 'searchNorm tolera null/undefined');
ok(digitsOf('809-555-1234') === '8095551234', 'digitsOf deja solo dígitos');
ok(digitsOf('RNC: 1-30-12345-6') === '130123456', 'digitsOf sobre RNC con guiones');

// ── Limpieza ──
db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
