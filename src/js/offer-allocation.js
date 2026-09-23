// Reparto determinista de ofertas del POS.
//
// El navegador y el proceso main usan exactamente este mismo motor. El artículo
// marcado se cobra en cero; los demás conservan su precio porque ese precio ya
// incluye comercialmente el regalo. El reparto solo deja trazabilidad interna,
// en centavos y dentro del mismo grupo fiscal, sin inflar ninguna línea.
(function initOfferAllocation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VeloOffer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function offerAllocationFactory() {
  function toCents(value) {
    return Math.round((Number(value) || 0) * 100);
  }

  function taxableOf(item) {
    return !(item?.taxable === 0 || item?.taxable === false || item?.taxable === '0');
  }

  function taxPctOf(item) {
    if (!taxableOf(item)) return 0;
    const value = Number.parseFloat(item?.tax_pct);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 18;
  }

  function fiscalKey(item) {
    if (!taxableOf(item) || taxPctOf(item) <= 0) return 'exento';
    return `gravado:${taxPctOf(item).toFixed(6)}`;
  }

  function lineCents(item) {
    const price = item?.price ?? item?.unit_price;
    const qty = Number(item?.qty) || 0;
    return toCents((Number(price) || 0) * qty);
  }

  function invalid(message) {
    return { ok: false, error: message, items: [] };
  }

  function calculate(items) {
    if (!Array.isArray(items) || !items.length) {
      return { ok: true, hasOffer: false, originalTotal: 0, adjustedTotal: 0, items: [] };
    }

    const rows = items.map((item, index) => ({
      index,
      key: fiscalKey(item),
      cents: lineCents(item),
      gift: item?.offer_is_gift === true || Number(item?.offer_is_gift) === 1,
      absorbed: 0,
    }));
    const gifts = rows.filter(row => row.gift);
    const originalTotalCents = rows.reduce((sum, row) => sum + row.cents, 0);

    if (!gifts.length) {
      return {
        ok: true,
        hasOffer: false,
        originalTotal: originalTotalCents / 100,
        adjustedTotal: originalTotalCents / 100,
        items: rows.map(row => ({
          ...items[row.index],
          offer_is_gift: 0,
          offer_original_amount: 0,
          offer_absorbed_amount: 0,
          effective_line_total: row.cents / 100,
          effective_unit_price: (row.cents / 100) / (Number(items[row.index]?.qty) || 1),
        })),
      };
    }

    if (gifts.length === rows.length) {
      return invalid('Debe quedar al menos un artículo cobrado para absorber la oferta.');
    }

    const keys = [...new Set(gifts.map(row => row.key))];
    for (const key of keys) {
      const groupGifts = gifts.filter(row => row.key === key);
      const receivers = rows.filter(row => !row.gift && row.key === key && row.cents > 0);
      if (!receivers.length) {
        const kind = key === 'exento' ? 'exento' : 'con el mismo ITBIS';
        return invalid(`La oferta necesita otro artículo ${kind} que pueda absorber su valor.`);
      }

      const giftCents = groupGifts.reduce((sum, row) => sum + row.cents, 0);
      const receiverCents = receivers.reduce((sum, row) => sum + row.cents, 0);
      let assigned = 0;
      const shares = receivers.map(row => {
        const exact = giftCents * row.cents / receiverCents;
        const base = Math.floor(exact);
        assigned += base;
        return { row, base, remainder: exact - base };
      });
      let pending = giftCents - assigned;
      shares.sort((a, b) => (b.remainder - a.remainder) || (a.row.index - b.row.index));
      for (let index = 0; index < shares.length && pending > 0; index += 1, pending -= 1) {
        shares[index].base += 1;
      }
      for (const share of shares) share.row.absorbed += share.base;
    }

    const allocated = rows.reduce((sum, row) => sum + row.absorbed, 0);
    const giftTotal = gifts.reduce((sum, row) => sum + row.cents, 0);
    if (allocated !== giftTotal) return invalid('No se pudo cuadrar el reparto de la oferta al centavo.');

    const output = rows.map(row => {
      const effectiveCents = row.gift ? 0 : row.cents;
      const qty = Number(items[row.index]?.qty) || 1;
      return {
        ...items[row.index],
        offer_is_gift: row.gift ? 1 : 0,
        offer_original_amount: row.gift ? row.cents / 100 : 0,
        offer_absorbed_amount: row.absorbed / 100,
        effective_line_total: effectiveCents / 100,
        effective_unit_price: (effectiveCents / 100) / qty,
      };
    });
    const adjustedTotalCents = output.reduce(
      (sum, row) => sum + toCents(row.effective_line_total), 0
    );
    const expectedTotalCents = originalTotalCents - giftTotal;
    if (adjustedTotalCents !== expectedTotalCents) {
      return invalid('No se pudo descontar correctamente el artículo en oferta.');
    }

    return {
      ok: true,
      hasOffer: true,
      originalTotal: originalTotalCents / 100,
      adjustedTotal: adjustedTotalCents / 100,
      items: output,
    };
  }

  return { calculate, fiscalKey, lineCents, toCents };
});
