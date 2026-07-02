#!/usr/bin/env node
/**
 * test-import-hardening.js — Test de regresión de seguridad (Bloque 2)
 *
 * Valida el escape de identificadores sqliteIdent() y el path de lectura de
 * importación (importar:readSQLite / importar:readZIP en main.js) con nombres
 * de tabla ADVERSARIOS provenientes de un archivo .db externo del cliente.
 *
 * No toca la base de datos real: crea una BD desechable en el temp del SO.
 * Correr con el Node de Electron por el ABI de better-sqlite3:
 *   npm run test:import
 *
 * Exit code: 0 = todo OK; 1 = algún fallo.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FALLO:', msg); }
}

// Copia EXACTA de sqliteIdent() en main.js. Si cambias una, cambia la otra.
function sqliteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

console.log('\n== 1. sqliteIdent(): escape correcto ==');
ok(sqliteIdent('productos') === '"productos"', 'nombre normal → "productos"');
ok(sqliteIdent('con espacio') === '"con espacio"', 'nombre con espacio preservado');
ok(sqliteIdent('ev"il') === '"ev""il"', 'comilla doble → duplicada (ev""il)');
ok(sqliteIdent('a"; DROP TABLE x;--') === '"a""; DROP TABLE x;--"', 'intento de breakout neutralizado');

const tmpDb = path.join(os.tmpdir(), `velo_test_${Date.now()}.db`);
const w = new Database(tmpDb);
w.exec('CREATE TABLE productos (id INTEGER, nombre TEXT);');
const insP = w.prepare('INSERT INTO productos VALUES (?,?)');
for (let i = 1; i <= 120; i++) insP.run(i, 'prod' + i);
w.exec('CREATE TABLE "we""ird" (a TEXT);'); // tabla con comilla en el nombre
w.prepare('INSERT INTO "we""ird" VALUES (?)').run('x');
w.close();

console.log('\n== 2. Path de lectura de importación (réplica de readSQLite) ==');
const db2 = new Database(tmpDb, { readonly: true });
const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all().map(r => r.name).filter(t => !t.startsWith('sqlite_'));
ok(tables.length === 2, `detecta 2 tablas (encontró ${tables.length})`);
ok(tables.includes('we"ird'), 'incluye la tabla con nombre adversario');

let bestTable = tables[0], bestCount = 0, errored = false;
for (const t of tables) {
  try {
    const c = db2.prepare(`SELECT COUNT(*) as c FROM ${sqliteIdent(t)}`).get().c;
    if (c > bestCount) { bestCount = c; bestTable = t; }
  } catch (e) { errored = true; console.log('    (error en tabla', JSON.stringify(t), ':', e.message, ')'); }
}
ok(!errored, 'COUNT sobre todas las tablas SIN error (incluida la adversaria)');
ok(bestTable === 'productos' && bestCount === 120, `elige la tabla con más filas: productos/120 (obtuvo ${bestTable}/${bestCount})`);

const rows = db2.prepare(`SELECT * FROM ${sqliteIdent(bestTable)} LIMIT 500`).all();
ok(rows.length === 120, `SELECT devuelve las 120 filas (obtuvo ${rows.length})`);

console.log('\n== 3. Contraprueba: interpolación CRUDA (código viejo) sí falla ==');
let rawBroke = false;
try {
  db2.prepare('SELECT COUNT(*) as c FROM "we"ird"').get(); // como era antes: `FROM "${t}"`
} catch (e) { rawBroke = true; }
ok(rawBroke, 'la interpolación cruda `FROM "we"ird"` lanza error de sintaxis (el fix lo evita)');

db2.close();
fs.unlinkSync(tmpDb);

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
