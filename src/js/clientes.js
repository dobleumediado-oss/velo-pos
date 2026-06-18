// ══════════════════════════════════════════════
// clientes.js — Gestión de Clientes & Crédito
//   · CRUD via SQLite
//   · Buscador (admin y cajero)
//   · Estado de cuenta completo
//   · Crédito con límite, plazo y bloqueo
//   · Abonos con recibo impreso
//   · Cambio de estado (activo/bloqueado/moroso)
//   · Exportar PDF estado de cuenta
// ══════════════════════════════════════════════

let cliSearch = '';
let cliTab    = 'todos';

function renderClientes(el) {
  el.innerHTML = '';

  const alerts    = getCreditAlerts();
  const clientes  = DB.customers.filter(c => c.id !== 1 && c.active !== 0);
  const conDeuda  = clientes.filter(c => c.balance > 0);
  const totalDeuda= conDeuda.reduce((a, c) => a + c.balance, 0);

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Clientes'),
      h('div', { class: 'sec-sub' },
        `${clientes.length} clientes · ` +
        `${conDeuda.length} con deuda (${fmt(totalDeuda)}) · ` +
        `${alerts.length} alerta${alerts.length !== 1 ? 's' : ''}`
      )
    ),
    h('button', {
          class: 'btn btn-dark',
          onclick: openClienteModal,
          html: `${svg('plus')} Nuevo Cliente`
        })
  ));

  // ── Métricas rápidas ────────────────────────
  const metWrap = h('div', { class: 'metrics',
    style: { gridTemplateColumns: 'repeat(4,1fr)', marginBottom: '16px' } });
  [
    { icon: 'users',  color: 'b', label: 'Clientes',      val: clientes.length },
    { icon: 'dollar', color: 'r', label: 'Total por cobrar', val: fmt(totalDeuda) },
    { icon: 'alert',  color: 'a', label: 'Por vencer',    val: alerts.filter(a=>a.status==='soon').length },
    { icon: 'lock',   color: 'r', label: 'Vencidos',      val: alerts.filter(a=>a.status==='overdue').length },
  ].forEach(m => {
    metWrap.appendChild(
      h('div', { class: 'metric' },
        h('div', { class: 'met-top' },
          h('div', { class: `met-icon ${m.color}`, html: svg(m.icon) })
        ),
        h('div', { class: 'met-label' }, m.label),
        h('div', { class: 'met-val' }, String(m.val))
      )
    );
  });
  el.appendChild(metWrap);

  // ── Buscador y tabs ─────────────────────────
  el.appendChild(
    h('div', { class: 'flex', style: { marginBottom: '14px', gap: '8px', flexWrap: 'wrap' } },
      h('div', { class: 'inp-ic', style: { flex: 1, minWidth: '220px', maxWidth: '380px' } },
        h('div', { class: 'ic', html: svg('search') }),
        h('input', {
          class: 'inp', type: 'text', id: 'cli-search-inp',
          placeholder: 'Buscar por nombre, RNC, teléfono...',
          value: cliSearch,
          oninput: e => {
            cliSearch = e.target.value;
            clearTimeout(window._cliSearchTimer);
            window._cliSearchTimer = setTimeout(() => renderCliTable(), 150);
          }
        })
      ),
      h('div', { class: 'tabs', style: { marginBottom: 0 } },
        ...[
          { k: 'todos',   l: 'Todos' },
          { k: 'credito', l: `Con Crédito (${conDeuda.length})` },
          { k: 'alertas', l: alerts.length ? `Alertas (${alerts.length})` : 'Alertas' },
        ].map(t => h('button', {
          class: `tab ${cliTab === t.k ? 'on' : ''}`,
          onclick: () => { cliTab = t.k; renderCliTable(); }
        }, t.l))
      )
    )
  );

  const tableWrap = h('div', { id: 'cli-table-wrap' });
  el.appendChild(tableWrap);
  renderCliTable();
}

