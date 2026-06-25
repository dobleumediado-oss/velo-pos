// ══════════════════════════════════════════════
// contabilidad.js — Módulo de Contabilidad
// Catálogo, Asientos, Mayor, Balances, CxC, CxP
// ══════════════════════════════════════════════

let _contTab  = 'dashboard';
let _contFrom = _isoDate(-30);
let _contTo   = _isoDate(0);

function _isoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function renderContabilidad(el) {
  el.innerHTML = '';

  if (!['admin','superadmin'].includes(user?.role)) {
    el.innerHTML = '<div class="empty"><p>Acceso restringido</p></div>';
    return;
  }

  const wrap = h('div', { style: { padding: '20px', maxWidth: '1200px', margin: '0 auto' } });
  el.appendChild(wrap);

  const tabs = h('div', { class: 'mod-tabs' });
  [
    { key: 'dashboard',    label: 'Dashboard' },
    { key: 'cuentas',      label: 'Catálogo' },
    { key: 'asientos',     label: 'Asientos' },
    { key: 'mayor',        label: 'Mayor' },
    { key: 'balance',      label: 'Bal. Comprobación' },
    { key: 'resultados',   label: 'Resultados' },
    { key: 'general',      label: 'Bal. General' },
    { key: 'cxc',          label: 'CxC' },
    { key: 'cxp',          label: 'CxP' },
    { key: 'configuracion',label: 'Configuración' },
  ].forEach(t => {
    const btn = h('button', {
      class: `mod-tab ${_contTab === t.key ? 'on' : ''}`,
      onclick: () => { _contTab = t.key; renderContabilidad(el); }
    }, t.label);
    tabs.appendChild(btn);
  });
  wrap.appendChild(tabs);

  const body = h('div', { id: 'cont-body' });
  wrap.appendChild(body);

  switch (_contTab) {
    case 'dashboard':     await _contRenderDash(body);         break;
    case 'cuentas':       await _contRenderCuentas(body);      break;
    case 'asientos':      await _contRenderAsientos(body);     break;
    case 'mayor':         await _contRenderMayor(body);        break;
    case 'balance':       await _contRenderBalance(body);      break;
    case 'resultados':    await _contRenderResultados(body);   break;
    case 'general':       await _contRenderGeneral(body);      break;
    case 'cxc':           await _contRenderCxC(body);          break;
    case 'cxp':           await _contRenderCxP(body);          break;
    case 'configuracion': await _contRenderConfig(body);       break;
  }
}

// ══════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════
async function _contRenderDash(el) {
  const [statsRes, finRes] = await Promise.all([
    window.api.accounting.getDashboardStats(),
    window.api.financial.getSummary(),
  ]);
  const s   = statsRes?.data  || {};
  const fin = finRes?.data    || {};

  const cards = [
    { label: 'Ingresos del período', val: s.totalRevenue  || 0, icon: '📈', cls: 'positive' },
    { label: 'Gastos del período',   val: s.totalExpenses || 0, icon: '📉', cls: 'negative' },
    { label: 'Utilidad neta',        val: s.netIncome     || 0, icon: '💰', cls: (s.netIncome||0) >= 0 ? 'positive' : 'negative' },
    { label: 'Efectivo total',       val: fin.total_active|| 0, icon: '🏦', cls: '' },
    { label: 'Cuentas por cobrar',   val: s.arBalance     || 0, icon: '📋', cls: '' },
    { label: 'Cuentas por pagar',    val: s.apBalance     || 0, icon: '📄', cls: 'negative' },
    { label: 'Asientos confirmados', val: s.totalEntries  || 0, icon: '📝', cls: '', noFmt: true },
    { label: 'Asientos borrador',    val: s.pendingEntries|| 0, icon: '🗂',  cls: '', noFmt: true },
  ];

  const grid = h('div', { class: 'cont-dash' });
  cards.forEach(c => {
    grid.appendChild(h('div', { class: 'cont-stat' },
      h('div', { style: { fontSize: '22px', marginBottom: '6px' } }, c.icon),
      h('div', { class: `cont-stat-val ${c.cls === 'positive' ? '' : c.cls === 'negative' ? '' : ''}`,
        style: { color: c.cls === 'positive' ? '#10b981' : c.cls === 'negative' ? '#ef4444' : 'var(--accent)' } },
        c.noFmt ? c.val : fmt(c.val)),
      h('div', { class: 'cont-stat-lbl' }, c.label)
    ));
  });
  el.appendChild(grid);

  // Accesos rápidos
  el.appendChild(h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px' } },
    h('button', { class: 'btn', onclick: () => { _contTab = 'asientos'; renderContabilidad(document.getElementById('page')); } }, '+ Nuevo asiento'),
    h('button', { class: 'btn-ghost', onclick: () => { _contTab = 'resultados'; renderContabilidad(document.getElementById('page')); } }, 'Estado de Resultados'),
    h('button', { class: 'btn-ghost', onclick: () => { _contTab = 'general'; renderContabilidad(document.getElementById('page')); } }, 'Balance General'),
    h('button', { class: 'btn-ghost',
      onclick: async () => {
        const r = await window.api.accounting.syncHistorical({ requestUserId: user.id });
        toast(r?.ok ? `${r.data?.created || 0} asientos generados` : (r?.error || 'Error'), r?.ok ? 's' : 'e');
      }
    }, '🔄 Sincronizar histórico')
  ));
}

// ══════════════════════════════════════════════
// CATÁLOGO DE CUENTAS
// ══════════════════════════════════════════════
async function _contRenderCuentas(el) {
  const res    = await window.api.accounting.getAccounts();
  const cuentas = res?.data || [];

  const hdr = h('div', { class: 'sec-hdr', style: { marginBottom: '14px' } },
    h('div', null),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'print-btn', onclick: () => _printCatalogo(cuentas) }, '🖨 Imprimir'),
      h('button', { class: 'btn', onclick: () => _openCuentaModal(null, cuentas) }, '+ Nueva cuenta')
    )
  );
  el.appendChild(hdr);

  if (!cuentas.length) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'Sin cuentas en el catálogo')));
    return;
  }

  // Construir árbol jerárquico
  const map = {};
  const roots = [];
  cuentas.forEach(c => { map[c.id] = { ...c, children: [] }; });
  cuentas.forEach(c => {
    if (c.parent_id && map[c.parent_id]) map[c.parent_id].children.push(map[c.id]);
    else roots.push(map[c.id]);
  });

  const chartEl = h('div', { style: { border: '1px solid var(--line2)', borderRadius: '10px', overflow: 'hidden' } });

  function renderNode(node, level) {
    const row = h('div', { class: `chart-row lvl-${Math.min(level, 4)}` },
      h('span', { class: 'chart-code' }, node.code),
      h('span', { style: { flex: '1' }, html: `${node.is_summary ? '<strong>' : ''}${node.name}${node.is_summary ? '</strong>' : ''}` }),
      h('span', { style: { fontSize: '11px', color: 'var(--muted2)' } }, node.type || ''),
      h('span', { class: 'chart-bal' }, node.balance ? fmt(node.balance) : '—'),
      h('div', { style: { display: 'flex', gap: '4px', marginLeft: '8px' } },
        h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '2px 7px' },
          onclick: (e) => { e.stopPropagation(); _openCuentaModal(node, cuentas); } }, 'Editar'),
        !node.is_summary && !node.children?.length
          ? h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '2px 7px', color: '#ef4444' },
              onclick: (e) => { e.stopPropagation(); _deleteCuenta(node.id); } }, 'Eliminar')
          : null
      )
    );
    chartEl.appendChild(row);
    node.children?.forEach(child => renderNode(child, level + 1));
  }
  roots.forEach(r => renderNode(r, 1));
  el.appendChild(chartEl);
}

