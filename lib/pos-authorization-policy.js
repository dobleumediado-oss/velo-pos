'use strict';

const DEFAULT_DISCOUNT_AUTH_LIMIT_PCT = 10;
const DEFAULT_PRICE_MAX_REDUCTION_AMOUNT = 0;

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function discountAuthLimit(value) {
  return clampNumber(value, 0, 100, DEFAULT_DISCOUNT_AUTH_LIMIT_PCT);
}

function priceChangePolicy(settings = {}) {
  return {
    enabled: String(settings.pos_price_change_enabled ?? '1') !== '0',
    maxReductionAmount: clampNumber(
      settings.pos_price_max_reduction_amount,
      0,
      99999999,
      DEFAULT_PRICE_MAX_REDUCTION_AMOUNT
    ),
  };
}

function priceOverrideReduction(override = {}) {
  const unitPrice = Math.max(0, Number(override.unitPrice) || 0);
  const catalog = [override.retail, override.wholesale]
    .map(Number)
    .filter(Number.isFinite)
    .filter(value => value >= 0);
  if (!catalog.length) return 0;
  return Math.max(0, Math.min(...catalog) - unitPrice);
}

function priceOverridesRequiringAuth(overrides, maxReductionAmount) {
  const limit = clampNumber(maxReductionAmount, 0, 99999999, DEFAULT_PRICE_MAX_REDUCTION_AMOUNT);
  return (overrides || []).filter(override => priceOverrideReduction(override) > limit + 0.0049);
}

module.exports = {
  DEFAULT_DISCOUNT_AUTH_LIMIT_PCT,
  DEFAULT_PRICE_MAX_REDUCTION_AMOUNT,
  discountAuthLimit,
  priceChangePolicy,
  priceOverrideReduction,
  priceOverridesRequiringAuth,
};
