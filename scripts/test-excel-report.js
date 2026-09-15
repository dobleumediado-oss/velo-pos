#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { createExcelReportBuffer, safeSheetName } = require('../src/main/excel-report');

(async () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'excel.js'), 'utf8');
  assert.ok(!rendererSource.includes('subtree: true'),
    'el exportador no debe observar cada mutación interna de la pantalla');
  const used = new Set();
  assert.strictEqual(safeSheetName('Ventas/Detalle', used), 'Ventas Detalle');
  assert.strictEqual(safeSheetName('Ventas/Detalle', used), 'Ventas Detalle 2');

  const buffer = await createExcelReportBuffer({
    title: 'Reporte financiero',
    company: 'Comercial Demo, SRL',
    subtitle: 'Septiembre 2026',
    generatedAt: '2026-09-14 11:45',
    sheets: [{
      name: 'Ventas/Detalle',
      columns: [
        { header: 'Fecha' }, { header: 'Cliente' }, { header: 'Total' }, { header: 'Margen' },
      ],
      rows: [
        { cells: [
          { value: '2026-09-14', type: 'date' },
          { value: 'Cliente Uno', type: 'text' },
          { value: 1250.5, type: 'currency' },
          { value: 0.325, type: 'percent' },
        ] },
        { total: true, cells: [
          { value: 'TOTAL', type: 'text', bold: true },
          { value: '', type: 'text' },
          { value: 1250.5, type: 'currency', bold: true },
          { value: 0.325, type: 'percent' },
        ] },
      ],
    }, {
      name: 'Ventas/Detalle',
      columns: [{ header: 'Estado' }, { header: 'Cantidad' }],
      rows: [{ cells: [
        { value: 'Vencido', type: 'text', status: 'danger' },
        { value: 3, type: 'integer' },
      ] }],
    }],
  });

  assert(buffer.length > 5000, 'el XLSX debe contener un libro real');
  assert.strictEqual(buffer.subarray(0, 2).toString(), 'PK', 'XLSX debe ser un contenedor ZIP válido');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepStrictEqual(workbook.worksheets.map(sheet => sheet.name), ['Ventas Detalle', 'Ventas Detalle 2']);
  const detail = workbook.getWorksheet('Ventas Detalle');
  assert.strictEqual(detail.getCell('A7').value, 'Fecha');
  assert(detail.getCell('A8').value instanceof Date, 'las fechas deben conservar tipo fecha');
  assert.strictEqual(detail.getCell('C8').value, 1250.5, 'la moneda debe conservar tipo numérico');
  assert(detail.getCell('C8').numFmt.includes('RD$'), 'la moneda debe tener formato RD$');
  assert.strictEqual(detail.getCell('D8').value, 0.325, 'el porcentaje debe conservar su valor decimal');
  assert.strictEqual(detail.views[0].ySplit, 7, 'debe congelar el encabezado');
  assert(detail.autoFilter, 'debe incluir autofiltros');
  assert.strictEqual(detail.getCell('A9').font.bold, true, 'la fila total debe resaltarse');
  assert.strictEqual(workbook.getWorksheet('Ventas Detalle 2').getCell('A8').font.color.argb, 'B91C1C');

  console.log('✓ XLSX profesional: tipos, estilos, filtros, hojas y totales verificados');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
