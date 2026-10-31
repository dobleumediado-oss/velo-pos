// Generado por cloud/scripts/sync-desktop-zpl.mjs desde apps/web/src/lib/zpl-labels.ts. No editar a mano.
(function (root) {
// Etiquetas en ZPL nativo (Zebra LP 2824 Plus y compatibles) y su vista previa.
// Un solo plano por etiqueta (labelLayout / serviceLabelLayout) produce dos
// salidas: el ZPL que VELO Bridge entrega a la Zebra y el SVG de la vista
// previa, así lo que se ve en pantalla es lo que sale impreso. La impresora
// dibuja texto y barras a su resolución real, como Zebra Designer. El Desktop
// usa una copia exacta de este archivo (src/js/zpl-labels.js).
// Texto de campo con ^FH_: ^, ~, _ y las letras con tilde o ñ viajan como
// bytes UTF-8 en hexadecimal (_5E, _C3_B1…), así el trabajo es ASCII puro.
const hexByte = (byte) => `_${byte.toString(16).toUpperCase().padStart(2, '0')}`;
const fieldText = (value) => Array.from(value)
    .map(char => /[\x20-\x7e]/.test(char) && !/[_^~]/.test(char) ? char : Array.from(new TextEncoder().encode(char), hexByte).join(''))
    .join('');
const cleanText = (value, max = 60) => Array.from(String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()).slice(0, max).join('');
// Code 128 B: arranque, verificación y parada suman 35 barras más 11 por carácter.
const code128Modules = (value) => 35 + 11 * String(value).length;
const cleanBarcode = (value) => String(value ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 40);
// Ancho medio de la letra 0 de Zebra (Triumvirate condensada) respecto a su alto.
const CHAR_RATIO = 0.5;
const dotsPerMm = (dpi) => Number(dpi) === 300 ? 12 : 8;
const labelSize = (design) => {
    const dpmm = dotsPerMm(design.dpi);
    return { dpmm, w: Math.round(Math.max(20, Math.min(110, design.widthMm)) * dpmm), h: Math.round(Math.max(10, Math.min(300, design.heightMm)) * dpmm) };
};
// Una línea de texto que cabe en el ancho: primero se estrecha la letra (hasta
// 55 % de su alto) y, si aún no cabe, se recorta.
function fitText(value, height, width) {
    let fontWidth = height;
    if (value.length * CHAR_RATIO * fontWidth > width)
        fontWidth = Math.max(Math.round(height * 0.55), Math.floor(width / (value.length * CHAR_RATIO)));
    const maxChars = Math.max(1, Math.floor(width / (CHAR_RATIO * fontWidth)));
    return { text: value.length > maxChars ? `${value.slice(0, Math.max(1, maxChars - 1))}.` : value, fontWidth };
}
// Reparte un texto en varias líneas por palabras, con el mismo cálculo de ancho.
function wrapText(value, height, width, maxLines) {
    const perLine = Math.max(1, Math.floor(width / (CHAR_RATIO * height)));
    const lines = [];
    let current = '';
    for (const word of value.split(/\s+/).filter(Boolean)) {
        const next = current ? `${current} ${word}` : word;
        if (next.length <= perLine || !current)
            current = next;
        else {
            lines.push(current);
            current = word;
        }
    }
    if (current)
        lines.push(current);
    if (lines.length > maxLines) {
        lines.length = maxLines;
        lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(1, perLine - 1))}.`;
    }
    return lines;
}
// Bloques centrados en vertical; si no caben, el texto y las barras se
// reducen en proporción (letra mínima de 12 puntos) para no salirse nunca de
// la etiqueta. El logo conserva su tamaño: ya viene medido para caber.
function stack(blocks, h, margin, gap) {
    const fixed = blocks.reduce((sum, block) => sum + (block.fixed ? block.height : 0), 0);
    const flexible = blocks.reduce((sum, block) => sum + (block.fixed ? 0 : block.height), 0) + gap * Math.max(0, blocks.length - 1);
    const scale = Math.min(1, Math.max(0.3, (h - margin * 2 - fixed) / Math.max(1, flexible)));
    const total = fixed + flexible * scale;
    let y = Math.max(margin, Math.round((h - total) / 2));
    const elements = [];
    for (const block of blocks) {
        elements.push(...block.place(y, scale));
        y += Math.round((block.fixed ? block.height : block.height * scale) + gap * scale);
    }
    return elements;
}
function labelLayout(item, design) {
    const { w, h, dpmm } = labelSize(design);
    const margin = Math.round(1.5 * dpmm);
    const inner = w - margin * 2;
    const gap = Math.round(0.6 * dpmm);
    const blocks = [];
    const text = (value, ratio, min = 14) => {
        const clean = cleanText(value);
        if (!clean)
            return;
        const base = Math.max(min, Math.round(h * ratio));
        blocks.push({ height: base, place: (y, scale) => {
                const height = Math.max(12, Math.round(base * scale));
                return [{ kind: 'text', x: margin, y, width: inner, height, align: 'C', ...fitText(clean, height, inner) }];
            } });
    };
    if (design.showLogo && design.logo) {
        const logo = design.logo;
        blocks.push({ height: logo.height, fixed: true, place: y => [{ kind: 'logo', x: margin + Math.max(0, Math.round((inner - logo.width) / 2)), y, logo }] });
    }
    if (design.showName !== false && item.name)
        text(item.name, 0.11, 18);
    const brandModel = [design.showBrand ? item.brand : '', design.showModel ? item.model : ''].map(value => cleanText(value)).filter(Boolean).join(' · ');
    if (brandModel)
        text(brandModel, 0.08);
    const specs = [design.showCapacity ? cleanText(item.capacity, 20) : '', design.showBattery && Number.isFinite(Number(item.battery)) && item.battery !== null ? `Batería ${Math.round(Number(item.battery))}%` : ''].filter(Boolean).join(' · ');
    if (specs)
        text(specs, 0.1, 16);
    if (design.showImei && item.imei)
        text(`IMEI ${item.imei}`, 0.07);
    const barcodeValue = cleanBarcode(item.barcode || item.code);
    if (design.showBarcode !== false && barcodeValue) {
        const module = code128Modules(barcodeValue) * 2 <= inner ? 2 : 1;
        const barWidth = code128Modules(barcodeValue) * module;
        const barBase = Math.max(28, Math.round(h * 0.26));
        const textBase = Math.max(14, Math.round(h * 0.08));
        const x = margin + Math.max(0, Math.round((inner - barWidth) / 2));
        // Línea de lectura debajo de las barras, como JsBarcode en el Desktop.
        blocks.push({ height: barBase + textBase + 4, place: (y, scale) => {
                const barH = Math.max(20, Math.round(barBase * scale));
                const textH = Math.max(12, Math.round(textBase * scale));
                return [{ kind: 'barcode', x, y, module, height: barH, value: barcodeValue },
                    { kind: 'text', x: margin, y: y + barH + 4, width: inner, height: textH, align: 'C', ...fitText(barcodeValue, textH, inner) }];
            } });
    }
    if (design.showCode && item.code && item.code !== barcodeValue)
        text(item.code, 0.08);
    if (design.showPrice && item.price)
        text(cleanText(item.price, 24), 0.15, 22);
    if (design.customText)
        text(design.customText, 0.08);
    const quantity = Math.max(1, Math.min(999, Math.round(Number(item.quantity) || 1)));
    return { w, h, quantity, elements: stack(blocks, h, margin, gap) };
}
function serviceLabelLayout(label, size) {
    const { w, h, dpmm } = labelSize(size);
    const margin = Math.round(1.5 * dpmm);
    const inner = w - margin * 2;
    const rows = [
        `Cliente: ${cleanText(label.customerName)}`, `Tel: ${cleanText(label.customerPhone) || '-'}`, `Equipo: ${cleanText(label.deviceDescription)}`,
        `IMEI/Serial: ${cleanText(label.identifier) || '-'}`, ...(cleanText(label.password) ? [`Contraseña: ${cleanText(label.password)}`] : []),
    ];
    // Alto disponible repartido: número (1,6 líneas), filas, línea y falla (2 líneas).
    const units = 1.6 + rows.length + 2;
    const gap = Math.max(2, Math.round(0.35 * dpmm));
    const line = Math.max(14, Math.min(Math.round(3.2 * dpmm), Math.floor((h - margin * 2 - gap * (rows.length + 3)) / units)));
    const big = Math.round(line * 1.6);
    const left = (value, height, y) => ({ kind: 'text', x: margin, y, width: inner, height, align: 'L', ...fitText(value, height, inner) });
    const elements = [];
    let y = margin;
    elements.push(left(cleanText(label.number, 30), big, y));
    y += big + gap;
    for (const row of rows) {
        elements.push(left(row, line, y));
        y += line + gap;
    }
    elements.push({ kind: 'line', x: margin, y, width: inner, thickness: 2 });
    y += 2 + gap;
    for (const text of wrapText(`Falla: ${cleanText(label.problem, 90)}`, line, inner, 2)) {
        elements.push(left(text, line, y));
        y += line + gap;
    }
    return { w, h, quantity: 1, elements };
}
// --- Salida ZPL ---------------------------------------------------------------
// En ^BC el carácter > inicia un cambio de juego de caracteres; >< lo imprime.
const barcodeData = (value) => fieldText(value).replace(/>/g, '><');
function zplElement(element) {
    switch (element.kind) {
        case 'text': return `^FO${element.x},${element.y}^A0N,${element.height},${element.fontWidth}^FB${element.width},1,0,${element.align},0^FH_^FD${fieldText(element.text)}^FS`;
        case 'barcode': return `^FO${element.x},${element.y}^BY${element.module},2.5,${element.height}^BCN,${element.height},N,N,N^FH_^FD${barcodeData(element.value)}^FS`;
        case 'logo': {
            const bytes = element.logo.hex.length / 2;
            return `^FO${element.x},${element.y}^GFA,${bytes},${bytes},${element.logo.width / 8},${element.logo.hex}^FS`;
        }
        case 'line': return `^FO${element.x},${element.y}^GB${element.width},${element.thickness},${element.thickness}^FS`;
    }
}
function zplFromLayout(layout) {
    return `^XA^CI28^PW${layout.w}^LL${layout.h}^LS0${layout.elements.map(zplElement).join('')}^PQ${layout.quantity},0,1,Y^XZ`;
}
function zplProductLabels(items, design) {
    return items.map(item => zplFromLayout(labelLayout(item, design))).join('\n');
}
function zplServiceLabel(label, size) {
    return zplFromLayout(serviceLabelLayout(label, size));
}
// --- Vista previa SVG ---------------------------------------------------------
// Code 128: anchos de barra/espacio de cada símbolo (104 = arranque B, 106 = parada).
const CODE128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
function code128BBars(value) {
    const codes = Array.from(value, char => char.charCodeAt(0) - 32);
    const check = codes.reduce((sum, code, index) => sum + code * (index + 1), 104) % 103;
    return [104, ...codes, check, 106].map(code => CODE128[code]).join('');
}
const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function labelPreviewSvg(layout) {
    const parts = layout.elements.map(element => {
        switch (element.kind) {
            case 'text': {
                const length = Math.min(element.width, element.text.length * CHAR_RATIO * element.fontWidth);
                const x = element.align === 'C' ? element.x + element.width / 2 : element.x;
                return `<text x="${x}" y="${element.y + element.height * 0.86}" font-size="${element.height}" text-anchor="${element.align === 'C' ? 'middle' : 'start'}" textLength="${length.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${xml(element.text)}</text>`;
            }
            case 'barcode': {
                let x = element.x;
                let bar = true;
                let rects = '';
                for (const width of code128BBars(element.value)) {
                    const size = Number(width) * element.module;
                    if (bar)
                        rects += `<rect x="${x}" y="${element.y}" width="${size}" height="${element.height}"/>`;
                    x += size;
                    bar = !bar;
                }
                return rects;
            }
            case 'logo': return element.logo.preview ? `<image href="${xml(element.logo.preview)}" x="${element.x}" y="${element.y}" width="${element.logo.width}" height="${element.logo.height}" style="image-rendering:pixelated"/>` : '';
            case 'line': return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.thickness}"/>`;
        }
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.w} ${layout.h}" width="${layout.w}" height="${layout.h}"><rect width="100%" height="100%" fill="#fff"/><g fill="#111" font-family="'Arial Narrow','Roboto Condensed','Helvetica Neue',Arial,sans-serif" font-weight="700">${parts}</g></svg>`;
}
const labelPreviewDataUrl = (layout) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelPreviewSvg(layout))}`;
const LABEL_FIELDS = [['name', 'Nombre'], ['brand', 'Marca'], ['model', 'Modelo'], ['capacity', 'Capacidad'], ['battery', 'Batería'], ['imei', 'IMEI / serie'], ['barcode', 'Código de barras'], ['code', 'Código interno'], ['price', 'Precio']];
const DEFAULT_LABEL_FIELDS = {
    exhibir: ['name', 'brand', 'model', 'capacity', 'battery', 'price'],
    custom: ['name', 'barcode', 'code', 'price'],
};
const FIXED_FIELDS = { internal: ['name', 'barcode', 'code', 'price'], provider: ['name', 'barcode', 'code'] };
const normalizeLabelKind = (value) => {
    const kind = String(value || '').toLowerCase();
    return kind === 'provider' || kind === 'proveedor' ? 'provider' : kind === 'exhibir' ? 'exhibir' : kind === 'custom' || kind === 'personalizado' ? 'custom' : 'internal';
};
function labelFieldsFor(kind, chosen) {
    if (kind === 'internal' || kind === 'provider')
        return FIXED_FIELDS[kind];
    const valid = new Set(LABEL_FIELDS.map(([field]) => field));
    const list = Array.isArray(chosen?.[kind]) ? chosen[kind].filter((field) => valid.has(field)) : DEFAULT_LABEL_FIELDS[kind];
    return list.length ? list : DEFAULT_LABEL_FIELDS[kind];
}
function labelDesignFor(input) {
    const has = (field) => input.fields.includes(field);
    return { widthMm: input.widthMm, heightMm: input.heightMm, dpi: input.dpi, showName: has('name'), showBrand: has('brand'), showModel: has('model'),
        showCapacity: has('capacity'), showBattery: has('battery'), showImei: has('imei'), showBarcode: has('barcode'), showCode: has('code'), showPrice: has('price'),
        showLogo: Boolean(input.showLogo && input.logo), logo: input.showLogo ? input.logo ?? null : null };
}
// Logo: hasta 70 % del ancho útil y 24 % del alto de la etiqueta.
function labelLogoBox(design) {
    const { w, h, dpmm } = labelSize(design);
    return { maxWidth: Math.floor((w - 3 * dpmm) * 0.7), maxHeight: Math.max(16, Math.floor(h * 0.24)) };
}
// Una etiqueta por producto o, en Exhibir, una por cada equipo con IMEI/serie.
function labelItemsFor(kind, products, units, copies) {
    const base = (product) => ({ name: product.name, brand: product.brand, model: product.model, code: product.sku,
        barcode: product.barcode || product.sku, price: product.price, quantity: copies, productId: product.id });
    return products.flatMap(product => {
        const own = kind === 'exhibir' && product.serialized ? units.filter(unit => unit.productId === product.id) : [];
        if (!own.length)
            return [{ ...base(product), key: product.id }];
        return own.map(unit => ({ ...base(product), key: `${product.id}:${unit.id}`, capacity: unit.capacity || '', battery: unit.batteryHealth ?? null,
            imei: unit.imei || unit.serial || '', barcode: unit.imei || unit.serial || product.barcode || product.sku }));
    });
}

// Solo Desktop: reconoce una Zebra por el nombre de la impresora de Windows.
function isZebraPrinter(name) {
  return /zebra|zdesigner|\blp ?28\d\d|\btlp ?28\d\d|\bgk42\d|\bgx42\d|\bzd\d{3}|\bgc420/i.test(String(name || ''));
}

const api = { labelLayout, serviceLabelLayout, zplFromLayout, zplProductLabels, zplServiceLabel, code128BBars, labelPreviewSvg, labelPreviewDataUrl, LABEL_FIELDS, DEFAULT_LABEL_FIELDS, normalizeLabelKind, labelFieldsFor, labelDesignFor, labelLogoBox, labelItemsFor, isZebraPrinter };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
