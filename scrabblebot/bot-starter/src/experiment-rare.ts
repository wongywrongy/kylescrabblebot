// Value letters by the words they unlock, and save tiles for length bonuses.
export { LETTER_VALUE } from "./baseline.js";
import { LETTER_VALUE } from "./baseline.js";

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  myBalance?: number;
  bagRemaining?: number;
}
export interface BidContext extends WordContext {
  letter: string;
  myBalance: number;
  auctionType?: string;
  opponentBalances?: number[];
}
export function wordScore(word: string): number {
  const base = [...word].reduce((sum, c) => sum + LETTER_VALUE[c], 0);
  return Math.floor(base * (word.length <= 3 ? 1 : Math.min(3, (word.length - 1) / 2)));
}

type Word = { text: string; score: number; needs: [string, number][] };
type Analysis = { playable: Word[]; completion: number[]; near: number[]; tiles: number };
export const rareExperiment = { mode: "face2" as "face2" | "strong" | "strongQGuard" | "face4" | "flat40" };
const BAG_COUNTS = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
const premiumIndexes = new WeakMap<string[], Map<string, Word[]>>();
const indexes = new WeakMap<string[], Word[][]>();
const caches = new WeakMap<string[], Map<string, Analysis>>();

function analyze({ myRack, dictionary }: WordContext): Analysis {
  let index = indexes.get(dictionary);
  if (!index) {
    index = [];
    const premiumIndex = new Map<string, Word[]>();
    for (const text of dictionary) {
      const counts = new Map<string, number>();
      for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
      const word = { text, score: wordScore(text), needs: [...counts] };
      (index[text.length] ??= []).push(word);
      if (text.length >= 7 && word.score >= 45 && word.needs.every(([c, n]) => n <= BAG_COUNTS[c.charCodeAt(0) - 65])) {
        for (const [c] of word.needs) if (LETTER_VALUE[c] >= 4) {
          let words = premiumIndex.get(c);
          if (!words) { words = []; premiumIndex.set(c, words); }
          words.push(word);
        }
      }
    }
    indexes.set(dictionary, index);
    premiumIndexes.set(dictionary, premiumIndex);
  }
  let cache = caches.get(dictionary);
  if (!cache) { cache = new Map(); caches.set(dictionary, cache); }
  const key = [...myRack].filter(([, n]) => n > 0).sort().map(([c, n]) => `${c}${n}`).join("");
  const cached = cache.get(key);
  if (cached) return cached;
  const tiles = [...myRack.values()].reduce((sum, n) => sum + n, 0);
  const playable: Word[] = [];
  const completion = Array<number>(26).fill(0);
  for (let length = 2; length <= Math.min(tiles + 1, index.length - 1); length++) {
    for (const word of index[length] ?? []) {
      let missing = "";
      let fits = true;
      for (const [c, n] of word.needs) {
        const deficit = n - (myRack.get(c) ?? 0);
        if (deficit <= 0) continue;
        if (deficit > 1 || missing) { fits = false; break; }
        missing = c;
      }
      if (!fits) continue;
      if (!missing) playable.push(word);
      else {
        const i = missing.charCodeAt(0) - 65;
        completion[i] = Math.max(completion[i], word.score);
      }
    }
  }
  playable.sort((a, b) => b.score - a.score || b.text.length - a.text.length || a.text.localeCompare(b.text));
  const result = { playable, completion, near: Array<number>(26).fill(-1), tiles };
  if (cache.size >= 512) cache.clear();
  cache.set(key, result);
  return result;
}

export function chooseWord(ctx: WordContext): string | null {
  const { playable, tiles } = analyze(ctx);
  const remaining = ctx.bagRemaining ?? 0;
  const minLength = remaining <= 6 || (ctx.myBalance ?? 100) < 10 ? 2
    : remaining <= 15 || tiles >= 10 ? 5 : 7;
  return playable.find(w => w.text.length >= minLength || (w.text.length >= 6 && w.score >= 30))?.text ?? null;
}

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const { playable, completion, near, tiles } = analyze(ctx);
  const best = playable[0]?.score ?? 0;
  const completed = completion[ctx.letter.charCodeAt(0) - 65] ?? 0;
  const gain = Math.max(0, completed - best);
  const maxOpponent = ctx.opponentBalances?.length ? Math.max(...ctx.opponentBalances) + 1 : Infinity;
  if ((ctx.bagRemaining ?? 68) <= 5) {
    // Unspent currency has no score value; the last usable tile is the penultimate auction.
    return gain > 0 ? Math.min(ctx.myBalance, maxOpponent, Math.ceil(ctx.myBalance / Math.max(1, ctx.bagRemaining! / 2))) : 0;
  }
  const have = ctx.myRack.get(ctx.letter) ?? 0;
  let vowels = 0;
  for (const [c, n] of ctx.myRack) if ("AEIOU".includes(c)) vowels += n;
  const vowel = "AEIOU".includes(ctx.letter);
  let value = LETTER_VALUE[ctx.letter] * 2 + 9;
  if ("AEINORST".includes(ctx.letter)) value += 3;
  if (vowel && vowels < tiles * 0.3) value += 3;
  if (vowel && vowels > tiles * 0.55) value *= 0.5;
  if (!vowel && vowels === 0 && tiles >= 5) value *= 0.5;
  value /= 1 + have * 0.6;
  if ("JQXZ".includes(ctx.letter) && rareExperiment.mode !== "face2") {
    const canUse = tiles >= 4 && vowels > 0 && (rareExperiment.mode !== "strongQGuard" || ctx.letter !== "Q" || (ctx.myRack.get("U") ?? 0) > 0 || (ctx.myRack.get("I") ?? 0) > 0);
    value = canUse ? Math.max(value, rareExperiment.mode === "flat40" ? 40 : LETTER_VALUE[ctx.letter] * (rareExperiment.mode === "face4" ? 4 : 3) + 8) : completed === 0 ? 1 : value;
  }
  value = Math.max(value, gain * 1.15);
  // shortcut: future letters may already be gone; track public draws if speculative bids waste cash.
  if (LETTER_VALUE[ctx.letter] >= 4 && have === 0 && (ctx.bagRemaining ?? 68) > 15) {
    const letterIndex = ctx.letter.charCodeAt(0) - 65;
    if (near[letterIndex] < 0) {
      near[letterIndex] = 0;
      for (const word of premiumIndexes.get(ctx.dictionary)?.get(ctx.letter) ?? []) {
        if (word.text.length > tiles + 2) continue;
        let missing = 0;
        for (const [c, n] of word.needs) {
          missing += Math.max(0, n - (ctx.myRack.get(c) ?? 0));
          if (missing > 2) break;
        }
        if (missing === 2) near[letterIndex] = Math.max(near[letterIndex], word.score);
      }
    }
    value = Math.max(value, near[letterIndex] - 15);
  }
  // A percentage reserve can make every market-priced letter unaffordable at low balances.
  if (ctx.auctionType === "FirstPrice") value *= 0.8;
  return Math.max(0, Math.min(ctx.myBalance, Math.round(value), maxOpponent));
}
