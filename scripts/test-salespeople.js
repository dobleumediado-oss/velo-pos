#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { periodFor } = require('../src/main/salespeople-repo');

let pass=0,fail=0;
function ok(cond,msg){if(cond){pass++;console.log('  ✓',msg);}else{fail++;console.log('  ✗ FALLO:',msg);}}
function near(a,b){return Math.abs(Number(a)-Number(b))<0.005;}
function throws(fn,msg){try{fn();ok(false,msg+' (no lanzó)');}catch{ok(true,msg);}}

const tmpDir=path.join(os.tmpdir(),`velo_sellertest_${Date.now()}`);
const DB=require('../database');
DB.initDB(tmpDir);
const db=DB.getDB();
const userRow=db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const user={id:userRow.id,name:userRow.name};
// Las ventas usan `datetime('now','localtime')` en SQLite. Tomar la fecha del
// mismo reloj evita falsos negativos si la prueba cruza medianoche o si Electron
// y Node resuelven zonas horarias distintas en el runner.
const today=db.prepare("SELECT date('now','localtime') value").get().value;
const productId=DB.productsRepo.create({code:'VEN-P1',name:'Producto vendedor',cost:50,price:118,stock:20,taxable:1,tax_pct:18});
const customerId=DB.customersRepo.create({name:'Cliente vendedor',credit_limit:10000});
const auditArgs=[user.id,user.name];

console.log('\n== A. Registro fijo y ambulante ==');
const fixedId=DB.salespeopleRepo.create({name:'Ana Fija',seller_type:'fijo',linked_user_id:user.id,
  commission_mode:'percent_sales',commission_rate:10,commission_frequency:'mensual',salary_amount:1000,payroll_frequency:'mensual'},...auditArgs);
const streetId=DB.salespeopleRepo.create({name:'Luis Ambulante',seller_type:'ambulante',booklet_code:'T-01',
  zone:'Santo Domingo Norte',route:'Ruta 4',coverage_address:'Av. Hermanas Mirabal',sales_goal:25000,map_lat:18.5123,map_lng:-69.9012,
  commission_mode:'percent_margin',commission_rate:20,commission_frequency:'quincenal',salary_amount:0},...auditArgs);
ok(DB.salespeopleRepo.getAll({status:'activo'}).length===2,'registra vendedores fijos y ambulantes');
ok(DB.salespeopleRepo.getById(streetId).linked_user_id==null,'ambulante existe sin usuario del POS');
ok(DB.salespeopleRepo.getById(streetId).booklet_code==='','el perfil ambulante no administra talonarios externos');
ok(near(DB.salespeopleRepo.getById(streetId).sales_goal,25000),'conserva la meta comercial del vendedor');
ok(near(DB.salespeopleRepo.getById(streetId).map_lat,18.5123)&&near(DB.salespeopleRepo.getById(streetId).map_lng,-69.9012),'conserva coordenadas operativas opcionales');
ok(DB.salespeopleRepo.getById(streetId).coverage_address==='Av. Hermanas Mirabal'&&!!DB.salespeopleRepo.getById(streetId).location_updated_at,'conserva dirección y fecha de actualización de cobertura');
DB.salespeopleRepo.updateLocation(streetId,{lat:18.5201,lng:-69.9001,coverage_address:'Santo Domingo Norte'},...auditArgs);
ok(near(DB.salespeopleRepo.getById(streetId).map_lat,18.5201)&&DB.salespeopleRepo.getById(streetId).coverage_address==='Santo Domingo Norte','actualiza el punto geográfico del ambulante de forma independiente');
ok(periodFor('quincenal','2026-07-20').from==='2026-07-16'&&periodFor('quincenal','2026-07-20').to==='2026-07-31','sugiere automáticamente segunda quincena');
const mechanicId=DB.salespeopleRepo.create({name:'Carlos Mecánico',employee_role:'mecanica',salary_amount:800,payroll_frequency:'semanal',commission_mode:'percent_sales',commission_rate:99},...auditArgs);
const mechanic=DB.salespeopleRepo.getById(mechanicId);
ok(mechanic.employee_role==='mecanica'&&mechanic.commission_mode==='none','registra mecánicos como colaboradores sin activar comisiones');
ok(!DB.salespeopleRepo.getAll({commercialOnly:true}).some(x=>x.id===mechanicId),'excluye personal no comercial de ventas y comisiones');
throws(()=>DB.salespeopleRepo.previewCommission({salespersonId:mechanicId,from:today,to:today}),'impide calcular comisiones a personal no comercial');

