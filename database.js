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
const { ensureSalespeopleSchema, createSalespeopleRepo } = require('./src/main/salespeople-repo');
const { ensureCheckoutOrdersSchema, createCheckoutOrdersRepo } = require('./src/main/checkout-orders-repo');

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
  migratePriceHistoryAccountingColumns();
  migrateVehiclesModule();
  migratePurchaseColumns();
  migrateTaxColumns();
  migrateECFColumns();
  migrateExpensesColumns();
  migratePaymentsColumns();
  migrateV2IdentityColumns();   // Fase 1 migración v2 (identidad real Equiparts)
  migrateDocumentNumbering();   // Secuencias internas independientes por tipo documental
  migrateCustomerCompanies();   // Personas, empresas, representantes y snapshots
  migrateSalesWorkflowEnhancements(); // Teléfonos múltiples, cargos, USD y fecha documental
  ensureCheckoutOrdersSchema(db);
  seedIfEmpty();
  ensureNcfIntegrity();         // C2: índice UNIQUE parcial contra NCF duplicados
  ensureDeliveryExpenseIntegrity(); // gastos de envíos pre-v1.18 sin enlazar/anular

  console.log('[DB] Iniciada en:', DB_PATH);
  return db;
}

// Inicializa una base secundaria sin dejar el proceso apuntando a ella.
// Se usa para crear negocios separados: la DB nueva se prepara y se cierra,
// mientras la conexión activa del POS queda exactamente como estaba.
function initDetachedDB(customDataDir, afterInit) {
  if (!customDataDir) throw new Error('customDataDir requerido');

  const previous = { dataDir, DB_PATH, db };
  let detachedDb = null;

  try {
    detachedDb = initDB(customDataDir);
    if (typeof afterInit === 'function') afterInit(detachedDb, customDataDir);
    return { ok: true, dbPath: path.join(customDataDir, 'velo.db') };
  } finally {
    const dbToClose = detachedDb || (db !== previous.db ? db : null);
    dataDir = previous.dataDir;
    DB_PATH = previous.DB_PATH;
    db = previous.db;
    if (dbToClose && dbToClose !== previous.db) {
      try { dbToClose.close(); } catch {}
    }
  }
}

// ── Integridad de NCF (C2): red de seguridad contra duplicados a nivel BD ─────
// `getNext` ya es atómico (transacción), pero sin restricción UNIQUE un import,
// una secuencia mal configurada o el path legacy podían colar un NCF duplicado.
// Esta función corre en CADA arranque (idempotente, auto-sanadora): crea un índice
// UNIQUE PARCIAL sobre los NCF NO vacíos (las ventas no fiscales con ncf='' no se
// afectan) SOLO si no hay duplicados existentes. Si los hay, avisa con la lista y
// NO crea el índice (para no romper) — al reconciliarlos, el próximo arranque lo crea.
function ensureNcfIntegrity() {
  try {
    const dups = (table) => db.prepare(
      `SELECT ncf, COUNT(*) c FROM ${table === 'sales' ? 'sales' : 'ncf_log'} ` +
      `WHERE ncf IS NOT NULL AND TRIM(ncf)<>'' GROUP BY ncf HAVING c>1`
    ).all();
    const apply = (table, idx) => {
      const d = dups(table);
      if (d.length === 0) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${table === 'sales' ? 'sales' : 'ncf_log'}(ncf) WHERE ncf IS NOT NULL AND ncf<>''`);
      } else {
        console.warn(`[NCF] ⚠ ${d.length} NCF duplicado(s) en ${table} — índice único NO aplicado. Reconciliar: ${d.slice(0, 10).map(x => x.ncf).join(', ')}`);
      }
    };
    apply('sales',   'uidx_sales_ncf');
    apply('ncf_log', 'uidx_ncflog_ncf');
  } catch (e) { console.error('[NCF] ensureNcfIntegrity:', e.message); }
}

// ── Integridad envíos ↔ gastos: red de seguridad para gastos huérfanos ────────
// Hasta v1.17.9 el gasto del envío lo creaba el renderer al marcar "en camino"
// SIN guardar expense_id en el envío, así que cancelar el envío no encontraba
// nada que anular y el gasto quedaba vivo para siempre. Corre en CADA arranque
// (idempotente): identifica esos gastos automáticos por descripción+notas, los
// enlaza a su envío, y si el envío está cancelado anula el gasto y reversa sus
// asientos. Los gastos creados por el flujo nuevo (v1.18+) ya vienen enlazados
// y no entran al filtro.
function ensureDeliveryExpenseIntegrity() {
  try {
    if (!tableExists('deliveries') || !tableExists('expenses')) return;
    const orphans = db.prepare(`
      SELECT e.id, e.description, e.status FROM expenses e
      WHERE (e.description LIKE 'Envío #%' OR e.description LIKE 'Combustible envío #%')
        AND (e.notes LIKE 'Rastreo:%' OR e.notes LIKE 'Registrado automáticamente%'
             OR e.notes LIKE '%Generado automáticamente desde Envíos%')
        AND e.id NOT IN (SELECT expense_id FROM deliveries WHERE expense_id IS NOT NULL)
    `).all();
    let linked = 0, voided = 0;
    for (const g of orphans) {
      const m = (g.description || '').match(/env[ií]o #(\d+)/i);
      if (!m) continue;
      const d = db.prepare('SELECT id, status, expense_id FROM deliveries WHERE id=?').get(Number(m[1]));
      if (!d) continue;
      if (d.expense_id == null) {
        db.prepare('UPDATE deliveries SET expense_id=? WHERE id=?').run(g.id, d.id);
        linked++;
      }
      if (d.status === 'cancelado' && g.status !== 'anulado') {
        const motivo = `Envío #${d.id} cancelado — saneo automático de gasto huérfano`;
        try {
          expensesRepo.cancel(g.id, null, 'sistema', motivo);
          accountingRepo.reverseSourceEntries('gasto',      g.id, null, motivo);
          accountingRepo.reverseSourceEntries('gasto_dev',  g.id, null, motivo);
          accountingRepo.reverseSourceEntries('gasto_pago', g.id, null, motivo);
          voided++;
        } catch (e) { console.error(`[Envíos] saneo gasto #${g.id}:`, e.message); }
      }
    }
    if (linked || voided) {
      console.log(`[Envíos] Saneo de gastos huérfanos: ${linked} enlazado(s), ${voided} anulado(s)`);
    }
  } catch (e) { console.error('[Envíos] ensureDeliveryExpenseIntegrity:', e.message); }
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
      taxable       INTEGER NOT NULL DEFAULT 1,
      tax_pct       REAL NOT NULL DEFAULT 18,
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

    -- ── Historial de cambios de costo/precio ──
    CREATE TABLE IF NOT EXISTS product_price_history (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id            INTEGER NOT NULL REFERENCES products(id),
      product_code          TEXT DEFAULT '',
      product_name          TEXT DEFAULT '',
      cost_before           REAL NOT NULL DEFAULT 0,
      cost_after            REAL NOT NULL DEFAULT 0,
      price_before          REAL NOT NULL DEFAULT 0,
      price_after           REAL NOT NULL DEFAULT 0,
      wholesale_before      REAL NOT NULL DEFAULT 0,
      wholesale_after       REAL NOT NULL DEFAULT 0,
      stock_at_change       INTEGER NOT NULL DEFAULT 0,
      cost_delta            REAL NOT NULL DEFAULT 0,
      price_delta           REAL NOT NULL DEFAULT 0,
      wholesale_delta       REAL NOT NULL DEFAULT 0,
      stock_value_delta     REAL NOT NULL DEFAULT 0,
      retail_value_delta    REAL NOT NULL DEFAULT 0,
      wholesale_value_delta REAL NOT NULL DEFAULT 0,
      source                TEXT DEFAULT 'manual',
      reason                TEXT DEFAULT '',
      user_id               INTEGER REFERENCES users(id),
      accounting_entry_id   INTEGER DEFAULT NULL,
      accounting_error      TEXT DEFAULT '',
      created_at            TEXT DEFAULT (datetime('now','localtime'))
    );

    -- ── Clientes ──
    CREATE TABLE IF NOT EXISTS customers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      customer_type  TEXT DEFAULT 'person' CHECK(customer_type IN ('person','company')),
      trade_name     TEXT DEFAULT '',
      rnc            TEXT DEFAULT '',
      phone          TEXT DEFAULT '',
      address        TEXT DEFAULT '',
      email          TEXT DEFAULT '',
      billing_email  TEXT DEFAULT '',
      preferred_price_mode TEXT DEFAULT 'retail' CHECK(preferred_price_mode IN ('retail','wholesale')),
      notes          TEXT DEFAULT '',
      credit_limit   REAL DEFAULT 0,
      credit_days    INTEGER DEFAULT 30,
      balance        REAL DEFAULT 0,
      credit_due     TEXT DEFAULT NULL,
      status         TEXT DEFAULT 'activo' CHECK(status IN ('activo','bloqueado','moroso')),
      active         INTEGER DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    );

    -- Representantes operativos de clientes empresa. La cuenta, el crédito y
    -- las facturas siempre pertenecen al customer_id padre.
    CREATE TABLE IF NOT EXISTS customer_contacts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id          INTEGER NOT NULL REFERENCES customers(id),
      name                 TEXT NOT NULL,
      document             TEXT DEFAULT '',
      role                 TEXT DEFAULT '',
      phone                TEXT DEFAULT '',
      email                TEXT DEFAULT '',
      is_primary           INTEGER DEFAULT 0,
      can_order            INTEGER DEFAULT 1,
      can_receive          INTEGER DEFAULT 1,
      can_receive_invoices INTEGER DEFAULT 1,
      active               INTEGER DEFAULT 1,
      created_at           TEXT DEFAULT (datetime('now','localtime')),
      updated_at           TEXT DEFAULT (datetime('now','localtime'))
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
      customer_type   TEXT DEFAULT 'person',
      customer_trade_name TEXT DEFAULT '',
      customer_address TEXT DEFAULT '',
      customer_phone   TEXT DEFAULT '',
      customer_email   TEXT DEFAULT '',
      customer_contact_id INTEGER REFERENCES customer_contacts(id),
      customer_contact_name TEXT DEFAULT '',
      customer_contact_document TEXT DEFAULT '',
      customer_contact_role TEXT DEFAULT '',
      customer_contact_phone TEXT DEFAULT '',
      customer_contact_email TEXT DEFAULT '',
      type            TEXT DEFAULT 'factura' CHECK(type IN ('factura','cotizacion','devolucion')),
      status          TEXT DEFAULT 'completed' CHECK(status IN ('completed','cancelled','returned')),
      subtotal        REAL NOT NULL DEFAULT 0,
      discount_pct    REAL DEFAULT 0,
      discount_amt    REAL DEFAULT 0,
      tax_pct         REAL DEFAULT 18,
      tax_amt         REAL DEFAULT 0,
      total           REAL NOT NULL DEFAULT 0,
      source_balance  REAL DEFAULT NULL,
      payment_method  TEXT DEFAULT 'efectivo',
      price_mode      TEXT DEFAULT 'retail' CHECK(price_mode IN ('retail','wholesale')),
      cajero          TEXT DEFAULT '',
      user_id         INTEGER REFERENCES users(id),
      salesperson_id  INTEGER REFERENCES salespeople(id),
      financial_account_id INTEGER DEFAULT NULL,
      payment_currency TEXT DEFAULT 'DOP',
      exchange_rate   REAL DEFAULT 1,
      account_amount  REAL DEFAULT 0,
      card_brand      TEXT DEFAULT '',
      card_last4      TEXT DEFAULT '',
      payment_reference TEXT DEFAULT '',
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
      subtotal    REAL NOT NULL DEFAULT 0,
      taxable     INTEGER DEFAULT NULL,
      tax_pct     REAL DEFAULT NULL,
      tax_amt     REAL DEFAULT NULL,
      net_subtotal REAL DEFAULT NULL
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
      customer_contact_id       INTEGER REFERENCES customer_contacts(id),
      customer_contact_name     TEXT DEFAULT '',
      customer_contact_document TEXT DEFAULT '',
      customer_contact_role     TEXT DEFAULT '',
      customer_contact_phone    TEXT DEFAULT '',
      customer_contact_email    TEXT DEFAULT '',
      created_at      TEXT DEFAULT (datetime('now','localtime'))
    );

    -- ── Proveedores / compras ──
    CREATE TABLE IF NOT EXISTS suppliers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      contact    TEXT DEFAULT '',
      phone      TEXT DEFAULT '',
      email      TEXT DEFAULT '',
      rnc        TEXT DEFAULT '',
      address    TEXT DEFAULT '',
      notes      TEXT DEFAULT '',
      status     TEXT DEFAULT 'activo',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id    INTEGER REFERENCES suppliers(id),
      supplier_name  TEXT DEFAULT '',
      status         TEXT DEFAULT 'pendiente' CHECK(status IN ('pendiente','recibido','parcial','cancelado')),
      subtotal       REAL DEFAULT 0,
      tax_amt        REAL DEFAULT 0,
      freight_cost   REAL DEFAULT 0,
      customs_cost   REAL DEFAULT 0,
      transport_cost REAL DEFAULT 0,
      other_cost     REAL DEFAULT 0,
      landed_cost    REAL DEFAULT 0,
      total          REAL DEFAULT 0,
      notes          TEXT DEFAULT '',
      user_id        INTEGER REFERENCES users(id),
      cajero         TEXT DEFAULT '',
      received_at    TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id    INTEGER NOT NULL REFERENCES purchase_orders(id),
      product_id           INTEGER REFERENCES products(id),
      product_code         TEXT DEFAULT '',
      product_name         TEXT NOT NULL,
      unit_cost            REAL NOT NULL DEFAULT 0,
      landed_unit_cost     REAL DEFAULT 0,
      allocated_extra_cost REAL DEFAULT 0,
      qty_ordered          INTEGER NOT NULL DEFAULT 0,
      qty_received         INTEGER NOT NULL DEFAULT 0,
      subtotal             REAL DEFAULT 0
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
                        CHECK(type IN ('carro','camioneta','moto','camion','furgoneta','otro')),
      brand           TEXT NOT NULL,
      model           TEXT NOT NULL,
      year            INTEGER,
      plate           TEXT,
      color           TEXT,
      fuel_type       TEXT DEFAULT 'gasolina'
                        CHECK(fuel_type IN ('gasolina','diesel','glp','gnv','electrico','hibrido')),
      fuel_grade      TEXT DEFAULT 'premium'
                        CHECK(fuel_grade IN ('premium','regular','diesel','gasoil_regular','glp','gnv','ninguno')),
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
      expense_id      INTEGER REFERENCES expenses(id),
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
      customer_contact_id INTEGER REFERENCES customer_contacts(id),
      customer_contact_name TEXT DEFAULT '',
      customer_contact_role TEXT DEFAULT '',
      customer_contact_phone TEXT DEFAULT '',
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
      delivery_type   TEXT DEFAULT 'propio',
      carrier_name    TEXT DEFAULT '',
      carrier_stop    TEXT DEFAULT '',
      carrier_tracking TEXT DEFAULT '',
      carrier_dest    TEXT DEFAULT '',
      expense_id      INTEGER REFERENCES expenses(id),
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
    CREATE INDEX IF NOT EXISTS idx_payments_sale     ON payments(sale_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_inv_product       ON inventory_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_price_hist_product ON product_price_history(product_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_price_hist_date    ON product_price_history(created_at DESC);
    -- idx_price_hist_accounting se crea en migratePriceHistoryAccountingColumns():
    -- en BDs existentes la columna accounting_entry_id aún no existe en este punto.
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_po ON purchase_items(purchase_order_id);
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
    CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id, active);
    CREATE INDEX IF NOT EXISTS idx_customer_contacts_name ON customer_contacts(name) WHERE active=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_contacts_primary
      ON customer_contacts(customer_id) WHERE active=1 AND is_primary=1;
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

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// Clientes empresariales: migración idempotente para instalaciones existentes.
// Todos los registros previos permanecen como persona hasta que el usuario los
// cambie explícitamente; no inferimos el tipo solo por la longitud del documento.
function migrateCustomerCompanies() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_contacts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id          INTEGER NOT NULL REFERENCES customers(id),
      name                 TEXT NOT NULL,
      document             TEXT DEFAULT '',
      role                 TEXT DEFAULT '',
      phone                TEXT DEFAULT '',
      email                TEXT DEFAULT '',
      is_primary           INTEGER DEFAULT 0,
      can_order            INTEGER DEFAULT 1,
      can_receive          INTEGER DEFAULT 1,
      can_receive_invoices INTEGER DEFAULT 1,
      active               INTEGER DEFAULT 1,
      created_at           TEXT DEFAULT (datetime('now','localtime')),
      updated_at           TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  const customerCols = [
    ['customer_type', "TEXT DEFAULT 'person'"],
    ['trade_name', "TEXT DEFAULT ''"],
    ['billing_email', "TEXT DEFAULT ''"],
    ['preferred_price_mode', "TEXT DEFAULT 'retail'"],
    ['notes', "TEXT DEFAULT ''"],
  ];
  const saleCols = [
    ['customer_type', "TEXT DEFAULT 'person'"],
    ['customer_trade_name', "TEXT DEFAULT ''"],
    ['customer_address', "TEXT DEFAULT ''"],
    ['customer_phone', "TEXT DEFAULT ''"],
    ['customer_email', "TEXT DEFAULT ''"],
    ['customer_contact_id', 'INTEGER'],
    ['customer_contact_name', "TEXT DEFAULT ''"],
    ['customer_contact_document', "TEXT DEFAULT ''"],
    ['customer_contact_role', "TEXT DEFAULT ''"],
    ['customer_contact_phone', "TEXT DEFAULT ''"],
    ['customer_contact_email', "TEXT DEFAULT ''"],
  ];
  for (const [col, def] of customerCols) {
    try { db.prepare(`ALTER TABLE customers ADD COLUMN ${col} ${def}`).run(); }
    catch { /* ya existe */ }
  }
  for (const [col, def] of saleCols) {
    try { db.prepare(`ALTER TABLE sales ADD COLUMN ${col} ${def}`).run(); }
    catch { /* ya existe */ }
  }
  const paymentCols = [
    ['customer_contact_id', 'INTEGER'],
    ['customer_contact_name', "TEXT DEFAULT ''"],
    ['customer_contact_document', "TEXT DEFAULT ''"],
    ['customer_contact_role', "TEXT DEFAULT ''"],
    ['customer_contact_phone', "TEXT DEFAULT ''"],
    ['customer_contact_email', "TEXT DEFAULT ''"],
  ];
  if (tableExists('payments')) {
    for (const [col, def] of paymentCols) {
      try { db.prepare(`ALTER TABLE payments ADD COLUMN ${col} ${def}`).run(); }
      catch { /* ya existe */ }
    }
  }
  // Conduce se crea mediante versioning en instalaciones nuevas. En bases que
  // ya lo tienen, adelantamos estas columnas para que el repositorio sea seguro
  // incluso antes de ejecutar el migrador de versión.
  if (tableExists('delivery_notes')) {
    const deliveryNoteCols = [
      ['customer_contact_id', 'INTEGER'],
      ['customer_contact_name', "TEXT DEFAULT ''"],
      ['customer_contact_document', "TEXT DEFAULT ''"],
      ['customer_contact_role', "TEXT DEFAULT ''"],
      ['customer_contact_phone', "TEXT DEFAULT ''"],
      ['customer_contact_email', "TEXT DEFAULT ''"],
    ];
    for (const [col, def] of deliveryNoteCols) {
      try { db.prepare(`ALTER TABLE delivery_notes ADD COLUMN ${col} ${def}`).run(); }
      catch { /* ya existe */ }
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id, active);
    CREATE INDEX IF NOT EXISTS idx_customer_contacts_name ON customer_contacts(name) WHERE active=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_contacts_primary
      ON customer_contacts(customer_id) WHERE active=1 AND is_primary=1;
    CREATE INDEX IF NOT EXISTS idx_payments_customer_contact ON payments(customer_contact_id);
  `);
}

// Mejoras operativas del POS. Corre en cada arranque para que una base creada
// por una versión intermedia también quede completa aunque ya figure una
// migración de versión como aplicada.
function migrateSalesWorkflowEnhancements() {
  const addCol = (table, col, def) => {
    if (!tableExists(table)) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_phones (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      phone_type  TEXT NOT NULL DEFAULT 'telefono'
                    CHECK(phone_type IN ('telefono','celular','flota')),
      phone       TEXT NOT NULL,
      is_primary  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now','localtime')),
      updated_at  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_phones_customer
      ON customer_phones(customer_id,active);
    CREATE INDEX IF NOT EXISTS idx_customer_phones_phone
      ON customer_phones(phone) WHERE active=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_phones_primary
      ON customer_phones(customer_id) WHERE active=1 AND is_primary=1;

    CREATE TABLE IF NOT EXISTS sale_charges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id     INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount      REAL NOT NULL CHECK(amount >= 0),
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_sale_charges_sale ON sale_charges(sale_id);
  `);

  addCol('sales', 'customer_phone_type', "TEXT DEFAULT 'telefono'");
  addCol('sales', 'additional_charges_total', 'REAL DEFAULT 0');
  addCol('sales', 'display_currency', "TEXT DEFAULT 'DOP'");
  addCol('sales', 'display_exchange_rate', 'REAL DEFAULT 1');
  addCol('sales', 'display_amount', 'REAL DEFAULT 0');

  // Llevar el teléfono legacy a la colección nueva sin duplicarlo.
  db.prepare(`
    INSERT INTO customer_phones(customer_id,phone_type,phone,is_primary)
    SELECT c.id,'telefono',TRIM(c.phone),1
    FROM customers c
    WHERE TRIM(COALESCE(c.phone,''))<>''
      AND NOT EXISTS (
        SELECT 1 FROM customer_phones p
        WHERE p.customer_id=c.id AND p.active=1
      )
  `).run();
}

