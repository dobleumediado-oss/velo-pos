'use strict';

// Registro de custodia física. Deliberadamente separado de products, ventas,
// caja y contabilidad mientras no esté definido el tratamiento fiscal.
const MAX_QTY = 100000000;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignment_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_name TEXT NOT NULL,
      owner_phone TEXT NOT NULL DEFAULT '',
      item_name TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS consignment_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id INTEGER NOT NULL REFERENCES consignment_lots(id),
      kind TEXT NOT NULL CHECK(kind IN ('entrada','devolucion')),
      qty INTEGER NOT NULL CHECK(qty > 0),
      reason TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_movements_lot ON consignment_movements(lot_id,id);
    CREATE INDEX IF NOT EXISTS idx_consignment_lots_owner ON consignment_lots(owner_name);
  `);
}

function requiredText(value, label, max = 160) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} es obligatorio`);
  if (text.length > max) throw new Error(`${label} supera ${max} caracteres`);
  return text;
}

function optionalText(value, label, max = 500) {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new Error(`${label} supera ${max} caracteres`);
  return text;
}

function quantity(value) {
  if (value === '' || value === null || value === undefined) throw new Error('Ingresa una cantidad');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_QTY) throw new Error('La cantidad debe ser un entero positivo');
  return n;
}

function list(db) {
  return db.prepare(`
    SELECT l.*,COALESCE(SUM(CASE WHEN m.kind='entrada' THEN m.qty ELSE 0 END),0) AS received,
      COALESCE(SUM(CASE WHEN m.kind='devolucion' THEN m.qty ELSE 0 END),0) AS returned,
      COALESCE(SUM(CASE WHEN m.kind='entrada' THEN m.qty ELSE -m.qty END),0) AS on_hand
    FROM consignment_lots l LEFT JOIN consignment_movements m ON m.lot_id=l.id
    GROUP BY l.id ORDER BY l.id DESC
  `).all();
}

function movements(db, lotId) {
  return db.prepare('SELECT * FROM consignment_movements WHERE lot_id=? ORDER BY id DESC').all(lotId);
}

function create(db, input, userId) {
  const ownerName = requiredText(input.ownerName, 'Nombre del dueño');
  const itemName = requiredText(input.itemName, 'Nombre del artículo');
  const ownerPhone = optionalText(input.ownerPhone, 'Teléfono', 50);
  const reference = optionalText(input.reference, 'Referencia', 100);
  const location = optionalText(input.location, 'Ubicación', 100);
  const notes = optionalText(input.notes, 'Notas');
  const qty = quantity(input.qty);
  return db.transaction(() => {
    const id = db.prepare(`INSERT INTO consignment_lots
      (owner_name,owner_phone,item_name,reference,location,notes,created_by)
      VALUES(?,?,?,?,?,?,?)`).run(ownerName, ownerPhone, itemName, reference, location, notes, userId).lastInsertRowid;
    db.prepare(`INSERT INTO consignment_movements(lot_id,kind,qty,reason,created_by)
      VALUES(?,'entrada',?,'Recepción inicial',?)`).run(id, qty, userId);
    return id;
  })();
}

function move(db, input, userId) {
  const lotId = Number(input.lotId);
  if (!Number.isSafeInteger(lotId) || lotId < 1) throw new Error('Registro no válido');
  const kind = String(input.kind || '');
  if (kind !== 'entrada' && kind !== 'devolucion') throw new Error('Movimiento no válido');
  const qty = quantity(input.qty);
  const reason = requiredText(input.reason, 'Motivo', 500);
  return db.transaction(() => {
    const lot = db.prepare(`SELECT l.id,
      COALESCE(SUM(CASE WHEN m.kind='entrada' THEN m.qty ELSE -m.qty END),0) AS on_hand
      FROM consignment_lots l LEFT JOIN consignment_movements m ON m.lot_id=l.id
      WHERE l.id=? GROUP BY l.id`).get(lotId);
    if (!lot) throw new Error('Registro no encontrado');
    if (kind === 'devolucion' && qty > lot.on_hand) throw new Error('No puedes devolver más unidades de las disponibles');
    const id = db.prepare('INSERT INTO consignment_movements(lot_id,kind,qty,reason,created_by) VALUES(?,?,?,?,?)')
      .run(lotId, kind, qty, reason, userId).lastInsertRowid;
    return { id, onHand: lot.on_hand + (kind === 'entrada' ? qty : -qty) };
  })();
}

module.exports = { ensureSchema, list, movements, create, move };
