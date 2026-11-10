'use strict';
// «Pasar a VELO Cloud»: correspondencias, sesión y los 20 pasos, sin red (cliente simulado).
// La prueba de punta a punta contra Cloud (ensayo, rechazo, sin conexión, respuesta perdida
// y corte) se corre aparte con la copia real; ver docs/pasar-a-cloud.md.
// Uso: node scripts/test-cloud-direct.js
const assert = require('node:assert/strict');
const cd = require('../lib/cloud-direct');

// Los mismos pasos, en el mismo orden, que la pantalla web «Convertir pasos».
assert.equal(cd.STEPS.length, 20);
assert.deepEqual(cd.STEPS.slice(0, 3).map(step => step.key), ['customerConversion', 'catalogConversion', 'operationsConversion']);
assert.equal(cd.STEPS.at(-1).key, 'deliveryNoteConversion');

// Sesión: velo_session; o la cookie que termine en _session; nunca la del Control Center.
const response = cookies => ({ headers: { getSetCookie: () => cookies, get: () => null } });
assert.equal(cd.sessionTokenFrom(response(['velo_session=abc123; Path=/; HttpOnly'])), 'abc123');
assert.equal(cd.sessionTokenFrom(response(['otro=1', 'pos_session=xyz; Path=/'])), 'xyz');
assert.equal(cd.sessionTokenFrom(response(['velo_platform=nop'])), '');
assert.throws(() => cd.createClient({ apiUrl: 'http://ejemplo.com' }), /no válida/);
assert.doesNotThrow(() => cd.createClient({ apiUrl: 'http://localhost:4000' }));

// Correspondencias: una sola opción se elige sola; lo guardado se reutiliza si sigue existiendo.
const sources = {
  desktop: { users: [{ id: '1', name: 'Administrador' }, { id: '2', name: 'Cajero' }], terminals: [{ terminalId: 't1' }], sessionsWithoutTerminal: [{ id: '9' }], branches: 0, units: [{ name: 'UND', minimum: 0 }, { name: 'KG', minimum: 2 }] },
  cloud: { branches: [{ id: 'b1', name: 'Principal', warehouses: [{ id: 'w1', name: 'General' }], cashRegisters: [{ id: 'r1', name: 'Caja' }] }],
    members: [{ userId: 'u1', branchId: null }, { userId: 'u2', branchId: 'b1' }, { userId: 'u3', branchId: 'otra' }] },
};
let built = cd.buildMapping(sources, {});
assert.deepEqual(built.mapping, { branchId: 'b1', warehouseId: 'w1', users: {}, terminals: { t1: 'r1' }, looseRegister: 'r1' });
assert.deepEqual(built.missing, ['Elige el usuario de Cloud de «Administrador»', 'Elige el usuario de Cloud de «Cajero»']);
assert.deepEqual(built.unitDecimals, { UND: 0, KG: 2 });
// Un usuario de otra sucursal no se acepta; uno repetido tampoco.
built = cd.buildMapping(sources, { users: { 1: 'u1', 2: 'u3' } });
assert.deepEqual(built.mapping.users, { 1: 'u1' });
built = cd.buildMapping(sources, { users: { 1: 'u1', 2: 'u1' } });
assert.ok(built.missing.includes('Cada usuario de Desktop necesita un usuario de Cloud distinto'));
built = cd.buildMapping(sources, { users: { 1: 'u1', 2: 'u2' } });
assert.deepEqual(built.missing, []);
assert.deepEqual(built.options, { location: { branchId: 'b1', warehouseId: 'w1' }, users: { 1: 'u1', 2: 'u2' }, terminals: { t1: 'r1' }, sessionRegisters: { 9: 'r1' }, sourceLocalUtcOffsetMinutes: -240 });
// Con varias cajas no se adivina: hay que elegir.
const two = JSON.parse(JSON.stringify(sources)); two.cloud.branches[0].cashRegisters.push({ id: 'r2', name: 'Caja 2' });
assert.ok(cd.buildMapping(two, { users: { 1: 'u1', 2: 'u2' } }).missing.includes('Elige la caja de la terminal 1'));
// Cuerpos de cada paso, iguales a los de la pantalla web.
assert.deepEqual(cd.stepBody('financialMovementConversion', 'clave', built), { passphrase: 'clave' });
assert.deepEqual(cd.stepBody('catalogConversion', 'clave', built), { passphrase: 'clave', sourceLocalUtcOffsetMinutes: -240, unitDecimals: { UND: 0, KG: 2 } });
assert.deepEqual(cd.stepBody('operationsConversion', 'clave', built), { passphrase: 'clave', options: built.options });

(async () => {
  // Los pasos: salta los superados, reaplica usuarios y cajas, y se detiene en el primero con bloqueos.
  const calls = [];
  const fake = (failAt = null) => ({
    list: async () => [{ id: 'm1', steps: cd.STEPS.map(step => ({ key: step.key, trial: step.key === 'customerConversion' || step.key === 'operationsConversion' ? 'PASSED_AND_ROLLED_BACK' : null, issueCount: 0 })) }],
    prepare: async (id, route) => { calls.push(route); return route === failAt ? { trial: 'BLOCKED_BY_SOURCE_ISSUES', issueCount: 2, issues: [{ code: 'X', table: 'sales' }] } : { trial: 'PASSED_AND_ROLLED_BACK', issueCount: 0 }; },
  });
  const progress = [];
  let out = await cd.runSteps(fake(), { migrationId: 'm1', passphrase: 'clave', built, onProgress: item => progress.push(item) });
  assert.equal(out.ok, true);
  assert.ok(!calls.includes('customers'), 'un paso superado no se repite');
  assert.ok(calls.includes('operations'), 'usuarios y cajas se reaplican siempre');
  assert.equal(calls.length, 19);
  calls.length = 0;
  out = await cd.runSteps(fake('invoices'), { migrationId: 'm1', passphrase: 'clave', built });
  assert.deepEqual({ ok: out.ok, step: out.step, issues: out.issueCount }, { ok: false, step: 'invoiceConversion', issues: 2 });
  assert.equal(calls.at(-1), 'invoices', 'se detiene en el primero con bloqueos');
  console.log('✓ Pasar a VELO Cloud: pasos, sesión, correspondencias y orden sin red');
})().catch(error => { console.error(error); process.exitCode = 1; });
