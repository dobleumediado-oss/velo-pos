'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  shouldUppercaseEntryControl,
  uppercaseEntryValue,
  normalizeUppercaseEntry,
  shouldFormatMoneyControl,
  formatMoneyEntryValue,
  unformatMoneyEntryValue,
  beginMoneyEntry,
  normalizeMoneyEntry,
  renderMoneyEntry,
  finishMoneyEntry,
} = require('../src/js/input-normalization');

function control(tagName, type = 'text', value = '', dataset = {}) {
  return {
    tagName, type, value, dataset,
    selectionStart: value.length,
    selectionEnd: value.length,
    classList: { contains: () => false },
    getAttribute: key => key === 'data-uppercase' ? dataset.uppercase : null,
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    select() {
      this.selectionStart = 0;
      this.selectionEnd = String(this.value ?? '').length;
    },
  };
}

assert.strictEqual(uppercaseEntryValue('José peña, srl'), 'JOSÉ PEÑA, SRL');

const name = control('INPUT', 'text', 'Arbaro Fuentes');
assert.strictEqual(normalizeUppercaseEntry(name), true);
assert.strictEqual(name.value, 'ARBARO FUENTES');
assert.strictEqual(name.selectionStart, 14);

const notes = control('TEXTAREA', '', 'entregar por la mañana');
assert.strictEqual(shouldUppercaseEntryControl(notes), true);
normalizeUppercaseEntry(notes);
assert.strictEqual(notes.value, 'ENTREGAR POR LA MAÑANA');

for (const type of ['email', 'password', 'url', 'search']) {
  const preserved = control('INPUT', type, 'MiDato@Ejemplo.com');
  assert.strictEqual(shouldUppercaseEntryControl(preserved), false);
  assert.strictEqual(normalizeUppercaseEntry(preserved), false);
  assert.strictEqual(preserved.value, 'MiDato@Ejemplo.com');
}

const explicit = control('INPUT', 'text', 'Mezcla', { uppercase: 'off' });
assert.strictEqual(shouldUppercaseEntryControl(explicit), false);

// Los motivos de auditoría son narrativos. Deben conservar la escritura del
// usuario y, sobre todo, no reescribirse durante una entrada remota o por IME.
const auditReason = control('TEXTAREA', '', 'Continuar desde el sistema anterior', { uppercase: 'off' });
assert.strictEqual(shouldUppercaseEntryControl(auditReason), false);
assert.strictEqual(normalizeUppercaseEntry(auditReason), false);
assert.strictEqual(auditReason.value, 'Continuar desde el sistema anterior');

const branchesSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'js', 'sucursales.js'),
  'utf8'
);
assert.match(
  branchesSource,
  /id="ncf-edit-reason"[^>]*data-uppercase="off"/,
  'El motivo fiscal debe quedar fuera de la reescritura en vivo para admitir teclado remoto/IME'
);

const dataSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'js', 'data.js'),
  'utf8'
);
const dataContext = vm.createContext({
  window: {},
  globalThis: {},
  console,
  setTimeout: () => 0,
});
vm.runInContext(dataSource, dataContext);

assert.strictEqual(
  vm.runInContext(
    `clientDocumentFilename(
      { name: 'ANA MARÍA PÉREZ SANTANA', customer_type: 'person' },
      'FCR-000003',
      'Factura'
    )`,
    dataContext
  ),
  'ANA-PEREZ-FCR-000003'
);
assert.strictEqual(
  vm.runInContext(
    `clientDocumentFilename(
      { name: 'ISMAGRIC GROUP SRL', trade_name: 'ISMAGRIC GROUP', customer_type: 'company' },
      'ABO-000005',
      'Abono'
    )`,
    dataContext
  ),
  'ISMAGRIC-GROUP-ABO-000005'
);

console.log('✓ Captura global en mayúsculas y nombres documentales validados');

assert.strictEqual(formatMoneyEntryValue('1000'), '1,000.00');
assert.strictEqual(formatMoneyEntryValue('50000'), '50,000.00');
assert.strictEqual(formatMoneyEntryValue('1234.5'), '1,234.50');
assert.strictEqual(unformatMoneyEntryValue('50,000.00'), '50000.00');
assert.strictEqual(unformatMoneyEntryValue('RD$ 1.350,50'), '1350.50');
assert.strictEqual(unformatMoneyEntryValue('1,350.50'), '1350.50');
assert.strictEqual(unformatMoneyEntryValue('1,350'), '1350');
assert.strictEqual(unformatMoneyEntryValue('1350.999'), '1350.99');
assert.strictEqual(unformatMoneyEntryValue('1350.999999,456'), '1350999999.45');

const price = control('INPUT', 'number', '1000');
price.id = 'pf-price';
assert.strictEqual(shouldFormatMoneyControl(price), true);
assert.strictEqual(beginMoneyEntry(price), true);
assert.strictEqual(price.type, 'text');
assert.strictEqual(price.value, '1,000.00');
price.value = '50,000.00';
price.selectionStart = 5;
price.selectionEnd = 5;
normalizeMoneyEntry(price);
assert.strictEqual(price.value, '50000.00');
assert.strictEqual(Number(price.value), 50000,
  'un monto activo debe seguir siendo legible por todos los cálculos de la aplicación');
renderMoneyEntry(price);
assert.strictEqual(price.value, '50,000.00',
  'después del cálculo el mismo monto debe volver a verse con miles y decimales');
normalizeMoneyEntry(price);
assert.strictEqual(price.value, '50000.00',
  'antes de guardar el formato visual debe volver a número puro');
finishMoneyEntry(price);
assert.strictEqual(price.type, 'number');
assert.strictEqual(price.value, '50000.00');

