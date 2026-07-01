// ================================================================
// system-doctor.js
// Diagnostico profundo del POS desde el main process.
// No modifica datos: detecta riesgos reales y devuelve acciones sugeridas.
// ================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const MONEY_FMT = new Intl.NumberFormat('es-DO', {
  style: 'currency',
  currency: 'DOP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function money(value) {
  return MONEY_FMT.format(round2(value));
}

function absDiff(a, b) {
  return Math.abs(round2(a) - round2(b));
}

function pct(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

function count(db, sql, ...params) {
  return db.prepare(sql).get(...params)?.c || 0;
}

function tableExists(db, table) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
}

function parseDbDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const variants = [
    raw,
    raw.replace(' ', 'T'),
    raw.replace(/\s+a\.\s*m\./i, ' AM').replace(/\s+p\.\s*m\./i, ' PM'),
  ];
  for (const candidate of variants) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function hoursSince(value) {
  const d = parseDbDate(value);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 3600000));
}

function listFiles(root, fileNames) {
  return fileNames
    .map(file => path.join(root, file))
    .filter(file => fs.existsSync(file));
}

function statusFrom(hasError, hasWarn) {
  if (hasError) return 'error';
  if (hasWarn) return 'warn';
  return 'ok';
}

function result(id, label, status, detail, extra = {}) {
  return { id, label, status, detail, ...extra };
}

function safeSection(results, id, label, fn) {
  try {
    results.push(fn());
  } catch (e) {
    results.push(result(id, label, 'error', e.message, {
      impact: 'El diagnostico no pudo completar esta revision.',
      fix: 'Revisar el log tecnico y ejecutar de nuevo.',
    }));
  }
}

async function safeAsyncSection(results, id, label, fn) {
  try {
    results.push(await fn());
  } catch (e) {
    results.push(result(id, label, 'error', e.message, {
      impact: 'El diagnostico no pudo completar esta revision.',
      fix: 'Revisar el log tecnico y ejecutar de nuevo.',
    }));
  }
}

function diagnoseDatabase({ db, dataDir }) {
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const integrityOk = integrity?.integrity_check === 'ok';
  const fkRows = db.prepare('PRAGMA foreign_key_check').all();
  const dbPath = path.join(dataDir, 'velo.db');
  const stat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
  const walPath = `${dbPath}-wal`;
  const walStat = fs.existsSync(walPath) ? fs.statSync(walPath) : null;
  const dbSizeMB = stat ? round2(stat.size / 1024 / 1024) : 0;
  const walSizeMB = walStat ? round2(walStat.size / 1024 / 1024) : 0;
  const sales = tableExists(db, 'sales')
    ? count(db, "SELECT COUNT(*) c FROM sales WHERE status!='cancelled'")
    : 0;
  const products = tableExists(db, 'products')
    ? count(db, "SELECT COUNT(*) c FROM products WHERE active=1")
    : 0;
  const customers = tableExists(db, 'customers')
    ? count(db, "SELECT COUNT(*) c FROM customers WHERE active=1")
    : 0;
  const status = statusFrom(!integrityOk || fkRows.length > 0, walSizeMB > 200);

  return result('db', 'Base de datos', status,
    integrityOk && fkRows.length === 0
      ? `Integra | ${dbSizeMB} MB | WAL ${walSizeMB} MB | ${sales} ventas | ${products} productos | ${customers} clientes`
      : `Integridad: ${integrity?.integrity_check || 'desconocida'} | FK rotas: ${fkRows.length}`,
    {
      category: 'nucleo',
      impact: status === 'ok'
        ? 'La base principal responde y conserva sus relaciones.'
        : 'Puede haber datos huerfanos o una DB danada; ventas, caja y reportes pueden fallar.',
      fix: fkRows.length
        ? 'Crear backup, revisar las filas huerfanas y reparar relaciones antes de seguir operando.'
        : walSizeMB > 200
          ? 'Ejecutar mantenimiento/VACUUM fuera de horario para compactar.'
          : 'Sin accion requerida.',
      value: { integrity: integrity?.integrity_check, foreignKeys: fkRows.length, dbSizeMB, walSizeMB },
    }
  );
}

