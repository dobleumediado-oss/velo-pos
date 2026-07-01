// ══════════════════════════════════════════════
// config.js — Módulo de Configuración
// ══════════════════════════════════════════════

// Usuario actual. Antes varias acciones (guardar usuario, backup, categorías)
// usaban `user` sin definirlo → ReferenceError que dejaba los botones sin efecto.
function _cfgUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}

async function renderConfiguracion(el) {
  el.innerHTML = '';

  // ── Cargar datos necesarios ─────────────────
  const settings    = await window.api.settings.getAll();
  const versionInfo = await window.api.version.getInfo().catch(() => ({ ok: false }));
  const info        = versionInfo.ok ? versionInfo.data : {};
  const licResult   = await window.api.license.getStatus().catch(() => ({ ok: false }));
  const lic         = licResult.ok ? licResult.data : null;
  const isSA        = user?.role === 'superadmin';

  // ── Header ──────────────────────────────────
  el.appendChild(h('div', { class: 'sec-hdr' },
    h('div', null,
      h('div', { class: 'sec-title' }, 'Configuración'),
      h('div', { class: 'sec-sub' }, `Velo POS v${info.appVersion || window._appVersion || '1.5.5'}`)
    ),
    h('button', {
      class: 'btn btn-green',
      onclick: guardarConfiguracion,
      html: `${svg('check')} Guardar cambios`
    })
  ));

  // ── Columnas ─────────────────────────────────
  const colLeft  = h('div', { style: 'display:flex;flex-direction:column;gap:16px;min-width:0' });
  const colRight = h('div', { style: 'display:flex;flex-direction:column;gap:16px;width:400px;flex-shrink:0' });
  const grid     = h('div', { style: 'display:grid;grid-template-columns:1fr 400px;gap:20px;align-items:start' });

  // ══════════════════════
  // COLUMNA IZQUIERDA
  // ══════════════════════

  // ══════════════════════════════════════════════
  // PLANTILLAS DE IMPRESIÓN
  // Un solo estado: window._PA (plantilla activa)
  // Fuente de verdad: DB.settings.print_template
  // ══════════════════════════════════════════════

  // Variables de impresora — necesarias en todo el bloque
  const printerSaved  = settings?.printer || '';
  const printerType   = detectPrinterType(printerSaved);

  // Estado global de plantillas — siempre desde DB
  window._PA = settings?.print_template || 'termica_80_clasica';
  window._PT = window._PA.startsWith('carta') || window._PA === 'media_carta'
    ? 'carta' : 'termica';

  // ── Helpers ──────────────────────────────────
  function _getEstilos(id) {
    try { return JSON.parse(DB?.settings?.[`template_opts_${id}`] || '{}'); }
    catch { return {}; }
  }

  function _buildCard(p) {
    const isActive = window._PA === p.id;
    const card = document.createElement('div');
    card.id = `plc-${p.id}`;
    card.style.cssText = `
      border: 2px solid ${isActive ? 'var(--green)' : 'var(--line)'};
      border-radius: 10px; padding: 10px 12px; cursor: pointer;
      background: ${isActive ? 'var(--green-bg)' : 'var(--surface)'};
      display: flex; align-items: center; gap: 10px;
      transition: border-color .12s, background .12s;
    `;
    card.innerHTML = `
      <div style="font-size:20px;flex-shrink:0">${p.icono}</div>
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${p.nombre}
        </div>
        <div style="font-size:10px;color:var(--muted2);margin-top:1px">${p.tipo==='carta'?'Carta/A4':p.tipo}</div>
        <div class="plc-tick" style="font-size:10px;font-weight:700;color:var(--green);margin-top:2px;display:${isActive?'block':'none'}">✓ Activa</div>
      </div>
    `;
    card.addEventListener('click', () => _selectPlantilla(p.id));
    return card;
  }

  function _renderGrid() {
    const grid = document.getElementById('plt-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const tab     = window._PT;
    const plantas = (typeof PLANTILLAS !== 'undefined' ? PLANTILLAS : [])
      .filter(p => tab === 'carta' ? p.tipo === 'carta' : p.tipo !== 'carta');
    plantas.forEach(p => grid.appendChild(_buildCard(p)));
    // Actualizar estado de tabs
    const tT = document.getElementById('plt-tab-t');
    const tC = document.getElementById('plt-tab-c');
    if (tT) { tT.style.background = tab==='termica'?'var(--ink)':'transparent'; tT.style.color = tab==='termica'?'#fff':'var(--muted)'; }
    if (tC) { tC.style.background = tab==='carta'?'var(--ink)':'transparent'; tC.style.color = tab==='carta'?'#fff':'var(--muted)'; }
  }

  function _selectPlantilla(id) {
    window._PA = id;
    // Guardar en DB
    window.api.settings.set({ key: 'print_template', value: id, requestUserId: user?.id });
    if (typeof DB !== 'undefined' && DB.settings) DB.settings.print_template = id;
    // Actualizar visualmente todas las cards
    document.querySelectorAll('[id^="plc-"]').forEach(el => {
      const pid = el.id.replace('plc-','');
      const on  = pid === id;
      el.style.border     = `2px solid ${on?'var(--green)':'var(--line)'}`;
      el.style.background = on ? 'var(--green-bg)' : 'var(--surface)';
      const tick = el.querySelector('.plc-tick');
      if (tick) tick.style.display = on ? 'block' : 'none';
    });
    // Toast y preview automático
    const nombre = (typeof PLANTILLAS !== 'undefined'
      ? PLANTILLAS.find(p=>p.id===id)?.nombre : null) || id;
    toast(`✓ Plantilla "${nombre}" seleccionada`);
    _renderPreview(id);
    // Si el modal está abierto actualizar su preview también
    window._modalPreviewFn?.();
  }

  function _renderPreview(id) {
    const wrap   = document.getElementById('plt-preview-wrap');
    const iframe = document.getElementById('plt-iframe');
    const label  = document.getElementById('plt-preview-label');
    if (!wrap || !iframe) return;
    const plantilla = typeof PLANTILLAS !== 'undefined'
      ? PLANTILLAS.find(p=>p.id===id) : null;
    if (!plantilla) return;
    const cfg2 = {
      biz_name: CFG.biz||'Mi Negocio', biz_rnc: CFG.rnc||'',
      biz_addr: CFG.addr||'', biz_phone: CFG.phone||'',
      receipt_msg: CFG.receiptMsg||'¡Gracias por su compra!', biz_logo: CFG.biz_logo||'',
    };
    const opts = { ...plantilla.opciones, _estilos: _getEstilos(id) };
    if (label) label.textContent = `VISTA PREVIA — ${plantilla.nombre}`;
    iframe.srcdoc = plantilla.render(getSampleSale(cfg2), cfg2, opts);
    wrap.style.display = 'block';
  }

  // ── Construir la card de plantillas ──────────
  const plantCard = h('div', { class: 'card' });

  // Header
  const pHdr = h('div', { class: 'fxb mb8' });
  pHdr.appendChild(h('div', { class: 'card-title' }, 'Plantillas de Impresión'));
  const pBadge = h('span', { class: 'badge b', style: 'font-size:11px' },
    printerType==='58mm'?'Térmica 58mm':printerType==='80mm'?'Térmica 80mm':printerType==='carta'?'Carta/A4':'Auto');
  pHdr.appendChild(pBadge);
  plantCard.appendChild(pHdr);

  // Alerta impresora
  const pAlert = h('div', { class: 'alrt b', style: 'margin-bottom:12px' });
  pAlert.innerHTML = `
    <div class="alrt-dot b"></div>
    <div>
      <div class="alrt-title">Impresora: ${printerSaved||'No configurada'}</div>
      <div class="alrt-sub">Tipo detectado: ${
        printerType==='58mm'?'Térmica 58mm':
        printerType==='80mm'?'Térmica 80mm':
        printerType==='carta'?'Carta / A4':'No reconocida — usando 80mm por defecto'
      }</div>
    </div>`;
  plantCard.appendChild(pAlert);

  // Tabs
  const pTabs = h('div', {
    style: 'display:flex;gap:4px;margin-bottom:10px;background:var(--surface2);border:1px solid var(--line);border-radius:6px;padding:3px;width:fit-content'
  });
  const mkTab = (id, label, tipo) => {
    const isOn = window._PT === tipo;
    const btn = h('button', {
      id,
      style: `padding:5px 14px;border-radius:4px;border:none;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;transition:.12s;background:${isOn?'var(--ink)':'transparent'};color:${isOn?'#fff':'var(--muted)'}`,
      onclick: () => { window._PT = tipo; _renderGrid(); }
    }, label);
    return btn;
  };
  pTabs.appendChild(mkTab('plt-tab-t', '🖨️ Térmicas', 'termica'));
  pTabs.appendChild(mkTab('plt-tab-c', '📄 Carta / A4', 'carta'));
  plantCard.appendChild(pTabs);

  // Grid de plantillas
  const pGrid = h('div', { id: 'plt-grid', style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:14px' });
  plantCard.appendChild(pGrid);

  // Botones de acción
  const pBtns = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0' });

  const btnPrev = h('button', { class: 'btn btn-dark', onclick: () => _renderPreview(window._PA) });
  btnPrev.innerHTML = `${svg('eye')} Vista previa`;
  pBtns.appendChild(btnPrev);

  const btnPrint = h('button', { class: 'btn btn-out', onclick: () => {
    const plantilla = typeof PLANTILLAS!=='undefined'?PLANTILLAS.find(p=>p.id===window._PA):null;
    if (!plantilla) { toast('Selecciona una plantilla primero','w'); return; }
    const cfg2 = { biz_name:CFG.biz||'Mi Negocio', biz_rnc:CFG.rnc||'', biz_addr:CFG.addr||'', biz_phone:CFG.phone||'', receipt_msg:CFG.receiptMsg||'¡Gracias por su compra!', biz_logo:CFG.biz_logo||'' };
    const html = plantilla.render(getSampleSale(cfg2), cfg2, {...plantilla.opciones,_estilos:_getEstilos(window._PA)});
    _openPrintWindow(html, 'prueba_plantilla', 0, false);
  }});
  btnPrint.innerHTML = `${svg('print')} Imprimir prueba`;
  pBtns.appendChild(btnPrint);

  if (isSA) {
    const btnEdit = h('button', {
      class: 'btn btn-out',
      style: 'color:var(--purple);border-color:var(--purple-line)',
      onclick: () => _abrirModalEstilos()
    });
    btnEdit.innerHTML = '✏️ Personalizar plantilla';
    pBtns.appendChild(btnEdit);
  }
  plantCard.appendChild(pBtns);

  // Zona de preview
  const pPrevWrap = h('div', { id: 'plt-preview-wrap', style: 'display:none;margin-top:14px' });
  const pPrevLbl  = h('div', { id: 'plt-preview-label', style: 'font-size:11px;font-weight:700;margin-bottom:6px;color:var(--muted);letter-spacing:.04em' }, '');
  const pIframe   = h('iframe', { id: 'plt-iframe', style: 'width:100%;height:420px;border:1px solid var(--line);border-radius:8px;background:#fff' });
  pPrevWrap.appendChild(pPrevLbl);
  pPrevWrap.appendChild(pIframe);
  plantCard.appendChild(pPrevWrap);

  colLeft.appendChild(plantCard);

  // Inicializar grid y preview automático
  setTimeout(() => {
    _renderGrid();
    _renderPreview(window._PA);
  }, 60);

  // ══════════════════════════════════════════════
  // MODAL PERSONALIZAR (solo superadmin)
  // ══════════════════════════════════════════════

  function _abrirModalEstilos() {
    const id       = window._PA;
    const plantilla = typeof PLANTILLAS !== 'undefined' ? PLANTILLAS.find(p=>p.id===id) : null;
    if (!plantilla) { toast('Selecciona primero una plantilla', 'w'); return; }

    const isTermica = plantilla.tipo !== 'carta';
    const saved     = _getEstilos(id);
    const def       = isTermica
      ? { fontSize:'11.5px', lineHeight:'1.45', marginTop:'2mm', marginBottom:'4mm', marginLeft:'2mm', marginRight:'2mm' }
      : { fontSize:'11pt',   lineHeight:'1.5',  marginTop:'15mm', marginBottom:'15mm', marginLeft:'20mm', marginRight:'20mm' };
    const cur = { ...def, ...saved };

    const ov = document.createElement('div');
    ov.id = 'modal-estilos-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(13,15,18,.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)';
    ov.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.15)">
        <div style="font-weight:800;font-size:16px;margin-bottom:3px">✏️ Personalizar — ${plantilla.nombre}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:20px">Los cambios se aplican al imprimir. Solo superadmin puede modificar esto.</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-bottom:14px">
          <div class="fg">
            <label class="lbl">Tamaño de letra</label>
            <select class="inp" id="est-fontSize">
              ${(isTermica
                ? ['9px','9.5px','10px','10.5px','11px','11.5px','12px','12.5px','13px']
                : ['8pt','9pt','9.5pt','10pt','10.5pt','11pt','11.5pt','12pt','13pt'])
                .map(v=>`<option value="${v}" ${cur.fontSize===v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="fg">
            <label class="lbl">Altura de línea</label>
            <select class="inp" id="est-lineHeight">
              ${['1.2','1.25','1.3','1.35','1.4','1.45','1.5','1.6','1.7','1.8']
                .map(v=>`<option value="${v}" ${cur.lineHeight===v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="fg">
            <label class="lbl">Margen superior</label>
            <input class="inp" id="est-marginTop" value="${cur.marginTop}" placeholder="${isTermica?'ej: 2mm':'ej: 15mm'}"/>
          </div>
          <div class="fg">
            <label class="lbl">Margen inferior</label>
            <input class="inp" id="est-marginBottom" value="${cur.marginBottom}" placeholder="${isTermica?'ej: 4mm':'ej: 15mm'}"/>
          </div>
          <div class="fg">
            <label class="lbl">Margen izquierdo</label>
            <input class="inp" id="est-marginLeft" value="${cur.marginLeft}" placeholder="${isTermica?'ej: 2mm':'ej: 20mm'}"/>
          </div>
          <div class="fg">
            <label class="lbl">Margen derecho</label>
            <input class="inp" id="est-marginRight" value="${cur.marginRight}" placeholder="${isTermica?'ej: 2mm':'ej: 20mm'}"/>
          </div>
        </div>

        <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--line);border-radius:6px;padding:9px 12px;margin-bottom:14px">
          Usa <strong>mm</strong> para térmicas y <strong>mm o pt</strong> para carta.
          Los cambios se reflejan en el preview en tiempo real ↓
        </div>

        <!-- Preview en tiempo real -->
        <div style="margin-bottom:16px">
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-bottom:6px">Vista previa en tiempo real</div>
          <iframe id="modal-iframe" style="width:100%;height:${isTermica?'320px':'280px'};border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
        </div>

        <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;padding-top:14px;border-top:1px solid var(--line)">
          <button id="btn-reset-estilos" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--muted);font-family:inherit;padding:6px 8px;border-radius:6px">
            ↺ Restablecer defaults
          </button>
          <div style="display:flex;gap:8px">
            <button class="btn btn-out" id="btn-cancel-estilos">Cancelar</button>
            <button class="btn btn-dark" id="btn-save-estilos">✓ Guardar y aplicar</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(ov);
    const cerrarEstilos = () => {
      document.getElementById('modal-estilos-ov')?.remove();
      window._modalPreviewFn = null;
    };
    ov.addEventListener('click', e => { if (e.target===ov) cerrarEstilos(); });
    ov.querySelector('#btn-cancel-estilos')?.addEventListener('click', cerrarEstilos);
    ov.querySelector('#btn-reset-estilos')?.addEventListener('click', () => _resetEstilos(id));
    ov.querySelector('#btn-reset-estilos')?.addEventListener('mouseenter', e => { e.currentTarget.style.background = 'var(--surface2)'; });
    ov.querySelector('#btn-reset-estilos')?.addEventListener('mouseleave', e => { e.currentTarget.style.background = 'none'; });
    ov.querySelector('#btn-save-estilos')?.addEventListener('click', () => _guardarEstilos(id));

    // Preview en tiempo real
    const _mRender = () => {
      const mIframe = document.getElementById('modal-iframe');
      if (!mIframe || !plantilla) return;
      const cfg2 = { biz_name:CFG.biz||'Mi Negocio', biz_rnc:CFG.rnc||'', biz_addr:CFG.addr||'Calle Principal #1', biz_phone:CFG.phone||'809-000-0000', receipt_msg:CFG.receiptMsg||'¡Gracias por su compra!', biz_logo:CFG.biz_logo||'' };
      const estilos = {
        fontSize:     document.getElementById('est-fontSize')?.value,
        lineHeight:   document.getElementById('est-lineHeight')?.value,
        marginTop:    document.getElementById('est-marginTop')?.value?.trim(),
        marginBottom: document.getElementById('est-marginBottom')?.value?.trim(),
        marginLeft:   document.getElementById('est-marginLeft')?.value?.trim(),
        marginRight:  document.getElementById('est-marginRight')?.value?.trim(),
      };
      mIframe.srcdoc = plantilla.render(getSampleSale(cfg2), cfg2, {...plantilla.opciones, _estilos: estilos});
    };

    window._modalPreviewFn = _mRender;
    setTimeout(_mRender, 100);

    // Actualizar preview al cambiar cualquier control
    ['est-fontSize','est-lineHeight','est-marginTop','est-marginBottom','est-marginLeft','est-marginRight']
      .forEach(id2 => {
        const el = document.getElementById(id2);
        if (!el) return;
        el.addEventListener('change', () => setTimeout(_mRender, 60));
        el.addEventListener('input',  () => { clearTimeout(el._t); el._t = setTimeout(_mRender, 350); });
      });
  }

  window._guardarEstilos = async function(id) {
    const estilos = {
      fontSize:     document.getElementById('est-fontSize')?.value,
      lineHeight:   document.getElementById('est-lineHeight')?.value,
      marginTop:    document.getElementById('est-marginTop')?.value?.trim(),
      marginBottom: document.getElementById('est-marginBottom')?.value?.trim(),
      marginLeft:   document.getElementById('est-marginLeft')?.value?.trim(),
      marginRight:  document.getElementById('est-marginRight')?.value?.trim(),
    };
    const key = `template_opts_${id}`;
    await window.api.settings.set({ key, value: JSON.stringify(estilos), requestUserId: user?.id });
    if (typeof DB !== 'undefined' && DB.settings) DB.settings[key] = JSON.stringify(estilos);
    document.getElementById('modal-estilos-ov')?.remove();
    window._modalPreviewFn = null;
    toast('✓ Estilos guardados');
    // Refrescar preview principal
    _renderPreview(id);
  };

  window._resetEstilos = async function(id) {
    const key = `template_opts_${id}`;
    await window.api.settings.set({ key, value: '{}', requestUserId: user?.id });
    if (typeof DB !== 'undefined' && DB.settings) DB.settings[key] = '{}';
    document.getElementById('modal-estilos-ov')?.remove();
    window._modalPreviewFn = null;
    toast('✓ Estilos restablecidos a defaults');
    _renderPreview(id);
  };



// imprimirPruebaPlantilla movida a inline en el bloque de plantillas

  // ── Datos del negocio ────────────────────────
  const fiscalActivo = settings.fiscal_enabled === '1';
  const bizCard = h('div', { class: 'card' });
  bizCard.innerHTML = `
    <div class="card-title mb8">Datos del Negocio</div>
    <div class="fg">
      <label class="lbl">Nombre comercial *</label>
      <input class="inp" id="cfg-biz-name" type="text" placeholder="Mi Negocio" value="${_esc(settings.biz_name||'')}"/>
    </div>
    <div class="fg">
      <label class="lbl">Dirección</label>
      <input class="inp" id="cfg-biz-addr" type="text" placeholder="Calle Principal #1" value="${_esc(settings.biz_addr||'')}"/>
    </div>
    <div class="fg">
      <label class="lbl">Teléfono / WhatsApp</label>
      <input class="inp" id="cfg-biz-phone" type="tel" placeholder="18091234567" value="${_esc(settings.biz_phone||'')}"/>
      <div style="font-size:10px;color:var(--muted2);margin-top:3px">
        Con código de país (ej: 18091234567). Se usa como destino por defecto al enviar por WhatsApp.
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Mensaje en recibos</label>
      <input class="inp" id="cfg-receipt-msg" type="text" placeholder="¡Gracias por su compra!" value="${_esc(settings.receipt_msg||'')}"/>
    </div>

    ${isSA ? `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--fg)">Módulo Fiscal (RNC / NCF / ITBIS)</div>
          <div style="font-size:11px;color:var(--muted2);margin-top:2px">
            Solo para negocios registrados en la DGII. Activa el RNC, comprobantes fiscales y el cálculo de ITBIS.
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex-shrink:0;margin-left:16px">
          <div style="position:relative;width:40px;height:22px">
            <input type="checkbox" id="cfg-fiscal-enabled" ${fiscalActivo ? 'checked' : ''}
              style="opacity:0;width:0;height:0;position:absolute"
              onchange="toggleFiscal(this.checked)"/>
            <div id="fiscal-track" style="
              position:absolute;inset:0;border-radius:11px;transition:background .2s;
              background:${fiscalActivo ? 'var(--accent)' : 'var(--line)'};cursor:pointer"
              onclick="document.getElementById('cfg-fiscal-enabled').click()">
              <div style="
                position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;
                left:${fiscalActivo ? '21px' : '3px'};" id="fiscal-thumb"></div>
            </div>
          </div>
          <span style="font-size:12px;color:var(--muted2)">${fiscalActivo ? 'Activo' : 'Inactivo'}</span>
        </label>
      </div>
    </div>` : ''}

    <div id="fiscal-fields" style="display:${fiscalActivo ? 'block' : 'none'}">
      <div class="fg" style="margin-top:10px">
        <label class="lbl">RNC del negocio</label>
        <input class="inp" id="cfg-biz-rnc" type="text" placeholder="130-00000-0" value="${_esc(settings.biz_rnc||'')}"/>
      </div>
      <div class="fg">
        <label class="lbl">ITBIS (%)</label>
        <input class="inp" id="cfg-tax" type="number" min="0" max="100" placeholder="18" value="${settings.tax_pct||'18'}"/>
        <div style="font-size:10px;color:var(--muted2);margin-top:3px">
          Se aplica solo a facturas. Las cotizaciones nunca llevan ITBIS.
        </div>
      </div>
    </div>

    ${!isSA && !fiscalActivo ? `
    <div style="margin-top:12px;padding:8px 12px;background:var(--bg2);border-radius:6px;font-size:11px;color:var(--muted2)">
      El módulo fiscal (RNC / NCF / ITBIS) está desactivado. Si este negocio está registrado en la DGII, contacta al administrador del sistema para activarlo.
    </div>` : ''}`;
  colLeft.appendChild(bizCard);

  // ── NCF Avanzado (cuando módulo activo) ──────
  if (CFG.module_ncf_avanzado === '1' && isSA) {
    const ncfCard = h('div', { class: 'card', style: 'margin-top:16px' });
    ncfCard.innerHTML = `
      <div class="fxb mb8">
        <div>
          <div class="card-title">📋 Comprobantes Fiscales NCF</div>
          <div style="font-size:11px;color:var(--muted2);margin-top:2px">
            Gestiona los rangos autorizados por la DGII, alertas de agotamiento y validación de RNC.
          </div>
        </div>
      </div>
      <div id="ncf-avanzado-container"></div>`;
    colLeft.appendChild(ncfCard);
    // Renderizar el módulo NCF dentro del contenedor
    const ncfContainer = ncfCard.querySelector('#ncf-avanzado-container');
    if (ncfContainer && typeof renderNCFAvanzado === 'function') {
      renderNCFAvanzado(ncfContainer);
    }
  }

  // ── e-CF: configuración de facturación electrónica ──────────────────────
  if (fiscalActivo) {
    const ecfContainer = document.createElement('div');
    ecfContainer.id = 'ecf-config-container';
    colLeft.appendChild(ecfContainer);
    if (typeof renderECFConfig === 'function') {
      renderECFConfig(ecfContainer);
    }
  }

  // ── Logo (solo superadmin) ───────────────────
  if (isSA) {
    const logoActual = settings.biz_logo || '';
    const logoCard   = h('div', { class: 'card' });
    logoCard.innerHTML = `
      <div class="fxb mb8">
        <div class="card-title">Logo en Tickets</div>
        ${logoActual ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="eliminarLogo()">Eliminar</button>` : ''}
      </div>
      ${logoActual
        ? `<div style="text-align:center;margin-bottom:12px">
             <img src="${logoActual}" style="max-width:160px;max-height:60px;filter:grayscale(100%) contrast(150%);border:1px solid var(--line);border-radius:6px;padding:8px"/>
             <div style="font-size:11px;color:var(--muted);margin-top:4px">Así aparecerá en B&N en el ticket</div>
           </div>`
        : `<div class="alrt b" style="margin-bottom:12px">
             <div class="alrt-dot b"></div>
             <div>
               <div class="alrt-title">Sin logo configurado</div>
               <div class="alrt-sub">PNG o JPG, 300×100px recomendado.</div>
             </div>
           </div>`}
      <input type="file" id="logo-input" accept="image/png,image/jpeg,image/jpg" style="display:none" onchange="previewLogo(this)"/>
      <button class="btn btn-out btn-fw" onclick="document.getElementById('logo-input').click()">
        ${svg('download')} ${logoActual ? 'Cambiar logo' : 'Seleccionar imagen'}
      </button>
      <div id="logo-preview" style="margin-top:10px;display:none;text-align:center">
        <img id="logo-preview-img" style="max-width:160px;max-height:60px;filter:grayscale(100%) contrast(150%);border:1px solid var(--line);border-radius:6px;padding:8px"/>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">Vista previa</div>
        <button class="btn btn-green btn-sm" style="margin-top:8px" onclick="guardarLogo()">
          ${svg('check')} Guardar logo
        </button>
      </div>`;
    colLeft.appendChild(logoCard);
  }

  // ── Impresora (solo superadmin) ──────────────
  if (isSA) {
    const printerCard = h('div', { class: 'card' });
    printerCard.innerHTML = `
      <div class="fxb mb8"><div class="card-title">Impresora Térmica</div></div>
      <div class="tr" style="font-size:12px;margin-bottom:10px">
        <span>Impresora guardada</span>
        <span style="font-weight:600;color:${settings.printer?'var(--green)':'var(--muted2)'}">
          ${settings.printer ? settings.printer.slice(0,30) : 'No configurada'}
        </span>
      </div>
      <div class="alrt b" style="margin-bottom:12px">
        <div class="alrt-dot b"></div>
        <div>
          <div class="alrt-title">${detectPrinterType(settings.printer||'')==='58mm'?'Térmica 58mm detectada':'Térmica 80mm (default)'}</div>
          <div class="alrt-sub">Conecta por USB, instala en Windows y configura aquí.</div>
        </div>
      </div>
      <div class="flex" style="gap:8px">
        <button class="btn btn-dark btn-fw" onclick="openPrinterConfig()">${svg('settings')} Configurar</button>
        <button class="btn btn-out btn-fw" onclick="testPrint()">${svg('print')} Prueba</button>
      </div>`;
    colLeft.appendChild(printerCard);
  }

  // ── Impresión por módulo/documento (solo superadmin) ──
  if (isSA) {
    const printers = await window.api.print.getPrinters().catch(() => []);
    let printCfg = {};
    try { printCfg = JSON.parse(settings.print_config || '{}'); } catch {}

    const printerOpts = (current) => `
      <option value="">Impresora global (la de arriba)</option>
      ${printers.map(p => `<option value="${_escHtml(p.name)}" ${p.name===current?'selected':''}>${_escHtml(p.name)}${p.isDefault?' (predeterminada)':''}</option>`).join('')}
    `;

    const catCard = h('div', { class: 'card', style: 'margin-top:16px' });
    const rows = Object.keys(PRINT_CATEGORIES).map(cat => {
      const c   = printCfg[cat] || {};
      const def = PRINT_CATEGORIES[cat];
      const autoPrintChecked = c.autoPrint !== undefined ? c.autoPrint : def.autoPrintDefault;
      return `
        <tr data-cat="${cat}">
          <td style="padding:8px 6px;font-size:12px;font-weight:600">${def.label}</td>
          <td style="padding:8px 6px">
            <select class="inp pc-printer" style="font-size:12px;padding:5px 8px;width:100%">${printerOpts(c.printer||'')}</select>
          </td>
          <td style="padding:8px 6px;text-align:center">
            <input type="checkbox" class="pc-preview" ${c.preview?'checked':''}>
          </td>
          <td style="padding:8px 6px;text-align:center">
            ${cat === 'ticket'
              ? `<input type="checkbox" class="pc-autoprint" ${autoPrintChecked?'checked':''}>`
              : '<span style="color:var(--muted2);font-size:11px">—</span>'}
          </td>
        </tr>`;
    }).join('');

    catCard.innerHTML = `
      <div class="fxb mb8"><div class="card-title">Impresión por módulo</div></div>
      <div style="font-size:11px;color:var(--muted2);margin-bottom:10px">
        Asigna una impresora distinta por tipo de documento y decide si quieres ver una vista
        previa antes de imprimir. "Auto-imprimir" solo aplica a tickets de venta — si lo
        desactivas, cada venta abrirá una vista previa en vez de imprimir directo.
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="text-align:left;font-size:10px;color:var(--muted2);text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:4px 6px">Módulo</th><th style="padding:4px 6px">Impresora</th>
          <th style="padding:4px 6px;text-align:center">Vista previa</th>
          <th style="padding:4px 6px;text-align:center">Auto-imprimir</th>
        </tr></thead>
        <tbody id="pc-rows">${rows}</tbody>
      </table>
      <div style="margin-top:12px">
        <button class="btn btn-dark btn-fw" id="btn-save-print-config">${svg('check')} Guardar configuración</button>
      </div>`;
    colLeft.appendChild(catCard);

    catCard.querySelector('#btn-save-print-config')?.addEventListener('click', async () => {
      const newCfg = {};
      catCard.querySelectorAll('#pc-rows tr[data-cat]').forEach(row => {
        const cat     = row.dataset.cat;
        const printer = row.querySelector('.pc-printer')?.value || '';
        const preview = row.querySelector('.pc-preview')?.checked || false;
        const autoEl  = row.querySelector('.pc-autoprint');
        const entry   = { printer, preview };
        if (autoEl) entry.autoPrint = autoEl.checked;
        newCfg[cat] = entry;
      });
      const res = await window.api.print.saveConfig({ config: newCfg, requestUserId: user?.id });
      if (res?.ok) {
        settings.print_config = JSON.stringify(newCfg);
        if (DB.settings) DB.settings.print_config = JSON.stringify(newCfg);
        toast('✓ Configuración de impresión guardada');
      } else {
        toast(res?.error || 'Error al guardar', 'err');
      }
    });
  }

  // ══════════════════════
  // COLUMNA DERECHA
  // ══════════════════════

  // ── Actualizaciones ──────────────────────────
  const updCard = h('div', { class: 'card', id: 'upd-card' });
  _renderUpdPanel(updCard);
  if (window.api?.updater?.onState) {
    window.api.updater.onState((state) => {
      const c = document.getElementById('upd-card');
      if (c) _renderUpdPanel(c, state);
      _updFloatingBar(state);
    });
  }
  colRight.appendChild(updCard);

  // ── Sistema ──────────────────────────────────
  const infoCard = h('div', { class: 'card' });
  infoCard.innerHTML = `
    <div class="card-title mb8">Sistema</div>
    <div class="tr" style="font-size:12px">
      <span>Versión</span>
      <span style="font-family:var(--mono);font-weight:600">v${info.appVersion||window._appVersion||'1.4.1'}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Instalado</span>
      <span>${info.installedAt?info.installedAt.split('T')[0]:'—'}</span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Último backup</span>
      <span style="color:${info.lastBackup&&info.lastBackup===today()?'var(--green)':'var(--amber)'}">
        ${info.lastBackup||'Nunca'}
      </span>
    </div>
    <div class="tr" style="font-size:12px">
      <span>Backups guardados</span>
      <span>${info.backupsCount||0}</span>
    </div>`;
  colRight.appendChild(infoCard);

  // ── Importar datos ───────────────────────────
  const importCard = h('div', { class: 'card' });
  importCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, '📂 Importar datos'),
    h('span', { style: 'font-size:11px;color:var(--muted2)' }, 'Excel, CSV, JSON, SQLite')
  ));
  importCard.appendChild(h('div', { class: 'alrt b', style: 'margin-bottom:12px' },
    h('div', { class: 'alrt-dot b' }),
    h('div', null,
      h('div', { class: 'alrt-title' }, 'Importación con IA'),
      h('div', { class: 'alrt-sub' }, 'La IA detecta automáticamente las columnas de tu archivo.')
    )
  ));
  importCard.appendChild(h('button', {
    class: 'btn btn-dark btn-fw',
    onclick: abrirImportarDesdeConfig,
    html: '✨ Importar productos o clientes'
  }));
  colRight.appendChild(importCard);

  // ── Backups ──────────────────────────────────
  const backupCard = h('div', { class: 'card' });
  backupCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Backups'),
    h('span', { style: 'font-size:11px;color:var(--muted2)' }, `${info.backupsCount||0} guardados`)
  ));
  backupCard.appendChild(h('div', { class: 'alrt b', style: 'margin-bottom:12px' },
    h('div', { class: 'alrt-dot b' }),
    h('div', null,
      h('div', { class: 'alrt-title' }, 'Backup automático activo'),
      h('div', { class: 'alrt-sub' }, 'Se crea automáticamente cada vez que inicia la app.')
    )
  ));
  backupCard.appendChild(h('div', { class: 'flex', style: 'gap:8px;margin-bottom:12px' },
    h('button', { class: 'btn btn-out btn-fw', onclick: hacerBackupManual, html: `${svg('download')} Crear ahora` }),
    h('button', { class: 'btn btn-ghost btn-fw', style: 'color:var(--amber)', onclick: restaurarBackup, html: `${svg('return')} Restaurar último` })
  ));
  if (info.backups?.length) {
    const bList = h('div');
    bList.appendChild(h('div', { style: 'font-size:11px;font-weight:700;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em' }, 'Backups disponibles'));
    info.backups.forEach(b => {
      const nombre   = typeof b === 'string' ? b : b.name || b;
      const fechaStr = nombre.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
      const esHoy    = fechaStr === today();
      const row      = h('div', { class: 'fxb', style: 'padding:8px 0;border-bottom:1px solid var(--line2)' });
      row.appendChild(h('div', null,
        h('div', { style: `font-size:12px;font-family:var(--mono);color:${esHoy?'var(--green)':'var(--ink)'}` }, nombre),
        h('div', { style: 'font-size:10px;color:var(--muted2)' }, esHoy ? 'Hoy' : fechaStr ? fdate(fechaStr) : '')
      ));
      row.appendChild(h('button', {
        class: 'btn btn-ghost btn-sm',
        style: 'color:var(--amber);font-size:11px',
        html: `${svg('return')} Restaurar`,
        onclick: () => restaurarBackupEspecifico(nombre)
      }));
      bList.appendChild(row);
    });
    backupCard.appendChild(bList);
  } else {
    backupCard.appendChild(h('div', { style: 'font-size:12px;color:var(--muted2);padding:8px 0' }, 'Sin backups todavía'));
  }
  colRight.appendChild(backupCard);

  // ── Licencia (solo superadmin) ───────────────
  if (isSA) {
    const licColor = !lic ? 'var(--muted)' :
      lic.blocked     ? 'var(--red)'   :
      lic.inGrace     ? 'var(--amber)' :
      lic.warningSoon ? 'var(--amber)' : 'var(--green)';
    const licLabel = !lic ? 'No disponible' :
      lic.blocked      ? 'Sin licencia — bloqueado' :
      lic.inGrace      ? `Período de gracia — ${lic.graceDaysLeft}d restantes` :
      lic.warningSoon  ? `Vence en ${lic.daysLeft} días` :
      lic.licensed     ? `Activa${lic.expiry==='Perpetua'?' (Perpetua)':' — Vence: '+lic.expiry}` : 'Desconocido';

    const licCard = h('div', { class: 'card' });
    licCard.innerHTML = `
      <div class="fxb mb8">
        <div class="card-title">Licencia del Sistema</div>
        <span class="badge ${lic?.licensed?'g':lic?.inGrace?'a':'r'}" style="font-size:11px">
          ${lic?.licensed?'Activa':lic?.inGrace?'Gracia':'Sin licencia'}
        </span>
      </div>
      <div class="tr" style="font-size:12px;margin-bottom:6px">
        <span>Estado</span>
        <span style="font-weight:600;color:${licColor}">${licLabel}</span>
      </div>
      ${lic?.business ? `<div class="tr" style="font-size:12px;margin-bottom:6px">
        <span>Negocio</span><span style="font-weight:600">${_esc(lic.business)}</span>
      </div>` : ''}
      <div class="tr" style="font-size:11px;color:var(--muted);margin-bottom:12px">
        <span>ID de máquina</span>
        <span style="font-family:var(--mono);font-size:10px">${_esc(lic?.machineId||'—')}</span>
      </div>
      ${lic?.inGrace||lic?.blocked||!lic?.licensed ? `
        <div class="alrt a" style="margin-bottom:12px">
          <div class="alrt-dot a"></div>
          <div>
            <div class="alrt-title">Activar licencia</div>
            <div class="alrt-sub">Contacta al proveedor con el ID de máquina.</div>
          </div>
        </div>
        <div class="fg" style="margin-bottom:8px">
          <label class="lbl">Clave de licencia</label>
          <textarea class="inp" id="lic-key" rows="3" placeholder="2|ABCD...|Negocio|2027-01-01|FIRMA"
                 style="font-family:var(--mono);font-size:11px;resize:none;white-space:nowrap;overflow-x:auto"
                 onpaste="setTimeout(()=>{this.value=this.value.replace(/[\r\n\s]+/g,'')},0)"></textarea>
        </div>
        <button class="btn btn-green btn-fw" onclick="activarLicencia()">
          ${svg('check')} Activar licencia
        </button>` : `
        <button class="btn btn-out btn-sm" onclick="openModal('<div class=\\'modal-title\\'>ID de Máquina</div><div style=\\'font-family:monospace;font-size:12px;padding:14px;background:var(--surface2);border-radius:8px;word-break:break-all\\'>${_esc(lic?.machineId||'')}</div><div class=\\'modal-foot\\'><button class=\\'btn btn-out\\' onclick=\\'closeModal()\\'>Cerrar</button></div>')">
          Ver ID de máquina
        </button>`}`;
    colRight.appendChild(licCard);
  }

  // ── Categorías (scroll interno) ──────────────
  const catCard = h('div', { class: 'card' });
  catCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Categorías'),
    h('button', { class: 'btn btn-dark btn-sm', onclick: openNuevaCategoriaModal, html: `${svg('plus')} Nueva` })
  ));
  const catScroll = h('div', { style: 'max-height:220px;overflow-y:auto;overflow-x:hidden' });
  const catListEl = h('div', { id: 'cat-list' });
  _renderCatList(catListEl);
  catScroll.appendChild(catListEl);
  catCard.appendChild(catScroll);
  colRight.appendChild(catCard);

  // ── Usuarios ─────────────────────────────────
  const usersCard = h('div', { class: 'card' });
  usersCard.appendChild(h('div', { class: 'fxb mb8' },
    h('div', { class: 'card-title' }, 'Usuarios del sistema'),
    h('button', { class: 'btn btn-dark btn-sm', onclick: openNuevoCajeroModal, html: `${svg('plus')} Nuevo cajero` })
  ));
  const users = (window._cachedUsers || []).filter(u => u.role !== 'superadmin');
  if (!users.length) {
    usersCard.appendChild(h('div', { style: 'color:var(--muted2);font-size:12px' }, 'Sin usuarios'));
  } else {
    users.forEach(u => {
      const row = h('div', { class: 'fxb', style: 'padding:10px 0;border-bottom:1px solid var(--line2)' });
      row.appendChild(h('div', { class: 'flex', style: 'gap:8px' },
        h('div', { class: 'sb-av', style: `width:32px;height:32px;font-size:11px;opacity:${u.active?1:0.4}` }, u.avatar||u.name?.[0]||'U'),
        h('div', null,
          h('div', { style: `font-size:13px;font-weight:600;color:${u.active?'var(--ink)':'var(--muted)'}` }, u.name),
          h('div', { class: 'ts' }, u.email)
        )
      ));
      const actions = h('div', { class: 'flex', style: 'gap:5px' });
      actions.appendChild(h('span', { class: `badge ${u.role==='admin'?'b':'g'}` }, u.role));
      actions.appendChild(h('span', { class: `badge ${u.active?'g':'r'}` }, u.active?'Activo':'Inactivo'));
      if (!(u.role==='admin' && u.id===user?.id)) {
        actions.appendChild(h('button', { class: 'btn btn-ghost btn-sm', title: 'Editar', html: svg('edit'), onclick: () => openEditarUsuarioModal(u) }));
        if (u.role !== 'admin') {
          actions.appendChild(h('button', {
            class: 'btn btn-ghost btn-sm',
            title: u.active ? 'Desactivar' : 'Activar',
            style: `color:${u.active?'var(--red)':'var(--green)'}`,
            html: u.active ? svg('lock') : svg('check'),
            onclick: () => toggleUsuario(u)
          }));
        }
      }
      row.appendChild(actions);
      usersCard.appendChild(row);
    });
  }
  colRight.appendChild(usersCard);

  // ── Diagnóstico del sistema (solo superadmin) ──
  if (isSA) {
    const diagCard = h('div', { class: 'card', id: 'diag-card' });
    diagCard.innerHTML = `
      <div class="fxb mb8">
        <div class="card-title">Diagnóstico del sistema</div>
        <button class="btn btn-dark btn-sm" id="diag-btn">
          ${svg('refresh')} Ejecutar
        </button>
      </div>
      <div id="diag-body" style="font-size:12px;color:var(--muted2)">
        Presiona "Ejecutar" para revisar el estado completo del sistema.
      </div>`;
    diagCard.querySelector('#diag-btn')?.addEventListener('click', runDiagnosis);
    colRight.appendChild(diagCard);
  }

  // ── Impresiones fallidas (solo superadmin) ──
  if (isSA) {
    const failedJobs = await window.api.print.getJobs({})
      .then(jobs => (jobs || []).filter(j => j.status === 'failed'))
      .catch(() => []);

    const failCard = h('div', { class: 'card' });
    const rowsHtml = failedJobs.length ? failedJobs.slice(0, 15).map(j => `
      <tr data-ref-id="${j.reference_id||''}">
        <td style="padding:6px 6px;font-size:11px">${_escHtml(j.type)} #${j.reference_id||'—'}</td>
        <td style="padding:6px 6px;font-size:11px;color:var(--muted2)">${_escHtml((j.created_at||'').slice(0,16))}</td>
        <td style="padding:6px 6px;font-size:11px;color:#ef4444" title="${_escHtml(j.error)}">${_escHtml((j.error||'').slice(0,40))}</td>
        <td style="padding:6px 6px;text-align:right">
          ${j.type === 'ticket' && j.reference_id
            ? `<button class="btn btn-out btn-sm pj-retry">${svg('refresh')} Reintentar</button>`
            : `<span style="font-size:10px;color:var(--muted2)">Reimprime desde su módulo</span>`}
        </td>
      </tr>`).join('') : `<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--muted2);font-size:12px">Sin impresiones fallidas recientes</td></tr>`;

    failCard.innerHTML = `
      <div class="fxb mb8"><div class="card-title">Impresiones fallidas</div></div>
      <div style="font-size:11px;color:var(--muted2);margin-bottom:10px">
        Últimos intentos de impresión que fallaron (impresora ocupada, desconectada, etc.).
        Los tickets de venta se pueden reintentar aquí mismo; el resto debe reimprimirse
        desde su módulo de origen.
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${rowsHtml}</tbody>
      </table>`;
    colRight.appendChild(failCard);

    failCard.querySelectorAll('.pj-retry').forEach(btn => {
      btn.addEventListener('click', () => {
        const refId = parseInt(btn.closest('tr')?.dataset.refId, 10);
        if (refId && typeof reimprimirVenta === 'function') reimprimirVenta(refId);
      });
    });
  }

  // ── Ensamblar ────────────────────────────────
  grid.appendChild(colLeft);
  grid.appendChild(colRight);
  el.appendChild(grid);
}

