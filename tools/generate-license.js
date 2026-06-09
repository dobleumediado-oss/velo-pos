#!/usr/bin/env node
// ══════════════════════════════════════════════
// tools/generate-license.js — CLI del vendedor
//
// NUNCA incluir en el instalador del cliente.
// Ejecutar localmente: node tools/generate-license.js
//
// Requiere: VELO_PRIVATE_KEY_PATH en el entorno
// o un archivo vendor-private.pem en esta carpeta.
// ══════════════════════════════════════════════

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const LICENSE_VERSION = '2';

// ── Cargar clave privada ──────────────────────
function loadPrivateKey() {
  const envPath = process.env.VELO_PRIVATE_KEY_PATH;
  const localPath = path.join(__dirname, 'vendor-private.pem');

  const keyPath = envPath || localPath;
  if (!fs.existsSync(keyPath)) {
    console.error(`\n❌ Clave privada no encontrada en: ${keyPath}`);
    console.error('   Generar con: node tools/generate-license.js --keygen\n');
    process.exit(1);
  }
  return fs.readFileSync(keyPath, 'utf8');
}

// ── Generar par de claves (solo correr una vez) ──
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const privPath = path.join(__dirname, 'vendor-private.pem');
  const pubPath  = path.join(__dirname, 'vendor-public.pem');
  fs.writeFileSync(privPath, privateKey);
  fs.writeFileSync(pubPath,  publicKey);
  console.log(`\n✅ Par de claves generado:`);
  console.log(`   Privada: ${privPath}  ← guardar en lugar seguro, NUNCA subir a git`);
  console.log(`   Pública: ${pubPath}   ← copiar el contenido a license.js del cliente\n`);
  console.log('CLAVE PÚBLICA (pegar en license.js):');
  console.log(publicKey);
}

// ── Generar licencia ──────────────────────────
function generateLicense(machineId, business, expiryDate) {
  const keyPem     = loadPrivateKey();
  const privateKey = crypto.createPrivateKey(keyPem);
  const payload    = `${LICENSE_VERSION}|${machineId}|${business}|${expiryDate}`;
  const signature  = crypto.sign('SHA256', Buffer.from(payload), privateKey);
  const sigB64     = signature.toString('base64');
  return `${payload}|${sigB64}`;
}

// ── CLI ───────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--keygen')) {
  generateKeyPair();
  process.exit(0);
}

// Uso: node generate-license.js <MACHINE_ID> <"Nombre Negocio"> <YYYY-MM-DD|PERPETUAL>
if (args.length < 3) {
  console.log('\nUso:');
  console.log('  node tools/generate-license.js <MACHINE_ID> <"Nombre Negocio"> <YYYY-MM-DD|PERPETUAL>');
  console.log('  node tools/generate-license.js --keygen   (generar par de claves)\n');
  console.log('Ejemplo:');
  console.log('  node tools/generate-license.js A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6 "Auto Parts La Vega" 2026-12-31\n');
  process.exit(1);
}

const [machineId, business, expiry] = args;

// Validar
if (!/^[A-F0-9]{32}$/.test(machineId) && machineId !== 'UNIVERSAL') {
  console.error('\n❌ MACHINE_ID debe ser 32 caracteres hexadecimales en mayúsculas\n');
  process.exit(1);
}
if (expiry !== 'PERPETUAL' && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
  console.error('\n❌ Fecha debe ser YYYY-MM-DD o PERPETUAL\n');
  process.exit(1);
}

const licenseKey = generateLicense(machineId, business, expiry);

console.log('\n✅ Licencia generada:');
console.log('─'.repeat(80));
console.log(licenseKey);
console.log('─'.repeat(80));
console.log(`\nNegocio:  ${business}`);
console.log(`Máquina:  ${machineId}`);
console.log(`Vence:    ${expiry}\n`);
