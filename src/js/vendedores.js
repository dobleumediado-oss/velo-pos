// ════════════════════════════════════════════════════════════════════════════
// vendedores.js — Operación comercial de vendedores fijos y ambulantes
// ════════════════════════════════════════════════════════════════════════════

let _venTab = 'resumen';
let _venState = { sellers: [], dashboard: null, external: [], commissions: [], expenses: [] };
let _venRange = { from: '', to: '' };
let _venQuery = '';
let _venListFilter = 'todos';
let _venCalendarDate = '';
let _venCoverageMap = null;
let _venCoverageMarkers = new Map();

function _venEsc(v) {
  return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function _venToday() {
  if (typeof today === 'function') return today();
  const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _venMonthStart() { const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; }
function _venMoney(v) { return typeof fmt === 'function' ? fmt(Number(v)||0) : `RD$${(Number(v)||0).toFixed(2)}`; }
function _venBadge(status) {
  const cls = ['activo','aprobado','pagado','registrada'].includes(status) ? 'g'
    : ['borrador','pendiente'].includes(status) ? 'a' : 'n';
  return `<span class="badge ${cls}">${_venEsc(String(status||'').replaceAll('_',' '))}</span>`;
}
function _venSellerOptions(selected, activeOnly=true) {
  return _venState.sellers.filter(s=>!activeOnly||s.status==='activo').map(s=>
    `<option value="${s.id}" ${Number(selected)===Number(s.id)?'selected':''}>${_venEsc(s.code)} · ${_venEsc(s.name)} (${s.seller_type})</option>`).join('');
}
function _venModeLabel(s) {
  if(s.commission_mode==='percent_sales')return `${s.commission_rate}% venta neta`;
  if(s.commission_mode==='percent_margin')return `${s.commission_rate}% margen`;
  if(s.commission_mode==='fixed_sale')return `${_venMoney(s.commission_fixed)} por venta`;
  return 'Sin comisión';
}

function _venSellerPerformance(id) {
  return (_venState.dashboard?.rows || []).find(row => Number(row.id) === Number(id)) ||
    { id:Number(id), sales:0, margin:0, commission:0, expenses:0, salesCount:0 };
}

function _venGoalPercent(seller, sales = 0) {
  const goal = Number(seller?.sales_goal || 0);
  return goal > 0 ? Math.max(0, Math.min(999, (Number(sales || 0) / goal) * 100)) : 0;
}

function _venMiniLine(values, color = '#10b981') {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return '<div class="ven-profile-nochart">Aún no hay suficientes días para mostrar tendencia.</div>';
  const width=280,height=72,min=Math.min(...nums),max=Math.max(...nums),span=Math.max(1,max-min);
  const points=nums.map((v,i)=>`${(i/(nums.length-1))*width},${height-8-((v-min)/span)*(height-18)}`).join(' ');
  return `<svg class="ven-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><linearGradient id="venLineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><polygon points="0,${height} ${points} ${width},${height}" fill="url(#venLineFill)"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function _venInitials(name) {
  return String(name || 'V').trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
}

function _venNorm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function _venMatches(...values) {
  const q = _venNorm(_venQuery);
  return !q || values.some(v => _venNorm(v).includes(q));
}

function _venEmpty(icon, title, text, actionLabel = '', action = '') {
  return `<div class="ven-empty">
    <div class="ven-empty-icon">${svg(icon)}</div>
    <h3>${_venEsc(title)}</h3><p>${_venEsc(text)}</p>
    ${actionLabel ? `<button class="btn btn-green btn-sm" onclick="${action}">${svg('plus')} ${_venEsc(actionLabel)}</button>` : ''}
  </div>`;
}

function _venSetTab(tab) {
  if (tab !== 'mapa' && _venCoverageMap) { try { _venCoverageMap.remove(); } catch {} _venCoverageMap=null;_venCoverageMarkers=new Map(); }
  _venTab = tab;
  _venQuery = '';
  _venListFilter = 'todos';
  _venRender();
}

function _venSetQuery(value) {
  _venQuery = value || '';
  const content = document.getElementById('ven-content');
  if (!content) return;
  if (_venTab === 'vendedores') _venRenderSellers(content);
  if (_venTab === 'externas') _venRenderExternal(content);
  if (_venTab === 'viaticos') _venRenderExpenses(content);
  requestAnimationFrame(() => {
    const input = document.querySelector('.ven-search input');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  });
}

function _venSetListFilter(value) {
  _venListFilter = value || 'todos';
  _venSetQuery(_venQuery);
}

async function _venApplyPeriod() {
  const from = document.getElementById('ven-range-from')?.value;
  const to = document.getElementById('ven-range-to')?.value;
  if (!from || !to || from > to) { toast('Selecciona un período válido', 'w'); return; }
  _venRange = { from, to };
  await renderVendedores(document.getElementById('page'));
}

function _venToolbar({ placeholder, filters = '', action = '' }) {
  return `<div class="ven-toolbar">
    <div class="ven-search">${svg('search')}<input value="${_venEsc(_venQuery)}" oninput="_venSetQuery(this.value)" placeholder="${_venEsc(placeholder)}"/></div>
    <div class="flex">${filters}${action}</div>
  </div>`;
}

async function renderVendedores(el) {
  if (!['admin','superadmin','cajero'].includes(user?.role)) { routeTo('dash'); return; }
  // Compatibilidad con sesiones que conservaron la pestaña del antiguo diseño combinado.
  if (_venTab === 'comisiones') _venTab = 'resumen';
  if (!_venRange.from) _venRange = { from: _venMonthStart(), to: _venToday() };
  el.innerHTML = `<div class="ven-shell"><div class="ven-panel"><div class="ven-empty">
    <div class="ven-empty-icon">${svg('clock')}</div><h3>Preparando el centro de vendedores</h3>
    <p>Conectando perfiles, ventas externas, rutas y viáticos…</p></div></div></div>`;
  const canManageFinance = ['admin','superadmin'].includes(user?.role);
  const [sellers,dashboard,external,commissions,expenses] = await Promise.all([
    window.api.salespeople.getAll({}),
    window.api.salespeople.getDashboard(_venRange),
    window.api.salespeople.getExternalSales(_venRange),
    canManageFinance ? window.api.salespeople.getCommissionRuns({}) : Promise.resolve({ok:true,data:[]}),
    window.api.salespeople.getExpenses(_venRange),
  ]);
  _venState = {
    sellers:sellers?.data||[], dashboard:dashboard?.data||null, external:external?.data||[],
    commissions:commissions?.data||[], expenses:expenses?.data||[],
  };
  DB.salespeople = _venState.sellers.filter(s=>s.status==='activo');
  _venRender(el);
}

function _venRender(el=document.getElementById('page')) {
  if(!el)return;
  const tabs=[
    ['resumen','grid','Centro de control',''],
    ['vendedores','users','Vendedores',_venState.sellers.length],
    ['externas','receipt','Ventas externas',_venState.external.length],
    ['viaticos','cash','Viáticos',_venState.expenses.length],
    ['agenda','calendar','Agenda',''],
    ['mapa','map-pin','Cobertura',_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante').length],
  ];
  el.innerHTML=`
    <div class="ven-shell">
      <section class="ven-hero">
        <div class="ven-hero-main">
          <div><div class="ven-eyebrow"><span class="dot"></span> Operación y dirección comercial</div>
            <h1>Vendedores</h1>
            <p>Administra perfiles, rutas, cobertura, ventas externas y viáticos de vendedores fijos y ambulantes.</p>
          </div>
          <div class="ven-actions">
            <button class="btn btn-out" onclick="vendedoresOpenExternalSale()">${svg('receipt')} Registrar venta externa</button>
            <button class="btn btn-green" onclick="vendedoresOpenSeller()">${svg('plus')} Nuevo vendedor</button>
          </div>
        </div>
        <div class="ven-hero-bottom">
          <div class="ven-period"><label>PERÍODO</label>
            <input id="ven-range-from" type="date" value="${_venEsc(_venRange.from)}"/>
            <span style="color:rgba(255,255,255,.45);font-size:10px">hasta</span>
            <input id="ven-range-to" type="date" value="${_venEsc(_venRange.to)}"/>
            <button onclick="_venApplyPeriod()">Actualizar</button>
          </div>
          <div class="ven-sync"><i></i> Datos sincronizados con Ventas, Gastos y Contabilidad</div>
        </div>
      </section>
      <nav class="ven-nav">${tabs.map(([k,i,l,c])=>`<button class="ven-nav-btn ${_venTab===k?'on':''}" onclick="_venSetTab('${k}')">${svg(i)}<span>${l}</span>${c!==''?`<span class="ven-nav-count">${c}</span>`:''}</button>`).join('')}</nav>
      <div id="ven-content"></div>
    </div>
  `;
  const content=document.getElementById('ven-content');
  if(_venTab==='resumen')_venRenderSummary(content);
  if(_venTab==='vendedores')_venRenderSellers(content);
  if(_venTab==='externas')_venRenderExternal(content);
  if(_venTab==='viaticos')_venRenderExpenses(content);
  if(_venTab==='agenda')_venRenderCalendar(content);
  if(_venTab==='mapa')_venRenderMap(content);
}

function _venRenderSummary(el) {
  const d=_venState.dashboard||{rows:[],activeCount:0,salesTotal:0,commissionTotal:0,expenseTotal:0};
  const rows=d.rows||[];
  const activeStreet=_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante').length;
  const drafts=_venState.commissions.filter(x=>x.status==='borrador');
  const approved=_venState.commissions.filter(x=>x.status==='aprobado');
  const maxSales=Math.max(1,...rows.map(r=>Number(r.sales)||0));
  const expenseRatio=Number(d.salesTotal)>0?(Number(d.expenseTotal)/Number(d.salesTotal))*100:0;
  const canManageFinance=['admin','superadmin'].includes(user?.role);
  const metric=(icon,color,chip,label,value,note)=>`<article class="ven-metric">
    <div class="ven-metric-top"><div class="ven-metric-icon ${color}">${svg(icon)}</div><span class="ven-metric-chip">${chip}</span></div>
    <div class="ven-metric-label">${label}</div><div class="ven-metric-value">${value}</div><div class="ven-metric-note">${note}</div></article>`;
  const marginTotal=rows.reduce((sum,row)=>sum+Number(row.margin||0),0);
  const table=rows.length?`<div class="tw"><table><thead><tr><th>Vendedor</th><th>Perfil</th><th style="text-align:center">Operaciones</th><th>Desempeño</th><th style="text-align:right">Margen</th><th style="text-align:right">Gastos</th></tr></thead><tbody>
    ${rows.map(r=>{const seller=_venState.sellers.find(s=>Number(s.id)===Number(r.id))||{};const goalPct=_venGoalPercent(seller,r.sales);return `<tr class="ven-click-row" onclick="vendedoresOpenProfile(${r.id})"><td><div class="ven-person"><div class="ven-avatar ${r.type==='ambulante'?'street':''}">${_venInitials(r.name)}</div><div><div class="ven-person-name">${_venEsc(r.name)}</div><div class="ven-person-meta">${Number(seller.sales_goal||0)>0?`${goalPct.toFixed(0)}% de la meta`:`Venta neta ${_venMoney(r.sales)}`}</div></div></div></td>
      <td>${r.type==='ambulante'?'<span class="badge a">Ambulante</span>':'<span class="badge b">Fijo</span>'}</td><td style="text-align:center"><strong>${r.salesCount}</strong></td>
      <td><strong class="ven-money">${_venMoney(r.sales)}</strong><div class="ven-progress"><span style="width:${Math.max(4,Number(seller.sales_goal||0)>0?Math.min(100,goalPct):(Number(r.sales)||0)/maxSales*100)}%"></span></div></td>
      <td style="text-align:right" class="ven-money">${_venMoney(r.margin)}</td><td style="text-align:right" class="ven-money">${_venMoney(r.expenses)}</td></tr>`}).join('')}
    </tbody></table></div>`:_venEmpty('users','Aún no hay rendimiento para mostrar','Registra tu primer vendedor y asígnalo a una venta para comenzar.','Crear primer vendedor','vendedoresOpenSeller()');
  el.innerHTML=`<div class="ven-metrics">
    ${metric('users','green','Equipo','Vendedores activos',d.activeCount||0,`<strong>${activeStreet}</strong> ambulantes · <strong>${Math.max(0,(d.activeCount||0)-activeStreet)}</strong> fijos`)}
    ${metric('trend','blue','Período','Ventas asignadas',_venMoney(d.salesTotal),`<strong>${rows.reduce((s,r)=>s+(Number(r.salesCount)||0),0)}</strong> operaciones netas`)}
    ${metric('dollar','purple','Rentabilidad','Margen comercial',_venMoney(marginTotal),`Antes de viáticos y compensaciones`)}
    ${metric('cash','amber','Operación','Viáticos y gastos',_venMoney(d.expenseTotal),`<strong>${expenseRatio.toFixed(1)}%</strong> de las ventas asignadas`)}
  </div>
  <div class="ven-grid">
    <section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('chart')} Rendimiento del equipo</div><div class="ven-panel-sub">Ventas netas después de devoluciones · ${_venEsc(d.from||'')} al ${_venEsc(d.to||'')}</div></div><span class="badge g">${rows.length} vendedor${rows.length===1?'':'es'}</span></div>${table}</section>
    <aside class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('alert')} Pendientes y próximos pasos</div><div class="ven-panel-sub">Acciones que requieren atención</div></div></div><div class="ven-panel-body"><div class="ven-insights">
      ${canManageFinance?`<div class="ven-insight"><div class="ven-insight-icon">${svg('trend')}</div><div><strong>Comisiones en módulo independiente</strong><span>${drafts.length} por revisar y ${approved.length} aprobadas para Nómina.</span></div></div>
      <div class="ven-insight"><div class="ven-insight-icon">${svg('calendar')}</div><div><strong>Nómina separada del área comercial</strong><span>Salarios, bonos, deducciones y pagos se gestionan allí.</span></div></div>`:`<div class="ven-insight"><div class="ven-insight-icon">${svg('users')}</div><div><strong>Operación comercial</strong><span>Consulta perfiles, ventas, rutas y viáticos autorizados.</span></div></div>
      <div class="ven-insight"><div class="ven-insight-icon">${svg('lock')}</div><div><strong>Información financiera protegida</strong><span>Comisiones, salarios y pagos están reservados a administración.</span></div></div>`}
      <div class="ven-insight"><div class="ven-insight-icon">${svg('receipt')}</div><div><strong>${_venState.external.length} recibos externos</strong><span>Registrados dentro del período seleccionado.</span></div></div>
    </div><div class="ven-quick">${canManageFinance?`<button onclick="routeTo('comisiones')">Abrir Comisiones</button><button onclick="routeTo('nomina')">Abrir Nómina</button>`:''}<button onclick="vendedoresOpenExpense()">Registrar viático</button><button onclick="_venSetTab('vendedores')">Ver equipo</button></div></div></aside>
  </div>`;
}

function _venRenderSellers(el) {
  const all=_venState.sellers;
  const sellers=all.filter(s=>{
    const filterOk=_venListFilter==='todos'||_venListFilter===s.seller_type||_venListFilter===s.status;
    return filterOk&&_venMatches(s.code,s.name,s.phone,s.document,s.zone,s.route);
  });
  const filter=`<select class="ven-filter" onchange="_venSetListFilter(this.value)"><option value="todos">Todos los perfiles</option><option value="fijo" ${_venListFilter==='fijo'?'selected':''}>Fijos</option><option value="ambulante" ${_venListFilter==='ambulante'?'selected':''}>Ambulantes</option><option value="activo" ${_venListFilter==='activo'?'selected':''}>Activos</option><option value="inactivo" ${_venListFilter==='inactivo'?'selected':''}>Inactivos</option></select>`;
  const cards=sellers.length?sellers.map(s=>`<article class="ven-seller-card ${s.status!=='activo'?'inactive':''}">
    <div class="ven-seller-head"><div class="ven-seller-id"><div class="ven-avatar ${s.seller_type==='ambulante'?'street':''}">${_venInitials(s.name)}</div><div style="min-width:0"><h3>${_venEsc(s.name)}</h3><p>${_venEsc(s.code)} · ${s.seller_type==='ambulante'?'AMBULANTE':'FIJO'}</p></div></div>${_venBadge(s.status)}</div>
    <div class="ven-seller-data"><div><label>Operación</label><strong>${s.seller_type==='ambulante'?'Venta externa':'Punto de venta'}</strong></div><div><label>Ventas registradas</label><strong>${Number(s.internal_sales_count||0)+Number(s.external_sales_count||0)}</strong></div><div><label>Zona / Ruta</label><strong>${_venEsc([s.zone,s.route].filter(Boolean).join(' · ')||'Sin asignar')}</strong></div><div><label>Meta comercial</label><strong>${Number(s.sales_goal||0)>0?_venMoney(s.sales_goal):'Sin meta'}</strong></div></div>
    <div class="ven-seller-foot"><div class="ven-seller-contact">${svg('phone')} ${_venEsc(s.phone||s.document||'Sin contacto')}</div><div class="flex"><button class="btn btn-out btn-sm" onclick="vendedoresOpenProfile(${s.id})">${svg('eye')} Perfil</button><button class="btn btn-out btn-sm" onclick="vendedoresOpenSeller(${s.id})">${svg('edit')} Editar</button><button class="btn btn-ghost btn-sm" title="${s.status==='activo'?'Desactivar':'Activar'}" onclick="vendedoresToggle(${s.id},${s.status!=='activo'})">${s.status==='activo'?svg('lock'):svg('unlock')}</button></div></div>
  </article>`).join(''):_venEmpty('users',all.length?'No encontramos coincidencias':'Construye tu equipo comercial',all.length?'Cambia la búsqueda o el filtro seleccionado.':'Registra vendedores fijos o ambulantes. Los ambulantes no necesitan acceso al POS.','Nuevo vendedor','vendedoresOpenSeller()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('users')} Directorio comercial</div><div class="ven-panel-sub">Perfiles, contacto, tipo de operación, rutas y cobertura del equipo</div></div><span class="badge g">${all.filter(s=>s.status==='activo').length} activos</span></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Fijos <strong>${all.filter(s=>s.seller_type==='fijo').length}</strong></span><span class="ven-summary-item">Ambulantes <strong>${all.filter(s=>s.seller_type==='ambulante').length}</strong></span><span class="ven-summary-item">Sin usuario POS <strong>${all.filter(s=>!s.linked_user_id).length}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar por nombre, código, zona o teléfono…',filters:filter,action:`<button class="btn btn-green btn-sm" onclick="vendedoresOpenSeller()">${svg('plus')} Agregar</button>`})}<div class="ven-seller-grid" style="margin-top:14px">${cards}</div></div></section>`;
}

