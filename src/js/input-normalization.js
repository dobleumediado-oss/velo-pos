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
    const type = String(control.type || 'text').toLowerCase();
    if (!['number', 'text', 'tel'].includes(type)) return false;
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
  globalScope.finishMoneyEntry = finishMoneyEntry;

  if (typeof document !== 'undefined' && document?.addEventListener) {
    document.addEventListener('focus', event => {
      beginMoneyEntry(event.target);
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
        const schedule = typeof queueMicrotask === 'function' ? queueMicrotask : (fn => setTimeout(fn, 0));
        schedule(() => normalizeMoneyEntry(control));
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
      finishMoneyEntry,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
