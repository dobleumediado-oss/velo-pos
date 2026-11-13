#!/usr/bin/env node
'use strict';

// Recibo de egreso: un gasto pagado con el efectivo de la caja. Comprueba que
// baja el cuadre, que Caja lo lista por sesión, que se imprime con su diseño
// y que solo el administrador puede hacerlo desde Caja.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let passed = 0;
const ok = (condition, message) => {
  if (!condition) { console.error('  ✗', message); process.exitCode = 1; return; }
  passed += 1; console.log('  ✓', message);
};

const tempDir = path.join(os.tmpdir(), `velo_cash_expense_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

try {
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  db.prepare("INSERT INTO settings(key,value) VALUES('module_contabilidad','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const sessionId = DB.cashRepo.open({ userId:admin.id, cajero:admin.name, openAmount:1000, openBills:{}, terminalId:'EXPENSE-QA' });
  const category = db.prepare('SELECT id,name FROM expense_categories WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1').get();

  const createExpense = (overrides = {}) => DB.expensesRepo.create(Object.assign({
    type:'gasto', category_id:category?.id || null, description:'Pago de fletes',
    beneficiary_name:'Transportista de prueba', beneficiary_document:'001-0000000-1',
    amount:300, total:300, payment_method:'efectivo', payment_source:'caja',
    issue_date:'2026-11-13', user_id:admin.id, status:'pendiente_pago',
  }, overrides));
  const pay = (expenseId, amount, extra = {}) => DB.expensesRepo.pay(Object.assign({
    expenseId, amount, payment_method:'efectivo', payment_source:'caja', cash_session_id:sessionId,
    userId:admin.id, userName:admin.name,
  }, extra));

  console.log('\n== Egreso pagado con el efectivo de la caja ==');
  const expenseId = createExpense();
  const payment = pay(expenseId, 300);
  ok(/^RGE-\d{6}$/.test(payment.documentNumberFmt), 'el egreso con persona identificada emite su número RGE');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === 700, 'baja exactamente lo esperado en el cuadre');
  let rows = DB.expensesRepo.getCashPaymentsBySession(sessionId);
  ok(rows.length === 1 && Number(rows[0].id) === Number(payment.paymentId), 'Caja lo encuentra en la sesión');
  ok(rows[0].document_number_fmt === payment.documentNumberFmt && String(rows[0].description).toUpperCase() === 'PAGO DE FLETES' &&
    Number(rows[0].amount) === 300 && Number(rows[0].expense_id) === Number(expenseId),
  'la fila trae número, concepto, monto y gasto para reimprimir');
  ok(!category || rows[0].category_name === category.name, 'la fila trae la categoría del gasto');
  ok(DB.expensesRepo.getById(expenseId).status === 'pagado', 'el gasto queda pagado en Gastos');
  ok(Number(rows[0].active_payments) === 1 && Number(rows[0].expense_total) === 300 &&
    Number(rows[0].expense_cash_session_id) === Number(sessionId),
  'la fila dice si el recibo es todo el gasto y de qué caja salió (para poder anularlo en Caja)');

  DB.accountingRepo.generateExpenseAccrualEntry({ expenseId, userId:admin.id });
  DB.accountingRepo.generateExpensePaymentEntry({ paymentId:payment.paymentId, userId:admin.id });
  DB.accountingRepo.generateExpensePaymentEntry({ paymentId:payment.paymentId, userId:admin.id });
  const accrualEntries = db.prepare("SELECT COUNT(*) c FROM accounting_entries WHERE source_module='gasto_dev' AND source_id=?").get(expenseId).c;
  // El asiento del pago se identifica por el gasto (source_id = expense_id).
  const paymentEntries = db.prepare("SELECT COUNT(*) c FROM accounting_entries WHERE source_module='gasto_pago' AND source_id=?").get(expenseId).c;
  ok(accrualEntries === 1 && paymentEntries === 1, 'Contabilidad registra el gasto y su pago una sola vez');

  console.log('\n== Lo que no salió de esta caja no aparece ==');
  const bankExpense = createExpense({ description:'Pago por transferencia', payment_method:'transferencia', payment_source:'banco' });
  pay(bankExpense, 300, { payment_method:'transferencia', payment_source:'banco', cash_session_id:null });
  rows = DB.expensesRepo.getCashPaymentsBySession(sessionId);
  ok(rows.length === 1, 'un pago por banco no se lista como egreso de caja');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === 700, 'ni toca el efectivo de la caja');
  ok(DB.expensesRepo.getCashPaymentsBySession(0).length === 0 &&
    DB.expensesRepo.getCashPaymentsBySession(null).length === 0, 'una sesión inválida no devuelve nada');

  console.log('\n== Pago parcial y anulación ==');
  const partialId = createExpense({ description:'Reparación de puerta', amount:500, total:500 });
  pay(partialId, 200);
  rows = DB.expensesRepo.getCashPaymentsBySession(sessionId);
  ok(rows.length === 2 && Number(rows[0].amount) === 200, 'el abono parcial a un gasto también es un egreso de caja');
  ok(Number(rows[0].expense_total) === 500 && Number(rows[0].amount) === 200,
    'un abono parcial no es todo el gasto: Caja no ofrece anularlo, se anula desde Gastos');
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === 500, 'el cuadre baja solo lo pagado');
  DB.expensesRepo.cancel(partialId, admin.id, admin.name, 'Registrado por error', { returnCashSessionId:sessionId });
  rows = DB.expensesRepo.getCashPaymentsBySession(sessionId);
  ok(rows.length === 1 && rows.every(row => Number(row.expense_id) !== Number(partialId)),
    'al anular el gasto su egreso sale de la lista operativa');

  console.log('\n== Historial de recibos de egreso ==');
  const today = db.prepare("SELECT date('now','localtime') d").get().d;
  let history = DB.expensesRepo.searchPaymentReceipts({ from:today, to:today });
  ok(history.rows.length === 3, 'el historial trae todos los pagos de hoy: caja, banco y el parcial anulado');
  ok(history.totals.active === 600 && history.totals.cancelled === 200, 'separa vigentes de anulados en los totales');
  ok(history.rows.every(row => String(row.created_local || '').slice(0, 10) === today), 'la fecha sale en hora local');
  history = DB.expensesRepo.searchPaymentReceipts({ from:today, to:today, includeCancelled:false });
  ok(history.rows.length === 2 && history.rows.every(row => row.status === 'pagado'), 'puede ocultar los anulados');
  history = DB.expensesRepo.searchPaymentReceipts({ from:today, to:today, query:'transferencia' });
  ok(history.rows.length === 1 && history.rows[0].payment_method === 'transferencia', 'busca por concepto');
  history = DB.expensesRepo.searchPaymentReceipts({ from:'2000-01-01', to:'2000-01-31' });
  ok(history.rows.length === 0 && history.totals.active === 0, 'un período sin pagos queda vacío');
  history = DB.expensesRepo.searchPaymentReceipts({ from:"x' OR 1=1 --", to:'', query:"%' OR '1'='1" });
  ok(history.rows.length === 0, 'fechas inválidas se ignoran y el texto se busca como texto, nunca como SQL');

  console.log('\n== Anular desde Caja ==');
  const cancelId = createExpense({ description:'Compra duplicada', amount:150, total:150 });
  pay(cancelId, 150);
  const beforeCancel = DB.cashRepo.getSessionCashSummary(sessionId).expected;
  DB.expensesRepo.cancel(cancelId, admin.id, admin.name, 'Registrado dos veces', { returnCashSessionId:sessionId, requireCashReturn:true });
  ok(DB.cashRepo.getSessionCashSummary(sessionId).expected === beforeCancel + 150, 'anular devuelve el dinero a la caja');
  ok(!DB.expensesRepo.getCashPaymentsBySession(sessionId).some(row => Number(row.expense_id) === Number(cancelId)),
    'el egreso anulado sale de la tarjeta de la sesión');
  ok(DB.expensesRepo.searchPaymentReceipts({ from:today, to:today }).rows
    .some(row => Number(row.expense_id) === Number(cancelId) && row.status === 'anulado'),
  'y queda en el historial como anulado');

  console.log('\n== Diseño del recibo ==');
  const cajaSource = fs.readFileSync(path.join(__dirname, '../src/js/caja.js'), 'utf8');
  const from = cajaSource.indexOf('const _CAJA_EXPENSE_TEMPLATES');
  const to = cajaSource.indexOf('function printExpenseReceipt(');
  ok(from > 0 && to > from, 'caja.js contiene el diseño del recibo de egreso');
  const render = ({ route = {}, ticket = '', override = null, receipt = {} } = {}) => {
    const context = {
      _getCategoryConfig: category => (category === 'ticket' ? { template:ticket } : route),
      DB: { settings: {} },
      CFG: { biz:'NEGOCIO', rnc:'101', phone:'809', addr:'RD', biz_logo:'x', biz_logo_2:'' },
      today: () => '2026-11-13',
      fmt: value => `RD$${Number(value || 0).toFixed(2)}`,
      fdate: value => value,
      _cajaEsc: value => String(value == null ? '' : value),
      buildLogoHeader: () => '<img src="logo.png"/>',
    };
    vm.runInNewContext(`${cajaSource.slice(from, to)}
      this.template = cajaExpenseReceiptTemplate(override);
      this.html = buildExpenseReceiptHTML(receipt, override);`, Object.assign(context, {
      override,
      receipt: Object.assign({
        document_number_fmt:'RGE-000001', paid_to_name:'JUAN', paid_to_document:'001',
        created_at:'2026-11-13 10:00', method:'efectivo', category_name:'Fletes',
        concept:'Concepto del egreso', amount:300, expense_total:300, balance_after:0,
        notes:'Nota', user_name:'Administrador',
      }, receipt),
    }));
    return context;
  };
  const base = render();
  ok(base.html.includes('RECIBO DE EGRESO') && base.html.includes('Constancia de dinero entregado'),
    'el documento se titula Recibo de egreso');
  ok(base.html.includes('Pagado a') && base.html.includes('Entregado por') && base.html.includes('Recibido por'),
    'muestra a quién se pagó y las dos firmas');
  ok(base.html.includes('Documento interno · No sustituye comprobante fiscal'), 'se identifica como documento interno');
  ok(render({ ticket:'termica_80_clasica' }).template === 'egreso_termica_80', 'si ventas imprime en 80 mm, el egreso sale en 80 mm');
  ok(render({ ticket:'carta_recibo' }).template === 'egreso_carta_profesional', 'si ventas imprime en carta, el egreso sale en carta');
  ok(render({ ticket:'termica_58_basica' }).template === 'egreso_ticket_pos', 'en rollo de 58 mm conserva el formato anterior, que sí cabe');
  ok(render({ route:{ template:'egreso_carta_compacta' }, ticket:'termica_80_clasica' }).template === 'egreso_carta_compacta',
    'la plantilla elegida en el Centro de impresión manda');
  ok(render({ route:{ template:'egreso_termica_80' } }).html.includes('@page{size:80mm auto;margin:4mm}'), 'la térmica usa rollo de 80 mm');
  const partial = render({ receipt:{ amount:200, expense_total:500, balance_after:300 } }).html;
  ok(partial.includes('Saldo pendiente RD$300.00'), 'un pago parcial dice el saldo que queda');
  ok(!base.html.includes('Saldo pendiente'), 'un pago completo no menciona saldo');
  ok(render({ receipt:{ is_reprint:true } }).html.includes('Reimpresión'), 'la reimpresión queda marcada');
  const stripped = render({ override:{ template:'egreso_carta_profesional',
    options:{ showLogo:false, showBusinessDetails:false, showNotes:false, showSignatures:false } } }).html;
  ok(!stripped.includes('logo.png') && !stripped.includes('Recibido por') && !stripped.includes('<strong>Notas</strong>'),
    'las opciones del Centro de impresión quitan logo, notas y firmas');

  console.log('\n== Reglas en el proceso principal y la interfaz ==');
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const guard = mainSource.slice(mainSource.indexOf('if (data.from_cash_register === true)'),
    mainSource.indexOf('delete data.from_cash_register;'));
  ok(guard.includes("['admin', 'superadmin'].includes(u.role)"), 'desde Caja solo el administrador registra egresos');
  ok(guard.includes('Number(session.id) !== Number(data.cash_session_id)'), 'exige la caja abierta de esta terminal');
  ok(guard.includes("_method !== 'efectivo' || !wantPayNow"), 'el egreso de Caja se paga en efectivo al momento');
  const readHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('expenses:getCashReceipts'"));
  ok(readHandler.slice(0, 500).includes("['admin', 'superadmin'].includes(u.role)"), 'la lista de egresos exige administrador');
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  ok(preload.includes("getCashReceipts:  (d) => ipcRenderer.invoke('expenses:getCashReceipts', d)"), 'el canal está en la lista blanca');
  const whitelist = mainSource.slice(mainSource.indexOf('const allowedCategories = new Set(['),
    mainSource.indexOf('const allowedChannels = new Set(['));
  ok(/'egreso'/.test(whitelist), 'la plantilla del recibo de egreso se guarda en la configuración');
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  ok(printSource.includes("recibo_egreso: 'egreso'") && printSource.includes("cajaExpenseReceiptTemplate() !== 'egreso_ticket_pos'"),
    'los pagos de Gastos usan el recibo de egreso salvo que se elija el formato anterior');
  const cancellable = cajaSource.slice(cajaSource.indexOf('function cajaExpenseCancellableHere'),
    cajaSource.indexOf('function openCancelExpenseReceiptModal'));
  ok(cancellable.includes('Number(row.active_payments) === 1') && cancellable.includes('row.expense_total') &&
    cancellable.includes('Number(row.expense_cash_session_id) === Number(sessionId)'),
  'Caja solo ofrece anular cuando el recibo es todo el gasto y salió de esta sesión');
  ok(cajaSource.includes('window.api.expenses.cancel({ expenseId, reason') && cajaSource.includes('Motivo de la anulación'),
    'anular desde Caja usa el flujo de Gastos y exige motivo');
  ok(cajaSource.includes('Historial de recibos de egreso') && cajaSource.includes('window.api.expenses.searchReceipts'),
    'Caja muestra el historial de egresos por fechas');
  const searchHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('expenses:searchReceipts'"));
  ok(searchHandler.slice(0, 500).includes("['admin', 'superadmin'].includes(u.role)") &&
    preload.includes("searchReceipts:   (d) => ipcRenderer.invoke('expenses:searchReceipts', d)"),
  'el historial exige administrador y su canal está en la lista blanca');
  ok(printSource.includes("`${rawCreated.replace(' ', 'T')}Z`"), 'el recibo convierte la hora UTC guardada a la fecha local');
  ok(cajaSource.includes('Recibo de egreso') && cajaSource.includes('function cajaCanIssueExpenseReceipt') &&
    cajaSource.includes("CFG.module_gastos === '1'"), 'Caja muestra el botón solo con Gastos activo y administrador');
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch {}
}

console.log(`\n${passed} pruebas del recibo de egreso aprobadas.`);
