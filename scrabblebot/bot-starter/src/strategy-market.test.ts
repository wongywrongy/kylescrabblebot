import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as market from './strategy-market.js';
import priceData from './market-prices.json' with { type: 'json' };

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
const ctx = { dictionary: ['BALLOON', 'BALL', 'ON'], myRack: rack('BALLON'), myBalance: 100, bagRemaining: 30, letter: 'O' };

test('paired markets are deterministic, remove held/current tiles and draw without replacement', () => {
  const bag = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
  assert.deepEqual(market.sampleMarkets(ctx), market.sampleMarkets(ctx));
  for (const auctions of market.sampleMarkets(ctx)) {
    assert.equal(auctions.length, 30);
    const counts = Array<number>(26).fill(0);
    for (const [c, n] of ctx.myRack) counts[c.charCodeAt(0) - 65] += n;
    counts[ctx.letter.charCodeAt(0) - 65]++;
    for (const a of auctions) { counts[a.letter]++; assert.ok(Number.isFinite(a.price) && a.price >= 0); }
    assert.ok(counts.every((n, i) => n <= bag[i]));
  }
});
test('quotes preserve rack/dictionary inputs, repeats, cash bounds and first-price shading', () => {
  const original = [...ctx.myRack];
  assert.equal(market.chooseWord({ ...ctx, myRack: rack('BALLOON') }), 'BALLOON');
  assert.equal(market.chooseWord({ ...ctx, myRack: rack('BALLN'), bagRemaining: 0 }), 'BALL');
  for (const myBalance of [0, 1, 9, 30, 100]) for (const bagRemaining of [0, 1, 6, 30]) {
    const input = { ...ctx, myBalance, bagRemaining };
    const bid = market.decideBid(input);
    assert.equal(market.decideBid(input), bid);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= myBalance);
    assert.ok(market.decideBid({ ...input, auctionType: 'FirstPrice' }) <= bid);
    if (bagRemaining === 0) assert.equal(bid, 0);
  }
  assert.deepEqual([...ctx.myRack], original);
  assert.deepEqual(ctx.dictionary, ['BALLOON', 'BALL', 'ON']);
});
test('full-dictionary normal and large-rack quotes stay below100ms after warmup', () => {
  const dictionary = fs.readFileSync(new URL('../../spacetimedb/wordlist.txt', import.meta.url), 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  market.chooseWord({ dictionary, myRack: new Map() });
  const times: number[] = [];
  for (const [letters, myBalance, bagRemaining] of [['AEINR', 100, 60], ['AEINRTZ', 70, 30], ['BCDFGHJKLMNPQRSTVWXZ', 100, 20]] as const) {
    const start = performance.now();
    const bid = market.decideBid({ dictionary, myRack: rack(letters), myBalance, bagRemaining, letter: 'E' });
    times.push(performance.now() - start);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= myBalance);
  }
  assert.ok(Math.max(...times) < 100, `quotes took ${times.join(', ')}ms`);
});


test('market price data pins the frozen source, quote order, and safe integer thresholds', () => {
  assert.equal(market.config.MC_K, 24);
  assert.equal(market.config.MC_LAMBDA, 0.5);
  assert.equal(market.config.marketPrices.firstMatch, 400);
  assert.equal(market.config.marketPrices.lastMatch, 599);
  assert.equal(market.validateMarketPrices(priceData).reduce((n, row) => n + row.length, 0), 13600);
  for (const malformed of [null, {}, { ...priceData, version: 2 }, { ...priceData, prices: priceData.prices.slice(1) }]) {
    assert.throws(() => market.validateMarketPrices(malformed), /market price/i);
  }
  for (const invalid of [-1, 0.5, Infinity, NaN]) {
    const changed = structuredClone(priceData);
    changed.prices[0][0] = invalid;
    assert.throws(() => market.validateMarketPrices(changed), /market price/i);
  }
  const changed = structuredClone(priceData);
  changed.prices[0][0]++;
  assert.throws(() => market.validateMarketPrices(changed), /hash/i);
  changed.provenance.pricesSha256 = '0'.repeat(64);
  assert.throws(() => market.validateMarketPrices(changed), /provenance/i);
  const reordered = structuredClone(priceData);
  reordered.prices[0].reverse();
  assert.throws(() => market.validateMarketPrices(reordered), /hash/i);
});

