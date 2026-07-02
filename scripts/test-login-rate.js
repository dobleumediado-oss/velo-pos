#!/usr/bin/env node
/**
 * test-login-rate.js — Regresión del rate limiting de login (anti fuerza bruta).
 * Función con estado interno → corre con node normal. npm run test:login
 * Exit: 0 = OK; 1 = algún fallo.
 */
'use strict';
const rl = require('../lib/login-rate-limit');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FALLO:', msg); } }

console.log('\n== Rate limiting de login ==');
rl._reset();
const email = 'user@test.co';

ok(rl.checkLoginRate(email).allowed === true, 'permite el primer intento');

// Fallar LOGIN_MAX veces → debe quedar bloqueado
for (let i = 0; i < rl.LOGIN_MAX; i++) rl.recordLoginFail(email);
const blocked = rl.checkLoginRate(email);
ok(blocked.allowed === false, `bloquea tras ${rl.LOGIN_MAX} fallos`);
ok(blocked.secsLeft > 0 && blocked.secsLeft <= rl.LOGIN_BLOCK_MS / 1000, `informa segundos restantes (${blocked.secsLeft})`);

// Un login exitoso limpia el estado
rl.clearLoginRate(email);
ok(rl.checkLoginRate(email).allowed === true, 'login exitoso limpia el bloqueo');

// Otro email no se ve afectado por los fallos del primero
rl._reset();
rl.recordLoginFail('a@test.co');
ok(rl.checkLoginRate('b@test.co').allowed === true, 'el bloqueo es por email (no global)');

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