console.log('\n== B. Venta interna y comprobante externo con productos ==');
const internal=DB.salesRepo.create({customer:{id:customerId,name:'Cliente vendedor'},items:[{product_id:productId,product_code:'VEN-P1',product_name:'Producto vendedor',unit_cost:50,unit_price:118,taxable:1,tax_pct:18,qty:1}],payment:{method:'efectivo'},user,type:'factura'});
ok(internal.salespersonId===fixedId,'venta del usuario vinculado se asigna automáticamente al vendedor');
const extId=DB.salespeopleRepo.createExternalSale({salesperson_id:streetId,sale_date:today,receipt_number:'0001',customer_name:'Colmado Ruta',
  items:[
    {product_id:productId,qty:2,unit_price:200,unit_cost:100},
    {product_name:'Producto libre del comprobante',qty:1,unit_price:100,unit_cost:100},
  ],discount_amount:50,collected_amount:450,payment_method:'efectivo'},...auditArgs);
ok(DB.salespeopleRepo.getExternalSales({salespersonId:streetId}).some(x=>x.id===extId&&near(x.net_amount,450)&&x.item_count===2),'venta externa suma productos y calcula venta neta 500-50=450');
const extDetail=DB.salespeopleRepo.getExternalSaleById(extId);
ok(extDetail.items.length===2&&near(extDetail.cost_amount,300),'conserva productos, cantidades, precios y costo para calcular margen');
throws(()=>DB.salespeopleRepo.createExternalSale({salesperson_id:streetId,sale_date:today,receipt_number:'0001',gross_amount:100},...auditArgs),'impide duplicar la referencia externa del mismo vendedor');
throws(()=>DB.salespeopleRepo.createExternalSale({salesperson_id:fixedId,sale_date:today,receipt_number:'EXT-FIJA',gross_amount:100},...auditArgs),'reserva las ventas externas para vendedores ambulantes');
const automaticRefId=DB.salespeopleRepo.createExternalSale({salesperson_id:streetId,sale_date:today,items:[{product_name:'Venta sin número físico',qty:1,unit_price:25,unit_cost:10}]},...auditArgs);
ok(/^EXT-\d{6}$/.test(DB.salespeopleRepo.getExternalSaleById(automaticRefId).receipt_number),'genera referencia interna cuando el recibo físico no tiene número');
DB.salespeopleRepo.cancelExternalSale(automaticRefId,'Venta auxiliar de prueba',...auditArgs);

console.log('\n== C. Comisión automática ==');
const fixedPreview=DB.salespeopleRepo.previewCommission({salespersonId:fixedId,from:today,to:today});
ok(near(fixedPreview.salesTotal,118)&&near(fixedPreview.commissionTotal,11.8),'10% sobre venta neta del POS = 11.80');
const streetPreview=DB.salespeopleRepo.previewCommission({salespersonId:streetId,from:today,to:today});
ok(near(streetPreview.marginTotal,150)&&near(streetPreview.commissionTotal,30),'20% sobre margen de la venta externa = 30.00');
const commission=DB.salespeopleRepo.generateCommission({salespersonId:streetId,from:today,to:today},...auditArgs);
const commissionDetail=DB.salespeopleRepo.getCommissionById(commission.id);
ok(commissionDetail.id===commission.id&&commissionDetail.lines.length===1&&commissionDetail.salesperson_id===streetId,'detalle de comisión conserva vendedor, origen y líneas calculadas');
DB.salespeopleRepo.approveCommission(commission.id,...auditArgs);
ok(DB.salespeopleRepo.getCommissionRuns({salespersonId:streetId})[0].status==='aprobado','corte queda aprobado y disponible para nómina');
throws(()=>DB.salespeopleRepo.generateCommission({salespersonId:streetId,from:today,to:today},...auditArgs),'impide duplicar comisiones con períodos cruzados');
throws(()=>DB.salespeopleRepo.cancelExternalSale(extId,'error',...auditArgs),'protege venta incluida en comisión aprobada');

console.log('\n== D. Viáticos conectados a Gastos ==');
const travel=DB.salespeopleRepo.createSellerExpense({salespersonId:streetId,kind:'combustible',issue_date:today,amount:250,description:'Ruta Norte',payment_method:'efectivo',payment_source:'caja_chica',pay_now:true},...auditArgs);
const expense=DB.expensesRepo.getById(travel.expenseId);
ok(expense&&expense.status==='pagado'&&near(expense.total,250),'viático crea y paga un gasto real del negocio');
ok(DB.salespeopleRepo.getSellerExpenses({salespersonId:streetId}).some(x=>x.expense_id===travel.expenseId),'gasto conserva vínculo con el vendedor');

