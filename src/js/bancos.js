// ══════════════════════════════════════════════
// bancos.js — Módulo de Cuentas Financieras
// Caja, Banco, Tarjeta, Transferencias
// ══════════════════════════════════════════════

let _bancosTab  = 'cuentas';
let _bancosAcct = null; // cuenta seleccionada para movimientos

function _bancosMoney(value, currency = 'DOP') {
  const n = Number(value) || 0;
  return String(currency || 'DOP').toUpperCase() === 'USD'
    ? `US$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : fmt(n);
}

async function renderBancos(el) {
  el.innerHTML = '';

  if (!['admin','superadmin'].includes(user?.role)) {
    el.innerHTML = '<div class="empty"><p>Acceso restringido</p></div>';
    return;
  }

  const wrap = h('div', { style: { padding: '20px', maxWidth: '1100px', margin: '0 auto' } });
  el.appendChild(wrap);

  // Tabs — la barra queda FIJA; el clic re-renderiza SOLO el cuerpo (sin pestañeo
  // del módulo completo).
  const tabs = h('div', { class: 'mod-tabs' });
  const body = h('div', { id: 'bancos-body' });
  [
    { key: 'cuentas',         label: 'Cuentas' },
    { key: 'movimientos',     label: 'Movimientos' },
    { key: 'transferencias',  label: 'Transferencias' },
    { key: 'conciliacion',    label: 'Conciliación' },
    { key: 'resumen',         label: 'Resumen' },
  ].forEach(t => {
    const btn = h('button', {
      class: `mod-tab ${_bancosTab === t.key ? 'on' : ''}`,
      'data-tab': t.key,
      onclick: () => {
        if (_bancosTab === t.key) return;
        _bancosTab = t.key;
        tabs.querySelectorAll('.mod-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t.key));
        _renderBancosBody(body);
      }
    }, t.label);
    tabs.appendChild(btn);
  });
  wrap.appendChild(tabs);
  wrap.appendChild(body);

  await _renderBancosBody(body);
}

// Re-renderiza solo el cuerpo del módulo (cambio de pestaña) con swap atómico sin flash.
async function _renderBancosBody(body) {
  await _swapView(body, async (c) => {
    if (_bancosTab === 'cuentas')             await _renderBancosCtAs(c);
    else if (_bancosTab === 'movimientos')    await _renderBancosMov(c);
    else if (_bancosTab === 'transferencias') await _renderBancosTransfer(c);
    else if (_bancosTab === 'conciliacion')   await _renderBancosConcil(c);
    else if (_bancosTab === 'resumen')        await _renderBancosResumen(c);
  });
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
    const badgeText = _bancosTypeLabel(c);
    const cur = String(c.currency || 'DOP').toUpperCase();
    // Sublíneas informativas: banco · nº de cuenta.
    const subLines = [];
    if (c.bank_name) subLines.push(c.bank_name);
    if (c.account_number) subLines.push(c.account_number);
    const card = h('div', { class: `fin-card${!c.is_active ? ' opacity-50' : ''}`,
      style: { cursor: 'pointer', position: 'relative' },
      onclick: () => _openBancosDetailModal(c)
    },
      h('div', { class: 'fin-card-icon', style: { background: 'var(--surface2)', fontSize: '18px' } }, icon),
      h('div', { class: 'fin-card-label' }, c.name),
      h('div', { class: 'fin-card-amount' },
        _bancosMoney(c.balance, cur)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
        h('span', { class: `acct-type-badge ${typeClass}` }, badgeText),
        cur !== 'DOP' ? h('span', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--muted2)' } }, cur) : null,
        !c.is_active ? h('span', { style: { fontSize: '10px', color: 'var(--muted2)' } }, 'inactiva') : null
      ),
      subLines.length
        ? h('div', { class: 'fin-card-sub', style: { marginTop: '4px' } }, subLines.join(' · '))
        : null
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
  const _v = s => String(s ?? '').replace(/"/g, '&quot;');
  const isBankish = (acct?.type === 'banco' || acct?.type === 'tarjeta');
  openModal(`
    <div style="padding:24px;min-width:520px;max-width:560px">
      <div class="modal-title">${editing ? 'Editar cuenta' : 'Nueva cuenta financiera'}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px">
        <div style="grid-column:1/-1">
          <label class="lbl">Nombre de la cuenta *</label>
          <input id="fa-name" class="inp" value="${_v(acct?.name)}" placeholder="Ej: Caja Principal">
        </div>
        <div>
          <label class="lbl">Tipo *</label>
          <select id="fa-type" class="inp" onchange="_bancosOnTypeChange(this.value)">
            ${['caja','banco','tarjeta','otro'].map(t =>
              `<option value="${t}" ${acct?.type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
        <!-- Balance inicial: solo caja/otro (banco/tarjeta parten en 0) -->
        <div id="fa-bal-wrap" style="display:${isBankish ? 'none' : 'block'}">
          <label class="lbl">Balance inicial (RD$)</label>
          <input id="fa-bal" class="inp" type="number" min="0" step="0.01"
            value="${editing ? '' : (acct?.balance || 0)}"
            ${editing ? 'disabled title="Use un movimiento para ajustar el balance"' : ''}>
        </div>
        <!-- Subtipo de cuenta: solo Banco -->
        <div id="fa-subtype-wrap" style="display:${acct?.type==='banco' ? 'block' : 'none'}">
          <label class="lbl">Tipo de cuenta</label>
          <select id="fa-subtype" class="inp">
            ${[['','—'],['ahorros','Ahorros'],['corriente','Corriente']].map(([v,l]) =>
              `<option value="${v}" ${(acct?.account_subtype||'')===v?'selected':''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <!-- Moneda: relevante para banco/tarjeta -->
        <div id="fa-currency-wrap" style="display:${isBankish ? 'block' : 'none'}">
          <label class="lbl">Moneda</label>
          <select id="fa-currency" class="inp">
            ${[['DOP','Pesos (DOP)'],['USD','Dólares (USD)']].map(([v,l]) =>
              `<option value="${v}" ${(acct?.currency||'DOP')===v?'selected':''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label class="lbl">Nombre del banco</label>
          <input id="fa-bank" class="inp" value="${_v(acct?.bank_name)}" placeholder="BanReservas, Popular...">
        </div>
        <div>
          <label class="lbl">Número de cuenta</label>
          <input id="fa-num" class="inp" value="${_v(acct?.account_number)}" placeholder="000-0000000-0">
        </div>
        <div style="grid-column:1/-1">
          <label class="lbl">Descripción</label>
          <input id="fa-desc" class="inp" value="${_v(acct?.description)}">
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button class="btn" onclick="_saveBancosAcct(${acct?.id || 'null'})">${editing ? 'Guardar' : 'Crear'}</button>
        <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
      </div>
    </div>
  `);
}

// Muestra/oculta campos según el tipo de cuenta:
//   banco   → subtipo (Ahorros/Corriente) + moneda, sin balance inicial
//   tarjeta → moneda, sin balance inicial
//   caja/otro → balance inicial, sin subtipo ni moneda
window._bancosOnTypeChange = function(type) {
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? 'block' : 'none'; };
  const isBankish = type === 'banco' || type === 'tarjeta';
  show('fa-bal-wrap', !isBankish);
  show('fa-subtype-wrap', type === 'banco');
  show('fa-currency-wrap', isBankish);
};

window._saveBancosAcct = async function(id) {
  const name    = document.getElementById('fa-name').value.trim();
  const type    = document.getElementById('fa-type').value;
  const balEl   = document.getElementById('fa-bal');
  const bal     = parseFloat(balEl?.value || 0) || 0;
  const bank    = document.getElementById('fa-bank').value.trim();
  const num     = document.getElementById('fa-num').value.trim();
  const desc    = document.getElementById('fa-desc').value.trim();
  const subtype = document.getElementById('fa-subtype')?.value || '';
  const currency= document.getElementById('fa-currency')?.value || 'DOP';

  if (!name) { toast('El nombre es obligatorio', 'w'); return; }

  const data = { name, type, bank_name: bank, account_number: num, description: desc,
    account_subtype: type === 'banco' ? subtype : '',
    currency: (type === 'banco' || type === 'tarjeta') ? currency : 'DOP' };
  // Balance inicial solo para caja/otro (banco/tarjeta parten en 0).
  if (!id && type !== 'banco' && type !== 'tarjeta') data.balance = bal;

  let res;
  if (id) {
    res = await window.api.financial.update({ id, data, requestUserId: user.id });
  } else {
    res = await window.api.financial.create({ data, requestUserId: user.id });
  }

  if (res?.ok) {
    toast(id ? 'Cuenta actualizada' : 'Cuenta creada', 's');
    if (typeof reloadFinancialAccounts === 'function') await reloadFinancialAccounts().catch(() => {});
    closeModal();
    routeTo('bancos');
  } else {
    toast(res?.error || 'Error al guardar', 'e');
  }
};

// Etiqueta legible del tipo/subtipo de cuenta (ej. "Banco · Ahorros").
function _bancosTypeLabel(c) {
  const base = { caja: 'Caja', banco: 'Banco', tarjeta: 'Tarjeta', otro: 'Otro' }[c.type] || (c.type || 'otro');
  const sub  = { ahorros: 'Ahorros', corriente: 'Corriente' }[c.account_subtype] || '';
  return sub ? `${base} · ${sub}` : base;
}

function _openBancosDetailModal(c) {
  const _e = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cur = c.currency || 'DOP';
  const infoRow = (lbl, val) => val ? `
    <div style="display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:0.5px solid var(--line2)">
      <span style="color:var(--muted2)">${lbl}</span><span style="font-weight:600;text-align:right">${val}</span>
    </div>` : '';
  openModal(`
    <div style="padding:24px;min-width:400px">
      <div class="modal-title">${_e(c.name)}</div>
      <div style="font-size:28px;font-weight:800;color:var(--accent);margin:12px 0">
        ${_bancosMoney(c.balance, cur)}
      </div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:12px">
        <span class="acct-type-badge acct-type-${c.type}">${_bancosTypeLabel(c)}</span>
      </div>
      <div style="font-size:12.5px;margin-bottom:16px">
        ${infoRow('Banco', _e(c.bank_name))}
        ${infoRow('Número de cuenta', _e(c.account_number))}
        ${infoRow('Tipo de cuenta', { ahorros: 'Ahorros', corriente: 'Corriente' }[c.account_subtype] || '')}
        ${infoRow('Moneda', cur === 'USD' ? 'Dólares (USD)' : 'Pesos (DOP)')}
        ${infoRow('Descripción', _e(c.description))}
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
  if (res?.ok) { toast(active ? 'Cuenta activada' : 'Cuenta desactivada', 's'); if (typeof reloadFinancialAccounts === 'function') await reloadFinancialAccounts().catch(() => {}); closeModal(); routeTo('bancos'); }
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
      const selected = cuentas.find(c => Number(c.id) === Number(_bancosAcct));
      await _renderBancosMovList(movBody, _bancosAcct, selected?.currency || 'DOP');
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
  if (_bancosAcct) {
    const selected = cuentas.find(c => Number(c.id) === Number(_bancosAcct));
    await _renderBancosMovList(movBody, _bancosAcct, selected?.currency || 'DOP');
  }
}

async function _renderBancosMovList(el, accountId, currency = 'DOP') {
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
        h('td', { class: `num ${isEgreso?'debit':'credit'}` }, `${isEgreso?'-':'+'} ${_bancosMoney(m.amount, currency)}`),
        h('td', { class: 'num' }, _bancosMoney(m.balance_after, currency)),
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
        Cuenta: <strong>${c?.name || accountId}</strong> · Balance: <strong>${_bancosMoney(c?.balance || 0, c?.currency || 'DOP')}</strong>
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
          <label class="lbl">Monto (${String(c?.currency || 'DOP').toUpperCase() === 'USD' ? 'US$' : 'RD$'}) *</label>
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
  const reason = await askText('Razón de la anulación:', { title: 'Anular movimiento' });
  if (!reason || !reason.trim()) return;
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
          ...cuentas.map(c => h('option', { value: c.id }, `${c.name} · ${_bancosMoney(c.balance, c.currency)}`))
        )
      ),
      h('div', null,
        h('label', { class: 'lbl' }, 'Cuenta destino *'),
        h('select', { id: 'tr-to', class: 'inp' },
          h('option', { value: '' }, '— Selecciona —'),
          ...cuentas.map(c => h('option', { value: c.id }, `${c.name} · ${_bancosMoney(c.balance, c.currency)}`))
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

// ══════════════════════════════════════════════
// CONCILIACIÓN BANCARIA
// ══════════════════════════════════════════════
async function _renderBancosConcil(el) {
  const allRes  = await window.api.financial.getAll();
  const cuentas = (allRes?.data || []).filter(c => c.is_active && (c.type === 'banco' || c.type === 'tarjeta'));

  const selRow = h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap', alignItems: 'flex-end' } });
  const sel = h('select', { class: 'inp', style: { maxWidth: '260px' },
    onchange: (e) => { _bancosAcct = parseInt(e.target.value) || null; renderBancos(document.getElementById('page')); }
  }, h('option', { value: '' }, '— Selecciona cuenta bancaria —'),
  ...cuentas.map(c => h('option', { value: c.id, ...(c.id === _bancosAcct ? { selected: true } : {}) }, c.name)));
  selRow.appendChild(h('div', null, h('label', { class: 'lbl', style: { marginBottom: '4px', display: 'block' } }, 'Cuenta'), sel));

  if (_bancosAcct) {
    selRow.appendChild(h('button', { class: 'btn', onclick: () => _openImportExtractoModal(_bancosAcct) }, '📥 Importar extracto'));
    selRow.appendChild(h('button', { class: 'btn-ghost', onclick: async () => {
      const r = await window.api.bank.autoMatch({ accountId: _bancosAcct, requestUserId: user.id });
      toast(r?.ok ? `${r.matched} conciliados automáticamente` : (r?.error || 'Error'), r?.ok ? 's' : 'e');
      renderBancos(document.getElementById('page'));
    } }, '🔗 Auto-conciliar'));
  }
  el.appendChild(selRow);

  if (!cuentas.length) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'No hay cuentas bancarias'), h('span', null, 'Crea una cuenta tipo Banco o Tarjeta')));
    return;
  }
  if (!_bancosAcct) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'Selecciona una cuenta'), h('span', null, 'Importa el extracto del banco y concílialo con tus movimientos')));
    return;
  }

  const res = await window.api.bank.getReconciliation({ accountId: _bancosAcct });
  const data = res?.data;
  if (!data) { el.appendChild(h('div', { class: 'empty' }, h('p', null, res?.error || 'Error'))); return; }
  const s = data.summary;

  // Resumen
  const cards = h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' } },
    _concilCard('Saldo en libros', fmt(s.bookBalance), ''),
    _concilCard('Conciliadas', String(s.conciliado), 'positive'),
    _concilCard('Líneas pendientes', String(s.pendientes), s.pendientes ? 'negative' : ''),
    _concilCard('Movim. sin conciliar', String(s.unmatchedMovements), s.unmatchedMovements ? 'negative' : '')
  );
  el.appendChild(cards);

  // Líneas del extracto
  el.appendChild(h('div', { style: { fontSize: '13px', fontWeight: '600', margin: '4px 0 8px' } }, `Extracto bancario (${data.statementLines.length})`));
  if (!data.statementLines.length) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'Sin líneas importadas'), h('span', null, 'Usa "Importar extracto" para cargar el CSV del banco')));
  } else {
    el.appendChild(h('div', { class: 'tw' }, h('table', { class: 'ledger-tbl', style: { width: '100%' } },
      h('thead', null, h('tr', null,
        h('th', null, 'Fecha'), h('th', null, 'Descripción'), h('th', null, 'Ref'),
        h('th', { class: 'num' }, 'Monto'), h('th', null, 'Estado'), h('th', null, 'Movimiento'), h('th', null, '')
      )),
      h('tbody', null, ...data.statementLines.map(l => {
        const st = l.status;
        const badge = st === 'conciliado' ? 'activo' : (st === 'ignorado' ? 'borrador' : 'anulado');
        return h('tr', null,
          h('td', null, l.date || '—'),
          h('td', null, l.description || '—'),
          h('td', null, l.bank_ref || '—'),
          h('td', { class: `num ${l.amount < 0 ? 'debit' : 'credit'}` }, fmt(l.amount)),
          h('td', null, h('span', { class: `entry-status entry-status-${badge}` }, st + (l.match_type ? ` (${l.match_type})` : ''))),
          h('td', { style: { fontSize: '11px', color: 'var(--muted2)' } }, l.mov_desc ? `${l.mov_desc} · ${fmt(l.movSigned)}` : '—'),
          h('td', null, _concilLineActions(l))
        );
      }))
    )));
  }

  // Movimientos sin conciliar
  el.appendChild(h('div', { style: { fontSize: '13px', fontWeight: '600', margin: '20px 0 8px' } }, `Movimientos sin conciliar (${data.unmatchedMovements.length})`));
  if (!data.unmatchedMovements.length) {
    el.appendChild(h('div', { class: 'empty' }, h('p', null, 'Todos los movimientos están conciliados')));
  } else {
    el.appendChild(h('div', { class: 'tw' }, h('table', { class: 'ledger-tbl', style: { width: '100%' } },
      h('thead', null, h('tr', null, h('th', null, 'Fecha'), h('th', null, 'Tipo'), h('th', null, 'Descripción'), h('th', { class: 'num' }, 'Monto (con signo)'))),
      h('tbody', null, ...data.unmatchedMovements.map(m => h('tr', null,
        h('td', null, (m.created_at || '').slice(0, 10)),
        h('td', null, m.type),
        h('td', null, m.description || '—'),
        h('td', { class: `num ${m.signed < 0 ? 'debit' : 'credit'}` }, fmt(m.signed))
      )))
    )));
  }
}

function _concilCard(label, val, cls) {
  return h('div', { style: { flex: '1', minWidth: '150px', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: '12px', padding: '14px' } },
    h('div', { style: { fontSize: '11px', color: 'var(--muted2)', marginBottom: '4px' } }, label),
    h('div', { class: cls, style: { fontSize: '18px', fontWeight: '700' } }, val)
  );
}

function _concilLineActions(l) {
  const box = h('div', { style: { display: 'flex', gap: '4px' } });
  if (l.status === 'conciliado') {
    box.appendChild(h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px' },
      onclick: async () => { const r = await window.api.bank.unmatch({ lineId: l.id, requestUserId: user.id }); r?.ok ? renderBancos(document.getElementById('page')) : toast(r?.error || 'Error', 'e'); } }, 'Desvincular'));
  } else if (l.status === 'pendiente') {
    box.appendChild(h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px' },
      onclick: () => _openManualMatchModal(l) }, 'Conciliar'));
    box.appendChild(h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px', color: 'var(--muted2)' },
      onclick: async () => { const r = await window.api.bank.ignoreLine({ lineId: l.id, ignore: true, requestUserId: user.id }); r?.ok ? renderBancos(document.getElementById('page')) : toast(r?.error || 'Error', 'e'); } }, 'Ignorar'));
  } else if (l.status === 'ignorado') {
    box.appendChild(h('button', { class: 'btn-ghost', style: { fontSize: '11px', padding: '3px 8px' },
      onclick: async () => { const r = await window.api.bank.ignoreLine({ lineId: l.id, ignore: false, requestUserId: user.id }); r?.ok ? renderBancos(document.getElementById('page')) : toast(r?.error || 'Error', 'e'); } }, 'Restaurar'));
  }
  return box;
}

async function _openManualMatchModal(line) {
  const res = await window.api.bank.getReconciliation({ accountId: line.financial_account_id });
  const movs = (res?.data?.unmatchedMovements || []);
  // Sugerir por monto igual primero
  movs.sort((a, b) => Math.abs(Math.abs(a.signed) - Math.abs(line.amount)) - Math.abs(Math.abs(b.signed) - Math.abs(line.amount)));
  openModal(`
    <div class="modal-head"><div class="modal-title">Conciliar línea del extracto</div></div>
    <div class="modal-body">
      <div style="font-size:12px;color:var(--muted2);margin-bottom:10px">
        ${_esc(line.date)} · ${_esc(line.description) || '—'} · <b>${fmt(line.amount)}</b></div>
      <label class="lbl">Vincular con el movimiento</label>
      <select class="inp" id="mm-mov">
        <option value="">— Selecciona movimiento —</option>
        ${movs.map(m => `<option value="${m.id}">${(m.created_at||'').slice(0,10)} · ${_esc(m.description)||m.type} · ${fmt(m.signed)}</option>`).join('')}
      </select>
      ${movs.length ? '' : '<p style="font-size:11px;color:#ef4444;margin-top:8px">No hay movimientos sin conciliar. Registra primero el movimiento en la pestaña Movimientos.</p>'}
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn" id="mm-save">Conciliar</button>
    </div>
  `);
  document.getElementById('mm-save').onclick = async () => {
    const movementId = parseInt(document.getElementById('mm-mov').value) || null;
    if (!movementId) { toast('Selecciona un movimiento', 'e'); return; }
    const r = await window.api.bank.manualMatch({ lineId: line.id, movementId, requestUserId: user.id });
    if (r?.ok) { toast('Conciliado', 's'); closeModal(); renderBancos(document.getElementById('page')); }
    else toast(r?.error || 'Error', 'e');
  };
}

// Parser CSV mínimo (coma/;/tab, con comillas). Devuelve { headers, rows }.
function _bankParseCSV(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r/g, '');
  const linesRaw = clean.split('\n').filter(l => l.trim() !== '');
  if (!linesRaw.length) return { headers: [], rows: [] };
  const delim = (linesRaw[0].match(/;/g) || []).length > (linesRaw[0].match(/,/g) || []).length ? ';'
              : (linesRaw[0].includes('\t') ? '\t' : ',');
  const parseLine = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === delim && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim().replace(/^["']|["']$/g, ''));
  };
  const headers = parseLine(linesRaw[0]);
  const rows = linesRaw.slice(1).map(parseLine);
  return { headers, rows };
}

function _bankNum(s) {
  if (s == null) return 0;
  let t = String(s).trim().replace(/[^0-9.,\-]/g, '');
  const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    // Ambos presentes: el separador decimal es el que aparece más a la derecha.
    if (lc > ld) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56 (EU)
    else         t = t.replace(/,/g, '');                    // 1,234.56 (US)
  } else if (lc > -1) {
    // Solo coma: 3 dígitos después → miles (1,200); si no → decimal (25,00).
    t = (t.length - lc - 1 === 3) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  return parseFloat(t) || 0;
}

async function _openImportExtractoModal(accountId) {
  openModal(`
    <div class="modal-head"><div class="modal-title">Importar extracto bancario</div></div>
    <div class="modal-body">
      <p style="font-size:12px;color:var(--muted2);margin-bottom:10px">
        Carga el CSV del banco. Luego indica qué columna es cada campo. El monto puede venir
        en una sola columna con signo, o en columnas separadas de Débito y Crédito.</p>
      <input type="file" id="ext-file" accept=".csv,.tsv,.txt" class="inp">
      <div id="ext-map" style="margin-top:12px"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn" id="ext-import" style="display:none">Importar</button>
    </div>
  `);

  let parsed = null;
  document.getElementById('ext-file').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      parsed = _bankParseCSV(String(reader.result || ''));
      _renderExtractoMapeo(parsed, accountId, () => parsed);
    };
    reader.readAsText(file, 'UTF-8');
  };
}

function _renderExtractoMapeo(parsed, accountId, getParsed) {
  const box = document.getElementById('ext-map');
  if (!parsed || !parsed.headers.length) { box.innerHTML = '<p style="color:#ef4444;font-size:12px">No se pudo leer el archivo.</p>'; return; }
  const opts = ['<option value="">—</option>', ...parsed.headers.map((hd, i) => `<option value="${i}">${_esc(hd) || ('Columna ' + (i + 1))}</option>`)].join('');
  // Heurística de auto-selección por nombre de encabezado
  const guess = (re) => { const i = parsed.headers.findIndex(hd => re.test((hd || '').toLowerCase())); return i >= 0 ? i : ''; };
  box.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:120px"><label class="lbl">Fecha</label><select class="inp" id="map-date">${opts}</select></div>
      <div style="flex:1;min-width:120px"><label class="lbl">Descripción</label><select class="inp" id="map-desc">${opts}</select></div>
      <div style="flex:1;min-width:120px"><label class="lbl">Referencia (opc.)</label><select class="inp" id="map-ref">${opts}</select></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <div style="flex:1;min-width:120px"><label class="lbl">Monto (con signo)</label><select class="inp" id="map-amount">${opts}</select></div>
      <div style="flex:1;min-width:120px"><label class="lbl">Débito (egreso)</label><select class="inp" id="map-debit">${opts}</select></div>
      <div style="flex:1;min-width:120px"><label class="lbl">Crédito (ingreso)</label><select class="inp" id="map-credit">${opts}</select></div>
    </div>
    <div style="font-size:11px;color:var(--muted2);margin-top:6px">${parsed.rows.length} filas detectadas. Usa Monto con signo <b>o</b> el par Débito/Crédito.</div>`;
  document.getElementById('map-date').value   = guess(/fecha|date/);
  document.getElementById('map-desc').value   = guess(/desc|concepto|detalle|referencia banc/);
  document.getElementById('map-amount').value = guess(/monto|importe|amount|valor/);
  document.getElementById('map-debit').value  = guess(/d[ée]bito|debe|cargo|retiro/);
  document.getElementById('map-credit').value = guess(/cr[ée]dito|haber|abono|dep[óo]sito/);

  const btn = document.getElementById('ext-import');
  btn.style.display = '';
  btn.onclick = async () => {
    const p = getParsed();
    const gi = (id) => { const v = document.getElementById(id).value; return v === '' ? null : parseInt(v); };
    const iDate = gi('map-date'), iDesc = gi('map-desc'), iRef = gi('map-ref');
    const iAmt = gi('map-amount'), iDeb = gi('map-debit'), iCred = gi('map-credit');
    if (iDate == null) { toast('Indica la columna de Fecha', 'e'); return; }
    if (iAmt == null && iDeb == null && iCred == null) { toast('Indica Monto, o Débito/Crédito', 'e'); return; }
    const lines = p.rows.map(r => {
      let amount = 0;
      if (iAmt != null) amount = _bankNum(r[iAmt]);
      else {
        const deb = iDeb != null ? Math.abs(_bankNum(r[iDeb])) : 0;
        const cred = iCred != null ? Math.abs(_bankNum(r[iCred])) : 0;
        amount = cred - deb;
      }
      return {
        date: _impNormDate ? _impNormDate(r[iDate]) : String(r[iDate] || '').slice(0, 10),
        description: iDesc != null ? r[iDesc] : '',
        bank_ref: iRef != null ? r[iRef] : '',
        amount,
      };
    }).filter(l => l.amount);
    if (!lines.length) { toast('No se detectaron montos válidos', 'e'); return; }
    const res = await window.api.bank.importStatement({ accountId, lines, requestUserId: user.id });
    if (res?.ok) {
      toast(`${res.inserted} líneas importadas${res.skipped ? ` · ${res.skipped} duplicadas/omitidas` : ''}`, 's');
      closeModal();
      renderBancos(document.getElementById('page'));
    } else toast(res?.error || 'Error al importar', 'e');
  };
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