function migratePriceHistoryAccountingColumns() {
  try {
    if (!tableExists('product_price_history')) return;
    const cols = db.prepare('PRAGMA table_info(product_price_history)').all().map(c => c.name);
    if (!cols.includes('accounting_entry_id')) {
      db.prepare('ALTER TABLE product_price_history ADD COLUMN accounting_entry_id INTEGER DEFAULT NULL').run();
      console.log('[MIGRATE] product_price_history.accounting_entry_id agregada');
    }
    if (!cols.includes('accounting_error')) {
      db.prepare("ALTER TABLE product_price_history ADD COLUMN accounting_error TEXT DEFAULT ''").run();
      console.log('[MIGRATE] product_price_history.accounting_error agregada');
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_price_hist_accounting ON product_price_history(accounting_entry_id)').run();
  } catch (e) {
    console.error('[MIGRATE] product_price_history contabilidad:', e.message);
  }
}

// ── Migración módulo vehículos/envíos (segura e idempotente) ─────────────────
// 1) SQLite no permite editar un CHECK: si la tabla vehicles existe con el CHECK
//    viejo (sin 'camioneta'/'glp'), se reconstruye copiando los datos (ids se
//    preservan, así deliveries/vehicle_maintenance no pierden sus referencias).
// 2) Columnas nuevas de deliveries (expreso/parada + enlace a gasto) y de
//    vehicle_maintenance (enlace a gasto) vía ALTER TABLE.
function migrateVehiclesModule() {
  try {
    const tblSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vehicles'").get()?.sql || '';
    if (tblSql && (!tblSql.includes("'camioneta'") || !tblSql.includes("'glp'") || !tblSql.includes("'ninguno'"))) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE vehicles_new (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            type            TEXT NOT NULL DEFAULT 'carro'
                              CHECK(type IN ('carro','camioneta','moto','camion','furgoneta','otro')),
            brand           TEXT NOT NULL,
            model           TEXT NOT NULL,
            year            INTEGER,
            plate           TEXT,
            color           TEXT,
            fuel_type       TEXT DEFAULT 'gasolina'
                              CHECK(fuel_type IN ('gasolina','diesel','glp','gnv','electrico','hibrido')),
            fuel_grade      TEXT DEFAULT 'premium'
                              CHECK(fuel_grade IN ('premium','regular','diesel','gasoil_regular','glp','gnv','ninguno')),
            km_per_gallon   REAL DEFAULT 35,
            odometer        REAL DEFAULT 0,
            status          TEXT DEFAULT 'activo'
                              CHECK(status IN ('activo','inactivo','taller')),
            notes           TEXT,
            user_id         INTEGER REFERENCES users(id),
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now'))
          );
        `);
        db.exec(`INSERT INTO vehicles_new(id,type,brand,model,year,plate,color,fuel_type,fuel_grade,
                   km_per_gallon,odometer,status,notes,user_id,created_at,updated_at)
                 SELECT id,type,brand,model,year,plate,color,fuel_type,fuel_grade,
                   km_per_gallon,odometer,status,notes,user_id,created_at,updated_at FROM vehicles`);
        db.exec('DROP TABLE vehicles');
        db.exec('ALTER TABLE vehicles_new RENAME TO vehicles');
      })();
      db.pragma('foreign_keys = ON');
      console.log('[MIGRATE] vehicles: tipos ampliados (camioneta, GLP, GNV)');
    }

    const addCol = (table, col, def) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes(col)) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
        console.log(`[MIGRATE] ${table}.${col} agregada`);
      }
    };
    addCol('deliveries', 'delivery_type',    "TEXT DEFAULT 'propio'");
    addCol('deliveries', 'carrier_name',     "TEXT DEFAULT ''");
    addCol('deliveries', 'carrier_stop',     "TEXT DEFAULT ''");
    addCol('deliveries', 'carrier_tracking', "TEXT DEFAULT ''");
    addCol('deliveries', 'carrier_dest',     "TEXT DEFAULT ''");
    addCol('deliveries', 'expense_id',       'INTEGER DEFAULT NULL');
    // Cliente NO registrado: nombre libre sin exigir alta en Clientes.
    addCol('deliveries', 'customer_name',    "TEXT DEFAULT ''");
    addCol('deliveries', 'customer_contact_id', 'INTEGER DEFAULT NULL');
    addCol('deliveries', 'customer_contact_name', "TEXT DEFAULT ''");
    addCol('deliveries', 'customer_contact_role', "TEXT DEFAULT ''");
    addCol('deliveries', 'customer_contact_phone', "TEXT DEFAULT ''");
    addCol('vehicle_maintenance', 'expense_id', 'INTEGER DEFAULT NULL');
  } catch (e) {
    db.pragma('foreign_keys = ON');
    console.error('[MIGRATE] vehiculos/envios:', e.message);
  }
}

function migrateTaxColumns() {
  const productCols = [
    { col: 'taxable', def: 'INTEGER NOT NULL DEFAULT 1' },
    { col: 'tax_pct', def: 'REAL NOT NULL DEFAULT 18' },
  ];
  productCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE products ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE] products.${col} agregada`);
    } catch { /* ya existe */ }
  });

  const saleItemCols = [
    { col: 'taxable',      def: 'INTEGER DEFAULT NULL' },
    { col: 'tax_pct',      def: 'REAL DEFAULT NULL' },
    { col: 'tax_amt',      def: 'REAL DEFAULT NULL' },
    { col: 'net_subtotal', def: 'REAL DEFAULT NULL' },
  ];
  saleItemCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE sale_items ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE] sale_items.${col} agregada`);
    } catch { /* ya existe */ }
  });
}

function migratePurchaseColumns() {
  const orderCols = [
    { col: 'tax_amt',        def: 'REAL DEFAULT 0' },
    { col: 'freight_cost',   def: 'REAL DEFAULT 0' },
    { col: 'customs_cost',   def: 'REAL DEFAULT 0' },
    { col: 'transport_cost', def: 'REAL DEFAULT 0' },
    { col: 'other_cost',     def: 'REAL DEFAULT 0' },
    { col: 'landed_cost',    def: 'REAL DEFAULT 0' },
  ];
  orderCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE purchase_orders ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE] purchase_orders.${col} agregada`);
    } catch { /* ya existe */ }
  });

  const itemCols = [
    { col: 'landed_unit_cost',     def: 'REAL DEFAULT 0' },
    { col: 'allocated_extra_cost', def: 'REAL DEFAULT 0' },
  ];
  itemCols.forEach(({ col, def }) => {
    try {
      db.prepare(`ALTER TABLE purchase_items ADD COLUMN ${col} ${def}`).run();
      console.log(`[MIGRATE] purchase_items.${col} agregada`);
    } catch { /* ya existe */ }
  });
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
    // Saldo individual informado por el sistema de origen. Es NULL para ventas
    // nativas; permite conservar exactamente qué facturas históricas siguen
    // abiertas sin reconstruirlas desde el balance agregado del cliente.
    { col: 'source_balance',     def: 'REAL DEFAULT NULL' },
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
    `CREATE INDEX IF NOT EXISTS idx_payments_sale          ON payments(sale_id)`,
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

// ── Numeración documental interna ──────────────────────────────────────────
// El ID de una fila es una llave técnica, no el número que debe ver el cliente.
// Cada familia documental mantiene su propio correlativo; los NCF continúan
// siendo administrados exclusivamente por ncf_sequences (rangos DGII).
const DOCUMENT_SEQUENCE_DEFAULTS = {
  factura_contado: { prefix: 'FAC', pad: 6 },
  factura_credito: { prefix: 'FCR', pad: 6 },
  cotizacion:      { prefix: 'COT', pad: 6 },
  nota_credito:    { prefix: 'NCR', pad: 6 },
  abono:           { prefix: 'ABO', pad: 6 },
  recibo:          { prefix: 'REC', pad: 6 },
  pago_proveedor:  { prefix: 'PPR', pad: 6 },
  conduce:         { prefix: 'CON', pad: 6 },
  reporte:         { prefix: 'REP', pad: 6 },
};

function documentKindForSale(type, paymentMethod) {
  if (type === 'cotizacion') return 'cotizacion';
  if (type === 'devolucion') return 'nota_credito';
  return String(paymentMethod || '').toLowerCase() === 'credito'
    ? 'factura_credito'
    : 'factura_contado';
}

function _issueDocumentNumber(kind, sourceType, sourceId) {
  const cfg = DOCUMENT_SEQUENCE_DEFAULTS[kind];
  if (!cfg) throw new Error(`Tipo documental no soportado: ${kind}`);
  const source = String(sourceType || '').trim();
  const sourceKey = sourceId == null ? '' : String(sourceId);
  if (source && sourceKey) {
    const existing = db.prepare(`
      SELECT kind,sequence_number,formatted_number
      FROM document_issues
      WHERE kind=? AND source_type=? AND source_id=?
    `).get(kind, source, sourceKey);
    if (existing) return existing;
  }

  db.prepare(`
    INSERT INTO document_sequences(kind,prefix,current,pad_length)
    VALUES(?,?,0,?)
    ON CONFLICT(kind) DO NOTHING
  `).run(kind, cfg.prefix, cfg.pad);
  const seq = db.prepare('SELECT * FROM document_sequences WHERE kind=?').get(kind);
  const next = Number(seq.current || 0) + 1;
  db.prepare(`
    UPDATE document_sequences
    SET current=?,updated_at=datetime('now','localtime')
    WHERE kind=?
  `).run(next, kind);
  const formatted = `${seq.prefix}-${String(next).padStart(Number(seq.pad_length) || cfg.pad, '0')}`;
  db.prepare(`
    INSERT INTO document_issues(
      kind,sequence_number,formatted_number,source_type,source_id,status
    ) VALUES(?,?,?,?,?,'active')
  `).run(kind, next, formatted, source, sourceKey);
  return { kind, sequence_number: next, formatted_number: formatted };
}

function migrateDocumentNumbering() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_sequences (
      kind       TEXT PRIMARY KEY,
      prefix     TEXT NOT NULL,
      current    INTEGER NOT NULL DEFAULT 0,
      pad_length INTEGER NOT NULL DEFAULT 6,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS document_issues (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      kind             TEXT NOT NULL,
      sequence_number  INTEGER NOT NULL,
      formatted_number TEXT NOT NULL,
      source_type      TEXT DEFAULT '',
      source_id        TEXT DEFAULT '',
      status           TEXT DEFAULT 'active' CHECK(status IN ('active','cancelled','deleted')),
      created_at       TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(kind, sequence_number),
      UNIQUE(kind, source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_issues_source
      ON document_issues(source_type,source_id);
  `);
  for (const [kind, cfg] of Object.entries(DOCUMENT_SEQUENCE_DEFAULTS)) {
    db.prepare(`
      INSERT INTO document_sequences(kind,prefix,current,pad_length)
      VALUES(?,?,0,?)
      ON CONFLICT(kind) DO NOTHING
    `).run(kind, cfg.prefix, cfg.pad);
  }

  const add = (table, col, def) => {
    if (!tableExists(table)) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
  };
  [['sales','document_kind',"TEXT DEFAULT ''"],
   ['sales','document_number','INTEGER'],
   ['sales','document_number_fmt',"TEXT DEFAULT ''"],
   ['sales','receipt_document_number','INTEGER'],
   ['sales','receipt_document_number_fmt',"TEXT DEFAULT ''"],
   ['payments','document_kind',"TEXT DEFAULT ''"],
   ['payments','document_number','INTEGER'],
   ['payments','document_number_fmt',"TEXT DEFAULT ''"],
   ['expense_payments','document_kind',"TEXT DEFAULT ''"],
   ['expense_payments','document_number','INTEGER'],
   ['expense_payments','document_number_fmt',"TEXT DEFAULT ''"]]
    .forEach(([table, col, def]) => add(table, col, def));

  // Solo numeramos registros nativos. Los importados conservan exactamente el
  // número histórico que traían del sistema anterior.
  const tx = db.transaction(() => {
    const nativeSales = db.prepare(`
      SELECT id,type,payment_method
      FROM sales
      WHERE COALESCE(import_source,'')=''
        AND COALESCE(document_number_fmt,'')=''
      ORDER BY id
    `).all();
    for (const sale of nativeSales) {
      const kind = documentKindForSale(sale.type, sale.payment_method);
      const issued = _issueDocumentNumber(kind, 'sale', sale.id);
      db.prepare(`
        UPDATE sales SET document_kind=?,document_number=?,document_number_fmt=?
        WHERE id=?
      `).run(kind, issued.sequence_number, issued.formatted_number, sale.id);
    }

    const nativeReceipts = db.prepare(`
      SELECT id FROM sales
      WHERE COALESCE(import_source,'')=''
        AND type='factura'
        AND LOWER(COALESCE(payment_method,''))!='credito'
        AND COALESCE(receipt_document_number_fmt,'')=''
      ORDER BY id
    `).all();
    for (const sale of nativeReceipts) {
      const issued = _issueDocumentNumber('recibo', 'sale_receipt', sale.id);
      db.prepare(`
        UPDATE sales SET receipt_document_number=?,receipt_document_number_fmt=?
        WHERE id=?
      `).run(issued.sequence_number, issued.formatted_number, sale.id);
    }

    const nativePayments = db.prepare(`
      SELECT id FROM payments
      WHERE COALESCE(import_source,'')=''
        AND COALESCE(document_number_fmt,'')=''
      ORDER BY id
    `).all();
    for (const payment of nativePayments) {
      const issued = _issueDocumentNumber('abono', 'payment', payment.id);
      db.prepare(`
        UPDATE payments SET document_kind='abono',document_number=?,document_number_fmt=?,
          numero_recibo=COALESCE(numero_recibo,?)
        WHERE id=?
      `).run(issued.sequence_number, issued.formatted_number, issued.sequence_number, payment.id);
    }

    const supplierPayments = db.prepare(`
      SELECT id FROM expense_payments
      WHERE COALESCE(document_number_fmt,'')=''
      ORDER BY id
    `).all();
    for (const payment of supplierPayments) {
      const issued = _issueDocumentNumber('pago_proveedor', 'expense_payment', payment.id);
      db.prepare(`
        UPDATE expense_payments
        SET document_kind='pago_proveedor',document_number=?,document_number_fmt=?
        WHERE id=?
      `).run(issued.sequence_number, issued.formatted_number, payment.id);
    }
  });
  tx();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sales_document_number
      ON sales(document_kind,document_number);
    CREATE INDEX IF NOT EXISTS idx_payments_document_number
      ON payments(document_kind,document_number);
    CREATE INDEX IF NOT EXISTS idx_expense_payments_document_number
      ON expense_payments(document_kind,document_number);
  `);
}

const documentNumberRepo = {
  issue(kind, sourceType = '', sourceId = '') {
    return db.transaction(() => _issueDocumentNumber(kind, sourceType, sourceId))();
  },
  get(kind, sourceType, sourceId) {
    return db.prepare(`
      SELECT kind,sequence_number,formatted_number,status,created_at
      FROM document_issues WHERE kind=? AND source_type=? AND source_id=?
    `).get(kind, String(sourceType || ''), String(sourceId ?? '')) || null;
  },
  markStatus(kind, sourceType, sourceId, status) {
    if (!['active','cancelled','deleted'].includes(status)) throw new Error('Estado documental inválido');
    db.prepare(`
      UPDATE document_issues SET status=?
      WHERE kind=? AND source_type=? AND source_id=?
    `).run(status, kind, String(sourceType || ''), String(sourceId ?? ''));
  },
  getSequences() {
    return db.prepare(`
      SELECT kind,prefix,current,pad_length,updated_at
      FROM document_sequences
      ORDER BY kind
    `).all();
  },
  updateSequence(kind, { prefix, current, padLength } = {}) {
    const cfg = DOCUMENT_SEQUENCE_DEFAULTS[kind];
    if (!cfg) throw new Error('Tipo documental no soportado');
    const cleanPrefix = String(prefix || cfg.prefix).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
    const cleanCurrent = Math.max(0, Math.floor(Number(current) || 0));
    const cleanPad = Math.max(3, Math.min(12, Math.floor(Number(padLength) || cfg.pad)));
    const issuedMax = db.prepare(
      'SELECT COALESCE(MAX(sequence_number),0) AS n FROM document_issues WHERE kind=?'
    ).get(kind)?.n || 0;
    if (cleanCurrent < issuedMax) {
      throw new Error(`La secuencia no puede retroceder por debajo de ${issuedMax}; esos números ya fueron emitidos`);
    }
    db.prepare(`
      UPDATE document_sequences
      SET prefix=?,current=?,pad_length=?,updated_at=datetime('now','localtime')
      WHERE kind=?
    `).run(cleanPrefix || cfg.prefix, cleanCurrent, cleanPad, kind);
    return db.prepare('SELECT * FROM document_sequences WHERE kind=?').get(kind);
  },
};

function migrateECFColumns() {
  const cols = ['ecf_status', 'ecf_qr', 'ecf_pdf', 'ecf_sent_at'];
  cols.forEach(col => {
    try {
      db.prepare(`ALTER TABLE sales ADD COLUMN ${col} TEXT`).run();
      console.log(`[DB] Columna ${col} agregada a sales`);
    } catch { /* ya existe */ }
  });
  ensureSalespeopleSchema(db);
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
    ['printer_profile',''],
    ['printer_width_mm','80'],
    ['printer_dpi',    '203'],
    ['receipt_msg',    '¡Gracias por su compra!'],
    ['password_changed','0'],
    ['pos_price_change_password_hash',''],
    ['ncf_counter',    '0'],
    ['barcode_enabled','0'],
    ['barcode_printer',''],
    ['barcode_printer_profile',''],
    ['barcode_media_width_mm','100'],
    ['barcode_printer_dpi','203'],
    ['barcode_media_mode','gap'],
    ['barcode_design', ''],
    // ── Módulos activables por superadmin ──────────
    ['module_sucursales',      '0'],
    ['module_vehiculos',       '0'],
    ['module_mantenimiento',   '0'],
    ['module_envios',          '0'],
    ['module_ncf_avanzado',    '0'],
    ['module_multi_negocio',   '0'],
    ['module_vendedores',      '1'],
    ['module_vendedores_roles','admin'],
    ['module_preventa',        '1'],
    ['module_preventa_roles',  'admin,cajero'],
    ['checkout_notifications_sound','1'],
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

function normalizeTaxable(value, fallback = 1) {
  const v = value === undefined || value === null || value === ''
    ? fallback
    : value;
  return (v === 0 || v === false || v === '0' || v === 'false') ? 0 : 1;
}

function normalizeTaxPct(value, fallback = 18) {
  const f = Number.parseFloat(fallback);
  const n = Number.parseFloat(value);
  const picked = Number.isFinite(n) ? n : (Number.isFinite(f) ? f : 18);
  return Math.max(0, Math.min(100, picked));
}

function configuredTaxPct() {
  const row = db.prepare("SELECT value FROM settings WHERE key='tax_pct'").get();
  return normalizeTaxPct(row?.value, 18);
}

function calcIncludedTaxTotals(items, { type = 'factura', discPct = 0 } = {}) {
  const discountPct = Math.max(0, Math.min(100, Number.parseFloat(discPct) || 0));
  const grossSubtotal = round2(items.reduce((a, i) => {
    const qty = Number.parseFloat(i.qty) || 0;
    const price = Number.parseFloat(i.unit_price) || 0;
    return a + (price * qty);
  }, 0));
  const discountFactor = 1 - (discountPct / 100);
  const discAmt = round2(grossSubtotal * (discountPct / 100));
  const total = round2(grossSubtotal - discAmt);

  let netAcc = 0;
  let taxAcc = 0;
  for (const item of items) {
    const qty = Number.parseFloat(item.qty) || 0;
    const price = Number.parseFloat(item.unit_price) || 0;
    const lineGross = price * qty;
    const lineAfterDiscount = lineGross * discountFactor;
    const taxable = type === 'factura' && normalizeTaxable(item.taxable, 1) === 1;
    const taxPct = taxable ? normalizeTaxPct(item.tax_pct, 18) : 0;
    const lineNet = taxable && taxPct > 0
      ? lineAfterDiscount / (1 + (taxPct / 100))
      : lineAfterDiscount;
    const lineTax = lineAfterDiscount - lineNet;
    item.net_subtotal = round2(lineNet);
    item.tax_amt = round2(lineTax);
    item.taxable = taxable ? 1 : 0;
    item.tax_pct = taxPct;
    netAcc += lineNet;
    taxAcc += lineTax;
  }

  const taxAmt = type === 'factura' ? round2(taxAcc) : 0;
  const subtotal = round2(total - taxAmt);
  return { subtotal, grossSubtotal, discAmt, taxAmt, total, discPct: discountPct };
}

function moneyVal(value) {
  return round2(Number.parseFloat(value) || 0);
}

function normalizePurchaseCosts(costs = {}) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (costs[key] !== undefined && costs[key] !== null) return moneyVal(costs[key]);
    }
    return 0;
  };
  const freight = Math.max(0, pick('freight', 'freight_cost', 'flete'));
  const customs = Math.max(0, pick('customs', 'customs_cost', 'aduana'));
  const transport = Math.max(0, pick('transport', 'transport_cost', 'transporte'));
  const other = Math.max(0, pick('other', 'other_cost', 'otros'));
  return {
    freight,
    customs,
    transport,
    other,
    totalExtra: round2(freight + customs + transport + other),
  };
}

