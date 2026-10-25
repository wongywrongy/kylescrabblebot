import fs from 'node:fs';
import * as mc from './experiment-mc-fast.js';
export { LETTER_VALUE, wordScore } from './experiment-mc-fast.js';
import type { BidContext, WordContext } from './experiment-mc-fast.js';

const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
const POOL = BAG.flatMap((n, i) => Array<number>(n).fill(i));
const history = JSON.parse(fs.readFileSync('runs/public-history.json', 'utf8'));
const top = new Map<string, number>(history.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
const prices: number[][] = Array.from({ length: 26 }, () => []);
for (const a of history.auctions) if (Number(a.matchId) >= 400 && Number(a.matchId) < 600) prices[a.letter.charCodeAt(0) - 65].push(top.get(a.auctionId) ?? 0);

type Word = { text: string; score: number };
type Index = { words: Map<string, Word>; prefixes: Set<string>; cache: Map<string, Word | undefined> };
const indexes = new WeakMap<string[], Index>();
function index(dictionary: string[]): Index {
  let idx = indexes.get(dictionary);
  if (idx) return idx;
  idx = { words: new Map(), prefixes: new Set(), cache: new Map() };
  for (const text of dictionary) {
    if (!/^[A-Z]{2,}$/.test(text)) continue;
    const counts = Array<number>(26).fill(0);
    for (const c of text) counts[c.charCodeAt(0) - 65]++;
    if (counts.some((n, i) => n > BAG[i])) continue;
    const key = [...text].sort().join('');
    if (!idx.words.has(key)) idx.words.set(key, { text, score: mc.wordScore(text) });
    for (let n = 1; n <= key.length; n++) idx.prefixes.add(key.slice(0, n));
  }
  indexes.set(dictionary, idx);
  return idx;
}

function bestWord(r: number[], idx: Index, minLength = 2): Word | undefined {
  const key = r.map((n, i) => String.fromCharCode(65 + i).repeat(n)).join('');
  const cacheKey = `${minLength}:${key}`;
  if (idx.cache.has(cacheKey)) return idx.cache.get(cacheKey);
  let best: Word | undefined;
  const visit = (start: number, prefix: string) => {
    for (let i = start; i < 26; i++) if (r[i]) {
      const next = prefix + String.fromCharCode(65 + i);
      if (!idx.prefixes.has(next)) continue;
      const word = idx.words.get(next);
      if (word && (word.text.length >= minLength || (word.text.length === 6 && word.score >= 30)) && (!best || word.score > best.score || (word.score === best.score && word.text.length > best.text.length))) best = word;
      r[i]--; visit(i, next); r[i]++;
    }
  };
  visit(0, '');
  if (idx.cache.size >= 16384) idx.cache.clear();
  idx.cache.set(cacheKey, best);
  return best;
}

type Auction = { letter: number; price: number };
export function sampleMarkets(ctx: WordContext & { letter?: string }): Auction[][] {
  const pool = [...POOL];
  for (const [c, n] of ctx.myRack) for (let k = 0; k < n; k++) { const i = pool.indexOf(c.charCodeAt(0) - 65); if (i >= 0) pool.splice(i, 1); }
  const current = ctx.letter ? pool.indexOf(ctx.letter.charCodeAt(0) - 65) : -1;
  if (current >= 0) pool.splice(current, 1);
  let seed = (ctx.bagRemaining ?? 68) * 7919 + (ctx.letter ? ctx.letter.charCodeAt(0) : 1);
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  return Array.from({ length: 8 }, () => {
    const remaining = [...pool], result: Auction[] = [];
    for (let n = 0; n < Math.min(ctx.bagRemaining ?? 68, pool.length); n++) {
      const letter = remaining.splice(Math.floor(random() * remaining.length), 1)[0], quotes = prices[letter];
      result.push({ letter, price: quotes[Math.floor(random() * quotes.length)] ?? 0 });
    }
    return result;
  });
}

function rollout(initial: number[], cash: number, market: Auction[], idx: Index): number {
  const r = [...initial];
  let score = 0, tiles = r.reduce((a, b) => a + b, 0);
  for (let i = 0; i < market.length; i++) {
    const remaining = market.length - i - 1;
    let word: Word | undefined;
    while ((word = bestWord(r, idx, remaining <= 6 || cash < 10 ? 2 : remaining <= 15 || tiles >= 10 ? 5 : 7))) {
      for (const c of word.text) r[c.charCodeAt(0) - 65]--;
      tiles -= word.text.length; score += word.score; cash += word.score;
    }
    if (remaining === 0 || cash <= 0) continue;
    const { letter, price } = market[i], c = String.fromCharCode(65 + letter);
    const before = bestWord(r, idx)?.score ?? 0;
    r[letter]++;
    const gain = Math.max(0, (bestWord(r, idx)?.score ?? 0) - before);
    r[letter]--;
    let bid = (2.5 * mc.LETTER_VALUE[c] + 8.5 + ('AEINORST'.includes(c) ? 3 : 0)) / (1 + 0.6 * r[letter]);
    bid = Math.max(bid, gain * 1.15);
    if (remaining <= 5) bid = gain > 0 ? Math.ceil(cash / Math.max(1, remaining / 2)) : 0;
    bid = Math.min(cash, Math.round(bid));
    if (bid > 0 && bid > price) { cash -= Math.max(1, price); r[letter]++; tiles++; }
  }
  return score;
}

export function chooseWord(ctx: WordContext): string | null {
  const idx = index(ctx.dictionary), r = Array<number>(26).fill(0);
  for (const [c, n] of ctx.myRack) r[c.charCodeAt(0) - 65] += n;
  const best = bestWord(r, idx);
  if (!best) return null;
  const cash = ctx.myBalance ?? 100;
  if ((ctx.bagRemaining ?? 68) <= 5 || cash < 10) return best.text;
  const future = sampleMarkets(ctx);
  const value = (rack: number[], balance: number) => future.reduce((sum, market) => sum + rollout(rack, balance, market, idx), 0) / future.length;
  const holding = value(r, cash), rest = [...r];
  for (const c of best.text) rest[c.charCodeAt(0) - 65]--;
  return best.score + value(rest, cash + best.score) >= holding ? best.text : null;
}

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const idx = index(ctx.dictionary), future = sampleMarkets(ctx), r = Array<number>(26).fill(0), letter = ctx.letter.charCodeAt(0) - 65;
  for (const [c, n] of ctx.myRack) r[c.charCodeAt(0) - 65] += n;
  const value = (rack: number[], cash: number) => future.reduce((sum, market) => sum + rollout(rack, cash, market, idx), 0) / future.length;
  const baseline = value(r, ctx.myBalance);
  r[letter]++;
  if (value(r, ctx.myBalance) <= baseline) return 0;
  let low = 0, high = ctx.myBalance;
  // shortcut: six paired searches approximate willingness within~balance/64; fixed-policy returns can be nonmonotone.
  for (let step = 0; step < 6 && low < high; step++) {
    const price = Math.ceil((low + high) / 2);
    if (value(r, ctx.myBalance - price) > baseline) low = price;
    else high = price - 1;
  }
  return Math.min(ctx.myBalance, Math.round(low * (ctx.auctionType === 'FirstPrice' ? 0.8 : 1)));
}
