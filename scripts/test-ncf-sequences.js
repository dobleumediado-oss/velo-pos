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
  parseRecoverableDuplicatedTypeNcf,
  repairLegacyNcfData,
  recoverMalformedNcfEvidence,
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
ok(canonicalizeLegacyNcf('B01100000855') === null, 'no reasigna un NCF B01 mal formado a otro comprobante');
ok(canonicalizeLegacyNcf('B02200000403') === null, 'no reasigna un NCF B02 mal formado a otro comprobante');
ok(canonicalizeLegacyNcf('B0100000849') === 'B0100000849', 'no altera un NCF correcto');
ok(parseRecoverableDuplicatedTypeNcf('B01100000844')?.canonicalNcf === 'B0100000844',
  'reconoce exactamente el dígito B01 duplicado por la versión defectuosa');
ok(parseRecoverableDuplicatedTypeNcf('B141400000844')?.canonicalNcf === 'B1400000844',
  'reconoce también tipos fiscales de dos dígitos como B14');
ok(parseRecoverableDuplicatedTypeNcf('B01900000844') === null,
  'rechaza recortar un exceso que no corresponde al tipo fiscal');

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
  INSERT INTO sales VALUES(1,'B0100000848');
  INSERT INTO sales VALUES(2,'B01100000855');
  INSERT INTO ncf_log VALUES(1,'B01100000855','', 'B01',2);
  INSERT INTO ncf_log VALUES(2,'B0400000001','B01100000855','B04',3);
  INSERT INTO ncf_sequences VALUES(1,'B01','B01',100000844,100000890,100000856,1);
`);

const result = repairLegacyNcfData(db);
const repairedSale = db.prepare('SELECT ncf FROM sales WHERE id=2').get().ncf;
const repairedLog = db.prepare('SELECT ncf FROM ncf_log WHERE id=1').get().ncf;
const repairedRef = db.prepare('SELECT modifies_ncf FROM ncf_log WHERE id=2').get().modifies_ncf;
const sequence = db.prepare('SELECT * FROM ncf_sequences WHERE id=1').get();
const auditRows = db.prepare('SELECT * FROM ncf_normalization_log ORDER BY id').all();

ok(repairedSale === 'B01100000855', 'conserva como evidencia el NCF mal formado de la factura');
ok(repairedLog === 'B01100000855', 'conserva como evidencia el registro fiscal mal formado');
ok(repairedRef === 'B01100000855', 'conserva la referencia original sin reasignarla');
ok(sequence.from_num === 844 && sequence.to_num === 890, 'limpia los límites del rango');
ok(sequence.current === 856, 'la normalización mecánica conserva el contador hasta conciliarlo');
ok(auditRows.length === 1, 'audita únicamente el rango corregido');
ok(result.conflicts.length === 0, 'la reparación normal no produce colisiones');

const secondRun = repairLegacyNcfData(db);
ok(secondRun.sales === 0 && secondRun.log === 0 && secondRun.sequences === 0,
  'la migración es idempotente al ejecutarse nuevamente');

const recoveredDirect = recoverMalformedNcfEvidence(db);
const directSequence = db.prepare('SELECT * FROM ncf_sequences WHERE id=1').get();
ok(directSequence.current === 848 && recoveredDirect.sequences === 1,
  'recalcula la secuencia desde el último NCF válido y excluye el mal formado');

// Simula exactamente una instalación que ya recibió v1.36.0: el documento
// inválido fue convertido a 855 y el contador quedó adelantado en 856.
db.prepare("UPDATE sales SET ncf='B0100000855' WHERE id=2").run();
db.prepare("UPDATE ncf_log SET ncf='B0100000855' WHERE id=1").run();
db.prepare("UPDATE ncf_log SET modifies_ncf='B0100000855' WHERE id=2").run();
db.prepare('UPDATE ncf_sequences SET current=856 WHERE id=1').run();
const oldReason = 'Normalización NCF serie B: tipo + correlativo de 8 dígitos';
const insertOldAudit = db.prepare(`
  INSERT OR IGNORE INTO ncf_normalization_log
    (source_table,source_id,field_name,old_value,new_value,reason)
  VALUES(?,?,?,?,?,?)
