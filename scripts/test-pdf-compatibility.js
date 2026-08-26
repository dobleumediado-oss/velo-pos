'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const qrFactory = require('qrcode-generator');
const { app, BrowserWindow } = require('electron');
const {
  buildPdfOptions,
  waitForPdfDocument,
  validatePdfBuffer,
  writePdfFile,
} = require('../src/main/pdf-document');

app.commandLine.appendSwitch('disable-gpu');

global.buildLogoHeader = () => '';
global.facturaLabel = row => row.document_number_fmt || String(row.id || '');
global.facturaLabelOriginal = row => row.original_document_number_fmt || '';
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '../src/js/plantillas.js'), 'utf8'),
  { filename: 'plantillas.js' }
);

const outputDir = path.join(__dirname, '../output/pdf');
const tempDir = path.join(__dirname, '../tmp/pdfs');
const generatedTempFiles = [];

const cfg = {
  biz_name: 'VELO POS QA',
  biz_rnc: '131-96863-5',
  biz_addr: 'La Vega, República Dominicana',
  biz_phone: '809-737-2612',
  receipt_msg: 'Gracias por su compra. Conserve este comprobante.',
  invoice_branding_enabled: '0',
};
const opts = { logo: false, rnc: true, ncf: true, mensaje: true, cedula: true, _estilos: {} };

function item(index, name = 'PRODUCTO DE PRUEBA') {
  const price = 50 + (index % 7) * 12.5;
  return {
    product_code: `QA-${String(index).padStart(4, '0')}`,
    product_name: `${name} ${index} — Ñ, Á, É y descripción extensa compatible`,
    qty: (index % 3) + 1,
    unit_price: price,
    subtotal: price * ((index % 3) + 1),
    taxable: 1,
    tax_pct: 18,
    tax_amt: 0,
    net_subtotal: price * ((index % 3) + 1),
  };
}

function sampleSale(type, count, id) {
  const items = Array.from({ length: count }, (_, index) => item(index + 1));
  const subtotal = items.reduce((sum, row) => sum + row.subtotal, 0);
  return {
    id,
    document_number_fmt: `${type === 'cotizacion' ? 'COT' : type === 'abono' ? 'ABO' : 'FAC'}-${String(id).padStart(6, '0')}`,
    type,
    status: type === 'cotizacion' ? 'draft' : 'completed',
    date: '2026-08-26',
    time: '10:30',
    due_date: '2026-09-25',
    customer_name: 'CLIENTE DE COMPATIBILIDAD PDF',
    customer_rnc: '001-0000000-1',
    customer_phone: '809-555-0101',
    customer_address: 'Dirección con texto largo para validar saltos, acentos y caracteres dominicanos.',
    cajero: 'ADMINISTRADOR QA',
    items,
    subtotal,
    tax_pct: 18,
    tax_amt: subtotal * 0.18,
    total: subtotal * 1.18,
    payment_method: type === 'cotizacion' ? 'pendiente' : 'efectivo',
    payment_amount: subtotal * 1.18,
    paid_amount: subtotal * 1.18,
    balance_before: subtotal * 1.18,
    balance_after: 0,
    balance_after_payment: 0,
    notes: 'Texto largo de control: el documento debe conservar su diseño, poder paginar y abrir en Chrome sin quedar en blanco.',
  };
}

function inlineQr(text) {
  const qr = qrFactory(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 3, margin: 1, scalable: true });
}

