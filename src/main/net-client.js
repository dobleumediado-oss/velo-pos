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

// Fase B — agente keep-alive: reusa la conexión TCP entre llamadas RPC en vez de
// abrir un socket (con su handshake) por cada operación. En LAN/Tailscale esto
// quita el retraso perceptible de guardar venta / abrir caja / cobrar. maxSockets
// acota la concurrencia; keepAliveMsecs mantiene el socket caliente sin fugarlo.
const _agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8, maxFreeSockets: 4 });

// Llama a un canal en el servidor. Resuelve SIEMPRE (no rechaza) con:
//   { ok:true, data } | { ok:false, error, offline? }
// offline:true → no se pudo llegar al servidor (red/timeout) → la UI debe avisar.
function rpcCall({ host, port, accessKey, terminalId, channel, args, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let payload;
    try { payload = Buffer.from(JSON.stringify(conn.makeRequest(channel, args, { accessKey, terminalId }))); }
    catch { return resolve({ ok: false, error: 'BAD_REQUEST' }); }

    const req = http.request({
      host, port, path: '/rpc', method: 'POST', agent: _agent,
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

// ── Consumidor de eventos SSE (Fase C — push tiempo real) ─────────────────────
// El cliente abre un GET /events de larga duración al servidor y recibe avisos
// "algo cambió en scope X" (sin datos). onEvent recibe el objeto ya parseado.
// Robusto: nunca lanza; ante corte/timeout/servidor caído reintenta con backoff.
// Devuelve { close() } para cerrarlo en el before-quit. Autenticación por headers
// (clave + terminalId), verificados por el servidor contra clave y allowlist.
function openEventStream({ host, port, accessKey, terminalId, onEvent, onStatus, retryMs = 3000 }) {
  let stopped = false;
  let req = null;
  let reconnecting = false;

  const scheduleReconnect = () => {
    if (stopped || reconnecting) return;
    reconnecting = true;
    setTimeout(() => { reconnecting = false; connect(); }, retryMs);
  };

  const connect = () => {
    if (stopped) return;
    try {
      req = http.get({
        host, port, path: '/events',
        headers: {
          'Accept': 'text/event-stream',
          'x-access-key': accessKey || '',
          'x-terminal-id': terminalId || '',
        },
        // SIN timeout: la respuesta SSE es de larga duración a propósito.
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          try { onStatus && onStatus({ ok: false, code: res.statusCode }); } catch {}
          return scheduleReconnect();
        }
        try { onStatus && onStatus({ ok: true }); } catch {}
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue; // heartbeat / comentario ':' → ignorar
            const payload = dataLine.slice(5).trim();
            if (!payload) continue;
            try { onEvent && onEvent(JSON.parse(payload)); } catch {}
          }
        });
        res.on('end', scheduleReconnect);
        res.on('error', scheduleReconnect);
      });
      req.on('error', () => { try { onStatus && onStatus({ ok: false }); } catch {} scheduleReconnect(); });
    } catch { scheduleReconnect(); }
  };

  connect();
  return { close: () => { stopped = true; try { req && req.destroy(); } catch {} } };
}

module.exports = { rpcCall, healthCheck, openEventStream };
