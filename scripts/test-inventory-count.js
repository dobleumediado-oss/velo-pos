#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DB = require('../database');
const count = require('../lib/inventory-count');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-inventory-count-'));
let db;
try {
  db = DB.initDB(directory);
  require('../versioning').initVersioning(db, directory);
  const userId = db.prepare("SELECT id FROM users WHERE role IN ('admin','superadmin') LIMIT 1").get()?.id || null;
  const make = (code, name, stock, cost, price) => DB.productsRepo.create({
    code, name, stock, cost, price, wholesale: price, taxable: 1, tax_pct: 18,
  });
  const a = make('CT-A', 'Aceite', 10, 100, 250);
  const b = make('CT-B', 'Bujía', 5, 30, 90);
  const tech = make('CT-C', 'Equipo serializado', 0, 0, 1000);
  DB.productUnitsRepo.setSerialized(tech, true);
  const emptyTech = make('CT-D', 'Modelo sin equipos', 0, 0, 1200);
  DB.productUnitsRepo.setSerialized(emptyTech, true);
  const u1 = DB.productUnitsRepo.create({ product_id: tech, imei: 'COUNT-IMEI-1', unit_cost: 400 });
  const u2 = DB.productUnitsRepo.create({ product_id: tech, imei: 'COUNT-IMEI-2', unit_cost: 500 });

  DB.settingsRepo.set('module_contabilidad', '1');
  const s = count.startCount(db, userId);
  assert.equal(s.lines.length, 5);
  assert.equal(count.startCount(db, userId).session.id, s.session.id, 'no duplica borradores');
  const row = (productId, unitId = null) => s.lines.find(l => l.product_id === productId && l.unit_id === unitId);
  assert.throws(() => count.confirmLine(db, { countId: s.session.id, lineId: row(a).id,
    qty: 1.5, cost: 110, userId }), /entero/);
  assert.throws(() => count.confirmLine(db, { countId: s.session.id, lineId: row(a).id,
    qty: 8, cost: -1, userId }), /Costo no válido/);
  assert.throws(() => count.confirmLine(db, { countId: s.session.id, lineId: row(tech, u2).id,
    present: 0, cost: 800, userId }), /equipo marcado como faltante/);
  count.confirmLine(db, { countId: s.session.id, lineId: row(a).id, qty: 8, cost: 110, userId });
  count.confirmLine(db, { countId: s.session.id, lineId: row(b).id, qty: 5, cost: 30, userId });
  count.confirmLine(db, { countId: s.session.id, lineId: row(tech, u1).id, present: 1, cost: 450, userId });
  count.confirmLine(db, { countId: s.session.id, lineId: row(tech, u2).id, present: 0, cost: 500, userId });
  count.confirmLine(db, { countId: s.session.id, lineId: row(emptyTech).id, qty: 0, cost: 0, userId });

  assert.equal(DB.productsRepo.getById(a).stock, 10, 'confirmar no cambia stock');
  assert.equal(DB.productsRepo.getById(a).cost, 100, 'confirmar no cambia costo');
  assert.equal(DB.productUnitsRepo.countInStock(tech), 2, 'confirmar no retira IMEI');
  assert.equal(count.getDraft(db).session.id, s.session.id, 'el borrador persiste');

  // Una venta u otra terminal que cambie el stock invalida el snapshot.
  DB.productsRepo.adjustStock(a, -1, 'salida', 'Prueba de concurrencia', null, userId);
  assert.throws(() => count.applyCount(db, { countId: s.session.id, reason: 'Conteo físico', userId,
    userName: 'Prueba', audit: DB.audit, accountingRepo: DB.accountingRepo }), /cambió durante el conteo/);
  assert.equal(DB.productsRepo.getById(b).stock, 5, 'el intento no aplicó otra línea');
  assert.equal(db.prepare('SELECT status FROM inventory_counts WHERE id=?').get(s.session.id).status, 'borrador');
  const updated = count.refreshCount(db, s.session.id);
  assert.equal(updated.refreshed, 1, 'solo la fila afectada por la venta requiere revisión');
  assert.equal(updated.lines.find(l => l.product_id === a && !l.unit_id).confirmed, 0);
  assert.equal(updated.lines.find(l => l.product_id === b && !l.unit_id).confirmed, 1);
  count.confirmLine(db, { countId: s.session.id, lineId: row(a).id, qty: 8, cost: 110, userId });

  // Si contabilidad falla, tampoco debe quedar media aplicación.
  assert.throws(() => count.applyCount(db, { countId: s.session.id, reason: 'Conteo físico', userId,
    userName: 'Prueba', audit: DB.audit,
    accountingRepo: {
      getConfig: () => DB.accountingRepo.getConfig(),
      createEntry() { throw new Error('Fallo contable simulado'); },
    } }), /Fallo contable/);
  assert.equal(DB.productsRepo.getById(a).stock, 9);
  assert.equal(DB.productUnitsRepo.countInStock(tech), 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_price_history WHERE source=?').get('conteo_fisico').n, 0);

  const applied = count.applyCount(db, { countId: s.session.id, reason: 'Conteo físico', userId,
    userName: 'Prueba', audit: DB.audit, accountingRepo: DB.accountingRepo });
  assert.equal(applied.changed, 4);
  assert.ok(applied.accountingEntryId, 'el cambio de valor creó un asiento');
  assert.equal(DB.productsRepo.getById(a).stock, 8);
  assert.equal(DB.productsRepo.getById(a).cost, 110);
  assert.equal(DB.productsRepo.getById(a).price, 250, 'precio de venta intacto');
  assert.equal(DB.productUnitsRepo.countInStock(tech), 1, 'IMEI faltante fuera del stock');
  assert.equal(DB.productUnitsRepo.listForProduct(tech, 'en_stock').some(u => u.id === u2), false,
    'la selección de equipos disponibles no muestra el IMEI faltante');
  assert.equal(DB.productUnitsRepo.listForProduct(tech).find(u => u.id === u2).inventory_missing, 1);
  assert.equal(DB.productsRepo.getAll().find(p => p.id === tech).effective_inventory_value, 450);
  assert.equal(db.prepare("SELECT qty FROM inventory_movements WHERE product_id=? AND reason LIKE 'Conteo físico%' ORDER BY id DESC LIMIT 1").get(a).qty, -1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_price_history WHERE product_id=? AND source=?').get(a, 'conteo_fisico').n, 1);
  const saleId = db.prepare('INSERT INTO sales(subtotal,total) VALUES(0,0)').run().lastInsertRowid;
  assert.equal(DB.productUnitsRepo.markSold(u2, saleId), 0, 'IMEI faltante no puede venderse');
  assert.throws(() => DB.salesRepo.create({
    session: null, customer: { id: 1 },
    items: [{ product_id: tech, product_code: 'CT-C', product_name: 'Equipo serializado',
      imei: 'COUNT-IMEI-2', unit_price: 1000, qty: 1, taxable: 1, tax_pct: 18 }],
    payment: { method: 'efectivo' }, user: DB.authRepo.findById(userId), type: 'factura',
  }), /marcado como faltante/, 'la venta real también bloquea el IMEI faltante');
  assert.throws(() => count.applyCount(db, { countId: s.session.id, reason: 'Repetido', userId,
    userName: 'Prueba', audit: DB.audit, accountingRepo: DB.accountingRepo }), /ya fue aplicado/);

  // Un conteo posterior puede encontrar el equipo y devolverlo al disponible.
  const second = count.startCount(db, userId);
  const newcomer = make('CT-E', 'Producto nuevo durante el conteo', 2, 25, 50);
  assert.throws(() => count.applyCount(db, { countId: second.session.id,
    reason: 'Conteo incompleto', userId, userName: 'Prueba', audit: DB.audit,
    accountingRepo: DB.accountingRepo }), /Faltan|catálogo cambió/);
  const synced = count.refreshCount(db, second.session.id);
  assert.equal(synced.refreshed, 1, 'un producto nuevo entra pendiente sin borrar el borrador');
  assert.ok(synced.lines.some(line => line.product_id === newcomer));
  for (const line of synced.lines) count.confirmLine(db, {
    countId: second.session.id, lineId: line.id,
    qty: line.counted_qty, cost: line.counted_cost,
    present: line.unit_id === u2 ? 1 : line.present, userId,
  });
  count.applyCount(db, { countId: second.session.id, reason: 'Equipo encontrado', userId,
    userName: 'Prueba', audit: DB.audit, accountingRepo: DB.accountingRepo });
  assert.equal(DB.productUnitsRepo.countInStock(tech), 2);
  assert.equal(DB.productUnitsRepo.listForProduct(tech).find(u => u.id === u2).inventory_missing, 0);

  // Descartar solo elimina el borrador; no altera productos.
  const third = count.startCount(db, userId);
  const newUnit = DB.productUnitsRepo.create({ product_id: tech, imei: 'COUNT-IMEI-3', unit_cost: 300 });
  const withUnit = count.refreshCount(db, third.session.id);
  assert.equal(withUnit.refreshed, 1, 'un IMEI nuevo entra pendiente al actualizar el conteo');
  assert.ok(withUnit.lines.some(line => line.unit_id === newUnit));
  count.cancelCount(db, third.session.id);
  assert.equal(count.getDraft(db), null);
  assert.equal(DB.productsRepo.getById(a).stock, 8);
  console.log('✓ Conteo masivo: borrador, IMEI, concurrencia, rollback, contabilidad y aplicación completa');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
