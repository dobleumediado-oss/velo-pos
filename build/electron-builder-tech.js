'use strict';

// ════════════════════════════════════════════════════════════════════════════
// Build config — VELO TECH POS (producto de tecnología/celulares)
// ────────────────────────────────────────────────────────────────────────────
// Hermano de electron-builder-terminal.js: mismo core, IDENTIDAD y CANAL propios.
// - appId/productName/ícono propios → app separada, jamás colisiona con VELO POS.
// - canal `latest-tech` → electron-updater nunca cruza un instalador VELO POS a
//   un cliente TECH ni viceversa (mismo principio que Terminal vs Server).
// - extraMetadata.veloVertical='tech' → el resolver del vertical lo lee compilado.
// ════════════════════════════════════════════════════════════════════════════

const pkg = require('../package.json');

module.exports = {
  ...pkg.build,
  appId: 'do.velotechpos.app',
  productName: 'Velo Tech POS',
  copyright: 'Copyright 2026 — Velo Tech POS',
  directories: { ...pkg.build.directories, output: 'dist/tech' },
  artifactName: 'Velo-Tech-POS-Setup-${version}.${ext}',
  // Vertical COMPILADO: el resolver (src/verticals) lo lee de package.json.
  extraMetadata: { veloVertical: 'tech' },
  win: {
    ...pkg.build.win,
    icon: 'src/assets/velo-tech-icon.ico',
    requestedExecutionLevel: 'asInvoker',
  },
  mac: {
    ...pkg.build.mac,
    icon: 'src/assets/velo-tech-icon.png',
  },
  nsis: {
    ...pkg.build.nsis,
    shortcutName: 'Velo Tech POS',
    installerIcon: 'src/assets/velo-tech-icon.ico',
    uninstallerIcon: 'src/assets/velo-tech-icon.ico',
    installerHeaderIcon: 'src/assets/velo-tech-icon.ico',
  },
  publish: {
    ...pkg.build.publish,
    channel: 'latest-tech',
  },
};
