'use strict';

// Plan puro para trasladar autorizaciones entre dos servicios. No abre la red
// ni escribe configuración: el destino valida todo antes de guardar un cambio.
const net = require('net');
const crypto = require('crypto');

const PROFILE_MAGIC = 'VELO-TERMINALS-1';

function sealProfile(profile, passphrase) {
  if (String(passphrase || '').length < 12) throw new Error('La clave de traslado debe tener al menos 12 caracteres');
  if (!profile || typeof profile !== 'object') throw new Error('El perfil de terminales no es válido');
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(PROFILE_MAGIC));
  const body = Buffer.from(JSON.stringify(profile));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(JSON.stringify({
    format: PROFILE_MAGIC,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    body: encrypted.toString('base64'),
  }));
}

function openProfile(buffer, passphrase) {
  try {
    const packageFile = JSON.parse(Buffer.from(buffer).toString('utf8'));
    if (packageFile.format !== PROFILE_MAGIC ||
        typeof packageFile.salt !== 'string' || typeof packageFile.nonce !== 'string' ||
        typeof packageFile.tag !== 'string' || typeof packageFile.body !== 'string') {
      throw new Error('Formato no válido');
    }
    const salt = Buffer.from(packageFile.salt, 'base64');
    const nonce = Buffer.from(packageFile.nonce, 'base64');
    const tag = Buffer.from(packageFile.tag, 'base64');
    const body = Buffer.from(packageFile.body, 'base64');
    if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16 || body.length > 1024 * 1024) {
      throw new Error('Tamaño no válido');
    }
    const key = crypto.scryptSync(String(passphrase || ''), salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(PROFILE_MAGIC));
    decipher.setAuthTag(tag);
    const profile = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Perfil no válido');
    return profile;
  } catch {
    throw new Error('No se pudo abrir el perfil; revisa el archivo y la clave');
  }
}

function privateIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const parts = value.split('.').map(Number);
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function normalizeAddresses(addresses) {
  if (!Array.isArray(addresses)) throw new Error('Indica las direcciones LAN o Tailscale del Server nuevo');
  const unique = [...new Set(addresses.map(item => String(item || '').trim()).filter(Boolean))];
  if (!unique.length || unique.length > 3 || unique.some(item => !privateIpv4(item))) {
    throw new Error('Usa una dirección IPv4 privada de LAN o Tailscale para el Server nuevo');
  }
  return unique;
}

function versionAtLeast(actual, minimum) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(actual);
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

async function probeTerminalDestination(directive, currentBusinessId, connection, rpcCall, minimumVersion) {
  if (!directive?.targetServiceId || !Number.isInteger(directive.port) ||
      directive.port < 1024 || directive.port > 65535) return null;
  const businessId = directive.businessMap?.[currentBusinessId];
  if (!businessId || !Array.isArray(directive.addresses)) return null;
  for (const host of directive.addresses) {
    if (!privateIpv4(host)) continue;
    const next = { ...connection, host, port:directive.port, businessId, timeoutMs:3500 };
    const status = await rpcCall({ ...next, channel:'service:status', args:{} });
    if (!status?.ok || status.data?.serviceId !== directive.targetServiceId) continue;
    const ready = await rpcCall({ ...next, channel:'version:getInfo', args:{} });
    if (!ready?.ok || !versionAtLeast(ready.data?.appVersion, minimumVersion)) continue;
    return { host, port:directive.port, businessId };
  }
  return null;
}

function _activeSourceBusinesses(sourceBusinesses) {
  if (!Array.isArray(sourceBusinesses) || !sourceBusinesses.length) {
    throw new Error('No se encontraron negocios en el Server anterior');
  }
  const rows = sourceBusinesses.filter(item => item && item.active !== false)
    .map(item => ({ id: String(item.id || ''), name: String(item.name || item.id || '') }));
  if (!rows.length || rows.some(item => !item.id) || new Set(rows.map(item => item.id)).size !== rows.length) {
    throw new Error('La lista de negocios del Server anterior no es válida');
  }
  return rows;
}

