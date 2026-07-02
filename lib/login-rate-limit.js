// ══════════════════════════════════════════════
// lib/login-rate-limit.js — Rate limiting de login (proceso main)
// Protección anti-fuerza-bruta REAL: vive en Node, no se puede bypassear
// desde el renderer. El estado (intentos por email) es interno al módulo.
// NUNCA se expone al renderer.
// ══════════════════════════════════════════════
'use strict';

const _loginAttempts = new Map(); // email → { count, blockedUntil }
const LOGIN_MAX      = 5;
const LOGIN_BLOCK_MS = 60 * 1000; // 60 segundos de bloqueo tras 5 fallos

// ¿Se permite intentar login para este email ahora?
function checkLoginRate(email) {
  const now = Date.now();
  const rec = _loginAttempts.get(email) || { count: 0, blockedUntil: 0 };
  if (rec.blockedUntil > now) {
    const secsLeft = Math.ceil((rec.blockedUntil - now) / 1000);
    return { allowed: false, secsLeft };
  }
  return { allowed: true, count: rec.count };
}

// Registrar un intento fallido; al llegar al máximo, bloquear temporalmente.
function recordLoginFail(email) {
  const now = Date.now();
  const rec = _loginAttempts.get(email) || { count: 0, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX) {
    rec.blockedUntil = now + LOGIN_BLOCK_MS;
    rec.count        = 0;
  }
  _loginAttempts.set(email, rec);
}

// Login exitoso → limpiar el historial de intentos de ese email.
function clearLoginRate(email) {
  _loginAttempts.delete(email);
}

// Solo para tests: reiniciar el estado interno.
function _reset() {
  _loginAttempts.clear();
}

module.exports = { checkLoginRate, recordLoginFail, clearLoginRate, _reset, LOGIN_MAX, LOGIN_BLOCK_MS };
