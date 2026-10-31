#!/usr/bin/env node
'use strict';
// Configuración del sistema → «Escritura en MAYÚSCULAS» (text_uppercase).
// Activada (por defecto) todo se guarda en mayúsculas, como siempre; apagada se
// respeta lo escrito y solo los códigos siguen en mayúsculas. Lo ya guardado no
// se reescribe al apagarla.
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = path.join(os.tmpdir(), `velo_textcase_${Date.now()}`);
const DB = require('../database');
DB.initDB(tempDir);
const db = DB.getDB();
require('../versioning').initVersioning(db, tempDir);

// Crea el cliente por el repositorio (como la pantalla) y devuelve su id.
const customer = name => { DB.customersRepo.create({ customer_type: 'person', name, phone: '809-555-0000' }); return db.prepare('SELECT MAX(id) AS id FROM customers').get().id; };
const customerName = id => db.prepare('SELECT name FROM customers WHERE id=?').get(id).name;
const insertProduct = (code, name) => db.prepare("INSERT INTO products (code, name, price, cost, stock) VALUES (?,?,1,1,0)").run(code, name).lastInsertRowid;
const product = id => db.prepare('SELECT code, name FROM products WHERE id=?').get(id);

// Por defecto: como hasta ahora.
const joseId = customer('José Pérez');
assert.strictEqual(customerName(joseId), 'JOSÉ PÉREZ');
console.log('  ✓ por defecto se guarda en MAYÚSCULAS');

// Apagada: se respeta lo escrito; los códigos siguen en mayúsculas.
DB.settingsRepo.set('text_uppercase', '0');
DB.ensureUppercasePersistence(false);
const mariaId = customer('María Gómez');
assert.strictEqual(customerName(mariaId), 'María Gómez');
assert.strictEqual(customerName(joseId), 'JOSÉ PÉREZ', 'lo ya guardado no cambia');
const filtro = insertProduct('flt-001', 'Filtro de aceite');
assert.deepStrictEqual({ ...product(filtro) }, { code: 'FLT-001', name: 'Filtro de aceite' });
db.prepare("UPDATE products SET name='Filtro de aire', code='flt-002' WHERE id=?").run(filtro);
assert.deepStrictEqual({ ...product(filtro) }, { code: 'FLT-002', name: 'Filtro de aire' });
console.log('  ✓ apagada: se guarda como se escribe y los códigos siguen en mayúsculas');

// Al reiniciar con la casilla apagada no se reescribe nada.
DB.ensureUppercasePersistence();
assert.strictEqual(customerName(mariaId), 'María Gómez');
console.log('  ✓ al reiniciar con la casilla apagada no se reescribe lo guardado');

// Volver a activarla: lo escrito en minúsculas pasa a mayúsculas (avisado en pantalla).
DB.settingsRepo.set('text_uppercase', '1');
DB.ensureUppercasePersistence(true);
assert.strictEqual(customerName(mariaId), 'MARÍA GÓMEZ');
assert.strictEqual(product(filtro).name, 'FILTRO DE AIRE');
console.log('  ✓ al reactivarla todo vuelve a MAYÚSCULAS');

// Pantalla: los campos de código siempre en mayúsculas; el resto según la casilla.
const input = require('../src/js/input-normalization');
const control = (dataset = {}) => ({ tagName: 'INPUT', type: 'text', dataset, classList: { contains: () => false }, getAttribute: key => key === 'data-uppercase' ? dataset.uppercase : null });
global.DB = { settings: { text_uppercase: '0' } };
assert.strictEqual(input.uppercaseEnabled(), false);
assert.strictEqual(input.shouldUppercaseEntryControl(control()), false);
assert.strictEqual(input.shouldUppercaseEntryControl(control({ uppercase: 'always' })), true);
global.DB = { settings: { text_uppercase: '1' } };
assert.strictEqual(input.shouldUppercaseEntryControl(control()), true);
global.DB = { settings: {} };
assert.strictEqual(input.uppercaseEnabled(), true, 'sin ajuste guardado: activada');
console.log('  ✓ pantalla: la casilla manda; los códigos siempre en mayúsculas');
