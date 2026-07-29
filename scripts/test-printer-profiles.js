'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PRINTER_PROFILES,
  inferPrinterProfileId,
  detectLabelPrinter,
  resolvePrinterProfile,
  buildLabelCalibrationHTML,
  printerProfileLegacyType,
  calculateLabelLayout,
} = require('../src/js/printer-profiles');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPerfiles universales de impresión');

test('detecta la 2Connect 2C-LP427B aunque el driver varíe el separador', () => {
  assert.strictEqual(inferPrinterProfileId('2Connect 2C-LP427B', 'ticket'), 'label_2connect_108');
  assert.strictEqual(inferPrinterProfileId('2C_LP427 Printer', 'barcode'), 'label_2connect_108');
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

console.log(`\n${passed} pruebas de impresión aprobadas.`);
