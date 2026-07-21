#!/usr/bin/env node
/**
 * importar-equiparts-v2.js — Importador dedicado de la migración v2.
 *
 * Carga los 4 CSV v2.1 (generados desde el BAK) a Velo POS con identidad real:
 *   - Dedup infalible por code / old_id_cliente / old_id_factura / old_id_pago_detalle
 *   - Inventario real → products (enlaza sale_items por código)
 *   - Detalle real por artículo (sale_items con product_id del catálogo)
 *   - ANULADAS EXCLUIDAS (ya filtradas en el CSV; no deben existir)
 *   - payment_method: balance>0 → 'credito' (aparece en Facturas Pendientes,
 *     abonable); balance=0 → 'efectivo' (pagada)
 *   - Balance del cliente = suma de balance_factura con saldo (del BAK)
 *   - Recibos → payments (solo de facturas NO anuladas), SIN recalcular balance
 *   - NCF fiscal real vinculado a factura y cliente
 *
 * IMPORTANTE: correr con el Electron del proyecto (better-sqlite3 está
 * compilado para Electron, no para Node del sistema):
 *
 *   ./node_modules/.bin/electron scripts/importar-equiparts-v2.js --dir=/ruta/a/los/csv
 *
 * Requiere que la Fase 1 (columnas v2) ya esté aplicada.
 * Idempotente: se puede correr varias veces sin duplicar (dedup por old_id_*).
 *
 * CHECKPOINT: se deriva de los propios CSV al final del proceso (suma de
 * `balance` deduplicada por old_id_factura). No hay numero magico: si cambia
 * el BAK, el target cambia solo.
 */

const fs   = require('fs');
const path = require('path');

// ── Parseo de argumentos ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
// Carpeta donde están los 4 CSV. Por defecto: ./csv_v2 junto al proyecto.
const CSV_DIR = path.resolve(getArg('dir', path.join(__dirname, '..', 'csv_v2')));
const DRY_RUN = args.includes('--dry-run');

const FILES = {
  clientes:  '2_clientes_v2.csv',
  inventario:'1_inventario_v2.csv',
  ventas:    '3_ventas_v2.csv',
  recibos:   '4_recibos_v2.csv',
};

// ── CSV parser real (maneja comillas y comas internas) ────────────────
function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignorar */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadCSV(fname) {
  const p = path.join(CSV_DIR, fname);
  if (!fs.existsSync(p)) throw new Error(`No se encontró el CSV: ${p}`);
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // quitar BOM si lo hubiera
  const rows = parseCSV(text).filter(r => r.length && !(r.length === 1 && r[0] === ''));
  const header = rows.shift();
  return rows.map(r => {
    const o = {};
    header.forEach((h, i) => { o[h.trim()] = (r[i] !== undefined ? r[i] : '').trim(); });
    return o;
  });
}

