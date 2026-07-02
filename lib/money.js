// ══════════════════════════════════════════════
// lib/money.js — Helpers de dinero (proceso main)
// Funciones PURAS. Centraliza el redondeo monetario a 2 decimales, que
// estaba duplicado ~21 veces en database.js. Una sola fuente de verdad
// evita que un cálculo redondee distinto que otro.
// ══════════════════════════════════════════════
'use strict';

// Redondea a 2 decimales (centavos). round2(1.005) → 1.01 (según Math.round).
// IDÉNTICO a la expresión Math.round(n * 100) / 100 usada históricamente.
function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { round2 };
