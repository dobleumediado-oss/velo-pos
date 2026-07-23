#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { startServerService } = require('../src/main/server-service');
const { loadServiceConfig, saveServiceConfig } = require('../src/main/service-config');

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
        resolve({ status: res.statusCode, data });
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
    host: '127.0.0.1',
    launchWorker: launchFakeWorker,
  });
  if (!service.server.listening) await new Promise(resolve => service.server.once('listening', resolve));
  await new Promise(resolve => setTimeout(resolve, 80));
  const port = service.server.address().port;

  const health = await request(port, '/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.data.service, 'velo-pos-server-service');

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
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ Server Service: auth, aislamiento por negocio y routing verificados');
})().catch(async error => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
