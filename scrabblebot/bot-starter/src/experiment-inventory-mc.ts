// Monte Carlo rack valuation: a rack is worth the best words it can form
// once the tiles we still expect to buy arrive. Bid the paired difference
// between owning the letter and not, priced in cash.
export { LETTER_VALUE } from "./baseline.js";
import { LETTER_VALUE } from "./baseline.js";

export interface WordContext { myRack: Map<string, number>; dictionary: string[]; myBalance?: number; bagRemaining?: number; }
export interface BidContext extends WordContext { letter: string; myBalance: number; auctionType?: string; opponentBalances?: number[]; }
export function wordScore(word: string): number {
  const base = [...word].reduce((sum, c) => sum + LETTER_VALUE[c], 0);
  return Math.floor(base * (word.length <= 3 ? 1 : Math.min(3, (word.length - 1) / 2)));
}
const P = (k: string, d: number) => Number(process.env[k] ?? d);
const ROLLOUTS = P("MC_K", 24), LAMBDA = P("MC_LAMBDA", 0.5), MEAN_PRICE = P("MC_PRICE", 13);
const WIN_RATE = P("MC_WIN", 0.25), ENDGAME = P("MC_END", 5), PACE = P("MC_PACE", 0.5), PACE_MAX = P("MC_PACE_MAX", 2.5);
const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
const BAG_TILES = BAG.flatMap((n, i) => Array<number>(n).fill(i));

type Word = { text: string; score: number; mask: number; needs: number[]; len: number };
const indexes = new WeakMap<string[], Word[]>();
function index(dictionary: string[]): Word[] {
  let words = indexes.get(dictionary);
  if (words) return words;
  words = [];
  for (const text of dictionary) {
    const counts = new Array<number>(26).fill(0);
    let mask = 0;
    for (const c of text) { const i = c.charCodeAt(0) - 65; counts[i]++; mask |= 1 << i; }
    if (counts.some((n, i) => n > BAG[i])) continue;
    const needs: number[] = [];
    counts.forEach((n, i) => { if (n > 1) needs.push(i, n); }); // singles are covered by the mask
    words.push({ text, score: wordScore(text), mask, needs, len: text.length });
  }
  words.sort((a, b) => b.score - a.score); // first fit is the best
  indexes.set(dictionary, words);
  return words;
}
function toArr(rack: Map<string, number>) { const r = new Array<number>(26).fill(0); for (const [c, n] of rack) r[c.charCodeAt(0) - 65] += n; return r; }
function maskOf(r: number[]) { let m = 0; for (let i = 0; i < 26; i++) if (r[i]) m |= 1 << i; return m; }

function bestWord(r: number[], words: Word[], minLen = 2): Word | undefined {
  const mask = maskOf(r);
  let tiles = 0; for (let i = 0; i < 26; i++) tiles += r[i];
  for (const w of words) {
    if (w.len > tiles || w.len < minLen || (w.mask & ~mask) !== 0) continue;
    let ok = true;
    for (let i = 0; i < w.needs.length; i += 2) if (r[w.needs[i]] < w.needs[i + 1]) { ok = false; break; }
    if (ok) return w;
  }
  return undefined;
}
// Greedy two-word haul from a rack: what the rack can realistically cash in.
function haul(r: number[], words: Word[]): number {
  const w = bestWord(r, words);
  if (!w) return 0;
  const rest = [...r];
  for (const c of w.text) rest[c.charCodeAt(0) - 65]--;
  return w.score + (bestWord(rest, words, 4)?.score ?? 0);
}

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// Future draws shared by every valuation in one decision (common random numbers).
let draws: number[][] = [];
function reseed(key: number, n: number) {
  draws = [];
  const r = rng(key);
  for (let k = 0; k < ROLLOUTS; k++) {
    const d: number[] = [];
    for (let j = 0; j < n; j++) d.push(BAG_TILES[Math.floor(r() * BAG_TILES.length)]);
    draws.push(d);
  }
}
function value(r: number[], n: number, words: Word[]): number {
  let total = 0;
  const tmp = [...r];
  for (const d of draws) {
    for (let j = 0; j < 26; j++) tmp[j] = r[j];
    for (let j = 0; j < n; j++) tmp[d[j]]++;
    total += haul(tmp, words);
  }
  return total / draws.length;
}
function futureTiles(balance: number, bag: number) { return Math.max(0, Math.min(Math.floor(balance / MEAN_PRICE), Math.round(bag * WIN_RATE))); }

export function chooseWord(ctx: WordContext): string | null {
  const words = index(ctx.dictionary);
  const r = toArr(ctx.myRack), bag = ctx.bagRemaining ?? 68, balance = ctx.myBalance ?? 100;
  const best = bestWord(r, words);
  if (!best) return null;
  if (bag <= ENDGAME || balance < 10) return best.text;
  if (best.len >= 7) return best.text;
  if (best.len < 5) return null;
  const n = futureTiles(balance, bag);
  const afterPlay = futureTiles(balance + best.score, bag);
  reseed(bag * 7919 + 1, Math.max(n, afterPlay));
  const rest = [...r];
  for (const c of best.text) rest[c.charCodeAt(0) - 65]--;
  return best.score + value(rest, afterPlay, words) >= value(r, n, words) ? best.text : null;
}

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const words = index(ctx.dictionary);
  const r = toArr(ctx.myRack), bag = ctx.bagRemaining ?? 68, li = ctx.letter.charCodeAt(0) - 65;
  const best = bestWord(r, words)?.score ?? 0;
  if (bag <= ENDGAME) {
    r[li]++;
    const gain = (bestWord(r, words)?.score ?? 0) - best;
    return gain > 0 ? Math.min(ctx.myBalance, Math.ceil(ctx.myBalance / Math.max(1, bag / 2))) : 0;
  }
  const n = futureTiles(ctx.myBalance, bag);
  reseed(bag * 7919 + li, Math.max(n, 1));
  const without = value(r, n, words);
  r[li]++;
  const withL = value(r, n, words);
  let bid = (withL - without) / LAMBDA;
  // Cash left at the end is worthless: bid up when ahead of the spend schedule.
  bid *= Math.min(PACE_MAX, Math.max(0.7, Math.pow((ctx.myBalance / bag) / (100 / 68), PACE)));
  if (ctx.auctionType === "FirstPrice") bid *= 0.8;
  return Math.max(0, Math.min(ctx.myBalance, Math.round(bid)));
}
