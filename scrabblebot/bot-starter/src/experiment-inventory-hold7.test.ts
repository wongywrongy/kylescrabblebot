import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as base from './experiment-mc-fast.js';
import * as candidate from './experiment-inventory-hold7.js';

function rack(letters: string) {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
test('weak seven-letter words may wait for a better funded outcome, with fixed score/cash/time gates', () => {
  const ctx = { dictionary: ['AAAAAAA', 'AAAAAAAJ'], myRack: rack('AAAAAAA'), myBalance: 100, bagRemaining: 60 };
  const original = [...ctx.myRack];
  assert.equal(base.chooseWord(ctx), 'AAAAAAA');
  assert.equal(candidate.chooseWord(ctx), null);
  assert.equal(candidate.chooseWord(ctx), null);
  assert.equal(candidate.chooseWord({ ...ctx, myBalance: 29 }), 'AAAAAAA');
  assert.equal(candidate.chooseWord({ ...ctx, bagRemaining: 20 }), 'AAAAAAA');
  assert.equal(candidate.chooseWord({ ...ctx, myRack: rack('AAAAAAAJ') }), 'AAAAAAAJ');
  assert.deepEqual([...ctx.myRack], original);
  assert.deepEqual(ctx.dictionary, ['AAAAAAA', 'AAAAAAAJ']);
});
test('shorter-word timing, repeat validation and all bid logic remain unchanged', () => {
  const dictionary = ['CARTER', 'CARTERS', 'AT', 'BALLOON', 'BALL', 'ON'];
  for (const letters of ['CARTER', 'BALLON', 'BALLOON', 'Z']) for (const myBalance of [0, 9, 30, 100]) for (const bagRemaining of [0, 1, 20, 60]) {
    const ctx = { dictionary, myRack: rack(letters), myBalance, bagRemaining };
    if (letters.length < 7 || bagRemaining <= 20 || myBalance < 30) assert.equal(candidate.chooseWord(ctx), base.chooseWord(ctx));
    for (const letter of ['A', 'F', 'Q']) for (const auctionType of ['Vickrey', 'FirstPrice']) {
      const input = { ...ctx, letter, auctionType };
      assert.equal(candidate.decideBid(input), base.decideBid(input));
    }
  }
});
test('full-dictionary low-seven word and bid decisions remain under100ms after warmup', () => {
  const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  candidate.chooseWord({ dictionary, myRack: new Map() });
  const ctx = { dictionary, myRack: rack('INERTIA'), myBalance: 100, bagRemaining: 60, letter: 'F' };
  const start = performance.now(); candidate.chooseWord(ctx); const wordMs = performance.now() - start;
  const bidStart = performance.now(); candidate.decideBid(ctx); const bidMs = performance.now() - bidStart;
  assert.ok(Math.max(wordMs, bidMs) < 100, `word${wordMs}ms bid${bidMs}ms`);
});
