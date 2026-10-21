'use strict';

// Conteos físicos: el borrador nunca modifica productos ni equipos. Solo aplicar
// un conteo confirmado cambia existencias/costos dentro de una transacción.

const MAX_COST = 1000000000;
const MAX_QTY = 100000000;

function ensureInventoryCountSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'borrador' CHECK(status IN ('borrador','aplicado','cancelado')),
      catalog_snapshot TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      applied_at TEXT,
      reason TEXT NOT NULL DEFAULT '',
      accounting_entry_id INTEGER REFERENCES accounting_entries(id)
    );
    CREATE TABLE IF NOT EXISTS inventory_count_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL REFERENCES inventory_counts(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      unit_id INTEGER REFERENCES product_units(id),
      kind TEXT NOT NULL DEFAULT 'product' CHECK(kind IN ('product','unit','empty_serial')),
      snapshot_qty INTEGER NOT NULL DEFAULT 0,
      snapshot_cost REAL NOT NULL DEFAULT 0,
      snapshot_missing INTEGER NOT NULL DEFAULT 0,
      counted_qty INTEGER NOT NULL DEFAULT 0,
      counted_cost REAL NOT NULL DEFAULT 0,
      present INTEGER NOT NULL DEFAULT 1,
      confirmed INTEGER NOT NULL DEFAULT 0,
      confirmed_by INTEGER REFERENCES users(id),
      confirmed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_count_product
      ON inventory_count_lines(count_id,product_id) WHERE unit_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_count_unit
      ON inventory_count_lines(count_id,unit_id) WHERE unit_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_count ON inventory_count_lines(count_id);
    CREATE TABLE IF NOT EXISTS inventory_unit_missing (
      unit_id INTEGER PRIMARY KEY REFERENCES product_units(id),
      active INTEGER NOT NULL DEFAULT 1,
      reported_by INTEGER REFERENCES users(id),
      reported_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      resolved_at TEXT,
      reason TEXT NOT NULL DEFAULT ''
    );
  `);
}

function money(value, label = 'Costo') {
  if (value === '' || value === null || value === undefined) throw new Error(`${label} requerido`);
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_COST ||
    Math.abs(Math.round(amount * 100) - amount * 100) > 0.000001) {
    throw new Error(`${label} no válido; usa hasta dos decimales`);
  }
  return Math.round(amount * 100) / 100;
}

function quantity(value) {
  if (value === '' || value === null || value === undefined) throw new Error('Ingresa la cantidad contada');
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_QTY) {
    throw new Error('La cantidad debe ser un entero no negativo');
  }
  return amount;
}

function round2(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }

function getDraft(db) {
  const session = db.prepare("SELECT * FROM inventory_counts WHERE status='borrador' ORDER BY id DESC LIMIT 1").get();
  if (!session) return null;
  return getCount(db, session.id);
}

function getCount(db, id) {
  const session = db.prepare('SELECT * FROM inventory_counts WHERE id=?').get(id);
  if (!session) throw new Error('Conteo no encontrado');
  const lines = db.prepare(`
    SELECT l.*,p.code AS product_code,p.name AS product_name,p.unit AS product_unit,
           p.serialized,pu.imei,pu.serial
    FROM inventory_count_lines l
    JOIN products p ON p.id=l.product_id
    LEFT JOIN product_units pu ON pu.id=l.unit_id
    WHERE l.count_id=?
    ORDER BY p.name COLLATE NOCASE,p.id,l.unit_id
  `).all(id);
  return { session, lines };
}

function startCount(db, userId) {
  ensureInventoryCountSchema(db);
  const existing = getDraft(db);
  if (existing) return existing;
  return db.transaction(() => {
    const products = db.prepare('SELECT id,COALESCE(serialized,0) AS serialized,stock,cost FROM products WHERE active=1 ORDER BY id').all();
    if (!products.length) throw new Error('No hay productos activos para contar');
    const catalog = products.map(p => [p.id, p.serialized]);
    const id = db.prepare('INSERT INTO inventory_counts(catalog_snapshot,created_by) VALUES(?,?)')
      .run(JSON.stringify(catalog), userId).lastInsertRowid;
    const insert = db.prepare(`INSERT INTO inventory_count_lines
      (count_id,product_id,unit_id,kind,snapshot_qty,snapshot_cost,snapshot_missing,counted_qty,counted_cost,present)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const units = db.prepare(`SELECT pu.id,pu.unit_cost,COALESCE(m.active,0) AS missing
      FROM product_units pu LEFT JOIN inventory_unit_missing m ON m.unit_id=pu.id
      WHERE pu.product_id=? AND pu.status='en_stock' ORDER BY pu.id`);
    for (const product of products) {
      if (product.serialized) {
        const productUnits = units.all(product.id);
        if (!productUnits.length) insert.run(id, product.id, null, 'empty_serial', 0, 0, 0, 0, 0, 1);
        for (const unit of productUnits) {
          const missing = Number(unit.missing) === 1 ? 1 : 0;
          insert.run(id, product.id, unit.id, 'unit', 1, money(unit.unit_cost || 0), missing,
            1, money(unit.unit_cost || 0), missing ? 0 : 1);
        }
      } else {
        insert.run(id, product.id, null, 'product', quantity(product.stock), money(product.cost), 0,
          quantity(product.stock), money(product.cost), 1);
      }
    }
    return getCount(db, id);
  })();
}

