#!/usr/bin/env node
/**
 * test-crm-cerebro.js — Regresión F0 del CRM Cerebro (dev-only)
 * Corre con el Node de Electron:  ELECTRON_RUN_AS_NODE=1 electron scripts/test-crm-cerebro.js
 * BD fresca y aislada en temp; nunca toca la BD real.
 */
'use strict';
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FALLO:', m); } };

const tmpDir = path.join(os.tmpdir(), `velo_crmtest_${Date.now()}`);
const DB = require('../database');
DB.initDB(tmpDir);
const db = DB.getDB();
const { initVersioning } = require('../versioning');

// Aplica TODAS las migraciones (incluida 1.31.0-crm-cerebro) sobre la BD fresca.
try { initVersioning(db); ok(true, 'initVersioning corre sin romper la cadena de migraciones'); }
catch (e) { ok(false, 'initVersioning: ' + e.message); }

// Las tablas nuevas existen tras migrar
const hasTable = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
['customer_scores', 'customer_interactions', 'crm_tags', 'customer_tag_map', 'product_enrichment']
  .forEach(t => ok(hasTable(t), `tabla ${t} creada por la migración`));

// Datos de prueba
const cust = db.prepare("INSERT INTO customers(name) VALUES (?)");
const c1 = cust.run('VIP Ana').lastInsertRowid;
const c2 = cust.run('Riesgo Caro').lastInsertRowid;
const c3 = cust.run('Nuevo Dan').lastInsertRowid;
const sale = db.prepare("INSERT INTO sales(customer_id,type,status,total,created_at) VALUES (?,?,?,?,datetime('now','localtime',?))");
for (let i = 0; i < 5; i++) sale.run(c1, 'factura', 'completed', 3000, `-${i * 5} days`);      // VIP
for (let i = 0; i < 3; i++) sale.run(c2, 'factura', 'completed', 800, `-${200 + i * 10} days`); // en_riesgo
sale.run(c3, 'factura', 'completed', 500, '-2 days');                                            // frecuente reciente
sale.run(c1, 'cotizacion', 'completed', 99999, '-1 days');                                       // ruido
sale.run(c1, 'factura', 'cancelled', 99999, '-1 days');                                          // ruido

const { crmRepo } = DB;
const ov = crmRepo.overview();
// initDB puede sembrar un cliente por defecto (Consumidor Final): contamos los ≥3 nuestros.
ok(ov.totalCustomers >= 3, `overview: cuenta clientes activos (${ov.totalCustomers}, incluye default si existe)`);
ok(ov.withPurchases === 3, `overview: 3 con compras (${ov.withPurchases})`);
ok(ov.segments.vip === 1, `overview: 1 VIP (${ov.segments.vip})`);
ok(ov.segments.en_riesgo === 1, `overview: 1 en riesgo (${ov.segments.en_riesgo})`);
const ana = ov.topSpenders.find(t => t.id === c1);
ok(ana && Math.abs(ana.monetary - 15000) < 0.01, `overview: monetary de Ana = 15000 sin ruido (${ana && ana.monetary})`);
ok(ov.atRisk.some(t => t.id === c2), 'overview: Caro aparece en atRisk');

// Interacciones
const iid = crmRepo.logInteraction({ customerId: c1, kind: 'whatsapp', reason: 'recordatorio', message: 'Hola Ana', userId: null });
ok(iid > 0, 'logInteraction inserta y devuelve id');
const list = crmRepo.interactionsFor(c1);
ok(list.length === 1 && list[0].kind === 'whatsapp', 'interactionsFor devuelve la interacción registrada');

// ── F1: Cliente 360° (RFM+ 6 ejes + hábitos) ──
const p1 = db.prepare("INSERT INTO products(code,name,cost,price) VALUES(?,?,?,?)").run('P-ACE', 'Aceite 5W-30', 200, 500).lastInsertRowid;
const anaSales = db.prepare("SELECT id FROM sales WHERE customer_id=? AND type='factura' AND status='completed'").all(c1);
const item = db.prepare("INSERT INTO sale_items(sale_id,product_id,product_code,product_name,unit_cost,unit_price,qty,subtotal) VALUES(?,?,?,?,?,?,?,?)");
anaSales.forEach(s => item.run(s.id, p1, 'P-ACE', 'Aceite 5W-30', 200, 500, 2, 1000)); // margen = 1000-400 = 600 c/u

const c360 = crmRepo.customer360(c1);
ok(c360 && c360.metrics.frequency === 5, `customer360: frequency 5 (${c360 && c360.metrics.frequency})`);
ok(Math.abs(c360.metrics.monetary - 15000) < 0.01, `customer360: LTV 15000 (${c360.metrics.monetary})`);
ok(Math.abs(c360.metrics.margin - 3000) < 0.01, `customer360: margen 3000 (5×600) (${c360.metrics.margin})`);
ok(c360.metrics.marginKnown === true, 'customer360: marginKnown=true cuando hay costo');

// Cliente con ítems SIN costo (data importada) → margen no confiable
const p0 = db.prepare("INSERT INTO products(code,name,cost,price) VALUES(?,?,?,?)").run('P-CORREA', 'Correa C52', 0, 800).lastInsertRowid;
db.prepare("SELECT id FROM sales WHERE customer_id=? AND type='factura' AND status='completed'").all(c2)
  .forEach(s => item.run(s.id, p0, 'P-CORREA', 'Correa C52', 0, 800, 1, 800)); // unit_cost 0
const caro = crmRepo.customer360(c2);
ok(caro.metrics.marginKnown === false, 'customer360: marginKnown=false cuando el costo es 0 (importado)');
ok(caro.metrics.margin === 0, 'customer360: margen=0 (no se infla al 100%) sin costo');
ok(c360.segment === 'vip', `customer360: segmento vip (${c360.segment})`);
ok(c360.rfm.f === 4, `customer360: F score = 4 para 5 compras (${c360.rfm.f})`);
ok(c360.topProducts.length >= 1 && c360.topProducts[0].name === 'Aceite 5W-30', 'customer360: "suele comprar" detecta el aceite');
ok(crmRepo.customer360(999999) === null, 'customer360: cliente inexistente devuelve null');

console.log(`\n${fail === 0 ? '✅' : '❌'} F0+F1 CRM: ${pass} OK, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
