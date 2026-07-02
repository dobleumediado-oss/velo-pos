// ══════════════════════════════════════════════
// lib/sql-safe.js — Utilidades de SQL seguras (proceso main)
// Compartido por main.js y por los tests. NUNCA se expone al renderer.
// ══════════════════════════════════════════════
'use strict';

/**
 * Escapa un identificador SQLite (nombre de tabla/columna) para interpolarlo
 * de forma segura: duplica comillas dobles según el estándar de SQLite. Se usa
 * al leer bases de datos EXTERNAS durante la importación, donde el nombre de la
 * tabla proviene del sqlite_master del archivo del cliente y no es de confianza.
 */
function sqliteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

module.exports = { sqliteIdent };
