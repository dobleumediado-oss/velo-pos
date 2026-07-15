// ══════════════════════════════════════════════
// sync-events.js — Mapa de invalidación para el push en tiempo real (Fase C)
//   · PURO y sin estado: solo traduce un canal IPC que MUTA datos → los "scopes"
//     de datos que quedaron obsoletos en las otras terminales.
//   · El push es SOLO AVISO: no viaja ningún dato, solo el/los scope(s). El
//     cliente, al recibirlo, RE-CONSULTA al servidor (fuente de verdad) igual que
//     hoy → imposible corromper, solo dispara la lectura que ya existe.
//   · Canal no listado aquí = no se difunde (fallback: refresco manual, como hoy).
//     Sub-difundir es inofensivo (un re-fetch de más), sub-notificar solo pierde
//     el "en vivo" y cae al comportamiento actual. Por eso el mapa es explícito y
//     conservador: solo operaciones de POS que comparten estado entre terminales.
//   Ver docs/multi-terminal-sync.md
// ══════════════════════════════════════════════

// Scopes de datos que el renderer sabe recargar (reloadProducts/Customers/Sales).
// La caja (cash:*) NO va aquí: la sesión de caja es POR terminal, no se comparte.
const CHANNEL_SCOPES = {
  // Venta: baja stock, puede afectar el balance del cliente (crédito) y el historial.
  'sales:create':        ['sales', 'products', 'customers'],
  'sales:cancel':        ['sales', 'products', 'customers'],
  'sales:return':        ['sales', 'products', 'customers'],
  // Inventario.
  'products:create':     ['products'],
  'products:update':     ['products'],
  'products:delete':     ['products'],
  'products:adjustStock':['products'],
  'purchases:receive':   ['products'],
  // Clientes / cuentas por cobrar.
  'customers:create':    ['customers'],
  'customers:update':    ['customers'],
  'customers:delete':    ['customers'],
  'customers:addPayment':['customers', 'sales'],
};

// Devuelve el array de scopes de un canal, o null si no difunde.
function scopesForChannel(channel) {
  return CHANNEL_SCOPES[channel] || null;
}

module.exports = { CHANNEL_SCOPES, scopesForChannel };
