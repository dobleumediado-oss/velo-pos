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
  // Un documento ya emitido no se "corrige" recortando dígitos. Hacerlo
  // convertiría un NCF inválido (p. ej. B01100000855) en otro NCF válido y
  // diferente (B0100000855). Solo se normalizan separadores/case; el documento
  // debe contener exactamente tipo + ocho dígitos.
  const match = raw.match(/^(B\d{2})(\d{8})$/);
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

// Reconoce exclusivamente la contaminación mecánica producida por versiones
// antiguas de VELO: el contador guardó delante de sus ocho dígitos el número del
// tipo (B01 -> "1", B02 -> "2", B14 -> "14", etc.). No recorta libremente
// ningún documento: si el exceso no coincide exactamente con su tipo, el valor
// queda como evidencia no recuperable y requiere revisión manual.
function parseRecoverableDuplicatedTypeNcf(value) {
  const raw = _digits(value);
  const head = raw.match(/^(B(?:01|02|04|14|15|16|17))(\d+)$/);
  if (!head || head[2].length <= 8) return null;
  const type = head[1];
  const suffix = head[2];
  const correlation = suffix.slice(-8);
  const contamination = suffix.slice(0, -8);
  const typeDigits = type.slice(1);
  const numericType = typeDigits.replace(/^0+/, '') || '0';
  if (contamination !== typeDigits && contamination !== numericType) return null;
  const sequence = Number.parseInt(correlation, 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_LEGACY_SEQUENCE) return null;
  return {
    type,
    sequence,
    malformedNcf: raw,
    canonicalNcf: formatLegacyNcf(type, sequence),
    contamination,
  };
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

// v1.36.0 llegó a convertir algunos NCF mal formados de 12 caracteres en un
// NCF distinto de 11 caracteres. Esta recuperación conserva el valor realmente
// emitido como evidencia (aunque sea inválido), y vuelve a calcular el último
// correlativo desde los documentos válidos. Nunca baja por debajo de un NCF
// válido emitido después de la actualización.
function recoverMalformedNcfEvidence(db) {
  const result = { sales: 0, log: 0, references: 0, sequences: 0, conflicts: [] };
  if (!_tableExists(db, 'ncf_normalization_log')) return result;

  const allowed = new Map([
    ['sales:ncf', 'sales'],
    ['ncf_log:ncf', 'log'],
    ['ncf_log:modifies_ncf', 'references'],
  ]);
  const affectedTypes = new Set();
  const rows = db.prepare(`
    SELECT * FROM ncf_normalization_log
    WHERE reason LIKE 'Normalización NCF serie B:%'
      AND source_table IN ('sales','ncf_log')
      AND field_name IN ('ncf','modifies_ncf')
    ORDER BY id
  `).all();
  const reversalAudit = db.prepare(`
    INSERT OR IGNORE INTO ncf_normalization_log
      (source_table,source_id,field_name,old_value,new_value,reason)
    VALUES(?,?,?,?,?,'Restauración de evidencia NCF: no reasignar documentos emitidos')
  `);

  rows.forEach(row => {
    const key = `${row.source_table}:${row.field_name}`;
    const counter = allowed.get(key);
    if (!counter) return;
    const oldValue = String(row.old_value || '').trim().toUpperCase();
    const newValue = String(row.new_value || '').trim().toUpperCase();
    // Solo revierte la contaminación que produjo un documento de más de 11
    // caracteres. Correcciones de espacios/case legítimas no se deshacen.
    if (!/^B(?:01|02|04|14|15|16|17)\d{9,}$/.test(oldValue) || oldValue.length <= 11) return;
    const current = db.prepare(`SELECT ${row.field_name} value FROM ${row.source_table} WHERE id=?`).get(row.source_id);
    if (!current || String(current.value || '').trim().toUpperCase() !== newValue) return;
    const collision = db.prepare(`SELECT id FROM ${row.source_table} WHERE ${row.field_name}=? AND id<>? LIMIT 1`)
      .get(oldValue, row.source_id);
    if (collision && row.field_name === 'ncf') {
      result.conflicts.push({ table: row.source_table, id: row.source_id, oldValue, collisionId: collision.id });
      return;
    }
    db.prepare(`UPDATE ${row.source_table} SET ${row.field_name}=? WHERE id=?`).run(oldValue, row.source_id);
    reversalAudit.run(row.source_table, row.source_id, row.field_name, newValue, oldValue);
    result[counter]++;
    affectedTypes.add(oldValue.slice(0, 3));
  });

  // Instalaciones que aún no ejecutaron la normalización también pueden tener
  // documentos contaminados. Marcar su tipo permite reparar la secuencia en la
  // misma actualización sin reescribir el documento.
  for (const [table, field] of [['sales', 'ncf'], ['ncf_log', 'ncf']]) {
    if (!_columnExists(db, table, field)) continue;
    db.prepare(`SELECT ${field} value FROM ${table} WHERE length(TRIM(COALESCE(${field},'')))>11`).all()
      .forEach(item => {
        const type = String(item.value || '').trim().toUpperCase().slice(0, 3);
        if (LEGACY_NCF_TYPES.has(type)) affectedTypes.add(type);
      });
  }

  if (!_tableExists(db, 'ncf_sequences')) return result;
  const readIssued = type => {
    const values = [];
    if (_columnExists(db, 'sales', 'ncf')) {
      values.push(...db.prepare("SELECT ncf FROM sales WHERE length(TRIM(COALESCE(ncf,'')))=11 AND UPPER(substr(TRIM(ncf),1,3))=?")
        .all(type).map(row => row.ncf));
    }
    if (_columnExists(db, 'ncf_log', 'ncf')) {
      values.push(...db.prepare("SELECT ncf FROM ncf_log WHERE length(TRIM(COALESCE(ncf,'')))=11 AND UPPER(substr(TRIM(ncf),1,3))=?")
        .all(type).map(row => row.ncf));
    }
    return values.map(parseCanonicalLegacyNcf).filter(Boolean).map(item => item.sequence);
  };
  const sequenceAudit = db.prepare(`
    INSERT OR IGNORE INTO ncf_normalization_log
      (source_table,source_id,field_name,old_value,new_value,reason)
    VALUES('ncf_sequences',?,'current',?,?,
      'Recuperación de secuencia desde NCF válidos; excluye evidencia mal formada')
  `);

  affectedTypes.forEach(type => {
    const issued = readIssued(type);
    const sequences = db.prepare('SELECT * FROM ncf_sequences WHERE type=? ORDER BY id').all(type);
    sequences.forEach(sequence => {
      const validInRange = issued.filter(value => value >= sequence.from_num && value <= sequence.to_num);
      const lastValid = validInRange.length ? Math.max(...validInRange) : sequence.from_num - 1;
      if (lastValid === Number(sequence.current)) return;
      sequenceAudit.run(sequence.id, String(sequence.current), String(lastValid));
      db.prepare('UPDATE ncf_sequences SET current=? WHERE id=?').run(lastValid, sequence.id);
      result.sequences++;
    });
  });
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
  parseRecoverableDuplicatedTypeNcf,
  repairLegacyNcfData,
  recoverMalformedNcfEvidence,
};
