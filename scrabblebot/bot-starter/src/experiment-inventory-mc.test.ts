import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as original from './strategy-mc.js';
import * as candidate from './experiment-inventory-mc.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
test('playing a word can fund the extra future tiles that make liquidation worthwhile', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const dictionary = ['CARTER', 'CARTERS', ...[...letters].flatMap(a => [...letters].map(b => a + b))];
  const ctx = { dictionary, myRack: rack('CARTER'), myBalance: 13, bagRemaining: 30 };
  assert.equal(original.chooseWord(ctx), null);
  assert.equal(candidate.chooseWord(ctx), 'CARTER');
});
test('word funding correction preserves bids, repeated-letter validation and inputs', () => {
  const ctx = { myRack: rack('BALLOON'), dictionary: ['BALLOON', 'BALL', 'ON'], myBalance: 20, bagRemaining: 30, letter: 'F' };
  const originalRack = [...ctx.myRack];
  assert.equal(candidate.chooseWord(ctx), 'BALLOON');
  assert.equal(candidate.chooseWord({ ...ctx, myRack: rack('BALLON'), bagRemaining: 0 }), 'BALL');
  for (const letter of 'ABFJQXZ') for (const balance of [0, 1, 20, 100]) for (const bagRemaining of [0, 1, 6, 30]) {
    const input = { ...ctx, letter, myBalance: balance, bagRemaining };
    assert.equal(candidate.decideBid(input), original.decideBid(input));
    const bid = candidate.decideBid(input);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    if (bagRemaining === 0) assert.equal(bid, 0);
  }
  assert.deepEqual([...ctx.myRack], originalRack);
});

