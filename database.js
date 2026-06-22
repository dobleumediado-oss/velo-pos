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
  migrateECFColumns();
  migrateExpensesColumns();
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
      barcode       TEXT DEFAULT '',
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
      condition     TEXT DEFAULT 'nuevo',
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


    -- ══════════════════════════════════════════════
    -- MÓDULO: GASTOS Y CUENTAS POR PAGAR
    -- ══════════════════════════════════════════════

    -- ── Categorías de gastos ──
    CREATE TABLE IF NOT EXISTS expense_categories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      parent_id     INTEGER REFERENCES expense_categories(id),
      affects_profit INTEGER DEFAULT 1,
      requires_approval INTEGER DEFAULT 0,
      approval_limit REAL DEFAULT 0,
      requires_attachment INTEGER DEFAULT 0,
      active        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    -- ── Gastos ──
    CREATE TABLE IF NOT EXISTS expenses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT NOT NULL DEFAULT 'gasto'
                        CHECK(type IN ('gasto','retiro','traslado','activo','reembolso','aporte')),
      category_id     INTEGER REFERENCES expense_categories(id),
      description     TEXT NOT NULL,
      supplier_id     INTEGER REFERENCES suppliers(id),
      amount          REAL NOT NULL DEFAULT 0,
      tax_amount      REAL DEFAULT 0,
      discount        REAL DEFAULT 0,
      total           REAL NOT NULL DEFAULT 0,
      currency        TEXT DEFAULT 'DOP',
      status          TEXT DEFAULT 'pendiente'
                        CHECK(status IN ('borrador','pendiente_aprobacion','aprobado',
                                         'pendiente_pago','parcialmente_pagado','pagado','anulado','rechazado')),
      payment_method  TEXT DEFAULT 'efectivo'
                        CHECK(payment_method IN ('efectivo','transferencia','tarjeta','cheque','credito','otro')),
      payment_source  TEXT DEFAULT 'caja'
                        CHECK(payment_source IN ('caja','caja_chica','banco','tarjeta_credito','pendiente')),
      cash_session_id INTEGER REFERENCES cash_sessions(id),
      cash_movement_id INTEGER REFERENCES cash_movements(id),
      issue_date      TEXT NOT NULL DEFAULT (date('now')),
      due_date        TEXT,
      invoice_number  TEXT,
      ncf             TEXT,
      supplier_rnc    TEXT,
      notes           TEXT,
      user_id         INTEGER REFERENCES users(id),
      approved_by     INTEGER REFERENCES users(id),
      approved_at     TEXT,
      cancelled_by    INTEGER REFERENCES users(id),
      cancel_reason   TEXT,
      cancelled_at    TEXT,
      paid_amount     REAL DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- ── Pagos de gastos ──
    CREATE TABLE IF NOT EXISTS expense_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id      INTEGER NOT NULL REFERENCES expenses(id),
      amount          REAL NOT NULL,
      payment_method  TEXT DEFAULT 'efectivo',
      payment_source  TEXT DEFAULT 'caja',
      cash_session_id INTEGER REFERENCES cash_sessions(id),
      cash_movement_id INTEGER REFERENCES cash_movements(id),
      reference       TEXT,
      notes           TEXT,
      user_id         INTEGER REFERENCES users(id),
      status          TEXT DEFAULT 'pagado' CHECK(status IN ('pagado','anulado')),
      cancelled_by    INTEGER REFERENCES users(id),
      cancel_reason   TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- ── Gastos recurrentes (plantillas) ──
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      supplier_id     INTEGER REFERENCES suppliers(id),
      category_id     INTEGER REFERENCES expense_categories(id),
      amount          REAL NOT NULL DEFAULT 0,
      frequency       TEXT DEFAULT 'mensual'
                        CHECK(frequency IN ('diario','semanal','quincenal','mensual','bimestral','trimestral','anual')),
      day_of_period   INTEGER DEFAULT 1,
      next_date       TEXT,
      end_date        TEXT,
      payment_method  TEXT DEFAULT 'efectivo',
      payment_source  TEXT DEFAULT 'caja',
      requires_approval INTEGER DEFAULT 0,
      auto_draft      INTEGER DEFAULT 1,
      active          INTEGER DEFAULT 1,
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- ── Presupuestos ──
    CREATE TABLE IF NOT EXISTS expense_budgets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id     INTEGER REFERENCES expense_categories(id),
      month           TEXT NOT NULL,
      amount          REAL NOT NULL DEFAULT 0,
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(category_id, month)
    );

    -- ── Configuración del módulo de gastos ──
    CREATE TABLE IF NOT EXISTS expense_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );


    -- ══════════════════════════════════════════════
    -- MÓDULO: SUCURSALES
    -- ══════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS branches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      address     TEXT,
      phone       TEXT,
      manager     TEXT,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- ══════════════════════════════════════════════
    -- MÓDULO: VEHÍCULOS
    -- ══════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS vehicles (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT NOT NULL DEFAULT 'carro'
                        CHECK(type IN ('carro','moto','camion','furgoneta','otro')),
      brand           TEXT NOT NULL,
      model           TEXT NOT NULL,
      year            INTEGER,
      plate           TEXT,
      color           TEXT,
      fuel_type       TEXT DEFAULT 'gasolina'
                        CHECK(fuel_type IN ('gasolina','diesel','electrico','hibrido')),
      fuel_grade      TEXT DEFAULT 'premium'
                        CHECK(fuel_grade IN ('premium','regular','diesel')),
      km_per_gallon   REAL DEFAULT 35,
      odometer        REAL DEFAULT 0,
      status          TEXT DEFAULT 'activo'
                        CHECK(status IN ('activo','inactivo','taller')),
      notes           TEXT,
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- ══════════════════════════════════════════════
    -- MÓDULO: MANTENIMIENTO DE VEHÍCULOS
    -- ══════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS vehicle_maintenance (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id),
      type            TEXT NOT NULL,
      description     TEXT,
      odometer_at     REAL,
      next_odometer   REAL,
      date_done       TEXT NOT NULL DEFAULT (date('now')),
      next_date       TEXT,
      cost            REAL DEFAULT 0,
      workshop        TEXT,
      notes           TEXT,
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vehicle_maintenance_types (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      interval_km   INTEGER DEFAULT 0,
      interval_days INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    -- ══════════════════════════════════════════════
    -- MÓDULO: ENVÍOS
    -- ══════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id         INTEGER REFERENCES sales(id),
      customer_id     INTEGER REFERENCES customers(id),
      vehicle_id      INTEGER REFERENCES vehicles(id),
      driver_id       INTEGER REFERENCES users(id),
      origin_address  TEXT,
      dest_address    TEXT NOT NULL,
      dest_lat        REAL,
      dest_lng        REAL,
      distance_km     REAL,
      fuel_used       REAL,
      fuel_cost       REAL,
      delivery_fee    REAL DEFAULT 0,
      status          TEXT DEFAULT 'pendiente'
                        CHECK(status IN ('pendiente','en_camino','entregado','cancelado')),
      scheduled_at    TEXT,
      delivered_at    TEXT,
      notes           TEXT,
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- ══════════════════════════════════════════════
    -- MÓDULO: NCF AVANZADO
    -- ══════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS ncf_sequences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      prefix      TEXT NOT NULL,
      from_num    INTEGER NOT NULL,
      to_num      INTEGER NOT NULL,
      current     INTEGER NOT NULL DEFAULT 0,
      expiry_date TEXT,
      active      INTEGER DEFAULT 1,
      alert_at    INTEGER DEFAULT 50,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ncf_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ncf         TEXT NOT NULL,
      type        TEXT NOT NULL,
      sale_id     INTEGER REFERENCES sales(id),
      customer_rnc TEXT,
      issued_at   TEXT DEFAULT (datetime('now'))
    );

    -- ── Tabla e-CF (Facturación Electrónica) ──────────────────────
    CREATE TABLE IF NOT EXISTS ecf_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id      INTEGER REFERENCES sales(id),
      encf         TEXT,
      tipo         TEXT,
      estado       TEXT DEFAULT 'Procesando',
      qr_code      TEXT,
      pdf_url      TEXT,
      xml_firmado  TEXT,
      emitido_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ecf_log_sale ON ecf_log(sale_id);
    CREATE INDEX IF NOT EXISTS idx_ecf_log_encf ON ecf_log(encf);

    -- Índices
    CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
    CREATE INDEX IF NOT EXISTS idx_deliveries_sale     ON deliveries(sale_id);
    CREATE INDEX IF NOT EXISTS idx_vm_vehicle          ON vehicle_maintenance(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_ncf_type            ON ncf_sequences(type);

    -- ── Índices del módulo ──
    CREATE INDEX IF NOT EXISTS idx_expenses_status    ON expenses(status);
    CREATE INDEX IF NOT EXISTS idx_expenses_date      ON expenses(issue_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_supplier  ON expenses(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_category  ON expenses(category_id);
    CREATE INDEX IF NOT EXISTS idx_exp_pay_expense    ON expense_payments(expense_id);

    -- ── Índices ──
    CREATE INDEX IF NOT EXISTS idx_sales_date        ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_customer    ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_sales_session     ON sales(cash_session_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale   ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_inv_product       ON inventory_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_products_barcode  ON products(barcode);
    -- Índices faltantes para búsquedas frecuentes en producción
    CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_products_code     ON products(code) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_sales_status      ON sales(status);
    CREATE INDEX IF NOT EXISTS idx_sales_user        ON sales(user_id);
    CREATE INDEX IF NOT EXISTS idx_customers_name    ON customers(name) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_cash_status       ON cash_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_inv_type          ON inventory_movements(type);
    CREATE INDEX IF NOT EXISTS idx_payments_date     ON payments(created_at DESC);
  `);
}

// ── Migración: columnas e-CF en sales (segura — ignora si ya existen) ─────────
function migrateECFColumns() {
  const cols = ['ecf_status', 'ecf_qr', 'ecf_pdf', 'ecf_sent_at'];
  cols.forEach(col => {
    try {
      db.prepare(`ALTER TABLE sales ADD COLUMN ${col} TEXT`).run();
      console.log(`[DB] Columna ${col} agregada a sales`);
    } catch { /* ya existe */ }
  });
}

// Migración segura de columnas en expenses y expense_payments
// Necesaria para DBs creadas antes de v1.5.x que no tenían estas columnas
function migrateExpensesColumns() {
  const expensesCols = [
    { col: 'cash_movement_id', def: 'INTEGER' },
    { col: 'approved_by',      def: 'INTEGER' },
    { col: 'approved_at',      def: 'TEXT' },
    { col: 'cancelled_by',     def: 'INTEGER' },
    { col: 'cancel_reason',    def: 'TEXT' },
    { col: 'cancelled_at',     def: 'TEXT' },
    { col: 'paid_amount',      def: 'REAL DEFAULT 0' },
    { col: 'supplier_rnc',     def: 'TEXT' },
    { col: 'ncf',              def: 'TEXT' },
    { col: 'invoice_number',   def: 'TEXT' },
    { col: 'tax_amount',       def: 'REAL DEFAULT 0' },
    { col: 'discount',         def: 'REAL DEFAULT 0' },
    { col: 'currency',         def: "TEXT DEFAULT 'DOP'" },
    { col: 'due_date',         def: 'TEXT' },
    { col: 'notes',            def: 'TEXT' },
    { col: 'updated_at',       def: "TEXT DEFAULT (datetime('now'))" },
  ];
  expensesCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE expenses ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE] expenses.${col} agregada`);
    } catch { /* ya existe — ignorar */ }
  });

  const payCols = [
    { col: 'cash_movement_id', def: 'INTEGER' },
    { col: 'reference',        def: 'TEXT' },
    { col: 'notes',            def: 'TEXT' },
    { col: 'cancelled_by',     def: 'INTEGER' },
    { col: 'cancel_reason',    def: 'TEXT' },
    { col: 'status',           def: "TEXT DEFAULT 'pagado'" },
    { col: 'payment_source',   def: "TEXT DEFAULT 'caja'" },
  ];
  payCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE expense_payments ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE] expense_payments.${col} agregada`);
    } catch { /* ya existe — ignorar */ }
  });
}

// ══════════════════════════════════════════════
// SEED INICIAL
// ══════════════════════════════════════════════
function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) {
    // Siempre verificar que el superadmin existe aunque la DB no sea nueva
    _ensureSuperAdmin();
    seedExpenseCategories();
    seedMaintenanceTypes();
    return;
  }

  console.log('[DB] Insertando datos iniciales...');
  seedExpenseCategories();
  seedMaintenanceTypes();

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  [
    ['biz_name',       'Mi Negocio'],
    ['biz_rnc',        ''],
    ['biz_addr',       ''],
    ['biz_phone',      ''],
    ['tax_pct',        '18'],
    ['fiscal_enabled', '0'],   // 0 = sin RNC/NCF/ITBIS · solo superadmin lo activa
    ['currency',       'RD$'],
    ['printer',        ''],
    ['receipt_msg',    '¡Gracias por su compra!'],
    ['password_changed','0'],
    ['ncf_counter',    '0'],
    ['barcode_enabled','0'],
    ['barcode_printer',''],
    ['barcode_design', ''],
    // ── Módulos activables por superadmin ──────────
    ['module_sucursales',      '0'],
    ['module_vehiculos',       '0'],
    ['module_mantenimiento',   '0'],
    ['module_envios',          '0'],
    ['module_ncf_avanzado',    '0'],
    ['module_multi_negocio',   '0'],
    // ── e-CF MSeller ──────────────────────────────
    ['ecf_email',        ''],
    ['ecf_password',     ''],
    ['ecf_api_key',      ''],
    ['ecf_environment',  'test'],
    // ── Visibilidad por rol ────────────────────────
    ['mod_envios_cajero',      '0'],
    ['mod_vehiculos_admin',    '1'],
    ['mod_mantenimiento_admin','1'],
    ['mod_sucursales_admin',   '1'],
    // ── Config combustible ─────────────────────────
    ['fuel_price_premium',    '293'],
    ['fuel_price_regular',    '276'],
    ['fuel_price_diesel',     '239'],
    ['fuel_last_updated',      ''],
    ['ors_api_key',            ''],
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
// La contraseña se genera dinámicamente basada en el machineId de la máquina.
// Nunca es la misma en dos instalaciones diferentes.
// El vendedor puede derivarla con: sha256(machineId + VENDOR_SALT).slice(0,16)
function _ensureSuperAdmin() {
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`)
    .get('dev@sistema.do');
  if (!existing) {
    const machinePass = _deriveSuperAdminPass();
    const hash        = bcrypt.hashSync(machinePass, 10);
    db.prepare(`
      INSERT INTO users(name,email,password,role,avatar,active)
      VALUES(?,?,?,?,?,1)
    `).run('Super Admin', 'dev@sistema.do', hash, 'superadmin', 'SA');
    console.log('[DB] Super Admin inicializado (contraseña derivada del hardware).');
  }
}

