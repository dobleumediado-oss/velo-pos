// ════════════════════════════════════════════════════════════════════════════
// vendedores.js — Vendedores fijos/ambulantes, comisiones, viáticos y nómina
// ════════════════════════════════════════════════════════════════════════════

let _venTab = 'resumen';
let _venState = { sellers: [], dashboard: null, external: [], commissions: [], expenses: [], payroll: [] };
let _venRange = { from: '', to: '' };
let _venQuery = '';
let _venListFilter = 'todos';
let _venCalendarDate = '';

function _venEsc(v) {
  return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function _venToday() {
  if (typeof today === 'function') return today();
  const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _venMonthStart() { const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; }
function _venPeriod(frequency, dateText=_venToday()) {
  const d=new Date(`${dateText}T12:00:00`),y=d.getFullYear(),m=d.getMonth();
  const fmt=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
  let from,to;
  if(frequency==='semanal'){const off=(d.getDay()+6)%7;from=new Date(y,m,d.getDate()-off);to=new Date(from.getFullYear(),from.getMonth(),from.getDate()+6);}
  else if(frequency==='quincenal'){from=new Date(y,m,d.getDate()<=15?1:16);to=d.getDate()<=15?new Date(y,m,15):new Date(y,m+1,0);}
  else{from=new Date(y,m,1);to=new Date(y,m+1,0);}
  return {from:fmt(from),to:fmt(to)};
}
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
  if (_venTab === 'comisiones') _venRenderCommissions(content);
  if (_venTab === 'viaticos') _venRenderExpenses(content);
  if (_venTab === 'nomina') _venRenderPayroll(content);
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
  if (!_venRange.from) _venRange = { from: _venMonthStart(), to: _venToday() };
  el.innerHTML = `<div class="ven-shell"><div class="ven-panel"><div class="ven-empty">
    <div class="ven-empty-icon">${svg('clock')}</div><h3>Preparando el centro de vendedores</h3>
    <p>Conectando ventas, comisiones, gastos y nómina…</p></div></div></div>`;
  const [sellers,dashboard,external,commissions,expenses,payroll] = await Promise.all([
    window.api.salespeople.getAll({}),
    window.api.salespeople.getDashboard(_venRange),
    window.api.salespeople.getExternalSales(_venRange),
    window.api.salespeople.getCommissionRuns({}),
    window.api.salespeople.getExpenses(_venRange),
    window.api.salespeople.getPayrollRuns(),
  ]);
  _venState = {
    sellers:sellers?.data||[], dashboard:dashboard?.data||null, external:external?.data||[],
    commissions:commissions?.data||[], expenses:expenses?.data||[], payroll:payroll?.data||[],
  };
  DB.salespeople = _venState.sellers.filter(s=>s.status==='activo');
  _venRender(el);
}

function _venRender(el=document.getElementById('page')) {
  if(!el)return;
  const pendingCommissions = _venState.commissions.filter(x => x.status === 'borrador').length;
  const pendingPayroll = _venState.payroll.filter(x => ['borrador','aprobado'].includes(x.status)).length;
  const tabs=[
    ['resumen','grid','Centro de control',''],
    ['vendedores','users','Vendedores',_venState.sellers.length],
    ['externas','receipt','Talonarios',_venState.external.length],
    ['comisiones','trend','Comisiones',pendingCommissions],
    ['viaticos','cash','Viáticos',_venState.expenses.length],
    ['nomina','calendar','Nómina',pendingPayroll],
    ['agenda','calendar','Agenda',''],
    ['flujo','grid','Flujo',''],
    ['mapa','map-pin','Cobertura',_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante').length],
  ];
  el.innerHTML=`
    <div class="ven-shell">
      <section class="ven-hero">
        <div class="ven-hero-main">
          <div><div class="ven-eyebrow"><span class="dot"></span> Gestión comercial y compensación</div>
            <h1>Vendedores y Nómina</h1>
            <p>Un centro único para dirigir el equipo, controlar talonarios, calcular comisiones y convertir cada pago en un gasto contable trazable.</p>
          </div>
          <div class="ven-actions">
            <button class="btn btn-out" onclick="vendedoresOpenExternalSale()">${svg('receipt')} Registrar talonario</button>
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
  if(_venTab==='comisiones')_venRenderCommissions(content);
  if(_venTab==='viaticos')_venRenderExpenses(content);
  if(_venTab==='nomina')_venRenderPayroll(content);
  if(_venTab==='agenda')_venRenderCalendar(content);
  if(_venTab==='flujo')_venRenderWorkflow(content);
  if(_venTab==='mapa')_venRenderMap(content);
}

function _venRenderSummary(el) {
  const d=_venState.dashboard||{rows:[],activeCount:0,salesTotal:0,commissionTotal:0,expenseTotal:0};
  const rows=d.rows||[];
  const activeStreet=_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante').length;
  const drafts=_venState.commissions.filter(x=>x.status==='borrador');
  const approved=_venState.commissions.filter(x=>x.status==='aprobado');
  const payrollPending=_venState.payroll.filter(x=>['borrador','aprobado'].includes(x.status));
  const maxSales=Math.max(1,...rows.map(r=>Number(r.sales)||0));
  const expenseRatio=Number(d.salesTotal)>0?(Number(d.expenseTotal)/Number(d.salesTotal))*100:0;
  const metric=(icon,color,chip,label,value,note)=>`<article class="ven-metric">
    <div class="ven-metric-top"><div class="ven-metric-icon ${color}">${svg(icon)}</div><span class="ven-metric-chip">${chip}</span></div>
    <div class="ven-metric-label">${label}</div><div class="ven-metric-value">${value}</div><div class="ven-metric-note">${note}</div></article>`;
  const table=rows.length?`<div class="tw"><table><thead><tr><th>Vendedor</th><th>Perfil</th><th style="text-align:center">Operaciones</th><th>Desempeño</th><th style="text-align:right">Margen</th><th style="text-align:right">Comisión</th><th style="text-align:right">Gastos</th></tr></thead><tbody>
    ${rows.map(r=>{const seller=_venState.sellers.find(s=>Number(s.id)===Number(r.id))||{};const goalPct=_venGoalPercent(seller,r.sales);return `<tr class="ven-click-row" onclick="vendedoresOpenProfile(${r.id})"><td><div class="ven-person"><div class="ven-avatar ${r.type==='ambulante'?'street':''}">${_venInitials(r.name)}</div><div><div class="ven-person-name">${_venEsc(r.name)}</div><div class="ven-person-meta">${Number(seller.sales_goal||0)>0?`${goalPct.toFixed(0)}% de la meta`:`Venta neta ${_venMoney(r.sales)}`}</div></div></div></td>
      <td>${r.type==='ambulante'?'<span class="badge a">Ambulante</span>':'<span class="badge b">Fijo</span>'}</td><td style="text-align:center"><strong>${r.salesCount}</strong></td>
      <td><strong class="ven-money">${_venMoney(r.sales)}</strong><div class="ven-progress"><span style="width:${Math.max(4,Number(seller.sales_goal||0)>0?Math.min(100,goalPct):(Number(r.sales)||0)/maxSales*100)}%"></span></div></td>
      <td style="text-align:right" class="ven-money">${_venMoney(r.margin)}</td><td style="text-align:right;color:var(--green);font-weight:800" class="ven-money">${_venMoney(r.commission)}</td><td style="text-align:right" class="ven-money">${_venMoney(r.expenses)}</td></tr>`}).join('')}
    </tbody></table></div>`:_venEmpty('users','Aún no hay rendimiento para mostrar','Registra tu primer vendedor y asígnalo a una venta para comenzar.','Crear primer vendedor','vendedoresOpenSeller()');
  el.innerHTML=`<div class="ven-metrics">
    ${metric('users','green','Equipo','Vendedores activos',d.activeCount||0,`<strong>${activeStreet}</strong> ambulantes · <strong>${Math.max(0,(d.activeCount||0)-activeStreet)}</strong> fijos`)}
    ${metric('trend','blue','Período','Ventas asignadas',_venMoney(d.salesTotal),`<strong>${rows.reduce((s,r)=>s+(Number(r.salesCount)||0),0)}</strong> operaciones netas`)}
    ${metric('dollar','purple','Proyección','Comisión estimada',_venMoney(d.commissionTotal),`<strong>${drafts.length}</strong> cortes por aprobar`)}
    ${metric('cash','amber','Operación','Viáticos y gastos',_venMoney(d.expenseTotal),`<strong>${expenseRatio.toFixed(1)}%</strong> de las ventas asignadas`)}
  </div>
  <div class="ven-grid">
    <section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('chart')} Rendimiento del equipo</div><div class="ven-panel-sub">Ventas netas después de devoluciones · ${_venEsc(d.from||'')} al ${_venEsc(d.to||'')}</div></div><span class="badge g">${rows.length} vendedor${rows.length===1?'':'es'}</span></div>${table}</section>
    <aside class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('alert')} Pendientes y próximos pasos</div><div class="ven-panel-sub">Acciones que requieren atención</div></div></div><div class="ven-panel-body"><div class="ven-insights">
      <div class="ven-insight"><div class="ven-insight-icon">${svg('trend')}</div><div><strong>${drafts.length} comisión${drafts.length===1?'':'es'} por aprobar</strong><span>${approved.length} aprobadas listas para entrar en nómina.</span></div></div>
      <div class="ven-insight"><div class="ven-insight-icon">${svg('calendar')}</div><div><strong>${payrollPending.length} nómina${payrollPending.length===1?'':'s'} en proceso</strong><span>Separadas por frecuencia semanal, quincenal o mensual.</span></div></div>
      <div class="ven-insight"><div class="ven-insight-icon">${svg('receipt')}</div><div><strong>${_venState.external.length} recibos externos</strong><span>Registrados dentro del período seleccionado.</span></div></div>
    </div><div class="ven-quick"><button onclick="vendedoresOpenCommission()">Calcular comisión</button><button onclick="vendedoresOpenPayroll()">Generar nómina</button><button onclick="vendedoresOpenExpense()">Registrar viático</button><button onclick="_venSetTab('vendedores')">Ver equipo</button></div></div></aside>
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
    <div class="ven-seller-data"><div><label>Comisión</label><strong>${_venEsc(_venModeLabel(s))}</strong></div><div><label>Liquidación</label><strong>${_venEsc(s.commission_frequency)}</strong></div><div><label>Zona / Ruta</label><strong>${_venEsc([s.zone,s.route].filter(Boolean).join(' · ')||'Sin asignar')}</strong></div><div><label>Salario período</label><strong>${_venMoney(s.salary_amount)}</strong></div></div>
    <div class="ven-seller-foot"><div class="ven-seller-contact">${svg('phone')} ${_venEsc(s.phone||s.document||'Sin contacto')}</div><div class="flex"><button class="btn btn-out btn-sm" onclick="vendedoresOpenProfile(${s.id})">${svg('eye')} Perfil</button><button class="btn btn-out btn-sm" onclick="vendedoresOpenSeller(${s.id})">${svg('edit')} Editar</button><button class="btn btn-ghost btn-sm" title="${s.status==='activo'?'Desactivar':'Activar'}" onclick="vendedoresToggle(${s.id},${s.status!=='activo'})">${s.status==='activo'?svg('lock'):svg('unlock')}</button></div></div>
  </article>`).join(''):_venEmpty('users',all.length?'No encontramos coincidencias':'Construye tu equipo comercial',all.length?'Cambia la búsqueda o el filtro seleccionado.':'Registra vendedores fijos o ambulantes. Los ambulantes no necesitan acceso al POS.','Nuevo vendedor','vendedoresOpenSeller()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('users')} Directorio comercial</div><div class="ven-panel-sub">Perfiles, reglas de comisión, rutas y compensación del equipo</div></div><span class="badge g">${all.filter(s=>s.status==='activo').length} activos</span></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Fijos <strong>${all.filter(s=>s.seller_type==='fijo').length}</strong></span><span class="ven-summary-item">Ambulantes <strong>${all.filter(s=>s.seller_type==='ambulante').length}</strong></span><span class="ven-summary-item">Sin usuario POS <strong>${all.filter(s=>!s.linked_user_id).length}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar por nombre, código, zona o teléfono…',filters:filter,action:`<button class="btn btn-green btn-sm" onclick="vendedoresOpenSeller()">${svg('plus')} Agregar</button>`})}<div class="ven-seller-grid" style="margin-top:14px">${cards}</div></div></section>`;
}

