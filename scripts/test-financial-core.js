#!/usr/bin/env node
/**
 * test-financial-core.js — Regresión del núcleo financiero (dev-only)
 *
 * Valida los cálculos de dinero, inventario y crédito de salesRepo /
 * customersRepo contra una base de datos FRESCA Y AISLADA en el temp del SO.
 * NUNCA toca la BD real: llama initDB(tempDir) con un directorio desechable.
 *
 * Cubre las invariantes que una refactorización JAMÁS debe romper:
 *  - precio final con ITBIS incluido: subtotal neto / ITBIS 18% / total
 *  - descuento porcentual
 *  - descuento de stock al facturar
 *  - la cotización NO lleva ITBIS ni mueve inventario
 *  - venta a crédito sube el balance del cliente
 *  - abono baja el balance y el sobrepago se rechaza
 *  - los registros de 'Importación histórica' quedan fuera de las ventas vivas
 *
 * Correr con el Node de Electron (ABI de better-sqlite3):
 *   npm run test:financial
 *
 * Exit code: 0 = todo OK; 1 = algún fallo.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FALLO:', msg); }
}
function near(a, b) { return Math.abs(a - b) < 0.005; }
function throws(fn, msg) {
  try { fn(); ok(false, msg + ' (no lanzó)'); }
  catch { ok(true, msg); }
}

// ── BD aislada y desechable ──
const tmpDir = path.join(os.tmpdir(), `velo_fintest_${Date.now()}`);
const DB = require('../database');
DB.initDB(tmpDir);
const db = DB.getDB();
const { seedAccountingCatalog } = require('../versioning');

function setupAccountingCore() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounting_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK(type IN ('activo','pasivo','capital','ingreso','costo','gasto','impuesto')),
      subtype     TEXT DEFAULT '',
      parent_id   INTEGER REFERENCES accounting_accounts(id),
      description TEXT DEFAULT '',
      balance     REAL NOT NULL DEFAULT 0,
      is_summary  INTEGER DEFAULT 0,
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
      status        TEXT DEFAULT 'confirmado' CHECK(status IN ('borrador','confirmado','anulado')),
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
      key         TEXT PRIMARY KEY,
      account_id  INTEGER REFERENCES accounting_accounts(id),
      value       TEXT DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_acc_entries_module ON accounting_entries(source_module, source_id);
    CREATE INDEX IF NOT EXISTS idx_acc_lines_entry ON accounting_entry_lines(entry_id);
    CREATE INDEX IF NOT EXISTS idx_acc_lines_account ON accounting_entry_lines(account_id);
  `);
  seedAccountingCatalog(db);
}
setupAccountingCore();

// Ajustes deterministas: ITBIS 18%, sin fiscal (evita NCF)
db.prepare("INSERT INTO settings(key,value) VALUES('tax_pct','18') ON CONFLICT(key) DO UPDATE SET value='18'").run();
db.prepare("INSERT INTO settings(key,value) VALUES('fiscal_enabled','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();

// Usuario para auditoría (usar el admin seed id=1 si existe, si no crear)
let userId = (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() || {}).id;
if (!userId) userId = DB.usersRepo.create({ name: 'Test', email: 't@t.co', password: 'x', role: 'admin' });
const user = { id: userId, name: 'Test' };

const prodId = DB.productsRepo.create({ code: 'P1', name: 'Filtro Aceite', cost: 50, price: 118, stock: 10, taxable: 1, tax_pct: 18 });
const prodNoTaxId = DB.productsRepo.create({ code: 'P2', name: 'Servicio Exento', cost: 20, price: 100, stock: 10, taxable: 0, tax_pct: 0 });
const custId = DB.customersRepo.create({ name: 'Taller Pérez', credit_limit: 100000 });
const item = (qty, price = 118) => ({ product_id: prodId, product_code: 'P1', product_name: 'Filtro Aceite', unit_cost: 50, unit_price: price, taxable: 1, tax_pct: 18, qty });
const itemNoTax = (qty) => ({ product_id: prodNoTaxId, product_code: 'P2', product_name: 'Servicio Exento', unit_cost: 20, unit_price: 100, taxable: 0, tax_pct: 0, qty });

console.log('\n== A. Factura: precio final incluye ITBIS 18% + stock ==');
const a = DB.salesRepo.create({ customer: { id: custId, name: 'Taller Pérez' }, items: [item(2)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(a.subtotal, 200), `subtotal 200 (obtuvo ${a.subtotal})`);
ok(near(a.taxAmt, 36), `ITBIS 36 incluido en total 236 (obtuvo ${a.taxAmt})`);
ok(near(a.total, 236), `total 236 (obtuvo ${a.total})`);
ok(DB.productsRepo.getById(prodId).stock === 8, `stock 10→8 tras vender 2 (obtuvo ${DB.productsRepo.getById(prodId).stock})`);

console.log('\n== B. Descuento porcentual ==');
const b = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1)], payment: { method: 'efectivo', disc: 10 }, user, type: 'factura' });
ok(near(b.discAmt, 11.8), `descuento 11.8 = 10% de 118 final (obtuvo ${b.discAmt})`);
ok(near(b.subtotal, 90), `subtotal neto 90 después de descuento (obtuvo ${b.subtotal})`);
ok(near(b.taxAmt, 16.2), `ITBIS 16.2 incluido después de descuento (obtuvo ${b.taxAmt})`);
ok(near(b.total, 106.2), `total 106.2 (obtuvo ${b.total})`);
const bReturn = DB.returnsRepo.create({
  originalSaleId: b.saleId,
  items: [{ ...item(1), qty: 1 }],
  session: null,
  user,
  reason: 'devolución con descuento',
});
ok(near(bReturn.total, 106.2),
  `devolución respeta el descuento original y reembolsa 106.2 (obtuvo ${bReturn.total})`);
ok(near(bReturn.taxAmt, 16.2),
  `devolución descontada conserva ITBIS 16.2 (obtuvo ${bReturn.taxAmt})`);
ok(!DB.salesRepo.getAll({ range: 'all', view: 'sales' }).some(s => s.id === b.saleId),
  'una factura con devolución vigente no aparece en la vista Ventas');
ok(!DB.salesRepo.getAll({ range: 'all', view: 'sales' }).some(s => s.id === bReturn.returnId),
  'la nota de crédito no se mezcla en la vista Ventas');

console.log('\n== C. Cotización: sin ITBIS, sin mover stock ==');
const stockBefore = DB.productsRepo.getById(prodId).stock;
const c = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1)], payment: { method: 'efectivo' }, user, type: 'cotizacion' });
ok(near(c.taxAmt, 0), `cotización sin ITBIS (obtuvo ${c.taxAmt})`);
ok(near(c.total, 118), `cotización total = precio final 118 (obtuvo ${c.total})`);
ok(DB.productsRepo.getById(prodId).stock === stockBefore, `stock intacto en cotización (${stockBefore})`);

console.log('\n== C2. Precio final modificado y producto exento ==');
const c2 = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [item(1, 150)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(c2.total, 150), `precio final modificado total 150 (obtuvo ${c2.total})`);
ok(near(c2.subtotal, 127.12), `precio final 150 => neto 127.12 (obtuvo ${c2.subtotal})`);
ok(near(c2.taxAmt, 22.88), `precio final 150 => ITBIS 22.88 (obtuvo ${c2.taxAmt})`);
const stockBeforeReturn = DB.productsRepo.getById(prodId).stock;
const ret = DB.returnsRepo.create({
  originalSaleId: c2.saleId,
  items: [{ ...item(1, 999), qty: 1 }],
  session: null,
  user,
  reason: 'devolución test',
});
ok(near(ret.total, 150), `devolución respeta precio histórico final 150 (obtuvo ${ret.total})`);
ok(near(ret.taxAmt, 22.88), `devolución respeta ITBIS histórico 22.88 (obtuvo ${ret.taxAmt})`);
ok(DB.productsRepo.getById(prodId).stock === stockBeforeReturn + 1, `devolución repone stock ${stockBeforeReturn}→${stockBeforeReturn + 1}`);
const saleWithReturn = DB.salesRepo.getAll({ range: 'all' }).find(s => s.id === c2.saleId);
ok(Number(saleWithReturn?.has_active_return) === 1, 'venta original queda identificada para salir de la pantalla Ventas');
ok(!DB.salesRepo.getAll({ range: 'all', view: 'sales' }).some(s => s.id === c2.saleId),
  'la vista Ventas excluye la factura desde que se registra la devolución');
ok(DB.salesRepo.countAll({ range: 'all', view: 'sales' }) ===
   DB.salesRepo.getAll({ range: 'all', view: 'sales' }).length,
  'el contador de Ventas usa el mismo filtro que el listado');
const stockBeforeCancelReturn = DB.productsRepo.getById(prodId).stock;
DB.returnsRepo.cancel(ret.returnId, 'devolución registrada por error', userId, user.name);
ok(DB.productsRepo.getById(prodId).stock === stockBeforeCancelReturn - 1,
  'anular devolución retira nuevamente el artículo del inventario');
ok(DB.salesRepo.getById(c2.saleId).status === 'completed',
  'anular la única devolución reactiva la factura original');
ok(DB.salesRepo.getAll({ range: 'all', view: 'sales' }).some(s => s.id === c2.saleId),
  'al anular la devolución, la factura vuelve a aparecer en Ventas');
ok(!DB.salesRepo.getAll({ range: 'all' }).some(s => s.id === ret.returnId),
  'devolución anulada desaparece del listado operativo');
const saleToCancel = DB.salesRepo.create({
  customer: { id: custId, name: 'x' },
  items: [item(1, 150)],
  payment: { method: 'efectivo' },
  user,
  type: 'factura',
});
DB.salesRepo.cancel(saleToCancel.saleId, 'venta creada por error', userId, user.name);
ok(DB.salesRepo.getById(saleToCancel.saleId).status === 'cancelled',
  'Anular marca la venta como anulada para conservar solo la auditoría');
ok(!DB.salesRepo.getAll({ range: 'all', view: 'sales' }).some(s => s.id === saleToCancel.saleId),
  'una venta anulada deja de existir en la pantalla Ventas');

console.log('\n== C2b. Cobros USD y tarjeta profesional ==');
// La suite financiera inicializa solo el esquema núcleo; recrear aquí las tablas
// que en la aplicación real instala la migración del módulo Bancos.
db.exec(`
  CREATE TABLE IF NOT EXISTS financial_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
    bank_name TEXT DEFAULT '', account_number TEXT DEFAULT '', currency TEXT DEFAULT 'DOP',
    account_subtype TEXT DEFAULT '', initial_balance REAL DEFAULT 0,
    current_balance REAL DEFAULT 0, description TEXT DEFAULT '', notes TEXT DEFAULT '',
    user_id INTEGER, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS financial_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, financial_account_id INTEGER NOT NULL,
    type TEXT NOT NULL, amount REAL NOT NULL, balance_before REAL DEFAULT 0,
    balance_after REAL DEFAULT 0, description TEXT DEFAULT '', reference_type TEXT DEFAULT '',
    reference_id INTEGER, related_account_id INTEGER, method TEXT DEFAULT 'efectivo',
    notes TEXT DEFAULT '', user_id INTEGER, status TEXT DEFAULT 'activo',
    cancelled_by INTEGER, cancel_reason TEXT, cancelled_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
const usdAccountId = DB.financialAccountsRepo.create({
  name: 'Cuenta USD Test', type: 'banco', bank_name: 'BanReservas',
  currency: 'USD', account_subtype: 'corriente', userId,
});
const usdSale = DB.salesRepo.create({
  customer: { id: custId, name: 'x' },
  items: [item(1, 118)],
  payment: {
    method: 'transferencia', financialAccountId: usdAccountId,
    exchangeRate: 59, reference: 'TRX-USD-001',
  },
  user,
  type: 'factura',
});
const usdSaleRow = DB.salesRepo.getById(usdSale.saleId);
ok(usdSaleRow.payment_currency === 'USD' && near(usdSaleRow.exchange_rate, 59),
  'venta conserva USD y la tasa histórica utilizada');
ok(near(usdSaleRow.account_amount, 2) && near(DB.financialAccountsRepo.getById(usdAccountId).current_balance, 2),
  'RD$118 se acreditan como US$2.00 en la cuenta USD');
ok(usdSaleRow.payment_reference === 'TRX-USD-001',
  'transferencia conserva su referencia bancaria');
const usdReturn = DB.returnsRepo.create({
  originalSaleId: usdSale.saleId,
  items: [{ ...item(1, 118), qty: 1 }],
  session: null,
  user,
  reason: 'devolución USD',
});
ok(near(DB.financialAccountsRepo.getById(usdAccountId).current_balance, 0),
  'devolución retira US$2.00 de la misma cuenta USD');
DB.returnsRepo.cancel(usdReturn.returnId, 'devolución USD anulada', userId, user.name);
ok(near(DB.financialAccountsRepo.getById(usdAccountId).current_balance, 2),
  'anular la devolución restaura exactamente US$2.00');
DB.salesRepo.cancel(usdSale.saleId, 'venta USD anulada', userId, user.name);
ok(near(DB.financialAccountsRepo.getById(usdAccountId).current_balance, 0),
  'anular la venta retira el monto USD, no el total nominal en RD$');

const visaAccountId = DB.financialAccountsRepo.create({
  name: 'Liquidación Visa', type: 'tarjeta', bank_name: 'Adquirente Test',
  currency: 'DOP', userId,
});
const cardSale = DB.salesRepo.create({
  customer: { id: custId, name: 'x' },
  items: [item(1, 118)],
  payment: {
    method: 'tarjeta', cardBrand: 'Visa', cardLast4: '4242',
    reference: 'AUTH-7788',
  },
  user,
  type: 'factura',
});
const cardSaleRow = DB.salesRepo.getById(cardSale.saleId);
ok(cardSaleRow.card_brand === 'Visa' && cardSaleRow.card_last4 === '4242' &&
   cardSaleRow.payment_reference === 'AUTH-7788',
  'tarjeta conserva marca, últimos 4 y autorización sin almacenar el número completo');
ok(Number(cardSaleRow.financial_account_id) === Number(visaAccountId) &&
   near(DB.financialAccountsRepo.getById(visaAccountId).current_balance, 118),
  'Visa se vincula automáticamente a su cuenta interna sin pedírsela al cajero');

const c3 = DB.salesRepo.create({ customer: { id: custId, name: 'x' }, items: [itemNoTax(1)], payment: { method: 'efectivo' }, user, type: 'factura' });
ok(near(c3.total, 100), `producto exento total 100 (obtuvo ${c3.total})`);
ok(near(c3.taxAmt, 0), `producto exento sin ITBIS (obtuvo ${c3.taxAmt})`);

console.log('\n== C3. Historial de cambios de costo/precio ==');
const histProdId = DB.productsRepo.create({
  code: 'PH1', name: 'Producto con Historial', cost: 100, price: 150,
  wholesale: 140, stock: 5, taxable: 1, tax_pct: 18,
});
const histBefore = DB.productsRepo.getById(histProdId);
DB.productsRepo.update(histProdId, {
  ...histBefore,
  cost: 120,
  price: 180,
  wholesale: 160,
}, { userId, source: 'manual', reason: 'cambio test' });
const histRows = DB.productsRepo.getPriceHistory(histProdId);
ok(histRows.length === 1, `edición manual registra 1 cambio (obtuvo ${histRows.length})`);
ok(near(histRows[0].cost_before, 100) && near(histRows[0].cost_after, 120), 'historial guarda costo antes/después');
ok(near(histRows[0].price_delta, 30), `historial guarda variación precio +30 (obtuvo ${histRows[0].price_delta})`);
ok(histRows[0].stock_at_change === 5, `historial guarda stock afectado 5 (obtuvo ${histRows[0].stock_at_change})`);
ok(near(histRows[0].stock_value_delta, 100), `historial valoriza variación costo 5*20=100 (obtuvo ${histRows[0].stock_value_delta})`);
const histListed = DB.productsRepo.getAll().find(p => p.id === histProdId);
ok(near(histListed.last_cost_delta, 20), `getAll expone último cambio de costo +20 (obtuvo ${histListed.last_cost_delta})`);

console.log('\n== C4. Contabilidad de ajuste de costo en inventario ==');
db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
const acctProdId = DB.productsRepo.create({
  code: 'AC1', name: 'Producto Ajuste Contable', cost: 100, price: 150,
  wholesale: 140, stock: 4, taxable: 1, tax_pct: 18,
});
const acctBefore = DB.productsRepo.getById(acctProdId);
const acctUpdate = DB.productsRepo.update(acctProdId, {
  ...acctBefore,
  cost: 125,
}, { userId, source: 'manual', reason: 'revalorización contable test' });
ok(!!acctUpdate?.historyId, 'edición de costo devuelve historyId para contabilidad');
const acctEntry = DB.accountingRepo.generateInventoryRevaluationEntry({ historyId: acctUpdate.historyId, userId });
ok(!!acctEntry?.entryId, 'cambio manual de costo genera asiento contable');
const acctHist = DB.productsRepo.getPriceHistory(acctProdId)[0];
ok(acctHist.accounting_entry_number === acctEntry.number, `historial queda enlazado al asiento ${acctEntry.number}`);
const invAccount = DB.accountingRepo.getAccountByCode('1105');
const gainAccount = DB.accountingRepo.getAccountByCode('4104');
ok(near(invAccount.balance, 100), `aumento de costo debita inventario por 4*25=100 (obtuvo ${invAccount.balance})`);
ok(near(gainAccount.balance, -100), `aumento de costo acredita ingreso por ajuste -100 (obtuvo ${gainAccount.balance})`);
const acctDup = DB.accountingRepo.generateInventoryRevaluationEntry({ historyId: acctUpdate.historyId, userId });
const adjCount = db.prepare("SELECT COUNT(*) c FROM accounting_entries WHERE source_module='inventario_valor' AND source_id=?").get(acctUpdate.historyId).c;
ok(acctDup?.entryId === acctEntry.entryId && adjCount === 1, 'ajuste contable es idempotente y no duplica asientos');
throws(() => DB.accountingRepo.reverseEntry(acctEntry.entryId, userId, 'intento directo'),
  'bloquea anulación directa de un asiento automático');
const autoVoid = DB.accountingRepo.reverseSourceEntry(
  'inventario_valor', acctUpdate.historyId, userId, 'origen anulado en prueba'
);
ok(autoVoid?.entryId === acctEntry.entryId &&
   DB.accountingRepo.getEntryById(acctEntry.entryId).status === 'anulado',
  'el módulo de origen puede anular su asiento automático sin crear reverso');
ok(near(DB.accountingRepo.getAccountByCode('1105').balance, 0) &&
   near(DB.accountingRepo.getAccountByCode('4104').balance, 0),
  'anular desde el origen restaura los saldos automáticos');

const cashAccount = DB.accountingRepo.getAccountByCode('1101');
const capitalAccount = DB.accountingRepo.getAccountByCode('3101');
throws(() => DB.accountingRepo.createEntry({
  date: '2026-07-20', concept: 'Línea inválida', source_module: 'manual', userId,
  lines: [
    { account_id: cashAccount.id, debit: 10, credit: 10 },
    { account_id: capitalAccount.id, debit: 0, credit: 0 },
  ],
}), 'rechaza líneas con débito y crédito simultáneos o ambos en cero');
const manualEntry = DB.accountingRepo.createEntry({
  date: '2026-07-20', concept: 'Asiento manual a anular', source_module: 'manual', userId,
  lines: [
    { account_id: cashAccount.id, debit: 25, credit: 0, description: 'Prueba' },
    { account_id: capitalAccount.id, debit: 0, credit: 25, description: 'Prueba' },
  ],
});
const cashBeforeVoid = DB.accountingRepo.getAccountByCode('1101').balance;
const capitalBeforeVoid = DB.accountingRepo.getAccountByCode('3101').balance;
const manualVoid = DB.accountingRepo.reverseEntry(manualEntry.entryId, userId, 'prueba de anulación');
const reversedOriginal = DB.accountingRepo.getEntryById(manualEntry.entryId);
ok(manualVoid.entryId === manualEntry.entryId && reversedOriginal.status === 'anulado',
  'anulación retira el asiento original sin crear otro documento');
ok(!DB.accountingRepo.getEntries({ includeHistory: false }).some(e =>
  e.id === manualEntry.entryId), 'lista normal oculta el asiento anulado');
ok(db.prepare("SELECT COUNT(*) c FROM accounting_entries WHERE source_module='reverso'").get().c === 0,
  'anular no crea ningún asiento REVERSO');
ok(near(DB.accountingRepo.getAccountByCode('1101').balance, cashBeforeVoid - 25) &&
   near(DB.accountingRepo.getAccountByCode('3101').balance, capitalBeforeVoid + 25),
  'anulación restaura directamente los saldos de las cuentas');
throws(() => DB.accountingRepo.reverseEntry(manualEntry.entryId, userId, 'segunda anulación'),
  'impide anular dos veces el mismo asiento');

const automaticEntry = DB.accountingRepo.createEntry({
  date: '2026-07-20', concept: 'Devolución automática corregible',
  source_module: 'devolucion', source_id: 999001, userId,
  lines: [
    { account_id: cashAccount.id, debit: 40, credit: 0, description: 'Prueba automática' },
    { account_id: capitalAccount.id, debit: 0, credit: 40, description: 'Prueba automática' },
  ],
});
const autoCashBeforeDelete = DB.accountingRepo.getAccountByCode('1101').balance;
const deletedAutomatic = DB.accountingRepo.deleteEntry(automaticEntry.entryId, userId, 'registro automático incorrecto');
ok(deletedAutomatic.entryId === automaticEntry.entryId &&
   DB.accountingRepo.getEntryById(automaticEntry.entryId).status === 'anulado',
  'Contabilidad puede retirar un asiento automático conservando su auditoría');
ok(near(DB.accountingRepo.getAccountByCode('1101').balance, autoCashBeforeDelete - 40) &&
   !DB.accountingRepo.getEntries().some(e => e.id === automaticEntry.entryId),
  'eliminar asiento automático restaura saldos y lo oculta de los libros vigentes');

db.prepare("DELETE FROM settings WHERE key='accounting_control_baseline'").run();
const reconciliationBefore = DB.accountingRepo.getReconciliation();
ok(reconciliationBefore.every(c => c.ok || c.state === 'pendiente'),
  'auxiliares históricos sin apertura se muestran pendientes, no como descuadre real');
const initialized = DB.accountingRepo.initializeReconciliation({ date: '2026-07-20', userId });
const reconciliationAfter = DB.accountingRepo.getReconciliation();
ok(initialized.ok && reconciliationAfter.every(c => c.ok && c.state === 'ok'),
  'inicialización crea una apertura balanceada y cuadra CxC, inventario y CxP');
throws(() => DB.accountingRepo.initializeReconciliation({ date: '2026-07-20', userId }),
  'la apertura de auxiliares solo puede ejecutarse una vez');

db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();

console.log('\n== C5. Flujo de estados de envíos ==');
const deliveryId = DB.deliveriesRepo.create({
  dest_address: 'Destino de prueba', delivery_fee: 500, user_id: userId,
});
throws(() => DB.deliveriesRepo.updateStatus(deliveryId, 'entregado', userId),
  'impide saltar un envío de pendiente directamente a entregado');
DB.deliveriesRepo.updateStatus(deliveryId, 'en_camino', userId);
ok(DB.deliveriesRepo.getById(deliveryId).status === 'en_camino', 'permite despachar un envío pendiente');
DB.deliveriesRepo.updateStatus(deliveryId, 'entregado', userId);
ok(DB.deliveriesRepo.getById(deliveryId).status === 'entregado' && !!DB.deliveriesRepo.getById(deliveryId).delivered_at,
  'confirmar entrega registra estado y fecha de entrega');
DB.deliveriesRepo.updateStatus(deliveryId, 'cancelado', userId);
ok(DB.deliveriesRepo.getById(deliveryId).status === 'cancelado' && !DB.deliveriesRepo.getById(deliveryId).delivered_at,
  'anular una entrega limpia la fecha y la envía al historial');
throws(() => DB.deliveriesRepo.updateStatus(deliveryId, 'en_camino', userId),
  'un envío cancelado no puede reactivarse');

const buyProdId = DB.productsRepo.create({
  code: 'PH2', name: 'Producto Compra Historial', cost: 50, price: 100,
  wholesale: 90, stock: 10, taxable: 1, tax_pct: 18,
});
db.exec(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    rnc TEXT DEFAULT '',
    address TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'activo',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER REFERENCES suppliers(id),
    supplier_name TEXT DEFAULT '',
    status TEXT DEFAULT 'pendiente' CHECK(status IN ('pendiente','recibido','parcial','cancelado')),
    subtotal REAL DEFAULT 0,
    tax_amt REAL DEFAULT 0,
    total REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    user_id INTEGER REFERENCES users(id),
    cajero TEXT DEFAULT '',
    received_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    product_id INTEGER REFERENCES products(id),
    product_code TEXT DEFAULT '',
    product_name TEXT NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0,
    qty_ordered INTEGER NOT NULL DEFAULT 0,
    qty_received INTEGER NOT NULL DEFAULT 0,
    subtotal REAL DEFAULT 0
  );
`);
const po = DB.purchasesRepo.create({
  supplierName: 'Proveedor Historial',
  items: [{
    product_id: buyProdId,
    product_code: 'PH2',
    product_name: 'Producto Compra Historial',
    unit_cost: 70,
    qty_ordered: 10,
  }],
  userId,
  cajero: 'Test',
});
const poItem = DB.purchasesRepo.getById(po.poId).items[0];
DB.purchasesRepo.receive(po.poId, { items: [{ ...poItem, qty_received: 10 }], userId });
const buyHist = DB.productsRepo.getPriceHistory(buyProdId);
ok(buyHist.length === 1 && buyHist[0].source === 'compra', 'recepción de compra registra historial con origen compra');
ok(near(buyHist[0].cost_before, 50) && near(buyHist[0].cost_after, 60), `compra pondera costo 50→60 (obtuvo ${buyHist[0].cost_after})`);
ok(buyHist[0].stock_at_change === 10, `compra afecta stock previo 10 (obtuvo ${buyHist[0].stock_at_change})`);
ok(near(buyHist[0].stock_value_delta, 100), `compra valoriza variación previa 10*10=100 (obtuvo ${buyHist[0].stock_value_delta})`);

const landedProdId = DB.productsRepo.create({
  code: 'PH3', name: 'Producto Costo Real', cost: 50, price: 100,
  wholesale: 90, stock: 10, taxable: 1, tax_pct: 18,
});
const poLanded = DB.purchasesRepo.create({
  supplierName: 'Proveedor Flete',
  items: [{
    product_id: landedProdId,
    product_code: 'PH3',
    product_name: 'Producto Costo Real',
    unit_cost: 60,
    qty_ordered: 10,
  }],
  userId,
  cajero: 'Test',
});
const landedItem = DB.purchasesRepo.getById(poLanded.poId).items[0];
const recvLanded = DB.purchasesRepo.receive(poLanded.poId, {
  items: [{ ...landedItem, qty_received: 10 }],
  userId,
  userName: 'Test',
  costs: { freight: 100 },
});
const landedAfter = DB.productsRepo.getById(landedProdId);
const landedPoAfter = DB.purchasesRepo.getById(poLanded.poId);
const landedHist = DB.productsRepo.getPriceHistory(landedProdId);
ok(near(recvLanded.receivedValue, 700), `recepción con flete reconoce costo real 700 (obtuvo ${recvLanded.receivedValue})`);
ok(near(landedPoAfter.freight_cost, 100) && near(landedPoAfter.landed_cost, 100), 'orden acumula flete/costo real');
ok(near(landedPoAfter.items[0].landed_unit_cost, 70), `línea guarda costo real unitario 70 (obtuvo ${landedPoAfter.items[0].landed_unit_cost})`);
ok(near(landedAfter.cost, 60), `costo promedio ponderado usa costo real 70 y queda 60 (obtuvo ${landedAfter.cost})`);
ok(landedHist[0].reason.includes('Costo real: 70'), 'historial explica costo real usado en la compra');
const priceReport = DB.reportsRepo.priceChanges({ range: 'all', limit: 20 });
ok(priceReport.summary.count >= 2, `reporte general incluye cambios de precio (${priceReport.summary.count})`);
ok(priceReport.rows.some(r => r.product_id === buyProdId), 'reporte lista cambio generado por compra');
ok(priceReport.rows.some(r => r.product_id === landedProdId && r.reason.includes('Costo real: 70')), 'reporte muestra cambio por costo real de recepción');

console.log('\n== D. Venta a crédito sube el balance del cliente ==');
const balBefore = DB.customersRepo.getById(custId).balance;
const d = DB.salesRepo.create({ customer: { id: custId, name: 'Taller Pérez' }, items: [item(1)], payment: { method: 'credito' }, user, type: 'factura' });
const balAfter = DB.customersRepo.getById(custId).balance;
ok(near(balAfter - balBefore, d.total), `balance +${d.total} tras venta a crédito (Δ=${(balAfter - balBefore).toFixed(2)})`);

console.log('\n== E. Abono baja el balance y el sobrepago se rechaza ==');
const preAbono = DB.customersRepo.getById(custId).balance;
DB.customersRepo.addPayment({ customerId: custId, amount: 50, method: 'efectivo', note: 'abono test', userId });
ok(near(DB.customersRepo.getById(custId).balance, preAbono - 50), `balance -50 tras abono (obtuvo ${DB.customersRepo.getById(custId).balance.toFixed(2)})`);
throws(() => DB.customersRepo.addPayment({ customerId: custId, amount: 9e9, method: 'efectivo', userId }), 'rechaza abono mayor al balance');

console.log('\n== F. Exclusión de "Importación histórica" ==');
db.prepare(`INSERT INTO sales(customer_id,customer_name,type,status,subtotal,total,cajero,user_id,created_at)
            VALUES(?,?,'factura','completed',500,590,'Importación histórica',?,datetime('now','localtime'))`).run(custId, 'Hist', userId);
const vivas = db.prepare("SELECT COUNT(*) c FROM sales WHERE date(created_at)=date('now','localtime') AND cajero!='Importación histórica'").get().c;
const hist  = db.prepare("SELECT COUNT(*) c FROM sales WHERE cajero='Importación histórica'").get().c;
ok(hist === 1, `1 venta histórica insertada (obtuvo ${hist})`);
ok(vivas >= 3 && vivas < 100, `las ventas vivas de hoy EXCLUYEN la histórica (obtuvo ${vivas})`);

console.log('\n== G. Normalizadores financieros (lib/normalize-financial) ==');
const { normalizeFinAcct, normalizeFinMov } = require('../lib/normalize-financial');
const na = normalizeFinAcct({ id: 1, current_balance: 250.5, active: 1 });
ok(na.balance === 250.5 && na.is_active === true, 'cuenta: current_balance→balance, active=1→is_active true');
ok(normalizeFinAcct({ current_balance: 0, active: 0 }).is_active === false, 'cuenta: active=0→is_active false');
ok(normalizeFinAcct(null) === null, 'cuenta: null → null');
ok(normalizeFinMov({ type: 'deposito' }).type === 'ingreso', "movimiento: deposito→ingreso");
ok(normalizeFinMov({ type: 'retiro' }).type === 'egreso' && normalizeFinMov({ type: 'retiro' }).is_outflow === true, 'movimiento: retiro→egreso, is_outflow true');
ok(normalizeFinMov({ type: 'deposito' }).db_type === 'deposito', 'movimiento: conserva db_type original');

console.log('\n== H. Helpers de fecha (lib/dates) ==');
const { todayStr, nowStr, addDaysStr } = require('../lib/dates');
ok(/^\d{4}-\d{2}-\d{2}$/.test(todayStr()), `todayStr formato YYYY-MM-DD (${todayStr()})`);
ok(/^\d{2}:\d{2}:\d{2}$/.test(nowStr()), `nowStr usa hora SQLite HH:MM:SS (${nowStr()})`);
ok(addDaysStr('2026-01-31', 1) === '2026-02-01', 'addDaysStr cruza fin de mes: 2026-01-31 +1 = 2026-02-01');
ok(addDaysStr('2026-12-31', 1) === '2027-01-01', 'addDaysStr cruza fin de año: 2026-12-31 +1 = 2027-01-01');
ok(addDaysStr('2024-02-28', 1) === '2024-02-29', 'addDaysStr respeta año bisiesto: 2024-02-28 +1 = 2024-02-29');
ok(addDaysStr('2026-01-01', 30) === '2026-01-31', 'addDaysStr +30 días (crédito): 2026-01-01 → 2026-01-31');

console.log('\n== J. Redondeo monetario (lib/money) ==');
const { round2 } = require('../lib/money');
ok(round2(0.1 + 0.2) === 0.3, 'round2 corrige 0.1+0.2 → 0.3');
ok(round2(1.005 * 100) === 100.5 && round2(236.004) === 236, 'round2 a 2 decimales');
ok(round2(200 * 0.18) === 36, 'round2(200*0.18) = 36 (ITBIS)');
ok(round2(100 / 3) === 33.33, 'round2(100/3) = 33.33');

console.log('\n== K. Plantilla A4: factura histórica con ITBIS calculable ==');
const vm = require('vm');
global.buildLogoHeader = () => '';
global.facturaLabel = s => s.numero_factura_fmt || String(s.id || '');
global.facturaLabelOriginal = () => '';
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/js/plantillas.js'), 'utf8'));
const legacyHtml = renderCartaRecibo({
  id: 2335,
  numero_factura_fmt: '00002335',
  type: 'factura',
  status: 'completed',
  date: '2026-06-27',
  customer_name: 'MARCIAL NUÑEZ ROSARIO',
  payment_method: 'efectivo',
  tax_pct: 18,
  tax_amt: 0,
  subtotal: 16152.54,
  total: 16152.54,
  cajero: 'Test',
  items: [
    { product_code: '57054-16100', product_name: 'EJE COMPLETO TRANSMISION', qty: 1, unit_price: 10593.22, subtotal: 10593.22 },
    { product_code: '5H491-16250', product_name: 'ENGRANAJE DOBLE DE LA TRANSMISION', qty: 2, unit_price: 2779.66, subtotal: 5559.32 },
  ],
}, { biz_name: 'EQUIPARTS', biz_rnc: '131-96863-5', biz_addr: 'La Vega', biz_phone: '809', receipt_msg: 'Gracias' }, {
  logo: false, rnc: true, ncf: true, mensaje: true, cedula: true,
});
ok(legacyHtml.includes('RECIBO DE PAGO'), 'A4 pagada se titula RECIBO DE PAGO');
ok(legacyHtml.includes('Código') && legacyHtml.includes('ITBIS') && legacyHtml.includes('Importe'), 'A4 muestra Código, ITBIS e Importe');
ok(legacyHtml.includes('2,463.95'), 'A4 extrae ITBIS incluido desde líneas legacy sin tax_amt');
ok(legacyHtml.includes('16,152.54'), 'A4 conserva el total histórico ya cobrado sin inflarlo');
const usdHtml = renderCartaRecibo({
  id: 3001, type: 'factura', status: 'completed', date: '2026-07-20',
  customer_name: 'Cliente USD', payment_method: 'transferencia',
  payment_currency: 'USD', exchange_rate: 60.25, account_amount: 10,
  total: 602.5, subtotal: 602.5, items: [], financial_account_id: 99,
  payment_reference: 'TRX-USD-001',
}, { biz_name: 'EQUIPARTS', bank_accounts: [{ id: 99, name: 'EQUIPARTS', bank_name: 'BanReservas', currency: 'USD' }] }, {
  logo: false, rnc: true, ncf: true, mensaje: true, cedula: true,
});
ok(usdHtml.includes('US$10.00') && usdHtml.includes('RD$60.25') && usdHtml.includes('TRX-USD-001'),
  'plantilla A4 muestra monto USD, tasa y referencia bancaria');
const cardHtml = renderCartaRecibo({
  id: 3002, type: 'factura', status: 'completed', date: '2026-07-20',
  customer_name: 'Cliente Tarjeta', payment_method: 'tarjeta',
  card_brand: 'Mastercard', card_last4: '5454', payment_reference: 'AUTH-99',
  total: 500, subtotal: 500, items: [], financial_account_id: 77,
}, { biz_name: 'EQUIPARTS', bank_accounts: [{ id: 77, name: 'Cuenta interna', bank_name: 'Banco X' }] }, {
  logo: false, rnc: true, ncf: true, mensaje: true, cedula: true,
});
ok(cardHtml.includes('Tarjeta Mastercard') && cardHtml.includes('•••• 5454') && cardHtml.includes('AUTH-99'),
  'plantilla A4 refleja marca, últimos 4 y autorización de tarjeta');
ok(!cardHtml.includes('Cuenta interna') && !cardHtml.includes('Banco X'),
  'plantilla de tarjeta no expone la cuenta bancaria interna');
const documentSample = {
  id: 3003, type: 'factura', status: 'completed', date: '2026-07-20', time: '10:30',
  customer_name: 'Cliente Multiformato', customer_phone: '829-555-0000',
  customer_phone_type: 'celular', payment_method: 'efectivo',
  display_currency: 'USD', display_exchange_rate: 60, display_amount: 10,
  additional_charges_total: 128, total: 600, subtotal: 400, tax_amt: 72, tax_pct: 18,
  items: [
    { product_name: 'Producto', qty: 4, unit_price: 118, taxable: 1, tax_pct: 18 },
    { product_name: 'Envío', qty: 1, unit_price: 128, taxable: 0, tax_pct: 0, _is_charge: true },
  ],
};
const cfgSample = { biz_name: 'EQUIPARTS', biz_phone: '809', receipt_msg: 'Gracias' };
const optsSample = { logo: false, rnc: true, ncf: true, mensaje: true, cedula: true, _estilos: {} };
[
  'termica_58_basica', 'termica_80_clasica', 'termica_80_moderna', 'termica_80_minimal',
  'carta_recibo', 'carta_formal', 'carta_ncf', 'media_carta',
].forEach(id => {
  const html = getPlantilla(id).render(documentSample, cfgSample, optsSample);
  ok(html.includes('US$10.00') && html.includes('Celular') && html.includes('Envío'),
    `${id} imprime USD, tipo de teléfono y cargo`);
});

console.log('\n== I. Normalización de búsqueda (lib/text-normalize) ==');
const { searchNorm, digitsOf } = require('../lib/text-normalize');
ok(searchNorm('Ñoño') === 'nono', "searchNorm quita tildes/Ñ: 'Ñoño'→'nono'");
ok(searchNorm('  José García  ') === 'jose garcia', 'searchNorm minúsculas + trim');
ok(searchNorm(null) === '' && searchNorm(undefined) === '', 'searchNorm tolera null/undefined');
ok(digitsOf('809-555-1234') === '8095551234', 'digitsOf deja solo dígitos');
ok(digitsOf('RNC: 1-30-12345-6') === '130123456', 'digitsOf sobre RNC con guiones');

// ── Limpieza ──
db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
