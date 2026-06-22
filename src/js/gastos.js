// ══════════════════════════════════════════════
// gastos.js — Módulo Gastos y Cuentas por Pagar
// VeloPOS v1.5.2
// ══════════════════════════════════════════════

// ── Estado local del módulo ───────────────────
let _gastosTab   = 'resumen';
let _gastosFiltro = {};
let _categorias  = [];
let _config      = {};

// Leer usuario igual que todos los módulos en Velo POS:
// 'user' es var del scope de app.js, pero también accesible como
// cierre en módulos cargados en el mismo HTML. Como fallback,
// leer de sessionStorage (mismo que usa app.js).
function _getUser() {
  // window._currentUser lo asigna app.js al hacer login o restaurar sesión
  if (window._currentUser) return window._currentUser;
  // Fallback: sessionStorage (por si acaso)
  try {
    const saved = sessionStorage.getItem('vp_user');
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
}

// ── Utilitarios ───────────────────────────────
const _gFmt = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _gFmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('es-DO', { day:'2-digit', month:'short', year:'numeric' }) : '—';
const _gToday = () => new Date().toISOString().split('T')[0];
const _gThisMonth = () => _gToday().slice(0,7);

const STATUS_LABEL = {
  borrador:             { t:'Borrador',              c:'var(--muted2)' },
  pendiente_aprobacion: { t:'Pend. Aprobación',      c:'var(--amber,#f59e0b)' },
  aprobado:             { t:'Aprobado',               c:'var(--blue,#3b82f6)' },
  pendiente_pago:       { t:'Pendiente de pago',      c:'var(--amber,#f59e0b)' },
  parcialmente_pagado:  { t:'Parcial',                c:'var(--blue,#3b82f6)' },
  pagado:               { t:'Pagado',                 c:'var(--green,#00c07a)' },
  anulado:              { t:'Anulado',                c:'var(--red,#ef4444)' },
  rechazado:            { t:'Rechazado',              c:'var(--red,#ef4444)' },
};

function badge(status) {
  const s = STATUS_LABEL[status] || { t: status, c: 'var(--muted2)' };
  return `<span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${s.c}22;color:${s.c};font-weight:600">${s.t}</span>`;
}

function daysLabel(days) {
  if (!days && days !== 0) return '';
  if (days < 0) return `<span style="color:var(--red,#ef4444);font-size:11px;font-weight:600">${Math.abs(Math.round(days))}d vencida</span>`;
  if (days <= 5) return `<span style="color:var(--amber,#f59e0b);font-size:11px;font-weight:600">Vence en ${Math.round(days)}d</span>`;
  return `<span style="color:var(--muted2);font-size:11px">${Math.round(days)}d</span>`;
}

// ── Render principal ──────────────────────────
async function renderGastos(el) {
  // ── Limpiar DOM PRIMERO antes de cualquier await ──────────────
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Cargando módulo de gastos...</div>';

  const user = _getUser();
  if (!user) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Sesión no disponible. Recarga la aplicación.</div>';
    return;
  }

  // Verificar que el API de gastos esté disponible
  if (!window.api?.expenses) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red,#ef4444)">El módulo de gastos requiere reiniciar la aplicación para activarse.<br><br><button class="btn btn-dark btn-sm" onclick="location.reload()">Reiniciar ahora</button></div>';
    return;
  }

  // Cargar config y categorías
  try {
    if (['admin','superadmin'].includes(user.role)) {
      const [cfgRes, catRes] = await Promise.all([
        window.api.expenses.getConfig({ requestUserId: user.id }),
        window.api.expenses.getCategories(),
      ]);
      if (cfgRes?.ok)  _config     = cfgRes.config;
      if (catRes?.ok)  _categorias = catRes.data;
    } else {
      const catRes = await window.api.expenses.getCategories();
      if (catRes?.ok) _categorias = catRes.data;
    }
  } catch(e) { console.error('[gastos] init error', e); }

  el.innerHTML = '';

  // ── Header ────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px';
  header.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Gastos y Cuentas por Pagar</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">Control de egresos, deudas y presupuestos</p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${['admin','superadmin'].includes(user.role) ? `
        <button class="btn btn-ghost btn-sm" id="btn-gasto-retiro">${svg('return')} Retiro/Traslado</button>
        <button class="btn btn-dark btn-sm" id="btn-gasto-nuevo">${svg('plus')} Registrar gasto</button>
      ` : `
        <button class="btn btn-dark btn-sm" id="btn-gasto-nuevo">${svg('plus')} Registrar gasto</button>
      `}
    </div>`;
  el.appendChild(header);

  // ── Tabs ──────────────────────────────────
  const tabs = [
    { key:'resumen',    label:'Resumen' },
    { key:'gastos',     label:'Gastos' },
    { key:'por_pagar',  label:'Cuentas por pagar' },
    { key:'recurrentes',label:'Recurrentes' },
    { key:'proveedores',label:'Proveedores' },
    { key:'presupuestos',label:'Presupuestos' },
    { key:'categorias', label:'Categorías' },
  ].filter(t => {
    if (['admin','superadmin'].includes(user.role)) return true;
    return ['resumen','gastos'].includes(t.key);
  });

  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;border-bottom:1px solid var(--line2);margin-bottom:16px;overflow-x:auto';
  tabs.forEach(t => {
    const btn = document.createElement('button');
    btn.dataset.tab = t.key;
    btn.style.cssText = `padding:8px 16px;border:none;background:none;font-size:13px;cursor:pointer;border-bottom:2px solid ${_gastosTab===t.key?'var(--accent)':'transparent'};color:${_gastosTab===t.key?'var(--accent)':'var(--muted2)'};font-weight:${_gastosTab===t.key?'600':'400'};white-space:nowrap`;
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      _gastosTab = t.key;
      renderGastos(el);
    });
    tabBar.appendChild(btn);
  });
  el.appendChild(tabBar);

  // ── Contenido del tab ─────────────────────
  const content = document.createElement('div');
  el.appendChild(content);

  switch(_gastosTab) {
    case 'resumen':     await renderResumen(content, user); break;
    case 'gastos':      await renderListaGastos(content, user); break;
    case 'por_pagar':   await renderPorPagar(content, user); break;
    case 'recurrentes': await renderRecurrentes(content, user); break;
    case 'proveedores': await renderProveedoresGastos(content, user); break;
    case 'presupuestos':await renderPresupuestos(content, user); break;
    case 'categorias':  await renderCategorias(content, user); break;
    default:            await renderResumen(content, user);
  }

  // ── Eventos de botones ─────────────────────
  document.getElementById('btn-gasto-nuevo')?.addEventListener('click', () => modalNuevoGasto(el, user));
  document.getElementById('btn-gasto-retiro')?.addEventListener('click', () => modalRetiro(el, user));
}

