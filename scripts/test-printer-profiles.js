'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PRINTER_PROFILES,
  inferPrinterProfileId,
  detectLabelPrinter,
  classifyLabelPrinters,
  chooseLabelPrinter,
  getPrinterRuntimeState,
  normalizePrinterSnapshot,
  diffPrinterSnapshots,
  resolvePrinterProfile,
  buildLabelCalibrationHTML,
  printerProfileLegacyType,
  calculateLabelLayout,
  normalizeLabelText,
  buildLabelRenderModel,
} = require('../src/js/printer-profiles');
const {
  buildPdfOptions,
  extractCssPageSize,
  extractCssPageVerticalMarginInches,
  cleanupStaleGeneratedFiles,
} = require('../src/main/pdf-document');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPerfiles universales de impresión');

test('PDF térmico convierte 80 mm a pulgadas para Electron 41', () => {
  const layout = buildPdfOptions(
    '<style>@page{size:80mm auto;margin:2mm 2mm 4mm}</style>',
    { contentHeightPx: 800 }
  );
  assert.strictEqual(layout.profile, 'thermal-roll');
  assert.ok(Math.abs(layout.options.pageSize.width - (80 / 25.4)) < 0.01);
  assert.ok(layout.options.pageSize.width < 4);
  assert.ok(layout.options.pageSize.height <= 36);
  assert.ok(extractCssPageVerticalMarginInches('<style>@page{margin:2mm 1mm 4mm}</style>') > 0.23);
});

test('PDF respeta A4, Carta y etiquetas fijas mediante CSS', () => {
  for (const size of ['A4', 'letter', '62mm 40mm', '108mm 27mm']) {
    const html = `<style>@page { size:${size}; margin:0 }</style>`;
    const layout = buildPdfOptions(html, { contentHeightPx: 5000 });
    assert.strictEqual(layout.profile, 'css-fixed');
    assert.strictEqual(layout.options.preferCSSPageSize, true);
    assert.strictEqual(extractCssPageSize(html), size.toLowerCase());
  }
});

test('PDF térmico largo pagina sin crear hojas gigantes', () => {
  const layout = buildPdfOptions(
    '<style>@page{size:58mm auto;margin:2mm}</style>',
    { contentHeightPx: 12000 }
  );
  assert.strictEqual(layout.paginated, true);
  assert.strictEqual(layout.options.pageSize.height, 36);
  assert.ok(layout.options.pageSize.width < 3);
});

test('limpia únicamente temporales PDF antiguos generados por VELO', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'velo-pdf-cleanup-'));
  try {
    const oldPdf = path.join(dir, 'documento.pdf');
    const recentPdf = path.join(dir, 'reciente.pdf');
    const unrelated = path.join(dir, 'conservar.txt');
    fs.writeFileSync(oldPdf, 'old');
    fs.writeFileSync(recentPdf, 'new');
    fs.writeFileSync(unrelated, 'keep');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(oldPdf, old, old);
    assert.strictEqual(cleanupStaleGeneratedFiles(dir, /^[^/\\]+\.pdf$/i), 1);
    assert.strictEqual(fs.existsSync(oldPdf), false);
    assert.strictEqual(fs.existsSync(recentPdf), true);
    assert.strictEqual(fs.existsSync(unrelated), true);
  } finally {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
});

test('detecta la 2Connect 2C-LP427B aunque el driver varíe el separador', () => {
  assert.strictEqual(inferPrinterProfileId('2Connect 2C-LP427B', 'ticket'), 'label_2connect_108');
  assert.strictEqual(inferPrinterProfileId('2C_LP427 Printer', 'barcode'), 'label_2connect_108');
});

test('Brother QL-710W conserva el canal térmico aunque el driver incluya la marca Brother', () => {
  const exactName = 'Brother QL-710W WIFI - Brother';
  assert.strictEqual(inferPrinterProfileId(exactName, 'ticket'), 'label_generic');
  assert.strictEqual(inferPrinterProfileId(exactName, 'barcode'), 'label_generic');
  assert.strictEqual(detectLabelPrinter({ name: exactName }, {}).confidence, 'medium');
  assert.strictEqual(resolvePrinterProfile(exactName, 'barcode', {
    barcode_printer_profile: 'sheet',
    barcode_media_width_mm: '62',
  }).kind, 'labels');
  assert.strictEqual(inferPrinterProfileId('Brother HL-L2350DW', 'ticket'), 'sheet');
});

