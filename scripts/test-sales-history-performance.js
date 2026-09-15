#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const ok = (condition, message) => {
  if (!condition) {
    console.error('  ✗', message);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log('  ✓', message);
};

const tempDir = path.join(os.tmpdir(), `velo_sales_history_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();

try {
  console.log('\n== Historial paginado de Ventas ==');
  const insertSale = db.prepare(`
    INSERT INTO sales(
      customer_name,customer_rnc,type,status,subtotal,total,payment_method,
      document_number_fmt,numero_factura_fmt,original_sale_date,sale_date,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sale_items(
      sale_id,product_code,product_name,unit_cost,unit_price,qty,subtotal
    ) VALUES(?,?,?,?,?,?,?)
  `);
  const currentMonth = db.prepare("SELECT strftime('%Y-%m','now','localtime') AS value").get().value;
  const seed = db.transaction(() => {
    for (let i = 1; i <= 2500; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      const date = i > 1250 ? `${currentMonth}-${day}` : `2025-${month}-${day}`;
      const name = i === 17 ? 'CLIENTE BUSQUEDA PROFUNDA' : `CLIENTE ${i}`;
      const code = i === 17 ? 'CODIGO-PROFUNDO' : `SKU-${i}`;
      const result = insertSale.run(
        name, `RNC-${i}`, 'factura', 'completed', 100, 118, 'efectivo',
        `FAC-${String(i).padStart(7, '0')}`, `#${String(i).padStart(8, '0')}`,
        date, date, `${date} 12:00:00`
      );
      insertItem.run(result.lastInsertRowid, code, `PRODUCTO ${i}`, 50, 118, 1, 118);
    }
    const quote = insertSale.run(
      'CLIENTE COTIZACION', 'RNC-COT', 'cotizacion', 'completed', 50, 50,
      'efectivo', 'COT-0000001', '', '2026-09-15', '2026-09-15', '2026-09-15 12:00:00'
    );
    insertItem.run(quote.lastInsertRowid, 'COT-SKU', 'PRODUCTO COTIZADO', 25, 50, 1, 50);
  });
  seed();

  const before = db.prepare(`
    SELECT COUNT(*) AS sales_count,
           COALESCE(SUM(total),0) AS sales_total,
           (SELECT COUNT(*) FROM sale_items) AS item_count
    FROM sales
  `).get();

  const started = process.hrtime.bigint();
  const page = DB.salesRepo.getAll({ range:'all', view:'sales', limit:100, offset:0 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const countedSales = DB.salesRepo.countAll({ range:'all', view:'sales' });
  const expectedSales = db.prepare(`
    SELECT COUNT(*) AS n FROM sales
    WHERE status!='cancelled' AND type!='cotizacion' AND type!='devolucion'
      AND NOT (
        correction_kind='product_addition'
        AND original_sale_id IS NOT NULL
      )
  `).get().n;
  ok(page.length === 100, '“Ver todas” trae solo la página solicitada');
  ok(countedSales === expectedSales,
    `el contador conserva el total completo sin renderizarlo (${countedSales}/${expectedSales})`);
  ok(elapsedMs < 1000, `primera página queda bajo 1 s (${elapsedMs.toFixed(1)} ms)`);

  const monthStarted = process.hrtime.bigint();
  const monthPage = DB.salesRepo.getAll({ range:'month', view:'sales', limit:100, offset:0 });
  const monthElapsedMs = Number(process.hrtime.bigint() - monthStarted) / 1e6;
  ok(monthPage.length === 100 && DB.salesRepo.countAll({ range:'month', view:'sales' }) >= 1250,
    '“Este mes” también pagina un período con más de mil facturas');
  ok(monthElapsedMs < 1000, `“Este mes” queda bajo 1 s (${monthElapsedMs.toFixed(1)} ms)`);

  const deepByCustomer = DB.salesRepo.getAll({
    range:'all', view:'sales', q:'BUSQUEDA PROFUNDA', limit:100, offset:0,
  });
  ok(deepByCustomer.length === 1 && deepByCustomer[0].customer_name === 'CLIENTE BUSQUEDA PROFUNDA',
    'la búsqueda consulta todo el historial, no solo la página visible');
  const deepByProduct = DB.salesRepo.getAll({
    range:'all', view:'sales', q:'CODIGO-PROFUNDO', limit:100, offset:0,
  });
  ok(deepByProduct.length === 1 && deepByProduct[0].items_summary.includes('PRODUCTO 17'),
    'la búsqueda profunda encuentra códigos de artículos antiguos');

  const quotes = DB.salesRepo.getAll({ range:'all', view:'quotes', limit:100, offset:0 });
  ok(quotes.length === 1 && quotes[0].type === 'cotizacion',
    'Cotizaciones usa el mismo paginado sin mezclarse con facturas');

  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM sales
    WHERE status!='cancelled' AND type!='cotizacion'
    ORDER BY sale_date DESC,id DESC LIMIT 100 OFFSET 0
  `).all().map(row => row.detail).join(' | ');
  console.log('  · Plan:', plan);
  ok(plan.includes('idx_sales_sale_date'), 'SQLite usa el índice de fecha para formar la página');

  const after = db.prepare(`
    SELECT COUNT(*) AS sales_count,
           COALESCE(SUM(total),0) AS sales_total,
           (SELECT COUNT(*) FROM sale_items) AS item_count
    FROM sales
  `).get();
  ok(JSON.stringify(after) === JSON.stringify(before),
    'consultar, contar y buscar no modifica ventas, totales ni artículos');

  const ui = fs.readFileSync(path.join(__dirname, '../src/js/ventas.js'), 'utf8');
  ok(ui.includes('const VENTAS_PAGE_SIZE = 100') && ui.includes('ventasGoToPage'),
    'la pantalla limita el render a 100 documentos y ofrece navegación');
  ok(ui.includes('async function ventasRowsForExport') && ui.includes('const pageSize = 500'),
    'PDF y Excel reúnen el filtro completo por lotes sin repintar miles de filas');
  console.log(`\n== RESULTADO: ${passed} OK · ${elapsedMs.toFixed(1)} ms ==`);
} finally {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive:true, force:true });
}
