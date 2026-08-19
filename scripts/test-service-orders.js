#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const ok = (condition, message) => {
  if (condition) { passed++; console.log('  ✓', message); }
  else { failed++; console.error('  ✗', message); }
};

const tempDir = path.join(os.tmpdir(), `velo_service_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);
const admin = db.prepare("SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();

console.log('== Taller profesional · recepción, aprobación, reservas, calidad y garantía ==');

const partId = DB.productsRepo.create({
  code:'REP-PANT', name:'Pantalla de reemplazo', cost:2500, price:4500,
  stock:5, taxable:1, tax_pct:18,
});
const deviceProductId = DB.productsRepo.create({
  code:'PHONE-13', name:'iPhone 13', cost:18000, price:26000,
  stock:0, taxable:1, tax_pct:18, serialized:1,
});
DB.productUnitsRepo.setSerialized(deviceProductId, true);
const unitId = DB.productUnitsRepo.create({
  product_id:deviceProductId, imei:'359999999999999', status:'vendido', unit_cost:18000,
});
const technicianId = DB.serviceOrdersRepo.saveTechnician({
  name:'Ana Técnica', specialty:'Celulares', commission_pct:10,
});
const order = DB.serviceOrdersRepo.create({
  customer_id:1, product_unit_id:unitId, device_desc:'iPhone 13', imei:'359999999999999',
  problem:'Pantalla rota', intake_condition:'Golpe en esquina superior',
  accessories_received:['Funda'], intake_checklist:{ power:'funciona', charge:'funciona' },
  privacy_consent:true, notes:'Recibido sin cargador', service_technician_id:technicianId,
}, admin);
ok(order.number === 'SRV-000001' && order.workflow_status === 'recepcion', 'crea la recepción profesional con número estable');
ok(order.product_unit_id === unitId && DB.productUnitsRepo.findById(unitId).status === 'servicio', 'enlaza el IMEI y marca el equipo en servicio');
ok(order.events.length === 1 && order.intake_condition.includes('Golpe'), 'conserva recepción y primer evento de trazabilidad');

let current = DB.serviceOrdersRepo.advance(order.id, 'inspeccion', admin);
current = DB.serviceOrdersRepo.advance(order.id, 'diagnostico', admin);
ok(current.workflow_status === 'diagnostico', 'recorre inspección y llega a diagnóstico');

let blocked = false;
try { DB.serviceOrdersRepo.advance(order.id, 'presupuesto', admin); } catch { blocked = true; }
ok(blocked, 'impide presupuestar sin diagnóstico');

current = DB.serviceOrdersRepo.update(order.id, {
  diagnosis:'Display OLED quebrado; placa y batería funcionales',
  service_technician_id:technicianId,
  items:[
    { kind:'parte', product_id:partId, description:'Pantalla OLED', qty:1, unit_price:4500 },
    { kind:'mano_obra', description:'Instalación y pruebas', qty:1, unit_price:1200, taxable:1, tax_pct:18 },
  ],
});
ok(current.items.length === 2 && Number(current.quote_amount) === 5700, 'guarda piezas, mano de obra y total del presupuesto');

current = DB.serviceOrdersRepo.advance(order.id, 'presupuesto', admin);
current = DB.serviceOrdersRepo.advance(order.id, 'esperando_aprobacion', admin);
ok(current.workflow_status === 'esperando_aprobacion' && current.estimates.length === 1, 'congela y versiona el presupuesto enviado');

blocked = false;
try { DB.serviceOrdersRepo.update(order.id, { items:[] }); } catch { blocked = true; }
ok(blocked, 'impide cambiar partidas mientras el presupuesto espera decisión');

current = DB.serviceOrdersRepo.decideEstimate(order.id, {
  approved:true, method:'whatsapp', customer_name:'Consumidor Final', notes:'Mensaje confirmado',
}, admin);
ok(current.workflow_status === 'aprobado' && current.items[0].reservation_status === 'reserved', 'registra evidencia de aprobación y reserva la pieza');
const listedPart = DB.productsRepo.getAll().find(product => product.id === partId);
ok(Number(listedPart.reserved_stock) === 1, 'expone la reserva del taller al resto del inventario');

blocked = false;
try {
  DB.salesRepo.create({ customer:{id:1}, user:admin, type:'factura', session:null,
    items:[{product_id:partId,product_name:'Pantalla',qty:5,unit_price:4500}], payment:{method:'efectivo'} });
} catch { blocked = true; }
ok(blocked, 'el POS no puede vender stock comprometido con una reparación');

current = DB.serviceOrdersRepo.advance(order.id, 'reparando', admin);
current = DB.serviceOrdersRepo.advance(order.id, 'control_calidad', admin);
blocked = false;
try { DB.serviceOrdersRepo.advance(order.id, 'listo', admin); } catch { blocked = true; }
ok(blocked, 'impide dejar listo sin control de calidad');
current = DB.serviceOrdersRepo.saveQuality(order.id, {
  checklist:{ encendido:true, funcion_reparada:true, carga:true, limpieza:true }, notes:'Pruebas aprobadas',
}, admin);
current = DB.serviceOrdersRepo.advance(order.id, 'listo', admin);
ok(current.workflow_status === 'listo' && !!current.quality_checked_at, 'aprueba calidad y deja el equipo listo');

const stockBefore = DB.productsRepo.getById(partId).stock;
const delivered = DB.serviceOrdersRepo.deliver(order.id, { method:'efectivo', warrantyDays:45 }, admin, null);
current = delivered.order;
ok(current.workflow_status === 'entregado' && !!current.sale_id && !!current.delivered_at, 'entrega enlazada a una venta real');
const sale = DB.salesRepo.getById(current.sale_id);
ok(sale.items.length === 2 && sale.items.some(i => i.product_id == null && i.product_code === 'SERVICIO'), 'factura contiene pieza y mano de obra no inventariable');
ok(Number(sale.total) === 5700, 'la factura conserva el total del presupuesto');
ok(DB.productsRepo.getById(partId).stock === stockBefore - 1, 'la pieza descuenta inventario una sola vez');
ok(current.items[0].reservation_status === 'consumed' && DB.productUnitsRepo.findById(unitId).status === 'vendido', 'consume la reserva y devuelve el equipo a estado vendido');
ok(current.service_warranty_days === 45 && !!current.warranty_until, 'emite garantía propia de la reparación');

DB.settingsRepo.set('module_contabilidad', '1');
DB.accountingRepo.generateSaleEntry({ saleId:current.sale_id, userId:admin.id });
const entry = db.prepare("SELECT id FROM accounting_entries WHERE source_module='venta' AND source_id=?").get(current.sale_id);
const balance = entry ? db.prepare('SELECT ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM accounting_entry_lines WHERE entry_id=?').get(entry.id) : null;
ok(balance && Number(balance.debit) === Number(balance.credit), 'la venta de servicio genera asiento contable cuadrado');

const salesCount = db.prepare('SELECT COUNT(*) n FROM sales').get().n;
const repeated = DB.serviceOrdersRepo.deliver(order.id, { method:'efectivo' }, admin, null);
ok(repeated.order.sale_id === current.sale_id && db.prepare('SELECT COUNT(*) n FROM sales').get().n === salesCount, 'reintentar la entrega no duplica la factura');

const warrantyReturn = DB.serviceOrdersRepo.createWarrantyReturn(order.id, 'Pantalla presenta líneas', admin);
ok(warrantyReturn.parent_order_id === order.id && warrantyReturn.service_type === 'garantia', 'crea reingreso enlazado bajo garantía');
const cancelledWarranty = DB.serviceOrdersRepo.cancel(warrantyReturn.id, 'Cliente retiró el equipo', admin);
ok(cancelledWarranty.workflow_status === 'cancelado' && DB.productUnitsRepo.findById(unitId).status === 'vendido', 'cancelar libera correctamente el equipo enlazado');

const stockUnitId = DB.productUnitsRepo.create({
  product_id:deviceProductId, imei:'359999999999998', status:'en_stock', unit_cost:18000,
});
const internalOrder = DB.serviceOrdersRepo.create({
  customer_id:1, product_unit_id:stockUnitId, device_desc:'iPhone 13 de inventario',
  problem:'Prueba interna', intake_condition:'Completo',
}, admin);
DB.serviceOrdersRepo.cancel(internalOrder.id, 'Prueba interna completada', admin);
ok(DB.productUnitsRepo.findById(stockUnitId).status === 'en_stock', 'una cancelación devuelve al inventario un equipo que estaba en stock');

const scarcePartId = DB.productsRepo.create({ code:'REP-ESCASA', name:'Pieza escasa', cost:100, price:200, stock:1, taxable:1, tax_pct:18 });
let scarceOrder = DB.serviceOrdersRepo.create({ customer_id:1, device_desc:'Laptop', problem:'No enciende', intake_condition:'Completa' }, admin);
scarceOrder = DB.serviceOrdersRepo.advance(scarceOrder.id, 'inspeccion', admin);
scarceOrder = DB.serviceOrdersRepo.advance(scarceOrder.id, 'diagnostico', admin);
scarceOrder = DB.serviceOrdersRepo.update(scarceOrder.id, { diagnosis:'Dos componentes dañados', items:[
  { kind:'parte', product_id:scarcePartId, description:'Pieza escasa A', qty:1, unit_price:200 },
  { kind:'parte', product_id:scarcePartId, description:'Pieza escasa B', qty:1, unit_price:200 },
] });
scarceOrder = DB.serviceOrdersRepo.advance(scarceOrder.id, 'presupuesto', admin);
scarceOrder = DB.serviceOrdersRepo.advance(scarceOrder.id, 'esperando_aprobacion', admin);
scarceOrder = DB.serviceOrdersRepo.decideEstimate(scarceOrder.id, { approved:true, method:'llamada', customer_name:'Cliente' }, admin);
ok(scarceOrder.workflow_status === 'esperando_pieza' && scarceOrder.items.every(item => item.reservation_status === 'waiting'), 'agrupa partidas repetidas y espera pieza si el total supera el stock');
DB.serviceOrdersRepo.cancel(scarceOrder.id, 'Prueba completada', admin);

const report = DB.serviceOrdersRepo.report();
ok(report.delivered === 1 && report.warranty_returns === 1 && report.by_technician.length >= 1, 'genera indicadores operativos del taller');

const serviceUi = fs.readFileSync(path.join(__dirname, '../src/js/servicio.js'), 'utf8');
ok(!serviceUi.includes("prompt('Motivo") && serviceUi.includes("askText('Indica el motivo"), 'la cancelación usa el diálogo compatible de VELO');
ok(serviceUi.includes('function svcOpenDelivery(order)') && !serviceUi.includes('function svcOpenDelivery(id, save)'), 'la entrega no depende de campos destruidos del modal anterior');
ok(serviceUi.includes('svcPrintDocument') && serviceUi.includes('svcShareStatus'), 'expone documento operativo y aviso por WhatsApp');

console.log(`\n== RESULTADO: ${passed} OK, ${failed} fallos ==`);
process.exit(failed ? 1 : 0);