function _venRenderExternal(el) {
  const all=_venState.external;
  const rows=all.filter(x=>(_venListFilter==='todos'||x.payment_method===_venListFilter)&&_venMatches(x.salesperson_name,x.customer_name,x.booklet_number,x.receipt_number,x.payment_method));
  const total=all.reduce((s,x)=>s+Number(x.net_amount||0),0),collected=all.reduce((s,x)=>s+Number(x.collected_amount||0),0);
  const methods=[...new Set(all.map(x=>x.payment_method).filter(Boolean))];
  const filter=`<select class="ven-filter" onchange="_venSetListFilter(this.value)"><option value="todos">Todos los métodos</option>${methods.map(x=>`<option value="${_venEsc(x)}" ${_venListFilter===x?'selected':''}>${_venEsc(x)}</option>`).join('')}</select>`;
  const body=rows.length?`<div class="tw"><table><thead><tr><th>Fecha</th><th>Vendedor</th><th>Talonario / Recibo</th><th>Cliente</th><th>Método</th><th style="text-align:right">Venta neta</th><th style="text-align:right">Cobrado</th><th>Estado</th><th></th></tr></thead><tbody>
    ${rows.map(x=>`<tr><td>${_venEsc(x.sale_date)}</td><td><div class="ven-person"><div class="ven-avatar street">${_venInitials(x.salesperson_name)}</div><div><div class="ven-person-name">${_venEsc(x.salesperson_name)}</div><div class="ven-person-meta">Venta fuera del POS</div></div></div></td><td><strong class="ven-money">${_venEsc([x.booklet_number,x.receipt_number].filter(Boolean).join('-'))}</strong></td><td>${_venEsc(x.customer_name)}</td><td><span class="badge n">${_venEsc(x.payment_method)}</span></td><td style="text-align:right;font-weight:750" class="ven-money">${_venMoney(x.net_amount)}</td><td style="text-align:right" class="ven-money">${_venMoney(x.collected_amount)}</td><td>${_venBadge(x.status)}</td><td>${x.status==='registrada'?`<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="vendedoresCancelExternal(${x.id})">Anular</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:_venEmpty('receipt',all.length?'No encontramos recibos':'Sin movimientos de talonario',all.length?'Prueba con otro método o término de búsqueda.':'Registra las ventas realizadas fuera del POS para calcular la comisión del ambulante.','Registrar recibo','vendedoresOpenExternalSale()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('receipt')} Control de talonarios</div><div class="ven-panel-sub">Registro operativo de ventas ambulantes sin duplicar la factura fiscal</div></div><button class="btn btn-green btn-sm" onclick="vendedoresOpenExternalSale()">${svg('plus')} Registrar recibo</button></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Recibos <strong>${all.length}</strong></span><span class="ven-summary-item">Venta neta <strong>${_venMoney(total)}</strong></span><span class="ven-summary-item">Cobrado <strong>${_venMoney(collected)}</strong></span><span class="ven-summary-item">Pendiente <strong>${_venMoney(Math.max(0,total-collected))}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar vendedor, cliente, talonario o recibo…',filters:filter})}</div>${body}</section>`;
}

function _venRenderCommissions(el) {
  const all=_venState.commissions;
  const rows=all.filter(r=>(_venListFilter==='todos'||r.status===_venListFilter)&&_venMatches(r.salesperson_name,r.date_from,r.date_to,r.calculation_mode,r.status));
  const total=all.reduce((s,r)=>s+Number(r.commission_total||0),0);
  const approved=all.filter(r=>r.status==='aprobado').reduce((s,r)=>s+Number(r.commission_total||0),0);
  const filter=`<select class="ven-filter" onchange="_venSetListFilter(this.value)"><option value="todos">Todos los estados</option>${['borrador','aprobado','pagado'].map(x=>`<option value="${x}" ${_venListFilter===x?'selected':''}>${x}</option>`).join('')}</select>`;
  const body=rows.length?`<div class="tw"><table><thead><tr><th>Período</th><th>Vendedor</th><th>Regla aplicada</th><th style="text-align:center">Ventas</th><th style="text-align:right">Venta neta</th><th style="text-align:right">Margen</th><th style="text-align:right">Comisión</th><th>Estado</th><th></th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td><strong>${_venEsc(r.date_from)}</strong><div class="ven-person-meta">hasta ${_venEsc(r.date_to)} · ${_venEsc(r.frequency)}</div></td><td><div class="ven-person"><div class="ven-avatar ${r.seller_type==='ambulante'?'street':''}">${_venInitials(r.salesperson_name)}</div><div class="ven-person-name">${_venEsc(r.salesperson_name)}</div></div></td><td>${_venEsc(r.calculation_mode.replaceAll('_',' '))}${r.rate?`<div class="ven-person-meta">Tasa ${r.rate}%</div>`:''}</td><td style="text-align:center"><strong>${r.sales_count}</strong></td><td style="text-align:right" class="ven-money">${_venMoney(r.sales_total)}</td><td style="text-align:right" class="ven-money">${_venMoney(r.margin_total)}</td><td style="text-align:right;color:var(--green);font-weight:850" class="ven-money">${_venMoney(r.commission_total)}</td><td>${_venBadge(r.status)}</td><td>${r.status==='borrador'?`<button class="btn btn-green btn-sm" onclick="vendedoresApproveCommission(${r.id})">${svg('check')} Aprobar</button>`:'<span style="color:var(--muted2)">—</span>'}</td></tr>`).join('')}</tbody></table></div>`:_venEmpty('trend',all.length?'No hay cortes con ese filtro':'Las comisiones aún no se han calculado',all.length?'Cambia el estado o la búsqueda.':'El sistema propondrá el período correcto y descontará las devoluciones vigentes.','Calcular comisión','vendedoresOpenCommission()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('trend')} Liquidación de comisiones</div><div class="ven-panel-sub">Cortes auditables con ventas y reglas congeladas</div></div><button class="btn btn-green btn-sm" onclick="vendedoresOpenCommission()">${svg('plus')} Nuevo cálculo</button></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Cortes <strong>${all.length}</strong></span><span class="ven-summary-item">Total calculado <strong>${_venMoney(total)}</strong></span><span class="ven-summary-item">Aprobado para nómina <strong>${_venMoney(approved)}</strong></span><span class="ven-summary-item">Pendientes <strong>${all.filter(r=>r.status==='borrador').length}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar vendedor, período o regla…',filters:filter})}</div>${body}</section>`;
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

