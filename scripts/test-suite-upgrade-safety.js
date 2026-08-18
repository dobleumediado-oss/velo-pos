#!/usr/bin/env node
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// VELO SUITE — Compuerta de camino de upgrade (F0)
// ────────────────────────────────────────────────────────────────────────────
// Simula lo que le pasa a un cliente real cuando su VELO POS se auto-actualiza:
// se toma una copia de una base EXISTENTE y se corren TODAS las migraciones del
// build nuevo sobre ella. La actualización es segura solo si:
//   • las migraciones corren sin error,
//   • la integridad y las claves foráneas quedan OK,
//   • y los agregados de negocio (ventas, facturas, contabilidad, stock)
//     quedan IDÉNTICOS — ninguna migración toca datos existentes.
//
// Esta prueba es la red que atrapará una migración de la suite (p. ej. R3
// `product_units`) que, por error, altere datos de auto-repuestos.
//
// Uso:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/test-suite-upgrade-safety.js [ruta_db]
// (better-sqlite3 está compilado contra el ABI de Electron; se corre bajo él.)
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const srcDb = process.argv[2] || path.join(ROOT, 'data', 'velo.db');

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✓', msg); else { failed++; console.error('  ✗', msg); } };

if (!fs.existsSync(srcDb)) {
  console.error(`No existe la base de referencia: ${srcDb}`);
  console.error('Pasa la ruta de una base real como argumento, o coloca una en data/velo.db');
  process.exit(2);
}

const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

// Agregados de negocio que JAMÁS deben cambiar por una migración. Cada consulta
// se protege ante tablas ausentes para servir a bases de distintas épocas.
function snapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const one = (sql, d = 0) => { try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : d; } catch { return d; } };
  const snap = {
    sales_count:      has('sales') ? one('SELECT COUNT(*) FROM sales') : 0,
    factura_total:    has('sales') ? one("SELECT COALESCE(ROUND(SUM(total),2),0) FROM sales WHERE type='factura' AND status='completed'") : 0,
    factura_count:    has('sales') ? one("SELECT COUNT(*) FROM sales WHERE type='factura' AND status='completed'") : 0,
    customers_count:  has('customers') ? one('SELECT COUNT(*) FROM customers') : 0,
    products_count:   has('products') ? one('SELECT COUNT(*) FROM products') : 0,
    products_stock:   has('products') ? one('SELECT COALESCE(SUM(stock),0) FROM products') : 0,
    acct_debit:       has('accounting_entry_lines') ? one('SELECT COALESCE(ROUND(SUM(debit),2),0) FROM accounting_entry_lines') : 0,
    acct_credit:      has('accounting_entry_lines') ? one('SELECT COALESCE(ROUND(SUM(credit),2),0) FROM accounting_entry_lines') : 0,
  };
  db.close();
  return snap;
}

function integrity(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const integ = db.prepare('PRAGMA integrity_check').get();
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  db.close();
  return { integrityOk: (integ && Object.values(integ)[0]) === 'ok', fkViolations: fk.length };
}

console.log('== VELO SUITE · camino de upgrade sobre base real ==');
console.log('   base:', srcDb);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo_upgrade_'));
const tmpDb = path.join(tmpDir, 'velo.db');
fs.copyFileSync(srcDb, tmpDb);

// (1) Agregados ANTES de migrar.
const before = snapshot(tmpDb);
console.log('   antes :', JSON.stringify(before));

// (2) Correr initDB + migraciones del build ACTUAL sobre la copia.
let migrated = true;
try {
  const DB = require(path.join(ROOT, 'database'));
  DB.initDB(tmpDir);                    // abre tmpDir/velo.db
  require(path.join(ROOT, 'versioning')).initVersioning(DB.getDB(), tmpDir);
} catch (e) {
  migrated = false;
  console.error('  ✗ las migraciones lanzaron:', e.message);
}
ok(migrated, 'migraciones corren sin lanzar error');

// (3) Agregados DESPUÉS + integridad.
const after = snapshot(tmpDb);
console.log('   después:', JSON.stringify(after));
const integ = integrity(tmpDb);

for (const key of Object.keys(before)) {
  ok(before[key] === after[key], `agregado intacto · ${key} (${before[key]})`);
}
ok(integ.integrityOk, 'PRAGMA integrity_check = ok');
ok(integ.fkViolations === 0, `sin violaciones de clave foránea (${integ.fkViolations})`);

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failed) {
  console.error(`\n✗ UPGRADE INSEGURO (${failed} fallos). Una migración alteró datos o rompió integridad.`);
  process.exit(1);
}
console.log('\n✓ Upgrade seguro — migraciones aditivas, datos y contabilidad intactos.');
