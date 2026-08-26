'use strict';

const fs = require('fs');
const path = require('path');

const CSS_PX_PER_INCH = 96;
const PDF_POINTS_PER_INCH = 72;
const MAX_COMPATIBLE_PAGE_INCHES = 200;
const MAX_THERMAL_PAGE_HEIGHT_INCHES = 36;

function extractCssPageSize(html) {
  const match = String(html || '').match(/@page\s*(?:[^{}]*)\{[\s\S]{0,640}?\bsize\s*:\s*([^;}{]+)/i);
  return String(match?.[1] || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _extractPageBlock(html) {
  return String(html || '').match(/@page\s*(?:[^{}]*)\{([\s\S]{0,1200}?)\}/i)?.[1] || '';
}

function extractCssPageVerticalMarginInches(html) {
  const block = _extractPageBlock(html);
  const shorthand = block.match(/(?:^|[;\s])margin\s*:\s*([^;}{]+)/i)?.[1] || '';
  const values = shorthand.trim().split(/\s+/).map(cssLengthToInches).filter(value => value != null);
  let top = 0;
  let bottom = 0;
  if (values.length === 1) top = bottom = values[0];
  else if (values.length === 2) top = bottom = values[0];
  else if (values.length >= 3) {
    top = values[0];
    bottom = values[2];
  }
  const explicitTop = cssLengthToInches(block.match(/margin-top\s*:\s*([^;}{]+)/i)?.[1]);
  const explicitBottom = cssLengthToInches(block.match(/margin-bottom\s*:\s*([^;}{]+)/i)?.[1]);
  if (explicitTop != null) top = explicitTop;
  if (explicitBottom != null) bottom = explicitBottom;
  return top + bottom;
}

function cssLengthToInches(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|px)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (match[2]) {
    case 'mm': return amount / 25.4;
    case 'cm': return amount / 2.54;
    case 'pt': return amount / PDF_POINTS_PER_INCH;
    case 'px': return amount / CSS_PX_PER_INCH;
    case 'in': return amount;
    default: return null;
  }
}

function _cssSizeTokens(cssSize) {
  return String(cssSize || '')
    .replace(/\b(?:portrait|landscape)\b/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function _thermalRollWidth(cssSize) {
  const tokens = _cssSizeTokens(cssSize);
  if (!tokens.includes('auto')) return null;
  const length = tokens.find(token => token !== 'auto' && cssLengthToInches(token) != null);
  return length ? cssLengthToInches(length) : null;
}

function _hasFixedCssPageSize(cssSize) {
  if (!cssSize || /\bauto\b/.test(cssSize)) return false;
  if (/\b(?:a[0-6]|letter|legal|tabloid|ledger)\b/i.test(cssSize)) return true;
  const tokens = _cssSizeTokens(cssSize);
  return tokens.length >= 1 && tokens.length <= 2 && tokens.every(token => cssLengthToInches(token) != null);
}

function buildPdfOptions(html, renderInfo = {}) {
  const cssSize = extractCssPageSize(html);
  const rollWidthInches = _thermalRollWidth(cssSize);
  const base = {
    printBackground: true,
    displayHeaderFooter: false,
  };

  if (_hasFixedCssPageSize(cssSize)) {
    return {
      options: { ...base, preferCSSPageSize: true },
      profile: 'css-fixed',
      cssSize,
      paginated: true,
    };
  }

  if (rollWidthInches) {
    const measuredPixels = Math.max(
      48,
      Number(renderInfo.contentHeightPx) || 0,
      Number(renderInfo.bodyHeightPx) || 0
    );
    const contentHeightInches = (measuredPixels / CSS_PX_PER_INCH)
      + extractCssPageVerticalMarginInches(html)
      + 0.08;
    const pageHeightInches = Math.min(
      MAX_THERMAL_PAGE_HEIGHT_INCHES,
      Math.max(1, contentHeightInches)
    );
    return {
      options: {
        ...base,
        // Electron 41 exige pulgadas para printToPDF. La impresión física usa
        // micras y se calcula por una ruta diferente en main.js.
        pageSize: {
          width: Number(rollWidthInches.toFixed(4)),
          height: Number(pageHeightInches.toFixed(4)),
        },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      },
      profile: 'thermal-roll',
      cssSize,
      widthInches: rollWidthInches,
      contentHeightInches,
      pageHeightInches,
      paginated: contentHeightInches > pageHeightInches,
    };
  }

  return {
    options: { ...base, pageSize: 'Letter' },
    profile: 'sheet-default',
    cssSize,
    paginated: true,
  };
}

async function waitForPdfDocument(webContents, timeoutMs = 12000) {
  const execution = webContents.executeJavaScript(`
    (async () => {
      const nextPaint = () => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)));

      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      }
      if (window.__VELO_PDF_READY__ && typeof window.__VELO_PDF_READY__.then === 'function') {
        await window.__VELO_PDF_READY__;
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;

      const images = Array.from(document.images || []);
      await Promise.all(images.map(image => {
        if (image.complete) return Promise.resolve();
        return new Promise(resolve => {
          const done = () => resolve();
          image.addEventListener('load', done, { once: true });
          image.addEventListener('error', done, { once: true });
        });
      }));
      await nextPaint();

      const body = document.body;
      const root = document.documentElement;
      const bodyRect = body ? body.getBoundingClientRect() : { width: 0, height: 0, top: 0 };
      let contentRangeHeight = 0;
      if (body && body.childNodes.length) {
        const range = document.createRange();
        range.selectNodeContents(body);
        const rangeRect = range.getBoundingClientRect();
        contentRangeHeight = Math.max(0, rangeRect.bottom - bodyRect.top);
      }
      const brokenImages = images.filter(image => image.src && image.naturalWidth === 0).length;
      const text = body ? String(body.innerText || '').trim() : '';
      return {
        textLen: text.length,
        imageCount: images.length,
        brokenImages,
        svgCount: document.querySelectorAll('svg').length,
        canvasCount: document.querySelectorAll('canvas').length,
        contentWidthPx: Math.ceil(Math.max(
          body ? body.scrollWidth : 0,
          bodyRect.width || 0,
          root ? root.clientWidth : 0
        )),
        contentHeightPx: Math.ceil(Math.max(
          body ? body.scrollHeight : 0,
          bodyRect.height || 0,
          contentRangeHeight
        )),
        bodyHeightPx: Math.ceil(Math.max(bodyRect.height || 0, contentRangeHeight)),
      };
    })()
  `);

  let timeout;
  try {
    return await Promise.race([
      execution,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Tiempo agotado esperando fuentes, imágenes o QR del PDF')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validatePdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Electron no devolvió un Buffer PDF');
  if (buffer.length < 1000) throw new Error('El PDF generado no contiene datos suficientes');
  const header = buffer.subarray(0, 8).toString('ascii');
  if (!header.startsWith('%PDF-')) throw new Error('El archivo generado no tiene cabecera PDF');

  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  if (!tail.includes('%%EOF')) throw new Error('El PDF quedó incompleto: falta el marcador EOF');
  if (!/startxref\s+\d+/i.test(tail)) throw new Error('El PDF quedó incompleto: falta la tabla de referencias');

  const source = buffer.toString('latin1');
  const mediaBoxes = [];
  const mediaBoxPattern = /\/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/g;
  for (const match of source.matchAll(mediaBoxPattern)) {
    const widthPoints = Number(match[3]) - Number(match[1]);
    const heightPoints = Number(match[4]) - Number(match[2]);
    if (widthPoints > 0 && heightPoints > 0) mediaBoxes.push({ widthPoints, heightPoints });
  }
  if (!mediaBoxes.length) throw new Error('El PDF no declara un tamaño de página válido');
  const oversized = mediaBoxes.find(box =>
    box.widthPoints > MAX_COMPATIBLE_PAGE_INCHES * PDF_POINTS_PER_INCH ||
    box.heightPoints > MAX_COMPATIBLE_PAGE_INCHES * PDF_POINTS_PER_INCH
  );
  if (oversized) throw new Error('El PDF excede el tamaño de página compatible con Chrome');

  const pageCounts = Array.from(source.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,180}?\/Count\s+(\d+)/g), match => Number(match[1]));
  const pageCount = pageCounts.length ? Math.max(...pageCounts) : (source.match(/\/Type\s*\/Page\b/g) || []).length;
  if (!pageCount) throw new Error('El PDF no contiene páginas');

  return {
    version: header.slice(1).trim(),
    bytes: buffer.length,
    pageCount,
    mediaBoxes,
  };
}

function writePdfFile(filePath, buffer) {
  const validation = validatePdfBuffer(buffer);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const temporaryPath = `${filePath}.${token}.tmp`;
  const backupPath = `${filePath}.${token}.bak`;
  let backedUp = false;
  try {
    fs.writeFileSync(temporaryPath, buffer, { mode: 0o600, flush: true });
    const temporarySize = fs.statSync(temporaryPath).size;
    if (temporarySize !== buffer.length) throw new Error('El PDF no se escribió completo en disco');
    validatePdfBuffer(fs.readFileSync(temporaryPath));

    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, backupPath);
      backedUp = true;
    }
    fs.renameSync(temporaryPath, filePath);
    const finalSize = fs.statSync(filePath).size;
    if (finalSize !== buffer.length) throw new Error('El tamaño guardado no coincide con el Buffer generado');
    if (backedUp) fs.unlinkSync(backupPath);
    return { ...validation, path: filePath, size: finalSize };
  } catch (error) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch {}
    if (backedUp) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(backupPath, filePath);
      } catch {}
    }
    throw error;
  }
}

function cleanupStaleGeneratedFiles(directory, matcher, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!directory || !(matcher instanceof RegExp) || !fs.existsSync(directory)) return 0;
  const cutoff = Date.now() - Math.max(60 * 1000, Number(maxAgeMs) || 0);
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !matcher.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    try {
      if (fs.statSync(candidate).mtimeMs < cutoff) {
        fs.unlinkSync(candidate);
        removed++;
      }
    } catch {}
  }
  return removed;
}

module.exports = {
  MAX_COMPATIBLE_PAGE_INCHES,
  MAX_THERMAL_PAGE_HEIGHT_INCHES,
  extractCssPageSize,
  cssLengthToInches,
  extractCssPageVerticalMarginInches,
  buildPdfOptions,
  waitForPdfDocument,
  validatePdfBuffer,
  writePdfFile,
  cleanupStaleGeneratedFiles,
};
