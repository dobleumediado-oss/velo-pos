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
const TAILSCALE_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/i;
const TAILSCALE_PORTS = new Set(['', '443', '8443', '10000']);

function isAllowedPortalBaseUrl(url, { allowLocal = false } = {}) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return false;
    if (parsed.protocol === 'https:' && TAILSCALE_HOST.test(parsed.hostname)
        && TAILSCALE_PORTS.has(parsed.port)) return true;
    return allowLocal && parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
      && /^\d*$/.test(parsed.port);
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const tailscalePortal = TAILSCALE_HOST.test(parsed.hostname) && TAILSCALE_PORTS.has(parsed.port);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && (ALLOWED_HOSTS.has(parsed.hostname) || tailscalePortal);
  } catch {
    return false;
  }
}

module.exports = { isAllowedExternalUrl, isAllowedPortalBaseUrl, ALLOWED_HOSTS };
