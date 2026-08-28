'use strict';

const http = require('http');

const MAX_FORM = 16 * 1024;
const STATUS_LABELS = {
  recepcion:'Equipo recibido', inspeccion:'Inspección inicial', diagnostico:'Diagnóstico',
  presupuesto:'Preparando presupuesto', esperando_aprobacion:'Esperando tu aprobación',
  aprobado:'Presupuesto aprobado', esperando_pieza:'Esperando repuesto', reparando:'En reparación',
  control_calidad:'Control de calidad', listo:'Listo para retirar', entregado:'Entregado',
  rechazado:'Presupuesto rechazado', cancelado:'Orden cancelada', no_reparable:'No reparable',
  devuelto_sin_reparar:'Devuelto sin reparar',
};
const PUBLIC_STAGES = [
  { key:'recibido', label:'Equipo recibido y en evaluación', statuses:['recepcion','inspeccion','diagnostico'] },
  { key:'autorizacion', label:'Presupuesto y autorización', statuses:['presupuesto','esperando_aprobacion','aprobado'] },
  { key:'trabajo', label:'Trabajo en proceso', statuses:['esperando_pieza','reparando','control_calidad'] },
  { key:'final', label:'Listo / entregado', statuses:['listo','entregado'] },
];

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(value) {
  return `RD$ ${Number(value || 0).toLocaleString('es-DO', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
}

function dateText(value) {
  if (!value) return 'Pendiente de confirmar';
  const raw = String(value).replace(' ', 'T');
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString('es-DO', { dateStyle:'medium', timeStyle:'short' });
}

function securityHeaders(contentType = 'text/html; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function send(res, status, body, contentType) {
  const payload = Buffer.from(String(body));
  res.writeHead(status, { ...securityHeaders(contentType), 'Content-Length':payload.length });
  res.end(payload);
}

function shell(title, business, content, { print = false } = {}) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>
  :root{color-scheme:light;--navy:#123274;--blue:#3171e8;--ink:#172033;--muted:#667085;--line:#dfe5ee;--soft:#f3f6fa;--ok:#0e8a54;--warn:#b15b00;--red:#be3343}*{box-sizing:border-box}body{margin:0;background:#eef2f6;color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:760px;margin:0 auto;padding:22px 14px 48px}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.brand{display:flex;align-items:center;gap:10px}.logo{width:42px;height:42px;border-radius:12px;background:var(--navy);color:#5aa1ff;display:grid;place-items:center;font-size:24px;font-weight:900}.business{font-size:17px;font-weight:800}.sub,.muted{color:var(--muted);font-size:12px}.secure{font-size:11px;color:var(--ok);font-weight:700}.card{background:white;border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:13px;box-shadow:0 8px 28px rgba(18,50,116,.06)}h1{font-size:25px;margin:0 0 6px}h2{font-size:15px;margin:0 0 12px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#e9f1ff;color:var(--navy);font-size:12px;font-weight:800}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field{background:var(--soft);padding:11px;border-radius:10px}.field span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}.field strong{font-size:13px}.timeline{display:grid;gap:0}.step{display:grid;grid-template-columns:24px 1fr;gap:9px;min-height:44px}.dot{width:14px;height:14px;border-radius:50%;border:2px solid #bdc7d6;margin-top:2px;background:white}.step.done .dot{background:var(--blue);border-color:var(--blue)}.step.current .dot{background:white;border:4px solid var(--blue)}.step:not(:last-child) .dot:after{content:"";display:block;width:2px;height:28px;background:#d6dde8;margin:12px 0 0 4px}.step.done:not(:last-child) .dot:after{background:var(--blue)}.step b{font-size:13px}.step small{display:block;color:var(--muted);margin-top:2px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px 5px;border-bottom:1px solid var(--line);text-align:left}th:last-child,td:last-child{text-align:right}.total{text-align:right;font-size:20px;font-weight:900;margin-top:12px}.notice{padding:12px;border-radius:10px;background:#fff5e8;color:#7a3d00;font-size:12px;margin:12px 0}.success{background:#eaf8f1;color:#07663d}.error{background:#fff0f1;color:#9a2331}.form label{display:block;font-size:12px;font-weight:700;margin:11px 0 5px}.form input[type=text],.form input[type=password]{width:100%;padding:11px;border:1px solid #cbd4e1;border-radius:9px;font:inherit}.choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.choice{padding:11px;border:1px solid var(--line);border-radius:9px}.consent{display:flex!important;gap:8px;align-items:flex-start;font-weight:500!important}.button{display:block;width:100%;padding:12px;border:0;border-radius:10px;background:var(--navy);color:white;font-size:13px;font-weight:800;cursor:pointer;text-align:center;text-decoration:none}.button.secondary{background:white;color:var(--navy);border:1px solid var(--navy);margin-top:8px}.footer{text-align:center;color:var(--muted);font-size:10px;margin-top:22px}.signature{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:65px}.signature div{border-top:1px solid #222;padding-top:5px;text-align:center;font-size:11px}@media(max-width:560px){.grid{grid-template-columns:1fr}.head{align-items:flex-start}.secure{display:none}.card{padding:15px}.choices{grid-template-columns:1fr}}@media print{body{background:white}.wrap{max-width:none;padding:0}.card{box-shadow:none;break-inside:avoid}.no-print{display:none!important}}
  </style></head><body><main class="wrap"><header class="head"><div class="brand"><div class="logo">ϟ</div><div><div class="business">${esc(business.name)}</div><div class="sub">${print ? 'Documento de servicio' : 'Seguimiento de reparación'}</div></div></div><div class="secure">🔒 Enlace privado HTTPS</div></header>${content}<footer class="footer">Este enlace es personal. No lo compartas. VELO nunca solicita tu PIN o contraseña.</footer></main></body></html>`;
}

