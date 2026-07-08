// ══════════════════════════════════════════════
// ipc-bridge.js — Puente de handlers (Fase 2b)
//   Permite que un handler se registre UNA vez y quede disponible por DOS vías:
//     1. ipcMain.handle(canal, ...)  → para el renderer local (como hoy).
//     2. dispatch(canal, args)       → para el servidor de red (clientes remotos).
//   Migración incremental: los handlers existentes se pasan a registerHandler()
//   poco a poco; los no migrados siguen funcionando local igual y simplemente no
//   se exponen por red todavía (el servidor responde UNKNOWN_CHANNEL).
//   Ver docs/multi-terminal-sync.md
// ══════════════════════════════════════════════

// ipcMain solo existe dentro de Electron; en pruebas con node puro no está.
// Se resuelve de forma tolerante para poder testear dispatch() aislado.
let _ipcMain = null;
try { const e = require('electron'); if (e && e.ipcMain) _ipcMain = e.ipcMain; } catch { /* node puro */ }

const _handlers = new Map();

// Registra un handler. `fn` recibe SOLO el argumento (sin el objeto event de IPC),
// para que la misma función sirva a ipcMain y a la red sin ramas.
function registerHandler(channel, fn) {
  if (typeof channel !== 'string' || !channel) throw new Error('canal inválido');
  if (typeof fn !== 'function') throw new Error('handler inválido');
  _handlers.set(channel, fn);
  if (_ipcMain && typeof _ipcMain.handle === 'function') {
    _ipcMain.handle(channel, (_event, arg) => fn(arg));
  }
}

// Despacha una petición de red al handler correspondiente.
// Devuelve { __unknown: true } si el canal no está registrado (el servidor lo
// traduce a UNKNOWN_CHANNEL) — se distingue de un resultado real del handler.
async function dispatch(channel, args) {
  const fn = _handlers.get(channel);
  if (!fn) return { __unknown: true };
  return await fn(args);
}

function hasChannel(channel) { return _handlers.has(channel); }
function channelCount() { return _handlers.size; }

module.exports = { registerHandler, dispatch, hasChannel, channelCount };