`);
insertOldAudit.run('sales', 2, 'ncf', 'B01100000855', 'B0100000855', oldReason);
insertOldAudit.run('ncf_log', 1, 'ncf', 'B01100000855', 'B0100000855', oldReason);
insertOldAudit.run('ncf_log', 2, 'modifies_ncf', 'B01100000855', 'B0100000855', oldReason);
const recoveredUpgrade = recoverMalformedNcfEvidence(db);
ok(db.prepare('SELECT ncf FROM sales WHERE id=2').get().ncf === 'B01100000855',
  'la actualización correctiva restaura la evidencia alterada por v1.36.0');
ok(db.prepare('SELECT current FROM ncf_sequences WHERE id=1').get().current === 848,
  'la actualización correctiva elimina el adelanto ficticio del contador');
ok(recoveredUpgrade.sales === 1 && recoveredUpgrade.log === 1 && recoveredUpgrade.references === 1,
  'la recuperación registra cada documento restaurado');
const recoveredAgain = recoverMalformedNcfEvidence(db);
ok(recoveredAgain.sales === 0 && recoveredAgain.log === 0 && recoveredAgain.sequences === 0,
  'la recuperación correctiva también es idempotente');

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

const b02Id = appDb.prepare("SELECT id FROM ncf_sequences WHERE type='B02'").get().id;
const correctedB02 = DB.ncfRepo.updateSequence({ id: b02Id, next_number: 'B0200000403', alert_at: 10, active: 1 });
ok(correctedB02.sequence.current === 402,
  'un superadmin puede corregir el próximo NCF cuando no reutiliza documentos emitidos');
let reuseRejected = false;
try { DB.ncfRepo.updateSequence({ id: sequenceId, next_number: 'B0100000850' }); } catch { reuseRejected = true; }
ok(reuseRejected, 'bloquea bajar la secuencia sobre un NCF válido ya emitido');

const unusedId = DB.ncfRepo.createSequence({ type: 'B14', prefix: 'B14', from_num: 1, to_num: 10 });
const unusedRemoval = DB.ncfRepo.removeSequence(unusedId);
ok(unusedRemoval.deleted && !appDb.prepare('SELECT 1 FROM ncf_sequences WHERE id=?').get(unusedId),
  'elimina una secuencia que nunca emitió comprobantes');
const usedRemoval = DB.ncfRepo.removeSequence(sequenceId);
ok(usedRemoval.deactivated && appDb.prepare('SELECT active FROM ncf_sequences WHERE id=?').get(sequenceId).active === 0,
  'retira sin borrar una secuencia que ya tiene documentos para conservar auditoría');

let overlapRejected = false;
try {
  DB.ncfRepo.createSequence({ type: 'B01', prefix: 'B01', from_num: 875, to_num: 950 });
} catch { overlapRejected = true; }
ok(overlapRejected, 'rechaza rangos superpuestos que podrían duplicar comprobantes');

console.log('\n== Recuperación guiada de documentos NCF mal formados ==');
const recoverySequenceId = DB.ncfRepo.createSequence({
  type: 'B15', prefix: 'B15', from_num: 844, to_num: 890, alert_at: 10,
});
const malformedSales = [
  ['B151500000844', 'CLIENTE A', 1000],
  ['B151500000845', 'CLIENTE B', 2000],
  ['B151500000847', 'CLIENTE C', 3000],
].map(([ncf, customer, total], index) => {
  const saleId = Number(appDb.prepare(`
    INSERT INTO sales(customer_name,type,status,subtotal,total,payment_method,notes,created_at)
    VALUES(?,'factura','completed',?,?,'efectivo',?,datetime('now',?))
  `).run(customer, total, total, `NOTA ORIGINAL ${index + 1}`, `+${index} seconds`).lastInsertRowid);
  appDb.prepare('UPDATE sales SET ncf=? WHERE id=?').run(ncf, saleId);
  const logId = Number(appDb.prepare(`
    INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc,status,issued_at)
    VALUES(?,'B15',?,'','emitido',datetime('now'))
  `).run(ncf, saleId).lastInsertRowid);
  return { saleId, logId, ncf, total };
});
const referenceLogId = Number(appDb.prepare(`
  INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc,status,modifies_ncf,issued_at)
  VALUES('B0400000999','B04',NULL,'','emitido','B151500000845',datetime('now'))
