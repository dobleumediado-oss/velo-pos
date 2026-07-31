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
let cliSort   = 'name-asc';

function cliEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cliRepresentativeLine(record, prefix = 'Solicitado por') {
  if (!record?.customer_contact_name) return '';
  return `<div style="font-size:10px;color:var(--blue);margin-top:2px">
    ${prefix}: <strong>${cliEsc(record.customer_contact_name)}</strong>${record.customer_contact_role ? ` · ${cliEsc(record.customer_contact_role)}` : ''}
  </div>`;
}

// facturaLabel() ahora es global (definido en data.js) — reutilizado aquí.

function renderClientes(el) {
  // Resetear estado de búsqueda al entrar al módulo
  cliSearch = '';
  cliSort   = 'name-asc';
  // Si viene desde dashboard con filtro predefinido
  if (window._cliTabInicial) {
    cliTab = window._cliTabInicial;
    delete window._cliTabInicial;
  } else {
    cliTab = 'todos';
  }
  el.innerHTML = '';

  const alerts    = getCreditAlerts();
  const clientes  = DB.customers.filter(c => c.id !== 1 && c.active !== 0);
  const personas  = clientes.filter(c => c.customer_type !== 'company');
  const empresas  = clientes.filter(c => c.customer_type === 'company');
  const conDeuda  = clientes.filter(c => c.balance > 0);
  const totalDeuda= conDeuda.reduce((a, c) => a + c.balance, 0);

  // ── Header ──────────────────────────────────
  const isAdmin = ['admin','superadmin'].includes(user?.role);
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Clientes'),
      h('div', { class: 'sec-sub' },
        `${clientes.length} clientes · ` +
        `${conDeuda.length} con deuda (${fmt(totalDeuda)}) · ` +
        `${alerts.length} alerta${alerts.length !== 1 ? 's' : ''}`
      )
    ),
    h('div', { class: 'flex', style: { gap: '8px' } },
      isAdmin && clientes.length > 0
        ? h('button', {
            class: 'btn btn-out',
            title: 'Eliminar todos los clientes',
            style: { color: 'var(--red)' },
            onclick: confirmEliminarTodosClientes,
            html: `${svg('trash')} Eliminar todos`
          })
        : null,
      h('button', {
            class: 'btn btn-dark',
            onclick: openClienteModal,
            html: `${svg('plus')} Nuevo Cliente`
          })
    )
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
          { k: 'personas', l: `Personas (${personas.length})` },
          { k: 'empresas', l: `Empresas (${empresas.length})` },
          { k: 'credito', l: `Con Crédito (${conDeuda.length})` },
          { k: 'alertas', l: alerts.length ? `Alertas (${alerts.length})` : 'Alertas' },
        ].map(t => h('button', {
          class: `tab ${cliTab === t.k ? 'on' : ''}`,
          onclick: () => { cliTab = t.k; renderCliTable(); }
        }, t.l))
      ),
      (() => {
        const sel = h('select', {
          class: 'inp', style: { width: '160px' },
          onchange: e => { cliSort = e.target.value; renderCliTable(); }
        });
        [
          { v: 'name-asc',     l: 'Nombre A-Z'   },
          { v: 'name-desc',    l: 'Nombre Z-A'   },
          { v: 'balance-desc', l: 'Mayor deuda'  },
          { v: 'balance-asc',  l: 'Menor deuda'  },
          { v: 'credit-desc',  l: 'Mayor límite' },
        ].forEach(o => {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.l; op.selected = o.v === cliSort;
          sel.appendChild(op);
        });
        return sel;
      })()
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

  const q       = cliSearch.trim();
  const qNorm   = searchNorm(q);
  // Versión solo-dígitos de la búsqueda: permite encontrar un teléfono o
  // RNC sin importar si el usuario escribe o no los guiones/espacios
  // (ej. "8095551234" debe encontrar un cliente guardado como "809-555-1234")
  const qDigits = digitsOf(q);

  let clients = DB.customers.filter(c => {
    if (c.id === 1 || c.active === 0) return false;
    if (cliTab === 'personas') return c.customer_type !== 'company';
    if (cliTab === 'empresas') return c.customer_type === 'company';
    if (cliTab === 'credito') return c.balance > 0;
    if (cliTab === 'alertas') return !!alertMap[c.id];
    return true;
  }).filter(c =>
    !qNorm ||
    matchText(c.name, qNorm) ||
    matchText(c.address, qNorm) ||
    matchText(c.rnc, qNorm) ||
    matchDigits(c.rnc, qDigits) ||
    matchText(c.phone, qNorm) ||
    matchDigits(c.phone, qDigits) ||
    (c.phones || []).some(p => matchText(p.phone, qNorm) || matchDigits(p.phone, qDigits)) ||
    matchText(c.trade_name, qNorm) ||
    (c.contacts || []).some(contact =>
      matchText(contact.name, qNorm) || matchText(contact.role, qNorm) ||
      matchText(contact.email, qNorm) || matchDigits(contact.phone, qDigits) ||
      matchDigits(contact.document, qDigits)
    )
  ).sort((a, b) => {
    if (cliSort === 'name-asc')     return a.name.localeCompare(b.name);
    if (cliSort === 'name-desc')    return b.name.localeCompare(a.name);
    if (cliSort === 'balance-desc') return (b.balance||0) - (a.balance||0);
    if (cliSort === 'balance-asc')  return (a.balance||0) - (b.balance||0);
    if (cliSort === 'credit-desc')  return (b.credit_limit||0) - (a.credit_limit||0);
    return a.name.localeCompare(b.name);
  });

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
    const validDue = typeof creditDue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(creditDue);
    if (balance > 0 && validDue) {
      const dl = daysDiff(today(), creditDue);
      if (dl < 0)      dueBadge = h('span', { class: 'credit-due-badge overdue' }, `Vencido ${Math.abs(dl)}d`);
      else if (dl <= 5) dueBadge = h('span', { class: 'credit-due-badge soon' },    `Vence en ${dl}d`);
      else             dueBadge = h('span', { class: 'credit-due-badge ok' },       fdate(creditDue));
    } else if (balance === 0 && validDue) {
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
        h('div', { class: 'tb', style: { opacity: isBloqueado ? '0.6' : '1' } },
          c.name,
          c.customer_type === 'company'
            ? h('span', { class: 'badge b', style: { marginLeft: '6px', fontSize: '9px' } }, 'Empresa')
            : null),
        h('div', { class: 'ts' }, [
          c.trade_name || '', c.rnc || 'Sin RNC',
          c.customer_type === 'company' && (c.contacts || []).length
            ? `${c.contacts.length} representante${c.contacts.length === 1 ? '' : 's'}` : '',
          c.customer_type === 'company' && (c.branches || []).length
            ? `${c.branches.length} sucursal${c.branches.length === 1 ? '' : 'es'}` : '',
        ].filter(Boolean).join(' · '))
      ),
      h('td', { class: 'ts' }, (c.phones || []).length
        ? c.phones.map(p => `${p.phone_type === 'celular' ? 'Cel.' : p.phone_type === 'flota' ? 'Flota' : 'Tel.'}: ${p.phone}`).join(' · ')
        : (c.phone || '—')),
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
          c.customer_type === 'company'
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                title: ['admin','superadmin'].includes(user?.role) ? 'Gestionar representantes' : 'Ver representantes',
                onclick: () => openRepresentantesModal(c.id),
                html: `${svg('users')} Representantes`
              })
            : null,
          c.customer_type === 'company'
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                title: ['admin','superadmin'].includes(user?.role) ? 'Gestionar sucursales' : 'Ver sucursales',
                onclick: () => openSucursalesModal(c.id),
                html: `${svg('map-pin')} Sucursales`
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
            : null,
          ['admin','superadmin'].includes(user?.role)
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                title: 'Eliminar cliente',
                style: { color: 'var(--red)' },
                onclick: () => confirmEliminarCliente(c),
                html: svg('trash')
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
  const customerType= c?.customer_type === 'company' ? 'company' : 'person';
  const creditLimit = Number(c?.credit_limit || 0);
  const creditDays  = Number(c?.credit_days  || 30);
  const balance     = Number(c?.balance || 0);
  const phones = (Array.isArray(c?.phones) && c.phones.length)
    ? c.phones
    : (c?.phone
      ? [{ phone_type: 'telefono', phone: c.phone, is_primary: 1 }]
      : [{ phone_type: 'celular', phone: isEdit ? '' : '1', is_primary: 1 }]);

  openModal(`
    <div class="modal-title">${isEdit ? 'Editar Cliente' : 'Nuevo Cliente'}</div>
    <div class="modal-sub">${isEdit ? cliEsc(c.name) : 'Registrar nuevo cliente'}</div>

    <div class="fg">
      <label class="lbl">Tipo de cliente</label>
      <div class="tabs" style="margin-bottom:0">
        <button type="button" id="cf-type-person" class="tab ${customerType==='person'?'on':''}"
                onclick="onCustomerTypeChange('person')">Persona</button>
        <button type="button" id="cf-type-company" class="tab ${customerType==='company'?'on':''}"
                onclick="onCustomerTypeChange('company')">Empresa</button>
      </div>
      <input type="hidden" id="cf-type" value="${customerType}"/>
    </div>

    <div class="g2">
      <div class="fg">
        <label class="lbl" id="cf-name-label">${customerType==='company'?'Razón social':'Nombre completo'} *</label>
        <input class="inp" id="cf-name" type="text" placeholder="Taller García"
               value="${isEdit ? cliEsc(c.name) : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">RNC / Cédula</label>
        <div style="display:flex;gap:6px">
          <input class="inp" id="cf-rnc" type="text" placeholder="RNC 9 díg. · Cédula 11 díg."
                 value="${isEdit ? cliEsc(c.rnc || '') : ''}" oninput="onRncInput()" style="flex:1;min-width:0"/>
          <button class="btn btn-out" type="button" onclick="verificarRncDGII()"
                  title="Verificar en la DGII (requiere internet)" style="flex-shrink:0">DGII</button>
        </div>
        <div id="cf-rnc-hint" style="font-size:10.5px;margin-top:4px;color:var(--muted2)"></div>
      </div>
    </div>
    <div class="g2 cf-company-only" style="display:${customerType==='company'?'grid':'none'}">
      <div class="fg">
        <label class="lbl">Nombre comercial <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
        <input class="inp" id="cf-trade-name" type="text" placeholder="Nombre conocido del negocio"
               value="${isEdit ? cliEsc(c.trade_name || '') : ''}"/>
      </div>
      <div class="fg">
        <label class="lbl">Correo de facturación</label>
        <input class="inp" id="cf-billing-email" type="email" placeholder="facturacion@empresa.com"
               value="${isEdit ? cliEsc(c.billing_email || '') : ''}"/>
      </div>
    </div>
    <div class="g2">
      <div class="fg">
        <div class="fxb" style="margin-bottom:6px">
          <label class="lbl" style="margin:0">Teléfonos</label>
          <button type="button" class="btn btn-out btn-sm" onclick="cfAddPhoneRow()">+ Agregar número</button>
        </div>
        <div id="cf-phone-list" style="display:flex;flex-direction:column;gap:6px">
          ${phones.map((p, index) => cfPhoneRowHtml(p, index)).join('')}
        </div>
        <div style="font-size:10px;color:var(--muted2);margin-top:5px">Marca el principal para búsquedas, WhatsApp y documentos.</div>
      </div>
      <div class="fg">
        <label class="lbl">Dirección</label>
        <input class="inp" id="cf-address" type="text" placeholder="Calle, sector..."
               value="${isEdit ? cliEsc(c.address || '') : ''}"/>
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Email</label>
      <input class="inp" id="cf-email" type="email" placeholder="correo@ejemplo.com"
             value="${isEdit ? cliEsc(c.email || '') : ''}"/>
    </div>
    <div class="g2">
      <div class="fg">
        <label class="lbl">Precio preferido</label>
        <select class="inp" id="cf-price-mode">
          <option value="retail" ${(c?.preferred_price_mode||'retail')==='retail'?'selected':''}>Detalle</option>
          <option value="wholesale" ${c?.preferred_price_mode==='wholesale'?'selected':''}>Mayorista</option>
        </select>
      </div>
      <div class="fg">
        <label class="lbl">Notas internas</label>
        <input class="inp" id="cf-notes" type="text" maxlength="500" placeholder="Información comercial opcional"
               value="${isEdit ? cliEsc(c.notes || '') : ''}"/>
      </div>
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
    ${isEdit && customerType === 'company' ? `
      <div class="alrt b" style="margin-top:10px">
        <div><div class="alrt-title">Representantes de la empresa</div>
        <div class="alrt-sub">${(c.contacts||[]).length} registrado(s). Guarda los cambios y usa “Representantes” desde la lista para administrarlos.</div></div>
      </div>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="guardarCliente(${isEdit ? c.id : 'null'})">
        ${svg('check')} ${isEdit ? 'Guardar cambios' : 'Registrar cliente'}
      </button>
    </div>
  `);
  // Inicializa el detector de tipo de documento (muestra RNC/Cédula al editar)
  setTimeout(() => { onCustomerTypeChange(customerType); onRncInput(); }, 30);
}

function cfPhoneRowHtml(phone = {}, index = Date.now()) {
  const type = ['telefono','celular','flota'].includes(phone.phone_type) ? phone.phone_type : 'telefono';
  return `<div class="cf-phone-row" style="display:grid;grid-template-columns:105px 1fr 26px 26px;gap:5px;align-items:center">
    <select class="inp cf-phone-type" aria-label="Tipo de teléfono">
      <option value="telefono" ${type==='telefono'?'selected':''}>Teléfono</option>
      <option value="celular" ${type==='celular'?'selected':''}>Celular</option>
      <option value="flota" ${type==='flota'?'selected':''}>Flota</option>
    </select>
    <input class="inp cf-phone-number" type="tel" maxlength="40" placeholder="1809-555-0000"
           value="${cliEsc(phone.phone || '')}" onblur="cfNormalizePhoneInput(this)"/>
    <input type="radio" name="cf-phone-primary" class="cf-phone-primary"
           title="Número principal" aria-label="Número principal" ${phone.is_primary || index===0?'checked':''}/>
    <button type="button" class="btn btn-ghost btn-sm" title="Quitar número"
            onclick="cfRemovePhoneRow(this)" style="padding:3px">×</button>
  </div>`;
}

function cfNormalizePhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits || digits === '1') return '';
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return raw;
}

function cfNormalizePhoneInput(input) {
  if (!input) return;
  const normalized = cfNormalizePhone(input.value);
  input.value = normalized || (String(input.value || '').replace(/\D/g, '') === '1' ? '1' : '');
}

function cfAddPhoneRow() {
  const list = document.getElementById('cf-phone-list');
  if (!list) return;
  if (list.querySelectorAll('.cf-phone-row').length >= 12) {
    toast('Puedes registrar hasta 12 números por cliente', 'w');
    return;
  }
  list.insertAdjacentHTML('beforeend', cfPhoneRowHtml({ phone_type: 'celular', phone: '1', is_primary: false }, Date.now()));
}

function cfRemovePhoneRow(button) {
  const row = button?.closest('.cf-phone-row');
  const list = document.getElementById('cf-phone-list');
  if (!row || !list) return;
  const wasPrimary = !!row.querySelector('.cf-phone-primary')?.checked;
  row.remove();
  if (wasPrimary) {
    const first = list.querySelector('.cf-phone-primary');
    if (first) first.checked = true;
  }
  if (!list.querySelector('.cf-phone-row')) cfAddPhoneRow();
}

function onCustomerTypeChange(type) {
  const value = type === 'company' ? 'company' : 'person';
  const input = document.getElementById('cf-type');
  if (input) input.value = value;
  document.getElementById('cf-type-person')?.classList.toggle('on', value === 'person');
  document.getElementById('cf-type-company')?.classList.toggle('on', value === 'company');
  document.querySelectorAll('.cf-company-only').forEach(el => {
    el.style.display = value === 'company' ? 'grid' : 'none';
  });
  const label = document.getElementById('cf-name-label');
  if (label) label.textContent = value === 'company' ? 'Razón social *' : 'Nombre completo *';
  const name = document.getElementById('cf-name');
  if (name) name.placeholder = value === 'company' ? 'Repuestos del Cibao, SRL' : 'María Pérez';
}

// ── Validación de documento RD (offline) ──────────────────────────────────
// RNC = 9 dígitos (persona jurídica) · Cédula = 11 dígitos (persona física),
// cada uno con su dígito verificador. Es informativo, nunca bloquea el guardado
// (la verificación autoritativa es el botón "DGII" en línea).
function _rncChecksum(d) {
  if (d.length !== 9) return false;
  const w = [7, 9, 8, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += parseInt(d[i], 10) * w[i];
  const r = sum % 11;
  const chk = r === 0 ? 2 : r === 1 ? 1 : 11 - r;
  return chk === parseInt(d[8], 10);
}
function _cedulaChecksum(d) {
  if (d.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let p = parseInt(d[i], 10) * ((i % 2 === 0) ? 1 : 2);
    if (p > 9) p -= 9;
    sum += p;
  }
  const chk = (10 - (sum % 10)) % 10;
  return chk === parseInt(d[10], 10);
}
function onRncInput() {
  const el   = document.getElementById('cf-rnc');
  const hint = document.getElementById('cf-rnc-hint');
  if (!el || !hint) return;
  const d = (el.value || '').replace(/\D/g, '');
  if (!d) {
    hint.textContent = 'RNC = 9 dígitos · Cédula = 11 dígitos';
    hint.style.color = 'var(--muted2)';
    return;
  }
  if (d.length === 9) {
    const ok = _rncChecksum(d);
    hint.textContent = ok ? '✓ RNC válido — Persona jurídica'
                          : '⚠ RNC de 9 dígitos — revisa el dígito verificador';
    hint.style.color = ok ? 'var(--green)' : 'var(--amber)';
  } else if (d.length === 11) {
    const ok = _cedulaChecksum(d);
    hint.textContent = ok ? '✓ Cédula válida — Persona física'
                          : '⚠ Cédula de 11 dígitos — revisa el dígito verificador';
    hint.style.color = ok ? 'var(--green)' : 'var(--amber)';
  } else {
    hint.textContent = `${d.length} dígitos — RNC usa 9, Cédula usa 11`;
    hint.style.color = 'var(--amber)';
  }
}
async function verificarRncDGII() {
  const el   = document.getElementById('cf-rnc');
  const hint = document.getElementById('cf-rnc-hint');
  if (!el) return;
  const d = (el.value || '').replace(/\D/g, '');
  if (d.length !== 9 && d.length !== 11) {
    toast('Ingresa un RNC (9 díg.) o Cédula (11 díg.)', 'err');
    return;
  }
  // Cédula (11) y RNC (9) se interpretan distinto: para una persona física
  // NO figurar como contribuyente en la DGII es lo normal (no es un error).
  const esCedula = d.length === 11;
  if (hint) { hint.textContent = 'Consultando DGII…'; hint.style.color = 'var(--muted2)'; }
  try {
    const res = await window.api.ncf.validateRnc({ rnc: d });
    if (res?.ok) {
      if (hint) {
        hint.textContent = `✓ Inscrito en DGII: ${res.nombre || 'Contribuyente'} — ${res.estado || 'ACTIVO'}`;
        hint.style.color = 'var(--green)';
      }
      const nameEl = document.getElementById('cf-name');
      if (nameEl && !nameEl.value.trim() && res.nombre) nameEl.value = res.nombre;
      toast('Verificado en la DGII');
    } else if (hint) {
      if (esCedula) {
        // Mantiene coherencia con la validación offline: la cédula sigue siendo
        // un documento válido de persona física; solo no está registrada como
        // contribuyente (lo habitual). No se muestra como error.
        const okFmt = _cedulaChecksum(d);
        hint.textContent = okFmt
          ? 'Cédula válida — Persona física · No figura como contribuyente en DGII (normal)'
          : 'Cédula persona física · No inscrita en DGII y con dígito verificador dudoso';
        hint.style.color = 'var(--muted2)';
      } else {
        hint.textContent = '⚠ RNC no inscrito en la DGII como contribuyente — verifica el número';
        hint.style.color = 'var(--amber)';
      }
    }
  } catch (e) {
    if (hint) {
      hint.textContent = 'Sin conexión para verificar en la DGII (puedes guardar igual)';
      hint.style.color = 'var(--muted2)';
    }
  }
}

async function guardarCliente(id) {
  const customerType = document.getElementById('cf-type')?.value === 'company' ? 'company' : 'person';
  const name    = document.getElementById('cf-name')?.value?.trim();
  const rnc     = document.getElementById('cf-rnc')?.value?.trim()     || '';
  const phones = [...document.querySelectorAll('#cf-phone-list .cf-phone-row')].map(row => ({
    phone_type: row.querySelector('.cf-phone-type')?.value || 'telefono',
    phone: cfNormalizePhone(row.querySelector('.cf-phone-number')?.value),
    is_primary: !!row.querySelector('.cf-phone-primary')?.checked,
  })).filter(row => row.phone);
  if (phones.length && !phones.some(row => row.is_primary)) phones[0].is_primary = true;
  const phone = (phones.find(row => row.is_primary) || phones[0])?.phone || '';
  const address = document.getElementById('cf-address')?.value?.trim() || '';
  const email   = document.getElementById('cf-email')?.value?.trim()   || '';
  const tradeName = document.getElementById('cf-trade-name')?.value?.trim() || '';
  const billingEmail = document.getElementById('cf-billing-email')?.value?.trim() || '';
  const preferredPriceMode = document.getElementById('cf-price-mode')?.value === 'wholesale' ? 'wholesale' : 'retail';
  const notes = document.getElementById('cf-notes')?.value?.trim() || '';
  const limit   = parseFloat(document.getElementById('cf-limit')?.value)   || 0;
  const days    = parseInt(document.getElementById('cf-days')?.value)       || 30;
  const status  = document.getElementById('cf-status')?.value              || 'activo';

  if (!name) { toast('El nombre es requerido', 'err'); return; }

  const data = { name, customer_type: customerType, trade_name: tradeName, rnc, phone, phones, address, email,
    billing_email: billingEmail, preferred_price_mode: preferredPriceMode, notes,
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

// ══════════════════════════════════════════════
// REPRESENTANTES DE EMPRESA
// ══════════════════════════════════════════════
function openRepresentantesModal(customerId) {
  const company = (DB.customers || []).find(c => Number(c.id) === Number(customerId));
  if (!company || company.customer_type !== 'company') {
    toast('La empresa no está disponible', 'err');
    return;
  }
  const contacts = (company.contacts || []).filter(c => c.active !== 0);
  const canManage = ['admin','superadmin'].includes(user?.role);
  openModal(`
    <div class="modal-title">Representantes</div>
    <div class="modal-sub">${cliEsc(company.name)}${company.rnc ? ` · ${cliEsc(company.rnc)}` : ''}</div>
    ${canManage ? `<div style="display:flex;justify-content:flex-end;margin:12px 0">
      <button class="btn btn-dark" onclick="openRepresentanteForm(${company.id})">${svg('plus')} Nuevo representante</button>
    </div>` : '<div style="height:8px"></div>'}
    ${contacts.length ? `<div class="card" style="padding:0;overflow:hidden">
      ${contacts.map(contact => `
        <div style="padding:13px 14px;border-bottom:1px solid var(--line)">
          <div style="display:flex;align-items:flex-start;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:750">${cliEsc(contact.name)}${contact.is_primary ? ' <span class="badge g">Principal</span>' : ''}</div>
            <div class="ts">${[contact.role,contact.document,contact.phone,contact.email].filter(Boolean).map(cliEsc).join(' · ') || 'Sin datos adicionales'}</div>
            <div class="ts" style="margin-top:3px">${[
              contact.can_order ? 'Puede solicitar' : '',
              contact.can_receive ? 'Puede recibir' : '',
              contact.can_receive_invoices ? 'Recibe facturas' : '',
            ].filter(Boolean).join(' · ') || 'Sin permisos operativos'}</div>
          </div>
          ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="openRepresentanteForm(${company.id},${contact.id})">${svg('edit')} Editar</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmEliminarRepresentante(${company.id},${contact.id})">${svg('trash')}</button>` : ''}
          </div>
          <div id="rep-activity-${contact.id}" style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);font-size:11px;color:var(--muted2)">
            Cargando actividad comercial...
          </div>
        </div>`).join('')}
    </div>` : `<div class="empty" style="padding:32px"><div>${svg('users')}</div><p>Sin representantes</p><span>Agrega las personas que compran o reciben en nombre de esta empresa.</span></div>`}
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>
  `, 'modal-lg');
  cargarActividadRepresentantes(company.id, contacts);
}

async function cargarActividadRepresentantes(customerId, contacts) {
  try {
    const [salesRaw, payments, pending] = await Promise.all([
      window.api.sales.getAll({ customerId, range: 'all', limit: 9999 }),
      window.api.customers.getPayments({ customerId }),
      window.api.customers.getFacturasPendientes({ customerId }),
    ]);
    const sales = (Array.isArray(salesRaw) ? salesRaw : []).filter(s => s.status !== 'cancelled');
    const pays = Array.isArray(payments) ? payments : [];
    const pendingInvoices = pending?.ok ? (pending.facturas || []) : [];

    contacts.forEach(contact => {
      const el = document.getElementById(`rep-activity-${contact.id}`);
      if (!el) return;
      const documents = sales.filter(s => Number(s.customer_contact_id) === Number(contact.id));
      const invoices = documents.filter(s => s.type === 'factura');
      const quotes = documents.filter(s => s.type === 'cotizacion');
      const creditInvoices = invoices.filter(s => ['credito','crédito','credit'].includes(String(s.payment_method || '').toLowerCase()));
      const attributedPayments = pays.filter(p => Number(p.customer_contact_id) === Number(contact.id));
      const pendingCredit = pendingInvoices
        .filter(f => Number(f.customer_contact_id) === Number(contact.id))
        .reduce((sum, f) => sum + Number(f.pendiente || 0), 0);
      const invoiced = invoices.reduce((sum, s) => sum + Number(s.total || 0), 0);
      const paid = attributedPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const timeline = [
        ...documents.map(s => ({ date: s.sale_date, label: `${facturaLabel(s)} · ${s.type === 'cotizacion' ? 'Cotización' : 'Factura'} · ${fmt(s.total || 0)}` })),
        ...attributedPayments.map(p => ({ date: p.created_at, label: `${reciboLabel(p)} · Abono · ${fmt(p.amount || 0)}` })),
      ].sort((a,b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 3);
      el.innerHTML = `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:${timeline.length ? '7px' : '0'}">
          <span class="badge">${invoices.length} factura${invoices.length === 1 ? '' : 's'} · ${fmt(invoiced)}</span>
          <span class="badge b">${quotes.length} cotización${quotes.length === 1 ? '' : 'es'}</span>
          <span class="badge ${pendingCredit > 0 ? 'r' : 'g'}">Crédito pendiente: ${fmt(pendingCredit)}</span>
          <span class="badge g">${attributedPayments.length} abono${attributedPayments.length === 1 ? '' : 's'} · ${fmt(paid)}</span>
        </div>
        ${creditInvoices.length ? `<div style="color:var(--amber);margin-bottom:5px"><strong>${creditInvoices.length}</strong> factura${creditInvoices.length === 1 ? '' : 's'} tomada${creditInvoices.length === 1 ? '' : 's'} a crédito por este representante.</div>` : ''}
        ${timeline.length ? timeline.map(item => `<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">
          <span>${cliEsc(item.label)}</span><span style="color:var(--muted2);white-space:nowrap">${item.date ? fdate(String(item.date).split('T')[0].split(' ')[0]) : ''}</span>
        </div>`).join('') : '<div>Sin operaciones atribuidas todavía.</div>'}`;
    });
  } catch (error) {
    contacts.forEach(contact => {
      const el = document.getElementById(`rep-activity-${contact.id}`);
      if (el) el.textContent = 'No se pudo cargar la actividad comercial.';
    });
  }
}

function openRepresentanteForm(customerId, contactId = null) {
  const company = (DB.customers || []).find(c => Number(c.id) === Number(customerId));
  const contact = (company?.contacts || []).find(c => Number(c.id) === Number(contactId));
  if (!company) return;
  openModal(`
    <div class="modal-title">${contact ? 'Editar representante' : 'Nuevo representante'}</div>
    <div class="modal-sub">Actuará en nombre de ${cliEsc(company.name)}</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nombre completo *</label>
        <input class="inp" id="cr-name" value="${cliEsc(contact?.name || '')}" placeholder="Juan Pérez"/></div>
      <div class="fg"><label class="lbl">Cargo</label>
        <input class="inp" id="cr-role" value="${cliEsc(contact?.role || '')}" placeholder="Encargado de compras"/></div>
    </div>
    <div class="g2">
      <div class="fg"><label class="lbl">Cédula / documento</label>
        <input class="inp" id="cr-document" value="${cliEsc(contact?.document || '')}"/></div>
      <div class="fg"><label class="lbl">Teléfono / WhatsApp</label>
        <input class="inp" id="cr-phone" type="tel"
               value="${cliEsc(contact?.phone || (contact ? '' : '1'))}"
               onblur="cfNormalizePhoneInput(this)"/></div>
    </div>
    <div class="fg"><label class="lbl">Correo</label>
      <input class="inp" id="cr-email" type="email" value="${cliEsc(contact?.email || '')}"/></div>
    <div class="card" style="background:var(--surface2);margin-top:8px">
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input id="cr-primary" type="checkbox" ${contact?.is_primary?'checked':''}/> Representante principal</label>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input id="cr-order" type="checkbox" ${contact?.can_order!==0?'checked':''}/> Puede solicitar compras</label>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input id="cr-receive" type="checkbox" ${contact?.can_receive!==0?'checked':''}/> Puede recibir mercancía</label>
      <label style="display:flex;gap:8px;align-items:center"><input id="cr-invoices" type="checkbox" ${contact?.can_receive_invoices!==0?'checked':''}/> Puede recibir facturas</label>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="openRepresentantesModal(${company.id})">Volver</button>
      <button class="btn btn-dark" id="cr-save" onclick="guardarRepresentante(${company.id},${contact?.id || 'null'})">${svg('check')} Guardar</button>
    </div>
  `);
}

async function guardarRepresentante(customerId, contactId) {
  const data = {
    name: document.getElementById('cr-name')?.value?.trim() || '',
    role: document.getElementById('cr-role')?.value?.trim() || '',
    document: document.getElementById('cr-document')?.value?.trim() || '',
    phone: cfNormalizePhone(document.getElementById('cr-phone')?.value),
    email: document.getElementById('cr-email')?.value?.trim() || '',
    is_primary: document.getElementById('cr-primary')?.checked ? 1 : 0,
    can_order: document.getElementById('cr-order')?.checked ? 1 : 0,
    can_receive: document.getElementById('cr-receive')?.checked ? 1 : 0,
    can_receive_invoices: document.getElementById('cr-invoices')?.checked ? 1 : 0,
  };
  if (!data.name) return toast('El nombre del representante es requerido', 'err');
  const btn = document.getElementById('cr-save');
  if (btn) btn.disabled = true;
  const result = contactId
    ? await window.api.customers.updateContact({ id: contactId, data, requestUserId: user.id })
    : await window.api.customers.createContact({ customerId, data, requestUserId: user.id });
  if (!result?.ok) {
    if (btn) btn.disabled = false;
    return toast(result?.error || 'No se pudo guardar el representante', 'err');
  }
  await reloadCustomers();
  toast(contactId ? '✓ Representante actualizado' : '✓ Representante registrado');
  openRepresentantesModal(customerId);
  renderCliTable();
}

function confirmEliminarRepresentante(customerId, contactId) {
  const company = (DB.customers || []).find(c => Number(c.id) === Number(customerId));
  const contact = (company?.contacts || []).find(c => Number(c.id) === Number(contactId));
  if (!contact) return;
  confirmModal(`¿Desactivar a <strong>${cliEsc(contact.name)}</strong> como representante de ${cliEsc(company.name)}?`, async () => {
    const result = await window.api.customers.deleteContact({ id: contactId, requestUserId: user.id });
    if (!result?.ok) return toast(result?.error || 'No se pudo desactivar', 'err');
    await reloadCustomers();
    toast('✓ Representante desactivado');
    openRepresentantesModal(customerId);
    renderCliTable();
  }, 'Desactivar', 'btn-red');
}

// ══════════════════════════════════════════════
// SUCURSALES DEL CLIENTE EMPRESA
// La empresa es dueña del RNC, crédito y cuenta por cobrar; las sucursales son
// solo ubicaciones de entrega bajo esa misma cuenta (mismo RNC, sin choque).
// ══════════════════════════════════════════════
function openSucursalesModal(customerId) {
  const company = (DB.customers || []).find(c => Number(c.id) === Number(customerId));
  if (!company || company.customer_type !== 'company') {
    toast('La empresa no está disponible', 'err');
    return;
  }
  const branches = (company.branches || []).filter(b => b.active !== 0);
  const canManage = ['admin','superadmin'].includes(user?.role);
  openModal(`
    <div class="modal-title">Sucursales</div>
    <div class="modal-sub">${cliEsc(company.name)}${company.rnc ? ` · ${cliEsc(company.rnc)}` : ''}</div>
    <div class="alrt b" style="margin:12px 0"><div><div class="alrt-title">Mismo RNC, una sola cuenta</div>
      <div class="alrt-sub">El crédito, las facturas y la cuenta por cobrar siguen a nombre de la empresa. Las sucursales son ubicaciones de entrega.</div></div></div>
    ${canManage ? `<div style="display:flex;justify-content:flex-end;margin:12px 0">
      <button class="btn btn-dark" onclick="openSucursalForm(${company.id})">${svg('plus')} Nueva sucursal</button>
    </div>` : '<div style="height:8px"></div>'}
    ${branches.length ? `<div class="card" style="padding:0;overflow:hidden">
      ${branches.map(branch => `
        <div style="padding:13px 14px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:750">${cliEsc(branch.name)}${branch.is_primary ? ' <span class="badge g">Principal</span>' : ''}${branch.code ? ` <span class="badge">Est. ${cliEsc(branch.code)}</span>` : ''}</div>
            <div class="ts">${[branch.address, branch.phone, branch.manager ? `Encargado: ${branch.manager}` : ''].filter(Boolean).map(cliEsc).join(' · ') || 'Sin datos adicionales'}</div>
          </div>
          ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="openSucursalForm(${company.id},${branch.id})">${svg('edit')} Editar</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmEliminarSucursal(${company.id},${branch.id})">${svg('trash')}</button>` : ''}
        </div>`).join('')}
    </div>` : `<div class="empty" style="padding:32px"><div>${svg('map-pin')}</div><p>Sin sucursales</p><span>Agrega las ubicaciones de entrega de esta empresa (mismo RNC).</span></div>`}
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>
  `, 'modal-lg');
}

function openSucursalForm(customerId, branchId = null) {
  const company = (DB.customers || []).find(c => Number(c.id) === Number(customerId));
  const branch = (company?.branches || []).find(b => Number(b.id) === Number(branchId));
  if (!company) return;
  openModal(`
    <div class="modal-title">${branch ? 'Editar sucursal' : 'Nueva sucursal'}</div>
    <div class="modal-sub">Ubicación de entrega de ${cliEsc(company.name)}</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nombre de la sucursal *</label>
        <input class="inp" id="cs-name" value="${cliEsc(branch?.name || '')}" placeholder="Sucursal Santiago"/></div>
      <div class="fg"><label class="lbl">No. de establecimiento</label>
        <input class="inp" id="cs-code" value="${cliEsc(branch?.code || '')}" placeholder="002"/></div>
    </div>
    <div class="fg"><label class="lbl">Dirección</label>
      <input class="inp" id="cs-address" value="${cliEsc(branch?.address || '')}" placeholder="Av. Estrella Sadhalá #45"/></div>
    <div class="g2">
      <div class="fg"><label class="lbl">Teléfono</label>
        <input class="inp" id="cs-phone" type="tel" value="${cliEsc(branch?.phone || '')}"/></div>
      <div class="fg"><label class="lbl">Encargado</label>
        <input class="inp" id="cs-manager" value="${cliEsc(branch?.manager || '')}" placeholder="Persona de contacto"/></div>
    </div>
    <div class="card" style="background:var(--surface2);margin-top:8px">
      <label style="display:flex;gap:8px;align-items:center"><input id="cs-primary" type="checkbox" ${branch?.is_primary?'checked':''}/> Sucursal principal</label>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="openSucursalesModal(${company.id})">Volver</button>
      <button class="btn btn-dark" id="cs-save" onclick="guardarSucursal(${company.id},${branch?.id || 'null'})">${svg('check')} Guardar</button>
    </div>
  `);
}

async function guardarSucursal(customerId, branchId) {
  const data = {
    name: document.getElementById('cs-name')?.value?.trim() || '',
    code: document.getElementById('cs-code')?.value?.trim() || '',
    address: document.getElementById('cs-address')?.value?.trim() || '',
    phone: document.getElementById('cs-phone')?.value?.trim() || '',
    manager: document.getElementById('cs-manager')?.value?.trim() || '',
    is_primary: document.getElementById('cs-primary')?.checked ? 1 : 0,
  };
  if (!data.name) return toast('El nombre de la sucursal es requerido', 'err');
  const btn = document.getElementById('cs-save');
  if (btn) btn.disabled = true;
  const result = branchId
    ? await window.api.customers.updateBranch({ id: branchId, data, requestUserId: user.id })
    : await window.api.customers.createBranch({ customerId, data, requestUserId: user.id });
  if (!result?.ok) {
    if (btn) btn.disabled = false;
    return toast(result?.error || 'No se pudo guardar la sucursal', 'err');
  }
  await reloadCustomers();
  toast(branchId ? '✓ Sucursal actualizada' : '✓ Sucursal registrada');
  openSucursalesModal(customerId);
  renderCliTable();
}

function confirmEliminarSucursal(customerId, branchId) {
  const company = (DB.customers || []).find(c => Number(c.id) === Number(customerId));
  const branch = (company?.branches || []).find(b => Number(b.id) === Number(branchId));
  if (!branch) return;
  confirmModal(`¿Desactivar la sucursal <strong>${cliEsc(branch.name)}</strong> de ${cliEsc(company.name)}?`, async () => {
    const result = await window.api.customers.deleteBranch({ id: branchId, requestUserId: user.id });
    if (!result?.ok) return toast(result?.error || 'No se pudo desactivar', 'err');
    await reloadCustomers();
    toast('✓ Sucursal desactivada');
    openSucursalesModal(customerId);
    renderCliTable();
  }, 'Desactivar', 'btn-red');
}

function confirmEliminarCliente(c) {
  const balance = Number(c.balance || 0);
  confirmModal(
    `¿Eliminar a <strong>${c.name}</strong>?
     <br><span style="font-size:12px;color:var(--muted)">El cliente quedará inactivo y desaparecerá de la lista y los reportes.</span>
     ${balance > 0 ? `
       <br><br><span style="font-size:12px;color:var(--red)">
         ⚠ Este cliente tiene un balance pendiente de <strong>${fmt(balance)}</strong>.
         Al eliminarlo, ese monto dejará de contarse en Cuentas por Cobrar y en los reportes.
       </span>` : ''}`,
    () => eliminarCliente(c.id),
    'Eliminar', 'btn-red'
  );
}

async function eliminarCliente(id) {
  const result = await window.api.customers.delete({ id, requestUserId: user.id });
  if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
  await reloadCustomers();
  toast(result.balance > 0
    ? `✓ Cliente eliminado · ${fmt(result.balance)} removido de Cuentas por Cobrar`
    : '✓ Cliente eliminado');
  renderClientes(document.getElementById('page'));
  buildSidebar();
}

function confirmEliminarTodosClientes() {
  const clientes  = DB.customers.filter(c => c.id !== 1 && c.active !== 0);
  const totalDeuda = clientes.reduce((a, c) => a + Number(c.balance || 0), 0);
  const plural = clientes.length === 1 ? '1 cliente registrado' : `los ${clientes.length} clientes registrados`;
  confirmModal(
    `¿Eliminar <strong>${plural}</strong>?
     <br><span style="font-size:12px;color:var(--muted)">
       Quedarán inactivos: desaparecerán de la lista, del dashboard y de todos los reportes.
       Esta acción no se puede deshacer desde aquí.</span>
     ${totalDeuda > 0 ? `
       <br><br><span style="font-size:12px;color:var(--red)">
         ⚠ Hay <strong>${fmt(totalDeuda)}</strong> en balances pendientes entre estos clientes.
         Ese monto dejará de contarse en Cuentas por Cobrar y en los reportes.
       </span>` : ''}`,
    eliminarTodosClientes,
    'Eliminar todos', 'btn-red'
  );
}

async function eliminarTodosClientes() {
  const result = await window.api.customers.deleteAll({ requestUserId: user.id });
  if (!result.ok) { toast(result.error || 'Error', 'err'); return; }
  await reloadCustomers();
  const plural = result.count === 1 ? '1 cliente eliminado' : `${result.count} clientes eliminados`;
  toast(result.totalBalance > 0
    ? `✓ ${plural} · ${fmt(result.totalBalance)} removido de Cuentas por Cobrar`
    : `✓ ${plural}`);
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

// ── Enviar mensaje por WhatsApp ───────────────
function clienteWhatsApp(c) {
  if (!c) { toast('Cliente no encontrado', 'err'); return; }
  const preferred = (c.phones || []).find(p => p.is_primary)
    || (c.phones || []).find(p => p.phone_type === 'celular')
    || (c.phones || [])[0];
  const customerPhone = preferred?.phone || c.phone || '';
  if (!customerPhone) { toast('Este cliente no tiene teléfono registrado', 'w'); return; }

  const phone   = customerPhone.replace(/\D/g, '');
  const balance = Number(c.balance || 0);

  const msg = [
    `Hola ${c.name},`,
    '',
    balance > 0
      ? `Le recordamos que tiene un saldo pendiente de ${fmt(balance)} con ${CFG.biz}.\nPor favor comuníquese con nosotros para coordinar el pago.`
      : `Gracias por ser cliente de ${CFG.biz}.`,
    '',
    CFG.phone ? `Tel: ${CFG.phone}` : '',
  ].filter(l => l !== null && l !== undefined).join('\n');

  openWhatsAppModal(msg, phone, c.name);
}

// ══════════════════════════════════════════════
// MODAL ABONO
// ══════════════════════════════════════════════
async function openAbonoModal(c, prefill = null) {
  const balance   = Number(c.balance || 0);
  const creditDue = c.credit_due || null;
  const contacts  = c.customer_type === 'company'
    ? (c.contacts || []).filter(x => x.active !== 0)
    : [];
  const primaryContact = contacts.find(x => x.is_primary) || contacts[0] || null;
  let pending = { facturas: [], unallocatedBalance: balance };
  try {
    const result = await window.api.customers.getFacturasPendientes({ customerId: c.id });
    if (result?.ok) pending = result;
  } catch {}
  const invoices = pending.facturas || [];
  window._abonoPendingInvoices = invoices;
  window._abonoUnallocatedBalance = Number(pending.unallocatedBalance || 0);

  openModal(`
    <div class="modal-title">${prefill ? 'Registrar abono corregido' : 'Registrar Abono'}</div>
    <div class="modal-sub">${c.name} · Balance: <strong style="color:var(--red)">${fmt(balance)}</strong></div>
    ${prefill ? `<div class="alrt b" style="margin-bottom:14px">
      <div class="alrt-dot b"></div>
      <div>
        <div class="alrt-title">Corrección de ${cliEsc(prefill.sourceReceipt || 'recibo anulado')}</div>
        <div class="alrt-sub">Los datos fueron precargados. Revisa el monto, método y distribución antes de confirmar.</div>
      </div>
    </div>` : ''}

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
               oninput="abonoAmountChanged(${balance})"/>
      </div>
      <div id="ab-resto" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
    </div>

    ${invoices.length ? `<div class="card" style="padding:12px;margin-bottom:14px;background:var(--surface2)">
      <div class="fxb" style="gap:10px;margin-bottom:9px">
        <div>
          <div style="font-size:12px;font-weight:800">Distribuir entre facturas</div>
          <div class="ts">Puedes seleccionar varias. La última puede recibir un abono parcial.</div>
        </div>
        <div class="flex" style="gap:5px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-out btn-sm" onclick="abonoAutoDistribuir(${balance})">Automático</button>
          <button class="btn btn-ghost btn-sm" onclick="abonoLimpiarDistribucion(${balance})">Limpiar</button>
        </div>
      </div>
      <div style="max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--surface)">
        ${invoices.map((invoice, index) => {
          const pendingAmount = Number(invoice.pendiente || 0);
          const corrected = invoice.correction_kind === 'product_addition' || Number(invoice.revision || 0) > 0;
          return `<label style="display:grid;grid-template-columns:22px minmax(0,1fr) 132px;gap:8px;align-items:center;padding:10px;border-bottom:1px solid var(--line);cursor:pointer">
            <input type="checkbox" class="ab-invoice-check" data-sale-id="${invoice.id}"
                   data-pending="${pendingAmount}" ${invoices.length === 1 ? 'checked' : ''}
                   onchange="abonoToggleInvoice(${invoice.id},${pendingAmount},${balance})"/>
            <span style="min-width:0">
              <strong>${cliEsc(facturaLabel(invoice))}</strong>
              ${corrected ? '<span class="badge a" style="margin-left:5px">Ajustada</span>' : ''}
              <span class="ts" style="display:block">Pendiente ${fmt(pendingAmount)}${invoice.ncf ? ` · NCF ${cliEsc(invoice.ncf)}` : ''}</span>
            </span>
            <input class="inp ab-allocation-amount" id="ab-alloc-${invoice.id}" type="number"
                   min="0" max="${pendingAmount}" step="0.01"
                   value="${invoices.length === 1 ? '' : ''}" placeholder="RD$ 0.00"
                   ${invoices.length === 1 ? '' : 'disabled'}
                   onclick="event.stopPropagation()" oninput="abonoAllocationChanged(${balance})"/>
          </label>`;
        }).join('')}
      </div>
      ${Number(pending.unallocatedBalance || 0) > 0 ? `<div class="ts" style="margin-top:7px">
        Además existen ${fmt(pending.unallocatedBalance)} de saldo no vinculado a una factura; cualquier remanente puede aplicarse allí.
      </div>` : ''}
      <div id="ab-allocation-summary" class="alrt b" style="margin:10px 0 0;padding:9px 11px"></div>
    </div>` : `<div class="alrt b" style="margin-bottom:12px">
      <div class="alrt-dot b"></div>
      <div><div class="alrt-title">Saldo no vinculado a una factura</div>
      <div class="alrt-sub">El abono reducirá el balance pendiente general del cliente.</div></div>
    </div>`}

    <div style="margin-bottom:12px">
      <button class="btn btn-out btn-sm" onclick="abonoSaldarTodo(${balance})">
        Usar balance completo: <span>${fmt(balance)}</span>
      </button>
    </div>

    <div class="g2">
      <div class="fg">
        <label class="lbl">Método de pago</label>
        <select class="inp" id="ab-method" onchange="abonoMethodChanged()">
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

    <div class="card" id="ab-account-wrap" style="display:none;padding:12px;margin-bottom:12px;background:var(--surface2)">
      <div class="g2">
        <div class="fg" style="margin-bottom:0">
          <label class="lbl">Cuenta que recibe el abono *</label>
          <select class="inp" id="ab-financial-account" onchange="abonoMethodChanged()">
            <option value="">— Selecciona una cuenta —</option>
            ${(DB.financialAccounts || []).filter(account =>
              account.active !== 0 && ['banco','tarjeta'].includes(account.type)
            ).map(account => `<option value="${account.id}" data-currency="${cliEsc(account.currency || 'DOP')}">
              ${cliEsc(account.name)}${account.bank_name ? ` · ${cliEsc(account.bank_name)}` : ''}${account.currency === 'USD' ? ' · USD' : ''}
            </option>`).join('')}
          </select>
        </div>
        <div class="fg" id="ab-exchange-wrap" style="display:none;margin-bottom:0">
          <label class="lbl">Tasa USD utilizada *</label>
          <input class="inp" id="ab-exchange-rate" type="number" min="20" max="500" step="0.01" placeholder="RD$ por US$"/>
        </div>
      </div>
      <div class="ts" style="margin-top:6px">El ingreso y una futura anulación quedarán conciliados en Bancos y Cuentas.</div>
    </div>

    ${contacts.length ? `<div class="fg">
      <label class="lbl">Representante que realiza el abono</label>
      <select class="inp" id="ab-contact">
        <option value="">— No especificado —</option>
        ${contacts.map(contact => `<option value="${contact.id}" ${Number(contact.id) === Number(primaryContact?.id) ? 'selected' : ''}>
          ${cliEsc(contact.name)}${contact.role ? ` · ${cliEsc(contact.role)}` : ''}${contact.is_primary ? ' · Principal' : ''}
        </option>`).join('')}
      </select>
      <div class="ts" style="margin-top:4px">Quedará registrado en el recibo y el estado de cuenta de la empresa.</div>
    </div>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" id="btn-abono"
              onclick="registrarAbono(${c.id}, ${balance}, ${Number(prefill?.replacesPaymentId) || 'null'})">
        ${svg('check')} Registrar Abono
      </button>
    </div>
  `);
  if (prefill) {
    const amountInput = document.getElementById('ab-amount');
    const methodInput = document.getElementById('ab-method');
    const noteInput = document.getElementById('ab-note');
    const contactInput = document.getElementById('ab-contact');
    const accountInput = document.getElementById('ab-financial-account');
    const exchangeInput = document.getElementById('ab-exchange-rate');
    if (amountInput) amountInput.value = Math.min(balance, Number(prefill.amount || 0)).toFixed(2);
    if (methodInput && [...methodInput.options].some(option => option.value === prefill.method)) {
      methodInput.value = prefill.method;
    }
    if (noteInput) noteInput.value = prefill.note || '';
    if (contactInput && prefill.contactId) contactInput.value = String(prefill.contactId);
    if (accountInput && prefill.financialAccountId) {
      accountInput.value = String(prefill.financialAccountId);
    }
    if (exchangeInput && Number(prefill.exchangeRate) > 1) {
      exchangeInput.value = Number(prefill.exchangeRate).toFixed(2);
    }

    document.querySelectorAll('.ab-invoice-check').forEach(check => {
      check.checked = false;
      const input = document.getElementById(`ab-alloc-${check.dataset.saleId}`);
      if (input) { input.disabled = true; input.value = ''; }
    });
    (prefill.allocations || []).forEach(row => {
      const check = document.querySelector(
        `.ab-invoice-check[data-sale-id="${Number(row.saleId)}"]`
      );
      const input = document.getElementById(`ab-alloc-${Number(row.saleId)}`);
      if (!check || !input) return;
      const pendingAmount = Number(check.dataset.pending || 0);
      check.checked = true;
      input.disabled = false;
      input.value = Math.min(pendingAmount, Number(row.amount || 0)).toFixed(2);
    });
  }
  abonoMethodChanged();
  abonoAmountChanged(balance);
}