function _venRenderExternal(el) {
  const all=_venState.external;
  const rows=all.filter(x=>(_venListFilter==='todos'||x.payment_method===_venListFilter)&&_venMatches(x.salesperson_name,x.customer_name,x.receipt_number,x.payment_method));
  const total=all.reduce((s,x)=>s+Number(x.net_amount||0),0),collected=all.reduce((s,x)=>s+Number(x.collected_amount||0),0);
  const methods=[...new Set(all.map(x=>x.payment_method).filter(Boolean))];
  const filter=`<select class="ven-filter" onchange="_venSetListFilter(this.value)"><option value="todos">Todos los métodos</option>${methods.map(x=>`<option value="${_venEsc(x)}" ${_venListFilter===x?'selected':''}>${_venEsc(x)}</option>`).join('')}</select>`;
  const body=rows.length?`<div class="tw"><table><thead><tr><th>Fecha</th><th>Vendedor</th><th>Comprobante externo</th><th>Cliente</th><th>Productos</th><th>Método</th><th style="text-align:right">Venta neta</th><th style="text-align:right">Cobrado</th><th>Estado</th><th></th></tr></thead><tbody>
    ${rows.map(x=>`<tr><td>${_venEsc(x.sale_date)}</td><td><div class="ven-person"><div class="ven-avatar street">${_venInitials(x.salesperson_name)}</div><div><div class="ven-person-name">${_venEsc(x.salesperson_name)}</div><div class="ven-person-meta">Venta fuera del POS</div></div></div></td><td><strong class="ven-money">${_venEsc(x.receipt_number)}</strong></td><td>${_venEsc(x.customer_name)}</td><td><span class="badge b">${Number(x.item_count||0)} producto${Number(x.item_count||0)===1?'':'s'}</span></td><td><span class="badge n">${_venEsc(x.payment_method)}</span></td><td style="text-align:right;font-weight:750" class="ven-money">${_venMoney(x.net_amount)}</td><td style="text-align:right" class="ven-money">${_venMoney(x.collected_amount)}</td><td>${_venBadge(x.status)}</td><td><div class="flex"><button class="btn btn-out btn-sm" onclick="vendedoresViewExternal(${x.id})">${svg('eye')} Ver</button>${x.status==='registrada'?`<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="vendedoresCancelExternal(${x.id})">Anular</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:_venEmpty('receipt',all.length?'No encontramos ventas':'Sin ventas externas registradas',all.length?'Prueba con otro método o término de búsqueda.':'Transcribe los productos vendidos fuera del POS para calcular automáticamente la comisión.','Registrar venta externa','vendedoresOpenExternalSale()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('receipt')} Registro de ventas externas</div><div class="ven-panel-sub">Transcripción administrativa de comprobantes físicos; no crea factura fiscal ni mueve inventario</div></div><button class="btn btn-green btn-sm" onclick="vendedoresOpenExternalSale()">${svg('plus')} Registrar venta</button></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Ventas <strong>${all.length}</strong></span><span class="ven-summary-item">Venta neta <strong>${_venMoney(total)}</strong></span><span class="ven-summary-item">Cobrado <strong>${_venMoney(collected)}</strong></span><span class="ven-summary-item">Pendiente <strong>${_venMoney(Math.max(0,total-collected))}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar vendedor, cliente o comprobante…',filters:filter})}</div>${body}</section>`;
}

function _venRenderExpenses(el) {
  const all=_venState.expenses;
  const rows=all.filter(x=>(_venListFilter==='todos'||x.expense_kind===_venListFilter)&&_venMatches(x.salesperson_name,x.expense_kind,x.description,x.payment_source,x.status));
  const total=all.reduce((s,x)=>s+Number(x.total||0),0),paid=all.reduce((s,x)=>s+Number(x.paid_amount||0),0);
  const kinds=[...new Set(all.map(x=>x.expense_kind).filter(Boolean))];
  const filter=`<select class="ven-filter" onchange="_venSetListFilter(this.value)"><option value="todos">Todos los conceptos</option>${kinds.map(x=>`<option value="${_venEsc(x)}" ${_venListFilter===x?'selected':''}>${_venEsc(x)}</option>`).join('')}</select>`;
  const body=rows.length?`<div class="tw"><table><thead><tr><th>Fecha</th><th>Vendedor</th><th>Concepto</th><th>Descripción</th><th style="text-align:right">Total</th><th style="text-align:right">Pagado</th><th>Estado</th><th>Origen</th></tr></thead><tbody>
    ${rows.map(x=>`<tr><td>${_venEsc(x.issue_date)}</td><td><div class="ven-person"><div class="ven-avatar">${_venInitials(x.salesperson_name)}</div><div class="ven-person-name">${_venEsc(x.salesperson_name)}</div></div></td><td><span class="badge a">${_venEsc(x.expense_kind)}</span></td><td>${_venEsc(x.description)}</td><td style="text-align:right;font-weight:750" class="ven-money">${_venMoney(x.total)}</td><td style="text-align:right" class="ven-money">${_venMoney(x.paid_amount)}</td><td>${_venBadge(x.status)}</td><td>${_venEsc(String(x.payment_source||'').replaceAll('_',' '))}</td></tr>`).join('')}</tbody></table></div>`:_venEmpty('cash',all.length?'No hay gastos con ese filtro':'El equipo no tiene viáticos registrados','Cada gasto creado aquí aparecerá también en Gastos, Resultados y Contabilidad.','Registrar gasto','vendedoresOpenExpense()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('cash')} Viáticos y gastos comerciales</div><div class="ven-panel-sub">Desembolsos vinculados al vendedor y al gasto real del negocio</div></div><button class="btn btn-green btn-sm" onclick="vendedoresOpenExpense()">${svg('plus')} Registrar gasto</button></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Movimientos <strong>${all.length}</strong></span><span class="ven-summary-item">Total devengado <strong>${_venMoney(total)}</strong></span><span class="ven-summary-item">Pagado <strong>${_venMoney(paid)}</strong></span><span class="ven-summary-item">Por pagar <strong>${_venMoney(Math.max(0,total-paid))}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar vendedor, concepto o descripción…',filters:filter})}</div>${body}</section>`;
}

function _venCalendarEvents() {
  const events=[];
  _venState.expenses.filter(x=>!['anulado','rechazado'].includes(x.status)).forEach(x=>events.push({date:x.issue_date,type:'gasto',tone:'amber',title:`${x.expense_kind} · ${x.salesperson_name}`,detail:_venMoney(x.total),tab:'viaticos'}));
  _venState.external.filter(x=>x.status==='registrada').forEach(x=>events.push({date:x.sale_date,type:'venta_externa',tone:'green',title:`Venta externa · ${x.salesperson_name}`,detail:_venMoney(x.net_amount),tab:'externas'}));
  return events.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x.date||'')));
}

function _venCalendarMove(offset) {
  const base=new Date(`${_venCalendarDate||_venToday()}T12:00:00`);base.setMonth(base.getMonth()+Number(offset||0),1);
  _venCalendarDate=`${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,'0')}-01`;
  _venRenderCalendar(document.getElementById('ven-content'));
}

function _venRenderCalendar(el) {
  if(!_venCalendarDate)_venCalendarDate=(_venRange.to||_venToday()).slice(0,7)+'-01';
  const base=new Date(`${_venCalendarDate}T12:00:00`),year=base.getFullYear(),month=base.getMonth();
  const firstOffset=(new Date(year,month,1).getDay()+6)%7,days=new Date(year,month+1,0).getDate();
  const monthKey=`${year}-${String(month+1).padStart(2,'0')}`,events=_venCalendarEvents().filter(x=>x.date.startsWith(monthKey));
  const cells=[];for(let i=0;i<firstOffset;i++)cells.push('<div class="ven-calendar-day muted"></div>');
  for(let day=1;day<=days;day++){
    const date=`${monthKey}-${String(day).padStart(2,'0')}`,dayEvents=events.filter(x=>x.date===date),isToday=date===_venToday();
    cells.push(`<div class="ven-calendar-day ${isToday?'today':''}"><div class="ven-calendar-number"><span>${day}</span>${dayEvents.length?`<b>${dayEvents.length}</b>`:''}</div><div class="ven-calendar-events">${dayEvents.slice(0,3).map(x=>`<button class="ven-calendar-event ${x.tone}" onclick="_venSetTab('${x.tab}')"><i></i><span>${_venEsc(x.title)}</span><small>${_venEsc(x.detail)}</small></button>`).join('')}${dayEvents.length>3?`<em>+${dayEvents.length-3} más</em>`:''}</div></div>`);
  }
  const totals={gasto:events.filter(x=>x.type==='gasto').length,externa:events.filter(x=>x.type==='venta_externa').length};
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('calendar')} Agenda comercial</div><div class="ven-panel-sub">Viáticos y actividad externa del equipo en un solo calendario</div></div><div class="ven-calendar-nav"><button onclick="_venCalendarMove(-1)">‹</button><strong>${base.toLocaleDateString('es-DO',{month:'long',year:'numeric'})}</strong><button onclick="_venCalendarMove(1)">›</button></div></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Gastos <strong>${totals.gasto}</strong></span><span class="ven-summary-item">Ventas externas <strong>${totals.externa}</strong></span><button class="btn btn-out btn-sm" onclick="routeTo('comisiones')">Ver liquidaciones de comisión →</button></div>
    <div class="ven-panel-body"><div class="ven-calendar-week">${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(x=>`<span>${x}</span>`).join('')}</div><div class="ven-calendar-grid">${cells.join('')}</div></div></section>`;
}

