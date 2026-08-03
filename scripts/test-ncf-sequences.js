#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  normalizeLegacySequenceNumber,
  normalizeLegacySequenceRange,
  formatLegacyNcf,
  canonicalizeLegacyNcf,
  repairLegacyNcfData,
} = require('../lib/ncf-sequences');

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) { passed++; console.log('  ✓', message); }
  else { failed++; console.error('  ✗', message); }
}

console.log('\n== Normalización de correlativos NCF ==');
ok(normalizeLegacySequenceNumber('B01', 849) === 849, 'acepta correlativo simple 849');
ok(normalizeLegacySequenceNumber('B01', 'B0100000849') === 849, 'acepta NCF B01 completo');
ok(normalizeLegacySequenceNumber('B01', '0100000849') === 849, 'acepta parte numérica completa con 01');
ok(normalizeLegacySequenceNumber('B01', 100000849) === 849, 'repara el 1 del tipo contaminando el contador');
ok(normalizeLegacySequenceNumber('B02', 200000402) === 402, 'repara el 2 del tipo contaminando B02');
ok(formatLegacyNcf('B01', 850) === 'B0100000850', 'genera B01 con exactamente 8 correlativos');
ok(canonicalizeLegacyNcf('B01100000855') === 'B0100000855', 'normaliza el NCF observado en cliente');
ok(canonicalizeLegacyNcf('B02200000403') === 'B0200000403', 'normaliza B02 contaminado');
ok(canonicalizeLegacyNcf('B0100000849') === 'B0100000849', 'no altera un NCF correcto');

let rejected = false;
try { normalizeLegacySequenceRange('B01', 'B0200000001', 'B0200000100'); } catch { rejected = true; }
ok(rejected, 'rechaza un rango cuyo comprobante pertenece a otro tipo');

console.log('\n== Migración conservadora de facturas emitidas ==');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-ncf-'));
const dbPath = path.join(tempDir, 'test.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE sales(id INTEGER PRIMARY KEY, ncf TEXT);
  CREATE TABLE ncf_log(
    id INTEGER PRIMARY KEY, ncf TEXT, modifies_ncf TEXT,
    type TEXT, sale_id INTEGER
  );
  CREATE TABLE ncf_sequences(
    id INTEGER PRIMARY KEY, type TEXT, prefix TEXT,
    from_num INTEGER, to_num INTEGER, current INTEGER,
    active INTEGER DEFAULT 1
  );
  CREATE UNIQUE INDEX uidx_sales_ncf ON sales(ncf) WHERE ncf<>'';
  CREATE UNIQUE INDEX uidx_log_ncf ON ncf_log(ncf) WHERE ncf<>'';
  INSERT INTO sales VALUES(1,'B0100000849');
  INSERT INTO sales VALUES(2,'B01100000855');
  INSERT INTO ncf_log VALUES(1,'B01100000855','', 'B01',2);
  INSERT INTO ncf_log VALUES(2,'B0400000001','B01100000855','B04',3);
  INSERT INTO ncf_sequences VALUES(1,'B01','B01',100000849,100000900,100000854,1);
`);

const result = repairLegacyNcfData(db);
const repairedSale = db.prepare('SELECT ncf FROM sales WHERE id=2').get().ncf;
const repairedLog = db.prepare('SELECT ncf FROM ncf_log WHERE id=1').get().ncf;
const repairedRef = db.prepare('SELECT modifies_ncf FROM ncf_log WHERE id=2').get().modifies_ncf;
const sequence = db.prepare('SELECT * FROM ncf_sequences WHERE id=1').get();
const auditRows = db.prepare('SELECT * FROM ncf_normalization_log ORDER BY id').all();

ok(repairedSale === 'B0100000855', 'corrige la factura sin reemplazar su registro');
ok(repairedLog === 'B0100000855', 'corrige el registro fiscal asociado');
ok(repairedRef === 'B0100000855', 'corrige la referencia de nota de crédito');
ok(sequence.from_num === 849 && sequence.to_num === 900, 'limpia los límites del rango');
ok(sequence.current === 855, 'continúa después del último NCF realmente registrado');
ok(auditRows.length === 4, 'conserva trazabilidad de factura, log, referencia y rango');
ok(result.conflicts.length === 0, 'la reparación normal no produce colisiones');

const secondRun = repairLegacyNcfData(db);
ok(secondRun.sales === 0 && secondRun.log === 0 && secondRun.sequences === 0,
  'la migración es idempotente al ejecutarse nuevamente');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('\n== Emisión real desde el repositorio de ventas ==');
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-ncf-sale-'));
const DB = require('../database');
DB.initDB(appDir);
const appDb = DB.getDB();
appDb.prepare(`
  INSERT INTO ncf_sequences(type,prefix,from_num,to_num,current,active,alert_at)
  VALUES('B02','B02',200000402,200000512,200000409,1,10)
`).run();
require('../versioning').initVersioning(appDb, appDir);
const migratedSequence = appDb.prepare("SELECT * FROM ncf_sequences WHERE type='B02'").get();
const preMigrationBackups = fs.readdirSync(path.join(appDir, 'backups'))
  .filter(name => name.startsWith('velo_pre_ncf_normalization_'));
ok(migratedSequence.from_num === 402 && migratedSequence.current === 409,
  'la actualización repara automáticamente una secuencia existente');
ok(preMigrationBackups.length === 1,
  'crea un respaldo consistente antes de modificar datos fiscales existentes');
DB.settingsRepo.set('fiscal_enabled', '1');

const sequenceId = DB.ncfRepo.createSequence({
  type: 'B01', prefix: 'B01',
  from_num: 'B0100000850', to_num: 'B0100000900',
  alert_at: 10,
});
const storedSequence = appDb.prepare('SELECT * FROM ncf_sequences WHERE id=?').get(sequenceId);
ok(storedSequence.from_num === 850 && storedSequence.current === 849,
  'el backend guarda el correlativo limpio aunque se pegue el NCF completo');

const admin = appDb.prepare("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const customerId = DB.customersRepo.create({ name: 'CLIENTE FISCAL', rnc: '131521665', credit_days: 30 });
appDb.prepare('UPDATE customers SET credit_limit=100000 WHERE id=?').run(customerId);
const productId = DB.productsRepo.create({
  code: 'NCF-001', name: 'PRODUCTO FISCAL', cost: 50,
  price: 118, stock: 10, taxable: 1, tax_pct: 18,
});
const saleResult = DB.salesRepo.create({
  customer: { id: customerId },
  items: [{
    product_id: productId, product_code: 'NCF-001', product_name: 'PRODUCTO FISCAL',
    unit_cost: 50, unit_price: 118, qty: 1, taxable: 1, tax_pct: 18,
  }],
  payment: { method: 'credito' },
  session: null,
  user: admin,
  type: 'factura',
});
const emitted = DB.salesRepo.getById(saleResult.saleId);
ok(emitted.ncf === 'B0100000850' && emitted.ncf.length === 11,
  'la venta real emite B0100000850 con longitud fiscal correcta');
ok(appDb.prepare('SELECT ncf FROM ncf_log WHERE sale_id=?').get(saleResult.saleId).ncf === emitted.ncf,
  'factura y registro fiscal conservan el mismo NCF');

let overlapRejected = false;
try {
  DB.ncfRepo.createSequence({ type: 'B01', prefix: 'B01', from_num: 875, to_num: 950 });
} catch { overlapRejected = true; }
ok(overlapRejected, 'rechaza rangos superpuestos que podrían duplicar comprobantes');

appDb.close();
fs.rmSync(appDir, { recursive: true, force: true });

console.log(`\n${passed} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
