#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const { allocatePendingInvoices, getPendingInvoices } = require('../lib/pending-invoices');

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

const imported = allocatePendingInvoices([
  { id: 10, total: 500, pending_capacity: 40 },
  { id: 11, total: 900, pending_capacity: 60 },
], 100);
ok(imported.facturas.length === 2,
  'conserva todas las facturas importadas que tienen saldo individual');
ok(near(imported.facturas.find(f => f.id === 10)?.pendiente, 40),
  'respeta el saldo de origen de la factura antigua');
ok(near(imported.facturas.find(f => f.id === 11)?.pendiente, 60),
  'respeta el saldo de origen de la factura reciente');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE customers(id INTEGER PRIMARY KEY, balance REAL);
  CREATE TABLE sales(
    id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL, subtotal REAL,
    tax_amt REAL, discount_amt REAL, created_at TEXT, notes TEXT, ncf TEXT,
    status TEXT, numero_factura INTEGER, numero_factura_fmt TEXT,
    source_balance REAL, import_source TEXT, payment_method TEXT, type TEXT
  );
  CREATE TABLE payments(
    id INTEGER PRIMARY KEY, sale_id INTEGER, amount REAL,
    import_source TEXT, cajero TEXT
  );
  INSERT INTO customers VALUES(1, 100);
  INSERT INTO sales VALUES
    (10,1,500,500,0,0,'2024-01-01','','','completed',10,'00000010',NULL,'equiparts_bak','credito','factura'),
    (11,1,900,900,0,0,'2024-02-01','','','completed',11,'00000011',NULL,'equiparts_bak','credito','factura');
  INSERT INTO payments VALUES
    (1,10,460,'equiparts_bak','Importación histórica'),
    (2,11,840,'equiparts_bak','Importación histórica');
`);
const legacyImported = getPendingInvoices(db, 1);
ok(legacyImported.facturas.length === 2,
  'reconstruye los saldos de una base ya migrada que aún no tenía source_balance');
ok(near(legacyImported.facturas.find(f => f.id === 10)?.pendiente, 40)
  && near(legacyImported.facturas.find(f => f.id === 11)?.pendiente, 60),
  'usa únicamente los cobros históricos enlazados para la compatibilidad');
db.close();

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