`).run().lastInsertRowid);

const financialBefore = malformedSales.map(row => appDb.prepare(`
  SELECT subtotal,total,payment_method,notes,status FROM sales WHERE id=?
`).get(row.saleId));
const preview = DB.ncfRepo.previewMalformedRecovery(recoverySequenceId);
ok(preview.can_recover && preview.recoverable_count === 3,
  'la vista previa encuentra únicamente las tres facturas recuperables');
ok(preview.next_ncf === 'B1500000846' && preview.regular_next_ncf === 'B1500000848' && preview.gaps.includes(846),
  'prioriza el NCF saltado 846 y conserva 848 como continuación normal');

let staleTokenRejected = false;
try {
  DB.ncfRepo.recoverMalformedDocuments({
    id: recoverySequenceId, preview_token: 'TOKEN-INCORRECTO',
    reason: 'RECUPERACIÓN CONTROLADA DE PRUEBA',
  });
} catch { staleTokenRejected = true; }
ok(staleTokenRejected && appDb.prepare('SELECT ncf FROM sales WHERE id=?').get(malformedSales[0].saleId).ncf === 'B151500000844',
  'un token inválido bloquea toda modificación antes de tocar documentos');

const recovery = DB.ncfRepo.recoverMalformedDocuments({
  id: recoverySequenceId,
  preview_token: preview.token,
  reason: 'RECUPERACIÓN CONTROLADA DE PRUEBA',
});
ok(recovery.recovered === 3 && recovery.next_ncf === 'B1500000846' && recovery.regular_next_ncf === 'B1500000848',
  'recupera las correspondencias y deja 846 antes de continuar con 848');
malformedSales.forEach((row, index) => {
  const expected = ['B1500000844', 'B1500000845', 'B1500000847'][index];
  ok(appDb.prepare('SELECT ncf FROM sales WHERE id=?').get(row.saleId).ncf === expected,
    `corrige la factura ${row.ncf} a ${expected}`);
  ok(appDb.prepare('SELECT ncf FROM ncf_log WHERE id=?').get(row.logId).ncf === expected,
    `mantiene sincronizado el registro fiscal ${expected}`);
  const financialAfter = appDb.prepare(`
    SELECT subtotal,total,payment_method,notes,status FROM sales WHERE id=?
  `).get(row.saleId);
  ok(JSON.stringify(financialAfter) === JSON.stringify(financialBefore[index]),
    `no altera importes, método, nota ni estado de la factura ${row.saleId}`);
});
ok(appDb.prepare('SELECT modifies_ncf FROM ncf_log WHERE id=?').get(referenceLogId).modifies_ncf === 'B1500000845',
  'actualiza referencias fiscales relacionadas sin perder el vínculo');
ok(appDb.prepare('SELECT current FROM ncf_sequences WHERE id=?').get(recoverySequenceId).current === 847,
  'reconcilia el contador al último documento realmente ocupado');
const sequenceWithGap = DB.ncfRepo.getSequences().find(row => Number(row.id) === Number(recoverySequenceId));
ok(sequenceWithGap.available_gap_count === 1 && sequenceWithGap.next_issue_ncf === 'B1500000846',
  'expone el salto disponible como el próximo comprobante real en Configuración');
const gapAllocation = DB.ncfRepo.getNext('B15');
const continuationAllocation = DB.ncfRepo.getNext('B15');
ok(gapAllocation.ncf === 'B1500000846' && gapAllocation.from_available_gap,
  'la próxima emisión consume primero el NCF saltado 846');
ok(continuationAllocation.ncf === 'B1500000848' && !continuationAllocation.from_available_gap,
  'después de agotar los saltados continúa con el correlativo 848');
ok(appDb.prepare("SELECT COUNT(*) c FROM ncf_normalization_log WHERE reason LIKE 'Recuperación fiscal confirmada:%'").get().c >= 6,
  'conserva auditoría old/new tanto de facturas como de registros fiscales');
const idempotentPreview = DB.ncfRepo.previewMalformedRecovery(recoverySequenceId);
ok(idempotentPreview.recoverable_count === 0 && !idempotentPreview.can_recover,
  'una segunda ejecución no vuelve a modificar documentos ya recuperados');

const conflictSequenceId = DB.ncfRepo.createSequence({
  type: 'B16', prefix: 'B16', from_num: 10, to_num: 20, alert_at: 5,
});
const malformedConflictId = Number(appDb.prepare(`
  INSERT INTO sales(customer_name,type,status,total,ncf)
  VALUES('CONFLICTO A','factura','completed',10,'B161600000010')
