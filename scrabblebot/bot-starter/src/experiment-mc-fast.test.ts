import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as original from './strategy-mc.js';
import * as fast from './experiment-mc-fast.js';
import * as credit from './experiment-inventory-fast-credit.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
test('signature lookup matches original scores, tie order, repeats, missing words and large-rack fallback', () => {
  const dictionary = ['CATS', 'ACTS', 'TACT', 'CAT', 'AT', 'BALLOON', 'BALL', 'ON', 'QUIZZED', 'QUIZ'];
  for (const letters of ['CATS', 'TACT', 'BALLON', 'BALLOON', 'QUIZE', 'QUIZZED', 'ZZZ', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
    const ctx = { dictionary, myRack: rack(letters), myBalance: 100, bagRemaining: 0 };
    assert.equal(fast.chooseWord(ctx), original.chooseWord(ctx));
  }
});
test('fast valuation preserves original bids, word timing, budgets, price shading and inputs', () => {
  const dictionary = ['CARTER', 'CARTERS', 'AT', 'ON', 'BALL', 'BALLOON', 'QUIZ', 'QUIZZED'];
  const myRack = rack('CARTER'), before = [...myRack];
  for (const balance of [0, 13, 40, 100]) for (const bagRemaining of [0, 1, 10, 30]) {
    const ctx = { dictionary, myRack, myBalance: balance, bagRemaining };
    assert.equal(fast.chooseWord(ctx), original.chooseWord(ctx));
    for (const letter of ['A', 'F', 'Q']) for (const auctionType of ['Vickrey', 'FirstPrice']) {
      const input = { ...ctx, letter, auctionType };
      const bid = fast.decideBid(input);
      assert.equal(bid, original.decideBid(input));
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    }
  }
  assert.deepEqual([...myRack], before);
});
test('normal warmed full-dictionary bids finish under100ms', () => {
  const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  fast.chooseWord({ dictionary, myRack: new Map() });
  const times: number[] = [];
  for (const letter of ['A', 'F', 'Q']) {
    const start = performance.now();
    fast.decideBid({ dictionary, myRack: rack('AEINR'), myBalance: 100, bagRemaining: 60, letter });
    times.push(performance.now() - start);
  }
  assert.ok(Math.max(...times) < 100, `warm bids took ${times.join(', ')}ms`);
});
test('fast funding variant credits the word reward into future purchase capacity', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const dictionary = ['CARTER', 'CARTERS', ...[...letters].flatMap(a => [...letters].map(b => a + b))];
  const ctx = { dictionary, myRack: rack('CARTER'), myBalance: 13, bagRemaining: 30 };
  assert.equal(fast.chooseWord(ctx), null);
  assert.equal(credit.chooseWord(ctx), 'CARTER');
});
