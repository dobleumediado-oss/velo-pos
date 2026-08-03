#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const { rpcTimeoutFor } = require('../src/main/ipc-bridge');
const {
  parseCsv,
  loadEquipartsCsvPayload,
  validateEquipartsData,
  calculateInvoiceFiscalBreakdown,
  syncImportedCustomerPhones,
  assertForeignKeyIntegrity,
} = require('../lib/equiparts-import');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) {
    pass += 1;
    console.log('  ✓', message);
  } else {
    fail += 1;
    console.log('  ✗ FALLO:', message);
  }
}

function records(csv, source) {
  const rows = parseCsv(csv.trim(), source);
  const headers = rows.shift();
  const result = rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
  Object.defineProperty(result, '_headers', { value: headers, enumerable: false });
  return result;
}

console.log('\n== 1. CSV estricto y validación previa ==');
let quoteError = false;
try { parseCsv('a,b\n"sin cerrar,2', 'roto.csv'); } catch (error) { quoteError = /sin cerrar/.test(error.message); }
ok(quoteError, 'rechaza comillas sin cerrar antes de tocar la base');

const data = {
  clientes: records(`old_id_cliente,name,rnc,phone,celular,address,email,credit_days
1,CONSUMIDOR FINAL,,,,,,30
2,JUAN PEREZ,001,8095550101,8295550101,CALLE 1,jp@example.com,30`, 'clientes'),
  inventario: records(`code,barcode,name,cost,price,wholesale,taxable,tax_pct,stock,stock_min,category,brand,unit
P1,P1,GRAVADO,50,118,100,1,18,10,1,GENERAL,GENERICA,UND
P2,P2,EXENTO,20,50,45,0,0,5,1,GENERAL,GENERICA,UND`, 'inventario'),
  ventas: records(`old_id_factura,numero_factura,numero_factura_fmt,ncf,customer_name,old_id_cliente,date,total,balance,payment_method,status,estado_origen,product_code,product_name,qty,unit_price,line_total,taxable,tax_pct,factura_nota
10,849,00000849,B0100000849,JUAN PEREZ,2,2026-08-03,168,68,credito,completed,Pendiente,P1,GRAVADO,1,118,118,1,18,PRUEBA
10,849,00000849,B0100000849,JUAN PEREZ,2,2026-08-03,168,68,credito,completed,Pendiente,P2,EXENTO,1,50,50,0,0,PRUEBA`, 'ventas'),
  recibos: records(`old_id_pago_detalle,old_id_factura,old_id_cliente,customer_name,date,amount,method,numero_recibo,notes
20,10,2,JUAN PEREZ,2026-08-03,100,efectivo,3,ABONO`, 'recibos'),
};
const validation = validateEquipartsData(data);
ok(validation.targetCxc === 68, 'CxC se deriva una sola vez por factura');
ok(validation.invoices.get(10).ncf === 'B0100000849', 'NCF histórico queda canónico y no duplica el tipo');
ok(validation.invoices.get(10).items[1].taxable === 0, 'preserva líneas exentas');

const broken = { ...data, ventas: data.ventas.map(row => ({ ...row, total: '999' })) };
let totalError = false;
try { validateEquipartsData(broken); } catch (error) { totalError = /no cuadra/.test(error.message); }
ok(totalError, 'rechaza una factura cuyo detalle no cuadra con el total');

const zeroHeader = { ...data, ventas: data.ventas.map(row => ({ ...row, total: '0' })) };
const recovered = validateEquipartsData(zeroHeader);
ok(recovered.invoices.get(10).total === 168 && recovered.warnings.length === 1,
  'recupera un total legado en cero únicamente desde líneas que cuadran');
ok(recovered.invoices.get(10).total_recovered_from_detail === true,
  'marca explícitamente la factura conciliada para auditoría y trazabilidad');

const impossibleBalance = {
  ...data,
  ventas: data.ventas.map(row => ({ ...row, total: '0', balance: '999' })),
};
let balanceError = false;
try { validateEquipartsData(impossibleBalance); } catch (error) { balanceError = /balance.+supera el total recuperado/i.test(error.message); }
ok(balanceError, 'no recupera silenciosamente un encabezado cuyo balance supera el detalle');

