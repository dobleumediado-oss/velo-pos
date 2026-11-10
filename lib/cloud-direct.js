'use strict';
// ══════════════════════════════════════════════
// cloud-direct.js — «Pasar a VELO Cloud» desde Desktop, sin archivos
//   Decisión del dueño (10 nov 2026): Desktop entra a Cloud con la cuenta del
//   negocio, envía la copia y Cloud la convierte, sin llevar archivos ni claves a
//   mano. Primero un ensayo con el negocio trabajando; luego el corte. Desktop
//   solo queda congelado para siempre si Cloud confirma la activación.
//   Este módulo es Node puro (sin Electron): cliente de la API, correspondencias y
//   los 20 pasos en el mismo orden y con los mismos datos que la pantalla web
//   «Convertir pasos» (cloud: apps/web/src/app/(platform)/desktop-migration).
// ══════════════════════════════════════════════
const crypto = require('crypto');

const DEFAULT_API_URL = 'https://api.velosuite.cloud';
// República Dominicana: UTC−4 todo el año (igual que la pantalla web).
const ZONE = -240;
const STEPS = [
  ['customerConversion', 'customers', 'Clientes y representantes'], ['catalogConversion', 'catalog', 'Catálogo'],
  ['operationsConversion', 'operations', 'Usuarios, sucursal y cajas'], ['expenseCategoryConversion', 'expense-categories', 'Categorías de gastos'],
  ['technicianConversion', 'technicians', 'Técnicos'], ['salespersonConversion', 'salespeople', 'Colaboradores'],
  ['financialAccountConversion', 'financial-accounts', 'Cuentas financieras'], ['purchaseConversion', 'purchases', 'Compras'],
  ['invoiceConversion', 'invoices', 'Facturas y numeración'], ['returnConversion', 'returns', 'Devoluciones'],
  ['paymentConversion', 'payments', 'Abonos'], ['quoteConversion', 'quotes', 'Cotizaciones'], ['checkoutConversion', 'checkout', 'Preventas'],
  ['cashConversion', 'cash', 'Movimientos de caja'], ['inventoryConversion', 'inventory', 'Existencias y kardex'], ['expenseConversion', 'expenses', 'Gastos'],
  ['incomeReceiptConversion', 'income-receipts', 'Recibos de ingreso'], ['financialMovementConversion', 'financial-movements', 'Bancos'],
  ['payrollConversion', 'payroll', 'Nóminas'], ['deliveryNoteConversion', 'delivery-notes', 'Conduces'],
].map(([key, route, label]) => ({ key, route, label }));
// Estos pasos no manejan fechas y su API no admite la zona horaria.
const WITHOUT_ZONE = new Set(['expenseCategoryConversion', 'financialAccountConversion', 'financialMovementConversion']);
const passed = step => step && step.trial === 'PASSED_AND_ROLLED_BACK' && step.issueCount === 0;

class CloudError extends Error {
  constructor(message, { status = 0, code = 'CLOUD_ERROR', offline = false, details } = {}) {
    super(message); this.status = status; this.code = code; this.offline = offline; this.details = details;
  }
}

// Clave aleatoria de la copia: la conoce solo este Desktop (y se guarda junto al corte
// para poder deshacerlo en Cloud). Nunca se pide ni se muestra para escribirla.
function newPassphrase() { return crypto.randomBytes(24).toString('base64url'); }

function sessionTokenFrom(response) {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  // velo_session por omisión; si Cloud la renombra (SESSION_COOKIE_NAME), la que termina en _session.
  const parsed = cookies.map(cookie => /^([A-Za-z0-9_-]+)=([^;]*)/.exec(String(cookie).trim())).filter(Boolean);
  const match = parsed.find(item => item[1] === 'velo_session') || parsed.find(item => /_session$/.test(item[1]) && item[1] !== 'velo_platform');
  return match && match[2] ? decodeURIComponent(match[2]) : '';
}

