#!/usr/bin/env node
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// R5a — Inventario serializado (VELO TECH POS): gestión de unidades por IMEI.
// Verifica que product_units funciona y que auto-repuestos (serialized=0) NO se
// ve afectado (su stock sigue siendo el campo numérico).
// ════════════════════════════════════════════════════════════════════════════

const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.error('  ✗', m); } };

const tempDir = path.join(os.tmpdir(), `velo_units_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const repo = DB.productUnitsRepo;

const techCatalog = require('../lib/tech-catalog').ensureTechInitialCatalog(db, DB.settingsRepo);
ok(techCatalog.changed && techCatalog.categories.includes('Celulares')
  && techCatalog.categories.includes('Piezas y repuestos técnicos'),
  'instalación TECH nueva recibe categorías tecnológicas sin tocar catálogos usados');

// Producto fungible (auto-repuestos): NO se toca.
const fungibleId = DB.productsRepo.create({ code: 'RPT-1', name: 'Filtro de aceite', cost: 100, price: 250, stock: 40, taxable: 1, tax_pct: 18 });
// Producto que será serializado (equipo TECH).
const phoneId = DB.productsRepo.create({ code: 'CEL-1', name: 'Smartphone X', cost: 12000, price: 18000, stock: 0, taxable: 1, tax_pct: 18 });

console.log('== R5a · inventario serializado ==');

// 1) auto-repuestos intacto: effectiveStock = su stock numérico.
ok(repo.effectiveStock(fungibleId) === 40, 'producto fungible: effectiveStock = stock numérico (40)');
ok(repo.overview(fungibleId).inStock === 0, 'producto fungible: sin unidades serializadas');

// 2) Registrar equipos por IMEI marca el producto como serializado.
repo.setSerialized(phoneId, true);
const u1 = repo.create({ product_id: phoneId, imei: '350000000000001', condition: 'nuevo', unit_cost: 12000, color: 'Negro', capacity: '128GB' });
const u2 = repo.create({ product_id: phoneId, imei: '350000000000002', condition: 'nuevo', unit_cost: 12500, color: 'Azul',  capacity: '256GB' });
const u3 = repo.create({ product_id: phoneId, imei: '350000000000003', condition: 'usado', unit_cost: 8000,  color: 'Negro', capacity: '128GB' });
ok(!!u1 && !!u2 && !!u3, 'se registran 3 equipos por IMEI');

// 3) Stock serializado = unidades en stock.
ok(repo.effectiveStock(phoneId) === 3, 'equipo serializado: effectiveStock = 3 unidades en stock');
ok(repo.countInStock(phoneId) === 3, 'countInStock = 3');
ok(repo.listForProduct(phoneId).length === 3, 'listForProduct devuelve 3');
let phoneView = DB.productsRepo.getAll().find(product => product.id === phoneId);
ok(Number(phoneView.effective_stock) === 3
  && Math.abs(Number(phoneView.effective_cost) - (32500 / 3)) < 0.01
  && Number(phoneView.effective_inventory_value) === 32500,
  'listado de inventario usa cantidad, costo promedio y valor de las unidades por IMEI');

// 4) Buscar por IMEI (y por serial vacío no rompe).
const found = repo.findByImei('350000000000002');
ok(found && found.color === 'Azul' && found.capacity === '256GB', 'findByImei localiza la unidad correcta');
ok(repo.findByImei('999') === null, 'findByImei inexistente devuelve null');

// 5) IMEI duplicado se rechaza (índice único).
let dupBlocked = false;
try { repo.create({ product_id: phoneId, imei: '350000000000001' }); } catch { dupBlocked = true; }
ok(dupBlocked, 'IMEI duplicado rechazado por el índice único');

// 6) Vender una unidad la descuenta del stock. product_units.sale_id referencia
// sales(id), así que se crea una venta real mínima (la BD rechaza un id falso —
// no se puede vender una unidad a una venta inexistente).
const saleId = db.prepare('INSERT INTO sales(subtotal,total) VALUES(0,0)').run().lastInsertRowid;
const sold = repo.markSold(u2, saleId);
ok(sold === 1, 'markSold marca la unidad como vendida');
ok(repo.effectiveStock(phoneId) === 2, 'tras vender, effectiveStock = 2');
phoneView = DB.productsRepo.getAll().find(product => product.id === phoneId);
ok(Number(phoneView.effective_stock) === 2 && Number(phoneView.effective_cost) === 10000
  && Number(phoneView.effective_inventory_value) === 20000,
  'al vender un IMEI, el listado recalcula existencia y valor sin usar products.stock');
const ov = repo.overview(phoneId);
ok(ov.byStatus.vendido === 1 && ov.byStatus.en_stock === 2, 'overview: 1 vendido, 2 en stock');

// 7) Recepción masiva: lote completo y rollback ante duplicados.
const bulkProductId = DB.productsRepo.create({ code:'CEL-LOTE', name:'Smartphone por lote', cost:9000, price:13000, stock:0 });
repo.setSerialized(bulkProductId, true);
const bulkIds = repo.createMany(bulkProductId, [
  { imei:'350000000000101', unit_cost:9000, color:'Azul' },
  { imei:'350000000000102', unit_cost:9000, color:'Azul' },
]);
ok(bulkIds.length === 2 && repo.countInStock(bulkProductId) === 2,
  'recepción masiva registra el lote completo');
let atomicBlocked = false;
try {
  repo.createMany(bulkProductId, [
    { imei:'350000000000103' },
    { imei:'350000000000101' },
  ]);
} catch { atomicBlocked = true; }
ok(atomicBlocked && !repo.findByImei('350000000000103'),
  'un duplicado cancela todo el lote sin registros parciales');

// 8) Recepción de una orden de compra: crea exactamente las unidades físicas,
// conserva la trazabilidad a OC/proveedor y no infla products.stock.
const supplierId = DB.suppliersRepo.create({ name:'Distribuidor TECH' });
const purchaseProductId = DB.productsRepo.create({ code:'CEL-OC', name:'Teléfono desde compra', cost:10000, price:15000, stock:0 });
repo.setSerialized(purchaseProductId, true);
const createdPurchase = DB.purchasesRepo.create({
  supplierId, supplierName:'Distribuidor TECH', userId:null, cajero:'Prueba',
  items:[{ product_id:purchaseProductId, product_code:'CEL-OC', product_name:'Teléfono desde compra', unit_cost:10000, qty_ordered:2 }],
});
const purchase = DB.purchasesRepo.getById(createdPurchase.poId);
const received = DB.purchasesRepo.receive(createdPurchase.poId, {
  userId:null, userName:'Prueba', costs:{ freight:1000 },
  items:[{
    id:purchase.items[0].id, qty_received:2,
    units:[
      { imei:'350000000000201', color:'Negro', capacity:'128GB', grade:'A', battery_health:100 },
      { imei:'350000000000202', color:'Azul', capacity:'256GB', supplier_warranty_until:'2027-08-19' },
    ],
  }],
});
const receivedUnits = repo.listForProduct(purchaseProductId);
const receivedProduct = db.prepare('SELECT stock,cost FROM products WHERE id=?').get(purchaseProductId);
ok(received.status === 'recibido' && receivedUnits.length === 2,
  'la compra serializada crea las 2 unidades y completa la OC');
ok(receivedProduct.stock === 0 && repo.effectiveStock(purchaseProductId) === 2,
  'la compra serializada no duplica stock numérico; el stock efectivo sale de los IMEI');
ok(receivedUnits.every(unit => unit.purchase_order_id === createdPurchase.poId && unit.supplier_id === supplierId),
  'cada equipo conserva trazabilidad a la OC y al proveedor');
ok(receivedUnits.every(unit => unit.unit_cost === 10500),
  'el flete se distribuye y queda guardado como costo real por equipo');

// 9) Si un IMEI del lote está duplicado, también se revierten cantidades,
// costos, estado de la OC y cualquier unidad válida previa del mismo intento.
const rollbackProductId = DB.productsRepo.create({ code:'CEL-ROLL', name:'Lote atómico', cost:5000, price:8000, stock:0 });
repo.setSerialized(rollbackProductId, true);
const rollbackPurchaseId = DB.purchasesRepo.create({
  supplierId, supplierName:'Distribuidor TECH', userId:null, cajero:'Prueba',
  items:[{ product_id:rollbackProductId, product_code:'CEL-ROLL', product_name:'Lote atómico', unit_cost:5000, qty_ordered:2 }],
}).poId;
const rollbackLine = DB.purchasesRepo.getById(rollbackPurchaseId).items[0];
let purchaseRollbackBlocked = false;
try {
  DB.purchasesRepo.receive(rollbackPurchaseId, {
    userId:null, userName:'Prueba', costs:{ freight:300 },
    items:[{ id:rollbackLine.id, qty_received:2, units:[
      { imei:'350000000000301' }, { imei:'350000000000201' },
    ] }],
  });
} catch { purchaseRollbackBlocked = true; }
const rollbackPurchase = DB.purchasesRepo.getById(rollbackPurchaseId);
ok(purchaseRollbackBlocked && rollbackPurchase.status === 'pendiente' && rollbackPurchase.items[0].qty_received === 0,
  'un IMEI duplicado revierte toda la recepción de compra');
ok(!repo.findByImei('350000000000301') && repo.effectiveStock(rollbackProductId) === 0,
  'el rollback no deja unidades ni existencias fantasma');

// 10) No se puede desactivar el serializado con unidades registradas.
let guard = false;
try { repo.setSerialized(phoneId, false); } catch { guard = true; }
ok(guard, 'no se puede desactivar serializado con unidades existentes');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed ? 1 : 0);
