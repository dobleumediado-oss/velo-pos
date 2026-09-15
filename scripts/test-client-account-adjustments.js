#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'clientes.js'), 'utf8');
const start = source.indexOf('function cliIsCreditSale');
const end = source.indexOf('function cliSortLatestFirst', start);
assert(start >= 0 && end > start, 'no se encontraron las funciones financieras del cliente');

const context = {
  isImportedRecord: () => false,
  console,
};
vm.runInNewContext(`${source.slice(start, end)}\nthis.accountHelpers = {
  cliConsolidateAdjustedSales, cliConsolidatePendingInvoices, cliAccountMath
};`, context);

const rows = [
  { id: 2392, type: 'factura', status: 'completed', payment_method: 'credito', total: 306600 },
  { id: 2426, type: 'factura', status: 'completed', payment_method: 'credito', total: 166040,
    correction_kind: 'product_addition', original_sale_id: 2392, correction_artifact: 1 },
  { id: 3006, type: 'devolucion', status: 'completed', payment_method: 'credito', total: 185600,
    original_sale_id: 2392, correction_artifact: 1 },
  { id: 3001, type: 'devolucion', status: 'completed', payment_method: 'efectivo', total: 168000,
    original_sale_id: 2200, correction_artifact: 0 },
];
const consolidated = context.accountHelpers.cliConsolidateAdjustedSales(rows);
assert.strictEqual(consolidated.some(row => row.id === 2426), false,
  'el aumento interno no debe aparecer como otra factura del cliente');
assert.strictEqual(consolidated.some(row => row.id === 3006), false,
  'la nota generada por una corrección debe permanecer solo en auditoría');
assert.strictEqual(consolidated.some(row => row.id === 3001), true,
  'una devolución real e independiente debe seguir visible');
assert.strictEqual(consolidated.find(row => row.id === 2392).operation_total, 287040,
  'la factura ajustada debe mostrar original + aumentos - créditos');

const consolidatedPending = context.accountHelpers.cliConsolidatePendingInvoices([
  { id: 2392, total: 306600, pendiente: 121000 },
  { id: 2426, total: 166040, pendiente: 166040,
    correction_kind: 'product_addition', original_sale_id: 2392 },
], consolidated);
assert.strictEqual(consolidatedPending.length, 1,
  'facturas pendientes debe mostrar una sola operación corregida');
assert.strictEqual(consolidatedPending[0].total, 287040);
assert.strictEqual(consolidatedPending[0].pendiente, 287040,
  'el saldo raíz y el aumento interno deben consolidarse');

const account = context.accountHelpers.cliAccountMath(consolidated, [], {
  ok: true,
  facturas: [
    { id: 2392, pendiente: 121000 },
    { id: 2426, pendiente: 166040, correction_kind: 'product_addition', original_sale_id: 2392 },
  ],
}, 287040);
assert.strictEqual(account.creditInvoices.length, 1,
  'el estado de cuenta debe contar una sola factura ajustada');
assert.strictEqual(account.totalCredito, 287040,
  'el total facturado debe usar el neto vigente de la operación');
assert.strictEqual(account.pendingBySale.get(2392), 287040,
  'el saldo complementario debe consolidarse en la factura original');

console.log('✓ Estado de cuenta consolida correcciones sin refacturar visualmente');
