#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log('  ✓', message); }
  else { fail++; console.error('  ✗', message); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(addPayment, options = {}) {
  let modalOpen = true;
  const storage = options.storage || new Map();
  const printed = [];
  const toasts = [];
  const failures = [];
  const button = {
    dataset: { operationId: options.operationId || 'payment:77:ui-test' },
    disabled: false,
    innerHTML: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
  };
  const fields = {
    'ab-amount': { value: '100' },
    'ab-method': { value: 'efectivo' },
    'ab-note': { value: '' },
    'ab-financial-account': null,
    'ab-exchange-rate': null,
    'ab-contact': null,
    'ab-allocation-summary': { dataset: { valid: '1' } },
    'btn-abono': button,
    page: {},
  };
  const refreshCustomers = deferred();
  const refreshPayments = deferred();
  const refreshSales = deferred();
  const context = {
    console,
    Date,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    page: 'clientes',
    user: { id: 9, name: 'CAJERO PRUEBA', role: 'cajero' },
    DB: {
      customers: [{ id: 77, name: 'CLIENTE PRUEBA', rnc: '001', phone: '18095550000', balance: 200 }],
      payments: [],
      financialAccounts: [],
    },
    document: {
      getElementById(id) {
        if (id === 'btn-abono' && !modalOpen) return null;
        return fields[id] || null;
      },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    },
    fmt: value => `RD$${Number(value).toFixed(2)}`,
    svg: name => `<${name}>`,
    toast: (message, tone) => toasts.push({ message, tone }),
    facturaLabel: sale => sale.document_number_fmt || `#${sale.id}`,
    printAbono: payload => printed.push(payload),
    closeModal: () => { modalOpen = false; },
    renderClientes: () => {},
    buildSidebar: () => {},
    reloadCustomers: () => refreshCustomers.promise,
    reloadPayments: () => refreshPayments.promise,
    reloadSales: () => refreshSales.promise,
  };
  context.window = context;
  context.window.crypto = { randomUUID: () => 'uuid-test' };
  context.window.localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  context.window.api = {
    customers: {
      addPayment,
      ...(options.getPaymentByOperation
        ? { getPaymentByOperation: options.getPaymentByOperation }
        : {}),
    },
    log: { error: () => Promise.resolve() },
  };
  context.window.VeloExperience = {
    rememberFailure: failure => failures.push(failure),
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'clientes.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'clientes.js' });
  return {
    context, button, printed, toasts, failures, storage,
    refreshCustomers, refreshPayments, refreshSales,
    reopen: () => { modalOpen = true; },
  };
}

(async () => {
  console.log('\nFlujo visual resiliente de abonos');

  const success = createHarness(async () => ({
    ok: true,
    paymentId: 501,
    amount: 100,
    before: 200,
    after: 100,
    document_number_fmt: 'ABO-000501',
    allocations: [],
  }));
  await success.context.registrarAbono(77, 200, null);
  ok(success.printed.length === 1,
    'abre el display del recibo sin esperar las recargas secundarias');
  ok(success.context.DB.payments.length === 1
    && success.context.DB.customers[0].balance === 100,
    'refleja el abono y el nuevo balance inmediatamente en memoria');
  ok(success.button.disabled === true,
    'el formulario confirmado se cerró antes de que una recarga lenta pueda reactivarlo');
  success.refreshCustomers.resolve([]);
  success.refreshPayments.resolve([]);
  success.refreshSales.resolve([]);
  await Promise.resolve();

  const networkError = createHarness(async () => {
    const error = new Error('SERVER_OFFLINE');
    error.offline = true;
    throw error;
  });
  await networkError.context.registrarAbono(77, 200, null);
  ok(networkError.button.disabled === false && !networkError.button.attrs['aria-busy'],
    'libera siempre el botón cuando la respuesta falla');
  ok(networkError.failures.some(item => item.retryKey === 'payment:payment:77:ui-test'),
    'conserva una operación recuperable con la misma clave idempotente');

  const gate = deferred();
  let calls = 0;
  const doubleClick = createHarness(() => { calls++; return gate.promise; });
  const first = doubleClick.context.registrarAbono(77, 200, null);
  const second = doubleClick.context.registrarAbono(77, 200, null);
  ok(calls === 1, 'ignora el doble clic mientras el primer abono está en curso');
  gate.resolve({ ok:false, error:'rechazo de prueba' });
  await Promise.all([first, second]);
  ok(doubleClick.button.disabled === false,
    'restaura el control también después de un rechazo del backend');

  const neverReturns = createHarness(() => new Promise(() => {}));
  neverReturns.context.window.__VELO_TEST_PAYMENT_TIMEOUT_MS = 15;
  await neverReturns.context.registrarAbono(77, 200, null);
  ok(neverReturns.button.disabled === false
    && neverReturns.toasts.some(item => item.message.includes('misma operación')),
    'un backend que no responde libera la pantalla y ofrece reintento seguro');

  const recovered = createHarness(
    () => new Promise(() => {}),
    {
      getPaymentByOperation: async request => ({
        ok: true,
        found: true,
        idempotent: true,
        paymentId: 777,
        amount: 100,
        before: 200,
        after: 100,
        document_number_fmt: 'ABO-000777',
        operation_id: request.operationId,
        allocations: [],
      }),
    }
  );
  recovered.context.window.__VELO_TEST_PAYMENT_TIMEOUT_MS = 15;
  await recovered.context.registrarAbono(77, 200, null);
  ok(recovered.printed.length === 1 && recovered.context.DB.payments[0]?.id === 777,
    'recupera un abono confirmado cuando se pierde la primera respuesta');

  const sharedStorage = new Map();
  const ambiguous = createHarness(async () => {
    const error = new Error('SERVER_OFFLINE');
    error.offline = true;
    throw error;
  }, { storage: sharedStorage, operationId: 'payment:77:pending-original' });
  await ambiguous.context.registrarAbono(77, 200, null);
  let retriedOperation = '';
  const retryAfterReopen = createHarness(async request => {
    retriedOperation = request.data.operationId;
    return {
      ok: true, paymentId: 778, amount: 100, before: 200, after: 100,
      document_number_fmt: 'ABO-000778', allocations: [],
    };
  }, { storage: sharedStorage, operationId: 'payment:77:new-modal-operation' });
  await retryAfterReopen.context.registrarAbono(77, 200, null);
  ok(retriedOperation === 'payment:77:pending-original',
    'reabrir el formulario conserva la operación ambigua y evita duplicarla');
  ok(sharedStorage.size === 0,
    'elimina la recuperación pendiente después de una confirmación definitiva');

  const cancelContext = {
    console, Date, Math, Promise, setTimeout, clearTimeout,
    window: {
      __VELO_TEST_PAYMENT_TIMEOUT_MS: 15,
      api: { customers: {
        cancelPayment: () => new Promise(() => {}),
        getPaymentStatus: async () => ({
          ok: true, found: true, id: 501, status: 'cancelled',
          customerId: 77, restoredBalance: 200,
        }),
      } },
    },
    CFG: { itbis: 18 },
  };
  cancelContext.window.window = cancelContext.window;
  vm.createContext(cancelContext);
  const ventasSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ventas.js'), 'utf8');
  vm.runInContext(ventasSource, cancelContext, { filename: 'ventas.js' });
  const recoveredCancellation = await cancelContext.ventasCancelPaymentWithRecovery({
    id: 501, reason: 'Monto incorrecto', requestUserId: 9,
  });
  ok(recoveredCancellation?.ok && recoveredCancellation?.recovered
    && recoveredCancellation.status === 'cancelled',
  'recupera una anulación confirmada aunque se pierda su respuesta inicial');

  cancelContext.window.api.sales = {
    create: () => new Promise(() => {}),
    getByOperation: async () => ({
      ok: true, found: true, saleId: 779, total: 750,
      documentNumberFmt: 'FAC-000779',
    }),
  };
  const recoveredConversion = await cancelContext.ventasCreateSaleWithRecovery({
    operationId: 'sale:quote:44:test', customer:{id:1}, items:[], payment:{}, type:'factura',
  }, 9);
  ok(recoveredConversion?.ok && recoveredConversion?.recovered && recoveredConversion.saleId === 779,
    'convertir una cotización recupera la venta si se pierde la respuesta');

  const saleContext = {
    console, Date, Math, Promise, setTimeout, clearTimeout,
    CFG: { itbis: 18 }, DB: {},
    window: {
      __VELO_TEST_SALE_TIMEOUT_MS: 15,
      api: {
        sales: {
          create: () => new Promise(() => {}),
          getByOperation: async () => ({
            ok: true, found: true, idempotent: true,
            saleId: 880, total: 500, documentNumberFmt: 'FAC-000880',
          }),
        },
        checkout: { pay: async () => ({ ok: false }) },
      },
    },
  };
  vm.createContext(saleContext);
  const posSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'pos.js'), 'utf8');
  vm.runInContext(posSource, saleContext, { filename: 'pos.js' });
  const recoveredSale = await saleContext.posConfirmSaleWithRecovery(
    {},
    { operationId: 'sale:lost-response', customer:{id:1}, items:[], payment:{}, type:'factura' },
    9
  );
  ok(recoveredSale?.ok && recoveredSale?.recovered && recoveredSale.saleId === 880,
    'recupera una venta confirmada sin permitir un segundo cobro');

  console.log(`\nResultado: ${pass} OK, ${fail} fallos`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
