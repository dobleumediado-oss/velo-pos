'use strict';

// ════════════════════════════════════════════════════════════════════════════
// Resolver del vertical activo (VELO SUITE)
// ────────────────────────────────────────────────────────────────────────────
// Punto ÚNICO donde el core pregunta "¿qué rubro soy?". La identidad la fija el
// build de cada producto vía la variable de entorno `VELO_VERTICAL`
// (electron-builder-*.extraMetadata → runtime). Sin build de suite todavía, el
// default es `auto_parts` → VELO POS se comporta idéntico.
//
// El valor COMPILADO manda: un binario VELO POS es siempre `auto_parts`, sin
// importar qué diga un setting. `settings.business_vertical` es solo un espejo
// para consultas de datos (lo escribe main en el arranque).
// ════════════════════════════════════════════════════════════════════════════

const VERTICALS = {
  auto_parts: require('./auto-parts'),
  // El vertical 'tech' (VELO TECH POS) se registra aquí en la fase R4.
};

const DEFAULT_VERTICAL = 'auto_parts';

function activeVerticalId() {
  const fromEnv = String(process.env.VELO_VERTICAL || '').trim();
  return VERTICALS[fromEnv] ? fromEnv : DEFAULT_VERTICAL;
}

function getActiveVertical() {
  return VERTICALS[activeVerticalId()];
}

module.exports = {
  activeVerticalId,
  getActiveVertical,
  DEFAULT_VERTICAL,
  // Expuesto para pruebas / futuros verticales.
  _all: VERTICALS,
};