// Deriva la contraseña del superadmin a partir de identificadores de esta máquina.
// El resultado es único por máquina y no está hardcodeado en el código.
function _deriveSuperAdminPass() {
  const os       = require('os');
  const crypto   = require('crypto');
  // VENDOR_SALT: cambiar antes de producción — es el único secreto que el vendedor
  // debe guardar fuera del código (variable de entorno en CI, o en una herramienta CLI aparte)
  const VENDOR_SALT = process.env.VELO_VENDOR_SALT || 'velo-pos-salt-change-me';
  const cpuModel    = os.cpus()[0]?.model || 'cpu';
  const hostname    = os.hostname();
  const raw         = `${hostname}::${cpuModel}::${VENDOR_SALT}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);
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
    // Verificar si ya existe un producto con el mismo nombre (case-insensitive) y código
    // para evitar duplicados al importar varias veces
    if (p.name) {
      let existing;
      if (p.code && p.code !== '') {
        existing = db.prepare(
          "SELECT id FROM products WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?)) AND (code=? OR code='')"
        ).get(p.name, p.code);
      } else {
        existing = db.prepare(
          "SELECT id FROM products WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?))"
        ).get(p.name);
      }
      if (existing) return existing.id; // retornar el id existente sin duplicar
    }
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
    // VALIDACIÓN: qty=0 no debe crear movimiento ni alterar stock
    if (qty === 0) throw new Error('La cantidad del ajuste no puede ser cero');
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
    // VALIDACIONES: prevenir abonos inválidos que corrompan el balance
    if (!amount || amount <= 0) throw new Error('El monto del abono debe ser mayor a cero');
    if (amount > 9999999) throw new Error('Monto de abono excede el límite permitido');
    const cust = db.prepare('SELECT balance,credit_due FROM customers WHERE id=?').get(customerId);
    if (!cust) throw new Error('Cliente no encontrado');
    if (cust.balance <= 0) throw new Error('El cliente no tiene balance pendiente');
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
  delete(id) {
    if (Number(id) === 1) throw new Error('No se puede eliminar el cliente "Consumidor Final"');
    const cust = db.prepare('SELECT id,name,balance FROM customers WHERE id=?').get(id);
    if (!cust) throw new Error('Cliente no encontrado');
    db.prepare(`UPDATE customers SET active=0,updated_at=datetime('now') WHERE id=?`).run(id);
    return { id, name: cust.name, balance: cust.balance || 0 };
  },
  deleteAll() {
    const rows = db.prepare(`SELECT id,balance FROM customers WHERE active=1 AND id != 1`).all();
    const totalBalance = rows.reduce((s, r) => s + (r.balance || 0), 0);
    db.prepare(`UPDATE customers SET active=0,updated_at=datetime('now') WHERE active=1 AND id != 1`).run();
    return { count: rows.length, totalBalance };
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
    // SEGURIDAD: verificar que la sesión existe y está abierta antes de cerrarla
    const session = db.prepare('SELECT id, status FROM cash_sessions WHERE id=?').get(sessionId);
    if (!session) throw new Error('Sesión de caja no encontrada');
    if (session.status === 'closed') throw new Error('Esta sesión de caja ya fue cerrada');

    const diff = closeAmount - expected;
    db.prepare(`
      UPDATE cash_sessions SET
        close_date=?, close_time=?, close_amount=?, close_bills=?,
        expected=?, difference=?, notes=?, status='closed'
      WHERE id=? AND status='open'
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

      // 4b. Generar NCF (solo facturas con fiscal activo)
      let ncf = '';
      if (type === 'factura') {
        const fiscalOn = db.prepare("SELECT value FROM settings WHERE key='fiscal_enabled'").get()?.value === '1';
        const ncfAdv   = db.prepare("SELECT value FROM settings WHERE key='module_ncf_avanzado'").get()?.value === '1';

        if (fiscalOn) {
          if (ncfAdv) {
            // Modo avanzado: usar secuencias registradas por la DGII
            const ncfType = (customer.rnc && customer.rnc.trim()) ? 'B01' : 'B02';
            const seq = db.prepare(
              "SELECT * FROM ncf_sequences WHERE type=? AND active=1 AND current < to_num ORDER BY id ASC LIMIT 1"
            ).get(ncfType);

            if (seq) {
              const next = seq.current + 1;
              db.prepare("UPDATE ncf_sequences SET current=? WHERE id=?").run(next, seq.id);
              ncf = seq.prefix + String(next).padStart(8, '0');
              db.prepare("INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc) VALUES(?,?,?,?)")
                .run(ncf, ncfType, saleId, customer.rnc || '');
              const remaining = seq.to_num - next;
              if (remaining <= (seq.alert_at || 50)) {
                console.log('[NCF] ALERTA: quedan ' + remaining + ' comprobantes tipo ' + ncfType);
              }
            } else {
              // Fallback al contador simple si no hay secuencia disponible
              const nextNum = (parseInt(db.prepare("SELECT value FROM settings WHERE key='ncf_counter'").get()?.value || 0, 10)) + 1;
              ncf = 'B01' + String(nextNum).padStart(9, '0');
              db.prepare("UPDATE settings SET value=? WHERE key='ncf_counter'").run(String(nextNum));
              console.warn('[NCF] Sin secuencia — usando contador de respaldo. Configura secuencias en Panel NCF.');
            }
          } else {
            // Modo simple: contador básico
            const nextNum = (parseInt(db.prepare("SELECT value FROM settings WHERE key='ncf_counter'").get()?.value || 0, 10)) + 1;
            ncf = 'B01' + String(nextNum).padStart(9, '0');
            db.prepare("UPDATE settings SET value=? WHERE key='ncf_counter'").run(String(nextNum));
          }
          if (ncf) db.prepare("UPDATE sales SET ncf=? WHERE id=?").run(ncf, saleId);
        }
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
    if (sale.status === 'returned')  throw new Error('No se puede anular una venta con devolución procesada');
    // SEGURIDAD: solo facturas y ventas de crédito pueden anularse
    if (sale.type === 'cotizacion') throw new Error('Las cotizaciones no se anulan — elimínalas directamente');

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
    // ── Validar inputs para prevenir inyección ──
    // dateFrom y dateTo deben ser YYYY-MM-DD o null
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const safeFrom = (range === 'custom' && dateFrom && DATE_RE.test(dateFrom)) ? dateFrom : null;
    const safeTo   = (range === 'custom' && dateTo   && DATE_RE.test(dateTo))   ? dateTo   : null;

    // ── Construir filtros con parámetros preparados ──
    // Usamos funciones wrapper para evitar interpolación de strings
    const _buildFilters = () => {
      if (range === 'custom' && safeFrom && safeTo) {
        return {
          withAlias:    { sql: `date(s.created_at)   BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
          withoutAlias: { sql: `date(created_at)     BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
          payments:     { sql: `date(created_at,'localtime') BETWEEN ? AND ?`, params: [safeFrom, safeTo] },
        };
      }
      if (range === 'week') return {
        withAlias:    { sql: `date(s.created_at)  >= date('now','-7 days','localtime')`, params: [] },
        withoutAlias: { sql: `date(created_at)    >= date('now','-7 days','localtime')`, params: [] },
        payments:     { sql: `date(created_at,'localtime') >= date('now','-7 days','localtime')`, params: [] },
      };
      if (range === 'month') return {
        withAlias:    { sql: `strftime('%Y-%m',s.created_at) = strftime('%Y-%m','now','localtime')`, params: [] },
        withoutAlias: { sql: `strftime('%Y-%m',created_at)   = strftime('%Y-%m','now','localtime')`, params: [] },
        payments:     { sql: `strftime('%Y-%m',created_at,'localtime') = strftime('%Y-%m','now','localtime')`, params: [] },
      };
      if (range === 'all') return {
        withAlias:    { sql: `1=1`, params: [] },
        withoutAlias: { sql: `1=1`, params: [] },
        payments:     { sql: `1=1`, params: [] },
      };
      // today (default)
      return {
        withAlias:    { sql: `date(s.created_at)  = date('now','localtime')`, params: [] },
        withoutAlias: { sql: `date(created_at)    = date('now','localtime')`, params: [] },
        payments:     { sql: `date(created_at,'localtime') = date('now','localtime')`, params: [] },
      };
    };

    const f = _buildFilters();

    // Ventas por método de pago
    const byMethod = db.prepare(`
      SELECT payment_method, COUNT(*) as count,
             SUM(total) as total, SUM(tax_amt) as tax,
             SUM(discount_amt) as discount
      FROM sales
      WHERE status='completed' AND type != 'devolucion' AND ${f.withoutAlias.sql}
      GROUP BY payment_method
    `).all(...f.withoutAlias.params);

    // Costo total de lo vendido (desde snapshot de sale_items)
    const costData = db.prepare(`
      SELECT SUM(si.unit_cost * si.qty) as total_cost,
             SUM(si.unit_price * si.qty) as total_rev_items,
             COUNT(DISTINCT s.id) as total_sales,
             SUM(si.qty) as total_units
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status='completed' AND s.type != 'devolucion' AND ${f.withAlias.sql}
    `).get(...f.withAlias.params);

    // Devoluciones
    const devData = db.prepare(`
      SELECT COUNT(*) as count, SUM(total) as total
      FROM sales
      WHERE type='devolucion' AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // Descuentos totales
    const discData = db.prepare(`
      SELECT SUM(discount_amt) as total_discount
      FROM sales
      WHERE status='completed' AND type != 'devolucion' AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // ITBIS total
    const taxData = db.prepare(`
      SELECT SUM(tax_amt) as total_tax
      FROM sales
      WHERE status='completed' AND type != 'devolucion' AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // Productos más vendidos (con ganancia real)
    const topProducts = db.prepare(`
      SELECT si.product_name, si.product_code,
             SUM(si.qty) as total_qty,
             SUM(si.unit_price * si.qty) as total_rev,
             SUM(si.unit_cost  * si.qty) as total_cost,
             SUM((si.unit_price - si.unit_cost) * si.qty) as total_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status='completed' AND s.type != 'devolucion' AND ${f.withAlias.sql}
      GROUP BY si.product_id
      ORDER BY total_rev DESC LIMIT 10
    `).all(...f.withAlias.params);

    // Ventas por día (últimos 30 o en rango)
    const dailySales = db.prepare(`
      SELECT date(s.created_at,'localtime') as day,
             COUNT(*) as count,
             SUM(s.total) as total,
             SUM(si.unit_cost * si.qty) as cost
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.status='completed' AND s.type != 'devolucion' AND ${f.withAlias.sql}
      GROUP BY day
      ORDER BY day ASC
    `).all(...f.withAlias.params);

    // Abonos recibidos en el período (excluir saldos iniciales importados)
    const abonosData = db.prepare(`
      SELECT COUNT(*) as count, SUM(amount) as total
      FROM payments
      WHERE ${f.payments.sql}
        AND note != 'Saldo inicial importado'
    `).get(...f.payments.params);

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



function seedMaintenanceTypes() {
  const count = db.prepare('SELECT COUNT(*) as c FROM vehicle_maintenance_types').get().c;
  if (count > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO vehicle_maintenance_types(name,interval_km,interval_days) VALUES(?,?,?)');
  [
    ['Cambio de aceite',         5000,   90],
    ['Filtro de aceite',         5000,   90],
    ['Filtro de aire',          15000,  365],
    ['Filtro de combustible',   20000,  365],
    ['Cambio de cauchos',       50000,    0],
    ['Frenos (pastillas)',      30000,    0],
    ['Frenos (discos)',         60000,    0],
    ['Batería',                     0,  730],
    ['Correa de distribución',  60000, 1460],
    ['Alineación y balanceo',   10000,  180],
    ['Revisión general',            0,  180],
    ['Inspección de luces',         0,  365],
    ['Líquido de frenos',           0,  730],
    ['Líquido refrigerante',        0,  365],
    ['Bujías',                  30000,    0],
    ['Mantenimiento de moto',    3000,   90],
    ['Cadena de moto',          10000,    0],
    ['Neumático de moto',       20000,    0],
  ].forEach(([n,km,d]) => ins.run(n, km, d));
  console.log('[INIT] Tipos de mantenimiento inicializados');
}

function seedExpenseCategories() {
  const count = db.prepare('SELECT COUNT(*) as c FROM expense_categories').get().c;
  if (count > 0) return;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO expense_categories(name,parent_id,affects_profit,requires_approval) VALUES(?,?,?,?)'
  );
  const grupos = [
    ['Local', null, 1, 0],
    ['Servicios básicos', null, 1, 0],
    ['Operación', null, 1, 0],
    ['Personal', null, 1, 1],
    ['Marketing', null, 1, 0],
    ['Tecnología', null, 1, 0],
    ['Finanzas', null, 1, 0],
    ['Impuestos y permisos', null, 1, 1],
    ['Servicios profesionales', null, 1, 0],
    ['Activos fijos', null, 0, 1],
    ['Otros', null, 1, 0],
  ];
  const subs = {
    'Local':                ['Alquiler','Mantenimiento','Limpieza','Seguridad'],
    'Servicios básicos':    ['Electricidad','Agua','Internet','Teléfono'],
    'Operación':            ['Combustible','Transporte','Mensajería','Viáticos'],
    'Personal':             ['Nómina resumida','Incentivos','Uniformes','Capacitación'],
    'Marketing':            ['Publicidad','Diseño','Redes sociales','Impresiones'],
    'Tecnología':           ['Software','Licencias','Equipos','Reparaciones'],
    'Finanzas':             ['Comisiones bancarias','Intereses','Cargos por tarjeta'],
    'Impuestos y permisos': ['Impuestos','Licencias','Renovaciones'],
    'Servicios profesionales': ['Contabilidad','Abogados','Consultorías'],
    'Activos fijos':        ['Computadoras','Impresoras','Mobiliario','Equipos'],
    'Otros':                ['Imprevistos','Gastos extraordinarios'],
  };
  grupos.forEach(([name, pid, ap, ra]) => {
    const r = ins.run(name, pid, ap, ra);
    const parentId = r.lastInsertRowid;
    (subs[name] || []).forEach(sub => ins.run(sub, parentId, ap, ra));
  });
  // Config por defecto
  const insConf = db.prepare('INSERT OR IGNORE INTO expense_config(key,value) VALUES(?,?)');
  insConf.run('cajero_limit', '1500');      // límite sin aprobación para cajero
  insConf.run('require_attachment_above', '5000'); // exige comprobante sobre este monto
  console.log('[GASTOS] Categorías y config inicializadas');
}


// ══════════════════════════════════════════════
// REPOSITORIO: GASTOS Y CUENTAS POR PAGAR
// ══════════════════════════════════════════════
const expensesRepo = {
  // ── Configuración ────────────────────────
  getConfig() {
    const rows = db.prepare('SELECT key,value FROM expense_config').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  setConfig(key, value) {
    db.prepare('INSERT OR REPLACE INTO expense_config(key,value) VALUES(?,?)').run(key, String(value));
  },

  // ── Categorías ───────────────────────────
  getCategories() {
    return db.prepare(`
      SELECT c.*, p.name as parent_name
      FROM expense_categories c
      LEFT JOIN expense_categories p ON c.parent_id = p.id
      ORDER BY COALESCE(c.parent_id,c.id), c.id
    `).all();
  },
  createCategory({ name, parent_id, affects_profit, requires_approval, requires_attachment, approval_limit }) {
    const r = db.prepare(`INSERT INTO expense_categories(name,parent_id,affects_profit,requires_approval,requires_attachment,approval_limit)
      VALUES(?,?,?,?,?,?)`).run(name, parent_id||null, affects_profit??1, requires_approval??0, requires_attachment??0, approval_limit||0);
    return r.lastInsertRowid;
  },
  updateCategory(id, data) {
    db.prepare(`UPDATE expense_categories SET name=?,affects_profit=?,requires_approval=?,requires_attachment=?,approval_limit=?,active=? WHERE id=?`)
      .run(data.name, data.affects_profit??1, data.requires_approval??0, data.requires_attachment??0, data.approval_limit||0, data.active??1, id);
  },

  // ── CRUD Gastos ──────────────────────────
  getAll({ status, from, to, supplier_id, category_id, user_id, limit } = {}) {
    let q = `SELECT e.*,
      ec.name as category_name, ec.parent_id as category_parent_id,
      s.name as supplier_name,
      u.name as user_name,
      a.name as approved_by_name
    FROM expenses e
    LEFT JOIN expense_categories ec ON e.category_id = ec.id
    LEFT JOIN suppliers s ON e.supplier_id = s.id
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN users a ON e.approved_by = a.id
    WHERE 1=1`;
    const params = [];
    if (status)      { q += ' AND e.status=?';      params.push(status); }
    if (from)        { q += ' AND e.issue_date>=?';  params.push(from); }
    if (to)          { q += ' AND e.issue_date<=?';  params.push(to); }
    if (supplier_id) { q += ' AND e.supplier_id=?';  params.push(supplier_id); }
    if (category_id) { q += ' AND e.category_id=?';  params.push(category_id); }
    if (user_id)     { q += ' AND e.user_id=?';      params.push(user_id); }
    q += ' ORDER BY e.created_at DESC';
    if (limit) q += ` LIMIT ${parseInt(limit)}`;
    return db.prepare(q).all(...params);
  },

  getById(id) {
    const e = db.prepare(`SELECT e.*,
      ec.name as category_name, s.name as supplier_name,
      u.name as user_name, a.name as approved_by_name
    FROM expenses e
    LEFT JOIN expense_categories ec ON e.category_id = ec.id
    LEFT JOIN suppliers s ON e.supplier_id = s.id
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN users a ON e.approved_by = a.id
    WHERE e.id=?`).get(id);
    if (!e) return null;
    e.payments = db.prepare(`SELECT ep.*, u.name as user_name FROM expense_payments ep
      LEFT JOIN users u ON ep.user_id=u.id WHERE ep.expense_id=? ORDER BY ep.created_at`).all(id);
    return e;
  },

  getSummary({ from, to } = {}) {
    const dateFilter = from && to ? `AND e.issue_date BETWEEN '${from}' AND '${to}'` : '';
    return {
      total:       db.prepare(`SELECT COALESCE(SUM(total),0) as v FROM expenses e WHERE type='gasto' ${dateFilter}`).get().v,
      paid:        db.prepare(`SELECT COALESCE(SUM(paid_amount),0) as v FROM expenses e WHERE type='gasto' ${dateFilter}`).get().v,
      pending:     db.prepare(`SELECT COALESCE(SUM(total-paid_amount),0) as v FROM expenses e WHERE type='gasto' AND status NOT IN ('pagado','anulado') ${dateFilter}`).get().v,
      overdue:     db.prepare(`SELECT COALESCE(SUM(total-paid_amount),0) as v FROM expenses e WHERE type='gasto' AND status NOT IN ('pagado','anulado') AND due_date < date('now') ${dateFilter}`).get().v,
      from_cash:   db.prepare(`SELECT COALESCE(SUM(paid_amount),0) as v FROM expenses e WHERE type='gasto' AND payment_source='caja' ${dateFilter}`).get().v,
      count:       db.prepare(`SELECT COUNT(*) as v FROM expenses e WHERE type='gasto' ${dateFilter}`).get().v,
      by_category: db.prepare(`SELECT ec.name, COALESCE(SUM(e.total),0) as total FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE e.type='gasto' ${dateFilter} GROUP BY e.category_id ORDER BY total DESC LIMIT 8`).all(),
    };
  },

  // ── Crear gasto ──────────────────────────
  create({ type, category_id, description, supplier_id, amount, tax_amount, discount, total,
           currency, payment_method, payment_source, cash_session_id, issue_date, due_date,
           invoice_number, ncf, supplier_rnc, notes, user_id, status }) {
    const r = db.prepare(`
      INSERT INTO expenses(type,category_id,description,supplier_id,amount,tax_amount,discount,total,
        currency,payment_method,payment_source,cash_session_id,issue_date,due_date,
        invoice_number,ncf,supplier_rnc,notes,user_id,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(type||'gasto', category_id||null, description, supplier_id||null,
           amount||0, tax_amount||0, discount||0, total||amount||0,
           currency||'DOP', payment_method||'efectivo', payment_source||'pendiente',
           cash_session_id||null, issue_date||todayStr(), due_date||null,
           invoice_number||null, ncf||null, supplier_rnc||null, notes||null,
           user_id, status||'pendiente_pago');
    return r.lastInsertRowid;
  },

  // ── Pagar gasto desde caja ───────────────
  pay({ expenseId, amount, payment_method, payment_source, cash_session_id, reference, notes, userId, userName }) {
    return db.transaction(() => {
      const expense = db.prepare('SELECT * FROM expenses WHERE id=?').get(expenseId);
      if (!expense) throw new Error('Gasto no encontrado');
      if (expense.status === 'anulado') throw new Error('El gasto está anulado');
      const saldo = expense.total - expense.paid_amount;
      if (amount > saldo + 0.01) throw new Error(`Monto excede el saldo pendiente (RD$${saldo.toLocaleString('es-DO')})`);
      if (amount <= 0) throw new Error('El monto debe ser mayor a cero');

      // Crear movimiento de caja si paga desde caja
      let cashMovementId = null;
      if (payment_source === 'caja' && cash_session_id) {
        const session = db.prepare("SELECT * FROM cash_sessions WHERE id=? AND status='open'").get(cash_session_id);
        if (!session) throw new Error('La caja está cerrada');
        const cm = db.prepare(`INSERT INTO cash_movements(cash_session_id,type,amount,method,reference_id,description,user_id)
          VALUES(?,?,?,?,?,?,?)`).run(cash_session_id, 'salida', amount, payment_method||'efectivo',
          expenseId, `Gasto: ${expense.description}`, userId);
        cashMovementId = cm.lastInsertRowid;
        // Actualizar expected de la caja
        db.prepare('UPDATE cash_sessions SET expected=expected-? WHERE id=?').run(amount, cash_session_id);
      }

      // Registrar pago
      const payRow = db.prepare(`INSERT INTO expense_payments(expense_id,amount,payment_method,payment_source,
        cash_session_id,cash_movement_id,reference,notes,user_id)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(expenseId, amount, payment_method||'efectivo',
        payment_source||'caja', cash_session_id||null, cashMovementId, reference||null, notes||null, userId);

      // Actualizar gasto
      const newPaid = expense.paid_amount + amount;
      const newStatus = newPaid >= expense.total - 0.01 ? 'pagado' : 'parcialmente_pagado';
      db.prepare('UPDATE expenses SET paid_amount=?,status=?,updated_at=datetime("now"),cash_session_id=?,cash_movement_id=? WHERE id=?')
        .run(newPaid, newStatus, cash_session_id||expense.cash_session_id, cashMovementId||expense.cash_movement_id, expenseId);

      audit(userId, userName||'', 'gasto_pagado', 'expenses', expenseId,
        `Pago: RD$${amount} | Método: ${payment_method} | Estado: ${newStatus}`);
      return { ok: true, newStatus, newPaid, cashMovementId, paymentId: payRow.lastInsertRowid };
    })();
  },

  // ── Aprobar gasto ────────────────────────
  approve(expenseId, userId, userName) {
    const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(expenseId);
    if (!e) throw new Error('Gasto no encontrado');
    if (!['pendiente_aprobacion','borrador'].includes(e.status)) throw new Error('El gasto no está pendiente de aprobación');
    db.prepare('UPDATE expenses SET status=?,approved_by=?,approved_at=datetime("now"),updated_at=datetime("now") WHERE id=?')
      .run('aprobado', userId, expenseId);
    audit(userId, userName, 'gasto_aprobado', 'expenses', expenseId, '');
    return { ok: true };
  },

  // ── Rechazar gasto ───────────────────────
  reject(expenseId, userId, userName, reason) {
    db.prepare('UPDATE expenses SET status=?,cancel_reason=?,cancelled_by=?,cancelled_at=datetime("now"),updated_at=datetime("now") WHERE id=?')
      .run('rechazado', reason, userId, expenseId);
    audit(userId, userName, 'gasto_rechazado', 'expenses', expenseId, reason);
    return { ok: true };
  },

  // ── Anular gasto ─────────────────────────
  cancel(expenseId, userId, userName, reason) {
    return db.transaction(() => {
      const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(expenseId);
      if (!e) throw new Error('Gasto no encontrado');
      if (e.status === 'anulado') throw new Error('Ya está anulado');
      if (!reason?.trim()) throw new Error('El motivo de anulación es obligatorio');

      // Contramovimiento en caja si afectó caja
      if (e.cash_session_id && e.paid_amount > 0) {
        const session = db.prepare("SELECT * FROM cash_sessions WHERE id=?").get(e.cash_session_id);
        if (session?.status === 'open') {
          db.prepare(`INSERT INTO cash_movements(cash_session_id,type,amount,method,reference_id,description,user_id)
            VALUES(?,?,?,?,?,?,?)`).run(e.cash_session_id, 'entrada', e.paid_amount, e.payment_method,
            expenseId, `Anulación gasto: ${e.description}`, userId);
          db.prepare('UPDATE cash_sessions SET expected=expected+? WHERE id=?').run(e.paid_amount, e.cash_session_id);
        }
      }
      // Anular pagos activos
      db.prepare("UPDATE expense_payments SET status='anulado',cancel_reason=?,cancelled_by=? WHERE expense_id=? AND status='pagado'")
        .run(reason, userId, expenseId);
      db.prepare('UPDATE expenses SET status=?,cancel_reason=?,cancelled_by=?,cancelled_at=datetime("now"),updated_at=datetime("now") WHERE id=?')
        .run('anulado', reason, userId, expenseId);
      audit(userId, userName, 'gasto_anulado', 'expenses', expenseId, reason);
      return { ok: true };
    })();
  },

  // ── Cuentas por pagar ────────────────────
  getAccountsPayable() {
    return db.prepare(`
      SELECT e.*, ec.name as category_name, s.name as supplier_name,
        CASE WHEN e.due_date < date('now') AND e.status NOT IN ('pagado','anulado') THEN 1 ELSE 0 END as overdue,
        julianday(e.due_date) - julianday('now') as days_remaining
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN suppliers s ON e.supplier_id = s.id
      WHERE e.status NOT IN ('pagado','anulado','borrador','rechazado')
      AND e.type = 'gasto'
      ORDER BY e.due_date ASC, e.created_at DESC
    `).all();
  },

  // ── Gastos recurrentes ───────────────────
  getRecurring() {
    return db.prepare(`SELECT r.*, s.name as supplier_name, ec.name as category_name
      FROM recurring_expenses r
      LEFT JOIN suppliers s ON r.supplier_id=s.id
      LEFT JOIN expense_categories ec ON r.category_id=ec.id
      ORDER BY r.next_date ASC`).all();
  },
  createRecurring(data) {
    const r = db.prepare(`INSERT INTO recurring_expenses(name,supplier_id,category_id,amount,frequency,day_of_period,next_date,end_date,payment_method,payment_source,requires_approval,auto_draft,active,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(
      data.name, data.supplier_id||null, data.category_id||null, data.amount||0,
      data.frequency||'mensual', data.day_of_period||1, data.next_date||null, data.end_date||null,
      data.payment_method||'efectivo', data.payment_source||'caja',
      data.requires_approval||0, data.auto_draft??1, data.user_id);
    return r.lastInsertRowid;
  },
  toggleRecurring(id, active) {
    db.prepare('UPDATE recurring_expenses SET active=? WHERE id=?').run(active?1:0, id);
  },

  // ── Presupuestos ─────────────────────────
  getBudgets(month) {
    return db.prepare(`
      SELECT b.*, ec.name as category_name,
        COALESCE((SELECT SUM(e.total) FROM expenses e WHERE e.category_id=b.category_id
          AND strftime('%Y-%m',e.issue_date)=b.month AND e.status NOT IN ('anulado','borrador')),0) as spent
      FROM expense_budgets b
      LEFT JOIN expense_categories ec ON b.category_id=ec.id
      WHERE b.month=?
    `).all(month);
  },
  upsertBudget({ category_id, month, amount, user_id }) {
    db.prepare('INSERT OR REPLACE INTO expense_budgets(category_id,month,amount,user_id) VALUES(?,?,?,?)')
      .run(category_id, month, amount, user_id);
  },
};


// ══════════════════════════════════════════════
// REPOSITORIO: SUCURSALES
// ══════════════════════════════════════════════
const branchesRepo = {
  getAll() { return db.prepare('SELECT * FROM branches ORDER BY name').all(); },
  getById(id) { return db.prepare('SELECT * FROM branches WHERE id=?').get(id); },
  create({ name, address, phone, manager }) {
    return db.prepare('INSERT INTO branches(name,address,phone,manager) VALUES(?,?,?,?)')
      .run(name, address||'', phone||'', manager||'').lastInsertRowid;
  },
  update(id, { name, address, phone, manager, active }) {
    db.prepare('UPDATE branches SET name=?,address=?,phone=?,manager=?,active=? WHERE id=?')
      .run(name, address||'', phone||'', manager||'', active??1, id);
  },
  delete(id) { db.prepare('DELETE FROM branches WHERE id=?').run(id); },
};

// ══════════════════════════════════════════════
// REPOSITORIO: VEHÍCULOS
// ══════════════════════════════════════════════
const vehiclesRepo = {
  getAll() {
    return db.prepare(`SELECT v.*, u.name as user_name FROM vehicles v
      LEFT JOIN users u ON v.user_id=u.id ORDER BY v.brand, v.model`).all();
  },
  getById(id) { return db.prepare('SELECT * FROM vehicles WHERE id=?').get(id); },
  create(data) {
    const r = db.prepare(`INSERT INTO vehicles(type,brand,model,year,plate,color,fuel_type,fuel_grade,km_per_gallon,odometer,notes,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.type||'carro', data.brand, data.model, data.year||null,
      data.plate||'', data.color||'', data.fuel_type||'gasolina',
      data.fuel_grade||'premium', data.km_per_gallon||35,
      data.odometer||0, data.notes||'', data.user_id||null);
    return r.lastInsertRowid;
  },
  update(id, data) {
    db.prepare(`UPDATE vehicles SET type=?,brand=?,model=?,year=?,plate=?,color=?,
      fuel_type=?,fuel_grade=?,km_per_gallon=?,odometer=?,status=?,notes=?,updated_at=datetime('now') WHERE id=?`)
      .run(data.type||'carro', data.brand, data.model, data.year||null,
           data.plate||'', data.color||'', data.fuel_type||'gasolina',
           data.fuel_grade||'premium', data.km_per_gallon||35,
           data.odometer||0, data.status||'activo', data.notes||'', id);
  },
  delete(id) { db.prepare('DELETE FROM vehicles WHERE id=?').run(id); },

  // Calcular costo estimado de combustible para una distancia
  calcFuelCost(vehicleId, distanceKm, fuelPrices) {
    const v = this.getById(vehicleId);
    if (!v) return null;
    const gallons = distanceKm / (v.km_per_gallon || 35);
    const pricePerGallon = parseFloat(fuelPrices[v.fuel_grade] || fuelPrices.premium || 293);
    const cost = gallons * pricePerGallon;
    return { gallons: Math.round(gallons * 100) / 100, cost: Math.round(cost * 100) / 100,
             fuel_grade: v.fuel_grade, km_per_gallon: v.km_per_gallon };
  },
};

// ══════════════════════════════════════════════
// REPOSITORIO: MANTENIMIENTO
// ══════════════════════════════════════════════
const maintenanceRepo = {
  getTypes() { return db.prepare('SELECT * FROM vehicle_maintenance_types WHERE active=1 ORDER BY name').all(); },
  getByVehicle(vehicleId) {
    return db.prepare(`SELECT m.*, u.name as user_name FROM vehicle_maintenance m
      LEFT JOIN users u ON m.user_id=u.id WHERE m.vehicle_id=? ORDER BY m.date_done DESC`).all(vehicleId);
  },
  getPending() {
    return db.prepare(`SELECT m.*, v.brand, v.model, v.plate FROM vehicle_maintenance m
      JOIN vehicles v ON m.vehicle_id=v.id
      WHERE m.next_date IS NOT NULL AND m.next_date <= date('now','+30 days')
      ORDER BY m.next_date ASC`).all();
  },
  create(data) {
    return db.prepare(`INSERT INTO vehicle_maintenance(vehicle_id,type,description,odometer_at,next_odometer,date_done,next_date,cost,workshop,notes,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.vehicle_id, data.type, data.description||'',
      data.odometer_at||null, data.next_odometer||null,
      data.date_done||todayStr(), data.next_date||null,
      data.cost||0, data.workshop||'', data.notes||'', data.user_id||null).lastInsertRowid;
  },
  delete(id) { db.prepare('DELETE FROM vehicle_maintenance WHERE id=?').run(id); },
};

// ══════════════════════════════════════════════
// REPOSITORIO: ENVÍOS
// ══════════════════════════════════════════════
const deliveriesRepo = {
  getAll({ status, from, to } = {}) {
    let q = `SELECT d.*, v.brand, v.model, v.plate, v.km_per_gallon, v.fuel_grade,
      u.name as driver_name, c.name as customer_name
      FROM deliveries d
      LEFT JOIN vehicles v ON d.vehicle_id=v.id
      LEFT JOIN users u ON d.driver_id=u.id
      LEFT JOIN customers c ON d.customer_id=c.id WHERE 1=1`;
    const p = [];
    if (status) { q += ' AND d.status=?'; p.push(status); }
    if (from)   { q += ' AND d.created_at>=?'; p.push(from); }
    if (to)     { q += ' AND d.created_at<=?'; p.push(to); }
    q += ' ORDER BY d.created_at DESC';
    return db.prepare(q).all(...p);
  },
  getById(id) { return db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); },
  create(data) {
    return db.prepare(`INSERT INTO deliveries(sale_id,customer_id,vehicle_id,driver_id,
      origin_address,dest_address,dest_lat,dest_lng,distance_km,fuel_used,fuel_cost,
      delivery_fee,status,scheduled_at,notes,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.sale_id||null, data.customer_id||null, data.vehicle_id||null, data.driver_id||null,
      data.origin_address||'', data.dest_address, data.dest_lat||null, data.dest_lng||null,
      data.distance_km||null, data.fuel_used||null, data.fuel_cost||null,
      data.delivery_fee||0, data.status||'pendiente', data.scheduled_at||null,
      data.notes||'', data.user_id||null).lastInsertRowid;
  },
  updateStatus(id, status, userId) {
    db.prepare(`UPDATE deliveries SET status=?,${status==='entregado'?"delivered_at=datetime('now'),":""} updated_at=datetime('now') WHERE id=?`)
      .run(status, id);
  },
  getSummary() {
    return {
      pendiente:   db.prepare("SELECT COUNT(*) as c FROM deliveries WHERE status='pendiente'").get().c,
      en_camino:   db.prepare("SELECT COUNT(*) as c FROM deliveries WHERE status='en_camino'").get().c,
      entregado:   db.prepare("SELECT COUNT(*) as c FROM deliveries WHERE status='entregado'").get().c,
      fuel_cost:   db.prepare("SELECT COALESCE(SUM(fuel_cost),0) as c FROM deliveries WHERE status='entregado'").get().c,
    };
  },
};

// ══════════════════════════════════════════════
// REPOSITORIO: NCF AVANZADO
// ══════════════════════════════════════════════
const ncfRepo = {
  getSequences() { return db.prepare('SELECT * FROM ncf_sequences ORDER BY type, id').all(); },
  getActive(type) { return db.prepare("SELECT * FROM ncf_sequences WHERE type=? AND active=1").get(type); },
  createSequence({ type, prefix, from_num, to_num, expiry_date, alert_at }) {
    return db.prepare('INSERT INTO ncf_sequences(type,prefix,from_num,to_num,current,expiry_date,alert_at) VALUES(?,?,?,?,?,?,?)')
      .run(type, prefix, from_num, to_num, from_num - 1, expiry_date||null, alert_at||50).lastInsertRowid;
  },
  getNext(type) {
    return db.transaction(() => {
      const seq = db.prepare("SELECT * FROM ncf_sequences WHERE type=? AND active=1 AND current < to_num").get(type);
      if (!seq) throw new Error(`Sin comprobantes disponibles tipo ${type}`);
      const next = seq.current + 1;
      db.prepare('UPDATE ncf_sequences SET current=? WHERE id=?').run(next, seq.id);
      const ncf = seq.prefix + String(next).padStart(8, '0');
      const remaining = seq.to_num - next;
      // Alerta si quedan pocos
      if (remaining <= seq.alert_at) console.log(`[NCF] ALERTA: quedan ${remaining} comprobantes tipo ${type}`);
      return { ncf, remaining, sequence_id: seq.id };
    })();
  },
  logNcf({ ncf, type, sale_id, customer_rnc }) {
    db.prepare('INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc) VALUES(?,?,?,?)').run(ncf, type, sale_id||null, customer_rnc||'');
  },
  getAlerts() {
    return db.prepare(`SELECT *, (to_num - current) as remaining FROM ncf_sequences
      WHERE active=1 AND (to_num - current) <= alert_at ORDER BY remaining ASC`).all();
  },
};

// ══════════════════════════════════════════════
// REPOSITORIO: CUENTAS FINANCIERAS (BANCOS)
// ══════════════════════════════════════════════
const financialAccountsRepo = {
  getAll() {
    return db.prepare('SELECT * FROM financial_accounts ORDER BY type, name').all();
  },
  getById(id) {
    return db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(id);
  },
  create({ name, type, bank_name, account_number, currency, initial_balance, description, notes, userId }) {
    const bal = parseFloat(initial_balance) || 0;
    const r = db.prepare(`
      INSERT INTO financial_accounts(name,type,bank_name,account_number,currency,
        initial_balance,current_balance,description,notes,user_id,active)
      VALUES(?,?,?,?,?,?,?,?,?,?,1)
    `).run(name, type||'caja', bank_name||'', account_number||'',
           currency||'DOP', bal, bal, description||'', notes||'', userId||null);
    const accId = r.lastInsertRowid;
    if (bal > 0) {
      db.prepare(`
        INSERT INTO financial_movements(financial_account_id,type,amount,balance_before,
          balance_after,description,user_id)
        VALUES(?,?,?,0,?,?,?)
      `).run(accId, 'apertura', bal, bal, 'Balance inicial', userId||null);
    }
    return accId;
  },
  update(id, { name, type, bank_name, account_number, currency, description, notes, active }) {
    db.prepare(`
      UPDATE financial_accounts SET name=?,type=?,bank_name=?,account_number=?,
        currency=?,description=?,notes=?,active=?,updated_at=datetime('now')
      WHERE id=?
    `).run(name, type||'caja', bank_name||'', account_number||'',
           currency||'DOP', description||'', notes||'', active??1, id);
  },
  toggleActive(id, active) {
    db.prepare(`UPDATE financial_accounts SET active=?,updated_at=datetime('now') WHERE id=?`)
      .run(active?1:0, id);
  },
  getMovements(accountId, { from, to, limit = 200 } = {}) {
    let q = `SELECT m.*, u.name as user_name,
      fa2.name as related_account_name
      FROM financial_movements m
      LEFT JOIN users u ON m.user_id=u.id
      LEFT JOIN financial_accounts fa2 ON m.related_account_id=fa2.id
      WHERE m.financial_account_id=? AND m.status='activo'`;
    const params = [accountId];
    if (from) { q += ' AND date(m.created_at)>=?'; params.push(from); }
    if (to)   { q += ' AND date(m.created_at)<=?'; params.push(to); }
    q += ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?';
    params.push(limit);
    return db.prepare(q).all(...params);
  },
  addMovement({ accountId, type, amount, description, referenceType, referenceId, relatedAccountId, method, notes, userId }) {
    return db.transaction(() => {
      const acc = db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(accountId);
      if (!acc) throw new Error('Cuenta no encontrada');
      if (!acc.active) throw new Error('La cuenta está inactiva');
      const amt = parseFloat(amount);
      if (!amt || amt === 0) throw new Error('El monto no puede ser cero');
      const before = acc.current_balance;
      const after  = before + amt; // amount can be negative for outflows
      db.prepare(`UPDATE financial_accounts SET current_balance=?,updated_at=datetime('now') WHERE id=?`)
        .run(after, accountId);
      const r = db.prepare(`
        INSERT INTO financial_movements(financial_account_id,type,amount,balance_before,balance_after,
          description,reference_type,reference_id,related_account_id,method,notes,user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(accountId, type, Math.abs(amt), before, after, description||'',
             referenceType||'', referenceId||null, relatedAccountId||null,
             method||'efectivo', notes||'', userId||null);
      return { movementId: r.lastInsertRowid, balance_before: before, balance_after: after };
    })();
  },
  transfer({ fromId, toId, amount, description, notes, userId }) {
    return db.transaction(() => {
      const fromAcc = db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(fromId);
      const toAcc   = db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(toId);
      if (!fromAcc || !toAcc) throw new Error('Cuenta no encontrada');
      if (!fromAcc.active || !toAcc.active) throw new Error('Una de las cuentas está inactiva');
      const amt = parseFloat(amount);
      if (amt <= 0) throw new Error('El monto debe ser mayor a cero');

      const fromBefore = fromAcc.current_balance;
      const fromAfter  = fromBefore - amt;
      const toBefore   = toAcc.current_balance;
      const toAfter    = toBefore + amt;

      db.prepare(`UPDATE financial_accounts SET current_balance=?,updated_at=datetime('now') WHERE id=?`)
        .run(fromAfter, fromId);
      db.prepare(`UPDATE financial_accounts SET current_balance=?,updated_at=datetime('now') WHERE id=?`)
        .run(toAfter, toId);

      const desc = description || `Transferencia a ${toAcc.name}`;
      const descTo = description ? `${description} (de ${fromAcc.name})` : `Transferencia de ${fromAcc.name}`;

      db.prepare(`INSERT INTO financial_movements(financial_account_id,type,amount,balance_before,
        balance_after,description,related_account_id,notes,user_id)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(fromId, 'transferencia_out', amt, fromBefore, fromAfter, desc, toId, notes||'', userId||null);
      db.prepare(`INSERT INTO financial_movements(financial_account_id,type,amount,balance_before,
        balance_after,description,related_account_id,notes,user_id)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(toId, 'transferencia_in', amt, toBefore, toAfter, descTo, fromId, notes||'', userId||null);

      return { ok: true, fromBalance: fromAfter, toBalance: toAfter };
    })();
  },
  cancelMovement(movementId, cancelledBy, reason) {
    return db.transaction(() => {
      const mov = db.prepare('SELECT * FROM financial_movements WHERE id=?').get(movementId);
      if (!mov) throw new Error('Movimiento no encontrado');
      if (mov.status === 'anulado') throw new Error('Ya está anulado');
      // Revertir el movimiento en la cuenta
      const acc = db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(mov.financial_account_id);
      const outflow = ['transferencia_out','retiro','gasto','pago_proveedor'].includes(mov.type);
      const newBal = outflow ? acc.current_balance + mov.amount : acc.current_balance - mov.amount;
      db.prepare(`UPDATE financial_accounts SET current_balance=?,updated_at=datetime('now') WHERE id=?`)
        .run(newBal, mov.financial_account_id);
      db.prepare(`UPDATE financial_movements SET status='anulado',cancelled_by=?,cancel_reason=?,
        cancelled_at=datetime('now') WHERE id=?`).run(cancelledBy, reason||'', movementId);
      return { ok: true };
    })();
  },
  getSummary() {
    const accs = db.prepare('SELECT * FROM financial_accounts WHERE active=1').all();
    const total = accs.reduce((s, a) => s + (a.current_balance||0), 0);
    const byCaja = accs.filter(a=>a.type==='caja'||a.type==='caja_chica').reduce((s,a)=>s+(a.current_balance||0),0);
    const byBank = accs.filter(a=>a.type==='banco').reduce((s,a)=>s+(a.current_balance||0),0);
    return { total, byCaja, byBank, accounts: accs };
  },
};

// ══════════════════════════════════════════════
// REPOSITORIO: CONTABILIDAD
// ══════════════════════════════════════════════
const accountingRepo = {
  // ── Catálogo de cuentas ──────────────────
  getAccounts({ type, active } = {}) {
    let q = `SELECT a.*, p.name as parent_name, p.code as parent_code
      FROM accounting_accounts a
      LEFT JOIN accounting_accounts p ON a.parent_id=p.id
      WHERE 1=1`;
    const params = [];
    if (type)           { q += ' AND a.type=?';   params.push(type); }
    if (active != null) { q += ' AND a.active=?'; params.push(active?1:0); }
    q += ' ORDER BY a.code';
    return db.prepare(q).all(...params);
  },
  getAccountByCode(code) {
    return db.prepare('SELECT * FROM accounting_accounts WHERE code=?').get(code);
  },
  getAccountById(id) {
    return db.prepare('SELECT * FROM accounting_accounts WHERE id=?').get(id);
  },
  createAccount({ code, name, type, subtype, parent_id, description, is_summary }) {
    if (db.prepare('SELECT id FROM accounting_accounts WHERE code=?').get(code)) {
      throw new Error(`El código ${code} ya existe`);
    }
    const r = db.prepare(`
      INSERT INTO accounting_accounts(code,name,type,subtype,parent_id,description,is_summary,active)
      VALUES(?,?,?,?,?,?,?,1)
    `).run(code, name, type, subtype||'', parent_id||null, description||'', is_summary?1:0);
    return r.lastInsertRowid;
  },
  updateAccount(id, { code, name, type, subtype, parent_id, description, is_summary, active }) {
    const existing = db.prepare('SELECT id FROM accounting_accounts WHERE code=? AND id!=?').get(code, id);
    if (existing) throw new Error(`El código ${code} ya existe en otra cuenta`);
    db.prepare(`UPDATE accounting_accounts SET code=?,name=?,type=?,subtype=?,parent_id=?,
      description=?,is_summary=?,active=?,updated_at=datetime('now') WHERE id=?`)
      .run(code, name, type, subtype||'', parent_id||null, description||'', is_summary?1:0, active??1, id);
  },
  deleteAccount(id) {
    const hasLines = db.prepare('SELECT COUNT(*) as c FROM accounting_entry_lines WHERE account_id=?').get(id).c;
    if (hasLines > 0) throw new Error('No se puede eliminar: tiene asientos registrados. Desactívela en su lugar.');
    db.prepare('UPDATE accounting_accounts SET active=0,updated_at=datetime(\'now\') WHERE id=?').run(id);
  },

  // ── Configuración contable ────────────────
  getConfig() {
    const rows = db.prepare(`SELECT c.*, a.code as account_code, a.name as account_name
      FROM accounting_config c
      LEFT JOIN accounting_accounts a ON c.account_id=a.id`).all();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r; });
    return obj;
  },
  setConfig(key, accountId, description) {
    db.prepare(`INSERT INTO accounting_config(key,account_id,description,updated_at)
      VALUES(?,?,?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET account_id=excluded.account_id,
        description=COALESCE(excluded.description,description),
        updated_at=excluded.updated_at`).run(key, accountId||null, description||'');
  },

  // ── Asientos contables ───────────────────
  _nextNumber() {
    const last = db.prepare("SELECT number FROM accounting_entries ORDER BY id DESC LIMIT 1").get();
    if (!last) return 'AS-000001';
    const num = parseInt(last.number.replace('AS-','')) + 1;
    return 'AS-' + String(num).padStart(6, '0');
  },

  createEntry({ date, concept, reference, source_module, source_id, lines, notes, userId, status }) {
    return db.transaction(() => {
      if (!lines || lines.length < 2) throw new Error('El asiento debe tener al menos 2 líneas');
      const totalDebit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
      const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new Error(`Asiento descuadrado: Débito=${totalDebit.toFixed(2)} ≠ Crédito=${totalCredit.toFixed(2)}`);
      }
      const number = this._nextNumber();
      const entryStatus = status || 'confirmado';
      const r = db.prepare(`
        INSERT INTO accounting_entries(number,date,concept,reference,source_module,source_id,
          total_debit,total_credit,status,notes,user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(number, date||new Date().toISOString().split('T')[0], concept, reference||'',
             source_module||'', source_id||null, totalDebit, totalCredit,
             entryStatus, notes||'', userId||null);
      const entryId = r.lastInsertRowid;
      for (const line of lines) {
        const acc = db.prepare('SELECT id,active FROM accounting_accounts WHERE id=?').get(line.account_id);
        if (!acc) throw new Error(`Cuenta ID ${line.account_id} no existe`);
        if (!acc.active) throw new Error(`La cuenta ${line.account_id} está inactiva`);
        db.prepare(`INSERT INTO accounting_entry_lines(entry_id,account_id,description,debit,credit,reference)
          VALUES(?,?,?,?,?,?)`).run(entryId, line.account_id, line.description||'',
          parseFloat(line.debit)||0, parseFloat(line.credit)||0, line.reference||'');
        // Actualizar saldo de cuenta
        const netChange = (parseFloat(line.debit)||0) - (parseFloat(line.credit)||0);
        db.prepare(`UPDATE accounting_accounts SET balance=balance+?,updated_at=datetime('now') WHERE id=?`)
          .run(netChange, line.account_id);
      }
      return { entryId, number, totalDebit, totalCredit };
    })();
  },

  getEntries({ from, to, source_module, status, limit = 200 } = {}) {
    let q = `SELECT e.*, u.name as user_name FROM accounting_entries e
      LEFT JOIN users u ON e.user_id=u.id WHERE 1=1`;
    const params = [];
    if (from)          { q += ' AND e.date>=?'; params.push(from); }
    if (to)            { q += ' AND e.date<=?'; params.push(to); }
    if (source_module) { q += ' AND e.source_module=?'; params.push(source_module); }
    if (status)        { q += ' AND e.status=?'; params.push(status); }
    q += ' ORDER BY e.date DESC, e.id DESC LIMIT ?';
    params.push(limit);
    return db.prepare(q).all(...params);
  },

  getEntryById(id) {
    const entry = db.prepare('SELECT e.*, u.name as user_name FROM accounting_entries e LEFT JOIN users u ON e.user_id=u.id WHERE e.id=?').get(id);
    if (!entry) return null;
    entry.lines = db.prepare(`SELECT l.*, a.code as account_code, a.name as account_name
      FROM accounting_entry_lines l
      LEFT JOIN accounting_accounts a ON l.account_id=a.id
      WHERE l.entry_id=? ORDER BY l.id`).all(id);
    return entry;
  },

  reverseEntry(entryId, userId, reason) {
    return db.transaction(() => {
      const original = this.getEntryById(entryId);
      if (!original) throw new Error('Asiento no encontrado');
      if (original.status === 'anulado') throw new Error('El asiento ya está anulado');
      if (!reason?.trim()) throw new Error('El motivo de anulación es obligatorio');

      // Crear asiento de reverso
      const reversalLines = original.lines.map(l => ({
        account_id:  l.account_id,
        description: `Reverso: ${l.description}`,
        debit:       l.credit,
        credit:      l.debit,
        reference:   original.number,
      }));

      const reversal = this.createEntry({
        date:          new Date().toISOString().split('T')[0],
        concept:       `REVERSO: ${original.concept}`,
        reference:     original.number,
        source_module: 'reverso',
        source_id:     original.id,
        lines:         reversalLines,
        notes:         reason,
        userId,
        status:        'confirmado',
      });

      // Marcar original como anulado
      db.prepare(`UPDATE accounting_entries SET status='anulado',reversed_by=?,
        updated_at=datetime('now') WHERE id=?`).run(reversal.entryId, entryId);
      db.prepare(`UPDATE accounting_entries SET reversal_of=? WHERE id=?`)
        .run(entryId, reversal.entryId);

      // Revertir cambios de saldo del asiento original
      for (const line of original.lines) {
        const netChange = (parseFloat(line.debit)||0) - (parseFloat(line.credit)||0);
        db.prepare(`UPDATE accounting_accounts SET balance=balance-?,updated_at=datetime('now') WHERE id=?`)
          .run(netChange, line.account_id);
      }

      audit(userId, '', 'asiento_anulado', 'accounting_entries', entryId, reason);
      return { ok: true, reversalId: reversal.entryId, reversalNumber: reversal.number };
    })();
  },

  // ── Mayor general (movimientos por cuenta) ─
  getLedger({ accountId, from, to } = {}) {
    let q = `SELECT l.*, e.date, e.number, e.concept, e.source_module, e.status,
      a.code, a.name as account_name
      FROM accounting_entry_lines l
      JOIN accounting_entries e ON l.entry_id=e.id
      JOIN accounting_accounts a ON l.account_id=a.id
      WHERE e.status='confirmado'`;
    const params = [];
    if (accountId) { q += ' AND l.account_id=?'; params.push(accountId); }
    if (from)      { q += ' AND e.date>=?'; params.push(from); }
    if (to)        { q += ' AND e.date<=?'; params.push(to); }
    q += ' ORDER BY e.date ASC, e.id ASC, l.id ASC';
    return db.prepare(q).all(...params);
  },

  // ── Balance de comprobación ───────────────
  getTrialBalance({ from, to } = {}) {
    const accounts = db.prepare(`SELECT a.*,
      COALESCE((SELECT SUM(l.debit)  FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        WHERE l.account_id=a.id AND e.status='confirmado'
        ${from ? "AND e.date>='"+from+"'" : ''}
        ${to   ? "AND e.date<='"+to+"'"   : ''}),0) as period_debit,
      COALESCE((SELECT SUM(l.credit) FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        WHERE l.account_id=a.id AND e.status='confirmado'
        ${from ? "AND e.date>='"+from+"'" : ''}
        ${to   ? "AND e.date<='"+to+"'"   : ''}),0) as period_credit
      FROM accounting_accounts a
      WHERE a.active=1 AND a.is_summary=0
      ORDER BY a.code`).all();

    return accounts.map(a => ({
      ...a,
      net_debit:  Math.max(0, a.period_debit  - a.period_credit),
      net_credit: Math.max(0, a.period_credit - a.period_debit),
    }));
  },

  // ── Estado de resultados ──────────────────
  getIncomeStatement({ from, to } = {}) {
    const getTotal = (types, sign = 1) => {
      const rows = db.prepare(`
        SELECT a.code, a.name, a.type,
          COALESCE(SUM(l.debit),0) as total_debit,
          COALESCE(SUM(l.credit),0) as total_credit
        FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        JOIN accounting_accounts a ON l.account_id=a.id
        WHERE e.status='confirmado' AND a.active=1 AND a.is_summary=0
          AND a.type IN (${types.map(()=>'?').join(',')})
          ${from ? `AND e.date>=?` : ''}
          ${to   ? `AND e.date<=?` : ''}
        GROUP BY a.id ORDER BY a.code
      `).all(...types, ...(from?[from]:[]), ...(to?[to]:[]));
      return rows.map(r => ({
        ...r,
        net: (r.total_debit - r.total_credit) * sign,
      }));
    };

    const revenues = getTotal(['ingreso'], -1);
    const costs    = getTotal(['costo'],    1);
    const expenses = getTotal(['gasto'],    1);

    const totalRev  = revenues.reduce((s,r) => s + r.net, 0);
    const totalCost = costs.reduce((s,r) => s + r.net, 0);
    const totalExp  = expenses.reduce((s,r) => s + r.net, 0);
    const grossProfit = totalRev - totalCost;
    const netIncome   = grossProfit - totalExp;

    return { revenues, costs, expenses, totalRev, totalCost, totalExp, grossProfit, netIncome };
  },

  // ── Balance general ───────────────────────
  getBalanceSheet({ to } = {}) {
    const getGroup = (types) => {
      return db.prepare(`
        SELECT a.code, a.name, a.type, a.subtype,
          COALESCE(SUM(l.debit),0) as total_debit,
          COALESCE(SUM(l.credit),0) as total_credit
        FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        JOIN accounting_accounts a ON l.account_id=a.id
        WHERE e.status='confirmado' AND a.active=1 AND a.is_summary=0
          AND a.type IN (${types.map(()=>'?').join(',')})
          ${to ? 'AND e.date<=?' : ''}
        GROUP BY a.id ORDER BY a.code
      `).all(...types, ...(to?[to]:[]));
    };

    const assets   = getGroup(['activo']).map(r => ({ ...r, net: r.total_debit - r.total_credit }));
    const liabilities = getGroup(['pasivo']).map(r => ({ ...r, net: r.total_credit - r.total_debit }));
    const equity   = getGroup(['capital']).map(r => ({ ...r, net: r.total_credit - r.total_debit }));

    const totalAssets = assets.reduce((s,r) => s+r.net, 0);
    const totalLiab   = liabilities.reduce((s,r) => s+r.net, 0);
    const totalEquity = equity.reduce((s,r) => s+r.net, 0);

    return { assets, liabilities, equity, totalAssets, totalLiab, totalEquity };
  },

  // ── Generar asiento automático para venta ─
  generateSaleEntry({ saleId, userId, configOverride } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;

      const sale  = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
      if (!sale) return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='venta' AND source_id=?").get(saleId)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || (fallback ? db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id : null);

      const cashAccId  = getAccId('account_cash',       '1101');
      const bankAccId  = getAccId('account_bank',       '1103');
      const arAccId    = getAccId('account_ar',         '1104');
      const revAccId   = getAccId('account_revenue',    '4101');
      const taxAccId   = getAccId('account_tax_payable','2102');
      const cogsAccId  = getAccId('account_cogs',       '5101');
      const invAccId   = getAccId('account_inventory',  '1105');

      const lines = [];
      const method = sale.payment_method || 'efectivo';

      // Débito: qué recibimos
      let debitAccId = cashAccId;
      if (method === 'transferencia') debitAccId = bankAccId;
      else if (method === 'tarjeta')  debitAccId = bankAccId;
      else if (method === 'credito')  debitAccId = arAccId;

      if (debitAccId) {
        lines.push({ account_id: debitAccId, debit: sale.total, credit: 0, description: `Venta #${saleId}` });
      }

      // Crédito: ingresos (neto sin ITBIS)
      const netSale = sale.total - (sale.tax_amt || 0);
      if (revAccId && netSale > 0) {
        lines.push({ account_id: revAccId, debit: 0, credit: netSale, description: `Venta #${saleId}` });
      }
      // Crédito: ITBIS por pagar
      if (taxAccId && (sale.tax_amt || 0) > 0) {
        lines.push({ account_id: taxAccId, debit: 0, credit: sale.tax_amt, description: `ITBIS venta #${saleId}` });
      }

      // COGS (costo de venta)
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
      const totalCost = items.reduce((s, i) => s + ((i.unit_cost||0) * (i.qty||1)), 0);
      if (cogsAccId && invAccId && totalCost > 0) {
        lines.push({ account_id: cogsAccId, debit: totalCost, credit: 0, description: `Costo venta #${saleId}` });
        lines.push({ account_id: invAccId, debit: 0, credit: totalCost, description: `Inventario venta #${saleId}` });
      }

      if (lines.length < 2) return null;

      return this.createEntry({
        date:          (sale.created_at || new Date().toISOString()).split('T')[0],
        concept:       `Venta #${saleId} — ${sale.customer_name || 'Consumidor Final'}`,
        reference:     `V-${saleId}`,
        source_module: 'venta',
        source_id:     saleId,
        lines,
        userId,
        status:        'confirmado',
      });
    } catch(e) {
      console.error('[accounting] Error generando asiento de venta:', e.message);
      return null;
    }
  },

  // ── Asiento para gasto ────────────────────
  generateExpenseEntry({ expenseId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;

      const expense = db.prepare('SELECT e.*, ec.name as cat_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE e.id=?').get(expenseId);
      if (!expense || expense.status !== 'pagado') return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='gasto' AND source_id=?").get(expenseId)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;

      const cashAccId = expense.payment_source === 'banco'
        ? getAccId('account_bank', '1103')
        : getAccId('account_cash', '1101');

      // Cuenta de gasto según categoría
      let expAccId = getAccId('account_other_exp', '6120');
      const catName = (expense.cat_name || '').toLowerCase();
      if (catName.includes('alquiler'))    expAccId = getAccId('account_rent',   '6101');
      else if (catName.includes('electric')) expAccId = getAccId('account_elec', '6102');
      else if (catName.includes('internet')) expAccId = getAccId('account_internet','6104');
      else if (catName.includes('sueldo') || catName.includes('nómina') || catName.includes('personal'))
                                             expAccId = getAccId('account_salary','6106');
      else if (catName.includes('combustible')) expAccId = getAccId('account_fuel','6107');

      const lines = [
        { account_id: expAccId, debit: expense.total, credit: 0,             description: expense.description },
        { account_id: cashAccId, debit: 0,             credit: expense.total, description: expense.description },
      ];

      return this.createEntry({
        date:          expense.issue_date || new Date().toISOString().split('T')[0],
        concept:       `Gasto: ${expense.description}`,
        reference:     `G-${expenseId}`,
        source_module: 'gasto',
        source_id:     expenseId,
        lines,
        userId,
        status:        'confirmado',
      });
    } catch(e) {
      console.error('[accounting] Error generando asiento de gasto:', e.message);
      return null;
    }
  },

  // ── Asiento para abono de cliente ─────────
  generatePaymentEntry({ paymentId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;

      const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
      if (!payment) return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='abono' AND source_id=?").get(paymentId)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;

      const cashAccId = payment.method === 'transferencia'
        ? getAccId('account_bank', '1103')
        : getAccId('account_cash', '1101');
      const arAccId = getAccId('account_ar', '1104');

      const lines = [
        { account_id: cashAccId, debit: payment.amount, credit: 0, description: `Abono cliente #${payment.customer_id}` },
        { account_id: arAccId,   debit: 0, credit: payment.amount, description: `Abono cliente #${payment.customer_id}` },
      ];

      return this.createEntry({
        date:          (payment.created_at || new Date().toISOString()).split('T')[0],
        concept:       `Abono de cliente — ${payment.cajero || ''}`,
        reference:     `AB-${paymentId}`,
        source_module: 'abono',
        source_id:     paymentId,
        lines,
        userId,
        status:        'confirmado',
      });
    } catch(e) {
      console.error('[accounting] Error generando asiento de abono:', e.message);
      return null;
    }
  },

  // ── Dashboard contable ────────────────────
  getDashboardStats({ from, to } = {}) {
    const curMonth = new Date().toISOString().slice(0,7);
    const f = from || (curMonth + '-01');
    const t = to   || new Date().toISOString().split('T')[0];

    const getSum = (type, field) => {
      const r = db.prepare(`
        SELECT COALESCE(SUM(l.${field}),0) as v
        FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        JOIN accounting_accounts a ON l.account_id=a.id
        WHERE e.status='confirmado' AND a.type=? AND e.date BETWEEN ? AND ?
      `).get(type, f, t);
      return r.v || 0;
    };

    const totalEntries = db.prepare("SELECT COUNT(*) as c FROM accounting_entries WHERE status='confirmado' AND date BETWEEN ? AND ?").get(f, t).c || 0;
    const pendingEntries = db.prepare("SELECT COUNT(*) as c FROM accounting_entries WHERE status='borrador'").get().c || 0;
    const totalRevenue  = getSum('ingreso', 'credit') - getSum('ingreso', 'debit');
    const totalExpenses = getSum('gasto', 'debit')   - getSum('gasto', 'credit');
    const totalCost     = getSum('costo', 'debit')   - getSum('costo', 'credit');
    const grossProfit   = totalRevenue - totalCost;
    const netIncome     = grossProfit - totalExpenses;

    // Saldos contables clave
    const getAccountBalance = (code) => {
      const acc = db.prepare('SELECT id FROM accounting_accounts WHERE code=?').get(code);
      if (!acc) return 0;
      const r = db.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) as v
        FROM accounting_entry_lines l JOIN accounting_entries e ON l.entry_id=e.id
        WHERE l.account_id=? AND e.status='confirmado'`).get(acc.id);
      return r.v || 0;
    };

    const cashBalance = getAccountBalance('1101');
    const bankBalance = getAccountBalance('1103');
    const arBalance   = getAccountBalance('1104');
    const apBalance   = Math.abs(getAccountBalance('2101'));

    return {
      totalEntries, pendingEntries,
      totalRevenue, totalExpenses, totalCost,
      grossProfit, netIncome,
      cashBalance, bankBalance, arBalance, apBalance,
      period: { from: f, to: t },
    };
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
  // Exportada para auth:login y auth:getSuperPass en main.js
  // Genera la contraseña superadmin per-máquina sin depender de .env
  _deriveSuperAdminPass,
  expensesRepo,
  branchesRepo,
  vehiclesRepo,
  maintenanceRepo,
  deliveriesRepo,
  ncfRepo,
  financialAccountsRepo,
  accountingRepo,
};