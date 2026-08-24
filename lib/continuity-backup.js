'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const MAGIC = Buffer.from('VELOENC1');

function _deriveKey(passphrase, salt) {
  if (String(passphrase || '').length < 10) throw new Error('La clave debe tener al menos 10 caracteres');
  return crypto.scryptSync(String(passphrase), salt, 32, { N:16384, r:8, p:1 });
}

function _assertFolder(destinationDir) {
  const resolved = path.resolve(String(destinationDir || ''));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('El destino externo no es una carpeta');
  fs.accessSync(resolved, fs.constants.W_OK);
  return resolved;
}

function _readEnvelope(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('El archivo no es un respaldo cifrado de VELO');
  }
  const headerLength = bytes.readUInt32BE(MAGIC.length);
  if (headerLength < 20 || headerLength > 8192) throw new Error('Encabezado de respaldo no válido');
  const start = MAGIC.length + 4;
  const header = JSON.parse(bytes.subarray(start, start + headerLength).toString('utf8'));
  return { header, ciphertext:bytes.subarray(start + headerLength) };
}

function _decryptTo(filePath, passphrase, destination) {
  const { header, ciphertext } = _readEnvelope(filePath);
  const salt = Buffer.from(header.salt, 'base64');
  const iv = Buffer.from(header.iv, 'base64');
  const tag = Buffer.from(header.tag, 'base64');
  const key = _deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const checksum = crypto.createHash('sha256').update(plain).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(checksum), Buffer.from(String(header.sha256 || '')))) {
    throw new Error('El respaldo no superó la verificación de integridad');
  }
  fs.writeFileSync(destination, plain, { flag:'wx', mode:0o600 });
  return { header, checksum, size:plain.length };
}

async function createEncryptedBackup({ db, destinationDir, passphrase, businessId = 'principal', businessName = 'VELO' }) {
  if (!db || typeof db.backup !== 'function') throw new Error('La base de datos no está disponible');
  const targetDir = _assertFolder(destinationDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-continuity-'));
  const snapshot = path.join(tempDir, 'snapshot.db');
  try {
    await db.backup(snapshot);
    const plain = fs.readFileSync(snapshot);
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = _deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sha256 = crypto.createHash('sha256').update(plain).digest('hex');
    const header = Buffer.from(JSON.stringify({
      format:1, algorithm:'AES-256-GCM', kdf:'scrypt', business_id:String(businessId),
      business_name:String(businessName), created_at:new Date().toISOString(),
      salt:salt.toString('base64'), iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), sha256,
    }), 'utf8');
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
    const safeBusiness = String(businessName || 'velo').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0,40) || 'velo';
    const finalPath = path.join(targetDir, `velo-${safeBusiness}-${stamp}.veloenc`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, Buffer.concat([MAGIC, size, header, ciphertext]), { flag:'wx', mode:0o600 });
    fs.renameSync(tmpPath, finalPath);
    return { path:finalPath, checksum:sha256, bytes:plain.length, created_at:JSON.parse(header.toString()).created_at };
  } finally {
    try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch {}
  }
}

function verifyEncryptedBackup({ filePath, passphrase }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-verify-'));
  const snapshot = path.join(tempDir, 'verify.db');
  let detached;
  try {
    const result = _decryptTo(path.resolve(String(filePath || '')), passphrase, snapshot);
    detached = new Database(snapshot, { readonly:true, fileMustExist:true });
    const integrity = detached.pragma('integrity_check', { simple:true });
    const foreignKeys = detached.pragma('foreign_key_check');
    if (integrity !== 'ok' || foreignKeys.length) throw new Error('La base descifrada no superó las pruebas de SQLite');
    return { ok:true, header:result.header, checksum:result.checksum, bytes:result.size, integrity, foreign_key_errors:0 };
  } finally {
    try { detached?.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch {}
  }
}

module.exports = { createEncryptedBackup, verifyEncryptedBackup };
