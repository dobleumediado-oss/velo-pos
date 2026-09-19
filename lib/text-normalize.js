// ══════════════════════════════════════════════
// lib/text-normalize.js — Normalización de texto para búsqueda (proceso main)
// Funciones PURAS usadas por el buscador global de database.js. Deben quedar
// en paridad con las del frontend (src/js/data.js) para que backend y UI
// normalicen igual (tildes/Ñ, dígitos). Compartido con los tests.
// ══════════════════════════════════════════════
'use strict';

// Quita tildes/diacríticos, pasa a minúsculas y recorta. 'Ñoño' → 'nono'.
// El buscador global la invoca una vez por campo y por fila, siempre sobre los
// mismos textos, así que recuerda lo ya calculado. La tabla se vacía al llegar
// al tope: nunca crece sin techo.
const SEARCH_NORM_CACHE_LIMIT = 20000;
const _searchNormCache = new Map();
function searchNorm(s) {
  const key = String(s == null ? '' : s);
  const remembered = _searchNormCache.get(key);
  if (remembered !== undefined) return remembered;
  const value = key
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
  if (_searchNormCache.size >= SEARCH_NORM_CACHE_LIMIT) _searchNormCache.clear();
  _searchNormCache.set(key, value);
  return value;
}

// Deja solo los dígitos (para buscar por teléfono/RNC). '809-555' → '809555'.
function digitsOf(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

module.exports = { searchNorm, digitsOf };
