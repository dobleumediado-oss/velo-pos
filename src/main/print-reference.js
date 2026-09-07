'use strict';

function _positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function validateLocalPrintReference(db, payload = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('No se pudo consultar la base de datos activa para imprimir');
  }

  const userId = _positiveId(payload.userId);
  if (payload.userId != null && !userId) {
    throw new Error('Usuario no válido para imprimir');
  }
  if (userId) {
    const user = db.prepare('SELECT active FROM users WHERE id=?').get(userId);
    if (!user || Number(user.active) === 0) {
      throw new Error('Usuario no válido para imprimir');
    }
  }

  const jobType = String(payload.jobType || '').trim().toLowerCase();
  const referenceId = _positiveId(payload.referenceId);
  if (jobType === 'abono') {
    if (!referenceId) throw new Error('El abono ya no existe');
    const payment = db.prepare(
      'SELECT status,document_number_fmt FROM payments WHERE id=?'
    ).get(referenceId);
    if (!payment) throw new Error('El abono ya no existe');
    if (String(payment.status || 'active').toLowerCase() !== 'active') {
      throw new Error(
        `El abono ${payment.document_number_fmt || '#' + referenceId} está anulado y no puede reimprimirse como vigente`
      );
    }
    return {
      valid: true,
      jobType,
      referenceId,
      documentNumber: payment.document_number_fmt || '',
    };
  }

  return { valid: true, jobType, referenceId };
}

async function validatePrintReferenceForMode({ mode, forwardToServer, getDB, payload } = {}) {
  if (mode === 'client') {
    if (typeof forwardToServer !== 'function') {
      throw new Error('No se pudo validar el documento con el servidor');
    }
    // La impresora sigue siendo local, pero el documento pertenece a la base
    // central. Consultarlo allí evita falsos "ya no existe" en las terminales.
    return await forwardToServer('print:validateReference', payload || {});
  }
  return validateLocalPrintReference(getDB(), payload || {});
}

module.exports = {
  validateLocalPrintReference,
  validatePrintReferenceForMode,
};
