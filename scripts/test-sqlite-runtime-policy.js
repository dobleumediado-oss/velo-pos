#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-sqlite-runtime-'));
const DB = require('../database');

try {
  DB.initDB(dataDir);
  const db = DB.getDB();

  assert.strictEqual(
    Number(db.pragma('temp_store', { simple: true })),
    2,
    'SQLite debe mantener temporales en memoria para el servicio Windows'
  );

  db.exec('CREATE TEMP TABLE velo_temp_probe(value INTEGER)');
  db.prepare('INSERT INTO velo_temp_probe(value) VALUES(?)').run(7);
  assert.strictEqual(
    db.prepare('SELECT value FROM velo_temp_probe').get().value,
    7,
    'la base temporal en memoria debe aceptar lecturas y escrituras'
  );

  const index = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get('idx_sales_customer_type_status_created');
  assert(index, 'debe existir el indice optimizado para facturas pendientes');

  db.exec('SAVEPOINT velo_runtime_write_probe');
  db.exec('CREATE TABLE __velo_runtime_write_probe(id INTEGER)');
  db.prepare('INSERT INTO __velo_runtime_write_probe(id) VALUES(1)').run();
  db.exec('ROLLBACK TO velo_runtime_write_probe');
  db.exec('RELEASE velo_runtime_write_probe');
  assert.strictEqual(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__velo_runtime_write_probe'").get(),
    undefined,
    'la prueba reversible no debe dejar tablas ni datos en el negocio'
  );

  db.close();
  console.log('✓ SQLite: temporales en memoria, indice CxC y escritura reversible verificados');
} finally {
  try { DB.getDB()?.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}
