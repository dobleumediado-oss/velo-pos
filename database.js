// ══════════════════════════════════════════════
// database.js — Capa SQLite
// Corre SOLO en el main process de Electron
// NUNCA se expone directamente al renderer
// ══════════════════════════════════════════════

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { app }  = require('electron');
const { todayStr, nowStr, addDaysStr } = require('./lib/dates');
const { searchNorm: _searchNorm, digitsOf: _digitsOf } = require('./lib/text-normalize');
const { round2 } = require('./lib/money');
const { getPendingInvoices } = require('./lib/pending-invoices');
const { reconcileCashSessionTotals } = require('./lib/cash-session-totals');
const { normalizeCustomerPhone } = require('./lib/customer-phone');
const { assertCreditPermission } = require('./lib/user-operational-permissions');
const {
  normalizeLegacyType,
  normalizeLegacySequenceRange,
  normalizeLegacySequenceNumber,
  formatLegacyNcf,
  parseCanonicalLegacyNcf,
  parseRecoverableDuplicatedTypeNcf,
} = require('./lib/ncf-sequences');
const { ensureSalespeopleSchema, createSalespeopleRepo } = require('./src/main/salespeople-repo');
const { ensureCheckoutOrdersSchema, createCheckoutOrdersRepo } = require('./src/main/checkout-orders-repo');
const {
  ensureSaleCorrectionsSchema,
  createSaleCorrectionsRepo,
} = require('./src/main/sale-corrections-repo');

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
  // SQLite UPPER() solo transforma ASCII. VELO_UPPER conserva acentos y Ñ,
  // por lo que "Pérez" se guarda correctamente como "PÉREZ".
  db.function('VELO_UPPER', { deterministic: true }, value =>
    String(value ?? '').trim().toLocaleUpperCase('es-DO')
  );

  // Rendimiento y seguridad
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Si una escritura encuentra la base ocupada, reintenta hasta 5s en vez de
  // fallar de inmediato. Protege operaciones concurrentes (venta + backup, etc).
  db.pragma('busy_timeout = 5000');

  migrateProductsModel();
  createTables();
  migrateTradeInSellerSnapshots();
  migratePriceHistoryAccountingColumns();
  migrateVehiclesModule();
  migratePurchaseColumns();
  migrateTaxColumns();
  migrateECFColumns();
  migrateExpensesColumns();
  migratePaymentsColumns();
  migrateV2IdentityColumns();   // Fase 1 migración v2 (identidad real Equiparts)
  backupBeforeHistoricalNumberContinuation();
  migrateDocumentNumbering();   // Secuencias internas independientes por tipo documental
  migrateCustomerCompanies();   // Personas, empresas, representantes y snapshots
  migrateSalesWorkflowEnhancements(); // Teléfonos múltiples, cargos, USD y fecha documental
  migrateServiceWorkshopEnhancements(); // Taller: ocasionales, anticipos, retiro, abandono y garantías por partida
  ensureUppercasePersistence(); // Defensa backend para datos capturados por formularios
  ensureCheckoutOrdersSchema(db);
  backupBeforeSaleCorrectionsMigration();
  backupBeforeProductCorrectionsMigration();
  ensureSaleCorrectionsSchema(db);
  seedIfEmpty();
  ensureNcfIntegrity();         // C2: índice UNIQUE parcial contra NCF duplicados
  ensureDeliveryExpenseIntegrity(); // gastos de envíos pre-v1.18 sin enlazar/anular

  console.log('[DB] Iniciada en:', DB_PATH);
  return db;
}

// La UI convierte texto mientras se escribe, pero importadores, terminales
// antiguas o llamadas IPC directas también llegan al backend. Estos triggers
// normalizan únicamente campos descriptivos (nunca email, contraseña, URL,
// estados ni identificadores fiscales sensibles a formato).
function ensureUppercasePersistence() {
  const targets = {
    customers: ['name', 'trade_name', 'address', 'notes'],
    customer_contacts: ['name', 'role'],
    customer_branches: ['name', 'code', 'address', 'manager'],
    products: ['code', 'barcode', 'name', 'brand', 'category', 'description', 'model'],
    suppliers: ['name', 'contact', 'address', 'notes'],
    expenses: ['description', 'beneficiary_name', 'notes'],
    vehicles: ['brand', 'model', 'plate', 'color', 'notes'],
    delivery_notes: ['customer_name', 'delivery_address', 'driver_name', 'vehicle_plate', 'notes'],
    purchase_orders: ['supplier_name', 'notes'],
    product_units: ['sale_description', 'notes'],
    tech_description_templates: ['name', 'description'],
    tech_private_purchases: [
      'seller_name', 'seller_address', 'device_name', 'brand', 'model', 'color',
      'physical_condition', 'sale_description', 'seller_signature_name',
      'business_signature_name'
    ],
    sales: [
      'customer_name', 'customer_trade_name', 'customer_address',
      'customer_contact_name', 'customer_contact_role',
      'customer_branch_name', 'customer_branch_code',
      'customer_branch_address', 'notes',
    ],
    payments: ['note'],
  };
  Object.entries(targets).forEach(([table, requestedColumns]) => {
    if (!tableExists(table)) return;
    const available = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const columns = requestedColumns.filter(column => available.has(column));
    if (!columns.length) return;
    const assignment = columns
      .map(column => `"${column}"=VELO_UPPER(NEW."${column}")`)
      .join(',');
    const differs = columns
      .map(column => `COALESCE(NEW."${column}",'')<>VELO_UPPER(NEW."${column}")`)
      .join(' OR ');
    db.exec(`
      DROP TRIGGER IF EXISTS trg_${table}_uppercase_insert;
      DROP TRIGGER IF EXISTS trg_${table}_uppercase_update;
      CREATE TRIGGER trg_${table}_uppercase_insert
      AFTER INSERT ON "${table}"
      WHEN ${differs}
      BEGIN
        UPDATE "${table}" SET ${assignment} WHERE id=NEW.id;
      END;
      CREATE TRIGGER trg_${table}_uppercase_update
      AFTER UPDATE ON "${table}"
      WHEN ${differs}
      BEGIN
        UPDATE "${table}" SET ${assignment} WHERE id=NEW.id;
      END;
    `);
    columns.forEach(column => {
      db.prepare(`
        UPDATE "${table}"
        SET "${column}"=VELO_UPPER("${column}")
        WHERE COALESCE("${column}",'')<>VELO_UPPER("${column}")
      `).run();
    });
  });
}

// Respaldo puntual antes de introducir la separación de fechas. Solo corre una
// vez por base (cuando sale_date aún no existe) y nunca sustituye respaldos.
function backupBeforeSaleCorrectionsMigration() {
  try {
    const hasSales = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales'").get();
    if (!hasSales) return;
    const migrated = db.prepare('PRAGMA table_info(sales)').all().some(column => column.name === 'sale_date');
    if (migrated || !DB_PATH || !fs.existsSync(DB_PATH)) return;
    try { db.pragma('wal_checkpoint(FULL)'); } catch {}
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDir, `velo_pre_sale_corrections_${stamp}.db`);
    fs.copyFileSync(DB_PATH, destination, fs.constants.COPYFILE_EXCL);
    console.log('[BACKUP] Respaldo previo a correcciones de factura:', path.basename(destination));
  } catch (error) {
    // La migración no continúa sin respaldo en una base existente: es preferible
    // un arranque abortado a modificar estructura sin copia recuperable.
    throw new Error(`No se pudo crear el respaldo previo a correcciones de factura: ${error.message}`);
  }
}

// Segundo respaldo puntual: instalaciones que ya tenían corrección de fechas
// reciben ahora documentos compensatorios para líneas. No se amplía el esquema
// de una base con ventas sin dejar antes una copia independiente.
function backupBeforeProductCorrectionsMigration() {
  try {
    const hasSales = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales'").get();
    if (!hasSales) return;
    const migrated = db.prepare('PRAGMA table_info(sales)').all()
      .some(column => column.name === 'correction_kind');
    if (migrated || !DB_PATH || !fs.existsSync(DB_PATH)) return;
    try { db.pragma('wal_checkpoint(FULL)'); } catch {}
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDir, `velo_pre_product_corrections_${stamp}.db`);
    fs.copyFileSync(DB_PATH, destination, fs.constants.COPYFILE_EXCL);
    console.log('[BACKUP] Respaldo previo a corrección de productos:', path.basename(destination));
  } catch (error) {
    throw new Error(`No se pudo crear el respaldo previo a corrección de productos: ${error.message}`);
  }
}

// La continuidad histórica puede alinear números FAC/FCR emitidos después de
// una importación. Antes de cambiar esas etiquetas documentales se crea una
// copia única y recuperable de la base.
function backupBeforeHistoricalNumberContinuation() {
  try {
    if (!DB_PATH || !fs.existsSync(DB_PATH) || !tableExists('sales')) return;
    const columns = db.prepare('PRAGMA table_info(sales)').all().map(column => column.name);
    if (!['import_source','numero_factura','document_kind'].every(column => columns.includes(column))) return;
    const imported = db.prepare(`
      SELECT COALESCE(MAX(id),0) max_id
      FROM sales
      WHERE type='factura'
        AND COALESCE(import_source,'')<>''
        AND numero_factura IS NOT NULL
        AND CAST(numero_factura AS INTEGER)>0
    `).get();
    if (!Number(imported?.max_id || 0)) return;
    const pending = db.prepare(`
      SELECT COUNT(*) count
      FROM sales
      WHERE type='factura'
        AND COALESCE(import_source,'')=''
        AND id>?
        AND COALESCE(document_kind,'')!='factura_historica'
    `).get(Number(imported.max_id));
    if (!Number(pending?.count || 0)) return;
    try { db.pragma('wal_checkpoint(FULL)'); } catch {}
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDir, `velo_pre_historical_numbering_${stamp}.db`);
    fs.copyFileSync(DB_PATH, destination, fs.constants.COPYFILE_EXCL);
    console.log('[BACKUP] Respaldo previo a continuidad de numeración histórica:', path.basename(destination));
  } catch (error) {
    throw new Error(`No se pudo respaldar la numeración anterior: ${error.message}`);
  }
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
      can_sell_credit INTEGER NOT NULL DEFAULT 1,
      credit_limit_per_sale REAL NOT NULL DEFAULT 0,
      can_manage_inventory INTEGER NOT NULL DEFAULT 0,
      module_permissions TEXT NOT NULL DEFAULT '{}',
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
      serialized    INTEGER DEFAULT 0,
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

    -- ── Sucursales de un cliente empresa ──
    -- La empresa (customers) es dueña del RNC, el crédito y la cuenta por cobrar.
    -- Las sucursales son UBICACIONES/entregas bajo esa misma cuenta: NO son
    -- clientes aparte ni tienen RNC propio, así que comparten el RNC sin chocar
    -- con la regla de unicidad de documento.
    CREATE TABLE IF NOT EXISTS customer_branches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id  INTEGER NOT NULL REFERENCES customers(id),
      name         TEXT NOT NULL,
      code         TEXT DEFAULT '',
      address      TEXT DEFAULT '',
      phone        TEXT DEFAULT '',
      manager      TEXT DEFAULT '',
      is_primary   INTEGER DEFAULT 0,
      active       INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      updated_at   TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_branches_customer ON customer_branches(customer_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_branches_primary
      ON customer_branches(customer_id) WHERE active=1 AND is_primary=1;

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
      payment_id      INTEGER REFERENCES payments(id),
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
      customer_branch_id   INTEGER REFERENCES customer_branches(id),
      customer_branch_name TEXT DEFAULT '',
      customer_branch_code TEXT DEFAULT '',
      customer_branch_address TEXT DEFAULT '',
      customer_branch_phone TEXT DEFAULT '',
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
      trade_in_amount REAL NOT NULL DEFAULT 0,
      trade_in_unit_id INTEGER REFERENCES product_units(id),
      print_template_id TEXT DEFAULT '',
      print_printer_type TEXT DEFAULT '',
      print_printer_name TEXT DEFAULT '',
      print_profile_id TEXT DEFAULT '',
      print_copies    INTEGER DEFAULT 1,
      print_action    TEXT DEFAULT 'print',
      operation_id    TEXT DEFAULT '',
      operation_fingerprint TEXT DEFAULT '',
      cancelled_at    TEXT,
      cancel_reason   TEXT DEFAULT '',
      original_sale_id INTEGER,
      replaces_sale_id INTEGER REFERENCES sales(id),
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
      net_subtotal REAL DEFAULT NULL,
      product_unit_id INTEGER REFERENCES product_units(id)
    );

    -- ── Unidades serializadas (VELO TECH POS): cada equipo por IMEI/serial ──
    -- Inerte para auto-repuestos (products.serialized=0). Ver migración
    -- 1.41.0-product-units-serialized (esquema idéntico, para BDs existentes).
    CREATE TABLE IF NOT EXISTS product_units (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL REFERENCES products(id),
      imei           TEXT,
      serial         TEXT,
      condition      TEXT DEFAULT 'nuevo',
      status         TEXT DEFAULT 'en_stock'
                       CHECK(status IN ('en_stock','reservado','vendido','servicio','devuelto')),
      unit_cost      REAL DEFAULT 0,
      color          TEXT DEFAULT '',
      capacity       TEXT DEFAULT '',
      warranty_until TEXT,
      sale_id        INTEGER REFERENCES sales(id),
      purchase_order_id INTEGER REFERENCES purchase_orders(id),
      purchase_item_id INTEGER REFERENCES purchase_items(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      supplier_warranty_until TEXT,
      grade          TEXT NOT NULL DEFAULT '',
      battery_health INTEGER,
      battery_capacity_mah INTEGER,
      sale_description TEXT NOT NULL DEFAULT '',
      refurb_status  TEXT NOT NULL DEFAULT '',
      received_at    TEXT DEFAULT (datetime('now','localtime')),
      sold_at        TEXT,
      notes          TEXT DEFAULT ''
    );

    -- ── Órdenes de servicio / reparación (VELO TECH POS) ──
    -- Las tablas existen en el core, pero solo el vertical TECH expone el
    -- módulo. La entrega enlaza una venta normal para reutilizar fiscalidad,
    -- inventario, caja y contabilidad.
    CREATE TABLE IF NOT EXISTS service_orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      number         TEXT UNIQUE NOT NULL,
      customer_id    INTEGER REFERENCES customers(id),
      customer_name  TEXT NOT NULL DEFAULT 'Consumidor Final',
      product_unit_id INTEGER REFERENCES product_units(id),
      unit_previous_status TEXT DEFAULT '',
      parent_order_id INTEGER REFERENCES service_orders(id),
      device_desc    TEXT NOT NULL,
      imei           TEXT DEFAULT '',
      imei2          TEXT DEFAULT '',
      serial         TEXT DEFAULT '',
      brand          TEXT DEFAULT '',
      model          TEXT DEFAULT '',
      device_color   TEXT DEFAULT '',
      battery_health INTEGER,
      battery_capacity_mah INTEGER,
      problem        TEXT NOT NULL,
      diagnosis      TEXT DEFAULT '',
      quote_amount   REAL NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'recepcion'
                       CHECK(status IN ('recepcion','diagnostico','presupuesto','aprobado','reparando','listo','entregado','cancelado')),
      workflow_status TEXT NOT NULL DEFAULT 'recepcion',
      service_type   TEXT NOT NULL DEFAULT 'reparacion',
      priority       TEXT NOT NULL DEFAULT 'normal',
      promised_at    TEXT,
      intake_condition TEXT DEFAULT '',
      accessories_received TEXT DEFAULT '[]',
      intake_checklist TEXT DEFAULT '{}',
      privacy_consent INTEGER NOT NULL DEFAULT 0,
      approval_version INTEGER NOT NULL DEFAULT 0,
      approved_amount REAL NOT NULL DEFAULT 0,
      approval_method TEXT DEFAULT '',
      approved_by_name TEXT DEFAULT '',
      approval_notes TEXT DEFAULT '',
      quality_checklist TEXT DEFAULT '{}',
      quality_notes TEXT DEFAULT '',
      quality_checked_by INTEGER REFERENCES users(id),
      quality_checked_at TEXT,
      service_warranty_days INTEGER NOT NULL DEFAULT 0,
      warranty_until TEXT,
      technician_id  INTEGER REFERENCES users(id),
      service_technician_id INTEGER,
      received_by    INTEGER REFERENCES users(id),
      sale_id        INTEGER REFERENCES sales(id),
      approved_at    TEXT,
      delivered_at   TEXT,
      notes          TEXT DEFAULT '',
      created_at     TEXT DEFAULT (datetime('now','localtime')),
      updated_at     TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_order_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL CHECK(kind IN ('parte','mano_obra')),
      product_id       INTEGER REFERENCES products(id),
      description      TEXT NOT NULL,
      qty              INTEGER NOT NULL DEFAULT 1,
      unit_price       REAL NOT NULL DEFAULT 0,
      unit_cost        REAL NOT NULL DEFAULT 0,
      taxable          INTEGER NOT NULL DEFAULT 1,
      tax_pct          REAL NOT NULL DEFAULT 18,
      qty_reserved     INTEGER NOT NULL DEFAULT 0,
      qty_consumed     INTEGER NOT NULL DEFAULT 0,
      reservation_status TEXT NOT NULL DEFAULT 'none',
      created_at       TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_order_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      event_type       TEXT NOT NULL,
      from_status      TEXT DEFAULT '',
      to_status        TEXT DEFAULT '',
      title            TEXT NOT NULL,
      detail           TEXT DEFAULT '',
      user_id          INTEGER REFERENCES users(id),
      user_name        TEXT DEFAULT '',
      created_at       TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_order_estimates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      version          INTEGER NOT NULL,
      amount           REAL NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pendiente',
      decision_method  TEXT DEFAULT '',
      decided_by_name  TEXT DEFAULT '',
      decision_notes   TEXT DEFAULT '',
      decided_at       TEXT,
      snapshot_json    TEXT NOT NULL DEFAULT '{}',
      public_code_hash TEXT DEFAULT '',
      public_code_expires_at TEXT,
      public_attempts  INTEGER NOT NULL DEFAULT 0,
      public_locked_until TEXT,
      public_decided_at TEXT,
      created_by       INTEGER REFERENCES users(id),
      created_at       TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(service_order_id, version)
    );
    CREATE TABLE IF NOT EXISTS service_technicians (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      phone            TEXT DEFAULT '',
      specialty        TEXT DEFAULT '',
      commission_pct   REAL NOT NULL DEFAULT 0,
      linked_user_id   INTEGER REFERENCES users(id),
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_public_links (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      public_id        TEXT UNIQUE NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      expires_at       TEXT,
      access_count     INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_by       INTEGER REFERENCES users(id),
      created_at       TEXT DEFAULT (datetime('now','localtime')),
      revoked_at       TEXT
    );
    CREATE TABLE IF NOT EXISTS service_order_notifications (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      channel          TEXT NOT NULL DEFAULT 'whatsapp',
      sent_by          INTEGER REFERENCES users(id),
      sent_at          TEXT,
      provider_message_id TEXT DEFAULT '',
      provider_status  TEXT DEFAULT '',
      provider_error   TEXT DEFAULT '',
      provider_response TEXT DEFAULT '',
      created_at       TEXT DEFAULT (datetime('now','localtime')),
      updated_at       TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(service_order_id, notification_type)
    );
    CREATE TABLE IF NOT EXISTS service_order_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      evidence_type TEXT NOT NULL CHECK(evidence_type IN ('recepcion','diagnostico','proceso','entrega','firma_cliente')),
      storage_path TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
      original_name TEXT DEFAULT '', note TEXT DEFAULT '', captured_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER REFERENCES service_orders(id) ON DELETE SET NULL,
      customer_id INTEGER REFERENCES customers(id), customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT DEFAULT '', device_desc TEXT DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL, ends_at TEXT, technician_id INTEGER REFERENCES service_technicians(id),
      status TEXT NOT NULL DEFAULT 'programada' CHECK(status IN ('programada','confirmada','en_curso','completada','cancelada','no_asistio')),
      notes TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      technician_id INTEGER NOT NULL REFERENCES service_technicians(id),
      started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), ended_at TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK(duration_minutes>=0),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','stopped','voided')),
      notes TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_procurement_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      service_order_item_id INTEGER REFERENCES service_order_items(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id), description TEXT NOT NULL,
      qty_requested INTEGER NOT NULL CHECK(qty_requested>0), qty_received INTEGER NOT NULL DEFAULT 0 CHECK(qty_received>=0),
      supplier_id INTEGER REFERENCES suppliers(id), purchase_order_id INTEGER REFERENCES purchase_orders(id),
      purchase_item_id INTEGER REFERENCES purchase_items(id),
      status TEXT NOT NULL DEFAULT 'solicitada' CHECK(status IN ('solicitada','ordenada','parcial','recibida','cancelada')),
      requested_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_time_one_running ON service_time_entries(technician_id) WHERE status='running';
    CREATE INDEX IF NOT EXISTS idx_service_evidence_order ON service_order_evidence(service_order_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_service_appointments_start ON service_appointments(starts_at,status);
    CREATE INDEX IF NOT EXISTS idx_service_procurement_status ON service_procurement_requests(status,created_at);
    CREATE TABLE IF NOT EXISTS service_message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER REFERENCES service_orders(id) ON DELETE CASCADE,
      appointment_id INTEGER REFERENCES service_appointments(id) ON DELETE CASCADE,
      message_type TEXT NOT NULL,destination TEXT NOT NULL,message TEXT NOT NULL,scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','submitted','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,provider_message_id TEXT DEFAULT '',provider_error TEXT DEFAULT '',
      submitted_at TEXT,updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_service_message_due ON service_message_queue(status,scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_service_orders_status ON service_orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_service_orders_imei ON service_orders(imei);
    CREATE INDEX IF NOT EXISTS idx_service_order_items_order ON service_order_items(service_order_id);
    CREATE INDEX IF NOT EXISTS idx_service_events_order ON service_order_events(service_order_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_service_public_links_order ON service_public_links(service_order_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_service_notifications_status ON service_order_notifications(status, created_at);

    -- ── Equipos usados recibidos como parte de pago (VELO TECH POS R7) ──
    CREATE TABLE IF NOT EXISTS trade_ins (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id         INTEGER UNIQUE NOT NULL REFERENCES sales(id),
      customer_id     INTEGER REFERENCES customers(id),
      product_id      INTEGER NOT NULL REFERENCES products(id),
      product_unit_id INTEGER UNIQUE NOT NULL REFERENCES product_units(id),
      allowance       REAL NOT NULL CHECK(allowance > 0),
      seller_name     TEXT NOT NULL DEFAULT '',
      seller_document TEXT NOT NULL DEFAULT '',
      seller_phone    TEXT NOT NULL DEFAULT '',
      seller_phone_type TEXT NOT NULL DEFAULT 'telefono',
      seller_address  TEXT NOT NULL DEFAULT '',
      seller_email    TEXT NOT NULL DEFAULT '',
      ownership_declared INTEGER NOT NULL DEFAULT 0,
      lawful_origin_declared INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'aplicado' CHECK(status IN ('aplicado','cancelado')),
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_trade_ins_customer ON trade_ins(customer_id, created_at);

    -- ── Descripciones reutilizables y compras de usados a particulares (TECH) ──
    CREATE TABLE IF NOT EXISTS tech_description_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS tech_private_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT UNIQUE NOT NULL,
      seller_name TEXT NOT NULL,
      seller_document TEXT NOT NULL,
      seller_phone TEXT NOT NULL,
      seller_address TEXT NOT NULL DEFAULT '',
      seller_email TEXT NOT NULL DEFAULT '',
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_unit_id INTEGER UNIQUE NOT NULL REFERENCES product_units(id),
      device_name TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      imei TEXT NOT NULL DEFAULT '',
      serial TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      capacity TEXT NOT NULL DEFAULT '',
      battery_health INTEGER,
      battery_capacity_mah INTEGER,
      physical_condition TEXT NOT NULL,
      sale_description TEXT NOT NULL DEFAULT '',
      accessories TEXT NOT NULL DEFAULT '[]',
      amount REAL NOT NULL CHECK(amount > 0),
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      payment_reference TEXT NOT NULL DEFAULT '',
      financial_account_id INTEGER REFERENCES financial_accounts(id),
      cash_session_id INTEGER REFERENCES cash_sessions(id),
      terms_snapshot TEXT NOT NULL,
      ownership_declared INTEGER NOT NULL DEFAULT 0,
      lawful_origin_declared INTEGER NOT NULL DEFAULT 0,
      seller_signature_name TEXT NOT NULL,
      business_signature_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completada' CHECK(status IN ('completada','anulada')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_tech_private_purchases_created
      ON tech_private_purchases(created_at, status);

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
      status          TEXT NOT NULL DEFAULT 'active',
      voided_at       TEXT DEFAULT NULL,
      void_reason     TEXT DEFAULT '',
      voided_by       INTEGER REFERENCES users(id),
      voided_by_name  TEXT DEFAULT '',
      void_cash_session_id INTEGER REFERENCES cash_sessions(id),
      replaces_payment_id INTEGER REFERENCES payments(id),
      financial_account_id INTEGER REFERENCES financial_accounts(id),
      payment_currency TEXT DEFAULT 'DOP',
      exchange_rate REAL DEFAULT 1,
      account_amount REAL DEFAULT 0,
      payment_reference TEXT DEFAULT '',
      operation_id    TEXT DEFAULT '',
      created_at      TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Un recibo de abono puede distribuirse entre varias facturas sin crear
    -- cobros duplicados en Caja ni alterar su numeración documental.
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id             INTEGER NOT NULL REFERENCES payments(id),
      sale_id                INTEGER NOT NULL REFERENCES sales(id),
      amount                 REAL NOT NULL CHECK(amount > 0),
      invoice_balance_before REAL NOT NULL DEFAULT 0,
      invoice_balance_after  REAL NOT NULL DEFAULT 0,
      created_at             TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(payment_id, sale_id)
    );
    CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment
      ON payment_allocations(payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_allocations_sale
      ON payment_allocations(sale_id);

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
      service_procurement_request_id INTEGER,
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
      beneficiary_name TEXT NOT NULL DEFAULT '',
      beneficiary_document TEXT NOT NULL DEFAULT '',
      beneficiary_phone TEXT NOT NULL DEFAULT '',
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
      beneficiary_name TEXT NOT NULL DEFAULT '',
      beneficiary_document TEXT NOT NULL DEFAULT '',
      beneficiary_phone TEXT NOT NULL DEFAULT '',
      user_id         INTEGER REFERENCES users(id),
      status          TEXT DEFAULT 'pagado' CHECK(status IN ('pagado','anulado')),
      cancelled_by    INTEGER REFERENCES users(id),
      cancel_reason   TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Retenciones fiscales documentadas. Se mantienen separadas del gasto/venta
    -- para conservar trazabilidad y soportar conciliaciones IT-1 / IR-17.
    CREATE TABLE IF NOT EXISTS fiscal_withholdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL CHECK(direction IN ('received','made')),
      tax_kind TEXT NOT NULL CHECK(tax_kind IN ('itbis','isr','retribucion_complementaria','other')),
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id INTEGER,
      party_name TEXT DEFAULT '', party_rnc TEXT DEFAULT '', ncf TEXT DEFAULT '',
      document_date TEXT NOT NULL, base_amount REAL NOT NULL DEFAULT 0 CHECK(base_amount>=0),
      rate REAL NOT NULL DEFAULT 0 CHECK(rate>=0), amount REAL NOT NULL CHECK(amount>=0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','voided')),
      notes TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_fiscal_withholdings_period ON fiscal_withholdings(document_date,tax_kind,status);

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
      customer_branch_id INTEGER REFERENCES customer_branches(id),
      customer_branch_name TEXT DEFAULT '',
      customer_branch_code TEXT DEFAULT '',
      customer_branch_address TEXT DEFAULT '',
      customer_branch_phone TEXT DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_sale_items_product_sale ON sale_items(product_id, sale_id);
    CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
    CREATE INDEX IF NOT EXISTS idx_payments_sale     ON payments(sale_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_inv_product       ON inventory_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_inv_product_type_date ON inventory_movements(product_id, type, created_at);
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

// La persona que entrega un equipo como parte de pago no tiene que convertirse
// en cliente habitual. Estos campos conservan su identidad solo en la operación
// y permiten que customer_id sea NULL cuando la factura es a Consumidor Final.
function migrateTradeInSellerSnapshots() {
  if (!tableExists('trade_ins')) return;
  const columns = [
    ['seller_name', "TEXT NOT NULL DEFAULT ''"],
    ['seller_document', "TEXT NOT NULL DEFAULT ''"],
    ['seller_phone', "TEXT NOT NULL DEFAULT ''"],
    ['seller_phone_type', "TEXT NOT NULL DEFAULT 'telefono'"],
    ['seller_address', "TEXT NOT NULL DEFAULT ''"],
    ['seller_email', "TEXT NOT NULL DEFAULT ''"],
    ['ownership_declared', 'INTEGER NOT NULL DEFAULT 0'],
    ['lawful_origin_declared', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  const existing = new Set(db.prepare('PRAGMA table_info(trade_ins)').all().map(column => column.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.prepare(`ALTER TABLE trade_ins ADD COLUMN ${name} ${definition}`).run();
  }
  db.prepare(`
    UPDATE trade_ins
       SET seller_name=COALESCE(NULLIF(seller_name,''),(SELECT name FROM customers WHERE id=trade_ins.customer_id),''),
           seller_document=COALESCE(NULLIF(seller_document,''),(SELECT rnc FROM customers WHERE id=trade_ins.customer_id),''),
           seller_phone=COALESCE(NULLIF(seller_phone,''),(SELECT phone FROM customers WHERE id=trade_ins.customer_id),'')
  `).run();
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
    // Sucursal de entrega (Fase 2): snapshot para el documento. La empresa
    // sigue siendo dueña del RNC/crédito; esto solo indica DÓNDE se entrega.
    ['customer_branch_id', 'INTEGER'],
    ['customer_branch_name', "TEXT DEFAULT ''"],
    ['customer_branch_code', "TEXT DEFAULT ''"],
    ['customer_branch_address', "TEXT DEFAULT ''"],
    ['customer_branch_phone', "TEXT DEFAULT ''"],
    ['operation_id', "TEXT DEFAULT ''"],
    ['operation_fingerprint', "TEXT DEFAULT ''"],
  ];
  for (const [col, def] of customerCols) {
    try { db.prepare(`ALTER TABLE customers ADD COLUMN ${col} ${def}`).run(); }
    catch { /* ya existe */ }
  }
  for (const [col, def] of saleCols) {
    try { db.prepare(`ALTER TABLE sales ADD COLUMN ${col} ${def}`).run(); }
    catch { /* ya existe */ }
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_sales_operation_id
      ON sales(operation_id)
      WHERE operation_id IS NOT NULL AND TRIM(operation_id)<>''`);
  } catch (e) {
    console.warn('[Sales] No se pudo asegurar idempotencia:', e.message);
  }
  const paymentCols = [
    ['customer_contact_id', 'INTEGER'],
    ['customer_contact_name', "TEXT DEFAULT ''"],
    ['customer_contact_document', "TEXT DEFAULT ''"],
    ['customer_contact_role', "TEXT DEFAULT ''"],
    ['customer_contact_phone', "TEXT DEFAULT ''"],
    ['customer_contact_email', "TEXT DEFAULT ''"],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['voided_at', 'TEXT DEFAULT NULL'],
    ['void_reason', "TEXT DEFAULT ''"],
    ['voided_by', 'INTEGER'],
    ['voided_by_name', "TEXT DEFAULT ''"],
    ['void_cash_session_id', 'INTEGER'],
    ['replaces_payment_id', 'INTEGER'],
    ['financial_account_id', 'INTEGER'],
    ['payment_currency', "TEXT DEFAULT 'DOP'"],
    ['exchange_rate', 'REAL DEFAULT 1'],
    ['account_amount', 'REAL DEFAULT 0'],
    ['payment_reference', "TEXT DEFAULT ''"],
    ['operation_id', "TEXT DEFAULT ''"],
  ];
  if (tableExists('payments')) {
    for (const [col, def] of paymentCols) {
      try { db.prepare(`ALTER TABLE payments ADD COLUMN ${col} ${def}`).run(); }
      catch { /* ya existe */ }
    }
    // Una confirmación cuyo resultado se perdió por red puede reintentarse con
    // el mismo operation_id sin cobrar dos veces. Los registros históricos no
    // llevan clave y, por tanto, no se ven afectados.
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_payments_operation_id
        ON payments(operation_id)
        WHERE operation_id IS NOT NULL AND TRIM(operation_id)<>''`);
    } catch (e) {
      console.warn('[Payments] No se pudo asegurar idempotencia:', e.message);
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
      ['customer_branch_id', 'INTEGER'],
      ['customer_branch_name', "TEXT DEFAULT ''"],
      ['customer_branch_code', "TEXT DEFAULT ''"],
      ['customer_branch_address', "TEXT DEFAULT ''"],
      ['customer_branch_phone', "TEXT DEFAULT ''"],
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
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_replaces ON payments(replaces_payment_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status_customer_created
      ON payments(status,customer_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_session_status_created
      ON payments(cash_session_id,status,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_financial_account
      ON payments(financial_account_id,status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_active_replacement
      ON payments(replaces_payment_id)
      WHERE replaces_payment_id IS NOT NULL AND COALESCE(status,'active')='active';
  `);
  if (tableExists('cash_movements')) {
    try { db.prepare('ALTER TABLE cash_movements ADD COLUMN payment_id INTEGER').run(); }
    catch { /* ya existe */ }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cash_movements_payment
        ON cash_movements(payment_id,cash_session_id,type);
      CREATE INDEX IF NOT EXISTS idx_cash_movements_session_created
        ON cash_movements(cash_session_id,created_at,id);
    `);
  }
  if (tableExists('print_jobs')) {
    try { db.prepare('ALTER TABLE print_jobs ADD COLUMN invalidated_at TEXT').run(); }
    catch { /* ya existe */ }
    try { db.prepare("ALTER TABLE print_jobs ADD COLUMN invalidation_reason TEXT DEFAULT ''").run(); }
    catch { /* ya existe */ }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_print_jobs_reference
        ON print_jobs(type,reference_id,created_at DESC);
    `);
  }
  // Sucursales del cliente empresa (idempotente). La empresa conserva RNC,
  // crédito y cuenta por cobrar; las sucursales son solo ubicaciones de entrega.
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_branches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id  INTEGER NOT NULL REFERENCES customers(id),
      name         TEXT NOT NULL,
      code         TEXT DEFAULT '',
      address      TEXT DEFAULT '',
      phone        TEXT DEFAULT '',
      manager      TEXT DEFAULT '',
      is_primary   INTEGER DEFAULT 0,
      active       INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      updated_at   TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_branches_customer ON customer_branches(customer_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_branches_primary
      ON customer_branches(customer_id) WHERE active=1 AND is_primary=1;
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
  // Salida de impresión elegida al cobrar: plantilla y tipo de papel usados.
  addCol('sales', 'print_template_id', "TEXT DEFAULT ''");
  addCol('sales', 'print_printer_type', "TEXT DEFAULT ''");
  addCol('sales', 'print_printer_name', "TEXT DEFAULT ''");
  addCol('sales', 'print_profile_id', "TEXT DEFAULT ''");
  addCol('sales', 'print_copies', 'INTEGER DEFAULT 1');
  addCol('sales', 'print_action', "TEXT DEFAULT 'print'");

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

// Taller profesional R7. Esta migración corre siempre y es idempotente para
// completar también instalaciones que ya tenían órdenes de servicio creadas.
function migrateServiceWorkshopEnhancements() {
  if (!tableExists('service_orders')) return;
  const addCol = (table, col, def) => {
    if (!tableExists(table)) return;
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (!cols.has(col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
  };
  [
    ['customer_document', "TEXT NOT NULL DEFAULT ''"],
    ['customer_phone', "TEXT NOT NULL DEFAULT ''"],
    ['customer_address', "TEXT NOT NULL DEFAULT ''"],
    ['customer_email', "TEXT NOT NULL DEFAULT ''"],
    ['customer_is_occasional', 'INTEGER NOT NULL DEFAULT 0'],
    ['failure_category', "TEXT NOT NULL DEFAULT 'otro'"],
    ['intake_signed_name', "TEXT NOT NULL DEFAULT ''"],
    ['intake_signed_at', 'TEXT'],
    ['ready_at', 'TEXT'],
    ['pickup_due_at', 'TEXT'],
    ['storage_grace_days', 'INTEGER NOT NULL DEFAULT 0'],
    ['storage_fee_per_day', 'REAL NOT NULL DEFAULT 0'],
    ['pickup_notice_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_pickup_notice_at', 'TEXT'],
    ['abandoned_at', 'TEXT'],
    ['pickup_person_name', "TEXT NOT NULL DEFAULT ''"],
    ['pickup_person_document', "TEXT NOT NULL DEFAULT ''"],
    ['pickup_person_phone', "TEXT NOT NULL DEFAULT ''"],
    ['pickup_relationship', "TEXT NOT NULL DEFAULT ''"],
    ['pickup_authorized_by', "TEXT NOT NULL DEFAULT ''"],
    ['pickup_notes', "TEXT NOT NULL DEFAULT ''"],
    ['pickup_signed_at', 'TEXT'],
  ].forEach(([col, def]) => addCol('service_orders', col, def));
  addCol('service_order_items', 'warranty_days', 'INTEGER NOT NULL DEFAULT 0');
  addCol('service_order_items', 'warranty_until', 'TEXT');
  addCol('sales', 'prepaid_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('sales', 'prepaid_reference', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE TABLE IF NOT EXISTS service_order_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
      amount REAL NOT NULL CHECK(amount>0),
      method TEXT NOT NULL DEFAULT 'efectivo',
      reference TEXT NOT NULL DEFAULT '',
      financial_account_id INTEGER REFERENCES financial_accounts(id),
      cash_session_id INTEGER REFERENCES cash_sessions(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','applied','refunded')),
      applied_sale_id INTEGER REFERENCES sales(id),
      received_by INTEGER REFERENCES users(id),
      received_by_name TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      applied_at TEXT,
      refunded_at TEXT,
      refund_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_service_deposits_order ON service_order_deposits(service_order_id,status);
    CREATE INDEX IF NOT EXISTS idx_service_ready_pickup ON service_orders(workflow_status,ready_at,pickup_due_at);
    CREATE INDEX IF NOT EXISTS idx_service_imei_history ON service_orders(imei,imei2,serial,created_at);
  `);

  // Los datos del cliente registrado se copian como snapshot una sola vez.
  db.prepare(`UPDATE service_orders SET
    customer_document=COALESCE(NULLIF(customer_document,''),(SELECT rnc FROM customers WHERE id=service_orders.customer_id),''),
    customer_phone=COALESCE(NULLIF(customer_phone,''),(SELECT phone FROM customers WHERE id=service_orders.customer_id),''),
    customer_address=COALESCE(NULLIF(customer_address,''),(SELECT address FROM customers WHERE id=service_orders.customer_id),''),
    customer_email=COALESCE(NULLIF(customer_email,''),(SELECT email FROM customers WHERE id=service_orders.customer_id),'')
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
    addCol('deliveries', 'customer_branch_id', 'INTEGER DEFAULT NULL');
    addCol('deliveries', 'customer_branch_name', "TEXT DEFAULT ''");
    addCol('deliveries', 'customer_branch_code', "TEXT DEFAULT ''");
    addCol('deliveries', 'customer_branch_address', "TEXT DEFAULT ''");
    addCol('deliveries', 'customer_branch_phone', "TEXT DEFAULT ''");
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

  // Un recibo histórico puede distribuirse entre varias facturas. Esta tabla
  // conserva cada id_pago_detalle del origen sin multiplicar el encabezado en
  // payments y permite reejecutar la migración de forma idempotente.
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_payment_details (
      import_source       TEXT NOT NULL,
      old_id_pago_detalle INTEGER NOT NULL,
      payment_id          INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      sale_id             INTEGER NOT NULL REFERENCES sales(id),
      amount              REAL NOT NULL,
      method              TEXT DEFAULT '',
      created_at          TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY(import_source,old_id_pago_detalle)
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_payment_details_payment
      ON legacy_payment_details(payment_id);
    CREATE INDEX IF NOT EXISTS idx_legacy_payment_details_sale
      ON legacy_payment_details(sale_id);
  `);

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
  // Se activa únicamente cuando existen facturas importadas con numeración
  // histórica. Contado y crédito comparten entonces la secuencia original.
  factura_historica: { prefix: '', pad: 8 },
  cotizacion:      { prefix: 'COT', pad: 6 },
  nota_credito:    { prefix: 'NCR', pad: 6 },
  abono:           { prefix: 'ABO', pad: 6 },
  recibo:          { prefix: 'REC', pad: 6 },
  pago_proveedor:  { prefix: 'PPR', pad: 6 },
  pago_gasto_externo: { prefix: 'RGE', pad: 6 },
  conduce:         { prefix: 'CON', pad: 6 },
  reporte:         { prefix: 'REP', pad: 6 },
};

function importedInvoiceSequenceInfo() {
  if (!db || !tableExists('sales')) return { count: 0, max: 0, pad: 8, maxImportedId: 0 };
  const row = db.prepare(`
    SELECT COUNT(*) count,
           COALESCE(MAX(CAST(numero_factura AS INTEGER)),0) max_number,
           COALESCE(MAX(LENGTH(TRIM(numero_factura_fmt))),8) pad_length,
           COALESCE(MAX(id),0) max_imported_id
    FROM sales
    WHERE type='factura'
      AND COALESCE(import_source,'')<>''
      AND numero_factura IS NOT NULL
      AND CAST(numero_factura AS INTEGER)>0
  `).get();
  return {
    count: Number(row?.count || 0),
    max: Number(row?.max_number || 0),
    pad: Math.max(3, Math.min(12, Number(row?.pad_length || 8))),
    maxImportedId: Number(row?.max_imported_id || 0),
  };
}

function documentKindForSale(type, paymentMethod) {
  if (type === 'cotizacion') return 'cotizacion';
  if (type === 'devolucion') return 'nota_credito';
  if (importedInvoiceSequenceInfo().count > 0) return 'factura_historica';
  return String(paymentMethod || '').toLowerCase() === 'credito'
    ? 'factura_credito'
    : 'factura_contado';
}

// NCF saltados pero nunca emitidos. La DGII permite utilizarlos mientras la
// secuencia continúe vigente. Se guardan aparte del puntero `current` para no
// retroceder el rango ni confundir un hueco disponible con un NCF ya usado.
function ensureNcfAvailableNumbersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ncf_available_numbers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_id     INTEGER NOT NULL REFERENCES ncf_sequences(id),
      ncf_type        TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK(status IN ('available','issued','retired')),
      source          TEXT NOT NULL DEFAULT 'recovery_gap',
      issued_sale_id  INTEGER REFERENCES sales(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      issued_at       TEXT,
      UNIQUE(ncf_type,sequence_number)
    );
    CREATE INDEX IF NOT EXISTS idx_ncf_available_queue
      ON ncf_available_numbers(ncf_type,status,sequence_number);
  `);
}

function allocateNextNcfNumber(type, saleId = null) {
  ensureNcfAvailableNumbersTable();
  const cleanType = normalizeLegacyType(type);

  // Prioridad 1: correlativos saltados y verificados como nunca emitidos.
  // Una comprobación final contra sales+ncf_log protege incluso si la base fue
  // modificada por importación después de crear la cola.
  while (true) {
    const gap = db.prepare(`
      SELECT a.*,s.to_num,s.alert_at
      FROM ncf_available_numbers a
      JOIN ncf_sequences s ON s.id=a.sequence_id
      WHERE a.ncf_type=? AND a.status='available' AND s.active=1
        AND (s.expiry_date IS NULL OR TRIM(s.expiry_date)='' OR date(s.expiry_date)>=date('now','localtime'))
      ORDER BY a.sequence_number,a.id LIMIT 1
    `).get(cleanType);
    if (!gap) break;
    const ncf = formatLegacyNcf(cleanType, gap.sequence_number);
    const occupied = db.prepare(`
      SELECT 1 FROM sales WHERE UPPER(TRIM(COALESCE(ncf,'')))=?
      UNION ALL
      SELECT 1 FROM ncf_log WHERE UPPER(TRIM(COALESCE(ncf,'')))=?
      LIMIT 1
    `).get(ncf, ncf);
    if (occupied) {
      db.prepare("UPDATE ncf_available_numbers SET status='retired' WHERE id=?").run(gap.id);
      continue;
    }
    const claimed = db.prepare(`
      UPDATE ncf_available_numbers
      SET status='issued',issued_sale_id=?,issued_at=datetime('now','localtime')
      WHERE id=? AND status='available'
    `).run(saleId || null, gap.id);
    if (claimed.changes !== 1) continue;
    const queued = db.prepare("SELECT COUNT(*) c FROM ncf_available_numbers WHERE ncf_type=? AND status='available'")
      .get(cleanType).c;
    const tail = Math.max(0, Number(gap.to_num) - Number(
      db.prepare('SELECT current FROM ncf_sequences WHERE id=?').get(gap.sequence_id)?.current || 0
    ));
    return {
      ncf, remaining: Number(queued) + tail, sequence_id: gap.sequence_id,
      from_available_gap: true, sequence_number: Number(gap.sequence_number),
    };
  }

  // Prioridad 2: continuación normal del rango, sin regresar el puntero.
  const seq = db.prepare(`
    SELECT * FROM ncf_sequences
    WHERE type=? AND active=1 AND current < to_num
      AND (expiry_date IS NULL OR TRIM(expiry_date)='' OR date(expiry_date)>=date('now','localtime'))
    ORDER BY id LIMIT 1
  `).get(cleanType);
  if (!seq) throw new Error(`Sin comprobantes vigentes disponibles tipo ${cleanType}`);
  const current = normalizeLegacySequenceNumber(cleanType, seq.current, { allowZero: true });
  const next = current + 1;
  const ncf = formatLegacyNcf(cleanType, next);
  const collision = db.prepare(`
    SELECT 1 FROM sales WHERE UPPER(TRIM(COALESCE(ncf,'')))=?
    UNION ALL
    SELECT 1 FROM ncf_log WHERE UPPER(TRIM(COALESCE(ncf,'')))=?
    LIMIT 1
  `).get(ncf, ncf);
  if (collision) throw new Error(`El próximo comprobante ${ncf} ya figura como emitido; revisa la secuencia fiscal`);
  db.prepare('UPDATE ncf_sequences SET current=? WHERE id=?').run(next, seq.id);
  const queued = db.prepare("SELECT COUNT(*) c FROM ncf_available_numbers WHERE ncf_type=? AND status='available'")
    .get(cleanType).c;
  return {
    ncf, remaining: Number(queued) + (Number(seq.to_num) - next),
    sequence_id: seq.id, from_available_gap: false, sequence_number: next,
  };
}

// Cola de numeración interna LIBERADA por anulación. A diferencia de los NCF,
// el correlativo interno de factura (FAC-/FCR-) sí puede reutilizarse: al anular
// una factura su número vuelve a esta cola para que la próxima factura del mismo
// tipo lo tome y la secuencia "no quede con huecos". Nunca aplica a numeración
// importada (factura_historica), que conserva su número histórico para siempre.
function ensureDocumentAvailableNumbersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_available_numbers (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      kind               TEXT NOT NULL,
      sequence_number    INTEGER NOT NULL,
      formatted_number   TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'available'
                           CHECK(status IN ('available','issued','retired')),
      source             TEXT NOT NULL DEFAULT 'anulacion',
      source_sale_id     INTEGER,
      issued_source_type TEXT,
      issued_source_id   TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      issued_at          TEXT,
      UNIQUE(kind,sequence_number)
    );
    CREATE INDEX IF NOT EXISTS idx_document_available_queue
      ON document_available_numbers(kind,status,sequence_number);
  `);
}

// Reclama el número liberado más bajo de la familia `kind` para asignarlo a la
// nueva venta. Reutiliza el propio asiento anulado de document_issues (lo pone
// 'active' y lo reapunta a la nueva venta) para no chocar con sus índices UNIQUE.
// Devuelve null si no hay número liberado válido y se debe avanzar el correlativo.
function _claimFreedDocumentNumber(kind, sourceType, sourceKey) {
  if (!sourceType || !sourceKey) return null;
  if (kind === 'factura_historica') return null;
  ensureDocumentAvailableNumbersTable();
  while (true) {
    const gap = db.prepare(`
      SELECT * FROM document_available_numbers
      WHERE kind=? AND status='available'
      ORDER BY sequence_number LIMIT 1
    `).get(kind);
    if (!gap) return null;
    const issue = db.prepare(
      'SELECT * FROM document_issues WHERE kind=? AND sequence_number=?'
    ).get(kind, gap.sequence_number);
    if (issue && issue.status === 'cancelled') {
      db.prepare(`
        UPDATE document_issues
        SET status='active',source_type=?,source_id=?
        WHERE id=? AND status='cancelled'
      `).run(sourceType, sourceKey, issue.id);
      db.prepare(`
        UPDATE document_available_numbers
        SET status='issued',issued_source_type=?,issued_source_id=?,
            issued_at=datetime('now','localtime')
        WHERE id=?
      `).run(sourceType, sourceKey, gap.id);
      return {
        kind,
        sequence_number: issue.sequence_number,
        formatted_number: issue.formatted_number,
      };
    }
    // Asiento ya reutilizado o inexistente → este número deja de estar libre.
    db.prepare("UPDATE document_available_numbers SET status='retired' WHERE id=?").run(gap.id);
  }
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

  // Antes de avanzar el correlativo, reutiliza un número liberado por anulación.
  const reclaimed = _claimFreedDocumentNumber(kind, source, sourceKey);
  if (reclaimed) return reclaimed;

  db.prepare(`
    INSERT INTO document_sequences(kind,prefix,current,pad_length)
    VALUES(?,?,0,?)
    ON CONFLICT(kind) DO NOTHING
  `).run(kind, cfg.prefix, cfg.pad);
  if (kind === 'factura_historica') {
    const historical = importedInvoiceSequenceInfo();
    db.prepare(`
      UPDATE document_sequences
      SET current=MAX(current,?),
          pad_length=MAX(pad_length,?),
          updated_at=datetime('now','localtime')
      WHERE kind=?
    `).run(historical.max, historical.pad, kind);
  }
  const seq = db.prepare('SELECT * FROM document_sequences WHERE kind=?').get(kind);
  const next = Number(seq.current || 0) + 1;
  db.prepare(`
    UPDATE document_sequences
    SET current=?,updated_at=datetime('now','localtime')
    WHERE kind=?
  `).run(next, kind);
  const digits = String(next).padStart(Number(seq.pad_length) || cfg.pad, '0');
  const formatted = seq.prefix ? `${seq.prefix}-${digits}` : digits;
  db.prepare(`
    INSERT INTO document_issues(
      kind,sequence_number,formatted_number,source_type,source_id,status
    ) VALUES(?,?,?,?,?,'active')
  `).run(kind, next, formatted, source, sourceKey);
  return { kind, sequence_number: next, formatted_number: formatted };
}

// Reutilización controlada de una numeración comercial interna.
//
// No "libera" el número para la próxima venta: lo transfiere exclusivamente
// desde una factura anulada a su reemplazo. El antecedente permanece en sales
// y document_reuse_log conserva la cadena de auditoría. Nunca aplica a NCF,
// e-CF, documentos importados, clientes registrados ni otras familias.
function _reuseCancelledConsumerFinalNumber(originalSaleId, replacementSaleId, kind, userId = null) {
  originalSaleId = Number(originalSaleId);
  replacementSaleId = Number(replacementSaleId);
  if (!originalSaleId || !replacementSaleId || originalSaleId === replacementSaleId) {
    throw new Error('La factura de origen para registrar nuevamente no es válida');
  }

  const original = db.prepare('SELECT * FROM sales WHERE id=?').get(originalSaleId);
  const replacement = db.prepare('SELECT * FROM sales WHERE id=?').get(replacementSaleId);
  if (!original || !replacement) throw new Error('No se encontró la factura que se desea reemplazar');
  if (original.type !== 'factura' || original.status !== 'cancelled') {
    throw new Error('Solo puede registrarse nuevamente una factura previamente anulada');
  }
  if (Number(original.customer_id) !== 1 || Number(replacement.customer_id) !== 1) {
    throw new Error('La reutilización está reservada a facturas de Consumidor Final');
  }
  if (String(original.import_source || '').trim()) {
    throw new Error('La numeración de una factura importada no puede reutilizarse');
  }
  if (String(original.ncf || '').trim() || String(original.ecf_status || '').trim()) {
    throw new Error('Una factura con NCF o e-CF conserva definitivamente su numeración');
  }
  const fiscalEnabled = db.prepare(
    "SELECT value FROM settings WHERE key='fiscal_enabled'"
  ).get()?.value === '1';
  const availableConsumerNcf = fiscalEnabled
    ? db.prepare(`
        SELECT id FROM ncf_sequences
        WHERE type='B02' AND active=1 AND current < to_num
        ORDER BY id
        LIMIT 1
      `).get()
    : null;
  if (availableConsumerNcf) {
    throw new Error(
      'El reemplazo generaría un comprobante fiscal B02; debe emitirse con un número comercial nuevo'
    );
  }
  if (replacement.type !== 'factura') {
    throw new Error('El documento de reemplazo debe ser una factura');
  }
  if (String(original.document_kind || '') !== String(kind || '')) {
    throw new Error('El reemplazo debe conservar la misma familia de numeración');
  }
  if (!['factura_contado', 'factura_historica'].includes(String(kind || ''))) {
    throw new Error('Esta familia documental no permite reutilización');
  }
  const relatedDocuments = db.prepare(`
    SELECT COUNT(*) AS total
    FROM sales
    WHERE original_sale_id=? AND status!='cancelled'
  `).get(originalSaleId)?.total || 0;
  if (relatedDocuments > 0) {
    throw new Error(
      'La factura tiene notas de crédito, devoluciones o ajustes relacionados y no puede reutilizar su número'
    );
  }

  const existingReplacement = db.prepare(`
    SELECT id FROM sales WHERE replaces_sale_id=? LIMIT 1
  `).get(originalSaleId);
  if (existingReplacement) {
    throw new Error('Esta factura anulada ya fue registrada nuevamente');
  }
  const issue = db.prepare(`
    SELECT id,kind,sequence_number,formatted_number,status
    FROM document_issues
    WHERE kind=? AND source_type='sale' AND source_id=?
    LIMIT 1
  `).get(kind, String(originalSaleId));
  if (!issue || issue.status !== 'cancelled') {
    throw new Error('La numeración original no está disponible para reemplazo controlado');
  }

  db.prepare(`
    UPDATE document_issues
    SET source_id=?,status='active'
    WHERE id=? AND status='cancelled'
  `).run(String(replacementSaleId), issue.id);
  db.prepare(`
    UPDATE sales SET replaces_sale_id=? WHERE id=?
  `).run(originalSaleId, replacementSaleId);
  db.prepare(`
    INSERT INTO document_reuse_log(
      kind,sequence_number,formatted_number,original_sale_id,replacement_sale_id,user_id,reason
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    issue.kind, issue.sequence_number, issue.formatted_number,
    originalSaleId, replacementSaleId, userId || null,
    String(original.cancel_reason || 'Factura anulada y registrada nuevamente').slice(0, 500)
  );

  return {
    kind: issue.kind,
    sequence_number: issue.sequence_number,
    formatted_number: issue.formatted_number,
    reused: true,
    original_sale_id: originalSaleId,
  };
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
    CREATE TABLE IF NOT EXISTS document_reuse_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      kind             TEXT NOT NULL,
      sequence_number  INTEGER NOT NULL,
      formatted_number TEXT NOT NULL,
      original_sale_id INTEGER NOT NULL REFERENCES sales(id),
      replacement_sale_id INTEGER NOT NULL REFERENCES sales(id),
      user_id          INTEGER REFERENCES users(id),
      reason           TEXT DEFAULT '',
      created_at       TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(original_sale_id),
      UNIQUE(replacement_sale_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_reuse_number
      ON document_reuse_log(kind,sequence_number);
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
   ['sales','replaces_sale_id','INTEGER'],
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
    const historical = importedInvoiceSequenceInfo();
    if (historical.count > 0) {
      db.prepare(`
        UPDATE document_sequences
        SET current=MAX(current,?),
            pad_length=MAX(pad_length,?),
            updated_at=datetime('now','localtime')
        WHERE kind='factura_historica'
      `).run(historical.max, historical.pad);

      // Si la migración histórica ya estaba cargada cuando Velo comenzó a
      // facturar, alinear únicamente las ventas posteriores a esa importación.
      // No se renumeran documentos nativos anteriores a un import tardío.
      const continuationSales = db.prepare(`
        SELECT id
        FROM sales
        WHERE COALESCE(import_source,'')=''
          AND type='factura'
          AND id>?
          AND COALESCE(document_kind,'')!='factura_historica'
        ORDER BY id
      `).all(historical.maxImportedId);
      for (const sale of continuationSales) {
        db.prepare(`
          UPDATE document_issues
          SET status='cancelled'
          WHERE source_type='sale' AND source_id=? AND status='active'
            AND kind IN ('factura_contado','factura_credito')
        `).run(String(sale.id));
        const issued = _issueDocumentNumber('factura_historica', 'sale', sale.id);
        db.prepare(`
          UPDATE sales
          SET document_kind='factura_historica',
              document_number=?,
              document_number_fmt=?,
              numero_factura=?,
              numero_factura_fmt=?
          WHERE id=?
        `).run(
          issued.sequence_number, issued.formatted_number,
          issued.sequence_number, issued.formatted_number,
          sale.id
        );
      }
    }

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
        UPDATE sales
        SET document_kind=?,document_number=?,document_number_fmt=?,
            numero_factura=CASE WHEN ?='factura_historica' THEN ? ELSE numero_factura END,
            numero_factura_fmt=CASE WHEN ?='factura_historica' THEN ? ELSE numero_factura_fmt END
        WHERE id=?
      `).run(
        kind, issued.sequence_number, issued.formatted_number,
        kind, issued.sequence_number, kind, issued.formatted_number,
        sale.id
      );
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_replacement
      ON sales(replaces_sale_id) WHERE replaces_sale_id IS NOT NULL;
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
  // Familia de numeración que consumen realmente las facturas nuevas. Cuando el
  // negocio importó facturas históricas, contado y crédito comparten la
  // secuencia `factura_historica`; la de contado deja de usarse. La UI de
  // configuración debe editar ESTA secuencia, no una que nunca se consume.
  activeInvoiceKind() {
    return documentKindForSale('factura', 'efectivo');
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
    // Alta perezosa: una familia (p. ej. factura_historica) puede no tener aún
    // su fila cuando se edita antes de emitir el primer documento nativo.
    db.prepare(`
      INSERT INTO document_sequences(kind,prefix,current,pad_length)
      VALUES(?,?,?,?)
      ON CONFLICT(kind) DO NOTHING
    `).run(kind, cfg.prefix, 0, cfg.pad);
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
    { col: 'beneficiary_name', def: "TEXT NOT NULL DEFAULT ''" },
    { col: 'beneficiary_document', def: "TEXT NOT NULL DEFAULT ''" },
    { col: 'beneficiary_phone', def: "TEXT NOT NULL DEFAULT ''" },
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
    { col: 'beneficiary_name', def: "TEXT NOT NULL DEFAULT ''" },
    { col: 'beneficiary_document', def: "TEXT NOT NULL DEFAULT ''" },
    { col: 'beneficiary_phone', def: "TEXT NOT NULL DEFAULT ''" },
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
    ['pos_discount_auth_limit_pct','10'],
    ['pos_price_change_enabled','1'],
    ['pos_price_max_reduction_amount','0'],
    ['pos_price_max_increase_amount','0'],
    ['pos_cashier_auto_credit_limit_amount','0'],
    ['ncf_counter',    '0'],
    ['barcode_enabled','0'],
    ['barcode_printer',''],
    ['barcode_printer_profile',''],
    ['barcode_media_width_mm','100'],
    ['barcode_printer_dpi','203'],
    ['barcode_media_mode','gap'],
    ['barcode_design', ''],
    ['barcode_calibrations', '{}'],
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
  const result = db.prepare(`
    INSERT INTO audit_logs(user_id,user_name,action,entity,entity_id,detail)
    VALUES(?,?,?,?,?,?)
  `).run(userId, userName, action, entity, entityId, detail);
  // En operación multi-sucursal todas las terminales escriben contra la base
  // central. Este diario inmutable permite demostrar qué operación quedó
  // confirmada y detectar reintentos sin inventar una peligrosa sincronización
  // multi-master cuando una terminal está desconectada.
  try {
    if (tableExists('branch_sync_journal') && entity) {
      const terminalId = db.prepare("SELECT value FROM settings WHERE key='terminal_id'").get()?.value || '';
      const configuredBranch = Number(db.prepare("SELECT value FROM settings WHERE key='terminal_branch_id'").get()?.value) || null;
      const branchId = configuredBranch && db.prepare('SELECT id FROM branches WHERE id=?').get(configuredBranch)
        ? configuredBranch : null;
      const operationId = `audit:${Number(result.lastInsertRowid)}`;
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify({action,entity,entityId,detail})).digest('hex');
      db.prepare(`INSERT OR IGNORE INTO branch_sync_journal(branch_id,terminal_id,entity,entity_id,action,operation_id,payload_hash)
        VALUES(?,?,?,?,?,?,?)`).run(branchId,terminalId,String(entity),String(entityId ?? ''),String(action),operationId,payloadHash);
    }
  } catch (error) {
    console.error('[branch journal]', error.message);
  }
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
    return db.prepare(`
      SELECT id,name,email,role,avatar,active,
             can_sell_credit,credit_limit_per_sale,can_manage_inventory,
             module_permissions,created_at
      FROM users ORDER BY name
    `).all();
  },
  create({
    name, email, password, role, avatar = '', can_sell_credit = 0,
    credit_limit_per_sale = 0, can_manage_inventory = 0, module_permissions = '{}',
  }) {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(`
      INSERT INTO users(
        name,email,password,role,avatar,can_sell_credit,credit_limit_per_sale,
        can_manage_inventory,module_permissions
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      name, email.toLowerCase(), hash, role, avatar,
      can_sell_credit ? 1 : 0,
      Math.max(0, Number(credit_limit_per_sale) || 0),
      can_manage_inventory ? 1 : 0,
      typeof module_permissions === 'string' ? module_permissions : JSON.stringify(module_permissions || {}),
    );
    return r.lastInsertRowid;
  },
  update(id, data = {}) {
    const current = db.prepare(`
      SELECT can_sell_credit,credit_limit_per_sale,can_manage_inventory,module_permissions
      FROM users WHERE id=?
    `).get(id);
    if (!current) throw new Error('Usuario no encontrado');
    const {
      name, email, role, avatar, active,
      can_sell_credit = current.can_sell_credit,
      credit_limit_per_sale = current.credit_limit_per_sale,
      can_manage_inventory = current.can_manage_inventory,
      module_permissions = current.module_permissions,
    } = data;
    db.prepare(`
      UPDATE users SET name=?,email=?,role=?,avatar=?,active=?,
        can_sell_credit=?,credit_limit_per_sale=?,can_manage_inventory=?,module_permissions=?,updated_at=datetime('now')
      WHERE id=?
    `).run(
      name, email.toLowerCase(), role, avatar, active ? 1 : 0,
      can_sell_credit ? 1 : 0,
      Math.max(0, Number(credit_limit_per_sale) || 0),
      can_manage_inventory ? 1 : 0,
      typeof module_permissions === 'string' ? module_permissions : JSON.stringify(module_permissions || {}),
      id,
    );
  },
  setModulePolicy(id, { moduleKey, enabled, creditLimit }) {
    const current = db.prepare(`
      SELECT role,module_permissions,can_sell_credit,credit_limit_per_sale,can_manage_inventory
      FROM users WHERE id=?
    `).get(id);
    if (!current) throw new Error('Usuario no encontrado');
    if (current.role === 'superadmin') throw new Error('El acceso del superadmin es fijo');
    const { MANAGED_MODULE_KEYS, parseModulePermissions } = require('./lib/user-operational-permissions');
    if (!MANAGED_MODULE_KEYS.has(moduleKey)) throw new Error('Módulo no reconocido');
    const permissions = parseModulePermissions(current);
    permissions[moduleKey] = !!enabled;
    const nextCredit = moduleKey === 'credito' ? (enabled ? 1 : 0) : current.can_sell_credit;
    const nextInventory = moduleKey === 'inventario' ? (enabled ? 1 : 0) : current.can_manage_inventory;
    const nextLimit = moduleKey === 'credito' && creditLimit !== undefined
      ? Math.max(0, Math.round((Number(creditLimit) || 0) * 100) / 100)
      : current.credit_limit_per_sale;
    db.prepare(`
      UPDATE users SET module_permissions=?,can_sell_credit=?,credit_limit_per_sale=?,
        can_manage_inventory=?,updated_at=datetime('now') WHERE id=?
    `).run(JSON.stringify(permissions), nextCredit, nextLimit, nextInventory, id);
    return db.prepare(`
      SELECT id,name,email,role,avatar,active,can_sell_credit,credit_limit_per_sale,
             can_manage_inventory,module_permissions,created_at
      FROM users WHERE id=?
    `).get(id);
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
    // Stock EFECTIVO: para productos serializados (VELO TECH POS) es el conteo de
    // unidades en stock; para fungibles (auto-repuestos) es el campo numérico.
    const effectiveStockSelect = tableExists('product_units')
      ? `CASE WHEN COALESCE(p.serialized,0)=1
               THEN COALESCE((SELECT COUNT(*) FROM product_units pu WHERE pu.product_id=p.id AND pu.status='en_stock'),0)
               ELSE p.stock END      AS effective_stock,`
      : `p.stock AS effective_stock,`;
    // En equipos serializados el costo pertenece a cada IMEI/serial. El modelo
    // puede conservar costo 0 porque cada unidad entra con un valor diferente.
    const effectiveCostSelect = tableExists('product_units')
      ? `CASE WHEN COALESCE(p.serialized,0)=1
               THEN COALESCE((SELECT AVG(pu.unit_cost) FROM product_units pu WHERE pu.product_id=p.id AND pu.status='en_stock'),p.cost)
               ELSE p.cost END       AS effective_cost,
         CASE WHEN COALESCE(p.serialized,0)=1
               THEN COALESCE((SELECT SUM(pu.unit_cost) FROM product_units pu WHERE pu.product_id=p.id AND pu.status='en_stock'),0)
               ELSE p.stock*p.cost END AS effective_inventory_value,`
      : `p.cost AS effective_cost, p.stock*p.cost AS effective_inventory_value,`;
    return db.prepare(`
      SELECT p.*,
             ${effectiveStockSelect}
             ${effectiveCostSelect}
             (COALESCE((
               SELECT SUM(coi.qty)
               FROM checkout_order_items coi
               JOIN checkout_orders co ON co.id=coi.order_id
               WHERE coi.product_id=p.id AND co.status='pending'
                 AND co.expires_at > datetime('now','localtime')
             ),0) + COALESCE((
               SELECT SUM(soi.qty_reserved)
               FROM service_order_items soi
               WHERE soi.product_id=p.id AND soi.reservation_status='reserved'
             ),0)) AS reserved_stock,
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

      const changesSerialized = p.serialized !== undefined && p.serialized !== null &&
        Number(before.serialized || 0) !== (p.serialized ? 1 : 0);
      if (changesSerialized && !p.serialized && tableExists('product_units')) {
        const units = db.prepare('SELECT COUNT(*) n FROM product_units WHERE product_id=?').get(id).n;
        if (units > 0) {
          throw new Error('No se puede desactivar el serializado: el producto ya tiene unidades registradas');
        }
      }

      // Igual que en create(): barcode vacío → código del artículo.
      const barcode = String(p.barcode || '').trim() || String(p.code || '').trim();
      db.prepare(`
        UPDATE products SET code=?,barcode=?,name=?,brand=?,category=?,description=?,model=?,
        cost=?,price=?,wholesale=?,taxable=?,tax_pct=?,stock_min=?,unit=?,condition=?,
        serialized=COALESCE(?,serialized),updated_at=datetime('now')
        WHERE id=?
      `).run(p.code,barcode,p.name,p.brand||'',p.category||'',p.description||'',
             p.model||'',p.cost,p.price,p.wholesale||p.price,
             normalizeTaxable(p.taxable, 1), normalizeTaxPct(p.tax_pct, 18),
             p.stock_min||5,p.unit||'und', p.condition||'nuevo',
             p.serialized === undefined || p.serialized === null ? null : (p.serialized ? 1 : 0), id);

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

function branchesForCustomer(customerId) {
  if (!tableExists('customer_branches')) return [];
  return db.prepare(`
    SELECT * FROM customer_branches
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
    phone: normalizeCustomerPhone(row?.phone || row?.number).slice(0, 40),
    is_primary: row?.is_primary ? 1 : 0,
    _index: index,
  })).filter(row => row.phone);
  if (!clean.length && String(legacyPhone || '').trim()) {
    const phone = normalizeCustomerPhone(legacyPhone).slice(0, 40);
    if (phone) clean.push({ phone_type: 'telefono', phone, is_primary: 1, _index: 0 });
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

function ensurePrimaryCustomerBranch(customerId) {
  const primary = db.prepare(`SELECT id FROM customer_branches WHERE customer_id=? AND active=1 AND is_primary=1 LIMIT 1`).get(customerId);
  if (primary) return primary.id;
  const first = db.prepare(`SELECT id FROM customer_branches WHERE customer_id=? AND active=1 ORDER BY id LIMIT 1`).get(customerId);
  if (first) db.prepare('UPDATE customer_branches SET is_primary=1 WHERE id=?').run(first.id);
  return first?.id || null;
}

function hydratePaymentAllocations(payment) {
  if (!payment) return payment;
  let allocations = [];
  if (tableExists('payment_allocations')) {
    allocations = db.prepare(`
      SELECT pa.id,pa.payment_id,pa.sale_id,pa.amount,
             pa.invoice_balance_before,pa.invoice_balance_after,
             s.status AS sale_status,s.correction_kind,s.original_sale_id,
             s.document_number_fmt,s.numero_factura,s.numero_factura_fmt,s.ncf,
             s.sale_date,s.total AS sale_total
      FROM payment_allocations pa
      JOIN sales s ON s.id=pa.sale_id
      WHERE pa.payment_id=?
      ORDER BY pa.id
    `).all(payment.id);
  }
  // Compatibilidad: los abonos anteriores a esta actualización conservan
  // sale_id en payments y se presentan como una aplicación única.
  if (!allocations.length && payment.sale_id) {
    allocations = [{
      payment_id: payment.id,
      sale_id: payment.sale_id,
      amount: payment.amount,
      invoice_balance_before: null,
      invoice_balance_after: null,
      sale_status: payment.sale_status || '',
      correction_kind: payment.sale_correction_kind || '',
      original_sale_id: payment.sale_original_sale_id || null,
      document_number_fmt: payment.sale_document_number_fmt || '',
      numero_factura: payment.sale_numero_factura,
      numero_factura_fmt: payment.sale_numero_factura_fmt || '',
      ncf: payment.sale_ncf || '',
      sale_date: payment.sale_date || '',
      sale_total: payment.sale_total || 0,
      legacy: true,
    }];
  }
  return {
    ...payment,
    allocations,
    allocation_count: allocations.length,
    allocated_amount: round2(allocations.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
  };
}

function normalizeOperationId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 100);
}

function canonicalPaymentAllocations(allocations, saleId = null, amount = 0) {
  const totals = new Map();
  for (const row of allocations || []) {
    const id = Number(row?.saleId ?? row?.sale_id);
    const value = round2(Number(row?.amount) || 0);
    if (id > 0 && value > 0) totals.set(id, round2((totals.get(id) || 0) + value));
  }
  if (!totals.size && Number(saleId) > 0) totals.set(Number(saleId), round2(Number(amount) || 0));
  return [...totals.entries()].sort((a, b) => a[0] - b[0]);
}

function paymentOperationFingerprint({
  customerId, amount, method, note, saleId, allocations, contactId,
  replacesPaymentId, financialAccountId, exchangeRate, paymentReference,
}) {
  const canonical = {
    customerId: Number(customerId),
    amount: round2(Number(amount) || 0),
    method: String(method || 'efectivo').trim().toLowerCase(),
    allocations: canonicalPaymentAllocations(allocations, saleId, amount),
    contactId: Number(contactId) || null,
    replacesPaymentId: Number(replacesPaymentId) || null,
    financialAccountId: Number(financialAccountId) || null,
    exchangeRate: round2(Number(exchangeRate) || 1),
    reference: String(paymentReference || note || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function paymentConfirmationResult(payment, { idempotent = false } = {}) {
  if (!payment) return null;
  const hydrated = hydratePaymentAllocations(payment);
  return {
    before: Number(payment.balance_before || 0),
    after: Number(payment.balance_after || 0),
    amount: Number(payment.amount || 0),
    paymentId: Number(payment.id),
    saleId: payment.sale_id ? Number(payment.sale_id) : null,
    sale_document_number_fmt: payment.sale_document_number_fmt || '',
    sale_numero_factura: payment.sale_numero_factura ?? null,
    sale_numero_factura_fmt: payment.sale_numero_factura_fmt || '',
    document_kind: payment.document_kind || 'abono',
    document_number: payment.document_number,
    document_number_fmt: payment.document_number_fmt || '',
    numero_recibo: payment.numero_recibo,
    customer_contact_id: payment.customer_contact_id || null,
    customer_contact_name: payment.customer_contact_name || '',
    customer_contact_document: payment.customer_contact_document || '',
    customer_contact_role: payment.customer_contact_role || '',
    customer_contact_phone: payment.customer_contact_phone || '',
    cash_session_id: payment.cash_session_id || null,
    created_at: payment.created_at || '',
    financial_account_id: payment.financial_account_id || null,
    payment_currency: payment.payment_currency || 'DOP',
    exchange_rate: Number(payment.exchange_rate || 1),
    account_amount: Number(payment.account_amount || 0),
    payment_reference: payment.payment_reference || '',
    replaces_payment_id: payment.replaces_payment_id || null,
    allocations: hydrated.allocations || [],
    operation_id: payment.operation_id || '',
    status: String(payment.status || 'active').toLowerCase(),
    idempotent,
  };
}

function findPaymentByOperationId(operationId, customerId = null) {
  operationId = normalizeOperationId(operationId);
  if (!operationId) return null;
  const params = [operationId];
  let customerFilter = '';
  if (customerId != null) {
    customerFilter = 'AND p.customer_id=?';
    params.push(Number(customerId));
  }
  return db.prepare(`
    SELECT p.*,s.document_number_fmt AS sale_document_number_fmt,
           s.numero_factura AS sale_numero_factura,
           s.numero_factura_fmt AS sale_numero_factura_fmt
    FROM payments p
    LEFT JOIN sales s ON s.id=p.sale_id
    WHERE p.operation_id=? ${customerFilter}
    LIMIT 1
  `).get(...params) || null;
}

const customersRepo = {
  getAll() {
    return db.prepare('SELECT * FROM customers WHERE active=1 ORDER BY name').all()
      .map(customer => ({
        ...customer,
        contacts: contactsForCustomer(customer.id),
        branches: branchesForCustomer(customer.id),
        phones: phonesForCustomer(customer.id),
      }));
  },
  getById(id) {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    return customer ? {
      ...customer,
      contacts: contactsForCustomer(customer.id),
      branches: branchesForCustomer(customer.id),
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
      db.prepare("UPDATE customer_branches SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE customer_id=? AND active=1").run(id);
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
        normalizeCustomerPhone(c.phone), String(c.email || '').trim(), primary,
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
        normalizeCustomerPhone(c.phone), String(c.email || '').trim(), primary,
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
  // ── Sucursales del cliente empresa ──
  // Ubicaciones de entrega bajo la misma cuenta; sin RNC ni crédito propio.
  getBranches(customerId) {
    return branchesForCustomer(customerId);
  },
  createBranch(customerId, b) {
    const customer = db.prepare("SELECT id,customer_type FROM customers WHERE id=? AND active=1").get(customerId);
    if (!customer) throw new Error('Cliente no encontrado');
    if (customer.customer_type !== 'company') throw new Error('Solo las empresas pueden tener sucursales');
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('El nombre de la sucursal es requerido');
    return db.transaction(() => {
      const primary = b.is_primary ? 1 : 0;
      if (primary) db.prepare('UPDATE customer_branches SET is_primary=0 WHERE customer_id=?').run(customerId);
      const r = db.prepare(`
        INSERT INTO customer_branches(customer_id,name,code,address,phone,manager,is_primary)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        customerId, name, String(b.code || '').trim(), String(b.address || '').trim(),
        String(b.phone || '').trim(), String(b.manager || '').trim(), primary
      );
      ensurePrimaryCustomerBranch(customerId);
      return Number(r.lastInsertRowid);
    })();
  },
  updateBranch(id, b) {
    const current = db.prepare('SELECT * FROM customer_branches WHERE id=? AND active=1').get(id);
    if (!current) throw new Error('Sucursal no encontrada');
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('El nombre de la sucursal es requerido');
    db.transaction(() => {
      const primary = b.is_primary ? 1 : 0;
      if (primary) db.prepare('UPDATE customer_branches SET is_primary=0 WHERE customer_id=?').run(current.customer_id);
      db.prepare(`
        UPDATE customer_branches SET name=?,code=?,address=?,phone=?,manager=?,is_primary=?,
          updated_at=datetime('now','localtime')
        WHERE id=?
      `).run(
        name, String(b.code || '').trim(), String(b.address || '').trim(),
        String(b.phone || '').trim(), String(b.manager || '').trim(), primary, id
      );
      ensurePrimaryCustomerBranch(current.customer_id);
    })();
    return this.getBranches(current.customer_id);
  },
  deleteBranch(id) {
    const current = db.prepare('SELECT * FROM customer_branches WHERE id=? AND active=1').get(id);
    if (!current) throw new Error('Sucursal no encontrada');
    db.transaction(() => {
      db.prepare("UPDATE customer_branches SET active=0,is_primary=0,updated_at=datetime('now','localtime') WHERE id=?").run(id);
      ensurePrimaryCustomerBranch(current.customer_id);
    })();
    return { id, customerId: current.customer_id, name: current.name };
  },
  addPayment({
    customerId, amount, method, note, saleId = null, allocations = null,
    contactId = null, cajero = '', userId = null, sessionId = null,
    replacesPaymentId = null, financialAccountId = null,
    exchangeRate = 1, paymentReference = '', operationId = ''
  }) {
    operationId = normalizeOperationId(operationId);
    if (operationId) {
      const previous = findPaymentByOperationId(operationId);
      if (previous) {
        if (String(previous.status || 'active').toLowerCase() !== 'active') {
          throw new Error('Esta confirmación corresponde a un abono que ya fue anulado');
        }
        const previousAllocations = hydratePaymentAllocations(previous).allocations;
        const requestedAllocations = Array.isArray(allocations) && allocations.length
          ? allocations
          : (saleId ? null : previousAllocations);
        // Cuando el usuario no elige una cuenta, el backend selecciona la
        // cuenta DOP compatible. En el reintento se compara contra esa decisión
        // ya confirmada, sin aceptar una cuenta explícita diferente.
        const requestedFinancialAccountId = Number(financialAccountId) || null;
        const requestedFingerprint = paymentOperationFingerprint({
          customerId, amount, method, note, saleId,
          allocations: requestedAllocations, contactId, replacesPaymentId,
          financialAccountId: requestedFinancialAccountId || previous.financial_account_id,
          exchangeRate, paymentReference,
        });
        const storedFingerprint = paymentOperationFingerprint({
          customerId: previous.customer_id,
          amount: previous.amount,
          method: previous.method,
          note: previous.note,
          saleId: previous.sale_id,
          allocations: previousAllocations,
          contactId: previous.customer_contact_id,
          replacesPaymentId: previous.replaces_payment_id,
          financialAccountId: previous.financial_account_id,
          exchangeRate: previous.exchange_rate,
          paymentReference: previous.payment_reference,
        });
        if (requestedFingerprint !== storedFingerprint) {
          throw new Error('La operación ya fue confirmada con otros datos; actualiza el historial antes de continuar');
        }
        return paymentConfirmationResult(previous, { idempotent: true });
      }
    }
    // VALIDACIONES: prevenir abonos inválidos que corrompan el balance
    amount = round2(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('El monto del abono debe ser mayor a cero');
    }
    if (amount > 9999999) throw new Error('Monto de abono excede el límite permitido');
    const cust = db.prepare('SELECT id,customer_type,balance,credit_due FROM customers WHERE id=?').get(customerId);
    if (!cust) throw new Error('Cliente no encontrado');
    if (cust.balance <= 0) throw new Error('El cliente no tiene balance pendiente');
    const before = round2(cust.balance);
    if (amount > before + 0.01) throw new Error(`El abono (${amount.toFixed(2)}) supera el balance actual (${before.toFixed(2)})`);
    let replacedPayment = null;
    if (replacesPaymentId) {
      replacedPayment = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(replacesPaymentId));
      if (!replacedPayment) throw new Error('El abono anulado que se desea corregir no existe');
      if (Number(replacedPayment.customer_id) !== Number(customerId)) {
        throw new Error('El abono corregido debe pertenecer al mismo cliente');
      }
      if (String(replacedPayment.status || 'active').toLowerCase() !== 'cancelled') {
        throw new Error('Primero debes anular el abono que se desea corregir');
      }
      if (
        String(replacedPayment.import_source || '').trim() ||
        String(replacedPayment.cajero || '').trim() === 'Importación histórica' ||
        String(replacedPayment.note || '').trim() === 'Saldo inicial importado'
      ) {
        throw new Error('Los abonos importados no pueden reemplazarse');
      }
      const activeReplacement = db.prepare(`
        SELECT id FROM payments
        WHERE replaces_payment_id=? AND COALESCE(status,'active')='active'
        LIMIT 1
      `).get(Number(replacesPaymentId));
      if (activeReplacement) {
        throw new Error('Este abono anulado ya tiene un recibo corregido vigente');
      }
      replacesPaymentId = Number(replacesPaymentId);
    } else {
      replacesPaymentId = null;
    }
    const pending = getPendingInvoices(db, customerId);
    const pendingInvoices = pending.facturas || [];
    const bySaleId = new Map(pendingInvoices.map(invoice => [Number(invoice.id), invoice]));
    const requested = new Map();
    if (Array.isArray(allocations)) {
      allocations.forEach(row => {
        const id = Number(row?.saleId ?? row?.sale_id);
        const value = round2(Number(row?.amount) || 0);
        if (id > 0 && value > 0) requested.set(id, round2((requested.get(id) || 0) + value));
      });
    }
    if (!requested.size && saleId) requested.set(Number(saleId), round2(Number(amount)));
    if (!requested.size && pendingInvoices.length === 1) {
      requested.set(Number(pendingInvoices[0].id), round2(Number(amount)));
    }
    if (!requested.size && pendingInvoices.length > 1) {
      throw new Error('Este cliente tiene varias facturas pendientes. Selecciona una o varias facturas y distribuye el abono');
    }

    const normalizedAllocations = [];
    for (const [invoiceId, appliedAmount] of requested.entries()) {
      const invoice = bySaleId.get(invoiceId);
      if (!invoice) {
        throw new Error('Una factura seleccionada no pertenece al cliente, está anulada o ya no tiene balance pendiente');
      }
      const invoicePending = round2(Number(invoice.pendiente || 0));
      if (appliedAmount > invoicePending + 0.01) {
        throw new Error(
          `El monto aplicado a la factura excede su pendiente (${invoicePending.toFixed(2)})`
        );
      }
      normalizedAllocations.push({
        saleId: invoiceId,
        amount: appliedAmount,
        invoiceBalanceBefore: invoicePending,
        invoiceBalanceAfter: Math.max(0, round2(invoicePending - appliedAmount)),
        invoice,
      });
    }
    const allocatedAmount = round2(normalizedAllocations.reduce((sum, row) => sum + row.amount, 0));
    const unallocatedAmount = round2(Number(amount) - allocatedAmount);
    if (unallocatedAmount < -0.01) {
      throw new Error('La distribución entre facturas supera el monto total del abono');
    }
    if (pendingInvoices.length &&
        unallocatedAmount > Number(pending.unallocatedBalance || 0) + 0.01) {
      throw new Error(`Falta distribuir ${unallocatedAmount.toFixed(2)} del abono entre las facturas seleccionadas`);
    }
    if (!pendingInvoices.length && Number(pending.unallocatedBalance || 0) + 0.01 < Number(amount)) {
      throw new Error('No existe saldo no vinculado suficiente para aplicar este abono');
    }
    const selectedInvoice = normalizedAllocations.length === 1
      ? normalizedAllocations[0].invoice : null;
    saleId = selectedInvoice ? Number(selectedInvoice.id) : null;
    const after  = Math.max(0, round2((before - amount)));
    method = String(method || 'efectivo').trim().toLowerCase();
    const bankMethod = ['transferencia', 'tarjeta', 'cheque'].includes(method);
    let financialAccount = null;
    let accountAmount = 0;
    let paymentCurrency = 'DOP';
    exchangeRate = round2(Number(exchangeRate) || 1);
    if (bankMethod && tableExists('financial_accounts')) {
      let accountId = Number(financialAccountId) || null;
      if (!accountId) {
        const preferredType = method === 'tarjeta' ? 'tarjeta' : 'banco';
        accountId = db.prepare(`
          SELECT id FROM financial_accounts
          WHERE active=1 AND type=?
          ORDER BY CASE WHEN upper(COALESCE(currency,'DOP'))='DOP' THEN 0 ELSE 1 END, id
          LIMIT 1
        `).get(preferredType)?.id || null;
      }
      financialAccount = accountId
        ? db.prepare('SELECT * FROM financial_accounts WHERE id=? AND active=1').get(accountId)
        : null;
      if (!financialAccount) {
        throw new Error(
          `Configura o selecciona una cuenta activa para recibir el abono por ${method}`
        );
      }
      if (method !== 'tarjeta' && financialAccount.type !== 'banco') {
        throw new Error('Transferencias y cheques deben recibirse en una cuenta bancaria');
      }
      paymentCurrency = String(financialAccount.currency || 'DOP').toUpperCase();
      if (!['DOP', 'USD'].includes(paymentCurrency)) {
        throw new Error(`Moneda de cuenta no soportada: ${paymentCurrency}`);
      }
      if (paymentCurrency === 'USD') {
        if (exchangeRate < 20 || exchangeRate > 500) {
          throw new Error('Indica una tasa USD válida para acreditar la cuenta');
        }
        accountAmount = round2(amount / exchangeRate);
      } else {
        exchangeRate = 1;
        accountAmount = amount;
      }
    } else {
      financialAccountId = null;
      exchangeRate = 1;
    }
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
          customer_contact_phone,customer_contact_email,replaces_payment_id,
          financial_account_id,payment_currency,exchange_rate,account_amount,payment_reference,
          operation_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
      `).run(
        customerId, saleId, amount, method, note||'Abono', before, after, cajero, userId, sessionId || null,
        contact?.id || null, contact?.name || '', contact?.document || '', contact?.role || '',
        contact?.phone || '', contact?.email || '', replacesPaymentId,
        financialAccount?.id || null, paymentCurrency, exchangeRate, accountAmount,
        String(paymentReference || note || '').trim().slice(0, 120), operationId
      );
      const paymentId = payInsert.lastInsertRowid;
      if (normalizedAllocations.length) {
        const insertAllocation = db.prepare(`
          INSERT INTO payment_allocations(
            payment_id,sale_id,amount,invoice_balance_before,invoice_balance_after
          ) VALUES(?,?,?,?,?)
        `);
        normalizedAllocations.forEach(row => insertAllocation.run(
          paymentId, row.saleId, row.amount,
          row.invoiceBalanceBefore, row.invoiceBalanceAfter
        ));
      }
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
          INSERT INTO cash_movements(
            cash_session_id,type,amount,method,reference_id,payment_id,description,user_id
          ) VALUES(?,?,?,?,?,?,?,?)
        `).run(
          sessionId, 'abono', amount, method || 'efectivo',
          paymentId, paymentId,
          normalizedAllocations.length > 1
            ? `Abono distribuido en ${normalizedAllocations.length} facturas`
            : 'Abono cliente',
          userId
        );
      }
      if (financialAccount && accountAmount > 0.005) {
        financialAccountsRepo.addMovement({
          accountId: financialAccount.id,
          type: 'abono_recibido',
          amount: accountAmount,
          description: `Abono ${documentIssue.formatted_number}`,
          referenceType: 'payment',
          referenceId: Number(paymentId),
          method,
          userId,
          notes: paymentCurrency === 'USD'
            ? `Base RD$${amount.toFixed(2)} · Tasa ${exchangeRate.toFixed(2)}`
            : String(paymentReference || note || '').trim().slice(0, 300),
        });
      }
      return {
        before, after, amount, paymentId, saleId: saleId || null,
        sale_document_number_fmt: selectedInvoice?.document_number_fmt || '',
        sale_numero_factura: selectedInvoice?.numero_factura ?? null,
        sale_numero_factura_fmt: selectedInvoice?.numero_factura_fmt || '',
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
        cash_session_id: sessionId || null,
        created_at: db.prepare('SELECT created_at FROM payments WHERE id=?').get(paymentId)?.created_at || '',
        financial_account_id: financialAccount?.id || null,
        payment_currency: paymentCurrency,
        exchange_rate: exchangeRate,
        account_amount: accountAmount,
        payment_reference: String(paymentReference || note || '').trim().slice(0, 120),
        operation_id: operationId,
        replaces_payment_id: replacesPaymentId,
        replaces_payment_document_number_fmt:
          replacedPayment?.document_number_fmt ||
          (replacedPayment?.numero_recibo != null
            ? `REC-${String(replacedPayment.numero_recibo).padStart(6, '0')}`
            : ''),
        allocations: normalizedAllocations.map(row => ({
          sale_id: row.saleId,
          amount: row.amount,
          invoice_balance_before: row.invoiceBalanceBefore,
          invoice_balance_after: row.invoiceBalanceAfter,
          document_number_fmt: row.invoice.document_number_fmt || '',
          numero_factura: row.invoice.numero_factura ?? null,
          numero_factura_fmt: row.invoice.numero_factura_fmt || '',
          ncf: row.invoice.ncf || '',
          correction_kind: row.invoice.correction_kind || '',
          original_sale_id: row.invoice.original_sale_id || null,
        })),
        unallocated_amount: Math.max(0, unallocatedAmount),
      };
    });
    return payTx();
  },
  getPaymentByOperationId(operationId, customerId = null) {
    const payment = findPaymentByOperationId(operationId, customerId);
    if (!payment) return null;
    return paymentConfirmationResult(payment, { idempotent: true });
  },
  getPaymentStatus(id) {
    const payment = db.prepare(`
      SELECT p.*,c.balance AS customer_balance,c.credit_due AS customer_credit_due
      FROM payments p
      JOIN customers c ON c.id=p.customer_id
      WHERE p.id=?
    `).get(Number(id));
    if (!payment) return null;
    return {
      id: Number(payment.id),
      customerId: Number(payment.customer_id),
      status: String(payment.status || 'active').toLowerCase(),
      amount: Number(payment.amount || 0),
      restoredBalance: Number(payment.customer_balance || 0),
      restoredDue: payment.customer_credit_due || null,
      documentNumber: payment.document_number_fmt || '',
      allocations: hydratePaymentAllocations(payment).allocations || [],
    };
  },
  cancelPayment({
    id, reason, userId = null, userName = '', sessionId = null
  }) {
    id = Number(id);
    reason = String(reason || '').replace(/\s+/g, ' ').trim();
    if (!id) throw new Error('Abono no válido');
    if (reason.length < 5) throw new Error('Escribe un motivo de anulación de al menos 5 caracteres');

    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    if (!payment) throw new Error('Abono no encontrado');
    if (String(payment.status || 'active').toLowerCase() === 'cancelled') {
      throw new Error('Este abono ya fue anulado');
    }
    if (
      String(payment.import_source || '').trim() ||
      String(payment.cajero || '').trim() === 'Importación histórica'
    ) {
      throw new Error(
        'Los abonos importados forman parte del saldo histórico y no pueden anularse desde Ventas'
      );
    }
    if (String(payment.note || '').trim() === 'Saldo inicial importado') {
      throw new Error('El saldo inicial importado no es un abono anulable');
    }

    const customer = db.prepare(
      'SELECT id,balance,credit_due,credit_days FROM customers WHERE id=?'
    ).get(payment.customer_id);
    if (!customer) throw new Error('El cliente del abono ya no existe');

    const allocations = tableExists('payment_allocations')
      ? db.prepare('SELECT * FROM payment_allocations WHERE payment_id=? ORDER BY id').all(id)
      : [];
    const relatedSaleIds = [...new Set([
      ...allocations.map(row => Number(row.sale_id)),
      ...(payment.sale_id ? [Number(payment.sale_id)] : []),
    ].filter(Boolean))];
    if (relatedSaleIds.length) {
      const placeholders = relatedSaleIds.map(() => '?').join(',');
      const cancelledInvoice = db.prepare(`
        SELECT id,document_number_fmt,numero_factura_fmt
        FROM sales
        WHERE id IN (${placeholders}) AND status='cancelled'
        LIMIT 1
      `).get(...relatedSaleIds);
      if (cancelledInvoice) {
        throw new Error(
          'Una factura vinculada ya está anulada. Revisa esa factura antes de reversar el abono'
        );
      }
    }

    const method = String(payment.method || 'efectivo').trim().toLowerCase();
    const originalCashParts = method === 'mixto' ? db.prepare(`
      SELECT method,SUM(amount) amount
      FROM cash_movements
      WHERE payment_id=? AND type='abono'
      GROUP BY method
      ORDER BY method
    `).all(id) : [];
    const requiresCashTrace = !['credito', 'descuento'].includes(method);
    let reversalSession = null;
    if (requiresCashTrace) {
      reversalSession = sessionId
        ? db.prepare("SELECT id,status FROM cash_sessions WHERE id=?").get(Number(sessionId))
        : null;
      if (!reversalSession || reversalSession.status !== 'open') {
        throw new Error(
          'Abre la caja antes de anular este abono; la devolución debe quedar registrada en la sesión actual'
        );
      }
    }

    const currentBalance = round2(Number(customer.balance || 0));
    let restoredBalance = round2(currentBalance + Number(payment.amount || 0));
    let reconciledFromDocuments = false;
    let restoredDue = customer.credit_due || null;
    if (!restoredDue && relatedSaleIds.length) {
      const placeholders = relatedSaleIds.map(() => '?').join(',');
      const oldest = db.prepare(`
        SELECT COALESCE(s.sale_date,date(s.created_at)) AS sale_date
        FROM sales s
        WHERE s.id IN (${placeholders})
        ORDER BY COALESCE(s.sale_date,date(s.created_at)),s.id
        LIMIT 1
      `).get(...relatedSaleIds);
      if (oldest?.sale_date) {
        restoredDue = db.prepare(
          "SELECT date(?, '+' || ? || ' days') AS due"
        ).get(
          oldest.sale_date,
          Math.max(1, Number(customer.credit_days) || 30)
        )?.due;
      }
    }
    if (!restoredDue) restoredDue = todayStr();

    const cancelTx = db.transaction(() => {
      const changed = db.prepare(`
        UPDATE payments
        SET status='cancelled',
            voided_at=datetime('now','localtime'),
            void_reason=?,
            voided_by=?,
            voided_by_name=?,
            void_cash_session_id=?
        WHERE id=? AND COALESCE(status,'active')!='cancelled'
      `).run(
        reason, userId || null, String(userName || '').trim(),
        reversalSession?.id || null, id
      );
      if (!changed.changes) throw new Error('Este abono ya fue anulado');

      // El correlativo nunca se reutiliza, pero su ciclo de vida sí debe reflejar
      // la realidad. Así Auditoría distingue un ABO vigente de uno anulado.
      db.prepare(`
        UPDATE document_issues
        SET status='cancelled'
        WHERE kind='abono' AND source_type='payment' AND source_id=?
      `).run(String(id));

      // Invalidar cualquier trabajo anterior: conservarlo en la bitácora no
      // significa que pueda reimprimirse luego como un recibo vigente.
      if (tableExists('print_jobs')) {
        db.prepare(`
          UPDATE print_jobs
          SET invalidated_at=datetime('now','localtime'),
              invalidation_reason=?
          WHERE type IN ('abono','payment','ticket')
            AND reference_id=?
            AND invalidated_at IS NULL
        `).run(`Abono anulado: ${reason}`.slice(0, 500), id);
      }

      // Bancos y Cuentas forma parte de la misma transacción del abono. Si el
      // cobro entró a una cuenta, la anulación retira exactamente ese movimiento.
      if (payment.financial_account_id && tableExists('financial_movements')) {
        const financialMovement = db.prepare(`
          SELECT id FROM financial_movements
          WHERE reference_type='payment' AND reference_id=?
            AND type='abono_recibido' AND status='activo'
          ORDER BY id DESC LIMIT 1
        `).get(id);
        if (financialMovement) {
          financialAccountsRepo.cancelMovement(
            financialMovement.id, userId || null, `Abono anulado: ${reason}`
          );
        }
      }

      // Contabilidad también se revierte antes de confirmar la transacción. Un
      // fallo aquí revierte deuda, caja, banco y documento: nunca queda media
      // anulación aplicada.
      if (tableExists('accounting_entries')) {
        const accountingEntry = db.prepare(`
          SELECT id FROM accounting_entries
          WHERE source_module='abono' AND source_id=? AND status='confirmado'
          ORDER BY id DESC LIMIT 1
        `).get(id);
        if (accountingEntry) {
          accountingRepo.reverseEntry(
            accountingEntry.id, userId || null, `Abono anulado: ${reason}`,
            { allowSystem: true }
          );
        }
      }

      // Si el acumulado del cliente llegó desfasado desde otra terminal, sumar
      // el monto a ciegas infla la deuda. Cuando toda la CxC está vinculada a
      // facturas, la fuente segura son los documentos vigentes y sus abonos
      // activos (el recibo ya está marcado como anulado en este punto).
      const receivableProjection = getPendingInvoices(db, payment.customer_id);
      if (receivableProjection.fullyReconcilable) {
        restoredBalance = round2(Number(receivableProjection.capacityTotal || 0));
        reconciledFromDocuments = true;
      }

      db.prepare(`
        UPDATE customers
        SET balance=?,credit_due=?,updated_at=datetime('now','localtime')
        WHERE id=?
      `).run(restoredBalance, restoredDue, payment.customer_id);

      if (requiresCashTrace) {
        const insertCashReversal = db.prepare(`
          INSERT INTO cash_movements(
            cash_session_id,type,amount,method,reference_id,payment_id,description,user_id
          ) VALUES(?,?,?,?,?,?,?,?)
        `);
        const parts = method === 'mixto' && originalCashParts.length
          ? originalCashParts
          : [{ method: method || 'efectivo', amount: Number(payment.amount || 0) }];
        parts.forEach(part => insertCashReversal.run(
          reversalSession.id, 'salida', Number(part.amount || 0),
          String(part.method || 'efectivo'), id, id,
          `Anulación de abono ${payment.document_number_fmt || payment.numero_recibo || '#' + id}: ${reason}`,
          userId || null
        ));
      }

      return {
        paymentId: id,
        customerId: Number(payment.customer_id),
        amount: Number(payment.amount || 0),
        method,
        previousBalance: currentBalance,
        restoredBalance,
        restoredDue,
        reconciledFromDocuments,
        cashSessionId: reversalSession?.id || null,
        documentNumber: payment.document_number_fmt || payment.numero_recibo || '',
        financialAccountId: payment.financial_account_id || null,
        allocations: allocations.map(row => ({
          sale_id: Number(row.sale_id),
          amount: Number(row.amount || 0),
        })),
      };
    });
    return cancelTx();
  },
  getPayments(customerId, { includeCancelled = false } = {}) {
    // LEFT JOIN a sales para que la referencia de factura en el historial de
    // abonos muestre el número real (numero_factura_fmt), no el id interno.
    // Alias con prefijo sale_ para no colisionar con columnas de payments.
    return db.prepare(`
      SELECT p.*,
             s.document_number_fmt AS sale_document_number_fmt,
             s.numero_factura     AS sale_numero_factura,
             s.numero_factura_fmt AS sale_numero_factura_fmt,
             s.ncf                AS sale_ncf,
             s.status             AS sale_status,
             s.correction_kind    AS sale_correction_kind,
             s.original_sale_id   AS sale_original_sale_id,
             s.sale_date          AS sale_date,
             s.total              AS sale_total
      FROM payments p
      LEFT JOIN sales s ON s.id = p.sale_id
      WHERE p.customer_id=?
        ${includeCancelled ? '' : "AND COALESCE(p.status,'active')='active'"}
      ORDER BY p.created_at DESC
    `).all(customerId).map(hydratePaymentAllocations);
  },
  getAllPayments({ includeCancelled = false } = {}) {
    return db.prepare(`
      SELECT p.*,
             c.name AS customer_name,c.rnc AS customer_rnc,c.phone AS customer_phone,
             s.document_number_fmt AS sale_document_number_fmt,
             s.numero_factura AS sale_numero_factura,
             s.numero_factura_fmt AS sale_numero_factura_fmt,
             s.ncf AS sale_ncf,
             s.status AS sale_status,
             s.correction_kind AS sale_correction_kind,
             s.original_sale_id AS sale_original_sale_id,
             s.sale_date AS sale_date,
             s.total AS sale_total
      FROM payments p
      LEFT JOIN customers c ON c.id=p.customer_id
      LEFT JOIN sales s ON s.id=p.sale_id
      ${includeCancelled ? '' : "WHERE COALESCE(p.status,'active')='active'"}
      ORDER BY p.created_at DESC,p.id DESC
    `).all().map(hydratePaymentAllocations);
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

    const canonical = this.getSessionCashSummary(sessionId);
    expected = canonical?.expected ?? Number(expected || 0);
    const diff = round2(closeAmount - expected);
    db.prepare(`
      UPDATE cash_sessions SET
        close_date=?, close_time=?, close_amount=?, close_bills=?,
        expected=?, difference=?, notes=?, status='closed'
      WHERE id=? AND status='open'
    `).run(todayStr(), nowStr(), closeAmount, JSON.stringify(closeBills || {}),
           expected, diff, notes || '', sessionId);
    audit(userId, cajero, 'cierre_caja', 'cash_sessions', sessionId,
          `Contado: ${closeAmount} | Esperado: ${expected} | Diferencia: ${diff}`);
    return { diff, expected, summary: canonical };
  },
  closePending({ sessionId, confirmation, userId, cajero }) {
    if (confirmation !== 'CASH_ALREADY_CLOSED') {
      throw new Error('Debes confirmar que la caja física ya fue cerrada');
    }
    const session = db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(Number(sessionId));
    if (!session) throw new Error('Sesión de caja no encontrada');
    if (session.status !== 'open') throw new Error('La sesión pendiente ya no está abierta');
    const summary = this.getSessionCashSummary(session.id);
    const expected = round2(Number(summary?.expected ?? session.open_amount ?? 0));
    const result = this.close({
      sessionId: session.id,
      closeAmount: expected,
      closeBills: {},
      expected,
      notes: 'Cierre técnico confirmado por administrador: la caja física ya estaba cerrada',
      userId,
      cajero,
    });
    audit(userId, cajero, 'caja_pendiente_conciliada', 'cash_sessions', session.id,
      `Sesión de ${session.cajero || 'cajero'} marcada cerrada tras confirmación administrativa | Esperado: ${expected}`);
    return { ...result, repaired: true, sessionId: session.id };
  },
  addMovement({
    sessionId, type, amount, method, referenceId, paymentId = null,
    description, userId
  }) {
    db.prepare(`
      INSERT INTO cash_movements(
        cash_session_id,type,amount,method,reference_id,payment_id,description,user_id
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(
      sessionId, type, amount, method || 'efectivo', referenceId,
      paymentId || null, description || '', userId
    );
  },
  getSessions(limit = 30) {
    return db.prepare(`
      SELECT cs.*, u.name as user_name,
        ROUND(COALESCE((
          SELECT SUM(s.total)
          FROM sales s
          WHERE s.cash_session_id=cs.id
            AND s.type='factura'
            AND COALESCE(s.status,'completed')!='cancelled'
        ),0),2) AS live_sales_total,
        COALESCE((
          SELECT COUNT(*)
          FROM sales s
          WHERE s.cash_session_id=cs.id
            AND s.type='factura'
            AND COALESCE(s.status,'completed')!='cancelled'
        ),0) AS live_sales_count
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
    const byMethodNet = {};        // movimiento neto por método

    for (const m of movements) {
      const method = (m.method || 'efectivo').toLowerCase();
      const amt = m.amount || 0;

      // Una venta o devolución anulada deja su movimiento original por trazabilidad,
      // pero ya no debe afectar el efectivo esperado de la caja.
      if ((m.type === 'venta' || m.type === 'devolucion') &&
          m.reference_id && cancelledSet.has(m.reference_id)) {
        continue;
      }

      // Movimiento neto por método. Así un abono y su anulación dentro de la
      // misma sesión dejan exactamente cero también en el resumen visual.
      if (m.type === 'venta' || m.type === 'abono') {
        byMethodNet[method] = (byMethodNet[method] || 0) + amt;
      } else if (m.type === 'entrada') {
        byMethodNet[method] = (byMethodNet[method] || 0) + amt;
      } else if (m.type === 'salida') {
        byMethodNet[method] = (byMethodNet[method] || 0) - amt;
      } else if (m.type === 'devolucion') {
        byMethodNet[method] = (byMethodNet[method] || 0) + amt;
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
      // Alias para terminales que todavía consulten el nombre anterior.
      byMethodIn: byMethodNet,
      byMethodNet,
      movementCount: movements.length,
    };
  },
  getSessionReport(sessionId) {
    const session = db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(sessionId);
    if (!session) return null;
    const sales = this.getSessionSales(sessionId);
    const payments = db.prepare(`
      SELECT p.*,c.name customer_name,c.rnc customer_rnc
      FROM payments p
      LEFT JOIN customers c ON c.id=p.customer_id
      WHERE p.cash_session_id=?
        AND COALESCE(p.status,'active')='active'
        AND COALESCE(p.import_source,'')=''
      ORDER BY p.created_at,p.id
    `).all(sessionId).map(hydratePaymentAllocations);
    const movements = db.prepare(`
      SELECT * FROM cash_movements
      WHERE cash_session_id=?
      ORDER BY created_at,id
    `).all(sessionId);
    const summary = this.getSessionCashSummary(sessionId);
    const invoices = sales.filter(sale => sale.type === 'factura');
    const returns = sales.filter(sale => sale.type === 'devolucion');
    const bySaleMethod = {};
    invoices.forEach(sale => {
      const method = String(sale.payment_method || 'efectivo').toLowerCase();
      bySaleMethod[method] = round2((bySaleMethod[method] || 0) + Number(sale.total || 0));
    });
    return {
      session,
      sales,
      payments,
      movements,
      summary,
      totals: {
        sales: round2(invoices.reduce((sum, sale) => sum + Number(sale.total || 0), 0)),
        returns: round2(returns.reduce((sum, sale) => sum + Number(sale.total || 0), 0)),
        payments: round2(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
        salesCount: invoices.length,
        returnCount: returns.length,
        paymentCount: payments.length,
        bySaleMethod,
      },
    };
  },
};

function saleOperationFingerprint({ customer, items, payment, type }) {
  const canonical = {
    type: String(type || 'factura'),
    customer: {
      id: Number(customer?.id) || 1,
      contactId: Number(customer?.contact_id ?? customer?.contact?.id) || null,
      branchId: Number(customer?.branch_id ?? customer?.branch?.id) || null,
      name: String(customer?.name || '').replace(/\s+/g, ' ').trim(),
      rnc: String(customer?.rnc || '').replace(/\D/g, ''),
    },
    items: (items || []).map(item => ({
      productId: Number(item.product_id),
      sourceConduceItemId: Number(item.sourceConduceItemId ?? item.source_conduce_item_id) || null,
      qty: Number(item.qty),
      unitPrice: round2(Number(item.unit_price)),
      taxable: item.taxable === 0 || item.taxable === false || item.taxable === '0' ? 0 : 1,
      taxPct: round2(Number(item.tax_pct) || 0),
    })),
    payment: {
      method: String(payment?.method || 'efectivo').toLowerCase(),
      disc: round2(Number(payment?.disc) || 0),
      priceMode: String(payment?.priceMode || 'retail'),
      mixEfec: round2(Number(payment?.mixEfec) || 0),
      mixCard: round2(Number(payment?.mixCard) || 0),
      financialAccountId: Number(payment?.financialAccountId) || null,
      exchangeRate: round2(Number(payment?.exchangeRate) || 1),
      cardBrand: String(payment?.cardBrand || '').trim().toLowerCase(),
      cardLast4: String(payment?.cardLast4 || '').replace(/\D/g, '').slice(-4),
      reference: String(payment?.reference || '').replace(/\s+/g, ' ').trim(),
      salespersonId: Number(payment?.salespersonId) || null,
      initialPaymentAmount: round2(Number(payment?.initialPaymentAmount) || 0),
      initialPaymentMethod: String(payment?.initialPaymentMethod || 'efectivo').toLowerCase(),
      initialPaymentMixCash: round2(Number(payment?.initialPaymentMixCash) || 0),
      initialPaymentMixNoncash: round2(Number(payment?.initialPaymentMixNoncash) || 0),
      initialPaymentNoncashMethod: String(payment?.initialPaymentNoncashMethod || 'transferencia').toLowerCase(),
      initialPaymentFinancialAccountId: Number(payment?.initialPaymentFinancialAccountId) || null,
      initialPaymentExchangeRate: round2(Number(payment?.initialPaymentExchangeRate) || 1),
      initialPaymentReference: String(payment?.initialPaymentReference || '').replace(/\s+/g, ' ').trim(),
      prepaidServiceOrderId: Number(payment?.prepaidServiceOrderId) || null,
      replacesSaleId: Number(payment?.replacesSaleId) || null,
      sourceQuoteId: Number(payment?.sourceQuoteId) || null,
      sourceConduceId: Number(payment?.sourceConduceId) || null,
      saleDate: String(payment?.saleDate || '').trim(),
      notes: String(payment?.notes || '').replace(/\s+/g, ' ').trim(),
      displayCurrency: String(payment?.displayCurrency || 'DOP').toUpperCase(),
      displayExchangeRate: round2(Number(payment?.displayExchangeRate) || 1),
      charges: (payment?.charges || []).map(row => ({
        description: String(row?.description || '').replace(/\s+/g, ' ').trim(),
        amount: round2(Number(row?.amount) || 0),
      })),
      warrantyDays: Math.max(0, Number.parseInt(payment?.warrantyDays, 10) || 0),
      tradeIn: payment?.tradeIn ? {
        productId: Number(payment.tradeIn.productId) || null,
        imei: String(payment.tradeIn.imei || '').trim().toUpperCase(),
        serial: String(payment.tradeIn.serial || '').trim().toUpperCase(),
        allowance: round2(Number(payment.tradeIn.allowance) || 0),
        color: String(payment.tradeIn.color || '').trim(),
        capacity: String(payment.tradeIn.capacity || '').trim(),
        sellerName: String(payment.tradeIn.sellerName || '').replace(/\s+/g, ' ').trim(),
        sellerDocument: String(payment.tradeIn.sellerDocument || '').trim(),
        sellerPhone: String(payment.tradeIn.sellerPhone || '').trim(),
        sellerPhoneType: String(payment.tradeIn.sellerPhoneType || 'telefono').trim(),
        sellerAddress: String(payment.tradeIn.sellerAddress || '').replace(/\s+/g, ' ').trim(),
        sellerEmail: String(payment.tradeIn.sellerEmail || '').trim().toLowerCase(),
        ownershipDeclared: payment.tradeIn.ownershipDeclared ? 1 : 0,
        lawfulOriginDeclared: payment.tradeIn.lawfulOriginDeclared ? 1 : 0,
      } : null,
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function saleConfirmationResult(sale, { idempotent = false } = {}) {
  if (!sale) return null;
  const initialPayment = db.prepare(`
    SELECT id,amount,method
    FROM payments
    WHERE sale_id=? AND note='Pago inicial de factura a crédito'
      AND COALESCE(status,'active')='active'
    ORDER BY id LIMIT 1
  `).get(sale.id);
  const initialMovements = initialPayment ? db.prepare(`
    SELECT method,amount
    FROM cash_movements
    WHERE payment_id=? AND type='abono'
    ORDER BY id
  `).all(initialPayment.id) : [];
  const initialPaymentMixCash = round2(initialMovements
    .filter(row => String(row.method || '').toLowerCase() === 'efectivo')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const initialPaymentMixNoncash = round2(initialMovements
    .filter(row => String(row.method || '').toLowerCase() !== 'efectivo')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const convertedConduce = tableExists('delivery_note_invoice_links')
    ? db.prepare(`
        SELECT dn.id,dn.number
        FROM delivery_note_invoice_links l
        JOIN delivery_notes dn ON dn.id=l.delivery_note_id
        WHERE l.invoice_id=?
        ORDER BY l.id LIMIT 1
      `).get(sale.id)
    : null;
  return {
    saleId: Number(sale.id),
    total: Number(sale.total || 0),
    subtotal: Number(sale.subtotal || 0),
    taxAmt: Number(sale.tax_amt || 0),
    discAmt: Number(sale.discount_amt || 0),
    taxPct: Number(sale.tax_pct || 0),
    ncf: sale.ncf || '',
    documentKind: sale.document_kind || '',
    documentNumber: sale.document_number,
    documentNumberFmt: sale.document_number_fmt || '',
    receiptDocumentNumber: sale.receipt_document_number,
    receiptDocumentNumberFmt: sale.receipt_document_number_fmt || '',
    financialAccountId: sale.financial_account_id || null,
    paymentCurrency: sale.payment_currency || 'DOP',
    exchangeRate: Number(sale.exchange_rate || 1),
    accountAmount: Number(sale.account_amount || 0),
    salespersonId: sale.salesperson_id || null,
    additionalChargesTotal: Number(sale.additional_charges_total || 0),
    displayCurrency: sale.display_currency || 'DOP',
    displayExchangeRate: Number(sale.display_exchange_rate || 1),
    displayAmount: Number(sale.display_amount || 0),
    cardBrand: sale.card_brand || '',
    cardLast4: sale.card_last4 || '',
    paymentReference: sale.payment_reference || '',
    initialPaymentId: initialPayment?.id || null,
    initialPaymentAmount: Number(initialPayment?.amount || 0),
    initialPaymentMethod: initialPayment?.method || '',
    initialPaymentMixCash,
    initialPaymentMixNoncash,
    initialPaymentNoncashMethod: initialMovements.find(
      row => String(row.method || '').toLowerCase() !== 'efectivo'
    )?.method || '',
    outstandingBalance: sale.payment_method === 'credito'
      ? Math.max(0, round2(Number(sale.total || 0) - Number(sale.trade_in_amount || 0) - Number(initialPayment?.amount || 0)))
      : 0,
    tradeInAmount: Number(sale.trade_in_amount || 0),
    prepaidAmount: Number(sale.prepaid_amount || 0),
    prepaidReference: sale.prepaid_reference || '',
    tradeInUnitId: sale.trade_in_unit_id || null,
    replacesSaleId: sale.replaces_sale_id || null,
    convertedConduceId: convertedConduce?.id || null,
    convertedConduceNumber: convertedConduce?.number || '',
    reusedDocumentNumber: !!sale.replaces_sale_id,
    operationId: sale.operation_id || '',
    idempotent,
  };
}

function findConfirmedSaleOperation({ operationId = '', customer, items, payment, type = 'factura' }) {
  operationId = normalizeOperationId(operationId);
  if (!operationId) return null;
  const previous = db.prepare('SELECT * FROM sales WHERE operation_id=?').get(operationId);
  if (!previous) return null;
  if (String(previous.status || 'completed') === 'cancelled') {
    throw new Error('Esta confirmación corresponde a una venta que ya fue anulada');
  }
  const fingerprint = saleOperationFingerprint({ customer, items, payment, type });
  if (previous.operation_fingerprint !== fingerprint) {
    throw new Error('La operación ya fue confirmada con otros datos; actualiza Ventas antes de continuar');
  }
  return saleConfirmationResult(previous, { idempotent: true });
}

// ── Ventas ────────────────────────────────────
const salesRepo = {
  getConfirmationById(id, { idempotent = true } = {}) {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(Number(id));
    return sale ? saleConfirmationResult(sale, { idempotent }) : null;
  },
  getConfirmedOperation({ operationId = '', customer, items, payment, type = 'factura' }) {
    return findConfirmedSaleOperation({ operationId, customer, items, payment, type });
  },
  // Transacción completa de venta
  create({
    session, customer, items, payment, user, type = 'factura',
    trustedCustomerSnapshot = false, operationId = ''
  }) {
    operationId = normalizeOperationId(operationId);
    const operationFingerprint = operationId
      ? saleOperationFingerprint({ customer, items, payment, type }) : '';
    const createSaleTx = db.transaction(() => {
      if (operationId) {
        const confirmed = findConfirmedSaleOperation({
          operationId, customer, items, payment, type,
        });
        if (confirmed) return confirmed;
      }
      if (!['factura', 'cotizacion'].includes(type)) {
        throw new Error('Tipo de documento de venta no soportado');
      }
      payment = { ...(payment || {}) };
      // Una cotización es un documento comercial: no cobra, no crea CxC, no
      // utiliza una cuenta financiera y no depende del estado de la caja.
      if (type === 'cotizacion') payment.method = 'cotizacion';

      // Una conversión enviada al POS conserva la cotización hasta confirmar
      // el cobro. Al llegar aquí se valida y se eliminará dentro de ESTA misma
      // transacción, evitando una factura creada con la cotización aún activa.
      const sourceQuoteId = type === 'factura'
        ? (Number(payment.sourceQuoteId) || null)
        : null;
      const sourceQuote = sourceQuoteId
        ? db.prepare('SELECT * FROM sales WHERE id=?').get(sourceQuoteId)
        : null;
      if (sourceQuoteId && (!sourceQuote || sourceQuote.type !== 'cotizacion')) {
        throw new Error('La cotización de origen ya no está disponible');
      }
      const sourceConduceId = type === 'factura'
        ? (Number(payment.sourceConduceId) || null)
        : null;
      const sourceConduce = sourceConduceId
        ? db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(sourceConduceId)
        : null;
      if (sourceConduceId && (!sourceConduce || !['despachado', 'entregado', 'parcial', 'facturado'].includes(sourceConduce.status))) {
        throw new Error('El conduce de origen ya no está disponible para convertirlo en venta');
      }
      if (sourceConduce && tableExists('delivery_note_charges')) {
        // El servidor es la autoridad: los cargos pendientes viajan una sola
        // vez, aunque el renderer sea recargado o la venta sea parcial.
        payment.charges = db.prepare(`
          SELECT description,amount FROM delivery_note_charges
          WHERE delivery_note_id=? AND invoice_id IS NULL ORDER BY id
        `).all(sourceConduceId);
      }

      // Para clientes registrados, la base de datos es la autoridad. El renderer
      // solo elige la cuenta y, opcionalmente, uno de sus representantes.
      const requestedCustomer = customer || {};
      const requestedCustomerId = Number(requestedCustomer.id) || 1;
      let selectedContact = null;
      let selectedBranch = null;
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
        // Sucursal de entrega (Fase 2): ubicación bajo la misma empresa/RNC.
        const branchId = Number(requestedCustomer.branch_id || requestedCustomer.branch?.id) || null;
        if (branchId) {
          const storedBranch = db.prepare(`SELECT * FROM customer_branches WHERE id=? AND customer_id=?`).get(branchId, account.id);
          if (!storedBranch) throw new Error('La sucursal no pertenece a la empresa seleccionada');
          if (trustedCustomerSnapshot && requestedCustomer.preserve_branch_snapshot) {
            selectedBranch = {
              ...storedBranch,
              name: requestedCustomer.branch?.name || storedBranch.name,
              code: requestedCustomer.branch?.code || storedBranch.code,
              address: requestedCustomer.branch?.address || storedBranch.address,
              phone: requestedCustomer.branch?.phone || storedBranch.phone,
            };
          } else {
            if (account.customer_type !== 'company') throw new Error('Solo una empresa puede tener sucursales');
            if (storedBranch.active !== 1) throw new Error('La sucursal seleccionada está inactiva');
            selectedBranch = storedBranch;
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
        if (!productId) continue;
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
      const usedUnits = new Set();   // unidades serializadas ya tomadas en esta venta

      // 1. Validar stock y normalizar snapshot de línea. unit_price es precio final.
      for (const item of items) {
        const nonStockService = item.kind === 'service' || item.non_stock === true;
        const storedProd = item.product_id
          ? db.prepare('SELECT id,stock,name,taxable,tax_pct,COALESCE(serialized,0) AS serialized FROM products WHERE id=?').get(item.product_id)
          : null;
        if (!storedProd && !nonStockService) throw new Error(`Producto ID ${item.product_id} no existe`);
        const prod = storedProd || {
          id: null, stock: 0, name: item.product_name || 'Servicio técnico',
          taxable: item.taxable == null ? 1 : item.taxable,
          tax_pct: item.tax_pct == null ? configuredTaxPct() : item.tax_pct,
          serialized: 0,
        };
        const productId = Number(item.product_id);
        // Producto SERIALIZADO (VELO TECH POS): se vende una UNIDAD concreta por
        // IMEI/serial; el stock sale de product_units, no del campo numérico. Para
        // productos fungibles (auto-repuestos, serialized=0) nada de esto corre y
        // la validación numérica de abajo es idéntica a la actual.
        let _unitId = null;
        if (afectaStock && !nonStockService && prod.serialized) {
          const ref = String(item.imei ?? item.serial ?? '').trim();
          let unit = null;
          if (item.product_unit_id) {
            unit = db.prepare('SELECT * FROM product_units WHERE id=? AND product_id=?').get(Number(item.product_unit_id), productId);
          } else if (ref) {   // solo con referencia NO vacía (un IMEI/serial en blanco no debe hacer match)
            unit = db.prepare("SELECT * FROM product_units WHERE product_id=? AND (UPPER(TRIM(COALESCE(imei,'')))=UPPER(?) OR UPPER(TRIM(COALESCE(serial,'')))=UPPER(?)) LIMIT 1").get(productId, ref, ref);
          }
          if (!unit) throw new Error(`Selecciona el equipo (IMEI) a vender para "${prod.name}"`);
          if (unit.status !== 'en_stock') throw new Error(`El equipo ${unit.imei || unit.serial || ('#' + unit.id)} ya no está disponible`);
          if (usedUnits.has(unit.id)) throw new Error(`El equipo ${unit.imei || unit.serial || ('#' + unit.id)} está repetido en la venta`);
          usedUnits.add(unit.id);
          _unitId = unit.id;
          if (unit.unit_cost != null) item.unit_cost = unit.unit_cost; // costo real de la unidad → asiento correcto
          if (String(unit.sale_description || '').trim()) {
            item.product_name = `${prod.name} — ${String(unit.sale_description).trim()}`.slice(0, 1000);
          }
          item.qty = 1;                                                // cada unidad serializada es una línea de 1
        } else if (afectaStock && !nonStockService && !stockValidated.has(productId)) {
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
          const ownServiceOrderId = Number(item.service_order_id) || 0;
          const serviceReserved = tableExists('service_order_items')
            ? (db.prepare(`
                SELECT COALESCE(SUM(qty_reserved),0) AS qty
                FROM service_order_items
                WHERE product_id=? AND reservation_status='reserved' AND service_order_id<>?
              `).get(productId, ownServiceOrderId).qty || 0)
            : 0;
          const available = Number(prod.stock) - Number(reserved) - Number(serviceReserved);
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
          _serialized: !!prod.serialized,
          _nonStock: nonStockService,
          product_unit_id: _unitId,
        });
      }

      let sourceConduceLines = [];
      if (sourceConduce) {
        const availableById = new Map(
          conduceRepo.invoiceableLines(sourceConduceId).map(line => [Number(line.id), line])
        );
        const usedSourceLines = new Set();
        sourceConduceLines = saleItems.flatMap(item => {
          const itemId = Number(item.sourceConduceItemId ?? item.source_conduce_item_id) || null;
          if (!itemId) return [];
          if (usedSourceLines.has(itemId)) throw new Error('Una línea del conduce está repetida en la venta');
          usedSourceLines.add(itemId);
          const sourceLine = availableById.get(itemId);
          if (!sourceLine || sourceLine.invoiceable <= 0) {
            throw new Error('Una línea del conduce ya fue facturada o dejó de estar disponible');
          }
          if (Number(sourceLine.product_id) !== Number(item.product_id)) {
            throw new Error(`El producto de "${sourceLine.description}" no coincide con el conduce`);
          }
          if (Number(item.qty) > Number(sourceLine.invoiceable) + 1e-9) {
            throw new Error(`No puedes vender ${item.qty} de "${sourceLine.description}" — pendiente en el conduce: ${sourceLine.invoiceable}`);
          }
          return [{ sourceLine, item }];
        });
        if (!sourceConduceLines.length) {
          throw new Error('La venta debe conservar al menos una línea pendiente del conduce');
        }
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
      const additionalChargesTotal = ['factura', 'cotizacion'].includes(type)
        ? round2(charges.reduce((sum, row) => sum + row.amount, 0)) : 0;
      const subtotal = calculated.subtotal;
      const discAmt = calculated.discAmt;
      const taxAmt = calculated.taxAmt;
      const total = round2(calculated.total + additionalChargesTotal);
      const taxPct = headerTaxPct;

      // R7 · Equipo usado recibido como parte de pago. La factura conserva su
      // total comercial/fiscal completo; solo el saldo a cobrar se reduce. El
      // equipo entra a product_units con costo igual al valor reconocido.
      let tradeIn = null;
      let tradeInAmount = 0;
      if (type === 'factura' && payment.tradeIn) {
        const productId = Number(payment.tradeIn.productId) || 0;
        const product = db.prepare('SELECT id,name,COALESCE(serialized,0) serialized FROM products WHERE id=? AND active=1').get(productId);
        if (!product || !product.serialized) throw new Error('Selecciona un modelo serializado válido para el equipo usado');
        const imei = String(payment.tradeIn.imei || '').trim();
        const serial = String(payment.tradeIn.serial || '').trim();
        if (!imei && !serial) throw new Error('Ingresa el IMEI o serial del equipo usado');
        if (productUnitsRepo.findByImei(imei || serial)) throw new Error('Ese IMEI o serial ya está registrado');
        tradeInAmount = round2(Number(payment.tradeIn.allowance) || 0);
        if (tradeInAmount <= 0) throw new Error('El valor reconocido por el usado debe ser mayor a cero');
        if (tradeInAmount > total + 0.005) throw new Error('El valor del usado no puede superar el total de la venta');
        const oneTimeSeller = customer.id === 1;
        const sellerName = String(oneTimeSeller ? payment.tradeIn.sellerName : customer.name || '').replace(/\s+/g, ' ').trim();
        const sellerDocument = String(oneTimeSeller ? payment.tradeIn.sellerDocument : customer.rnc || '').trim();
        const sellerPhone = String(oneTimeSeller ? payment.tradeIn.sellerPhone : customer.phone || '').trim();
        const sellerPhoneType = ['telefono','celular','flota'].includes(String(payment.tradeIn.sellerPhoneType || '').toLowerCase())
          ? String(payment.tradeIn.sellerPhoneType).toLowerCase() : selectedCustomerPhoneType;
        const sellerAddress = String(oneTimeSeller ? payment.tradeIn.sellerAddress : customer.address || '').replace(/\s+/g, ' ').trim();
        const sellerEmail = String(oneTimeSeller ? payment.tradeIn.sellerEmail : customer.email || '').trim().toLowerCase();
        const ownershipDeclared = payment.tradeIn.ownershipDeclared ? 1 : 0;
        const lawfulOriginDeclared = payment.tradeIn.lawfulOriginDeclared ? 1 : 0;
        if (oneTimeSeller && !sellerName) throw new Error('Identifica a la persona que entrega el equipo usado');
        if (oneTimeSeller && sellerDocument.replace(/[^a-zA-Z0-9]/g, '').length < 5) {
          throw new Error('Indica una cédula, pasaporte o documento válido para quien entrega el usado');
        }
        if (oneTimeSeller && sellerPhone.replace(/\D/g, '').length < 7) {
          throw new Error('Indica un teléfono válido para quien entrega el usado');
        }
        if (oneTimeSeller && !sellerAddress) throw new Error('Indica la dirección de quien entrega el usado');
        if (!ownershipDeclared) throw new Error('La persona debe declarar que es propietaria legítima del equipo');
        if (!lawfulOriginDeclared) throw new Error('La persona debe declarar la procedencia lícita del equipo');
        tradeIn = {
          productId, imei, serial,
          color: String(payment.tradeIn.color || '').trim(),
          capacity: String(payment.tradeIn.capacity || '').trim(),
          notes: String(payment.tradeIn.notes || '').trim(),
          sellerName, sellerDocument, sellerPhone, sellerPhoneType,
          sellerAddress, sellerEmail, ownershipDeclared, lawfulOriginDeclared,
          customerId: oneTimeSeller ? null : customer.id,
        };
      }
      // Anticipos del taller: solo se aceptan desde una orden real y únicamente
      // por el total todavía activo en service_order_deposits. La factura conserva
      // su total fiscal; caja cobra solamente el restante.
      const prepaidServiceOrderId = type === 'factura'
        ? (Number(payment.prepaidServiceOrderId) || 0) : 0;
      let prepaidAmount = 0;
      let prepaidReference = '';
      if (prepaidServiceOrderId) {
        if (!tableExists('service_order_deposits')) throw new Error('Los anticipos de servicio no están disponibles');
        const depositSummary = db.prepare(`SELECT COALESCE(SUM(amount),0) amount,COUNT(*) count
          FROM service_order_deposits WHERE service_order_id=? AND status='active'`).get(prepaidServiceOrderId);
        prepaidAmount = round2(Number(depositSummary.amount) || 0);
        if (prepaidAmount > total + 0.005) throw new Error('Los anticipos activos superan el total de la reparación');
        prepaidReference = depositSummary.count
          ? `Anticipo(s) orden ${db.prepare('SELECT number FROM service_orders WHERE id=?').get(prepaidServiceOrderId)?.number || prepaidServiceOrderId}`
          : '';
      }
      const amountDue = round2(total - tradeInAmount - prepaidAmount);
      const initialPaymentAmount = type === 'factura' && payment.method === 'credito'
        ? round2(Number(payment.initialPaymentAmount) || 0)
        : 0;
      const initialPaymentMethod = String(payment.initialPaymentMethod || 'efectivo').toLowerCase();
      const initialPaymentMixCash = initialPaymentMethod === 'mixto'
        ? round2(Number(payment.initialPaymentMixCash) || 0) : 0;
      const initialPaymentMixNoncash = initialPaymentMethod === 'mixto'
        ? round2(Number(payment.initialPaymentMixNoncash) || 0) : 0;
      const initialPaymentNoncashMethod = initialPaymentMethod === 'mixto'
        ? String(payment.initialPaymentNoncashMethod || 'transferencia').toLowerCase()
        : initialPaymentMethod;
      if (initialPaymentAmount < 0 || initialPaymentAmount > amountDue + 0.01) {
        throw new Error('El pago inicial no puede ser negativo ni superar el total de la factura');
      }
      if (type === 'factura' && payment.method === 'credito') {
        if (customer.id === 1) {
          throw new Error('Selecciona un cliente registrado para realizar una venta a crédito');
        }
        if (initialPaymentAmount >= amountDue - 0.005) {
          throw new Error('Si el cliente paga el total, registra la venta como contado');
        }
        if (initialPaymentAmount > 0 && !session?.id) {
          throw new Error('Abre la caja antes de recibir el pago inicial');
        }
        if (!['efectivo','transferencia','tarjeta','cheque','mixto'].includes(initialPaymentMethod)) {
          throw new Error('Método de pago inicial no válido');
        }
        if (initialPaymentMethod === 'mixto' && initialPaymentAmount > 0) {
          if (!(initialPaymentMixCash > 0) || !(initialPaymentMixNoncash > 0)) {
            throw new Error('El pago inicial mixto requiere una parte en efectivo y otra no efectiva');
          }
          if (!['transferencia','tarjeta'].includes(initialPaymentNoncashMethod)) {
            throw new Error('Método no efectivo del pago inicial mixto no válido');
          }
          if (Math.abs(round2(initialPaymentMixCash + initialPaymentMixNoncash) - initialPaymentAmount) > 0.01) {
            throw new Error('La distribución del pago inicial mixto no coincide con su total');
          }
        }
      }

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
      let autoCreditLimitAssigned = 0;
      if (type === 'factura' && payment.method === 'credito') {
        const cust = db.prepare('SELECT balance,credit_limit,status FROM customers WHERE id=?').get(customer.id);
        if (!cust) throw new Error('Cliente no encontrado');
        if (cust.status === 'bloqueado') {
          throw new Error('Cliente bloqueado — no puede comprar a crédito');
        }
        if (cust.status === 'moroso') {
          throw new Error('Cliente marcado como moroso — no puede comprar a crédito');
        }
        const creditExposure = round2(amountDue - initialPaymentAmount);
        // Este es el monto que realmente quedará pendiente después del pago
        // inicial. Se valida aquí, dentro de la transacción y con el total
        // recalculado por SQLite, para cubrir POS directo y Preventa/Despacho.
        const creditUser = db.prepare(`
          SELECT id,role,active,can_sell_credit,credit_limit_per_sale,module_permissions
          FROM users WHERE id=?
        `).get(user?.id);
        if (!creditUser?.active) throw new Error('El usuario de caja ya no está activo');
        assertCreditPermission(creditUser, creditExposure);
        if (cust.credit_limit <= 0) {
          const requiredLimit = round2(Math.max(0, Number(cust.balance) || 0) + creditExposure);
          const cashierThreshold = Math.max(0,
            Number(settingsRepo.get('pos_cashier_auto_credit_limit_amount')) || 0
          );
          const isPrivileged = ['admin', 'superadmin'].includes(creditUser.role);
          const approvedBy = Number(payment.creditLimitApprovedBy) || null;
          const approvedMax = Math.max(0, Number(payment.creditLimitApprovedMaxAmount) || 0);
          if (!isPrivileged && requiredLimit > cashierThreshold + 0.005
              && (!approvedBy || requiredLimit > approvedMax + 0.005)) {
            throw new Error(
              `Asignar ${requiredLimit.toFixed(2)} de límite a este cliente supera el máximo automático del cajero (${cashierThreshold.toFixed(2)})`
            );
          }
          db.prepare(`
            UPDATE customers
            SET credit_limit=?,updated_at=datetime('now')
            WHERE id=? AND COALESCE(credit_limit,0)<=0
          `).run(requiredLimit, customer.id);
          cust.credit_limit = requiredLimit;
          autoCreditLimitAssigned = requiredLimit;
        }
        if (cust.balance + creditExposure > cust.credit_limit) {
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
          : (method === 'credito' ? 0 : amountDue));
      let exchangeRate = 1;
      let accountAmount = round2(baseAccountAmount);
      if (paymentCurrency === 'USD' && baseAccountAmount > 0) {
        exchangeRate = round2(Number.parseFloat(payment.exchangeRate) || 0);
        if (exchangeRate < 20 || exchangeRate > 500) {
          throw new Error('Indica una tasa USD válida para acreditar la cuenta en dólares');
        }
        accountAmount = round2(baseAccountAmount / exchangeRate);
      }

      let initialFinancialAccount = null;
      let initialPaymentCurrency = 'DOP';
      let initialExchangeRate = 1;
      let initialAccountAmount = 0;
      const initialBankMethod = initialPaymentMethod === 'mixto'
        ? initialPaymentNoncashMethod : initialPaymentMethod;
      const initialBankBaseAmount = initialPaymentMethod === 'mixto'
        ? initialPaymentMixNoncash : initialPaymentAmount;
      if (type === 'factura' && method === 'credito' && initialPaymentAmount > 0 &&
          ['transferencia', 'tarjeta', 'cheque', 'mixto'].includes(initialPaymentMethod)) {
        let initialAccountId = Number(payment.initialPaymentFinancialAccountId) ||
          Number(payment.financialAccountId) || null;
        if (!initialAccountId) {
          const preferredType = initialBankMethod === 'tarjeta' ? 'tarjeta' : 'banco';
          initialAccountId = db.prepare(`
            SELECT id FROM financial_accounts
            WHERE active=1 AND type=?
            ORDER BY CASE WHEN upper(COALESCE(currency,'DOP'))='DOP' THEN 0 ELSE 1 END, id
            LIMIT 1
          `).get(preferredType)?.id || null;
        }
        initialFinancialAccount = initialAccountId
          ? db.prepare('SELECT * FROM financial_accounts WHERE id=? AND active=1').get(initialAccountId)
          : null;
        if (!initialFinancialAccount) {
          throw new Error(
            `Selecciona una cuenta activa para recibir el pago inicial por ${initialBankMethod}`
          );
        }
        if (initialBankMethod !== 'tarjeta' && initialFinancialAccount.type !== 'banco') {
          throw new Error('Transferencias y cheques deben recibirse en una cuenta bancaria');
        }
        initialPaymentCurrency = String(initialFinancialAccount.currency || 'DOP').toUpperCase();
        initialExchangeRate = initialPaymentCurrency === 'USD'
          ? round2(Number(payment.initialPaymentExchangeRate) || 0) : 1;
        if (initialPaymentCurrency === 'USD' &&
            (initialExchangeRate < 20 || initialExchangeRate > 500)) {
          throw new Error('Indica una tasa USD válida para el pago inicial');
        }
        initialAccountAmount = initialPaymentCurrency === 'USD'
          ? round2(initialBankBaseAmount / initialExchangeRate)
          : initialBankBaseAmount;
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
          customer_branch_id,customer_branch_name,customer_branch_code,customer_branch_address,customer_branch_phone,
          type,status,subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,
          payment_method,price_mode,cajero,user_id,salesperson_id,financial_account_id,
          payment_currency,exchange_rate,account_amount,card_brand,card_last4,
          additional_charges_total,display_currency,display_exchange_rate,display_amount,
          print_template_id,print_printer_type,print_printer_name,print_profile_id,print_copies,print_action,
          payment_reference,notes,trade_in_amount,trade_in_unit_id,prepaid_amount,prepaid_reference,operation_id,operation_fingerprint,
          created_at,original_sale_date,sale_date,updated_at)
        VALUES(
          @cash_session_id,@customer_id,@customer_name,@customer_rnc,
          @customer_type,@customer_trade_name,@customer_address,@customer_phone,@customer_phone_type,@customer_email,
          @customer_contact_id,@customer_contact_name,@customer_contact_document,
          @customer_contact_role,@customer_contact_phone,@customer_contact_email,
          @customer_branch_id,@customer_branch_name,@customer_branch_code,@customer_branch_address,@customer_branch_phone,
          @type,'completed',@subtotal,@discount_pct,@discount_amt,@tax_pct,@tax_amt,@total,
          @payment_method,@price_mode,@cajero,@user_id,@salesperson_id,@financial_account_id,
          @payment_currency,@exchange_rate,@account_amount,@card_brand,@card_last4,
          @additional_charges_total,@display_currency,@display_exchange_rate,@display_amount,
          @print_template_id,@print_printer_type,@print_printer_name,@print_profile_id,@print_copies,@print_action,
          @payment_reference,@notes,@trade_in_amount,@trade_in_unit_id,@prepaid_amount,@prepaid_reference,@operation_id,@operation_fingerprint,
          @created_at,@original_sale_date,@sale_date,@created_at
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
        customer_branch_id: selectedBranch?.id || null,
        customer_branch_name: selectedBranch?.name || '',
        customer_branch_code: selectedBranch?.code || '',
        customer_branch_address: selectedBranch?.address || '',
        customer_branch_phone: selectedBranch?.phone || '',
        type, subtotal, discount_pct: discPct, discount_amt: discAmt, tax_pct: taxPct,
        tax_amt: taxAmt, total, payment_method: method,
        price_mode: payment.priceMode || 'retail', cajero: user.name || '', user_id: user.id,
        salesperson_id: salespersonId, financial_account_id: finAcctId,
        payment_currency: paymentCurrency, exchange_rate: exchangeRate, account_amount: accountAmount,
        additional_charges_total: additionalChargesTotal,
        display_currency: displayCurrency,
        display_exchange_rate: displayExchangeRate,
        display_amount: displayAmount,
        print_template_id: String(payment.printTemplateId || '').slice(0, 40),
        print_printer_type: String(payment.printPrinterType || '').slice(0, 20),
        print_printer_name: String(payment.printPrinterName || '').slice(0, 255),
        print_profile_id: String(payment.printProfileId || '').slice(0, 80),
        print_copies: Math.max(1, Math.min(9, parseInt(payment.printCopies, 10) || 1)),
        print_action: payment.printAction === 'none' ? 'none' : 'print',
        card_brand: cardBrand, card_last4: cardLast4, payment_reference: paymentReference,
        notes: String(payment.notes || '').trim().slice(0, 1000),
        trade_in_amount: tradeInAmount,
        trade_in_unit_id: null,
        prepaid_amount: prepaidAmount,
        prepaid_reference: prepaidReference,
        operation_id: operationId,
        operation_fingerprint: operationFingerprint,
        created_at: db.prepare("SELECT datetime('now','localtime') AS value").get().value,
        original_sale_date: requestedSaleDate || db.prepare("SELECT date('now','localtime') AS value").get().value,
        sale_date: requestedSaleDate || db.prepare("SELECT date('now','localtime') AS value").get().value,
      });
      const saleId = saleR.lastInsertRowid;
      if (charges.length) {
        const insertCharge = db.prepare(
          'INSERT INTO sale_charges(sale_id,description,amount) VALUES(?,?,?)'
        );
        charges.forEach(row => insertCharge.run(saleId, row.description, row.amount));
      }
      const replacesSaleId = type === 'factura'
        ? (Number(payment.replacesSaleId) || null)
        : null;
      const replacementSource = replacesSaleId
        ? db.prepare('SELECT document_kind FROM sales WHERE id=?').get(replacesSaleId)
        : null;
      const documentKind = replacementSource?.document_kind ||
        documentKindForSale(type, method);
      const documentIssue = replacesSaleId
        ? _reuseCancelledConsumerFinalNumber(
            replacesSaleId, saleId, documentKind, user.id
          )
        : _issueDocumentNumber(documentKind, 'sale', saleId);
      const receiptIssue = type === 'factura' && method !== 'credito'
        ? _issueDocumentNumber('recibo', 'sale_receipt', saleId)
        : null;
      db.prepare(`
        UPDATE sales
        SET document_kind=?,document_number=?,document_number_fmt=?,
            receipt_document_number=?,receipt_document_number_fmt=?,
            numero_factura=CASE WHEN ?='factura_historica' THEN ? ELSE numero_factura END,
            numero_factura_fmt=CASE WHEN ?='factura_historica' THEN ? ELSE numero_factura_fmt END
        WHERE id=?
      `).run(
        documentKind, documentIssue.sequence_number,
        documentIssue.formatted_number,
        receiptIssue?.sequence_number || null,
        receiptIssue?.formatted_number || '',
        documentKind, documentIssue.sequence_number,
        documentKind, documentIssue.formatted_number,
        saleId
      );

      // 4b. Generar NCF — SOLO facturas, con fiscal activo, tipo ELEGIDO en el cobro
      // y una secuencia registrada. El comprobante NUNCA se fabrica con un contador
      // interno: proviene exclusivamente de un rango autorizado por la DGII
      // (tabla ncf_sequences).
      //
      // El tipo lo elige el cajero en el POS (`payment.ncfType`). Por defecto la
      // venta sale SIN COMPROBANTE (ncfType vacío): la mayoría de las ventas de
      // mostrador no requieren comprobante fiscal. Solo cuando el cliente lo pide
      // se selecciona B01 (Crédito Fiscal), B02 (Consumo), etc. Si el tipo elegido
      // no tiene secuencia activa, la factura sale como documento interno SIN NCF
      // (nunca aparenta un comprobante inexistente).
      let ncf = '';
      const requestedNcfType = String(payment.ncfType || '').trim().toUpperCase();
      const ncfType = /^B(01|02|04|14|15|16|17)$/.test(requestedNcfType) ? requestedNcfType : '';
      if (type === 'factura' && ncfType) {
        const fiscalOn = db.prepare("SELECT value FROM settings WHERE key='fiscal_enabled'").get()?.value === '1';
        if (fiscalOn) {
          ensureNcfAvailableNumbersTable();
          const hasSequence = db.prepare(`
            SELECT 1 FROM ncf_sequences s
            WHERE s.type=? AND s.active=1
              AND (s.expiry_date IS NULL OR TRIM(s.expiry_date)='' OR date(s.expiry_date)>=date('now','localtime'))
              AND (s.current<s.to_num OR EXISTS(
                SELECT 1 FROM ncf_available_numbers a
                WHERE a.sequence_id=s.id AND a.status='available'
              ))
            LIMIT 1
          `).get(ncfType);
          if (hasSequence) {
            const allocation = allocateNextNcfNumber(ncfType, saleId);
            ncf = allocation.ncf;
            db.prepare("INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc) VALUES(?,?,?,?)")
              .run(ncf, ncfType, saleId, customer.rnc || '');
            if (allocation.remaining <= 50) {
              console.log('[NCF] ALERTA: quedan ' + allocation.remaining + ' comprobantes tipo ' + ncfType);
            }
            db.prepare(`
              UPDATE sales
              SET ncf=?,fiscal_issued_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
              WHERE id=?
            `).run(ncf, saleId);
          } else {
            // Sin secuencia registrada para este tipo → factura sin comprobante fiscal.
            console.warn('[NCF] Sin secuencia registrada para ' + ncfType +
              ' — factura #' + saleId + ' sale sin NCF. Registra el rango en el Panel NCF.');
          }
        }
      }

      // 5. Insertar items con snapshot (product_unit_id enlaza la unidad vendida
      //    en líneas serializadas; NULL en ventas fungibles).
      for (const item of saleItems) {
        db.prepare(`
          INSERT INTO sale_items(
            sale_id,product_id,product_code,product_name,unit_cost,unit_price,qty,subtotal,
            taxable,tax_pct,tax_amt,net_subtotal,product_unit_id
          )
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(saleId, item.product_id, item.product_code, item.product_name,
               item.unit_cost, item.unit_price, item.qty, round2(item.unit_price * item.qty),
               item.taxable, item.tax_pct, item.tax_amt, item.net_subtotal,
               item.product_unit_id || null);

        // 6. Descontar stock. Serializado: marca la UNIDAD como vendida (el stock
        //    ES el conteo de unidades). Fungible: descuenta el stock numérico como
        //    siempre (auto-repuestos idéntico).
        if (afectaStock && !item._nonStock) {
          if (item._serialized && item.product_unit_id) {
            productUnitsRepo.markSold(item.product_unit_id, saleId);
            const warrantyDays = Math.max(0, Math.min(3650, Number.parseInt(payment.warrantyDays, 10) || 0));
            if (warrantyDays > 0) productUnitsRepo.applySaleWarranty(item.product_unit_id, warrantyDays);
          } else {
            productsRepo.adjustStock(item.product_id, -item.qty, 'salida',
              `Venta #${saleId}`, saleId, user.id);
          }
        }
      }

      // El usado entra solo después de que la venta y sus líneas quedaron
      // validadas. Sigue dentro de la misma transacción de salesRepo.create.
      if (tradeIn) {
        const unitId = productUnitsRepo.create({
          product_id: tradeIn.productId,
          imei: tradeIn.imei || null,
          serial: tradeIn.serial || null,
          condition: 'usado', status: 'en_stock', unit_cost: tradeInAmount,
          color: tradeIn.color, capacity: tradeIn.capacity,
          notes: `Trade-in venta #${saleId}${tradeIn.notes ? ` · ${tradeIn.notes}` : ''}`,
        });
        db.prepare('UPDATE sales SET trade_in_unit_id=? WHERE id=?').run(unitId, saleId);
        db.prepare(`INSERT INTO trade_ins(
          sale_id,customer_id,product_id,product_unit_id,allowance,
          seller_name,seller_document,seller_phone,seller_phone_type,
          seller_address,seller_email,ownership_declared,lawful_origin_declared,created_by
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          saleId, tradeIn.customerId, tradeIn.productId, unitId, tradeInAmount,
          tradeIn.sellerName, tradeIn.sellerDocument, tradeIn.sellerPhone,
          tradeIn.sellerPhoneType, tradeIn.sellerAddress, tradeIn.sellerEmail,
          tradeIn.ownershipDeclared, tradeIn.lawfulOriginDeclared, user.id
        );
      }

      // 7. Actualizar crédito del cliente
      let initialPaymentId = null;
      let outstandingBalance = 0;
      if (type === 'factura' && payment.method === 'credito') {
        const ci = db.prepare('SELECT balance,credit_days FROM customers WHERE id=?').get(customer.id);
        const debtBeforeInitial = round2((ci.balance || 0) + amountDue);
        const newBalance = round2(debtBeforeInitial - initialPaymentAmount);
        outstandingBalance = round2(amountDue - initialPaymentAmount);
        const dueDate = ci.credit_due && ci.credit_due >= todayStr()
          ? ci.credit_due
          : addDaysStr(todayStr(), ci.credit_days || 30);
        db.prepare(`
          UPDATE customers SET balance=?,credit_due=?,updated_at=datetime('now') WHERE id=?
        `).run(newBalance, dueDate, customer.id);

        // El pago inicial es un abono real: queda vinculado a la factura, baja
        // la CxC, aparece en Caja/Ventas y conserva su propio número de recibo.
        if (initialPaymentAmount > 0) {
          const paymentInsert = db.prepare(`
            INSERT INTO payments(
              customer_id,sale_id,amount,method,note,balance_before,balance_after,
              cajero,user_id,cash_session_id,
              customer_contact_id,customer_contact_name,customer_contact_document,
              customer_contact_role,customer_contact_phone,customer_contact_email,
              financial_account_id,payment_currency,exchange_rate,account_amount,
              payment_reference,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
          `).run(
            customer.id, saleId, initialPaymentAmount, initialPaymentMethod,
            'Pago inicial de factura a crédito', debtBeforeInitial, newBalance,
            user.name || '', user.id, session.id,
            selectedContact?.id || null, selectedContact?.name || '',
            selectedContact?.document || '', selectedContact?.role || '',
            selectedContact?.phone || '', selectedContact?.email || '',
            initialFinancialAccount?.id || null, initialPaymentCurrency,
            initialExchangeRate, initialAccountAmount,
            String(payment.initialPaymentReference || '').trim().slice(0, 120)
          );
          initialPaymentId = Number(paymentInsert.lastInsertRowid);
          const initialIssue = _issueDocumentNumber('abono', 'payment', initialPaymentId);
          db.prepare(`
            UPDATE payments
            SET document_kind='abono',document_number=?,document_number_fmt=?,
                numero_recibo=COALESCE(numero_recibo,?)
            WHERE id=?
          `).run(
            initialIssue.sequence_number, initialIssue.formatted_number,
            initialIssue.sequence_number, initialPaymentId
          );
          if (initialPaymentMethod === 'mixto') {
            cashRepo.addMovement({
              sessionId: session.id, type: 'abono',
              amount: initialPaymentMixCash, method: 'efectivo',
              referenceId: initialPaymentId,
              paymentId: initialPaymentId,
              description: `Pago inicial ${documentIssue.formatted_number} (efectivo)`,
              userId: user.id,
            });
            cashRepo.addMovement({
              sessionId: session.id, type: 'abono',
              amount: initialPaymentMixNoncash, method: initialPaymentNoncashMethod,
              referenceId: initialPaymentId,
              paymentId: initialPaymentId,
              description: `Pago inicial ${documentIssue.formatted_number} (${initialPaymentNoncashMethod})`,
              userId: user.id,
            });
          } else {
            cashRepo.addMovement({
              sessionId: session.id, type: 'abono',
              amount: initialPaymentAmount, method: initialPaymentMethod,
              referenceId: initialPaymentId,
              paymentId: initialPaymentId,
              description: `Pago inicial ${documentIssue.formatted_number}`,
              userId: user.id,
            });
          }
          if (initialFinancialAccount && initialAccountAmount > 0.005) {
            financialAccountsRepo.addMovement({
              accountId: initialFinancialAccount.id,
              type: 'abono_recibido',
              amount: initialAccountAmount,
              description: `Pago inicial ${initialIssue.formatted_number}`,
              referenceType: 'payment',
              referenceId: initialPaymentId,
              method: initialBankMethod,
              userId: user.id,
              notes: initialPaymentCurrency === 'USD'
                ? `Base RD$${initialBankBaseAmount.toFixed(2)} · Tasa ${initialExchangeRate.toFixed(2)}`
                : String(payment.initialPaymentReference || '').trim().slice(0, 300),
            });
          }
        }
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
        } else if (amountDue > 0.005) {
          cashRepo.addMovement({
            sessionId: session.id, type: 'venta',
            amount: amountDue, method: payment.method,
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

      let convertedQuoteId = null;
      let convertedQuoteNumber = '';
      if (sourceQuote) {
        const removed = salesRepo.deleteQuote(sourceQuoteId, user.id, user.name);
        convertedQuoteId = Number(removed.id);
        convertedQuoteNumber = removed.documentNumber || sourceQuote.document_number_fmt || '';
        audit(user.id, user.name, 'cotizacion_convertida', 'sales', saleId,
          `${convertedQuoteNumber || '#' + sourceQuoteId} → ${documentIssue.formatted_number}`);
      }

      let convertedConduceId = null;
      let convertedConduceNumber = '';
      if (sourceConduce) {
        const insertLink = db.prepare(`
          INSERT INTO delivery_note_invoice_links
            (delivery_note_id,delivery_note_item_id,invoice_id,product_id,qty_linked)
          VALUES(?,?,?,?,?)
        `);
        sourceConduceLines.forEach(({ sourceLine, item }) => {
          insertLink.run(sourceConduceId, sourceLine.id, saleId, item.product_id, item.qty);
        });
        if (tableExists('delivery_note_charges')) {
          db.prepare(`
            UPDATE delivery_note_charges
            SET invoice_id=?,updated_at=datetime('now','localtime')
            WHERE delivery_note_id=? AND invoice_id IS NULL
          `).run(saleId, sourceConduceId);
        }
        const fullyInvoiced = conduceRepo.invoiceableLines(sourceConduceId)
          .every(line => line.invoiceable <= 1e-9);
        db.prepare(`
          UPDATE delivery_notes
          SET invoice_id=?,status=?,updated_at=datetime('now','localtime')
          WHERE id=?
        `).run(saleId, fullyInvoiced ? 'facturado' : sourceConduce.status, sourceConduceId);
        convertedConduceId = sourceConduceId;
        convertedConduceNumber = sourceConduce.number || '';
        audit(user.id, user.name, 'conduce_convertido', 'delivery_notes', sourceConduceId,
          `${convertedConduceNumber || '#' + sourceConduceId} → ${documentIssue.formatted_number}`);
      }

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
        tradeInAmount, tradeInUnitId: tradeIn ? db.prepare('SELECT trade_in_unit_id FROM sales WHERE id=?').get(saleId).trade_in_unit_id : null,
        prepaidAmount, prepaidReference,
        cardBrand, cardLast4, paymentReference,
        initialPaymentId, initialPaymentAmount, initialPaymentMethod,
        initialPaymentMixCash, initialPaymentMixNoncash, initialPaymentNoncashMethod,
        outstandingBalance,
        autoCreditLimitAssigned,
        replacesSaleId,
        convertedQuoteId,
        convertedQuoteNumber,
        convertedConduceId,
        convertedConduceNumber,
        reusedDocumentNumber: !!documentIssue.reused,
        operationId,
        idempotent: false,
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
            AND (
              (si.product_id IS NOT NULL AND rsi.product_id=si.product_id)
              OR
              (si.product_id IS NULL AND rsi.product_id IS NULL
                AND rsi.product_code=si.product_code AND rsi.product_name=si.product_name)
            )
        ),0) AS returned_qty
      FROM sale_items si WHERE si.sale_id=?
    `).all(id).map(item => ({
      ...item,
      returnable_qty: Math.max(0, (item.qty || 0) - (item.returned_qty || 0)),
    }));
    sale.charges = tableExists('sale_charges')
      ? db.prepare('SELECT id,description,amount FROM sale_charges WHERE sale_id=? ORDER BY id').all(id)
      : [];
    sale.trade_in = Number(sale.trade_in_amount || 0) > 0 && tableExists('trade_ins')
      ? db.prepare(`
          SELECT ti.*,pu.imei,pu.serial,p.name AS product_name,p.code AS product_code
          FROM trade_ins ti
          JOIN product_units pu ON pu.id=ti.product_unit_id
          JOIN products p ON p.id=ti.product_id
          WHERE ti.sale_id=?
        `).get(id) || null
      : null;
    if (sale.trade_in) {
      sale.trade_in_seller_name = sale.trade_in.seller_name || '';
      sale.trade_in_seller_document = sale.trade_in.seller_document || '';
      sale.trade_in_seller_phone = sale.trade_in.seller_phone || '';
      sale.trade_in_seller_address = sale.trade_in.seller_address || '';
      sale.trade_in_ownership_declared = Number(sale.trade_in.ownership_declared) || 0;
      sale.trade_in_lawful_origin_declared = Number(sale.trade_in.lawful_origin_declared) || 0;
      sale.trade_in_product_name = sale.trade_in.product_name || '';
      sale.trade_in_imei = sale.trade_in.imei || sale.trade_in.serial || '';
    }
    const payments = db.prepare(`
      SELECT p.id,p.document_kind,p.document_number,p.document_number_fmt,p.numero_recibo,
             COALESCE((
               SELECT pa.amount
               FROM payment_allocations pa
               WHERE pa.payment_id=p.id AND pa.sale_id=?
             ),p.amount) AS amount,
             p.amount AS payment_total,p.method,p.note,p.balance_before,p.balance_after,
             p.cajero,p.created_at
      FROM payments p
      WHERE COALESCE(p.status,'active')='active'
        AND (
          (
            p.sale_id=?
            AND NOT EXISTS (
              SELECT 1 FROM payment_allocations pa0 WHERE pa0.payment_id=p.id
            )
          )
          OR EXISTS (
            SELECT 1 FROM payment_allocations pa
            WHERE pa.payment_id=p.id AND pa.sale_id=?
          )
        )
      ORDER BY created_at DESC, id DESC
    `).all(id, id, id);
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
      if ((sale.payment_method || '').toLowerCase() === 'credito' && sale.customer_id) {
        const pending = getPendingInvoices(db, sale.customer_id);
        sale.balance_after_payment = round2(
          pending.facturas.find(invoice => Number(invoice.id) === Number(sale.id))?.pendiente || 0
        );
      } else {
        sale.balance_after_payment = 0;
      }
    } else if ((sale.payment_method || '').toLowerCase() === 'credito' && sale.type === 'factura') {
      const pending = getPendingInvoices(db, sale.customer_id);
      sale.balance_after_payment = round2(
        pending.facturas.find(invoice => Number(invoice.id) === Number(sale.id))?.pendiente || 0
      );
    } else if ((sale.payment_method || '').toLowerCase() !== 'credito' && sale.type === 'factura') {
      sale.balance_after_payment = 0;
      sale.last_receipt_number = sale.receipt_document_number_fmt || '';
    }
    // Adjuntar la referencia documental real a toda nota de crédito o factura
    // complementaria. Nunca mostrar el id técnico como si fuera el correlativo.
    if (sale.original_sale_id) {
      const orig = db.prepare(`
        SELECT ncf,document_kind,document_number_fmt,numero_factura,numero_factura_fmt,
               old_id_factura,import_source
        FROM sales WHERE id=?
      `).get(sale.original_sale_id);
      if (sale.type === 'devolucion') sale.modifies_ncf = (orig && orig.ncf) ? orig.ncf : '';
      sale.original_document_number_fmt = orig ? orig.document_number_fmt : '';
      sale.original_document_kind       = orig ? orig.document_kind       : '';
      sale.original_numero_factura     = orig ? orig.numero_factura     : null;
      sale.original_numero_factura_fmt = orig ? orig.numero_factura_fmt : null;
      sale.original_old_id_factura     = orig ? orig.old_id_factura     : null;
      sale.original_import_source      = orig ? orig.import_source      : '';
    }
    if (sale.replaces_sale_id) {
      sale.replaces_sale = db.prepare(`
        SELECT id,status,document_kind,document_number,document_number_fmt,
               cancelled_at,cancel_reason
        FROM sales WHERE id=?
      `).get(sale.replaces_sale_id) || null;
    }
    sale.replacement_sale = db.prepare(`
      SELECT id,status,document_kind,document_number,document_number_fmt,
             created_at
      FROM sales
      WHERE replaces_sale_id=?
      ORDER BY id DESC
      LIMIT 1
    `).get(sale.id) || null;
    if (sale.type === 'factura' && sale.correction_kind !== 'product_addition') {
      const operation = db.prepare(`
        SELECT
          COALESCE((
            SELECT SUM(supp.total) FROM sales supp
            WHERE supp.type='factura'
              AND supp.original_sale_id=?
              AND supp.correction_kind='product_addition'
              AND supp.status!='cancelled'
          ),0) additions,
          COALESCE((
            SELECT SUM(ret.total) FROM sales ret
            WHERE ret.type='devolucion'
              AND ret.status!='cancelled'
              AND (
                ret.original_sale_id=?
                OR ret.original_sale_id IN (
                  SELECT supp.id FROM sales supp
                  WHERE supp.type='factura'
                    AND supp.original_sale_id=?
                    AND supp.correction_kind='product_addition'
                    AND supp.status!='cancelled'
                )
              )
          ),0) credits
      `).get(sale.id, sale.id, sale.id);
      sale.adjustment_addition_total = round2(operation?.additions || 0);
      sale.operation_credit_total = round2(operation?.credits || 0);
      sale.operation_total = round2(
        Number(sale.total || 0) +
        sale.adjustment_addition_total -
        sale.operation_credit_total
      );

      // Copia consolidada para consulta/reimpresión de la factura ajustada.
      // Los documentos compensatorios permanecen inmutables en la base, pero el
      // cliente ve las cantidades actualmente vigentes en una sola operación.
      if (sale.adjustment_addition_total > 0 || sale.operation_credit_total > 0) {
        const sources = db.prepare(`
          SELECT id FROM sales
          WHERE id=?
             OR (
               original_sale_id=?
               AND type='factura'
               AND correction_kind='product_addition'
               AND status!='cancelled'
             )
          ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,id
        `).all(sale.id, sale.id, sale.id);
        const sourceIds = sources.map(row => Number(row.id));
        const marks = sourceIds.map(() => '?').join(',');
        const sourceItems = db.prepare(`
          SELECT sale_id,product_id,product_code,product_name,unit_cost,unit_price,
                 qty,subtotal,taxable,tax_pct,tax_amt,net_subtotal
          FROM sale_items
          WHERE sale_id IN (${marks})
          ORDER BY sale_id,id
        `).all(...sourceIds);
        const returnedItems = db.prepare(`
          SELECT ret.original_sale_id source_sale_id,
                 rsi.product_id,rsi.product_code,rsi.product_name,SUM(rsi.qty) qty
          FROM sales ret
          JOIN sale_items rsi ON rsi.sale_id=ret.id
          WHERE ret.type='devolucion'
            AND ret.status!='cancelled'
            AND ret.original_sale_id IN (${marks})
            AND ret.correction_kind!='monetary_credit'
          GROUP BY ret.original_sale_id,rsi.product_id,rsi.product_code,rsi.product_name
        `).all(...sourceIds);
        const itemKey = row => row.product_id != null
          ? `id:${row.product_id}`
          : `text:${String(row.product_code || '').trim().toLowerCase()}|${String(row.product_name || '').trim().toLowerCase()}`;
        const returnedBySource = new Map();
        returnedItems.forEach(row => {
          returnedBySource.set(`${row.source_sale_id}|${itemKey(row)}`, Number(row.qty || 0));
        });
        const grouped = new Map();
        sourceItems.forEach(row => {
          const key = `${row.sale_id}|${itemKey(row)}`;
          if (!grouped.has(key)) {
            grouped.set(key, {
              sale_id: row.sale_id,
              product_id: row.product_id,
              product_code: row.product_code || '',
              product_name: row.product_name || 'Producto',
              unit_cost: Number(row.unit_cost || 0),
              taxable: row.taxable,
              tax_pct: row.tax_pct,
              qty: 0,
              gross: 0,
              tax: 0,
              net: 0,
            });
          }
          const current = grouped.get(key);
          const qty = Number(row.qty || 0);
          const gross = row.subtotal != null
            ? Number(row.subtotal || 0)
            : Number(row.unit_price || 0) * qty;
          const tax = Number(row.tax_amt || 0);
          current.qty += qty;
          current.gross += gross;
          current.tax += tax;
          current.net += row.net_subtotal != null
            ? Number(row.net_subtotal || 0)
            : gross - tax;
        });
        sale.adjusted_items = [...grouped.values()].map(line => {
          const returned = returnedBySource.get(`${line.sale_id}|${itemKey(line)}`) || 0;
          const qty = Math.max(0, line.qty - returned);
          const ratio = line.qty > 0 ? qty / line.qty : 0;
          return {
            product_id: line.product_id,
            product_code: line.product_code,
            product_name: line.product_name,
            unit_cost: line.unit_cost,
            unit_price: line.qty > 0 ? round2(line.gross / line.qty) : 0,
            qty,
            subtotal: round2(line.gross * ratio),
            taxable: line.taxable,
            tax_pct: line.tax_pct,
            tax_amt: round2(line.tax * ratio),
            net_subtotal: round2(line.net * ratio),
          };
        }).filter(line => line.qty > 0);

        const adjustedAmounts = db.prepare(`
          SELECT
            COALESCE(SUM(CASE
              WHEN doc.type='factura' THEN doc.subtotal
              WHEN doc.type='devolucion' THEN -doc.subtotal
              ELSE 0 END),0) subtotal,
            COALESCE(SUM(CASE
              WHEN doc.type='factura' THEN doc.tax_amt
              WHEN doc.type='devolucion' THEN -doc.tax_amt
              ELSE 0 END),0) tax_amt
          FROM sales doc
          WHERE doc.status!='cancelled'
            AND (
              doc.id=?
              OR (
                doc.type='factura'
                AND doc.original_sale_id=?
                AND doc.correction_kind='product_addition'
              )
              OR (
                doc.type='devolucion'
                AND (
                  doc.original_sale_id=?
                  OR doc.original_sale_id IN (
                    SELECT supp.id FROM sales supp
                    WHERE supp.type='factura'
                      AND supp.original_sale_id=?
                      AND supp.correction_kind='product_addition'
                      AND supp.status!='cancelled'
                  )
                )
              )
            )
        `).get(sale.id, sale.id, sale.id, sale.id);
        sale.adjusted_subtotal = round2(adjustedAmounts?.subtotal || 0);
        sale.adjusted_tax_amt = round2(adjustedAmounts?.tax_amt || 0);
        sale.adjustment_documents = db.prepare(`
          SELECT id,type,correction_kind,document_number_fmt,numero_factura_fmt,ncf,
                 subtotal,tax_amt,total,created_at
          FROM sales
          WHERE status!='cancelled'
            AND (
              (type='factura' AND original_sale_id=? AND correction_kind='product_addition')
              OR (
                type='devolucion'
                AND (
                  original_sale_id=?
                  OR original_sale_id IN (
                    SELECT supp.id FROM sales supp
                    WHERE supp.type='factura'
                      AND supp.original_sale_id=?
                      AND supp.correction_kind='product_addition'
                      AND supp.status!='cancelled'
                  )
                )
              )
            )
          ORDER BY created_at,id
        `).all(sale.id, sale.id, sale.id);
        sale.adjustment_documents
          .filter(document => document.type === 'devolucion' &&
            document.correction_kind === 'monetary_credit')
          .forEach(document => {
            sale.adjusted_items.push({
              product_id: null,
              product_code: 'AJUSTE',
              product_name: 'AJUSTE MONETARIO / NOTA DE CRÉDITO',
              unit_cost: 0,
              unit_price: -round2(document.total || 0),
              qty: 1,
              subtotal: -round2(document.total || 0),
              taxable: Number(document.tax_amt || 0) !== 0 ? 1 : 0,
              tax_pct: sale.tax_pct,
              tax_amt: -round2(document.tax_amt || 0),
              net_subtotal: -round2(document.subtotal || 0),
              _is_adjustment: true,
            });
          });
      }
    }
    return sale;
  },

  getAll({ range = 'today', customerId, method, view, limit = 200, offset = 0 } = {}) {
    let where = "WHERE s.status != 'cancelled'";
    const params = [];
    // Ventas conserva visible la factura original aunque tenga ajustes. Las notas
    // de crédito viven además en Devoluciones, pero nunca "reemplazan" ni hacen
    // desaparecer el documento que modifican.
    if (view === 'sales') {
      where += ` AND s.status IN ('completed','returned') AND s.type!='devolucion'
        AND NOT (
          s.type='factura'
          AND s.correction_kind='product_addition'
          AND s.original_sale_id IS NOT NULL
        )`;
    }
    // Ventas y reportes comerciales usan la fecha operativa. created_at queda
    // reservado para auditoría técnica y jamás se refecha.
    if (range === 'today') {
      where += ` AND s.sale_date=date('now','localtime')`;
    } else if (range === 'week') {
      where += ` AND s.sale_date>=date('now','-7 days','localtime')`;
    } else if (range === 'month') {
      where += ` AND strftime('%Y-%m',s.sale_date)=strftime('%Y-%m','now','localtime')`;
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
             (
               COALESCE((
                 SELECT SUM(p.amount)
                 FROM payments p
                 WHERE p.sale_id=s.id
                   AND COALESCE(p.status,'active')='active'
                   AND NOT EXISTS (
                     SELECT 1 FROM payment_allocations pa0 WHERE pa0.payment_id=p.id
                   )
               ),0)
               +
               COALESCE((
                 SELECT SUM(pa.amount)
                 FROM payment_allocations pa
                 JOIN payments ap ON ap.id=pa.payment_id
                 WHERE pa.sale_id=s.id
                   AND COALESCE(ap.status,'active')='active'
               ),0)
             ) AS payment_amount,
             CASE
               WHEN LOWER(COALESCE(s.payment_method,''))='credito' THEN MAX(0, ROUND(
                 s.total - (
                   COALESCE((
                     SELECT SUM(p.amount)
                     FROM payments p
                     WHERE p.sale_id=s.id
                       AND COALESCE(p.status,'active')='active'
                       AND NOT EXISTS (
                         SELECT 1 FROM payment_allocations pa0 WHERE pa0.payment_id=p.id
                       )
                   ),0)
                   +
                   COALESCE((
                     SELECT SUM(pa.amount)
                     FROM payment_allocations pa
                     JOIN payments ap ON ap.id=pa.payment_id
                     WHERE pa.sale_id=s.id
                       AND COALESCE(ap.status,'active')='active'
                   ),0)
                 ), 2
               ))
               ELSE 0
             END AS balance_after_payment,
             EXISTS(
               SELECT 1 FROM sales ret
               WHERE ret.type='devolucion'
                 AND ret.original_sale_id=s.id
                 AND ret.status!='cancelled'
             ) AS has_active_return,
             COALESCE((
               SELECT SUM(ret.total) FROM sales ret
               WHERE ret.type='devolucion'
                 AND ret.original_sale_id=s.id
                 AND ret.status!='cancelled'
             ),0) AS adjustment_credit_total,
             COALESCE((
               SELECT SUM(supp.total) FROM sales supp
               WHERE supp.type='factura'
                 AND supp.original_sale_id=s.id
                 AND supp.correction_kind='product_addition'
                 AND supp.status!='cancelled'
             ),0) AS adjustment_addition_total,
             COALESCE((
               SELECT SUM(ret.total) FROM sales ret
               WHERE ret.type='devolucion'
                 AND ret.status!='cancelled'
                 AND (
                   ret.original_sale_id=s.id
                   OR ret.original_sale_id IN (
                     SELECT supp.id FROM sales supp
                     WHERE supp.type='factura'
                       AND supp.original_sale_id=s.id
                       AND supp.correction_kind='product_addition'
                       AND supp.status!='cancelled'
                   )
                 )
             ),0) AS operation_credit_total,
             EXISTS(
               SELECT 1 FROM sale_corrections sc
               WHERE sc.sale_id=CASE
                 WHEN s.correction_kind='product_addition' AND s.original_sale_id IS NOT NULL
                   THEN s.original_sale_id
                 ELSE s.id
               END
                 AND sc.action='correct_products'
             ) AS has_product_correction,
             orig.document_kind       AS original_document_kind,
             orig.document_number_fmt AS original_document_number_fmt,
             orig.numero_factura     AS original_numero_factura,
             orig.numero_factura_fmt AS original_numero_factura_fmt,
             orig.old_id_factura     AS original_old_id_factura,
             orig.import_source      AS original_import_source
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN sales orig    ON orig.id = s.original_sale_id
      LEFT JOIN salespeople sp ON sp.id = s.salesperson_id
      ${where}
      GROUP BY s.id
      ORDER BY s.sale_date DESC, s.id DESC
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
      where += ` AND status IN ('completed','returned') AND type!='devolucion'
        AND NOT (
          type='factura'
          AND correction_kind='product_addition'
          AND original_sale_id IS NOT NULL
        )`;
    }
    // Coherente con getAll: fecha operativa, no fecha técnica de creación.
    if (range === 'today') {
      where += ` AND sale_date=date('now','localtime')`;
    } else if (range === 'week') {
      where += ` AND sale_date>=date('now','-7 days','localtime')`;
    } else if (range === 'month') {
      where += ` AND strftime('%Y-%m',sale_date)=strftime('%Y-%m','now','localtime')`;
    }
    if (customerId) { where += ' AND customer_id=?'; params.push(customerId); }
    if (method)     { where += ' AND payment_method=?'; params.push(method); }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM sales ${where}`).get(...params);
    return row ? row.n : 0;
  },

  updateDate() {
    throw new Error('Usa el flujo transaccional sales:corrections:changeDate');
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
  search(q, limit = 8, productIds = []) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];

    const qNorm   = _searchNorm(term);
    const qDigits = _digitsOf(term);
    const idNum   = parseInt(term, 10);
    const termNoHash = term.replace(/^#/, '').trim();
    const facNum = parseInt(termNoHash, 10);
    const matchedProductIds = [...new Set((Array.isArray(productIds) ? productIds : [])
      .map(Number).filter(Number.isInteger).filter(id => id > 0))].slice(0, 20);
    const like = `%${term.toLowerCase()}%`;
    const likeNoHash = `%${termNoHash.toLowerCase()}%`;

    // Primero se resuelven ids candidatos. La implementación anterior unía
    // cada venta con todos sus artículos por cada tecla y multiplicaba el
    // trabajo sobre importaciones grandes.
    const headerIds = db.prepare(`
      SELECT DISTINCT s.id
      FROM sales s
      LEFT JOIN customers c ON c.id=s.customer_id
      LEFT JOIN salespeople sp ON sp.id=s.salesperson_id
      WHERE s.status!='cancelled' AND (
        s.id=? OR s.numero_factura=?
        OR lower(s.document_number_fmt) LIKE ?
        OR lower(s.numero_factura_fmt) LIKE ?
        OR lower(s.ncf) LIKE ?
        OR lower(s.customer_name) LIKE ?
        OR lower(s.customer_rnc) LIKE ?
        OR lower(s.customer_contact_name) LIKE ?
        OR lower(s.customer_contact_role) LIKE ?
        OR lower(s.customer_contact_phone) LIKE ?
        OR lower(s.notes) LIKE ?
        OR lower(sp.name) LIKE ?
        OR lower(sp.code) LIKE ?
        OR lower(c.phone) LIKE ?
        OR EXISTS (
          SELECT 1 FROM payments p
          WHERE COALESCE(p.status,'active')='active'
            AND CAST(p.numero_recibo AS TEXT) LIKE ?
            AND (
              (p.sale_id=s.id AND NOT EXISTS (
                SELECT 1 FROM payment_allocations pa0 WHERE pa0.payment_id=p.id
              ))
              OR EXISTS (
                SELECT 1 FROM payment_allocations pa
                WHERE pa.payment_id=p.id AND pa.sale_id=s.id
              )
            )
        )
      )
      ORDER BY s.id DESC LIMIT 120
    `).all(
      Number.isFinite(idNum) ? idNum : -1,
      Number.isFinite(facNum) ? facNum : -1,
      likeNoHash, likeNoHash, like, like, like, like, like, like,
      like, like, like, like, likeNoHash
    );

    let itemIds;
    if (matchedProductIds.length) {
      const placeholders = matchedProductIds.map(() => '?').join(',');
      itemIds = db.prepare(`
        SELECT DISTINCT si.sale_id AS id
        FROM sale_items si JOIN sales s ON s.id=si.sale_id
        WHERE s.status!='cancelled' AND si.product_id IN (${placeholders})
        ORDER BY si.sale_id DESC LIMIT 300
      `).all(...matchedProductIds);
    } else {
      itemIds = db.prepare(`
        SELECT DISTINCT si.sale_id AS id
        FROM sale_items si JOIN sales s ON s.id=si.sale_id
        WHERE s.status!='cancelled'
          AND (lower(si.product_name) LIKE ? OR lower(si.product_code) LIKE ?)
        ORDER BY si.sale_id DESC LIMIT 180
      `).all(like, like);
    }

    const productSaleIds = new Set(itemIds.map(row => Number(row.id)));
    const candidateIds = [...new Set([...headerIds, ...itemIds].map(row => Number(row.id)))]
      .filter(Number.isInteger).sort((a, b) => b - a).slice(0, 300);
    if (!candidateIds.length) return [];

    const placeholders = candidateIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT s.*,
             sp.name AS salesperson_name,
             sp.code AS salesperson_code,
             GROUP_CONCAT(si.product_name || ' x' || si.qty, ' | ') AS items_summary,
             c.phone AS _cust_phone,
             (
               SELECT GROUP_CONCAT(p.numero_recibo, ',') FROM payments p
               WHERE COALESCE(p.status,'active')='active' AND (
                 (p.sale_id=s.id AND NOT EXISTS (
                   SELECT 1 FROM payment_allocations pa0 WHERE pa0.payment_id=p.id
                 ))
                 OR EXISTS (
                   SELECT 1 FROM payment_allocations pa
                   WHERE pa.payment_id=p.id AND pa.sale_id=s.id
                 )
               )
             ) AS _recibos
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id=s.id
      LEFT JOIN customers c ON c.id=s.customer_id
      LEFT JOIN salespeople sp ON sp.id=s.salesperson_id
      WHERE s.id IN (${placeholders})
      GROUP BY s.id ORDER BY s.id DESC
    `).all(...candidateIds);

    const matchText   = (hay) => !qNorm || _searchNorm(hay).includes(qNorm);
    const matchDigits = (hay) => !!qDigits && _digitsOf(hay).includes(qDigits);
    const filtered = rows.filter(s =>
      String(s.id) === term || String(s.id).includes(term) ||
      (Number.isFinite(facNum) && s.numero_factura === facNum) ||
      matchText(s.document_number_fmt) || matchDigits(s.document_number_fmt) ||
      matchText(s.numero_factura_fmt) || matchDigits(s.numero_factura_fmt) ||
      matchText(s.ncf) || matchText(s.customer_name) || matchText(s.customer_rnc) ||
      matchDigits(s.customer_rnc) || matchText(s.customer_contact_name) ||
      matchText(s.customer_contact_role) || matchDigits(s.customer_contact_phone) ||
      matchDigits(s._cust_phone) || matchDigits(s._recibos) || matchText(s.notes) ||
      matchText(s.salesperson_name) || matchText(s.salesperson_code) ||
      matchText(s.items_summary) || productSaleIds.has(Number(s.id))
    );

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

  cancel(id, reason, userId, userName, options = {}) {
    // reuseNcf: SOLO cuando el operador confirma que el comprobante NO se entregó
    // ni se reportó (p. ej. error de RNC detectado antes de dárselo al cliente).
    // Por defecto es false: el NCF se conserva ANULADO y aparece en el 608, que es
    // el comportamiento fiscalmente correcto. Nunca se produce un NCF duplicado.
    const reuseNcf = !!options.reuseNcf;
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!sale) throw new Error('Venta no encontrada');
    if (sale.status === 'cancelled') throw new Error('Venta ya está cancelada');
    if (sale.status === 'returned')  throw new Error('No se puede anular una venta con devolución procesada');
    // SEGURIDAD: solo facturas y ventas de crédito pueden anularse
    if (sale.type === 'cotizacion') throw new Error('Las cotizaciones no se anulan — elimínalas directamente');
    const legacyApplied = db.prepare(`
      SELECT COALESCE(SUM(p.amount),0) total
      FROM payments p
      WHERE p.sale_id=?
        AND COALESCE(p.status,'active')='active'
        ${tableExists('payment_allocations')
          ? 'AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id=p.id)'
          : ''}
    `).get(id)?.total || 0;
    const distributedApplied = tableExists('payment_allocations')
      ? db.prepare(`
          SELECT COALESCE(SUM(pa.amount),0) total
          FROM payment_allocations pa
          JOIN payments p ON p.id=pa.payment_id
          WHERE pa.sale_id=? AND COALESCE(p.status,'active')='active'
        `).get(id)?.total || 0
      : 0;
    const appliedTotal = round2(Number(legacyApplied) + Number(distributedApplied));
    if (appliedTotal > 0.005) {
      throw new Error(
        `Esta factura tiene ${appliedTotal.toFixed(2)} en abonos aplicados. ` +
        'No puede anularse hasta procesar formalmente el reembolso o reverso de esos cobros'
      );
    }

    const cancelTx = db.transaction(() => {
      db.prepare(`
        UPDATE sales SET status='cancelled',cancelled_at=datetime('now'),cancel_reason=? WHERE id=?
      `).run(reason, id);
      db.prepare(`
        UPDATE document_issues SET status='cancelled'
        WHERE source_type IN ('sale','sale_receipt') AND source_id=?
      `).run(String(id));

      // Liberar solo el correlativo interno de la factura (FAC-/FCR-): vuelve a
      // la cola para que su reemplazo controlado pueda reutilizarlo. El recibo
      // permanece anulado y nunca se recicla, porque el nuevo cobro debe conservar
      // su propia numeración y una trazabilidad financiera inequívoca. Tampoco se
      // libera numeración importada (factura_historica conserva su número histórico
      // definitivo).
      //
      // Se recicla cuando es coherente con la decisión fiscal: si la factura no
      // llevó comprobante (sin impacto fiscal) o si el operador eligió reutilizar
      // también el NCF. En una anulación formal al 608 (se conserva el NCF) el
      // número interno también se conserva, para no dejar dos documentos vivos con
      // el mismo correlativo mientras el comprobante queda declarado como anulado.
      const freeingAllowed = !String(sale.import_source || '').trim();
      const hadNcf = !!(sale.ncf && String(sale.ncf).trim());
      const freeDocNumber = freeingAllowed && (!hadNcf || reuseNcf);
      if (freeDocNumber) {
        ensureDocumentAvailableNumbersTable();
        const freedIssues = db.prepare(`
          SELECT kind,sequence_number,formatted_number
          FROM document_issues
          WHERE source_type='sale' AND source_id=? AND status='cancelled'
        `).all(String(id));
        const pushFreedNumber = db.prepare(`
          INSERT INTO document_available_numbers(kind,sequence_number,formatted_number,status,source,source_sale_id)
          VALUES(?,?,?,'available','anulacion',?)
          ON CONFLICT(kind,sequence_number) DO UPDATE SET
            status='available',source='anulacion',source_sale_id=excluded.source_sale_id,
            issued_source_type=NULL,issued_source_id=NULL,issued_at=NULL
        `);
        for (const iss of freedIssues) {
          if (iss.kind === 'factura_historica') continue;
          pushFreedNumber.run(iss.kind, iss.sequence_number, iss.formatted_number, id);
        }
      }

      if (tableExists('checkout_orders')) {
        db.prepare(`
          UPDATE checkout_orders
          SET status='cancelled',cancel_reason=?,cancelled_at=datetime('now','localtime'),
              updated_at=datetime('now','localtime')
          WHERE sale_id=? AND status IN ('paid','dispatched')
        `).run(`Factura anulada: ${reason || 'sin motivo'}`.slice(0, 300), id);
      }

      // Fiscal: por defecto el NCF se conserva ANULADO y aparece en el 608 (correcto).
      // Solo si el operador pidió reutilizarlo (reuseNcf) — porque el comprobante NO
      // se entregó ni reportó — el número vuelve a la cola de disponibles para que la
      // próxima factura del mismo tipo lo tome; se retira de ncf_log y de la venta
      // anulada para no chocar con el índice UNIQUE ni con la verificación de ocupación
      // de allocateNextNcfNumber, evitando cualquier NCF duplicado.
      // Un NCF importado o sin secuencia propia siempre se conserva 'anulado' (608).
      if (sale.ncf && String(sale.ncf).trim()) {
        const parsedNcf = (reuseNcf && freeingAllowed) ? parseCanonicalLegacyNcf(sale.ncf) : null;
        const owningSeq = parsedNcf
          ? db.prepare(`
              SELECT id FROM ncf_sequences
              WHERE type=? AND from_num<=? AND to_num>=?
              ORDER BY id LIMIT 1
            `).get(parsedNcf.type, parsedNcf.sequence, parsedNcf.sequence)
          : null;
        if (parsedNcf && owningSeq) {
          ensureNcfAvailableNumbersTable();
          db.prepare(`
            INSERT INTO ncf_available_numbers(sequence_id,ncf_type,sequence_number,status,source)
            VALUES(?,?,?,'available','anulacion')
            ON CONFLICT(ncf_type,sequence_number) DO UPDATE SET
              status='available',sequence_id=excluded.sequence_id,source='anulacion',
              issued_sale_id=NULL,issued_at=NULL
          `).run(owningSeq.id, parsedNcf.type, parsedNcf.sequence);
          db.prepare("DELETE FROM ncf_log WHERE sale_id=? AND UPPER(TRIM(COALESCE(ncf,'')))=?")
            .run(id, parsedNcf.ncf);
          db.prepare("UPDATE sales SET ncf='' WHERE id=?").run(id);
          audit(userId, userName, 'ncf_liberado_por_anulacion', 'sales', id,
            `NCF ${parsedNcf.ncf} devuelto a la cola para reutilización`);
        } else {
          db.prepare(`UPDATE ncf_log SET status='anulado', voided_at=datetime('now')
                      WHERE sale_id=? AND ncf=? AND status!='anulado'`).run(id, String(sale.ncf).trim());
        }
      }

      // Reponer stock
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
      for (const item of items) {
        if (sale.type === 'factura' || sale.payment_method === 'credito') {
          if (item.product_unit_id) {
            db.prepare(`UPDATE product_units SET status='en_stock',sale_id=NULL,sold_at=NULL,warranty_until=NULL WHERE id=? AND sale_id=?`)
              .run(item.product_unit_id, id);
          } else if (item.product_id) {
            productsRepo.adjustStock(item.product_id, item.qty, 'devolucion',
              `Anulación venta #${id}`, id, userId);
          }
        }
      }

      // El equipo recibido como pago deja de ser inventario disponible cuando
      // se anula el negocio que lo originó. Se conserva como evidencia devuelta.
      if (sale.trade_in_unit_id) {
        db.prepare("UPDATE product_units SET status='devuelto' WHERE id=?").run(sale.trade_in_unit_id);
        db.prepare("UPDATE trade_ins SET status='cancelado' WHERE sale_id=?").run(id);
      }

      // Si era crédito, revertir balance y calcular overpayment
      let overpayment = 0;
      if (sale.payment_method === 'credito' && sale.customer_id !== 1) {
        const cust = db.prepare('SELECT balance FROM customers WHERE id=?').get(sale.customer_id);
        const theoretical = (cust?.balance || 0) - round2((sale.total || 0) - (sale.trade_in_amount || 0));
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

      // cash_sessions conserva acumulados para resúmenes rápidos. Al anular no
      // se resta a ciegas: se reconstruye desde las facturas vigentes para
      // corregir también cualquier desfase previo de esa misma sesión.
      if (sale.cash_session_id) {
        reconcileCashSessionTotals(db, { sessionId: sale.cash_session_id });
      }

      // Si la factura nació de un conduce, su anulación libera exactamente las
      // cantidades y cargos enlazados por esa factura. Los demás enlaces de una
      // conversión parcial permanecen intactos.
      if (tableExists('delivery_note_invoice_links')) {
        const affectedNotes = db.prepare(`
          SELECT DISTINCT delivery_note_id AS id
          FROM delivery_note_invoice_links WHERE invoice_id=?
        `).all(id);
        db.prepare('DELETE FROM delivery_note_invoice_links WHERE invoice_id=?').run(id);
        if (tableExists('delivery_note_charges')) {
          db.prepare(`
            UPDATE delivery_note_charges
            SET invoice_id=NULL,updated_at=datetime('now','localtime')
            WHERE invoice_id=?
          `).run(id);
        }
        for (const note of affectedNotes) {
          const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(note.id);
          if (!dn || ['anulado', 'devuelto'].includes(dn.status)) continue;
          const lastInvoice = db.prepare(`
            SELECT invoice_id FROM delivery_note_invoice_links
            WHERE delivery_note_id=? ORDER BY id DESC LIMIT 1
          `).get(note.id)?.invoice_id || null;
          const fallbackStatus = dn.received_date
            ? 'entregado'
            : (dn.dispatch_date ? 'despachado' : 'borrador');
          db.prepare(`
            UPDATE delivery_notes
            SET invoice_id=?,status=?,updated_at=datetime('now','localtime')
            WHERE id=?
          `).run(lastInvoice, fallbackStatus, note.id);
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
  summary(range = 'today', dateFrom = null, dateTo = null, filters = {}) {
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
          withAlias:    { sql: `s.sale_date BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
          withoutAlias: { sql: `sale_date   BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
          payments:     { sql: `date(created_at)   BETWEEN ? AND ?`,  params: [safeFrom, safeTo] },
        };
      }
      if (range === 'month') return {
        withAlias:    { sql: `strftime('%Y-%m',s.sale_date) = strftime('%Y-%m','now','localtime')`, params: [] },
        withoutAlias: { sql: `strftime('%Y-%m',sale_date)   = strftime('%Y-%m','now','localtime')`, params: [] },
        payments:     { sql: `strftime('%Y-%m',created_at)   = strftime('%Y-%m','now','localtime')`, params: [] },
      };
      if (range === 'week') return {
        withAlias:    { sql: `s.sale_date >= date('now','-6 days','localtime')`, params: [] },
        withoutAlias: { sql: `sale_date   >= date('now','-6 days','localtime')`, params: [] },
        payments:     { sql: `date(created_at)   >= date('now','-6 days','localtime')`, params: [] },
      };
      if (range === 'all') return {
        withAlias:    { sql: `1=1`, params: [] },
        withoutAlias: { sql: `1=1`, params: [] },
        payments:     { sql: `1=1`, params: [] },
      };
      // today (default)
      return {
        withAlias:    { sql: `s.sale_date = date('now','localtime')`, params: [] },
        withoutAlias: { sql: `sale_date   = date('now','localtime')`, params: [] },
        payments:     { sql: `date(created_at)   = date('now','localtime')`, params: [] },
      };
    };

    const f = _buildFilters();
    const priceMode = ['retail', 'wholesale'].includes(String(filters?.priceMode || ''))
      ? String(filters.priceMode) : 'all';
    const customerType = ['person', 'company'].includes(String(filters?.customerType || ''))
      ? String(filters.customerType) : 'all';
    const segmentOnly = { sql: '1=1', params: [] };
    if (priceMode !== 'all') {
      f.withAlias.sql += ` AND COALESCE(s.price_mode,'retail')=?`;
      f.withAlias.params.push(priceMode);
      f.withoutAlias.sql += ` AND COALESCE(price_mode,'retail')=?`;
      f.withoutAlias.params.push(priceMode);
      segmentOnly.sql += ` AND COALESCE(s.price_mode,'retail')=?`;
      segmentOnly.params.push(priceMode);
    }
    if (customerType !== 'all') {
      f.withAlias.sql += ` AND COALESCE(s.customer_type,'person')=?`;
      f.withAlias.params.push(customerType);
      f.withoutAlias.sql += ` AND COALESCE(customer_type,'person')=?`;
      f.withoutAlias.params.push(customerType);
      segmentOnly.sql += ` AND COALESCE(s.customer_type,'person')=?`;
      segmentOnly.params.push(customerType);
    }

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
      SELECT s.sale_date as day,
             COUNT(*) as count,
             SUM(s.total) as total,
             SUM(COALESCE((
               SELECT SUM(si.unit_cost * si.qty)
               FROM sale_items si
               WHERE si.sale_id=s.id
             ),0)) as cost
      FROM sales s
      WHERE s.status='completed' AND s.type='factura'
        ${hfs} AND ${f.withAlias.sql}
      GROUP BY day
      ORDER BY day ASC
    `).all(...f.withAlias.params);

    // Abonos recibidos en el período (excluir saldos iniciales importados)
    // Usa hfp: el alcance temporal no cambia si un registro es importado.
    // method='descuento' se excluye: es una rebaja que cierra factura sin que
    // entre efectivo, no un cobro. Sumarlo inflaría la caja.
    let abonosData;
    if (priceMode === 'all' && customerType === 'all') {
      abonosData = db.prepare(`
        SELECT COUNT(*) as count, SUM(amount) as total
        FROM payments
        WHERE ${f.payments.sql}
          AND COALESCE(status,'active')='active'
          AND note != 'Saldo inicial importado'
          AND LOWER(COALESCE(method,'efectivo')) != 'descuento' ${hfp}
      `).get(...f.payments.params);
    } else {
      // Cuando el dueño filtra un segmento, un recibo distribuido puede tocar
      // facturas de segmentos distintos. Solo se atribuye a este reporte la
      // parte realmente aplicada a facturas que cumplen el filtro.
      const candidatePayments = db.prepare(`
        SELECT id,sale_id,amount
        FROM payments
        WHERE ${f.payments.sql}
          AND COALESCE(status,'active')='active'
          AND note != 'Saldo inicial importado'
          AND LOWER(COALESCE(method,'efectivo')) != 'descuento' ${hfp}
      `).all(...f.payments.params);
      let filteredPaymentTotal = 0;
      let filteredPaymentCount = 0;
      for (const payment of candidatePayments) {
        const allocated = db.prepare(`
          SELECT COALESCE(SUM(pa.amount),0) AS total
          FROM payment_allocations pa
          JOIN sales s ON s.id=pa.sale_id
          WHERE pa.payment_id=?
            AND s.status!='cancelled'
            AND ${segmentOnly.sql}
        `).get(payment.id, ...segmentOnly.params)?.total || 0;
        const hasAllocations = db.prepare(
          'SELECT 1 FROM payment_allocations WHERE payment_id=? LIMIT 1'
        ).get(payment.id);
        let attributable = Number(allocated || 0);
        if (!hasAllocations && payment.sale_id) {
          const directMatch = db.prepare(`
            SELECT 1
            FROM sales s
            WHERE s.id=? AND s.status!='cancelled' AND ${segmentOnly.sql}
          `).get(payment.sale_id, ...segmentOnly.params);
          attributable = directMatch ? Number(payment.amount || 0) : 0;
        }
        if (attributable > 0.005) {
          filteredPaymentTotal += attributable;
          filteredPaymentCount += 1;
        }
      }
      abonosData = {
        count: filteredPaymentCount,
        total: round2(filteredPaymentTotal),
      };
    }

    // Desglose contado vs crédito (para cobradoMes)
    const contadoCreditoData = db.prepare(`
      SELECT
        SUM(CASE WHEN payment_method != 'credito' THEN total ELSE 0 END) as ventas_contado,
        SUM(CASE WHEN payment_method  = 'credito' THEN total ELSE 0 END) as ventas_credito
      FROM sales
      WHERE status='completed' AND type='factura'
        ${hf} AND ${f.withoutAlias.sql}
    `).get(...f.withoutAlias.params);

    // Segmentación comercial para el dueño: detalle/mayorista,
    // personas/empresas, clientes principales y facturas auditables.
    const byPriceMode = db.prepare(`
      SELECT COALESCE(price_mode,'retail') AS segment,
             COUNT(*) AS count,COALESCE(SUM(total),0) AS total,
             COALESCE(AVG(total),0) AS average_ticket
      FROM sales
      WHERE status='completed' AND type='factura'
        AND ${f.withoutAlias.sql}
      GROUP BY COALESCE(price_mode,'retail')
      ORDER BY total DESC
    `).all(...f.withoutAlias.params);
    const byCustomerType = db.prepare(`
      SELECT COALESCE(customer_type,'person') AS segment,
             COUNT(*) AS count,COALESCE(SUM(total),0) AS total,
             COALESCE(AVG(total),0) AS average_ticket
      FROM sales
      WHERE status='completed' AND type='factura'
        AND ${f.withoutAlias.sql}
      GROUP BY COALESCE(customer_type,'person')
      ORDER BY total DESC
    `).all(...f.withoutAlias.params);
    const topCustomers = db.prepare(`
      SELECT customer_id,customer_name,customer_rnc,
             COALESCE(customer_type,'person') AS customer_type,
             COUNT(*) AS count,COALESCE(SUM(total),0) AS total,
             COALESCE(AVG(total),0) AS average_ticket
      FROM sales
      WHERE status='completed' AND type='factura'
        AND ${f.withoutAlias.sql}
      GROUP BY customer_id,customer_name,customer_rnc,COALESCE(customer_type,'person')
      ORDER BY total DESC
      LIMIT 15
    `).all(...f.withoutAlias.params);
    const salesDetail = db.prepare(`
      SELECT id,sale_date,customer_name,customer_rnc,customer_type,
             price_mode,payment_method,total,tax_amt,discount_amt,
             document_number_fmt,numero_factura,numero_factura_fmt,ncf,
             CASE WHEN COALESCE(import_source,'')<>'' THEN 1 ELSE 0 END AS imported
      FROM sales
      WHERE status='completed' AND type='factura'
        AND ${f.withoutAlias.sql}
      ORDER BY sale_date DESC,id DESC
      LIMIT 1000
    `).all(...f.withoutAlias.params);

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
      averageTicket: totalSales > 0 ? round2(totalRev / totalSales) : 0,
      byPriceMode, byCustomerType, topCustomers, salesDetail,
      filters: { priceMode, customerType },
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
    const baseWhere = `${f.sql}
      AND COALESCE(p.status,'active')='active'
      AND COALESCE(p.note,'') != 'Saldo inicial importado'`;

    const rows = db.prepare(`
      SELECT p.*,
             c.name AS customer_name,
             c.rnc  AS customer_rnc,
             s.total AS sale_total,
             s.created_at AS sale_created_at,
             s.sale_date AS sale_date,
             s.original_sale_date AS sale_original_date,
             s.fiscal_issued_at AS sale_fiscal_issued_at,
             s.document_number_fmt AS sale_document_number_fmt,
             s.numero_factura     AS sale_numero_factura,
             s.numero_factura_fmt AS sale_numero_factura_fmt,
             s.ncf                AS sale_ncf,
             CASE WHEN COALESCE(p.import_source,'')<>'' OR p.cajero='Importación histórica'
                  OR p.note='Saldo inicial importado' THEN 1 ELSE 0 END AS imported
      FROM payments p
      LEFT JOIN customers c ON c.id = p.customer_id
      LEFT JOIN sales s ON s.id = p.sale_id
      WHERE ${baseWhere}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 5000
    `).all(...f.params).map(hydratePaymentAllocations);

    const byDay = db.prepare(`
      SELECT date(p.created_at) AS day,
             COUNT(*) AS count,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))!='descuento' THEN p.amount ELSE 0 END),0) AS total,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.method,'efectivo'))='descuento' THEN p.amount ELSE 0 END),0) AS discount_total,
             SUM(CASE WHEN COALESCE(p.import_source,'')<>'' OR p.cajero='Importación histórica'
                           OR p.note='Saldo inicial importado' THEN p.amount ELSE 0 END) AS imported_total,
             SUM(CASE WHEN COALESCE(p.import_source,'')='' AND p.cajero!='Importación histórica'
                           AND p.note!='Saldo inicial importado' THEN p.amount ELSE 0 END) AS current_total
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
             SUM(CASE WHEN COALESCE(p.import_source,'')<>'' OR p.cajero='Importación histórica'
                           OR p.note='Saldo inicial importado' THEN p.amount ELSE 0 END) AS imported_total,
             SUM(CASE WHEN COALESCE(p.import_source,'')='' AND p.cajero!='Importación histórica'
                           AND p.note!='Saldo inicial importado' THEN p.amount ELSE 0 END) AS current_total,
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
      SELECT s.sale_date as day,
             COUNT(DISTINCT s.id) as count,
             SUM(s.total) as total,
             SUM(s.tax_amt) as tax,
             SUM(si.unit_cost * si.qty) as cost
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.status='completed' AND s.type='factura'
        AND s.sale_date >= date('now','-'||?||' days','localtime')
        AND (? = 1 OR s.cajero != 'Importación histórica')
      GROUP BY day
      ORDER BY day ASC
    `).all(days, includeHistorical ? 1 : 0);
  },

  monthlyTrend({ months = 12, includeHistorical = true } = {}) {
    return db.prepare(`
      SELECT strftime('%Y-%m', s.sale_date) as month,
             COUNT(DISTINCT s.id) as count,
             SUM(s.total) as total,
             SUM(s.tax_amt) as tax
      FROM sales s
      WHERE s.status='completed' AND s.type='factura'
        AND s.sale_date >= date('now','-'||?||' months','localtime')
        AND (? = 1 OR s.cajero != 'Importación histórica')
      GROUP BY month
      ORDER BY month ASC
    `).all(months, includeHistorical ? 1 : 0);
  },
};


// ══════════════════════════════════════════════
// DEVOLUCIONES
// ══════════════════════════════════════════════
function _returnLineKey(row) {
  const productId = Number(row?.product_id) || 0;
  if (productId) return `product:${productId}`;
  return `service:${String(row?.product_code || '').trim()}|${String(row?.product_name || row?.name || '').trim()}`;
}

const returnsRepo = {
  /**
   * Procesa una devolución parcial o total de una venta.
   * - Crea una venta de tipo 'devolucion' vinculada a la original
   * - Repone stock de los artículos devueltos
   * - Si la venta original era a crédito, reduce el balance del cliente
   * - Registra movimiento de caja si aplica (devolución en efectivo)
   * - Todo en una sola transacción — si algo falla, revierte todo
   */
  create({
    originalSaleId,
    items = [],
    session,
    user,
    reason = '',
    monetaryAmount = null,
    monetaryLabel = 'Descuento o ajuste monetario posterior',
  }) {
    const createReturnTx = db.transaction(() => {
      const isMonetaryCredit = monetaryAmount !== null && monetaryAmount !== undefined;
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
        SELECT si.product_id,si.product_code,si.product_name,COALESCE(SUM(si.qty),0) AS devuelto
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE s.type='devolucion' AND s.original_sale_id=? AND s.status != 'cancelled'
        GROUP BY si.product_id,si.product_code,si.product_name
      `).all(originalSaleId);
      const yaDevuelto = new Map();
      prevReturns.forEach(r => { yaDevuelto.set(_returnLineKey(r), r.devuelto || 0); });

      const preparedReturnItems = [];
      if (!isMonetaryCredit) {
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error('Debes seleccionar al menos un producto para devolver');
        }
        for (const item of items) {
          if (!Number.isInteger(Number(item.qty)) || Number(item.qty) <= 0) {
            throw new Error('La cantidad a devolver debe ser un número entero mayor que cero');
          }
          const requestedSaleItemId = Number(item.sale_item_id || item.original_sale_item_id) || 0;
          const orig = requestedSaleItemId
            ? originalItems.find(oi => Number(oi.id) === requestedSaleItemId)
            : originalItems.find(oi => _returnLineKey(oi) === _returnLineKey(item));
          if (!orig) throw new Error(`Producto ID ${item.product_id} no pertenece a esta venta`);
          const lineKey = _returnLineKey(orig);
          const yaDev = yaDevuelto.get(lineKey) || 0;
          const disponible = orig.qty - yaDev;
          if (Number(item.qty) > disponible) {
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
            qty:          Number(item.qty),
            taxable:      orig.taxable,
            tax_pct:      orig.tax_pct,
          });
        }
      }

      // 3. Calcular totales de la devolución (usando precios históricos del snapshot)
      const hasIncludedTaxSnapshot = originalItems.some(oi =>
        oi.taxable !== null || oi.tax_pct !== null || oi.tax_amt !== null || oi.net_subtotal !== null
      );
      const taxPct = original.tax_pct || 0;
      let subtotal, taxAmt, total;
      if (isMonetaryCredit) {
        const requestedAmount = round2(Number(monetaryAmount));
        if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
          throw new Error('El importe de la nota de crédito debe ser mayor que cero');
        }
        const activeCredits = db.prepare(`
          SELECT COALESCE(SUM(total),0) total
          FROM sales
          WHERE type='devolucion' AND original_sale_id=? AND status!='cancelled'
        `).get(originalSaleId).total || 0;
        const availableCredit = round2(Math.max(0, Number(original.total || 0) - Number(activeCredits || 0)));
        if (requestedAmount > availableCredit + 0.005) {
          throw new Error(
            `El importe supera el saldo disponible para acreditar. Disponible: RD$${availableCredit.toFixed(2)}`
          );
        }
        total = requestedAmount;
        const originalTotal = Number(original.total || 0);
        const originalTax = Math.max(0, Number(original.tax_amt || 0));
        taxAmt = originalTotal > 0 ? round2(total * (originalTax / originalTotal)) : 0;
        subtotal = round2(total - taxAmt);
        preparedReturnItems.push({
          product_id: null,
          product_code: 'AJUSTE',
          product_name: String(monetaryLabel || 'Descuento o ajuste monetario posterior').trim().slice(0, 180),
          unit_cost: 0,
          unit_price: total,
          qty: 1,
          taxable: taxAmt > 0 ? 1 : 0,
          tax_pct: taxPct,
          net_subtotal: subtotal,
          tax_amt: taxAmt,
        });
      } else if (hasIncludedTaxSnapshot) {
        // Las líneas modernas guardan el neto/ITBIS DESPUÉS del descuento.
        // Reembolsar por esos snapshots evita devolver el precio completo de una
        // factura que originalmente tuvo descuento.
        subtotal = 0;
        taxAmt = 0;
        for (const item of preparedReturnItems) {
          const orig = originalItems.find(oi => _returnLineKey(oi) === _returnLineKey(item));
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
          cajero, user_id, notes, original_sale_id,
          original_sale_date,sale_date,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
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
        originalSaleId,
        db.prepare("SELECT date('now','localtime') value").get().value,
        db.prepare("SELECT date('now','localtime') value").get().value
      );
      const returnId = retR.lastInsertRowid;
      const returnDocument = _issueDocumentNumber('nota_credito', 'sale', returnId);
      db.prepare(`
        UPDATE sales
        SET document_kind='nota_credito',document_number=?,document_number_fmt=?,
            correction_kind=?
        WHERE id=?
      `).run(
        returnDocument.sequence_number,
        returnDocument.formatted_number,
        isMonetaryCredit ? 'monetary_credit' : '',
        returnId
      );
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

        // Una nota monetaria documenta un descuento/error de importe: nunca crea
        // una entrada ficticia de mercancía. Solo las devoluciones físicas reponen.
        if (!isMonetaryCredit && item.product_id) {
          productsRepo.adjustStock(
            item.product_id, +item.qty, 'devolucion',
            `Devolución de venta #${originalSaleId}`, returnId, user.id
          );
        }
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

      // 7. Distribuir el reembolso según el pago real. En pagos mixtos se conserva
      // la proporción efectivo/no efectivo de la venta original: solo la parte
      // efectiva sale físicamente de caja y el resto vuelve a la cuenta financiera.
      let cashRefundBase = original.payment_method === 'efectivo' ? total : 0;
      let financialRefundBase = original.financial_account_id && original.payment_method !== 'credito'
        ? total : 0;
      if (original.payment_method === 'mixto') {
        const mix = db.prepare(`
          SELECT LOWER(COALESCE(method,'efectivo')) method,COALESCE(SUM(amount),0) amount
          FROM cash_movements
          WHERE type='venta' AND reference_id=?
          GROUP BY LOWER(COALESCE(method,'efectivo'))
        `).all(originalSaleId);
        const cashPaid = mix
          .filter(row => row.method === 'efectivo')
          .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const paidTotal = mix.reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const cashRatio = paidTotal > 0 ? Math.max(0, Math.min(1, cashPaid / paidTotal)) : 0;
        cashRefundBase = round2(total * cashRatio);
        financialRefundBase = original.financial_account_id
          ? round2(total - cashRefundBase) : 0;
      }
      const actualReturnAccountAmount = returnCurrency === 'USD' && returnRate > 0
        ? round2(financialRefundBase / returnRate) : round2(financialRefundBase);
      if (original.financial_account_id) {
        db.prepare('UPDATE sales SET account_amount=? WHERE id=?')
          .run(actualReturnAccountAmount, returnId);
      }

      // Registrar movimiento de caja solo por el efectivo que realmente se entrega.
      if (session?.id && cashRefundBase > 0.005) {
        cashRepo.addMovement({
          sessionId: session.id,
          type: 'devolucion',
          amount: -cashRefundBase,
          method: 'efectivo',
          referenceId: returnId,
          description: `Devolución venta #${originalSaleId}`,
          userId: user.id,
        });
      }

      // Si el cobro original entró a una cuenta financiera, el reembolso sale de
      // la misma cuenta y en su misma moneda. Para USD se conserva la tasa histórica.
      if (original.financial_account_id && original.payment_method !== 'credito' && actualReturnAccountAmount > 0.005) {
        financialAccountsRepo.addMovement({
          accountId: original.financial_account_id,
          type: 'retiro',
          amount: -actualReturnAccountAmount,
          description: `Devolución #${returnId} · Venta #${originalSaleId}`,
          referenceType: 'return',
          referenceId: returnId,
          method: original.payment_method,
          notes: returnCurrency === 'USD'
            ? `Reembolso base RD$${financialRefundBase.toFixed(2)} · Tasa ${returnRate.toFixed(2)}` : '',
          userId: user.id,
        });
      }

      // 8. Marcar venta original como 'returned' solo si TODOS sus productos quedaron
      // completamente devueltos, sumando ESTA devolución con las anteriores (yaDevuelto).
      // Antes solo miraba los items de la tanda actual, así que devoluciones parciales
      // en varias tandas nunca marcaban la venta como devuelta.
      if (!isMonetaryCredit) {
        const currentReturn = new Map();
        for (const i of preparedReturnItems) {
          const key = _returnLineKey(i);
          currentReturn.set(key, (currentReturn.get(key) || 0) + i.qty);
        }
        const allReturned = originalItems.every(oi => {
          const key = _returnLineKey(oi);
          const totalDevuelto = (yaDevuelto.get(key) || 0) + (currentReturn.get(key) || 0);
          return totalDevuelto >= oi.qty;
        });
        if (allReturned) {
          db.prepare(`UPDATE sales SET status='returned' WHERE id=?`).run(originalSaleId);
        }
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
          ensureNcfAvailableNumbersTable();
          const hasSequence = db.prepare(`
            SELECT 1 FROM ncf_sequences s
            WHERE s.type='B04' AND s.active=1
              AND (s.expiry_date IS NULL OR TRIM(s.expiry_date)='' OR date(s.expiry_date)>=date('now','localtime'))
              AND (s.current<s.to_num OR EXISTS(
                SELECT 1 FROM ncf_available_numbers a
                WHERE a.sequence_id=s.id AND a.status='available'
              ))
            LIMIT 1
          `).get();
          if (hasSequence) {
            const allocation = allocateNextNcfNumber('B04', returnId);
            ncfNota = allocation.ncf;
            if (allocation.remaining <= 50) console.log('[NCF] ALERTA: quedan ' + allocation.remaining + ' notas de crédito B04');
          } else {
            console.warn('[NCF] Sin secuencia B04 registrada — nota de crédito #' + returnId +
              ' sin NCF. Registra un rango B04 en el Panel NCF.');
          }
          if (ncfNota) {
            db.prepare(`
              UPDATE sales
              SET ncf=?,fiscal_issued_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
              WHERE id=?
            `).run(ncfNota, returnId);
            db.prepare("INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc,modifies_ncf) VALUES(?,?,?,?,?)")
              .run(ncfNota, 'B04', returnId, original.customer_rnc || '', String(original.ncf).trim());
          }
        }
      }

      // 9. Auditoría
      audit(
        user.id,
        user.name,
        isMonetaryCredit ? 'nota_credito_monetaria_emitida' : 'devolucion_procesada',
        'sales',
        returnId,
        `Venta original #${originalSaleId} | ${isMonetaryCredit ? 'Crédito monetario' : 'Total devuelto'}: ${total} | ` +
          `Items: ${preparedReturnItems.length} | Inventario: ${isMonetaryCredit ? 'sin movimiento' : 'repuesto'}` +
          `${ncfNota ? ' | NC B04: ' + ncfNota : ''}`
      );

      return {
        returnId, total, subtotal, taxAmt, overpayment,
        creditKind: isMonetaryCredit ? 'monetary' : 'product_return',
        inventoryMoved: !isMonetaryCredit,
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
      const isMonetaryCredit = ret.correction_kind === 'monetary_credit';
      if (!isMonetaryCredit) {
        for (const item of items) {
          if (!item.product_id) continue;
          const product = db.prepare('SELECT stock,name FROM products WHERE id=?').get(item.product_id);
          if (!product) throw new Error(`Producto ID ${item.product_id} no existe`);
          if ((product.stock || 0) < (item.qty || 0)) {
            throw new Error(
              `No se puede anular: el inventario de "${product.name}" ya fue utilizado. ` +
              `Disponible: ${product.stock || 0}; requerido: ${item.qty || 0}.`
            );
          }
        }
      }

      // La devolución repuso existencias; al anularla se retiran nuevamente.
      if (!isMonetaryCredit) {
        for (const item of items) {
          if (!item.product_id) continue;
          productsRepo.adjustStock(
            item.product_id, -item.qty, 'salida',
            `Anulación devolución #${returnId} de venta #${ret.original_sale_id}`,
            returnId, userId
          );
        }
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
      const originalItems = db.prepare('SELECT product_id,product_code,product_name,qty FROM sale_items WHERE sale_id=?').all(original.id);
      const activeReturned = db.prepare(`
        SELECT si.product_id,si.product_code,si.product_name,COALESCE(SUM(si.qty),0) qty
        FROM sales s JOIN sale_items si ON si.sale_id=s.id
        WHERE s.type='devolucion' AND s.original_sale_id=? AND s.status!='cancelled'
        GROUP BY si.product_id,si.product_code,si.product_name
      `).all(original.id);
      const returnedByProduct = new Map(activeReturned.map(r => [_returnLineKey(r), r.qty || 0]));
      const stillFullyReturned = originalItems.length > 0 && originalItems.every(i =>
        (returnedByProduct.get(_returnLineKey(i)) || 0) >= i.qty
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
        receiveRows.push({ ...poItem, qty_received: qtyReceived, units: raw.units });
      }

      if (!receiveRows.length) throw new Error('Ingresa al menos una cantidad a recibir');

      // Prevalidar el lote completo antes de tocar compras, stock o costos. En
      // productos serializados la cantidad física se deriva exclusivamente de
      // product_units: una recepción sin sus IMEI/seriales nunca es válida.
      const identifiersInReceipt = new Set();
      for (const row of receiveRows) {
        const product = row.product_id
          ? db.prepare('SELECT * FROM products WHERE id=?').get(Number(row.product_id))
          : null;
        if (!product) throw new Error(`Producto no encontrado para ${row.product_name}`);
        row.product = product;
        const suppliedUnits = Array.isArray(row.units) ? row.units : [];
        if (!product.serialized) {
          if (suppliedUnits.length) throw new Error(`${row.product_name} no está configurado como producto serializado`);
          row.cleanUnits = [];
          continue;
        }
        if (suppliedUnits.length !== row.qty_received) {
          throw new Error(`${row.product_name}: debes registrar exactamente ${row.qty_received} IMEI/serial(es)`);
        }
        row.cleanUnits = suppliedUnits.map((rawUnit, index) => {
          const unit = typeof rawUnit === 'string' ? { imei:rawUnit } : (rawUnit || {});
          const imei = String(unit.imei || '').trim();
          const serial = String(unit.serial || '').trim();
          if (!imei && !serial) throw new Error(`${row.product_name}: la unidad ${index + 1} no tiene IMEI ni serial`);
          for (const identifier of [imei, serial].filter(Boolean)) {
            const key = identifier.toUpperCase();
            if (identifiersInReceipt.has(key)) throw new Error(`El IMEI o serial ${identifier} está repetido en la recepción`);
            identifiersInReceipt.add(key);
            if (productUnitsRepo.findByImei(identifier)) throw new Error(`El IMEI o serial ${identifier} ya está registrado`);
          }
          return {
            ...unit,
            product_id:product.id,
            imei:imei || null,
            serial:serial || null,
            condition:unit.condition || product.condition || 'nuevo',
          };
        });
      }

      const allocation = allocatePurchaseCosts(receiveRows, costs);
      for (const item of allocation.items) {
        const sourceRow = receiveRows.find(row => Number(row.id) === Number(item.id));
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
          const prodActual = sourceRow?.product || db.prepare(`SELECT * FROM products WHERE id=?`).get(item.product_id);

          const stockActual   = prodActual?.serialized
            ? productUnitsRepo.countInStock(item.product_id)
            : (prodActual?.stock || 0);
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

          // 3. Crear las unidades o ajustar stock fungible. Nunca se ejecutan
          // ambos caminos para evitar duplicar existencias.
          const reason = `Recepción OC #${id} | Base: ${item.unit_cost} | Gastos: ${item.allocatedExtra} | Costo real: ${costoNuevo} | Promedio: ${costoPromedio}`;
          if (prodActual?.serialized) {
            for (const unit of (sourceRow?.cleanUnits || [])) {
              productUnitsRepo.create({
                ...unit,
                unit_cost:costoNuevo,
                purchase_order_id:Number(id),
                purchase_item_id:Number(item.id),
                supplier_id:Number(po.supplier_id) || null,
                notes:[unit.notes, `Recibido en OC #${id}`].filter(Boolean).join(' · '),
              });
            }
          } else {
            productsRepo.adjustStock(
              item.product_id, item.qty_received, 'entrada',
              reason,
              null, userId
            );
          }

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

        // Si la compra nació de una pieza faltante del taller, la recepción
        // alimenta su estado con la misma transacción.
        if (item.service_procurement_request_id) {
          const request = db.prepare('SELECT * FROM service_procurement_requests WHERE id=?')
            .get(Number(item.service_procurement_request_id));
          if (request && request.status !== 'cancelada') {
            const received = Math.min(Number(request.qty_requested), Number(request.qty_received || 0) + Number(item.qty_received));
            const status = received >= Number(request.qty_requested) ? 'recibida' : 'parcial';
            db.prepare(`UPDATE service_procurement_requests SET qty_received=?,status=?,updated_at=datetime('now','localtime') WHERE id=?`)
              .run(received, status, request.id);
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

// ══════════════════════════════════════════════
// VELO TECH POS · Descripciones y compra directa de equipos usados
// ══════════════════════════════════════════════
const techDescriptionTemplatesRepo = {
  list() {
    return db.prepare(`SELECT * FROM tech_description_templates WHERE active=1 ORDER BY name,id`).all();
  },
  save(data = {}, userId = null) {
    const name = String(data.name || '').trim().slice(0,120);
    const description = String(data.description || '').trim().slice(0,1000);
    if (!name || !description) throw new Error('Nombre y descripción son obligatorios');
    if (Number(data.id)) {
      const result = db.prepare(`UPDATE tech_description_templates SET name=?,description=?,
        updated_at=datetime('now','localtime') WHERE id=? AND active=1`).run(name, description, Number(data.id));
      if (!result.changes) throw new Error('Descripción guardada no encontrada');
      return Number(data.id);
    }
    return Number(db.prepare(`INSERT INTO tech_description_templates(name,description,created_by)
      VALUES(?,?,?)`).run(name, description, Number(userId) || null).lastInsertRowid);
  },
  remove(id) {
    const result = db.prepare(`UPDATE tech_description_templates SET active=0,
      updated_at=datetime('now','localtime') WHERE id=?`).run(Number(id));
    if (!result.changes) throw new Error('Descripción guardada no encontrada');
    return { ok:true };
  },
};

const techPrivatePurchasesRepo = {
  list({ limit = 200 } = {}) {
    return db.prepare(`SELECT tp.*,p.code product_code,p.name product_name,u.status unit_status
      FROM tech_private_purchases tp
      JOIN products p ON p.id=tp.product_id
      JOIN product_units u ON u.id=tp.product_unit_id
      ORDER BY tp.id DESC LIMIT ?`).all(Math.max(1,Math.min(1000,Number(limit)||200)));
  },
  getById(id) {
    return db.prepare(`SELECT tp.*,p.code product_code,p.name product_name,u.status unit_status,
      u.warranty_until,u.notes unit_notes,fa.name financial_account_name,cs.cajero cash_session_user
      FROM tech_private_purchases tp
      JOIN products p ON p.id=tp.product_id
      JOIN product_units u ON u.id=tp.product_unit_id
      LEFT JOIN financial_accounts fa ON fa.id=tp.financial_account_id
      LEFT JOIN cash_sessions cs ON cs.id=tp.cash_session_id
      WHERE tp.id=?`).get(Number(id)) || null;
  },
  create(data = {}, user = {}, cashSession = null) {
    const sellerName = String(data.seller_name || '').trim();
    const sellerDocument = String(data.seller_document || '').trim();
    const sellerPhone = String(data.seller_phone || '').trim();
    const sellerAddress = String(data.seller_address || '').trim();
    const physicalCondition = String(data.physical_condition || '').trim();
    const sellerSignature = String(data.seller_signature_name || '').trim();
    const businessSignature = String(data.business_signature_name || '').trim();
    const imei = String(data.imei || '').trim();
    const serial = String(data.serial || '').trim();
    const amount = round2(Number(data.amount) || 0);
    if (!sellerName || !sellerDocument || !sellerPhone || !sellerAddress) {
      throw new Error('Nombre, documento, teléfono y dirección del vendedor son obligatorios');
    }
    if (!imei && !serial) throw new Error('El equipo necesita IMEI o serial');
    if (!physicalCondition) throw new Error('Documenta la condición física del equipo');
    if (amount <= 0) throw new Error('El precio de compra debe ser mayor a cero');
    if (!data.ownership_declared || !data.lawful_origin_declared) {
      throw new Error('El vendedor debe aceptar las declaraciones de propiedad y procedencia');
    }
    if (!sellerSignature || !businessSignature) throw new Error('Registra los nombres de ambas firmas');
    const product = db.prepare(`SELECT * FROM products WHERE id=? AND active=1`).get(Number(data.product_id));
    if (!product) throw new Error('Producto o modelo no encontrado');
    if (!product.serialized) throw new Error('El producto debe estar controlado por IMEI/serial');
    if (productUnitsRepo.findByImei(imei || serial)) throw new Error('Ese IMEI o serial ya está registrado');
    const paymentMethod = ['efectivo','transferencia','cheque'].includes(String(data.payment_method))
      ? String(data.payment_method) : 'efectivo';
    let account = null;
    if (paymentMethod === 'efectivo') {
      if (!cashSession?.id || cashSession.status !== 'open') throw new Error('Abre la caja antes de pagar una compra en efectivo');
    } else {
      account = db.prepare(`SELECT * FROM financial_accounts WHERE id=? AND active=1`).get(Number(data.financial_account_id));
      if (!account || account.type !== 'banco') throw new Error('Selecciona una cuenta bancaria activa para realizar el pago');
    }
    const terms = String(data.terms_snapshot || settingsRepo.get('tech_private_purchase_terms') || '').trim();
    if (!terms) throw new Error('Configura los términos de compra a particulares');
    const result = db.transaction(() => {
      const unitId = Number(productUnitsRepo.create({
        product_id:product.id, imei:imei || null, serial:serial || null,
        condition:'usado', status:'en_stock', unit_cost:amount,
        color:String(data.color || '').trim(), capacity:String(data.capacity || '').trim(),
        battery_health:data.battery_health, battery_capacity_mah:data.battery_capacity_mah,
        sale_description:String(data.sale_description || '').trim(),
        notes:`COMPRA DIRECTA A ${sellerName} · DOC. ${sellerDocument}`,
      }));
      const next = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM tech_private_purchases').get().n || 1);
      const number = `CPU-${String(next).padStart(6,'0')}`;
      const info = db.prepare(`INSERT INTO tech_private_purchases(
        number,seller_name,seller_document,seller_phone,seller_address,seller_email,
        product_id,product_unit_id,device_name,brand,model,imei,serial,color,capacity,
        battery_health,battery_capacity_mah,physical_condition,sale_description,accessories,
        amount,payment_method,payment_reference,financial_account_id,cash_session_id,terms_snapshot,
        ownership_declared,lawful_origin_declared,seller_signature_name,business_signature_name,created_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        number,sellerName,sellerDocument,sellerPhone,sellerAddress,String(data.seller_email||'').trim(),
        product.id,unitId,String(data.device_name||product.name).trim(),String(data.brand||product.brand||'').trim(),
        String(data.model||product.model||'').trim(),imei,serial,String(data.color||'').trim(),String(data.capacity||'').trim(),
        data.battery_health===''||data.battery_health==null?null:Math.max(0,Math.min(100,Number.parseInt(data.battery_health,10)||0)),
        data.battery_capacity_mah===''||data.battery_capacity_mah==null?null:Math.max(0,Math.min(100000,Number.parseInt(data.battery_capacity_mah,10)||0)),
        physicalCondition,String(data.sale_description||'').trim(),
        JSON.stringify(Array.isArray(data.accessories)?data.accessories:[]),amount,paymentMethod,
        String(data.payment_reference||'').trim(),account?.id||null,cashSession?.id||null,terms,1,1,
        sellerSignature,businessSignature,Number(user.id)||null
      );
      const purchaseId = Number(info.lastInsertRowid);
      db.prepare(`UPDATE product_units SET notes=notes||? WHERE id=?`).run(` · ${number}`,unitId);
      if (paymentMethod === 'efectivo') {
        cashRepo.addMovement({ sessionId:cashSession.id,type:'salida',amount,method:'efectivo',
          referenceId:purchaseId,description:`Compra equipo usado ${number}`,userId:user.id });
        db.prepare('UPDATE cash_sessions SET expected=expected-? WHERE id=?').run(amount,cashSession.id);
      } else {
        // Reutiliza el tipo financiero canónico de salida para no ampliar el
        // CHECK histórico. reference_type mantiene la naturaleza exacta.
        financialAccountsRepo.addMovement({ accountId:account.id,type:'pago_proveedor',amount:-amount,
          description:`Compra equipo usado ${number}`,referenceType:'tech_private_purchase',
          referenceId:purchaseId,method:paymentMethod,notes:String(data.payment_reference||''),userId:user.id });
      }
      audit(user.id,user.name,'compra_equipo_usado','tech_private_purchases',purchaseId,
        `${number} · ${imei||serial} · RD$${amount.toFixed(2)}`);
      return { purchaseId, unitId, number };
    })();
    accountingRepo.generatePrivatePurchaseEntry({ purchaseId:result.purchaseId, userId:user.id });
    return { ...result, data:this.getById(result.purchaseId) };
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
    'Servicios profesionales': ['Contabilidad','Abogados','Consultorías','Comisiones externas'],
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
      LEFT JOIN users u ON ep.user_id=u.id WHERE ep.expense_id=? ORDER BY ep.created_at,ep.id`).all(id);
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
      from_cash:   value(`SELECT COALESCE(SUM(ep.amount),0) as v
        FROM expense_payments ep
        JOIN expenses e ON e.id=ep.expense_id
        WHERE ${baseWhere} AND ep.status='pagado' AND ep.payment_source='caja'`),
      count:       value(`SELECT COUNT(*) as v FROM expenses e WHERE ${baseWhere}`),
      by_category: db.prepare(`SELECT ec.name, COALESCE(SUM(e.total),0) as total FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE ${baseWhere} GROUP BY e.category_id ORDER BY total DESC LIMIT 8`).all(...params),
    };
  },

  // ── Crear gasto ──────────────────────────
  create({ type, category_id, description, supplier_id, beneficiary_name, beneficiary_document,
           beneficiary_phone, amount, tax_amount, discount, total,
           currency, payment_method, payment_source, cash_session_id, issue_date, due_date,
           invoice_number, ncf, supplier_rnc, notes, user_id, status }) {
    const beneficiaryName = String(beneficiary_name || '').trim().slice(0, 120);
    const beneficiaryDocument = String(beneficiary_document || '').trim().slice(0, 40);
    const beneficiaryPhone = String(beneficiary_phone || '').trim().slice(0, 40);
    const r = db.prepare(`
      INSERT INTO expenses(type,category_id,description,supplier_id,beneficiary_name,beneficiary_document,
        beneficiary_phone,amount,tax_amount,discount,total,
        currency,payment_method,payment_source,cash_session_id,issue_date,due_date,
        invoice_number,ncf,supplier_rnc,notes,user_id,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(type||'gasto', category_id||null, description, supplier_id||null,
           beneficiaryName, beneficiaryDocument, beneficiaryPhone,
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
      const beneficiaryName = String(expense.beneficiary_name || '').trim();
      const beneficiaryDocument = String(expense.beneficiary_document || '').trim();
      const beneficiaryPhone = String(expense.beneficiary_phone || '').trim();
      const payRow = db.prepare(`INSERT INTO expense_payments(expense_id,amount,payment_method,payment_source,
        cash_session_id,cash_movement_id,reference,notes,beneficiary_name,beneficiary_document,
        beneficiary_phone,user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(expenseId, amount, payment_method||'efectivo',
        payment_source||'caja', cash_session_id||null, cashMovementId, reference||null, notes||null,
        beneficiaryName, beneficiaryDocument, beneficiaryPhone, userId);
      const paymentId = payRow.lastInsertRowid;
      const documentKind = beneficiaryName ? 'pago_gasto_externo' : 'pago_proveedor';
      const documentIssue = _issueDocumentNumber(documentKind, 'expense_payment', paymentId);
      db.prepare(`
        UPDATE expense_payments
        SET document_kind=?,document_number=?,document_number_fmt=?
        WHERE id=?
      `).run(documentKind, documentIssue.sequence_number, documentIssue.formatted_number, paymentId);

      // Actualizar gasto
      const newPaid = expense.paid_amount + amount;
      const newStatus = newPaid >= expense.total - 0.01 ? 'pagado' : 'parcialmente_pagado';
      // Pagar = aprobado automático: si el gasto aún no estaba aprobado, el pago lo
      // aprueba (lo hace un admin, que tiene la autoridad). No sobreescribe si ya
      // tenía aprobador. Elimina el paso previo de "Aprobar" para poder pagar.
      db.prepare(`UPDATE expenses SET paid_amount=?,status=?,
        approved_by=COALESCE(approved_by,?), approved_at=COALESCE(approved_at,datetime('now')),
        updated_at=datetime('now'),payment_method=?,payment_source=?,
        cash_session_id=?,cash_movement_id=? WHERE id=?`)
        .run(newPaid, newStatus, userId||null, payment_method||expense.payment_method,
          payment_source||expense.payment_source, cash_session_id||expense.cash_session_id,
          cashMovementId||expense.cash_movement_id, expenseId);

      audit(userId, userName||'', 'gasto_pagado', 'expenses', expenseId,
        `Pago: RD$${amount} | Método: ${payment_method} | Estado: ${newStatus}${expense.approved_by ? '' : ' | Aprobado al pagar'}`);
      return {
        ok: true, newStatus, newPaid, cashMovementId, paymentId,
        documentKind,
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
    let custBranch = null;
    if (data.customer_branch_id && data.customer_id) {
      custBranch = db.prepare(`SELECT * FROM customer_branches WHERE id=? AND customer_id=? AND active=1`)
        .get(data.customer_branch_id, data.customer_id);
      if (!custBranch) throw new Error('La sucursal no pertenece a la empresa o está inactiva');
    }
    return db.prepare(`INSERT INTO deliveries(
      sale_id,customer_id,customer_name,customer_contact_id,customer_contact_name,
      customer_contact_role,customer_contact_phone,
      customer_branch_id,customer_branch_name,customer_branch_code,customer_branch_address,customer_branch_phone,
      vehicle_id,driver_id,
      origin_address,dest_address,dest_lat,dest_lng,distance_km,fuel_used,fuel_cost,
      delivery_fee,delivery_type,carrier_name,carrier_stop,carrier_tracking,carrier_dest,
      status,scheduled_at,notes,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.sale_id||null, data.customer_id||null, String(data.customer_name||'').trim(),
      contact?.id || null, contact?.name || '', contact?.role || '', contact?.phone || '',
      custBranch?.id || null, custBranch?.name || '', custBranch?.code || '', custBranch?.address || '', custBranch?.phone || '',
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
function ensureNcfRecoveryAuditTable() {
  ensureNcfAvailableNumbersTable();
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
    )
  `);
}

function ncfRecoveryFingerprint(sequence, rows, conflicts) {
  const payload = {
    sequence: {
      id: Number(sequence.id), type: sequence.type,
      from: Number(sequence.from_num), to: Number(sequence.to_num),
      current: Number(sequence.current),
    },
    rows: rows.map(row => ({
      saleId: Number(row.sale_id), logId: Number(row.log_id) || null,
      old: row.old_ncf, next: row.corrected_ncf,
    })),
    conflicts: conflicts.map(item => String(item.code || item.message || item)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function previewMalformedNcfRecovery(sequenceId) {
  const sequence = db.prepare('SELECT * FROM ncf_sequences WHERE id=?').get(Number(sequenceId));
  if (!sequence) throw new Error('La secuencia NCF no existe');
  const type = normalizeLegacyType(sequence.type);
  const sales = db.prepare(`
    SELECT id,ncf,status,customer_name,customer_rnc,total,created_at,cancelled_at
    FROM sales
    WHERE TRIM(COALESCE(ncf,''))<>'' AND UPPER(substr(TRIM(ncf),1,3))=?
    ORDER BY datetime(created_at),id
  `).all(type);
  const logsForSale = db.prepare(`
    SELECT id,ncf,type,status,issued_at,voided_at,modifies_ncf
    FROM ncf_log WHERE sale_id=? ORDER BY id
  `);
  const targetInSales = db.prepare("SELECT id FROM sales WHERE UPPER(TRIM(ncf))=? AND id<>? LIMIT 1");
  const targetInLog = db.prepare("SELECT id,sale_id FROM ncf_log WHERE UPPER(TRIM(ncf))=? AND id<>? LIMIT 1");
  const rows = [];
  const conflicts = [];
  const targetOwners = new Map();

  sales.forEach(sale => {
    const parsed = parseRecoverableDuplicatedTypeNcf(sale.ncf);
    if (!parsed || parsed.type !== type) return;
    if (parsed.sequence < Number(sequence.from_num) || parsed.sequence > Number(sequence.to_num)) {
      conflicts.push({
        code: `OUT_OF_RANGE:${sale.id}`,
        sale_id: sale.id,
        message: `${parsed.malformedNcf} pertenece al correlativo ${parsed.sequence}, fuera del rango autorizado`,
      });
      return;
    }
    const saleLogs = logsForSale.all(sale.id);
    const matchingLogs = saleLogs.filter(log => String(log.ncf || '').trim().toUpperCase() === parsed.malformedNcf);
    if (saleLogs.length && matchingLogs.length !== 1) {
      conflicts.push({
        code: `LOG_MISMATCH:${sale.id}`,
        sale_id: sale.id,
        message: `La factura #${sale.id} no tiene un único registro fiscal que coincida con ${parsed.malformedNcf}`,
      });
      return;
    }
    const log = matchingLogs[0] || null;
    const priorOwner = targetOwners.get(parsed.canonicalNcf);
    if (priorOwner) {
      conflicts.push({
        code: `DUPLICATE_TARGET:${sale.id}`,
        sale_id: sale.id,
        message: `${parsed.canonicalNcf} quedaría asignado a las facturas #${priorOwner} y #${sale.id}`,
      });
      return;
    }
    targetOwners.set(parsed.canonicalNcf, sale.id);
    const saleCollision = targetInSales.get(parsed.canonicalNcf, sale.id);
    const logCollision = targetInLog.get(parsed.canonicalNcf, log?.id || -1);
    if (saleCollision || logCollision) {
      conflicts.push({
        code: `TARGET_USED:${sale.id}`,
        sale_id: sale.id,
        message: `${parsed.canonicalNcf} ya está registrado en otro documento`,
      });
      return;
    }
    rows.push({
      sale_id: sale.id,
      log_id: log?.id || null,
      old_ncf: parsed.malformedNcf,
      corrected_ncf: parsed.canonicalNcf,
      sequence: parsed.sequence,
      status: sale.status,
      fiscal_status: log?.status || (sale.status === 'cancelled' ? 'anulado' : 'emitido'),
      issued_at: log?.issued_at || sale.created_at,
      customer_name: sale.customer_name || 'Consumidor Final',
      customer_rnc: sale.customer_rnc || '',
      total: Number(sale.total) || 0,
      reference_count: db.prepare("SELECT COUNT(*) c FROM ncf_log WHERE UPPER(TRIM(COALESCE(modifies_ncf,'')))=?")
        .get(parsed.malformedNcf).c,
    });
  });

  // Un registro fiscal huérfano o distinto de la factura no se corrige por
  // inferencia. Se muestra como conflicto para que soporte lo revise primero.
  db.prepare(`
    SELECT l.id,l.sale_id,l.ncf
    FROM ncf_log l LEFT JOIN sales s ON s.id=l.sale_id
    WHERE TRIM(COALESCE(l.ncf,''))<>'' AND UPPER(substr(TRIM(l.ncf),1,3))=?
      AND (s.id IS NULL OR UPPER(TRIM(COALESCE(s.ncf,'')))<>UPPER(TRIM(l.ncf)))
    ORDER BY l.id
  `).all(type).forEach(log => {
    const parsed = parseRecoverableDuplicatedTypeNcf(log.ncf);
    if (!parsed || parsed.sequence < Number(sequence.from_num) || parsed.sequence > Number(sequence.to_num)) return;
    conflicts.push({
      code: `ORPHAN_LOG:${log.id}`,
      sale_id: log.sale_id || null,
      message: `El registro fiscal #${log.id} (${parsed.malformedNcf}) no coincide con su factura`,
    });
  });

  rows.sort((a, b) => a.sequence - b.sequence || a.sale_id - b.sale_id);
  const recoveredNumbers = rows.map(row => row.sequence);
  const validNumbers = [
    ...db.prepare("SELECT ncf FROM sales WHERE length(TRIM(COALESCE(ncf,'')))=11 AND UPPER(substr(TRIM(ncf),1,3))=?").all(type),
    ...db.prepare("SELECT ncf FROM ncf_log WHERE length(TRIM(COALESCE(ncf,'')))=11 AND UPPER(substr(TRIM(ncf),1,3))=?").all(type),
  ].map(item => parseCanonicalLegacyNcf(item.ncf)).filter(Boolean)
    .map(item => item.sequence)
    .filter(value => value >= Number(sequence.from_num) && value <= Number(sequence.to_num));
  const occupied = [...new Set([...validNumbers, ...recoveredNumbers])].sort((a, b) => a - b);
  const lastIssued = occupied.length ? occupied[occupied.length - 1] : Number(sequence.from_num) - 1;
  const regularNextNumber = Math.min(Number(sequence.to_num) + 1, lastIssued + 1);
  const gaps = [];
  if (occupied.length) {
    const set = new Set(occupied);
    for (let value = Number(sequence.from_num); value < lastIssued; value++) {
      if (!set.has(value)) gaps.push(value);
    }
  }
  const preview = {
    sequence,
    rows,
    conflicts,
    recoverable_count: rows.length,
    conflict_count: conflicts.length,
    can_recover: rows.length > 0 && conflicts.length === 0,
    last_recovered_number: recoveredNumbers.length ? Math.max(...recoveredNumbers) : null,
    next_number: gaps.length ? gaps[0] : regularNextNumber,
    next_ncf: (gaps.length ? gaps[0] : regularNextNumber) <= Number(sequence.to_num)
      ? formatLegacyNcf(type, gaps.length ? gaps[0] : regularNextNumber) : null,
    regular_next_number: regularNextNumber,
    regular_next_ncf: regularNextNumber <= Number(sequence.to_num)
      ? formatLegacyNcf(type, regularNextNumber) : null,
    gaps,
  };
  preview.token = ncfRecoveryFingerprint(sequence, rows, conflicts);
  return preview;
}

const ncfRepo = {
  getSequences() {
    ensureNcfAvailableNumbersTable();
    return db.prepare(`
      SELECT s.*,
        COALESCE((SELECT COUNT(*) FROM ncf_available_numbers a
          WHERE a.sequence_id=s.id AND a.status='available'),0) available_gap_count,
        (SELECT MIN(a.sequence_number) FROM ncf_available_numbers a
          WHERE a.sequence_id=s.id AND a.status='available') next_gap_number
      FROM ncf_sequences s ORDER BY s.type,s.id
    `).all().map(sequence => {
      const regularNext = Number(sequence.current) + 1;
      const nextNumber = sequence.next_gap_number != null
        ? Number(sequence.next_gap_number) : regularNext;
      return {
        ...sequence,
        regular_next_number: regularNext,
        next_issue_number: nextNumber,
        next_issue_ncf: nextNumber <= Number(sequence.to_num)
          ? formatLegacyNcf(sequence.type, nextNumber) : null,
        remaining: Math.max(0, Number(sequence.to_num) - Number(sequence.current)) +
          Number(sequence.available_gap_count || 0),
      };
    });
  },
  getActive(type) { return db.prepare("SELECT * FROM ncf_sequences WHERE type=? AND active=1").get(type); },
  getSequenceUsage(id) {
    const sequence = db.prepare('SELECT * FROM ncf_sequences WHERE id=?').get(id);
    if (!sequence) throw new Error('La secuencia NCF no existe');
    const values = [
      ...db.prepare("SELECT ncf FROM sales WHERE length(TRIM(COALESCE(ncf,'')))=11 AND UPPER(substr(TRIM(ncf),1,3))=?").all(sequence.type),
      ...db.prepare("SELECT ncf FROM ncf_log WHERE length(TRIM(COALESCE(ncf,'')))=11 AND UPPER(substr(TRIM(ncf),1,3))=?").all(sequence.type),
    ].map(row => parseCanonicalLegacyNcf(row.ncf)).filter(Boolean)
      .map(item => item.sequence)
      .filter(value => value >= sequence.from_num && value <= sequence.to_num);
    const unique = [...new Set(values)].sort((a, b) => a - b);
    return {
      sequence,
      issuedCount: unique.length,
      firstIssued: unique[0] || null,
      lastIssued: unique.length ? unique[unique.length - 1] : null,
    };
  },
  previewMalformedRecovery(id) {
    return previewMalformedNcfRecovery(id);
  },
  recoverMalformedDocuments({ id, preview_token, reason }) {
    const before = previewMalformedNcfRecovery(id);
    if (!before.can_recover) {
      if (!before.rows.length) throw new Error('No hay facturas con el patrón recuperable en esta secuencia');
      throw new Error('La recuperación está bloqueada porque existen conflictos que requieren revisión');
    }
    if (!preview_token || preview_token !== before.token) {
      throw new Error('Los datos fiscales cambiaron desde la vista previa. Revísalos nuevamente antes de confirmar');
    }
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 10) throw new Error('Explica el motivo de la recuperación (mínimo 10 caracteres)');
    ensureNcfRecoveryAuditTable();
    const auditChange = db.prepare(`
      INSERT OR IGNORE INTO ncf_normalization_log
        (source_table,source_id,field_name,old_value,new_value,reason)
      VALUES(?,?,?,?,?,?)
    `);
    const result = db.transaction(() => {
      let references = 0;
      const queuedGaps = [];
      for (const row of before.rows) {
        const currentSale = db.prepare('SELECT ncf FROM sales WHERE id=?').get(row.sale_id);
        if (String(currentSale?.ncf || '').trim().toUpperCase() !== row.old_ncf) {
          throw new Error(`La factura #${row.sale_id} cambió durante la recuperación`);
        }
        db.prepare("UPDATE sales SET ncf=?,updated_at=datetime('now','localtime') WHERE id=?")
          .run(row.corrected_ncf, row.sale_id);
        auditChange.run('sales', row.sale_id, 'ncf', row.old_ncf, row.corrected_ncf,
          `Recuperación fiscal confirmada: ${cleanReason}`);

        if (row.log_id) {
          const changed = db.prepare('UPDATE ncf_log SET ncf=? WHERE id=? AND UPPER(TRIM(ncf))=?')
            .run(row.corrected_ncf, row.log_id, row.old_ncf);
          if (changed.changes !== 1) throw new Error(`El registro fiscal de la factura #${row.sale_id} cambió`);
          auditChange.run('ncf_log', row.log_id, 'ncf', row.old_ncf, row.corrected_ncf,
            `Recuperación fiscal confirmada: ${cleanReason}`);
        } else {
          const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(row.sale_id);
          const inserted = db.prepare(`
            INSERT INTO ncf_log(ncf,type,sale_id,customer_rnc,issued_at,status,voided_at)
            VALUES(?,?,?,?,?,?,?)
          `).run(
            row.corrected_ncf, before.sequence.type, row.sale_id, sale.customer_rnc || '',
            sale.fiscal_issued_at || sale.created_at,
            sale.status === 'cancelled' ? 'anulado' : 'emitido',
            sale.status === 'cancelled' ? (sale.cancelled_at || sale.created_at) : null
          );
          auditChange.run('ncf_log', Number(inserted.lastInsertRowid), 'ncf', row.old_ncf, row.corrected_ncf,
            `Registro fiscal reconstruido durante recuperación: ${cleanReason}`);
        }

        const referenceRows = db.prepare("SELECT id FROM ncf_log WHERE UPPER(TRIM(COALESCE(modifies_ncf,'')))=?")
          .all(row.old_ncf);
        referenceRows.forEach(reference => {
          db.prepare('UPDATE ncf_log SET modifies_ncf=? WHERE id=?').run(row.corrected_ncf, reference.id);
          auditChange.run('ncf_log', reference.id, 'modifies_ncf', row.old_ncf, row.corrected_ncf,
            `Referencia fiscal recuperada: ${cleanReason}`);
          references++;
        });
      }
      db.prepare('UPDATE ncf_sequences SET current=? WHERE id=?')
        .run(before.regular_next_number - 1, Number(id));
      const insertGap = db.prepare(`
        INSERT OR IGNORE INTO ncf_available_numbers(
          sequence_id,ncf_type,sequence_number,status,source
        ) VALUES(?,?,?,'available','malformed_ncf_recovery')
      `);
      before.gaps.forEach(sequenceNumber => {
        const canonical = formatLegacyNcf(before.sequence.type, sequenceNumber);
        const occupied = db.prepare(`
          SELECT 1 FROM sales WHERE UPPER(TRIM(COALESCE(ncf,'')))=?
          UNION ALL
          SELECT 1 FROM ncf_log WHERE UPPER(TRIM(COALESCE(ncf,'')))=?
          LIMIT 1
        `).get(canonical, canonical);
        if (occupied) throw new Error(`${canonical} ya no está disponible; revisa nuevamente la recuperación`);
        const inserted = insertGap.run(Number(id), before.sequence.type, sequenceNumber);
        const available = db.prepare(`
          SELECT id,status FROM ncf_available_numbers
          WHERE ncf_type=? AND sequence_number=?
        `).get(before.sequence.type, sequenceNumber);
        if (!available || available.status !== 'available') {
          throw new Error(`${canonical} no puede agregarse a la cola de comprobantes disponibles`);
        }
        if (inserted.changes) {
          queuedGaps.push(canonical);
          auditChange.run(
            'ncf_available_numbers', Number(available.id), 'status', 'gap_detected', 'available',
            `Correlativo saltado conservado para emisión posterior: ${cleanReason}`
          );
        }
      });
      return {
        recovered: before.rows.length, references, rows: before.rows,
        queued_gaps: queuedGaps,
      };
    })();
    const after = previewMalformedNcfRecovery(id);
    const nextGap = db.prepare(`
      SELECT sequence_number FROM ncf_available_numbers
      WHERE sequence_id=? AND status='available'
      ORDER BY sequence_number LIMIT 1
    `).get(Number(id));
    const regularNext = Number(after.sequence.current) + 1;
    return {
      ...result,
      sequence: after.sequence,
      next_number: nextGap ? Number(nextGap.sequence_number) : regularNext,
      next_ncf: nextGap
        ? formatLegacyNcf(after.sequence.type, Number(nextGap.sequence_number))
        : Number(after.sequence.current) < Number(after.sequence.to_num)
          ? formatLegacyNcf(after.sequence.type, regularNext)
          : null,
      regular_next_number: regularNext,
      regular_next_ncf: Number(after.sequence.current) < Number(after.sequence.to_num)
        ? formatLegacyNcf(after.sequence.type, regularNext)
        : null,
    };
  },
  updateSequence({ id, next_number, expiry_date, alert_at, active }) {
    const usage = this.getSequenceUsage(id);
    const sequence = usage.sequence;
    const next = normalizeLegacySequenceNumber(sequence.type, next_number);
    if (next < sequence.from_num || next > sequence.to_num + 1) {
      throw new Error(
        `El próximo NCF debe estar entre ${formatLegacyNcf(sequence.type, sequence.from_num)} ` +
        `y ${formatLegacyNcf(sequence.type, sequence.to_num)} (o uno después si el rango se agotó)`
      );
    }
    if (usage.lastIssued != null && next <= usage.lastIssued) {
      throw new Error(
        `No se puede reutilizar un NCF ya emitido. El último válido registrado es ${formatLegacyNcf(sequence.type, usage.lastIssued)}`
      );
    }
    const nextActive = active === undefined ? Number(sequence.active) : (active ? 1 : 0);
    if (nextActive) {
      const other = db.prepare(`
        SELECT id FROM ncf_sequences
        WHERE id<>? AND type=? AND active=1
          AND NOT(to_num < ? OR from_num > ?) LIMIT 1
      `).get(id, sequence.type, sequence.from_num, sequence.to_num);
      if (other) throw new Error(`Otra secuencia activa (#${other.id}) utiliza este rango`);
    }
    const alert = Math.max(1, Number.parseInt(alert_at, 10) || Number(sequence.alert_at) || 50);
    db.prepare(`
      UPDATE ncf_sequences
      SET current=?,expiry_date=?,alert_at=?,active=?
      WHERE id=?
    `).run(next - 1, expiry_date || null, alert, nextActive, id);
    return this.getSequenceUsage(id);
  },
  removeSequence(id) {
    const usage = this.getSequenceUsage(id);
    if (usage.issuedCount === 0) {
      db.prepare('DELETE FROM ncf_sequences WHERE id=?').run(id);
      return { deleted: true, deactivated: false, usage };
    }
    db.prepare('UPDATE ncf_sequences SET active=0 WHERE id=?').run(id);
    return { deleted: false, deactivated: true, usage };
  },
  createSequence({ type, prefix, from_num, to_num, expiry_date, alert_at }) {
    const cleanType = normalizeLegacyType(type);
    const cleanPrefix = String(prefix || cleanType).trim().toUpperCase();
    if (cleanPrefix !== cleanType) {
      throw new Error(`El prefijo fiscal debe ser ${cleanType}; no puede modificarse`);
    }
    const { from, to } = normalizeLegacySequenceRange(cleanType, from_num, to_num);
    const overlap = db.prepare(`
      SELECT id,from_num,to_num FROM ncf_sequences
      WHERE type=? AND NOT(to_num < ? OR from_num > ?) LIMIT 1
    `).get(cleanType, from, to);
    if (overlap) {
      throw new Error(`El rango se cruza con la secuencia #${overlap.id} (${overlap.from_num}-${overlap.to_num})`);
    }
    const maxIssued = db.prepare("SELECT ncf FROM sales WHERE ncf LIKE ? AND length(TRIM(ncf))=11")
      .all(`${cleanType}%`)
      .map(row => parseCanonicalLegacyNcf(row.ncf))
      .filter(Boolean)
      .map(row => row.sequence)
      .filter(sequence => sequence >= from && sequence <= to)
      .reduce((max, sequence) => Math.max(max, sequence), 0);
    const current = Math.max(from - 1, maxIssued);
    return db.prepare('INSERT INTO ncf_sequences(type,prefix,from_num,to_num,current,expiry_date,alert_at) VALUES(?,?,?,?,?,?,?)')
      .run(cleanType, cleanType, from, to, current, expiry_date||null, alert_at||50).lastInsertRowid;
  },
  getNext(type) {
    return db.transaction(() => allocateNextNcfNumber(type))();
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
    return this.getSequences()
      .filter(sequence => sequence.active && sequence.remaining <= sequence.alert_at)
      .sort((a, b) => a.remaining - b.remaining);
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
    return db.prepare(q).all(...p).map(row => {
      const parsed = parseCanonicalLegacyNcf(row.ncf);
      return {
        ...row,
        ncf_valid: !!parsed && parsed.type === row.type,
        ncf_issue: parsed && parsed.type === row.type
          ? ''
          : 'NCF tradicional inválido: debe tener tipo B autorizado y exactamente 8 dígitos correlativos',
      };
    });
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
      let advancesAcc = db.prepare("SELECT id FROM accounting_accounts WHERE code='2103'").get();
      if (!advancesAcc) {
        const parent = db.prepare("SELECT id FROM accounting_accounts WHERE code='21'").get();
        const created = db.prepare(`INSERT INTO accounting_accounts(code,name,type,subtype,parent_id,description,is_summary,active)
          VALUES('2103','Anticipos de Clientes','pasivo','anticipo',?,'Pagos recibidos antes de facturar',0,1)`).run(parent?.id || null);
        advancesAcc = { id:Number(created.lastInsertRowid) };
      }

      // Si el anticipo se recibió antes de activar Contabilidad, lo reconoce
      // ahora antes de aplicarlo. La función es idempotente.
      if (Number(sale.prepaid_amount || 0) > 0 && tableExists('service_order_deposits')) {
        const deposits = db.prepare("SELECT id FROM service_order_deposits WHERE applied_sale_id=? AND status='applied'").all(saleId);
        deposits.forEach(deposit => this.generateServiceDepositEntry({ depositId:deposit.id, userId }));
      }

      const lines = [];
      const method = sale.payment_method || 'efectivo';
      // Número visible de la factura (nunca el id técnico de la fila): usa la
      // numeración histórica importada, luego la interna del documento y, como
      // último recurso, el id. Así el asiento cita el mismo número que ve el
      // cliente en la factura impresa.
      const invNo = (sale.numero_factura_fmt || '').trim()
        || (sale.document_number_fmt || '').trim()
        || `#${saleId}`;

      // Débito: qué recibimos
      let debitAccId = cashAccId;
      if (method === 'transferencia') debitAccId = bankAccId;
      else if (method === 'tarjeta')  debitAccId = bankAccId;
      else if (method === 'credito')  debitAccId = arAccId;

      const tradeInAmount = round2(Number(sale.trade_in_amount) || 0);
      const prepaidAmount = round2(Number(sale.prepaid_amount) || 0);
      const monetaryAmount = round2(Number(sale.total) - tradeInAmount - prepaidAmount);
      if (debitAccId && monetaryAmount > 0) {
        lines.push({ account_id: debitAccId, debit: monetaryAmount, credit: 0, description: `Factura ${invNo}` });
      }
      if (invAccId && tradeInAmount > 0) {
        lines.push({ account_id: invAccId, debit: tradeInAmount, credit: 0, description: `Equipo usado recibido · Factura ${invNo}` });
      }
      if (advancesAcc?.id && prepaidAmount > 0) {
        lines.push({ account_id: advancesAcc.id, debit: prepaidAmount, credit: 0, description: `Anticipo aplicado · Factura ${invNo}` });
      }

      // Crédito: ingresos (neto sin ITBIS)
      const netSale = sale.total - (sale.tax_amt || 0);
      if (revAccId && netSale > 0) {
        lines.push({ account_id: revAccId, debit: 0, credit: netSale, description: `Factura ${invNo}` });
      }
      // Crédito: ITBIS por pagar
      if (taxAccId && (sale.tax_amt || 0) > 0) {
        lines.push({ account_id: taxAccId, debit: 0, credit: sale.tax_amt, description: `ITBIS factura ${invNo}` });
      }

      // COGS (costo de venta)
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
      const totalCost = items.reduce((s, i) => s + ((i.unit_cost||0) * (i.qty||1)), 0);
      if (cogsAccId && invAccId && totalCost > 0) {
        lines.push({ account_id: cogsAccId, debit: totalCost, credit: 0, description: `Costo factura ${invNo}` });
        lines.push({ account_id: invAccId, debit: 0, credit: totalCost, description: `Inventario factura ${invNo}` });
      }

      if (lines.length < 2) return null;

      return this.createEntry({
        date:          sale.sale_date || (sale.created_at || new Date().toISOString()).split('T')[0],
        concept:       `Factura ${invNo} — ${sale.customer_name || 'Consumidor Final'}`,
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

  generateServiceDepositEntry({ depositId, userId } = {}) {
    try {
      const modEnabled = db.prepare("SELECT value FROM settings WHERE key='module_contabilidad'").get()?.value;
      if (modEnabled !== '1' || !tableExists('service_order_deposits')) return null;
      const deposit = db.prepare(`SELECT d.*,so.number FROM service_order_deposits d
        JOIN service_orders so ON so.id=d.service_order_id WHERE d.id=?`).get(Number(depositId));
      if (!deposit || deposit.status === 'refunded') return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='servicio_anticipo' AND source_id=? AND status='confirmado'").get(deposit.id)) return null;
      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare('SELECT id FROM accounting_accounts WHERE code=?').get(fallback)?.id;
      const receivedAccId = deposit.method === 'efectivo' ? getAccId('account_cash','1101') : getAccId('account_bank','1103');
      let advances = db.prepare("SELECT id FROM accounting_accounts WHERE code='2103'").get();
      if (!advances) {
        const parent = db.prepare("SELECT id FROM accounting_accounts WHERE code='21'").get();
        advances = { id:Number(db.prepare(`INSERT INTO accounting_accounts(code,name,type,subtype,parent_id,description,is_summary,active)
          VALUES('2103','Anticipos de Clientes','pasivo','anticipo',?,'Pagos recibidos antes de facturar',0,1)`).run(parent?.id || null).lastInsertRowid) };
      }
      if (!receivedAccId || !advances.id) return null;
      return this.createEntry({ date:String(deposit.created_at || '').slice(0,10), concept:`Anticipo de servicio ${deposit.number}`,
        reference:`SAD-${deposit.id}`, source_module:'servicio_anticipo', source_id:deposit.id, userId,
        lines:[
          {account_id:receivedAccId,debit:deposit.amount,credit:0,description:`Anticipo ${deposit.number}`},
          {account_id:advances.id,debit:0,credit:deposit.amount,description:`Anticipo pendiente ${deposit.number}`},
        ], status:'confirmado' });
    } catch (e) { console.error('[accounting] generateServiceDepositEntry:', e.message); return null; }
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
      if (String(payment.status || 'active').toLowerCase() !== 'active') return null;
      // Solo abonos REALES reducen la CxC: ignorar monto 0 y el marcador contable
      // "Saldo inicial importado" (no es un cobro, es el saldo de apertura de la deuda).
      if (!payment.amount || payment.amount <= 0) return null;
      if (payment.note === 'Saldo inicial importado') return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='abono' AND source_id=?").get(paymentId)) return null;

      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare("SELECT id FROM accounting_accounts WHERE code=?").get(fallback)?.id;

      const method = String(payment.method || 'efectivo').toLowerCase();
      const cashAccId = getAccId('account_cash', '1101');
      const bankAccId = getAccId('account_bank', '1103');
      const arAccId = getAccId('account_ar', '1104');

      let cashDebit = 0;
      let bankDebit = 0;
      if (method === 'mixto') {
        const parts = db.prepare(`
          SELECT method,SUM(amount) amount
          FROM cash_movements
          WHERE payment_id=? AND type='abono'
          GROUP BY method
        `).all(paymentId);
        cashDebit = round2(parts
          .filter(row => String(row.method || '').toLowerCase() === 'efectivo')
          .reduce((sum, row) => sum + Number(row.amount || 0), 0));
        bankDebit = round2(parts
          .filter(row => String(row.method || '').toLowerCase() !== 'efectivo')
          .reduce((sum, row) => sum + Number(row.amount || 0), 0));
        const unclassified = round2(Number(payment.amount || 0) - cashDebit - bankDebit);
        if (unclassified > 0) bankDebit = round2(bankDebit + unclassified);
      } else if (['transferencia', 'tarjeta', 'cheque'].includes(method)) {
        bankDebit = round2(Number(payment.amount || 0));
      } else {
        cashDebit = round2(Number(payment.amount || 0));
      }
      const lines = [
        ...(cashDebit > 0 ? [{ account_id: cashAccId, debit: cashDebit, credit: 0, description: `Abono cliente #${payment.customer_id} · efectivo` }] : []),
        ...(bankDebit > 0 ? [{ account_id: bankAccId, debit: bankDebit, credit: 0, description: `Abono cliente #${payment.customer_id} · banco/tarjeta` }] : []),
        { account_id: arAccId, debit: 0, credit: payment.amount, description: `Abono cliente #${payment.customer_id}` },
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
      // Número visible de la factura original devuelta (no el id técnico).
      const original = ret.original_sale_id
        ? db.prepare('SELECT numero_factura_fmt,document_number_fmt FROM sales WHERE id=?').get(ret.original_sale_id)
        : null;
      const ref = (original?.numero_factura_fmt || '').trim()
        || (original?.document_number_fmt || '').trim()
        || (ret.numero_factura_fmt || '').trim()
        || (ret.document_number_fmt || '').trim()
        || `#${ret.original_sale_id || returnSaleId}`;

      const lines = [];
      if (revAccId && net > 0) lines.push({ account_id: revAccId, debit: net,   credit: 0, description: `Devolución factura ${ref}` });
      if (taxAccId && tax > 0) lines.push({ account_id: taxAccId, debit: tax,   credit: 0, description: `ITBIS devolución ${ref}` });
      if (method === 'mixto') {
        const cashPart = Math.abs(db.prepare(`
          SELECT COALESCE(SUM(amount),0) amount
          FROM cash_movements
          WHERE type='devolucion' AND reference_id=? AND LOWER(COALESCE(method,'efectivo'))='efectivo'
        `).get(returnSaleId).amount || 0);
        const bankPart = Math.max(0, round2(total - cashPart));
        if (cashAccId && cashPart > 0) {
          lines.push({ account_id: cashAccId, debit: 0, credit: cashPart, description: `Devolución efectivo factura ${ref}` });
        }
        if (bankAccId && bankPart > 0) {
          lines.push({ account_id: bankAccId, debit: 0, credit: bankPart, description: `Devolución tarjeta/transferencia factura ${ref}` });
        }
      } else if (creditAccId) {
        lines.push({ account_id: creditAccId, debit: 0, credit: total, description: `Devolución factura ${ref}` });
      }

      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(returnSaleId);
      const cost = items.reduce((s,i)=> s + (Math.abs(i.unit_cost||0) * Math.abs(i.qty||1)), 0);
      if (cogsAccId && invAccId && cost > 0) {
        lines.push({ account_id: invAccId,  debit: cost, credit: 0, description: `Inventario devolución factura ${ref}` });
        lines.push({ account_id: cogsAccId, debit: 0, credit: cost, description: `Costo devolución factura ${ref}` });
      }
      if (lines.length < 2) return null;

      return this.createEntry({
        date:          ret.sale_date || (ret.created_at || new Date().toISOString()).split('T')[0],
        concept:       `Devolución factura ${ref} — ${ret.customer_name||'Consumidor Final'}`,
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

  generatePrivatePurchaseEntry({ purchaseId, userId } = {}) {
    try {
      if (settingsRepo.get('module_contabilidad') !== '1') return null;
      const purchase = db.prepare('SELECT * FROM tech_private_purchases WHERE id=?').get(Number(purchaseId));
      if (!purchase || purchase.status !== 'completada') return null;
      if (db.prepare("SELECT id FROM accounting_entries WHERE source_module='compra_usado' AND source_id=?").get(purchase.id)) return null;
      const cfg = this.getConfig();
      const getAccId = (key, fallback) => cfg[key]?.account_id || db.prepare('SELECT id FROM accounting_accounts WHERE code=?').get(fallback)?.id;
      const inventoryId = getAccId('account_inventory','1105');
      const paymentId = purchase.payment_method === 'efectivo'
        ? getAccId('account_cash','1101') : getAccId('account_bank','1103');
      if (!inventoryId || !paymentId) return null;
      return this.createEntry({
        date:String(purchase.created_at || '').slice(0,10),
        concept:`Compra de equipo usado ${purchase.number} — ${purchase.seller_name}`,
        reference:purchase.number,
        source_module:'compra_usado',source_id:purchase.id,userId,status:'confirmado',
        lines:[
          { account_id:inventoryId,debit:purchase.amount,credit:0,description:`Equipo ${purchase.imei||purchase.serial}` },
          { account_id:paymentId,debit:0,credit:purchase.amount,description:`Pago ${purchase.number}` },
        ],
      });
    } catch (e) { console.error('[accounting] generatePrivatePurchaseEntry:', e.message); return null; }
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

  saveFiscalWithholding(data = {}, userId = null) {
    const direction = data.direction === 'received' ? 'received' : 'made';
    const taxKind = ['itbis','isr','retribucion_complementaria','other'].includes(data.tax_kind) ? data.tax_kind : 'other';
    const date = String(data.document_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Indica una fecha válida');
    const base = Math.max(0, round2(Number(data.base_amount) || 0));
    const rate = Math.max(0, round2(Number(data.rate) || 0));
    const amount = Math.max(0, round2(Number(data.amount) || (base * rate / 100)));
    if (amount <= 0) throw new Error('El monto retenido debe ser mayor que cero');
    return Number(db.prepare(`INSERT INTO fiscal_withholdings(direction,tax_kind,source_type,source_id,
      party_name,party_rnc,ncf,document_date,base_amount,rate,amount,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(direction,taxKind,String(data.source_type || 'manual'),
      Number(data.source_id) || null,String(data.party_name || '').trim(),String(data.party_rnc || '').replace(/\D/g,''),
      String(data.ncf || '').trim().toUpperCase(),date,base,rate,amount,String(data.notes || '').trim(),Number(userId) || null).lastInsertRowid);
  },

  getFiscalWorkpaper({ from, to } = {}) {
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const periodFrom = validDate(from) ? from : `${new Date().toISOString().slice(0,7)}-01`;
    const periodTo = validDate(to) ? to : new Date().toISOString().slice(0,10);
    const salesBook = db.prepare(`SELECT s.id,date(s.created_at) document_date,s.customer_name,s.customer_rnc,
      s.subtotal,s.discount_amt,s.tax_amt,s.total,s.source_balance,s.payment_method,n.ncf,n.type ncf_type,n.issued_at,
      COALESCE((SELECT SUM(CASE WHEN LOWER(cm.method)='efectivo' THEN cm.amount ELSE 0 END) FROM cash_movements cm WHERE cm.type='venta' AND cm.reference_id=s.id),0) cash_amount,
      COALESCE((SELECT SUM(CASE WHEN LOWER(cm.method) IN ('transferencia','cheque') THEN cm.amount ELSE 0 END) FROM cash_movements cm WHERE cm.type='venta' AND cm.reference_id=s.id),0) transfer_amount,
      COALESCE((SELECT SUM(CASE WHEN LOWER(cm.method)='tarjeta' THEN cm.amount ELSE 0 END) FROM cash_movements cm WHERE cm.type='venta' AND cm.reference_id=s.id),0) card_amount
      FROM sales s LEFT JOIN ncf_log n ON n.id=(SELECT MAX(n2.id) FROM ncf_log n2 WHERE n2.sale_id=s.id)
      WHERE s.type='factura' AND s.status='completed' AND date(s.created_at) BETWEEN ? AND ?
      ORDER BY datetime(s.created_at),s.id`).all(periodFrom, periodTo).map(row => {
        const explicitPaid = round2(Number(row.cash_amount)+Number(row.transfer_amount)+Number(row.card_amount));
        const credit = row.payment_method === 'credito'
          ? round2(row.source_balance == null ? row.total : row.source_balance)
          : Math.max(0, round2(Number(row.total)-explicitPaid));
        return { ...row, credit_amount:credit,
          payment_control_difference:round2(Number(row.total)-explicitPaid-credit) };
      });
    const purchaseBook = this.get606({ from:periodFrom, to:periodTo });
    const withholdings = db.prepare(`SELECT * FROM fiscal_withholdings WHERE status='active'
      AND date(document_date) BETWEEN ? AND ? ORDER BY document_date,id`).all(periodFrom,periodTo);
    const salesTotals = salesBook.reduce((sum,row) => ({
      base:round2(sum.base+Number(row.subtotal||0)-Number(row.discount_amt||0)),
      itbis:round2(sum.itbis+Number(row.tax_amt||0)), total:round2(sum.total+Number(row.total||0)),
    }), {base:0,itbis:0,total:0});
    const w = (direction,kind) => round2(withholdings.filter(x=>x.direction===direction&&x.tax_kind===kind).reduce((s,x)=>s+Number(x.amount||0),0));
    const taxAccount = code => {
      const account = db.prepare('SELECT id FROM accounting_accounts WHERE code=?').get(code);
      if (!account) return 0;
      const row = db.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) value FROM accounting_entry_lines l
        JOIN accounting_entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.status='confirmado'
        AND e.source_module!='reverso' AND date(e.date) BETWEEN ? AND ?`).get(account.id,periodFrom,periodTo);
      return round2(Number(row.value||0));
    };
    const invalidNcf = salesBook.filter(row => row.ncf && !parseCanonicalLegacyNcf(row.ncf)).map(row => ({sale_id:row.id,ncf:row.ncf,issue:'NCF tradicional inválido'}));
    const orphanNcf = db.prepare(`SELECT l.id,l.ncf,l.sale_id FROM ncf_log l LEFT JOIN sales s ON s.id=l.sale_id
      WHERE date(l.issued_at) BETWEEN ? AND ? AND (l.sale_id IS NULL OR s.id IS NULL)`).all(periodFrom,periodTo);
    const paymentDifferences = salesBook.filter(row=>Math.abs(row.payment_control_difference)>0.01)
      .map(row=>({sale_id:row.id,difference:row.payment_control_difference}));
    return {
      period:{from:periodFrom,to:periodTo}, sales_book:salesBook, purchase_book:purchaseBook.rows,
      withholdings,
      totals:{ sales:salesTotals, purchases:purchaseBook.totals },
      it1_workpaper:{
        itbis_facturado:salesTotals.itbis, itbis_compras:Number(purchaseBook.totals.itbis||0),
        itbis_retenido_por_terceros:w('received','itbis'), itbis_retenido_a_terceros:w('made','itbis'),
        diferencia_antes_de_ajustes:round2(salesTotals.itbis-Number(purchaseBook.totals.itbis||0)-w('received','itbis')),
      },
      ir17_workpaper:{ isr_retenido:w('made','isr'), itbis_retenido:w('made','itbis'),
        retribuciones_complementarias:w('made','retribucion_complementaria'), otras:w('made','other') },
      accounting_control:{ itbis_por_pagar_movement:round2(-taxAccount('2102')),
        itbis_acreditable_movement:taxAccount('1106') },
      reconciliation:{ invalid_ncf:invalidNcf, orphan_ncf:orphanNcf, payment_differences:paymentDifferences,
        issue_count:invalidNcf.length+orphanNcf.length+paymentDifferences.length },
      disclaimer:'Hoja de trabajo y conciliación interna. Debe validarse en los formularios oficiales de DGII antes de presentar.',
    };
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

  _insertCharges(noteId, charges) {
    if (!tableExists('delivery_note_charges')) return;
    const ins = db.prepare(`
      INSERT INTO delivery_note_charges
        (delivery_note_id,description,amount,invoice_id)
      VALUES(?,?,?,?)
    `);
    (Array.isArray(charges) ? charges : []).map(row => ({
      description: String(row?.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      amount: round2(Number(row?.amount) || 0),
      invoice_id: Number(row?.invoice_id) || null,
    })).filter(row => row.description && row.amount > 0 && row.amount <= 9999999)
      .slice(0, 20)
      .forEach(row => ins.run(noteId, row.description, row.amount, row.invoice_id));
  },

  create({ header = {}, items = [], charges = [], userId = null, trustedSnapshot = false }) {
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
      // Sucursal de entrega del cliente (distinta de branch_id, que es la
      // sucursal del propio negocio).
      let custBranch = null;
      if (header.customer_branch_id && header.customer_id) {
        const storedB = db.prepare('SELECT * FROM customer_branches WHERE id=? AND customer_id=?')
          .get(header.customer_branch_id, header.customer_id);
        if (!storedB) throw new Error('La sucursal no pertenece al cliente seleccionado');
        if (trustedSnapshot && header.preserve_branch_snapshot) {
          custBranch = { ...storedB, name: header.customer_branch_name || storedB.name,
            code: header.customer_branch_code || storedB.code,
            address: header.customer_branch_address || storedB.address,
            phone: header.customer_branch_phone || storedB.phone };
        } else {
          if (storedB.active !== 1) throw new Error('La sucursal seleccionada está inactiva');
          custBranch = storedB;
        }
      }
      const r = db.prepare(`
        INSERT INTO delivery_notes
          (number, customer_id, customer_name, customer_rnc,
           customer_contact_id,customer_contact_name,customer_contact_document,
           customer_contact_role,customer_contact_phone,customer_contact_email,
           customer_branch_id,customer_branch_name,customer_branch_code,customer_branch_address,customer_branch_phone,branch_id,
           source_type, source_id, status, issue_date, delivery_address,
           driver_name, vehicle_plate, notes, invoice_id, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        number, header.customer_id || null, account?.name || header.customer_name || 'Consumidor Final',
        account?.rnc || header.customer_rnc || '', contact?.id || null, contact?.name || '', contact?.document || '',
        contact?.role || '', contact?.phone || '', contact?.email || '',
        custBranch?.id || null, custBranch?.name || '', custBranch?.code || '', custBranch?.address || '', custBranch?.phone || '',
        header.branch_id || null,
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
      this._insertCharges(id, charges);
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
    dn.charges       = tableExists('delivery_note_charges')
      ? db.prepare('SELECT * FROM delivery_note_charges WHERE delivery_note_id=? ORDER BY id').all(id)
      : [];
    return dn;
  },

  update(id, { header = {}, items = null, charges = null }) {
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
      let custBranch = null;
      if (header.customer_branch_id) {
        if (!account || account.customer_type !== 'company') {
          throw new Error('Solo una empresa puede tener sucursales');
        }
        custBranch = db.prepare('SELECT * FROM customer_branches WHERE id=? AND customer_id=? AND active=1')
          .get(header.customer_branch_id, account.id);
        if (!custBranch) throw new Error('La sucursal no pertenece a la empresa o está inactiva');
      }
      db.prepare(`
        UPDATE delivery_notes SET
          customer_id=?, customer_name=?, customer_rnc=?, customer_contact_id=?,
          customer_contact_name=?,customer_contact_document=?,customer_contact_role=?,
          customer_contact_phone=?,customer_contact_email=?,
          customer_branch_id=?,customer_branch_name=?,customer_branch_code=?,customer_branch_address=?,customer_branch_phone=?,branch_id=?,
          delivery_address=?, driver_name=?, vehicle_plate=?, notes=?,
          updated_at=datetime('now','localtime')
        WHERE id=?
      `).run(
        header.customer_id || null, account?.name || header.customer_name || 'Consumidor Final',
        account?.rnc || header.customer_rnc || '', contact?.id || null,
        contact?.name || '',contact?.document || '',contact?.role || '',
        contact?.phone || '',contact?.email || '',
        custBranch?.id || null, custBranch?.name || '', custBranch?.code || '', custBranch?.address || '', custBranch?.phone || '',
        header.branch_id || null,
        header.delivery_address || '', header.driver_name || '',
        header.vehicle_plate || '', header.notes || '', id
      );
      if (Array.isArray(items)) {
        db.prepare('DELETE FROM delivery_note_items WHERE delivery_note_id=?').run(id);
        this._insertItems(id, items);
      }
      if (Array.isArray(charges) && tableExists('delivery_note_charges')) {
        db.prepare('DELETE FROM delivery_note_charges WHERE delivery_note_id=?').run(id);
        this._insertCharges(id, charges);
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
        sourceConduceItemId: t.item.id,
      })),
      payment: {
        ...payment,
        method: payment.method || 'efectivo', disc: payment.disc || 0, priceMode,
        sourceConduceId: conduceId,
      },
      user,
      type: 'factura',
      trustedCustomerSnapshot: true,
    });
    const saleId = saleRes.saleId;

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
    // Idempotente: si ya existe un conduce (no anulado) para esta venta, se
    // devuelve el existente en vez de duplicar. Así el botón "Generar conduce"
    // puede pulsarse varias veces sin crear copias.
    const existing = db.prepare(
      "SELECT id FROM delivery_notes WHERE source_id=? AND source_type IN ('factura','cotizacion') AND status!='anulado' ORDER BY id DESC LIMIT 1"
    ).get(saleId);
    if (existing) return this.getById(existing.id);
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
    if (!items.length) throw new Error('La venta no tiene líneas');
    const sourceCharges = tableExists('sale_charges')
      ? db.prepare('SELECT description,amount FROM sale_charges WHERE sale_id=? ORDER BY id').all(saleId)
      : [];

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
      charges: sourceCharges.map(row => ({
        ...row,
        invoice_id: sale.type === 'factura' ? saleId : null,
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
const saleCorrectionsRepo = createSaleCorrectionsRepo({
  getDb: () => db,
  salesRepo,
  returnsRepo,
});

// ══════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// CRM CEREBRO — repositorio (F0/F1)
// ──────────────────────────────────────────────
// Segmentación RFM ligera calculada 100% offline sobre sales/customers.
// F0 entrega el panel de inicio (conteos por segmento + destacados) y la
// bitácora de interacciones. El scoring RFM+ de 6 ejes se profundiza en F1.
// ══════════════════════════════════════════════

// Clasifica un cliente según sus agregados de compra (recencia/frecuencia).
// Umbrales conservadores y explicables — nada de "magia".
function _crmSegmentOf(agg) {
  const freq = agg.freq || 0;
  if (freq === 0) return 'nuevo';
  const r = (agg.recency == null) ? 9999 : agg.recency;
  if (freq >= 3 && r <= 45) return 'vip';
  if (freq >= 3 && r > 90)  return 'en_riesgo';
  if (r > 90)               return 'dormido';
  return 'frecuente';
}

// Formato de dinero/fecha para los mensajes redactados del CRM (F3).
function _crmMoney(n) { return (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _crmDateStr(iso) {
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return String(iso || '');
  return d.toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Clasifica un producto por demanda, rotación y antigüedad. Umbrales fijos y
// explicables, iguales en el panel de inventario y en la ficha de producto.
//   congelado = con stock pero sin venderse hace mucho (capital muerto)
//   reponer   = se vende y está por agotarse (bajo mínimo o < 15 días de stock)
//   estrella  = alta demanda (≥10 und/90d) con buen margen (≥25%)
//   estable   = el resto con movimiento normal
function _crmProductSegment(x) {
  const stock = x.stock || 0;
  if (stock > 0 && (
        (x.qtyTotal === 0) ? (x.shelfAge != null && x.shelfAge > 120)
                           : (x.daysSinceLastSale != null && x.daysSinceLastSale > 180))) {
    return 'congelado';
  }
  if (x.qty90 > 0 && (stock <= (x.stockMin || 0) || (x.daysOfStock != null && x.daysOfStock < 15))) {
    return 'reponer';
  }
  if (x.qty90 >= (x.starQty || 10) && x.marginPct >= 25) return 'estrella';
  return 'estable';
}

// Umbral "estrella" adaptado al negocio (F-Aprendizaje): percentil 80 de las
// unidades vendidas en 90 días, mínimo 5. Así "mucha venta" se calibra a la
// escala real de ESTA tienda en vez de un número fijo.
function _crmLearnedStarQty() {
  const q = db.prepare(`
    SELECT SUM(CASE WHEN julianday('now','localtime')-julianday(s.created_at) <= 90 THEN si.qty ELSE 0 END) AS q90
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.type='factura' AND s.status='completed' AND si.product_id IS NOT NULL
     GROUP BY si.product_id
  `).all().map(r => r.q90 || 0).filter(v => v > 0).sort((a, b) => a - b);
  if (!q.length) return 10;
  return Math.max(5, q[Math.min(q.length - 1, Math.floor(q.length * 0.8))]);
}

let _crmInventoryCache = null;
const crmRepo = {
  // Panel de inicio del CRM: totales, conteo por segmento y listas destacadas.
  // Solo lee ventas confirmadas (factura + completed); ignora cotizaciones,
  // devoluciones y anuladas para que los números reflejen negocio real.
  overview() {
    const customers = db.prepare(
      `SELECT id, name, trade_name, customer_type, balance, credit_limit, status
         FROM customers WHERE active=1`
    ).all();

    const agg = db.prepare(`
      SELECT customer_id AS id,
             COUNT(*)            AS freq,
             COALESCE(SUM(total),0) AS monetary,
             MAX(created_at)     AS last_sale,
             CAST(julianday('now','localtime') - julianday(MAX(created_at)) AS INTEGER) AS recency
        FROM sales
       WHERE type='factura' AND status='completed' AND customer_id IS NOT NULL
       GROUP BY customer_id
    `).all();

    const byId = {};
    agg.forEach(a => { byId[a.id] = a; });

    const segments = { vip: 0, frecuente: 0, en_riesgo: 0, dormido: 0, nuevo: 0 };
    const enriched = customers.map(c => {
      const a = byId[c.id] || { freq: 0, monetary: 0, recency: null };
      const segment = _crmSegmentOf(a);
      segments[segment]++;
      return {
        id: c.id,
        name: c.trade_name || c.name,
        freq: a.freq || 0,
        monetary: a.monetary || 0,
        recency: a.recency,
        balance: c.balance || 0,
        segment,
      };
    });

    const topSpenders = enriched
      .filter(e => e.monetary > 0)
      .sort((x, y) => y.monetary - x.monetary)
      .slice(0, 8);

    const atRisk = enriched
      .filter(e => e.segment === 'en_riesgo' || e.segment === 'dormido')
      .sort((x, y) => y.monetary - x.monetary)
      .slice(0, 8);

    return {
      generatedAt: new Date().toISOString(),
      totalCustomers: customers.length,
      withPurchases: agg.length,
      segments,
      topSpenders,
      atRisk,
    };
  },

  // Registra un contacto/nota del CRM en la bitácora del cliente.
  logInteraction({ customerId, kind = 'nota', reason = '', message = '', userId = null }) {
    const info = db.prepare(
      `INSERT INTO customer_interactions(customer_id, kind, reason, message, user_id)
       VALUES(?,?,?,?,?)`
    ).run(customerId, kind, reason, message, userId);
    return info.lastInsertRowid;
  },

  // Últimas interacciones de un cliente (para el historial del panel 360°).
  interactionsFor(customerId, limit = 20) {
    return db.prepare(
      `SELECT id, kind, reason, message, user_id, created_at
         FROM customer_interactions
        WHERE customer_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    ).all(customerId, limit);
  },

  // ── Cliente 360° (F1) ──────────────────────────
  // RFM+ de 6 ejes + hábitos de compra + crédito, todo offline sobre datos
  // que ya existen. Devuelve null si el cliente no existe.
  customer360(customerId) {
    const c = db.prepare(
      `SELECT id, name, trade_name, customer_type, phone, rnc, email, address,
              balance, credit_limit, credit_days, credit_due, status, preferred_price_mode
         FROM customers WHERE id = ?`
    ).get(customerId);
    if (!c) return null;

    // Ventas confirmadas (excluye cotizaciones/anuladas/devoluciones).
    const sales = db.prepare(`
      SELECT id, total, ncf, created_at,
             CAST(julianday('now','localtime') - julianday(created_at) AS INTEGER) AS days_ago
        FROM sales
       WHERE customer_id = ? AND type='factura' AND status='completed'
       ORDER BY created_at DESC
    `).all(customerId);

    const frequency = sales.length;
    const monetary  = sales.reduce((s, x) => s + (x.total || 0), 0);
    const recency   = frequency ? sales[0].days_ago : null;
    const lastSale  = frequency ? sales[0].created_at : null;
    const firstSale = frequency ? sales[frequency - 1].created_at : null;
    const avgTicket = frequency ? monetary / frequency : 0;

    // Eje 4 — Margen real aportado (ingreso de ítems − costo). Si el costo es 0
    // en todos los ítems (típico de data importada sin costo), el margen no es
    // confiable: marcamos marginKnown=false para no mostrar "100% de margen".
    const marginRow = db.prepare(`
      SELECT COALESCE(SUM(si.subtotal), 0)          AS revenue,
             COALESCE(SUM(si.unit_cost * si.qty), 0) AS cost
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.customer_id = ? AND s.type='factura' AND s.status='completed'
    `).get(customerId);
    const marginKnown = (marginRow.cost || 0) > 0;
    const margin      = marginKnown ? (marginRow.revenue - marginRow.cost) : 0;
    const marginPct   = (marginKnown && marginRow.revenue > 0)
      ? (margin / marginRow.revenue) * 100 : 0;

    // Eje 5 — Tendencia: gasto últimos 90 días vs los 90 previos.
    const t = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN julianday('now','localtime')-julianday(created_at) <= 90 THEN total END),0) AS recent,
        COALESCE(SUM(CASE WHEN julianday('now','localtime')-julianday(created_at) > 90
                      AND julianday('now','localtime')-julianday(created_at) <= 180 THEN total END),0) AS previous
        FROM sales
       WHERE customer_id = ? AND type='factura' AND status='completed'
    `).get(customerId);
    let direction = 'estable';
    if (t.recent > t.previous * 1.15 && t.recent > 0) direction = 'subiendo';
    else if (t.recent < t.previous * 0.85) direction = 'bajando';

    // Eje 6 — Comportamiento de pago (crédito vencido o estado del cliente).
    const overdue = !!(c.balance > 0 && c.credit_due && new Date(c.credit_due) < new Date());
    const paymentStatus = (c.status === 'moroso' || overdue)
      ? 'moroso'
      : (c.status === 'bloqueado' ? 'bloqueado' : 'al_dia');

    // "Suele comprar" — productos más recurrentes de este cliente.
    const topProducts = db.prepare(`
      SELECT si.product_name AS name, SUM(si.qty) AS qty, COUNT(DISTINCT si.sale_id) AS times
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.customer_id = ? AND s.type='factura' AND s.status='completed'
       GROUP BY COALESCE(si.product_id, si.product_code), si.product_name
       ORDER BY times DESC, qty DESC
       LIMIT 5
    `).all(customerId);

    // Recompra prevista del producto más frecuente (promedio de días entre compras).
    let nextRepurchase = null;
    if (topProducts.length) {
      const top = topProducts[0];
      const g = db.prepare(`
        SELECT MIN(s.created_at) AS first, MAX(s.created_at) AS last, COUNT(DISTINCT s.id) AS n
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.customer_id = ? AND s.type='factura' AND s.status='completed'
           AND si.product_name = ?
      `).get(customerId, top.name);
      if (g.n >= 2) {
        const span = (new Date(g.last) - new Date(g.first)) / 86400000;
        const avgDays = Math.max(1, Math.round(span / (g.n - 1)));
        const daysSince = Math.round((Date.now() - new Date(g.last)) / 86400000);
        nextRepurchase = { product: top.name, avgDays, daysSince, due: daysSince >= avgDays * 0.85 };
      }
    }

    // Segmento (misma lógica del panel de inicio) + puntajes RFM 1–5.
    const segment = _crmSegmentOf({ freq: frequency, recency });
    const rScore = recency == null ? 1 : recency <= 15 ? 5 : recency <= 45 ? 4 : recency <= 90 ? 3 : recency <= 180 ? 2 : 1;
    const fScore = frequency >= 10 ? 5 : frequency >= 5 ? 4 : frequency >= 3 ? 3 : frequency >= 1 ? 2 : 1;
    const mScore = monetary >= 100000 ? 5 : monetary >= 50000 ? 4 : monetary >= 20000 ? 3 : monetary >= 5000 ? 2 : 1;

    const interactions = db.prepare(
      `SELECT id, kind, reason, message, user_id, created_at
         FROM customer_interactions WHERE customer_id = ?
        ORDER BY created_at DESC LIMIT 10`
    ).all(customerId);

    return {
      customer: c,
      metrics: { recency, frequency, monetary, margin, marginKnown, marginPct, avgTicket, firstSale, lastSale },
      trend: { recent: t.recent, previous: t.previous, direction },
      payment: { status: paymentStatus, overdue },
      segment,
      rfm: { r: rScore, f: fScore, m: mScore },
      topProducts,
      nextRepurchase,
      recentSales: sales.slice(0, 10),
      interactions,
    };
  },

  // ── Cerebro de inventario (F2) ─────────────────
  // Segmenta cada producto activo por demanda/rotación/antigüedad, 100% offline
  // sobre products + sale_items + inventory_movements que ya existen.
  inventoryOverview() {
    if (_crmInventoryCache && _crmInventoryCache.db === db &&
        Date.now() - _crmInventoryCache.createdAt < 15000) {
      return _crmInventoryCache.data;
    }
    const products = db.prepare(
      `SELECT id, name, code, category, stock, stock_min, cost, price, created_at
         FROM products WHERE active=1`
    ).all();

    const soldRows = db.prepare(`
      SELECT si.product_id AS pid,
             SUM(CASE WHEN julianday('now','localtime')-julianday(s.created_at) <= 90 THEN si.qty ELSE 0 END) AS qty90,
             SUM(si.qty) AS qtyTotal,
             MAX(s.created_at) AS lastSale
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.type='factura' AND s.status='completed' AND si.product_id IS NOT NULL
       GROUP BY si.product_id
    `).all();
    const sold = {};
    soldRows.forEach(r => { sold[r.pid] = r; });

    const entryRows = db.prepare(
      `SELECT product_id AS pid, MAX(created_at) AS lastEntry
         FROM inventory_movements WHERE type='entrada' GROUP BY product_id`
    ).all();
    const entry = {};
    entryRows.forEach(r => { entry[r.pid] = r.lastEntry; });

    const now = Date.now();
    const daysSince = (iso) => iso ? Math.round((now - new Date(String(iso).replace(' ', 'T'))) / 86400000) : null;

    const starQty = _crmLearnedStarQty();
    const segments = { estrella: 0, estable: 0, reponer: 0, congelado: 0 };
    const enriched = products.map(p => {
      const s = sold[p.id] || { qty90: 0, qtyTotal: 0, lastSale: null };
      const qty90 = s.qty90 || 0;
      const velocity = qty90 / 90;
      const daysOfStock = velocity > 0 ? Math.round(p.stock / velocity) : null;
      const marginPct = p.price > 0 ? (p.price - p.cost) / p.price * 100 : 0;
      const daysSinceLastSale = daysSince(s.lastSale);
      const shelfAge = daysSince(entry[p.id] || p.created_at);
      const segment = _crmProductSegment({
        stock: p.stock, stockMin: p.stock_min, qty90, qtyTotal: s.qtyTotal || 0,
        marginPct, daysSinceLastSale, shelfAge, daysOfStock, starQty,
      });
      segments[segment]++;
      return {
        id: p.id, name: p.name, code: p.code, stock: p.stock, stockMin: p.stock_min,
        qty90, daysOfStock, marginPct, daysSinceLastSale, shelfAge,
        stockValue: (p.stock || 0) * (p.cost || 0), segment,
      };
    });

    const result = {
      generatedAt: new Date().toISOString(),
      totalProducts: products.length,
      withStock: products.filter(p => (p.stock || 0) > 0).length,
      stockValue: enriched.reduce((s, e) => s + e.stockValue, 0),
      segments,
      reorderList: enriched.filter(e => e.segment === 'reponer')
        .sort((a, b) => (a.daysOfStock ?? 9999) - (b.daysOfStock ?? 9999)).slice(0, 8),
      deadList: enriched.filter(e => e.segment === 'congelado')
        .sort((a, b) => b.stockValue - a.stockValue).slice(0, 8),
      starList: enriched.filter(e => e.segment === 'estrella')
        .sort((a, b) => b.qty90 - a.qty90).slice(0, 8),
    };
    _crmInventoryCache = { db, createdAt: Date.now(), data: result };
    return result;
  },

  // Ficha 360° de un producto: rotación, margen, antigüedad, "se vende junto
  // con" y movimientos recientes. Devuelve null si no existe.
  product360(productId) {
    const p = db.prepare(
      `SELECT id, name, code, barcode, category, brand, model, stock, stock_min,
              cost, price, wholesale, created_at,
              perishable, shelf_life_months, expiry_date, care_type, care_every_months,
              last_care_at, storage_note
         FROM products WHERE id = ?`
    ).get(productId);
    if (!p) return null;

    const s = db.prepare(`
      SELECT SUM(CASE WHEN julianday('now','localtime')-julianday(sa.created_at) <= 90 THEN si.qty ELSE 0 END) AS qty90,
             SUM(si.qty) AS qtyTotal,
             MAX(sa.created_at) AS lastSale,
             COUNT(DISTINCT sa.id) AS timesSold
        FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
       WHERE si.product_id = ? AND sa.type='factura' AND sa.status='completed'
    `).get(productId);

    const qty90 = s.qty90 || 0;
    const velocity = qty90 / 90;
    const velocityMonth = Math.round(velocity * 30 * 10) / 10;
    const daysOfStock = velocity > 0 ? Math.round(p.stock / velocity) : null;
    const marginPct = p.price > 0 ? (p.price - p.cost) / p.price * 100 : 0;

    const now = Date.now();
    const daysSince = (iso) => iso ? Math.round((now - new Date(String(iso).replace(' ', 'T'))) / 86400000) : null;
    const lastEntry = db.prepare(
      `SELECT MAX(created_at) AS e FROM inventory_movements WHERE product_id = ? AND type='entrada'`
    ).get(productId).e;
    const shelfAge = daysSince(lastEntry || p.created_at);
    const daysSinceLastSale = daysSince(s.lastSale);

    const segment = _crmProductSegment({
      stock: p.stock, stockMin: p.stock_min, qty90, qtyTotal: s.qtyTotal || 0,
      marginPct, daysSinceLastSale, shelfAge, daysOfStock, starQty: _crmLearnedStarQty(),
    });

    const boughtWith = db.prepare(`
      SELECT si2.product_name AS name, COUNT(DISTINCT si2.sale_id) AS times
        FROM sale_items si1
        JOIN sale_items si2 ON si2.sale_id = si1.sale_id AND si2.product_id <> si1.product_id
        JOIN sales sa ON sa.id = si1.sale_id
       WHERE si1.product_id = ? AND sa.type='factura' AND sa.status='completed'
       GROUP BY COALESCE(si2.product_id, si2.product_name)
       ORDER BY times DESC LIMIT 5
    `).all(productId);

    const recentMovements = db.prepare(
      `SELECT type, qty, qty_after, reason, created_at
         FROM inventory_movements WHERE product_id = ?
        ORDER BY created_at DESC LIMIT 8`
    ).all(productId);

    // Estado físico (F2b): caducidad y mantenimiento, si están configurados.
    const parseD = (iso) => { const dd = new Date(String(iso).replace(' ', 'T')); return isNaN(dd) ? null : dd; };
    const addM = (iso, months) => { const dd = iso ? parseD(iso) : null; if (!dd || months == null) return null; dd.setMonth(dd.getMonth() + Number(months)); return dd; };
    const expiryDate = p.expiry_date ? parseD(p.expiry_date)
      : (p.perishable && p.shelf_life_months ? addM(lastEntry || p.created_at, p.shelf_life_months) : null);
    let careDue = null;
    if (p.care_type && p.care_every_months) careDue = addM(p.last_care_at || lastEntry || p.created_at, p.care_every_months);
    const care = {
      perishable: !!p.perishable,
      expiry: expiryDate ? expiryDate.toISOString().slice(0, 10) : null,
      daysToExpiry: expiryDate ? Math.round((expiryDate - now) / 86400000) : null,
      careType: p.care_type || '',
      careEveryMonths: p.care_every_months,
      lastCareAt: p.last_care_at,
      daysToCare: careDue ? Math.round((careDue - now) / 86400000) : null,
      storageNote: p.storage_note || '',
    };

    return {
      product: p,
      metrics: {
        stock: p.stock, stockMin: p.stock_min, cost: p.cost, price: p.price,
        marginPct, stockValue: (p.stock || 0) * (p.cost || 0),
      },
      sales: {
        qty90, qtyTotal: s.qtyTotal || 0, timesSold: s.timesSold || 0,
        lastSale: s.lastSale, velocityMonth, daysOfStock, daysSinceLastSale,
      },
      shelfAge, segment, care, boughtWith, recentMovements,
    };
  },

  // ── Salud física del inventario (F2b) ──────────
  // "Revisar en almacén": productos con stock que necesitan atención por
  // caducidad, mantenimiento o sensibilidad. Solo actúa sobre los productos
  // que tienen esos atributos configurados (por producto o plantilla).
  warehouseReview() {
    const products = db.prepare(
      `SELECT id, name, code, category, stock, perishable, shelf_life_months, expiry_date,
              care_type, care_every_months, last_care_at, storage_note, created_at
         FROM products WHERE active=1`
    ).all();
    const entryRows = db.prepare(
      `SELECT product_id AS pid, MAX(created_at) AS lastEntry
         FROM inventory_movements WHERE type='entrada' GROUP BY product_id`
    ).all();
    const entry = {};
    entryRows.forEach(r => { entry[r.pid] = r.lastEntry; });

    const now = Date.now();
    const parse = (iso) => { const d = new Date(String(iso).replace(' ', 'T')); return isNaN(d) ? null : d; };
    const addMonths = (iso, months) => {
      const d = iso ? parse(iso) : null;
      if (!d || months == null) return null;
      d.setMonth(d.getMonth() + Number(months));
      return d;
    };

    const expiring = [], maintenance = [], sensitive = [];
    products.forEach(p => {
      if ((p.stock || 0) <= 0) return; // sin stock no hay nada físico que revisar
      // Caducidad: fecha explícita, o estimada desde la última entrada + vida útil.
      let expDate = null;
      if (p.expiry_date) expDate = parse(p.expiry_date);
      else if (p.perishable && p.shelf_life_months) expDate = addMonths(entry[p.id] || p.created_at, p.shelf_life_months);
      if (expDate) {
        const daysToExpiry = Math.round((expDate - now) / 86400000);
        if (daysToExpiry <= 60) expiring.push({ id: p.id, name: p.name, code: p.code, stock: p.stock, daysToExpiry, expiry: expDate.toISOString().slice(0, 10) });
      }
      // Mantenimiento: vencido o por vencer (≤15 días) desde el último cuidado.
      if (p.care_type && p.care_every_months) {
        const due = addMonths(p.last_care_at || entry[p.id] || p.created_at, p.care_every_months);
        if (due) {
          const daysToCare = Math.round((due - now) / 86400000);
          if (daysToCare <= 15) maintenance.push({ id: p.id, name: p.name, code: p.code, stock: p.stock, careType: p.care_type, daysOverdue: -daysToCare, lastCare: p.last_care_at });
        }
      }
      if (p.storage_note) sensitive.push({ id: p.id, name: p.name, note: p.storage_note });
    });

    expiring.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
    maintenance.sort((a, b) => b.daysOverdue - a.daysOverdue);

    return {
      generatedAt: new Date().toISOString(),
      configured: products.filter(p => p.perishable || p.care_type || p.expiry_date).length,
      expiring: expiring.slice(0, 20),
      maintenance: maintenance.slice(0, 20),
      sensitive: sensitive.slice(0, 20),
    };
  },

  // Categorías del inventario con su plantilla de cuidado (si existe) y conteo.
  categoryTemplates() {
    const cats = db.prepare(
      `SELECT DISTINCT category FROM products
        WHERE active=1 AND TRIM(COALESCE(category,'')) <> '' ORDER BY category`
    ).all().map(r => r.category);
    const tpls = {};
    db.prepare(`SELECT * FROM crm_category_care`).all().forEach(t => { tpls[t.category] = t; });
    return cats.map(c => ({
      category: c,
      template: tpls[c] || null,
      productCount: db.prepare(`SELECT COUNT(*) n FROM products WHERE active=1 AND category=?`).get(c).n,
    }));
  },

  // Guarda la plantilla de una categoría y, si applyNow, la aplica a todos sus
  // productos de una vez (para no configurar miles a mano).
  saveCategoryTemplate(t) {
    const params = {
      category: t.category,
      perishable: t.perishable ? 1 : 0,
      shelf_life_months: (t.shelf_life_months === '' || t.shelf_life_months == null) ? null : Number(t.shelf_life_months),
      care_type: t.care_type || '',
      care_every_months: (t.care_every_months === '' || t.care_every_months == null) ? null : Number(t.care_every_months),
      storage_note: t.storage_note || '',
    };
    db.prepare(`
      INSERT INTO crm_category_care(category,perishable,shelf_life_months,care_type,care_every_months,storage_note,updated_at)
      VALUES(@category,@perishable,@shelf_life_months,@care_type,@care_every_months,@storage_note,datetime('now','localtime'))
      ON CONFLICT(category) DO UPDATE SET
        perishable=@perishable, shelf_life_months=@shelf_life_months, care_type=@care_type,
        care_every_months=@care_every_months, storage_note=@storage_note, updated_at=datetime('now','localtime')
    `).run(params);
    let applied = 0;
    if (t.applyNow) {
      applied = db.prepare(`
        UPDATE products SET perishable=@perishable, shelf_life_months=@shelf_life_months,
          care_type=@care_type, care_every_months=@care_every_months, storage_note=@storage_note,
          updated_at=datetime('now','localtime')
        WHERE active=1 AND category=@category
      `).run(params).changes;
    }
    return { ok: true, applied };
  },

  // Edita los atributos físicos de un producto; markCareDone marca el
  // mantenimiento como recién hecho (reinicia el reloj del próximo).
  setProductCare(productId, attrs = {}) {
    const cur = db.prepare(
      `SELECT perishable, shelf_life_months, expiry_date, care_type, care_every_months, last_care_at, storage_note
         FROM products WHERE id = ?`
    ).get(productId);
    if (!cur) return { ok: false, error: 'Producto no encontrado' };
    const next = { ...cur, ...attrs };
    if (attrs.markCareDone) next.last_care_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const num = (v) => (v === '' || v == null) ? null : Number(v);
    db.prepare(
      `UPDATE products SET perishable=?, shelf_life_months=?, expiry_date=?, care_type=?,
              care_every_months=?, last_care_at=?, storage_note=?, updated_at=datetime('now','localtime')
        WHERE id = ?`
    ).run(next.perishable ? 1 : 0, num(next.shelf_life_months), next.expiry_date || null,
          next.care_type || '', num(next.care_every_months), next.last_care_at || null,
          next.storage_note || '', productId);
    return { ok: true };
  },

  // ── Contactar hoy (F3) ─────────────────────────
  // Detecta clientes que conviene contactar y REDACTA el mensaje (offline).
  // El envío es manual: la UI abre WhatsApp con el texto ya escrito.
  contactToday() {
    const biz = db.prepare("SELECT value FROM settings WHERE key='biz_name'").get()?.value || 'nuestro negocio';
    const now = Date.now();
    const customers = db.prepare(
      `SELECT id, name, trade_name, customer_type, phone, balance, credit_due, status
         FROM customers WHERE active=1`
    ).all();
    const agg = db.prepare(`
      SELECT customer_id AS id, COUNT(*) AS freq, MAX(created_at) AS last_sale,
             CAST(julianday('now','localtime') - julianday(MAX(created_at)) AS INTEGER) AS recency
        FROM sales WHERE type='factura' AND status='completed' AND customer_id IS NOT NULL
       GROUP BY customer_id
    `).all();
    const byId = {};
    agg.forEach(a => { byId[a.id] = a; });

    const disp = c => c.customer_type === 'company' ? (c.trade_name || c.name) : c.name;
    const first = c => String(disp(c) || '').trim().split(/\s+/)[0] || disp(c) || 'estimado cliente';

    const topProductOf = (id) => db.prepare(`
      SELECT si.product_name AS name FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.customer_id = ? AND s.type='factura' AND s.status='completed'
       GROUP BY COALESCE(si.product_id, si.product_code), si.product_name
       ORDER BY COUNT(DISTINCT si.sale_id) DESC LIMIT 1
    `).get(id)?.name;

    const items = [];
    customers.forEach(c => {
      const a = byId[c.id];
      const name = disp(c), fn = first(c);

      // 1) Crédito por vencer (≤3 días) o vencido — máxima prioridad.
      if (c.balance > 0 && c.credit_due) {
        const due = new Date(String(c.credit_due).replace(' ', 'T'));
        if (!isNaN(due)) {
          const days = Math.round((due - now) / 86400000);
          if (days <= 3) {
            const overdue = days < 0;
            items.push({
              customerId: c.id, name, phone: c.phone || '', reasonType: 'credito', priority: overdue ? 0 : 1,
              reason: overdue ? `Crédito vencido hace ${-days} día(s) · RD$${_crmMoney(c.balance)}`
                              : (days === 0 ? `Crédito vence hoy · RD$${_crmMoney(c.balance)}` : `Crédito vence en ${days} día(s) · RD$${_crmMoney(c.balance)}`),
              message: `Hola ${fn}, le saluda ${biz}. Le recordamos que su cuenta por RD$${_crmMoney(c.balance)} ${overdue ? 'está vencida desde el' : 'vence el'} ${_crmDateStr(c.credit_due)}. Cualquier cosa estamos a la orden. ¡Gracias!`,
            });
            return; // un solo motivo por cliente
          }
        }
      }

      // 2) Dormido: tenía compras y lleva 60+ días sin volver.
      if (a && a.recency != null && a.recency >= 60) {
        const prod = topProductOf(c.id);
        items.push({
          customerId: c.id, name, phone: c.phone || '', reasonType: 'dormido', priority: 3,
          reason: `Sin comprar hace ${a.recency} días`,
          message: `Hola ${fn}, ¿cómo va todo? Hace un tiempo no le vemos por ${biz}. Ya tenemos mercancía nueva${prod ? ` y contamos con ${prod} que suele llevar` : ''}. ¡Le esperamos!`,
        });
        return;
      }

      // 3) Recompra prevista: su producto habitual entra en ventana de recompra.
      if (a && a.freq >= 2) {
        const top = db.prepare(`
          SELECT si.product_name AS name, MIN(s.created_at) AS first, MAX(s.created_at) AS last, COUNT(DISTINCT s.id) AS n
            FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE s.customer_id = ? AND s.type='factura' AND s.status='completed'
           GROUP BY COALESCE(si.product_id, si.product_code), si.product_name
           ORDER BY COUNT(DISTINCT s.id) DESC LIMIT 1
        `).get(c.id);
        if (top && top.n >= 2) {
          const span = (new Date(top.last) - new Date(top.first)) / 86400000;
          const avg = Math.max(1, Math.round(span / (top.n - 1)));
          const since = Math.round((now - new Date(String(top.last).replace(' ', 'T'))) / 86400000);
          if (since >= avg * 0.85 && since <= avg * 2) {
            items.push({
              customerId: c.id, name, phone: c.phone || '', reasonType: 'recompra', priority: 2,
              reason: `Recompra de ${top.name}: cada ~${avg} días, van ${since}`,
              message: `Hola ${fn}, según nuestro registro pronto le tocaría ${top.name}. Lo tenemos en existencia; si quiere se lo apartamos. ¡Saludos!`,
            });
          }
        }
      }
    });

    items.sort((x, y) => x.priority - y.priority);
    return { generatedAt: new Date().toISOString(), count: items.length, items: items.slice(0, 50) };
  },

  // ── El cerebro que aprende (F-Aprendizaje) ─────
  // (A) lo aprendido del negocio (percentiles/ritmos propios) y
  // (B) el bucle de resultados: ¿los contactos registrados llevaron a compra?
  // Todo offline y explicable — sin caja negra.
  learningStats() {
    // (A) Aprendizaje del negocio
    const salesCount = db.prepare(
      `SELECT COUNT(*) n FROM sales WHERE type='factura' AND status='completed'`
    ).get().n;
    const customersWithPurchases = db.prepare(
      `SELECT COUNT(DISTINCT customer_id) n FROM sales WHERE type='factura' AND status='completed' AND customer_id IS NOT NULL`
    ).get().n;

    // "compra grande" = percentil 75 de los totales
    let bigTicket = 0;
    if (salesCount > 0) {
      bigTicket = db.prepare(
        `SELECT total FROM sales WHERE type='factura' AND status='completed' ORDER BY total LIMIT 1 OFFSET ?`
      ).get(Math.floor(salesCount * 0.75))?.total || 0;
    }

    // ritmo típico = mediana de la brecha promedio entre compras (clientes con 2+)
    const gaps = db.prepare(`
      SELECT (julianday(MAX(created_at)) - julianday(MIN(created_at))) / (COUNT(*) - 1) AS gap
        FROM sales WHERE type='factura' AND status='completed' AND customer_id IS NOT NULL
       GROUP BY customer_id HAVING COUNT(*) >= 2
    `).all().map(r => r.gap).filter(g => g != null && g > 0).sort((a, b) => a - b);
    const medianGapDays = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;

    const starQty = _crmLearnedStarQty();

    const mrow = db.prepare(`
      SELECT COALESCE(SUM(si.subtotal),0) rev, COALESCE(SUM(si.unit_cost*si.qty),0) cost
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.type='factura' AND s.status='completed'
    `).get();
    const avgMarginPct = (mrow.cost > 0 && mrow.rev > 0) ? ((mrow.rev - mrow.cost) / mrow.rev * 100) : null;

    // (B) Efectividad de contactos: interacción seguida de compra dentro de 30 días
    const inter = db.prepare(`
      SELECT ci.reason AS reason,
             SUM(CASE WHEN EXISTS(
               SELECT 1 FROM sales s
                WHERE s.customer_id = ci.customer_id AND s.type='factura' AND s.status='completed'
                  AND s.created_at > ci.created_at
                  AND julianday(s.created_at) - julianday(ci.created_at) <= 30
             ) THEN 1 ELSE 0 END) AS bought,
             COUNT(*) AS sent
        FROM customer_interactions ci
       WHERE ci.kind IN ('whatsapp','llamada','recordatorio')
       GROUP BY ci.reason
    `).all();
    const byReason = inter.map(r => ({
      reason: r.reason || 'otro', sent: r.sent, bought: r.bought,
      rate: r.sent ? Math.round(r.bought / r.sent * 100) : 0,
    })).sort((a, b) => b.rate - a.rate);
    const totSent = byReason.reduce((a, b) => a + b.sent, 0);
    const totBought = byReason.reduce((a, b) => a + b.bought, 0);

    return {
      generatedAt: new Date().toISOString(),
      business: { salesCount, customersWithPurchases, bigTicket, medianGapDays, starQty, avgMarginPct },
      effectiveness: { sent: totSent, bought: totBought, rate: totSent ? Math.round(totBought / totSent * 100) : 0, byReason },
    };
  },
};

// ── Inventario serializado (VELO SUITE / VELO TECH POS) ─────────────────────
// Rastrea cada unidad física por IMEI/serial. INERTE para auto-repuestos:
// ningún flujo existente lo invoca y los productos con serialized=0 siguen
// usando el campo numérico products.stock. Lo consume VELO TECH POS (R5+).
const productUnitsRepo = {
  // Alta de una unidad física de un producto serializado.
  create(u = {}) {
    const imei = String(u.imei || '').trim();
    const serial = String(u.serial || '').trim();
    if (!imei && !serial) throw new Error('Cada equipo necesita IMEI o serial');
    const duplicate = this.findByImei(imei || serial);
    if (duplicate) throw new Error(`El IMEI o serial ${imei || serial} ya está registrado`);
    const info = db.prepare(`
      INSERT INTO product_units
        (product_id, imei, serial, condition, status, unit_cost, color, capacity,
         warranty_until, purchase_order_id, purchase_item_id, supplier_id,
         supplier_warranty_until, grade, battery_health, battery_capacity_mah,
         sale_description, refurb_status, notes)
      VALUES (@product_id, @imei, @serial, @condition, @status, @unit_cost, @color, @capacity,
              @warranty_until, @purchase_order_id, @purchase_item_id, @supplier_id,
              @supplier_warranty_until, @grade, @battery_health, @battery_capacity_mah,
              @sale_description, @refurb_status, @notes)
    `).run({
      product_id:     u.product_id,
      imei:           imei || null,
      serial:         serial || null,
      condition:      u.condition || 'nuevo',
      status:         u.status || 'en_stock',
      unit_cost:      Number(u.unit_cost) || 0,
      color:          u.color || '',
      capacity:       u.capacity || '',
      warranty_until: u.warranty_until || null,
      purchase_order_id: Number(u.purchase_order_id) || null,
      purchase_item_id: Number(u.purchase_item_id) || null,
      supplier_id: Number(u.supplier_id) || null,
      supplier_warranty_until: u.supplier_warranty_until || null,
      grade: String(u.grade || '').trim(),
      battery_health: u.battery_health === '' || u.battery_health == null
        ? null : Math.max(0, Math.min(100, Number.parseInt(u.battery_health, 10) || 0)),
      battery_capacity_mah: u.battery_capacity_mah === '' || u.battery_capacity_mah == null
        ? null : Math.max(0, Math.min(100000, Number.parseInt(u.battery_capacity_mah, 10) || 0)),
      sale_description: String(u.sale_description || '').trim().slice(0, 1000),
      refurb_status: String(u.refurb_status || '').trim(),
      notes:          u.notes || '',
    });
    return info.lastInsertRowid;
  },
  // Recepción masiva atómica: o entra el lote completo o no entra ninguna
  // unidad. Evita dejar compras/recepciones a medias ante un duplicado.
  createMany(productId, units = []) {
    const product = db.prepare('SELECT id FROM products WHERE id=?').get(Number(productId));
    if (!product) throw new Error('Producto no encontrado');
    const list = (Array.isArray(units) ? units : [units]).filter(Boolean);
    if (!list.length) throw new Error('Agrega al menos un IMEI o serial');
    if (list.length > 1000) throw new Error('El lote no puede superar 1,000 equipos');
    const seen = new Set();
    const clean = list.map(unit => {
      const imei = String(unit.imei || '').trim();
      const serial = String(unit.serial || '').trim();
      const identifier = imei || serial;
      if (!identifier) throw new Error('Cada equipo necesita IMEI o serial');
      const key = identifier.toUpperCase();
      if (seen.has(key)) throw new Error(`El IMEI o serial ${identifier} está repetido en el lote`);
      seen.add(key);
      if (this.findByImei(identifier)) throw new Error(`El IMEI o serial ${identifier} ya está registrado`);
      return { ...unit, product_id:Number(productId), imei:imei || null, serial:serial || null };
    });
    return db.transaction(rows => rows.map(unit => this.create(unit)))(clean);
  },
  // Unidades de un producto (opcionalmente filtradas por estado).
  listForProduct(productId, status = null) {
    return status
      ? db.prepare('SELECT * FROM product_units WHERE product_id=? AND status=? ORDER BY id').all(productId, status)
      : db.prepare('SELECT * FROM product_units WHERE product_id=? ORDER BY id').all(productId);
  },
  // Unidades en stock (base del stock de un producto serializado).
  countInStock(productId) {
    return db.prepare("SELECT COUNT(*) n FROM product_units WHERE product_id=? AND status='en_stock'").get(productId).n;
  },
  // Buscar una unidad por IMEI o serial (venta/garantía por IMEI, R5/R7).
  findByImei(imei) {
    const key = String(imei || '').trim();
    if (!key) return null;
    return db.prepare(
      `SELECT pu.*,
              p.code AS product_code, p.name AS product_name, p.brand AS product_brand,
              p.model AS product_model, p.price AS product_price,
              COALESCE(NULLIF(s.numero_factura_fmt,''), NULLIF(s.document_number_fmt,''),
                       CAST(s.numero_factura AS TEXT)) AS numero_factura,
              s.customer_id, s.customer_name, s.created_at AS sale_date,
              ti.id AS trade_in_id, ti.sale_id AS trade_in_sale_id,
              ti.seller_name AS origin_seller_name,
              ti.seller_document AS origin_seller_document,
              ti.seller_phone AS origin_seller_phone,
              ti.seller_address AS origin_seller_address
         FROM product_units pu
         JOIN products p ON p.id=pu.product_id
         LEFT JOIN sales s ON s.id=pu.sale_id
         LEFT JOIN trade_ins ti ON ti.product_unit_id=pu.id
        WHERE UPPER(TRIM(COALESCE(pu.imei,'')))=UPPER(?)
           OR UPPER(TRIM(COALESCE(pu.serial,'')))=UPPER(?)
        LIMIT 1`
    ).get(key, key) || null;
  },
  // Marca una unidad como vendida y la enlaza a su venta.
  markSold(unitId, saleId) {
    return db.prepare(
      "UPDATE product_units SET status='vendido', sale_id=?, sold_at=datetime('now','localtime') WHERE id=? AND status IN ('en_stock','reservado')"
    ).run(saleId, unitId).changes;
  },
  applySaleWarranty(unitId, days) {
    const safeDays = Math.max(0, Math.min(3650, Number.parseInt(days, 10) || 0));
    if (!safeDays) return 0;
    return db.prepare("UPDATE product_units SET warranty_until=date('now','localtime', ?) WHERE id=?")
      .run(`+${safeDays} days`, Number(unitId)).changes;
  },
  updateWarranty(unitId, warrantyUntil) {
    const value = String(warrantyUntil || '').trim();
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Fecha de garantía no válida');
    const unit = db.prepare('SELECT id FROM product_units WHERE id=?').get(Number(unitId));
    if (!unit) throw new Error('Equipo no encontrado');
    db.prepare('UPDATE product_units SET warranty_until=? WHERE id=?').run(value || null, unit.id);
    return this.findById(unit.id);
  },
  updateDetails(unitId, data = {}) {
    const unit = db.prepare('SELECT id FROM product_units WHERE id=?').get(Number(unitId));
    if (!unit) throw new Error('Equipo no encontrado');
    const health = data.battery_health === '' || data.battery_health == null
      ? null : Math.max(0, Math.min(100, Number.parseInt(data.battery_health, 10) || 0));
    const capacityMah = data.battery_capacity_mah === '' || data.battery_capacity_mah == null
      ? null : Math.max(0, Math.min(100000, Number.parseInt(data.battery_capacity_mah, 10) || 0));
    db.prepare(`UPDATE product_units SET color=?,capacity=?,battery_health=?,battery_capacity_mah=?,
      sale_description=?,notes=? WHERE id=?`).run(
      String(data.color || '').trim(), String(data.capacity || '').trim(), health, capacityMah,
      String(data.sale_description || '').trim().slice(0,1000),
      String(data.notes || '').trim().slice(0,2000), unit.id
    );
    return this.findById(unit.id);
  },
  findById(unitId) {
    return db.prepare(`
      SELECT pu.*,p.code AS product_code,p.name AS product_name,p.brand AS product_brand,p.model AS product_model,
             s.numero_factura,s.customer_id,s.customer_name,s.created_at AS sale_date
      FROM product_units pu JOIN products p ON p.id=pu.product_id
      LEFT JOIN sales s ON s.id=pu.sale_id WHERE pu.id=?
    `).get(Number(unitId)) || null;
  },
  // Stock EFECTIVO de un producto: por unidades si es serializado; si no, el
  // campo numérico actual. Helper central para el flujo serializado.
  effectiveStock(productId) {
    const p = db.prepare('SELECT stock, COALESCE(serialized,0) AS serialized FROM products WHERE id=?').get(productId);
    if (!p) return 0;
    return p.serialized ? this.countInStock(productId) : (p.stock || 0);
  },
  // Resumen de un producto serializado: conteo por estado + stock efectivo.
  overview(productId) {
    const rows = db.prepare(
      'SELECT status, COUNT(*) n FROM product_units WHERE product_id=? GROUP BY status'
    ).all(productId);
    const byStatus = { en_stock: 0, reservado: 0, vendido: 0, servicio: 0, devuelto: 0 };
    rows.forEach(r => { byStatus[r.status] = r.n; });
    return { productId, byStatus, inStock: byStatus.en_stock };
  },
  // Marca (o desmarca) un producto como serializado. Solo permite apagarlo si no
  // tiene unidades registradas, para no dejar equipos huérfanos.
  setSerialized(productId, on) {
    if (!on) {
      const units = db.prepare('SELECT COUNT(*) n FROM product_units WHERE product_id=?').get(productId).n;
      if (units > 0) throw new Error('No se puede desactivar el serializado: el producto ya tiene unidades registradas');
    }
    db.prepare('UPDATE products SET serialized=? WHERE id=?').run(on ? 1 : 0, productId);
    return { ok: true };
  },
};

// ── Servicio / reparación (VELO TECH POS R6) ───────────────────────────────
const SERVICE_TRANSITIONS = {
  recepcion: ['inspeccion'],
  inspeccion: ['diagnostico'],
  diagnostico: ['presupuesto'],
  presupuesto: ['esperando_aprobacion'],
  aprobado: ['esperando_pieza', 'reparando'],
  esperando_pieza: ['reparando'],
  reparando: ['control_calidad'],
  control_calidad: ['listo'],
};
const SERVICE_TERMINAL = new Set(['entregado','cancelado','rechazado','no_reparable','devuelto_sin_reparar']);
const SERVICE_LEGACY_STATUS = {
  recepcion:'recepcion', inspeccion:'recepcion', diagnostico:'diagnostico',
  presupuesto:'presupuesto', esperando_aprobacion:'presupuesto', rechazado:'presupuesto',
  aprobado:'aprobado', esperando_pieza:'aprobado', reparando:'reparando',
  control_calidad:'reparando', listo:'listo', entregado:'entregado',
  cancelado:'cancelado', no_reparable:'cancelado', devuelto_sin_reparar:'cancelado',
};
const serviceOrdersRepo = {
  _event(orderId, eventType, title, detail = '', user = {}, fromStatus = '', toStatus = '') {
    db.prepare(`INSERT INTO service_order_events(
      service_order_id,event_type,from_status,to_status,title,detail,user_id,user_name
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      Number(orderId), eventType, fromStatus || '', toStatus || '', title,
      String(detail || '').trim(), Number(user.id) || null, String(user.name || '')
    );
  },

  _setWorkflow(orderId, workflowStatus) {
    const legacy = SERVICE_LEGACY_STATUS[workflowStatus] || 'recepcion';
    db.prepare(`UPDATE service_orders SET workflow_status=?,status=?,updated_at=datetime('now','localtime') WHERE id=?`)
      .run(workflowStatus, legacy, Number(orderId));
  },

  _safeJson(value, fallback) {
    if (value == null || value === '') return JSON.stringify(fallback);
    if (typeof value === 'string') {
      try { JSON.parse(value); return value; } catch { return JSON.stringify(fallback); }
    }
    return JSON.stringify(value);
  },

  _restoreUnitStatus(order) {
    if (!order?.product_unit_id) return;
    const allowed = new Set(['en_stock', 'reservado', 'vendido', 'devuelto']);
    const status = allowed.has(order.unit_previous_status) ? order.unit_previous_status : 'vendido';
    db.prepare('UPDATE product_units SET status=? WHERE id=?').run(status, order.product_unit_id);
  },

  _portalSecret() {
    let secret = String(settingsRepo.get('service_public_portal_secret') || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(secret)) {
      secret = crypto.randomBytes(32).toString('hex');
      settingsRepo.set('service_public_portal_secret', secret);
    }
    return secret;
  },

  _portalEnabled() {
    return String(settingsRepo.get('service_public_portal_enabled') || '1') === '1';
  },

  _signPublicLink(orderId, publicId) {
    return crypto.createHmac('sha256', this._portalSecret())
      .update(`service:${Number(orderId)}:${publicId}`)
      .digest('base64url').slice(0, 32);
  },

  _tokenForLink(link) {
    return `${link.public_id}.${this._signPublicLink(link.service_order_id, link.public_id)}`;
  },

  _findPublicLink(token, { touch = false } = {}) {
    const match = /^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{32})$/.exec(String(token || '').trim());
    if (!match) return null;
    const link = db.prepare(`SELECT * FROM service_public_links WHERE public_id=? AND enabled=1
      AND revoked_at IS NULL AND (expires_at IS NULL OR datetime(expires_at)>datetime('now','localtime'))`).get(match[1]);
    if (!link) return null;
    const expected = Buffer.from(this._signPublicLink(link.service_order_id, link.public_id));
    const supplied = Buffer.from(match[2]);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    if (touch) {
      db.prepare(`UPDATE service_public_links SET access_count=access_count+1,
        last_accessed_at=datetime('now','localtime') WHERE id=?`).run(link.id);
    }
    return link;
  },

  _publicUrl(token, businessId = 'principal') {
    const safeBusiness = /^[A-Za-z0-9_-]{1,80}$/.test(String(businessId || '')) ? String(businessId) : 'principal';
    const relativePath = `/r/${safeBusiness}/${token}`;
    const baseUrl = String(settingsRepo.get('service_public_base_url') || '').trim().replace(/\/+$/, '');
    return { baseUrl, relativePath, url: baseUrl ? `${baseUrl}${relativePath}` : '' };
  },

  getPublicAccess(id, { businessId = 'principal', regenerate = false } = {}, user = {}) {
    const order = db.prepare('SELECT id,number FROM service_orders WHERE id=?').get(Number(id));
    if (!order) throw new Error('Orden de servicio no encontrada');
    return db.transaction(() => {
      if (regenerate) {
        db.prepare(`UPDATE service_public_links SET enabled=0,revoked_at=datetime('now','localtime')
          WHERE service_order_id=? AND enabled=1`).run(order.id);
      }
      let link = db.prepare(`SELECT * FROM service_public_links WHERE service_order_id=? AND enabled=1
        AND revoked_at IS NULL AND (expires_at IS NULL OR datetime(expires_at)>datetime('now','localtime'))
        ORDER BY id DESC LIMIT 1`).get(order.id);
      if (!link) {
        const days = Math.max(1, Math.min(3650,
          Number.parseInt(settingsRepo.get('service_public_link_days'), 10) || 365));
        const publicId = crypto.randomBytes(24).toString('base64url');
        const info = db.prepare(`INSERT INTO service_public_links(
          service_order_id,public_id,expires_at,created_by
        ) VALUES(?,?,datetime('now','localtime',?),?)`).run(
          order.id, publicId, `+${days} days`, Number(user.id) || null
        );
        link = db.prepare('SELECT * FROM service_public_links WHERE id=?').get(Number(info.lastInsertRowid));
        this._event(order.id, 'portal', regenerate ? 'Enlace público regenerado' : 'Portal de seguimiento habilitado', '', user);
      }
      const token = this._tokenForLink(link);
      return {
        order_id: order.id,
        number: order.number,
        token,
        expires_at: link.expires_at,
        access_count: link.access_count,
        last_accessed_at: link.last_accessed_at,
        configured: !!String(settingsRepo.get('service_public_base_url') || '').trim(),
        ...this._publicUrl(token, businessId),
      };
    })();
  },

  revokePublicAccess(id, user = {}) {
    const order = db.prepare('SELECT id FROM service_orders WHERE id=?').get(Number(id));
    if (!order) throw new Error('Orden de servicio no encontrada');
    return db.transaction(() => {
      const changes = db.prepare(`UPDATE service_public_links SET enabled=0,revoked_at=datetime('now','localtime')
        WHERE service_order_id=? AND enabled=1`).run(order.id).changes;
      if (changes) this._event(order.id, 'portal', 'Enlace público revocado', '', user);
      return { ok:true, revoked:changes };
    })();
  },

  _approvalCodeHash(estimateId, code) {
    return crypto.createHmac('sha256', this._portalSecret())
      .update(`approval:${Number(estimateId)}:${String(code)}`).digest('hex');
  },

  _queueNotification(orderId, type) {
    if (!['estado','presupuesto','listo','entregado','garantia'].includes(type)) return;
    db.prepare(`INSERT OR IGNORE INTO service_order_notifications(service_order_id,notification_type)
      VALUES(?,?)`).run(Number(orderId), type);
  },

  preparePublicApproval(id, { businessId = 'principal' } = {}, user = {}) {
    const order = this.getById(id);
    if (!order || order.workflow_status !== 'esperando_aprobacion') {
      throw new Error('La orden no está esperando aprobación');
    }
    return db.transaction(() => {
      const estimate = db.prepare(`SELECT * FROM service_order_estimates WHERE service_order_id=? AND version=?`)
        .get(order.id, order.approval_version);
      if (!estimate || estimate.status !== 'pendiente') throw new Error('El presupuesto vigente no está pendiente');
      const code = String(crypto.randomInt(100000, 1000000));
      db.prepare(`UPDATE service_order_estimates SET public_code_hash=?,public_code_expires_at=datetime('now','localtime','+7 days'),
        public_attempts=0,public_locked_until=NULL WHERE id=?`).run(this._approvalCodeHash(estimate.id, code), estimate.id);
      const access = this.getPublicAccess(order.id, { businessId }, user);
      this._queueNotification(order.id, 'presupuesto');
      this._event(order.id, 'portal', `Código de aprobación generado para presupuesto v${estimate.version}`,
        'Válido por 7 días', user);
      const business = String(settingsRepo.get('biz_name') || 'VELO TECH POS');
      const message = `Hola ${order.customer_name}. ${business} preparó el presupuesto de la orden ${order.number} por RD$${Number(estimate.amount).toFixed(2)}. Revísalo aquí: ${access.url || access.relativePath} Código: ${code}`;
      return { ...access, code, amount:estimate.amount, version:estimate.version, message };
    })();
  },

  publicLookup(token, { touch = true } = {}) {
    if (!this._portalEnabled()) return null;
    const link = this._findPublicLink(token, { touch });
    if (!link) return null;
    const order = this.getById(link.service_order_id);
    if (!order) return null;
    const estimate = order.estimates.find(row => Number(row.version) === Number(order.approval_version)) || null;
    const identifier = String(order.imei || order.serial || order.imei2 || '');
    const safeCustomer = String(order.customer_name || 'Cliente').trim().split(/\s+/)[0] || 'Cliente';
    const visibleEvents = (order.events || []).filter(event =>
      ['recepcion','estado','presupuesto','aprobacion','calidad','entrega','cancelacion'].includes(event.event_type)
    ).map(event => ({ title:event.title, to_status:event.to_status, created_at:event.created_at }));
    return {
      business: {
        name:String(settingsRepo.get('biz_name') || 'VELO TECH POS'),
        phone:String(settingsRepo.get('biz_phone') || ''),
      },
      order: {
        number:order.number, customer_name:safeCustomer, device_desc:order.device_desc,
        brand:order.brand, model:order.model, device_color:order.device_color,
        identifier_hint:identifier.length >= 4 ? `••••${identifier.slice(-4)}` : '',
        problem:order.problem, diagnosis:order.diagnosis, workflow_status:order.workflow_status,
        priority:order.priority, promised_at:order.promised_at, quote_amount:order.quote_amount,
        approval_version:order.approval_version, approved_amount:order.approved_amount,
        approved_at:order.approved_at, quality_checked_at:order.quality_checked_at,
        service_warranty_days:order.service_warranty_days, warranty_until:order.warranty_until,
        created_at:order.created_at, delivered_at:order.delivered_at,
        items:(order.items || []).map(item => ({
          kind:item.kind, description:item.description, qty:item.qty, unit_price:item.unit_price,
          warranty_days:item.warranty_days,warranty_until:item.warranty_until,
        })),
        deposit_total:order.deposit_total,deposit_active:order.deposit_active,
        pickup_due_at:order.pickup_due_at,pickup_notice_count:order.pickup_notice_count,
        pickup_person_name:order.pickup_person_name,pickup_relationship:order.pickup_relationship,
        events:visibleEvents,
        can_decide:order.workflow_status === 'esperando_aprobacion' && estimate?.status === 'pendiente'
          && !!estimate.public_code_hash && (!estimate.public_code_expires_at
            || db.prepare("SELECT datetime(?)>datetime('now','localtime') ok").get(estimate.public_code_expires_at).ok === 1),
        document_available:order.workflow_status === 'entregado',
      },
    };
  },

  publicDecision(token, decision = {}, requestMeta = {}) {
    if (!this._portalEnabled()) throw new Error('El portal está deshabilitado');
    const link = this._findPublicLink(token);
    if (!link) throw new Error('Enlace inválido o vencido');
    const order = this.getById(link.service_order_id);
    if (!order || order.workflow_status !== 'esperando_aprobacion') throw new Error('El presupuesto ya no está pendiente');
    const estimate = db.prepare(`SELECT * FROM service_order_estimates WHERE service_order_id=? AND version=?`)
      .get(order.id, order.approval_version);
    if (!estimate || estimate.status !== 'pendiente') throw new Error('El presupuesto ya fue respondido');
    if (estimate.public_locked_until && db.prepare("SELECT datetime(?)>datetime('now','localtime') ok").get(estimate.public_locked_until).ok) {
      throw new Error('Demasiados intentos. Espera 15 minutos');
    }
    if (!estimate.public_code_expires_at
      || !db.prepare("SELECT datetime(?)>datetime('now','localtime') ok").get(estimate.public_code_expires_at).ok) {
      throw new Error('El código venció. Solicita uno nuevo a la tienda');
    }
    const code = String(decision.code || '').trim();
    const supplied = Buffer.from(this._approvalCodeHash(estimate.id, code));
    const expected = Buffer.from(String(estimate.public_code_hash || ''));
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      const attempts = Number(estimate.public_attempts || 0) + 1;
      db.prepare(`UPDATE service_order_estimates SET public_attempts=?,
        public_locked_until=CASE WHEN ?>=5 THEN datetime('now','localtime','+15 minutes') ELSE NULL END WHERE id=?`)
        .run(attempts, attempts, estimate.id);
      throw new Error(attempts >= 5 ? 'Demasiados intentos. Espera 15 minutos' : 'Código incorrecto');
    }
    const customerName = String(decision.customer_name || '').trim().slice(0, 100);
    if (customerName.length < 2) throw new Error('Escribe el nombre de quien responde');
    if (decision.consent !== true) throw new Error('Confirma que revisaste el presupuesto');
    const approved = decision.approved === true;
    const notes = `Portal del cliente · IP ${String(requestMeta.ip || 'no disponible').slice(0, 80)}`;
    const updated = this.decideEstimate(order.id, {
      approved, method:'portal_cliente', customer_name:customerName, notes,
    }, { name:`Portal · ${customerName}` });
    db.prepare(`UPDATE service_order_estimates SET public_decided_at=datetime('now','localtime'),
      public_code_hash='',public_attempts=0,public_locked_until=NULL WHERE id=?`).run(estimate.id);
    return { order:updated, public:this.publicLookup(token, { touch:false }) };
  },

  getSharePayload(id, type = 'estado', { businessId = 'principal' } = {}, user = {}) {
    const order = this.getById(id);
    if (!order) throw new Error('Orden de servicio no encontrada');
    const access = this.getPublicAccess(order.id, { businessId }, user);
    const url = access.url || access.relativePath;
    const status = String(order.workflow_status || '').replaceAll('_', ' ');
    let message = `Hola ${order.customer_name}. La orden ${order.number} de ${order.device_desc} está: ${status}. Seguimiento: ${url}`;
    if (type === 'listo') {
      message = `Hola ${order.customer_name}. Tu equipo ${order.device_desc}, orden ${order.number}, ya está listo para retirar. Consulta los detalles: ${url}`;
      this._queueNotification(order.id, 'listo');
    } else if (type === 'entregado') {
      message = `Hola ${order.customer_name}. Aquí puedes consultar el documento y la garantía de la orden ${order.number}: ${url}`;
      this._queueNotification(order.id, 'entregado');
    }
    return { ...access, type, phone:order.customer_phone || '', customer_name:order.customer_name, message };
  },

  markNotificationSent(id, type, user = {}) {
    const notification = db.prepare(`SELECT * FROM service_order_notifications
      WHERE service_order_id=? AND notification_type=?`).get(Number(id), String(type || ''));
    if (!notification) return { ok:true, changed:0 };
    const changed = db.prepare(`UPDATE service_order_notifications SET status='prepared',sent_by=?,
      sent_at=datetime('now','localtime') WHERE id=?`).run(Number(user.id) || null, notification.id).changes;
    if (changed) this._event(Number(id), 'notificacion', `Aviso ${type} preparado para WhatsApp`, '', user);
    return { ok:true, changed };
  },

  recordNotificationProvider(id, type, provider = {}, user = {}) {
    this._queueNotification(Number(id), String(type || 'estado'));
    const notification = db.prepare(`SELECT * FROM service_order_notifications
      WHERE service_order_id=? AND notification_type=?`).get(Number(id), String(type || ''));
    if (!notification) throw new Error('No se pudo crear el registro de notificación');
    const status = provider.ok ? 'submitted' : 'failed';
    db.prepare(`UPDATE service_order_notifications SET status=?,provider_status=?,provider_message_id=?,
      provider_error=?,provider_response=?,sent_by=?,sent_at=CASE WHEN ? THEN datetime('now','localtime') ELSE sent_at END,
      updated_at=datetime('now','localtime') WHERE id=?`).run(
      status, String(provider.status || ''), String(provider.messageId || ''), String(provider.error || '').slice(0,1000),
      JSON.stringify(provider.response || {}).slice(0,5000), Number(user.id) || null, provider.ok ? 1 : 0, notification.id,
    );
    this._event(Number(id), 'notificacion', provider.ok
      ? `Aviso ${type} aceptado por WhatsApp Cloud`
      : `Falló el aviso ${type} por WhatsApp Cloud`, provider.ok ? String(provider.messageId || '') : String(provider.error || ''), user);
    return db.prepare('SELECT * FROM service_order_notifications WHERE id=?').get(notification.id);
  },

  list({ status = '', search = '', limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('so.workflow_status=?'); params.push(status); }
    const q = String(search || '').trim();
    if (q) {
      where.push(`(so.number LIKE ? OR so.customer_name LIKE ? OR so.device_desc LIKE ? OR
        so.imei LIKE ? OR so.imei2 LIKE ? OR so.serial LIKE ? OR so.problem LIKE ? OR st.name LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like, like);
    }
    params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
    return db.prepare(`
      SELECT so.*, COALESCE(st.name,u.name) AS technician_name,
             (SELECT COUNT(*) FROM service_order_items i WHERE i.service_order_id=so.id) AS item_count,
             (SELECT COALESCE(SUM(i.qty*i.unit_price),0) FROM service_order_items i WHERE i.service_order_id=so.id) AS items_total,
             CAST(julianday('now','localtime')-julianday(so.created_at) AS INTEGER) AS age_days
      FROM service_orders so
      LEFT JOIN users u ON u.id=so.technician_id
      LEFT JOIN service_technicians st ON st.id=so.service_technician_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE so.workflow_status WHEN 'listo' THEN 0 WHEN 'control_calidad' THEN 1
        WHEN 'reparando' THEN 2 WHEN 'esperando_pieza' THEN 3 WHEN 'esperando_aprobacion' THEN 4 ELSE 5 END,
               so.updated_at DESC, so.id DESC
      LIMIT ?
    `).all(...params);
  },

  getById(id) {
    const row = db.prepare(`
      SELECT so.*, COALESCE(st.name,u.name) AS technician_name, r.name AS received_by_name,
             c.phone AS registered_customer_phone,c.email AS registered_customer_email,c.address AS registered_customer_address,
             pu.status AS unit_status,pu.warranty_until AS unit_warranty_until,
             p.name AS catalog_product_name,p.brand AS catalog_brand,p.model AS catalog_model
      FROM service_orders so
      LEFT JOIN users u ON u.id=so.technician_id
      LEFT JOIN users r ON r.id=so.received_by
      LEFT JOIN customers c ON c.id=so.customer_id
      LEFT JOIN service_technicians st ON st.id=so.service_technician_id
      LEFT JOIN product_units pu ON pu.id=so.product_unit_id
      LEFT JOIN products p ON p.id=pu.product_id
      WHERE so.id=?
    `).get(Number(id));
    if (!row) return null;
    row.items = db.prepare('SELECT * FROM service_order_items WHERE service_order_id=? ORDER BY id').all(row.id);
    row.events = db.prepare('SELECT * FROM service_order_events WHERE service_order_id=? ORDER BY id DESC').all(row.id);
    row.estimates = db.prepare('SELECT * FROM service_order_estimates WHERE service_order_id=? ORDER BY version DESC').all(row.id);
    row.notifications = db.prepare('SELECT * FROM service_order_notifications WHERE service_order_id=? ORDER BY id DESC').all(row.id);
    row.evidence = db.prepare('SELECT * FROM service_order_evidence WHERE service_order_id=? ORDER BY id DESC').all(row.id);
    row.time_entries = db.prepare(`SELECT te.*,st.name technician_name FROM service_time_entries te
      JOIN service_technicians st ON st.id=te.technician_id WHERE te.service_order_id=? ORDER BY te.id DESC`).all(row.id);
    row.procurement = db.prepare(`SELECT pr.*,po.status purchase_status,s.name supplier_name
      FROM service_procurement_requests pr
      LEFT JOIN purchase_orders po ON po.id=pr.purchase_order_id
      LEFT JOIN suppliers s ON s.id=pr.supplier_id
      WHERE pr.service_order_id=? ORDER BY pr.id DESC`).all(row.id);
    row.deposits = db.prepare(`SELECT d.*,fa.name financial_account_name
      FROM service_order_deposits d LEFT JOIN financial_accounts fa ON fa.id=d.financial_account_id
      WHERE d.service_order_id=? ORDER BY d.id`).all(row.id);
    row.deposit_total = round2(row.deposits.filter(deposit => deposit.status !== 'refunded')
      .reduce((sum, deposit) => sum + Number(deposit.amount || 0), 0));
    row.deposit_active = round2(row.deposits.filter(deposit => deposit.status === 'active')
      .reduce((sum, deposit) => sum + Number(deposit.amount || 0), 0));
    const readySince = row.ready_at || (row.workflow_status === 'listo' ? row.updated_at : null);
    row.storage_days = readySince ? Math.max(0, Number(db.prepare(`SELECT CAST(MAX(0,julianday('now','localtime')-julianday(?)-?) AS INTEGER) days`)
      .get(readySince, Number(row.storage_grace_days) || 0).days || 0)) : 0;
    row.storage_fee_accrued = round2(row.storage_days * Math.max(0, Number(row.storage_fee_per_day) || 0));
    if (row.sale_id) row.sale = salesRepo.getById(row.sale_id);
    return row;
  },

  create(data = {}, user = {}) {
    const device = String(data.device_desc || '').trim();
    const problem = String(data.problem || '').trim();
    if (!device) throw new Error('Describe el equipo recibido');
    if (!problem) throw new Error('Describe el problema reportado');
    const occasional = data.customer_is_occasional === true || data.customer_is_occasional === 1;
    let customerId = occasional ? 1 : (Number(data.customer_id) || 1);
    const customer = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(customerId);
    if (!customer) throw new Error('Cliente no encontrado o inactivo');
    const customerName = String(occasional ? data.customer_name : customer.name || '').replace(/\s+/g,' ').trim();
    const customerDocument = String(occasional ? data.customer_document : customer.rnc || '').trim();
    const customerPhone = String(occasional ? data.customer_phone : customer.phone || '').trim();
    const customerAddress = String(occasional ? data.customer_address : customer.address || '').replace(/\s+/g,' ').trim();
    const customerEmail = String(occasional ? data.customer_email : customer.email || '').trim().toLowerCase();
    if (occasional && customerName.length < 3) throw new Error('Indica el nombre de la persona que entrega el equipo');
    if (occasional && customerDocument.replace(/[^A-Za-z0-9]/g,'').length < 5) throw new Error('Indica su cédula, pasaporte o documento');
    if (occasional && customerPhone.replace(/\D/g,'').length < 7) throw new Error('Indica un teléfono válido');
    if (occasional && !data.privacy_consent) throw new Error('La persona debe autorizar el diagnóstico y manejo del equipo');
    if (occasional && !data.intake_signed) throw new Error('La recepción ocasional requiere la firma de la persona');
    return db.transaction(() => {
      const identifier = String(data.imei || data.serial || '').trim();
      let unit = Number(data.product_unit_id)
        ? db.prepare(`SELECT pu.*,p.name product_name,p.brand product_brand,p.model product_model
            FROM product_units pu JOIN products p ON p.id=pu.product_id WHERE pu.id=?`).get(Number(data.product_unit_id))
        : (identifier ? productUnitsRepo.findByImei(identifier) : null);
      if (unit) {
        const activeRepair = db.prepare(`SELECT number FROM service_orders
          WHERE product_unit_id=? AND workflow_status NOT IN ('entregado','cancelado','rechazado','no_reparable','devuelto_sin_reparar') LIMIT 1`).get(unit.id);
        if (activeRepair) throw new Error(`El equipo ya está en la orden ${activeRepair.number}`);
      }
      const next = (db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM service_orders').get().n || 1);
      const number = `SRV-${String(next).padStart(6, '0')}`;
      const info = db.prepare(`
        INSERT INTO service_orders(
          number,customer_id,customer_name,customer_document,customer_phone,customer_address,customer_email,customer_is_occasional,
          product_unit_id,unit_previous_status,parent_order_id,device_desc,imei,imei2,serial,
          brand,model,device_color,battery_health,battery_capacity_mah,problem,workflow_status,service_type,priority,promised_at,
          failure_category,intake_condition,accessories_received,intake_checklist,privacy_consent,intake_signed_name,intake_signed_at,
          technician_id,service_technician_id,received_by,service_warranty_days,notes
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'recepcion',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        number, customer.id, customerName, customerDocument, customerPhone, customerAddress, customerEmail, occasional ? 1 : 0,
        unit?.id || null, String(unit?.status || ''), Number(data.parent_order_id) || null,
        device, String(data.imei || unit?.imei || '').trim(), String(data.imei2 || '').trim(),
        String(data.serial || unit?.serial || '').trim(), String(data.brand || unit?.product_brand || '').trim(),
        String(data.model || unit?.product_model || '').trim(), String(data.device_color || unit?.color || '').trim(),
        data.battery_health === '' || data.battery_health == null
          ? (unit?.battery_health ?? null) : Math.max(0, Math.min(100, Number.parseInt(data.battery_health,10) || 0)),
        data.battery_capacity_mah === '' || data.battery_capacity_mah == null
          ? (unit?.battery_capacity_mah ?? null) : Math.max(0, Math.min(100000, Number.parseInt(data.battery_capacity_mah,10) || 0)),
        problem,
        ['reparacion','garantia','diagnostico','instalacion','visita'].includes(data.service_type) ? data.service_type : 'reparacion',
        ['baja','normal','alta','urgente'].includes(data.priority) ? data.priority : 'normal',
        String(data.promised_at || '').trim() || null,
        ['senal','carga','pantalla','bateria','audio','camaras','conectividad','liquido','no_enciende','otro'].includes(data.failure_category)
          ? data.failure_category : 'otro',
        String(data.intake_condition || '').trim(),
        this._safeJson(data.accessories_received, []), this._safeJson(data.intake_checklist, {}),
        data.privacy_consent ? 1 : 0, String(data.intake_signed_name || customerName).trim(),
        data.intake_signed ? db.prepare("SELECT datetime('now','localtime') value").get().value : null,
        Number(data.technician_id) || null,
        Number(data.service_technician_id) || null, Number(user.id) || null,
        Math.max(0, Math.min(3650, Number.parseInt(
          data.service_warranty_days ?? settingsRepo.get('service_default_warranty_days'), 10
        ) || 0)),
        String(data.notes || '').trim()
      );
      const orderId = Number(info.lastInsertRowid);
      if (unit) db.prepare("UPDATE product_units SET status='servicio' WHERE id=?").run(unit.id);
      this._event(orderId, 'recepcion', 'Equipo recibido',
        `${device}${identifier ? ` · ${identifier}` : ''}`, user, '', 'recepcion');
      this.getPublicAccess(orderId, {}, user);
      return this.getById(orderId);
    })();
  },

  update(id, data = {}) {
    const current = this.getById(id);
    if (!current) throw new Error('Orden de servicio no encontrada');
    if (SERVICE_TERMINAL.has(current.workflow_status)) throw new Error('La orden ya no se puede editar');
    const lockedEstimate = ['esperando_aprobacion','aprobado','esperando_pieza','reparando','control_calidad','listo']
      .includes(current.workflow_status);
    if (lockedEstimate && (Array.isArray(data.items) || data.diagnosis !== undefined || data.quote_amount !== undefined)) {
      throw new Error('El presupuesto está bloqueado. Reábrelo y genera una nueva versión antes de cambiar piezas o precios');
    }
    return db.transaction(() => {
      const diagnosis = data.diagnosis == null ? current.diagnosis : String(data.diagnosis).trim();
      const quoteAmount = data.quote_amount == null ? current.quote_amount : Math.max(0, Number(data.quote_amount) || 0);
      const technicianId = data.technician_id === undefined ? current.technician_id : (Number(data.technician_id) || null);
      const serviceTechnicianId = data.service_technician_id === undefined
        ? current.service_technician_id : (Number(data.service_technician_id) || null);
      const notes = data.notes == null ? current.notes : String(data.notes).trim();
      db.prepare(`UPDATE service_orders SET diagnosis=?,quote_amount=?,technician_id=?,service_technician_id=?,
        promised_at=COALESCE(?,promised_at),priority=COALESCE(?,priority),notes=?,updated_at=datetime('now','localtime') WHERE id=?`)
        .run(diagnosis, quoteAmount, technicianId, serviceTechnicianId,
          data.promised_at === undefined ? null : (String(data.promised_at || '').trim() || null),
          data.priority === undefined ? null : String(data.priority || 'normal'), notes, current.id);
      if (Array.isArray(data.items)) {
        const reserved = current.items.some(i => i.reservation_status !== 'none' || i.qty_reserved || i.qty_consumed);
        if (reserved) throw new Error('No se pueden sustituir partidas con piezas reservadas o consumidas');
        db.prepare('DELETE FROM service_order_items WHERE service_order_id=?').run(current.id);
        const insert = db.prepare(`
          INSERT INTO service_order_items(service_order_id,kind,product_id,description,qty,unit_price,unit_cost,taxable,tax_pct,warranty_days)
          VALUES(?,?,?,?,?,?,?,?,?,?)
        `);
        for (const raw of data.items) {
          const kind = raw.kind === 'parte' ? 'parte' : 'mano_obra';
          const qty = Math.max(1, Math.min(99999, Number.parseInt(raw.qty, 10) || 1));
          const unitPrice = round2(Math.max(0, Number(raw.unit_price) || 0));
          let productId = null;
          let description = String(raw.description || '').trim();
          let unitCost = 0;
          let taxable = normalizeTaxable(raw.taxable, 1);
          let taxPct = normalizeTaxPct(raw.tax_pct, configuredTaxPct());
          if (kind === 'parte') {
            productId = Number(raw.product_id) || null;
            const product = productId ? db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId) : null;
            if (!product) throw new Error('Selecciona un repuesto válido');
            if (product.serialized) throw new Error(`"${product.name}" se controla por IMEI y no puede usarse como repuesto fungible`);
            description = description || product.name;
            unitCost = Number(product.cost) || 0;
            taxable = normalizeTaxable(raw.taxable ?? product.taxable, 1);
            taxPct = normalizeTaxPct(raw.tax_pct ?? product.tax_pct, configuredTaxPct());
          }
          if (!description) throw new Error('Cada partida necesita una descripción');
          const warrantyDays = Math.max(0, Math.min(3650, Number.parseInt(raw.warranty_days,10) || 0));
          insert.run(current.id, kind, productId, description, qty, unitPrice, unitCost, taxable, taxPct, warrantyDays);
        }
      }
      const total = db.prepare('SELECT COALESCE(SUM(qty*unit_price),0) AS n FROM service_order_items WHERE service_order_id=?').get(current.id).n;
      if (data.quote_amount == null && Array.isArray(data.items)) {
        db.prepare('UPDATE service_orders SET quote_amount=? WHERE id=?').run(round2(total), current.id);
      }
      this._event(current.id, 'actualizacion', 'Orden actualizada', '', data.user || {});
      return this.getById(current.id);
    })();
  },

  advance(id, nextStatus, user = {}) {
    const current = this.getById(id);
    if (!current) throw new Error('Orden de servicio no encontrada');
    const allowed = SERVICE_TRANSITIONS[current.workflow_status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new Error('Transición de estado no permitida');
    }
    if (nextStatus === 'presupuesto' && !String(current.diagnosis || '').trim()) {
      throw new Error('Registra el diagnóstico antes de presupuestar');
    }
    if (nextStatus === 'esperando_aprobacion') {
      if (Number(current.quote_amount) <= 0 || !current.items.length) throw new Error('Agrega el presupuesto y sus partidas antes de enviarlo');
      return this.submitEstimate(id, user);
    }
    if (nextStatus === 'reparando') {
      const waiting = current.items.some(i => i.kind === 'parte' && i.reservation_status !== 'reserved');
      if (waiting) throw new Error('Reserva todas las piezas antes de iniciar la reparación');
    }
    if (nextStatus === 'listo' && !current.quality_checked_at) {
      throw new Error('Completa el control de calidad antes de marcar el equipo listo');
    }
    return db.transaction(() => {
      this._setWorkflow(current.id, nextStatus);
      this._event(current.id, 'estado', `Estado: ${nextStatus.replaceAll('_',' ')}`, '', user,
        current.workflow_status, nextStatus);
      if (nextStatus === 'listo') {
        const graceDays = Math.max(0, Math.min(3650, Number(settingsRepo.get('service_pickup_grace_days')) || 7));
        const fee = round2(Math.max(0, Number(settingsRepo.get('service_storage_fee_per_day')) || 0));
        db.prepare(`UPDATE service_orders SET ready_at=datetime('now','localtime'),pickup_due_at=date('now','localtime',?),
          storage_grace_days=?,storage_fee_per_day=? WHERE id=?`).run(`+${graceDays} days`, graceDays, fee, current.id);
        this._queueNotification(current.id, 'listo');
      }
      return this.getById(current.id);
    })();
  },

  submitEstimate(id, user = {}) {
    const current = this.getById(id);
    if (!current) throw new Error('Orden de servicio no encontrada');
    if (current.workflow_status !== 'presupuesto') throw new Error('La orden debe estar en presupuesto');
    if (!current.items.length || Number(current.quote_amount) <= 0) throw new Error('El presupuesto está vacío');
    return db.transaction(() => {
      const version = Number(current.approval_version || 0) + 1;
      const snapshot = {
        diagnosis: current.diagnosis,
        amount: round2(current.items.reduce((sum, item) => sum + Number(item.qty) * Number(item.unit_price), 0)),
        items: current.items.map(item => ({
          kind:item.kind, product_id:item.product_id, description:item.description, qty:item.qty,
          unit_price:item.unit_price, unit_cost:item.unit_cost, taxable:item.taxable, tax_pct:item.tax_pct,
          warranty_days:item.warranty_days,
        })),
      };
      db.prepare(`INSERT INTO service_order_estimates(
        service_order_id,version,amount,status,snapshot_json,created_by
      ) VALUES(?,?,?,'pendiente',?,?)`).run(current.id, version, snapshot.amount, JSON.stringify(snapshot), Number(user.id) || null);
      db.prepare(`UPDATE service_orders SET approval_version=?,quote_amount=?,workflow_status='esperando_aprobacion',
        status='presupuesto',updated_at=datetime('now','localtime') WHERE id=?`).run(version, snapshot.amount, current.id);
      this._event(current.id, 'presupuesto', `Presupuesto v${version} enviado`, `RD$${snapshot.amount.toFixed(2)}`,
        user, current.workflow_status, 'esperando_aprobacion');
      this._queueNotification(current.id, 'presupuesto');
      return this.getById(current.id);
    })();
  },

  _reserveParts(orderId) {
    const current = this.getById(orderId);
    const shortages = [];
    const requested = new Map();
    for (const item of current.items.filter(i => i.kind === 'parte')) {
      const productId = Number(item.product_id);
      const row = requested.get(productId) || { productId, qty:0, description:item.description };
      row.qty += Number(item.qty) || 0;
      requested.set(productId, row);
    }
    for (const request of requested.values()) {
      const product = db.prepare('SELECT id,name,stock,COALESCE(serialized,0) serialized FROM products WHERE id=?').get(request.productId);
      if (!product || product.serialized) throw new Error(`La pieza "${request.description}" no está disponible como inventario fungible`);
      const checkoutReserved = tableExists('checkout_orders') ? (db.prepare(`
        SELECT COALESCE(SUM(i.qty),0) qty FROM checkout_order_items i
        JOIN checkout_orders o ON o.id=i.order_id WHERE i.product_id=? AND o.status='pending'
          AND o.expires_at>datetime('now','localtime')`).get(request.productId).qty || 0) : 0;
      const serviceReserved = db.prepare(`SELECT COALESCE(SUM(qty_reserved),0) qty FROM service_order_items
        WHERE product_id=? AND reservation_status='reserved' AND service_order_id<>?`).get(request.productId, current.id).qty || 0;
      const available = Number(product.stock) - Number(checkoutReserved) - Number(serviceReserved);
      if (available < request.qty) shortages.push(`${product.name}: faltan ${request.qty - Math.max(0, available)}`);
    }
    if (shortages.length) {
      db.prepare(`UPDATE service_order_items SET reservation_status='waiting',qty_reserved=0
        WHERE service_order_id=? AND kind='parte'`).run(current.id);
      return { ok:false, shortages };
    }
    db.prepare(`UPDATE service_order_items SET reservation_status='reserved',qty_reserved=qty
      WHERE service_order_id=? AND kind='parte'`).run(current.id);
    return { ok:true, shortages:[] };
  },

  decideEstimate(id, decision = {}, user = {}) {
    const current = this.getById(id);
    if (!current) throw new Error('Orden de servicio no encontrada');
    if (current.workflow_status !== 'esperando_aprobacion') throw new Error('La orden no está esperando aprobación');
    const approved = decision.approved === true;
    const method = String(decision.method || '').trim();
    const customerName = String(decision.customer_name || current.customer_name || '').trim();
    if (!method) throw new Error('Indica cómo respondió el cliente');
    if (!customerName) throw new Error('Indica quién respondió');
    return db.transaction(() => {
      const estimate = db.prepare(`SELECT * FROM service_order_estimates WHERE service_order_id=? AND version=?`)
        .get(current.id, current.approval_version);
      if (!estimate) throw new Error('No se encontró la versión del presupuesto');
      db.prepare(`UPDATE service_order_estimates SET status=?,decision_method=?,decided_by_name=?,decision_notes=?,
        decided_at=datetime('now','localtime') WHERE id=?`).run(
        approved ? 'aprobado' : 'rechazado', method, customerName, String(decision.notes || '').trim(), estimate.id
      );
      if (!approved) {
        this._setWorkflow(current.id, 'rechazado');
        this._event(current.id, 'aprobacion', `Presupuesto v${estimate.version} rechazado`,
          `${method} · ${customerName}`, user, current.workflow_status, 'rechazado');
        return this.getById(current.id);
      }
      const reservation = this._reserveParts(current.id);
      const next = reservation.ok ? 'aprobado' : 'esperando_pieza';
      db.prepare(`UPDATE service_orders SET approved_amount=?,approval_method=?,approved_by_name=?,approval_notes=?,
        approved_at=datetime('now','localtime') WHERE id=?`).run(
        estimate.amount, method, customerName, String(decision.notes || '').trim(), current.id
      );
      this._setWorkflow(current.id, next);
      this._event(current.id, 'aprobacion', `Presupuesto v${estimate.version} aprobado`,
        reservation.ok ? `${method} · piezas reservadas` : `${method} · ${reservation.shortages.join('; ')}`,
        user, current.workflow_status, next);
      return this.getById(current.id);
    })();
  },

  retryReservations(id, user = {}) {
    const current = this.getById(id);
    if (!current || current.workflow_status !== 'esperando_pieza') throw new Error('La orden no está esperando piezas');
    return db.transaction(() => {
      const result = this._reserveParts(current.id);
      if (!result.ok) throw new Error(`Aún falta inventario: ${result.shortages.join('; ')}`);
      this._setWorkflow(current.id, 'aprobado');
      this._event(current.id, 'inventario', 'Piezas reservadas', '', user, current.workflow_status, 'aprobado');
      return this.getById(current.id);
    })();
  },

  reopenEstimate(id, user = {}) {
    const current = this.getById(id);
    if (!current || !['rechazado','esperando_aprobacion'].includes(current.workflow_status)) {
      throw new Error('Este presupuesto no se puede reabrir');
    }
    return db.transaction(() => {
      db.prepare(`UPDATE service_order_estimates SET status='reemplazado' WHERE service_order_id=? AND status='pendiente'`).run(current.id);
      this._setWorkflow(current.id, 'presupuesto');
      this._event(current.id, 'presupuesto', 'Presupuesto reabierto para revisión', '', user,
        current.workflow_status, 'presupuesto');
      return this.getById(current.id);
    })();
  },

  saveQuality(id, data = {}, user = {}) {
    const current = this.getById(id);
    if (!current || current.workflow_status !== 'control_calidad') throw new Error('La orden no está en control de calidad');
    const checklist = data.checklist && typeof data.checklist === 'object' ? data.checklist : {};
    const entries = Object.entries(checklist);
    if (entries.length < 3) throw new Error('Completa al menos tres pruebas de calidad');
    if (entries.some(([,value]) => value !== true)) throw new Error('Todas las pruebas deben aprobar antes de entregar');
    return db.transaction(() => {
      db.prepare(`UPDATE service_orders SET quality_checklist=?,quality_notes=?,quality_checked_by=?,
        quality_checked_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?`).run(
        JSON.stringify(checklist), String(data.notes || '').trim(), Number(user.id) || null, current.id
      );
      this._event(current.id, 'calidad', 'Control de calidad aprobado', String(data.notes || '').trim(), user);
      return this.getById(current.id);
    })();
  },

  addDeposit(id, data = {}, user = {}, session = null) {
    const order = this.getById(id);
    if (!order || SERVICE_TERMINAL.has(order.workflow_status)) throw new Error('La orden no admite anticipos');
    const amount = round2(Number(data.amount) || 0);
    const quoted = Math.max(Number(order.approved_amount) || 0, Number(order.quote_amount) || 0);
    if (amount <= 0) throw new Error('El anticipo debe ser mayor a cero');
    if (quoted > 0 && round2(Number(order.deposit_active || 0) + amount) > quoted + 0.005) {
      throw new Error('El anticipo supera el total pendiente de la reparación');
    }
    const method = String(data.method || 'efectivo').toLowerCase();
    if (!['efectivo','transferencia','tarjeta','cheque'].includes(method)) throw new Error('Forma de pago no válida');
    if (method === 'efectivo' && !session?.id) throw new Error('Abre la caja antes de recibir efectivo');
    let account = null;
    if (method !== 'efectivo') {
      account = db.prepare('SELECT * FROM financial_accounts WHERE id=? AND active=1').get(Number(data.financial_account_id));
      if (!account) throw new Error('Selecciona la cuenta que recibió el anticipo');
    }
    return db.transaction(() => {
      const info = db.prepare(`INSERT INTO service_order_deposits(
        service_order_id,amount,method,reference,financial_account_id,cash_session_id,received_by,received_by_name
      ) VALUES(?,?,?,?,?,?,?,?)`).run(order.id, amount, method, String(data.reference || '').trim().slice(0,120),
        account?.id || null, session?.id || null, Number(user.id) || null, String(user.name || ''));
      const depositId = Number(info.lastInsertRowid);
      if (session?.id) cashRepo.addMovement({ sessionId:session.id, type:'entrada', amount, method,
        referenceId:depositId, description:`Anticipo ${order.number}`, userId:Number(user.id) || null });
      if (account) financialAccountsRepo.addMovement({ accountId:account.id, type:'deposito', amount,
        description:`Anticipo ${order.number}`, referenceType:'service_order_deposit', referenceId:depositId,
        method, notes:String(data.reference || '').trim(), userId:Number(user.id) || null });
      this._event(order.id, 'anticipo', `Anticipo recibido: RD$${amount.toFixed(2)}`,
        `${method}${data.reference ? ` · ${String(data.reference).trim()}` : ''}`, user);
      return this.getById(order.id);
    })();
  },

  refundDeposit(id, depositId, reason = '', user = {}, session = null) {
    const order = this.getById(id);
    const deposit = order?.deposits?.find(row => Number(row.id) === Number(depositId));
    if (!order || !deposit || deposit.status !== 'active') throw new Error('El anticipo ya no está disponible para devolución');
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) throw new Error('Indica el motivo de la devolución');
    if (deposit.method === 'efectivo' && !session?.id) throw new Error('Abre la caja antes de devolver efectivo');
    return db.transaction(() => {
      if (session?.id) cashRepo.addMovement({ sessionId:session.id, type:'salida', amount:deposit.amount,
        method:deposit.method, referenceId:deposit.id, description:`Devolución anticipo ${order.number}`, userId:Number(user.id) || null });
      if (deposit.financial_account_id) financialAccountsRepo.addMovement({ accountId:deposit.financial_account_id,
        type:'retiro', amount:-Number(deposit.amount), description:`Devolución anticipo ${order.number}`,
        referenceType:'service_order_deposit_refund', referenceId:deposit.id, method:deposit.method,
        notes:cleanReason, userId:Number(user.id) || null });
      db.prepare(`UPDATE service_order_deposits SET status='refunded',refunded_at=datetime('now','localtime'),refund_reason=? WHERE id=?`).run(cleanReason, deposit.id);
      this._event(order.id, 'anticipo_devuelto', `Anticipo devuelto: RD$${Number(deposit.amount).toFixed(2)}`, cleanReason, user);
      return this.getById(order.id);
    })();
  },

  registerPickupNotice(id, data = {}, user = {}) {
    const order = this.getById(id);
    if (!order || order.workflow_status !== 'listo') throw new Error('La orden no está pendiente de retiro');
    const channel = String(data.channel || 'whatsapp').trim();
    db.prepare(`UPDATE service_orders SET pickup_notice_count=pickup_notice_count+1,
      last_pickup_notice_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?`).run(order.id);
    this._event(order.id, 'aviso_retiro', 'Aviso de retiro registrado', channel, user);
    return this.getById(order.id);
  },

  markAbandoned(id, data = {}, user = {}) {
    const order = this.getById(id);
    if (!order || order.workflow_status !== 'listo') throw new Error('Solo un equipo listo puede marcarse como no reclamado');
    if (Number(order.pickup_notice_count || 0) < 1) throw new Error('Registra al menos un aviso al cliente antes de continuar');
    const acknowledgment = String(data.acknowledgment || '');
    if (acknowledgment !== 'CONFIRMO REVISION LEGAL') throw new Error('Confirma que el negocio revisó sus términos y la normativa aplicable');
    db.prepare(`UPDATE service_orders SET abandoned_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?`).run(order.id);
    this._event(order.id, 'no_reclamado', 'Equipo marcado como no reclamado', String(data.notes || '').trim(), user);
    return this.getById(order.id);
  },

  identifierHistory(identifier) {
    const value = String(identifier || '').trim();
    if (!value) throw new Error('Escribe un IMEI o serial');
    const unit = productUnitsRepo.findByImei(value);
    const services = db.prepare(`SELECT id,number,customer_name,device_desc,problem,workflow_status,sale_id,created_at,delivered_at
      FROM service_orders WHERE imei=? OR imei2=? OR serial=? ORDER BY id DESC`).all(value,value,value);
    const sales = db.prepare(`SELECT s.id,s.document_number_fmt,s.customer_name,s.total,s.created_at,si.product_name
      FROM sale_items si JOIN sales s ON s.id=si.sale_id
      WHERE si.product_unit_id=? AND s.status!='cancelled' ORDER BY s.id DESC`).all(unit?.id || -1);
    const purchases = unit ? db.prepare(`SELECT po.id,('OC-' || printf('%04d',po.id)) number,po.supplier_name,po.created_at,pu.unit_cost
      FROM product_units pu LEFT JOIN purchase_orders po ON po.id=pu.purchase_order_id WHERE pu.id=?`).all(unit.id) : [];
    const tradeIns = unit && tableExists('trade_ins') ? db.prepare(`SELECT ti.*,s.document_number_fmt
      FROM trade_ins ti LEFT JOIN sales s ON s.id=ti.sale_id WHERE ti.product_unit_id=? ORDER BY ti.id DESC`).all(unit.id) : [];
    return { identifier:value, unit:unit || null, services, sales, purchases, trade_ins:tradeIns };
  },

  deliver(id, payment = {}, user = {}, session = null) {
    const order = this.getById(id);
    if (!order) throw new Error('Orden de servicio no encontrada');
    if (order.sale_id) return { order, saleResult: salesRepo.getConfirmationById(order.sale_id) };
    if (order.workflow_status !== 'listo') throw new Error('La orden debe estar lista antes de entregarla');
    if (!order.items.length) throw new Error('Agrega piezas o mano de obra antes de entregar');
    const pickupName = String(payment.pickupPersonName || '').replace(/\s+/g,' ').trim();
    const pickupDocument = String(payment.pickupPersonDocument || '').trim();
    const pickupPhone = String(payment.pickupPersonPhone || '').trim();
    if (pickupName.length < 3) throw new Error('Identifica a la persona que retira el equipo');
    if (pickupDocument.replace(/[^A-Za-z0-9]/g,'').length < 5) throw new Error('Indica el documento de quien retira');
    if (!payment.pickupConsent) throw new Error('La persona debe confirmar la recepción del equipo');
    const items = order.items.map(item => item.kind === 'parte' ? {
      product_id: item.product_id,
      product_code: db.prepare('SELECT code FROM products WHERE id=?').get(item.product_id)?.code || 'PARTE',
      product_name: item.description,
      unit_price: Number(item.unit_price) || 0,
      unit_cost: Number(item.unit_cost) || 0,
      qty: Number(item.qty) || 1,
      taxable: item.taxable,
      tax_pct: item.tax_pct,
      service_order_id: order.id,
    } : {
      product_id: null,
      product_code: 'SERVICIO',
      product_name: item.description,
      kind: 'service',
      non_stock: true,
      unit_price: Number(item.unit_price) || 0,
      unit_cost: 0,
      qty: Number(item.qty) || 1,
      taxable: item.taxable,
      tax_pct: item.tax_pct,
      service_order_id: order.id,
    });
    const saleResult = salesRepo.create({
      session,
      customer: {
        id: Number(order.customer_id) || 1,
        name: order.customer_name || 'Consumidor Final',
        rnc: order.customer_document || '',
        phone: order.customer_phone || '',
        address: order.customer_address || '',
        email: order.customer_email || '',
        preserve_customer_snapshot: Number(order.customer_id) !== 1,
      },
      items,
      payment: {
        method: String(payment.method || 'efectivo'),
        ncfType: String(payment.ncfType || ''),
        financialAccountId: Number(payment.financialAccountId) || null,
        reference: String(payment.reference || '').trim(),
        notes: `Orden de servicio ${order.number}${payment.notes ? ` · ${payment.notes}` : ''}`,
        prepaidServiceOrderId: order.id,
      },
      user,
      trustedCustomerSnapshot: true,
      type: 'factura',
      operationId: `service-order-${order.id}`,
    });
    const saleId = saleResult.saleId || saleResult.id;
    db.transaction(() => {
      db.prepare(`UPDATE service_order_items SET qty_consumed=CASE WHEN kind='parte' THEN qty ELSE 0 END,
        qty_reserved=0,reservation_status=CASE WHEN kind='parte' THEN 'consumed' ELSE 'none' END WHERE service_order_id=?`).run(order.id);
      const warrantyDays = Math.max(0, Math.min(3650,
        Number.parseInt(payment.warrantyDays, 10) || Number(order.service_warranty_days) ||
        Number(settingsRepo.get('service_default_warranty_days')) || 0));
      db.prepare(`UPDATE service_orders SET status='entregado',workflow_status='entregado',sale_id=?,
        service_warranty_days=?,warranty_until=CASE WHEN ?>0 THEN date('now','localtime',?) ELSE NULL END,
        pickup_person_name=?,pickup_person_document=?,pickup_person_phone=?,pickup_relationship=?,pickup_authorized_by=?,
        pickup_notes=?,pickup_signed_at=datetime('now','localtime'),
        delivered_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?`)
        .run(saleId, warrantyDays, warrantyDays, `+${warrantyDays} days`, pickupName, pickupDocument, pickupPhone,
          String(payment.pickupRelationship || '').trim(), String(payment.pickupAuthorizedBy || order.customer_name || '').trim(),
          String(payment.pickupNotes || '').trim(), order.id);
      db.prepare(`UPDATE service_order_items SET warranty_until=CASE WHEN warranty_days>0
        THEN date('now','localtime','+' || warranty_days || ' days') ELSE NULL END WHERE service_order_id=?`).run(order.id);
      db.prepare(`UPDATE service_order_deposits SET status='applied',applied_sale_id=?,applied_at=datetime('now','localtime')
        WHERE service_order_id=? AND status='active'`).run(saleId, order.id);
      this._restoreUnitStatus(order);
      this._event(order.id, 'entrega', 'Equipo entregado y facturado', `Venta #${saleId} · garantía ${warrantyDays} días`,
        user, order.workflow_status, 'entregado');
      this._queueNotification(order.id, 'entregado');
    })();
    return { order: this.getById(order.id), saleResult };
  },

  cancel(id, reason = '', user = {}) {
    const current = this.getById(id);
    if (!current) throw new Error('Orden de servicio no encontrada');
    if (SERVICE_TERMINAL.has(current.workflow_status)) throw new Error('La orden ya no puede cancelarse');
    const clean = String(reason || '').trim();
    if (!clean) throw new Error('Indica el motivo de cancelación');
    if (Number(current.deposit_active || 0) > 0) throw new Error('Devuelve o aplica los anticipos activos antes de cancelar la orden');
    return db.transaction(() => {
      db.prepare(`UPDATE service_order_items SET qty_reserved=0,reservation_status='released'
        WHERE service_order_id=? AND reservation_status IN ('reserved','waiting')`).run(current.id);
      db.prepare(`UPDATE service_orders SET status='cancelado',workflow_status='cancelado',
        notes=TRIM(COALESCE(notes,'') || ?),updated_at=datetime('now','localtime') WHERE id=?`)
        .run(`\nCancelación: ${clean}`, current.id);
      this._restoreUnitStatus(current);
      this._event(current.id, 'cancelacion', 'Orden cancelada', clean, user, current.workflow_status, 'cancelado');
      return this.getById(current.id);
    })();
  },

  createWarrantyReturn(id, problem, user = {}, itemId = null) {
    const original = this.getById(id);
    if (!original || original.workflow_status !== 'entregado') throw new Error('La reparación original no está entregada');
    const today = db.prepare("SELECT date('now','localtime') d").get().d;
    const selectedItem = Number(itemId) ? original.items.find(item => Number(item.id) === Number(itemId)) : null;
    if (Number(itemId) && !selectedItem) throw new Error('La cobertura seleccionada no pertenece a esta reparación');
    const warrantyUntil = selectedItem?.warranty_until || original.warranty_until;
    if (!warrantyUntil || warrantyUntil < today) {
      throw new Error('La garantía de esta reparación está vencida o no fue configurada');
    }
    return this.create({
      customer_id: original.customer_id, product_unit_id: original.product_unit_id,
      customer_is_occasional: original.customer_is_occasional,
      customer_name: original.customer_name, customer_document: original.customer_document,
      customer_phone: original.customer_phone, customer_address: original.customer_address, customer_email: original.customer_email,
      parent_order_id: original.id, device_desc: original.device_desc, imei: original.imei,
      imei2: original.imei2, serial: original.serial, brand: original.brand, model: original.model,
      device_color: original.device_color, problem: String(problem || '').trim(),
      service_type: 'garantia', priority: 'alta', privacy_consent: original.privacy_consent,
      intake_condition: original.intake_condition, accessories_received: [],
      service_warranty_days: original.service_warranty_days,
      failure_category: original.failure_category,
      notes: `Reingreso de garantía de ${original.number}${selectedItem ? ` · ${selectedItem.description}` : ''}`,
    }, user);
  },

  technicians() {
    return db.prepare('SELECT * FROM service_technicians WHERE active=1 ORDER BY name').all();
  },

  saveTechnician(data = {}) {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('Indica el nombre del técnico');
    const pct = Math.max(0, Math.min(100, Number(data.commission_pct) || 0));
    if (Number(data.id)) {
      db.prepare(`UPDATE service_technicians SET name=?,phone=?,specialty=?,commission_pct=?,active=? WHERE id=?`).run(
        name, String(data.phone || '').trim(), String(data.specialty || '').trim(), pct,
        data.active === 0 ? 0 : 1, Number(data.id));
      return Number(data.id);
    }
    return Number(db.prepare(`INSERT INTO service_technicians(name,phone,specialty,commission_pct,linked_user_id)
      VALUES(?,?,?,?,?)`).run(name, String(data.phone || '').trim(), String(data.specialty || '').trim(), pct,
      Number(data.linked_user_id) || null).lastInsertRowid);
  },

  addEvidenceMetadata(orderId, evidence = {}, user = {}) {
    const order = db.prepare('SELECT id,number FROM service_orders WHERE id=?').get(Number(orderId));
    if (!order) throw new Error('Orden de servicio no encontrada');
    const allowed = new Set(['recepcion','diagnostico','proceso','entrega','firma_cliente']);
    const type = String(evidence.evidence_type || '').trim();
    if (!allowed.has(type)) throw new Error('Tipo de evidencia no válido');
    const info = db.prepare(`INSERT INTO service_order_evidence(
      service_order_id,evidence_type,storage_path,mime_type,sha256,original_name,note,captured_by
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      order.id, type, String(evidence.storage_path || ''), String(evidence.mime_type || ''),
      String(evidence.sha256 || ''), String(evidence.original_name || '').slice(0,200),
      String(evidence.note || '').slice(0,500), Number(user.id) || null,
    );
    this._event(order.id, 'evidencia', `Evidencia agregada: ${type}`,
      String(evidence.note || evidence.original_name || ''), user);
    return db.prepare('SELECT * FROM service_order_evidence WHERE id=?').get(Number(info.lastInsertRowid));
  },

  listAppointments({ from = '', to = '' } = {}) {
    let where = '1=1'; const params = [];
    if (from) { where += ' AND datetime(sa.starts_at)>=datetime(?)'; params.push(String(from)); }
    if (to) { where += ' AND datetime(sa.starts_at)<datetime(?)'; params.push(String(to)); }
    return db.prepare(`SELECT sa.*,st.name technician_name,so.number order_number
      FROM service_appointments sa
      LEFT JOIN service_technicians st ON st.id=sa.technician_id
      LEFT JOIN service_orders so ON so.id=sa.service_order_id
      WHERE ${where} ORDER BY datetime(sa.starts_at),sa.id`).all(...params);
  },

  saveAppointment(data = {}, user = {}) {
    const startsAt = String(data.starts_at || '').trim();
    const reason = String(data.reason || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T?\d{2}:\d{2}/.test(startsAt)) throw new Error('Indica una fecha y hora válidas');
    if (!reason) throw new Error('Indica el motivo de la cita');
    const status = ['programada','confirmada','en_curso','completada','cancelada','no_asistio'].includes(data.status)
      ? data.status : 'programada';
    if (Number(data.id)) {
      const existing = db.prepare('SELECT id FROM service_appointments WHERE id=?').get(Number(data.id));
      if (!existing) throw new Error('Cita no encontrada');
      db.prepare(`UPDATE service_appointments SET service_order_id=?,customer_id=?,customer_name=?,customer_phone=?,
        device_desc=?,reason=?,starts_at=?,ends_at=?,technician_id=?,status=?,notes=?,updated_at=datetime('now','localtime') WHERE id=?`).run(
        Number(data.service_order_id) || null, Number(data.customer_id) || null, String(data.customer_name || '').trim(),
        String(data.customer_phone || '').trim(), String(data.device_desc || '').trim(), reason, startsAt,
        String(data.ends_at || '').trim() || null, Number(data.technician_id) || null, status,
        String(data.notes || '').trim(), existing.id,
      );
      this._queueAppointmentMessages(existing.id);
      return existing.id;
    }
    const appointmentId = Number(db.prepare(`INSERT INTO service_appointments(service_order_id,customer_id,customer_name,customer_phone,
      device_desc,reason,starts_at,ends_at,technician_id,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      Number(data.service_order_id) || null, Number(data.customer_id) || null, String(data.customer_name || '').trim(),
      String(data.customer_phone || '').trim(), String(data.device_desc || '').trim(), reason, startsAt,
      String(data.ends_at || '').trim() || null, Number(data.technician_id) || null, status,
      String(data.notes || '').trim(), Number(user.id) || null,
    ).lastInsertRowid);
    this._queueAppointmentMessages(appointmentId);
    return appointmentId;
  },

  _queueAppointmentMessages(appointmentId) {
    const appointment = db.prepare('SELECT * FROM service_appointments WHERE id=?').get(Number(appointmentId));
    if (!appointment) return;
    db.prepare("UPDATE service_message_queue SET status='cancelled',updated_at=datetime('now','localtime') WHERE appointment_id=? AND status='pending'").run(appointment.id);
    const phone = String(appointment.customer_phone || '').replace(/\D/g,'');
    if (!phone || ['cancelada','no_asistio'].includes(appointment.status)) return;
    const biz = db.prepare("SELECT value FROM settings WHERE key='biz_name'").get()?.value || 'VELO TECH POS';
    const when = String(appointment.starts_at).replace('T',' ');
    const insert = db.prepare(`INSERT INTO service_message_queue(appointment_id,service_order_id,message_type,destination,message,scheduled_at)
      VALUES(?,?,?,?,?,?)`);
    insert.run(appointment.id,appointment.service_order_id||null,'appointment_confirmation',phone,
      `Hola ${appointment.customer_name || ''}. ${biz} confirma tu cita para ${appointment.reason} el ${when}.`,
      db.prepare("SELECT datetime('now','localtime') value").get().value);
    const reminderAt = db.prepare("SELECT datetime(?,'-24 hours') value").get(appointment.starts_at).value;
    if (reminderAt) insert.run(appointment.id,appointment.service_order_id||null,'appointment_reminder',phone,
      `Recordatorio de ${biz}: tu cita para ${appointment.reason} es el ${when}.`,reminderAt);
  },

  startTimer(orderId, technicianId, notes = '', user = {}) {
    const order = this.getById(orderId);
    if (!order || SERVICE_TERMINAL.has(order.workflow_status)) throw new Error('La orden no admite registro de tiempo');
    const technician = db.prepare('SELECT id,name FROM service_technicians WHERE id=? AND active=1').get(Number(technicianId));
    if (!technician) throw new Error('Selecciona un técnico activo');
    const running = db.prepare("SELECT service_order_id FROM service_time_entries WHERE technician_id=? AND status='running'").get(technician.id);
    if (running) throw new Error('Ese técnico ya tiene un trabajo en curso; deténlo antes de iniciar otro');
    const id = Number(db.prepare(`INSERT INTO service_time_entries(service_order_id,technician_id,notes,created_by)
      VALUES(?,?,?,?)`).run(order.id, technician.id, String(notes || '').trim(), Number(user.id) || null).lastInsertRowid);
    this._event(order.id, 'tiempo', `Tiempo iniciado por ${technician.name}`, '', user);
    return db.prepare('SELECT * FROM service_time_entries WHERE id=?').get(id);
  },

  stopTimer(entryId, user = {}) {
    const entry = db.prepare(`SELECT te.*,st.name technician_name FROM service_time_entries te
      JOIN service_technicians st ON st.id=te.technician_id WHERE te.id=?`).get(Number(entryId));
    if (!entry || entry.status !== 'running') throw new Error('El contador ya no está activo');
    db.prepare(`UPDATE service_time_entries SET ended_at=datetime('now','localtime'),status='stopped',
      duration_minutes=MAX(1,CAST(ROUND((julianday('now','localtime')-julianday(started_at))*1440) AS INTEGER)) WHERE id=?`).run(entry.id);
    const stopped = db.prepare('SELECT * FROM service_time_entries WHERE id=?').get(entry.id);
    this._event(entry.service_order_id, 'tiempo', `Tiempo detenido por ${entry.technician_name}`,
      `${stopped.duration_minutes} minuto(s)`, user);
    return stopped;
  },

  requestPart(orderId, itemId, supplierId, user = {}) {
    return db.transaction(() => {
      const order = this.getById(orderId);
      if (!order || SERVICE_TERMINAL.has(order.workflow_status)) throw new Error('La orden no admite solicitudes de piezas');
      const item = db.prepare(`SELECT * FROM service_order_items WHERE id=? AND service_order_id=? AND kind='parte'`)
        .get(Number(itemId), order.id);
      if (!item) throw new Error('Pieza de la orden no encontrada');
      const needed = Math.max(0, Number(item.qty) - Number(item.qty_reserved || 0));
      if (!needed) throw new Error('Esa pieza ya está reservada completamente');
      const active = db.prepare(`SELECT * FROM service_procurement_requests WHERE service_order_item_id=?
        AND status IN ('solicitada','ordenada','parcial') ORDER BY id DESC LIMIT 1`).get(item.id);
      if (active) return { request:active, purchaseOrderId:active.purchase_order_id };
      const requestId = Number(db.prepare(`INSERT INTO service_procurement_requests(
        service_order_id,service_order_item_id,product_id,description,qty_requested,supplier_id,requested_by
      ) VALUES(?,?,?,?,?,?,?)`).run(order.id, item.id, item.product_id || null, item.description, needed,
        Number(supplierId) || null, Number(user.id) || null).lastInsertRowid);
      let purchaseOrderId = null;
      if (Number(supplierId)) {
        const supplier = db.prepare("SELECT * FROM suppliers WHERE id=? AND status='activo'").get(Number(supplierId));
        if (!supplier) throw new Error('Proveedor no encontrado o inactivo');
        if (!item.product_id) throw new Error('La pieza debe estar enlazada a un producto para crear la compra');
        const product = db.prepare('SELECT * FROM products WHERE id=?').get(item.product_id);
        const purchase = purchasesRepo.create({ supplierId:supplier.id, supplierName:supplier.name,
          notes:`Solicitud automática para ${order.number}`, userId:Number(user.id) || null, cajero:user.name || '',
          items:[{ product_id:product.id, product_code:product.code, product_name:product.name,
            unit_cost:Number(product.cost) || 0, qty_ordered:needed }],
        });
        purchaseOrderId = Number(purchase.poId);
        const purchaseItem = db.prepare('SELECT id FROM purchase_items WHERE purchase_order_id=? ORDER BY id LIMIT 1').get(purchaseOrderId);
        db.prepare('UPDATE purchase_items SET service_procurement_request_id=? WHERE id=?').run(requestId, purchaseItem.id);
        db.prepare(`UPDATE service_procurement_requests SET status='ordenada',purchase_order_id=?,purchase_item_id=?,updated_at=datetime('now','localtime') WHERE id=?`)
          .run(purchaseOrderId, purchaseItem.id, requestId);
      }
      this._event(order.id, 'abastecimiento', `Pieza solicitada: ${item.description}`,
        purchaseOrderId ? `OC #${purchaseOrderId} · ${needed} unidad(es)` : `${needed} unidad(es)`, user);
      return { request:db.prepare('SELECT * FROM service_procurement_requests WHERE id=?').get(requestId), purchaseOrderId };
    })();
  },

  techCatalog() {
    const models = db.prepare(`SELECT dm.*,
      (SELECT COUNT(*) FROM tech_product_compatibility pc WHERE pc.device_model_id=dm.id) compatibility_count
      FROM tech_device_models dm WHERE dm.active=1
      ORDER BY dm.device_type,dm.brand,dm.model,dm.model_code`).all();
    const compatibility = db.prepare(`SELECT pc.*,p.name product_name,p.code product_code,
      dm.device_type,dm.brand,dm.model,dm.model_code
      FROM tech_product_compatibility pc
      JOIN products p ON p.id=pc.product_id
      JOIN tech_device_models dm ON dm.id=pc.device_model_id
      ORDER BY p.name,dm.brand,dm.model`).all();
    return { models, compatibility };
  },

  saveDeviceModel(data = {}) {
    const deviceType = String(data.device_type || 'otro').trim().toLowerCase();
    const brand = String(data.brand || '').trim();
    const model = String(data.model || '').trim();
    const modelCode = String(data.model_code || '').trim();
    if (!brand || !model) throw new Error('Marca y modelo son obligatorios');
    if (Number(data.id)) {
      const changed = db.prepare(`UPDATE tech_device_models SET device_type=?,brand=?,model=?,model_code=?,active=? WHERE id=?`).run(
        deviceType, brand, model, modelCode, data.active === 0 ? 0 : 1, Number(data.id));
      if (!changed.changes) throw new Error('Modelo tecnológico no encontrado');
      return Number(data.id);
    }
    return Number(db.prepare(`INSERT INTO tech_device_models(device_type,brand,model,model_code)
      VALUES(?,?,?,?) ON CONFLICT(brand,model,model_code) DO UPDATE SET device_type=excluded.device_type,active=1
      RETURNING id`).get(deviceType, brand, model, modelCode).id);
  },

  saveCompatibility(data = {}) {
    const productId = Number(data.product_id);
    const modelId = Number(data.device_model_id);
    if (!db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(productId)) throw new Error('Producto no encontrado');
    if (!db.prepare('SELECT id FROM tech_device_models WHERE id=? AND active=1').get(modelId)) throw new Error('Modelo no encontrado');
    const compatibilityType = ['compatible','original','alternativo','no_compatible'].includes(data.compatibility_type)
      ? data.compatibility_type : 'compatible';
    db.prepare(`INSERT INTO tech_product_compatibility(product_id,device_model_id,compatibility_type,notes)
      VALUES(?,?,?,?) ON CONFLICT(product_id,device_model_id) DO UPDATE SET
      compatibility_type=excluded.compatibility_type,notes=excluded.notes`).run(
      productId, modelId, compatibilityType, String(data.notes || '').trim().slice(0,500));
    return this.techCatalog();
  },

  report() {
    const open = db.prepare(`SELECT COUNT(*) n FROM service_orders WHERE workflow_status NOT IN
      ('entregado','cancelado','rechazado','no_reparable','devuelto_sin_reparar')`).get().n;
    const overdue = db.prepare(`SELECT COUNT(*) n FROM service_orders WHERE promised_at IS NOT NULL
      AND datetime(promised_at)<datetime('now','localtime') AND workflow_status NOT IN
      ('entregado','cancelado','rechazado','no_reparable','devuelto_sin_reparar')`).get().n;
    const delivered = db.prepare(`SELECT COUNT(*) n,COALESCE(AVG(julianday(delivered_at)-julianday(created_at)),0) avg_days
      FROM service_orders WHERE workflow_status='entregado'`).get();
    const warrantyReturns = db.prepare(`SELECT COUNT(*) n FROM service_orders WHERE service_type='garantia'`).get().n;
    const byStatus = db.prepare(`SELECT workflow_status status,COUNT(*) count FROM service_orders GROUP BY workflow_status ORDER BY count DESC`).all();
    const byTechnician = db.prepare(`SELECT COALESCE(st.name,'Sin asignar') technician,COUNT(DISTINCT so.id) count,
      COALESCE(SUM(CASE WHEN so.workflow_status='entregado' THEN so.approved_amount ELSE 0 END),0) billed,
      COALESCE((SELECT SUM(te.duration_minutes) FROM service_time_entries te WHERE te.technician_id=st.id AND te.status='stopped'),0) worked_minutes,
      ROUND(COALESCE(SUM(CASE WHEN so.workflow_status='entregado' THEN so.approved_amount ELSE 0 END),0)*COALESCE(st.commission_pct,0)/100.0,2) commission
      FROM service_orders so LEFT JOIN service_technicians st ON st.id=so.service_technician_id
      GROUP BY st.id,st.name ORDER BY count DESC`).all();
    const profitability = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN so.workflow_status='entregado' THEN i.qty*i.unit_price ELSE 0 END),0) revenue,
      COALESCE(SUM(CASE WHEN so.workflow_status='entregado' THEN i.qty*i.unit_cost ELSE 0 END),0) parts_cost,
      COALESCE(SUM(CASE WHEN so.workflow_status='entregado' AND i.kind='mano_obra' THEN i.qty*i.unit_price ELSE 0 END),0) labor_revenue,
      COALESCE(AVG(CASE WHEN so.workflow_status='entregado' THEN julianday(so.delivered_at)-julianday(so.created_at) END),0) cycle_days
      FROM service_orders so LEFT JOIN service_order_items i ON i.service_order_id=so.id`).get();
    profitability.gross_profit = round2(Number(profitability.revenue) - Number(profitability.parts_cost));
    profitability.margin_pct = Number(profitability.revenue) > 0
      ? round2(profitability.gross_profit / Number(profitability.revenue) * 100) : 0;
    const deposits = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status!='refunded' THEN amount ELSE 0 END),0) received,
      COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0) pending_application
      FROM service_order_deposits`).get();
    const unclaimed = db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(MAX(0,
      CAST(julianday('now','localtime')-julianday(COALESCE(ready_at,updated_at))-storage_grace_days AS INTEGER))*storage_fee_per_day),0) fees
      FROM service_orders WHERE workflow_status='listo'`).get();
    return { open, overdue, delivered:delivered.n, average_days:round2(delivered.avg_days), warranty_returns:warrantyReturns,
      by_status:byStatus, by_technician:byTechnician, profitability, deposits, unclaimed };
  },
};

module.exports = {
  suppliersRepo,
  purchasesRepo,
  techPrivatePurchasesRepo,
  techDescriptionTemplatesRepo,
  crmRepo,
  productUnitsRepo,
  serviceOrdersRepo,
  initDB,
  initDetachedDB,
  ensureUppercasePersistence,
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
  saleCorrectionsRepo,
};
