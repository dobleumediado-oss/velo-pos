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
const { todayStr, nowStr, addDaysStr } = require('./lib/dates');
const { searchNorm: _searchNorm, digitsOf: _digitsOf } = require('./lib/text-normalize');
const { round2 } = require('./lib/money');

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
  // Si una escritura encuentra la base ocupada, reintenta hasta 5s en vez de
  // fallar de inmediato. Protege operaciones concurrentes (venta + backup, etc).
  db.pragma('busy_timeout = 5000');

  migrateProductsModel();
  createTables();
  migrateECFColumns();
  migrateExpensesColumns();
  migratePaymentsColumns();
  migrateV2IdentityColumns();   // Fase 1 migración v2 (identidad real Equiparts)
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
      model         TEXT DEFAULT '',
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
      created_at      TEXT DEFAULT (datetime('now','localtime'))
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
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id     INTEGER NOT NULL REFERENCES customers(id),
      sale_id         INTEGER REFERENCES sales(id),
      amount          REAL NOT NULL,
      method          TEXT DEFAULT 'efectivo',
      note            TEXT DEFAULT '',
      balance_before  REAL DEFAULT 0,
      balance_after   REAL DEFAULT 0,
      cajero          TEXT DEFAULT '',
      user_id         INTEGER REFERENCES users(id),
      cash_session_id INTEGER REFERENCES cash_sessions(id),
      created_at      TEXT DEFAULT (datetime('now','localtime'))
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
    CREATE INDEX IF NOT EXISTS idx_products_model    ON products(model) WHERE active=1 AND model!='';
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_products_code     ON products(code) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_sales_status      ON sales(status);
    CREATE INDEX IF NOT EXISTS idx_sales_user        ON sales(user_id);
    CREATE INDEX IF NOT EXISTS idx_customers_name    ON customers(name) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_cash_status       ON cash_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_inv_type          ON inventory_movements(type);
    CREATE INDEX IF NOT EXISTS idx_payments_date     ON payments(created_at DESC);
    -- Fase 1: búsqueda de cliente por teléfono (ventas, buscador global)
    CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers(phone) WHERE active=1;
    -- Fase 1: reportes filtran por estado + fecha juntos; compuesto evita escaneo
    CREATE INDEX IF NOT EXISTS idx_sales_status_date ON sales(status, created_at);
  `);
}

// ── Migración: columnas e-CF en sales (segura — ignora si ya existen) ─────────
function migrateProductsModel() {
  try {
    db.prepare("ALTER TABLE products ADD COLUMN model TEXT DEFAULT ''").run();
    console.log('[MIGRATE] products.model agregada');
  } catch { /* ya existe */ }
}

function migratePaymentsColumns() {
  try {
    db.prepare('ALTER TABLE payments ADD COLUMN cash_session_id INTEGER REFERENCES cash_sessions(id)').run();
    console.log('[MIGRATE] payments.cash_session_id agregada');
  } catch { /* ya existe */ }
}

// ── Migración v2: campos de identidad real desde el BAK de Equiparts ──
// Fase 1 del plan de migración v2. Idempotente: try/catch por columna.
// Agrega los números reales (factura, recibo, NCF) para búsqueda nativa,
// más trazabilidad al origen (old_id_*) para deduplicación infalible.
function migrateV2IdentityColumns() {
  // sales: número de factura real + trazabilidad al origen
  const salesCols = [
    { col: 'numero_factura',     def: 'INTEGER' },
    { col: 'numero_factura_fmt', def: 'TEXT' },
    { col: 'old_id_factura',     def: 'INTEGER' },
    { col: 'import_source',      def: 'TEXT' },
  ];
  salesCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE sales ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE v2] sales.${col} agregada`);
    } catch { /* ya existe — ignorar */ }
  });

  // payments: número de recibo visible + trazabilidad al abono origen
  const payCols = [
    { col: 'numero_recibo',       def: 'INTEGER' },
    { col: 'old_id_pago_detalle', def: 'INTEGER' },
    { col: 'import_source',       def: 'TEXT' },
  ];
  payCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE payments ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE v2] payments.${col} agregada`);
    } catch { /* ya existe — ignorar */ }
  });

  // customers: mapa al id_cliente del BAK (conecta ventas y recibos al cliente)
  const custCols = [
    { col: 'old_id_cliente', def: 'INTEGER' },
    { col: 'import_source',  def: 'TEXT' },
  ];
  custCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE customers ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE v2] customers.${col} agregada`);
    } catch { /* ya existe — ignorar */ }
  });

  // Índices para búsqueda rápida por número real (buscador Cmd+K / historial)
  const idx = [
    `CREATE INDEX IF NOT EXISTS idx_sales_numero_factura   ON sales(numero_factura)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_old_id_factura   ON sales(old_id_factura)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_numero_recibo ON payments(numero_recibo)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_old_pd        ON payments(old_id_pago_detalle)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_old_id       ON customers(old_id_cliente)`,
  ];
  idx.forEach(sql => {
    try { db.prepare(sql).run(); }
    catch (e) { console.log('[MIGRATE v2] idx:', e.message); }
  });

  // Índice de NCF: solo si la columna existe (en algunas DBs ncf se agrega
  // por otra migración; verificamos en runtime para no fallar).
  try {
    const salesHasNcf = db.prepare('PRAGMA table_info(sales)').all().some(c => c.name === 'ncf');
    if (salesHasNcf) {
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_sales_ncf ON sales(ncf)`).run();
    } else {
      // Asegurar que ncf exista, luego crear el índice
      try { db.prepare(`ALTER TABLE sales ADD COLUMN ncf TEXT`).run(); } catch { /* ya existe */ }
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_sales_ncf ON sales(ncf)`).run();
    }
  } catch (e) { console.log('[MIGRATE v2] idx ncf:', e.message); }
}

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

