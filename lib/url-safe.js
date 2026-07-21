// ══════════════════════════════════════════════
// lib/url-safe.js — Allowlist de URLs externas (proceso main)
// Controla qué URLs puede abrir la app con shell.openExternal. Función PURA.
// Endurecer aquí protege contra abrir enlaces arbitrarios/maliciosos.
// NUNCA se expone al renderer.
// ══════════════════════════════════════════════
'use strict';

// Servicios externos iniciados explícitamente por el usuario: mensajería y
// navegación. Se validan host exacto y HTTPS; no se aceptan subdominios libres.
const ALLOWED_HOSTS = new Set([
  'wa.me', 'api.whatsapp.com',
  'www.google.com', 'maps.google.com',
  'waze.com', 'www.waze.com',
]);

function isAllowedExternalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

module.exports = { isAllowedExternalUrl, ALLOWED_HOSTS };
