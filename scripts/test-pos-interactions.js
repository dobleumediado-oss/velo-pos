#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', disabled: false, style: {},
      focus() {}, select() {},
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        toggle(name, force) {
          if (force === undefined ? !classes.has(name) : force) classes.add(name);
          else classes.delete(name);
          return classes.has(name);
        },
        contains(name) { return classes.has(name); },
      },
    });
  }
  return elements.get(id);
};

const context = vm.createContext({
  console,
  Date,
  Intl,
  setTimeout,
  clearTimeout,
  AbortController,
  svg() { return ''; },
  toast() {},
  window: { api: { sync: { onChanged() {} } } },
  document: {
    getElementById(id) {
      if (id === 'inv-tabs') return null;
      return elements.get(id) || null;
    },
  },
});

const dataSource = fs.readFileSync(path.join(root, 'src/js/data.js'), 'utf8');
vm.runInContext(`${dataSource}\nthis.__posState={
  addInvoice,removeInvoice,resetInvoices,currentInv,renumberInvoices,
  setActive(v){activeInvoice=v},
  setUser(v){user=v},
  setTax(v){CFG.itbis=v},
  setCustomers(v){DB.customers=v},
  setProducts(v){DB.products=v},
  setPreventaConfig(enabled,roles){CFG.module_preventa=enabled;CFG.module_preventa_roles=roles},
  snapshot(){return {activeInvoice,invCounter,invoices:invoices.map(i=>({id:i.id,cart:[...i.cart]}))}}
};`, context, { filename: 'data.js' });

const state = context.__posState;
state.resetInvoices();
state.currentInv().cart.push({ name: 'Artículo', price: 105, qty: 1 });
state.removeInvoice(0);
assert.strictEqual(Array.from(state.snapshot().invoices, i => i.id).join(','), '1');
assert.strictEqual(state.currentInv().cart.length, 0, 'cerrar el único ticket debe limpiarlo');

state.addInvoice();
state.addInvoice();
state.setActive(1); // Mantener activa la #2 mientras se cierra la #1.
state.currentInv().cart.push({ marker: 'factura-activa' });
state.removeInvoice(0);
assert.strictEqual(state.currentInv().id, 1, 'las pestañas restantes deben renumerarse');
assert.strictEqual(state.currentInv().cart[0].marker, 'factura-activa',
  'cerrar una pestaña anterior debe conservar el carrito activo');
console.log('  ✓ cerrar el único ticket no crea automáticamente Factura #2');
console.log('  ✓ cerrar otra pestaña conserva el carrito activo y compacta los números');

state.resetInvoices();
state.addInvoice();                 // #1, #2
state.removeInvoice(1);             // queda #1
state.addInvoice();                 // reutiliza #2: #1, #2
assert.strictEqual(state.currentInv().id, 2, 'debe reutilizar el primer número disponible');
state.removeInvoice(0);             // queda la antigua #2, renumerada como #1
state.removeInvoice(0);             // se cerraron todas → permanece #1 limpia
assert.strictEqual(state.currentInv().id, 1, 'al cerrar todos los tickets debe volver a #1');
assert.strictEqual(state.snapshot().invCounter, 1, 'el contador debe reiniciarse con el ciclo');
state.addInvoice();
assert.strictEqual(state.currentInv().id, 2, 'después del reinicio el botón + debe crear #2');
console.log('  ✓ reutiliza números libres y al cerrar todos vuelve a Factura #1');

['pos-subtotal-value','pos-itbis-value','pos-discount-row','pos-discount-value',
 'pos-total-value','pos-charge-btn'].forEach(element);
state.resetInvoices();
state.setUser({ id: 1, role: 'admin' });
state.setTax(18);
state.currentInv().cart.push({ name: 'Artículo', price: 105, qty: 1, taxable: 1, tax_pct: 18 });

const posSource = fs.readFileSync(path.join(root, 'src/js/pos.js'), 'utf8');
vm.runInContext(`${posSource}\nlet __renderCartCalls=0;
renderCart=()=>{__renderCartCalls++};
this.__posDiscount={posDiscConPin,calcTotals,posSetQty,posCommitQty,renderCalls:()=>__renderCartCalls};
this.__posCustomers={pvCustomerMatches,pvCustomerOptions,pvFilterCustomers,pvSelectCustomer,posSelectCustomer,_setPosPmode};`,
context, { filename: 'pos.js' });
const discount = context.__posDiscount;
const customers = context.__posCustomers;
context.toast = () => {};

const pctInput = { value: '4' };
discount.posDiscConPin(pctInput, '4');
pctInput.value = '40';
discount.posDiscConPin(pctInput, '40');
assert.strictEqual(state.currentInv().disc, 40);
assert.strictEqual(discount.renderCalls(), 0, 'escribir descuento no debe reemplazar el carrito');
assert.strictEqual(elements.get('pos-total-value').textContent, 'RD$63.00');
console.log('  ✓ permite escribir 40% seguido sin perder el foco');

