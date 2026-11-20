'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseLicense,
  normalizeLicenseKeyInput,
  verifyLicense,
  activateLicense,
  getLicenseStatus,
  withDevelopmentBypass,
} = require('../license');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const machineId = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';

function sign(parts) {
  const payload = parts.join('|');
  const signature = crypto.sign('SHA256', Buffer.from(payload), privateKey).toString('base64');
  return `${payload}|${signature}`;
}

const suiteKey = sign(['3', machineId, 'Castillo Tech', 'PERPETUAL', 'velo_pos,velo_tech_pos']);
const techKey = sign(['3', machineId, 'Castillo Tech', 'PERPETUAL', 'velo_tech_pos']);
const legacyPosKey = sign(['2', machineId, 'Cliente VELO POS', 'PERPETUAL']);
const verifyOptions = { publicKeyPem };

test('v3 parsea uno o varios productos canónicos', () => {
  assert.deepStrictEqual(parseLicense(suiteKey).products, ['velo_pos', 'velo_tech_pos']);
  assert.strictEqual(parseLicense(sign(['3', machineId, 'X', 'PERPETUAL', 'velo_tech_pos,velo_pos'])), null);
});

test('una licencia de suite habilita ambos productos', () => {
  const license = parseLicense(suiteKey);
  assert.strictEqual(verifyLicense(license, machineId, 'velo_pos', verifyOptions).valid, true);
  assert.strictEqual(verifyLicense(license, machineId, 'velo_tech_pos', verifyOptions).valid, true);
});

test('una licencia TECH no habilita VELO POS', () => {
  const license = parseLicense(techKey);
  assert.strictEqual(verifyLicense(license, machineId, 'velo_tech_pos', verifyOptions).valid, true);
  const wrong = verifyLicense(license, machineId, 'velo_pos', verifyOptions);
  assert.strictEqual(wrong.valid, false);
  assert.strictEqual(wrong.code, 'PRODUCT_NOT_LICENSED');
  assert.strictEqual(wrong.graceEligible, false);
});

test('v2 ECDSA sigue habilitando solo VELO POS', () => {
  const license = parseLicense(legacyPosKey);
  assert.strictEqual(verifyLicense(license, machineId, 'velo_pos', verifyOptions).valid, true);
  assert.strictEqual(verifyLicense(license, machineId, 'velo_tech_pos', verifyOptions).code, 'PRODUCT_NOT_LICENSED');
});

test('v1 insegura se rechaza aunque tenga formato válido', () => {
  const legacy = parseLicense(`1|${machineId}|Negocio|PERPETUAL|DEADBEEFDEADBEEF`);
  assert.strictEqual(verifyLicense(legacy, machineId, 'velo_pos', verifyOptions).code, 'INSECURE_LEGACY_LICENSE');
});

test('alterar productos invalida la firma', () => {
  const tampered = parseLicense(suiteKey.replace('velo_pos,velo_tech_pos', 'velo_tech_pos'));
  assert.strictEqual(verifyLicense(tampered, machineId, 'velo_tech_pos', verifyOptions).code, 'INVALID_SIGNATURE');
});

