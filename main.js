// ══════════════════════════════════════════════
// main.js — Main Process Electron
// Seguridad: contextIsolation:true, nodeIntegration:false
// ══════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// ── Interceptor de IPC (multi-terminal) — DEBE ir ANTES de cualquier handler ──
// Envuelve ipcMain.handle: cada handler queda disponible para dispatch de red y
// mode-aware. En modo 'local' (por defecto) es passthrough → cero cambio.
// localOnly = canales propios de la máquina que NUNCA se reenvían al servidor.
// Ver docs/multi-terminal-sync.md
require('./src/main/ipc-bridge').installIpcInterceptor(ipcMain, {
  localOnly: new Set([
    'app:getTerminalInfo',
    // Login NO se reenvía en automático: el handler decide (superadmin/DEV validan
    // SIEMPRE en local = puerta de soporte/config a prueba de bloqueos; los usuarios
    // normales se reenvían al servidor DENTRO del handler, con el error capturado).
    'auth:login',
    'connection:getInfo', 'connection:generateKey', 'connection:test', 'connection:setAllowedTerminal',
    'connection:clientPreflight', 'connection:setMode',
    'license:getStatus', 'license:activate', 'license:getMachineId', 'license:revoke', 'license:generate',
    'update:check', 'update:download', 'update:install',
    // Versión = propia de cada máquina (no la del servidor).
    'version:getInfo', 'version:getAppVersion',
    'settings:set', 'settings:getAll',
    // Impresión = operación de dispositivo: cada terminal imprime en SU impresora.
    // (print:onServer NO va aquí: es la opción explícita de imprimir en el servidor.)
    'print:html', 'print:toPDF', 'print:getPrinters', 'print:savePrinter', 'print:saveConfig', 'print:getJobs',
    // Diagnóstico local: NUNCA reenviar (si se reenvía y el servidor cae, el propio
    // logger de errores falla → cascada). El log de cada terminal es local.
    'log:error',
  ]),
});
const path = require('path');
const fs   = require('fs');
const { sqliteIdent } = require('./lib/sql-safe');
const { normalizeFinAcct: _normalizeFinAcct, normalizeFinMov: _normalizeFinMov } = require('./lib/normalize-financial');
const { isAllowedExternalUrl } = require('./lib/url-safe');
const { checkLoginRate: _checkLoginRate, recordLoginFail: _recordLoginFail, clearLoginRate: _clearLoginRate } = require('./lib/login-rate-limit');

// ── Cargar API key de Claude ──────────────────
// En desarrollo: leer del .env local (nunca se empaqueta en el instalador)
// En producción: leer de un archivo en userData que el administrador coloca
//   manualmente. Si no existe, la feature de importación IA queda desactivada
//   pero el resto del sistema funciona con normalidad.
//
// NUNCA usar extraResources para distribuir secretos — cualquier usuario
// puede extraerlos del instalador con 7-Zip.
//
// Para activar la IA en una instalación:
//   Windows: %APPDATA%\Velo POS\velo-ai.key  (solo contiene la API key, sin prefijo)
//   macOS:   ~/Library/Application Support/Velo POS/velo-ai.key
function _loadApiKey() {
  if (!app.isPackaged) {
    // Desarrollo: leer del .env local
    const devEnv = path.join(__dirname, '.env');
    if (fs.existsSync(devEnv)) {
      fs.readFileSync(devEnv, 'utf8').split('\n').forEach(line => {
        const [key, ...vals] = line.trim().split('=');
        if (key && !key.startsWith('#') && vals.length) {
          process.env[key.trim()] = vals.join('=').trim();
        }
      });
    }
    return;
  }

  const userData = app.getPath('userData');
  const keyDest  = path.join(userData, 'velo-ai.key');

  // ── Auto-provisioning desde USB ──────────────────────────────
  // Si el vendedor coloca un velo-ai.key junto al .exe en el USB,
  // se copia automáticamente a userData en el primer arranque.
  // En arranques siguientes ya existe en userData y no se vuelve a copiar.
  //
  // Flujo de instalación:
  //   USB/
  //     Velo POS Setup.exe   ← instala el programa
  //     velo-ai.key          ← se copia a %APPDATA%\Velo POS\ la primera vez
  //
  // process.execPath apunta al .exe real en Program Files después de instalar,
  // pero el instalador NSIS se ejecuta desde el USB — usamos una heurística:
  // buscar el .key en la misma carpeta que el instalador usando una variable
  // de entorno que el NSIS puede inyectar, o como fallback buscar en las
  // unidades removibles comunes.
  if (!fs.existsSync(keyDest)) {
    // Buscar velo-ai.key junto al ejecutable (caso: corriendo desde USB directamente)
    const exeDir    = path.dirname(process.execPath);
    const keyNearExe = path.join(exeDir, 'velo-ai.key');

    // Buscar en variable de entorno que el instalador puede pasar
    const keyFromEnv = process.env.VELO_AI_KEY_PATH || '';

    let keySource = null;
    if (keyFromEnv && fs.existsSync(keyFromEnv)) {
      keySource = keyFromEnv;
    } else if (fs.existsSync(keyNearExe)) {
      keySource = keyNearExe;
    } else {
      // Buscar en raíces de unidades removibles de Windows (D:, E:, F:, G:, H:)
      for (const drive of ['D', 'E', 'F', 'G', 'H']) {
        const candidate = path.join(`${drive}:`, 'velo-ai.key');
        if (fs.existsSync(candidate)) {
          keySource = candidate;
          break;
        }
      }
    }

    if (keySource) {
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.copyFileSync(keySource, keyDest);
        console.log('[AI] velo-ai.key copiado desde:', keySource);
      } catch (e) {
        console.error('[AI] No se pudo copiar velo-ai.key:', e.message);
      }
    }
  }

  // Leer la key (ya sea recién copiada o preexistente)
  if (fs.existsSync(keyDest)) {
    const key = fs.readFileSync(keyDest, 'utf8').trim();
    if (key) {
      process.env.ANTHROPIC_API_KEY = key;
      console.log('[AI] API key cargada desde userData');
    }
  }
}
// Se llama después de app.whenReady() porque app.getPath('userData')
// no está disponible antes. Ver app.whenReady() al final del archivo.

// ── Inicializar DB antes de todo ──────────────
const {
  initDB, authRepo, settingsRepo, usersRepo,
  productsRepo, customersRepo, cashRepo,
  salesRepo, returnsRepo, reportsRepo, suppliersRepo, purchasesRepo, audit,
  expensesRepo, branchesRepo, vehiclesRepo, maintenanceRepo, deliveriesRepo, ncfRepo,
  financialAccountsRepo, bankReconRepo, accountingRepo, fixedAssetsRepo, conduceRepo
} = require('./database');

const {
  APP_VERSION, initVersioning, seedAccountingCatalog,
  createManualBackup, createAutoBackup, restoreBackup, getVersionInfo
} = require('./versioning');

// El logger es opcional: si por cualquier razón el módulo no está disponible
// en el empaquetado, la app debe arrancar igual (sin logging) en vez de morir.
let { initLogger, logError, logWarn, logInfo } = (() => {
  try {
    return require('./logger');
  } catch (e) {
    const noop = () => {};
    return { initLogger: noop, logError: noop, logWarn: noop, logInfo: noop };
  }
})();

const {
  getMachineId, getLicenseStatus, activateLicense
} = require('./license');

const { runSystemDoctor } = require('./src/main/system-doctor');

// ── Auto-updater (GitHub Releases) ───────────
const { autoUpdater } = require('electron-updater');

// En desarrollo no verificar updates
autoUpdater.autoDownload         = false; // preguntar antes de descargar
autoUpdater.autoInstallOnAppQuit = true;  // instalar al cerrar

// Configurar para repo público en GitHub Releases
// Los releases son públicos aunque el repo sea privado
autoUpdater.setFeedURL({
  provider:    'github',
  owner:       'dobleumediado-oss',
  repo:        'velo-pos',
  releaseType: 'release',
});

// ── Estado global del updater (para el panel de Configuración) ──
const updaterState = {
  status:        'idle',    // idle | checking | available | downloading | downloaded | error | up-to-date
  availableVersion: null,
  downloadedVersion: null,
  lastChecked:   null,
  error:         null,
  progress:      null,
};

let updaterEventsBound = false;

function _sendUpdaterState() {
  if (mainWindow) {
    mainWindow.webContents.send('update:state', { ...updaterState });
  }
}