console.log('\n== E. Nómina integrada ==');
const fixedCommission=DB.salespeopleRepo.generateCommission({salespersonId:fixedId,from:today,to:today},...auditArgs);
DB.salespeopleRepo.approveCommission(fixedCommission.id,...auditArgs);
const payrollId=DB.salespeopleRepo.generatePayroll({from:today,to:today,frequency:'mensual',notes:'Prueba mensual'},...auditArgs);
let payroll=DB.salespeopleRepo.getPayrollById(payrollId);
ok(payroll.items.length===1&&payroll.items[0].salesperson_id===fixedId,'nómina mensual incluye solo vendedores de frecuencia mensual');
ok(near(payroll.base_total,1000)&&near(payroll.commission_total,11.8)&&near(payroll.net_total,1011.8),'nómina suma salario + comisión mensual aprobada');
const fixedItem=payroll.items.find(i=>i.salesperson_id===fixedId);
DB.salespeopleRepo.updatePayrollItem(fixedItem.id,{bonusAmount:100,deductionAmount:25,notes:'Incentivo'});
payroll=DB.salespeopleRepo.getPayrollById(payrollId);
ok(near(payroll.net_total,1086.8),'bonos y deducciones recalculan el neto automáticamente');
DB.salespeopleRepo.approvePayroll(payrollId,...auditArgs);
const refs=DB.salespeopleRepo.payPayroll(payrollId,{payment_date:today,payment_method:'efectivo',payment_source:'caja_chica',reference:'TEST'},...auditArgs);
payroll=DB.salespeopleRepo.getPayrollById(payrollId);
ok(payroll.status==='pagado'&&refs.length===1,'pago de nómina genera un gasto pagado por vendedor');
const streetPayrollId=DB.salespeopleRepo.generatePayroll({from:today,to:today,frequency:'quincenal',notes:'Prueba quincenal'},...auditArgs);
const streetPayroll=DB.salespeopleRepo.getPayrollById(streetPayrollId);
ok(streetPayroll.items.length===1&&near(streetPayroll.commission_total,30)&&near(streetPayroll.base_total,0),'nómina quincenal liquida al ambulante sin salario fijo');
throws(()=>DB.salespeopleRepo.generatePayroll({from:today,to:today,frequency:'quincenal'},...auditArgs),'impide duplicar una nómina del mismo período y frecuencia');
DB.salespeopleRepo.approvePayroll(streetPayrollId,...auditArgs);
DB.salespeopleRepo.payPayroll(streetPayrollId,{payment_date:today,payment_method:'efectivo',payment_source:'caja_chica',reference:'TEST-Q'},...auditArgs);
ok(DB.salespeopleRepo.getCommissionRuns({salespersonId:streetId})[0].status==='pagado','comisión pasa a pagada junto con la nómina correcta');

const weekly=periodFor('semanal',today);
const quick=DB.salespeopleRepo.quickPayPayroll({salesperson_id:mechanicId,frequency:'semanal',from:weekly.from,to:weekly.to,bonus_amount:75,deduction_amount:25,payment_date:today,payment_method:'transferencia',payment_source:'banco',reference:'NOM-FAST-01',receipt_notes:'Excelente trabajo en el taller'},...auditArgs);
const quickPayroll=DB.salespeopleRepo.getPayrollById(quick.id);
ok(quickPayroll.status==='pagado'&&quickPayroll.items.length===1&&quickPayroll.items[0].employee_role==='mecanica','pago rápido liquida un solo colaborador y conserva su área');
ok(near(quickPayroll.net_total,850)&&quickPayroll.payment_method==='transferencia'&&quickPayroll.payment_reference==='NOM-FAST-01','pago rápido guarda ajustes, método y referencia del recibo');
ok(quickPayroll.receipt_notes==='Excelente trabajo en el taller'&&quick.refs.length===1,'recibo conserva la nota visible y el pago contable');