function renderCliTable() {
  const wrap = document.getElementById('cli-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const alerts   = getCreditAlerts();
  const alertMap = {};
  alerts.forEach(a => { alertMap[a.client.id] = a; });

  const q = cliSearch.toLowerCase().trim();

  let clients = DB.customers.filter(c => {
    if (c.id === 1 || c.active === 0) return false;
    if (cliTab === 'credito') return c.balance > 0;
    if (cliTab === 'alertas') return !!alertMap[c.id];
    return true;
  }).filter(c =>
    !q ||
    c.name.toLowerCase().includes(q)        ||
    (c.rnc   && c.rnc.includes(q))          ||
    (c.phone  && c.phone.includes(q))       ||
    (c.address && c.address.toLowerCase().includes(q))
  );

  if (!clients.length) {
    wrap.appendChild(h('div', { class: 'empty' },
      h('div', { html: svg('users'), style: { color: 'var(--muted2)' } }),
      h('p', null, cliSearch ? 'Sin resultados' : 'Sin clientes'),
      h('span', null, cliSearch ? 'Prueba otro término' : 'Agrega tu primer cliente')
    ));
    return;
  }

  const card  = h('div', { class: 'card' });
  const tw    = h('div', { class: 'tw' });
  const tbl   = h('table', null,
    h('thead', null,
      h('tr', null,
        ...['Cliente','Teléfono','Límite / Disponible','Balance','Vencimiento','Estado',''].map(t =>
          h('th', null, t)
        )
      )
    )
  );
  const tbody = h('tbody', null);

  clients.forEach(c => {
    const alert       = alertMap[c.id];
    const creditDue   = c.credit_due || null;
    const creditLimit = Number(c.credit_limit || 0);
    const creditDays  = Number(c.credit_days  || 30);
    const balance     = Number(c.balance || 0);
    const disponible  = Math.max(0, creditLimit - balance);
    const usedPct     = creditLimit > 0
      ? Math.min((balance / creditLimit) * 100, 100) : 0;
    const isBloqueado = c.status === 'bloqueado' || c.status === 'moroso';

    // Badge vencimiento
    let dueBadge = null;
    if (balance > 0 && creditDue) {
      const dl = daysDiff(today(), creditDue);
      if (dl < 0)      dueBadge = h('span', { class: 'credit-due-badge overdue' }, `Vencido ${Math.abs(dl)}d`);
      else if (dl <= 5) dueBadge = h('span', { class: 'credit-due-badge soon' },    `Vence en ${dl}d`);
      else             dueBadge = h('span', { class: 'credit-due-badge ok' },       fdate(creditDue));
    } else if (balance === 0 && creditDue) {
      dueBadge = h('span', { class: 'credit-due-badge ok' }, '✓ Saldado');
    }

    // Badge estado
    const estadoBadge = h('span', { class: `badge ${
      c.status === 'bloqueado' ? 'r' :
      c.status === 'moroso'    ? 'r' :
      alert?.status === 'overdue' ? 'r' :
      alert?.status === 'soon'    ? 'a' :
      balance > 0 ? 'b' : 'g'
    }` },
      c.status === 'bloqueado' ? 'Bloqueado' :
      c.status === 'moroso'    ? 'Moroso'    :
      alert?.status === 'overdue' ? 'Vencido'  :
      alert?.status === 'soon'    ? 'Por vencer' :
      balance > 0 ? 'Con crédito' : 'Al día'
    );

    const tr = h('tr', null,
      h('td', null,
        h('div', { class: 'tb', style: { opacity: isBloqueado ? '0.6' : '1' } }, c.name),
        h('div', { class: 'ts' }, c.rnc || 'Sin RNC')
      ),
      h('td', { class: 'ts' }, c.phone || '—'),
      h('td', null,
        h('div', { style: { fontSize: '12px', fontWeight: 600 } }, fmt(creditLimit)),
        creditLimit > 0
          ? h('div', { style: { fontSize: '10px',
              color: disponible < creditLimit * 0.1 ? 'var(--red)' : 'var(--green)' } },
              `Disponible: ${fmt(disponible)}`)
          : h('div', { class: 'ts' }, `${creditDays}d plazo`)
      ),
      h('td', null,
        h('div', { style: { fontWeight: 700, fontSize: '13px',
          color: balance > 0 ? 'var(--red)' : 'var(--green)' } }, fmt(balance)),
        creditLimit > 0
          ? h('div', { class: 'prog', style: { marginTop: '4px', width: '80px' } },
              h('div', { class: 'prog-f', style: {
                width: `${usedPct}%`,
                background: usedPct > 90 ? 'var(--red)' :
                            usedPct > 60 ? 'var(--amber)' : 'var(--green)'
              }})
            )
          : null
      ),
      h('td', null, dueBadge ||
        h('span', { style: { color: 'var(--muted2)', fontSize: '12px' } }, '—')),
      h('td', null, estadoBadge),
      h('td', null,
        h('div', { class: 'flex', style: { gap: '4px' } },
          h('button', {
            class: 'btn btn-ghost btn-sm',
            title: 'Ver estado de cuenta',
            onclick: () => openEstadoCuentaModal(c),
            html: `${svg('eye')} Ver`
          }),
          balance > 0
            ? h('button', {
                class: 'btn btn-green btn-sm',
                title: 'Registrar abono',
                onclick: () => openAbonoModal(c),
                html: `${svg('dollar')} Abonar`
              })
            : null,
          c.phone
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                title: 'Enviar mensaje por WhatsApp',
                style: { color: '#25D366' },
                onclick: () => clienteWhatsApp(c),
                html: `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="flex-shrink:0"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/></svg>`
              })
            : null,
          ['admin','superadmin','cajero'].includes(user?.role)
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                title: 'Editar cliente',
                onclick: () => openClienteModal(c),
                html: `${svg('edit')} Editar`
              })
            : null,
          ['admin','superadmin','cajero'].includes(user?.role)
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                title: `${c.status === 'bloqueado' ? 'Activar' : 'Bloquear'} cliente`,
                style: { color: c.status === 'bloqueado' ? 'var(--green)' : 'var(--amber)' },
                onclick: () => toggleEstadoCliente(c),
                html: c.status === 'bloqueado' ? svg('check') : svg('lock')
              })
            : null
        )
      )
    );

    if (c.status === 'bloqueado' || c.status === 'moroso') {
      tr.style.opacity = '0.75';
    } else if (alert?.status === 'overdue') tr.style.background = 'var(--red-bg)';
    else if (alert?.status === 'soon')     tr.style.background = 'var(--amber-bg)';

    tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  tw.appendChild(tbl);
  card.appendChild(tw);
  wrap.appendChild(card);
}
// ══════════════════════════════════════════════
// MODAL NUEVO / EDITAR CLIENTE
// ══════════════════════════════════════════════
function openClienteModal(c = null) {
  const isEdit      = !!c?.id;
  const creditLimit = Number(c?.credit_limit || 0);
  const creditDays  = Number(c?.credit_days  || 30);
  const balance     = Number(c?.balance || 0);

  openModal(`
    <div class="modal-title">${isEdit ? 'Editar Cliente' : 'Nuevo Cliente'}</div>
    <div class="modal-sub">${isEdit ? c.name : 'Registrar nuevo cliente'}</div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Nombre *</label>
        <input class="inp" id="cf-name" type="text" placeholder="Taller García"
               value="${isEdit ? c.name : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">RNC / Cédula</label>
        <input class="inp" id="cf-rnc" type="text" placeholder="101-00000-0"
               value="${isEdit ? (c.rnc || '') : ''}"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Teléfono</label>
        <input class="inp" id="cf-phone" type="tel" placeholder="809-555-0000"
               value="${isEdit ? (c.phone || '') : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">Dirección</label>
        <input class="inp" id="cf-address" type="text" placeholder="Calle, sector..."
               value="${isEdit ? (c.address || '') : ''}"/>
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Email</label>
      <input class="inp" id="cf-email" type="email" placeholder="correo@ejemplo.com"
             value="${isEdit ? (c.email || '') : ''}"/>
    </div>

    <hr style="margin:12px 0;border:none;border-top:1px solid var(--line)"/>
    <div style="font-weight:700;font-size:12px;margin-bottom:10px">Crédito</div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Límite de crédito (RD$)</label>
        <input class="inp" id="cf-limit" type="number" min="0" placeholder="0"
               value="${creditLimit}"/>
      </div>
      <div class="fg">
        <label class="lbl">Plazo de pago (días)</label>
        <input class="inp" id="cf-days" type="number" min="1" placeholder="30"
               value="${creditDays}"/>
      </div>
    </div>
    ${isEdit && balance > 0 ? `
      <div class="alrt a" style="margin-top:8px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Balance actual: ${fmt(balance)}</div>
          <div class="alrt-sub">Para modificar el balance usa la opción "Abonar".</div>
        </div>
      </div>` : ''}
    ${isEdit ? `
      <div class="fg" style="margin-top:10px">
        <label class="lbl">Estado del cliente</label>
        <select class="inp" id="cf-status">
          <option value="activo"   ${c.status==='activo'?'selected':''}>Activo</option>
          <option value="bloqueado"${c.status==='bloqueado'?'selected':''}>Bloqueado</option>
          <option value="moroso"   ${c.status==='moroso'?'selected':''}>Moroso</option>
        </select>
      </div>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="guardarCliente(${isEdit ? c.id : 'null'})">
        ${svg('check')} ${isEdit ? 'Guardar cambios' : 'Registrar cliente'}
      </button>
    </div>
  `);
}

async function guardarCliente(id) {
  const name    = document.getElementById('cf-name')?.value?.trim();
  const rnc     = document.getElementById('cf-rnc')?.value?.trim()     || '';
  const phone   = document.getElementById('cf-phone')?.value?.trim()   || '';
  const address = document.getElementById('cf-address')?.value?.trim() || '';
  const email   = document.getElementById('cf-email')?.value?.trim()   || '';
  const limit   = parseFloat(document.getElementById('cf-limit')?.value)   || 0;
  const days    = parseInt(document.getElementById('cf-days')?.value)       || 30;
  const status  = document.getElementById('cf-status')?.value              || 'activo';

  if (!name) { toast('El nombre es requerido', 'err'); return; }

  const data = { name, rnc, phone, address, email,
    credit_limit: limit, credit_days: days, status };

  let result;
  if (id) {
    result = await window.api.customers.update({ id, data, requestUserId: user.id });
  } else {
    result = await window.api.customers.create({ data, requestUserId: user.id });
  }

  if (!result.ok) { toast(result.error || 'Error al guardar', 'err'); return; }

  await reloadCustomers();
  closeModal();
  toast(id ? '✓ Cliente actualizado' : '✓ Cliente registrado');
  renderClientes(document.getElementById('page'));
  buildSidebar();
}

async function eliminarCliente(id) {
  const result = await window.api.customers.update({
    id, data: { active: 0 }, requestUserId: user.id
  });
  if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
  await reloadCustomers();
  toast('Cliente eliminado');
  renderClientes(document.getElementById('page'));
  buildSidebar();
}

// ── Cambiar estado rápido ─────────────────────
async function toggleEstadoCliente(c) {
  const nuevoEstado = c.status === 'bloqueado' ? 'activo' : 'bloqueado';
  const label = nuevoEstado === 'bloqueado' ? 'bloquear' : 'activar';

  confirmModal(
    `¿Deseas <strong>${label}</strong> al cliente <strong>${c.name}</strong>?
     ${nuevoEstado === 'bloqueado'
       ? '<br><span style="font-size:12px;color:var(--muted)">No podrá comprar a crédito mientras esté bloqueado.</span>'
       : ''}`,
    async () => {
      const result = await window.api.customers.update({
        id: c.id,
        data: { ...c, status: nuevoEstado },
        requestUserId: user.id,
      });
      if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
      await reloadCustomers();
      toast(`✓ Cliente ${nuevoEstado === 'bloqueado' ? 'bloqueado' : 'activado'}`);
      renderClientes(document.getElementById('page'));
    },
    nuevoEstado === 'bloqueado' ? 'Bloquear' : 'Activar',
    nuevoEstado === 'bloqueado' ? 'btn-red' : 'btn-green'
  );
}

// ══════════════════════════════════════════════
// MODAL ABONO
// ══════════════════════════════════════════════
function openAbonoModal(c) {
  const balance   = Number(c.balance || 0);
  const creditDue = c.credit_due || null;

  openModal(`
    <div class="modal-title">Registrar Abono</div>
    <div class="modal-sub">${c.name} · Balance: <strong style="color:var(--red)">${fmt(balance)}</strong></div>

    <div class="alrt ${creditDue && creditDue < today() ? 'r' : 'a'}" style="margin-bottom:14px">
      <div class="alrt-dot ${creditDue && creditDue < today() ? 'r' : 'a'}"></div>
      <div>
        <div class="alrt-title">Crédito pendiente: ${fmt(balance)}</div>
        <div class="alrt-sub">
          ${creditDue
            ? `Fecha límite: ${fdate(creditDue)} ${creditDue < today() ? '— VENCIDO' : ''}`
            : 'Sin fecha límite configurada'}
        </div>
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Monto del abono (RD$) *</label>
      <div class="inp-ic">
        <div class="ic">${svg('dollar')}</div>
        <input class="inp" id="ab-amount" type="number" min="1"
               max="${balance}" placeholder="${balance}"
               oninput="calcAbonoResto(${balance})"/>
      </div>
      <div id="ab-resto" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
    </div>

    <div style="margin-bottom:12px">
      <button class="btn btn-out btn-sm"
              onclick="document.getElementById('ab-amount').value=${balance};calcAbonoResto(${balance})">
        Saldar todo: ${fmt(balance)}
      </button>
    </div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Método de pago</label>
        <select class="inp" id="ab-method">
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="cheque">Cheque</option>
        </select>
      </div>
      <div class="fg">
        <label class="lbl">Referencia / Nota</label>
        <input class="inp" id="ab-note" type="text" placeholder="Número de transferencia, etc."/>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" id="btn-abono"
              onclick="registrarAbono(${c.id}, ${balance})">
        ${svg('check')} Registrar Abono
      </button>
    </div>
  `);
}

function calcAbonoResto(balance) {
  const amt   = parseFloat(document.getElementById('ab-amount')?.value) || 0;
  const resto = balance - amt;
  const el    = document.getElementById('ab-resto');
  if (!el) return;
  el.textContent = resto <= 0
    ? '✓ La deuda quedará saldada completamente'
    : `Balance restante: ${fmt(Math.max(0, resto))}`;
  el.style.color = resto <= 0 ? 'var(--green)' : 'var(--muted)';
}

async function registrarAbono(clientId, balanceActual) {
  const amount = parseFloat(document.getElementById('ab-amount')?.value);
  const method = document.getElementById('ab-method')?.value  || 'efectivo';
  const note   = document.getElementById('ab-note')?.value?.trim() || '';

  if (!amount || amount <= 0) {
    toast('Ingresa un monto válido', 'err'); return;
  }
  if (amount > balanceActual + 0.01) {
    toast(`El abono no puede ser mayor al balance (${fmt(balanceActual)})`, 'err'); return;
  }

  const btn = document.getElementById('btn-abono');
  if (btn) { btn.disabled = true; btn.textContent = 'Procesando...'; }

  const result = await window.api.customers.addPayment({
    data: { customerId: clientId, amount, method, note },
    requestUserId: user.id,
  });

  if (!result.ok) {
    toast(result.error || 'Error al registrar abono', 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = `${svg('check')} Registrar Abono`; }
    return;
  }

  await reloadCustomers();
  closeModal();
  toast(`✓ Abono de ${fmt(amount)} registrado`);

  // Imprimir recibo de abono en impresora térmica 80mm
  const c = DB.customers.find(c => c.id === clientId);
  printAbono({
    payment: {
      id:             result.paymentId || 0,
      amount,
      method,
      note:           note || 'Abono',
      balance_before: balanceActual,
      balance_after:  result.after,
      created_at:     new Date().toISOString(),
    },
    customer: {
      name:  c?.name  || '',
      rnc:   c?.rnc   || '',
      phone: c?.phone || '',
    },
    cajero: user?.name || '',
  });

  renderClientes(document.getElementById('page'));
  buildSidebar();
}

// ══════════════════════════════════════════════
// ESTADO DE CUENTA COMPLETO
// ══════════════════════════════════════════════
async function openEstadoCuentaModal(c) {
  const balance     = Number(c.balance || 0);
  const creditLimit = Number(c.credit_limit || 0);
  const creditDue   = c.credit_due || null;
  const creditDays  = Number(c.credit_days || 30);
  const disponible  = Math.max(0, creditLimit - balance);
  const usedPct     = creditLimit > 0
    ? Math.min((balance / creditLimit) * 100, 100) : 0;

  // Cargar pagos e historial desde SQLite
  const pagos  = await window.api.customers.getPayments({ customerId: c.id }) || [];
  const ventas = DB.sales.filter(s =>
    (s.customer_id || s.clientId) === c.id && s.status !== 'cancelled'
  ).reverse();

  const totalCompras = ventas.reduce((a, s) => a + s.total, 0);
  const totalAbonado = pagos.reduce((a, p) => a + p.amount, 0);

  const ventasRows = ventas.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:var(--muted2);padding:14px;font-size:12px">
         Sin compras registradas</td></tr>`
    : ventas.map(s => {
        const fecha = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
        const tipo  = s.type === 'devolucion' ? 'Devolución' :
                      s.type === 'cotizacion' ? 'Cotización' : 'Factura';
        return `
          <tr>
            <td style="font-size:11px;color:var(--muted)">${fdate(fecha)}</td>
            <td style="font-size:12px">#${String(s.id).padStart(5,'0')} <span style="font-size:10px;color:var(--muted)">${tipo}</span></td>
            <td style="text-align:right;font-weight:600">${fmt(s.total)}</td>
            <td><span class="badge ${
              (s.payment_method||s.pay)==='credito' ? 'a' :
              s.type === 'devolucion' ? 'r' : 'g'
            }">${s.payment_method || s.pay || '—'}</span></td>
            <td><span class="badge ${s.status==='returned'?'r':s.status==='cancelled'?'r':'g'}">
              ${s.status==='returned'?'Devuelta':s.status==='cancelled'?'Anulada':'OK'}
            </span></td>
          </tr>`;
      }).join('');

  const pagosRows = pagos.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:var(--muted2);padding:14px;font-size:12px">
         Sin abonos registrados</td></tr>`
    : [...pagos].reverse().map(p => {
        const fecha = (p.created_at || '').split('T')[0].split(' ')[0];
        return `
          <tr>
            <td style="font-size:11px;color:var(--muted)">${fdate(fecha)}</td>
            <td style="font-size:12px">${p.note || 'Abono'}</td>
            <td style="text-align:right;color:var(--green);font-weight:700">+${fmt(p.amount)}</td>
            <td>
              <span class="badge g">${p.method || 'efectivo'}</span>
              <span style="font-size:10px;color:var(--muted2);margin-left:4px">
                ${fmt(p.balance_before)} → ${fmt(p.balance_after)}
              </span>
            </td>
          </tr>`;
      }).join('');

  openModal(`
    <div class="modal-title">Estado de Cuenta</div>
    <div class="modal-sub">${c.name} · ${c.rnc || 'Sin RNC'} · ${c.phone || 'Sin teléfono'}</div>

    <!-- Métricas -->
    <div class="metrics" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
      <div class="metric">
        <div class="met-label">Balance Pendiente</div>
        <div class="met-val" style="color:${balance>0?'var(--red)':'var(--green)'}">
          ${fmt(balance)}</div>
      </div>
      <div class="metric">
        <div class="met-label">Límite / Disponible</div>
        <div class="met-val" style="font-size:14px">${fmt(creditLimit)}</div>
        <div style="font-size:10px;color:${disponible<creditLimit*0.1?'var(--red)':'var(--green)'}">
          Disp: ${fmt(disponible)}</div>
      </div>
      <div class="metric">
        <div class="met-label">Total Comprado</div>
        <div class="met-val" style="font-size:14px">${fmt(totalCompras)}</div>
      </div>
      <div class="metric">
        <div class="met-label">Total Abonado</div>
        <div class="met-val" style="font-size:14px;color:var(--green)">${fmt(totalAbonado)}</div>
      </div>
    </div>

    ${creditLimit > 0 ? `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:11px;
                    color:var(--muted);margin-bottom:4px">
          <span>Crédito utilizado: ${usedPct.toFixed(0)}%</span>
          <span>Vence: ${creditDue ? fdate(creditDue) : '—'} · Plazo: ${creditDays}d</span>
        </div>
        <div class="prog" style="height:8px">
          <div class="prog-f" style="width:${usedPct}%;height:8px;
            background:${usedPct>90?'var(--red)':usedPct>60?'var(--amber)':'var(--green)'}">
          </div>
        </div>
      </div>` : ''}

    <!-- Historial ventas -->
    <div style="font-weight:700;font-size:12px;margin-bottom:6px">
      Historial de Compras (${ventas.length})</div>
    <div class="tw" style="max-height:160px;overflow-y:auto;margin-bottom:12px">
      <table>
        <thead><tr>
          <th>Fecha</th><th>Factura</th>
          <th style="text-align:right">Total</th>
          <th>Método</th><th>Estado</th>
        </tr></thead>
        <tbody>${ventasRows}</tbody>
      </table>
    </div>

    <!-- Historial abonos -->
    <div style="font-weight:700;font-size:12px;margin-bottom:6px">
      Historial de Abonos (${pagos.length})</div>
    <div class="tw" style="max-height:140px;overflow-y:auto;margin-bottom:12px">
      <table>
        <thead><tr>
          <th>Fecha</th><th>Concepto</th>
          <th style="text-align:right">Monto</th><th>Método / Balance</th>
        </tr></thead>
        <tbody>${pagosRows}</tbody>
      </table>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-out"
              onclick="exportClientCreditPDF(DB.customers.find(x=>x.id===${c.id}))">
        ${svg('pdf')} PDF
      </button>
      ${['admin','superadmin','cajero'].includes(user?.role) ? `
        <button class="btn btn-ghost"
                onclick="closeModal();openClienteModal(DB.customers.find(x=>x.id===${c.id}))">
          ${svg('edit')} Editar
        </button>` : ''}
      ${balance > 0 ? `
        <button class="btn btn-green"
                onclick="closeModal();openAbonoModal(DB.customers.find(x=>x.id===${c.id}))">
          ${svg('dollar')} Abonar
        </button>` : ''}
    </div>
  `, 'modal-xl');
}
