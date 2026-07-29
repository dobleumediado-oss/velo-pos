'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SALE_CORRECTION_PERMISSIONS = Object.freeze([
  'sales.view',
  'sales.correct',
  'sales.change_date',
  'sales.edit_internal_data',
  'sales.request_return',
  'sales.approve_return',
  'sales.issue_credit_note',
  'sales.issue_debit_note',
  'sales.cancel',
  'sales.replace_invoice',
  'sales.refund',
  'sales.override_closed_cash',
  'sales.override_closed_period',
  'sales.view_audit',
]);

function _tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function _columns(db, table) {
  return _tableExists(db, table)
    ? db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    : [];
}

function _addColumn(db, table, column, definition) {
  if (!_tableExists(db, table) || _columns(db, table).includes(column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

/**
 * Esquema idempotente. Se invoca en cada initDB para que bases temporales y
 * herramientas que no ejecutan versioning también tengan la semántica nueva.
 */
function ensureSaleCorrectionsSchema(db) {
  if (!db || !_tableExists(db, 'sales')) return;

  [
    ['original_sale_date', 'TEXT'],
    ['sale_date', 'TEXT'],
    ['fiscal_issued_at', 'TEXT'],
    ['date_modified_at', 'TEXT'],
    ['date_modified_by', 'INTEGER'],
    ['date_change_reason', "TEXT DEFAULT ''"],
    ['updated_at', 'TEXT'],
    ['revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['administrative_data', "TEXT NOT NULL DEFAULT '{}'"],
    ['correction_kind', "TEXT NOT NULL DEFAULT ''"],
  ].forEach(([column, definition]) => _addColumn(db, 'sales', column, definition));

  _addColumn(db, 'inventory_movements', 'operational_sale_date', 'TEXT');
  _addColumn(db, 'inventory_movements', 'correction_id', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_corrections (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id            INTEGER NOT NULL REFERENCES sales(id),
      action             TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'applied'
                           CHECK(status IN ('requested','approved','applied','rejected')),
      reason             TEXT NOT NULL,
      requested_by       INTEGER NOT NULL REFERENCES users(id),
      authorized_by      INTEGER REFERENCES users(id),
      cash_session_id    INTEGER REFERENCES cash_sessions(id),
      branch_id          INTEGER,
      terminal_id        TEXT DEFAULT '',
      idempotency_key    TEXT NOT NULL UNIQUE,
      before_data        TEXT NOT NULL,
      after_data         TEXT NOT NULL,
      affected_modules   TEXT NOT NULL DEFAULT '[]',
      metadata           TEXT NOT NULL DEFAULT '{}',
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sale_date_history (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id            INTEGER NOT NULL REFERENCES sales(id),
      correction_id      INTEGER NOT NULL REFERENCES sale_corrections(id),
      original_sale_date TEXT NOT NULL,
      previous_sale_date TEXT NOT NULL,
      new_sale_date      TEXT NOT NULL,
      fiscal_issued_at   TEXT,
      reason             TEXT NOT NULL,
      changed_by         INTEGER NOT NULL REFERENCES users(id),
      authorized_by      INTEGER REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sale_correction_role_permissions (
      role        TEXT NOT NULL,
      permission  TEXT NOT NULL,
      allowed     INTEGER NOT NULL DEFAULT 1 CHECK(allowed IN (0,1)),
      PRIMARY KEY(role, permission)
    );

    CREATE TABLE IF NOT EXISTS commission_adjustments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id               INTEGER NOT NULL REFERENCES sales(id),
      correction_id         INTEGER NOT NULL REFERENCES sale_corrections(id),
      commission_run_id     INTEGER,
      salesperson_id        INTEGER,
      previous_sale_date    TEXT NOT NULL,
      new_sale_date         TEXT NOT NULL,
      commission_amount     REAL NOT NULL DEFAULT 0,
      original_run_status   TEXT DEFAULT '',
      status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','applied','settled','voided')),
      reason                TEXT NOT NULL,
      created_by            INTEGER NOT NULL REFERENCES users(id),
      created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sale_correction_documents (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_id  INTEGER NOT NULL REFERENCES sale_corrections(id),
      sale_id        INTEGER NOT NULL REFERENCES sales(id),
      document_role  TEXT NOT NULL
                       CHECK(document_role IN ('credit','supplemental_invoice')),
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(correction_id,sale_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sales_sale_date
      ON sales(sale_date);
    CREATE INDEX IF NOT EXISTS idx_sales_fiscal_issued
      ON sales(fiscal_issued_at);
    CREATE INDEX IF NOT EXISTS idx_sale_corrections_sale
      ON sale_corrections(sale_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_date_history_sale
      ON sale_date_history(sale_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_operational_date
      ON inventory_movements(operational_sale_date);
    CREATE INDEX IF NOT EXISTS idx_commission_adjustments_sale
      ON commission_adjustments(sale_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_correction_documents_correction
      ON sale_correction_documents(correction_id, sale_id);
    CREATE INDEX IF NOT EXISTS idx_sale_correction_documents_sale
      ON sale_correction_documents(sale_id, correction_id);

    CREATE TRIGGER IF NOT EXISTS trg_sales_dates_after_insert
    AFTER INSERT ON sales
    WHEN NEW.original_sale_date IS NULL OR NEW.sale_date IS NULL OR NEW.updated_at IS NULL
    BEGIN
      UPDATE sales
      SET original_sale_date=COALESCE(NEW.original_sale_date,date(NEW.created_at)),
          sale_date=COALESCE(NEW.sale_date,date(NEW.created_at)),
          updated_at=COALESCE(NEW.updated_at,NEW.created_at,datetime('now','localtime'))
      WHERE id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_fiscal_after_insert
    AFTER INSERT ON sales
    WHEN TRIM(COALESCE(NEW.ncf,''))<>'' AND NEW.fiscal_issued_at IS NULL
    BEGIN
      UPDATE sales
      SET fiscal_issued_at=COALESCE(NEW.created_at,datetime('now','localtime'))
      WHERE id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_fiscal_when_ncf_issued
    AFTER UPDATE OF ncf ON sales
    WHEN TRIM(COALESCE(OLD.ncf,''))=''
      AND TRIM(COALESCE(NEW.ncf,''))<>''
      AND NEW.fiscal_issued_at IS NULL
    BEGIN
      UPDATE sales
      SET fiscal_issued_at=datetime('now','localtime')
      WHERE id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_original_date_immutable
    BEFORE UPDATE OF original_sale_date ON sales
    WHEN OLD.original_sale_date IS NOT NULL
      AND NEW.original_sale_date IS NOT OLD.original_sale_date
    BEGIN
      SELECT RAISE(ABORT, 'original_sale_date es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_created_at_immutable
    BEFORE UPDATE OF created_at ON sales
    WHEN NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'created_at es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_fiscal_date_immutable
    BEFORE UPDATE OF fiscal_issued_at ON sales
    WHEN OLD.fiscal_issued_at IS NOT NULL
      AND NEW.fiscal_issued_at IS NOT OLD.fiscal_issued_at
    BEGIN
      SELECT RAISE(ABORT, 'fiscal_issued_at es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sale_corrections_no_update
    BEFORE UPDATE ON sale_corrections
    BEGIN
      SELECT RAISE(ABORT, 'El historial de correcciones es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sale_corrections_no_delete
    BEFORE DELETE ON sale_corrections
    BEGIN
      SELECT RAISE(ABORT, 'El historial de correcciones es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sale_date_history_no_update
    BEFORE UPDATE ON sale_date_history
    BEGIN
      SELECT RAISE(ABORT, 'El historial de fechas es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sale_date_history_no_delete
    BEFORE DELETE ON sale_date_history
    BEGIN
      SELECT RAISE(ABORT, 'El historial de fechas es inmutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sale_correction_documents_no_update
    BEFORE UPDATE ON sale_correction_documents
    BEGIN
      SELECT RAISE(ABORT, 'Los documentos de una corrección son inmutables');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sale_correction_documents_no_delete
    BEFORE DELETE ON sale_correction_documents
    BEGIN
      SELECT RAISE(ABORT, 'Los documentos de una corrección son inmutables');
    END;
  `);

  const now = db.prepare("SELECT datetime('now','localtime') value").get().value;
  db.prepare(`
    UPDATE sales
    SET original_sale_date=COALESCE(NULLIF(original_sale_date,''),date(created_at)),
        sale_date=COALESCE(NULLIF(sale_date,''),date(created_at)),
        updated_at=COALESCE(updated_at,created_at,?)
    WHERE original_sale_date IS NULL OR original_sale_date=''
       OR sale_date IS NULL OR sale_date=''
       OR updated_at IS NULL
  `).run(now);

  if (_tableExists(db, 'ncf_log')) {
    db.prepare(`
      UPDATE sales
      SET fiscal_issued_at=COALESCE(
        (SELECT nl.issued_at FROM ncf_log nl
         WHERE nl.sale_id=sales.id ORDER BY nl.id LIMIT 1),
        created_at
      )
      WHERE TRIM(COALESCE(ncf,''))<>'' AND fiscal_issued_at IS NULL
    `).run();
  }
  if (_tableExists(db, 'ecf_log')) {
    db.prepare(`
      UPDATE sales
      SET fiscal_issued_at=COALESCE(
        (SELECT el.emitido_at FROM ecf_log el
         WHERE el.sale_id=sales.id ORDER BY el.id LIMIT 1),
        fiscal_issued_at,
        created_at
      )
      WHERE EXISTS(SELECT 1 FROM ecf_log el WHERE el.sale_id=sales.id)
        AND fiscal_issued_at IS NULL
    `).run();
  }
  if (_tableExists(db, 'inventory_movements')) {
    db.prepare(`
      UPDATE inventory_movements
      SET operational_sale_date=(
        SELECT s.sale_date FROM sales s WHERE s.id=inventory_movements.sale_id
      )
      WHERE sale_id IS NOT NULL
        AND (operational_sale_date IS NULL OR operational_sale_date='')
    `).run();
  }

  const grant = db.prepare(`
    INSERT INTO sale_correction_role_permissions(role,permission,allowed)
    VALUES(?,?,1) ON CONFLICT(role,permission) DO NOTHING
  `);
  const manager = [
    'sales.view', 'sales.correct', 'sales.change_date',
    'sales.edit_internal_data', 'sales.request_return',
    'sales.approve_return', 'sales.issue_credit_note',
    'sales.issue_debit_note', 'sales.cancel', 'sales.refund', 'sales.override_closed_cash',
    'sales.view_audit',
  ];
  const cashier = ['sales.view', 'sales.request_return'];
  SALE_CORRECTION_PERMISSIONS.forEach(permission => grant.run('superadmin', permission));
  manager.forEach(permission => grant.run('admin', permission));
  cashier.forEach(permission => grant.run('cajero', permission));

  db.prepare(`
    INSERT INTO settings(key,value) VALUES('sales_allow_future_date','0')
    ON CONFLICT(key) DO NOTHING
  `).run();
}

function _validDate(value) {
  const clean = String(value || '').trim();
  if (!DATE_RE.test(clean)) return '';
  const parsed = new Date(`${clean}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === clean
    ? clean
    : '';
}

function _json(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function _serialize(value) {
  return JSON.stringify(value == null ? {} : value);
}

function _snapshot(sale) {
  return {
    id: sale.id,
    document_number: sale.document_number,
    document_number_fmt: sale.document_number_fmt,
    numero_factura: sale.numero_factura,
    numero_factura_fmt: sale.numero_factura_fmt,
    ncf: sale.ncf || '',
    type: sale.type,
    status: sale.status,
    customer_id: sale.customer_id,
    customer_name: sale.customer_name,
    customer_rnc: sale.customer_rnc,
    subtotal: sale.subtotal,
    discount_pct: sale.discount_pct,
    discount_amt: sale.discount_amt,
    tax_pct: sale.tax_pct,
    tax_amt: sale.tax_amt,
    total: sale.total,
    payment_method: sale.payment_method,
    cash_session_id: sale.cash_session_id,
    salesperson_id: sale.salesperson_id,
    created_at: sale.created_at,
    original_sale_date: sale.original_sale_date,
    sale_date: sale.sale_date,
    fiscal_issued_at: sale.fiscal_issued_at,
    revision: sale.revision || 0,
    administrative_data: _json(sale.administrative_data, {}),
  };
}

function createSaleCorrectionsRepo({ getDb, salesRepo, returnsRepo }) {
  const db = () => getDb();

  function userById(userId) {
    return db().prepare('SELECT id,name,role,active FROM users WHERE id=?').get(Number(userId));
  }

  function hasPermission(userOrId, permission) {
    const user = typeof userOrId === 'object' ? userOrId : userById(userOrId);
    if (!user || user.active === 0 || !SALE_CORRECTION_PERMISSIONS.includes(permission)) return false;
    return !!db().prepare(`
      SELECT 1 FROM sale_correction_role_permissions
      WHERE role=? AND permission=? AND allowed=1
    `).get(user.role, permission);
  }

  function requirePermission(user, permission) {
    if (!hasPermission(user, permission)) {
      const error = new Error(`Permiso requerido: ${permission}`);
      error.code = 'FORBIDDEN';
      throw error;
    }
  }

  function closedCashForDate(date) {
    return db().prepare(`
      SELECT id,cajero,open_date,close_date,status
      FROM cash_sessions
      WHERE status='closed'
        AND date(?) BETWEEN date(open_date) AND date(COALESCE(close_date,open_date))
      ORDER BY id DESC LIMIT 1
    `).get(date);
  }

  function closedPeriodForDate(date) {
    if (!_tableExists(db(), 'accounting_periods')) return null;
    return db().prepare(`
      SELECT id,name,date_from,date_to,status
      FROM accounting_periods
      WHERE status='cerrado' AND date_from<=? AND date_to>=?
      ORDER BY id DESC LIMIT 1
    `).get(date, date);
  }

  function commissionLinks(saleId) {
    if (!_tableExists(db(), 'seller_commission_lines')) return [];
    return db().prepare(`
      SELECT l.id line_id,l.commission_run_id,l.sale_date,l.commission_amount,
             r.salesperson_id,r.date_from,r.date_to,r.status run_status
      FROM seller_commission_lines l
      JOIN seller_commission_runs r ON r.id=l.commission_run_id
      WHERE l.source_type='sistema' AND l.source_id=?
        AND r.status!='anulado'
      ORDER BY r.id
    `).all(saleId);
  }

  function ecfState(saleId) {
    if (!_tableExists(db(), 'ecf_log')) return null;
    return db().prepare(`
      SELECT estado,emitido_at,encf
      FROM ecf_log WHERE sale_id=? ORDER BY id DESC LIMIT 1
    `).get(saleId);
  }

  function impact(saleId, newSaleDate, userId) {
    const sale = db().prepare('SELECT * FROM sales WHERE id=?').get(Number(saleId));
    if (!sale) throw new Error('Venta no encontrada');
    const user = userById(userId);
    if (!user) throw new Error('Usuario no encontrado');
    const date = newSaleDate ? _validDate(newSaleDate) : sale.sale_date;
    if (!date) throw new Error('Fecha inválida');
    const cash = sale.cash_session_id
      ? db().prepare('SELECT id,cajero,open_date,close_date,status FROM cash_sessions WHERE id=?').get(sale.cash_session_id)
      : null;
    const targetClosedCash = closedCashForDate(date);
    const targetClosedPeriod = closedPeriodForDate(date);
    const ecf = ecfState(sale.id);
    const commissions = commissionLinks(sale.id);
    const payments = db().prepare(`
      SELECT COUNT(*) count,COALESCE(SUM(amount),0) total,
             MAX(created_at) last_payment_at
      FROM payments WHERE sale_id=?
    `).get(sale.id);
    const returns = db().prepare(`
      SELECT COUNT(*) count,COALESCE(SUM(total),0) total
      FROM sales
      WHERE original_sale_id=? AND type='devolucion' AND status!='cancelled'
    `).get(sale.id);
    const inventory = db().prepare(`
      SELECT COUNT(*) count,COALESCE(SUM(ABS(qty)),0) units
      FROM inventory_movements WHERE sale_id=?
    `).get(sale.id);
    const accounting = _tableExists(db(), 'accounting_entries')
      ? db().prepare(`
          SELECT COUNT(*) count,
                 SUM(CASE WHEN status='confirmado' THEN 1 ELSE 0 END) confirmed
          FROM accounting_entries
          WHERE source_module IN ('venta','devolucion') AND source_id=?
        `).get(sale.id)
      : { count: 0, confirmed: 0 };
    const reconciledFinancial = _tableExists(db(), 'financial_movements') &&
      _columns(db(), 'financial_movements').includes('reconciled')
      ? db().prepare(`
          SELECT COUNT(*) count FROM financial_movements
          WHERE reference_type='sale' AND reference_id=? AND reconciled=1
        `).get(sale.id)
      : { count: 0 };

    const warnings = [];
    if (targetClosedCash) {
      warnings.push({
        code: 'CLOSED_CASH',
        severity: 'high',
        message: `La fecha pertenece a la caja cerrada #${targetClosedCash.id}. El cierre y sus movimientos no serán modificados.`,
        requiresPermission: 'sales.override_closed_cash',
        permitted: hasPermission(user, 'sales.override_closed_cash'),
      });
    }
    if (targetClosedPeriod) {
      warnings.push({
        code: 'CLOSED_ACCOUNTING_PERIOD',
        severity: 'high',
        message: `El período contable "${targetClosedPeriod.name}" está cerrado. Los asientos contabilizados conservarán su fecha.`,
        requiresPermission: 'sales.override_closed_period',
        permitted: hasPermission(user, 'sales.override_closed_period'),
      });
    }
    if (ecf) {
      warnings.push({
        code: 'FISCAL_DATE_IMMUTABLE',
        severity: 'high',
        message: `El e-CF está ${ecf.estado || 'emitido'}; su fecha fiscal permanecerá en ${String(sale.fiscal_issued_at || ecf.emitido_at || '').slice(0, 10)}.`,
        permitted: true,
      });
    } else if (sale.ncf) {
      warnings.push({
        code: 'NCF_DATE_IMMUTABLE',
        severity: 'medium',
        message: 'El NCF y su fecha de emisión fiscal permanecerán sin cambios.',
        permitted: true,
      });
    }
    commissions.forEach(link => {
      warnings.push({
        code: `COMMISSION_${String(link.run_status).toUpperCase()}`,
        severity: link.run_status === 'pagado' ? 'high' : 'medium',
        message: link.run_status === 'borrador'
          ? 'La venta se moverá o retirará del corte de comisión en borrador para recalcularlo.'
          : `La comisión está ${link.run_status}; se conservará y se generará un ajuste de período.`,
        permitted: true,
      });
    });
    if (returns.count) {
      warnings.push({
        code: 'HAS_CREDIT_NOTE',
        severity: 'medium',
        message: `La factura tiene ${returns.count} devolución(es)/nota(s) de crédito relacionadas; no se alterarán.`,
        permitted: true,
      });
    }
    if (sale.payment_method === 'credito') {
      warnings.push({
        code: 'CREDIT_DUE_DATE_PRESERVED',
        severity: 'medium',
        message: 'La fecha de vencimiento y los abonos aplicados permanecerán sin cambios; cualquier recálculo requiere un proceso separado.',
        permitted: true,
      });
    }
    if (reconciledFinancial.count) {
      warnings.push({
        code: 'RECONCILED_PAYMENT_PRESERVED',
        severity: 'high',
        message: 'La factura tiene un movimiento financiero conciliado. La conciliación y la fecha del cobro no serán modificadas.',
        permitted: true,
      });
    }

    return {
      sale: { ...sale, administrative_data: _json(sale.administrative_data, {}) },
      permissions: SALE_CORRECTION_PERMISSIONS.filter(permission => hasPermission(user, permission)),
      cash,
      targetClosedCash,
      targetClosedPeriod,
      fiscal: ecf,
      payments,
      returns,
      inventory,
      accounting,
      reconciledFinancial,
      commissions,
      warnings,
      modules: [
        { id: 'sales', label: 'Ventas y reportes comerciales', effect: 'Se moverán a la nueva fecha operativa.' },
        { id: 'inventory', label: 'Inventario histórico', effect: 'Solo cambia la referencia operativa; el movimiento físico conserva su fecha real.' },
        { id: 'payments', label: 'Pagos y caja', effect: 'No cambian fechas ni cierres.' },
        { id: 'accounting', label: 'Contabilidad', effect: 'Los asientos existentes conservan su fecha de contabilización.' },
        { id: 'fiscal', label: 'NCF / e-CF', effect: 'El comprobante y la fecha fiscal no cambian.' },
        { id: 'commissions', label: 'Comisiones', effect: 'Se recalcula el borrador o se crea un ajuste si ya fue aprobado/pagado.' },
      ],
    };
  }

  function _recalculateCommissionRun(runId) {
    db().prepare(`
      UPDATE seller_commission_runs
      SET sales_total=COALESCE((SELECT SUM(sale_amount) FROM seller_commission_lines WHERE commission_run_id=?),0),
          margin_total=COALESCE((SELECT SUM(MAX(0,sale_amount-cost_amount)) FROM seller_commission_lines WHERE commission_run_id=?),0),
          commission_total=COALESCE((SELECT SUM(commission_amount) FROM seller_commission_lines WHERE commission_run_id=?),0)
      WHERE id=?
    `).run(runId, runId, runId, runId);
  }

  function changeDate({
    saleId, newSaleDate, reason, userId, authorizedByUserId,
    expectedRevision, idempotencyKey, terminalId, ipAddress,
  }) {
    const date = _validDate(newSaleDate);
    if (!date) throw new Error('Selecciona una fecha válida');
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (cleanReason.length < 5) throw new Error('El motivo es obligatorio y debe ser específico');
    const key = String(idempotencyKey || '').trim().slice(0, 120);
    if (key.length < 12) throw new Error('Clave de idempotencia inválida');

    const requester = userById(userId);
    if (!requester) throw new Error('Usuario solicitante no encontrado');
    requirePermission(requester, 'sales.correct');
    requirePermission(requester, 'sales.change_date');
    const authorizer = userById(authorizedByUserId || userId);
    if (!authorizer) throw new Error('Usuario autorizador no encontrado');
    requirePermission(authorizer, 'sales.change_date');

    const existing = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
    if (existing) {
      if (Number(existing.sale_id) !== Number(saleId) || existing.action !== 'change_sale_date') {
        throw new Error('La clave de idempotencia ya fue utilizada para otra operación');
      }
      return {
        idempotent: true,
        correctionId: existing.id,
        data: db().prepare('SELECT * FROM sales WHERE id=?').get(existing.sale_id),
        warnings: _json(existing.metadata, {}).warnings || [],
      };
    }

    const result = db().transaction(() => {
      const duplicate = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
      if (duplicate) {
        return {
          idempotent: true,
          correctionId: duplicate.id,
          data: db().prepare('SELECT * FROM sales WHERE id=?').get(duplicate.sale_id),
          warnings: _json(duplicate.metadata, {}).warnings || [],
        };
      }

      const sale = db().prepare('SELECT * FROM sales WHERE id=?').get(Number(saleId));
      if (!sale) throw new Error('Venta no encontrada');
      if (sale.type !== 'factura') throw new Error('Solo las facturas emitidas usan este flujo de corrección');
      if (sale.status !== 'completed') throw new Error('La factura anulada o devuelta totalmente no puede cambiar de fecha');
      if (date === sale.sale_date) throw new Error('La nueva fecha es igual a la fecha operativa actual');
      if (expectedRevision != null && Number(expectedRevision) !== Number(sale.revision || 0)) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga el detalle antes de continuar.');
        error.code = 'CONFLICT';
        throw error;
      }

      const allowFuture = db().prepare("SELECT value FROM settings WHERE key='sales_allow_future_date'").get()?.value === '1';
      const today = db().prepare("SELECT date('now','localtime') value").get().value;
      if (date > today && !allowFuture) throw new Error('La configuración actual no permite mover facturas a fechas futuras');

      const details = impact(sale.id, date, requester.id);
      const blocking = details.warnings.find(warning => warning.requiresPermission && !warning.permitted);
      if (blocking) throw new Error(`${blocking.message} Permiso requerido: ${blocking.requiresPermission}`);
      if (details.targetClosedCash) requirePermission(authorizer, 'sales.override_closed_cash');
      if (details.targetClosedPeriod) requirePermission(authorizer, 'sales.override_closed_period');

      const before = _snapshot(sale);
      const previousDate = sale.sale_date || String(sale.created_at || '').slice(0, 10);
      const affectedModules = ['sales', 'commercial_reports', 'inventory_operational_history'];
      if (details.commissions.length) affectedModules.push('commissions');
      const now = db().prepare("SELECT datetime('now','localtime') value").get().value;

      const update = db().prepare(`
        UPDATE sales
        SET sale_date=?,
            date_modified_at=?,
            date_modified_by=?,
            date_change_reason=?,
            updated_at=?,
            revision=revision+1
        WHERE id=? AND revision=?
      `).run(date, now, requester.id, cleanReason, now, sale.id, sale.revision || 0);
      if (update.changes !== 1) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga el detalle antes de continuar.');
        error.code = 'CONFLICT';
        throw error;
      }

      if (_tableExists(db(), 'inventory_movements')) {
        db().prepare(`
          UPDATE inventory_movements SET operational_sale_date=?
          WHERE sale_id=?
        `).run(date, sale.id);
      }

      const commissionChanges = [];
      for (const link of details.commissions) {
        if (link.run_status === 'borrador') {
          if (date >= link.date_from && date <= link.date_to) {
            db().prepare('UPDATE seller_commission_lines SET sale_date=? WHERE id=?').run(date, link.line_id);
            commissionChanges.push({ runId: link.commission_run_id, action: 'moved_in_draft', amount: link.commission_amount });
          } else {
            db().prepare('DELETE FROM seller_commission_lines WHERE id=?').run(link.line_id);
            commissionChanges.push({ runId: link.commission_run_id, action: 'removed_from_draft', amount: link.commission_amount });
          }
          _recalculateCommissionRun(link.commission_run_id);
        }
      }

      const afterSale = db().prepare('SELECT * FROM sales WHERE id=?').get(sale.id);
      const after = _snapshot(afterSale);
      const metadata = {
        warnings: details.warnings,
        ipAddress: String(ipAddress || '').slice(0, 80),
        paymentDatesPreserved: true,
        cashClosuresPreserved: true,
        accountingDatesPreserved: true,
        fiscalDatePreserved: true,
        commissionChanges,
      };
      const correction = db().prepare(`
        INSERT INTO sale_corrections(
          sale_id,action,status,reason,requested_by,authorized_by,cash_session_id,
          terminal_id,idempotency_key,before_data,after_data,affected_modules,metadata
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        sale.id, 'change_sale_date', 'applied', cleanReason,
        requester.id, authorizer.id, sale.cash_session_id || null,
        String(terminalId || '').slice(0, 120), key,
        _serialize(before), _serialize(after), _serialize(affectedModules), _serialize(metadata)
      );
      const correctionId = Number(correction.lastInsertRowid);

      for (const link of details.commissions) {
        if (link.run_status === 'aprobado' || link.run_status === 'pagado') {
          db().prepare(`
            INSERT INTO commission_adjustments(
              sale_id,correction_id,commission_run_id,salesperson_id,
              previous_sale_date,new_sale_date,commission_amount,
              original_run_status,status,reason,created_by
            ) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)
          `).run(
            sale.id, correctionId, link.commission_run_id, link.salesperson_id,
            previousDate, date, link.commission_amount || 0,
            link.run_status, cleanReason, requester.id
          );
        }
      }

      db().prepare(`
        INSERT INTO sale_date_history(
          sale_id,correction_id,original_sale_date,previous_sale_date,new_sale_date,
          fiscal_issued_at,reason,changed_by,authorized_by
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        sale.id, correctionId, sale.original_sale_date || previousDate,
        previousDate, date, sale.fiscal_issued_at || null,
        cleanReason, requester.id, authorizer.id
      );

      db().prepare(`
        INSERT INTO audit_logs(user_id,user_name,action,entity,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        requester.id, requester.name, 'fecha_operativa_venta_cambiada',
        'sales', sale.id,
        _serialize({
          correctionId,
          previousSaleDate: previousDate,
          newSaleDate: date,
          originalSaleDate: sale.original_sale_date,
          fiscalIssuedAt: sale.fiscal_issued_at,
          reason: cleanReason,
          authorizedBy: authorizer.id,
        }),
        now
      );

      return {
        idempotent: false,
        correctionId,
        data: afterSale,
        warnings: details.warnings,
      };
    })();

    return result;
  }

  function updateAdministrativeData({
    saleId, values, reason, userId, expectedRevision, idempotencyKey, terminalId,
  }) {
    const requester = userById(userId);
    if (!requester) throw new Error('Usuario no encontrado');
    requirePermission(requester, 'sales.correct');
    requirePermission(requester, 'sales.edit_internal_data');
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (cleanReason.length < 5) throw new Error('El motivo es obligatorio');
    const key = String(idempotencyKey || '').trim().slice(0, 120);
    if (key.length < 12) throw new Error('Clave de idempotencia inválida');
    const allowed = ['internal_note', 'order_reference', 'purchase_order', 'driver', 'route',
      'delivery_info', 'admin_comment', 'tags', 'non_fiscal_contact'];
    const patch = {};
    allowed.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(values || {}, field)) {
        patch[field] = String(values[field] == null ? '' : values[field]).trim().slice(0, field === 'delivery_info' ? 1000 : 500);
      }
    });
    if (!Object.keys(patch).length) throw new Error('No hay información administrativa para guardar');

    return db().transaction(() => {
      const existing = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
      if (existing) {
        return { idempotent: true, correctionId: existing.id, data: db().prepare('SELECT * FROM sales WHERE id=?').get(existing.sale_id) };
      }
      const sale = db().prepare('SELECT * FROM sales WHERE id=?').get(Number(saleId));
      if (!sale) throw new Error('Venta no encontrada');
      if (sale.status === 'cancelled') throw new Error('Una factura anulada no admite cambios administrativos');
      if (expectedRevision != null && Number(expectedRevision) !== Number(sale.revision || 0)) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga el detalle.');
        error.code = 'CONFLICT';
        throw error;
      }
      const before = _snapshot(sale);
      const admin = { ..._json(sale.administrative_data, {}), ...patch };
      const now = db().prepare("SELECT datetime('now','localtime') value").get().value;
      const changed = db().prepare(`
        UPDATE sales SET administrative_data=?,updated_at=?,revision=revision+1
        WHERE id=? AND revision=?
      `).run(_serialize(admin), now, sale.id, sale.revision || 0);
      if (changed.changes !== 1) throw new Error('La factura fue modificada por otro usuario. Recarga el detalle.');
      const updated = db().prepare('SELECT * FROM sales WHERE id=?').get(sale.id);
      const correction = db().prepare(`
        INSERT INTO sale_corrections(
          sale_id,action,status,reason,requested_by,authorized_by,cash_session_id,
          terminal_id,idempotency_key,before_data,after_data,affected_modules,metadata
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        sale.id, 'update_administrative_data', 'applied', cleanReason,
        requester.id, requester.id, sale.cash_session_id || null,
        String(terminalId || '').slice(0, 120), key,
        _serialize(before), _serialize(_snapshot(updated)),
        _serialize(['sales_administration']), _serialize({ changedFields: Object.keys(patch) })
      );
      db().prepare(`
        INSERT INTO audit_logs(user_id,user_name,action,entity,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        requester.id, requester.name, 'datos_administrativos_venta_cambiados',
        'sales', sale.id,
        _serialize({ correctionId: Number(correction.lastInsertRowid), changedFields: Object.keys(patch), reason: cleanReason }),
        now
      );
      return { idempotent: false, correctionId: Number(correction.lastInsertRowid), data: updated };
    })();
  }

  function productCorrectionModel(saleId, userId) {
    const user = userById(userId);
    if (!user) throw new Error('Usuario no encontrado');
    requirePermission(user, 'sales.correct');

    const selected = db().prepare('SELECT * FROM sales WHERE id=?').get(Number(saleId));
    if (!selected) throw new Error('Factura no encontrada');
    const rootId = selected.correction_kind === 'product_addition' && selected.original_sale_id
      ? Number(selected.original_sale_id)
      : Number(selected.id);
    const root = db().prepare('SELECT * FROM sales WHERE id=?').get(rootId);
    if (!root || root.type !== 'factura') throw new Error('Solo se corrigen productos de una factura');
    if (root.status === 'cancelled') throw new Error('La factura anulada no admite correcciones');

    const sourceSales = db().prepare(`
      SELECT * FROM sales
      WHERE id=?
         OR (
           original_sale_id=?
           AND type='factura'
           AND correction_kind='product_addition'
           AND status!='cancelled'
         )
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, created_at, id
    `).all(root.id, root.id, root.id);

    const lines = [];
    for (const source of sourceSales) {
      const sourceLines = db().prepare(`
        SELECT
          MIN(si.id) sale_item_id,
          si.product_id,
          MAX(si.product_code) product_code,
          MAX(si.product_name) product_name,
          SUM(si.qty) original_qty,
          SUM(COALESCE(si.net_subtotal,si.unit_price*si.qty)) net_subtotal,
          SUM(COALESCE(si.tax_amt,0)) tax_amt,
          CASE WHEN SUM(si.qty)>0
            THEN SUM(si.unit_price*si.qty)/SUM(si.qty)
            ELSE 0 END unit_price,
          MAX(si.unit_cost) unit_cost,
          MAX(si.taxable) taxable,
          MAX(si.tax_pct) tax_pct,
          COALESCE((
            SELECT SUM(rsi.qty)
            FROM sales ret
            JOIN sale_items rsi ON rsi.sale_id=ret.id
            WHERE ret.type='devolucion'
              AND ret.original_sale_id=?
              AND ret.status!='cancelled'
              AND rsi.product_id=si.product_id
          ),0) returned_qty
        FROM sale_items si
        WHERE si.sale_id=?
        GROUP BY si.product_id
        ORDER BY MIN(si.id)
      `).all(source.id, source.id);
      for (const line of sourceLines) {
        const currentQty = Math.max(0, Number(line.original_qty || 0) - Number(line.returned_qty || 0));
        if (currentQty <= 0) continue;
        lines.push({
          ...line,
          source_sale_id: source.id,
          source_document_number: source.document_number_fmt || source.numero_factura_fmt || `#${source.id}`,
          source_kind: source.id === root.id ? 'original' : 'supplemental_invoice',
          current_qty: currentQty,
        });
      }
    }

    const products = db().prepare(`
      SELECT id,code,barcode,name,cost,price,wholesale,taxable,tax_pct,stock,unit
      FROM products WHERE active=1 ORDER BY name,id
    `).all();
    const fiscal = ecfState(root.id);
    const warnings = [];
    if (fiscal) {
      warnings.push({
        code: 'FISCAL_DOCUMENT_PRESERVED',
        severity: 'high',
        message: 'El e-CF original permanecerá intacto. Los aumentos quedarán respaldados internamente y la operación se mostrará como una sola factura Ajustada.',
      });
    } else if (root.ncf) {
      warnings.push({
        code: 'NCF_PRESERVED',
        severity: 'medium',
        message: 'El NCF original permanecerá intacto. Las reducciones generarán nota de crédito y los aumentos quedarán como respaldo interno de la factura Ajustada.',
      });
    }
    if (root.payment_method === 'mixto') {
      warnings.push({
        code: 'MIXED_PAYMENT',
        severity: 'medium',
        message: 'Para los aumentos debes escoger un método simple; las reducciones conservan la trazabilidad del pago original.',
      });
    }

    return {
      root: { ...root, administrative_data: _json(root.administrative_data, {}) },
      selectedSaleId: selected.id,
      lines,
      products,
      warnings,
      permissions: SALE_CORRECTION_PERMISSIONS.filter(permission => hasPermission(user, permission)),
    };
  }

  function correctProducts({
    saleId, lines, addedItems, reason, userId, expectedRevision,
    idempotencyKey, terminalId, session, additionPaymentMethod,
  }) {
    if (!salesRepo || !returnsRepo) throw new Error('El servicio de corrección de productos no está disponible');
    const requester = userById(userId);
    if (!requester) throw new Error('Usuario no encontrado');
    requirePermission(requester, 'sales.correct');
    const cleanReason = String(reason || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (cleanReason.length < 5) throw new Error('El motivo es obligatorio y debe ser específico');
    const key = String(idempotencyKey || '').trim().slice(0, 120);
    if (key.length < 12) throw new Error('Clave de idempotencia inválida');

    const selectedForKey = db().prepare(`
      SELECT id,original_sale_id,correction_kind FROM sales WHERE id=?
    `).get(Number(saleId));
    if (!selectedForKey) throw new Error('Factura no encontrada');
    const requestedRootId = selectedForKey.correction_kind === 'product_addition' &&
      selectedForKey.original_sale_id
      ? Number(selectedForKey.original_sale_id)
      : Number(selectedForKey.id);
    const existing = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
    if (existing) {
      if (existing.action !== 'correct_products' || Number(existing.sale_id) !== requestedRootId) {
        throw new Error('La clave de idempotencia ya fue utilizada para otra operación');
      }
      const metadata = _json(existing.metadata, {});
      return {
        idempotent: true,
        correctionId: existing.id,
        returnIds: metadata.returnIds || [],
        additionSaleId: metadata.additionSaleId || null,
        creditTotal: metadata.creditTotal || 0,
        additionTotal: metadata.additionTotal || 0,
        overpayment: metadata.overpayment || 0,
      };
    }

    const beforeModel = productCorrectionModel(saleId, requester.id);
    const beforeRoot = beforeModel.root;
    if (expectedRevision != null && Number(expectedRevision) !== Number(beforeRoot.revision || 0)) {
      const error = new Error('La factura fue modificada por otro usuario. Recarga la corrección antes de continuar.');
      error.code = 'CONFLICT';
      throw error;
    }

    const requestedLines = new Map();
    for (const row of Array.isArray(lines) ? lines : []) {
      const sourceSaleId = Number(row?.sourceSaleId);
      const productId = Number(row?.productId);
      const targetQty = Number(row?.targetQty);
      if (!Number.isInteger(sourceSaleId) || !Number.isInteger(productId) ||
          !Number.isInteger(targetQty) || targetQty < 0 || targetQty > 999999) {
        throw new Error('Hay una cantidad de producto inválida');
      }
      const lineKey = `${sourceSaleId}:${productId}`;
      if (requestedLines.has(lineKey)) throw new Error('Hay una línea de producto duplicada');
      requestedLines.set(lineKey, targetQty);
    }

    const reductionsBySale = new Map();
    const additionRows = [];
    for (const current of beforeModel.lines) {
      const lineKey = `${current.source_sale_id}:${current.product_id}`;
      const targetQty = requestedLines.has(lineKey)
        ? requestedLines.get(lineKey)
        : Number(current.current_qty);
      const delta = targetQty - Number(current.current_qty);
      if (delta < 0) {
        const group = reductionsBySale.get(Number(current.source_sale_id)) || [];
        group.push({ product_id: Number(current.product_id), qty: Math.abs(delta) });
        reductionsBySale.set(Number(current.source_sale_id), group);
      } else if (delta > 0) {
        const originalQty = Number(current.original_qty || 0);
        const snapshotTotal = Number(current.net_subtotal || 0) + Number(current.tax_amt || 0);
        const historicalUnitPrice = originalQty > 0 && snapshotTotal > 0
          ? Math.round((snapshotTotal / originalQty) * 100) / 100
          : Number(current.unit_price || 0);
        additionRows.push({
          product_id: Number(current.product_id),
          qty: delta,
          unit_price: historicalUnitPrice,
          taxable: current.taxable,
          tax_pct: current.tax_pct,
          price_source: 'historical',
        });
      }
    }

    for (const row of Array.isArray(addedItems) ? addedItems : []) {
      const productId = Number(row?.productId);
      const qty = Number(row?.qty);
      const unitPrice = Number(row?.unitPrice);
      if (!Number.isInteger(productId) || !Number.isInteger(qty) || qty <= 0 || qty > 999999) {
        throw new Error('Hay un producto agregado con cantidad inválida');
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 999999999) {
        throw new Error('Hay un producto agregado con precio inválido');
      }
      additionRows.push({
        product_id: productId,
        qty,
        unit_price: Math.round(unitPrice * 100) / 100,
        price_source: 'current_or_authorized',
      });
    }

    if (!reductionsBySale.size && !additionRows.length) {
      throw new Error('No hay cambios de productos para aplicar');
    }
    if (reductionsBySale.size) {
      requirePermission(requester, 'sales.request_return');
      requirePermission(requester, 'sales.issue_credit_note');
      const reductionNeedsCash = [...reductionsBySale.keys()].some(sourceSaleId => {
        const source = db().prepare('SELECT payment_method FROM sales WHERE id=?').get(sourceSaleId);
        return ['efectivo','mixto'].includes(String(source?.payment_method || '').toLowerCase());
      });
      if (reductionNeedsCash && !session?.id) {
        throw new Error('Debes tener la caja abierta para entregar el reembolso en efectivo');
      }
    }
    if (additionRows.length) {
      requirePermission(requester, 'sales.issue_debit_note');
    }

    const allowedMethods = new Set(['efectivo', 'tarjeta', 'transferencia', 'credito']);
    let method = String(additionPaymentMethod || beforeRoot.payment_method || 'efectivo').toLowerCase();
    if (!allowedMethods.has(method)) method = 'efectivo';
    if (additionRows.length && method !== 'credito' && !session?.id) {
      throw new Error('Debes tener la caja abierta para cobrar los productos agregados');
    }
    if (additionRows.length && method === 'credito' && Number(beforeRoot.customer_id) === 1) {
      throw new Error('Consumidor Final no puede recibir un aumento vinculado a crédito');
    }

    return db().transaction(() => {
      const duplicate = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
      if (duplicate) {
        if (duplicate.action !== 'correct_products' || Number(duplicate.sale_id) !== Number(beforeRoot.id)) {
          throw new Error('La clave de idempotencia ya fue utilizada para otra operación');
        }
        const metadata = _json(duplicate.metadata, {});
        return {
          idempotent: true,
          correctionId: duplicate.id,
          returnIds: metadata.returnIds || [],
          additionSaleId: metadata.additionSaleId || null,
          creditTotal: metadata.creditTotal || 0,
          additionTotal: metadata.additionTotal || 0,
          overpayment: metadata.overpayment || 0,
        };
      }
      const lockedRoot = db().prepare('SELECT * FROM sales WHERE id=?').get(beforeRoot.id);
      if (!lockedRoot || Number(lockedRoot.revision || 0) !== Number(beforeRoot.revision || 0)) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga la corrección antes de continuar.');
        error.code = 'CONFLICT';
        throw error;
      }

      const returnIds = [];
      let creditTotal = 0;
      let overpayment = 0;
      for (const [sourceSaleId, returnItems] of reductionsBySale.entries()) {
        const result = returnsRepo.create({
          originalSaleId: sourceSaleId,
          items: returnItems,
          session,
          user: requester,
          reason: `Corrección de productos: ${cleanReason}`,
        });
        returnIds.push(Number(result.returnId));
        creditTotal = Math.round((creditTotal + Number(result.total || 0)) * 100) / 100;
        overpayment = Math.round((overpayment + Number(result.overpayment || 0)) * 100) / 100;
      }

      let additionSaleId = null;
      let additionTotal = 0;
      if (additionRows.length) {
        const prepared = additionRows.map(row => {
          const product = db().prepare(`
            SELECT id,code,name,cost,price,wholesale,taxable,tax_pct,stock,active
            FROM products WHERE id=?
          `).get(row.product_id);
          if (!product || product.active !== 1) throw new Error('Uno de los productos agregados no existe o está inactivo');
          return {
            product_id: product.id,
            product_code: product.code,
            product_name: product.name,
            unit_cost: Number(product.cost || 0),
            unit_price: Number(row.unit_price),
            taxable: row.taxable ?? product.taxable,
            tax_pct: row.tax_pct ?? product.tax_pct,
            qty: row.qty,
          };
        });
        const addition = salesRepo.create({
          session: session?.id ? session : null,
          customer: {
            id: beforeRoot.customer_id,
            name: beforeRoot.customer_name,
            rnc: beforeRoot.customer_rnc,
            customer_type: beforeRoot.customer_type,
            trade_name: beforeRoot.customer_trade_name,
            address: beforeRoot.customer_address,
            phone: beforeRoot.customer_phone,
            email: beforeRoot.customer_email,
            contact_id: beforeRoot.customer_contact_id,
            contact: beforeRoot.customer_contact_id ? {
              id: beforeRoot.customer_contact_id,
              name: beforeRoot.customer_contact_name,
              document: beforeRoot.customer_contact_document,
              role: beforeRoot.customer_contact_role,
              phone: beforeRoot.customer_contact_phone,
              email: beforeRoot.customer_contact_email,
            } : null,
            preserve_customer_snapshot: true,
            preserve_contact_snapshot: true,
          },
          items: prepared,
          payment: {
            method,
            priceMode: beforeRoot.price_mode || 'retail',
            financialAccountId: method === 'transferencia' || method === 'tarjeta'
              ? beforeRoot.financial_account_id || null : null,
            exchangeRate: beforeRoot.exchange_rate || 1,
            cardBrand: method === 'tarjeta' ? beforeRoot.card_brand || '' : '',
            cardLast4: method === 'tarjeta' ? beforeRoot.card_last4 || '' : '',
            reference: `Corrección factura ${beforeRoot.document_number_fmt || beforeRoot.id}`,
            salespersonId: beforeRoot.salesperson_id || null,
          },
          user: requester,
          type: 'factura',
          trustedCustomerSnapshot: true,
        });
        additionSaleId = Number(addition.saleId);
        additionTotal = Number(addition.total || 0);
        db().prepare(`
          UPDATE sales
          SET original_sale_id=?,correction_kind='product_addition',
              notes=?,updated_at=datetime('now','localtime')
          WHERE id=?
        `).run(
          beforeRoot.id,
          `Aumento vinculado por corrección de productos · ${cleanReason}`,
          additionSaleId
        );
      }

      const revisionUpdate = db().prepare(`
        UPDATE sales
        SET revision=revision+1,updated_at=datetime('now','localtime')
        WHERE id=? AND revision=?
      `).run(beforeRoot.id, beforeRoot.revision || 0);
      if (revisionUpdate.changes !== 1) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga la corrección antes de continuar.');
        error.code = 'CONFLICT';
        throw error;
      }

      const afterModel = productCorrectionModel(beforeRoot.id, requester.id);
      const beforeData = {
        sale: _snapshot(beforeRoot),
        effective_items: beforeModel.lines.map(row => ({
          source_sale_id: row.source_sale_id,
          product_id: row.product_id,
          product_name: row.product_name,
          qty: row.current_qty,
          unit_price: row.unit_price,
        })),
      };
      const afterData = {
        sale: _snapshot(afterModel.root),
        effective_items: afterModel.lines.map(row => ({
          source_sale_id: row.source_sale_id,
          product_id: row.product_id,
          product_name: row.product_name,
          qty: row.current_qty,
          unit_price: row.unit_price,
        })),
      };
      const metadata = {
        returnIds,
        additionSaleId,
        creditTotal,
        additionTotal,
        overpayment,
        netDifference: Math.round((additionTotal - creditTotal) * 100) / 100,
        paymentMethod: additionRows.length ? method : null,
        originalFiscalDocumentPreserved: true,
      };
      const correction = db().prepare(`
        INSERT INTO sale_corrections(
          sale_id,action,status,reason,requested_by,authorized_by,cash_session_id,
          terminal_id,idempotency_key,before_data,after_data,affected_modules,metadata
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        beforeRoot.id, 'correct_products', 'applied', cleanReason,
        requester.id, requester.id, session?.id || beforeRoot.cash_session_id || null,
        String(terminalId || '').slice(0, 120), key,
        _serialize(beforeData), _serialize(afterData),
        _serialize(['sales','inventory','payments','accounts_receivable','accounting','fiscal','reports']),
        _serialize(metadata)
      );
      const correctionId = Number(correction.lastInsertRowid);
      const linkDocument = db().prepare(`
        INSERT INTO sale_correction_documents(correction_id,sale_id,document_role)
        VALUES(?,?,?)
      `);
      returnIds.forEach(id => linkDocument.run(correctionId, id, 'credit'));
      if (additionSaleId) linkDocument.run(correctionId, additionSaleId, 'supplemental_invoice');

      const generatedIds = [...returnIds, ...(additionSaleId ? [additionSaleId] : [])];
      if (generatedIds.length && _tableExists(db(), 'inventory_movements')) {
        const markInventory = db().prepare('UPDATE inventory_movements SET correction_id=? WHERE sale_id=?');
        generatedIds.forEach(id => markInventory.run(correctionId, id));
      }
      const now = db().prepare("SELECT datetime('now','localtime') value").get().value;
      db().prepare(`
        INSERT INTO audit_logs(user_id,user_name,action,entity,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        requester.id, requester.name, 'productos_venta_corregidos', 'sales', beforeRoot.id,
        _serialize({ correctionId, reason: cleanReason, ...metadata }), now
      );

      return {
        idempotent: false,
        correctionId,
        returnIds,
        additionSaleId,
        creditTotal,
        additionTotal,
        overpayment,
        netDifference: metadata.netDifference,
        data: afterModel.root,
      };
    })();
  }

  function monetaryCreditModel(saleId, userId) {
    const user = userById(userId);
    if (!user) throw new Error('Usuario no encontrado');
    requirePermission(user, 'sales.correct');
    requirePermission(user, 'sales.issue_credit_note');

    const selected = db().prepare('SELECT * FROM sales WHERE id=?').get(Number(saleId));
    if (!selected) throw new Error('Factura no encontrada');
    const rootId = selected.correction_kind === 'product_addition' && selected.original_sale_id
      ? Number(selected.original_sale_id)
      : Number(selected.id);
    const root = db().prepare('SELECT * FROM sales WHERE id=?').get(rootId);
    if (!root || root.type !== 'factura') throw new Error('Solo se emiten notas de crédito sobre facturas');
    if (root.status === 'cancelled') throw new Error('La factura anulada no admite notas de crédito');

    const activeCredits = db().prepare(`
      SELECT COALESCE(SUM(total),0) total
      FROM sales
      WHERE type='devolucion' AND original_sale_id=? AND status!='cancelled'
    `).get(root.id);
    const creditedTotal = Math.round(Number(activeCredits?.total || 0) * 100) / 100;
    const availableCredit = Math.round(
      Math.max(0, Number(root.total || 0) - creditedTotal) * 100
    ) / 100;
    const warnings = [{
      code: 'NO_INVENTORY_MOVEMENT',
      severity: 'info',
      message: 'Esta nota de crédito ajusta dinero e impuestos; no agrega ni retira productos del inventario.',
    }];
    if (root.ncf) {
      warnings.push({
        code: 'ORIGINAL_FISCAL_DOCUMENT_PRESERVED',
        severity: 'medium',
        message: 'La factura y su NCF permanecerán intactos. La nota de crédito quedará vinculada al comprobante original.',
      });
    }

    return {
      root: { ...root, administrative_data: _json(root.administrative_data, {}) },
      creditedTotal,
      availableCredit,
      warnings,
      permissions: SALE_CORRECTION_PERMISSIONS.filter(permission => hasPermission(user, permission)),
    };
  }

  function createMonetaryCredit({
    saleId, amount, reason, userId, expectedRevision,
    idempotencyKey, terminalId, session,
  }) {
    if (!returnsRepo) throw new Error('El servicio de notas de crédito no está disponible');
    const requester = userById(userId);
    if (!requester) throw new Error('Usuario no encontrado');
    requirePermission(requester, 'sales.correct');
    requirePermission(requester, 'sales.issue_credit_note');

    const cleanReason = String(reason || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (cleanReason.length < 5) throw new Error('El motivo es obligatorio y debe ser específico');
    const creditAmount = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      throw new Error('El importe de la nota de crédito debe ser mayor que cero');
    }
    const key = String(idempotencyKey || '').trim().slice(0, 120);
    if (key.length < 12) throw new Error('Clave de idempotencia inválida');

    const selected = db().prepare('SELECT id,original_sale_id,correction_kind FROM sales WHERE id=?')
      .get(Number(saleId));
    if (!selected) throw new Error('Factura no encontrada');
    const rootId = selected.correction_kind === 'product_addition' && selected.original_sale_id
      ? Number(selected.original_sale_id)
      : Number(selected.id);
    const existing = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
    if (existing) {
      if (existing.action !== 'create_monetary_credit' || Number(existing.sale_id) !== rootId) {
        throw new Error('La clave de idempotencia ya fue utilizada para otra operación');
      }
      const metadata = _json(existing.metadata, {});
      return {
        idempotent: true,
        correctionId: existing.id,
        returnIds: metadata.creditNoteId ? [metadata.creditNoteId] : [],
        creditTotal: metadata.creditTotal || 0,
        additionTotal: 0,
        netDifference: -(metadata.creditTotal || 0),
        creditKind: 'monetary',
        inventoryMoved: false,
      };
    }

    const model = monetaryCreditModel(rootId, requester.id);
    if (expectedRevision != null && Number(expectedRevision) !== Number(model.root.revision || 0)) {
      const error = new Error('La factura fue modificada por otro usuario. Recarga la corrección antes de continuar.');
      error.code = 'CONFLICT';
      throw error;
    }
    if (creditAmount > Number(model.availableCredit || 0) + 0.005) {
      throw new Error(
        `El importe supera el saldo disponible para acreditar. Disponible: RD$${Number(model.availableCredit || 0).toFixed(2)}`
      );
    }
    if (['efectivo', 'mixto'].includes(String(model.root.payment_method || '').toLowerCase()) && !session?.id) {
      throw new Error('Debes tener la caja abierta para entregar el reembolso en efectivo');
    }

    return db().transaction(() => {
      const duplicate = db().prepare('SELECT * FROM sale_corrections WHERE idempotency_key=?').get(key);
      if (duplicate) {
        if (duplicate.action !== 'create_monetary_credit' || Number(duplicate.sale_id) !== rootId) {
          throw new Error('La clave de idempotencia ya fue utilizada para otra operación');
        }
        const metadata = _json(duplicate.metadata, {});
        return {
          idempotent: true,
          correctionId: duplicate.id,
          returnIds: metadata.creditNoteId ? [metadata.creditNoteId] : [],
          creditTotal: metadata.creditTotal || 0,
          additionTotal: 0,
          netDifference: -(metadata.creditTotal || 0),
          creditKind: 'monetary',
          inventoryMoved: false,
        };
      }
      const lockedRoot = db().prepare('SELECT * FROM sales WHERE id=?').get(rootId);
      if (!lockedRoot || Number(lockedRoot.revision || 0) !== Number(model.root.revision || 0)) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga la corrección antes de continuar.');
        error.code = 'CONFLICT';
        throw error;
      }

      const credit = returnsRepo.create({
        originalSaleId: rootId,
        items: [],
        monetaryAmount: creditAmount,
        monetaryLabel: 'Descuento o ajuste monetario posterior',
        session,
        user: requester,
        reason: cleanReason,
      });

      const revisionUpdate = db().prepare(`
        UPDATE sales
        SET revision=revision+1,updated_at=datetime('now','localtime')
        WHERE id=? AND revision=?
      `).run(rootId, model.root.revision || 0);
      if (revisionUpdate.changes !== 1) {
        const error = new Error('La factura fue modificada por otro usuario. Recarga la corrección antes de continuar.');
        error.code = 'CONFLICT';
        throw error;
      }

      const updated = db().prepare('SELECT * FROM sales WHERE id=?').get(rootId);
      const metadata = {
        creditNoteId: Number(credit.returnId),
        creditTotal: Number(credit.total || creditAmount),
        creditKind: 'monetary',
        inventoryMoved: false,
        originalFiscalDocumentPreserved: true,
      };
      const correction = db().prepare(`
        INSERT INTO sale_corrections(
          sale_id,action,status,reason,requested_by,authorized_by,cash_session_id,
          terminal_id,idempotency_key,before_data,after_data,affected_modules,metadata
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        rootId, 'create_monetary_credit', 'applied', cleanReason,
        requester.id, requester.id, session?.id || model.root.cash_session_id || null,
        String(terminalId || '').slice(0, 120), key,
        _serialize(_snapshot(model.root)), _serialize(_snapshot(updated)),
        _serialize(['sales','payments','accounts_receivable','cash','accounting','fiscal','reports']),
        _serialize(metadata)
      );
      const correctionId = Number(correction.lastInsertRowid);
      db().prepare(`
        INSERT INTO sale_correction_documents(correction_id,sale_id,document_role)
        VALUES(?,?,'credit')
      `).run(correctionId, credit.returnId);
      const now = db().prepare("SELECT datetime('now','localtime') value").get().value;
      db().prepare(`
        INSERT INTO audit_logs(user_id,user_name,action,entity,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        requester.id, requester.name, 'nota_credito_monetaria_registrada', 'sales', rootId,
        _serialize({ correctionId, reason: cleanReason, ...metadata }), now
      );

      return {
        idempotent: false,
        correctionId,
        returnIds: [Number(credit.returnId)],
        creditTotal: metadata.creditTotal,
        additionTotal: 0,
        netDifference: -metadata.creditTotal,
        creditKind: 'monetary',
        inventoryMoved: false,
        data: updated,
      };
    })();
  }

  function history(saleId, userId) {
    const user = userById(userId);
    if (!user) throw new Error('Usuario no encontrado');
    requirePermission(user, 'sales.view_audit');
    const sale = db().prepare('SELECT * FROM sales WHERE id=?').get(Number(saleId));
    if (!sale) throw new Error('Venta no encontrada');
    const corrections = db().prepare(`
      SELECT sc.*,ru.name requested_by_name,au.name authorized_by_name
      FROM sale_corrections sc
      LEFT JOIN users ru ON ru.id=sc.requested_by
      LEFT JOIN users au ON au.id=sc.authorized_by
      WHERE sc.sale_id=?
      ORDER BY sc.created_at DESC,sc.id DESC
    `).all(sale.id).map(row => ({
      ...row,
      before_data: _json(row.before_data, {}),
      after_data: _json(row.after_data, {}),
      affected_modules: _json(row.affected_modules, []),
      metadata: _json(row.metadata, {}),
    }));
    const dateHistory = db().prepare(`
      SELECT h.*,cu.name changed_by_name,au.name authorized_by_name
      FROM sale_date_history h
      LEFT JOIN users cu ON cu.id=h.changed_by
      LEFT JOIN users au ON au.id=h.authorized_by
      WHERE h.sale_id=?
      ORDER BY h.created_at DESC,h.id DESC
    `).all(sale.id);
    const relatedDocuments = db().prepare(`
      SELECT s.id,s.type,s.status,s.total,s.ncf,s.sale_date,s.created_at,
             s.document_number_fmt,s.numero_factura_fmt,s.correction_kind,
             CASE
               WHEN s.type='devolucion' THEN 'credit'
               WHEN s.correction_kind='product_addition' THEN 'supplemental_invoice'
               ELSE ''
             END document_role
      FROM sales s
      WHERE s.original_sale_id=?
         OR EXISTS(
           SELECT 1
           FROM sale_correction_documents scd
           JOIN sale_corrections sc ON sc.id=scd.correction_id
           WHERE sc.sale_id=? AND scd.sale_id=s.id
         )
      ORDER BY created_at,id
    `).all(sale.id, sale.id);
    const payments = db().prepare(`
      SELECT id,amount,method,created_at,document_number_fmt
      FROM payments WHERE sale_id=? ORDER BY created_at,id
    `).all(sale.id);
    const commissionAdjustments = _tableExists(db(), 'commission_adjustments')
      ? db().prepare('SELECT * FROM commission_adjustments WHERE sale_id=? ORDER BY created_at,id').all(sale.id)
      : [];
    const auditEvents = db().prepare(`
      SELECT id,action,detail,user_name,created_at
      FROM audit_logs
      WHERE entity='sales' AND entity_id=?
      ORDER BY created_at,id
    `).all(sale.id);
    const accountingEntries = _tableExists(db(), 'accounting_entries')
      ? db().prepare(`
          SELECT id,number,date,concept,status,source_module,created_at
          FROM accounting_entries
          WHERE source_id=? AND source_module IN ('venta','devolucion')
          ORDER BY created_at,id
        `).all(sale.id)
      : [];
    return {
      sale: { ...sale, administrative_data: _json(sale.administrative_data, {}) },
      corrections,
      dateHistory,
      relatedDocuments,
      payments,
      commissionAdjustments,
      auditEvents,
      accountingEntries,
    };
  }

  return {
    permissions: SALE_CORRECTION_PERMISSIONS,
    hasPermission,
    impact,
    changeDate,
    updateAdministrativeData,
    productCorrectionModel,
    correctProducts,
    monetaryCreditModel,
    createMonetaryCredit,
    history,
  };
}

module.exports = {
  SALE_CORRECTION_PERMISSIONS,
  ensureSaleCorrectionsSchema,
  createSaleCorrectionsRepo,
};
