#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-aio-integration-'));
const csvDir = path.join(root, 'csv');
const dataDir = path.join(root, 'data');
fs.mkdirSync(csvDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const files = {
  '1_inventario_v2.csv': `code,barcode,name,cost,price,wholesale,taxable,tax_pct,stock,stock_min,category,brand,unit
P1,P1,PRODUCTO GRAVADO,50,118,100,1,18,10,1,GENERAL,GENERICA,UND
P2,P2,PRODUCTO EXENTO,20,50,45,0,0,5,1,GENERAL,GENERICA,UND
`,
  '2_clientes_v2.csv': `old_id_cliente,name,rnc,phone,celular,address,email,credit_days
1,CONSUMIDOR FINAL,,,,,,30
2,JUAN PEREZ,00112345678,8095550101,8295550101,CALLE 1,jp@example.com,30
`,
  '3_ventas_v2.csv': `old_id_factura,numero_factura,numero_factura_fmt,ncf,customer_name,old_id_cliente,date,total,balance,payment_method,status,estado_origen,product_code,product_name,qty,unit_price,line_total,taxable,tax_pct,factura_nota
10,849,00000849,B0100000849,JUAN PEREZ,2,2026-08-03,168,68,credito,completed,Pendiente,P1,PRODUCTO GRAVADO,1,118,118,1,18,PRUEBA
10,849,00000849,B0100000849,JUAN PEREZ,2,2026-08-03,168,68,credito,completed,Pendiente,P2,PRODUCTO EXENTO,1,50,50,0,0,PRUEBA
11,850,00000850,,JUAN PEREZ,2,2026-08-03,50,0,efectivo,completed,Pagada,P2,PRODUCTO EXENTO,1,50,50,0,0,PRUEBA
`,
  '4_recibos_v2.csv': `old_id_pago_detalle,old_id_factura,old_id_cliente,customer_name,date,amount,method,numero_recibo,notes
20,10,2,JUAN PEREZ,2026-08-03,100,efectivo,3,ABONO INICIAL
21,11,2,JUAN PEREZ,2026-08-03,50,efectivo,3,ABONO INICIAL
`,
};
for (const [filename, contents] of Object.entries(files)) {
  fs.writeFileSync(path.join(csvDir, filename), contents, 'utf8');
}

function runImport() {
  return spawnSync(process.execPath, [
    path.join(__dirname, 'importar-equiparts-v2.js'),
    `--dir=${csvDir}`,
    `--data-dir=${dataDir}`,
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

console.log('\n== 1. Importación completa en base desechable ==');
const first = runImport();
ok(first.status === 0, `primera importación termina correctamente${first.status === 0 ? '' : `: ${first.stderr || first.stdout}`}`);

const db = new Database(path.join(dataDir, 'velo.db'), { readonly: true });
const customer = db.prepare(`SELECT id,rnc,phone,balance,credit_due FROM customers WHERE old_id_cliente=2`).get();
ok(customer?.rnc === '00112345678', 'cliente importado conserva RNC');
ok(customer?.phone === '18095550101', 'teléfono principal queda normalizado para WhatsApp');
ok(customer?.balance === 68 && customer?.credit_due === '2026-09-02', 'CxC y vencimiento quedan correctos');

const phones = db.prepare(`SELECT phone_type,phone,is_primary FROM customer_phones WHERE customer_id=? AND active=1 ORDER BY id`).all(customer.id);
ok(phones.length === 2 && phones.filter(row => row.is_primary).length === 1, 'teléfono y celular quedan tipados sin dos principales');

const sale = db.prepare(`SELECT id,customer_rnc,ncf,subtotal,tax_amt,total,source_balance FROM sales WHERE old_id_factura=10`).get();
ok(sale?.customer_rnc === '00112345678', 'snapshot de factura conserva el RNC');
ok(sale?.ncf === 'B0100000849', 'factura conserva NCF válido de 11 caracteres');
ok(sale?.subtotal === 150 && sale?.tax_amt === 18 && sale?.total === 168, 'total mixto gravado/exento no se infla al reimprimir');

const items = db.prepare(`SELECT taxable,tax_pct,tax_amt,net_subtotal,subtotal FROM sale_items WHERE sale_id=? ORDER BY id`).all(sale.id);
ok(items.length === 2 && items[0].tax_amt === 18 && items[1].tax_amt === 0, 'ITBIS se conserva por línea');

const payment = db.prepare(`SELECT id,sale_id,balance_before,balance_after,amount FROM payments WHERE old_id_pago_detalle=20`).get();
const allocations = db.prepare(`SELECT * FROM payment_allocations WHERE payment_id=? ORDER BY sale_id`).all(payment.id);
ok(payment?.sale_id === sale.id && payment.amount === 150 && payment.balance_before === 218 && payment.balance_after === 68, 'un recibo distribuido crea un solo abono con saldo global coherente');
ok(allocations.length === 2 && allocations[0].amount === 100 && allocations[1].amount === 50, 'abono queda distribuido explícitamente entre sus dos facturas');
ok(db.prepare(`SELECT COUNT(*) count FROM legacy_payment_details WHERE payment_id=?`).get(payment.id).count === 2, 'conserva la identidad de cada aplicación del sistema viejo');
ok(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'la base importada no contiene referencias huérfanas');
db.close();

console.log('\n== 2. Segunda ejecución idempotente ==');
const second = runImport();
ok(second.status === 0, `segunda importación termina correctamente${second.status === 0 ? '' : `: ${second.stderr || second.stdout}`}`);
const db2 = new Database(path.join(dataDir, 'velo.db'), { readonly: true });
ok(db2.prepare(`SELECT COUNT(*) count FROM sales WHERE old_id_factura IN (10,11)`).get().count === 2, 'no duplica las facturas');
ok(db2.prepare(`SELECT COUNT(*) count FROM payments WHERE old_id_pago_detalle=20`).get().count === 1, 'no duplica el abono');
ok(db2.prepare(`SELECT COUNT(*) count FROM customer_phones WHERE customer_id=? AND active=1`).get(customer.id).count === 2, 'no duplica teléfonos');
ok(db2.prepare(`SELECT COUNT(*) count FROM payment_allocations`).get().count === 2, 'no duplica asignaciones');
db2.close();

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
