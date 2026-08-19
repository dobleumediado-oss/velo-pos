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

  const cashierId = DB.usersRepo.create({
    name: 'Caja limitada', email: 'caja.limitada@prueba.do', password: 'prueba123', role: 'cajero',
    can_sell_credit: 1, credit_limit_per_sale: 5000, can_manage_inventory: 1,
  });
  const cashier = DB.authRepo.findById(cashierId);
  assert.strictEqual(permissions.canManageInventory(cashier), true);
  assert.strictEqual(permissions.evaluateCreditPermission(cashier, 5000).allowed, true);
  assert.strictEqual(permissions.evaluateCreditPermission(cashier, 5000.01).allowed, false);

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

  DB.usersRepo.update(cashierId, {
    ...cashier, can_sell_credit: 0, credit_limit_per_sale: 5000, can_manage_inventory: 1,
  });
  assert.throws(() => makeSale(1000, 0), /no tiene permiso para realizar ventas a crédito/);

  const refreshed = DB.authRepo.findById(cashierId);
  assert.strictEqual(permissions.canManageInventory(refreshed), true);
  assert.strictEqual(permissions.canSellOnCredit(refreshed), false);

  console.log('✓ Permisos por cajero, límite autoritativo y acceso de inventario verificados');
  db.close();
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
