// ══════════════════════════════════════════════
// bancos.js — Módulo de Cuentas Financieras
// Caja, Banco, Tarjeta, Transferencias
// ══════════════════════════════════════════════

let _bancosTab  = 'cuentas';
let _bancosAcct = null; // cuenta seleccionada para movimientos

async function renderBancos(el) {
  el.innerHTML = '';

  if (!['admin','superadmin'].includes(user?.role)) {
    el.innerHTML = '<div class="empty"><p>Acceso restringido</p></div>';
    return;
  }

  const wrap = h('div', { style: { padding: '20px', maxWidth: '1100px', margin: '0 auto' } });
  el.appendChild(wrap);

  // Tabs
  const tabs = h('div', { class: 'mod-tabs' });
  [
    { key: 'cuentas',         label: 'Cuentas' },
    { key: 'movimientos',     label: 'Movimientos' },
    { key: 'transferencias',  label: 'Transferencias' },
    { key: 'resumen',         label: 'Resumen' },
  ].forEach(t => {
    const btn = h('button', {
      class: `mod-tab ${_bancosTab === t.key ? 'on' : ''}`,
      onclick: () => { _bancosTab = t.key; renderBancos(el); }
    }, t.label);
    tabs.appendChild(btn);
  });
  wrap.appendChild(tabs);

  const body = h('div', { id: 'bancos-body' });
  wrap.appendChild(body);

  if (_bancosTab === 'cuentas')        await _renderBancosCtAs(body);
  else if (_bancosTab === 'movimientos')   await _renderBancosMov(body);
  else if (_bancosTab === 'transferencias') await _renderBancosTransfer(body);
  else if (_bancosTab === 'resumen')    await _renderBancosResumen(body);
}

// ── Cuentas ───────────────────────────────────
async function _renderBancosCtAs(el) {
  const res = await window.api.financial.getAll();
  const cuentas = res?.data || [];

  // Header
  const hdr = h('div', { class: 'sec-hdr', style: { marginBottom: '16px' } },
    h('div', null),
    h('button', { class: 'btn', onclick: _openBancosCreateModal }, '+ Nueva cuenta')
  );
  el.appendChild(hdr);

  // Cards de cuentas
  const cards = h('div', { class: 'fin-cards' });
  cuentas.forEach(c => {
    const typeClass = `acct-type-${c.type || 'otro'}`;
    const icons = { caja: '💵', banco: '🏦', tarjeta: '💳', otro: '💼' };
    const icon = icons[c.type] || '💼';
    const card = h('div', { class: `fin-card${!c.is_active ? ' opacity-50' : ''}`,
      style: { cursor: 'pointer', position: 'relative' },
      onclick: () => _openBancosDetailModal(c)
    },
      h('div', { class: 'fin-card-icon', style: { background: 'var(--surface2)', fontSize: '18px' } }, icon),
      h('div', { class: 'fin-card-label' }, c.name),
      h('div', { class: 'fin-card-amount' }, fmt(c.balance)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' } },
        h('span', { class: `acct-type-badge ${typeClass}` }, c.type || 'otro'),
        !c.is_active ? h('span', { style: { fontSize: '10px', color: 'var(--muted2)' } }, 'inactiva') : null
      ),
      h('div', { class: 'fin-card-sub', style: { marginTop: '4px' } },
        c.bank_name ? `${c.bank_name}` : (c.account_number ? `****${c.account_number.slice(-4)}` : ''))
    );
    cards.appendChild(card);
  });

  if (!cuentas.length) {
    cards.appendChild(h('div', { class: 'empty', style: { gridColumn: '1/-1' } },
      h('p', null, 'No hay cuentas creadas'),
      h('span', null, 'Crea tu primera cuenta financiera')
    ));
  }

  el.appendChild(cards);
}