// Forma corta usada por los handlers de bancos/contabilidad:
//   audit.log(userId, action, detail)
// Resuelve el nombre del usuario y delega en audit(). Sin esto, `audit.log`
// era undefined y cada llamada lanzaba TypeError (13 sitios en main.js).
// user_id tiene FK a users(id): si no hay usuario, se guarda NULL (no 0).
audit.log = function(userId, action, detail = '') {
  let userName = 'sistema';
  try {
    if (userId) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
      if (u && u.name) userName = u.name;
    }
  } catch {}
  audit(userId || null, userName, action, '', null, detail);
};




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
      INSERT INTO products(code,barcode,name,brand,category,description,model,cost,price,wholesale,stock,stock_min,unit,condition)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(p.code,p.barcode||'',p.name,p.brand||'',p.category||'',p.description||'',
           p.model||'',p.cost,p.price,p.wholesale||p.price,p.stock||0,p.stock_min||5,p.unit||'und',
           p.condition||'nuevo');
    return r.lastInsertRowid;
  },
  update(id, p) {
    db.prepare(`
      UPDATE products SET code=?,barcode=?,name=?,brand=?,category=?,description=?,model=?,
      cost=?,price=?,wholesale=?,stock_min=?,unit=?,condition=?,updated_at=datetime('now')
      WHERE id=?
    `).run(p.code,p.barcode||'',p.name,p.brand||'',p.category||'',p.description||'',
           p.model||'',p.cost,p.price,p.wholesale||p.price,p.stock_min||5,p.unit||'und',
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
    const before = round2(cust.balance);
    if (amount > before + 0.01) throw new Error(`El abono (${amount.toFixed(2)}) supera el balance actual (${before.toFixed(2)})`);
    const after  = Math.max(0, round2((before - amount)));
    const payTx = db.transaction(() => {
      const payInsert = db.prepare(`
        INSERT INTO payments(customer_id,sale_id,amount,method,note,balance_before,balance_after,cajero,user_id,cash_session_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
      `).run(customerId, saleId, amount, method, note||'Abono', before, after, cajero, userId, sessionId || null);
      const paymentId = payInsert.lastInsertRowid;
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
      return { before, after, amount, paymentId };
    });
    return payTx();
  },
  getPayments(customerId) {
    // LEFT JOIN a sales para que la referencia de factura en el historial de
    // abonos muestre el número real (numero_factura_fmt), no el id interno.
    // Alias con prefijo sale_ para no colisionar con columnas de payments.
    return db.prepare(`
      SELECT p.*,
             s.numero_factura     AS sale_numero_factura,
             s.numero_factura_fmt AS sale_numero_factura_fmt,
             s.ncf                AS sale_ncf
      FROM payments p
      LEFT JOIN sales s ON s.id = p.sale_id
      WHERE p.customer_id=?
      ORDER BY p.created_at DESC
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

  /**
   * Calcula el cuadre real de una sesión de caja desde cash_movements,
   * que es la única fuente fiel de lo que entró/salió físicamente.
   * Captura automáticamente: ventas efectivo, la PORCIÓN efectivo de ventas
   * mixtas (registrada como movimiento 'venta'/efectivo aparte), abonos en
   * efectivo de ESTA sesión, devoluciones efectivo (negativas), gastos
   * (salida) y anulaciones de gasto (entrada).
   *
   * Excluye de raíz los abonos históricos de migración: nunca tienen
   * cash_session_id ni generan cash_movement, así que no aparecen aquí.
   *
   * Las ventas anuladas: su movimiento original queda, por eso restamos
   * explícitamente los movimientos cuya venta de referencia esté cancelada.
   *
   * Signos por tipo de movimiento (efecto sobre el efectivo en caja):
   *   venta      → +  (entra)
   *   abono      → +  (entra)
   *   entrada    → +  (reingreso, ej. anulación de gasto)
   *   devolucion → su amount ya viene negativo en la BD → se suma tal cual
   *   salida     → -  (sale, ej. gasto pagado de caja)
   */
  getSessionCashSummary(sessionId) {
    const session = db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(sessionId);
    if (!session) return null;

    // IDs de ventas anuladas de esta sesión (para descontar su movimiento)
    const cancelledSaleIds = db.prepare(
      `SELECT id FROM sales WHERE cash_session_id=? AND status='cancelled'`
    ).all(sessionId).map(r => r.id);
    const cancelledSet = new Set(cancelledSaleIds);

    const movements = db.prepare(
      `SELECT type, amount, method, reference_id FROM cash_movements WHERE cash_session_id=?`
    ).all(sessionId);

    let efectivoNeto = 0;          // solo efectivo físico
    const byMethodIn = {};         // entradas por método (informativo)

    for (const m of movements) {
      const method = (m.method || 'efectivo').toLowerCase();
      const amt = m.amount || 0;

      // Una venta anulada deja su movimiento original: no debe contar.
      if (m.type === 'venta' && m.reference_id && cancelledSet.has(m.reference_id)) {
        continue;
      }

      // Acumular informativo por método (entradas de venta/abono)
      if (m.type === 'venta' || m.type === 'abono') {
        byMethodIn[method] = (byMethodIn[method] || 0) + amt;
      }

      // Efectivo físico: solo movimientos en efectivo afectan el conteo.
      if (method !== 'efectivo') continue;

      if (m.type === 'venta' || m.type === 'abono' || m.type === 'entrada') {
        efectivoNeto += amt;        // entra
      } else if (m.type === 'salida') {
        efectivoNeto -= amt;        // sale (amount positivo)
      } else if (m.type === 'devolucion') {
        efectivoNeto += amt;        // amount ya es negativo en la BD
      }
    }

    const openAmount = session.open_amount || 0;
    const expected   = round2((openAmount + efectivoNeto));

    return {
      sessionId,
      openAmount,
      efectivoNeto: round2(efectivoNeto),
      expected,
      byMethodIn,
      movementCount: movements.length,
    };
  },
};

// ── Ventas ────────────────────────────────────
const salesRepo = {
  // Transacción completa de venta
  create({ session, customer, items, payment, user, type = 'factura' }) {
    const createSaleTx = db.transaction(() => {
      // 1. Calcular totales
      const subtotal   = round2(items.reduce((a, i) => a + i.unit_price * i.qty, 0));
      const discPct    = payment.disc || 0;
      const discAmt    = round2(subtotal * (discPct / 100));
      const base       = round2((subtotal - discAmt));
      const taxPctSetting = db.prepare("SELECT value FROM settings WHERE key='tax_pct'").get();
      const taxPct     = type === 'factura' ? parseFloat(taxPctSetting?.value ?? 18) : 0;
      const taxAmt     = round2(base * (taxPct / 100));
      const total      = round2((base + taxAmt));

      // ¿Esta venta afecta inventario? (descuenta stock). Una sola fuente de
      // verdad para validación Y descuento, así nunca quedan asimétricas.
      // Factura y venta a crédito mueven inventario; la cotización no.
      const afectaStock = (type === 'factura' || payment.method === 'credito');

      // 2. Validar stock (solo si la venta afecta inventario)
      for (const item of items) {
        const prod = db.prepare('SELECT stock,name FROM products WHERE id=?').get(item.product_id);
        if (!prod) throw new Error(`Producto ID ${item.product_id} no existe`);
        if (prod.stock < item.qty && afectaStock) {
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
        if (cust.credit_limit <= 0) {
          throw new Error('Este cliente no tiene límite de crédito configurado — contacte al administrador');
        }
        if (cust.balance + total > cust.credit_limit) {
          throw new Error(`Límite de crédito excedido. Disponible: ${(cust.credit_limit - cust.balance).toFixed(2)}`);
        }
      }

      // 4. Crear venta
      const saleR = db.prepare(`
        INSERT INTO sales(cash_session_id,customer_id,customer_name,customer_rnc,
          type,status,subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,
          payment_method,price_mode,cajero,user_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
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

      // 4b. Generar NCF — SOLO facturas, con fiscal activo Y una secuencia registrada.
      // El comprobante NUNCA se fabrica con un contador interno: proviene
      // exclusivamente de un rango autorizado por la DGII (tabla ncf_sequences).
      // Si no existe una secuencia activa del tipo que corresponde, la factura
      // sale como documento interno SIN NCF (no aparenta un comprobante inexistente).
      // Tipo determinado automáticamente por el documento del cliente:
      //   · RNC de 9 dígitos             → B01 (Crédito Fiscal)
      //   · Cédula de 11 díg. o sin doc  → B02 (Consumo)
      let ncf = '';
      if (type === 'factura') {
        const fiscalOn = db.prepare("SELECT value FROM settings WHERE key='fiscal_enabled'").get()?.value === '1';
        if (fiscalOn) {
          const docDigits = String(customer.rnc || '').replace(/\D/g, '');
          const ncfType   = docDigits.length === 9 ? 'B01' : 'B02';
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
            db.prepare("UPDATE sales SET ncf=? WHERE id=?").run(ncf, saleId);
          } else {
            // Sin secuencia registrada para este tipo → factura sin comprobante fiscal.
            console.warn('[NCF] Sin secuencia registrada para ' + ncfType +
              ' — factura #' + saleId + ' sale sin NCF. Registra el rango en el Panel NCF.');
          }
        }
      }

      // 5. Insertar items con snapshot
      for (const item of items) {
        db.prepare(`
          INSERT INTO sale_items(sale_id,product_id,product_code,product_name,unit_cost,unit_price,qty,subtotal)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(saleId, item.product_id, item.product_code, item.product_name,
               item.unit_cost, item.unit_price, item.qty, item.unit_price * item.qty);

        // 6. Descontar stock (misma condición que la validación: afectaStock)
        if (afectaStock) {
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
    // Para notas de crédito (devoluciones con B04): adjuntar el NCF y el número
    // real de la factura original que esta nota modifica, para poder mostrarlos
    // en la impresión (la referencia "Ref. venta original" usa el número real,
    // no el id interno).
    if (sale.type === 'devolucion' && sale.original_sale_id) {
      const orig = db.prepare('SELECT ncf, numero_factura, numero_factura_fmt FROM sales WHERE id=?').get(sale.original_sale_id);
      sale.modifies_ncf = (orig && orig.ncf) ? orig.ncf : '';
      sale.original_numero_factura     = orig ? orig.numero_factura     : null;
      sale.original_numero_factura_fmt = orig ? orig.numero_factura_fmt : null;
    }
    return sale;
  },

  getAll({ range = 'today', customerId, method, limit = 200, offset = 0 } = {}) {
    let where = "WHERE s.status != 'cancelled'";
    const params = [];
    // Filtrar SOLO por fecha real, nunca por origen (cajero): una venta
    // importada con fecha del mes cuenta como venta del mes.
    if (range === 'today') {
      where += ` AND date(s.created_at)=date('now','localtime')`;
    } else if (range === 'week') {
      where += ` AND date(s.created_at)>=date('now','-7 days','localtime')`;
    } else if (range === 'month') {
      where += ` AND strftime('%Y-%m',s.created_at)=strftime('%Y-%m','now','localtime')`;
    }
    if (customerId) { where += ' AND s.customer_id=?'; params.push(customerId); }
    if (method)     { where += ' AND s.payment_method=?'; params.push(method); }
    // Paginación real: LIMIT + OFFSET. offset=0 por defecto mantiene el
    // comportamiento anterior (primera página) sin romper llamadas existentes.
    params.push(limit, offset);
    return db.prepare(`
      SELECT s.*,
             GROUP_CONCAT(si.product_name || ' x' || si.qty, ' | ') as items_summary,
             COALESCE(SUM(si.unit_cost * si.qty), 0) as cost_total,
             orig.numero_factura     AS original_numero_factura,
             orig.numero_factura_fmt AS original_numero_factura_fmt
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN sales orig    ON orig.id = s.original_sale_id
      ${where}
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT ? OFFSET ?
    `).all(...params);
  },

  /**
   * Cuenta el total de ventas que coinciden con un filtro (sin traer filas).
   * Permite al frontend saber cuántas páginas hay para la paginación real.
   */
  countAll({ range = 'today', customerId, method } = {}) {
    let where = "WHERE status != 'cancelled'";
    const params = [];
    // Filtrar SOLO por fecha real, nunca por origen (coherente con getAll).
    if (range === 'today') {
      where += ` AND date(created_at)=date('now','localtime')`;
    } else if (range === 'week') {
      where += ` AND date(created_at)>=date('now','-7 days','localtime')`;
    } else if (range === 'month') {
      where += ` AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime')`;
    }
    if (customerId) { where += ' AND customer_id=?'; params.push(customerId); }
    if (method)     { where += ' AND payment_method=?'; params.push(method); }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM sales ${where}`).get(...params);
    return row ? row.n : 0;
  },

  /**
   * Búsqueda global de ventas sobre TODO el historial (incluidas las
   * ventas de importación histórica y de cualquier fecha). Pensado para el
   * buscador global (Cmd+K), que antes solo veía las ventas de hoy en memoria.
   *
   * Trae un conjunto amplio de candidatos por SQL (rápido, con índices) y
   * luego filtra con normalización de tildes/Ñ en JS, igual que el resto
   * del sistema. Limita el resultado para no saturar la UI.
   */
  search(q, limit = 8) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];

    const qNorm   = _searchNorm(term);
    const qDigits = _digitsOf(term);
    const idNum   = parseInt(term, 10);
    // Término solo-dígitos sin '#' ni ceros a la izquierda, para casar
    // numero_factura (ej. "#02449", "02449" y "2449" → 2449).
    const termNoHash = term.replace(/^#/, '').trim();
    const facNum = parseInt(termNoHash, 10);

    // Candidatos por SQL: por id exacto, o LIKE amplio en los campos de texto
    // y en los nombres de producto de los items. El LIKE usa el término crudo
    // en minúsculas; el filtro fino con tildes se hace después en JS.
    const like = `%${term.toLowerCase()}%`;
    const likeNoHash = `%${termNoHash.toLowerCase()}%`;
    const rows = db.prepare(`
      SELECT s.*,
             GROUP_CONCAT(si.product_name || ' x' || si.qty, ' | ') as items_summary,
             c.phone AS _cust_phone,
             (SELECT GROUP_CONCAT(p.numero_recibo, ',') FROM payments p WHERE p.sale_id = s.id) AS _recibos
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN customers c   ON c.id = s.customer_id
      WHERE s.status != 'cancelled'
        AND (
          s.id = ?
          OR s.numero_factura = ?
          OR lower(s.numero_factura_fmt) LIKE ?
          OR lower(s.ncf)           LIKE ?
          OR lower(s.customer_name) LIKE ?
          OR lower(s.customer_rnc)  LIKE ?
          OR lower(s.notes)         LIKE ?
          OR lower(si.product_name) LIKE ?
          OR lower(si.product_code) LIKE ?
          OR lower(c.phone)         LIKE ?
          OR EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND CAST(p.numero_recibo AS TEXT) LIKE ?)
        )
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT 300
    `).all(
      Number.isFinite(idNum) ? idNum : -1,
      Number.isFinite(facNum) ? facNum : -1,
      likeNoHash, like, like, like, like, like, like, like, likeNoHash
    );

    // Filtro fino con normalización de tildes/Ñ y dígitos con guarda.
    const matchText   = (hay) => !qNorm   || _searchNorm(hay).includes(qNorm);
    const matchDigits = (hay) => !!qDigits && _digitsOf(hay).includes(qDigits);

    const filtered = rows.filter(s =>
      String(s.id) === term ||
      String(s.id).includes(term) ||
      (Number.isFinite(facNum) && s.numero_factura === facNum) ||
      matchText(s.numero_factura_fmt) ||
      matchDigits(s.numero_factura_fmt) ||
      matchText(s.ncf) ||
      matchText(s.customer_name) ||
      matchText(s.customer_rnc) ||
      matchDigits(s.customer_rnc) ||
      matchDigits(s._cust_phone) ||
      matchDigits(s._recibos) ||
      matchText(s.notes) ||
      matchText(s.items_summary)
    );

    // Limpiar los campos auxiliares antes de devolver
    return filtered.slice(0, limit).map(({ _cust_phone, _recibos, ...rest }) => rest);
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

      // Fiscal: si la venta tenía un NCF, marcarlo como anulado en ncf_log para que
      // aparezca en el reporte 608 (comprobantes anulados). Aplica a facturas (B01/B02…)
      // y también a notas de crédito B04 si alguna vez se anula una devolución.
      if (sale.ncf && String(sale.ncf).trim()) {
        db.prepare(`UPDATE ncf_log SET status='anulado', voided_at=datetime('now')
                    WHERE sale_id=? AND ncf=? AND status!='anulado'`).run(id, String(sale.ncf).trim());
      }

      // Reponer stock
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
      for (const item of items) {
        if (sale.type === 'factura' || sale.payment_method === 'credito') {
          productsRepo.adjustStock(item.product_id, item.qty, 'devolucion',
            `Anulación venta #${id}`, id, userId);
        }
      }

      // Si era crédito, revertir balance y calcular overpayment
      let overpayment = 0;
      if (sale.payment_method === 'credito' && sale.customer_id !== 1) {
        const cust = db.prepare('SELECT balance FROM customers WHERE id=?').get(sale.customer_id);
        const theoretical = (cust?.balance || 0) - sale.total;
        overpayment = Math.max(0, round2(-theoretical));
        const newBal = Math.max(0, round2(theoretical));
        db.prepare('UPDATE customers SET balance=? WHERE id=?').run(newBal, sale.customer_id);
      }

      audit(userId, userName, 'venta_anulada', 'sales', id, `Motivo: ${reason}`);
      return { overpayment };
    });

    return cancelTx();
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
          withAlias:    { sql: `date(s.created_at) BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
          withoutAlias: { sql: `date(created_at)   BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
          payments:     { sql: `date(created_at)   BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
        };
      }
      if (range === 'month') return {
        withAlias:    { sql: `strftime('%Y-%m',s.created_at) = strftime('%Y-%m','now','localtime')`, params: [] },
        withoutAlias: { sql: `strftime('%Y-%m',created_at)   = strftime('%Y-%m','now','localtime')`, params: [] },
        payments:     { sql: `strftime('%Y-%m',created_at)   = strftime('%Y-%m','now','localtime')`, params: [] },
      };
      if (range === 'week') return {
        withAlias:    { sql: `date(s.created_at) >= date('now','-6 days','localtime')`, params: [] },
        withoutAlias: { sql: `date(created_at)   >= date('now','-6 days','localtime')`, params: [] },
        payments:     { sql: `date(created_at)   >= date('now','-6 days','localtime')`, params: [] },
      };
      if (range === 'all') return {
        withAlias:    { sql: `1=1`, params: [] },
        withoutAlias: { sql: `1=1`, params: [] },
        payments:     { sql: `1=1`, params: [] },
      };
      // today (default)
      return {
        withAlias:    { sql: `date(s.created_at) = date('now','localtime')`, params: [] },
        withoutAlias: { sql: `date(created_at)   = date('now','localtime')`, params: [] },
        payments:     { sql: `date(created_at)   = date('now','localtime')`, params: [] },
      };
    };

    const f = _buildFilters();

    // Regla contable: filtrar SOLO por fecha real, NUNCA por origen.
    // Una venta cuenta una vez, en su fecha, por su total — sin importar si
    // vino del POS o de una importación histórica. El filtro de fecha (f) ya
    // restringe a la ventana correcta (today/month/week/custom/all), así que
    // una factura importada con fecha del mes actual SÍ debe contar en el mes,
    // y una de 2020 NO aparece en 'month' simplemente porque su fecha no cae.
    // Esto evita ocultar ventas reales recientes y evita doble conteo:
    //   ventas = devengado (por total) · abonos = caja · CxC = saldo acumulado.
    const hf  = '';
    const hfs = '';
    const hfp = '';

    // Ventas por método de pago
    const byMethod = db.prepare(`
      SELECT payment_method, COUNT(*) as count,
             SUM(total) as total, SUM(tax_amt) as tax,
             SUM(discount_amt) as discount
      FROM sales
      WHERE status='completed' AND type != 'devolucion'
        ${hf} AND ${f.withoutAlias.sql}
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
      WHERE s.status='completed' AND s.type != 'devolucion'
        ${hfs} AND ${f.withAlias.sql}
    `).get(...f.withAlias.params);

    // Devoluciones
    const devData = db.prepare(`
      SELECT COUNT(*) as count, SUM(total) as total
      FROM sales
      WHERE type='devolucion' ${hf}
        AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // Descuentos totales
    const discData = db.prepare(`
      SELECT SUM(discount_amt) as total_discount
      FROM sales
      WHERE status='completed' AND type != 'devolucion'
        ${hf} AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // ITBIS total
    const taxData = db.prepare(`
      SELECT SUM(tax_amt) as total_tax
      FROM sales
      WHERE status='completed' AND type != 'devolucion'
        ${hf} AND ${f.withoutAlias.sql}
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
      WHERE s.status='completed' AND s.type != 'devolucion'
        ${hfs} AND ${f.withAlias.sql}
      GROUP BY si.product_id
      ORDER BY total_rev DESC LIMIT 10
    `).all(...f.withAlias.params);

    // Ventas por día (últimos 30 o en rango)
    const dailySales = db.prepare(`
      SELECT date(s.created_at) as day,
             COUNT(*) as count,
             SUM(s.total) as total,
             SUM(si.unit_cost * si.qty) as cost
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.status='completed' AND s.type != 'devolucion'
        ${hfs} AND ${f.withAlias.sql}
      GROUP BY day
      ORDER BY day ASC
    `).all(...f.withAlias.params);

    // Abonos recibidos en el período (excluir saldos iniciales importados)
    // Usa hfp: excluye históricos solo en 'today', no en 'month'
    const abonosData = db.prepare(`
      SELECT COUNT(*) as count, SUM(amount) as total
      FROM payments
      WHERE ${f.payments.sql}
        AND note != 'Saldo inicial importado' ${hfp}
    `).get(...f.payments.params);

    // Desglose contado vs crédito (para cobradoMes)
    const contadoCreditoData = db.prepare(`
      SELECT
        SUM(CASE WHEN payment_method != 'credito' THEN total ELSE 0 END) as ventas_contado,
        SUM(CASE WHEN payment_method  = 'credito' THEN total ELSE 0 END) as ventas_credito
      FROM sales
      WHERE status='completed' AND type != 'devolucion'
        ${hf} AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    const totalRev      = byMethod.reduce((a, m) => a + (m.total || 0), 0);
    const totalCost     = costData?.total_cost   || 0;
    const totalTax      = taxData?.total_tax      || 0;
    const totalDisc     = discData?.total_discount || 0;
    const totalUnits    = costData?.total_units    || 0;
    const totalSales    = costData?.total_sales    || 0;
    const netRev        = totalRev - totalTax;
    // Utilidad bruta REAL = ingreso sin ITBIS − costo. El ITBIS no es ganancia
    // del negocio (se le debe a la DGII), por eso se excluye del cálculo.
    const grossProfit   = round2((netRev - totalCost));
    // Margen sobre el ingreso neto (sin impuesto), criterio contable correcto.
    const margin        = netRev > 0 ? (grossProfit / netRev) * 100 : 0;
    const ventasContado = contadoCreditoData?.ventas_contado || 0;
    const ventasCredito = contadoCreditoData?.ventas_credito || 0;
    // cobradoMes = dinero real recibido: ventas al contado + abonos de CxC
    const cobradoMes    = ventasContado + (abonosData?.total || 0);

    // ── Métricas NETAS de devoluciones (adicionales) ──
    // grossProfit ya excluye ITBIS (utilidad real). Estos campos además
    // descuentan las devoluciones del período para quien quiera el neto final.
    const totalDevol      = devData?.total || 0;
    const totalRevNeto    = round2((totalRev - totalDevol));
    const grossProfitNeto = round2((grossProfit - totalDevol));
    const marginNeto      = totalRevNeto > 0 ? (grossProfitNeto / totalRevNeto) * 100 : 0;

    return {
      byMethod,
      totalRev, totalCost, totalTax, totalDisc,
      totalUnits, totalSales,
      grossProfit, netRev, margin,
      // Netos de devoluciones (opcionales para reportes)
      totalRevNeto, grossProfitNeto, marginNeto,
      topProducts,
      dailySales,
      devolucion:   { count: devData?.count || 0, total: totalDevol },
      abonos:       { count: abonosData?.count || 0, total: abonosData?.total || 0 },
      ventasContado, ventasCredito, cobradoMes,
    };
  },

  paymentsHistory({ range = 'month', dateFrom = null, dateTo = null } = {}) {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const safeFrom = (range === 'custom' && dateFrom && DATE_RE.test(dateFrom)) ? dateFrom : null;
    const safeTo   = (range === 'custom' && dateTo   && DATE_RE.test(dateTo))   ? dateTo   : null;

    const buildFilter = () => {
      if (range === 'custom' && safeFrom && safeTo) {
        return { sql: `date(p.created_at) BETWEEN ? AND ?`, params: [safeFrom, safeTo] };
      }
      if (range === 'today') {
        return { sql: `date(p.created_at) = date('now','localtime')`, params: [] };
      }
      if (range === 'week') {
        return { sql: `date(p.created_at) >= date('now','-6 days','localtime')`, params: [] };
      }
      if (range === 'all') {
        return { sql: `1=1`, params: [] };
      }
      return {
        sql: `strftime('%Y-%m',p.created_at) = strftime('%Y-%m','now','localtime')`,
        params: [],
      };
    };

    const f = buildFilter();
    const baseWhere = `${f.sql} AND COALESCE(p.note,'') != 'Saldo inicial importado'`;

    const rows = db.prepare(`
      SELECT p.*,
             c.name AS customer_name,
             c.rnc  AS customer_rnc,
             s.total AS sale_total,
             s.created_at AS sale_created_at,
             s.numero_factura     AS sale_numero_factura,
             s.numero_factura_fmt AS sale_numero_factura_fmt,
             s.ncf                AS sale_ncf,
             CASE WHEN p.cajero='Importación histórica' THEN 1 ELSE 0 END AS imported
      FROM payments p
      LEFT JOIN customers c ON c.id = p.customer_id
      LEFT JOIN sales s ON s.id = p.sale_id
      WHERE ${baseWhere}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 5000
    `).all(...f.params);

    const byDay = db.prepare(`
      SELECT date(p.created_at) AS day,
             COUNT(*) AS count,
             COALESCE(SUM(p.amount),0) AS total,
             SUM(CASE WHEN p.cajero='Importación histórica' THEN p.amount ELSE 0 END) AS imported_total,
             SUM(CASE WHEN p.cajero!='Importación histórica' THEN p.amount ELSE 0 END) AS current_total
      FROM payments p
      WHERE ${baseWhere}
      GROUP BY day
      ORDER BY day DESC
      LIMIT 370
    `).all(...f.params);

    const byMonth = db.prepare(`
      SELECT strftime('%Y-%m',p.created_at) AS month,
             COUNT(*) AS count,
             COALESCE(SUM(p.amount),0) AS total,
             SUM(CASE WHEN p.cajero='Importación histórica' THEN p.amount ELSE 0 END) AS imported_total,
             SUM(CASE WHEN p.cajero!='Importación histórica' THEN p.amount ELSE 0 END) AS current_total
      FROM payments p
      WHERE ${baseWhere}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 120
    `).all(...f.params);

    const byMethod = db.prepare(`
      SELECT COALESCE(p.method,'efectivo') AS method,
             COUNT(*) AS count,
             COALESCE(SUM(p.amount),0) AS total
      FROM payments p
      WHERE ${baseWhere}
      GROUP BY method
      ORDER BY total DESC
    `).all(...f.params);

    const summary = db.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(p.amount),0) AS total,
             SUM(CASE WHEN p.cajero='Importación histórica' THEN p.amount ELSE 0 END) AS imported_total,
             SUM(CASE WHEN p.cajero!='Importación histórica' THEN p.amount ELSE 0 END) AS current_total,
             COUNT(DISTINCT p.customer_id) AS customers
      FROM payments p
      WHERE ${baseWhere}
    `).get(...f.params);

    return {
      summary: {
        count: summary?.count || 0,
        total: summary?.total || 0,
        importedTotal: summary?.imported_total || 0,
        currentTotal: summary?.current_total || 0,
        customers: summary?.customers || 0,
      },
      byDay,
      byMonth,
      byMethod,
      rows,
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
        AND (credit_due IS NULL OR credit_due <= date('now','+5 days','localtime'))
      ORDER BY credit_due ASC
    `).all();
  },

  dailyTrend({ days = 30, includeHistorical = true } = {}) {
    return db.prepare(`
      SELECT date(s.created_at) as day,
             COUNT(DISTINCT s.id) as count,
             SUM(s.total) as total,
             SUM(s.tax_amt) as tax,
             SUM(si.unit_cost * si.qty) as cost
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.status='completed' AND s.type != 'devolucion'
        AND date(s.created_at) >= date('now','-'||?||' days','localtime')
        AND (? = 1 OR s.cajero != 'Importación histórica')
      GROUP BY day
      ORDER BY day ASC
    `).all(days, includeHistorical ? 1 : 0);
  },

  monthlyTrend({ months = 12, includeHistorical = true } = {}) {
    return db.prepare(`
      SELECT strftime('%Y-%m', s.created_at) as month,
             COUNT(DISTINCT s.id) as count,
             SUM(s.total) as total,
             SUM(s.tax_amt) as tax
      FROM sales s
      WHERE s.status='completed' AND s.type != 'devolucion'
        AND date(s.created_at) >= date('now','-'||?||' months','localtime')
        AND (? = 1 OR s.cajero != 'Importación histórica')
      GROUP BY month
      ORDER BY month ASC
    `).all(months, includeHistorical ? 1 : 0);
  },
};


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
      // Blindaje: solo se devuelven facturas/ventas a crédito (las que descontaron
      // stock). Las cotizaciones nunca movieron inventario ni dinero.
      if (original.type === 'cotizacion') {
        throw new Error('No se puede devolver una cotización');
      }
      if (original.type === 'devolucion') {
        throw new Error('No se puede devolver una devolución');
      }

      // 2. Verificar que los items a devolver existen en la venta original
      const originalItems = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(originalSaleId);

      // 2b. Calcular cuánto ya se devolvió antes de esta venta, por producto.
      // Suma las cantidades de TODAS las devoluciones previas de esta factura
      // para impedir devolver más de lo realmente vendido en varias tandas.
      const prevReturns = db.prepare(`
        SELECT si.product_id, COALESCE(SUM(si.qty),0) AS devuelto
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE s.type='devolucion' AND s.original_sale_id=? AND s.status != 'cancelled'
        GROUP BY si.product_id
      `).all(originalSaleId);
      const yaDevuelto = {};
      prevReturns.forEach(r => { yaDevuelto[r.product_id] = r.devuelto || 0; });

      for (const item of items) {
        const orig = originalItems.find(oi => oi.product_id === item.product_id);
        if (!orig) throw new Error(`Producto ID ${item.product_id} no pertenece a esta venta`);
        const yaDev = yaDevuelto[item.product_id] || 0;
        const disponible = orig.qty - yaDev;
        if (item.qty > disponible) {
          throw new Error(
            `Cantidad a devolver (${item.qty}) supera lo disponible para "${orig.product_name}". ` +
            `Vendido: ${orig.qty}, ya devuelto: ${yaDev}, disponible: ${disponible}.`
          );
        }
      }

      // 3. Calcular totales de la devolución (usando precios históricos del snapshot)
      const subtotal = round2(items.reduce((a, i) => a + i.unit_price * i.qty, 0));
      const taxPct   = original.tax_pct || 0;
      const taxAmt   = round2(subtotal * (taxPct / 100));
      const total    = round2((subtotal + taxAmt));

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
      let overpayment = 0;
      if (original.payment_method === 'credito' && original.customer_id !== 1) {
        const cust = db.prepare('SELECT balance FROM customers WHERE id=?').get(original.customer_id);
        if (cust) {
          const theoretical = (cust.balance || 0) - total;
          overpayment = Math.max(0, round2(-theoretical));
          const newBal = Math.max(0, round2(theoretical));
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

      // 8. Marcar venta original como 'returned' solo si TODOS sus productos quedaron
      // completamente devueltos, sumando ESTA devolución con las anteriores (yaDevuelto).
      // Antes solo miraba los items de la tanda actual, así que devoluciones parciales
      // en varias tandas nunca marcaban la venta como devuelta.
      const currentReturn = {};
      for (const i of items) currentReturn[i.product_id] = (currentReturn[i.product_id] || 0) + i.qty;
      const allReturned = originalItems.every(oi => {
        const totalDevuelto = (yaDevuelto[oi.product_id] || 0) + (currentReturn[oi.product_id] || 0);
        return totalDevuelto >= oi.qty;
      });
      if (allReturned) {
        db.prepare(`UPDATE sales SET status='returned' WHERE id=?`).run(originalSaleId);
      }

      // 8b. Nota de crédito B04 — SOLO si la factura original tenía NCF y el modo
      // fiscal está activo. La DGII exige un B04 que referencie el NCF modificado.
      // Igual que en la emisión de ventas, el B04 proviene EXCLUSIVAMENTE de una
      // secuencia registrada; nunca se fabrica con contador interno. Sin secuencia
      // B04 registrada, la nota de crédito sale sin NCF (documento interno).
      let ncfNota = '';
      if (original.ncf && String(original.ncf).trim()) {
        const fiscalOn = db.prepare("SELECT value FROM settings WHERE key='fiscal_enabled'").get()?.value === '1';
        if (fiscalOn) {
          const seq = db.prepare(
            "SELECT * FROM ncf_sequences WHERE type='B04' AND active=1 AND current < to_num ORDER BY id ASC LIMIT 1"
          ).get();
          if (seq) {
            const next = seq.current + 1;
            db.prepare("UPDATE ncf_sequences SET current=? WHERE id=?").run(next, seq.id);
            ncfNota = seq.prefix + String(next).padStart(8, '0');
            const remaining = seq.to_num - next;
            if (remaining <= (seq.alert_at || 50)) console.log('[NCF] ALERTA: quedan ' + remaining + ' notas de crédito B04');
          } else {
            console.warn('[NCF] Sin secuencia B04 registrada — nota de crédito #' + returnId +
              ' sin NCF. Registra un rango B04 en el Panel NCF.');
          }
          if (ncfNota) {
            db.prepare("UPDATE sales SET ncf=? WHERE id=?").run(ncfNota, returnId);
            db.prepare("INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc,modifies_ncf) VALUES(?,?,?,?,?)")
              .run(ncfNota, 'B04', returnId, original.customer_rnc || '', String(original.ncf).trim());
          }
        }
      }

      // 9. Auditoría
      audit(user.id, user.name, 'devolucion_procesada', 'sales', returnId,
        `Venta original #${originalSaleId} | Total devuelto: ${total} | Items: ${items.length}${ncfNota ? ' | NC B04: ' + ncfNota : ''}`);

      return { returnId, total, subtotal, taxAmt, overpayment, ncf: ncfNota, modifies_ncf: ncfNota ? String(original.ncf).trim() : '' };
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
              costoPromedio = round2(costoPromedio);
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
      db.prepare("UPDATE expenses SET paid_amount=?,status=?,updated_at=datetime('now'),cash_session_id=?,cash_movement_id=? WHERE id=?")
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
    db.prepare("UPDATE expenses SET status=?,approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
      .run('aprobado', userId, expenseId);
    audit(userId, userName, 'gasto_aprobado', 'expenses', expenseId, '');
    return { ok: true };
  },

  // ── Rechazar gasto ───────────────────────
  reject(expenseId, userId, userName, reason) {
    db.prepare("UPDATE expenses SET status=?,cancel_reason=?,cancelled_by=?,cancelled_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
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
      db.prepare("UPDATE expenses SET status=?,cancel_reason=?,cancelled_by=?,cancelled_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
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
    return { gallons: round2(gallons), cost: round2(cost),
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
  // ── Log de comprobantes (base para reportes 607/608) ──────────────────────
  // status: 'emitido' (default) | 'anulado'. Filtros de fecha sobre issued_at.
  getLog({ from, to, status, type } = {}) {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let q = `SELECT l.*, s.total, s.customer_name FROM ncf_log l
             LEFT JOIN sales s ON l.sale_id = s.id WHERE 1=1`;
    const p = [];
    if (from && DATE_RE.test(from)) { q += ` AND date(l.issued_at) >= ?`; p.push(from); }
    if (to   && DATE_RE.test(to))   { q += ` AND date(l.issued_at) <= ?`; p.push(to); }
    if (status)                     { q += ` AND COALESCE(l.status,'emitido') = ?`; p.push(status); }
    if (type)                       { q += ` AND l.type = ?`; p.push(type); }
    q += ` ORDER BY l.issued_at DESC, l.id DESC`;
    return db.prepare(q).all(...p);
  },
  // 608: comprobantes anulados en el período.
  getVoided({ from, to } = {}) { return this.getLog({ from, to, status: 'anulado' }); },
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

      // Enlaza las dos patas (out/in) para poder anularlas SIEMPRE juntas y no
      // descuadrar los saldos si se anula una transferencia. Ver cancelMovement.
      const group = `TR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      db.prepare(`INSERT INTO financial_movements(financial_account_id,type,amount,balance_before,
        balance_after,description,related_account_id,notes,user_id,transfer_group)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(fromId, 'transferencia_out', amt, fromBefore, fromAfter, desc, toId, notes||'', userId||null, group);
      db.prepare(`INSERT INTO financial_movements(financial_account_id,type,amount,balance_before,
        balance_after,description,related_account_id,notes,user_id,transfer_group)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(toId, 'transferencia_in', amt, toBefore, toAfter, descTo, fromId, notes||'', userId||null, group);

      return { ok: true, fromBalance: fromAfter, toBalance: toAfter };
    })();
  },
  cancelMovement(movementId, cancelledBy, reason) {
    return db.transaction(() => {
      const mov = db.prepare('SELECT * FROM financial_movements WHERE id=?').get(movementId);
      if (!mov) throw new Error('Movimiento no encontrado');
      if (mov.status === 'anulado') throw new Error('Ya está anulado');

      const revertLeg = (m) => {
        const acc = db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(m.financial_account_id);
        const outflow = ['transferencia_out', 'retiro', 'gasto', 'pago_proveedor'].includes(m.type);
        const newBal = outflow ? acc.current_balance + m.amount : acc.current_balance - m.amount;
        db.prepare(`UPDATE financial_accounts SET current_balance=?,updated_at=datetime('now') WHERE id=?`)
          .run(newBal, m.financial_account_id);
        db.prepare(`UPDATE financial_movements SET status='anulado',cancelled_by=?,cancel_reason=?,
          cancelled_at=datetime('now') WHERE id=?`).run(cancelledBy, reason || '', m.id);
      };

      // Una transferencia son DOS movimientos (out/in). Anular uno solo dejaría el
      // otro vivo y descuadraría el total → se anulan SIEMPRE juntos por transfer_group.
      const isTransferLeg = mov.type === 'transferencia_out' || mov.type === 'transferencia_in';
      if (isTransferLeg) {
        if (!mov.transfer_group) {
          // Transferencia anterior a v1.11.2: sus patas no están enlazadas, así que no
          // se puede anular con seguridad por una sola. Para revertirla, hacer una
          // transferencia inversa por el mismo monto. Bloquear evita corromper saldos.
          throw new Error('Esta transferencia es anterior a la actualización y no puede anularse por una sola pata. Para revertirla, realiza una transferencia inversa por el mismo monto.');
        }
        const legs = db.prepare(
          "SELECT * FROM financial_movements WHERE transfer_group=? AND status!='anulado'"
        ).all(mov.transfer_group);
        for (const leg of legs) revertLeg(leg);
        return { ok: true, transferReversed: true, legs: legs.length };
      }

      // Movimiento simple: revertir su saldo según el tipo.
      revertLeg(mov);
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
// REPOSITORIO: CONCILIACIÓN BANCARIA (Fase 5)
// ══════════════════════════════════════════════
// Coteja las líneas de un extracto bancario importado contra los movimientos
// registrados en la cuenta. El monto de un movimiento se guarda positivo; el
// signo lo da el `type`. El extracto trae monto con signo (+ ingreso, − egreso).
const bankReconRepo = {
  _sign(type) {
    if (['deposito','transferencia_in','venta','abono_recibido','apertura'].includes(type)) return 1;
    if (['retiro','transferencia_out','gasto','pago_proveedor'].includes(type)) return -1;
    return 1; // ajuste u otros: asumir ingreso (caso raro)
  },
  signedAmount(m) { return this._sign(m.type) * Math.abs(m.amount || 0); },
  _daysBetween(a, b) {
    const da = new Date(a), db2 = new Date(b);
    if (isNaN(da) || isNaN(db2)) return 9999;
    return Math.round((da - db2) / 86400000);
  },

  // Importa líneas del extracto. Dedup por (cuenta, bank_ref+monto) o, sin ref,
  // por (cuenta, fecha+monto+descripción) → re-importar el mismo archivo no duplica.
  importStatement({ accountId, lines, batch }) {
    return db.transaction(() => {
      const acc = db.prepare('SELECT id FROM financial_accounts WHERE id=?').get(accountId);
      if (!acc) throw new Error('Cuenta no encontrada');
      const b = batch || ('IMP-' + Date.now());
      const ins = db.prepare(`INSERT INTO bank_statement_lines
        (financial_account_id,date,description,amount,bank_ref,import_batch) VALUES(?,?,?,?,?,?)`);
      let inserted = 0, skipped = 0;
      for (const l of (lines || [])) {
        const date   = String(l.date || '').slice(0, 10);
        const amount = Math.round((parseFloat(l.amount) || 0) * 100) / 100;
        const desc   = String(l.description || '').trim();
        const ref    = String(l.bank_ref || '').trim();
        if (!amount) { skipped++; continue; }
        const dup = ref
          ? db.prepare("SELECT id FROM bank_statement_lines WHERE financial_account_id=? AND bank_ref=? AND ABS(amount-?)<0.01").get(accountId, ref, amount)
          : db.prepare("SELECT id FROM bank_statement_lines WHERE financial_account_id=? AND date=? AND ABS(amount-?)<0.01 AND description=?").get(accountId, date, amount, desc);
        if (dup) { skipped++; continue; }
        ins.run(accountId, date, desc, amount, ref, b);
        inserted++;
      }
      return { inserted, skipped, batch: b };
    })();
  },

  // Auto-conciliación: monto con signo exacto y fecha dentro de ±windowDays.
  autoMatch({ accountId, windowDays = 4 } = {}) {
    return db.transaction(() => {
      const lines = db.prepare("SELECT * FROM bank_statement_lines WHERE financial_account_id=? AND status='pendiente' ORDER BY date ASC, id ASC").all(accountId);
      const movs  = db.prepare("SELECT * FROM financial_movements WHERE financial_account_id=? AND status='activo' AND COALESCE(reconciled,0)=0").all(accountId);
      const used = new Set();
      let matched = 0;
      for (const line of lines) {
        const cand = movs.find(m => !used.has(m.id)
          && Math.abs(this.signedAmount(m) - line.amount) < 0.01
          && Math.abs(this._daysBetween(String(m.created_at).slice(0, 10), line.date)) <= windowDays);
        if (cand) {
          used.add(cand.id);
          db.prepare("UPDATE bank_statement_lines SET status='conciliado',matched_movement_id=?,match_type='auto' WHERE id=?").run(cand.id, line.id);
          db.prepare("UPDATE financial_movements SET reconciled=1,reconciled_at=datetime('now') WHERE id=?").run(cand.id);
          matched++;
        }
      }
      return { matched, remaining: lines.length - matched };
    })();
  },

  manualMatch(lineId, movementId) {
    return db.transaction(() => {
      const line = db.prepare("SELECT * FROM bank_statement_lines WHERE id=?").get(lineId);
      const mov  = db.prepare("SELECT * FROM financial_movements WHERE id=?").get(movementId);
      if (!line || !mov) throw new Error('Línea o movimiento no encontrado');
      if (mov.financial_account_id !== line.financial_account_id) throw new Error('El movimiento es de otra cuenta');
      if (mov.status !== 'activo') throw new Error('El movimiento está anulado');
      if (line.matched_movement_id && line.matched_movement_id !== movementId) throw new Error('La línea ya está conciliada');
      db.prepare("UPDATE bank_statement_lines SET status='conciliado',matched_movement_id=?,match_type='manual' WHERE id=?").run(movementId, lineId);
      db.prepare("UPDATE financial_movements SET reconciled=1,reconciled_at=datetime('now') WHERE id=?").run(movementId);
      return { ok: true };
    })();
  },

  unmatch(lineId) {
    return db.transaction(() => {
      const line = db.prepare("SELECT * FROM bank_statement_lines WHERE id=?").get(lineId);
      if (!line) throw new Error('Línea no encontrada');
      if (line.matched_movement_id) db.prepare("UPDATE financial_movements SET reconciled=0,reconciled_at=NULL WHERE id=?").run(line.matched_movement_id);
      db.prepare("UPDATE bank_statement_lines SET status='pendiente',matched_movement_id=NULL,match_type='' WHERE id=?").run(lineId);
      return { ok: true };
    })();
  },

  ignoreLine(lineId, ignore = true) {
    const line = db.prepare("SELECT * FROM bank_statement_lines WHERE id=?").get(lineId);
    if (!line) throw new Error('Línea no encontrada');
    if (ignore && line.matched_movement_id) throw new Error('Desvincula primero la línea conciliada');
    db.prepare("UPDATE bank_statement_lines SET status=? WHERE id=?").run(ignore ? 'ignorado' : 'pendiente', lineId);
    return { ok: true };
  },

  // Borra las líneas importadas de un lote (desvincula sus conciliaciones).
  clearBatch(accountId, batch) {
    return db.transaction(() => {
      const lines = db.prepare("SELECT * FROM bank_statement_lines WHERE financial_account_id=? AND import_batch=?").all(accountId, batch);
      for (const l of lines) {
        if (l.matched_movement_id) db.prepare("UPDATE financial_movements SET reconciled=0,reconciled_at=NULL WHERE id=?").run(l.matched_movement_id);
      }
      const r = db.prepare("DELETE FROM bank_statement_lines WHERE financial_account_id=? AND import_batch=?").run(accountId, batch);
      return { deleted: r.changes };
    })();
  },

  getReconciliation(accountId) {
    const acc = db.prepare("SELECT * FROM financial_accounts WHERE id=?").get(accountId);
    const stmtLines = db.prepare(`
      SELECT b.*, m.description as mov_desc, m.created_at as mov_date, m.type as mov_type, m.amount as mov_amount
      FROM bank_statement_lines b
      LEFT JOIN financial_movements m ON b.matched_movement_id=m.id
      WHERE b.financial_account_id=? ORDER BY b.date DESC, b.id DESC`).all(accountId);
    const unmatchedMovs = db.prepare(`
      SELECT * FROM financial_movements
      WHERE financial_account_id=? AND status='activo' AND COALESCE(reconciled,0)=0
      ORDER BY created_at DESC, id DESC`).all(accountId);

    const r2 = (n) => Math.round((n || 0) * 100) / 100;
    const active = stmtLines.filter(l => l.status !== 'ignorado');
    return {
      account: acc,
      statementLines: stmtLines.map(l => ({ ...l, movSigned: l.mov_type ? this.signedAmount({ type: l.mov_type, amount: l.mov_amount }) : null })),
      unmatchedMovements: unmatchedMovs.map(m => ({ ...m, signed: this.signedAmount(m) })),
      batches: [...new Set(stmtLines.map(l => l.import_batch))].filter(Boolean),
      summary: {
        totalLines:  stmtLines.length,
        conciliado:  stmtLines.filter(l => l.status === 'conciliado').length,
        pendientes:  stmtLines.filter(l => l.status === 'pendiente').length,
        ignorado:    stmtLines.filter(l => l.status === 'ignorado').length,
        unmatchedMovements: unmatchedMovs.length,
        statementBalance:   r2(active.reduce((s, l) => s + l.amount, 0)),
        bookBalance:        r2(acc?.current_balance || 0),
        unmatchedMovDelta:  r2(unmatchedMovs.reduce((s, m) => s + this.signedAmount(m), 0)),
      },
    };
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

  // ── Períodos contables (cierre / bloqueo) ─────────────────────────────────
  // Un período 'cerrado' bloquea el posteo de asientos con fecha dentro del rango.
  getPeriods() {
    return db.prepare("SELECT * FROM accounting_periods ORDER BY date_from DESC").all();
  },
  isDateLocked(date) {
    if (!date) return false;
    const d = String(date).slice(0, 10);
    return !!db.prepare(
      "SELECT id FROM accounting_periods WHERE status='cerrado' AND date_from<=? AND date_to>=? LIMIT 1"
    ).get(d, d);
  },
  closePeriod({ name, dateFrom, dateTo, notes, userId }) {
    const r = db.prepare(
      "INSERT INTO accounting_periods(name,date_from,date_to,status,notes) VALUES(?,?,?,'cerrado',?)"
    ).run(name, dateFrom, dateTo, notes || '');
    audit(userId, '', 'periodo_cerrado', 'accounting_periods', r.lastInsertRowid, `${dateFrom}..${dateTo}`);
    return { ok: true, id: r.lastInsertRowid };
  },
  reopenPeriod(id, userId, reason) {
    const p = db.prepare("SELECT * FROM accounting_periods WHERE id=?").get(id);
    if (!p) throw new Error('Período no encontrado');
    db.prepare("UPDATE accounting_periods SET status='abierto' WHERE id=?").run(id);
    audit(userId, '', 'periodo_reabierto', 'accounting_periods', id, reason || '');
    return { ok: true };
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
      // Bloqueo de período: no se postea en un período contable cerrado.
      const entryDate = date || new Date().toISOString().split('T')[0];
      if (this.isDateLocked(entryDate)) {
        throw new Error(`El período contable de ${entryDate} está cerrado — no se pueden postear asientos en esa fecha.`);
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

      // NOTA: no revertir aquí los saldos manualmente. El asiento de reverso creado
      // arriba con createEntry() ya invierte débito/crédito y ajusta
      // accounting_accounts.balance por cada línea. Un segundo ajuste manual duplicaba
      // la reversión y descuadraba la columna de saldo cacheada (los estados —balanza y
      // balance general— recalculan desde las líneas, por eso no se veía en esos reportes,
      // pero la lista de cuentas sí mostraba saldos erróneos tras cada anulación).

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
      WHERE e.status IN ('confirmado','anulado')`;
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
        WHERE l.account_id=a.id AND e.status IN ('confirmado','anulado')
        ${from ? "AND e.date>='"+from+"'" : ''}
        ${to   ? "AND e.date<='"+to+"'"   : ''}),0) as period_debit,
      COALESCE((SELECT SUM(l.credit) FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        WHERE l.account_id=a.id AND e.status IN ('confirmado','anulado')
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
        WHERE e.status IN ('confirmado','anulado') AND a.active=1 AND a.is_summary=0
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
        WHERE e.status IN ('confirmado','anulado') AND a.active=1 AND a.is_summary=0
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

  // ── Estado de flujo de efectivo (método directo) ──────────────────────────
  // Toma cada asiento que mueve efectivo/banco y clasifica el delta de caja por
  // origen (source_module) o, si es manual, por la contrapartida: operación /
  // inversión (activos fijos 12xx) / financiamiento (capital 3xxx, préstamos 2201).
  getCashFlow({ from, to } = {}) {
    const cfg = this.getConfig();
    const idBy = (key, code) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(code)?.id;
    const cashIds = [...new Set([
      idBy('account_cash', '1101'),
      db.prepare("SELECT id FROM accounting_accounts WHERE code='1102'").get()?.id,
      idBy('account_bank', '1103'),
    ].filter(Boolean))];
    const empty = { operacion: [], inversion: [], financiamiento: [], totalOperacion: 0, totalInversion: 0, totalFinanciamiento: 0, netChange: 0, beginningCash: 0, endingCash: 0 };
    if (!cashIds.length) return empty;
    const ph = cashIds.map(() => '?').join(',');
    const r2 = (n) => Math.round((n || 0) * 100) / 100;

    const beginningCash = from ? r2(db.prepare(`
      SELECT COALESCE(SUM(l.debit-l.credit),0) v FROM accounting_entry_lines l
      JOIN accounting_entries e ON l.entry_id=e.id
      WHERE e.status IN ('confirmado','anulado') AND l.account_id IN (${ph}) AND e.date < ?`).get(...cashIds, from).v) : 0;

    const rows = db.prepare(`
      SELECT e.id, e.date, e.concept, e.source_module,
        COALESCE(SUM(CASE WHEN l.account_id IN (${ph}) THEN l.debit-l.credit ELSE 0 END),0) as cash_delta
      FROM accounting_entries e
      JOIN accounting_entry_lines l ON l.entry_id=e.id
      WHERE e.status IN ('confirmado','anulado')
        ${from ? 'AND e.date>=?' : ''} ${to ? 'AND e.date<=?' : ''}
      GROUP BY e.id HAVING cash_delta != 0
      ORDER BY e.date ASC, e.id ASC`).all(...cashIds, ...(from ? [from] : []), ...(to ? [to] : []));

    const labelFor = (sm) => ({
      venta: 'Cobros de ventas', abono: 'Cobros a clientes (CxC)', devolucion: 'Devoluciones a clientes',
      gasto: 'Pagos de gastos', gasto_pago: 'Pagos de gastos', compra: 'Pagos de compras',
    })[sm] || 'Otros movimientos';

    const bucketOf = (e) => {
      const sm = e.source_module || '';
      if (['venta', 'abono', 'devolucion', 'gasto', 'gasto_pago', 'compra'].includes(sm)) return 'operacion';
      const counter = db.prepare(`SELECT a.code FROM accounting_entry_lines l JOIN accounting_accounts a ON l.account_id=a.id WHERE l.entry_id=? AND l.account_id NOT IN (${ph})`).all(e.id, ...cashIds);
      if (counter.some(c => /^12/.test(c.code))) return 'inversion';
      if (counter.some(c => /^3/.test(c.code) || c.code === '2201')) return 'financiamiento';
      return 'operacion';
    };

    // Agrupa por etiqueta dentro de cada categoría.
    const groups = { operacion: new Map(), inversion: new Map(), financiamiento: new Map() };
    for (const r of rows) {
      const b = bucketOf(r);
      const label = b === 'operacion' ? labelFor(r.source_module) : (r.concept || 'Movimiento');
      groups[b].set(label, r2((groups[b].get(label) || 0) + r.cash_delta));
    }
    const toArr = (m) => [...m.entries()].map(([label, amount]) => ({ label, amount })).filter(x => x.amount !== 0);
    const operacion = toArr(groups.operacion), inversion = toArr(groups.inversion), financiamiento = toArr(groups.financiamiento);
    const sum = (a) => r2(a.reduce((s, x) => s + x.amount, 0));
    const totalOperacion = sum(operacion), totalInversion = sum(inversion), totalFinanciamiento = sum(financiamiento);
    const netChange = r2(totalOperacion + totalInversion + totalFinanciamiento);
    return { operacion, inversion, financiamiento, totalOperacion, totalInversion, totalFinanciamiento, netChange, beginningCash, endingCash: r2(beginningCash + netChange) };
  },

  // ── Generar asiento automático para venta ─
  generateSaleEntry({ saleId, userId, configOverride } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;

      const sale  = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
      if (!sale) return null;
      // Solo ventas reales generan ingreso: excluir cotizaciones (no son venta),
      // devoluciones (van por generateReturnEntry) y ventas anuladas.
      if (['cotizacion', 'devolucion'].includes(sale.type)) return null;
      if (sale.status === 'cancelled') return null;
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
      // Solo abonos REALES reducen la CxC: ignorar monto 0 y el marcador contable
      // "Saldo inicial importado" (no es un cobro, es el saldo de apertura de la deuda).
      if (!payment.amount || payment.amount <= 0) return null;
      if (payment.note === 'Saldo inicial importado') return null;
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

  // ── Reversar el asiento de un origen (venta/gasto anulado) ────────────────
  // En vivo al anular. Idempotente (si no hay asiento confirmado, no hace nada).
  // No lanza → nunca rompe la operación que lo dispara.
  reverseSourceEntry(sourceModule, sourceId, userId, reason) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;
      const entry = db.prepare(
        "SELECT id FROM accounting_entries WHERE source_module=? AND source_id=? AND status='confirmado'"
      ).get(sourceModule, sourceId);
      if (!entry) return null;
      return this.reverseEntry(entry.id, userId || null, reason || 'Origen anulado');
    } catch (e) {
      console.error('[accounting] reverseSourceEntry:', e.message);
      return null;
    }
  },

  // ── Reversar TODOS los asientos confirmados de un origen ───────────────────
  // Un origen puede tener varios asientos (ej. un gasto: devengo + N pagos).
  // No lanza. Devuelve cuántos reversó.
  reverseSourceEntries(sourceModule, sourceId, userId, reason) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return 0;
      const entries = db.prepare(
        "SELECT id FROM accounting_entries WHERE source_module=? AND source_id=? AND status='confirmado'"
      ).all(sourceModule, sourceId);
      let n = 0;
      for (const e of entries) {
        try { this.reverseEntry(e.id, userId || null, reason || 'Origen anulado'); n++; }
        catch (err) { console.error('[accounting] reverseSourceEntries:', err.message); }
      }
      return n;
    } catch (e) { console.error('[accounting] reverseSourceEntries:', e.message); return 0; }
  },

  // ── Asiento de devolución (nota de crédito) ───────────────────────────────
  // Inverso de la venta: débito Ingresos + ITBIS, crédito Caja/Banco/CxC; y
  // reingresa inventario a costo. Usa los montos de la venta de devolución.
  generateReturnEntry({ returnSaleId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;
      const ret = db.prepare('SELECT * FROM sales WHERE id=?').get(returnSaleId);
      if (!ret || ret.type !== 'devolucion') return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='devolucion' AND source_id=?").get(returnSaleId)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;
      const cashAccId = getAccId('account_cash','1101');
      const bankAccId = getAccId('account_bank','1103');
      const arAccId   = getAccId('account_ar','1104');
      const revAccId  = getAccId('account_revenue','4101');
      const taxAccId  = getAccId('account_tax_payable','2102');
      const cogsAccId = getAccId('account_cogs','5101');
      const invAccId  = getAccId('account_inventory','1105');

      const total = Math.abs(ret.total || 0);
      const tax   = Math.abs(ret.tax_amt || 0);
      const net   = total - tax;
      const method = ret.payment_method || 'efectivo';
      let creditAccId = cashAccId;
      if (method === 'transferencia' || method === 'tarjeta') creditAccId = bankAccId;
      else if (method === 'credito') creditAccId = arAccId;
      const ref = ret.original_sale_id || returnSaleId;

      const lines = [];
      if (revAccId && net > 0) lines.push({ account_id: revAccId, debit: net,   credit: 0, description: `Devolución venta #${ref}` });
      if (taxAccId && tax > 0) lines.push({ account_id: taxAccId, debit: tax,   credit: 0, description: `ITBIS devolución #${ref}` });
      if (creditAccId)         lines.push({ account_id: creditAccId, debit: 0, credit: total, description: `Devolución venta #${ref}` });

      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(returnSaleId);
      const cost = items.reduce((s,i)=> s + (Math.abs(i.unit_cost||0) * Math.abs(i.qty||1)), 0);
      if (cogsAccId && invAccId && cost > 0) {
        lines.push({ account_id: invAccId,  debit: cost, credit: 0, description: `Inventario devolución #${ref}` });
        lines.push({ account_id: cogsAccId, debit: 0, credit: cost, description: `Costo devolución #${ref}` });
      }
      if (lines.length < 2) return null;

      return this.createEntry({
        date:          (ret.created_at || new Date().toISOString()).split('T')[0],
        concept:       `Devolución venta #${ref} — ${ret.customer_name||'Consumidor Final'}`,
        reference:     `DV-${returnSaleId}`,
        source_module: 'devolucion',
        source_id:     returnSaleId,
        lines,
        userId,
        status:        'confirmado',
      });
    } catch (e) {
      console.error('[accounting] generateReturnEntry:', e.message);
      return null;
    }
  },

  // ══ CRITERIO DEVENGADO (Fase 3) — gastos por pagar y compras ══════════════
  // El gasto/compra se reconoce al incurrirse (Créd Cuentas por Pagar), y el
  // pago posterior salda la CxP contra Caja/Banco. Así CxP contable ↔ operativo.

  // Cuenta de gasto según la categoría (mismo mapeo que el modelo de caja legacy).
  _expenseAccountId(expense, getAccId) {
    if (expense.type === 'activo') return getAccId('account_fixed_asset', '1201');
    let id = getAccId('account_other_exp', '6120');
    const cat = (expense.cat_name || '').toLowerCase();
    if (cat.includes('alquiler'))        id = getAccId('account_rent',     '6101');
    else if (cat.includes('electric'))   id = getAccId('account_elec',     '6102');
    else if (cat.includes('internet'))   id = getAccId('account_internet', '6104');
    else if (cat.includes('sueldo') || cat.includes('nómina') || cat.includes('nomina') || cat.includes('personal'))
                                         id = getAccId('account_salary',   '6106');
    else if (cat.includes('combustible')) id = getAccId('account_fuel',    '6107');
    return id;
  },

  // ── Devengo de gasto: Déb Gasto/Activo + Déb ITBIS Acreditable · Créd CxP ──
  // Solo tipos con obligación real (gasto/activo/reembolso). Idempotente. No
  // duplica si ya existe el asiento legacy de caja ('gasto').
  generateExpenseAccrualEntry({ expenseId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;
      const expense = db.prepare('SELECT e.*, ec.name as cat_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE e.id=?').get(expenseId);
      if (!expense) return null;
      if (!['gasto', 'activo', 'reembolso'].includes(expense.type || 'gasto')) return null;
      if (['borrador', 'rechazado', 'anulado'].includes(expense.status)) return null;
      // Compatibilidad: no duplicar si ya hay asiento legacy de caja o devengo previo.
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='gasto'     AND source_id=?").get(expenseId)) return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='gasto_dev' AND source_id=?").get(expenseId)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;

      const total = expense.total || 0;
      if (total <= 0) return null;
      const tax = expense.tax_amount || 0;
      const net = round2(total - tax);
      const expAccId = this._expenseAccountId(expense, getAccId);
      const vatAccId = getAccId('account_vat_credit', '1106'); // ITBIS Acreditable
      const apAccId  = getAccId('account_ap',         '2101'); // Cuentas por Pagar

      const lines = [];
      if (expAccId && net > 0) lines.push({ account_id: expAccId, debit: net, credit: 0, description: expense.description });
      if (vatAccId && tax > 0) lines.push({ account_id: vatAccId, debit: tax, credit: 0, description: `ITBIS acreditable — ${expense.description}` });
      if (apAccId)             lines.push({ account_id: apAccId,  debit: 0,   credit: total, description: `Por pagar — ${expense.description}` });
      if (lines.length < 2) return null;

      return this.createEntry({
        date:          expense.issue_date || new Date().toISOString().split('T')[0],
        concept:       `Gasto (devengo): ${expense.description}`,
        reference:     `GD-${expenseId}`,
        source_module: 'gasto_dev',
        source_id:     expenseId,
        lines, userId, status: 'confirmado',
      });
    } catch (e) { console.error('[accounting] generateExpenseAccrualEntry:', e.message); return null; }
  },

  // ── Pago de gasto: Déb CxP · Créd Caja/Banco. Un asiento por pago (parcial ──
  // o total). Idempotente por referencia. Solo salda si el gasto fue devengado.
  generateExpensePaymentEntry({ paymentId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;
      const pay = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(paymentId);
      if (!pay || pay.status !== 'pagado' || !pay.amount || pay.amount <= 0) return null;
      const ref = `GP-${paymentId}`;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='gasto_pago' AND reference=?").get(ref)) return null;
      // Solo salda CxP si el gasto tiene asiento de devengo (excluye retiro/aporte/traslado y legacy caja).
      if (!db.prepare("SELECT id FROM accounting_entries WHERE source_module='gasto_dev' AND source_id=? AND status='confirmado'").get(pay.expense_id)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;
      const apAccId = getAccId('account_ap', '2101');
      const viaBank = pay.payment_source === 'banco' || ['transferencia', 'tarjeta', 'cheque'].includes(pay.payment_method);
      const cashAccId = viaBank ? getAccId('account_bank', '1103') : getAccId('account_cash', '1101');

      const lines = [
        { account_id: apAccId,   debit: pay.amount, credit: 0,          description: `Pago gasto #${pay.expense_id}` },
        { account_id: cashAccId, debit: 0,          credit: pay.amount, description: `Pago gasto #${pay.expense_id}` },
      ];
      return this.createEntry({
        date:          (pay.created_at || new Date().toISOString()).split('T')[0],
        concept:       `Pago de gasto #${pay.expense_id}`,
        reference:     ref,
        source_module: 'gasto_pago',
        source_id:     pay.expense_id,
        lines, userId, status: 'confirmado',
      });
    } catch (e) { console.error('[accounting] generateExpensePaymentEntry:', e.message); return null; }
  },

  // ── Compra recibida (devengado): Déb Inventario + ITBIS Acreditable · Créd ──
  // CxP. Se llama en cada recepción (parcial/total) con el valor recibido en
  // ESA recepción. Idempotente por referencia (secuencia de recepción).
  generatePurchaseEntry({ poId, deltaValue, deltaTax, receiveSeq, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId);
      if (!po) return null;
      const value = round2(deltaValue || 0);
      const tax   = round2(deltaTax || 0);
      if (value <= 0 && tax <= 0) return null;
      const ref = `C-${poId}-r${receiveSeq || 1}`;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='compra' AND reference=?").get(ref)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;
      const invAccId = getAccId('account_inventory',  '1105');
      const vatAccId = getAccId('account_vat_credit', '1106');
      const apAccId  = getAccId('account_ap',         '2101');

      const lines = [];
      if (invAccId && value > 0) lines.push({ account_id: invAccId, debit: value, credit: 0, description: `Compra OC #${poId}` });
      if (vatAccId && tax > 0)   lines.push({ account_id: vatAccId, debit: tax,   credit: 0, description: `ITBIS compra OC #${poId}` });
      if (apAccId)               lines.push({ account_id: apAccId,  debit: 0, credit: round2(value + tax), description: `Por pagar OC #${poId} — ${po.supplier_name || ''}` });
      if (lines.length < 2) return null;

      return this.createEntry({
        date:          new Date().toISOString().split('T')[0],
        concept:       `Compra OC #${poId} — ${po.supplier_name || 'Proveedor'}`,
        reference:     ref,
        source_module: 'compra',
        source_id:     poId,
        lines, userId, status: 'confirmado',
      });
    } catch (e) { console.error('[accounting] generatePurchaseEntry:', e.message); return null; }
  },

  // ══ CUADRES auxiliar ↔ mayor (Fase 4) ════════════════════════════════════
  // Compara el saldo contable (cuenta control) con el auxiliar operativo. Si no
  // cuadran, `ok=false` → alerta. El saldo contable es autoridad; el auxiliar es
  // la fuente operativa (clientes, stock, gastos/compras pendientes).
  getReconciliation() {
    const cfg = this.getConfig();
    const r2 = (n) => Math.round((n || 0) * 100) / 100;
    const apId = cfg.account_ap?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code='2101'").get()?.id;
    const ctrlBal = (key, code) => {
      const id = cfg[key]?.account_id;
      const row = id
        ? db.prepare("SELECT balance FROM accounting_accounts WHERE id=?").get(id)
        : db.prepare("SELECT balance FROM accounting_accounts WHERE code=?").get(code);
      return row?.balance || 0;
    };

    // CxC (1104, deudor): saldo contable vs suma de saldos de clientes.
    const cxcCtrl = r2(ctrlBal('account_ar', '1104'));
    const cxcAux  = r2(db.prepare("SELECT COALESCE(SUM(balance),0) t FROM customers WHERE balance>0").get().t);

    // Inventario (1105, deudor): saldo contable vs valor de stock a costo.
    const invCtrl = r2(ctrlBal('account_inventory', '1105'));
    const invAux  = r2(db.prepare("SELECT COALESCE(SUM(stock*cost),0) t FROM products WHERE active=1").get().t);

    // CxP (2101, acreedor → saldo negativo): gastos devengados pendientes + compras
    // recibidas contabilizadas (sin flujo de pago a proveedor, siguen como CxP).
    const cxpCtrl = r2(-ctrlBal('account_ap', '2101'));
    const cxpGastos = db.prepare(`
      SELECT COALESCE(SUM(total-paid_amount),0) t FROM expenses
      WHERE type IN ('gasto','activo','reembolso') AND status NOT IN ('anulado','rechazado','borrador')
        AND EXISTS(SELECT 1 FROM accounting_entries ae WHERE ae.source_module='gasto_dev' AND ae.source_id=expenses.id AND ae.status='confirmado')`).get().t;
    const cxpCompras = apId ? db.prepare(`
      SELECT COALESCE(SUM(l.credit),0) t FROM accounting_entry_lines l
      JOIN accounting_entries e ON l.entry_id=e.id
      WHERE e.source_module='compra' AND e.status='confirmado' AND l.account_id=?`).get(apId).t : 0;
    const cxpAux = r2(cxpGastos + cxpCompras);

    const mk = (name, control, auxiliar, note) => {
      const diff = r2(control - auxiliar);
      return { name, control: r2(control), auxiliar: r2(auxiliar), diff, ok: Math.abs(diff) < 0.01, note };
    };
    return [
      mk('Cuentas por cobrar (1104)', cxcCtrl, cxcAux, 'Contable vs suma de saldos de clientes'),
      mk('Inventario (1105)',         invCtrl, invAux, 'Contable vs valor de stock a costo'),
      mk('Cuentas por pagar (2101)',  cxpCtrl, cxpAux, 'Contable vs gastos pendientes + compras recibidas'),
    ];
  },

  // ── Reporte 606 (compras/gastos con NCF — formato DGII preliminar) ─────────
  // Fuente: gastos con RNC de proveedor. Devuelve filas + totales (base, ITBIS).
  get606({ from, to } = {}) {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let q = `SELECT e.id, e.issue_date, e.supplier_rnc, e.ncf, e.invoice_number, e.description,
               e.type, e.amount, e.tax_amount, e.total, s.name as supplier_name
             FROM expenses e LEFT JOIN suppliers s ON e.supplier_id=s.id
             WHERE e.status NOT IN ('anulado','rechazado','borrador')
               AND e.supplier_rnc IS NOT NULL AND TRIM(e.supplier_rnc)<>''`;
    const p = [];
    if (from && DATE_RE.test(from)) { q += ` AND date(e.issue_date)>=?`; p.push(from); }
    if (to   && DATE_RE.test(to))   { q += ` AND date(e.issue_date)<=?`; p.push(to); }
    q += ` ORDER BY e.issue_date ASC, e.id ASC`;
    const rows = db.prepare(q).all(...p);
    const totals = rows.reduce((a, r) => {
      const itbis = r.tax_amount || 0;
      const base  = (r.total || 0) - itbis;
      a.base += base; a.itbis += itbis; a.total += (r.total || 0); return a;
    }, { base: 0, itbis: 0, total: 0, count: rows.length });
    return { rows, totals };
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
        WHERE e.status IN ('confirmado','anulado') AND a.type=? AND e.date BETWEEN ? AND ?
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
        WHERE l.account_id=? AND e.status IN ('confirmado','anulado')`).get(acc.id);
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
// REPOSITORIO: CONDUCE / NOTA DE ENTREGA
// ──────────────────────────────────────────────
// Documento de entrega/despacho. NO fiscal: sin NCF, sin ITBIS, sin CxC, y NO
// mueve inventario por sí mismo (el stock sale en la factura, como en todo el
// sistema). Toda mutación valida el estado; permisos y auditoría se aplican en
// los handlers (main.js). Arquitectura single-almacén: inventario global.
// ══════════════════════════════════════════════
const conduceRepo = {
  // Próximo número correlativo: CD-00001, CD-00002, ...
  generateNumber() {
    const row = db.prepare(
      "SELECT number FROM delivery_notes WHERE number LIKE 'CD-%' ORDER BY id DESC LIMIT 1"
    ).get();
    let next = 1;
    if (row && row.number) {
      const n = parseInt(String(row.number).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) next = n + 1;
    }
    return 'CD-' + String(next).padStart(5, '0');
  },

  // Transiciones de estado permitidas (documentales — el conduce no mueve stock).
  _transitions: {
    borrador:   ['preparado', 'despachado', 'anulado'],
    preparado:  ['despachado', 'borrador', 'anulado'],
    despachado: ['entregado', 'parcial', 'devuelto', 'anulado'],
    parcial:    ['entregado', 'devuelto', 'facturado'],
    entregado:  ['facturado', 'devuelto'],
    facturado:  ['devuelto'],
    anulado:    [],
    devuelto:   [],
  },
  canTransition(from, to) {
    if (from === to) return true;
    return (this._transitions[from] || []).includes(to);
  },

  _insertItems(noteId, items) {
    const ins = db.prepare(`
      INSERT INTO delivery_note_items
        (delivery_note_id, product_id, sku, description, unit,
         requested_qty, delivered_qty, pending_qty, lot_number, serial_number, notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const it of (items || [])) {
      const req = Number(it.requested_qty ?? it.qty ?? 0) || 0;
      const del = Number(it.delivered_qty ?? 0) || 0;
      ins.run(
        noteId, it.product_id || null, it.sku || it.product_code || '',
        it.description || it.product_name || it.name || '', it.unit || 'und',
        req, del, Math.max(0, req - del),
        it.lot_number || '', it.serial_number || '', it.notes || ''
      );
    }
  },

  create({ header = {}, items = [], userId = null }) {
    const number = header.number || this.generateNumber();
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO delivery_notes
          (number, customer_id, customer_name, customer_rnc, branch_id,
           source_type, source_id, status, issue_date, delivery_address,
           driver_name, vehicle_plate, notes, invoice_id, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        number, header.customer_id || null, header.customer_name || 'Consumidor Final',
        header.customer_rnc || '', header.branch_id || null,
        header.source_type || 'manual', header.source_id || null,
        header.status || 'borrador', header.issue_date || todayStr(),
        header.delivery_address || '', header.driver_name || '',
        header.vehicle_plate || '', header.notes || '', header.invoice_id || null, userId
      );
      const id = r.lastInsertRowid;
      this._insertItems(id, items);
      return id;
    });
    return tx();
  },

  getAll(filters = {}) {
    const where = [], params = [];
    if (filters.status)      { where.push('dn.status = ?');      params.push(filters.status); }
    if (filters.customer_id) { where.push('dn.customer_id = ?'); params.push(filters.customer_id); }
    if (filters.source_type) { where.push('dn.source_type = ?'); params.push(filters.source_type); }
    if (filters.from)        { where.push('dn.issue_date >= ?'); params.push(filters.from); }
    if (filters.to)          { where.push('dn.issue_date <= ?'); params.push(filters.to); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return db.prepare(`
      SELECT dn.*, u.name AS created_by_name,
             (SELECT COUNT(*) FROM delivery_note_items di WHERE di.delivery_note_id = dn.id) AS item_count
      FROM delivery_notes dn
      LEFT JOIN users u ON dn.created_by = u.id
      ${w}
      ORDER BY dn.id DESC
      LIMIT ${Number(filters.limit) || 500}
    `).all(...params);
  },

  getById(id) {
    const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(id);
    if (!dn) return null;
    dn.items         = db.prepare('SELECT * FROM delivery_note_items WHERE delivery_note_id=? ORDER BY id').all(id);
    dn.invoice_links = db.prepare('SELECT * FROM delivery_note_invoice_links WHERE delivery_note_id=? ORDER BY id').all(id);
    return dn;
  },

  update(id, { header = {}, items = null }) {
    const dn = db.prepare('SELECT status FROM delivery_notes WHERE id=?').get(id);
    if (!dn) throw new Error('Conduce no encontrado');
    if (dn.status !== 'borrador') throw new Error('Solo se puede editar un conduce en BORRADOR');
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE delivery_notes SET
          customer_id=?, customer_name=?, customer_rnc=?, branch_id=?,
          delivery_address=?, driver_name=?, vehicle_plate=?, notes=?,
          updated_at=datetime('now','localtime')
        WHERE id=?
      `).run(
        header.customer_id || null, header.customer_name || 'Consumidor Final',
        header.customer_rnc || '', header.branch_id || null,
        header.delivery_address || '', header.driver_name || '',
        header.vehicle_plate || '', header.notes || '', id
      );
      if (Array.isArray(items)) {
        db.prepare('DELETE FROM delivery_note_items WHERE delivery_note_id=?').run(id);
        this._insertItems(id, items);
      }
    });
    tx();
    return this.getById(id);
  },

  // Cambio de estado validado. `data` transporta campos según el destino.
  setStatus(id, newStatus, data = {}) {
    const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(id);
    if (!dn) throw new Error('Conduce no encontrado');
    if (!this.canTransition(dn.status, newStatus)) {
      throw new Error(`Transición no permitida: ${dn.status} → ${newStatus}`);
    }
    const sets = ['status=?', "updated_at=datetime('now','localtime')"];
    const vals = [newStatus];
    if (newStatus === 'despachado') {
      sets.push('dispatch_date=?', 'dispatched_by=?');
      vals.push(data.dispatch_date || nowStr(), data.userId || null);
      if (data.driver_name != null)      { sets.push('driver_name=?');      vals.push(data.driver_name); }
      if (data.vehicle_plate != null)    { sets.push('vehicle_plate=?');    vals.push(data.vehicle_plate); }
      if (data.delivery_address != null) { sets.push('delivery_address=?'); vals.push(data.delivery_address); }
    }
    if (newStatus === 'entregado' || newStatus === 'parcial') {
      sets.push('received_date=?', 'received_by_user_id=?');
      vals.push(data.received_date || nowStr(), data.userId || null);
      if (data.received_by_name != null)     { sets.push('received_by_name=?');     vals.push(data.received_by_name); }
      if (data.received_by_document != null) { sets.push('received_by_document=?'); vals.push(data.received_by_document); }
    }
    const tx = db.transaction(() => {
      if (Array.isArray(data.deliveredItems)) {
        const upd = db.prepare("UPDATE delivery_note_items SET delivered_qty=?, pending_qty=?, updated_at=datetime('now','localtime') WHERE id=? AND delivery_note_id=?");
        for (const d of data.deliveredItems) {
          const row = db.prepare('SELECT requested_qty FROM delivery_note_items WHERE id=? AND delivery_note_id=?').get(d.itemId, id);
          if (!row) continue;
          const del = Math.max(0, Number(d.delivered_qty) || 0);
          upd.run(del, Math.max(0, (row.requested_qty || 0) - del), d.itemId, id);
        }
      }
      db.prepare(`UPDATE delivery_notes SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    });
    tx();
    return this.getById(id);
  },

  cancel(id, { userId = null, reason = '' } = {}) {
    const dn = db.prepare('SELECT status FROM delivery_notes WHERE id=?').get(id);
    if (!dn) throw new Error('Conduce no encontrado');
    if (dn.status === 'anulado')   throw new Error('El conduce ya está anulado');
    if (dn.status === 'facturado') throw new Error('No se puede anular un conduce ya facturado — maneja primero la factura');
    if (!reason || !reason.trim()) throw new Error('Debes indicar un motivo de anulación');
    db.prepare(`
      UPDATE delivery_notes SET status='anulado', cancelled_by=?, cancellation_reason=?,
        updated_at=datetime('now','localtime') WHERE id=?
    `).run(userId, reason.trim(), id);
    return this.getById(id);
  },

  // ── Facturación desde conduce ────────────────────────────────
  // Cantidad ya facturada por línea (suma de enlaces).
  _invoicedByItem(conduceId) {
    const rows = db.prepare(`
      SELECT delivery_note_item_id AS iid, COALESCE(SUM(qty_linked),0) AS q
      FROM delivery_note_invoice_links WHERE delivery_note_id=? GROUP BY delivery_note_item_id
    `).all(conduceId);
    const map = {};
    rows.forEach(r => { map[r.iid] = r.q; });
    return map;
  },

  // Por cada línea: base facturable (lo entregado si se registró, si no lo solicitado),
  // lo ya facturado, y lo que resta por facturar.
  invoiceableLines(conduceId) {
    const dn = this.getById(conduceId);
    if (!dn) throw new Error('Conduce no encontrado');
    const inv = this._invoicedByItem(conduceId);
    return dn.items.map(it => {
      const base    = (it.delivered_qty && it.delivered_qty > 0) ? it.delivered_qty : it.requested_qty;
      const already = inv[it.id] || 0;
      return { ...it, base, already, invoiceable: Math.max(0, round2(base - already)) };
    });
  },

  // Crea una FACTURA desde el conduce reusando salesRepo (que descuenta stock
  // UNA sola vez). El conduce nunca descontó → cero doble descuento. Registra
  // los enlaces para impedir doble facturación y permitir facturación parcial.
  invoiceFromConduce({ conduceId, lines = null, payment = {}, session = null, user, priceMode = 'retail' }) {
    const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(conduceId);
    if (!dn) throw new Error('Conduce no encontrado');
    if (!['despachado', 'entregado', 'parcial', 'facturado'].includes(dn.status)) {
      throw new Error('El conduce debe estar despachado o entregado para poder facturarse');
    }
    const avail = this.invoiceableLines(conduceId);
    const toInvoice = [];
    for (const a of avail) {
      let qty = a.invoiceable;
      if (Array.isArray(lines)) {
        const req = lines.find(l => Number(l.itemId) === a.id);
        if (!req) continue;
        qty = Number(req.qty) || 0;
      }
      if (qty <= 0) continue;
      if (qty > a.invoiceable + 1e-9) {
        throw new Error(`No puedes facturar ${qty} de "${a.description}" — disponible por facturar: ${a.invoiceable}`);
      }
      if (!a.product_id) throw new Error(`La línea "${a.description}" no tiene producto vinculado; no se puede facturar`);
      const prod = productsRepo.getById(a.product_id);
      if (!prod) throw new Error(`El producto de "${a.description}" ya no existe`);
      const price = priceMode === 'wholesale' ? (prod.wholesale || prod.price) : prod.price;
      toInvoice.push({ item: a, qty, prod, price });
    }
    if (!toInvoice.length) throw new Error('No hay cantidades pendientes por facturar en este conduce');

    // 1) Crear la factura (descuenta stock una sola vez — afectaStock=true)
    const saleRes = salesRepo.create({
      session,
      customer: { id: dn.customer_id || 1, name: dn.customer_name, rnc: dn.customer_rnc || '' },
      items: toInvoice.map(t => ({
        product_id: t.prod.id, product_code: t.prod.code, product_name: t.prod.name,
        unit_cost: t.prod.cost, unit_price: t.price, qty: t.qty,
      })),
      payment: { method: payment.method || 'efectivo', disc: payment.disc || 0, priceMode },
      user,
      type: 'factura',
    });
    const saleId = saleRes.saleId;

    // 2) Registrar enlaces + actualizar estado del conduce
    const linkTx = db.transaction(() => {
      const insLink = db.prepare(`
        INSERT INTO delivery_note_invoice_links
          (delivery_note_id, delivery_note_item_id, invoice_id, product_id, qty_linked)
        VALUES(?,?,?,?,?)
      `);
      for (const t of toInvoice) insLink.run(conduceId, t.item.id, saleId, t.prod.id, t.qty);
      const after = this.invoiceableLines(conduceId);
      const fully = after.every(a => a.invoiceable <= 1e-9);
      db.prepare(`
        UPDATE delivery_notes SET invoice_id=?, status=?, updated_at=datetime('now','localtime') WHERE id=?
      `).run(saleId, fully ? 'facturado' : dn.status, conduceId);
    });
    linkTx();

    return { saleId, ncf: saleRes.ncf, total: saleRes.total, conduce: this.getById(conduceId) };
  },

  // Genera un conduce A PARTIR de una venta existente (cotización o factura).
  // cotización → conduce: para despachar lo cotizado (se factura después).
  // factura → conduce: la factura ya descontó stock; el conduce nace vinculado
  // y en estado 'facturado' (no se vuelve a facturar ni a descontar).
  createFromSale(saleId, { userId = null } = {}) {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
    if (!sale) throw new Error('Venta/cotización no encontrada');
    if (sale.type === 'devolucion') throw new Error('No se puede generar un conduce de una devolución');
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
    if (!items.length) throw new Error('La venta no tiene líneas');

    const id = this.create({
      header: {
        customer_id: sale.customer_id, customer_name: sale.customer_name,
        customer_rnc: sale.customer_rnc,
        source_type: sale.type === 'cotizacion' ? 'cotizacion' : 'factura',
        source_id: saleId,
        invoice_id: sale.type === 'factura' ? saleId : null,
      },
      items: items.map(it => ({
        product_id: it.product_id, product_code: it.product_code,
        description: it.product_name, unit: 'und', qty: it.qty,
      })),
      userId,
    });

    // Si viene de una factura, ya está facturado: enlazar y marcar (no re-factura).
    if (sale.type === 'factura') {
      const linkTx = db.transaction(() => {
        const dn = this.getById(id);
        const insLink = db.prepare(`
          INSERT INTO delivery_note_invoice_links
            (delivery_note_id, delivery_note_item_id, invoice_id, product_id, qty_linked)
          VALUES(?,?,?,?,?)
        `);
        dn.items.forEach(di => insLink.run(id, di.id, saleId, di.product_id, di.requested_qty));
        db.prepare("UPDATE delivery_notes SET status='facturado' WHERE id=?").run(id);
      });
      linkTx();
    }
    return this.getById(id);
  },

  // ── Reportes ─────────────────────────────────────────────────
  // Agregaciones de solo lectura. Filtros opcionales: { from, to } por issue_date.
  reports(filters = {}) {
    const cond = [], p = [];
    if (filters.from) { cond.push('issue_date >= ?'); p.push(filters.from); }
    if (filters.to)   { cond.push('issue_date <= ?'); p.push(filters.to); }
    const w = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const list = (extra) => db.prepare(`
      SELECT dn.id, dn.number, dn.customer_name, dn.issue_date, dn.status, dn.source_type, dn.source_id,
             (SELECT COUNT(*) FROM delivery_note_items di WHERE di.delivery_note_id=dn.id) AS item_count
      FROM delivery_notes dn ${w ? w + ' AND' : 'WHERE'} ${extra} ORDER BY dn.id DESC LIMIT 500
    `).all(...p);

    return {
      byStatus: db.prepare(`SELECT status, COUNT(*) c FROM delivery_notes ${w} GROUP BY status`).all(...p),
      // Pendientes de facturar: despachados/entregados/parciales aún no facturados.
      pendientesFacturar:    list(`dn.status IN ('despachado','entregado','parcial')`),
      despachadosNoEntregados: list(`dn.status='despachado'`),
      entregadosNoFacturados:  list(`dn.status='entregado'`),
      anulados:                list(`dn.status='anulado'`),
      porVendedor: db.prepare(`
        SELECT COALESCE(u.name,'—') AS vendedor, COUNT(*) c
        FROM delivery_notes dn LEFT JOIN users u ON dn.created_by=u.id
        ${w ? w + " AND" : "WHERE"} dn.status!='anulado' GROUP BY dn.created_by ORDER BY c DESC LIMIT 30
      `).all(...p),
      porCliente: db.prepare(`
        SELECT customer_name, COUNT(*) c
        FROM delivery_notes dn ${w ? w + " AND" : "WHERE"} status!='anulado'
        GROUP BY customer_id, customer_name ORDER BY c DESC LIMIT 30
      `).all(...p),
      topProductos: db.prepare(`
        SELECT di.description, SUM(di.requested_qty) qty, COUNT(DISTINCT di.delivery_note_id) conduces
        FROM delivery_note_items di JOIN delivery_notes dn ON di.delivery_note_id=dn.id
        ${w ? w + " AND" : "WHERE"} dn.status IN ('despachado','entregado','parcial','facturado')
        GROUP BY di.product_id, di.description ORDER BY qty DESC LIMIT 30
      `).all(...p),
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
  bankReconRepo,
  accountingRepo,
  conduceRepo,
};
