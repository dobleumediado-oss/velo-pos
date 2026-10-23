#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createManualBackup, validateSqliteBackup, restoreBackup } = require('../versioning');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-backup-manual-'));
const sourcePath = path.join(directory, 'origen.db');
const backupPath = path.join(directory, 'respaldo.db');
let source;
try {
  source = new Database(sourcePath);
  source.pragma('journal_mode = WAL');
  source.pragma('wal_autocheckpoint = 0');
  source.exec('CREATE TABLE comprobantes (numero TEXT PRIMARY KEY)');
  source.prepare('INSERT INTO comprobantes (numero) VALUES (?)').run('B0100000001');
  assert.ok(fs.existsSync(`${sourcePath}-wal`), 'la prueba necesita transacciones en WAL');

  (async () => {
    await createManualBackup(source, backupPath);
    const restored = new Database(backupPath, { readonly: true });
    try {
      assert.equal(restored.prepare('SELECT numero FROM comprobantes').get().numero, 'B0100000001');
      assert.equal(restored.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      restored.close();
    }
    assert.equal(validateSqliteBackup(backupPath), true);
    const brokenPath = path.join(directory, 'incompleto.db');
    fs.copyFileSync(backupPath, brokenPath);
    fs.truncateSync(brokenPath, 256);
    assert.throws(() => validateSqliteBackup(brokenPath));
    source.close(); source = null;
    const active = new Database(path.join(directory, 'velo.db'));
    active.exec('CREATE TABLE comprobantes (numero TEXT PRIMARY KEY)');
    active.prepare('INSERT INTO comprobantes (numero) VALUES (?)').run('B0100000099');
    active.close();
    assert.throws(() => restoreBackup(directory, brokenPath));
    const restoredResult = restoreBackup(directory, backupPath);
    const recovered = new Database(path.join(directory, 'velo.db'), { readonly: true });
    const previous = new Database(restoredResult.backupCreated, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT numero FROM comprobantes').get().numero, 'B0100000001');
      assert.equal(previous.prepare('SELECT numero FROM comprobantes').get().numero, 'B0100000099');
    } finally { recovered.close(); previous.close(); }
    console.log('✓ Copia manual íntegra con WAL; restauración conserva la base anterior');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    source?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
} catch (error) {
  try { source?.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
  throw error;
}
