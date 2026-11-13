'use strict';
// ══════════════════════════════════════════════
// cloud-cutover-freeze.js — Modo consulta para el corte a VELO Cloud
//   Decisión del dueño (7 nov 2026): el día del corte se cuadra y se cierra la
//   caja, Desktop congela el negocio en TODAS sus terminales y saca la copia
//   final; Cloud la activa. Desde ese momento Desktop solo consulta: un solo
//   sistema emite documentos y consume NCF.
//   · La marca vive en un archivo de la carpeta del negocio (la base ya no
//     admite escrituras) y sobrevive reinicios y actualizaciones.
//   · Garantía dura: PRAGMA query_only en la conexión. SQLite rechaza toda
//     escritura, venga de esta PC o de una terminal a través del Servidor.
//   · Mensaje claro: db.prepare rechaza antes de ejecutar una sentencia que
//     escribe, y el puente IPC traduce el error crudo de SQLite.
//   · Descongelar solo lo hace un superadmin y solo si Cloud no llegó a
//     activarse o se deshizo el corte. Queda registrado en el archivo y en la
//     auditoría.
//   better-sqlite3 es síncrono: congelar entre dos operaciones nunca deja una
//   transacción a medias.
// ══════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const MARKER = 'cloud-cutover.json';
const FROZEN_CODE = 'VELO_CUTOVER_FROZEN';
const FROZEN_MESSAGE = 'Este negocio ya opera en VELO Cloud: Desktop está en modo consulta y no guarda cambios.';

let _state = null; // { frozenAt, frozenBy, businessId, dataDir } del negocio abierto en este proceso

function markerPath(dataDir) { return path.join(dataDir, MARKER); }

function readMarker(dataDir) {
  const file = markerPath(dataDir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  // Un archivo dañado no descongela: se trata como congelado sin datos.
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.frozenAt !== 'string' || Number.isNaN(Date.parse(data.frozenAt))) throw new Error('marca no válida');
    return data;
  } catch { return { frozenAt: new Date(fs.statSync(file).mtimeMs).toISOString(), damaged: true }; }
}

function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  // Windows solo vacía a disco un archivo abierto con escritura: con 'r' fsync da EPERM.
  const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function frozenError() { const error = new Error(FROZEN_MESSAGE); error.code = FROZEN_CODE; return error; }

// Envuelve db.prepare una sola vez por conexión: una sentencia que escribe se
// rechaza con el mensaje claro mientras el negocio esté congelado.
function guardConnection(db) {
  if (db.__veloCutoverGuard) return;
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (_state && db.__veloCutoverFrozen && !statement.readonly) throw frozenError();
    return statement;
  };
  db.__veloCutoverGuard = true;
}

function applyToConnection(db, state) {
  guardConnection(db);
  db.pragma('query_only = ON');
  db.__veloCutoverFrozen = true;
  _state = state;
}

// Arranque: si el negocio quedó congelado, se abre en modo consulta.
function applyIfMarked(db, dataDir) {
  const marker = readMarker(dataDir);
  if (!marker) { _state = null; return null; }
  applyToConnection(db, { ...marker, dataDir });
  return status();
}

function freeze(db, dataDir, { frozenBy, businessId, beforeFreeze, cloud } = {}) {
  if (readMarker(dataDir)) throw new Error('Este negocio ya está congelado para el corte');
  const frozenAt = new Date().toISOString();
  const marker = { format: 1, frozenAt, frozenBy: frozenBy || null, businessId: businessId || null, reason: 'Corte final a VELO Cloud', ...(cloud ? { cloud } : {}) };
  // Lo último que se escribe en la base es su propia auditoría.
  if (typeof beforeFreeze === 'function') beforeFreeze(frozenAt);
  writeAtomic(markerPath(dataDir), marker);
  applyToConnection(db, { ...marker, dataDir });
  return frozenAt;
}

// Descongelar: la marca se conserva renombrada, con quién, cuándo y por qué.
function unfreeze(db, dataDir, { unfrozenBy, reason } = {}) {
  const marker = readMarker(dataDir);
  if (!marker) throw new Error('Este negocio no está congelado');
  const unfrozenAt = new Date().toISOString();
  const archived = path.join(dataDir, `cloud-cutover.descongelado-${unfrozenAt.replace(/[:.]/g, '-')}.json`);
  writeAtomic(archived, { ...marker, unfrozenAt, unfrozenBy: unfrozenBy || null, unfreezeReason: String(reason || '') });
  fs.unlinkSync(markerPath(dataDir));
  db.pragma('query_only = OFF');
  db.__veloCutoverFrozen = false;
  _state = null;
  return { frozenAt: marker.frozenAt, unfrozenAt };
}

// «Pasar a VELO Cloud»: anota en la marca cómo va el corte en Cloud (copia enviada,
// activada o por comprobar). La marca vive fuera de la base, que está en solo lectura.
function updateCloud(dataDir, patch) {
  const marker = readMarker(dataDir);
  if (!marker || marker.damaged) throw new Error('Este negocio no está congelado');
  const next = { ...marker, cloud: { ...(marker.cloud || {}), ...patch } };
  writeAtomic(markerPath(dataDir), next);
  if (_state && _state.dataDir === dataDir) _state = { ..._state, cloud: next.cloud };
  return next.cloud;
}

function isFrozen() { return !!_state; }
function status() {
  if (!_state) return { frozen: false };
  // De Cloud solo se informa el estado, nunca la clave de la copia.
  const base = { frozen: true, frozenAt: _state.frozenAt, frozenBy: _state.frozenBy || null, damaged: !!_state.damaged };
  return _state.cloud ? { ...base, cloud: { state: _state.cloud.state || null, tenantName: _state.cloud.tenantName || null, activatedAt: _state.cloud.activatedAt || null } } : base;
}
function isFrozenDir(dataDir) { try { return !!readMarker(dataDir); } catch { return true; } }

// El puente IPC usa esto para dar el mismo mensaje sin importar dónde falló la escritura.
function isFrozenFailure(value) {
  if (!_state || !value) return false;
  const message = typeof value === 'string' ? value : value.message || value.error || '';
  return value.code === FROZEN_CODE || value.code === 'SQLITE_READONLY' || message === FROZEN_MESSAGE || /readonly database|VELO_CUTOVER_FROZEN/i.test(String(message));
}
function friendlyResult(out) {
  if (out && typeof out === 'object' && out.ok === false && isFrozenFailure(String(out.error || ''))) return { ...out, error: FROZEN_MESSAGE, cutoverFrozen: true };
  return out;
}

module.exports = { MARKER, FROZEN_CODE, FROZEN_MESSAGE, readMarker, applyIfMarked, freeze, unfreeze, updateCloud, isFrozen, isFrozenDir, status, isFrozenFailure, friendlyResult, frozenError };