function allocatePurchaseCosts(rows, costs = {}) {
  const normalized = normalizePurchaseCosts(costs);
  const positiveRows = (rows || [])
    .map(row => ({
      ...row,
      qty_received: Math.max(0, Number.parseInt(row.qty_received, 10) || 0),
      unit_cost: moneyVal(row.unit_cost),
    }))
    .filter(row => row.qty_received > 0);
  const baseTotal = round2(positiveRows.reduce((sum, row) => (
    sum + round2(row.unit_cost * row.qty_received)
  ), 0));

  let assignedExtra = 0;
  const lastIndex = positiveRows.length - 1;
  const items = positiveRows.map((row, idx) => {
    const baseLine = round2(row.unit_cost * row.qty_received);
    let allocatedExtra = 0;
    if (normalized.totalExtra > 0 && baseTotal > 0) {
      allocatedExtra = idx === lastIndex
        ? round2(normalized.totalExtra - assignedExtra)
        : round2(normalized.totalExtra * (baseLine / baseTotal));
      assignedExtra = round2(assignedExtra + allocatedExtra);
    }
    const landedLine = round2(baseLine + allocatedExtra);
    const landedUnitCost = row.qty_received > 0
      ? round2(landedLine / row.qty_received)
      : row.unit_cost;
    return { ...row, baseLine, allocatedExtra, landedLine, landedUnitCost };
  });

  return {
    ...normalized,
    baseTotal,
    landedTotal: round2(baseTotal + normalized.totalExtra),
    items,
  };
}

function priceFieldChanged(before, after) {
  return Math.abs(moneyVal(after) - moneyVal(before)) >= 0.005;
}

function recordProductPriceHistory(productId, before, after, opts = {}) {
  if (!before || !after) return null;

  const costBefore = moneyVal(before.cost);
  const costAfter = moneyVal(after.cost);
  const priceBefore = moneyVal(before.price);
  const priceAfter = moneyVal(after.price);
  const wholesaleBefore = moneyVal(before.wholesale);
  const wholesaleAfter = moneyVal(after.wholesale);

  const changed = priceFieldChanged(costBefore, costAfter)
    || priceFieldChanged(priceBefore, priceAfter)
    || priceFieldChanged(wholesaleBefore, wholesaleAfter);
  if (!changed) return null;

  const stockRaw = opts.stockAtChange ?? before.stock ?? after.stock ?? 0;
  const stockAtChange = Math.max(0, Number.parseInt(stockRaw, 10) || 0);
  const costDelta = round2(costAfter - costBefore);
  const priceDelta = round2(priceAfter - priceBefore);
  const wholesaleDelta = round2(wholesaleAfter - wholesaleBefore);

  const r = db.prepare(`
    INSERT INTO product_price_history(
      product_id, product_code, product_name,
      cost_before, cost_after, price_before, price_after,
      wholesale_before, wholesale_after, stock_at_change,
      cost_delta, price_delta, wholesale_delta,
      stock_value_delta, retail_value_delta, wholesale_value_delta,
      source, reason, user_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    productId,
    after.code || before.code || '',
    after.name || before.name || '',
    costBefore, costAfter,
    priceBefore, priceAfter,
    wholesaleBefore, wholesaleAfter,
    stockAtChange,
    costDelta, priceDelta, wholesaleDelta,
    round2(costDelta * stockAtChange),
    round2(priceDelta * stockAtChange),
    round2(wholesaleDelta * stockAtChange),
    opts.source || 'manual',
    opts.reason || '',
    opts.userId || null
  );
  return r.lastInsertRowid;
}

function buildDateFilter(column, { range = 'month', dateFrom = null, dateTo = null } = {}) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const safeFrom = (range === 'custom' && dateFrom && DATE_RE.test(dateFrom)) ? dateFrom : null;
  const safeTo = (range === 'custom' && dateTo && DATE_RE.test(dateTo)) ? dateTo : null;

  if (range === 'custom' && safeFrom && safeTo) {
    return { sql: `date(${column}) BETWEEN ? AND ?`, params: [safeFrom, safeTo] };
  }
  if (range === 'today') return { sql: `date(${column}) = date('now','localtime')`, params: [] };
  if (range === 'week') return { sql: `date(${column}) >= date('now','-6 days','localtime')`, params: [] };
  if (range === 'all') return { sql: '1=1', params: [] };
  return {
    sql: `strftime('%Y-%m',${column}) = strftime('%Y-%m','now','localtime')`,
    params: [],
  };
}

// ── Productos ─────────────────────────────────
const productsRepo = {
  getAll() {
    const hasAccountingEntries = tableExists('accounting_entries');
    const accountingSelect = hasAccountingEntries
      ? `h.accounting_entry_id   AS last_price_change_accounting_entry_id,
             ae.number               AS last_price_change_accounting_number,
             ae.status               AS last_price_change_accounting_status,`
      : `h.accounting_entry_id   AS last_price_change_accounting_entry_id,
             NULL                    AS last_price_change_accounting_number,
             NULL                    AS last_price_change_accounting_status,`;
    const accountingJoin = hasAccountingEntries
      ? 'LEFT JOIN accounting_entries ae ON ae.id = h.accounting_entry_id'
      : '';
    return db.prepare(`
      SELECT p.*,
             COALESCE((
               SELECT SUM(coi.qty)
               FROM checkout_order_items coi
               JOIN checkout_orders co ON co.id=coi.order_id
               WHERE coi.product_id=p.id AND co.status='pending'
                 AND co.expires_at > datetime('now','localtime')
             ),0) AS reserved_stock,
             h.id                    AS last_price_change_id,
             h.cost_before           AS last_cost_before,
             h.cost_after            AS last_cost_after,
             h.price_before          AS last_price_before,
             h.price_after           AS last_price_after,
             h.wholesale_before      AS last_wholesale_before,
             h.wholesale_after       AS last_wholesale_after,
             h.stock_at_change       AS last_stock_at_change,
             h.cost_delta            AS last_cost_delta,
             h.price_delta           AS last_price_delta,
             h.wholesale_delta       AS last_wholesale_delta,
             h.stock_value_delta     AS last_stock_value_delta,
             h.retail_value_delta    AS last_retail_value_delta,
             h.wholesale_value_delta AS last_wholesale_value_delta,
             h.source                AS last_price_change_source,
             h.reason                AS last_price_change_reason,
             ${accountingSelect}
             h.created_at            AS last_price_changed_at
      FROM products p
      LEFT JOIN product_price_history h ON h.id = (
        SELECT id FROM product_price_history
        WHERE product_id = p.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      ${accountingJoin}
      WHERE p.active=1
      ORDER BY p.name
    `).all();
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
    // Sin código de barras propio → usar el código del artículo como barcode.
    // Así toda etiqueta impresa es escaneable en el POS sin configurar nada.
    const barcode = String(p.barcode || '').trim() || String(p.code || '').trim();
    const r = db.prepare(`
      INSERT INTO products(code,barcode,name,brand,category,description,model,cost,price,wholesale,taxable,tax_pct,stock,stock_min,unit,condition)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(p.code,barcode,p.name,p.brand||'',p.category||'',p.description||'',
           p.model||'',p.cost,p.price,p.wholesale||p.price,
           normalizeTaxable(p.taxable, 1), normalizeTaxPct(p.tax_pct, 18),
           p.stock||0,p.stock_min||5,p.unit||'und', p.condition||'nuevo');
    return r.lastInsertRowid;
  },
  update(id, p, opts = {}) {
    return db.transaction(() => {
      const before = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!before) throw new Error('Producto no encontrado');

      // Igual que en create(): barcode vacío → código del artículo.
      const barcode = String(p.barcode || '').trim() || String(p.code || '').trim();
      db.prepare(`
        UPDATE products SET code=?,barcode=?,name=?,brand=?,category=?,description=?,model=?,
        cost=?,price=?,wholesale=?,taxable=?,tax_pct=?,stock_min=?,unit=?,condition=?,updated_at=datetime('now')
        WHERE id=?
      `).run(p.code,barcode,p.name,p.brand||'',p.category||'',p.description||'',
             p.model||'',p.cost,p.price,p.wholesale||p.price,
             normalizeTaxable(p.taxable, 1), normalizeTaxPct(p.tax_pct, 18),
             p.stock_min||5,p.unit||'und', p.condition||'nuevo',id);

      const after = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      const historyId = recordProductPriceHistory(id, before, after, {
        userId: opts.userId,
        source: opts.source || 'manual',
        reason: opts.reason || 'Edición de producto',
        stockAtChange: opts.stockAtChange,
      });
      return { historyId };
    })();
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
  getPriceHistory(productId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 100));
    const hasAccountingEntries = tableExists('accounting_entries');
    const accountingSelect = hasAccountingEntries
      ? ', ae.number as accounting_entry_number, ae.status as accounting_entry_status'
      : ', NULL as accounting_entry_number, NULL as accounting_entry_status';
    const accountingJoin = hasAccountingEntries
      ? 'LEFT JOIN accounting_entries ae ON ae.id = h.accounting_entry_id'
      : '';
    return db.prepare(`
      SELECT h.*, u.name as user_name${accountingSelect}
      FROM product_price_history h
      LEFT JOIN users u ON u.id = h.user_id
      ${accountingJoin}
      WHERE h.product_id=?
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT ?
    `).all(productId, safeLimit);
  },
};

// ── Clientes ──────────────────────────────────
function normalizeCustomerType(value) {
  return value === 'company' ? 'company' : 'person';
}

function assertUniqueCustomerDocument(rnc, excludeId = null) {
  const digits = String(rnc || '').replace(/\D/g, '');
  if (!digits) return;
  const rows = db.prepare(`SELECT id,rnc,name FROM customers WHERE active=1 AND (? IS NULL OR id<>?)`).all(excludeId, excludeId);
  const duplicate = rows.find(row => String(row.rnc || '').replace(/\D/g, '') === digits);
  if (duplicate) throw new Error(`Ese RNC/Cédula ya pertenece a ${duplicate.name}`);
}

function contactsForCustomer(customerId) {
  return db.prepare(`
    SELECT * FROM customer_contacts
    WHERE customer_id=? AND active=1
    ORDER BY is_primary DESC,name COLLATE NOCASE
  `).all(customerId);
}

function phonesForCustomer(customerId) {
  if (!tableExists('customer_phones')) return [];
  return db.prepare(`
    SELECT id,customer_id,phone_type,phone,is_primary,active
    FROM customer_phones
    WHERE customer_id=? AND active=1
    ORDER BY is_primary DESC,id
  `).all(customerId);
}

function normalizeCustomerPhones(input, legacyPhone = '') {
  const allowed = new Set(['telefono', 'celular', 'flota']);
  const rows = Array.isArray(input) ? input : [];
  const clean = rows.map((row, index) => ({
    phone_type: allowed.has(String(row?.phone_type || row?.type || '').toLowerCase())
      ? String(row.phone_type || row.type).toLowerCase() : 'telefono',
    phone: String(row?.phone || row?.number || '').trim().slice(0, 40),
    is_primary: row?.is_primary ? 1 : 0,
    _index: index,
  })).filter(row => row.phone);
  if (!clean.length && String(legacyPhone || '').trim()) {
    clean.push({ phone_type: 'telefono', phone: String(legacyPhone).trim().slice(0, 40), is_primary: 1, _index: 0 });
  }
  if (clean.length && !clean.some(row => row.is_primary)) clean[0].is_primary = 1;
  let foundPrimary = false;
  clean.forEach(row => {
    if (row.is_primary && !foundPrimary) foundPrimary = true;
    else row.is_primary = 0;
    delete row._index;
  });
  return clean.slice(0, 12);
}

function replaceCustomerPhones(customerId, phones, legacyPhone = '') {
  if (!tableExists('customer_phones')) return [];
  const clean = normalizeCustomerPhones(phones, legacyPhone);
  db.prepare("UPDATE customer_phones SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE customer_id=?").run(customerId);
  const ins = db.prepare(`
    INSERT INTO customer_phones(customer_id,phone_type,phone,is_primary,active)
    VALUES(?,?,?,?,1)
  `);
  clean.forEach(row => ins.run(customerId, row.phone_type, row.phone, row.is_primary));
  const primary = clean.find(row => row.is_primary) || clean[0];
  db.prepare("UPDATE customers SET phone=?,updated_at=datetime('now') WHERE id=?")
    .run(primary?.phone || '', customerId);
  return phonesForCustomer(customerId);
}

function ensurePrimaryCustomerContact(customerId) {
  const primary = db.prepare(`SELECT id FROM customer_contacts WHERE customer_id=? AND active=1 AND is_primary=1 LIMIT 1`).get(customerId);
  if (primary) return primary.id;
  const first = db.prepare(`SELECT id FROM customer_contacts WHERE customer_id=? AND active=1 ORDER BY id LIMIT 1`).get(customerId);
  if (first) db.prepare('UPDATE customer_contacts SET is_primary=1 WHERE id=?').run(first.id);
  return first?.id || null;
}

