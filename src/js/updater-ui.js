// ══════════════════════════════════════════════
// updater-ui.js — Panel de actualizaciones UI
// Contiene: _renderUpdPanel, _buscarActualizacion,
//           _descargarActualizacion, _instalarActualizacion,
//           _updFloatingBar, _loadUpdState
// Separado de app.js para mantenibilidad
// ══════════════════════════════════════════════

async function _loadUpdState() {
  try {
    const r = await window.api.updater.getState();
    if (r?.ok) _updState = r.state;
  } catch {}
  return _updState;
}

// Renderizar el panel dentro de la card pasada
async function _renderUpdPanel(card, state) {
  if (!state) {
    state = _updState || await _loadUpdState();
  }
  _updState = state;

  const s      = state || {};
  const isProd = true; // En dev siempre mostramos el panel pero con aviso

  // Determinar color e icono según estado
  const meta = {
    idle:        { color: 'var(--muted)',  icon: svg('clock'),   label: 'Sin verificar' },
    'dev-mode':  { color: 'var(--muted)',  icon: svg('settings'), label: 'Modo desarrollo' },
    checking:    { color: 'var(--blue)',   icon: svg('refresh'), label: 'Verificando...' },
    'up-to-date':{ color: 'var(--green)', icon: svg('check'),   label: 'Al día' },
    available:   { color: 'var(--amber)', icon: svg('alert'),   label: `Versión ${s.availableVersion} disponible` },
    downloading: { color: 'var(--blue)',  icon: svg('download'), label: `Descargando ${s.progress?.percent || 0}%` },
    downloaded:  { color: 'var(--green)', icon: svg('check'),   label: `v${s.downloadedVersion} lista para instalar` },
    error:       { color: 'var(--red)',   icon: svg('alert'),   label: 'Error al verificar' },
  }[s.status] || { color: 'var(--muted)', icon: svg('clock'), label: 'Sin verificar' };

  const lastCheckedStr = s.lastChecked
    ? new Date(s.lastChecked).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
    : 'Nunca';

  card.innerHTML = `
    <div class="fxb mb8">
      <div class="card-title">Actualizaciones</div>
      <span class="badge ${
        s.status === 'up-to-date' || s.status === 'downloaded' ? 'g' :
        s.status === 'available'  || s.status === 'downloading' ? 'a' :
        s.status === 'error'      ? 'r' : 'n'
      }" style="font-size:11px">${
        s.status === 'up-to-date' ? 'Al día' :
        s.status === 'downloaded' ? 'Lista' :
        s.status === 'available'  ? 'Disponible' :
        s.status === 'downloading'? 'Descargando' :
        s.status === 'checking'   ? 'Verificando' :
        s.status === 'error'      ? 'Error' :
        s.status === 'dev-mode'   ? 'Desarrollo' : '—'
      }</span>
    </div>

    <div class="alrt ${
      s.status === 'up-to-date' || s.status === 'downloaded' ? 'g' :
      s.status === 'available'  || s.status === 'downloading' ? 'a' :
      s.status === 'error' ? 'r' : 'n'
    }" style="margin-bottom:12px">
      <div class="alrt-dot ${
        s.status === 'up-to-date' || s.status === 'downloaded' ? 'g' :
        s.status === 'available'  || s.status === 'downloading' ? 'a' :
        s.status === 'error' ? 'r' : 'n'
      }"></div>
      <div style="flex:1">
        <div class="alrt-title" style="color:${meta.color}">${meta.label}</div>
        <div class="alrt-sub">${
          s.status === 'dev-mode'
            ? 'Las actualizaciones automáticas se activan en la versión instalada'
            : s.status === 'error'
            ? s.error || ''
            : 'Última verificación: ' + lastCheckedStr
        }</div>
      </div>
    </div>

    <div class="tr" style="font-size:12px;margin-bottom:4px">
      <span>Versión instalada</span>
      <span style="font-family:var(--mono);font-weight:700">
        v${window._appVersion || '1.5.1'}
      </span>
    </div>
    ${s.availableVersion ? `
    <div class="tr" style="font-size:12px;margin-bottom:4px">
      <span>Versión disponible</span>
      <span style="font-family:var(--mono);font-weight:700;color:var(--amber)">
        v${s.availableVersion}
      </span>
    </div>` : ''}

    ${s.status === 'downloading' && s.progress ? `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:11px;
                  color:var(--muted);margin-bottom:5px">
        <span>Descargando actualización...</span>
        <span>${s.progress.percent}%</span>
      </div>
      <div style="background:var(--line);border-radius:4px;height:6px;overflow:hidden">
        <div style="background:var(--blue);height:6px;border-radius:4px;
                    width:${s.progress.percent}%;transition:width .4s"></div>
      </div>
      <div style="font-size:10px;color:var(--muted2);margin-top:4px;text-align:center">
        ${(s.progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s ·
        ${(s.progress.transferred / 1024 / 1024).toFixed(1)} /
        ${(s.progress.total / 1024 / 1024).toFixed(1)} MB
      </div>
    </div>` : ''}

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
      ${s.status !== 'downloading' && s.status !== 'downloaded' ? `
        <button class="btn btn-out btn-fw" style="font-size:12px"
                onclick="_buscarActualizacion()"
                ${s.status === 'checking' ? 'disabled' : ''}>
          ${s.status === 'checking'
            ? `${svg('refresh')} Verificando...`
            : `${svg('refresh')} Buscar actualización`}
        </button>` : ''}

      ${s.status === 'available' ? `
        <button class="btn btn-dark btn-fw" style="font-size:12px"
                onclick="_descargarActualizacion()">
          ${svg('download')} Descargar v${s.availableVersion}
        </button>` : ''}

      ${s.status === 'downloaded' ? `
        <button class="btn btn-green btn-fw" style="font-size:12px"
                onclick="_instalarActualizacion()">
          ${svg('check')} Instalar v${s.downloadedVersion} y reiniciar
        </button>` : ''}
    </div>`;
}

// Botón "Buscar actualización"
async function _buscarActualizacion() {
  const card = document.getElementById('upd-card');
  if (!card) return;
  _updState = { ..._updState, status: 'checking', lastChecked: new Date().toISOString() };
  _renderUpdPanel(card, _updState);
  const r = await window.api.updater.check();
  if (!r.ok && !r.devMode) {
    // Solo mostrar toast si es un error real, no en modo desarrollo
    toast(r.error || 'No se pudo verificar', 'err');
  }
}

// Botón "Descargar"
async function _descargarActualizacion() {
  await window.api.updater.download();
}

// Botón "Instalar y reiniciar"
async function _instalarActualizacion() {
  // Revisar si hay items en el carrito
  const cartEmpty = !invoices?.some(inv => inv.cart?.length > 0);
  const r = await window.api.updater.install({ cartEmpty });
  if (r?.cancelled) {
    toast('Instalación cancelada — termina las ventas primero', 'w');
  }
}

// ── Barra flotante de progreso (esquina inferior derecha) ──
function _updFloatingBar(state) {
  let bar = document.getElementById('update-progress-bar');

  if (state?.status === 'downloading' && state.progress) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'update-progress-bar';
      bar.style.cssText = [
        'position:fixed', 'bottom:16px', 'right:16px', 'z-index:99999',
        'background:var(--surface)', 'border:1px solid var(--line)',
        'border-radius:10px', 'padding:10px 14px', 'min-width:230px',
        'box-shadow:0 4px 16px rgba(0,0,0,.15)', 'font-size:12px',
      ].join(';');
      document.body.appendChild(bar);
    }
    const p  = state.progress;
    const mb = (p.bytesPerSecond / 1024 / 1024).toFixed(1);
    bar.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;color:var(--text)">
        Descargando actualización…
      </div>
      <div style="background:var(--line);border-radius:4px;height:6px;margin-bottom:5px">
        <div style="background:var(--blue);height:6px;border-radius:4px;
                    width:${p.percent}%;transition:.3s"></div>
      </div>
      <div style="color:var(--muted);display:flex;justify-content:space-between">
        <span>${p.percent}%</span>
        <span>${mb} MB/s</span>
      </div>`;
  } else if (state?.status === 'downloaded') {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'update-progress-bar';
      bar.style.cssText = [
        'position:fixed', 'bottom:16px', 'right:16px', 'z-index:99999',
        'background:var(--surface)', 'border:1px solid var(--green)',
        'border-radius:10px', 'padding:10px 14px', 'min-width:230px',
        'box-shadow:0 4px 16px rgba(0,0,0,.15)', 'font-size:12px',
      ].join(';');
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px;color:var(--green)">
        ✓ Actualización lista
      </div>
      <div style="color:var(--muted);font-size:11px;margin-bottom:8px">
        v${state.downloadedVersion} — se instala al cerrar
      </div>
      <button onclick="routeTo('configuracion')"
              style="font-size:11px;padding:4px 10px;border-radius:6px;
                     background:var(--green);color:#fff;border:none;cursor:pointer;width:100%">
        Ver panel de actualizaciones
      </button>`;
  } else {
    bar?.remove();
  }
}

