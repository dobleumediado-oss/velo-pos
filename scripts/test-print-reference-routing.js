#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  validateLocalPrintReference,
  validatePrintReferenceForMode,
} = require('../src/main/print-reference');

function fixture({ withPayment = false, status = 'active' } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, active INTEGER NOT NULL);
    CREATE TABLE payments(
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      document_number_fmt TEXT DEFAULT ''
    );
    INSERT INTO users(id,active) VALUES(9,1),(10,0);
  `);
  if (withPayment) {
    db.prepare('INSERT INTO payments(id,status,document_number_fmt) VALUES(?,?,?)')
      .run(501, status, 'ABO-000501');
  }
  return db;
}

(async () => {
  const auxiliaryDb = fixture();
  const centralDb = fixture({ withPayment: true });

  assert.throws(
    () => validateLocalPrintReference(auxiliaryDb, { jobType: 'abono', referenceId: 501, userId: 9 }),
    /El abono ya no existe/,
    'la base auxiliar reproduce el falso negativo observado en la terminal'
  );

  let routedChannel = '';
  const result = await validatePrintReferenceForMode({
    mode: 'client',
    getDB: () => auxiliaryDb,
    payload: { jobType: 'abono', referenceId: 501, userId: 9 },
    forwardToServer: async (channel, payload) => {
      routedChannel = channel;
      return validateLocalPrintReference(centralDb, payload);
    },
  });
  assert.strictEqual(routedChannel, 'print:validateReference');
  assert.strictEqual(result.documentNumber, 'ABO-000501');

  const voidedDb = fixture({ withPayment: true, status: 'voided' });
  assert.throws(
    () => validateLocalPrintReference(voidedDb, { jobType: 'abono', referenceId: 501, userId: 9 }),
    /está anulado/,
    'un abono anulado continúa bloqueado por la base central'
  );
  assert.throws(
    () => validateLocalPrintReference(centralDb, { jobType: 'abono', referenceId: 501, userId: 10 }),
    /Usuario no válido/,
    'un usuario inactivo continúa sin autorización de impresión'
  );

  auxiliaryDb.close();
  centralDb.close();
  voidedDb.close();
  console.log('✓ La impresión local valida abonos contra el negocio central');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