// ══════════════════════════════════════════════
// TAB: RESUMEN
// ══════════════════════════════════════════════
async function renderResumen(el, user) {
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:40px;color:var(--muted2)">
    <div style="text-align:center">
      <div style="font-size:24px;margin-bottom:8px">${svg('chart')}</div>
      <div>Cargando resumen...</div>
    </div>
  </div>`;

  try {
    const from = _gToday().slice(0,7) + '-01';
    const to   = _gToday();
    const res  = await window.api.expenses.getSummary({ from, to });
    if (!res.ok) throw new Error(res.error);
    const s = res.data;

    const metricCard = (label, value, color='var(--ink)', sub='') => `
      <div style="background:var(--bg2);border-radius:10px;padding:14px 16px;border:0.5px solid var(--line2)">
        <div style="font-size:11px;color:var(--muted2);margin-bottom:4px">${label}</div>
        <div style="font-size:20px;font-weight:600;color:${color}">${value}</div>
        ${sub ? `<div style="font-size:10px;color:var(--muted2);margin-top:2px">${sub}</div>` : ''}
      </div>`;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:20px">
        ${metricCard('Gastos del mes', _gFmt(s.total), 'var(--ink)', `${s.count} registros`)}
        ${metricCard('Pagado', _gFmt(s.paid), 'var(--green,#00c07a)')}
        ${metricCard('Pendiente por pagar', _gFmt(s.pending), 'var(--amber,#f59e0b)')}
        ${metricCard('Vencido', _gFmt(s.overdue), s.overdue>0?'var(--red,#ef4444)':'var(--muted2)')}
        ${metricCard('Pagado desde caja', _gFmt(s.from_cash), 'var(--blue,#3b82f6)')}
      </div>

      ${s.by_category?.length ? `
      <div style="background:var(--bg2);border-radius:10px;padding:16px;border:0.5px solid var(--line2)">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px;color:var(--ink)">Gastos por categoría — ${new Date().toLocaleString('es-DO',{month:'long'})}</div>
        ${s.by_category.map(c => {
          const pct = s.total > 0 ? Math.min(100, (c.total / s.total) * 100) : 0;
          return `<div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;margin-bottom:3px">
              <span style="font-size:12px;color:var(--ink)">${c.name||'Sin categoría'}</span>
              <span style="font-size:12px;font-weight:600;color:var(--ink)">${_gFmt(c.total)}</span>
            </div>
            <div style="background:var(--line2);border-radius:4px;height:6px">
              <div style="background:var(--accent);border-radius:4px;height:6px;width:${pct}%;transition:width .3s"></div>
            </div>
          </div>`;
        }).join('')}
      </div>` : `
      <div style="background:var(--bg2);border-radius:10px;padding:32px;text-align:center;color:var(--muted2);border:0.5px solid var(--line2)">
        ${svg('chart')}
        <div style="margin-top:8px;font-size:13px">Sin gastos registrados este mes</div>
        <div style="font-size:11px;margin-top:4px">Registra el primer gasto para ver el resumen</div>
      </div>`}`;
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red,#ef4444);padding:16px">Error al cargar resumen: ${e.message}</div>`;
  }
}

