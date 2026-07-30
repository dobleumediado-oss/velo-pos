'use strict';

/**
 * Canoniza teléfonos de clientes para WhatsApp en República Dominicana.
 *
 * - 8095550000   → 18095550000
 * - +1 809...    → 18095550000
 * - 18095550000  → 18095550000
 * - "1" solo     → vacío (es únicamente el prefijo inicial del formulario)
 *
 * Los números de otras longitudes se conservan limpios para no impedir flotas
 * o contactos internacionales; WhatsApp hará su validación al abrir el chat.
 */
function normalizeCustomerPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits || digits === '1') return '';
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return raw;
}

function whatsappPhoneDigits(value) {
  const normalized = normalizeCustomerPhone(value);
  const digits = String(normalized || '').replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

module.exports = { normalizeCustomerPhone, whatsappPhoneDigits };
