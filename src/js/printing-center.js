// ════════════════════════════════════════════════════════════════════════════
// Centro de impresión VELO
// Política global por documento + impresoras físicas locales por terminal.
// ════════════════════════════════════════════════════════════════════════════

let _pcState = null;
let _pcActiveTab = 'devices';
let _pcTemplateDiagnostics = new Map();

function pcEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function pcParseConfig(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function pcCanUseLabels() {
  if (['admin', 'superadmin'].includes(user?.role)) return true;
  return user?.role === 'cajero'
    && window._bcEnabled
    && String(CFG?.barcode_enabled_roles || 'admin').includes('cajero');
}

function pcDocumentPrinters(printers, settings) {
  return (printers || []).filter(printer => {
    if (!printer?.name || printer.name === settings?.barcode_printer) return false;
    if (typeof detectLabelPrinter !== 'function') return true;
    return !['high', 'medium'].includes(detectLabelPrinter(printer, settings || {}).confidence);
  });
}

function pcLabelPrinters(printers, settings) {
  return (printers || []).filter(printer => {
    if (!printer?.name) return false;
    if (printer.name === settings?.barcode_printer) return true;
    if (typeof detectLabelPrinter !== 'function') return false;
    return ['high', 'medium'].includes(detectLabelPrinter(printer, settings || {}).confidence);
  });
}

function pcConnected(printers, name) {
  return !!name && (printers || []).some(printer => printer.name === name);
}

function pcPrinterConnection(printers, name) {
  const printer = (printers || []).find(item => item.name === name);
  const runtime = printer && typeof getPrinterRuntimeState === 'function'
    ? getPrinterRuntimeState(printer) : null;
  return {
    printer: printer || null,
    connected: !!printer,
    ready: !!printer && !runtime?.reportedIssue,
    runtime,
  };
}

function pcGetBindings(settings, printConfig) {
  const saved = pcParseConfig(settings?.printer_channel_bindings);
  const bindings = {};
  Object.keys(PRINT_CHANNELS).forEach(channel => {
    const hasSaved = Object.prototype.hasOwnProperty.call(saved, channel);
    bindings[channel] = String(hasSaved
      ? (saved[channel] || '')
      : (channel === 'etiquetas' ? settings?.barcode_printer : settings?.printer) || '').trim();
  });
  // Migración silenciosa: una ruta antigua con nombre físico alimenta el canal
  // local solo cuando todavía no existe una asignación explícita.
  Object.entries(printConfig || {}).forEach(([category, config]) => {
    const channel = PRINT_CHANNELS[config?.channel]
      ? config.channel : (_DEFAULT_PRINT_CHANNEL[category] || 'oficina');
    if (!Object.prototype.hasOwnProperty.call(saved, channel) && !bindings[channel] && config?.printer) {
      bindings[channel] = String(config.printer).trim();
    }
  });
  return bindings;
}

function pcGetProfiles(settings) {
  const saved = pcParseConfig(settings?.printer_channel_profiles);
  return Object.fromEntries(Object.keys(PRINT_CHANNELS).map(channel => [
    channel,
    String(Object.prototype.hasOwnProperty.call(saved, channel)
      ? (saved[channel] || '')
      : (channel === 'ventas' ? settings?.printer_profile : '') || '').trim(),
  ]));
}

function pcProfileOptions(current, isLabel) {
  if (isLabel) {
    return `<option value="" ${!current ? 'selected' : ''}>Automático</option>
      <option value="label_2connect_108" ${current === 'label_2connect_108' ? 'selected' : ''}>2Connect · 108 mm</option>
      <option value="label_generic" ${current === 'label_generic' ? 'selected' : ''}>Etiqueta universal</option>`;
  }
  const options = [
    ['', 'Detectar automáticamente'],
    ['ticket_58', 'Ticket térmico · 58 mm'],
    ['ticket_72', 'Ticket térmico · 72 mm'],
    ['ticket_80', 'Ticket térmico · 80 mm'],
    ['continuous_custom', 'Rollo continuo personalizado'],
    ['sheet', 'Carta/A4 · láser o tinta'],
  ];
  return options.map(([id, label]) => `<option value="${id}" ${id === current ? 'selected' : ''}>${label}</option>`).join('');
}

function pcPrinterOptions(current, printers, emptyLabel = 'Sin asignar') {
  return `<option value="">${pcEsc(emptyLabel)}</option>
    ${(printers || []).map(printer => `<option value="${pcEsc(printer.name)}" ${printer.name === current ? 'selected' : ''}>
      ${pcEsc(printer.displayName || printer.name)}${printer.isDefault ? ' · predeterminada del sistema' : ''}
    </option>`).join('')}`;
}

function pcChannelOptions(current) {
  return Object.entries(PRINT_CHANNELS)
    .filter(([, channel]) => channel.accepts === 'document')
    .map(([id, channel]) => `<option value="${id}" ${id === current ? 'selected' : ''}>${pcEsc(channel.label)}</option>`)
    .join('');
}

function pcTemplatesForCategory(category) {
  const definition = PRINT_CATEGORIES[category] || {};
  const all = (typeof PLANTILLAS !== 'undefined' ? PLANTILLAS : [])
    .filter(template => template && template.tipo !== 'etiqueta');
  return definition.media === 'sheet' ? all.filter(template => template.tipo === 'carta') : all;
}

function pcTemplateOptions(category, current) {
  return `<option value="">Usar plantilla general</option>
    ${pcTemplatesForCategory(category).map(template =>
      `<option value="${pcEsc(template.id)}" ${template.id === current ? 'selected' : ''}>${pcEsc(template.nombre)}</option>`
    ).join('')}`;
}

function pcTabs(active = _pcActiveTab) {
  const tabs = [
    ['devices', 'Dispositivos y canales', 'print'],
    ['routes', 'Rutas', 'send'],
    ['labels', 'Etiquetas', 'barcode'],
    ['templates', 'Diagnóstico de plantillas', 'check'],
  ];
  return `<div class="tabs print-center-tabs" style="margin-bottom:16px">
    ${tabs.filter(([id]) => id !== 'labels' || pcCanUseLabels()).map(([id, label, icon]) =>
      `<button class="tab ${active === id ? 'on' : ''}" onclick="pcOpenTab('${id}')">${svg(icon)} ${label}</button>`
    ).join('')}
  </div>`;
}

function pcHeader(subtitle, actions = '') {
  return `<div class="sec-hdr">
    <div><div class="sec-title">Centro de impresión</div><div class="sec-sub">${pcEsc(subtitle)}</div></div>
    <div class="flex" style="gap:8px">${actions}</div>
  </div>${pcTabs()}`;
}

async function renderPrintingCenter(el) {
  const admin = ['admin', 'superadmin'].includes(user?.role);
  if (!admin && !pcCanUseLabels()) {
    renderDash(el);
    return;
  }
  if (!admin) _pcActiveTab = 'labels';

  const root = document.createElement('div');
  root.className = 'module-canvas';
  root.innerHTML = pcHeader('Preparando el entorno de impresión…') +
    `<div class="card" style="padding:28px;text-align:center;color:var(--muted)">${svg('clock')} Cargando…</div>`;
  el.replaceChildren(root);

  if (_pcActiveTab === 'labels') {
    root.innerHTML = pcHeader('Diseña, calibra y produce etiquetas desde el mismo centro.');
    if (!window._bcEnabled) {
      root.innerHTML += `<div class="card" style="padding:30px;text-align:center">
        <div style="width:52px;height:52px;border-radius:12px;background:var(--surface2);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;color:var(--muted)">${svg('barcode')}</div>
        <div class="card-title">Producción de etiquetas desactivada</div>
        <div style="font-size:12px;color:var(--muted2);margin:6px auto 16px;max-width:500px">La herramienta está integrada aquí, pero el módulo debe activarse para seleccionar productos, diseñar y enviar etiquetas.</div>
        ${user?.role === 'superadmin'
          ? `<button class="btn btn-dark" onclick="saToggleBarcodeModule(true).then(()=>pcRefresh())">${svg('check')} Activar etiquetas</button>`
          : `<div style="font-size:11px;color:var(--muted2)">Un Super Admin debe activar este módulo.</div>`}
      </div>`;
      return;
    }
    const host = document.createElement('div');
    host.id = 'pc-label-workspace';
    root.appendChild(host);
    await renderBarcode(host, { embedded: true });
    return;
  }

  const [settings, printers, jobs] = await Promise.all([
    window.api.settings.getAll().catch(() => DB?.settings || {}),
    typeof printerMonitorRefresh === 'function'
      ? printerMonitorRefresh({ reason: 'print-center-open' })
      : window.api.print.getPrinters().catch(() => []),
    window.api.print.getJobs({}).catch(() => []),
  ]);
  if (!document.body.contains(root)) return;

  const documentPrinters = pcDocumentPrinters(printers, settings);
  const labelPrinters = pcLabelPrinters(printers, settings);
  const printConfig = pcParseConfig(settings.print_route_config || settings.print_config);
  const bindings = pcGetBindings(settings, printConfig);
  const profiles = pcGetProfiles(settings);
  _pcState = { root, settings, printers, documentPrinters, labelPrinters, jobs, printConfig, bindings, profiles };

  if (_pcActiveTab === 'routes') pcRenderRoutes();
  else if (_pcActiveTab === 'templates') pcRenderTemplateDiagnostics();
  else pcRenderDevices();
}

function pcOpenTab(tab) {
  _pcActiveTab = tab;
  pcRefresh();
}

function pcGoToPrintingTab(tab) {
  _pcActiveTab = tab;
  window._pcPreserveTabOnce = true;
  routeTo('impresion');
}

function pcRefresh() {
  const pageEl = document.getElementById('page');
  if (pageEl) renderPrintingCenter(pageEl);
}

function pcCaptureLocalAssignments() {
  if (!_pcState?.root) return;
  _pcState.root.querySelectorAll('.pc-binding[data-channel]').forEach(select => {
    _pcState.bindings[select.dataset.channel] = select.value || '';
  });
  _pcState.root.querySelectorAll('.pc-binding-profile[data-channel]').forEach(select => {
    _pcState.profiles[select.dataset.channel] = select.value || '';
  });
}

async function pcDetectNow() {
  pcCaptureLocalAssignments();
  if (typeof printerMonitorRefresh === 'function') {
    const printers = await printerMonitorRefresh({ reason: 'manual', forceEvent: true });
    if (_pcState?.root && document.body.contains(_pcState.root)) {
      _pcState.printers = printers;
      _pcState.documentPrinters = pcDocumentPrinters(printers, _pcState.settings);
      _pcState.labelPrinters = pcLabelPrinters(printers, _pcState.settings);
      if (_pcActiveTab === 'devices') pcRenderDevices();
    }
  } else {
    pcRefresh();
  }
  toast('✓ Lista de impresoras actualizada');
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('velo:printers-changed', event => {
    if (!_pcState?.root || !document.body.contains(_pcState.root) || _pcActiveTab !== 'devices') return;
    pcCaptureLocalAssignments();
    const printers = event.detail?.printers || [];
    _pcState.printers = printers;
    _pcState.documentPrinters = pcDocumentPrinters(printers, _pcState.settings);
    _pcState.labelPrinters = pcLabelPrinters(printers, _pcState.settings);
    pcRenderDevices();
  });
}

function pcRenderDevices() {
  const { root, settings, documentPrinters, labelPrinters, jobs, bindings, profiles } = _pcState;
  const monitorState = typeof printerMonitorGetState === 'function'
    ? printerMonitorGetState() : { error: '', checkedAt: 0 };
  const connectedChannels = Object.entries(PRINT_CHANNELS).filter(([id, channel]) => {
    const pool = channel.accepts === 'label' ? labelPrinters : documentPrinters;
    return pcPrinterConnection(pool, bindings[id]).ready;
  }).length;
  const failures = (jobs || []).filter(job => job.status === 'failed').length;
  const jobRows = (jobs || []).slice(0, 10).map(job => `
    <tr><td>${pcEsc(PRINT_CATEGORIES[_categoryForJobType(job.type)]?.label || job.type || 'Documento')}</td>
      <td>${job.reference_id ? `#${pcEsc(job.reference_id)}` : '—'}</td>
      <td>${pcEsc(job.printer || 'Diálogo del sistema')}</td>
      <td><span class="badge ${job.status === 'success' ? 'g' : 'r'}">${job.status === 'success' ? 'Impreso' : 'Falló'}</span></td>
      <td>${pcEsc(String(job.created_at || '').replace('T', ' ').slice(0, 16))}</td></tr>`).join('');

  const channelCards = Object.entries(PRINT_CHANNELS).map(([id, channel]) => {
    const label = channel.accepts === 'label';
    const printers = label ? labelPrinters : documentPrinters;
    const connection = pcPrinterConnection(printers, bindings[id]);
    const connected = connection.connected;
    const ready = connection.ready;
    const statusLabel = ready ? 'Lista'
      : connected ? 'Incidencia'
        : bindings[id] ? 'No disponible' : 'Sin asignar';
    return `<div class="print-channel-card" data-channel-card="${id}">
      <div class="fxb"><div><strong>${pcEsc(channel.label)}</strong>
        <div style="font-size:10.5px;color:var(--muted2);margin-top:2px">${label ? 'Salida exclusiva de códigos de barras' : 'Asignación local de esta computadora'}</div>
      </div><span class="badge ${ready ? 'g' : connected ? 'o' : bindings[id] ? 'r' : 'n'}">${statusLabel}</span></div>
      ${connection.runtime?.reportedIssue ? `<div style="font-size:10px;color:var(--orange);margin-top:6px">
        ${pcEsc(connection.runtime.stateReason || 'El controlador no acepta trabajos')}
      </div>` : ''}
      <select class="inp pc-binding" data-channel="${id}" style="margin-top:10px">
        ${pcPrinterOptions(bindings[id], printers, label ? 'Seleccionar etiquetadora' : 'Usar diálogo del sistema')}
      </select>
      <select class="inp pc-binding-profile" data-channel="${id}" style="margin-top:7px">
        ${pcProfileOptions(profiles[id] || '', label)}
      </select>
    </div>`;
  }).join('');

  const templates = (typeof PLANTILLAS !== 'undefined' ? PLANTILLAS : []).filter(t => t.tipo !== 'etiqueta');
  root.innerHTML = pcHeader(
    'Las reglas son globales; estas conexiones pertenecen únicamente a esta computadora.',
    `<button class="btn btn-out" onclick="pcDetectNow()">${svg('refresh')} Detectar ahora</button>
     <button class="btn btn-dark" onclick="pcSaveBindings()">${svg('check')} Guardar asignaciones</button>`
  ) + `
    <div class="print-center-stats">
      <div class="print-center-stat"><div class="print-center-stat-label">Impresoras instaladas</div>
        <div class="print-center-stat-value" style="color:${monitorState.error ? 'var(--red)' : 'var(--ink)'}">${_pcState.printers.length}</div>
        <div class="print-center-stat-detail">${monitorState.error ? 'No se pudo consultar el sistema operativo' : 'Monitor automático cada 4 segundos'}</div></div>
      <div class="print-center-stat"><div class="print-center-stat-label">Canales conectados</div>
        <div class="print-center-stat-value">${connectedChannels}/${Object.keys(PRINT_CHANNELS).length}</div><div class="print-center-stat-detail">En esta terminal</div></div>
      <div class="print-center-stat"><div class="print-center-stat-label">Etiquetadoras</div>
        <div class="print-center-stat-value">${labelPrinters.length}</div><div class="print-center-stat-detail">Separadas de documentos</div></div>
      <div class="print-center-stat"><div class="print-center-stat-label">Incidencias recientes</div>
        <div class="print-center-stat-value" style="color:${failures ? 'var(--red)' : 'var(--green)'}">${failures}</div><div class="print-center-stat-detail">Últimos 50 trabajos</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="fxb"><div><div class="card-title">Canales de esta terminal</div>
        <div style="font-size:11px;color:var(--muted2);margin-top:3px">El mismo canal puede apuntar a equipos distintos en cada caja o sucursal.</div>
      </div><button class="btn btn-out" onclick="openPrinterConfig()">${svg('settings')} Perfil avanzado</button></div>
      <div class="print-channel-grid" style="margin-top:13px">${channelCards}</div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Comportamiento general</div>
      <div class="g3" style="margin-top:12px">
        <div class="fg" style="margin-bottom:0"><label class="lbl">Plantilla general</label>
          <select class="inp" id="pc-global-template">${templates.map(template =>
            `<option value="${pcEsc(template.id)}" ${template.id === settings.print_template ? 'selected' : ''}>${pcEsc(template.nombre)}</option>`
          ).join('')}</select></div>
        <div class="fg" style="margin-bottom:0"><label class="lbl">Densidad térmica</label>
          <select class="inp" id="pc-density">
            <option value="normal" ${(settings.thermal_density || 'normal') === 'normal' ? 'selected' : ''}>Normal</option>
            <option value="oscura" ${settings.thermal_density === 'oscura' ? 'selected' : ''}>Oscura</option>
            <option value="maxima" ${settings.thermal_density === 'maxima' ? 'selected' : ''}>Máxima</option>
          </select></div>
        <div class="fg" style="margin-bottom:0"><label class="lbl">Detalle</label>
          <label class="inp" style="display:flex;align-items:center;gap:9px;cursor:pointer">
            <input type="checkbox" id="pc-item-code" ${(settings.print_item_code || '1') !== '0' ? 'checked' : ''}/> Mostrar código del artículo
          </label></div>
      </div>
      <div class="flex" style="justify-content:flex-end;margin-top:12px">
        <button class="btn btn-dark" onclick="pcSaveGeneral()">${svg('check')} Guardar valores generales</button>
      </div>
    </div>

    <div class="card">
      <div class="fxb"><div><div class="card-title">Actividad reciente</div>
        <div style="font-size:11px;color:var(--muted2)">Trazabilidad del spooler de impresión.</div></div>
        <button class="btn btn-out" onclick="testPrint()">${svg('print')} Prueba rápida</button></div>
      ${jobRows ? `<div class="tbl-wrap" style="overflow-x:auto;margin-top:12px"><table class="tbl">
        <thead><tr><th>Tipo</th><th>Referencia</th><th>Impresora</th><th>Estado</th><th>Fecha</th></tr></thead>
        <tbody>${jobRows}</tbody></table></div>` : `<div class="empty-state">Aún no hay trabajos registrados.</div>`}
    </div>`;
}

function pcRenderRoutes() {
  const { root, printConfig, bindings, documentPrinters } = _pcState;
  const rows = Object.entries(PRINT_CATEGORIES).map(([category, definition]) => {
    const config = printConfig[category] || {};
    const channel = PRINT_CHANNELS[config.channel]
      ? config.channel : (_DEFAULT_PRINT_CHANNEL[category] || 'oficina');
    const assigned = bindings[channel] || '';
    const available = pcConnected(documentPrinters, assigned);
    const copies = Math.max(1, Math.min(9, parseInt(config.copies, 10) || 1));
    const preview = config.preview !== undefined ? config.preview === true : definition.previewDefault === true;
    const auto = config.autoPrint !== undefined ? config.autoPrint !== false : definition.autoPrintDefault !== false;
    return `<tr data-category="${category}">
      <td><strong>${pcEsc(definition.label)}</strong><div class="pc-route-status ${available ? 'ok' : ''}">
        ${assigned ? `${available ? '✓' : '⚠'} ${pcEsc(assigned)}` : 'Sin impresora: abrirá el diálogo'}
      </div></td>
      <td><select class="inp pc-route-channel" onchange="pcRouteChannelChanged(this)">${pcChannelOptions(channel)}</select></td>
      <td><select class="inp pc-route-template">${pcTemplateOptions(category, config.template || '')}</select></td>
      <td style="width:80px"><input class="inp pc-route-copies" type="number" min="1" max="9" value="${copies}"/></td>
      <td style="text-align:center"><input class="pc-route-auto" type="checkbox" ${auto ? 'checked' : ''}/></td>
      <td style="text-align:center"><input class="pc-route-preview" type="checkbox" ${preview ? 'checked' : ''}/></td>
    </tr>`;
  }).join('');
  root.innerHTML = pcHeader(
    'Cada documento elige un canal lógico; la terminal resuelve la impresora física.',
    `<button class="btn btn-dark" onclick="pcSaveRoutes()">${svg('check')} Guardar rutas</button>`
  ) + `<div class="card">
    <div class="alrt a" style="margin-bottom:13px"><div><div class="alrt-title">Rutas portables entre sucursales</div>
      <div class="alrt-sub">Aquí nunca se guardan nombres físicos de impresoras. Por eso la misma regla funciona en todas las computadoras.</div></div></div>
    <div class="tbl-wrap" style="overflow-x:auto"><table class="tbl">
      <thead><tr><th>Documento</th><th>Canal</th><th>Plantilla</th><th>Copias</th><th>Automática</th><th>Vista previa</th></tr></thead>
      <tbody id="pc-route-rows">${rows}</tbody>
    </table></div>
    <div style="font-size:10.5px;color:var(--muted2);margin-top:10px">Las reimpresiones siempre abren vista previa. El cobro directo usa estas preferencias sin añadir pasos.</div>
  </div>`;
}

function pcRouteChannelChanged(select) {
  const row = select.closest('tr');
  const status = row?.querySelector('.pc-route-status');
  const printer = _pcState?.bindings?.[select.value] || '';
  const available = pcConnected(_pcState?.documentPrinters, printer);
  if (status) {
    status.className = `pc-route-status ${available ? 'ok' : ''}`;
    status.textContent = printer ? `${available ? '✓' : '⚠'} ${printer}` : 'Sin impresora: abrirá el diálogo';
  }
}

function pcDiagnosticSample() {
  return {
    id: 99999, type: 'factura', date: today(), time: nowt(),
    document_number_fmt: 'FAC-000999', transaction_number: 'FAC-000999',
    customer_name: 'CLIENTE DE PRUEBA VELO', customer_rnc: '101999999',
    customer_address: 'Santo Domingo, República Dominicana', customer_phone: '809-555-0101',
    items: [
      { product_code: 'VELO-001', product_name: 'PRODUCTO DE PRUEBA PRINCIPAL', qty: 2, unit_price: 500, subtotal: 1000, taxable: 1, tax_pct: 18, tax_amt: 152.54, net_subtotal: 847.46 },
      { product_code: 'VELO-002', product_name: 'ARTÍCULO SECUNDARIO CON NOMBRE EXTENSO', qty: 1, unit_price: 180, subtotal: 180, taxable: 1, tax_pct: 18, tax_amt: 27.46, net_subtotal: 152.54 },
    ],
    subtotal: 1000, tax_pct: 18, tax_amt: 180, total: 1180,
    payment_method: 'efectivo', payment_amount: 1180, balance_after_payment: 0,
    cajero: user?.name || 'Administrador', ncf: 'B0200000999',
  };
}

function pcDiagnosticBusiness(settings) {
  return {
    biz_name: settings.biz_name || CFG?.biz || 'NEGOCIO DE PRUEBA VELO',
    biz_rnc: settings.biz_rnc || CFG?.rnc || '101999999',
    biz_addr: settings.biz_addr || CFG?.addr || 'Santo Domingo, República Dominicana',
    biz_phone: settings.biz_phone || CFG?.phone || '809-555-0101',
    biz_email: settings.biz_email || 'info@negocio.do',
    biz_web: settings.biz_web || 'www.negocio.do',
    biz_logo: settings.biz_logo || '',
    biz_logo_2: settings.biz_logo_2 || '',
    receipt_msg: settings.receipt_msg || 'Gracias por su compra',
    print_item_code: settings.print_item_code || '1',
    logo_size: settings.logo_size || 'mediano',
    invoice_notes: settings.invoice_notes || '',
    bank_accounts: [],
  };
}

function pcAnalyzeTemplate(template) {
  const checks = [];
  let html = '';
  const add = (level, label, detail) => checks.push({ level, label, detail });
  try {
    html = template.render(pcDiagnosticSample(), pcDiagnosticBusiness(_pcState.settings), template.opciones || {});
  } catch (error) {
    add('error', 'Renderizado', error?.message || 'La plantilla produjo un error');
    return { template, html: '', checks, status: 'error' };
  }
  const raw = String(html || '');
  const visible = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  add(visible.length > 80 ? 'ok' : 'error', 'Contenido visible', visible.length > 80 ? `${visible.length} caracteres renderizados` : 'El documento está vacío o incompleto');
  add(/PRODUCTO DE PRUEBA|ARTÍCULO SECUNDARIO/i.test(visible) ? 'ok' : 'error', 'Detalle de productos',
    /PRODUCTO DE PRUEBA|ARTÍCULO SECUNDARIO/i.test(visible) ? 'Las líneas de venta aparecen' : 'No se encontraron los productos de prueba');
  add(/1[,.]180|1180/.test(visible) ? 'ok' : 'warning', 'Total', /1[,.]180|1180/.test(visible) ? 'El total está visible' : 'No se reconoció el total RD$1,180.00');
  add(!/{{[^}]+}}|undefined|null null/i.test(raw) ? 'ok' : 'error', 'Variables', !/{{[^}]+}}|undefined|null null/i.test(raw) ? 'Sin campos sin resolver' : 'Hay variables o valores sin resolver');
  add(!/<script[^>]+src=["']https?:/i.test(raw) ? 'ok' : 'error', 'Funcionamiento offline',
    !/<script[^>]+src=["']https?:/i.test(raw) ? 'No depende de scripts externos' : 'Depende de recursos externos');
  const sheet = template.tipo === 'carta';
  const hasPageRule = /@page\s*{[\s\S]{0,320}?\bsize\s*:/i.test(raw)
    || /\b(?:width|max-width)\s*:\s*\d+(?:\.\d+)?mm/i.test(raw);
  add(hasPageRule ? 'ok' : 'warning', 'Tamaño de papel',
    hasPageRule ? `Regla de papel detectada para ${sheet ? 'hoja' : template.tipo}` : 'No declara explícitamente el tamaño de página');
  const status = checks.some(check => check.level === 'error') ? 'error'
    : checks.some(check => check.level === 'warning') ? 'warning' : 'ok';
  return { template, html: raw, checks, status };
}

function pcRenderTemplateDiagnostics() {
  const { root, bindings } = _pcState;
  const templates = (typeof PLANTILLAS !== 'undefined' ? PLANTILLAS : []).filter(t => t.tipo !== 'etiqueta');
  _pcTemplateDiagnostics = new Map(templates.map(template => [template.id, pcAnalyzeTemplate(template)]));
  const first = _pcState.settings.print_template && _pcTemplateDiagnostics.has(_pcState.settings.print_template)
    ? _pcState.settings.print_template : templates[0]?.id;
  const summary = { ok: 0, warning: 0, error: 0 };
  _pcTemplateDiagnostics.forEach(result => { summary[result.status] += 1; });
  root.innerHTML = pcHeader(
    'Comprueba contenido, papel, compatibilidad, desbordes y funcionamiento offline antes de llegar al cliente.',
    `<button class="btn btn-out" onclick="pcRenderTemplateDiagnostics()">${svg('refresh')} Ejecutar de nuevo</button>`
  ) + `
    <div class="print-center-stats">
      <div class="print-center-stat"><div class="print-center-stat-label">Plantillas</div><div class="print-center-stat-value">${templates.length}</div><div class="print-center-stat-detail">Analizadas</div></div>
      <div class="print-center-stat"><div class="print-center-stat-label">Correctas</div><div class="print-center-stat-value" style="color:var(--green)">${summary.ok}</div><div class="print-center-stat-detail">Sin observaciones</div></div>
      <div class="print-center-stat"><div class="print-center-stat-label">Advertencias</div><div class="print-center-stat-value" style="color:var(--amber)">${summary.warning}</div><div class="print-center-stat-detail">Requieren revisión visual</div></div>
      <div class="print-center-stat"><div class="print-center-stat-label">Errores</div><div class="print-center-stat-value" style="color:var(--red)">${summary.error}</div><div class="print-center-stat-detail">Bloquean una prueba segura</div></div>
    </div>
    <div class="print-diagnostic-layout">
      <div class="card print-diagnostic-list">
        <div class="card-title mb8">Plantillas disponibles</div>
        ${templates.map(template => {
          const result = _pcTemplateDiagnostics.get(template.id);
          return `<button class="print-template-row ${template.id === first ? 'on' : ''}" data-template="${pcEsc(template.id)}"
            onclick="pcShowTemplateDiagnostic('${pcEsc(template.id)}')">
            <span>${template.icono || '🧾'}</span><span><strong>${pcEsc(template.nombre)}</strong><small>${pcEsc(template.tipo)}</small></span>
            <span class="badge ${result.status === 'ok' ? 'g' : result.status === 'warning' ? 'o' : 'r'}">${result.status === 'ok' ? 'OK' : result.status === 'warning' ? 'Revisar' : 'Error'}</span>
          </button>`;
        }).join('')}
      </div>
      <div id="pc-diagnostic-detail"></div>
    </div>`;
  pcShowTemplateDiagnostic(first);
}

function pcShowTemplateDiagnostic(templateId) {
  const result = _pcTemplateDiagnostics.get(templateId);
  const host = document.getElementById('pc-diagnostic-detail');
  if (!result || !host) return;
  document.querySelectorAll('.print-template-row').forEach(row => row.classList.toggle('on', row.dataset.template === templateId));
  const defaultChannel = result.template.tipo === 'carta' ? 'oficina' : 'ventas';
  host.innerHTML = `<div class="card">
    <div class="fxb"><div><div class="card-title">${pcEsc(result.template.nombre)}</div>
      <div style="font-size:11px;color:var(--muted2)">${pcEsc(result.template.desc || '')}</div></div>
      <span class="badge ${result.status === 'ok' ? 'g' : result.status === 'warning' ? 'o' : 'r'}">${result.status === 'ok' ? 'Correcta' : result.status === 'warning' ? 'Con advertencias' : 'Con errores'}</span></div>
    <div class="g2" style="margin:12px 0">
      <div class="fg" style="margin:0"><label class="lbl">Probar mediante el canal</label>
        <select class="inp" id="pc-diagnostic-channel" onchange="pcUpdateTemplateCompatibility('${pcEsc(templateId)}')">${pcChannelOptions(defaultChannel)}</select></div>
      <div id="pc-template-compatibility"></div>
    </div>
    <div class="print-check-grid">${result.checks.map(check => `<div class="print-check ${check.level}">
      <span>${check.level === 'ok' ? '✓' : check.level === 'warning' ? '!' : '×'}</span>
      <div><strong>${pcEsc(check.label)}</strong><small>${pcEsc(check.detail)}</small></div></div>`).join('')}</div>
    <div id="pc-overflow-result" class="print-check warning" style="display:none;margin-top:8px"></div>
    <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;margin-top:12px">
      <iframe id="pc-template-frame" title="Vista previa ${pcEsc(result.template.nombre)}"
        onload="pcMeasureTemplatePreview(this,'${pcEsc(templateId)}')"
        style="width:100%;height:min(62vh,650px);border:0;display:block;background:#fff"></iframe>
    </div>
    <div class="flex" style="justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn btn-out" onclick="pcSetGlobalTemplate('${pcEsc(templateId)}')">${svg('check')} Usar como general</button>
      <button class="btn btn-dark" ${result.status === 'error' ? 'disabled' : ''} onclick="pcPrintTemplateTest('${pcEsc(templateId)}')">${svg('print')} Prueba de impresión</button>
    </div>
  </div>`;
  const frame = document.getElementById('pc-template-frame');
  if (frame) frame.srcdoc = typeof _htmlForPreview === 'function' ? _htmlForPreview(result.html) : result.html;
  pcUpdateTemplateCompatibility(templateId);
}

function pcUpdateTemplateCompatibility(templateId) {
  const result = _pcTemplateDiagnostics.get(templateId);
  const host = document.getElementById('pc-template-compatibility');
  const channel = document.getElementById('pc-diagnostic-channel')?.value || 'ventas';
  if (!result || !host) return;
  const printer = _pcState.bindings[channel] || '';
  let compatible = true;
  let profileLabel = 'Diálogo del sistema';
  if (printer && typeof resolvePrinterProfile === 'function') {
    const profile = resolvePrinterProfile(printer, 'ticket', {
      ..._pcState.settings,
      printer_profile: _pcState.profiles?.[channel] || '',
    });
    const isSheet = profile?.kind === 'sheet';
    compatible = result.template.tipo === 'carta' ? isSheet : !isSheet;
    profileLabel = `${printer} · ${profile?.label || profile?.kind || 'perfil automático'}`;
  }
  host.innerHTML = `<label class="lbl">Compatibilidad</label><div class="inp" style="height:auto;min-height:38px;color:${compatible ? 'var(--green)' : 'var(--red)'}">
    <strong>${compatible ? '✓ Compatible' : '⚠ Papel incompatible'}</strong>
    <div style="font-size:10px;color:var(--muted2);margin-top:2px">${pcEsc(profileLabel)}</div></div>`;
}

function pcMeasureTemplatePreview(frame) {
  const host = document.getElementById('pc-overflow-result');
  if (!host) return;
  try {
    const body = frame.contentDocument?.body;
    const doc = frame.contentDocument?.documentElement;
    const overflow = Math.max(body?.scrollWidth || 0, doc?.scrollWidth || 0) > (frame.clientWidth + 8);
    host.style.display = 'flex';
    host.className = `print-check ${overflow ? 'warning' : 'ok'}`;
    host.innerHTML = `<span>${overflow ? '!' : '✓'}</span><div><strong>Desborde horizontal</strong>
      <small>${overflow ? 'La vista previa excede el ancho disponible; revisa márgenes y papel.' : 'No se detectó contenido recortado horizontalmente.'}</small></div>`;
  } catch {
    host.style.display = 'none';
  }
}

async function pcSetGlobalTemplate(templateId) {
  const result = await window.api.settings.set({ key: 'print_template', value: templateId, requestUserId: user?.id });
  if (!result?.ok) return toast(result?.error || 'No se pudo guardar la plantilla', 'err');
  if (DB?.settings) DB.settings.print_template = templateId;
  _pcState.settings.print_template = templateId;
  toast('✓ Plantilla general actualizada');
}

function pcPrintTemplateTest(templateId) {
  const result = _pcTemplateDiagnostics.get(templateId);
  if (!result?.html || result.status === 'error') return toast('Corrige los errores de la plantilla antes de imprimir', 'err');
  const channel = document.getElementById('pc-diagnostic-channel')?.value || 'ventas';
  _openPrintWindow(result.html, 'prueba_plantilla', Date.now(), false, {
    printerName: _pcState.bindings[channel] || '',
    profileId: _pcState.profiles?.[channel] || '',
    templateId,
    preview: true,
  });
}

function pcOpenLabelDesigner() {
  if (!['admin', 'superadmin'].includes(user?.role)) {
    toast('Solo un administrador puede modificar el diseño de etiquetas', 'w');
    return;
  }
  openModal(`
    <div class="modal-title">Diseñador de etiquetas</div>
    <div class="modal-sub">Diseño, medidas, calibración y prueba física dentro del Centro de impresión.</div>
    <div id="pc-label-designer-host"></div>
    <div class="modal-foot"><button class="btn btn-out" onclick="closeModal()">Cerrar</button></div>
  `, 'modal-xl');
  const host = document.getElementById('pc-label-designer-host');
  if (host && typeof renderBarcodeDesigner === 'function') {
    renderBarcodeDesigner(host, { embedded: true });
  }
}

async function pcSaveBindings() {
  const bindings = {};
  const profiles = {};
  _pcState.root.querySelectorAll('.pc-binding[data-channel]').forEach(select => {
    bindings[select.dataset.channel] = select.value || '';
  });
  _pcState.root.querySelectorAll('.pc-binding-profile[data-channel]').forEach(select => {
    profiles[select.dataset.channel] = select.value || '';
  });
  const values = [
    window.api.settings.set({
      key: 'printer_channel_bindings',
      value: JSON.stringify(bindings),
      requestUserId: user?.id,
    }),
    window.api.settings.set({
      key: 'printer_channel_profiles',
      value: JSON.stringify(profiles),
      requestUserId: user?.id,
    }),
    window.api.settings.set({
      key: 'barcode_printer',
      value: bindings.etiquetas || '',
      requestUserId: user?.id,
    }),
    window.api.settings.set({
      key: 'barcode_printer_profile',
      value: profiles.etiquetas || '',
      requestUserId: user?.id,
    }),
    window.api.settings.set({
      key: 'printer_profile',
      value: profiles.ventas || '',
      requestUserId: user?.id,
    }),
  ];
  // Compatibilidad con módulos antiguos: la impresora general sigue al canal de ventas.
  values.push(window.api.print.savePrinter({ printerName: bindings.ventas || '', requestUserId: user?.id }));
  const results = await Promise.all(values);
  const failed = results.find(result => !result?.ok);
  if (failed) return toast(failed.error || 'No se pudieron guardar las asignaciones', 'err');
  const raw = JSON.stringify(bindings);
  const profileRaw = JSON.stringify(profiles);
  _pcState.bindings = bindings;
  _pcState.profiles = profiles;
  _pcState.settings.printer_channel_bindings = raw;
  _pcState.settings.printer_channel_profiles = profileRaw;
  Object.assign(DB.settings, {
    printer_channel_bindings: raw,
    printer_channel_profiles: profileRaw,
    printer: bindings.ventas || '',
    barcode_printer: bindings.etiquetas || '',
    printer_profile: profiles.ventas || '',
    barcode_printer_profile: profiles.etiquetas || '',
  });
  toast('✓ Canales guardados para esta terminal');
  pcRefresh();
}

async function pcSaveGeneral() {
  const values = {
    print_template: document.getElementById('pc-global-template')?.value || '',
    thermal_density: document.getElementById('pc-density')?.value || 'normal',
    print_item_code: document.getElementById('pc-item-code')?.checked ? '1' : '0',
  };
  const results = await Promise.all(Object.entries(values).map(([key, value]) =>
    window.api.settings.set({ key, value, requestUserId: user?.id })));
  const failed = results.find(result => !result?.ok);
  if (failed) return toast(failed.error || 'No se pudo guardar la configuración', 'err');
  Object.assign(_pcState.settings, values);
  if (DB?.settings) Object.assign(DB.settings, values);
  toast('✓ Valores generales guardados');
}

async function pcSaveRoutes() {
  const next = {};
  _pcState.root.querySelectorAll('#pc-route-rows tr[data-category]').forEach(row => {
    next[row.dataset.category] = {
      channel: row.querySelector('.pc-route-channel')?.value || _DEFAULT_PRINT_CHANNEL[row.dataset.category] || 'oficina',
      template: row.querySelector('.pc-route-template')?.value || '',
      copies: Math.max(1, Math.min(9, parseInt(row.querySelector('.pc-route-copies')?.value, 10) || 1)),
      autoPrint: !!row.querySelector('.pc-route-auto')?.checked,
      preview: !!row.querySelector('.pc-route-preview')?.checked,
    };
  });
  const result = await window.api.print.saveConfig({ config: next, requestUserId: user?.id });
  if (!result?.ok) return toast(result?.error || 'No se pudieron guardar las rutas', 'err');
  const raw = JSON.stringify(next);
  _pcState.printConfig = next;
  _pcState.settings.print_route_config = raw;
  if (DB?.settings) DB.settings.print_route_config = raw;
  toast('✓ Rutas globales guardadas');
  pcRefresh();
}
