#!/usr/bin/env node
'use strict';

// Ejecuta scripts Node con el runtime incluido en Electron de forma idéntica en
// Windows, macOS y Linux. Evita la sintaxis POSIX `VAR=valor comando`, que cmd.exe
// no reconoce y que anteriormente detenía el release antes de compilar.
const { spawnSync } = require('child_process');
const electronPath = require('electron');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Uso: node scripts/run-electron-node.js <script> [...args]');
  process.exit(2);
}

const result = spawnSync(electronPath, args, {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`Electron terminó por señal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
