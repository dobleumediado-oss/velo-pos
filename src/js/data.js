// ══════════════════════════════════════════════
// data.js — Estado global del renderer
// Usa window.api (IPC) para todo acceso a datos
// NUNCA accede a localStorage ni a Node directamente
// ══════════════════════════════════════════════

// ── Estado global en memoria ──────────────────
let user        = null;   // usuario autenticado
let page        = 'dash'; // página actual
let sbSm        = false;  // sidebar colapsado
let cajaOpen    = false;  // caja abierta
let cajaSession = null;   // sesión de caja activa

// ── Cache en memoria (se recarga via IPC) ─────
const DB = {
  products:  [],
  customers: [],
  sales:     [],
  caja:      [],
  payments:  [],
  settings:  {},
  // Alias para compatibilidad con módulos viejos
  get clients() { return this.customers; },
  get users()   { return window._cachedUsers || []; },
};

// ── Configuración del negocio ─────────────────
// Se carga desde settings al iniciar
let CFG = {
  biz:   'Velo POS',
  rnc:   '',
  addr:  '',
  phone: '',
  itbis: 18,
};

// ── Denominaciones de billetes RD$ ────────────
const DENS = [2000,1000,500,200,100,50,25,10,5,1];

// ── Categorías ────────────────────────────────
const CATS = [
  'Filtros','Eléctrico','Frenos','Suspensión',
  'Motor','Lubricantes','Encendido','Enfriamiento','Otros'
];

// ══════════════════════════════════════════════
// CARGAR DATOS INICIALES (IPC)
// ══════════════════════════════════════════════
async function loadAppData() {
  try {
    const [products, customers, settings, sessions, users, sales, payments] = await Promise.all([
      window.api.products.getAll(),
      window.api.customers.getAll(),
      window.api.settings.getAll(),
      window.api.cash.getSessions(),
      window.api.users.getAll(),
      window.api.sales.getAll({ range: 'all' }),
      window.api.customers.getAllPayments ? window.api.customers.getAllPayments().catch(() => []) : Promise.resolve([]),
    ]);

    // Cache de usuarios para dropdown de login
    window._cachedUsers = users || [];

    DB.products  = products  || [];
    DB.customers = customers || [];
    DB.settings  = settings  || {};
    DB.caja      = sessions  || [];
    DB.sales     = sales     || [];
    DB.payments  = payments  || [];

    // Cargar configuración del negocio
    if (settings) {
      CFG.biz            = settings.biz_name      || CFG.biz;
      CFG.rnc            = settings.biz_rnc       || CFG.rnc;
      CFG.addr           = settings.biz_addr      || CFG.addr;
      CFG.phone          = settings.biz_phone     || CFG.phone;
      CFG.itbis          = (settings.tax_pct !== undefined && settings.tax_pct !== '') ? parseFloat(settings.tax_pct) : 18;
      CFG.biz_logo       = settings.biz_logo      || '';
      CFG.receipt_msg    = settings.receipt_msg   || '¡Gracias por su compra!';
      CFG.print_template = settings.print_template || '';
    }

    // Verificar caja
    await chkCaja();

  } catch (e) {
    console.error('[loadAppData]', e);
  }
}

async function reloadProducts() {
  DB.products = await window.api.products.getAll() || [];
}

async function reloadCustomers() {
  DB.customers = await window.api.customers.getAll() || [];
}

async function reloadSales(filters = {}) {
  const sales = await window.api.sales.getAll(filters) || [];
  // Normalizar campos SQLite → compatibilidad con módulos
  DB.sales = sales.map(s => ({
    ...s,
    // Aliases para compatibilidad
    clientId:     s.customer_id    || s.clientId,
    clientName:   s.customer_name  || s.clientName  || 'Consumidor Final',
    clientCedula: s.customer_rnc   || s.clientCedula || '',
    pay:          s.payment_method || s.pay          || 'efectivo',
    date:         (s.created_at    || s.date || '').split('T')[0].split(' ')[0],
    time:         s.created_at
      ? new Date(s.created_at).toLocaleTimeString('es-DO',
          { hour: '2-digit', minute: '2-digit' })
      : (s.time || ''),
    itbis:        s.tax_amt        || s.itbis        || 0,
    disc:         s.discount_pct   || s.disc         || 0,
    discAmt:      s.discount_amt   || s.discAmt      || 0,
    cajaId:       s.cash_session_id|| s.cajaId,
    // items_summary viene como "Producto x2 | Otro x1"
    // lo parseamos a array básico si no hay items cargados
    items: s.items || [],
  }));

  // Sincronizar con compat
  if (window._syncDB) window._syncDB({ sales: DB.sales });
}