console.log('\n== F. Corregir, reabrir y anular pagos de nómina ==');
const expenseStatus=id=>DB.expensesRepo.getById(id)?.status;
const quickBefore=DB.salespeopleRepo.getPayrollById(quick.id);
const oldQuickExpense=quickBefore.items[0].expense_id;
throws(()=>DB.salespeopleRepo.modifyPayroll(quick.id,{items:[],reason:'Sin cambios'},...auditArgs),'rechaza una corrección que no cambia nada');
throws(()=>DB.salespeopleRepo.modifyPayroll(quick.id,{items:[{id:quickBefore.items[0].id,bonus_amount:500}]},...auditArgs),'exige el motivo de la corrección');
throws(()=>DB.salespeopleRepo.modifyPayroll(quick.id,{items:[{id:quickBefore.items[0].id,deduction_amount:99999}],reason:'Deducción imposible'},...auditArgs),'impide que la deducción supere lo que recibe');
DB.salespeopleRepo.modifyPayroll(quick.id,{reference:'NOM-FAST-02',reason:'Referencia equivocada'},...auditArgs);
let quickAfter=DB.salespeopleRepo.getPayrollById(quick.id);
ok(quickAfter.payment_reference==='NOM-FAST-02'&&quickAfter.items[0].expense_id===oldQuickExpense&&expenseStatus(oldQuickExpense)==='pagado','corregir solo la referencia no anula ni vuelve a pagar');
const reissue=DB.salespeopleRepo.modifyPayroll(quick.id,{items:[{id:quickBefore.items[0].id,bonus_amount:275}],reason:'El bono era mayor'},...auditArgs);
quickAfter=DB.salespeopleRepo.getPayrollById(quick.id);
ok(near(quickAfter.net_total,1050)&&quickAfter.status==='pagado'&&quickAfter.revision===1,'corregir el bono recalcula el neto 800+275-25=1050');
ok(reissue.cancelledExpenseIds[0]===oldQuickExpense&&expenseStatus(oldQuickExpense)==='anulado','el gasto del pago anterior queda anulado');
const newQuickExpense=DB.expensesRepo.getById(quickAfter.items[0].expense_id);
ok(newQuickExpense&&newQuickExpense.status==='pagado'&&near(newQuickExpense.total,1050)&&/corrección 1/i.test(newQuickExpense.description),'el pago corregido crea un gasto nuevo pagado por el monto correcto');
ok(quickAfter.changes.length===2&&quickAfter.changes.every(c=>c.action==='corregida'),'cada corrección queda en el historial inmutable');
ok(near(JSON.parse(quickAfter.changes[0].before_json).net_total,850)&&near(JSON.parse(quickAfter.changes[0].after_json).net_total,1050),'el historial guarda el antes y el después');
throws(()=>DB.salespeopleRepo.modifyPayroll(quick.id,{payment_source:'caja',reason:'Pagado desde caja'},...auditArgs),'no registra un pago en caja sin una caja abierta');

const helperId=DB.salespeopleRepo.create({name:'Rosa Caja',employee_role:'administracion',salary_amount:500,payroll_frequency:'mensual'},...auditArgs);
const groupId=DB.salespeopleRepo.generatePayroll({from:'2030-01-01',to:'2030-01-31',frequency:'mensual'},...auditArgs);
DB.salespeopleRepo.approvePayroll(groupId,...auditArgs);
DB.salespeopleRepo.payPayroll(groupId,{payment_date:today,payment_method:'efectivo',payment_source:'caja_chica'},...auditArgs);
let group=DB.salespeopleRepo.getPayrollById(groupId);
const rosaItem=group.items.find(i=>i.salesperson_id===helperId),anaItem=group.items.find(i=>i.salesperson_id===fixedId);
ok(group.items.length===2&&rosaItem&&anaItem,'nómina de grupo con dos colaboradores pagada');
const groupFix=DB.salespeopleRepo.modifyPayroll(groupId,{items:[{id:rosaItem.id,bonus_amount:100}],reason:'Bono de Rosa'},...auditArgs);
group=DB.salespeopleRepo.getPayrollById(groupId);
ok(groupFix.cancelledExpenseIds.length===1&&groupFix.cancelledExpenseIds[0]===rosaItem.expense_id&&groupFix.refs.length===1,'corregir a un colaborador solo re-emite su pago');
ok(group.items.find(i=>i.id===anaItem.id).expense_id===anaItem.expense_id&&expenseStatus(anaItem.expense_id)==='pagado','el pago de los demás queda intacto');
ok(near(group.net_total,1600),'el total de la nómina refleja la corrección 1000+600=1600');
const methodFix=DB.salespeopleRepo.modifyPayroll(groupId,{payment_method:'transferencia',payment_source:'banco',reason:'Fue por transferencia'},...auditArgs);
ok(methodFix.cancelledExpenseIds.length===2&&methodFix.refs.length===2,'cambiar el método re-emite el pago de todos');
DB.salespeopleRepo.cancelPayroll(groupId,'Período de prueba',...auditArgs);
DB.salespeopleRepo.remove(helperId,...auditArgs);

