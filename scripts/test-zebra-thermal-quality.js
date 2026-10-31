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

// Mismo plano que VELO Web: vista previa SVG = ZPL; Exhibir una por equipo.
const labels = require('../src/js/zpl-labels');
const fs = require('node:fs');
const path = require('node:path');
const units = [{ id: '1', productId: '9', imei: '356789012345678', capacity: '256GB', batteryHealth: 87 }, { id: '2', productId: '9', imei: '356789012345679', capacity: '128GB', batteryHealth: 92 }];
const exhibir = labels.labelItemsFor('exhibir', [{ id: '9', sku: 'IPHO-13', name: 'IPHONE 13 PRO MAX', price: 'RD$44,444.00', brand: 'APPLE', model: 'A2484', serialized: true }], units, 1);
assert.equal(exhibir.length, 2);
const design = labels.labelDesignFor({ kind: 'exhibir', fields: labels.labelFieldsFor('exhibir'), widthMm: 52, heightMm: 28, dpi: 203 });
const layout = labels.labelLayout(exhibir[0], design);
const exhibirZpl = labels.zplFromLayout(layout);
assert.ok(exhibirZpl.includes('256GB _C2_B7 Bater_C3_ADa 87%'));
assert.ok(!exhibirZpl.includes('^BC'));
assert.ok(engines.validZpl(exhibirZpl));
assert.ok(labels.labelPreviewSvg(layout).includes('viewBox="0 0 416 224"'));
assert.equal(labels.normalizeLabelKind('interno'), 'internal');
assert.equal(labels.normalizeLabelKind('personalizado'), 'custom');
const service = labels.zplFromLayout(labels.serviceLabelLayout({ number: 'OS-000001', customerName: 'PEDRO LOPEZ', customerPhone: '8295778767', deviceDescription: 'CONSOLA', identifier: '0104010101111', password: '', problem: 'MANTENIMIENTO' }, { widthMm: 52, heightMm: 28, dpi: 203 }));
assert.ok(service.includes('OS-000001') && engines.validZpl(service));
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
assert.ok(html.indexOf('js/zpl-labels.js') < html.indexOf('js/label-logo.js') && html.indexOf('js/label-logo.js') < html.indexOf('js/barcode.js'));
const servicio = fs.readFileSync(path.join(__dirname, '../src/js/servicio.js'), 'utf8');
assert.ok(servicio.includes('RECIBO DE SERVICIO TÉCNICO') && servicio.includes('svc-receipt-labor') && servicio.includes('serviceLabelLayout('));
console.log('  ✓ Exhibir por equipo, vista previa = ZPL, logo cargado antes de etiquetas y recibo de servicio técnico');

assert.deepEqual([...engines.escposFeedCut(4)], [0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0x00]);
assert.equal(engines.profileFromCapabilities('POS-80C', 'USB001',
  '<psf:ScoredProperty name="psk:MediaSizeWidth"><psf:Value xsi:type="xsd:integer">80000</psf:Value></psf:ScoredProperty>').escpos, true);
console.log('  ✓ avance y corte ESC/POS y detección de térmica de rollo');
