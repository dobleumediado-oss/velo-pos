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
    matchDigits(c.phone, qDigits)
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
        <div style="display:flex;gap:6px">
          <input class="inp" id="cf-rnc" type="text" placeholder="RNC 9 díg. · Cédula 11 díg."
                 value="${isEdit ? (c.rnc || '') : ''}" oninput="onRncInput()" style="flex:1;min-width:0"/>
          <button class="btn btn-out" type="button" onclick="verificarRncDGII()"
                  title="Verificar en la DGII (requiere internet)" style="flex-shrink:0">DGII</button>
        </div>
        <div id="cf-rnc-hint" style="font-size:10.5px;margin-top:4px;color:var(--muted2)"></div>
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
  // Inicializa el detector de tipo de documento (muestra RNC/Cédula al editar)
  setTimeout(onRncInput, 30);
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
  if (!c.phone) { toast('Este cliente no tiene teléfono registrado', 'w'); return; }

  const phone   = c.phone.replace(/\D/g, '');
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

// Guardar un recibo de abono como PDF (bajo demanda, desde el historial).
function guardarAbonoPDF(paymentId) {
  const ctx = window._cliAbonoData;
  const p = ctx && (ctx.pagos || []).find(x => x.id === paymentId);
  if (!p) { toast('Abono no encontrado', 'err'); return; }
  const c = (ctx && ctx.customer) || {};
  const build = () => printAbono({
    payment: {
      id: p.id, amount: p.amount, method: p.method, note: p.note || 'Abono',
      balance_before: p.balance_before, balance_after: p.balance_after, created_at: p.created_at,
    },
    customer: { name: c.name || '', rnc: c.rnc || '' },
    cajero: (window._currentUser && window._currentUser.name) || '',
  });
  if (typeof guardarDocumentoPDF === 'function') {
    guardarDocumentoPDF(build, `Abono-${String(p.id).padStart(5, '0')}`);
  } else { build(); }
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
            <td style="font-size:12px">${facturaLabel(s)} <span style="font-size:10px;color:var(--muted)">${tipo}</span></td>
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
        const concepto = p.note || 'Abono';
        return `
          <tr>
            <td style="font-size:11px;color:var(--muted)">${fdate(fecha)}</td>
            <td style="font-size:12px">${concepto}${facturaRef}</td>
            <td style="text-align:right;color:var(--green);font-weight:700">+${fmt(p.amount)}</td>
            <td>
              <span class="badge g">${p.method || 'efectivo'}</span>
              <span style="font-size:10px;color:var(--muted2);margin-left:4px">
                ${fmt(p.balance_before)} → ${fmt(p.balance_after)}
              </span>
              <button class="btn btn-ghost btn-sm" style="margin-left:4px" title="Guardar recibo en PDF"
                      onclick="guardarAbonoPDF(${p.id})">${svg('pdf')}</button>
            </td>
          </tr>`;
      }).join('');

  // Contexto para "Guardar PDF" de recibos de abono de este cliente.
  window._cliAbonoData = { customer: c, pagos };

  openModal(`
    <div class="modal-title">
      ${c.name}
      <span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:8px">${c.rnc||''} ${c.phone ? '· '+c.phone : ''}</span>
    </div>

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

    <!-- Contenido por tab -->
    ${activeTab === 'cuenta' ? `
      <!-- Historial ventas expandible -->
      <div style="font-weight:700;font-size:12px;margin-bottom:6px">
        Facturas (${ventas.length})</div>
      <div style="max-height:200px;overflow-y:auto;margin-bottom:12px;border:1px solid var(--line);border-radius:6px">
        ${ventas.length === 0
          ? `<div style="text-align:center;padding:16px;color:var(--muted2);font-size:12px">Sin facturas registradas</div>`
          : ventas.map((s, idx) => {
              const fecha = (s.created_at||s.date||'').split('T')[0].split(' ')[0];
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
      const facturas = res?.facturas || [];
      if (!facturas.length) {
        body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted2)">
          <div style="font-size:24px;margin-bottom:8px">✅</div>
          <div>Sin facturas a crédito pendientes</div></div>`;
        return;
      }
      body.innerHTML = facturas.map((f, idx) => {
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
  const ventas = DB.sales.filter(s =>
    (s.customer_id || s.clientId) === c.id && s.status !== 'cancelled'
  ).reverse();

  const totalCompras = ventas.reduce((a, s) => a + s.total, 0);
  const totalAbonado = pagos.reduce((a, p) => a + p.amount, 0);

  const _e = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const ventasRows = ventas.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:12px">Sin compras registradas</td></tr>`
    : ventas.map(s => {
        const fecha = (s.created_at || s.date || '').split('T')[0].split(' ')[0];
        const tipo  = s.type === 'devolucion' ? 'Devolución' :
                      s.type === 'cotizacion' ? 'Cotización' : 'Factura';
        const estado = s.status === 'returned' ? 'Devuelta' :
                       s.status === 'cancelled' ? 'Anulada' : 'OK';
        const metodoBadge = (s.payment_method || s.pay || '—');
        return `<tr>
          <td>${fdate(fecha)}</td>
          <td>${facturaLabel(s)} <span style="color:#9ca3af;font-size:10px">${tipo}</span></td>
          <td style="text-align:right;font-weight:700">${fmt(s.total)}</td>
          <td>${_e(metodoBadge)}</td>
          <td><span style="color:${s.status==='returned'||s.status==='cancelled'?'#dc2626':'#16a34a'};font-weight:600">${estado}</span></td>
        </tr>`;
      }).join('');

  const pagosRows = pagos.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:12px">Sin abonos registrados</td></tr>`
    : [...pagos].reverse().map(p => {
        const fecha = (p.created_at || '').split('T')[0].split(' ')[0];
        return `<tr>
          <td>${fdate(fecha)}</td>
          <td>${_e(p.note || 'Abono')}</td>
          <td style="text-align:right;color:#16a34a;font-weight:700">+${fmt(p.amount)}</td>
          <td>${_e(p.method || 'efectivo')} <span style="color:#9ca3af;font-size:10px">${fmt(p.balance_before)} → ${fmt(p.balance_after)}</span></td>
        </tr>`;
      }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>Estado de Cuenta — ${_e(c.name)}</title>
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

  <h2>Estado de Cuenta — ${_e(c.name)}</h2>
  <div class="sub">
    RNC: ${_e(c.rnc || 'Sin RNC')} ·
    Tel: ${_e(c.phone || 'Sin teléfono')} ·
    Generado: ${fdate(today())} a las ${nowt()} ·
    ${_e(CFG.biz || '')}
  </div>

  <div class="metrics">
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
      <div class="met-s">${pagos.length} abono${pagos.length!==1?'s':''}</div>
    </div>
  </div>

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
