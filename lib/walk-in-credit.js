// Compras de paso: cuenta interna exclusiva de una factura, fuera del directorio.
'use strict';
function ensureWalkInCreditSchema(db) {
  for (const [table, column, definition] of [
    ['customers', 'is_walk_in', 'INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'is_walk_in_credit', 'INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'walk_in_due_date', 'TEXT'],
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_walk_in ON customers(is_walk_in,active)');
}
function validateWalkInCredit(customer, payment, type) {
  if (!payment.walkInCredit) return false;
  if (type !== 'factura' || payment.method !== 'credito' || Number(customer?.id || 1) !== 1) {
    throw new Error('El saldo de compra de paso requiere una factura a crédito sin cliente habitual');
  }
  const name = String(customer?.name || '').trim();
  if (!name || /^consumidor final$/i.test(name) || name.length > 160) {
    throw new Error('Escribe el nombre del comprador de paso (máximo 160 caracteres)');
  }
  if (!(Number(payment.initialPaymentAmount) > 0) || !Number.isFinite(Number(payment.initialPaymentAmount))) {
    throw new Error('La compra de paso requiere un abono inicial mayor a cero');
  }
  const date = String(payment.walkInDueDate || '');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date + 'T12:00:00Z')) ||
      new Date(date + 'T12:00:00Z').toISOString().slice(0,10) !== date)) {
    throw new Error('La fecha acordada de pago no es válida');
  }
  return true;
}
module.exports = { ensureWalkInCreditSchema, validateWalkInCredit };
