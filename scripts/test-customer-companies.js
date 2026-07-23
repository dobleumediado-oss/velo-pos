#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log('  ✓', message); }
  else { fail++; console.log('  ✗ FALLO:', message); }
}
function throws(fn, message) {
  try { fn(); ok(false, `${message} (no lanzó)`); }
  catch { ok(true, message); }
}

const tempDir = path.join(os.tmpdir(), `velo_companies_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const admin = db.prepare("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();

console.log('\n== A. Cuenta empresarial y representantes ==');
const companyId = DB.customersRepo.create({
  customer_type: 'company', name: 'Motores del Caribe, SRL', trade_name: 'MotoCaribe',
  rnc: '130123456', phone: '809-555-1000', address: 'Av. Principal 10',
  email: 'info@motocaribe.do', billing_email: 'facturas@motocaribe.do',
  preferred_price_mode: 'wholesale', credit_limit: 5000, credit_days: 30,
});
const contactId = DB.customersRepo.createContact(companyId, {
  name: 'Ana Pérez', document: '00100000001', role: 'Encargada de compras',
  phone: '809-555-2000', email: 'ana@motocaribe.do', is_primary: 1,
});
const company = DB.customersRepo.getById(companyId);
ok(company.customer_type === 'company' && company.trade_name === 'MotoCaribe',
  'guarda la empresa sin convertirla en una persona');
ok(company.contacts.length === 1 && company.contacts[0].id === contactId,
  'devuelve los representantes dentro de la cuenta empresarial');
ok(company.contacts[0].is_primary === 1 && company.contacts[0].can_order === 1,
  'conserva representante principal y permisos operativos');
throws(() => DB.customersRepo.create({ name:'Duplicado', rnc:'130-123456' }),
  'impide duplicar un RNC aunque cambie el formato');
const personId = DB.customersRepo.create({ name:'Cliente Persona', rnc:'00100000002' });
throws(() => DB.customersRepo.createContact(personId, { name:'Contacto inválido' }),
  'una persona no puede recibir representantes empresariales');

console.log('\n== B. Venta usa la empresa y guarda snapshot ==');
const productId = DB.productsRepo.create({
  code:'EMP-001', name:'Producto empresarial', cost:50, price:118,
  stock:10, taxable:1, tax_pct:18,
});
const item = qty => ({
  product_id:productId, product_code:'EMP-001', product_name:'Producto empresarial',
  unit_cost:50, unit_price:118, qty, taxable:1, tax_pct:18,
});
const sale = DB.salesRepo.create({
  session:null,
  customer:{ id:companyId, name:'Nombre manipulado', rnc:'000', contact_id:contactId },
  items:[item(1)], payment:{ method:'efectivo', priceMode:'wholesale' },
  user:admin, type:'factura',
});
const storedSale = DB.salesRepo.getById(sale.saleId);
ok(storedSale.customer_name === 'Motores del Caribe, SRL' && storedSale.customer_rnc === '130123456',
  'el backend usa los datos reales de la empresa, no texto alterado desde el POS');
ok(storedSale.customer_contact_name === 'Ana Pérez' && storedSale.customer_contact_role === 'Encargada de compras',
  'la venta conserva el representante seleccionado');
ok(storedSale.customer_email === 'facturas@motocaribe.do' && storedSale.customer_address === 'Av. Principal 10',
  'guarda correo de facturación y dirección como snapshot histórico');

const changedCompany = DB.customersRepo.getById(companyId);
DB.customersRepo.update(companyId, { ...changedCompany, name:'Motores del Caribe Renovado, SRL', address:'Dirección nueva' });
DB.customersRepo.updateContact(contactId, { ...company.contacts[0], name:'Ana Pérez Actualizada' });
const historicalSale = DB.salesRepo.getById(sale.saleId);
ok(historicalSale.customer_name === 'Motores del Caribe, SRL' && historicalSale.customer_address === 'Av. Principal 10',
  'editar la empresa no cambia una factura anterior');
ok(historicalSale.customer_contact_name === 'Ana Pérez',
  'editar el representante no cambia una factura anterior');

console.log('\n== C. Preventa conserva el representante hasta caja ==');
const order = DB.checkoutOrdersRepo.create({
  customer:{ id:companyId, contact_id:contactId }, items:[item(2)],
  priceMode:'wholesale', createdBy:admin.id, createdByName:admin.name,
  terminalId:'despacho-empresa', reservationMinutes:30,
});
ok(order.customer_name === 'Motores del Caribe Renovado, SRL' && order.customer_contact_name === 'Ana Pérez Actualizada',
  'la orden guarda la empresa y el representante vigentes al prepararse');
DB.customersRepo.updateContact(contactId, { ...DB.customersRepo.getContacts(companyId)[0], name:'Cambio posterior' });
const companyAfterOrder = DB.customersRepo.getById(companyId);
DB.customersRepo.update(companyId, { ...companyAfterOrder, address:'Dirección posterior a la orden' });
const paid = DB.checkoutOrdersRepo.pay({
  id:order.id, payment:{ method:'efectivo' }, session:null,
  user:admin, terminalId:'caja-empresa',
});
const paidSale = DB.salesRepo.getById(paid.saleId);
ok(paidSale.customer_contact_name === 'Ana Pérez Actualizada',
  'caja factura con el snapshot de la orden aunque el contacto cambie después');
ok(paidSale.customer_address === 'Dirección nueva',
  'caja conserva los datos empresariales de la orden aunque la cuenta cambie después');
ok(paid.order.customer_contact_id === contactId && paid.order.status === 'paid',
  'la trazabilidad conecta orden, representante y venta');

console.log('\n== D. Crédito permanece consolidado en la empresa ==');
DB.salesRepo.create({
  session:null, customer:{ id:companyId, contact_id:contactId }, items:[item(1)],
  payment:{ method:'credito' }, user:admin, type:'factura',
});
const credited = DB.customersRepo.getById(companyId);
ok(credited.balance === 118, 'la deuda se acumula en la empresa, no en el representante');
ok(!Object.prototype.hasOwnProperty.call(credited.contacts[0], 'balance'),
  'los representantes no se convierten en cuentas por cobrar');

const payment = DB.customersRepo.addPayment({
  customerId:companyId, contactId, amount:18, method:'transferencia', note:'Abono empresarial',
  cajero:admin.name, userId:admin.id,
});
const storedPayment = DB.customersRepo.getPayments(companyId).find(p => p.id === payment.paymentId);
ok(storedPayment.customer_contact_name === 'Cambio posterior' && storedPayment.customer_contact_role === 'Encargada de compras',
  'el abono conserva quién pagó en nombre de la empresa');
DB.customersRepo.updateContact(contactId, { ...DB.customersRepo.getContacts(companyId)[0], name:'Cambio después del abono' });
ok(DB.customersRepo.getPayments(companyId).find(p => p.id === payment.paymentId).customer_contact_name === 'Cambio posterior',
  'editar el representante no altera el recibo de abono histórico');
ok(DB.customersRepo.getById(companyId).balance === 100,
  'el abono del representante reduce la cuenta consolidada de la empresa');

console.log('\n== E. Conduce y envío conservan la cadena empresarial ==');
const conduceId = DB.conduceRepo.create({
  header:{
    customer_id:companyId, customer_name:'Nombre manipulado', customer_rnc:'000',
    customer_contact_id:contactId, source_type:'manual',
  },
  items:[{ product_id:productId, product_code:'EMP-001', description:'Producto empresarial', qty:1 }],
  userId:admin.id,
});
const conduce = DB.conduceRepo.getById(conduceId);
ok(conduce.customer_name === 'Motores del Caribe Renovado, SRL' && conduce.customer_contact_name === 'Cambio después del abono',
  'el conduce usa la empresa y representante vigentes desde la base de datos');
const otherCompanyId = DB.customersRepo.create({ customer_type:'company', name:'Otra Empresa', rnc:'101010101' });
const otherContactId = DB.customersRepo.createContact(otherCompanyId, { name:'Contacto Ajeno' });
ok(DB.customersRepo.getContacts(otherCompanyId)[0].is_primary === 1,
  'el primer representante queda como principal automáticamente');
throws(() => DB.conduceRepo.update(conduceId, {
  header:{ customer_id:companyId, customer_contact_id:otherContactId }, items:null,
}), 'impide asignar al conduce un representante de otra empresa');

const deliveryId = DB.deliveriesRepo.create({
  customer_id:companyId, customer_name:'Motores del Caribe Renovado, SRL',
  customer_contact_id:contactId, dest_address:'Santo Domingo', user_id:admin.id,
});
const delivery = DB.deliveriesRepo.getById(deliveryId);
ok(delivery.customer_contact_name === 'Cambio después del abono' && delivery.customer_contact_role === 'Encargada de compras',
  'el envío conserva el representante responsable de la entrega');

const receivingOnlyId = DB.customersRepo.createContact(companyId, {
  name:'Solo Recepción', can_order:0, can_receive:1,
});
throws(() => DB.salesRepo.create({
  session:null, customer:{ id:companyId, contact_id:receivingOnlyId }, items:[item(1)],
  payment:{ method:'efectivo' }, user:admin, type:'factura',
}), 'un contacto de recepción no puede figurar como solicitante de una venta');
const receivingDeliveryId = DB.deliveriesRepo.create({
  customer_id:companyId, customer_contact_id:receivingOnlyId, dest_address:'Santo Domingo', user_id:admin.id,
});
ok(DB.deliveriesRepo.getById(receivingDeliveryId).customer_contact_name === 'Solo Recepción',
  'un contacto autorizado para recibir sí puede vincularse al envío');

const saleConduce = DB.conduceRepo.createFromSale(sale.saleId, { userId:admin.id });
ok(saleConduce.customer_name === 'Motores del Caribe, SRL' && saleConduce.customer_contact_name === 'Ana Pérez',
  'un conduce generado desde factura conserva el snapshot histórico de la factura');

DB.customersRepo.deleteContact(contactId);
ok(!DB.customersRepo.getContacts(companyId).some(contact => contact.id === contactId),
  'desactivar un representante lo retira de operaciones nuevas sin borrar el historial');
ok(DB.salesRepo.getById(sale.saleId).customer_contact_name === 'Ana Pérez',
  'el historial sobrevive a la desactivación del representante');

db.close();
try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch {}

console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
process.exit(fail ? 1 : 0);
