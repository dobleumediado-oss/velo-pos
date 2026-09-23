#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { calculate } = require('../src/js/offer-allocation');

let passed = 0;
let failed = 0;
function ok(condition, message, detail = '') {
  if (condition) {
    passed += 1;
    console.log('  ✓', message);
  } else {
    failed += 1;
    console.error('  ✗', message, detail ? `· ${detail}` : '');
  }
}
const r2 = value => Math.round((Number(value) || 0) * 100) / 100;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-sale-offers-'));
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

try {
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const customerId = db.prepare(
    "INSERT INTO customers(name,rnc,active,credit_limit) VALUES('CLIENTE OFERTA','101010101',1,9999999)"
  ).run().lastInsertRowid;
  const sessionId = DB.cashRepo.open({
    userId: admin.id, cajero: admin.name, openAmount: 0, openBills: {}, terminalId: 'OFERTA-QA',
  });

  const specs = [
    ['OF-G1', 'Regalo gravado', 59.99, 20, 1, 18],
    ['OF-A1', 'Absorbe gravado A', 100.01, 20, 1, 18],
    ['OF-A2', 'Absorbe gravado B', 200.02, 20, 1, 18],
    ['OF-GE', 'Regalo exento', 10.01, 20, 0, 0],
    ['OF-AE', 'Absorbe exento', 30.00, 20, 0, 0],
  ];
  const products = specs.map(([code, name, price, stock, taxable, taxPct], index) => ({
    id: DB.productsRepo.create({ code, name, price, cost:10 + index, stock, taxable, tax_pct:taxPct }),
    code, name, price, taxable, tax_pct:taxPct, qty:index === 0 ? 2 : 1,
  }));
  const offerIndexes = new Set([0, 3]);
  const input = products.map((product, index) => ({
    product_id:product.id, product_code:product.code, product_name:product.name,
    unit_cost:10 + index, unit_price:product.price, price:product.price,
    taxable:product.taxable, tax_pct:product.tax_pct, qty:product.qty,
    offer_is_gift:offerIndexes.has(index) ? 1 : 0,
  }));

  console.log('\n== Motor de reparto ==');
  const beforeSnapshot = JSON.stringify(input.map(item => ({ ...item, offer_is_gift:0 })));
  const plan = calculate(input);
  ok(plan.ok, 'acepta varias líneas de regalo con grupos fiscales compatibles', plan.error);
  ok(r2(plan.originalTotal) === r2(plan.adjustedTotal),
    '1. el total permanece idéntico al centavo', `${plan.originalTotal} vs ${plan.adjustedTotal}`);
  const adjustedCents = plan.items.reduce((sum, item) => sum + Math.round(item.effective_line_total * 100), 0);
  ok(adjustedCents === Math.round(plan.originalTotal * 100),
    'los centavos se reparten sin residuo ni centavo perdido');
  ok(plan.items[0].offer_is_gift === 1 && plan.items[0].effective_line_total === 0 &&
    plan.items[0].offer_original_amount === 119.98,
    'la oferta cubre toda la cantidad de la línea marcada');
  ok(plan.items[1].offer_absorbed_amount === 39.99 && plan.items[2].offer_absorbed_amount === 79.99,
    'el redondeo proporcional asigna el último centavo de forma determinista',
    `${plan.items[1].offer_absorbed_amount} + ${plan.items[2].offer_absorbed_amount}`);
  ok(plan.items[4].offer_absorbed_amount === 10.01,
    'un regalo exento solo se reparte sobre una línea exenta');
  const restored = input.map(item => ({ ...item, offer_is_gift:0 }));
  const restoredPlan = calculate(restored);
  ok(restoredPlan.ok && JSON.stringify(restored) === beforeSnapshot &&
    restoredPlan.items.every((item, index) => item.effective_line_total === item.price * item.qty),
    '5. quitar las marcas restaura exactamente los precios y cantidades anteriores');
  ok(!calculate([input[0]]).ok && /al menos un artículo cobrado/i.test(calculate([input[0]]).error),
    'un carrito de una sola línea no divide entre cero y explica el motivo');
  const incompatible = calculate([
    { price:118, qty:1, taxable:1, tax_pct:18, offer_is_gift:1 },
    { price:100, qty:1, taxable:0, tax_pct:0, offer_is_gift:0 },
  ]);
  ok(!incompatible.ok && /mismo ITBIS/i.test(incompatible.error),
    'si no existe receptor fiscal compatible, informa y no aplica la oferta');

  function createSale(withOffer) {
    return DB.salesRepo.getById(DB.salesRepo.create({
      customer: { id:customerId },
      items: input.map(item => ({
        ...item,
        price:undefined,
        offer_is_gift:withOffer ? item.offer_is_gift : 0,
      })),
      payment: { method:'efectivo', disc:7.5, saleDate:'2026-09-23', ncfType:'' },
      session: { id:sessionId }, user:admin, type:'factura',
    }).saleId);
  }

  console.log('\n== Venta persistida, impuestos, inventario y contabilidad ==');
  const baseline = createSale(false);
  const stockBeforeOffer = new Map(products.map(product => [
    product.id, db.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,
  ]));
  const offered = createSale(true);
  ok(r2(offered.total) === r2(baseline.total),
    '1. con descuento previo, la factura cobra exactamente el mismo total',
    `${baseline.total} vs ${offered.total}`);
  ok(r2(offered.tax_amt) === r2(baseline.tax_amt),
    '2. el ITBIS total permanece idéntico en mezcla gravada y exenta',
    `${baseline.tax_amt} vs ${offered.tax_amt}`);
  const storedGift = offered.items.find(item => item.product_code === 'OF-G1');
  const storedReceiver = offered.items.find(item => item.product_code === 'OF-A1');
  ok(Number(storedGift.offer_is_gift) === 1 && r2(storedGift.offer_original_amount) === 119.98 &&
    r2(storedGift.subtotal) === 0 && r2(storedReceiver.offer_absorbed_amount) === 39.99,
    '4. guarda por línea el valor regalado y el valor absorbido');
  ok(products.every(product => {
    const current = db.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock;
    return current === stockBeforeOffer.get(product.id) - product.qty;
  }), '6. inventario descuenta también toda la cantidad de las líneas regaladas');

  const columns = new Set(db.prepare('PRAGMA table_info(sale_items)').all().map(column => column.name));
  ok(['offer_is_gift','offer_original_amount','offer_absorbed_amount'].every(name => columns.has(name)),
    '4. la migración aditiva deja disponibles las tres columnas nuevas');

  const accounting = sale => {
    DB.accountingRepo.generateSaleEntry({ saleId:sale.id, userId:admin.id });
    const entry = db.prepare(`SELECT id FROM accounting_entries
      WHERE source_module='venta' AND source_id=? AND status='confirmado'`).get(sale.id);
    const lines = db.prepare(`SELECT a.code,l.debit,l.credit FROM accounting_entry_lines l
      JOIN accounting_accounts a ON a.id=l.account_id WHERE l.entry_id=?`).all(entry.id);
    return {
      debit:r2(lines.reduce((sum, line) => sum + line.debit, 0)),
      credit:r2(lines.reduce((sum, line) => sum + line.credit, 0)),
      revenue:r2(lines.find(line => line.code === '4101')?.credit),
    };
  };
  const baselineAccounting = accounting(baseline);
  const offeredAccounting = accounting(offered);
  ok(offeredAccounting.debit === offeredAccounting.credit &&
    offeredAccounting.revenue === baselineAccounting.revenue,
    '7. el asiento queda cuadrado y reconoce el mismo ingreso total',
    JSON.stringify({ baseline:baselineAccounting, offered:offeredAccounting }));

  console.log('\n== Impresión ==');
  const templateSource = fs.readFileSync(path.join(__dirname, '../src/js/plantillas.js'), 'utf8');
  const templateContext = {
    facturaLabel:sale => sale.document_number_fmt || `#${sale.id}`,
    facturaLabelOriginal:sale => `#${sale.original_sale_id || ''}`,
  };
  vm.runInNewContext(`${templateSource}\nthis.__renderMediaCarta = renderMediaCarta;`, templateContext);
  const html = templateContext.__renderMediaCarta(offered, {
    biz_name:'Negocio QA', biz_rnc:'101010101', biz_addr:'Santo Domingo', biz_phone:'8090000000',
  }, { logo:false, rnc:true, ncf:false, mensaje:false });
  ok(/Regalo gravado[^<]*· OFERTA/.test(html) && /Regalo exento[^<]*· OFERTA/.test(html),
    '3. la impresión etiqueta claramente cada línea regalada como OFERTA');
  ok(/Regalo gravado[^]*?<td[^>]*>RD\$0(?:\.00)?<\/td>/.test(html),
    '3. el artículo regalado se imprime con importe cero');

  console.log(`\n${failed ? 'FALLO' : 'OK'}: ${passed} verificaciones correctas, ${failed} fallidas.`);
  if (failed) process.exitCode = 1;
} finally {
  try { DB.getDB().close(); } catch {}
  fs.rmSync(tempDir, { recursive:true, force:true });
}
