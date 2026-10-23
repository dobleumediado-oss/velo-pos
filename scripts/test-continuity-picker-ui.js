#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const elements = new Map();
function resetElements() {
  elements.clear();
  for (const id of ['continuity-pass', 'continuity-pass2', 'continuity-folder',
    'continuity-pick', 'continuity-create', 'continuity-status']) {
    elements.set(id, { value: '', textContent: '', disabled: false });
  }
}
resetElements();
let modalHTML = '';
let closed = 0;
let pickerCall;
let backupCall;
const notices = [];
const context = vm.createContext({
  console,
  window: {
    _currentUser: { id: 7 },
    api: { backup: {
      pickExternalDirectory: () => pickerCall(),
      createEncrypted: data => backupCall(data),
    } },
  },
  document: { getElementById: id => elements.get(id) || null },
  openModal(html) { modalHTML = html; resetElements(); },
  closeModal() { closed++; },
  toast(message, kind) { notices.push({ message, kind }); },
});
const source = fs.readFileSync(path.join(__dirname, '..', 'src/js/config.js'), 'utf8');
vm.runInContext(`${source}\nthis.openBackupForTest = abrirBackupCifrado;`, context, { filename: 'config.js' });

async function run() {
  context.openBackupForTest();
  assert.match(modalHTML, /id="continuity-folder"/, 'debe haber ruta manual');
  assert.match(modalHTML, /id="continuity-pick"/, 'el selector debe ser opcional');
  elements.get('continuity-pass').value = 'clave-de-prueba-123';
  elements.get('continuity-pass2').value = 'clave-de-prueba-123';

  // Simula el bloqueo observado: Windows nunca responde al selector nativo.
  pickerCall = () => new Promise(() => {});
  const picking = elements.get('continuity-pick').onclick();
  assert.equal(elements.get('continuity-pick').disabled, true);
  assert.equal(elements.get('continuity-create').disabled, false,
    'el usuario debe poder usar la ruta manual aunque el selector no responda');
  elements.get('continuity-folder').value = 'E:\\Respaldos VELO';
  let payload;
  backupCall = async data => { payload = data; return { ok: true }; };
  await elements.get('continuity-create').onclick();
  assert.equal(payload.destinationDir, 'E:\\Respaldos VELO');
  assert.equal(payload.requestUserId, 7);
  assert.equal(closed, 1);
  void picking;

  context.openBackupForTest();
  elements.get('continuity-pass').value = 'clave-de-prueba-123';
  elements.get('continuity-pass2').value = 'clave-de-prueba-123';
  pickerCall = async () => { throw new Error('Selector no disponible'); };
  await elements.get('continuity-pick').onclick();
  assert.equal(elements.get('continuity-pick').disabled, false,
    'un error del selector debe permitir reintentar');
  assert.match(elements.get('continuity-status').textContent, /pegar la ruta/);

  elements.get('continuity-folder').value = 'E:\\Respaldos VELO';
  backupCall = async () => ({ ok: false, error: 'La carpeta no existe' });
  await elements.get('continuity-create').onclick();
  assert.equal(elements.get('continuity-create').disabled, false,
    'un fallo al crear la copia debe liberar el botón');
  assert.equal(elements.get('continuity-create').textContent, 'Crear copia');
  assert(notices.some(item => item.message === 'La carpeta no existe'));

  console.log('✓ Respaldo: ruta manual disponible si Windows no abre el selector; errores recuperables');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
