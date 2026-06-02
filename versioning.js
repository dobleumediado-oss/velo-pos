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
    version: '1.4.3',
    description: 'Sin cambios de schema — Dashboard Chart.js + WhatsApp integrado',
    run(db) {
      // No requiere cambios en la DB — solo mejoras de UI
      console.log('[MIGRATION 1.4.3] Dashboard y WhatsApp activados');
    }
  },
  {
    version: '1.4.4',
    description: 'Fix layout CSS + WhatsApp en clientes + botones armonizados',
    run(db) {
      console.log('[MIGRATION 1.4.4] Layout y UX mejorados');
    }
  },
  {
    version: '1.4.5',
    description: 'Superadmin pass en Panel Dev + WhatsApp shell.openExternal',
    run(db) {
      console.log('[MIGRATION 1.4.5] Sin cambios de schema');
    }
  },
  {
    version: '1.4.6',
    description: 'Fix importar Excel — carga xlsx desde CDN',
    run(db) { console.log('[MIGRATION 1.4.6] Sin cambios de schema'); }
  },
  {
    version: '1.4.7',
    description: 'Fix auto-update 404 repo privado + fix importar Excel',
    run(db) { console.log('[MIGRATION 1.4.7] Sin cambios de schema'); }
  },
  {
    version: '1.4.8',
    description: 'Fix login — auth duplicado en preload',
    run(db) { console.log('[MIGRATION 1.4.8] Sin cambios de schema'); }
  },
  {
    version: '1.4.9',
    description: 'Contraseña maestra del vendedor para superadmin',
    run(db) { console.log('[MIGRATION 1.4.9] Sin cambios de schema'); }
  },
  {
    version: '1.5.0',
    description: 'Fix importar — Claude API via IPC + contraseña maestra + login fix',
    run(db) { console.log('[MIGRATION 1.5.0] Sin cambios de schema'); }
  },
  {
    version: '1.5.1',
    description: 'Carga .env automática — API key de Claude para importador',
    run(db) { console.log('[MIGRATION 1.5.1] Sin cambios de schema'); }
  },
];

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
      migration.run(db);
      db.prepare(`
        INSERT OR IGNORE INTO db_migrations(version, description)
        VALUES(?, ?)
      `).run(migration.version, migration.description);
      count++;
      console.log(`[MIGRATION] ✓ v${migration.version} aplicada`);
    } catch (e) {
      console.error(`[MIGRATION] ✗ Error en v${migration.version}:`, e.message);
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
  db.prepare('SELECT key, value FROM app_info').all()
    .forEach(r => { appInfo[r.key] = r.value; });

  const migrations = db.prepare(
    'SELECT * FROM db_migrations ORDER BY applied_at DESC'
  ).all();

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

module.exports = {
  APP_VERSION,
  initVersioning,
  createManualBackup,
  restoreBackup,
  getVersionInfo,
};