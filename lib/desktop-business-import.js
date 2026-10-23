'use strict';

// Incorpora una copia completa como negocio nuevo. Nunca sustituye la base
// activa ni reutiliza rutas de evidencias de otra instalación.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { verifyMigrationPackage, restoreCompleteBackupToEmptyDirectory } = require('./cloud-migration-package');
const businessCtx = require('../src/main/business-context');

function compareVersions(left, right) {
  const parts = value => String(value || '').split('.').slice(0, 3).map(part => Number(part) || 0);
  const a = parts(left), b = parts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function importCompleteBackupAsBusiness({ filePath, passphrase, rootDataDir, vertical, appVersion }) {
  if (!path.isAbsolute(filePath || '') || !path.isAbsolute(rootDataDir || '')) throw new Error('Selecciona una copia y una instalación válidas');
  if (!['POS', 'TECH'].includes(vertical)) throw new Error('Edición de VELO no válida');
  const { manifest } = await verifyMigrationPackage({ filePath, passphrase });
  if (manifest.purpose !== 'desktop-complete-backup') throw new Error('Selecciona una copia completa .velobackup');
  if (manifest.vertical !== vertical) throw new Error(`Esta copia es de VELO ${manifest.vertical}; abre VELO ${manifest.vertical} para importarla`);
  if (compareVersions(manifest.appVersion, appVersion) > 0) throw new Error('Actualiza VELO antes de importar una copia creada con una versión más reciente');
  const installed = businessCtx.loadBusinesses(rootDataDir);
  if (installed.some(item => item.origin_business_id === manifest.businessId && item.backup_captured_at === manifest.capturedAt)) {
    throw new Error('Esta copia ya se incorporó en esta instalación');
  }

  const id = `biz_${crypto.randomUUID()}`;
  const nonce = crypto.randomUUID();
  const staging = path.join(rootDataDir, `.velo-import-${nonce}`);
  const businessRoot = path.join(rootDataDir, 'negocios');
  const businessStaging = path.join(businessRoot, `.velo-import-${nonce}`);
  const businessFinal = path.join(businessRoot, id);
  const evidenceRoot = path.join(rootDataDir, 'service-evidence');
  const evidenceStaging = path.join(evidenceRoot, `.velo-import-${nonce}`);
  const evidenceFinal = path.join(evidenceRoot, `importado-${id}`);
  let evidenceMoved = false;
  let businessMoved = false;
  try {
    await restoreCompleteBackupToEmptyDirectory({ filePath, passphrase, destinationDir: staging });
    const sourceBusiness = manifest.businessId === 'principal'
      ? staging : path.join(staging, 'negocios', manifest.businessId);
    const sourceDb = path.join(sourceBusiness, 'velo.db');
    fs.mkdirSync(businessRoot, { recursive: true });
    fs.mkdirSync(businessStaging);
    fs.copyFileSync(sourceDb, path.join(businessStaging, 'velo.db'), fs.constants.COPYFILE_EXCL);

    const importedDb = new Database(path.join(businessStaging, 'velo.db'));
    let evidenceFiles = 0;
    try {
      const hasEvidence = importedDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_order_evidence'").get();
      if (hasEvidence) {
        const rows = importedDb.prepare('SELECT DISTINCT storage_path FROM service_order_evidence').all();
        if (rows.length) fs.mkdirSync(evidenceStaging, { recursive: true });
        const update = importedDb.prepare('UPDATE service_order_evidence SET storage_path = ? WHERE storage_path = ?');
        const changes = [];
        for (const { storage_path: oldPath } of rows) {
          const normalized = String(oldPath).replace(/\\/g, '/');
          const relative = normalized.slice('service-evidence/'.length);
          if (!normalized.startsWith('service-evidence/') || !relative || relative.split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error('Una evidencia tiene una ruta no válida');
          }
          const source = path.join(staging, normalized);
          const target = path.join(evidenceStaging, relative);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          changes.push([`service-evidence/importado-${id}/${relative}`, oldPath]);
          evidenceFiles++;
        }
        importedDb.transaction(() => {
          for (const [next, previous] of changes) update.run(next, previous);
        })();
      }
      if (importedDb.pragma('integrity_check', { simple: true }) !== 'ok' || importedDb.pragma('foreign_key_check').length) {
        throw new Error('La base importada no superó la verificación de integridad');
      }
    } finally { importedDb.close(); }

    const originalName = String(manifest.businessName || 'Negocio recuperado').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120) || 'Negocio recuperado';
    const name = installed.some(item => item.name === originalName)
      ? `${originalName.slice(0, 107)} (recuperado)` : originalName;
    fs.writeFileSync(path.join(businessStaging, 'meta.json'), JSON.stringify({
      id, name, description: 'Importado desde una copia completa de VELO',
      created_at: new Date().toISOString(), active: true,
      origin_business_id: manifest.businessId, backup_captured_at: manifest.capturedAt,
    }), { flag: 'wx', mode: 0o600 });

    if (evidenceFiles) { fs.renameSync(evidenceStaging, evidenceFinal); evidenceMoved = true; }
    fs.renameSync(businessStaging, businessFinal); businessMoved = true;
    return { ok: true, id, name, evidenceFiles, capturedAt: manifest.capturedAt };
  } catch (error) {
    if (businessMoved) fs.rmSync(businessFinal, { recursive: true, force: true });
    if (evidenceMoved) fs.rmSync(evidenceFinal, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(businessStaging, { recursive: true, force: true });
    fs.rmSync(evidenceStaging, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { importCompleteBackupAsBusiness };
