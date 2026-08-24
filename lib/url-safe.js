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

const PORTAL_URL_ERRORS = Object.freeze({
  ENABLE_LINK: "Ese es el enlace para HABILITAR el Funnel, no la URL del portal. Habilítalo, vuelve a correr 'tailscale funnel --bg <puerto>' y copia la línea que empieza con https://...ts.net",
  BASE_ONLY: 'Guarda solo el dominio base HTTPS entregado por Tailscale, sin /r, rutas, número de orden, barra final ni el comando tailscale funnel.',
  INVALID: 'Usa únicamente la URL pública HTTPS que termina en .ts.net y aparece en la línea “Available on the internet”.',
});

// Diagnóstico puro para poder explicar por qué una URL no pasa la allowlist.
// No normaliza entradas inseguras ni intenta "arreglarlas": savePortalConfig
// decide si muestra el mensaje y solo persiste valores que resulten válidos.
function diagnosePortalBaseUrl(url, { allowLocal = false } = {}) {
  if (!url || typeof url !== 'string') return { allowed:false, code:'empty', error:'' };
  const value = url.trim();

  // URL que Tailscale muestra para autorizar Funnel por primera vez. Contiene
  // un token/node de habilitación y jamás debe almacenarse como portal público.
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() === 'login.tailscale.com'
        && /^\/f\/funnel\/?$/i.test(parsed.pathname)
        && parsed.searchParams.has('node')) {
      return { allowed:false, code:'tailscale_enable_link', error:PORTAL_URL_ERRORS.ENABLE_LINK };
    }
  } catch { /* el diagnóstico de formato continúa abajo */ }

  // Una orden pegada junto a la URL o cualquier espacio interno no representa
  // un dominio base y suele venir de copiar toda la salida de Terminal.
  if (/\s/.test(value) || /\btailscale\s+funnel\b/i.test(value)) {
    return { allowed:false, code:'base_only', error:PORTAL_URL_ERRORS.BASE_ONLY };
  }

  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { allowed:false, code:'base_only', error:PORTAL_URL_ERRORS.BASE_ONLY };
    }
    if (parsed.pathname !== '/' || /\/r(?:\/|$)/i.test(parsed.pathname)) {
      return { allowed:false, code:'base_only', error:PORTAL_URL_ERRORS.BASE_ONLY };
    }
    if (parsed.protocol === 'https:' && TAILSCALE_HOST.test(parsed.hostname)
        && TAILSCALE_PORTS.has(parsed.port)) return { allowed:true, code:'tailscale', error:'' };
    if (allowLocal && parsed.protocol === 'http:'
        && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
        && /^\d*$/.test(parsed.port)) return { allowed:true, code:'local', error:'' };
    return { allowed:false, code:'invalid', error:PORTAL_URL_ERRORS.INVALID };
  } catch {
    return { allowed:false, code:'invalid', error:PORTAL_URL_ERRORS.INVALID };
  }
}

function isAllowedPortalBaseUrl(url, { allowLocal = false } = {}) {
  return diagnosePortalBaseUrl(url, { allowLocal }).allowed;
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

module.exports = {
  isAllowedExternalUrl,
  isAllowedPortalBaseUrl,
  diagnosePortalBaseUrl,
  PORTAL_URL_ERRORS,
  ALLOWED_HOSTS,
};
