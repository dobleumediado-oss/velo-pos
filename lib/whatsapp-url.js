'use strict';

function normalizeWhatsAppPhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 15) {
    throw new Error('Número de WhatsApp inválido');
  }
  return phone;
}

function buildWhatsAppUrls({ phone, message = '' } = {}) {
  const normalized = normalizeWhatsAppPhone(phone);
  const text = encodeURIComponent(String(message || '').slice(0, 4000));
  return {
    phone: normalized,
    appUrl: `whatsapp://send?phone=${normalized}&text=${text}`,
    webUrl: `https://wa.me/${normalized}?text=${text}`,
  };
}

module.exports = { normalizeWhatsAppPhone, buildWhatsAppUrls };
