'use strict';
// ══════════════════════════════════════════════
// control-report.js — Reporte diario de VELO Desktop a VELO Control (Fase D)
//   Una vez al día, el equipo envía a Cloud su licencia (como identidad), la
//   versión, el modo y el uso de e-CF del mes con sus rangos. Nunca clientes,
//   montos ni facturas. Si la cuenta de cobro del cliente está al día y su
//   licencia vence pronto, Cloud responde con una licencia renovada (corta,
//   firmada por el servidor) que este equipo instala tras verificarla.
//   Node puro: el proceso main le pasa la base, la licencia y fetch.
// ══════════════════════════════════════════════

const REPORT_TIMEOUT_MS = 20000;

// Uso de e-CF del mes y rangos. Solo desde la base que factura (equipo único o Servidor).
function ecfUsage(db, today) {
  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!hasTable('ecf_sequences') || !hasTable('ecf_documents')) return { monthAccepted: 0, ranges: [] };
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthAccepted = db.prepare(`
    SELECT COUNT(*) AS n FROM ecf_documents d
      JOIN ecf_sequences s ON s.id = d.sequence_id
      JOIN sales v ON v.id = d.sale_id
     WHERE s.environment = 'production' AND d.status IN ('Aceptado', 'Aceptado Condicional')
       AND COALESCE(v.fiscal_issued_at, v.sale_date, date(v.created_at)) >= ?
  `).get(monthStart).n;
  const activeColumn = db.prepare('PRAGMA table_info(ecf_sequences)').all().some(col => col.name === 'active');
  const ranges = db.prepare(`
    SELECT type, environment, expiry_date,
           MAX(0, CAST(substr(last_ncf, 4) AS INTEGER) - next_number + 1) AS remaining
      FROM ecf_sequences ${activeColumn ? 'WHERE active = 1' : ''}
     ORDER BY environment, type, first_ncf
     LIMIT 40
  `).all()
    .filter(row => ['E31', 'E32'].includes(row.type) && ['test', 'production'].includes(row.environment) && /^\d{4}-\d{2}-\d{2}$/.test(row.expiry_date))
    .map(row => ({ type: row.type, environment: row.environment, remaining: Number(row.remaining) || 0, expiresOn: row.expiry_date }));
  return { monthAccepted: Number(monthAccepted) || 0, ranges };
}

function lastSaleOn(db) {
  try {
    const row = db.prepare("SELECT MAX(COALESCE(NULLIF(sale_date,''), date(created_at))) AS day FROM sales").get();
    return row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.day)) ? String(row.day) : undefined;
  } catch { return undefined; }
}

function buildReport({ db, licenseKey, machineId, appVersion, mode, today }) {
  const report = { license: String(licenseKey || ''), machineId, appVersion: String(appVersion || '').slice(0, 30), mode };
  // Una terminal no tiene la base del negocio: solo reporta versión y licencia.
  if (mode !== 'client' && db) {
    report.ecf = ecfUsage(db, today);
    const day = lastSaleOn(db);
    if (day) report.lastSaleOn = day;
  }
  return report;
}

async function sendReport({ apiUrl, report, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${String(apiUrl).replace(/\/+$/, '')}/v1/desktop/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json().catch(() => ({}));
    return { ok: true, license: typeof body.license === 'string' ? body.license : null, renewedUntil: body.renewedUntil || null };
  } catch (error) {
    return { ok: false, offline: true, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// Solo instala una licencia renovada si es para este equipo y vence después de la actual.
function shouldInstall(currentExpiry, renewed, parseLicense) {
  const parsed = parseLicense(renewed);
  if (!parsed || parsed.expiry === 'PERPETUAL') return false;
  if (currentExpiry === 'Perpetua' || currentExpiry === 'PERPETUAL') return false;
  return !currentExpiry || !/^\d{4}-\d{2}-\d{2}$/.test(currentExpiry) || parsed.expiry > currentExpiry;
}

// Cuándo volver a reportar: al día siguiente si salió bien; en una hora si falló
// (sin internet o Cloud no respondió), para no quedarse un día entero sin renovar.
const HOUR_MS = 60 * 60 * 1000;
const REPORT_EVERY_MS = 24 * HOUR_MS;
const RETRY_AFTER_MS = HOUR_MS;
function nextDelayMs(result) {
  return result && result.ok ? REPORT_EVERY_MS : RETRY_AFTER_MS;
}

// Al despertar la PC: reportar si no hay un reporte bueno en las últimas 20 horas.
function shouldReportOnResume(lastOkIso, now = Date.now()) {
  const last = Date.parse(lastOkIso || '');
  return !Number.isFinite(last) || now - last >= 20 * HOUR_MS;
}

// Texto para el usuario de por qué no se pudo conectar (sin jerga).
function failureText(result) {
  if (!result) return 'No se pudo conectar.';
  if (result.offline) return 'Sin conexión a internet o el servicio no respondió.';
  if (result.status === 403) return 'La licencia de este equipo no fue reconocida. Contacta a tu proveedor.';
  if (result.status === 429) return 'Demasiados intentos seguidos. Prueba de nuevo en un rato.';
  return 'El servicio no respondió bien. Se intentará de nuevo en una hora.';
}

module.exports = { buildReport, sendReport, shouldInstall, ecfUsage, nextDelayMs, shouldReportOnResume, failureText, REPORT_EVERY_MS, RETRY_AFTER_MS };
