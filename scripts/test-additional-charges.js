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
  // Un taller puede cobrar solo mano de obra: la venta vale sin artículos.
  const sellOnlyCharges = (charges) =>
    DB.salesRepo.getById(DB.salesRepo.create({
      customer: { id: customerId },
      items: [],
      payment: { method: 'efectivo', saleDate: '2026-09-19', ncfType: '', charges },
      session: { id: sessionId }, user: admin, type: 'factura',
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

  console.log('\n== El carrito muestra lo mismo que se guarda ==');
  const vm = require('vm');
  const posSource = fs.readFileSync(path.join(__dirname, '../src/js/pos.js'), 'utf8');
  const totalsFrom = posSource.indexOf('function _posRound2(');
  const totalsTo = posSource.indexOf('function invTotal(');
  ok(totalsFrom > 0 && totalsTo > totalsFrom, 'el cálculo del carrito sigue en pos.js');
  const cartTotals = (chargesTaxable, charges, itype = 'factura') => {
    const context = { CFG: { itbis: 18, charges_taxable: chargesTaxable } };
    vm.runInNewContext(`${posSource.slice(totalsFrom, totalsTo)}\nthis.calcTotals = calcTotals;`, context);
    return context.calcTotals({
      itype, disc: 0, charges,
      cart: [{ price: 118, qty: 1, taxable: 1, tax_pct: 18 }],
    });
  };
  const cartTaxed = cartTotals(true, [{ description: 'Instalación', amount: 500 }]);
  ok(r2(cartTaxed.subtotal) === r2(taxed.subtotal) && r2(cartTaxed.itbis) === r2(taxed.tax_amt) &&
    r2(cartTaxed.total) === r2(taxed.total),
    'con cargo gravado, el carrito da al centavo lo que guarda el backend',
    `carrito ${cartTaxed.subtotal}+${cartTaxed.itbis}=${cartTaxed.total} · backend ${taxed.subtotal}+${taxed.tax_amt}=${taxed.total}`);
  const cartExempt = cartTotals(false, [{ description: 'Envío a domicilio', amount: 500 }]);
  ok(r2(cartExempt.subtotal) === r2(exempt.subtotal) && r2(cartExempt.itbis) === r2(exempt.tax_amt) &&
    r2(cartExempt.total) === r2(exempt.total),
    'con cargo exento, el carrito también coincide con el backend',
    `carrito ${cartExempt.subtotal}+${cartExempt.itbis} · backend ${exempt.subtotal}+${exempt.tax_amt}`);
  const cartQuote = cartTotals(true, [{ description: 'Envío', amount: 200 }], 'cotizacion');
  ok(r2(cartQuote.itbis) === 0 && r2(cartQuote.subtotal + cartQuote.itbis) === r2(cartQuote.total),
    'en una cotización el cargo nunca fija ITBIS, aunque el negocio los grave');

  console.log('\n== La impresión no duplica el cargo ==');
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const linesFrom = printSource.indexOf('function _printChargesAsLines(');
  const linesTo = printSource.indexOf('function printReceipt(');
  const printContext = {};
  vm.runInNewContext(`${printSource.slice(linesFrom, linesTo)}\nthis.asLines = _printChargesAsLines;`, printContext);
  const current = printContext.asLines({
    charges_in_subtotal: 1, additional_charges_total: 500,
    items: [{ product_name: 'Producto', qty: 1, unit_price: 118 }],
    charges: [{ description: 'Instalación', amount: 500, taxable: 1, tax_pct: 18, net_subtotal: 423.73, tax_amt: 76.27 }],
  });
  ok(current.items.length === 2 && current.items[1].product_name === 'Instalación' &&
    current.items[1].is_charge === true,
    'en la convención vigente el cargo se imprime como una línea más');
  ok(current.additional_charges_total === 0,
    'y no se repite como fila debajo del ITBIS en ninguna de las plantillas');
  ok(printContext.asLines(current).items.length === 2,
    'normalizar dos veces no lo inyecta dos veces');
  const legacyPrint = printContext.asLines({
    charges_in_subtotal: 0, additional_charges_total: 300,
    items: [{ product_name: 'Producto' }], charges: [{ description: 'Flete antiguo', amount: 300 }],
  });
  ok(legacyPrint.items.length === 1 && legacyPrint.additional_charges_total === 300,
    'una factura vieja se reimprime exactamente como se emitió, con su fila aparte');

  console.log('\n== Redacción y pantallas ==');
  const allUi = ['pos.js', 'conduce.js', 'ventas.js', 'tour.js']
    .map(file => fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8')).join('\n');
  ok(!allUi.includes('Agregar envío u otro cargo') && !allUi.includes('Agregar cargo a la ${label}'),
    'la interfaz dice "cargos adicionales" en todos lados');
  ok(!posSource.includes('id="cbr-summary-charges"') && posSource.includes('Incluye cargos adicionales por'),
    'el cobro informa los cargos sin mostrarlos como fila que se suma');
  const ventasSource = fs.readFileSync(path.join(__dirname, '../src/js/ventas.js'), 'utf8');
  ok(ventasSource.includes("Number(detail.charges_in_subtotal) !== 1"),
    'el detalle de Ventas solo muestra la fila aparte en facturas de la convención anterior');
  const configSource = fs.readFileSync(path.join(__dirname, '../src/js/config.js'), 'utf8');
  ok(configSource.includes('id="cfg-charges-taxable"') && configSource.includes("key: 'charges_taxable'"),
    'Configuración ofrece la regla del negocio, junto al porcentaje de ITBIS');

  console.log('\n== Venta de solo cargos (mano de obra, flete) ==');
  // Con la regla apagada (como arranca todo negocio) el cargo va sin ITBIS.
  db.prepare("INSERT INTO settings(key,value) VALUES('charges_taxable','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  const soloCargo = sellOnlyCharges([{ description: 'MANO DE OBRA', amount: 1500 }]);
  ok(r2(soloCargo.tax_amt) === 0, 'sin la regla de ITBIS, el cargo no genera impuesto', `itbis=${soloCargo.tax_amt}`);
  ok(r2(soloCargo.total) === 1500, 'el total es exactamente el cargo escrito', `total=${soloCargo.total}`);
  ok(r2(soloCargo.subtotal + soloCargo.tax_amt) === r2(soloCargo.total),
    'el desglose cuadra sin artículos', `${soloCargo.subtotal}+${soloCargo.tax_amt}`);
  ok((soloCargo.items || []).length === 0 && (soloCargo.charges || []).length === 1,
    'la venta queda sin artículos y con su cargo');
  ok(r2(soloCargo.additional_charges_total) === 1500,
    'el cargo queda registrado como tal', `cargos=${soloCargo.additional_charges_total}`);
  const lineasSoloCargo = entryLines(soloCargo.id);
  const cuenta4105 = lineasSoloCargo.filter(l => l.code === '4105');
  ok(cuenta4105.length === 1 && r2(cuenta4105[0].credit) === 1500,
    'contabilidad lleva el cargo a la 4105 aunque no haya mercancía',
    JSON.stringify(lineasSoloCargo.map(l => `${l.code}:${l.debit || 0}/${l.credit || 0}`)));
  const ventasMercancia = lineasSoloCargo.filter(l => l.code === '4101');
  ok(ventasMercancia.length === 0, 'no se inventa una venta de mercancía que no existió');

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(main.includes("Array.isArray(saleData?.payment?.charges) ? saleData.payment.charges") &&
    main.includes('La venta debe tener al menos un producto o un cargo adicional'),
    'el backend acepta una venta de solo cargos y rechaza la que no trae nada');
  const pos = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'pos.js'), 'utf8');
  ok(pos.includes('function posTieneQueCobrar(') && !pos.includes('if (!inv || !inv.cart.length) return;'),
    'el botón Cobrar y la confirmación miran artículos y cargos');

  console.log(`\n== RESULTADO: ${passed} OK ==`);

} finally {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
}
