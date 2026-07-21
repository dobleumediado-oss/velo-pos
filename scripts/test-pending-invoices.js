#!/usr/bin/env node
'use strict';

const { allocatePendingInvoices } = require('../lib/pending-invoices');

let failures = 0;
function ok(condition, message) {
  if (condition) console.log('  ✓', message);
  else { failures++; console.error('  ✗', message); }
}
function near(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.005;
}

console.log('\n== Facturas pendientes: saldo vigente distribuido FIFO ==');
const eduard = allocatePendingInvoices([
  { id: 38, total: 819735 },
  { id: 43, total: 98825 },
  { id: 278, total: 90100 },
  { id: 466, total: 37800 },
], 1009420.13);

ok(eduard.facturas.length === 4, 'conserva las cuatro facturas abiertas del caso reportado');
ok(near(eduard.facturas.reduce((sum, f) => sum + f.pendiente, 0), 1009420.13),
  'la suma pendiente coincide con el balance del cliente');
ok(near(eduard.facturas.find(f => f.id === 38)?.pendiente, 782695.13),
  'aplica los abonos primero a la factura más antigua (FIFO)');
ok(near(eduard.unallocatedBalance, 0), 'no deja saldo sin asignar cuando existen facturas suficientes');

const partial = allocatePendingInvoices([
  { id: 1, total: 100 },
  { id: 2, total: 200 },
], 250);
ok(near(partial.facturas.find(f => f.id === 1)?.pendiente, 50),
  'un abono parcial reduce primero la factura antigua');
ok(near(partial.facturas.find(f => f.id === 2)?.pendiente, 200),
  'mantiene completa la factura más reciente');

const opening = allocatePendingInvoices([], 75.25);
ok(opening.facturas.length === 0 && near(opening.unallocatedBalance, 75.25),
  'identifica un saldo inicial que no tiene factura asociada');

if (failures) {
  console.error(`\n${failures} prueba(s) fallaron.`);
  process.exit(1);
}
console.log('\nTodas las pruebas de facturas pendientes pasaron.');
