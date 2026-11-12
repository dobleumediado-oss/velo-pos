'use strict';

const { round2 } = require('./money');

const TYPES = new Set(['E31', 'E32']);
const TERMINAL_STATES = new Set(['Aceptado', 'Aceptado Condicional', 'Rechazado', 'Anulado']);
const PROVIDER_STATES = new Set([...TERMINAL_STATES, 'En Cola', 'Enviado a la DGII', 'En Proceso', 'Error', 'No encontrado']);
const numberPattern = /^E(?:31|32)\d{10}$/;

function dateFiscal(value) {
  const date = String(value || '').slice(0, 10);
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('La fecha fiscal debe ser válida.');
  }
  return date.split('-').reverse().join('-');
}

function rangeInput({ from, to, expiry, environment }) {
  from = String(from || '').trim().toUpperCase();
  to = String(to || '').trim().toUpperCase();
  expiry = String(expiry || '').trim();
  const type = from.slice(0, 3);
  if (!numberPattern.test(from) || !numberPattern.test(to) || to.slice(0, 3) !== type ||
      Number(from.slice(3)) === 0 || from > to) {
    throw new Error('Indica un rango válido de e-NCF completos del mismo tipo (E31 o E32).');
  }
  dateFiscal(expiry);
  return { type, from, to, expiry: expiry.slice(0, 10), environment };
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildDocument({ ncf, expiry, date, dueDate, sale, items, charges, issuer }) {
  if (!numberPattern.test(ncf)) throw new Error('La venta requiere un e-NCF E31 o E32 válido.');
  const type = ncf.slice(1, 3);
  const buyer = digits(sale.customer_rnc);
  const credit = sale.payment_method === 'credito';
  if (!/^\d{9}$/.test(digits(issuer.rnc)) || !issuer.name || !issuer.address ||
      !/^0[1-6]$/.test(issuer.incomeType || '')) {
    throw new Error('Completa el RNC, nombre, dirección y tipo de ingresos del emisor.');
  }
  if ((type === '31' && (!/^\d{9}$/.test(buyer) || !sale.customer_name)) ||
      (type === '32' && sale.total >= 250000 && (!/^\d{9}(?:\d{2})?$/.test(buyer) || !sale.customer_name))) {
    throw new Error('Completa el documento fiscal y el nombre del comprador para este e-CF.');
  }
  if (credit && (!dueDate || dueDate < date)) throw new Error('Indica una fecha límite de pago válida.');
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const rows = [
    ...items,
    ...charges.map(row => ({
      ...row, product_name: row.description, qty: 1, unit_price: row.amount, _nonStock: true,
    })),
  ].map((row, index) => {
    const indicator = ({ 18: 1, 16: 2, 0: row.taxable ? 3 : 4 })[row.tax_pct];
    if (!indicator || !Number.isFinite(Number(row.qty)) || Number(row.qty) <= 0 ||
        !Number.isFinite(row.net_subtotal) || row.net_subtotal < 0) {
      throw new Error('Hay una línea con cantidad, importe o tasa de ITBIS incompatible con el e-CF.');
    }
    const divisor = 1 + row.tax_pct / 100;
    const unit = Number((row.unit_price / divisor).toFixed(4));
    const base = round2(unit * row.qty);
    const net = row.net_subtotal;
    const discount = round2(base - net);
    // Los precios de Velo incluyen ITBIS. La diferencia de un centavo puede
    // salir del prorrateo por cantidad y se absorbe en el precio neto unitario.
    const adjustedUnit = discount < 0 ? Number((net / row.qty).toFixed(4)) : unit;
    const line = {
      NumeroLinea: index + 1,
      IndicadorFacturacion: indicator,
      NombreItem: String(row.product_name || '').trim().slice(0, 80),
      IndicadorBienoServicio: row._nonStock ? 2 : 1,
      CantidadItem: Number(row.qty),
      PrecioUnitarioItem: adjustedUnit,
      MontoItem: net,
    };
    if (discount > 0) {
      line.DescuentoMonto = discount;
      line.TablaSubDescuento = { SubDescuento: [{ TipoSubDescuento: '$', MontoSubDescuento: discount }] };
    }
    buckets[indicator] += net;
    return line;
  });
  const base = round2(buckets[1] + buckets[2] + buckets[3]);
  const totals = { MontoTotal: sale.total };
  if (base || rows.some(row => row.IndicadorFacturacion !== 4)) totals.MontoGravadoTotal = base;
  const groups = [[1, 18], [2, 16], [3, 0]];
  for (const [indicator, rate] of groups) {
    if (rows.some(row => row.IndicadorFacturacion === indicator)) {
      totals['MontoGravadoI' + indicator] = round2(buckets[indicator]);
      totals['ITBIS' + indicator] = rate;
      totals['TotalITBIS' + indicator] = round2(buckets[indicator] * rate / 100);
    }
  }
  if (rows.some(row => row.IndicadorFacturacion === 4)) totals.MontoExento = round2(buckets[4]);
  const tax = round2(groups.reduce((sum, [indicator]) => sum + (totals['TotalITBIS' + indicator] || 0), 0));
  if (totals.MontoGravadoTotal !== undefined) totals.TotalITBIS = tax;
  // DGII admite tolerancia de redondeo, pero la factura debe representar el
  // mismo importe que quedó cobrado en Velo.
  if (!rows.length || sale.total <= 0 || Math.abs(round2(tax - sale.tax_amt)) > 0.02 ||
      Math.abs(round2(base + buckets[4] + tax - sale.total)) > 0.02) {
    throw new Error('El detalle fiscal y el total de la venta no cuadran. Revisa precios, descuentos e ITBIS.');
  }
  const IdDoc = {
    TipoeCF: Number(type),
    eNCF: ncf,
    IndicadorMontoGravado: 0,
    TipoIngresos: issuer.incomeType,
    TipoPago: credit ? 2 : 1,
  };
  if (type === '31') IdDoc.FechaVencimientoSecuencia = dateFiscal(expiry);
  if (credit) IdDoc.FechaLimitePago = dateFiscal(dueDate);
  const Encabezado = {
    Version: '1.0',
    IdDoc,
    Emisor: {
      RNCEmisor: digits(issuer.rnc),
      RazonSocialEmisor: issuer.name.slice(0, 150),
      DireccionEmisor: issuer.address.slice(0, 100),
      FechaEmision: dateFiscal(date),
    },
  };
  if (/^\d{9}(?:\d{2})?$/.test(buyer) && sale.customer_name) {
    Encabezado.Comprador = {
      RNCComprador: buyer,
      RazonSocialComprador: sale.customer_name.slice(0, 150),
    };
  }
  Encabezado.Totales = totals;
  return { ECF: { Encabezado, DetallesItems: { Item: rows } } };
}

function providerResult(data, ncf, issuer) {
  if ((data?.ncf || data?.ecf || data?.eCF) !== ncf) {
    throw new Error('MSeller no confirmó el mismo e-NCF. Consulta su estado antes de reenviar.');
  }
  const resultIssuer = data.rnc || data.customerId;
  if (issuer && resultIssuer && digits(resultIssuer) !== issuer) {
    throw new Error('MSeller devolvió un comprobante de otro emisor.');
  }
  const qr = String(data.qr_url || '');
  const code = String(data.securityCode || '');
  const safeQr = qr.length <= 1024 && /^https:\/\/(ecf|fc)\.dgii\.gov\.do\//i.test(qr) ? qr : '';
  const signedDate = data.signedDate || (safeQr && [...new URL(safeQr).searchParams]
    .find(([key]) => key.toLowerCase() === 'fechafirma')?.[1]) || '';
  return {
    status: PROVIDER_STATES.has(data.status) ? data.status : 'Enviado',
    qr: safeQr,
    code: /^[A-Za-z0-9+/]{6}$/.test(code) ? code : '',
    signedDate: /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(signedDate) ? signedDate : '',
  };
}

module.exports = { TYPES, TERMINAL_STATES, numberPattern, rangeInput, buildDocument, providerResult };
