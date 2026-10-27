#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  sealProfile, openProfile, normalizeAddresses, mapRecoveredBusinesses, planTerminalReception,
  versionAtLeast, probeTerminalDestination, markHandoffCopies,
} = require('../src/main/terminal-handoff');

const lockedAt = '2026-10-26T15:00:00.000Z';
const source = {
  vertical: 'POS', serviceId: 'origen', accessKey: 'ABCD-EFGH-JKLM',
  businesses: [
    { id: 'principal', name: 'Tienda Central', active: true },
    { id: 'biz_norte', name: 'Sucursal Norte', active: true },
  ],
  terminals: [
    { terminalId: 'terminal_lan_001', name: 'Caja LAN', businesses: ['principal'] },
    { terminalId: 'terminal_ts_002', name: 'Caja Tailscale', businesses: [] },
    { terminalId: 'console_old_003', name: 'Consola del servidor', businesses: [] },
  ],
};
const targetBusinesses = [
  { id: 'principal', name: 'Base vacía', active: true },
  { id: 'biz_older', origin_business_id: 'principal', backup_captured_at: '2026-10-26T14:00:00.000Z', active: true },
  { id: 'biz_centro_new', origin_business_id: 'principal', backup_captured_at: '2026-10-26T15:05:00.000Z', active: true },
  { id: 'biz_norte_new', origin_business_id: 'biz_norte', backup_captured_at: '2026-10-26T15:06:00.000Z', active: true },
];
const targetConfig = {
  vertical: 'POS', serviceId: 'destino', accessKey: 'WXYZ-ABCD-EFGH',
  allowlist: ['console_new_001'],
  terminalNames: { console_new_001: 'Consola del servidor' },
  terminalBusinesses: {},
};

const sealed = sealProfile(source, 'Clave-de-traslado-segura');
assert.deepStrictEqual(openProfile(sealed, 'Clave-de-traslado-segura'), source);
assert.throws(() => openProfile(sealed, 'Clave-equivocada-segura'), /No se pudo abrir/);
const tampered = JSON.parse(sealed.toString('utf8'));
tampered.body = Buffer.from('archivo alterado').toString('base64');
assert.throws(() => openProfile(Buffer.from(JSON.stringify(tampered)), 'Clave-de-traslado-segura'), /No se pudo abrir/);
assert.throws(() => sealProfile(source, 'corta'), /12 caracteres/);

assert.deepStrictEqual(normalizeAddresses(['100.101.102.103', '192.168.1.8', '100.101.102.103']),
  ['100.101.102.103', '192.168.1.8']);
assert.throws(() => normalizeAddresses(['8.8.8.8']), /privada/);
assert.throws(() => normalizeAddresses(['localhost']), /privada/);
assert.deepStrictEqual(mapRecoveredBusinesses(source.businesses, targetBusinesses, lockedAt), {
  principal: 'biz_centro_new', biz_norte: 'biz_norte_new',
});
const labeledBusinesses = markHandoffCopies(targetBusinesses, {
  businessMap: { principal:'biz_centro_new', biz_norte:'biz_norte_new' },
});
assert.strictEqual(labeledBusinesses.find(item => item.id === 'biz_older').handoffCopyStatus, 'preliminary');
assert.strictEqual(labeledBusinesses.find(item => item.id === 'biz_centro_new').handoffCopyStatus, 'final');
assert.strictEqual(labeledBusinesses.find(item => item.id === 'principal').handoffCopyStatus, undefined);
assert.strictEqual(targetBusinesses.find(item => item.id === 'biz_older').handoffCopyStatus, undefined);
const plan = planTerminalReception({ source, targetConfig, targetBusinesses, lockedAt });
assert.strictEqual(plan.terminalCount, 2);
assert.strictEqual(plan.businessCount, 2);
assert.strictEqual(plan.nextConfig.accessKey, source.accessKey);
assert.deepStrictEqual(plan.nextConfig.terminalBusinesses.terminal_lan_001, ['biz_centro_new']);
assert.deepStrictEqual(plan.nextConfig.terminalBusinesses.terminal_ts_002, ['biz_centro_new', 'biz_norte_new']);
assert(!plan.nextConfig.allowlist.includes('console_old_003'));
assert(plan.nextConfig.allowlist.includes('console_new_001'));
assert.strictEqual(targetConfig.accessKey, 'WXYZ-ABCD-EFGH', 'planificar no altera la configuración actual');

assert.throws(() => planTerminalReception({ source, targetConfig,
  targetBusinesses: targetBusinesses.filter(item => item.id !== 'biz_norte_new'), lockedAt }), /Falta incorporar/);
assert.throws(() => planTerminalReception({ source, targetConfig,
  targetBusinesses: [...targetBusinesses, {
    id: 'biz_centro_duplicate', origin_business_id: 'principal',
    backup_captured_at: '2026-10-26T15:07:00.000Z', active: true,
  }], lockedAt }), /varias copias finales/);
assert.throws(() => planTerminalReception({ source: { ...source, vertical: 'TECH' },
  targetConfig, targetBusinesses, lockedAt }), /misma edición/);
assert.throws(() => planTerminalReception({ source, targetConfig: {
  ...targetConfig, allowlist: ['console_new_001', 'terminal_lan_001'],
}, targetBusinesses, lockedAt }), /terminales propias/);

assert(versionAtLeast('1.58.0', '1.57.0'));
assert(!versionAtLeast('1.56.9', '1.57.0'));
assert(!versionAtLeast('sin-versión', '1.57.0'));

(async () => {
  const directive = { targetServiceId:'destino', port:8443,
    addresses:['192.168.1.8', '100.101.102.103'],
    businessMap:{ principal:'biz_centro_new' } };
  const calls = [];
  const rpcCall = async request => {
    calls.push(request);
    if (request.host === '192.168.1.8') return { ok:false, offline:true };
    if (request.channel === 'service:status') return { ok:true, data:{ serviceId:'destino' } };
    return { ok:true, data:{ appVersion:'1.58.0' } };
  };
  const connection = { accessKey:'ABCD-EFGH-JKLM', terminalId:'terminal_lan_001' };
  const selected = await probeTerminalDestination(directive, 'principal', connection, rpcCall, '1.57.0');
  assert.deepStrictEqual(selected, { host:'100.101.102.103', port:8443, businessId:'biz_centro_new' });
  assert(calls.every(call => call.businessId === 'biz_centro_new'));
  assert.strictEqual(await probeTerminalDestination(directive, 'biz_desconocido', connection, rpcCall, '1.57.0'), null);
  const older = await probeTerminalDestination(directive, 'principal', connection, async request =>
    request.channel === 'service:status'
      ? { ok:true, data:{ serviceId:'destino' } }
      : { ok:true, data:{ appVersion:'1.56.0' } }, '1.57.0');
  assert.strictEqual(older, null, 'una versión vieja nunca recibe la terminal');
  const wrongService = await probeTerminalDestination(directive, 'principal', connection, async () =>
    ({ ok:true, data:{ serviceId:'otro-destino' } }), '1.57.0');
  assert.strictEqual(wrongService, null, 'una IP equivocada nunca recibe la terminal');
  console.log('✓ Traslado: copias finales, permisos y conmutación LAN/Tailscale validados');
})().catch(error => { console.error(error); process.exitCode = 1; });