function abonoMethodChanged() {
  const method = document.getElementById('ab-method')?.value || 'efectivo';
  const wrap = document.getElementById('ab-account-wrap');
  const account = document.getElementById('ab-financial-account');
  const exchangeWrap = document.getElementById('ab-exchange-wrap');
  const bankMethod = ['transferencia','tarjeta','cheque'].includes(method);
  if (wrap) wrap.style.display = bankMethod ? 'block' : 'none';
  if (!bankMethod || !account) {
    if (exchangeWrap) exchangeWrap.style.display = 'none';
    return;
  }
  const selected = account.options[account.selectedIndex];
  if (exchangeWrap) {
    exchangeWrap.style.display = selected?.dataset?.currency === 'USD' ? 'block' : 'none';
  }
}

function abonoAmountChanged(balance) {
  const amount = Math.max(0, Number(document.getElementById('ab-amount')?.value || 0));
  const invoices = window._abonoPendingInvoices || [];
  if (invoices.length === 1) {
    const row = invoices[0];
    const allocation = document.getElementById(`ab-alloc-${row.id}`);
    if (allocation) allocation.value = Math.min(amount, Number(row.pendiente || 0)).toFixed(2);
  }
  abonoAllocationChanged(balance);
}

function abonoToggleInvoice(saleId, pending, balance) {
  const check = document.querySelector(`.ab-invoice-check[data-sale-id="${saleId}"]`);
  const input = document.getElementById(`ab-alloc-${saleId}`);
  if (!check || !input) return;
  input.disabled = !check.checked;
  if (!check.checked) {
    input.value = '';
  } else {
    const total = Number(document.getElementById('ab-amount')?.value || 0);
    const already = [...document.querySelectorAll('.ab-allocation-amount')]
      .filter(el => el !== input && !el.disabled)
      .reduce((sum, el) => sum + Number(el.value || 0), 0);
    input.value = Math.min(Number(pending || 0), Math.max(0, total - already)).toFixed(2);
  }
  abonoAllocationChanged(balance);
}

