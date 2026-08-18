#!/usr/bin/env node
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// R5b — Venta de un equipo serializado por IMEI (VELO TECH POS), y prueba de que
// la venta de un producto fungible (auto-repuestos) NO cambia en nada.
// ════════════════════════════════════════════════════════════════════════════

const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.error('  ✗', m); } };

const tempDir = path.join(os.tmpdir(), `velo_ssale_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const admin = db.prepare("SELECT id,name FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();

// Producto fungible (auto-repuestos) con stock numérico.
const fungibleId = DB.productsRepo.create({ code: 'RPT-9', name: 'Bujía', cost: 80, price: 200, stock: 10, taxable: 1, tax_pct: 18 });
// Producto serializado (equipo) con 2 unidades.
const phoneId = DB.productsRepo.create({ code: 'CEL-9', name: 'Galaxy S23', cost: 0, price: 25000, stock: 0, taxable: 1, tax_pct: 18 });
DB.productUnitsRepo.setSerialized(phoneId, true);   // en producción lo hace el handler al registrar equipos
DB.productUnitsRepo.create({ product_id: phoneId, imei: '111111111111111', unit_cost: 16000, condition: 'nuevo' });
DB.productUnitsRepo.create({ product_id: phoneId, imei: '222222222222222', unit_cost: 16500, condition: 'nuevo' });

console.log('== R5b · venta serializada por IMEI ==');
ok(DB.productUnitsRepo.effectiveStock(phoneId) === 2, 'inicio: 2 equipos en stock');

// 1) Vender un equipo eligiendo su IMEI.
const r1 = DB.salesRepo.create({
  session: null, customer: { id: 1 },
  items: [{ product_id: phoneId, product_code: 'CEL-9', product_name: 'Galaxy S23', unit_price: 25000, imei: '222222222222222', qty: 1, taxable: 1, tax_pct: 18 }],
  payment: { method: 'efectivo' }, user: admin, type: 'factura',
});
const saleId = r1.saleId || r1.id;
ok(!!saleId, 'la venta del equipo se crea');
const unit2 = DB.productUnitsRepo.findByImei('222222222222222');
ok(unit2.status === 'vendido' && Number(unit2.sale_id) === Number(saleId), 'la unidad vendida queda marcada y enlazada a la venta');
ok(DB.productUnitsRepo.effectiveStock(phoneId) === 1, 'tras vender, 1 equipo en stock (descontó por unidad)');
const li = db.prepare('SELECT product_unit_id, unit_cost FROM sale_items WHERE sale_id=?').get(saleId);
ok(Number(li.product_unit_id) === Number(unit2.id), 'sale_items.product_unit_id enlaza la unidad');
ok(Number(li.unit_cost) === 16500, 'el costo de la línea es el COSTO REAL de la unidad (asiento correcto)');

// 2) No se puede vender un equipo ya vendido.
let soldBlocked = false;
try {
  DB.salesRepo.create({ session: null, customer: { id: 1 },
    items: [{ product_id: phoneId, product_code: 'CEL-9', product_name: 'Galaxy S23', unit_price: 25000, imei: '222222222222222', qty: 1, taxable: 1, tax_pct: 18 }],
    payment: { method: 'efectivo' }, user: admin, type: 'factura' });
} catch { soldBlocked = true; }
ok(soldBlocked, 'vender un equipo ya vendido se rechaza');

// 3) Vender un serializado sin IMEI se rechaza.
let noImeiBlocked = false;
try {
  DB.salesRepo.create({ session: null, customer: { id: 1 },
    items: [{ product_id: phoneId, product_code: 'CEL-9', product_name: 'Galaxy S23', unit_price: 25000, qty: 1, taxable: 1, tax_pct: 18 }],
    payment: { method: 'efectivo' }, user: admin, type: 'factura' });
} catch { noImeiBlocked = true; }
ok(noImeiBlocked, 'vender un equipo sin elegir IMEI se rechaza');

// 4) La venta de un producto FUNGIBLE no cambia: descuenta stock numérico.
const stockBefore = db.prepare('SELECT stock FROM products WHERE id=?').get(fungibleId).stock;
const r2 = DB.salesRepo.create({
  session: null, customer: { id: 1 },
  items: [{ product_id: fungibleId, product_code: 'RPT-9', product_name: 'Bujía', unit_price: 200, qty: 3, taxable: 1, tax_pct: 18 }],
  payment: { method: 'efectivo' }, user: admin, type: 'factura',
});
ok(!!(r2.saleId || r2.id), 'la venta fungible se crea');
const stockAfter = db.prepare('SELECT stock FROM products WHERE id=?').get(fungibleId).stock;
ok(stockBefore - stockAfter === 3, 'producto fungible: descuenta stock numérico (−3), sin tocar unidades');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed ? 1 : 0);
