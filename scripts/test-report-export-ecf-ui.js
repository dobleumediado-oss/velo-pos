#!/usr/bin/env node
'use strict';

// Regresión de dos fallos vistos en Desktop 1.66.3:
//  1. Excel/PDF del reporte financiero solo llevaban las 1,000 facturas más
//     recientes (un período 2022→hoy llegaba desde 2024).
//  2. La configuración e-CF se caía a mitad de dibujarse con la respuesta de
//     un Servidor anterior y "Guardar configuración" quedaba sin acción.
// Corre el código real de reportes.js, excel.js y renderECFConfig (config.js)
// en una ventana de Electron con la API simulada. No usa ninguna base de datos.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function ecfSource() {
  const source = read('src/js/config.js');
  const start = source.indexOf('async function renderECFConfig(');
  const end = source.indexOf('\n// Encender o apagar Preventa', start);
  assert.ok(start > 0 && end > start, 'no se encontró renderECFConfig en config.js');
  return source.slice(start, end);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  let stage = 'load';
  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body><div id="page"></div><div id="ecf"></div></body></html>');
    stage = 'stubs';
    await win.webContents.executeJavaScript(`
      window.CFG = { biz: 'Empresa Demo', rnc: '000000000', phone: '', addr: '', itbis: 18 };
      window.DB = { products: [], settings: {} };
      window.user = { id: 1, role: 'admin' };
      window.today = () => '2026-11-16';
      window.nowt = () => '04:46 p. m.';
      window.fdate = value => String(value || '');
      window.fmt = value => 'RD$' + Number(value || 0).toFixed(2);
      window._esc = value => String(value == null ? '' : value);
      window.svg = () => '';
      window.h = () => document.createElement('div');
      window.facturaLabel = row => '#' + row.id;
      window.toasts = [];
      window.toast = (message, type) => window.toasts.push({ message, type });
      window.printed = [];
      window.printHTML = (html, category, options) => window.printed.push({ html, category, options });
      window._cfgUser = () => ({ id: 1, role: 'admin' });
      // Espera con límite: si el archivo nunca se genera, la prueba falla en
      // vez de quedarse colgada.
      window.waitFor = (check, label, ms = 10000) => new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (check()) { clearInterval(timer); resolve(true); }
          else if (Date.now() - started > ms) { clearInterval(timer); reject(new Error(label)); }
        }, 20);
      });
      true;
    `);
    stage = 'sources';
    await win.webContents.executeJavaScript(`${read('src/js/excel.js')}\n;true;`);
    await win.webContents.executeJavaScript(`${read('src/js/reportes.js')}\n;true;`);
    await win.webContents.executeJavaScript(`${ecfSource()}\n;true;`);

    stage = 'report-data';
    await win.webContents.executeJavaScript(`
      const makeRows = count => Array.from({ length: count }, (_, i) => ({
        id: i + 1, sale_date: i < count - 1 ? '2026-01-10' : '2022-01-03', customer_name: 'Cliente ' + i,
        customer_type: 'person', price_mode: 'retail', payment_method: 'efectivo', total: 118, tax_amt: 18,
      }));
      window.makeReport = (rows, total) => ({
        totalRev: 0, totalCost: 0, grossProfit: 0, margin: 0, totalTax: 0, totalDisc: 0,
        totalSales: total, totalUnits: 0, byMethod: [], topProducts: [], priceChanges: [], topCustomers: [],
        salesDetail: makeRows(rows), salesDetailTotal: total, filters: {},
      });
      window.summaryCalls = [];
      window.api = {
        excel: { saveReport: async payload => { window.excelPayload = payload; return { ok: true }; } },
        reports: { summary: async payload => {
          window.summaryCalls.push(payload);
          return { ok: true, data: makeReport(payload.fullDetail === true ? 2266 : 1000, 2266) };
        } },
      };
      repTab = 'financiero';
      repRange = 'custom'; repDateFrom = '2022-01-01'; repDateTo = '2026-11-16';
      repData = makeReport(1000, 2266);
      repDataRequest = { range: 'custom', dateFrom: '2022-01-01', dateTo: '2026-11-16', priceMode: 'all', customerType: 'all', requestUserId: 1 };
      true;
    `);

    stage = 'excel';
    await win.webContents.executeJavaScript(`
      guardarDocumentoExcel(exportReporteActualPDF, 'Reporte-financiero', 'Reportes');
      waitFor(() => window.excelPayload, 'el Excel no se generó');
    `);
    const excel = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
      calls: window.summaryCalls,
      sheet: window.excelPayload.sheets.find(sheet => sheet.name === 'Facturas del segmento'),
    })`));
    assert.strictEqual(excel.calls.length, 1, 'el Excel debe pedir el detalle completo una vez');
    assert.strictEqual(excel.calls[0].fullDetail, true, 'el Excel pide fullDetail');
    assert.strictEqual(excel.calls[0].dateFrom, '2022-01-01', 'el Excel usa los mismos filtros que la pantalla');
    assert.strictEqual(excel.sheet.rows.length, 2266, 'el Excel lleva las 2,266 facturas del período');
    assert.strictEqual(excel.sheet.rows.at(-1).cells[0].value, '2022-01-03', 'el Excel llega hasta 2022');
    console.log('✓ Excel del reporte financiero con todas las facturas del período');

    stage = 'pdf';
    await win.webContents.executeJavaScript(`window.summaryCalls = []; _repGuardarPDF();`);
    const pdf = JSON.parse(await win.webContents.executeJavaScript(`
      waitFor(() => window.printed.length, 'el PDF no se generó').then(() => JSON.stringify({
        category: window.printed[0].category, options: window.printed[0].options,
        rows: (window.printed[0].html.match(/<td>2026-01-10<\\/td>|<td>2022-01-03<\\/td>/g) || []).length,
        calls: window.summaryCalls.length,
      }))
    `));
    assert.strictEqual(pdf.calls, 1, 'el PDF pide el detalle completo');
    assert.strictEqual(pdf.category, 'reporte', 'el PDF conserva la categoría de reporte (papel y plantilla)');
    assert.deepStrictEqual(pdf.options, { mode: 'pdf', suggestedName: 'Reporte-financiero' });
    assert.strictEqual(pdf.rows, 2266, 'el PDF lleva las 2,266 facturas');
    console.log('✓ PDF del reporte financiero con todas las facturas y como trabajo de reporte');

    stage = 'complete-no-refetch';
    const noRefetch = await win.webContents.executeJavaScript(`
      window.summaryCalls = []; repData = makeReport(40, 40);
      exportReporteActualPDF().then(html => ({ calls: window.summaryCalls.length, note: /más recientes/.test(html) }));
    `);
    assert.deepStrictEqual(noRefetch, { calls: 0, note: false }, 'si la pantalla ya tiene todo, no vuelve a consultar ni avisa');

    stage = 'truncation-note';
    const note = await win.webContents.executeJavaScript(`
      ({ capped: /Se muestran las 50,000 facturas más recientes de 60,000/.test(exportReportePDF(makeReport(50000, 60000), { returnHtml: true })),
         oldServer: /actualiza el Servidor/.test(exportReportePDF({ ...makeReport(1000, 0), salesDetailTotal: undefined }, { returnHtml: true })) })
    `);
    assert.deepStrictEqual(note, { capped: true, oldServer: true }, 'el documento avisa si no lleva todas las facturas');
    console.log('✓ El documento avisa cuando no caben todas las facturas');

    stage = 'ecf-old-server';
    const oldServer = await win.webContents.executeJavaScript(`
      window.ecfSaves = [];
      window.api.ecf = {
        getConfig: async () => ({ ok: true, data: { email: 'x@example.test', hasPassword: false, apiKey: '', environment: 'production' } }),
        saveConfig: async payload => { window.ecfSaves.push(payload); return { ok: true }; },
      };
      renderECFConfig(document.getElementById('ecf')).then(() => ({
        warning: /versión anterior/.test(document.getElementById('ecf').textContent),
        saveButton: !!document.getElementById('btn-save-ecf'),
        password: !!document.getElementById('ecf-pass'),
      }));
    `);
    assert.deepStrictEqual(oldServer, { warning: true, saveButton: false, password: false },
      'con un Servidor anterior se avisa y no se ofrece guardar');
    console.log('✓ e-CF con Servidor anterior: aviso claro y sin guardado que borre credenciales');

    stage = 'ecf-current';
    const current = await win.webContents.executeJavaScript(`
      window.toasts = [];
      window.ecfConfig = { email: '', environment: 'test', enabled: false, hasPassword: false, hasApiKey: false, incomeType: '01',
        ranges: [{ first_ncf: 'E310000000001', last_ncf: null, issuer_rnc: '000000000', expiry_date: '2027-12-31', next_number: 1 }] };
      window.api.ecf = {
        getConfig: async () => ({ ok: true, data: window.ecfConfig }),
        saveConfig: async payload => {
          window.ecfSaves.push(payload);
          if (!payload.password) return { ok: false, error: 'Ingresa las credenciales para la cuenta y el ambiente nuevos.' };
          window.ecfConfig = { ...window.ecfConfig, email: payload.email, environment: payload.environment, hasPassword: true, hasApiKey: true };
          return { ok: true };
        },
      };
      (async () => {
        const box = document.getElementById('ecf');
        await renderECFConfig(box);
        const income = box.querySelector('#ecf-income').value;
        box.querySelector('#ecf-email').value = 'cuenta@example.test';
        box.querySelector('#ecf-env').value = 'production';
        await box.querySelector('#btn-save-ecf').onclick({ currentTarget: box.querySelector('#btn-save-ecf') });
        const failed = window.toasts.at(-1);
        box.querySelector('#ecf-pass').value = 'valor-ficticio';
        box.querySelector('#ecf-apikey').value = 'llave-ficticia';
        await box.querySelector('#btn-save-ecf').onclick({ currentTarget: box.querySelector('#btn-save-ecf') });
        return {
          income, failed, saved: window.toasts.at(-1),
          incomeSent: window.ecfSaves.at(-1).incomeType,
          placeholder: box.querySelector('#ecf-pass').placeholder,
          rangeText: box.querySelector('#ecf-ranges li').textContent.includes('0 disponibles'),
        };
      })();
    `);
    assert.strictEqual(current.income, '01', 'el tipo de ingresos queda seleccionado');
    assert.deepStrictEqual(current.failed, { message: 'Ingresa las credenciales para la cuenta y el ambiente nuevos.', type: 'err' },
      'un guardado rechazado se ve como aviso');
    assert.deepStrictEqual(current.saved, { message: 'Configuración guardada.', type: 'ok' }, 'el guardado correcto se confirma');
    assert.strictEqual(current.incomeSent, '01', 'se envía el tipo de ingresos');
    assert.ok(/Guardada/.test(current.placeholder), 'tras guardar, la contraseña aparece como guardada');
    assert.ok(current.rangeText, 'un rango incompleto no rompe la pantalla');
    console.log('✓ e-CF: botones conectados aunque un rango venga incompleto, y resultado visible');
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
