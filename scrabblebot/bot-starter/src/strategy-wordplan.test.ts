import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decideBid } from './strategy-wordplan.js';
const dictionary = readFileSync(new URL('../../spacetimedb/wordlist.txt', import.meta.url), 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2);
const rack = (s: string) => { const m = new Map<string, number>(); for (const c of s) m.set(c, (m.get(c) ?? 0) + 1); return m; };
test('a letter that completes a premium long word is worth more than one that does not, and bids stay within cash', () => {
  const ctx = { dictionary, myRack: rack('QUIVERE'), myBalance: 60, bagRemaining: 40, auctionType: 'Vickrey' as const };
  const r = decideBid({ ...ctx, letter: 'R' }), x = decideBid({ ...ctx, letter: 'X' });
  assert.ok(r > x, `R ${r} should beat X ${x}`);
  for (const b of [r, x]) assert.ok(Number.isInteger(b) && b >= 0 && b <= 60);
  assert.equal(decideBid({ ...ctx, letter: 'R', bagRemaining: 0 }), 0);
  assert.equal(decideBid({ ...ctx, letter: 'R', myBalance: 0 }), 0);
});