test('la activación persiste solo una clave del producto correcto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-'));
  try {
    const rejected = activateLicense(dir, techKey, 'velo_pos', { ...verifyOptions, machineId });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'license.key')), false);

    const accepted = activateLicense(dir, suiteKey, 'velo_pos', { ...verifyOptions, machineId });
    assert.strictEqual(accepted.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'license.key'), 'utf8'), suiteKey);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('la activación conserva el caso y los espacios de la licencia firmada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-case-'));
  try {
    const cut = suiteKey.indexOf('|', suiteKey.indexOf('|') + 1) + 1;
    const wrapped = `${suiteKey.slice(0, cut)}\r\n${suiteKey.slice(cut)}`;
    assert.strictEqual(normalizeLicenseKeyInput(wrapped), suiteKey);
    assert.ok(normalizeLicenseKeyInput(wrapped).includes('|Castillo Tech|'));

    const accepted = activateLicense(dir, wrapped, 'velo_pos', { ...verifyOptions, machineId });
    assert.strictEqual(accepted.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'license.key'), 'utf8'), suiteKey);

    const uppercased = activateLicense(dir, suiteKey.toUpperCase(), 'velo_pos', {
      ...verifyOptions,
      machineId,
    });
    assert.strictEqual(uppercased.ok, false,
      'convertir la firma Base64 o el producto a mayúsculas debe invalidar la clave');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('los campos visuales de activación excluyen la conversión a mayúsculas', () => {
  const root = path.join(__dirname, '..');
  const appSource = fs.readFileSync(path.join(root, 'src/js/app.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(root, 'src/js/config.js'), 'utf8');
  assert.match(appSource, /class: 'inp no-uppercase'[\s\S]*?'data-uppercase': 'off'/);
  assert.match(configSource, /class="inp no-uppercase" id="lic-key"[\s\S]*?data-uppercase="off"/);
  assert.strictEqual(configSource.includes("replace(/[\\r\\n\\s]+/g,'')"), false,
    'pegar una licencia no debe borrar espacios firmados del nombre del negocio');
});

test('producto equivocado queda bloqueado sin período de gracia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-'));
  try {
    fs.writeFileSync(path.join(dir, 'license.key'), techKey);
    const status = getLicenseStatus(dir, 'velo_pos', { ...verifyOptions, machineId });
    assert.strictEqual(status.blocked, true);
    assert.strictEqual(status.inGrace, false);
    assert.strictEqual(status.code, 'PRODUCT_NOT_LICENSED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el cliente no contiene la llave privada y la consola del proveedor exige desarrollo explícito', () => {
  const root = path.join(__dirname, '..');
  for (const rel of ['main.js', 'preload.js', 'src/js/superadmin.js']) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.strictEqual(source.includes('vendor-private.pem'), false, rel);
    assert.strictEqual(source.includes('crypto.sign('), false, rel);
  }
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const providerGuard = main.indexOf('if (!app.isPackaged && RUNTIME.dev && !RUNTIME.headless)');
  const providerHandler = main.indexOf("ipcMain.handle('providerLicenses:create'");
  assert.ok(providerGuard >= 0 && providerHandler > providerGuard, 'handler de proveedor fuera de guardia dev');
  assert.ok(main.includes("additionalArguments: (!app.isPackaged && RUNTIME.dev)"));
  assert.ok(preload.includes("process.argv.includes('--velo-provider-tools')"));
  const packagedFiles = require(path.join(root, 'package.json')).build.files;
  assert.strictEqual(packagedFiles.some(item => String(item).startsWith('tools/')), false);
});

test('el bypass de desarrollo es explícito y nunca aplica al instalador', () => {
  const blocked = { licensed: false, blocked: true, reason: 'Licencia inválida' };
  assert.strictEqual(withDevelopmentBypass(blocked, { isPackaged: false, explicitDev: false }).blocked, true);
  assert.strictEqual(withDevelopmentBypass(blocked, { isPackaged: true, explicitDev: true }).blocked, true);
  const development = withDevelopmentBypass(blocked, { isPackaged: false, explicitDev: true });
  assert.strictEqual(development.blocked, false);
  assert.strictEqual(development.licensed, true);
  assert.strictEqual(development.development, true);
});

// ── Llave retirada el 20 nov 2026 ─────────────────────────────────────────────
const retired = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const retiredPublicPem = retired.publicKey.export({ type: 'spki', format: 'pem' });
function signRetired(parts) {
  const payload = parts.join('|');
  return `${payload}|${crypto.sign('SHA256', Buffer.from(payload), retired.privateKey).toString('base64')}`;
}
const issuedLegacy = signRetired(['3', machineId, 'Cliente Legítimo', 'PERPETUAL', 'velo_pos']);
const forgedLegacy = signRetired(['3', 'UNIVERSAL', 'Copia Falsa', 'PERPETUAL', 'velo_pos,velo_tech_pos']);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const legacyOptions = { publicKeyPem, legacyPublicKeyPem: retiredPublicPem, legacyAllowlist: new Set([sha(issuedLegacy)]) };

test('una licencia emitida con la llave retirada sigue valiendo si está en la lista blanca', () => {
  const result = verifyLicense(parseLicense(issuedLegacy), machineId, 'velo_pos', legacyOptions);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.legacy, true);
  assert.strictEqual(verifyLicense(parseLicense(suiteKey), machineId, 'velo_pos', legacyOptions).legacy, false);
});

