// ══════════════════════════════════════════════
// license.js — Licencia offline de VELO Suite
//   · ECDSA P-256: el cliente solo contiene la clave pública
//   · v3 declara los productos habilitados
//   · v2 se conserva exclusivamente como licencia legacy de VELO POS
//   · v1 (hash con secreto embebido) se rechaza por insegura
// ═════════════════════════════════════════════

const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const LICENSE_VERSION = '3';
const GRACE_DAYS      = 30;
const WARN_DAYS       = 7;
const LICENSE_PRODUCTS = Object.freeze(['velo_pos', 'velo_tech_pos']);

// Solo verifica. La clave privada vive fuera del repositorio y del instalador.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYi32UkSnHgjHcDvulKyc0thmkFqB
EGTRTJDMlSfzk/sRF9FFl0YK40Ndw8drzAW8QNvUT+1+T1b+PPK4HGX1nw==
-----END PUBLIC KEY-----`;

function getMachineId() {
  const cpus     = os.cpus();
  const hostname = os.hostname();
  const platform = os.platform();
  const arch     = os.arch();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  const raw = `${hostname}::${platform}::${arch}::${cpuModel}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32).toUpperCase();
}

function normalizeProducts(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const unique = [...new Set(input.map(v => String(v).trim().toLowerCase()).filter(Boolean))];
  return LICENSE_PRODUCTS.filter(product => unique.includes(product));
}

// Las firmas ECDSA se codifican en Base64 y distinguen mayúsculas de
// minúsculas. Solo retiramos saltos de línea que puedan aparecer al copiar una
// licencia desde una pantalla estrecha; los espacios internos (por ejemplo en
// el nombre del negocio) forman parte de la licencia firmada y se conservan.
function normalizeLicenseKeyInput(value) {
  return String(value || '').trim().replace(/[\r\n]+/g, '');
}

