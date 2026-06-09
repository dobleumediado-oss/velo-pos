// ══════════════════════════════════════════════
// license.js — Sistema de Licencia Offline
//   · Licencia por máquina (sin servidor)
//   · Verificación con ECDSA (clave pública embebida)
//   · El vendedor firma con clave privada (NUNCA en este archivo)
//   · Período de gracia de 30 días sin licencia
//   · Bloqueo suave: avisa, no cierra (configurable)
// ══════════════════════════════════════════════

const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const LICENSE_VERSION = '2';
const GRACE_DAYS      = 30;
const WARN_DAYS       = 7;

// ── Clave pública ECDSA (P-256) ───────────────
// SOLO para verificar. La clave privada nunca sale del servidor del vendedor.
// Generada con: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
// REEMPLAZAR con tu clave pública real antes de producción.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYi32UkSnHgjHcDvulKyc0thmkFqB
EGTRTJDMlSfzk/sRF9FFl0YK40Ndw8drzAW8QNvUT+1+T1b+PPK4HGX1nw==
-----END PUBLIC KEY-----`;

// ── Generar ID único de máquina ───────────────
function getMachineId() {
  const cpus     = os.cpus();
  const hostname = os.hostname();
  const platform = os.platform();
  const arch     = os.arch();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  const raw = `${hostname}::${platform}::${arch}::${cpuModel}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32).toUpperCase();
}

// ── Parsear licencia ──────────────────────────
// Formato v2: VERSION|MACHINE_ID|BUSINESS|EXPIRY|BASE64_SIGNATURE
function parseLicense(content) {
  try {
    const parts = content.trim().split('|');
    if (parts.length !== 5) return null;
    const [version, machineId, business, expiry, signature] = parts;
    return { version, machineId, business, expiry, signature, raw: content.trim() };
  } catch {
    return null;
  }
}

// ── Verificar firma ECDSA o hash v1 ──────────
function verifySignature(license) {
  try {
    // v1: hash SHA-256 simple (generado desde el Panel Dev)
    if (license.version === '1') {
      const secret  = 'velo-pos-2026-rd';
      const data    = `1|${license.machineId}|${license.business}|${license.expiry}|${secret}`;
      const hash    = crypto.createHash('sha256').update(data).digest('hex')
                      .slice(0, 16).toUpperCase();
      return license.signature === hash;
    }
    // v2: firma ECDSA P-256
    const payload = `${license.version}|${license.machineId}|${license.business}|${license.expiry}`;
    const sigBuf  = Buffer.from(license.signature, 'base64');
    const pubKey  = crypto.createPublicKey(PUBLIC_KEY_PEM);
    return crypto.verify('SHA256', Buffer.from(payload), pubKey, sigBuf);
  } catch {
    return false;
  }
}

// ── Verificar licencia ────────────────────────
function verifyLicense(license, machineId) {
  if (!license) return { valid: false, reason: 'Sin licencia' };

  // Aceptar v1 (hash simple) y v2 (ECDSA)
  if (license.version !== LICENSE_VERSION && license.version !== '1') {
    return { valid: false, reason: 'Formato de licencia obsoleto — solicita una nueva licencia' };
  }

  if (license.machineId !== machineId && license.machineId !== 'UNIVERSAL') {
    return { valid: false, reason: 'Licencia de otra máquina' };
  }

  if (!verifySignature(license)) {
    return { valid: false, reason: 'Licencia inválida o alterada' };
  }

  if (license.expiry !== 'PERPETUAL') {
    const today  = new Date().toISOString().split('T')[0];
    if (today > license.expiry) {
      return { valid: false, reason: 'Licencia vencida', expiry: license.expiry };
    }
    const daysLeft = Math.ceil((new Date(license.expiry) - new Date()) / 86400000);
    return { valid: true, expiry: license.expiry, daysLeft, business: license.business };
  }

  return { valid: true, expiry: 'Perpetua', business: license.business };
}

// ── Leer licencia desde archivo ───────────────
function readLicenseFile(dataDir) {
  const licensePath = path.join(dataDir, 'license.key');
  if (!fs.existsSync(licensePath)) return null;
  try {
    return parseLicense(fs.readFileSync(licensePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Estado completo de la licencia ───────────
function getLicenseStatus(dataDir) {
  const machineId    = getMachineId();
  const license      = readLicenseFile(dataDir);
  const verification = verifyLicense(license, machineId);

  let graceDaysLeft = 0;
  try {
    const installedPath = path.join(dataDir, '.installed');
    if (!fs.existsSync(installedPath)) {
      fs.writeFileSync(installedPath, new Date().toISOString());
    }
    const installedAt = new Date(fs.readFileSync(installedPath, 'utf8').trim());
    const daysSince   = Math.floor((Date.now() - installedAt) / 86400000);
    graceDaysLeft     = Math.max(0, GRACE_DAYS - daysSince);
  } catch {}

  const inGrace = !verification.valid && graceDaysLeft > 0;

  return {
    machineId,
    licensed:     verification.valid,
    inGrace,
    graceDaysLeft,
    reason:       verification.reason,
    expiry:       verification.expiry,
    daysLeft:     verification.daysLeft,
    business:     verification.business || '',
    // Activar bloqueo cuando inGrace=false y licensed=false:
    blocked:      !verification.valid && !inGrace,
    warningSoon:  verification.valid && (verification.daysLeft || 9999) <= WARN_DAYS,
    licenseKey:   license?.raw || '',
  };
}

// ── Activar licencia ──────────────────────────
function activateLicense(dataDir, licenseKey) {
  const machineId = getMachineId();
  const parsed    = parseLicense(licenseKey.trim());

  if (!parsed) return { ok: false, error: 'Formato de licencia inválido' };

  const result = verifyLicense(parsed, machineId);
  if (!result.valid) return { ok: false, error: result.reason };

  fs.writeFileSync(path.join(dataDir, 'license.key'), licenseKey.trim());
  return { ok: true, ...result };
}

// ── generateLicenseKey ────────────────────────
// Esta función NO debe estar en el código del cliente.
// Aquí como placeholder — moverla a una herramienta CLI separada del vendedor.
function generateLicenseKey() {
  throw new Error(
    'generateLicenseKey() debe ejecutarse en la herramienta CLI del vendedor, ' +
    'nunca en el cliente instalado. Ver /tools/generate-license.js'
  );
}

module.exports = {
  getMachineId,
  getLicenseStatus,
  activateLicense,
  generateLicenseKey,
};
