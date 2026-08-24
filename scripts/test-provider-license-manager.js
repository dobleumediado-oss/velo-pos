'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLicense, verifyLicense } = require('../license');
const {
  normalizeRequest,
  getProviderStatus,
  createProviderLicense,
  listProviderLicenses,
  markProviderLicenseCancelled,
  securePrivateKey,
} = require('../tools/license-provider');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-provider-license-'));
try {
  const privateKeyPath = path.join(tempDir, 'private.pem');
  const historyPath = path.join(tempDir, 'history.json');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
  const options = { privateKeyPath, historyPath, expectedPublicKeyPem: publicPem };

  const normalized = normalizeRequest({
    machineId: 'a1b2-c3d4 e5f6a7b8c9d0e1f2a3b4c5d6',
    business: ' Castillo Tech ',
    expiry: 'perpetual',
    products: ['velo_tech_pos', 'velo_pos'],
  });
  assert.strictEqual(normalized.machineId, 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6');
  assert.deepStrictEqual(normalized.products, ['velo_pos', 'velo_tech_pos']);

  const status = getProviderStatus(options);
  assert.strictEqual(status.available, true);
  assert.strictEqual(status.keyMatchesApplication, true);
  if (process.platform !== 'win32') {
    fs.chmodSync(privateKeyPath, 0o644);
    assert.strictEqual(getProviderStatus(options).permissionsSecure, false);
    assert.strictEqual(securePrivateKey(options).permissionsSecure, true);
  }

  const generated = createProviderLicense(normalized, options);
  const parsed = parseLicense(generated.licenseKey);
  assert.strictEqual(verifyLicense(parsed, normalized.machineId, 'velo_pos', { publicKeyPem: publicPem }).valid, true);
  assert.strictEqual(verifyLicense(parsed, normalized.machineId, 'velo_tech_pos', { publicKeyPem: publicPem }).valid, true);
  assert.strictEqual(listProviderLicenses(options).length, 1);

  const cancelled = markProviderLicenseCancelled(generated.id, options);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(listProviderLicenses(options)[0].status, 'cancelled');

  const otherPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const otherPublic = otherPair.publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(
    () => createProviderLicense(normalized, { ...options, expectedPublicKeyPem: otherPublic }),
    /no corresponde/
  );
  assert.strictEqual(listProviderLicenses(options).length, 1, 'no guarda licencias con llave incompatible');

  assert.throws(() => normalizeRequest({ ...normalized, machineId: 'UNIVERSAL' }), /32 caracteres/);
  assert.strictEqual(normalizeRequest({ ...normalized, machineId: 'UNIVERSAL' }, { allowUniversal: true }).machineId, 'UNIVERSAL');
  assert.throws(() => normalizeRequest({ ...normalized, products: ['otro'] }), /producto desconocido/);
  console.log('✓ Administrador privado de licencias: validación, firma, historial y aislamiento correctos.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