test('el preset 2Connect conserva 108mm y 203dpi', () => {
  const p = resolvePrinterProfile('2Connect LP-427', 'barcode', {});
  assert.strictEqual(p.widthMm, 108);
  assert.strictEqual(p.printableWidthMm, 108);
  assert.strictEqual(p.dpi, 203);
  assert.deepStrictEqual(p.languages, ['Driver', 'ZPL', 'TSPL', 'EPS/EPL', 'DPL']);
  assert.strictEqual(printerProfileLegacyType(p), '108mm');
});

test('el detector combina nombre visible, descripción y metadatos del controlador', () => {
  const detected = detectLabelPrinter({
    name: 'POS_Printer_3',
    displayName: 'Etiquetas almacén',
    description: '2Connect 2C-LP427B',
    isDefault: true,
    status: 0,
  }, {});
  assert.strictEqual(detected.id, 'label_2connect_108');
  assert.strictEqual(detected.widthMm, 108);
  assert.strictEqual(detected.dpi, 203);
  assert.strictEqual(detected.confidence, 'high');
  assert.strictEqual(detected.isDefault, true);
});

test('reconoce el modelo real y las incidencias reportadas por el controlador', () => {
  const info = {
    name: 'Printer_01',
    options: {
      'printer-make-and-model': '2Connect 2C-LP427B',
      'printer-is-accepting-jobs': 'false',
      'printer-state-reasons': 'offline-report,media-empty-warning',
    },
  };
  const detected = detectLabelPrinter(info, {});
  const runtime = getPrinterRuntimeState(info);
  assert.strictEqual(detected.id, 'label_2connect_108');
  assert.strictEqual(runtime.model, '2Connect 2C-LP427B');
  assert.strictEqual(runtime.acceptingJobs, false);
  assert.strictEqual(runtime.reportedIssue, true);
});

test('separa impresoras de etiquetas de impresoras de documentos', () => {
  const classified = classifyLabelPrinters([
    { name: 'HP LaserJet Pro' },
    { name: '2Connect 2C-LP427B' },
  ], {});
  assert.strictEqual(classified[0].labelDetection.confidence, 'low');
  assert.strictEqual(classified[1].labelDetection.confidence, 'high');
});

test('autoselecciona solo una etiquetadora reconocida y nunca la impresora general', () => {
  const single = chooseLabelPrinter([
    { name: 'HP LaserJet Pro' },
    { name: '2Connect 2C-LP427B' },
  ], '', {});
  assert.strictEqual(single.printerName, '2Connect 2C-LP427B');
  assert.strictEqual(single.autoDetected, true);

  const ambiguous = chooseLabelPrinter([
    { name: 'Zebra ZD220' },
    { name: 'TSC TE200' },
  ], '', {});
  assert.strictEqual(ambiguous.printerName, '');
  assert.strictEqual(ambiguous.autoDetected, false);
});

test('el monitor detecta altas, bajas y cambios sin depender del orden', () => {
  const before = [
    { name: 'Caja', status: 0, isDefault: true },
    { name: 'Etiquetas', status: 0 },
  ];
  const after = [
    { name: 'Etiquetas', status: 2 },
    { name: 'Oficina', status: 0 },
  ];
  const diff = diffPrinterSnapshots(before, after);
  assert.deepStrictEqual(diff.added.map(p => p.name), ['Oficina']);
  assert.deepStrictEqual(diff.removed.map(p => p.name), ['Caja']);
  assert.deepStrictEqual(diff.updated.map(p => p.name), ['Etiquetas']);
  assert.strictEqual(diff.changed, true);
  assert.deepStrictEqual(normalizePrinterSnapshot(after).map(p => p.name), ['Etiquetas', 'Oficina']);
});

test('el perfil universal permite ancho y DPI configurables con límites seguros', () => {
  const p = resolvePrinterProfile('Generic Label Printer', 'barcode', {
    barcode_printer_profile: 'label_generic',
    barcode_media_width_mm: '72',
    barcode_printer_dpi: '300',
  });
  assert.strictEqual(p.widthMm, 72);
  assert.strictEqual(p.dpi, 300);
});

test('dos etiquetas de 50mm caben en el rollo 2Connect de 108mm', () => {
  const layout = calculateLabelLayout(
    { labelW: 50, labelH: 25, gapMm: 2, pageMm: 0, cols: 4 },
    PRINTER_PROFILES.label_2connect_108
  );
  assert.strictEqual(layout.cols, 2);
  assert.strictEqual(layout.usedWidthMm, 102);
  assert.strictEqual(layout.rowHeightMm, 27);
  assert.strictEqual(layout.adjusted, true);
});