// ══════════════════════════════════════════════
// TAB: LISTA DE GASTOS
// ══════════════════════════════════════════════
async function renderListaGastos(el, user) {
  // Filtros
  el.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <input id="gf-search" class="inp" placeholder="Buscar descripción..." style="width:180px;font-size:12px">
      <input id="gf-from" type="date" class="inp" style="width:130px;font-size:12px" value="${_gThisMonth()}-01">
      <input id="gf-to"   type="date" class="inp" style="width:130px;font-size:12px" value="${_gToday()}">
      <select id="gf-status" class="inp" style="width:160px;font-size:12px">
        <option value="">Todos los estados</option>
        <option value="pendiente_pago">Pendiente de pago</option>
        <option value="pendiente_aprobacion">Pend. aprobación</option>
        <option value="parcialmente_pagado">Parcial</option>
        <option value="pagado">Pagado</option>
        <option value="anulado">Anulado</option>
      </select>
      <button class="btn btn-ghost btn-sm" id="gf-apply">${svg('filter')} Filtrar</button>
    </div>
    <div id="gastos-table-wrap">
      <div style="text-align:center;padding:32px;color:var(--muted2)">Cargando...</div>
    </div>`;

  const loadTable = async () => {
    const search   = document.getElementById('gf-search')?.value.toLowerCase();
    const from     = document.getElementById('gf-from')?.value;
    const to       = document.getElementById('gf-to')?.value;
    const status   = document.getElementById('gf-status')?.value;
    const wrap     = document.getElementById('gastos-table-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted2)">Cargando...</div>';

    try {
      const filters = { from, to };
      if (status) filters.status = status;
      if (user.role === 'cajero') filters.user_id = user.id;
      const res = await window.api.expenses.getAll(filters);
      if (!res.ok) throw new Error(res.error);
      let data = res.data;
      if (search) data = data.filter(e => e.description?.toLowerCase().includes(search) ||
        e.supplier_name?.toLowerCase().includes(search));

      if (!data.length) {
        wrap.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted2)">
          ${svg('list')}<div style="margin-top:8px;font-size:13px">Sin gastos en este período</div></div>`;
        return;
      }

      wrap.innerHTML = `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:1px solid var(--line2);color:var(--muted2);text-align:left">
                <th style="padding:8px">Fecha</th>
                <th style="padding:8px">Descripción</th>
                <th style="padding:8px">Categoría</th>
                <th style="padding:8px">Proveedor</th>
                <th style="padding:8px;text-align:right">Total</th>
                <th style="padding:8px;text-align:right">Pagado</th>
                <th style="padding:8px;text-align:right">Saldo</th>
                <th style="padding:8px">Estado</th>
                <th style="padding:8px">Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${data.map(e => `
                <tr style="border-bottom:0.5px solid var(--line2)" data-eid="${e.id}">
                  <td style="padding:8px;color:var(--muted2)">${_gFmtDate(e.issue_date)}</td>
                  <td style="padding:8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.description}</td>
                  <td style="padding:8px;color:var(--muted2)">${e.category_name||'—'}</td>
                  <td style="padding:8px;color:var(--muted2)">${e.supplier_name||'—'}</td>
                  <td style="padding:8px;text-align:right;font-weight:600">${_gFmt(e.total)}</td>
                  <td style="padding:8px;text-align:right;color:var(--green,#00c07a)">${_gFmt(e.paid_amount)}</td>
                  <td style="padding:8px;text-align:right;color:${e.total-e.paid_amount>0?'var(--amber,#f59e0b)':'var(--muted2)'}">${_gFmt(e.total-e.paid_amount)}</td>
                  <td style="padding:8px">${badge(e.status)}</td>
                  <td style="padding:8px">
                    <div style="display:flex;gap:4px">
                      <button class="btn btn-ghost btn-sm" onclick="verDetalleGasto(${e.id})" title="Ver detalle">${svg('eye')}</button>
                      ${['admin','superadmin'].includes(user.role) && e.status==='pendiente_aprobacion' ? `
                        <button class="btn btn-ghost btn-sm" style="color:var(--green)" onclick="aprobarGasto(${e.id})" title="Aprobar">${svg('check')}</button>
                        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="rechazarGasto(${e.id})" title="Rechazar">${svg('xmark')}</button>
                      ` : ''}
                      ${['admin','superadmin'].includes(user.role) && ['pendiente_pago','parcialmente_pagado','aprobado'].includes(e.status) ? `
                        <button class="btn btn-ghost btn-sm" style="color:var(--blue)" onclick="pagarGasto(${e.id},${e.total-e.paid_amount})" title="Pagar">${svg('dollar')}</button>
                      ` : ''}
                      ${['admin','superadmin'].includes(user.role) && !['anulado','rechazado'].includes(e.status) ? `
                        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="anularGasto(${e.id})" title="Anular">${svg('xmark')}</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch(err) {
      wrap.innerHTML = `<div style="color:var(--red,#ef4444);padding:16px">Error: ${err.message}</div>`;
    }
  };

  document.getElementById('gf-apply')?.addEventListener('click', loadTable);
  await loadTable();
}

// ══════════════════════════════════════════════
// TAB: CUENTAS POR PAGAR
// ══════════════════════════════════════════════
async function renderPorPagar(el, user) {
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted2)">Cargando cuentas por pagar...</div>';
  try {
    const res = await window.api.expenses.getPayable({ requestUserId: user.id });
    if (!res.ok) throw new Error(res.error);
    const data = res.data;

    // Alertas
    const vencidas = data.filter(e => e.overdue);
    const proximas = data.filter(e => !e.overdue && e.days_remaining !== null && e.days_remaining <= 7);

    el.innerHTML = `
      ${vencidas.length ? `<div style="background:#fef2f2;border:1px solid #ef4444;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#991b1b">
        ${svg('alert')} <strong>${vencidas.length} factura${vencidas.length>1?'s':''} vencida${vencidas.length>1?'s':''}</strong> por un total de <strong>${_gFmt(vencidas.reduce((a,e)=>a+(e.total-e.paid_amount),0))}</strong>
      </div>` : ''}
      ${proximas.length ? `<div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#92400e">
        ${svg('bell')} Tienes <strong>${proximas.length} factura${proximas.length>1?'s':''}</strong> que vencen esta semana por <strong>${_gFmt(proximas.reduce((a,e)=>a+(e.total-e.paid_amount),0))}</strong>
      </div>` : ''}
      ${!data.length ? `<div style="text-align:center;padding:40px;color:var(--muted2)">
        ${svg('check')}<div style="margin-top:8px;font-size:13px">Sin cuentas pendientes</div></div>` : `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
              <th style="padding:8px;text-align:left">Proveedor</th>
              <th style="padding:8px;text-align:left">Descripción</th>
              <th style="padding:8px;text-align:left">Vencimiento</th>
              <th style="padding:8px;text-align:left">Días</th>
              <th style="padding:8px;text-align:right">Total</th>
              <th style="padding:8px;text-align:right">Saldo</th>
              <th style="padding:8px;text-align:left">Estado</th>
              <th style="padding:8px">Acción</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(e => `
              <tr style="border-bottom:0.5px solid var(--line2);${e.overdue?'background:#fef2f220':''}">
                <td style="padding:8px">${e.supplier_name||'—'}</td>
                <td style="padding:8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.description}</td>
                <td style="padding:8px;color:var(--muted2)">${_gFmtDate(e.due_date)}</td>
                <td style="padding:8px">${daysLabel(e.days_remaining)}</td>
                <td style="padding:8px;text-align:right;font-weight:600">${_gFmt(e.total)}</td>
                <td style="padding:8px;text-align:right;color:var(--amber,#f59e0b);font-weight:600">${_gFmt(e.total-e.paid_amount)}</td>
                <td style="padding:8px">${badge(e.status)}</td>
                <td style="padding:8px">
                  <button class="btn btn-ghost btn-sm" style="color:var(--blue)" onclick="pagarGasto(${e.id},${e.total-e.paid_amount})">${svg('dollar')} Pagar</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}`;
  } catch(err) {
    el.innerHTML = `<div style="color:var(--red,#ef4444);padding:16px">Error: ${err.message}</div>`;
  }
}

// ══════════════════════════════════════════════
// TAB: GASTOS RECURRENTES
// ══════════════════════════════════════════════
async function renderRecurrentes(el, user) {
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted2)">Cargando...</div>';
  try {
    const res = await window.api.expenses.getRecurring({ requestUserId: user.id });
    if (!res.ok) throw new Error(res.error);
    const data = res.data;

    el.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-dark btn-sm" id="btn-new-recurrent">${svg('plus')} Nueva plantilla</button>
      </div>
      ${!data.length ? `<div style="text-align:center;padding:40px;color:var(--muted2)">
        ${svg('clock')}<div style="margin-top:8px;font-size:13px">Sin gastos recurrentes configurados</div></div>` : `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
              <th style="padding:8px;text-align:left">Nombre</th>
              <th style="padding:8px;text-align:left">Proveedor</th>
              <th style="padding:8px;text-align:left">Frecuencia</th>
              <th style="padding:8px;text-align:left">Próxima fecha</th>
              <th style="padding:8px;text-align:right">Monto</th>
              <th style="padding:8px;text-align:left">Estado</th>
              <th style="padding:8px">Acción</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(r => `
              <tr style="border-bottom:0.5px solid var(--line2)">
                <td style="padding:8px;font-weight:500">${r.name}</td>
                <td style="padding:8px;color:var(--muted2)">${r.supplier_name||'—'}</td>
                <td style="padding:8px;color:var(--muted2)">${r.frequency}</td>
                <td style="padding:8px;color:var(--muted2)">${_gFmtDate(r.next_date)}</td>
                <td style="padding:8px;text-align:right;font-weight:600">${_gFmt(r.amount)}</td>
                <td style="padding:8px"><span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${r.active?'var(--green,#00c07a)':'var(--muted2)'}22;color:${r.active?'var(--green,#00c07a)':'var(--muted2)'};font-weight:600">${r.active?'Activo':'Inactivo'}</span></td>
                <td style="padding:8px">
                  <button class="btn btn-ghost btn-sm" onclick="toggleRecurrente(${r.id},${r.active?0:1})">${r.active?'Pausar':'Activar'}</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}`;

    document.getElementById('btn-new-recurrent')?.addEventListener('click', () => modalNuevoRecurrente(el, user));
  } catch(err) {
    el.innerHTML = `<div style="color:var(--red,#ef4444);padding:16px">Error: ${err.message}</div>`;
  }
}