`).run().lastInsertRowid);
appDb.prepare(`INSERT INTO ncf_log(ncf,type,sale_id,status) VALUES('B161600000010','B16',?,'emitido')`)
  .run(malformedConflictId);
appDb.prepare(`
  INSERT INTO sales(customer_name,type,status,total,ncf)
  VALUES('CONFLICTO B','factura','completed',10,'B1600000010')
`).run();
const conflictPreview = DB.ncfRepo.previewMalformedRecovery(conflictSequenceId);
ok(!conflictPreview.can_recover && conflictPreview.conflicts.some(item => item.code.startsWith('TARGET_USED:')),
  'bloquea la recuperación completa si el NCF destino ya pertenece a otro documento');

console.log('\n== Venta real prioriza un B01 saltado ==');
appDb.prepare('UPDATE ncf_sequences SET active=1,current=850 WHERE id=?').run(sequenceId);
for (const [ncf, total] of [['B01100000851', 151], ['B01100000853', 153]]) {
  const id = Number(appDb.prepare(`
    INSERT INTO sales(customer_id,customer_name,customer_rnc,type,status,subtotal,total,payment_method)
    VALUES(?,?,?,'factura','completed',?,?,'credito')
  `).run(customerId, 'CLIENTE FISCAL', '131521665', total, total).lastInsertRowid);
  appDb.prepare(`INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc,status) VALUES(?,'B01',?,?,'emitido')`)
    .run(ncf, id, '131521665');
  appDb.prepare('UPDATE sales SET ncf=? WHERE id=?').run(ncf, id);
}
const b01Preview = DB.ncfRepo.previewMalformedRecovery(sequenceId);
ok(b01Preview.next_ncf === 'B0100000852' && b01Preview.regular_next_ncf === 'B0100000854',
  'la recuperación B01 detecta 852 como salto disponible antes de 854');
const b01Recovery = DB.ncfRepo.recoverMalformedDocuments({
  id: sequenceId, preview_token: b01Preview.token,
  reason: 'RECUPERACIÓN B01 PARA VENTA REAL',
});
ok(b01Recovery.next_ncf === 'B0100000852',
  'la cola fiscal B01 anuncia 852 como siguiente comprobante');
const gapSale = DB.salesRepo.create({
  customer: { id: customerId },
  items: [{
    product_id: productId, product_code: 'NCF-001', product_name: 'PRODUCTO FISCAL',
    unit_cost: 50, unit_price: 118, qty: 1, taxable: 1, tax_pct: 18,
  }],
  payment: { method: 'credito' }, session: null, user: admin, type: 'factura',
});
const issuedGapSale = DB.salesRepo.getById(gapSale.saleId);
ok(issuedGapSale.ncf === 'B0100000852',
  'una factura real consume automáticamente el B01 saltado 852');
ok(appDb.prepare('SELECT ncf FROM ncf_log WHERE sale_id=?').get(gapSale.saleId).ncf === 'B0100000852',
  'la venta real y su registro fiscal quedan sincronizados con el salto utilizado');
const b01AfterGap = DB.ncfRepo.getSequences().find(row => Number(row.id) === Number(sequenceId));
ok(b01AfterGap.next_issue_ncf === 'B0100000854' && b01AfterGap.available_gap_count === 0,
  'tras usar el salto, VELO continúa automáticamente con 854');

appDb.close();
fs.rmSync(appDir, { recursive: true, force: true });

console.log(`\n${passed} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