// ══════════════════════════════════════════════
// CAJA
// ══════════════════════════════════════════════
async function chkCaja() {
  const session = await window.api.cash.getOpen();
  cajaOpen    = !!session;
  cajaSession = session || null;
}

// ══════════════════════════════════════════════
// POS — MÚLTIPLES FACTURAS
// ══════════════════════════════════════════════
function newInvObj(id) {
  return {
    id, cart: [], pmode: 'retail', itype: 'factura',
    pmeth: 'efectivo', cliId: 1, cliName: '', cliCedula: '', disc: 0
  };
}

let invoices      = [newInvObj(1)];
let activeInvoice = 0;
let invCounter    = 1;

function currentInv() {
  return invoices[activeInvoice] || invoices[0];
}

function addInvoice() {
  invCounter++;
  invoices.push(newInvObj(invCounter));
  activeInvoice = invoices.length - 1;
}

function removeInvoice(idx) {
  if (invoices.length === 1) {
    invCounter++;
    invoices[0] = newInvObj(invCounter);
    activeInvoice = 0;
    return;
  }
  invoices.splice(idx, 1);
  if (activeInvoice >= invoices.length) activeInvoice = invoices.length - 1;
}

function resetInvoices() {
  invCounter    = 1;
  invoices      = [newInvObj(1)];
  activeInvoice = 0;
}

// ══════════════════════════════════════════════
// UTILIDADES
// ══════════════════════════════════════════════

// Formato moneda RD$
const fmt = n =>
  'RD$' + Number(n || 0).toLocaleString('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

// Fecha de hoy YYYY-MM-DD
const today = () => new Date().toISOString().split('T')[0];

// Hora actual HH:MM
const nowt = () =>
  new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });

// Formatear fecha legible
const fdate = d =>
  d ? new Date(d + 'T12:00').toLocaleDateString('es-DO', {
    day: '2-digit', month: 'short', year: 'numeric'
  }) : '—';

// Sumar N días a YYYY-MM-DD
function addDays(date, n) {
  const d = new Date(date + 'T12:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Diferencia en días
function daysDiff(dateA, dateB) {
  const a = new Date(dateA + 'T12:00');
  const b = new Date(dateB + 'T12:00');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// ── DOM helpers ───────────────────────────────
function h(tag, attr, ...ch) {
  const el = document.createElement(tag);
  if (attr) for (const [k, v] of Object.entries(attr)) {
    if (v == null) continue;
    if (k === 'class')                      el.className = v;
    else if (k === 'html')                  el.innerHTML = v;
    else if (k.startsWith('on'))            el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else                                    el.setAttribute(k, v);
  }
  ch.flat(9).forEach(c => {
    if (c == null) return;
    if (typeof c === 'string' || typeof c === 'number') {
      el.appendChild(document.createTextNode(String(c)));
    } else if (c instanceof Node) {
      el.appendChild(c);
    }
    // Ignore anything else (booleans, objects, etc.)
  });
  return el;
}

// Toast
function toast(msg, t = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.background =
    t === 'err' ? 'var(--red)' :
    t === 'w'   ? 'var(--amber)' : 'var(--ink)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Alertas de crédito ────────────────────────
function getCreditAlerts() {
  const td = today();
  return DB.customers
    .filter(c => c.balance > 0 && c.id !== 1)
    .map(c => {
      const daysLeft = c.credit_due ? daysDiff(td, c.credit_due) : -999;
      const status   = daysLeft < 0 ? 'overdue' : daysLeft <= 5 ? 'soon' : 'ok';
      return { client: c, daysLeft, status };
    })
    .filter(a => a.status !== 'ok')
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// ── Ventas helpers ────────────────────────────
function getSales(range = 'today') {
  const td = today();
  return DB.sales.filter(s => {
    const d = (s.created_at || '').split('T')[0] || s.created_at?.split(' ')[0];
    if (range === 'today')     return d === td;
    if (range === 'yesterday') {
      const y = new Date(); y.setDate(y.getDate() - 1);
      return d === y.toISOString().split('T')[0];
    }
    if (range === 'week') {
      const w = new Date(); w.setDate(w.getDate() - 7);
      return d >= w.toISOString().split('T')[0];
    }
    if (range === 'month') return d?.startsWith(td.slice(0, 7));
    return true;
  });
}