// ══════════════════════════════════════════════
// GUARDAR CONFIGURACIÓN
// ══════════════════════════════════════════════
async function guardarConfiguracion() {
  const uid = user?.id;
  const fields = [
    ['biz_name',    'cfg-biz-name'],
    ['biz_addr',    'cfg-biz-addr'],
    ['biz_phone',   'cfg-biz-phone'],
    ['receipt_msg', 'cfg-receipt-msg'],
  ];
  for (const [key, id] of fields) {
    const val = document.getElementById(id)?.value?.trim() || '';
    const r = await window.api.settings.set({ key, value: val, requestUserId: uid });
    if (r && !r.ok) { toast(r.error || 'Sin permisos para guardar configuración', 'e'); return; }
  }

  // Campos fiscales — solo si el módulo fiscal está activo
  const fiscalCheck = document.getElementById('cfg-fiscal-enabled');
  if (fiscalCheck) {
    const fiscalOn = fiscalCheck.checked ? '1' : '0';
    const r = await window.api.settings.set({ key: 'fiscal_enabled', value: fiscalOn, requestUserId: uid });
    if (r && !r.ok) { toast(r.error || 'Sin permisos', 'e'); return; }
  }
  const rncEl = document.getElementById('cfg-biz-rnc');
  if (rncEl) await window.api.settings.set({ key: 'biz_rnc', value: rncEl.value.trim(), requestUserId: uid });
  const taxEl = document.getElementById('cfg-tax');
  if (taxEl) await window.api.settings.set({ key: 'tax_pct', value: taxEl.value.trim(), requestUserId: uid });

  const s = await window.api.settings.getAll();
  CFG.biz          = s.biz_name      || CFG.biz;
  CFG.rnc          = s.biz_rnc       || CFG.rnc;
  CFG.addr         = s.biz_addr      || CFG.addr;
  CFG.phone        = s.biz_phone     || CFG.phone;
  CFG.fiscalEnabled = s.fiscal_enabled === '1';
  CFG.itbis        = CFG.fiscalEnabled ? (parseFloat(s.tax_pct) || 18) : 0;
  toast('✓ Configuración guardada');
}