const paidCommission=DB.salespeopleRepo.getCommissionRuns({salespersonId:streetId})[0];
const cancelResult=DB.salespeopleRepo.cancelPayroll(streetPayrollId,'Se pagó con el período equivocado',...auditArgs);
const cancelledStreet=DB.salespeopleRepo.getPayrollById(streetPayrollId);
ok(cancelledStreet.status==='anulado'&&cancelledStreet.cancel_reason==='Se pagó con el período equivocado','anular guarda estado y motivo');
ok(cancelResult.wasPaid&&cancelResult.cancelledExpenseIds.every(id=>expenseStatus(id)==='anulado'),'anular una nómina pagada anula sus gastos');
const releasedCommission=DB.salespeopleRepo.getCommissionById(paidCommission.id);
ok(releasedCommission.status==='aprobado'&&releasedCommission.payroll_run_id==null,'la comisión vuelve a quedar aprobada para otra nómina');
throws(()=>DB.salespeopleRepo.cancelPayroll(streetPayrollId,'Otra vez',...auditArgs),'no anula dos veces la misma nómina');
const regenerated=DB.salespeopleRepo.generatePayroll({from:today,to:today,frequency:'quincenal'},...auditArgs);
ok(near(DB.salespeopleRepo.getPayrollById(regenerated).commission_total,30),'el período anulado se puede generar de nuevo con la misma comisión');
DB.salespeopleRepo.approvePayroll(regenerated,...auditArgs);
ok(DB.salespeopleRepo.getCommissionById(paidCommission.id).payroll_run_id===regenerated,'al aprobar, la comisión se enlaza a la nómina nueva');
DB.salespeopleRepo.reopenPayroll(regenerated,'Falta un bono',...auditArgs);
ok(DB.salespeopleRepo.getPayrollById(regenerated).status==='borrador'&&DB.salespeopleRepo.getCommissionById(paidCommission.id).payroll_run_id==null,'devolver a borrador suelta la comisión hasta volver a aprobar');
throws(()=>DB.salespeopleRepo.reopenPayroll(quick.id,'',...auditArgs),'una nómina pagada no vuelve a borrador');

console.log('\n== G. Eliminar colaboradores ==');
const newbieId=DB.salespeopleRepo.create({name:'Temporal Sin Historial',employee_role:'administracion',salary_amount:0},...auditArgs);
ok(DB.salespeopleRepo.remove(newbieId,...auditArgs).mode==='deleted'&&!db.prepare('SELECT id FROM salespeople WHERE id=?').get(newbieId),'sin movimientos se borra por completo');
throws(()=>DB.salespeopleRepo.remove(streetId,...auditArgs),'no elimina a quien está en una nómina sin pagar');
DB.salespeopleRepo.cancelPayroll(regenerated,'Prueba de eliminación',...auditArgs);
throws(()=>DB.salespeopleRepo.remove(streetId,...auditArgs),'no elimina a quien tiene comisiones aprobadas sin pagar');
const removal=DB.salespeopleRepo.remove(mechanicId,...auditArgs);
const archived=db.prepare('SELECT * FROM salespeople WHERE id=?').get(mechanicId);
ok(removal.mode==='archived'&&archived.deleted_at&&archived.status==='inactivo','con historial se archiva en vez de borrarse');
ok(!DB.salespeopleRepo.getAll({}).some(x=>x.id===mechanicId)&&DB.salespeopleRepo.getAll({includeDeleted:true}).some(x=>x.id===mechanicId),'el archivado sale de las listas pero sigue existiendo');
ok(DB.salespeopleRepo.getPayrollById(quick.id).items[0].salesperson_name==='Carlos Mecánico','sus nóminas anteriores conservan el nombre');
throws(()=>DB.salespeopleRepo.remove(mechanicId,...auditArgs),'no elimina dos veces');
DB.salespeopleRepo.remove(fixedId,...auditArgs);
ok(db.prepare('SELECT linked_user_id FROM salespeople WHERE id=?').get(fixedId).linked_user_id==null,'archivar libera el usuario del POS vinculado');
const saleAfterRemoval=DB.salesRepo.create({customer:{id:customerId,name:'Cliente vendedor'},items:[{product_id:productId,product_code:'VEN-P1',product_name:'Producto vendedor',unit_cost:50,unit_price:118,taxable:1,tax_pct:18,qty:1}],payment:{method:'efectivo'},user,type:'factura'});
ok(!saleAfterRemoval.salespersonId,'las ventas nuevas ya no se asignan al colaborador eliminado');

try{DB.getDB().close();}catch{}
try{fs.rmSync(tmpDir,{recursive:true,force:true});}catch{}
console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==`);
if(fail)process.exit(1);
