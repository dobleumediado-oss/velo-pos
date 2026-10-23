'use strict';

// Solo datos ficticios en una carpeta temporal; nunca abre la base del negocio.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { createMigrationPackage, verifyMigrationPackage, restoreCompleteBackupToEmptyDirectory } = require('../lib/cloud-migration-package');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-migration-test-'));
  const db = new Database(path.join(root, 'source.db'));
  try {
    const destinationDir = path.join(root, 'exports'); fs.mkdirSync(destinationDir);
    fs.mkdirSync(path.join(root, 'service-evidence'));
    const evidence = Buffer.from('Evidencia ficticia, sin información de clientes');
    fs.writeFileSync(path.join(root, 'service-evidence', 'example.txt'), evidence);
    const checksum = crypto.createHash('sha256').update(evidence).digest('hex');
    db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE sales(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), balance INTEGER, number TEXT);
      CREATE TABLE future_module(id INTEGER PRIMARY KEY, content BLOB);
      CREATE TABLE service_order_evidence(storage_path TEXT, sha256 TEXT);
      INSERT INTO customers VALUES(1, 'Cliente ficticio');
      INSERT INTO sales VALUES(1, 1, 2490, 'B0100000042');`);
    db.prepare('INSERT INTO future_module VALUES(?,?)').run(1, Buffer.from([0, 255, 17]));
    db.prepare('INSERT INTO service_order_evidence VALUES(?,?)').run('service-evidence/example.txt', checksum);
    const args = { db, dataDir: root, destinationDir, passphrase: 'Clave-ficticia-2026', businessId: 'prueba', vertical: 'TECH', appVersion: 'test' };
    await assert.rejects(createMigrationPackage({ ...args, passphrase: 'corta' }));
    const result = await createMigrationPackage(args);
    assert.equal(result.cloudActivated, false); assert.equal(result.evidenceFiles, 1);
    const verified = await verifyMigrationPackage({ filePath: result.path, passphrase: args.passphrase });
    assert.equal(verified.manifest.tables.length, 4);
    assert.equal(verified.manifest.businessId, 'prueba');
    // Descifrado independiente: comprobar que se preservan la base y los archivos,
    // incluyendo módulos desconocidos y valores binarios, no solo sus conteos.
    const encrypted = fs.readFileSync(result.path);
    assert.equal(encrypted.includes(Buffer.from('Cliente ficticio')), false);
    const key = crypto.scryptSync(args.passphrase, encrypted.subarray(8, 24), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(24, 36));
    decipher.setAAD(encrypted.subarray(0, 36)); decipher.setAuthTag(encrypted.subarray(-16));
    const payload = zlib.gunzipSync(Buffer.concat([decipher.update(encrypted.subarray(36, -16)), decipher.final()])); key.fill(0);
    let cursor = 0; const records = new Map();
    for (;;) {
      const length = payload.readUInt32BE(cursor); cursor += 4; if (!length) break;
      const meta = JSON.parse(payload.subarray(cursor, cursor + length)); cursor += length;
      records.set(meta.name, payload.subarray(cursor, cursor + meta.bytes)); cursor += meta.bytes;
    }
    assert.equal(cursor, payload.length);
    assert.deepEqual(records.get('service-evidence/example.txt'), evidence);
    const copyPath = path.join(root, 'roundtrip.db'); fs.writeFileSync(copyPath, records.get('database/velo.db'));
    const copy = new Database(copyPath, { readonly: true });
    try {
      assert.deepEqual(copy.prepare('SELECT * FROM sales').all(), db.prepare('SELECT * FROM sales').all());
      assert.deepEqual(copy.prepare('SELECT * FROM future_module').all(), db.prepare('SELECT * FROM future_module').all());
      assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
    } finally { copy.close(); }
    // La aplicación puede continuar escribiendo y la copia conserva el punto inicial.
    db.prepare('INSERT INTO sales VALUES(2,1,100,?)').run('B0100000043');
    assert.equal(verified.manifest.tables.find(t => t.name === 'sales').rows, 1);
    await assert.rejects(verifyMigrationPackage({ filePath: result.path, passphrase: 'Clave-equivocada-2026' }));
    const damaged = path.join(root, 'damaged.velomigrate');
    const altered = Buffer.from(encrypted); altered[40] ^= 1; fs.writeFileSync(damaged, altered);
    await assert.rejects(verifyMigrationPackage({ filePath: damaged, passphrase: args.passphrase }));
    fs.writeFileSync(damaged, encrypted.subarray(0, 40));
    await assert.rejects(verifyMigrationPackage({ filePath: damaged, passphrase: args.passphrase }));
    db.prepare('UPDATE service_order_evidence SET storage_path=?').run('service-evidence/../source.db');
    await assert.rejects(createMigrationPackage(args), /ruta no válida/);
    db.prepare('UPDATE service_order_evidence SET storage_path=?').run('service-evidence/missing.txt');
    await assert.rejects(createMigrationPackage(args));
    db.prepare('UPDATE service_order_evidence SET storage_path=?').run('service-evidence/example.txt');
    fs.writeFileSync(path.join(root, 'service-evidence', 'example.txt'), 'modificado');
    await assert.rejects(createMigrationPackage(args), /no coincide/);
    assert.deepEqual(fs.readdirSync(destinationDir), [path.basename(result.path)]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 2);
    fs.writeFileSync(path.join(root, 'service-evidence', 'example.txt'), evidence);
    const pos = await createMigrationPackage({ ...args, vertical: 'POS', businessId: 'otro-negocio' });
    const posVerified = await verifyMigrationPackage({ filePath: pos.path, passphrase: args.passphrase });
    assert.equal(posVerified.manifest.vertical, 'POS');
    assert.equal(posVerified.manifest.businessId, 'otro-negocio');
    assert.equal(posVerified.manifest.tables.find(t => t.name === 'sales').rows, 2);
    const businessDataDir = path.join(root, 'negocios', 'biz_prueba');
    fs.mkdirSync(businessDataDir, { recursive: true });
    fs.writeFileSync(path.join(businessDataDir, 'meta.json'), JSON.stringify({ name: 'Negocio ficticio' }));
    const complete = await createMigrationPackage({ ...args, businessId: 'biz_prueba',
      businessDataDir, purpose: 'desktop-complete-backup' });
    const recoveryDir = path.join(root, 'recuperado');
    const recovery = await restoreCompleteBackupToEmptyDirectory({ filePath: complete.path,
      passphrase: args.passphrase, destinationDir: recoveryDir });
    assert.equal(recovery.businessId, 'biz_prueba');
    assert.deepEqual(fs.readFileSync(path.join(recoveryDir, 'service-evidence', 'example.txt')), evidence);
    const recovered = new Database(path.join(recoveryDir, 'negocios', 'biz_prueba', 'velo.db'), { readonly: true });
    try {
      assert.deepEqual(recovered.prepare('SELECT * FROM sales').all(), db.prepare('SELECT * FROM sales').all());
      assert.deepEqual(recovered.prepare('SELECT * FROM future_module').all(), db.prepare('SELECT * FROM future_module').all());
    } finally { recovered.close(); }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(recoveryDir, 'negocios', 'biz_prueba', 'meta.json'))), { name: 'Negocio ficticio' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(recoveryDir, 'active_business.json'))).id, 'biz_prueba');
    await assert.rejects(restoreCompleteBackupToEmptyDirectory({ filePath: complete.path,
      passphrase: args.passphrase, destinationDir: recoveryDir }), /EEXIST/);
    await assert.rejects(restoreCompleteBackupToEmptyDirectory({ filePath: complete.path,
      passphrase: 'clave-equivocada-2026', destinationDir: path.join(root, 'no-creada') }));
    assert.equal(fs.existsSync(path.join(root, 'no-creada')), false);
    const posBackup = await createMigrationPackage({ ...args, vertical: 'POS', businessId: 'principal',
      purpose: 'desktop-complete-backup' });
    const posRecoveryDir = path.join(root, 'pos-recuperado');
    await restoreCompleteBackupToEmptyDirectory({ filePath: posBackup.path,
      passphrase: args.passphrase, destinationDir: posRecoveryDir });
    const posRecovery = new Database(path.join(posRecoveryDir, 'velo.db'), { readonly: true });
    try { assert.deepEqual(posRecovery.prepare('SELECT * FROM sales').all(), db.prepare('SELECT * FROM sales').all()); }
    finally { posRecovery.close(); }
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO sales VALUES(3,999,10,?)').run('B0100000044');
    await assert.rejects(createMigrationPackage(args), /integridad/);
    console.log('✓ Paquete cifrado: base completa, evidencias, historial, saldos, numeración, clave incorrecta, alteraciones y limpieza verificados');
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
