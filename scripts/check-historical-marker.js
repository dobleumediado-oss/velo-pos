#!/usr/bin/env node
/**
 * check-historical-marker.js — GUARDIÁN ESTÁTICO (solo lectura de código)
 *
 * La separación entre data histórica importada y data viva en VELO POS
 * depende de un literal frágil repetido en el código:
 *
 *     'Importación histórica'   (sales.cajero / payments.cajero)
 *
 * No hay columna dedicada. Si alguien altera una sola copia (un espacio,
 * un acento distinto, mayúscula/minúscula, o traduce el texto), los
 * reportes de "hoy"/"mes", la caja y las cuentas por cobrar se corrompen
 * SILENCIOSAMENTE: no lanza error, solo empieza a contar mal.
 *
 * Este guardián escanea el código fuente y falla si encuentra CUALQUIER
 * variante del marcador que no sea byte-idéntica al canónico. No modifica
 * nada. Pensado para correrse en cada refactorización (y opcionalmente
 * antes de un release) como red de seguridad del contrato.
 *
 * Uso:
 *   node scripts/check-historical-marker.js
 *   node scripts/check-historical-marker.js --verbose   # lista cada ocurrencia
 *
 * Exit code: 0 = todas las copias son idénticas; 1 = drift detectado.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Fuente única de verdad del valor canónico.
const CANONICAL = 'Importación histórica';

// Solo nos importa el marcador como LITERAL DE CÓDIGO (token entre comillas
// simples o dobles), no como prosa en comentarios. Por eso exigimos que el
// texto venga "abrazado" por comillas: 'Importación histórica'. El contenido
// se compara byte a byte contra CANONICAL; cualquier variante (acento,
// mayúscula, espacio, traducción) dentro de comillas se reporta como drift.
// Comentarios en minúscula tipo «...de importación histórica y...» se ignoran.
const DETECT = /(['"])([^'"]*importaci[oó]n\s+hist[oó]rica[^'"]*)\1/gi;

const ROOT = path.join(__dirname, '..');
const TARGET_DIRS = ['', 'src/js', 'src/main'];
const TARGET_ROOT_FILES = ['main.js', 'database.js', 'versioning.js', 'preload.js'];

const verbose = process.argv.includes('--verbose');

function collectFiles() {
  const files = new Set();
  for (const f of TARGET_ROOT_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) files.add(abs);
  }
  for (const dir of TARGET_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) files.add(path.join(abs, name));
    }
  }
  return [...files];
}

const drift = [];
let okCount = 0;
const occurrences = [];

for (const file of collectFiles()) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    let m;
    DETECT.lastIndex = 0;
    while ((m = DETECT.exec(line)) !== null) {
      const inner = m[2]; // contenido entre comillas, sin las comillas
      const rel = path.relative(ROOT, file);
      occurrences.push({ file: rel, line: i + 1, matched: inner });
      if (inner !== CANONICAL) {
        drift.push({ file: rel, line: i + 1, found: inner, expected: CANONICAL });
      } else {
        okCount++;
      }
    }
  });
}

if (verbose) {
  console.log(`Ocurrencias del marcador histórico (${occurrences.length}):`);
  for (const o of occurrences) {
    const flag = o.matched === CANONICAL ? ' ' : '✗';
    console.log(`  ${flag} ${o.file}:${o.line}  «${o.matched}»`);
  }
  console.log('');
}

if (drift.length > 0) {
  console.error('✗ DRIFT DEL MARCADOR HISTÓRICO — el contrato de importación está en riesgo:');
  for (const d of drift) {
    console.error(`  - ${d.file}:${d.line}`);
    console.error(`      encontrado: «${d.found}»`);
    console.error(`      esperado:   «${d.expected}»`);
  }
  console.error('');
  console.error('  Toda copia del marcador DEBE ser byte-idéntica. Corrige antes de continuar.');
  process.exit(1);
}

console.log(`✓ Marcador histórico consistente: ${okCount} copias byte-idénticas a «${CANONICAL}».`);
process.exit(0);
