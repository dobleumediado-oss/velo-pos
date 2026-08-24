// ════════════════════════════════════════════════════════════════════════════
// cash-close-policy.js — Política pura de apertura y cierre operativo de Caja
// Compartida por el renderer y las pruebas. No consulta DOM, IPC ni base de datos.
// ════════════════════════════════════════════════════════════════════════════

(function cashClosePolicyModule(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VeloCashClosePolicy = api;
})(typeof window !== 'undefined' ? window : null, function createCashClosePolicy() {
  function roleRequiresOpenCash(role) {
    const normalizedRole = String(role || '').trim().toLowerCase();
    return normalizedRole === 'cajero' || normalizedRole === 'admin';
  }

  function parseTimeToMinutes(value) {
    const match = String(value || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function evaluate({
    role,
    cashOpen,
    enabled,
    closeTime,
    now = new Date(),
    reminderMinutes = 5,
  } = {}) {
    const closeAt = parseTimeToMinutes(closeTime);
    const appliesToRole = roleRequiresOpenCash(role);
    const active = enabled === true || String(enabled || '') === '1';
    const configured = active && closeAt !== null;
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    const minutesUntilClose = closeAt === null ? null : closeAt - currentMinute;
    const hasOpenCash = cashOpen === true;

    return {
      appliesToRole,
      configured,
      closeAt,
      minutesUntilClose,
      remind: configured && appliesToRole && hasOpenCash
        && minutesUntilClose > 0
        && minutesUntilClose <= Math.max(1, Number(reminderMinutes) || 5),
      blockExit: configured && appliesToRole && hasOpenCash && minutesUntilClose <= 0,
      dateKey: localDateKey(now),
    };
  }

  return {
    roleRequiresOpenCash,
    parseTimeToMinutes,
    localDateKey,
    evaluate,
  };
});
