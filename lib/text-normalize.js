// ══════════════════════════════════════════════
// lib/text-normalize.js — Normalización de texto para búsqueda (proceso main)
// Funciones PURAS usadas por el buscador global de database.js. Deben quedar
// en paridad con las del frontend (src/js/data.js) para que backend y UI
// normalicen igual (tildes/Ñ, dígitos). Compartido con los tests.
// ══════════════════════════════════════════════
'use strict';

// Quita tildes/diacríticos, pasa a minúsculas y recorta. 'Ñoño' → 'nono'.
function searchNorm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

// Deja solo los dígitos (para buscar por teléfono/RNC). '809-555' → '809555'.
function digitsOf(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

module.exports = { searchNorm, digitsOf };