const customersRepo = {
  getAll() {
    return db.prepare('SELECT * FROM customers WHERE active=1 ORDER BY name').all()
      .map(customer => ({
        ...customer,
        contacts: contactsForCustomer(customer.id),
        phones: phonesForCustomer(customer.id),
      }));
  },
  getById(id) {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    return customer ? {
      ...customer,
      contacts: contactsForCustomer(customer.id),
      phones: phonesForCustomer(customer.id),
    } : null;
  },
  create(c) {
    const name = String(c.name || '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('El nombre del cliente es requerido');
    assertUniqueCustomerDocument(c.rnc);
    const customerType = normalizeCustomerType(c.customer_type);
    const r = db.prepare(`
      INSERT INTO customers(
        name,customer_type,trade_name,rnc,phone,address,email,billing_email,
        preferred_price_mode,notes,credit_limit,credit_days
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      name, customerType, customerType === 'company' ? String(c.trade_name || '').trim() : '',
      String(c.rnc || '').trim(), String(c.phone || '').trim(), String(c.address || '').trim(),
      String(c.email || '').trim(), customerType === 'company' ? String(c.billing_email || '').trim() : '',
      c.preferred_price_mode === 'wholesale' ? 'wholesale' : 'retail', String(c.notes || '').trim(),
      Number(c.credit_limit) || 0, Math.max(1, Number(c.credit_days) || 30)
    );
    replaceCustomerPhones(Number(r.lastInsertRowid), c.phones, c.phone);
    return r.lastInsertRowid;
  },
  update(id, c) {
    const name = String(c.name || '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('El nombre del cliente es requerido');
    assertUniqueCustomerDocument(c.rnc, id);
    const customerType = normalizeCustomerType(c.customer_type);
    db.prepare(`
      UPDATE customers SET name=?,customer_type=?,trade_name=?,rnc=?,phone=?,address=?,email=?,
      billing_email=?,preferred_price_mode=?,notes=?,credit_limit=?,credit_days=?,status=?,updated_at=datetime('now')
      WHERE id=?
    `).run(
      name, customerType, customerType === 'company' ? String(c.trade_name || '').trim() : '',
      String(c.rnc || '').trim(), String(c.phone || '').trim(), String(c.address || '').trim(),
      String(c.email || '').trim(), customerType === 'company' ? String(c.billing_email || '').trim() : '',
      c.preferred_price_mode === 'wholesale' ? 'wholesale' : 'retail', String(c.notes || '').trim(),
      Number(c.credit_limit) || 0, Math.max(1, Number(c.credit_days) || 30), c.status || 'activo', id
    );
    if (customerType !== 'company') {
      db.prepare("UPDATE customer_contacts SET active=0,updated_at=datetime('now','localtime') WHERE customer_id=? AND active=1").run(id);
    }
    replaceCustomerPhones(id, c.phones, c.phone);
  },
  getContacts(customerId) {
    return contactsForCustomer(customerId);
  },
  createContact(customerId, c) {
    const customer = db.prepare("SELECT id,customer_type FROM customers WHERE id=? AND active=1").get(customerId);
    if (!customer) throw new Error('Cliente no encontrado');
    if (customer.customer_type !== 'company') throw new Error('Solo las empresas pueden tener representantes');
    const name = String(c.name || '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('El nombre del representante es requerido');
    return db.transaction(() => {
      const primary = c.is_primary ? 1 : 0;
      if (primary) db.prepare('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?').run(customerId);
      const r = db.prepare(`
        INSERT INTO customer_contacts(
          customer_id,name,document,role,phone,email,is_primary,
          can_order,can_receive,can_receive_invoices
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        customerId, name, String(c.document || '').trim(), String(c.role || '').trim(),
        String(c.phone || '').trim(), String(c.email || '').trim(), primary,
        c.can_order === false || c.can_order === 0 ? 0 : 1,
        c.can_receive === false || c.can_receive === 0 ? 0 : 1,
        c.can_receive_invoices === false || c.can_receive_invoices === 0 ? 0 : 1
      );
      ensurePrimaryCustomerContact(customerId);
      return Number(r.lastInsertRowid);
    })();
  },
  updateContact(id, c) {
    const current = db.prepare('SELECT * FROM customer_contacts WHERE id=? AND active=1').get(id);
    if (!current) throw new Error('Representante no encontrado');
    const name = String(c.name || '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('El nombre del representante es requerido');
    db.transaction(() => {
      const primary = c.is_primary ? 1 : 0;
      if (primary) db.prepare('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?').run(current.customer_id);
      db.prepare(`
        UPDATE customer_contacts SET name=?,document=?,role=?,phone=?,email=?,is_primary=?,
          can_order=?,can_receive=?,can_receive_invoices=?,updated_at=datetime('now','localtime')
        WHERE id=?
      `).run(
        name, String(c.document || '').trim(), String(c.role || '').trim(),
        String(c.phone || '').trim(), String(c.email || '').trim(), primary,
        c.can_order === false || c.can_order === 0 ? 0 : 1,
        c.can_receive === false || c.can_receive === 0 ? 0 : 1,
        c.can_receive_invoices === false || c.can_receive_invoices === 0 ? 0 : 1, id
      );
      ensurePrimaryCustomerContact(current.customer_id);
    })();
    return this.getContacts(current.customer_id);
  },
  deleteContact(id) {
    const current = db.prepare('SELECT * FROM customer_contacts WHERE id=? AND active=1').get(id);
    if (!current) throw new Error('Representante no encontrado');
    db.transaction(() => {
      db.prepare("UPDATE customer_contacts SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE id=?").run(id);
      ensurePrimaryCustomerContact(current.customer_id);
    })();
    return { id, customerId: current.customer_id, name: current.name };
  },
  addPayment({ customerId, amount, method, note, saleId = null, contactId = null, cajero = '', userId = null, sessionId = null }) {
    // VALIDACIONES: prevenir abonos inválidos que corrompan el balance
    if (!amount || amount <= 0) throw new Error('El monto del abono debe ser mayor a cero');
    if (amount > 9999999) throw new Error('Monto de abono excede el límite permitido');
    const cust = db.prepare('SELECT id,customer_type,balance,credit_due FROM customers WHERE id=?').get(customerId);
    if (!cust) throw new Error('Cliente no encontrado');
    if (cust.balance <= 0) throw new Error('El cliente no tiene balance pendiente');
    const before = round2(cust.balance);
    if (amount > before + 0.01) throw new Error(`El abono (${amount.toFixed(2)}) supera el balance actual (${before.toFixed(2)})`);
    const after  = Math.max(0, round2((before - amount)));
    let contact = null;
    if (contactId) {
      contact = db.prepare(`
        SELECT id,name,document,role,phone,email
        FROM customer_contacts
        WHERE id=? AND customer_id=? AND active=1
      `).get(Number(contactId), Number(customerId));
      if (!contact) throw new Error('El representante seleccionado no pertenece a esta empresa o está inactivo');
    }
    const payTx = db.transaction(() => {
      const payInsert = db.prepare(`
        INSERT INTO payments(
          customer_id,sale_id,amount,method,note,balance_before,balance_after,cajero,user_id,cash_session_id,
          customer_contact_id,customer_contact_name,customer_contact_document,customer_contact_role,
          customer_contact_phone,customer_contact_email,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
      `).run(
        customerId, saleId, amount, method, note||'Abono', before, after, cajero, userId, sessionId || null,
        contact?.id || null, contact?.name || '', contact?.document || '', contact?.role || '',
        contact?.phone || '', contact?.email || ''
      );
      const paymentId = payInsert.lastInsertRowid;
      const documentIssue = _issueDocumentNumber('abono', 'payment', paymentId);
      db.prepare(`
        UPDATE payments
        SET document_kind='abono',document_number=?,document_number_fmt=?,
            numero_recibo=COALESCE(numero_recibo,?)
        WHERE id=?
      `).run(
        documentIssue.sequence_number, documentIssue.formatted_number,
        documentIssue.sequence_number, paymentId
      );
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
      return {
        before, after, amount, paymentId,
        document_kind: 'abono',
        document_number: documentIssue.sequence_number,
        document_number_fmt: documentIssue.formatted_number,
        numero_recibo: documentIssue.sequence_number,
        customer_contact_id: contact?.id || null,
        customer_contact_name: contact?.name || '',
        customer_contact_document: contact?.document || '',
        customer_contact_role: contact?.role || '',
        customer_contact_phone: contact?.phone || '',
        customer_contact_email: contact?.email || '',
      };
    });
    return payTx();
  },
  getPayments(customerId) {
    // LEFT JOIN a sales para que la referencia de factura en el historial de
    // abonos muestre el número real (numero_factura_fmt), no el id interno.
    // Alias con prefijo sale_ para no colisionar con columnas de payments.
    return db.prepare(`
      SELECT p.*,
             s.document_number_fmt AS sale_document_number_fmt,
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
    db.transaction(() => {
      db.prepare(`UPDATE customers SET active=0,updated_at=datetime('now') WHERE id=?`).run(id);
      db.prepare(`UPDATE customer_contacts SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE customer_id=?`).run(id);
      db.prepare(`UPDATE customer_phones SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE customer_id=?`).run(id);
    })();
    return { id, name: cust.name, balance: cust.balance || 0 };
  },
  deleteAll() {
    const rows = db.prepare(`SELECT id,balance FROM customers WHERE active=1 AND id != 1`).all();
    const totalBalance = rows.reduce((s, r) => s + (r.balance || 0), 0);
    db.transaction(() => {
      db.prepare(`UPDATE customer_contacts SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE customer_id IN (SELECT id FROM customers WHERE active=1 AND id != 1)`).run();
      db.prepare(`UPDATE customer_phones SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE customer_id IN (SELECT id FROM customers WHERE active=1 AND id != 1)`).run();
      db.prepare(`UPDATE customers SET active=0,updated_at=datetime('now') WHERE active=1 AND id != 1`).run();
    })();
    return { count: rows.length, totalBalance };
  },
};

// ── Caja ──────────────────────────────────────
const cashRepo = {
  // getOpen(terminalId?) — SIN terminalId: comportamiento histórico (la única caja
  // abierta). CON terminalId (multi-terminal): la caja abierta de ESA terminal, con
  // fallback a sesiones legacy sin terminal_id (abiertas antes de actualizar), para
  // no perder ninguna caja abierta. Prefiere la propia sobre la legacy.
  getOpen(terminalId) {
    if (!terminalId) {
      return db.prepare("SELECT * FROM cash_sessions WHERE status='open' LIMIT 1").get();
    }
    return db.prepare(
      "SELECT * FROM cash_sessions WHERE status='open' AND (terminal_id=? OR terminal_id IS NULL) " +
      "ORDER BY (terminal_id IS NULL) ASC, id DESC LIMIT 1"
    ).get(terminalId);
  },
  open({ userId, cajero, openAmount, openBills, terminalId }) {
    const r = db.prepare(`
      INSERT INTO cash_sessions(user_id,cajero,open_date,open_time,open_amount,open_bills,status,terminal_id)
      VALUES(?,?,?,?,?,?,'open',?)
    `).run(userId, cajero, todayStr(), nowStr(), openAmount, JSON.stringify(openBills || {}), terminalId || null);
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
      SELECT s.*,
        COALESCE((SELECT SUM(si.qty) FROM sale_items si WHERE si.sale_id=s.id),0) AS item_qty_total,
        COALESCE((SELECT COUNT(*) FROM sale_items si WHERE si.sale_id=s.id),0) AS item_lines_count
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

      // Una venta o devolución anulada deja su movimiento original por trazabilidad,
      // pero ya no debe afectar el efectivo esperado de la caja.
      if ((m.type === 'venta' || m.type === 'devolucion') &&
          m.reference_id && cancelledSet.has(m.reference_id)) {
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
  create({ session, customer, items, payment, user, type = 'factura', trustedCustomerSnapshot = false }) {
    const createSaleTx = db.transaction(() => {
      if (!['factura', 'cotizacion'].includes(type)) {
        throw new Error('Tipo de documento de venta no soportado');
      }
      payment = { ...(payment || {}) };
      // Una cotización es un documento comercial: no cobra, no crea CxC, no
      // utiliza una cuenta financiera y no depende del estado de la caja.
      if (type === 'cotizacion') payment.method = 'cotizacion';

      // Para clientes registrados, la base de datos es la autoridad. El renderer
      // solo elige la cuenta y, opcionalmente, uno de sus representantes.
      const requestedCustomer = customer || {};
      const requestedCustomerId = Number(requestedCustomer.id) || 1;
      let selectedContact = null;
      let selectedCustomerPhoneType = String(requestedCustomer.phone_type || 'telefono').toLowerCase();
      if (requestedCustomerId !== 1) {
        const account = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(requestedCustomerId);
        if (!account) throw new Error('Cliente no encontrado o inactivo');
        const contactId = Number(requestedCustomer.contact_id || requestedCustomer.contact?.id) || null;
        if (contactId) {
          const storedContact = db.prepare(`
            SELECT * FROM customer_contacts
            WHERE id=? AND customer_id=?
          `).get(contactId, account.id);
          if (!storedContact) throw new Error('El representante no pertenece a la empresa seleccionada');
          if (trustedCustomerSnapshot && requestedCustomer.preserve_contact_snapshot) {
            selectedContact = {
              ...storedContact,
              name: requestedCustomer.contact?.name || storedContact.name,
              document: requestedCustomer.contact?.document || storedContact.document,
              role: requestedCustomer.contact?.role || storedContact.role,
              phone: requestedCustomer.contact?.phone || storedContact.phone,
              email: requestedCustomer.contact?.email || storedContact.email,
            };
          } else {
            if (account.customer_type !== 'company') throw new Error('Solo una empresa puede usar representantes');
            if (storedContact.active !== 1) throw new Error('El representante seleccionado está inactivo');
            if (storedContact.can_order !== 1) throw new Error('El representante no está autorizado para solicitar compras');
            selectedContact = storedContact;
          }
        }
        const preserveAccount = trustedCustomerSnapshot && requestedCustomer.preserve_customer_snapshot;
        customer = {
          id: account.id,
          name: preserveAccount ? (requestedCustomer.name || account.name) : account.name,
          rnc: preserveAccount ? (requestedCustomer.rnc ?? account.rnc ?? '') : (account.rnc || ''),
          customer_type: preserveAccount
            ? (requestedCustomer.customer_type || account.customer_type || 'person')
            : (account.customer_type || 'person'),
          trade_name: preserveAccount
            ? (requestedCustomer.trade_name ?? account.trade_name ?? '')
            : (account.trade_name || ''),
          address: preserveAccount
            ? (requestedCustomer.address ?? account.address ?? '')
            : (account.address || ''),
          phone: preserveAccount
            ? (requestedCustomer.phone ?? account.phone ?? '')
            : (account.phone || ''),
          email: preserveAccount
            ? (requestedCustomer.email ?? account.billing_email ?? account.email ?? '')
            : (account.billing_email || account.email || ''),
          contact: selectedContact,
        };
        const storedPhones = phonesForCustomer(account.id);
        const requestedPhoneId = Number(requestedCustomer.phone_id) || null;
        const storedPhone = (requestedPhoneId
          ? storedPhones.find(row => Number(row.id) === requestedPhoneId)
          : null) || storedPhones.find(row => row.is_primary) || storedPhones[0] || null;
        if (!preserveAccount && storedPhone) customer.phone = storedPhone.phone;
        selectedCustomerPhoneType = storedPhone?.phone_type || selectedCustomerPhoneType;
      } else {
        customer = {
          id: 1,
          name: String(requestedCustomer.name || 'Consumidor Final').trim() || 'Consumidor Final',
          rnc: String(requestedCustomer.rnc || '').trim(),
          customer_type: 'person', trade_name: '',
          address: String(requestedCustomer.address || '').trim(),
          phone: String(requestedCustomer.phone || '').trim(),
          email: String(requestedCustomer.email || '').trim(),
          contact: null,
        };
        selectedCustomerPhoneType = ['telefono','celular','flota'].includes(selectedCustomerPhoneType)
          ? selectedCustomerPhoneType : 'telefono';
      }

      // ¿Esta venta afecta inventario? (descuenta stock). Una sola fuente de
      // verdad para validación Y descuento, así nunca quedan asimétricas.
      // Solo la factura mueve inventario. "Crédito" es una forma de pago de la
      // factura, nunca una razón para convertir una cotización en movimiento.
      const afectaStock = type === 'factura';
      const headerTaxPct = type === 'factura' ? configuredTaxPct() : 0;
      const saleItems = [];
      const requestedByProduct = new Map();
      for (const item of items) {
        const productId = Number(item.product_id);
        requestedByProduct.set(productId,
          (requestedByProduct.get(productId) || 0) + (Number(item.qty) || 0));
      }
      if (afectaStock && tableExists('checkout_orders')) {
        db.prepare(`
          UPDATE checkout_orders SET status='expired',updated_at=datetime('now','localtime')
          WHERE status='pending' AND expires_at <= datetime('now','localtime')
        `).run();
      }
      const stockValidated = new Set();

      // 1. Validar stock y normalizar snapshot de línea. unit_price es precio final.
      for (const item of items) {
        const prod = db.prepare('SELECT stock,name,taxable,tax_pct FROM products WHERE id=?').get(item.product_id);
        if (!prod) throw new Error(`Producto ID ${item.product_id} no existe`);
        const productId = Number(item.product_id);
        if (afectaStock && !stockValidated.has(productId)) {
          const ownOrderId = Number(payment.checkoutOrderId) || 0;
          const reserved = tableExists('checkout_orders')
            ? (db.prepare(`
                SELECT COALESCE(SUM(i.qty),0) AS qty
                FROM checkout_order_items i
                JOIN checkout_orders o ON o.id=i.order_id
                WHERE i.product_id=? AND o.status='pending'
                  AND o.expires_at > datetime('now','localtime') AND o.id<>?
              `).get(productId, ownOrderId).qty || 0)
            : 0;
          const available = Number(prod.stock) - Number(reserved);
          if (available < (requestedByProduct.get(productId) || 0)) {
            throw new Error(`Stock disponible insuficiente para "${prod.name}"`);
          }
          stockValidated.add(productId);
        }
        const unitPrice = round2(Number.parseFloat(item.unit_price) || 0);
        const taxable = type === 'factura'
          ? normalizeTaxable(item.taxable ?? prod.taxable, 1)
          : 0;
        const itemTaxPct = taxable
          ? normalizeTaxPct(item.tax_pct ?? prod.tax_pct, headerTaxPct)
          : 0;
        saleItems.push({
          ...item,
          product_name: item.product_name || prod.name,
          unit_price: unitPrice,
          unit_cost: round2(Number.parseFloat(item.unit_cost) || 0),
          taxable,
          tax_pct: itemTaxPct,
        });
      }

      // 2. Calcular totales con precio final: neto + ITBIS incluido = total.
      const discPct = payment.disc || 0;
      const calculated = calcIncludedTaxTotals(saleItems, { type, discPct });
      const charges = (Array.isArray(payment.charges) ? payment.charges : [])
        .map(row => ({
          description: String(row?.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          amount: round2(Number(row?.amount) || 0),
        }))
        .filter(row => row.description && row.amount > 0 && row.amount <= 9999999)
        .slice(0, 20);
      const additionalChargesTotal = type === 'factura'
        ? round2(charges.reduce((sum, row) => sum + row.amount, 0)) : 0;
      const subtotal = calculated.subtotal;
      const discAmt = calculated.discAmt;
      const taxAmt = calculated.taxAmt;
      const total = round2(calculated.total + additionalChargesTotal);
      const taxPct = headerTaxPct;

      const displayCurrency = String(payment.displayCurrency || 'DOP').toUpperCase() === 'USD'
        ? 'USD' : 'DOP';
      let displayExchangeRate = 1;
      let displayAmount = 0;
      if (displayCurrency === 'USD') {
        displayExchangeRate = round2(Number(payment.displayExchangeRate) || 0);
        if (displayExchangeRate < 20 || displayExchangeRate > 500) {
          throw new Error('Indica una tasa USD válida para mostrar la conversión de la factura');
        }
        displayAmount = round2(total / displayExchangeRate);
      }
      const requestedSaleDate = String(payment.saleDate || '').trim();
      if (requestedSaleDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedSaleDate)) {
          throw new Error('La fecha del documento no es válida');
        }
        const parsedSaleDate = new Date(`${requestedSaleDate}T12:00:00`);
        if (Number.isNaN(parsedSaleDate.getTime()) ||
            parsedSaleDate.toISOString().slice(0, 10) !== requestedSaleDate) {
          throw new Error('La fecha del documento no es válida');
        }
      }

      // 3. Validar crédito
      if (type === 'factura' && payment.method === 'credito' && customer.id !== 1) {
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

      // 4. Resolver el instrumento de cobro y la moneda REAL de la cuenta.
      // La factura conserva DOP como moneda contable/fiscal base; account_amount
      // es lo que efectivamente entra en la cuenta (p. ej. US$10, no RD$600).
      const method = payment.method || 'efectivo';
      const brandMap = {
        visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express',
        'american express': 'American Express', discover: 'Discover',
        diners: 'Diners Club', 'diners club': 'Diners Club',
        unionpay: 'UnionPay', ath: 'ATH', otra: 'Otra', otro: 'Otra',
      };
      const brandKey = String(payment.cardBrand || '').trim().toLowerCase();
      const cardBrand = method === 'tarjeta' ? (brandMap[brandKey] || 'Otra') : '';
      const cardLast4 = method === 'tarjeta'
        ? String(payment.cardLast4 || '').replace(/\D/g, '').slice(-4) : '';
      const paymentReference = String(payment.reference || '').trim().slice(0, 80);

      let finAcctId = type === 'factura'
        ? (parseInt(payment.financialAccountId) || null) : null;

      // Tarjeta no obliga al cajero a escoger una cuenta bancaria. Si existe una
      // cuenta tipo Tarjeta en DOP, se enlaza automáticamente, priorizando una que
      // contenga la marca ("Visa", "Mastercard", etc.) en su nombre/banco.
      if (type === 'factura' && method === 'tarjeta') {
        const cardAccounts = db.prepare(
          "SELECT * FROM financial_accounts WHERE active=1 AND type='tarjeta' AND UPPER(COALESCE(currency,'DOP'))='DOP' ORDER BY id"
        ).all();
        const needle = cardBrand.toLowerCase();
        const autoAccount = cardAccounts.find(a =>
          `${a.name || ''} ${a.bank_name || ''}`.toLowerCase().includes(needle)
        ) || cardAccounts[0];
        finAcctId = autoAccount?.id || null;
      }

      let account = finAcctId
        ? db.prepare('SELECT * FROM financial_accounts WHERE id=?').get(finAcctId)
        : null;
      if (finAcctId && (!account || !account.active)) {
        throw new Error('La cuenta que recibe el pago no existe o está inactiva');
      }
      if (method === 'transferencia' && account && account.type !== 'banco') {
        throw new Error('Las transferencias deben recibirse en una cuenta bancaria');
      }

      const paymentCurrency = account
        ? String(account.currency || 'DOP').toUpperCase() : 'DOP';
      if (!['DOP', 'USD'].includes(paymentCurrency)) {
        throw new Error(`Moneda de cuenta no soportada: ${paymentCurrency}`);
      }
      const baseAccountAmount = type !== 'factura'
        ? 0
        : (method === 'mixto'
          ? round2(payment.mixCard || 0)
          : (method === 'credito' ? 0 : total));
      let exchangeRate = 1;
      let accountAmount = round2(baseAccountAmount);
      if (paymentCurrency === 'USD' && baseAccountAmount > 0) {
        exchangeRate = round2(Number.parseFloat(payment.exchangeRate) || 0);
        if (exchangeRate < 20 || exchangeRate > 500) {
          throw new Error('Indica una tasa USD válida para acreditar la cuenta en dólares');
        }
        accountAmount = round2(baseAccountAmount / exchangeRate);
      }

      // Vendedor asignado: selección explícita del POS o vínculo automático con
      // el usuario que factura. Un ambulante puede existir sin usuario del sistema.
      let salespersonId = Number(payment.salespersonId) || null;
      if (!salespersonId) {
        salespersonId = db.prepare("SELECT id FROM salespeople WHERE linked_user_id=? AND status='activo'").get(user.id)?.id || null;
      }
      if (salespersonId) {
        const validSeller = db.prepare("SELECT id FROM salespeople WHERE id=? AND status='activo'").get(salespersonId);
        if (!validSeller) throw new Error('El vendedor seleccionado no existe o está inactivo');
      }

      // Crear venta
      const saleR = db.prepare(`
        INSERT INTO sales(cash_session_id,customer_id,customer_name,customer_rnc,
          customer_type,customer_trade_name,customer_address,customer_phone,customer_phone_type,customer_email,
          customer_contact_id,customer_contact_name,customer_contact_document,
          customer_contact_role,customer_contact_phone,customer_contact_email,
          type,status,subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,
          payment_method,price_mode,cajero,user_id,salesperson_id,financial_account_id,
          payment_currency,exchange_rate,account_amount,card_brand,card_last4,
          additional_charges_total,display_currency,display_exchange_rate,display_amount,
          payment_reference,created_at)
        VALUES(
          @cash_session_id,@customer_id,@customer_name,@customer_rnc,
          @customer_type,@customer_trade_name,@customer_address,@customer_phone,@customer_phone_type,@customer_email,
          @customer_contact_id,@customer_contact_name,@customer_contact_document,
          @customer_contact_role,@customer_contact_phone,@customer_contact_email,
          @type,'completed',@subtotal,@discount_pct,@discount_amt,@tax_pct,@tax_amt,@total,
          @payment_method,@price_mode,@cajero,@user_id,@salesperson_id,@financial_account_id,
          @payment_currency,@exchange_rate,@account_amount,@card_brand,@card_last4,
          @additional_charges_total,@display_currency,@display_exchange_rate,@display_amount,
          @payment_reference,@created_at
        )
      `).run({
        cash_session_id: session?.id || null,
        customer_id: customer.id,
        customer_name: customer.name || 'Consumidor Final',
        customer_rnc: customer.rnc || '',
        customer_type: customer.customer_type || 'person',
        customer_trade_name: customer.trade_name || '',
        customer_address: customer.address || '',
        customer_phone: customer.phone || '',
        customer_phone_type: selectedCustomerPhoneType,
        customer_email: customer.email || '',
        customer_contact_id: selectedContact?.id || null,
        customer_contact_name: selectedContact?.name || '',
        customer_contact_document: selectedContact?.document || '',
        customer_contact_role: selectedContact?.role || '',
        customer_contact_phone: selectedContact?.phone || '',
        customer_contact_email: selectedContact?.email || '',
        type, subtotal, discount_pct: discPct, discount_amt: discAmt, tax_pct: taxPct,
        tax_amt: taxAmt, total, payment_method: method,
        price_mode: payment.priceMode || 'retail', cajero: user.name || '', user_id: user.id,
        salesperson_id: salespersonId, financial_account_id: finAcctId,
        payment_currency: paymentCurrency, exchange_rate: exchangeRate, account_amount: accountAmount,
        additional_charges_total: additionalChargesTotal,
        display_currency: displayCurrency,
        display_exchange_rate: displayExchangeRate,
        display_amount: displayAmount,
        card_brand: cardBrand, card_last4: cardLast4, payment_reference: paymentReference,
        created_at: requestedSaleDate
          ? `${requestedSaleDate} ${db.prepare("SELECT time('now','localtime') AS value").get().value}`
          : db.prepare("SELECT datetime('now','localtime') AS value").get().value,
      });
      const saleId = saleR.lastInsertRowid;
      if (charges.length) {
        const insertCharge = db.prepare(
          'INSERT INTO sale_charges(sale_id,description,amount) VALUES(?,?,?)'
        );
        charges.forEach(row => insertCharge.run(saleId, row.description, row.amount));
      }
      const documentKind = documentKindForSale(type, method);
      const documentIssue = _issueDocumentNumber(documentKind, 'sale', saleId);
      const receiptIssue = type === 'factura' && method !== 'credito'
        ? _issueDocumentNumber('recibo', 'sale_receipt', saleId)
        : null;
      db.prepare(`
        UPDATE sales
        SET document_kind=?,document_number=?,document_number_fmt=?,
            receipt_document_number=?,receipt_document_number_fmt=?
        WHERE id=?
      `).run(
        documentKind, documentIssue.sequence_number,
        documentIssue.formatted_number,
        receiptIssue?.sequence_number || null,
        receiptIssue?.formatted_number || '',
        saleId
      );

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
      for (const item of saleItems) {
        db.prepare(`
          INSERT INTO sale_items(
            sale_id,product_id,product_code,product_name,unit_cost,unit_price,qty,subtotal,
            taxable,tax_pct,tax_amt,net_subtotal
          )
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(saleId, item.product_id, item.product_code, item.product_name,
               item.unit_cost, item.unit_price, item.qty, round2(item.unit_price * item.qty),
               item.taxable, item.tax_pct, item.tax_amt, item.net_subtotal);

        // 6. Descontar stock (misma condición que la validación: afectaStock)
        if (afectaStock) {
          productsRepo.adjustStock(item.product_id, -item.qty, 'salida',
            `Venta #${saleId}`, saleId, user.id);
        }
      }

      // 7. Actualizar crédito del cliente
      if (type === 'factura' && payment.method === 'credito' && customer.id !== 1) {
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
      if (type === 'factura' && session?.id && payment.method !== 'credito') {
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

      // 8b. Reflejar en la cuenta bancaria/tarjeta seleccionada (Bancos y Cuentas).
      // El dinero que entra por transferencia/tarjeta se registra como ingreso en
      // esa cuenta operativa → su balance sube y queda el movimiento trazable.
      // No-fatal: un problema aquí nunca debe abortar una venta ya cobrada.
      if (type === 'factura' && finAcctId && method !== 'credito') {
        if (accountAmount > 0.005) {
          try {
            financialAccountsRepo.addMovement({
              accountId: finAcctId, type: 'venta', amount: accountAmount,
              description: `Venta #${saleId}${cardBrand ? ` · ${cardBrand}` : ''}`,
              referenceType: 'sale', referenceId: saleId,
              method, userId: user.id,
              notes: paymentCurrency === 'USD'
                ? `Base RD$${baseAccountAmount.toFixed(2)} · Tasa ${exchangeRate.toFixed(2)}`
                : paymentReference,
            });
          } catch (e) { console.error('[venta] movimiento a cuenta bancaria:', e.message); }
        }
      }

      // 9. Actualizar totales de sesión
      if (type === 'factura' && session?.id) {
        cashRepo.updateTotals(session.id, total);
      }

      // 10. Auditoría
      audit(user.id, user.name, type === 'cotizacion' ? 'cotizacion_creada' : 'venta_creada', 'sales', saleId,
            `Documento: ${documentIssue.formatted_number} | Total: ${total} | Método: ${method} | Moneda cuenta: ${paymentCurrency} | Monto cuenta: ${accountAmount} | Items: ${items.length}`);

      return {
        saleId, total, subtotal, taxAmt, discAmt, taxPct, ncf,
        documentKind,
        documentNumber: documentIssue.sequence_number,
        documentNumberFmt: documentIssue.formatted_number,
        receiptDocumentNumber: receiptIssue?.sequence_number || null,
        receiptDocumentNumberFmt: receiptIssue?.formatted_number || '',
        financialAccountId: finAcctId,
        paymentCurrency, exchangeRate, accountAmount, salespersonId,
        additionalChargesTotal, displayCurrency, displayExchangeRate, displayAmount,
        cardBrand, cardLast4, paymentReference,
      };
    });

    return createSaleTx(); // Si algo falla, revierte TODO
  },

  getById(id) {
    const sale  = db.prepare(`SELECT s.*,sp.name salesperson_name,sp.code salesperson_code
      FROM sales s LEFT JOIN salespeople sp ON sp.id=s.salesperson_id WHERE s.id=?`).get(id);
    if (!sale) return null;
    sale.items  = db.prepare(`
      SELECT si.*,
        COALESCE((
          SELECT SUM(rsi.qty)
          FROM sales ret
          JOIN sale_items rsi ON rsi.sale_id=ret.id
          WHERE ret.type='devolucion'
            AND ret.original_sale_id=si.sale_id
            AND ret.status!='cancelled'
            AND rsi.product_id=si.product_id
        ),0) AS returned_qty
      FROM sale_items si WHERE si.sale_id=?
    `).all(id).map(item => ({
      ...item,
      returnable_qty: Math.max(0, (item.qty || 0) - (item.returned_qty || 0)),
    }));
    sale.charges = tableExists('sale_charges')
      ? db.prepare('SELECT id,description,amount FROM sale_charges WHERE sale_id=? ORDER BY id').all(id)
      : [];
    const payments = db.prepare(`
      SELECT id,document_kind,document_number,document_number_fmt,numero_recibo,
             amount,method,note,balance_before,balance_after,cajero,created_at
      FROM payments
      WHERE sale_id=?
      ORDER BY created_at DESC, id DESC
    `).all(id);
    sale.payments = payments;
    sale.payment_amount = payments.length
      ? round2(payments.reduce((sum, p) => sum + (p.amount || 0), 0))
      : null;
    sale.receipt_numbers = payments
      .map(p => p.document_number_fmt || p.numero_recibo || p.id)
      .filter(Boolean)
      .join(', ');
    if (payments.length) {
      sale.last_receipt_number = payments[0].document_number_fmt || payments[0].numero_recibo || payments[0].id;
      sale.last_payment_date = payments[0].created_at;
      sale.balance_after_payment = payments[0].balance_after;
    } else if ((sale.payment_method || '').toLowerCase() !== 'credito' && sale.type === 'factura') {
      sale.balance_after_payment = 0;
      sale.last_receipt_number = sale.receipt_document_number_fmt || '';
    }
    // Para notas de crédito (devoluciones con B04): adjuntar el NCF y el número
    // real de la factura original que esta nota modifica, para poder mostrarlos
    // en la impresión (la referencia "Ref. venta original" usa el número real,
    // no el id interno).
    if (sale.type === 'devolucion' && sale.original_sale_id) {
      const orig = db.prepare(`
        SELECT ncf,document_number_fmt,numero_factura,numero_factura_fmt
        FROM sales WHERE id=?
      `).get(sale.original_sale_id);
      sale.modifies_ncf = (orig && orig.ncf) ? orig.ncf : '';
      sale.original_document_number_fmt = orig ? orig.document_number_fmt : '';
      sale.original_numero_factura     = orig ? orig.numero_factura     : null;
      sale.original_numero_factura_fmt = orig ? orig.numero_factura_fmt : null;
    }
    return sale;
  },

  getAll({ range = 'today', customerId, method, view, limit = 200, offset = 0 } = {}) {
    let where = "WHERE s.status != 'cancelled'";
    const params = [];
    // Vista estrictamente operativa del módulo Ventas: una factura que ya tiene
    // cualquier devolución vigente pasa a Devoluciones y deja de formar parte de
    // este resultado. El filtro vive en BD para que tabla, métricas y exportación
    // trabajen sobre exactamente el mismo conjunto.
    if (view === 'sales') {
      where += ` AND s.status='completed' AND s.type!='devolucion'
        AND NOT EXISTS (
          SELECT 1 FROM sales ret
          WHERE ret.type='devolucion'
            AND ret.original_sale_id=s.id
            AND ret.status!='cancelled'
        )`;
    }
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
             sp.name AS salesperson_name,
             sp.code AS salesperson_code,
             GROUP_CONCAT(si.product_name || ' x' || si.qty, ' | ') as items_summary,
             COALESCE(SUM(si.qty), 0) as item_qty_total,
             COUNT(si.id) as item_lines_count,
             COALESCE(SUM(si.unit_cost * si.qty), 0) as cost_total,
             EXISTS(
               SELECT 1 FROM sales ret
               WHERE ret.type='devolucion'
                 AND ret.original_sale_id=s.id
                 AND ret.status!='cancelled'
             ) AS has_active_return,
             orig.numero_factura     AS original_numero_factura,
             orig.numero_factura_fmt AS original_numero_factura_fmt
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN sales orig    ON orig.id = s.original_sale_id
      LEFT JOIN salespeople sp ON sp.id = s.salesperson_id
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
  countAll({ range = 'today', customerId, method, view } = {}) {
    let where = "WHERE status != 'cancelled'";
    const params = [];
    if (view === 'sales') {
      where += ` AND status='completed' AND type!='devolucion'
        AND NOT EXISTS (
          SELECT 1 FROM sales ret
          WHERE ret.type='devolucion'
            AND ret.original_sale_id=sales.id
            AND ret.status!='cancelled'
        )`;
    }
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

  updateDate(id, saleDate) {
    const clean = String(saleDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new Error('Fecha inválida');
    const parsed = new Date(`${clean}T12:00:00`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clean) {
      throw new Error('Fecha inválida');
    }
    const sale = db.prepare('SELECT id,created_at,status FROM sales WHERE id=?').get(id);
    if (!sale) throw new Error('Venta no encontrada');
    const time = String(sale.created_at || '').match(/\d{2}:\d{2}:\d{2}/)?.[0]
      || db.prepare("SELECT time('now','localtime') AS value").get().value;
    const next = `${clean} ${time}`;
    db.transaction(() => {
      db.prepare('UPDATE sales SET created_at=? WHERE id=?').run(next, id);
      // Mantener las historias operativas alineadas con la fecha documental.
      db.prepare(`
        UPDATE cash_movements SET created_at=?
        WHERE reference_id=? AND type IN ('venta','devolucion')
      `).run(next, id);
      if (tableExists('financial_movements')) {
        db.prepare(`
          UPDATE financial_movements SET created_at=?
          WHERE reference_type='sale' AND reference_id=?
        `).run(next, id);
      }
      if (tableExists('ncf_log')) {
        db.prepare('UPDATE ncf_log SET issued_at=? WHERE sale_id=?').run(next, id);
      }
    })();
    return this.getById(id);
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
             sp.name AS salesperson_name,
             sp.code AS salesperson_code,
             GROUP_CONCAT(si.product_name || ' x' || si.qty, ' | ') as items_summary,
             c.phone AS _cust_phone,
             (SELECT GROUP_CONCAT(p.numero_recibo, ',') FROM payments p WHERE p.sale_id = s.id) AS _recibos
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN customers c   ON c.id = s.customer_id
      LEFT JOIN salespeople sp ON sp.id = s.salesperson_id
      WHERE s.status != 'cancelled'
        AND (
          s.id = ?
          OR s.numero_factura = ?
          OR lower(s.document_number_fmt) LIKE ?
          OR lower(s.numero_factura_fmt) LIKE ?
          OR lower(s.ncf)           LIKE ?
          OR lower(s.customer_name) LIKE ?
          OR lower(s.customer_rnc)  LIKE ?
          OR lower(s.customer_contact_name) LIKE ?
          OR lower(s.customer_contact_role) LIKE ?
          OR lower(s.customer_contact_phone) LIKE ?
          OR lower(s.notes)         LIKE ?
          OR lower(sp.name)         LIKE ?
          OR lower(sp.code)         LIKE ?
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
      likeNoHash, likeNoHash, like, like, like, like, like, like, like, like, like, like, like, like, likeNoHash
    );

    // Filtro fino con normalización de tildes/Ñ y dígitos con guarda.
    const matchText   = (hay) => !qNorm   || _searchNorm(hay).includes(qNorm);
    const matchDigits = (hay) => !!qDigits && _digitsOf(hay).includes(qDigits);

    const filtered = rows.filter(s =>
      String(s.id) === term ||
      String(s.id).includes(term) ||
      (Number.isFinite(facNum) && s.numero_factura === facNum) ||
      matchText(s.document_number_fmt) ||
      matchDigits(s.document_number_fmt) ||
      matchText(s.numero_factura_fmt) ||
      matchDigits(s.numero_factura_fmt) ||
      matchText(s.ncf) ||
      matchText(s.customer_name) ||
      matchText(s.customer_rnc) ||
      matchDigits(s.customer_rnc) ||
      matchText(s.customer_contact_name) ||
      matchText(s.customer_contact_role) ||
      matchDigits(s.customer_contact_phone) ||
      matchDigits(s._cust_phone) ||
      matchDigits(s._recibos) ||
      matchText(s.notes) ||
      matchText(s.salesperson_name) ||
      matchText(s.salesperson_code) ||
      matchText(s.items_summary)
    );

    // Limpiar los campos auxiliares antes de devolver
    return filtered.slice(0, limit).map(({ _cust_phone, _recibos, ...rest }) => rest);
  },

  // Las cotizaciones no se "anulan": se eliminan de la operación porque nunca
  // debieron afectar caja, inventario ni CxC. Se conserva únicamente la huella
  // de auditoría y el correlativo queda marcado como eliminado (no se reutiliza).
  deleteQuote(id, userId, userName) {
    const tx = db.transaction(() => {
      const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
      if (!sale) throw new Error('Cotización no encontrada');
      if (sale.type !== 'cotizacion') throw new Error('Solo se pueden eliminar cotizaciones');

      // Reparación de cotizaciones antiguas creadas por la ruta financiera.
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
      const movedStock = db.prepare(`
        SELECT COUNT(*) AS c FROM inventory_movements
        WHERE sale_id=? AND type='salida'
      `).get(id)?.c || 0;
      if (movedStock > 0) {
        for (const item of items) {
          productsRepo.adjustStock(
            item.product_id, item.qty, 'devolucion',
            `Corrección al eliminar cotización ${sale.document_number_fmt || '#' + id}`,
            id, userId
          );
        }
      }

      if (sale.payment_method === 'credito' && sale.customer_id && sale.customer_id !== 1) {
        const customer = db.prepare('SELECT balance FROM customers WHERE id=?').get(sale.customer_id);
        const newBalance = Math.max(0, round2((customer?.balance || 0) - (sale.total || 0)));
        db.prepare(`
          UPDATE customers
          SET balance=?,credit_due=CASE WHEN ?<=0 THEN NULL ELSE credit_due END,
              updated_at=datetime('now','localtime')
          WHERE id=?
        `).run(newBalance, newBalance, sale.customer_id);
      }

      const removedCashMovements = db.prepare(
        "DELETE FROM cash_movements WHERE type='venta' AND reference_id=?"
      ).run(id).changes;
      if (sale.cash_session_id && removedCashMovements > 0) {
        db.prepare(`
          UPDATE cash_sessions
          SET sales_total=MAX(0,sales_total-?),sales_count=MAX(0,sales_count-1)
          WHERE id=?
        `).run(sale.total || 0, sale.cash_session_id);
      }
      db.prepare(`
        UPDATE document_issues SET status='deleted'
        WHERE kind='cotizacion' AND source_type='sale' AND source_id=?
      `).run(String(id));
      db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(id);
      db.prepare('DELETE FROM sales WHERE id=?').run(id);
      audit(userId, userName, 'cotizacion_eliminada', 'sales', id,
        `${sale.document_number_fmt || '#' + id} · ${sale.customer_name || 'Consumidor Final'} · Total ${sale.total || 0}`);
      return { id, documentNumber: sale.document_number_fmt || '', total: sale.total || 0 };
    });
    return tx();
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
      db.prepare(`
        UPDATE document_issues SET status='cancelled'
        WHERE source_type IN ('sale','sale_receipt') AND source_id=?
      `).run(String(id));
      if (tableExists('checkout_orders')) {
        db.prepare(`
          UPDATE checkout_orders
          SET status='cancelled',cancel_reason=?,cancelled_at=datetime('now','localtime'),
              updated_at=datetime('now','localtime')
          WHERE sale_id=? AND status IN ('paid','dispatched')
        `).run(`Factura anulada: ${reason || 'sin motivo'}`.slice(0, 300), id);
      }

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

      // Revertir el ingreso reflejado en la cuenta bancaria/tarjeta (si lo hubo):
      // saca de esa cuenta el mismo monto que entró al vender. No-fatal.
      if (sale.financial_account_id && sale.payment_method !== 'credito') {
        // Recuperar el movimiento original es la fuente más segura: contiene USD
        // cuando la cuenta es USD y solo la parte no-efectivo cuando fue mixto.
        const mov = db.prepare(
          "SELECT amount FROM financial_movements WHERE reference_type='sale' AND reference_id=? AND type='venta' AND status='activo' ORDER BY id DESC LIMIT 1"
        ).get(id);
        const acctAmount = mov?.amount || sale.account_amount || sale.total;
        if (acctAmount > 0.005) {
          try {
            financialAccountsRepo.addMovement({
              accountId: sale.financial_account_id, type: 'retiro', amount: -acctAmount,
              description: `Anulación venta #${id}`, referenceType: 'sale', referenceId: id,
              method: sale.payment_method, userId,
            });
          } catch (e) { console.error('[venta] reverso movimiento bancario:', e.message); }
        }
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
      WHERE status='completed' AND type='factura'
        ${hf} AND ${f.withoutAlias.sql}
      GROUP BY payment_method
    `).all(...f.withoutAlias.params);

    // Costo total de lo vendido (desde snapshot de sale_items)
    const costData = db.prepare(`
      SELECT SUM(si.unit_cost * si.qty) as total_cost,
             SUM(COALESCE(si.net_subtotal, si.unit_price * si.qty)) as total_rev_items,
             COUNT(DISTINCT s.id) as total_sales,
             SUM(si.qty) as total_units
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status='completed' AND s.type='factura'
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
      WHERE status='completed' AND type='factura'
        ${hf} AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // ITBIS total
    const taxData = db.prepare(`
      SELECT SUM(tax_amt) as total_tax
      FROM sales
      WHERE status='completed' AND type='factura'
        ${hf} AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // Productos más vendidos (con ganancia real)
    const topProducts = db.prepare(`
      SELECT si.product_name, si.product_code,
             SUM(si.qty) as total_qty,
             SUM(COALESCE(si.net_subtotal, si.unit_price * si.qty)) as total_rev,
             SUM(si.unit_cost  * si.qty) as total_cost,
             SUM(COALESCE(si.net_subtotal, si.unit_price * si.qty) - (si.unit_cost * si.qty)) as total_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status='completed' AND s.type='factura'
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
      WHERE s.status='completed' AND s.type='factura'
        ${hfs} AND ${f.withAlias.sql}
      GROUP BY day
      ORDER BY day ASC
    `).all(...f.withAlias.params);

    // Abonos recibidos en el período (excluir saldos iniciales importados)
    // Usa hfp: excluye históricos solo en 'today', no en 'month'
    // method='descuento' se excluye: es una rebaja que cierra factura sin que
    // entre efectivo, no un cobro. Sumarlo inflaría la caja.
    const abonosData = db.prepare(`
      SELECT COUNT(*) as count, SUM(amount) as total
      FROM payments
      WHERE ${f.payments.sql}
        AND note != 'Saldo inicial importado'
        AND LOWER(COALESCE(method,'efectivo')) != 'descuento' ${hfp}
    `).get(...f.payments.params);

    // Desglose contado vs crédito (para cobradoMes)
    const contadoCreditoData = db.prepare(`
      SELECT
        SUM(CASE WHEN payment_method != 'credito' THEN total ELSE 0 END) as ventas_contado,
        SUM(CASE WHEN payment_method  = 'credito' THEN total ELSE 0 END) as ventas_credito
      FROM sales
      WHERE status='completed' AND type='factura'
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
    const priceChangeData = reportsRepo.priceChanges({ range, dateFrom, dateTo, limit: 8 });

    return {
      byMethod,
      totalRev, totalCost, totalTax, totalDisc,
      totalUnits, totalSales,
      grossProfit, netRev, margin,
      // Netos de devoluciones (opcionales para reportes)
      totalRevNeto, grossProfitNeto, marginNeto,
      topProducts,
      dailySales,
      priceChanges: priceChangeData.rows,
      priceChangeSummary: priceChangeData.summary,
      devolucion:   { count: devData?.count || 0, total: totalDevol },
      abonos:       { count: abonosData?.count || 0, total: abonosData?.total || 0 },
      ventasContado, ventasCredito, cobradoMes,
    };
  },

  priceChanges({ range = 'month', dateFrom = null, dateTo = null, limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 100));
    const f = buildDateFilter('h.created_at', { range, dateFrom, dateTo });
    const hasAccountingEntries = tableExists('accounting_entries');
    const accountingSelect = hasAccountingEntries
      ? `,
             ae.number as accounting_entry_number,
             ae.status as accounting_entry_status`
      : `,
             NULL as accounting_entry_number,
             NULL as accounting_entry_status`;
    const accountingJoin = hasAccountingEntries
      ? 'LEFT JOIN accounting_entries ae ON ae.id = h.accounting_entry_id'
      : '';

    const rows = db.prepare(`
      SELECT h.*,
             p.category,
             p.stock as current_stock,
             p.cost as current_cost,
             p.price as current_price,
             p.wholesale as current_wholesale,
             u.name as user_name${accountingSelect}
      FROM product_price_history h
      LEFT JOIN products p ON p.id = h.product_id
      LEFT JOIN users u ON u.id = h.user_id
      ${accountingJoin}
      WHERE ${f.sql}
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT ?
    `).all(...f.params, safeLimit);

    const summary = db.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(stock_at_change),0) as affected_units,
             COALESCE(SUM(stock_value_delta),0) as cost_impact,
             COALESCE(SUM(retail_value_delta),0) as retail_impact,
             SUM(CASE WHEN cost_delta > 0 THEN 1 ELSE 0 END) as cost_increases,
             SUM(CASE WHEN cost_delta < 0 THEN 1 ELSE 0 END) as cost_decreases,
             SUM(CASE WHEN price_delta > 0 THEN 1 ELSE 0 END) as price_increases,
             SUM(CASE WHEN price_delta < 0 THEN 1 ELSE 0 END) as price_decreases
      FROM product_price_history h
      WHERE ${f.sql}
    `).get(...f.params);

    return {
      rows,
      summary: {
        count: summary?.count || 0,
        affectedUnits: summary?.affected_units || 0,
        costImpact: round2(summary?.cost_impact || 0),
        retailImpact: round2(summary?.retail_impact || 0),
        costIncreases: summary?.cost_increases || 0,
        costDecreases: summary?.cost_decreases || 0,
        priceIncreases: summary?.price_increases || 0,
        priceDecreases: summary?.price_decreases || 0,
      },
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
             s.document_number_fmt AS sale_document_number_fmt,
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
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))!='descuento' THEN p.amount ELSE 0 END),0) AS total,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))='descuento' THEN p.amount ELSE 0 END),0) AS discount_total,
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
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))!='descuento' THEN p.amount ELSE 0 END),0) AS total,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))='descuento' THEN p.amount ELSE 0 END),0) AS discount_total,
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
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))!='descuento' THEN p.amount ELSE 0 END),0) AS total,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))='descuento' THEN p.amount ELSE 0 END),0) AS discount_total,
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
        discountTotal: summary?.discount_total || 0,
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
      WHERE s.status='completed' AND s.type='factura'
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
      WHERE s.status='completed' AND s.type='factura'
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

      const preparedReturnItems = [];
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
        preparedReturnItems.push({
          product_id:   orig.product_id,
          product_code: orig.product_code || '',
          product_name: orig.product_name,
          unit_cost:    orig.unit_cost || 0,
          unit_price:   orig.unit_price || 0,
          qty:          item.qty,
          taxable:      orig.taxable,
          tax_pct:      orig.tax_pct,
        });
      }

      // 3. Calcular totales de la devolución (usando precios históricos del snapshot)
      const hasIncludedTaxSnapshot = originalItems.some(oi =>
        oi.taxable !== null || oi.tax_pct !== null || oi.tax_amt !== null || oi.net_subtotal !== null
      );
      const taxPct = original.tax_pct || 0;
      let subtotal, taxAmt, total;
      if (hasIncludedTaxSnapshot) {
        // Las líneas modernas guardan el neto/ITBIS DESPUÉS del descuento.
        // Reembolsar por esos snapshots evita devolver el precio completo de una
        // factura que originalmente tuvo descuento.
        subtotal = 0;
        taxAmt = 0;
        for (const item of preparedReturnItems) {
          const orig = originalItems.find(oi => oi.product_id === item.product_id);
          const ratio = orig?.qty ? item.qty / orig.qty : 0;
          item.net_subtotal = round2((orig?.net_subtotal || 0) * ratio);
          item.tax_amt = round2((orig?.tax_amt || 0) * ratio);
          const lineTotal = round2(item.net_subtotal + item.tax_amt);
          item.unit_price = item.qty ? round2(lineTotal / item.qty) : 0;
          subtotal += item.net_subtotal;
          taxAmt += item.tax_amt;
        }
        subtotal = round2(subtotal);
        taxAmt = round2(taxAmt);
        total = round2(subtotal + taxAmt);
      } else {
        // Compatibilidad con ventas antiguas sin snapshots por línea.
        const totals = calcIncludedTaxTotals(preparedReturnItems, {
          type: original.type,
          discPct: original.discount_pct || 0,
        });
        subtotal = totals.subtotal;
        taxAmt = totals.taxAmt;
        total = totals.total;
      }

      // 4. Crear venta de tipo 'devolucion'
      const retR = db.prepare(`
        INSERT INTO sales(
          cash_session_id, customer_id, customer_name, customer_rnc,
          customer_type,customer_trade_name,customer_address,customer_phone,customer_email,
          customer_contact_id,customer_contact_name,customer_contact_document,
          customer_contact_role,customer_contact_phone,customer_contact_email,
          type, status, subtotal, discount_pct, discount_amt,
          tax_pct, tax_amt, total, payment_method, price_mode,
          cajero, user_id, notes, original_sale_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        session?.id || original.cash_session_id || null,
        original.customer_id,
        original.customer_name,
        original.customer_rnc,
        original.customer_type || 'person',
        original.customer_trade_name || '',
        original.customer_address || '',
        original.customer_phone || '',
        original.customer_email || '',
        original.customer_contact_id || null,
        original.customer_contact_name || '',
        original.customer_contact_document || '',
        original.customer_contact_role || '',
        original.customer_contact_phone || '',
        original.customer_contact_email || '',
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
      const returnDocument = _issueDocumentNumber('nota_credito', 'sale', returnId);
      db.prepare(`
        UPDATE sales
        SET document_kind='nota_credito',document_number=?,document_number_fmt=?
        WHERE id=?
      `).run(returnDocument.sequence_number, returnDocument.formatted_number, returnId);
      const returnCurrency = String(original.payment_currency || 'DOP').toUpperCase();
      const returnRate = returnCurrency === 'USD' ? Number(original.exchange_rate || 0) : 1;
      const returnAccountAmount = returnCurrency === 'USD' && returnRate > 0
        ? round2(total / returnRate) : round2(total);
      db.prepare(`
        UPDATE sales SET financial_account_id=?,payment_currency=?,exchange_rate=?,
          account_amount=?,card_brand=?,card_last4=? WHERE id=?
      `).run(
        original.financial_account_id || null,
        returnCurrency,
        returnRate || 1,
        original.financial_account_id ? returnAccountAmount : 0,
        original.card_brand || '',
        original.card_last4 || '',
        returnId
      );

      // 5. Insertar items de la devolución y reponer stock
      for (const item of preparedReturnItems) {
        db.prepare(`
          INSERT INTO sale_items(
            sale_id, product_id, product_code, product_name, unit_cost, unit_price, qty, subtotal,
            taxable, tax_pct, tax_amt, net_subtotal
          )
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(returnId, item.product_id, item.product_code, item.product_name,
               item.unit_cost || 0, item.unit_price, item.qty, round2(item.unit_price * item.qty),
               item.taxable, item.tax_pct, item.tax_amt, item.net_subtotal);

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

      // Si el cobro original entró a una cuenta financiera, el reembolso sale de
      // la misma cuenta y en su misma moneda. Para USD se conserva la tasa histórica.
      if (original.financial_account_id && original.payment_method !== 'credito' && returnAccountAmount > 0.005) {
        financialAccountsRepo.addMovement({
          accountId: original.financial_account_id,
          type: 'retiro',
          amount: -returnAccountAmount,
          description: `Devolución #${returnId} · Venta #${originalSaleId}`,
          referenceType: 'return',
          referenceId: returnId,
          method: original.payment_method,
          notes: returnCurrency === 'USD'
            ? `Reembolso base RD$${total.toFixed(2)} · Tasa ${returnRate.toFixed(2)}` : '',
          userId: user.id,
        });
      }

      // 8. Marcar venta original como 'returned' solo si TODOS sus productos quedaron
      // completamente devueltos, sumando ESTA devolución con las anteriores (yaDevuelto).
      // Antes solo miraba los items de la tanda actual, así que devoluciones parciales
      // en varias tandas nunca marcaban la venta como devuelta.
      const currentReturn = {};
      for (const i of preparedReturnItems) currentReturn[i.product_id] = (currentReturn[i.product_id] || 0) + i.qty;
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
        `Venta original #${originalSaleId} | Total devuelto: ${total} | Items: ${preparedReturnItems.length}${ncfNota ? ' | NC B04: ' + ncfNota : ''}`);

      return {
        returnId, total, subtotal, taxAmt, overpayment,
        documentKind: 'nota_credito',
        documentNumber: returnDocument.sequence_number,
        documentNumberFmt: returnDocument.formatted_number,
        ncf: ncfNota,
        modifies_ncf: ncfNota ? String(original.ncf).trim() : '',
      };
    });

    return createReturnTx();
  },

  /**
   * Anula una devolución sin tratarla como una venta ordinaria.
   * La nota de crédito permanece solo como rastro de auditoría y deja de aparecer
   * en los listados operativos. Se deshacen inventario y CxC en una transacción.
   */
  cancel(returnId, reason, userId, userName) {
    if (!reason?.trim()) throw new Error('El motivo de anulación es obligatorio');

    return db.transaction(() => {
      const ret = db.prepare('SELECT * FROM sales WHERE id=?').get(returnId);
      if (!ret) throw new Error('Devolución no encontrada');
      if (ret.type !== 'devolucion') throw new Error('El documento indicado no es una devolución');
      if (ret.status === 'cancelled') throw new Error('La devolución ya está anulada');

      const original = db.prepare('SELECT * FROM sales WHERE id=?').get(ret.original_sale_id);
      if (!original) throw new Error('La venta original de la devolución no existe');

      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(returnId);
      for (const item of items) {
        const product = db.prepare('SELECT stock,name FROM products WHERE id=?').get(item.product_id);
        if (!product) throw new Error(`Producto ID ${item.product_id} no existe`);
        if ((product.stock || 0) < (item.qty || 0)) {
          throw new Error(
            `No se puede anular: el inventario de "${product.name}" ya fue utilizado. ` +
            `Disponible: ${product.stock || 0}; requerido: ${item.qty || 0}.`
          );
        }
      }

      // La devolución repuso existencias; al anularla se retiran nuevamente.
      for (const item of items) {
        productsRepo.adjustStock(
          item.product_id, -item.qty, 'salida',
          `Anulación devolución #${returnId} de venta #${ret.original_sale_id}`,
          returnId, userId
        );
      }

      // Restaurar la cuenta por cobrar que había reducido la devolución.
      if (original.payment_method === 'credito' && original.customer_id !== 1) {
        db.prepare(`UPDATE customers SET balance=balance+?,updated_at=datetime('now') WHERE id=?`)
          .run(ret.total || 0, original.customer_id);
      }

      // Reponer en la cuenta el monto que había salido al efectuar la devolución.
      if (ret.financial_account_id && ret.payment_method !== 'credito') {
        const refundMov = db.prepare(
          "SELECT amount FROM financial_movements WHERE reference_type='return' AND reference_id=? AND status='activo' ORDER BY id DESC LIMIT 1"
        ).get(returnId);
        const refundAmount = refundMov?.amount || ret.account_amount || 0;
        if (refundAmount > 0.005) {
          financialAccountsRepo.addMovement({
            accountId: ret.financial_account_id,
            type: 'deposito',
            amount: refundAmount,
            description: `Anulación devolución #${returnId}`,
            referenceType: 'return_cancel',
            referenceId: returnId,
            method: ret.payment_method,
            notes: 'Restauración del reembolso anulado',
            userId,
          });
        }
      }

      db.prepare(`UPDATE sales SET status='cancelled',cancelled_at=datetime('now'),cancel_reason=? WHERE id=?`)
        .run(reason.trim(), returnId);
      db.prepare(`
        UPDATE document_issues SET status='cancelled'
        WHERE kind='nota_credito' AND source_type='sale' AND source_id=?
      `).run(String(returnId));

      // Recalcular si la factura original sigue totalmente devuelta por otras notas
      // de crédito vigentes. Si no, vuelve a estar disponible en Devoluciones.
      const originalItems = db.prepare('SELECT product_id,qty FROM sale_items WHERE sale_id=?').all(original.id);
      const activeReturned = db.prepare(`
        SELECT si.product_id,COALESCE(SUM(si.qty),0) qty
        FROM sales s JOIN sale_items si ON si.sale_id=s.id
        WHERE s.type='devolucion' AND s.original_sale_id=? AND s.status!='cancelled'
        GROUP BY si.product_id
      `).all(original.id);
      const returnedByProduct = new Map(activeReturned.map(r => [r.product_id, r.qty || 0]));
      const stillFullyReturned = originalItems.length > 0 && originalItems.every(i =>
        (returnedByProduct.get(i.product_id) || 0) >= i.qty
      );
      db.prepare('UPDATE sales SET status=? WHERE id=?')
        .run(stillFullyReturned ? 'returned' : 'completed', original.id);

      if (ret.ncf && String(ret.ncf).trim()) {
        db.prepare(`UPDATE ncf_log SET status='anulado',voided_at=datetime('now')
                    WHERE sale_id=? AND ncf=? AND status!='anulado'`)
          .run(returnId, String(ret.ncf).trim());
      }

      audit(userId, userName, 'devolucion_anulada', 'sales', returnId,
        `Venta original #${original.id} | Motivo: ${reason.trim()}`);
      return { ok: true, originalSaleId: original.id };
    })();
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
      const subtotal = round2(items.reduce((s, i) => s + (moneyVal(i.unit_cost) * (Number.parseInt(i.qty_ordered, 10) || 0)), 0));
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

      audit(userId || null, cajero || '', 'compra_creada', 'purchase_orders', poId,
            `OC #${poId} | ${items.length} item(s) | Total: ${total}`);

      return { poId, total };
    })();
  },

  receive(id, { items, userId, userName = '', costs = {} }) {
    return db.transaction(() => {
      const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(id);
      if (!po) throw new Error('Orden no encontrada');
      if (po.status === 'recibido') throw new Error('Esta orden ya fue recibida completamente');

      const receiveRows = [];
      for (const raw of (items || [])) {
        const qtyReceived = Number.parseInt(raw.qty_received, 10) || 0;
        if (qtyReceived <= 0) continue;
        const poItem = db.prepare(`
          SELECT * FROM purchase_items WHERE id=? AND purchase_order_id=?
        `).get(raw.id, id);
        if (!poItem) throw new Error('Línea de compra no encontrada');
        const remaining = (Number.parseInt(poItem.qty_ordered, 10) || 0)
          - (Number.parseInt(poItem.qty_received, 10) || 0);
        if (qtyReceived > remaining) {
          throw new Error(`Cantidad recibida supera lo pendiente para ${poItem.product_name}`);
        }
        receiveRows.push({ ...poItem, qty_received: qtyReceived });
      }

      if (!receiveRows.length) throw new Error('Ingresa al menos una cantidad a recibir');

      const allocation = allocatePurchaseCosts(receiveRows, costs);
      for (const item of allocation.items) {
        // Actualizar item de la orden
        db.prepare(`
          UPDATE purchase_items
          SET qty_received = qty_received + ?,
              allocated_extra_cost = COALESCE(allocated_extra_cost,0) + ?,
              landed_unit_cost = CASE
                WHEN (qty_received + ?) > 0 THEN
                  ROUND(((COALESCE(NULLIF(landed_unit_cost,0), unit_cost, 0) * qty_received) + (? * ?)) / (qty_received + ?), 2)
                ELSE ?
              END
          WHERE id=? AND purchase_order_id=?
        `).run(
          item.qty_received,
          item.allocatedExtra,
          item.qty_received,
          item.landedUnitCost,
          item.qty_received,
          item.qty_received,
          item.landedUnitCost,
          item.id,
          id
        );

        // Actualizar stock y costo promedio ponderado
        if (item.product_id) {
          // 1. Leer stock y costo actuales ANTES de ajustar
          const prodActual = db.prepare(
            `SELECT * FROM products WHERE id=?`
          ).get(item.product_id);

          const stockActual   = prodActual?.stock  || 0;
          const costoActual   = prodActual?.cost   || 0;
          const stockNuevo    = item.qty_received;
          const costoNuevo    = item.landedUnitCost || item.unit_cost;

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
          const reason = `Recepción OC #${id} | Base: ${item.unit_cost} | Gastos: ${item.allocatedExtra} | Costo real: ${costoNuevo} | Promedio: ${costoPromedio}`;
          productsRepo.adjustStock(
            item.product_id, item.qty_received, 'entrada',
            reason,
            null, userId
          );

          // 4. Siempre actualizar al costo promedio ponderado
          // Las ventas históricas NO se ven afectadas porque tienen su snapshot en sale_items
          if (costoNuevo > 0) {
            db.prepare(
              `UPDATE products SET cost=?, updated_at=datetime('now') WHERE id=?`
            ).run(costoPromedio, item.product_id);
            const prodDespues = db.prepare(`SELECT * FROM products WHERE id=?`).get(item.product_id);
            recordProductPriceHistory(item.product_id, prodActual, prodDespues, {
              userId,
              source: 'compra',
              reason,
              stockAtChange: stockActual,
            });
          }
        }
      }

      // Verificar si todos los items fueron recibidos completamente
      const pendingItems = db.prepare(`
        SELECT COUNT(*) as c FROM purchase_items
        WHERE purchase_order_id=? AND qty_received < qty_ordered
      `).get(id);

      const newStatus = pendingItems.c === 0 ? 'recibido' : 'parcial';
      const newFreight = round2((po.freight_cost || 0) + allocation.freight);
      const newCustoms = round2((po.customs_cost || 0) + allocation.customs);
      const newTransport = round2((po.transport_cost || 0) + allocation.transport);
      const newOther = round2((po.other_cost || 0) + allocation.other);
      const newLanded = round2(newFreight + newCustoms + newTransport + newOther);
      const newTotal = round2((po.subtotal || 0) + (po.tax_amt || 0) + newLanded);

      db.prepare(`
        UPDATE purchase_orders
        SET status=?,
            received_at=CASE WHEN ?='recibido' THEN datetime('now') ELSE received_at END,
            freight_cost=?,
            customs_cost=?,
            transport_cost=?,
            other_cost=?,
            landed_cost=?,
            total=?
        WHERE id=?
      `).run(newStatus, newStatus, newFreight, newCustoms, newTransport, newOther, newLanded, newTotal, id);

      audit(userId, userName || '', 'compra_recibida', 'purchase_orders', id,
            `OC #${id} | Status: ${newStatus} | Mercancía: ${allocation.baseTotal} | Gastos: ${allocation.totalExtra} | Costo real: ${allocation.landedTotal}`);

      return {
        status: newStatus,
        baseValue: allocation.baseTotal,
        landedCost: allocation.totalExtra,
        receivedValue: allocation.landedTotal,
      };
    })();
  },

  cancel(id, userId, userName = '') {
    db.prepare(`UPDATE purchase_orders SET status='cancelado' WHERE id=?`).run(id);
    audit(userId, userName || '', 'compra_cancelada', 'purchase_orders', id, `OC #${id} cancelada`);
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
const EXPENSE_NON_ACTIVE_STATUS_SQL = "('anulado','rechazado','borrador')";

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
  // Busca una categoría por nombre (case-insensitive); si no existe la crea,
  // colgada del grupo indicado (que también se crea si falta). Usado por los
  // gastos automáticos de mantenimiento y envíos.
  ensureCategory(name, parentName = null) {
    const found = db.prepare('SELECT id FROM expense_categories WHERE name=? COLLATE NOCASE AND active=1').get(name);
    if (found) return found.id;
    let parentId = null;
    if (parentName) {
      const p = db.prepare('SELECT id FROM expense_categories WHERE name=? COLLATE NOCASE AND parent_id IS NULL AND active=1').get(parentName);
      parentId = p ? p.id
        : db.prepare('INSERT INTO expense_categories(name,affects_profit,requires_approval) VALUES(?,1,0)').run(parentName).lastInsertRowid;
    }
    return db.prepare('INSERT INTO expense_categories(name,parent_id,affects_profit,requires_approval) VALUES(?,?,1,0)')
      .run(name, parentId).lastInsertRowid;
  },

  // ── CRUD Gastos ──────────────────────────
  getAll({ status, from, to, date, supplier_id, category_id, user_id, limit, include_inactive, includeInactive } = {}) {
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
    else if (!include_inactive && !includeInactive) {
      q += ` AND e.status NOT IN ${EXPENSE_NON_ACTIVE_STATUS_SQL}`;
    }
    if (date)        { q += ' AND e.issue_date=?';   params.push(date); }
    else {
      if (from)      { q += ' AND e.issue_date>=?';  params.push(from); }
      if (to)        { q += ' AND e.issue_date<=?';  params.push(to); }
    }
    if (supplier_id) { q += ' AND e.supplier_id=?';  params.push(supplier_id); }
    if (category_id) { q += ' AND e.category_id=?';  params.push(category_id); }
    if (user_id)     { q += ' AND e.user_id=?';      params.push(user_id); }
    q += ' ORDER BY e.created_at DESC';
    const safeLimit = Number.parseInt(limit, 10);
    if (Number.isFinite(safeLimit) && safeLimit > 0) q += ` LIMIT ${safeLimit}`;
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

  getSummary({ from, to, month } = {}) {
    const where = [`e.type='gasto'`, `e.status NOT IN ${EXPENSE_NON_ACTIVE_STATUS_SQL}`];
    const params = [];
    if (month) {
      where.push("strftime('%Y-%m', e.issue_date)=?");
      params.push(String(month).slice(0, 7));
    } else {
      if (from) { where.push('e.issue_date>=?'); params.push(from); }
      if (to)   { where.push('e.issue_date<=?'); params.push(to); }
    }
    const baseWhere = where.join(' AND ');
    const value = (sql) => db.prepare(sql).get(...params).v;
    return {
      total:       value(`SELECT COALESCE(SUM(total),0) as v FROM expenses e WHERE ${baseWhere}`),
      paid:        value(`SELECT COALESCE(SUM(paid_amount),0) as v FROM expenses e WHERE ${baseWhere}`),
      pending:     value(`SELECT COALESCE(SUM(total-paid_amount),0) as v FROM expenses e WHERE ${baseWhere} AND e.status!='pagado'`),
      overdue:     value(`SELECT COALESCE(SUM(total-paid_amount),0) as v FROM expenses e WHERE ${baseWhere} AND e.status!='pagado' AND e.due_date < date('now')`),
      from_cash:   value(`SELECT COALESCE(SUM(paid_amount),0) as v FROM expenses e WHERE ${baseWhere} AND e.payment_source='caja'`),
      count:       value(`SELECT COUNT(*) as v FROM expenses e WHERE ${baseWhere}`),
      by_category: db.prepare(`SELECT ec.name, COALESCE(SUM(e.total),0) as total FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE ${baseWhere} GROUP BY e.category_id ORDER BY total DESC LIMIT 8`).all(...params),
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
      const paymentId = payRow.lastInsertRowid;
      const documentIssue = _issueDocumentNumber('pago_proveedor', 'expense_payment', paymentId);
      db.prepare(`
        UPDATE expense_payments
        SET document_kind='pago_proveedor',document_number=?,document_number_fmt=?
        WHERE id=?
      `).run(documentIssue.sequence_number, documentIssue.formatted_number, paymentId);

      // Actualizar gasto
      const newPaid = expense.paid_amount + amount;
      const newStatus = newPaid >= expense.total - 0.01 ? 'pagado' : 'parcialmente_pagado';
      // Pagar = aprobado automático: si el gasto aún no estaba aprobado, el pago lo
      // aprueba (lo hace un admin, que tiene la autoridad). No sobreescribe si ya
      // tenía aprobador. Elimina el paso previo de "Aprobar" para poder pagar.
      db.prepare(`UPDATE expenses SET paid_amount=?,status=?,
        approved_by=COALESCE(approved_by,?), approved_at=COALESCE(approved_at,datetime('now')),
        updated_at=datetime('now'),cash_session_id=?,cash_movement_id=? WHERE id=?`)
        .run(newPaid, newStatus, userId||null, cash_session_id||expense.cash_session_id, cashMovementId||expense.cash_movement_id, expenseId);

      audit(userId, userName||'', 'gasto_pagado', 'expenses', expenseId,
        `Pago: RD$${amount} | Método: ${payment_method} | Estado: ${newStatus}${expense.approved_by ? '' : ' | Aprobado al pagar'}`);
      return {
        ok: true, newStatus, newPaid, cashMovementId, paymentId,
        documentKind: 'pago_proveedor',
        documentNumber: documentIssue.sequence_number,
        documentNumberFmt: documentIssue.formatted_number,
      };
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
      db.prepare(`
        UPDATE document_issues SET status='cancelled'
        WHERE kind='pago_proveedor' AND source_type='expense_payment'
          AND source_id IN (
            SELECT CAST(id AS TEXT) FROM expense_payments WHERE expense_id=?
          )
      `).run(expenseId);
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
          AND strftime('%Y-%m',e.issue_date)=b.month AND e.status NOT IN ${EXPENSE_NON_ACTIVE_STATUS_SQL}),0) as spent
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
  delete(id) {
    // FK ON: primero el historial de mantenimiento (sus gastos quedan como
    // registro histórico) y desasignar envíos; luego el vehículo.
    db.transaction(() => {
      db.prepare('DELETE FROM vehicle_maintenance WHERE vehicle_id=?').run(id);
      db.prepare('UPDATE deliveries SET vehicle_id=NULL WHERE vehicle_id=?').run(id);
      db.prepare('DELETE FROM vehicles WHERE id=?').run(id);
    })();
  },

  // Calcular costo estimado de combustible para una distancia
  calcFuelCost(vehicleId, distanceKm, fuelPrices) {
    const v = this.getById(vehicleId);
    if (!v) return null;
    // Eléctrico: no consume combustible — costo 0 (no se estima electricidad)
    if (v.fuel_type === 'electrico' || v.fuel_grade === 'ninguno') {
      return { gallons: 0, cost: 0, fuel_grade: v.fuel_grade,
               km_per_gallon: v.km_per_gallon, electric: true };
    }
    const gallons = distanceKm / (v.km_per_gallon || 35);
    const pricePerGallon = parseFloat(fuelPrices[v.fuel_grade] ?? fuelPrices.premium ?? 293);
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
  getById(id) { return db.prepare('SELECT * FROM vehicle_maintenance WHERE id=?').get(id); },
  setExpense(id, expenseId) {
    db.prepare('UPDATE vehicle_maintenance SET expense_id=? WHERE id=?').run(expenseId, id);
  },
  delete(id) { db.prepare('DELETE FROM vehicle_maintenance WHERE id=?').run(id); },
};

// ══════════════════════════════════════════════
// REPOSITORIO: ENVÍOS
// ══════════════════════════════════════════════
const deliveriesRepo = {
  getAll({ status, from, to } = {}) {
    // customer_name: prioridad al nombre libre guardado en el envío (cliente no
    // registrado); si está vacío, el nombre del cliente vinculado.
    let q = `SELECT d.*, v.brand, v.model, v.plate, v.km_per_gallon, v.fuel_grade,
      u.name as driver_name, COALESCE(NULLIF(d.customer_name,''), c.name) as customer_name
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
    let contact = null;
    if (data.customer_contact_id && data.customer_id) {
      contact = db.prepare(`SELECT * FROM customer_contacts WHERE id=? AND customer_id=? AND active=1 AND can_receive=1`)
        .get(data.customer_contact_id, data.customer_id);
      if (!contact) throw new Error('El representante no pertenece a la empresa, está inactivo o no puede recibir mercancía');
    }
    return db.prepare(`INSERT INTO deliveries(
      sale_id,customer_id,customer_name,customer_contact_id,customer_contact_name,
      customer_contact_role,customer_contact_phone,vehicle_id,driver_id,
      origin_address,dest_address,dest_lat,dest_lng,distance_km,fuel_used,fuel_cost,
      delivery_fee,delivery_type,carrier_name,carrier_stop,carrier_tracking,carrier_dest,
      status,scheduled_at,notes,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.sale_id||null, data.customer_id||null, String(data.customer_name||'').trim(),
      contact?.id || null, contact?.name || '', contact?.role || '', contact?.phone || '',
      data.vehicle_id||null, data.driver_id||null,
      data.origin_address||'', data.dest_address, data.dest_lat||null, data.dest_lng||null,
      data.distance_km||null, data.fuel_used||null, data.fuel_cost||null,
      data.delivery_fee||0, data.delivery_type||'propio', data.carrier_name||'',
      data.carrier_stop||'', data.carrier_tracking||'', data.carrier_dest||'',
      data.status||'pendiente', data.scheduled_at||null,
      data.notes||'', data.user_id||null).lastInsertRowid;
  },
  setExpense(id, expenseId) {
    db.prepare('UPDATE deliveries SET expense_id=? WHERE id=?').run(expenseId, id);
  },
  // Edición de campos operativos (no toca estado ni gasto vinculado; los campos
  // no enviados conservan su valor actual).
  update(id, data = {}) {
    const cur = this.getById(id);
    if (!cur) throw new Error('Envío no encontrado');
    db.prepare(`UPDATE deliveries SET dest_address=?, customer_id=?, customer_name=?,
      delivery_fee=?, carrier_tracking=?, carrier_stop=?, notes=?, scheduled_at=?,
      updated_at=datetime('now') WHERE id=?`).run(
      data.dest_address !== undefined ? String(data.dest_address || '').trim() : cur.dest_address,
      data.customer_id !== undefined ? (data.customer_id || null) : cur.customer_id,
      data.customer_name !== undefined ? String(data.customer_name || '').trim() : (cur.customer_name || ''),
      data.delivery_fee !== undefined ? (Number(data.delivery_fee) || 0) : cur.delivery_fee,
      data.carrier_tracking !== undefined ? String(data.carrier_tracking || '').trim() : (cur.carrier_tracking || ''),
      data.carrier_stop !== undefined ? String(data.carrier_stop || '').trim() : (cur.carrier_stop || ''),
      data.notes !== undefined ? String(data.notes || '') : (cur.notes || ''),
      data.scheduled_at !== undefined ? (data.scheduled_at || null) : cur.scheduled_at,
      id);
    return this.getById(id);
  },
  updateStatus(id, status, userId) {
    const current = this.getById(id);
    if (!current) throw new Error('Envío no encontrado');
    const transitions = {
      pendiente: ['en_camino', 'cancelado'],
      en_camino: ['entregado', 'cancelado'],
      entregado: ['cancelado'],
      cancelado: [],
    };
    if (!transitions[current.status]?.includes(status)) {
      const from = ({ pendiente: 'Pendiente', en_camino: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado' })[current.status] || current.status;
      const to = ({ pendiente: 'Pendiente', en_camino: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado' })[status] || status;
      throw new Error(`No se puede cambiar un envío de ${from} a ${to}`);
    }
    db.prepare(`UPDATE deliveries SET status=?,
      delivered_at=${status === 'entregado' ? "datetime('now')" : 'NULL'},
      updated_at=datetime('now') WHERE id=?`).run(status, id);
    return this.getById(id);
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
  // Diagnóstico C2: NCF duplicados a reconciliar (ventas con el mismo NCF no vacío).
  // Mientras existan, el índice único no se aplica (ver ensureNcfIntegrity).
  getDuplicates() {
    return db.prepare(`
      SELECT ncf, COUNT(*) as veces, GROUP_CONCAT(id) as sale_ids
      FROM sales WHERE ncf IS NOT NULL AND TRIM(ncf)<>''
      GROUP BY ncf HAVING veces>1 ORDER BY ncf`).all();
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
  create({ name, type, bank_name, account_number, currency, account_subtype, initial_balance, balance, description, notes, userId }) {
    // Las cuentas de banco/tarjeta parten en 0 (reciben ingresos): el balance
    // inicial solo aplica a caja/otro. Evita inflar el saldo bancario a mano.
    // (La UI envía `balance`; se acepta como alias de initial_balance.)
    const isBankish = type === 'banco' || type === 'tarjeta';
    const bal = isBankish ? 0 : (parseFloat(initial_balance ?? balance) || 0);
    const r = db.prepare(`
      INSERT INTO financial_accounts(name,type,bank_name,account_number,currency,account_subtype,
        initial_balance,current_balance,description,notes,user_id,active)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
    `).run(name, type||'caja', bank_name||'', account_number||'',
           currency||'DOP', account_subtype||'', bal, bal, description||'', notes||'', userId||null);
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
  update(id, { name, type, bank_name, account_number, currency, account_subtype, description, notes, active }) {
    db.prepare(`
      UPDATE financial_accounts SET name=?,type=?,bank_name=?,account_number=?,
        currency=?,account_subtype=?,description=?,notes=?,active=?,updated_at=datetime('now')
      WHERE id=?
    `).run(name, type||'caja', bank_name||'', account_number||'',
           currency||'DOP', account_subtype||'', description||'', notes||'', active??1, id);
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
      if (!String(concept || '').trim()) throw new Error('El concepto del asiento es obligatorio');
      if (!lines || lines.length < 2) throw new Error('El asiento debe tener al menos 2 líneas');
      const entryDate = date || new Date().toISOString().split('T')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entryDate).slice(0, 10))) {
        throw new Error('La fecha del asiento debe tener formato YYYY-MM-DD');
      }
      const normalizedLines = lines.map((line, index) => {
        const debit = round2(Number.parseFloat(line.debit) || 0);
        const credit = round2(Number.parseFloat(line.credit) || 0);
        if (debit < 0 || credit < 0) {
          throw new Error(`Línea ${index + 1}: débito y crédito no pueden ser negativos`);
        }
        if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
          throw new Error(`Línea ${index + 1}: indique débito o crédito, pero no ambos`);
        }
        return { ...line, debit, credit };
      });
      const totalDebit  = round2(normalizedLines.reduce((s, l) => s + l.debit, 0));
      const totalCredit = round2(normalizedLines.reduce((s, l) => s + l.credit, 0));
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new Error(`Asiento descuadrado: Débito=${totalDebit.toFixed(2)} ≠ Crédito=${totalCredit.toFixed(2)}`);
      }
      // Bloqueo de período: no se postea en un período contable cerrado.
      if (this.isDateLocked(entryDate)) {
        throw new Error(`El período contable de ${entryDate} está cerrado — no se pueden postear asientos en esa fecha.`);
      }
      const number = this._nextNumber();
      const entryStatus = status || 'confirmado';
      const r = db.prepare(`
        INSERT INTO accounting_entries(number,date,concept,reference,source_module,source_id,
          total_debit,total_credit,status,notes,user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(number, String(entryDate).slice(0, 10), String(concept).trim(), reference||'',
             source_module||'', source_id||null, totalDebit, totalCredit,
             entryStatus, notes||'', userId||null);
      const entryId = r.lastInsertRowid;
      for (const line of normalizedLines) {
        const acc = db.prepare('SELECT id,active,is_summary FROM accounting_accounts WHERE id=?').get(line.account_id);
        if (!acc) throw new Error(`Cuenta ID ${line.account_id} no existe`);
        if (!acc.active) throw new Error(`La cuenta ${line.account_id} está inactiva`);
        if (acc.is_summary) throw new Error(`La cuenta ${line.account_id} es de resumen y no admite movimientos`);
        db.prepare(`INSERT INTO accounting_entry_lines(entry_id,account_id,description,debit,credit,reference)
          VALUES(?,?,?,?,?,?)`).run(entryId, line.account_id, line.description||'',
          line.debit, line.credit, line.reference||'');
        // Solo un asiento confirmado afecta saldos. Los borradores existen para
        // preparación/revisión, no forman parte de la contabilidad vigente.
        if (entryStatus === 'confirmado') {
          const netChange = line.debit - line.credit;
          db.prepare(`UPDATE accounting_accounts SET balance=balance+?,updated_at=datetime('now') WHERE id=?`)
            .run(netChange, line.account_id);
        }
      }
      return { entryId, number, totalDebit, totalCredit };
    })();
  },

  getEntries({ from, to, source_module, status, includeHistory = false, limit = 200 } = {}) {
    let q = `SELECT e.*, u.name as user_name FROM accounting_entries e
      LEFT JOIN users u ON e.user_id=u.id WHERE 1=1`;
    const params = [];
    // La pantalla operativa solo muestra asientos vigentes. Los originales
    // anulados quedan fuera de la lista; el motivo permanece en Auditoría.
    if (!includeHistory) q += " AND e.status!='anulado' AND e.source_module!='reverso'";
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

  reverseEntry(entryId, userId, reason, { allowSystem = false } = {}) {
    return db.transaction(() => {
      const original = this.getEntryById(entryId);
      if (!original) throw new Error('Asiento no encontrado');
      if (original.status === 'anulado') throw new Error('El asiento ya está anulado');
      if (original.source_module === 'reverso' || original.reversal_of) {
        throw new Error('Un asiento de reversión no puede volver a anularse');
      }
      const manualSources = new Set(['manual', 'ajuste', 'apertura', 'cierre']);
      if (!allowSystem && !manualSources.has(original.source_module || 'manual')) {
        throw new Error(
          'Este asiento fue generado automáticamente. Anule la operación desde su módulo de origen.'
        );
      }
      if (!reason?.trim()) throw new Error('El motivo de anulación es obligatorio');

      // El cliente no usa asientos de reverso visibles. Retirar el efecto del
      // asiento original directamente mantiene el catálogo cuadrado sin crear
      // otra fila contable llamada "REVERSO". Todo ocurre en esta transacción.
      if (original.status === 'confirmado') {
        for (const line of original.lines) {
          const netChange = (Number(line.debit) || 0) - (Number(line.credit) || 0);
          db.prepare(`UPDATE accounting_accounts
            SET balance=balance-?,updated_at=datetime('now') WHERE id=?`)
            .run(netChange, line.account_id);
        }
      }

      db.prepare(`UPDATE accounting_entries SET status='anulado',reversed_by=NULL,
        reversal_of=NULL,updated_at=datetime('now') WHERE id=?`).run(entryId);

      audit(userId, '', 'asiento_anulado', 'accounting_entries', entryId, reason);
      return { ok: true, entryId, number: original.number };
    })();
  },

  // Eliminación lógica de un asiento desde Contabilidad. Puede retirar tanto
  // asientos manuales como automáticos, pero conserva el documento anulado y
  // el motivo en Auditoría. Así desaparece de libros/reportes sin destruir la
  // trazabilidad ni dejar saldos acumulados en el catálogo.
  deleteEntry(entryId, userId, reason) {
    const result = this.reverseEntry(entryId, userId, reason, { allowSystem: true });
    audit(userId, '', 'asiento_eliminado', 'accounting_entries', entryId, reason);
    return result;
  },

  // ── Mayor general (movimientos por cuenta) ─
  getLedger({ accountId, from, to } = {}) {
    let q = `SELECT l.*, e.date, e.number, e.concept, e.source_module, e.status,
      a.code, a.name as account_name
      FROM accounting_entry_lines l
      JOIN accounting_entries e ON l.entry_id=e.id
      JOIN accounting_accounts a ON l.account_id=a.id
      WHERE e.status='confirmado' AND e.source_module!='reverso'`;
    const params = [];
    if (accountId) { q += ' AND l.account_id=?'; params.push(accountId); }
    if (from)      { q += ' AND e.date>=?'; params.push(from); }
    if (to)        { q += ' AND e.date<=?'; params.push(to); }
    q += ' ORDER BY e.date ASC, e.id ASC, l.id ASC';
    return db.prepare(q).all(...params);
  },

  // ── Balance de comprobación ───────────────
  getTrialBalance({ from, to } = {}) {
    const dateSql = `${from ? ' AND e.date>=?' : ''}${to ? ' AND e.date<=?' : ''}`;
    const dateParams = [...(from ? [from] : []), ...(to ? [to] : [])];
    const accounts = db.prepare(`SELECT a.*,
      COALESCE((SELECT SUM(l.debit)  FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        WHERE l.account_id=a.id AND e.status='confirmado' AND e.source_module!='reverso'
        ${dateSql}),0) as period_debit,
      COALESCE((SELECT SUM(l.credit) FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        WHERE l.account_id=a.id AND e.status='confirmado' AND e.source_module!='reverso'
        ${dateSql}),0) as period_credit
      FROM accounting_accounts a
      WHERE a.active=1 AND a.is_summary=0
      ORDER BY a.code`).all(...dateParams, ...dateParams);

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
        WHERE e.status='confirmado' AND e.source_module!='reverso' AND a.active=1 AND a.is_summary=0
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
        WHERE e.status='confirmado' AND e.source_module!='reverso' AND a.active=1 AND a.is_summary=0
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
      WHERE e.status='confirmado' AND e.source_module!='reverso' AND l.account_id IN (${ph}) AND e.date < ?`).get(...cashIds, from).v) : 0;

    const rows = db.prepare(`
      SELECT e.id, e.date, e.concept, e.source_module,
        COALESCE(SUM(CASE WHEN l.account_id IN (${ph}) THEN l.debit-l.credit ELSE 0 END),0) as cash_delta
      FROM accounting_entries e
      JOIN accounting_entry_lines l ON l.entry_id=e.id
      WHERE e.status='confirmado' AND e.source_module!='reverso'
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
      else if (catName.includes('mantenimiento') || catName.includes('reparaci'))
        expAccId = getAccId('account_maintenance','6110') || getAccId('account_other_exp','6120');
      else if (catName.includes('transporte') || catName.includes('mensajer') || catName.includes('envío') || catName.includes('envio'))
        expAccId = getAccId('account_transport','6108') || getAccId('account_other_exp','6120');

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
      return this.reverseEntry(entry.id, userId || null, reason || 'Origen anulado', { allowSystem: true });
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
        try { this.reverseEntry(e.id, userId || null, reason || 'Origen anulado', { allowSystem: true }); n++; }
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
    else if (cat.includes('mantenimiento') || cat.includes('reparaci'))
      id = getAccId('account_maintenance', '6110') || getAccId('account_other_exp', '6120');
    else if (cat.includes('transporte') || cat.includes('mensajer') || cat.includes('envío') || cat.includes('envio'))
      id = getAccId('account_transport', '6108') || getAccId('account_other_exp', '6120');
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

  // ── Ajuste de valorización de inventario por cambio manual de costo ───────
  // Las compras ya debitan Inventario con el valor recibido. Este asiento cubre
  // solamente cambios de costo que revalorizan stock existente (edición manual,
  // entrada rápida con costo nuevo, etc.) para mantener 1105 = stock * costo.
  generateInventoryRevaluationEntry({ historyId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1') return null;
      if (!historyId) return null;
      if (!tableExists('accounting_entries') || !tableExists('accounting_accounts')) return null;

      const hist = db.prepare('SELECT * FROM product_price_history WHERE id=?').get(historyId);
      if (!hist) return null;
      if ((hist.source || '') === 'compra') return null;

      const amount = round2(hist.stock_value_delta || 0);
      const stockAtChange = Number.parseInt(hist.stock_at_change, 10) || 0;
      if (Math.abs(amount) < 0.005 || Math.abs(hist.cost_delta || 0) < 0.005 || stockAtChange <= 0) return null;

      if (hist.accounting_entry_id) {
        const linked = db.prepare('SELECT id, number, total_debit, total_credit FROM accounting_entries WHERE id=?').get(hist.accounting_entry_id);
        if (linked) {
          return { entryId: linked.id, number: linked.number, totalDebit: linked.total_debit, totalCredit: linked.total_credit };
        }
      }

      const existing = db.prepare(
        "SELECT id, number, total_debit, total_credit FROM accounting_entries WHERE source_module='inventario_valor' AND source_id=?"
      ).get(historyId);
      if (existing) {
        db.prepare("UPDATE product_price_history SET accounting_entry_id=?, accounting_error='' WHERE id=?").run(existing.id, historyId);
        return { entryId: existing.id, number: existing.number, totalDebit: existing.total_debit, totalCredit: existing.total_credit };
      }

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || (fallback ? db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id : null);
      const invAccId  = getAccId('account_inventory', '1105');
      const gainAccId = getAccId('account_inventory_gain', '4104') || getAccId('account_other_rev', '4104');
      const lossAccId = getAccId('account_inventory_loss', '6120') || getAccId('account_other_exp', '6120') || getAccId('account_expense', '6120');
      const product = hist.product_name || hist.product_code || `Producto #${hist.product_id}`;
      const absAmount = round2(Math.abs(amount));

      if (!invAccId || (amount > 0 && !gainAccId) || (amount < 0 && !lossAccId)) {
        throw new Error('Faltan cuentas contables para ajuste de inventario');
      }

      const lines = amount > 0
        ? [
            { account_id: invAccId,  debit: absAmount, credit: 0,         description: `Revalorización inventario ${product}` },
            { account_id: gainAccId, debit: 0,         credit: absAmount, description: `Aumento de costo ${product}` },
          ]
        : [
            { account_id: lossAccId, debit: absAmount, credit: 0,         description: `Disminución de costo ${product}` },
            { account_id: invAccId,  debit: 0,         credit: absAmount, description: `Revalorización inventario ${product}` },
          ];

      const date = String(hist.created_at || new Date().toISOString()).split(' ')[0].split('T')[0];
      const entry = this.createEntry({
        date,
        concept:       `Ajuste valor inventario #${historyId} - ${product}`,
        reference:     `INV-VAL-${historyId}`,
        source_module: 'inventario_valor',
        source_id:     historyId,
        lines,
        notes:         hist.reason || '',
        userId:        userId || hist.user_id || null,
        status:        'confirmado',
      });

      db.prepare("UPDATE product_price_history SET accounting_entry_id=?, accounting_error='' WHERE id=?").run(entry.entryId, historyId);
      return entry;
    } catch (e) {
      console.error('[accounting] generateInventoryRevaluationEntry:', e.message);
      try {
        if (historyId && tableExists('product_price_history')) {
          db.prepare('UPDATE product_price_history SET accounting_error=? WHERE id=?').run(e.message || 'Error contable', historyId);
        }
      } catch {}
      return null;
    }
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

    const initialized = settingsRepo.get('accounting_control_baseline') === '1';
    const mk = (name, control, auxiliar, note, key, code) => {
      const diff = r2(control - auxiliar);
      const ok = Math.abs(diff) < 0.01;
      return {
        name, control: r2(control), auxiliar: r2(auxiliar), diff, ok, note, key, code,
        state: ok ? 'ok' : (initialized ? 'descuadre' : 'pendiente'),
      };
    };
    return [
      mk('Cuentas por cobrar (1104)', cxcCtrl, cxcAux, 'Contable vs suma de saldos de clientes', 'account_ar', '1104'),
      mk('Inventario (1105)',         invCtrl, invAux, 'Contable vs valor de stock a costo', 'account_inventory', '1105'),
      mk('Cuentas por pagar (2101)',  cxpCtrl, cxpAux, 'Contable vs gastos pendientes + compras recibidas', 'account_ap', '2101'),
    ];
  },

  // Crea una apertura balanceada para datos operativos que ya existían antes
  // de activar Contabilidad. No debe ejecutarse automáticamente: el usuario
  // confirma la fecha y la acción queda registrada en Auditoría.
  initializeReconciliation({ date, userId } = {}) {
    return db.transaction(() => {
      if (settingsRepo.get('accounting_control_baseline') === '1') {
        throw new Error('Los saldos auxiliares ya fueron inicializados');
      }
      const checks = this.getReconciliation();
      const cfg = this.getConfig();
      const lines = [];
      let net = 0;

      for (const check of checks) {
        const accountId = cfg[check.key]?.account_id || this.getAccountByCode(check.code)?.id;
        if (!accountId) throw new Error(`Falta configurar la cuenta control ${check.code}`);
        // CxC e Inventario tienen saldo deudor. CxP se guarda acreedor (negativo).
        const currentRaw = check.code === '2101' ? -check.control : check.control;
        const targetRaw = check.code === '2101' ? -check.auxiliar : check.auxiliar;
        const delta = round2(targetRaw - currentRaw);
        if (Math.abs(delta) < 0.01) continue;
        lines.push({
          account_id: accountId,
          debit: delta > 0 ? delta : 0,
          credit: delta < 0 ? -delta : 0,
          description: `Saldo inicial ${check.name.replace(/\s*\([^)]*\)$/, '')}`,
        });
        net = round2(net + delta);
      }

      let entry = null;
      if (lines.length) {
        const equityId = cfg.account_equity?.account_id || this.getAccountByCode('3101')?.id;
        if (!equityId) throw new Error('Falta la cuenta de capital 3101 para balancear la apertura');
        if (Math.abs(net) >= 0.01) {
          lines.push({
            account_id: equityId,
            debit: net < 0 ? -net : 0,
            credit: net > 0 ? net : 0,
            description: 'Contrapartida de saldos iniciales',
          });
        }
        if (lines.length < 2) throw new Error('No fue posible construir una apertura balanceada');
        entry = this.createEntry({
          date: date || new Date().toISOString().slice(0, 10),
          concept: 'Inicialización de saldos auxiliares',
          reference: 'APERTURA-AUXILIARES',
          source_module: 'apertura',
          lines,
          notes: 'Apertura de CxC, inventario y CxP existentes antes de activar Contabilidad.',
          userId,
          status: 'confirmado',
        });
      }
      settingsRepo.set('accounting_control_baseline', '1');
      audit(userId, '', 'saldos_auxiliares_inicializados', 'accounting_entries', entry?.entryId || null,
        entry ? `Asiento ${entry.number}` : 'Sin diferencias');
      return { ok: true, entry, checks: this.getReconciliation() };
    })();
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

    // Las cards del período cuentan SOLO asientos activos:
    //   · sin 'anulado' y sin reversos — un asiento anulado y su reverso se
    //     excluyen COMO PAR. Si se incluyen ambos solo cuadran cuando caen en el
    //     mismo período; anular una venta de un mes anterior dejaba al mes
    //     actual con solo el reverso → ingresos/utilidad NEGATIVOS fantasma.
    //   · sin 'inventario_valor' (revalorización por edición de costo): mantiene
    //     1105 = stock × costo pero no es resultado operativo. Sigue visible en
    //     el widget "Ajustes de valor de inventario" y en reportes por cuenta.
    const getSum = (type, field) => {
      const r = db.prepare(`
        SELECT COALESCE(SUM(l.${field}),0) as v
        FROM accounting_entry_lines l
        JOIN accounting_entries e ON l.entry_id=e.id
        JOIN accounting_accounts a ON l.account_id=a.id
        WHERE e.status='confirmado' AND a.type=? AND e.date BETWEEN ? AND ?
          AND e.source_module NOT IN ('inventario_valor','reverso')
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
        WHERE l.account_id=? AND e.status='confirmado' AND e.source_module!='reverso'`).get(acc.id);
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
// REPOSITORIO: ACTIVOS FIJOS + DEPRECIACIÓN (Fase 7)
// ══════════════════════════════════════════════
// Depreciación en línea recta: (costo − valor residual) / vida útil (meses).
// La corrida mensual postea Déb Depreciación (6119) · Créd Dep. Acumulada (1203),
// idempotente por (activo, período). Respeta el bloqueo de período contable.
const fixedAssetsRepo = {
  _acctId(code) { return db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(code)?.id; },
  _lastDayOfMonth(period) {
    const [y, m] = String(period).split('-').map(Number);
    return `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  },
  monthlyAmount(a) {
    const base = (a.cost || 0) - (a.salvage_value || 0);
    const life = a.useful_life_months || 0;
    if (base <= 0 || life <= 0) return 0;
    return round2(base / life);
  },
  remaining(a) { return round2(((a.cost || 0) - (a.salvage_value || 0)) - (a.accumulated || 0)); },
  bookValue(a) { return round2((a.cost || 0) - (a.accumulated || 0)); },

  getAll({ status } = {}) {
    let q = "SELECT * FROM fixed_assets";
    const p = [];
    if (status) { q += " WHERE status=?"; p.push(status); }
    q += " ORDER BY acquisition_date DESC, id DESC";
    return db.prepare(q).all(...p).map(a => ({
      ...a,
      monthly: this.monthlyAmount(a),
      remaining: this.remaining(a),
      book_value: this.bookValue(a),
    }));
  },
  getById(id) {
    const a = db.prepare("SELECT * FROM fixed_assets WHERE id=?").get(id);
    if (!a) return null;
    a.monthly = this.monthlyAmount(a);
    a.remaining = this.remaining(a);
    a.book_value = this.bookValue(a);
    a.schedule = db.prepare("SELECT * FROM depreciation_entries WHERE fixed_asset_id=? ORDER BY period ASC").all(id);
    return a;
  },
  create(d) {
    const r = db.prepare(`INSERT INTO fixed_assets
      (name,category,acquisition_date,cost,salvage_value,useful_life_months,method,
       asset_code,depreciation_code,accumulated_code,expense_id,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.name, d.category || '', d.acquisition_date || todayStr(),
      d.cost || 0, d.salvage_value || 0, d.useful_life_months || 60, d.method || 'linea_recta',
      d.asset_code || '1201', d.depreciation_code || '6119', d.accumulated_code || '1203',
      d.expense_id || null, d.notes || '');
    return { id: r.lastInsertRowid };
  },
  update(id, d) {
    const a = db.prepare("SELECT * FROM fixed_assets WHERE id=?").get(id);
    if (!a) throw new Error('Activo no encontrado');
    db.prepare(`UPDATE fixed_assets SET name=?,category=?,acquisition_date=?,cost=?,salvage_value=?,
      useful_life_months=?,depreciation_code=?,accumulated_code=?,notes=?,updated_at=datetime('now') WHERE id=?`).run(
      d.name ?? a.name, d.category ?? a.category, d.acquisition_date ?? a.acquisition_date,
      d.cost ?? a.cost, d.salvage_value ?? a.salvage_value, d.useful_life_months ?? a.useful_life_months,
      d.depreciation_code ?? a.depreciation_code, d.accumulated_code ?? a.accumulated_code,
      d.notes ?? a.notes, id);
    return { ok: true };
  },

  // Corrida de depreciación de un período 'YYYY-MM' para todos los activos elegibles.
  runDepreciation({ period, userId } = {}) {
    if (!/^\d{4}-\d{2}$/.test(period || '')) throw new Error('Período inválido (use YYYY-MM)');
    const endDate = this._lastDayOfMonth(period);
    const assets = db.prepare("SELECT * FROM fixed_assets WHERE status='activo' AND acquisition_date<=?").all(endDate);
    let posted = 0, skipped = 0, failed = 0, total = 0;
    for (const a of assets) {
      try {
        // Idempotencia por (activo, período).
        if (db.prepare("SELECT id FROM depreciation_entries WHERE fixed_asset_id=? AND period=?").get(a.id, period)) { skipped++; continue; }
        const amount = Math.min(this.monthlyAmount(a), this.remaining(a));
        if (amount <= 0) { skipped++; continue; }
        const depId = this._acctId(a.depreciation_code || '6119');
        const accId = this._acctId(a.accumulated_code || '1203');
        if (!depId || !accId) { failed++; continue; }
        const entry = accountingRepo.createEntry({
          date: endDate,
          concept: `Depreciación ${period} — ${a.name}`,
          reference: `DEP-${a.id}-${period}`,
          source_module: 'depreciacion',
          source_id: a.id,
          lines: [
            { account_id: depId, debit: amount, credit: 0, description: `Depreciación ${a.name}` },
            { account_id: accId, debit: 0, credit: amount, description: `Dep. acumulada ${a.name}` },
          ],
          userId, status: 'confirmado',
        });
        db.prepare("INSERT INTO depreciation_entries(fixed_asset_id,period,amount,accounting_entry_id) VALUES(?,?,?,?)")
          .run(a.id, period, amount, entry?.entryId || null);
        const newAcc = round2((a.accumulated || 0) + amount);
        const fully = newAcc >= ((a.cost || 0) - (a.salvage_value || 0)) - 0.01;
        db.prepare("UPDATE fixed_assets SET accumulated=?,status=?,updated_at=datetime('now') WHERE id=?")
          .run(newAcc, fully ? 'depreciado' : 'activo', a.id);
        posted++; total = round2(total + amount);
      } catch (e) { failed++; console.error('[activos] depreciación', a.id, e.message); }
    }
    audit(userId, '', 'depreciacion_corrida', 'fixed_assets', null, `${period}: ${posted} posteados, RD$${total}`);
    return { posted, skipped, failed, total };
  },

  // Baja del activo: retira costo y depreciación acumulada; el valor en libros
  // restante va a pérdida (6120). Marca el activo como dado_de_baja.
  dispose({ id, reason, userId } = {}) {
    const a = db.prepare("SELECT * FROM fixed_assets WHERE id=?").get(id);
    if (!a) throw new Error('Activo no encontrado');
    if (a.status === 'dado_de_baja') throw new Error('El activo ya fue dado de baja');
    const assetId = this._acctId(a.asset_code || '1201');
    const accId = this._acctId(a.accumulated_code || '1203');
    const lossId = this._acctId('6120');
    const book = this.bookValue(a);
    const lines = [];
    if (accId && a.accumulated > 0) lines.push({ account_id: accId, debit: round2(a.accumulated), credit: 0, description: `Retiro dep. acum. ${a.name}` });
    if (lossId && book > 0)         lines.push({ account_id: lossId, debit: book, credit: 0, description: `Pérdida en baja ${a.name}` });
    if (assetId && a.cost > 0)      lines.push({ account_id: assetId, debit: 0, credit: round2(a.cost), description: `Baja activo ${a.name}` });
    if (lines.length >= 2) {
      try {
        accountingRepo.createEntry({
          date: todayStr(), concept: `Baja de activo — ${a.name}`, reference: `BAJA-${a.id}`,
          source_module: 'baja_activo', source_id: a.id, lines, userId, status: 'confirmado',
        });
      } catch (e) { console.error('[activos] baja asiento', e.message); }
    }
    db.prepare("UPDATE fixed_assets SET status='dado_de_baja',disposed_at=datetime('now'),dispose_reason=?,updated_at=datetime('now') WHERE id=?")
      .run(reason || '', id);
    audit(userId, '', 'activo_baja', 'fixed_assets', id, reason || '');
    return { ok: true };
  },

  summary() {
    const rows = db.prepare("SELECT * FROM fixed_assets").all();
    const active = rows.filter(a => a.status !== 'dado_de_baja');
    const r2 = (n) => Math.round((n || 0) * 100) / 100;
    return {
      count: active.length,
      totalCost:   r2(active.reduce((s, a) => s + (a.cost || 0), 0)),
      totalAccum:  r2(active.reduce((s, a) => s + (a.accumulated || 0), 0)),
      totalBook:   r2(active.reduce((s, a) => s + this.bookValue(a), 0)),
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
  _syncSequence() {
    const existingMax = db.prepare('SELECT number FROM delivery_notes ORDER BY id').all()
      .reduce((max, row) => {
        const n = parseInt(String(row.number || '').replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) ? Math.max(max, n) : max;
      }, 0);
    db.prepare(`
      UPDATE document_sequences
      SET current=MAX(current,?),updated_at=datetime('now','localtime')
      WHERE kind='conduce'
    `).run(existingMax);
  },

  // Vista previa del próximo correlativo; no consume el número hasta guardar.
  generateNumber() {
    this._syncSequence();
    const seq = db.prepare("SELECT * FROM document_sequences WHERE kind='conduce'").get();
    return `${seq.prefix}-${String(Number(seq.current || 0) + 1).padStart(Number(seq.pad_length) || 6, '0')}`;
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

  create({ header = {}, items = [], userId = null, trustedSnapshot = false }) {
    const tx = db.transaction(() => {
      this._syncSequence();
      const pendingKey = `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const issued = _issueDocumentNumber('conduce', 'delivery_note_pending', pendingKey);
      const number = issued.formatted_number;
      let account = null;
      if (header.customer_id && !(trustedSnapshot && header.preserve_contact_snapshot)) {
        account = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(header.customer_id);
        if (!account) throw new Error('Cliente no encontrado o inactivo');
      }
      let contact = null;
      if (header.customer_contact_id && header.customer_id) {
        const stored = db.prepare('SELECT * FROM customer_contacts WHERE id=? AND customer_id=?')
          .get(header.customer_contact_id, header.customer_id);
        if (!stored) throw new Error('El representante no pertenece al cliente seleccionado');
        if (trustedSnapshot && header.preserve_contact_snapshot) {
          contact = {
            ...stored, name: header.customer_contact_name || stored.name,
            document: header.customer_contact_document || stored.document,
            role: header.customer_contact_role || stored.role,
            phone: header.customer_contact_phone || stored.phone,
            email: header.customer_contact_email || stored.email,
          };
        } else {
          const contactAccount = db.prepare('SELECT customer_type FROM customers WHERE id=?').get(header.customer_id);
          if (contactAccount?.customer_type !== 'company') throw new Error('Solo una empresa puede usar representantes');
          if (stored.active !== 1) throw new Error('El representante seleccionado está inactivo');
          if (stored.can_order !== 1) throw new Error('El representante no está autorizado para solicitar compras');
          contact = stored;
        }
      }
      const r = db.prepare(`
        INSERT INTO delivery_notes
          (number, customer_id, customer_name, customer_rnc,
           customer_contact_id,customer_contact_name,customer_contact_document,
           customer_contact_role,customer_contact_phone,customer_contact_email,branch_id,
           source_type, source_id, status, issue_date, delivery_address,
           driver_name, vehicle_plate, notes, invoice_id, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        number, header.customer_id || null, account?.name || header.customer_name || 'Consumidor Final',
        account?.rnc || header.customer_rnc || '', contact?.id || null, contact?.name || '', contact?.document || '',
        contact?.role || '', contact?.phone || '', contact?.email || '', header.branch_id || null,
        header.source_type || 'manual', header.source_id || null,
        header.status || 'borrador', header.issue_date || todayStr(),
        header.delivery_address || '', header.driver_name || '',
        header.vehicle_plate || '', header.notes || '', header.invoice_id || null, userId
      );
      const id = r.lastInsertRowid;
      db.prepare(`
        UPDATE document_issues
        SET source_type='delivery_note',source_id=?
        WHERE kind='conduce' AND source_type='delivery_note_pending' AND source_id=?
      `).run(String(id), pendingKey);
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
    const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(id);
    if (!dn) throw new Error('Conduce no encontrado');
    if (dn.status !== 'borrador') throw new Error('Solo se puede editar un conduce en BORRADOR');
    const tx = db.transaction(() => {
      let account = null;
      let contact = null;
      if (header.customer_id) {
        account = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(header.customer_id);
        if (!account) throw new Error('Cliente no encontrado o inactivo');
      }
      if (header.customer_contact_id) {
        if (!account || account.customer_type !== 'company') {
          throw new Error('Solo una empresa puede tener representante');
        }
        contact = db.prepare(`
          SELECT * FROM customer_contacts WHERE id=? AND customer_id=? AND active=1 AND can_order=1
        `).get(header.customer_contact_id, account.id);
        if (!contact) throw new Error('El representante no pertenece a la empresa, está inactivo o no puede solicitar compras');
      }
      db.prepare(`
        UPDATE delivery_notes SET
          customer_id=?, customer_name=?, customer_rnc=?, customer_contact_id=?,
          customer_contact_name=?,customer_contact_document=?,customer_contact_role=?,
          customer_contact_phone=?,customer_contact_email=?,branch_id=?,
          delivery_address=?, driver_name=?, vehicle_plate=?, notes=?,
          updated_at=datetime('now','localtime')
        WHERE id=?
      `).run(
        header.customer_id || null, account?.name || header.customer_name || 'Consumidor Final',
        account?.rnc || header.customer_rnc || '', contact?.id || null,
        contact?.name || '',contact?.document || '',contact?.role || '',
        contact?.phone || '',contact?.email || '',header.branch_id || null,
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
      customer: {
        id: dn.customer_id || 1, name: dn.customer_name, rnc: dn.customer_rnc || '',
        contact_id: dn.customer_contact_id || null,
        preserve_customer_snapshot: true, preserve_contact_snapshot: true,
        customer_type: dn.customer_contact_id ? 'company' : undefined,
        contact: dn.customer_contact_id ? {
          id:dn.customer_contact_id,name:dn.customer_contact_name || '',
          document:dn.customer_contact_document || '',role:dn.customer_contact_role || '',
          phone:dn.customer_contact_phone || '',email:dn.customer_contact_email || '',
        } : null,
      },
      items: toInvoice.map(t => ({
        product_id: t.prod.id, product_code: t.prod.code, product_name: t.prod.name,
        unit_cost: t.prod.cost, unit_price: t.price, qty: t.qty,
      })),
      payment: { method: payment.method || 'efectivo', disc: payment.disc || 0, priceMode },
      user,
      type: 'factura',
      trustedCustomerSnapshot: true,
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

    return {
      saleId,
      documentKind: saleRes.documentKind,
      documentNumber: saleRes.documentNumber,
      documentNumberFmt: saleRes.documentNumberFmt,
      ncf: saleRes.ncf,
      total: saleRes.total,
      conduce: this.getById(conduceId),
    };
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
        customer_contact_id: sale.customer_contact_id || null,
        customer_contact_name: sale.customer_contact_name || '',
        customer_contact_document: sale.customer_contact_document || '',
        customer_contact_role: sale.customer_contact_role || '',
        customer_contact_phone: sale.customer_contact_phone || '',
        customer_contact_email: sale.customer_contact_email || '',
        preserve_contact_snapshot: true,
        preserve_customer_snapshot: true,
        source_type: sale.type === 'cotizacion' ? 'cotizacion' : 'factura',
        source_id: saleId,
        invoice_id: sale.type === 'factura' ? saleId : null,
      },
      items: items.map(it => ({
        product_id: it.product_id, product_code: it.product_code,
        description: it.product_name, unit: 'und', qty: it.qty,
      })),
      userId,
      trustedSnapshot: true,
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

// Vendedores/nómina se mantiene en un repositorio separado para no seguir
// creciendo este archivo monolítico; usa siempre la DB activa (multi-negocio).
const salespeopleRepo = createSalespeopleRepo({ getDb: () => db, expensesRepo, audit });
const checkoutOrdersRepo = createCheckoutOrdersRepo({ getDb: () => db, salesRepo, audit });

// ══════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════
module.exports = {
  suppliersRepo,
  purchasesRepo,
  initDB,
  initDetachedDB,
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
  fixedAssetsRepo,
  accountingRepo,
  conduceRepo,
  documentNumberRepo,
  salespeopleRepo,
  checkoutOrdersRepo,
};
