// Etiquetas de producto en ZPL nativo (Zebra LP 2824 Plus y compatibles): la
// misma etiqueta de _bcBuildLabelMarkup (columna centrada con nombre, marca,
// código de barras Code 128, código, precio y texto libre), dibujada por la
// impresora a su resolución real, como Zebra Designer. Copia en JavaScript de
// cloud/apps/web/src/lib/zpl-labels.ts: mantener ambas iguales.


// Texto de campo con ^FH_: ^, ~, _ y las letras con tilde o ñ viajan como
// bytes UTF-8 en hexadecimal (_5E, _C3_B1…), así el trabajo es ASCII puro.
const hexByte = (byte) => `_${byte.toString(16).toUpperCase().padStart(2, '0')}`;
const fieldText = (value, max = 60) => Array.from(String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max))
  .map(char => /[\x20-\x7e]/.test(char) && !/[_^~]/.test(char) ? char : Array.from(new TextEncoder().encode(char), hexByte).join(''))
  .join('');
// Code 128 automático: arranque, verificación y parada suman unas 35 barras.
const code128Modules = (value) => 35 + 11 * String(value).length;

function zplProductLabels(items, design) {
  const dpmm = Number(design.dpi) === 300 ? 12 : 8;
  const w = Math.round(Math.max(20, Math.min(110, design.widthMm)) * dpmm);
  const h = Math.round(Math.max(10, Math.min(300, design.heightMm)) * dpmm);
  const margin = Math.round(1.5 * dpmm);
  const inner = w - margin * 2;
  // Alturas proporcionales al alto de la etiqueta (28 mm a 203 DPI = 224 puntos).
  const nameH = Math.max(18, Math.round(h * 0.11));
  const brandH = Math.max(14, Math.round(h * 0.08));
  const codeH = Math.max(14, Math.round(h * 0.08));
  const priceH = Math.max(22, Math.round(h * 0.15));
  const customH = Math.max(14, Math.round(h * 0.08));
  const gap = Math.round(0.6 * dpmm);
  return items.map(item => {
    const barcodeValue = String(item.barcode || item.code || '').replace(/[^\x20-\x7e]/g, '').slice(0, 40);
    const blocks = [];
    const text = (value, height, max) => blocks.push({ height,
      zpl: y => `^FO${margin},${y}^A0N,${height},${height}^FB${inner},1,0,C,0^FH_^FD${fieldText(value, max)}^FS` });
    if (design.showName !== false && item.name) text(item.name, nameH);
    if (design.showBrand && item.brand) text(item.brand, brandH);
    if (design.showBarcode !== false && barcodeValue) {
      const module = code128Modules(barcodeValue) * 2 <= inner ? 2 : 1;
      const width = code128Modules(barcodeValue) * module;
      const barH = Math.max(28, Math.round(h * 0.26));
      const x = margin + Math.max(0, Math.round((inner - width) / 2));
      // Línea de lectura debajo de las barras, como JsBarcode en el Desktop.
      blocks.push({ height: barH + codeH + 4, zpl: y => `^FO${x},${y}^BY${module},2.5,${barH}^BCN,${barH},N,N,N^FD${fieldText(barcodeValue, 40)}^FS`
        + `^FO${margin},${y + barH + 4}^A0N,${codeH},${codeH}^FB${inner},1,0,C,0^FH_^FD${fieldText(barcodeValue, 40)}^FS` });
    }
    if (design.showCode && item.code && item.code !== barcodeValue) text(item.code, codeH);
    if (design.showPrice && item.price) text(item.price, priceH, 24);
    if (design.customText) text(design.customText, customH);
    // Bloques centrados en vertical, como justify-content:center del Desktop.
    const total = blocks.reduce((sum, block) => sum + block.height, 0) + gap * Math.max(0, blocks.length - 1);
    let y = Math.max(margin, Math.round((h - total) / 2));
    const body = blocks.map(block => { const out = block.zpl(y); y += block.height + gap; return out; }).join('');
    const quantity = Math.max(1, Math.min(999, Math.round(Number(item.quantity) || 1)));
    return `^XA^CI28^PW${w}^LL${h}^LS0${body}^PQ${quantity},0,1,Y^XZ`;
  }).join('\n');
}

// Etiquetadoras que entienden ZPL (mismo criterio que VELO Bridge).
function isZebraPrinter(name) {
  return /zebra|zdesigner|\blp ?28\d\d|\btlp ?28\d\d|\bgk42\d|\bgx42\d|\bzd\d{3}|\bgc420/i.test(String(name || ''));
}

// Etiqueta del equipo en servicio técnico (mismos datos que la etiqueta HTML
// de la orden): número grande, cliente, teléfono, equipo, IMEI/serial,
// contraseña si se escribió y, tras una línea, la falla en hasta dos líneas.
// Las letras se reducen solas si la etiqueta es pequeña (52 × 28 mm cabe).
function zplServiceLabel(label, size) {
  const dpmm = Number(size.dpi) === 300 ? 12 : 8;
  const w = Math.round(Math.max(20, Math.min(110, size.widthMm)) * dpmm);
  const h = Math.round(Math.max(10, Math.min(300, size.heightMm)) * dpmm);
  const margin = Math.round(1.5 * dpmm);
  const inner = w - margin * 2;
  const rows = [
    `Cliente: ${label.customerName}`, `Tel: ${label.customerPhone || '-'}`, `Equipo: ${label.deviceDescription}`,
    `IMEI/Serial: ${label.identifier || '-'}`, ...(label.password ? [`Contraseña: ${label.password}`] : []),
  ];
  // Alto disponible repartido: número (1,6 líneas), filas, línea y falla (2 líneas).
  const units = 1.6 + rows.length + 2;
  const gap = Math.max(2, Math.round(0.35 * dpmm));
  const line = Math.max(14, Math.min(Math.round(3.2 * dpmm), Math.floor((h - margin * 2 - gap * (rows.length + 3)) / units)));
  const big = Math.round(line * 1.6);
  let y = margin;
  let body = `^FO${margin},${y}^A0N,${big},${big}^FB${inner},1,0,L,0^FH_^FD${fieldText(label.number, 30)}^FS`;
  y += big + gap;
  for (const row of rows) { body += `^FO${margin},${y}^A0N,${line},${line}^FB${inner},1,0,L,0^FH_^FD${fieldText(row, 48)}^FS`; y += line + gap; }
  body += `^FO${margin},${y}^GB${inner},2,2^FS`;
  y += 2 + gap;
  body += `^FO${margin},${y}^A0N,${line},${line}^FB${inner},2,0,L,0^FH_^FDFalla: ${fieldText(label.problem, 90)}^FS`;
  return `^XA^CI28^PW${w}^LL${h}^LS0${body}^PQ1,0,1,Y^XZ`;
}

if (typeof module !== 'undefined') module.exports = { zplProductLabels, zplServiceLabel, isZebraPrinter };
