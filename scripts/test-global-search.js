#!/usr/bin/env node
'use strict';

// Regresión y medición del buscador global. Usa exclusivamente una base
// temporal sintética; nunca abre data/velo.db.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const { searchNorm, digitsOf } = require('../lib/text-normalize');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-global-search-'));
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

const TARGET_ID = 2388;
const TARGET_NAME = 'José Peña Núñez';
const TARGET_NCF = 'B0200000407';
const ROWS = 6000;

function queryLabel(sql) {
  const compact = String(sql).replace(/\s+/g, ' ').trim();
  if (/SELECT DISTINCT s\.id FROM sales s/i.test(compact)) return 'cabeceras';
  if (/SELECT DISTINCT si\.sale_id AS id/i.test(compact)) return 'artículos';
  if (/SELECT s\.\*,/i.test(compact)) return 'detalle';
  return compact.slice(0, 55);
}

function seed() {
  const insertSale = db.prepare(`
    INSERT INTO sales(
      customer_name,type,status,subtotal,total,payment_method,ncf,
      document_number_fmt,numero_factura,numero_factura_fmt,
      original_sale_date,sale_date,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sale_items(
      sale_id,product_code,product_name,unit_cost,unit_price,qty,subtotal
    ) VALUES(?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (let index = 1; index <= ROWS; index += 1) {
      const number = String(index).padStart(8, '0');
      const isTarget = index === TARGET_ID;
      const customer = isTarget ? TARGET_NAME : `CLIENTE SINTÉTICO ${index}`;
      const ncf = isTarget ? TARGET_NCF : null;
      const created = insertSale.run(
        customer, 'factura', 'completed', 100, 118, 'efectivo', ncf,
        `EQP-${number}`, index, number,
        '2026-09-15', '2026-09-15', '2026-09-15 12:00:00'
      );
      insertItem.run(created.lastInsertRowid, `SKU-${index}`, `PRODUCTO ${index}`, 50, 118, 1, 118);
    }
  })();
}

function createRendererHarness() {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/js/app.js'), 'utf8');
  const start = appSource.indexOf('let _gSearchSeq = 0;');
  const end = appSource.indexOf('async function _openVentaGlobal(', start);
  assert(start >= 0 && end > start, 'No se encontró el bloque del buscador global');

  let latestRows = [];
  let latestQueries = [];
  let tracing = false;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (tracing) latestQueries.push(queryLabel(sql));
    return originalPrepare(sql);
  };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    searchNorm,
    digitsOf,
    matchText: (value, normalizedQuery) => searchNorm(value).includes(normalizedQuery),
    matchDigits: (value, queryDigits) => !!queryDigits && digitsOf(value).includes(queryDigits),
    DB: { products: [], customers: [], sales: [] },
    user: { role: 'admin' },
    document: { querySelectorAll: () => [] },
    _escHtml: value => String(value ?? ''),
    svg: () => '',
    fmt: value => `RD$${Number(value || 0).toFixed(2)}`,
    fdate: value => value,
    facturaLabel: sale => `#${sale.numero_factura_fmt || sale.id}`,
    window: {
      VeloExperience: {},
      api: { sales: { search: async args => {
        latestQueries = [];
        tracing = true;
        try {
          latestRows = DB.salesRepo.search(args.q, args.limit, args.productIds);
          return latestRows;
        } finally {
          tracing = false;
        }
      } } },
    },
  });
  vm.runInContext(appSource.slice(start, end), context, { filename: 'app-global-search.js' });

  async function measure(query) {
    const started = performance.now();
    let writes = 0;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Tiempo agotado buscando ${query}`)), 5000);
      const results = {
        get innerHTML() { return this._html || ''; },
        set innerHTML(value) {
          this._html = value;
          writes += 1;
          if (writes < 2) return; // primero pinta “Buscando…”, luego resultados
          clearTimeout(timeout);
          resolve({
            query,
            elapsedMs: performance.now() - started,
            queries: [...latestQueries],
            ids: latestRows.map(row => Number(row.id)),
          });
        },
      };
      context._queueGSearch(query, results);
    });
  }

  return { measure, restore: () => { db.prepare = originalPrepare; } };
}

(async () => {
  try {
    seed();
    const harness = createRendererHarness();
    const cases = [
      { query: '00002388', expected: TARGET_ID, reason: 'número completo con ceros' },
      { query: '2388', expected: TARGET_ID, reason: 'número sin ceros' },
      { query: TARGET_NCF, expected: TARGET_ID, reason: 'NCF completo' },
      { query: TARGET_NAME, expected: TARGET_ID, reason: 'nombre con tilde y Ñ' },
      { query: 'Jose Pena', expected: TARGET_ID, reason: 'nombre equivalente sin tildes' },
      { query: 'pena', expected: TARGET_ID, reason: 'fragmento normalizado del nombre' },
    ];
    const measurements = [];
    for (const item of cases) {
      const measured = await harness.measure(item.query);
      measurements.push({
        ...measured,
        expected: item.expected,
        reason: item.reason,
        found: measured.ids.includes(item.expected),
      });
    }
    harness.restore();

    console.log('\n== Buscador global: tecla → resultados pintados ==');
    console.table(measurements.map(row => ({
      búsqueda: row.query,
      esperaba: `#${row.expected}`,
      devolvió: row.ids.length ? row.ids.slice(0, 3).map(id => `#${id}`).join(', ') : 'sin resultados',
      correcto: row.found ? 'sí' : 'NO',
      consultas: row.queries.join(' → ') || 'ninguna',
      ms: row.elapsedMs.toFixed(1),
    })));

    for (const row of measurements) {
      assert(row.found, `${row.reason}: ${row.query} debe devolver #${row.expected}`);
      assert(row.elapsedMs < 300,
        `${row.reason}: debe pintar en menos de 300 ms (${row.elapsedMs.toFixed(1)} ms)`);
    }
    console.log('✓ Búsqueda global correcta y dentro del presupuesto local');
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
