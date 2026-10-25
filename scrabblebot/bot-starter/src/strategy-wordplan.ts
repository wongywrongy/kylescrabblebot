// Word-plan bidder: value a rack by the best long word it can still reach, net of the market cost
// and the odds of acquiring the missing letters; bid the value a letter adds. Words come from hold-seven.
import priceData from './market-prices.json' with { type: 'json' };
import * as hold7 from './experiment-hold-word.js';
import { LETTER_VALUE, wordScore } from './strategy-trained-market.js';
export { LETTER_VALUE, wordScore } from './strategy-trained-market.js';
import type { BidContext, WordContext } from './strategy-market.js';

const MAX_MISSING = Number(process.env.PLAN_MAX_MISSING ?? 3), WIN_RATE = Number(process.env.PLAN_WIN_RATE ?? 0.25);
const MIN_LEN = Number(process.env.PLAN_MIN_LEN ?? 7), HYBRID = process.env.PLAN_HYBRID === '1';
// Cash is worthless when the bag empties, so letter prices mostly act as a budget limit rather than a deduction.
const COST_WEIGHT = Number(process.env.PLAN_COST_WEIGHT ?? 0.2);
// Commit mode: pay alpha * target score / missing letters for each letter the best target still needs.
const COMMIT = Number(process.env.PLAN_COMMIT ?? 0), COMMIT_MIN_P = Number(process.env.PLAN_COMMIT_MIN_P ?? 0.3);
const PRICE = (priceData as { prices: number[][] }).prices.map(row => row.reduce((a, b) => a + b, 0) / row.length);
const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
export const config = { ...hold7.config, planner: { maxMissing: MAX_MISSING, winRate: WIN_RATE, minLen: MIN_LEN, hybrid: HYBRID, costWeight: COST_WEIGHT, commit: COMMIT, commitMinP: COMMIT_MIN_P } };

type Word = { counts: Uint8Array; score: number };
const indexes = new WeakMap<string[], Word[]>();
function index(dictionary: string[]): Word[] {
  let words = indexes.get(dictionary);
  if (words) return words;
  words = [];
  for (const text of dictionary) {
    if (text.length < MIN_LEN) continue;
    const counts = new Uint8Array(26);
    for (const c of text) counts[c.charCodeAt(0) - 65]++;
    if (counts.some((n, i) => n > BAG[i])) continue;
    words.push({ counts, score: wordScore(text) });
  }
  indexes.set(dictionary, words);
  return words;
}
function toArr(rack: Map<string, number>) { const r = new Array<number>(26).fill(0); for (const [c, n] of rack) r[c.charCodeAt(0) - 65] += n; return r; }
// Letters still to be auctioned: observed counts when known, otherwise the bag prior less our rack, scaled to the bag size.
function remaining(ctx: WordContext, rack: number[]): number[] {
  const bag = ctx.bagRemaining ?? 68;
  if (ctx.remainingLetters) { const r = new Array<number>(26).fill(0); for (const [c, n] of ctx.remainingLetters) r[c.charCodeAt(0) - 65] += n; return r; }
  const prior = BAG.map((n, i) => Math.max(0, n - rack[i])), total = prior.reduce((a, b) => a + b, 0) || 1;
  return prior.map(n => n * bag / total);
}
export function bestTarget(rack: number[], ctx: WordContext, words: Word[]): { value: number; score: number; p: number; missing: number; needs: Uint8Array | null } {
  const bag = ctx.bagRemaining ?? 68, left = remaining(ctx, rack), budget = ctx.myBalance ?? 100;
  const maxAcquire = Math.max(0, Math.floor(bag * WIN_RATE));
  let best = 0, target: Word | null = null, bestP = 0, bestMissing = 0;
  for (const w of words) {
    let missing = 0, p = 1, cost = 0;
    for (let i = 0; i < 26 && missing <= MAX_MISSING; i++) {
      const need = w.counts[i] - rack[i];
      if (need <= 0) continue;
      missing += need;
      if (left[i] < need) { p = 0; break; }
      // Chance to win at least `need` of the remaining copies, treating each copy as an independent WIN_RATE shot.
      p *= Math.pow(1 - Math.pow(1 - WIN_RATE, left[i]), need);
      cost += need * PRICE[i];
    }
    if (missing > MAX_MISSING || missing > maxAcquire || p === 0 || cost > budget) continue;
    const value = p * (w.score - COST_WEIGHT * cost);
    if (value > best) { best = value; target = w; bestP = p; bestMissing = missing; }
  }
  return { value: best, score: target?.score ?? 0, p: bestP, missing: bestMissing, needs: target ? target.counts.map((n, i) => Math.max(0, n - rack[i])) as Uint8Array : null };
}
export function rackValue(rack: number[], ctx: WordContext, words: Word[]): number { return bestTarget(rack, ctx, words).value; }
export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const words = index(ctx.dictionary), rack = toArr(ctx.myRack), li = ctx.letter.charCodeAt(0) - 65;
  const without = rackValue(rack, ctx, words);
  rack[li]++;
  const gain = rackValue(rack, ctx, words) - without;
  let bid = Math.max(0, Math.min(ctx.myBalance, Math.round(gain * (ctx.auctionType === 'FirstPrice' ? 0.8 : 1))));
  if (COMMIT > 0) {
    rack[li]--;
    const t = bestTarget(rack, ctx, words);
    if (t.needs && t.needs[li] > 0 && t.p >= COMMIT_MIN_P) bid = Math.max(bid, Math.round(COMMIT * t.score / t.missing));
  }
  if (HYBRID || COMMIT > 0) bid = Math.max(bid, hold7.decideBid(ctx));
  return Math.min(ctx.myBalance, bid);
}
export function chooseWord(ctx: WordContext) { index(ctx.dictionary); return hold7.chooseWord(ctx); }
