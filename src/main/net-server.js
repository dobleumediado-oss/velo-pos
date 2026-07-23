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

  // ── Push tiempo real (Fase C): clientes SSE conectados ──────────────────────
  // Cada entrada es un `res` de una respuesta /events abierta. broadcast() les
  // escribe un aviso "algo cambió en scope X" (sin datos). El heartbeat mantiene
  // vivo el socket a través de NAT/Tailscale.
  const sseClients = new Map();
  const heartbeat = setInterval(() => {
    for (const r of sseClients.keys()) { try { r.write(':hb\n\n'); } catch {} }
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return _sendJson(res, 200, { ok: true, service: 'velo-pos', v: 1 });
    }

    // ── SSE: stream de eventos de cambio (solo aviso, sin datos) ──────────────
    if (req.method === 'GET' && req.url === '/events') {
      const key = req.headers['x-access-key'];
      const tid = req.headers['x-terminal-id'];
      const bid = String(req.headers['x-business-id'] || '');
      const okKey = conn.verifyAccessKey(key, getAccessKey ? getAccessKey() : null);
      const okTid = conn.isTerminalAuthorized(tid, getAllowlist ? getAllowlist() : []);
      if (!okKey || !okTid) {
        log('warn', 'sse rechazado', { reason: !okKey ? 'UNAUTHORIZED' : 'FORBIDDEN' });
        return _sendJson(res, okKey ? 403 : 401, conn.makeResponse(false, null, okKey ? conn.RPC_ERRORS.FORBIDDEN : conn.RPC_ERRORS.UNAUTHORIZED));
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(':ok\n\n');
      sseClients.set(res, bid);
      log('info', 'sse conectado', { terminalId: tid, businessId: bid, total: sseClients.size });
      req.on('close', () => { sseClients.delete(res); });
      return;
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
        const result = await dispatch(parsed.channel, parsed.args, {
          terminalId: parsed.auth && parsed.auth.terminalId,
          businessId: parsed.auth && parsed.auth.businessId,
        });
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

  // Difunde un aviso a todos los clientes SSE. `obj` p.ej. { scopes:['products'] }.
  // Nunca lanza; un cliente muerto se limpia solo en su 'close'.
  const broadcast = (obj, businessId = '') => {
    if (!sseClients.size) return;
    let line;
    try { line = `data: ${JSON.stringify(obj)}\n\n`; } catch { return; }
    for (const [r, clientBusinessId] of sseClients.entries()) {
      if (businessId && clientBusinessId && clientBusinessId !== businessId) continue;
      try { r.write(line); } catch {}
    }
  };

  return {
    server,
    port,
    broadcast,
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const r of sseClients.keys()) { try { r.end(); } catch {} }
      sseClients.clear();
      server.close(resolve);
    }),
  };
}

module.exports = { startRpcServer };
