// ══════════════════════════════════════════════
// versioning.js — Control de versiones y
//                 migraciones automáticas de DB
// Corre SOLO en el main process de Electron
// ══════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const APP_VERSION = '1.0.0';

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
// ══════════════════════════════════════════════
function restoreBackup(dataDir, sourcePath) {
  const dbPath     = path.join(dataDir, 'velo.db');
  const backupPath = path.join(dataDir, `velo_before_restore_${Date.now()}.db`);

  // Hacer backup del actual antes de restaurar
  fs.copyFileSync(dbPath, backupPath);

  // Restaurar
  fs.copyFileSync(sourcePath, dbPath);

  return { ok: true, backupCreated: backupPath };
}

// ══════════════════════════════════════════════
// OBTENER INFO DE VERSIÓN
// ══════════════════════════════════════════════
function getVersionInfo(db, dataDir) {
  const backupDir = path.join(dataDir, 'backups');
  const backups   = fs.existsSync(backupDir)
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