function abonoAutoDistribuir(balance) {
  let remaining = Math.max(0, Number(document.getElementById('ab-amount')?.value || 0));
  document.querySelectorAll('.ab-invoice-check').forEach(check => {
    const pending = Number(check.dataset.pending || 0);
    const saleId = check.dataset.saleId;
    const applied = Math.min(pending, remaining);
    check.checked = applied > 0;
    const input = document.getElementById(`ab-alloc-${saleId}`);
    if (input) {
      input.disabled = applied <= 0;
      input.value = applied > 0 ? applied.toFixed(2) : '';
    }
    remaining = Math.max(0, remaining - applied);
  });
  abonoAllocationChanged(balance);
}

function abonoLimpiarDistribucion(balance) {
  document.querySelectorAll('.ab-invoice-check').forEach(check => { check.checked = false; });
  document.querySelectorAll('.ab-allocation-amount').forEach(input => {
    input.value = '';
    input.disabled = true;
  });
  abonoAllocationChanged(balance);
}

function abonoSaldarTodo(balance) {
  const input = document.getElementById('ab-amount');
  if (input) input.value = Number(balance || 0).toFixed(2);
  abonoAutoDistribuir(balance);
}

function abonoAllocationChanged(balance) {
  const amt   = parseFloat(document.getElementById('ab-amount')?.value) || 0;
  const resto = balance - amt;
  const el    = document.getElementById('ab-resto');
  if (el) {
    el.textContent = resto <= 0
      ? '✓ La deuda total del cliente quedará saldada'
      : `Balance total restante del cliente: ${fmt(Math.max(0, resto))}`;
    el.style.color = resto <= 0 ? 'var(--green)' : 'var(--muted)';
  }
  const allocated = [...document.querySelectorAll('.ab-allocation-amount')]
    .filter(input => !input.disabled)
    .reduce((sum, input) => sum + Number(input.value || 0), 0);
  const remaining = Math.round((amt - allocated) * 100) / 100;
  const historicalMax = Number(window._abonoUnallocatedBalance || 0);
  const summary = document.getElementById('ab-allocation-summary');
  if (summary) {
    const selected = document.querySelectorAll('.ab-invoice-check:checked').length;
    const historicalApplied = Math.max(0, remaining);
    const valid = Math.abs(remaining) <= 0.01 ||
      (remaining > 0 && historicalApplied <= historicalMax + 0.01);
    summary.className = `alrt ${valid ? 'g' : remaining < 0 ? 'r' : 'a'}`;
    summary.innerHTML = `<div>
      <strong>${selected} factura${selected === 1 ? '' : 's'} seleccionada${selected === 1 ? '' : 's'}</strong> ·
      Distribuido ${fmt(allocated)} ·
      ${Math.abs(remaining) <= 0.01
        ? '<span style="color:var(--green)">Monto completado</span>'
        : remaining > 0
          ? `Falta distribuir ${fmt(remaining)}${historicalApplied <= historicalMax + 0.01 ? ' (irá al saldo no vinculado)' : ''}`
          : `Exceso distribuido ${fmt(Math.abs(remaining))}`}
    </div>`;
    summary.dataset.valid = valid ? '1' : '0';
  }
}

