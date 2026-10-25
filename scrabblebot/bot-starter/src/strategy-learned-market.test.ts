import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { validateLearnedPrices } from './strategy-learned-market.js';
import { sampleMarkets, decideBid } from './strategy-market.js';

const prices = Array.from({ length: 68 }, (_, phase) =>
  Array.from({ length: 26 }, (_, letter) => Array(128).fill(phase + letter)));
const artifact = () => ({ version: 1, prices: structuredClone(prices),
  pricesSha256: createHash('sha256').update(JSON.stringify(prices)).digest('hex') });

test('learned tables reject missing phases, invalid prices and corrupted model content', () => {
  assert.deepEqual(validateLearnedPrices(artifact()), prices);
  for (const invalid of [null, {}, { ...artifact(), version: 2 }, { ...artifact(), prices: prices.slice(1) }]) {
    assert.throws(() => validateLearnedPrices(invalid), /learned price/i);
  }
  for (const invalid of [-1, 1.5, NaN, Infinity, 201]) {
    const bad = artifact(); bad.prices[0][0][0] = invalid;
    assert.throws(() => validateLearnedPrices(bad), /learned price/i);
  }
  const bad = artifact(); bad.prices[0][0].fill(1);
  assert.throws(() => validateLearnedPrices(bad), /hash/i);
});

test('future prices use the future auction phase and preserve paired letter draws', () => {
  const ctx = { myRack: new Map([['A', 1], ['T', 1]]), myBalance: 100,
    dictionary: ['AT', 'ATE', 'TEA'], letter: 'E', bagRemaining: 30 };
  const empirical = sampleMarkets(ctx), learned = sampleMarkets(ctx, prices);
  assert.deepEqual(learned.map(m => m.map(a => a.letter)), empirical.map(m => m.map(a => a.letter)));
  for (const m of learned) m.forEach((a, i) => assert.equal(a.price, 29 - i + a.letter));
  assert.deepEqual(learned, sampleMarkets(ctx, prices));
  for (const balance of [0, 1, 10, 100]) for (const bag of [0, 1, 30, 68]) {
    const bid = decideBid({ ...ctx, myBalance: balance, bagRemaining: bag }, prices);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    if (bag === 0) assert.equal(bid, 0);
  }
  assert.deepEqual([...ctx.myRack], [['A', 1], ['T', 1]]);
});
