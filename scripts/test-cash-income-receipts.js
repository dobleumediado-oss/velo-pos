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

  const ui = fs.readFileSync(path.join(__dirname,'../src/js/caja.js'),'utf8');
  ok(ui.includes('Historial de recibos de ingreso')&&ui.includes('function cajaSearchIncomeHistory')&&
    ui.includes('function cajaReprintIncomeReceipt'),'Caja muestra el historial con reimpresión');
  ok(ui.includes('Nuevo recibo de ingreso')&&ui.includes("printHTML(buildIncomeReceiptHTML(receipt, override), 'recibo_ingreso')"),'Caja incluye captura e impresión del recibo');
  ok(ui.includes('function _cajaIncomeReceiptSettings')&&ui.includes("_getCategoryConfig('ingreso')")&&
    ui.includes("settings.template === 'ingreso_termica_80'"),'el recibo respeta la plantilla configurada en el Centro de impresión');
  ok(ui.includes('Registrar e imprimir')&&ui.includes('Documento interno · No sustituye comprobante fiscal'),'el flujo termina en un comprobante interno identificado');

  console.log(`\n== RESULTADO: ${passed} OK ==`);
} finally {
  try { db.close(); } catch {}
  fs.rmSync(tempDir,{recursive:true,force:true});
}