async function registrarAbono(clientId, balanceActual, replacesPaymentId = null) {
  const amount = parseFloat(document.getElementById('ab-amount')?.value);
  const method = document.getElementById('ab-method')?.value  || 'efectivo';
  const note   = document.getElementById('ab-note')?.value?.trim() || '';
  const financialAccountId = Number(document.getElementById('ab-financial-account')?.value) || null;
  const selectedAccount = (DB.financialAccounts || []).find(
    account => Number(account.id) === financialAccountId
  );
  const exchangeRate = selectedAccount?.currency === 'USD'
    ? Number(document.getElementById('ab-exchange-rate')?.value || 0) : 1;
  const contactId = Number(document.getElementById('ab-contact')?.value) || null;
  const allocations = [...document.querySelectorAll('.ab-invoice-check:checked')]
    .map(check => ({
      saleId: Number(check.dataset.saleId),
      amount: Number(document.getElementById(`ab-alloc-${check.dataset.saleId}`)?.value || 0),
    }))
    .filter(row => row.saleId && row.amount > 0);

  if (!amount || amount <= 0) {
    toast('Ingresa un monto válido', 'err'); return;
  }
  if (amount > balanceActual + 0.01) {
    toast(`El abono no puede ser mayor al balance (${fmt(balanceActual)})`, 'err'); return;
  }
  if (document.getElementById('ab-allocation-summary')?.dataset.valid !== '1') {
    toast('Distribuye el monto completo entre las facturas seleccionadas', 'w'); return;
  }
  if (['transferencia','tarjeta','cheque'].includes(method) && !financialAccountId) {
    toast('Selecciona la cuenta que recibe el abono', 'w'); return;
  }
  if (selectedAccount?.currency === 'USD' && (exchangeRate < 20 || exchangeRate > 500)) {
    toast('Indica una tasa USD válida', 'w'); return;
  }

  const btn = document.getElementById('btn-abono');
  if (btn) { btn.disabled = true; btn.textContent = 'Procesando...'; }

  const result = await window.api.customers.addPayment({
    data: {
      customerId: clientId, amount, method, note, contactId, allocations,
      financialAccountId, exchangeRate, paymentReference: note,
      replacesPaymentId: Number(replacesPaymentId) || null,
    },
    requestUserId: user.id,
  });

  if (!result.ok) {
    toast(result.error || 'Error al registrar abono', 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = `${svg('check')} Registrar Abono`; }
    return;
  }

  await Promise.all([
    reloadCustomers(),
    typeof reloadPayments === 'function' ? reloadPayments() : Promise.resolve(),
  ]);
  closeModal();
  toast(`✓ Abono de ${fmt(amount)} registrado`);

  // Imprimir con la plantilla y la impresora global elegidas en Configuración.
  const c = DB.customers.find(c => c.id === clientId);
  printAbono({
    payment: {
      id:             result.paymentId || 0,
      document_kind:  result.document_kind || 'abono',
      document_number: result.document_number,
      document_number_fmt: result.document_number_fmt || '',
      numero_recibo:  result.numero_recibo,
      amount,
      method,
      note:           note || 'Abono',
      balance_before: balanceActual,
      balance_after:  result.after,
      sale_id:        result.saleId || null,
      allocations:    result.allocations || allocations,
      applied_invoice: result.saleId ? facturaLabel({
        id: result.saleId,
        document_number_fmt: result.sale_document_number_fmt,
        numero_factura: result.sale_numero_factura,
        numero_factura_fmt: result.sale_numero_factura_fmt,
      }) : '',
      created_at:     new Date().toISOString(),
      customer_contact_id: result.customer_contact_id || null,
      customer_contact_name: result.customer_contact_name || '',
      customer_contact_document: result.customer_contact_document || '',
      customer_contact_role: result.customer_contact_role || '',
      replaces_payment_id: result.replaces_payment_id || null,
      replaces_payment_document_number_fmt:
        result.replaces_payment_document_number_fmt || '',
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

// Guardar un recibo de abono como PDF (bajo demanda, desde el historial).
function guardarAbonoPDF(paymentId) {
  const ctx = window._cliAbonoData;
  const p = (ctx && (ctx.pagos || []).find(x => x.id === paymentId))
    || (DB.payments || []).find(x => Number(x.id) === Number(paymentId));
  if (!p) { toast('Abono no encontrado', 'err'); return; }
  const c = (ctx && ctx.customer)
    || (DB.customers || []).find(x => Number(x.id) === Number(p.customer_id))
    || { name: p.customer_name || '', rnc: p.customer_rnc || '', phone: p.customer_phone || '' };
  const build = () => printAbono({
    payment: {
      id: p.id, document_kind: p.document_kind || 'abono',
      document_number: p.document_number, document_number_fmt: p.document_number_fmt || '',
      numero_recibo: p.numero_recibo,
      amount: p.amount, method: p.method, note: p.note || 'Abono',
      balance_before: p.balance_before, balance_after: p.balance_after, created_at: p.created_at,
      status: p.status || 'active', void_reason: p.void_reason || '',
      voided_at: p.voided_at || '', voided_by_name: p.voided_by_name || '',
      sale_id: p.sale_id || null,
      sale_document_number_fmt: p.sale_document_number_fmt || '',
      sale_numero_factura: p.sale_numero_factura,
      sale_numero_factura_fmt: p.sale_numero_factura_fmt || '',
      allocations: paymentAllocationsOf(p),
      applied_invoice: p.sale_id ? facturaLabel({
        id: p.sale_id,
        document_number_fmt: p.sale_document_number_fmt,
        numero_factura: p.sale_numero_factura,
        numero_factura_fmt: p.sale_numero_factura_fmt,
      }) : '',
      customer_contact_id: p.customer_contact_id || null,
      customer_contact_name: p.customer_contact_name || '',
      customer_contact_document: p.customer_contact_document || '',
      customer_contact_role: p.customer_contact_role || '',
    },
    customer: { name: c.name || '', rnc: c.rnc || '' },
    cajero: (window._currentUser && window._currentUser.name) || '',
  });
  if (typeof guardarDocumentoPDF === 'function') {
    const docNo = typeof reciboLabel === 'function' ? reciboLabel(p) : String(p.id).padStart(5, '0');
    guardarDocumentoPDF(build, clientDocumentFilename(c, docNo, 'Abono'));
  } else { build(); }
}

function reimprimirAbono(paymentId) {
  const p = (DB.payments || []).find(x => Number(x.id) === Number(paymentId))
    || window._cliAbonoData?.pagos?.find(x => Number(x.id) === Number(paymentId));
  if (!p) { toast('Abono no encontrado', 'err'); return; }
  const c = (DB.customers || []).find(x => Number(x.id) === Number(p.customer_id))
    || window._cliAbonoData?.customer
    || { name: p.customer_name || '', rnc: p.customer_rnc || '', phone: p.customer_phone || '' };
  printAbono({ payment: p, customer: c, cajero: p.cajero || user?.name || '', isReprint: true });
}

function openAbonoDetalleModal(paymentOrId) {
  const p = typeof paymentOrId === 'object'
    ? paymentOrId
    : (DB.payments || []).find(x => Number(x.id) === Number(paymentOrId));
  if (!p) { toast('Abono no encontrado', 'err'); return; }
  const c = (DB.customers || []).find(x => Number(x.id) === Number(p.customer_id))
    || { name: p.customer_name || 'Cliente', rnc: p.customer_rnc || '', phone: p.customer_phone || '' };
  const cancelled = String(p.status || 'active').toLowerCase() === 'cancelled';
  const imported = isImportedRecord(p);
  const canCancel = !cancelled && !imported
    && ['admin','superadmin'].includes(user?.role)
    && typeof openAnularAbonoModal === 'function';
  const allocations = paymentAllocationsOf(p);
  const allocationRows = allocations.length
    ? allocations.map(row => `<div class="tr" style="padding:7px 0;border-top:1px solid var(--line)">
        <span><strong>${cliEsc(paymentAllocationLabel(row))}</strong>${row.ncf ? `<span class="ts" style="display:block">NCF ${cliEsc(row.ncf)}</span>` : ''}</span>
        <span style="text-align:right"><strong>${fmt(row.amount)}</strong>${row.invoice_balance_after != null ? `<span class="ts" style="display:block">Queda ${fmt(row.invoice_balance_after)}</span>` : ''}</span>
      </div>`).join('')
    : `<div class="ts">Aplicado al ${imported ? 'saldo importado' : 'saldo no vinculado a una factura'}.</div>`;
  const replacement = (DB.payments || []).find(
    row => Number(row.replaces_payment_id) === Number(p.id)
      && String(row.status || 'active').toLowerCase() !== 'cancelled'
  );
  const replaces = p.replaces_payment_id
    ? (DB.payments || []).find(row => Number(row.id) === Number(p.replaces_payment_id))
    : null;
  openModal(`
    <div class="modal-title">Abono ${cliEsc(reciboLabel(p))}</div>
    <div class="modal-sub">${cliEsc(c.name || '')} · ${fdate(String(p.created_at || '').slice(0,10))}</div>
    ${cancelled ? `
      <div style="margin-top:12px;padding:11px 13px;border:1px solid #fecaca;background:#fff7f7;border-radius:10px">
        <div style="font-weight:800;color:var(--red)">Abono anulado</div>
        <div class="ts" style="margin-top:3px">
          ${cliEsc(p.void_reason || 'Sin motivo registrado')}
          ${p.voided_by_name ? ` · Por ${cliEsc(p.voided_by_name)}` : ''}
          ${p.voided_at ? ` · ${cliEsc(fdate(String(p.voided_at).slice(0,10)))}` : ''}
        </div>
      </div>` : ''}
    ${replacement ? `<div class="alrt g" style="margin-top:10px">
      <div class="alrt-dot g"></div><div>
        <div class="alrt-title">Corregido mediante ${cliEsc(reciboLabel(replacement))}</div>
        <div class="alrt-sub">El nuevo recibo conserva el vínculo con este abono anulado.</div>
      </div>
    </div>` : replaces ? `<div class="alrt b" style="margin-top:10px">
      <div class="alrt-dot b"></div><div>
        <div class="alrt-title">Reemplaza a ${cliEsc(reciboLabel(replaces))}</div>
        <div class="alrt-sub">Este es el recibo corregido vigente.</div>
      </div>
    </div>` : ''}
    <div class="card" style="background:var(--surface2);margin-top:14px">
      <div class="g2">
        <div><div class="ts">Monto abonado</div><div style="font-size:22px;font-weight:800;color:var(--green)">${fmt(p.amount)}</div></div>
        <div><div class="ts">Aplicación</div><div style="font-size:15px;font-weight:700">${cliEsc(paymentInvoiceSummary(p))}</div></div>
        <div><div class="ts">Método</div><div style="font-weight:700;text-transform:capitalize">${cliEsc(p.method || 'efectivo')}</div></div>
        <div><div class="ts">Balance del cliente después</div><div style="font-weight:700">${fmt(p.balance_after)}</div></div>
      </div>
      ${p.note ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
        <div class="ts">Nota</div><div style="font-size:12px">${cliEsc(p.note)}</div>
      </div>` : ''}
      <div style="margin-top:12px">
        <div class="ts" style="font-weight:800;margin-bottom:3px">Facturas abonadas</div>
        ${allocationRows}
      </div>
    </div>
    <div class="modal-foot" style="flex-wrap:wrap">
      <button class="btn btn-out" onclick="closeModal()">Cerrar</button>
      <button class="btn btn-out" onclick="reimprimirAbono(${p.id})">${svg('print')} Reimprimir</button>
      <button class="btn btn-out" onclick="guardarAbonoPDF(${p.id})">${svg('pdf')} Guardar PDF</button>
      ${!cancelled ? `<button class="btn btn-green" onclick="abonoWhatsApp(${p.id})">WhatsApp</button>` : ''}
      ${canCancel ? `<button class="btn btn-red" onclick="closeModal();setTimeout(()=>openAnularAbonoModal(${p.id}),80)">
        ${svg('x')} Anular abono
      </button>` : ''}
    </div>
  `);
}

function abonoWhatsApp(paymentId) {
  const p = (DB.payments || []).find(x => Number(x.id) === Number(paymentId));
  if (!p) return;
  if (String(p.status || 'active').toLowerCase() === 'cancelled') {
    toast('Un abono anulado no puede enviarse como comprobante vigente', 'w');
    return;
  }
  const c = (DB.customers || []).find(x => Number(x.id) === Number(p.customer_id))
    || { name: p.customer_name || 'Cliente', phone: p.customer_phone || '' };
  const allocations = paymentAllocationsOf(p);
  const applied = allocations.length
    ? allocations.map(row => `${paymentAllocationLabel(row)}: ${fmt(row.amount)}`).join('\n')
    : (isImportedRecord(p) ? 'Saldo importado' : 'Saldo no vinculado');
  openWhatsAppModal([
    `Recibo de abono ${reciboLabel(p)} · ${CFG.biz}`,
    `Cliente: ${c.name}`,
    `Monto: ${fmt(p.amount)}`,
    `Aplicado a: ${applied}`,
    `Balance restante: ${fmt(p.balance_after)}`,
  ].join('\n'), String(c.phone || '').replace(/\D/g, ''), c.name);
}

// ══════════════════════════════════════════════
// ESTADO DE CUENTA COMPLETO
// ══════════════════════════════════════════════
async function openEstadoCuentaModal(c, activeTab = 'cuenta') {
  // Guardar tab activa para re-render al cambiar
  window._cliModalTab = activeTab;
  const balance     = Number(c.balance || 0);
  const creditLimit = Number(c.credit_limit || 0);
  const creditDue   = c.credit_due || null;
  const creditDays  = Number(c.credit_days || 30);
  const disponible  = Math.max(0, creditLimit - balance);
  const usedPct     = creditLimit > 0
    ? Math.min((balance / creditLimit) * 100, 100) : 0;

  // Cargar pagos e historial desde backend (range='all' para incluir histórico)
  const pagos  = await window.api.customers.getPayments({ customerId: c.id }) || [];
  const ventasRaw = await window.api.sales.getAll({ customerId: c.id, range: 'all', limit: 9999 }) || [];
  const ventas = ventasRaw.filter(s => s.status !== 'cancelled').reverse();
  // Guardar ventas del cliente en window para que filtrarHistorialCliente las use
  window._cliModalVentas = ventas;
  // Cargar items reales de todas las ventas del cliente (para Buscar por Artículo).
  // Se hace una sola vez al abrir el modal; la búsqueda filtra en memoria.
  try {
    const itemsRes = await window.api.customers.getItemsForCustomer({ customerId: c.id });
    window._cliModalItems = (itemsRes && itemsRes.items) ? itemsRes.items : [];
  } catch { window._cliModalItems = []; }

  const totalCompras = ventas.reduce((a, s) => a + s.total, 0);
  // Los descuentos llegan como pagos con method='descuento' (migración Equiparts).
  // NO son efectivo: cierran factura sin que entre dinero. Se totalizan aparte
  // para que la caja no se infle y el gerente vea de dónde sale la diferencia
  // entre lo comprado y lo abonado.
  const esDescuento  = p => String(p.method || '').toLowerCase() === 'descuento';
  const esVigente = p => String(p.status || 'active').toLowerCase() !== 'cancelled';
  const abonosReales = pagos.filter(p => esVigente(p) && !esDescuento(p));
  const descuentos   = pagos.filter(p => esVigente(p) && esDescuento(p));
  const totalAbonado = abonosReales.reduce((a, p) => a + p.amount, 0);
  const totalDesc    = descuentos.reduce((a, p) => a + p.amount, 0);

  const ventasRows = ventas.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:var(--muted2);padding:14px;font-size:12px">
         Sin compras registradas</td></tr>`
    : ventas.map(s => {
        const fecha = (s.sale_date || s.date || '').split('T')[0].split(' ')[0];
        const tipo  = s.type === 'devolucion' ? 'Devolución' :
                      s.type === 'cotizacion' ? 'Cotización' : 'Factura';
        return `
          <tr>
            <td style="font-size:11px;color:var(--muted)">${fdate(fecha)}</td>
            <td style="font-size:12px">${facturaLabel(s)} <span style="font-size:10px;color:var(--muted)">${tipo}</span>${cliRepresentativeLine(s)}</td>
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
        // Vincular al sale_id si existe
        const facturaRef = p.sale_id
          ? `<span style="font-size:10px;color:var(--blue);cursor:pointer;margin-left:4px"
               onclick="closeModal();setTimeout(()=>{
                 const s=DB.sales.find(x=>x.id===${p.sale_id})||window._cliModalVentas?.find(x=>x.id===${p.sale_id});
                 if(s)openDetalleVentaModal(s);
               },100)">${facturaLabel(p)} ↗</span>`
          : '';
        const esDesc = String(p.method || '').toLowerCase() === 'descuento';
        const cancelled = String(p.status || 'active').toLowerCase() === 'cancelled';
        const concepto = p.note || (esDesc ? 'Descuento aplicado' : 'Abono');
        return `
          <tr${cancelled
            ? ' style="background:rgba(239,68,68,.05);opacity:.72"'
            : esDesc ? ' style="background:rgba(245,158,11,.07)"' : ''}>
            <td style="font-size:11px;color:var(--muted)">${fdate(fecha)}</td>
            <td style="font-size:12px${cancelled ? ';color:var(--red)' : esDesc ? ';color:var(--amber)' : ''}">
              ${cancelled ? '<strong>ANULADO · </strong>' : ''}${cliEsc(concepto)}${facturaRef}${cliRepresentativeLine(p, 'Pagado por')}
            </td>
            <td style="text-align:right;font-weight:700;color:${cancelled ? 'var(--muted2)' : esDesc ? 'var(--amber)' : 'var(--green)'};${cancelled ? 'text-decoration:line-through' : ''}">${esDesc ? '' : '+'}${fmt(p.amount)}</td>
            <td>
              <span class="badge ${esDesc ? 'a' : 'g'}">${p.method || 'efectivo'}</span>
              <span style="font-size:10px;color:var(--muted2);margin-left:4px">
                ${fmt(p.balance_before)} → ${fmt(p.balance_after)}
              </span>
              <button class="btn btn-ghost btn-sm" style="margin-left:4px" title="Guardar recibo en PDF"
                      onclick="guardarAbonoPDF(${p.id})">${svg('pdf')}</button>
              <button class="btn btn-ghost btn-sm" style="margin-left:2px" title="Ver y reimprimir"
                      onclick="openAbonoDetalleModal(${p.id})">${svg('eye')}</button>
            </td>
          </tr>`;
      }).join('');

  // Contexto para "Guardar PDF" de recibos de abono de este cliente.
  window._cliAbonoData = { customer: c, pagos };

  openModal(`
    <div class="modal-title">
      ${cliEsc(c.name)}
      <span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:8px">${cliEsc(c.rnc||'')} ${c.phone ? '· '+cliEsc(c.phone) : ''}</span>
    </div>
    ${c.customer_type === 'company' && (c.contacts || []).length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin:7px 0 12px">
      ${(c.contacts || []).filter(x => x.active !== 0).map(contact => `<span class="badge ${contact.is_primary ? 'b' : ''}">${cliEsc(contact.name)}${contact.role ? ` · ${cliEsc(contact.role)}` : ''}</span>`).join('')}
    </div>` : ''}

    <!-- Pestañas del cliente -->
    <div class="tabs" style="margin-bottom:14px">
      <button class="tab ${activeTab==='cuenta'?'on':''}"
              onclick="openEstadoCuentaModal(DB.customers.find(x=>x.id===${c.id}),'cuenta')">
        📊 Estado de Cuenta
      </button>
      <button class="tab ${activeTab==='facturas'?'on':''}"
              onclick="openEstadoCuentaModal(DB.customers.find(x=>x.id===${c.id}),'facturas')">
        🧾 Facturas Pendientes
      </button>
      <button class="tab ${activeTab==='historial'?'on':''}"
              onclick="openEstadoCuentaModal(DB.customers.find(x=>x.id===${c.id}),'historial')">
        🔍 Buscar por Artículo
      </button>
    </div>
    <div id="cli-modal-body">

    <!-- Métricas -->
    <div class="metrics" style="grid-template-columns:repeat(${totalDesc > 0 ? 5 : 4},1fr);margin-bottom:14px">
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
        <div style="font-size:10px;color:var(--muted2)">${abonosReales.length} abono${abonosReales.length!==1?'s':''}</div>
      </div>
      ${totalDesc > 0 ? `
      <div class="metric">
        <div class="met-label">Descuentos</div>
        <div class="met-val" style="font-size:14px;color:var(--amber)">${fmt(totalDesc)}</div>
        <div style="font-size:10px;color:var(--muted2)">${descuentos.length} aplicado${descuentos.length!==1?'s':''}</div>
      </div>` : ''}
    </div>

    ${totalDesc > 0 ? `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;
                  background:rgba(245,158,11,.07);border:1px solid var(--line);
                  border-radius:6px;padding:8px 12px;margin-bottom:14px">
        <span style="color:var(--muted)">Rebajado sin efectivo:</span>
        <span style="color:var(--amber);font-weight:700">${fmt(totalDesc)}</span>
        <span style="color:var(--muted2)">— cerró factura sin que entrara dinero, no cuenta como cobro en caja</span>
      </div>` : ''}

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

    <!-- Contenido por tab -->
    ${activeTab === 'cuenta' ? `
      <!-- Historial ventas expandible -->
      <div style="font-weight:700;font-size:12px;margin-bottom:6px">
        Facturas (${ventas.length})</div>
      <div style="max-height:200px;overflow-y:auto;margin-bottom:12px;border:1px solid var(--line);border-radius:6px">
        ${ventas.length === 0
          ? `<div style="text-align:center;padding:16px;color:var(--muted2);font-size:12px">Sin facturas registradas</div>`
          : ventas.map((s, idx) => {
              const fecha = (s.sale_date||s.date||'').split('T')[0].split(' ')[0];
              const tipo  = s.type==='devolucion'?'Devolución':s.type==='cotizacion'?'Cotización':'Factura';
              const metColor = (s.payment_method||s.pay)==='credito'?'var(--amber)':s.type==='devolucion'?'var(--red)':'var(--green)';
              return `
                <div style="border-bottom:1px solid var(--line)">
                  <div onclick="toggleVentaDetalle(${idx},${s.id},this)"
                       style="display:flex;justify-content:space-between;align-items:center;
                              padding:8px 12px;cursor:pointer;background:var(--surface2)">
                    <div>
                      <span style="font-weight:700;font-size:12px">${facturaLabel(s)}</span>
                      <span style="font-size:10px;color:var(--muted);margin-left:6px">${tipo}</span>
                      <span style="font-size:10px;color:var(--muted2);margin-left:6px">${fdate(fecha)}</span>
                      ${cliRepresentativeLine(s)}
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                      <span style="font-size:10px;font-weight:600;color:${metColor};
                                   background:${metColor}18;padding:2px 6px;border-radius:4px">
                        ${s.payment_method||s.pay||'—'}
                      </span>
                      <span style="font-weight:800;font-size:12px">${fmt(s.total)}</span>
                      <span style="color:var(--muted2);font-size:10px">▼</span>
                    </div>
                  </div>
                  <div id="vta-det-${idx}" style="display:none;padding:8px 12px;background:var(--surface)">
                    <div id="vta-det-body-${idx}" style="font-size:11px;color:var(--muted2)">
                      Cargando artículos...
                    </div>
                  </div>
                </div>`;
            }).join('')
        }
      </div>
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
    ` : activeTab === 'facturas' ? `
      <div id="cli-facturas-body">
        <div style="text-align:center;padding:20px;color:var(--muted2)">Cargando facturas...</div>
      </div>
    ` : `
      <!-- Búsqueda por artículo / modelo -->
      <div class="inp-ic" style="margin-bottom:12px">
        <div class="ic">${svg('search')}</div>
        <input class="inp" id="cli-art-search" type="text"
               placeholder="Buscar artículo o modelo en el historial de este cliente..."
               oninput="filtrarHistorialCliente(${c.id}, this.value)"/>
      </div>
      <div id="cli-art-results">
        <div style="text-align:center;padding:20px;color:var(--muted2);font-size:12px">
          Escribe para buscar artículos comprados por este cliente
        </div>
      </div>
    `}
    </div><!-- /cli-modal-body -->

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

  // Si tab es facturas → cargar facturas pendientes async
  if (activeTab === 'facturas') {
    window.api.customers.getFacturasPendientes({ customerId: c.id }).then(res => {
      const body = document.getElementById('cli-facturas-body');
      if (!body) return;
      if (!res?.ok) {
        body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--red)">
          <div style="font-size:24px;margin-bottom:8px">⚠️</div>
          <div>No se pudieron cargar las facturas pendientes</div>
          <div style="font-size:11px;margin-top:4px;color:var(--muted2)">${esc(res?.error || 'Error desconocido')}</div>
        </div>`;
        return;
      }
      const facturas = res?.facturas || [];
      const saldoSinFactura = Number(res?.unallocatedBalance || 0);
      if (!facturas.length) {
        body.innerHTML = saldoSinFactura > 0.005
          ? `<div style="text-align:center;padding:24px;color:var(--amber)">
              <div style="font-size:24px;margin-bottom:8px">⚠️</div>
              <div style="font-weight:700">Saldo pendiente sin factura asociada</div>
              <div style="font-size:12px;margin-top:5px;color:var(--muted2)">${fmt(saldoSinFactura)}</div>
            </div>`
          : `<div style="text-align:center;padding:24px;color:var(--muted2)">
              <div style="font-size:24px;margin-bottom:8px">✅</div>
              <div>Sin facturas a crédito pendientes</div></div>`;
        return;
      }
      const saldoSinFacturaAviso = saldoSinFactura > 0.005
        ? `<div style="padding:10px 12px;margin-bottom:10px;border:1px solid var(--amber);border-radius:8px;color:var(--amber);font-size:12px">
            ⚠ Además hay ${fmt(saldoSinFactura)} de saldo inicial sin factura asociada.
          </div>`
        : '';
      body.innerHTML = saldoSinFacturaAviso + facturas.map((f, idx) => {
        const fecha = (f.created_at||'').split('T')[0].split(' ')[0];
        const diasD = Math.floor((Date.now()-new Date(fecha).getTime())/86400000);
        const ref   = facturaLabel(f, f.notes?.match(/import_ref:([^\s|]+)/)?.[1]);
        return `<div style="border:1px solid var(--line);border-radius:8px;margin-bottom:8px;overflow:hidden">
          <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;
                      cursor:pointer;background:var(--surface2)" onclick="toggleFacturaDetalle(${idx},${f.id},this)">
            <div>
              <span style="font-weight:700">${ref}</span>
              <span style="font-size:11px;color:var(--muted);margin-left:8px">${fdate(fecha)}</span>
              <span class="badge ${diasD>30?'r':'a'}" style="margin-left:6px">${diasD}d</span>
              ${cliRepresentativeLine(f)}
            </div>
            <div style="text-align:right">
              <div style="font-weight:800;color:var(--red)">${fmt(f.pendiente)}</div>
              <div style="font-size:10px;color:var(--muted2)">de ${fmt(f.total)}</div>
            </div>
          </div>
          <div id="fac-detail-${idx}" style="display:none">
            <div id="fac-detail-body-${idx}" style="padding:12px 14px;background:var(--surface)">
              <div style="color:var(--muted2);font-size:12px">Cargando artículos...</div>
            </div>
          </div>
        </div>`;
      }).join('');
    });
  }
}

// ══════════════════════════════════════════════
// EXPORTAR ESTADO DE CUENTA — PDF
// ══════════════════════════════════════════════
async function exportClientCreditPDF(c) {
  if (!c) { toast('Cliente no encontrado', 'err'); return; }

  const balance     = Number(c.balance || 0);
  const creditLimit = Number(c.credit_limit || 0);
  const creditDays  = Number(c.credit_days || 30);
  const creditDue   = c.credit_due || null;
  const disponible  = Math.max(0, creditLimit - balance);
  const usedPct     = creditLimit > 0 ? Math.min((balance / creditLimit) * 100, 100) : 0;

  const pagos  = await window.api.customers.getPayments({ customerId: c.id }) || [];
  const ventasRaw = await window.api.sales.getAll({ customerId: c.id, range: 'all', limit: 9999 }) || [];
  const ventas = ventasRaw.filter(s => s.status !== 'cancelled').reverse();

  const totalCompras = ventas.reduce((a, s) => a + s.total, 0);
  // Descuentos aparte del efectivo — ver nota en openEstadoCuentaModal.
  const esDescuento  = p => String(p.method || '').toLowerCase() === 'descuento';
  const esVigente = p => String(p.status || 'active').toLowerCase() !== 'cancelled';
  const abonosReales = pagos.filter(p => esVigente(p) && !esDescuento(p));
  const descuentos   = pagos.filter(p => esVigente(p) && esDescuento(p));
  const totalAbonado = abonosReales.reduce((a, p) => a + p.amount, 0);
  const totalDesc    = descuentos.reduce((a, p) => a + p.amount, 0);

  const _e = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const ventasRows = ventas.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:12px">Sin compras registradas</td></tr>`
    : ventas.map(s => {
        const fecha = (s.sale_date || s.date || '').split('T')[0].split(' ')[0];
        const tipo  = s.type === 'devolucion' ? 'Devolución' :
                      s.type === 'cotizacion' ? 'Cotización' : 'Factura';
        const estado = s.status === 'returned' ? 'Devuelta' :
                       s.status === 'cancelled' ? 'Anulada' : 'OK';
        const metodoBadge = (s.payment_method || s.pay || '—');
        return `<tr>
          <td>${fdate(fecha)}</td>
          <td>${facturaLabel(s)} <span style="color:#9ca3af;font-size:10px">${tipo}</span>
            ${s.customer_contact_name ? `<div style="color:#2563eb;font-size:9px;margin-top:2px">Solicitado por: <strong>${_e(s.customer_contact_name)}</strong>${s.customer_contact_role ? ` · ${_e(s.customer_contact_role)}` : ''}</div>` : ''}
          </td>
          <td style="text-align:right;font-weight:700">${fmt(s.total)}</td>
          <td>${_e(metodoBadge)}</td>
          <td><span style="color:${s.status==='returned'||s.status==='cancelled'?'#dc2626':'#16a34a'};font-weight:600">${estado}</span></td>
        </tr>`;
      }).join('');

  const pagosRows = pagos.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:12px">Sin abonos registrados</td></tr>`
    : [...pagos].reverse().map(p => {
        const fecha  = (p.created_at || '').split('T')[0].split(' ')[0];
        const esDesc = esDescuento(p);
        const cancelled = !esVigente(p);
        return `<tr${cancelled ? ' style="background:#fef2f2;color:#9ca3af"' : esDesc ? ' style="background:#fffbeb"' : ''}>
          <td>${fdate(fecha)}</td>
          <td${cancelled ? ' style="color:#dc2626"' : esDesc ? ' style="color:#b45309"' : ''}>${cancelled ? '<strong>ANULADO · </strong>' : ''}${_e(p.note || (esDesc ? 'Descuento aplicado' : 'Abono'))}
            ${p.customer_contact_name ? `<div style="color:#2563eb;font-size:9px;margin-top:2px">Pagado por: <strong>${_e(p.customer_contact_name)}</strong>${p.customer_contact_role ? ` · ${_e(p.customer_contact_role)}` : ''}</div>` : ''}
          </td>
          <td style="text-align:right;font-weight:700;color:${cancelled ? '#9ca3af' : esDesc ? '#b45309' : '#16a34a'};${cancelled ? 'text-decoration:line-through' : ''}">${esDesc ? '' : '+'}${fmt(p.amount)}</td>
          <td>${_e(p.method || 'efectivo')} <span style="color:#9ca3af;font-size:10px">${fmt(p.balance_before)} → ${fmt(p.balance_after)}</span></td>
        </tr>`;
      }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Estado de Cuenta: ${_e(c.name)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:24px;max-width:800px;margin:0 auto}
  h2{font-size:17px;margin-bottom:2px}
  .sub{color:#6b7280;font-size:11px;margin-bottom:18px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .met{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px}
  .met-l{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;margin-bottom:4px}
  .met-v{font-size:16px;font-weight:800}
  .met-s{font-size:10px;color:#9ca3af;margin-top:2px}
  .prog{background:#e5e7eb;border-radius:4px;height:6px;margin-top:6px}
  .prog-f{height:6px;border-radius:4px}
  h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
     color:#6b7280;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin:16px 0 8px}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left;font-size:10px;
     text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
  td{padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:11px}
  .foot{margin-top:24px;border-top:1px solid #e5e7eb;padding-top:10px;
        font-size:10px;color:#9ca3af;display:flex;justify-content:space-between}
  .no-print{text-align:right;margin-bottom:16px}
  @media print{.no-print{display:none}}
</style>
</head><body>
  <div class="no-print" style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:16px">
    <button onclick="window.print()"
      style="background:#0D0F12;color:#fff;border:none;padding:8px 18px;
             border-radius:6px;font-size:12px;cursor:pointer;font-weight:700">
      🖨️ Imprimir / Guardar PDF
    </button>
    <button onclick="window.close()"
      style="background:transparent;color:#6b7280;border:1px solid #e5e7eb;padding:8px 18px;
             border-radius:6px;font-size:12px;cursor:pointer">
      Cerrar
    </button>
  </div>

  <h2>Estado de Cuenta: ${_e(c.name)}</h2>
  <div class="sub">
    RNC: ${_e(c.rnc || 'Sin RNC')} ·
    Tel: ${_e(c.phone || 'Sin teléfono')} ·
    Generado: ${fdate(today())} a las ${nowt()} ·
    ${_e(CFG.biz || '')}
  </div>

  <div class="metrics"${totalDesc > 0 ? ' style="grid-template-columns:repeat(5,1fr)"' : ''}>
    <div class="met" style="border-color:${balance>0?'#fecaca':'#bbf7d0'};background:${balance>0?'#fef2f2':'#f0fdf4'}">
      <div class="met-l">Balance Pendiente</div>
      <div class="met-v" style="color:${balance>0?'#dc2626':'#16a34a'}">${fmt(balance)}</div>
    </div>
    <div class="met">
      <div class="met-l">Límite / Disponible</div>
      <div class="met-v">${fmt(creditLimit)}</div>
      <div class="met-s" style="color:${disponible<creditLimit*0.1?'#dc2626':'#16a34a'}">Disp: ${fmt(disponible)}</div>
      ${creditLimit>0?`<div class="prog"><div class="prog-f" style="width:${usedPct}%;background:${usedPct>90?'#dc2626':usedPct>60?'#f59e0b':'#16a34a'}"></div></div>`:''}
    </div>
    <div class="met">
      <div class="met-l">Total Comprado</div>
      <div class="met-v">${fmt(totalCompras)}</div>
      <div class="met-s">${ventas.length} factura${ventas.length!==1?'s':''}</div>
    </div>
    <div class="met">
      <div class="met-l">Total Abonado</div>
      <div class="met-v" style="color:#16a34a">${fmt(totalAbonado)}</div>
      <div class="met-s">${abonosReales.length} abono${abonosReales.length!==1?'s':''}</div>
    </div>
    ${totalDesc > 0 ? `
    <div class="met" style="border-color:#fde68a;background:#fffbeb">
      <div class="met-l">Descuentos</div>
      <div class="met-v" style="color:#b45309">${fmt(totalDesc)}</div>
      <div class="met-s">${descuentos.length} aplicado${descuentos.length!==1?'s':''}</div>
    </div>` : ''}
  </div>

  ${totalDesc > 0 ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;
       padding:8px 12px;margin-bottom:16px;font-size:10px;color:#92400e">
    Rebajado sin efectivo: <strong>${fmt(totalDesc)}</strong> — cerró factura sin que entrara dinero.
    No cuenta como cobro en caja.
  </div>` : ''}

  ${creditLimit>0?`<div style="font-size:10px;color:#6b7280;margin-bottom:16px">
    Crédito utilizado: ${usedPct.toFixed(0)}% ·
    Plazo: ${creditDays}d ·
    Vence: ${creditDue ? fdate(creditDue) : '—'}
  </div>`:''}

  <h3>Historial de Compras (${ventas.length})</h3>
  <table>
    <thead><tr>
      <th>Fecha</th><th>Factura</th>
      <th style="text-align:right">Total</th>
      <th>Método</th><th>Estado</th>
    </tr></thead>
    <tbody>${ventasRows}</tbody>
  </table>

  <h3>Historial de Abonos (${pagos.length})</h3>
  <table>
    <thead><tr>
      <th>Fecha</th><th>Concepto</th>
      <th style="text-align:right">Monto</th><th>Método / Balance</th>
    </tr></thead>
    <tbody>${pagosRows}</tbody>
  </table>

  <div class="foot">
    <span>${_e(CFG.biz || '')} · ${_e(CFG.rnc || '')}</span>
    <span>Generado: ${fdate(today())} ${nowt()}</span>
  </div>
</body></html>`;

  printHTML(html, 'reporte');
}

// ══════════════════════════════════════════════
// BUSCAR ARTÍCULO/MODELO EN HISTORIAL DE CLIENTE
// ══════════════════════════════════════════════
function filtrarHistorialCliente(customerId, q) {
  const results = document.getElementById('cli-art-results');
  if (!results) return;
  q = (q || '').toLowerCase().trim();

  if (!q) {
    results.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted2);font-size:12px">
      Escribe para buscar artículos comprados por este cliente</div>`;
    return;
  }

  // Usar los items reales cargados del backend (una fila por artículo vendido).
  const items = window._cliModalItems || [];

  // Buscar en cada item por nombre, código o modelo (Unicode-safe)
  const qn = q.normalize('NFC');
  const matches = [];
  items.forEach(it => {
    const prod   = DB.products.find(p => p.id === it.product_id);
    const nombre = (it.product_name || '').toLowerCase().normalize('NFC');
    const codigo = (it.product_code || prod?.code || '').toLowerCase().normalize('NFC');
    const modelo = (prod?.model || '').toLowerCase().normalize('NFC');

    if (nombre.includes(qn) || codigo.includes(qn) || modelo.includes(qn)) {
      const fecha = (it.created_at || '').split('T')[0].split(' ')[0];
      matches.push({
        saleId:   it.sale_id,
        fecha,
        item:     { product_name: it.product_name, product_code: it.product_code,
                    qty: it.qty, unit_price: it.unit_price },
        prod,
        total:    it.sale_total,
        method:   it.payment_method || '—',
        numFact:  it.numero_factura_fmt || (it.numero_factura != null ? String(it.numero_factura).padStart(8,'0') : ''),
        ncf:      it.ncf || '',
      });
    }
  });

  if (!matches.length) {
    results.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted2)">
      No se encontraron artículos con "${q}"</div>`;
    return;
  }

  results.innerHTML = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
      ${matches.length} resultado${matches.length!==1?'s':''} para "${q}"
    </div>
    <div class="tw" style="max-height:320px;overflow-y:auto">
      <table>
        <thead><tr>
          <th>Fecha</th><th>Artículo</th><th>Modelo</th>
          <th style="text-align:center">Cant.</th>
          <th style="text-align:right">Precio</th>
          <th># Factura</th>
        </tr></thead>
        <tbody>
          ${matches.map(m => `
            <tr style="cursor:pointer" onclick="closeModal();setTimeout(()=>openDetalleVentaModal(DB.sales.find(s=>s.id===${m.saleId})),100)">
              <td style="font-size:11px;white-space:nowrap">${fdate(m.fecha)}</td>
              <td>
                <div style="font-weight:500;font-size:12px">${m.item.product_name||m.item.name||'—'}</div>
                <div style="font-size:10px;color:var(--muted2)">${m.item.product_code||m.prod?.code||''}</div>
              </td>
              <td>
                ${m.prod?.model
                  ? `<span style="font-size:11px;font-weight:600;color:var(--blue);
                                 background:var(--blue-bg,#eff6ff);padding:2px 8px;
                                 border-radius:20px">${m.prod.model}</span>`
                  : '<span style="color:var(--muted2);font-size:11px">—</span>'}
              </td>
              <td style="text-align:center;font-size:12px">${m.item.qty||1}</td>
              <td style="text-align:right;font-size:12px">${fmt(m.item.unit_price||m.item.price||0)}</td>
              <td style="font-size:11px;color:var(--muted)">${facturaLabel(m)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ══════════════════════════════════════════════
// TOGGLE DETALLE DE FACTURA (expandir artículos)
// Llamado desde la pestaña Facturas del modal
// ══════════════════════════════════════════════
async function toggleVentaDetalle(idx, saleId, rowEl) {
  const detailDiv  = document.getElementById(`vta-det-${idx}`);
  const detailBody = document.getElementById(`vta-det-body-${idx}`);
  if (!detailDiv) return;

  const isOpen = detailDiv.style.display !== 'none';
  // Rotar indicador ▼/▲
  const arrow = rowEl.querySelector('span:last-child');
  if (isOpen) {
    detailDiv.style.display = 'none';
    if (arrow) arrow.textContent = '▼';
    return;
  }

  detailDiv.style.display = '';
  if (arrow) arrow.textContent = '▲';
  if (detailBody.dataset.loaded === 'true') return;

  const res   = await window.api.customers.getSaleItems({ saleId });
  const items = res?.items || [];

  if (!items.length) {
    detailBody.innerHTML = `<div style="color:var(--muted2);font-size:11px;padding:6px">
      Sin detalle de artículos registrado.</div>`;
  } else {
    const total = items.reduce((s, i) => s + i.subtotal, 0);
    detailBody.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="border-bottom:1px solid var(--line)">
          <th style="padding:4px 8px;text-align:left;color:var(--muted)">Código</th>
          <th style="padding:4px 8px;text-align:left;color:var(--muted)">Artículo</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted)">Cant.</th>
          <th style="padding:4px 8px;text-align:right;color:var(--muted)">P. Unit.</th>
          <th style="padding:4px 8px;text-align:right;color:var(--muted)">Subtotal</th>
        </tr></thead>
        <tbody>
          ${items.map((it, i) => `
            <tr style="background:${i%2===0?'transparent':'var(--surface)'}">
              <td style="padding:4px 8px;font-family:monospace;font-size:10px;color:var(--muted)">${it.product_code || '—'}</td>
              <td style="padding:4px 8px;font-weight:500">${it.product_name}</td>
              <td style="padding:4px 8px;text-align:center;color:var(--muted2)">${it.qty}</td>
              <td style="padding:4px 8px;text-align:right">${fmt(it.unit_price)}</td>
              <td style="padding:4px 8px;text-align:right;font-weight:700">${fmt(it.subtotal)}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr style="border-top:1px solid var(--line)">
          <td colspan="4" style="padding:4px 8px;text-align:right;font-size:10px;color:var(--muted)">Total:</td>
          <td style="padding:4px 8px;text-align:right;font-weight:800">${fmt(total)}</td>
        </tr></tfoot>
      </table>`;
  }
  detailBody.dataset.loaded = 'true';
}

async function toggleFacturaDetalle(idx, saleId, rowEl) {
  const detailRow  = document.getElementById(`fac-detail-${idx}`);
  const detailBody = document.getElementById(`fac-detail-body-${idx}`);
  if (!detailRow) return;

  const isOpen = detailRow.style.display !== 'none';
  if (isOpen) { detailRow.style.display = 'none'; return; }

  detailRow.style.display = '';
  if (detailBody.dataset.loaded === 'true') return;

  const res   = await window.api.customers.getSaleItems({ saleId });
  const items = res?.items || [];

  if (!items.length) {
    detailBody.innerHTML = `<div style="color:var(--muted2);font-size:12px;padding:8px">
      Sin detalle de artículos registrado.</div>`;
  } else {
    const total = items.reduce((s, i) => s + i.subtotal, 0);
    detailBody.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--line)">
          <th style="padding:5px 8px;text-align:left;color:var(--muted)">Código</th>
          <th style="padding:5px 8px;text-align:left;color:var(--muted)">Artículo</th>
          <th style="padding:5px 8px;text-align:center;color:var(--muted)">Cant.</th>
          <th style="padding:5px 8px;text-align:right;color:var(--muted)">Precio Unit.</th>
          <th style="padding:5px 8px;text-align:right;color:var(--muted)">Subtotal</th>
        </tr></thead>
        <tbody>
          ${items.map((it, i) => `
            <tr style="background:${i%2===0?'transparent':'var(--surface)'}">
              <td style="padding:5px 8px;font-family:monospace;font-size:11px;color:var(--muted)">${it.product_code || '—'}</td>
              <td style="padding:5px 8px;font-weight:500">${it.product_name}</td>
              <td style="padding:5px 8px;text-align:center;color:var(--muted2)">${it.qty}</td>
              <td style="padding:5px 8px;text-align:right">${fmt(it.unit_price)}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:700">${fmt(it.subtotal)}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr style="border-top:1px solid var(--line)">
          <td colspan="4" style="padding:5px 8px;text-align:right;font-size:11px;color:var(--muted)">Total artículos:</td>
          <td style="padding:5px 8px;text-align:right;font-weight:800;color:var(--red)">${fmt(total)}</td>
        </tr></tfoot>
      </table>`;
  }
  detailBody.dataset.loaded = 'true';
}
