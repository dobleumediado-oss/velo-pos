#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'caja.js'), 'utf8');
const context = {
  console, Promise, setTimeout, clearTimeout,
  sessionStorage: { getItem: () => null },
  window: {
    __VELO_TEST_CASH_TIMEOUT_MS: 15,
    api: {
      cash: {
        open: () => new Promise(() => {}),
        getOpen: async () => ({
          id: 21, user_id: 9, open_amount: 500, status: 'open',
        }),
        close: () => new Promise(() => {}),
        getSessions: async () => [{ id: 21, status: 'closed' }],
      },
    },
  },
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'caja.js' });

(async () => {
  const opened = await context.cajaOpenWithRecovery({
    openAmount: 500, openBills: {}, requestUserId: 9, terminalId: 'TEST',
  });
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(opened.recovered, true);
  assert.strictEqual(opened.id, 21);
  console.log('  ✓ recupera una apertura confirmada cuya respuesta se perdió');

  const closed = await context.cajaCloseWithRecovery({
    sessionId: 21, closeAmount: 500, closeBills: {}, expected: 500,
    notes: '', requestUserId: 9,
  });
  assert.strictEqual(closed.ok, true);
  assert.strictEqual(closed.recovered, true);
  console.log('  ✓ recupera un cierre confirmado sin dejar la pantalla procesando');

  const closeHandler = source.slice(
    source.indexOf('async function confirmarCierre'),
    source.indexOf('// ══════════════════════════════════════════════\n// REPORTE DEL DÍA')
  );
  assert.ok(!closeHandler.includes('await imprimirReporteDia('));
  console.log('  ✓ cerrar caja no abre ni imprime el reporte automáticamente');

  console.log('\nResiliencia visual de Caja verificada.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