function _openCuentaModal(acct = null, allAccts = []) {
  const parents = allAccts.filter(c => c.is_summary);
  openModal(`
    <div style="padding:24px;min-width:400px">
      <div class="modal-title">${acct ? 'Editar cuenta' : 'Nueva cuenta contable'}</div>
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label class="lbl">Código *</label>
            <input id="ca-code" class="inp" value="${acct?.code || ''}" placeholder="Ej: 6120">
          </div>
          <div>
            <label class="lbl">Tipo *</label>
            <select id="ca-type" class="inp">
              ${['activo','pasivo','capital','ingreso','costo','gasto','impuesto'].map(t =>
                `<option value="${t}" ${acct?.type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div>
          <label class="lbl">Nombre *</label>
          <input id="ca-name" class="inp" value="${acct?.name || ''}" placeholder="Ej: Gastos de Publicidad">
        </div>
        <div>
          <label class="lbl">Cuenta padre</label>
          <select id="ca-parent" class="inp">
            <option value="">— Ninguna (cuenta raíz) —</option>
            ${parents.map(p =>
              `<option value="${p.id}" ${acct?.parent_id===p.id?'selected':''}>${p.code} - ${p.name}</option>`
            ).join('')}
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="ca-summary" ${acct?.is_summary?'checked':''}>
          <label for="ca-summary" style="font-size:12px;color:var(--ink2)">Cuenta de grupo (no recibe movimientos directos)</label>
        </div>
        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn" onclick="_saveCuenta(${acct?.id || 'null'})">${acct ? 'Guardar' : 'Crear'}</button>
          <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </div>
    </div>
  `);
}

window._saveCuenta = async function(id) {
  const code     = document.getElementById('ca-code').value.trim();
  const name     = document.getElementById('ca-name').value.trim();
  const type     = document.getElementById('ca-type').value;
  const parentId = parseInt(document.getElementById('ca-parent').value) || null;
  const isSummary= document.getElementById('ca-summary').checked ? 1 : 0;

  if (!code) { toast('El código es obligatorio', 'w'); return; }
  if (!name) { toast('El nombre es obligatorio', 'w'); return; }

  const data = { code, name, type, parent_id: parentId, is_summary: isSummary };
  const res  = id
    ? await window.api.accounting.updateAccount({ id, data, requestUserId: user.id })
    : await window.api.accounting.createAccount({ data, requestUserId: user.id });

  if (res?.ok) {
    toast(id ? 'Cuenta actualizada' : 'Cuenta creada', 's');
    closeModal();
    const body = document.getElementById('cont-body');
    if (body) { body.innerHTML = ''; await _contRenderCuentas(body); }
  } else {
    toast(res?.error || 'Error al guardar', 'e');
  }
};

window._deleteCuenta = async function(id) {
  if (!confirm('¿Eliminar esta cuenta? Solo se puede si no tiene movimientos.')) return;
  const res = await window.api.accounting.deleteAccount({ id, requestUserId: user.id });
  if (res?.ok) {
    toast('Cuenta eliminada', 's');
    const body = document.getElementById('cont-body');
    if (body) { body.innerHTML = ''; await _contRenderCuentas(body); }
  } else {
    toast(res?.error || 'No se puede eliminar: tiene movimientos', 'e');
  }
};

async function _printCatalogo(cuentas) {
  const biz   = DB?.settings?.biz_name || CFG.biz || 'Velo POS';
  const today = new Date().toLocaleDateString('es-DO');
  const rows  = cuentas.map(c =>
    `<tr><td style="padding-left:${(c.level||1)*12}px">${_esc(c.code)}</td><td>${_esc(c.name)}</td><td>${_esc(c.type)}</td><td style="text-align:right">${c.balance ? fmt(c.balance) : '—'}</td></tr>`
  ).join('');
  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:15px}table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left;font-size:10px}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}</style>
  </head><body>
  <h1>${biz} — Catálogo de Cuentas</h1><p style="color:#6b7280;font-size:10px">${today}</p>
  <table><thead><tr><th>Código</th><th>Nombre</th><th>Tipo</th><th style="text-align:right">Saldo</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// ASIENTOS CONTABLES
// ══════════════════════════════════════════════
async function _contRenderAsientos(el) {
  // Filtros
  const filterRow = h('div', { class: 'period-sel', style: { marginBottom: '14px' } },
    h('label', { class: 'lbl', style: { alignSelf: 'center', marginBottom: 0 } }, 'Desde:'),
    h('input', { type: 'date', id: 'as-from', value: _contFrom,
      onchange: e => { _contFrom = e.target.value; _reloadAsientos(); } }),
    h('label', { class: 'lbl', style: { alignSelf: 'center', marginBottom: 0 } }, 'Hasta:'),
    h('input', { type: 'date', id: 'as-to', value: _contTo,
      onchange: e => { _contTo = e.target.value; _reloadAsientos(); } }),
    h('button', { class: 'btn', onclick: _openNuevoAsientoModal }, '+ Nuevo asiento')
  );
  el.appendChild(filterRow);

  const body = h('div', { id: 'as-body' });
  el.appendChild(body);
  await _reloadAsientos();
}

async function _reloadAsientos() {
  const body = document.getElementById('as-body');
  if (!body) return;
  body.innerHTML = '';

  const res     = await window.api.accounting.getEntries({ from: _contFrom, to: _contTo, limit: 200 });
  const entries = res?.data || [];

  if (!entries.length) {
    body.appendChild(h('div', { class: 'empty' }, h('p', null, 'Sin asientos en el período')));
    return;
  }

  const tbl = h('table', { class: 'ledger-tbl', style: { width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', null, 'Número'),
      h('th', null, 'Fecha'),
      h('th', null, 'Descripción'),
      h('th', null, 'Tipo'),
      h('th', { class: 'num' }, 'Total'),
      h('th', null, 'Estado'),
      h('th', null, '')
    )),
    h('tbody', null, ...entries.map(e =>
      h('tr', null,
        h('td', null, h('span', { style: { fontFamily: 'DM Mono,monospace', fontSize: '11px' } }, e.number)),
        h('td', null, e.date),
        h('td', null, e.concept || '—'),
        h('td', null, e.source_module || 'manual'),
        h('td', { class: 'num' }, fmt(e.total_debit)),
        h('td', null, h('span', { class: `entry-status entry-status-${e.status}` }, e.status)),
        h('td', null, h('div', { style: { display: 'flex', gap: '4px' } },
          h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '2px 7px' },
            onclick: () => _openVerAsiento(e.id) }, 'Ver'),
          e.status === 'activo'
            ? h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '2px 7px', color: '#ef4444' },
                onclick: () => _reverseAsiento(e.id) }, 'Anular')
            : null
        ))
      )
    ))
  );
  body.appendChild(h('div', { class: 'tw' }, tbl));
}

async function _openVerAsiento(id) {
  const res   = await window.api.accounting.getEntryById({ id });
  const entry = res?.data;
  if (!entry) { toast('No se encontró el asiento', 'e'); return; }

  const linesHtml = (entry.lines || []).map(l => `
    <tr>
      <td>${l.account_code || ''}</td>
      <td>${l.account_name || ''}</td>
      <td style="text-align:right;color:#ef4444">${l.debit > 0 ? fmt(l.debit) : '—'}</td>
      <td style="text-align:right;color:#10b981">${l.credit > 0 ? fmt(l.credit) : '—'}</td>
      <td>${l.description || ''}</td>
    </tr>
  `).join('');

  openModal(`
    <div style="padding:24px;min-width:560px">
      <div class="modal-title">Asiento ${entry.number}</div>
      <div style="display:flex;gap:20px;font-size:12px;color:var(--muted2);margin:10px 0 16px">
        <span>Fecha: <strong style="color:var(--ink)">${entry.date}</strong></span>
        <span>Tipo: <strong style="color:var(--ink)">${entry.source_module || 'manual'}</strong></span>
        <span>Estado: <span class="entry-status entry-status-${entry.status}">${entry.status}</span></span>
      </div>
      <div style="font-size:13px;font-weight:500;margin-bottom:10px">${entry.concept || ''}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:var(--surface2)">
          <th style="padding:7px 10px;text-align:left;font-size:11px">Código</th>
          <th style="padding:7px 10px;text-align:left;font-size:11px">Cuenta</th>
          <th style="padding:7px 10px;text-align:right;font-size:11px">Debe</th>
          <th style="padding:7px 10px;text-align:right;font-size:11px">Haber</th>
          <th style="padding:7px 10px;text-align:left;font-size:11px">Detalle</th>
        </tr></thead>
        <tbody>${linesHtml}</tbody>
        <tfoot><tr style="background:var(--surface2);font-weight:700">
          <td colspan="2" style="padding:8px 10px">TOTALES</td>
          <td style="padding:8px 10px;text-align:right">${fmt(entry.total_debit)}</td>
          <td style="padding:8px 10px;text-align:right">${fmt(entry.total_credit)}</td>
          <td></td>
        </tr></tfoot>
      </table>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="print-btn" onclick="_printAsiento(${id})">🖨 Imprimir</button>
        <button class="btn-ghost" onclick="closeModal()">Cerrar</button>
      </div>
    </div>
  `);
}

window._printAsiento = async function(id) {
  const res   = await window.api.accounting.getEntryById({ id });
  const entry = res?.data;
  if (!entry) return;
  const biz   = DB?.settings?.biz_name || CFG.biz || 'Velo POS';
  const rows  = (entry.lines || []).map(l => `
    <tr><td>${_esc(l.account_code)}</td><td>${_esc(l.account_name)}</td>
    <td style="text-align:right">${l.debit>0?fmt(l.debit):'—'}</td>
    <td style="text-align:right">${l.credit>0?fmt(l.credit):'—'}</td>
    <td>${_esc(l.description)}</td></tr>
  `).join('');
  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px}table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  .tot{font-weight:700;background:#f3f4f6}</style></head><body>
  <h1>${_esc(biz)} — Asiento Contable ${_esc(entry.number)}</h1>
  <p style="color:#6b7280;font-size:10px">Fecha: ${entry.date} · ${_esc(entry.concept)} · Estado: ${_esc(entry.status)}</p>
  <table><thead><tr><th>Código</th><th>Cuenta</th><th style="text-align:right">Debe</th><th style="text-align:right">Haber</th><th>Detalle</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr class="tot"><td colspan="2">TOTALES</td>
  <td style="text-align:right">${fmt(entry.total_debit)}</td>
  <td style="text-align:right">${fmt(entry.total_credit)}</td><td></td></tr></tfoot>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
};

window._reverseAsiento = async function(id) {
  const reason = prompt('Razón de la anulación:');
  if (!reason) return;
  const res = await window.api.accounting.reverseEntry({ id, reason, requestUserId: user.id });
  if (res?.ok) {
    toast('Asiento anulado y reversión creada', 's');
    closeModal();
    await _reloadAsientos();
  } else {
    toast(res?.error || 'Error al anular', 'e');
  }
};

async function _openNuevoAsientoModal() {
  const acctRes = await window.api.accounting.getAccounts();
  const accts   = (acctRes?.data || []).filter(c => !c.is_summary);

  const optionsHtml = accts.map(a =>
    `<option value="${a.id}" data-code="${a.code}" data-type="${a.type}">${a.code} - ${a.name}</option>`
  ).join('');

  openModal(`
    <div style="padding:24px;min-width:640px">
      <div class="modal-title">Nuevo asiento contable</div>
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label class="lbl">Fecha *</label>
            <input id="ne-date" class="inp" type="date" value="${_isoDate(0)}">
          </div>
          <div>
            <label class="lbl">Tipo</label>
            <select id="ne-type" class="inp">
              <option value="manual">Manual</option>
              <option value="ajuste">Ajuste</option>
              <option value="apertura">Apertura</option>
              <option value="cierre">Cierre</option>
            </select>
          </div>
        </div>
        <div>
          <label class="lbl">Descripción *</label>
          <input id="ne-desc" class="inp" placeholder="Descripción del asiento">
        </div>
        <div>
          <label class="lbl" style="margin-bottom:6px">Líneas del asiento</label>
          <div class="entry-lines">
            <div class="entry-line-hdr">
              <span>Cuenta</span><span>Descripción</span><span style="text-align:right">Debe</span><span style="text-align:right">Haber</span><span></span>
            </div>
            <div id="ne-lines"></div>
          </div>
          <button class="btn-ghost" style="font-size:12px;margin-top:4px" onclick="_addEntryLine('${optionsHtml.replace(/'/g, "\\'")}')">+ Agregar línea</button>
        </div>
        <div id="ne-balance" class="balance-bar" style="display:none"></div>
        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn" onclick="_saveAsiento()">Crear asiento</button>
          <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </div>
    </div>
  `, 'lg');

  // Agregar 2 líneas por defecto
  window._entryLineOptsHtml = optionsHtml;
  window._addEntryLine(optionsHtml);
  window._addEntryLine(optionsHtml);
}

window._addEntryLine = function(optsHtml) {
  const container = document.getElementById('ne-lines');
  if (!container) return;
  const idx = container.children.length;
  const row = document.createElement('div');
  row.className = 'entry-line-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <select class="ne-acct" onchange="_updateEntryBalance()">
      <option value="">— Cuenta —</option>
      ${optsHtml || window._entryLineOptsHtml || ''}
    </select>
    <input class="ne-ldesc" placeholder="Descripción" style="padding:5px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink);font-size:12px;width:100%">
    <input class="ne-debit"  type="number" min="0" step="0.01" placeholder="0.00"
      style="padding:5px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink);font-size:12px;width:100%;text-align:right"
      oninput="this.closest('.entry-line-row').querySelector('.ne-credit').value='';_updateEntryBalance()">
    <input class="ne-credit" type="number" min="0" step="0.01" placeholder="0.00"
      style="padding:5px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink);font-size:12px;width:100%;text-align:right"
      oninput="this.closest('.entry-line-row').querySelector('.ne-debit').value='';_updateEntryBalance()">
    <button onclick="this.closest('.entry-line-row').remove();_updateEntryBalance()"
      style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:16px;padding:0 4px">×</button>
  `;
  container.appendChild(row);
};

window._updateEntryBalance = function() {
  const container = document.getElementById('ne-lines');
  const balEl     = document.getElementById('ne-balance');
  if (!container || !balEl) return;
  let debe = 0, haber = 0;
  container.querySelectorAll('.entry-line-row').forEach(row => {
    debe  += parseFloat(row.querySelector('.ne-debit')?.value  || 0) || 0;
    haber += parseFloat(row.querySelector('.ne-credit')?.value || 0) || 0;
  });
  const ok = Math.abs(debe - haber) <= 0.01;
  balEl.style.display = 'flex';
  balEl.className = `balance-bar ${ok ? 'ok' : 'err'}`;
  balEl.textContent = ok
    ? `✓ Balanceado — Debe: ${fmt(debe)} · Haber: ${fmt(haber)}`
    : `✗ No balanceado — Debe: ${fmt(debe)} · Haber: ${fmt(haber)} · Diferencia: ${fmt(Math.abs(debe-haber))}`;
};

window._saveAsiento = async function() {
  const date    = document.getElementById('ne-date').value;
  const type    = document.getElementById('ne-type').value;
  const desc    = document.getElementById('ne-desc').value.trim();
  const container = document.getElementById('ne-lines');

  if (!date)  { toast('La fecha es obligatoria', 'w'); return; }
  if (!desc)  { toast('La descripción es obligatoria', 'w'); return; }

  const lines = [];
  let ok = true;
  container?.querySelectorAll('.entry-line-row').forEach(row => {
    const acctId = parseInt(row.querySelector('.ne-acct')?.value) || 0;
    const debit  = parseFloat(row.querySelector('.ne-debit')?.value  || 0) || 0;
    const credit = parseFloat(row.querySelector('.ne-credit')?.value || 0) || 0;
    const ldesc  = row.querySelector('.ne-ldesc')?.value?.trim() || '';
    if (!acctId) { ok = false; return; }
    if (debit > 0 || credit > 0) lines.push({ account_id: acctId, debit, credit, description: ldesc });
  });

  if (!ok)            { toast('Todas las líneas deben tener una cuenta', 'w'); return; }
  if (lines.length < 2) { toast('Mínimo 2 líneas por asiento', 'w'); return; }

  const totalD = lines.reduce((s, l) => s + l.debit,  0);
  const totalC = lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalD - totalC) > 0.01) {
    toast('El asiento no está balanceado (Debe ≠ Haber)', 'e'); return;
  }

  const res = await window.api.accounting.createEntry({
    data: { date, type, description: desc, lines, userId: user.id },
    requestUserId: user.id
  });

  if (res?.ok) {
    toast(`Asiento ${res.data?.number} creado`, 's');
    closeModal();
    await _reloadAsientos();
  } else {
    toast(res?.error || 'Error al crear asiento', 'e');
  }
};

