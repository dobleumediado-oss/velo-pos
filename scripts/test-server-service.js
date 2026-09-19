#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const net = require('net');
const { startServerService } = require('../src/main/server-service');
const { startRpcServer } = require('../src/main/net-server');
const { rpcCall } = require('../src/main/net-client');
const { rpcTimeoutFor } = require('../src/main/ipc-bridge');
const { loadServiceConfig, saveServiceConfig } = require('../src/main/service-config');
const { listLocalAddresses } = require('../lib/network-addresses');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-service-test-'));
const terminalId = 'terminal_test_12345678';
const accessKey = 'TEST-KEY1-KEY2';

function request(port, route, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: payload ? 'POST' : 'GET',
      headers: {
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

function launchFakeWorker({ business, port }) {
  const child = new EventEmitter();
  child.pid = 10000 + port;
  child.exitCode = null;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/r/')) {
      const data = Buffer.from(`<html><body>portal ${business.id}</body></html>`);
      res.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8', 'Content-Length':data.length,
        'Cache-Control':'no-store', 'X-Robots-Tag':'noindex, nofollow',
      });
      res.end(data);
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(':ok\n\n');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const data = Buffer.from(JSON.stringify({
        ok: true,
        data: { businessId: business.id, channel: parsed.channel },
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      res.end(data);
    });
  });
  server.listen(port, '127.0.0.1');
  child.kill = () => {
    if (child.exitCode != null) return;
    child.exitCode = 0;
    server.close(() => child.emit('exit', 0, null));
  };
  return child;
}