test('distingue el ancho del medio del ancho de cada etiqueta', () => {
  const layout = calculateLabelLayout(
    { labelW: 50, labelH: 25, gapMm: 2, pageMm: 5, cols: 4 },
    PRINTER_PROFILES.label_2connect_108
  );
  assert.strictEqual(layout.mediaWidthMm, 108);
  assert.strictEqual(layout.labelW, 50);
  assert.strictEqual(layout.availableWidthMm, 98);
  assert.strictEqual(layout.cols, 1);
  assert.strictEqual(layout.fitsMedia, true);
  assert.strictEqual(layout.adjusted, true);
});

test('marca como inválida una etiqueta más ancha que el área útil', () => {
  const layout = calculateLabelLayout(
    { labelW: 100, labelH: 25, gapMm: 2, pageMm: 5, cols: 1 },
    { widthMm: 100, printableWidthMm: 100 }
  );
  assert.strictEqual(layout.availableWidthMm, 90);
  assert.strictEqual(layout.fitsMedia, false);
  assert.strictEqual(layout.overflowMm, 10);
});

test('normaliza nombres migrados y evita repetir el código visible', () => {
  assert.strictEqual(normalizeLabelText('  "BATERIA EXTERNA CONTROL "  '), 'BATERIA EXTERNA CONTROL');
  const model = buildLabelRenderModel(
    { id: 20, name: ' "Producto" ', code: 'ABC-20', barcode: '' },
    { labelW: 50, labelH: 25, showBarcode: true, showBarcodeText: true, showCode: true },
    { widthMm: 108, printableWidthMm: 108 }
  );
  assert.strictEqual(model.product.name, 'Producto');
  assert.strictEqual(model.barcodeValue, 'ABC-20');
  assert.strictEqual(model.standaloneCodeVisible, false);
});

test('conserva SKU independiente cuando el valor de barras es distinto', () => {
  const model = buildLabelRenderModel(
    { code: 'SKU-20', barcode: '746000000020' },
    { labelW: 50, labelH: 25, showBarcode: true, showBarcodeText: true, showCode: true },
    { widthMm: 108, printableWidthMm: 108 }
  );
  assert.strictEqual(model.standaloneCodeVisible, true);
});

test('el margen lateral no altera el alto físico ni el avance de la etiqueta', () => {
  const layout = calculateLabelLayout(
    { labelW: 50, labelH: 25, gapMm: 2, pageMm: 5, cols: 1 },
    { widthMm: 50, printableWidthMm: 50 }
  );
  assert.strictEqual(layout.pageMm, 5);
  assert.strictEqual(layout.rowHeightMm, 27);
});

test('la prueba de calibración es una etiqueta válida con tamaño y ajustes exactos', () => {
  const html = buildLabelCalibrationHTML({
    widthMm: 108,
    labelHeightMm: 25,
    gapMm: 2,
    offsetXmm: -0.5,
    offsetYmm: 1,
    printerLabel: '2Connect <principal>',
  });
  assert.ok(html.includes('class="vp-label"'));
  assert.ok(html.includes('data-velo-label-calibration="1"'));
  assert.ok(html.includes('@page { size:108mm 27mm;'));
  assert.ok(html.includes('translate(-0.5mm, 1mm)'));
  assert.ok(html.includes('2Connect &lt;principal&gt;'));
});

test('la calibración respeta etiqueta, medio y columnas como medidas separadas', () => {
  const html = buildLabelCalibrationHTML({
    widthMm: 108,
    labelWidthMm: 50,
    labelHeightMm: 25,
    gapMm: 2,
    pageMm: 0,
    cols: 2,
  });
  assert.ok(html.includes('grid-template-columns:repeat(2, 50mm)'));
  assert.strictEqual((html.match(/class="vp-label"/g) || []).length, 2);
  assert.ok(html.includes('50×25mm'));
});

test('reduce columnas automáticamente para impedir recortes', () => {
  const layout = calculateLabelLayout(
    { labelW: 50, labelH: 25, gapMm: 2, pageMm: 0, cols: 3 },
    { widthMm: 72, printableWidthMm: 72 }
  );
  assert.strictEqual(layout.cols, 1);
  assert.ok(layout.usedWidthMm <= layout.mediaWidthMm);
});

test('mantiene compatibilidad con perfiles históricos de ticket', () => {
  assert.strictEqual(resolvePrinterProfile('Mini 58 Printer', 'ticket', {}).widthMm, 58);
  assert.strictEqual(resolvePrinterProfile('AOKIA AK-3380', 'ticket', {}).widthMm, 80);
  assert.strictEqual(resolvePrinterProfile('HP LaserJet', 'ticket', {}).kind, 'sheet');
});

