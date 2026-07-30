'use strict';

const { round2 } = require('./money');

/**
 * Recalcula los acumulados comerciales de una o todas las sesiones de caja.
 *
 * cash_sessions.sales_total / sales_count son un cache para mostrar resúmenes.
 * La fuente contable real siempre son las facturas vigentes de `sales`.
 * Cotizaciones, devoluciones y documentos anulados no incrementan ese cache.
 *
 * No abre una transacción propia para poder reutilizarse dentro de la
 * transacción que anula una factura y dentro del sistema de migraciones.
 */
function reconcileCashSessionTotals(db, { sessionId = null } = {}) {
  if (!db) throw new Error('Base de datos no disponible');

  const params = [];
  const where = sessionId == null ? '' : 'WHERE cs.id=?';
  if (sessionId != null) params.push(Number(sessionId));

  const sessions = db.prepare(`
    SELECT
      cs.id,
      ROUND(COALESCE(cs.sales_total, 0), 2) AS previous_total,
      COALESCE(cs.sales_count, 0) AS previous_count,
      ROUND(COALESCE((
        SELECT SUM(s.total)
        FROM sales s
        WHERE s.cash_session_id=cs.id
          AND s.type='factura'
          AND COALESCE(s.status, 'completed')!='cancelled'
      ), 0), 2) AS real_total,
      COALESCE((
        SELECT COUNT(*)
        FROM sales s
        WHERE s.cash_session_id=cs.id
          AND s.type='factura'
          AND COALESCE(s.status, 'completed')!='cancelled'
      ), 0) AS real_count
    FROM cash_sessions cs
    ${where}
    ORDER BY cs.id
  `).all(...params);

  const update = db.prepare(`
    UPDATE cash_sessions
    SET sales_total=?, sales_count=?
    WHERE id=?
  `);
  const repairs = [];

  sessions.forEach(session => {
    const previousTotal = round2(session.previous_total);
    const realTotal = round2(session.real_total);
    const previousCount = Number(session.previous_count) || 0;
    const realCount = Number(session.real_count) || 0;
    if (Math.abs(previousTotal - realTotal) <= 0.005 && previousCount === realCount) return;

    update.run(realTotal, realCount, session.id);
    repairs.push({
      sessionId: Number(session.id),
      previousTotal,
      repairedTotal: realTotal,
      previousCount,
      repairedCount: realCount,
    });
  });

  return {
    checked: sessions.length,
    repaired: repairs.length,
    repairs,
  };
}

module.exports = { reconcileCashSessionTotals };
