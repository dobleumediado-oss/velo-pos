// ══════════════════════════════════════════════
// updater-ui.js — Panel de actualizaciones UI
// Contiene: _renderUpdPanel, _buscarActualizacion,
//           _descargarActualizacion, _instalarActualizacion,
//           _updFloatingBar, _loadUpdState
// Separado de app.js para mantenibilidad
// ══════════════════════════════════════════════

// Cache del estado del updater en el renderer.
let _updState = null;

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
        v${window._appVersion || '1.5.2'}
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
                id="upd-check-btn"
                ${s.status === 'checking' ? 'disabled' : ''}>
          ${s.status === 'checking'
            ? `${svg('refresh')} Verificando...`
            : `${svg('refresh')} Buscar actualización`}
        </button>` : ''}

      ${s.status === 'available' ? `
        <button class="btn btn-dark btn-fw" style="font-size:12px"
                id="upd-download-btn">
          ${svg('download')} Descargar v${s.availableVersion}
        </button>` : ''}

      ${s.status === 'downloaded' ? `
        <button class="btn btn-green btn-fw" style="font-size:12px"
                id="upd-install-btn">
          ${svg('check')} Instalar v${s.downloadedVersion} y reiniciar
        </button>` : ''}
    </div>`;

  card.querySelector('#upd-check-btn')?.addEventListener('click', _buscarActualizacion);
  card.querySelector('#upd-download-btn')?.addEventListener('click', _descargarActualizacion);
  card.querySelector('#upd-install-btn')?.addEventListener('click', _instalarActualizacion);
}

// Botón "Buscar actualización"
async function _buscarActualizacion() {
  const card = document.getElementById('upd-card');
  if (!card) return;

  if (!window.api?.updater?.check) {
    toast('El módulo de actualizaciones no está disponible', 'err');
    return;
  }

  _updState = {
    ...(_updState || {}),
    status: 'checking',
    error: null,
    lastChecked: new Date().toISOString(),
  };
  await _renderUpdPanel(card, _updState);

  try {
    const r = await window.api.updater.check();
    if (r?.state) {
      _updState = r.state;
      await _renderUpdPanel(card, _updState);
      _updFloatingBar(_updState);
    } else {
      await _renderUpdPanel(card, await _loadUpdState());
    }

    if (!r?.ok && !r?.devMode) {
      toast(r?.error || 'No se pudo verificar la actualización', 'err');
      return;
    }
    if (r?.devMode) {
      toast('Las actualizaciones se verifican en la app instalada, no en desarrollo', 'w');
      return;
    }
    if (_updState?.status === 'up-to-date') {
      toast('✓ Ya estás al día');
    }
  } catch (e) {
    _updState = {
      ...(_updState || {}),
      status: 'error',
      error: e.message || 'No se pudo verificar',
      lastChecked: new Date().toISOString(),
    };
    await _renderUpdPanel(card, _updState);
    toast(_updState.error, 'err');
  }
}

// Botón "Descargar"
async function _descargarActualizacion() {
  const r = await window.api.updater.download();
  if (!r?.ok) toast(r?.error || 'No se pudo iniciar la descarga', 'err');
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
      <button id="upd-open-config-btn"
              style="font-size:11px;padding:4px 10px;border-radius:6px;
                     background:var(--green);color:#fff;border:none;cursor:pointer;width:100%">
        Ver panel de actualizaciones
      </button>`;
    bar.querySelector('#upd-open-config-btn')?.addEventListener('click', () => routeTo('configuracion'));
  } else {
    bar?.remove();
  }
}
