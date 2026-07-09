// ══════════════════════════════════════════════
// versioning.js — Control de versiones y
//                 migraciones automáticas de DB
// Corre SOLO en el main process de Electron
// ══════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── Versión centralizada — siempre desde package.json ──
// Nunca hardcodeada aquí. Así package.json es la única fuente de verdad.
const APP_VERSION = require('./package.json').version;

// ── Migraciones por versión ───────────────────
// Cada migración corre UNA SOLA VEZ por cliente
// Se registra en la tabla db_migrations
const MIGRATIONS = [
  {
    version: '1.0.0',
    description: 'Esquema inicial',
    run(db) {
      // Ya creado por initDB() — no hacer nada
    }
  },
  {
    version: '1.0.1',
    description: 'Agregar campo address a customers',
    run(db) {
      try {
        db.exec(`ALTER TABLE customers ADD COLUMN address TEXT DEFAULT ''`);
      } catch {}
    }
  },
  {
    version: '1.0.2',
    description: 'Agregar campo description a products',
    run(db) {
      try {
        db.exec(`ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''`);
      } catch {}
    }
  },
  {
    version: '1.0.3',
    description: 'Agregar cash_session_id a payments para cuadre de caja',
    run(db) {
      try {
        db.exec(`ALTER TABLE payments ADD COLUMN cash_session_id INTEGER REFERENCES cash_sessions(id)`);
      } catch {}
    }
  },
  {
    version: '1.0.4',
    description: 'Permitir rol superadmin en tabla users',
    run(db) {
      try {
        // SQLite no permite ALTER TABLE para cambiar CHECK constraints
        // Se recrea la tabla con la nueva restricción
        db.exec(`
          CREATE TABLE IF NOT EXISTS users_new (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            email      TEXT NOT NULL UNIQUE,
            password   TEXT NOT NULL,
            role       TEXT NOT NULL CHECK(role IN ('admin','cajero','superadmin')),
            avatar     TEXT DEFAULT '',
            active     INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          );
          INSERT INTO users_new SELECT * FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
      } catch(e) {
        console.log('[MIGRATION 1.0.4] Skipped:', e.message);
      }
    }
  },
  {
    version: '1.0.5',
    description: 'Agregar columna ncf a sales y contador ncf_counter en settings',
    run(db) {
      try {
        db.exec(`ALTER TABLE sales ADD COLUMN ncf TEXT DEFAULT ''`);
      } catch {}
      try {
        const maxId = db.prepare(
          `SELECT MAX(id) as m FROM sales WHERE type='factura'`
        ).get()?.m || 0;
        db.prepare(`
          INSERT INTO settings(key,value)
          VALUES('ncf_counter', ?)
          ON CONFLICT(key) DO NOTHING
        `).run(String(maxId));
        db.prepare(`
          UPDATE sales SET ncf = 'B01' || printf('%09d', id)
          WHERE type='factura' AND (ncf IS NULL OR ncf='')
        `).run();
      } catch(e) {
        console.log('[MIGRATION 1.0.5] ncf_counter:', e.message);
      }
    }
  },
  {
    version: '1.0.6',
    description: 'Eliminar tabla users_new huerfana',
    run(db) {
      try {
        db.exec(`DROP TABLE IF EXISTS users_new`);
      } catch {}
    }
  },
  {
    version: '1.0.7',
    description: 'Agregar columna created_at a sales si no existe',
    run(db) {
      try {
        db.exec(`ALTER TABLE sales ADD COLUMN created_at TEXT DEFAULT (datetime('now'))`);
        console.log('[MIGRATION 1.0.7] created_at agregado a sales');
      } catch {}
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at)`);
      } catch {}
      try {
        db.exec(`ALTER TABLE sales ADD COLUMN ncf TEXT DEFAULT ''`);
      } catch {}
    }
  },
  {
    version: '1.0.8',
    description: 'Agregar ncf_counter y password_changed a settings si no existen',
    run(db) {
      try {
        db.prepare(`INSERT INTO settings(key,value) VALUES('ncf_counter','0') ON CONFLICT(key) DO NOTHING`).run();
        db.prepare(`INSERT INTO settings(key,value) VALUES('password_changed','0') ON CONFLICT(key) DO NOTHING`).run();
      } catch(e) {
        console.log('[MIGRATION 1.0.8]', e.message);
      }
    }
  },
  {
    version: '1.0.9',
    description: 'Agregar columna barcode a products para codigo de barras',
    run(db) {
      try {
        db.exec(`ALTER TABLE products ADD COLUMN barcode TEXT DEFAULT ''`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`);
        console.log('[MIGRATION 1.0.9] columna barcode agregada a products');
      } catch {}
    }
  },
  {
    version: '1.1.0',
    description: 'Crear tablas de proveedores y ordenes de compra',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL,
          contact     TEXT DEFAULT '',
          phone       TEXT DEFAULT '',
          email       TEXT DEFAULT '',
          rnc         TEXT DEFAULT '',
          address     TEXT DEFAULT '',
          notes       TEXT DEFAULT '',
          status      TEXT DEFAULT 'activo',
          created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS purchase_orders (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_id  INTEGER REFERENCES suppliers(id),
          supplier_name TEXT DEFAULT '',
          status       TEXT DEFAULT 'pendiente'
                       CHECK(status IN ('pendiente','recibido','parcial','cancelado')),
          subtotal     REAL DEFAULT 0,
          tax_amt      REAL DEFAULT 0,
          total        REAL DEFAULT 0,
          notes        TEXT DEFAULT '',
          user_id      INTEGER REFERENCES users(id),
          cajero       TEXT DEFAULT '',
          received_at  TEXT,
          created_at   TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS purchase_items (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
          product_id        INTEGER REFERENCES products(id),
          product_code      TEXT DEFAULT '',
          product_name      TEXT NOT NULL,
          unit_cost         REAL NOT NULL DEFAULT 0,
          qty_ordered       INTEGER NOT NULL DEFAULT 0,
          qty_received      INTEGER NOT NULL DEFAULT 0,
          subtotal          REAL DEFAULT 0
        );
      `);
      console.log('[MIGRATION 1.1.0] tablas suppliers y purchase_orders creadas');
    }
  },
  {
    version: '1.1.1',
    description: 'Agregar campo condition a products para productos usados/especiales',
    run(db) {
      try {
        db.exec(`ALTER TABLE products ADD COLUMN condition TEXT DEFAULT 'nuevo'`);
        console.log('[MIGRATION 1.1.1] campo condition agregado a products');
      } catch {}
    }
  },
  {
    version: '1.4.1',
    description: 'Agregar password_changed a users y barcode a products',
    run(db) {
      try {
        db.exec(`ALTER TABLE users ADD COLUMN password_changed TEXT DEFAULT '0'`);
        console.log('[MIGRATION 1.4.1] password_changed agregado a users');
      } catch {}
      try {
        db.exec(`ALTER TABLE products ADD COLUMN barcode TEXT DEFAULT ''`);
        console.log('[MIGRATION 1.4.1] barcode agregado a products');
      } catch {}
    }
  },
  {
    version: '1.4.2',
    description: 'Agregar settings de módulo de etiquetas de código de barras',
    run(db) {
      const ins = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
      ins.run('barcode_enabled', '0');
      ins.run('barcode_printer', '');
      ins.run('barcode_design',  '');
      console.log('[MIGRATION 1.4.2] settings de etiquetas agregados');
    }
  },
  {
    // Versiones 1.4.3 → 1.5.2 — solo mejoras de UI, sin cambios de schema.
    // Consolidadas en una sola entrada para no inflar db_migrations con
    // registros que no aportan información útil de base de datos.
    version: '1.5.2',
    description: 'UI: Dashboard Chart.js, WhatsApp, importador IA, updater, barcode designer',
    run(db) {
      console.log('[MIGRATION 1.5.2] UI y funcionalidades consolidadas — sin cambios de schema');
    }
  },
  {
    version: '1.5.3',
    description: 'Agregar fiscal_enabled — negocios sin RNC no ven NCF ni ITBIS',
    run(db) {
      // Si el negocio ya tiene RNC configurado, activar fiscal automáticamente
      // para no romper instalaciones existentes que sí lo usan.
      try {
        const rnc = db.prepare("SELECT value FROM settings WHERE key='biz_rnc'").get();
        const tieneRnc = rnc?.value && rnc.value.trim().length > 0;
        db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('fiscal_enabled',?)`).run(tieneRnc ? '1' : '0');
        console.log(`[MIGRATION 1.5.3] fiscal_enabled=${tieneRnc ? '1 (RNC detectado)' : '0 (sin RNC)'}`);
      } catch(e) {
        console.log('[MIGRATION 1.5.3]', e.message);
      }
    }
  },

  {
    version: '1.5.4',
    description: 'Módulo Gastos y Cuentas por Pagar — tablas, categorías y config',
    run(db) {
      try {
        // Crear tablas si no existen (idempotente)
        db.prepare(`CREATE TABLE IF NOT EXISTS expense_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          parent_id INTEGER REFERENCES expense_categories(id),
          affects_profit INTEGER DEFAULT 1, requires_approval INTEGER DEFAULT 0,
          approval_limit REAL DEFAULT 0, requires_attachment INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'gasto',
          category_id INTEGER REFERENCES expense_categories(id),
          description TEXT NOT NULL, supplier_id INTEGER REFERENCES suppliers(id),
          amount REAL NOT NULL DEFAULT 0, tax_amount REAL DEFAULT 0, discount REAL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0, currency TEXT DEFAULT 'DOP',
          status TEXT DEFAULT 'pendiente',
          payment_method TEXT DEFAULT 'efectivo', payment_source TEXT DEFAULT 'caja',
          cash_session_id INTEGER REFERENCES cash_sessions(id),
          cash_movement_id INTEGER REFERENCES cash_movements(id),
          issue_date TEXT NOT NULL DEFAULT (date('now')), due_date TEXT,
          invoice_number TEXT, ncf TEXT, supplier_rnc TEXT, notes TEXT,
          user_id INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
          approved_at TEXT, cancelled_by INTEGER REFERENCES users(id),
          cancel_reason TEXT, cancelled_at TEXT, paid_amount REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS expense_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER NOT NULL REFERENCES expenses(id),
          amount REAL NOT NULL, payment_method TEXT DEFAULT 'efectivo', payment_source TEXT DEFAULT 'caja',
          cash_session_id INTEGER REFERENCES cash_sessions(id),
          cash_movement_id INTEGER REFERENCES cash_movements(id),
          reference TEXT, notes TEXT, user_id INTEGER REFERENCES users(id),
          status TEXT DEFAULT 'pagado', cancelled_by INTEGER REFERENCES users(id),
          cancel_reason TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS recurring_expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          supplier_id INTEGER REFERENCES suppliers(id),
          category_id INTEGER REFERENCES expense_categories(id),
          amount REAL NOT NULL DEFAULT 0, frequency TEXT DEFAULT 'mensual',
          day_of_period INTEGER DEFAULT 1, next_date TEXT, end_date TEXT,
          payment_method TEXT DEFAULT 'efectivo', payment_source TEXT DEFAULT 'caja',
          requires_approval INTEGER DEFAULT 0, auto_draft INTEGER DEFAULT 1,
          active INTEGER DEFAULT 1, user_id INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS expense_budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER REFERENCES expense_categories(id),
          month TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
          user_id INTEGER REFERENCES users(id), created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(category_id, month))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS expense_config (key TEXT PRIMARY KEY, value TEXT)`).run();

        // Índices
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(issue_date)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_exp_pay_expense ON expense_payments(expense_id)`).run();

        console.log('[MIGRATION 1.5.4] Módulo de gastos creado');
      } catch(e) {
        console.log('[MIGRATION 1.5.4]', e.message);
      }
    }
  },


  {
    version: '1.5.5',
    description: 'Módulos: Sucursales, Vehículos, Mantenimiento, Envíos, NCF Avanzado + switches',
    run(db) {
      try {
        db.prepare(`CREATE TABLE IF NOT EXISTS branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          address TEXT, phone TEXT, manager TEXT, active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS vehicles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'carro', brand TEXT NOT NULL, model TEXT NOT NULL,
          year INTEGER, plate TEXT, color TEXT,
          fuel_type TEXT DEFAULT 'gasolina', fuel_grade TEXT DEFAULT 'premium',
          km_per_gallon REAL DEFAULT 35, odometer REAL DEFAULT 0,
          status TEXT DEFAULT 'activo', notes TEXT,
          user_id INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS vehicle_maintenance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
          type TEXT NOT NULL, description TEXT, odometer_at REAL, next_odometer REAL,
          date_done TEXT NOT NULL DEFAULT (date('now')), next_date TEXT,
          cost REAL DEFAULT 0, workshop TEXT, notes TEXT,
          user_id INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS vehicle_maintenance_types (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          interval_km INTEGER DEFAULT 0, interval_days INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1)`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS deliveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER REFERENCES sales(id), customer_id INTEGER REFERENCES customers(id),
          vehicle_id INTEGER REFERENCES vehicles(id), driver_id INTEGER REFERENCES users(id),
          origin_address TEXT, dest_address TEXT NOT NULL,
          dest_lat REAL, dest_lng REAL, distance_km REAL,
          fuel_used REAL, fuel_cost REAL, delivery_fee REAL DEFAULT 0,
          status TEXT DEFAULT 'pendiente', scheduled_at TEXT, delivered_at TEXT,
          notes TEXT, user_id INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS ncf_sequences (
          id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, prefix TEXT NOT NULL,
          from_num INTEGER NOT NULL, to_num INTEGER NOT NULL,
          current INTEGER NOT NULL DEFAULT 0, expiry_date TEXT,
          active INTEGER DEFAULT 1, alert_at INTEGER DEFAULT 50,
          created_at TEXT DEFAULT (datetime('now')))`).run();

        db.prepare(`CREATE TABLE IF NOT EXISTS ncf_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ncf TEXT NOT NULL, type TEXT NOT NULL,
          sale_id INTEGER REFERENCES sales(id), customer_rnc TEXT,
          issued_at TEXT DEFAULT (datetime('now')))`).run();

        // Switches de módulos — INSERT OR IGNORE para no sobreescribir si ya existen.
        // Si el valor es inválido (no '0' ni '1'), resetear a '0' para evitar UI corrupta.
        const insS = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
        const fixS = db.prepare("UPDATE settings SET value='0' WHERE key=? AND value NOT IN ('0','1')");
        [
          ['module_sucursales','0'], ['module_vehiculos','0'],
          ['module_mantenimiento','0'], ['module_envios','0'],
          ['module_ncf_avanzado','0'], ['module_multi_negocio','0'],
          ['mod_envios_cajero','0'], ['mod_vehiculos_admin','1'],
          ['fuel_price_premium','293'], ['fuel_price_regular','276'],
          ['fuel_price_diesel','239'], ['fuel_last_updated',''], ['ors_api_key',''],
        ].forEach(([k,v]) => { insS.run(k,v); fixS.run(k); });

        console.log('[MIGRATION 1.5.5] Módulos Sucursales/Vehículos/Envíos/NCF creados');
      } catch(e) {
        console.log('[MIGRATION 1.5.5]', e.message);
      }
    }
  },

  // ── MÓDULO CONTABILIDAD Y BANCOS ─────────────────────────────────────────
  {
    version: '1.6.0',
    description: 'Módulo Bancos/Cuentas Financieras — tablas y cuenta Caja General inicial',
    run(db) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS financial_accounts (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            type            TEXT NOT NULL DEFAULT 'caja'
                              CHECK(type IN ('caja','caja_chica','banco','tarjeta','transferencia','otro')),
            bank_name       TEXT DEFAULT '',
            account_number  TEXT DEFAULT '',
            currency        TEXT DEFAULT 'DOP',
            initial_balance REAL DEFAULT 0,
            current_balance REAL DEFAULT 0,
            description     TEXT DEFAULT '',
            active          INTEGER DEFAULT 1,
            user_id         INTEGER REFERENCES users(id),
            notes           TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS financial_movements (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            financial_account_id INTEGER NOT NULL REFERENCES financial_accounts(id),
            type                TEXT NOT NULL
                                  CHECK(type IN ('deposito','retiro','transferencia_in',
                                    'transferencia_out','venta','gasto','abono_recibido',
                                    'pago_proveedor','apertura','ajuste')),
            amount              REAL NOT NULL,
            balance_before      REAL NOT NULL DEFAULT 0,
            balance_after       REAL NOT NULL DEFAULT 0,
            description         TEXT NOT NULL DEFAULT '',
            reference_type      TEXT DEFAULT '',
            reference_id        INTEGER,
            related_account_id  INTEGER REFERENCES financial_accounts(id),
            method              TEXT DEFAULT 'efectivo',
            notes               TEXT DEFAULT '',
            user_id             INTEGER REFERENCES users(id),
            status              TEXT DEFAULT 'activo' CHECK(status IN ('activo','anulado')),
            cancelled_by        INTEGER REFERENCES users(id),
            cancel_reason       TEXT,
            cancelled_at        TEXT,
            created_at          TEXT DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_fin_mov_account ON financial_movements(financial_account_id);
          CREATE INDEX IF NOT EXISTS idx_fin_mov_type    ON financial_movements(type);
          CREATE INDEX IF NOT EXISTS idx_fin_mov_date    ON financial_movements(created_at);
          CREATE INDEX IF NOT EXISTS idx_fin_mov_ref     ON financial_movements(reference_type, reference_id);
        `);

        // Crear cuenta Caja General inicial si no existe
        const existing = db.prepare("SELECT COUNT(*) as c FROM financial_accounts").get().c;
        if (existing === 0) {
          const openSession = db.prepare("SELECT * FROM cash_sessions WHERE status='open' LIMIT 1").get();
          const currentCash = openSession ? (openSession.open_amount || 0) : 0;
          const r = db.prepare(`
            INSERT INTO financial_accounts(name, type, currency, initial_balance, current_balance, description, active)
            VALUES('Caja General', 'caja', 'DOP', 0, ?, 'Caja principal del negocio', 1)
          `).run(currentCash);
          if (currentCash > 0) {
            db.prepare(`
              INSERT INTO financial_movements(financial_account_id, type, amount, balance_before, balance_after, description)
              VALUES(?, 'apertura', ?, 0, ?, 'Balance inicial de caja')
            `).run(r.lastInsertRowid, currentCash, currentCash);
          }
          db.prepare(`
            INSERT INTO financial_accounts(name, type, currency, initial_balance, current_balance, description, active)
            VALUES('Banco Principal', 'banco', 'DOP', 0, 0, 'Cuenta bancaria principal', 1)
          `).run();
        }

        console.log('[MIGRATION 1.6.0] Módulo Bancos/Cuentas Financieras creado');
      } catch(e) {
        console.error('[MIGRATION 1.6.0]', e.message);
      }
    }
  },

  {
    version: '1.6.1',
    description: 'Módulo Contabilidad — catálogo de cuentas, asientos y configuración',
    run(db) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS accounting_accounts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL
                          CHECK(type IN ('activo','pasivo','capital','ingreso','costo','gasto','impuesto')),
            subtype     TEXT DEFAULT '',
            parent_id   INTEGER REFERENCES accounting_accounts(id),
            description TEXT DEFAULT '',
            is_summary  INTEGER DEFAULT 0,
            balance     REAL DEFAULT 0,
            active      INTEGER DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS accounting_entries (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            number        TEXT UNIQUE NOT NULL,
            date          TEXT NOT NULL,
            concept       TEXT NOT NULL,
            reference     TEXT DEFAULT '',
            source_module TEXT DEFAULT '',
            source_id     INTEGER,
            total_debit   REAL NOT NULL DEFAULT 0,
            total_credit  REAL NOT NULL DEFAULT 0,
            status        TEXT DEFAULT 'confirmado'
                            CHECK(status IN ('borrador','confirmado','anulado')),
            notes         TEXT DEFAULT '',
            user_id       INTEGER REFERENCES users(id),
            reversed_by   INTEGER REFERENCES accounting_entries(id),
            reversal_of   INTEGER REFERENCES accounting_entries(id),
            created_at    TEXT DEFAULT (datetime('now')),
            updated_at    TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS accounting_entry_lines (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id    INTEGER NOT NULL REFERENCES accounting_entries(id),
            account_id  INTEGER NOT NULL REFERENCES accounting_accounts(id),
            description TEXT DEFAULT '',
            debit       REAL NOT NULL DEFAULT 0,
            credit      REAL NOT NULL DEFAULT 0,
            reference   TEXT DEFAULT '',
            created_at  TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS accounting_config (
            key        TEXT PRIMARY KEY,
            account_id INTEGER REFERENCES accounting_accounts(id),
            value      TEXT DEFAULT '',
            description TEXT DEFAULT '',
            updated_at  TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS accounting_periods (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            date_from  TEXT NOT NULL,
            date_to    TEXT NOT NULL,
            status     TEXT DEFAULT 'abierto' CHECK(status IN ('abierto','cerrado')),
            notes      TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_acc_entries_date   ON accounting_entries(date);
          CREATE INDEX IF NOT EXISTS idx_acc_entries_module ON accounting_entries(source_module, source_id);
          CREATE INDEX IF NOT EXISTS idx_acc_lines_entry    ON accounting_entry_lines(entry_id);
          CREATE INDEX IF NOT EXISTS idx_acc_lines_account  ON accounting_entry_lines(account_id);
          CREATE INDEX IF NOT EXISTS idx_acc_accounts_code  ON accounting_accounts(code);
          CREATE INDEX IF NOT EXISTS idx_acc_accounts_type  ON accounting_accounts(type);
        `);

        console.log('[MIGRATION 1.6.1] Módulo Contabilidad — tablas creadas');
      } catch(e) {
        console.error('[MIGRATION 1.6.1]', e.message);
      }
    }
  },

  {
    version: '1.6.2',
    description: 'Catálogo de cuentas inicial y mapeo contable para RD',
    run(db) {
      try {
        seedAccountingCatalog(db);
        console.log('[MIGRATION 1.6.2] Catálogo de cuentas y configuración contable creados');
      } catch(e) {
        console.error('[MIGRATION 1.6.2]', e.message);
      }
    }
  },
  {
    version: '1.6.3',
    description: 'Agregar module_contabilidad a settings',
    run(db) {
      try {
        const ins = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
        ins.run('module_contabilidad', '0');
        console.log('[MIGRATION 1.6.3] module_contabilidad agregado a settings');
      } catch(e) {
        console.error('[MIGRATION 1.6.3]', e.message);
      }
    }
  },

  {
    version: '1.6.4',
    description: 'Permisos por rol para cada módulo',
    run(db) {
      try {
        const ins = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
        // Por defecto todos los módulos son solo admin.
        // module_envios mantiene acceso cajero para compatibilidad con versiones anteriores.
        ins.run('module_gastos_roles',        'admin');
        ins.run('module_contabilidad_roles',  'admin');
        ins.run('barcode_enabled_roles',      'admin');
        ins.run('module_sucursales_roles',    'admin');
        ins.run('module_vehiculos_roles',     'admin');
        ins.run('module_mantenimiento_roles', 'admin');
        ins.run('module_envios_roles',        'admin,cajero');
        ins.run('module_ncf_avanzado_roles',  'admin');
        ins.run('fiscal_enabled_roles',       'admin');
        console.log('[MIGRATION 1.6.4] Permisos por rol creados');
      } catch(e) {
        console.error('[MIGRATION 1.6.4]', e.message);
      }
    }
  },
  {
    version: '1.6.5',
    description: 'Índices de rendimiento y seguridad adicionales',
    run(db) {
      try {
        // Índices para consultas de crédito y búsqueda de clientes
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_customers_status
            ON customers(status) WHERE active=1;

          CREATE INDEX IF NOT EXISTS idx_customers_balance
            ON customers(balance) WHERE active=1 AND balance > 0;

          CREATE INDEX IF NOT EXISTS idx_sales_customer_status
            ON sales(customer_id, status);

          CREATE INDEX IF NOT EXISTS idx_cash_user_status
            ON cash_sessions(user_id, status);

          CREATE INDEX IF NOT EXISTS idx_payments_date
            ON payments(created_at);

          CREATE INDEX IF NOT EXISTS idx_inv_movements_date
            ON inventory_movements(created_at);

          CREATE INDEX IF NOT EXISTS idx_audit_entity_ref
            ON audit_logs(entity, entity_id);
        `);
        console.log('[MIGRATION 1.6.5] Índices adicionales creados');
      } catch(e) {
        console.error('[MIGRATION 1.6.5]', e.message);
      }
    }
  },
  {
    version: '1.6.6',
    description: 'Índice de auditoría por entidad y referencia',
    run(db) {
      try {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_audit_entity_ref
            ON audit_logs(entity, entity_id);
        `);
        console.log('[MIGRATION 1.6.6] Índice audit_entity_ref creado');
      } catch(e) {
        console.error('[MIGRATION 1.6.6]', e.message);
      }
    }
  },
  {
    version: '1.9.0',
    description: 'Corrige aviso de cambio de contraseña obligatorio que se disparaba siempre por un bug de lectura — marcar usuarios existentes como ya cambiada para no interrumpirlos de golpe',
    run(db) {
      try {
        // users.password_changed ya existe desde la migración 1.4.1, pero un bug
        // en el frontend nunca lo leía correctamente, así que en la práctica
        // nunca se actualizaba. Al corregir esa lectura, todo usuario existente
        // se vería forzado a cambiar contraseña en su próximo login.
        // Solo aplicar el backfill si el negocio ya tiene actividad real
        // (ventas registradas) — así no afecta una instalación recién
        // sembrada, donde admin/cajero SÍ deben cambiar su clave por defecto.
        const tieneVentas = db.prepare('SELECT COUNT(*) as c FROM sales').get().c > 0;
        if (tieneVentas) {
          db.prepare(`UPDATE users SET password_changed='1' WHERE password_changed IS NULL OR password_changed='0'`).run();
          console.log('[MIGRATION 1.9.0] Usuarios existentes marcados como password_changed=1');
        } else {
          console.log('[MIGRATION 1.9.0] Instalación nueva sin ventas — no se aplica backfill');
        }
      } catch(e) {
        console.error('[MIGRATION 1.9.0]', e.message);
      }
    }
  },
  {
    version: '1.9.6',
    description: 'Corrige nombre del cliente FRANCISCO ORTIZ → FRANCISCO YSAC ORTIZ ROSARIO',
    run(db) {
      try {
        const result = db.prepare(`
          UPDATE customers
          SET name = 'FRANCISCO YSAC ORTIZ ROSARIO'
          WHERE name = 'FRANCISCO ORTIZ'
            AND phone = '809-912-1199'
        `).run();
        if (result.changes > 0) {
          console.log('[MIGRATION 1.9.6] Cliente FRANCISCO ORTIZ renombrado a FRANCISCO YSAC ORTIZ ROSARIO');
        } else {
          console.log('[MIGRATION 1.9.6] Cliente ya tiene el nombre correcto o no existe — sin cambios');
        }
      } catch(e) {
        console.error('[MIGRATION 1.9.6]', e.message);
      }
    }
  },
  {
    version: '1.10.9',
    description: 'Repara catálogo contable vacío (re-siembra idempotente del plan de cuentas)',
    run(db) {
      try {
        // Algunas instalaciones quedaron con el catálogo contable vacío
        // (p.ej. tras "Resetear Datos", que borraba accounting_accounts sin
        // volver a sembrarlo, y como 1.6.2 ya figuraba aplicada no se regeneraba).
        // Esto lo reconstruye de forma idempotente: INSERT OR IGNORE, no duplica
        // ni borra, y NO toca datos importados (productos/ventas/clientes están
        // en otras tablas). En una instalación sana es un no-op.
        const before = db.prepare('SELECT COUNT(*) c FROM accounting_accounts').get().c;
        seedAccountingCatalog(db);
        const after = db.prepare('SELECT COUNT(*) c FROM accounting_accounts').get().c;
        console.log(`[MIGRATION 1.10.9] Catálogo contable: ${before} → ${after} cuentas`);
      } catch(e) {
        console.error('[MIGRATION 1.10.9]', e.message);
      }
    }
  },
  {
    version: '1.10.10',
    description: 'Módulo de Conduce / Nota de Entrega (delivery_notes) — documento de entrega, NO fiscal',
    run(db) {
      try {
        // Conduce = nota de entrega/despacho. NO es factura, NO genera NCF ni ITBIS,
        // NO crea cuenta por cobrar y (por decisión de arquitectura) NO mueve inventario
        // por sí mismo: el stock sale en la FACTURA, como en todo el sistema. El conduce
        // documenta la entrega y puede enlazarse a una factura para trazabilidad.
        // Arquitectura single-almacén (el inventario es global): sin warehouse_id.
        db.exec(`
          CREATE TABLE IF NOT EXISTS delivery_notes (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            number              TEXT UNIQUE NOT NULL,
            customer_id         INTEGER REFERENCES customers(id),
            customer_name       TEXT DEFAULT 'Consumidor Final',
            customer_rnc        TEXT DEFAULT '',
            branch_id           INTEGER REFERENCES branches(id),
            source_type         TEXT DEFAULT 'manual'
                                  CHECK(source_type IN ('manual','cotizacion','factura')),
            source_id           INTEGER,
            status              TEXT DEFAULT 'borrador'
                                  CHECK(status IN ('borrador','preparado','despachado','entregado','parcial','facturado','anulado','devuelto')),
            issue_date          TEXT DEFAULT (date('now','localtime')),
            dispatch_date       TEXT,
            received_date       TEXT,
            delivery_address    TEXT DEFAULT '',
            driver_name         TEXT DEFAULT '',
            vehicle_plate       TEXT DEFAULT '',
            received_by_name    TEXT DEFAULT '',
            received_by_document TEXT DEFAULT '',
            notes               TEXT DEFAULT '',
            invoice_id          INTEGER REFERENCES sales(id),
            created_by          INTEGER REFERENCES users(id),
            dispatched_by       INTEGER REFERENCES users(id),
            received_by_user_id INTEGER REFERENCES users(id),
            cancelled_by        INTEGER REFERENCES users(id),
            cancellation_reason TEXT DEFAULT '',
            created_at          TEXT DEFAULT (datetime('now','localtime')),
            updated_at          TEXT DEFAULT (datetime('now','localtime'))
          );

          CREATE TABLE IF NOT EXISTS delivery_note_items (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            delivery_note_id INTEGER NOT NULL REFERENCES delivery_notes(id),
            product_id       INTEGER REFERENCES products(id),
            sku              TEXT DEFAULT '',
            description      TEXT NOT NULL,
            unit             TEXT DEFAULT 'und',
            requested_qty    REAL NOT NULL DEFAULT 0,
            delivered_qty    REAL NOT NULL DEFAULT 0,
            pending_qty      REAL NOT NULL DEFAULT 0,
            lot_number       TEXT DEFAULT '',
            serial_number    TEXT DEFAULT '',
            notes            TEXT DEFAULT '',
            created_at       TEXT DEFAULT (datetime('now','localtime')),
            updated_at       TEXT DEFAULT (datetime('now','localtime'))
          );

          CREATE TABLE IF NOT EXISTS delivery_note_invoice_links (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            delivery_note_id      INTEGER NOT NULL REFERENCES delivery_notes(id),
            delivery_note_item_id INTEGER REFERENCES delivery_note_items(id),
            invoice_id            INTEGER NOT NULL REFERENCES sales(id),
            product_id            INTEGER REFERENCES products(id),
            qty_linked            REAL NOT NULL DEFAULT 0,
            created_at            TEXT DEFAULT (datetime('now','localtime'))
          );

          CREATE INDEX IF NOT EXISTS idx_dn_status    ON delivery_notes(status);
          CREATE INDEX IF NOT EXISTS idx_dn_customer  ON delivery_notes(customer_id);
          CREATE INDEX IF NOT EXISTS idx_dn_source    ON delivery_notes(source_type, source_id);
          CREATE INDEX IF NOT EXISTS idx_dn_invoice   ON delivery_notes(invoice_id);
          CREATE INDEX IF NOT EXISTS idx_dni_note     ON delivery_note_items(delivery_note_id);
          CREATE INDEX IF NOT EXISTS idx_dnl_note     ON delivery_note_invoice_links(delivery_note_id);
          CREATE INDEX IF NOT EXISTS idx_dnl_invoice  ON delivery_note_invoice_links(invoice_id);
        `);

        // Módulo desactivado por defecto + permisos por rol (patrón del sistema).
        const ins = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
        ins.run('module_conduce',        '0');
        ins.run('module_conduce_roles',  'admin');
        // Mostrar precios de referencia en la impresión del conduce: apagado por defecto.
        ins.run('conduce_show_prices',   '0');

        console.log('[MIGRATION 1.10.10] Módulo de Conduce creado (tablas + settings)');
      } catch(e) {
        console.error('[MIGRATION 1.10.10]', e.message);
      }
    }
  },
  {
    version: '1.11.2',
    description: 'Bancos: columna transfer_group para enlazar y anular juntas las dos patas de una transferencia',
    run(db) {
      // Idempotente: PRAGMA para no re-ALTERar si la columna ya existe. Sin try/catch
      // que trague errores — si algo falla, el runner revierte y NO marca la migración
      // como aplicada (reintenta en el próximo arranque, sin dejar estado a medias).
      const cols = db.prepare("PRAGMA table_info(financial_movements)").all().map(c => c.name);
      if (!cols.includes('transfer_group')) {
        db.exec("ALTER TABLE financial_movements ADD COLUMN transfer_group TEXT");
        console.log('[MIGRATION 1.11.2] Columna transfer_group añadida a financial_movements');
      } else {
        console.log('[MIGRATION 1.11.2] transfer_group ya existía — sin cambios');
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_fin_mov_transfer_group ON financial_movements(transfer_group)");
    }
  },
  {
    version: '1.11.3',
    description: 'Fiscal: ncf_log.modifies_ncf — nota de crédito B04 referencia el NCF de la factura devuelta',
    run(db) {
      // Idempotente (PRAGMA guard). Sin try/catch que trague: si falla, el runner
      // revierte y no marca la migración → reintenta al próximo arranque.
      const cols = db.prepare("PRAGMA table_info(ncf_log)").all().map(c => c.name);
      if (!cols.includes('modifies_ncf')) {
        db.exec("ALTER TABLE ncf_log ADD COLUMN modifies_ncf TEXT");
        console.log('[MIGRATION 1.11.3] Columna modifies_ncf añadida a ncf_log');
      } else {
        console.log('[MIGRATION 1.11.3] modifies_ncf ya existía — sin cambios');
      }
    }
  },
  {
    version: '1.11.4',
    description: 'Fiscal: ncf_log.status/voided_at — marca NCF de factura anulada para el reporte 608',
    run(db) {
      // Idempotente (PRAGMA guard). status por defecto 'emitido' aplica también a
      // las filas existentes. Sin try/catch que trague: si falla, el runner revierte.
      const cols = db.prepare("PRAGMA table_info(ncf_log)").all().map(c => c.name);
      if (!cols.includes('status')) {
        db.exec("ALTER TABLE ncf_log ADD COLUMN status TEXT DEFAULT 'emitido'");
        console.log('[MIGRATION 1.11.4] Columna status añadida a ncf_log');
      }
      if (!cols.includes('voided_at')) {
        db.exec("ALTER TABLE ncf_log ADD COLUMN voided_at TEXT");
        console.log('[MIGRATION 1.11.4] Columna voided_at añadida a ncf_log');
      }
    }
  },
  {
    version: '1.14.1',
    description: 'Multi-terminal: terminal_id en cash_sessions (caja por terminal)',
    run(db) {
      // Aditiva e idempotente (PRAGMA guard). NULL en filas existentes = compatible:
      // getOpen(terminalId) trata las sesiones legacy sin terminal_id como propias,
      // así NO se pierde ninguna caja abierta al actualizar. No toca montos ni cuadre.
      const cols = db.prepare("PRAGMA table_info(cash_sessions)").all().map(c => c.name);
      if (!cols.includes('terminal_id')) {
        db.exec("ALTER TABLE cash_sessions ADD COLUMN terminal_id TEXT");
        console.log('[MIGRATION 1.14.1] Columna terminal_id añadida a cash_sessions');
      }
    }
  },
];

// ══════════════════════════════════════════════
// CATÁLOGO CONTABLE (reutilizable e idempotente)
// ──────────────────────────────────────────────
// Siembra el plan de cuentas RD y su mapeo por defecto. Usa INSERT OR IGNORE
// y resuelve el parent por CÓDIGO (no por lastInsertRowid), así que es seguro
// llamarlo múltiples veces: nunca duplica ni borra, y no toca datos importados
// (productos, ventas, clientes, etc. viven en otras tablas). Se usa en:
//   · la migración inicial 1.6.2 (instalación nueva),
//   · la migración de reparación 1.10.9 (catálogo quedó vacío), y
//   · business:resetData (para no dejar el catálogo vacío tras un reset).
// Devuelve el total de cuentas resultante.
function seedAccountingCatalog(db) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO accounting_accounts(code, name, type, subtype, parent_id, description, is_summary, active)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const idOf = (code) => {
    if (code == null) return null;
    const r = db.prepare('SELECT id FROM accounting_accounts WHERE code=?').get(String(code));
    return r ? r.id : null;
  };

  // [code, name, type, subtype, parentCode, description, is_summary]
  // Los padres van antes que los hijos → idOf(parentCode) siempre resuelve.
  const ACCOUNTS = [
    ['1','ACTIVOS','activo','',null,'Grupo activos',1],
    ['11','Activo Corriente','activo','corriente','1','',1],
    ['1101','Caja General','activo','efectivo','11','Efectivo en caja',0],
    ['1102','Caja Chica','activo','efectivo','11','Fondo de caja chica',0],
    ['1103','Bancos','activo','banco','11','Saldos en cuentas bancarias',0],
    ['1104','Cuentas por Cobrar','activo','cobrar','11','Ventas a crédito pendientes',0],
    ['1105','Inventario de Mercancías','activo','inventario','11','Mercancía disponible para venta',0],
    ['1106','ITBIS Acreditable','activo','impuesto','11','ITBIS pagado en compras recuperable',0],
    ['1107','Otros Activos Corrientes','activo','','11','',0],
    ['12','Activo No Corriente','activo','fijo','1','',1],
    ['1201','Mobiliario y Equipo','activo','fijo','12','',0],
    ['1202','Equipos de Cómputo','activo','fijo','12','',0],
    ['1203','Dep. Acumulada Mobiliario','activo','fijo','12','Cuenta contranatura (saldo acreedor)',0],
    ['2','PASIVOS','pasivo','',null,'Grupo pasivos',1],
    ['21','Pasivo Corriente','pasivo','corriente','2','',1],
    ['2101','Cuentas por Pagar','pasivo','pagar','21','Deudas con proveedores',0],
    ['2102','ITBIS por Pagar','pasivo','impuesto','21','ITBIS cobrado en ventas a remitir a DGII',0],
    ['2103','Retenciones por Pagar','pasivo','impuesto','21','Retenciones ISR a pagar',0],
    ['2104','Sueldos por Pagar','pasivo','','21','',0],
    ['2105','Otros Pasivos Corrientes','pasivo','','21','',0],
    ['22','Pasivo a Largo Plazo','pasivo','largo','2','',1],
    ['2201','Préstamos Bancarios','pasivo','prestamo','22','',0],
    ['3','CAPITAL','capital','',null,'Patrimonio del propietario',1],
    ['3101','Capital Social','capital','','3','Capital inicial del negocio',0],
    ['3102','Aportes del Propietario','capital','','3','',0],
    ['3103','Retiros del Propietario','capital','','3','Cuenta contranatura',0],
    ['3104','Utilidades Acumuladas','capital','','3','Utilidades de períodos anteriores',0],
    ['3105','Utilidad/Pérdida del Período','capital','','3','Resultado del período actual',0],
    ['4','INGRESOS','ingreso','',null,'Grupo ingresos',1],
    ['41','Ingresos Operacionales','ingreso','','4','',1],
    ['4101','Ventas de Mercancía','ingreso','ventas','41','',0],
    ['4102','Descuentos en Ventas','ingreso','descuento','41','Cuenta contranatura (reduce ingresos)',0],
    ['4103','Devoluciones en Ventas','ingreso','devolucion','41','Cuenta contranatura',0],
    ['4104','Otros Ingresos','ingreso','','41','',0],
    ['5','COSTOS','costo','',null,'Grupo costos',1],
    ['51','Costo de Ventas','costo','','5','',1],
    ['5101','Costo de Mercancía Vendida','costo','cogs','51','Costo directo de productos vendidos',0],
    ['5102','Compras de Mercancía','costo','','51','',0],
    ['5103','Devoluciones en Compras','costo','','51','Cuenta contranatura',0],
    ['6','GASTOS','gasto','',null,'Grupo gastos',1],
    ['61','Gastos Operacionales','gasto','','6','',1],
    ['6101','Alquiler de Local','gasto','','61','',0],
    ['6102','Electricidad','gasto','','61','',0],
    ['6103','Agua y Saneamiento','gasto','','61','',0],
    ['6104','Internet','gasto','','61','',0],
    ['6105','Teléfono','gasto','','61','',0],
    ['6106','Sueldos y Salarios','gasto','','61','',0],
    ['6107','Combustible','gasto','','61','',0],
    ['6108','Transporte y Mensajería','gasto','','61','',0],
    ['6109','Publicidad y Marketing','gasto','','61','',0],
    ['6110','Mantenimiento y Reparaciones','gasto','','61','',0],
    ['6111','Limpieza y Aseo','gasto','','61','',0],
    ['6112','Comisiones Bancarias','gasto','','61','',0],
    ['6113','Gastos de Tecnología','gasto','','61','',0],
    ['6114','Impuestos y Licencias','gasto','','61','',0],
    ['6115','Servicios Profesionales','gasto','','61','',0],
    ['6116','Incentivos y Bonificaciones','gasto','','61','',0],
    ['6117','Útiles y Materiales de Ofic.','gasto','','61','',0],
    ['6118','Seguros','gasto','','61','',0],
    ['6119','Depreciación','gasto','','61','',0],
    ['6120','Otros Gastos Operacionales','gasto','','61','',0],
    ['7','IMPUESTOS','impuesto','',null,'Grupo impuestos',1],
    ['7101','ITBIS Cobrado (Ventas)','impuesto','','7','ITBIS facturado en ventas',0],
    ['7102','ITBIS Pagado (Compras)','impuesto','','7','ITBIS en compras acreditable',0],
    ['7103','Retenciones ISR','impuesto','','7','',0],
  ];
  for (const [code, name, type, subtype, parentCode, desc, summary] of ACCOUNTS) {
    ins.run(code, name, type, subtype, idOf(parentCode), desc, summary);
  }

  const insConf = db.prepare(
    `INSERT OR IGNORE INTO accounting_config(key, account_id, description) VALUES(?, ?, ?)`
  );
  // [configKey, accountCode, description]
  const CONFIG = [
    ['account_cash','1101','Caja General → efectivo ventas y caja'],
    ['account_petty_cash','1102','Caja Chica → pagos menores'],
    ['account_bank','1103','Bancos → transferencias y depósitos'],
    ['account_ar','1104','Cuentas por Cobrar → ventas a crédito'],
    ['account_inventory','1105','Inventario → stock de mercancía'],
    ['account_tax_credit','1106','ITBIS pagado en compras'],
    ['account_ap','2101','Cuentas por Pagar → compras a crédito'],
    ['account_tax_payable','2102','ITBIS cobrado en ventas → DGII'],
    ['account_capital','3101','Capital Social'],
    ['account_revenue','4101','Ventas de mercancía'],
    ['account_discount','4102','Descuentos en ventas'],
    ['account_returns','4103','Devoluciones en ventas'],
    ['account_other_rev','4104','Otros ingresos'],
    ['account_cogs','5101','Costo de mercancía vendida'],
    ['account_rent','6101','Alquiler'],
    ['account_elec','6102','Electricidad'],
    ['account_internet','6104','Internet'],
    ['account_salary','6106','Sueldos'],
    ['account_fuel','6107','Combustible'],
    ['account_other_exp','6120','Otros gastos'],
  ];
  for (const [key, code, desc] of CONFIG) insConf.run(key, idOf(code), desc);

  return db.prepare('SELECT COUNT(*) c FROM accounting_accounts').get().c;
}

// ══════════════════════════════════════════════
// INICIALIZAR SISTEMA DE VERSIONES
// ══════════════════════════════════════════════
function initVersioning(db, dataDir) {
  // Crear tabla de migraciones si no existe
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version     TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      applied_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_info (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Guardar versión actual
  db.prepare(`
    INSERT INTO app_info(key, value)
    VALUES('app_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(APP_VERSION);

  db.prepare(`
    INSERT OR IGNORE INTO app_info(key, value)
    VALUES('installed_at', datetime('now'))
  `).run();

  // Correr migraciones pendientes
  runMigrations(db);

  // Crear backup automático si es primera vez hoy
  autoBackup(db, dataDir);

  console.log(`[VERSION] App v${APP_VERSION} lista`);
}

// ══════════════════════════════════════════════
// CORRER MIGRACIONES PENDIENTES
// ══════════════════════════════════════════════
function runMigrations(db) {
  const applied = db.prepare('SELECT version FROM db_migrations').all()
    .map(r => r.version);

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.includes(migration.version)) continue;

    try {
      console.log(`[MIGRATION] Aplicando v${migration.version}: ${migration.description}`);
      // SEGURIDAD: envolver cada migración en transacción para atomicidad
      // Si la migración falla, la DB queda como estaba — no estado inconsistente
      const migTx = db.transaction(() => {
        migration.run(db);
        db.prepare(`
          INSERT OR IGNORE INTO db_migrations(version, description)
          VALUES(?, ?)
        `).run(migration.version, migration.description);
      });
      migTx();
      count++;
      console.log(`[MIGRATION] ✓ v${migration.version} aplicada`);
    } catch (e) {
      // Log del error pero continuar — no abortar otras migraciones independientes
      console.error(`[MIGRATION] ✗ Error en v${migration.version}:`, e.message);
      console.error('[MIGRATION] La DB permanece en estado consistente (transacción revertida)');
    }
  }

  if (count > 0) {
    console.log(`[MIGRATION] ${count} migración(es) aplicada(s)`);
  } else {
    console.log('[MIGRATION] Base de datos actualizada');
  }
}

// ══════════════════════════════════════════════
// BACKUP AUTOMÁTICO
// Se hace UNA VEZ POR DÍA al arrancar
// ══════════════════════════════════════════════
function autoBackup(db, dataDir) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Verificar si ya se hizo backup hoy
    const lastBackup = db.prepare(`
      SELECT value FROM app_info WHERE key='last_backup_date'
    `).get();

    if (lastBackup?.value === today) {
      console.log('[BACKUP] Ya se realizó backup hoy');
      return;
    }

    // Crear carpeta de backups
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Limpiar backups viejos (mantener últimos 30)
    cleanOldBackups(backupDir, 30);

    // Crear backup
    const backupName = `velo_${today}.db`;
    const backupPath = path.join(backupDir, backupName);
    const dbPath     = path.join(dataDir, 'velo.db');

    fs.copyFileSync(dbPath, backupPath);

    // Registrar fecha del último backup
    db.prepare(`
      INSERT INTO app_info(key, value)
      VALUES('last_backup_date', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(today);

    console.log(`[BACKUP] ✓ Backup automático: ${backupName}`);
  } catch (e) {
    console.error('[BACKUP] Error en backup automático:', e.message);
  }
}

// ── Limpiar backups viejos ────────────────────
function cleanOldBackups(backupDir, keep = 30) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('velo_') && f.endsWith('.db'))
      .sort()
      .reverse();

    const toDelete = files.slice(keep);
    toDelete.forEach(f => {
      fs.unlinkSync(path.join(backupDir, f));
      console.log(`[BACKUP] Backup antiguo eliminado: ${f}`);
    });
  } catch (e) {
    console.error('[BACKUP] Error al limpiar backups:', e.message);
  }
}

// ══════════════════════════════════════════════
// BACKUP MANUAL (llamado desde IPC)
// ══════════════════════════════════════════════
function createManualBackup(dataDir, destPath) {
  const dbPath = path.join(dataDir, 'velo.db');
  fs.copyFileSync(dbPath, destPath);
  return destPath;
}

// ══════════════════════════════════════════════
// RESTAURAR BACKUP (llamado desde IPC)
// ── IMPORTANTE: cierra la DB antes de copiar ──
// El caller (main.js) debe reiniciar la app después de llamar esto.
// ══════════════════════════════════════════════
function restoreBackup(dataDir, sourcePath) {
  const dbPath      = path.join(dataDir, 'velo.db');
  const safetyPath  = path.join(dataDir, `velo_before_restore_${Date.now()}.db`);

  // Verificar que el archivo fuente existe y parece una DB SQLite
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Archivo de backup no encontrado: ${sourcePath}`);
  }
  const header = Buffer.alloc(16);
  const fd     = fs.openSync(sourcePath, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (!header.toString('ascii', 0, 16).startsWith('SQLite format 3')) {
    throw new Error('El archivo seleccionado no es una base de datos SQLite válida');
  }

  // Backup de seguridad del estado actual
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, safetyPath);
  }

  // Copiar el backup sobre la DB activa
  // NOTA: la conexión SQLite debe estar cerrada antes de llamar esto.
  // main.js cierra la DB en el handler backup:restore antes de invocar esta función.
  fs.copyFileSync(sourcePath, dbPath);

  return { ok: true, backupCreated: safetyPath };
}

