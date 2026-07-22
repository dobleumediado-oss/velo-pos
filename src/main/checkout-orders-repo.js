// Ordenes de cobro compartidas entre despacho y caja.
// Una orden NO es una venta: no emite NCF, no mueve dinero y no descuenta stock.
// Solo reserva disponibilidad hasta que caja la convierte atomicamente en venta.

const { round2 } = require('../../lib/money');

function ensureCheckoutOrdersSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkout_orders (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      number              TEXT UNIQUE,
      status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','paid','dispatched','cancelled','expired')),
      customer_id         INTEGER REFERENCES customers(id),
      customer_name       TEXT NOT NULL DEFAULT 'Consumidor Final',
      customer_rnc        TEXT DEFAULT '',
      price_mode          TEXT NOT NULL DEFAULT 'retail'
                            CHECK(price_mode IN ('retail','wholesale')),
      discount_pct        REAL NOT NULL DEFAULT 0,
      discount_amt        REAL NOT NULL DEFAULT 0,
      subtotal            REAL NOT NULL DEFAULT 0,
      tax_amt             REAL NOT NULL DEFAULT 0,
      total               REAL NOT NULL DEFAULT 0,
      salesperson_id      INTEGER REFERENCES salespeople(id),
      price_approved_by   INTEGER REFERENCES users(id),
      created_by          INTEGER NOT NULL REFERENCES users(id),
      created_by_name     TEXT NOT NULL DEFAULT '',
      origin_terminal_id  TEXT DEFAULT '',
      paid_by             INTEGER REFERENCES users(id),
      paid_by_name        TEXT DEFAULT '',
      paid_terminal_id    TEXT DEFAULT '',
      cash_session_id     INTEGER REFERENCES cash_sessions(id),
      sale_id             INTEGER REFERENCES sales(id),
      notes               TEXT DEFAULT '',
      cancel_reason       TEXT DEFAULT '',
      expires_at          TEXT NOT NULL,
      created_at          TEXT DEFAULT (datetime('now','localtime')),
      updated_at          TEXT DEFAULT (datetime('now','localtime')),
      paid_at             TEXT,
      dispatched_at       TEXT,
      cancelled_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS checkout_order_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    INTEGER NOT NULL REFERENCES checkout_orders(id) ON DELETE CASCADE,
      product_id  INTEGER NOT NULL REFERENCES products(id),
      product_code TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      unit_cost   REAL NOT NULL DEFAULT 0,
      unit_price  REAL NOT NULL DEFAULT 0,
      qty         INTEGER NOT NULL CHECK(qty > 0),
      taxable     INTEGER NOT NULL DEFAULT 1,
      tax_pct     REAL NOT NULL DEFAULT 18,
      line_total  REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_checkout_orders_status_expiry
      ON checkout_orders(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_checkout_orders_sale
      ON checkout_orders(sale_id);
    CREATE INDEX IF NOT EXISTS idx_checkout_items_order
      ON checkout_order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_checkout_items_product
      ON checkout_order_items(product_id);
  `);

  // Se ejecuta en cada arranque con INSERT OR IGNORE. Así también reciben el
  // control modular las instalaciones de desarrollo que ya habían registrado
  // la migración 1.24.2 antes de incorporarse estos ajustes.
  const insertSetting = db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING'
  );
  insertSetting.run('checkout_reservation_minutes', '30');
  insertSetting.run('checkout_notifications_sound', '1');
  insertSetting.run('module_preventa', '1');
  insertSetting.run('module_preventa_roles', 'admin,cajero');
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Number.parseFloat(value) || 0));
}

function taxTotals(items, discountPct) {
  const pct = clampPct(discountPct);
  const factor = 1 - (pct / 100);
  const gross = round2(items.reduce((sum, item) =>
    sum + (Number(item.unit_price) || 0) * (Number(item.qty) || 0), 0));
  const discountAmt = round2(gross * pct / 100);
  const total = round2(gross - discountAmt);
  let tax = 0;
  for (const item of items) {
    if (!item.taxable || !(Number(item.tax_pct) > 0)) continue;
    const afterDiscount = (Number(item.unit_price) || 0) * (Number(item.qty) || 0) * factor;
    tax += afterDiscount - (afterDiscount / (1 + Number(item.tax_pct) / 100));
  }
  const taxAmt = round2(tax);
  return { subtotal: round2(total - taxAmt), discountAmt, taxAmt, total, discountPct: pct };
}

function createCheckoutOrdersRepo({ getDb, salesRepo, audit }) {
  const db = () => getDb();

  function expireStale() {
    return db().prepare(`
      UPDATE checkout_orders
      SET status='expired', updated_at=datetime('now','localtime')
      WHERE status='pending' AND expires_at <= datetime('now','localtime')
    `).run().changes;
  }

  function getById(id) {
    expireStale();
    const order = db().prepare(`
      SELECT o.*, s.name AS salesperson_name
      FROM checkout_orders o
      LEFT JOIN salespeople s ON s.id=o.salesperson_id
      WHERE o.id=?
    `).get(id);
    if (!order) return null;
    order.items = db().prepare(
      'SELECT * FROM checkout_order_items WHERE order_id=? ORDER BY id'
    ).all(id);
    return order;
  }

  function list({ statuses = ['pending','paid'], limit = 100 } = {}) {
    expireStale();
    const allowed = ['pending','paid','dispatched','cancelled','expired'];
    const safe = (Array.isArray(statuses) ? statuses : [statuses]).filter(s => allowed.includes(s));
    const picked = safe.length ? safe : ['pending','paid'];
    const placeholders = picked.map(() => '?').join(',');
    const rows = db().prepare(`
      SELECT o.*,
        (SELECT COUNT(*) FROM checkout_order_items i WHERE i.order_id=o.id) AS item_count,
        (SELECT GROUP_CONCAT(i.product_name || ' x' || i.qty, ', ')
           FROM checkout_order_items i WHERE i.order_id=o.id) AS items_summary
      FROM checkout_orders o
      WHERE o.status IN (${placeholders})
      ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
               CASE WHEN o.status IN ('pending','paid') THEN o.created_at END ASC,
               CASE WHEN o.status NOT IN ('pending','paid') THEN o.updated_at END DESC,
               CASE WHEN o.status IN ('pending','paid') THEN o.id END ASC,
               CASE WHEN o.status NOT IN ('pending','paid') THEN o.id END DESC
      LIMIT ?
    `).all(...picked, Math.max(1, Math.min(500, Number(limit) || 100)));
    return rows;
  }

  function create(data) {
    return db().transaction(() => {
      expireStale();
      const rawItems = Array.isArray(data.items) ? data.items : [];
      if (!rawItems.length) throw new Error('La orden debe tener al menos un producto');

      const items = rawItems.map(raw => {
        const productId = Number(raw.product_id);
        const product = db().prepare(
          'SELECT id,code,name,cost,stock,taxable,tax_pct,active FROM products WHERE id=?'
        ).get(productId);
        if (!product || product.active === 0) throw new Error('Uno de los productos ya no esta disponible');
        const qty = Math.floor(Number(raw.qty) || 0);
        const unitPrice = round2(Number(raw.unit_price));
        if (qty <= 0 || qty > 99999) throw new Error(`Cantidad invalida para "${product.name}"`);
        if (!(unitPrice > 0) || unitPrice > 99999999) throw new Error(`Precio invalido para "${product.name}"`);

        const reserved = db().prepare(`
          SELECT COALESCE(SUM(i.qty),0) AS qty
          FROM checkout_order_items i
          JOIN checkout_orders o ON o.id=i.order_id
          WHERE i.product_id=? AND o.status='pending'
            AND o.expires_at > datetime('now','localtime')
        `).get(productId).qty || 0;
        const available = Number(product.stock) - Number(reserved);
        if (available < qty) {
          throw new Error(`Disponible insuficiente para "${product.name}": ${available} libre(s)`);
        }
        return {
          product_id: product.id,
          product_code: raw.product_code || product.code || '',
          product_name: raw.product_name || product.name,
          unit_cost: round2(Number(product.cost) || 0),
          unit_price: unitPrice,
          qty,
          taxable: raw.taxable === 0 ? 0 : (product.taxable === 0 ? 0 : 1),
          tax_pct: Math.max(0, Math.min(100, Number(raw.tax_pct ?? product.tax_pct) || 0)),
          line_total: round2(unitPrice * qty),
        };
      });

      const totals = taxTotals(items, data.discountPct);
      const minutes = Math.max(5, Math.min(480, Number(data.reservationMinutes) || 30));
      const customerId = Number(data.customer?.id) || 1;
      const customer = db().prepare('SELECT id,name,rnc FROM customers WHERE id=? AND active=1').get(customerId);
      if (!customer) throw new Error('Cliente no encontrado o inactivo');

      const orderR = db().prepare(`
        INSERT INTO checkout_orders(
          status,customer_id,customer_name,customer_rnc,price_mode,
          discount_pct,discount_amt,subtotal,tax_amt,total,salesperson_id,
          price_approved_by,created_by,created_by_name,origin_terminal_id,notes,expires_at
        ) VALUES(
          'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime',?)
        )
      `).run(
        customer.id,
        String(data.customer?.name || customer.name || 'Consumidor Final').slice(0, 160),
        String(data.customer?.rnc || customer.rnc || '').slice(0, 32),
        data.priceMode === 'wholesale' ? 'wholesale' : 'retail',
        totals.discountPct, totals.discountAmt, totals.subtotal, totals.taxAmt, totals.total,
        Number(data.salespersonId) || null,
        Number(data.priceApprovedBy) || null,
        Number(data.createdBy), String(data.createdByName || '').slice(0, 120),
        String(data.terminalId || '').slice(0, 100), String(data.notes || '').slice(0, 500),
        `+${minutes} minutes`
      );
      const id = Number(orderR.lastInsertRowid);
      const number = `OC-${String(id).padStart(6, '0')}`;
      db().prepare('UPDATE checkout_orders SET number=? WHERE id=?').run(number, id);

      const insertItem = db().prepare(`
        INSERT INTO checkout_order_items(
          order_id,product_id,product_code,product_name,unit_cost,unit_price,
          qty,taxable,tax_pct,line_total
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
      `);
      items.forEach(item => insertItem.run(
        id, item.product_id, item.product_code, item.product_name, item.unit_cost,
        item.unit_price, item.qty, item.taxable, item.tax_pct, item.line_total
      ));
      audit(data.createdBy, data.createdByName, 'orden_cobro_creada', 'checkout_orders', id,
        `${number} | Total: ${totals.total} | Reserva: ${minutes} min | Items: ${items.length}`);
      return getById(id);
    })();
  }

  function cancel({ id, reason, user }) {
    return db().transaction(() => {
      const order = db().prepare('SELECT * FROM checkout_orders WHERE id=?').get(id);
      if (!order) throw new Error('Orden no encontrada');
      if (order.status !== 'pending') throw new Error('Solo se pueden cancelar ordenes pendientes');
      const cleanReason = String(reason || '').trim();
      if (!cleanReason) throw new Error('Indica el motivo de cancelacion');
      db().prepare(`
        UPDATE checkout_orders SET status='cancelled',cancel_reason=?,cancelled_at=datetime('now','localtime'),
          updated_at=datetime('now','localtime') WHERE id=? AND status='pending'
      `).run(cleanReason.slice(0, 300), id);
      audit(user.id, user.name, 'orden_cobro_cancelada', 'checkout_orders', id,
        `${order.number} | ${cleanReason}`);
      return getById(id);
    })();
  }

  function markDispatched({ id, user }) {
    return db().transaction(() => {
      const order = db().prepare('SELECT * FROM checkout_orders WHERE id=?').get(id);
      if (!order) throw new Error('Orden no encontrada');
      if (order.status !== 'paid') throw new Error('La orden debe estar pagada antes de despacharla');
      db().prepare(`
        UPDATE checkout_orders SET status='dispatched',dispatched_at=datetime('now','localtime'),
          updated_at=datetime('now','localtime') WHERE id=? AND status='paid'
      `).run(id);
      audit(user.id, user.name, 'orden_cobro_despachada', 'checkout_orders', id, order.number);
      return getById(id);
    })();
  }

  function pay({ id, payment, session, user, terminalId }) {
    return db().transaction(() => {
      expireStale();
      const order = db().prepare('SELECT * FROM checkout_orders WHERE id=?').get(id);
      if (!order) throw new Error('Orden no encontrada');
      if (order.status !== 'pending') {
        const labels = { paid: 'ya fue cobrada', dispatched: 'ya fue despachada', cancelled: 'fue cancelada', expired: 'vencio' };
        throw new Error(`La orden ${labels[order.status] || 'ya no esta pendiente'}`);
      }
      const items = db().prepare('SELECT * FROM checkout_order_items WHERE order_id=? ORDER BY id').all(id);
      const claimed = db().prepare(`
        UPDATE checkout_orders SET updated_at=datetime('now','localtime') WHERE id=? AND status='pending'
      `).run(id);
      if (claimed.changes !== 1) throw new Error('La orden esta siendo procesada en otra caja');

      const customer = {
        id: order.customer_id || 1,
        name: order.customer_name || 'Consumidor Final',
        rnc: order.customer_rnc || '',
      };
      const saleResult = salesRepo.create({
        session,
        customer,
        items,
        payment: {
          ...(payment || {}),
          disc: order.discount_pct || 0,
          priceMode: order.price_mode || 'retail',
          salespersonId: order.salesperson_id || null,
          checkoutOrderId: order.id,
          priceChangeApprovedBy: order.price_approved_by || null,
        },
        user,
        type: 'factura',
      });
      db().prepare(`
        UPDATE checkout_orders SET status='paid',sale_id=?,cash_session_id=?,paid_by=?,paid_by_name=?,
          paid_terminal_id=?,paid_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
        WHERE id=? AND status='pending'
      `).run(
        saleResult.saleId, session?.id || null, user.id, user.name || '',
        String(terminalId || '').slice(0, 100), id
      );
      audit(user.id, user.name, 'orden_cobro_pagada', 'checkout_orders', id,
        `${order.number} -> Venta #${saleResult.saleId} | Total: ${saleResult.total}`);
      return { ...saleResult, order: getById(id) };
    })();
  }

  return { expireStale, getById, list, create, cancel, markDispatched, pay };
}

module.exports = { ensureCheckoutOrdersSchema, createCheckoutOrdersRepo };
