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
  tech:       require('./tech'),      // VELO TECH POS (R4)
};

const DEFAULT_VERTICAL = 'auto_parts';

function activeVerticalId() {
  // Precedencia: override de dev (env) > valor COMPILADO en el build
  // (package.json.veloVertical, inyectado por electron-builder-*.extraMetadata)
  // > default auto_parts. Un build VELO POS no lleva veloVertical → auto_parts.
  const fromEnv = String(process.env.VELO_VERTICAL || '').trim();
  if (VERTICALS[fromEnv]) return fromEnv;
  try {
    const baked = String(require('../../package.json').veloVertical || '').trim();
    if (VERTICALS[baked]) return baked;
  } catch { /* sin package.json accesible → default */ }
  return DEFAULT_VERTICAL;
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
