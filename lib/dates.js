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

// Hora local estable para SQLite. No usar toLocaleTimeString(): algunas
// plataformas devuelven “a. m./p. m.” y rompen date()/time() en consultas.
function nowStr() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':');
}

// Suma n días a una fecha 'YYYY-MM-DD' y devuelve 'YYYY-MM-DD'.
// Usa mediodía para evitar corrimientos por horario de verano/zona.
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

module.exports = { todayStr, nowStr, addDaysStr };
