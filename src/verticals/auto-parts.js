'use strict';

// ════════════════════════════════════════════════════════════════════════════
// Vertical pack — Auto-repuestos (VELO POS)
// ────────────────────────────────────────────────────────────────────────────
// El rubro por defecto de la suite. Captura QUÉ hace distinto a este producto,
// sin bifurcar el core. En R0 solo declara identidad y el flag de modelo de
// producto; `theme`, `terminology` y `modules` se pueblan en fases posteriores
// (R1/R2/R4) — hoy la app sigue usando sus valores fijos, así que declararlos
// aquí en null/vacío NO cambia comportamiento.
//
// Regla: la identidad del producto (appId/name) la fija el build; se repite aquí
// solo como referencia legible. La autoridad de compatibilidad es
// scripts/test-suite-invariants.js.
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  id: 'auto_parts',

  // Identidad del producto (referencia; el build es la autoridad — ver
  // package.json.build / electron-builder-terminal.js).
  product: {
    appId: 'do.velopos.app',
    name:  'Velo POS',
  },

  // Modelo de producto: auto-repuestos es inventario fungible (stock numérico).
  // Con serialized=false, `product_units` (R3) queda inactiva y el flujo de
  // venta es idéntico al actual.
  serialized: false,

  // R1 — paleta de tema. null = usar la paleta fija actual (sin cambio visual).
  theme: null,

  // R2 — terminología por rubro. Vacío = usar los labels actuales (fallback).
  terminology: {},

  // R2/R4 — set de módulos encendidos por defecto para este rubro. Vacío = no
  // altera el gateo actual por `settings.module_*`.
  modules: {},
};