test('Epson ET-4810 WiFi se detecta como hoja y corrige un perfil térmico heredado', () => {
  assert.strictEqual(inferPrinterProfileId('ET-4810 Series WiFi', 'ticket'), 'sheet');
  assert.strictEqual(resolvePrinterProfile('EPSON ET-4810 Series WiFi', 'ticket', {
    printer_profile: 'ticket_80',
    printer_width_mm: '80',
  }).kind, 'sheet');
});

test('el módulo de etiquetas no hereda la impresora de facturas ni permite salida implícita', () => {
  const barcodeSource = fs.readFileSync(path.join(__dirname, '../src/js/barcode.js'), 'utf8');
  const designerSource = fs.readFileSync(path.join(__dirname, '../src/js/barcode-designer.js'), 'utf8');
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(!barcodeSource.includes("settings?.barcode_printer || settings?.printer"));
  assert.ok(!designerSource.includes("settings?.barcode_printer || settings?.printer"));
  assert.ok(printSource.includes('Selecciona una impresora de etiquetas; la impresora de documentos no se usa automáticamente'));
  assert.ok(mainSource.includes("jobType === 'barcode_labels'"));
});

test('Etiquetas usa JsBarcode local y bloquea trabajos incompletos', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/js/barcode.js'), 'utf8');
  assert.ok(source.includes("vendor/jsbarcode/JsBarcode.all.min.js"));
  assert.ok(source.includes('renderedCodes < total'));
  assert.ok(source.includes('No se enviaron etiquetas en blanco'));
});

test('el despacho de etiquetas valida contenido y conserva el alto calculado', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  assert.ok(source.includes("String(html || '').includes('class=\"vp-label\"')"));
  assert.ok(source.includes("jobType: 'barcode_labels'"));
  assert.ok(source.includes("printerHeight: heightMm ? `${Number(heightMm)}mm` : undefined"));
});

test('la etiqueta de servicio usa el canal de etiquetas y tamaño 62×40 mm', () => {
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, '../src/js/servicio.js'), 'utf8');
  assert.ok(printSource.includes("servicio_etiqueta: 'etiquetas'"));
  assert.ok(printSource.includes("category === 'servicio_etiqueta' ? '62mm'"));
  assert.ok(printSource.includes("category === 'servicio_etiqueta' ? '40mm'"));
  assert.ok(serviceSource.includes("printHTML(html,'servicio_etiqueta')"));
});

test('el asistente conserva calibraciones independientes por impresora', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/js/barcode.js'), 'utf8');
  assert.ok(source.includes("function _bcCalibrationKey(printerName)"));
  assert.ok(source.includes("key: 'barcode_calibrations'"));
  assert.ok(source.includes("function _bcOpenCalibrationWizard()"));
  assert.ok(source.includes("await printLabelBatch({"));
  assert.ok(source.includes("Calibración guardada para esta impresora"));
});

test('el diseñador solo confirma la prueba después de recibir el resultado', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/js/barcode-designer.js'), 'utf8');
  assert.ok(source.includes('async function _bcdPrintCalibration()'));
  assert.ok(source.includes('buildLabelCalibrationHTML({'));
  assert.ok(source.includes('const result = await printLabelBatch({'));
  assert.ok(source.includes("if (result?.ok === false) throw new Error"));
});

test('diseñador, vista previa e impresión comparten el mismo render de etiqueta', () => {
  const barcodeSource = fs.readFileSync(path.join(__dirname, '../src/js/barcode.js'), 'utf8');
  const designerSource = fs.readFileSync(path.join(__dirname, '../src/js/barcode-designer.js'), 'utf8');
  assert.ok(barcodeSource.includes('function _bcBuildLabelMarkup'));
  assert.ok(barcodeSource.includes('_bcBuildLabelMarkup(p, d, profile)'));
  assert.ok(designerSource.includes('_bcBuildLabelMarkup(p, d, profile)'));
  assert.ok(!barcodeSource.includes('_bcState.design.labelW = _bcState.mediaWidthMm'));
  assert.ok(!designerSource.includes("key: 'barcode_media_width_mm', value: String(design.labelW)"));
  assert.ok(!designerSource.includes('Usar ${det.widthMm}mm'));
});

