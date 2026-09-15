#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  let stage = 'load';
  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body><div id="root"></div></body></html>');
    stage = 'bootstrap';
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'excel.js'), 'utf8');
    assert.ok(!source.includes('subtree: true'), 'el exportador no debe observar cada mutación interna de la pantalla');
    await win.webContents.executeJavaScript(`
      window.CFG = { biz: 'Empresa Demo' };
      window.today = () => '2026-09-14';
      window.nowt = () => '11:45';
      window.toast = () => {};
      window.svg = () => '';
      window.__excelPayload = null;
      window.api = { excel: { saveReport: async payload => {
        window.__excelPayload = payload;
        return { ok: true, path: 'demo.xlsx' };
      } } };
      true;
    `);
    stage = 'excel-source';
    await win.webContents.executeJavaScript(`${source}\n;true;`);
    stage = 'convert';
    const payloadJson = await win.webContents.executeJavaScript(`
      _exportHTMLToExcel(\`
        <html><body>
          <h2>Ventas por cliente</h2><div class="sub">Septiembre 2026</div>
          <div class="metrics"><div class="met"><div class="met-l">Ingresos</div><div class="met-v">RD$1,250.50</div></div></div>
          <h3>Detalle</h3><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Total</th><th>Margen</th></tr></thead>
          <tbody><tr><td>14 sept de 2026</td><td>Cliente Uno</td><td>RD$1,250.50</td><td>32.5%</td></tr></tbody></table>
        </body></html>
      \`, { suggestedName: 'Ventas' }).then(() => JSON.stringify(window.__excelPayload))
    `);
    const payload = JSON.parse(payloadJson);
    assert.strictEqual(payload.company, 'Empresa Demo');
    assert.strictEqual(payload.sheets.length, 2, 'debe separar resumen y detalle');
    assert.strictEqual(payload.sheets[0].rows[0].cells[1].type, 'currency');
    assert.strictEqual(payload.sheets[1].rows[0].cells[0].type, 'date');
    assert.strictEqual(payload.sheets[1].rows[0].cells[0].value, '2026-09-14');
    assert.strictEqual(payload.sheets[1].rows[0].cells[2].value, 1250.5);
    assert.strictEqual(payload.sheets[1].rows[0].cells[3].type, 'percent');
    console.log('✓ Conversión de reportes HTML a hojas Excel tipadas verificada');
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
