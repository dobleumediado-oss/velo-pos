'use strict';

const AUTO_DEFAULTS = new Set([
  'Filtros','Eléctrico','Frenos','Suspensión','Motor',
  'Lubricantes','Encendido','Enfriamiento','Transmisión','Otros',
]);

const TECH_DEFAULTS = [
  'Celulares','Tablets','Laptops y computadoras','Audio y video',
  'Accesorios','Cargadores y cables','Piezas y repuestos técnicos',
  'Equipos usados','Servicios y mano de obra','Otros',
];

function ensureTechInitialCatalog(db, settingsRepo) {
  if (!db || !settingsRepo || settingsRepo.get('tech_catalog_initialized') === '1') {
    return { changed:false };
  }
  const productCount = Number(db.prepare('SELECT COUNT(*) n FROM products').get()?.n || 0);
  const current = db.prepare('SELECT name FROM categories ORDER BY id').all().map(row => String(row.name || '').trim());
  const untouchedAutoCatalog = current.length > 0 && current.every(name => AUTO_DEFAULTS.has(name));
  let changed = false;
  if (productCount === 0 && untouchedAutoCatalog) {
    db.transaction(() => {
      db.prepare('DELETE FROM categories').run();
      const insert = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
      TECH_DEFAULTS.forEach(name => insert.run(name));
    })();
    changed = true;
  }
  settingsRepo.set('tech_catalog_initialized', '1');
  return { changed, categories:changed ? [...TECH_DEFAULTS] : current };
}

module.exports = { ensureTechInitialCatalog, TECH_DEFAULTS };
