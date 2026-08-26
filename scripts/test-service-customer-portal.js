#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const DB = require('../database');
const { startServicePortalServer } = require('../src/main/service-portal');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-service-portal-'));

function request(port, route, { method = 'GET', form } = {}) {
  return new Promise((resolve, reject) => {
    const payload = form ? Buffer.from(new URLSearchParams(form).toString()) : null;
    const req = http.request({
      host:'127.0.0.1', port, path:route, method,
      headers:payload ? {
        'Content-Type':'application/x-www-form-urlencoded',
        'Content-Length':payload.length,
      } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status:res.statusCode,
        headers:res.headers,
        text:Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

(async () => {
  DB.initDB(tempDir);
  const db = DB.getDB();
  require('../versioning').initVersioning(db, tempDir);
  const admin = db.prepare("SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();
  DB.settingsRepo.set('biz_name', 'Velo Tech Prueba');
  DB.settingsRepo.set('service_public_base_url', 'https://velo-prueba.tail123.ts.net');

  const partId = DB.productsRepo.create({
    code:'PORTAL-PART', name:'Pantalla portal', cost:1000, price:2000, stock:3, taxable:1, tax_pct:18,
  });
  let order = DB.serviceOrdersRepo.create({
    customer_id:1, device_desc:'Teléfono privado', imei:'359999999991234',
    problem:'Pantalla sin imagen', intake_condition:'Equipo con rayones leves', privacy_consent:true,
  }, admin);
  const access = DB.serviceOrdersRepo.getPublicAccess(order.id, { businessId:'principal' }, admin);
  assert.match(access.url, /^https:\/\/velo-prueba\.tail123\.ts\.net\/r\/principal\//);
  assert.ok(!access.url.includes(order.number), 'el enlace no usa número secuencial');

  const portal = startServicePortalServer({ repo:DB.serviceOrdersRepo, businessId:'principal', port:0 });
  if (!portal.server.listening) await new Promise((resolve, reject) => {
    portal.server.once('listening', resolve);
    portal.server.once('error', reject);
  });
  const port = portal.server.address().port;
  const route = access.relativePath;

  let response = await request(port, '/health');
  assert.strictEqual(response.status, 200, 'el monitor local debe responder');
  assert.deepStrictEqual(JSON.parse(response.text), { ok:true, service:'velo-service-portal' });

  response = await request(port, route);
  assert.strictEqual(response.status, 200);
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.headers['strict-transport-security'], /max-age=31536000/);
  assert.match(response.headers['x-robots-tag'], /noindex/);
  assert.ok(response.text.includes('••••1234'), 'muestra solo pista del IMEI');
  assert.ok(!response.text.includes('359999999991234'), 'no expone el IMEI completo');
  ['Equipo recibido y en evaluación','Presupuesto y autorización','Trabajo en proceso','Listo / entregado']
    .forEach(stage => assert.ok(response.text.includes(stage), `muestra etapa pública compacta: ${stage}`));
  assert.ok(!response.text.includes('<b>Inspección inicial</b>'),
    'los estados internos no se duplican como pasos públicos');
  DB.settingsRepo.set('service_public_portal_enabled', '0');
  response = await request(port, route);
  assert.strictEqual(response.status, 404, 'deshabilitar el portal corta el acceso sin reiniciar');
  DB.settingsRepo.set('service_public_portal_enabled', '1');

  order = DB.serviceOrdersRepo.advance(order.id, 'inspeccion', admin);
  order = DB.serviceOrdersRepo.advance(order.id, 'diagnostico', admin);
  order = DB.serviceOrdersRepo.update(order.id, { diagnosis:'Pantalla dañada', items:[
    { kind:'parte', product_id:partId, description:'Pantalla', qty:1, unit_price:2000 },
    { kind:'mano_obra', description:'Instalación', qty:1, unit_price:800 },
  ] });
  order = DB.serviceOrdersRepo.advance(order.id, 'presupuesto', admin);
  order = DB.serviceOrdersRepo.advance(order.id, 'esperando_aprobacion', admin);
  const approval = DB.serviceOrdersRepo.preparePublicApproval(order.id, { businessId:'principal' }, admin);
  assert.match(approval.code, /^\d{6}$/);
  assert.ok(approval.message.includes(approval.url) && approval.message.includes(approval.code));

  response = await request(port, `${route}/decision`, { method:'POST', form:{
    customer_name:'Cliente Portal', code:'000000', decision:'approve', consent:'yes',
  } });
  assert.strictEqual(response.status, 400, 'rechaza un código incorrecto');
  assert.strictEqual(DB.serviceOrdersRepo.getById(order.id).workflow_status, 'esperando_aprobacion');

  for (let attempt=2; attempt<=5; attempt++) {
    response = await request(port, `${route}/decision`, { method:'POST', form:{
      customer_name:'Cliente Portal', code:'000000', decision:'approve', consent:'yes',
    } });
  }
  assert.strictEqual(response.status, 400);
  assert.match(response.text, /Demasiados intentos/, 'bloquea después de cinco códigos incorrectos');
  response = await request(port, `${route}/decision`, { method:'POST', form:{
    customer_name:'Cliente Portal', code:approval.code, decision:'approve', consent:'yes',
  } });
  assert.strictEqual(response.status, 400, 'el código correcto tampoco evade un bloqueo vigente');
  db.prepare(`UPDATE service_order_estimates SET public_locked_until=datetime('now','localtime','-1 minute')
    WHERE service_order_id=? AND version=?`).run(order.id, order.approval_version);

  response = await request(port, `${route}/decision`, { method:'POST', form:{
    customer_name:'Cliente Portal', code:approval.code, decision:'approve', consent:'yes',
  } });
  assert.strictEqual(response.status, 200);
  order = DB.serviceOrdersRepo.getById(order.id);
  assert.strictEqual(order.workflow_status, 'aprobado');
  assert.strictEqual(order.approval_method, 'portal_cliente');

  order = DB.serviceOrdersRepo.advance(order.id, 'reparando', admin);
  order = DB.serviceOrdersRepo.advance(order.id, 'control_calidad', admin);
  order = DB.serviceOrdersRepo.saveQuality(order.id, {
    checklist:{ encendido:true,pantalla:true,carga:true,limpieza:true }, notes:'Todo correcto',
  }, admin);
  order = DB.serviceOrdersRepo.advance(order.id, 'listo', admin);
  assert.ok(order.notifications.some(item => item.notification_type === 'listo' && item.status === 'pending'));
  const ready = DB.serviceOrdersRepo.getSharePayload(order.id, 'listo', { businessId:'principal' }, admin);
  assert.ok(ready.message.includes('listo para retirar') && ready.message.includes(access.url));
  DB.serviceOrdersRepo.markNotificationSent(order.id, 'listo', admin);
  assert.ok(DB.serviceOrdersRepo.getById(order.id).notifications.some(item => item.notification_type === 'listo' && item.status === 'prepared'));

  order = DB.serviceOrdersRepo.deliver(order.id, { method:'efectivo', warrantyDays:30 }, admin, null).order;
  response = await request(port, `${route}/document`);
  assert.strictEqual(response.status, 200);
  assert.ok(response.text.includes('Entrega y garantía') && response.text.includes(order.warranty_until));
  assert.ok(!response.text.includes('359999999991234'));

  DB.serviceOrdersRepo.revokePublicAccess(order.id, admin);
  response = await request(port, route);
  assert.strictEqual(response.status, 404, 'revocar invalida inmediatamente el enlace');

  let rejected = DB.serviceOrdersRepo.create({
    customer_id:1, device_desc:'Laptop de prueba', serial:'LAPTOP-PORTAL-02',
    problem:'No enciende', privacy_consent:true,
  }, admin);
  rejected = DB.serviceOrdersRepo.advance(rejected.id, 'inspeccion', admin);
  rejected = DB.serviceOrdersRepo.advance(rejected.id, 'diagnostico', admin);
  rejected = DB.serviceOrdersRepo.update(rejected.id, { diagnosis:'Daño en circuito de carga', items:[
    { kind:'mano_obra', description:'Reparación de circuito', qty:1, unit_price:1800 },
  ] });
  rejected = DB.serviceOrdersRepo.advance(rejected.id, 'presupuesto', admin);
  rejected = DB.serviceOrdersRepo.advance(rejected.id, 'esperando_aprobacion', admin);
  const rejection = DB.serviceOrdersRepo.preparePublicApproval(rejected.id, { businessId:'principal' }, admin);
  response = await request(port, `${rejection.relativePath}/decision`, { method:'POST', form:{
    customer_name:'Cliente Portal', code:rejection.code, decision:'reject', consent:'yes',
  } });
  assert.strictEqual(response.status, 200, 'el cliente también puede rechazar');
  rejected = DB.serviceOrdersRepo.getById(rejected.id);
  assert.strictEqual(rejected.workflow_status, 'rechazado');
  assert.strictEqual(rejected.estimates.find(item => item.version === rejected.approval_version).decision_method,
    'portal_cliente');

  await portal.close();
  db.close();
  fs.rmSync(tempDir, { recursive:true, force:true });
  console.log('✓ Portal de reparaciones: enlace, privacidad, aprobación/rechazo, avisos, documento y revocación verificados');
})().catch(async error => {
  try { DB.getDB()?.close(); } catch {}
  try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch {}
  console.error(error);
  process.exit(1);
});
