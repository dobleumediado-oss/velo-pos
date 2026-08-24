'use strict';

// Herramienta privada del proveedor. Este archivo vive bajo tools/ y queda
// fuera de build.files: nunca forma parte de los instaladores de clientes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LICENSE_VERSION = '3';
const ALLOWED_PRODUCTS = Object.freeze(['velo_pos', 'velo_tech_pos']);

function resolvePrivateKeyPath() {
  return process.env.VELO_PRIVATE_KEY_PATH
    ? path.resolve(process.env.VELO_PRIVATE_KEY_PATH)
    : path.join(__dirname, 'vendor-private.pem');
}

function resolveHistoryPath() {
  return path.join(__dirname, '.license-history.json');
}

function normalizeMachineId(value) {
  return String(value || '').trim().replace(/[\s-]+/g, '').toUpperCase();
}

function normalizeProducts(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const requested = new Set(input.map(item => String(item).trim().toLowerCase()).filter(Boolean));
  return ALLOWED_PRODUCTS.filter(product => requested.has(product));
}

function normalizeRequest(input = {}, options = {}) {
  const machineId = normalizeMachineId(input.machineId);
  const business = String(input.business || '').trim();
  const expiry = String(input.expiry || '').trim().toUpperCase();
  const products = normalizeProducts(input.products);

  if (!/^[A-F0-9]{32}$/.test(machineId) && !(options.allowUniversal && machineId === 'UNIVERSAL')) {
    throw new Error('El ID de máquina debe tener exactamente 32 caracteres hexadecimales');
  }
  if (!business || business.includes('|')) {
    throw new Error('El nombre del negocio es obligatorio y no puede contener |');
  }
  if (expiry !== 'PERPETUAL' && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    throw new Error('Selecciona una fecha válida o una licencia permanente');
  }
  if (expiry !== 'PERPETUAL') {
    const parsed = new Date(`${expiry}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expiry) {
      throw new Error('La fecha de vencimiento no existe');
    }
  }
  const unknown = (Array.isArray(input.products) ? input.products : String(input.products || '').split(','))
    .map(item => String(item).trim().toLowerCase()).filter(Boolean)
    .filter(product => !ALLOWED_PRODUCTS.includes(product));
  if (unknown.length) throw new Error('La solicitud contiene un producto desconocido');
  if (!products.length) throw new Error('Selecciona al menos un producto');

  return { machineId, business, expiry, products };
}

function readPrivateKey(privateKeyPath = resolvePrivateKeyPath()) {
  if (!fs.existsSync(privateKeyPath)) {
    throw new Error('No se encontró la llave privada del proveedor');
  }
  return fs.readFileSync(privateKeyPath, 'utf8');
}

function publicKeyDer(key) {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
}

function fingerprintForKey(key) {
  return crypto.createHash('sha256').update(publicKeyDer(key)).digest('hex').slice(0, 16).toUpperCase();
}

function keysMatch(privateKeyPem, expectedPublicKeyPem) {
  if (!expectedPublicKeyPem) return true;
  const actual = publicKeyDer(privateKeyPem);
  const expected = publicKeyDer(expectedPublicKeyPem);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readHistory(historyPath = resolveHistoryPath()) {
  if (!fs.existsSync(historyPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    throw new Error('El historial local de licencias está dañado');
  }
}

function writeHistory(history, historyPath = resolveHistoryPath()) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  const temporary = `${historyPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(history, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, historyPath);
  try { fs.chmodSync(historyPath, 0o600); } catch {}
}

function getProviderStatus(options = {}) {
  const privateKeyPath = options.privateKeyPath || resolvePrivateKeyPath();
  const historyPath = options.historyPath || resolveHistoryPath();
  const keyAvailable = fs.existsSync(privateKeyPath);
  let keyMatchesApplication = false;
  let fingerprint = '';
  let permissionsSecure = false;
  let error = '';

  if (keyAvailable) {
    try {
      const privateKeyPem = readPrivateKey(privateKeyPath);
      keyMatchesApplication = keysMatch(privateKeyPem, options.expectedPublicKeyPem);
      fingerprint = fingerprintForKey(privateKeyPem);
      const mode = fs.statSync(privateKeyPath).mode & 0o777;
      permissionsSecure = process.platform === 'win32' || (mode & 0o077) === 0;
    } catch (err) {
      error = err.message;
    }
  }

  let historyCount = 0;
  try { historyCount = readHistory(historyPath).length; } catch (err) { error ||= err.message; }

  return {
    available: keyAvailable && keyMatchesApplication && !error,
    keyAvailable,
    keyMatchesApplication,
    permissionsSecure,
    fingerprint,
    historyCount,
    keySource: process.env.VELO_PRIVATE_KEY_PATH ? 'Variable privada' : 'Llave local del proveedor',
    error,
  };
}

function createProviderLicense(input, options = {}) {
  const normalized = normalizeRequest(input, options);
  const privateKeyPath = options.privateKeyPath || resolvePrivateKeyPath();
  const privateKeyPem = readPrivateKey(privateKeyPath);
  if (!keysMatch(privateKeyPem, options.expectedPublicKeyPem)) {
    throw new Error('La llave privada no corresponde a las aplicaciones publicadas. No se generó ninguna licencia');
  }

  const productsField = normalized.products.join(',');
  const payload = [LICENSE_VERSION, normalized.machineId, normalized.business, normalized.expiry, productsField].join('|');
  const signature = crypto.sign('SHA256', Buffer.from(payload), privateKeyPem).toString('base64');
  const licenseKey = `${payload}|${signature}`;

  if (options.expectedPublicKeyPem
      && !crypto.verify('SHA256', Buffer.from(payload), options.expectedPublicKeyPem, Buffer.from(signature, 'base64'))) {
    throw new Error('La licencia no superó la verificación interna y fue descartada');
  }

  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'active',
    ...normalized,
    licenseKey,
  };
  const historyPath = options.historyPath || resolveHistoryPath();
  const history = readHistory(historyPath);
  history.unshift(record);
  writeHistory(history.slice(0, 500), historyPath);
  return record;
}

function listProviderLicenses(options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  return readHistory(options.historyPath || resolveHistoryPath()).slice(0, limit);
}

function markProviderLicenseCancelled(id, options = {}) {
  const historyPath = options.historyPath || resolveHistoryPath();
  const history = readHistory(historyPath);
  const record = history.find(item => item.id === String(id || ''));
  if (!record) throw new Error('No se encontró la licencia en el historial local');
  record.status = 'cancelled';
  record.cancelledAt = new Date().toISOString();
  writeHistory(history, historyPath);
  return record;
}

function securePrivateKey(options = {}) {
  const privateKeyPath = options.privateKeyPath || resolvePrivateKeyPath();
  if (!fs.existsSync(privateKeyPath)) throw new Error('No se encontró la llave privada del proveedor');
  if (process.platform !== 'win32') fs.chmodSync(privateKeyPath, 0o600);
  return getProviderStatus(options);
}

module.exports = {
  LICENSE_VERSION,
  ALLOWED_PRODUCTS,
  resolvePrivateKeyPath,
  resolveHistoryPath,
  normalizeRequest,
  getProviderStatus,
  createProviderLicense,
  listProviderLicenses,
  markProviderLicenseCancelled,
  securePrivateKey,
};
