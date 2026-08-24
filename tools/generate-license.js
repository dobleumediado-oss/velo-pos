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
const { PUBLIC_KEY_PEM } = require('../license');
const {
  resolvePrivateKeyPath,
  normalizeRequest,
  createProviderLicense,
} = require('./license-provider');

// ── Cargar clave privada ──────────────────────
function loadPrivateKey() {
  const keyPath = resolvePrivateKeyPath();
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
  if (fs.existsSync(privPath) || fs.existsSync(pubPath)) {
    throw new Error('Ya existe una llave del proveedor. No se reemplazó ningún archivo');
  }
  // Nunca reemplazar silenciosamente la identidad criptográfica que ya usan
  // las aplicaciones publicadas.
  fs.writeFileSync(privPath, privateKey, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(pubPath,  publicKey,  { flag: 'wx', mode: 0o644 });
  console.log(`\n✅ Par de claves generado:`);
  console.log(`   Privada: ${privPath}  ← guardar en lugar seguro, NUNCA subir a git`);
  console.log(`   Pública: ${pubPath}   ← copiar el contenido a license.js del cliente\n`);
  console.log('CLAVE PÚBLICA (pegar en license.js):');
  console.log(publicKey);
}

// ── Generar licencia ──────────────────────────
function generateLicense(machineId, business, expiryDate, products) {
  // Mantiene la CLI y el administrador visual sobre una sola lógica validada.
  loadPrivateKey();
  return createProviderLicense(
    { machineId, business, expiry: expiryDate, products },
    { privateKeyPath: resolvePrivateKeyPath(), expectedPublicKeyPem: PUBLIC_KEY_PEM, allowUniversal: true }
  ).licenseKey;
}

// ── CLI ───────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--keygen')) {
  generateKeyPair();
  process.exit(0);
}

// Uso: node generate-license.js <MACHINE_ID> <"Negocio"> <EXPIRY> <PRODUCTOS>
if (args.length < 4) {
  console.log('\nUso:');
  console.log('  node tools/generate-license.js <MACHINE_ID> <"Nombre Negocio"> <YYYY-MM-DD|PERPETUAL> <PRODUCTOS>');
  console.log('  node tools/generate-license.js --keygen   (generar par de claves)\n');
  console.log('Productos: velo_pos | velo_tech_pos | velo_pos,velo_tech_pos');
  console.log('Ejemplo:');
  console.log('  node tools/generate-license.js A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6 "Castillo Tech" 2027-12-31 velo_tech_pos\n');
  process.exit(1);
}

const [machineId, business, expiry, productsArg] = args;

let normalized;
try {
  normalized = normalizeRequest(
    { machineId, business, expiry, products: productsArg },
    { allowUniversal: true }
  );
} catch (error) {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
}
const products = normalized.products;

const licenseKey = generateLicense(normalized.machineId, normalized.business, normalized.expiry, products);

console.log('\n✅ Licencia generada:');
console.log('─'.repeat(80));
console.log(licenseKey);
console.log('─'.repeat(80));
console.log(`\nNegocio:  ${normalized.business}`);
console.log(`Máquina:  ${normalized.machineId}`);
console.log(`Vence:    ${normalized.expiry}`);
console.log(`Productos: ${products.join(', ')}\n`);
