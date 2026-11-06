#!/usr/bin/env node
'use strict';
// El JSON es la fuente editable. Las sugerencias no son productos ni existencias.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src/assets/catalogs/device-reference.json');
const reference = JSON.parse(fs.readFileSync(source, 'utf8'));
const kinds = new Set(reference.kinds.map(row => row.id));
const seen = new Set();
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
for (const row of reference.entries) {
  if (!kinds.has(row.kind) || !row.brand.trim() || !row.model.trim() || row.brand.length > 120 || row.model.length > 100) throw Error('Referencia de dispositivo inválida');
  const key = [row.kind, normalize(row.brand), normalize(row.model)].join('|');
  if (seen.has(key)) throw Error('Referencia de dispositivo repetida');
  seen.add(key);
}
fs.writeFileSync(path.join(root, 'src/js/device-reference.js'), '// Generado desde src/assets/catalogs/device-reference.json. No editar a mano.\nwindow.VeloDeviceReference = '+JSON.stringify(reference)+';\n');
const cloud = path.join(root, 'cloud/apps/web/src/data');
if (fs.existsSync(path.join(root, 'cloud/apps/web'))) {
  fs.mkdirSync(cloud, { recursive:true });
  fs.writeFileSync(path.join(cloud, 'device-reference.json'), JSON.stringify(reference, null, 2)+'\n');
}
console.log(`Referencia verificada: ${reference.entries.length} modelos, ${new Set(reference.entries.map(row => row.brand)).size} marcas y ${reference.kinds.length} tipos.`);