function _venRenderMap(el) {
  const sellers=_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante');
  if(!sellers.length){el.innerHTML=`<section class="ven-panel">${_venEmpty('map-pin','Aún no hay cobertura ambulante','Registra un vendedor ambulante y asigna su zona y ruta para construir la cobertura.','Crear ambulante','vendedoresOpenSeller()')}</section>`;return;}
  const configured=sellers.filter(s=>Number.isFinite(Number(s.map_lat))&&Number.isFinite(Number(s.map_lng)));
  const list=sellers.map(s=>{const perf=_venSellerPerformance(s.id),pct=_venGoalPercent(s,perf.sales),located=configured.some(x=>Number(x.id)===Number(s.id));return `<article class="ven-map-seller ${located?'located':'pending'}" data-coverage-seller="${s.id}"><button class="ven-map-seller-main" onclick="${located?`_venFocusCoverage(${s.id})`:`vendedoresOpenSeller(${s.id})`}"><span class="ven-avatar street">${_venInitials(s.name)}</span><div><strong>${_venEsc(s.name)}</strong><small>${_venEsc([s.zone,s.route].filter(Boolean).join(' · ')||'Sin ruta asignada')}</small><em>${located?`Punto actualizado ${_venEsc(_venRelativeTime(s.location_updated_at))}`:'Ubicación pendiente'}</em><div class="ven-progress"><i style="width:${Math.min(100,pct)}%"></i></div></div><b>${Number(s.sales_goal||0)>0?pct.toFixed(0)+'%':_venMoney(perf.sales)}</b></button><div class="ven-map-seller-actions"><button onclick="_venLocateSeller(${s.id})">${svg('map-pin')} ${located?'Actualizar':'Ubicar'}</button>${located?`<button onclick="_venOpenNavigation(${s.id},'google')">Google Maps</button><button onclick="_venOpenNavigation(${s.id},'waze')">Waze</button>`:''}</div></article>`}).join('');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('map-pin')} Cobertura geográfica real</div><div class="ven-panel-sub">Mapa OpenStreetMap con puntos base de zonas y rutas; no representa rastreo GPS del teléfono</div></div><div class="ven-map-head-badges"><span class="badge g">${configured.length} ubicada${configured.length===1?'':'s'}</span><span class="badge ${configured.length===sellers.length?'b':'a'}">${sellers.length-configured.length} pendiente${sellers.length-configured.length===1?'':'s'}</span></div></div><div class="ven-map-layout"><div class="ven-map-canvas"><div id="ven-coverage-map" class="ven-real-map"></div><div class="ven-map-loading" id="ven-map-loading">${svg('map-pin')} Preparando mapa de cobertura…</div><div class="ven-map-legend"><span><i class="exact"></i> Punto de cobertura guardado</span><span><i class="business"></i> Negocio</span></div></div><aside class="ven-map-list"><header><strong>Equipo ambulante</strong><small>Actualización administrativa inmediata</small></header>${list}</aside></div></section>`;
  requestAnimationFrame(()=>_venInitCoverageMap(configured));
}

function _venRelativeTime(value){
  if(!value)return 'recientemente';const d=new Date(String(value).replace(' ','T')),ms=Date.now()-d.getTime();if(!Number.isFinite(ms))return String(value);
  const min=Math.max(0,Math.round(ms/60000));if(min<2)return 'ahora';if(min<60)return `hace ${min} min`;const h=Math.round(min/60);if(h<24)return `hace ${h} h`;return new Intl.DateTimeFormat('es-DO',{day:'2-digit',month:'short'}).format(d);
}

async function _venInitCoverageMap(sellers){
  const node=document.getElementById('ven-coverage-map');if(!node||!window.L)return;
  if(_venCoverageMap){try{_venCoverageMap.remove();}catch{} _venCoverageMap=null;}
  _venCoverageMarkers=new Map();
  const origin=await window.api.deliveries.getOrigin();if(!document.getElementById('ven-coverage-map'))return;
  const center=[Number(origin?.lat)||18.7357,Number(origin?.lng)||-70.1627];
  const map=L.map(node,{zoomControl:true,attributionControl:true}).setView(center,8);_venCoverageMap=map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
  const businessIcon=L.divIcon({className:'ven-leaflet-wrap',html:`<span class="ven-leaflet-marker business">${svg('store')}</span>`,iconSize:[40,40],iconAnchor:[20,20]});
  const originMarker=L.marker(center,{icon:businessIcon}).addTo(map).bindPopup(`<strong>${_venEsc(origin?.label||CFG.biz||'Negocio')}</strong><br><small>Punto de origen configurado</small>`);
  const bounds=L.latLngBounds([originMarker.getLatLng()]);
  sellers.forEach(s=>{const point=[Number(s.map_lat),Number(s.map_lng)],icon=L.divIcon({className:'ven-leaflet-wrap',html:`<span class="ven-leaflet-marker seller">${_venInitials(s.name)}</span>`,iconSize:[38,38],iconAnchor:[19,19]});const marker=L.marker(point,{icon}).addTo(map).bindPopup(`<strong>${_venEsc(s.name)}</strong><br><span>${_venEsc(s.coverage_address||s.zone||'Punto de cobertura')}</span><br><button class="ven-popup-link" onclick="vendedoresOpenProfile(${s.id})">Ver perfil comercial</button>`);_venCoverageMarkers.set(Number(s.id),marker);bounds.extend(point);});
  if(sellers.length)map.fitBounds(bounds.pad(.18),{maxZoom:14});
  document.getElementById('ven-map-loading')?.remove();setTimeout(()=>map.invalidateSize(),80);
}

function _venFocusCoverage(id){const marker=_venCoverageMarkers.get(Number(id));if(marker&&_venCoverageMap){_venCoverageMap.setView(marker.getLatLng(),15,{animate:true});marker.openPopup();}document.querySelector(`[data-coverage-seller="${Number(id)}"]`)?.scrollIntoView({block:'nearest'});}

async function _venLocateSeller(id){
  const seller=_venState.sellers.find(x=>Number(x.id)===Number(id));if(!seller)return;
  const address=seller.coverage_address||[seller.zone,seller.route].filter(Boolean).join(', ');
  if(!address){toast('Edita el vendedor e indica una dirección o zona de cobertura','w');vendedoresOpenSeller(id);return;}
  toast('Buscando el punto en el mapa…');const geo=await window.api.deliveries.geocode({address});
  if(!geo?.ok){toast(geo?.error||'No se encontró la ubicación','err');return;}
  const saved=await window.api.salespeople.updateLocation({id,data:{lat:geo.lat,lng:geo.lng,coverage_address:geo.display_name||address},requestUserId:user.id});
  if(!saved?.ok){toast(saved?.error||'No se pudo guardar la ubicación','err');return;}
  const index=_venState.sellers.findIndex(x=>Number(x.id)===Number(id));if(index>=0)_venState.sellers[index]=saved.data;
  toast('✓ Punto de cobertura actualizado');_venRenderMap(document.getElementById('ven-content'));
}

async function _venOpenNavigation(id,provider='google'){
  const seller=_venState.sellers.find(x=>Number(x.id)===Number(id));if(!seller||seller.map_lat==null||seller.map_lng==null)return;
  const point=encodeURIComponent(`${seller.map_lat},${seller.map_lng}`),url=provider==='waze'?`https://www.waze.com/ul?ll=${point}&navigate=yes`:`https://www.google.com/maps/dir/?api=1&destination=${point}`;
  const result=await window.api.shell.openExternal(url);if(!result?.ok)toast(result?.error||'No se pudo abrir la navegación','err');
}