function _openBancosCreateModal(acct = null) {
  const editing = !!acct;
  openModal(`
    <div style="padding:24px;min-width:380px">
      <div class="modal-title">${editing ? 'Editar cuenta' : 'Nueva cuenta financiera'}</div>
      <div style="display:flex;flex-direction:column;gap:14px;margin-top:16px">
        <div>
          <label class="lbl">Nombre de la cuenta *</label>
          <input id="fa-name" class="inp" value="${acct?.name || ''}" placeholder="Ej: Caja Principal">
        </div>
        <div>
          <label class="lbl">Tipo *</label>
          <select id="fa-type" class="inp">
            ${['caja','banco','tarjeta','otro'].map(t =>
              `<option value="${t}" ${acct?.type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label class="lbl">Balance inicial (RD$)</label>
          <input id="fa-bal" class="inp" type="number" min="0" step="0.01"
            value="${editing ? '' : (acct?.balance || 0)}"
            ${editing ? 'disabled title="Use un movimiento para ajustar el balance"' : ''}>
        </div>
        <div>
          <label class="lbl">Nombre del banco</label>
          <input id="fa-bank" class="inp" value="${acct?.bank_name || ''}" placeholder="BanReservas, Popular...">
        </div>
        <div>
          <label class="lbl">Número de cuenta / últimos 4 dígitos</label>
          <input id="fa-num" class="inp" value="${acct?.account_number || ''}" placeholder="****1234">
        </div>
        <div>
          <label class="lbl">Descripción</label>
          <input id="fa-desc" class="inp" value="${acct?.description || ''}">
        </div>
        <div style="display:flex;gap:10px;margin-top:8px">
          <button class="btn" onclick="_saveBancosAcct(${acct?.id || 'null'})">${editing ? 'Guardar' : 'Crear'}</button>
          <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </div>
    </div>
  `);
}

window._saveBancosAcct = async function(id) {
  const name    = document.getElementById('fa-name').value.trim();
  const type    = document.getElementById('fa-type').value;
  const balEl   = document.getElementById('fa-bal');
  const bal     = parseFloat(balEl?.value || 0) || 0;
  const bank    = document.getElementById('fa-bank').value.trim();
  const num     = document.getElementById('fa-num').value.trim();
  const desc    = document.getElementById('fa-desc').value.trim();

  if (!name) { toast('El nombre es obligatorio', 'w'); return; }

  const data = { name, type, bank_name: bank, account_number: num, description: desc };
  if (!id) data.balance = bal;

  let res;
  if (id) {
    res = await window.api.financial.update({ id, data, requestUserId: user.id });
  } else {
    res = await window.api.financial.create({ data, requestUserId: user.id });
  }

  if (res?.ok) {
    toast(id ? 'Cuenta actualizada' : 'Cuenta creada', 's');
    closeModal();
    routeTo('bancos');
  } else {
    toast(res?.error || 'Error al guardar', 'e');
  }
};

function _openBancosDetailModal(c) {
  openModal(`
    <div style="padding:24px;min-width:380px">
      <div class="modal-title">${c.name}</div>
      <div style="font-size:28px;font-weight:800;color:var(--accent);margin:12px 0">${fmt(c.balance)}</div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:16px">
        <span class="acct-type-badge acct-type-${c.type}">${c.type}</span>
        ${c.bank_name ? ` · ${c.bank_name}` : ''}
        ${c.account_number ? ` · ${c.account_number}` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" onclick="closeModal();_bancosTab='movimientos';_bancosAcct=${c.id};routeTo('bancos')">
          Ver movimientos
        </button>
        <button class="btn-ghost" onclick="closeModal();_openBancosCreateModal(${JSON.stringify(c).replace(/"/g,'&quot;')})">
          Editar
        </button>
        <button class="btn-ghost" style="color:${c.is_active?'#ef4444':'var(--accent)'}"
          onclick="_toggleBancosAcct(${c.id},${c.is_active?0:1})">
          ${c.is_active ? 'Desactivar' : 'Activar'}
        </button>
        <button class="btn-ghost" onclick="closeModal()">Cerrar</button>
      </div>
    </div>
  `);
}

window._toggleBancosAcct = async function(id, active) {
  const res = await window.api.financial.toggleActive({ id, active, requestUserId: user.id });
  if (res?.ok) { toast(active ? 'Cuenta activada' : 'Cuenta desactivada', 's'); closeModal(); routeTo('bancos'); }
  else toast(res?.error || 'Error', 'e');
};

// ── Movimientos ───────────────────────────────
async function _renderBancosMov(el) {
  const allRes  = await window.api.financial.getAll();
  const cuentas = (allRes?.data || []).filter(c => c.is_active);

  // Selector de cuenta
  const selRow = h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap', alignItems: 'center' } });
  const sel = h('select', { class: 'inp', style: { maxWidth: '260px' },
    onchange: async (e) => {
      _bancosAcct = parseInt(e.target.value) || null;
      movBody.innerHTML = '';
      await _renderBancosMovList(movBody, _bancosAcct);
    }
  }, h('option', { value: '' }, '— Selecciona cuenta —'),
  ...cuentas.map(c => h('option', { value: c.id, ...(c.id === _bancosAcct ? { selected: true } : {}) }, c.name)));

  selRow.appendChild(h('div', null, h('label', { class: 'lbl', style: { marginBottom: '4px', display: 'block' } }, 'Cuenta'), sel));
  selRow.appendChild(h('button', { class: 'btn', style: { alignSelf: 'flex-end' },
    onclick: () => _bancosAcct && _openMovModal(_bancosAcct, cuentas)
  }, '+ Movimiento'));
  el.appendChild(selRow);

  const movBody = h('div');
  el.appendChild(movBody);
  if (_bancosAcct) await _renderBancosMovList(movBody, _bancosAcct);
}

async function _renderBancosMovList(el, accountId) {
  if (!accountId) return;
  const res = await window.api.financial.getMovements({ accountId, limit: 100 });
  const movs = res?.data || [];

  if (!movs.length) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'Sin movimientos'), h('span', null, 'Crea el primer movimiento')));
    return;
  }

  const tbl = h('table', { class: 'ledger-tbl', style: { width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', null, 'Fecha'),
      h('th', null, 'Tipo'),
      h('th', null, 'Descripción'),
      h('th', null, 'Referencia'),
      h('th', { class: 'num' }, 'Monto'),
      h('th', { class: 'num' }, 'Balance'),
      h('th', null, 'Estado'),
      h('th', null, '')
    )),
    h('tbody', null, ...movs.map(m => {
      // Salidas de dinero (misma clasificación que los reportes en main.js):
      // el monto se guarda en positivo, el signo lo determina el tipo.
      const OUTFLOW_TYPES = ['retiro', 'transferencia_out', 'gasto', 'pago_proveedor', 'egreso'];
      const isEgreso = OUTFLOW_TYPES.includes(m.type);
      return h('tr', null,
        h('td', null, m.created_at?.slice(0,10) || ''),
        h('td', null, h('span', { class: `mov-type-${m.type}` }, m.type)),
        h('td', null, m.description || '—'),
        h('td', null, m.reference || '—'),
        h('td', { class: `num ${isEgreso?'debit':'credit'}` }, `${isEgreso?'-':'+'} ${fmt(m.amount)}`),
        h('td', { class: 'num' }, fmt(m.balance_after)),
        h('td', null, h('span', { class: `mov-status-${m.status}` }, m.status)),
        h('td', null, m.status === 'activo'
          ? h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px', color: '#ef4444' },
              onclick: () => _cancelMov(m.id) }, 'Anular')
          : null
        )
      );
    }))
  );
  el.appendChild(h('div', { class: 'tw' }, tbl));
}

function _openMovModal(accountId, cuentas) {
  const c = cuentas.find(x => x.id === accountId);
  openModal(`
    <div style="padding:24px;min-width:360px">
      <div class="modal-title">Nuevo movimiento</div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:16px">
        Cuenta: <strong>${c?.name || accountId}</strong> · Balance: <strong>${fmt(c?.balance || 0)}</strong>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label class="lbl">Tipo *</label>
          <select id="mv-type" class="inp">
            <option value="ingreso">Ingreso</option>
            <option value="egreso">Egreso</option>
          </select>
        </div>
        <div>
          <label class="lbl">Monto (RD$) *</label>
          <input id="mv-amount" class="inp" type="number" min="0.01" step="0.01" placeholder="0.00">
        </div>
        <div>
          <label class="lbl">Descripción *</label>
          <input id="mv-desc" class="inp" placeholder="Ej: Pago de nómina">
        </div>
        <div>
          <label class="lbl">Referencia / Número</label>
          <input id="mv-ref" class="inp" placeholder="Ej: CHQ-001">
        </div>
        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn" onclick="_saveMov(${accountId})">Guardar</button>
          <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </div>
    </div>
  `);
}

window._saveMov = async function(accountId) {
  const type   = document.getElementById('mv-type').value;
  const amount = parseFloat(document.getElementById('mv-amount').value) || 0;
  const desc   = document.getElementById('mv-desc').value.trim();
  const ref    = document.getElementById('mv-ref').value.trim();

  if (!amount || amount <= 0) { toast('Ingresa un monto válido', 'w'); return; }
  if (!desc) { toast('La descripción es obligatoria', 'w'); return; }

  const res = await window.api.financial.addMovement({
    data: { account_id: accountId, type, amount, description: desc, reference: ref },
    requestUserId: user.id
  });
  if (res?.ok) {
    toast('Movimiento registrado', 's');
    closeModal();
    const body = document.getElementById('bancos-body');
    if (body) { body.innerHTML = ''; await _renderBancosMov(body); }
  } else {
    toast(res?.error || 'Error al guardar', 'e');
  }
};

window._cancelMov = async function(id) {
  const reason = prompt('Razón de la anulación:');
  if (!reason) return;
  const res = await window.api.financial.cancelMovement({ id, reason, requestUserId: user.id });
  if (res?.ok) {
    toast('Movimiento anulado', 's');
    const body = document.getElementById('bancos-body');
    if (body) { body.innerHTML = ''; await _renderBancosMov(body); }
  } else toast(res?.error || 'Error', 'e');
};

// ── Transferencias ────────────────────────────
async function _renderBancosTransfer(el) {
  const allRes  = await window.api.financial.getAll();
  const cuentas = (allRes?.data || []).filter(c => c.is_active);

  el.appendChild(h('div', { style: { maxWidth: '480px' } },
    h('div', { style: { fontSize: '13px', fontWeight: '600', marginBottom: '16px', color: 'var(--ink)' } }, 'Transferencia entre cuentas'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: '12px', padding: '20px' } },

      h('div', null,
        h('label', { class: 'lbl' }, 'Cuenta origen *'),
        h('select', { id: 'tr-from', class: 'inp' },
          h('option', { value: '' }, '— Selecciona —'),
          ...cuentas.map(c => h('option', { value: c.id }, `${c.name} · ${fmt(c.balance)}`))
        )
      ),
      h('div', null,
        h('label', { class: 'lbl' }, 'Cuenta destino *'),
        h('select', { id: 'tr-to', class: 'inp' },
          h('option', { value: '' }, '— Selecciona —'),
          ...cuentas.map(c => h('option', { value: c.id }, `${c.name} · ${fmt(c.balance)}`))
        )
      ),
      h('div', null,
        h('label', { class: 'lbl' }, 'Monto (RD$) *'),
        h('input', { id: 'tr-amount', class: 'inp', type: 'number', min: '0.01', step: '0.01', placeholder: '0.00' })
      ),
      h('div', null,
        h('label', { class: 'lbl' }, 'Descripción'),
        h('input', { id: 'tr-desc', class: 'inp', placeholder: 'Ej: Traslado a cuenta banco' })
      ),
      h('div', null,
        h('label', { class: 'lbl' }, 'Referencia'),
        h('input', { id: 'tr-ref', class: 'inp', placeholder: 'Ej: TRF-001' })
      ),
      h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: _doTransfer }, 'Realizar transferencia')
    )
  ));
}

async function _doTransfer() {
  const from   = parseInt(document.getElementById('tr-from').value) || 0;
  const to     = parseInt(document.getElementById('tr-to').value)   || 0;
  const amount = parseFloat(document.getElementById('tr-amount').value) || 0;
  const desc   = document.getElementById('tr-desc').value.trim();
  const ref    = document.getElementById('tr-ref').value.trim();

  if (!from)         { toast('Selecciona la cuenta origen', 'w');   return; }
  if (!to)           { toast('Selecciona la cuenta destino', 'w');  return; }
  if (from === to)   { toast('Las cuentas deben ser diferentes', 'w'); return; }
  if (amount <= 0)   { toast('Ingresa un monto válido', 'w');       return; }

  const res = await window.api.financial.transfer({
    data: { from_account_id: from, to_account_id: to, amount, description: desc, reference: ref },
    requestUserId: user.id
  });

  if (res?.ok) {
    toast('Transferencia realizada', 's');
    routeTo('bancos');
  } else {
    toast(res?.error || 'Error en transferencia', 'e');
  }
}

// ── Resumen ───────────────────────────────────
async function _renderBancosResumen(el) {
  const [sumRes, allRes] = await Promise.all([
    window.api.financial.getSummary(),
    window.api.financial.getAll(),
  ]);
  const summary  = sumRes?.data  || {};
  const cuentas  = allRes?.data  || [];

  // Totales por tipo
  const byType = {};
  cuentas.filter(c => c.is_active).forEach(c => {
    byType[c.type] = (byType[c.type] || 0) + (c.balance || 0);
  });

  const statCards = h('div', { class: 'fin-cards', style: { marginBottom: '20px' } });
  [
    { label: 'Total activos',      val: summary.total_active  || 0, icon: '📊', cls: '' },
    { label: 'Efectivo (Caja)',    val: byType.caja            || 0, icon: '💵', cls: 'positive' },
    { label: 'Bancos',             val: byType.banco           || 0, icon: '🏦', cls: 'positive' },
    { label: 'Tarjetas',           val: byType.tarjeta         || 0, icon: '💳', cls: '' },
    { label: 'Ingresos del mes',   val: summary.total_income_month || 0, icon: '📈', cls: 'positive' },
    { label: 'Egresos del mes',    val: summary.total_expenses_month || 0, icon: '📉', cls: 'negative' },
  ].forEach(s => {
    statCards.appendChild(h('div', { class: `fin-card ${s.cls}` },
      h('div', { class: 'fin-card-icon', style: { background: 'var(--surface2)', fontSize: '18px' } }, s.icon),
      h('div', { class: 'fin-card-label' }, s.label),
      h('div', { class: 'fin-card-amount' }, fmt(s.val))
    ));
  });
  el.appendChild(statCards);

  // Tabla de cuentas
  el.appendChild(h('div', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '10px' } }, 'Detalle por cuenta'));
  const tbl = h('table', { class: 'ledger-tbl', style: { width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', null, 'Cuenta'),
      h('th', null, 'Tipo'),
      h('th', null, 'Banco'),
      h('th', { class: 'num' }, 'Balance'),
      h('th', null, 'Estado')
    )),
    h('tbody', null, ...cuentas.map(c =>
      h('tr', null,
        h('td', null, c.name),
        h('td', null, h('span', { class: `acct-type-badge acct-type-${c.type}` }, c.type)),
        h('td', null, c.bank_name || '—'),
        h('td', { class: 'num' }, fmt(c.balance)),
        h('td', null, c.is_active ? '✓ Activa' : 'Inactiva')
      )
    ))
  );
  el.appendChild(h('div', { class: 'tw' }, tbl));

  // Botón imprimir
  el.appendChild(h('div', { style: { marginTop: '16px' } },
    h('button', { class: 'print-btn', onclick: _printBancosResumen }, '🖨 Imprimir resumen')
  ));
}

async function _printBancosResumen() {
  const [sumRes, allRes] = await Promise.all([
    window.api.financial.getSummary(),
    window.api.financial.getAll(),
  ]);
  const summary = sumRes?.data || {};
  const cuentas = allRes?.data || [];
  const biz     = DB?.settings?.biz_name || CFG.biz || 'Velo POS';
  const today   = new Date().toLocaleDateString('es-DO');

  const rows = cuentas.map(c => `
    <tr>
      <td>${_esc(c.name)}</td>
      <td>${_esc(c.type)}</td>
      <td>${_esc(c.bank_name)||'—'}</td>
      <td style="text-align:right">${fmt(c.balance)}</td>
      <td>${c.is_active ? 'Activa' : 'Inactiva'}</td>
    </tr>
  `).join('');

  const html = `
    <html><head><meta charset="UTF-8">
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#111}
      h1{font-size:16px;margin:0}h2{font-size:13px;font-weight:600;margin:16px 0 8px}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      th{background:#f3f4f6;padding:7px 10px;text-align:left;font-size:11px}
      td{padding:6px 10px;border-bottom:1px solid #e5e7eb}
      .total{font-weight:700;font-size:14px;margin-top:12px}
      .muted{color:#6b7280;font-size:11px}
    </style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div><h1>${_esc(biz)}</h1><div class="muted">Resumen de Cuentas Financieras · ${today}</div></div>
    </div>
    <h2>Cuentas Registradas</h2>
    <table>
      <thead><tr><th>Cuenta</th><th>Tipo</th><th>Banco</th><th style="text-align:right">Balance</th><th>Estado</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="total">Total activos: ${fmt(summary.total_active || 0)}</div>
    </body></html>
  `;

  printHTML(html, 'bancos');
}
