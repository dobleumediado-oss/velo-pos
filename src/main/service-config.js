'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const conn = require('./connection');

const FILE_NAME = 'server-service.json';

function configPath(rootDataDir) {
  return path.join(rootDataDir, FILE_NAME);
}

function _atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function _legacySettings(rootDataDir) {
  const dbPath = path.join(rootDataDir, 'velo.db');
  if (!fs.existsSync(dbPath)) return {};
  let sqlite;
  try {
    const Database = require('better-sqlite3');
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = sqlite.prepare(`
      SELECT key,value FROM settings
      WHERE key IN (
        'connection_access_key','connection_allowlist',
        'connection_terminal_names','biz_name','terminal_id'
      )
    `).all();
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  } catch {
    return {};
  } finally {
    try { sqlite?.close(); } catch {}
  }
}

function _newAccessKey() {
  return conn.generateAccessKey();
}

function normalizeConfig(raw = {}, legacy = {}) {
  const allowlist = Array.isArray(raw.allowlist)
    ? raw.allowlist.map(String).filter(Boolean)
    : conn.parseAllowlist(legacy.connection_allowlist);
  // Al convertir una instalación existente en Servidor, su propia terminal debe
  // poder conectarse al servicio en localhost desde el primer arranque.
  if (!raw.schemaVersion && legacy.terminal_id && !allowlist.includes(legacy.terminal_id)) {
    allowlist.push(legacy.terminal_id);
  }
  let terminalNames = raw.terminalNames;
  if (!terminalNames || typeof terminalNames !== 'object' || Array.isArray(terminalNames)) {
    try { terminalNames = JSON.parse(legacy.connection_terminal_names || '{}'); }
    catch { terminalNames = {}; }
  }
  const terminalBusinesses = (
    raw.terminalBusinesses &&
    typeof raw.terminalBusinesses === 'object' &&
    !Array.isArray(raw.terminalBusinesses)
  ) ? raw.terminalBusinesses : {};

  return {
    schemaVersion: 1,
    serviceId: String(raw.serviceId || crypto.randomUUID()),
    port: Math.min(65535, Math.max(1024, Number(raw.port) || 8443)),
    accessKey: String(raw.accessKey || legacy.connection_access_key || _newAccessKey()),
    allowlist: [...new Set(allowlist)],
    terminalNames,
    terminalBusinesses,
    defaultBusinessId: String(raw.defaultBusinessId || 'principal'),
    primaryBusinessName: String(raw.primaryBusinessName || legacy.biz_name || 'Negocio Principal'),
    workerPortStart: Math.min(62000, Math.max(12000, Number(raw.workerPortStart) || 18440)),
    localBootstrapComplete: raw.localBootstrapComplete === true,
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
  };
}

function loadServiceConfig(rootDataDir, { create = true } = {}) {
  const file = configPath(rootDataDir);
  let raw = {};
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { raw = {}; }
  }
  const normalized = normalizeConfig(raw, _legacySettings(rootDataDir));
  if (create && (!fs.existsSync(file) || JSON.stringify(raw) !== JSON.stringify(normalized))) {
    _atomicWrite(file, normalized);
  }
  return normalized;
}

function saveServiceConfig(rootDataDir, nextConfig) {
  const normalized = normalizeConfig({
    ...nextConfig,
    updatedAt: new Date().toISOString(),
  }, _legacySettings(rootDataDir));
  _atomicWrite(configPath(rootDataDir), normalized);
  return normalized;
}

function isTerminalAllowedForBusiness(config, terminalId, businessId) {
  if (!conn.isTerminalAuthorized(terminalId, config.allowlist)) return false;
  const assigned = config.terminalBusinesses?.[terminalId];
  if (!Array.isArray(assigned) || assigned.length === 0) return true;
  return assigned.map(String).includes(String(businessId || config.defaultBusinessId || 'principal'));
}

function publicConfig(config) {
  return {
    schemaVersion: config.schemaVersion,
    serviceId: config.serviceId,
    port: config.port,
    allowlist: config.allowlist.map(terminalId => ({
      terminalId,
      name: config.terminalNames?.[terminalId] || '',
      businesses: config.terminalBusinesses?.[terminalId] || [],
    })),
    defaultBusinessId: config.defaultBusinessId,
    primaryBusinessName: config.primaryBusinessName,
    updatedAt: config.updatedAt,
  };
}

module.exports = {
  FILE_NAME,
  configPath,
  loadServiceConfig,
  saveServiceConfig,
  isTerminalAllowedForBusiness,
  publicConfig,
};