function _venRenderPayroll(el) {
  const all=_venState.payroll;
  const rows=all.filter(r=>(_venListFilter==='todos'||r.status===_venListFilter||r.frequency===_venListFilter)&&_venMatches(r.number,r.date_from,r.date_to,r.frequency,r.status));
  const total=all.reduce((s,r)=>s+Number(r.net_total||0),0),commissions=all.reduce((s,r)=>s+Number(r.commission_total||0),0);
  const filter=`<select class="ven-filter" onchange="_venSetListFilter(this.value)"><option value="todos">Todos los estados</option><option value="borrador" ${_venListFilter==='borrador'?'selected':''}>Borradores</option><option value="aprobado" ${_venListFilter==='aprobado'?'selected':''}>Aprobadas</option><option value="pagado" ${_venListFilter==='pagado'?'selected':''}>Pagadas</option><option value="semanal" ${_venListFilter==='semanal'?'selected':''}>Semanales</option><option value="quincenal" ${_venListFilter==='quincenal'?'selected':''}>Quincenales</option><option value="mensual" ${_venListFilter==='mensual'?'selected':''}>Mensuales</option></select>`;
  const body=rows.length?`<div class="tw"><table><thead><tr><th>Número / Período</th><th>Frecuencia</th><th style="text-align:center">Personas</th><th style="text-align:right">Salario</th><th style="text-align:right">Comisiones</th><th style="text-align:right">Ajustes</th><th style="text-align:right">Neto a pagar</th><th>Estado</th><th></th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td><strong class="ven-money">${_venEsc(r.number)}</strong><div class="ven-person-meta">${_venEsc(r.date_from)} al ${_venEsc(r.date_to)}</div></td><td><span class="badge b">${_venEsc(r.frequency||'mensual')}</span></td><td style="text-align:center"><strong>${r.employee_count}</strong></td><td style="text-align:right" class="ven-money">${_venMoney(r.base_total)}</td><td style="text-align:right;color:var(--purple);font-weight:750" class="ven-money">${_venMoney(r.commission_total)}</td><td style="text-align:right" class="ven-money">${Number(r.bonus_total||0)>0?'+':''}${_venMoney(Number(r.bonus_total||0)-Number(r.deduction_total||0))}</td><td style="text-align:right;color:var(--green);font-weight:850" class="ven-money">${_venMoney(r.net_total)}</td><td>${_venBadge(r.status)}</td><td style="white-space:nowrap"><button class="btn btn-out btn-sm" onclick="vendedoresViewPayroll(${r.id})">${svg('eye')} Detalle</button>${r.status==='borrador'?`<button class="btn btn-green btn-sm" onclick="vendedoresApprovePayroll(${r.id})">Aprobar</button>`:''}${r.status==='aprobado'?`<button class="btn btn-dark btn-sm" onclick="vendedoresPayPayroll(${r.id})">Pagar</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:_venEmpty('calendar',all.length?'No hay nóminas con ese filtro':'La nómina está lista para automatizarse','Genera el período semanal, quincenal o mensual. El sistema incorporará únicamente las comisiones aprobadas.','Generar primera nómina','vendedoresOpenPayroll()');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('calendar')} Nómina y liquidaciones</div><div class="ven-panel-sub">Salario base + comisión aprobada + bonos − deducciones</div></div><button class="btn btn-green btn-sm" onclick="vendedoresOpenPayroll()">${svg('plus')} Generar nómina</button></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Períodos <strong>${all.length}</strong></span><span class="ven-summary-item">Neto acumulado <strong>${_venMoney(total)}</strong></span><span class="ven-summary-item">Comisiones incluidas <strong>${_venMoney(commissions)}</strong></span><span class="ven-summary-item">En proceso <strong>${all.filter(r=>['borrador','aprobado'].includes(r.status)).length}</strong></span></div>
    <div class="ven-panel-body">${_venToolbar({placeholder:'Buscar número, período, frecuencia o estado…',filters:filter})}</div>${body}</section>`;
}

function _venCalendarEvents() {
  const events=[];
  _venState.commissions.filter(x=>x.status!=='anulado').forEach(x=>events.push({date:x.date_to,type:'comision',tone:'purple',title:`Comisión · ${x.salesperson_name}`,detail:_venMoney(x.commission_total),tab:'comisiones'}));
  _venState.payroll.filter(x=>x.status!=='anulado').forEach(x=>events.push({date:x.payment_date||x.date_to,type:'nomina',tone:x.status==='pagado'?'green':'blue',title:`${x.number} · ${x.frequency}`,detail:`${_venMoney(x.net_total)} · ${x.status}`,tab:'nomina'}));
  _venState.expenses.filter(x=>!['anulado','rechazado'].includes(x.status)).forEach(x=>events.push({date:x.issue_date,type:'gasto',tone:'amber',title:`${x.expense_kind} · ${x.salesperson_name}`,detail:_venMoney(x.total),tab:'viaticos'}));
  _venState.external.filter(x=>x.status==='registrada').forEach(x=>events.push({date:x.sale_date,type:'talonario',tone:'green',title:`Recibo · ${x.salesperson_name}`,detail:_venMoney(x.net_amount),tab:'externas'}));
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
  const totals={comision:events.filter(x=>x.type==='comision').length,nomina:events.filter(x=>x.type==='nomina').length,gasto:events.filter(x=>x.type==='gasto').length,talonario:events.filter(x=>x.type==='talonario').length};
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('calendar')} Calendario empresarial</div><div class="ven-panel-sub">Cortes, nóminas, viáticos y actividad ambulante en una sola agenda</div></div><div class="ven-calendar-nav"><button onclick="_venCalendarMove(-1)">‹</button><strong>${base.toLocaleDateString('es-DO',{month:'long',year:'numeric'})}</strong><button onclick="_venCalendarMove(1)">›</button></div></div>
    <div class="ven-summary-strip"><span class="ven-summary-item">Comisiones <strong>${totals.comision}</strong></span><span class="ven-summary-item">Nóminas <strong>${totals.nomina}</strong></span><span class="ven-summary-item">Gastos <strong>${totals.gasto}</strong></span><span class="ven-summary-item">Talonarios <strong>${totals.talonario}</strong></span></div>
    <div class="ven-panel-body"><div class="ven-calendar-week">${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(x=>`<span>${x}</span>`).join('')}</div><div class="ven-calendar-grid">${cells.join('')}</div></div></section>`;
}

