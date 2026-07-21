// ════════════════════════════════════════════════════════════════════════════
// nomina.js — Salarios, ajustes, períodos y pagos del equipo
// ════════════════════════════════════════════════════════════════════════════

let _nomTab = 'resumen';
let _nomState = { sellers: [], commissions: [], payroll: [] };
let _nomQuery = '';

function _nomEsc(value) {
  return String(value == null ? '' : value).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function _nomMoney(value) {
  return typeof fmt === 'function' ? fmt(Number(value) || 0) : `RD$${(Number(value) || 0).toFixed(2)}`;
}
function _nomToday() {
  if (typeof today === 'function') return today();
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _nomPeriod(frequency, dateText = _nomToday()) {
  const d = new Date(`${dateText}T12:00:00`), y = d.getFullYear(), m = d.getMonth();
  const format = x => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
  let from, to;
  if (frequency === 'semanal') {
    const offset = (d.getDay()+6)%7;
    from = new Date(y,m,d.getDate()-offset);
    to = new Date(from.getFullYear(),from.getMonth(),from.getDate()+6);
  } else if (frequency === 'quincenal') {
    from = new Date(y,m,d.getDate()<=15?1:16);
    to = d.getDate()<=15 ? new Date(y,m,15) : new Date(y,m+1,0);
  } else {
    from = new Date(y,m,1);
    to = new Date(y,m+1,0);
  }
  return { from:format(from), to:format(to) };
}
function _nomInitials(name) {
  return String(name || 'N').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();
}
function _nomBadge(status) {
  const normalized = String(status || '');
  const cls = ['activo','aprobado','pagado'].includes(normalized) ? 'g' : normalized === 'borrador' ? 'a' : 'n';
  return `<span class="badge ${cls}">${_nomEsc(normalized.replaceAll('_',' '))}</span>`;
}
function _nomFrequency(value) {
  return value === 'semanal' ? 'Semanal' : value === 'quincenal' ? 'Quincenal' : 'Mensual';
}
function _nomEmpty(icon, title, text, actionLabel = '', action = '') {
  return `<div class="ven-empty"><div class="ven-empty-icon">${svg(icon)}</div><h3>${_nomEsc(title)}</h3><p>${_nomEsc(text)}</p>
    ${actionLabel ? `<button class="btn btn-green btn-sm" onclick="${action}">${svg('plus')} ${_nomEsc(actionLabel)}</button>` : ''}</div>`;
}

async function renderNomina(el) {
  if (!['admin','superadmin'].includes(user?.role)) { routeTo('dash'); return; }
  el.innerHTML = `<div class="nom-shell"><div class="ven-panel">${_nomEmpty('clock','Preparando Nómina','Organizando salarios, comisiones y períodos de pago…')}</div></div>`;
  const [sellers, commissions, payroll] = await Promise.all([
    window.api.salespeople.getAll({}),
    window.api.salespeople.getCommissionRuns({}),
    window.api.salespeople.getPayrollRuns({}),
  ]);
  _nomState = {
    sellers: sellers?.data || [],
    commissions: commissions?.data || [],
    payroll: payroll?.data || [],
  };
  _nomRender(el);
}

function _nomSetTab(tab) {
  _nomTab = tab;
  _nomQuery = '';
  _nomRender();
}

function _nomRender(el = document.getElementById('page')) {
  if (!el) return;
  const drafts = _nomState.payroll.filter(x=>x.status==='borrador').length;
  const tabs = [
    ['resumen','grid','Resumen',''],
    ['periodos','calendar','Períodos',_nomState.payroll.length],
    ['compensacion','users','Salarios',_nomState.sellers.filter(x=>x.status==='activo').length],
    ['flujo','trend','Flujo',drafts],
  ];
  el.innerHTML = `<div class="nom-shell">
    <section class="nom-hero">
      <div class="nom-hero-main"><div><div class="nom-eyebrow"><span></span> Salarios y pagos del equipo</div>
        <h1>Nómina</h1><p>Administra salarios base, bonos, deducciones, períodos y pagos; recibe comisiones únicamente después de su aprobación.</p></div>
        <div class="nom-actions"><button class="btn btn-out" onclick="routeTo('comisiones')">${svg('trend')} Ir a Comisiones</button><button class="btn btn-green" onclick="nominaOpenPayroll()">${svg('plus')} Generar nómina</button></div>
      </div>
      <div class="nom-hero-foot"><span>${svg('check')} Las comisiones entran únicamente después de ser aprobadas</span><span>${svg('receipt')} Cada pago genera sus gastos y registros contables</span></div>
    </section>
    <nav class="nom-nav">${tabs.map(([key,icon,label,count])=>`<button class="nom-nav-btn ${_nomTab===key?'on':''}" onclick="_nomSetTab('${key}')">${svg(icon)}<span>${label}</span>${count!==''?`<b>${count}</b>`:''}</button>`).join('')}</nav>
    <div id="nom-content"></div>
  </div>`;
  const content = document.getElementById('nom-content');
  if (_nomTab === 'resumen') _nomRenderSummary(content);
  if (_nomTab === 'periodos') _nomRenderPeriods(content);
  if (_nomTab === 'compensacion') _nomRenderCompensation(content);
  if (_nomTab === 'flujo') _nomRenderFlow(content);
}

function _nomRenderSummary(el) {
  const active = _nomState.sellers.filter(x=>x.status==='activo');
  const compensated = active.filter(x=>Number(x.salary_amount||0)>0);
  const approvedCommissions = _nomState.commissions.filter(x=>x.status==='aprobado' && !x.payroll_run_id);
  const openRuns = _nomState.payroll.filter(x=>x.status!=='pagado');
  const paid = _nomState.payroll.filter(x=>x.status==='pagado');
  const pendingCommissionTotal = approvedCommissions.reduce((sum,x)=>sum+Number(x.commission_total||0),0);
  const openTotal = openRuns.reduce((sum,x)=>sum+Number(x.net_total||0),0);
  const paidTotal = paid.reduce((sum,x)=>sum+Number(x.net_total||0),0);
  const metric = (icon,tone,label,value,note)=>`<article class="nom-metric"><div class="nom-metric-icon ${tone}">${svg(icon)}</div><div><label>${label}</label><strong>${value}</strong><span>${note}</span></div></article>`;
  const recent = _nomState.payroll.slice(0,5);
  el.innerHTML = `<div class="nom-metrics">
    ${metric('users','blue','Personal con salario',compensated.length,`${active.length} personas activas`)}
    ${metric('trend','purple','Comisión disponible',_nomMoney(pendingCommissionTotal),`${approvedCommissions.length} ${approvedCommissions.length===1?'corte aprobado':'cortes aprobados'}`)}
    ${metric('clock','amber','Nómina en proceso',_nomMoney(openTotal),`${openRuns.length} períodos abiertos`)}
    ${metric('check','green','Pagado históricamente',_nomMoney(paidTotal),`${paid.length} ${paid.length===1?'nómina completada':'nóminas completadas'}`)}
  </div>
  <div class="nom-dashboard-grid">
    <section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('calendar')} Actividad reciente</div><div class="ven-panel-sub">Últimos períodos de nómina creados</div></div><button class="btn btn-out btn-sm" onclick="_nomSetTab('periodos')">Ver todos</button></div>
      ${recent.length ? _nomPayrollTable(recent, false) : _nomEmpty('calendar','Todavía no hay períodos de nómina','Configura la compensación y genera el primer borrador.','Generar primera nómina','nominaOpenPayroll()')}
    </section>
    <aside class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('alert')} Ruta de pago</div><div class="ven-panel-sub">Un proceso claro y auditable</div></div></div>
      <div class="nom-steps"><button onclick="_nomSetTab('compensacion')"><i>1</i><div><strong>Configura el salario</strong><span>Monto base y frecuencia para cada persona.</span></div></button><button onclick="nominaOpenPayroll()"><i>2</i><div><strong>Genera el borrador</strong><span>Importa las comisiones ya aprobadas.</span></div></button><button onclick="_nomSetTab('periodos')"><i>3</i><div><strong>Revisa y aprueba</strong><span>Ajusta bonos o deducciones antes de cerrar.</span></div></button><button onclick="_nomSetTab('flujo')"><i>4</i><div><strong>Paga y contabiliza</strong><span>El sistema conecta Gastos y Contabilidad.</span></div></button></div>
    </aside>
  </div>`;
}

function _nomPayrollTable(rows, showActions = true) {
  return `<div class="tw"><table><thead><tr><th>Número / período</th><th>Frecuencia</th><th style="text-align:right">Salario</th><th style="text-align:right">Comisiones</th><th style="text-align:right">Neto</th><th>Estado</th>${showActions?'<th></th>':''}</tr></thead><tbody>
    ${rows.map(run=>`<tr class="ven-click-row" onclick="nominaViewPayroll(${run.id})"><td><strong>${_nomEsc(run.number)}</strong><div class="txt-xs muted">${_nomEsc(run.date_from)} al ${_nomEsc(run.date_to)}</div></td><td>${_nomFrequency(run.frequency)}</td><td style="text-align:right" class="ven-money">${_nomMoney(run.base_total)}</td><td style="text-align:right" class="ven-money">${_nomMoney(run.commission_total)}</td><td style="text-align:right;font-weight:850" class="ven-money">${_nomMoney(run.net_total)}</td><td>${_nomBadge(run.status)}</td>${showActions?`<td onclick="event.stopPropagation()"><div class="flex">${run.status==='borrador'?`<button class="btn btn-out btn-sm" onclick="nominaApprovePayroll(${run.id})">Aprobar</button>`:''}${run.status==='aprobado'?`<button class="btn btn-green btn-sm" onclick="nominaPayPayroll(${run.id})">Pagar</button>`:''}<button class="btn btn-ghost btn-sm" onclick="nominaViewPayroll(${run.id})">${svg('eye')}</button></div></td>`:''}</tr>`).join('')}
  </tbody></table></div>`;
}

function _nomRenderPeriods(el) {
  el.innerHTML = `<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('calendar')} Períodos de nómina</div><div class="ven-panel-sub">Borradores, aprobaciones y pagos del equipo</div></div><button class="btn btn-green btn-sm" onclick="nominaOpenPayroll()">${svg('plus')} Generar</button></div>
    <div class="nom-summary-strip"><span><b>${_nomState.payroll.filter(x=>x.status==='borrador').length}</b> borradores</span><span><b>${_nomState.payroll.filter(x=>x.status==='aprobado').length}</b> listos para pagar</span><span><b>${_nomState.payroll.filter(x=>x.status==='pagado').length}</b> pagados</span></div>
    ${_nomState.payroll.length ? _nomPayrollTable(_nomState.payroll) : _nomEmpty('calendar','No existen nóminas todavía','Genera un borrador semanal, quincenal o mensual.','Generar nómina','nominaOpenPayroll()')}
  </section>`;
}

function _nomRenderCompensation(el) {
  const sellers = _nomState.sellers.filter(s=>s.status==='activo' && (!_nomQuery || `${s.name} ${s.code} ${s.seller_type}`.toLowerCase().includes(_nomQuery.toLowerCase())));
  const cards = sellers.map(s=>{
    const commission = _nomState.commissions.filter(x=>Number(x.salesperson_id)===Number(s.id) && x.status==='aprobado' && !x.payroll_run_id).reduce((sum,x)=>sum+Number(x.commission_total||0),0);
    return `<article class="nom-person-card"><div class="nom-person-head"><div class="ven-person"><div class="ven-avatar ${s.seller_type==='ambulante'?'street':''}">${_nomInitials(s.name)}</div><div><div class="ven-person-name">${_nomEsc(s.name)}</div><div class="ven-person-meta">${_nomEsc(s.code)} · ${s.seller_type==='ambulante'?'Ambulante':'Fijo'}</div></div></div><span class="badge g">Activo</span></div>
      <div class="nom-person-values"><div><label>Salario por período</label><strong>${_nomMoney(s.salary_amount)}</strong></div><div><label>Frecuencia de pago</label><strong>${_nomFrequency(s.payroll_frequency)}</strong></div><div><label>Comisión aprobada</label><strong class="green">${_nomMoney(commission)}</strong></div></div>
      <div class="nom-person-foot"><span>${Number(s.salary_amount||0)>0?`${svg('check')} Salario configurado`:`${svg('alert')} Sin salario base`}</span><button class="btn btn-out btn-sm" onclick="nominaOpenCompensation(${s.id})">${svg('edit')} Configurar</button></div></article>`;
  }).join('');
  el.innerHTML = `<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('users')} Salarios base del equipo</div><div class="ven-panel-sub">Aquí se configura el salario; las reglas comerciales pertenecen a Comisiones.</div></div><button class="btn btn-out btn-sm" onclick="routeTo('comisiones')">Administrar comisiones</button></div>
    <div class="ven-panel-body"><div class="ven-toolbar"><div class="ven-search">${svg('search')}<input value="${_nomEsc(_nomQuery)}" oninput="_nomQuery=this.value;_nomRenderCompensation(document.getElementById('nom-content'))" placeholder="Buscar persona…"/></div><span class="badge b">${sellers.length} personas</span></div>
      <div class="nom-person-grid">${cards || _nomEmpty('users','No hay vendedores activos','Crea o activa un vendedor desde el módulo comercial.')}</div></div>
  </section>`;
}

function _nomRenderFlow(el) {
  const columns = [
    ['borrador','Borrador','Requiere revisión'],
    ['aprobado','Aprobada','Lista para pagar'],
    ['pagado','Pagada','Proceso completado'],
  ];
  el.innerHTML = `<section class="ven-panel"><div class="ven-panel-head"><div><div class="ven-panel-title">${svg('trend')} Flujo de nómina</div><div class="ven-panel-sub">Seguimiento visual desde el cálculo hasta la contabilización</div></div><button class="btn btn-green btn-sm" onclick="nominaOpenPayroll()">${svg('plus')} Nuevo período</button></div>
    <div class="ven-panel-body"><div class="ven-kanban">${columns.map(([status,title,sub])=>{const runs=_nomState.payroll.filter(x=>x.status===status);return `<div class="ven-kanban-col"><div class="ven-kanban-head"><div><strong>${title}</strong><span>${sub}</span></div><b>${runs.length}</b></div><div class="ven-kanban-list">${runs.map(run=>`<article class="ven-kanban-card" onclick="nominaViewPayroll(${run.id})"><div class="flex between"><strong>${_nomEsc(run.number)}</strong>${_nomBadge(run.status)}</div><div class="txt-xs muted" style="margin-top:6px">${_nomEsc(run.date_from)} — ${_nomEsc(run.date_to)}</div><div class="ven-kanban-amount">${_nomMoney(run.net_total)}</div><div class="ven-kanban-foot"><span>${_nomFrequency(run.frequency)}</span>${status==='borrador'?`<button onclick="event.stopPropagation();nominaApprovePayroll(${run.id})">Aprobar</button>`:status==='aprobado'?`<button onclick="event.stopPropagation();nominaPayPayroll(${run.id})">Pagar</button>`:'<span>Contabilizada</span>'}</div></article>`).join('') || '<div class="ven-kanban-empty">Sin registros</div>'}</div></div>`}).join('')}</div></div>
  </section>`;
}

function nominaOpenCompensation(id) {
  const seller = _nomState.sellers.find(x=>Number(x.id)===Number(id));
  if (!seller) return;
  openModal(`<div class="modal-title">Salario base de ${_nomEsc(seller.name)}</div><div class="modal-sub">Define únicamente el monto periódico. Las reglas y liquidaciones se administran en Comisiones.</div>
    <div class="nom-comp-preview"><div class="ven-avatar ${seller.seller_type==='ambulante'?'street':''}">${_nomInitials(seller.name)}</div><div><strong>${_nomEsc(seller.code)} · ${seller.seller_type==='ambulante'?'Ambulante':'Fijo'}</strong><span>La comisión aprobada se sumará automáticamente cuando coincida la frecuencia.</span></div></div>
    <div class="g2"><div class="fg"><label class="lbl">Salario por período</label><input class="inp" id="nom-salary" type="number" min="0" step="0.01" value="${Number(seller.salary_amount||0)}"/><small class="ven-field-help">Usa 0 si trabaja únicamente por comisión.</small></div><div class="fg"><label class="lbl">Frecuencia de pago</label><select class="inp" id="nom-frequency">${['semanal','quincenal','mensual'].map(x=>`<option value="${x}" ${seller.payroll_frequency===x?'selected':''}>${_nomFrequency(x)}</option>`).join('')}</select></div></div>
    <div class="ven-callout">Los viáticos no se descuentan del salario: se registran como gastos operativos separados y conservan su propia trazabilidad.</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="nominaSaveCompensation(${seller.id})">${svg('check')} Guardar salario</button></div>`);
}

async function nominaSaveCompensation(id) {
  const seller = _nomState.sellers.find(x=>Number(x.id)===Number(id));
  if (!seller) return;
  const data = { ...seller, salary_amount:document.getElementById('nom-salary').value, payroll_frequency:document.getElementById('nom-frequency').value };
  const result = await window.api.salespeople.update({ id, data, requestUserId:user.id });
  if (!result?.ok) { toast(result?.error || 'No se pudo guardar la compensación','err'); return; }
  closeModal(); toast('✓ Salario base actualizado'); await renderNomina(document.getElementById('page'));
}

function nominaOpenPayroll() {
  const period = _nomPeriod('mensual');
  openModal(`<div class="modal-title">Generar nómina</div><div class="modal-sub">El borrador incluirá al personal activo de la frecuencia seleccionada</div>
    <div class="fg"><label class="lbl">Frecuencia</label><select class="inp" id="nom-pay-frequency" onchange="nominaPayrollPeriodChange()"><option value="semanal">Semanal</option><option value="quincenal">Quincenal</option><option value="mensual" selected>Mensual</option></select></div>
    <div class="g2"><div class="fg"><label class="lbl">Desde</label><input class="inp" id="nom-pay-from" type="date" value="${period.from}"/></div><div class="fg"><label class="lbl">Hasta</label><input class="inp" id="nom-pay-to" type="date" value="${period.to}"/></div></div>
    <div class="nom-rule-box"><strong>${svg('trend')} Automatización incluida</strong><span>Se suman las comisiones aprobadas de la misma frecuencia y se evita duplicar un período ya generado.</span></div>
    <div class="fg"><label class="lbl">Notas internas</label><textarea class="inp" id="nom-pay-notes" rows="2" placeholder="Observaciones opcionales…"></textarea></div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="nominaGeneratePayroll()">${svg('plus')} Generar borrador</button></div>`);
}

function nominaPayrollPeriodChange() {
  const period = _nomPeriod(document.getElementById('nom-pay-frequency').value);
  document.getElementById('nom-pay-from').value = period.from;
  document.getElementById('nom-pay-to').value = period.to;
}

async function nominaGeneratePayroll() {
  const data = { frequency:document.getElementById('nom-pay-frequency').value, from:document.getElementById('nom-pay-from').value, to:document.getElementById('nom-pay-to').value, notes:document.getElementById('nom-pay-notes').value };
  const result = await window.api.salespeople.generatePayroll({ data, requestUserId:user.id });
  if (!result?.ok) { toast(result?.error || 'No se pudo generar la nómina','err'); return; }
  closeModal(); toast('✓ Borrador de nómina generado'); _nomTab='periodos'; await renderNomina(document.getElementById('page'));
}

async function nominaViewPayroll(id) {
  const result = await window.api.salespeople.getPayrollById({ id });
  if (!result?.ok || !result.data) { toast(result?.error || 'Nómina no encontrada','err'); return; }
  const run = result.data, items = run.items || [];
  openModal(`<div class="modal-title">Detalle de ${_nomEsc(run.number)}</div><div class="modal-sub">${_nomEsc(run.date_from)} al ${_nomEsc(run.date_to)} · ${_nomFrequency(run.frequency)} · ${_nomBadge(run.status)}</div>
    <div class="nom-detail-metrics"><div><label>Salario base</label><strong>${_nomMoney(run.base_total)}</strong></div><div><label>Comisiones</label><strong class="purple">${_nomMoney(run.commission_total)}</strong></div><div><label>Ajustes netos</label><strong>${_nomMoney(Number(run.bonus_total||0)-Number(run.deduction_total||0))}</strong></div><div><label>Total a pagar</label><strong class="green">${_nomMoney(run.net_total)}</strong></div></div>
    <div class="ven-panel" style="box-shadow:none"><div class="tw"><table><thead><tr><th>Persona</th><th style="text-align:right">Salario</th><th style="text-align:right">Comisión</th><th style="text-align:right">Bono</th><th style="text-align:right">Deducción</th><th style="text-align:right">Neto</th></tr></thead><tbody>
      ${items.map(item=>`<tr><td><div class="ven-person"><div class="ven-avatar ${item.seller_type==='ambulante'?'street':''}">${_nomInitials(item.salesperson_name)}</div><div><div class="ven-person-name">${_nomEsc(item.salesperson_name)}</div><div class="ven-person-meta">${_nomEsc(item.code)} · ${_nomEsc(item.seller_type)}</div></div></div></td><td style="text-align:right" class="ven-money">${_nomMoney(item.base_salary)}</td><td style="text-align:right" class="ven-money">${_nomMoney(item.commission_amount)}</td><td style="text-align:right">${run.status==='borrador'?`<input class="inp" data-nom-bonus="${item.id}" type="number" min="0" step="0.01" value="${item.bonus_amount}" style="width:100px;text-align:right">`:_nomMoney(item.bonus_amount)}</td><td style="text-align:right">${run.status==='borrador'?`<input class="inp" data-nom-deduction="${item.id}" type="number" min="0" step="0.01" value="${item.deduction_amount}" style="width:100px;text-align:right">`:_nomMoney(item.deduction_amount)}</td><td style="text-align:right;font-weight:850;color:var(--green)" class="ven-money">${_nomMoney(item.net_amount)}</td></tr>`).join('')}
    </tbody></table></div></div>
    ${run.status==='borrador'?'<div class="ven-callout" style="margin-top:12px">Puedes ajustar bonos y deducciones. El total se recalculará al guardar.</div>':''}
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button>${run.status==='borrador'?`<button class="btn btn-green" onclick="nominaSavePayrollItems(${run.id})">${svg('check')} Guardar ajustes</button>`:''}</div>`, 'modal-lg');
}

async function nominaSavePayrollItems() {
  const bonuses = [...document.querySelectorAll('[data-nom-bonus]')];
  for (const input of bonuses) {
    const id = input.dataset.nomBonus;
    const deduction = document.querySelector(`[data-nom-deduction="${id}"]`);
    const result = await window.api.salespeople.updatePayrollItem({ id, data:{ bonusAmount:input.value, deductionAmount:deduction?.value||0 }, requestUserId:user.id });
    if (!result?.ok) { toast(result?.error || 'No se pudieron guardar los ajustes','err'); return; }
  }
  closeModal(); toast('✓ Ajustes guardados'); await renderNomina(document.getElementById('page'));
}

async function nominaApprovePayroll(id) {
  const result = await window.api.salespeople.approvePayroll({ id, requestUserId:user.id });
  if (!result?.ok) { toast(result?.error || 'No se pudo aprobar la nómina','err'); return; }
  toast('✓ Nómina aprobada y lista para pagar'); await renderNomina(document.getElementById('page'));
}

function nominaPayPayroll(id) {
  openModal(`<div class="modal-title">Pagar nómina</div><div class="modal-sub">Se generará un gasto pagado por cada persona y su movimiento contable correspondiente.</div>
    <div class="g2"><div class="fg"><label class="lbl">Fecha de pago</label><input class="inp" id="nom-payment-date" type="date" value="${_nomToday()}"/></div><div class="fg"><label class="lbl">Método</label><select class="inp" id="nom-payment-method">${['efectivo','transferencia','cheque','otro'].map(x=>`<option value="${x}">${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div></div>
    <div class="fg"><label class="lbl">Origen del pago</label><select class="inp" id="nom-payment-source"><option value="caja_chica">Caja chica</option><option value="caja">Caja abierta</option><option value="banco">Banco</option></select></div>
    <div class="fg"><label class="lbl">Referencia</label><input class="inp" id="nom-payment-reference" placeholder="Transferencia, cheque u observación…"/></div>
    <div class="ven-callout">Esta acción cierra el período. Los pagos quedarán visibles en Gastos y Contabilidad.</div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cancelar</button><button class="btn btn-green" onclick="nominaConfirmPayrollPay(${id})">${svg('check')} Confirmar pago</button></div>`);
}

async function nominaConfirmPayrollPay(id) {
  const data = { payment_date:document.getElementById('nom-payment-date').value, payment_method:document.getElementById('nom-payment-method').value, payment_source:document.getElementById('nom-payment-source').value, reference:document.getElementById('nom-payment-reference').value };
  const result = await window.api.salespeople.payPayroll({ id, data, requestUserId:user.id });
  if (!result?.ok) { toast(result?.error || 'No se pudo completar el pago','err'); return; }
  closeModal(); toast(`✓ Nómina pagada · ${result.paid} gasto(s) generado(s)`); await renderNomina(document.getElementById('page'));
}
