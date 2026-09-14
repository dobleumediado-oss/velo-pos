// ══════════════════════════════════════════════
// excel.js — Exportación profesional y centralizada a Excel
// Convierte las mismas tablas completas usadas por impresión/PDF a un XLSX
// real, tipado y con formato. Así todos los módulos conservan los filtros y
// criterios de sus reportes sin duplicar reglas financieras.
// ══════════════════════════════════════════════

window._excelSaveRequest = null;

function _excelText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function _excelNumber(text) {
  const normalized = String(text || '')
    .replace(/[^0-9,.-]/g, '')
    .replace(/,/g, '');
  if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function _excelDateValue(text) {
  const value = _excelText(text).toLowerCase().replace(/\./g, '');
  if (/^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?$/.test(value)) return value;
  const months = {
    ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4,
    may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8,
    sep: 9, sept: 9, septiembre: 9, oct: 10, octubre: 10,
    nov: 11, noviembre: 11, dic: 12, diciembre: 12,
  };
  const longDate = value.match(/^(\d{1,2})\s+([a-záéíóú]+)(?:\s+de)?\s+(\d{4})$/i);
  if (longDate && months[longDate[2]]) {
    return `${longDate[3]}-${String(months[longDate[2]]).padStart(2, '0')}-${String(longDate[1]).padStart(2, '0')}`;
  }
  const shortDate = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (shortDate) return `${shortDate[3]}-${String(shortDate[2]).padStart(2, '0')}-${String(shortDate[1]).padStart(2, '0')}`;
  return '';
}

function _excelStatus(element, text) {
  const value = _excelText(text).toLowerCase();
  const style = String(element?.getAttribute?.('style') || '').toLowerCase();
  const className = String(element?.className || '').toLowerCase();
  if (/vencid|anulad|sin stock|bloquead|moros|error/.test(value) || /dc2626|b91c1c|red/.test(style + className)) return 'danger';
  if (/por vencer|bajo|pendiente|advert/.test(value) || /d97706|b45309|amber|warn/.test(style + className)) return 'warning';
  if (/pagad|saldad|activo|entregado|facturado|completado|\bok\b/.test(value) || /16a34a|047857|green|success/.test(style + className)) return 'success';
  return '';
}

function _excelCellFromElement(cell, header = '') {
  const text = _excelText(cell?.textContent || '');
  const lowerHeader = _excelText(header).toLowerCase();
  const status = _excelStatus(cell, text);
  const bold = !!cell?.querySelector?.('strong,b') || /font-weight\s*:\s*(?:600|700|800|bold)/i.test(cell?.getAttribute?.('style') || '');
  const currency = /rd\$/i.test(text) || /^[-+]?\$[\d,.]+$/.test(text);
  const usd = /us\$/i.test(text);
  if ((currency || usd) && !/[→/]/.test(text)) {
    const value = _excelNumber(text);
    if (value !== null) return { value, type: usd ? 'usd' : 'currency', status, bold };
  }
  if (/^-?[\d,.]+\s*%$/.test(text)) {
    const value = _excelNumber(text);
    if (value !== null) return { value: value / 100, type: 'percent', status, bold };
  }
  const dateValue = /fecha|vencimiento|emisi[oó]n/i.test(lowerHeader) ? _excelDateValue(text) : '';
  if (dateValue) {
    return { value: dateValue, type: dateValue.length > 10 ? 'datetime' : 'date', status, bold };
  }
  if (/^-?[\d,.]+$/.test(text) && /cantidad|facturas|registros|unidades|stock|mín|lineas|líneas|días|conteo|número|total|monto|costo|precio|balance|límite|valor|ingreso|utilidad|itbis|descuento|ganancia|impacto|variación|promedio|debe|haber|saldo/i.test(lowerHeader)) {
    const value = _excelNumber(text);
    if (value !== null) {
      const moneyHeader = /total|monto|costo|precio|balance|límite|valor|ingreso|utilidad|itbis|descuento|ganancia|impacto|variación|promedio|debe|haber|saldo/i.test(lowerHeader);
      return { value, type: moneyHeader ? 'currency' : (Number.isInteger(value) ? 'integer' : 'number'), status, bold };
    }
  }
  return { value: text, type: 'text', status, bold };
}

function _excelUniqueName(name, used) {
  const base = (_excelText(name) || 'Detalle').replace(/[\\/*?:\[\]]/g, ' ').slice(0, 31) || 'Detalle';
  let candidate = base;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${index++}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function _excelSectionTitle(table, fallback) {
  let node = table?.previousElementSibling;
  while (node) {
    if (/^H[1-6]$/.test(node.tagName) || node.classList?.contains('card-title') || node.classList?.contains('modal-title')) {
      const text = _excelText(node.textContent);
      if (text) return text;
    }
    node = node.previousElementSibling;
  }
  const parentTitle = table?.closest?.('.card,section')?.querySelector?.('.card-title,h2,h3');
  return _excelText(parentTitle?.textContent) || fallback;
}

function _excelTablePayload(table, index, usedNames, reportTitle, subtitle) {
  let headers = Array.from(table.querySelectorAll('thead tr:last-child th')).map(cell => _excelText(cell.textContent));
  if (!headers.length) {
    const firstRow = table.querySelector('tr');
    headers = firstRow ? Array.from(firstRow.children).map((_, i) => `Columna ${i + 1}`) : [];
  }
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (!headers.length) return null;
  const dataRows = Array.from(table.querySelectorAll('tbody tr, tfoot tr')).map(row => {
    const cells = Array.from(row.querySelectorAll(':scope > td, :scope > th')).slice(0, headers.length)
      .map((cell, cellIndex) => _excelCellFromElement(cell, headers[cellIndex]));
    while (cells.length < headers.length) cells.push({ value: '', type: 'text' });
    return {
      cells,
      total: row.closest('tfoot') !== null || /total/i.test(String(row.className || '')),
    };
  }).filter(row => row.cells.some(cell => _excelText(cell.value) !== ''));
  const section = _excelSectionTitle(table, index === 0 ? reportTitle : `Detalle ${index + 1}`);
  return {
    name: _excelUniqueName(section, usedNames),
    title: section,
    subtitle,
    columns: headers.map(header => ({ header })),
    rows: dataRows,
  };
}

function _excelPayloadFromDocument(doc, options = {}) {
  const title = _excelText(options.title || doc.querySelector('h1,h2,.modal-title')?.textContent || 'Reporte');
  const subtitle = _excelText(options.subtitle || doc.querySelector('.sub,.modal-sub')?.textContent || '');
  const usedNames = new Set();
  const sheets = [];
  const metrics = Array.from(doc.querySelectorAll('.metrics .met, .metrics .metric, .stats .stat')).map(metric => {
    const valueEl = metric.querySelector('.met-v,.met-val,strong');
    const label = _excelText(metric.querySelector('.met-l,.met-label')?.textContent)
      || _excelText(metric.textContent).replace(_excelText(valueEl?.textContent), '').trim();
    return label && valueEl ? {
      cells: [
        { value: label, type: 'text', bold: true },
        _excelCellFromElement(valueEl, label),
      ],
    } : null;
  }).filter(Boolean);
  if (metrics.length) {
    sheets.push({
      name: _excelUniqueName('Resumen', usedNames), title, subtitle,
      columns: [{ header: 'Indicador' }, { header: 'Valor' }], rows: metrics,
    });
  }
  Array.from(doc.querySelectorAll('table')).forEach((table, index) => {
    const sheet = _excelTablePayload(table, index, usedNames, title, subtitle);
    if (sheet) sheets.push(sheet);
  });
  return {
    title,
    company: _excelText(options.company || (typeof CFG !== 'undefined' ? CFG.biz : '') || 'VELO POS'),
    subtitle,
    generatedAt: `${typeof today === 'function' ? today() : new Date().toISOString().slice(0, 10)} ${typeof nowt === 'function' ? nowt() : ''}`.trim(),
    suggestedName: options.suggestedName || title,
    sheets,
  };
}

async function _exportHTMLToExcel(html, options = {}) {
  if (!window.api?.excel?.saveReport) {
    toast('Exportación a Excel no disponible', 'err');
    return { ok: false };
  }
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const payload = _excelPayloadFromDocument(doc, options);
  if (!payload.sheets.length) {
    toast('Este reporte no contiene tablas para exportar', 'w');
    return { ok: false };
  }
  const result = await window.api.excel.saveReport(payload);
  if (result?.ok) toast(`Excel guardado correctamente${result.openError ? ' (no se pudo abrir automáticamente)' : ''}`, result.openError ? 'w' : 'ok');
  else if (!result?.canceled) toast(result?.error || 'No se pudo guardar el Excel', 'err');
  return result;
}

function _excelConsumeHTML(html, request) {
  if (!request || window._excelSaveRequest !== request) return false;
  window._excelSaveRequest = null;
  _exportHTMLToExcel(html, { suggestedName: request.name, title: request.title }).catch(error => {
    toast(error?.message || 'No se pudo generar el Excel', 'err');
  });
  return true;
}

// Intercepta el mismo constructor usado por PDF/impresión y guarda sus tablas
// completas en Excel. Admite constructores síncronos y asíncronos.
function guardarDocumentoExcel(buildAndPrintFn, suggestedName, title = '') {
  const request = { name: suggestedName || 'Reporte', title };
  window._excelSaveRequest = request;
  const finish = html => {
    if (typeof html === 'string' && html.trim()) _excelConsumeHTML(html, request);
    else if (window._excelSaveRequest === request) window._excelSaveRequest = null;
  };
  try {
    const result = typeof buildAndPrintFn === 'function' ? buildAndPrintFn() : buildAndPrintFn;
    if (result && typeof result.then === 'function') {
      result.then(finish).catch(error => {
        if (window._excelSaveRequest === request) window._excelSaveRequest = null;
        toast(error?.message || 'No se pudo preparar el Excel', 'err');
      });
      return;
    }
    finish(result);
  } catch (error) {
    if (window._excelSaveRequest === request) window._excelSaveRequest = null;
    toast(error?.message || 'No se pudo preparar el Excel', 'err');
  }
}

function exportarTablasExcel(root, suggestedName, title = '') {
  const source = root || document.getElementById('page') || document.body;
  const html = `<!DOCTYPE html><html><body>${source.outerHTML || source.innerHTML || ''}</body></html>`;
  return _exportHTMLToExcel(html, { suggestedName, title });
}

// Cobertura de respaldo para módulos operativos con tablas que todavía no
// tenían un exportador propio (compras, nómina, vendedores, comisiones, envíos,
// devoluciones, etc.). Exporta exactamente la vista y los filtros visibles.
function _excelEnhanceCurrentPage() {
  const pageEl = document.getElementById('page');
  if (!pageEl || !pageEl.querySelector('table')) return;
  const header = pageEl.querySelector(':scope > .sec-hdr') || pageEl.querySelector('.sec-hdr');
  if (!header || header.querySelector('[data-excel-auto]')) return;
  const alreadyHasExcel = Array.from(header.querySelectorAll('button')).some(button => /\bexcel\b/i.test(button.textContent || ''));
  if (alreadyHasExcel) return;
  const title = _excelText(header.querySelector('.sec-title')?.textContent || 'Reporte');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-out btn-sm';
  button.dataset.excelAuto = '1';
  button.innerHTML = `${typeof svg === 'function' ? svg('download') : ''} Excel`;
  button.title = 'Exportar la vista actual a Excel';
  button.onclick = () => exportarTablasExcel(pageEl, title.replace(/\s+/g, '-'), title);
  header.appendChild(button);
}

let _excelEnhanceTimer = null;
function _excelScheduleEnhance() {
  clearTimeout(_excelEnhanceTimer);
  _excelEnhanceTimer = setTimeout(_excelEnhanceCurrentPage, 80);
}

function _excelStartEnhancer() {
  _excelScheduleEnhance();
  const root = document.getElementById('root') || document.body;
  new MutationObserver(_excelScheduleEnhance).observe(root, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _excelStartEnhancer, { once: true });
else _excelStartEnhancer();