function createClient({ apiUrl = DEFAULT_API_URL, fetchImpl = globalThis.fetch, timeoutMs = 180_000 } = {}) {
  const base = String(apiUrl).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('Dirección de VELO Cloud no válida');
  let token = '';
  async function call(path, { method = 'GET', body, timeout = timeoutMs, auth = true } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, signal: AbortSignal.timeout(timeout),
        headers: { 'x-velo-client': 'desktop', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      // Sin respuesta: puede que Cloud haya hecho el trabajo. Quien llama decide qué comprobar.
      throw new CloudError('Sin conexión con VELO Cloud o tardó demasiado en responder', { offline: true, code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE' });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Un proxy que agota el tiempo tampoco sabe cómo terminó la operación.
      const offline = [502, 503, 504].includes(response.status);
      throw new CloudError(payload?.error?.message || `VELO Cloud respondió ${response.status}`, { status: response.status, code: payload?.error?.code || `HTTP_${response.status}`, offline, details: payload?.error?.details });
    }
    return { payload, response };
  }
  return {
    get apiUrl() { return base; },
    get signedIn() { return !!token; },
    async login({ email, password, vertical, tenantId }) {
      const { payload, response } = await call('/v1/auth/login', { method: 'POST', auth: false, timeout: 30_000, body: { email, password, ...(vertical ? { vertical } : {}), ...(tenantId ? { tenantId } : {}) } });
      if (payload.requiresTenant) return { requiresTenant: true, tenants: payload.tenants || [] };
      const received = sessionTokenFrom(response);
      if (!received) throw new CloudError('VELO Cloud no entregó la sesión', { code: 'NO_SESSION' });
      token = received;
      return { requiresTenant: false };
    },
    async logout() {
      if (!token) return;
      try { await call('/v1/auth/logout', { method: 'POST', body: {}, timeout: 15_000 }); } catch { /* la sesión vence sola */ }
      token = '';
    },
    me: () => call('/v1/auth/me', { timeout: 30_000 }).then(r => r.payload),
    list: () => call('/v1/desktop-migrations', { timeout: 30_000 }).then(r => r.payload),
    get: id => call(`/v1/desktop-migrations/${id}`, { timeout: 30_000 }).then(r => r.payload),
    upload: (buffer, passphrase) => call('/v1/desktop-migrations', { method: 'POST', body: { packageBase64: Buffer.from(buffer).toString('base64'), passphrase } }).then(r => r.payload),
    sources: (id, passphrase) => call(`/v1/desktop-migrations/${id}/operations/sources`, { method: 'POST', body: { passphrase } }).then(r => r.payload),
    prepare: (id, route, body) => call(`/v1/desktop-migrations/${id}/${route}/prepare`, { method: 'POST', body }).then(r => r.payload),
    archiveHistory: (id, passphrase) => call(`/v1/desktop-migrations/${id}/history/archive`, { method: 'POST', body: { passphrase, sourceLocalUtcOffsetMinutes: ZONE } }).then(r => r.payload),
    activate: (id, passphrase, dryRun = false) => call(`/v1/desktop-migrations/${id}/activate`, { method: 'POST', body: { passphrase, confirm: 'ACTIVAR', dryRun } }).then(r => r.payload),
  };
}

// Correspondencias: lo guardado del ensayo se reutiliza; lo que hay una sola
// opción se elige solo; las unidades toman los decimales mínimos que usan los
// artículos. Devuelve también lo que falta elegir, en palabras del dueño.
function buildMapping(sources, saved = {}) {
  const cloud = sources.cloud, desktop = sources.desktop;
  const branches = cloud.branches || [];
  const branch = branches.find(item => item.id === saved.branchId) || (branches.length === 1 ? branches[0] : null);
  const warehouse = branch && ((branch.warehouses || []).find(item => item.id === saved.warehouseId) || (branch.warehouses.length === 1 ? branch.warehouses[0] : null));
  const registers = branch ? branch.cashRegisters || [] : [];
  const eligible = new Set((cloud.members || []).filter(member => !member.branchId || member.branchId === branch?.id).map(member => member.userId));
  const users = {};
  for (const user of desktop.users) { const chosen = (saved.users || {})[user.id]; if (chosen && eligible.has(chosen)) users[user.id] = chosen; }
  const pickRegister = chosen => registers.some(item => item.id === chosen) ? chosen : registers.length === 1 ? registers[0].id : '';
  const terminals = {};
  for (const terminal of desktop.terminals) { const chosen = pickRegister((saved.terminals || {})[terminal.terminalId]); if (chosen) terminals[terminal.terminalId] = chosen; }
  const loose = desktop.sessionsWithoutTerminal.length ? pickRegister(saved.looseRegister) : '';
  const missing = [
    ...(desktop.branches > 1 ? ['La copia tiene varias sucursales de Desktop: hace falta un plan de distribución'] : []),
    ...(!branch ? ['Elige la sucursal de Cloud'] : []), ...(branch && !warehouse ? ['Elige el almacén'] : []),
    ...desktop.users.filter(user => !users[user.id]).map(user => `Elige el usuario de Cloud de «${user.name || user.username}»`),
    ...(new Set(Object.values(users)).size !== Object.values(users).length ? ['Cada usuario de Desktop necesita un usuario de Cloud distinto'] : []),
    ...desktop.terminals.filter(terminal => !terminals[terminal.terminalId]).map((_, index) => `Elige la caja de la terminal ${index + 1}`),
    ...(desktop.sessionsWithoutTerminal.length && !loose ? ['Elige la caja de las sesiones sin terminal'] : []),
  ];
  const mapping = { branchId: branch?.id || '', warehouseId: warehouse?.id || '', users, terminals, looseRegister: loose };
  const options = { location: { branchId: mapping.branchId, warehouseId: mapping.warehouseId }, users, terminals,
    sessionRegisters: Object.fromEntries(desktop.sessionsWithoutTerminal.map(session => [session.id, loose])), sourceLocalUtcOffsetMinutes: ZONE };
  const unitDecimals = Object.fromEntries((desktop.units || []).map(unit => [unit.name, unit.minimum]));
  return { mapping, options, unitDecimals, missing };
}

function stepBody(key, passphrase, built) {
  if (key === 'operationsConversion') return { passphrase, options: built.options };
  if (key === 'catalogConversion') return { passphrase, sourceLocalUtcOffsetMinutes: ZONE, unitDecimals: built.unitDecimals };
  return WITHOUT_ZONE.has(key) ? { passphrase } : { passphrase, sourceLocalUtcOffsetMinutes: ZONE };
}

// Los 20 pasos en orden. Salta los ya superados con esta copia (si uno anterior
// cambia, Cloud marca los siguientes para repetir) y siempre reaplica usuarios y
// cajas. Se detiene en el primero con algo por resolver.
async function runSteps(client, { migrationId, passphrase, built, onProgress = () => {} }) {
  const timings = {};
  for (const step of STEPS) {
    const state = (await client.list()).find(row => row.id === migrationId)?.steps?.find(item => item.key === step.key);
    if (step.key !== 'operationsConversion' && passed(state)) { onProgress({ key: step.key, label: step.label, state: 'ok', text: 'Ya superado' }); continue; }
    onProgress({ key: step.key, label: step.label, state: 'run', text: 'Convirtiendo…' });
    const started = Date.now();
    const out = await client.prepare(migrationId, step.route, stepBody(step.key, passphrase, built));
    timings[step.key] = (Date.now() - started) / 1000;
    if (out.trial !== 'PASSED_AND_ROLLED_BACK' || out.issueCount) {
      onProgress({ key: step.key, label: step.label, state: 'bad', text: `${out.issueCount || 0} por resolver` });
      return { ok: false, step: step.key, label: step.label, issueCount: out.issueCount || 0, issues: (out.issues || []).slice(0, 20), timings };
    }
    onProgress({ key: step.key, label: step.label, state: 'ok', text: `Superado en ${timings[step.key].toFixed(1)} s` });
  }
  return { ok: true, timings };
}

module.exports = { DEFAULT_API_URL, ZONE, STEPS, CloudError, createClient, newPassphrase, buildMapping, stepBody, runSteps, sessionTokenFrom };
