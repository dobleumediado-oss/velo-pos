'use strict';
// ══════════════════════════════════════════════
// cloud-direct-flow.js — El flujo «Pasar a VELO Cloud» (ensayo, corte, comprobar)
//   Sin Electron: recibe la base, la carpeta del negocio, cómo sacar la copia y
//   cómo auditar. main.js solo valida quién lo pide y expone los canales IPC.
//   Regla del dueño (10 nov 2026): Desktop queda congelado para siempre solo si
//   Cloud confirma la activación. Si Cloud confirma que no se activó, se descongela
//   solo. Si no se puede saber (sin respuesta al activar, sin conexión), queda en
//   consulta hasta comprobarlo: nunca dos sistemas emitiendo NCF a la vez.
// ══════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const cloudDirect = require('./cloud-direct');
const freezer = require('./cloud-cutover-freeze');
const techTestData = require('./tech-test-data');
const inventoryCount = require('./inventory-count');

// Una activación sin respuesta puede seguir terminando en Cloud: se espera antes de concluir.
const ACTIVATION_SETTLE_MS = 5 * 60 * 1000;
const PENDING_STATES = ['verify', 'sending', 'converting', 'activating'];

function createFlow({ getDb, dataDir, makePackage, audit = () => {}, log = () => {}, businessId = () => 'principal', vertical = () => 'POS', apiUrl = () => cloudDirect.DEFAULT_API_URL, fetchImpl, now = () => Date.now() }) {
  let client = null, tenant = null, job = null;
  const stateFile = () => path.join(dataDir(), 'cloud-direct.json');
  const saved = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } };
  function save(patch) {
    const next = { ...saved(), ...patch, updatedAt: new Date(now()).toISOString() };
    const temp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, stateFile());
    return next;
  }
  const session = () => { if (!client?.signedIn || !tenant) throw new Error('Entra primero con tu cuenta de VELO Cloud'); return client; };
  function start(kind) {
    if (job && !job.finishedAt) throw new Error('Ya hay un paso a VELO Cloud en curso');
    job = { kind, phase: 'Preparando…', steps: {}, startedAt: now(), finishedAt: null, result: null };
    return job;
  }
  const phase = (current, text) => { current.phase = text; };
  function finish(current, result) { current.result = result; current.finishedAt = now(); delete current.pending; return result; }
  // Lo que ve la pantalla: nunca la clave ni los datos de la copia.
  function view() { if (!job) return null; const { pending, ...visible } = job; return { ...visible, steps: { ...job.steps }, result: job.result ? { ...job.result } : null }; }

  // Lo que impide el ensayo o el corte, con lo que se puede resolver desde Desktop.
  function checks() {
    const openCash = getDb().prepare("SELECT COUNT(*) AS n FROM cash_sessions WHERE status='open'").get().n;
    const draft = inventoryCount.getDraft(getDb());
    const tech = vertical() === 'POS' ? techTestData.techTestDataStatus(getDb()) : { present: false, activeSales: [], otherTables: [], blockers: [], canRetire: false };
    const items = [];
    if (tech.present && tech.activeSales.length) items.push({ key: 'testSales', blocking: true, text: `Ventas de prueba con equipo (IMEI) sin anular: ${tech.activeSales.map(row => row.number).join(', ')}`, action: 'voidTestSales', sales: tech.activeSales });
    if (tech.present && !tech.activeSales.length) items.push({ key: 'techData', blocking: true, text: 'Datos de prueba de VELO TECH (artículo con IMEI y sus equipos)', action: tech.canRetire ? 'retireTech' : null, detail: tech.otherTables.length ? tech.blockers.join('. ') : '' });
    if (draft) items.push({ key: 'draftCount', blocking: true, text: 'Conteo físico de inventario en borrador', action: 'cancelDraft', countId: draft.session.id });
    if (openCash) items.push({ key: 'openCash', blocking: false, text: openCash === 1 ? 'Hay una caja abierta: el corte exige cuadrarla y cerrarla (el ensayo no)' : `Hay ${openCash} cajas abiertas: el corte exige cuadrarlas y cerrarlas (el ensayo no)`, action: null });
    return { frozen: freezer.status(), items, rehearsalReady: !items.some(item => item.blocking), cutoverReady: !items.length };
  }

  function status() {
    const kept = saved();
    return { apiUrl: apiUrl(), signedIn: !!client?.signedIn, tenant, checks: checks(), job: view(),
      saved: { tenantId: kept.tenantId || null, tenantName: kept.tenantName || null, rehearsal: kept.rehearsal || null, hasMapping: !!kept.mapping },
      marker: freezer.readMarker(dataDir())?.cloud?.state || null };
  }

  async function login({ email, password, tenantId }) {
    if (job && !job.finishedAt) throw new Error('Ya hay un paso a VELO Cloud en curso');
    const next = cloudDirect.createClient({ apiUrl: apiUrl(), fetchImpl });
    const out = await next.login({ email: String(email || '').trim().toLowerCase(), password: String(password || ''), vertical: vertical(), tenantId: tenantId || undefined });
    if (out.requiresTenant) return { requiresTenant: true, tenants: out.tenants };
    const me = await next.me();
    if (!(me.permissions || []).includes('tenant.manage')) { await next.logout(); throw new Error('Esa cuenta no administra la empresa en VELO Cloud'); }
    try { await next.list(); } catch (error) {
      await next.logout();
      throw new Error([404, 409].includes(error.status) ? 'La migración desde Desktop no está habilitada para esta empresa de VELO Cloud. Pídela a VELO.' : error.message);
    }
    // Lo elegido (usuarios y cajas) es de una empresa: otra empresa empieza de cero.
    const kept = saved();
    save(kept.tenantId && kept.tenantId !== me.tenant.id ? { tenantId: me.tenant.id, tenantName: me.tenant.name, mapping: null, rehearsal: null } : { tenantId: me.tenant.id, tenantName: me.tenant.name });
    if (client) await client.logout();
    client = next; tenant = { id: me.tenant.id, name: me.tenant.name, slug: me.tenant.slug, vertical: me.tenant.vertical, user: me.user?.name || '' };
    return { requiresTenant: false, tenant };
  }
  async function logout() {
    if (job && !job.finishedAt) throw new Error('Espera a que termine el paso a VELO Cloud');
    if (client) await client.logout();
    client = null; tenant = null;
  }

  // Ensayo, parte 1: copia de preparación (el negocio sigue trabajando) y lo que hay que elegir.
  async function prepareRehearsal() {
    const api = session();
    if (freezer.isFrozen()) throw new Error('El negocio está congelado: el ensayo se hace con Desktop trabajando');
    if (!checks().rehearsalReady) throw new Error('Resuelve primero lo que aparece en la revisión');
    const current = start('rehearsal-read');
    try {
      const passphrase = cloudDirect.newPassphrase();
      phase(current, 'Sacando una copia del negocio…');
      const buffer = await makePackage({ purpose: 'desktop-migration-preparation', passphrase });
      phase(current, 'Enviando la copia a VELO Cloud…');
      const migration = await api.upload(buffer, passphrase);
      phase(current, 'Leyendo la copia en VELO Cloud…');
      const sources = await api.sources(migration.id, passphrase);
      const built = cloudDirect.buildMapping(sources, saved().mapping || {});
      const result = { ok: true, migrationId: migration.id, sources, mapping: built.mapping, missing: built.missing };
      current.result = result; current.finishedAt = now(); current.pending = { migrationId: migration.id, passphrase, sources };
      return result;
    } catch (error) { finish(current, { ok: false, error: error.message }); throw error; }
  }

  // Ensayo, parte 2: las correspondencias elegidas se guardan y se ensayan los 20 pasos.
  async function runRehearsal(mapping, actor) {
    const api = session();
    const pending = job?.kind === 'rehearsal-read' ? job.pending : null;
    if (!pending) throw new Error('Vuelve a empezar el ensayo');
    const built = cloudDirect.buildMapping(pending.sources, mapping || {});
    if (built.missing.length) throw new Error(built.missing.join('. '));
    save({ mapping: built.mapping });
    const current = start('rehearsal');
    try {
      phase(current, 'Ensayando los 20 pasos en VELO Cloud (no cambia nada)…');
      const started = now();
      const result = await cloudDirect.runSteps(api, { migrationId: pending.migrationId, passphrase: pending.passphrase, built, onProgress: item => { current.steps[item.key] = item; } });
      const seconds = Math.round((now() - started) / 1000);
      save({ rehearsal: { ok: result.ok, at: new Date(now()).toISOString(), tenantId: tenant.id, migrationId: pending.migrationId, seconds, ...(result.ok ? {} : { step: result.label, issueCount: result.issueCount }) } });
      audit(actor, 'ensayo_paso_cloud', result.ok ? `Ensayo superado en ${seconds} s · ${tenant.name}` : `Ensayo detenido en ${result.label}: ${result.issueCount} por resolver`);
      return finish(current, { ...result, seconds });
    } catch (error) { finish(current, { ok: false, error: error.message }); throw error; }
  }

  // Descongelar sin superadmin: solo cuando Cloud confirmó que la copia no quedó activa.
  function autoUnfreeze(reason) {
    if (!freezer.isFrozen()) return null;
    const result = freezer.unfreeze(getDb(), dataDir(), { unfrozenBy: { id: null, name: 'VELO (automático)' }, reason });
    audit(null, 'corte_cloud_descongelado_auto', `${reason} · congelado ${result.frozenAt}`.slice(0, 1000));
    log('warn', 'Desktop descongelado automáticamente', { reason, ...result });
    return result;
  }
  // Sin copia enviada no hay nada que activar. Si Cloud no da el estado, no se sabe.
  async function resolve(migrationId) {
    if (!migrationId) return 'not-activated';
    try { return (await client.get(migrationId)).status === 'ACTIVATED' ? 'activated' : 'not-activated'; }
    catch { return 'unknown'; }
  }

  // El corte: congelar, enviar la copia final, convertir, guardar historial y activar.
  async function cutover(actor, confirm) {
    let migrationId = null, frozenHere = false, activationSent = false, current = null;
    try {
      const api = session();
      if (confirm !== 'CORTE') throw new Error('Escribe CORTE para confirmar');
      if (freezer.isFrozen()) throw new Error('El negocio ya está congelado');
      const kept = saved();
      if (!kept.mapping || kept.tenantId !== tenant.id || !kept.rehearsal?.ok || kept.rehearsal.tenantId !== tenant.id) throw new Error('Haz primero un ensayo superado con esta empresa de VELO Cloud');
      const current_checks = checks();
      if (!current_checks.cutoverReady) throw new Error(current_checks.items.map(item => item.text).join('. '));
      if (getDb().pragma('quick_check', { simple: true }) !== 'ok') throw new Error('La base necesita revisión de integridad antes del corte');
      current = start('cutover');
      const passphrase = cloudDirect.newPassphrase();
      phase(current, 'Congelando Desktop en todas las terminales…');
      const frozenAt = freezer.freeze(getDb(), dataDir(), {
        frozenBy: actor ? { id: actor.id, name: actor.name } : null, businessId: businessId(),
        cloud: { state: 'sending', apiUrl: api.apiUrl, tenantId: tenant.id, tenantName: tenant.name, passphrase },
        beforeFreeze: at => audit(actor, 'corte_cloud_congelado', `Pasar a VELO Cloud (${tenant.name}) · ${at}`),
      });
      frozenHere = true;
      phase(current, 'Sacando la copia final…');
      const buffer = await makePackage({ purpose: 'desktop-cutover-final', frozenAt, passphrase });
      phase(current, 'Enviando la copia final a VELO Cloud…');
      const migration = await api.upload(buffer, passphrase);
      migrationId = migration.id;
      freezer.updateCloud(dataDir(), { state: 'converting', migrationId });
      phase(current, 'Leyendo la copia final…');
      const sources = await api.sources(migrationId, passphrase);
      const built = cloudDirect.buildMapping(sources, kept.mapping);
      if (built.missing.length) throw new Error(`Cambió algo desde el ensayo: ${built.missing.join('. ')}`);
      phase(current, 'Convirtiendo los 20 pasos…');
      const steps = await cloudDirect.runSteps(api, { migrationId, passphrase, built, onProgress: item => { current.steps[item.key] = item; } });
      if (!steps.ok) throw Object.assign(new Error(`${steps.label}: ${steps.issueCount} por resolver`), { issues: steps.issues });
      phase(current, 'Guardando el historial en VELO Cloud…');
      await api.archiveHistory(migrationId, passphrase);
      phase(current, 'Activando en VELO Cloud…');
      freezer.updateCloud(dataDir(), { state: 'activating', activatingAt: new Date(now()).toISOString() });
      activationSent = true;
      const activated = await api.activate(migrationId, passphrase);
      if (activated.status !== 'ACTIVATED') throw new Error('VELO Cloud no confirmó la activación');
      freezer.updateCloud(dataDir(), { state: 'activated', activatedAt: new Date(now()).toISOString() });
      log('info', 'Negocio activado en VELO Cloud', { migrationId, tenantId: tenant.id });
      return finish(current, { ok: true, outcome: 'activated', tenant: tenant.name, imported: activated.imported, durationMs: activated.durationMs, timings: steps.timings, passphrase });
    } catch (error) {
      if (!frozenHere) { if (current) finish(current, { ok: false, error: error.message }); throw error; }
      phase(current, 'Comprobando en VELO Cloud cómo quedó…');
      // Activar sin respuesta: Cloud puede estar terminando. Nunca se descongela en caliente.
      const outcome = activationSent && error.offline ? 'unknown' : await resolve(migrationId);
      if (outcome === 'activated') {
        freezer.updateCloud(dataDir(), { state: 'activated', activatedAt: new Date(now()).toISOString() });
        return finish(current, { ok: true, outcome: 'activated', tenant: tenant?.name, note: 'La respuesta se perdió, pero VELO Cloud confirma la activación.' });
      }
      if (outcome === 'not-activated') {
        autoUnfreeze(`Corte no completado en VELO Cloud: ${error.message}`);
        return finish(current, { ok: false, outcome: 'unfrozen', error: error.message, issues: error.issues || [] });
      }
      try { freezer.updateCloud(dataDir(), { state: 'verify' }); } catch { /* la marca sigue en su último estado pendiente */ }
      return finish(current, { ok: false, outcome: 'verify', error: error.message });
    }
  }

  // Cuando no se pudo saber cómo quedó: volver a preguntar a Cloud.
  async function verify() {
    session();
    const cloud = freezer.readMarker(dataDir())?.cloud;
    if (!cloud || !PENDING_STATES.includes(cloud.state)) throw new Error('No hay un corte por comprobar');
    if (cloud.tenantId !== tenant.id) throw new Error(`Entra con la cuenta de la empresa del corte: ${cloud.tenantName}`);
    const outcome = await resolve(cloud.migrationId);
    // Mientras pueda estar terminando la activación, «no activa todavía» no basta para descongelar.
    const waitMs = cloud.activatingAt ? Date.parse(cloud.activatingAt) + ACTIVATION_SETTLE_MS - now() : 0;
    if (outcome === 'not-activated' && waitMs > 0) return { outcome: 'wait', waitSeconds: Math.ceil(waitMs / 1000) };
    if (outcome === 'activated') { freezer.updateCloud(dataDir(), { state: 'activated', activatedAt: new Date(now()).toISOString() }); return { outcome }; }
    if (outcome === 'not-activated') { autoUnfreeze('Comprobado en VELO Cloud: el corte no quedó activo'); return { outcome: 'unfrozen' }; }
    return { outcome: 'unknown' };
  }

  return { status, checks, login, logout, progress: view, prepareRehearsal, runRehearsal, cutover, verify };
}

module.exports = { createFlow, ACTIVATION_SETTLE_MS };