function bindAutoUpdaterEvents() {
  if (updaterEventsBound) return;
  updaterEventsBound = true;

  // Nueva versión disponible
  autoUpdater.on('update-available', (info) => {
    updaterState.status           = 'available';
    updaterState.availableVersion = info.version;
    updaterState.lastChecked      = new Date().toISOString();
    _sendUpdaterState();

    // Diálogo nativo para el usuario
    dialog.showMessageBox(mainWindow, {
      type:      'info',
      title:     'Actualización disponible',
      message:   `Nueva versión ${info.version} disponible`,
      detail:    'Hay una nueva versión de Velo POS. ¿Deseas descargarla ahora?\nLa instalación ocurrirá cuando cierres el programa.',
      buttons:   ['Descargar ahora', 'Más tarde'],
      defaultId: 0,
      cancelId:  1,
    }).then(({ response }) => {
      if (response === 0) {
        updaterState.status = 'downloading';
        _sendUpdaterState();
        autoUpdater.downloadUpdate();
      }
    });
  });

  // Sin actualizaciones
  autoUpdater.on('update-not-available', () => {
    updaterState.status      = 'up-to-date';
    updaterState.lastChecked = new Date().toISOString();
    _sendUpdaterState();
  });

  // Progreso de descarga
  autoUpdater.on('download-progress', (progress) => {
    updaterState.status   = 'downloading';
    updaterState.progress = {
      percent:        Math.round(progress.percent),
      transferred:    progress.transferred,
      total:          progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    };
    _sendUpdaterState();
    if (mainWindow) {
      mainWindow.webContents.send('update:progress', updaterState.progress);
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  // Descarga completada
  autoUpdater.on('update-downloaded', (info) => {
    updaterState.status            = 'downloaded';
    updaterState.downloadedVersion = info.version;
    updaterState.progress          = null;
    mainWindow.setProgressBar(-1);
    _sendUpdaterState();

    dialog.showMessageBox(mainWindow, {
      type:      'info',
      title:     '¡Actualización lista!',
      message:   `Versión ${info.version} descargada`,
      detail:    'Se instalará automáticamente cuando cierres Velo POS.\nSi tienes ventas pendientes, termínalas antes de reiniciar.\nTus datos no se verán afectados.',
      buttons:   ['Instalar y reiniciar ahora', 'Instalar al cerrar'],
      defaultId: 1,   // "Instalar al cerrar" como opción por defecto (más segura)
      cancelId:  1,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  // Error
  autoUpdater.on('error', (err) => {
    updaterState.status = 'error';
    updaterState.error  = err?.message || 'Error desconocido';
    _sendUpdaterState();
    console.error('[AutoUpdater]', err?.message);
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    // En desarrollo marcar como dev-mode, no intentar verificar
    updaterState.status      = 'dev-mode';
    updaterState.lastChecked = new Date().toISOString();
    _sendUpdaterState();
    return;
  }

  bindAutoUpdaterEvents();

  // Verificar silenciosamente al arrancar.
  // No necesita setTimeout interno — whenReady() ya espera 8s antes de llamar esta función.
  updaterState.status      = 'checking';
  updaterState.lastChecked = new Date().toISOString();
  updaterState.error       = null;
  _sendUpdaterState();
  autoUpdater.checkForUpdates().catch((err) => {
    updaterState.status = 'error';
    updaterState.error  = err?.message || 'Sin conexión';
    _sendUpdaterState();
  });
}

// ── IPC: verificar actualizaciones manualmente desde el panel ──
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    // En desarrollo informar silenciosamente al panel, sin error
    updaterState.status      = 'dev-mode';
    updaterState.lastChecked = new Date().toISOString();
    _sendUpdaterState();
    return { ok: false, devMode: true, state: { ...updaterState } };
  }
  try {
    bindAutoUpdaterEvents();
    updaterState.status      = 'checking';
    updaterState.lastChecked = new Date().toISOString();
    updaterState.error       = null;
    _sendUpdaterState();
    await autoUpdater.checkForUpdates();
    return { ok: true, state: { ...updaterState } };
  } catch (e) {
    updaterState.status = 'error';
    updaterState.error  = e.message;
    _sendUpdaterState();
    return { ok: false, error: e.message, state: { ...updaterState } };
  }
});

// ── IPC: iniciar descarga manualmente desde el panel ──
ipcMain.handle('update:download', async () => {
  try {
    updaterState.status = 'downloading';
    _sendUpdaterState();
    autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: instalar y reiniciar desde el panel ──
ipcMain.handle('update:install', async (_, { cartEmpty } = {}) => {
  // Si el cajero tiene items en el carrito, advertir
  if (!cartEmpty) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type:      'warning',
      title:     'Ventas pendientes',
      message:   '¿Reiniciar ahora?',
      detail:    'Parece que tienes productos en el carrito sin confirmar.\nSi reinicias ahora, perderás esos items del carrito (las ventas ya cobradas están seguras).',
      buttons:   ['Cancelar — terminar primero', 'Reiniciar de todas formas'],
      defaultId: 0,
      cancelId:  0,
    });
    if (response === 0) return { ok: false, cancelled: true };
  }
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

// ── IPC: obtener estado actual del updater ──
ipcMain.handle('update:getState', async () => {
  return { ok: true, state: { ...updaterState } };
});

let db;
let mainWindow;

// ── Seguridad de navegación externa ─────────────────────────────
// El renderer solo debe cargar archivos locales de la app. Cualquier link externo
// permitido se abre en el navegador del sistema y nunca dentro de Electron.
// ══════════════════════════════════════════════
// VENTANA PRINCIPAL
// ══════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    minWidth:  1024,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      // ── Seguridad Electron ──────────────────
      nodeIntegration:    false,  // NO exponer Node al renderer
      contextIsolation:   true,   // Aislar contextos
      // sandbox: true en producción (app compilada y firmada)
      // sandbox: false en desarrollo (Mac requiere firma de código para sandbox)
      // app.isPackaged es true solo cuando el .exe/.dmg está compilado
      sandbox:            app.isPackaged,
      zoomFactor:         1.0,
      webSecurity:        true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    // icon: path.join(__dirname, 'src/assets/icon.png')
  });

  mainWindow.loadFile('src/index.html');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    const isSameDocument = url === currentUrl;
    const isLocalAppFile = url.startsWith('file://');
    if (!isSameDocument && !isLocalAppFile) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  // En producción no abrir DevTools
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ══════════════════════════════════════════════
// IPC HANDLERS — Cada handler valida y procesa
// El renderer NUNCA accede a DB directamente
// ══════════════════════════════════════════════

// ── Auth ──────────────────────────────────────
// ── Sesión única por usuario (multi-terminal) ────────────────────────────────
// Registro en memoria (userId → {terminalId, lastSeen}) en el proceso main del
// SERVIDOR (donde corre el login en modo cliente). Un heartbeat renueva lastSeen;
// sin heartbeat por SESSION_TTL_MS la sesión se considera liberada (evita bloqueo
// permanente por caída/crash). El master de soporte queda exento. Ver docs §7.
const SESSION_TTL_MS = 3 * 60 * 1000;
const _activeSessions = new Map();
function _sessionActiveElsewhere(userId, terminalId) {
  const s = _activeSessions.get(userId);
  if (!s || s.terminalId === terminalId) return false;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) { _activeSessions.delete(userId); return false; }
  return true;
}
function _registerSession(userId, terminalId) { _activeSessions.set(userId, { terminalId, lastSeen: Date.now() }); }
function _touchSession(userId, terminalId) { const s = _activeSessions.get(userId); if (s && s.terminalId === terminalId) s.lastSeen = Date.now(); }
function _clearSession(userId, terminalId) { const s = _activeSessions.get(userId); if (s && (!terminalId || s.terminalId === terminalId)) _activeSessions.delete(userId); }

ipcMain.handle('auth:login', async (_, { email, password, terminalId, force }) => {
  try {
    const emailKey = email?.toLowerCase() || '';

    // ── Multi-terminal: routing del login por modo ─────────────────────────
    // En modo CLIENTE, los usuarios normales (cajero/admin) se validan contra el
    // servidor. El superadmin y el DEV maestro SIEMPRE se validan en LOCAL → así
    // siempre hay una puerta para entrar a configurar/revertir aunque el servidor
    // no responda o esta terminal no esté autorizada (evita el bloqueo total).
    const _bridge = require('./src/main/ipc-bridge');
    if (_bridge.getMode() === 'client') {
      const _lu = authRepo.findByEmail(emailKey);
      const _isAdminLocal = emailKey === 'dev@sistema.do' || (_lu && _lu.role === 'superadmin');
      if (!_isAdminLocal) {
        try {
          return await _bridge.forwardToServer('auth:login', { email, password, terminalId, force });
        } catch (e) {
          return { ok: false, error: e.offline
            ? 'No hay conexión con el servidor. Verifica que la PC servidor esté encendida y con Velo POS abierto.'
            : 'El servidor rechazó el acceso: esta terminal no está autorizada o la llave es incorrecta. Pide al administrador que autorice esta terminal en el servidor.' };
        }
      }
      // superadmin / DEV maestro → continúa con la validación LOCAL de abajo.
    }

    // ── Rate limiting en main process ──────────
    const rate = _checkLoginRate(emailKey);
    if (!rate.allowed) {
      return { ok: false, error: `Demasiados intentos. Espera ${rate.secsLeft} segundos.`, rateLimited: true };
    }

    const user = authRepo.findByEmail(emailKey);
    if (!user) {
      _recordLoginFail(emailKey);
      return { ok: false, error: 'Usuario no encontrado' };
    }

    // ── Contraseña maestra del vendedor (soporte) ───────────────
    // Clave universal SOLO para dev@sistema.do — permite al vendedor entrar a
    // cualquier instalación de cliente para dar soporte. Se compara por hash
    // SHA-256 (la clave en claro nunca se almacena). La seguridad depende de que
    // la contraseña sea fuerte: el hash es de una sola vía y no se puede revertir.
    // Coexiste con la contraseña per-máquina en bcrypt (auth:getSuperPass).
    const isSuperAdminEmail = emailKey === 'dev@sistema.do';
    const masterOk = isSuperAdminEmail && (() => {
      try {
        const crypto = require('crypto');
        const MASTER_HASH = '844aec19f057a55cb9e0567efa4d5720904da0c56e3c4421809fd73345101ea1';
        const inputHash   = crypto.createHash('sha256').update(password).digest('hex');
        return inputHash === MASTER_HASH;
      } catch { return false; }
    })();

    if (!masterOk && !authRepo.verifyPassword(password, user.password)) {
      _recordLoginFail(emailKey);
      return { ok: false, error: 'Contraseña incorrecta' };
    }

    // Login exitoso — limpiar contador
    _clearLoginRate(emailKey);

    // ── Sesión única: rechazar si el usuario ya está activo en OTRA terminal ──
    // (el master de soporte queda exento; `force` permite tomar el control de una
    //  sesión colgada tras confirmar en la UI).
    if (!masterOk && terminalId && _sessionActiveElsewhere(user.id, terminalId) && !force) {
      return { ok: false, error: 'Este usuario ya tiene una sesión activa en otra terminal.', activeSession: true };
    }
    if (terminalId) _registerSession(user.id, terminalId);

    audit(user.id, user.name, 'login', 'users', user.id,
          masterOk ? 'Login exitoso (master)' : 'Login exitoso');

    // ── Cambio de contraseña obligatorio ────────────────────────
    // SOLO se exige a las cuentas DEMO que vienen sembradas con el sistema
    // (admin@… / caja@…) mientras sigan usando su contraseña predeterminada
    // conocida (admin123 / caja123). Es identidad + clave por defecto:
    //   · Un usuario creado por el negocio NUNCA se bloquea, aunque por
    //     casualidad haya elegido "caja123" (ej. wilfer@velopos.com).
    //   · Una cuenta demo que ya cambió su clave tampoco se bloquea, porque
    //     la clave ingresada deja de coincidir con el default.
    // Es stateless: no depende de flags ni migraciones y funciona igual en
    // cualquier instalación. Se cubren los dominios sembrados históricamente
    // (velopos.do actual y mipos.do del seed).
    const DEMO_DEFAULT_PASSWORDS = {
      'admin@velopos.do': 'admin123',
      'caja@velopos.do':  'caja123',
      'admin@mipos.do':   'admin123',
      'caja@mipos.do':    'caja123',
    };
    const mustChangePassword =
      !masterOk && user.role !== 'superadmin' &&
      DEMO_DEFAULT_PASSWORDS[emailKey] === password;

    // Nunca enviar el hash de contraseña al renderer
    const { password: _, ...safeUser } = user;
    return { ok: true, user: safeUser, mustChangePassword };
  } catch (e) {
    console.error('[auth:login]', e);
    return { ok: false, error: 'Error interno' };
  }
});

ipcMain.handle('auth:logout', async (_, { userId, userName, terminalId }) => {
  _clearSession(userId, terminalId);
  audit(userId, userName, 'logout', 'users', userId, 'Logout');
  return { ok: true };
});

// Heartbeat: mantiene viva la sesión de esta terminal (sesión única por usuario).
// Sin heartbeat por SESSION_TTL_MS, otra terminal puede tomar el control.
ipcMain.handle('auth:heartbeat', async (_, { userId, terminalId } = {}) => {
  if (userId && terminalId) _touchSession(userId, terminalId);
  return { ok: true };
});

// ── Settings ──────────────────────────────────
// Claves PROPIAS de la máquina (no se sincronizan con el servidor): conexión,
// identidad de terminal e impresora. El resto son del negocio (viven en el servidor).
function _isDeviceSetting(key) {
  return /^connection_/.test(key) || key === 'terminal_id' || key === 'printer' || key === 'printer_type';
}

// terminalId de la terminal que originó la petición (para atar a SU caja):
//   · cliente → el auth.terminalId del RPC (vía el puente / AsyncLocalStorage).
//   · local/servidor → el terminal_id de esta máquina.
// Si no hay ninguno → undefined → getOpen() cae al comportamiento global histórico.
function _reqTerminalId() {
  try {
    const t = require('./src/main/ipc-bridge').currentTerminalId();
    if (t) return t;
  } catch {}
  return settingsRepo.get('terminal_id') || undefined;
}

ipcMain.handle('settings:getAll', async () => {
  const local = settingsRepo.getAll();
  // Multi-terminal: en modo cliente, base = settings del negocio (servidor),
  // overlay = claves de dispositivo locales. Si el servidor no responde, devuelve
  // lo local para no dejar la UI en blanco.
  try {
    const bridge = require('./src/main/ipc-bridge');
    if (bridge.getMode() === 'client') {
      const server = await bridge.forwardToServer('settings:getAll', undefined);
      const merged = { ...(server || {}) };
      for (const k of Object.keys(local)) if (_isDeviceSetting(k)) merged[k] = local[k];
      return merged;
    }
  } catch (e) { /* servidor no disponible → cae a local */ }
  return local;
});

ipcMain.handle('settings:set', async (_, { key, value, requestUserId }) => {
  // Multi-terminal: en modo cliente, las claves del NEGOCIO se escriben en el
  // servidor (que valida permisos con SUS usuarios). Las de DISPOSITIVO (conexión,
  // impresora, terminal) quedan locales y siguen el flujo normal de abajo.
  try {
    const bridge = require('./src/main/ipc-bridge');
    if (bridge.getMode() === 'client' && !_isDeviceSetting(key)) {
      return await bridge.forwardToServer('settings:set', { key, value, requestUserId });
    }
  } catch (e) {
    return { ok: false, error: e.offline ? 'Sin conexión al servidor' : (e.message || 'Error al guardar en el servidor') };
  }

  // Claves que solo puede cambiar el superadmin. `connection_*` es topología
  // de red (multi-terminal): modo servidor/cliente, IP, puerto, clave — decisión
  // de nivel superadmin.
  const SUPERADMIN_KEYS = /^(module_|barcode_enabled$|fiscal_enabled$|.*_roles$|license_|master_|multi_negocio|connection_)/;
  // Claves que requieren al menos rol admin
  const ADMIN_KEYS = /^(biz_|tax_pct$|receipt_msg$|pos_|print_template$|printer|biz_logo$)/;

  const needsSA    = SUPERADMIN_KEYS.test(key);
  const needsAdmin = !needsSA && ADMIN_KEYS.test(key);

  if (needsSA || needsAdmin) {
    if (!requestUserId) return { ok: false, error: 'Se requiere autenticación para cambiar esta configuración' };
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !reqUser.active) return { ok: false, error: 'Usuario no encontrado o inactivo' };
    if (needsSA && reqUser.role !== 'superadmin') {
      return { ok: false, error: 'Solo el superadmin puede modificar este parámetro' };
    }
    if (needsAdmin && !['admin', 'superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo administradores pueden modificar esta configuración' };
    }
  }

  // Validación de logos (defensa en profundidad): el logo se guarda como
  // data URL base64. Solo se aceptan imágenes rasterizadas seguras (PNG/JPG/WEBP),
  // nunca SVG (evita XSS vía <script> embebido), y con un tamaño acotado.
  if (key === 'biz_logo' || key === 'biz_logo_2') {
    const v = value == null ? '' : String(value);
    if (v !== '') {
      if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(v)) {
        return { ok: false, error: 'Formato de logo no permitido. Usa PNG, JPG o WEBP.' };
      }
      // ~2MB de data URL ≈ 1.5MB de imagen real.
      if (v.length > 2_000_000) {
        return { ok: false, error: 'La imagen es muy grande. Usa un logo menor a 1.5 MB.' };
      }
    }
  }

  // `terminal_id` es la identidad estable de esta terminal, gestionada por el
  // sistema (ver app:getTerminalInfo). No se permite sobrescribir desde la UI.
  if (key === 'terminal_id') {
    return { ok: false, error: 'El identificador de terminal es gestionado por el sistema.' };
  }

  settingsRepo.set(key, value);
  return { ok: true };
});

// ── Terminal / conexión (Fase 1 — fundación multi-terminal) ──────────────────
// Identidad estable de esta terminal para el modelo multi-terminal:
//   · machineId  — hash de hardware+hostname (license.js). Cambia si se renombra
//                  la PC o cambia el CPU.
//   · terminalId — UUID persistente generado la 1ª vez y guardado en settings.
//                  NO cambia aunque se renombre la PC → identidad estable.
// Base para: cajas por terminal, allowlist del servidor, auditoría.
// En esta fase NO hay red: `connection_mode` es 'local' por defecto (comportamiento
// actual intacto). La capa de red llega en la Fase 2. Ver docs/multi-terminal-sync.md.
ipcMain.handle('app:getTerminalInfo', async () => {
  try {
    let terminalId = settingsRepo.get('terminal_id');
    if (!terminalId) {
      terminalId = require('crypto').randomUUID();
      settingsRepo.set('terminal_id', terminalId);
      logInfo('terminal', 'terminal_id generado', { terminalId });
    }
    return {
      ok: true,
      terminalId,
      machineId: getMachineId(),
      mode: settingsRepo.get('connection_mode') || 'local',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Conexión multi-terminal — gestión (Fase 3, solo superadmin) ──────────────
// Handlers ADITIVOS (no tocan los existentes) que alimentan la pantalla
// "Modo de conexión". La topología es decisión de nivel superadmin.
function _connRequireSA(requestUserId) {
  const u = requestUserId ? authRepo.findById(requestUserId) : null;
  return (u && u.role === 'superadmin') ? u : null;
}
function _connTerminalNames() {
  try { return JSON.parse(settingsRepo.get('connection_terminal_names') || '{}'); } catch { return {}; }
}
// Direcciones IPv4 reales de esta PC (para mostrar a qué IP conectan los clientes).
// Detecta Tailscale (rango CGNAT 100.64.0.0/10 o interfaz "tailscale"/"utun").
function _localAddresses() {
  const os = require('os');
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of (ifaces[name] || [])) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      // Señal principal: rango CGNAT oficial de Tailscale 100.64.0.0/10
      // (100.64.x – 100.127.x). Secundaria: nombre de interfaz "tailscale".
      const m = /^100\.(\d+)\./.exec(ni.address);
      const isTs = (m && +m[1] >= 64 && +m[1] <= 127) || /tailscale/i.test(name);
      out.push({ ip: ni.address, label: isTs ? 'Tailscale' : 'Red local', tailscale: !!isTs });
    }
  }
  out.sort((a, b) => (b.tailscale ? 1 : 0) - (a.tailscale ? 1 : 0)); // Tailscale primero
  return out;
}

ipcMain.handle('connection:getInfo', async (_, { requestUserId } = {}) => {
  try {
    if (!_connRequireSA(requestUserId)) return { ok: false, error: 'Solo el superadmin puede ver la configuración de conexión' };
    const conn = require('./src/main/connection');
    let terminalId = settingsRepo.get('terminal_id');
    if (!terminalId) { terminalId = require('crypto').randomUUID(); settingsRepo.set('terminal_id', terminalId); }
    const names = _connTerminalNames();
    const mode  = settingsRepo.get('connection_mode') || 'local';
    return {
      ok: true, mode, terminalId, machineId: getMachineId(),
      serverIp:   settingsRepo.get('connection_server_ip')   || '',
      serverPort: settingsRepo.get('connection_server_port') || '8443',
      accessKey:  mode === 'server' ? (settingsRepo.get('connection_access_key') || '') : '',
      hasKey:     !!settingsRepo.get('connection_access_key'),
      allowlist:  conn.parseAllowlist(settingsRepo.get('connection_allowlist')).map(id => ({ terminalId: id, name: names[id] || '' })),
      addresses:  _localAddresses(),
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('connection:generateKey', async (_, { requestUserId } = {}) => {
  try {
    if (!_connRequireSA(requestUserId)) return { ok: false, error: 'Solo el superadmin' };
    const key = require('./src/main/connection').generateAccessKey();
    settingsRepo.set('connection_access_key', key);
    return { ok: true, accessKey: key };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('connection:test', async (_, { requestUserId, host, port } = {}) => {
  try {
    if (!_connRequireSA(requestUserId)) return { ok: false, error: 'Solo el superadmin' };
    const { healthCheck } = require('./src/main/net-client');
    const r = await healthCheck({
      host: host || settingsRepo.get('connection_server_ip') || '127.0.0.1',
      port: Number(port || settingsRepo.get('connection_server_port')) || 8443,
      timeoutMs: 5000,
    });
    return { ok: true, reachable: !!r.ok, ms: r.ms ?? null, error: r.error || null };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Preflight al arrancar (SIN auth, se llama antes del login). En modo cliente
// comprueba si el servidor responde; el renderer muestra pantalla de recuperación
// en vez de intentar cargar datos (que colgaría la app). No expone la llave.
ipcMain.handle('connection:clientPreflight', async () => {
  try {
    const mode = settingsRepo.get('connection_mode') || 'local';
    const terminalId = settingsRepo.get('terminal_id') || '';
    if (mode !== 'client') return { ok: true, mode, reachable: true, authorized: true, terminalId };
    const host = settingsRepo.get('connection_server_ip') || '';
    const port = Number(settingsRepo.get('connection_server_port')) || 8443;
    if (!host) return { ok: true, mode, reachable: false, authorized: false, host: '', port, terminalId, reason: 'no-ip' };

    const { healthCheck, rpcCall } = require('./src/main/net-client');
    // 1) ¿El servidor está encendido/alcanzable? (/health, sin auth)
    const h = await healthCheck({ host, port, timeoutMs: 4000 });
    if (!h.ok) return { ok: true, mode, reachable: false, authorized: false, host, port, terminalId, reason: 'offline' };

    // 2) ¿Este terminal está AUTORIZADO? Ping RPC autenticado (llave + allowlist).
    //    Sin esto, un servidor encendido pero que rechaza al terminal dejaba pasar
    //    a un login que no podía funcionar.
    const accessKey = settingsRepo.get('connection_access_key') || '';
    const ping = await rpcCall({ host, port, accessKey, terminalId, channel: 'version:getInfo', args: {}, timeoutMs: 4000 });
    const authorized = !!(ping && ping.ok === true);
    const reason = authorized ? 'ok' : ((ping && ping.error) || 'unauthorized');
    return { ok: true, mode, reachable: true, authorized, host, port, terminalId, reason };
  } catch (e) { return { ok: true, mode: 'client', reachable: false, authorized: false, error: e.message }; }
});

// Cambia el modo de conexión (usado por la pantalla de recuperación offline para
// volver a 'local' sin login). connection_mode es device-setting → se guarda local.
ipcMain.handle('connection:setMode', async (_, { mode } = {}) => {
  try {
    if (!['local', 'server', 'client'].includes(mode)) return { ok: false, error: 'Modo inválido' };
    settingsRepo.set('connection_mode', mode);
    return { ok: true, mode };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('connection:setAllowedTerminal', async (_, { requestUserId, terminalId, name, remove } = {}) => {
  try {
    if (!_connRequireSA(requestUserId)) return { ok: false, error: 'Solo el superadmin' };
    const conn = require('./src/main/connection');
    let list  = conn.parseAllowlist(settingsRepo.get('connection_allowlist'));
    const names = _connTerminalNames();
    if (remove) { list = list.filter(id => id !== terminalId); delete names[terminalId]; }
    else if (terminalId && !list.includes(terminalId)) { list.push(terminalId); if (name) names[terminalId] = name; }
    settingsRepo.set('connection_allowlist', JSON.stringify(list));
    settingsRepo.set('connection_terminal_names', JSON.stringify(names));
    return { ok: true, count: list.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Usuarios ──────────────────────────────────
ipcMain.handle('users:getById', async (_, id) => {
  try {
    const u = authRepo.findById(id);
    if (!u) return { ok: false, error: 'Usuario no encontrado' };
    const { password: _, ...safe } = u;
    return { ok: true, data: safe };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('users:getAll', async () => {
  return usersRepo.getAll();
});

ipcMain.handle('users:create', async (_, { data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    const id = usersRepo.create(data);
    audit(requestUserId, reqUser.name, 'usuario_creado', 'users', id, data.name);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('users:update', async (_, { id, data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    usersRepo.update(id, data);
    audit(requestUserId, reqUser.name, 'usuario_editado', 'users', id, data.name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('users:changePassword', async (_, { id, password, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };

    const isSelf  = reqUser.id === id;
    const isAdmin = ['admin', 'superadmin'].includes(reqUser.role);

    // Un usuario siempre puede cambiar su propia contraseña.
    // Solo admin/superadmin pueden cambiar la de otro usuario.
    if (!isSelf && !isAdmin) {
      return { ok: false, error: 'Sin permisos para cambiar la contraseña de otro usuario' };
    }

    usersRepo.changePassword(id, password);
    audit(requestUserId, reqUser.name, 'cambio_contrasena', 'users', id,
          isSelf ? 'Propio cambio' : 'Cambio por admin');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Productos ─────────────────────────────────
ipcMain.handle('products:getAll', async () => {
  return productsRepo.getAll();
});

// Retorna lista de modelos únicos registrados (para autocompletado)
ipcMain.handle('products:getModels', async () => {
  try {
    const db = require('./database').getDB();
    const rows = db.prepare(
      "SELECT DISTINCT model FROM products WHERE active=1 AND model!='' ORDER BY model ASC"
    ).all();
    return { ok: true, models: rows.map(r => r.model) };
  } catch(e) {
    return { ok: false, models: [] };
  }
});

ipcMain.handle('products:create', async (_, { data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    const id = productsRepo.create(data);
    audit(requestUserId, reqUser.name, 'producto_creado', 'products', id, data.name);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('products:update', async (_, { id, data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    productsRepo.update(id, data);
    audit(requestUserId, reqUser.name, 'producto_editado', 'products', id, data.name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('products:adjustStock', async (_, { id, qty, type, reason, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo el administrador puede ajustar stock' };
    }
    const result = productsRepo.adjustStock(id, qty, type, reason, null, requestUserId);
    audit(requestUserId, reqUser.name, 'ajuste_inventario', 'products', id,
          `Tipo: ${type} | Cantidad: ${qty} | Motivo: ${reason}`);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('products:delete', async (_, { id, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    productsRepo.delete(id);
    audit(requestUserId, reqUser.name, 'producto_inactivado', 'products', id, '');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('products:getMovements', async (_, { productId }) => {
  return productsRepo.getMovements(productId);
});

// ── Clientes ──────────────────────────────────
ipcMain.handle('customers:getAll', async () => {
  return customersRepo.getAll();
});

ipcMain.handle('customers:create', async (_, { data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };

    // Cajeros pueden crear clientes (necesario en el flujo de venta),
    // pero NO pueden fijar límite de crédito — eso es potestad del admin.
    const isAdmin = ['admin', 'superadmin'].includes(reqUser.role);
    const safeData = { ...data };
    if (!isAdmin) {
      // Forzar credit_limit a 0 para cajeros — el admin lo ajusta después
      safeData.credit_limit = 0;
    }

    const id = customersRepo.create(safeData);
    audit(requestUserId, reqUser.name, 'cliente_creado', 'customers', id, data.name);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('customers:update', async (_, { id, data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    customersRepo.update(id, data);
    audit(requestUserId, reqUser.name, 'cliente_editado', 'customers', id, data.name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Contabilidad en vivo ──────────────────────────────────────────────────
// Ejecuta un hook contable DESPUÉS de que la operación commiteó (better-sqlite3
// no permite transacciones anidadas) y NUNCA rompe la operación si falla. Las
// funciones generate*/reverse* ya se auto-guardan por módulo e idempotencia.
function _acctHook(fn) {
  try { fn(); } catch (e) { try { logError('accounting', 'hook falló', { error: e.message }); } catch {} }
}

ipcMain.handle('customers:addPayment', async (_, { data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    // VALIDACIÓN: monto debe ser positivo
    if (!data?.amount || parseFloat(data.amount) <= 0) {
      return { ok: false, error: 'El monto del abono debe ser mayor a cero' };
    }
    // Obtener sesión de caja activa
    const session = cashRepo.getOpen(_reqTerminalId());
    const result  = customersRepo.addPayment({
      ...data,
      cajero:    reqUser?.name,
      userId:    requestUserId,
      sessionId: session?.id || null,
    });
    audit(requestUserId, reqUser?.name || '', 'abono_registrado', 'customers',
          data.customerId, `Monto: ${data.amount}`);
    // Contabilidad en vivo: Débito Caja/Banco · Crédito Cuentas por Cobrar.
    _acctHook(() => accountingRepo.generatePaymentEntry({ paymentId: result.paymentId, userId: requestUserId }));
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('customers:delete', async (_, { id, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    const result = customersRepo.delete(id);
    audit(requestUserId, reqUser.name, 'cliente_eliminado', 'customers', id,
          `${result.name} | Balance liberado de CxC: ${result.balance}`);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('customers:deleteAll', async (_, { requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    const result = customersRepo.deleteAll();
    audit(requestUserId, reqUser.name, 'clientes_eliminados_todos', 'customers', null,
          `${result.count} clientes | Balance liberado de CxC: ${result.totalBalance}`);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('customers:getPayments', async (_, { customerId }) => {
  if (!customerId || customerId === 0) return [];
  return customersRepo.getPayments(customerId);
});

ipcMain.handle('customers:getAllPayments', async () => {
  const db = require('./database').getDB();
  return db.prepare('SELECT * FROM payments ORDER BY created_at DESC').all();
});

ipcMain.handle('customers:getHistory', async (_, { customerId }) => {
  try {
    const db = require('./database').getDB();
    const sales = db.prepare(`
      SELECT s.*, GROUP_CONCAT(si.product_name || ' x' || si.qty, ', ') as items_summary
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.customer_id = ? AND s.status != 'cancelled'
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT 100
    `).all(customerId);
    return sales;
  } catch (e) {
    return [];
  }
});

// ── Caja ──────────────────────────────────────
ipcMain.handle('cash:getOpen', async (_, arg) => {
  // terminalId opcional: sin él = caja abierta global (histórico); con él = la de
  // esta terminal (multi-terminal). El renderer lo pasa cuando lo conoce.
  return cashRepo.getOpen(arg && arg.terminalId);
});

ipcMain.handle('cash:open', async (_, { openAmount, openBills, requestUserId, terminalId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    const existing = cashRepo.getOpen(terminalId);
    if (existing) return { ok: false, error: 'Ya hay una caja abierta' };
    const id = cashRepo.open({
      userId: requestUserId, cajero: reqUser.name,
      openAmount, openBills, terminalId
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cash:close', async (_, { sessionId, closeAmount, closeBills, expected, notes, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    // VALIDACIÓN: closeAmount no puede ser negativo
    if (closeAmount === undefined || closeAmount === null || parseFloat(closeAmount) < 0) {
      return { ok: false, error: 'El monto de cierre no puede ser negativo' };
    }
    if (!sessionId) return { ok: false, error: 'ID de sesión requerido' };
    const result = cashRepo.close({
      sessionId, closeAmount: parseFloat(closeAmount) || 0,
      closeBills, expected: parseFloat(expected) || 0,
      notes, userId: requestUserId, cajero: reqUser.name
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cash:getSessions', async () => {
  return cashRepo.getSessions();
});

ipcMain.handle('cash:getSessionSales', async (_, { sessionId }) => {
  return cashRepo.getSessionSales(sessionId);
});

ipcMain.handle('cash:getSessionCashSummary', async (_, { sessionId }) => {
  try {
    return cashRepo.getSessionCashSummary(sessionId);
  } catch (e) {
    console.error('[cash:getSessionCashSummary]', e);
    return null;
  }
});

// ── Ventas ────────────────────────────────────
ipcMain.handle('sales:create', async (_, { saleData, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };

    // ── Validación básica de integridad (segunda línea de defensa tras el renderer) ──
    if (!saleData?.items?.length) {
      return { ok: false, error: 'La venta debe tener al menos un producto' };
    }
    for (const item of saleData.items) {
      if (!item.qty || item.qty <= 0) {
        return { ok: false, error: `Cantidad inválida en "${item.product_name || 'producto'}"` };
      }
      if (item.qty > 99999) {
        return { ok: false, error: `Cantidad excesiva en "${item.product_name || 'producto'}" — máximo 99,999` };
      }
      if (typeof item.unit_price !== 'number' || item.unit_price < 0) {
        return { ok: false, error: `Precio inválido en "${item.product_name || 'producto'}"` };
      }
      if (item.unit_price > 99999999) {
        return { ok: false, error: `Precio excesivo en "${item.product_name || 'producto'}"` };
      }
    }

    // Verificar caja abierta (cajero debe tener caja)
    if (reqUser.role === 'cajero') {
      const session = cashRepo.getOpen(_reqTerminalId());
      if (!session) return { ok: false, error: 'Debes abrir la caja antes de vender' };
      saleData.session = session;
    }

    const result = salesRepo.create({ ...saleData, user: reqUser });
    // Contabilidad en vivo: asiento de venta (Débito Caja/Banco/CxC · Crédito
    // Ingresos + ITBIS · Costo/Inventario). Se auto-guarda por tipo/idempotencia.
    _acctHook(() => accountingRepo.generateSaleEntry({ saleId: result.saleId, userId: requestUserId }));
    return { ok: true, ...result };
  } catch (e) {
    console.error('[sales:create]', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sales:getById', async (_, { id }) => {
  return salesRepo.getById(id);
});

ipcMain.handle('sales:getAll', async (_, filters) => {
  return salesRepo.getAll(filters);
});

ipcMain.handle('sales:count', async (_, filters) => {
  try {
    return salesRepo.countAll(filters || {});
  } catch (e) {
    console.error('[sales:count]', e);
    return 0;
  }
});

// Canal para que el renderer registre errores en el log persistente (Fase 2)
ipcMain.handle('log:error', async (_, { tag, message, extra } = {}) => {
  try { logError(tag || 'renderer', message || '', extra); } catch {}
  return true;
});

ipcMain.handle('sales:search', async (_, { q, limit } = {}) => {
  try {
    return salesRepo.search(q, limit || 8);
  } catch (e) {
    console.error('[sales:search]', e);
    return [];
  }
});

ipcMain.handle('sales:cancel', async (_, { id, reason, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo el administrador puede anular ventas' };
    }
    const cancelResult = salesRepo.cancel(id, reason, requestUserId, reqUser.name);
    // Contabilidad en vivo: reversar el asiento de la venta anulada.
    _acctHook(() => accountingRepo.reverseSourceEntry('venta', id, requestUserId, 'Venta anulada: ' + (reason || '')));
    return { ok: true, overpayment: cancelResult?.overpayment || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Devoluciones ──────────────────────────────
ipcMain.handle('sales:return', async (_, { originalSaleId, items, reason, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };

    // Verificar caja abierta
    const session = cashRepo.getOpen(_reqTerminalId());
    if (!session) return { ok: false, error: 'Debes tener la caja abierta para procesar devoluciones' };

    const result = returnsRepo.create({
      originalSaleId,
      items,
      session,
      user: reqUser,
      reason,
    });

    // Contabilidad en vivo: asiento de devolución (nota de crédito).
    _acctHook(() => accountingRepo.generateReturnEntry({ returnSaleId: result.returnId, userId: requestUserId }));
    return { ok: true, ...result };
  } catch (e) {
    console.error('[sales:return]', e);
    return { ok: false, error: e.message };
  }
});

// ── Reportes ──────────────────────────────────
ipcMain.handle('reports:summary', async (_, { range, dateFrom, dateTo, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    return { ok: true, data: reportsRepo.summary(range, dateFrom, dateTo) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('reports:paymentsHistory', async (_, { range, dateFrom, dateTo, requestUserId } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    return { ok: true, data: reportsRepo.paymentsHistory({ range, dateFrom, dateTo }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('reports:lowStock', async () => {
  return reportsRepo.lowStock();
});

ipcMain.handle('reports:creditAlerts', async () => {
  return reportsRepo.creditAlerts();
});

// ── Auditoría ─────────────────────────────────
ipcMain.handle('audit:getLogs', async (_, { limit = 200, action, entity } = {}) => {
  try {
    const dbInst = require('./database').getDB();
    let query  = 'SELECT * FROM audit_logs';
    const params = [];
    const where  = [];
    if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
    if (entity) { where.push('entity=?');      params.push(entity); }
    if (where.length) query += ' WHERE ' + where.join(' AND ');
    query += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    return dbInst.prepare(query).all(...params);
  } catch (e) {
    return [];
  }
});

ipcMain.handle('audit:log', async (_, { action, entity, entityId, detail, userId } = {}) => {
  try {
    if (!action) return { ok: false, error: 'action requerida' };
    const reqUser = userId ? authRepo.findById(userId) : null;
    audit(userId || 0, reqUser?.name || 'sistema', action, entity || '', entityId || null, detail || '');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Categorías ────────────────────────────────
ipcMain.handle('categories:getAll', async () => {
  try {
    const dbInst = require('./database').getDB();
    return { ok: true, data: dbInst.prepare('SELECT * FROM categories ORDER BY name').all() };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('categories:create', async (_, { name, requestUserId }) => {
  try {
    if (!name?.trim()) return { ok: false, error: 'El nombre es requerido' };
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo el administrador puede crear categorías' };
    }
    const dbInst = require('./database').getDB();
    const r = dbInst.prepare('INSERT INTO categories(name) VALUES(?)').run(name.trim());
    audit(requestUserId, reqUser.name, 'categoria_creada', 'categories', r.lastInsertRowid, name);
    return { ok: true, id: r.lastInsertRowid };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('categories:delete', async (_, { id, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    const dbInst = require('./database').getDB();
    dbInst.prepare('DELETE FROM categories WHERE id=?').run(id);
    audit(requestUserId, reqUser.name, 'categoria_eliminada', 'categories', id, '');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});


ipcMain.handle('db:vacuum', async (_, { requestUserId } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || reqUser.role !== 'superadmin') {
      return { ok: false, error: 'Solo el Super Admin puede ejecutar VACUUM' };
    }
    const dbInst = require('./database').getDB();
    dbInst.exec('VACUUM');
    audit(requestUserId, reqUser.name, 'db_vacuum', 'system', null, 'VACUUM ejecutado');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('license:revoke', async (_, { requestUserId } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || reqUser.role !== 'superadmin') {
      return { ok: false, error: 'Solo el Super Admin puede revocar licencias' };
    }
    const licensePath   = path.join(DATA_DIR, 'license.key');
    const installedPath = path.join(DATA_DIR, '.installed');
    if (fs.existsSync(licensePath))   fs.unlinkSync(licensePath);
    if (fs.existsSync(installedPath)) fs.unlinkSync(installedPath);
    audit(requestUserId, reqUser.name, 'licencia_revocada', 'license', null, '');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Impresión ─────────────────────────────────

/**
 * Imprime HTML en la impresora seleccionada.
 * - Si se pasa printerName, la preselecciona en el diálogo
 * - Registra el trabajo en print_jobs para auditoría y reimpresión
 */
async function _attemptPrintHTML({ html, printerName, printerWidth, pageHint }) {
  // isThermal: solo cuando hay printerName Y printerWidth
  // carta: printerName sin printerWidth (o sin printerName)
  // Para carta usamos 816px (≈ 8.5" a 96dpi) para que el layout renderice correcto
  // Para térmica 480px es suficiente — papel angosto
  const isThermal  = !!(printerName && printerWidth);
  const printWin = new BrowserWindow({
    width:  isThermal ? 480 : 816,
    height: isThermal ? 700 : 1056,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // Cargar desde ARCHIVO TEMPORAL, no desde data: URL. Los data: URLs son una
  // causa conocida de impresión en blanco en Electron/Chromium: el documento de
  // impresión no siempre recibe el frame renderizado. Un archivo local se imprime
  // de forma fiable en todas las plataformas.
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `velo_print_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
  const cleanupTmp = () => { try { fs.unlinkSync(tmpFile); } catch {} };
  fs.writeFileSync(tmpFile, html, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      const loadTimeout = setTimeout(() => reject(new Error('Tiempo agotado cargando el documento de impresión')), 12000);
      printWin.webContents.once('did-finish-load', () => { clearTimeout(loadTimeout); resolve(); });
      printWin.webContents.once('did-fail-load', (_, __, errDesc) => {
        clearTimeout(loadTimeout);
        reject(new Error(errDesc || 'No se pudo cargar el documento'));
      });
      printWin.loadFile(tmpFile);
    });

    // Esperar a que la página realmente PINTE (dos frames), no solo un delay fijo.
    try {
      await printWin.webContents.executeJavaScript(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'
      );
    } catch {}
    await new Promise(r => setTimeout(r, isThermal ? 250 : 500));

    // Ancho del papel en micrones (printerWidth puede venir "50mm" o número)
    let paperWidth = 80000;
    if (printerWidth) {
      if (typeof printerWidth === 'string' && printerWidth.endsWith('mm')) paperWidth = Math.round(parseFloat(printerWidth) * 1000);
      else if (typeof printerWidth === 'number') paperWidth = printerWidth;
      else paperWidth = parseInt(printerWidth) || 80000;
    }

    // Térmica: altura del papel = altura REAL del contenido. Antes se usaba
    // height:999999 (~1 metro), que en muchos drivers térmicos deja salir hojas
    // en blanco o rechaza el trabajo. Medir el contenido lo hace exacto.
    // 1px ≈ 264.58 micrones a 96dpi.
    let thermalHeight = 200000;
    try {
      const px = await printWin.webContents.executeJavaScript('document.body.scrollHeight');
      if (px && px > 0) thermalHeight = Math.round(px * 264.583) + 8000;  // +~3mm de margen
    } catch {}

    const printOptions = {
      // Imprime DIRECTO (sin diálogo) siempre que haya una impresora elegida —
      // aplica tanto a térmica como a carta/láser. El diálogo solo aparece si no
      // se configuró ninguna impresora (deviceName vacío).
      silent:          !!printerName,
      printBackground: true,
      margins:         isThermal
        ? { marginType: 'custom', top: 2, bottom: 2, left: 2, right: 2 }
        : { marginType: 'default' },
      pageSize: isThermal
        ? { width: paperWidth, height: thermalHeight }
        : pageHint === 'half-letter'
          ? { width: 139700, height: 107950 }
          : 'Letter',
    };
    if (printerName) printOptions.deviceName = printerName;

    logInfo('print', `Imprimiendo`, { printer: printerName || '(dialogo)', thermal: isThermal, paperWidth, height: isThermal ? thermalHeight : 'letter' });

    await new Promise((resolve, reject) => {
      printWin.webContents.print(printOptions, (success, errType) => {
        if (success) resolve();
        else reject(new Error(errType || 'Impresión cancelada o fallida'));
      });
    });
    logInfo('print', `Enviado a impresora`, { printer: printerName || 'dialogo' });
  } finally {
    try { printWin.destroy(); } catch {}
    cleanupTmp();
  }
}

ipcMain.handle('print:html', async (_, { html, printerName, printerWidth, jobType, referenceId, userId, pageHint }) => {
  try {
    try {
      await _attemptPrintHTML({ html, printerName, printerWidth, pageHint });
    } catch (firstErr) {
      // Reintento automático único — solo para impresión silenciosa (térmica),
      // donde un fallo normalmente es un problema transitorio (impresora ocupada
      // o temporalmente no disponible), no una cancelación explícita del usuario.
      // En modo diálogo (carta) un fallo suele ser el usuario cancelando — no reintentar.
      const wasThermalAttempt = !!(printerName && printerWidth);
      if (!wasThermalAttempt) throw firstErr;
      await new Promise(r => setTimeout(r, 1200));
      await _attemptPrintHTML({ html, printerName, printerWidth, pageHint });
    }

    // Registrar trabajo exitoso en print_jobs
    if (jobType && referenceId) {
      const dbInst = require('./database').getDB();
      dbInst.prepare(`
        INSERT INTO print_jobs(type, reference_id, status, printer, user_id)
        VALUES(?, ?, 'success', ?, ?)
      `).run(jobType, referenceId, printerName || '', userId || null);
    }

    return { ok: true };

  } catch (e) {
    // Registrar fallo en print_jobs
    if (jobType && referenceId) {
      try {
        const dbInst = require('./database').getDB();
        dbInst.prepare(`
          INSERT INTO print_jobs(type, reference_id, status, error, printer, user_id)
          VALUES(?, ?, 'failed', ?, ?, ?)
        `).run(jobType, referenceId, e.message, printerName || '', userId || null);
      } catch {}
    }
    console.error('[print:html]', e.message);
    return { ok: false, error: e.message };
  }
});

// Imprimir en la impresora del SERVIDOR (mostrador). NO es local-only: en modo
// cliente el interceptor reenvía esta llamada al servidor, que la ejecuta con SU
// impresora configurada. Es la opción "imprimir por el servidor" cuando la terminal
// no tiene impresora física. Ver docs/multi-terminal-sync.md §8.
ipcMain.handle('print:onServer', async (_, { html, jobType, referenceId, userId } = {}) => {
  try {
    const printerName  = settingsRepo.get('printer') || undefined;
    const ptype        = settingsRepo.get('printer_type') || '';
    const printerWidth = ptype === '58mm' ? 58000 : ptype === '80mm' ? 80000 : undefined;
    await _attemptPrintHTML({ html, printerName, printerWidth });
    if (jobType && referenceId) {
      try {
        require('./database').getDB().prepare(
          "INSERT INTO print_jobs(type, reference_id, status, printer, user_id) VALUES(?,?,'success',?,?)"
        ).run(jobType, referenceId, (printerName || '') + ' (servidor)', userId || null);
      } catch {}
    }
    return { ok: true, printedOn: 'server' };
  } catch (e) {
    console.error('[print:onServer]', e.message);
    return { ok: false, error: e.message };
  }
});

// Guardar un documento como PDF (mismo HTML que se imprime) con diálogo "Guardar como".
// Universal: sirve para factura, cotización, conduce, abono, reportes, etc.
ipcMain.handle('print:toPDF', async (_, { html, suggestedName, open } = {}) => {
  try {
    if (!html) return { ok: false, error: 'Sin contenido para el PDF' };
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), `velo_pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(tmpFile, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 816, height: 1056,
      webPreferences: { nodeIntegration: false, contextIsolation: true } });

    let pdfBuf;
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Tiempo agotado generando el PDF')), 12000);
        win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
        win.webContents.once('did-fail-load', (_, __, e) => { clearTimeout(t); reject(new Error(e || 'No se pudo cargar')); });
        win.loadFile(tmpFile);
      });
      await win.webContents.executeJavaScript(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {});
      // Página a la medida del contenido (documento compacto, sin hojas en blanco).
      let dims = { w: 302, h: 800 };
      try { dims = await win.webContents.executeJavaScript('({w:document.body.scrollWidth,h:document.body.scrollHeight})'); } catch {}
      const micron = px => Math.max(20000, Math.round((px || 0) * 264.583));
      pdfBuf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: micron(dims.w) + 4000, height: micron(dims.h) + 4000 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
    } finally {
      try { win.destroy(); } catch {}
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    const safeName = String(suggestedName || 'documento').replace(/[^\w\-. ]/g, '_');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar PDF',
      defaultPath: safeName.endsWith('.pdf') ? safeName : safeName + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, pdfBuf);
    if (open) { try { shell.openPath(filePath); } catch {} }
    return { ok: true, path: filePath };
  } catch (e) {
    console.error('[print:toPDF]', e.message);
    return { ok: false, error: e.message };
  }
});

/**
 * Lista las impresoras instaladas en el sistema.
 * En Windows incluye la AOKIA USB si está instalada.
 */
ipcMain.handle('print:getPrinters', async () => {
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map(p => ({
      name:      p.name,
      isDefault: p.isDefault,
      status:    p.status || 0,
    }));
  } catch (e) {
    console.error('[print:getPrinters]', e);
    return [];
  }
});

/**
 * Guarda la impresora seleccionada en settings.
 */
ipcMain.handle('print:savePrinter', async (_, { printerName, requestUserId }) => {
  try {
    settingsRepo.set('printer', printerName);
    const reqUser = requestUserId ? authRepo.findById(requestUserId) : null;
    audit(requestUserId || 0, reqUser?.name || 'sistema',
      'impresora_configurada', 'settings', null, printerName);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * Guarda la configuración de impresión por categoría de documento
 * (impresora/vista previa/auto-impresión por módulo: ticket, pago,
 * caja, contabilidad, bancos, reporte).
 */
ipcMain.handle('print:saveConfig', async (_, { config, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin', 'superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo administradores pueden modificar la configuración de impresión' };
    }
    settingsRepo.set('print_config', JSON.stringify(config || {}));
    audit(requestUserId, reqUser.name, 'config_impresion_actualizada', 'settings', null, '');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * Historial de trabajos de impresión (para reimpresión auditada).
 */
ipcMain.handle('print:getJobs', async (_, { referenceId, jobType } = {}) => {
  try {
    const dbInst = require('./database').getDB();
    let query = 'SELECT * FROM print_jobs';
    const params = [];
    if (referenceId && jobType) {
      query += ' WHERE reference_id=? AND type=?';
      params.push(referenceId, jobType);
    } else if (referenceId) {
      query += ' WHERE reference_id=?';
      params.push(referenceId);
    }
    query += ' ORDER BY created_at DESC LIMIT 50';
    return dbInst.prepare(query).all(...params);
  } catch (e) {
    return [];
  }
});

// ── Versioning ────────────────────────────────
ipcMain.handle('version:getInfo', async () => {
  try {
    return { ok: true, data: getVersionInfo(db, DATA_DIR) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:getAppVersion', async () => {
  return APP_VERSION;
});

// ── Backup ────────────────────────────────────
// ══════════════════════════════════════════════
// IPC — RESET COMPLETO DEL NEGOCIO
// Borra todos los datos EXCEPTO:
//   · Usuarios y licencia
//   · API key (velo-ai.key en %APPDATA%)
//   · Configuración del updater
// ══════════════════════════════════════════════
ipcMain.handle('business:resetData', async (_, { requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || reqUser.role !== 'superadmin') {
      return { ok: false, error: 'Solo el Super Admin puede resetear los datos' };
    }

    const db = require('./database').getDB();

    // Tablas a limpiar — en orden para respetar FK
    const TABLAS = [
      'ecf_log',
      'ncf_log',
      'ncf_sequences',
      'deliveries',
      'vehicle_maintenance',
      'vehicles',
      'branches',
      'expense_budgets',
      'expense_config',
      'recurring_expenses',
      'expense_payments',
      'expenses',
      'expense_categories',
      'print_jobs',
      'audit_logs',
      'payments',
      'sale_items',
      'sales',
      'cash_movements',
      'cash_sessions',
      'customers',
      'inventory_movements',
      'products',
      'categories',
      // Compras
      'purchase_items',
      'purchase_orders',
      'suppliers',
      // Bancos y cuentas
      'financial_movements',
      'financial_accounts',
      // Contabilidad
      'accounting_entry_lines',
      'accounting_entries',
      'accounting_periods',
      'accounting_accounts',
      'accounting_config',
    ];

    db.transaction(() => {
      for (const tabla of TABLAS) {
        try {
          const r = db.prepare(`DELETE FROM ${tabla}`).run();
          db.prepare(`DELETE FROM sqlite_sequence WHERE name=?`).run(tabla);
          console.log(`[reset] ✓ ${tabla}: ${r.changes} filas eliminadas`);
        } catch(e) {
          console.error(`[reset] ✗ ${tabla}:`, e.message);
        }
      }

      // Limpiar settings — solo borrar NCF counters
      // Conservar: datos del negocio (biz, rnc, phone, address, email, logo)
      //            configuración del sistema (module_*, license_*, master_*)
      //            updater, barcode_enabled, fiscal_enabled
      const settingsToDelete = [
        'next_ncf_b01','next_ncf_b02','next_ncf_b14','next_ncf_b15',
        'next_ncf_b16','next_ncf_b17',
      ];
      for (const key of settingsToDelete) {
        try { db.prepare(`DELETE FROM settings WHERE key=?`).run(key); } catch {}
      }
    })();

    // Compactar la DB después del reset
    try { db.exec('VACUUM'); } catch {}

    // Recrear Consumidor Final con id=1 — el POS lo necesita para ventas rápidas
    // y el sistema asigna custId=1 cuando no encuentra el cliente por nombre
    try {
      db.prepare(`INSERT INTO customers(name,rnc,credit_limit,balance,active) VALUES('Consumidor Final','',0,0,1)`).run();
      console.log('[reset] Consumidor Final recreado con id=1');
    } catch(e) { console.error('[reset] Error recreando Consumidor Final:', e.message); }

    // Re-sembrar el catálogo contable — el reset borró accounting_accounts/config.
    // El plan de cuentas es estructura, no datos del negocio, así que debe
    // persistir. Idempotente: no duplica si ya existiera.
    try {
      const n = seedAccountingCatalog(db);
      console.log(`[reset] Catálogo contable re-sembrado (${n} cuentas)`);
    } catch(e) { console.error('[reset] Error re-sembrando catálogo contable:', e.message); }

    console.log('[reset] Datos del negocio eliminados por:', reqUser.name);
    return { ok: true };
  } catch(e) {
    console.error('[business:resetData]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:create', async (_, { requestUserId }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar backup',
      defaultPath: `velo_backup_${new Date().toISOString().split('T')[0]}.db`,
      filters: [{ name: 'Database', extensions: ['db'] }]
    });

    if (!filePath) return { ok: false, error: 'Cancelado' };

    createManualBackup(DATA_DIR, filePath);

    const reqUser = authRepo.findById(requestUserId);
    audit(requestUserId, reqUser?.name || '', 'backup_creado', '', null, filePath);

    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:restore', async (_, { requestUserId, fileName } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo el administrador puede restaurar backups' };
    }

    let filePath = null;

    if (fileName) {
      filePath = path.join(DATA_DIR, 'backups', fileName);
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `Backup no encontrado: ${fileName}` };
      }
    } else {
      const { filePaths } = await dialog.showOpenDialog(mainWindow, {
        title:       'Seleccionar backup',
        defaultPath: path.join(DATA_DIR, 'backups'),
        filters:     [{ name: 'Database', extensions: ['db'] }],
        properties:  ['openFile'],
      });
      if (!filePaths?.length) return { ok: false, error: 'Cancelado' };
      filePath = filePaths[0];
    }

    // Registrar auditoría ANTES de cerrar la DB
    audit(requestUserId, reqUser.name, 'backup_restaurado', 'backup', null,
      fileName || filePath);

    // Cerrar la conexión SQLite antes de copiar el archivo (crítico en Windows)
    const dbInst = require('./database').getDB();
    if (dbInst) dbInst.close();

    const result = restoreBackup(DATA_DIR, filePath);

    // Notificar al usuario y reiniciar la aplicación
    await dialog.showMessageBox(mainWindow, {
      type:    'info',
      title:   'Backup restaurado',
      message: 'Backup restaurado correctamente',
      detail:  'La aplicación se reiniciará ahora para aplicar los cambios.',
      buttons: ['Reiniciar ahora'],
    });

    app.relaunch();
    app.exit(0);

    return { ok: true, message: 'Reiniciando...' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:getList', async () => {
  try {
    const info = getVersionInfo(db, DATA_DIR);
    return { ok: true, backups: info.backups, backupDir: info.backupDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Licencia ──────────────────────────────────

ipcMain.handle('license:generate', async (_, { machineId, business, expiry, requestUserId } = {}) => {
  try {
    // Producción: el POS instalado en el cliente NUNCA debe generar licencias.
    // Las licencias se generan desde una herramienta separada del vendedor/empresa.
    if (app.isPackaged) {
      return { ok: false, error: 'La generación de licencias no está disponible en instalaciones de cliente' };
    }

    const reqUser = requestUserId ? authRepo.findById(requestUserId) : null;
    if (!reqUser || reqUser.role !== 'superadmin') {
      return { ok: false, error: 'Solo el Super Admin puede generar licencias en modo desarrollo/soporte' };
    }

    if (!machineId || !business || !expiry) {
      return { ok: false, error: 'machineId, business y expiry son requeridos' };
    }

    const crypto     = require('crypto');
    const fs         = require('fs');
    const path       = require('path');
    const keyPath    = process.env.VELO_PRIVATE_KEY_PATH
                       || path.join(app.getPath('userData'), 'vendor-private.pem')
                       || path.join(__dirname, 'tools', 'vendor-private.pem');
    if (!fs.existsSync(keyPath)) {
      return { ok: false, error: 'Clave privada no encontrada en este equipo' };
    }
    const keyPem     = fs.readFileSync(keyPath, 'utf8');
    const privateKey = crypto.createPrivateKey(keyPem);
    const payload    = `2|${machineId}|${business}|${expiry}`;
    const signature  = crypto.sign('SHA256', Buffer.from(payload), privateKey);
    const licKey     = `${payload}|${signature.toString('base64')}`;

    audit(requestUserId, reqUser.name, 'licencia_generada', 'license', null, `Negocio: ${business} | Máquina: ${machineId}`);
    return { ok: true, licenseKey: licKey };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('license:getStatus', async () => {
  try {
    return { ok: true, data: getLicenseStatus(DATA_DIR) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('license:activate', async (_, { licenseKey, requestUserId }) => {
  try {
    const result = activateLicense(DATA_DIR, licenseKey);
    if (result.ok) {
      const reqUser = requestUserId ? authRepo.findById(requestUserId) : null;
      audit(requestUserId || 0, reqUser?.name || 'admin',
        'licencia_activada', 'license', null,
        `Vence: ${result.expiry}`);
    }
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('license:getMachineId', async () => {
  try {
    return { ok: true, machineId: getMachineId() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// APP LIFECYCLE
// ══════════════════════════════════════════════
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');

// Asegurar que el directorio de datos existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ══════════════════════════════════════════════
// IPC — IMPORTACION UNIVERSAL
// ══════════════════════════════════════════════
ipcMain.handle('reports:dailyTrend', async (_, { days = 30, includeHistorical = true, requestUserId } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    const data = reportsRepo.dailyTrend({ days, includeHistorical });
    return { ok: true, data };
  } catch(e) {
    console.error('[reports:dailyTrend]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('reports:monthlyTrend', async (_, { months = 12, includeHistorical = true, requestUserId } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    const data = reportsRepo.monthlyTrend({ months, includeHistorical });
    return { ok: true, data };
  } catch(e) {
    console.error('[reports:monthlyTrend]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('importar:readSQLite', async (_, { data }) => {
  try {
    const tmp  = require('os').tmpdir();
    const path = require('path');
    const fs   = require('fs');
    const tmp_path = path.join(tmp, `velo_import_${Date.now()}.db`);

    // Escribir el buffer al disco temporalmente
    fs.writeFileSync(tmp_path, Buffer.from(data));

    const Database = require('better-sqlite3');
    const db2      = new Database(tmp_path, { readonly: true });

    // Listar tablas
    const tables = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name).filter(t => !t.startsWith('sqlite_'));

    // Leer la tabla con más registros
    let bestTable = tables[0];
    let bestCount = 0;
    for (const t of tables) {
      try {
        const count = db2.prepare(`SELECT COUNT(*) as c FROM ${sqliteIdent(t)}`).get().c;
        if (count > bestCount) { bestCount = count; bestTable = t; }
      } catch {}
    }

    if (!bestTable) throw new Error('No se encontraron tablas con datos');

    const rows    = db2.prepare(`SELECT * FROM ${sqliteIdent(bestTable)} LIMIT 500`).all();
    const headers = rows.length ? Object.keys(rows[0]) : [];

    db2.close();
    fs.unlinkSync(tmp_path);

    return { ok: true, data: { headers, rows, tables, bestTable } };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('importar:readPDF', async (_, { data }) => {
  try {
    const buf  = Buffer.from(data);
    const text = buf.toString('binary');

    // Extraer texto visible del PDF buscando streams de texto
    // Patrón: bloques BT...ET que contienen texto real del PDF
    const textChunks = [];

    // Método 1: Extraer texto de operadores PDF Tj y TJ
    const tjMatches = text.match(/\(([^)]{1,200})\)\s*Tj/g) || [];
    tjMatches.forEach(m => {
      const inner = m.match(/\(([^)]+)\)/)?.[1];
      if (inner) textChunks.push(inner.replace(/\\[0-9]{3}|\\./g, ' ').trim());
    });

    // Método 2: Arrays TJ con strings individuales
    const tjArrMatches = text.match(/\[([^\]]{1,500})\]\s*TJ/g) || [];
    tjArrMatches.forEach(m => {
      const inner = m.replace(/\]\s*TJ$/, '').replace(/^\[/, '');
      const parts = inner.match(/\(([^)]+)\)/g) || [];
      parts.forEach(p => {
        const s = p.slice(1,-1).replace(/\\[0-9]{3}|\\./g, ' ').trim();
        if (s.length > 1) textChunks.push(s);
      });
    });

    // Limpiar y deduplicar
    const cleaned = textChunks
      .map(s => s.replace(/[^\x20-\x7E\xC0-\xFF]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 2 && !/^[\d\s.]+$/.test(s));

    // Construir líneas agrupando chunks consecutivos
    const lines = [];
    let current = '';
    cleaned.forEach(chunk => {
      if (current.length + chunk.length < 120) {
        current += (current ? ' ' : '') + chunk;
      } else {
        if (current) lines.push(current);
        current = chunk;
      }
    });
    if (current) lines.push(current);

    // Si no se extrajo texto útil, indicarlo claramente
    if (lines.length < 3) {
      return {
        ok: true,
        data: {
          headers: ['contenido'],
          rows: [{ contenido: 'PDF escaneado o protegido — el texto no es extraíble automáticamente. Usa la IA para procesar la imagen del PDF.' }],
          nota: 'PDF sin texto extraíble — puede ser un PDF escaneado (imagen). Usa la importación IA.',
          isPDFScan: true,
        }
      };
    }

    const rows = lines.slice(0, 300).map((l, i) => ({ linea: i+1, contenido: l }));

    return {
      ok: true,
      data: {
        headers: ['linea', 'contenido'],
        rows,
        nota: `PDF procesado — ${rows.length} líneas de texto extraídas. La IA mapeará los campos automáticamente.`,
        rawText: lines.join('\n'), // texto completo para enviar a la IA
      }
    };
  } catch(e) {
    return { ok: false, error: 'No se pudo leer el PDF: ' + e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — IMPORTAR VENTA HISTÓRICA
// Inserta directamente en la DB sin validar caja,
// sin descontar stock, sin requerir usuario cajero.
// Solo para migraciones históricas.
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// IPC — IMPORTAR CRÉDITO / CUENTA POR COBRAR
// Busca el cliente por nombre exacto.
// Si existe → actualiza balance, credit_limit, status.
// Si no existe → lo crea con todos los datos de crédito.
// Registra en payments como "Saldo inicial importado".
// ══════════════════════════════════════════════
ipcMain.handle('importar:importarCredito', async (_, {
  customerName, balance, creditLimit, creditDays,
  creditDue, phone, rnc, status, requestUserId
}) => {
  try {
    const db = require('./database').getDB();

    if (!customerName) return { ok: false, error: 'Nombre de cliente requerido' };
    if (balance < 0)   return { ok: false, error: 'El balance no puede ser negativo' };

    const safeBalance     = Math.round(balance * 100) / 100;
    const safeCreditLimit = Math.max(safeBalance, Math.round((creditLimit || 0) * 100) / 100);
    const safeStatus      = ['activo','bloqueado','moroso'].includes(status) ? status : 'activo';
    const safeCreditDays  = creditDays > 0 ? creditDays : 30;

    // Calcular fecha de vencimiento si no viene y hay balance
    let safeDue = creditDue || null;
    if (!safeDue && safeBalance > 0) {
      const d = new Date();
      d.setDate(d.getDate() + safeCreditDays);
      safeDue = d.toISOString().split('T')[0];
    }

    const tx = db.transaction(() => {
      // Buscar cliente existente por nombre (Unicode-safe: SQLite lower() no maneja Ñ/tildes)
      const _allForImport = db.prepare(
        `SELECT id, balance, name FROM customers WHERE active=1`
      ).all();
      const _searchForImport = customerName.trim().toLowerCase().normalize('NFC');
      const existing = _allForImport.find(c =>
        c.name.trim().toLowerCase().normalize('NFC') === _searchForImport
      ) || null;

      let customerId;
      let created = false;

      if (existing) {
        // Cliente existe → actualizar balance y datos de crédito
        customerId = existing.id;
        db.prepare(`
          UPDATE customers
          SET balance=?, credit_limit=?, credit_days=?, credit_due=?,
              status=?, phone=CASE WHEN phone='' THEN ? ELSE phone END,
              rnc=CASE WHEN rnc='' THEN ? ELSE rnc END,
              updated_at=datetime('now')
          WHERE id=?
        `).run(safeBalance, safeCreditLimit, safeCreditDays, safeDue,
               safeStatus, phone || '', rnc || '', customerId);
      } else {
        // Cliente no existe → crear con todos los datos
        const r = db.prepare(`
          INSERT INTO customers(name, rnc, phone, address, email,
            credit_limit, credit_days, balance, credit_due, status)
          VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?)
        `).run(customerName, rnc || '', phone || '',
               safeCreditLimit, safeCreditDays, safeBalance, safeDue, safeStatus);
        customerId = r.lastInsertRowid;
        created = true;
      }

      // NOTA: No creamos payment de "Saldo inicial importado" por factura
      // porque eso inflaría la card de Ventas/Abonos a Facturas del dashboard.
      // El balance del cliente ya se establece directamente en el campo balance.

      return { customerId, created };
    });

    const result = tx();
    return { ok: true, ...result };

  } catch(e) {
    console.error('[importar:importarCredito]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('importar:importarVenta', async (_, { venta, requestUserId }) => {
  try {
    const db = require('./database').getDB();

    // Validar datos mínimos
    if (!venta?.total || venta.total <= 0) {
      return { ok: false, error: 'Total inválido' };
    }
    if (!venta?.date) {
      return { ok: false, error: 'Fecha requerida' };
    }

    const db_tx = db.transaction(() => {
      // Insertar la venta directamente — sin sesión de caja, sin stock
      // Usar fecha histórica real — NUNCA datetime('now')
      const ventaDatetime = (venta.date || new Date().toISOString().split('T')[0]) + ' 00:00:00';
      const ventaNotes = venta.invoice_ref
        ? `Factura importada | import_ref:${venta.invoice_ref}`
        : 'Factura importada';

      // Buscar customer_id por nombre (Unicode-safe)
      const _ventaSearchName = (venta.customer_name || 'Consumidor Final').trim().toLowerCase().normalize('NFC');
      const _allForVenta = db.prepare(`SELECT id, name FROM customers WHERE active=1`).all();
      const _custMatch = _allForVenta.find(c =>
        c.name.trim().toLowerCase().normalize('NFC') === _ventaSearchName
      );
      const custId = _custMatch?.id || 1;

      // ── Control de duplicados ──────────────────────────────────────────────
      // El import_ref del sistema viejo NO es único (se reutiliza entre clientes
      // y fechas). Dedup por la combinación completa: ref + fecha + cliente + total.
      // Esto permite importar facturas distintas que comparten el mismo VH-ref.
      if (venta.invoice_ref) {
        const ventaDate = (venta.date || '').slice(0, 10);
        const existing = db.prepare(`
          SELECT id FROM sales
          WHERE cajero = 'Importación histórica'
            AND notes LIKE ?
            AND customer_id = ?
            AND date(created_at) = date(?)
            AND total = ?
          LIMIT 1
        `).get(`%import_ref:${venta.invoice_ref}%`, custId,
               ventaDate + ' 00:00:00', venta.total);
        if (existing) return { ok: true, saleId: existing.id, skipped: true };
      }

      const saleR = db.prepare(`
        INSERT INTO sales(
          cash_session_id, customer_id, customer_name, customer_rnc,
          type, status, subtotal, discount_pct, discount_amt,
          tax_pct, tax_amt, total, payment_method, price_mode,
          cajero, user_id, ncf, notes, created_at
        ) VALUES (?, ?, ?, '', ?, 'completed', ?, ?, 0, ?, ?, ?, ?, 'retail', ?, ?, ?, ?, ?)
      `).run(
        null,
        custId,
        venta.customer_name || 'Consumidor Final',
        venta.type || 'factura',
        venta.subtotal || venta.total,
        venta.discount_pct || 0,
        venta.type === 'factura' ? 18 : 0,
        venta.tax_amt || 0,
        venta.total,
        venta.payment_method || 'efectivo',
        'Importación histórica',
        requestUserId || null,
        venta.ncf || '',
        ventaNotes,
        ventaDatetime
      );
      const saleId = saleR.lastInsertRowid;

      // Insertar items — producto genérico de importación (product_id=null)
      if (venta.items && venta.items.length) {
        for (const item of venta.items) {
          db.prepare(`
            INSERT INTO sale_items(
              sale_id, product_id, product_code, product_name,
              unit_cost, unit_price, qty, subtotal
            ) VALUES (?, NULL, ?, ?, 0, ?, ?, ?)
          `).run(
            saleId,
            item.product_code || 'IMP',
            item.product_name || 'Producto importado',
            item.unit_price   || venta.total,
            item.qty          || 1,
            (item.unit_price || venta.total) * (item.qty || 1)
          );
        }
      }

      return { saleId };
    });

    const result = db_tx();
    return { ok: true, saleId: result.saleId };

  } catch(e) {
    console.error('[importar:importarVenta]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — IMPORTAR COMPRA HISTÓRICA
// ══════════════════════════════════════════════
ipcMain.handle('importar:importarCompra', async (_, {
  supplierName, productName, productId, productCode,
  unitCost, qty, date, notes, requestUserId, skipStock
}) => {
  try {
    const db = require('./database').getDB();
    const tx = db.transaction(() => {
      // Crear o encontrar proveedor
      let supplierId = null;
      const existing = db.prepare(
        "SELECT id FROM suppliers WHERE lower(trim(name))=lower(trim(?)) AND status='activo' LIMIT 1"
      ).get(supplierName || 'Proveedor Importado');
      if (existing) {
        supplierId = existing.id;
      } else if (supplierName) {
        const r = db.prepare(
          "INSERT INTO suppliers(name,contact,phone,email,rnc,address,notes) VALUES(?,?,?,?,?,?,?)"
        ).run(supplierName,'','','','','','Creado por importación');
        supplierId = r.lastInsertRowid;
      }

      const subtotal = unitCost * qty;
      const poR = db.prepare(`
        INSERT INTO purchase_orders(supplier_id,supplier_name,status,subtotal,total,notes,user_id,cajero,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(supplierId, supplierName||'', 'recibido',
             subtotal, subtotal, notes||'Importado', requestUserId||null, '',
             (date||new Date().toISOString().split('T')[0]) + ' 00:00:00');
      const poId = poR.lastInsertRowid;

      db.prepare(`
        INSERT INTO purchase_items(purchase_order_id,product_id,product_code,product_name,unit_cost,qty_ordered,qty_received,subtotal)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(poId, productId||null, productCode||'IMP', productName, unitCost, qty, qty, subtotal);

      // Actualizar stock solo si NO es importación histórica
      // (skipStock=true cuando el stock ya viene correcto del CSV de productos)
      if (productId && !skipStock) {
        db.prepare('UPDATE products SET stock=stock+?,updated_at=datetime(\'now\') WHERE id=?')
          .run(qty, productId);
        db.prepare(`
          INSERT INTO inventory_movements(product_id,type,qty,qty_before,qty_after,reason,user_id)
          SELECT id,?,?,stock-?,stock,'Compra importada #${poId}',?
          FROM products WHERE id=?
        `).run('entrada', qty, qty, requestUserId||null, productId);
      }

      return { poId };
    });
    const result = tx();
    return { ok: true, poId: result.poId };
  } catch(e) {
    console.error('[importar:importarCompra]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — IMPORTAR GASTO HISTÓRICO
// ══════════════════════════════════════════════
ipcMain.handle('importar:importarAbono', async (_, {
  customerName, amount, date, invoiceRef, paymentMethod, notes, requestUserId,
}) => {
  try {
    const db = require('./database').getDB();
    if (!customerName) return { ok: false, error: 'Cliente requerido' };
    if (!amount || amount <= 0) return { ok: false, error: 'Monto inválido' };

    const result = db.transaction(() => {
      const safeDate = (date || new Date().toISOString().split('T')[0]) + ' 00:00:00';

      // Buscar la venta histórica por invoice_ref primero (VH-XXXX o número)
      // Estas ventas tienen cajero='Importación histórica' y notes con el ref
      let saleId   = null;
      let custId   = null;
      let custBal  = 0;

      if (invoiceRef) {
        // Buscar primero la venta del MISMO cliente (Unicode-safe), porque el
        // import_ref del sistema viejo se reutiliza entre clientes distintos.
        // Si no hay match por cliente, caer al primero que coincida por ref.
        const _abonoSearchName = (customerName || '').trim().toLowerCase().normalize('NFC');
        const _candidatos = db.prepare(`
          SELECT s.id, s.customer_id, c.balance, c.id as cid, c.name as cname
          FROM sales s
          JOIN customers c ON c.id = s.customer_id
          WHERE s.cajero = 'Importación histórica'
            AND (s.notes LIKE ? OR s.notes LIKE ?)
            AND s.status != 'cancelled'
        `).all(`%import_ref:VH-${invoiceRef}%`, `%import_ref:${invoiceRef}%`);
        const saleByRef = _candidatos.find(c =>
          (c.cname || '').trim().toLowerCase().normalize('NFC') === _abonoSearchName
        ) || _candidatos[0] || null;

        if (saleByRef) {
          // Dedup: mismo abono ya importado para esta venta en la misma fecha
          const existingForSale = db.prepare(
            `SELECT id FROM payments WHERE customer_id=? AND sale_id=? AND cajero='Importación histórica' AND date(created_at)=date(?) LIMIT 1`
          ).get(saleByRef.customer_id, saleByRef.id, safeDate);
          if (existingForSale) return { ok: true, id: existingForSale.id, tipo: 'historico_dup', skipped: true };

          // Es un abono de venta histórica — NO tocar balance CxC del cliente
          saleId  = saleByRef.id;
          custId  = saleByRef.customer_id;
          custBal = saleByRef.balance || 0;

          const histNote = notes || (invoiceRef ? `Abono importado | ref:${invoiceRef}` : 'Abono importado');
          const r = db.prepare(`
            INSERT INTO payments(customer_id, sale_id, amount, method, note,
              balance_before, balance_after, cajero, user_id, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, 'Importación histórica', ?, ?)
          `).run(
            custId, saleId, amount,
            paymentMethod || 'efectivo',
            histNote,
            custBal, custBal,           // balance no cambia — ya descontado en CSV
            requestUserId || null,
            safeDate
          );
          return { ok: true, id: r.lastInsertRowid, tipo: 'historico' };
        }
      }

      // Sin venta histórica que referenciar — registrar como histórico sin tocar CxC.
      // El balance del cliente ya viene correcto del CSV de clientes; no debe reducirse.
      // Búsqueda Unicode-safe: SQLite lower() no maneja Ñ/tildes — comparamos en JS
      const _allCusts = db.prepare(
        `SELECT id, balance, name FROM customers WHERE active=1`
      ).all();
      const _searchName = customerName.trim().toLowerCase().normalize('NFC');
      const _custMatch = _allCusts.find(c =>
        c.name.trim().toLowerCase().normalize('NFC') === _searchName
      );
      const cust = _custMatch ? { id: _custMatch.id, balance: _custMatch.balance } : null;
      if (!cust) return { ok: false, error: `Cliente no encontrado: ${customerName}` };

      // Dedup: misma combinación cliente + monto + fecha + ref ya importada
      // Incluir invoiceRef en el dedup para permitir dos abonos legítimamente
      // iguales en monto/fecha pero con distinta referencia de factura
      const _dedupNote = invoiceRef ? `%ref:${invoiceRef}%` : null;
      const existingNoRef = _dedupNote
        ? db.prepare(
            `SELECT id FROM payments WHERE customer_id=? AND amount=? AND cajero='Importación histórica' AND date(created_at)=date(?) AND note LIKE ? LIMIT 1`
          ).get(cust.id, amount, safeDate, _dedupNote)
        : db.prepare(
            `SELECT id FROM payments WHERE customer_id=? AND amount=? AND cajero='Importación histórica' AND date(created_at)=date(?) LIMIT 1`
          ).get(cust.id, amount, safeDate);
      if (existingNoRef) return { ok: true, id: existingNoRef.id, tipo: 'historico_sin_ref_dup', skipped: true };

      const before = cust.balance;

      // Siempre incluir invoiceRef en el note para permitir dedup correcto por ref
      const sinRefNote = invoiceRef ? `${notes || 'Abono importado'} | ref:${invoiceRef}` : (notes || 'Abono importado');
      const r = db.prepare(`
        INSERT INTO payments(customer_id, sale_id, amount, method, note,
          balance_before, balance_after, cajero, user_id, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'Importación histórica', ?, ?)
      `).run(
        cust.id, null, amount,
        paymentMethod || 'efectivo',
        sinRefNote,
        before, before,
        requestUserId || null,
        safeDate
      );

      return { ok: true, id: r.lastInsertRowid, tipo: 'historico_sin_ref' };
    })();

    return result;
  } catch(e) {
    console.error('[importar:importarAbono]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('importar:importarGasto', async (_, {
  description, total, date, category, payment_method,
  supplier_name, notes, status, requestUserId
}) => {
  try {
    const db = require('./database').getDB();

    // Buscar o crear categoría de gasto
    let categoryId = null;
    if (category && category.trim()) {
      const cat = db.prepare(
        "SELECT id FROM expense_categories WHERE lower(trim(name))=lower(trim(?)) AND active=1 LIMIT 1"
      ).get(category.trim());
      if (cat) categoryId = cat.id;
      else {
        const r = db.prepare(
          "INSERT INTO expense_categories(name,affects_profit,requires_approval,requires_attachment,approval_limit) VALUES(?,1,0,0,0)"
        ).run(category.trim());
        categoryId = r.lastInsertRowid;
      }
    }

    const safeStatus = ['pagado','pendiente_pago','anulado'].includes(status) ? status : 'pagado';
    const safeMethod = ['efectivo','transferencia','tarjeta','cheque','credito','otro'].includes(payment_method)
      ? payment_method : 'efectivo';

    const r = db.prepare(`
      INSERT INTO expenses(type,category_id,description,amount,total,currency,
        payment_method,payment_source,issue_date,status,notes,user_id,paid_amount,updated_at)
      VALUES('gasto',?,?,?,?,'DOP',?,'pendiente',?,?,?,?,?,datetime('now'))
    `).run(
      categoryId, description, total, total,
      safeMethod,
      date || new Date().toISOString().split('T')[0],
      safeStatus,
      notes || 'Importado',
      requestUserId || null,
      safeStatus === 'pagado' ? total : 0
    );

    return { ok: true, id: r.lastInsertRowid };
  } catch(e) {
    console.error('[importar:importarGasto]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — LEER ZIP (buscar el archivo más útil)
// ══════════════════════════════════════════════
ipcMain.handle('importar:readZIP', async (_, { data, name }) => {
  try {
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');
    const buf  = Buffer.from(data);
    const tmp  = path.join(os.tmpdir(), `velo_zip_${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });

    // Descomprimir usando node (sin librería extra — leer entradas del ZIP manualmente)
    // ZIP central directory está al final — buscar End of Central Directory
    const EOCD_SIG = 0x06054b50;
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('No es un archivo ZIP válido');

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdSize   = buf.readUInt32LE(eocdOffset + 12);
    const entries  = [];
    let pos = cdOffset;

    while (pos < cdOffset + cdSize) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) break;
      const compMethod   = buf.readUInt16LE(pos + 10);
      const compSize     = buf.readUInt32LE(pos + 20);
      const uncompSize   = buf.readUInt32LE(pos + 24);
      const fnLen        = buf.readUInt16LE(pos + 28);
      const extraLen     = buf.readUInt16LE(pos + 30);
      const commentLen   = buf.readUInt16LE(pos + 32);
      const localOffset  = buf.readUInt32LE(pos + 42);
      const fileName     = buf.slice(pos + 46, pos + 46 + fnLen).toString('utf8');
      entries.push({ fileName, compMethod, compSize, uncompSize, localOffset });
      pos += 46 + fnLen + extraLen + commentLen;
    }

    // Preferir: xlsx > csv > db/sqlite > json > txt/sql
    const priority = ['xlsx','xls','ods','csv','tsv','db','sqlite','json','txt','sql','xml'];
    const sorted   = entries
      .filter(e => !e.fileName.startsWith('__MACOSX') && !e.fileName.endsWith('/'))
      .sort((a, b) => {
        const extA = a.fileName.split('.').pop().toLowerCase();
        const extB = b.fileName.split('.').pop().toLowerCase();
        return (priority.indexOf(extA) === -1 ? 99 : priority.indexOf(extA)) -
               (priority.indexOf(extB) === -1 ? 99 : priority.indexOf(extB));
      });

    if (!sorted.length) throw new Error('El ZIP no contiene archivos procesables');

    const best = sorted[0];
    // Leer el archivo local del ZIP
    const localPos   = best.localOffset;
    const localFnLen = buf.readUInt16LE(localPos + 26);
    const localExLen = buf.readUInt16LE(localPos + 28);
    const dataStart  = localPos + 30 + localFnLen + localExLen;
    const fileData   = buf.slice(dataStart, dataStart + best.compSize);

    // Solo método 0 (store) soportado directamente — método 8 requiere zlib
    let fileBuffer;
    if (best.compMethod === 0) {
      fileBuffer = fileData;
    } else if (best.compMethod === 8) {
      // Deflate
      const zlib = require('zlib');
      fileBuffer = zlib.inflateRawSync(fileData);
    } else {
      throw new Error(`Método de compresión ${best.compMethod} no soportado. Extrae el ZIP manualmente.`);
    }

    const ext      = best.fileName.split('.').pop().toLowerCase();
    const tmpFile  = path.join(tmp, best.fileName.replace(/[/\\]/g, '_'));
    fs.writeFileSync(tmpFile, fileBuffer);

    // Si es SQLite, leer con better-sqlite3
    if (['db','sqlite'].includes(ext)) {
      const Database = require('better-sqlite3');
      const db2      = new Database(tmpFile, { readonly: true });
      const tables   = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map(r => r.name).filter(t => !t.startsWith('sqlite_'));
      let bestTable = tables[0], bestCount = 0;
      for (const t of tables) {
        try {
          const c = db2.prepare(`SELECT COUNT(*) as c FROM ${sqliteIdent(t)}`).get().c;
          if (c > bestCount) { bestCount = c; bestTable = t; }
        } catch {}
      }
      const rows    = db2.prepare(`SELECT * FROM ${sqliteIdent(bestTable)} LIMIT 1000`).all();
      const headers = rows.length ? Object.keys(rows[0]) : [];
      db2.close();
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmp, { recursive: true });
      return { ok: true, data: { headers, rows, tables, bestTable, nota: `ZIP → ${best.fileName}` } };
    }

    // Para otros formatos leer como texto
    const text = fs.readFileSync(tmpFile, 'utf8');
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmp, { recursive: true });

    // Devolver como CSV/texto para que el renderer lo procese
    return { ok: true, data: {
      headers: ['contenido'], rows: [{ contenido: text.slice(0, 50000) }],
      rawText: text, ext, fileName: best.fileName,
      nota: `ZIP extraído: ${best.fileName} (${(fileBuffer.length/1024).toFixed(1)} KB)`,
    }};

  } catch(e) {
    console.error('[importar:readZIP]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — ROLLBACK DE IMPORTACIÓN
// Elimina los registros insertados en la sesión
// ══════════════════════════════════════════════
ipcMain.handle('importar:rollback', async (_, { ids, requestUserId }) => {
  try {
    const db = require('./database').getDB();
    let deleted = 0;

    const tx = db.transaction(() => {
      // Procesar en orden inverso para respetar FK
      const reversed = [...(ids || [])].reverse();
      for (const entry of reversed) {
        try {
          const { tabla, id } = entry;
          if (tabla === 'products') {
            // Eliminar movimientos de inventario primero
            db.prepare('DELETE FROM inventory_movements WHERE product_id=?').run(id);
            db.prepare('DELETE FROM sale_items WHERE product_id=?').run(id);
            db.prepare('DELETE FROM products WHERE id=?').run(id);
            deleted++;
          } else if (tabla === 'customers') {
            db.prepare('DELETE FROM payments WHERE customer_id=?').run(id);
            db.prepare('DELETE FROM customers WHERE id=?').run(id);
            deleted++;
          } else if (tabla === 'sales') {
            db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(id);
            db.prepare('DELETE FROM sales WHERE id=?').run(id);
            deleted++;
          } else if (tabla === 'suppliers') {
            db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
            deleted++;
          } else if (tabla === 'purchase_orders') {
            db.prepare('DELETE FROM purchase_items WHERE purchase_order_id=?').run(id);
            db.prepare('DELETE FROM purchase_orders WHERE id=?').run(id);
            deleted++;
          } else if (tabla === 'expenses') {
            db.prepare('DELETE FROM expense_payments WHERE expense_id=?').run(id);
            db.prepare('DELETE FROM expenses WHERE id=?').run(id);
            deleted++;
          }
        } catch(e) {
          console.warn('[rollback] Error en entrada:', entry, e.message);
        }
      }
    });

    tx();
    return { ok: true, deleted };
  } catch(e) {
    console.error('[importar:rollback]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// IPC — IMPORTAR FACTURA A CRÉDITO CON DETALLE
// ══════════════════════════════════════════════
ipcMain.handle('importar:importarFacturaCredito', async (_, {
  customerName, phone, rnc,
  invoiceRef, date, items, total,
  creditDays, requestUserId,
}) => {
  try {
    const db = require('./database').getDB();
    if (!customerName) return { ok: false, error: 'Nombre de cliente requerido' };
    if (!items || !items.length) return { ok: false, error: 'Sin artículos' };
    if (total <= 0) return { ok: false, error: 'Total inválido' };

    const safeDate  = date || new Date().toISOString().split('T')[0];
    const safeDays  = creditDays > 0 ? creditDays : 30;
    const safeRef   = (invoiceRef || '').toString().trim();
    const safeTotal = Math.round(total * 100) / 100;
    // Normalizar espacios dobles en nombre de cliente
    const safeCustomerName = customerName.replace(/\s+/g, ' ').trim();

    const result = db.transaction(() => {
      // Búsqueda Unicode-safe: SQLite lower() no convierte Ñ/tildes.
      // Comparar en JS con normalize('NFC') para evitar duplicados (EDUARD PEÑA, etc.)
      const _facSearchName = safeCustomerName.toLowerCase().normalize('NFC');
      const _allFacCusts = db.prepare(
        `SELECT id, balance, credit_limit, credit_days, credit_due, name
         FROM customers WHERE active=1`
      ).all();
      let cust = _allFacCusts.find(c =>
        (c.name || '').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFC') === _facSearchName
      ) || null;

      let customerId; let customerCreated = false;
      if (cust) {
        customerId = cust.id;
        db.prepare(`UPDATE customers SET
          phone = CASE WHEN phone='' AND ? != '' THEN ? ELSE phone END,
          rnc   = CASE WHEN rnc=''   AND ? != '' THEN ? ELSE rnc   END,
          updated_at = datetime('now') WHERE id=?`
        ).run(phone||'', phone||'', rnc||'', rnc||'', customerId);
      } else {
        const r = db.prepare(`INSERT INTO customers(name,rnc,phone,address,email,
          credit_limit,credit_days,balance,status,active)
          VALUES(?,?,?,?,?,0,?,0,'activo',1)`
        ).run(safeCustomerName, rnc||'', phone||'', '', '', safeDays);
        customerId = r.lastInsertRowid; customerCreated = true;
      }

      if (safeRef) {
        const exists = db.prepare(
          `SELECT id FROM sales WHERE customer_id=? AND notes LIKE ? LIMIT 1`
        ).get(customerId, `%import_ref:${safeRef}%`);
        if (exists) return { ok: true, skipped: true, saleId: exists.id, customerId };
      }

      const subtotal = items.reduce((s, i) => s + (i.price * i.qty), 0);
      // Usar fecha histórica — NUNCA datetime('now')
      const importDatetime = safeDate + ' 00:00:00';
      const saleR = db.prepare(`INSERT INTO sales(
        cash_session_id,customer_id,customer_name,customer_rnc,type,status,
        subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,payment_method,
        price_mode,cajero,user_id,notes,created_at)
        VALUES(NULL,?,?,?,'factura','completed',?,0,0,0,0,?,'credito','retail',
        'Importación histórica',?,?,?)`
      ).run(customerId, safeCustomerName, rnc||'', subtotal, safeTotal,
            requestUserId||null,
            safeRef ? `Factura importada | import_ref:${safeRef}` : 'Factura importada',
            importDatetime);
      const saleId = saleR.lastInsertRowid;

      for (const item of items) {
        const n = (item.name||'Artículo importado').trim();
        const q = Math.max(1, Math.round(item.qty||1));
        const p = Math.round((item.price||0)*100)/100;
        db.prepare(`INSERT INTO sale_items(sale_id,product_id,product_code,
          product_name,unit_cost,unit_price,qty,subtotal)
          VALUES(?,NULL,'IMP',?,0,?,?,?)`
        ).run(saleId, n, p, q, Math.round(p*q*100)/100);
      }

      const cur = db.prepare('SELECT balance,credit_due FROM customers WHERE id=?').get(customerId);
      const newBal = Math.round(((cur?.balance||0) + safeTotal)*100)/100;
      const d = new Date(safeDate); d.setDate(d.getDate()+safeDays);
      const thisDue = d.toISOString().split('T')[0];
      const existingDue = cur?.credit_due || null;
      const dueDate = (!existingDue || thisDue > existingDue) ? thisDue : existingDue;
      const newLimit = Math.max(newBal,
        db.prepare('SELECT credit_limit FROM customers WHERE id=?').get(customerId)?.credit_limit||0);
      db.prepare(`UPDATE customers SET balance=?,credit_due=?,credit_limit=?,
        updated_at=datetime('now') WHERE id=?`
      ).run(newBal, dueDate, newLimit, customerId);

      return { saleId, customerId, customerCreated, skipped: false };
    })();

    return { ok: true, ...result };
  } catch(e) {
    console.error('[importar:importarFacturaCredito]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════════════════════════════
// IPC — ALL IN ONE (migración Equiparts v2 desde carpeta de CSV)
// ══════════════════════════════════════════════════════════════════════
// Backup automático → RESET total (FK-safe) → import limpio → valida CxC.
// Porta la lógica probada de scripts/importar-equiparts-v2.js a runtime,
// sin proceso externo ni reinicio de Electron. Todo-o-nada.
const ALLINONE_FILES = {
  clientes:   '2_clientes_v2.csv',
  inventario: '1_inventario_v2.csv',
  ventas:     '3_ventas_v2.csv',
  recibos:    '4_recibos_v2.csv',
};
const ALLINONE_TARGET_CXC = 12214797.62;

// Parser CSV real (comillas + comas internas) — idéntico al script v2.
function _aioParseCSV(text) {
  const rows = []; let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignorar */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function _aioLoadCSV(dir, fname) {
  const p = path.join(dir, fname);
  if (!fs.existsSync(p)) throw new Error(`No se encontró el CSV: ${fname}`);
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = _aioParseCSV(text).filter(r => r.length && !(r.length === 1 && r[0] === ''));
  const header = rows.shift();
  return rows.map(r => {
    const o = {};
    header.forEach((h, i) => { o[h.trim()] = (r[i] !== undefined ? r[i] : '').trim(); });
    return o;
  });
}
const _aioNum = v => {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const _aioIntOrNull = v => (v === '' || v == null) ? null : parseInt(v, 10);
const _aioNorm = s => (s || '').trim().toLowerCase().normalize('NFC');

ipcMain.handle('importar:allInOneEquiparts', async (_, { dir, requestUserId } = {}) => {
  try {
    const db = require('./database').getDB();
    if (!db) return { ok: false, error: 'DB no inicializada' };

    // ── 0) Elegir carpeta si no vino ────────────────────────────────────
    let csvDir = dir;
    if (!csvDir) {
      const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
        title: 'Seleccionar carpeta con los 4 CSV de la migración v2',
        properties: ['openDirectory'],
      });
      if (canceled || !filePaths?.length) return { ok: false, error: 'Cancelado' };
      csvDir = filePaths[0];
    }

    // ── 1) Verificar Fase 1 (columnas v2) ──────────────────────────────
    const salesCols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
    const custCols  = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
    const payCols   = db.prepare('PRAGMA table_info(payments)').all().map(c => c.name);
    const need = [
      ['sales','old_id_factura', salesCols], ['sales','numero_factura', salesCols],
      ['customers','old_id_cliente', custCols],
      ['payments','old_id_pago_detalle', payCols], ['payments','numero_recibo', payCols],
    ];
    const missing = need.filter(([t,c,cols]) => !cols.includes(c)).map(([t,c]) => `${t}.${c}`);
    if (missing.length) return { ok: false, error: 'Faltan columnas v2 (Fase 1): ' + missing.join(', ') };

    // ── 2) Cargar los 4 CSV (valida existencia y nombres) ──────────────
    let clientes, inventario, ventas, recibos;
    try {
      clientes   = _aioLoadCSV(csvDir, ALLINONE_FILES.clientes);
      inventario = _aioLoadCSV(csvDir, ALLINONE_FILES.inventario);
      ventas     = _aioLoadCSV(csvDir, ALLINONE_FILES.ventas);
      recibos    = _aioLoadCSV(csvDir, ALLINONE_FILES.recibos);
    } catch (e) {
      return { ok: false, error: e.message };
    }

    // ── 3) BACKUP automático del .db actual ────────────────────────────
    const backupsDir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupsDir, `velo_before_allinone_${stamp}.db`);
    try {
      // better-sqlite3: backup en caliente, consistente con WAL activo.
      await db.backup(backupPath);
    } catch (e) {
      return { ok: false, error: 'No se pudo crear el backup, se aborta: ' + e.message };
    }

    const stats = {
      prod_new: 0, prod_skip: 0, cli_new: 0, cli_skip: 0,
      fac_new: 0, fac_skip: 0, items: 0, rec_new: 0, rec_skip: 0,
    };

    // ── 4) RESET + IMPORT en UNA transacción todo-o-nada ───────────────
    // FK off dentro de la transacción para limpieza masiva segura.
    db.pragma('foreign_keys = OFF');
    const runAll = db.transaction(() => {
      // 4a) RESET: vaciar tablas que la migración toca (orden no crítico con FK off)
      const wipe = [
        'inventory_movements', 'ecf_log', 'ncf_log', 'deliveries',
        'sale_items', 'payments', 'sales', 'customers', 'products',
      ];
      for (const t of wipe) {
        try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_) { /* tabla ausente: ignorar */ }
      }
      // Reset de autoincrement para IDs limpios
      try { db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('sales','sale_items','payments','customers','products')`).run(); } catch (_) {}
      // Recrear Consumidor Final (id=1) — resolveCust cae aquí por defecto
      db.prepare(`INSERT INTO customers(id, name, active, balance) VALUES (1, 'Consumidor Final', 1, 0)`).run();

      // 4b) INVENTARIO
      const findProdByCode = db.prepare(`SELECT id FROM products WHERE code = ? LIMIT 1`);
      const insProd = db.prepare(`
        INSERT INTO products(code, barcode, name, brand, category, cost, price, wholesale, stock, stock_min, unit, active)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      for (const p of inventario) {
        const code = (p.code || '').trim();
        if (!code) continue;
        if (findProdByCode.get(code)) { stats.prod_skip++; continue; }
        insProd.run(code, (p.barcode || code).trim(), (p.name || 'Producto').trim(),
          (p.brand || 'GENERICA').trim(), (p.category || 'GENERICO').trim(),
          _aioNum(p.cost), _aioNum(p.price), _aioNum(p.wholesale),
          parseInt(p.stock, 10) || 0, parseInt(p.stock_min, 10) || 5, (p.unit || 'UNIDAD').trim());
        stats.prod_new++;
      }
      const prodByCode = new Map(db.prepare(`SELECT id, code FROM products WHERE active=1`).all().map(x => [x.code, x.id]));

      // 4c) CLIENTES
      const mapCli = new Map();
      const insCli = db.prepare(`
        INSERT INTO customers(name, rnc, phone, address, email, credit_days, balance, active, old_id_cliente, import_source)
        VALUES(?, ?, ?, ?, ?, ?, 0, 1, ?, 'equiparts_bak')`);
      const findCliByOld = db.prepare(`SELECT id FROM customers WHERE old_id_cliente = ? LIMIT 1`);
      let allCustomers = db.prepare(`SELECT id, name FROM customers WHERE active=1`).all();
      for (const c of clientes) {
        const oldId = _aioIntOrNull(c.old_id_cliente);
        if (oldId == null) continue;
        const exist = findCliByOld.get(oldId);
        if (exist) { mapCli.set(oldId, exist.id); stats.cli_skip++; continue; }
        const byName = allCustomers.find(x => _aioNorm(x.name) === _aioNorm(c.name));
        if (byName) {
          db.prepare(`UPDATE customers SET old_id_cliente=?, import_source='equiparts_bak' WHERE id=?`).run(oldId, byName.id);
          mapCli.set(oldId, byName.id); stats.cli_skip++; continue;
        }
        const r = insCli.run(c.name || 'Cliente', c.rnc || '', c.phone || '', c.address || '',
          c.email || '', _aioIntOrNull(c.credit_days) || 30, oldId);
        mapCli.set(oldId, r.lastInsertRowid); stats.cli_new++;
      }
      const custByName = new Map(db.prepare(`SELECT id, name FROM customers WHERE active=1`).all().map(x => [_aioNorm(x.name), x.id]));
      const resolveCust = (oldId, name) => {
        if (oldId != null && mapCli.has(oldId)) return mapCli.get(oldId);
        const byOld = oldId != null ? findCliByOld.get(oldId) : null;
        if (byOld) return byOld.id;
        const byName = custByName.get(_aioNorm(name));
        if (byName) return byName.id;
        return 1;
      };

      // 4d) VENTAS + items
      const findSaleByOld = db.prepare(`SELECT id FROM sales WHERE old_id_factura = ? LIMIT 1`);
      const insSale = db.prepare(`
        INSERT INTO sales(cash_session_id, customer_id, customer_name, customer_rnc, type, status,
          subtotal, discount_pct, discount_amt, tax_pct, tax_amt, total, payment_method, price_mode,
          cajero, user_id, ncf, notes, created_at, numero_factura, numero_factura_fmt, old_id_factura, import_source)
        VALUES (?, ?, ?, '', ?, ?, ?, 0, 0, ?, ?, ?, ?, 'retail', 'Importación histórica', NULL, ?, ?, ?, ?, ?, ?, 'equiparts_bak')`);
      const insItem = db.prepare(`
        INSERT INTO sale_items(sale_id, product_id, product_code, product_name, unit_cost, unit_price, qty, subtotal)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?)`);
      const facturas = new Map();
      for (const v of ventas) {
        const oid = _aioIntOrNull(v.old_id_factura);
        if (oid == null) continue;
        if (!facturas.has(oid)) {
          facturas.set(oid, {
            old_id_factura: oid, numero_factura: _aioIntOrNull(v.numero_factura),
            numero_factura_fmt: v.numero_factura_fmt || '',
            ncf: (v.ncf || '').startsWith('B') ? v.ncf : '',
            customer_name: v.customer_name || 'Consumidor Final',
            old_id_cliente: _aioIntOrNull(v.old_id_cliente),
            date: (v.date || '').slice(0, 10), total: _aioNum(v.total), balance: _aioNum(v.balance),
            payment_method: v.payment_method || 'efectivo',
            status: v.status === 'cancelled' ? 'cancelled' : 'completed',
            type: 'factura', items: [],
          });
        }
        const f = facturas.get(oid);
        const pname = (v.product_name || '').trim();
        if (pname) f.items.push({
          product_code: v.product_code || 'IMP', product_name: pname,
          qty: Math.max(1, parseInt(v.qty, 10) || 1), unit_price: _aioNum(v.unit_price),
          line_total: _aioNum(v.line_total),
        });
      }
      const balByCust = new Map();
      const dueByCust = new Map();   // fecha de vencimiento más antigua por cliente (crédito con saldo)
      const custCreditDays = new Map(
        db.prepare(`SELECT id, COALESCE(credit_days,30) cd FROM customers`).all().map(x => [x.id, x.cd])
      );
      // Suma días a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD
      const addDays = (ymd, days) => {
        const d = new Date(ymd + 'T12:00');
        if (isNaN(d)) return null;
        d.setDate(d.getDate() + (parseInt(days, 10) || 30));
        return d.toISOString().slice(0, 10);
      };
      for (const f of facturas.values()) {
        if (findSaleByOld.get(f.old_id_factura)) { stats.fac_skip++; continue; }
        const custId = resolveCust(f.old_id_cliente, f.customer_name);
        const dt = (f.date || new Date().toISOString().split('T')[0]) + ' 00:00:00';
        const fmt = f.numero_factura_fmt || (f.numero_factura != null ? String(f.numero_factura).padStart(8,'0') : '');
        const notes = f.numero_factura != null ? `Factura #${fmt}${f.ncf ? ' | NCF:' + f.ncf : ''}` : 'Factura importada';
        const taxPct = 18;
        const r = insSale.run(null, custId, f.customer_name, f.type, f.status,
          f.total, taxPct, 0, f.total, f.payment_method, f.ncf, notes, dt,
          f.numero_factura, fmt, f.old_id_factura);
        const saleId = r.lastInsertRowid;
        const items = f.items.length ? f.items
          : [{ product_code: 'IMP', product_name: 'Factura importada', qty: 1, unit_price: f.total, line_total: f.total }];
        for (const it of items) {
          const pid = prodByCode.get((it.product_code || '').trim()) || null;
          insItem.run(saleId, pid, it.product_code, it.product_name, it.unit_price, it.qty,
            it.line_total || (it.unit_price * it.qty));
          stats.items++;
        }
        stats.fac_new++;
        if (f.balance > 0) {
          balByCust.set(custId, (balByCust.get(custId) || 0) + f.balance);
          // Vencimiento = fecha de la factura + días de crédito del cliente.
          // Guardamos la MÁS ANTIGUA (la más vencida) por cliente.
          const facDate = (f.date || '').slice(0, 10);
          const due = facDate ? addDays(facDate, custCreditDays.get(custId) || 30) : null;
          if (due) {
            const prev = dueByCust.get(custId);
            if (!prev || due < prev) dueByCust.set(custId, due);
          }
        }
      }

      // 4e) RECIBOS → payments
      const findPayByOld = db.prepare(`SELECT id FROM payments WHERE old_id_pago_detalle = ? LIMIT 1`);
      const findSaleForRec = db.prepare(`SELECT id, customer_id FROM sales WHERE old_id_factura = ? LIMIT 1`);
      const insPay = db.prepare(`
        INSERT INTO payments(customer_id, sale_id, amount, method, note, balance_before, balance_after,
          cajero, user_id, created_at, numero_recibo, old_id_pago_detalle, import_source)
        VALUES(?, ?, ?, ?, ?, 0, 0, 'Importación histórica', NULL, ?, ?, ?, 'equiparts_bak')`);
      for (const rc of recibos) {
        const oldPd = _aioIntOrNull(rc.old_id_pago_detalle);
        if (oldPd == null) continue;
        if (findPayByOld.get(oldPd)) { stats.rec_skip++; continue; }
        const sale = findSaleForRec.get(_aioIntOrNull(rc.old_id_factura));
        const custId = sale ? sale.customer_id : resolveCust(_aioIntOrNull(rc.old_id_cliente), rc.customer_name);
        const saleId = sale ? sale.id : null;
        const dt = ((rc.date || '').slice(0,10) || new Date().toISOString().split('T')[0]) + ' 00:00:00';
        const note = `Recibo #${rc.numero_recibo || ''}${rc.notes ? ' | ' + rc.notes : ''}`.trim();
        insPay.run(custId, saleId, _aioNum(rc.amount), (rc.method || 'efectivo').toLowerCase(),
          note, dt, _aioIntOrNull(rc.numero_recibo), oldPd);
        stats.rec_new++;
      }

      // 4f) BALANCE del cliente = suma balance_factura pendiente (BAK manda)
      // credit_due = fecha de vencimiento más antigua (fecha factura + credit_days).
      const setBal = db.prepare(`UPDATE customers SET balance = ?, credit_due = ? WHERE id = ?`);
      for (const [custId, bal] of balByCust.entries()) {
        const b = Math.round(bal * 100) / 100;
        const due = b > 0 ? (dueByCust.get(custId) || null) : null;
        setBal.run(b, due, custId);
      }
    });

    let importError = null;
    try { runAll(); }
    catch (e) { importError = e.message; }
    finally { db.pragma('foreign_keys = ON'); }

    if (importError) {
      return { ok: false, error: 'Import falló (transacción revertida): ' + importError, backup: backupPath };
    }

    // ── 5) Validación de integridad (CxC) ──────────────────────────────
    const cxc = db.prepare(`
      SELECT COALESCE(SUM(balance),0) AS cxc_total,
             COUNT(*) AS clientes_con_saldo
      FROM customers WHERE balance > 0`).get();
    const facturasImp = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE import_source='equiparts_bak'`).get().n;
    const cxcTotal = Math.round((cxc.cxc_total || 0) * 100) / 100;
    const cuadra = Math.abs(cxcTotal - ALLINONE_TARGET_CXC) < 0.01;

    try {
      audit(requestUserId || null, 'ALL IN ONE', 'migracion_allinone', 'sistema', null,
        `CxC ${cxcTotal} / ${cxc.clientes_con_saldo} clientes / ${facturasImp} facturas`);
    } catch (_) { /* auditoría no debe tumbar el resultado */ }

    return {
      ok: true,
      backup: backupPath,
      stats,
      cxc: cxcTotal,
      clientes_con_saldo: cxc.clientes_con_saldo,
      facturas: facturasImp,
      target: ALLINONE_TARGET_CXC,
      cuadra,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — ITEMS DE UNA VENTA (para modal cliente)
// ══════════════════════════════════════════════
ipcMain.handle('customers:getSaleItems', async (_, { saleId }) => {
  try {
    const db = require('./database').getDB();
    return { ok: true, items: db.prepare(
      'SELECT * FROM sale_items WHERE sale_id=? ORDER BY id ASC'
    ).all(saleId) };
  } catch(e) { return { ok: false, items: [], error: e.message }; }
});

// ══════════════════════════════════════════════
// IPC — FACTURAS A CRÉDITO PENDIENTES DE CLIENTE
// ══════════════════════════════════════════════
// Trae TODOS los items de las ventas de un cliente en una sola query.
// Usado por "Buscar por Artículo" en el modal de cliente. Rápido: un solo
// JOIN indexado por customer_id. Devuelve items con su venta asociada.
ipcMain.handle('customers:getItemsForCustomer', async (_, { customerId }) => {
  try {
    const db = require('./database').getDB();
    const rows = db.prepare(`
      SELECT si.sale_id, si.product_id, si.product_code, si.product_name,
             si.qty, si.unit_price, si.subtotal,
             s.created_at, s.total AS sale_total, s.payment_method,
             s.numero_factura, s.numero_factura_fmt, s.ncf, s.notes
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.customer_id = ? AND s.status != 'cancelled'
      ORDER BY s.id DESC
    `).all(customerId);
    return { ok: true, items: rows };
  } catch (e) {
    return { ok: false, items: [], error: e.message };
  }
});

ipcMain.handle('customers:getFacturasPendientes', async (_, { customerId }) => {
  try {
    const db = require('./database').getDB();
    // Obtener facturas a crédito en orden cronológico (ASC = FIFO)
    const sales = db.prepare(`
      SELECT s.id, s.total, s.subtotal, s.tax_amt, s.discount_amt,
             s.created_at, s.notes, s.ncf, s.status,
             s.numero_factura, s.numero_factura_fmt
      FROM sales s
      WHERE s.customer_id=? AND s.payment_method='credito'
        AND s.status!='cancelled' AND s.type='factura'
      ORDER BY s.created_at ASC
    `).all(customerId);

    // Total de pagos reales del cliente — excluir "Saldo inicial importado" porque ese
    // registro es un marcador contable que no corresponde a ninguna factura específica;
    // sumarlo aquí haría que el FIFO consuma facturas que siguen pendientes.
    const { totalPaid } = db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS totalPaid FROM payments WHERE customer_id=? AND note != 'Saldo inicial importado'"
    ).get(customerId);

    // Distribuir pagos FIFO: las facturas más antiguas se pagan primero
    let remaining = totalPaid;
    const facturas = sales.map(s => {
      const paid     = Math.min(remaining, s.total);
      remaining      = Math.max(0, remaining - paid);
      const pendiente = Math.max(0, Math.round((s.total - paid) * 100) / 100);
      return { ...s, pendiente };
    }).filter(s => s.pendiente > 0.005)
      .reverse(); // volver a DESC para mostrar las más recientes primero

    return { ok: true, facturas };
  } catch(e) { return { ok: false, facturas: [], error: e.message }; }
});

// ══════════════════════════════════════════════
// IPC — PROVEEDORES
// ══════════════════════════════════════════════
ipcMain.handle('suppliers:getAll', async () => {
  try { return { ok: true, data: suppliersRepo.getAll() }; }
  catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('suppliers:create', async (_, { data, requestUserId }) => {
  try {
    if (!data?.name?.trim()) return { ok: false, error: 'El nombre del proveedor es requerido' };
    const id = suppliersRepo.create(data);
    return { ok: true, id };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('suppliers:update', async (_, { id, data }) => {
  try {
    if (!id) return { ok: false, error: 'ID requerido' };
    if (!data?.name?.trim()) return { ok: false, error: 'El nombre del proveedor es requerido' };
    suppliersRepo.update(id, data); return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('suppliers:delete', async (_, { id, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo el administrador puede eliminar proveedores' };
    }
    suppliersRepo.delete(id);
    audit(requestUserId, reqUser.name, 'proveedor_eliminado', 'suppliers', id, '');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ══════════════════════════════════════════════
// IPC — ORDENES DE COMPRA
// ══════════════════════════════════════════════
ipcMain.handle('purchases:getAll', async (_, params) => {
  try { return { ok: true, data: purchasesRepo.getAll(params || {}) }; }
  catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('purchases:getById', async (_, { id }) => {
  try { return { ok: true, data: purchasesRepo.getById(id) }; }
  catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('purchases:create', async (_, data) => {
  try {
    if (!data?.items?.length) return { ok: false, error: 'La orden debe tener al menos un producto' };
    for (const item of data.items) {
      if (!item.product_name?.trim()) return { ok: false, error: 'Todos los items deben tener nombre' };
      if (!item.qty_ordered || item.qty_ordered <= 0) return { ok: false, error: 'La cantidad debe ser mayor a 0' };
      if (item.unit_cost < 0) return { ok: false, error: 'El costo no puede ser negativo' };
    }
    const result = purchasesRepo.create(data); return { ok: true, ...result };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('purchases:receive', async (_, { id, items, userId }) => {
  try {
    const result = purchasesRepo.receive(id, { items, userId });
    // Contabilidad devengada: valor recibido en ESTA recepción → Déb Inventario
    // (+ITBIS Acreditable proporcional) · Créd Cuentas por Pagar.
    const deltaValue = (items || []).reduce((s, it) =>
      s + ((it.qty_received > 0 ? it.qty_received : 0) * (it.unit_cost || 0)), 0);
    _acctHook(() => {
      const po = purchasesRepo.getById(id);
      const deltaTax = (po && po.tax_amt > 0 && po.subtotal > 0)
        ? (deltaValue / po.subtotal) * po.tax_amt : 0;
      const seq = (db.prepare("SELECT COUNT(*) c FROM accounting_entries WHERE source_module='compra' AND source_id=?").get(id)?.c || 0) + 1;
      accountingRepo.generatePurchaseEntry({ poId: id, deltaValue, deltaTax, receiveSeq: seq, userId });
    });
    return { ok: true, ...result };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('purchases:cancel', async (_, { id, userId }) => {
  try { purchasesRepo.cancel(id, userId); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});




// ══════════════════════════════════════════════
// IPC — SUCURSALES
// ══════════════════════════════════════════════
ipcMain.handle('branches:getAll', async () => {
  try { return { ok:true, data: branchesRepo.getAll() }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('branches:create', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    const id = branchesRepo.create(data);
    audit(requestUserId, u.name, 'sucursal_creada', 'branches', id, data.name);
    return { ok:true, id };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('branches:update', async (_, { id, data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    branchesRepo.update(id, data);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('branches:delete', async (_, { id, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || u.role !== 'superadmin') return { ok:false, error:'Solo superadmin' };
    branchesRepo.delete(id);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ══════════════════════════════════════════════
// IPC — VEHÍCULOS
// ══════════════════════════════════════════════
ipcMain.handle('vehicles:getAll', async () => {
  try { return { ok:true, data: vehiclesRepo.getAll() }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('vehicles:create', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    data.user_id = requestUserId;
    const id = vehiclesRepo.create(data);
    audit(requestUserId, u.name, 'vehiculo_creado', 'vehicles', id, `${data.brand} ${data.model}`);
    return { ok:true, id };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('vehicles:update', async (_, { id, data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    vehiclesRepo.update(id, data);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('vehicles:delete', async (_, { id, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    vehiclesRepo.delete(id);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('vehicles:calcFuel', async (_, { vehicleId, distanceKm, requestUserId }) => {
  try {
    // Fuente única: precio real de Presto (caché 6h). Antes usaba settings viejos.
    const fuelPrices = (await getFuelPricesCached()).data;
    const result = vehiclesRepo.calcFuelCost(vehicleId, distanceKm, fuelPrices);
    return { ok:true, data: result };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ══════════════════════════════════════════════
// IPC — MANTENIMIENTO
// ══════════════════════════════════════════════
ipcMain.handle('maintenance:getTypes', async () => {
  try { return { ok:true, data: maintenanceRepo.getTypes() }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('maintenance:getByVehicle', async (_, { vehicleId }) => {
  try { return { ok:true, data: maintenanceRepo.getByVehicle(vehicleId) }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('maintenance:getPending', async () => {
  try { return { ok:true, data: maintenanceRepo.getPending() }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('maintenance:create', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    data.user_id = requestUserId;
    const id = maintenanceRepo.create(data);
    // Actualizar odómetro del vehículo si viene
    if (data.odometer_at) {
      const v = vehiclesRepo.getById(data.vehicle_id);
      if (v && data.odometer_at > v.odometer) {
        vehiclesRepo.update(data.vehicle_id, { ...v, odometer: data.odometer_at });
      }
    }
    return { ok:true, id };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('maintenance:delete', async (_, { id, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    maintenanceRepo.delete(id);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ══════════════════════════════════════════════
// IPC — ENVÍOS
// ══════════════════════════════════════════════
ipcMain.handle('deliveries:getAll', async (_, filters) => {
  try { return { ok:true, data: deliveriesRepo.getAll(filters||{}) }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('deliveries:getSummary', async () => {
  try { return { ok:true, data: deliveriesRepo.getSummary() }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('deliveries:create', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok:false, error:'Sin sesión' };
    data.user_id = requestUserId;
    // Calcular combustible si tiene vehículo y distancia.
    // Fuente única: precio real de Presto (caché 6h). Así lo que se GUARDA en el
    // envío coincide con lo que el usuario vio en el modal (que ya usa precio live).
    if (data.vehicle_id && data.distance_km) {
      const fuelPrices = (await getFuelPricesCached()).data;
      const calc = vehiclesRepo.calcFuelCost(data.vehicle_id, data.distance_km, fuelPrices);
      if (calc) { data.fuel_used = calc.gallons; data.fuel_cost = calc.cost; }
    }
    const id = deliveriesRepo.create(data);
    audit(requestUserId, u.name, 'envio_creado', 'deliveries', id, data.dest_address);
    return { ok:true, id, fuel_cost: data.fuel_cost };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('deliveries:updateStatus', async (_, { id, status, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok:false, error:'Sin sesión' };
    deliveriesRepo.updateStatus(id, status, requestUserId);
    audit(requestUserId, u.name, `envio_${status}`, 'deliveries', id, '');
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});

// Geocoding + distancia por carretera.
// DEBE correr en el proceso main: el CSP del renderer (connect-src 'self')
// bloquea todo fetch externo, por eso desde envios.js daba "Failed to fetch".
// Aquí usamos net.fetch (Electron), que no está sujeto al CSP.
ipcMain.handle('deliveries:geocode', async (_, { address, originLat, originLng } = {}) => {
  try {
    if (!address || !String(address).trim()) return { ok: false, error: 'Ingresa una dirección primero' };
    const { net } = require('electron');
    const q = encodeURIComponent(String(address).trim() + ', República Dominicana');

    // 1) Geocoding con Nominatim (OpenStreetMap). Requiere User-Agent identificable.
    const geoRes = await net.fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
      { headers: { 'User-Agent': 'VeloPOS/1.10 (soporte@velopos.do)' }, signal: AbortSignal.timeout(10000) }
    );
    if (!geoRes.ok) return { ok: false, error: `Servicio de mapas no disponible (${geoRes.status})` };
    const geo = await geoRes.json();
    if (!Array.isArray(geo) || geo.length === 0) {
      return { ok: false, error: 'Dirección no encontrada. Intenta ser más específico.' };
    }
    const lat = parseFloat(geo[0].lat), lng = parseFloat(geo[0].lon);
    const display_name = geo[0].display_name || String(address);

    // 2) Distancia por carretera con OSRM. Origen configurable (default: Santiago).
    const oLat = Number.isFinite(originLat) ? originLat : 19.2207;
    const oLng = Number.isFinite(originLng) ? originLng : -70.5291;
    let distance_km = null;
    try {
      const osrmRes = await net.fetch(
        `https://router.project-osrm.org/route/v1/driving/${oLng},${oLat};${lng},${lat}?overview=false`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (osrmRes.ok) {
        const osrm = await osrmRes.json();
        if (osrm && osrm.routes && osrm.routes[0]) {
          distance_km = Math.round((osrm.routes[0].distance / 1000) * 10) / 10;
        }
      }
    } catch {}

    return { ok: true, lat, lng, display_name, distance_km };
  } catch (e) {
    return { ok: false, error: 'No se pudo conectar al servicio de mapas: ' + e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — CONDUCE / NOTA DE ENTREGA
// ──────────────────────────────────────────────
// Documento de entrega. NO fiscal (sin NCF/ITBIS/CxC) y NO mueve inventario.
// Permisos: crear/ver por cualquier sesión; anular solo admin/superadmin.
// Toda acción sensible se audita con estado anterior → nuevo.
// ══════════════════════════════════════════════
ipcMain.handle('conduce:getAll', async (_, filters = {}) => {
  try { return { ok: true, data: conduceRepo.getAll(filters || {}) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('conduce:getById', async (_, { id }) => {
  try { return { ok: true, data: conduceRepo.getById(id) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('conduce:generateNumber', async () => {
  try { return { ok: true, number: conduceRepo.generateNumber() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('conduce:create', async (_, { header = {}, items = [], requestUserId } = {}) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok: false, error: 'Sin sesión' };
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'El conduce debe tener al menos un producto' };
    const id = conduceRepo.create({ header, items, userId: requestUserId });
    const dn = conduceRepo.getById(id);
    audit(requestUserId, u.name, 'conduce_creado', 'delivery_notes', id,
      `${dn.number} · ${dn.customer_name} · ${items.length} líneas`);
    return { ok: true, id, data: dn };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('conduce:update', async (_, { id, header = {}, items = null, requestUserId } = {}) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok: false, error: 'Sin sesión' };
    const dn = conduceRepo.update(id, { header, items });
    audit(requestUserId, u.name, 'conduce_editado', 'delivery_notes', id, dn.number);
    return { ok: true, data: dn };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('conduce:setStatus', async (_, { id, status, data = {}, requestUserId } = {}) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok: false, error: 'Sin sesión' };
    const prev = conduceRepo.getById(id);
    if (!prev) return { ok: false, error: 'Conduce no encontrado' };
    const dn = conduceRepo.setStatus(id, status, { ...data, userId: requestUserId });
    audit(requestUserId, u.name, `conduce_${status}`, 'delivery_notes', id,
      `${dn.number}: ${prev.status} → ${status}`);
    return { ok: true, data: dn };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('conduce:cancel', async (_, { id, reason, requestUserId } = {}) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin', 'superadmin'].includes(u.role)) {
      return { ok: false, error: 'Solo admin puede anular un conduce' };
    }
    const prev = conduceRepo.getById(id);
    if (!prev) return { ok: false, error: 'Conduce no encontrado' };
    const dn = conduceRepo.cancel(id, { userId: requestUserId, reason });
    audit(requestUserId, u.name, 'conduce_anulado', 'delivery_notes', id,
      `${dn.number}: ${prev.status} → anulado · Motivo: ${(reason || '').trim()}`);
    return { ok: true, data: dn };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Vista previa de lo facturable (por línea) — para la UI de facturación parcial.
ipcMain.handle('conduce:invoiceable', async (_, { id } = {}) => {
  try { return { ok: true, data: conduceRepo.invoiceableLines(id) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Facturar desde conduce: crea la factura (descuenta stock 1 vez) + enlaza.
ipcMain.handle('conduce:invoice', async (_, { id, lines = null, payment = {}, priceMode = 'retail', sessionId = null, requestUserId } = {}) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok: false, error: 'Sin sesión' };
    // Caja abierta para la factura (igual que una venta normal)
    const session = cashRepo.getOpen ? cashRepo.getOpen(_reqTerminalId()) : (sessionId ? { id: sessionId } : null);
    const res = conduceRepo.invoiceFromConduce({
      conduceId: id, lines, payment, priceMode,
      session, user: { id: u.id, name: u.name },
    });
    audit(requestUserId, u.name, 'conduce_facturado', 'delivery_notes', id,
      `${res.conduce.number} → factura #${res.saleId} · Total: ${res.total}`);
    return { ok: true, ...res };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Reportes de conduce (agregaciones de solo lectura).
ipcMain.handle('conduce:reports', async (_, filters = {}) => {
  try { return { ok: true, data: conduceRepo.reports(filters || {}) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Generar un conduce a partir de una cotización o factura existente.
ipcMain.handle('conduce:fromSale', async (_, { saleId, requestUserId } = {}) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok: false, error: 'Sin sesión' };
    const dn = conduceRepo.createFromSale(saleId, { userId: requestUserId });
    audit(requestUserId, u.name, 'conduce_desde_venta', 'delivery_notes', dn.id,
      `${dn.number} desde ${dn.source_type} #${saleId}`);
    return { ok: true, data: dn };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ══════════════════════════════════════════════
// IPC — NCF AVANZADO
// ══════════════════════════════════════════════
ipcMain.handle('ncf:getSequences', async () => {
  try { return { ok:true, data: ncfRepo.getSequences() }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('ncf:createSequence', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    const id = ncfRepo.createSequence(data);
    audit(requestUserId, u.name, 'ncf_secuencia_creada', 'ncf_sequences', id, `${data.type}: ${data.from_num}-${data.to_num}`);
    return { ok:true, id };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('ncf:getAlerts', async () => {
  try { return { ok:true, data: ncfRepo.getAlerts() }; } catch(e) { return { ok:false, error:e.message }; }
});
// Log de comprobantes — base de los reportes 607 (emitidos) y 608 (anulados).
ipcMain.handle('ncf:getLog', async (_, { from, to, status, type } = {}) => {
  try { return { ok:true, data: ncfRepo.getLog({ from, to, status, type }) }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('ncf:getVoided', async (_, { from, to } = {}) => {
  try { return { ok:true, data: ncfRepo.getVoided({ from, to }) }; } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('ncf:validateRnc', async (_, { rnc }) => {
  try {
    const clean = (rnc || '').replace(/[-\s]/g, '').trim();
    if (clean.length < 9) return { ok:false, error:'RNC debe tener al menos 9 dígitos' };
    if (clean.length > 11) return { ok:false, error:'RNC no puede tener más de 11 dígitos' };

    const { net } = require('electron');

    // ── API principal: rnc.megaplus.com.do ─────────────────────────────
    // API JSON real que consulta directamente la DGII
    // Devuelve 404 cuando el RNC no existe — no hay falsos positivos
    try {
      const url = 'https://rnc.megaplus.com.do/api/consulta?rnc=' + clean;
      const r = await net.fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'VeloPOS/1.5.5',
        }
      });

      const data = await r.json();

      // HTTP 200 — RNC encontrado y válido
      if (r.ok && data && !data.error) {
        return {
          ok: true,
          rnc:      data.cedula_rnc      || clean,
          nombre:   data.nombre_razon_social || data.nombre_comercial || 'Sin nombre',
          comercial: data.nombre_comercial || '',
          estado:   data.estado          || 'ACTIVO',
          categoria: data.actividad_economica || '',
          regimen:  data.regimen_de_pagos || '',
          electronico: data.facturador_electronico || 'NO',
          fuente:   'DGII vía rnc.megaplus.com.do',
        };
      }

      // HTTP 404 — RNC no inscrito en la DGII
      if (r.status === 404) {
        return { ok:false, error:'RNC ' + clean + ' no se encuentra inscrito como contribuyente en la DGII' };
      }

      // HTTP 400 — formato inválido
      if (r.status === 400) {
        return { ok:false, error:'Formato de RNC inválido. Debe tener 9 o 11 dígitos.' };
      }

      // Otro error de servidor
      return { ok:false, error:'Error del servidor DGII (código ' + r.status + '). Intenta de nuevo.' };

    } catch(e1) {
      console.warn('[RNC] megaplus.com.do error:', e1.message);
      // Fallback: api.rncrd.com si megaplus falla
      try {
        const r2 = await net.fetch('https://api.rncrd.com/api/rnc/' + clean, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'VeloPOS/1.5.5' }
        });
        if (r2.ok) {
          const d2 = await r2.json();
          if (d2 && d2.nombre) {
            return { ok:true, rnc: clean, nombre: d2.nombre, estado: d2.estado||'ACTIVO', fuente: 'api.rncrd.com' };
          }
        }
        return { ok:false, error:'RNC no encontrado en la DGII' };
      } catch(e2) {
        return { ok:false, error:'Sin conexión a internet. Verifica tu red e intenta de nuevo.' };
      }
    }
  } catch(e) {
    return { ok:false, error:'Error inesperado: ' + e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — MÓDULO GASTOS Y CUENTAS POR PAGAR
// ══════════════════════════════════════════════

// ── Configuración ─────────────────────────────
ipcMain.handle('expenses:getConfig', async (_, { requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    return { ok:true, config: expensesRepo.getConfig() };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:setConfig', async (_, { key, value, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    expensesRepo.setConfig(key, value);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ── Categorías ────────────────────────────────
ipcMain.handle('expenses:getCategories', async () => {
  try { return { ok:true, data: expensesRepo.getCategories() }; }
  catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:createCategory', async (_, data) => {
  try {
    const u = authRepo.findById(data.requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    const id = expensesRepo.createCategory(data);
    audit(data.requestUserId, u.name, 'categoria_gasto_creada', 'expense_categories', id, data.name);
    return { ok:true, id };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:updateCategory', async (_, { id, requestUserId, ...data }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    expensesRepo.updateCategory(id, data);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ── Gastos ────────────────────────────────────
ipcMain.handle('expenses:getAll', async (_, filters) => {
  try { return { ok:true, data: expensesRepo.getAll(filters||{}) }; }
  catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:getById', async (_, { id }) => {
  try { return { ok:true, data: expensesRepo.getById(id) }; }
  catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:getSummary', async (_, filters) => {
  try { return { ok:true, data: expensesRepo.getSummary(filters||{}) }; }
  catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('expenses:create', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok:false, error:'Usuario no válido' };

    // Verificar límite de cajero
    const cfg = expensesRepo.getConfig();
    const cajeroLimit = parseFloat(cfg.cajero_limit || 1500);
    let status = data.status || 'pendiente_pago';

    if (u.role === 'cajero') {
      // Cajero solo puede registrar desde caja abierta
      const session = cashRepo.getOpen(_reqTerminalId());
      if (!session) return { ok:false, error:'Debes tener una caja abierta para registrar gastos' };
      data.cash_session_id = session.id;
      data.payment_source = 'caja';
      if ((data.total || data.amount || 0) > cajeroLimit) {
        status = 'pendiente_aprobacion';
        data.payment_source = 'pendiente';
      }
    }

    data.status = status;
    data.user_id = requestUserId;
    const id = expensesRepo.create(data);
    audit(requestUserId, u.name, 'gasto_creado', 'expenses', id, data.description);

    // Si es cajero, pago directo sin aprobación y caja disponible
    let autoPay = null;
    if (u.role === 'cajero' && status === 'pendiente_pago' && data.payment_source === 'caja') {
      const session = cashRepo.getOpen(_reqTerminalId());
      if (session) {
        autoPay = expensesRepo.pay({
          expenseId: id, amount: data.total || data.amount,
          payment_method: data.payment_method || 'efectivo',
          payment_source: 'caja', cash_session_id: session.id,
          userId: requestUserId, userName: u.name
        });
      }
    }

    // Contabilidad en vivo (devengado): reconoce el gasto y la CxP; si hubo pago
    // inmediato, además salda la CxP contra Caja/Banco.
    _acctHook(() => {
      accountingRepo.generateExpenseAccrualEntry({ expenseId: id, userId: requestUserId });
      if (autoPay?.paymentId) accountingRepo.generateExpensePaymentEntry({ paymentId: autoPay.paymentId, userId: requestUserId });
    });
    return { ok:true, id, status };
  } catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('expenses:pay', async (_, { expenseId, amount, payment_method, payment_source, reference, notes, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u) return { ok:false, error:'Usuario no válido' };
    if (u.role === 'cajero' && !['admin','superadmin'].includes(u.role)) {
      return { ok:false, error:'Solo el administrador puede registrar pagos' };
    }
    let cash_session_id = null;
    if (payment_source === 'caja') {
      const session = cashRepo.getOpen(_reqTerminalId());
      if (!session) return { ok:false, error:'No hay caja abierta' };
      cash_session_id = session.id;
    }
    const result = expensesRepo.pay({ expenseId, amount, payment_method, payment_source,
      cash_session_id, reference, notes, userId: requestUserId, userName: u.name });
    // Contabilidad en vivo (devengado): asegura el devengo (idempotente) y salda
    // la CxP con este pago (Déb CxP · Créd Caja/Banco).
    _acctHook(() => {
      accountingRepo.generateExpenseAccrualEntry({ expenseId, userId: requestUserId });
      if (result?.paymentId) accountingRepo.generateExpensePaymentEntry({ paymentId: result.paymentId, userId: requestUserId });
    });
    return result;
  } catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('expenses:approve', async (_, { expenseId, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    return expensesRepo.approve(expenseId, requestUserId, u.name);
  } catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('expenses:reject', async (_, { expenseId, reason, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    if (!reason?.trim()) return { ok:false, error:'El motivo es obligatorio' };
    return expensesRepo.reject(expenseId, requestUserId, u.name, reason);
  } catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('expenses:cancel', async (_, { expenseId, reason, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Solo el administrador puede anular gastos' };
    if (!reason?.trim()) return { ok:false, error:'El motivo de anulación es obligatorio' };
    const r = expensesRepo.cancel(expenseId, requestUserId, u.name, reason);
    // Contabilidad en vivo: reversar TODOS los asientos del gasto anulado
    // (legacy caja + devengo + pagos).
    _acctHook(() => {
      const motivo = 'Gasto anulado: ' + (reason || '');
      accountingRepo.reverseSourceEntries('gasto',      expenseId, requestUserId, motivo);
      accountingRepo.reverseSourceEntries('gasto_dev',  expenseId, requestUserId, motivo);
      accountingRepo.reverseSourceEntries('gasto_pago', expenseId, requestUserId, motivo);
    });
    return r;
  } catch(e) { return { ok:false, error:e.message }; }
});

// ── Cuentas por pagar ─────────────────────────
ipcMain.handle('expenses:getPayable', async (_, { requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    return { ok:true, data: expensesRepo.getAccountsPayable() };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ── Gastos recurrentes ────────────────────────
ipcMain.handle('expenses:getRecurring', async (_, { requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    return { ok:true, data: expensesRepo.getRecurring() };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:createRecurring', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    data.user_id = requestUserId;
    const id = expensesRepo.createRecurring(data);
    return { ok:true, id };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:toggleRecurring', async (_, { id, active, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    expensesRepo.toggleRecurring(id, active);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ── Presupuestos ──────────────────────────────
ipcMain.handle('expenses:getBudgets', async (_, { month, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    return { ok:true, data: expensesRepo.getBudgets(month) };
  } catch(e) { return { ok:false, error:e.message }; }
});
ipcMain.handle('expenses:upsertBudget', async (_, { data, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || !['admin','superadmin'].includes(u.role)) return { ok:false, error:'Sin permisos' };
    data.user_id = requestUserId;
    expensesRepo.upsertBudget(data);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
});


// ══════════════════════════════════════════════
// MULTI-NEGOCIOS
// ══════════════════════════════════════════════

function getBusinessesDir() {
  return path.join(DATA_DIR, 'negocios');
}

function getBusinessDir(bizId) {
  return path.join(getBusinessesDir(), String(bizId));
}

function loadBusinesses() {
  const dir = getBusinessesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => fs.existsSync(path.join(dir, d, 'meta.json')))
    .map(d => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, d, 'meta.json'), 'utf8'));
        return { ...meta, id: d };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getActiveBusiness() {
  const f = path.join(DATA_DIR, 'active_business.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}

function setActiveBusiness(bizId) {
  fs.writeFileSync(
    path.join(DATA_DIR, 'active_business.json'),
    JSON.stringify({ id: bizId, set_at: new Date().toISOString() })
  );
}

// IPC — Multi-negocios
ipcMain.handle('business:getAll', async () => {
  try { return { ok: true, data: loadBusinesses() }; }
  catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('business:getActive', async () => {
  try { return { ok: true, data: getActiveBusiness() }; }
  catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('business:create', async (_, { name, description, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || u.role !== 'superadmin') return { ok: false, error: 'Solo superadmin' };

    const bizId = 'biz_' + Date.now();
    const bizDir = getBusinessDir(bizId);
    fs.mkdirSync(bizDir, { recursive: true });

    // Guardar metadata del negocio
    fs.writeFileSync(path.join(bizDir, 'meta.json'), JSON.stringify({
      id: bizId, name, description: description || '',
      created_at: new Date().toISOString(), active: true
    }));

    // Inicializar DB propia para este negocio
    const { initDB: initBizDB } = require('./database');
    initBizDB(bizDir);

    audit(requestUserId, u.name, 'negocio_creado', 'businesses', bizId, name);
    return { ok: true, id: bizId };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('business:switch', async (_, { bizId, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || u.role !== 'superadmin') return { ok: false, error: 'Solo superadmin' };
    const bizDir = getBusinessDir(bizId);
    if (!fs.existsSync(path.join(bizDir, 'meta.json'))) return { ok: false, error: 'Negocio no encontrado' };
    setActiveBusiness(bizId);
    return { ok: true, restart_required: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('business:delete', async (_, { bizId, requestUserId }) => {
  try {
    const u = authRepo.findById(requestUserId);
    if (!u || u.role !== 'superadmin') return { ok: false, error: 'Solo superadmin' };
    const bizDir = getBusinessDir(bizId);
    if (fs.existsSync(bizDir)) fs.rmSync(bizDir, { recursive: true });
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});



// ══════════════════════════════════════════════
// IPC — DIAGNÓSTICO DEL SISTEMA
// Solo accesible para superadmin
// ══════════════════════════════════════════════
ipcMain.handle('system:diagnose', async (_, { requestUserId } = {}) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || reqUser.role !== 'superadmin') {
      return { ok: false, error: 'Sin permisos' };
    }

    const dbInst = require('./database').getDB();
    return await runSystemDoctor({
      db: dbInst,
      dataDir: DATA_DIR,
      appRoot: __dirname,
      cashRepo,
      settingsRepo,
      getLicenseStatus,
      mainWindow,
    });

  } catch(e) {
    console.error('[system:diagnose]', e);
    return { ok: false, error: e.message };
  }
});


// ── Precio de combustible — scraping Presto + MICM ──────────────
// ══════════════════════════════════════════════
// PRECIOS DE COMBUSTIBLE — FUENTE ÚNICA: Presto (scraping) con caché en main
// ──────────────────────────────────────────────
// Una sola fuente para TODO el sistema (banner, costo/km, costo de envíos):
// se scrapea prestocombustibles.com (respaldo: MICM). El resultado se cachea
// 6h en el proceso main — los precios cambian una vez por semana (viernes),
// así que 6h es "tiempo real" para este dato y evita golpear la web en cada
// cálculo. getFuelPricesCached() es el ÚNICO punto de lectura de precios.
// Red de seguridad si el scraping falla. Valores vigentes semana 27 jun - 3 jul 2026.
const FUEL_FALLBACK = {
  premium:        341.10,
  regular:        310.50,
  diesel:         293.10,  // Gasoil Óptimo
  gasoil_regular: 262.80,
  kerosene:       279.80,
  glp:            137.20,
  gnv:             43.97,
};

function _cleanFuelNum(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^\d.]/g, ''));
  // GNV ronda los RD$44, así que el piso debe ser bajo; techo amplio por seguridad.
  return (n > 10 && n < 2000) ? n : null;
}

// Baja los precios de la web. Devuelve { source, data } o null si nada sirve.
async function _scrapeFuelPrices() {
  // ── FUENTE 1: prestocombustibles.com (tabla limpia) ───────────
  try {
    const res = await fetch('https://www.prestocombustibles.com/precios-combustibles/', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VeloPOS/1.10' }
    });
    if (res.ok) {
      const html = await res.text();
      // Estructura real de la tabla: <td>Gasolina Premium</td><td>RD$ 341.10</td>
      // etiqueta → hasta 40 chars (cubre </td><td>) → 'RD$' número.
      const get = (label) => {
        const rx = new RegExp(label + '[\\s\\S]{0,40}?RD\\$?\\s*([\\d.,]+)', 'i');
        return _cleanFuelNum(html.match(rx)?.[1]);
      };
      const premium  = get('Gasolina Premium') || get('Premium');
      const regular  = get('Gasolina Regular') || get('Regular');
      const diesel   = get('Gasoil .ptimo');
      const gasoilR  = get('Gasoil Regular');
      const kerosene = get('Kerosene');
      const glp      = get('Gas Licuado') || get('GLP');
      const gnv      = get('Gas Natural') || get('GNV');
      if (premium && premium > 200) {
        return {
          source: 'prestocombustibles',
          data: {
            premium,
            regular:        regular  || Math.round(premium * 0.917 * 10) / 10,
            diesel:         diesel   || Math.round(premium * 0.857 * 10) / 10,
            gasoil_regular: gasoilR  || Math.round(premium * 0.775 * 10) / 10,
            kerosene:       kerosene || FUEL_FALLBACK.kerosene,
            glp:            glp      || FUEL_FALLBACK.glp,
            gnv:            gnv      || FUEL_FALLBACK.gnv,
          }
        };
      }
    }
  } catch(e) { console.warn('[Fuel] Presto error:', e.message); }

  // ── FUENTE 2 (respaldo): micm.gob.do (artículo más reciente) ──
  try {
    const listRes = await fetch('https://micm.gob.do/tag/precios-de-combustible/', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VeloPOS/1.10' }
    });
    if (listRes.ok) {
      const listHtml = await listRes.text();
      const urlMatch = listHtml.match(/href="(https:\/\/micm\.gob\.do\/[^"]*(?:combustible|gasolina|reajusta|precio)[^"]*?)"/i);
      if (urlMatch) {
        const artRes = await fetch(urlMatch[1], {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'VeloPOS/1.10' }
        });
        if (artRes.ok) {
          const html    = await artRes.text();
          const matchP  = html.match(/[Gg]asolina\s*[Pp]r[eé]mium[^<\d]{0,40}([\d,.]+)/i);
          const matchR  = html.match(/[Gg]asolina\s*[Rr]egular[^<\d]{0,40}([\d,.]+)/i);
          const matchDO = html.match(/[Gg]asoil\s*[ÓOo]ptimo[^<\d]{0,40}([\d,.]+)/i);
          const matchDR = html.match(/[Gg]asoil\s*[Rr]egular[^<\d]{0,40}([\d,.]+)/i);
          const matchK  = html.match(/[Kk]erosene[^<\d]{0,40}([\d,.]+)/i);
          const matchG  = html.match(/[Gg][Ll][Pp][^<\d]{0,30}([\d,.]+)/i);
          const premium = _cleanFuelNum(matchP?.[1]);
          if (premium && premium > 200) {
            return {
              source: 'micm',
              data: {
                premium,
                regular:        _cleanFuelNum(matchR?.[1])  || Math.round(premium * 0.917 * 10) / 10,
                diesel:         _cleanFuelNum(matchDO?.[1]) || Math.round(premium * 0.857 * 10) / 10,
                gasoil_regular: _cleanFuelNum(matchDR?.[1]) || Math.round(premium * 0.775 * 10) / 10,
                kerosene:       _cleanFuelNum(matchK?.[1])  || FUEL_FALLBACK.kerosene,
                glp:            _cleanFuelNum(matchG?.[1])  || FUEL_FALLBACK.glp,
                gnv:            FUEL_FALLBACK.gnv,
              }
            };
          }
        }
      }
    }
  } catch(e) { console.warn('[Fuel] MICM error:', e.message); }

  return null;
}

// Caché de 6h en el proceso main. ÚNICO punto de lectura de precios de combustible.
let _fuelCache   = null;   // { source, data }
let _fuelCacheTs = 0;
const FUEL_CACHE_MS = 6 * 60 * 60 * 1000;

async function getFuelPricesCached(force = false) {
  if (!force && _fuelCache && (Date.now() - _fuelCacheTs) < FUEL_CACHE_MS) {
    return _fuelCache;
  }
  const fresh = await _scrapeFuelPrices();
  if (fresh && fresh.data && fresh.data.premium > 100) {
    _fuelCache   = fresh;
    _fuelCacheTs = Date.now();
    return _fuelCache;
  }
  // Falló el scraping: usar el último valor bueno si existe; si no, el fallback.
  return _fuelCache || { source: 'fallback', data: FUEL_FALLBACK };
}

ipcMain.handle('fuel:getPrices', async () => {
  const r = await getFuelPricesCached();
  return { ok: true, source: r.source, data: r.data };
});


// ── e-CF MSeller — handlers IPC ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Cache de autenticación MSeller ────────────────────────────────────────────
let _msellerToken     = null;
let _msellerTokenExp  = 0;

async function _msellerAuth(email, password) {
  if (_msellerToken && Date.now() < _msellerTokenExp) return _msellerToken;
  const env = db?.prepare("SELECT value FROM settings WHERE key='ecf_environment'").get()?.value || 'test';
  const base = env === 'production'
    ? 'https://ecf.api.mseller.app/eCF'
    : 'https://ecf.api.mseller.app/TesteCF';
  const res = await fetch(`${base}/customer/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`MSeller auth error: ${res.status}`);
  const data = await res.json();
  _msellerToken    = data.idToken;
  _msellerTokenExp = Date.now() + (55 * 60 * 1000); // 55 min
  return _msellerToken;
}

// ── Emitir e-CF para una venta ────────────────────────────────────────────────
ipcMain.handle('ecf:emit', async (_, { saleId }) => {
  try {
    // 1. Obtener datos de la venta
    const sale = db.prepare(`
      SELECT s.*, c.name as cust_name, c.rnc as cust_rnc, c.email as cust_email,
             c.address as cust_addr
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.id = ?
    `).get(saleId);
    if (!sale) return { ok: false, error: 'Venta no encontrada' };
    if (sale.ecf_status === 'Aceptado') return { ok: false, error: 'Ya tiene e-CF emitido' };

    // 2. Obtener items de la venta
    const items = db.prepare(`
      SELECT si.*, p.name as product_name
      FROM sale_items si
      LEFT JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `).all(saleId);

    // 3. Obtener configuración del negocio
    const getSet = k => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value || '';
    const rnc          = (getSet('biz_rnc') || getSet('rnc')).replace(/[-\s]/g, '');
    const bizName      = getSet('biz_name') || getSet('biz') || 'NEGOCIO';
    const apiKey       = getSet('ecf_api_key');
    const msellerEmail = getSet('ecf_email');
    const msellerPass  = getSet('ecf_password');
    const env          = getSet('ecf_environment') || 'test';

    if (!apiKey || !msellerEmail || !msellerPass) {
      return { ok: false, error: 'Configura las credenciales de facturación electrónica en Configuración' };
    }
    if (!rnc) return { ok: false, error: 'El negocio no tiene RNC configurado' };

    // 4. Autenticar con MSeller
    const token = await _msellerAuth(msellerEmail, msellerPass);

    // 5. Determinar tipo de e-CF por el documento del cliente (mismo criterio
    //    que la emisión de NCF impresos):
    //    · RNC de 9 dígitos            → E31 (Crédito Fiscal, equiv. B01)
    //    · Cédula de 11 díg. o sin doc → E32 (Consumo, equiv. B02)
    const custRnc = (sale.cust_rnc || '').replace(/\D/g, '');
    const tipoECF = custRnc.length === 9 ? '31' : '32';

    // 6. Construir el JSON según estructura DGII/MSeller
    const itbis    = sale.tax_amt  || 0;
    const subtotal = sale.subtotal || 0;
    const total    = sale.total    || 0;
    const discAmt  = sale.discount_amt || 0;

    // Items con ITBIS
    const detalles = items.map((item, idx) => {
      const precioUnit = Number(item.unit_price ?? item.price ?? 0);
      const cantidad   = Number(item.qty ?? item.quantity ?? 1);
      const monto      = item.subtotal || (precioUnit * cantidad);
      const taxRate    = (Number(sale.tax_pct) || 0) / 100;
      const itbisItem  = itbis > 0 ? parseFloat((monto * taxRate).toFixed(2)) : 0;
      return {
        NumeroLinea:          String(idx + 1),
        IndicadorFacturacion: itbis > 0 ? '1' : '3', // 1=ITBIS, 3=exento
        NombreItem:           item.product_name || item.name || `Producto ${idx+1}`,
        CantidadItem:         String(cantidad),
        UnidadMedida:         'UN',
        PrecioUnitarioItem:   precioUnit.toFixed(2),
        DescuentoMonto:       discAmt > 0 ? discAmt.toFixed(2) : undefined,
        TablaSubDescuento:    undefined,
        MontoItem:            monto.toFixed(2),
        ITBIS:                itbisItem > 0 ? itbisItem.toFixed(2) : undefined,
      };
    }).map(item => {
      // Limpiar campos undefined
      Object.keys(item).forEach(k => item[k] === undefined && delete item[k]);
      return item;
    });

    const fechaHoy = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const ecfDoc = {
      ECF: {
        Encabezado: {
          Version: '1.0',
          IdDoc: {
            TipoeCF:                    tipoECF,
            TipoPago:                   sale.payment_method === 'credito' ? '2' : '1', // 1=contado, 2=crédito
            FechaVencimientoSecuencia:  '31-12-2027',
            TotalPagado:                total.toFixed(2),
            FechaDePago:                fechaHoy,
          },
          Emisor: {
            RNCEmisor:         rnc,
            RazonSocialEmisor: bizName,
            NombreComercial:   bizName,
            Sucursal:          '001',
            DireccionEmisor:   getSet('biz_addr') || getSet('addr') || 'República Dominicana',
            Telefono:          (getSet('biz_phone') || getSet('phone') || '').replace(/[^0-9]/g, '').slice(0, 10),
            WebSite:           '',
            ActividadEconomica: getSet('actividad') || '479900',
            CodigoVendedor:    String(sale.user_id || 1),
          },
          Comprador: custRnc ? {
            RNCComprador:           custRnc,
            RazonSocialComprador:   sale.cust_name || '',
            ContactoComprador:      sale.cust_name || '',
            CorreoComprador:        sale.cust_email || '',
          } : undefined,
          Totales: {
            MontoGravadoTotal:   itbis > 0 ? subtotal.toFixed(2) : undefined,
            MontoGravadoI1:      itbis > 0 ? subtotal.toFixed(2) : undefined,
            MontoExento:         itbis === 0 ? subtotal.toFixed(2) : undefined,
            ITBIS1:              itbis > 0 ? '0.18' : undefined,
            TotalITBIS:          itbis > 0 ? itbis.toFixed(2) : undefined,
            TotalITBIS1:         itbis > 0 ? itbis.toFixed(2) : undefined,
            MontoTotal:          total.toFixed(2),
            MontoNoFacturable:   undefined,
          },
        },
        DetallesItems: {
          Item: detalles,
        },
      },
    };

    // Limpiar undefined del objeto
    const cleanObj = obj => {
      if (Array.isArray(obj)) return obj.map(cleanObj);
      if (obj && typeof obj === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v !== undefined && v !== null) result[k] = cleanObj(v);
        }
        return result;
      }
      return obj;
    };
    const payload = cleanObj(ecfDoc);

    // 7. Enviar a MSeller
    const base = env === 'production'
      ? 'https://ecf.api.mseller.app/eCF'
      : 'https://ecf.api.mseller.app/TesteCF';

    const mRes = await fetch(`${base}/documentos-ecf`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'X-API-KEY':      apiKey,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify(payload),
    });

    const mData = await mRes.json();

    if (!mRes.ok) {
      console.error('[eCF] MSeller error:', JSON.stringify(mData));
      return { ok: false, error: mData?.message || `Error MSeller: ${mRes.status}`, detail: mData };
    }

    // 8. Guardar resultado en DB
    const eNCF     = mData.eCF || mData.ecf || mData.ncf || '';
    const qrCode   = mData.qr_link || mData.qrLink || mData.codigoSeguridad || '';
    const pdfUrl   = mData.pdf_cloud_url || mData.pdfUrl || '';
    const xmlFirm  = mData.xml || '';
    const estado   = mData.estado || 'Procesando';

    db.prepare(`
      UPDATE sales SET
        ncf        = ?,
        ecf_status = ?,
        ecf_qr     = ?,
        ecf_pdf    = ?,
        ecf_sent_at = datetime('now')
      WHERE id = ?
    `).run(eNCF || sale.ncf, estado, qrCode, pdfUrl, saleId);

    // Log en tabla de eCF
    db.prepare(`
      INSERT OR IGNORE INTO ecf_log(sale_id, encf, tipo, estado, qr_code, pdf_url, xml_firmado, emitido_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(saleId, eNCF, tipoECF, estado, qrCode, pdfUrl, xmlFirm.slice(0, 5000));

    return {
      ok:      true,
      eNCF,
      estado,
      qrCode,
      pdfUrl,
      message: `e-CF emitido: ${eNCF} — ${estado}`,
    };

  } catch(e) {
    console.error('[eCF] Error:', e.message);
    return { ok: false, error: e.message };
  }
});

// ── Consultar estado de un e-CF ───────────────────────────────────────────────
ipcMain.handle('ecf:getStatus', async (_, { encf }) => {
  try {
    const getSet = k => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value || '';
    const apiKey = getSet('ecf_api_key');
    const email  = getSet('ecf_email');
    const pass   = getSet('ecf_password');
    const env    = getSet('ecf_environment') || 'test';
    const base   = env === 'production'
      ? 'https://ecf.api.mseller.app/eCF'
      : 'https://ecf.api.mseller.app/TesteCF';
    const token  = await _msellerAuth(email, pass);
    const res    = await fetch(`${base}/documentos-ecf?ecf=${encf}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-API-KEY': apiKey },
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Guardar configuración eCF ─────────────────────────────────────────────────
ipcMain.handle('ecf:saveConfig', async (_, { email, password, apiKey, environment }) => {
  try {
    const sets = [
      ['ecf_email',       email       || ''],
      ['ecf_password',    password    || ''],
      ['ecf_api_key',     apiKey      || ''],
      ['ecf_environment', environment || 'test'],
    ];
    const stmt = db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)");
    sets.forEach(([k, v]) => stmt.run(k, v));
    _msellerToken = null; // Reset token cache
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Obtener configuración eCF ─────────────────────────────────────────────────
ipcMain.handle('ecf:getConfig', async () => {
  try {
    const getSet = k => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value || '';
    return {
      ok: true,
      data: {
        email:       getSet('ecf_email'),
        hasPassword: !!getSet('ecf_password'),
        apiKey:      getSet('ecf_api_key'),
        environment: getSet('ecf_environment') || 'test',
      }
    };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Historial de e-CF emitidos ────────────────────────────────────────────────
ipcMain.handle('ecf:getLog', async (_, { limit = 50, offset = 0 } = {}) => {
  try {
    const rows = db.prepare(`
      SELECT el.*, s.total, c.name as cust_name
      FROM ecf_log el
      LEFT JOIN sales s ON el.sale_id = s.id
      LEFT JOIN customers c ON s.customer_id = c.id
      ORDER BY el.emitido_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    return { ok: true, data: rows };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});


// ── Multi-terminal (opt-in) — puente mode-aware + servidor RPC ───────────────
// Por defecto connection_mode='local' → NO arranca ningún servidor ni cambia
// nada. Solo se activa si un superadmin configura modo servidor/cliente.
// El puente aún no tiene handlers migrados; esta es la infraestructura de red.
// Ver docs/multi-terminal-sync.md
let _rpcServer = null;
function setupMultiTerminal() {
  const bridge = require('./src/main/ipc-bridge');
  const conn   = require('./src/main/connection');
  const getMode = () => settingsRepo.get('connection_mode') || 'local';

  bridge.configureBridge({
    mode: getMode,
    client: () => ({
      host:       settingsRepo.get('connection_server_ip')   || '127.0.0.1',
      port:       Number(settingsRepo.get('connection_server_port')) || 8443,
      accessKey:  settingsRepo.get('connection_access_key')  || '',
      terminalId: settingsRepo.get('terminal_id')            || '',
    }),
  });

  const mode = getMode();
  if (mode === 'server') {
    const { startRpcServer } = require('./src/main/net-server');
    // Canales que el servidor NUNCA sirve a clientes remotos (propios de la máquina).
    // OJO: settings:* NO va aquí (el cliente reenvía claves de negocio); print:onServer
    // tampoco (es la opción explícita de imprimir en el servidor).
    const SERVER_DENY = new Set([
      'app:getTerminalInfo',
      'connection:getInfo', 'connection:generateKey', 'connection:test', 'connection:setAllowedTerminal',
      'license:getStatus', 'license:activate', 'license:getMachineId', 'license:revoke', 'license:generate',
      'update:check', 'update:download', 'update:install',
      'print:html', 'print:toPDF', 'print:getPrinters', 'print:savePrinter', 'print:saveConfig', 'print:getJobs',
    ]);
    _rpcServer = startRpcServer({
      port: Number(settingsRepo.get('connection_server_port')) || 8443,
      host: '0.0.0.0',
      getAccessKey: () => settingsRepo.get('connection_access_key') || '',
      getAllowlist: () => conn.parseAllowlist(settingsRepo.get('connection_allowlist')),
      dispatch: bridge.dispatch,
      denyChannel: (ch) => SERVER_DENY.has(ch),
      onLog: (lvl, msg, extra) => { try { (lvl === 'error' ? logError : lvl === 'warn' ? logWarn : logInfo)('rpc', msg, extra); } catch {} },
    });
    logInfo('multiterminal', 'Servidor RPC iniciado', { port: _rpcServer.port, canales: bridge.channelCount() });
  } else {
    logInfo('multiterminal', 'Modo de conexión', { mode });
  }
}

app.whenReady().then(() => {
  // Cargar API key de Claude (necesita userData, disponible solo aquí)
  _loadApiKey();

  // Logger persistente + manejadores globales de error (Fase 2)
  initLogger(DATA_DIR);
  logInfo('app', `Velo POS iniciando — v${APP_VERSION}`);
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err?.message || String(err), { stack: err?.stack });
    console.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason?.message || String(reason), { stack: reason?.stack });
    console.error('[unhandledRejection]', reason);
  });

  try {
    db = initDB(DATA_DIR);
    initVersioning(db, DATA_DIR);
    // Multi-terminal: configura el puente y (solo en modo servidor) arranca el RPC.
    // Aislado en try propio para que jamás impida el arranque del POS.
    try { setupMultiTerminal(); }
    catch (e) { logError('multiterminal', 'Setup falló: ' + e.message); }
  } catch (e) {
    logError('DB', 'Error al inicializar: ' + e.message);
    console.error('[DB] Error al inicializar:', e);
    dialog.showErrorBox('Error de base de datos', e.message);
    app.quit();
    return;
  }
  createWindow();
  // Verificar actualizaciones 8 segundos después del arranque,
  // cuando la ventana ya está completamente cargada y visible.
  setTimeout(() => setupAutoUpdater(), 8000);

  // ── Backup automático asíncrono (Fase 1) ──────────────────────
  // Corre en background con db.backup() (no bloquea ventas). Uno al arrancar
  // (tras 30s para no competir con la carga inicial) y luego cada 6 horas.
  // Cualquier fallo se registra pero nunca interrumpe la operación del POS.
  const runAutoBackup = async () => {
    try {
      const dbInst = require('./database').getDB();
      if (!dbInst) return;
      const p = await createAutoBackup(DATA_DIR, dbInst, 10);
      console.log('[Backup] Automático creado:', p);
    } catch (e) {
      console.error('[Backup] Automático falló:', e.message);
    }
  };
  setTimeout(runAutoBackup, 30000);
  setInterval(runAutoBackup, 6 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Cierre limpio
app.on('before-quit', () => {
  if (_rpcServer) { try { _rpcServer.close(); } catch {} _rpcServer = null; }
  const dbInst = require('./database').getDB();
  if (dbInst) dbInst.close();
});
// ── Superadmin — recuperar contraseña de esta máquina ──
ipcMain.handle('auth:getSuperPass', async (_, { requestUserId } = {}) => {
  // Solo accesible para usuarios con rol superadmin.
  // Retorna información de la máquina para soporte técnico.
  // La contraseña maestra es fija y la conoce solo el vendedor.
  try {
    if (requestUserId) {
      const reqUser = authRepo.findById(requestUserId);
      if (!reqUser || reqUser.role !== 'superadmin') {
        return { ok: false, error: 'Sin permisos' };
      }
    }
    const os       = require('os');
    const cpuModel = os.cpus()[0]?.model || 'cpu';
    const hostname = os.hostname();
    return { ok: true, hostname, cpu: cpuModel };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Importar — análisis con Claude AI ────────
ipcMain.handle('importar:analyzeWithAI', async (_, { headers, rows, tipo, campos }) => {
  try {
    // Usar los campos enviados desde el cliente o calcularlos
    const camposStr = campos || (tipo === 'productos'
      ? 'name (Nombre, requerido), code (Código), barcode (Código barras), price (Precio venta, requerido), cost (Costo), wholesale (Precio mayor), stock (Stock), stock_min (Stock mínimo), category (Categoría), brand (Marca), unit (Unidad), description (Descripción)'
      : tipo === 'clientes'
      ? 'name (Nombre, requerido), phone (Teléfono), email (Email), rnc (RNC/Cédula), address (Dirección), credit_limit (Límite crédito), balance (Deuda actual), credit_days (Días crédito), credit_due (Fecha vencimiento), status (Estado)'
      : tipo === 'ventas'
      ? 'date (Fecha, requerido), customer_name (Cliente), total (Total, requerido), payment_method (Método pago), product_name (Producto), qty (Cantidad), unit_price (Precio unitario), subtotal (Subtotal), tax_amt (ITBIS), discount_pct (Descuento %), ncf (NCF), cajero (Cajero), type (Tipo doc)'
      : tipo === 'cuentas_cobrar'
      ? 'customer_name (Cliente, requerido), balance (Deuda, requerido), credit_limit (Límite crédito), credit_due (Fecha vencimiento), credit_days (Días crédito), status (Estado), phone (Teléfono), rnc (RNC)'
      : tipo === 'proveedores'
      ? 'name (Nombre, requerido), contact (Contacto), phone (Teléfono), email (Email), rnc (RNC), address (Dirección), notes (Notas)'
      : tipo === 'compras'
      ? 'supplier_name (Proveedor, requerido), product_name (Producto, requerido), unit_cost (Costo unitario, requerido), qty (Cantidad, requerido), date (Fecha), notes (Notas)'
      : tipo === 'gastos'
      ? 'description (Descripción, requerido), total (Monto, requerido), date (Fecha), category (Categoría), payment_method (Método pago), supplier_name (Proveedor), notes (Notas), status (Estado)'
      : 'name (Nombre, requerido)');

    const muestra = rows.slice(0, 5);
    const prompt = `Eres un experto en migración de datos para sistemas POS en República Dominicana.
Analiza este archivo y mapea sus columnas a los campos de Velo POS.

Columnas encontradas: ${headers.join(', ')}

Muestra de datos (primeras ${muestra.length} filas):
${JSON.stringify(muestra, null, 2)}

Tipo de importación: ${tipo}
Campos disponibles en Velo POS: ${camposStr}

REGLAS IMPORTANTES:
1. Sé flexible: busca la columna que MÁS se parezca a cada campo aunque el nombre sea diferente.
2. Para "name/nombre": busca articulo, producto, descripcion, item, nombre, name, NOMBRE, ARTICULO, cliente, razon_social.
3. Para "price/precio": busca precio_venta, precio, price, PVP, valor, importe, monto.
4. Para "code/codigo": busca codigo, code, id, sku, referencia, barcode.
5. Para "stock": busca cantidad, existencia, stock, qty, inventario.
6. Para "date/fecha": busca fecha, date, created_at, fecha_venta, fecha_compra — detecta formatos dd/mm/yyyy, yyyy-mm-dd, mm/dd/yyyy.
7. Para "total/monto": busca total, monto, importe, valor, amount.
8. Para "phone/telefono": busca telefono, tel, phone, celular, movil.
9. Si hay columnas con nombres extraños (__EMPTY_1, COL_1, etc.), analiza los DATOS para inferir contenido.
10. SIEMPRE mapea los campos requeridos aunque la confianza sea baja.
11. Para números con formato especial (RD$1,500.00, 1.500,00), mapéalos igual — el sistema los limpiará.

Responde SOLO con JSON sin comentarios ni markdown:
{
  "mapping": {
    "campo_velo": "ColumnaExactaDelArchivo"
  },
  "confidence": 0.85,
  "notas": "Descripción de lo detectado y ajustes que puede necesitar el usuario"
}

Usa null solo si definitivamente no existe esa información. Prefiere mapear con baja confianza a no mapear.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { ok: false, error: `Claude API error ${response.status}: ${err.slice(0,200)}` };
    }

    const data   = await response.json();
    const texto  = data.content?.[0]?.text || '';
    const clean  = texto.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


// ── WhatsApp — abrir en navegador del sistema ──
ipcMain.handle('shell:openExternal', async (_, { url }) => {
  try {
    // SEGURIDAD: solo URLs https:// a dominios conocidos.
    // No usar startsWith: valida protocolo y hostname real para evitar bypass.
    if (!isAllowedExternalUrl(url)) return { ok: false, error: 'URL no permitida' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — CUENTAS FINANCIERAS (BANCOS)
// ══════════════════════════════════════════════
// Gobierno contable (Fase 2): las mutaciones de contabilidad/bancos solo las hacen
// admin/superadmin. El módulo ya está oculto para cajeros en la UI; esto es defensa
// en profundidad en el backend. NOTA: los asientos AUTOMÁTICOS (venta/abono/gasto)
// pasan por accountingRepo.* directamente (hooks), no por estos handlers, así que
// no se ven afectados por esta guarda.
function _requireAccountingRole(requestUserId) {
  const u = requestUserId ? authRepo.findById(requestUserId) : null;
  return (u && u.active && ['admin', 'superadmin'].includes(u.role)) ? u : null;
}
const _NO_ACCT_ROLE = { ok: false, error: 'Solo administradores pueden modificar contabilidad y bancos' };

ipcMain.handle('financial:getAll', async () => {
  try {
    return { ok: true, data: financialAccountsRepo.getAll().map(_normalizeFinAcct) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:getById', async (_, { id }) => {
  try {
    return { ok: true, data: _normalizeFinAcct(financialAccountsRepo.getById(id)) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:create', async (_, { data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    const id = financialAccountsRepo.create({ ...data, userId: requestUserId });
    audit.log(requestUserId, 'financial_account_create', `Cuenta creada: ${data.name}`);
    return { ok: true, data: { id } };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:update', async (_, { id, data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    financialAccountsRepo.update(id, data);
    audit.log(requestUserId, 'financial_account_update', `Cuenta actualizada: ${id}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:toggleActive', async (_, { id, active, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    financialAccountsRepo.toggleActive(id, active);
    audit.log(requestUserId, 'financial_account_toggle', `Cuenta ${active ? 'activada' : 'desactivada'}: ${id}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:getMovements', async (_, { accountId, from, to, limit }) => {
  try {
    const rows = financialAccountsRepo.getMovements(accountId, { from, to, limit });
    return { ok: true, data: rows.map(_normalizeFinMov) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:addMovement', async (_, { data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    // Map UI-friendly type names to DB enum values
    const typeMap = { ingreso: 'deposito', egreso: 'retiro' };
    const mov = financialAccountsRepo.addMovement({
      accountId:        data.account_id,
      type:             typeMap[data.type] || data.type,
      amount:           data.type === 'egreso' ? -Math.abs(data.amount) : Math.abs(data.amount),
      description:      data.description,
      referenceType:    data.reference_type || '',
      referenceId:      data.reference_id   || null,
      relatedAccountId: data.related_account_id || null,
      method:           data.method || 'efectivo',
      notes:            data.notes  || '',
      userId:           requestUserId,
    });
    audit.log(requestUserId, 'financial_movement', `Movimiento: ${data.type} ${data.amount} en cuenta ${data.account_id}`);
    return { ok: true, data: mov };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:transfer', async (_, { data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    const result = financialAccountsRepo.transfer({
      fromId:      data.from_account_id,
      toId:        data.to_account_id,
      amount:      data.amount,
      description: data.description,
      notes:       data.reference || data.notes || '',
      userId:      requestUserId,
    });
    audit.log(requestUserId, 'financial_transfer', `Transferencia ${data.amount} de cuenta ${data.from_account_id} a ${data.to_account_id}`);
    return { ok: true, data: result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:cancelMovement', async (_, { id, reason, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    financialAccountsRepo.cancelMovement(id, requestUserId, reason);
    audit.log(requestUserId, 'financial_movement_cancel', `Movimiento anulado: ${id}. Razón: ${reason}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:getSummary', async () => {
  try {
    const s   = financialAccountsRepo.getSummary();
    const db  = require('./database').getDB();
    const now = new Date();
    const mo  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const incomeMonth  = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM financial_movements WHERE type IN ('deposito','transferencia_in','venta','abono_recibido') AND strftime('%Y-%m',created_at)=? AND status='activo'`).get(mo)?.v || 0;
    const expenseMonth = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM financial_movements WHERE type IN ('retiro','transferencia_out','gasto','pago_proveedor') AND strftime('%Y-%m',created_at)=? AND status='activo'`).get(mo)?.v || 0;
    return { ok: true, data: {
      total_active:         s.total  || 0,
      total_caja:           s.byCaja || 0,
      total_banco:          s.byBank || 0,
      total_income_month:   incomeMonth,
      total_expenses_month: expenseMonth,
    }};
  } catch (e) { return { ok: false, error: e.message }; }
});

// ══════════════════════════════════════════════
// IPC — CONCILIACIÓN BANCARIA (Fase 5)
// ══════════════════════════════════════════════
// Lecturas abiertas al módulo; mutaciones exigen admin (defensa en profundidad).
ipcMain.handle('bank:getReconciliation', async (_, { accountId } = {}) => {
  try { return { ok: true, data: bankReconRepo.getReconciliation(accountId) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bank:importStatement', async (_, { accountId, lines, batch, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    const r = bankReconRepo.importStatement({ accountId, lines, batch });
    audit(requestUserId, '', 'bank_statement_import', 'financial_accounts', accountId, `${r.inserted} líneas (${r.skipped} omitidas)`);
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bank:autoMatch', async (_, { accountId, windowDays, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return { ok: true, ...bankReconRepo.autoMatch({ accountId, windowDays }) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bank:manualMatch', async (_, { lineId, movementId, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return bankReconRepo.manualMatch(lineId, movementId);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bank:unmatch', async (_, { lineId, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return bankReconRepo.unmatch(lineId);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bank:ignoreLine', async (_, { lineId, ignore, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return bankReconRepo.ignoreLine(lineId, ignore !== false);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bank:clearBatch', async (_, { accountId, batch, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return { ok: true, ...bankReconRepo.clearBatch(accountId, batch) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ══════════════════════════════════════════════
// IPC — CONTABILIDAD
// ══════════════════════════════════════════════

ipcMain.handle('accounting:getAccounts', async () => {
  try {
    return { ok: true, data: accountingRepo.getAccounts() };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getAccountByCode', async (_, { code }) => {
  try {
    return { ok: true, data: accountingRepo.getAccountByCode(code) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:createAccount', async (_, { data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    const account = accountingRepo.createAccount(data);
    audit.log(requestUserId, 'accounting_account_create', `Cuenta contable creada: ${data.code} - ${data.name}`);
    return { ok: true, data: account };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:updateAccount', async (_, { id, data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    accountingRepo.updateAccount(id, data);
    audit.log(requestUserId, 'accounting_account_update', `Cuenta contable actualizada: ${id}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:deleteAccount', async (_, { id, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    accountingRepo.deleteAccount(id);
    audit.log(requestUserId, 'accounting_account_delete', `Cuenta contable eliminada: ${id}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getConfig', async () => {
  try {
    return { ok: true, data: accountingRepo.getConfig() };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:setConfig', async (_, { key, value, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    accountingRepo.setConfig(key, value);
    audit.log(requestUserId, 'accounting_config_set', `Config contable: ${key}=${value}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:createEntry', async (_, { data, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    // Translate UI field names → repo field names
    const repoData = {
      date:          data.date,
      concept:       data.description || data.concept,
      reference:     data.reference   || '',
      source_module: data.type        || data.source_module || 'manual',
      source_id:     data.source_id   || null,
      lines:         data.lines,
      notes:         data.notes       || '',
      userId:        data.created_by  || requestUserId,
      status:        data.status      || 'confirmado',
    };
    const entry = accountingRepo.createEntry(repoData);
    audit.log(requestUserId, 'accounting_entry_create', `Asiento creado: ${entry.number}`);
    return { ok: true, data: entry };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getEntries', async (_, { from, to, type, source_module, status, limit } = {}) => {
  try {
    return { ok: true, data: accountingRepo.getEntries({ from, to, source_module: source_module || type, status, limit }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getEntryById', async (_, { id }) => {
  try {
    return { ok: true, data: accountingRepo.getEntryById(id) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:reverseEntry', async (_, { id, reason, requestUserId }) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    const reversed = accountingRepo.reverseEntry(id, requestUserId, reason);
    audit.log(requestUserId, 'accounting_entry_reverse', `Asiento anulado: ${id}. Razón: ${reason}`);
    return { ok: true, data: reversed };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getLedger', async (_, { accountId, from, to } = {}) => {
  try {
    const rows = accountingRepo.getLedger({ accountId, from, to });
    // Build enriched ledger with running balance
    let running = 0;
    const lines = rows.map(r => {
      running += (r.debit || 0) - (r.credit || 0);
      return {
        date:            r.date,
        entry_number:    r.number,
        description:     r.concept || r.description || '',
        debit:           r.debit   || 0,
        credit:          r.credit  || 0,
        running_balance: running,
      };
    });
    const totalDebit  = rows.reduce((s, r) => s + (r.debit  || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
    const first       = rows[0];
    return { ok: true, data: {
      account:         { id: accountId, code: first?.code, name: first?.account_name },
      lines,
      total_debit:     totalDebit,
      total_credit:    totalCredit,
      closing_balance: running,
    }};
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getTrialBalance', async (_, { asOf, from, to } = {}) => {
  try {
    const rows = accountingRepo.getTrialBalance({ from, to: asOf || to });
    const data = rows.map(r => ({
      code:   r.code,
      name:   r.name,
      type:   r.type,
      debit:  r.net_debit  || 0,
      credit: r.net_credit || 0,
    }));
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getIncomeStatement', async (_, { from, to } = {}) => {
  try {
    const rpt = accountingRepo.getIncomeStatement({ from, to });
    return { ok: true, data: {
      revenue_items:   (rpt.revenues || []).map(r => ({ name: r.name, amount: r.net })),
      cogs_items:      (rpt.costs    || []).map(r => ({ name: r.name, amount: r.net })),
      expense_items:   (rpt.expenses || []).map(r => ({ name: r.name, amount: r.net })),
      total_revenue:   rpt.totalRev   || 0,
      total_cogs:      rpt.totalCost  || 0,
      total_expenses:  rpt.totalExp   || 0,
      gross_profit:    rpt.grossProfit|| 0,
      net_income:      rpt.netIncome  || 0,
    }};
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getBalanceSheet', async (_, { asOf, to } = {}) => {
  try {
    const rpt = accountingRepo.getBalanceSheet({ to: asOf || to });
    return { ok: true, data: {
      asset_items:       (rpt.assets      || []).map(r => ({ code: r.code, name: r.name, balance: r.net })),
      liability_items:   (rpt.liabilities || []).map(r => ({ code: r.code, name: r.name, balance: r.net })),
      equity_items:      (rpt.equity      || []).map(r => ({ code: r.code, name: r.name, balance: r.net })),
      total_assets:      rpt.totalAssets || 0,
      total_liabilities: rpt.totalLiab   || 0,
      total_equity:      rpt.totalEquity || 0,
    }};
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:getDashboardStats', async () => {
  try {
    return { ok: true, data: accountingRepo.getDashboardStats() };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Cuadres auxiliar ↔ mayor (CxC/Inventario/CxP): alerta de descuadre.
ipcMain.handle('accounting:getReconciliation', async () => {
  try {
    return { ok: true, data: accountingRepo.getReconciliation() };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Reporte 606 (compras/gastos con NCF — formato DGII preliminar).
ipcMain.handle('accounting:get606', async (_, { from, to } = {}) => {
  try {
    return { ok: true, data: accountingRepo.get606({ from, to }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Estado de flujo de efectivo (método directo).
ipcMain.handle('accounting:getCashFlow', async (_, { from, to } = {}) => {
  try {
    return { ok: true, data: accountingRepo.getCashFlow({ from, to }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Activos fijos + depreciación ──────────────
ipcMain.handle('assets:getAll', async (_, { status } = {}) => {
  try { return { ok: true, data: fixedAssetsRepo.getAll({ status }) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('assets:getById', async (_, { id } = {}) => {
  try { return { ok: true, data: fixedAssetsRepo.getById(id) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('assets:getSummary', async () => {
  try { return { ok: true, data: fixedAssetsRepo.summary() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('assets:create', async (_, { data, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    if (!data?.name?.trim()) return { ok: false, error: 'El nombre es obligatorio' };
    if (!(data.cost > 0)) return { ok: false, error: 'El costo debe ser mayor a cero' };
    const r = fixedAssetsRepo.create(data);
    audit(requestUserId, '', 'activo_creado', 'fixed_assets', r.id, data.name);
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('assets:update', async (_, { id, data, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return fixedAssetsRepo.update(id, data || {});
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('assets:dispose', async (_, { id, reason, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    if (!reason?.trim()) return { ok: false, error: 'El motivo de la baja es obligatorio' };
    return fixedAssetsRepo.dispose({ id, reason, userId: requestUserId });
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('assets:runDepreciation', async (_, { period, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return { ok: true, ...fixedAssetsRepo.runDepreciation({ period, userId: requestUserId }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:syncHistorical', async (_, { requestUserId } = {}) => {
  try {
    // Obtener ventas no vinculadas a asientos contables y generar asientos retroactivos
    const db = require('./database').getDB();
    const sales = db.prepare(`
      SELECT s.* FROM sales s
      WHERE s.status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM accounting_entries ae WHERE ae.source_module = 'venta' AND ae.source_id = s.id
      )
      ORDER BY s.created_at ASC
      LIMIT 500
    `).all();

    let created = 0, failed = 0;
    for (const sale of sales) {
      try {
        // BUGFIX: antes se pasaba sale.id (número) a un método que espera { saleId }
        // → saleId=undefined → el sync NUNCA generaba asientos (no-op silencioso).
        if (accountingRepo.generateSaleEntry({ saleId: sale.id, userId: requestUserId })) created++;
      } catch (e) { failed++; console.error(`[accounting:syncHistorical] venta ${sale.id}: ${e.message}`); }
    }

    // Gastos (criterio devengado): reconoce gasto + CxP (devengo) y salda con
    // cada pago. El devengo omite gastos con asiento legacy 'gasto' (no duplica).
    const expenses = db.prepare(`
      SELECT id FROM expenses
      WHERE type IN ('gasto','activo','reembolso')
        AND status NOT IN ('borrador','rechazado','anulado')
      ORDER BY created_at ASC LIMIT 1000
    `).all();
    for (const exp of expenses) {
      try {
        if (accountingRepo.generateExpenseAccrualEntry({ expenseId: exp.id, userId: requestUserId })) created++;
      } catch (e) { failed++; console.error(`[accounting:syncHistorical] gasto devengo ${exp.id}: ${e.message}`); }
    }
    const expPayments = db.prepare(`
      SELECT id FROM expense_payments WHERE status='pagado' AND amount>0
      ORDER BY created_at ASC LIMIT 1000
    `).all();
    for (const p of expPayments) {
      try {
        if (accountingRepo.generateExpensePaymentEntry({ paymentId: p.id, userId: requestUserId })) created++;
      } catch (e) { failed++; console.error(`[accounting:syncHistorical] gasto pago ${p.id}: ${e.message}`); }
    }

    // Compras recibidas (devengado): Déb Inventario (+ITBIS Acreditable) · Créd
    // CxP. Backfill del valor ya recibido, un asiento por OC.
    const pos = db.prepare(`
      SELECT id, subtotal, tax_amt FROM purchase_orders po
      WHERE status IN ('recibido','parcial')
        AND NOT EXISTS (SELECT 1 FROM accounting_entries ae WHERE ae.source_module='compra' AND ae.source_id=po.id)
      ORDER BY created_at ASC LIMIT 1000
    `).all();
    for (const po of pos) {
      try {
        const items = db.prepare('SELECT qty_received, unit_cost FROM purchase_items WHERE purchase_order_id=?').all(po.id);
        const val = items.reduce((s, it) => s + ((it.qty_received || 0) * (it.unit_cost || 0)), 0);
        const tax = (po.tax_amt > 0 && po.subtotal > 0) ? (val / po.subtotal) * po.tax_amt : 0;
        if (accountingRepo.generatePurchaseEntry({ poId: po.id, deltaValue: val, deltaTax: tax, receiveSeq: 1, userId: requestUserId })) created++;
      } catch (e) { failed++; console.error(`[accounting:syncHistorical] compra ${po.id}: ${e.message}`); }
    }

    // Abonos (pagos de clientes) no vinculados → Débito Caja/Banco · Crédito CxC.
    // generatePaymentEntry ignora monto 0 y el marcador "Saldo inicial importado".
    const payments = db.prepare(`
      SELECT p.id FROM payments p
      WHERE p.amount > 0 AND (p.note IS NULL OR p.note != 'Saldo inicial importado')
      AND NOT EXISTS (SELECT 1 FROM accounting_entries ae WHERE ae.source_module='abono' AND ae.source_id=p.id)
      ORDER BY p.created_at ASC LIMIT 500
    `).all();
    for (const pay of payments) {
      try {
        if (accountingRepo.generatePaymentEntry({ paymentId: pay.id, userId: requestUserId })) created++;
      } catch (e) { failed++; console.error(`[accounting:syncHistorical] abono ${pay.id}: ${e.message}`); }
    }

    // Reconciliar anulaciones: reversar asientos cuyo origen (venta/gasto) fue
    // anulado DESPUÉS de sincronizarse. Sin esto, los estados financieros
    // sobreestiman ingresos/gastos de operaciones ya anuladas.
    let reversed = 0;
    const staleEntries = db.prepare(`
      SELECT ae.id FROM accounting_entries ae
      WHERE ae.status='confirmado' AND ae.source_module IN ('venta','gasto','gasto_dev','gasto_pago') AND ae.source_id IS NOT NULL
        AND (
          (ae.source_module='venta' AND EXISTS(SELECT 1 FROM sales s    WHERE s.id=ae.source_id AND s.status='cancelled'))
          OR
          (ae.source_module IN ('gasto','gasto_dev','gasto_pago') AND EXISTS(SELECT 1 FROM expenses e WHERE e.id=ae.source_id AND e.status='anulado'))
        )
    `).all();
    for (const ae of staleEntries) {
      try { accountingRepo.reverseEntry(ae.id, requestUserId || 0, 'Origen anulado (reconciliación de sincronización)'); reversed++; }
      catch (e) { failed++; console.error(`[accounting:syncHistorical] reversar asiento ${ae.id}: ${e.message}`); }
    }

    audit.log(requestUserId || 0, 'accounting_sync_historical', `Sincronización: ${created} generados, ${reversed} reversados, ${failed} fallidos`);
    return { ok: true, data: { created, reversed, failed } };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Períodos contables (cierre/bloqueo) ──────────────────────────────────────
ipcMain.handle('accounting:getPeriods', async (_, { requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    return { ok: true, data: accountingRepo.getPeriods() };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:closePeriod', async (_, { name, dateFrom, dateTo, notes, requestUserId } = {}) => {
  try {
    if (!_requireAccountingRole(requestUserId)) return _NO_ACCT_ROLE;
    if (!dateFrom || !dateTo) return { ok: false, error: 'Rango de fechas requerido' };
    const r = accountingRepo.closePeriod({ name: name || `${dateFrom} a ${dateTo}`, dateFrom, dateTo, notes, userId: requestUserId });
    audit.log(requestUserId, 'accounting_period_close', `Período cerrado: ${dateFrom}..${dateTo}`);
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:reopenPeriod', async (_, { id, reason, requestUserId } = {}) => {
  try {
    // Reabrir es sensible → solo superadmin + motivo.
    const u = requestUserId ? authRepo.findById(requestUserId) : null;
    if (!u || u.role !== 'superadmin') return { ok: false, error: 'Solo el superadmin puede reabrir un período' };
    if (!reason?.trim()) return { ok: false, error: 'El motivo es obligatorio' };
    const r = accountingRepo.reopenPeriod(id, requestUserId, reason);
    audit.log(requestUserId, 'accounting_period_reopen', `Período reabierto: ${id}. Razón: ${reason}`);
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