test('el Centro de impresión centraliza rutas y mantiene etiquetas separadas', () => {
  const centerSource = fs.readFileSync(path.join(__dirname, '../src/js/printing-center.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../src/js/app.js'), 'utf8');
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const businessContextSource = fs.readFileSync(path.join(__dirname, '../src/main/business-context.js'), 'utf8');
  assert.ok(centerSource.includes('function renderPrintingCenter'));
  assert.ok(centerSource.includes('pcDocumentPrinters'));
  assert.ok(centerSource.includes('pcLabelPrinters'));
  assert.ok(centerSource.includes("renderBarcode(host, { embedded: true })"));
  assert.ok(centerSource.includes('function pcRenderTemplateDiagnostics'));
  assert.ok(centerSource.includes('function pcAnalyzeTemplate'));
  assert.ok(centerSource.includes('printer_channel_bindings'));
  assert.ok(printSource.includes('const PRINT_CHANNELS'));
  assert.ok(printSource.includes('print_route_config'));
  assert.ok(printSource.includes('printer_channel_profiles'));
  assert.ok(businessContextSource.includes("'printer_channel_bindings'"));
  assert.ok(businessContextSource.includes("'printer_channel_profiles'"));
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(mainSource.includes("bindings[safeChannel] || settingsRepo.get('printer')"));
  assert.ok(mainSource.includes("profiles[safeChannel] || settingsRepo.get('printer_profile')"));
  assert.ok(appSource.includes("case 'impresion':"));
});

test('el cobro VELO resuelve la salida sin mezclar etiquetadoras', () => {
  const posSource = fs.readFileSync(path.join(__dirname, '../src/js/pos.js'), 'utf8');
  const databaseSource = fs.readFileSync(path.join(__dirname, '../database.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(posSource.includes('function posRenderPrintOutput'));
  assert.ok(posSource.includes('Guardar sin abrir documento'));
  assert.ok(posSource.includes('Mostrar documento'));
  assert.ok(posSource.includes("return !['high', 'medium'].includes(confidence)"));
  assert.ok(databaseSource.includes("'print_printer_name'"));
  assert.ok(databaseSource.includes("'print_copies'"));
  assert.ok(mainSource.includes('copies: Math.max(1, Math.min(9'));
});

test('ningún documento se imprime automáticamente antes del botón del display', () => {
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const posSource = fs.readFileSync(path.join(__dirname, '../src/js/pos.js'), 'utf8');
  assert.ok(printSource.includes('const shouldPreview = true'));
  assert.ok(printSource.includes('ningún documento se envía automáticamente al spooler'));
  assert.ok(printSource.includes('solo el botón Imprimir del display despacha el trabajo'));
  assert.ok(printSource.includes('if (!window._printPreviewBypass)'));
  assert.ok(!posSource.includes('Imprimir automáticamente'));
  assert.ok(!posSource.includes('autoPrint: true'));
});

test('el conduce impreso prioriza entrega, observaciones y espacio de recepción', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const start = source.indexOf('function printConduceDoc(dn)');
  const end = source.indexOf('function printAbono(', start);
  const conduce = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(!conduce.includes('<span class="k">Estado:</span>'));
  assert.ok(!conduce.includes('<span class="k">Origen:</span>'));
  assert.ok(conduce.indexOf('<table class="items">') < conduce.indexOf('<div class="notes">'));
  assert.ok(conduce.indexOf('<div class="notes">') < conduce.indexOf('<div class="signs">'));
  assert.ok(conduce.includes('margin-top:32px'));
  assert.ok(conduce.includes('.received-document .document-line { flex:0 0 150px'));
  assert.ok(conduce.includes('<span>Cédula:</span><span class="document-line">'));
});

test('monitorea impresoras y vuelve a validarlas inmediatamente antes del envío', () => {
  const printSource = fs.readFileSync(path.join(__dirname, '../src/js/print.js'), 'utf8');
  const posSource = fs.readFileSync(path.join(__dirname, '../src/js/pos.js'), 'utf8');
  const barcodeSource = fs.readFileSync(path.join(__dirname, '../src/js/barcode.js'), 'utf8');
  const centerSource = fs.readFileSync(path.join(__dirname, '../src/js/printing-center.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(printSource.includes('const PRINTER_MONITOR_INTERVAL_MS = 4000'));
  assert.ok(printSource.includes("new CustomEvent('velo:printers-changed'"));
  assert.ok(printSource.includes('printerMonitorEnsureAvailable(payload.printerName)'));
  assert.ok(posSource.includes("document.addEventListener('velo:printers-changed'"));
  assert.ok(barcodeSource.includes('function _bcHandlePrinterSnapshot'));
  assert.ok(centerSource.includes('function pcDetectNow'));
  assert.ok(mainSource.includes('async function _assertPrinterQueueAvailable'));
  assert.ok(mainSource.includes("firstErr?.code === 'PRINTER_UNAVAILABLE'"));
});

console.log(`\n${passed} pruebas de impresión aprobadas.`);