async function seleccionarPlantilla(id) {
  _plantSeleccionada = id;

  // Actualizar UI — resaltar seleccionada
  document.querySelectorAll('[id^="plant-card-"]').forEach(el => {
    const isSelected = el.id === `plant-card-${id}`;
    el.style.border    = `2px solid ${isSelected ? 'var(--green)' : 'var(--line)'}`;
    el.style.background = isSelected ? 'var(--green-bg)' : 'var(--surface)';
  });

  // Guardar en settings
  await window.api.settings.set({ key: 'print_template', value: id });
  if (DB?.settings) DB.settings.print_template = id;

  toast(`✓ Plantilla "${getPlantilla(id)?.nombre}" seleccionada`);

  // Mostrar vista previa automáticamente
  previsualizarPlantilla(id);
}

function previsualizarPlantilla(id) {
  const plantId  = id || _plantSeleccionada || DB?.settings?.print_template || 'termica_80_clasica';
  const plantilla = getPlantilla(plantId);
  if (!plantilla) return;

  const cfg = {
    biz_name:    DB?.settings?.biz_name    || CFG?.biz    || 'Mi Negocio',
    biz_rnc:     DB?.settings?.biz_rnc     || CFG?.rnc    || '101-00000-0',
    biz_addr:    DB?.settings?.biz_addr    || CFG?.addr   || 'Calle Principal #1',
    biz_phone:   DB?.settings?.biz_phone   || CFG?.phone  || '809-555-0000',
    biz_logo:    DB?.settings?.biz_logo    || CFG?.biz_logo || '',
    receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
  };

  const sale    = getSampleSale(cfg);
  const opts    = plantilla.opciones;
  const html    = plantilla.render(sale, cfg, opts);

  const preview = document.getElementById('plant-preview');
  const iframe  = document.getElementById('plant-iframe');
  if (preview && iframe) {
    preview.style.display = 'block';
    iframe.srcdoc = html;
  }
}

