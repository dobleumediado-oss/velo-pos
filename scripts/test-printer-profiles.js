'use strict';

const assert = require('assert');
const {
  PRINTER_PROFILES,
  inferPrinterProfileId,
  resolvePrinterProfile,
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

console.log(`\n${passed} pruebas de impresión aprobadas.`);
