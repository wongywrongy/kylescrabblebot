import * as rare from './experiment-rare-live.js';
export { LETTER_VALUE, wordScore, decideBid } from './experiment-rare-live.js';
export type { WordContext, BidContext } from './experiment-rare-live.js';

type Word = { text: string; score: number; base: number };
const indexes = new WeakMap<string[], Map<string, Word>>();
const caches = new WeakMap<string[], Map<string, Word[]>>();
const BAG = 'A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1'.match(/[A-Z]\d+/g)!.flatMap(x => [...x[0].repeat(Number(x.slice(1)))]);
let seed = 1979;
const futures = Array.from({ length: 8 }, () => Array.from({ length: 3 }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return BAG[Math.floor(seed / 2 ** 32 * BAG.length)];
}));

function words(ctx: rare.WordContext): Word[] {
  let index = indexes.get(ctx.dictionary);
  if (!index) {
    index = new Map();
    for (const text of ctx.dictionary) {
      const key = [...text].sort().join('');
      const previous = index.get(key);
      if (!previous || text < previous.text) index.set(key, { text, score: rare.wordScore(text), base: [...text].reduce((s, c) => s + rare.LETTER_VALUE[c], 0) });
    }
    indexes.set(ctx.dictionary, index);
  }
  let cache = caches.get(ctx.dictionary);
  if (!cache) { cache = new Map(); caches.set(ctx.dictionary, cache); }
  const entries = [...ctx.myRack].filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
  const key = entries.map(([c, n]) => c.repeat(n)).join('');
  const cached = cache.get(key);
  if (cached) return cached;
  const found: Word[] = [];
  function visit(i: number, letters: string) {
    if (i === entries.length) {
      const word = index!.get(letters);
      if (word) found.push(word);
      return;
    }
    const [c, count] = entries[i];
    for (let n = 0; n <= count; n++) visit(i + 1, letters + c.repeat(n));
  }
  visit(0, '');
  found.sort((a, b) => b.score - a.score || b.text.length - a.text.length || a.text.localeCompare(b.text));
  const result = found.slice(0, 5);
  if (cache.size >= 4096) cache.clear();
  cache.set(key, result);
  return result;
}

function remove(myRack: Map<string, number>, word: string) {
  const result = new Map(myRack);
  for (const c of word) result.set(c, result.get(c)! - 1);
  return result;
}

export function inventoryValue(ctx: rare.WordContext): number {
  const additions = Math.min(3, Math.floor((ctx.bagRemaining ?? 68) / 4));
  let value = 0;
  for (const future of futures) {
    const myRack = new Map(ctx.myRack);
    for (const c of future.slice(0, additions)) myRack.set(c, (myRack.get(c) ?? 0) + 1);
    const best = words({ ...ctx, myRack })[0];
    const face = [...myRack].reduce((sum, [c, n]) => sum + rare.LETTER_VALUE[c] * n, 0);
    value += best ? best.score + 1.5 * (face - best.base) : 1.5 * face;
  }
  return value / futures.length;
}

export function chooseWord(ctx: rare.WordContext): string | null {
  const tiles = [...ctx.myRack.values()].reduce((a, b) => a + b, 0);
  // shortcut: subset enumeration grows exponentially; retain the established policy on oversized racks.
  if (tiles > 11) return rare.chooseWord(ctx);
  const playable = words(ctx);
  if (!playable.length) return null;
  if ((ctx.bagRemaining ?? 0) <= 6) return playable[0].text;
  const weight = (ctx.myBalance ?? 100) < 30 ? 0.5 : 0.75;
  let bestValue = weight * inventoryValue(ctx), chosen: string | null = null;
  for (const word of playable) {
    const value = word.score + weight * inventoryValue({ ...ctx, myRack: remove(ctx.myRack, word.text) });
    if (value > bestValue) { bestValue = value; chosen = word.text; }
  }
  return chosen;
}
