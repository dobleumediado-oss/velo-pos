// ══════════════════════════════════════════════
// net-client.js — Transporte cliente (Fase 2b-2)
//   · Espejo de net-server.js. Cuando connection_mode === 'client', el proceso
//     main usa esto para reenviar las llamadas al servidor por HTTP.
//   · HTTP nativo de Node (sin deps). Sobre Tailscale el tráfico ya va cifrado.
//   · Distingue "servidor no disponible" (offline:true) de un error de handler,
//     para que la UI pueda avisar y bloquear la venta (ver docs §10).
//   Ver docs/multi-terminal-sync.md
// ══════════════════════════════════════════════
const http = require('http');
const conn = require('./connection');

// Llama a un canal en el servidor. Resuelve SIEMPRE (no rechaza) con:
//   { ok:true, data } | { ok:false, error, offline? }
// offline:true → no se pudo llegar al servidor (red/timeout) → la UI debe avisar.
function rpcCall({ host, port, accessKey, terminalId, channel, args, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let payload;
    try { payload = Buffer.from(JSON.stringify(conn.makeRequest(channel, args, { accessKey, terminalId }))); }
    catch { return resolve({ ok: false, error: 'BAD_REQUEST' }); }

    const req = http.request({
      host, port, path: '/rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch { resolve({ ok: false, error: 'BAD_RESPONSE' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT', offline: true }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || 'NETWORK', offline: true }));
    req.write(payload);
    req.end();
  });
}

// Prueba de conexión (botón "Probar conexión"). Devuelve { ok, ms }.
function healthCheck({ host, port, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          resolve({ ok: res.statusCode === 200 && j.ok === true, ms: Date.now() - started, service: j.service });
        } catch { resolve({ ok: false, ms: Date.now() - started }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || 'NETWORK' }));
  });
}

module.exports = { rpcCall, healthCheck };