function timeline(order) {
  const current = order.workflow_status;
  if (['rechazado','cancelado','no_reparable','devuelto_sin_reparar'].includes(current)) {
    return `<div class="notice error"><strong>${esc(STATUS_LABELS[current])}</strong><br>Comunícate con la tienda si necesitas más información.</div>`;
  }
  const index = Math.max(0, PUBLIC_STAGES.findIndex(stage => stage.statuses.includes(current)));
  return `<div class="timeline">${PUBLIC_STAGES.map((stage, i) => `<div class="step ${i < index ? 'done' : i === index ? 'current' : ''}"><div class="dot"></div><div><b>${esc(stage.label)}</b>${i === index ? `<small>${esc(STATUS_LABELS[current] || 'Estado actual')}</small>` : ''}</div></div>`).join('')}</div>`;
}

function itemsTable(order) {
  if (!order.items?.length || !['esperando_aprobacion','aprobado','esperando_pieza','reparando','control_calidad','listo','entregado','rechazado'].includes(order.workflow_status)) return '';
  return `<section class="card"><h2>Presupuesto / trabajo realizado</h2><table><thead><tr><th>Descripción</th><th>Cant.</th><th>Garantía</th><th>Importe</th></tr></thead><tbody>${order.items.map(item => `<tr><td>${esc(item.description)}</td><td>${Number(item.qty)}</td><td>${Number(item.warranty_days||0)} días${item.warranty_until?` · ${esc(item.warranty_until)}`:''}</td><td>${money(Number(item.qty)*Number(item.unit_price))}</td></tr>`).join('')}</tbody></table><div class="total">${money(order.quote_amount)}</div>${Number(order.deposit_total||0)>0?`<div class="muted" style="text-align:right;margin-top:5px">Anticipos: −${money(order.deposit_total)} · Restante: ${money(Math.max(0,Number(order.quote_amount)-Number(order.deposit_total)))}</div>`:''}</section>`;
}

