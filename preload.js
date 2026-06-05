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
    login:        (data)     => ipcRenderer.invoke('auth:login', data),
    logout:       (data)     => ipcRenderer.invoke('auth:logout', data),
    getSuperPass: ()         => ipcRenderer.invoke('auth:getSuperPass'),
  },

  // ── Settings ──────────────────────────────
  settings: {
    getAll: ()               => ipcRenderer.invoke('settings:getAll'),
    set:    (data)           => ipcRenderer.invoke('settings:set', data),
  },

  // ── Usuarios ──────────────────────────────
  users: {
    getAll:         ()         => ipcRenderer.invoke('users:getAll'),
    getById:        (id)       => ipcRenderer.invoke('users:getById', id),
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
    log:     (data)          => ipcRenderer.invoke('audit:log', data),
  },
  // ── Shell — abrir links en navegador del sistema ──
  shell: {
    openExternal: (url)      => ipcRenderer.invoke('shell:openExternal', { url }),
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

  // ── Categorías ────────────────────────────────
  categories: {
    getAll:  ()       => ipcRenderer.invoke('categories:getAll'),
    create:  (data)   => ipcRenderer.invoke('categories:create', data),
    delete:  (data)   => ipcRenderer.invoke('categories:delete', data),
  },

  // ── DB Tools ──────────────────────────────
  db: {
    vacuum: (data) => ipcRenderer.invoke('db:vacuum', data),
  },

  // ── Auto-updater ──────────────────────────
  updater: {
    onProgress: (cb) => ipcRenderer.on('update:progress', (_, data) => cb(data)),
    onState:    (cb) => ipcRenderer.on('update:state',    (_, data) => cb(data)),
    getState:   ()   => ipcRenderer.invoke('update:getState'),
    check:      ()   => ipcRenderer.invoke('update:check'),
    download:   ()   => ipcRenderer.invoke('update:download'),
    install:    (data) => ipcRenderer.invoke('update:install', data),
  },

  // ── Importación universal ────────────────
  importar: {
    readSQLite:    (data)    => ipcRenderer.invoke('importar:readSQLite',    data),
    readPDF:       (data)    => ipcRenderer.invoke('importar:readPDF',       data),
    analyzeWithAI: (data)    => ipcRenderer.invoke('importar:analyzeWithAI', data),
  },

  // ── Proveedores ───────────────────────────
  suppliers: {
    getAll:  ()           => ipcRenderer.invoke('suppliers:getAll'),
    create:  (data)       => ipcRenderer.invoke('suppliers:create', data),
    update:  (data)       => ipcRenderer.invoke('suppliers:update', data),
    delete:  (data)       => ipcRenderer.invoke('suppliers:delete', data),
  },

  // ── Órdenes de compra ─────────────────────
  purchases: {
    getAll:   (params)    => ipcRenderer.invoke('purchases:getAll', params),
    getById:  (data)      => ipcRenderer.invoke('purchases:getById', data),
    create:   (data)      => ipcRenderer.invoke('purchases:create', data),
    receive:  (data)      => ipcRenderer.invoke('purchases:receive', data),
    cancel:   (data)      => ipcRenderer.invoke('purchases:cancel', data),
  },

  // ── Diagnóstico del sistema ───────────────
  system: {
    diagnose: (data) => ipcRenderer.invoke('system:diagnose', data),
  },

  // ── Multi-negocios ──────────────────────
  business: {
    getAll:    ()  => ipcRenderer.invoke('business:getAll'),
    getActive: ()  => ipcRenderer.invoke('business:getActive'),
    create:    (d) => ipcRenderer.invoke('business:create', d),
    switch:    (d) => ipcRenderer.invoke('business:switch', d),
    delete:    (d) => ipcRenderer.invoke('business:delete', d),
  },

  // ── Multi-negocios ──────────────────────────
  // ── Sucursales ───────────────────────────
  branches: {
    getAll:   ()  => ipcRenderer.invoke('branches:getAll'),
    create:   (d) => ipcRenderer.invoke('branches:create', d),
    update:   (d) => ipcRenderer.invoke('branches:update', d),
    delete:   (d) => ipcRenderer.invoke('branches:delete', d),
  },

  // ── Vehículos ────────────────────────────
  vehicles: {
    getAll:   ()  => ipcRenderer.invoke('vehicles:getAll'),
    create:   (d) => ipcRenderer.invoke('vehicles:create', d),
    update:   (d) => ipcRenderer.invoke('vehicles:update', d),
    delete:   (d) => ipcRenderer.invoke('vehicles:delete', d),
    calcFuel: (d) => ipcRenderer.invoke('vehicles:calcFuel', d),
  },

  // ── Mantenimiento ────────────────────────
  maintenance: {
    getTypes:     ()  => ipcRenderer.invoke('maintenance:getTypes'),
    getByVehicle: (d) => ipcRenderer.invoke('maintenance:getByVehicle', d),
    getPending:   ()  => ipcRenderer.invoke('maintenance:getPending'),
    create:       (d) => ipcRenderer.invoke('maintenance:create', d),
    delete:       (d) => ipcRenderer.invoke('maintenance:delete', d),
  },

  // ── Envíos ───────────────────────────────
  deliveries: {
    getAll:        (d) => ipcRenderer.invoke('deliveries:getAll', d),
    getSummary:    ()  => ipcRenderer.invoke('deliveries:getSummary'),
    create:        (d) => ipcRenderer.invoke('deliveries:create', d),
    updateStatus:  (d) => ipcRenderer.invoke('deliveries:updateStatus', d),
  },

  // ── NCF Avanzado ─────────────────────────
  ncf: {
    getSequences:    ()  => ipcRenderer.invoke('ncf:getSequences'),
    createSequence:  (d) => ipcRenderer.invoke('ncf:createSequence', d),
    getAlerts:       ()  => ipcRenderer.invoke('ncf:getAlerts'),
    validateRnc:     (d) => ipcRenderer.invoke('ncf:validateRnc', d),
  },

  // ── Gastos y cuentas por pagar ───────────
  expenses: {
    getConfig:        (d) => ipcRenderer.invoke('expenses:getConfig', d),
    setConfig:        (d) => ipcRenderer.invoke('expenses:setConfig', d),
    getCategories:    ()  => ipcRenderer.invoke('expenses:getCategories'),
    createCategory:   (d) => ipcRenderer.invoke('expenses:createCategory', d),
    updateCategory:   (d) => ipcRenderer.invoke('expenses:updateCategory', d),
    getAll:           (d) => ipcRenderer.invoke('expenses:getAll', d),
    getById:          (d) => ipcRenderer.invoke('expenses:getById', d),
    getSummary:       (d) => ipcRenderer.invoke('expenses:getSummary', d),
    create:           (d) => ipcRenderer.invoke('expenses:create', d),
    pay:              (d) => ipcRenderer.invoke('expenses:pay', d),
    approve:          (d) => ipcRenderer.invoke('expenses:approve', d),
    reject:           (d) => ipcRenderer.invoke('expenses:reject', d),
    cancel:           (d) => ipcRenderer.invoke('expenses:cancel', d),
    getPayable:       (d) => ipcRenderer.invoke('expenses:getPayable', d),
    getRecurring:     (d) => ipcRenderer.invoke('expenses:getRecurring', d),
    createRecurring:  (d) => ipcRenderer.invoke('expenses:createRecurring', d),
    toggleRecurring:  (d) => ipcRenderer.invoke('expenses:toggleRecurring', d),
    getBudgets:       (d) => ipcRenderer.invoke('expenses:getBudgets', d),
    upsertBudget:     (d) => ipcRenderer.invoke('expenses:upsertBudget', d),
  },

  // ── Precio combustible (scraping Presto + MICM) ──────────────
  fuel: {
    getPrices: () => ipcRenderer.invoke('fuel:getPrices'),
  },

  // ── Facturación Electrónica e-CF (MSeller) ────────────────────
  ecf: {
    emit:       (d) => ipcRenderer.invoke('ecf:emit',       d),
    getStatus:  (d) => ipcRenderer.invoke('ecf:getStatus',  d),
    saveConfig: (d) => ipcRenderer.invoke('ecf:saveConfig', d),
    getConfig:  ()  => ipcRenderer.invoke('ecf:getConfig'),
    getLog:     (d) => ipcRenderer.invoke('ecf:getLog',     d),
  },

});