// ══════════════════════════════════════════════
// ipc-bridge.js — Puente de handlers mode-aware (Fase 2b)
//   Un handler se registra UNA vez y queda disponible según el modo:
//     · local / server → ipcMain.handle ejecuta el handler LOCAL (BD local).
//     · client         → ipcMain.handle REENVÍA la llamada al servidor por red.
//     · dispatch()     → lo usa el servidor de red: SIEMPRE ejecuta local
//                        (el servidor es la fuente de verdad).
//   Migración incremental: los handlers pasan a registerHandler() poco a poco;
//   los no migrados siguen funcionando local igual (no se exponen por red aún).
//   Ver docs/multi-terminal-sync.md
// ══════════════════════════════════════════════
const { rpcCall } = require('./net-client');

// ipcMain solo existe dentro de Electron; en pruebas con node puro no está.
let _ipcMain = null;
try { const e = require('electron'); if (e && e.ipcMain) _ipcMain = e.ipcMain; } catch { /* node puro */ }

const _handlers = new Map();

// Contexto de modo/conexión, inyectado en el arranque (main.js). Por defecto
// 'local' → comportamiento actual intacto aunque no se configure nada.
let _ctx = {
  mode:   () => 'local',
  client: () => ({}),   // { host, port, accessKey, terminalId }
};
function configureBridge({ mode, client } = {}) {
  if (typeof mode === 'function')   _ctx.mode = mode;
  if (typeof client === 'function') _ctx.client = client;
}

// Enrutado mode-aware de una llamada (lo usa el wrapper de ipcMain).
// - client: reenvía al servidor; devuelve el resultado real o LANZA en error/offline
//   (el reject llega al renderer, que puede avisar y bloquear la venta).
// - local/server: ejecuta el handler registrado.
async function routeCall(channel, arg) {
  if (_ctx.mode() === 'client') {
    const cfg = _ctx.client() || {};
    const res = await rpcCall({ ...cfg, channel, args: arg });
    if (res && res.ok === true) return res.data;
    const err = new Error(res && res.offline ? 'SERVER_OFFLINE' : ((res && res.error) || 'RPC_ERROR'));
    err.offline = !!(res && res.offline);
    err.rpc = res && res.error;
    throw err;
  }
  const fn = _handlers.get(channel);
  if (!fn) throw new Error('UNKNOWN_CHANNEL:' + channel);
  return await fn(arg);
}

// Registra un handler. `fn` recibe SOLO el argumento (sin el event de IPC).
function registerHandler(channel, fn) {
  if (typeof channel !== 'string' || !channel) throw new Error('canal inválido');
  if (typeof fn !== 'function') throw new Error('handler inválido');
  _handlers.set(channel, fn);
  if (_ipcMain && typeof _ipcMain.handle === 'function') {
    _ipcMain.handle(channel, (_event, arg) => routeCall(channel, arg));
  }
}

// Despacho del lado SERVIDOR (red): siempre local. { __unknown:true } si no existe.
async function dispatch(channel, args) {
  const fn = _handlers.get(channel);
  if (!fn) return { __unknown: true };
  return await fn(args);
}

// ── Interceptor de ipcMain.handle (migración centralizada) ────────────────────
// Envuelve ipcMain.handle UNA vez: cada handler que se registre después queda
//   (1) disponible para dispatch de red (el servidor puede servirlo), y
//   (2) mode-aware en el lado renderer: en modo 'client' (y si no es local-only)
//       reenvía al servidor; en 'local'/'server' ejecuta el handler local.
// En modo 'local' (por defecto) es un PASSTHROUGH → cero cambio de comportamiento.
// Los handlers de este proyecto usan la firma (event, arg) e ignoran event, así
// que el dispatch de red pasa event=null sin problema.
// `localOnly`: canales que NUNCA se reenvían (identidad, conexión, licencia,
// updater, settings) porque son propios de la máquina.
function installIpcInterceptor(ipcMainRef, { localOnly } = {}) {
  if (!ipcMainRef || typeof ipcMainRef.handle !== 'function' || ipcMainRef.__veloBridgeWrapped) return false;
  const localSet = localOnly instanceof Set ? localOnly : new Set(localOnly || []);
  const orig = ipcMainRef.handle.bind(ipcMainRef);
  ipcMainRef.handle = (channel, fn) => {
    _handlers.set(channel, (arg) => fn(null, arg));
    orig(channel, async (event, arg) => {
      if (_ctx.mode() === 'client' && !localSet.has(channel)) {
        const cfg = _ctx.client() || {};
        const res = await rpcCall({ ...cfg, channel, args: arg });
        if (res && res.ok === true) return res.data;
        const err = new Error(res && res.offline ? 'SERVER_OFFLINE' : ((res && res.error) || 'RPC_ERROR'));
        err.offline = !!(res && res.offline);
        err.rpc = res && res.error;
        throw err;
      }
      return fn(event, arg);
    });
  };
  ipcMainRef.__veloBridgeWrapped = true;
  return true;
}

function hasChannel(channel) { return _handlers.has(channel); }
function channelCount() { return _handlers.size; }

module.exports = { configureBridge, registerHandler, routeCall, dispatch, installIpcInterceptor, hasChannel, channelCount };
