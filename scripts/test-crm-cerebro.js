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

console.log(`\n${fail === 0 ? '✅' : '❌'} F0 CRM: ${pass} OK, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
