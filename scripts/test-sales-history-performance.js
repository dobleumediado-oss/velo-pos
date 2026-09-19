#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const ok = (condition, message) => {
  if (!condition) {
    console.error('  ✗', message);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log('  ✓', message);
};

const tempDir = path.join(os.tmpdir(), `velo_sales_history_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
// El esquema completo (cuentas financieras, aplicaciones de abono) vive en las
// migraciones: sin ellas, insertar un abono falla por su clave foránea.
require('../versioning').initVersioning(db, tempDir);

try {
  console.log('\n== Historial paginado de Ventas ==');
  const insertSale = db.prepare(`
    INSERT INTO sales(
      customer_name,customer_rnc,type,status,subtotal,total,payment_method,
      document_number_fmt,numero_factura_fmt,original_sale_date,sale_date,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sale_items(
      sale_id,product_code,product_name,unit_cost,unit_price,qty,subtotal
    ) VALUES(?,?,?,?,?,?,?)
  `);
  const currentMonth = db.prepare("SELECT strftime('%Y-%m','now','localtime') AS value").get().value;
  const seed = db.transaction(() => {
    for (let i = 1; i <= 2500; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      const date = i > 1250 ? `${currentMonth}-${day}` : `2025-${month}-${day}`;
      const name = i === 17 ? 'CLIENTE BUSQUEDA PROFUNDA' : `CLIENTE ${i}`;
      const code = i === 17 ? 'CODIGO-PROFUNDO' : `SKU-${i}`;
      const result = insertSale.run(
        name, `RNC-${i}`, 'factura', 'completed', 100, 118, 'efectivo',
        `FAC-${String(i).padStart(7, '0')}`, `#${String(i).padStart(8, '0')}`,
        date, date, `${date} 12:00:00`
      );
      insertItem.run(result.lastInsertRowid, code, `PRODUCTO ${i}`, 50, 118, 1, 118);
    }
    const quote = insertSale.run(
      'CLIENTE COTIZACION', 'RNC-COT', 'cotizacion', 'completed', 50, 50,
      'efectivo', 'COT-0000001', '', '2026-09-15', '2026-09-15', '2026-09-15 12:00:00'
    );
    insertItem.run(quote.lastInsertRowid, 'COT-SKU', 'PRODUCTO COTIZADO', 25, 50, 1, 50);
    for (let i = 1; i <= 300; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const result = insertSale.run(
        `CLIENTE DEVOLUCION ${i}`, `DEV-${i}`, 'devolucion', 'completed', 25, 29.50,
        'efectivo', `NCR-${String(i).padStart(7, '0')}`, '',
        `${currentMonth}-${day}`, `${currentMonth}-${day}`, `${currentMonth}-${day} 14:00:00`
      );
      insertItem.run(result.lastInsertRowid, `DEV-SKU-${i}`, `DEVUELTO ${i}`, 10, 29.50, 1, 29.50);
    }
  });
  seed();

  const before = db.prepare(`
    SELECT COUNT(*) AS sales_count,
           COALESCE(SUM(total),0) AS sales_total,
           (SELECT COUNT(*) FROM sale_items) AS item_count
    FROM sales
  `).get();

  const started = process.hrtime.bigint();
  const page = DB.salesRepo.getAll({ range:'all', view:'sales', limit:100, offset:0 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const countedSales = DB.salesRepo.countAll({ range:'all', view:'sales' });
  const expectedSales = db.prepare(`
    SELECT COUNT(*) AS n FROM sales
    WHERE status!='cancelled' AND type!='cotizacion' AND type!='devolucion'
      AND NOT (
        correction_kind='product_addition'
        AND original_sale_id IS NOT NULL
      )
  `).get().n;
  ok(page.length === 100, '“Ver todas” trae solo la página solicitada');
  ok(countedSales === expectedSales,
    `el contador conserva el total completo sin renderizarlo (${countedSales}/${expectedSales})`);
  ok(elapsedMs < 1000, `primera página queda bajo 1 s (${elapsedMs.toFixed(1)} ms)`);

  const monthStarted = process.hrtime.bigint();
  const monthPage = DB.salesRepo.getAll({ range:'month', view:'sales', limit:100, offset:0 });
  const monthElapsedMs = Number(process.hrtime.bigint() - monthStarted) / 1e6;
  ok(monthPage.length === 100 && DB.salesRepo.countAll({ range:'month', view:'sales' }) >= 1250,
    '“Este mes” también pagina un período con más de mil facturas');
  ok(monthElapsedMs < 1000, `“Este mes” queda bajo 1 s (${monthElapsedMs.toFixed(1)} ms)`);

  const deepByCustomer = DB.salesRepo.getAll({
    range:'all', view:'sales', q:'BUSQUEDA PROFUNDA', limit:100, offset:0,
  });
  ok(deepByCustomer.length === 1 && deepByCustomer[0].customer_name === 'CLIENTE BUSQUEDA PROFUNDA',
    'la búsqueda consulta todo el historial, no solo la página visible');
  const deepByProduct = DB.salesRepo.getAll({
    range:'all', view:'sales', q:'CODIGO-PROFUNDO', limit:100, offset:0,
  });
  ok(deepByProduct.length === 1 && deepByProduct[0].items_summary.includes('PRODUCTO 17'),
    'la búsqueda profunda encuentra códigos de artículos antiguos');

  const quotes = DB.salesRepo.getAll({ range:'all', view:'quotes', limit:100, offset:0 });
  ok(quotes.length === 1 && quotes[0].type === 'cotizacion',
    'Cotizaciones usa el mismo paginado sin mezclarse con facturas');

  const returnsStarted = process.hrtime.bigint();
  const returnsPage = DB.salesRepo.getAll({ range:'all', view:'returns', limit:100, offset:0 });
  const returnsElapsedMs = Number(process.hrtime.bigint() - returnsStarted) / 1e6;
  ok(returnsPage.length === 100 && returnsPage.every(row => row.type === 'devolucion') &&
    DB.salesRepo.countAll({ range:'all', view:'returns' }) === 300,
    'Devoluciones carga solo su primera página y conserva el contador completo');
  ok(returnsElapsedMs < 1000,
    `Devoluciones queda bajo 1 s con historial abundante (${returnsElapsedMs.toFixed(1)} ms)`);

  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM sales
    WHERE status!='cancelled' AND type!='cotizacion'
    ORDER BY sale_date DESC,id DESC LIMIT 100 OFFSET 0
  `).all().map(row => row.detail).join(' | ');
  console.log('  · Plan:', plan);
  ok(plan.includes('idx_sales_sale_date'), 'SQLite usa el índice de fecha para formar la página');

  const after = db.prepare(`
    SELECT COUNT(*) AS sales_count,
           COALESCE(SUM(total),0) AS sales_total,
           (SELECT COUNT(*) FROM sale_items) AS item_count
    FROM sales
  `).get();
  ok(JSON.stringify(after) === JSON.stringify(before),
    'consultar, contar y buscar no modifica ventas, totales ni artículos');

  const dataSourceForWindow = fs.readFileSync(path.join(__dirname, '../src/js/data.js'), 'utf8');
  console.log('\n== Abonos sin consulta por fila (N+1) ==');
  const customerId = db.prepare("INSERT INTO customers(name,rnc,active) VALUES('CLIENTE ABONOS','101',1)")
    .run().lastInsertRowid;
  const insertPayment = db.prepare(`
    INSERT INTO payments(customer_id,sale_id,amount,method,balance_before,balance_after,created_at)
    VALUES(?,?,?,'efectivo',0,0,?)
  `);
  const insertAllocation = db.prepare(`
    INSERT INTO payment_allocations(payment_id,sale_id,amount,invoice_balance_before,invoice_balance_after)
    VALUES(?,?,?,0,0)
  `);
  const anySaleId = db.prepare("SELECT id FROM sales ORDER BY id LIMIT 1").get().id;
  const PAYMENT_ROWS = 400;
  db.transaction(() => {
    for (let i = 0; i < PAYMENT_ROWS; i += 1) {
      const paymentId = insertPayment.run(customerId, anySaleId, 100, `2026-01-01 10:00:0${i % 10}`).lastInsertRowid;
      insertAllocation.run(paymentId, anySaleId, 100);
    }
  })();

  // Una consulta por abono era el costo real: crecía con el historial y
  // congelaba el proceso principal, que es síncrono.
  const originalPrepare = db.prepare.bind(db);
  let prepareCalls = 0;
  db.prepare = (sql) => { prepareCalls += 1; return originalPrepare(sql); };
  let payments;
  try {
    payments = DB.customersRepo.getAllPayments();
  } finally {
    db.prepare = originalPrepare;
  }
  ok(payments.length >= PAYMENT_ROWS, 'devuelve todos los abonos del historial');
  ok(prepareCalls <= 5,
    `resuelve las aplicaciones en consultas fijas, no una por abono (usó ${prepareCalls} para ${payments.length} abonos)`);
  const allocated = Math.round(payments.reduce((sum, row) => sum + Number(row.allocated_amount || 0), 0) * 100) / 100;
  const expected = db.prepare(`
    SELECT ROUND(COALESCE(SUM(pa.amount),0),2) total FROM payment_allocations pa
    JOIN sales s ON s.id=pa.sale_id
    JOIN payments p ON p.id=pa.payment_id
    WHERE COALESCE(p.status,'active')='active'
  `).get().total;
  ok(Math.abs(allocated - expected) < 0.01,
    'la agrupación conserva exactamente el monto aplicado de cada abono');
  ok(payments.every(row => Array.isArray(row.allocations) && row.allocation_count === row.allocations.length),
    'cada abono conserva su lista de aplicaciones y su conteo');

  const windowed = DB.customersRepo.getAllPayments({ limit: 50 });
  ok(windowed.length === 50, 'la ventana acota la consulta a los abonos pedidos');
  ok(windowed.every(row => Array.isArray(row.allocations)) &&
    windowed.some(row => row.allocation_count > 0),
    'la ventana conserva las aplicaciones de cada abono');
  const newestAll = DB.customersRepo.getAllPayments()[0];
  ok(Number(windowed[0].id) === Number(newestAll.id),
    'la ventana empieza por el abono más reciente, no por el más viejo');
  ok(dataSourceForWindow.includes('const PAYMENTS_WINDOW = 500') &&
    dataSourceForWindow.includes('async function ensurePaymentsComplete') &&
    fs.readFileSync(path.join(__dirname, '../src/js/ventas.js'), 'utf8')
      .includes('await ensurePaymentsComplete()'),
    'la pestaña de Abonos pide el historial completo antes de filtrar por fecha');

  const ventasRefreshSource = fs.readFileSync(path.join(__dirname, '../src/js/ventas.js'), 'utf8');
  ok(/const tasks = \[reloadSales\(\{[\s\S]{0,260}limit: VENTAS_PAGE_SIZE/.test(ventasRefreshSource),
    'tras una mutación Ventas recarga su página, no mil filas de la colección compartida');

  console.log('\n== Clientes sin consulta por fila ==');
  const insertCustomer = db.prepare("INSERT INTO customers(name,rnc,active) VALUES(?,?,1)");
  const insertPhone = db.prepare(
    "INSERT INTO customer_phones(customer_id,phone_type,phone,is_primary,active) VALUES(?,'celular',?,1,1)"
  );
  db.transaction(() => {
    for (let i = 0; i < 120; i += 1) {
      const id = insertCustomer.run(`CLIENTE ${i}`, `RNC${i}`).lastInsertRowid;
      insertPhone.run(id, `809000${String(i).padStart(4, '0')}`);
    }
  })();
  let customerPrepareCalls = 0;
  const prepareBeforeCustomers = db.prepare.bind(db);
  db.prepare = (sql) => { customerPrepareCalls += 1; return prepareBeforeCustomers(sql); };
  let customers;
  try {
    customers = DB.customersRepo.getAll();
  } finally {
    db.prepare = prepareBeforeCustomers;
  }
  ok(customers.length >= 120, 'devuelve todos los clientes activos');
  ok(customerPrepareCalls <= 6,
    `resuelve contactos, sucursales y teléfonos en consultas fijas (usó ${customerPrepareCalls} para ${customers.length} clientes)`);
  const phonesInDb = db.prepare('SELECT COUNT(*) n FROM customer_phones WHERE active=1').get().n;
  const phonesInRepo = customers.reduce((sum, row) => sum + row.phones.length, 0);
  ok(phonesInDb === phonesInRepo && customers.every(row =>
    Array.isArray(row.contacts) && Array.isArray(row.branches) && Array.isArray(row.phones)),
    'cada cliente conserva sus contactos, sucursales y teléfonos');

  // Una tabla creada DESPUÉS de la primera consulta debe detectarse igual: solo
  // se cachea el resultado positivo, nunca la ausencia.
  const beforeCreate = DB.tableExists ? DB.tableExists('velo_cache_probe') : null;
  db.exec('CREATE TABLE IF NOT EXISTS velo_cache_probe(id INTEGER PRIMARY KEY)');
  const afterCreate = DB.tableExists ? DB.tableExists('velo_cache_probe') : null;
  ok(beforeCreate === false && afterCreate === true,
    'la caché de tablas no congela un "no existe": una migración posterior se detecta');

  console.log('\n== Recargas coalescidas y abonos diferidos ==');
  const dataSource = fs.readFileSync(path.join(__dirname, '../src/js/data.js'), 'utf8');
  const sliceFrom = dataSource.indexOf('async function reloadProducts()');
  const sliceTo = dataSource.indexOf('let salesLoadGeneration');
  ok(sliceFrom > 0 && sliceTo > sliceFrom, 'las recargas siguen agrupadas en data.js');

  const buildDataContext = (activePage) => {
    let productCalls = 0;
    let paymentCalls = 0;
    const context = {
      DB: { products: [], customers: [], payments: [] },
      page: activePage,
      window: {
        api: {
          products: { getAll: async () => { productCalls += 1; return [{ id: 1 }]; } },
          customers: {
            getAll: async () => [{ id: 1 }],
            getAllPayments: async () => { paymentCalls += 1; return [{ id: 7 }]; },
          },
        },
      },
      counters: () => ({ productCalls, paymentCalls }),
    };
    require('vm').runInNewContext(
      `${dataSource.slice(sliceFrom, sliceTo)}
       this.reloadProducts = reloadProducts;
       this.reloadPayments = reloadPayments;
       this.ensurePaymentsFresh = ensurePaymentsFresh;`,
      context
    );
    return context;
  };

  const posContext = buildDataContext('pos');
  Promise.all([posContext.reloadProducts(), posContext.reloadProducts(), posContext.reloadProducts()])
    .then(() => posContext.reloadPayments())
    .then(() => {
      const first = posContext.counters();
      ok(first.productCalls === 1,
        `tres recargas simultáneas de productos consultan una sola vez (fueron ${first.productCalls})`);
      ok(first.paymentCalls === 0,
        'estando en el POS no se recargan los abonos de todo el historial');
      return posContext.ensurePaymentsFresh();
    })
    .then(() => {
      const after = posContext.counters();
      ok(after.paymentCalls === 1,
        'al entrar a una pantalla que sí los muestra, los abonos pendientes se recuperan');
      const ventasContext = buildDataContext('ventas');
      return ventasContext.reloadPayments().then(() => {
        ok(ventasContext.counters().paymentCalls === 1,
          'en Ventas los abonos se recargan de inmediato, sin diferir');
      });
    })
    .catch(error => { console.error('  ✗', error.message); process.exitCode = 1; });

  console.log('\n== Repintado que conserva la posición ==');
  const repaintFrom = dataSource.indexOf('function veloRepaint(');
  const repaintTo = dataSource.indexOf('// Varias acciones seguidas disparaban');
  ok(repaintFrom > 0 && repaintTo > repaintFrom, 'veloRepaint vive en data.js');
  const pageEl = {
    scrollTop: 420, scrollLeft: 0, style: {},
    focus() {},
  };
  const focusable = { id: 'campo', focus() { focusable.focused = true; }, selectionStart: 3,
    setSelectionRange() { focusable.restoredCaret = true; } };
  const repaintContext = {
    document: {
      activeElement: focusable,
      getElementById: (id) => (id === 'page' ? pageEl : (id === 'campo' ? focusable : null)),
    },
    repainted: false,
  };
  require('vm').runInNewContext(
    `${dataSource.slice(repaintFrom, repaintTo)}
     veloRepaint(() => { this.repainted = true; document.getElementById('page').scrollTop = 0; });`,
    repaintContext
  );
  ok(repaintContext.repainted && pageEl.scrollTop === 420,
    'un repintado completo devuelve la vista a donde estaba, no al tope');
  ok(focusable.focused && focusable.restoredCaret,
    'el campo enfocado y la posición del cursor sobreviven al repintado');

  const cajaSource = fs.readFileSync(path.join(__dirname, '../src/js/caja.js'), 'utf8');
  const ventasSource = fs.readFileSync(path.join(__dirname, '../src/js/ventas.js'), 'utf8');
  // Todo módulo que reconstruye su pantalla debe pasar por el helper. El POS y
  // el asistente quedan fuera a propósito: manejan su propio foco.
  // El POS queda fuera a propósito: tras cobrar limpia la factura y renderPOS
  // devuelve el foco al buscador para el siguiente escaneo, que es lo correcto.
  const repaintExceptions = new Set(['pos.js', 'data.js']);
  const jsDir = path.join(__dirname, '../src/js');
  const unwrapped = fs.readdirSync(jsDir)
    .filter(file => file.endsWith('.js') && !repaintExceptions.has(file))
    .filter(file => /(?<!veloRepaint\(\(\) => )render[A-Z][a-zA-Z]*\(document\.getElementById\('page'\)\)/
      .test(fs.readFileSync(path.join(jsDir, file), 'utf8')));
  ok(unwrapped.length === 0,
    `todos los módulos repintan a través del helper que conserva la posición${unwrapped.length ? ' · faltan: ' + unwrapped.join(', ') : ''}`);
  ok(cajaSource.includes('veloRepaint(() => renderCaja') &&
    ventasSource.includes('veloRepaint(() => renderVentas'),
    'Caja y Ventas conservan scroll y foco al confirmar una acción');

  console.log('\n== Aviso de cambio sin trabajo duplicado ==');
  const trackFrom = dataSource.indexOf('const _reloadInFlight = new Map();');
  const trackTo = dataSource.indexOf('async function reloadPayments(');
  const syncFrom = dataSource.indexOf('let _syncPending = new Set();');
  const syncTo = dataSource.indexOf('  if (window.api && window.api.sync', syncFrom) - 'try {\n'.length;
  ok(trackFrom > 0 && syncFrom > trackFrom && syncTo > syncFrom,
    'el seguimiento de ámbitos y el manejador de avisos siguen en data.js');

  let productReloads = 0;
  const syncContext = {
    page: 'inventario',
    console,
    reloadProducts: async () => { productReloads += 1; },
    reloadCustomers: async () => {},
    reloadPayments: async () => {},
    reloadSales: async () => {},
    renderInvTable: () => {},
    setTimeout: (fn) => { syncContext.scheduled = fn; return 1; },
    counters: () => ({ productReloads }),
  };
  require('vm').runInNewContext(
    `${dataSource.slice(trackFrom, trackTo)}
     ${dataSource.slice(syncFrom, syncTo)}
     this.markRefreshed = (scope) => _scopeRefreshedAt.set(scope, Date.now());
     this.markStale = (scope) => _scopeRefreshedAt.set(scope, Date.now() - 5000);
     this.onRemoteSync = _onRemoteSync;
     this.applyRemoteSync = _applyRemoteSync;`,
    syncContext
  );

  syncContext.markRefreshed('products');
  syncContext.onRemoteSync({ scopes: ['products'], local: true });
  ok(typeof syncContext.scheduled === 'function', 'el aviso se agenda con su ventana de agrupación');
  syncContext.scheduled();
  setTimeout(() => {
    ok(syncContext.counters().productReloads === 0,
      'el aviso que llega justo después de la propia recarga no vuelve a consultar');
    syncContext.markStale('products');
    syncContext.onRemoteSync({ scopes: ['products'], local: true });
    syncContext.scheduled();
    setTimeout(() => {
      ok(syncContext.counters().productReloads === 1,
        'un cambio que la pantalla no había refrescado sí se recupera');
      const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
      ok(mainSource.includes("send('sync:changed', { scopes, local: true })"),
        'en modo local el proceso principal también avisa a su propio renderer');
      ok(dataSource.includes('data && data.local ? 120 : 250'),
        'un aviso local se atiende antes que uno que atravesó la red');
      console.log(`\n== RESULTADO: ${passed} OK · ${elapsedMs.toFixed(1)} ms ==`);
    }, 5);
  }, 5);

  const ui = fs.readFileSync(path.join(__dirname, '../src/js/ventas.js'), 'utf8');
  ok(ui.includes('const VENTAS_PAGE_SIZE = 100') && ui.includes('ventasGoToPage'),
    'la pantalla limita el render a 100 documentos y ofrece navegación');
  ok(ui.includes('async function ventasRowsForExport') && ui.includes('const pageSize = 500'),
    'PDF y Excel reúnen el filtro completo por lotes sin repintar miles de filas');

  const inv = fs.readFileSync(path.join(__dirname, '../src/js/inventario.js'), 'utf8');
  ok(inv.includes('function invMatchesFilters') && inv.includes('invFocusProductId') &&
    inv.includes('invPage = Math.floor(focusIdx / pageSize) + 1'),
    'Inventario salta a la página del producto guardado en vez de esconderlo');
  ok(inv.includes('function refreshInvHeaderStats') && inv.includes("id: 'inv-header-stats'"),
    'las cifras de la cabecera se actualizan sin salir y volver al módulo');
} finally {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive:true, force:true });
}
