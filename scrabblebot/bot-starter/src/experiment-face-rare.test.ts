import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as rare from './experiment-rare-live.js';
import * as candidate from './experiment-face-rare.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
const ctx = { myRack: rack('AEIN'), dictionary: ['TRAIN'], myBalance: 100, bagRemaining: 30, letter: 'F' };

test('generic face lift preserves common prices and independent rare prices', () => {
  assert.equal(candidate.decideBid(ctx), 19);
  assert.equal(candidate.decideBid({ ...ctx, letter: 'K' }), 21);
  for (const letter of 'AEINORSTU') assert.equal(candidate.decideBid({ ...ctx, letter }), rare.decideBid({ ...ctx, letter }));
  for (const letter of 'JQXZ') {
    assert.equal(candidate.decideBid({ ...ctx, letter }), rare.decideBid({ ...ctx, letter }));
    assert.equal(candidate.decideBid({ ...ctx, letter, myRack: rack('ABC') }), rare.decideBid({ ...ctx, letter, myRack: rack('ABC') }));
    assert.equal(candidate.decideBid({ ...ctx, letter, myRack: rack('BCDF') }), rare.decideBid({ ...ctx, letter, myRack: rack('BCDF') }));
  }
  assert.equal(candidate.decideBid({ ...ctx, letter: 'J' }), 32);
  assert.equal(candidate.decideBid({ ...ctx, letter: 'Z' }), 38);
  assert.equal(candidate.decideBid({ ...ctx, letter: 'Z', auctionType: 'FirstPrice' }), 30);
});

test('combination preserves completion, duplicate counts, caps, final auction and inputs', () => {
  const original = [...ctx.myRack];
  const repeat = { ...ctx, dictionary: ['BALLOON'], myRack: rack('BALLON'), letter: 'O' };
  assert.equal(candidate.decideBid(repeat), rare.decideBid(repeat));
  assert.equal(candidate.chooseWord({ ...repeat, myRack: rack('BALLOON') }), 'BALLOON');
  assert.equal(candidate.chooseWord({ ...repeat, myRack: rack('BALLON') }), null);
  const completion = { ...ctx, dictionary: ['QUIZZED'], myRack: rack('QUIZZE'), letter: 'D' };
  assert.equal(candidate.decideBid(completion), rare.decideBid(completion));
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const balance of [0, 1, 8, 20, 100]) for (const bagRemaining of [0, 1, 6, 30]) {
    const input = { ...ctx, letter, myBalance: balance, bagRemaining };
    const bid = candidate.decideBid(input);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    if (bagRemaining === 0) assert.equal(bid, 0);
    if (bagRemaining === 1) assert.equal(bid, rare.decideBid(input));
    assert.ok(candidate.decideBid({ ...input, opponentBalances: [0, 2] }) <= 3);
  }
  assert.deepEqual([...ctx.myRack], original);
  assert.deepEqual(ctx.dictionary, ['TRAIN']);
});
