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
    tagline: 'Celulares · Tecnología · Servicio',
    logo:  'assets/velo-tech-logo.svg',
  },

  // Modelo serializado: cada equipo se rastrea por unidad (IMEI/serial) en
  // product_units. Enciende el flujo serializado de R5.
  serialized: true,

  // Tema (override-only): paleta exacta del logo VELO TECH POS — azul royal del
  // rayo sobre chrome oscuro. La marca verde de VELO POS pasa a azul; el sidebar
  // se mantiene oscuro (comparte --ink con el texto), que es justo el lockup del
  // logo sobre fondo negro. Un sidebar navy dedicado sería un ajuste de diseño
  // aparte (requiere separar --ink del fondo del sidebar).
  theme: {
    'green':       '#2563EB',   // azul royal del rayo — botón primario / marca
    'green-bg':    '#EAF1FE',   // tinte claro para fondos de éxito/marca
    'green-line':  '#BBD3FA',   // borde claro de marca
    'accent':      '#2563EB',   // acento base
    'teal':        '#1E40AF',   // navy secundario del logo
  },
  // Acento por módulo: la app pinta cada módulo con su propio --module-accent
  // (clase .module-xxx). Este valor los unifica al azul del rubro; se aplica con
  // un stylesheet de mayor especificidad ([data-vertical] .module-xxx).
  moduleAccent: '#2563EB',

  // Terminología del rubro (fallback al texto actual donde no se define). Cubre
  // labels y ejemplos/placeholders que deben leerse como tecnología, no auto.
  terminology: {
    product_singular:     'Equipo',
    product_plural:       'Equipos',
    code_label:           'IMEI / Serial',
    catalog_title:        'Inventario de equipos',
    new_product:          'Nuevo equipo',
    edit_product:         'Editar equipo',
    register_in_inventory:'Registrar equipo en inventario',
    // Ejemplos/placeholders del modal de producto:
    product_name_example: 'iPhone 13 · 128GB · Negro',
    code_example:         'CEL-001',
    brand_example:        'Apple, Samsung, Xiaomi...',
    model_hint:           '',                              // sin "(compatible)" en tech
    model_example:        'iPhone 13, Galaxy S23, Redmi 12...',
  },

  // Set de módulos por defecto del rubro (se cablea a los toggles en R5/R6).
  modules: {
    serialized:     true,   // inventario por IMEI (R5)
    service_orders: true,   // reparación (R6)
    trade_in:       true,   // compra de usados (R7)
    vehicles:       false,  // no aplica a tecnología
  },
};
