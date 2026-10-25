import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as market from './strategy-market.js';
import { createPolicy, defaults, validateParameters } from './strategy-trained-market.js';

const rack = (word: string) => {
  const result = new Map<string, number>();
  for (const c of word) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
};
const dictionary = ['CARTER', 'CARTERS', 'AT', 'ON', 'BALLOON', 'BALL', 'QUIZ'];
test('default policy is exactly the incumbent and parameter bounds reject corrupt models', () => {
  const policy = createPolicy(defaults);
  for (const letters of ['CARTE', 'CARTER', 'BALLON']) for (const bagRemaining of [0, 5, 20, 45, 67]) {
    const ctx = { dictionary, myRack: rack(letters), myBalance: 100, letter: 'R', bagRemaining };
    assert.equal(policy.chooseWord(ctx), market.chooseWord(ctx));
    assert.equal(policy.decideBid(ctx), market.decideBid(ctx));
  }
  for (const p of [null, [], [...defaults, 1], [NaN, ...defaults.slice(1)], [1, 1, 1, 36, 0, 1]]) {
    assert.throws(() => validateParameters(p), /parameters/);
  }
  assert.throws(() => createPolicy(defaults, 'unknown'), /price source/);
});
test('trained decisions preserve cash, rack, first-price and final-auction constraints', () => {
  const policy = createPolicy([1.3, .8, 1.1, 25, 1.2, .6]);
  for (const balance of [0, 1, 9, 24, 100]) for (const bag of [0, 1, 5, 6, 30, 67, 80]) {
    const ctx = { dictionary, myRack: rack('BALLON'), myBalance: balance, letter: 'O', bagRemaining: bag };
    const before = [...ctx.myRack], bid = policy.decideBid(ctx);
    assert.ok(Number.isSafeInteger(bid) && bid >= 0 && bid <= balance);
    if (bag <= 5 || bag > 68) assert.equal(bid, market.decideBid(ctx));
    assert.equal(policy.decideBid({ ...ctx, auctionType: 'FirstPrice' }), market.decideBid({ ...ctx, auctionType: 'FirstPrice' }));
    const word = policy.chooseWord(ctx);
    if (word) {
      const available = new Map(ctx.myRack);
      for (const c of word) { assert.ok(available.get(c)! > 0); available.set(c, available.get(c)! - 1); }
    }
    assert.deepEqual([...ctx.myRack], before);
  }
  assert.equal(policy.chooseWord({ dictionary, myRack: rack('BALL'), myBalance: 24, bagRemaining: 50 }), 'BALL');
});

test('trained artifacts select deeper search while preserving the incumbent by default', () => {
  const ctx = { dictionary, myRack: rack('CARTE'), myBalance: 100, letter: 'R', bagRemaining: 30 };
  const policy = createPolicy(defaults, 'market', 32);
  assert.equal(policy.config.futureMarkets, 32);
  assert.equal(policy.decideBid(ctx), market.decideBid(ctx, undefined, 32));
  for (const count of [0, 65, 1.5, NaN]) {
    assert.throws(() => createPolicy(defaults, 'market', count), /sample count/);
  }
});


test('observed tile artifacts opt in while old artifacts retain their decisions', () => {
  const ctx = { dictionary, myRack: rack('CARTE'), myBalance: 100, letter: 'R', bagRemaining: 3, remainingLetters: new Map([['A', 2], ['T', 1]]) };
  const old = createPolicy(defaults, 'market', 64), observed = createPolicy(defaults, 'market', 64, true);
  assert.equal(old.config.observedTiles, false);
  assert.equal(observed.config.observedTiles, true);
  assert.equal(old.decideBid(ctx), market.decideBid({ ...ctx, remainingLetters: undefined }, undefined, 64));
  assert.equal(observed.decideBid(ctx), market.decideBid(ctx, undefined, 64));
  assert.equal(observed.decideBid({ ...ctx, remainingLetters: undefined }), old.decideBid(ctx));
  for (const invalid of [null, 1, 'true']) assert.throws(() => createPolicy(defaults, 'market', 64, invalid as unknown as boolean), /observed tile/);
});
