#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let printed = '';
let category = '';
const context = vm.createContext({
  console,
  window: {},
  document: {},
  CFG: { biz:'Taller Velo', rnc:'131000001', phone:'809-555-0101', addr:'Santo Domingo', biz_logo:'', biz_logo_2:'' },
  fmt: value => `RD$${Number(value || 0).toFixed(2)}`,
  printHTML: (html, type) => { printed = html; category = type; },
  buildLogoHeader: () => '',
  svg: () => '',
  toast: message => { throw new Error(message); },
  setTimeout,
  clearTimeout,
});
context.window = context;
const source = fs.readFileSync(path.join(__dirname,'../src/js/nomina.js'),'utf8');
vm.runInContext(source, context, { filename:'nomina.js' });

const run = {
  id: 9, number:'NOM-20260914-0009', frequency:'semanal', date_from:'2026-09-07', date_to:'2026-09-13',
  payment_date:'2026-09-14', status:'pagado', payment_method:'transferencia', payment_source:'banco',
  payment_reference:'TRX-009', receipt_notes:'Gracias por tu excelente trabajo.', notes:'NOTA INTERNA CONFIDENCIAL',
  base_total:10000, commission_total:0, bonus_total:500, deduction_total:250, net_total:10250,
  items:[{id:91,code:'COL-0009',salesperson_name:'Carlos Mecánico',employee_role:'mecanica',base_salary:10000,commission_amount:0,bonus_amount:500,deduction_amount:250,net_amount:10250}],
};

let pass = 0;
function ok(condition, message) {
  if (!condition) { console.error('  ✗',message); process.exitCode=1; return; }
  pass += 1; console.log('  ✓',message);
}

(async () => {
  await context.nominaPrintReceipts(run, 91);
  ok(category==='recibo_nomina' && printed.includes('RECIBO DE PAGO DE NÓMINA'),'genera un recibo individual en su categoría propia');
  ok(printed.includes('Carlos Mecánico')&&printed.includes('Mecánica')&&printed.includes('RD$10250.00'),'incluye colaborador, área y neto pagado');
  ok(printed.includes('TRX-009')&&printed.includes('Gracias por tu excelente trabajo.'),'incluye referencia y nota visible');
  ok(!printed.includes('NOTA INTERNA CONFIDENCIAL'),'no filtra notas internas al recibo del colaborador');
  ok(printed.includes('Firma del colaborador')&&printed.includes('Firma autorizada'),'incluye constancia y espacios de firma');

  const thermal = context._nomPayrollReceiptHTML(run, run.items, {
    template:'nomina_termica_80',
    options:{showLogo:false,showBusinessDetails:false,showNotes:false,showSignatures:false},
  });
  ok(thermal.includes('size:80mm auto')&&!thermal.includes('Firma del colaborador'),'adapta el recibo a 80 mm y permite ocultar firmas');
  ok(!thermal.includes('Gracias por tu excelente trabajo.')&&!thermal.includes('Taller Velo'),'respeta la visibilidad de nota y datos del negocio');

  printed=''; category='';
  await context.nominaPrintPayrollReport(run);
  ok(category==='reporte'&&printed.includes('REPORTE DE NÓMINA'),'genera el reporte consolidado de nómina');
  ok(printed.includes('NOTA INTERNA CONFIDENCIAL')&&printed.includes('TOTALES'),'el reporte administrativo conserva notas internas y totales');
  console.log(`\n== RESULTADO: ${pass} OK ==`);
})();
