#!/usr/bin/env node
/**
 * test-url-safe.js — Regresión de seguridad de la allowlist de URLs externas.
 * Función pura → corre con node normal. npm run test:url
 * Exit: 0 = OK; 1 = algún fallo.
 */
'use strict';
const { isAllowedExternalUrl, isAllowedPortalBaseUrl } = require('../lib/url-safe');
const { buildWhatsAppUrls, normalizeWhatsAppPhone } = require('../lib/whatsapp-url');

let pass = 0, fail = 0;
function expect(url, allowed) {
  const got = isAllowedExternalUrl(url);
  if (got === allowed) { pass++; console.log(`  ✓ ${allowed ? 'permite ' : 'bloquea '} ${JSON.stringify(url)}`); }
  else { fail++; console.log(`  ✗ FALLO: ${JSON.stringify(url)} → esperaba ${allowed}, obtuvo ${got}`); }
}

console.log('\n== Allowlist de URLs externas ==');
// Permitidas
expect('https://wa.me/18091234567', true);
expect('https://api.whatsapp.com/send?phone=1809', true);
expect('https://www.google.com/maps/dir/?api=1&destination=18.48,-69.93', true);
expect('https://www.waze.com/ul?ll=18.48,-69.93&navigate=yes', true);
expect('https://velo-servidor.tail123.ts.net/r/principal/token', true);
// Bloqueadas
expect('http://wa.me/123', false);                 // http, no https
expect('https://evil.com', false);                 // host no permitido
expect('https://wa.me.evil.com', false);           // sufijo engañoso
expect('javascript:alert(1)', false);              // esquema peligroso
expect('file:///etc/passwd', false);               // acceso a archivos
expect('', false);
expect(null, false);
expect('no es una url', false);
expect('https://sub.wa.me/x', false);              // subdominio no listado
expect('https://maps.google.com.evil.com/x', false);
expect('https://ts.net.evil.com/r/principal/token', false);
expect('http://velo-servidor.tail123.ts.net/r/principal/token', false);

console.log('\n== Base del portal Tailscale Funnel ==');
function expectPortal(url, allowed, options) {
  const got = isAllowedPortalBaseUrl(url, options);
  if (got === allowed) { pass++; console.log(`  ✓ ${allowed ? 'permite ' : 'bloquea '} ${JSON.stringify(url)}`); }
  else { fail++; console.log(`  ✗ FALLO: ${JSON.stringify(url)} → esperaba ${allowed}, obtuvo ${got}`); }
}
expectPortal('https://velo-servidor.tail123.ts.net', true);
expectPortal('https://velo-servidor.tail123.ts.net:8443', true);
expectPortal('https://evil.example', false);
expectPortal('https://velo.tail123.ts.net/r/orden', false);
expectPortal('https://user@velo.tail123.ts.net', false);
expectPortal('https://velo.tail123.ts.net:9443', false);
expectPortal('http://127.0.0.1:8787', false);
expectPortal('http://127.0.0.1:8787', true, { allowLocal:true });

console.log('\n== Enlaces de WhatsApp Desktop/Web ==');
try {
  const urls = buildWhatsAppUrls({ phone: '+1 (809) 123-4567', message: 'Hola & gracias' });
  if (urls.phone === '18091234567' &&
      urls.appUrl === 'whatsapp://send?phone=18091234567&text=Hola%20%26%20gracias' &&
      urls.webUrl === 'https://wa.me/18091234567?text=Hola%20%26%20gracias') {
    pass++; console.log('  ✓ construye protocolo Desktop y fallback Web con el mismo mensaje');
  } else {
    fail++; console.log('  ✗ construye URLs inesperadas', urls);
  }
  normalizeWhatsAppPhone('123');
  fail++; console.log('  ✗ aceptó un teléfono demasiado corto');
} catch (e) {
  if (e.message === 'Número de WhatsApp inválido') {
    pass++; console.log('  ✓ rechaza teléfonos inválidos');
  } else {
    fail++; console.log('  ✗ error inesperado:', e.message);
  }
}

try {
  if (normalizeWhatsAppPhone('809-123-4567') === '18091234567' &&
      normalizeWhatsAppPhone('18091234567') === '18091234567') {
    pass++; console.log('  ✓ agrega el prefijo 1 a teléfonos dominicanos de 10 dígitos sin duplicarlo');
  } else {
    fail++; console.log('  ✗ no normalizó correctamente el prefijo 1');
  }
} catch (e) {
  fail++; console.log('  ✗ falló al normalizar el prefijo 1:', e.message);
}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
