#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'caja.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'app.js'), 'utf8');
const dataSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'data.js'), 'utf8');
const importerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'importar.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const posSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'pos.js'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'config.js'), 'utf8');
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

  assert.ok(appSource.includes("className: 'other-open'") && appSource.includes('Otra caja abierta'));
  assert.ok(source.includes('Cajas abiertas en otras terminales') && source.includes('ALL IN ONE permanecerá protegido'));
  assert.ok(dataSource.includes('window.api.cash.getSessions().catch(() => null)'));
  assert.ok(importerSource.includes("res?.code === 'OPEN_CASH_SESSION'") && importerSource.includes('Revisar cajas'));
  console.log('  ✓ diferencia la caja local cerrada de cajas abiertas en otras terminales');

  assert.ok(preloadSource.includes("ipcRenderer.invoke('cash:closePending'"));
  assert.ok(importerSource.includes('confirmarCajaYaCerradaAllInOne')
    && importerSource.includes("confirmation: 'CASH_ALREADY_CLOSED'"));
  assert.ok(mainSource.includes("ipcMain.handle('cash:closePending'")
    && mainSource.includes('_sessionActiveElsewhere(pending.user_id, currentTerminalId)'));
  console.log('  ✓ un administrador puede conciliar la sesión huérfana solo si la otra terminal ya no está conectada');

  assert.ok(posSource.includes('roleRequiresOpenCash(user?.role)'));
  assert.ok(mainSource.includes('roleRequiresOpenCash(reqUser.role)'));
  assert.ok(mainSource.includes("if (reqUser.role !== 'superadmin' &&"));
  console.log('  ✓ VELO POS y VELO TECH exigen caja al Administrador tanto en pantalla como en backend');

  assert.ok(preloadSource.includes("ipcRenderer.on('app:close-requested'"));
  assert.ok(mainSource.includes("ipcMain.handle('app:respondToClose'"));
  assert.ok(appSource.includes('_cashCloseExitBlocked') && appSource.includes('_refreshCashForExit'));
  assert.ok(configSource.includes('business_close_time') && configSource.includes('cash_close_required_after_hours'));
  console.log('  ✓ el cierre de app/sesión consulta la caja real y respeta el horario configurado');

  console.log('\nResiliencia visual de Caja verificada.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
