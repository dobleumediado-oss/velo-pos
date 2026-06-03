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
  expensesRepo, branchesRepo, vehiclesRepo, maintenanceRepo, deliveriesRepo, ncfRepo
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

ipcMain.handle('settings:set', async (_, { key, value }) => {
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
    const result = cashRepo.close({
      sessionId, closeAmount, closeBills, expected, notes,
      userId: requestUserId, cajero: reqUser.name
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
      if (typeof item.unit_price !== 'number' || item.unit_price < 0) {
        return { ok: false, error: `Precio inválido en "${item.product_name || 'producto'}"` };
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
ipcMain.handle('print:html', async (_, { html, printerName, printerWidth, jobType, referenceId, userId }) => {
  try {
    const printWin = new BrowserWindow({
      width: 480, height: 700,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    await new Promise((resolve, reject) => {
      printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      printWin.webContents.once('did-finish-load', resolve);
      printWin.webContents.once('did-fail-load', (_, __, errDesc) =>
        reject(new Error(errDesc || 'No se pudo cargar el documento')));
    });

    // Pausa para que el CSS renderice antes de imprimir
    await new Promise(r => setTimeout(r, 350));

    const isThermal  = !!printerName;
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
        : 'A4',
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
ipcMain.handle('importar:analyzeWithAI', async (_, { headers, rows, tipo }) => {
  try {
    const campos = tipo === 'productos'
      ? 'name (Nombre, requerido), code (Código), barcode (Código barras), price (Precio venta, requerido), cost (Costo), wholesale (Precio mayor), stock (Stock), stock_min (Stock mínimo), category (Categoría), brand (Marca), unit (Unidad), description (Descripción)'
      : 'name (Nombre, requerido), phone (Teléfono), email (Email), rnc (RNC/Cédula), address (Dirección), credit_limit (Límite crédito)';

    const muestra = rows.slice(0, 5);
    const prompt = `Eres un experto en migración de datos para sistemas POS en República Dominicana.
Analiza este archivo y mapea sus columnas a los campos de Velo POS.

Columnas encontradas: ${headers.join(', ')}

Muestra de datos (primeras 5 filas):
${JSON.stringify(muestra, null, 2)}

Tipo de importación: ${tipo}
Campos disponibles en Velo POS: ${campos}

REGLAS IMPORTANTES:
1. Sé flexible: busca la columna que MÁS se parezca a cada campo aunque el nombre sea diferente.
2. Para "name/nombre": busca columnas como articulo, producto, descripcion, item, nombre, name, NOMBRE, ARTICULO, etc.
3. Para "price/precio": busca precio_venta, precio, price, PRECIO, PVP, valor, importe, monto, costo (si no hay precio).
4. Para "code/codigo": busca codigo, code, id, sku, referencia, barcode, codigo_barra.
5. Para "stock": busca cantidad, existencia, stock, qty, inventario, cantidad_inventario.
6. Para clientes "name": busca cliente, nombre, razon_social, company, CLIENTE, nombre_cliente.
7. Para clientes "phone": busca telefono, tel, phone, celular, movil, contacto.
8. Si el archivo tiene columnas vacías o con nombres raros (__EMPTY_1, etc.), analiza los DATOS para inferir qué contiene.
9. Si hay precios con formato extraño (comas, puntos, etc.), igual mapéalos — el sistema los limpiará.
10. SIEMPRE intenta hacer el mejor mapeo posible aunque la confianza sea baja.

Responde SOLO con JSON sin comentarios ni markdown:
{
  "mapping": {
    "name": "ColumnaExacta",
    "price": "ColumnaExacta",
    "code": "ColumnaExacta"
  },
  "confidence": 0.85,
  "notas": "Qué detectaste y qué ajustes puede necesitar el usuario"
}

Usa null solo si definitivamente no existe esa información en el archivo. Prefiere mapear con baja confianza a no mapear.`;

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
    if (!url || !url.startsWith('https://')) return { ok: false, error: 'URL inválida' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
