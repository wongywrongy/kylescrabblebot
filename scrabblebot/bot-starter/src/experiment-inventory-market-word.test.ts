import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as frozen from './experiment-inventory-market.js';
import * as candidate from './experiment-inventory-market-word.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
const small = { dictionary: ['BALL', 'BALLOON', 'ON', 'AT'], myRack: rack('BALLON'), myBalance: 40, bagRemaining: 30 };

test('word markets require no offered letter and preserve physical supply and deterministic sampling', () => {
  const ctx = { ...small, myRack: rack('QQ') };
  assert.deepEqual(candidate.sampleMarkets(small), candidate.sampleMarkets(small));
  assert.equal(candidate.sampleMarkets(small).length, 8);
  assert.equal(candidate.sampleMarkets(small)[0].length, 30);
  const withOffer = { ...small, letter: 'A' };
  assert.deepEqual(candidate.sampleMarkets(withOffer), frozen.sampleMarkets(withOffer));
  // Holding the unique Q leaves no future Q, with no imaginary current auction subtracted.
  for (const market of candidate.sampleMarkets({ ...ctx, myRack: rack('Q') })) assert.ok(market.every(a => a.letter !== 16));
});
test('word decisions preserve repeated copies, final/cash boundaries and input state', () => {
  const before = [...small.myRack];
  assert.equal(candidate.chooseWord({ ...small, bagRemaining: 0 }), 'BALL');
  assert.equal(candidate.chooseWord({ ...small, myRack: rack('BALLOON'), bagRemaining: 0 }), 'BALLOON');
  assert.equal(candidate.chooseWord({ ...small, myBalance: 9 }), 'BALL');
  assert.equal(candidate.chooseWord({ ...small, myRack: new Map() }), null);
  assert.equal(candidate.chooseWord(small), candidate.chooseWord(small));
  assert.deepEqual([...small.myRack], before);
  assert.deepEqual(small.dictionary, ['BALL', 'BALLOON', 'ON', 'AT']);
});
test('offered-letter bids remain identical to the frozen market policy', () => {
  for (const myBalance of [0, 1, 13, 40, 100]) for (const bagRemaining of [0, 1, 6, 30]) for (const letter of ['A', 'F', 'Q']) {
    const ctx = { ...small, myBalance, bagRemaining, letter };
    assert.equal(candidate.decideBid(ctx), frozen.decideBid(ctx));
    assert.equal(candidate.decideBid({ ...ctx, auctionType: 'FirstPrice' }), frozen.decideBid({ ...ctx, auctionType: 'FirstPrice' }));
  }
});
test('full-dictionary word/bid decisions stay below100ms and warm empty racks avoid rollouts', () => {
  const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  candidate.chooseWord({ dictionary, myRack: new Map() });
  const times: number[] = [];
  for (const letters of ['GENUSR', 'INERTIA', 'QUIZ', 'BCDFGHJKLMNPQRSTVWXZ']) {
    const ctx = { dictionary, myRack: rack(letters), myBalance: 100, bagRemaining: 40, letter: 'E' };
    const t = performance.now(); const word = candidate.chooseWord(ctx); times.push(performance.now() - t);
    if (word) {
      const counts = new Map(ctx.myRack);
      for (const c of word) { assert.ok((counts.get(c) ?? 0) > 0); counts.set(c, counts.get(c)! - 1); }
    }
    const tBid = performance.now(); candidate.decideBid(ctx); times.push(performance.now() - tBid);
    assert.equal(candidate.decideBid(ctx), frozen.decideBid(ctx));
  }
  const t = performance.now();
  for (let i = 0; i < 1000; i++) assert.equal(candidate.chooseWord({ dictionary, myRack: new Map() }), null);
  assert.ok(performance.now() - t < 100);
  assert.ok(Math.max(...times) < 100, `decisions took ${times.join(', ')}ms`);
});