(async () => {
  const addresses = listLocalAddresses({
    Ethernet: [{ family: 'IPv4', internal: false, address: '10.211.55.3' }],
    WiFi: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
    Tailscale: [{ family: 'IPv4', internal: false, address: '100.82.10.4' }],
  });
  assert.strictEqual(addresses[0].kind, 'tailscale', 'Tailscale debe recomendarse primero');
  assert.strictEqual(addresses.find(item => item.ip === '10.211.55.3').kind, 'virtual', 'Parallels NAT no debe anunciarse como LAN real');
  assert.strictEqual(addresses.find(item => item.ip === '192.168.1.20').kind, 'lan', 'la IP privada física debe conservarse como LAN');

  const bizId = 'biz_service_test';
  const bizDir = path.join(tmp, 'negocios', bizId);
  fs.mkdirSync(bizDir, { recursive: true });
  fs.writeFileSync(path.join(bizDir, 'meta.json'), JSON.stringify({
    id: bizId,
    name: 'Negocio Secundario',
    active: true,
  }));

  saveServiceConfig(tmp, {
    accessKey,
    allowlist: [terminalId],
    terminalBusinesses: { [terminalId]: ['principal'] },
    port: 8443,
    workerPortStart: 19440,
  });
  const firstUpdatedAt = loadServiceConfig(tmp).updatedAt;
  assert.strictEqual(loadServiceConfig(tmp).updatedAt, firstUpdatedAt, 'leer config no debe reescribir updatedAt');

  const service = startServerService({
    rootDataDir: tmp,
    port: 0,
    publicPort: 0,
    host: '127.0.0.1',
    launchWorker: launchFakeWorker,
  });
  if (!service.server.listening) await new Promise(resolve => service.server.once('listening', resolve));
  if (!service.portalServer.listening) await new Promise(resolve => service.portalServer.once('listening', resolve));
  await new Promise(resolve => setTimeout(resolve, 80));
  const port = service.server.address().port;
  const publicPort = service.portalServer.address().port;

  const health = await request(port, '/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.data.service, 'velo-pos-server-service');

  const portalHealth = await request(publicPort, '/health');
  assert.strictEqual(portalHealth.data.service, 'velo-service-portal');
  const portal = await request(publicPort, '/r/principal/token.public');
  assert.strictEqual(portal.status, 200, 'el gateway público debe enrutar al worker correcto');
  assert.match(portal.text, /portal principal/, 'el gateway debe conservar el HTML del portal');
  const unknownPortal = await request(publicPort, '/r/no-existe/token.public');
  assert.strictEqual(unknownPortal.status, 404, 'el portal no revela negocios inexistentes');

  const auth = { accessKey, terminalId, businessId: 'principal' };
  const list = await request(port, '/rpc', {
    body: { v: 1, channel: 'service:businesses:list', args: {}, auth },
  });
  assert.deepStrictEqual(list.data.data.map(item => item.id), ['principal']);

  const principal = await request(port, '/rpc', {
    body: { v: 1, channel: 'products:getAll', args: {}, auth },
  });
  assert.strictEqual(principal.data.data.businessId, 'principal');

  const denied = await request(port, '/rpc', {
    body: {
      v: 1,
      channel: 'products:getAll',
      args: {},
      auth: { ...auth, businessId: bizId },
    },
  });
  assert.strictEqual(denied.status, 403);

  const current = loadServiceConfig(tmp);
  saveServiceConfig(tmp, {
    ...current,
    terminalBusinesses: { [terminalId]: ['principal', bizId] },
  });
  const secondary = await request(port, '/rpc', {
    body: {
      v: 1,
      channel: 'products:getAll',
      args: {},
      auth: { ...auth, businessId: bizId },
    },
  });
  assert.strictEqual(secondary.data.data.businessId, bizId);

  const remoteAdmin = await request(port, '/rpc', {
    body: { v: 1, channel: 'serverAdmin:getInfo', args: {}, auth },
  });
  // La llamada sí viene de loopback en esta prueba y se enruta siempre al principal.
  assert.strictEqual(remoteAdmin.data.data.businessId, 'principal');

  await service.close();

  // ── Texto con tildes y Ñ íntegro por la red ────────────────────────────────
  // Un proxy reparte el flujo en pedazos irregulares, como una red real: si un
  // extremo decodifica cada pedazo por separado, la Ñ que cae en el corte llega
  // como "��" (así falló la migración de un cliente con "customer_name cambia").
  const texto = Array.from({ length: 6000 }, (_, i) =>
    `${i},"ROMÁN VILLAFAÑA PEÑA","GÜIRA ¿Sí? ¡Año nuevo! €${i}","Ñandú 🚗"`).join('\n');
  const rpcPort = 19880 + Math.floor(Math.random() * 60);
  const rpc = startRpcServer({
    port: rpcPort, host: '127.0.0.1',
    getAccessKey: () => accessKey, getAllowlist: () => [terminalId],
    dispatch: async (channel, args) => (channel === 'prueba:eco'
      ? { llegoIgual: args.texto === texto, texto }
      : { __unknown: true }),
  });
  if (!rpc.server.listening) await new Promise(resolve => rpc.server.once('listening', resolve));
  const trocear = (from, to) => {
    let cola = Promise.resolve();
    from.on('data', buf => {
      cola = cola.then(async () => {
        for (let i = 0; i < buf.length;) {
          const n = 97 + Math.floor(Math.random() * 1400);
          to.write(buf.subarray(i, i + n));
          i += n;
          await new Promise(resolve => setImmediate(resolve));
        }
      });
    });
    from.on('end', () => cola.then(() => to.end()));
  };
  const proxy = net.createServer(cliente => {
    const destino = net.connect(rpcPort, '127.0.0.1');
    cliente.setNoDelay(true); destino.setNoDelay(true);
    trocear(cliente, destino); trocear(destino, cliente);
    cliente.on('error', () => destino.destroy()); destino.on('error', () => cliente.destroy());
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => proxy.once('listening', resolve));
  for (let vuelta = 0; vuelta < 3; vuelta += 1) {
    const eco = await rpcCall({
      host: '127.0.0.1', port: proxy.address().port, accessKey, terminalId, businessId: '',
      channel: 'prueba:eco', args: { texto }, timeoutMs: 30000,
    });
    assert.strictEqual(eco.ok, true, 'la llamada por el proxy debe completarse');
    assert.strictEqual(eco.data.llegoIgual, true, 'el servidor recibe el texto con tildes y Ñ intacto');
    assert.strictEqual(eco.data.texto, texto, 'la terminal recibe el texto con tildes y Ñ intacto');
  }
  await new Promise(resolve => proxy.close(resolve));
  await rpc.close();

  // El gateway espera a una operación larga lo mismo que la terminal: con 12 s
  // fijos cortaba la migración y la pantalla la daba por fallida.
  const gateway = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'server-service.js'), 'utf8');
  assert(gateway.includes('proxyRpc(worker, body, res, rpcTimeoutFor(parsed.channel))') &&
    gateway.includes('timeout: Math.max(12000, Number(timeoutMs) || 0)'),
    'el gateway usa el límite de cada canal y nunca menos de 12 s');
  assert(rpcTimeoutFor('importar:allInOneEquiparts') > 12000,
    'la migración tiene más de 12 s también al pasar por el gateway');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ Server Service: auth, aislamiento por negocio, routing y texto íntegro por la red verificados');
})().catch(async error => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
