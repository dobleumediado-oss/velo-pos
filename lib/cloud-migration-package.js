'use strict';

// Preparación local: conserva la base íntegra y las evidencias referenciadas.
// No importa datos en Cloud, no bloquea ventas y no marca el negocio migrado.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const MAGIC = Buffer.from('VELOMIG1');
const derive = promisify(crypto.scrypt);
const workingDirectory = (root, prefix) => fs.mkdtempSync(path.join(root || os.tmpdir(), prefix));
const hashFile = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const quote = name => '"' + name.replace(/"/g, '""') + '"';
async function keyFor(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('Usa una clave de entre 12 y 1024 caracteres');
  return derive(passphrase, salt, 32);
}
async function* encode(entries) {
  for (const entry of entries) {
    const metadata = Buffer.from(JSON.stringify({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 }));
    const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
    yield length; yield metadata;
    const hash = crypto.createHash('sha256'); let bytes = 0;
    const source = entry.buffer ? [entry.buffer] : fs.createReadStream(entry.file);
    for await (const chunk of source) { bytes += chunk.length; hash.update(chunk); yield chunk; }
    if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('Un archivo cambió durante la copia; vuelve a preparar el paquete');
  }
  yield Buffer.alloc(4);
}

async function createMigrationPackage({ db, dataDir, businessDataDir, destinationDir, passphrase, businessId, businessName, vertical, appVersion, purpose = 'desktop-migration-preparation' }) {
  if (!db || typeof db.backup !== 'function') throw new Error('La base del negocio no está disponible');
  if (!['POS', 'TECH'].includes(vertical)) throw new Error('Edición no compatible');
  if (!['desktop-migration-preparation', 'desktop-complete-backup'].includes(purpose)) throw new Error('Tipo de paquete no válido');
  if (!businessId) throw new Error('No se pudo identificar el negocio');
  if (!path.isAbsolute(destinationDir || '') || !fs.statSync(destinationDir).isDirectory()) throw new Error('Selecciona una carpeta válida');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await keyFor(passphrase, salt);
  const prefix = Buffer.concat([MAGIC, salt, iv]);
  const temp = workingDirectory(dataDir, 'velo-migration-');
  const partial = path.join(destinationDir, `.velo-migration-${crypto.randomUUID()}.tmp`);
  let snapshotDb;
  try {
    const snapshot = path.join(temp, 'snapshot.db');
    await db.backup(snapshot);
    const capturedAt = new Date().toISOString();
    snapshotDb = new Database(snapshot, { readonly: true, fileMustExist: true });
    if (snapshotDb.pragma('integrity_check', { simple: true }) !== 'ok' || snapshotDb.pragma('foreign_key_check').length) throw new Error('La copia necesita revisión de integridad antes de migrar');
    const tables = snapshotDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => ({ name, rows: snapshotDb.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n }));
    const files = [{ name: 'database/velo.db', file: snapshot, bytes: fs.statSync(snapshot).size, sha256: await hashFile(snapshot) }];
    if (tables.some(table => table.name === 'service_order_evidence')) {
      const root = fs.realpathSync(dataDir);
      const seen = new Map();
      for (const row of snapshotDb.prepare('SELECT storage_path, sha256 FROM service_order_evidence').all()) {
        const relative = String(row.storage_path).replace(/\\/g, '/');
        if (!relative.startsWith('service-evidence/') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Una evidencia tiene una ruta no válida');
        const file = fs.realpathSync(path.join(root, relative));
        if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('Una evidencia está fuera de la carpeta del negocio');
        const sha256 = await hashFile(file);
        if (sha256 !== row.sha256) throw new Error('Una evidencia no coincide con su registro; revisa el archivo original');
        if (seen.has(relative)) { if (seen.get(relative) !== sha256) throw new Error('Evidencia inconsistente'); continue; }
        seen.set(relative, sha256);
        files.push({ name: relative, file, bytes: fs.statSync(file).size, sha256 });
      }
    }
    if (purpose === 'desktop-complete-backup' && businessDataDir) {
      const meta = path.join(businessDataDir, 'meta.json');
      if (fs.existsSync(meta)) {
        const stat = fs.lstatSync(meta);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('La ficha del negocio no es válida');
        const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('La ficha del negocio no es válida');
        files.push({ name: 'business/meta.json', file: meta, bytes: stat.size, sha256: await hashFile(meta) });
      }
    }
    snapshotDb.close(); snapshotDb = null;
    const manifest = { format: 1, purpose, businessId: String(businessId), vertical, appVersion: String(appVersion), capturedAt, cloudActivated: false, scope: purpose === 'desktop-complete-backup' ? 'complete-database-and-service-evidence-and-business-meta' : 'complete-database-and-service-evidence', tables, files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) };
    if (purpose === 'desktop-complete-backup') manifest.businessName = String(businessName || businessId).slice(0, 120);
    const buffer = Buffer.from(JSON.stringify(manifest));
    const entries = [{ name: 'manifest.json', buffer, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }, ...files];
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(prefix);
    fs.writeFileSync(partial, prefix, { flag: 'wx', mode: 0o600 });
    await pipeline(Readable.from(encode(entries)), zlib.createGzip(), cipher, fs.createWriteStream(partial, { flags: 'a', mode: 0o600 }));
    fs.appendFileSync(partial, cipher.getAuthTag());
    // Verificar el paquete escrito antes de mostrar que está listo.
    await verifyMigrationPackage({ filePath: partial, passphrase, workDir: dataDir });
    const extension = purpose === 'desktop-complete-backup' ? 'velobackup' : 'velomigrate';
    const label = purpose === 'desktop-complete-backup'
      ? String(businessName || businessId).normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'negocio'
      : vertical.toLowerCase();
    const finalPath = path.join(destinationDir, `velo-${label}-${crypto.randomUUID()}.${extension}`);
    fs.renameSync(partial, finalPath);
    return { path: finalPath, bytes: fs.statSync(finalPath).size, tables: tables.length, evidenceFiles: files.length - 1, capturedAt: manifest.capturedAt, cloudActivated: false };
  } finally {
    key.fill(0);
    try { snapshotDb?.close(); } catch {}
    fs.rmSync(partial, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function allowedBackupEntry(name) {
  if (name === 'database/velo.db' || name === 'business/meta.json') return true;
  return name.startsWith('service-evidence/') && name.split('/').every(part =>
    part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes(':'));
}

async function verifyMigrationPackage({ filePath, passphrase, extractDir, workDir }) {
  const temp = workingDirectory(workDir, 'velo-migration-check-');
  let key;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 53) throw new Error('Paquete incompleto');
    const fd = fs.openSync(filePath, 'r');
    const prefix = Buffer.alloc(36), tag = Buffer.alloc(16);
    try { fs.readSync(fd, prefix, 0, 36, 0); fs.readSync(fd, tag, 0, 16, stat.size - 16); } finally { fs.closeSync(fd); }
    if (!prefix.subarray(0, 8).equals(MAGIC)) throw new Error('El archivo no es un paquete de migración VELO');
    key = await keyFor(passphrase, prefix.subarray(8, 24));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, prefix.subarray(24));
    decipher.setAAD(prefix); decipher.setAuthTag(tag);
    // Autenticar antes de descomprimir o interpretar datos del paquete.
    const compressed = path.join(temp, 'verified.gz');
    await pipeline(fs.createReadStream(filePath, { start: 36, end: stat.size - 17 }), decipher, fs.createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
    // Comprobar cada registro sin reconstruir rutas recibidas del paquete.
    const source = fs.createReadStream(compressed);
    const stream = zlib.createGunzip();
    source.on('error', error => stream.destroy(error));
    source.pipe(stream);
    const iterator = stream[Symbol.asyncIterator](); let pending = Buffer.alloc(0);
    const take = async size => {
      const parts = []; let remaining = size;
      while (remaining) {
        if (!pending.length) { const next = await iterator.next(); if (next.done) throw new Error('Paquete truncado'); pending = next.value; }
        const n = Math.min(remaining, pending.length); parts.push(pending.subarray(0, n)); pending = pending.subarray(n); remaining -= n;
      }
      return Buffer.concat(parts, size);
    };
    const records = []; let manifest;
    try {
      for (;;) {
        const length = (await take(4)).readUInt32BE(); if (!length) break;
        if (length > 8192 || records.length > 100000) throw new Error('Paquete fuera de los límites admitidos');
        const record = JSON.parse((await take(length)).toString('utf8'));
        if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > 64 * 1024 ** 3 || typeof record.name !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Registro no válido');
        if (!records.length && (record.name !== 'manifest.json' || record.bytes > 8 * 1024 ** 2)) throw new Error('Manifiesto no válido');
        const hash = crypto.createHash('sha256'); const first = [];
        let output;
        if (extractDir && records.length) {
          if (!allowedBackupEntry(record.name)) throw new Error('El respaldo contiene una ruta no permitida');
          const target = path.join(extractDir, record.name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          output = fs.openSync(target, 'wx', 0o600);
        }
        try {
          for (let left = record.bytes; left > 0;) {
            const part = await take(Math.min(left, 65536));
            hash.update(part);
            if (!records.length) first.push(part);
            if (output !== undefined) fs.writeSync(output, part);
            left -= part.length;
          }
        } finally { if (output !== undefined) fs.closeSync(output); }
        if (hash.digest('hex') !== record.sha256) throw new Error('Un registro no superó la verificación');
        if (!records.length) manifest = JSON.parse(Buffer.concat(first).toString('utf8'));
        records.push(record);
      }
      if (pending.length || !(await iterator.next()).done) throw new Error('Contenido adicional no admitido');
    } finally { source.destroy(); stream.destroy(); }
    if (manifest?.format !== 1 || manifest.cloudActivated !== false || !Array.isArray(manifest.files) || manifest.files.length !== records.length - 1 || JSON.stringify(manifest.files) !== JSON.stringify(records.slice(1))) throw new Error('El contenido no coincide con el manifiesto');
    if (extractDir && (manifest.purpose !== 'desktop-complete-backup' ||
      manifest.scope !== 'complete-database-and-service-evidence-and-business-meta' ||
      !manifest.files.some(file => file.name === 'database/velo.db'))) throw new Error('El archivo no es una copia completa restaurable');
    return { ok: true, manifest };
  } finally { key?.fill(0); fs.rmSync(temp, { recursive: true, force: true }); }
}

async function restoreCompleteBackupToEmptyDirectory({ filePath, passphrase, destinationDir, workDir }) {
  const staging = workingDirectory(workDir, 'velo-restore-check-');
  let created = false;
  try {
    const { manifest } = await verifyMigrationPackage({ filePath, passphrase, extractDir: staging, workDir });
    if (manifest.businessId !== 'principal' && !/^biz_[A-Za-z0-9_-]+$/.test(manifest.businessId)) throw new Error('Identificador de negocio no válido');
    const snapshot = path.join(staging, 'database', 'velo.db');
    const files = new Map(manifest.files.map(file => [file.name, file.sha256]));
    const checked = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      if (checked.pragma('integrity_check', { simple: true }) !== 'ok' || checked.pragma('foreign_key_check').length) throw new Error('La base de la copia no superó la prueba de integridad');
      const actualTables = checked.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(row => row.name);
      if (!Array.isArray(manifest.tables) ||
          JSON.stringify(actualTables) !== JSON.stringify(manifest.tables.map(table => table.name))) {
        throw new Error('El inventario de tablas no coincide con la base recuperada');
      }
      for (const table of manifest.tables || []) {
        if (typeof table.name !== 'string' || !table.name ||
          checked.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).get().n !== table.rows) throw new Error('El inventario de tablas no coincide con la copia');
      }
      const evidence = checked.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_order_evidence'").get()
        ? checked.prepare('SELECT storage_path, sha256 FROM service_order_evidence').all() : [];
      for (const item of evidence) {
        const relative = String(item.storage_path || '').replace(/\\/g, '/');
        if (!allowedBackupEntry(relative) || files.get(relative) !== item.sha256) throw new Error('Falta una evidencia del servicio en la copia');
      }
    } finally { checked.close(); }
    if (!path.isAbsolute(destinationDir || '')) throw new Error('Selecciona una carpeta nueva para recuperar el negocio');
    fs.mkdirSync(destinationDir); created = true;
    const businessDir = manifest.businessId === 'principal' ? destinationDir : path.join(destinationDir, 'negocios', manifest.businessId);
    fs.mkdirSync(businessDir, { recursive: true });
    fs.copyFileSync(snapshot, path.join(businessDir, 'velo.db'), fs.constants.COPYFILE_EXCL);
    if (manifest.businessId !== 'principal') {
      if (!files.has('business/meta.json')) throw new Error('Falta la ficha del negocio');
      const businessMeta = JSON.parse(fs.readFileSync(path.join(staging, 'business', 'meta.json'), 'utf8'));
      if (!businessMeta || typeof businessMeta !== 'object' || Array.isArray(businessMeta)) throw new Error('La ficha del negocio no es válida');
      fs.copyFileSync(path.join(staging, 'business', 'meta.json'), path.join(businessDir, 'meta.json'), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(destinationDir, 'active_business.json'),
        JSON.stringify({ id: manifest.businessId, set_at: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 });
    }
    for (const file of manifest.files.filter(item => item.name.startsWith('service-evidence/'))) {
      const target = path.join(destinationDir, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(staging, file.name), target, fs.constants.COPYFILE_EXCL);
    }
    return { ok: true, businessId: manifest.businessId, destinationDir, tables: manifest.tables.length,
      evidenceFiles: manifest.files.filter(file => file.name.startsWith('service-evidence/')).length };
  } catch (error) {
    if (created) fs.rmSync(destinationDir, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { createMigrationPackage, verifyMigrationPackage, restoreCompleteBackupToEmptyDirectory };