// ══════════════════════════════════════════════
// MAYOR CONTABLE
// ══════════════════════════════════════════════
async function _contRenderMayor(el) {
  const acctRes = await window.api.accounting.getAccounts();
  const accts   = (acctRes?.data || []).filter(c => !c.is_summary);

  let selAcct   = accts[0]?.id || null;

  const controls = h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap', alignItems: 'flex-end' } });
  const acctSel  = h('select', { class: 'inp', style: { maxWidth: '300px' },
    onchange: e => { selAcct = parseInt(e.target.value); _reloadMayor(); }
  }, ...accts.map(a => h('option', { value: a.id }, `${a.code} - ${a.name}`)));

  const fromIn = h('input', { type: 'date', class: 'inp', style: { maxWidth: '150px' }, value: _contFrom,
    onchange: e => { _contFrom = e.target.value; _reloadMayor(); } });
  const toIn   = h('input', { type: 'date', class: 'inp', style: { maxWidth: '150px' }, value: _contTo,
    onchange: e => { _contTo = e.target.value; _reloadMayor(); } });

  controls.appendChild(h('div', null,
    h('label', { class: 'lbl', style: { display: 'block', marginBottom: '3px' } }, 'Cuenta'),
    acctSel
  ));
  controls.appendChild(h('div', null, h('label', { class: 'lbl', style: { display: 'block', marginBottom: '3px' } }, 'Desde'), fromIn));
  controls.appendChild(h('div', null, h('label', { class: 'lbl', style: { display: 'block', marginBottom: '3px' } }, 'Hasta'), toIn));
  controls.appendChild(h('button', { class: 'print-btn', style: { alignSelf: 'flex-end' },
    onclick: () => _printMayor(selAcct) }, '🖨 Imprimir'));
  el.appendChild(controls);

  const body = h('div', { id: 'mayor-body' });
  el.appendChild(body);

  window._mayorSelAcct = selAcct;
  await _reloadMayor();
}

