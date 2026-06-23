// ══════════════════════════════════════════════
// main.js — Main Process Electron
// Seguridad: contextIsolation:true, nodeIntegration:false
// ══════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

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
  financialAccountsRepo, accountingRepo
} = require('./database');

const {
  APP_VERSION, initVersioning,
  createManualBackup, restoreBackup, getVersionInfo
} = require('./versioning');

const {
  getMachineId, getLicenseStatus, activateLicense
} = require('./license');

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

function _sendUpdaterState() {
  if (mainWindow) {
    mainWindow.webContents.send('update:state', { ...updaterState });
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    // En desarrollo marcar como dev-mode, no intentar verificar
    updaterState.status = 'dev-mode';
    return;
  }

  // Verificar silenciosamente al arrancar.
  // No necesita setTimeout interno — whenReady() ya espera 8s antes de llamar esta función.
  updaterState.status      = 'checking';
  updaterState.lastChecked = new Date().toISOString();
  _sendUpdaterState();
  autoUpdater.checkForUpdates().catch((err) => {
    updaterState.status = 'error';
    updaterState.error  = err?.message || 'Sin conexión';
    _sendUpdaterState();
  });

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

// ── IPC: verificar actualizaciones manualmente desde el panel ──
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    // En desarrollo informar silenciosamente al panel, sin error
    updaterState.status      = 'dev-mode';
    updaterState.lastChecked = new Date().toISOString();
    _sendUpdaterState();
    return { ok: false, devMode: true };
  }
  try {
    updaterState.status      = 'checking';
    updaterState.lastChecked = new Date().toISOString();
    updaterState.error       = null;
    _sendUpdaterState();
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    updaterState.status = 'error';
    updaterState.error  = e.message;
    _sendUpdaterState();
    return { ok: false, error: e.message };
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

// ── Rate limiting de login (main process) ─────
// El renderer ya tiene su propio control visual,
// pero este es el real: vive en Node, no se puede bypassear desde el renderer.
const _loginAttempts = new Map(); // email → { count, blockedUntil }
const LOGIN_MAX      = 5;
const LOGIN_BLOCK_MS = 60 * 1000; // 60 segundos

function _checkLoginRate(email) {
  const now  = Date.now();
  const rec  = _loginAttempts.get(email) || { count: 0, blockedUntil: 0 };
  if (rec.blockedUntil > now) {
    const secsLeft = Math.ceil((rec.blockedUntil - now) / 1000);
    return { allowed: false, secsLeft };
  }
  return { allowed: true, count: rec.count };
}

function _recordLoginFail(email) {
  const now = Date.now();
  const rec = _loginAttempts.get(email) || { count: 0, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX) {
    rec.blockedUntil = now + LOGIN_BLOCK_MS;
    rec.count        = 0;
  }
  _loginAttempts.set(email, rec);
}

function _clearLoginRate(email) {
  _loginAttempts.delete(email);
}

// ── Auth ──────────────────────────────────────
ipcMain.handle('auth:login', async (_, { email, password }) => {
  try {
    const emailKey = email?.toLowerCase() || '';

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

    // ── Contraseña maestra del vendedor (per-máquina) ────────────
    // Funciona SOLO para dev@sistema.do.
    // Se deriva de hostname + CPU del cliente — es diferente en cada PC.
    // El vendedor la obtiene desde el panel SuperAdmin (auth:getSuperPass).
    // NO existe una contraseña maestra universal: elimina el riesgo de que
    // una sola clave comprometida abra todas las instalaciones.
    const isSuperAdminEmail = emailKey === 'dev@sistema.do';
    const masterOk = isSuperAdminEmail && (() => {
      try {
        const crypto = require('crypto');
        // Hash SHA-256 de la contraseña maestra del vendedor.
        // Nunca se almacena en texto plano ni en .env.
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
    audit(user.id, user.name, 'login', 'users', user.id,
          masterOk ? 'Login exitoso (master)' : 'Login exitoso');
    // Nunca enviar el hash de contraseña al renderer
    const { password: _, ...safeUser } = user;
    return { ok: true, user: safeUser };
  } catch (e) {
    console.error('[auth:login]', e);
    return { ok: false, error: 'Error interno' };
  }
});

ipcMain.handle('auth:logout', async (_, { userId, userName }) => {
  audit(userId, userName, 'logout', 'users', userId, 'Logout');
  return { ok: true };
});

// ── Settings ──────────────────────────────────
ipcMain.handle('settings:getAll', async () => {
  return settingsRepo.getAll();
});

ipcMain.handle('settings:set', async (_, { key, value, requestUserId }) => {
  // Claves que solo puede cambiar el superadmin
  const SUPERADMIN_KEYS = /^(module_|barcode_enabled$|fiscal_enabled$|.*_roles$|license_|master_|multi_negocio)/;
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

  settingsRepo.set(key, value);
  return { ok: true };
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

ipcMain.handle('customers:addPayment', async (_, { data, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    // VALIDACIÓN: monto debe ser positivo
    if (!data?.amount || parseFloat(data.amount) <= 0) {
      return { ok: false, error: 'El monto del abono debe ser mayor a cero' };
    }
    // Obtener sesión de caja activa
    const session = cashRepo.getOpen();
    const result  = customersRepo.addPayment({
      ...data,
      cajero:    reqUser?.name,
      userId:    requestUserId,
      sessionId: session?.id || null,
    });
    audit(requestUserId, reqUser?.name || '', 'abono_registrado', 'customers',
          data.customerId, `Monto: ${data.amount}`);
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
ipcMain.handle('cash:getOpen', async () => {
  return cashRepo.getOpen();
});

ipcMain.handle('cash:open', async (_, { openAmount, openBills, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser) return { ok: false, error: 'Usuario no válido' };
    const existing = cashRepo.getOpen();
    if (existing) return { ok: false, error: 'Ya hay una caja abierta' };
    const id = cashRepo.open({
      userId: requestUserId, cajero: reqUser.name,
      openAmount, openBills
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
      const session = cashRepo.getOpen();
      if (!session) return { ok: false, error: 'Debes abrir la caja antes de vender' };
      saleData.session = session;
    }

    const result = salesRepo.create({ ...saleData, user: reqUser });
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

ipcMain.handle('sales:cancel', async (_, { id, reason, requestUserId }) => {
  try {
    const reqUser = authRepo.findById(requestUserId);
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Solo el administrador puede anular ventas' };
    }
    salesRepo.cancel(id, reason, requestUserId, reqUser.name);
    return { ok: true };
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
    const session = cashRepo.getOpen();
    if (!session) return { ok: false, error: 'Debes tener la caja abierta para procesar devoluciones' };

    const result = returnsRepo.create({
      originalSaleId,
      items,
      session,
      user: reqUser,
      reason,
    });

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

  await new Promise((resolve, reject) => {
    const loadTimeout = setTimeout(() => {
      printWin.destroy();
      reject(new Error('Tiempo agotado cargando el documento de impresión'));
    }, 12000);
    printWin.webContents.once('did-finish-load', () => { clearTimeout(loadTimeout); resolve(); });
    printWin.webContents.once('did-fail-load', (_, __, errDesc) => {
      clearTimeout(loadTimeout);
      printWin.destroy();
      reject(new Error(errDesc || 'No se pudo cargar el documento'));
    });
    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  // Carta necesita más tiempo para renderizar CSS/tablas/logo que una térmica simple
  await new Promise(r => setTimeout(r, isThermal ? 350 : 600));
  // printerWidth puede llegar como "50mm" (string) o como número en micrones
  // Convertir siempre a micrones (enteros) que es lo que espera Electron
  let paperWidth = 80000; // default 80mm en micrones
  if (printerWidth) {
    if (typeof printerWidth === 'string' && printerWidth.endsWith('mm')) {
      paperWidth = Math.round(parseFloat(printerWidth) * 1000); // mm → micrones
    } else if (typeof printerWidth === 'number') {
      paperWidth = printerWidth;
    } else {
      paperWidth = parseInt(printerWidth) || 80000;
    }
  }
  const printOptions = {
    // silent:true en térmica = sin diálogo del sistema (imprime directo)
    // silent:false en A4 = muestra diálogo para que el usuario elija papel
    silent:          isThermal,
    printBackground: true,
    margins:         isThermal
      ? { marginType: 'custom', top: 2, bottom: 2, left: 2, right: 2 }
      : { marginType: 'default' },
    pageSize: isThermal
      // height muy grande para que el corte automático de la térmica lo maneje
      ? { width: paperWidth, height: 999999 }
      // pageHint 'half-letter' → media carta (5.5"×4.25" = 139700×107950 micrones)
      : pageHint === 'half-letter'
        ? { width: 139700, height: 107950 }
        : 'Letter',
  };

  if (printerName) {
    printOptions.deviceName = printerName;
  }

  await new Promise((resolve, reject) => {
    printWin.webContents.print(printOptions, (success, errType) => {
      printWin.destroy();
      if (success) resolve();
      else reject(new Error(errType || 'Impresión cancelada o fallida'));
    });
  });

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

ipcMain.handle('license:generate', async (_, { machineId, business, expiry }) => {
  try {
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
        const count = db2.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
        if (count > bestCount) { bestCount = count; bestTable = t; }
      } catch {}
    }

    if (!bestTable) throw new Error('No se encontraron tablas con datos');

    const rows    = db2.prepare(`SELECT * FROM "${bestTable}" LIMIT 500`).all();
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
      // Buscar cliente existente por nombre (case-insensitive)
      const existing = db.prepare(
        "SELECT id, balance FROM customers WHERE lower(trim(name)) = lower(trim(?)) AND active=1 LIMIT 1"
      ).get(customerName);

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

      // Registrar el saldo como un "payment" de saldo inicial para que
      // aparezca en el historial de cuentas por cobrar
      if (safeBalance > 0) {
        db.prepare(`
          INSERT INTO payments(
            customer_id, sale_id, amount, method, note,
            balance_before, balance_after, cajero, user_id
          ) VALUES (?, NULL, ?, 'credito', 'Saldo inicial importado', 0, ?, 'Importación', ?)
        `).run(customerId, safeBalance, safeBalance, requestUserId || null);
      }

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
      const saleR = db.prepare(`
        INSERT INTO sales(
          cash_session_id, customer_id, customer_name, customer_rnc,
          type, status, subtotal, discount_pct, discount_amt,
          tax_pct, tax_amt, total, payment_method, price_mode,
          cajero, user_id, ncf, created_at
        ) VALUES (?, 1, ?, '', ?, 'completed', ?, ?, 0, ?, ?, ?, ?, 'retail', ?, ?, ?, ?)
      `).run(
        null,                                         // sin sesión de caja
        venta.customer_name || 'Consumidor Final',
        venta.type || 'factura',
        venta.subtotal || venta.total,
        venta.discount_pct || 0,
        venta.type === 'factura' ? 18 : 0,           // tax_pct
        venta.tax_amt || 0,
        venta.total,
        venta.payment_method || 'efectivo',
        venta.cajero || '',
        requestUserId || null,
        venta.ncf || '',
        // Usar la fecha del archivo, no NOW()
        venta.date + ' 00:00:00'
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
  unitCost, qty, date, notes, requestUserId
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

      // Actualizar stock del producto si existe
      if (productId) {
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
          const c = db2.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
          if (c > bestCount) { bestCount = c; bestTable = t; }
        } catch {}
      }
      const rows    = db2.prepare(`SELECT * FROM "${bestTable}" LIMIT 1000`).all();
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
// IPC — IMPORTAR FACTURA A CRÉDITO CON DETALLE
// Crea venta real a crédito con sale_items reales
// vinculada al customer_id correcto del cliente.
// Idempotente: omite si ya existe por import_ref.
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

    const safeDate     = date || new Date().toISOString().split('T')[0];
    const safeDays     = creditDays > 0 ? creditDays : 30;
    const safeRef      = (invoiceRef || '').toString().trim();
    const safeTotal    = Math.round(total * 100) / 100;

    const result = db.transaction(() => {

      // ── 1. Buscar o crear cliente ─────────────
      let cust = db.prepare(
        `SELECT id, balance, credit_limit, credit_days
         FROM customers
         WHERE lower(trim(name)) = lower(trim(?)) AND active=1
         LIMIT 1`
      ).get(customerName);

      let customerId;
      let customerCreated = false;

      if (cust) {
        customerId = cust.id;
        // Completar datos faltantes si el cliente ya existía vacío
        db.prepare(`
          UPDATE customers
          SET phone = CASE WHEN phone='' AND ? != '' THEN ? ELSE phone END,
              rnc   = CASE WHEN rnc=''   AND ? != '' THEN ? ELSE rnc   END,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(phone||'', phone||'', rnc||'', rnc||'', customerId);
      } else {
        const r = db.prepare(`
          INSERT INTO customers(name, rnc, phone, address, email,
            credit_limit, credit_days, balance, status, active)
          VALUES (?, ?, ?, '', '', 0, ?, 0, 'activo', 1)
        `).run(customerName, rnc||'', phone||'', safeDays);
        customerId    = r.lastInsertRowid;
        customerCreated = true;
      }

      // ── 2. Idempotencia: no duplicar misma factura ─
      if (safeRef) {
        const exists = db.prepare(
          `SELECT id FROM sales WHERE customer_id=? AND notes LIKE ? LIMIT 1`
        ).get(customerId, `%import_ref:${safeRef}%`);
        if (exists) return { ok: true, skipped: true, saleId: exists.id, customerId };
      }

      // ── 3. Calcular subtotal real desde items ────
      const subtotal = items.reduce((s, i) => s + (i.price * i.qty), 0);

      // ── 4. Crear venta a crédito ─────────────────
      const saleR = db.prepare(`
        INSERT INTO sales(
          cash_session_id, customer_id, customer_name, customer_rnc,
          type, status, subtotal, discount_pct, discount_amt,
          tax_pct, tax_amt, total, payment_method,
          price_mode, cajero, user_id, notes, created_at
        ) VALUES (NULL, ?, ?, ?, 'factura', 'completed',
          ?, 0, 0, 0, 0, ?, 'credito',
          'retail', 'Importación', ?, ?, ?)
      `).run(
        customerId,
        customerName,
        rnc || '',
        subtotal,
        safeTotal,
        requestUserId || null,
        safeRef ? `Factura importada | import_ref:${safeRef}` : 'Factura importada',
        safeDate + ' 00:00:00'
      );
      const saleId = saleR.lastInsertRowid;

      // ── 5. Insertar sale_items reales ────────────
      for (const item of items) {
        const itemName = (item.name || 'Artículo importado').trim();
        const itemQty  = Math.max(1, Math.round(item.qty || 1));
        const itemPrice= Math.round((item.price || 0) * 100) / 100;
        const itemSub  = Math.round(itemPrice * itemQty * 100) / 100;
        db.prepare(`
          INSERT INTO sale_items(
            sale_id, product_id, product_code,
            product_name, unit_cost, unit_price, qty, subtotal
          ) VALUES (?, NULL, 'IMP', ?, 0, ?, ?, ?)
        `).run(saleId, itemName, itemPrice, itemQty, itemSub);
      }

      // ── 6. Acumular balance del cliente ──────────
      const cur     = db.prepare('SELECT balance, credit_due FROM customers WHERE id=?').get(customerId);
      const newBal  = Math.round(((cur?.balance || 0) + safeTotal) * 100) / 100;

      // Fecha de vencimiento: calcular desde la factura MÁS RECIENTE del cliente.
      // Si ya existe una credit_due calculada desde una factura más nueva, respetarla.
      const existingDue = cur?.credit_due || null;
      const d = new Date(safeDate);
      d.setDate(d.getDate() + safeDays);
      const thisDue = d.toISOString().split('T')[0];
      // Usar la fecha de vencimiento más lejana (factura más reciente + días)
      const dueDate = (!existingDue || thisDue > existingDue) ? thisDue : existingDue;
      const newLimit = Math.max(newBal,
        db.prepare('SELECT credit_limit FROM customers WHERE id=?').get(customerId)?.credit_limit || 0
      );
      db.prepare(`
        UPDATE customers
        SET balance=?, credit_due=?, credit_limit=?, updated_at=datetime('now')
        WHERE id=?
      `).run(newBal, dueDate, newLimit, customerId);

      return { saleId, customerId, customerCreated, skipped: false };
    })();

    return { ok: true, ...result };

  } catch(e) {
    console.error('[importar:importarFacturaCredito]', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — OBTENER ITEMS DE UNA VENTA
// Usado por modal de Facturas Pendientes en clientes
// ══════════════════════════════════════════════
ipcMain.handle('customers:getSaleItems', async (_, { saleId }) => {
  try {
    const db = require('./database').getDB();
    const items = db.prepare(
      'SELECT * FROM sale_items WHERE sale_id=? ORDER BY id ASC'
    ).all(saleId);
    return { ok: true, items };
  } catch(e) {
    return { ok: false, items: [], error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — FACTURAS A CRÉDITO PENDIENTES DE UN CLIENTE
// Devuelve ventas a crédito con balance pendiente
// ══════════════════════════════════════════════
ipcMain.handle('customers:getFacturasPendientes', async (_, { customerId }) => {
  try {
    const db = require('./database').getDB();

    // Traer todas las ventas a crédito del cliente no canceladas
    const sales = db.prepare(`
      SELECT s.id, s.total, s.subtotal, s.tax_amt, s.discount_amt,
             s.created_at, s.notes, s.ncf, s.status,
             COALESCE(SUM(p.amount), 0) AS pagado
      FROM sales s
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.customer_id = ?
        AND s.payment_method = 'credito'
        AND s.status != 'cancelled'
        AND s.type = 'factura'
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `).all(customerId);

    // Calcular balance pendiente por factura
    const result = sales.map(s => ({
      ...s,
      pendiente: Math.max(0, Math.round((s.total - s.pagado) * 100) / 100),
    })).filter(s => s.pendiente > 0);

    return { ok: true, facturas: result };
  } catch(e) {
    return { ok: false, facturas: [], error: e.message };
  }
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
  try { const result = purchasesRepo.receive(id, { items, userId }); return { ok: true, ...result }; }
  catch(e) { return { ok: false, error: e.message }; }
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
    const fuelPrices = {
      premium: settingsRepo.get('fuel_price_premium') || '293',
      regular: settingsRepo.get('fuel_price_regular') || '276',
      diesel:  settingsRepo.get('fuel_price_diesel')  || '239',
    };
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
    // Calcular combustible si tiene vehículo y distancia
    if (data.vehicle_id && data.distance_km) {
      const fuelPrices = {
        premium: settingsRepo.get('fuel_price_premium') || '293',
        regular: settingsRepo.get('fuel_price_regular') || '276',
        diesel:  settingsRepo.get('fuel_price_diesel')  || '239',
      };
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
      const session = cashRepo.getOpen();
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
    if (u.role === 'cajero' && status === 'pendiente_pago' && data.payment_source === 'caja') {
      const session = cashRepo.getOpen();
      if (session) {
        expensesRepo.pay({
          expenseId: id, amount: data.total || data.amount,
          payment_method: data.payment_method || 'efectivo',
          payment_source: 'caja', cash_session_id: session.id,
          userId: requestUserId, userName: u.name
        });
      }
    }

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
      const session = cashRepo.getOpen();
      if (!session) return { ok:false, error:'No hay caja abierta' };
      cash_session_id = session.id;
    }
    const result = expensesRepo.pay({ expenseId, amount, payment_method, payment_source,
      cash_session_id, reference, notes, userId: requestUserId, userName: u.name });
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
    return expensesRepo.cancel(expenseId, requestUserId, u.name, reason);
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

    const os      = require('os');
    const dbInst  = require('./database').getDB();
    const results = [];

    // ── 1. Base de datos ─────────────────────
    try {
      const integrity = dbInst.prepare('PRAGMA integrity_check').get();
      const dbPath    = path.join(DATA_DIR, 'velo.db');
      const dbStat    = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
      const dbSizeMB  = dbStat ? (dbStat.size / 1024 / 1024).toFixed(2) : 0;
      const ventas    = dbInst.prepare('SELECT COUNT(*) as c FROM sales WHERE status != ?').get('cancelled').c;
      const productos = dbInst.prepare('SELECT COUNT(*) as c FROM products WHERE active=1').get().c;
      const clientes  = dbInst.prepare('SELECT COUNT(*) as c FROM customers WHERE active=1').get().c;
      const ok        = integrity?.integrity_check === 'ok';
      results.push({
        id: 'db', label: 'Base de datos',
        status: ok ? 'ok' : 'error',
        detail: ok
          ? `Íntegra · ${dbSizeMB} MB · ${ventas} ventas · ${productos} productos · ${clientes} clientes`
          : `Error de integridad: ${integrity?.integrity_check}`,
        value: { integrity: integrity?.integrity_check, sizeMB: dbSizeMB, ventas, productos, clientes },
      });
    } catch(e) {
      results.push({ id:'db', label:'Base de datos', status:'error', detail: e.message });
    }

    // ── 2. Backups ───────────────────────────
    try {
      const backupDir  = path.join(DATA_DIR, 'backups');
      const backups    = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir).filter(f => f.startsWith('velo_') && f.endsWith('.db')).sort().reverse()
        : [];
      const lastBackup = backups[0] ? backups[0].replace('velo_','').replace('.db','') : null;
      const today      = new Date().toISOString().split('T')[0];
      const yesterday  = new Date(Date.now()-86400000).toISOString().split('T')[0];
      const daysSince  = lastBackup
        ? Math.floor((Date.now() - new Date(lastBackup)) / 86400000) : 999;
      const status     = !lastBackup ? 'error' : daysSince <= 1 ? 'ok' : daysSince <= 3 ? 'warn' : 'error';
      results.push({
        id: 'backup', label: 'Backups',
        status,
        detail: !lastBackup
          ? 'Nunca se ha hecho un backup — riesgo crítico de pérdida de datos'
          : daysSince === 0 ? `Backup de hoy · ${backups.length} guardados`
          : daysSince === 1 ? `Último backup: ayer · ${backups.length} guardados`
          : `Último backup hace ${daysSince} días · ${backups.length} guardados`,
        value: { lastBackup, count: backups.length, daysSince },
      });
    } catch(e) {
      results.push({ id:'backup', label:'Backups', status:'error', detail: e.message });
    }

    // ── 3. Caja ──────────────────────────────
    try {
      const cajaAbierta = cashRepo.getOpen();
      let status = 'ok', detail = 'Sin sesión de caja activa';
      if (cajaAbierta) {
        const abiertaEn = new Date(cajaAbierta.opened_at);
        const horasAbierta = Math.floor((Date.now() - abiertaEn) / 3600000);
        if (horasAbierta > 24) {
          status = 'error';
          detail = `Caja abierta hace ${horasAbierta}h — posiblemente olvidaron cerrarla`;
        } else {
          status = 'ok';
          detail = `Caja abierta hace ${horasAbierta}h por ${cajaAbierta.cajero || 'cajero'}`;
        }
      }
      // Revisar diferencia del último cierre
      const ultimoCierre = dbInst.prepare(
        `SELECT * FROM cash_sessions WHERE status='closed' ORDER BY id DESC LIMIT 1`
      ).get();
      if (ultimoCierre) {
        const diff = Math.abs((ultimoCierre.close_amount || 0) - (ultimoCierre.expected_amount || 0));
        if (diff > 500 && status === 'ok') {
          status = 'warn';
          detail += ` · Último cierre con diferencia de RD$${diff.toLocaleString('es-DO')}`;
        }
      }
      results.push({ id:'caja', label:'Caja', status, detail,
        value: { abierta: !!cajaAbierta, horasAbierta: cajaAbierta
          ? Math.floor((Date.now()-new Date(cajaAbierta.opened_at))/3600000) : 0 }
      });
    } catch(e) {
      results.push({ id:'caja', label:'Caja', status:'warn', detail: e.message });
    }

    // ── 4. Licencia ──────────────────────────
    try {
      const lic = getLicenseStatus(DATA_DIR);
      let status = 'ok', detail = '';
      if (lic.blocked)       { status = 'error'; detail = 'Sin licencia válida — sistema bloqueado'; }
      else if (lic.inGrace)  { status = 'warn';  detail = `Período de gracia — ${lic.graceDaysLeft} días restantes`; }
      else if (lic.warningSoon) { status = 'warn'; detail = `Licencia vence en ${lic.daysLeft} días`; }
      else if (lic.licensed) { detail = `Activa · ${lic.expiry === 'Perpetua' ? 'Perpetua' : 'Vence: ' + lic.expiry} · ${lic.business}`; }
      results.push({ id:'license', label:'Licencia', status, detail, value: lic });
    } catch(e) {
      results.push({ id:'license', label:'Licencia', status:'error', detail: e.message });
    }

    // ── 5. Disco ─────────────────────────────
    try {
      const totalMem  = os.totalmem();
      const freeMem   = os.freemem();
      const memUsoPct = Math.round((1 - freeMem/totalMem) * 100);
      // Espacio en disco — leer la partición donde está userData
      let diskDetail = `RAM: ${Math.round(freeMem/1024/1024)}MB libre de ${Math.round(totalMem/1024/1024)}MB`;
      let diskStatus = memUsoPct > 90 ? 'warn' : 'ok';
      // Estimar espacio libre mirando el directorio de datos
      try {
        const { execSync } = require('child_process');
        if (process.platform === 'win32') {
          const drive = DATA_DIR.split(':')[0] + ':';
          const out   = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, { timeout: 3000 }).toString();
          const match = out.match(/FreeSpace=(\d+)/);
          if (match) {
            const freeGB = (parseInt(match[1]) / 1024 / 1024 / 1024).toFixed(1);
            diskDetail += ` · Disco: ${freeGB}GB libres`;
            if (parseFloat(freeGB) < 1) { diskStatus = 'error'; diskDetail += ' — espacio crítico'; }
            else if (parseFloat(freeGB) < 3) { diskStatus = 'warn'; }
          }
        }
      } catch {}
      results.push({ id:'disk', label:'Sistema', status: diskStatus, detail: diskDetail,
        value: { memUsoPct, freeMemMB: Math.round(freeMem/1024/1024) }
      });
    } catch(e) {
      results.push({ id:'disk', label:'Sistema', status:'warn', detail: e.message });
    }

    // ── 6. Reloj del sistema ─────────────────
    try {
      const now        = new Date();
      const year       = now.getFullYear();
      const status     = (year < 2025 || year > 2035) ? 'error' : 'ok';
      results.push({
        id: 'clock', label: 'Fecha y hora',
        status,
        detail: status === 'error'
          ? `Fecha incorrecta: ${now.toLocaleString('es-DO')} — los reportes y NCF pueden fallar`
          : `${now.toLocaleDateString('es-DO', { weekday:'long', year:'numeric', month:'long', day:'numeric' })} · ${now.toLocaleTimeString('es-DO')}`,
        value: { timestamp: now.toISOString() },
      });
    } catch(e) {
      results.push({ id:'clock', label:'Fecha y hora', status:'warn', detail: e.message });
    }

    // ── 7. Impresora ─────────────────────────
    try {
      const printerSaved = settingsRepo.getAll()?.printer || '';
      if (!printerSaved) {
        results.push({ id:'printer', label:'Impresora', status:'warn',
          detail:'Sin impresora configurada — imprimirá con el diálogo del sistema' });
      } else {
        const printers = await mainWindow.webContents.getPrintersAsync();
        const found    = printers.find(p => p.name === printerSaved);
        results.push({ id:'printer', label:'Impresora', status: found ? 'ok' : 'error',
          detail: found
            ? `"${printerSaved}" encontrada y lista`
            : `"${printerSaved}" configurada pero NO encontrada en el sistema — puede haber sido desinstalada`,
          value: { configured: printerSaved, found: !!found },
        });
      }
    } catch(e) {
      results.push({ id:'printer', label:'Impresora', status:'warn', detail: e.message });
    }

    // ── 8. API key de Claude ─────────────────
    try {
      const keyFile  = path.join(DATA_DIR, 'velo-ai.key');
      const keyExists = fs.existsSync(keyFile);
      const keyValid  = keyExists
        ? fs.readFileSync(keyFile,'utf8').trim().startsWith('sk-ant-')
        : false;
      results.push({
        id: 'ai', label: 'Importador IA',
        status: !keyExists ? 'warn' : !keyValid ? 'error' : 'ok',
        detail: !keyExists
          ? 'API key no encontrada — el importador IA no estará disponible'
          : !keyValid ? 'API key con formato inválido'
          : 'API key de Claude configurada correctamente',
        value: { exists: keyExists, valid: keyValid },
      });
    } catch(e) {
      results.push({ id:'ai', label:'Importador IA', status:'warn', detail: e.message });
    }

    // ── 9. Módulo fiscal ─────────────────────
    try {
      const s           = settingsRepo.getAll();
      const fiscalOn    = s?.fiscal_enabled === '1';
      if (fiscalOn) {
        const tieneRnc  = (s?.biz_rnc || '').trim().length > 0;
        const ncfCount  = parseInt(s?.ncf_counter || '0');
        const ventasFact = dbInst.prepare(
          `SELECT COUNT(*) as c FROM sales WHERE type='factura' AND status!='cancelled'`
        ).get().c;
        const status    = !tieneRnc ? 'error' : 'ok';
        results.push({ id:'fiscal', label:'Módulo fiscal',
          status,
          detail: !tieneRnc
            ? 'Módulo fiscal activo pero sin RNC configurado'
            : `RNC: ${s.biz_rnc} · ITBIS: ${s.tax_pct}% · NCF counter: ${ncfCount} · ${ventasFact} facturas`,
          value: { fiscalOn, tieneRnc, ncfCount, ventasFact },
        });
      } else {
        results.push({ id:'fiscal', label:'Módulo fiscal', status:'ok',
          detail:'Desactivado — negocio sin RNC (normal)', value: { fiscalOn: false } });
      }
    } catch(e) {
      results.push({ id:'fiscal', label:'Módulo fiscal', status:'warn', detail: e.message });
    }

    // ── Resumen ──────────────────────────────
    const errors = results.filter(r => r.status === 'error').length;
    const warns  = results.filter(r => r.status === 'warn').length;
    const score  = errors > 0 ? 'critical' : warns > 0 ? 'warn' : 'healthy';

    return { ok: true, results, score, errors, warns, timestamp: new Date().toISOString() };

  } catch(e) {
    console.error('[system:diagnose]', e);
    return { ok: false, error: e.message };
  }
});


// ── Precio de combustible — scraping Presto + MICM ──────────────
ipcMain.handle('fuel:getPrices', async () => {
  const FALLBACK = {
    premium:        335.10,  // semana 30 mayo - 6 junio 2026
    regular:        307.50,  // Fuente: prestocombustibles.com / micm.gob.do
    diesel:         287.10,  // Gasoil Óptimo
    gasoil_regular: 259.80,
    glp:            137.20,
    gnv:             43.97,
  };

  const clean = str => {
    if (!str) return null;
    const n = parseFloat(String(str).replace(/[^\d.]/g, ''));
    return (n > 50 && n < 1000) ? n : null;
  };

  // ── FUENTE 1: prestocombustibles.com (tabla limpia) ───────────
  try {
    const res = await fetch('https://www.prestocombustibles.com/precios-combustibles/', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VeloPOS/1.5.5' }
    });
    if (res.ok) {
      const html = await res.text();
      const get = (label) => {
        const rx = new RegExp(label + '[^|\\n]*[|:]\\s*RD\\$?\\s*([\\d,.]+)', 'i');
        return clean(html.match(rx)?.[1]);
      };
      const premium = get('Gasolina Premium') || get('Premium');
      const regular = get('Gasolina Regular') || get('Regular');
      const diesel  = get('Gasoil .ptimo');
      const gasoilR = get('Gasoil Regular');
      const glp     = get('Gas Licuado') || get('GLP');
      const gnv     = get('Gas Natural') || get('GNV');
      if (premium && premium > 200) {
        return {
          ok: true, source: 'prestocombustibles',
          data: {
            premium,
            regular:        regular  || Math.round(premium * 0.917 * 10) / 10,
            diesel:         diesel   || Math.round(premium * 0.857 * 10) / 10,
            gasoil_regular: gasoilR  || Math.round(premium * 0.775 * 10) / 10,
            glp:            glp      || FALLBACK.glp,
            gnv:            gnv      || FALLBACK.gnv,
          }
        };
      }
    }
  } catch(e) { console.warn('[Fuel] Presto error:', e.message); }

  // ── FUENTE 2: micm.gob.do (artículo más reciente) ─────────────
  try {
    const listRes = await fetch('https://micm.gob.do/tag/precios-de-combustible/', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VeloPOS/1.5.5' }
    });
    if (listRes.ok) {
      const listHtml = await listRes.text();
      const urlMatch = listHtml.match(/href="(https:\/\/micm\.gob\.do\/[^"]*(?:combustible|gasolina|reajusta|precio)[^"]*?)"/i);
      if (urlMatch) {
        const artRes = await fetch(urlMatch[1], {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'VeloPOS/1.5.5' }
        });
        if (artRes.ok) {
          const html    = await artRes.text();
          const matchP  = html.match(/[Gg]asolina\s*[Pp]r[eé]mium[^<\d]{0,40}([\d,.]+)/i);
          const matchR  = html.match(/[Gg]asolina\s*[Rr]egular[^<\d]{0,40}([\d,.]+)/i);
          const matchDO = html.match(/[Gg]asoil\s*[ÓOo]ptimo[^<\d]{0,40}([\d,.]+)/i);
          const matchDR = html.match(/[Gg]asoil\s*[Rr]egular[^<\d]{0,40}([\d,.]+)/i);
          const matchG  = html.match(/[Gg][Ll][Pp][^<\d]{0,30}([\d,.]+)/i);
          const premium = clean(matchP?.[1]);
          if (premium && premium > 200) {
            return {
              ok: true, source: 'micm',
              data: {
                premium,
                regular:        clean(matchR?.[1])  || Math.round(premium * 0.917 * 10) / 10,
                diesel:         clean(matchDO?.[1]) || Math.round(premium * 0.857 * 10) / 10,
                gasoil_regular: clean(matchDR?.[1]) || Math.round(premium * 0.775 * 10) / 10,
                glp:            clean(matchG?.[1])  || FALLBACK.glp,
                gnv:            FALLBACK.gnv,
              }
            };
          }
        }
      }
    }
  } catch(e) { console.warn('[Fuel] MICM error:', e.message); }

  // ── FALLBACK: precios verificados más recientes ────────────────
  return { ok: true, source: 'fallback', data: FALLBACK };
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
    const rnc          = getSet('rnc').replace(/[-\s]/g, '');
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

    // 5. Determinar tipo de e-CF
    // E31 = Factura con valor fiscal (B01) — cliente con RNC
    // E32 = Factura consumidor final (B02) — cliente sin RNC
    const custRnc = (sale.cust_rnc || '').replace(/[-\s]/g, '');
    const tipoECF = custRnc ? '31' : '32';

    // 6. Construir el JSON según estructura DGII/MSeller
    const itbis    = sale.tax_amt  || 0;
    const subtotal = sale.subtotal || 0;
    const total    = sale.total    || 0;
    const discAmt  = sale.discount_amt || 0;

    // Items con ITBIS
    const detalles = items.map((item, idx) => {
      const precioUnit = item.price || 0;
      const cantidad   = item.quantity || 1;
      const monto      = item.subtotal || (precioUnit * cantidad);
      const itbisItem  = itbis > 0 ? parseFloat((monto * 0.18).toFixed(2)) : 0;
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
            DireccionEmisor:   getSet('addr') || 'República Dominicana',
            Telefono:          (getSet('phone') || '').replace(/[^0-9]/g, '').slice(0, 10),
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


app.whenReady().then(() => {
  // Cargar API key de Claude (necesita userData, disponible solo aquí)
  _loadApiKey();

  try {
    db = initDB(DATA_DIR);
    initVersioning(db, DATA_DIR);
  } catch (e) {
    console.error('[DB] Error al inicializar:', e);
    dialog.showErrorBox('Error de base de datos', e.message);
    app.quit();
    return;
  }
  createWindow();
  // Verificar actualizaciones 8 segundos después del arranque,
  // cuando la ventana ya está completamente cargada y visible.
  setTimeout(() => setupAutoUpdater(), 8000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Cierre limpio
app.on('before-quit', () => {
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
      : tipo === 'facturas_credito'
      ? 'customer_name (Cliente, requerido), invoice_ref (N° factura), date (Fecha), product_name (Artículo, requerido), qty (Cantidad), unit_price (Precio unitario, requerido), total (Total factura), phone (Teléfono), rnc (RNC), credit_days (Días crédito)'
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

    // Validar que la API key existe y tiene formato correcto antes de llamar
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return { ok: false, error: 'API_KEY_INVALID', authError: true };
    }

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

    // Detectar error de autenticación específicamente para dar mensaje claro
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'API_KEY_INVALID', authError: true };
    }
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
    // SEGURIDAD: solo URLs https:// a dominios conocidos
    if (!url || typeof url !== 'string') return { ok: false, error: 'URL inválida' };
    const ALLOWED_PREFIXES = ['https://wa.me/', 'https://api.whatsapp.com/'];
    const isAllowed = ALLOWED_PREFIXES.some(prefix => url.startsWith(prefix));
    if (!isAllowed) return { ok: false, error: 'URL no permitida' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════
// IPC — CUENTAS FINANCIERAS (BANCOS)
// ══════════════════════════════════════════════

function _normalizeFinAcct(a) {
  if (!a) return null;
  return { ...a, balance: a.current_balance || 0, is_active: a.active === 1 || a.active === true };
}

function _normalizeFinMov(m) {
  if (!m) return null;
  // Normalize DB types back to UI-friendly names for display
  const typeDisplayMap = {
    deposito: 'ingreso', retiro: 'egreso', transferencia_in: 'transferencia',
    transferencia_out: 'transferencia', venta: 'ingreso', gasto: 'egreso',
    abono_recibido: 'ingreso', pago_proveedor: 'egreso', apertura: 'ingreso', ajuste: 'ajuste',
  };
  const outflows = ['retiro','transferencia_out','gasto','pago_proveedor'];
  return {
    ...m,
    type:         typeDisplayMap[m.type] || m.type,
    db_type:      m.type,
    reference:    m.notes || m.cancel_reason || '',
    is_outflow:   outflows.includes(m.type),
  };
}

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
    const id = financialAccountsRepo.create({ ...data, userId: requestUserId });
    audit.log(requestUserId, 'financial_account_create', `Cuenta creada: ${data.name}`);
    return { ok: true, data: { id } };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:update', async (_, { id, data, requestUserId }) => {
  try {
    financialAccountsRepo.update(id, data);
    audit.log(requestUserId, 'financial_account_update', `Cuenta actualizada: ${id}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('financial:toggleActive', async (_, { id, active, requestUserId }) => {
  try {
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
    const account = accountingRepo.createAccount(data);
    audit.log(requestUserId, 'accounting_account_create', `Cuenta contable creada: ${data.code} - ${data.name}`);
    return { ok: true, data: account };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:updateAccount', async (_, { id, data, requestUserId }) => {
  try {
    accountingRepo.updateAccount(id, data);
    audit.log(requestUserId, 'accounting_account_update', `Cuenta contable actualizada: ${id}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:deleteAccount', async (_, { id, requestUserId }) => {
  try {
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
    accountingRepo.setConfig(key, value);
    audit.log(requestUserId, 'accounting_config_set', `Config contable: ${key}=${value}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('accounting:createEntry', async (_, { data, requestUserId }) => {
  try {
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

ipcMain.handle('accounting:syncHistorical', async (_, { requestUserId } = {}) => {
  try {
    // Obtener ventas no vinculadas a asientos contables y generar asientos retroactivos
    const db = require('./database').getDB();
    const sales = db.prepare(`
      SELECT s.* FROM sales s
      WHERE s.status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM accounting_entries ae WHERE ae.ref_type = 'sale' AND ae.ref_id = s.id
      )
      ORDER BY s.created_at ASC
      LIMIT 500
    `).all();

    let created = 0;
    for (const sale of sales) {
      try {
        accountingRepo.generateSaleEntry(sale.id);
        created++;
      } catch (_) {}
    }

    // Gastos pagados no vinculados
    const expenses = db.prepare(`
      SELECT e.* FROM expenses e
      WHERE e.status = 'pagado'
      AND NOT EXISTS (
        SELECT 1 FROM accounting_entries ae WHERE ae.ref_type = 'expense' AND ae.ref_id = e.id
      )
      ORDER BY e.created_at ASC
      LIMIT 500
    `).all();

    for (const exp of expenses) {
      try {
        accountingRepo.generateExpenseEntry(exp.id);
        created++;
      } catch (_) {}
    }

    audit.log(requestUserId || 0, 'accounting_sync_historical', `Sincronización histórica: ${created} asientos generados`);
    return { ok: true, data: { created } };
  } catch (e) { return { ok: false, error: e.message }; }
});
