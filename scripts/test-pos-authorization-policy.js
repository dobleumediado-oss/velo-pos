#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  discountAuthLimit,
  priceChangePolicy,
  priceOverrideReduction,
  priceOverridesRequiringAuth,
} = require('../lib/pos-authorization-policy');

assert.strictEqual(discountAuthLimit(undefined), 10);
assert.strictEqual(discountAuthLimit('15'), 15);
assert.strictEqual(discountAuthLimit('150'), 100);
assert.strictEqual(discountAuthLimit('-2'), 0);

assert.deepStrictEqual(priceChangePolicy({}), {
  enabled: true,
  maxReductionAmount: 0,
});
assert.deepStrictEqual(priceChangePolicy({
  pos_price_change_enabled: '0',
  pos_price_max_reduction_amount: '250.50',
}), {
  enabled: false,
  maxReductionAmount: 250.5,
});

const withinLimit = { retail: 1000, wholesale: 900, unitPrice: 850 };
const aboveLimit = { retail: 1000, wholesale: 900, unitPrice: 849.99 };
const increase = { retail: 1000, wholesale: 900, unitPrice: 1100 };
assert.strictEqual(priceOverrideReduction(withinLimit), 50);
assert.strictEqual(priceOverrideReduction(increase), 0);
assert.deepStrictEqual(priceOverridesRequiringAuth([withinLimit, aboveLimit, increase], 50), [aboveLimit]);

console.log('  ✓ límite porcentual de descuento configurable');
console.log('  ✓ política de cambio manual de precio normalizada');
console.log('  ✓ reducción en RD$ calculada desde el menor precio de catálogo');