// ══════════════════════════════════════════════
// DIAGNÓSTICO DEL SISTEMA
// ══════════════════════════════════════════════
async function runDiagnosis() {
  const body = document.getElementById('diag-body');
  const btn  = document.getElementById('diag-btn');
  if (!body) return;

  if (btn) btn.disabled = true;
  body.innerHTML = `<div style="color:var(--muted2);font-size:12px;padding:8px 0">Analizando sistema...</div>`;

  let res;
  try {
    if (!window.api?.system?.diagnose) {
      throw new Error('El puente de diagnóstico no está disponible. Reinicia la app en modo desarrollo.');
    }
    res = await window.api.system.diagnose({ requestUserId: user?.id });
  } catch (e) {
    if (btn) btn.disabled = false;
    body.innerHTML = `<div style="color:var(--red);font-size:12px">${e.message || 'Error al ejecutar diagnóstico'}</div>`;
    return;
  }
  if (btn) btn.disabled = false;

  if (!res?.ok) {
    body.innerHTML = `<div style="color:var(--red);font-size:12px">${res?.error || 'Error al ejecutar diagnóstico'}</div>`;
    return;
  }

  const { results, score, errors, warns, timestamp } = res;

  const scoreColor = score === 'healthy' ? 'var(--green)' : score === 'warn' ? 'var(--amber)' : 'var(--red)';
  const scoreLabel = score === 'healthy' ? 'Sistema saludable' : score === 'warn' ? `${warns} advertencia${warns>1?'s':''}` : `${errors} error${errors>1?'es':''}`;
  const scoreIcon  = score === 'healthy' ? '✓' : score === 'warn' ? '⚠' : '✗';

  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'warn' ? 'var(--amber)' : 'var(--red)';
  const statusIcon  = s => s === 'ok' ? '●' : s === 'warn' ? '●' : '●';
  const escDiag = v => String(v == null ? '' : v)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
  const catLabel = c => ({
    nucleo: 'Núcleo',
    seguridad: 'Seguridad',
    operacion: 'Operación',
    negocio: 'Negocio',
    fiscal: 'Fiscal',
    contabilidad: 'Contabilidad',
    codigo: 'Código',
    sistema: 'Sistema',
    hardware: 'Hardware',
  }[c] || 'Sistema');

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;
                background:var(--bg2);margin-bottom:10px">
      <span style="font-size:16px;color:${scoreColor};font-weight:700">${scoreIcon}</span>
      <span style="font-size:13px;font-weight:600;color:${scoreColor}">${scoreLabel}</span>
      <span style="font-size:10px;color:var(--muted2);margin-left:auto">
        ${new Date(timestamp).toLocaleTimeString('es-DO')}
      </span>
    </div>
    ${results.map(r => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;
                  border-bottom:1px solid var(--line2)">
        <span style="color:${statusColor(r.status)};font-size:10px;margin-top:2px;flex-shrink:0">${statusIcon(r.status)}</span>
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:12px;font-weight:600;color:var(--ink)">${escDiag(r.label)}</span>
            <span style="font-size:9px;padding:1px 6px;border-radius:100px;background:var(--surface2);color:var(--muted2)">
              ${catLabel(r.category)}
            </span>
            <span style="font-size:10px;padding:1px 6px;border-radius:100px;
                         background:${r.status==='ok'?'var(--green-bg, #f0fdf4)':r.status==='warn'?'var(--amber-bg, #fffbeb)':'var(--red-bg, #fef2f2)'};
                         color:${statusColor(r.status)}">
              ${r.status === 'ok' ? 'OK' : r.status === 'warn' ? 'Advertencia' : 'Error'}
            </span>
          </div>
          <div style="font-size:11px;color:var(--muted2);margin-top:3px;line-height:1.4">${escDiag(r.detail)}</div>
          ${r.impact ? `<div style="font-size:10.5px;color:var(--muted);margin-top:5px;line-height:1.35">
            <strong style="color:var(--ink)">Impacto:</strong> ${escDiag(r.impact)}
          </div>` : ''}
          ${r.fix ? `<div style="font-size:10.5px;color:var(--muted);margin-top:3px;line-height:1.35">
            <strong style="color:var(--ink)">Acción:</strong> ${escDiag(r.fix)}
          </div>` : ''}
        </div>
    </div>`).join('')}
    <div style="margin-top:8px;text-align:right">
      <button class="btn btn-ghost btn-sm" id="diag-rerun-btn" style="font-size:11px">
        Ejecutar de nuevo
      </button>
    </div>`;
  document.getElementById('diag-rerun-btn')?.addEventListener('click', runDiagnosis);
}

window.runDiagnosis = runDiagnosis;

// ── Toggle módulo fiscal (solo superadmin) ────
function toggleFiscal(activo) {
  const fields  = document.getElementById('fiscal-fields');
  const track   = document.getElementById('fiscal-track');
  const thumb   = document.getElementById('fiscal-thumb');
  const label   = track?.nextElementSibling;
  if (fields)  fields.style.display  = activo ? 'block' : 'none';
  if (track)   track.style.background = activo ? 'var(--accent)' : 'var(--line)';
  if (thumb)   thumb.style.left       = activo ? '21px' : '3px';
  if (label)   label.textContent      = activo ? 'Activo' : 'Inactivo';
}

// ══════════════════════════════════════════════
// USUARIOS
// ══════════════════════════════════════════════
function openEditarUsuarioModal(u) {
  openModal(`
    <div class="modal-title">Editar Usuario</div>
    <div class="modal-sub">${_esc(u.name)} · ${_esc(u.role)}</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nombre completo *</label>
        <input class="inp" id="eu-name" type="text" value="${_esc(u.name||'')}"/></div>
      <div class="fg"><label class="lbl">Email *</label>
        <input class="inp" id="eu-email" type="email" value="${_esc(u.email||'')}"/></div>
    </div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nueva contraseña</label>
        <input class="inp" id="eu-pass" type="password" placeholder="Dejar vacío para no cambiar"/></div>
      <div class="fg"><label class="lbl">Iniciales (avatar)</label>
        <input class="inp" id="eu-avatar" type="text" value="${_esc(u.avatar||'')}" maxlength="2"/></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" id="eu-cancel">Cancelar</button>
      <button class="btn btn-green" id="eu-save">${svg('check')} Guardar</button>
    </div>`);
  // Eventos propios: el botón con argumento no lo reconoce la lista blanca de
  // _bindModalSafeActions, así que lo enganchamos aquí directamente.
  document.getElementById('eu-cancel')?.addEventListener('click', () => closeModal());
  document.getElementById('eu-save')?.addEventListener('click', () => guardarEdicionUsuario(u.id));
}

async function guardarEdicionUsuario(id) {
  const name   = document.getElementById('eu-name')?.value?.trim();
  const email  = document.getElementById('eu-email')?.value?.trim();
  const pass   = document.getElementById('eu-pass')?.value;
  const avatar = document.getElementById('eu-avatar')?.value?.trim().toUpperCase() || '';
  if (!name)  { toast('El nombre es requerido', 'err'); return; }
  if (!email) { toast('El email es requerido', 'err');  return; }
  if (pass && pass.length < 6) { toast('Mínimo 6 caracteres', 'err'); return; }
  const existing = (window._cachedUsers||[]).find(u=>u.id===id);
  const data = { name, email, role: existing?.role||'cajero', avatar: avatar||name[0].toUpperCase(), active: existing?.active??1 };
  const result = await window.api.users.update({ id, data, requestUserId: _cfgUser().id });
  if (!result.ok) { toast(result.error||'Error', 'err'); return; }
  if (pass) {
    await window.api.users.changePassword({ id, password: pass, requestUserId: _cfgUser().id });
  }
  window._cachedUsers = await window.api.users.getAll() || [];
  closeModal();
  toast(`✓ Usuario ${name} actualizado`);
  renderConfiguracion(document.getElementById('page'));
}

async function toggleUsuario(u) {
  confirmModal(`¿Deseas ${u.active?'desactivar':'activar'} a <strong>${_esc(u.name)}</strong>?`,
    async () => {
      const result = await window.api.users.update({ id: u.id, data: {...u, active: u.active?0:1}, requestUserId: _cfgUser().id });
      if (!result.ok) { toast(result.error||'Error', 'err'); return; }
      window._cachedUsers = await window.api.users.getAll() || [];
      toast(`✓ Usuario ${u.active?'desactivado':'activado'}`);
      renderConfiguracion(document.getElementById('page'));
    },
    u.active ? 'Desactivar' : 'Activar',
    u.active ? 'btn-red' : 'btn-green'
  );
}

// ══════════════════════════════════════════════
// BACKUPS
// ══════════════════════════════════════════════
async function hacerBackupManual() {
  const result = await window.api.backup.create({ requestUserId: _cfgUser().id });
  if (result.ok) {
    toast(`✓ Backup creado`);
    renderConfiguracion(document.getElementById('page'));
  } else {
    toast(result.error||'Error al crear backup', 'err');
  }
}

async function restaurarBackup() {
  confirmModal('Al restaurar el último backup, los datos actuales serán reemplazados. ¿Continuar?',
    async () => {
      const result = await window.api.backup.restore({ requestUserId: _cfgUser().id });
      if (result.ok) { toast('✓ Restaurando...'); setTimeout(() => location.reload(), 1500); }
      else toast(result.error||'Error al restaurar', 'err');
    }, 'Restaurar', 'btn-red');
}

async function restaurarBackupEspecifico(nombre) {
  confirmModal(`¿Restaurar <strong>${nombre}</strong>?<br><span style="font-size:11px;color:var(--muted)">Los datos actuales serán reemplazados.</span>`,
    async () => {
      const result = await window.api.backup.restore({ fileName: nombre, requestUserId: _cfgUser().id });
      if (result.ok) { toast('✓ Restaurando...'); setTimeout(() => location.reload(), 1500); }
      else toast(result.error||'Error al restaurar', 'err');
    }, 'Restaurar este backup', 'btn-red');
}

// ══════════════════════════════════════════════
// NUEVO CAJERO
// ══════════════════════════════════════════════
function openNuevoCajeroModal() {
  const isSA = user?.role === 'superadmin';
  openModal(`
    <div class="modal-title">Nuevo Usuario</div>
    <div class="modal-sub">Crear cuenta de acceso</div>
    <div class="g2">
      <div class="fg"><label class="lbl">Nombre completo *</label>
        <input class="inp" id="uc-name" type="text" placeholder="Juan Pérez"/></div>
      <div class="fg"><label class="lbl">Email *</label>
        <input class="inp" id="uc-email" type="email" placeholder="cajero@negocio.do"/></div>
    </div>
    <div class="g2">
      <div class="fg"><label class="lbl">Contraseña *</label>
        <input class="inp" id="uc-pass" type="password" placeholder="Mínimo 6 caracteres"/></div>
      <div class="fg"><label class="lbl">Iniciales (avatar)</label>
        <input class="inp" id="uc-avatar" type="text" placeholder="JP" maxlength="2"/></div>
    </div>
    <div class="fg">
      <label class="lbl">Rol</label>
      <select class="inp" id="uc-role">
        <option value="cajero">Cajero / Vendedor</option>
        ${isSA ? '<option value="admin">Administrador</option>' : ''}
      </select>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="crearCajero()">${svg('check')} Crear usuario</button>
    </div>`);
}

async function crearCajero() {
  const name   = document.getElementById('uc-name')?.value?.trim();
  const email  = document.getElementById('uc-email')?.value?.trim();
  const pass   = document.getElementById('uc-pass')?.value;
  const avatar = document.getElementById('uc-avatar')?.value?.trim().toUpperCase() || '';
  const role   = user?.role==='superadmin' ? (document.getElementById('uc-role')?.value||'cajero') : 'cajero';
  if (!name)  { toast('El nombre es requerido', 'err'); return; }
  if (!email) { toast('El email es requerido', 'err');  return; }
  if (!pass||pass.length<6) { toast('Mínimo 6 caracteres', 'err'); return; }
  const result = await window.api.users.create({ data: { name, email, password: pass, role, avatar }, requestUserId: _cfgUser().id });
  if (!result.ok) { toast(result.error||'Error al crear', 'err'); return; }
  window._cachedUsers = await window.api.users.getAll() || [];
  closeModal();
  toast(`✓ ${role==='admin'?'Administrador':'Cajero'} ${name} creado`);
  renderConfiguracion(document.getElementById('page'));
}

// ══════════════════════════════════════════════
// CATEGORÍAS
// ══════════════════════════════════════════════
async function _renderCatList(el) {
  if (!el) return;
  const r    = await window.api.categories.getAll().catch(() => ({ ok: false }));
  const cats = r?.ok ? r.data : [];
  if (!cats.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--muted2);padding:8px 0">Sin categorías — agrega la primera</div>`;
    return;
  }
  el.innerHTML = '';
  cats.forEach(c => {
    const row = h('div', { class: 'fxb', style: 'padding:7px 0;border-bottom:1px solid var(--line2)' });
    row.appendChild(h('span', { style: 'font-size:13px' }, c.name));
    row.appendChild(h('button', {
      class: 'btn btn-ghost btn-sm',
      style: 'color:var(--red);font-size:11px',
      html: `${svg('trash')} Eliminar`,
      onclick: () => eliminarCategoria(c.id, c.name)
    }));
    el.appendChild(row);
  });
}

function openNuevaCategoriaModal() {
  openModal(`
    <div class="modal-title">Nueva Categoría</div>
    <div class="fg">
      <label class="lbl">Nombre *</label>
      <input class="inp" id="cat-name" type="text" placeholder="Ej: Herramientas, Aceites..."
             onkeydown="if(event.key==='Enter') crearCategoria()"/>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="crearCategoria()">${svg('check')} Crear</button>
    </div>`);
  setTimeout(() => document.getElementById('cat-name')?.focus(), 100);
}

async function crearCategoria() {
  const name = document.getElementById('cat-name')?.value?.trim();
  if (!name) { toast('El nombre es requerido', 'err'); return; }
  const r = await window.api.categories.create({ name, requestUserId: _cfgUser().id });
  if (!r.ok) { toast(r.error||'Error al crear', 'err'); return; }
  await reloadCategories();
  closeModal();
  toast(`✓ Categoría "${name}" creada`);
  const el = document.getElementById('cat-list');
  if (el) _renderCatList(el);
}

function eliminarCategoria(id, name) {
  confirmModal(`¿Eliminar la categoría <strong>${name}</strong>?<br>
    <span style="font-size:11px;color:var(--muted)">Los productos quedarán sin categoría.</span>`,
    async () => {
      const r = await window.api.categories.delete({ id, requestUserId: _cfgUser().id });
      if (!r.ok) { toast(r.error||'Error', 'err'); return; }
      await reloadCategories();
      toast('✓ Categoría eliminada');
      const el = document.getElementById('cat-list');
      if (el) _renderCatList(el);
    }, 'Eliminar', 'btn-red');
}

// ══════════════════════════════════════════════
// LOGO
// ══════════════════════════════════════════════
function previewLogo(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById('logo-preview');
    const img  = document.getElementById('logo-preview-img');
    if (prev) prev.style.display = 'block';
    if (img)  img.src = e.target.result;
    window._logoDataUrl = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function guardarLogo() {
  if (!window._logoDataUrl) { toast('Selecciona una imagen primero', 'w'); return; }
  await window.api.settings.set({ key: 'biz_logo', value: window._logoDataUrl, requestUserId: user?.id });
  CFG.biz_logo = window._logoDataUrl;
  toast('✓ Logo guardado');
  renderConfiguracion(document.getElementById('page'));
}

async function eliminarLogo() {
  confirmModal('¿Eliminar el logo del negocio?',
    async () => {
      await window.api.settings.set({ key: 'biz_logo', value: '', requestUserId: user?.id });
      CFG.biz_logo = '';
      toast('✓ Logo eliminado');
      renderConfiguracion(document.getElementById('page'));
    }, 'Eliminar', 'btn-red');
}

// ══════════════════════════════════════════════
// LICENCIA
// ══════════════════════════════════════════════
async function activarLicencia() {
  const licInput = document.getElementById('lic-key')
    || document.querySelector('textarea#lic-key')
    || document.querySelector('input[placeholder*="ABCD"]')
    || document.querySelector('input[style*="mono"]');
  const key = licInput ? (licInput.value || licInput.textContent || '').trim().replace(/[\r\n\s]+/g, '') : '';
  if (!key) {
    toast('Ingresa la clave de licencia', 'err');
    return;
  }
  const result = await window.api.license.activate({ licenseKey: key, requestUserId: user?.id });
  if (result.ok) {
    toast('✓ Licencia activada correctamente');
    renderConfiguracion(document.getElementById('page'));
  } else {
    toast(result.error || 'Licencia inválida', 'err');
  }
}

// ══════════════════════════════════════════════
// AUDITORÍA
// ══════════════════════════════════════════════
let auditFilter = '';

// ══════════════════════════════════════════════════════════════════════════════
// Sección de configuración e-CF para config.js
// Agregar dentro de renderConfig() después de la sección de NCF existente
// ══════════════════════════════════════════════════════════════════════════════

async function renderECFConfig(container) {
  const cfgRes = await window.api.ecf?.getConfig();
  const cfg    = cfgRes?.ok ? cfgRes.data : {};

  container.innerHTML = `
    <div style="background:var(--bg2);border-radius:12px;padding:18px;border:1px solid var(--line2);margin-top:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="font-size:20px">📄</span>
        <div>
          <div style="font-weight:600;font-size:14px">Facturación Electrónica (e-CF)</div>
          <div style="font-size:11px;color:var(--muted2)">Comprobantes Fiscales Electrónicos — DGII · MSeller ECF</div>
        </div>
        <span style="margin-left:auto;font-size:10px;padding:3px 10px;border-radius:100px;
          background:${cfg.apiKey ? 'rgba(0,192,122,.1)' : 'rgba(239,68,68,.1)'};
          color:${cfg.apiKey ? 'var(--green,#00c07a)' : 'var(--red,#ef4444)'}">
          ${cfg.apiKey ? '● Configurado' : '● Sin configurar'}
        </span>
      </div>

      <div style="display:grid;gap:10px">
        <div class="fg">
          <label class="lbl">Correo de cuenta MSeller</label>
          <input class="inp" id="ecf-email" type="email"
            value="${cfg.email || ''}"
            placeholder="tu@correo.com">
        </div>
        <div class="fg">
          <label class="lbl">Contraseña MSeller ${cfg.hasPassword ? '(guardada ●●●)' : ''}</label>
          <input class="inp" id="ecf-pass" type="password"
            placeholder="${cfg.hasPassword ? 'Dejar vacío para mantener la actual' : 'Contraseña de tu cuenta MSeller'}">
        </div>
        <div class="fg">
          <label class="lbl">API Key</label>
          <input class="inp" id="ecf-apikey" type="text"
            value="${cfg.apiKey || ''}"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
          <div style="font-size:10px;color:var(--muted2);margin-top:3px">
            Obtén tu API Key en: ecf.mseller.app → Configuración → API Keys
          </div>
        </div>
        <div class="fg">
          <label class="lbl">Ambiente</label>
          <select class="inp" id="ecf-env">
            <option value="test"       ${(cfg.environment||'test')==='test'       ? 'selected' : ''}>🧪 Prueba (TesteCF)</option>
            <option value="production" ${cfg.environment==='production' ? 'selected' : ''}>🚀 Producción</option>
          </select>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-dark btn-sm" id="btn-save-ecf">Guardar configuración</button>
        <button class="btn btn-ghost btn-sm" id="btn-test-ecf">Probar conexión</button>
      </div>
      <div id="ecf-status-msg" style="font-size:12px;margin-top:8px;min-height:16px"></div>
    </div>`;

  // Guardar
  container.querySelector('#btn-save-ecf')?.addEventListener('click', async () => {
    const email  = container.querySelector('#ecf-email')?.value.trim();
    const pass   = container.querySelector('#ecf-pass')?.value;
    const apiKey = container.querySelector('#ecf-apikey')?.value.trim();
    const env    = container.querySelector('#ecf-env')?.value;
    const msg    = container.querySelector('#ecf-status-msg');
    if (!email || !apiKey) { msg.style.color='var(--red,#ef4444)'; msg.textContent = '⚠ Correo y API Key son obligatorios'; return; }
    const res = await window.api.ecf.saveConfig({ email, password: pass || undefined, apiKey, environment: env });
    if (res.ok) { msg.style.color='var(--green,#00c07a)'; msg.textContent = '✓ Configuración guardada'; }
    else { msg.style.color='var(--red,#ef4444)'; msg.textContent = `⚠ ${res.error}`; }
  });

  // Probar conexión
  container.querySelector('#btn-test-ecf')?.addEventListener('click', async () => {
    const msg = container.querySelector('#ecf-status-msg');
    msg.style.color = 'var(--muted2)';
    msg.textContent = '⏳ Probando conexión con MSeller...';
    try {
      const logRes = await window.api.ecf.getLog({ limit: 1 });
      if (logRes.ok) {
        msg.style.color = 'var(--green,#00c07a)';
        msg.textContent = '✓ Conexión exitosa con MSeller ECF';
      } else throw new Error(logRes.error);
    } catch(e) {
      msg.style.color = 'var(--red,#ef4444)';
      msg.textContent = `⚠ Error: ${e.message}`;
    }
  });
}
