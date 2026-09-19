#!/usr/bin/env node
'use strict';

// Cargos adicionales: el importe escrito es el que se suma al total y, cuando
// el negocio los tiene gravados, lo incluye descompuesto como el precio de un
// artículo. Cada documento conserva la convención con la que se emitió.

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const ok = (condition, message, detail = '') => {
  if (!condition) {
    console.error('  ✗', message, detail ? `· ${detail}` : '');
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log('  ✓', message);
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

const tempDir = path.join(os.tmpdir(), `velo_additional_charges_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const { diagnoseSales } = require('../src/main/system-doctor');

try {
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const customerId = db.prepare(
    "INSERT INTO customers(name,rnc,active,credit_limit) VALUES('CLIENTE CARGOS','101',1,999999)"
  ).run().lastInsertRowid;
  const productId = db.prepare(`
    INSERT INTO products(code,name,price,cost,stock,active,taxable,tax_pct)
    VALUES('CARGO-1','Producto con cargo',118,50,999,1,1,18)
  `).run().lastInsertRowid;
  const sessionId = DB.cashRepo.open({
    userId: admin.id, cajero: admin.name, openAmount: 0, openBills: {}, terminalId: 'CARGOS-QA',
  });
  const sell = ({ charges = [], method = 'efectivo', type = 'factura', qty = 1 } = {}) =>
    DB.salesRepo.getById(DB.salesRepo.create({
      customer: { id: customerId },
      items: [{
        product_id: productId, product_code: 'CARGO-1', product_name: 'Producto con cargo',
        unit_cost: 50, unit_price: 118, taxable: 1, tax_pct: 18, qty,
      }],
      payment: {
        method: type === 'cotizacion' ? 'cotizacion' : method,
        saleDate: '2026-09-19', ncfType: '', charges,
      },
      session: { id: sessionId }, user: admin, type,
    }).saleId);
  const entryLines = (saleId) => {
    DB.accountingRepo.generateSaleEntry({ saleId, userId: admin.id });
    const entry = db.prepare(`
      SELECT id FROM accounting_entries
      WHERE source_module='venta' AND source_id=? AND status='confirmado'
      ORDER BY id DESC LIMIT 1
    `).get(saleId);
    return entry ? db.prepare(`
      SELECT a.code, ROUND(l.debit,2) debit, ROUND(l.credit,2) credit
      FROM accounting_entry_lines l JOIN accounting_accounts a ON a.id=l.account_id
      WHERE l.entry_id=?
    `).all(entry.id) : [];
  };

  console.log('\n== Instalación existente: nada cambia al actualizar ==');
  ok(db.prepare("SELECT value FROM settings WHERE key='charges_taxable'").get()?.value === '0',
    'el ajuste arranca apagado, así ninguna instalación cambia de conducta');
  ok(!!db.prepare("SELECT id FROM accounting_accounts WHERE code='4105'").get(),
    'existe la cuenta 4105 Ingresos por Servicios y Fletes');

  console.log('\n== Cargo exento ==');
  const exempt = sell({ charges: [{ description: 'Envío a domicilio', amount: 500 }] });
  ok(r2(exempt.total) === 618, 'el monto escrito se suma tal cual', `total=${exempt.total}`);
  ok(r2(exempt.subtotal + exempt.tax_amt) === r2(exempt.total),
    'el desglose cuadra: subtotal + ITBIS = total',
    `${exempt.subtotal} + ${exempt.tax_amt} vs ${exempt.total}`);
  ok(r2(exempt.tax_amt) === 18, 'un cargo exento no aporta ITBIS', `itbis=${exempt.tax_amt}`);
  ok(Number(exempt.charges_in_subtotal) === 1, 'la venta queda marcada con la convención vigente');

  console.log('\n== Cargo gravado, cuando el dueño lo enciende ==');
  db.prepare("UPDATE settings SET value='1' WHERE key='charges_taxable'").run();
  const taxed = sell({ charges: [{ description: 'Instalación', amount: 500 }] });
  const chargeNet = r2(500 / 1.18);
  const chargeTax = r2(500 - 500 / 1.18);
  ok(r2(taxed.total) === 618, 'el monto escrito SIGUE sumándose tal cual', `total=${taxed.total}`);
  ok(r2(taxed.subtotal + taxed.tax_amt) === r2(taxed.total),
    'el desglose cuadra con el cargo gravado',
    `${taxed.subtotal} + ${taxed.tax_amt} vs ${taxed.total}`);
  ok(r2(taxed.tax_amt) === r2(18 + chargeTax),
    'el ITBIS del documento incluye el del cargo', `itbis=${taxed.tax_amt}`);
  const storedCharge = (taxed.charges || [])[0] || {};
  ok(Number(storedCharge.taxable) === 1 && r2(storedCharge.net_subtotal) === chargeNet &&
    r2(storedCharge.tax_amt) === chargeTax,
    'el cargo queda descompuesto como la línea de un artículo',
    `neto=${storedCharge.net_subtotal} itbis=${storedCharge.tax_amt}`);

  console.log('\n== Contabilidad ==');
  const lines = entryLines(taxed.id);
  const debit = r2(lines.reduce((sum, row) => sum + row.debit, 0));
  const credit = r2(lines.reduce((sum, row) => sum + row.credit, 0));
  ok(debit === credit, 'el asiento cuadra', `D=${debit} C=${credit}`);
  ok(r2(lines.find(row => row.code === '4105')?.credit) === chargeNet,
    'el cargo acredita 4105 por su neto, no Ventas de Mercancía');
  ok(r2(lines.find(row => row.code === '4101')?.credit) === 100,
    'la mercancía conserva su propio renglón en 4101');
  ok(r2(lines.find(row => row.code === '2102')?.credit) === r2(18 + chargeTax),
    'el ITBIS del cargo llega a ITBIS por Pagar');

  console.log('\n== Cotización ==');
  const quote = sell({ type: 'cotizacion', charges: [{ description: 'Envío', amount: 200 }] });
  ok(r2(quote.total) === 318 && r2(quote.subtotal + quote.tax_amt) === r2(quote.total),
    'una cotización con cargo también cuadra', `sub=${quote.subtotal} total=${quote.total}`);

  console.log('\n== Documentos emitidos con la convención anterior ==');
  // Se reproduce una factura vieja: subtotal sin el cargo y cargo sumado aparte.
  const legacy = sell({ charges: [{ description: 'Flete antiguo', amount: 300 }] });
  db.prepare(`UPDATE sales SET subtotal=100,tax_amt=18,charges_in_subtotal=0 WHERE id=?`).run(legacy.id);
  db.prepare(`UPDATE sale_charges SET taxable=0,tax_pct=0,net_subtotal=amount,tax_amt=0 WHERE sale_id=?`).run(legacy.id);
  const report = diagnoseSales({ db });
  const flagged = new Set(JSON.stringify(report).match(/"id":\d+/g) || []);
  ok(!flagged.has(`"id":${legacy.id}`),
    'el Doctor no marca como corrupta una factura emitida con la convención anterior');
  ok(![exempt.id, taxed.id, quote.id].some(id => flagged.has(`"id":${id}`)),
    'el Doctor tampoco marca las ventas nuevas con cargo, exento o gravado');

  console.log('\n== Corregir una factura con cargo gravado ==');
  const credit_ = sell({ method: 'credito', qty: 2, charges: [{ description: 'Mano de obra', amount: 1180 }] });
  const model = DB.saleCorrectionsRepo.productCorrectionModel(credit_.id, admin.id);
  ok(model.correctionMode === 'direct_amendment', 'se corrige sobre la misma factura');
  DB.saleCorrectionsRepo.correctProducts({
    saleId: credit_.id,
    lines: model.lines.map(line => ({ sourceSaleId: line.source_sale_id, productId: line.product_id, targetQty: 1 })),
    addedItems: [], reason: 'Solo se llevó una unidad', userId: admin.id,
    expectedRevision: model.root.revision,
    idempotencyKey: `cargo-correccion-${credit_.id}-${Date.now()}`,
    session: { id: sessionId }, correctionIntent: 'reduction_only',
  });
  const corrected = DB.salesRepo.getById(credit_.id);
  ok(r2(corrected.total) === r2(118 + 1180), 'el total corregido conserva el cargo', `total=${corrected.total}`);
  ok(r2(corrected.subtotal + corrected.tax_amt) === r2(corrected.total),
    'tras corregir, el desglose sigue cuadrando',
    `${corrected.subtotal} + ${corrected.tax_amt} vs ${corrected.total}`);
  ok(r2(corrected.tax_amt) === r2(18 + (1180 - 1180 / 1.18)),
    'la corrección no le quita al cargo su ITBIS', `itbis=${corrected.tax_amt}`);

  console.log(`\n== RESULTADO: ${passed} OK ==`);
} finally {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
}
