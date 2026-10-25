import { createHash } from 'node:crypto';
import priceData from './market-prices.json' with { type: 'json' };
import * as mc from './strategy-montecarlo.js';
export { LETTER_VALUE, wordScore } from './strategy-montecarlo.js';
import type { BidContext, WordContext } from './strategy-montecarlo.js';
export type { BidContext, WordContext } from './strategy-montecarlo.js';

const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
const POOL = BAG.flatMap((n, i) => Array<number>(n).fill(i));
const provenance = {
  source: "runs/public-history.json", capturedAt: "2026-10-24T07:58:20.851Z",
  historySha256: "f94c84d7baa9e7ffbe64798dcdc3573720dd3c272cd142e4bab7abfcd6a7f8b5",
  firstMatch: 400, lastMatch: 599, quoteCount: 13600,
  trainingQuoteSha256: "13703e7e4741a8a88eb67091f6d309e497060732f6d172683490fc812a29868c",
  pricesSha256: "6201401ffceae7ed260d748bcfdefc8d4f061ba7c5622b1566b8b5f903550a95",
  quoteOrder: "Original auctions array order; missing topBid maps to0; no sorting or deduplication",
};
export function validateMarketPrices(input: unknown): number[][] {
  if (typeof input !== "object" || input === null) throw new Error("Invalid market price data");
  const data = input as { version?: unknown; provenance?: unknown; prices?: unknown };
  if (data.version !== 1 || typeof data.provenance !== "object" || data.provenance === null) throw new Error("Invalid market price provenance");
  const source = data.provenance as Record<string, unknown>;
  if (Object.entries(provenance).some(([key, value]) => source[key] !== value)) throw new Error("Invalid market price provenance");
  const quotes = data.prices;
  if (!Array.isArray(quotes) || quotes.length !== 26 || quotes.some(row => !Array.isArray(row) || row.length === 0 || row.some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error("Invalid market price quotes");
  if (quotes.reduce((n, row) => n + row.length, 0) !== provenance.quoteCount || createHash("sha256").update(JSON.stringify(quotes)).digest("hex") !== provenance.pricesSha256) throw new Error("Market price hash mismatch");
  return quotes;
}
const prices = validateMarketPrices(priceData);
export const config = { ...mc.config, futureMarkets: 8, priceSearchSteps: 6, marketPrices: { ...provenance } };

type Word = { text: string; score: number };
type Trie = { children: Map<number, Trie>; word?: Word };
type Index = { root: Trie; cache: Map<string, Word | undefined> };
const indexes = new WeakMap<string[], Index>();
function index(dictionary: string[]): Index {
  let idx = indexes.get(dictionary);
  if (idx) return idx;
  idx = { root: { children: new Map() }, cache: new Map() };
  for (const text of dictionary) {
    if (!/^[A-Z]{2,}$/.test(text)) continue;
    const counts = Array<number>(26).fill(0);
    for (const c of text) counts[c.charCodeAt(0) - 65]++;
    if (counts.some((n, i) => n > BAG[i])) continue;
    const key = [...text].sort().join('');
    let node = idx.root;
    for (const c of key) {
      const letter = c.charCodeAt(0) - 65;
      let child = node.children.get(letter);
      if (!child) { child = { children: new Map() }; node.children.set(letter, child); }
      node = child;
    }
    node.word ??= { text, score: mc.wordScore(text) };
  }
  indexes.set(dictionary, idx);
  return idx;
}

function bestWord(r: number[], idx: Index, minLength = 2): Word | undefined {
  const cacheKey = String.fromCharCode(minLength, ...r);
  if (idx.cache.has(cacheKey)) return idx.cache.get(cacheKey);
  let best: Word | undefined;
  const visit = (start: number, node: Trie) => {
    for (let i = start; i < 26; i++) if (r[i]) {
      const next = node.children.get(i);
      if (!next) continue;
      const word = next.word;
      if (word && (word.text.length >= minLength || (word.text.length === 6 && word.score >= 30)) && (!best || word.score > best.score || (word.score === best.score && word.text.length > best.text.length))) best = word;
      r[i]--; visit(i, next); r[i]++;
    }
  };
  visit(0, idx.root);
  if (idx.cache.size >= 16384) idx.cache.clear();
  idx.cache.set(cacheKey, best);
  return best;
}

type Auction = { letter: number; price: number };
export function sampleMarkets(ctx: BidContext, phasePrices?: number[][][], count = 8): Auction[][] {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("Invalid market sample count");
  const pool = ctx.remainingLetters ? [...ctx.remainingLetters].flatMap(([c, n]) => {
    if (!/^[A-Z]$/.test(c) || !Number.isSafeInteger(n) || n < 0 || n > BAG[c.charCodeAt(0) - 65]) throw new Error('Invalid remaining letter counts');
    return Array<number>(n).fill(c.charCodeAt(0) - 65);
  }) : [...POOL];
  // Observed counts already exclude our initial rack and every public draw.
  if (!ctx.remainingLetters) {
    for (const [c, n] of ctx.myRack) for (let k = 0; k < n; k++) { const i = pool.indexOf(c.charCodeAt(0) - 65); if (i >= 0) pool.splice(i, 1); }
    const current = pool.indexOf(ctx.letter.charCodeAt(0) - 65);
    if (current >= 0) pool.splice(current, 1);
  }
  let seed = (ctx.bagRemaining ?? 68) * 7919 + ctx.letter.charCodeAt(0);
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  return Array.from({ length: count }, () => {
    const remaining = [...pool], result: Auction[] = [];
    for (let n = 0; n < Math.min(ctx.bagRemaining ?? 68, pool.length); n++) {
      const letter = remaining.splice(Math.floor(random() * remaining.length), 1)[0], quotes = phasePrices?.[(ctx.bagRemaining ?? 68) - n - 1]?.[letter] ?? prices[letter];
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

export function chooseWord(ctx: WordContext) {
  index(ctx.dictionary);
  // The frozen market policy uses the legacy word selector independently of pool mode.
  return mc.chooseWord({ dictionary: ctx.dictionary, myRack: ctx.myRack, myBalance: ctx.myBalance, bagRemaining: ctx.bagRemaining });
}

export function decideBid(ctx: BidContext, phasePrices?: number[][][], count = 8): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const idx = index(ctx.dictionary), future = sampleMarkets(ctx, phasePrices, count), r = Array<number>(26).fill(0), letter = ctx.letter.charCodeAt(0) - 65;
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
