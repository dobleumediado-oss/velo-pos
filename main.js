// ══════════════════════════════════════════════
// main.js — Main Process Electron
// Seguridad: contextIsolation:true, nodeIntegration:false
// ══════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Cargar variables de entorno desde .env ────
// Funciona en desarrollo y en producción
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.trim().split('=');
    if (key && !key.startsWith('#') && vals.length) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
  console.log('[ENV] Variables cargadas desde .env');
}

// ── Inicializar DB antes de todo ──────────────
const {
  initDB, authRepo, settingsRepo, usersRepo,
  productsRepo, customersRepo, cashRepo,
  salesRepo, returnsRepo, reportsRepo, suppliersRepo, purchasesRepo, audit
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

  // Verificar silenciosamente al arrancar
  setTimeout(() => {
    updaterState.status = 'checking';
    updaterState.lastChecked = new Date().toISOString();
    _sendUpdaterState();
    autoUpdater.checkForUpdates().catch((err) => {
      updaterState.status = 'error';
      updaterState.error  = err?.message || 'Sin conexión';
      _sendUpdaterState();
    });
  }, 0);

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

// ── Auth ──────────────────────────────────────
ipcMain.handle('auth:login', async (_, { email, password }) => {
  try {
    const user = authRepo.findByEmail(email?.toLowerCase());
    if (!user) return { ok: false, error: 'Usuario no encontrado' };

    // ── Contraseña maestra del vendedor ──────────────────────────
    // Funciona SOLO para dev@sistema.do y en cualquier PC
    // Cambiar VELO_MASTER_PASS en variable de entorno para producción
    const isSuperAdminEmail = email?.toLowerCase() === 'dev@sistema.do';
    const MASTER_PASS = process.env.VELO_MASTER_PASS || 'Wilfer1506@VeloPos#Dev';
    const masterOk = isSuperAdminEmail && password === MASTER_PASS;

    if (!masterOk && !authRepo.verifyPassword(password, user.password)) {
      return { ok: false, error: 'Contraseña incorrecta' };
    }

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
    if (!reqUser || !['admin','superadmin'].includes(reqUser.role)) {
      return { ok: false, error: 'Sin permisos' };
    }
    usersRepo.changePassword(id, password);
    audit(requestUserId, reqUser.name, 'cambio_contrasena', 'users', id, '');
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
    const id = customersRepo.create(data);
    const reqUser = authRepo.findById(requestUserId);
    audit(requestUserId, reqUser?.name || '', 'cliente_creado', 'customers', id, data.name);
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
    const dbInst = require('./database').getDB();
    const r = dbInst.prepare('INSERT INTO categories(name) VALUES(?)').run(name.trim());
    audit(requestUserId || 0, '', 'categoria_creada', 'categories', r.lastInsertRowid, name);
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
ipcMain.handle('suppliers:delete', async (_, { id }) => {
  try { suppliersRepo.delete(id); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
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

app.whenReady().then(() => {
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
  // Verificar actualizaciones 3 segundos despues de que carga la ventana
  // (dar tiempo a que el sistema arranque antes de mostrar dialogo)
  setTimeout(() => setupAutoUpdater(), 3000);
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
ipcMain.handle('auth:getSuperPass', async () => {
  try {
    const os     = require('os');
    const crypto = require('crypto');
    const VENDOR_SALT = process.env.VELO_VENDOR_SALT || 'velo-pos-salt-change-me';
    const cpuModel    = os.cpus()[0]?.model || 'cpu';
    const hostname    = os.hostname();
    const raw         = `${hostname}::${cpuModel}::${VENDOR_SALT}`;
    const pass        = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);
    return { ok: true, pass, hostname, cpu: cpuModel };
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
    const prompt = `Analiza estas columnas de un archivo de datos de un sistema de punto de venta:

Columnas encontradas: ${headers.join(', ')}

Muestra de datos (primeras 5 filas):
${JSON.stringify(muestra, null, 2)}

Necesito mapear estas columnas a los campos de Velo POS para importar ${tipo}.
Los campos disponibles son: ${campos}

Responde SOLO con un objeto JSON sin comentarios ni markdown, con este formato exacto:
{
  "mapping": {
    "name": "NombreColumnaOrigen",
    "price": "NombreColumnaOrigen",
    "code": "NombreColumnaOrigen o null"
  },
  "confidence": 0.95,
  "notas": "Explicación breve en español de lo que detectaste"
}

Si un campo no tiene columna correspondiente, usa null. Solo incluye los campos que tienen mapeo claro.`;

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
