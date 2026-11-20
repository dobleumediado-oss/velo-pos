// ══════════════════════════════════════════════
// license.js — Licencia offline de VELO Suite
//   · ECDSA P-256: el cliente solo contiene la clave pública
//   · v3 declara los productos habilitados
//   · v2 se conserva exclusivamente como licencia legacy de VELO POS
//   · v1 (hash con secreto embebido) se rechaza por insegura
//   · 20 nov 2026: la llave privada anterior quedó en el historial del repo
//     público, así que se cambió. Con la llave anterior solo valen las licencias
//     emitidas de verdad (lista blanca de huellas); cualquier otra recibe 30 días
//     de aviso para pedir su licencia nueva y luego se bloquea.
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
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzdNenB2xfWdy4peT5g0naHRGxJqy
+OM3J1e0CYtUZYI7/e0b2Q4GEa2yusrGqEyNa2qA4ekniuYHrQCzg/I3tQ==
-----END PUBLIC KEY-----`;

// Llave retirada el 20 nov 2026 (su privada se filtró). Solo verifica licencias
// de la lista blanca: SHA-256 de cada licencia que el proveedor emitió con ella.
const LEGACY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYi32UkSnHgjHcDvulKyc0thmkFqB
EGTRTJDMlSfzk/sRF9FFl0YK40Ndw8drzAW8QNvUT+1+T1b+PPK4HGX1nw==
-----END PUBLIC KEY-----`;
const LEGACY_ALLOWED_SHA256 = Object.freeze(new Set([
  '1ef49ce3d3188d4629015b06987e9834b3ee4863a2ae18a868c3edc0e2c11626',
  '202438cebee3d92379a39f5b7b445e90d64a360ed7082f17257cd8cb65783975',
  '4669f795d2d6168688435d7d3ec87c94756728b91f563393b53c1882e2876f7e',
  '52ea7d37f6c9791aeeb8da3ba3aeac50660f7789c3e7456bbcc4bf09ae3a3be3',
  '60e0dc477811ae5a5915bbf9d008514f9269e8f5adf898d5e0c3ea8a914e73a5',
  '6e7eaa130da57a125f6920bf9d17833287dcbbc3a3ace65ebc8aaf4bb6596e60',
  '799884ba672374f934a31cad83d9a0973905ebc3aa710daf2efce763130187e4',
  '90f3ab6243cd51182299315eb878680a4402972eb487b1047bb41b64e1a2e8c4',
  '9ce143f3fb0e9a464a5b2ac52268b0dda0088227e09ce9084a5848a3d613d514',
  '9d05bf10e305222872df5050f67877fe7344486aa4c8e29a226ab8809a2b0404',
  'b9a3428bae4d77fa50ed9836053903fb7252d69da51b479a64b4758b56435b8d',
  'd63bd316b6a0e61c1b5f11bce39a9ad605d5ca721a895b10f1da244333da8a49',
  'e214920082a830040c6e1af163dd0ee9c5d9f9dd37c02018ac8b3d6c10a2eab1',
  'f6921d22cad8f5db39723f5e9bb01ab10eee8a5bb7095d054cb9b57502d4ceec',
  'ff2bc81e8decab62712f300a2bdfed60d3690b7130640f2275256ea5ca550739',
]));
const LEGACY_NOTICE_DAYS = 30;
const LEGACY_NOTICE_FILE = '.legacy-license-notice';

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

const licenseFingerprint = (license) => crypto.createHash('sha256').update(String(license?.raw || '')).digest('hex');

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
  let legacy = false;
  let retired = false;
  if (!verifySignature(license, options.publicKeyPem || PUBLIC_KEY_PEM)) {
    // Firmada con la llave retirada: vale solo si el proveedor la emitió de verdad.
    if (!verifySignature(license, options.legacyPublicKeyPem || LEGACY_PUBLIC_KEY_PEM)) {
      return { valid: false, code: 'INVALID_SIGNATURE', reason: 'Licencia inválida o alterada', graceEligible: false };
    }
    legacy = true;
    // Fuera de la lista blanca: se marca al final, después de revisar producto y
    // vencimiento, para que el aviso de 30 días nunca habilite más que la licencia.
    retired = !(options.legacyAllowlist || LEGACY_ALLOWED_SHA256).has(licenseFingerprint(license));
  }
  const retiredResult = (extra) => ({
    valid: false, code: 'LEGACY_KEY_RETIRED', legacyNoticeEligible: true, graceEligible: false,
    reason: 'Esta licencia usa una firma que VELO retiró. Solicita tu licencia nueva enviando el ID de máquina.',
    business: license.business, products: license.products, ...extra,
  });

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
    if (retired) return retiredResult({ expiry: license.expiry, daysLeft, requiredProduct: product });
    return {
      valid: true, expiry: license.expiry, daysLeft, business: license.business,
      products: license.products, requiredProduct: product, legacy,
    };
  }

  if (retired) return retiredResult({ expiry: 'Perpetua', requiredProduct: product });
  return {
    valid: true, expiry: 'Perpetua', business: license.business,
    products: license.products, requiredProduct: product, legacy,
  };
}

// Una licencia ya instalada con la llave retirada y fuera de la lista blanca sigue
// funcionando 30 días desde que esta versión la detecta, con aviso. No aplica al
// activar: una licencia así nunca se puede instalar de nuevo.
function legacyNoticeDaysLeft(dataDir, now = new Date()) {
  const noticePath = path.join(dataDir, LEGACY_NOTICE_FILE);
  try {
    if (!fs.existsSync(noticePath)) fs.writeFileSync(noticePath, now.toISOString());
    const firstSeen = new Date(fs.readFileSync(noticePath, 'utf8').trim());
    if (!Number.isFinite(firstSeen.getTime())) return 0;
    const days = Math.floor((now.getTime() - firstSeen.getTime()) / 86400000);
    return Math.max(0, LEGACY_NOTICE_DAYS - days);
  } catch {
    return 0;
  }
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
  let verification   = verifyLicense(license, machineId, requiredProduct, options);
  let legacyNotice = false;
  let legacyDaysLeft = 0;
  if (verification.code === 'LEGACY_KEY_RETIRED') {
    legacyDaysLeft = legacyNoticeDaysLeft(dataDir, options.now);
    legacyNotice = legacyDaysLeft > 0;
    if (legacyNotice) {
      verification = {
        ...verification, valid: true,
        reason: `Licencia por renovar: quedan ${legacyDaysLeft} día${legacyDaysLeft === 1 ? '' : 's'}. Solicita tu licencia nueva a VELO.`,
      };
    }
  }

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
    warningSoon: verification.valid && (legacyNotice || (verification.daysLeft || 9999) <= WARN_DAYS),
    legacyNotice,
    legacyDaysLeft,
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
  LEGACY_PUBLIC_KEY_PEM,
  LEGACY_NOTICE_DAYS,
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
