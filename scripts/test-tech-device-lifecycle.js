#!/usr/bin/env node
'use strict';

// VELO TECH POS · ciclo verificable del equipo:
// recepción técnica, compra a una persona, inventario unitario y venta.
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
const ok = (condition, message) => {
  if (condition) { passed += 1; console.log('  ✓', message); }
  else { failed += 1; console.error('  ✗', message); }
};

const tempDir = path.join(os.tmpdir(), `velo_tech_lifecycle_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

try {
  const admin = db.prepare("SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();
  const terms = 'EL VENDEDOR DECLARA SER PROPIETARIO DEL EQUIPO Y AUTORIZA SU COMPRA.';
  DB.settingsRepo.set('tech_private_purchase_terms', terms);
  DB.settingsRepo.set('service_default_warranty_days', '45');
  DB.settingsRepo.set('module_contabilidad', '1');

  console.log('== VELO TECH · ciclo de equipos y documentos ==');

  const templateId = DB.techDescriptionTemplatesRepo.save({
    name: 'USADO GRADO A',
    description: 'EQUIPO USADO PROBADO, LIBERADO Y EN EXCELENTE CONDICIÓN.',
  }, admin.id);
  const template = DB.techDescriptionTemplatesRepo.list().find(row => Number(row.id) === Number(templateId));
  ok(template?.description.includes('EXCELENTE CONDICIÓN'), 'guarda descripciones reutilizables para la factura');

  const productId = DB.productsRepo.create({
    code: 'CEL-USADO', name: 'iPhone 13 usado', brand: 'Apple', model: 'iPhone 13',
    cost: 0, price: 24000, stock: 0, taxable: 1, tax_pct: 18,
  });
  DB.productUnitsRepo.setSerialized(productId, true);

  const service = DB.serviceOrdersRepo.create({
    customer_id: 1,
    device_desc: 'iPhone 13',
    problem: 'No enciende',
    intake_condition: 'Pantalla intacta',
    battery_health: 82,
    battery_capacity_mah: 3227,
  }, admin);
  ok(Number(service.battery_health) === 82 && Number(service.battery_capacity_mah) === 3227,
    'la recepción técnica conserva condición y capacidad de batería');
  ok(Number(service.service_warranty_days) === 45,
    'la recepción toma la garantía predeterminada configurada');

  const purchaseData = {
    seller_name: 'María Pérez', seller_document: '001-0000000-1',
    seller_phone: '8095550101', seller_address: 'Santo Domingo',
    seller_email: 'maria@example.com', product_id: productId,
    device_name: 'iPhone 13 usado', brand: 'Apple', model: 'iPhone 13',
    imei: '350000000000701', color: 'Negro', capacity: '128GB',
    battery_health: 84, battery_capacity_mah: 3227,
    physical_condition: 'Sin golpes; pantalla y cámaras probadas.',
    sale_description: template.description,
    accessories: ['CABLE'], amount: 12000, payment_method: 'efectivo',
    terms_snapshot: terms, ownership_declared: true, lawful_origin_declared: true,
    seller_signature_name: 'María Pérez', business_signature_name: admin.name,
  };

  let noCashBlocked = false;
  try { DB.techPrivatePurchasesRepo.create(purchaseData, admin, null); }
  catch { noCashBlocked = true; }
  ok(noCashBlocked && DB.productUnitsRepo.effectiveStock(productId) === 0,
    'una compra en efectivo exige caja abierta y no deja inventario parcial');

  const cashId = DB.cashRepo.open({
    userId: admin.id, cajero: admin.name, openAmount: 20000, openBills: {}, terminalId: 'TECH-QA',
  });
  const cashSession = DB.cashRepo.getOpen('TECH-QA');
  const cashPurchase = DB.techPrivatePurchasesRepo.create(purchaseData, admin, cashSession);
  const purchasedUnit = DB.productUnitsRepo.findByImei(purchaseData.imei);
  ok(cashPurchase.data.number.startsWith('CPU-') && purchasedUnit?.status === 'en_stock',
    'la compra genera documento y agrega exactamente una unidad al inventario');
  ok(Number(purchasedUnit.battery_health) === 84 && Number(purchasedUnit.battery_capacity_mah) === 3227,
    'el inventario conserva salud y capacidad de batería del usado');
  ok(JSON.parse(cashPurchase.data.accessories).includes('CABLE'),
    'el contrato conserva los accesorios que entregó el vendedor');
  ok(purchasedUnit.sale_description.includes('EQUIPO USADO PROBADO'),
    'la descripción comercial queda vinculada a la unidad concreta');
  const cashMovement = db.prepare("SELECT * FROM cash_movements WHERE cash_session_id=? AND type='salida'").get(cashId);
  ok(Number(cashMovement?.amount) === 12000,
    'el pago al vendedor queda registrado como salida del cuadre de caja');

  DB.settingsRepo.set('tech_private_purchase_terms', 'TÉRMINOS NUEVOS PARA OPERACIONES FUTURAS.');
  ok(DB.techPrivatePurchasesRepo.getById(cashPurchase.purchaseId).terms_snapshot === terms,
    'el contrato conserva una copia inmutable de los términos firmados');

  let duplicateBlocked = false;
  try { DB.techPrivatePurchasesRepo.create(purchaseData, admin, cashSession); }
  catch { duplicateBlocked = true; }
  ok(duplicateBlocked && DB.productUnitsRepo.effectiveStock(productId) === 1,
    'rechaza IMEI duplicado sin duplicar inventario ni contrato');

  const bankId = DB.financialAccountsRepo.create({
    name: 'Banco TECH QA', type: 'banco', bank_name: 'Banco QA', account_number: '001', userId: admin.id,
  });
  const bankPurchase = DB.techPrivatePurchasesRepo.create({
    ...purchaseData,
    imei: '350000000000702',
    amount: 9000,
    payment_method: 'transferencia',
    payment_reference: 'TRX-QA-01',
    financial_account_id: bankId,
    terms_snapshot: 'TÉRMINOS NUEVOS PARA OPERACIONES FUTURAS.',
  }, admin, cashSession);
  const bank = DB.financialAccountsRepo.getById(bankId);
  ok(Number(bank.current_balance) === -9000 && bankPurchase.data.financial_account_id === bankId,
    'la transferencia queda enlazada y descuenta la cuenta bancaria elegida');

  const entries = db.prepare("SELECT * FROM accounting_entries WHERE source_module='compra_usado'").all();
  const balanced = entries.length === 2 && entries.every(entry => {
    const sums = db.prepare('SELECT ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM accounting_entry_lines WHERE entry_id=?').get(entry.id);
    return Number(sums.debit) === Number(sums.credit);
  });
  ok(balanced, 'cada compra genera un asiento contable cuadrado cuando Contabilidad está activa');

  const sale = DB.salesRepo.create({
    session: null, customer: { id: 1 }, user: admin, type: 'factura',
    items: [{
      product_id: productId, product_code: 'CEL-USADO', product_name: 'iPhone 13 usado',
      product_unit_id: purchasedUnit.id, unit_price: 24000, qty: 1, taxable: 1, tax_pct: 18,
    }],
    payment: { method: 'efectivo' },
  });
  const saleLine = db.prepare('SELECT product_name FROM sale_items WHERE sale_id=?').get(sale.saleId);
  ok(saleLine.product_name.includes('EQUIPO USADO PROBADO'),
    'la descripción guardada sale en la línea de la factura al vender ese equipo');

  const fungibleId = DB.productsRepo.create({
    code: 'ACC-QA', name: 'Cable USB', cost: 100, price: 250, stock: 5,
  });
  ok(DB.productUnitsRepo.effectiveStock(fungibleId) === 5,
    'los productos no serializados conservan su funcionamiento anterior');

  console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { DB.getDB()?.close(); } catch {}
}
