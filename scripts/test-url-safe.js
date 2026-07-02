#!/usr/bin/env node
/**
 * test-url-safe.js — Regresión de seguridad de la allowlist de URLs externas.
 * Función pura → corre con node normal. npm run test:url
 * Exit: 0 = OK; 1 = algún fallo.
 */
'use strict';
const { isAllowedExternalUrl } = require('../lib/url-safe');

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

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
