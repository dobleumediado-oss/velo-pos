#!/usr/bin/env node
/**
 * Regresión multi-negocio:
 * crear/inicializar una DB secundaria NO debe cambiar la DB activa del proceso.
 *
 * Correr con:
 *   npm run test:business
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FALLO:', msg); }
}

const tmpRoot = path.join(os.tmpdir(), `velo_multibiz_${Date.now()}`);
const mainDir = path.join(tmpRoot, 'main');
const bizDir = path.join(tmpRoot, 'negocios', 'biz_test');

const DB = require('../database');
const { initVersioning } = require('../versioning');
const businessCtx = require('../src/main/business-context');

try {
  console.log('\n== A. DB principal activa ==');
  DB.initDB(mainDir);
  const mainDb = DB.getDB();
  mainDb.prepare("INSERT INTO settings(key,value) VALUES('test_marker','principal')").run();
  ok(DB.getDB() === mainDb, 'getDB apunta a la DB principal');

  console.log('\n== B. Inicializar DB secundaria separada ==');
  const result = DB.initDetachedDB(bizDir, (detachedDb, detachedDir) => {
    initVersioning(detachedDb, detachedDir);
    detachedDb.prepare(`
      INSERT INTO settings(key,value) VALUES('biz_name',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run('Negocio Secundario');
    detachedDb.prepare(`
      INSERT INTO settings(key,value) VALUES('module_multi_negocio','1')
      ON CONFLICT(key) DO UPDATE SET value='1'
    `).run();
    detachedDb.prepare("INSERT INTO settings(key,value) VALUES('test_marker','secundaria')").run();
  });
  ok(result && result.ok === true, 'initDetachedDB devuelve ok');
  ok(fs.existsSync(path.join(bizDir, 'velo.db')), 'la DB secundaria existe en su carpeta');
  ok(DB.getDB() === mainDb, 'getDB sigue apuntando a la DB principal');

  console.log('\n== C. Datos aislados ==');
  const mainMarker = DB.getDB().prepare("SELECT value FROM settings WHERE key='test_marker'").get()?.value;
  ok(mainMarker === 'principal', `la principal conserva su marcador (${mainMarker})`);

  const secondaryDb = new Database(path.join(bizDir, 'velo.db'), { readonly: true });
  const secondaryMarker = secondaryDb.prepare("SELECT value FROM settings WHERE key='test_marker'").get()?.value;
  const secondaryName = secondaryDb.prepare("SELECT value FROM settings WHERE key='biz_name'").get()?.value;
  const secondaryMulti = secondaryDb.prepare("SELECT value FROM settings WHERE key='module_multi_negocio'").get()?.value;
  const secondaryUsers = secondaryDb.prepare('SELECT COUNT(*) c FROM users').get().c;
  const secondaryMigrations = secondaryDb.prepare('SELECT COUNT(*) c FROM db_migrations').get().c;
  secondaryDb.close();
  ok(secondaryMarker === 'secundaria', `la secundaria conserva su marcador (${secondaryMarker})`);
  ok(secondaryName === 'Negocio Secundario', `la secundaria conserva su nombre (${secondaryName})`);
  ok(secondaryMulti === '1', `la secundaria conserva multi-negocio activo (${secondaryMulti})`);
  ok(secondaryUsers > 0, `la secundaria fue inicializada con usuarios seed (${secondaryUsers})`);
  ok(secondaryMigrations > 0, `la secundaria registró migraciones (${secondaryMigrations})`);

  console.log('\n== D. Contexto de negocio activo ==');
  const ctxRoot = path.join(tmpRoot, 'context');
  const ctxBizDir = businessCtx.getBusinessDir(ctxRoot, 'biz_100');
  fs.mkdirSync(ctxBizDir, { recursive: true });
  fs.writeFileSync(path.join(ctxBizDir, 'meta.json'), JSON.stringify({ id: 'biz_100', name: 'Negocio 100' }));
  fs.mkdirSync(path.join(businessCtx.getBusinessesDir(ctxRoot), 'evil'), { recursive: true });
  fs.writeFileSync(path.join(businessCtx.getBusinessesDir(ctxRoot), 'evil', 'meta.json'), JSON.stringify({ id: 'evil', name: 'No valido' }));

  ok(businessCtx.isValidBusinessId('biz_100'), 'acepta ID de negocio válido');
  ok(!businessCtx.isValidBusinessId('../biz_100'), 'rechaza ID con path traversal');
  ok(businessCtx.loadBusinesses(ctxRoot).length === 1, 'lista solo negocios con ID válido');
  ok(businessCtx.resolveActiveBusiness(ctxRoot).dataDir === ctxRoot, 'sin activo resuelve a la raíz');

  businessCtx.setActiveBusiness(ctxRoot, 'biz_100');
  ok(businessCtx.getActiveBusiness(ctxRoot)?.id === 'biz_100', 'lee negocio activo válido');
  ok(businessCtx.resolveActiveBusiness(ctxRoot).dataDir === ctxBizDir, 'activo resuelve a su carpeta de negocio');

  fs.writeFileSync(path.join(ctxRoot, 'active_business.json'), JSON.stringify({ id: '../biz_100' }));
  ok(businessCtx.getActiveBusiness(ctxRoot) === null, 'ignora active_business inválido');
  ok(businessCtx.resolveActiveBusiness(ctxRoot).dataDir === ctxRoot, 'activo inválido cae a la raíz');

  const pickedSettings = businessCtx.pickDeviceSettings({
    connection_mode: 'server',
    connection_access_key: 'abc',
    terminal_id: 'term-1',
    printer: 'Ticket',
    printer_type: '80mm',
    print_config: '{}',
    barcode_printer: 'Etiquetas',
    biz_name: 'No copiar',
    tax_pct: '18',
    module_multi_negocio: '1',
  });
  ok(pickedSettings.connection_mode === 'server' && pickedSettings.terminal_id === 'term-1', 'detecta settings de conexión y terminal');
  ok(pickedSettings.print_config === '{}' && pickedSettings.barcode_printer === 'Etiquetas', 'detecta settings locales de impresión');
  ok(!('biz_name' in pickedSettings) && !('module_multi_negocio' in pickedSettings), 'excluye settings propios del negocio');
  ok(businessCtx.normalizeBusinessInput({ name: '  Taller Norte  ', description: '  Demo  ' }).name === 'Taller Norte', 'normaliza nombre de negocio');
  try {
    businessCtx.normalizeBusinessInput({ name: '   ' });
    ok(false, 'rechaza nombre vacío');
  } catch {
    ok(true, 'rechaza nombre vacío');
  }

  businessCtx.setActiveBusiness(ctxRoot, null);
  ok(!fs.existsSync(path.join(ctxRoot, 'active_business.json')), 'limpiar activo elimina active_business.json');

  console.log('\n== E. Archivado reversible ==');
  const archiveBizDir = businessCtx.getBusinessDir(ctxRoot, 'biz_archive');
  fs.mkdirSync(archiveBizDir, { recursive: true });
  fs.writeFileSync(path.join(archiveBizDir, 'meta.json'), JSON.stringify({ id: 'biz_archive', name: 'Para archivar' }));
  const archived = businessCtx.archiveBusiness(ctxRoot, 'biz_archive');
  ok(archived.archived === true, 'archiveBusiness marca como archivado');
  ok(!fs.existsSync(archiveBizDir), 'el negocio ya no queda en la lista activa');
  ok(fs.existsSync(path.join(archived.dest, 'meta.json')), 'la carpeta archivada conserva meta.json');
  ok(businessCtx.loadBusinesses(ctxRoot).every(b => b.id !== 'biz_archive'), 'loadBusinesses excluye negocios archivados');
} catch (e) {
  fail++;
  console.error('  ✗ FALLO inesperado:', e);
} finally {
  try { DB.getDB()?.close(); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
