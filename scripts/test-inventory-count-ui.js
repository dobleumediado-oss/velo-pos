#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: Boolean(process.env.VELO_COUNT_PREVIEW_PATH),
    width: 1440,
    height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body><div id="inv-table-wrap"></div></body></html>');
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '..', 'src/css/styles.css'), 'utf8'));
    await win.webContents.executeJavaScript(`
      window.user = { id: 1 };
      window.CFG = { biz: 'Prueba' };
      window.searchNorm = value => String(value || '').toLowerCase();
      window.matchText = (value, query) => String(value || '').toLowerCase().includes(query);
      window.toast = () => {};
      window.__confirmCalls = [];
      window.api = { inventoryCount: {
        confirmLine: async data => {
          window.__confirmCalls.push(data);
          return { ok: true, data: {
            id: data.lineId, counted_qty: Number(data.qty), counted_cost: Number(data.cost),
            present: data.present ? 1 : 0, confirmed: 1,
          } };
        },
      } };
      true;
    `);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/js/inventario.js'), 'utf8');
    await win.webContents.executeJavaScript(`${source}\n;true;`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      invTab = 'conteo';
      invCountState = { session: { id: 7 }, lines: [
        { id: 1, kind: 'product', product_id: 1, product_code: 'A', product_name: 'Aceite',
          product_unit: 'und', snapshot_qty: 0, snapshot_cost: 100, counted_qty: 0,
          counted_cost: 100, present: 1, confirmed: 0 },
        { id: 2, kind: 'unit', product_id: 2, unit_id: 12, product_code: 'T',
          product_name: 'Celular', imei: '123456789012345', snapshot_qty: 1,
          snapshot_cost: 400, snapshot_missing: 0, counted_qty: 1,
          counted_cost: 400, present: 1, confirmed: 0 },
        { id: 3, kind: 'empty_serial', product_id: 3, product_code: 'V',
          product_name: 'Modelo vacío', snapshot_qty: 0, snapshot_cost: 0,
          counted_qty: 0, counted_cost: 0, present: 1, confirmed: 0 },
      ] };
      paintInvCount();
      const rows = document.querySelectorAll('[data-count-line]');
      const zeroVisible = rows[0].querySelector('[data-count-field="qty"]').value === '0';
      const emptyVisible = rows[2].textContent.includes('sin equipos en stock');
      rows[0].querySelector('[data-count-field="qty"]').value = '4';
      rows[0].querySelector('[data-count-field="qty"]').dispatchEvent(new Event('input', { bubbles: true }));
      rows[0].querySelector('[data-count-field="cost"]').value = '120';
      rows[0].querySelector('[data-count-field="cost"]').dispatchEvent(new Event('input', { bubbles: true }));
      const blockedDirty = document.getElementById('inv-count-apply').disabled;
      rows[0].querySelector('[data-count-action="confirm"]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector('[data-count-line="2"] [data-count-field="present"]').click();
      const missingCostLocked = document.querySelector('[data-count-line="2"] [data-count-field="cost"]').disabled;
      document.querySelector('[data-count-line="2"] [data-count-action="confirm"]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector('[data-count-line="3"] [data-count-action="confirm"]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { zeroVisible, emptyVisible, blockedDirty, missingCostLocked,
        count: window.__confirmCalls.length,
        firstQty: window.__confirmCalls[0]?.qty,
        firstCost: window.__confirmCalls[0]?.cost,
        secondPresent: window.__confirmCalls[1]?.present,
        applyEnabled: !document.getElementById('inv-count-apply').disabled,
      };
    })()`);
    assert.equal(result.zeroVisible, true, 'la cantidad cero debe verse en el formulario');
    assert.equal(result.emptyVisible, true, 'un modelo sin IMEI se puede confirmar');
    assert.equal(result.blockedDirty, true, 'un cambio sin confirmar bloquea aplicar');
    assert.equal(result.missingCostLocked, true, 'el costo de un IMEI faltante queda bloqueado');
    assert.equal(result.count, 3);
    assert.equal(result.firstQty, '4');
    assert.equal(result.firstCost, '120');
    assert.equal(result.secondPresent, false, 'el IMEI se puede marcar faltante');
    assert.equal(result.applyEnabled, true, 'aplicar se habilita cuando todo está confirmado');
    if (process.env.VELO_COUNT_PREVIEW_PATH) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(process.env.VELO_COUNT_PREVIEW_PATH, screenshot.toPNG());
      console.log(`Vista del conteo: ${process.env.VELO_COUNT_PREVIEW_PATH}`);
    }
    console.log('✓ Interfaz de conteo: cantidades cero, IMEI faltante, confirmación y bloqueo de cambios sin guardar');
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
