import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as market from './strategy-market.js';
import * as candidate from './research-weakword-20261025.js';

const rack = (letters: string) => {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
};
test('early weak-rack liquidation changes only the fixed word-timing gate', () => {
  const ctx = { dictionary: ['LATER', 'LATERAL'], myRack: rack('LATER'), myBalance: 100, bagRemaining: 60 };
  assert.equal(market.chooseWord(ctx), null);
  assert.equal(candidate.chooseWord(ctx), 'LATER');
  assert.equal(candidate.chooseWord({ ...ctx, myBalance: 30, bagRemaining: 41 }), 'LATER');
  for (const boundary of [
    { ...ctx, bagRemaining: 40 },
    { ...ctx, myBalance: 29 },
    { ...ctx, myRack: rack('LATERFEE') },
    { ...ctx, dictionary: ['RATE', 'LATERAL'], myRack: rack('RATE') },
    { ...ctx, dictionary: ['WATER', 'WATERED'], myRack: rack('WATER') },
  ]) assert.equal(candidate.chooseWord(boundary), market.chooseWord(boundary));
  assert.deepEqual(ctx.myRack, rack('LATER'));
  assert.equal(candidate.decideBid, market.decideBid);
});
