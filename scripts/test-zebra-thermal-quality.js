'use strict';

// Calidad de impresión: etiquetas Zebra en ZPL nativo y motores compartidos con
// VELO Bridge (lib/print-engines.js). Sin impresora: valida lo que se envía.
const assert = require('node:assert/strict');
const { zplProductLabels, isZebraPrinter } = require('../src/js/zpl-labels');
const engines = require('../lib/print-engines');

const zpl = zplProductLabels([{ name: 'Cargador rápido Ñandú 20W', code: 'CAR-20W', barcode: '7461234567890', price: 'RD$850.00', quantity: 3 }],
  { widthMm: 52, heightMm: 28, dpi: 203, showName: true, showCode: true, showBarcode: true, showPrice: true });
assert.match(zpl, /^\^XA\^CI28\^PW416\^LL224/);
assert.ok(zpl.includes('^PQ3,0,1,Y^XZ'));
assert.ok(zpl.includes('r_C3_A1pido _C3_91and_C3_BA'));
assert.ok(engines.validZpl(zpl));
console.log('  ✓ etiqueta 52 × 28 mm a 203 DPI, tildes y cantidad correctas');

const ready = engines.zplWithSettings(zpl, { darkness: 24, speed: 3, dpi: 203 });
assert.ok(ready.startsWith('~SD24\n'));
assert.ok(ready.includes('^XA^PR3^LH0,0^CI28'));
assert.equal(engines.validZpl('^XA^JUS^XZ'), false);
console.log('  ✓ oscuridad y velocidad aplicadas; órdenes de configuración rechazadas');

assert.equal(isZebraPrinter('ZDesigner LP 2824 Plus (ZPL)'), true);
assert.equal(engines.isZebra('ZDesigner LP 2824 Plus (ZPL)'), true);
assert.equal(isZebraPrinter('POS-80C'), false);
const page = engines.pdfPageFor('80mm', 600);
assert.ok(Math.abs(page.width - 80 / 25.4) < 1e-9);
assert.ok(engines.BLACK_WHITE_SCRIPT.includes('color:#000!important'));
console.log('  ✓ Zebra reconocida, papel del PDF en pulgadas y limpieza a negro puro');
