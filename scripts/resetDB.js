#!/usr/bin/env node
/**
 * resetDB.js — herramienta local de desarrollo/soporte.
 * Borra la base de datos local después de crear un backup de seguridad.
 *
 * Uso seguro:
 *   npm run db:reset -- --force
 * o:
 *   VELO_RESET_CONFIRM=SI npm run db:reset
 *
 * Nunca se ejecuta automáticamente en producción ni desde el renderer.
 */
const fs = require('fs');
const path = require('path');

const force = process.argv.includes('--force') || process.env.VELO_RESET_CONFIRM === 'SI';
if (!force) {
  console.error('Cancelado. Para resetear usa: npm run db:reset -- --force');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'velo.db');
const backupsDir = path.join(dataDir, 'backups');

fs.mkdirSync(backupsDir, { recursive: true });

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Backup creado: ${dest}`);
  }
}

if (fs.existsSync(dbPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyIfExists(dbPath, path.join(backupsDir, `velo_before_reset_${stamp}.db`));
}

['velo.db', 'velo.db-wal', 'velo.db-shm'].forEach((file) => {
  const target = path.join(dataDir, file);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { force: true });
    console.log(`Eliminado: ${target}`);
  }
});

console.log('Reset completado. Al iniciar la app se recreará la base de datos.');
