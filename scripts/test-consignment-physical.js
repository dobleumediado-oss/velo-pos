#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DB = require('../database');
const custody = require('../lib/consignment-physical');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-consignment-'));
let db;
try {
  db = DB.initDB(directory);
  require('../versioning').initVersioning(db, directory);
  const userId = db.prepare("SELECT id FROM users WHERE role IN ('admin','superadmin') LIMIT 1").get()?.id || null;
  const productCount = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const saleCount = db.prepare('SELECT COUNT(*) n FROM sales').get().n;
  const cashCount = db.prepare('SELECT COUNT(*) n FROM cash_movements').get().n;
  const accountCount = db.prepare('SELECT COUNT(*) n FROM accounting_entries').get().n;

  assert.throws(() => custody.create(db, { ownerName: 'Ana', itemName: 'Equipo', qty: 0 }, userId), /entero positivo/);
  const id = custody.create(db, {
    ownerName: 'Ana', ownerPhone: '8090000000', itemName: 'Radio',
    reference: 'R-1', location: 'Estante A', qty: 4,
  }, userId);
  assert.equal(custody.list(db).find(row => row.id === id).on_hand, 4);
  assert.throws(() => custody.move(db, { lotId: id, kind: 'devolucion', qty: 5, reason: 'Retiro' }, userId), /más unidades/);
  assert.equal(custody.movements(db, id).length, 1, 'rechazo sin movimiento parcial');
  custody.move(db, { lotId: id, kind: 'devolucion', qty: 2, reason: 'Retiro parcial' }, userId);
  custody.move(db, { lotId: id, kind: 'entrada', qty: 1, reason: 'Nueva entrega' }, userId);
  assert.equal(custody.list(db).find(row => row.id === id).on_hand, 3);
  assert.deepEqual(custody.movements(db, id).map(row => row.kind), ['entrada', 'devolucion', 'entrada']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, productCount, 'no crea productos vendibles');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sales').get().n, saleCount, 'no emite ventas');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements').get().n, cashCount, 'no altera caja');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounting_entries').get().n, accountCount, 'no crea asientos');
  console.log('✓ Custodia consignada: entradas, devoluciones, límites y aislamiento comercial');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
