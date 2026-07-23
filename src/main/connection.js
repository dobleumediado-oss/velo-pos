// ══════════════════════════════════════════════
// connection.js — Núcleo de conexión multi-terminal (Fase 2a)
//   · Lógica PURA y aislada: NO abre sockets, NO toca la BD, NO tiene estado.
//   · El servidor de red (Fase 2b) y el transporte cliente usarán estos helpers.
//   · Seguridad primero: verificación de clave en tiempo constante + allowlist
//     de terminales (deny por defecto).
//   Ver docs/multi-terminal-sync.md
// ══════════════════════════════════════════════
const crypto = require('crypto');

// Códigos de error del protocolo RPC (estables — el cliente los interpreta).
const RPC_ERRORS = {
  BAD_REQUEST:     'BAD_REQUEST',      // sobre malformado
  UNAUTHORIZED:    'UNAUTHORIZED',     // clave de acceso inválida
  FORBIDDEN:       'FORBIDDEN',        // terminal no está en la allowlist
  UNKNOWN_CHANNEL: 'UNKNOWN_CHANNEL',  // canal no registrado en el servidor
  HANDLER_ERROR:   'HANDLER_ERROR',    // el handler lanzó una excepción
};

// Genera una clave de acceso legible (formato XXXX-XXXX-XXXX) para que el
// servidor la muestre y el cliente la pegue. Es UNA de las capas (además hay
// allowlist de terminal y la red privada de Tailscale).
function generateAccessKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O/0/I/1 (legibilidad)
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

// Comparación en tiempo constante — no filtra la clave por timing.
function verifyAccessKey(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Allowlist de terminales autorizadas (setting connection_allowlist = JSON array
// de terminalIds). Deny por defecto: allowlist vacía = nadie entra.
function parseAllowlist(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function isTerminalAuthorized(terminalId, allowlist) {
  if (!terminalId || !Array.isArray(allowlist) || !allowlist.length) return false;
  return allowlist.includes(terminalId);
}

// Autoriza una petición completa: valida el sobre, la clave y la allowlist.
// Devuelve null si todo OK, o un código RPC_ERRORS si algo falla.
function authorizeRequest(req, { accessKey, allowlist } = {}) {
  const bad = validateRequest(req);
  if (bad) return bad;
  if (!verifyAccessKey(req.auth.accessKey, accessKey)) return RPC_ERRORS.UNAUTHORIZED;
  if (!isTerminalAuthorized(req.auth.terminalId, allowlist)) return RPC_ERRORS.FORBIDDEN;
  return null;
}

// ── Sobre RPC (JSON) — el transporte HTTP/WS solo lo serializa ──
function makeRequest(channel, args, { accessKey, terminalId, businessId } = {}) {
  return {
    v: 1,
    channel,
    args: args === undefined ? null : args,
    auth: {
      accessKey,
      terminalId,
      businessId: businessId == null ? '' : String(businessId),
    },
  };
}
function validateRequest(req) {
  if (!req || typeof req !== 'object') return RPC_ERRORS.BAD_REQUEST;
  if (typeof req.channel !== 'string' || !req.channel) return RPC_ERRORS.BAD_REQUEST;
  if (!req.auth || typeof req.auth !== 'object') return RPC_ERRORS.UNAUTHORIZED;
  return null;
}
function makeResponse(ok, data, error) {
  return ok ? { ok: true, data } : { ok: false, error: error || 'error' };
}

module.exports = {
  RPC_ERRORS,
  generateAccessKey, verifyAccessKey,
  parseAllowlist, isTerminalAuthorized, authorizeRequest,
  makeRequest, validateRequest, makeResponse,
};