function portalPage(data, basePath, flash = '') {
  const { business, order } = data;
  const form = order.can_decide ? `<section class="card"><h2>Responder al presupuesto</h2><div class="notice">Usa el código de 6 dígitos que la tienda te envió por WhatsApp.</div><form class="form" method="post" action="${esc(basePath)}/decision"><label>Nombre de quien responde</label><input type="text" name="customer_name" maxlength="100" required autocomplete="name"><label>Código de aprobación</label><input type="password" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"><div class="choices"><label class="choice"><input type="radio" name="decision" value="approve" required> Aprobar presupuesto</label><label class="choice"><input type="radio" name="decision" value="reject" required> Rechazar presupuesto</label></div><label class="consent"><input type="checkbox" name="consent" value="yes" required><span>Confirmo que revisé el diagnóstico, las partidas y el importe mostrado.</span></label><button class="button" type="submit">Registrar mi decisión</button></form></section>` : '';
  const documentLink = order.document_available ? `<a class="button secondary no-print" href="${esc(basePath)}/document">Ver documento de entrega y garantía</a>` : '';
  const content = `${flash ? `<div class="notice ${flash.startsWith('✓') ? 'success' : 'error'}">${esc(flash)}</div>` : ''}<section class="card"><span class="badge">${esc(STATUS_LABELS[order.workflow_status] || order.workflow_status)}</span><h1 style="margin-top:12px">${esc(order.number)}</h1><div class="muted">Hola ${esc(order.customer_name)}, aquí puedes consultar el progreso de tu equipo.</div><div class="grid" style="margin-top:15px"><div class="field"><span>Equipo</span><strong>${esc([order.device_desc,order.brand,order.model].filter(Boolean).join(' · '))}</strong></div><div class="field"><span>Identificador</span><strong>${esc(order.identifier_hint || 'No registrado')}</strong></div><div class="field"><span>Fecha prometida</span><strong>${dateText(order.promised_at)}</strong></div><div class="field"><span>Garantía de reparación</span><strong>${order.warranty_until ? `Hasta ${esc(order.warranty_until)}` : `${Number(order.service_warranty_days || 0)} días`}</strong></div>${order.workflow_status==='listo'?`<div class="field"><span>Retirar antes de</span><strong>${dateText(order.pickup_due_at)}</strong></div><div class="field"><span>Avisos de retiro</span><strong>${Number(order.pickup_notice_count||0)}</strong></div>`:''}</div>${documentLink}</section><section class="card"><h2>Progreso</h2>${timeline(order)}</section><section class="card"><h2>Problema reportado</h2><div class="muted">${esc(order.problem)}</div>${order.diagnosis ? `<h2 style="margin-top:16px">Diagnóstico</h2><div class="muted">${esc(order.diagnosis)}</div>` : ''}</section>${itemsTable(order)}${form}`;
  return shell(`${order.number} · Seguimiento`, business, content);
}

function documentPage(data) {
  const { business, order } = data;
  const content = `<section class="card"><h1>Entrega y garantía</h1><div class="muted">Orden ${esc(order.number)}</div><div class="grid" style="margin-top:16px"><div class="field"><span>Cliente</span><strong>${esc(order.customer_name)}</strong></div><div class="field"><span>Equipo</span><strong>${esc([order.device_desc,order.brand,order.model].filter(Boolean).join(' · '))}</strong></div><div class="field"><span>Entregado</span><strong>${dateText(order.delivered_at)}</strong></div><div class="field"><span>Retirado por</span><strong>${esc(order.pickup_person_name||order.customer_name)}${order.pickup_relationship?` · ${esc(order.pickup_relationship)}`:''}</strong></div><div class="field"><span>Garantía hasta</span><strong>${esc(order.warranty_until || 'Ver cobertura por partida')}</strong></div></div></section>${itemsTable(order)}<section class="card"><h2>Condiciones</h2><div class="muted">La garantía cubre únicamente el trabajo y las piezas indicadas en esta orden durante el plazo mostrado para cada partida. No cubre golpes, humedad, manipulación posterior, software de terceros ni fallas distintas a la reparación realizada.</div><div class="signature"><div>Cliente / persona autorizada</div><div>${esc(business.name)}</div></div></section><div class="notice no-print">Para guardar este documento usa la opción Imprimir → Guardar como PDF de tu navegador.</div>`;
  return shell(`${order.number} · Garantía`, business, content, { print:true });
}

