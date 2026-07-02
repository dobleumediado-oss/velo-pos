#!/usr/bin/env node
/**
 * verify-historical-integrity.js — RED DE SEGURIDAD (solo lectura)
 *
 * Diagnóstico de integridad de la data histórica importada de VELO POS.
 * NO modifica la base de datos: la abre en modo readonly. Pensado para
 * correrse ANTES y DESPUÉS de cada bloque de refactorización y comparar,
 * garantizando que "la historia" (ventas, abonos, CxC, relaciones y montos)
 * no cambió por accidente.
 *
 * La importación histórica en VELO POS NO usa una columna dedicada: se marca
 * con el literal cajero='Importación histórica' en sales/payments y
 * note='Saldo inicial importado' en payments. Este script mide alrededor de
 * ese contrato frágil para poder detectar cualquier alteración silenciosa.
 *
 * Uso:
 *   node scripts/verify-historical-integrity.js                 # imprime reporte
 *   node scripts/verify-historical-integrity.js --json          # emite JSON
 *   node scripts/verify-historical-integrity.js --baseline f.json   # guarda snapshot
 *   node scripts/verify-historical-integrity.js --compare  f.json   # compara vs snapshot
 *   node scripts/verify-historical-integrity.js --db /ruta/velo.db  # BD explícita
 *
 * Variables de entorno equivalentes: VELO_DB_PATH.
 * Exit code: 0 = OK / sin diferencias; 1 = diferencias detectadas o error.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const HISTORICAL_MARKER = 'Importación histórica';
const INITIAL_BALANCE_NOTE = 'Saldo inicial importado';

// ── Args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const asJson = args.includes('--json');
const baselineOut = argVal('--baseline');
const compareIn = argVal('--compare');

// ── Resolver ruta de la BD (misma lógica que la app: dev usa ./data) ──
function resolveDbPath() {
  const explicit = argVal('--db') || process.env.VELO_DB_PATH;
  if (explicit) return path.resolve(explicit);
  return path.join(__dirname, '..', 'data', 'velo.db');
}

const DB_PATH = resolveDbPath();
if (!fs.existsSync(DB_PATH)) {
  console.error(`[integrity] No se encontró la BD en: ${DB_PATH}`);
  console.error('Usa --db <ruta> o la variable VELO_DB_PATH.');
  process.exit(1);
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[integrity] No se pudo abrir la BD (readonly): ${e.message}`);
  process.exit(1);
}

// ── Helpers de consulta seguros (tolerantes a tablas ausentes) ────────
function scalar(sql, params = []) {
  try {
    const row = db.prepare(sql).get(...params);
    if (!row) return 0;
    const v = Object.values(row)[0];
    return v == null ? 0 : v;
  } catch {
    return null; // tabla/columna ausente en esta BD
  }
}
function round2(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : n;
}
function fingerprint(sql, params = []) {
  try {
    const rows = db.prepare(sql).all(...params);
    const blob = rows.map((r) => Object.values(r).join('|')).join('\n');
    return crypto.createHash('sha256').update(blob).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ── Métricas (invariantes que la refactorización NO debe cambiar) ─────
const M = HISTORICAL_MARKER;

const metrics = {
  // Conteos base
  customers:            scalar('SELECT COUNT(*) FROM customers'),
  products:             scalar('SELECT COUNT(*) FROM products'),
  sales_total:          scalar('SELECT COUNT(*) FROM sales'),
  sales_historical:     scalar('SELECT COUNT(*) FROM sales WHERE cajero=?', [M]),
  sales_live:           scalar('SELECT COUNT(*) FROM sales WHERE cajero!=?', [M]),
  sale_items:           scalar('SELECT COUNT(*) FROM sale_items'),
  payments_total:       scalar('SELECT COUNT(*) FROM payments'),
  payments_historical:  scalar('SELECT COUNT(*) FROM payments WHERE cajero=?', [M]),
  payments_initial_bal: scalar('SELECT COUNT(*) FROM payments WHERE note=?', [INITIAL_BALANCE_NOTE]),
  inventory_movements:  scalar('SELECT COUNT(*) FROM inventory_movements'),

  // Sumas financieras (deben permanecer idénticas)
  sum_sales_total:            round2(scalar('SELECT COALESCE(SUM(total),0) FROM sales')),
  sum_sales_hist_total:       round2(scalar('SELECT COALESCE(SUM(total),0) FROM sales WHERE cajero=?', [M])),
  sum_sales_completed_total:  round2(scalar("SELECT COALESCE(SUM(total),0) FROM sales WHERE status='completed'")),
  sum_payments_amount:        round2(scalar('SELECT COALESCE(SUM(amount),0) FROM payments')),
  sum_payments_hist_amount:   round2(scalar('SELECT COALESCE(SUM(amount),0) FROM payments WHERE cajero=?', [M])),
  cxc_customer_balance:       round2(scalar('SELECT COALESCE(SUM(balance),0) FROM customers WHERE balance>0')),

  // Integridad relacional (huérfanos: idealmente 0 y siempre constante)
  orphan_sale_items:      scalar('SELECT COUNT(*) FROM sale_items si LEFT JOIN sales s ON si.sale_id=s.id WHERE s.id IS NULL'),
  orphan_sale_customer:   scalar('SELECT COUNT(*) FROM sales s WHERE s.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=s.customer_id)'),
  orphan_pay_customer:    scalar('SELECT COUNT(*) FROM payments p WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=p.customer_id)'),
  orphan_pay_sale:        scalar('SELECT COUNT(*) FROM payments p WHERE p.sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id=p.sale_id)'),

  // Huellas digitales (cualquier mutación de un registro histórico cambia el hash)
  fp_hist_sales:    fingerprint('SELECT id,total,COALESCE(created_at,\'\'),COALESCE(ncf,\'\') FROM sales WHERE cajero=? ORDER BY id', [M]),
  fp_hist_payments: fingerprint('SELECT id,customer_id,amount,COALESCE(note,\'\') FROM payments WHERE cajero=? ORDER BY id', [M]),
  fp_customers_bal: fingerprint('SELECT id,balance FROM customers ORDER BY id'),
};

db.close();

const report = {
  generated_at: new Date().toISOString(),
  db_path: DB_PATH,
  historical_marker: HISTORICAL_MARKER,
  metrics,
};

// ── Modo comparación ──────────────────────────────────────────────────
if (compareIn) {
  const prev = JSON.parse(fs.readFileSync(path.resolve(compareIn), 'utf8'));
  const diffs = [];
  for (const key of Object.keys(metrics)) {
    const a = prev.metrics ? prev.metrics[key] : undefined;
    const b = metrics[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ key, before: a, after: b });
  }
  if (diffs.length === 0) {
    console.log('✓ INTEGRIDAD OK — ninguna métrica histórica cambió.');
    console.log(`  Base: ${compareIn}`);
    process.exit(0);
  }
  console.error('✗ DIFERENCIAS DETECTADAS — la refactorización alteró data/relaciones:');
  for (const d of diffs) {
    console.error(`  - ${d.key}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`);
  }
  process.exit(1);
}

// ── Modo baseline / salida ────────────────────────────────────────────
if (baselineOut) {
  fs.writeFileSync(path.resolve(baselineOut), JSON.stringify(report, null, 2));
  console.log(`✓ Baseline guardado en: ${baselineOut}`);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('════════════════════════════════════════════════════════');
  console.log(' VELO POS — Integridad de data histórica (solo lectura)');
  console.log('════════════════════════════════════════════════════════');
  console.log(` BD: ${DB_PATH}`);
  console.log('');
  const pad = (k) => k.padEnd(26);
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`  ${pad(k)} ${v == null ? '(n/d)' : v}`);
  }
  console.log('');
  const flags = [];
  if (metrics.orphan_sale_items)    flags.push(`sale_items huérfanos: ${metrics.orphan_sale_items}`);
  if (metrics.orphan_sale_customer) flags.push(`ventas sin cliente: ${metrics.orphan_sale_customer}`);
  if (metrics.orphan_pay_customer)  flags.push(`pagos sin cliente: ${metrics.orphan_pay_customer}`);
  if (metrics.orphan_pay_sale)      flags.push(`pagos sin venta: ${metrics.orphan_pay_sale}`);
  if (flags.length) {
    console.log('  ⚠ Inconsistencias relacionales preexistentes:');
    flags.forEach((f) => console.log(`     - ${f}`));
  } else {
    console.log('  ✓ Sin huérfanos relacionales.');
  }
  console.log('════════════════════════════════════════════════════════');
}
