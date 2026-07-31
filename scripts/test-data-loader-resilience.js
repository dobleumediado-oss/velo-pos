#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'data.js'), 'utf8');
const context = {
  console, Date, Math, Promise, setTimeout, clearTimeout,
  window: {},
};
context.window = context;
context.window.api = {
  products: { getAll: async () => [{ id: 1, name: 'Producto estable' }] },
  settings: { getAll: async () => ({ biz_name: 'NEGOCIO PRUEBA', tax_pct: '18' }) },
  business: { getActive: async () => ({ data: null }) },
  customers: {
    getAll: async () => { throw new Error('clientes temporalmente fuera'); },
    getAllPayments: async () => [{ id: 91, amount: 50, status: 'active' }],
  },
  cash: { getOpen: async () => null, getSessions: async () => [] },
  users: { getAll: async () => [] },
  sales: { getAll: async () => [] },
  salespeople: { getAll: async () => ({ ok: true, data: [] }) },
  categories: { getAll: async () => ({ ok: true, data: [] }) },
  financial: { getAll: async () => ({ ok: true, data: [] }) },
  app: { getTerminalInfo: async () => ({ terminalId: 'test' }) },
};
vm.createContext(context);
vm.runInContext(`${source}\nthis.__loader={loadAppData,snapshot:()=>({
  products:DB.products,customers:DB.customers,payments:DB.payments
})};`, context, { filename: 'data.js' });

(async () => {
  await context.__loader.loadAppData();
  await new Promise(resolve => setTimeout(resolve, 0));
  const partial = context.__loader.snapshot();
  assert.strictEqual(partial.products.length, 1,
    'la fase crítica debe cargar productos');
  assert.strictEqual(partial.payments.length, 1,
    'un fallo de clientes no debe descartar los abonos cargados');
  console.log('  ✓ las consultas secundarias fallan de forma independiente');

  let resolveOld;
  let productCall = 0;
  context.window.api.products.getAll = () => {
    productCall += 1;
    if (productCall === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.resolve([{ id: 2, name: 'Snapshot nuevo' }]);
  };
  const oldLoad = context.__loader.loadAppData();
  const newLoad = context.__loader.loadAppData();
  await newLoad;
  resolveOld([{ id: 3, name: 'Snapshot viejo' }]);
  await oldLoad;
  assert.strictEqual(context.__loader.snapshot().products[0].id, 2,
    'una respuesta antigua no debe sobrescribir la recarga más reciente');
  console.log('  ✓ las recargas concurrentes descartan snapshots obsoletos');
  console.log('\nCarga inicial resiliente verificada.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
