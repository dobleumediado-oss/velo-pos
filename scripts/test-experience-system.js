'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const experience = read('src/js/experience.js');
const app = read('src/js/app.js');
const main = read('main.js');
const doctor = read('src/main/system-doctor.js');
const styles = read('src/css/styles.css');

for (const [name, source] of [
  ['experience.js', experience],
  ['app.js', app],
]) {
  assert.doesNotThrow(() => new vm.Script(source, { filename:name }), `${name} debe tener sintaxis válida`);
}

[
  'openSystemHealth',
  'openRecoveryCenter',
  'openAutomations',
  'openActionPermissions',
  'rememberFailure',
  'refreshShell',
].forEach(symbol => assert(experience.includes(symbol), `Falta experiencia transversal: ${symbol}`));

assert(experience.includes('vp_table_preferences_v1'), 'Las columnas deben conservar preferencias');
assert(experience.includes('ui-high-contrast'), 'Debe existir preferencia de contraste');
assert(experience.includes('ui-large-text'), 'Debe existir preferencia de texto ampliado');
assert(app.includes('data-ux-recovery'), 'El topbar debe exponer recuperación');
assert(app.includes('Operación detenida por conexión'), 'Los fallos de conexión deben ser recuperables');
assert(app.includes('commandCatalog'), 'La búsqueda global debe incluir comandos operativos');
assert(app.includes('Centro de impresión'), 'La búsqueda debe conducir al centro de impresión');

[
  "_hasActionPermission(reqUser, 'cancel_payment'",
  "_hasActionPermission(reqUser, 'restore_backup'",
  "_hasActionPermission(reqUser, 'system_health'",
].forEach(check => assert(main.includes(check), `Falta permiso operativo: ${check}`));

assert(doctor.includes('printer_channel_bindings'), 'El diagnóstico debe revisar canales de impresión');
assert(doctor.includes('Canales de impresión'), 'El diagnóstico debe comunicar canales por departamento');

[
  '.ux-connection-chip',
  '.ux-recovery-trigger',
  '.ux-health-summary',
  '.ux-modal-structured',
  '[data-ux-status="danger"]',
  '.ui-high-contrast',
  '.ui-large-text',
].forEach(selector => assert(styles.includes(selector), `Falta estilo global: ${selector}`));

console.log('✓ Experiencia transversal, recuperación, permisos y salud del sistema verificados');
