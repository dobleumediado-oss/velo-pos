'use strict';
// Modo consulta del corte a VELO Cloud, con los repositorios reales de Desktop sobre
// una base temporal (nunca data/velo.db):
//   · congelado, ninguna escritura pasa (ventas, clientes, inventario, caja, gastos,
//     ajustes) y el mensaje es claro; consultar e iniciar sesión siguen funcionando;
//   · el puente IPC da el mismo mensaje al operador local y a una terminal por red;
//   · la marca sobrevive el reinicio; la copia final sale con su hora de congelamiento;
//   · descongelar devuelve la escritura y deja constancia.
// Uso: node scripts/run-electron-node.js scripts/test-cloud-cutover-freeze.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const DB = require(path.join(root, 'database'));
const freezer = require(path.join(root, 'lib/cloud-cutover-freeze'));
const bridge = require(path.join(root, 'src/main/ipc-bridge'));
const { createMigrationPackage, verifyMigrationPackage } = require(path.join(root, 'lib/cloud-migration-package'));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-cutover-freeze-'));
  let db;
  const open = () => { DB.initDB(temp); db = DB.getDB(); require(path.join(root, 'versioning')).initVersioning(db, temp); return db; };
  try {
    open();
    const user = db.prepare("SELECT id,name FROM users WHERE role='admin' LIMIT 1").get();
    const product = Number(DB.productsRepo.create({ code: 'CORTE-01', name: 'Artículo de corte', cost: 100, price: 200, stock: 10, taxable: 0, tax_pct: 0 }));
    const customer = Number(DB.customersRepo.create({ name: 'Cliente ficticio de corte', phone: '8095550199' }));
    const counts = () => db.prepare(`SELECT (SELECT COUNT(*) FROM sales) sales, (SELECT COUNT(*) FROM customers) customers, (SELECT COUNT(*) FROM audit_logs) audits,
      (SELECT stock FROM products WHERE id=${product}) stock, (SELECT COUNT(*) FROM cash_sessions) sessions, (SELECT COUNT(*) FROM settings) settings`).get();
    // Sentencia preparada antes del congelamiento: la frena SQLite (query_only).
    const early = db.prepare('UPDATE products SET price=price+1 WHERE id=?');

    let audited = null;
    const frozenAt = freezer.freeze(db, temp, { frozenBy: { id: user.id, name: user.name }, businessId: 'principal',
      beforeFreeze: at => { DB.audit(user.id, user.name, 'corte_cloud_congelado', 'cloud_cutover', null, at); audited = at; } });
    assert.equal(audited, frozenAt, 'la última escritura es la auditoría del congelamiento');
    assert.equal(freezer.status().frozen, true);
    assert.ok(fs.existsSync(path.join(temp, freezer.MARKER)));
    await assert.rejects(async () => freezer.freeze(db, temp, {}), /ya está congelado/);
    const before = counts();

    // Ninguna escritura pasa, venga del repositorio que venga.
    const attempts = {
      venta: () => DB.salesRepo.create({ customer: { id: 1 }, items: [{ product_id: product, product_code: 'CORTE-01', product_name: 'Artículo de corte', unit_price: 200, unit_cost: 100, qty: 1, taxable: 0, tax_pct: 0 }],
        payment: { method: 'efectivo' }, session: null, user, type: 'factura' }),
      cliente: () => DB.customersRepo.create({ name: 'Cliente nuevo' }),
      inventario: () => DB.productsRepo.adjustStock(product, 1, 'entrada', 'Prueba', null, user.id),
      caja: () => DB.cashRepo.open({ userId: user.id, cajero: user.name, openAmount: 100, openBills: {}, terminalId: 'terminal-ficticia' }),
      ajuste: () => DB.settingsRepo.set('biz_name', 'Otro nombre'),
      sqlCrudo: () => db.exec('DELETE FROM customers'),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      let failure = null;
      try { await attempt(); } catch (error) { failure = error; }
      assert.ok(failure, `${name}: debía fallar en modo consulta`);
      assert.ok(freezer.isFrozenFailure(failure), `${name}: el error debe reconocerse como modo consulta (${failure.message})`);
    }
    assert.throws(() => early.run(product), error => freezer.isFrozenFailure(error) && error.code === 'SQLITE_READONLY');
    assert.deepEqual(counts(), before, 'nada cambió en la base');

    // Consultar sigue funcionando; la auditoría no escribe (para poder entrar y salir).
    assert.equal(DB.productsRepo.getById(product).name, 'ARTÍCULO DE CORTE');
    assert.ok(DB.customersRepo.getById(customer));
    assert.ok(Array.isArray(DB.salesRepo.getAll({})));
    assert.ok(DB.authRepo.findById(user.id));
    DB.audit(user.id, user.name, 'login', 'users', user.id, 'Login exitoso');
    assert.deepEqual(counts(), before);

    // El puente IPC traduce el error al mismo mensaje, en esta PC y para una terminal por red.
    const handlers = new Map();
    const fakeIpc = { handle: (channel, fn) => handlers.set(channel, fn) };
    bridge.installIpcInterceptor(fakeIpc, { localOnly: new Set() });
    fakeIpc.handle('test:createCustomer', async () => { try { DB.customersRepo.create({ name: 'Por red' }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
    fakeIpc.handle('test:rawWrite', async () => { early.run(product); return { ok: true }; });
    const local = await handlers.get('test:createCustomer')(null, {});
    assert.deepEqual(local, { ok: false, error: freezer.FROZEN_MESSAGE, cutoverFrozen: true });
    const remote = await bridge.dispatch('test:createCustomer', null, { terminalId: 'terminal-2' });
    assert.equal(remote.error, freezer.FROZEN_MESSAGE);
    await assert.rejects(handlers.get('test:rawWrite')(null, {}), error => error.message === freezer.FROZEN_MESSAGE && error.code === freezer.FROZEN_CODE);
    await assert.rejects(bridge.dispatch('test:rawWrite', null, {}), error => error.message === freezer.FROZEN_MESSAGE);

    // La copia final lleva la hora del congelamiento y la base tal como quedó.
    const final = await createMigrationPackage({ db, dataDir: temp, destinationDir: temp, passphrase: 'Clave-ficticia-corte-2026', businessId: 'principal', vertical: 'POS', appVersion: 'prueba',
      purpose: 'desktop-cutover-final', frozenAt: freezer.status().frozenAt });
    const verified = await verifyMigrationPackage({ filePath: final.path, passphrase: 'Clave-ficticia-corte-2026' });
    assert.equal(verified.manifest.purpose, 'desktop-cutover-final');
    assert.equal(verified.manifest.frozenAt, frozenAt);
    assert.equal(verified.manifest.tables.find(table => table.name === 'customers').rows, before.customers);

    // Reiniciar no descongela.
    db.close(); open();
    assert.deepEqual(freezer.applyIfMarked(db, temp), { frozen: true, frozenAt, frozenBy: { id: user.id, name: user.name }, damaged: false });
    assert.throws(() => DB.customersRepo.create({ name: 'Tras reinicio' }), error => freezer.isFrozenFailure(error));
    assert.equal(counts().customers, before.customers);

    // Una marca dañada no descongela.
    fs.writeFileSync(path.join(temp, freezer.MARKER), '{dañado');
    db.close(); open();
    assert.equal(freezer.applyIfMarked(db, temp).frozen, true);
    assert.throws(() => DB.customersRepo.create({ name: 'Con marca dañada' }), error => freezer.isFrozenFailure(error));
    fs.writeFileSync(path.join(temp, freezer.MARKER), JSON.stringify({ format: 1, frozenAt, frozenBy: { id: user.id, name: user.name } }));

    // Descongelar devuelve la escritura y deja constancia en un archivo y en la auditoría.
    const thawed = freezer.unfreeze(db, temp, { unfrozenBy: { id: user.id, name: user.name }, reason: 'El corte se deshizo en Cloud' });
    assert.equal(thawed.frozenAt, frozenAt);
    assert.equal(freezer.status().frozen, false);
    assert.equal(fs.existsSync(path.join(temp, freezer.MARKER)), false);
    const archived = fs.readdirSync(temp).filter(name => name.startsWith('cloud-cutover.descongelado-'));
    assert.equal(archived.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, archived[0]), 'utf8')).unfreezeReason, 'El corte se deshizo en Cloud');
    DB.audit(user.id, user.name, 'corte_cloud_descongelado', 'cloud_cutover', null, 'Prueba');
    DB.customersRepo.create({ name: 'Cliente después de descongelar' });
    assert.equal(counts().customers, before.customers + 1);
    assert.equal(counts().audits, before.audits + 1);
    assert.throws(() => freezer.unfreeze(db, temp, {}), /no está congelado/);
    assert.throws(() => freezer.updateCloud(temp, { state: 'activated' }), /no está congelado/);

    // «Pasar a VELO Cloud»: la marca guarda cómo va el corte; el estado nunca expone la clave.
    freezer.freeze(db, temp, { frozenBy: { id: user.id, name: user.name }, cloud: { state: 'sending', tenantId: 't1', tenantName: 'Empresa', passphrase: 'secreta-de-la-copia' } });
    freezer.updateCloud(temp, { state: 'converting', migrationId: 'm1' });
    assert.deepEqual(freezer.status().cloud, { state: 'converting', tenantName: 'Empresa', activatedAt: null });
    assert.ok(!JSON.stringify(freezer.status()).includes('secreta-de-la-copia'));
    assert.deepEqual(freezer.readMarker(temp).cloud, { state: 'converting', tenantId: 't1', tenantName: 'Empresa', passphrase: 'secreta-de-la-copia', migrationId: 'm1' });
    db.close(); open();
    assert.equal(freezer.applyIfMarked(db, temp).cloud.state, 'converting', 'sobrevive al reinicio');
    freezer.unfreeze(db, temp, { unfrozenBy: { id: user.id, name: user.name }, reason: 'Prueba del estado de Cloud' });
    db.close(); open();
    assert.equal(freezer.applyIfMarked(db, temp), null);
    console.log('✓ Modo consulta del corte: escrituras bloqueadas con mensaje claro (local y red), consultas, reinicio, marca dañada, copia final y descongelar verificados');
  } finally { try { db?.close(); } catch {} fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
