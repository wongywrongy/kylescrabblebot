// Value flexible long-word plans by their expected reward and remaining purchase cost.
import { LETTER_VALUE } from "./baseline.js";
import { index as dictionaryIndex } from "./strategy-plan.js";
import { chooseWord as chooseBaseWord, decideBid as decideBaseBid } from "./experiment-rare-live.js";
export { LETTER_VALUE } from "./baseline.js";
export { wordScore } from "./experiment-rare-live.js";
export type { WordContext } from "./experiment-rare-live.js";
import type { WordContext, BidContext as BaseContext } from "./experiment-rare-live.js";
export interface BidContext extends BaseContext { remainingLetters?: Map<string, number>; }
const BAG_COUNTS = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
type Plan = { score: number; needs: number[]; mask: number };
type MissingPlan = { score: number; missing: number[]; total: number; cost: number };
const planIndexes = new WeakMap<string[], Plan[][]>();
const planCaches = new WeakMap<string[], Map<string, MissingPlan[]>>();
// shortcut: fixed rival top-bid forecasts; refit if auction prices change.
const PLAN_COST = Object.keys(LETTER_VALUE).map(c => "JQXZ".includes(c) ? 38 : LETTER_VALUE[c] >= 3 ? 23 : 15);
function plannerIndex(dictionary: string[]): Plan[][] {
  let plans = planIndexes.get(dictionary);
  if (plans) return plans;
  plans = [];
  const index = dictionaryIndex(dictionary).byLen;
  // shortcut: plan seven-to-nine letter words; expand if longer unfinished racks become common.
  for (let length = 7; length <= 9; length++) {
    const seen = new Set<string>();
    for (const word of index[length] ?? []) {
      const signature = word.needs.join(",");
      if (!seen.has(signature)) {
        seen.add(signature);
        let mask = 0;
        for (let i = 0; i < word.needs.length; i += 2) mask |= 1 << word.needs[i];
        (plans[length] ??= []).push({ score: word.score, needs: word.needs, mask });
      }
    }
  }
  planIndexes.set(dictionary, plans);
  return plans;
}
function plannerBid(ctx: BidContext, tiles: number): number | null {
  if (tiles < 4) return null;
  const rack = Array<number>(26).fill(0);
  for (const [c, n] of ctx.myRack) rack[c.charCodeAt(0) - 65] = n;
  let rackMask = 0;
  for (let i = 0; i < 26; i++) if (rack[i]) rackMask |= 1 << i;
  const key = rack.join(",");
  let cache = planCaches.get(ctx.dictionary);
  if (!cache) { cache = new Map(); planCaches.set(ctx.dictionary, cache); }
  let plans = cache.get(key);
  if (!plans) {
    plans = [];
    const index = plannerIndex(ctx.dictionary);
    const missing = Array<number>(8).fill(0);
    for (let length = 7; length <= Math.min(tiles + 4, 9); length++) {
      for (const word of index[length] ?? []) {
        let absent = word.mask & ~rackMask;
        for (let i = 0; i < 4 && absent; i++) absent &= absent - 1;
        if (absent) continue;
        let total = 0, cost = 0, count = 0;
        for (let i = 0; i < word.needs.length; i += 2) {
          const c = word.needs[i], deficit = Math.max(0, word.needs[i + 1] - rack[c]);
          total += deficit;
          if (total > 4) break;
          if (deficit) { missing[count++] = c; missing[count++] = deficit; cost += deficit * PLAN_COST[c]; }
        }
        if (total <= 4) plans.push({ score: word.score, total, cost, missing: missing.slice(0, count) });
      }
    }
    if (cache.size >= 64) cache.clear();
    cache.set(key, plans);
  }
  if (!plans.length) return null;
  const letter = ctx.letter.charCodeAt(0) - 65;
  // shortcut: use default bag priors without remainingLetters; pass public draw upperbounds for live planning.
  const available = BAG_COUNTS.map((n, c) => ctx.remainingLetters
    ? (ctx.remainingLetters.get(String.fromCharCode(65 + c)) ?? 0)
    : Math.max(0, n - rack[c] - Number(c === letter)));
  const pool = available.reduce((a, b) => a + b, 0);
  const draw = Math.min(1, (ctx.bagRemaining ?? 68) / Math.max(1, pool));
  const probabilities = available.map(n => {
    const p = [1];
    for (let need = 1; need <= 4; need++) {
      let below = 0;
      for (let k = 0; k < need && k <= n; k++) {
        let combinations = 1;
        for (let j = 0; j < k; j++) combinations *= (n - j) / (j + 1);
        below += combinations * draw ** k * (1 - draw) ** (n - k);
      }
      p.push(Math.max(0, Math.min(1, 1 - below)));
    }
    return p;
  });
  const shadow = 0.5, temperature = 3;
  let before = 0, after = 0, bestAfter = -Infinity, budget = 0;
  for (const plan of plans) {
    if (plan.cost > ctx.myBalance) continue;
    let pBefore = 1, pAfter = 1, needed = false;
    for (let i = 0; i < plan.missing.length; i += 2) {
      const c = plan.missing[i], n = plan.missing[i + 1];
      pBefore *= probabilities[c][n];
      pAfter *= probabilities[c][n - Number(c === letter)];
      if (c === letter) needed = true;
    }
    if (plan.total <= 3 && pBefore > 0) before += Math.exp((plan.score * pBefore - shadow * plan.cost) / temperature);
    if (plan.total - Number(needed) > 3 || pAfter === 0) continue;
    const otherCost = plan.cost - (needed ? PLAN_COST[letter] : 0);
    const value = plan.score * pAfter - shadow * otherCost;
    after += Math.exp(value / temperature);
    if (needed && value > bestAfter) { bestAfter = value; budget = ctx.myBalance - otherCost; }
  }
  if (before === 0 && after === 0) return null;
  const marginal = temperature * (Math.log1p(after) - Math.log1p(before)) / shadow;
  return Math.max(0, Math.min(budget, marginal));
}

export function chooseWord(ctx: WordContext): string | null {
  plannerIndex(ctx.dictionary);
  return chooseBaseWord(ctx);
}
export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
  const tiles = [...ctx.myRack.values()].reduce((n, x) => n + x, 0);
  if ((ctx.bagRemaining ?? 68) <= 15 || tiles < 4) return decideBaseBid(ctx);
  plannerIndex(ctx.dictionary);
  const planned = plannerBid(ctx, tiles);
  if (planned === null) return decideBaseBid(ctx);
  const value = ctx.auctionType === "FirstPrice" ? planned * 0.8 : planned;
  const opponents = ctx.opponentBalances?.length ? Math.max(...ctx.opponentBalances) + 1 : Infinity;
  return Math.max(0, Math.min(ctx.myBalance, Math.round(value), opponents));
}