function vendedoresOpenProfile(id) {
  const seller=_venState.sellers.find(x=>Number(x.id)===Number(id));if(!seller)return;
  const perf=_venSellerPerformance(id),goal=Number(seller.sales_goal||0),pct=_venGoalPercent(seller,perf.sales);
  const canManageFinance=['admin','superadmin'].includes(user?.role);
  const profitability=Number(perf.margin||0)-Number(perf.commission||0)-Number(perf.expenses||0);
  const operatingContribution=Number(perf.margin||0)-Number(perf.expenses||0);
  const external=_venState.external.filter(x=>Number(x.salesperson_id)===Number(id)&&x.status==='registrada');
  const byDay={};external.forEach(x=>{byDay[x.sale_date]=(byDay[x.sale_date]||0)+Number(x.net_amount||0)});
  const activity=[
    ...external.map(x=>({date:x.sale_date,icon:'receipt',tone:'green',title:`Venta externa ${x.receipt_number}`,detail:`${x.customer_name} · ${_venMoney(x.net_amount)}`})),
    ..._venState.expenses.filter(x=>Number(x.salesperson_id)===Number(id)).map(x=>({date:x.issue_date,icon:'cash',tone:'amber',title:`${x.expense_kind}: ${x.description}`,detail:_venMoney(x.total)})),
    ...(canManageFinance?_venState.commissions.filter(x=>Number(x.salesperson_id)===Number(id)&&x.status!=='anulado').map(x=>({date:x.date_to,icon:'trend',tone:'purple',title:`Comisión ${x.status}`,detail:_venMoney(x.commission_total)})):[]),
  ].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8);
  const body=window.VeloExperience?.openDrawer?.({id:'seller-profile',title:'Perfil comercial',subtitle:'Rendimiento, meta, rentabilidad y actividad',width:'650px',content:`<section class="ven-profile-hero"><div class="ven-profile-avatar ${seller.seller_type==='ambulante'?'street':''}">${_venInitials(seller.name)}</div><div><small>${_venEsc(seller.code)} · ${seller.seller_type==='ambulante'?'AMBULANTE':'FIJO'}</small><h2>${_venEsc(seller.name)}</h2><p>${_venEsc([seller.zone,seller.route].filter(Boolean).join(' · ')||'Sin zona o ruta asignada')}</p></div><button data-profile-edit>${svg('edit')} Editar</button></section>
    <div class="ven-profile-score"><div class="ven-profile-ring" style="--score:${Math.min(100,pct)}"><span>${goal>0?pct.toFixed(0)+'%':'—'}</span></div><div><small>META DEL PERÍODO</small><strong>${goal>0?`${_venMoney(perf.sales)} de ${_venMoney(goal)}`:'Configura una meta comercial'}</strong><p>${goal>0?(pct>=100?'Meta alcanzada. Excelente desempeño.':`Faltan ${_venMoney(Math.max(0,goal-perf.sales))} para completarla.`):'La meta permite comparar avance y proyectar el cierre.'}</p></div></div>
    <div class="ven-profile-metrics"><div><small>VENTAS</small><strong>${_venMoney(perf.sales)}</strong><span>${perf.salesCount||0} operaciones</span></div><div><small>MARGEN</small><strong>${_venMoney(perf.margin)}</strong><span>${Number(perf.sales)>0?((Number(perf.margin)/Number(perf.sales))*100).toFixed(1):'0.0'}% de venta</span></div>${canManageFinance?`<div><small>COMISIÓN</small><strong>${_venMoney(perf.commission)}</strong><span>Consulta vinculada a Comisiones</span></div><div><small>RENTABILIDAD</small><strong class="${profitability<0?'risk':''}">${_venMoney(profitability)}</strong><span>margen − comisión − gastos</span></div>`:`<div><small>VIÁTICOS</small><strong>${_venMoney(perf.expenses)}</strong><span>Gastos operativos vinculados</span></div><div><small>APORTE OPERATIVO</small><strong class="${operatingContribution<0?'risk':''}">${_venMoney(operatingContribution)}</strong><span>margen − gastos</span></div>`}</div>
    <div class="ven-profile-grid"><section><header><div><small>TENDENCIA AMBULANTE</small><strong>Ventas externas por día</strong></div><span>${external.length} venta${external.length===1?'':'s'}</span></header>${_venMiniLine(Object.keys(byDay).sort().map(k=>byDay[k]))}</section><section><header><div><small>OPERACIÓN</small><strong>Zona y contacto</strong></div></header><dl class="ven-profile-data"><div><dt>Teléfono</dt><dd>${_venEsc(seller.phone||'Sin registrar')}</dd></div><div><dt>Ventas externas</dt><dd>${external.length} registrada${external.length===1?'':'s'}</dd></div><div><dt>Cobertura</dt><dd>${_venEsc([seller.zone,seller.route].filter(Boolean).join(' · ')||'Sin asignar')}</dd></div></dl></section></div>
    <section class="ven-profile-timeline"><header><div><small>LÍNEA DE TIEMPO</small><strong>Actividad documental reciente</strong></div><button data-profile-expense>+ Gasto</button></header>${activity.length?activity.map(x=>`<article class="${x.tone}"><span>${svg(x.icon)}</span><div><small>${_venEsc(x.date)}</small><strong>${_venEsc(x.title)}</strong><p>${_venEsc(x.detail)}</p></div></article>`).join(''):'<div class="ven-profile-nochart">Todavía no hay documentos vinculados en el período.</div>'}</section>`});
  body?.querySelector('[data-profile-edit]')?.addEventListener('click',()=>{window.VeloExperience.closeDrawer();setTimeout(()=>vendedoresOpenSeller(id),180)});
  body?.querySelector('[data-profile-expense]')?.addEventListener('click',()=>{window.VeloExperience.closeDrawer();setTimeout(()=>vendedoresOpenExpense(id),180)});
}

