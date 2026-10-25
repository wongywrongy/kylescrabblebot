import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as premium from './strategy-premium.js';
import * as face from './experiment-face-policy.js';
import { createHighFaceCashflowPolicy } from './experiment-face-cashflow.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
const ctx = { myRack: rack('AEIN'), dictionary: ['TRAIN'], myBalance: 100, bagRemaining: 30, letter: 'F' };

test('face weighting preserves common prices and scales other face values', () => {
  for (const factor of [0.5, 1, 2]) {
    assert.equal(face.decideBid({ ...ctx, letter: 'T' }, factor), 14);
    assert.equal(face.decideBid({ ...ctx, letter: 'U' }, factor), premium.decideBid({ ...ctx, letter: 'U' }));
  }
  assert.equal(face.decideBid(ctx, 1), 20);
  assert.equal(face.decideBid({ ...ctx, letter: 'K' }, 1), 23);
  assert.equal(face.decideBid({ ...ctx, letter: 'C' }, 2), 19);
});

test('face weighting remains before rack modifiers, completion, rare gate and price shading', () => {
  assert.equal(face.decideBid({ ...ctx, myRack: rack('AAAAAFF'), letter: 'F' }, 1), 9);
  assert.equal(face.decideBid({ ...ctx, myRack: rack('BCDFG'), letter: 'F' }, 1), 6);
  assert.equal(face.decideBid({ ...ctx, auctionType: 'FirstPrice' }, 1), 16);
  for (const letter of 'JQXZ') assert.equal(face.decideBid({ ...ctx, letter }, 2), 1);
  const completion = { ...ctx, dictionary: ['QUIZZED'], myRack: rack('QUIZZE'), letter: 'D' };
  assert.equal(face.decideBid(completion, 2), premium.decideBid(completion));
  const repeated = { ...ctx, dictionary: ['BALLOON'], myRack: rack('BALLON'), letter: 'O' };
  assert.equal(face.decideBid(repeated, 2), premium.decideBid(repeated));
  assert.equal(face.chooseWord({ ...repeated, myRack: rack('BALLOON') }), 'BALLOON');
});

test('zero factor matches premium and the variants preserve caps, final auction and inputs', () => {
  const original = [...ctx.myRack];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const balance of [0, 1, 8, 20, 100]) {
      for (const remaining of [0, 1, 6, 30]) {
        const input = { ...ctx, letter, myBalance: balance, bagRemaining: remaining };
        assert.equal(face.decideBid(input, 0), premium.decideBid(input));
        for (const factor of [0.5, 1, 2]) {
          const bid = face.decideBid(input, factor);
          assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
          if (remaining === 0) assert.equal(bid, 0);
          if (remaining === 1) assert.equal(bid, premium.decideBid(input));
          assert.ok(face.decideBid({ ...input, opponentBalances: [0, 2] }, factor) <= 3);
        }
      }
    }
  }
  assert.deepEqual([...ctx.myRack], original);
  assert.deepEqual(ctx.dictionary, ['TRAIN']);
});

test('restricted cashflow floor requires a high-face tile, reward30 and the purchased copy', () => {
  const policy = createHighFaceCashflowPolicy();
  const input = { ...ctx, dictionary: ['FERVENT', 'VENTER'], myRack: rack('ERVENT'), letter: 'F' };
  const original = [...input.myRack];
  assert.equal(premium.decideBid(input), 20);
  assert.equal(policy.decideBid(input), 31);
  assert.equal(policy.decideBid({ ...input, auctionType: 'FirstPrice' }), 25);
  assert.equal(policy.decideBid({ ...input, myBalance: 12 }), 12);
  assert.equal(policy.decideBid({ ...input, opponentBalances: [5, 7] }), 8);
  assert.equal(policy.decideBid({ ...input, bagRemaining: 0 }), 0);
  const already = { ...input, myRack: rack('FERVENT') };
  assert.equal(policy.decideBid(already), premium.decideBid(already));
  const short = { ...ctx, dictionary: ['FIBRES', 'BRIES'], myRack: rack('IBRES'), letter: 'F', bagRemaining: 10 };
  assert.equal(premium.wordScore('FIBRES'), 27);
  assert.equal(policy.decideBid(short), premium.decideBid(short));
  const lowFace = { ...ctx, dictionary: ['PORTAGE', 'PROTEA'], myRack: rack('PREOTA'), letter: 'G' };
  assert.equal(policy.decideBid(lowFace), premium.decideBid(lowFace));
  assert.deepEqual([...input.myRack], original);
});
