// Value letters by the long words they bring within reach, weight premium
// tiles by the 3x points they add, and pace bids so no cash is left unspent.
export { LETTER_VALUE } from "./baseline.js";
import { LETTER_VALUE } from "./baseline.js";

export interface WordContext { myRack: Map<string, number>; dictionary: string[]; myBalance?: number; bagRemaining?: number; }
export interface BidContext extends WordContext { letter: string; myBalance: number; auctionType?: string; opponentBalances?: number[]; }
export function wordScore(word: string): number {
  const base = [...word].reduce((sum, c) => sum + LETTER_VALUE[c], 0);
  return Math.floor(base * (word.length <= 3 ? 1 : Math.min(3, (word.length - 1) / 2)));
}
const P = (k: string, d: number) => Number(process.env[k] ?? d);
const BASE = P("FB_BASE", 9), PER_LV = P("FB_LV", 2), COMMON = P("FB_COMMON", 3);
const PACE = P("FB_PACE", 0.5), PACE_MIN = P("FB_PACE_MIN", 0.7), PACE_MAX = P("FB_PACE_MAX", 2.2);
const NEAR = P("FB_NEAR", 0.5), GAIN = P("FB_GAIN", 1.15), ENDGAME = P("FB_END", 5), HOLD = P("FB_HOLD", 7);
// shortcut: market prices are the mean paid per letter in public history 2026-10-24; refit if the field changes.
const PRICE = [10.6, 15.4, 17.5, 13.4, 11.3, 18.2, 12.1, 19.5, 10.4, 25.7, 20.4, 10.8, 16.5, 10.5, 10, 15.9, 23.9, 11, 12.7, 10.1, 9.8, 16.1, 16.7, 27.3, 19.1, 33.2];
const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];

type Word = { text: string; score: number; needs: number[] };
type Index = { byLen: Word[][]; byLetter: Word[][] };
type Analysis = { playable: Word[]; completion: number[]; tiles: number };
const indexes = new WeakMap<string[], Index>();
const caches = new WeakMap<string[], Map<string, Analysis>>();
function index(dictionary: string[]): Index {
  let idx = indexes.get(dictionary);
  if (idx) return idx;
  const byLen: Word[][] = [], byLetter: Word[][] = Array.from({ length: 26 }, () => []);
  for (const text of dictionary) {
    const counts = new Array<number>(26).fill(0);
    for (const c of text) counts[c.charCodeAt(0) - 65]++;
    if (counts.some((n, i) => n > BAG[i])) continue;
    const needs: number[] = [];
    counts.forEach((n, i) => { if (n) needs.push(i, n); });
    const w = { text, score: wordScore(text), needs };
    (byLen[text.length] ??= []).push(w);
    if (text.length >= 7 && text.length <= 8) for (let i = 0; i < needs.length; i += 2) byLetter[needs[i]].push(w);
  }
  indexes.set(dictionary, idx = { byLen, byLetter });
  return idx;
}
function toArr(rack: Map<string, number>) { const r = new Array<number>(26).fill(0); for (const [c, n] of rack) r[c.charCodeAt(0) - 65] += n; return r; }

function analyze(ctx: WordContext): Analysis {
  const idx = index(ctx.dictionary);
  let cache = caches.get(ctx.dictionary);
  if (!cache) caches.set(ctx.dictionary, cache = new Map());
  const r = toArr(ctx.myRack), key = r.join(",");
  const hit = cache.get(key);
  if (hit) return hit;
  const tiles = r.reduce((a, b) => a + b, 0);
  const playable: Word[] = [], completion = new Array<number>(26).fill(0);
  for (let len = 2; len <= tiles + 1; len++) for (const w of idx.byLen[len] ?? []) {
    let missing = -1, ok = true;
    for (let i = 0; i < w.needs.length; i += 2) {
      const d = w.needs[i + 1] - r[w.needs[i]];
      if (d <= 0) continue;
      if (d > 1 || missing >= 0) { ok = false; break; }
      missing = w.needs[i];
    }
    if (!ok) continue;
    if (missing < 0) playable.push(w);
    else if (w.score > completion[missing]) completion[missing] = w.score;
  }
  playable.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  const result = { playable, completion, tiles };
  if (cache.size >= 1024) cache.clear();
  cache.set(key, result);
  return result;
}

// Best long word two letters away that needs `li`, net of the other letter's market price.
function near(r: number[], li: number, idx: Index, tiles: number): number {
  let best = 0;
  for (const w of idx.byLetter[li]) {
    if (w.text.length > tiles + 2 || w.needs.length > 0 && false) continue;
    let m = 0, other = -1;
    for (let i = 0; i < w.needs.length && m <= 2; i += 2) {
      const d = w.needs[i + 1] - r[w.needs[i]];
      if (d <= 0) continue;
      m += d;
      if (w.needs[i] !== li) other = w.needs[i];
      else if (d === 2) other = li;
    }
    if (m !== 2 || other < 0) continue;
    const v = w.score - PRICE[other];
    if (v > best) best = v;
  }
  return best;
}

export function chooseWord(ctx: WordContext): string | null {
  const { playable, tiles } = analyze(ctx);
  const remaining = ctx.bagRemaining ?? 0;
  const minLength = remaining <= ENDGAME || (ctx.myBalance ?? 100) < 10 ? 2 : remaining <= 15 || tiles >= 10 ? 5 : HOLD;
  return playable.find(w => w.text.length >= minLength || (w.text.length >= 6 && w.score >= 30))?.text ?? null;
}

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const { playable, completion, tiles } = analyze(ctx);
  const li = ctx.letter.charCodeAt(0) - 65, lv = LETTER_VALUE[ctx.letter];
  const best = playable[0]?.score ?? 0;
  const gain = Math.max(0, completion[li] - best);
  const bag = ctx.bagRemaining ?? 68;
  if (bag <= ENDGAME) {
    // Unspent currency has no score value; the last usable tile is the penultimate auction.
    return gain > 0 ? Math.min(ctx.myBalance, Math.ceil(ctx.myBalance / Math.max(1, bag / 2))) : 0;
  }
  const r = toArr(ctx.myRack);
  const have = r[li];
  let vowels = 0;
  for (const i of [0, 4, 8, 14, 20]) vowels += r[i];
  const vowel = "AEIOU".includes(ctx.letter);
  let value = BASE + PER_LV * lv;
  if ("AEINORST".includes(ctx.letter)) value += COMMON;
  if (vowel && vowels < tiles * 0.3) value += 3;
  if (vowel && vowels > tiles * 0.55) value *= 0.5;
  if (!vowel && vowels === 0 && tiles >= 5) value *= 0.5;
  value /= 1 + have * 0.6;
  if (lv >= 8 && completion[li] === 0) value = 1;
  // Cash left at the end is worthless: bid up when ahead of the spend schedule, down when behind.
  const pace = Math.min(PACE_MAX, Math.max(PACE_MIN, Math.pow((ctx.myBalance / bag) / (100 / 68), PACE)));
  value *= pace;
  value = Math.max(value, gain * GAIN);
  if (bag > 10 && have === 0) value = Math.max(value, NEAR * near(r, li, index(ctx.dictionary), tiles));
  if (ctx.auctionType === "FirstPrice") value *= 0.8;
  return Math.max(0, Math.min(ctx.myBalance, Math.round(value)));
}