function _venRenderWorkflow(el) {
  const cards=[
    ..._venState.commissions.filter(x=>x.status!=='anulado').map(x=>({kind:'Comisión',icon:'trend',id:x.id,status:x.status,title:x.salesperson_name,period:`${x.date_from} → ${x.date_to}`,amount:x.commission_total,action:x.status==='borrador'?`vendedoresApproveCommission(${x.id})`:''})),
    ..._venState.payroll.filter(x=>x.status!=='anulado').map(x=>({kind:'Nómina',icon:'calendar',id:x.id,status:x.status,title:x.number,period:`${x.date_from} → ${x.date_to}`,amount:x.net_total,action:x.status==='borrador'?`vendedoresApprovePayroll(${x.id})`:x.status==='aprobado'?`vendedoresPayPayroll(${x.id})`:''})),
  ];
  const columns=[['borrador','Por preparar','Revisión y ajustes'],['aprobado','Aprobado','Listo para pagar'],['pagado','Pagado','Ciclo completado']];
  const columnHtml=columns.map(([status,title,sub])=>{const items=cards.filter(x=>x.status===status);return `<section class="ven-kanban-column ${status}"><header><div><small>${title}</small><span>${sub}</span></div><b>${items.length}</b></header><div class="ven-kanban-list">${items.map(x=>`<article class="ven-kanban-card"><div class="ven-kanban-kind">${svg(x.icon)} ${x.kind}</div><strong>${_venEsc(x.title)}</strong><span>${_venEsc(x.period)}</span><div><b>${_venMoney(x.amount)}</b>${x.action?`<button onclick="${x.action}">${status==='borrador'?'Aprobar':'Pagar'} →</button>`:'<em>Completado ✓</em>'}</div></article>`).join('')||'<div class="ven-kanban-empty">Sin documentos en esta etapa</div>'}</div></section>`}).join('');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('grid')} Flujo de compensación</div><div class="ven-panel-sub">Comisiones y nóminas desde el borrador hasta el pago conectado con Gastos</div></div><div class="flex"><button class="btn btn-out btn-sm" onclick="vendedoresOpenCommission()">Nueva comisión</button><button class="btn btn-green btn-sm" onclick="vendedoresOpenPayroll()">Nueva nómina</button></div></div><div class="ven-panel-body"><div class="ven-kanban">${columnHtml}</div></div></section>`;
}

function _venMapPoint(seller,index,configured) {
  if(configured.length>1&&seller.map_lat!=null&&seller.map_lng!=null){
    const lats=configured.map(x=>Number(x.map_lat)),lngs=configured.map(x=>Number(x.map_lng));
    const latSpan=Math.max(.001,Math.max(...lats)-Math.min(...lats)),lngSpan=Math.max(.001,Math.max(...lngs)-Math.min(...lngs));
    return {x:12+((Number(seller.map_lng)-Math.min(...lngs))/lngSpan)*76,y:82-((Number(seller.map_lat)-Math.min(...lats))/latSpan)*64,exact:true};
  }
  if(configured.length===1&&seller.map_lat!=null&&seller.map_lng!=null)return{x:52,y:43,exact:true};
  const seed=[...(seller.zone||seller.route||seller.name||'')].reduce((sum,ch)=>sum+ch.charCodeAt(0),0)+index*37;
  return{x:14+(seed*17)%72,y:18+(seed*29)%64,exact:false};
}

function _venRenderMap(el) {
  const sellers=_venState.sellers.filter(s=>s.status==='activo'&&s.seller_type==='ambulante');
  const configured=sellers.filter(s=>s.map_lat!=null&&s.map_lng!=null);
  if(!sellers.length){el.innerHTML=`<section class="ven-panel">${_venEmpty('map-pin','Aún no hay cobertura ambulante','Registra un vendedor ambulante y asigna su zona o coordenadas para construir el mapa.','Crear ambulante','vendedoresOpenSeller()')}</section>`;return;}
  const points=sellers.map((s,i)=>({..._venMapPoint(s,i,configured),seller:s,perf:_venSellerPerformance(s.id)}));
  const lines=points.map(p=>`<line x1="50" y1="50" x2="${p.x}" y2="${p.y}"/>`).join('');
  const pins=points.map(p=>`<button class="ven-map-pin ${p.exact?'exact':'approx'}" style="left:${p.x}%;top:${p.y}%" onclick="vendedoresOpenProfile(${p.seller.id})"><span>${_venInitials(p.seller.name)}</span><label>${_venEsc(p.seller.name.split(' ')[0])}</label><small>${_venEsc(p.seller.zone||'Zona pendiente')}</small></button>`).join('');
  const list=points.map(p=>{const pct=_venGoalPercent(p.seller,p.perf.sales);return `<button class="ven-map-seller" onclick="vendedoresOpenProfile(${p.seller.id})"><span class="ven-avatar street">${_venInitials(p.seller.name)}</span><div><strong>${_venEsc(p.seller.name)}</strong><small>${_venEsc([p.seller.zone,p.seller.route].filter(Boolean).join(' · ')||'Sin ruta asignada')}</small><div class="ven-progress"><i style="width:${Math.min(100,pct)}%"></i></div></div><b>${Number(p.seller.sales_goal||0)>0?pct.toFixed(0)+'%':_venMoney(p.perf.sales)}</b></button>`}).join('');
  el.innerHTML=`<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('map-pin')} Cobertura de vendedores ambulantes</div><div class="ven-panel-sub">Mapa operativo de zonas y rutas · las posiciones sin coordenadas son aproximadas</div></div><span class="badge b">${configured.length}/${sellers.length} con coordenadas</span></div><div class="ven-map-layout"><div class="ven-map-canvas"><div class="ven-map-grid"></div><svg viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg><div class="ven-map-base">${svg('store')}<span>${_venEsc(CFG.biz||'Negocio')}</span></div>${pins}<div class="ven-map-legend"><span><i class="exact"></i> Coordenada configurada</span><span><i></i> Posición por zona</span></div></div><aside class="ven-map-list"><header><strong>Equipo en ruta</strong><small>${sellers.length} ambulante${sellers.length===1?'':'s'} activo${sellers.length===1?'':'s'}</small></header>${list}</aside></div></section>`;
}

function vendedoresOpenProfile(id) {
  const seller=_venState.sellers.find(x=>Number(x.id)===Number(id));if(!seller)return;
  const perf=_venSellerPerformance(id),goal=Number(seller.sales_goal||0),pct=_venGoalPercent(seller,perf.sales);
  const profitability=Number(perf.margin||0)-Number(perf.commission||0)-Number(perf.expenses||0);
  const external=_venState.external.filter(x=>Number(x.salesperson_id)===Number(id)&&x.status==='registrada');
  const byDay={};external.forEach(x=>{byDay[x.sale_date]=(byDay[x.sale_date]||0)+Number(x.net_amount||0)});
  const activity=[
    ...external.map(x=>({date:x.sale_date,icon:'receipt',tone:'green',title:`Talonario ${[x.booklet_number,x.receipt_number].filter(Boolean).join('-')}`,detail:`${x.customer_name} · ${_venMoney(x.net_amount)}`})),
    ..._venState.expenses.filter(x=>Number(x.salesperson_id)===Number(id)).map(x=>({date:x.issue_date,icon:'cash',tone:'amber',title:`${x.expense_kind}: ${x.description}`,detail:_venMoney(x.total)})),
    ..._venState.commissions.filter(x=>Number(x.salesperson_id)===Number(id)&&x.status!=='anulado').map(x=>({date:x.date_to,icon:'trend',tone:'purple',title:`Comisión ${x.status}`,detail:_venMoney(x.commission_total)})),
  ].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8);
  const body=window.VeloExperience?.openDrawer?.({id:'seller-profile',title:'Perfil comercial',subtitle:'Rendimiento, meta, rentabilidad y actividad',width:'650px',content:`<section class="ven-profile-hero"><div class="ven-profile-avatar ${seller.seller_type==='ambulante'?'street':''}">${_venInitials(seller.name)}</div><div><small>${_venEsc(seller.code)} · ${seller.seller_type==='ambulante'?'AMBULANTE':'FIJO'}</small><h2>${_venEsc(seller.name)}</h2><p>${_venEsc([seller.zone,seller.route].filter(Boolean).join(' · ')||'Sin zona o ruta asignada')}</p></div><button data-profile-edit>${svg('edit')} Editar</button></section>
    <div class="ven-profile-score"><div class="ven-profile-ring" style="--score:${Math.min(100,pct)}"><span>${goal>0?pct.toFixed(0)+'%':'—'}</span></div><div><small>META DEL PERÍODO</small><strong>${goal>0?`${_venMoney(perf.sales)} de ${_venMoney(goal)}`:'Configura una meta comercial'}</strong><p>${goal>0?(pct>=100?'Meta alcanzada. Excelente desempeño.':`Faltan ${_venMoney(Math.max(0,goal-perf.sales))} para completarla.`):'La meta permite comparar avance y proyectar el cierre.'}</p></div></div>
    <div class="ven-profile-metrics"><div><small>VENTAS</small><strong>${_venMoney(perf.sales)}</strong><span>${perf.salesCount||0} operaciones</span></div><div><small>MARGEN</small><strong>${_venMoney(perf.margin)}</strong><span>${Number(perf.sales)>0?((Number(perf.margin)/Number(perf.sales))*100).toFixed(1):'0.0'}% de venta</span></div><div><small>COMISIÓN</small><strong>${_venMoney(perf.commission)}</strong><span>${_venEsc(_venModeLabel(seller))}</span></div><div><small>RENTABILIDAD</small><strong class="${profitability<0?'risk':''}">${_venMoney(profitability)}</strong><span>margen − comisión − gastos</span></div></div>
    <div class="ven-profile-grid"><section><header><div><small>TENDENCIA AMBULANTE</small><strong>Ventas de talonario por día</strong></div><span>${external.length} recibos</span></header>${_venMiniLine(Object.keys(byDay).sort().map(k=>byDay[k]))}</section><section><header><div><small>OPERACIÓN</small><strong>Zona y contacto</strong></div></header><dl class="ven-profile-data"><div><dt>Teléfono</dt><dd>${_venEsc(seller.phone||'Sin registrar')}</dd></div><div><dt>Talonario</dt><dd>${_venEsc(seller.booklet_code||'Sin asignar')}</dd></div><div><dt>Ubicación</dt><dd>${seller.map_lat!=null&&seller.map_lng!=null?`${Number(seller.map_lat).toFixed(4)}, ${Number(seller.map_lng).toFixed(4)}`:'Aproximada por zona'}</dd></div></dl></section></div>
    <section class="ven-profile-timeline"><header><div><small>LÍNEA DE TIEMPO</small><strong>Actividad documental reciente</strong></div><button data-profile-expense>+ Gasto</button></header>${activity.length?activity.map(x=>`<article class="${x.tone}"><span>${svg(x.icon)}</span><div><small>${_venEsc(x.date)}</small><strong>${_venEsc(x.title)}</strong><p>${_venEsc(x.detail)}</p></div></article>`).join(''):'<div class="ven-profile-nochart">Todavía no hay documentos vinculados en el período.</div>'}</section>`});
  body?.querySelector('[data-profile-edit]')?.addEventListener('click',()=>{window.VeloExperience.closeDrawer();setTimeout(()=>vendedoresOpenSeller(id),180)});
  body?.querySelector('[data-profile-expense]')?.addEventListener('click',()=>{window.VeloExperience.closeDrawer();setTimeout(()=>vendedoresOpenExpense(id),180)});
}

function vendedoresOpenSeller(id=null) {
  const s=_venState.sellers.find(x=>Number(x.id)===Number(id))||{};
  const users=window._cachedUsers||[];
  openModal(`<div class="modal-title">${id?'Editar perfil comercial':'Crear vendedor'}</div>
    <div class="modal-sub">Configura identidad, operación, comisión y compensación en un solo lugar.</div>
    <div class="ven-modal-section"><div class="ven-modal-section-title"><span>1</span> Identidad y contacto</div>
      <div class="g2"><div class="fg"><label class="lbl">Nombre completo *</label><input class="inp" id="ven-name" value="${_venEsc(s.name||'')}" placeholder="Nombre del vendedor"/></div><div class="fg"><label class="lbl">Código interno</label><input class="inp" id="ven-code" value="${_venEsc(s.code||'')}" placeholder="Se genera automáticamente"/></div></div>
      <div class="g3"><div class="fg"><label class="lbl">Documento</label><input class="inp" id="ven-doc" value="${_venEsc(s.document||'')}"/></div><div class="fg"><label class="lbl">Teléfono</label><input class="inp" id="ven-phone" value="${_venEsc(s.phone||'')}"/></div><div class="fg"><label class="lbl">Correo</label><input class="inp" id="ven-email" type="email" value="${_venEsc(s.email||'')}"/></div></div>
      <div class="fg"><label class="lbl">Dirección</label><input class="inp" id="ven-address" value="${_venEsc(s.address||'')}"/></div>
    </div>
    <div class="ven-modal-section"><div class="ven-modal-section-title"><span>2</span> Perfil operativo</div>
      <div class="g2"><div class="fg"><label class="lbl">Tipo de vendedor</label><select class="inp" id="ven-type"><option value="fijo" ${s.seller_type!=='ambulante'?'selected':''}>Fijo / interno</option><option value="ambulante" ${s.seller_type==='ambulante'?'selected':''}>Ambulante / externo</option></select></div><div class="fg"><label class="lbl">Usuario POS vinculado</label><select class="inp" id="ven-user"><option value="">Sin usuario — control administrativo</option>${users.filter(u=>u.active!==0).map(u=>`<option value="${u.id}" ${Number(s.linked_user_id)===Number(u.id)?'selected':''}>${_venEsc(u.name)}</option>`).join('')}</select></div></div>
      <div class="g3"><div class="fg"><label class="lbl">Zona</label><input class="inp" id="ven-zone" value="${_venEsc(s.zone||'')}" placeholder="Ej. Santo Domingo Norte"/></div><div class="fg"><label class="lbl">Ruta</label><input class="inp" id="ven-route" value="${_venEsc(s.route||'')}" placeholder="Ruta o cartera"/></div><div class="fg"><label class="lbl">Talonario</label><input class="inp" id="ven-booklet" value="${_venEsc(s.booklet_code||'')}" placeholder="Serie asignada"/></div></div>
      <div class="g3"><div class="fg"><label class="lbl">Meta de ventas por período</label><input class="inp" id="ven-goal" type="number" min="0" step="0.01" value="${s.sales_goal||0}" placeholder="0.00"/></div><div class="fg"><label class="lbl">Latitud opcional</label><input class="inp" id="ven-lat" type="number" min="-90" max="90" step="0.000001" value="${s.map_lat??''}" placeholder="18.4861"/></div><div class="fg"><label class="lbl">Longitud opcional</label><input class="inp" id="ven-lng" type="number" min="-180" max="180" step="0.000001" value="${s.map_lng??''}" placeholder="-69.9312"/></div></div>
      <div class="fg"><label class="lbl">Fecha de ingreso</label><input class="inp" id="ven-hire" type="date" value="${_venEsc(s.hire_date||_venToday())}"/></div>
      <div class="ven-callout">El usuario POS es opcional. Si se vincula, sus ventas se asignarán automáticamente; un ambulante puede trabajar únicamente con su talonario.</div>
    </div>
    <div class="ven-modal-section"><div class="ven-modal-section-title"><span>3</span> Comisión automática</div>
      <div class="g3"><div class="fg"><label class="lbl">Regla de cálculo</label><select class="inp" id="ven-cmode"><option value="percent_sales" ${s.commission_mode==='percent_sales'?'selected':''}>Porcentaje de venta neta</option><option value="percent_margin" ${s.commission_mode==='percent_margin'?'selected':''}>Porcentaje de margen</option><option value="fixed_sale" ${s.commission_mode==='fixed_sale'?'selected':''}>Monto fijo por venta</option><option value="none" ${s.commission_mode==='none'?'selected':''}>Sin comisión</option></select></div><div class="fg"><label class="lbl">Porcentaje</label><input class="inp" id="ven-rate" type="number" min="0" max="100" step="0.01" value="${s.commission_rate||0}"/></div><div class="fg"><label class="lbl">Monto fijo</label><input class="inp" id="ven-fixed" type="number" min="0" step="0.01" value="${s.commission_fixed||0}"/></div></div>
      <div class="fg"><label class="lbl">Frecuencia del corte</label><select class="inp" id="ven-cfreq">${['semanal','quincenal','mensual'].map(x=>`<option ${s.commission_frequency===x?'selected':''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="ven-modal-section"><div class="ven-modal-section-title"><span>4</span> Nómina y compensación</div>
      <div class="g2"><div class="fg"><label class="lbl">Salario por período</label><input class="inp" id="ven-salary" type="number" min="0" step="0.01" value="${s.salary_amount||0}"/></div><div class="fg"><label class="lbl">Frecuencia de pago</label><select class="inp" id="ven-pfreq">${['semanal','quincenal','mensual'].map(x=>`<option ${s.payroll_frequency===x?'selected':''}>${x}</option>`).join('')}</select></div></div>
      <div class="fg"><label class="lbl">Notas internas</label><textarea class="inp" id="ven-notes" rows="2" placeholder="Condiciones, acuerdos o información administrativa…">${_venEsc(s.notes||'')}</textarea></div>
    </div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresSaveSeller(${id||'null'})">${svg('check')} Guardar perfil</button></div>`, 'modal-lg');
}

