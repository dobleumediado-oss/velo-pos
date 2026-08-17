'use strict';

// Regresión multi-terminal: en modo CLIENTE una llamada sin argumentos viaja
// por RPC como JSON, donde `undefined` no existe y `makeRequest` la convierte en
// `null`. El servidor despacha el handler con ese `null`. Muchos handlers del
// proyecto usan la firma `(_, { x } = {})`, cuyo valor por defecto SOLO aplica a
// `undefined`; desestructurar `null` lanza TypeError ANTES del try/catch y el
// servidor responde HANDLER_ERROR (ej.: 'ecf:getConfig' fallaba solo en clientes).
// dispatch() debe normalizar null→undefined para igualar el modo local.

const assert = require('assert');
const bridge = require('../src/main/ipc-bridge');

// Los handlers del proyecto se registran con ipcMain.handle(channel, (event,arg)=>…);
// el interceptor del bridge los envuelve. Simulamos ese ipcMain.
const fakeIpc = { handle(ch, fn) { (this._map || (this._map = {}))[ch] = fn; } };
assert.strictEqual(bridge.installIpcInterceptor(fakeIpc, { localOnly: new Set() }), true);

let received = 'SENTINEL';
fakeIpc.handle('t:getConfig', async (_event, { requestUserId } = {}) => {
  received = requestUserId;
  return { ok: true };
});

(async () => {
  // Antes del fix esto lanzaba TypeError → HANDLER_ERROR.
  const r = await bridge.dispatch('t:getConfig', null, {});
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(received, undefined, 'el default = {} debe aplicar cuando llega null');

  // Un argumento real se respeta intacto.
  received = 'SENTINEL';
  const r2 = await bridge.dispatch('t:getConfig', { requestUserId: 7 }, {});
  assert.deepStrictEqual(r2, { ok: true });
  assert.strictEqual(received, 7);

  console.log('✓ dispatch normaliza null→undefined (handlers sin args no lanzan HANDLER_ERROR en modo cliente)');
})().catch((e) => { console.error('✗ test-ipc-bridge-dispatch:', e); process.exit(1); });
