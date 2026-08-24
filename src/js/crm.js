// ══════════════════════════════════════════════
// crm.js — Módulo CRM Cerebro (F0 + F1)
// VeloPOS · inteligencia offline sobre clientes e inventario
// ══════════════════════════════════════════════
//
// F0: panel de inicio (segmentación RFM ligera + destacados).
// F1: Cliente 360° — RFM+ de 6 ejes (recencia, frecuencia, monto, margen,
//     tendencia, pago), hábitos de compra, recompra prevista y crédito.
// Todo calculado 100% offline sobre ventas confirmadas.

// ── Utilitarios locales ───────────────────────
const _crmFmt = n => 'RD$' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
// Compacto para tiles angostas: millones como "RD$8.86M", miles sin decimales.
const _crmFmtCompact = n => {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e6) return 'RD$' + (n / 1e6).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'M';
  if (abs >= 1e4) return 'RD$' + Math.round(n).toLocaleString('es-DO');
  return 'RD$' + n.toLocaleString('es-DO', { maximumFractionDigits: 2 });
};
const _crmRecency = d => (d == null) ? 'sin compras' : (d <= 0 ? 'hoy' : `hace ${d} día${d === 1 ? '' : 's'}`);
const _crmDate = s => { if (!s) return '—'; const d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? String(s).slice(0, 10) : d.toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' }); };

// Config visual de cada segmento (etiqueta + color de acento).
const _CRM_SEGMENTS = {
  vip:        { label: 'VIP',        color: 'var(--green,#00c07a)',  desc: 'Compran seguido y reciente. Cuidar y premiar.' },
  frecuente:  { label: 'Frecuente',  color: 'var(--accent,#059669)', desc: 'Venta constante. El sostén del negocio.' },
  en_riesgo:  { label: 'En riesgo',  color: 'var(--amber,#f59e0b)',  desc: 'Eran habituales y se están enfriando. Contactar.' },
  dormido:    { label: 'Dormido',    color: 'var(--red,#ef4444)',    desc: 'Sin comprar hace tiempo. Intentar reactivar.' },
  nuevo:      { label: 'Nuevo',      color: 'var(--muted2,#9ca3af)', desc: 'Aún sin historial suficiente. Conocerlos.' },
};

function _crmSegBadge(seg) {
  const cfg = _CRM_SEGMENTS[seg] || _CRM_SEGMENTS.nuevo;
  return `<span style="font-size:11px;font-weight:600;color:${cfg.color};border:1px solid ${cfg.color};border-radius:999px;padding:2px 10px">${cfg.label}</span>`;
}

function _crmRenderLoadError(body, area, error) {
  const offline = error?.message === 'SERVER_OFFLINE' || error?.offline || error === 'SERVER_OFFLINE';
  body.innerHTML = `<div class="card" style="max-width:560px;margin:28px auto;padding:22px;text-align:center;border-color:var(--amber,#f59e0b)">
    <div style="font-size:26px;margin-bottom:8px">${offline ? '🔌' : '⚠️'}</div>
    <div style="font-size:14px;font-weight:700;color:var(--ink)">No se pudo cargar ${area}</div>
    <div style="font-size:12px;color:var(--muted2);line-height:1.5;margin:7px 0 14px">
      ${offline
        ? 'La terminal no recibió confirmación del servidor. Revisa la conexión; tus datos no fueron modificados.'
        : 'La consulta no pudo completarse. Puedes intentarlo nuevamente sin cerrar Velo.'}
    </div>
    <button class="btn btn-dark" onclick="_crmLoadTab()">Reintentar</button>
  </div>`;
}

// ── Render principal (con pestañas) ────────────
let _crmTab = 'clientes';

async function renderCRM(el) {
  window._crmPageEl = el;
  const tabBtn = (key, label) => `
    <button data-crmtab="${key}" onclick="switchCRMTab('${key}')"
      style="border:none;background:none;cursor:pointer;padding:8px 4px;margin-right:18px;font-size:14px;font-weight:600;
             color:${_crmTab === key ? 'var(--ink)' : 'var(--muted2)'};
             border-bottom:2px solid ${_crmTab === key ? 'var(--accent,#059669)' : 'transparent'}">${label}</button>`;
  el.innerHTML = `
    <div class="page-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px">
      <div>
        <h1 style="margin:0;display:flex;align-items:center;gap:10px">🧠 CRM Cerebro</h1>
        <div style="font-size:12px;color:var(--muted2);margin-top:4px">Inteligencia offline sobre clientes e inventario</div>
      </div>
      <span style="font-size:11px;color:var(--green,#00c07a);border:1px solid var(--green,#00c07a);border-radius:999px;padding:4px 10px">100% offline</span>
    </div>
    <div style="border-bottom:1px solid var(--line2,#eee);margin-bottom:18px">
      ${tabBtn('clientes', '👤 Clientes')}${tabBtn('inventario', '📦 Inventario')}${tabBtn('contactar', '📣 Contactar hoy')}${tabBtn('aprende', '🎓 Aprende')}
    </div>
    <div id="crm-tab-body"></div>`;
  _crmLoadTab();
}

function switchCRMTab(tab) {
  _crmTab = tab;
  document.querySelectorAll('[data-crmtab]').forEach(b => {
    const on = b.dataset.crmtab === tab;
    b.style.color = on ? 'var(--ink)' : 'var(--muted2)';
    b.style.borderBottom = `2px solid ${on ? 'var(--accent,#059669)' : 'transparent'}`;
  });
  _crmLoadTab();
}

function _crmLoadTab() {
  const body = document.getElementById('crm-tab-body');
  if (!body) return;
  if (_crmTab === 'inventario') return renderCRMInventario(body);
  if (_crmTab === 'contactar') return renderCRMContactar(body);
  if (_crmTab === 'aprende') return renderCRMAprende(body);
  return renderCRMClientes(body);
}

// ── Pestaña Clientes ───────────────────────────
async function renderCRMClientes(body) {
  body.innerHTML = `<div style="color:var(--muted2);padding:40px;text-align:center">Analizando clientes…</div>`;
  let res;
  try {
    res = await window.api.crm.overview();
  } catch (e) {
    _crmRenderLoadError(body, 'el análisis de clientes', e);
    return;
  }
  if (!res || !res.ok) {
    _crmRenderLoadError(body, 'el análisis de clientes', res?.error);
    return;
  }

  const d = res.data;
  const segOrder = ['vip', 'frecuente', 'en_riesgo', 'dormido', 'nuevo'];

  const segCards = segOrder.map(key => {
    const cfg = _CRM_SEGMENTS[key];
    const n = d.segments[key] || 0;
    return `
      <div class="card" style="padding:14px 16px;border-left:4px solid ${cfg.color}">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
          <span style="font-size:13px;font-weight:600;color:var(--ink)">${cfg.label}</span>
          <span style="font-size:22px;font-weight:700;color:var(--ink)">${n}</span>
        </div>
        <div style="font-size:11px;color:var(--muted2);line-height:1.4;margin-top:4px">${cfg.desc}</div>
      </div>`;
  }).join('');

  const rowList = (items, emptyMsg) => {
    if (!items || !items.length) return `<div style="color:var(--muted2);font-size:12px;padding:14px">${emptyMsg}</div>`;
    return items.map(c => {
      const cfg = _CRM_SEGMENTS[c.segment] || _CRM_SEGMENTS.nuevo;
      return `
        <div onclick="showCliente360(${c.id})" title="Ver panel 360° de ${(c.name || '').replace(/"/g, '&quot;')}"
             style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 4px;border-bottom:0.5px solid var(--line2,#eee);cursor:pointer"
             onmouseover="this.style.background='var(--surface3,#f3f4f6)'" onmouseout="this.style.background=''">
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}</div>
            <div style="font-size:11px;color:var(--muted2)">${cfg.label} · ${_crmRecency(c.recency)} · ${c.freq} compra${c.freq === 1 ? '' : 's'}</div>
          </div>
          <div style="font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap">${_crmFmt(c.monetary)}</div>
        </div>`;
    }).join('');
  };

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px">
      ${segCards}
    </div>
    <div style="font-size:11px;color:var(--muted2);margin:2px 0 18px">
      ${d.totalCustomers} clientes activos · ${d.withPurchases} con compras registradas
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">🏆 Mejores clientes por valor</div>
        ${rowList(d.topSpenders, 'Aún no hay ventas registradas a clientes.')}
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">📉 En riesgo o dormidos</div>
        ${rowList(d.atRisk, 'Ningún cliente en riesgo por ahora. 🎉')}
      </div>
    </div>

    <div style="margin-top:18px;padding:12px 14px;background:var(--surface3,#f3f4f6);border-radius:10px;font-size:12px;color:var(--muted2)">
      <strong style="color:var(--ink)">Cerebro de cliente activo.</strong> RFM+ de 6 ejes por cliente (recencia, frecuencia, monto, margen, tendencia y pago).
      El cerebro de inventario está en <strong style="color:var(--ink)">Inventario</strong> y los mensajes listos para enviar, en <strong style="color:var(--ink)">Contactar hoy</strong>.
    </div>`;
}

// ── Cliente 360° (F1) ──────────────────────────
async function showCliente360(customerId) {
  openModal(`<div style="padding:40px;text-align:center;color:var(--muted2)">Cargando panel 360°…</div>`, 'modal-lg');
  let res;
  try {
    res = await window.api.crm.customer360({ customerId });
  } catch (e) {
    openModal(`<div style="padding:24px;color:var(--red,#ef4444)">No se pudo cargar: ${e.message}</div>`);
    return;
  }
  if (!res || !res.ok) {
    openModal(`<div style="padding:24px;color:var(--red,#ef4444)">No se pudo cargar: ${res?.error || 'error'}</div>`);
    return;
  }
  const d = res.data;
  const c = d.customer;
  const m = d.metrics;

  const stat = (label, value, color, sub, full) => `
    <div style="background:var(--surface2,#fafafa);border-radius:10px;padding:10px 12px;min-width:0"${full ? ` title="${full}"` : ''}>
      <div style="font-size:11px;color:var(--muted2);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
      <div style="font-size:15px;font-weight:700;color:${color || 'var(--ink)'};font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${value}</div>
      ${sub ? `<div style="font-size:10px;color:var(--muted2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>` : ''}
    </div>`;

  const rfmDot = (n) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:2px;background:${n ? 'var(--accent,#059669)' : 'var(--line2,#ddd)'}"></span>`;
  const rfmBar = (score) => Array.from({ length: 5 }, (_, i) => rfmDot(i < score)).join('');

  const payCfg = {
    al_dia:    { t: 'Al día',            c: 'var(--green,#00c07a)' },
    moroso:    { t: 'Moroso / vencido',  c: 'var(--red,#ef4444)' },
    bloqueado: { t: 'Bloqueado',         c: 'var(--red,#ef4444)' },
  }[d.payment.status] || { t: '—', c: 'var(--muted2)' };

  const trendCfg = {
    subiendo: { t: '▲ Subiendo', c: 'var(--green,#00c07a)' },
    bajando:  { t: '▼ Bajando',  c: 'var(--red,#ef4444)' },
    estable:  { t: '► Estable',  c: 'var(--muted2)' },
  }[d.trend.direction] || { t: '—', c: 'var(--muted2)' };

  const topProducts = d.topProducts.length
    ? d.topProducts.map(p => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--line2,#eee);font-size:12px"><span style="color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</span><span style="color:var(--muted2);white-space:nowrap">${p.times}× · ${p.qty} und</span></div>`).join('')
    : `<div style="color:var(--muted2);font-size:12px;padding:8px 0">Sin productos registrados.</div>`;

  const repurchase = d.nextRepurchase
    ? `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:${d.nextRepurchase.due ? 'var(--amber,#f59e0b)22' : 'var(--surface3,#f3f4f6)'};font-size:12px;color:var(--ink)">
         🔁 <strong>${d.nextRepurchase.product}</strong>: compra cada ~${d.nextRepurchase.avgDays} días · van ${d.nextRepurchase.daysSince}${d.nextRepurchase.due ? ' — <span style="color:var(--amber,#b45309)">tocaría reponer</span>' : ''}
       </div>`
    : '';

  const history = d.recentSales.length
    ? d.recentSales.map(s => `<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:0.5px solid var(--line2,#eee);font-size:12px"><span style="color:var(--muted2)">${_crmDate(s.created_at)}${s.ncf ? ` · <span style="font-size:10px">NCF ${s.ncf}</span>` : ''}</span><span style="color:var(--ink);font-weight:600">${_crmFmt(s.total)}</span></div>`).join('')
    : `<div style="color:var(--muted2);font-size:12px;padding:8px 0">Sin ventas registradas.</div>`;

  const creditLine = c.credit_limit > 0
    ? `${_crmFmt(c.balance)} / ${_crmFmt(c.credit_limit)}${c.credit_due ? ` · vence ${_crmDate(c.credit_due)}` : ''}`
    : (c.balance > 0 ? `${_crmFmt(c.balance)} pendiente` : 'Sin crédito');

  const displayName = c.customer_type === 'company' ? (c.trade_name || c.name) : c.name;

  const html = `
    <div class="modal-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line2,#eee)">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <div style="width:40px;height:40px;border-radius:50%;background:var(--accent,#059669)22;color:var(--accent,#059669);display:flex;align-items:center;justify-content:center;font-weight:700;flex:0 0 40px">${(displayName || '?').slice(0, 2).toUpperCase()}</div>
        <div style="min-width:0">
          <div style="font-size:16px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${displayName || 'Cliente'}</div>
          <div style="font-size:11px;color:var(--muted2)">${c.customer_type === 'company' ? 'Empresa' : 'Persona'}${c.rnc ? ` · ${c.rnc}` : ''}${c.phone ? ` · ${c.phone}` : ''}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto">${_crmSegBadge(d.segment)}<button class="btn btn-ghost" onclick="closeModal()" style="font-size:18px;line-height:1;padding:2px 8px">×</button></div>
    </div>

    <div style="padding:16px 18px;max-height:70vh;overflow:auto">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px">
        ${stat('Valor total (LTV)', _crmFmtCompact(m.monetary), null, null, _crmFmt(m.monetary))}
        ${m.marginKnown
          ? stat('Margen aportado', _crmFmtCompact(m.margin), 'var(--green,#00c07a)', `${Math.round(m.marginPct)}% margen`, _crmFmt(m.margin))
          : stat('Margen aportado', '—', 'var(--muted2)', 'sin costo registrado')}
        ${stat('Compras', m.frequency)}
        ${stat('Ticket prom.', _crmFmtCompact(m.avgTicket), null, null, _crmFmt(m.avgTicket))}
        ${stat('Última compra', _crmRecency(m.recency))}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div class="card" style="padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:10px">RFM+ · 6 ejes</div>
          <div style="display:flex;flex-direction:column;gap:7px;font-size:12px">
            <div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Recencia</span><span>${rfmBar(d.rfm.r)}</span></div>
            <div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Frecuencia</span><span>${rfmBar(d.rfm.f)}</span></div>
            <div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Monto</span><span>${rfmBar(d.rfm.m)}</span></div>
            <div style="display:flex;justify-content:space-between;border-top:0.5px solid var(--line2,#eee);padding-top:7px"><span style="color:var(--muted2)">Tendencia</span><span style="color:${trendCfg.c};font-weight:600">${trendCfg.t}</span></div>
            <div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Pago</span><span style="color:${payCfg.c};font-weight:600">${payCfg.t}</span></div>
          </div>
        </div>
        <div class="card" style="padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:10px">Crédito</div>
          <div style="font-size:13px;color:var(--ink);margin-bottom:6px">${creditLine}</div>
          ${d.payment.overdue ? `<div style="font-size:12px;color:var(--red,#ef4444);font-weight:600">⚠ Crédito vencido</div>` : `<div style="font-size:12px;color:var(--muted2)">Sin vencimientos pendientes</div>`}
          <div style="margin-top:10px;font-size:11px;color:var(--muted2)">Cliente desde ${_crmDate(m.firstSale)}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div class="card" style="padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:6px">🛒 Suele comprar</div>
          ${topProducts}
          ${repurchase}
        </div>
        <div class="card" style="padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:6px">🧾 Historial reciente</div>
          ${history}
        </div>
      </div>
    </div>`;

  openModal(html, 'modal-lg');
}

// ── Pestaña Inventario (F2) ────────────────────
const _CRM_PSEG = {
  estrella:  { label: 'Estrella',  color: 'var(--green,#00c07a)',  desc: 'Alta demanda + buen margen. Nunca deben faltar.' },
  estable:   { label: 'Estable',   color: 'var(--accent,#059669)', desc: 'Venta constante. El sostén del inventario.' },
  reponer:   { label: 'Reponer',   color: 'var(--amber,#f59e0b)',  desc: 'Se agotan pronto. Pedir para no perder venta.' },
  congelado: { label: 'Congelado', color: 'var(--red,#ef4444)',    desc: 'Sin venderse hace meses. Capital dormido.' },
};

function _crmPSegBadge(seg) {
  const cfg = _CRM_PSEG[seg] || _CRM_PSEG.estable;
  return `<span style="font-size:11px;font-weight:600;color:${cfg.color};border:1px solid ${cfg.color};border-radius:999px;padding:2px 10px">${cfg.label}</span>`;
}

async function renderCRMInventario(body) {
  body.innerHTML = `<div style="color:var(--muted2);padding:40px;text-align:center">Analizando inventario…</div>`;
  let res;
  try {
    res = await window.api.crm.inventoryOverview();
  } catch (e) {
    _crmRenderLoadError(body, 'el análisis de inventario', e);
    return;
  }
  if (!res || !res.ok) {
    _crmRenderLoadError(body, 'el análisis de inventario', res?.error);
    return;
  }
  const d = res.data;
  const order = ['estrella', 'estable', 'reponer', 'congelado'];

  const segCards = order.map(k => {
    const cfg = _CRM_PSEG[k];
    return `
      <div class="card" style="padding:14px 16px;border-left:4px solid ${cfg.color}">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
          <span style="font-size:13px;font-weight:600;color:var(--ink)">${cfg.label}</span>
          <span style="font-size:22px;font-weight:700;color:var(--ink)">${d.segments[k] || 0}</span>
        </div>
        <div style="font-size:11px;color:var(--muted2);line-height:1.4;margin-top:4px">${cfg.desc}</div>
      </div>`;
  }).join('');

  const prow = (p, right, subLeft) => `
    <div onclick="showProducto360(${p.id})" title="Ver ficha de ${(p.name || '').replace(/"/g, '&quot;')}"
         style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 4px;border-bottom:0.5px solid var(--line2,#eee);cursor:pointer"
         onmouseover="this.style.background='var(--surface3,#f3f4f6)'" onmouseout="this.style.background=''">
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div style="font-size:11px;color:var(--muted2)">${subLeft}</div>
      </div>
      <div style="font-size:12px;font-weight:600;color:var(--ink);white-space:nowrap;text-align:right">${right}</div>
    </div>`;

  const listOr = (items, fn, empty) => items && items.length ? items.map(fn).join('') : `<div style="color:var(--muted2);font-size:12px;padding:14px">${empty}</div>`;

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px">${segCards}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:2px 0 18px">
      <div style="font-size:11px;color:var(--muted2)">
        ${d.totalProducts} productos activos · ${d.withStock} con stock · valor en inventario ${_crmFmtCompact(d.stockValue)}
      </div>
      <button class="btn btn-ghost" onclick="showCategoryTemplates()" style="font-size:12px;padding:5px 10px">⚙️ Plantillas de categoría</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">⚠️ Reponer urgente</div>
        ${listOr(d.reorderList, p => prow(p, `quedan ${p.stock}`, `${p.daysOfStock != null ? `~${p.daysOfStock} días de stock` : 'bajo mínimo'} · vendió ${p.qty90}/90d`), 'Nada urgente por reponer. 👍')}
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">❄️ Capital congelado</div>
        ${listOr(d.deadList, p => prow(p, _crmFmtCompact(p.stockValue), `${p.stock} und · ${p.daysSinceLastSale != null ? `sin venta hace ${p.daysSinceLastSale} días` : 'nunca vendido'}`), 'Sin inventario muerto. 🎉')}
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">🏆 Productos estrella</div>
        ${listOr(d.starList, p => prow(p, `${Math.round(p.marginPct)}% margen`, `vendió ${p.qty90} und/90d`), 'Aún sin estrellas claras.')}
      </div>
    </div>
    <div id="crm-warehouse" style="margin-top:16px"></div>
    <div style="margin-top:18px;padding:12px 14px;background:var(--surface3,#f3f4f6);border-radius:10px;font-size:12px;color:var(--muted2)">
      <strong style="color:var(--ink)">Cerebro de inventario activo.</strong> Segmentación offline + salud física (caducidad y mantenimiento).
      Configura los atributos por <strong style="color:var(--ink)">plantilla de categoría</strong> para no llenarlos uno a uno.
    </div>`;

  _crmLoadWarehouse();
}

// ── Revisar en almacén (F2b) ───────────────────
async function _crmLoadWarehouse() {
  const box = document.getElementById('crm-warehouse');
  if (!box) return;
  let res;
  try { res = await window.api.crm.warehouseReview(); } catch { return; }
  if (!res || !res.ok) return;
  const w = res.data;

  if (!w.configured) {
    box.innerHTML = `
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">🩺 Revisar en almacén</div>
        <div style="font-size:12px;color:var(--muted2)">Aún no hay productos con caducidad o mantenimiento configurados.
        Usa <strong style="color:var(--ink)">⚙️ Plantillas de categoría</strong> para activarlos (ej. "Baterías → caduca 18 meses").</div>
      </div>`;
    return;
  }

  const alert = (icon, borderVar, name, code, right, sub) => `
    <div onclick="showProducto360(${'PID'})" style="display:flex;align-items:flex-start;gap:10px;background:var(--surface2,#fafafa);border-left:3px solid ${borderVar};border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer"
         onmouseover="this.style.background='var(--surface3,#f3f4f6)'" onmouseout="this.style.background='var(--surface2,#fafafa)'">
      <span style="font-size:16px;line-height:1.2">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name} <span style="font-weight:400;color:var(--muted2);font-size:11px">${code || ''}</span></div>
        <div style="font-size:11px;color:var(--muted2)">${sub}</div>
      </div>
      <div style="font-size:11px;font-weight:600;color:var(--ink);white-space:nowrap;text-align:right">${right}</div>
    </div>`;

  const expiring = w.expiring.map(p => alert(
    '⏰', p.daysToExpiry < 0 ? 'var(--red,#ef4444)' : 'var(--amber,#f59e0b)',
    p.name, p.code,
    p.daysToExpiry < 0 ? 'vencido' : `${p.daysToExpiry} días`,
    `${p.stock} und · ${p.daysToExpiry < 0 ? 'caducó' : 'caduca'} ${p.expiry}`
  ).replace('PID', p.id)).join('') || `<div style="font-size:12px;color:var(--muted2);padding:6px 0">Nada por caducar. 👍</div>`;

  const maint = w.maintenance.map(p => alert(
    '🛢️', p.daysOverdue >= 0 ? 'var(--amber,#f59e0b)' : 'var(--accent,#059669)',
    p.name, p.code,
    p.daysOverdue >= 0 ? 'vencido' : 'pronto',
    `${_crmCareLabel(p.careType)}${p.lastCare ? ` · último ${_crmDate(p.lastCare)}` : ''}`
  ).replace('PID', p.id)).join('') || `<div style="font-size:12px;color:var(--muted2);padding:6px 0">Sin mantenimientos pendientes. 👍</div>`;

  box.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:10px">⏰ Por caducar</div>
        ${expiring}
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:10px">🛢️ Mantenimiento en almacén</div>
        ${maint}
      </div>
    </div>`;
}

const _crmCareLabel = t => ({ engrasar: 'Engrasar', rotar: 'Rotar existencias', revisar_carga: 'Revisar carga', otro: 'Mantenimiento' }[t] || 'Mantenimiento');

// ── Producto 360° (F2) ─────────────────────────
async function showProducto360(productId) {
  openModal(`<div style="padding:40px;text-align:center;color:var(--muted2)">Cargando ficha…</div>`, 'modal-lg');
  let res;
  try {
    res = await window.api.crm.product360({ productId });
  } catch (e) {
    openModal(`<div style="padding:24px;color:var(--red,#ef4444)">No se pudo cargar: ${e.message}</div>`);
    return;
  }
  if (!res || !res.ok) {
    openModal(`<div style="padding:24px;color:var(--red,#ef4444)">No se pudo cargar: ${res?.error || 'error'}</div>`);
    return;
  }
  const d = res.data;
  const p = d.product;
  const mt = d.metrics;
  const sa = d.sales;

  const stat = (label, value, color, full) => `
    <div style="background:var(--surface2,#fafafa);border-radius:10px;padding:10px 12px;min-width:0"${full ? ` title="${full}"` : ''}>
      <div style="font-size:11px;color:var(--muted2);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
      <div style="font-size:15px;font-weight:700;color:${color || 'var(--ink)'};font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${value}</div>
    </div>`;

  const boughtWith = d.boughtWith.length
    ? d.boughtWith.map(b => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--line2,#eee);font-size:12px"><span style="color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.name}</span><span style="color:var(--muted2);white-space:nowrap">${b.times}×</span></div>`).join('')
    : `<div style="color:var(--muted2);font-size:12px;padding:8px 0">Aún sin patrón de canasta.</div>`;

  const movLabel = { entrada: '↑ Entrada', salida: '↓ Salida', ajuste: '≈ Ajuste', devolucion: '↩ Devolución', dano: '✖ Daño', perdida: '✖ Pérdida' };
  const movements = d.recentMovements.length
    ? d.recentMovements.map(mv => `<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:0.5px solid var(--line2,#eee);font-size:12px"><span style="color:var(--muted2)">${_crmDate(mv.created_at)} · ${movLabel[mv.type] || mv.type}</span><span style="color:var(--ink);font-weight:600">${mv.qty} → ${mv.qty_after}</span></div>`).join('')
    : `<div style="color:var(--muted2);font-size:12px;padding:8px 0">Sin movimientos registrados.</div>`;

  const reorderNote = (d.segment === 'reponer')
    ? `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--amber,#f59e0b)22;font-size:12px;color:var(--ink)">⚠️ ${sa.daysOfStock != null ? `Se agota en ~${sa.daysOfStock} días al ritmo actual.` : 'Bajo el stock mínimo.'} Conviene reponer.</div>`
    : (d.segment === 'congelado')
      ? `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--red,#ef4444)18;font-size:12px;color:var(--ink)">❄️ ${sa.daysSinceLastSale != null ? `Sin venderse hace ${sa.daysSinceLastSale} días.` : 'Nunca vendido.'} Capital dormido — liquidar o promocionar.</div>`
      : '';

  const html = `
    <div class="modal-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line2,#eee)">
      <div style="min-width:0">
        <div style="font-size:16px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div style="font-size:11px;color:var(--muted2)">${p.code}${p.brand ? ` · ${p.brand}` : ''}${p.category ? ` · ${p.category}` : ''}${d.shelfAge != null ? ` · ${d.shelfAge} días en estante` : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto">${_crmPSegBadge(d.segment)}<button class="btn btn-ghost" onclick="closeModal()" style="font-size:18px;line-height:1;padding:2px 8px">×</button></div>
    </div>
    <div style="padding:16px 18px;max-height:70vh;overflow:auto">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px">
        ${stat('Existencia', `${mt.stock} und`)}
        ${stat('Rotación', sa.velocityMonth ? `${sa.velocityMonth}/mes` : '—')}
        ${stat('Días de stock', sa.daysOfStock != null ? `${sa.daysOfStock} días` : '—')}
        ${stat('Margen', `${Math.round(mt.marginPct)}%`, 'var(--green,#00c07a)')}
        ${stat('Valor en stock', _crmFmtCompact(mt.stockValue), null, _crmFmt(mt.stockValue))}
      </div>
      ${reorderNote}
      ${_crmCareBlock(d)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px">
        <div class="card" style="padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:6px">🔗 Se vende junto con</div>
          ${boughtWith}
        </div>
        <div class="card" style="padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:6px">📦 Movimientos recientes</div>
          ${movements}
        </div>
      </div>
      <div style="margin-top:14px;font-size:11px;color:var(--muted2)">
        Costo ${_crmFmt(mt.cost)} · Precio ${_crmFmt(mt.price)} · Vendió ${sa.qty90} und en 90 días · ${sa.timesSold} ventas históricas
      </div>
    </div>`;
  openModal(html, 'modal-lg');
}

// ── F2b: salud física en la ficha de producto + plantillas ─────
function _crmUser() {
  if (window._currentUser) return window._currentUser;
  try { const s = sessionStorage.getItem('vp_user'); if (s) return JSON.parse(s); } catch {}
  return null;
}

function _crmCareBlock(d) {
  const c = d.care;
  if (!c || (!c.perishable && !c.expiry && !c.careType && !c.storageNote)) return '';
  const rows = [];
  if (c.expiry) {
    const col = c.daysToExpiry < 0 ? 'var(--red,#ef4444)' : (c.daysToExpiry <= 60 ? 'var(--amber,#b45309)' : 'var(--muted2)');
    rows.push(`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:var(--muted2)">Caducidad</span><span style="color:${col};font-weight:600">${c.daysToExpiry < 0 ? `vencido (${c.expiry})` : `${c.expiry} · en ${c.daysToExpiry} días`}</span></div>`);
  }
  if (c.careType) {
    const col = (c.daysToCare != null && c.daysToCare <= 0) ? 'var(--amber,#b45309)' : 'var(--muted2)';
    rows.push(`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:var(--muted2)">${_crmCareLabel(c.careType)}</span><span style="color:${col};font-weight:600">${c.daysToCare != null ? (c.daysToCare <= 0 ? 'vencido' : `en ${c.daysToCare} días`) : '—'}${c.lastCareAt ? ` · últ. ${_crmDate(c.lastCareAt)}` : ''}</span></div>`);
  }
  if (c.storageNote) rows.push(`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:var(--muted2)">Almacenaje</span><span style="color:var(--ink)">${c.storageNote}</span></div>`);
  return `<div class="card" style="padding:14px;margin-top:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div style="font-size:12px;font-weight:700;color:var(--ink)">🩺 Salud física</div>
      ${c.careType ? `<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onclick="_crmMarkCareDone(${d.product.id})">Marcar mantenimiento hecho</button>` : ''}
    </div>
    ${rows.join('')}
  </div>`;
}

async function _crmMarkCareDone(productId) {
  const r = await window.api.crm.setProductCare({ productId, attrs: { markCareDone: true }, requestUserId: _crmUser()?.id });
  if (!r || !r.ok) { toast(r?.error || 'No se pudo', 'e'); return; }
  toast('Mantenimiento registrado', 's');
  showProducto360(productId);
}

// ── Modal: plantillas de cuidado por categoría ──
async function showCategoryTemplates() {
  let res;
  try { res = await window.api.crm.categoryTemplates(); } catch (e) { toast('No se pudo cargar', 'e'); return; }
  if (!res || !res.ok) { toast(res?.error || 'Error', 'e'); return; }
  window._crmCats = res.data;
  if (!res.data.length) { openModal(`<div style="padding:24px;color:var(--muted2)">No hay categorías de productos aún.</div>`); return; }
  const options = res.data.map((c, i) => `<option value="${i}">${c.category} (${c.productCount})${c.template ? ' ✓' : ''}</option>`).join('');
  const careOpts = ['', 'engrasar', 'rotar', 'revisar_carga', 'otro'].map(v => `<option value="${v}">${v ? _crmCareLabel(v) : 'Ninguno'}</option>`).join('');
  const html = `
    <div class="modal-head" style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--line2,#eee)">
      <div style="font-size:16px;font-weight:700;color:var(--ink)">⚙️ Plantillas de categoría</div>
      <button class="btn btn-ghost" onclick="closeModal()" style="font-size:18px;padding:2px 8px">×</button>
    </div>
    <div style="padding:16px 18px;max-height:70vh;overflow:auto">
      <div style="font-size:12px;color:var(--muted2);margin-bottom:14px">Define caducidad y mantenimiento para toda una categoría y aplícalo a sus productos de una vez — así no configuras miles a mano.</div>
      <label style="font-size:12px;color:var(--muted2)">Categoría</label>
      <select id="ct-cat" onchange="_crmFillTemplate()" style="width:100%;margin:4px 0 14px">${options}</select>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <input type="checkbox" id="ct-perish"> <label for="ct-perish" style="font-size:13px;color:var(--ink)">Este tipo de producto caduca</label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div><label style="font-size:12px;color:var(--muted2)">Vida útil (meses)</label><input id="ct-shelf" type="number" min="1" style="width:100%" placeholder="ej. 18"></div>
        <div><label style="font-size:12px;color:var(--muted2)">Mantenimiento</label><select id="ct-care" style="width:100%">${careOpts}</select></div>
        <div><label style="font-size:12px;color:var(--muted2)">Repetir cada (meses)</label><input id="ct-caremonths" type="number" min="1" style="width:100%" placeholder="ej. 6"></div>
        <div><label style="font-size:12px;color:var(--muted2)">Nota de almacenaje</label><input id="ct-note" type="text" style="width:100%" placeholder="ej. mantener seco"></div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button class="btn" onclick="_crmSaveTemplate(false)">Guardar plantilla</button>
        <button class="btn btn-green" onclick="_crmSaveTemplate(true)">Guardar y aplicar a la categoría</button>
      </div>
    </div>`;
  openModal(html, 'modal-lg');
  _crmFillTemplate();
}

function _crmFillTemplate() {
  const cats = window._crmCats || [];
  const sel = document.getElementById('ct-cat');
  if (!sel) return;
  const t = cats[+sel.value]?.template;
  document.getElementById('ct-perish').checked = !!(t && t.perishable);
  document.getElementById('ct-shelf').value = t?.shelf_life_months ?? '';
  document.getElementById('ct-care').value = t?.care_type ?? '';
  document.getElementById('ct-caremonths').value = t?.care_every_months ?? '';
  document.getElementById('ct-note').value = t?.storage_note ?? '';
}

async function _crmSaveTemplate(applyNow) {
  const cats = window._crmCats || [];
  const category = cats[+document.getElementById('ct-cat').value]?.category;
  if (!category) return;
  const template = {
    category,
    perishable: document.getElementById('ct-perish').checked,
    shelf_life_months: document.getElementById('ct-shelf').value,
    care_type: document.getElementById('ct-care').value,
    care_every_months: document.getElementById('ct-caremonths').value,
    storage_note: document.getElementById('ct-note').value.trim(),
    applyNow,
  };
  const r = await window.api.crm.saveCategoryTemplate({ template, requestUserId: _crmUser()?.id });
  if (!r || !r.ok) { toast(r?.error || 'No se pudo guardar', 'e'); return; }
  toast(applyNow ? `Aplicado a ${r.applied} producto(s)` : 'Plantilla guardada', 's');
  closeModal();
  if (_crmTab === 'inventario') _crmLoadTab();
}

// ── Pestaña Contactar hoy (F3) ─────────────────
const _CRM_REASON = {
  credito:  { label: 'Crédito',  color: 'var(--amber,#f59e0b)' },
  dormido:  { label: 'Dormido',  color: 'var(--blue,#3b82f6)' },
  recompra: { label: 'Recompra', color: 'var(--green,#00c07a)' },
};

async function renderCRMContactar(body) {
  body.innerHTML = `<div style="color:var(--muted2);padding:40px;text-align:center">Buscando a quién contactar…</div>`;
  let res;
  try { res = await window.api.crm.contactToday(); } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar: ${e.message}</div>`; return;
  }
  if (!res || !res.ok) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar: ${res?.error || 'error'}</div>`; return;
  }
  const items = res.data.items || [];
  window._crmContactItems = items;

  if (!items.length) {
    body.innerHTML = `
      <div class="card" style="padding:28px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">🎉</div>
        <div style="font-size:14px;font-weight:600;color:var(--ink)">Nada urgente por contactar hoy</div>
        <div style="font-size:12px;color:var(--muted2);margin-top:4px">El cerebro no detectó créditos por vencer, clientes dormidos ni recompras pendientes.</div>
      </div>`;
    return;
  }

  const cards = items.map((it, i) => {
    const rc = _CRM_REASON[it.reasonType] || { label: it.reasonType, color: 'var(--muted2)' };
    const initials = (it.name || '?').slice(0, 2).toUpperCase();
    return `
      <div class="card" style="padding:14px 16px;border-left:4px solid ${rc.color};margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            <div style="width:34px;height:34px;border-radius:50%;background:${rc.color}22;color:${rc.color};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:0 0 34px">${initials}</div>
            <div style="min-width:0">
              <div style="font-size:14px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.name}</div>
              <div style="font-size:11px;color:${rc.color}">${rc.label} · ${it.reason}</div>
            </div>
          </div>
          <button class="btn btn-green" onclick="_crmSendWhatsApp(${i})" style="font-size:12px;padding:6px 12px;white-space:nowrap">📲 Enviar por WhatsApp</button>
        </div>
        <div style="background:var(--surface2,#fafafa);border:1px dashed var(--line2,#ddd);border-radius:9px;padding:10px 12px;font-size:13px;color:var(--ink2,var(--ink));line-height:1.55">${it.message}</div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <div style="font-size:12px;color:var(--muted2)">${items.length} cliente(s) detectado(s) · mensajes redactados automáticamente</div>
      <span style="font-size:11px;color:var(--green,#00c07a);border:1px solid var(--green,#00c07a);border-radius:999px;padding:3px 10px">redacción offline · envío manual</span>
    </div>
    ${cards}
    <div style="margin-top:6px;padding:12px 14px;background:var(--surface3,#f3f4f6);border-radius:10px;font-size:12px;color:var(--muted2)">
      El cerebro redacta cada mensaje con los datos del cliente. Al pulsar <strong style="color:var(--ink)">Enviar</strong> se abre WhatsApp con el texto listo — tú lo revisas y envías.
    </div>`;
}

async function _crmSendWhatsApp(i) {
  const it = (window._crmContactItems || [])[i];
  if (!it) return;
  // Registrar el contacto (alimenta el aprendizaje futuro) — sin bloquear el envío.
  try {
    await window.api.crm.logInteraction({
      customerId: it.customerId, kind: 'whatsapp', reason: it.reasonType,
      message: it.message, requestUserId: _crmUser()?.id,
    });
  } catch {}
  if (typeof openWhatsAppModal === 'function') {
    openWhatsAppModal(it.message, it.phone, it.name);
  } else {
    toast('No se encontró el envío de WhatsApp', 'e');
  }
}

// ── Pestaña Aprende (F-Aprendizaje) ────────────
async function renderCRMAprende(body) {
  body.innerHTML = `<div style="color:var(--muted2);padding:40px;text-align:center">Repasando lo aprendido…</div>`;
  let res;
  try { res = await window.api.crm.learningStats(); } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar: ${e.message}</div>`; return;
  }
  if (!res || !res.ok) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar: ${res?.error || 'error'}</div>`; return;
  }
  const b = res.data.business;
  const ef = res.data.effectiveness;

  const insight = (icon, value, label) => `
    <div class="card" style="padding:14px 16px">
      <div style="font-size:20px;margin-bottom:4px">${icon}</div>
      <div style="font-size:18px;font-weight:700;color:var(--ink)">${value}</div>
      <div style="font-size:11px;color:var(--muted2);line-height:1.4;margin-top:2px">${label}</div>
    </div>`;

  const insights = `
    <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:10px">🧠 Lo que aprendí de tu negocio</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:22px">
      ${insight('🔁', b.medianGapDays != null ? `~${b.medianGapDays} días` : '—', 'Ritmo típico: cada cuánto vuelve un cliente. Lo uso para anticipar recompras.')}
      ${insight('💰', b.bigTicket > 0 ? _crmFmtCompact(b.bigTicket) : '—', 'Una compra "grande" en tu tienda (25% superior). Calibra a tus mejores clientes.')}
      ${insight('⭐', `≥ ${b.starQty} und/90d`, 'Cuánto debe vender un producto para ser "estrella" AQUÍ — se adapta a tu escala.')}
      ${insight('📈', b.avgMarginPct != null ? `${Math.round(b.avgMarginPct)}%` : 'sin costo', 'Tu margen típico sobre los ítems con costo registrado.')}
    </div>`;

  let feedback;
  if (!ef.sent) {
    feedback = `
      <div class="card" style="padding:20px;text-align:center">
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">📊 ¿Funcionan tus contactos?</div>
        <div style="font-size:12px;color:var(--muted2)">Aún aprendiendo. Cada vez que envíes un mensaje desde <strong style="color:var(--ink)">Contactar hoy</strong>,
        el cerebro anota si el cliente compró después — y aquí verás qué motivos funcionan mejor.</div>
      </div>`;
  } else {
    const reasonLabel = r => ({ credito: 'Crédito', dormido: 'Dormido', recompra: 'Recompra' }[r] || 'Otro');
    const rows = ef.byReason.map(r => {
      const col = r.rate >= 40 ? 'var(--green,#00c07a)' : (r.rate >= 20 ? 'var(--amber,#f59e0b)' : 'var(--muted2)');
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:0.5px solid var(--line2,#eee)">
          <span style="font-size:13px;color:var(--ink)">${reasonLabel(r.reason)}</span>
          <span style="font-size:12px;color:var(--muted2)">${r.bought}/${r.sent} compraron · <strong style="color:${col}">${r.rate}%</strong></span>
        </div>`;
    }).join('');
    feedback = `
      <div class="card" style="padding:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:13px;font-weight:700;color:var(--ink)">📊 ¿Funcionan tus contactos?</div>
          <div style="font-size:12px;color:var(--muted2)">Global: <strong style="color:var(--ink)">${ef.rate}%</strong> (${ef.bought}/${ef.sent} compraron en 30 días)</div>
        </div>
        ${rows}
        <div style="font-size:11px;color:var(--muted2);margin-top:10px">El cerebro prioriza los motivos que más venta generan en tu tienda.</div>
      </div>`;
  }

  body.innerHTML = `
    ${insights}
    ${feedback}
    <div style="margin-top:18px;padding:12px 14px;background:var(--surface3,#f3f4f6);border-radius:10px;font-size:12px;color:var(--muted2)">
      <strong style="color:var(--ink)">Aprendizaje explicable.</strong> Todo sale de tus propios datos y puedes ver el porqué —
      sin caja negra. Mientras más vendes y más contactos registras, más se afina.
    </div>`;
}
