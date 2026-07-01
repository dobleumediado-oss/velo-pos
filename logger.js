// ══════════════════════════════════════════════
// LOGGER PERSISTENTE (Fase 2)
// Escribe errores y eventos técnicos a DATA_DIR/logs/velo-YYYY-MM-DD.log
// con rotación por tamaño. Nunca lanza: si falla el log, no debe tumbar la app.
// ══════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

let LOG_DIR = null;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB por archivo antes de rotar

function initLogger(dataDir) {
  try {
    LOG_DIR = path.join(dataDir, 'logs');
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    LOG_DIR = null; // si no se puede crear, el logger queda inerte
  }
}

function _logFile() {
  const day = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `velo-${day}.log`);
}

function _rotateIfNeeded(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      const rotated = file.replace(/\.log$/, `-${Date.now()}.log`);
      fs.renameSync(file, rotated);
      // Conservar solo los 5 rotados más recientes por día
      const base = path.basename(file, '.log');
      const rotados = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith(base + '-') && f.endsWith('.log'))
        .map(f => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      rotados.slice(5).forEach(({ f }) => {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch {}
      });
    }
  } catch {}
}

function log(level, tag, message, extra) {
  if (!LOG_DIR) return;
  try {
    const file = _logFile();
    _rotateIfNeeded(file);
    const ts = new Date().toISOString();
    let line = `[${ts}] [${level}] [${tag}] ${message}`;
    if (extra !== undefined) {
      try { line += ' | ' + JSON.stringify(extra); } catch {}
    }
    fs.appendFileSync(file, line + '\n');
  } catch {}
}

const logError = (tag, message, extra) => log('ERROR', tag, message, extra);
const logWarn  = (tag, message, extra) => log('WARN',  tag, message, extra);
const logInfo  = (tag, message, extra) => log('INFO',  tag, message, extra);

module.exports = { initLogger, log, logError, logWarn, logInfo };