function diagnoseBackups({ dataDir }) {
  const backupDir = path.join(dataDir, 'backups');
  const files = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.db') && (f.startsWith('velo_') || f.startsWith('velo_auto_')))
        .map(f => {
          const full = path.join(backupDir, f);
          return { name: f, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  const latest = files[0] || null;
  const daysSince = latest ? Math.floor((Date.now() - latest.mtime) / 86400000) : 999;
  const status = !latest ? 'error' : daysSince <= 1 ? 'ok' : daysSince <= 3 ? 'warn' : 'error';

  return result('backup', 'Backups', status,
    !latest
      ? 'No hay backups automaticos disponibles'
      : daysSince === 0
        ? `Backup reciente: ${latest.name} | ${files.length} guardados`
        : `Ultimo backup hace ${daysSince} dias: ${latest.name} | ${files.length} guardados`,
    {
      category: 'seguridad',
      impact: status === 'ok'
        ? 'Hay punto de recuperacion reciente.'
        : 'Si se dana la base o se borra informacion, la recuperacion seria riesgosa.',
      fix: 'Crear backup manual y confirmar que el backup automatico corre al iniciar.',
      value: { count: files.length, latest: latest?.name || null, daysSince },
    }
  );
}

function diagnoseCash({ db, cashRepo }) {
  const openSessions = db.prepare("SELECT * FROM cash_sessions WHERE status='open' ORDER BY id").all();
  const closedSessions = db.prepare(
    "SELECT * FROM cash_sessions WHERE status='closed' ORDER BY id DESC LIMIT 20"
  ).all();
  const mismatchedClosed = [];

  for (const session of closedSessions) {
    const summary = cashRepo.getSessionCashSummary(session.id);
    if (!summary) continue;
    const storedExpected = round2(session.expected || 0);
    const storedDiff = round2(session.difference || 0);
    const realExpected = round2(summary.expected);
    const realDiff = round2((session.close_amount || 0) - realExpected);
    if (absDiff(storedExpected, realExpected) > 1 || absDiff(storedDiff, realDiff) > 1) {
      mismatchedClosed.push({
        id: session.id,
        storedExpected,
        realExpected,
        storedDiff,
        realDiff,
      });
    }
  }

  const cachedMismatch = db.prepare(`
    SELECT cs.id, cs.sales_count, cs.sales_total,
           COUNT(s.id) AS real_count,
           COALESCE(SUM(s.total),0) AS real_total
    FROM cash_sessions cs
    LEFT JOIN sales s
      ON s.cash_session_id=cs.id
     AND s.status!='cancelled'
     AND s.type!='cotizacion'
    GROUP BY cs.id
    HAVING ABS(COALESCE(cs.sales_total,0)-COALESCE(SUM(s.total),0)) > 1
        OR COALESCE(cs.sales_count,0) != COUNT(s.id)
    ORDER BY cs.id DESC
    LIMIT 10
  `).all();

  let detail = 'Sin caja abierta';
  let impact = 'El cierre se puede validar contra movimientos reales.';
  let fix = 'Sin accion requerida.';
  let hasError = openSessions.length > 1;
  let hasWarn = mismatchedClosed.length > 0 || cachedMismatch.length > 0;

  if (openSessions.length === 1) {
    const open = openSessions[0];
    const age = hoursSince(open.created_at) ?? 0;
    detail = `Caja abierta #${open.id} por ${open.cajero || 'usuario'} hace ${age}h`;
    if (age > 24) {
      hasError = true;
      impact = 'Una caja abierta por mas de un dia puede mezclar turnos y descuadrar reportes.';
      fix = 'Cerrar la caja actual con conteo fisico y abrir una nueva sesion.';
    }
  } else if (openSessions.length > 1) {
    detail = `${openSessions.length} cajas abiertas al mismo tiempo`;
    impact = 'El POS puede registrar ventas en una caja incorrecta y descuadrar cierres.';
    fix = 'Cerrar o consolidar sesiones abiertas desde la mas antigua.';
  }

  if (mismatchedClosed.length) {
    detail += ` | ${mismatchedClosed.length} cierres no cuadran contra movimientos reales`;
    impact = 'El efectivo esperado guardado no coincide con ventas, abonos, devoluciones y salidas.';
    fix = 'Recalcular cierres afectados desde cash_movements antes de usar reportes de caja.';
  } else if (cachedMismatch.length) {
    detail += ` | ${cachedMismatch.length} sesiones tienen totales cacheados diferentes`;
    impact = 'La pantalla puede mostrar totales historicos distintos al movimiento real.';
    fix = 'Usar el cuadre calculado desde movimientos y regenerar cache si se habilita reparacion.';
  }

  return result('cash', 'Caja real', statusFrom(hasError, hasWarn), detail, {
    category: 'operacion',
    impact,
    fix,
    value: {
      openCount: openSessions.length,
      mismatchedClosed: mismatchedClosed.slice(0, 5),
      cachedMismatch: cachedMismatch.slice(0, 5),
    },
  });
}

function diagnoseSales({ db }) {
  const rows = db.prepare(`
    SELECT s.id, s.type, s.status, s.subtotal, s.discount_amt, s.tax_pct, s.tax_amt, s.total,
           s.cajero, s.notes,
           COUNT(si.id) AS item_count,
           COALESCE(SUM(si.unit_price * si.qty),0) AS item_subtotal
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id=s.id
    WHERE s.status!='cancelled'
    GROUP BY s.id
  `).all();
  const noItemsCurrent = [];
  const noItemsHistorical = [];
  const currentMismatch = [];
  const historicalMismatch = [];
  let historicalTaxIncluded = 0;

  for (const sale of rows) {
    const isHistorical = sale.cajero === 'Importación histórica' ||
      String(sale.notes || '').toLowerCase().includes('importada');
    if ((sale.item_count || 0) === 0) {
      (isHistorical ? noItemsHistorical : noItemsCurrent).push(sale.id);
      continue;
    }
    const itemSubtotal = round2(sale.item_subtotal);
    const discount = round2(sale.discount_amt || 0);
    const base = round2(itemSubtotal - discount);
    const expectedTax = round2(base * ((Number(sale.tax_pct) || 0) / 100));
    const expectedTotal = round2(base + expectedTax);
    const netTotal = round2(base);
    const storedTotal = round2((sale.subtotal || 0) - (sale.discount_amt || 0) + (sale.tax_amt || 0));

    if (isHistorical) {
      const matchesNetItems = absDiff(sale.total, netTotal) <= 1;
      const matchesGrossItems = absDiff(sale.total, expectedTotal) <= 1;
      if (!matchesNetItems && !matchesGrossItems) {
        historicalMismatch.push({
          id: sale.id,
          subtotal: round2(sale.subtotal),
          calcNet: netTotal,
          calcGross: expectedTotal,
          total: round2(sale.total),
        });
      } else if (matchesGrossItems && round2(sale.tax_amt) === 0 && round2(expectedTax) > 0) {
        historicalTaxIncluded += 1;
      }
      continue;
    }

    if (absDiff(sale.subtotal, itemSubtotal) > 0.02 ||
        absDiff(sale.tax_amt, expectedTax) > 0.02 ||
        absDiff(sale.total, expectedTotal) > 0.02 ||
        absDiff(sale.total, storedTotal) > 0.02) {
      currentMismatch.push({
        id: sale.id,
        subtotal: round2(sale.subtotal),
        calcSubtotal: itemSubtotal,
        total: round2(sale.total),
        calcTotal: expectedTotal,
      });
    }
  }

  const mixedMismatch = db.prepare(`
    SELECT s.id, s.total, COALESCE(SUM(cm.amount),0) AS movement_total
    FROM sales s
    LEFT JOIN cash_movements cm
      ON cm.reference_id=s.id
     AND cm.type='venta'
    WHERE s.status!='cancelled'
      AND s.type='factura'
      AND s.payment_method='mixto'
    GROUP BY s.id
    HAVING ABS(s.total - COALESCE(SUM(cm.amount),0)) > 1
    LIMIT 20
  `).all();

  const nonCreditWithoutMovement = db.prepare(`
    SELECT COUNT(*) c
    FROM sales s
    WHERE s.status!='cancelled'
      AND s.type='factura'
      AND s.payment_method!='credito'
      AND s.cash_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cash_movements cm
        WHERE cm.reference_id=s.id AND cm.type='venta'
      )
  `).get().c || 0;

  const hasError = noItemsCurrent.length > 0 || currentMismatch.length > 0;
  const hasWarn = noItemsHistorical.length > 0 || historicalMismatch.length > 0 ||
    historicalTaxIncluded > 0 || mixedMismatch.length > 0 || nonCreditWithoutMovement > 0;
  const pieces = [
    `${rows.length} documentos revisados`,
    noItemsCurrent.length ? `${noItemsCurrent.length} actuales sin items` : null,
    currentMismatch.length ? `${currentMismatch.length} actuales descuadrados` : null,
    noItemsHistorical.length ? `${noItemsHistorical.length} historicos sin items` : null,
    historicalMismatch.length ? `${historicalMismatch.length} historicos incoherentes` : null,
    historicalTaxIncluded ? `${historicalTaxIncluded} historicos con ITBIS incluido` : null,
    mixedMismatch.length ? `${mixedMismatch.length} pagos mixtos descuadrados` : null,
    nonCreditWithoutMovement ? `${nonCreditWithoutMovement} ventas sin movimiento de caja` : null,
  ].filter(Boolean);

  return result('sales_logic', 'Logica de ventas', statusFrom(hasError, hasWarn), pieces.join(' | '), {
    category: 'negocio',
    impact: hasError
      ? 'Una factura descuadrada afecta ticket, caja, credito, fiscal y contabilidad.'
      : hasWarn
        ? 'La operacion actual no tiene descuadres criticos, pero hay historial importado o movimientos que revisar.'
        : 'Ventas consistentes contra sus items y movimientos principales.',
    fix: hasError
      ? 'Revisar facturas indicadas y regenerar totales desde sale_items con backup previo.'
      : hasWarn
        ? 'Auditar importaciones historicas y movimientos de caja faltantes antes de usarlos para reportes fiscales.'
        : 'Sin accion requerida.',
    value: {
      noItemsCurrent: noItemsCurrent.slice(0, 10),
      noItemsHistorical: noItemsHistorical.slice(0, 10),
      currentMismatch: currentMismatch.slice(0, 10),
      historicalMismatch: historicalMismatch.slice(0, 10),
      historicalTaxIncluded,
      mixedMismatch: mixedMismatch.slice(0, 10),
      nonCreditWithoutMovement,
    },
  });
}

function diagnoseInventory({ db }) {
  const negativeStock = db.prepare(
    "SELECT id, name, stock FROM products WHERE active=1 AND stock < 0 LIMIT 20"
  ).all();
  const duplicateCodes = db.prepare(`
    SELECT LOWER(TRIM(code)) AS code, COUNT(*) AS c
    FROM products
    WHERE active=1 AND TRIM(COALESCE(code,''))!=''
    GROUP BY LOWER(TRIM(code))
    HAVING COUNT(*) > 1
    LIMIT 20
  `).all();
  const duplicateBarcodes = db.prepare(`
    SELECT LOWER(TRIM(barcode)) AS barcode, COUNT(*) AS c
    FROM products
    WHERE active=1 AND TRIM(COALESCE(barcode,''))!=''
    GROUP BY LOWER(TRIM(barcode))
    HAVING COUNT(*) > 1
    LIMIT 20
  `).all();
  const priceBelowCost = db.prepare(`
    SELECT COUNT(*) c
    FROM products
    WHERE active=1 AND cost > 0 AND price > 0 AND price < cost
  `).get().c || 0;
  const badMovements = db.prepare(`
    SELECT COUNT(*) c
    FROM inventory_movements
    WHERE ROUND(qty_before + qty, 2) != ROUND(qty_after, 2)
  `).get().c || 0;
  const stockMismatch = db.prepare(`
    SELECT p.id, p.name, p.stock, m.qty_after
    FROM products p
    JOIN (
      SELECT product_id, MAX(id) AS max_id
      FROM inventory_movements
      GROUP BY product_id
    ) last_m ON last_m.product_id=p.id
    JOIN inventory_movements m ON m.id=last_m.max_id
    WHERE p.active=1 AND ROUND(p.stock, 2) != ROUND(m.qty_after, 2)
    LIMIT 20
  `).all();
  const lowStock = count(db, "SELECT COUNT(*) c FROM products WHERE active=1 AND stock <= stock_min");

  const hasError = negativeStock.length > 0 || duplicateCodes.length > 0 || badMovements > 0;
  const hasWarn = duplicateBarcodes.length > 0 || priceBelowCost > 0 || stockMismatch.length > 0 || lowStock > 0;
  const pieces = [
    negativeStock.length ? `${negativeStock.length} productos con stock negativo` : null,
    duplicateCodes.length ? `${duplicateCodes.length} codigos duplicados` : null,
    duplicateBarcodes.length ? `${duplicateBarcodes.length} barcodes duplicados` : null,
    badMovements ? `${badMovements} movimientos matematicamente invalidos` : null,
    stockMismatch.length ? `${stockMismatch.length} stocks no coinciden con ultimo movimiento` : null,
    priceBelowCost ? `${priceBelowCost} productos bajo costo` : null,
    lowStock ? `${lowStock} en minimo` : null,
  ].filter(Boolean);

  return result('inventory_logic', 'Inventario real', statusFrom(hasError, hasWarn),
    pieces.length ? pieces.join(' | ') : 'Stock, codigos y movimientos consistentes',
    {
      category: 'negocio',
      impact: hasError
        ? 'Puede venderse una pieza equivocada, duplicada o con existencia falsa.'
        : hasWarn
          ? 'Hay alertas operativas que pueden afectar margen o reposicion.'
          : 'Inventario consistente para ventas y compras.',
      fix: hasError
        ? 'Bloquear venta de codigos conflictivos y corregir stock desde movimientos auditados.'
        : hasWarn
          ? 'Revisar duplicados, margenes y productos bajo minimo.'
          : 'Sin accion requerida.',
      value: {
        negativeStock,
        duplicateCodes,
        duplicateBarcodes,
        badMovements,
        stockMismatch,
        priceBelowCost,
        lowStock,
      },
    }
  );
}

function diagnoseCredit({ db }) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.balance, c.credit_due, c.status,
           COALESCE((SELECT SUM(s.total) FROM sales s
             WHERE s.customer_id=c.id AND s.payment_method='credito'
               AND s.type='factura' AND s.status!='cancelled'),0) AS credit_total,
           COALESCE((SELECT SUM(s.total) FROM sales s
             WHERE s.customer_id=c.id AND s.payment_method='credito'
               AND s.type='devolucion' AND s.status!='cancelled'),0) AS returns_total,
           COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id=c.id),0) AS paid_total
    FROM customers c
    WHERE c.active=1 AND c.id != 1
  `).all();

  const mismatches = [];
  const importedBalances = [];
  const overdueActive = [];
  const today = new Date().toISOString().split('T')[0];

  for (const c of rows) {
    const hasLedger = round2(c.credit_total) > 0 || round2(c.returns_total) > 0 || round2(c.paid_total) > 0;
    const expected = Math.max(0, round2(c.credit_total - c.returns_total - c.paid_total));
    if (hasLedger && absDiff(c.balance, expected) > 1) {
      mismatches.push({
        id: c.id,
        name: c.name,
        balance: round2(c.balance),
        expected,
      });
    } else if (!hasLedger && round2(c.balance) > 0) {
      importedBalances.push({ id: c.id, name: c.name, balance: round2(c.balance) });
    }
    if (round2(c.balance) > 0 && c.credit_due && c.credit_due < today && c.status === 'activo') {
      overdueActive.push({ id: c.id, name: c.name, due: c.credit_due, balance: round2(c.balance) });
    }
  }

  const hasError = mismatches.length > 0;
  const hasWarn = importedBalances.length > 0 || overdueActive.length > 0;
  const pieces = [
    `${rows.length} clientes revisados`,
    mismatches.length ? `${mismatches.length} balances no cuadran` : null,
    importedBalances.length ? `${importedBalances.length} saldos iniciales sin factura historica` : null,
    overdueActive.length ? `${overdueActive.length} vencidos aun activos` : null,
  ].filter(Boolean);

  return result('credit_logic', 'Credito y cuentas por cobrar', statusFrom(hasError, hasWarn), pieces.join(' | '), {
    category: 'negocio',
    impact: hasError
      ? 'Un balance incorrecto puede cobrar de mas, cobrar de menos o bloquear mal a un cliente.'
      : hasWarn
        ? 'Hay saldos que necesitan seguimiento administrativo.'
        : 'Balances de credito consistentes con facturas y abonos.',
    fix: hasError
      ? 'Recalcular balances desde facturas credito, devoluciones y abonos con respaldo previo.'
      : hasWarn
        ? 'Marcar vencidos como morosos o documentar saldos iniciales importados.'
        : 'Sin accion requerida.',
    value: {
      mismatches: mismatches.slice(0, 10),
      importedBalances: importedBalances.slice(0, 10),
      overdueActive: overdueActive.slice(0, 10),
    },
  });
}

function diagnoseFiscal({ db, settingsRepo }) {
  const settings = settingsRepo.getAll();
  const fiscalOn = settings?.fiscal_enabled === '1';
  const ncfAdvanced = settings?.module_ncf_avanzado === '1';
  const rnc = String(settings?.biz_rnc || '').replace(/[-\s]/g, '');
  const taxPct = Number(settings?.tax_pct ?? 0);
  const missingNcf = fiscalOn
    ? count(db, "SELECT COUNT(*) c FROM sales WHERE type='factura' AND status!='cancelled' AND TRIM(COALESCE(ncf,''))=''")
    : 0;
  const duplicatedNcf = count(db, `
    SELECT COUNT(*) c
    FROM (
      SELECT ncf
      FROM sales
      WHERE TRIM(COALESCE(ncf,''))!=''
      GROUP BY ncf
      HAVING COUNT(*) > 1
    )
  `);

  let sequenceAlerts = 0;
  let sequenceEmpty = 0;
  if (ncfAdvanced && tableExists(db, 'ncf_sequences')) {
    sequenceEmpty = count(db, "SELECT COUNT(*) c FROM ncf_sequences WHERE active=1 AND current >= to_num");
    sequenceAlerts = count(db, "SELECT COUNT(*) c FROM ncf_sequences WHERE active=1 AND (to_num-current) <= COALESCE(alert_at,50)");
  }

  const ecfPartial = ['ecf_email', 'ecf_password', 'ecf_api_key']
    .map(k => String(settings?.[k] || '').trim())
    .filter(Boolean).length;

  const hasError = fiscalOn && (!rnc || missingNcf > 0 || duplicatedNcf > 0 || sequenceEmpty > 0);
  const hasWarn = fiscalOn && ((taxPct < 0 || taxPct > 27) || sequenceAlerts > 0 || (ecfPartial > 0 && ecfPartial < 3));
  const detail = fiscalOn
    ? [
        `RNC ${rnc || 'sin configurar'}`,
        `ITBIS ${Number.isFinite(taxPct) ? taxPct : 0}%`,
        missingNcf ? `${missingNcf} facturas sin NCF` : null,
        duplicatedNcf ? `${duplicatedNcf} NCF duplicados` : null,
        sequenceEmpty ? `${sequenceEmpty} secuencias agotadas` : null,
        sequenceAlerts ? `${sequenceAlerts} secuencias en alerta` : null,
        ecfPartial > 0 && ecfPartial < 3 ? 'e-CF parcialmente configurado' : null,
      ].filter(Boolean).join(' | ')
    : 'Modulo fiscal desactivado';

  return result('fiscal_logic', 'Fiscal / NCF / e-CF', statusFrom(hasError, hasWarn), detail, {
    category: 'fiscal',
    impact: hasError
      ? 'Puede emitir facturas fiscalmente incompletas o duplicadas.'
      : fiscalOn
        ? 'La configuracion fiscal basica esta lista.'
        : 'El negocio opera sin comprobantes fiscales.',
    fix: hasError
      ? 'Configurar RNC/secuencias y corregir facturas sin NCF antes de reportar.'
      : hasWarn
        ? 'Completar credenciales e-CF y vigilar secuencias cercanas a agotarse.'
        : 'Sin accion requerida.',
    value: { fiscalOn, rnc, taxPct, missingNcf, duplicatedNcf, sequenceEmpty, sequenceAlerts },
  });
}

function diagnoseAccounting({ db, settingsRepo }) {
  const settings = settingsRepo.getAll();
  const enabled = settings?.module_contabilidad === '1';
  if (!enabled) {
    return result('accounting_logic', 'Contabilidad', 'ok', 'Modulo contable desactivado', {
      category: 'contabilidad',
      impact: 'No se exige asiento contable automatico.',
      fix: 'Sin accion requerida.',
      value: { enabled: false },
    });
  }
  if (!tableExists(db, 'accounting_entries') || !tableExists(db, 'accounting_entry_lines')) {
    return result('accounting_logic', 'Contabilidad', 'error', 'Modulo activo pero faltan tablas contables', {
      category: 'contabilidad',
      impact: 'No se pueden registrar asientos contables aunque el modulo este activo.',
      fix: 'Ejecutar migraciones o reinstalar esquema con backup previo.',
    });
  }

  const unbalanced = db.prepare(`
    SELECT e.id, e.number,
           ROUND(COALESCE(SUM(l.debit),0),2) AS debit,
           ROUND(COALESCE(SUM(l.credit),0),2) AS credit
    FROM accounting_entries e
    LEFT JOIN accounting_entry_lines l ON l.entry_id=e.id
    WHERE e.status!='anulado'
    GROUP BY e.id
    HAVING ABS(ROUND(COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0),2)) > 0.01
    LIMIT 20
  `).all();
  const noLines = count(db, `
    SELECT COUNT(*) c
    FROM accounting_entries e
    WHERE e.status!='anulado'
      AND NOT EXISTS (SELECT 1 FROM accounting_entry_lines l WHERE l.entry_id=e.id)
  `);
  const salesWithoutEntry = count(db, `
    SELECT COUNT(*) c
    FROM sales s
    WHERE s.status!='cancelled'
      AND s.type='factura'
      AND NOT EXISTS (
        SELECT 1 FROM accounting_entries e
        WHERE e.source_module='venta' AND e.source_id=s.id
      )
  `);

  const hasError = unbalanced.length > 0 || noLines > 0;
  const hasWarn = salesWithoutEntry > 0;
  const detail = [
    unbalanced.length ? `${unbalanced.length} asientos descuadrados` : null,
    noLines ? `${noLines} asientos sin lineas` : null,
    salesWithoutEntry ? `${salesWithoutEntry} ventas sin asiento` : null,
  ].filter(Boolean).join(' | ') || 'Asientos balanceados';

  return result('accounting_logic', 'Contabilidad', statusFrom(hasError, hasWarn), detail, {
    category: 'contabilidad',
    impact: hasError
      ? 'Los estados financieros pueden quedar incorrectos.'
      : hasWarn
        ? 'Hay operaciones sin reflejo contable.'
        : 'La partida doble esta balanceada.',
    fix: hasError
      ? 'Corregir asientos descuadrados y regenerar balances.'
      : hasWarn
        ? 'Ejecutar sincronizacion historica contable.'
        : 'Sin accion requerida.',
    value: { unbalanced, noLines, salesWithoutEntry },
  });
}

function diagnoseSecurity({ db, settingsRepo, getLicenseStatus, dataDir }) {
  const activeUsers = count(db, "SELECT COUNT(*) c FROM users WHERE active=1");
  const superadmins = count(db, "SELECT COUNT(*) c FROM users WHERE active=1 AND role='superadmin'");
  const admins = count(db, "SELECT COUNT(*) c FROM users WHERE active=1 AND role IN ('admin','superadmin')");
  const settings = settingsRepo.getAll();
  const passwordChanged = settings?.password_changed === '1';
  let licenseStatus = 'ok';
  let licenseDetail = 'Licencia activa';
  try {
    const lic = getLicenseStatus(dataDir);
    if (lic.blocked) {
      licenseStatus = 'error';
      licenseDetail = 'Sin licencia valida o sistema bloqueado';
    } else if (lic.inGrace || lic.warningSoon) {
      licenseStatus = 'warn';
      licenseDetail = lic.inGrace
        ? `Periodo de gracia: ${lic.graceDaysLeft} dias`
        : `Licencia vence en ${lic.daysLeft} dias`;
    } else if (lic.licensed) {
      licenseDetail = `Licencia ${lic.expiry === 'Perpetua' ? 'perpetua' : 'vence ' + lic.expiry}`;
    }
  } catch (e) {
    licenseStatus = 'warn';
    licenseDetail = e.message;
  }

  const hasError = activeUsers === 0 || admins === 0 || licenseStatus === 'error';
  const hasWarn = !passwordChanged || superadmins === 0 || licenseStatus === 'warn';
  return result('security', 'Seguridad operativa', statusFrom(hasError, hasWarn),
    `${activeUsers} usuarios activos | ${admins} administradores | ${licenseDetail}`,
    {
      category: 'seguridad',
      impact: hasError
        ? 'El sistema puede quedar sin administrador o bloqueado por licencia.'
        : hasWarn
          ? 'Hay ajustes de seguridad pendientes.'
          : 'Permisos y licencia en orden.',
      fix: hasError
        ? 'Crear/activar un administrador y resolver licencia.'
        : hasWarn
          ? 'Cambiar clave inicial y confirmar superadmin de soporte.'
          : 'Sin accion requerida.',
      value: { activeUsers, admins, superadmins, passwordChanged, licenseStatus },
    }
  );
}

function diagnoseCodeApi({ appRoot }) {
  const files = listFiles(appRoot, ['main.js', 'preload.js']);
  if (files.length < 2) {
    return result('code_api', 'Codigo / IPC', 'warn', 'No se pudieron leer main.js y preload.js', {
      category: 'codigo',
      impact: 'No se pudo validar que el renderer y main process esten sincronizados.',
      fix: 'Ejecutar diagnostico desde una instalacion con archivos fuente disponibles.',
    });
  }

  const mainText = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'preload.js'), 'utf8');
  const mainMatches = [...mainText.matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
  const preloadMatches = [...preloadText.matchAll(/ipcRenderer\.invoke\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
  const mainSet = new Set(mainMatches);
  const preloadSet = new Set(preloadMatches);
  const missingHandlers = [...preloadSet].filter(ch => !mainSet.has(ch)).sort();
  const duplicateInvokes = Object.entries(preloadMatches.reduce((acc, ch) => {
    acc[ch] = (acc[ch] || 0) + 1;
    return acc;
  }, {})).filter(([, n]) => n > 1).map(([ch, n]) => `${ch} x${n}`);
  const hiddenHandlers = [...mainSet].filter(ch => !preloadSet.has(ch)).sort();

  const hasError = missingHandlers.length > 0;
  const hasWarn = duplicateInvokes.length > 0 || hiddenHandlers.length > 10;
  return result('code_api', 'Codigo / IPC', statusFrom(hasError, hasWarn),
    `${mainSet.size} handlers main | ${preloadSet.size} canales renderer` +
      (missingHandlers.length ? ` | faltan ${missingHandlers.length}` : '') +
      (duplicateInvokes.length ? ` | duplicados ${duplicateInvokes.length}` : ''),
    {
      category: 'codigo',
      impact: hasError
        ? 'Una pantalla puede llamar un canal inexistente y fallar en produccion.'
        : hasWarn
          ? 'Hay duplicados o handlers internos que conviene revisar.'
          : 'Renderer y main process estan sincronizados.',
      fix: hasError
        ? `Implementar o quitar canales faltantes: ${missingHandlers.slice(0, 5).join(', ')}`
        : duplicateInvokes.length
          ? `Eliminar duplicados expuestos: ${duplicateInvokes.slice(0, 5).join(', ')}`
          : 'Sin accion requerida.',
      value: {
        missingHandlers,
        duplicateInvokes,
        hiddenHandlers: hiddenHandlers.slice(0, 20),
      },
    }
  );
}

function diagnoseSystem({ dataDir }) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsed = Math.round((1 - freeMem / totalMem) * 100);
  let diskFreeGB = null;
  let diskDetail = '';

  try {
    if (process.platform === 'win32') {
      const drive = dataDir.split(':')[0] + ':';
      const out = childProcess.execFileSync(
        'wmic',
        ['logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'FreeSpace', '/value'],
        { timeout: 3000 }
      ).toString();
      const match = out.match(/FreeSpace=(\d+)/);
      if (match) diskFreeGB = round2(Number(match[1]) / 1024 / 1024 / 1024);
    } else {
      const out = childProcess.execFileSync('df', ['-k', dataDir], { timeout: 3000 }).toString();
      const line = out.trim().split(/\n/).slice(-1)[0] || '';
      const parts = line.split(/\s+/);
      if (parts.length >= 4) diskFreeGB = round2(Number(parts[3]) / 1024 / 1024);
    }
  } catch {}

  if (diskFreeGB != null) diskDetail = ` | Disco libre ${diskFreeGB} GB`;
  const now = new Date();
  const badYear = now.getFullYear() < 2025 || now.getFullYear() > 2035;
  const lowDisk = diskFreeGB != null && diskFreeGB < 1;
  const warnDisk = diskFreeGB != null && diskFreeGB < 3;
  const status = statusFrom(badYear || lowDisk, memUsed > 92 || warnDisk);

  return result('system', 'Sistema operativo', status,
    `RAM usada ${pct(memUsed)}${diskDetail} | ${now.toLocaleString('es-DO')}`,
    {
      category: 'sistema',
      impact: status === 'ok'
        ? 'Recursos basicos suficientes para operar.'
        : badYear
          ? 'Fecha incorrecta afecta facturas, reportes, backups y NCF.'
          : 'Poco recurso del equipo puede causar lentitud o fallos al guardar.',
      fix: badYear
        ? 'Corregir fecha y hora del equipo.'
        : lowDisk || warnDisk
          ? 'Liberar espacio antes de seguir acumulando ventas/backups.'
          : 'Cerrar aplicaciones pesadas si el POS esta lento.',
      value: { memUsed, diskFreeGB, timestamp: now.toISOString() },
    }
  );
}

async function diagnosePrinter({ settingsRepo, mainWindow }) {
  const printerSaved = settingsRepo.getAll()?.printer || '';
  if (!printerSaved) {
    return result('printer', 'Impresora', 'warn', 'No hay impresora fija configurada', {
      category: 'hardware',
      impact: 'El sistema usara el dialogo o impresora por defecto.',
      fix: 'Configurar impresora de recibos desde Configuracion.',
    });
  }
  if (!mainWindow?.webContents?.getPrintersAsync) {
    return result('printer', 'Impresora', 'warn', `"${printerSaved}" configurada; no se pudo consultar el sistema`, {
      category: 'hardware',
      impact: 'No se confirmo si la impresora existe en este equipo.',
      fix: 'Abrir Configuracion e imprimir prueba.',
    });
  }
  const printers = await mainWindow.webContents.getPrintersAsync();
  const found = printers.find(p => p.name === printerSaved);
  return result('printer', 'Impresora', found ? 'ok' : 'error',
    found ? `"${printerSaved}" encontrada` : `"${printerSaved}" configurada pero no encontrada`,
    {
      category: 'hardware',
      impact: found ? 'Tickets y comprobantes pueden imprimirse.' : 'Las ventas pueden quedarse sin comprobante impreso.',
      fix: found ? 'Sin accion requerida.' : 'Reconectar/instalar impresora o cambiar impresora configurada.',
      value: { configured: printerSaved, found: !!found },
    }
  );
}

async function runSystemDoctor({ db, dataDir, appRoot, cashRepo, settingsRepo, getLicenseStatus, mainWindow }) {
  const results = [];

  safeSection(results, 'db', 'Base de datos', () => diagnoseDatabase({ db, dataDir }));
  safeSection(results, 'backup', 'Backups', () => diagnoseBackups({ dataDir }));
  safeSection(results, 'cash', 'Caja real', () => diagnoseCash({ db, cashRepo }));
  safeSection(results, 'sales_logic', 'Logica de ventas', () => diagnoseSales({ db }));
  safeSection(results, 'inventory_logic', 'Inventario real', () => diagnoseInventory({ db }));
  safeSection(results, 'credit_logic', 'Credito y cuentas por cobrar', () => diagnoseCredit({ db }));
  safeSection(results, 'fiscal_logic', 'Fiscal / NCF / e-CF', () => diagnoseFiscal({ db, settingsRepo }));
  safeSection(results, 'accounting_logic', 'Contabilidad', () => diagnoseAccounting({ db, settingsRepo }));
  safeSection(results, 'security', 'Seguridad operativa', () => diagnoseSecurity({ db, settingsRepo, getLicenseStatus, dataDir }));
  safeSection(results, 'code_api', 'Codigo / IPC', () => diagnoseCodeApi({ appRoot }));
  safeSection(results, 'system', 'Sistema operativo', () => diagnoseSystem({ dataDir }));
  await safeAsyncSection(results, 'printer', 'Impresora', () => diagnosePrinter({ settingsRepo, mainWindow }));

  const errors = results.filter(r => r.status === 'error').length;
  const warns = results.filter(r => r.status === 'warn').length;
  const score = errors > 0 ? 'critical' : warns > 0 ? 'warn' : 'healthy';
  const critical = results.filter(r => r.status === 'error').map(r => r.label);

  return {
    ok: true,
    results,
    score,
    errors,
    warns,
    critical,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { runSystemDoctor };
