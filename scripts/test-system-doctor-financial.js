#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const DB = require('../database');
const { runSystemDoctor } = require('../src/main/system-doctor');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { pass += 1; console.log('  ✓', message); }
  else { fail += 1; console.error('  ✗', message); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-doctor-test-'));
  DB.initDB(dataDir);
  const db = DB.getDB();
  db.prepare("INSERT INTO settings(key,value) VALUES('fiscal_enabled','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();

  const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const user = { id: userId, name: 'AUDITOR' };
  const productId = DB.productsRepo.create({
    code: 'DOC-ITBIS', name: 'Producto diagnóstico', cost: 50,
    price: 118, stock: 10, taxable: 1, tax_pct: 18,
  });
  const customerId = DB.customersRepo.create({ name: 'Cliente diagnóstico' });
  const sale = DB.salesRepo.create({
    operationId: 'doctor-sale-1',
    customer: { id: customerId, name: 'Cliente diagnóstico' },
    items: [{
      product_id: productId, product_code: 'DOC-ITBIS',
      product_name: 'Producto diagnóstico', unit_cost: 50,
      unit_price: 118, qty: 2, taxable: 1, tax_pct: 18,
    }],
    payment: {
      method: 'efectivo', disc: 10,
      charges: [{ description: 'Cargo adicional', amount: 5 }],
    },
    user,
    type: 'factura',
  });

  const diagnose = () => runSystemDoctor({
    db, dataDir, appRoot: path.resolve(__dirname, '..'),
    cashRepo: DB.cashRepo, settingsRepo: DB.settingsRepo,
    getLicenseStatus: () => ({ valid: true }), mainWindow: null,
  });

  const healthy = await diagnose();
  const healthySales = healthy.results.find(row => row.id === 'sales_logic');
  ok(healthySales && healthySales.value.currentMismatch.length === 0,
    'el diagnóstico entiende que el precio ya incluye ITBIS, descuento y cargos');
  ok(healthySales && healthySales.value.duplicateOperations.length === 0,
    'el diagnóstico no reporta duplicidad en una operación idempotente');

  db.prepare('UPDATE sales SET total=total+10 WHERE id=?').run(sale.saleId);
  const broken = await diagnose();
  const brokenSales = broken.results.find(row => row.id === 'sales_logic');
  ok(brokenSales && brokenSales.value.currentMismatch.some(row => row.id === sale.saleId),
    'el diagnóstico sí detecta una venta cuyo total fue alterado');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} OK, ${fail} fallos`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
