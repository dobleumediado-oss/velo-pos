#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const DB = require('../database');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-imei-consistency-'));
DB.initDB(tempDir);
const db = DB.getDB();
try {
  const base = { code:'IMEI-MODEL', name:'Modelo de prueba', price:1180, cost:500, stock:21, serialized:1 };
  const productId = DB.productsRepo.create({ ...base, first_unit:{imei:'350000000000051',unit_cost:500} });
  assert.equal(DB.productsRepo.getById(productId).serialized,1);
  assert.equal(DB.productsRepo.getById(productId).stock,0,'el modelo serializado no recibe stock numérico');
  assert.equal(DB.productUnitsRepo.countInStock(productId),1,'guardar con IMEI crea una unidad vendible');
  const before = db.prepare('SELECT COUNT(*) count FROM products').get().count;
  assert.throws(()=>DB.productsRepo.create({...base,code:'DUPLICADO',name:'Otro modelo',first_unit:{imei:'350000000000051'}}),/registrado/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM products').get().count,before,'IMEI duplicado revierte también el modelo');
  assert.throws(()=>DB.productsRepo.create({...base,first_unit:{imei:'350000000000052'}}),/modelo ya existe/);
  assert.equal(DB.productUnitsRepo.countInStock(productId),1);
  const emptyId = DB.productsRepo.create({...base,code:'SOLO-MODELO',name:'Solo modelo'});
  assert.equal(DB.productsRepo.getAll().find(row=>row.id===emptyId).stock,0,'crear modelo no inventa equipos');
  const second = DB.productUnitsRepo.createMany(productId,[{serial:'SERIAL-SECOND',unit_cost:600}])[0];
  db.prepare('UPDATE products SET stock=21 WHERE id=?').run(productId);
  let product = DB.productsRepo.getAll().find(row=>row.id===productId);
  assert.equal(product.stock,2,'el contador histórico 21 no se presenta como existencia');
  assert.equal(product.effective_stock,2);
  const saleId = db.prepare('INSERT INTO sales(subtotal,total) VALUES(0,0)').run().lastInsertRowid;
  DB.productUnitsRepo.markSold(second,saleId);
  product = DB.productsRepo.getAll().find(row=>row.id===productId);
  assert.equal(product.stock,1,'vender un IMEI lo retira del inventario visible');
  assert.equal(product.stock,DB.productUnitsRepo.listForProduct(productId,'en_stock').length,'listado y selector IMEI coinciden');
  const normalId = DB.productsRepo.create({code:'ACCESORIO',name:'Accesorio',price:200,cost:50,stock:7});
  assert.equal(DB.productsRepo.getAll().find(row=>row.id===normalId).stock,7,'los accesorios conservan su stock numérico');
  assert.throws(()=>DB.productUnitsRepo.createMany(normalId,[{imei:'350000000000051'}]));
  assert.equal(DB.productsRepo.getById(normalId).serialized,0,'un lote rechazado no convierte el accesorio');

  const context = vm.createContext({ currentInv:()=>({}) });
  for (const [file,start,end] of [
    ['src/js/inventario.js','function invProductStock(','function invProductCost('],
    ['src/js/pos.js','function _posAvailableStock(','function renderPOSGrid('],
  ]) {
    const source = fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),context);
  }
  assert.equal(context.invProductStock(product),context._posAvailableStock(product));
  assert.equal(context.invProductStock({serialized:1,stock:21}),0,'sin conteo confirmado no muestra stock manual como IMEI');
  console.log('✓ IMEI: alta atómica, duplicados, modelos vacíos, stock histórico, venta y coherencia entre Inventario y POS');
} finally {
  db.close();
  fs.rmSync(tempDir,{recursive:true,force:true});
}