test('production market preserves frozen full-dictionary decisions and sampled markets', () => {
  const dictionary = fs.readFileSync(new URL('../../spacetimedb/wordlist.txt', import.meta.url), 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  // Captured from the verified frozen experiment; no archived run data is needed to replay them.
  const cases = [
    { letters: 'AEINR', myBalance: 100, bagRemaining: 60, letter: 'A', word: null, bid: 16, firstPrice: 13, sampleHash: 'ad01d71f929a52e04625efe72ac0774a9528ccac42b118786fc4a4fb8986aeb0' },
    { letters: 'AEINR', myBalance: 100, bagRemaining: 60, letter: 'F', word: null, bid: 18, firstPrice: 14, sampleHash: '77f3fd0d6dcf227b890dcaddb6edd770b2eda436414cd05c23c8ff21762d8ccb' },
    { letters: 'AEINR', myBalance: 100, bagRemaining: 60, letter: 'Q', word: null, bid: 51, firstPrice: 41, sampleHash: '348f6acbbb45a6d287c8b7562f51651c3d7d22fb3977080f52495043e34471e1' },
    { letters: 'AEINRTZ', myBalance: 70, bagRemaining: 30, letter: 'E', word: null, bid: 42, firstPrice: 34, sampleHash: 'd6c417e738f2f3b237321821f8b15018d224c40d52543904dc71c265ebdd601d' },
    { letters: 'SPARE', myBalance: 20, bagRemaining: 6, letter: 'T', word: null, bid: 20, firstPrice: 16, sampleHash: 'b18db07ecc5e1cca13d06a9c8eab616cefabb98c0542249c61ec0d64d414ab50' },
    { letters: 'CARTER', myBalance: 30, bagRemaining: 1, letter: 'S', word: 'CARTER', bid: 30, firstPrice: 24, sampleHash: '0d43b6e18ddaa26ee36fb49534ab1c9a3e2f682d65546f46d458379d33f720a9' },
    { letters: 'BCDFGHJKLMNPQRSTVWXZ', myBalance: 100, bagRemaining: 20, letter: 'E', word: 'CRWTHS', bid: 0, firstPrice: 0, sampleHash: 'b5c0071c37e460c22888b16e3ca01f89fc7f98eb82341e560b2a3a34bb72bc19' },
    { letters: 'AEINR', myBalance: 0, bagRemaining: 30, letter: 'R', word: 'AIRN', bid: 0, firstPrice: 0, sampleHash: '41e637707b26e39076f70b0e66ca722935ed6c1487456fda3ce78b6f744f1b8f' },
    { letters: 'GRUSEN', myBalance: 32, bagRemaining: 8, letter: 'Z', word: null, bid: 20, firstPrice: 16, sampleHash: '977fac2f7113ae60b594903dadd508a7bebdd8120ee1abdf14b3bfa7d4dfd55e' },
  ];
  market.chooseWord({ dictionary, myRack: new Map() });
  for (const expected of cases) {
    const input = { dictionary, myRack: rack(expected.letters), myBalance: expected.myBalance, bagRemaining: expected.bagRemaining, letter: expected.letter };
    const hash = createHash('sha256').update(JSON.stringify(market.sampleMarkets(input))).digest('hex');
    assert.equal(hash, expected.sampleHash);
    assert.equal(market.chooseWord(input), expected.word);
    assert.equal(market.decideBid(input), expected.bid);
    assert.equal(market.decideBid({ ...input, auctionType: 'FirstPrice' }), expected.firstPrice);
    assert.equal(market.chooseWord({ ...input, remainingLetters: new Map() }), expected.word);
  }
});

test('deeper searches preserve the original paired sample prefix and validate the count', () => {
  const shallow = market.sampleMarkets(ctx);
  const deep = market.sampleMarkets(ctx, undefined, 32);
  assert.equal(deep.length, 32);
  assert.deepEqual(deep.slice(0, 8), shallow);
  for (const count of [0, 65, 1.5, Infinity, NaN]) {
    assert.throws(() => market.sampleMarkets(ctx, undefined, count), /sample count/);
  }
});


test('compact dictionary traversal preserves frozen deep-search bids with repeated letters and near endgame', () => {
  const dictionary = fs.readFileSync(new URL('../../spacetimedb/wordlist.txt', import.meta.url), 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  for (const [letters, myBalance, bagRemaining, letter, expected] of [
    ['AEINR', 100, 60, 'Q', 51], ['AEINRTZ', 70, 30, 'E', 28], ['SPARE', 20, 6, 'T', 20],
    ['CARTER', 30, 1, 'S', 30], ['GRUSEN', 32, 8, 'Z', 16], ['BALLOON', 100, 40, 'L', 12],
  ] as const) {
    const myRack = rack(letters), before = [...myRack];
    assert.equal(market.decideBid({ dictionary, myRack, myBalance, bagRemaining, letter }, undefined, 64), expected);
    assert.deepEqual([...myRack], before);
  }
});


test('observed pools exclude exhausted letters without subtracting held/current tiles twice', () => {
  const remainingLetters = new Map([['T', 1]]);
  const input = { ...ctx, myRack: rack('T'), letter: 'T', bagRemaining: 1, remainingLetters };
  for (const sample of market.sampleMarkets(input, undefined, 64)) assert.deepEqual(sample.map(a => a.letter), [19]);
  assert.deepEqual([...remainingLetters], [['T', 1]]);
  assert.deepEqual([...input.myRack], [['T', 1]]);
  for (const [letter, count] of [['T', -1], ['T', 0.5], ['T', 7], ['?', 1], ['A', Infinity]] as const) {
    assert.throws(() => market.sampleMarkets({ ...input, remainingLetters: new Map([[letter, count]]) }), /remaining letter/);
  }
});