const num = v => {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const intOrNull = v => (v === '' || v == null) ? null : parseInt(v, 10);
const norm = s => (s || '').trim().toLowerCase().normalize('NFC');

// ── Arranque: inicializar la MISMA DB del proyecto ────────────────────
const database = require('../database');
const db = database.initDB();   // resuelve la ruta igual que la app

console.log('════════════════════════════════════════════════════');
console.log(' IMPORTADOR EQUIPARTS v2');
console.log('════════════════════════════════════════════════════');
console.log('CSV dir :', CSV_DIR);
console.log('DRY RUN :', DRY_RUN ? 'SÍ (no escribe nada)' : 'no');
console.log('');

// ── Verificar que la Fase 1 está aplicada ─────────────────────────────
const salesCols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
const custCols  = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
const payCols   = db.prepare('PRAGMA table_info(payments)').all().map(c => c.name);
const need = [
  ['sales','old_id_factura', salesCols],
  ['sales','numero_factura', salesCols],
  ['customers','old_id_cliente', custCols],
  ['payments','old_id_pago_detalle', payCols],
  ['payments','numero_recibo', payCols],
];
const missing = need.filter(([t,c,cols]) => !cols.includes(c));
if (missing.length) {
  console.error('❌ FALTAN COLUMNAS (aplica la Fase 1 primero):');
  missing.forEach(([t,c]) => console.error(`   ${t}.${c}`));
  process.exit(1);
}
console.log('✓ Fase 1 verificada (columnas v2 presentes)\n');

// ── Cargar los CSV ────────────────────────────────────────────────────
const clientes  = loadCSV(FILES.clientes);
const inventario = loadCSV(FILES.inventario);   // #5: ahora SÍ se carga
const ventas    = loadCSV(FILES.ventas);
const recibos   = loadCSV(FILES.recibos);
console.log(`Cargados: ${clientes.length} clientes, ${inventario.length} productos, ${ventas.length} líneas de venta, ${recibos.length} recibos\n`);

// ══════════════════════════════════════════════════════════════════════
// TRANSACCIÓN ÚNICA — todo o nada
// ══════════════════════════════════════════════════════════════════════
const stats = {
  prod_new: 0, prod_skip: 0,
  cli_new: 0, cli_skip: 0,
  fac_new: 0, fac_skip: 0, fac_cancel: 0, items: 0,
  rec_new: 0, rec_skip: 0,
};

const runImport = db.transaction(() => {

  // ── 0) INVENTARIO (#5) — productos reales, dedup por code ────────────
  const findProdByCode = db.prepare(`SELECT id FROM products WHERE code = ? LIMIT 1`);
  const insProd = db.prepare(`
    INSERT INTO products(code, barcode, name, brand, category, cost, price, wholesale, taxable, tax_pct, stock, stock_min, unit, active)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const p of inventario) {
    const code = (p.code || '').trim();
    if (!code) continue;
    if (findProdByCode.get(code)) { stats.prod_skip++; continue; }
    // ITBIS por artículo (viene de articulo.itbis en faprodb).
    // El CSV trae taxable 1/0; tax_pct siempre 18 (el único artículo al 15%
    // se normalizó a 18, y los exentos conservan 18 para que marcar la
    // casilla en Velo calcule bien sin editar el porcentaje a mano).
    // Si el CSV no trae las columnas (formato viejo) → gravado al 18%.
    const taxable = (String(p.taxable).trim() === '0') ? 0 : 1;
    const taxPct  = num(p.tax_pct) || 18;
    insProd.run(
      code,
      (p.barcode || code).trim(),
      (p.name || 'Producto').trim(),
      (p.brand || 'GENERICA').trim(),
      (p.category || 'GENERICO').trim(),
      num(p.cost), num(p.price), num(p.wholesale),
      taxable, taxPct,
      parseInt(p.stock, 10) || 0,
      parseInt(p.stock_min, 10) || 5,
      (p.unit || 'UNIDAD').trim()
    );
    stats.prod_new++;
  }
  // Mapa code → product_id (para enlazar sale_items al catálogo real, #4)
  const prodByCode = new Map(db.prepare(`SELECT id, code FROM products WHERE active=1`).all()
    .map(x => [x.code, x.id]));

  // ── 1) CLIENTES ─────────────────────────────────────────────────────
  // Mapa old_id_cliente → customer_id de Velo.
  const mapCli = new Map();
  const insCli = db.prepare(`
    INSERT INTO customers(name, rnc, phone, address, email, credit_days, balance, active, old_id_cliente, import_source)
    VALUES(?, ?, ?, ?, ?, ?, 0, 1, ?, 'equiparts_bak')
  `);
  const findCliByOld = db.prepare(`SELECT id FROM customers WHERE old_id_cliente = ? LIMIT 1`);
  const allCustomers = db.prepare(`SELECT id, name FROM customers WHERE active=1`).all();

  for (const c of clientes) {
    const oldId = intOrNull(c.old_id_cliente);
    if (oldId == null) continue;
    // dedup por old_id_cliente
    const exist = findCliByOld.get(oldId);
    if (exist) { mapCli.set(oldId, exist.id); stats.cli_skip++; continue; }
    // dedup secundario por nombre (evitar duplicar Consumidor Final u otros ya existentes)
    const byName = allCustomers.find(x => norm(x.name) === norm(c.name));
    if (byName) {
      // enlazar old_id al existente
      db.prepare(`UPDATE customers SET old_id_cliente=?, import_source='equiparts_bak' WHERE id=?`).run(oldId, byName.id);
      mapCli.set(oldId, byName.id);
      stats.cli_skip++;
      continue;
    }
    const r = insCli.run(
      c.name || 'Cliente',
      c.rnc || '', c.phone || '', c.address || '', c.email || '',
      intOrNull(c.credit_days) || 30,
      oldId
    );
    mapCli.set(oldId, r.lastInsertRowid);
    stats.cli_new++;
  }

  // Resolver customer_id: por old_id_cliente, luego por nombre, luego Consumidor Final (1)
  const custByName = new Map(db.prepare(`SELECT id, name FROM customers WHERE active=1`).all()
    .map(x => [norm(x.name), x.id]));
  const resolveCust = (oldId, name) => {
    if (oldId != null && mapCli.has(oldId)) return mapCli.get(oldId);
    const byOld = oldId != null ? findCliByOld.get(oldId) : null;
    if (byOld) return byOld.id;
    const byName = custByName.get(norm(name));
    if (byName) return byName.id;
    return 1; // Consumidor Final
  };

  // ── 2) VENTAS (agrupadas por old_id_factura) ────────────────────────
  const findSaleByOld = db.prepare(`SELECT id FROM sales WHERE old_id_factura = ? LIMIT 1`);
  const insSale = db.prepare(`
    INSERT INTO sales(
      cash_session_id, customer_id, customer_name, customer_rnc,
      type, status, subtotal, discount_pct, discount_amt,
      tax_pct, tax_amt, total, payment_method, price_mode,
      cajero, user_id, ncf, notes, created_at,
      numero_factura, numero_factura_fmt, old_id_factura, import_source
    ) VALUES (?, ?, ?, '', ?, ?, ?, 0, 0, ?, ?, ?, ?, 'retail', 'Importación histórica', NULL, ?, ?, ?, ?, ?, ?, 'equiparts_bak')
  `);
  // product_id se enlaza al catálogo real por código (#4, #2). Si no existe, NULL.
  const insItem = db.prepare(`
    INSERT INTO sale_items(sale_id, product_id, product_code, product_name, unit_cost, unit_price, qty, subtotal)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `);

  // Agrupar líneas por old_id_factura
  const facturas = new Map();
  for (const v of ventas) {
    const oid = intOrNull(v.old_id_factura);
    if (oid == null) continue;
    if (!facturas.has(oid)) {
      facturas.set(oid, {
        old_id_factura: oid,
        numero_factura: intOrNull(v.numero_factura),
        numero_factura_fmt: v.numero_factura_fmt || '',
        ncf: (v.ncf || '').startsWith('B') ? v.ncf : '',
        customer_name: v.customer_name || 'Consumidor Final',
        old_id_cliente: intOrNull(v.old_id_cliente),
        date: (v.date || '').slice(0, 10),
        total: num(v.total),
        balance: num(v.balance),
        payment_method: v.payment_method || 'efectivo',
        status: v.status === 'cancelled' ? 'cancelled' : 'completed',
        estado_origen: v.estado_origen || '',
        type: 'factura',
        items: [],
      });
    }
    const f = facturas.get(oid);
    const pname = (v.product_name || '').trim();
    if (pname) {
      f.items.push({
        product_code: v.product_code || 'IMP',
        product_name: pname,
        qty: Math.max(1, parseInt(v.qty, 10) || 1),
        unit_price: num(v.unit_price),
        line_total: num(v.line_total),
      });
    }
  }

  // Acumular balance por cliente (SOLO facturas Pendientes → CxC real)
  const balByCust = new Map();

  for (const f of facturas.values()) {
    // dedup infalible
    if (findSaleByOld.get(f.old_id_factura)) { stats.fac_skip++; continue; }

    const custId = resolveCust(f.old_id_cliente, f.customer_name);
    const dt = (f.date || new Date().toISOString().split('T')[0]) + ' 00:00:00';
    const fmt = f.numero_factura_fmt || (f.numero_factura != null ? String(f.numero_factura).padStart(8,'0') : '');
    const notes = f.numero_factura != null
      ? `Factura #${fmt}${f.ncf ? ' | NCF:' + f.ncf : ''}` : 'Factura importada';
    const taxPct = f.type === 'factura' ? 18 : 0;

    const r = insSale.run(
      null, custId, f.customer_name, f.type, f.status,
      f.total, taxPct, 0, f.total, f.payment_method,
      f.ncf, notes, dt,
      f.numero_factura, fmt, f.old_id_factura
    );
    const saleId = r.lastInsertRowid;

    // items (detalle real). Si no hay, una línea genérica.
    const items = f.items.length ? f.items
      : [{ product_code: 'IMP', product_name: 'Factura importada', qty: 1, unit_price: f.total, line_total: f.total }];
    for (const it of items) {
      const pid = prodByCode.get((it.product_code || '').trim()) || null;
      insItem.run(saleId, pid, it.product_code, it.product_name, it.unit_price, it.qty,
        it.line_total || (it.unit_price * it.qty));
      stats.items++;
    }

    stats.fac_new++;
    // Balance del cliente = suma de balance_factura con saldo pendiente.
    // Anuladas ya fueron excluidas en el CSV, así que toda factura con
    // balance>0 aquí es CxC real cobrable.
    if (f.balance > 0) {
      balByCust.set(custId, (balByCust.get(custId) || 0) + f.balance);
    }
  }

  // ── 3) RECIBOS → payments (dedup por old_id_pago_detalle) ───────────
  // NO tocan el balance del cliente (el balance viene del BAK, paso 4).
  const findPayByOld = db.prepare(`SELECT id FROM payments WHERE old_id_pago_detalle = ? LIMIT 1`);
  const findSaleForRec = db.prepare(`SELECT id, customer_id FROM sales WHERE old_id_factura = ? LIMIT 1`);
  const insPay = db.prepare(`
    INSERT INTO payments(customer_id, sale_id, amount, method, note,
      balance_before, balance_after, cajero, user_id, created_at,
      numero_recibo, old_id_pago_detalle, import_source)
    VALUES(?, ?, ?, ?, ?, 0, 0, 'Importación histórica', NULL, ?, ?, ?, 'equiparts_bak')
  `);

  for (const rc of recibos) {
    const oldPd = intOrNull(rc.old_id_pago_detalle);
    if (oldPd == null) continue;
    if (findPayByOld.get(oldPd)) { stats.rec_skip++; continue; }

    // enlazar a la venta por old_id_factura; si no existe (facturas sin detalle),
    // enlazar al cliente por old_id_cliente
    const sale = findSaleForRec.get(intOrNull(rc.old_id_factura));
    const custId = sale ? sale.customer_id
      : resolveCust(intOrNull(rc.old_id_cliente), rc.customer_name);
    const saleId = sale ? sale.id : null;
    const dt = ((rc.date || '').slice(0,10) || new Date().toISOString().split('T')[0]) + ' 00:00:00';
    const note = `Recibo #${rc.numero_recibo || ''}${rc.notes ? ' | ' + rc.notes : ''}`.trim();

    insPay.run(
      custId, saleId, num(rc.amount),
      (rc.method || 'efectivo').toLowerCase(), note, dt,
      intOrNull(rc.numero_recibo), oldPd
    );
    stats.rec_new++;
  }

  // ── 4) BALANCE DEL CLIENTE = suma de balance_factura pendientes (BAK) ─
  // El balance manda desde el BAK, NO se recalcula restando abonos.
  const setBal = db.prepare(`UPDATE customers SET balance = ?, credit_due = ? WHERE id = ?`);
  for (const [custId, bal] of balByCust.entries()) {
    const b = Math.round(bal * 100) / 100;
    setBal.run(b, b > 0 ? b : null, custId);
  }

  return balByCust;
});

// ── Ejecutar ───────────────────────────────────────────────────────────
if (DRY_RUN) {
  console.log('DRY RUN: no se ejecuta la transacción. (Quita --dry-run para importar de verdad.)');
  process.exit(0);
}

const balByCust = runImport();

// ── Reporte ────────────────────────────────────────────────────────────
console.log('──────────────────────────────────────');
console.log('RESULTADO DE LA IMPORTACIÓN');
console.log('──────────────────────────────────────');
console.log(`Productos: ${stats.prod_new} nuevos, ${stats.prod_skip} ya existían`);
console.log(`Clientes:  ${stats.cli_new} nuevos, ${stats.cli_skip} ya existían`);
console.log(`Facturas:  ${stats.fac_new} importadas, ${stats.fac_skip} ya existían`);
console.log(`Items:     ${stats.items} líneas de detalle`);
console.log(`Recibos:   ${stats.rec_new} nuevos, ${stats.rec_skip} ya existían`);
console.log('');

// ── Validación de integridad ───────────────────────────────────────────
const cxc = db.prepare(`
  SELECT
    ROUND(SUM(balance), 2) AS cxc_total,
    COUNT(*)               AS clientes_con_saldo
  FROM customers WHERE balance > 0 AND active = 1
`).get();

const facturasImp = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE import_source='equiparts_bak'`).get().n;
const pendientes  = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE import_source='equiparts_bak' AND status='completed'`).get().n;

