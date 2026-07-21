// ══════════════════════════════════════════════
// lib/pending-invoices.js — Distribución FIFO del saldo de clientes
//
// El balance de customers es la fuente de verdad de CxC: ventas a crédito,
// abonos, devoluciones e importaciones lo actualizan. Para reconstruir las
// facturas abiertas, el saldo vigente se asigna desde la factura más reciente
// hacia atrás; esto equivale a haber aplicado los abonos FIFO a las antiguas.
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
    const total = Math.max(0, round2(Number(invoices[i]?.total) || 0));
    const pendiente = Math.min(remaining, total);
    remaining = Math.max(0, round2(remaining - pendiente));
    allocated[i] = { ...invoices[i], pendiente: round2(pendiente) };
  }

  return {
    facturas: allocated.filter(f => f.pendiente > 0.005).reverse(),
    unallocatedBalance: round2(remaining),
  };
}

module.exports = { allocatePendingInvoices };
