// ════════════════════════════════════════════════════════════════════════════
// printer-profiles.js — Perfiles universales de papel e impresora
//
// La marca de la impresora nunca debe decidir por sí sola el diseño. El perfil
// describe el medio físico; el controlador instalado en Windows/macOS/Linux se
// encarga de USB, ZPL/TSPL/EPL/DPL u otra emulación soportada por el equipo.
// ════════════════════════════════════════════════════════════════════════════

const PRINTER_PROFILES = Object.freeze({
  ticket_58: {
    id: 'ticket_58', label: 'Ticket térmico 58 mm', kind: 'continuous',
    widthMm: 58, printableWidthMm: 52, dpi: 203,
  },
  ticket_72: {
    id: 'ticket_72', label: 'Ticket térmico 72 mm', kind: 'continuous',
    widthMm: 72, printableWidthMm: 68, dpi: 203,
  },
  ticket_80: {
    id: 'ticket_80', label: 'Ticket térmico 80 mm', kind: 'continuous',
    widthMm: 80, printableWidthMm: 76, dpi: 203,
  },
  label_2connect_108: {
    id: 'label_2connect_108', label: '2Connect 2C-LP427B · 108 mm', kind: 'labels',
    widthMm: 108, printableWidthMm: 108, dpi: 203,
    model: '2Connect 2C-LP427B', languages: ['Driver', 'ZPL', 'TSPL', 'EPS/EPL', 'DPL'],
  },
  label_generic: {
    id: 'label_generic', label: 'Etiquetas · ancho configurable', kind: 'labels',
    widthMm: 100, printableWidthMm: 100, dpi: 203,
    languages: ['Driver'],
  },
  continuous_custom: {
    id: 'continuous_custom', label: 'Rollo continuo · ancho configurable', kind: 'continuous',
    widthMm: 80, printableWidthMm: 76, dpi: 203,
  },
  sheet: {
    id: 'sheet', label: 'Carta / A4 · hojas', kind: 'sheet',
    widthMm: 216, printableWidthMm: 186, dpi: 300,
  },
});

function _printerNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function _printerSettings(explicit) {
  if (explicit) return explicit;
  try {
    if (typeof DB !== 'undefined' && DB?.settings) return DB.settings;
    if (typeof CFG !== 'undefined' && CFG) return CFG;
  } catch {}
  return {};
}

function inferPrinterProfileId(printerName, scope = 'ticket') {
  const n = String(printerName || '').toLowerCase();
  if (/2\s*connect|2c[-_ ]?lp427|lp[-_ ]?427/.test(n)) return 'label_2connect_108';
  if (scope === 'barcode') return 'label_generic';
  if (/58|mini|port|pocket|handheld|bt.*print|print.*bt/.test(n)) return 'ticket_58';
  if (/72\s*mm/.test(n)) return 'ticket_72';
  if (/laser|inkjet|officejet|laserjet|pixma|envy|deskjet|ecotank|l-series|brother|canon|hp |ricoh|xerox|kyocera|samsung.*ml|samsung.*clp|pdf|fax|onenote|xps|a4|a3|ledger|legal/.test(n)) return 'sheet';
  if (/zebra|zpl|tsc|sato|dymo|brother.?ql|godex|argox|label|etiquet/.test(n)) return 'label_generic';
  return 'ticket_80';
}

function resolvePrinterProfile(printerName, scope = 'ticket', explicitSettings) {
  const settings = _printerSettings(explicitSettings);
  const settingKey = scope === 'barcode' ? 'barcode_printer_profile' : 'printer_profile';
  let id = String(settings[settingKey] || '').trim();

  // Compatibilidad con la configuración histórica printer_type.
  if (!id && scope === 'ticket') {
    const legacy = String(settings.printer_type || '').trim();
    id = ({ '58mm': 'ticket_58', '72mm': 'ticket_72', '80mm': 'ticket_80',
      '108mm': 'label_2connect_108', carta: 'sheet' })[legacy] || '';
  }
  if (!PRINTER_PROFILES[id]) id = inferPrinterProfileId(printerName, scope);

  const base = PRINTER_PROFILES[id] || PRINTER_PROFILES.ticket_80;
  const widthKey = scope === 'barcode' ? 'barcode_media_width_mm' : 'printer_width_mm';
  const dpiKey = scope === 'barcode' ? 'barcode_printer_dpi' : 'printer_dpi';
  const allowCustomWidth = id === 'label_generic' || id === 'continuous_custom';
  const widthMm = allowCustomWidth
    ? _printerNumber(settings[widthKey], base.widthMm, 20, 150)
    : base.widthMm;
  const dpi = _printerNumber(settings[dpiKey], base.dpi, 100, 1200);
  const safety = base.kind === 'continuous' ? Math.min(6, Math.max(2, widthMm * 0.05)) : 0;

  return {
    ...base,
    widthMm,
    printableWidthMm: allowCustomWidth ? Math.max(16, widthMm - safety) : base.printableWidthMm,
    dpi,
  };
}

function printerProfileLegacyType(profile) {
  const p = profile || PRINTER_PROFILES.ticket_80;
  if (p.kind === 'sheet') return 'carta';
  if (p.widthMm === 58) return '58mm';
  if (p.widthMm === 72) return '72mm';
  if (p.widthMm === 80) return '80mm';
  if (p.widthMm === 108) return '108mm';
  return p.kind === 'labels' ? 'label' : 'custom';
}

function calculateLabelLayout(design, profile) {
  const labelW = _printerNumber(design?.labelW, 50, 10, 150);
  const labelH = _printerNumber(design?.labelH, 25, 8, 300);
  const gapMm = _printerNumber(design?.gapMm, 2, 0, 30);
  const pageMm = Math.max(0, _printerNumber(design?.pageMm, 0, 0, 30));
  const mediaWidthMm = _printerNumber(profile?.printableWidthMm || profile?.widthMm, 100, 20, 150);
  const available = Math.max(labelW, mediaWidthMm - (pageMm * 2));
  const maxCols = Math.max(1, Math.floor((available + gapMm) / (labelW + gapMm)));
  const requestedCols = Math.max(1, Math.floor(Number(design?.cols) || 1));
  const cols = Math.min(requestedCols, maxCols);
  const usedWidthMm = (cols * labelW) + ((cols - 1) * gapMm);
  return {
    labelW, labelH, gapMm, pageMm, mediaWidthMm,
    cols, requestedCols, maxCols, usedWidthMm,
    rowHeightMm: labelH + gapMm + (pageMm * 2),
    adjusted: cols !== requestedCols,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PRINTER_PROFILES, inferPrinterProfileId, resolvePrinterProfile,
    printerProfileLegacyType, calculateLabelLayout,
  };
}