// ══════════════════════════════════════════════
// OBTENER INFO DE VERSIÓN
// ══════════════════════════════════════════════
function getVersionInfo(db, dataDir) {
  const backupDir = path.join(dataDir, 'backups');
  // Fix: fallback correcto a array vacío cuando no existe el directorio
  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir)
        .filter(f => f.startsWith('velo_') && f.endsWith('.db'))
        .sort().reverse()
    : [];

  const appInfo = {};
  try {
    db.prepare('SELECT key, value FROM app_info').all()
      .forEach(r => { appInfo[r.key] = r.value; });
  } catch (e) {
    console.log('[version:getInfo] app_info no disponible:', e.message);
  }

  let migrations = [];
  try {
    migrations = db.prepare(
      'SELECT * FROM db_migrations ORDER BY applied_at DESC'
    ).all();
  } catch (e) {
    console.log('[version:getInfo] db_migrations no disponible:', e.message);
  }

  const dbPath = path.join(dataDir, 'velo.db');
  const dbSizeBytes = fs.existsSync(dbPath)
    ? fs.statSync(dbPath).size : 0;
  const dbSize = dbSizeBytes > 1024*1024
    ? `${(dbSizeBytes/1024/1024).toFixed(1)} MB`
    : `${(dbSizeBytes/1024).toFixed(0)} KB`;

  return {
    appVersion:    APP_VERSION,
    installedAt:   appInfo.installed_at     || '—',
    lastBackup:    appInfo.last_backup_date || '—',
    backupsCount:  backups.length,
    backups:       backups.slice(0, 10),
    migrations,
    dbPath,
    dbSize,
    backupDir,
  };
}