state.currentInv().discMode = 'amt';
state.currentInv().disc = 0;
state.currentInv().discAmtInput = 0;
const amountInput = { value: '4' };
discount.posDiscConPin(amountInput, '4');
amountInput.value = '40';
discount.posDiscConPin(amountInput, '40');
assert.strictEqual(state.currentInv().discAmtInput, 40);
assert.strictEqual(discount.renderCalls(), 0, 'escribir RD$ no debe reemplazar el carrito');
assert.strictEqual(elements.get('pos-total-value').textContent, 'RD$65.00');
console.log('  ✓ permite escribir RD$40 seguido sin perder el foco');

state.setProducts([{ id: 100, price: 10, wholesale: 9, stock: 100, active: 1 }]);
state.currentInv().discMode = 'pct';
state.currentInv().disc = 0;
state.currentInv().cart = [{ pid:100, product_id:100, name:'Cantidad', price:10, qty:1, taxable:0 }];
const qtyInput = { value:'4' };
discount.posSetQty(0, qtyInput);
qtyInput.value = '40';
discount.posSetQty(0, qtyInput);
assert.strictEqual(state.currentInv().cart[0].qty, 40);
assert.strictEqual(discount.renderCalls(), 0, 'escribir cantidad no debe reemplazar el campo activo');
qtyInput.value = '';
discount.posSetQty(0, qtyInput);
assert.strictEqual(state.currentInv().cart[0].qty, 40, 'vaciar temporalmente no debe forzar cantidad 1');
discount.posCommitQty(0, qtyInput);
assert.strictEqual(qtyInput.value, 40, 'al salir de un campo vacío restaura la última cantidad válida');
console.log('  ✓ permite escribir cantidades de varios dígitos sin perder el foco');

state.setCustomers([
  { id: 1, name: 'Consumidor Final', active: 1 },
  { id: 7, name: 'José Peña', rnc: '1-31-45678-9', phone: '809-555-0182', email: 'ventas@pena.do', active: 1 },
  { id: 9, name: 'Motores del Caribe, SRL', trade_name: 'MotoCaribe', customer_type: 'company',
    rnc: '130123456', preferred_price_mode: 'wholesale', active: 1,
    contacts:[{ id:91, name:'Ana Pérez', role:'Compras', phone:'809-555-2000', document:'00100000001', active:1 }] },
  { id: 8, name: 'Cliente inactivo', rnc: '101010101', phone: '8090000000', active: 0 },
]);
assert(customers.pvCustomerMatches({ id: 7, name: 'José Peña', active: 1 }, 'jose pena'),
  'la búsqueda debe ignorar tildes');
assert(customers.pvCustomerMatches({ id: 7, name: 'José Peña', rnc: '1-31-45678-9', active: 1 }, '131456789'),
  'la búsqueda debe ignorar guiones del RNC');
assert(customers.pvCustomerMatches({ id: 7, name: 'José Peña', phone: '809-555-0182', active: 1 }, '5550182'),
  'la búsqueda debe aceptar fragmentos del teléfono');
const representativeResult = customers.pvCustomerOptions('ana perez')[0];
assert.strictEqual(representativeResult.customer.id, 9,
  'buscar un representante debe resolver la empresa vinculada');
assert.strictEqual(representativeResult.contact.id, 91,
  'la opción debe conservar el representante seleccionado');

['pv-customer-search', 'pv-customer-rnc', 'pv-customer-dd', 'pv-customer-selected'].forEach(element);
state.currentInv().cliId = 1;
customers.pvSelectCustomer(7);
assert.strictEqual(state.currentInv().cliId, 7, 'debe vincular el ID del cliente registrado');
assert.strictEqual(elements.get('pv-customer-search').value, 'José Peña');
assert.strictEqual(elements.get('pv-customer-rnc').value, '1-31-45678-9');
customers.pvFilterCustomers('María nueva');
assert.strictEqual(state.currentInv().cliId, 1,
  'editar el nombre debe descartar el ID del cliente seleccionado anteriormente');
assert.strictEqual(elements.get('pv-customer-rnc').value, '',
  'editar el nombre debe limpiar el documento del cliente anterior');
customers.pvSelectCustomer(1);
assert.strictEqual(elements.get('pv-customer-search').value, 'Consumidor Final');
customers.pvSelectCustomer(9, 91);
assert.strictEqual(state.currentInv().cliId, 9, 'el POS vincula la cuenta empresarial');
assert.strictEqual(state.currentInv().cliContactId, 91, 'el POS vincula el representante');
assert.strictEqual(state.currentInv().pmode, 'wholesale', 'aplica el precio preferido de la empresa');
console.log('  ✓ busca clientes por nombre, RNC o teléfono y vincula el registro correcto');
console.log('  ✓ busca representantes y usa la cuenta, contacto y precio de su empresa');
console.log('  ✓ evita mezclar el ID de un cliente con el nombre o RNC de otro');

