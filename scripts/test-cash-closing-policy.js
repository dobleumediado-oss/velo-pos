#!/usr/bin/env node
'use strict';

const assert = require('assert');
const policy = require('../src/js/cash-close-policy');

function at(hour, minute) {
  return new Date(2026, 7, 24, hour, minute, 0, 0);
}

assert.strictEqual(policy.roleRequiresOpenCash('admin'), true);
assert.strictEqual(policy.roleRequiresOpenCash('cajero'), true);
assert.strictEqual(policy.roleRequiresOpenCash('superadmin'), false);
console.log('  ✓ VELO POS y VELO TECH exigen caja a Administrador/Cajero; Superadmin queda exento');

const base = {
  role: 'admin', cashOpen: true, enabled: '1', closeTime: '17:00',
};
assert.strictEqual(policy.evaluate({ ...base, now: at(16, 54) }).remind, false);
assert.strictEqual(policy.evaluate({ ...base, now: at(16, 55) }).remind, true);
assert.strictEqual(policy.evaluate({ ...base, now: at(16, 59) }).remind, true);
assert.strictEqual(policy.evaluate({ ...base, now: at(17, 0) }).remind, false);
console.log('  ✓ el recordatorio aparece únicamente durante los cinco minutos previos');

assert.strictEqual(policy.evaluate({ ...base, now: at(16, 59) }).blockExit, false);
assert.strictEqual(policy.evaluate({ ...base, now: at(17, 0) }).blockExit, true);
assert.strictEqual(policy.evaluate({ ...base, now: at(19, 30) }).blockExit, true);
console.log('  ✓ desde la hora configurada bloquea la salida con caja abierta');

assert.strictEqual(policy.evaluate({ ...base, cashOpen: false, now: at(19, 30) }).blockExit, false);
assert.strictEqual(policy.evaluate({ ...base, enabled: '0', now: at(19, 30) }).blockExit, false);
assert.strictEqual(policy.evaluate({ ...base, closeTime: '', now: at(19, 30) }).blockExit, false);
assert.strictEqual(policy.evaluate({ ...base, role: 'superadmin', now: at(19, 30) }).blockExit, false);
assert.strictEqual(policy.parseTimeToMinutes('24:00'), null);
assert.strictEqual(policy.parseTimeToMinutes('17:00'), 1020);
console.log('  ✓ caja cerrada, política inactiva, hora inválida y Superadmin nunca quedan bloqueados');

console.log('\nPolítica de apertura y cierre de Caja verificada.');
