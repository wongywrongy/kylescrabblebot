import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cap1, premium, createCashflowPolicy } from './experiment-cashflow-policy.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}

for (const base of [cap1, premium]) {
  const policy = createCashflowPolicy(base, 0.8);
  test(`${base === cap1 ? 'cap1' : 'premium'} cashflow floor completes a held word and respects price/budget`, () => {
    const ctx = { dictionary: ['PORTAGE', 'PROTEA'], myRack: rack('PREOTA'), myBalance: 44, bagRemaining: 31, letter: 'G' };
    const original = [...ctx.myRack];
    assert.equal(base.chooseWord(ctx), null);
    assert.equal(base.decideBid(ctx), 13);
    assert.equal(policy.decideBid(ctx), 24);
    assert.equal(policy.decideBid({ ...ctx, auctionType: 'FirstPrice' }), 19);
    assert.equal(policy.decideBid({ ...ctx, myBalance: 12 }), 12);
    assert.equal(policy.decideBid({ ...ctx, opponentBalances: [5, 7] }), 8);
    assert.equal(policy.decideBid({ ...ctx, myBalance: 0 }), 0);
    assert.equal(policy.decideBid({ ...ctx, bagRemaining: 0 }), 0);
    assert.equal(policy.decideBid({ ...ctx, bagRemaining: 1 }), base.decideBid({ ...ctx, bagRemaining: 1 }));
    assert.deepEqual([...ctx.myRack], original);
    assert.deepEqual(ctx.dictionary, ['PORTAGE', 'PROTEA']);
  });
  test(`${base === cap1 ? 'cap1' : 'premium'} requires the purchased copy and subtracts liquidatable value`, () => {
    const ctx = { dictionary: ['BALLOON', 'BALL'], myRack: rack('BALLON'), myBalance: 100, bagRemaining: 30, letter: 'O' };
    assert.equal(policy.decideBid(ctx), Math.max(base.decideBid(ctx), 22));
    const missingTwice = { ...ctx, myRack: rack('BALLN') };
    assert.equal(policy.decideBid(missingTwice), base.decideBid(missingTwice));
    assert.equal(policy.decideBid({ ...ctx, letter: 'A' }), base.decideBid({ ...ctx, letter: 'A' }));
    const playable = { ...ctx, dictionary: ['BALLOON', 'BALL'], myRack: rack('BALLOON'), letter: 'O' };
    assert.equal(policy.decideBid(playable), base.decideBid(playable));
    const threshold = { ...ctx, dictionary: ['BALLOON'], myRack: rack('BALLOONXX'), letter: 'X' };
    assert.equal(policy.decideBid(threshold), base.decideBid(threshold));
    const upgrade = { ...ctx, dictionary: ['QUIZZED', 'QUIZ'], myRack: rack('QUIZZE'), letter: 'D', bagRemaining: 6 };
    assert.equal(policy.decideBid(upgrade), Math.max(base.decideBid(upgrade), Math.round((105 - 33) * 0.8)));
  });
}
