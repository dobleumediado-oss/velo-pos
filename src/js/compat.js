// ══════════════════════════════════════════════
// compat.js — Capa de compatibilidad
// Provee funciones que los módulos viejos esperan
// IMPORTANTE: cargado ANTES que data.js
// ══════════════════════════════════════════════

// save() — los módulos viejos la llaman pero ahora
// los datos se guardan via IPC en cada operación
function save() {
  console.debug('[compat] save() — data managed via IPC');
}

// Alias: DB.clients → DB.customers
// Se actualiza dinámicamente después de loadAppData