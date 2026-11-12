'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const desktopEcf = require('../lib/desktop-ecf');
const { todayStr, addDaysStr } = require('../lib/dates');
const repo = require('../database');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-ecf-'));
const db = repo.initDB(directory);
require('../versioning').initVersioning(db, directory);

async function test() {
  const { authRepo, settingsRepo, ecfRepo, salesRepo, ncfRepo } = repo;
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const buyer = repo.customersRepo.create({ name: 'COMPRADOR DE PRUEBA', rnc: '101000001' });
  const product = repo.productsRepo.create({
    code: 'ECF-PRUEBA', name: 'ARTÍCULO DE PRUEBA', cost: 50, price: 118, stock: 10, taxable: 1, tax_pct: 18,
  });
  const saleData = {
    customer: { id: buyer },
    items: [{ product_id: product, product_code: 'ECF-PRUEBA', qty: 1, unit_price: 118, taxable: 1, tax_pct: 18 }],
    user: admin, type: 'factura',
  };
  const create = (ncfType, customer = saleData.customer) => salesRepo.create({
    ...saleData, customer, payment: { ncfType, method: 'efectivo', disc: 10 },
  });
  for (const [key, value] of Object.entries({
    fiscal_enabled: '1', ecf_enabled: '1', ecf_environment: 'test', ecf_income_type: '01',
    biz_rnc: '101000002', biz_name: 'EMISOR DE PRUEBA', biz_addr: 'Dirección de prueba',
    ecf_email: 'prueba@example.test', ecf_password: 'valor-ficticio', ecf_api_key: 'llave-ficticia',
  })) settingsRepo.set(key, value);

  const expiry = addDaysStr(todayStr(), 40);
  const range = { from: 'E310000000101', to: 'E310000000102', expiry, environment: 'test' };
  ecfRepo.addRange(range);
  assert.throws(() => ecfRepo.addRange(range), /solapa/);
  ecfRepo.addRange({ ...range, from: 'E320000000101', to: 'E320000000101' });
  assert.deepEqual(ecfRepo.available(), ['E31', 'E32']);
  assert.throws(() => create('E31', { id: 1 }), /comprador/);
  const e31 = create('E31');
  const e32 = create('E32', { id: 1 });
  assert.equal(e31.ncf, 'E310000000101');
  assert.equal(e32.ncf, 'E320000000101');
  assert.equal(create('E31').ncf, 'E310000000102');
  assert.throws(() => create('E31'), /rango vigente/);
  assert.equal(ncfRepo.getLog({ status: 'emitido' }).length, 0);
  const snapshot = JSON.parse(db.prepare('SELECT payload FROM ecf_documents WHERE sale_id=?').get(e31.saleId).payload).ECF;
  assert.equal(snapshot.Encabezado.IdDoc.eNCF, e31.ncf);
  assert.equal(snapshot.Encabezado.IdDoc.FechaVencimientoSecuencia, expiry.split('-').reverse().join('-'));
  assert.equal(snapshot.DetallesItems.Item[0].DescuentoMonto, 10);
  assert.equal(snapshot.Encabezado.Totales.MontoGravadoI1, 90);
  assert.equal(snapshot.Encabezado.Totales.TotalITBIS, 16.2);
  assert.equal(snapshot.Encabezado.Totales.MontoTotal, 106.2);

  const handlers = new Map();
  let posts = 0;
  let e32AuthRejected = false;
  const signedDate = '12-11-2026 03:15:00';
  let lookedUp = '';
  const statuses = new Map([[e31.ncf, 'Aceptado'], [e32.ncf, 'Rechazado']]);
  const mockedFetch = async (url, options) => {
    assert.match(url, /^https:\/\/ecf\.api\.mseller\.app\/(TesteCF|eCF)\//);
    if (url.endsWith('/authentication')) return { ok: true, json: async () => ({ idToken: 'token-ficticio' }) };
    assert.equal(options.headers['X-API-KEY'], 'llave-ficticia');
    if (options.method === 'POST') {
      posts++;
      const ncf = JSON.parse(options.body).ECF.Encabezado.IdDoc.eNCF;
      assert.ok(statuses.has(ncf));
      if (ncf === e31.ncf) throw new Error('Conexión interrumpida');
      if (ncf === e32.ncf && !e32AuthRejected) {
        e32AuthRejected = true;
        return { ok: false, status: 401 };
      }
      return { ok: true, json: async () => ({ ecf: ncf }) };
    }
    lookedUp = new URL(url).searchParams.get('ecf');
    return { ok: true, json: async () => ({
      ncf: lookedUp, status: statuses.get(lookedUp), securityCode: 'TEST12', signedDate,
      qr_url: 'https://ecf.dgii.gov.do/testecf/consultatimbre',
    }) };
  };
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  vm.runInNewContext(main.slice(main.indexOf('function ecfAdmin('), main.indexOf('// ── Historial de e-CF')), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    require: () => repo, authRepo, settingsRepo, ecfRepo, desktopEcf, fetch: mockedFetch, AbortSignal,
  });
  const call = (action, saleId) => handlers.get('ecf:' + action)(null, { saleId, requestUserId: admin.id });
  const attempts = await Promise.all([call('emit', e31.saleId), call('emit', e31.saleId)]);
  assert.equal(attempts.filter(result => !result.ok).length, 2);
  assert.equal(posts, 1);
  assert.equal(salesRepo.getById(e31.saleId).ecf_status, 'Por confirmar');
  assert.equal((await call('getStatus', e31.saleId)).status, 'Aceptado');
  assert.equal(lookedUp, e31.ncf);
  assert.equal(salesRepo.getById(e31.saleId).ecf_security_code, 'TEST12');
  assert.equal((await call('emit', e32.saleId)).ok, false);
  assert.equal(salesRepo.getById(e32.saleId).ecf_status, 'Reservado');
  assert.equal((await call('emit', e32.saleId)).status, 'Enviado');
  assert.equal((await call('getStatus', e32.saleId)).status, 'Rechazado');
  assert.equal((await call('emit', e32.saleId)).ok, false);
  assert.equal(posts, 3);
  assert.equal(ncfRepo.getLog({ status: 'emitido' }).length, 0);
  assert.equal(salesRepo.getById(e31.saleId).fiscal_issued_at, null);

  const printScript = fs.readFileSync(path.join(__dirname, '..', 'src/js/print.js'), 'utf8');
  const printContext = vm.createContext({
    qrcode: require('qrcode-generator'), _escHtml: value => String(value), fmt: value => String(value),
    sale: salesRepo.getById(e31.saleId),
  });
  const printFn = printScript.slice(printScript.indexOf('function _printEcfRepresentation('), printScript.indexOf('function printReceipt('));
  const html = vm.runInContext(printFn + '\n_printEcfRepresentation(sale);', printContext);
  assert.match(html, /PRUEBA · SIN VALOR FISCAL/);
  assert.match(html, /<svg/);
  assert.match(html, /TEST12/);
  assert.match(html, /03:15:00/);
  printContext.sale = salesRepo.getById(e32.saleId);
  assert.equal(vm.runInContext('_printEcfRepresentation(sale)', printContext), '');

  settingsRepo.set('ecf_environment', 'production');
  ecfRepo.addRange({ from: 'E320000001001', to: 'E320000001001', expiry, environment: 'production' });
  const production = create('E32', { id: 1 });
  statuses.set(production.ncf, 'Aceptado Condicional');
  assert.equal((await call('emit', production.saleId)).status, 'Enviado');
  assert.equal((await call('getStatus', production.saleId)).status, 'Aceptado Condicional');
  assert.equal(salesRepo.getById(production.saleId).fiscal_issued_at, todayStr());
  assert.equal(ncfRepo.getLog({ status: 'emitido' }).length, 0);
  assert.deepEqual(ncfRepo.getLog({ status: 'emitido', copies: true }), [{
    id: production.saleId, ncf: production.ncf, fiscalDate: todayStr(),
  }]);
  assert.throws(() => desktopEcf.providerResult({ ncf: e32.ncf }, e31.ncf), /mismo e-NCF/);
  assert.throws(() => desktopEcf.providerResult({ ncf: e31.ncf, rnc: '101000003' }, e31.ncf, '101000002'), /otro emisor/);
  console.log('✓ E31/E32: reserva transaccional, descuentos, límites, envío único, consulta, rechazo y aislamiento fiscal de TesteCF.');
}

test().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
