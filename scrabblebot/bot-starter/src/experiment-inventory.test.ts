import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as policy from './experiment-inventory.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}

test('inventory subsets require every repeated copy, preserve inputs and return legal words', () => {
  const ctx = { dictionary: ['BALLOON', 'BALL', 'ON'], myRack: rack('BALLON'), bagRemaining: 0, myBalance: 100 };
  const original = [...ctx.myRack];
  assert.equal(policy.chooseWord(ctx), 'BALL');
  assert.equal(policy.chooseWord({ ...ctx, myRack: rack('BALLOON') }), 'BALLOON');
  assert.equal(policy.chooseWord({ ...ctx, myRack: rack('Z') }), null);
  assert.deepEqual([...ctx.myRack], original);
  assert.deepEqual(ctx.dictionary, ['BALLOON', 'BALL', 'ON']);
});

test('future values are deterministic and preserve budgets and final auction', () => {
  const ctx = { dictionary: ['QUIZ', 'QUIZZED', 'AT'], myRack: rack('QUIZE'), bagRemaining: 30, myBalance: 20, letter: 'D' };
  assert.equal(policy.inventoryValue(ctx), policy.inventoryValue(ctx));
  assert.equal(policy.decideBid({ ...ctx, bagRemaining: 0 }), 0);
  assert.ok(policy.decideBid(ctx) <= 20);
  for (const bagRemaining of [0, 6, 10, 30]) {
    const word = policy.chooseWord({ ...ctx, bagRemaining });
    if (word) {
      const available = new Map(ctx.myRack);
      for (const c of word) { assert.ok((available.get(c) ?? 0) > 0); available.set(c, available.get(c)! - 1); }
    }
  }
});
