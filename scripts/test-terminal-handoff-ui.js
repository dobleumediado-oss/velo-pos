#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/js/config.js'), 'utf8');
const start = source.indexOf('function _renderHandoffPanel(res) {');
const end = source.indexOf('async function renderConexionCard(container)', start);
assert(start >= 0 && end > start, 'La vista de traslado debe existir');

const context = { _handoffRoleView:'source', _esc:value => String(value) };
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.render = _renderHandoffPanel;`, context);

const base = {
  businesses:[{ id:'principal', name:'Negocio principal' }],
  allowlist:[
    { terminalId:'console', name:'Consola del servidor' },
    { terminalId:'terminal_lan_001', name:'Caja LAN' },
  ],
  terminalId:'console', serverPort:'8443',
};

let html = context.render(base);
assert.match(html, /Bloquear operaciones y crear copias finales/);
assert.doesNotMatch(html, /Recibir perfil cifrado del Server anterior/);
assert.match(html, /1 terminal\(es\) autorizada\(s\)/);

html = context.render({ ...base, handoffLockedAt:'2026-10-27T00:00:00.000Z' });
assert.match(html, /Guardar perfil cifrado de terminales/);
assert.match(html, /Validar destino/);
assert.doesNotMatch(html, /Recibir perfil cifrado del Server anterior/);

context._handoffRoleView = 'target';
html = context.render(base);
assert.match(html, /Recibir perfil cifrado del Server anterior/);
assert.doesNotMatch(html, /Bloquear operaciones y crear copias finales/);

html = context.render({ ...base, handoffSource:{ businessMap:{ principal:'final' }, arrivals:{}, terminalCount:1 },
  businesses:[...base.businesses,
    { id:'preliminar', name:'Negocio de prueba', origin_business_id:'principal', handoffCopyStatus:'preliminary' },
    { id:'final', name:'Negocio final', origin_business_id:'principal', handoffCopyStatus:'final' }],
});
assert.match(html, /Copia preliminar; no usar para ventas/);
assert.match(html, /Copia final para el traslado/);
assert.match(html, /Actualizar llegadas/);
assert.doesNotMatch(html, /Bloquear operaciones y crear copias finales/);

console.log('✓ Traslado: vistas de origen y destino separadas y copias identificadas');