async function _reloadMayor() {
  const body = document.getElementById('mayor-body');
  if (!body) return;
  body.innerHTML = '';
  const acctId = window._mayorSelAcct;
  if (!acctId) return;

  const res    = await window.api.accounting.getLedger({ accountId: acctId, from: _contFrom, to: _contTo });
  const ledger = res?.data || {};

  body.appendChild(h('div', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '8px' } },
    `${ledger.account?.code || ''} - ${ledger.account?.name || ''}`));

  const lines = ledger.lines || [];
  if (!lines.length) {
    body.appendChild(h('div', { class: 'empty' }, h('p', null, 'Sin movimientos en el período')));
    return;
  }

  const tbl = h('table', { class: 'ledger-tbl', style: { width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', null, 'Fecha'),
      h('th', null, 'Asiento'),
      h('th', null, 'Descripción'),
      h('th', { class: 'num' }, 'Debe'),
      h('th', { class: 'num' }, 'Haber'),
      h('th', { class: 'num' }, 'Saldo')
    )),
    h('tbody', null, ...lines.map(l =>
      h('tr', null,
        h('td', null, l.date),
        h('td', null, h('span', { style: { fontFamily: 'DM Mono,monospace', fontSize: '11px' } }, l.entry_number)),
        h('td', null, l.description || '—'),
        h('td', { class: 'num debit' },   l.debit  > 0 ? fmt(l.debit)  : '—'),
        h('td', { class: 'num credit' },  l.credit > 0 ? fmt(l.credit) : '—'),
        h('td', { class: 'num' }, fmt(l.running_balance))
      )
    )),
    h('tfoot', null, h('tr', null,
      h('td', { colspan: '3' }, 'TOTALES'),
      h('td', { class: 'num debit' },  fmt(ledger.total_debit  || 0)),
      h('td', { class: 'num credit' }, fmt(ledger.total_credit || 0)),
      h('td', { class: 'num' }, fmt(ledger.closing_balance || 0))
    ))
  );
  body.appendChild(h('div', { class: 'tw' }, tbl));
}

