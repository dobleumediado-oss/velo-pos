// ══════════════════════════════════════════════
// net-server.js — Servidor RPC del proceso main (Fase 2b)
//   · HTTP nativo de Node (sin dependencias nuevas).
//   · Solo debe arrancarse cuando connection_mode === 'server'.
//   · Autoriza cada petición con connection.js (clave + allowlist de terminal).
//   · Despacha al handler vía la función `dispatch` inyectada (ipc-bridge).
//   Cifrado: cuando el acceso es remoto viaja por el túnel de Tailscale (ya
//   cifrado extremo-a-extremo). En LAN pura es HTTP en claro dentro de la red de
//   confianza; TLS es un endurecimiento posterior (ver docs §11).
//   Endpoints:
//     GET  /health  → { ok, service, v }           (para "Probar conexión")
//     POST /rpc     → { v, channel, args, auth } → { ok, data } | { ok:false, error }
//   Ver docs/multi-terminal-sync.md
// ══════════════════════════════════════════════
const http = require('http');
const conn = require('./connection');

const MAX_BODY = 12 * 1024 * 1024; // 12 MB (data URLs de logo, etc.)

function _sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Arranca el servidor. Retorna { server, port, close() }.
// Config por funciones para leer siempre el valor vigente (clave/allowlist pueden
// cambiar en caliente sin reiniciar).
function startRpcServer({ port = 8443, host = '0.0.0.0', getAccessKey, getAllowlist, dispatch, denyChannel, onLog } = {}) {
  const log = (level, msg, extra) => { try { onLog && onLog(level, msg, extra); } catch {} };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return _sendJson(res, 200, { ok: true, service: 'velo-pos', v: 1 });
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      return _sendJson(res, 404, conn.makeResponse(false, null, conn.RPC_ERRORS.BAD_REQUEST));
    }

    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { aborted = true; res.destroy(); }
    });
    req.on('error', () => { aborted = true; });
    req.on('end', async () => {
      if (aborted) return;
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return _sendJson(res, 400, conn.makeResponse(false, null, conn.RPC_ERRORS.BAD_REQUEST)); }

      const authErr = conn.authorizeRequest(parsed, {
        accessKey: getAccessKey ? getAccessKey() : null,
        allowlist: getAllowlist ? getAllowlist() : [],
      });
      if (authErr) {
        const status = authErr === conn.RPC_ERRORS.FORBIDDEN ? 403
          : authErr === conn.RPC_ERRORS.UNAUTHORIZED ? 401 : 400;
        log('warn', 'rpc rechazado', { channel: parsed && parsed.channel, reason: authErr });
        return _sendJson(res, status, conn.makeResponse(false, null, authErr));
      }

      // Hardening: no servir canales propios de la máquina (config de conexión,
      // identidad, licencia, impresión local) a clientes remotos.
      if (typeof denyChannel === 'function' && denyChannel(parsed.channel)) {
        log('warn', 'rpc canal denegado', { channel: parsed.channel });
        return _sendJson(res, 403, conn.makeResponse(false, null, conn.RPC_ERRORS.FORBIDDEN));
      }

      try {
        const result = await dispatch(parsed.channel, parsed.args, { terminalId: parsed.auth && parsed.auth.terminalId });
        if (result && result.__unknown === true) {
          return _sendJson(res, 404, conn.makeResponse(false, null, conn.RPC_ERRORS.UNKNOWN_CHANNEL));
        }
        return _sendJson(res, 200, conn.makeResponse(true, result));
      } catch (e) {
        log('error', 'rpc handler falló', { channel: parsed.channel, error: e.message });
        return _sendJson(res, 500, conn.makeResponse(false, null, conn.RPC_ERRORS.HANDLER_ERROR));
      }
    });
  });

  server.on('error', (e) => log('error', 'servidor RPC error', { error: e.message }));
  server.listen(port, host, () => log('info', 'servidor RPC escuchando', { host, port }));

  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startRpcServer };