function setThermalPaper(html, paperWidthMm) {
  return String(html).replace(
    /(@page\s*\{[\s\S]{0,180}?\bsize\s*:)\s*\d+(?:\.\d+)?mm\s+auto/i,
    `$1 ${paperWidthMm}mm auto`
  );
}

function addQr(html, label) {
  const block = `<section style="text-align:center;margin:4mm 0 1mm;break-inside:avoid">
    <div style="width:24mm;height:24mm;margin:0 auto">${inlineQr(`https://velo.do/qa/${label}`)}</div>
    <small>QR de verificación · ${label}</small>
  </section>`;
  return String(html).replace('</body>', `${block}</body>`);
}

function setNamedPaper(html, paperName) {
  return String(html).replace(
    /(@page\s*\{[\s\S]{0,180}?\bsize\s*:)\s*(?:letter|a4)/i,
    `$1 ${paperName}`
  );
}

function buildCases() {
  const receipt80 = sampleSale('abono', 8, 4701);
  receipt80.items = [
    { product_code: 'ABONO', product_name: 'ABONO A FACTURA FAC-004701', qty: 1, unit_price: 2500, subtotal: 2500, taxable: 0 },
  ];
  receipt80.subtotal = receipt80.total = receipt80.payment_amount = receipt80.paid_amount = 2500;
  receipt80.balance_before = 7250;
  receipt80.balance_after = receipt80.balance_after_payment = 4750;

  const report = sampleSale('reporte', 145, 4705);
  report.document_number_fmt = 'REP-004705';
  report.customer_name = 'REPORTE GENERAL MULTIPÁGINA';

  return [
    {
      name: '01-recibo-abono-80mm.pdf',
      html: addQr(setThermalPaper(getPlantilla('termica_80_clasica').render(receipt80, cfg, opts), 80), 'ABO-004701'),
      expected: { profile: 'thermal-roll', widthInches: 80 / 25.4, minPages: 1 },
    },
    {
      name: '02-recibo-largo-58mm.pdf',
      html: addQr(setThermalPaper(getPlantilla('termica_58_basica').render(sampleSale('factura', 180, 4702), cfg, opts), 58), 'FAC-004702'),
      expected: { profile: 'thermal-roll', widthInches: 58 / 25.4, minPages: 2 },
    },
    {
      name: '03-factura-a4.pdf',
      html: setNamedPaper(getPlantilla('carta_recibo').render(sampleSale('factura', 24, 4703), cfg, opts), 'A4'),
      expected: { profile: 'css-fixed', minPages: 1 },
    },
    {
      name: '04-cotizacion-carta.pdf',
      html: getPlantilla('carta_formal').render(sampleSale('cotizacion', 34, 4704), cfg, opts),
      expected: { profile: 'css-fixed', minPages: 1 },
    },
    {
      name: '05-reporte-largo-multipagina.pdf',
      html: getPlantilla('carta_recibo').render(report, cfg, opts),
      expected: { profile: 'css-fixed', minPages: 2 },
    },
  ];
}

async function renderCase(win, testCase) {
  const tempHtml = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  generatedTempFiles.push(tempHtml);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(tempHtml, testCase.html, 'utf8');

  await win.loadFile(tempHtml);
  const renderInfo = await waitForPdfDocument(win.webContents);
  assert.strictEqual(renderInfo.brokenImages, 0, `${testCase.name}: recursos incompletos`);
  const layout = buildPdfOptions(testCase.html, renderInfo);
  assert.strictEqual(layout.profile, testCase.expected.profile, `${testCase.name}: perfil incorrecto`);
  if (testCase.expected.widthInches) {
    assert.ok(Math.abs(layout.options.pageSize.width - testCase.expected.widthInches) < 0.01,
      `${testCase.name}: ancho térmico incorrecto`);
  }
  const buffer = await win.webContents.printToPDF(layout.options);
  const validation = validatePdfBuffer(buffer);
  assert.ok(validation.pageCount >= testCase.expected.minPages,
    `${testCase.name}: se esperaban al menos ${testCase.expected.minPages} páginas`);
  const saved = writePdfFile(path.join(outputDir, testCase.name), buffer);
  return { testCase, layout, renderInfo, saved };
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });

  // Prueba unitaria explícita de la regresión: el algoritmo anterior entregaba
  // ~83 882 como "pulgadas" para 302 px; el correcto entrega 3.1496 pulgadas.
  const corrected = buildPdfOptions('<style>@page{size:80mm auto}</style>', { contentHeightPx: 800 });
  const legacyValuePassedAsInches = Math.round(302 * 264.583) + 4000;
  assert.ok(legacyValuePassedAsInches > 80000, 'la sonda histórica debe representar el error de unidades');
  assert.ok(corrected.options.pageSize.width < 3.16 && corrected.options.pageSize.width > 3.14,
    '80 mm debe convertirse a pulgadas para Electron 41');

  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 816,
    height: 1056,
    backgroundColor: '#ffffff',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const results = [];
  try {
    for (const testCase of buildCases()) results.push(await renderCase(win, testCase));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  for (const result of results) {
    const firstBox = result.saved.mediaBoxes[0];
    console.log(JSON.stringify({
      file: result.testCase.name,
      profile: result.layout.profile,
      cssSize: result.layout.cssSize,
      pages: result.saved.pageCount,
      bytes: result.saved.bytes,
      widthPt: Number(firstBox.widthPoints.toFixed(2)),
      heightPt: Number(firstBox.heightPoints.toFixed(2)),
      textLength: result.renderInfo.textLen,
      images: result.renderInfo.imageCount,
      svg: result.renderInfo.svgCount,
    }));
  }
  console.log(`PDF QA: ${results.length} documentos compatibles generados en ${outputDir}`);
}

app.whenReady().then(run).then(() => app.quit()).catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
  app.quit();
}).finally(() => {
  for (const tempFile of generatedTempFiles) {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
  }
});
