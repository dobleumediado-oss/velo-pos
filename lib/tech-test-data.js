'use strict';
// ══════════════════════════════════════════════
// tech-test-data.js — Retirar datos de prueba de VELO TECH en un negocio VELO POS
//   Decisión del dueño (7 nov 2026): VELO POS no maneja equipos con IMEI; si una base
//   de VELO POS trae un artículo de prueba con IMEI, sus equipos y ventas con equipo,
//   VELO Cloud no la convierte (datos de la otra edición). Anular esas ventas en
//   Desktop no basta: sus líneas siguen apuntando a los equipos.
//   Esta herramienta, solo para VELO POS y solo para superadmin:
//   · exige que toda venta con equipo ya esté ANULADA por el flujo normal de Desktop
//     (así caja, existencia y comprobantes se revierten como siempre);
//   · desengancha los equipos de esas líneas anuladas, retira los equipos, deja el
//     artículo sin IMEI e inactivo;
//   · se niega si hay taller, recepciones de usados o compras de equipos (datos de
//     TECH que no son de prueba simple);
//   · todo en una transacción, con respaldo previo (lo hace quien la llama) y auditoría.
// ══════════════════════════════════════════════

const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const count = (db, sql, ...args) => Number(db.prepare(sql).get(...args)?.n || 0);

// Tablas de VELO TECH que esta herramienta no limpia: si tienen filas, se resuelve aparte.
const OTHER_TECH_TABLES = ['service_orders', 'trade_ins', 'tech_private_purchases', 'service_technicians',
  'tech_device_models', 'tech_product_compatibility', 'tech_description_templates', 'service_appointments'];

function techTestDataStatus(db) {
  const units = has(db, 'product_units') ? count(db, 'SELECT COUNT(*) AS n FROM product_units') : 0;
  const serialized = count(db, 'SELECT COUNT(*) AS n FROM products WHERE serialized=1');
  const unitLines = count(db, 'SELECT COUNT(*) AS n FROM sale_items WHERE product_unit_id IS NOT NULL');
  const activeSales = db.prepare(`SELECT DISTINCT s.id, COALESCE(NULLIF(s.document_number_fmt,''), NULLIF(s.numero_factura_fmt,''), '#' || s.id) AS number
    FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE si.product_unit_id IS NOT NULL AND s.status != 'cancelled' ORDER BY s.id`).all();
  const tradeIns = count(db, 'SELECT COUNT(*) AS n FROM sales WHERE trade_in_unit_id IS NOT NULL');
  const otherTables = OTHER_TECH_TABLES.filter(table => has(db, table)).map(table => ({ table, rows: count(db, `SELECT COUNT(*) AS n FROM ${table}`) })).filter(row => row.rows > 0);
  if (tradeIns) otherTables.push({ table: 'sales.trade_in_unit_id', rows: tradeIns });
  const present = units + serialized + unitLines > 0;
  const blockers = [
    ...(activeSales.length ? [`Anula primero ${activeSales.length === 1 ? 'la venta' : 'las ventas'} con equipo: ${activeSales.map(row => row.number).join(', ')}`] : []),
    ...otherTables.map(row => `Hay datos de VELO TECH en ${row.table} (${row.rows}); esta herramienta no los retira`),
  ];
  return { present, serializedProducts: serialized, units, unitLines, activeSales, otherTables, blockers, canRetire: present && !blockers.length };
}

// Retira los datos de prueba. Se llama dentro del proceso principal después del respaldo.
function retireTechTestData(db) {
  const status = techTestDataStatus(db);
  if (!status.present) throw new Error('No hay datos de prueba de VELO TECH en este negocio');
  if (status.blockers.length) throw new Error(status.blockers.join('. '));
  return db.transaction(() => {
    const products = db.prepare('SELECT id FROM products WHERE serialized=1').all().map(row => row.id);
    // Solo líneas de ventas anuladas (comprobado arriba): su equipo deja de figurar en la línea.
    const lines = db.prepare(`UPDATE sale_items SET product_unit_id=NULL WHERE product_unit_id IS NOT NULL
      AND sale_id IN (SELECT id FROM sales WHERE status='cancelled')`).run().changes;
    if (count(db, 'SELECT COUNT(*) AS n FROM sale_items WHERE product_unit_id IS NOT NULL')) throw new Error('Quedan líneas de venta con equipo');
    const countLines = has(db, 'inventory_count_lines') ? db.prepare('UPDATE inventory_count_lines SET unit_id=NULL WHERE unit_id IS NOT NULL').run().changes : 0;
    const missing = has(db, 'inventory_unit_missing') ? db.prepare('DELETE FROM inventory_unit_missing').run().changes : 0;
    const units = has(db, 'product_units') ? db.prepare('DELETE FROM product_units').run().changes : 0;
    const placeholders = products.map(() => '?').join(',');
    const articles = products.length ? db.prepare(`UPDATE products SET serialized=0, active=0 WHERE id IN (${placeholders})`).run(...products).changes : 0;
    const after = techTestDataStatus(db);
    if (after.present) throw new Error('No se pudieron retirar todos los datos de prueba');
    return { lines, countLines, missing, units, articles };
  })();
}

module.exports = { techTestDataStatus, retireTechTestData, OTHER_TECH_TABLES };