const discounted = {
  ...data,
  ventas: data.ventas.map(row => ({ ...row, total: '166.32', balance: '66.32' })),
};
const discountValidation = validateEquipartsData(discounted);
const discountedInvoice = discountValidation.invoices.get(10);
const discountBreakdown = calculateInvoiceFiscalBreakdown(discountedInvoice);
ok(discountedInvoice.discount_amt === 1.68 && discountedInvoice.discount_pct === 1,
  'reconstruye el descuento de factura cuando el detalle bruto supera al total cobrado');
ok(discountValidation.warnings.some(w => w.code === 'INVOICE_DISCOUNT_RECOVERED_FROM_TOTALS'),
  'reporta el descuento reconstruido como conciliación auditable');
ok(discountBreakdown.netSubtotal + discountBreakdown.taxAmt === 166.32 &&
   discountBreakdown.fiscalItems.reduce((sum, item) => sum + item.lineAfterDiscount, 0) === 166.32,
  'prorratea descuento e ITBIS sin cambiar el total autoritativo');

const asCsv = rows => {
  const headers = rows._headers;
  return [headers.join(','), ...rows.map(row => headers.map(header => row[header] || '').join(','))].join('\n');
};
const transported = loadEquipartsCsvPayload({
  '1_inventario_v2.csv': asCsv(data.inventario),
  '2_clientes_v2.csv': asCsv(data.clientes),
  '3_ventas_v2.csv': asCsv(data.ventas),
  '4_recibos_v2.csv': asCsv(data.recibos),
});
ok(validateEquipartsData(transported).targetCxc === 68,
  'los cuatro CSV viajan desde una terminal y se reconstruyen íntegros en el servidor');
ok(rpcTimeoutFor('importar:allInOneEquiparts') === 10 * 60 * 1000 && rpcTimeoutFor('products:getAll') === 8000,
  'la importación remota no vence con el timeout general de ocho segundos');

console.log('\n== 2. Teléfonos tipados, normalizados e idempotentes ==');
const db = new Database(':memory:');
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT DEFAULT '');
  CREATE TABLE customer_phones(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    phone_type TEXT NOT NULL,
    phone TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );
  CREATE UNIQUE INDEX idx_test_primary ON customer_phones(customer_id) WHERE active=1 AND is_primary=1;
  INSERT INTO customers(id,name) VALUES(2,'JUAN PEREZ');
`);
syncImportedCustomerPhones(db, 2, '809-555-0101', '829 555 0101');
syncImportedCustomerPhones(db, 2, '809-555-0101', '829 555 0101');
let phones = db.prepare('SELECT phone_type,phone,is_primary FROM customer_phones WHERE customer_id=2 AND active=1 ORDER BY id').all();
ok(phones.length === 2, 'repetir la importación no duplica contactos');
ok(phones[0].phone === '18095550101' && phones[1].phone === '18295550101', 'agrega prefijo país 1 para WhatsApp');
ok(phones.filter(phone => phone.is_primary).length === 1, 'mantiene exactamente un teléfono principal');
ok(db.prepare('SELECT phone FROM customers WHERE id=2').get().phone === '18095550101', 'sincroniza customers.phone con el principal');

db.prepare(`INSERT INTO customer_phones(customer_id,phone_type,phone,is_primary,active) VALUES(2,'flota','*123',0,1)`).run();
syncImportedCustomerPhones(db, 2, '8095550101', '8495550101');
phones = db.prepare('SELECT phone FROM customer_phones WHERE customer_id=2 AND active=1 ORDER BY id').all();
ok(phones.some(row => row.phone === '*123') && phones.some(row => row.phone === '18495550101'), 'fusiona teléfonos importados sin borrar contactos locales');

console.log('\n== 3. Integridad referencial ==');
assertForeignKeyIntegrity(db);
ok(true, 'acepta una base sin referencias huérfanas');
db.pragma('foreign_keys=OFF');
db.prepare(`INSERT INTO customer_phones(customer_id,phone_type,phone,is_primary,active) VALUES(999,'telefono','18090000000',0,1)`).run();
let fkError = false;
try { assertForeignKeyIntegrity(db); } catch (error) { fkError = /huérfanas/.test(error.message); }
ok(fkError, 'bloquea la confirmación si el reset deja referencias huérfanas');
db.close();

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