function confirmLine(db, { countId, lineId, qty, cost, present, userId }) {
  return db.transaction(() => {
    const session = db.prepare('SELECT status FROM inventory_counts WHERE id=?').get(countId);
    if (session?.status !== 'borrador') throw new Error('Este conteo ya no está en borrador');
    const line = db.prepare('SELECT * FROM inventory_count_lines WHERE id=? AND count_id=?').get(lineId, countId);
    if (!line) throw new Error('Línea del conteo no encontrada');
    const countedQty = line.kind === 'empty_serial' ? 0 : line.unit_id ? 1 : quantity(qty);
    const countedCost = line.kind === 'empty_serial' ? 0 : money(cost);
    const isPresent = line.unit_id ? (present === true || present === 1 ? 1 : 0) : 1;
    // Una unidad faltante conserva su costo histórico; no pertenece al valor
    // disponible hasta que se marque como encontrada en otro conteo.
    if (line.unit_id && !isPresent && countedCost !== money(line.snapshot_cost)) {
      throw new Error('No cambies el costo de un equipo marcado como faltante');
    }
    db.prepare(`UPDATE inventory_count_lines SET counted_qty=?,counted_cost=?,present=?,confirmed=1,
      confirmed_by=?,confirmed_at=datetime('now','localtime') WHERE id=?`)
      .run(countedQty, countedCost, isPresent, userId, lineId);
    db.prepare("UPDATE inventory_counts SET updated_at=datetime('now','localtime') WHERE id=?").run(countId);
    return db.prepare('SELECT * FROM inventory_count_lines WHERE id=?').get(lineId);
  })();
}

function cancelCount(db, countId) {
  const result = db.prepare("UPDATE inventory_counts SET status='cancelado',updated_at=datetime('now','localtime') WHERE id=? AND status='borrador'").run(countId);
  if (!result.changes) throw new Error('No hay un conteo pendiente para descartar');
  return { id: countId };
}