test('una licencia falsificada con la llave retirada no se puede activar', () => {
  const result = verifyLicense(parseLicense(forgedLegacy), machineId, 'velo_pos', legacyOptions);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, 'LEGACY_KEY_RETIRED');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-legacy-'));
  try {
    const activation = activateLicense(dir, forgedLegacy, 'velo_pos', { ...legacyOptions, machineId });
    assert.strictEqual(activation.ok, false);
    assert.strictEqual(activation.code, 'LEGACY_KEY_RETIRED');
    assert.strictEqual(fs.existsSync(path.join(dir, 'license.key')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la llave pública por defecto ya no acepta firmas de otra llave', () => {
  assert.strictEqual(verifyLicense(parseLicense(issuedLegacy), machineId, 'velo_pos').code, 'INVALID_SIGNATURE');
});

test('una licencia ya instalada fuera de la lista avisa 30 días y luego se bloquea', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-notice-'));
  try {
    fs.writeFileSync(path.join(dir, 'license.key'), forgedLegacy);
    const start = new Date('2026-12-01T12:00:00Z');
    const first = getLicenseStatus(dir, 'velo_pos', { ...legacyOptions, machineId, now: start });
    assert.strictEqual(first.licensed, true);
    assert.strictEqual(first.blocked, false);
    assert.strictEqual(first.legacyNotice, true);
    assert.strictEqual(first.legacyDaysLeft, 30);
    assert.strictEqual(first.warningSoon, true);
    assert.match(first.reason, /Licencia por renovar: quedan 30 días/);
    const later = getLicenseStatus(dir, 'velo_pos', { ...legacyOptions, machineId, now: new Date('2026-12-21T12:00:00Z') });
    assert.strictEqual(later.legacyDaysLeft, 10);
    assert.strictEqual(later.licensed, true);
    const expired = getLicenseStatus(dir, 'velo_pos', { ...legacyOptions, machineId, now: new Date('2026-12-31T13:00:00Z') });
    assert.strictEqual(expired.licensed, false);
    assert.strictEqual(expired.blocked, true);
    assert.strictEqual(expired.code, 'LEGACY_KEY_RETIRED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('el aviso de 30 días no habilita otro producto ni una licencia vencida', () => {
  const posOnly = signRetired(['3', machineId, 'Copia Falsa', 'PERPETUAL', 'velo_pos']);
  assert.strictEqual(verifyLicense(parseLicense(posOnly), machineId, 'velo_tech_pos', legacyOptions).code, 'PRODUCT_NOT_LICENSED');
  const expired = signRetired(['3', machineId, 'Copia Falsa', '2020-01-01', 'velo_pos']);
  assert.strictEqual(verifyLicense(parseLicense(expired), machineId, 'velo_pos', legacyOptions).code, 'EXPIRED');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-product-'));
  try {
    fs.writeFileSync(path.join(dir, 'license.key'), posOnly);
    const status = getLicenseStatus(dir, 'velo_tech_pos', { ...legacyOptions, machineId });
    assert.strictEqual(status.licensed, false);
    assert.strictEqual(status.legacyNotice, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('una licencia legítima de la lista blanca no genera aviso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-license-allowed-'));
  try {
    fs.writeFileSync(path.join(dir, 'license.key'), issuedLegacy);
    const status = getLicenseStatus(dir, 'velo_pos', { ...legacyOptions, machineId });
    assert.strictEqual(status.licensed, true);
    assert.strictEqual(status.legacyNotice, false);
    assert.strictEqual(fs.existsSync(path.join(dir, '.legacy-license-notice')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\nLicencias por producto: ${passed}/18 pruebas correctas.`);