async function _printMayor(acctId) {
  const res    = await window.api.accounting.getLedger({ accountId: acctId, from: _contFrom, to: _contTo });
  const ledger = res?.data || {};
  const biz    = DB?.settings?.biz_name || CFG.biz || 'Velo POS';
  const rows   = (ledger.lines || []).map(l => `
    <tr><td>${l.date}</td><td>${_esc(l.entry_number)}</td><td>${_esc(l.description)}</td>
    <td style="text-align:right">${l.debit>0?fmt(l.debit):'—'}</td>
    <td style="text-align:right">${l.credit>0?fmt(l.credit):'—'}</td>
    <td style="text-align:right">${fmt(l.running_balance)}</td></tr>
  `).join('');
  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px}table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  tfoot td{font-weight:700;background:#f3f4f6}</style></head><body>
  <h1>${_esc(biz)} — Mayor: ${_esc(ledger.account?.code)} - ${_esc(ledger.account?.name)}</h1>
  <p style="color:#6b7280;font-size:10px">${_contFrom} al ${_contTo}</p>
  <table><thead><tr><th>Fecha</th><th>Asiento</th><th>Descripción</th>
  <th style="text-align:right">Debe</th><th style="text-align:right">Haber</th><th style="text-align:right">Saldo</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="3">TOTALES</td>
  <td style="text-align:right">${fmt(ledger.total_debit||0)}</td>
  <td style="text-align:right">${fmt(ledger.total_credit||0)}</td>
  <td style="text-align:right">${fmt(ledger.closing_balance||0)}</td></tr></tfoot>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// BALANCE DE COMPROBACIÓN
// ══════════════════════════════════════════════
async function _contRenderBalance(el) {
  const hdr = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' } },
    h('div', { class: 'period-sel' },
      h('label', { class: 'lbl', style: { alignSelf: 'center', marginBottom: 0 } }, 'Al:'),
      h('input', { type: 'date', id: 'tb-asof', value: _contTo, class: 'inp', style: { maxWidth: '150px' },
        onchange: async e => {
          const body = document.getElementById('tb-body');
          if (body) { body.innerHTML = ''; await _loadTrialBalance(body, e.target.value); }
        }
      })
    ),
    h('button', { class: 'print-btn', onclick: () => _printTrialBalance() }, '🖨 Imprimir')
  );
  el.appendChild(hdr);
  const body = h('div', { id: 'tb-body' });
  el.appendChild(body);
  await _loadTrialBalance(body, _contTo);
}

async function _loadTrialBalance(el, asOf) {
  const res  = await window.api.accounting.getTrialBalance({ asOf });
  const data = res?.data || [];

  if (!data.length) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'Sin datos')));
    return;
  }

  let totalD = 0, totalC = 0;
  const tbl = h('table', { class: 'trial-tbl', style: { width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', null, 'Código'),
      h('th', null, 'Cuenta'),
      h('th', { class: 'num' }, 'Debe'),
      h('th', { class: 'num' }, 'Haber')
    )),
    h('tbody', null, ...data.map(row => {
      totalD += row.debit  || 0;
      totalC += row.credit || 0;
      return h('tr', null,
        h('td', { class: 'acct-code' }, row.code),
        h('td', { class: 'acct-name' }, row.name),
        h('td', { class: 'num' }, (row.debit  || 0) > 0 ? fmt(row.debit)  : '—'),
        h('td', { class: 'num' }, (row.credit || 0) > 0 ? fmt(row.credit) : '—')
      );
    })),
    h('tfoot', null, h('tr', null,
      h('td', { colspan: '2', style: { padding: '10px' } }, 'TOTALES'),
      h('td', { class: 'num', style: { padding: '10px' } }, fmt(totalD)),
      h('td', { class: 'num', style: { padding: '10px' } }, fmt(totalC))
    ))
  );
  el.appendChild(h('div', { class: 'tw' }, tbl));

  const balanced = Math.abs(totalD - totalC) <= 0.01;
  el.appendChild(h('div', { class: `balance-bar ${balanced ? 'ok' : 'err'}`, style: { marginTop: '12px', maxWidth: '500px' } },
    balanced ? '✓ Contabilidad balanceada' : `✗ Diferencia: ${fmt(Math.abs(totalD - totalC))}`
  ));
}

