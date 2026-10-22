#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function testServerConsoleRecovery() {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const values = new Map(Object.entries({
    connection_mode: 'client', terminal_id: 'terminal_prueba',
    connection_server_ip: '127.0.0.1', connection_business_id: 'principal',
  }));
  let available = false;
  let workerReady = false;
  let bootstrapCalls = 0;
  let streamUpdates = 0;
  let preflight;
  const client = {
    localBootstrap: async () => {
      bootstrapCalls++;
      return available ? { ok: true, data: { accessKey: 'clave_prueba', port: 8443 } }
        : { ok: false, offline: true };
    },
    healthCheck: async () => ({ ok: available }),
    rpcCall: async ({ accessKey, channel }) => {
      assert.strictEqual(accessKey, 'clave_prueba', 'el reintento usa la clave recuperada');
      if (!workerReady) return { ok: false, error: 'BUSINESS_UNAVAILABLE' };
      return { ok: true, data: channel === 'connection:localGuardHash' ? { hash: '' } : {} };
    },
  };
  const context = vm.createContext({
    app: { isPackaged: true }, RUNTIME: { headless: false },
    process: { resourcesPath: '/recursos-prueba' }, path,
    fs: { existsSync: () => true, readFileSync: () => '{"port":8443}' },
    settingsRepo: { get: key => values.get(key), set: (key, value) => values.set(key, value) },
    require: name => { assert.strictEqual(name, './src/main/net-client'); return client; },
    ipcMain: { handle: (name, fn) => { preflight = fn; } },
    setupMultiTerminal: () => { streamUpdates++; }, logInfo() {}, logWarn() {},
    setTimeout: fn => { fn(); },
  });
  const configureStart = main.indexOf('async function _configureInstalledServerConsole(');
  vm.runInContext(main.slice(configureStart, main.indexOf('\napp.whenReady()', configureStart)), context);
  const preflightStart = main.indexOf("ipcMain.handle('connection:clientPreflight'");
  vm.runInContext(main.slice(preflightStart, main.indexOf('\n// Cambia el modo', preflightStart)), context);
  await context._configureInstalledServerConsole();
  assert.strictEqual(bootstrapCalls, 10, 'el arranque agota sus intentos sin servidor');
  assert.strictEqual((await preflight()).reachable, false);
  available = true;
  const warmingUp = await preflight();
  assert.strictEqual(warmingUp.authorized, false, 'el gateway no basta si el negocio aún arranca');
  assert.strictEqual(warmingUp.reason, 'BUSINESS_UNAVAILABLE');
  assert.strictEqual(streamUpdates, 1, 'se renueva el stream con la clave recuperada');
  workerReady = true;
  assert.strictEqual((await preflight()).authorized, true, 'se recupera sin reiniciar el main');
  assert.strictEqual(streamUpdates, 1, 'no se renueva el stream si nada cambió');

  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src/js/app.js'), 'utf8');
  const start = appSource.indexOf('function renderClientOffline(pf)');
  let checks = 0;
  let reloads = 0;
  let present = true;
  let pending = false;
  const timers = new Map();
  const elements = {};
  const ui = vm.createContext({
    h: (tag, props = {}) => {
      const node = { ...props, appendChild() {}, contains: () => present };
      if (props.id) elements[props.id] = node;
      return node;
    },
    document: { getElementById: id => elements[id] },
    verticalProductName: () => 'Velo POS', _confirmLocalMode() {},
    location: { reload: () => { reloads++; } },
    window: { api: { connection: { clientPreflight: async () => {
      checks++;
      if (pending) await new Promise(resolve => { ui.finishCheck = resolve; });
      return { reachable: true, authorized: checks >= 3, reason: 'BUSINESS_UNAVAILABLE' };
    } } } },
    setTimeout: fn => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  elements.root = { style: {}, appendChild() {}, contains: () => present };
  vm.runInContext(appSource.slice(start, appSource.indexOf('\n// Modal de confirmación', start)), ui);
  ui.renderClientOffline({ host: '127.0.0.1', port: 8443 });
  const tick = async () => {
    const [id, fn] = timers.entries().next().value;
    timers.delete(id);
    await fn();
  };
  await tick();
  assert.strictEqual(reloads, 0, 'no recarga mientras el negocio no esté listo');
  pending = true;
  const running = elements['co-retry'].onclick();
  await elements['co-retry'].onclick();
  assert.strictEqual(checks, 2, 'el botón no inicia comprobaciones simultáneas');
  ui.finishCheck();
  await running;
  pending = false;
  await tick();
  assert.strictEqual(reloads, 1, 'recupera automáticamente al estar autorizado');
  assert.strictEqual(timers.size, 0, 'deja de reintentar al recuperar');
  ui.renderClientOffline({ reachable: true, authorized: false, reason: 'FORBIDDEN' });
  present = false;
  await tick();
  assert.strictEqual(checks, 3, 'no consulta después de abandonar la pantalla');
  console.log('✓ Consola Server: arranque tardío, recuperación del enlace y reintentos sin reiniciar');
}

module.exports = testServerConsoleRecovery;
if (require.main === module) testServerConsoleRecovery().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
