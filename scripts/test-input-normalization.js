'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  shouldUppercaseEntryControl,
  uppercaseEntryValue,
  normalizeUppercaseEntry,
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
