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

// 8) No se puede desactivar el serializado con unidades registradas.
let guard = false;
try { repo.setSerialized(phoneId, false); } catch { guard = true; }
ok(guard, 'no se puede desactivar serializado con unidades existentes');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed ? 1 : 0);
