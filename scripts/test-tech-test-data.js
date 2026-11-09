'use strict';
// Retirar datos de prueba de VELO TECH en un negocio VELO POS, con los repositorios reales
// de Desktop sobre una base temporal (nunca data/velo.db): un artículo con IMEI, tres
// equipos y dos ventas con equipo, como en la base real del 7 nov 2026.
// Uso: node scripts/run-electron-node.js scripts/test-tech-test-data.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const DB = require(path.join(root, 'database'));
const tool = require(path.join(root, 'lib/tech-test-data'));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-tech-test-data-'));
  let db;
  try {
    DB.initDB(temp); db = DB.getDB(); require(path.join(root, 'versioning')).initVersioning(db, temp);
    const user = db.prepare("SELECT id,name FROM users WHERE role='admin' LIMIT 1").get();
    assert.equal(tool.techTestDataStatus(db).present, false, 'una base nueva de VELO POS no tiene datos de TECH');

    const phone = Number(DB.productsRepo.create({ code: 'PRUEBA', name: 'Equipo de prueba', cost: 1000, price: 1500, stock: 0, taxable: 0, tax_pct: 0 }));
    db.prepare('UPDATE products SET serialized=1 WHERE id=?').run(phone);
    const unit = imei => Number(DB.productUnitsRepo.create({ product_id: phone, imei, unit_cost: 1000 }));
    const units = [unit('350000000000011'), unit('350000000000029'), unit('350000000000037')];
    const other = Number(DB.productsRepo.create({ code: 'FILTRO-01', name: 'Filtro', cost: 100, price: 200, stock: 10, taxable: 0, tax_pct: 0 }));
    const session = DB.cashRepo.open({ userId: user.id, cajero: user.name, openAmount: 0, openBills: {}, terminalId: 'terminal-prueba' });
    const line = (productId, code, unitId, price) => ({ product_id: productId, product_code: code, product_name: code, unit_price: price, unit_cost: 0, qty: 1, taxable: 0, tax_pct: 0, ...(unitId ? { product_unit_id: unitId } : {}) });
    const sell = items => DB.salesRepo.create({ customer: { id: 1 }, items, payment: { method: 'efectivo' }, session: { id: session }, user, type: 'factura' }).saleId;
    const sales = [sell([line(phone, 'PRUEBA', units[0], 1500)]), sell([line(phone, 'PRUEBA', units[1], 1500), line(other, 'FILTRO-01', null, 200)])];
    const realSale = sell([line(other, 'FILTRO-01', null, 200)]);

    // Con las ventas vigentes la herramienta no actúa: primero se anulan por el flujo normal.
    let status = tool.techTestDataStatus(db);
    assert.deepEqual({ present: status.present, serialized: status.serializedProducts, units: status.units, lines: status.unitLines, active: status.activeSales.length, canRetire: status.canRetire },
      { present: true, serialized: 1, units: 3, lines: 2, active: 2, canRetire: false });
    assert.match(status.blockers[0], /Anula primero las ventas con equipo/);
    assert.throws(() => tool.retireTechTestData(db), /Anula primero/);

    for (const id of sales) DB.salesRepo.cancel(id, 'Venta de prueba de VELO TECH', user.id, user.name);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM product_units WHERE status='en_stock'").get().n, 3, 'anular devuelve los equipos a existencia');
    status = tool.techTestDataStatus(db);
    assert.equal(status.canRetire, true);

    // Datos de TECH que no son de prueba simple: no se retiran.
    db.prepare("INSERT INTO service_technicians(name) VALUES('Técnico de prueba')").run();
    assert.equal(tool.techTestDataStatus(db).canRetire, false);
    assert.throws(() => tool.retireTechTestData(db), /service_technicians/);
    db.prepare('DELETE FROM service_technicians').run();

    const before = db.prepare(`SELECT (SELECT COUNT(*) FROM sales) sales, (SELECT COUNT(*) FROM sale_items) items, (SELECT COUNT(*) FROM sales WHERE status='cancelled') cancelled,
      (SELECT COUNT(*) FROM cash_movements) cash, (SELECT total FROM sales WHERE id=${realSale}) real_total`).get();
    const result = tool.retireTechTestData(db);
    assert.deepEqual(result, { lines: 2, countLines: 0, missing: 0, units: 3, articles: 1 });
    assert.equal(tool.techTestDataStatus(db).present, false);
    // Se conservan las ventas anuladas, sus líneas, la caja y las demás ventas.
    assert.deepEqual(db.prepare(`SELECT (SELECT COUNT(*) FROM sales) sales, (SELECT COUNT(*) FROM sale_items) items, (SELECT COUNT(*) FROM sales WHERE status='cancelled') cancelled,
      (SELECT COUNT(*) FROM cash_movements) cash, (SELECT total FROM sales WHERE id=${realSale}) real_total`).get(), before);
    assert.deepEqual(db.prepare('SELECT serialized, active FROM products WHERE id=?').get(phone), { serialized: 0, active: 0 });
    assert.equal(db.prepare('SELECT active FROM products WHERE id=?').get(other).active, 1, 'los artículos normales no se tocan');
    assert.throws(() => tool.retireTechTestData(db), /No hay datos de prueba/);
    console.log('✓ Datos de prueba de VELO TECH: exige anular, rechaza otros datos de TECH, retira equipos y artículo y conserva ventas, caja e historial');
  } finally { try { db?.close(); } catch {} fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
