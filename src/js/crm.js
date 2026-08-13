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
      ${tabBtn('clientes', '👤 Clientes')}${tabBtn('inventario', '📦 Inventario')}
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
  return renderCRMClientes(body);
}

// ── Pestaña Clientes ───────────────────────────
async function renderCRMClientes(body) {
  body.innerHTML = `<div style="color:var(--muted2);padding:40px;text-align:center">Analizando clientes…</div>`;
  let res;
  try {
    res = await window.api.crm.overview();
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar el CRM: ${e.message}</div>`;
    return;
  }
  if (!res || !res.ok) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar el CRM: ${res?.error || 'error desconocido'}</div>`;
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
      El cerebro de inventario está en la pestaña <strong style="color:var(--ink)">Inventario</strong>; la Fase 3 añade el redactor de mensajes de WhatsApp.
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
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar el inventario: ${e.message}</div>`;
    return;
  }
  if (!res || !res.ok) {
    body.innerHTML = `<div style="color:var(--red,#ef4444);padding:24px">No se pudo cargar el inventario: ${res?.error || 'error'}</div>`;
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
    <div style="font-size:11px;color:var(--muted2);margin:2px 0 18px">
      ${d.totalProducts} productos activos · ${d.withStock} con stock · valor en inventario ${_crmFmtCompact(d.stockValue)}
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
    <div style="margin-top:18px;padding:12px 14px;background:var(--surface3,#f3f4f6);border-radius:10px;font-size:12px;color:var(--muted2)">
      <strong style="color:var(--ink)">Cerebro de inventario activo.</strong> Segmentación por demanda, rotación y antigüedad en estante — todo offline.
      La Fase 2b añade caducidad y mantenimiento (atributos por producto/categoría).
    </div>`;
}

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
