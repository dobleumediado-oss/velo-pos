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
const LICENSE_VERSION = '3';
const ALLOWED_PRODUCTS = ['velo_pos', 'velo_tech_pos'];

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
function generateLicense(machineId, business, expiryDate, products) {
  const keyPem     = loadPrivateKey();
  const privateKey = crypto.createPrivateKey(keyPem);
  const payload    = `${LICENSE_VERSION}|${machineId}|${business}|${expiryDate}|${products.join(',')}`;
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

// Validar
if (!/^[A-F0-9]{32}$/.test(machineId) && machineId !== 'UNIVERSAL') {
  console.error('\n❌ MACHINE_ID debe ser 32 caracteres hexadecimales en mayúsculas\n');
  process.exit(1);
}
if (expiry !== 'PERPETUAL' && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
  console.error('\n❌ Fecha debe ser YYYY-MM-DD o PERPETUAL\n');
  process.exit(1);
}
if (String(business).includes('|') || !String(business).trim()) {
  console.error('\n❌ El nombre del negocio no puede estar vacío ni contener |\n');
  process.exit(1);
}
const requestedProducts = [...new Set(String(productsArg).split(',').map(v => v.trim().toLowerCase()).filter(Boolean))];
if (!requestedProducts.length || requestedProducts.some(p => !ALLOWED_PRODUCTS.includes(p))) {
  console.error('\n❌ Productos válidos: velo_pos, velo_tech_pos\n');
  process.exit(1);
}
const products = ALLOWED_PRODUCTS.filter(p => requestedProducts.includes(p));

const licenseKey = generateLicense(machineId, business.trim(), expiry, products);

console.log('\n✅ Licencia generada:');
console.log('─'.repeat(80));
console.log(licenseKey);
console.log('─'.repeat(80));
console.log(`\nNegocio:  ${business}`);
console.log(`Máquina:  ${machineId}`);
console.log(`Vence:    ${expiry}`);
console.log(`Productos: ${products.join(', ')}\n`);