async function _printTrialBalance() {
  const asOf = document.getElementById('tb-asof')?.value || _contTo;
  const res  = await window.api.accounting.getTrialBalance({ asOf });
  const data = res?.data || [];
  const biz  = DB?.settings?.biz_name || CFG.biz || 'Velo POS';

  let totalD = 0, totalC = 0;
  const rows = data.map(row => {
    totalD += row.debit || 0; totalC += row.credit || 0;
    return `<tr><td>${_esc(row.code)}</td><td>${_esc(row.name)}</td>
    <td style="text-align:right">${(row.debit||0)>0?fmt(row.debit):'—'}</td>
    <td style="text-align:right">${(row.credit||0)>0?fmt(row.credit):'—'}</td></tr>`;
  }).join('');

  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px}table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  tfoot td{font-weight:700;background:#f3f4f6}</style></head><body>
  <h1>${biz} — Balance de Comprobación al ${asOf}</h1>
  <table><thead><tr><th>Código</th><th>Cuenta</th><th style="text-align:right">Debe</th><th style="text-align:right">Haber</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="2">TOTALES</td>
  <td style="text-align:right">${fmt(totalD)}</td><td style="text-align:right">${fmt(totalC)}</td></tr></tfoot>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// ESTADO DE RESULTADOS
// ══════════════════════════════════════════════
async function _contRenderResultados(el) {
  const controls = h('div', { class: 'period-sel', style: { marginBottom: '16px', justifyContent: 'space-between', flexWrap: 'wrap' } },
    h('div', { class: 'period-sel' },
      h('label', { class: 'lbl', style: { alignSelf: 'center', marginBottom: 0 } }, 'Desde:'),
      h('input', { type: 'date', id: 'er-from', value: _contFrom, class: 'inp', style: { maxWidth: '150px' },
        onchange: async e => { _contFrom = e.target.value; await _reloadResultados(); } }),
      h('label', { class: 'lbl', style: { alignSelf: 'center', marginBottom: 0 } }, 'Hasta:'),
      h('input', { type: 'date', id: 'er-to', value: _contTo, class: 'inp', style: { maxWidth: '150px' },
        onchange: async e => { _contTo = e.target.value; await _reloadResultados(); } })
    ),
    h('button', { class: 'print-btn', onclick: _printResultados }, '🖨 Imprimir')
  );
  el.appendChild(controls);
  const body = h('div', { id: 'er-body' });
  el.appendChild(body);
  await _reloadResultados();
}

async function _reloadResultados() {
  const body = document.getElementById('er-body');
  if (!body) return;
  body.innerHTML = '';
  const res = await window.api.accounting.getIncomeStatement({ from: _contFrom, to: _contTo });
  const rpt = res?.data || {};

  const wrap = h('div', { class: 'fin-report' });

  function section(title, items, subtotal) {
    const sec = h('div', { class: 'fin-report-section' },
      h('div', { class: 'fin-report-title' }, title)
    );
    (items || []).forEach(it => {
      sec.appendChild(h('div', { class: 'fin-report-row' },
        h('span', null, it.name),
        h('span', { class: 'amount' }, fmt(it.amount))
      ));
    });
    if (subtotal !== undefined) {
      sec.appendChild(h('div', { class: 'fin-report-row total' },
        h('span', null, 'Total ' + title),
        h('span', { class: 'amount' }, fmt(subtotal))
      ));
    }
    return sec;
  }

  wrap.appendChild(h('div', { style: { textAlign: 'center', marginBottom: '16px' } },
    h('div', { style: { fontWeight: '700', fontSize: '15px' } }, DB?.settings?.biz_name || CFG.biz || 'Velo POS'),
    h('div', { style: { fontSize: '13px', fontWeight: '600', margin: '4px 0 2px' } }, 'Estado de Resultados'),
    h('div', { style: { fontSize: '12px', color: 'var(--muted2)' } }, `${_contFrom} al ${_contTo}`)
  ));

  wrap.appendChild(section('Ingresos', rpt.revenue_items, rpt.total_revenue));
  wrap.appendChild(section('Costo de Ventas', rpt.cogs_items, rpt.total_cogs));

  wrap.appendChild(h('div', { class: 'fin-report-row group' },
    h('span', null, 'UTILIDAD BRUTA'),
    h('span', { class: 'amount', style: { color: (rpt.gross_profit||0) >= 0 ? '#10b981' : '#ef4444' } },
      fmt(rpt.gross_profit || 0))
  ));

  wrap.appendChild(section('Gastos Operativos', rpt.expense_items, rpt.total_expenses));

  const netColor = (rpt.net_income||0) >= 0 ? '#10b981' : '#ef4444';
  wrap.appendChild(h('div', { class: 'fin-report-row total', style: { borderColor: netColor } },
    h('span', null, 'UTILIDAD NETA'),
    h('span', { class: 'amount', style: { color: netColor } }, fmt(rpt.net_income || 0))
  ));

  body.appendChild(wrap);
}

async function _printResultados() {
  const res = await window.api.accounting.getIncomeStatement({ from: _contFrom, to: _contTo });
  const rpt = res?.data || {};
  const biz = DB?.settings?.biz_name || CFG.biz || 'Velo POS';

  function rows(items) {
    return (items||[]).map(it => `<tr><td style="padding-left:20px">${_esc(it.name)}</td><td style="text-align:right">${fmt(it.amount)}</td></tr>`).join('');
  }

  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px;text-align:center}
  .sub{text-align:center;color:#6b7280;font-size:10px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  .ttl{font-weight:700;background:#f3f4f6}.net{font-weight:800;font-size:13px;background:#dcfce7}</style>
  </head><body>
  <h1>${_esc(biz)}</h1><p class="sub">Estado de Resultados · ${_contFrom} al ${_contTo}</p>
  <table>
    <tr style="background:#f3f4f6"><td colspan="2"><strong>INGRESOS</strong></td></tr>
    ${rows(rpt.revenue_items)}
    <tr class="ttl"><td>Total Ingresos</td><td style="text-align:right">${fmt(rpt.total_revenue||0)}</td></tr>
    <tr style="background:#f3f4f6"><td colspan="2"><strong>COSTO DE VENTAS</strong></td></tr>
    ${rows(rpt.cogs_items)}
    <tr class="ttl"><td>Total Costo de Ventas</td><td style="text-align:right">${fmt(rpt.total_cogs||0)}</td></tr>
    <tr class="ttl"><td>UTILIDAD BRUTA</td><td style="text-align:right">${fmt(rpt.gross_profit||0)}</td></tr>
    <tr style="background:#f3f4f6"><td colspan="2"><strong>GASTOS OPERATIVOS</strong></td></tr>
    ${rows(rpt.expense_items)}
    <tr class="ttl"><td>Total Gastos</td><td style="text-align:right">${fmt(rpt.total_expenses||0)}</td></tr>
    <tr class="net"><td>UTILIDAD NETA</td><td style="text-align:right">${fmt(rpt.net_income||0)}</td></tr>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// BALANCE GENERAL
// ══════════════════════════════════════════════
async function _contRenderGeneral(el) {
  const controls = h('div', { class: 'period-sel', style: { marginBottom: '16px', justifyContent: 'space-between', flexWrap: 'wrap' } },
    h('div', { class: 'period-sel' },
      h('label', { class: 'lbl', style: { alignSelf: 'center', marginBottom: 0 } }, 'Al:'),
      h('input', { type: 'date', id: 'bg-asof', value: _contTo, class: 'inp', style: { maxWidth: '150px' },
        onchange: async e => { _contTo = e.target.value; await _reloadGeneral(); } })
    ),
    h('button', { class: 'print-btn', onclick: _printGeneral }, '🖨 Imprimir')
  );
  el.appendChild(controls);
  const body = h('div', { id: 'bg-body' });
  el.appendChild(body);
  await _reloadGeneral();
}

async function _reloadGeneral() {
  const body = document.getElementById('bg-body');
  if (!body) return;
  body.innerHTML = '';
  const res = await window.api.accounting.getBalanceSheet({ asOf: _contTo });
  const rpt = res?.data || {};

  const wrap = h('div', { class: 'fin-report' });
  wrap.appendChild(h('div', { style: { textAlign: 'center', marginBottom: '16px' } },
    h('div', { style: { fontWeight: '700', fontSize: '15px' } }, DB?.settings?.biz_name || CFG.biz || 'Velo POS'),
    h('div', { style: { fontSize: '13px', fontWeight: '600', margin: '4px 0 2px' } }, 'Balance General'),
    h('div', { style: { fontSize: '12px', color: 'var(--muted2)' } }, `Al ${_contTo}`)
  ));

  function section(title, items, total) {
    const sec = h('div', { class: 'fin-report-section' },
      h('div', { class: 'fin-report-title' }, title)
    );
    (items || []).forEach(it => {
      sec.appendChild(h('div', { class: 'fin-report-row' },
        h('span', null, `${it.code || ''} ${it.name}`),
        h('span', { class: 'amount' }, fmt(it.balance))
      ));
    });
    sec.appendChild(h('div', { class: 'fin-report-row total' },
      h('span', null, 'Total ' + title),
      h('span', { class: 'amount' }, fmt(total || 0))
    ));
    return sec;
  }

  wrap.appendChild(section('Activos', rpt.asset_items, rpt.total_assets));
  wrap.appendChild(section('Pasivos', rpt.liability_items, rpt.total_liabilities));
  wrap.appendChild(section('Capital', rpt.equity_items, rpt.total_equity));

  const balanced = Math.abs((rpt.total_assets||0) - ((rpt.total_liabilities||0) + (rpt.total_equity||0))) <= 0.01;
  wrap.appendChild(h('div', { class: `balance-bar ${balanced ? 'ok' : 'err'}`, style: { marginTop: '12px' } },
    balanced ? '✓ Activos = Pasivos + Capital' : `✗ No cuadra: Activos ${fmt(rpt.total_assets||0)} ≠ Pasivos+Capital ${fmt((rpt.total_liabilities||0)+(rpt.total_equity||0))}`
  ));

  body.appendChild(wrap);
}

async function _printGeneral() {
  const res = await window.api.accounting.getBalanceSheet({ asOf: _contTo });
  const rpt = res?.data || {};
  const biz = DB?.settings?.biz_name || CFG.biz || 'Velo POS';

  function rows(items) {
    return (items||[]).map(it => `<tr><td style="padding-left:20px">${_esc(it.code)} ${_esc(it.name)}</td><td style="text-align:right">${fmt(it.balance)}</td></tr>`).join('');
  }

  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px;text-align:center}
  .sub{text-align:center;color:#6b7280;font-size:10px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  .ttl{font-weight:700;background:#f3f4f6}</style></head><body>
  <h1>${_esc(biz)}</h1><p class="sub">Balance General · Al ${_contTo}</p>
  <table>
    <tr style="background:#f3f4f6"><td colspan="2"><strong>ACTIVOS</strong></td></tr>
    ${rows(rpt.asset_items)}
    <tr class="ttl"><td>Total Activos</td><td style="text-align:right">${fmt(rpt.total_assets||0)}</td></tr>
    <tr style="background:#f3f4f6"><td colspan="2"><strong>PASIVOS</strong></td></tr>
    ${rows(rpt.liability_items)}
    <tr class="ttl"><td>Total Pasivos</td><td style="text-align:right">${fmt(rpt.total_liabilities||0)}</td></tr>
    <tr style="background:#f3f4f6"><td colspan="2"><strong>CAPITAL</strong></td></tr>
    ${rows(rpt.equity_items)}
    <tr class="ttl"><td>Total Capital</td><td style="text-align:right">${fmt(rpt.total_equity||0)}</td></tr>
    <tr class="ttl" style="font-size:12px"><td>TOTAL PASIVOS + CAPITAL</td>
    <td style="text-align:right">${fmt((rpt.total_liabilities||0)+(rpt.total_equity||0))}</td></tr>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// CUENTAS POR COBRAR (CxC)
// ══════════════════════════════════════════════
async function _contRenderCxC(el) {
  const customers = DB.customers || [];
  const withCredit = customers.filter(c => (c.balance || 0) > 0);

  const hdr = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' } },
    h('div', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--ink)' } }, `Clientes con saldo pendiente (${withCredit.length})`),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'print-btn', onclick: () => _printCxC(withCredit) }, '🖨 Imprimir'),
      h('button', { class: 'btn-ghost', onclick: () => routeTo('clientes') }, 'Ir a Clientes')
    )
  );
  el.appendChild(hdr);

  if (!withCredit.length) {
    el.appendChild(h('div', { class: 'empty' },
      h('p', null, 'No hay cuentas por cobrar'),
      h('span', null, 'Todos los clientes están al día')
    ));
    return;
  }

  const total = withCredit.reduce((s, c) => s + (c.balance || 0), 0);

  const tbl = h('table', { class: 'ledger-tbl', style: { width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', null, 'Cliente'),
      h('th', null, 'Teléfono'),
      h('th', null, 'Límite crédito'),
      h('th', { class: 'num' }, 'Saldo pendiente'),
      h('th', null, '')
    )),
    h('tbody', null, ...withCredit.map(c =>
      h('tr', null,
        h('td', null, c.name),
        h('td', null, c.phone || '—'),
        h('td', null, c.credit_limit > 0 ? fmt(c.credit_limit) : 'Sin límite'),
        h('td', { class: 'num', style: { color: '#ef4444', fontWeight: '600' } }, fmt(c.balance)),
        h('td', null, h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px' },
          onclick: () => routeTo('clientes') }, 'Ver'))
      )
    )),
    h('tfoot', null, h('tr', null,
      h('td', { colspan: '3' }, 'TOTAL CxC'),
      h('td', { class: 'num', style: { color: '#ef4444', fontWeight: '700' } }, fmt(total)),
      h('td', null)
    ))
  );

  el.appendChild(h('div', { class: 'tw' }, tbl));
}

