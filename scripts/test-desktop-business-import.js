'use strict';

// Todo ocurre en carpetas temporales con datos ficticios.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createMigrationPackage } = require('../lib/cloud-migration-package');
const { importCompleteBackupAsBusiness } = require('../lib/desktop-business-import');
const businessCtx = require('../src/main/business-context');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-desktop-import-test-'));
  const sourceDir = path.join(root, 'origen');
  const targetDir = path.join(root, 'destino');
  const exportDir = path.join(root, 'copias');
  const original = path.join(targetDir, 'velo.db');
  const evidence = Buffer.from('Imagen ficticia de una reparación');
  let source;
  try {
    fs.mkdirSync(path.join(sourceDir, 'service-evidence', '1'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'service-evidence', '1'), { recursive: true });
    fs.mkdirSync(exportDir);
    fs.writeFileSync(path.join(sourceDir, 'service-evidence', '1', 'foto.txt'), evidence);
    fs.writeFileSync(path.join(targetDir, 'service-evidence', '1', 'foto.txt'), 'Evidencia del negocio que ya existe');
    fs.writeFileSync(original, 'Base activa que debe permanecer igual');
    source = new Database(path.join(sourceDir, 'velo.db'));
    source.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY, number TEXT, total INTEGER);
      CREATE TABLE service_order_evidence(id INTEGER PRIMARY KEY, storage_path TEXT, sha256 TEXT);
      INSERT INTO sales VALUES(1, 'V-00000042', 2650000);`);
    source.prepare('INSERT INTO service_order_evidence VALUES(?,?,?)').run(1, 'service-evidence\\1\\foto.txt', crypto.createHash('sha256').update(evidence).digest('hex'));
    const passphrase = 'Clave-ficticia-segura-2026';
    const result = await createMigrationPackage({ db: source, dataDir: sourceDir, destinationDir: exportDir,
      passphrase, businessId: 'principal', businessName: 'Negocio de prueba', vertical: 'TECH',
      appVersion: '1.55.0', purpose: 'desktop-complete-backup' });
    const input = { filePath: result.path, passphrase, rootDataDir: targetDir, vertical: 'TECH', appVersion: '1.55.0' };
    await assert.rejects(importCompleteBackupAsBusiness({ ...input, vertical: 'POS' }), /VELO TECH/);
    await assert.rejects(importCompleteBackupAsBusiness({ ...input, appVersion: '1.54.2' }), /Actualiza VELO/);
    await assert.rejects(importCompleteBackupAsBusiness({ ...input, passphrase: 'Clave-incorrecta-segura' }));
    assert.equal(fs.readFileSync(original, 'utf8'), 'Base activa que debe permanecer igual');
    assert.equal(businessCtx.loadBusinesses(targetDir).length, 0);

    // En algunas PC Windows os.tmpdir() apunta a C:\WINDOWS\TEMP, sin permiso
    // para el usuario. La incorporación debe trabajar en la carpeta de VELO.
    const systemTempDir = os.tmpdir;
    os.tmpdir = () => path.join(root, 'temporal-no-disponible');
    let imported;
    try {
      imported = await importCompleteBackupAsBusiness(input);
    } finally { os.tmpdir = systemTempDir; }
    assert.equal(fs.existsSync(path.join(root, 'temporal-no-disponible')), false);
    assert.match(imported.id, /^biz_/);
    assert.equal(imported.evidenceFiles, 1);
    assert.equal(businessCtx.loadBusinesses(targetDir)[0].name, 'Negocio de prueba');
    const copy = new Database(path.join(targetDir, 'negocios', imported.id, 'velo.db'), { readonly: true });
    try {
      assert.deepEqual(copy.prepare('SELECT * FROM sales').all(), source.prepare('SELECT * FROM sales').all());
      const row = copy.prepare('SELECT storage_path, sha256 FROM service_order_evidence').get();
      assert.match(row.storage_path, new RegExp(`^service-evidence/importado-${imported.id}/`));
      const copied = fs.readFileSync(path.join(targetDir, row.storage_path));
      assert.deepEqual(copied, evidence);
      assert.equal(crypto.createHash('sha256').update(copied).digest('hex'), row.sha256);
    } finally { copy.close(); }
    assert.equal(fs.readFileSync(original, 'utf8'), 'Base activa que debe permanecer igual');
    assert.equal(fs.readFileSync(path.join(targetDir, 'service-evidence', '1', 'foto.txt'), 'utf8'), 'Evidencia del negocio que ya existe');
    await assert.rejects(importCompleteBackupAsBusiness(input), /ya se incorporó/);
    assert.equal(businessCtx.loadBusinesses(targetDir).length, 1);
    assert.equal(fs.readdirSync(targetDir).filter(name => name.startsWith('.velo-import-')).length, 0);
    console.log('✓ Copia completa importada como negocio nuevo sin reemplazar base ni evidencias existentes');
  } finally {
    source?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