function parseRoute(pathname, businessId) {
  const safeBusiness = String(businessId || 'principal');
  const escapedBusiness = safeBusiness.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^/r/${escapedBusiness}/([A-Za-z0-9_-]{20,64}\\.[A-Za-z0-9_-]{32})(?:/(decision|document))?/?$`).exec(pathname);
  if (!match) return null;
  return { token:match[1], action:match[2] || 'view', basePath:`/r/${safeBusiness}/${match[1]}` };
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_FORM) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => tooLarge
      ? reject(new Error('FORM_TOO_LARGE'))
      : resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function createRateLimiter() {
  const buckets = new Map();
  return (key, limit) => {
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      while (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
    }
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count:1, resetAt:now + 15*60*1000 });
      return true;
    }
    current.count++;
    return current.count <= limit;
  };
}

function createServicePortalHandler({ repo, businessId = 'principal' } = {}) {
  if (!repo?.publicLookup || !repo?.publicDecision) throw new Error('Repositorio público de servicio requerido');
  const allow = createRateLimiter();
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok:true, service:'velo-service-portal' }), 'application/json; charset=utf-8');
    }
    const route = parseRoute(url.pathname, businessId);
    if (!route) return send(res, 404, shell('Enlace no disponible', { name:'VELO TECH POS' }, '<section class="card"><h1>Enlace no disponible</h1><div class="muted">Verifica el enlace o solicita uno nuevo a la tienda.</div></section>'));
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rateKey = `${ip}:${route.token.slice(0, 24)}:${req.method}`;
    if (!allow(rateKey, req.method === 'POST' ? 8 : 80)) {
      return send(res, 429, shell('Demasiadas solicitudes', { name:'VELO TECH POS' }, '<section class="card"><h1>Espera unos minutos</h1><div class="muted">Se alcanzó el límite de consultas para este enlace.</div></section>'));
    }
    if (req.method === 'GET' && route.action === 'view') {
      const data = repo.publicLookup(route.token);
      return data ? send(res, 200, portalPage(data, route.basePath)) : send(res, 404, shell('Enlace vencido', { name:'VELO TECH POS' }, '<section class="card"><h1>Enlace vencido o revocado</h1><div class="muted">Solicita un enlace nuevo a la tienda.</div></section>'));
    }
    if (req.method === 'GET' && route.action === 'document') {
      const data = repo.publicLookup(route.token);
      if (!data || !data.order.document_available) return send(res, 404, shell('Documento no disponible', data?.business || { name:'VELO TECH POS' }, '<section class="card"><h1>Documento no disponible</h1></section>'));
      return send(res, 200, documentPage(data));
    }
    if (req.method === 'POST' && route.action === 'decision') {
      const origin = String(req.headers.origin || '');
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch {}
        if (!originHost || originHost !== String(req.headers.host || '')) return send(res, 403, 'Solicitud rechazada', 'text/plain; charset=utf-8');
      }
      let form;
      try { form = await readForm(req); }
      catch { return send(res, 413, 'Solicitud demasiado grande', 'text/plain; charset=utf-8'); }
      try {
        const result = repo.publicDecision(route.token, {
          customer_name:form.get('customer_name'), code:form.get('code'),
          approved:form.get('decision') === 'approve', consent:form.get('consent') === 'yes',
        }, { ip, userAgent:String(req.headers['user-agent'] || '').slice(0, 200) });
        const flash = result.order.workflow_status === 'rechazado'
          ? '✓ Tu rechazo quedó registrado.' : '✓ Tu aprobación quedó registrada.';
        return send(res, 200, portalPage(result.public, route.basePath, flash));
      } catch (error) {
        const data = repo.publicLookup(route.token, { touch:false });
        if (!data) return send(res, 404, 'Enlace no disponible', 'text/plain; charset=utf-8');
        return send(res, 400, portalPage(data, route.basePath, error.message || 'No se pudo registrar la decisión'));
      }
    }
    return send(res, 405, 'Método no permitido', 'text/plain; charset=utf-8');
  };
}

function startServicePortalServer({ repo, businessId = 'principal', host = '127.0.0.1', port = 8787, onLog = () => {} } = {}) {
  const handler = createServicePortalHandler({ repo, businessId });
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
    try { onLog('error', 'portal público falló', { error:error.message }); } catch {}
    if (!res.headersSent) send(res, 500, 'Servicio temporalmente no disponible', 'text/plain; charset=utf-8');
  }));
  server.on('error', error => { try { onLog('error', 'portal público no pudo escuchar', { error:error.message }); } catch {} });
  server.listen(port, host, () => { try { onLog('info', 'portal público iniciado', { host, port }); } catch {} });
  return { server, port, close:() => new Promise(resolve => server.close(resolve)) };
}

module.exports = { createServicePortalHandler, startServicePortalServer, securityHeaders };
