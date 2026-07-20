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
  financialAccounts: [],
  activeBusiness: null,
  // Alias para compatibilidad con módulos viejos
  get clients() { return this.customers; },
  get users()   { return window._cachedUsers || []; },
};

// ── Número de factura mostrable (helper global) ───────────────
// Prioridad: numero_factura_fmt → numero_factura (padStart 8) → id interno (padStart 5).
// Acepta objetos de venta (s), factura pendiente (f), pago con JOIN (p) o
// match de búsqueda por artículo (m); reconoce los alias equivalentes de cada campo.
// `fallbackRef` (opcional) se usa antes del id interno — p.ej. la referencia de
// importación de una factura sin número real todavía. Devuelve con '#' incluido.
// NOTA: se define en data.js (carga primero) para estar disponible en TODOS los
// módulos (clientes, ventas, pos, reportes, plantillas, print).
function facturaLabel(o, fallbackRef) {
  if (!o) return fallbackRef || '';
  const fmt = o.numero_factura_fmt || o.sale_numero_factura_fmt || o.numFact;
  if (fmt) return '#' + fmt;
  const num = o.numero_factura != null ? o.numero_factura : o.sale_numero_factura;
  if (num != null && num !== '') return '#' + String(num).padStart(8, '0');
  if (fallbackRef) return fallbackRef;
  const id = o.id != null ? o.id : (o.sale_id != null ? o.sale_id : o.saleId);
  return '#' + String(id != null ? id : '').padStart(5, '0');
}

// Etiqueta de la factura ORIGINAL de una devolución/nota de crédito.
// Usa el número real de la venta original (original_numero_factura_fmt, provisto
// por getById/getAll) y cae al id interno (original_sale_id) solo si no existe.
function facturaLabelOriginal(sale) {
  if (!sale) return '';
  return facturaLabel({
    numero_factura_fmt: sale.original_numero_factura_fmt,
    numero_factura:     sale.original_numero_factura,
    id:                 sale.original_sale_id,
  });
}

// ── Configuración del negocio ─────────────────
// Se carga desde settings al iniciar
let CFG = {
  biz:          'Velo POS',
  rnc:          '',
  addr:         '',
  phone:        '',
  itbis:        0,
  fiscalEnabled:           false,
  module_gastos:           '0',
  module_sucursales:       '0',
  module_vehiculos:        '0',
  module_mantenimiento:    '0',
  module_envios:           '0',
  module_ncf_avanzado:     '0',
  module_multi_negocio:    '0',
  module_contabilidad:     '0',
  activeBusinessId:        '',
  activeBusinessName:      '',
  connectionMode:          'local',
};

// ── Denominaciones de billetes RD$ ────────────
const DENS = [2000,1000,500,200,100,50,25,10,5,1];

// ── Categorías ────────────────────────────────
// Se cargan desde SQLite en loadAppData()
// Fallback a categorías de auto parts si la DB aún no cargó
let CATS = [
  'Filtros','Eléctrico','Frenos','Suspensión',
  'Motor','Lubricantes','Encendido','Enfriamiento','Otros'
];

async function reloadCategories() {
  try {
    const r = await window.api.categories.getAll();
    if (r?.ok && r.data?.length) {
      CATS = r.data.map(c => c.name);
    }
  } catch {}
}

