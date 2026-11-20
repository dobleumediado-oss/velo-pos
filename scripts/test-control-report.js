'use strict';

// Reporte diario a VELO Control (Fase D): qué se envía (nunca clientes ni montos),
// qué no envía una terminal, y cuándo se instala una licencia renovada.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = require('../database');
const { addDaysStr, todayStr } = require('../lib/dates');
const { parseLicense } = require('../license');
const { buildReport, sendReport, shouldInstall } = require('../lib/control-report');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-control-report-'));
const db = repo.initDB(directory);
require('../versioning').initVersioning(db, directory);

async function test() {
  const { settingsRepo, ecfRepo, salesRepo } = repo;
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const buyer = repo.customersRepo.create({ name: 'COMPRADOR DE PRUEBA', rnc: '101000001' });
  const product = repo.productsRepo.create({ code: 'RPT-1', name: 'ARTÍCULO DE PRUEBA', cost: 50, price: 118, stock: 10, taxable: 1, tax_pct: 18 });
  for (const [key, value] of Object.entries({
    fiscal_enabled: '1', ecf_enabled: '1', ecf_environment: 'production', ecf_income_type: '01',
    biz_rnc: '101000002', biz_name: 'EMISOR DE PRUEBA', biz_addr: 'Dirección de prueba',
  })) settingsRepo.set(key, value);
  const expiry = addDaysStr(todayStr(), 90);
  ecfRepo.addRange({ from: 'E310000000001', to: 'E310000000100', expiry, environment: 'production' });
  const sale = salesRepo.create({
    customer: { id: buyer }, user: admin, type: 'factura', payment: { ncfType: 'E31', method: 'efectivo', disc: 0 },
    items: [{ product_id: product, product_code: 'RPT-1', qty: 1, unit_price: 118, taxable: 1, tax_pct: 18 }],
  });
  db.prepare("UPDATE ecf_documents SET status='Aceptado' WHERE sale_id=?").run(sale.saleId);
  db.prepare('UPDATE sales SET fiscal_issued_at=? WHERE id=?').run(todayStr(), sale.saleId);

  const license = '3|' + 'A'.repeat(32) + '|Negocio|2026-12-31|velo_pos|firma';
  const report = buildReport({ db, licenseKey: license, machineId: 'A'.repeat(32), appVersion: '1.66.6', mode: 'server', today: todayStr() });
  assert.equal(report.ecf.monthAccepted, 1);
  assert.deepEqual(report.ecf.ranges, [{ type: 'E31', environment: 'production', remaining: 99, expiresOn: expiry }]);
  assert.equal(report.lastSaleOn, todayStr());
  // Solo números: ni clientes, ni montos, ni RNC del comprador.
  const sent = JSON.stringify(report);
  assert.doesNotMatch(sent, /COMPRADOR|101000001|118|ARTÍCULO/);
  // Un rango desactivado no se reporta.
  ecfRepo.deactivateRange(db.prepare('SELECT id FROM ecf_sequences').get().id);
  assert.deepEqual(buildReport({ db, licenseKey: license, machineId: 'A'.repeat(32), mode: 'local', today: todayStr() }).ecf.ranges, []);
  // Una terminal no tiene la base del negocio: no manda uso de e-CF.
  const terminal = buildReport({ db, licenseKey: license, machineId: 'A'.repeat(32), mode: 'client', today: todayStr() });
  assert.equal(terminal.ecf, undefined);
  assert.equal(terminal.lastSaleOn, undefined);

  // Envío: la respuesta de Cloud trae (o no) la licencia renovada; sin red no falla.
  let request;
  const ok = await sendReport({ apiUrl: 'https://api.ejemplo.test/', report, fetchImpl: async (url, init) => {
    request = { url, init };
    return { ok: true, json: async () => ({ ok: true, license: 'NUEVA', renewedUntil: '2027-01-15' }) };
  } });
  assert.equal(request.url, 'https://api.ejemplo.test/v1/desktop/heartbeat');
  assert.equal(JSON.parse(request.init.body).machineId, 'A'.repeat(32));
  assert.deepEqual(ok, { ok: true, license: 'NUEVA', renewedUntil: '2027-01-15' });
  assert.deepEqual(await sendReport({ apiUrl: 'x', report, fetchImpl: async () => ({ ok: false, status: 403 }) }), { ok: false, status: 403 });
  assert.equal((await sendReport({ apiUrl: 'x', report, fetchImpl: async () => { throw new Error('sin red'); } })).offline, true);

  // Solo se instala una licencia que vence después de la actual; nunca sobre una perpetua.
  const renewed = '3|' + 'A'.repeat(32) + '|Negocio|2027-01-15|velo_pos|firma';
  assert.equal(shouldInstall('2026-12-31', renewed, parseLicense), true);
  assert.equal(shouldInstall('2027-02-01', renewed, parseLicense), false);
  assert.equal(shouldInstall('Perpetua', renewed, parseLicense), false);
  assert.equal(shouldInstall(undefined, renewed, parseLicense), true);
  assert.equal(shouldInstall('2026-12-31', 'basura', parseLicense), false);
  console.log('✓ Reporte a VELO Control: uso de e-CF sin datos de clientes, terminales sin base, envío sin red y licencia renovada solo si mejora.');
}

test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
