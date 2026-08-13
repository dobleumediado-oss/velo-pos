// ══════════════════════════════════════════════
// crm.js — Módulo CRM Cerebro (F0)
// VeloPOS · inteligencia offline sobre clientes e inventario
// ══════════════════════════════════════════════
//
// F0 entrega el panel de inicio: segmentación RFM ligera de clientes
// (calculada 100% offline sobre ventas confirmadas) más listas destacadas.
// F1 profundiza el scoring a 6 ejes y añade el panel Cliente 360°.
// El módulo se activa en superadmin (module_crm) y solo lo ve el admin.

// ── Utilitarios locales ───────────────────────
const _crmFmt = n => 'RD$' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _crmRecency = d => (d == null) ? 'sin compras' : (d <= 0 ? 'hoy' : `hace ${d} día${d === 1 ? '' : 's'}`);

// Config visual de cada segmento (etiqueta + color de acento).
const _CRM_SEGMENTS = {
  vip:        { label: 'VIP',        color: 'var(--green,#00c07a)',  desc: 'Compran seguido y reciente. Cuidar y premiar.' },
  frecuente:  { label: 'Frecuente',  color: 'var(--accent,#059669)', desc: 'Venta constante. El sostén del negocio.' },
  en_riesgo:  { label: 'En riesgo',  color: 'var(--amber,#f59e0b)',  desc: 'Eran habituales y se están enfriando. Contactar.' },
  dormido:    { label: 'Dormido',    color: 'var(--red,#ef4444)',    desc: 'Sin comprar hace tiempo. Intentar reactivar.' },
  nuevo:      { label: 'Nuevo',      color: 'var(--muted2,#9ca3af)', desc: 'Aún sin historial suficiente. Conocerlos.' },
};

// ── Render principal ──────────────────────────
async function renderCRM(el) {
  el.innerHTML = `
    <div class="page-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px">
      <div>
        <h1 style="margin:0;display:flex;align-items:center;gap:10px">🧠 CRM Cerebro</h1>
        <div style="font-size:12px;color:var(--muted2);margin-top:4px">Inteligencia offline sobre tus clientes · segmentación calculada con tus ventas</div>
      </div>
      <span style="font-size:11px;color:var(--green,#00c07a);border:1px solid var(--green,#00c07a);border-radius:999px;padding:4px 10px">100% offline</span>
    </div>
    <div id="crm-body"><div style="color:var(--muted2);padding:40px;text-align:center">Analizando clientes…</div></div>`;

  const body = el.querySelector('#crm-body');
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
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 4px;border-bottom:0.5px solid var(--line2,#eee)">
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
      <strong style="color:var(--ink)">Fase 0.</strong> Esta es la base del CRM Cerebro. La Fase 1 añade el scoring RFM+ de 6 ejes
      (margen, tendencia y comportamiento de pago), el panel Cliente 360° y el redactor de mensajes de WhatsApp.
    </div>`;
}