console.log('══════════════════════════════════════');
console.log('VALIDACIÓN DE INTEGRIDAD (CxC)');
console.log('══════════════════════════════════════');
console.log(`CxC total en Velo:    RD$${(cxc.cxc_total || 0).toLocaleString('en-US', {minimumFractionDigits:2})}`);
console.log(`Clientes con saldo:   ${cxc.clientes_con_saldo}`);
console.log(`Facturas importadas:  ${facturasImp}`);
console.log('');

// Target DINAMICO: sale de los propios CSV, no de una constante. El campo
// `balance` se repite en cada item de una misma factura (identificada por
// old_id_factura), asi que se toma UNA sola vez por factura y se suman solo
// las que tienen balance > 0. Mismo criterio que el ALL IN ONE en main.js.
const balancePorFactura = new Map();
for (const row of ventas) {
  const oid = row.old_id_factura;
  if (!balancePorFactura.has(oid)) balancePorFactura.set(oid, num(row.balance));
}
let targetCxc = 0;
for (const bal of balancePorFactura.values()) if (bal > 0) targetCxc += bal;
targetCxc = Math.round(targetCxc * 100) / 100;
const targetPend = [...balancePorFactura.values()].filter(b => b > 0).length;

console.log(`TARGET (desde el CSV): RD$${targetCxc.toLocaleString('en-US', {minimumFractionDigits:2})} / ${targetPend} facturas pendientes`);

const diff = Math.abs(Math.round((cxc.cxc_total || 0) * 100) / 100 - targetCxc);
if (diff < 0.01) {
  console.log('\n✅ CxC CUADRA con el total del CSV. Importación correcta.');
} else {
  console.log(`\n⚠️  CxC difiere del target por RD$${diff.toFixed(2)}. Revisar antes de dar por buena la carga.`);
}

process.exit(0);
