#!/usr/bin/env node
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// VELO SUITE — Compuerta de invariantes de compatibilidad (F0)
// ────────────────────────────────────────────────────────────────────────────
// Los clientes que YA tienen VELO POS instalado solo siguen recibiendo
// actualizaciones si el producto conserva su identidad de auto-update y su
// directorio de datos. electron-updater empareja por `appId`+canal; Electron
// deriva la carpeta de `userData` (donde vive velo.db) del `productName`/appId.
//
// Si el refactor de la suite cambia cualquiera de estos, un cliente:
//   • deja de recibir updates, o
//   • instala una app APARTE (dos "Velo POS"), o
//   • "pierde" sus datos porque la app busca velo.db en otra carpeta.
//
// Esta prueba CONGELA esos valores para VELO POS. Debe pasar en toda fase que
// toque VELO POS. Cambiarla es una decisión explícita y peligrosa, no un
// efecto colateral de mover archivos.
// ════════════════════════════════════════════════════════════════════════════

const path = require('path');
const pkg = require(path.join(__dirname, '..', 'package.json'));

// Valores congelados de VELO POS (rama publicada v1.40.x). NO cambiar sin
// entender que rompe el auto-update y la ruta de datos de clientes reales.
const FROZEN = {
  appId:       'do.velopos.app',
  productName: 'Velo POS',
  shortcutName: 'Velo POS',
};

let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    console.log('  ✓', name, '=', JSON.stringify(actual));
  } else {
    failed++;
    console.error('  ✗', name, '→ esperado', JSON.stringify(expected), 'pero es', JSON.stringify(actual));
  }
}

console.log('== VELO SUITE · invariantes de compatibilidad VELO POS ==');
check('build.appId',            pkg.build && pkg.build.appId,            FROZEN.appId);
check('build.productName',      pkg.build && pkg.build.productName,      FROZEN.productName);
check('build.nsis.shortcutName',
      pkg.build && pkg.build.nsis && pkg.build.nsis.shortcutName,        FROZEN.shortcutName);

// El canal de auto-update de VELO POS es el implícito de electron-updater
// (`latest.yml`). Un producto de la suite con canal propio (ej. TECH →
// `latest-tech.yml`) NUNCA debe declararse dentro del build de VELO POS.
const channel = pkg.build && pkg.build.publish &&
  (Array.isArray(pkg.build.publish) ? pkg.build.publish[0] : pkg.build.publish);
if (channel && channel.channel && channel.channel !== 'latest') {
  failed++;
  console.error('  ✗ canal de update de VELO POS alterado →', channel.channel, '(debe ser el implícito "latest")');
} else {
  console.log('  ✓ canal de update VELO POS = latest (implícito)');
}

// El instalador que corren los clientes se compila con el config Terminal.
// Verificamos la identidad EFECTIVA que produce (hereda de package.json.build
// y fija su canal), porque es la que reciben las máquinas en producción.
let terminalCfg = null;
try { terminalCfg = require(path.join(__dirname, '..', 'build', 'electron-builder-terminal.js')); }
catch (e) { failed++; console.error('  ✗ no se pudo cargar build/electron-builder-terminal.js:', e.message); }
if (terminalCfg) {
  check('terminal.appId',        terminalCfg.appId,                    FROZEN.appId);
  check('terminal.productName',  terminalCfg.productName,              FROZEN.productName);
  check('terminal.publish.channel',
        terminalCfg.publish && terminalCfg.publish.channel,            'latest');
  const artOk = /^Velo-POS-Terminal-Setup-/.test(String(terminalCfg.artifactName || ''));
  if (artOk) console.log('  ✓ terminal.artifactName =', JSON.stringify(terminalCfg.artifactName));
  else { failed++; console.error('  ✗ terminal.artifactName cambió →', terminalCfg.artifactName); }
}

// VELO TECH POS (y todo producto de la suite) DEBE ser separable de VELO POS:
// otro appId y otro canal, para que un instalador jamás se cruce con clientes
// de VELO POS por auto-update. Si el config TECH existe, lo verificamos.
try {
  const techCfg = require(path.join(__dirname, '..', 'build', 'electron-builder-tech.js'));
  if (techCfg.appId === FROZEN.appId) {
    failed++; console.error('  ✗ TECH comparte el appId de VELO POS → colisionaría con sus instalaciones');
  } else { console.log('  ✓ TECH.appId separado =', JSON.stringify(techCfg.appId)); }
  const techChannel = techCfg.publish && techCfg.publish.channel;
  if (!techChannel || techChannel === 'latest') {
    failed++; console.error('  ✗ TECH usa el canal de VELO POS (latest) → recibiría sus updates');
  } else { console.log('  ✓ TECH.channel separado =', JSON.stringify(techChannel)); }
} catch { /* aún no existe el build TECH → nada que verificar */ }

if (failed) {
  console.error(`\n✗ INVARIANTES ROTOS (${failed}). Esto afectaría a clientes con VELO POS instalado.`);
  process.exit(1);
}
console.log('\n✓ Invariantes de compatibilidad intactos — VELO POS conserva identidad, canal y ruta de datos.');
