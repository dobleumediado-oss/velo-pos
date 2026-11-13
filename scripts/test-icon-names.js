#!/usr/bin/env node
'use strict';

// Un ícono que no existe en icons.js no da error: svg() devuelve '' y el botón
// queda vacío (si no tiene texto, invisible). Esta prueba exige que cada
// nombre usado en la interfaz exista.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../src/js');
const iconSource = fs.readFileSync(path.join(dir, 'icons.js'), 'utf8');
const defined = new Set([...iconSource.matchAll(/^\s*'?([a-zA-Z0-9_]+)'?\s*:\s*`/gm)].map(m => m[1]));

const missing = [];
for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(dir, file), 'utf8');
  const patterns = [/\bsvg\(\s*'([a-zA-Z0-9_]+)'\s*\)/g, /\bS\(\s*'([a-zA-Z0-9_]+)'\s*\)/g];
  if (file === 'app.js') patterns.push(/\bicon:\s*'([a-zA-Z0-9_]+)'/g);
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!defined.has(match[1])) {
        const line = source.slice(0, match.index).split('\n').length;
        missing.push(`${file}:${line} usa el ícono «${match[1]}», que no existe en icons.js`);
      }
    }
  }
}

if (defined.size < 10) {
  console.error('  ✗ no se pudieron leer los íconos de icons.js');
  process.exit(1);
}
if (missing.length) {
  missing.forEach(message => console.error('  ✗', message));
  process.exit(1);
}
console.log(`  ✓ todos los íconos usados en la interfaz existen (${defined.size} definidos)`);