// v3: 3|MACHINE_ID|BUSINESS|EXPIRY|velo_pos,velo_tech_pos|BASE64_SIGNATURE
// v2: 2|MACHINE_ID|BUSINESS|EXPIRY|BASE64_SIGNATURE (legacy VELO POS)
function parseLicense(content) {
  try {
    const raw = String(content || '').trim();
    const parts = raw.split('|');
    if (parts.length === 6 && parts[0] === LICENSE_VERSION) {
      const [version, machineId, business, expiry, productsField, signature] = parts;
      const products = normalizeProducts(productsField);
      // Forma canónica: evita campos desconocidos, duplicados o ambiguos.
      if (!products.length || products.join(',') !== productsField) return null;
      return {
        version, machineId, business, expiry, products, productsField, signature, raw,
        signedPayload: parts.slice(0, 5).join('|'),
      };
    }
    if (parts.length === 5 && (parts[0] === '2' || parts[0] === '1')) {
      const [version, machineId, business, expiry, signature] = parts;
      return {
        version, machineId, business, expiry, signature, raw,
        products: version === '2' ? ['velo_pos'] : [],
        signedPayload: parts.slice(0, 4).join('|'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function verifySignature(license, publicKeyPem = PUBLIC_KEY_PEM) {
  try {
    if (!license || !['2', LICENSE_VERSION].includes(license.version)) return false;
    const sigBuf = Buffer.from(license.signature, 'base64');
    if (!sigBuf.length) return false;
    const pubKey = crypto.createPublicKey(publicKeyPem);
    return crypto.verify('SHA256', Buffer.from(license.signedPayload), pubKey, sigBuf);
  } catch {
    return false;
  }
}

function verifyLicense(license, machineId, requiredProduct = 'velo_pos', options = {}) {
  if (!license) {
    return { valid: false, code: 'NO_LICENSE', reason: 'Sin licencia', graceEligible: true };
  }
  if (license.version === '1') {
    return {
      valid: false,
      code: 'INSECURE_LEGACY_LICENSE',
      reason: 'Esta licencia antigua ya no es segura; solicita una licencia nueva',
      graceEligible: false,
    };
  }
  if (!['2', LICENSE_VERSION].includes(license.version)) {
    return { valid: false, code: 'UNSUPPORTED_VERSION', reason: 'Formato de licencia obsoleto', graceEligible: false };
  }
  if (license.machineId !== machineId && license.machineId !== 'UNIVERSAL') {
    return { valid: false, code: 'WRONG_MACHINE', reason: 'Licencia de otra máquina', graceEligible: false };
  }
  if (!verifySignature(license, options.publicKeyPem || PUBLIC_KEY_PEM)) {
    return { valid: false, code: 'INVALID_SIGNATURE', reason: 'Licencia inválida o alterada', graceEligible: false };
  }

  const product = String(requiredProduct || 'velo_pos');
  if (!license.products.includes(product)) {
    return {
      valid: false,
      code: 'PRODUCT_NOT_LICENSED',
      reason: `La licencia no habilita ${product === 'velo_tech_pos' ? 'VELO TECH POS' : 'VELO POS'}`,
      products: license.products,
      requiredProduct: product,
      graceEligible: false,
    };
  }

  if (license.expiry !== 'PERPETUAL') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(license.expiry)) {
      return { valid: false, code: 'INVALID_EXPIRY', reason: 'Fecha de licencia inválida', graceEligible: false };
    }
    const today = new Date().toISOString().split('T')[0];
    if (today > license.expiry) {
      return {
        valid: false, code: 'EXPIRED', reason: 'Licencia vencida', expiry: license.expiry,
        products: license.products, requiredProduct: product, graceEligible: false,
      };
    }
    const daysLeft = Math.ceil((new Date(`${license.expiry}T23:59:59`) - new Date()) / 86400000);
    return {
      valid: true, expiry: license.expiry, daysLeft, business: license.business,
      products: license.products, requiredProduct: product,
    };
  }

  return {
    valid: true, expiry: 'Perpetua', business: license.business,
    products: license.products, requiredProduct: product,
  };
}

function readLicenseFile(dataDir) {
  const licensePath = path.join(dataDir, 'license.key');
  if (!fs.existsSync(licensePath)) return null;
  try { return parseLicense(fs.readFileSync(licensePath, 'utf8')); }
  catch { return null; }
}

function getLicenseStatus(dataDir, requiredProduct = 'velo_pos', options = {}) {
  const machineId    = options.machineId || getMachineId();
  const license      = readLicenseFile(dataDir);
  const verification = verifyLicense(license, machineId, requiredProduct, options);

  let graceDaysLeft = 0;
  try {
    const installedPath = path.join(dataDir, '.installed');
    if (!fs.existsSync(installedPath)) fs.writeFileSync(installedPath, new Date().toISOString());
    const installedAt = new Date(fs.readFileSync(installedPath, 'utf8').trim());
    const daysSince = Number.isFinite(installedAt.getTime())
      ? Math.max(0, Math.floor((Date.now() - installedAt.getTime()) / 86400000))
      : GRACE_DAYS;
    graceDaysLeft = Math.max(0, GRACE_DAYS - daysSince);
  } catch {}

  const inGrace = !verification.valid && verification.graceEligible === true && graceDaysLeft > 0;
  return {
    machineId,
    licensed: verification.valid,
    inGrace,
    graceDaysLeft,
    reason: verification.reason,
    code: verification.code || '',
    expiry: verification.expiry,
    daysLeft: verification.daysLeft,
    business: verification.business || license?.business || '',
    products: verification.products || license?.products || [],
    requiredProduct,
    blocked: !verification.valid && !inGrace,
    warningSoon: verification.valid && (verification.daysLeft || 9999) <= WARN_DAYS,
    licenseKey: license?.raw || '',
  };
}

function activateLicense(dataDir, licenseKey, requiredProduct = 'velo_pos', options = {}) {
  const machineId = options.machineId || getMachineId();
  const parsed = parseLicense(normalizeLicenseKeyInput(licenseKey));
  if (!parsed) return { ok: false, error: 'Formato de licencia inválido' };

  const result = verifyLicense(parsed, machineId, requiredProduct, options);
  if (!result.valid) return { ok: false, error: result.reason, code: result.code };

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'license.key'), parsed.raw, { mode: 0o600 });
  return { ok: true, ...result };
}

// El desarrollo local necesita poder abrir bases antiguas para migrarlas y
// probarlas. El bypass exige DOS condiciones: binario no empaquetado y bandera
// --dev explícita. En una instalación de cliente, --dev nunca desactiva la licencia.
function withDevelopmentBypass(status, { isPackaged = true, explicitDev = false } = {}) {
  if (isPackaged || !explicitDev) return status;
  return {
    ...status,
    licensed: true,
    inGrace: false,
    blocked: false,
    warningSoon: false,
    development: true,
    reason: 'Modo desarrollo local',
  };
}

module.exports = {
  PUBLIC_KEY_PEM,
  LICENSE_VERSION,
  LICENSE_PRODUCTS,
  getMachineId,
  normalizeProducts,
  normalizeLicenseKeyInput,
  parseLicense,
  verifySignature,
  verifyLicense,
  getLicenseStatus,
  activateLicense,
  withDevelopmentBypass,
};