function vendedoresOpenSeller(id=null) {
  const s=_venState.sellers.find(x=>Number(x.id)===Number(id))||{};
  const users=window._cachedUsers||[];
  openModal(`<div class="modal-title">${id?'Editar perfil comercial':'Crear vendedor'}</div>
    <div class="modal-sub">Datos comerciales esenciales. El salario y los pagos se configuran desde el módulo Nómina.</div>
    <input type="hidden" id="ven-code" value="${_venEsc(s.code||'')}"/><input type="hidden" id="ven-lat" value="${s.map_lat??''}"/><input type="hidden" id="ven-lng" value="${s.map_lng??''}"/><input type="hidden" id="ven-salary" value="${s.salary_amount||0}"/><input type="hidden" id="ven-pfreq" value="${_venEsc(s.payroll_frequency||'mensual')}"/><input type="hidden" id="ven-cmode" value="${_venEsc(s.commission_mode||'none')}"/><input type="hidden" id="ven-rate" value="${Number(s.commission_rate||0)}"/><input type="hidden" id="ven-fixed" value="${Number(s.commission_fixed||0)}"/><input type="hidden" id="ven-cfreq" value="${_venEsc(s.commission_frequency||'mensual')}"/>
    <div class="ven-modal-section"><div class="ven-modal-section-title"><span>1</span> Identidad básica</div>
      <div class="g2"><div class="fg"><label class="lbl">Nombre completo *</label><input class="inp" id="ven-name" value="${_venEsc(s.name||'')}" placeholder="Nombre del vendedor"/></div><div class="fg"><label class="lbl">Tipo de vendedor *</label><select class="inp" id="ven-type" onchange="vendedoresSellerTypeChanged()"><option value="fijo" ${s.seller_type!=='ambulante'?'selected':''}>Fijo / interno</option><option value="ambulante" ${s.seller_type==='ambulante'?'selected':''}>Ambulante / externo</option></select></div></div>
      <div class="g2"><div class="fg"><label class="lbl">Teléfono</label><input class="inp" id="ven-phone" value="${_venEsc(s.phone||'')}" placeholder="Contacto principal"/></div><div class="fg"><label class="lbl">Documento</label><input class="inp" id="ven-doc" value="${_venEsc(s.document||'')}" placeholder="Cédula o identificación"/></div></div>
      <details class="ven-optional"><summary>Información adicional opcional</summary><div class="g2"><div class="fg"><label class="lbl">Correo</label><input class="inp" id="ven-email" type="email" value="${_venEsc(s.email||'')}"/></div><div class="fg"><label class="lbl">Dirección</label><input class="inp" id="ven-address" value="${_venEsc(s.address||'')}"/></div></div><div class="fg"><label class="lbl">Notas internas</label><textarea class="inp" id="ven-notes" rows="2">${_venEsc(s.notes||'')}</textarea></div></details>
    </div>
    <div class="ven-modal-section"><div class="ven-modal-section-title"><span>2</span> Operación comercial</div>
      <div data-seller-fixed><div class="fg"><label class="lbl">Usuario POS vinculado</label><select class="inp" id="ven-user"><option value="">Sin usuario — asignación administrativa</option>${users.filter(u=>u.active!==0).map(u=>`<option value="${u.id}" ${Number(s.linked_user_id)===Number(u.id)?'selected':''}>${_venEsc(u.name)}</option>`).join('')}</select><small class="ven-field-help">Sus ventas del POS se asignarán automáticamente.</small></div></div>
      <div data-seller-street><div class="g2"><div class="fg"><label class="lbl">Zona</label><input class="inp" id="ven-zone" value="${_venEsc(s.zone||'')}" placeholder="Ej. Santo Domingo Norte"/></div><div class="fg"><label class="lbl">Ruta o cartera</label><input class="inp" id="ven-route" value="${_venEsc(s.route||'')}" placeholder="Ruta comercial"/></div></div><div class="fg"><label class="lbl">Punto base de cobertura</label><div class="ven-location-input"><input class="inp" id="ven-coverage-address" value="${_venEsc(s.coverage_address||'')}" placeholder="Dirección, sector o avenida para ubicar en el mapa"/><button class="btn btn-out" type="button" onclick="vendedoresGeocodeSellerForm()">${svg('map-pin')} Buscar en mapa</button></div><small class="ven-field-help" id="ven-location-status">${s.map_lat!=null&&s.map_lng!=null?`Ubicación guardada · ${_venEsc(_venRelativeTime(s.location_updated_at))}`:'Todavía no se ha guardado una ubicación geográfica.'}</small></div><div class="ven-callout">El mapa usa este punto para representar la cobertura. Se actualiza inmediatamente al guardar; no rastrea el teléfono del vendedor.</div></div>
      <div class="g2"><div class="fg"><label class="lbl">Meta de ventas del período</label><input class="inp" id="ven-goal" type="number" min="0" step="0.01" value="${s.sales_goal||0}" placeholder="0.00"/></div><div class="fg"><label class="lbl">Fecha de ingreso</label><input class="inp" id="ven-hire" type="date" value="${_venEsc(s.hire_date||_venToday())}"/></div></div>
    </div>
    <div class="ven-callout">Las reglas y liquidaciones se configuran en el módulo independiente <strong>Comisiones</strong>. El salario y los pagos se administran en <strong>Nómina</strong>.</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresSaveSeller(${id||'null'})">${svg('check')} Guardar vendedor</button></div>`, 'modal-lg');
  vendedoresSellerTypeChanged();
}