// ══════════════════════════════════════════════
// CARGAR DATOS INICIALES (IPC)
// Carga lo mínimo necesario al arrancar.
// Cada módulo recarga lo que necesita bajo demanda.
// ══════════════════════════════════════════════
async function loadAppData() {
  try {
    // ── OPTIMIZACIÓN: Carga en 2 fases ────────────────────────────
    // Fase 1: crítico — lo que el usuario ve primero (productos + settings)
    // Fase 2: secundario — en background sin bloquear la UI
    // Resiliencia multi-terminal: en modo cliente estas llamadas se reenvían al
    // servidor; con .catch evitamos que un fallo de red rompa el arranque (el
    // preflight ya bloquea el caso servidor-caído, esto es defensa en profundidad).
    const [products, settings, activeBusinessRes] = await Promise.all([
      window.api.products.getAll().catch(() => null),
      window.api.settings.getAll().catch(() => null),
      window.api.business?.getActive
        ? window.api.business.getActive().catch(() => null)
        : Promise.resolve(null),
    ]);

    DB.products = products || [];
    DB.settings = settings || {};
    DB.activeBusiness = activeBusinessRes?.data || null;

    // Aplicar configuración inmediatamente — la UI ya puede renderizar
    if (settings) {
      CFG.biz            = settings.biz_name      || CFG.biz;
      CFG.rnc            = settings.biz_rnc       || CFG.rnc;
      CFG.addr           = settings.biz_addr      || CFG.addr;
      CFG.phone          = settings.biz_phone     || CFG.phone;
      CFG.biz_logo       = settings.biz_logo      || '';
      CFG.biz_logo_2     = settings.biz_logo_2    || '';
      CFG.receipt_msg    = settings.receipt_msg   || '¡Gracias por su compra!';
      CFG.print_template = settings.print_template || '';
      CFG.fiscalEnabled        = settings.fiscal_enabled === '1';
      CFG.module_sucursales    = settings.module_sucursales    || '0';
      CFG.module_vehiculos     = settings.module_vehiculos     || '0';
      CFG.module_mantenimiento = settings.module_mantenimiento || '0';
      if (CFG.module_mantenimiento === '1') CFG.module_vehiculos = '1';
      CFG.module_envios        = settings.module_envios        || '0';
      CFG.module_ncf_avanzado  = settings.module_ncf_avanzado  || '0';
      CFG.module_gastos        = settings.module_gastos        || '0';
      CFG.module_multi_negocio = settings.module_multi_negocio || '0';
      CFG.module_contabilidad  = settings.module_contabilidad  || '0';
      CFG.activeBusinessId     = DB.activeBusiness?.id || '';
      CFG.activeBusinessName   = DB.activeBusiness?.name || (CFG.activeBusinessId ? CFG.biz : '');
      CFG.connectionMode       = settings.connection_mode || CFG.connectionMode || 'local';
      // Combustibles a mostrar en el banner del topbar (JSON array de grados).
      // Vacío/ausente → el banner cae al default (premium) y su localStorage.
      CFG.banner_fuels         = settings.banner_fuels || '';

      // Permisos por rol — qué roles pueden acceder a cada módulo
      CFG.module_gastos_roles        = settings.module_gastos_roles        || 'admin';
      CFG.module_contabilidad_roles  = settings.module_contabilidad_roles  || 'admin';
      CFG.barcode_enabled_roles      = settings.barcode_enabled_roles      || 'admin';
      CFG.module_sucursales_roles    = settings.module_sucursales_roles    || 'admin';
      CFG.module_vehiculos_roles     = settings.module_vehiculos_roles     || 'admin';
      CFG.module_mantenimiento_roles = settings.module_mantenimiento_roles || 'admin';
      CFG.module_envios_roles        = settings.module_envios_roles        || 'admin,cajero';
      CFG.module_ncf_avanzado_roles  = settings.module_ncf_avanzado_roles  || 'admin';
      CFG.fiscal_enabled_roles       = settings.fiscal_enabled_roles       || 'admin';
        CFG.itbis = parseFloat(settings.tax_pct) || 18;
      window._bcEnabled = settings.barcode_enabled === '1' || settings.barcode_enabled === true;
    }

    // Verificar caja — necesario antes de mostrar POS
    await chkCaja();

    // Fase 2: cargar el resto en background sin bloquear
    Promise.all([
      window.api.customers.getAll(),
      window.api.cash.getSessions(),
      window.api.users.getAll(),
      window.api.customers.getAllPayments
        ? window.api.customers.getAllPayments().catch(() => [])
        : Promise.resolve([]),
    ]).then(([customers, sessions, users, payments]) => {
      window._cachedUsers = users || [];
      DB.customers = customers || [];
      DB.caja      = sessions  || [];
      DB.payments  = payments  || [];
    }).catch(e => console.warn('[loadAppData phase2]', e));

    // Fase 2 también: ventas de hoy y categorías
    reloadSales({ range: 'today' }).catch(() => {});
    reloadCategories().catch(() => {});
    reloadFinancialAccounts().catch(() => {});

    // Datos que SÍ esperamos al inicio (ya los tenemos de Fase 1)
    const customers = [];
    const sessions  = [];
    const users     = [];
    const payments  = [];

    // Cache de usuarios para dropdown de login
    window._cachedUsers = users || [];

    DB.customers = customers || [];
    DB.caja      = sessions  || [];
    DB.payments  = payments  || [];
    // Ventas: cargar sólo hoy al inicio. Los módulos que necesitan más rango
    // llaman reloadSales({ range: 'week'|'month'|'all' }) ellos mismos.
    DB.sales     = [];

    // (CFG ya aplicado en Fase 1 — ver arriba)

  } catch (e) {
    console.error('[loadAppData]', e);
  }
}

async function reloadProducts() {
  DB.products = await window.api.products.getAll() || [];
}

// Cuentas financieras (Bancos y Cuentas) — cacheadas para el cobro (selección de
// cuenta en transferencia) y para la plantilla A4 (datos bancarios en factura).
async function reloadFinancialAccounts() {
  try {
    const r = await window.api.financial?.getAll?.();
    DB.financialAccounts = (r?.ok ? r.data : (Array.isArray(r) ? r : [])) || [];
  } catch { DB.financialAccounts = DB.financialAccounts || []; }
  return DB.financialAccounts;
}

