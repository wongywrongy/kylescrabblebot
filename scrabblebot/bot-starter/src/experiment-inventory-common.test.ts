import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as base from './experiment-mc-fast.js';
import * as common from './experiment-inventory-common.js';

test('common floor requires spare cash and time, discounts duplicates and preserves price shading', () => {
  const ctx = { dictionary: [], myRack: new Map<string, number>(), myBalance: 100, bagRemaining: 30, letter: 'A' };
  const before = [...ctx.myRack];
  assert.equal(base.decideBid(ctx), 0);
  assert.equal(common.decideBid(ctx), 10);
  assert.equal(common.decideBid({ ...ctx, auctionType: 'FirstPrice' }), 8);
  assert.equal(common.decideBid({ ...ctx, myRack: new Map([['A', 1]]) }), 6);
  assert.equal(common.decideBid({ ...ctx, myBalance: 29 }), 0);
  assert.equal(common.decideBid({ ...ctx, myBalance: 30 }), 10);
  assert.equal(common.decideBid({ ...ctx, bagRemaining: 15 }), 0);
  for (const letter of 'BCDFGHJKLMPQUVWXYZ') assert.equal(common.decideBid({ ...ctx, letter }), 0);
  assert.deepEqual([...ctx.myRack], before);
});
test('common floor retains larger MC bids and respects balance and last auction', () => {
  const ctx = { dictionary: ['CARTERS'], myRack: new Map([['C', 1], ['A', 1], ['R', 2], ['T', 1], ['E', 1]]), myBalance: 100, bagRemaining: 30, letter: 'S' };
  assert.ok(base.decideBid(ctx) > 10);
  assert.equal(common.decideBid(ctx), base.decideBid(ctx));
  for (const myBalance of [0, 1, 29, 30, 100]) for (const bagRemaining of [0, 1, 15, 16, 30]) {
    const bid = common.decideBid({ ...ctx, myBalance, bagRemaining });
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= myBalance);
    if (bagRemaining === 0) assert.equal(bid, 0);
  }
});
