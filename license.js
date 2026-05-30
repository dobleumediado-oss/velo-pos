// ══════════════════════════════════════════════
// license.js — Sistema de Licencia Offline
//   · Licencia por máquina (sin servidor)
//   · Identificador de hardware (CPU + hostname)
//   · Período de gracia de 30 días sin licencia
//   · Bloqueo suave: avisa, no cierra
//   · Admin puede ver estado desde Configuración
// ══════════════════════════════════════════════

const os      = require('os');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const LICENSE_VERSION = '1';
const GRACE_DAYS      = 30;    // Días gratis antes de pedir licencia
const WARN_DAYS       = 7;     // Días antes del vencimiento que avisa

// ── Generar ID único de máquina ───────────────
// Basado en hostname + CPUs — no cambia si se copia la carpeta a otra PC
function getMachineId() {
  const cpus     = os.cpus();
  const hostname = os.hostname();
  const platform = os.platform();
  const arch     = os.arch();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';

  const raw = `${hostname}::${platform}::${arch}::${cpuModel}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32).toUpperCase();
}

// ── Leer licencia desde archivo ───────────────
function readLicenseFile(dataDir) {
  const licensePath = path.join(dataDir, 'license.key');
  if (!fs.existsSync(licensePath)) return null;
  try {
    const content = fs.readFileSync(licensePath, 'utf8').trim();
    return parseLicense(content);
  } catch {
    return null;
  }
}

// ── Parsear licencia ──────────────────────────
// Formato: VERSION|MACHINE_ID|BUSINESS|EXPIRY|HASH
function parseLicense(content) {
  try {
    const parts = content.split('|');
    if (parts.length !== 5) return null;
    const [version, machineId, business, expiry, hash] = parts;
    return { version, machineId, business, expiry, hash, raw: content };
  } catch {
    return null;
  }
}

// ── Verificar licencia ────────────────────────
function verifyLicense(license, machineId) {
  if (!license) return { valid: false, reason: 'Sin licencia' };

  // Verificar que es para esta máquina
  if (license.machineId !== machineId && license.machineId !== 'UNIVERSAL') {
    return { valid: false, reason: 'Licencia de otra máquina' };
  }

  // Verificar versión
  if (license.version !== LICENSE_VERSION) {
    return { valid: false, reason: 'Formato de licencia inválido' };
  }

  // Verificar hash (integridad)
  const expected = generateHash(license.version, license.machineId, license.business, license.expiry);
  if (expected !== license.hash) {
    return { valid: false, reason: 'Licencia alterada o inválida' };
  }

  // Verificar vencimiento
  if (license.expiry !== 'PERPETUAL') {
    const today  = new Date().toISOString().split('T')[0];
    const expiry = license.expiry;
    if (today > expiry) {
      return { valid: false, reason: 'Licencia vencida', expiry };
    }
    const daysLeft = Math.ceil((new Date(expiry) - new Date()) / 86400000);
    return { valid: true, expiry, daysLeft, business: license.business };
  }

  return { valid: true, expiry: 'Perpetua', business: license.business };
}

// ── Generar hash de licencia ──────────────────
function generateHash(version, machineId, business, expiry) {
  const secret = 'velo-pos-2026-rd';
  const data   = `${version}|${machineId}|${business}|${expiry}|${secret}`;
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16).toUpperCase();
}

// ── Generar clave de licencia (para el vendedor) ──
function generateLicenseKey(machineId, business, expiryDate) {
  const hash = generateHash(LICENSE_VERSION, machineId, business, expiryDate);
  return `${LICENSE_VERSION}|${machineId}|${business}|${expiryDate}|${hash}`;
}

// ── Estado completo de la licencia ───────────
function getLicenseStatus(dataDir) {
  const machineId   = getMachineId();
  const license     = readLicenseFile(dataDir);
  const verification = verifyLicense(license, machineId);

  // Calcular días desde instalación (período de gracia)
  let graceDaysLeft = 0;
  try {
    const licenseDir = path.join(dataDir, '.installed');
    if (!fs.existsSync(licenseDir)) {
      fs.writeFileSync(licenseDir, new Date().toISOString());
    }
    const installedAt = new Date(fs.readFileSync(licenseDir, 'utf8').trim());
    const daysSince   = Math.floor((Date.now() - installedAt) / 86400000);
    graceDaysLeft     = Math.max(0, GRACE_DAYS - daysSince);
  } catch {}

  const inGrace = !verification.valid && graceDaysLeft > 0;

  return {
    machineId,
    licensed:       verification.valid,
    inGrace,
    graceDaysLeft,
    reason:         verification.reason,
    expiry:         verification.expiry,
    daysLeft:       verification.daysLeft,
    business:       verification.business || '',
    blocked:        false,   // ← DESACTIVADO: cambiar a (!verification.valid && !inGrace) para activar bloqueo
    warningSoon:    verification.valid && (verification.daysLeft || 9999) <= WARN_DAYS,
    licenseKey:     license?.raw || '',
  };
}

// ── Activar licencia ──────────────────────────
function activateLicense(dataDir, licenseKey) {
  const machineId = getMachineId();
  const parsed    = parseLicense(licenseKey.trim());

  if (!parsed) {
    return { ok: false, error: 'Formato de licencia inválido' };
  }

  const result = verifyLicense(parsed, machineId);
  if (!result.valid) {
    return { ok: false, error: result.reason };
  }

  // Guardar licencia
  const licensePath = path.join(dataDir, 'license.key');
  fs.writeFileSync(licensePath, licenseKey.trim());

  return { ok: true, ...result };
}

module.exports = {
  getMachineId,
  getLicenseStatus,
  activateLicense,
  generateLicenseKey, // Solo para uso del vendedor/soporte
};