async function _printCxC(customers) {
  const biz   = DB?.settings?.biz_name || CFG.biz || 'Velo POS';
  const today = new Date().toLocaleDateString('es-DO');
  const total = customers.reduce((s, c) => s + (c.balance||0), 0);
  const rows  = customers.map(c =>
    `<tr><td>${_esc(c.name)}</td><td>${_esc(c.phone)||'—'}</td><td>${c.credit_limit>0?fmt(c.credit_limit):'—'}</td><td style="text-align:right">${fmt(c.balance)}</td></tr>`
  ).join('');
  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px}table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  tfoot td{font-weight:700;background:#f3f4f6}</style></head><body>
  <h1>${_esc(biz)} — Cuentas por Cobrar</h1><p style="color:#6b7280;font-size:10px">${today}</p>
  <table><thead><tr><th>Cliente</th><th>Teléfono</th><th>Límite</th><th style="text-align:right">Saldo</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="3">TOTAL</td><td style="text-align:right">${fmt(total)}</td></tr></tfoot>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// CUENTAS POR PAGAR (CxP)
// ══════════════════════════════════════════════
async function _contRenderCxP(el) {
  const [expRes, supRes] = await Promise.all([
    window.api.expenses.getPayable ? window.api.expenses.getPayable({}) : Promise.resolve({ data: [] }),
    window.api.suppliers.getAll(),
  ]);

  const payable  = expRes?.data  || [];
  const suppliers = supRes?.data || [];

  const hdr = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' } },
    h('div', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--ink)' } }, `Obligaciones pendientes (${payable.length})`),
    h('button', { class: 'print-btn', onclick: () => _printCxP(payable) }, '🖨 Imprimir')
  );
  el.appendChild(hdr);

  if (!payable.length) {
    el.appendChild(h('div', { class: 'empty' },
      h('p', null, 'No hay cuentas por pagar pendientes'),
      h('span', null, 'Todos los gastos están pagados')
    ));
  } else {
    const total = payable.reduce((s, e) => s + (e.amount || 0), 0);
    const tbl = h('table', { class: 'ledger-tbl', style: { width: '100%' } },
      h('thead', null, h('tr', null,
        h('th', null, 'Gasto'),
        h('th', null, 'Proveedor'),
        h('th', null, 'Categoría'),
        h('th', null, 'Vencimiento'),
        h('th', { class: 'num' }, 'Monto'),
        h('th', null, 'Estado'),
        h('th', null, '')
      )),
      h('tbody', null, ...payable.map(e => {
        const sup = suppliers.find(s => s.id === e.supplier_id);
        return h('tr', null,
          h('td', null, e.description || e.title || '—'),
          h('td', null, sup?.name || e.supplier_name || '—'),
          h('td', null, e.category || '—'),
          h('td', null, e.due_date || '—'),
          h('td', { class: 'num', style: { color: '#ef4444', fontWeight: '600' } }, fmt(e.amount)),
          h('td', null, h('span', { class: `entry-status entry-status-${e.status === 'pendiente' ? 'borrador' : 'activo'}` }, e.status)),
          h('td', null, h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px' },
            onclick: () => routeTo('gastos') }, 'Ver'))
        );
      })),
      h('tfoot', null, h('tr', null,
        h('td', { colspan: '4' }, 'TOTAL CxP'),
        h('td', { class: 'num', style: { color: '#ef4444', fontWeight: '700' } }, fmt(total)),
        h('td', null), h('td', null)
      ))
    );
    el.appendChild(h('div', { class: 'tw' }, tbl));
  }
}

