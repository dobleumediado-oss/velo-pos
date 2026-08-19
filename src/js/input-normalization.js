// ════════════════════════════════════════════════════════════════════════════
// Captura uniforme en mayúsculas y montos legibles
// ────────────────────────────────────────────────────────────────────────────
// Los datos operativos escritos por el usuario se normalizan mientras escribe.
// Se preservan credenciales, correos, URLs, búsquedas y controles técnicos,
// donde cambiar el caso alteraría el significado o empeoraría la experiencia.
// Para una excepción explícita: data-uppercase="off".
// ════════════════════════════════════════════════════════════════════════════

(function initUppercaseEntry(globalScope) {
  'use strict';

  const PRESERVE_TYPES = new Set([
    'email', 'password', 'url', 'search', 'date', 'datetime-local', 'time',
    'month', 'week', 'color', 'file', 'hidden', 'checkbox', 'radio', 'range',
  ]);

  const MONEY_WORDS = /(?:^|[\s_-])(?:amount|monto|importe|price|precio|cost|costo|wholesale|mayoreo|salary|salario|bonus|bono|deduction|deduccion|fixed|fijo|goal|meta|fee|tarifa|bal|balance|saldo|debit|debito|credit|credito|collected|cobrado|received|recibido|payment|pago|abono|freight|flete|customs|aduana|transport|transporte|salvage|residual|limit|limite|gasto|expense|retiro|presupuesto|efectivo|tarjeta|transferencia|return|devolucion)(?:$|[\s_-])/i;
  const NON_MONEY_WORDS = /(?:^|[\s_-])(?:qty|quantity|cantidad|stock|existencia|percent|porcentaje|pct|rate|tasa|tax-pct|itbis-pct|year|ano|days|dias|months|meses|km|odometer|copies|copias|digits|digitos)(?:$|[\s_-])/i;

  function moneyMode(control) {
    return String(control?.dataset?.money ?? control?.getAttribute?.('data-money') ?? '').toLowerCase();
  }

  function moneyDescriptor(control) {
    const dataKeys = Object.keys(control?.dataset || {})
      .map(key => `data-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`)
      .join(' ');
    const own = [
      control?.id,
      control?.name,
      control?.className,
      dataKeys,
      control?.getAttribute?.('aria-label'),
      control?.getAttribute?.('placeholder'),
    ].filter(Boolean).join(' ');
    let label = '';
    try {
      const field = control?.closest?.('.fg, label');
      label = field?.querySelector?.('label')?.textContent ||
        (String(field?.tagName || '').toUpperCase() === 'LABEL' ? field.textContent : '');
    } catch {}
    return `${own} ${label}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function shouldFormatMoneyControl(control) {
    if (!control || String(control.tagName || '').toUpperCase() !== 'INPUT') return false;
    const mode = moneyMode(control);
    if (['off', 'false', 'no', 'plain'].includes(mode)) return false;
    if (['on', 'true', 'yes', 'money', 'currency'].includes(mode)) return true;
    // Auto-detección por palabra clave SOLO en campos numéricos.
    // Un campo de texto (type=text/tel) puede contener palabras como "gasto",
    // "pago", "devolución", "transferencia", "crédito" en labels de
    // concepto/motivo/referencia/titular; tratarlo como monto filtraría las
    // letras y dejaría escribir "solo números". Los montos reales de la app
    // son type="number"; un monto que sea texto debe optar explícitamente con
    // data-money="on".
    const type = String(control.type || 'text').toLowerCase();
    if (type !== 'number') return false;
    const descriptor = ` ${moneyDescriptor(control)} `;
    if (NON_MONEY_WORDS.test(descriptor)) return false;
    return MONEY_WORDS.test(descriptor);
  }

  function unformatMoneyEntryValue(value) {
    let raw = String(value ?? '').trim().replace(/\s|RD\$|US\$/gi, '');
    if (!raw) return '';
    const negative = raw.startsWith('-');
    raw = raw.replace(/-/g, '');
    // La interfaz usa el formato 1,000.00. Si el usuario pega una coma como
    // separador decimal y no hay punto, también se acepta.
    if (!raw.includes('.') && /^\d+,\d{1,2}$/.test(raw)) {
      raw = raw.replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
    raw = raw.replace(/[^\d.]/g, '');
    const dot = raw.indexOf('.');
    if (dot >= 0) raw = raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, '');
    if (raw.startsWith('.')) raw = `0${raw}`;
    return `${negative ? '-' : ''}${raw}`;
  }

  function formatMoneyEntryValue(value) {
    const raw = unformatMoneyEntryValue(value);
    if (!raw || raw === '-') return raw;
    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    const [wholeRaw = '0', fractionRaw = ''] = unsigned.split('.');
    const whole = (wholeRaw.replace(/^0+(?=\d)/, '') || '0')
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const fraction = `${fractionRaw}00`.slice(0, 2);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  function mapCaretWithoutGrouping(value, position) {
    return String(value ?? '').slice(0, Math.max(0, position || 0)).replace(/,/g, '').length;
  }

  function mapCaretWithGrouping(value, rawPosition) {
    const text = String(value ?? '');
    let seen = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== ',') seen++;
      if (seen >= rawPosition) return index + 1;
    }
    return text.length;
  }

  function setMoneySelection(control, start, end = start) {
    if (typeof control?.setSelectionRange !== 'function') return;
    try { control.setSelectionRange(start, end); } catch {}
  }

  function beginMoneyEntry(control) {
    if (!shouldFormatMoneyControl(control) || control.disabled || control.readOnly) return false;
    const before = String(control.value ?? '');
    const oldStart = Number.isInteger(control.selectionStart) ? control.selectionStart : before.length;
    const rawPosition = mapCaretWithoutGrouping(before, oldStart);
    if (!control.dataset.moneyOriginalType) control.dataset.moneyOriginalType = control.type || 'text';
    control.dataset.moneyEditing = 'true';
    if (String(control.type).toLowerCase() === 'number') control.type = 'text';
    control.inputMode = 'decimal';
    // El formato visible se conserva al enfocar. Antes de cada cálculo el
    // listener de `input` lo convierte temporalmente a número puro y solo lo
    // vuelve a presentar con separadores cuando el navegador va a pintar.
    control.value = formatMoneyEntryValue(before);
    setMoneySelection(control, mapCaretWithGrouping(control.value, rawPosition));
    return true;
  }

  function prepareMoneyEdit(control) {
    if (control?.dataset?.moneyEditing !== 'true') return false;
    const before = String(control.value ?? '');
    const start = mapCaretWithoutGrouping(before, control.selectionStart ?? before.length);
    const end = mapCaretWithoutGrouping(before, control.selectionEnd ?? control.selectionStart ?? before.length);
    control.value = unformatMoneyEntryValue(before);
    setMoneySelection(control, start, end);
    return true;
  }

  function normalizeMoneyEntry(control) {
    if (control?.dataset?.moneyEditing !== 'true') return false;
    const before = String(control.value ?? '');
    const start = Number.isInteger(control.selectionStart) ? control.selectionStart : before.length;
    const end = Number.isInteger(control.selectionEnd) ? control.selectionEnd : start;
    const after = unformatMoneyEntryValue(before);
    control.value = after;
    setMoneySelection(control, Math.min(start, after.length), Math.min(end, after.length));
    return after !== before;
  }

  function renderMoneyEntry(control) {
    if (control?.dataset?.moneyEditing !== 'true') return false;
    const before = String(control.value ?? '');
    const start = mapCaretWithoutGrouping(
      before, Number.isInteger(control.selectionStart) ? control.selectionStart : before.length
    );
    const end = mapCaretWithoutGrouping(
      before, Number.isInteger(control.selectionEnd) ? control.selectionEnd : start
    );
    const after = formatMoneyEntryValue(before);
    control.value = after;
    setMoneySelection(control, mapCaretWithGrouping(after, start), mapCaretWithGrouping(after, end));
    return after !== before;
  }

  function finishMoneyEntry(control) {
    if (control?.dataset?.moneyEditing !== 'true') return false;
    control.value = unformatMoneyEntryValue(control.value);
    const originalType = control.dataset.moneyOriginalType || 'number';
    if (originalType === 'number') control.type = 'number';
    delete control.dataset.moneyEditing;
    delete control.dataset.moneyOriginalType;
    return true;
  }

  // Un campo numérico donde escribir un valor nuevo debe reemplazar al anterior
  // sin obligar a borrarlo primero. Cubre montos (en edición money), campos
  // type=number y cualquiera marcado con inputmode numérico/decimal.
  function isNumericEntryControl(control) {
    if (!control || String(control.tagName || '').toUpperCase() !== 'INPUT') return false;
    if (control.disabled || control.readOnly) return false;
    if (control.dataset?.moneyEditing === 'true') return true;
    const type = String(control.type || 'text').toLowerCase();
    if (type === 'number') return true;
    const inputMode = String(
      control.inputMode || control.getAttribute?.('inputmode') || ''
    ).toLowerCase();
    return inputMode === 'decimal' || inputMode === 'numeric';
  }

  function selectEntireEntry(control) {
    if (typeof control?.select !== 'function') return;
    try { control.select(); } catch {}
  }

  function shouldUppercaseEntryControl(control) {
    if (!control || !control.tagName) return false;
    const tag = String(control.tagName).toUpperCase();
    if (!['INPUT', 'TEXTAREA'].includes(tag)) return false;
    const mode = String(
      control.dataset?.uppercase ?? control.getAttribute?.('data-uppercase') ?? ''
    ).toLowerCase();
    if (['off', 'false', 'no', 'preserve'].includes(mode)) return false;
    if (control.classList?.contains('no-uppercase')) return false;
    if (tag === 'INPUT' && PRESERVE_TYPES.has(String(control.type || 'text').toLowerCase())) {
      return false;
    }
    return true;
  }

  function uppercaseEntryValue(value) {
    return String(value ?? '').toLocaleUpperCase('es-DO');
  }

  function normalizeUppercaseEntry(control) {
    if (!shouldUppercaseEntryControl(control)) return false;
    const before = String(control.value ?? '');
    const after = uppercaseEntryValue(before);
    if (after === before) return false;
    const start = Number.isInteger(control.selectionStart) ? control.selectionStart : null;
    const end = Number.isInteger(control.selectionEnd) ? control.selectionEnd : null;
    control.value = after;
    if (start !== null && typeof control.setSelectionRange === 'function') {
      try { control.setSelectionRange(start, end ?? start); } catch {}
    }
    return true;
  }

  globalScope.shouldUppercaseEntryControl = shouldUppercaseEntryControl;
  globalScope.uppercaseEntryValue = uppercaseEntryValue;
  globalScope.normalizeUppercaseEntry = normalizeUppercaseEntry;
  globalScope.shouldFormatMoneyControl = shouldFormatMoneyControl;
  globalScope.formatMoneyEntryValue = formatMoneyEntryValue;
  globalScope.unformatMoneyEntryValue = unformatMoneyEntryValue;
  globalScope.beginMoneyEntry = beginMoneyEntry;
  globalScope.normalizeMoneyEntry = normalizeMoneyEntry;
  globalScope.renderMoneyEntry = renderMoneyEntry;
  globalScope.finishMoneyEntry = finishMoneyEntry;

  if (typeof document !== 'undefined' && document?.addEventListener) {
    document.addEventListener('focus', event => {
      const control = event.target;
      beginMoneyEntry(control);
      // Al enfocar un campo numérico, selecciona todo su contenido para que el
      // primer dígito escrito lo reemplace (sin obligar a borrar el valor
      // anterior). Si el foco vino de un clic, el navegador coloca el cursor al
      // soltar el ratón; por eso se re-selecciona en `mouseup` (más abajo),
      // salvo que el usuario haya arrastrado una selección propia.
      if (isNumericEntryControl(control)) {
        control._selectNumericOnPointerUp = true;
        selectEntireEntry(control);
      }
    }, true);
    document.addEventListener('mouseup', event => {
      const control = event.target;
      if (!control || !control._selectNumericOnPointerUp) return;
      control._selectNumericOnPointerUp = false;
      // Diferido: el manejador por defecto del clic coloca el cursor tras el
      // mouseup; seleccionar después gana. Respeta una selección manual (drag).
      setTimeout(() => {
        if (!isNumericEntryControl(control)) return;
        if (control.selectionStart === control.selectionEnd) selectEntireEntry(control);
      }, 0);
    }, true);
    document.addEventListener('beforeinput', event => {
      const control = event.target;
      if (control?.dataset?.moneyEditing !== 'true') return;
      prepareMoneyEdit(control);
      if (event.data === '.' || event.data === ',') {
        const dot = String(control.value || '').indexOf('.');
        if (dot >= 0) {
          event.preventDefault();
          setMoneySelection(control, dot + 1, control.value.length);
        }
      }
    }, true);
    document.addEventListener('input', event => {
      normalizeUppercaseEntry(event.target);
      const control = event.target;
      if (control?.dataset?.moneyEditing === 'true') {
        // Este listener corre en captura, antes de los `oninput` de cada modal.
        // Normalizar aquí mismo garantiza que todos esos cálculos reciban el
        // número limpio incluso cuando el usuario pega un monto con comas.
        normalizeMoneyEntry(control);
        // Los manejadores de cada modal y sus microtareas reciben primero el
        // valor puro. El formato visual ocurre en el siguiente frame, antes de
        // pintar, y `beforeinput` volverá a retirarlo antes de la próxima tecla.
        const scheduleFrame = typeof globalScope.requestAnimationFrame === 'function'
          ? globalScope.requestAnimationFrame.bind(globalScope)
          : callback => setTimeout(callback, 0);
        if (!control._moneyRenderPending) {
          control._moneyRenderPending = true;
          scheduleFrame(() => {
            control._moneyRenderPending = false;
            renderMoneyEntry(control);
          });
        }
      }
    }, true);
    document.addEventListener('change', event => {
      finishMoneyEntry(event.target);
      normalizeUppercaseEntry(event.target);
    }, true);
    document.addEventListener('blur', event => {
      finishMoneyEntry(event.target);
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === 'Tab') finishMoneyEntry(event.target);
    }, true);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      shouldUppercaseEntryControl,
      uppercaseEntryValue,
      normalizeUppercaseEntry,
      shouldFormatMoneyControl,
      formatMoneyEntryValue,
      unformatMoneyEntryValue,
      beginMoneyEntry,
      normalizeMoneyEntry,
      renderMoneyEntry,
      finishMoneyEntry,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
