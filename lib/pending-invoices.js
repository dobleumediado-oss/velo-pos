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

  const saleColumns = new Set(db.prepare('PRAGMA table_info(sales)').all().map(column => column.name));
  const paymentColumns = new Set(
    db.prepare('PRAGMA table_info(payments)').all().map(column => column.name)
  );
  const hasPaymentStatus = paymentColumns.has('status');
  const directPaymentActive = hasPaymentStatus
    ? "AND COALESCE(p.status,'active')='active'" : '';
  const allocatedPaymentActive = hasPaymentStatus
    ? "AND COALESCE(ap.status,'active')='active'" : '';
  const hasAllocations = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payment_allocations'"
  ).get();
  const legacyPaymentOnly = hasAllocations
    ? 'AND NOT EXISTS (SELECT 1 FROM payment_allocations pa0 WHERE pa0.payment_id=p.id)'
    : '';
  const allocatedAfterMigration = hasAllocations ? `
               - COALESCE((
                 SELECT SUM(pa.amount)
                 FROM payment_allocations pa
                 JOIN payments ap ON ap.id=pa.payment_id
                 WHERE pa.sale_id=s.id
                   ${allocatedPaymentActive}
                   AND COALESCE(ap.import_source,'')!='equiparts_bak'
                   AND COALESCE(ap.cajero,'')!='Importación histórica'
               ), 0)` : '';
  const allocatedAll = hasAllocations ? `
               - COALESCE((
                 SELECT SUM(pa.amount)
                 FROM payment_allocations pa
                 JOIN payments ap ON ap.id=pa.payment_id
                 WHERE pa.sale_id=s.id
                   ${allocatedPaymentActive}
               ), 0)` : '';
  const contactSelect = [
    ['customer_contact_id', 'NULL'],
    ['customer_contact_name', "''"],
    ['customer_contact_document', "''"],
    ['customer_contact_role', "''"],
    ['customer_contact_phone', "''"],
    ['customer_contact_email', "''"],
  ].map(([column, fallback]) => saleColumns.has(column)
    ? `s.${column}` : `${fallback} AS ${column}`).join(',\n           ');
  const documentSelect = [
    ['document_kind', "''"],
    ['document_number', 'NULL'],
    ['document_number_fmt', "''"],
    ['old_id_factura', 'NULL'],
    ['import_source', "''"],
    ['correction_kind', "''"],
    ['original_sale_id', 'NULL'],
    ['revision', '0'],
  ].map(([column, fallback]) => saleColumns.has(column)
    ? `s.${column}` : `${fallback} AS ${column}`).join(',\n           ');

  const sales = db.prepare(`
    SELECT s.id, s.total, s.subtotal, s.tax_amt, s.discount_amt,
           s.created_at, s.notes, s.ncf, s.status,
           ${documentSelect},
           s.numero_factura, s.numero_factura_fmt, s.source_balance,
           ${contactSelect},
           CASE
             -- source_balance ya representa el saldo que llegó de Equiparts.
             -- Solo restar aquí los abonos posteriores a la migración; los
             -- pagos históricos ya fueron usados para calcular ese saldo.
             WHEN s.source_balance IS NOT NULL THEN MAX(0, ROUND(
               s.source_balance - COALESCE((
                 SELECT SUM(p.amount) FROM payments p
                 WHERE p.sale_id=s.id
                   ${directPaymentActive}
                   AND COALESCE(p.import_source,'')!='equiparts_bak'
                   AND COALESCE(p.cajero,'')!='Importación histórica'
                   ${legacyPaymentOnly}
               ), 0)
               ${allocatedAfterMigration}, 2))
             -- Sin source_balance, el total facturado menos TODOS los pagos
             -- vinculados es la capacidad pendiente real de la factura.
             ELSE MAX(0, ROUND(
               s.total - COALESCE((
                 SELECT SUM(p.amount) FROM payments p
                 WHERE p.sale_id=s.id
                   ${directPaymentActive}
                   ${legacyPaymentOnly}
               ), 0)
               ${allocatedAll}, 2))
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