['pos-customer-search', 'pos-customer-dd', 'pos-customer-state'].forEach(element);
state.setProducts([{ id:100, price:118, wholesale:100, active:1 }]);
state.currentInv().cart = [{ pid:100, product_id:100, price:118, unit_price:118, qty:1, manual_price:false }];
customers.posSelectCustomer(9, 91);
assert.strictEqual(state.currentInv().cart[0].price, 100,
  'elegir una empresa mayorista debe recalcular los artículos no modificados');
customers.posSelectCustomer(7);
assert.strictEqual(state.currentInv().pmode, 'retail',
  'elegir un cliente de detalle debe salir del modo mayorista');
assert.strictEqual(state.currentInv().cart[0].price, 118,
  'volver a precio detalle debe recalcular el carrito');
state.currentInv().cart[0].manual_price = true;
state.currentInv().cart[0].price = 111;
customers.posSelectCustomer(9, 91);
assert.strictEqual(state.currentInv().cart[0].price, 111,
  'el precio elegido manualmente no debe ser sobrescrito por el cliente');
console.log('  ✓ el selector principal aplica detalle/mayorista y respeta precios manuales');

context.__sidebarRenderCalls = 0;
context.buildSidebar = () => { context.__sidebarRenderCalls += 1; };
const preventaSource = fs.readFileSync(path.join(root, 'src/js/preventa.js'), 'utf8');
vm.runInContext(`${preventaSource}\nthis.__preventaBadge={_pvSetPendingCount,preventaCanAccess,_pvRowsForView,_pvMatchesSearch,_pvElapsed};`, context, { filename: 'preventa.js' });
context.window._preventaPendingCount = 1;
context.__preventaBadge._pvSetPendingCount(0);
assert.strictEqual(context.window._preventaPendingCount, 0,
  'cancelar la última orden debe poner el badge en cero');
assert.strictEqual(context.__sidebarRenderCalls, 1,
  'cambiar el contador debe reconstruir el menú lateral');
context.__preventaBadge._pvSetPendingCount(0);
assert.strictEqual(context.__sidebarRenderCalls, 1,
  'un contador sin cambios no debe repintar el menú');
console.log('  ✓ al cancelar la última orden desaparece la notificación del menú');

state.setUser({ id: 1, role: 'admin' });
state.setPreventaConfig('1', 'admin,cajero');
assert.strictEqual(context.__preventaBadge.preventaCanAccess(), true,
  'administrador autorizado debe poder abrir preventa');
state.setPreventaConfig('1', 'cajero');
assert.strictEqual(context.__preventaBadge.preventaCanAccess(), false,
  'quitar el rol administrador debe bloquear su acceso');
state.setUser({ id: 99, role: 'superadmin' });
assert.strictEqual(context.__preventaBadge.preventaCanAccess(), true,
  'superadmin conserva acceso cuando el módulo está activo');
state.setPreventaConfig('0', 'admin,cajero');
assert.strictEqual(context.__preventaBadge.preventaCanAccess(), false,
  'desactivar el módulo debe bloquearlo para todos');
console.log('  ✓ activación y permisos por rol controlan el acceso a Preventa');

const flowRows = [
  { id: 1, status: 'pending', number: 'OC-000001', customer_name: 'José Peña', customer_rnc: '1-31-45678-9', items_summary: 'Filtro x1' },
  { id: 2, status: 'paid', number: 'OC-000002', customer_name: 'María Soto', items_summary: 'Aceite x2' },
  { id: 3, status: 'dispatched', number: 'OC-000003', customer_name: 'Carlos Ruiz' },
  { id: 4, status: 'cancelled', number: 'OC-000004', customer_name: 'Ana Díaz' },
];
assert.strictEqual(context.__preventaBadge._pvRowsForView(flowRows, 'cashier').length, 1);
assert.strictEqual(context.__preventaBadge._pvRowsForView(flowRows, 'dispatch').length, 1);
assert.strictEqual(context.__preventaBadge._pvRowsForView(flowRows, 'history').length, 2);
assert(context.__preventaBadge._pvMatchesSearch(flowRows[0], 'jose pena'),
  'la cola debe buscar nombres ignorando tildes');
assert(context.__preventaBadge._pvMatchesSearch(flowRows[0], '131456789'),
  'la cola debe buscar documentos ignorando guiones');
console.log('  ✓ separa automáticamente las colas de caja, entrega e historial');
console.log('  ✓ búsqueda operativa encuentra orden, cliente, documento y artículos');

console.log('\nInteracciones del POS verificadas correctamente.');
