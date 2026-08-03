'use strict';

// Los NCF serie B se componen de un tipo fijo de 3 caracteres (B01, B02…)
// y un correlativo de EXACTAMENTE 8 dígitos. La base solo debe almacenar el
// correlativo como entero; nunca los dígitos del tipo dentro de from/current/to.
const LEGACY_NCF_TYPES = new Set(['B01', 'B02', 'B04', 'B14', 'B15', 'B16', 'B17']);
const MAX_LEGACY_SEQUENCE = 99_999_999;

function normalizeLegacyType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!LEGACY_NCF_TYPES.has(type)) {
    throw new Error(`Tipo de NCF no soportado: ${type || 'vacío'}`);
  }
  return type;
}

function _digits(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function normalizeLegacySequenceNumber(typeValue, value, { allowZero = false } = {}) {
  const type = normalizeLegacyType(typeValue);
  let raw = _digits(value);
  if (!raw) throw new Error(`El correlativo ${type} es obligatorio`);

  // Permite pegar el NCF completo (B0100000849) sin contaminar el contador.
  if (raw.startsWith('B')) {
    if (!raw.startsWith(type)) throw new Error(`El comprobante ${raw} no corresponde a ${type}`);
    raw = raw.slice(type.length);
  }
  if (!/^\d+$/.test(raw)) throw new Error(`El correlativo ${type} solo admite números`);

  if (raw.length > 8) {
    const typeDigits = type.slice(1);                 // 01, 02, 14…
    const numericType = typeDigits.replace(/^0+/, ''); // 1, 2, 14…
    const extra = raw.slice(0, -8);
    const knownContamination = extra === typeDigits ||
      extra === numericType || /^0+$/.test(extra);
    if (!knownContamination) {
      throw new Error(
        `${raw} mezcla el tipo ${type} con un correlativo inválido; usa solo los últimos 8 dígitos`
      );
    }
    raw = raw.slice(-8);
  }

  const sequence = Number.parseInt(raw, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(sequence) || sequence < minimum || sequence > MAX_LEGACY_SEQUENCE) {
    throw new Error(`El correlativo ${type} debe estar entre ${minimum} y ${MAX_LEGACY_SEQUENCE}`);
  }
  return sequence;
}

function normalizeLegacySequenceRange(type, fromValue, toValue) {
  const from = normalizeLegacySequenceNumber(type, fromValue);
  const to = normalizeLegacySequenceNumber(type, toValue);
  if (from > to) throw new Error('El inicio del rango no puede ser mayor que el final');
  return { from, to };
}

function formatLegacyNcf(typeValue, sequenceValue) {
  const type = normalizeLegacyType(typeValue);
  const sequence = normalizeLegacySequenceNumber(type, sequenceValue);
  return `${type}${String(sequence).padStart(8, '0')}`;
}

function canonicalizeLegacyNcf(value) {
  const raw = _digits(value);
  const match = raw.match(/^(B\d{2})(\d+)$/);
  if (!match || !LEGACY_NCF_TYPES.has(match[1])) return null;
  try {
    return formatLegacyNcf(match[1], match[2]);
  } catch {
    return null;
  }
}

function parseCanonicalLegacyNcf(value) {
  const raw = _digits(value);
  const match = raw.match(/^(B(?:01|02|04|14|15|16|17))(\d{8})$/);
  if (!match) return null;
  return { type: match[1], sequence: Number.parseInt(match[2], 10), ncf: raw };
}

function _tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function _columnExists(db, table, column) {
  return _tableExists(db, table) && db.prepare(`PRAGMA table_info(${table})`).all()
    .some(row => row.name === column);
}

// Corrige únicamente la contaminación mecánica conocida. No borra documentos,
// no reasigna IDs y conserva old_value/new_value para auditoría y soporte.
function repairLegacyNcfData(db) {
  const result = { sales: 0, log: 0, references: 0, sequences: 0, conflicts: [] };
  db.exec(`
    CREATE TABLE IF NOT EXISTS ncf_normalization_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_table TEXT NOT NULL,
      source_id    INTEGER NOT NULL,
      field_name   TEXT NOT NULL,
      old_value    TEXT NOT NULL,
      new_value    TEXT NOT NULL,
      reason       TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(source_table,source_id,field_name,old_value,new_value)
    );
  `);
  const audit = db.prepare(`
    INSERT OR IGNORE INTO ncf_normalization_log
      (source_table,source_id,field_name,old_value,new_value,reason)
    VALUES(?,?,?,?,?,'Normalización NCF serie B: tipo + correlativo de 8 dígitos')
  `);

  const repairField = (table, field, counter) => {
    if (!_columnExists(db, table, field)) return;
    const rows = db.prepare(`SELECT id,${field} value FROM ${table} WHERE TRIM(COALESCE(${field},''))<>''`).all();
    const existsTarget = db.prepare(`SELECT id FROM ${table} WHERE ${field}=? AND id<>? LIMIT 1`);
    const update = db.prepare(`UPDATE ${table} SET ${field}=? WHERE id=?`);
    rows.forEach(row => {
      const oldValue = String(row.value || '').trim().toUpperCase();
      const nextValue = canonicalizeLegacyNcf(oldValue);
      if (!nextValue || nextValue === oldValue) return;
      const collision = field === 'ncf' ? existsTarget.get(nextValue, row.id) : null;
      if (collision) {
        result.conflicts.push({ table, id: row.id, field, oldValue, nextValue, collisionId: collision.id });
        return;
      }
      audit.run(table, row.id, field, oldValue, nextValue);
      update.run(nextValue, row.id);
      result[counter]++;
    });
  };

  if (_tableExists(db, 'sales')) repairField('sales', 'ncf', 'sales');
  if (_tableExists(db, 'ncf_log')) {
    repairField('ncf_log', 'ncf', 'log');
    repairField('ncf_log', 'modifies_ncf', 'references');
  }

  if (_tableExists(db, 'ncf_sequences')) {
    const rows = db.prepare('SELECT * FROM ncf_sequences ORDER BY id').all();
    const update = db.prepare(`
      UPDATE ncf_sequences SET type=?,prefix=?,from_num=?,to_num=?,current=? WHERE id=?
    `);
    const issuedStatement = _tableExists(db, 'sales')
      ? db.prepare("SELECT ncf FROM sales WHERE ncf LIKE ? AND length(TRIM(ncf))=11")
      : null;

    rows.forEach(row => {
      let type;
      try { type = normalizeLegacyType(row.type); } catch { return; } // e-NCF u otro esquema: no tocar.
      let from;
      let to;
      let current;
      try {
        from = normalizeLegacySequenceNumber(type, row.from_num);
        to = normalizeLegacySequenceNumber(type, row.to_num);
        current = normalizeLegacySequenceNumber(type, row.current, { allowZero: true });
      } catch { return; }
      if (from > to) return;

      if (issuedStatement) {
        const maxIssued = issuedStatement.all(`${type}%`)
          .map(item => parseCanonicalLegacyNcf(item.ncf))
          .filter(Boolean)
          .map(item => item.sequence)
          .filter(sequence => sequence >= from && sequence <= to)
          .reduce((max, sequence) => Math.max(max, sequence), 0);
        current = Math.max(current, maxIssued, from - 1);
      }
      current = Math.min(current, to);
      const before = JSON.stringify({ type: row.type, prefix: row.prefix, from: row.from_num, to: row.to_num, current: row.current });
      const after = JSON.stringify({ type, prefix: type, from, to, current });
      if (before === after) return;
      audit.run('ncf_sequences', row.id, 'range', before, after);
      update.run(type, type, from, to, current, row.id);
      result.sequences++;
    });
  }
  return result;
}

module.exports = {
  LEGACY_NCF_TYPES,
  MAX_LEGACY_SEQUENCE,
  normalizeLegacyType,
  normalizeLegacySequenceNumber,
  normalizeLegacySequenceRange,
  formatLegacyNcf,
  canonicalizeLegacyNcf,
  parseCanonicalLegacyNcf,
  repairLegacyNcfData,
};
