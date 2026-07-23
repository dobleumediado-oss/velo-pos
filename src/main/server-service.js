'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const businessCtx = require('./business-context');
const conn = require('./connection');
const {
  loadServiceConfig,
  saveServiceConfig,
  isTerminalAllowedForBusiness,
  publicConfig,
} = require('./service-config');

const MAX_BODY = 12 * 1024 * 1024;

function _json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function _readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function _isLoopback(address) {
  const remote = String(address || '');
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function _primaryName(rootDataDir, fallback) {
  const dbPath = path.join(rootDataDir, 'velo.db');
  if (!fs.existsSync(dbPath)) return fallback || 'Negocio Principal';
  let sqlite;
  try {
    const Database = require('better-sqlite3');
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    return sqlite.prepare("SELECT value FROM settings WHERE key='biz_name'").get()?.value
      || fallback
      || 'Negocio Principal';
  } catch {
    return fallback || 'Negocio Principal';
  } finally {
    try { sqlite?.close(); } catch {}
  }
}

function listServiceBusinesses(rootDataDir, config = {}) {
  const principal = {
    id: 'principal',
    name: _primaryName(rootDataDir, config.primaryBusinessName),
    description: 'Base de datos principal',
    dataDir: rootDataDir,
    active: true,
    principal: true,
  };
  const additional = businessCtx.loadBusinesses(rootDataDir)
    .filter(item => item.active !== false)
    .map(item => ({
      ...item,
      id: String(item.id),
      dataDir: businessCtx.getBusinessDir(rootDataDir, String(item.id)),
      principal: false,
    }));
  return [principal, ...additional];
}

function createWorkerManager({ rootDataDir, launchWorker, onLog = () => {} }) {
  if (typeof launchWorker !== 'function') throw new Error('launchWorker requerido');
  const workers = new Map();
  let stopping = false;
  let timer = null;

  const log = (level, message, extra) => {
    try { onLog(level, message, extra); } catch {}
  };

  const start = business => {
    if (stopping || workers.has(business.id)) return workers.get(business.id);
    const config = loadServiceConfig(rootDataDir);
    const usedPorts = new Set([...workers.values()].map(item => item.port));
    let port = config.workerPortStart;
    while (usedPorts.has(port)) port++;
    const child = launchWorker({ business, port, configPath: path.join(rootDataDir, 'server-service.json') });
    const entry = {
      business,
      port,
      child,
      startedAt: new Date().toISOString(),
      ready: false,
      restarts: 0,
      stopped: false,
    };
    workers.set(business.id, entry);
    log('info', 'worker iniciado', { businessId: business.id, port, pid: child?.pid });

    child?.once?.('exit', (code, signal) => {
      const current = workers.get(business.id);
      if (current !== entry) return;
      workers.delete(business.id);
      log(code === 0 || stopping ? 'info' : 'error', 'worker finalizado', {
        businessId: business.id, code, signal,
      });
      if (!stopping && !entry.stopped) {
        setTimeout(() => {
          const exists = listServiceBusinesses(rootDataDir).find(item => item.id === business.id);
          if (exists) start(exists);
        }, 2000);
      }
    });
    return entry;
  };

  const stop = entry => {
    if (!entry || entry.stopped) return;
    entry.stopped = true;
    workers.delete(entry.business.id);
    try { entry.child?.kill?.('SIGTERM'); } catch {}
  };

  const sync = () => {
    if (stopping) return;
    const wanted = listServiceBusinesses(rootDataDir, loadServiceConfig(rootDataDir));
    const ids = new Set(wanted.map(item => item.id));
    wanted.forEach(start);
    for (const [id, entry] of workers.entries()) {
      if (!ids.has(id)) stop(entry);
    }
  };

  sync();
  timer = setInterval(sync, 10000);
  timer.unref?.();

  return {
    workers,
    sync,
    get: businessId => workers.get(String(businessId || '')),
    list: () => [...workers.values()].map(entry => ({
      businessId: entry.business.id,
      name: entry.business.name,
      port: entry.port,
      pid: entry.child?.pid || null,
      startedAt: entry.startedAt,
    })),
    close: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      const entries = [...workers.values()];
      entries.forEach(stop);
      await Promise.all(entries.map(entry => new Promise(resolve => {
        if (!entry.child || entry.child.exitCode != null) return resolve();
        const timeout = setTimeout(() => {
          try { entry.child.kill('SIGKILL'); } catch {}
          resolve();
        }, 5000);
        entry.child.once('exit', () => { clearTimeout(timeout); resolve(); });
      })));
    },
  };
}

