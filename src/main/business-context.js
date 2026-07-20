// business-context.js — helpers de filesystem para multi-negocio.
// Mantiene la carpeta raíz de la app separada de la carpeta activa del negocio.
'use strict';

const fs = require('fs');
const path = require('path');

const BUSINESS_ID_RE = /^biz_[A-Za-z0-9_-]+$/;
const DEVICE_SETTING_KEYS = new Set([
  'terminal_id',
  'printer',
  'printer_type',
  'printer_profile',
  'printer_width_mm',
  'printer_dpi',
  'print_config',
  'barcode_printer',
  'barcode_printer_profile',
  'barcode_media_width_mm',
  'barcode_printer_dpi',
  'barcode_media_mode',
]);

function isValidBusinessId(bizId) {
  return typeof bizId === 'string' && BUSINESS_ID_RE.test(bizId);
}

function isDeviceSettingKey(key) {
  const k = String(key || '');
  return /^connection_/.test(k) || DEVICE_SETTING_KEYS.has(k);
}

function pickDeviceSettings(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings || {})) {
    if (isDeviceSettingKey(key)) out[key] = value == null ? '' : String(value);
  }
  return out;
}

function normalizeBusinessInput(input) {
  const name = String(input?.name || '').trim();
  const description = String(input?.description || '').trim();
  if (!name) throw new Error('El nombre del negocio es obligatorio');
  if (name.length > 120) throw new Error('El nombre del negocio no puede pasar de 120 caracteres');
  if (description.length > 500) throw new Error('La descripción no puede pasar de 500 caracteres');
  return { name, description };
}

function getBusinessesDir(rootDataDir) {
  return path.join(rootDataDir, 'negocios');
}

function getArchivedBusinessesDir(rootDataDir) {
  return path.join(rootDataDir, 'negocios_archivados');
}

function getBusinessDir(rootDataDir, bizId) {
  if (!isValidBusinessId(bizId)) throw new Error('ID de negocio inválido');
  return path.join(getBusinessesDir(rootDataDir), bizId);
}

function archiveBusiness(rootDataDir, bizId) {
  const src = getBusinessDir(rootDataDir, bizId);
  if (!fs.existsSync(src)) return { archived: false, src, dest: null };

  const archivedDir = getArchivedBusinessesDir(rootDataDir);
  fs.mkdirSync(archivedDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = path.join(archivedDir, `${bizId}_${stamp}`);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(archivedDir, `${bizId}_${stamp}_${i++}`);
  }

  fs.renameSync(src, dest);
  return { archived: true, src, dest };
}

function loadBusinesses(rootDataDir) {
  const dir = getBusinessesDir(rootDataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => isValidBusinessId(d))
    .filter(d => fs.existsSync(path.join(dir, d, 'meta.json')))
    .map(d => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, d, 'meta.json'), 'utf8'));
        return { ...meta, id: d };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function _activePath(rootDataDir) {
  return path.join(rootDataDir, 'active_business.json');
}

function getActiveBusiness(rootDataDir) {
  const f = _activePath(rootDataDir);
  if (!fs.existsSync(f)) return null;

  let ref;
  try { ref = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }

  const id = ref && String(ref.id || '').trim();
  if (!isValidBusinessId(id)) return null;

  const metaPath = path.join(getBusinessDir(rootDataDir, id), 'meta.json');
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ...meta, id, set_at: ref.set_at || '' };
  } catch {
    return { id, set_at: ref.set_at || '' };
  }
}

function setActiveBusiness(rootDataDir, bizId) {
  const f = _activePath(rootDataDir);
  if (!bizId) {
    try { fs.unlinkSync(f); } catch {}
    return { id: null, dataDir: rootDataDir };
  }

  const id = String(bizId).trim();
  const bizDir = getBusinessDir(rootDataDir, id);
  if (!fs.existsSync(path.join(bizDir, 'meta.json'))) {
    throw new Error('Negocio no encontrado');
  }

  fs.writeFileSync(f, JSON.stringify({ id, set_at: new Date().toISOString() }));
  return { id, dataDir: bizDir };
}

function resolveActiveBusiness(rootDataDir) {
  const active = getActiveBusiness(rootDataDir);
  if (!active || !active.id) {
    return { businessId: null, dataDir: rootDataDir, meta: null };
  }

  return {
    businessId: active.id,
    dataDir: getBusinessDir(rootDataDir, active.id),
    meta: active,
  };
}

module.exports = {
  isValidBusinessId,
  isDeviceSettingKey,
  pickDeviceSettings,
  normalizeBusinessInput,
  getBusinessesDir,
  getArchivedBusinessesDir,
  getBusinessDir,
  archiveBusiness,
  loadBusinesses,
  getActiveBusiness,
  setActiveBusiness,
  resolveActiveBusiness,
};