// ══════════════════════════════════════════════
// BACKUP AUTOMÁTICO ASÍNCRONO (Fase 1)
// Usa la API db.backup() de better-sqlite3, que es asíncrona y consistente
// con WAL (hace checkpoint interno), por lo que NO bloquea las ventas ni
// deja transacciones fuera del respaldo. Guarda en backups/ con rotación.
// ══════════════════════════════════════════════
async function createAutoBackup(dataDir, db, keepLast = 10) {
  if (!db || typeof db.backup !== 'function') {
    throw new Error('Conexión de base de datos no disponible para backup');
  }
  const backupsDir = path.join(dataDir, 'backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').split('T');
  const fileName = `velo_auto_${stamp[0]}_${stamp[1].slice(0, 6)}.db`;
  const destPath = path.join(backupsDir, fileName);

  // db.backup() devuelve una Promise; corre en background sin bloquear.
  await db.backup(destPath);

  // Rotación: conservar solo los últimos `keepLast` backups automáticos.
  try {
    const autos = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('velo_auto_') && f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    autos.slice(keepLast).forEach(({ f }) => {
      try { fs.unlinkSync(path.join(backupsDir, f)); } catch {}
    });
  } catch {}

  return destPath;
}

module.exports = {
  APP_VERSION,
  initVersioning,
  seedAccountingCatalog,
  createManualBackup,
  createAutoBackup,
  restoreBackup,
  getVersionInfo,
};