// Relee únicamente las filas que cambiaron por ventas, compras u otra terminal.
// Las demás confirmaciones siguen intactas; una fila rebasada vuelve a pendiente.
function refreshCount(db, countId) {
  return db.transaction(() => {
    const session = db.prepare('SELECT * FROM inventory_counts WHERE id=?').get(countId);
    if (session?.status !== 'borrador') throw new Error('Este conteo ya no está en borrador');
    const products = db.prepare('SELECT id,COALESCE(serialized,0) AS serialized,stock,cost FROM products WHERE active=1 ORDER BY id').all();
    const oldLines = db.prepare('SELECT * FROM inventory_count_lines WHERE count_id=?').all(countId);
    const expected = new Set();
    const oldByKey = new Map(oldLines.map(line => [line.unit_id ? `u:${line.unit_id}` : `p:${line.product_id}`, line]));
    const insert = db.prepare(`INSERT INTO inventory_count_lines
      (count_id,product_id,unit_id,kind,snapshot_qty,snapshot_cost,snapshot_missing,counted_qty,counted_cost,present)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const units = db.prepare(`SELECT pu.id,pu.unit_cost,COALESCE(m.active,0) AS missing
      FROM product_units pu LEFT JOIN inventory_unit_missing m ON m.unit_id=pu.id
      WHERE pu.product_id=? AND pu.status='en_stock' ORDER BY pu.id`);
    let refreshed = 0;
    const sync = (key, productId, unitId, kind, qty, cost, missing) => {
      expected.add(key);
      const old = oldByKey.get(key);
      if (!old) {
        insert.run(countId, productId, unitId, kind, qty, cost, missing, qty, cost, missing ? 0 : 1);
        refreshed++;
      } else if (old.product_id !== productId || old.kind !== kind || old.snapshot_qty !== qty ||
        money(old.snapshot_cost) !== cost || Number(old.snapshot_missing) !== missing) {
        db.prepare(`UPDATE inventory_count_lines SET product_id=?,kind=?,snapshot_qty=?,snapshot_cost=?,
          snapshot_missing=?,counted_qty=?,counted_cost=?,present=?,confirmed=0,
          confirmed_by=NULL,confirmed_at=NULL WHERE id=?`)
          .run(productId, kind, qty, cost, missing, qty, cost, missing ? 0 : 1, old.id);
        refreshed++;
      }
    };
    for (const product of products) {
      if (product.serialized) {
        const productUnits = units.all(product.id);
        if (!productUnits.length) sync(`p:${product.id}`, product.id, null, 'empty_serial', 0, 0, 0);
        for (const unit of productUnits) {
          const missing = Number(unit.missing) ? 1 : 0;
          sync(`u:${unit.id}`, product.id, unit.id, 'unit', 1, money(unit.unit_cost || 0), missing);
        }
      } else {
        sync(`p:${product.id}`, product.id, null, 'product', quantity(product.stock), money(product.cost), 0);
      }
    }
    for (const old of oldLines) {
      const key = old.unit_id ? `u:${old.unit_id}` : `p:${old.product_id}`;
      if (!expected.has(key)) {
        db.prepare('DELETE FROM inventory_count_lines WHERE id=?').run(old.id);
        refreshed++;
      }
    }
    db.prepare("UPDATE inventory_counts SET catalog_snapshot=?,updated_at=datetime('now','localtime') WHERE id=?")
      .run(JSON.stringify(products.map(p => [p.id, p.serialized])), countId);
    return { ...getCount(db, countId), refreshed };
  })();
}

function validateCurrentState(db, session, lines) {
  const expected = JSON.parse(session.catalog_snapshot);
  const current = db.prepare('SELECT id,COALESCE(serialized,0) AS serialized FROM products WHERE active=1 ORDER BY id').all()
    .map(p => [p.id, p.serialized]);
  if (JSON.stringify(expected) !== JSON.stringify(current)) {
    throw new Error('El catálogo cambió durante el conteo. Pulsa «Actualizar cambios externos» y confirma las filas nuevas');
  }
  const product = db.prepare('SELECT stock,cost,active,serialized,name FROM products WHERE id=?');
  const unit = db.prepare(`SELECT pu.status,pu.unit_cost,COALESCE(m.active,0) AS missing
    FROM product_units pu LEFT JOIN inventory_unit_missing m ON m.unit_id=pu.id WHERE pu.id=? AND pu.product_id=?`);
  const serialCount = db.prepare("SELECT COUNT(*) n FROM product_units WHERE product_id=? AND status='en_stock'");
  const seenUnits = new Map();
  for (const line of lines) {
    const p = product.get(line.product_id);
    if (!p || p.active === 0) throw new Error(`El producto #${line.product_id} ya no está activo`);
    if (line.unit_id) {
      const u = unit.get(line.unit_id, line.product_id);
      if (!u || u.status !== 'en_stock' || money(u.unit_cost || 0) !== money(line.snapshot_cost)
        || Number(u.missing) !== Number(line.snapshot_missing)) {
        throw new Error(`El equipo de ${p.name} cambió durante el conteo; pulsa «Actualizar cambios externos» y revísalo`);
      }
      seenUnits.set(line.product_id, (seenUnits.get(line.product_id) || 0) + 1);
    } else if (line.kind === 'product' &&
      (quantity(p.stock) !== line.snapshot_qty || money(p.cost) !== money(line.snapshot_cost))) {
      throw new Error(`${p.name} cambió durante el conteo. Pulsa «Actualizar cambios externos» y revísalo`);
    }
  }
  for (const [id, serialized] of expected) {
    if (serialized && Number(serialCount.get(id).n) !== (seenUnits.get(id) || 0)) {
      throw new Error(`Cambió la lista de equipos del producto #${id}; pulsa «Actualizar cambios externos»`);
    }
  }
}

function applyCount(db, { countId, reason, userId, userName, audit, accountingRepo }) {
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3 || cleanReason.length > 500) throw new Error('Indica un motivo de 3 a 500 caracteres');
  return db.transaction(() => {
    const session = db.prepare('SELECT * FROM inventory_counts WHERE id=?').get(countId);
    if (session?.status !== 'borrador') throw new Error('Este conteo ya fue aplicado o descartado');
    const lines = db.prepare('SELECT * FROM inventory_count_lines WHERE count_id=? ORDER BY id').all(countId);
    if (!lines.length) throw new Error('No hay productos para aplicar');
    const pending = lines.filter(l => !l.confirmed);
    if (pending.length) throw new Error(`Faltan ${pending.length} producto(s) o equipo(s) por confirmar`);
    validateCurrentState(db, session, lines);

    let positive = 0, negative = 0, changed = 0;
    const historyIds = [];
    const movements = db.prepare(`INSERT INTO inventory_movements
      (product_id,type,qty,qty_before,qty_after,reason,user_id) VALUES(?,?,?,?,?,?,?)`);
    const availableUnits = db.prepare(`SELECT COUNT(*) n FROM product_units pu
      LEFT JOIN inventory_unit_missing m ON m.unit_id=pu.id
      WHERE pu.product_id=? AND pu.status='en_stock' AND COALESCE(m.active,0)=0`);
    const history = db.prepare(`INSERT INTO product_price_history
      (product_id,product_code,product_name,cost_before,cost_after,price_before,price_after,
       wholesale_before,wholesale_after,stock_at_change,cost_delta,price_delta,wholesale_delta,
       stock_value_delta,retail_value_delta,wholesale_value_delta,source,reason,user_id)
      SELECT id,code,name,?,?,price,price,wholesale,wholesale,?, ?,0,0,?,0,0,
             'conteo_fisico',?,? FROM products WHERE id=?`);
    for (const line of lines) {
      let beforeValue, afterValue;
      if (line.kind === 'empty_serial') {
        continue;
      } else if (line.unit_id) {
        const beforeAvailable = !line.snapshot_missing;
        const afterAvailable = !!line.present;
        beforeValue = beforeAvailable ? money(line.snapshot_cost) : 0;
        afterValue = afterAvailable ? money(line.counted_cost) : 0;
        if (line.snapshot_missing !== (afterAvailable ? 0 : 1)) {
          const beforeQty = availableUnits.get(line.product_id).n;
          db.prepare(`INSERT INTO inventory_unit_missing(unit_id,active,reported_by,reported_at,resolved_at,reason)
            VALUES(?,?,?,datetime('now','localtime'),?,?)
            ON CONFLICT(unit_id) DO UPDATE SET active=excluded.active,reported_by=excluded.reported_by,
              reported_at=excluded.reported_at,resolved_at=excluded.resolved_at,reason=excluded.reason`)
            .run(line.unit_id, afterAvailable ? 0 : 1, userId,
              afterAvailable ? new Date().toISOString() : null, cleanReason);
          const afterQty = availableUnits.get(line.product_id).n;
          movements.run(line.product_id, 'ajuste', afterQty - beforeQty, beforeQty, afterQty,
            `Conteo físico #${countId}; ${line.unit_id}; ${afterAvailable ? 'equipo encontrado' : 'equipo faltante'}: ${cleanReason}`, userId);
          changed++;
        }
        if (afterAvailable && money(line.counted_cost) !== money(line.snapshot_cost)) {
          db.prepare('UPDATE product_units SET unit_cost=? WHERE id=?').run(line.counted_cost, line.unit_id);
          changed++;
        }
      } else {
        const oldQty = quantity(line.snapshot_qty);
        const newQty = quantity(line.counted_qty);
        const oldCost = money(line.snapshot_cost);
        const newCost = money(line.counted_cost);
        beforeValue = round2(oldQty * oldCost);
        afterValue = round2(newQty * newCost);
        if (oldQty !== newQty) {
          db.prepare("UPDATE products SET stock=?,updated_at=datetime('now') WHERE id=?").run(newQty, line.product_id);
          movements.run(line.product_id, 'ajuste', newQty - oldQty, oldQty, newQty,
            `Conteo físico #${countId}: ${cleanReason}`, userId);
          changed++;
        }
        if (oldCost !== newCost) {
          db.prepare("UPDATE products SET cost=?,updated_at=datetime('now') WHERE id=?").run(newCost, line.product_id);
          const record = history.run(oldCost, newCost, newQty, round2(newCost - oldCost),
            round2((newCost - oldCost) * newQty), `Conteo físico #${countId}: ${cleanReason}`, userId, line.product_id);
          historyIds.push(Number(record.lastInsertRowid));
          changed++;
        }
      }
      const delta = round2(afterValue - beforeValue);
      if (delta > 0) positive = round2(positive + delta);
      if (delta < 0) negative = round2(negative - delta);
    }

    let accountingEntryId = null;
    const enabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value === '1';
    if (enabled && (positive >= 0.01 || negative >= 0.01)) {
      const config = accountingRepo.getConfig();
      const account = (key, code) => {
        const configured = Number(config[key]?.account_id) || 0;
        const row = configured
          ? db.prepare('SELECT id FROM accounting_accounts WHERE id=? AND active=1 AND is_summary=0').get(configured)
          : db.prepare('SELECT id FROM accounting_accounts WHERE code=? AND active=1 AND is_summary=0').get(code);
        return row?.id;
      };
      const inventoryId = account('account_inventory', '1105');
      const gainId = account('account_inventory_gain', '4104');
      const lossId = account('account_inventory_loss', '6120');
      if (!inventoryId || (positive && !gainId) || (negative && !lossId)) {
        throw new Error('Faltan cuentas contables para aplicar el conteo de inventario');
      }
      const entryLines = [];
      if (positive) entryLines.push(
        { account_id: inventoryId, debit: positive, credit: 0, description: 'Aumento de inventario por conteo físico' },
        { account_id: gainId, debit: 0, credit: positive, description: 'Ganancia por conteo físico' });
      if (negative) entryLines.push(
        { account_id: lossId, debit: negative, credit: 0, description: 'Pérdida por conteo físico' },
        { account_id: inventoryId, debit: 0, credit: negative, description: 'Disminución de inventario por conteo físico' });
      const entry = accountingRepo.createEntry({
        date: db.prepare("SELECT date('now','localtime') AS today").get().today,
        concept: `Conteo físico de inventario #${countId}`,
        reference: `CONTEO-${countId}`,
        source_module: 'inventario_conteo', source_id: countId,
        lines: entryLines, notes: cleanReason, userId, status: 'confirmado',
      });
      accountingEntryId = entry.entryId;
      for (const id of historyIds) {
        db.prepare('UPDATE product_price_history SET accounting_entry_id=? WHERE id=?').run(accountingEntryId, id);
      }
    }
    db.prepare(`UPDATE inventory_counts SET status='aplicado',reason=?,applied_at=datetime('now','localtime'),
      updated_at=datetime('now','localtime'),accounting_entry_id=? WHERE id=?`)
      .run(cleanReason, accountingEntryId, countId);
    audit(userId, userName, 'conteo_inventario_aplicado', 'inventory_counts', countId,
      `${changed} cambio(s); aumento RD$${positive.toFixed(2)}; disminución RD$${negative.toFixed(2)}; ${cleanReason}`);
    return { countId, changed, positive, negative, accountingEntryId };
  })();
}

module.exports = { ensureInventoryCountSchema, startCount, getDraft, getCount, confirmLine, refreshCount, cancelCount, applyCount };