async function _printCxP(payable) {
  const biz   = DB?.settings?.biz_name || CFG.biz || 'Velo POS';
  const today = new Date().toLocaleDateString('es-DO');
  const total = payable.reduce((s, e) => s + (e.amount||0), 0);
  const rows  = payable.map(e =>
    `<tr><td>${_esc(e.description||e.title)||'—'}</td><td>${_esc(e.supplier_name)||'—'}</td><td>${_esc(e.category)||'—'}</td><td>${e.due_date||'—'}</td><td style="text-align:right">${fmt(e.amount)}</td><td>${_esc(e.status)}</td></tr>`
  ).join('');
  const html = `<html><head><meta charset="UTF-8">
  <style>body{font-family:Arial;font-size:11px;margin:20px}h1{font-size:14px}table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  tfoot td{font-weight:700;background:#f3f4f6}</style></head><body>
  <h1>${_esc(biz)} — Cuentas por Pagar</h1><p style="color:#6b7280;font-size:10px">${today}</p>
  <table><thead><tr><th>Gasto</th><th>Proveedor</th><th>Categoría</th><th>Vencimiento</th><th style="text-align:right">Monto</th><th>Estado</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="4">TOTAL</td><td style="text-align:right">${fmt(total)}</td><td></td></tr></tfoot>
  </table></body></html>`;
  printHTML(html, 'contabilidad');
}

// ══════════════════════════════════════════════
// CONFIGURACIÓN CONTABLE
// ══════════════════════════════════════════════
async function _contRenderConfig(el) {
  const [cfgRes, acctRes] = await Promise.all([
    window.api.accounting.getConfig(),
    window.api.accounting.getAccounts(),
  ]);
  const cfg   = cfgRes?.data   || {};
  const accts = (acctRes?.data || []).filter(c => !c.is_summary);

  const opts  = accts.map(a => `<option value="${a.id}">${a.code} - ${a.name}</option>`).join('');

  const cfgKeys = [
    { key: 'account_cash',       label: 'Cuenta Efectivo (Caja)' },
    { key: 'account_bank',       label: 'Cuenta Banco' },
    { key: 'account_ar',         label: 'Cuentas por Cobrar' },
    { key: 'account_ap',         label: 'Cuentas por Pagar' },
    { key: 'account_inventory',  label: 'Inventario' },
    { key: 'account_revenue',    label: 'Ingresos por Ventas' },
    { key: 'account_cogs',       label: 'Costo de Mercancía Vendida' },
    { key: 'account_tax_payable',label: 'ITBIS por Pagar' },
    { key: 'account_expense',    label: 'Cuenta Gastos General' },
    { key: 'account_discount',   label: 'Descuentos en Ventas' },
  ];

  el.appendChild(h('div', { style: { maxWidth: '560px' } },
    h('div', { style: { fontSize: '13px', fontWeight: '600', marginBottom: '16px' } }, 'Mapeo de cuentas contables'),
    h('div', { style: { background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' } },
      ...cfgKeys.map(item => {
        const cur = cfg[item.key];
        return h('div', null,
          h('label', { class: 'lbl' }, item.label),
          h('select', { class: 'inp', id: `cfg-${item.key}`, 'data-key': item.key },
            h('option', { value: '' }, '— Selecciona cuenta —'),
            ...accts.map(a => {
              const sel = (cur && (parseInt(cur) === a.id || cur === a.code)) ? { selected: true } : {};
              return h('option', { value: a.id, ...sel }, `${a.code} - ${a.name}`);
            })
          )
        );
      }),
      h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: _saveContConfig }, 'Guardar configuración')
    ),

    h('div', { style: { marginTop: '20px', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: '12px', padding: '20px' } },
      h('div', { style: { fontSize: '13px', fontWeight: '600', marginBottom: '12px' } }, 'Sincronización'),
      h('div', { style: { fontSize: '12px', color: 'var(--muted2)', marginBottom: '12px' } },
        'Genera asientos contables automáticos para ventas y gastos históricos que aún no tienen asiento.'),
      h('button', { class: 'btn-ghost', onclick: async () => {
        const r = await window.api.accounting.syncHistorical({ requestUserId: user.id });
        toast(r?.ok ? `${r.data?.created || 0} asientos generados` : (r?.error || 'Error'), r?.ok ? 's' : 'e');
      }}, '🔄 Sincronizar histórico')
    )
  ));
}

async function _saveContConfig() {
  const keys = ['account_cash','account_bank','account_ar','account_ap','account_inventory',
    'account_revenue','account_cogs','account_tax_payable','account_expense','account_discount'];

  let ok = true;
  for (const key of keys) {
    const el  = document.getElementById(`cfg-${key}`);
    const val = el?.value;
    if (!val) continue;
    const res = await window.api.accounting.setConfig({ key, value: val, requestUserId: user.id });
    if (!res?.ok) { ok = false; toast(res?.error || `Error en ${key}`, 'e'); }
  }
  if (ok) toast('Configuración guardada', 's');
}