// ══════════════════════════════════════════════
// TAB: PROVEEDORES
// ══════════════════════════════════════════════
async function renderProveedoresGastos(el, user) {
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted2)">Cargando proveedores...</div>';
  try {
    const res = await window.api.suppliers.getAll();
    const data = res?.ok ? (res.data || []) : [];
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
        ${!data.length ? `<div style="color:var(--muted2);font-size:13px;padding:20px">Sin proveedores registrados.</div>` :
          data.map(s => `
          <div style="background:var(--bg2);border-radius:10px;padding:14px 16px;border:0.5px solid var(--line2)">
            <div style="font-weight:600;font-size:13px;margin-bottom:2px">${s.name}</div>
            ${s.rnc ? `<div style="font-size:11px;color:var(--muted2)">RNC: ${s.rnc}</div>` : ''}
            ${s.phone ? `<div style="font-size:11px;color:var(--muted2)">${svg('phone')} ${s.phone}</div>` : ''}
            ${s.email ? `<div style="font-size:11px;color:var(--muted2)">${svg('mail')} ${s.email}</div>` : ''}
            <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
              <span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${s.status==='activo'?'var(--green,#00c07a)':'var(--red,#ef4444)'}22;color:${s.status==='activo'?'var(--green,#00c07a)':'var(--red,#ef4444)'};font-weight:600">${s.status||'activo'}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:11px;padding:3px 8px" onclick="imprimirEstadoCuentaProveedor(${s.id})" title="Imprimir estado de cuenta">${svg('print')} Estado de cuenta</button>
            </div>
          </div>`).join('')}
      </div>`;
  } catch(err) {
    el.innerHTML = `<div style="color:var(--red,#ef4444);padding:16px">Error: ${err.message}</div>`;
  }
}

// ── Estado de cuenta / historial de pagos de un proveedor ──
window.imprimirEstadoCuentaProveedor = async function(supplierId) {
  try {
    const [suppRes, expRes] = await Promise.all([
      window.api.suppliers.getAll(),
      window.api.expenses.getAll({ supplier_id: supplierId }),
    ]);
    const suppliers = suppRes?.ok ? (suppRes.data || []) : [];
    const expenses  = expRes?.ok  ? (expRes.data  || []) : [];
    const supplier  = suppliers.find(s => s.id === supplierId);
    if (!supplier) { toast('Proveedor no encontrado', 'err'); return; }

    const biz          = DB?.settings?.biz_name || CFG.biz || 'Mi Negocio';
    const totalGeneral = expenses.reduce((a,e) => a + (e.total||0), 0);
    const totalPagado  = expenses.reduce((a,e) => a + (e.paid_amount||0), 0);
    const totalDeuda   = expenses.reduce((a,e) => a + Math.max(0, (e.total||0) - (e.paid_amount||0)), 0);

    const rows = expenses.map(e => {
      const pendiente = Math.max(0, (e.total||0) - (e.paid_amount||0));
      return `<tr>
        <td>${_gFmtDate(e.issue_date)}</td>
        <td>${_esc(e.description)}</td>
        <td>${_esc(e.category_name)||'—'}</td>
        <td style="text-align:right">${_gFmt(e.total)}</td>
        <td style="text-align:right">${_gFmt(e.paid_amount||0)}</td>
        <td style="text-align:right;font-weight:600;color:${pendiente>0?'#dc2626':'#16a34a'}">${_gFmt(pendiente)}</td>
        <td>${badge(e.status)}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Estado de cuenta — ${_esc(supplier.name)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;color:#111;padding:20px}
  h1{font-size:16px;margin-bottom:2px}
  .sub{color:#666;margin-bottom:14px;font-size:11px}
  table{width:100%;border-collapse:collapse;margin-bottom:12px}
  th{background:#f3f4f6;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase}
  td{padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:11px}
  .totals{margin-left:auto;width:260px}
  .totals td{padding:4px 8px}
  .totals tr:last-child td{font-weight:700;font-size:13px;border-top:2px solid #000}
  .foot{margin-top:14px;font-size:10px;color:#9ca3af}
</style></head><body>
  <h1>${_esc(biz)}</h1>
  <div class="sub">Estado de Cuenta — Proveedor · Generado el ${_gFmtDate(_gToday())}</div>
  <div style="background:#f9fafb;padding:8px 12px;border-radius:4px;margin-bottom:10px">
    <strong>Proveedor:</strong> ${_esc(supplier.name)}
    ${supplier.rnc   ? ` &nbsp;·&nbsp; RNC: ${_esc(supplier.rnc)}`     : ''}
    ${supplier.phone ? ` &nbsp;·&nbsp; Tel: ${_esc(supplier.phone)}` : ''}
  </div>
  <table>
    <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th>
    <th style="text-align:right">Total</th><th style="text-align:right">Pagado</th>
    <th style="text-align:right">Pendiente</th><th>Estado</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#9ca3af">Sin gastos registrados</td></tr>'}</tbody>
  </table>
  <table class="totals">
    <tr><td>Total facturado</td><td style="text-align:right">${_gFmt(totalGeneral)}</td></tr>
    <tr><td>Total pagado</td><td style="text-align:right">${_gFmt(totalPagado)}</td></tr>
    <tr><td>Balance pendiente</td><td style="text-align:right">${_gFmt(totalDeuda)}</td></tr>
  </table>
  <div class="foot">${_esc(biz)} · Documento generado por Velo POS</div>
</body></html>`;

    printHTML(html, 'pago');
  } catch(err) {
    toast('Error al generar estado de cuenta: ' + err.message, 'err');
  }
};

// ══════════════════════════════════════════════
// TAB: PRESUPUESTOS
// ══════════════════════════════════════════════
async function renderPresupuestos(el, user) {
  const month = _gThisMonth();
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted2)">Cargando presupuestos...</div>';
  try {
    const [budgetRes, sumRes] = await Promise.all([
      window.api.expenses.getBudgets({ month, requestUserId: user.id }),
      window.api.expenses.getSummary({ month }),
    ]);
    if (!budgetRes.ok) throw new Error(budgetRes.error);
    const data = budgetRes.data;
    const cats = _categorias.filter(c => !c.parent_id);
    const s    = sumRes?.ok ? sumRes.data : null;

    // Balance visual ingresos vs egresos del mes
    const totalGastado  = s?.total    || 0;
    const totalPagado   = s?.paid     || 0;
    const totalPendiente= s?.pending  || 0;
    const totalVencido  = s?.overdue  || 0;
    const totalBudget   = data.reduce((a,b) => a + (b.amount||0), 0);
    const pctBudget     = totalBudget > 0 ? Math.min(100, (totalGastado/totalBudget)*100) : 0;
    const budgetColor   = pctBudget >= 100 ? 'var(--red,#ef4444)' : pctBudget >= 80 ? 'var(--amber,#f59e0b)' : 'var(--green,#00c07a)';

    el.innerHTML = `
      <!-- Resumen del mes -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:16px">
        <div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:0.5px solid var(--line2)">
          <div style="font-size:10px;color:var(--muted2);margin-bottom:3px">Total gastado</div>
          <div style="font-size:18px;font-weight:700;color:var(--red,#ef4444)">${_gFmt(totalGastado)}</div>
          <div style="font-size:10px;color:var(--muted2)">${s?.count||0} registros</div>
        </div>
        <div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:0.5px solid var(--line2)">
          <div style="font-size:10px;color:var(--muted2);margin-bottom:3px">Pagado</div>
          <div style="font-size:18px;font-weight:700;color:var(--green,#00c07a)">${_gFmt(totalPagado)}</div>
        </div>
        <div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:0.5px solid var(--line2)">
          <div style="font-size:10px;color:var(--muted2);margin-bottom:3px">Por pagar</div>
          <div style="font-size:18px;font-weight:700;color:var(--amber,#f59e0b)">${_gFmt(totalPendiente)}</div>
          ${totalVencido > 0 ? `<div style="font-size:10px;color:var(--red,#ef4444);font-weight:600">${_gFmt(totalVencido)} vencido</div>` : ''}
        </div>
        ${totalBudget > 0 ? `
        <div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:0.5px solid ${budgetColor}">
          <div style="font-size:10px;color:var(--muted2);margin-bottom:3px">Presupuesto</div>
          <div style="font-size:18px;font-weight:700;color:${budgetColor}">${Math.round(pctBudget)}%</div>
          <div style="background:var(--line2);border-radius:3px;height:4px;margin-top:4px">
            <div style="background:${budgetColor};border-radius:3px;height:4px;width:${pctBudget}%;transition:width .4s"></div>
          </div>
          <div style="font-size:10px;color:var(--muted2);margin-top:2px">${_gFmt(totalGastado)} / ${_gFmt(totalBudget)}</div>
        </div>` : ''}
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:13px;font-weight:600">Presupuesto — ${new Date(month+'-01').toLocaleString('es-DO',{month:'long',year:'numeric'})}</div>
        <button class="btn btn-dark btn-sm" id="btn-add-budget">${svg('plus')} Agregar presupuesto</button>
      </div>
      ${!data.length ? `<div style="text-align:center;padding:40px;color:var(--muted2)">
        ${svg('dollar')}<div style="margin-top:8px;font-size:13px">Sin presupuestos configurados para este mes</div></div>` : `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
              <th style="padding:8px;text-align:left">Categoría</th>
              <th style="padding:8px;text-align:right">Presupuesto</th>
              <th style="padding:8px;text-align:right">Gastado</th>
              <th style="padding:8px;text-align:right">Disponible</th>
              <th style="padding:8px;text-align:left">Estado</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(b => {
              const pct = b.amount > 0 ? Math.min(100, (b.spent / b.amount) * 100) : 0;
              const color = pct >= 100 ? 'var(--red,#ef4444)' : pct >= 80 ? 'var(--amber,#f59e0b)' : 'var(--green,#00c07a)';
              return `<tr style="border-bottom:0.5px solid var(--line2)">
                <td style="padding:8px">${b.category_name||'Sin categoría'}</td>
                <td style="padding:8px;text-align:right">${_gFmt(b.amount)}</td>
                <td style="padding:8px;text-align:right;color:${color}">${_gFmt(b.spent)}</td>
                <td style="padding:8px;text-align:right;font-weight:600">${_gFmt(Math.max(0, b.amount - b.spent))}</td>
                <td style="padding:8px">
                  <div style="background:var(--line2);border-radius:4px;height:6px;width:100px">
                    <div style="background:${color};border-radius:4px;height:6px;width:${pct}%"></div>
                  </div>
                  <span style="font-size:10px;color:${color}">${Math.round(pct)}%</span>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}`;

    document.getElementById('btn-add-budget')?.addEventListener('click', () => modalPresupuesto(el, user, cats, month));
  } catch(err) {
    el.innerHTML = `<div style="color:var(--red,#ef4444);padding:16px">Error: ${err.message}</div>`;
  }
}

// ══════════════════════════════════════════════
// TAB: CATEGORÍAS
// ══════════════════════════════════════════════
async function renderCategorias(el, user) {
  const cats = _categorias;
  const padres = cats.filter(c => !c.parent_id);
  el.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-dark btn-sm" id="btn-new-cat">${svg('plus')} Nueva categoría</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
      ${padres.map(p => {
        const hijos = cats.filter(c => c.parent_id === p.id);
        return `<div style="background:var(--bg2);border-radius:10px;border:0.5px solid var(--line2);overflow:hidden">
          <div style="padding:10px 14px;font-weight:600;font-size:13px;border-bottom:0.5px solid var(--line2);display:flex;justify-content:space-between;align-items:center">
            ${p.name}
            <span style="font-size:10px;color:var(--muted2)">${hijos.length} sub</span>
          </div>
          <div style="padding:8px 14px">
            ${hijos.map(h => `<div style="font-size:12px;padding:3px 0;color:var(--muted2);border-bottom:0.5px solid var(--line2)">· ${h.name}</div>`).join('')}
            ${!hijos.length ? '<div style="font-size:11px;color:var(--muted2)">Sin subcategorías</div>' : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;

  document.getElementById('btn-new-cat')?.addEventListener('click', () => modalNuevaCat(el, user, padres));
}

// ══════════════════════════════════════════════
// MODALES
// ══════════════════════════════════════════════

function abrirModal(titulo, contenidoHTML, onConfirm, confirmLabel='Guardar') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2)">
        <div style="font-size:15px;font-weight:600">${titulo}</div>
        <button id="modal-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px" id="modal-body">${contenidoHTML}</div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="modal-cancel">Cancelar</button>
        <button class="btn btn-dark" id="modal-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#modal-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#modal-confirm');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try {
      await onConfirm(overlay);
      overlay.remove();
    } catch(e) {
      btn.disabled = false; btn.textContent = confirmLabel;
      alert(e.message);
    }
  });
  return overlay;
}

function modalNuevoGasto(parentEl, user) {
  const padres = _categorias.filter(c => !c.parent_id);
  const proveedores = [];
  window.api.suppliers.getAll().then(res => {
    const sel  = document.getElementById('gasto-supplier');
    const list = res?.ok ? (res.data || []) : [];
    if (sel) list.forEach(s => sel.insertAdjacentHTML('beforeend', `<option value="${s.id}">${_esc(s.name)}</option>`));
  }).catch(()=>{});

  const html = `
    <div class="fg"><label class="lbl">Tipo de movimiento *</label>
      <select class="inp" id="gasto-type">
        <option value="gasto">Gasto operativo / administrativo</option>
        <option value="activo">Compra de activo fijo</option>
        <option value="retiro">Retiro o traslado de dinero</option>
        <option value="reembolso">Reembolso recibido</option>
        <option value="aporte">Aporte de capital</option>
      </select></div>
    <div class="fg"><label class="lbl">Descripción *</label>
      <input class="inp" id="gasto-desc" placeholder="Ej: Pago de electricidad mes de junio"></div>
    <div class="fg"><label class="lbl">Categoría</label>
      <select class="inp" id="gasto-cat">
        <option value="">— Sin categoría —</option>
        ${padres.map(p => {
          const subs = _categorias.filter(c => c.parent_id === p.id);
          return `<optgroup label="${p.name}">${subs.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</optgroup>`;
        }).join('')}
      </select></div>
    <div class="fg"><label class="lbl">Proveedor</label>
      <select class="inp" id="gasto-supplier"><option value="">— Sin proveedor —</option></select></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Monto total *</label>
        <input class="inp" id="gasto-amount" type="number" min="0" step="0.01" placeholder="0.00"></div>
      <div class="fg"><label class="lbl">ITBIS (18%)</label>
        <input class="inp" id="gasto-tax" type="number" min="0" step="0.01" placeholder="0.00"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Fecha del gasto *</label>
        <input class="inp" id="gasto-date" type="date" value="${_gToday()}"></div>
      <div class="fg"><label class="lbl">Fecha de vencimiento</label>
        <input class="inp" id="gasto-due" type="date"></div>
    </div>
    <div class="fg"><label class="lbl">Método de pago</label>
      <select class="inp" id="gasto-method">
        <option value="efectivo">Efectivo</option>
        <option value="transferencia">Transferencia bancaria</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="cheque">Cheque</option>
        <option value="credito">Crédito (cuentas por pagar)</option>
      </select></div>
    <div class="fg"><label class="lbl">No. Factura del proveedor</label>
      <input class="inp" id="gasto-invoice" placeholder="Ej: FAC-00123"></div>
    <div class="fg"><label class="lbl">NCF</label>
      <input class="inp" id="gasto-ncf" placeholder="Ej: B0100000001"></div>
    <div class="fg"><label class="lbl">Notas internas</label>
      <textarea class="inp" id="gasto-notes" rows="2" placeholder="Observaciones..."></textarea></div>`;

  abrirModal('Registrar gasto', html, async (overlay) => {
    const desc   = overlay.querySelector('#gasto-desc')?.value.trim();
    const amount = parseFloat(overlay.querySelector('#gasto-amount')?.value);
    const tax    = parseFloat(overlay.querySelector('#gasto-tax')?.value||'0');
    if (!desc) throw new Error('La descripción es obligatoria');
    if (!amount || amount <= 0) throw new Error('El monto debe ser mayor a cero');

    const method = overlay.querySelector('#gasto-method')?.value;
    const res = await window.api.expenses.create({
      data: {
        type:           overlay.querySelector('#gasto-type')?.value,
        description:    desc,
        category_id:    overlay.querySelector('#gasto-cat')?.value || null,
        supplier_id:    overlay.querySelector('#gasto-supplier')?.value || null,
        amount,
        tax_amount:     isNaN(tax) ? 0 : tax,
        total:          amount,
        payment_method: method,
        payment_source: method === 'credito' ? 'pendiente' : 'caja',
        issue_date:     overlay.querySelector('#gasto-date')?.value,
        due_date:       overlay.querySelector('#gasto-due')?.value || null,
        invoice_number: overlay.querySelector('#gasto-invoice')?.value || null,
        ncf:            overlay.querySelector('#gasto-ncf')?.value || null,
        notes:          overlay.querySelector('#gasto-notes')?.value || null,
      },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    toast(`✓ Gasto registrado${res.status==='pendiente_aprobacion'?' — pendiente de aprobación':''}`);
    renderGastos(parentEl.closest('#main-content') || parentEl);
  }, 'Registrar gasto');
}

function modalRetiro(parentEl, user) {
  const html = `
    <div class="fg"><label class="lbl">Descripción *</label>
      <input class="inp" id="retiro-desc" placeholder="Ej: Depósito a cuenta bancaria"></div>
    <div class="fg"><label class="lbl">Monto *</label>
      <input class="inp" id="retiro-amount" type="number" min="0" step="0.01"></div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="retiro-notes" rows="2" placeholder="Referencia o destino..."></textarea></div>`;

  abrirModal('Registrar retiro o traslado', html, async (overlay) => {
    const desc   = overlay.querySelector('#retiro-desc')?.value.trim();
    const amount = parseFloat(overlay.querySelector('#retiro-amount')?.value);
    if (!desc) throw new Error('La descripción es obligatoria');
    if (!amount || amount <= 0) throw new Error('El monto debe ser mayor a cero');
    const res = await window.api.expenses.create({
      data: { type:'retiro', description:desc, amount, total:amount,
              notes: overlay.querySelector('#retiro-notes')?.value },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    toast('✓ Retiro/traslado registrado');
    renderGastos(parentEl.closest('#main-content') || parentEl);
  }, 'Registrar retiro');
}

function modalPresupuesto(parentEl, user, cats, month) {
  const html = `
    <div class="fg"><label class="lbl">Categoría *</label>
      <select class="inp" id="bud-cat">
        <option value="">Selecciona...</option>
        ${cats.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
      </select></div>
    <div class="fg"><label class="lbl">Monto del presupuesto *</label>
      <input class="inp" id="bud-amount" type="number" min="0" step="0.01"></div>`;

  abrirModal('Agregar presupuesto mensual', html, async (overlay) => {
    const cat_id = parseInt(overlay.querySelector('#bud-cat')?.value);
    const amount = parseFloat(overlay.querySelector('#bud-amount')?.value);
    if (!cat_id) throw new Error('Selecciona una categoría');
    if (!amount || amount <= 0) throw new Error('El monto debe ser mayor a cero');
    const res = await window.api.expenses.upsertBudget({
      data: { category_id: cat_id, month, amount },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    toast('✓ Presupuesto guardado');
    _gastosTab = 'presupuestos';
    renderGastos(parentEl.closest('#main-content') || parentEl);
  }, 'Guardar presupuesto');
}

function modalNuevaCat(parentEl, user, padres) {
  const html = `
    <div class="fg"><label class="lbl">Nombre *</label>
      <input class="inp" id="cat-name" placeholder="Ej: Logística"></div>
    <div class="fg"><label class="lbl">Categoría padre (opcional)</label>
      <select class="inp" id="cat-parent">
        <option value="">— Categoría principal —</option>
        ${padres.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}
      </select></div>
    <div class="fg" style="display:flex;gap:12px;align-items:center;margin-top:4px">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px">
        <input type="checkbox" id="cat-profit" checked> Afecta utilidad
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px">
        <input type="checkbox" id="cat-approval"> Requiere aprobación
      </label>
    </div>`;

  abrirModal('Nueva categoría de gasto', html, async (overlay) => {
    const name = overlay.querySelector('#cat-name')?.value.trim();
    if (!name) throw new Error('El nombre es obligatorio');
    const res = await window.api.expenses.createCategory({
      name,
      parent_id: overlay.querySelector('#cat-parent')?.value || null,
      affects_profit: overlay.querySelector('#cat-profit')?.checked ? 1 : 0,
      requires_approval: overlay.querySelector('#cat-approval')?.checked ? 1 : 0,
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    toast('✓ Categoría creada');
    const catRes = await window.api.expenses.getCategories();
    if (catRes.ok) _categorias = catRes.data;
    renderGastos(parentEl.closest('#main-content') || parentEl);
  }, 'Crear categoría');
}

function modalNuevoRecurrente(parentEl, user) {
  const padres = _categorias.filter(c => !c.parent_id);
  const html = `
    <div class="fg"><label class="lbl">Nombre *</label>
      <input class="inp" id="rec-name" placeholder="Ej: Alquiler mensual"></div>
    <div class="fg"><label class="lbl">Categoría</label>
      <select class="inp" id="rec-cat">
        <option value="">— Sin categoría —</option>
        ${padres.map(p => {
          const subs = _categorias.filter(c => c.parent_id === p.id);
          return `<optgroup label="${p.name}">${subs.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</optgroup>`;
        }).join('')}
      </select></div>
    <div class="fg"><label class="lbl">Monto habitual *</label>
      <input class="inp" id="rec-amount" type="number" min="0" step="0.01"></div>
    <div class="fg"><label class="lbl">Frecuencia *</label>
      <select class="inp" id="rec-freq">
        <option value="mensual">Mensual</option>
        <option value="quincenal">Quincenal</option>
        <option value="semanal">Semanal</option>
        <option value="bimestral">Bimestral</option>
        <option value="trimestral">Trimestral</option>
        <option value="anual">Anual</option>
      </select></div>
    <div class="fg"><label class="lbl">Próxima fecha *</label>
      <input class="inp" id="rec-next" type="date" value="${_gToday()}"></div>`;

  abrirModal('Nueva plantilla recurrente', html, async (overlay) => {
    const name   = overlay.querySelector('#rec-name')?.value.trim();
    const amount = parseFloat(overlay.querySelector('#rec-amount')?.value);
    if (!name) throw new Error('El nombre es obligatorio');
    if (!amount || amount <= 0) throw new Error('El monto debe ser mayor a cero');
    const res = await window.api.expenses.createRecurring({
      data: {
        name, amount, category_id: overlay.querySelector('#rec-cat')?.value || null,
        frequency: overlay.querySelector('#rec-freq')?.value,
        next_date: overlay.querySelector('#rec-next')?.value,
        user_id: user.id,
      },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    toast('✓ Plantilla recurrente creada');
    renderGastos(parentEl.closest('#main-content') || parentEl);
  }, 'Crear plantilla');
}

// ── Acciones globales (llamadas desde botones en tabla) ──
window.verDetalleGasto = async (id) => {
  const res = await window.api.expenses.getById({ id });
  if (!res.ok) return alert('Error al cargar el gasto');
  const e = res.data;
  const histPagos = e.payments?.map(p => `
    <tr style="border-bottom:0.5px solid var(--line2);font-size:12px">
      <td style="padding:6px">${_gFmtDate(p.created_at?.split('T')[0])}</td>
      <td style="padding:6px">${_gFmt(p.amount)}</td>
      <td style="padding:6px">${p.payment_method}</td>
      <td style="padding:6px;color:var(--muted2)">${p.user_name||'—'}</td>
      <td style="padding:6px">${badge(p.status)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="padding:10px;text-align:center;color:var(--muted2)">Sin pagos registrados</td></tr>';

  abrirModal(`Detalle — ${e.description}`, `
    <div style="font-size:12px;color:var(--muted2);margin-bottom:12px">Registrado por: <strong>${e.user_name||'—'}</strong> · ${_gFmtDate(e.issue_date)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div><span style="font-size:11px;color:var(--muted2)">Total</span><div style="font-size:16px;font-weight:600">${_gFmt(e.total)}</div></div>
      <div><span style="font-size:11px;color:var(--muted2)">Pagado</span><div style="font-size:16px;font-weight:600;color:var(--green,#00c07a)">${_gFmt(e.paid_amount)}</div></div>
      <div><span style="font-size:11px;color:var(--muted2)">Saldo</span><div style="font-size:16px;font-weight:600;color:var(--amber,#f59e0b)">${_gFmt(e.total-e.paid_amount)}</div></div>
      <div><span style="font-size:11px;color:var(--muted2)">Estado</span><div style="margin-top:2px">${badge(e.status)}</div></div>
    </div>
    ${e.supplier_name?`<div style="font-size:12px;margin-bottom:4px"><strong>Proveedor:</strong> ${e.supplier_name}</div>`:''}
    ${e.category_name?`<div style="font-size:12px;margin-bottom:4px"><strong>Categoría:</strong> ${e.category_name}</div>`:''}
    ${e.invoice_number?`<div style="font-size:12px;margin-bottom:4px"><strong>No. Factura:</strong> ${e.invoice_number}</div>`:''}
    ${e.ncf?`<div style="font-size:12px;margin-bottom:4px"><strong>NCF:</strong> ${e.ncf}</div>`:''}
    ${e.notes?`<div style="font-size:12px;margin-bottom:4px"><strong>Notas:</strong> ${e.notes}</div>`:''}
    ${e.cancel_reason?`<div style="font-size:12px;margin-bottom:4px;color:var(--red,#ef4444)"><strong>Motivo anulación:</strong> ${e.cancel_reason}</div>`:''}
    <div style="font-size:12px;font-weight:600;margin:12px 0 6px">Historial de pagos</div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="color:var(--muted2);font-size:11px">
        <th style="padding:6px;text-align:left">Fecha</th><th style="padding:6px;text-align:left">Monto</th>
        <th style="padding:6px;text-align:left">Método</th><th style="padding:6px;text-align:left">Usuario</th>
        <th style="padding:6px;text-align:left">Estado</th>
      </tr></thead>
      <tbody>${histPagos}</tbody>
    </table>`, () => {}, 'Cerrar');
};

window.pagarGasto = (id, saldo) => {
  const user = _getUser();
  const html = `
    <div class="fg"><label class="lbl">Monto a pagar *</label>
      <input class="inp" id="pago-amount" type="number" min="0.01" max="${saldo}" step="0.01" value="${saldo}">
      <div style="font-size:11px;color:var(--muted2);margin-top:3px">Saldo pendiente: ${_gFmt(saldo)}</div>
    </div>
    <div class="fg"><label class="lbl">Método de pago</label>
      <select class="inp" id="pago-method">
        <option value="efectivo">Efectivo (desde caja)</option>
        <option value="transferencia">Transferencia bancaria</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="cheque">Cheque</option>
      </select></div>
    <div class="fg"><label class="lbl">Referencia / No. de comprobante</label>
      <input class="inp" id="pago-ref" placeholder="Ej: TRF-00123"></div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="pago-notes" rows="2"></textarea></div>`;

  abrirModal('Registrar pago', html, async (overlay) => {
    const amount = parseFloat(overlay.querySelector('#pago-amount')?.value);
    if (!amount || amount <= 0) throw new Error('El monto debe ser mayor a cero');
    if (amount > saldo + 0.01) throw new Error(`No puedes pagar más del saldo pendiente (${_gFmt(saldo)})`);
    const method    = overlay.querySelector('#pago-method')?.value;
    const reference = overlay.querySelector('#pago-ref')?.value || null;
    const notes     = overlay.querySelector('#pago-notes')?.value || null;
    const res = await window.api.expenses.pay({
      expenseId: id, amount,
      payment_method: method,
      payment_source: method === 'efectivo' ? 'caja' : 'banco',
      reference, notes,
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    toast('✓ Pago registrado correctamente');

    // Imprimir recibo de pago a proveedor (no bloquea el flujo si falla)
    try {
      const expRes  = await window.api.expenses.getById({ id });
      const expense = expRes?.ok ? expRes.data : null;
      if (expense && typeof printPagoProveedor === 'function') {
        printPagoProveedor({
          payment: {
            id:             res.paymentId || id,
            amount,
            method,
            reference,
            notes,
            balance_before: saldo,
            balance_after:  saldo - amount,
            created_at:     new Date().toISOString(),
          },
          expense,
          cajero: user.name,
        });
      }
    } catch(e) { console.error('[gastos] error al imprimir recibo de pago', e); }

    const el = document.getElementById('main-content');
    if (el) renderGastos(el);
  }, 'Registrar pago');
};

window.aprobarGasto = async (id) => {
  if (!confirm('¿Aprobar este gasto?')) return;
  const user = _getUser();
  const res = await window.api.expenses.approve({ expenseId: id, requestUserId: user.id });
  if (!res.ok) return alert(res.error);
  toast('✓ Gasto aprobado');
  const el = document.getElementById('main-content');
  if (el) renderGastos(el);
};

window.rechazarGasto = (id) => {
  const user = _getUser();
  abrirModal('Rechazar gasto', `
    <div class="fg"><label class="lbl">Motivo del rechazo *</label>
      <textarea class="inp" id="rej-reason" rows="3" placeholder="Indica el motivo..."></textarea></div>`,
    async (overlay) => {
      const reason = overlay.querySelector('#rej-reason')?.value.trim();
      if (!reason) throw new Error('El motivo es obligatorio');
      const res = await window.api.expenses.reject({ expenseId: id, reason, requestUserId: user.id });
      if (!res.ok) throw new Error(res.error);
      toast('✓ Gasto rechazado');
      const el = document.getElementById('main-content');
      if (el) renderGastos(el);
    }, 'Rechazar');
};

window.anularGasto = (id) => {
  const user = _getUser();
  abrirModal('Anular gasto', `
    <div style="color:var(--amber,#f59e0b);margin-bottom:12px;font-size:13px">
      ${svg('alert')} Esta acción no se puede deshacer. Si el gasto afectó la caja, se creará un contramovimiento.
    </div>
    <div class="fg"><label class="lbl">Motivo de anulación *</label>
      <textarea class="inp" id="cancel-reason" rows="3" placeholder="Indica el motivo..."></textarea></div>`,
    async (overlay) => {
      const reason = overlay.querySelector('#cancel-reason')?.value.trim();
      if (!reason) throw new Error('El motivo de anulación es obligatorio');
      const res = await window.api.expenses.cancel({ expenseId: id, reason, requestUserId: user.id });
      if (!res.ok) throw new Error(res.error);
      toast('✓ Gasto anulado — contramovimiento generado');
      const el = document.getElementById('main-content');
      if (el) renderGastos(el);
    }, 'Confirmar anulación');
};

window.toggleRecurrente = async (id, active) => {
  const user = _getUser();
  const res = await window.api.expenses.toggleRecurring({ id, active, requestUserId: user.id });
  if (!res.ok) return alert(res.error);
  toast(active ? '✓ Plantilla activada' : '✓ Plantilla pausada');
  const el = document.getElementById('main-content');
  if (el) renderGastos(el);
};