function vendedoresSellerTypeChanged(){const street=document.getElementById('ven-type')?.value==='ambulante';document.querySelectorAll('[data-seller-fixed]').forEach(x=>x.hidden=street);document.querySelectorAll('[data-seller-street]').forEach(x=>x.hidden=!street);}
async function vendedoresGeocodeSellerForm(){
  const input=document.getElementById('ven-coverage-address'),status=document.getElementById('ven-location-status');
  const address=input?.value.trim()||document.getElementById('ven-zone')?.value.trim();if(!address){toast('Escribe una dirección o una zona','w');return;}
  if(status)status.textContent='Buscando ubicación…';const result=await window.api.deliveries.geocode({address});
  if(!result?.ok){if(status)status.textContent=result?.error||'No se encontró el punto';toast(result?.error||'No se encontró la ubicación','err');return;}
  document.getElementById('ven-lat').value=result.lat;document.getElementById('ven-lng').value=result.lng;if(input)input.value=result.display_name||address;
  if(status)status.textContent=`Punto encontrado · ${Number(result.lat).toFixed(5)}, ${Number(result.lng).toFixed(5)}`;toast('✓ Ubicación lista para guardar');
}

async function vendedoresSaveSeller(id) {
  const type=document.getElementById('ven-type').value,mode=document.getElementById('ven-cmode').value;
  const data={code:document.getElementById('ven-code').value,name:document.getElementById('ven-name').value,seller_type:type,linked_user_id:type==='fijo'?document.getElementById('ven-user').value:'',document:document.getElementById('ven-doc').value,phone:document.getElementById('ven-phone').value,email:document.getElementById('ven-email').value,address:document.getElementById('ven-address').value,zone:type==='ambulante'?document.getElementById('ven-zone').value:'',route:type==='ambulante'?document.getElementById('ven-route').value:'',coverage_address:type==='ambulante'?document.getElementById('ven-coverage-address').value:'',sales_goal:document.getElementById('ven-goal').value,map_lat:document.getElementById('ven-lat').value,map_lng:document.getElementById('ven-lng').value,hire_date:document.getElementById('ven-hire').value,commission_mode:mode,commission_rate:['percent_sales','percent_margin'].includes(mode)?document.getElementById('ven-rate').value:0,commission_fixed:mode==='fixed_sale'?document.getElementById('ven-fixed').value:0,commission_frequency:document.getElementById('ven-cfreq').value,salary_amount:document.getElementById('ven-salary').value,payroll_frequency:document.getElementById('ven-pfreq').value,notes:document.getElementById('ven-notes').value};
  const r=id?await window.api.salespeople.update({id,data,requestUserId:user.id}):await window.api.salespeople.create({data,requestUserId:user.id});
  if(!r?.ok){toast(r?.error||'No se pudo guardar','err');return;}closeModal();toast('✓ Vendedor guardado');renderVendedores(document.getElementById('page'));
}
async function vendedoresToggle(id,active){const r=await window.api.salespeople.toggle({id,active,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}renderVendedores(document.getElementById('page'));}

function vendedoresOpenExternalSale(){
  const ambulantes=_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante');
  if(!ambulantes.length){toast('Primero registra un vendedor ambulante','w');return;}
  window._vexProducts=(DB.products||[]).filter(p=>p.active!==0);
  const sellers=ambulantes.map(s=>`<option value="${s.id}">${_venEsc(s.code)} · ${_venEsc(s.name)}</option>`).join('');
  openModal(`<div class="modal-title">Registrar venta externa</div><div class="modal-sub">Registra los productos del recibo externo para calcular venta, margen y comisión</div>
    <div class="ven-callout">Este registro es administrativo: no crea una factura fiscal ni descuenta inventario. Los precios y costos sirven para calcular venta neta, margen y comisión.</div>
    <div class="vex-document-grid"><div class="fg"><label class="lbl">Vendedor ambulante *</label><select class="inp" id="vex-seller">${sellers}</select></div><div class="fg"><label class="lbl">Fecha *</label><input class="inp" id="vex-date" type="date" value="${_venToday()}"/></div><div class="fg"><label class="lbl">No. del recibo externo</label><input class="inp" id="vex-receipt" placeholder="Opcional — se genera automáticamente"/><small class="ven-field-help">Si el papel tiene número, escríbelo para evitar duplicados.</small></div><div class="fg"><label class="lbl">Cliente</label><input class="inp" id="vex-client" value="Consumidor Final"/></div></div>
    <div class="vex-products"><div class="vex-products-head"><div><strong>Productos vendidos</strong><span>Busca por código, nombre o descripción; también admite productos libres</span></div><button class="btn btn-out btn-sm" type="button" onclick="vendedoresExternalAddLine()">${svg('plus')} Agregar producto</button></div>
      <div class="vex-lines-head"><span>Producto</span><span>Cant.</span><span>Precio</span><span>Costo</span><span>Importe</span><span></span></div><div id="vex-lines" class="vex-lines"></div></div>
    <div class="g3"><div class="fg"><label class="lbl">Descuento</label><input class="inp" id="vex-discount" type="number" min="0" step="0.01" value="0" oninput="vendedoresExternalRecalc()"/></div><div class="fg"><label class="lbl">Devoluciones incluidas</label><input class="inp" id="vex-return" type="number" min="0" step="0.01" value="0" oninput="vendedoresExternalRecalc()"/></div><div class="fg"><label class="lbl">Monto cobrado</label><input class="inp" id="vex-collected" type="number" min="0" step="0.01" placeholder="Igual a venta neta"/></div></div>
    <div class="vex-totals"><div><span>Venta bruta</span><strong id="vex-gross-label">${_venMoney(0)}</strong></div><div><span>Costo estimado</span><strong id="vex-cost-label">${_venMoney(0)}</strong></div><div class="primary"><span>Venta neta comisionable</span><strong id="vex-net-label">${_venMoney(0)}</strong></div></div>
    <div class="g2"><div class="fg"><label class="lbl">Método</label><select class="inp" id="vex-method">${['efectivo','transferencia','tarjeta','credito','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Notas</label><input class="inp" id="vex-notes" placeholder="Observaciones opcionales"/></div></div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresSaveExternal()">${svg('check')} Registrar venta</button></div>`, 'modal-xl vex-modal');
  vendedoresExternalAddLine();
}

function vendedoresExternalAddLine(){
  const lines=document.getElementById('vex-lines');if(!lines)return;
  const row=document.createElement('div');row.className='vex-line';row.setAttribute('data-vex-line','');
  row.innerHTML=`<div class="vex-product-search"><input type="hidden" class="vex-product-id"/><div class="vex-search-box">${svg('search')}<input class="inp vex-search vex-name" autocomplete="off" placeholder="Código, nombre o descripción…" oninput="vendedoresExternalSearch(this)" onfocus="vendedoresExternalSearch(this)" onkeydown="vendedoresExternalSearchKey(event,this)" onblur="setTimeout(()=>vendedoresExternalHideResults(this),160)"/></div><div class="vex-search-results"></div><small class="vex-selected-product">También puedes escribir una descripción libre</small></div>
    <label class="vex-mobile-label">Cantidad<input class="inp vex-qty" type="number" min="0.01" step="0.01" value="1" oninput="vendedoresExternalRecalc()"/></label>
    <label class="vex-mobile-label">Precio<input class="inp vex-price" type="number" min="0" step="0.01" placeholder="0.00" oninput="vendedoresExternalRecalc()"/></label>
    <label class="vex-mobile-label">Costo<input class="inp vex-cost" type="number" min="0" step="0.01" placeholder="0.00" oninput="vendedoresExternalRecalc()"/></label>
    <div class="vex-line-total">${_venMoney(0)}</div><button class="btn btn-ghost btn-sm vex-remove" type="button" title="Quitar renglón" onclick="this.closest('[data-vex-line]').remove();vendedoresExternalRecalc()">${svg('trash')}</button>`;
  lines.appendChild(row);vendedoresExternalRecalc();setTimeout(()=>row.querySelector('.vex-search')?.focus(),0);
}

function _vexProductMatches(query){
  const q=_venNorm(query).trim(),tokens=q.split(/\s+/).filter(Boolean);
  return (window._vexProducts||[]).map(p=>{const code=_venNorm(p.code),name=_venNorm(p.name),description=_venNorm(p.description),barcode=_venNorm(p.barcode),haystack=`${code} ${name} ${description} ${barcode}`;if(tokens.some(t=>!haystack.includes(t)))return null;let score=0;if(code===q||barcode===q)score+=100;if(q&&code.startsWith(q))score+=50;if(q&&name.startsWith(q))score+=35;if(q&&name.includes(q))score+=15;return{p,score};}).filter(Boolean).sort((a,b)=>b.score-a.score||String(a.p.name).localeCompare(String(b.p.name))).slice(0,8).map(x=>x.p);
}

function vendedoresExternalSearch(input){
  const row=input.closest('[data-vex-line]'),hidden=row.querySelector('.vex-product-id'),selected=row.querySelector('.vex-selected-product'),current=(window._vexProducts||[]).find(p=>Number(p.id)===Number(hidden.value));
  if(!current||String(current.name||'')!==input.value){hidden.value='';selected.textContent='Descripción libre — selecciona una coincidencia para cargar precio y costo';}
  const matches=_vexProductMatches(input.value),box=row.querySelector('.vex-search-results');box.innerHTML=matches.length?matches.map((p,i)=>`<button type="button" class="${i===0?'active':''}" onmousedown="event.preventDefault();vendedoresExternalSelectProduct(this,${Number(p.id)})"><span><strong>${_venEsc(p.name)}</strong><small>${_venEsc([p.code,p.description].filter(Boolean).join(' · '))}</small></span><b>${_venMoney(p.price)}</b></button>`).join(''):`<div class="vex-search-empty">Sin coincidencias. Conserva el texto como descripción libre.</div>`;box.classList.add('open');vendedoresExternalRecalc();
}

function vendedoresExternalSearchKey(event,input){
  const box=input.closest('[data-vex-line]').querySelector('.vex-search-results'),buttons=[...box.querySelectorAll('button')];if(!buttons.length)return;
  let index=Math.max(0,buttons.findIndex(b=>b.classList.contains('active')));if(event.key==='ArrowDown'){event.preventDefault();index=Math.min(buttons.length-1,index+1);}else if(event.key==='ArrowUp'){event.preventDefault();index=Math.max(0,index-1);}else if(event.key==='Enter'){event.preventDefault();buttons[index].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return;}else if(event.key==='Escape'){box.classList.remove('open');return;}else{return;}buttons.forEach((b,i)=>b.classList.toggle('active',i===index));buttons[index].scrollIntoView({block:'nearest'});
}

function vendedoresExternalSelectProduct(button,id){
  const row=button.closest('[data-vex-line]'),product=(window._vexProducts||[]).find(p=>Number(p.id)===Number(id));if(!product)return;
  row.querySelector('.vex-product-id').value=product.id;row.querySelector('.vex-name').value=product.name||'';row.querySelector('.vex-price').value=Number(product.price||0).toFixed(2);row.querySelector('.vex-cost').value=Number(product.cost||0).toFixed(2);row.querySelector('.vex-selected-product').textContent=`${product.code||'S/C'} · ${product.description||'Producto del inventario'}`;row.querySelector('.vex-search-results').classList.remove('open');vendedoresExternalRecalc();
}

function vendedoresExternalHideResults(input){input.closest('[data-vex-line]')?.querySelector('.vex-search-results')?.classList.remove('open');}

function vendedoresExternalRecalc(){
  let gross=0,cost=0;
  document.querySelectorAll('#vex-lines [data-vex-line]').forEach(row=>{const qty=Math.max(0,Number(row.querySelector('.vex-qty').value)||0),price=Math.max(0,Number(row.querySelector('.vex-price').value)||0),unitCost=Math.max(0,Number(row.querySelector('.vex-cost').value)||0),total=qty*price;gross+=total;cost+=qty*unitCost;row.querySelector('.vex-line-total').textContent=_venMoney(total);});
  const discount=Math.max(0,Number(document.getElementById('vex-discount')?.value)||0),returned=Math.max(0,Number(document.getElementById('vex-return')?.value)||0),net=Math.max(0,gross-discount-returned);
  const grossEl=document.getElementById('vex-gross-label'),costEl=document.getElementById('vex-cost-label'),netEl=document.getElementById('vex-net-label'),collected=document.getElementById('vex-collected');
  if(grossEl)grossEl.textContent=_venMoney(gross);if(costEl)costEl.textContent=_venMoney(cost);if(netEl)netEl.textContent=_venMoney(net);if(collected){collected.max=String(net);collected.placeholder=`Hasta ${_venMoney(net)}`;}
}

async function vendedoresSaveExternal(){
  const items=[...document.querySelectorAll('#vex-lines [data-vex-line]')].map(row=>{const product=(window._vexProducts||[]).find(p=>Number(p.id)===Number(row.querySelector('.vex-product-id').value));return{product_id:product?.id||null,product_code:product?.code||'',product_name:row.querySelector('.vex-name').value,qty:row.querySelector('.vex-qty').value,unit_price:row.querySelector('.vex-price').value,unit_cost:row.querySelector('.vex-cost').value};});
  const data={salesperson_id:document.getElementById('vex-seller').value,sale_date:document.getElementById('vex-date').value,receipt_number:document.getElementById('vex-receipt').value,customer_name:document.getElementById('vex-client').value,items,discount_amount:document.getElementById('vex-discount').value,return_amount:document.getElementById('vex-return').value,collected_amount:document.getElementById('vex-collected').value||null,payment_method:document.getElementById('vex-method').value,notes:document.getElementById('vex-notes').value};
  const r=await window.api.salespeople.createExternalSale({data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast('✓ Venta externa registrada y lista para comisión');_venTab='externas';renderVendedores(document.getElementById('page'));
}

async function vendedoresViewExternal(id){
  const r=await window.api.salespeople.getExternalSaleById({id});if(!r?.ok||!r.data){toast(r?.error||'Venta externa no encontrada','err');return;}const s=r.data;
  const items=s.items||[];const rows=items.length?items.map(i=>`<tr><td><strong>${_venEsc(i.product_name)}</strong><div class="ven-person-meta">${_venEsc(i.product_code||'Producto libre')}</div></td><td style="text-align:right">${Number(i.qty)}</td><td style="text-align:right">${_venMoney(i.unit_price)}</td><td style="text-align:right">${_venMoney(i.unit_cost)}</td><td style="text-align:right;font-weight:750">${_venMoney(i.line_total)}</td></tr>`).join(''):`<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">Registro anterior sin detalle de productos</td></tr>`;
  openModal(`<div class="modal-title">Venta externa ${_venEsc(s.receipt_number)}</div><div class="modal-sub">${_venEsc(s.salesperson_name)} · ${_venEsc(s.sale_date)} · ${_venEsc(s.customer_name)}</div><div class="ven-callout">Registro administrativo basado en un recibo físico externo. No es una factura fiscal del sistema.</div><div class="tw"><table><thead><tr><th>Producto</th><th style="text-align:right">Cant.</th><th style="text-align:right">Precio</th><th style="text-align:right">Costo</th><th style="text-align:right">Importe</th></tr></thead><tbody>${rows}</tbody></table></div><div class="vex-totals"><div><span>Venta bruta</span><strong>${_venMoney(s.gross_amount)}</strong></div><div><span>Descuento / devolución</span><strong>${_venMoney(Number(s.discount_amount||0)+Number(s.return_amount||0))}</strong></div><div class="primary"><span>Venta neta comisionable</span><strong>${_venMoney(s.net_amount)}</strong></div></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>`, 'modal-lg');
}

async function vendedoresCancelExternal(id){const reason=await askText('Indica por qué se anula esta venta externa.',{title:'Anular venta externa'});if(!reason)return;const r=await window.api.salespeople.cancelExternalSale({id,reason,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}toast('✓ Venta externa anulada');renderVendedores(document.getElementById('page'));}

function vendedoresOpenExpense(sellerId=null){if(!_venState.sellers.some(s=>s.status==='activo')){toast('No hay vendedores activos','w');return;}openModal(`<div class="modal-title">Viático o gasto del vendedor</div><div class="modal-sub">Se registrará también en Gastos y Contabilidad</div><div class="g2"><div class="fg"><label class="lbl">Vendedor</label><select class="inp" id="veg-seller">${_venSellerOptions(sellerId)}</select></div><div class="fg"><label class="lbl">Tipo</label><select class="inp" id="veg-kind">${['viatico','combustible','alimentacion','alojamiento','peaje','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div></div><div class="g2"><div class="fg"><label class="lbl">Fecha</label><input class="inp" id="veg-date" type="date" value="${_venToday()}"/></div><div class="fg"><label class="lbl">Monto</label><input class="inp" id="veg-amount" type="number" min="0" step="0.01"/></div></div><div class="fg"><label class="lbl">Descripción</label><input class="inp" id="veg-desc" placeholder="Ruta, visita, motivo…"/></div><div class="g2"><div class="fg"><label class="lbl">Método</label><select class="inp" id="veg-method">${['efectivo','transferencia','tarjeta','cheque','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Origen</label><select class="inp" id="veg-source"><option value="caja_chica">Caja chica</option><option value="caja">Caja abierta</option><option value="banco">Banco</option><option value="pendiente">Pendiente de pago</option></select></div></div><label style="display:flex;gap:8px;align-items:center"><input id="veg-pay" type="checkbox" checked/> Pagar ahora</label><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresSaveExpense()">Registrar</button></div>`);}
async function vendedoresSaveExpense(){const data={salespersonId:document.getElementById('veg-seller').value,kind:document.getElementById('veg-kind').value,issue_date:document.getElementById('veg-date').value,amount:document.getElementById('veg-amount').value,description:document.getElementById('veg-desc').value,payment_method:document.getElementById('veg-method').value,payment_source:document.getElementById('veg-source').value,pay_now:document.getElementById('veg-pay').checked};if(data.payment_source==='pendiente')data.pay_now=false;const r=await window.api.salespeople.createExpense({data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast('✓ Gasto del vendedor registrado');_venTab='viaticos';renderVendedores(document.getElementById('page'));}
