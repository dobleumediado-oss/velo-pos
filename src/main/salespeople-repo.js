'use strict';

const { round2 } = require('../../lib/money');

function ensureSalespeopleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS salespeople (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      code                 TEXT NOT NULL UNIQUE,
      name                 TEXT NOT NULL,
      seller_type          TEXT NOT NULL DEFAULT 'fijo' CHECK(seller_type IN ('fijo','ambulante')),
      linked_user_id       INTEGER REFERENCES users(id),
      document             TEXT DEFAULT '',
      phone                TEXT DEFAULT '',
      email                TEXT DEFAULT '',
      address              TEXT DEFAULT '',
      zone                 TEXT DEFAULT '',
      route                TEXT DEFAULT '',
      booklet_code         TEXT DEFAULT '',
      hire_date            TEXT DEFAULT (date('now','localtime')),
      commission_mode      TEXT NOT NULL DEFAULT 'percent_sales'
                             CHECK(commission_mode IN ('none','percent_sales','percent_margin','fixed_sale')),
      commission_rate      REAL NOT NULL DEFAULT 0,
      commission_fixed     REAL NOT NULL DEFAULT 0,
      commission_frequency TEXT NOT NULL DEFAULT 'mensual'
                             CHECK(commission_frequency IN ('semanal','quincenal','mensual')),
      salary_amount        REAL NOT NULL DEFAULT 0,
      sales_goal           REAL NOT NULL DEFAULT 0,
      map_lat              REAL,
      map_lng              REAL,
      coverage_address     TEXT DEFAULT '',
      location_updated_at  TEXT,
      payroll_frequency    TEXT NOT NULL DEFAULT 'mensual'
                             CHECK(payroll_frequency IN ('semanal','quincenal','mensual')),
      status               TEXT NOT NULL DEFAULT 'activo' CHECK(status IN ('activo','inactivo')),
      notes                TEXT DEFAULT '',
      created_by           INTEGER REFERENCES users(id),
      created_at           TEXT DEFAULT (datetime('now','localtime')),
      updated_at           TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_salespeople_linked_user
      ON salespeople(linked_user_id) WHERE linked_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_salespeople_status_type ON salespeople(status,seller_type);

    CREATE TABLE IF NOT EXISTS seller_external_sales (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      salesperson_id   INTEGER NOT NULL REFERENCES salespeople(id),
      sale_date         TEXT NOT NULL DEFAULT (date('now','localtime')),
      booklet_number    TEXT NOT NULL DEFAULT '',
      receipt_number    TEXT NOT NULL,
      customer_name     TEXT DEFAULT 'Consumidor Final',
      gross_amount      REAL NOT NULL DEFAULT 0,
      discount_amount   REAL NOT NULL DEFAULT 0,
      return_amount     REAL NOT NULL DEFAULT 0,
      cost_amount       REAL NOT NULL DEFAULT 0,
      collected_amount  REAL NOT NULL DEFAULT 0,
      payment_method    TEXT DEFAULT 'efectivo',
      status            TEXT NOT NULL DEFAULT 'registrada' CHECK(status IN ('registrada','anulada')),
      notes             TEXT DEFAULT '',
      created_by        INTEGER REFERENCES users(id),
      cancelled_by      INTEGER REFERENCES users(id),
      cancel_reason     TEXT DEFAULT '',
      cancelled_at      TEXT,
      created_at        TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(salesperson_id,booklet_number,receipt_number)
    );
    CREATE INDEX IF NOT EXISTS idx_seller_external_date ON seller_external_sales(salesperson_id,sale_date,status);

    CREATE TABLE IF NOT EXISTS seller_external_sale_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      external_sale_id  INTEGER NOT NULL REFERENCES seller_external_sales(id) ON DELETE CASCADE,
      product_id        INTEGER REFERENCES products(id),
      product_code      TEXT DEFAULT '',
      product_name      TEXT NOT NULL,
      qty               REAL NOT NULL DEFAULT 1,
      unit_price        REAL NOT NULL DEFAULT 0,
      unit_cost         REAL NOT NULL DEFAULT 0,
      line_total        REAL NOT NULL DEFAULT 0,
      created_at        TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_seller_external_items_sale ON seller_external_sale_items(external_sale_id);

    CREATE TABLE IF NOT EXISTS seller_commission_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      salesperson_id   INTEGER NOT NULL REFERENCES salespeople(id),
      date_from         TEXT NOT NULL,
      date_to           TEXT NOT NULL,
      frequency         TEXT NOT NULL,
      calculation_mode TEXT NOT NULL,
      rate              REAL NOT NULL DEFAULT 0,
      fixed_amount      REAL NOT NULL DEFAULT 0,
      sales_total       REAL NOT NULL DEFAULT 0,
      margin_total      REAL NOT NULL DEFAULT 0,
      commission_total  REAL NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'borrador'
                           CHECK(status IN ('borrador','aprobado','pagado','anulado')),
      payroll_run_id    INTEGER,
      notes             TEXT DEFAULT '',
      approved_by       INTEGER REFERENCES users(id),
      approved_at       TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(salesperson_id,date_from,date_to)
    );

    CREATE TABLE IF NOT EXISTS seller_commission_lines (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      commission_run_id INTEGER NOT NULL REFERENCES seller_commission_runs(id) ON DELETE CASCADE,
      source_type       TEXT NOT NULL CHECK(source_type IN ('sistema','talonario')),
      source_id         INTEGER NOT NULL,
      sale_date         TEXT NOT NULL,
      reference         TEXT DEFAULT '',
      customer_name     TEXT DEFAULT '',
      sale_amount       REAL NOT NULL DEFAULT 0,
      cost_amount       REAL NOT NULL DEFAULT 0,
      commission_base   REAL NOT NULL DEFAULT 0,
      commission_amount REAL NOT NULL DEFAULT 0,
      UNIQUE(commission_run_id,source_type,source_id)
    );

    CREATE TABLE IF NOT EXISTS seller_expense_links (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      salesperson_id   INTEGER NOT NULL REFERENCES salespeople(id),
      expense_id       INTEGER NOT NULL UNIQUE REFERENCES expenses(id),
      expense_kind     TEXT NOT NULL DEFAULT 'viatico'
                           CHECK(expense_kind IN ('viatico','combustible','alojamiento','alimentacion','peaje','otro','nomina','comision')),
      created_at       TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS payroll_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      number         TEXT NOT NULL UNIQUE,
      date_from      TEXT NOT NULL,
      date_to        TEXT NOT NULL,
      frequency      TEXT NOT NULL DEFAULT 'mensual'
                         CHECK(frequency IN ('semanal','quincenal','mensual')),
      payment_date   TEXT,
      status         TEXT NOT NULL DEFAULT 'borrador'
                         CHECK(status IN ('borrador','aprobado','pagado','anulado')),
      base_total     REAL NOT NULL DEFAULT 0,
      commission_total REAL NOT NULL DEFAULT 0,
      bonus_total    REAL NOT NULL DEFAULT 0,
      deduction_total REAL NOT NULL DEFAULT 0,
      net_total      REAL NOT NULL DEFAULT 0,
      notes          TEXT DEFAULT '',
      approved_by    INTEGER REFERENCES users(id),
      approved_at    TEXT,
      paid_by        INTEGER REFERENCES users(id),
      paid_at        TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS payroll_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_run_id  INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      salesperson_id  INTEGER NOT NULL REFERENCES salespeople(id),
      base_salary     REAL NOT NULL DEFAULT 0,
      commission_amount REAL NOT NULL DEFAULT 0,
      bonus_amount    REAL NOT NULL DEFAULT 0,
      deduction_amount REAL NOT NULL DEFAULT 0,
      net_amount      REAL NOT NULL DEFAULT 0,
      expense_id      INTEGER REFERENCES expenses(id),
      notes           TEXT DEFAULT '',
      UNIQUE(payroll_run_id,salesperson_id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll_runs(date_from,date_to,status);
  `);

  const saleCols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
  if (!saleCols.includes('salesperson_id')) {
    db.exec('ALTER TABLE sales ADD COLUMN salesperson_id INTEGER REFERENCES salespeople(id)');
  }
  const payrollCols = db.prepare('PRAGMA table_info(payroll_runs)').all().map(c => c.name);
  if (!payrollCols.includes('frequency')) {
    db.exec("ALTER TABLE payroll_runs ADD COLUMN frequency TEXT NOT NULL DEFAULT 'mensual'");
  }
  const sellerCols = db.prepare('PRAGMA table_info(salespeople)').all().map(c => c.name);
  if (!sellerCols.includes('sales_goal')) db.exec('ALTER TABLE salespeople ADD COLUMN sales_goal REAL NOT NULL DEFAULT 0');
  if (!sellerCols.includes('map_lat')) db.exec('ALTER TABLE salespeople ADD COLUMN map_lat REAL');
  if (!sellerCols.includes('map_lng')) db.exec('ALTER TABLE salespeople ADD COLUMN map_lng REAL');
  if (!sellerCols.includes('coverage_address')) db.exec("ALTER TABLE salespeople ADD COLUMN coverage_address TEXT DEFAULT ''");
  if (!sellerCols.includes('location_updated_at')) db.exec('ALTER TABLE salespeople ADD COLUMN location_updated_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_salesperson_date ON sales(salesperson_id,created_at,status)');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_unique_period ON payroll_runs(date_from,date_to,frequency) WHERE status!='anulado'");
}

function isoDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Fecha inválida');
  return text;
}

function periodFor(frequency, asOf = new Date()) {
  const date = asOf instanceof Date ? new Date(asOf) : new Date(`${isoDate(asOf)}T12:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error('Fecha inválida');
  const y = date.getFullYear();
  const m = date.getMonth();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let from;
  let to;
  if (frequency === 'semanal') {
    const mondayOffset = (date.getDay() + 6) % 7;
    from = new Date(y, m, date.getDate() - mondayOffset);
    to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
  } else if (frequency === 'quincenal') {
    from = new Date(y, m, date.getDate() <= 15 ? 1 : 16);
    to = date.getDate() <= 15 ? new Date(y, m, 15) : new Date(y, m + 1, 0);
  } else {
    from = new Date(y, m, 1);
    to = new Date(y, m + 1, 0);
  }
  return { from: fmt(from), to: fmt(to), frequency: frequency || 'mensual' };
}

function createSalespeopleRepo({ getDb, expensesRepo, audit }) {
  const db = () => getDb();
  const money = n => round2(Math.max(0, Number(n) || 0));
  const text = (v, max = 250) => String(v || '').trim().slice(0, max);
  const coordinate = (value, min, max) => {
    if (value === '' || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  };

  const requireSeller = id => {
    const seller = db().prepare('SELECT * FROM salespeople WHERE id=?').get(Number(id));
    if (!seller) throw new Error('Vendedor no encontrado');
    return seller;
  };

  function commissionSources(seller, from, to) {
    const internal = db().prepare(`
      SELECT s.id source_id,'sistema' source_type,date(s.created_at) sale_date,
        COALESCE(s.numero_factura_fmt,s.numero_factura,printf('%08d',s.id)) reference,
        s.customer_name,
        MAX(0,s.total-COALESCE((SELECT SUM(r.total) FROM sales r
          WHERE r.type='devolucion' AND r.original_sale_id=s.id AND r.status!='cancelled'),0)) sale_amount,
        MAX(0,COALESCE((SELECT SUM(si.unit_cost*si.qty) FROM sale_items si WHERE si.sale_id=s.id),0)-
          COALESCE((SELECT SUM(ri.unit_cost*ri.qty) FROM sales r JOIN sale_items ri ON ri.sale_id=r.id
            WHERE r.type='devolucion' AND r.original_sale_id=s.id AND r.status!='cancelled'),0)) cost_amount
      FROM sales s
      WHERE s.salesperson_id=? AND s.type='factura' AND s.status!='cancelled'
        AND date(s.created_at) BETWEEN ? AND ?
      ORDER BY s.created_at,s.id
    `).all(seller.id, from, to);
    const external = db().prepare(`
      SELECT id source_id,'talonario' source_type,sale_date,
        receipt_number reference,
        customer_name,
        MAX(0,gross_amount-discount_amount-return_amount) sale_amount,
        MAX(0,cost_amount) cost_amount
      FROM seller_external_sales
      WHERE salesperson_id=? AND status='registrada' AND sale_date BETWEEN ? AND ?
      ORDER BY sale_date,id
    `).all(seller.id, from, to);
    return [...internal, ...external].filter(row => money(row.sale_amount) > 0);
  }

  function calculateCommission(seller, from, to) {
    const sources = commissionSources(seller, from, to).map(row => {
      const saleAmount = money(row.sale_amount);
      const costAmount = Math.min(saleAmount, money(row.cost_amount));
      const margin = money(saleAmount - costAmount);
      let base = 0;
      let amount = 0;
      if (seller.commission_mode === 'percent_sales') {
        base = saleAmount;
        amount = money(base * (Number(seller.commission_rate) || 0) / 100);
      } else if (seller.commission_mode === 'percent_margin') {
        base = margin;
        amount = money(base * (Number(seller.commission_rate) || 0) / 100);
      } else if (seller.commission_mode === 'fixed_sale') {
        base = 1;
        amount = money(seller.commission_fixed);
      }
      return { ...row, sale_amount: saleAmount, cost_amount: costAmount,
        margin_amount: margin, commission_base: base, commission_amount: amount };
    });
    return {
      seller, from, to, lines: sources,
      salesTotal: money(sources.reduce((s, r) => s + r.sale_amount, 0)),
      marginTotal: money(sources.reduce((s, r) => s + r.margin_amount, 0)),
      commissionTotal: money(sources.reduce((s, r) => s + r.commission_amount, 0)),
      salesCount: sources.length,
    };
  }

  function recalcPayroll(runId) {
    const totals = db().prepare(`SELECT COALESCE(SUM(base_salary),0) base_total,
      COALESCE(SUM(commission_amount),0) commission_total,COALESCE(SUM(bonus_amount),0) bonus_total,
      COALESCE(SUM(deduction_amount),0) deduction_total,COALESCE(SUM(net_amount),0) net_total
      FROM payroll_items WHERE payroll_run_id=?`).get(runId);
    db().prepare(`UPDATE payroll_runs SET base_total=?,commission_total=?,bonus_total=?,deduction_total=?,net_total=? WHERE id=?`)
      .run(totals.base_total, totals.commission_total, totals.bonus_total, totals.deduction_total, totals.net_total, runId);
    return totals;
  }

  return {
    getAll({ status, type } = {}) {
      let where = 'WHERE 1=1';
      const args = [];
      if (status) { where += ' AND sp.status=?'; args.push(status); }
      if (type) { where += ' AND sp.seller_type=?'; args.push(type); }
      return db().prepare(`SELECT sp.*,u.name linked_user_name,
        (SELECT COUNT(*) FROM sales s WHERE s.salesperson_id=sp.id AND s.status!='cancelled') internal_sales_count,
        (SELECT COUNT(*) FROM seller_external_sales es WHERE es.salesperson_id=sp.id AND es.status='registrada') external_sales_count
        FROM salespeople sp LEFT JOIN users u ON u.id=sp.linked_user_id ${where} ORDER BY sp.status,sp.name`).all(...args);
    },
    getById(id) { return requireSeller(id); },
    create(data, userId, userName) {
      const name = text(data.name, 120);
      if (!name) throw new Error('El nombre del vendedor es obligatorio');
      const code = text(data.code, 30) || `VEN-${String((db().prepare('SELECT COALESCE(MAX(id),0)+1 n FROM salespeople').get().n)).padStart(4, '0')}`;
      const r = db().prepare(`INSERT INTO salespeople(code,name,seller_type,linked_user_id,document,phone,email,address,zone,route,
        booklet_code,hire_date,commission_mode,commission_rate,commission_fixed,commission_frequency,salary_amount,sales_goal,map_lat,map_lng,coverage_address,location_updated_at,payroll_frequency,notes,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code,name,data.seller_type==='ambulante'?'ambulante':'fijo',
        Number(data.linked_user_id)||null,text(data.document,30),text(data.phone,30),text(data.email,120),text(data.address,250),
        text(data.zone,100),text(data.route,120),'',data.hire_date||null,
        ['none','percent_sales','percent_margin','fixed_sale'].includes(data.commission_mode)?data.commission_mode:'percent_sales',
        money(data.commission_rate),money(data.commission_fixed),
        ['semanal','quincenal','mensual'].includes(data.commission_frequency)?data.commission_frequency:'mensual',
        money(data.salary_amount),money(data.sales_goal),coordinate(data.map_lat,-90,90),coordinate(data.map_lng,-180,180),
        text(data.coverage_address,250),(data.map_lat!==''&&data.map_lat!=null&&data.map_lng!==''&&data.map_lng!=null)?new Date().toISOString():null,
        ['semanal','quincenal','mensual'].includes(data.payroll_frequency)?data.payroll_frequency:'mensual',
        text(data.notes,500),userId||null);
      audit(userId||0,userName||'','vendedor_creado','salespeople',r.lastInsertRowid,`${code} · ${name}`);
      return r.lastInsertRowid;
    },
    update(id, data, userId, userName) {
      const current = requireSeller(id);
      const name = text(data.name,120);
      if (!name) throw new Error('El nombre del vendedor es obligatorio');
      const nextLat = coordinate(data.map_lat,-90,90);
      const nextLng = coordinate(data.map_lng,-180,180);
      const locationChanged = nextLat !== current.map_lat || nextLng !== current.map_lng;
      db().prepare(`UPDATE salespeople SET code=?,name=?,seller_type=?,linked_user_id=?,document=?,phone=?,email=?,address=?,zone=?,route=?,
        booklet_code=?,hire_date=?,commission_mode=?,commission_rate=?,commission_fixed=?,commission_frequency=?,salary_amount=?,sales_goal=?,map_lat=?,map_lng=?,coverage_address=?,
        location_updated_at=CASE WHEN ?=1 THEN datetime('now','localtime') ELSE location_updated_at END,payroll_frequency=?,
        notes=?,updated_at=datetime('now','localtime') WHERE id=?`).run(text(data.code,30)||current.code,name,
        data.seller_type==='ambulante'?'ambulante':'fijo',Number(data.linked_user_id)||null,text(data.document,30),text(data.phone,30),
        text(data.email,120),text(data.address,250),text(data.zone,100),text(data.route,120),'',data.hire_date||current.hire_date,
        ['none','percent_sales','percent_margin','fixed_sale'].includes(data.commission_mode)?data.commission_mode:'percent_sales',
        money(data.commission_rate),money(data.commission_fixed),
        ['semanal','quincenal','mensual'].includes(data.commission_frequency)?data.commission_frequency:'mensual',money(data.salary_amount),money(data.sales_goal),
        nextLat,nextLng,text(data.coverage_address,250),locationChanged?1:0,
        ['semanal','quincenal','mensual'].includes(data.payroll_frequency)?data.payroll_frequency:'mensual',text(data.notes,500),id);
      audit(userId||0,userName||'','vendedor_actualizado','salespeople',id,name);
      return true;
    },
    updateLocation(id, data, userId, userName) {
      const seller = requireSeller(id);
      if (seller.seller_type !== 'ambulante') throw new Error('La cobertura geográfica solo aplica a vendedores ambulantes');
      const lat = coordinate(data.lat,-90,90), lng = coordinate(data.lng,-180,180);
      if (lat == null || lng == null) throw new Error('La ubicación indicada no es válida');
      db().prepare(`UPDATE salespeople SET map_lat=?,map_lng=?,coverage_address=?,location_updated_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?`)
        .run(lat,lng,text(data.coverage_address,250)||seller.coverage_address||'',id);
      audit(userId||0,userName||'','vendedor_ubicacion_actualizada','salespeople',id,`${seller.name} · ${lat}, ${lng}`);
      return requireSeller(id);
    },
    toggle(id, active, userId, userName) {
      const seller = requireSeller(id);
      db().prepare("UPDATE salespeople SET status=?,updated_at=datetime('now','localtime') WHERE id=?")
        .run(active ? 'activo' : 'inactivo',id);
      audit(userId||0,userName||'','vendedor_estado','salespeople',id,`${seller.name}: ${active?'activo':'inactivo'}`);
      return true;
    },
    getDashboard({ from, to } = {}) {
      const dateTo = to ? isoDate(to) : new Date().toISOString().slice(0,10);
      const d = new Date(`${dateTo}T12:00:00`); d.setDate(1);
      const dateFrom = from ? isoDate(from) : d.toISOString().slice(0,10);
      const sellers = this.getAll({ status:'activo' });
      const rows = sellers.map(seller => {
        const calc = calculateCommission(seller,dateFrom,dateTo);
        const expenses = db().prepare(`SELECT COALESCE(SUM(e.total),0) total FROM seller_expense_links l JOIN expenses e ON e.id=l.expense_id
          WHERE l.salesperson_id=? AND e.status NOT IN ('anulado','rechazado','borrador') AND e.issue_date BETWEEN ? AND ?`).get(seller.id,dateFrom,dateTo).total;
        return { id:seller.id,name:seller.name,type:seller.seller_type,sales:calc.salesTotal,margin:calc.marginTotal,
          commission:calc.commissionTotal,expenses:money(expenses),salesCount:calc.salesCount };
      });
      return { from:dateFrom,to:dateTo,rows,activeCount:sellers.length,
        salesTotal:money(rows.reduce((s,r)=>s+r.sales,0)),commissionTotal:money(rows.reduce((s,r)=>s+r.commission,0)),
        expenseTotal:money(rows.reduce((s,r)=>s+r.expenses,0)) };
    },
    createExternalSale(data, userId, userName) {
      return db().transaction(() => {
        const seller = requireSeller(data.salesperson_id);
        if (seller.seller_type !== 'ambulante') throw new Error('Las ventas externas solo aplican a vendedores ambulantes');
        const receipt = text(data.receipt_number,50) || `EXT-${String(db().prepare('SELECT COALESCE(MAX(id),0)+1 n FROM seller_external_sales').get().n).padStart(6,'0')}`;
        if (db().prepare('SELECT id FROM seller_external_sales WHERE salesperson_id=? AND receipt_number=? LIMIT 1').get(seller.id,receipt)) {
          throw new Error('Ese número de recibo externo ya fue registrado para el vendedor');
        }
        const suppliedItems = Array.isArray(data.items);
        const items = (suppliedItems ? data.items : []).map((item, index) => {
          const product = Number(item.product_id)
            ? db().prepare('SELECT id,code,name,price,cost FROM products WHERE id=?').get(Number(item.product_id))
            : null;
          const name = text(item.product_name || product?.name, 180);
          const qty = money(item.qty);
          const unitPrice = money(item.unit_price ?? product?.price);
          const unitCost = Math.min(unitPrice, money(item.unit_cost ?? product?.cost));
          if (!name || qty <= 0 || unitPrice <= 0) {
            throw new Error(`Producto ${index + 1}: completa descripción, cantidad y precio`);
          }
          return {
            product_id: product?.id || null,
            product_code: text(item.product_code || product?.code, 60),
            product_name: name,
            qty,
            unit_price: unitPrice,
            unit_cost: unitCost,
            line_total: money(qty * unitPrice),
          };
        });
        if (suppliedItems && !items.length) throw new Error('Agrega al menos un producto vendido');

        const gross = items.length
          ? money(items.reduce((sum, item) => sum + item.line_total, 0))
          : money(data.gross_amount);
        const itemCost = items.length
          ? money(items.reduce((sum, item) => sum + item.qty * item.unit_cost, 0))
          : money(data.cost_amount);
        const discount = money(data.discount_amount), returned = money(data.return_amount);
        if (gross <= 0 || discount + returned > gross) throw new Error('Los montos de la venta externa no son válidos');
        const net = money(gross-discount-returned);
        const collected = Math.min(net,money(data.collected_amount == null ? net : data.collected_amount));
        const r = db().prepare(`INSERT INTO seller_external_sales(salesperson_id,sale_date,booklet_number,receipt_number,customer_name,
          gross_amount,discount_amount,return_amount,cost_amount,collected_amount,payment_method,notes,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(seller.id,isoDate(data.sale_date),'',receipt,
          text(data.customer_name,120)||'Consumidor Final',gross,discount,returned,Math.min(net,itemCost),collected,
          text(data.payment_method,30)||'efectivo',text(data.notes,500),userId||null);
        if (items.length) {
          const insertItem = db().prepare(`INSERT INTO seller_external_sale_items(external_sale_id,product_id,product_code,product_name,qty,unit_price,unit_cost,line_total)
            VALUES(?,?,?,?,?,?,?,?)`);
          items.forEach(item => insertItem.run(r.lastInsertRowid,item.product_id,item.product_code,item.product_name,item.qty,item.unit_price,item.unit_cost,item.line_total));
        }
        audit(userId||0,userName||'','venta_ambulante_creada','seller_external_sales',r.lastInsertRowid,`${seller.name} · ${receipt} · RD$${net}`);
        return r.lastInsertRowid;
      })();
    },
    getExternalSales({ salespersonId, from, to, includeCancelled } = {}) {
      let where = includeCancelled ? 'WHERE 1=1' : "WHERE es.status='registrada'";
      const args=[];
      if (salespersonId) { where+=' AND es.salesperson_id=?';args.push(salespersonId); }
      if (from) { where+=' AND es.sale_date>=?';args.push(isoDate(from)); }
      if (to) { where+=' AND es.sale_date<=?';args.push(isoDate(to)); }
      return db().prepare(`SELECT es.*,sp.name salesperson_name,sp.seller_type,
        (SELECT COUNT(*) FROM seller_external_sale_items i WHERE i.external_sale_id=es.id) item_count,
        MAX(0,es.gross_amount-es.discount_amount-es.return_amount) net_amount
        FROM seller_external_sales es JOIN salespeople sp ON sp.id=es.salesperson_id ${where}
        ORDER BY es.sale_date DESC,es.id DESC`).all(...args);
    },
    getExternalSaleById(id) {
      const sale = db().prepare(`SELECT es.*,sp.name salesperson_name,sp.seller_type,
        MAX(0,es.gross_amount-es.discount_amount-es.return_amount) net_amount
        FROM seller_external_sales es JOIN salespeople sp ON sp.id=es.salesperson_id WHERE es.id=?`).get(Number(id));
      if (!sale) return null;
      sale.items = db().prepare(`SELECT * FROM seller_external_sale_items WHERE external_sale_id=? ORDER BY id`).all(sale.id);
      return sale;
    },
    cancelExternalSale(id, reason, userId, userName) {
      const sale=db().prepare('SELECT * FROM seller_external_sales WHERE id=?').get(id);
      if(!sale) throw new Error('Venta externa no encontrada');
      if(sale.status==='anulada') throw new Error('La venta externa ya está anulada');
      if(!text(reason,300)) throw new Error('El motivo es obligatorio');
      const used=db().prepare(`SELECT 1 FROM seller_commission_lines l JOIN seller_commission_runs r ON r.id=l.commission_run_id
        WHERE l.source_type='talonario' AND l.source_id=? AND r.status IN ('aprobado','pagado')`).get(id);
      if(used) throw new Error('No se puede anular: la venta ya pertenece a una comisión aprobada o pagada');
      db().prepare("UPDATE seller_external_sales SET status='anulada',cancel_reason=?,cancelled_by=?,cancelled_at=datetime('now','localtime') WHERE id=?")
        .run(text(reason,300),userId||null,id);
      audit(userId||0,userName||'','venta_ambulante_anulada','seller_external_sales',id,reason);
      return true;
    },
    suggestedPeriod(sellerId, asOf) { return periodFor(requireSeller(sellerId).commission_frequency,asOf); },
    previewCommission({ salespersonId, from, to }) {
      return calculateCommission(requireSeller(salespersonId),isoDate(from),isoDate(to));
    },
    generateCommission({ salespersonId, from, to, notes }, userId, userName) {
      const seller=requireSeller(salespersonId); const dateFrom=isoDate(from),dateTo=isoDate(to);
      if(dateFrom>dateTo) throw new Error('El período de comisión es inválido');
      const overlapping=db().prepare(`SELECT id,date_from,date_to FROM seller_commission_runs
        WHERE salesperson_id=? AND status!='anulado' AND date_from<=? AND date_to>=? LIMIT 1`).get(seller.id,dateTo,dateFrom);
      if(overlapping) throw new Error(`Ya existe un corte de comisión que cruza este período (${overlapping.date_from} al ${overlapping.date_to})`);
      const calc=calculateCommission(seller,dateFrom,dateTo);
      if(!calc.lines.length || calc.commissionTotal<=0) throw new Error('No existen ventas comisionables en este período');
      return db().transaction(()=>{
        const r=db().prepare(`INSERT INTO seller_commission_runs(salesperson_id,date_from,date_to,frequency,calculation_mode,rate,fixed_amount,
          sales_total,margin_total,commission_total,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(seller.id,dateFrom,dateTo,
          seller.commission_frequency,seller.commission_mode,seller.commission_rate,seller.commission_fixed,calc.salesTotal,calc.marginTotal,
          calc.commissionTotal,text(notes,500),userId||null);
        const ins=db().prepare(`INSERT INTO seller_commission_lines(commission_run_id,source_type,source_id,sale_date,reference,customer_name,
          sale_amount,cost_amount,commission_base,commission_amount) VALUES(?,?,?,?,?,?,?,?,?,?)`);
        calc.lines.forEach(l=>ins.run(r.lastInsertRowid,l.source_type,l.source_id,l.sale_date,l.reference,l.customer_name,l.sale_amount,l.cost_amount,l.commission_base,l.commission_amount));
        audit(userId||0,userName||'','comision_generada','seller_commission_runs',r.lastInsertRowid,`${seller.name} · ${dateFrom}/${dateTo} · RD$${calc.commissionTotal}`);
        return { id:r.lastInsertRowid,...calc };
      })();
    },
    getCommissionRuns({ salespersonId, status }={}) {
      let where='WHERE 1=1';const args=[];
      if(salespersonId){where+=' AND r.salesperson_id=?';args.push(salespersonId);}
      if(status){where+=' AND r.status=?';args.push(status);}
      return db().prepare(`SELECT r.*,sp.name salesperson_name,sp.seller_type,
        (SELECT COUNT(*) FROM seller_commission_lines l WHERE l.commission_run_id=r.id) sales_count
        FROM seller_commission_runs r JOIN salespeople sp ON sp.id=r.salesperson_id ${where} ORDER BY r.date_to DESC,r.id DESC`).all(...args);
    },
    getCommissionById(id) {
      const run=db().prepare(`SELECT r.*,sp.name salesperson_name,sp.code salesperson_code,sp.seller_type
        FROM seller_commission_runs r JOIN salespeople sp ON sp.id=r.salesperson_id WHERE r.id=?`).get(Number(id));
      if(!run)return null;
      run.lines=db().prepare(`SELECT * FROM seller_commission_lines WHERE commission_run_id=? ORDER BY sale_date,source_type,source_id`).all(run.id);
      return run;
    },
    approveCommission(id,userId,userName){
      const run=db().prepare('SELECT * FROM seller_commission_runs WHERE id=?').get(id);
      if(!run)throw new Error('Comisión no encontrada'); if(run.status!=='borrador')throw new Error('Solo se aprueban comisiones en borrador');
      db().prepare("UPDATE seller_commission_runs SET status='aprobado',approved_by=?,approved_at=datetime('now','localtime') WHERE id=?").run(userId,id);
      audit(userId||0,userName||'','comision_aprobada','seller_commission_runs',id,`RD$${run.commission_total}`);return true;
    },
    createSellerExpense(data,userId,userName){
      const seller=requireSeller(data.salespersonId); const amount=money(data.amount);
      if(amount<=0)throw new Error('El monto debe ser mayor a cero');
      const kinds={viatico:'Viáticos vendedores',combustible:'Combustible vendedores',alojamiento:'Alojamiento vendedores',
        alimentacion:'Alimentación vendedores',peaje:'Peajes vendedores',otro:'Otros gastos vendedores'};
      const kind=kinds[data.kind]?data.kind:'viatico'; const catId=expensesRepo.ensureCategory(kinds[kind],'Personal');
      const expenseId=expensesRepo.create({type:'gasto',category_id:catId,description:`${kinds[kind]} · ${seller.name}${data.description?' · '+text(data.description,180):''}`,
        amount,total:amount,payment_method:data.payment_method||'efectivo',payment_source:data.payment_source||'pendiente',
        cash_session_id:data.cash_session_id||null,issue_date:isoDate(data.issue_date),notes:`Vendedor #${seller.id} (${seller.code}). ${text(data.notes,350)}`,
        user_id:userId,status:'pendiente_pago'});
      db().prepare('INSERT INTO seller_expense_links(salesperson_id,expense_id,expense_kind) VALUES(?,?,?)').run(seller.id,expenseId,kind);
      let payment=null;
      if(data.pay_now)payment=expensesRepo.pay({expenseId,amount,payment_method:data.payment_method||'efectivo',payment_source:data.payment_source||'caja_chica',
        cash_session_id:data.cash_session_id||null,reference:data.reference||null,userId,userName});
      audit(userId||0,userName||'','viatico_vendedor','expenses',expenseId,`${seller.name} · RD$${amount}`);
      return {expenseId,paymentId:payment?.paymentId||null};
    },
    getSellerExpenses({salespersonId,from,to}={}){
      let where="WHERE e.status NOT IN ('anulado','rechazado','borrador')";const args=[];
      if(salespersonId){where+=' AND l.salesperson_id=?';args.push(salespersonId);}if(from){where+=' AND e.issue_date>=?';args.push(isoDate(from));}if(to){where+=' AND e.issue_date<=?';args.push(isoDate(to));}
      return db().prepare(`SELECT l.*,e.description,e.issue_date,e.total,e.paid_amount,e.status,e.payment_method,e.payment_source,sp.name salesperson_name
        FROM seller_expense_links l JOIN expenses e ON e.id=l.expense_id JOIN salespeople sp ON sp.id=l.salesperson_id ${where} ORDER BY e.issue_date DESC,e.id DESC`).all(...args);
    },
    generatePayroll({from,to,frequency,notes},userId,userName){
      const dateFrom=isoDate(from),dateTo=isoDate(to);if(dateFrom>dateTo)throw new Error('El período de nómina es inválido');
      const payrollFrequency=['semanal','quincenal','mensual'].includes(frequency)?frequency:'mensual';
      const duplicate=db().prepare("SELECT id FROM payroll_runs WHERE date_from=? AND date_to=? AND frequency=? AND status!='anulado'").get(dateFrom,dateTo,payrollFrequency);
      if(duplicate)throw new Error('Ya existe una nómina activa para este período y frecuencia');
      const sellers=db().prepare("SELECT * FROM salespeople WHERE status='activo' AND ((salary_amount>0 AND payroll_frequency=?) OR id IN (SELECT salesperson_id FROM seller_commission_runs WHERE status='aprobado' AND payroll_run_id IS NULL AND frequency=? AND date_to BETWEEN ? AND ?)) ORDER BY name").all(payrollFrequency,payrollFrequency,dateFrom,dateTo);
      if(!sellers.length)throw new Error('No hay vendedores con salario o comisiones aprobadas para el período');
      return db().transaction(()=>{
        const next=db().prepare('SELECT COALESCE(MAX(id),0)+1 n FROM payroll_runs').get().n;const number=`NOM-${dateFrom.replace(/-/g,'')}-${String(next).padStart(4,'0')}`;
        const rr=db().prepare('INSERT INTO payroll_runs(number,date_from,date_to,frequency,notes,created_by) VALUES(?,?,?,?,?,?)').run(number,dateFrom,dateTo,payrollFrequency,text(notes,500),userId||null);
        const ins=db().prepare(`INSERT INTO payroll_items(payroll_run_id,salesperson_id,base_salary,commission_amount,net_amount) VALUES(?,?,?,?,?)`);
        sellers.forEach(s=>{const cr=db().prepare("SELECT COALESCE(SUM(commission_total),0) total FROM seller_commission_runs WHERE salesperson_id=? AND status='aprobado' AND payroll_run_id IS NULL AND frequency=? AND date_to BETWEEN ? AND ?").get(s.id,payrollFrequency,dateFrom,dateTo);
          const base=money(s.salary_amount),commission=money(cr.total),net=money(base+commission);if(net>0)ins.run(rr.lastInsertRowid,s.id,base,commission,net);});
        recalcPayroll(rr.lastInsertRowid);audit(userId||0,userName||'','nomina_generada','payroll_runs',rr.lastInsertRowid,`${number} · ${dateFrom}/${dateTo}`);return rr.lastInsertRowid;
      })();
    },
    getPayrollRuns(){return db().prepare(`SELECT r.*,(SELECT COUNT(*) FROM payroll_items i WHERE i.payroll_run_id=r.id) employee_count FROM payroll_runs r ORDER BY r.date_to DESC,r.id DESC`).all();},
    getPayrollById(id){const run=db().prepare('SELECT * FROM payroll_runs WHERE id=?').get(id);if(!run)return null;run.items=db().prepare(`SELECT i.*,sp.name salesperson_name,sp.code,sp.seller_type FROM payroll_items i JOIN salespeople sp ON sp.id=i.salesperson_id WHERE i.payroll_run_id=? ORDER BY sp.name`).all(id);return run;},
    updatePayrollItem(id,{bonusAmount,deductionAmount,notes}){const item=db().prepare('SELECT * FROM payroll_items WHERE id=?').get(id);if(!item)throw new Error('Detalle de nómina no encontrado');const run=db().prepare('SELECT * FROM payroll_runs WHERE id=?').get(item.payroll_run_id);if(run.status!=='borrador')throw new Error('Solo se modifica una nómina en borrador');const bonus=money(bonusAmount),deduction=money(deductionAmount),net=money(item.base_salary+item.commission_amount+bonus-deduction);db().prepare('UPDATE payroll_items SET bonus_amount=?,deduction_amount=?,net_amount=?,notes=? WHERE id=?').run(bonus,deduction,net,text(notes,300),id);recalcPayroll(item.payroll_run_id);return true;},
    approvePayroll(id,userId,userName){const run=this.getPayrollById(id);if(!run)throw new Error('Nómina no encontrada');if(run.status!=='borrador')throw new Error('Solo se aprueba una nómina en borrador');if(run.net_total<=0)throw new Error('La nómina no tiene monto pagable');db().prepare("UPDATE payroll_runs SET status='aprobado',approved_by=?,approved_at=datetime('now','localtime') WHERE id=?").run(userId,id);db().prepare("UPDATE seller_commission_runs SET payroll_run_id=? WHERE status='aprobado' AND payroll_run_id IS NULL AND frequency=? AND salesperson_id IN (SELECT salesperson_id FROM payroll_items WHERE payroll_run_id=?) AND date_to BETWEEN ? AND ?").run(id,run.frequency||'mensual',id,run.date_from,run.date_to);audit(userId||0,userName||'','nomina_aprobada','payroll_runs',id,run.number);return true;},
    payPayroll(id,data,userId,userName){
      const run=this.getPayrollById(id);if(!run)throw new Error('Nómina no encontrada');if(run.status!=='aprobado')throw new Error('La nómina debe estar aprobada antes de pagar');
      return db().transaction(()=>{const refs=[];const catId=expensesRepo.ensureCategory('Pago de nómina','Personal');for(const item of run.items){if(item.net_amount<=0)continue;const expenseId=expensesRepo.create({type:'gasto',category_id:catId,description:`Nómina ${run.number} · ${item.salesperson_name}`,amount:item.net_amount,total:item.net_amount,payment_method:data.payment_method||'efectivo',payment_source:data.payment_source||'caja_chica',cash_session_id:data.cash_session_id||null,issue_date:isoDate(data.payment_date),notes:`Salario RD$${item.base_salary}; comisión RD$${item.commission_amount}; bonos RD$${item.bonus_amount}; deducciones RD$${item.deduction_amount}`,user_id:userId,status:'pendiente_pago'});db().prepare("INSERT INTO seller_expense_links(salesperson_id,expense_id,expense_kind) VALUES(?,?,'nomina')").run(item.salesperson_id,expenseId);const pay=expensesRepo.pay({expenseId,amount:item.net_amount,payment_method:data.payment_method||'efectivo',payment_source:data.payment_source||'caja_chica',cash_session_id:data.cash_session_id||null,reference:data.reference||run.number,userId,userName});db().prepare('UPDATE payroll_items SET expense_id=? WHERE id=?').run(expenseId,item.id);refs.push({expenseId,paymentId:pay.paymentId});}
        db().prepare("UPDATE payroll_runs SET status='pagado',payment_date=?,paid_by=?,paid_at=datetime('now','localtime') WHERE id=?").run(isoDate(data.payment_date),userId,id);db().prepare("UPDATE seller_commission_runs SET status='pagado' WHERE payroll_run_id=? AND status='aprobado'").run(id);audit(userId||0,userName||'','nomina_pagada','payroll_runs',id,`${run.number} · RD$${run.net_total}`);return refs;})();
    },
  };
}

module.exports = { ensureSalespeopleSchema, createSalespeopleRepo, periodFor };
