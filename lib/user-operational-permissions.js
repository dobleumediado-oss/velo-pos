'use strict';

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

function isAdminUser(user) {
  return !!user && ADMIN_ROLES.has(String(user.role || '').toLowerCase());
}

function flagEnabled(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeCreditLimit(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : 0;
}

function canManageInventory(user) {
  return isAdminUser(user) || flagEnabled(user?.can_manage_inventory, false);
}

function canSellOnCredit(user) {
  if (isAdminUser(user)) return true;
  // Las instalaciones anteriores ya permitían crédito al cajero. Si la columna
  // aún no existe durante una actualización, se conserva ese comportamiento.
  return flagEnabled(user?.can_sell_credit, true);
}

function evaluateCreditPermission(user, exposure) {
  const amount = normalizeCreditLimit(exposure);
  if (!user) {
    return { allowed: false, code: 'INVALID_USER', exposure: amount, limit: 0 };
  }
  if (isAdminUser(user)) {
    return { allowed: true, code: 'ADMIN', exposure: amount, limit: 0, unlimited: true };
  }
  if (!canSellOnCredit(user)) {
    return { allowed: false, code: 'CREDIT_DISABLED', exposure: amount, limit: 0 };
  }
  const limit = normalizeCreditLimit(user.credit_limit_per_sale);
  // Cero conserva el modo sin tope usado antes de introducir este permiso.
  if (limit <= 0) {
    return { allowed: true, code: 'UNLIMITED', exposure: amount, limit: 0, unlimited: true };
  }
  if (amount > limit + 0.005) {
    return { allowed: false, code: 'LIMIT_EXCEEDED', exposure: amount, limit };
  }
  return { allowed: true, code: 'WITHIN_LIMIT', exposure: amount, limit };
}

function formatDop(value) {
  return `RD$${normalizeCreditLimit(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function assertCreditPermission(user, exposure) {
  const result = evaluateCreditPermission(user, exposure);
  if (result.allowed) return result;
  if (result.code === 'CREDIT_DISABLED') {
    throw new Error('Este usuario de caja no tiene permiso para realizar ventas a crédito');
  }
  if (result.code === 'LIMIT_EXCEEDED') {
    throw new Error(
      `El crédito de esta factura (${formatDop(result.exposure)}) supera el límite del usuario (${formatDop(result.limit)})`,
    );
  }
  throw new Error('Usuario no válido para realizar la venta a crédito');
}

module.exports = {
  isAdminUser,
  canManageInventory,
  canSellOnCredit,
  normalizeCreditLimit,
  evaluateCreditPermission,
  assertCreditPermission,
};