async function vendedoresSaveSeller(id) {
  const data={code:document.getElementById('ven-code').value,name:document.getElementById('ven-name').value,seller_type:document.getElementById('ven-type').value,linked_user_id:document.getElementById('ven-user').value,document:document.getElementById('ven-doc').value,phone:document.getElementById('ven-phone').value,email:document.getElementById('ven-email').value,address:document.getElementById('ven-address').value,zone:document.getElementById('ven-zone').value,route:document.getElementById('ven-route').value,booklet_code:document.getElementById('ven-booklet').value,sales_goal:document.getElementById('ven-goal').value,map_lat:document.getElementById('ven-lat').value,map_lng:document.getElementById('ven-lng').value,hire_date:document.getElementById('ven-hire').value,commission_mode:document.getElementById('ven-cmode').value,commission_rate:document.getElementById('ven-rate').value,commission_fixed:document.getElementById('ven-fixed').value,commission_frequency:document.getElementById('ven-cfreq').value,salary_amount:document.getElementById('ven-salary').value,payroll_frequency:document.getElementById('ven-pfreq').value,notes:document.getElementById('ven-notes').value};
  const r=id?await window.api.salespeople.update({id,data,requestUserId:user.id}):await window.api.salespeople.create({data,requestUserId:user.id});
  if(!r?.ok){toast(r?.error||'No se pudo guardar','err');return;}closeModal();toast('✓ Vendedor guardado');renderVendedores(document.getElementById('page'));
}
async function vendedoresToggle(id,active){const r=await window.api.salespeople.toggle({id,active,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}renderVendedores(document.getElementById('page'));}

function vendedoresOpenExternalSale(){if(!_venState.sellers.some(s=>s.status==='activo')){toast('Primero registra un vendedor','w');return;}openModal(`<div class="modal-title">Registrar venta de talonario</div><div class="modal-sub">Venta realizada fuera del POS por un vendedor ambulante</div><div class="g2"><div class="fg"><label class="lbl">Vendedor *</label><select class="inp" id="vex-seller">${_venSellerOptions()}</select></div><div class="fg"><label class="lbl">Fecha *</label><input class="inp" id="vex-date" type="date" value="${_venToday()}"/></div></div><div class="g2"><div class="fg"><label class="lbl">Talonario</label><input class="inp" id="vex-book"/></div><div class="fg"><label class="lbl">Recibo / factura *</label><input class="inp" id="vex-receipt"/></div></div><div class="fg"><label class="lbl">Cliente</label><input class="inp" id="vex-client" value="Consumidor Final"/></div><div class="g3"><div class="fg"><label class="lbl">Venta bruta</label><input class="inp" id="vex-gross" type="number" min="0" step="0.01"/></div><div class="fg"><label class="lbl">Descuento</label><input class="inp" id="vex-discount" type="number" min="0" step="0.01" value="0"/></div><div class="fg"><label class="lbl">Devolución</label><input class="inp" id="vex-return" type="number" min="0" step="0.01" value="0"/></div></div><div class="g2"><div class="fg"><label class="lbl">Costo estimado</label><input class="inp" id="vex-cost" type="number" min="0" step="0.01" value="0"/></div><div class="fg"><label class="lbl">Monto cobrado</label><input class="inp" id="vex-collected" type="number" min="0" step="0.01" placeholder="Igual a venta neta"/></div></div><div class="fg"><label class="lbl">Método</label><select class="inp" id="vex-method">${['efectivo','transferencia','tarjeta','credito','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Notas</label><textarea class="inp" id="vex-notes" rows="2"></textarea></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresSaveExternal()">Registrar</button></div>`);}
async function vendedoresSaveExternal(){const data={salesperson_id:document.getElementById('vex-seller').value,sale_date:document.getElementById('vex-date').value,booklet_number:document.getElementById('vex-book').value,receipt_number:document.getElementById('vex-receipt').value,customer_name:document.getElementById('vex-client').value,gross_amount:document.getElementById('vex-gross').value,discount_amount:document.getElementById('vex-discount').value,return_amount:document.getElementById('vex-return').value,cost_amount:document.getElementById('vex-cost').value,collected_amount:document.getElementById('vex-collected').value||null,payment_method:document.getElementById('vex-method').value,notes:document.getElementById('vex-notes').value};const r=await window.api.salespeople.createExternalSale({data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast('✓ Venta externa registrada');_venTab='externas';renderVendedores(document.getElementById('page'));}
async function vendedoresCancelExternal(id){const reason=await askText('Indica por qué se anula esta venta de talonario.',{title:'Anular venta externa'});if(!reason)return;const r=await window.api.salespeople.cancelExternalSale({id,reason,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}toast('✓ Venta externa anulada');renderVendedores(document.getElementById('page'));}

async function vendedoresOpenCommission(){const seller=_venState.sellers.find(s=>s.status==='activo');if(!seller){toast('No hay vendedores activos','w');return;}const p=await window.api.salespeople.suggestedPeriod({salespersonId:seller.id,asOf:_venToday()});openModal(`<div class="modal-title">Calcular comisión automática</div><div class="modal-sub">El período se propone según la frecuencia del vendedor</div><div class="fg"><label class="lbl">Vendedor</label><select class="inp" id="vco-seller" onchange="vendedoresRefreshPeriod()">${_venSellerOptions(seller.id)}</select></div><div class="g2"><div class="fg"><label class="lbl">Desde</label><input class="inp" id="vco-from" type="date" value="${p?.data?.from||_venMonthStart()}"/></div><div class="fg"><label class="lbl">Hasta</label><input class="inp" id="vco-to" type="date" value="${p?.data?.to||_venToday()}"/></div></div><div id="vco-preview" class="card" style="background:var(--surface2)">Presiona vista previa para calcular.</div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-out" onclick="vendedoresCommissionPreview()">Vista previa</button><button class="btn btn-green" onclick="vendedoresGenerateCommission()">Generar corte</button></div>`);vendedoresCommissionPreview();}
async function vendedoresRefreshPeriod(){const id=document.getElementById('vco-seller').value;const p=await window.api.salespeople.suggestedPeriod({salespersonId:id,asOf:_venToday()});if(p?.ok){document.getElementById('vco-from').value=p.data.from;document.getElementById('vco-to').value=p.data.to;}vendedoresCommissionPreview();}
async function vendedoresCommissionPreview(){const r=await window.api.salespeople.previewCommission({salespersonId:document.getElementById('vco-seller').value,from:document.getElementById('vco-from').value,to:document.getElementById('vco-to').value});const el=document.getElementById('vco-preview');if(!r?.ok){el.innerHTML=`<span style="color:var(--red)">${_venEsc(r.error)}</span>`;return;}const d=r.data;el.innerHTML=`<div class="g3"><div><div class="muted txt-xs">VENTAS</div><strong>${d.salesCount} · ${_venMoney(d.salesTotal)}</strong></div><div><div class="muted txt-xs">MARGEN</div><strong>${_venMoney(d.marginTotal)}</strong></div><div><div class="muted txt-xs">COMISIÓN</div><strong style="color:var(--green)">${_venMoney(d.commissionTotal)}</strong></div></div><div class="txt-xs muted" style="margin-top:8px">Regla: ${_venEsc(_venModeLabel(d.seller))}. Las devoluciones vigentes ya fueron descontadas.</div>`;}
async function vendedoresGenerateCommission(){const data={salespersonId:document.getElementById('vco-seller').value,from:document.getElementById('vco-from').value,to:document.getElementById('vco-to').value};const r=await window.api.salespeople.generateCommission({data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast(`✓ Comisión generada: ${_venMoney(r.data.commissionTotal)}`);_venTab='comisiones';renderVendedores(document.getElementById('page'));}
async function vendedoresApproveCommission(id){const r=await window.api.salespeople.approveCommission({id,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}toast('✓ Comisión aprobada para nómina');renderVendedores(document.getElementById('page'));}

function vendedoresOpenExpense(sellerId=null){if(!_venState.sellers.some(s=>s.status==='activo')){toast('No hay vendedores activos','w');return;}openModal(`<div class="modal-title">Viático o gasto del vendedor</div><div class="modal-sub">Se registrará también en Gastos y Contabilidad</div><div class="g2"><div class="fg"><label class="lbl">Vendedor</label><select class="inp" id="veg-seller">${_venSellerOptions(sellerId)}</select></div><div class="fg"><label class="lbl">Tipo</label><select class="inp" id="veg-kind">${['viatico','combustible','alimentacion','alojamiento','peaje','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div></div><div class="g2"><div class="fg"><label class="lbl">Fecha</label><input class="inp" id="veg-date" type="date" value="${_venToday()}"/></div><div class="fg"><label class="lbl">Monto</label><input class="inp" id="veg-amount" type="number" min="0" step="0.01"/></div></div><div class="fg"><label class="lbl">Descripción</label><input class="inp" id="veg-desc" placeholder="Ruta, visita, motivo…"/></div><div class="g2"><div class="fg"><label class="lbl">Método</label><select class="inp" id="veg-method">${['efectivo','transferencia','tarjeta','cheque','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div><div class="fg"><label class="lbl">Origen</label><select class="inp" id="veg-source"><option value="caja_chica">Caja chica</option><option value="caja">Caja abierta</option><option value="banco">Banco</option><option value="pendiente">Pendiente de pago</option></select></div></div><label style="display:flex;gap:8px;align-items:center"><input id="veg-pay" type="checkbox" checked/> Pagar ahora</label><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresSaveExpense()">Registrar</button></div>`);}
async function vendedoresSaveExpense(){const data={salespersonId:document.getElementById('veg-seller').value,kind:document.getElementById('veg-kind').value,issue_date:document.getElementById('veg-date').value,amount:document.getElementById('veg-amount').value,description:document.getElementById('veg-desc').value,payment_method:document.getElementById('veg-method').value,payment_source:document.getElementById('veg-source').value,pay_now:document.getElementById('veg-pay').checked};if(data.payment_source==='pendiente')data.pay_now=false;const r=await window.api.salespeople.createExpense({data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast('✓ Gasto del vendedor registrado');_venTab='viaticos';renderVendedores(document.getElementById('page'));}

function vendedoresOpenPayroll(){const p=_venPeriod('mensual');openModal(`<div class="modal-title">Generar nómina</div><div class="modal-sub">Incluye solo salarios y comisiones aprobadas de la frecuencia elegida</div><div class="fg"><label class="lbl">Frecuencia</label><select class="inp" id="vno-frequency" onchange="vendedoresPayrollPeriodChange()"><option value="semanal">Semanal</option><option value="quincenal">Quincenal</option><option value="mensual" selected>Mensual</option></select></div><div class="g2"><div class="fg"><label class="lbl">Desde</label><input class="inp" id="vno-from" type="date" value="${p.from}"/></div><div class="fg"><label class="lbl">Hasta</label><input class="inp" id="vno-to" type="date" value="${p.to}"/></div></div><div class="card" style="background:var(--surface2);font-size:11px;color:var(--muted)">El sistema evita duplicar la misma nómina y separa pagos semanales, quincenales y mensuales.</div><div class="fg"><label class="lbl">Notas</label><textarea class="inp" id="vno-notes" rows="2"></textarea></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="vendedoresGeneratePayroll()">Generar borrador</button></div>`);}
function vendedoresPayrollPeriodChange(){const p=_venPeriod(document.getElementById('vno-frequency').value);document.getElementById('vno-from').value=p.from;document.getElementById('vno-to').value=p.to;}
async function vendedoresGeneratePayroll(){const data={frequency:document.getElementById('vno-frequency').value,from:document.getElementById('vno-from').value,to:document.getElementById('vno-to').value,notes:document.getElementById('vno-notes').value};const r=await window.api.salespeople.generatePayroll({data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast('✓ Borrador de nómina generado');_venTab='nomina';renderVendedores(document.getElementById('page'));}
async function vendedoresViewPayroll(id){
  const r=await window.api.salespeople.getPayrollById({id});
  if(!r?.ok||!r.data){toast(r?.error||'Nómina no encontrada','err');return;}
  const run=r.data;
  const items=run.items||[];
  openModal(`<div class="modal-title">Detalle de ${_venEsc(run.number)}</div>
    <div class="modal-sub">${_venEsc(run.date_from)} al ${_venEsc(run.date_to)} · ${_venEsc(run.frequency||'mensual')} · ${_venBadge(run.status)}</div>
    <div class="ven-metrics" style="grid-template-columns:repeat(4,1fr);margin:14px 0">
      <div class="ven-metric"><div class="ven-metric-label">Salario base</div><div class="ven-metric-value" style="font-size:17px">${_venMoney(run.base_total)}</div></div>
      <div class="ven-metric"><div class="ven-metric-label">Comisiones</div><div class="ven-metric-value" style="font-size:17px;color:var(--purple)">${_venMoney(run.commission_total)}</div></div>
      <div class="ven-metric"><div class="ven-metric-label">Ajustes netos</div><div class="ven-metric-value" style="font-size:17px">${_venMoney(Number(run.bonus_total||0)-Number(run.deduction_total||0))}</div></div>
      <div class="ven-metric"><div class="ven-metric-label">Total a pagar</div><div class="ven-metric-value" style="font-size:17px;color:var(--green)">${_venMoney(run.net_total)}</div></div>
    </div>
    <div class="ven-panel" style="box-shadow:none"><div class="tw"><table><thead><tr><th>Vendedor</th><th style="text-align:right">Salario</th><th style="text-align:right">Comisión</th><th style="text-align:right">Bono</th><th style="text-align:right">Deducción</th><th style="text-align:right">Neto</th></tr></thead><tbody>
      ${items.map(i=>`<tr><td><div class="ven-person"><div class="ven-avatar ${i.seller_type==='ambulante'?'street':''}">${_venInitials(i.salesperson_name)}</div><div><div class="ven-person-name">${_venEsc(i.salesperson_name)}</div><div class="ven-person-meta">${_venEsc(i.code)} · ${_venEsc(i.seller_type)}</div></div></div></td><td style="text-align:right" class="ven-money">${_venMoney(i.base_salary)}</td><td style="text-align:right" class="ven-money">${_venMoney(i.commission_amount)}</td><td style="text-align:right">${run.status==='borrador'?`<input class="inp" data-pay-bonus="${i.id}" type="number" min="0" step="0.01" value="${i.bonus_amount}" style="width:100px;text-align:right">`:_venMoney(i.bonus_amount)}</td><td style="text-align:right">${run.status==='borrador'?`<input class="inp" data-pay-ded="${i.id}" type="number" min="0" step="0.01" value="${i.deduction_amount}" style="width:100px;text-align:right">`:_venMoney(i.deduction_amount)}</td><td style="text-align:right;font-weight:850;color:var(--green)" class="ven-money">${_venMoney(i.net_amount)}</td></tr>`).join('')}
    </tbody></table></div></div>
    ${run.status==='borrador'?'<div class="ven-callout" style="margin-top:12px">Puedes ajustar bonos y deducciones. El total se recalculará al guardar.</div>':''}
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button>${run.status==='borrador'?`<button class="btn btn-green" onclick="vendedoresSavePayrollItems(${run.id})">${svg('check')} Guardar ajustes</button>`:''}</div>`, 'modal-lg');
}
async function vendedoresSavePayrollItems(runId){const bonuses=[...document.querySelectorAll('[data-pay-bonus]')];for(const b of bonuses){const id=b.dataset.payBonus;const ded=document.querySelector(`[data-pay-ded="${id}"]`);const r=await window.api.salespeople.updatePayrollItem({id,data:{bonusAmount:b.value,deductionAmount:ded?.value||0},requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}}closeModal();toast('✓ Ajustes guardados');renderVendedores(document.getElementById('page'));}
async function vendedoresApprovePayroll(id){const r=await window.api.salespeople.approvePayroll({id,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}toast('✓ Nómina aprobada');renderVendedores(document.getElementById('page'));}
function vendedoresPayPayroll(id){openModal(`<div class="modal-title">Pagar nómina</div><div class="modal-sub">Creará y pagará un gasto por cada vendedor</div><div class="g2"><div class="fg"><label class="lbl">Fecha</label><input class="inp" id="vpay-date" type="date" value="${_venToday()}"/></div><div class="fg"><label class="lbl">Método</label><select class="inp" id="vpay-method">${['efectivo','transferencia','cheque','otro'].map(x=>`<option>${x}</option>`).join('')}</select></div></div><div class="fg"><label class="lbl">Origen del pago</label><select class="inp" id="vpay-source"><option value="caja_chica">Caja chica</option><option value="caja">Caja abierta</option><option value="banco">Banco</option></select></div><div class="fg"><label class="lbl">Referencia</label><input class="inp" id="vpay-ref"/></div><div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-dark" onclick="vendedoresConfirmPayrollPay(${id})">Confirmar pago</button></div>`);}
async function vendedoresConfirmPayrollPay(id){const data={payment_date:document.getElementById('vpay-date').value,payment_method:document.getElementById('vpay-method').value,payment_source:document.getElementById('vpay-source').value,reference:document.getElementById('vpay-ref').value};const r=await window.api.salespeople.payPayroll({id,data,requestUserId:user.id});if(!r?.ok){toast(r.error,'err');return;}closeModal();toast(`✓ Nómina pagada · ${r.paid} gasto(s) generado(s)`);renderVendedores(document.getElementById('page'));}
