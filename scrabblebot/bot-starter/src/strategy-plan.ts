// Marginal-value planner: value a rack by its best reachable long word net of
// the market cost of the letters still missing; bid the value a letter adds.
export { LETTER_VALUE } from "./baseline.js";
import { LETTER_VALUE } from "./baseline.js";

export interface WordContext { myRack: Map<string, number>; dictionary: string[]; myBalance?: number; bagRemaining?: number; }
export interface BidContext extends WordContext { letter: string; myBalance: number; auctionType?: string; opponentBalances?: number[]; }
export function wordScore(word: string): number {
  const base = [...word].reduce((sum, c) => sum + LETTER_VALUE[c], 0);
  return Math.floor(base * (word.length <= 3 ? 1 : Math.min(3, (word.length - 1) / 2)));
}

const P = (k: string, d: number) => Number(process.env[k] ?? d);
const LAMBDA = P("PLAN_LAMBDA", 0.55);      // score value of one unit of cash early in the match
const LAMBDA_END = P("PLAN_LAMBDA_END", 0.1);
const MAXM = P("PLAN_MAXM", 7);              // most missing letters a plan may have
const F = P("PLAN_F", 0.7);                  // chance of winning each missing letter
const FEAS = Array.from({ length: 12 }, (_, m) => Math.pow(F, m));
const MINLEN = P("PLAN_MINLEN", 7);
// shortcut: market prices are the mean paid per letter in public history 2026-10-24; refit if the field changes.
const PRICE: Record<string, number> = { A: 10.6, B: 15.4, C: 17.5, D: 13.4, E: 11.3, F: 18.2, G: 12.1, H: 19.5, I: 10.4, J: 25.7, K: 20.4, L: 10.8, M: 16.5, N: 10.5, O: 10, P: 15.9, Q: 23.9, R: 11, S: 12.7, T: 10.1, U: 9.8, V: 16.1, W: 16.7, X: 27.3, Y: 19.1, Z: 33.2 };
const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];

type Word = { text: string; score: number; needs: number[] }; // needs = [letterIndex, count, ...]
type Index = { plans: Word[]; byLen: Word[][] };
const indexes = new WeakMap<string[], Index>();
export function index(dictionary: string[]): Index {
  let idx = indexes.get(dictionary);
  if (idx) return idx;
  const byLen: Word[][] = [], plans: Word[] = [];
  for (const text of dictionary) {
    const counts = new Array<number>(26).fill(0);
    for (const c of text) counts[c.charCodeAt(0) - 65]++;
    if (counts.some((n, i) => n > BAG[i])) continue;
    const needs: number[] = [];
    counts.forEach((n, i) => { if (n) needs.push(i, n); });
    const w = { text, score: wordScore(text), needs };
    (byLen[text.length] ??= []).push(w);
    if (text.length >= MINLEN && text.length <= 9) plans.push(w);
  }
  idx = { plans, byLen };
  indexes.set(dictionary, idx);
  return idx;
}

type Eval = { value: number; playable: Word[] };
const cache = new Map<string, Eval>();
export function toArr(rack: Map<string, number>) { const r = new Array<number>(26).fill(0); for (const [c, n] of rack) r[c.charCodeAt(0) - 65] += n; return r; }
const PRICE_I = Array.from({ length: 26 }, (_, i) => PRICE[String.fromCharCode(65 + i)]);
// AVAIL[i * 69 + bag]: chance at least one copy of letter i is auctioned in the next `bag` draws.
const AVAIL = new Float64Array(26 * 69);
for (let i = 0; i < 26; i++) for (let b = 0; b < 69; b++) AVAIL[i * 69 + b] = 1 - Math.pow(1 - BAG[i] / 98, b);
const TOPK = P("PLAN_K", 5);
const top = new Float64Array(16);

export function evaluate(r: number[], bag: number, idx: Index, lambda: number): Eval {
  const key = r.join(",") + "|" + bag;
  const hit = cache.get(key);
  if (hit) return hit;
  const tiles = r.reduce((a, b) => a + b, 0);
  const playable: Word[] = [];
  for (let len = 2; len <= tiles; len++) for (const w of idx.byLen[len] ?? []) {
    let ok = true;
    for (let i = 0; i < w.needs.length; i += 2) if (r[w.needs[i]] < w.needs[i + 1]) { ok = false; break; }
    if (ok) playable.push(w);
  }
  playable.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  let value = playable[0]?.score ?? 0;
  const b = Math.min(bag, 68);
  let n = 0;
  if (bag > 0) for (const w of idx.plans) {
    if (w.text.length > tiles + MAXM) continue;
    let m = 0, cost = 0, avail = 1;
    const needs = w.needs;
    for (let i = 0; i < needs.length; i += 2) {
      const d = needs[i + 1] - r[needs[i]];
      if (d <= 0) continue;
      m += d;
      if (m > MAXM) break;
      cost += d * PRICE_I[needs[i]];
      avail *= AVAIL[needs[i] * 69 + (d > 1 ? (b / d) | 0 : b)];
    }
    if (m === 0 || m > MAXM || m > bag) continue;
    const v = (w.score - lambda * cost) * FEAS[m] * avail * (bag < 3 * m ? bag / (3 * m) : 1);
    if (v <= 0 || (n === TOPK && v <= top[TOPK - 1])) continue;
    // insert into the sorted top-K
    let j = n < TOPK ? n++ : TOPK - 1;
    while (j > 0 && top[j - 1] < v) { top[j] = top[j - 1]; j--; }
    top[j] = v;
  }
  if (n) { let s = 0; for (let j = 0; j < n; j++) s += top[j]; s /= n; if (s > value) value = s; }
  const result = { value, playable };
  if (cache.size > 4096) cache.clear();
  cache.set(key, result);
  return result;
}
export function lambdaAt(bag: number) { return LAMBDA_END + (LAMBDA - LAMBDA_END) * Math.min(1, bag / 68); }

export function chooseWord(ctx: WordContext): string | null {
  const idx = index(ctx.dictionary);
  const bag = ctx.bagRemaining ?? 68, lambda = lambdaAt(bag);
  const r = toArr(ctx.myRack);
  const here = evaluate(r, bag, idx, lambda);
  if (bag <= 1) return here.playable[0]?.text ?? null;
  for (const w of here.playable.slice(0, 4)) {
    if (w.text.length < 5 && bag > 6) continue;
    const rest = [...r];
    for (let i = 0; i < w.needs.length; i += 2) rest[w.needs[i]] -= w.needs[i + 1];
    if (w.score + evaluate(rest, bag, idx, lambda).value >= here.value) return w.text;
  }
  return null;
}

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const idx = index(ctx.dictionary);
  const bag = ctx.bagRemaining ?? 68, lambda = lambdaAt(bag);
  const r = toArr(ctx.myRack);
  const li = ctx.letter.charCodeAt(0) - 65;
  const before = evaluate(r, bag, idx, lambda).value;
  r[li]++;
  const after = evaluate(r, bag - 1, idx, lambda).value;
  let bid = (after - before) / Math.max(lambda, 0.05);
  if (ctx.auctionType === "FirstPrice") bid *= 0.8;
  return Math.max(0, Math.min(ctx.myBalance, Math.round(bid)));
}
