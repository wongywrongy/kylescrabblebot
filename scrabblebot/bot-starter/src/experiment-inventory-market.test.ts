import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as market from './experiment-inventory-market.js';

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
  const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
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
