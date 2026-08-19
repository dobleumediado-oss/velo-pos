// ════════════════════════════════════════════════════════════════════════════
// module-access.js — Catálogo y política central de acceso por usuario
// El rol define la base; los permisos individuales permiten especializar a un
// cajero sin convertirlo en administrador. Superadmin conserva acceso total.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  const CATALOG = [
    { key:'dash', title:'Dashboard', icon:'📊', group:'Operación', route:'dash', core:true, cashierDefault:false, desc:'Indicadores y resumen general del negocio.' },
    { key:'pos', title:'Punto de Venta', icon:'🧾', group:'Operación', route:'pos', core:true, cashierDefault:true, desc:'Cotizar, facturar y cobrar ventas.' },
    { key:'credito', title:'Ventas a crédito', icon:'💳', group:'Operación', capability:true, core:true, cashierDefault:true, desc:'Autoriza dejar saldo pendiente y define el máximo por factura.', limit:'credit_limit_per_sale' },
    { key:'preventa', title:'Preventa y Despacho', icon:'📋', group:'Operación', route:'preventa', setting:'module_preventa', roles:'module_preventa_roles', desc:'Preparar órdenes, reservar productos y enviarlas a caja.' },
    { key:'inventario', title:'Inventario', icon:'📦', group:'Gestión', route:'inventario', core:true, cashierDefault:false, desc:'Administrar productos, precios, stock, categorías y equipos/IMEI.' },
    { key:'servicio', title:'Servicio técnico', icon:'🛠️', group:'Gestión', route:'servicio', techOnly:true, core:true, cashierDefault:true, desc:'Recepción, diagnóstico, presupuestos, reparación y garantía.' },
    { key:'compras', title:'Compras', icon:'🚚', group:'Gestión', route:'compras', core:true, cashierDefault:false, desc:'Proveedores, órdenes de compra y recepción de mercancía.' },
    { key:'clientes', title:'Clientes', icon:'👥', group:'Gestión', route:'clientes', core:true, cashierDefault:true, desc:'Directorio, crédito, estados de cuenta y contactos.' },
    { key:'crm', title:'CRM Cerebro', icon:'🧠', group:'Gestión', route:'crm', setting:'module_crm', roles:'module_crm_roles', desc:'Segmentación, alertas y seguimiento comercial.' },
    { key:'ventas', title:'Ventas y facturas', icon:'🧮', group:'Gestión', route:'ventas', core:true, cashierDefault:true, desc:'Historial de facturas, cotizaciones y documentos.' },
    { key:'devoluciones', title:'Devoluciones', icon:'↩️', group:'Gestión', route:'devoluciones', core:true, cashierDefault:false, desc:'Registrar devoluciones y notas de crédito.' },
    { key:'vendedores', title:'Vendedores', icon:'🧑‍💼', group:'Equipo', route:'vendedores', setting:'module_vendedores', roles:'module_vendedores_roles', desc:'Vendedores, metas y rendimiento.' },
    { key:'comisiones', title:'Comisiones', icon:'📈', group:'Equipo', route:'comisiones', setting:'module_vendedores', roles:'module_vendedores_roles', desc:'Cálculo y liquidación de comisiones.' },
    { key:'nomina', title:'Nómina', icon:'📅', group:'Equipo', route:'nomina', setting:'module_vendedores', roles:'module_vendedores_roles', desc:'Pagos, viáticos y liquidaciones del personal.' },
    { key:'caja', title:'Caja', icon:'💵', group:'Finanzas', route:'caja', core:true, cashierDefault:true, desc:'Apertura, movimientos, arqueo y cierre de caja.' },
    { key:'gastos', title:'Gastos y Egresos', icon:'💸', group:'Finanzas', route:'gastos', setting:'module_gastos', roles:'module_gastos_roles', desc:'Registro y pago de gastos y cuentas por pagar.' },
    { key:'bancos', title:'Bancos y Cuentas', icon:'🏦', group:'Finanzas', route:'bancos', setting:'module_contabilidad', roles:'module_contabilidad_roles', desc:'Cuentas financieras, movimientos y conciliación.' },
    { key:'contabilidad', title:'Contabilidad', icon:'📒', group:'Finanzas', route:'contabilidad', setting:'module_contabilidad', roles:'module_contabilidad_roles', desc:'Catálogo, asientos y estados contables.' },
    { key:'sucursales', title:'Sucursales', icon:'🏪', group:'Operación avanzada', route:'sucursales', setting:'module_sucursales', roles:'module_sucursales_roles', desc:'Registro y administración de sucursales.' },
    { key:'vehiculos', title:'Vehículos', icon:'🚗', group:'Operación avanzada', route:'vehiculos', autoOnly:true, setting:'module_vehiculos', roles:'module_vehiculos_roles', desc:'Vehículos de la empresa y su información operativa.' },
    { key:'mantenimiento', title:'Mantenimiento', icon:'🔧', group:'Operación avanzada', route:'vehiculos', autoOnly:true, setting:'module_mantenimiento', roles:'module_mantenimiento_roles', desc:'Historial y programación de mantenimiento.' },
    { key:'envios', title:'Envíos y Despachos', icon:'📦', group:'Operación avanzada', route:'envios', setting:'module_envios', roles:'module_envios_roles', desc:'Entregas, rutas y seguimiento de despachos.' },
    { key:'conduce', title:'Conduces', icon:'🚛', group:'Operación avanzada', route:'conduce', setting:'module_conduce', roles:'module_conduce_roles', desc:'Notas de entrega sin precios ni efecto fiscal.' },
    { key:'reportes', title:'Reportes', icon:'📊', group:'Análisis', route:'reportes', core:true, cashierDefault:false, desc:'Indicadores, exportaciones y análisis del negocio.' },
    { key:'impresion', title:'Centro de impresión', icon:'🖨️', group:'Sistema', route:'impresion', setting:'barcode_enabled', roles:'barcode_enabled_roles', desc:'Documentos, impresoras y etiquetas de código de barras.' },
  ];

  const BY_KEY = Object.fromEntries(CATALOG.map(item => [item.key, item]));

  function parsePermissions(user) {
    const raw = user?.module_permissions;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    try {
      const parsed = JSON.parse(String(raw || '{}'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }

  function globallyEnabled(def) {
    if (!def) return false;
    if (def.techOnly && window._vertical?.id !== 'tech') return false;
    if (def.autoOnly && window._vertical?.id === 'tech') return false;
    if (def.core || def.capability) return true;
    if (def.setting === 'barcode_enabled') return !!window._bcEnabled;
    return String((typeof CFG !== 'undefined' ? CFG?.[def.setting] : '') || '') === '1';
  }

  function roleDefault(def, currentUser) {
    const role = String(currentUser?.role || '');
    if (role === 'superadmin') return true;
    if (role === 'admin') {
      if (!globallyEnabled(def)) return false;
      if (def.core || def.capability) return true;
      const configured = String((typeof CFG !== 'undefined' ? CFG?.[def.roles] : '') || 'admin');
      return configured.split(',').map(value => value.trim()).includes('admin');
    }
    if (role !== 'cajero' || !globallyEnabled(def)) return false;
    if (def.key === 'inventario') return Number(currentUser?.can_manage_inventory) === 1;
    if (def.key === 'credito') return currentUser?.can_sell_credit === undefined || Number(currentUser.can_sell_credit) === 1;
    if (def.core) return !!def.cashierDefault;
    const configured = String((typeof CFG !== 'undefined' ? CFG?.[def.roles] : '') || 'admin');
    return configured.split(',').map(value => value.trim()).includes('cajero');
  }

  function canAccess(key, currentUser = window._currentUser) {
    const def = BY_KEY[key];
    if (!def || !globallyEnabled(def)) return false;
    if (currentUser?.role === 'superadmin') return true;
    if (currentUser?.role === 'admin') return roleDefault(def, currentUser);
    const permissions = parsePermissions(currentUser);
    if (Object.prototype.hasOwnProperty.call(permissions, key)) return permissions[key] === true || permissions[key] === 1;
    return roleDefault(def, currentUser);
  }

  function firstAccessibleRoute(currentUser = window._currentUser) {
    return CATALOG.find(def => def.route && canAccess(def.key, currentUser))?.route || null;
  }

  window.VELO_MODULE_CATALOG = CATALOG;
  window.veloParseModulePermissions = parsePermissions;
  window.veloModuleGloballyEnabled = globallyEnabled;
  window.veloCanAccessModule = canAccess;
  window.veloFirstAccessibleRoute = firstAccessibleRoute;
})();
