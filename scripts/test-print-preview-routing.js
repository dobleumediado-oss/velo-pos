'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const calls = [];
const context = { console, setTimeout, clearTimeout, DB: {settings:{}}, user:{id:1}, CFG:{connectionMode:'client'},
  window:{addEventListener:()=>{},api:{print:{html:()=>{}}}}, document:{addEventListener:()=>{}}, toast:()=>{} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/js/print.js','utf8'), context);
context._getCategoryConfig = () => ({printer:'POS-80',profileId:'ticket_80'});
context._getSavedPrinter = () => 'POS-80';
context._shouldOfferServerPrint = () => true;
context._offerPrintTarget = () => { throw new Error('No debe sustituir una selección explícita por el servidor'); };
context._printDispatch = async payload => { calls.push(payload); return {ok:true}; };
context.resolvePrinterProfile = name => ({kind:name==='Epson'?'sheet':'continuous'});
context.printerProfileLegacyType = p => p.kind === 'sheet' ? 'carta' : 'thermal';
context.getPlantilla = () => ({tipo:'carta'});
context._dispatchPrintWindow('<p>Factura</p>', 'ticket', 7, true, {printerName:'Epson',profileId:'',templateId:'a4'});
assert.equal(calls[0].printerName,'Epson');
assert.equal(calls[0].referenceId,7);
context._dispatchPrintHTML('<p>Orden</p>', 'reporte', {printerName:'Epson'});
assert.equal(calls[1].printerName,'Epson');
context._dispatchPrintHTML('<p>Reporte</p>', 'reporte', {printerName:''});
assert.equal(calls[2].printerName,undefined,'elección del sistema no hereda POS-80');
context.window._printPreviewJob={printOptions:{templateId:'a4',printerName:'POS-80',profileId:'ticket_80'}};
context._printPreviewSelectPrinter('Epson');
assert.equal(context.window._printPreviewJob.printOptions.profileId,'');
assert.equal(context.window._printPreviewJob.printOptions.templateId,'a4');
context._printPreviewSelectPrinter('__route__');
assert.equal(Object.hasOwn(context.window._printPreviewJob.printOptions,'printerName'),false);
console.log('✓ La vista previa conserva impresora, documento y selección del diálogo sin heredar la térmica');

// Vista previa = impresión: en hojas se muestra el PDF real del mismo HTML.
const printSource = fs.readFileSync(require('path').join(__dirname, '../src/js/print.js'), 'utf8');
const mainSource = fs.readFileSync(require('path').join(__dirname, '../main.js'), 'utf8');
const preloadSource = fs.readFileSync(require('path').join(__dirname, '../preload.js'), 'utf8');
assert.ok(printSource.includes('_printPreviewShowPdf(job)') && printSource.includes("previewPdf?.({ html"), 'la vista previa pide el PDF real');
assert.ok(mainSource.includes("ipcMain.handle('print:previewPdf'") && mainSource.includes("layout.profile !== 'css-fixed'"), 'solo hojas: los rollos siguen en HTML');
assert.ok(/plugins:\s*true/.test(mainSource), 'la ventana principal habilita el visor de PDF');
assert.ok(preloadSource.includes("previewPdf:") && preloadSource.includes("'print:previewPdf'"), 'el puente expone print.previewPdf');
console.log('✓ Vista previa exacta: hojas con el PDF que se imprime; rollos con la vista HTML');

const localPrintChannels = mainSource.slice(mainSource.indexOf('localOnly: new Set(['), mainSource.indexOf('const desktopEcf'));
assert.ok(localPrintChannels.includes("'print:previewPdf'") && localPrintChannels.includes("'print:printerProfile'"),
  'la vista previa y el driver pertenecen a la misma terminal que imprime');

const centerContext = vm.createContext({
  window: { addEventListener() {} }, document: { addEventListener() {} },
  DB: { settings: { printer: 'POS-80', print_config: '{"reporte":{"printer":"Láser Oficina"}}' } },
});
vm.runInContext(printSource, centerContext);
vm.runInContext(fs.readFileSync('src/js/printer-profiles.js', 'utf8'), centerContext);
vm.runInContext(fs.readFileSync('src/js/printing-center.js', 'utf8'), centerContext);
assert.equal(vm.runInContext("_getCategoryConfig('reporte').printer", centerContext), 'Láser Oficina');
assert.match(vm.runInContext("pcPrinterOptions('Láser Oficina', [{name:'POS-80'}])", centerContext),
  /value="Láser Oficina" selected/);
assert.equal(vm.runInContext("pcRouteStatus('reporte', {printer:'POS-80'}, [], {}).ready", centerContext), false);
assert.equal(vm.runInContext("printerAcceptsReportSheets('Zebra GK420')", centerContext), false);
assert.equal(vm.runInContext("printerAcceptsReportSheets('Láser Oficina')", centerContext), true);
console.log('✓ El Centro conserva una impresora no disponible y usa la misma ruta que el despacho');


async function testReportConfirmation() {
  context.document.getElementById = () => null;
  context._openPrintPreview = (html, options) => calls.push({ html, ...options });
  const fileName = 'Facturas del período';
  let finishBatch;
  const batch = new Promise(resolve => { finishBatch = resolve; });
  const pending = context.guardarDocumentoPDF(() => batch, fileName);
  context.printHTML('Reporte que se abrió después', 'reporte');
  finishBatch('Copias fiscales');
  await pending;
  assert.equal(calls.at(-2).mode, 'print', 'el segundo reporte no toma la solicitud de PDF del lote');
  assert.equal(calls.at(-1).html.includes('Copias fiscales'), true);
  assert.equal(calls.at(-1).suggestedName, fileName);
  context.printHTML('Lote fiscal', 'reporte', { mode: 'pdf', suggestedName: fileName });
  assert.equal(calls.at(-1).jobType, 'reporte', 'el lote PDF conserva la categoría y el folio de Reportes');

  let requests = 0;
  let issueNumber;
  context.window.api.documents = { issue: () => {
    requests += 1;
    return new Promise(resolve => { issueNumber = resolve; });
  } };
  context.window._printPreviewJob = { html: '<body>Reporte</body>', jobType: 'reporte', source: 'html' };
  context._dispatchPrintHTML = (html, category, options) => calls.push({ html, category, ...options });
  const before = calls.length;
  const first = context._printPreviewPrint();
  const second = context._printPreviewPrint();
  const save = context._printPreviewSavePDF();
  assert.equal(requests, 1);
  issueNumber({ ok: true, data: { formatted_number: 'REP-000001', sequence_number: 1 } });
  await Promise.all([first, second, save]);
  assert.equal(calls.length - before, 1);
  assert.equal(calls.at(-1).referenceId, 1);
  assert.match(calls.at(-1).html, /REP-000001/);
  console.log('✓ El PDF asíncrono conserva su documento y la vista previa confirma un solo folio y despacho');
}

async function testFiscalReportState() {
  const branches = fs.readFileSync('src/js/sucursales.js', 'utf8');
  const source = branches.slice(branches.indexOf('function modalReporteNCF()'), branches.indexOf('// ── Utilidades'));
  const fields = Object.fromEntries([
    'rep-close', 'rep-print', 'rep-excel', 'rep-paper', 'rep-layout', 'rep-ncf-type',
    'rep-tipo', 'rep-from', 'rep-to', 'rep-body', 'rep-gen',
  ].map(id => [id, { addEventListener(event, handler) { this[event] = handler; } }]));
  fields['rep-paper'].value = 'letter portrait';
  fields['rep-layout'].value = 'completo';
  fields['rep-ncf-type'].value = '';
  fields['rep-tipo'].value = '608';
  fields['rep-from'].value = '2026-11-01';
  fields['rep-to'].value = '2026-11-30';
  const overlay = { style: {}, addEventListener() {}, querySelector: query => fields[query.slice(1)] };
  const queries = [];
  const printed = [];
  vm.runInNewContext(source + '\nmodalReporteNCF();', {
    document: { createElement: () => overlay, body: { appendChild() {} } },
    user: { id: 1 }, fmt: value => 'RD$' + value, printHTML: html => printed.push(html),
    window: { api: { ncf: { getVoided: () => new Promise(resolve => queries.push(resolve)) } } },
  });
  const prior = fields['rep-gen'].onclick();
  fields['rep-from'].value = '2026-11-15';
  fields['rep-from'].change();
  const current = fields['rep-gen'].onclick();
  queries[1]({ ok: true, data: [
    { type: 'B01', ncf: 'B0100000001', issued_at: '2026-11-01', voided_at: '2026-11-16', total: 100, tax_amt: 18 },
    { type: 'B04', ncf: 'B0400000001', issued_at: '2026-11-02', voided_at: '2026-11-16', total: -30, tax_amt: -5 },
  ] });
  await current;
  queries[0]({ ok: true, data: [] });
  await prior;
  assert.equal(fields['rep-print'].disabled, false);
  assert.match(fields['rep-body'].innerHTML, /Total anulado: <strong>RD\$130/);
  fields['rep-print'].onclick();
  assert.match(printed[0], /15\/11\/2026 al 30\/11\/2026/);
  assert.match(printed[0], /TOTAL ANULADO \(2\)<\/td><td class="r">RD\$23<\/td><td class="r">RD\$130/);
  console.log('✓ El 608 ignora respuestas anteriores y conserva los mismos totales en pantalla e impresión');
}

Promise.resolve().then(testReportConfirmation).then(testFiscalReportState).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
