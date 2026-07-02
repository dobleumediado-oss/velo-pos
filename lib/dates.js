// ══════════════════════════════════════════════
// lib/dates.js — Helpers de fecha/hora (proceso main)
// Funciones PURAS usadas por database.js (vencimiento de crédito, sesiones
// de caja, fechas de documentos). Compartido con los tests.
// ══════════════════════════════════════════════
'use strict';

// Fecha de hoy en formato 'YYYY-MM-DD'.
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// Hora actual 'HH:MM' en formato local RD.
function nowStr() {
  return new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
}

// Suma n días a una fecha 'YYYY-MM-DD' y devuelve 'YYYY-MM-DD'.
// Usa mediodía para evitar corrimientos por horario de verano/zona.
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

module.exports = { todayStr, nowStr, addDaysStr };
