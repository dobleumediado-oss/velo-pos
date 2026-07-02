// ══════════════════════════════════════════════
// lib/normalize-financial.js — Normalizadores de dominio (proceso main)
// Transforman filas de la BD al shape que espera la UI. Funciones PURAS
// (sin estado ni acceso a BD). Compartido por main.js y los tests.
// NUNCA se expone al renderer.
// ══════════════════════════════════════════════
'use strict';

// financial_accounts: current_balance → balance, active → is_active (boolean)
function normalizeFinAcct(a) {
  if (!a) return null;
  return { ...a, balance: a.current_balance || 0, is_active: a.active === 1 || a.active === true };
}

// financial_movements: tipos internos de BD → nombres que muestra la UI.
function normalizeFinMov(m) {
  if (!m) return null;
  const typeDisplayMap = {
    deposito: 'ingreso', retiro: 'egreso', transferencia_in: 'transferencia',
    transferencia_out: 'transferencia', venta: 'ingreso', gasto: 'egreso',
    abono_recibido: 'ingreso', pago_proveedor: 'egreso', apertura: 'ingreso', ajuste: 'ajuste',
  };
  const outflows = ['retiro', 'transferencia_out', 'gasto', 'pago_proveedor'];
  return {
    ...m,
    type:       typeDisplayMap[m.type] || m.type,
    db_type:    m.type,
    reference:  m.notes || m.cancel_reason || '',
    is_outflow: outflows.includes(m.type),
  };
}

module.exports = { normalizeFinAcct, normalizeFinMov };
