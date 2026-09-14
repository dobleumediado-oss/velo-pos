'use strict';

const ExcelJS = require('exceljs');

const MAX_SHEETS = 20;
const MAX_COLUMNS = 60;
const MAX_ROWS = 100000;
const MAX_CELL_CHARS = 32000;
const BRAND = '0F766E';
const HEADER = '111827';
const LIGHT = 'F0FDFA';
const LINE = 'D1D5DB';

function cleanText(value, max = MAX_CELL_CHARS) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
}

function safeSheetName(value, used) {
  const base = cleanText(value || 'Reporte', 31).replace(/[\\/*?:\[\]]/g, ' ').trim() || 'Reporte';
  let name = base;
  let index = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` ${index++}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function localDate(value) {
  const match = cleanText(value, 40).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const date = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeCell(raw) {
  const cell = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
  const type = cleanText(cell.type || 'text', 20).toLowerCase();
  let value = cell.value;
  let numFmt = '';
  if (type === 'currency') {
    value = Number(value);
    value = Number.isFinite(value) ? value : 0;
    numFmt = '"RD$"#,##0.00;[Red]-"RD$"#,##0.00';
  } else if (type === 'usd') {
    value = Number(value);
    value = Number.isFinite(value) ? value : 0;
    numFmt = '"US$"#,##0.00;[Red]-"US$"#,##0.00';
  } else if (type === 'number' || type === 'integer') {
    value = Number(value);
    value = Number.isFinite(value) ? value : 0;
    numFmt = type === 'integer' ? '#,##0' : '#,##0.00';
  } else if (type === 'percent') {
    value = Number(value);
    value = Number.isFinite(value) ? value : 0;
    numFmt = '0.0%';
  } else if (type === 'date' || type === 'datetime') {
    value = localDate(value) || cleanText(value);
    numFmt = value instanceof Date ? (type === 'datetime' ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy') : '';
  } else if (type === 'boolean') {
    value = !!value;
  } else {
    value = cleanText(value);
  }
  return { value, numFmt, bold: !!cell.bold, status: cleanText(cell.status || '', 20).toLowerCase() };
}

function styleSheet(sheet, title, company, subtitle, generatedAt, columnCount) {
  sheet.views = [{ state: 'frozen', ySplit: 7, showGridLines: false }];
  sheet.properties.defaultRowHeight = 18;
  sheet.pageSetup = {
    orientation: columnCount > 7 ? 'landscape' : 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
  };
  sheet.getCell('A2').value = cleanText(title || 'Reporte', 240);
  sheet.getCell('A2').font = { name: 'Arial', size: 15, bold: true, color: { argb: HEADER } };
  sheet.getCell('A3').value = cleanText(company || '', 240);
  sheet.getCell('A3').font = { name: 'Arial', size: 10, bold: true, color: { argb: BRAND } };
  sheet.getCell('A4').value = cleanText(subtitle || '', 500);
  sheet.getCell('A4').font = { name: 'Arial', size: 9, italic: true, color: { argb: '6B7280' } };
  sheet.getCell('A5').value = `Generado: ${cleanText(generatedAt || new Date().toISOString(), 80)}`;
  sheet.getCell('A5').font = { name: 'Arial', size: 9, color: { argb: '6B7280' } };
  sheet.getRow(6).height = 8;
}

function buildExcelReport(payload = {}) {
  const inputSheets = Array.isArray(payload.sheets) ? payload.sheets.slice(0, MAX_SHEETS) : [];
  if (!inputSheets.length) throw new Error('El reporte no contiene tablas para exportar');
  const totalRows = inputSheets.reduce((sum, item) => sum + (Array.isArray(item?.rows) ? item.rows.length : 0), 0);
  if (totalRows > MAX_ROWS) throw new Error(`El reporte supera el límite de ${MAX_ROWS.toLocaleString()} filas`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'VELO POS';
  workbook.company = cleanText(payload.company || 'VELO POS', 240);
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  const usedNames = new Set();

  inputSheets.forEach((input, sheetIndex) => {
    const columns = (Array.isArray(input?.columns) ? input.columns : []).slice(0, MAX_COLUMNS);
    if (!columns.length) return;
    const sheet = workbook.addWorksheet(safeSheetName(input.name || `Reporte ${sheetIndex + 1}`, usedNames), {
      properties: { tabColor: { argb: sheetIndex === 0 ? HEADER : BRAND } },
    });
    styleSheet(
      sheet,
      input.title || payload.title || input.name,
      payload.company,
      input.subtitle || payload.subtitle,
      payload.generatedAt,
      columns.length
    );

    const headerRow = sheet.getRow(7);
    headerRow.values = columns.map(column => cleanText(column?.header || column?.key || '', 200));
    headerRow.height = 24;
    headerRow.eachCell(cell => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: BRAND } } };
    });

    const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, MAX_ROWS);
    rows.forEach((inputRow, rowIndex) => {
      const rawCells = Array.isArray(inputRow?.cells) ? inputRow.cells : (Array.isArray(inputRow) ? inputRow : []);
      const normalized = columns.map((_, columnIndex) => normalizeCell(rawCells[columnIndex]));
      const row = sheet.addRow(normalized.map(cell => cell.value));
      const isTotal = !!inputRow?.total;
      row.height = 20;
      row.eachCell({ includeEmpty: true }, (cell, columnIndex) => {
        const info = normalized[columnIndex - 1];
        cell.font = { name: 'Arial', size: 10, bold: isTotal || info.bold, color: { argb: HEADER } };
        cell.alignment = {
          vertical: 'middle',
          horizontal: info.numFmt ? 'right' : 'left',
          wrapText: false,
        };
        if (info.numFmt) cell.numFmt = info.numFmt;
        cell.border = { bottom: { style: 'hair', color: { argb: LINE } } };
        if (isTotal) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E5E7EB' } };
        else if (rowIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F9FAFB' } };
        if (info.status === 'danger') {
          cell.font = { ...cell.font, bold: true, color: { argb: 'B91C1C' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF2F2' } };
        } else if (info.status === 'warning') {
          cell.font = { ...cell.font, bold: true, color: { argb: 'B45309' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBEB' } };
        } else if (info.status === 'success') {
          cell.font = { ...cell.font, bold: true, color: { argb: '047857' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
        }
      });
    });

    const lastRow = Math.max(7, sheet.rowCount);
    const lastColumn = columns.length;
    if (rows.length) {
      sheet.autoFilter = { from: { row: 7, column: 1 }, to: { row: lastRow, column: lastColumn } };
    }
    columns.forEach((column, index) => {
      let width = Math.max(10, Math.min(45, Number(column?.width) || cleanText(column?.header || '').length + 3));
      const sampleEnd = Math.min(lastRow, 207);
      for (let row = 8; row <= sampleEnd; row += 1) {
        const value = sheet.getCell(row, index + 1).value;
        const text = value instanceof Date ? '00/00/0000' : cleanText(value, 120);
        width = Math.max(width, Math.min(45, text.length + 2));
      }
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(1).width = Math.max(sheet.getColumn(1).width || 0, 14);
    sheet.headerFooter.oddFooter = '&LVELO POS&C&P de &N&R&D &T';
  });

  if (!workbook.worksheets.length) throw new Error('El reporte no contiene columnas exportables');
  return workbook;
}

async function createExcelReportBuffer(payload) {
  const workbook = buildExcelReport(payload);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildExcelReport, createExcelReportBuffer, safeSheetName, normalizeCell };
