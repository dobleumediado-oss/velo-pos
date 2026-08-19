#!/usr/bin/env node
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// R6 — Órdenes de servicio / reparación (VELO TECH POS). Ciclo completo:
// recepción → diagnóstico → presupuesto → aprobado → reparando → listo →
// entrega (que genera una venta real). + guardas de transición.
// ════════════════════════════════════════════════════════════════════════════

const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.error('  ✗', m); } };

const tempDir = path.join(os.tmpdir(), `velo_service_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const repo = DB.serviceOrdersRepo;
const admin = db.prepare("SELECT id,name FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();
const cust = db.prepare('SELECT id,name FROM customers WHERE id>1 LIMIT 1').get()
  || { id: DB.customersRepo.create({ name: 'Cliente servicio', rnc: '', credit_limit: 0, credit_days: 0 }) };
// Repuesto (parte) con stock.
const partId = DB.productsRepo.create({ code: 'REP-PANT', name: 'Pantalla iPhone 13', cost: 3000, price: 5000, stock: 10, taxable: 1, tax_pct: 18 });

console.log('== R6 · órdenes de servicio ==');

// 1) Crear orden (recepción).
const o1 = repo.create({ customer_id: cust.id, device_desc: 'iPhone 13 128GB', imei: '359000000000900', problem: 'No enciende' }, admin);
ok(o1 && o1.status === 'recepcion' && /^SRV-\d{6}$/.test(o1.number), 'crea orden en recepción con número SRV-######');

// 2) No se puede saltar de estado (recepción → aprobado directo).
let jumpBlocked = false;
try { repo.advance(o1.id, 'aprobado', admin); } catch { jumpBlocked = true; }
ok(jumpBlocked, 'no permite saltar estados (recepción→aprobado)');

// 3) Avanzar a diagnóstico requiere… nada; a presupuesto requiere diagnóstico.
repo.advance(o1.id, 'diagnostico', admin);
let noDiag = false;
try { repo.advance(o1.id, 'presupuesto', admin); } catch { noDiag = true; }
ok(noDiag, 'no presupuesta sin diagnóstico');

// 4) Registrar diagnóstico + partidas (repuesto + mano de obra) → presupuesto.
repo.update(o1.id, {
  diagnosis: 'Pantalla dañada, requiere reemplazo',
  items: [
    { kind: 'parte', product_id: partId, qty: 1, unit_price: 5000 },
    { kind: 'mano_obra', description: 'Instalación y calibración', qty: 1, unit_price: 1500 },
  ],
});
const o2 = repo.getById(o1.id);
ok(o2.items.length === 2, 'registra 2 partidas (repuesto + mano de obra)');
ok(Number(o2.quote_amount) === 6500, 'presupuesto = suma de partidas (5000 + 1500 = 6500)');

// 5) Avanzar presupuesto → aprobado → reparando → listo.
repo.advance(o1.id, 'presupuesto', admin);
let noQuoteApprove = false;   // (ya hay quote, esta debe pasar)
repo.advance(o1.id, 'aprobado', admin);
ok(repo.getById(o1.id).approved_at != null, 'al aprobar se sella approved_at');
repo.advance(o1.id, 'reparando', admin);
const o3 = repo.advance(o1.id, 'listo', admin);
ok(o3.status === 'listo', 'llega a listo');

// 6) No se puede entregar por advance (entrega es su propio método).
let deliverByAdvance = false;
try { repo.advance(o1.id, 'entregado', admin); } catch { deliverByAdvance = true; }
ok(deliverByAdvance, "no se 'avanza' a entregado (usa deliver)");

// 7) Entregar → genera venta real, descuenta el repuesto, enlaza la venta.
const stockBefore = db.prepare('SELECT stock FROM products WHERE id=?').get(partId).stock;
const res = repo.deliver(o1.id, { method: 'efectivo' }, admin, null);
const saleId = res.saleResult && (res.saleResult.saleId || res.saleResult.id);
ok(!!saleId, 'la entrega genera una venta');
ok(res.order.status === 'entregado' && Number(res.order.sale_id) === Number(saleId), 'la orden queda entregada y enlazada a la venta');
const stockAfter = db.prepare('SELECT stock FROM products WHERE id=?').get(partId).stock;
ok(stockBefore - stockAfter === 1, 'el repuesto descuenta stock (−1); la mano de obra no toca inventario');
const saleTotal = db.prepare('SELECT total FROM sales WHERE id=?').get(saleId).total;
ok(Number(saleTotal) === 6500, 'el total de la venta = presupuesto (6500)');

// 8) Cancelar otra orden.
const oc = repo.create({ customer_id: cust.id, device_desc: 'Tablet', problem: 'Pantalla rota' }, admin);
const cancelled = repo.cancel(oc.id, 'Cliente no aprobó');
ok(cancelled.status === 'cancelado', 'una orden se puede cancelar');
let editCancelled = false;
try { repo.update(oc.id, { diagnosis: 'x' }); } catch { editCancelled = true; }
ok(editCancelled, 'una orden cancelada ya no se edita');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed ? 1 : 0);
