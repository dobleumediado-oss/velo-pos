// ══════════════════════════════════════════════
// lib/pending-invoices.js — Distribución FIFO del saldo de clientes
//
// El balance de customers es la fuente de verdad de CxC: ventas a crédito,
// abonos, devoluciones e importaciones lo actualizan. Para reconstruir las
// facturas abiertas, el saldo vigente se asigna desde la factura más reciente
// hacia atrás; esto equivale a haber aplicado los abonos FIFO a las antiguas.
// Las migraciones pueden proporcionar `pending_capacity` para limitar cada
// factura a su saldo real de origen en vez de usar el total facturado.
// ══════════════════════════════════════════════
'use strict';

const { round2 } = require('./money');

function allocatePendingInvoices(sales, customerBalance) {
  const invoices = Array.isArray(sales) ? sales : [];
  let remaining = Math.max(0, round2(Number(customerBalance) || 0));
  const allocated = new Array(invoices.length);

  // Las ventas llegan ASC. Reservar el saldo en las más nuevas deja las más
  // antiguas pagadas primero (FIFO), sin volver a restar el historial de abonos.
  for (let i = invoices.length - 1; i >= 0; i--) {
    const rawCapacity = invoices[i]?.pending_capacity ?? invoices[i]?.source_balance ?? invoices[i]?.total;
    const capacity = Math.max(0, round2(Number(rawCapacity) || 0));
    const pendiente = Math.min(remaining, capacity);
    remaining = Math.max(0, round2(remaining - pendiente));
    allocated[i] = { ...invoices[i], pendiente: round2(pendiente) };
  }

  return {
    facturas: allocated.filter(f => f.pendiente > 0.005).reverse(),
    unallocatedBalance: round2(remaining),
  };
}

function getPendingInvoices(db, customerId) {
  const customer = db.prepare('SELECT balance FROM customers WHERE id=?').get(customerId);
  if (!customer) throw new Error('Cliente no encontrado');

  const sales = db.prepare(`
    SELECT s.id, s.total, s.subtotal, s.tax_amt, s.discount_amt,
           s.created_at, s.notes, s.ncf, s.status,
           s.numero_factura, s.numero_factura_fmt, s.source_balance,
           CASE
             WHEN s.source_balance IS NOT NULL THEN MAX(0, s.source_balance)
             WHEN s.import_source='equiparts_bak' THEN MAX(0, ROUND(
               s.total - COALESCE((
                 SELECT SUM(p.amount) FROM payments p
                 WHERE p.sale_id=s.id
                   AND (p.import_source='equiparts_bak' OR p.cajero='Importación histórica')
               ), 0), 2))
             ELSE s.total
           END AS pending_capacity
    FROM sales s
    WHERE s.customer_id=?
      AND LOWER(TRIM(s.payment_method)) IN ('credito','crédito','credit')
      AND s.status!='cancelled' AND s.type='factura'
    ORDER BY s.created_at ASC, s.id ASC
  `).all(customerId);

  return allocatePendingInvoices(sales, customer.balance);
}

module.exports = { allocatePendingInvoices, getPendingInvoices };
