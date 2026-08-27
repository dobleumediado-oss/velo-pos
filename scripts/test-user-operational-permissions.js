#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const permissions = require('../lib/user-operational-permissions');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo_user_permissions_'));
const DB = require('../database');

try {
  DB.initDB(tempDir);
  const db = DB.getDB();
  require('../versioning').initVersioning(db, tempDir);

  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  assert(columns.has('can_sell_credit'));
  assert(columns.has('credit_limit_per_sale'));
  assert(columns.has('can_manage_inventory'));
  assert(columns.has('module_permissions'));

  const cashierId = DB.usersRepo.create({
    name: 'Caja limitada', email: 'caja.limitada@prueba.do', password: 'prueba123', role: 'cajero',
    can_sell_credit: 1, credit_limit_per_sale: 5000, can_manage_inventory: 1,
  });
  const cashier = DB.authRepo.findById(cashierId);
  assert.strictEqual(permissions.canManageInventory(cashier), true);
  assert.strictEqual(permissions.evaluateCreditPermission(cashier, 5000).allowed, true);
  assert.strictEqual(permissions.evaluateCreditPermission(cashier, 5000.01).allowed, false);

  const withoutInventory = DB.usersRepo.setModulePolicy(cashierId, {
    moduleKey: 'inventario', enabled: false,
  });
  assert.strictEqual(permissions.canManageInventory(withoutInventory), false,
    'la política modular individual prevalece sobre el campo heredado');
  const withInventory = DB.usersRepo.setModulePolicy(cashierId, {
    moduleKey: 'inventario', enabled: true,
  });
  assert.strictEqual(permissions.canManageInventory(withInventory), true);

  const customerId = DB.customersRepo.create({
    name: 'Cliente crédito controlado', credit_limit: 100000, credit_days: 30,
  });
  const productId = DB.productsRepo.create({
    code: 'PERM-001', name: 'Producto permiso', cost: 1000, price: 6000,
    stock: 4, taxable: 1, tax_pct: 18,
  });
  const sessionId = DB.cashRepo.open({
    userId: cashier.id, cajero: cashier.name, openAmount: 1000, openBills: {}, terminalId: 'test-permissions',
  });
  const makeSale = (unitPrice, initialPaymentAmount = 1000) => DB.salesRepo.create({
    customer: { id: customerId },
    items: [{
      product_id: productId, product_code: 'PERM-001', product_name: 'Producto permiso',
      unit_cost: 1000, unit_price: unitPrice, qty: 1, taxable: 1, tax_pct: 18,
    }],
    payment: { method: 'credito', initialPaymentAmount, initialPaymentMethod: 'efectivo' },
    session: { id: sessionId }, user: cashier, type: 'factura',
  });

  const accepted = makeSale(6000);
  assert(accepted.saleId, 'total 6,000 menos inicial 1,000 acepta el límite exacto de 5,000');
  assert.throws(() => makeSale(6000.01), /supera el límite del usuario/);

  DB.usersRepo.setModulePolicy(cashierId, {
    moduleKey: 'credito', enabled: true, creditLimit: 20000,
  });
  const cashierWithMoreCredit = DB.authRepo.findById(cashierId);
  DB.settingsRepo.set('pos_cashier_auto_credit_limit_amount', '10000');
  const autoCreditProductId = DB.productsRepo.create({
    code: 'AUTO-CRED-001', name: 'Producto crédito automático', cost: 1000,
    price: 12000, stock: 3, taxable: 1, tax_pct: 18,
  });
  const autoCreditSale = (customerId, amount, approval = {}) => DB.salesRepo.create({
    customer: { id: customerId },
    items: [{
      product_id: autoCreditProductId, product_code: 'AUTO-CRED-001',
      product_name: 'Producto crédito automático', unit_cost: 1000,
      unit_price: amount, qty: 1, taxable: 1, tax_pct: 18,
    }],
    payment: { method: 'credito', ...approval },
    session: { id: sessionId }, user: cashierWithMoreCredit, type: 'factura',
  });
  const customerWithoutLimit = DB.customersRepo.create({
    name: 'Cliente sin límite inicial', credit_limit: 0, credit_days: 30,
  });
  const autoAssigned = autoCreditSale(customerWithoutLimit, 7500);
  assert.strictEqual(autoAssigned.autoCreditLimitAssigned, 7500);
  assert.strictEqual(DB.customersRepo.getById(customerWithoutLimit).credit_limit, 7500,
    'la primera venta asigna al cliente el mismo monto que queda a crédito');

  const customerAboveCashierLimit = DB.customersRepo.create({
    name: 'Cliente requiere autorización', credit_limit: 0, credit_days: 30,
  });
  assert.throws(() => autoCreditSale(customerAboveCashierLimit, 12000),
    /supera el máximo automático del cajero/);
  const approvedAutoCredit = autoCreditSale(customerAboveCashierLimit, 12000, {
    creditLimitApprovedBy: 1,
    creditLimitApprovedMaxAmount: 12000,
  });
  assert.strictEqual(approvedAutoCredit.autoCreditLimitAssigned, 12000,
    'la autorización administrativa permite superar el umbral configurado');

  DB.usersRepo.setModulePolicy(cashierId, {
    moduleKey: 'credito', enabled: false, creditLimit: 5000,
  });
  assert.throws(() => makeSale(1000, 0), /no tiene permiso para realizar ventas a crédito/);

  const refreshed = DB.authRepo.findById(cashierId);
  assert.strictEqual(permissions.canManageInventory(refreshed), true);
  assert.strictEqual(permissions.canSellOnCredit(refreshed), false);

  global.window = { _vertical: { id: 'auto_parts' }, _bcEnabled: true };
  global.CFG = {
    module_preventa: '1', module_preventa_roles: 'admin,cajero',
    barcode_enabled_roles: 'admin,cajero',
  };
  require('../src/js/module-access');
  assert(window.VELO_MODULE_CATALOG.length >= 25, 'el catálogo incluye módulos base y opcionales');
  const uiCashier = {
    role: 'cajero', can_sell_credit: 1, can_manage_inventory: 0,
    module_permissions: JSON.stringify({ compras: true, clientes: false }),
  };
  assert.strictEqual(window.veloCanAccessModule('pos', uiCashier), true);
  assert.strictEqual(window.veloCanAccessModule('compras', uiCashier), true);
  assert.strictEqual(window.veloCanAccessModule('clientes', uiCashier), false);
  assert.strictEqual(window.veloCanAccessModule('inventario', uiCashier), false);
  assert.strictEqual(window.veloCanAccessModule('servicio', uiCashier), false,
    'Servicio técnico no aparece en VELO POS');
  window._vertical.id = 'tech';
  assert.strictEqual(window.veloCanAccessModule('servicio', uiCashier), true,
    'Servicio técnico conserva el acceso inicial en VELO TECH POS');
  delete global.CFG;
  delete global.window;

  console.log('✓ Centro modular, permisos por cajero, límite autoritativo y ambos verticales verificados');
  db.close();
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