const entryListeners = {};
const pendingFrames = [];
const normalizationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'js', 'input-normalization.js'),
  'utf8'
);
const entryWindow = {
  requestAnimationFrame(callback) {
    pendingFrames.push(callback);
    return pendingFrames.length;
  },
};
const entryContext = vm.createContext({
  window: entryWindow,
  document: {
    addEventListener(type, callback, capture) {
      (entryListeners[type] ||= []).push({ callback, capture });
    },
  },
  setTimeout,
  console,
});
vm.runInContext(normalizationSource, entryContext, { filename: 'input-normalization.js' });
const liveAmount = control('INPUT', 'number', '0');
liveAmount.id = 'ab-amount';
entryListeners.focus[0].callback({ target: liveAmount });
liveAmount.value = '10,000.00';
liveAmount.selectionStart = liveAmount.value.length;
liveAmount.selectionEnd = liveAmount.value.length;
entryListeners.input[0].callback({ target: liveAmount });
assert.strictEqual(liveAmount.value, '10000.00',
  'durante el evento el cálculo debe recibir el número sin separadores');
assert.strictEqual(Number(liveAmount.value), 10000);
pendingFrames.shift()();
assert.strictEqual(liveAmount.value, '10,000.00',
  'antes de pintar se deben recuperar la coma de miles y los decimales');

function typeMoneyCharacter(control, character) {
  let prevented = false;
  entryListeners.beforeinput[0].callback({
    target: control,
    data: character,
    preventDefault() { prevented = true; },
  });
  if (!prevented) {
    const start = control.selectionStart;
    const end = control.selectionEnd;
    control.value = `${control.value.slice(0, start)}${character}${control.value.slice(end)}`;
    control.selectionStart = start + character.length;
    control.selectionEnd = control.selectionStart;
    entryListeners.input[0].callback({ target: control });
    assert.ok(!Number.isNaN(Number(control.value)),
      'cada cálculo intermedio debe recibir un número puro');
    pendingFrames.shift()();
  }
}

const easyAmount = control('INPUT', 'number', '8750');
easyAmount.id = 'ab-amount';
entryListeners.focus[0].callback({ target: easyAmount });
assert.deepStrictEqual([easyAmount.selectionStart, easyAmount.selectionEnd], [0, 8],
  'al entrar, el monto completo debe quedar seleccionado para reemplazarlo');
for (const digit of '1350') typeMoneyCharacter(easyAmount, digit);
assert.strictEqual(easyAmount.value, '1,350.00',
  'escribir solo 1350 debe mostrar automáticamente 1,350.00');
typeMoneyCharacter(easyAmount, ',');
typeMoneyCharacter(easyAmount, '5');
typeMoneyCharacter(easyAmount, '9');
assert.strictEqual(easyAmount.value, '1,350.59',
  'la coma o el punto deben permitir escribir centavos sin mover manualmente el cursor');
entryListeners.blur[0].callback({ target: easyAmount });
assert.strictEqual(easyAmount.type, 'number');
assert.strictEqual(easyAmount.value, '1350.59',
  'al guardar, la aplicación debe recibir el monto puro con dos decimales');

const quantity = control('INPUT', 'number', '1000');
quantity.id = 'pf-stock';
assert.strictEqual(shouldFormatMoneyControl(quantity), false);

const percent = control('INPUT', 'number', '18');
percent.id = 'pf-tax-pct';
assert.strictEqual(shouldFormatMoneyControl(percent), false);

const creditDays = control('INPUT', 'number', '30');
creditDays.id = 'cf-days';
creditDays.className = 'inp credito dias';
assert.strictEqual(shouldFormatMoneyControl(creditDays), false);

const bonus = control('INPUT', 'number', '2500', { nomBonus: '17' });
assert.strictEqual(shouldFormatMoneyControl(bonus), true);

const initialBalance = control('INPUT', 'number', '50000');
initialBalance.id = 'fa-bal';
assert.strictEqual(shouldFormatMoneyControl(initialBalance), true);

console.log('✓ Montos con miles y dos decimales validados durante la captura');

// Regresión: un campo de TEXTO cuyo label/nombre contiene una palabra
// monetaria (gasto, pago, devolución, transferencia, crédito, retiro…) NO debe
// tratarse como monto. Antes se clasificaba como money y filtraba las letras,
// dejando escribir "solo números" en conceptos, motivos, referencias y demás.
// Los montos reales son type="number"; un monto de texto debe optar con
// data-money="on".
function textFieldWithLabel(labelText, type = 'text', dataset = {}) {
  const c = control('INPUT', type, '', dataset);
  c.closest = () => ({ tagName: 'DIV', querySelector: () => ({ textContent: labelText }) });
  return c;
}

for (const label of [
  'Concepto del gasto',
  'Motivo de devolución',
  'Referencia de pago',
  'Titular de tarjeta',
  'Método de pago',
  'Banco / transferencia',
  'Motivo del retiro',
  'Nota de crédito',
  'Concepto de flete',
  'Observaciones del abono',
]) {
  const field = textFieldWithLabel(label);
  assert.strictEqual(
    shouldFormatMoneyControl(field),
    false,
    `El campo de texto "${label}" no debe bloquearse a solo números`
  );
}

// Un monto de texto explícito (data-money="on") sí se formatea, aunque el label
// no contenga palabra monetaria: el opt-in manda.
const explicitMoneyText = textFieldWithLabel('Valor personalizado', 'text', { money: 'on' });
assert.strictEqual(shouldFormatMoneyControl(explicitMoneyText), true);

// Y los montos reales (type="number") conservan el formato de miles.
const realAmount = textFieldWithLabel('Monto', 'number');
assert.strictEqual(shouldFormatMoneyControl(realAmount), true);

console.log('✓ Campos de texto con palabras monetarias aceptan letras (no solo números)');
