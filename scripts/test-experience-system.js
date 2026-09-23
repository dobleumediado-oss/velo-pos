'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const experience = read('src/js/experience.js');
const app = read('src/js/app.js');
const icons = read('src/js/icons.js');
const config = read('src/js/config.js');
const importer = read('src/js/importar.js');
const clientes = read('src/js/clientes.js');
const preload = read('preload.js');
const main = read('main.js');
const doctor = read('src/main/system-doctor.js');
const styles = read('src/css/styles.css');

for (const [name, source] of [
  ['experience.js', experience],
  ['app.js', app],
  ['icons.js', icons],
  ['config.js', config],
  ['importar.js', importer],
]) {
  assert.doesNotThrow(() => new vm.Script(source, { filename:name }), `${name} debe tener sintaxis válida`);
}

[
  'openSystemHealth',
  'openRecoveryCenter',
  'openAutomations',
  'openActionPermissions',
  'rememberFailure',
  'refreshShell',
].forEach(symbol => assert(experience.includes(symbol), `Falta experiencia transversal: ${symbol}`));

assert(experience.includes('vp_table_preferences_v1'), 'Las columnas deben conservar preferencias');
assert(experience.includes('ui-high-contrast'), 'Debe existir preferencia de contraste');
assert(experience.includes('ui-large-text'), 'Debe existir preferencia de texto ampliado');
assert(app.includes('data-ux-recovery'), 'El topbar debe exponer recuperación');
assert(app.includes('Operación detenida por conexión'), 'Los fallos de conexión deben ser recuperables');
assert(app.includes('commandCatalog'), 'La búsqueda global debe incluir comandos operativos');
assert(app.includes('Centro de impresión'), 'La búsqueda debe conducir al centro de impresión');
assert(!app.includes("backdropFilter: 'blur(4px)'"), 'El buscador no debe bloquear su apertura aplicando desenfoque');
assert(app.includes('}, 100);'), 'La búsqueda global debe responder con una pausa corta');
assert(/function\s+modalBack\s*\(/.test(app), 'Los modales secundarios deben poder volver al modal anterior');
assert(app.includes("html: '← Atrás'"), 'La navegación de modales debe mostrar Atrás');
assert(styles.includes('.ov{background:rgba(2,6,23,.55);backdrop-filter:none}'),
  'Los modales no deben aplicar desenfoque costoso al fondo');
assert(main.includes("customers:getAccountSales"), 'El estado de cuenta debe usar una ruta ligera de ventas');
assert(preload.includes('getAccountSales:'), 'La ruta ligera del estado de cuenta debe estar disponible en la interfaz');
assert(clientes.includes('cliSortLatestFirst'), 'Clientes debe ordenar facturas y abonos explícitamente');
assert(!clientes.includes('Preparando estado de cuenta'), 'El estado de cuenta no debe mostrar una espera con reloj');
assert(app.includes("id: 'lpass-toggle'"), 'El acceso debe permitir mostrar u ocultar la contraseña');
assert(app.includes("input.type = showing ? 'password' : 'text'"), 'El ojo debe alternar la visibilidad de la contraseña');
assert(app.includes("'aria-pressed': 'false'"), 'El ojo de contraseña debe comunicar su estado al lector de pantalla');
assert(icons.includes("'eye-off'"), 'Debe existir el icono para volver a ocultar la contraseña');
assert(config.includes('Solo se detectó una red virtual/NAT'), 'La conexión debe advertir cuando solo existe una IP virtual');
assert(config.includes('Consola protegida'), 'La consola del servidor no debe ofrecer una acción de expulsión');
assert(main.includes('La consola local del servidor está protegida'), 'El backend debe impedir expulsar la consola local');
assert(importer.includes('Datos históricos conciliados'), 'La migración debe explicar las conciliaciones históricas');

[
  "_hasActionPermission(reqUser, 'cancel_payment'",
  "_hasActionPermission(reqUser, 'restore_backup'",
  "_hasActionPermission(reqUser, 'system_health'",
].forEach(check => assert(main.includes(check), `Falta permiso operativo: ${check}`));

assert(doctor.includes('printer_channel_bindings'), 'El diagnóstico debe revisar canales de impresión');
assert(doctor.includes('Canales de impresión'), 'El diagnóstico debe comunicar canales por departamento');

[
  '.ux-connection-chip',
  '.ux-recovery-trigger',
  '.ux-health-summary',
  '.ux-modal-structured',
  '[data-ux-status="danger"]',
  '.ui-high-contrast',
  '.ui-large-text',
  '.login-pass-toggle',
].forEach(selector => assert(styles.includes(selector), `Falta estilo global: ${selector}`));

// ── Cambio de rol en el acceso, sin reconstruir la vista ──────────────────────
// Reconstruir toda la pantalla para marcar un botón devolvía el reloj a
// 00:00:00 y vaciaba la fecha, lo que cambiaba la altura del bloque y movía la
// tarjeta entera: el salto que se veía al pulsar Supervisor.
let accesoArnes = null;
{
  const from = app.indexOf('  const OTRO_CORREO');
  const to = app.indexOf('  function build() {', from);
  assert(from > 0 && to > from, 'el cambio de rol del acceso sigue en app.js');

  const usuariosDelServidor = [
    { name: 'Administrador', email: 'admin@mipos.do', role: 'admin', active: 1 },
    { name: 'Dueña', email: 'due\u00f1a@mipos.do', role: 'admin', active: 1 },
    { name: 'Admin viejo', email: 'viejo@mipos.do', role: 'admin', active: 0 },
    { name: 'Cajero', email: 'caja@mipos.do', role: 'cajero', active: 1 },
    { name: 'Super Admin', email: 'dev@sistema.do', role: 'superadmin', active: 1 },
  ];
  const nodes = new Map();
  const makeNode = (id) => {
    const node = {
      id, className: '', textContent: '', style: {}, children: [],
      focused: false,
      _innerHTML: '',
      // Vaciar innerHTML retira los hijos, igual que en el navegador.
      get innerHTML() { return node._innerHTML; },
      set innerHTML(value) { node._innerHTML = value; if (value === '') node.children = []; },
      classList: {
        toggle(name, on) {
          const has = node.className.split(' ').includes(name);
          if (on === true && !has) node.className = `${node.className} ${name}`.trim();
          if (on === false && has) {
            node.className = node.className.split(' ').filter(c => c !== name).join(' ');
          }
        },
      },
      appendChild(child) { node.children.push(child); return child; },
      replaceChild(next, prev) {
        const at = node.children.indexOf(prev);
        if (at >= 0) node.children[at] = next; else node.children.push(next);
        nodes.set('luser', next);
        return prev;
      },
      focus() { node.focused = true; context.document.activeElement = node; },
      addEventListener(type, handler) { (node.handlers[type] = node.handlers[type] || []).push(handler); },
      emit(type) { (node.handlers[type] || []).forEach(handler => handler()); },
      handlers: {},
      get tagName() { return String(node.tag || '').toUpperCase(); },
      get options() { return node.children.filter(child => child.tag === 'option'); },
    };
    nodes.set(id, node);
    return node;
  };

  ['lrole-cajero', 'lrole-admin', 'luser-label', 'luser-slot', 'luser-hint', 'lerr', 'login-clock-time']
    .forEach(makeNode);
  const firstField = makeNode('luser');
  nodes.get('luser-slot').children.push(firstField);
  nodes.get('lrole-cajero').className = 'role-btn on';
  nodes.get('lrole-admin').className = 'role-btn';
  nodes.get('login-clock-time').innerHTML = '04<span>:</span>04';

  const context = {
    selRole: 'cajero',
    window: { _cachedUsers: [], api: { users: { getAll: async () => usuariosDelServidor } } },
    document: {
      activeElement: null,
      getElementById: (id) => nodes.get(id) || null,
      // El campo de Cajero es un <select> que se arma con opciones reales.
      createElement: (tag) => ({ tag, value: '', textContent: '' }),
    },
    h: (tag, attrs, ...children) => {
      const node = makeNode(attrs && attrs.id ? attrs.id : `${tag}-nuevo`);
      node.tag = tag;
      if (attrs && attrs.onclick) node.onclick = attrs.onclick;
      node.textContent = children.filter(child => typeof child === 'string').join('');
      return node;
    },
    currentRole: () => context.selRole,
  };
  vm.runInNewContext(
    `${app.slice(from, to)}
     this.setLoginRole = setLoginRole;
     this.ensureLoginUsers = ensureLoginUsers;
     this.refreshLoginUserField = refreshLoginUserField;
     this.currentRole = () => selRole;`,
    context
  );

  context.setLoginRole('admin');
  assert(context.currentRole() === 'admin', 'el rol seleccionado cambia a Supervisor');
  assert(nodes.get('lrole-admin').className.includes('on') &&
    !nodes.get('lrole-cajero').className.includes('on'),
    'el botón activo se traslada sin reconstruir la vista');
  assert(nodes.get('luser-label').textContent === 'Email',
    'la etiqueta del campo pasa a Email');
  assert(nodes.get('luser').tag === 'input',
    'el selector de cajeros se sustituye por el campo de correo');
  assert(nodes.get('login-clock-time').innerHTML === '04<span>:</span>04',
    'el reloj sobrevive al cambio de rol: no vuelve a 00:00:00 ni mueve la tarjeta');
  assert(nodes.get('luser').id === 'luser',
    'el campo sustituido conserva el identificador que lee el ingreso');
  assert(nodes.get('luser').focused === true,
    'al cambiar de rol el foco queda en el campo de usuario, listo para escribir');
  assert(nodes.get('lerr').innerHTML === '',
    'un error de intento anterior no queda colgando tras cambiar de rol');
  // Y de vuelta a Cajero: el campo debe volver a ser el selector de cajeros.
  context.setLoginRole('cajero');
  assert(context.currentRole() === 'cajero' && nodes.get('luser').tag === 'select',
    'volver a Cajero repone el selector de usuarios, no deja el campo de correo');
  assert(nodes.get('lrole-cajero').className.includes('on') &&
    !nodes.get('lrole-admin').className.includes('on'),
    'el botón activo vuelve a Cajero');
  assert(!app.includes("onclick: () => { selRole = 'admin'; build(); }"),
    'el cambio de rol ya no reconstruye toda la pantalla de acceso');
  assert(app.includes('_startLoginClock();\n    document.getElementById(\'lpass\')?.focus();'),
    'el reloj arranca en el mismo cuadro en que se pinta el acceso');
  accesoArnes = { context, nodes };
}

// Pantallas de 1366×768 (portátiles de clientes). Las medidas se tomaron en la
// app real; aquí se protege que las reglas que las resuelven sigan en su sitio.
{
  const inventario = read('src/js/inventario.js');
  const sucursales = read('src/js/sucursales.js');

  // Barra superior: se compacta por niveles, nunca ocultando indicadores.
  const fitFrom = app.indexOf('const TOPBAR_FIT_LEVELS');
  const fitTo = app.indexOf('let _topbarFitFrame');
  assert(fitFrom > 0 && fitTo > fitFrom, 'fitTopbar vive en app.js');
  const makeBar = (natural, savings) => {
    const classes = new Set(['topbar', 'tb-fit-4']);
    const bar = { classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
    const center = { clientWidth: 400,
      get scrollWidth() { return natural - savings.filter((_, i) => classes.has(`tb-fit-${i + 1}`)).reduce((a, b) => a + b, 0); } };
    const context = { document: { getElementById: id => ({ topbar: bar, 'tb-center': center }[id]) } };
    vm.runInNewContext(`${app.slice(fitFrom, fitTo)}\nfitTopbar();`, context);
    return [...classes].filter(c => c.startsWith('tb-fit-')).sort();
  };
  assert.deepStrictEqual(makeBar(380, [40, 40, 40, 40, 40]), [],
    'con espacio de sobra la barra no se compacta y suelta niveles de una medición anterior');
  assert.deepStrictEqual(makeBar(470, [40, 40, 40, 40, 40]), ['tb-fit-1', 'tb-fit-2'],
    'la barra suma niveles solo hasta que cabe');
  assert.deepStrictEqual(makeBar(900, [10, 10, 10, 10, 10]).length, 5,
    'nunca pasa del último nivel aunque siga sin caber');
  // Solo el separador "·" (.tb-rate-dot) puede ocultarse, cuando compra y venta se apilan.
  const fitRules = styles.split('\n').filter(line => line.includes('.topbar.tb-fit-') && line.includes('display:none'));
  assert(fitRules.length > 0 &&
    fitRules.every(line => !/#tb-rates|\.tb-rate-(chip|label|value|pair)/.test(line)),
    'ningún nivel de la barra oculta la tasa del dólar ni los combustibles');
  assert(!/\.tb-rate-chip\s*\{[^}]*display:\s*none/.test(styles),
    'los indicadores de la barra no se ocultan en ninguna regla');

  // POS y cobro: el panel no pasa del alto real y el botón de confirmar se ve.
  assert(styles.includes('.pos-wrap{display:flex;height:100%;overflow:hidden}') &&
    !styles.includes('.pos-wrap{display:flex;height:calc(100vh - 58px)'),
    'el POS usa el alto de su área, no un cálculo fijo que desbordaba 6 px');
  assert(/\.modal > \.modal-foot\{\s*position:sticky;/.test(styles),
    'los botones del pie de un modal quedan fijos al fondo mientras el contenido se desplaza');

  // Tablas: densidad a 1440 px o menos, acciones siempre a la vista.
  assert(/@media \(max-width: 1440px\) \{\s*thead th,\.ui-compact thead th\{padding-left:9px;padding-right:9px\}\s*tbody td,\.ui-compact tbody td\{padding-left:9px;padding-right:9px\}/.test(styles),
    'a 1440 px o menos las celdas reducen solo su relleno lateral, también en modo compacto');
  assert(styles.includes('.velo-sticky-actions > tbody > tr > td:last-child{position:sticky;right:0}') &&
    styles.includes('animation-timeline:scroll(nearest inline)'),
    'la columna de acciones queda fija y su sombra depende del desplazamiento real');
  assert(inventario.includes('<table class="velo-sticky-actions">'),
    'la tabla de Inventario usa la columna de acciones fija');
  assert(sucursales.includes('<table class="velo-sticky-actions"'),
    'la tabla de secuencias NCF usa la columna de acciones fija');
  const rowActions = clientes.indexOf("h('div', { class: 'cli-row-actions' }");
  const deleteButton = clientes.indexOf('confirmEliminarCliente(c)', rowActions);
  const companyButton = clientes.indexOf("html: `${svg('users')} Representantes`", rowActions);
  assert(rowActions > 0 && deleteButton > rowActions && companyButton > deleteButton,
    'los botones de empresa van en su propio grupo, después de los de toda fila');
  assert(styles.includes('.cli-row-actions{display:flex;flex-wrap:wrap;gap:4px}'),
    'el grupo de empresa baja de línea en vez de ensanchar la tabla de Clientes');
  assert(/@media \(max-width: 1440px\) \{[\s\S]*?\.mod-tabs\{flex-wrap:wrap\}/.test(styles),
    'las 16 pestañas de Contabilidad bajan de fila en vez de quedar fuera de vista');
  assert(inventario.includes('<div class="inv-pager" style=') &&
    styles.includes('.inv-pager{padding-top:8px!important;padding-bottom:8px!important}'),
    'la paginación de Inventario se compacta en pantallas bajas');
}

// ── Comprobantes para la contable, fuera de Configuración ────────────────────
// Los reportes 607/608 vivían dentro de Configuración, que solo abre un
// administrador, y no había forma de sacar copias de las facturas en lote.
{
  const reportes = read('src/js/reportes.js');
  const sucursales = read('src/js/sucursales.js');
  const print = read('src/js/print.js');

  assert(reportes.includes("{ v: 'comprobantes', l: 'Comprobantes fiscales' }") &&
    reportes.includes('function _renderReporteComprobantes('),
    'Reportes tiene su pestaña de comprobantes fiscales');
  assert(!sucursales.includes('id="btn-rep-ncf"') &&
    sucursales.includes('Los reportes 607/608 están en Reportes → Comprobantes fiscales'),
    'Configuración ya no guarda los reportes 607/608 y dice dónde están');
  assert(reportes.includes("if (typeof modalReporteNCF === 'function') modalReporteNCF();"),
    'la pestaña abre el mismo reporte 607/608, sin duplicar su código');

  assert(reportes.includes('function _repFacturasConComprobante(') &&
    reportes.includes("pagina.filter(venta => String(venta.ncf || '').trim())") &&
    reportes.includes("range: 'custom', dateFrom: desde, dateTo: hasta"),
    'las copias toman las facturas con comprobante del período elegido');
  assert(reportes.includes('print_html_only: true') && print.includes('if (sale.print_html_only) return html;'),
    'el lote reutiliza la misma plantilla de impresión sin abrir una ventana por factura');
  assert(/\.replace\(\/<script\[\\s\\S\]\*\?<\\\/script>\/gi, ''\)/.test(reportes),
    'cada copia entra sin su script de autoajuste, que mediría el lote entero');
  assert(reportes.includes('.velo-copia { break-after: page; page-break-after: always; }'),
    'cada factura del lote sale en su propia página');
  assert(reportes.includes('function _repPlantillasDeHoja(') && reportes.includes("p.tipo === 'carta'"),
    'solo se ofrecen plantillas de hoja: una térmica no sirve para archivar');
}

// ── Elegir quién entra, sin escribir el correo ───────────────────────────────
// La lista de usuarios llega después de pintar el acceso. Antes el desplegable
// de Cajero se quedaba con el correo de ejemplo y Supervisor solo dejaba
// escribir el correo completo.
(async () => {
  const { context, nodes } = accesoArnes;
  const campo = () => nodes.get('luser');
  const textos = () => campo().options.map(option => option.textContent);
  await context.ensureLoginUsers();

  assert.strictEqual(campo().tagName, 'SELECT', 'Cajero conserva su desplegable');
  assert.deepStrictEqual(textos(), ['Cajero'], 'la lista que llega tarde reemplaza al cajero de ejemplo');
  assert.strictEqual(campo().options[0].value, 'caja@mipos.do',
    'el desplegable de Cajero usa el correo registrado del negocio');

  context.setLoginRole('admin');
  assert.deepStrictEqual(textos(), ['Administrador', 'Due\u00f1a', 'Otro correo…'],
    'Supervisor lista los administradores activos y deja escribir otro correo');
  assert(!textos().includes('Super Admin'), 'el superadministrador no se anuncia en el acceso');
  assert(!textos().includes('Admin viejo'), 'un administrador inactivo no aparece en la lista');
  assert.strictEqual(nodes.get('luser-label').textContent, 'Usuario', 'la etiqueta acompaña al desplegable');

  const selector = campo();
  selector.value = '__otro__';
  selector.emit('change');
  assert.strictEqual(campo().tagName, 'INPUT', '"Otro correo…" abre el campo libre');
  assert.strictEqual(nodes.get('luser-label').textContent, 'Email', 'la etiqueta vuelve a Email');
  assert.strictEqual(nodes.get('luser-hint').children.length, 1, 'se ofrece volver a la lista');

  campo().value = 'dev@sistema.do';
  context.refreshLoginUserField();
  assert.strictEqual(campo().value, 'dev@sistema.do',
    'una recarga de la lista no borra el correo que la persona escribió');

  nodes.get('luser-hint').children[0].onclick();
  assert.strictEqual(campo().tagName, 'SELECT', 'volver a la lista repone el desplegable');
  assert.strictEqual(nodes.get('luser-hint').children.length, 0, 'la pista desaparece al volver a la lista');

  console.log('✓ Experiencia transversal, recuperación, permisos y salud del sistema verificados');
})().catch(error => { console.error(error); process.exit(1); });
