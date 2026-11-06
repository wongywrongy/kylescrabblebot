// Exploration wrapper for trace generation: hold-seven words, hold-seven bids scaled by an exogenous random factor so a Q-model can learn the bid/outcome tradeoff.
import * as base from './experiment-gain-policy.js';
export { wordScore, LETTER_VALUE } from './strategy-trained-market.js';
const ZERO = Number(process.env.EXPLORE_ZERO ?? 0.1), LO = Number(process.env.EXPLORE_LO ?? 0.3), HI = Number(process.env.EXPLORE_HI ?? 2);
export const config = { ...base.config, exploreZero: ZERO, exploreLo: LO, exploreHi: HI };
export const chooseWord = base.chooseWord;
export function decideBid(ctx: Parameters<typeof base.decideBid>[0]): number {
  if ((ctx.bagRemaining ?? 0) === 0) return 0;
  const b = base.decideBid(ctx);
  if (Math.random() < ZERO) return 0;
  const f = LO + Math.random() * (HI - LO);
  // Also explore from zero so letters hold-seven never wants still get sampled.
  const bid = b > 0 ? b * f : (Math.random() < 0.3 ? Math.round(5 + Math.random() * 20) : 0);
  return Math.max(0, Math.min(ctx.myBalance, Math.round(bid)));
}
