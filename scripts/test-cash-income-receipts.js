#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const ok = (condition, message) => {
  if (!condition) { console.error('  ✗', message); process.exitCode = 1; return; }
  passed += 1; console.log('  ✓', message);
};

const tempDir = path.join(os.tmpdir(), `velo_cash_income_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

try {
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const actor = { id:admin.id, name:admin.name };
  db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const sessionId = DB.cashRepo.open({ userId:admin.id, cajero:admin.name, openAmount:1000, openBills:{}, terminalId:'INCOME-QA' });

  console.log('\n== Recibo de ingreso en efectivo ==');
  const cashReceipt = DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'Socio principal',
    payer_document:'001-0000000-1', concept:'Aporte para operaciones', income_type:'aporte_capital',
    amount:750, method:'efectivo', reference:'CAP-01', notes:'Entregado en caja' }, actor);
  ok(/^RIN-\d{6}$/.test(cashReceipt.document_number_fmt),'emite correlativo independiente RIN');
  ok(cashReceipt.payer_name==='Socio principal'&&cashReceipt.amount===750,'conserva pagador, concepto y monto');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected===1750,'el efectivo aumenta exactamente el cuadre');
  ok(DB.cashRepo.getIncomeReceipts(sessionId).length===1,'aparece en la lista operativa de Caja');
  ok(!!cashReceipt.accounting_entry_id&&db.prepare('SELECT code FROM accounting_entry_lines l JOIN accounting_accounts a ON a.id=l.account_id WHERE l.entry_id=? AND l.credit>0').get(cashReceipt.accounting_entry_id)?.code==='3102','el aporte se clasifica correctamente en Contabilidad');

  DB.cashRepo.cancelIncomeReceipt(cashReceipt.id,'Registro duplicado',actor,sessionId);
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected===1000,'anular revierte exactamente el efectivo');
  ok(DB.cashRepo.getIncomeReceipts(sessionId).length===0,'lo anulado desaparece de la vista operativa');
  ok(DB.cashRepo.getIncomeReceipts(sessionId,{includeCancelled:true})[0].status==='cancelled','la auditoría conserva el documento anulado');

  console.log('\n== Recibo de ingreso bancario ==');
  const accountId = DB.financialAccountsRepo.create({ name:'Banco de prueba', type:'banco', account_number:'001', currency:'DOP', userId:admin.id });
  const bankReceipt = DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'Cliente ocasional',
    concept:'Reembolso de transporte', income_type:'reembolso', amount:500, method:'transferencia',
    financial_account_id:accountId, reference:'TRX-500' }, actor);
  ok(DB.financialAccountsRepo.getById(accountId).current_balance===500,'la transferencia aumenta la cuenta seleccionada');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected===1000,'el ingreso bancario no infla el efectivo físico');
  DB.cashRepo.cancelIncomeReceipt(bankReceipt.id,'Transferencia rechazada',actor,sessionId);
  ok(DB.financialAccountsRepo.getById(accountId).current_balance===0,'anular revierte la cuenta financiera');

  console.log('\n== Ingreso recibido en dólares ==');
  const usdExpectedBefore = DB.cashRepo.getSessionCashSummary(sessionId).expected;
  const usdReceipt = DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'Cliente extranjero',
    concept:'Adelanto en divisas', income_type:'otro_ingreso', amount:100, payment_currency:'USD',
    exchange_rate:63.5, method:'efectivo' }, actor);
  ok(usdReceipt.payment_currency==='USD'&&usdReceipt.currency_amount===100&&usdReceipt.exchange_rate===63.5,
    'conserva lo que el cliente entregó y la tasa aplicada');
  ok(usdReceipt.amount===6350,'convierte a pesos con la tasa indicada');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected===usdExpectedBefore+6350,
    'la caja recibe el equivalente en pesos, no el monto en dólares');

  let usdErrors = [];
  const expectUsdError = (fn) => { try { fn(); usdErrors.push(''); } catch (e) { usdErrors.push(e.message); } };
  expectUsdError(() => DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'X',
    concept:'Sin tasa', amount:50, payment_currency:'USD', method:'efectivo' }, actor));
  expectUsdError(() => DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'X',
    concept:'Tasa absurda', amount:50, payment_currency:'USD', exchange_rate:2, method:'efectivo' }, actor));
  ok(/tasa/i.test(usdErrors[0])&&/tasa/i.test(usdErrors[1]),'exige una tasa de cambio dentro de un rango razonable');

  const reRated = DB.cashRepo.updateIncomeReceipt(usdReceipt.id,
    { exchange_rate:62, reason:'La tasa acordada fue 62' }, actor, sessionId);
  ok(reRated.exchange_rate===62&&reRated.currency_amount===100&&reRated.amount===6200,
    'corregir la tasa recalcula el equivalente conservando los dólares recibidos');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected===usdExpectedBefore+6200,
    'la caja se ajusta solo por la diferencia que produjo la nueva tasa');
  DB.cashRepo.cancelIncomeReceipt(usdReceipt.id,'Fin de la prueba en divisas',actor,sessionId);
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected===usdExpectedBefore,
    'anular un recibo en dólares devuelve exactamente su equivalente en pesos');

  console.log('\n== Modificación del recibo conservando su número ==');
  const editable = DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'Pagador inicial',
    concept:'Concepto inicial', income_type:'otro_ingreso', amount:1000, method:'efectivo',
    reference:'REF-1' }, actor);
  const expectedAfterCreate = DB.cashRepo.getSessionCashSummary(sessionId).expected;
  const textOnly = DB.cashRepo.updateIncomeReceipt(editable.id,
    { payer_name:'Pagador corregido', concept:'Concepto corregido', reference:'REF-2', reason:'Nombre mal escrito' },
    actor, sessionId);
  ok(textOnly.document_number_fmt === editable.document_number_fmt &&
    textOnly.payer_name === 'Pagador corregido' && textOnly.concept === 'Concepto corregido',
    'corregir datos conserva el mismo número de recibo');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === expectedAfterCreate,
    'una corrección de texto no toca el efectivo de la caja');

  DB.cashRepo.updateIncomeReceipt(editable.id, { amount:1500, reason:'Se recibieron RD$500 adicionales' }, actor, sessionId);
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === expectedAfterCreate + 500,
    'subir el monto solo mueve la diferencia hacia la caja');
  DB.cashRepo.updateIncomeReceipt(editable.id, { amount:700, reason:'Se devolvio parte del dinero' }, actor, sessionId);
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === expectedAfterCreate - 300,
    'bajar el monto retira exactamente la diferencia');

  const balanceBeforeSwitch = DB.financialAccountsRepo.getById(accountId).current_balance;
  DB.cashRepo.updateIncomeReceipt(editable.id,
    { method:'transferencia', financial_account_id:accountId, reason:'El pago entro por transferencia' }, actor, sessionId);
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === expectedAfterCreate - 1000 &&
    DB.financialAccountsRepo.getById(accountId).current_balance === balanceBeforeSwitch + 700,
    'cambiar de efectivo a transferencia saca el dinero de caja y lo deposita en la cuenta');

  const correctedEntry = db.prepare(`SELECT l.credit,a.code FROM accounting_entry_lines l
    JOIN accounting_accounts a ON a.id=l.account_id
    WHERE l.entry_id=? AND l.credit>0`).get(DB.cashRepo.getIncomeReceipt(editable.id).accounting_entry_id);
  DB.cashRepo.updateIncomeReceipt(editable.id, { income_type:'prestamo', reason:'Era un prestamo, no otro ingreso' }, actor, sessionId);
  const afterType = DB.cashRepo.getIncomeReceipt(editable.id);
  const reclassified = db.prepare(`SELECT l.credit,a.code FROM accounting_entry_lines l
    JOIN accounting_accounts a ON a.id=l.account_id
    WHERE l.entry_id=? AND l.credit>0`).get(afterType.accounting_entry_id);
  ok(correctedEntry?.code === '4104' && reclassified?.code === '2201' && reclassified.credit === 700,
    'reclasificar el tipo regenera el asiento con la cuenta correcta');
  ok(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='recibo_ingreso_corregido' AND entity_id=?")
    .get(editable.id).c === 5, 'cada corrección queda en auditoría con su motivo');

  let editErrors = [];
  const expectError = (fn) => { try { fn(); editErrors.push(''); } catch (e) { editErrors.push(e.message); } };
  expectError(() => DB.cashRepo.updateIncomeReceipt(editable.id, { amount:900 }, actor, sessionId));
  expectError(() => DB.cashRepo.updateIncomeReceipt(editable.id, { amount:0, reason:'Monto invalido' }, actor, sessionId));
  expectError(() => DB.cashRepo.updateIncomeReceipt(editable.id, { reason:'Sin cambios reales' }, actor, sessionId));
  ok(/motivo/i.test(editErrors[0]) && /mayor a cero/i.test(editErrors[1]) && /cambios/i.test(editErrors[2]),
    'exige motivo, monto válido y un cambio real');
  DB.cashRepo.cancelIncomeReceipt(editable.id,'Fin de la prueba',actor,sessionId);
  expectError(() => DB.cashRepo.updateIncomeReceipt(editable.id, { amount:100, reason:'Ya esta anulado' }, actor, sessionId));
  ok(/anulado/i.test(editErrors[3]), 'un recibo anulado ya no se puede modificar');

  console.log('\n== Caja lee su propia sesión ==');
  const sessionPayments = DB.cashRepo.getSessionPayments(sessionId);
  ok(Array.isArray(sessionPayments) &&
    sessionPayments.every(row => Number(row.cash_session_id) === Number(sessionId)),
    'los abonos de la caja se consultan por su sesión, no filtrando el historial completo');
  ok(sessionPayments.every(row => Array.isArray(row.allocations)),
    'cada abono de la sesión llega con sus aplicaciones resueltas');
  const otherSession = DB.cashRepo.getSessionPayments(999999);
  ok(Array.isArray(otherSession) && otherSession.length === 0,
    'una sesión sin abonos devuelve una lista vacía, no el historial del negocio');
  const sessionSales = DB.cashRepo.getSessionSales(sessionId);
  ok(Array.isArray(sessionSales) &&
    sessionSales.every(row => Number(row.cash_session_id) === Number(sessionId)),
    'las ventas de la caja también salen de su propia consulta');

  const cajaUi = fs.readFileSync(path.join(__dirname,'../src/js/caja.js'),'utf8');
  ok(cajaUi.includes('function cajaFetchSessionPayments') &&
    cajaUi.includes('function cajaFetchSessionSales') &&
    !/const tdAbonos = DB\.payments/.test(cajaUi),
    'Caja dejó de depender de las colecciones compartidas para cuadrar');
  const dashUi = fs.readFileSync(path.join(__dirname,'../src/js/dashboard.js'),'utf8');
  ok(!/DB\.sales[.[]/.test(dashUi) && dashUi.includes('const dashSales'),
    'el panel calcula sus indicadores con las ventas del día que él mismo pide');

  console.log('\n== Ciclo completo de caja con las fuentes nuevas ==');
  // Este es el recorrido que antes solo se podía comprobar a mano: abrir caja,
  // vender, cobrar un abono, cerrar y volver a consultar la sesión ya cerrada.
  const cicloProduct = db.prepare(
    "INSERT INTO products(code,name,price,cost,stock,active,taxable,tax_pct) VALUES('CIC-1','Producto ciclo',118,60,50,1,1,18)"
  ).run().lastInsertRowid;
  const cicloCustomer = db.prepare(
    "INSERT INTO customers(name,rnc,active,credit_limit) VALUES('CLIENTE CICLO','131',1,50000)"
  ).run().lastInsertRowid;
  const cicloSession = DB.cashRepo.open({
    userId:admin.id, cajero:admin.name, openAmount:2000, openBills:{}, terminalId:'CICLO-QA',
  });
  const cicloSale = DB.salesRepo.create({
    customer:{ id:cicloCustomer },
    items:[{ product_id:cicloProduct, product_code:'CIC-1', product_name:'Producto ciclo',
      unit_cost:60, unit_price:118, taxable:1, tax_pct:18, qty:2 }],
    payment:{ method:'efectivo', saleDate:'2026-09-18', ncfType:'' },
    session:{ id:cicloSession }, user:admin, type:'factura',
  });
  const cicloCredit = DB.salesRepo.create({
    customer:{ id:cicloCustomer },
    items:[{ product_id:cicloProduct, product_code:'CIC-1', product_name:'Producto ciclo',
      unit_cost:60, unit_price:118, taxable:1, tax_pct:18, qty:1 }],
    payment:{ method:'credito', saleDate:'2026-09-18', ncfType:'' },
    session:{ id:cicloSession }, user:admin, type:'factura',
  });
  DB.customersRepo.addPayment({
    customerId:cicloCustomer, saleId:cicloCredit.saleId, amount:50, method:'efectivo',
    note:'Abono del ciclo', userId:admin.id, cajero:admin.name, sessionId:cicloSession,
  });

  const cicloSalesAbierta = DB.cashRepo.getSessionSales(cicloSession);
  ok(cicloSalesAbierta.length === 2 &&
    cicloSalesAbierta.every(row => Number(row.cash_session_id) === Number(cicloSession)),
    'con la caja abierta, sus ventas salen de su propia consulta');
  const cicloPagosAbierta = DB.cashRepo.getSessionPayments(cicloSession);
  ok(cicloPagosAbierta.length === 1 && Number(cicloPagosAbierta[0].amount) === 50,
    'el abono cobrado en esta caja aparece en su propia consulta');

  const cicloResumen = DB.cashRepo.getSessionCashSummary(cicloSession);
  ok(Math.round(cicloResumen.expected * 100) / 100 === 2000 + 236 + 50,
    'el cuadre suma fondo, venta de contado y abono en efectivo');

  DB.cashRepo.close({
    sessionId:cicloSession, closeAmount:cicloResumen.expected, closeBills:{},
    notes:'Cierre del ciclo', userId:admin.id, cajero:admin.name,
  });
  ok(db.prepare('SELECT status FROM cash_sessions WHERE id=?').get(cicloSession).status === 'closed',
    'la caja cierra sin diferencia con el cuadre canónico');

  // El fallo que se corrigió: una caja cerrada no encontraba sus ventas porque
  // se filtraba la colección en memoria del historial de Ventas.
  const cicloSalesCerrada = DB.cashRepo.getSessionSales(cicloSession);
  ok(cicloSalesCerrada.length === 2,
    'una caja YA CERRADA sigue devolviendo sus ventas para el resumen');
  ok(DB.cashRepo.getSessionPayments(cicloSession).length === 1,
    'una caja ya cerrada sigue devolviendo sus abonos');
  const cicloReporte = DB.cashRepo.getSessionReport(cicloSession);
  ok(cicloReporte && (cicloReporte.sales || []).length === 2 &&
    (cicloReporte.payments || []).length === 1,
    'el reporte imprimible de la sesión cerrada reúne ventas y abonos');

  console.log('\n== Historial consultable y reimprimible ==');
  const keptReceipt = DB.cashRepo.createIncomeReceipt({ cash_session_id:sessionId, payer_name:'Arrendatario del local',
    concept:'Alquiler de vitrina', income_type:'otro_ingreso', amount:2500, method:'efectivo',
    reference:'ALQ-09' }, actor);
  DB.cashRepo.close({ sessionId, closeAmount:DB.cashRepo.getSessionCashSummary(sessionId).expected,
    closeBills:{}, notes:'', userId:admin.id });
  ok(db.prepare('SELECT status FROM cash_sessions WHERE id=?').get(sessionId).status==='closed',
    'la caja queda cerrada para probar el historial');

  const history = DB.cashRepo.searchIncomeReceipts({});
  ok(history.rows.some(row => Number(row.id) === Number(keptReceipt.id)),
    'un recibo sigue consultable después de cerrar la caja que lo emitió');
  ok(history.rows.every(row => row.document_number_fmt && row.payer_name && row.concept),
    'el historial devuelve los datos completos para reimprimir el documento');
  ok(history.rows.some(row => row.status === 'cancelled') && history.totals.active === 2500,
    'separa el monto vigente de los recibos anulados');

  const activeOnly = DB.cashRepo.searchIncomeReceipts({ includeCancelled:false });
  ok(activeOnly.rows.length === 1 && Number(activeOnly.rows[0].id) === Number(keptReceipt.id),
    'permite ocultar los anulados sin perderlos de la base');
  ok(DB.cashRepo.searchIncomeReceipts({ query:'ALQ-09' }).rows.length === 1 &&
    DB.cashRepo.searchIncomeReceipts({ query:'Arrendatario' }).rows.length === 1 &&
    DB.cashRepo.searchIncomeReceipts({ query:'Vitrina' }).rows.length === 1,
    'busca por referencia, persona y concepto');
  ok(DB.cashRepo.searchIncomeReceipts({ from:'1990-01-01', to:'1990-12-31' }).rows.length === 0,
    'el rango de fechas acota el historial');
  ok(DB.cashRepo.searchIncomeReceipts({ limit:1 }).truncated === true,
    'avisa cuando el período devuelve más recibos de los mostrados');

  console.log('\n== Recorrido completo de un recibo en dólares ==');
  // Crear en divisas, corregir la tasa, encontrarlo en el historial y tener
  // todo lo que la reimpresión necesita: el recorrido que se probaba a mano.
  const viajeSession = DB.cashRepo.open({
    userId:admin.id, cajero:admin.name, openAmount:1000, openBills:{}, terminalId:'VIAJE-QA',
  });
  const viaje = DB.cashRepo.createIncomeReceipt({
    cash_session_id:viajeSession, payer_name:'VISITANTE EXTRANJERO',
    payer_document:'P-99887', concept:'Adelanto en divisas', income_type:'otro_ingreso',
    amount:200, payment_currency:'USD', exchange_rate:63.5, method:'efectivo',
    reference:'USD-01', notes:'Recibido en billetes',
  }, actor);
  ok(viaje.amount === 12700 && viaje.currency_amount === 200 && viaje.exchange_rate === 63.5,
    'el recibo en dólares guarda divisa, tasa y equivalente en pesos');

  const viajeCorregido = DB.cashRepo.updateIncomeReceipt(viaje.id,
    { exchange_rate:62, reason:'La tasa acordada fue 62' }, actor, viajeSession);
  ok(viajeCorregido.document_number_fmt === viaje.document_number_fmt &&
    viajeCorregido.amount === 12400 && viajeCorregido.currency_amount === 200,
    'corregir la tasa conserva el número y recalcula solo el equivalente');
  ok(Math.round(DB.cashRepo.getSessionCashSummary(viajeSession).expected * 100) / 100 === 1000 + 12400,
    'la caja refleja el equivalente corregido, no el original');

  const viajeHistorial = DB.cashRepo.searchIncomeReceipts({ query:'USD-01' });
  const viajeFila = viajeHistorial.rows.find(row => Number(row.id) === Number(viaje.id));
  ok(!!viajeFila && viajeFila.payment_currency === 'USD' &&
    Number(viajeFila.exchange_rate) === 62 && Number(viajeFila.currency_amount) === 200,
    'el historial encuentra el recibo y trae divisa, tasa y monto para reimprimirlo');
  ok(!!viajeFila.payer_name && !!viajeFila.concept && !!viajeFila.document_number_fmt &&
    viajeFila.user_name !== undefined,
    'la fila del historial trae todo lo que el documento impreso necesita');
  DB.cashRepo.close({
    sessionId:viajeSession, closeAmount:DB.cashRepo.getSessionCashSummary(viajeSession).expected,
    closeBills:{}, notes:'', userId:admin.id, cajero:admin.name,
  });
  const viajeTrasCierre = DB.cashRepo.searchIncomeReceipts({ query:'USD-01' });
  ok(viajeTrasCierre.rows.some(row => Number(row.id) === Number(viaje.id)),
    'cerrada la caja, el recibo sigue consultable y reimprimible desde el historial');

  const ui = fs.readFileSync(path.join(__dirname,'../src/js/caja.js'),'utf8');
  ok(ui.includes('Historial de recibos de ingreso')&&ui.includes('function cajaSearchIncomeHistory')&&
    ui.includes('function cajaReprintIncomeReceipt'),'Caja muestra el historial con reimpresión');
  ok(ui.includes('async function openEditIncomeReceiptModal')&&ui.includes('Motivo de la modificación')&&
    ui.includes('function cajaEditIncomeFromHistory'),'Caja permite modificar el recibo desde la sesión y el historial');
  ok(ui.includes('Nuevo recibo de ingreso')&&ui.includes("printHTML(buildIncomeReceiptHTML(receipt, override), 'recibo_ingreso')"),'Caja incluye captura e impresión del recibo');
  ok(ui.includes('function _cajaIncomeReceiptSettings')&&ui.includes("_getCategoryConfig('ingreso')")&&
    ui.includes("settings.template === 'ingreso_termica_80'"),'el recibo respeta la plantilla configurada en el Centro de impresión');
  ok(ui.includes('Registrar e imprimir')&&ui.includes('Documento interno · No sustituye comprobante fiscal'),'el flujo termina en un comprobante interno identificado');

  console.log('\n== Recibo enlazado a un cliente registrado ==');
  // El campo "Recibido de" era texto libre: un cliente registrado quedaba
  // escrito a mano y el recibo no se podía relacionar con él.
  // Las pruebas anteriores cerraron la caja; este bloque abre la suya.
  const sesionRecibos = DB.cashRepo.open({
    userId: admin.id, cajero: admin.name, openAmount: 0, openBills: {}, terminalId: 'RECIBO-QA',
  });
  const clienteId = db.prepare(
    "INSERT INTO customers(name,rnc,active) VALUES('CLIENTE DEL RECIBO','130123456',1)"
  ).run().lastInsertRowid;
  const enlazado = DB.cashRepo.createIncomeReceipt({
    cash_session_id: sesionRecibos, payer_name: 'CLIENTE DEL RECIBO', payer_document: '130123456',
    customer_id: clienteId, concept: 'Alquiler de equipo', income_type: 'otro_ingreso',
    amount: 300, method: 'efectivo',
  }, { id: admin.id, name: admin.name });
  ok(Number(enlazado.customer_id) === Number(clienteId), 'el recibo queda enlazado al cliente elegido');
  ok(enlazado.payer_name === 'CLIENTE DEL RECIBO',
    'conserva igual el nombre y el documento como copia del momento');
  const suelto = DB.cashRepo.createIncomeReceipt({
    cash_session_id: sesionRecibos, payer_name: 'VECINO DE LA ESQUINA', concept: 'Venta de chatarra',
    income_type: 'otro_ingreso', amount: 120, method: 'efectivo',
  }, { id: admin.id, name: admin.name });
  ok(suelto.customer_id == null, 'un pagador no registrado se guarda sin enlace, como siempre');
  const inventado = DB.cashRepo.createIncomeReceipt({
    cash_session_id: sesionRecibos, payer_name: 'FANTASMA', customer_id: 999999,
    concept: 'Cliente inexistente', income_type: 'otro_ingreso', amount: 50, method: 'efectivo',
  }, { id: admin.id, name: admin.name });
  ok(inventado.customer_id == null, 'un cliente que no existe no se guarda como enlace');

  const caja = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'caja.js'), 'utf8');
  ok(caja.includes('function cajaIncomeFilterPayer(') && caja.includes('function cajaIncomeSelectPayer('),
    'el recibo sugiere clientes mientras se escribe el nombre');
  const config = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'config.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(config.includes("id=\"cfg-module-preventa\"") && config.includes('async function togglePreventaModule('),
    'Configuración enciende y apaga Preventa y Despacho');
  ok(mainSrc.includes("const ADMIN_MODULE_KEYS = new Set(['module_preventa']);"),
    'el administrador puede cambiar ese módulo sin ser superadmin');

  console.log(`\n== RESULTADO: ${passed} OK ==`);
} finally {
  try { db.close(); } catch {}
  fs.rmSync(tempDir,{recursive:true,force:true});
}
