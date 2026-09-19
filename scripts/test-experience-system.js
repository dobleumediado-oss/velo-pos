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
{
  const from = app.indexOf('function buildLoginUserField()');
  const to = app.indexOf('  function build() {', from);
  assert(from > 0 && to > from, 'el cambio de rol del acceso sigue en app.js');

  const nodes = new Map();
  const makeNode = (id) => {
    const node = {
      id, className: '', textContent: '', innerHTML: '', style: {}, children: [],
      focused: false,
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
      focus() { node.focused = true; },
    };
    nodes.set(id, node);
    return node;
  };

  ['lrole-cajero', 'lrole-admin', 'luser-label', 'luser-slot', 'lerr', 'login-clock-time']
    .forEach(makeNode);
  const firstField = makeNode('luser');
  nodes.get('luser-slot').children.push(firstField);
  nodes.get('lrole-cajero').className = 'role-btn on';
  nodes.get('lrole-admin').className = 'role-btn';
  nodes.get('login-clock-time').innerHTML = '04<span>:</span>04';

  const context = {
    selRole: 'cajero',
    window: { _cachedUsers: [] },
    document: { getElementById: (id) => nodes.get(id) || null },
    h: (tag, attrs) => {
      const node = makeNode(attrs && attrs.id ? attrs.id : `${tag}-nuevo`);
      node.tag = tag;
      return node;
    },
    currentRole: () => context.selRole,
  };
  vm.runInNewContext(
    `${app.slice(from, to)}
     this.setLoginRole = setLoginRole;
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
  assert(!app.includes("onclick: () => { selRole = 'admin'; build(); }"),
    'el cambio de rol ya no reconstruye toda la pantalla de acceso');
  assert(app.includes('_startLoginClock();\n    document.getElementById(\'lpass\')?.focus();'),
    'el reloj arranca en el mismo cuadro en que se pinta el acceso');
}

console.log('✓ Experiencia transversal, recuperación, permisos y salud del sistema verificados');