function mapRecoveredBusinesses(sourceBusinesses, targetBusinesses, lockedAt) {
  const source = _activeSourceBusinesses(sourceBusinesses);
  if (!Number.isFinite(Date.parse(lockedAt || ''))) {
    throw new Error('Bloquea primero el Server anterior y crea copias finales');
  }
  const target = Array.isArray(targetBusinesses) ? targetBusinesses : [];
  const mapped = {};
  for (const business of source) {
    const candidates = target.filter(item =>
      item && item.active !== false
      && String(item.origin_business_id || '') === business.id
      && Number.isFinite(Date.parse(item.backup_captured_at || ''))
      && Date.parse(item.backup_captured_at) >= Date.parse(lockedAt));
    if (candidates.length !== 1) {
      throw new Error(candidates.length
        ? `Hay varias copias finales de «${business.name}». Deja una sola para el traslado.`
        : `Falta incorporar una copia final de «${business.name}», creada después del bloqueo. ${target.some(item => String(item?.origin_business_id || '') === business.id) ? 'La copia incorporada es anterior al bloqueo o no permite comprobar su fecha.' : 'No se encontró una copia final de este negocio.'} Crea una copia externa nueva en el Server anterior bloqueado e incorpórala aquí.`);
    }
    mapped[business.id] = String(candidates[0].id);
  }
  if (new Set(Object.values(mapped)).size !== source.length) {
    throw new Error('Dos negocios anteriores apuntan al mismo negocio recuperado');
  }
  return mapped;
}

function markHandoffCopies(businesses, handoffSource) {
  const businessMap = handoffSource?.businessMap || {};
  return (Array.isArray(businesses) ? businesses : []).map(item => {
    const sourceId = String(item?.origin_business_id || '');
    if (!sourceId || !Object.prototype.hasOwnProperty.call(businessMap, sourceId)) return item;
    return { ...item, handoffCopyStatus:
      String(businessMap[sourceId]) === String(item.id) ? 'final' : 'preliminary' };
  });
}

function planTerminalReception({ source, targetConfig, targetBusinesses, lockedAt }) {
  if (!source || !targetConfig || source.vertical !== targetConfig.vertical) {
    throw new Error('Los dos Servers deben ser de la misma edición POS o TECH');
  }
  if (!source.serviceId || !targetConfig.serviceId || source.serviceId === targetConfig.serviceId) {
    throw new Error('El Server nuevo debe tener una identidad distinta');
  }
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(String(source.accessKey || ''))) {
    throw new Error('La clave del Server anterior no es válida');
  }
  const businessMap = mapRecoveredBusinesses(source.businesses, targetBusinesses, lockedAt);
  const sourceTerminals = Array.isArray(source.terminals) ? source.terminals : [];
  const existing = new Set(targetConfig.allowlist || []);
  if ([...existing].some(id => targetConfig.terminalNames?.[id] !== 'Consola del servidor')) {
    throw new Error('El Server nuevo ya tiene terminales propias; no se puede reemplazar su clave de acceso');
  }
  const terminalNames = { ...(targetConfig.terminalNames || {}) };
  const terminalBusinesses = { ...(targetConfig.terminalBusinesses || {}) };
  const mappedBusinesses = Object.values(businessMap);
  let received = 0;
  for (const terminal of sourceTerminals) {
    const id = String(terminal?.terminalId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('Una terminal tiene un ID no válido');
    if (terminal.name === 'Consola del servidor') continue;
    if (existing.has(id)) throw new Error(`La terminal ${id.slice(0, 8)} ya existe en el Server nuevo`);
    const allowed = Array.isArray(terminal.businesses) && terminal.businesses.length
      ? terminal.businesses.map(String)
      : Object.keys(businessMap);
    if (!allowed.length || allowed.some(oldId => !businessMap[oldId])) {
      throw new Error(`La terminal ${id.slice(0, 8)} apunta a un negocio que falta recuperar`);
    }
    existing.add(id);
    terminalNames[id] = String(terminal.name || 'Terminal recuperada').slice(0, 80);
    // Se asignan solo los negocios de la fuente. Una autorización "todos" en
    // el Server anterior jamás abre otros negocios presentes en el destino.
    terminalBusinesses[id] = [...new Set(allowed.map(oldId => businessMap[oldId]))];
    received++;
  }
  if (!received) throw new Error('No hay terminales para trasladar');
  return {
    businessMap,
    terminalCount: received,
    businessCount: mappedBusinesses.length,
    nextConfig: {
      ...targetConfig,
      accessKey: source.accessKey,
      allowlist: [...existing],
      terminalNames,
      terminalBusinesses,
    },
  };
}

module.exports = { sealProfile, openProfile, privateIpv4, normalizeAddresses,
  versionAtLeast, probeTerminalDestination, mapRecoveredBusinesses, markHandoffCopies,
  planTerminalReception };