function startServerService({
  rootDataDir,
  port,
  host = '0.0.0.0',
  launchWorker,
  onLog = () => {},
} = {}) {
  if (!rootDataDir) throw new Error('rootDataDir requerido');
  fs.mkdirSync(rootDataDir, { recursive: true });
  const manager = createWorkerManager({ rootDataDir, launchWorker, onLog });
  const log = (level, message, extra) => {
    try { onLog(level, message, extra); } catch {}
  };

  const authorize = (auth, businessId, { requireBusiness = true } = {}) => {
    const config = loadServiceConfig(rootDataDir);
    if (!conn.verifyAccessKey(auth?.accessKey, config.accessKey)) return conn.RPC_ERRORS.UNAUTHORIZED;
    if (!conn.isTerminalAuthorized(auth?.terminalId, config.allowlist)) return conn.RPC_ERRORS.FORBIDDEN;
    if (requireBusiness && !isTerminalAllowedForBusiness(config, auth.terminalId, businessId)) {
      return conn.RPC_ERRORS.FORBIDDEN;
    }
    return null;
  };

  const proxyRpc = (worker, body, res) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: worker.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
      timeout: 12000,
    }, upstreamRes => {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const payload = Buffer.concat(chunks);
        res.writeHead(upstreamRes.statusCode || 502, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
          'Content-Length': payload.length,
          'Cache-Control': 'no-store',
        });
        res.end(payload);
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('WORKER_TIMEOUT')));
    upstream.on('error', error => {
      log('error', 'worker RPC no disponible', {
        businessId: worker.business.id,
        error: error.message,
      });
      if (!res.headersSent) _json(res, 503, conn.makeResponse(false, null, 'BUSINESS_UNAVAILABLE'));
    });
    upstream.end(body);
  };

  const proxyEvents = (worker, req, res) => {
    const upstream = http.get({
      host: '127.0.0.1',
      port: worker.port,
      path: '/events',
      headers: {
        Accept: 'text/event-stream',
        'x-access-key': req.headers['x-access-key'] || '',
        'x-terminal-id': req.headers['x-terminal-id'] || '',
        'x-business-id': req.headers['x-business-id'] || '',
      },
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, {
        'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      upstreamRes.pipe(res);
      req.on('close', () => upstreamRes.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) _json(res, 503, conn.makeResponse(false, null, 'BUSINESS_UNAVAILABLE'));
      else res.end();
    });
    req.on('close', () => upstream.destroy());
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const config = loadServiceConfig(rootDataDir);
      return _json(res, 200, {
        ok: true,
        service: 'velo-pos-server-service',
        v: 2,
        workers: manager.list().length,
        businesses: listServiceBusinesses(rootDataDir, config).length,
      });
    }

    // Enrolamiento de una sola vez para la interfaz instalada en la MISMA PC
    // del servicio. Nunca se expone a LAN/Tailscale y se cierra después de usarlo.
    if (req.method === 'POST' && req.url === '/local-bootstrap') {
      if (!_isLoopback(req.socket.remoteAddress)) {
        return _json(res, 403, conn.makeResponse(false, null, conn.RPC_ERRORS.FORBIDDEN));
      }
      let parsed;
      try { parsed = JSON.parse((await _readBody(req)).toString('utf8')); }
      catch { return _json(res, 400, conn.makeResponse(false, null, conn.RPC_ERRORS.BAD_REQUEST)); }
      const terminalId = String(parsed?.terminalId || '').trim();
      const terminalName = String(parsed?.name || 'Servidor local').trim().slice(0, 80);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(terminalId)) {
        return _json(res, 400, conn.makeResponse(false, null, conn.RPC_ERRORS.BAD_REQUEST));
      }
      const current = loadServiceConfig(rootDataDir);
      if (current.localBootstrapComplete && !current.allowlist.includes(terminalId)) {
        return _json(res, 403, conn.makeResponse(false, null, conn.RPC_ERRORS.FORBIDDEN));
      }
      const allowlist = current.allowlist.includes(terminalId)
        ? current.allowlist
        : [...current.allowlist, terminalId];
      const saved = saveServiceConfig(rootDataDir, {
        ...current,
        allowlist,
        terminalNames: { ...current.terminalNames, [terminalId]: terminalName },
        localBootstrapComplete: true,
      });
      return _json(res, 200, conn.makeResponse(true, {
        accessKey: saved.accessKey,
        port: saved.port,
        businessId: saved.defaultBusinessId,
      }));
    }

    if (req.method === 'GET' && req.url === '/events') {
      const businessId = String(req.headers['x-business-id'] || '');
      const auth = {
        accessKey: req.headers['x-access-key'],
        terminalId: req.headers['x-terminal-id'],
      };
      const authError = authorize(auth, businessId);
      if (authError) return _json(res, authError === conn.RPC_ERRORS.UNAUTHORIZED ? 401 : 403,
        conn.makeResponse(false, null, authError));
      const worker = manager.get(businessId);
      if (!worker) return _json(res, 503, conn.makeResponse(false, null, 'BUSINESS_UNAVAILABLE'));
      return proxyEvents(worker, req, res);
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      return _json(res, 404, conn.makeResponse(false, null, conn.RPC_ERRORS.BAD_REQUEST));
    }

    let body;
    let parsed;
    try {
      body = await _readBody(req);
      parsed = JSON.parse(body.toString('utf8'));
    } catch (error) {
      return _json(res, error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
        conn.makeResponse(false, null, conn.RPC_ERRORS.BAD_REQUEST));
    }

    const requestedBusinessId = String(parsed?.auth?.businessId || '');
    const serviceChannel = String(parsed?.channel || '').startsWith('service:');
    const serverAdminChannel = String(parsed?.channel || '').startsWith('serverAdmin:');
    if (serverAdminChannel && !_isLoopback(req.socket.remoteAddress)) {
      return _json(res, 403, conn.makeResponse(false, null, conn.RPC_ERRORS.FORBIDDEN));
    }
    const authError = authorize(parsed?.auth, requestedBusinessId, {
      requireBusiness: !serviceChannel && !serverAdminChannel,
    });
    if (authError) return _json(res, authError === conn.RPC_ERRORS.UNAUTHORIZED ? 401 : 403,
      conn.makeResponse(false, null, authError));

    if (parsed.channel === 'service:businesses:list') {
      const config = loadServiceConfig(rootDataDir);
      const rows = listServiceBusinesses(rootDataDir, config)
        .filter(item => isTerminalAllowedForBusiness(config, parsed.auth.terminalId, item.id))
        .map(({ dataDir, ...item }) => item);
      return _json(res, 200, conn.makeResponse(true, rows));
    }
    if (parsed.channel === 'service:status') {
      const config = loadServiceConfig(rootDataDir);
      return _json(res, 200, conn.makeResponse(true, {
        ...publicConfig(config),
        workers: manager.list(),
      }));
    }
    if (serviceChannel) {
      return _json(res, 404, conn.makeResponse(false, null, conn.RPC_ERRORS.UNKNOWN_CHANNEL));
    }

    const worker = manager.get(serverAdminChannel ? 'principal' : requestedBusinessId);
    if (!worker) return _json(res, 503, conn.makeResponse(false, null, 'BUSINESS_UNAVAILABLE'));
    return proxyRpc(worker, body, res);
  });

  const config = loadServiceConfig(rootDataDir);
  const listenPort = port === 0 ? 0 : (Number(port) || config.port || 8443);
  server.on('error', error => log('error', 'gateway error', { error: error.message }));
  server.listen(listenPort, host, () => {
    log('info', 'Velo POS Server Service iniciado', {
      host,
      port: listenPort,
      rootDataDir,
      businesses: listServiceBusinesses(rootDataDir, config).length,
    });
  });

  return {
    server,
    manager,
    port: listenPort,
    close: async () => {
      await manager.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = {
  listServiceBusinesses,
  createWorkerManager,
  startServerService,
};
