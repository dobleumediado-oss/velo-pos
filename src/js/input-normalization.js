// ════════════════════════════════════════════════════════════════════════════
// Captura uniforme en mayúsculas
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

  if (typeof document !== 'undefined' && document?.addEventListener) {
    document.addEventListener('input', event => {
      normalizeUppercaseEntry(event.target);
    }, true);
    document.addEventListener('change', event => {
      normalizeUppercaseEntry(event.target);
    }, true);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      shouldUppercaseEntryControl,
      uppercaseEntryValue,
      normalizeUppercaseEntry,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
