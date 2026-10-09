#!/usr/bin/env node
'use strict';
// Solo datos sintéticos en un directorio temporal; nunca abre data/velo.db.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-paso-'));
const DB = require('../database');
let db;
try {
  DB.initDB(dir); db=DB.getDB();
  require('../versioning').initVersioning(db,dir);
  const user=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  const session={id:DB.cashRepo.open({userId:user.id,cajero:user.name,openAmount:0,openBills:{},terminalId:'paso-test'})};
  const productId=DB.productsRepo.create({code:'PASO',name:'Producto sintético',cost:30,price:100,stock:30,taxable:0});
  const make=(extra={})=>({session,user,customer:{id:1,name:'Comprador de prueba',phone:'8095550000'},
    items:[{product_id:productId,product_code:'PASO',product_name:'Producto sintético',unit_price:100,qty:5,taxable:0}],
    payment:{method:'credito',walkInCredit:true,walkInDueDate:'2026-10-15',initialPaymentAmount:200},...extra});
  const request=make({operationId:'paso-operation-1'});
  const sale=DB.salesRepo.create(request);
  assert.equal(sale.total,500);assert.equal(sale.outstandingBalance,300);
  const saved=DB.salesRepo.getById(sale.saleId);
  const accountId=saved.customer_id;
  assert.notEqual(accountId,1);assert.equal(saved.is_walk_in_credit,1);
  assert.equal(saved.customer_name,'COMPRADOR DE PRUEBA');assert.equal(saved.customer_phone,'8095550000');
  assert.equal(saved.payment_amount,200);assert.equal(saved.balance_after_payment,300);
  assert.equal(DB.customersRepo.getById(accountId).credit_due,'2026-10-15');
  assert(!DB.customersRepo.getAll().some(c=>c.id===accountId));
  assert(DB.customersRepo.getWalkInPurchases().some(c=>c.sale_id===sale.saleId && c.balance===300));
  assert.equal(DB.salesRepo.create(request).saleId,sale.saleId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE is_walk_in=1').get().n,1);
  const changed=make({operationId:'paso-operation-1'});changed.payment.walkInDueDate='2026-10-16';
  assert.throws(()=>DB.salesRepo.create(changed),/otros|diferentes|distintos/i);
  assert.throws(()=>DB.salesRepo.create(make({customer:{id:accountId},payment:{method:'credito',initialPaymentAmount:100}})),/solo admite abonos/);
  const pay=DB.customersRepo.addPayment({customerId:accountId,saleId:sale.saleId,amount:100,method:'efectivo',sessionId:session.id,userId:user.id,note:'ABONO DE PRUEBA',operationId:'paso-abono-1'});
  assert.equal(DB.customersRepo.getById(accountId).balance,200);
  const payRetry=DB.customersRepo.addPayment({customerId:accountId,saleId:sale.saleId,amount:100,method:'efectivo',sessionId:session.id,userId:user.id,note:'ABONO DE PRUEBA',operationId:'paso-abono-1'});
  assert.equal(payRetry.paymentId,pay.paymentId);
  assert.throws(()=>DB.customersRepo.addPayment({customerId:accountId,saleId:sale.saleId,amount:201,method:'efectivo'}),/supera/);
  DB.customersRepo.addPayment({customerId:accountId,saleId:sale.saleId,amount:200,method:'efectivo',sessionId:session.id,userId:user.id});
  assert.equal(DB.customersRepo.getById(accountId).balance,0);
  assert.equal(DB.salesRepo.getById(sale.saleId).balance_after_payment,0);
  DB.customersRepo.cancelPayment({id:pay.paymentId,reason:'Prueba anular abono',userId:user.id,userName:user.name,sessionId:session.id});
  assert.equal(DB.customersRepo.getById(accountId).balance,100);
  assert.equal(DB.customersRepo.getById(accountId).credit_due,'2026-10-15');
  const second=DB.salesRepo.create(make());
  assert.notEqual(second.customerId,accountId);
  assert.throws(()=>DB.customersRepo.addPayment({customerId:accountId,saleId:second.saleId,amount:10,method:'efectivo'}),/no pertenece/);
  const count=()=>db.prepare('SELECT COUNT(*) n FROM customers').get().n;
  const before=count();
  for(const invalid of [make({customer:{id:1,name:'Consumidor Final'}}),make({payment:{method:'credito',walkInCredit:true,initialPaymentAmount:0}}),make({payment:{method:'credito',walkInCredit:true,initialPaymentAmount:500}}),make({payment:{method:'credito',walkInCredit:true,initialPaymentAmount:200,walkInDueDate:'2026-02-31'}}),make({items:[{product_id:productId,unit_price:100,qty:5000}]})]) {
    assert.throws(()=>DB.salesRepo.create(invalid));assert.equal(count(),before);
  }
  const cashierId=Number(db.prepare("INSERT INTO users(name,email,password,role,active,can_sell_credit) VALUES('Caja prueba','paso-caja','x','cajero',1,0)").run().lastInsertRowid);
  assert.throws(()=>DB.salesRepo.create(make({user:{id:cashierId,name:'Caja prueba'}})),/permiso|crédito/);
  assert.equal(count(),before);
  db.prepare('UPDATE users SET can_sell_credit=1 WHERE id=?').run(cashierId);
  const cashierSale = DB.salesRepo.create(make({user:{id:cashierId,name:'Caja prueba'}}));
  assert.notEqual(cashierSale.customerId, 1);
  assert.equal(DB.customersRepo.getById(cashierSale.customerId).credit_limit, 0);
  DB.salesRepo.cancel(second.saleId,'Anulación de prueba',user.id,user.name,{paymentDisposition:'void',operationId:'paso-cancel',reversalSessionId:session.id});
  assert.equal(DB.customersRepo.getById(second.customerId).balance,0);
  const promoted=DB.customersRepo.promoteWalkIn(accountId);
  assert.equal(promoted.is_walk_in,0);assert.equal(promoted.balance,100);assert.equal(promoted.credit_limit,0);
  assert(DB.customersRepo.getAll().some(c=>c.id===accountId));
  DB.customersRepo.deleteAll();
  assert.equal(DB.customersRepo.getById(second.customerId).active,1);
  console.log('OK: venta de paso, aislamiento, abonos, saldado, anulación, permisos, rollback, promoción e idempotencia.');
} finally { if(db?.open)db.close();fs.rmSync(dir,{recursive:true,force:true}); }
