// ══════════════════════════════════════════════
// preload.js — Puente seguro Main ↔ Renderer
// Solo expone lo que el renderer necesita
// NUNCA expone Node.js completo
// ══════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

// ── API expuesta al renderer ──────────────────
contextBridge.exposeInMainWorld('api', {

  // ── Auth ──────────────────────────────────
  auth: {
    login:  (data)           => ipcRenderer.invoke('auth:login', data),
    logout: (data)           => ipcRenderer.invoke('auth:logout', data),
  },

  // ── Settings ──────────────────────────────
  settings: {
    getAll: ()               => ipcRenderer.invoke('settings:getAll'),
    set:    (data)           => ipcRenderer.invoke('settings:set', data),
  },

  // ── Usuarios ──────────────────────────────
  users: {
    getAll:         ()         => ipcRenderer.invoke('users:getAll'),
    create:         (data)     => ipcRenderer.invoke('users:create', data),
    update:         (data)     => ipcRenderer.invoke('users:update', data),
    changePassword: (data)     => ipcRenderer.invoke('users:changePassword', data),
  },

  // ── Productos ─────────────────────────────
  products: {
    getAll:       ()         => ipcRenderer.invoke('products:getAll'),
    create:       (data)     => ipcRenderer.invoke('products:create', data),
    update:       (data)     => ipcRenderer.invoke('products:update', data),
    adjustStock:  (data)     => ipcRenderer.invoke('products:adjustStock', data),
    delete:       (data)     => ipcRenderer.invoke('products:delete', data),
    getMovements: (data)     => ipcRenderer.invoke('products:getMovements', data),
  },

  // ── Clientes ──────────────────────────────
  customers: {
    getAll:        ()          => ipcRenderer.invoke('customers:getAll'),
    create:        (data)      => ipcRenderer.invoke('customers:create', data),
    update:        (data)      => ipcRenderer.invoke('customers:update', data),
    addPayment:    (data)      => ipcRenderer.invoke('customers:addPayment', data),
    getPayments:   (data)      => ipcRenderer.invoke('customers:getPayments', data),
    getAllPayments: ()          => ipcRenderer.invoke('customers:getAllPayments'),
    getHistory:    (data)      => ipcRenderer.invoke('customers:getHistory', data),
  },

  // ── Caja ──────────────────────────────────
  cash: {
    getOpen:         ()      => ipcRenderer.invoke('cash:getOpen'),
    open:            (data)  => ipcRenderer.invoke('cash:open', data),
    close:           (data)  => ipcRenderer.invoke('cash:close', data),
    getSessions:     ()      => ipcRenderer.invoke('cash:getSessions'),
    getSessionSales: (data)  => ipcRenderer.invoke('cash:getSessionSales', data),
  },

  // ── Ventas ────────────────────────────────
  sales: {
    create:  (data)          => ipcRenderer.invoke('sales:create', data),
    getById: (data)          => ipcRenderer.invoke('sales:getById', data),
    getAll:  (data)          => ipcRenderer.invoke('sales:getAll', data),
    cancel:  (data)          => ipcRenderer.invoke('sales:cancel', data),
    return:  (data)          => ipcRenderer.invoke('sales:return', data),
  },

  // ── Reportes ──────────────────────────────
  reports: {
    summary:      (data)     => ipcRenderer.invoke('reports:summary', data),
    lowStock:     ()         => ipcRenderer.invoke('reports:lowStock'),
    creditAlerts: ()         => ipcRenderer.invoke('reports:creditAlerts'),
  },

  // ── Auditoría ─────────────────────────────
  audit: {
    getLogs: (data)          => ipcRenderer.invoke('audit:getLogs', data),
  },

  // ── Impresión ─────────────────────────────
  print: {
    html:         (data)      => ipcRenderer.invoke('print:html', data),
    getPrinters:  ()          => ipcRenderer.invoke('print:getPrinters'),
    savePrinter:  (data)      => ipcRenderer.invoke('print:savePrinter', data),
    getJobs:      (data)      => ipcRenderer.invoke('print:getJobs', data),
  },

  // ── Backup ────────────────────────────────
  backup: {
    create:  (data)          => ipcRenderer.invoke('backup:create', data),
    restore: (data)          => ipcRenderer.invoke('backup:restore', data),
    getList: ()              => ipcRenderer.invoke('backup:getList'),
  },

  // ── Version ───────────────────────────────
  version: {
    getInfo:       ()        => ipcRenderer.invoke('version:getInfo'),
    getAppVersion: ()        => ipcRenderer.invoke('version:getAppVersion'),
  },

  // ── Licencia ──────────────────────────────
  license: {
    getStatus:   ()          => ipcRenderer.invoke('license:getStatus'),
    activate:    (data)      => ipcRenderer.invoke('license:activate', data),
    getMachineId:()          => ipcRenderer.invoke('license:getMachineId'),
    revoke:      (data)      => ipcRenderer.invoke('license:revoke', data),
  },

  // ── DB Tools ──────────────────────────────
  db: {
    vacuum: (data) => ipcRenderer.invoke('db:vacuum', data),
  },
});