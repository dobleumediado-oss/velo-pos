'use strict';

// Orden de compra para el proveedor: hoja Carta con membrete y ticket térmico.
// Comprueba datos completos de proveedor y comprador, que no aparezcan
// impuestos, cargos ni pie de factura, y que cada formato vaya a su papel.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const between = (src, start, end) => src.slice(src.indexOf(start), end ? src.indexOf(end) : undefined);

const printed = [];
const ctx = {
  console, Promise, String, Number, Math, Object, Array, JSON, Date,
  DB: { settings: { biz_name: 'Repuestos <El Cibao>', biz_rnc: '131456789', biz_addr: 'Av. 27 de Febrero #145',
    biz_phone: '809-555-0142', biz_email: 'compras@cibao.do', biz_web: 'cibao.do' } },
  CFG: {},
  fmt: n => 'RD$' + Number(n || 0).toFixed(2),
  fdate: d => d,
  toast() {},
  printHTML: (html, category) => printed.push({ kind: 'html', html, category }),
  _openPrintWindow: (html, jobType, referenceId, isReprint, options) => printed.push({ kind: 'window', html, jobType, options }),
  _getCategoryConfig: () => ({ printer: '' }),
  _getTicketPrinterProfile: () => ({ kind: 'continuous', widthMm: 58, printableWidthMm: 48 }),
  window: { api: {
    purchases: { getById: async () => ({ ok: true, data: { id: 7, supplier_id: 3, supplier_name: 'Copia vieja',
      status: 'pendiente', created_at: '2026-10-30 10:00:00', cajero: 'Ana', notes: 'Entregar en almacén',
      subtotal: 1000, tax_amt: 180, freight_cost: 50,
      items: [{ product_code: 'F-1', product_name: 'Filtro', qty_ordered: 4, unit_cost: 250 }] } }) },
    suppliers: { getAll: async () => ({ ok: true, data: [{ id: 3, name: 'Autopartes Norte', rnc: '130987654',
      contact: 'José', phone: '809-555-0199', email: 'ventas@norte.do', address: 'Zona Industrial' }] }) },
  } },
};
vm.createContext(ctx);
vm.runInContext(between(read('src/js/compras.js'), '// ── Orden de compra para el proveedor'), ctx);

(async () => {
  await vm.runInContext("imprimirOrdenCompra(7, 'carta')", ctx);
  const sheet = printed.pop();
  assert.equal(sheet.kind, 'html');
  assert.equal(sheet.category, 'compras');
  for (const text of ['Orden de Compra', 'OC-0007', 'Autopartes Norte', '130987654', 'José', '809-555-0199',
    'ventas@norte.do', 'Zona Industrial', 'Ana', 'Entregar en almacén', 'RD$1000.00', 'RNC 131456789',
    'Av. 27 de Febrero #145', 'Repuestos &lt;El Cibao&gt;', 'size:letter']) {
    assert.ok(sheet.html.includes(text), `Carta debe incluir ${text}`);
  }
  assert.doesNotMatch(sheet.html, /Subtotal|ITBIS|Impuesto|Descuento|Flete|Enviar a|Ship|Tax Invoice|Firma autorizada/i);
  assert.ok(!sheet.html.includes('Copia vieja'), 'usa el nombre vigente del proveedor');
  console.log('  ✓ Carta: membrete, proveedor y comprador completos, solo el total');

  await vm.runInContext("imprimirOrdenCompra(7, 'termica')", ctx);
  const ticket = printed.pop();
  assert.equal(ticket.kind, 'window');
  assert.equal(ticket.jobType, 'compras');
  assert.equal(ticket.options.templateId, 'termica_58_basica');
  assert.match(ticket.html, /size:58mm auto/);
  assert.match(ticket.html, /width:48mm/);
  for (const text of ['ORDEN DE COMPRA', 'OC-0007', 'Autopartes Norte', '4 x RD$250.00', 'RD$1000.00', 'RNC 131456789', 'cibao.do']) {
    assert.ok(ticket.html.includes(text), `Térmica debe incluir ${text}`);
  }
  assert.doesNotMatch(ticket.html, /Subtotal|ITBIS|Impuesto|Descuento|Flete|Tax Invoice/i);
  console.log('  ✓ Térmica: ancho del rollo y plantilla térmica para la ruta de impresión');
})().catch(error => { console.error(error); process.exitCode = 1; });
