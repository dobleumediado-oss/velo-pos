#!/usr/bin/env node
/**
 * test-url-safe.js — Regresión de seguridad de la allowlist de URLs externas.
 * Función pura → corre con node normal. npm run test:url
 * Exit: 0 = OK; 1 = algún fallo.
 */
'use strict';
const { EventEmitter } = require('events');
const { isAllowedExternalUrl, isAllowedPortalBaseUrl, diagnosePortalBaseUrl } = require('../lib/url-safe');
const { checkPublicPortalAccess } = require('../lib/portal-public-check');
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

console.log('\n== Retroalimentación de configuración del portal ==');
function expectPortalDiagnostic(url, code, phrases = []) {
  const result = diagnosePortalBaseUrl(url, { allowLocal:true });
  const explains = phrases.every(phrase => result.error.includes(phrase));
  if (!result.allowed && result.code === code && result.error && explains) {
    pass++; console.log(`  ✓ explica ${code} para ${JSON.stringify(url)}`);
  } else {
    fail++; console.log(`  ✗ diagnóstico inesperado para ${JSON.stringify(url)}:`, result);
  }
}
expectPortalDiagnostic('https://login.tailscale.com/f/funnel?node=abc123', 'tailscale_enable_link', ['HABILITAR', "tailscale funnel --bg <puerto>", 'https://...ts.net']);
expectPortalDiagnostic('https://velo.tail123.ts.net/r/principal/token', 'base_only', ['dominio base', 'sin /r']);
expectPortalDiagnostic('https://velo.tail123.ts.net/otra-ruta', 'base_only');
expectPortalDiagnostic('https://velo.tail123.ts.net tailscale funnel --bg 8787', 'base_only');
expectPortalDiagnostic('https://evil.example', 'invalid');

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

async function testPublicPortalCheck() {
  console.log('\n== Prueba HTTPS pública manual ==');
  let captured;
  const requestImpl = (options, callback) => {
    captured = options;
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    return request;
  };
  const result = await checkPublicPortalAccess('https://velo.tail123.ts.net', { requestImpl });
  if (result.online && result.status_code === 200 && captured.hostname === 'velo.tail123.ts.net'
      && captured.path === '/health' && captured.protocol === 'https:') {
    pass++; console.log('  ✓ consulta exclusivamente /health del dominio público HTTPS permitido');
  } else {
    fail++; console.log('  ✗ la prueba pública armó una petición inesperada', { result, captured });
  }

  let called = false;
  try {
    await checkPublicPortalAccess('https://evil.example', { requestImpl:() => { called = true; } });
    fail++; console.log('  ✗ permitió probar un host fuera de la allowlist');
  } catch (error) {
    if (!called && /URL pública HTTPS válida/.test(error.message)) {
      pass++; console.log('  ✓ rechaza hosts fuera de la allowlist antes de abrir la red');
    } else {
      fail++; console.log('  ✗ rechazo inesperado de host no permitido:', error.message);
    }
  }
}

testPublicPortalCheck().then(() => {
  console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
  process.exit(fail ? 1 : 0);
}).catch(error => {
  fail++;
  console.log('  ✗ prueba pública inesperadamente fallida:', error.message);
  console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
  process.exit(1);
});
