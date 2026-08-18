'use strict';

// ════════════════════════════════════════════════════════════════════════════
// Vertical pack — Tecnología / celulares (VELO TECH POS)
// ────────────────────────────────────────────────────────────────────────────
// Segundo producto de la suite. Monta sobre el MISMO core que VELO POS; solo
// declara lo que lo hace distinto: identidad, paleta, terminología, set de
// módulos y modelo de producto serializado (IMEI/serial).
//
// La identidad del producto (appId/name/canal) la fija build/electron-builder-
// tech.js; se repite aquí como referencia. El tema es override-only: solo estas
// variables cambian respecto al :root de styles.css (paleta placeholder azul,
// afinable con el diseño real sin afectar a VELO POS).
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  id: 'tech',

  product: {
    appId: 'do.velotechpos.app',
    name:  'Velo Tech POS',
  },

  // Modelo serializado: cada equipo se rastrea por unidad (IMEI/serial) en
  // product_units. Enciende el flujo serializado de R5.
  serialized: true,

  // Tema (override-only): la marca verde de VELO POS pasa a azul en TECH.
  // Placeholder — se calibra con el diseño final. Solo afecta al build TECH.
  theme: {
    'green':       '#2563EB',
    'green-bg':    '#EFF6FF',
    'green-line':  '#BFDBFE',
    'accent':      '#2563EB',
    'teal':        '#1D4ED8',
  },

  // Terminología del rubro (fallback al texto actual donde no se define).
  terminology: {
    product_singular: 'Equipo',
    product_plural:   'Equipos',
    code_label:       'IMEI / Serial',
    catalog_title:    'Inventario de equipos',
    new_product:      'Nuevo equipo',
  },

  // Set de módulos por defecto del rubro (se cablea a los toggles en R5/R6).
  modules: {
    serialized:     true,   // inventario por IMEI (R5)
    service_orders: true,   // reparación (R6)
    trade_in:       true,   // compra de usados (R7)
    vehicles:       false,  // no aplica a tecnología
  },
};