async function reloadCustomers() {
  DB.customers = await window.api.customers.getAll() || [];
}

async function reloadSales(filters = {}) {
  // Para el historial completo (range:'all') subimos el límite por defecto:
  // antes se cortaba en 200 y el usuario no veía todas sus ventas. El render
  // incremental del frontend evita que traer más filas congele la UI.
  // El backend soporta offset para paginar más allá de este tope si hiciera falta.
  const f = { ...filters };
  if ((f.range === 'all' || !f.range) && f.limit == null) f.limit = 1000;
  const sales = await window.api.sales.getAll(f) || [];
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
// SYNC EN TIEMPO REAL (Fase C, multi-terminal)
// ══════════════════════════════════════════════
// El main avisa "cambió el scope X" cuando otra terminal muta datos compartidos.
// Aquí SOLO re-consultamos al servidor (fuente de verdad) y refrescamos de forma
// DIRIGIDA: nunca re-renderizamos el POS entero ni tocamos el carrito del cajero;
// como mucho se repinta la grilla de productos o la tabla del listado abierto.
// Debounce: una ráfaga de avisos colapsa en un solo refresco.
let _syncPending = new Set();
let _syncTimer = null;
async function _applyRemoteSync() {
  const s = _syncPending; _syncPending = new Set(); _syncTimer = null;
  const at = (typeof page !== 'undefined') ? page : null;
  try {
    if (s.has('products')) {
      await reloadProducts();
      if (at === 'pos'        && typeof renderPOSGrid   === 'function') renderPOSGrid();
      else if (at === 'inventario' && typeof renderInvTable === 'function') renderInvTable();
    }
    if (s.has('customers')) {
      await reloadCustomers();
      if (at === 'clientes' && typeof renderCliTable === 'function') renderCliTable();
    }
    if (s.has('sales')) {
      await reloadSales({ range: (typeof ventasRange !== 'undefined' ? ventasRange : 'today') });
      if (at === 'ventas' && typeof renderVentasTable === 'function') renderVentasTable();
    }
  } catch (e) { console.error('[sync]', e); }
}
function _onRemoteSync(data) {
  const scopes = data && Array.isArray(data.scopes) ? data.scopes : null;
  if (!scopes || !scopes.length) return;
  scopes.forEach(sc => _syncPending.add(sc));
  if (_syncTimer) return;
  _syncTimer = setTimeout(_applyRemoteSync, 250);
}
try {
  if (window.api && window.api.sync && typeof window.api.sync.onChanged === 'function') {
    window.api.sync.onChanged(_onRemoteSync);
  }
} catch { /* sin multi-terminal → nunca llega ningún evento */ }

// ══════════════════════════════════════════════
// TERMINAL (multi-terminal) — identidad estable de esta máquina
// ══════════════════════════════════════════════
let TERMINAL_ID = '';
async function ensureTerminalId() {
  if (TERMINAL_ID) return TERMINAL_ID;
  try {
    const info = await window.api.app.getTerminalInfo();
    if (info && info.ok) {
      TERMINAL_ID = info.terminalId || '';
      if (typeof CFG !== 'undefined') { CFG.terminalId = TERMINAL_ID; CFG.connectionMode = info.mode || 'local'; }
    }
  } catch { /* si falla, TERMINAL_ID queda '' → comportamiento local histórico */ }
  return TERMINAL_ID;
}

// ══════════════════════════════════════════════
// CAJA
// ══════════════════════════════════════════════
async function chkCaja() {
  // Caja por terminal: cada máquina consulta SU caja abierta. Sin terminalId
  // (no cargado aún) degrada al comportamiento histórico (caja global).
  const terminalId = await ensureTerminalId();
  const session = await window.api.cash.getOpen({ terminalId });
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

// ── Helpers de búsqueda (motor único de todos los buscadores) ──
// Normaliza para comparar texto: minúsculas + quita tildes/acentos.
// "FAÑA" → "fana", "José" → "jose", "ESCAÑO" → "escano".
// Así "faña", "fana", "FAÑA" se encuentran entre sí. Maneja Ñ/Ç/tildes
// que SQLite lower() y un toLowerCase() crudo no equiparan.
const searchNorm = (s) =>
  String(s == null ? '' : s)
    .normalize('NFD')              // separa letra + acento
    .replace(/[\u0300-\u036f]/g, '') // elimina los acentos
    .toLowerCase()
    .trim();

// Extrae solo dígitos de una cadena (para teléfonos/RNC con guiones).
// "809-555-1234" → "8095551234". Devuelve '' si no hay dígitos.
const digitsOf = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// ¿El texto `hay` (haystack) contiene la búsqueda `q` ya normalizada?
// Acepta q crudo y lo normaliza. Vacío → no filtra (true).
const matchText = (hay, qNorm) =>
  !qNorm || searchNorm(hay).includes(qNorm);

// ¿Coincide por dígitos? GUARDA anti-falso-positivo: si la búsqueda no
// tiene dígitos, devuelve false (no aporta match) en vez de includes('')
// que siempre da true. Este era el bug de "abanico" en Ventas.
const matchDigits = (hay, qDigits) =>
  !!qDigits && digitsOf(hay).includes(qDigits);

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
  // Valida que credit_due sea una fecha YYYY-MM-DD real (evita NaN por datos corruptos)
  const validDue = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return DB.customers
    .filter(c => c.balance > 0 && c.id !== 1)
    .map(c => {
      const daysLeft = validDue(c.credit_due) ? daysDiff(td, c.credit_due) : -999;
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
// ══════════════════════════════════════════════
// WHATSAPP — Modal universal
// Usa shell.openExternal para abrir en el
// navegador real del sistema (no Electron interno)
// ══════════════════════════════════════════════
function openWhatsAppModal(msg, defPhone = '', clientName = 'cliente') {
  // Escapar todo lo dinámico antes de interpolarlo en el HTML del modal —
  // msg/clientName pueden venir de datos del cliente (nombre, notas, etc.)
  const escapedMsg   = _escHtml(msg);
  const escapedName  = _escHtml(clientName);
  const escapedPhone = _escHtml((defPhone || '').replace(/\D/g, ''));

  openModal(`
    <div class="modal-title" style="display:flex;align-items:center;gap:10px">
      <div style="width:36px;height:36px;background:#25D366;border-radius:9px;
                  display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="#fff">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/>
        </svg>
      </div>
      Enviar por WhatsApp
    </div>
    <div class="modal-sub">A: ${escapedName}</div>

    <div class="fg">
      <label class="lbl">Número de WhatsApp</label>
      <div class="inp-ic">
        <div class="ic" style="font-size:11px;font-weight:700;color:var(--muted)">+</div>
        <input class="inp" id="wa-phone-input" type="tel"
               placeholder="18091234567  (con código de país)"
               value="${escapedPhone}"
               onkeydown="if(event.key==='Enter') _waEnviar()"
               style="font-size:15px;font-weight:600;letter-spacing:.5px"/>
      </div>
      <div style="font-size:11px;color:var(--muted2);margin-top:4px">
        República Dominicana: <strong>1809</strong>, <strong>1829</strong> o <strong>1849</strong> + 7 dígitos
      </div>
    </div>

    <div style="margin-top:12px">
      <label class="lbl">Vista previa del mensaje</label>
      <div style="background:var(--surface2);border:1px solid var(--line);border-radius:8px;
                  padding:12px;font-size:12px;line-height:1.7;color:var(--ink3);
                  max-height:180px;overflow-y:auto;white-space:pre-wrap;font-family:var(--mono)">
${escapedMsg}
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn" style="background:#25D366;color:#fff;border-color:#25D366"
              onclick="_waEnviar()">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="flex-shrink:0">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/>
        </svg>
        Abrir WhatsApp
      </button>
    </div>
  `);

  // Guardar msg para que _waEnviar lo use
  window._waPendingMsg = msg;
  setTimeout(() => {
    const inp = document.getElementById('wa-phone-input');
    if (inp) { inp.focus(); inp.select(); }
  }, 100);
}

async function _waEnviar() {
  const inp   = document.getElementById('wa-phone-input');
  const phone = (inp?.value || '').replace(/\D/g, '').trim();
  const msg   = window._waPendingMsg || '';

  if (!phone) {
    inp?.classList.add('inp-err');
    toast('Ingresa el número de WhatsApp', 'w');
    return;
  }
  if (phone.length < 10) {
    toast('Número muy corto — incluye el código de país (ej: 18091234567)', 'w');
    return;
  }
  if (phone.length > 15) {
    toast('Número muy largo — verifica el número de WhatsApp', 'w');
    return;
  }

  const encoded = encodeURIComponent(msg);
  const url     = 'https://wa.me/' + phone + '?text=' + encoded;

  closeModal();

  // Abrir en el NAVEGADOR DEL SISTEMA via shell.openExternal
  const result = await window.api.shell.openExternal(url).catch(() => ({ ok: false }));
  if (result?.ok === false) {
    toast('No se pudo abrir WhatsApp — verifica que tengas un navegador instalado', 'e');
  } else {
    toast('✓ WhatsApp abierto en el navegador', 'ok');
  }
}
