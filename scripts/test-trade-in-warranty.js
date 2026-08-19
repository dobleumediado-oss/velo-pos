#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
let passed=0, failed=0;
const ok=(c,m)=>{if(c){passed++;console.log('  ✓',m);}else{failed++;console.error('  ✗',m);}};

const tempDir=path.join(os.tmpdir(),`velo_tradein_${Date.now()}`);
const DB=require('../database');
DB.initDB(tempDir);
const db=DB.getDB();
require('../versioning').initVersioning(db,tempDir);
const admin=db.prepare("SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();
const customerId=db.prepare("INSERT INTO customers(name,phone,credit_limit) VALUES('María Tech','8095550101',100000)").run().lastInsertRowid;

console.log('== R7 · trade-in y garantía por IMEI ==');
const soldProduct=DB.productsRepo.create({code:'NEW-1',name:'iPhone 15',cost:25000,price:40000,stock:0,taxable:1,tax_pct:18});
DB.productUnitsRepo.setSerialized(soldProduct,true);
const soldUnit=DB.productUnitsRepo.create({product_id:soldProduct,imei:'350000000000111',condition:'nuevo',unit_cost:25000});
const usedProduct=DB.productsRepo.create({code:'USED-13',name:'iPhone 13 usado',cost:0,price:22000,stock:0,taxable:1,tax_pct:18});
DB.productUnitsRepo.setSerialized(usedProduct,true);

const result=DB.salesRepo.create({session:null,customer:{id:customerId},user:admin,type:'factura',
  items:[{product_id:soldProduct,product_code:'NEW-1',product_name:'iPhone 15',product_unit_id:soldUnit,unit_price:40000,qty:1,taxable:1,tax_pct:18}],
  payment:{method:'efectivo',warrantyDays:90,tradeIn:{productId:usedProduct,imei:'350000000000222',allowance:12000,color:'Negro',capacity:'128GB'}},
});
const sale=DB.salesRepo.getById(result.saleId);
ok(Number(sale.trade_in_amount)===12000 && !!sale.trade_in_unit_id,'la factura conserva el valor y la unidad recibida como pago');
const incoming=DB.productUnitsRepo.findByImei('350000000000222');
ok(incoming && incoming.condition==='usado' && incoming.status==='en_stock' && Number(incoming.unit_cost)===12000,'el usado entra al inventario con costo igual al valor reconocido');
const trade=db.prepare('SELECT * FROM trade_ins WHERE sale_id=?').get(result.saleId);
ok(trade && Number(trade.customer_id)===Number(customerId) && Number(trade.allowance)===12000,'el trade-in queda trazable a venta y cliente');
const sold=DB.productUnitsRepo.findByImei('350000000000111');
ok(sold.status==='vendido' && !!sold.warranty_until && String(sold.customer_name).toUpperCase()==='MARÍA TECH','la unidad vendida queda consultable por IMEI con cliente y garantía');

DB.settingsRepo.set('module_contabilidad','1');
DB.accountingRepo.generateSaleEntry({saleId:result.saleId,userId:admin.id});
const entry=db.prepare("SELECT id FROM accounting_entries WHERE source_module='venta' AND source_id=?").get(result.saleId);
const sums=db.prepare('SELECT ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM accounting_entry_lines WHERE entry_id=?').get(entry.id);
ok(Number(sums.debit)===Number(sums.credit),'contabilidad reconoce efectivo + inventario usado y queda cuadrada');
const tradeDebit=db.prepare("SELECT COALESCE(SUM(l.debit),0) n FROM accounting_entry_lines l JOIN accounting_accounts a ON a.id=l.account_id WHERE l.entry_id=? AND a.code='1105'").get(entry.id).n;
ok(Number(tradeDebit)>=12000,'el valor del usado debita Inventario, no se trata como descuento');

let duplicateBlocked=false;
try{DB.salesRepo.create({session:null,customer:{id:customerId},user:admin,type:'factura',items:[{product_id:usedProduct,product_code:'USED-13',product_name:'iPhone 13 usado',product_unit_id:incoming.id,unit_price:22000,qty:1}],payment:{method:'efectivo',tradeIn:{productId:usedProduct,imei:'350000000000222',allowance:5000}}});}catch{duplicateBlocked=true;}
ok(duplicateBlocked,'rechaza un IMEI de trade-in duplicado');

DB.salesRepo.cancel(result.saleId,'Prueba de reverso',admin.id,admin.name);
ok(DB.productUnitsRepo.findByImei('350000000000111').status==='en_stock','anular repone la unidad serializada vendida');
ok(DB.productUnitsRepo.findByImei('350000000000222').status==='devuelto' && db.prepare('SELECT status FROM trade_ins WHERE sale_id=?').get(result.saleId).status==='cancelado','anular retira del stock el usado recibido y conserva evidencia');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed?1:0);
