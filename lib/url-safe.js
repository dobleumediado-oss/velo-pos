// ══════════════════════════════════════════════
// lib/url-safe.js — Allowlist de URLs externas (proceso main)
// Controla qué URLs puede abrir la app con shell.openExternal. Función PURA.
// Endurecer aquí protege contra abrir enlaces arbitrarios/maliciosos.
// NUNCA se expone al renderer.
// ══════════════════════════════════════════════
'use strict';

// Solo se permite abrir externamente HTTPS hacia WhatsApp (envío de mensajes).
const ALLOWED_HOSTS = new Set(['wa.me', 'api.whatsapp.com']);

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