async function imprimirPruebaPlantilla() {
  const plantId   = _plantSeleccionada || DB?.settings?.print_template || 'termica_80_clasica';
  const plantilla = getPlantilla(plantId);
  if (!plantilla) { toast('Selecciona una plantilla primero', 'err'); return; }

  const cfg = {
    biz_name:    DB?.settings?.biz_name    || 'Mi Negocio',
    biz_rnc:     DB?.settings?.biz_rnc     || '101-00000-0',
    biz_addr:    DB?.settings?.biz_addr    || 'Calle Principal #1',
    biz_phone:   DB?.settings?.biz_phone   || '809-555-0000',
    biz_logo:    DB?.settings?.biz_logo    || '',
    receipt_msg: DB?.settings?.receipt_msg || '¡Gracias por su compra!',
  };

  const sale = getSampleSale(cfg);
  const html = plantilla.render(sale, cfg, plantilla.opciones);

  const result = await window.api.print.html({
    html,
    printerName: DB?.settings?.printer || '',
    jobType:     'prueba_plantilla',
    referenceId: 0,
    userId:      user?.id,
  });

  if (result.ok) {
    toast(`✓ Prueba de "${plantilla.nombre}" enviada a la impresora`);
  } else {
    toast(result.error || 'Error al imprimir', 'err');
  }
}
