// Offline variant on top of hold-seven: scale bids for high-face letters, and spend remaining cash in the last auctions.
import * as base from './experiment-hold-word.js';
import { LETTER_VALUE, wordScore } from './strategy-trained-market.js';
import * as market from './strategy-market.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export { wordScore, LETTER_VALUE } from './strategy-trained-market.js';
const FACTOR = Number(process.env.PREMIUM_FACTOR ?? 1), MIN_FACE = Number(process.env.PREMIUM_MIN_FACE ?? 8), SPEND_LAST = Number(process.env.ENDGAME_SPEND ?? 0);
// Live audit: runner-up in 609 auctions with a median margin of 2, so a small uplift on every positive bid flips near misses.
const UPLIFT_FLAT = Number(process.env.BID_UPLIFT_FLAT ?? 0), UPLIFT_FACTOR = Number(process.env.BID_UPLIFT_FACTOR ?? 1);
const CHEAP_FACTOR = Number(process.env.CHEAP_FACTOR ?? 1), IMITATE = process.env.IMITATE ? JSON.parse(require('node:fs').readFileSync(process.env.IMITATE, 'utf8')).prices as Record<string, number[]> : undefined, IMITATE_BLEND = Number(process.env.IMITATE_BLEND ?? 1);
export const config = { ...base.config, cheapFactor: CHEAP_FACTOR, imitate: process.env.IMITATE, imitateBlend: IMITATE_BLEND, premiumFactor: FACTOR, premiumMinFace: MIN_FACE, endgameSpend: SPEND_LAST, upliftFlat: UPLIFT_FLAT, upliftFactor: UPLIFT_FACTOR };
export const chooseWord = base.chooseWord;
export function decideBid(ctx: Parameters<typeof base.decideBid>[0]): number {
  let bid = base.decideBid(ctx);
  if (bid > 0) bid = Math.round(bid * UPLIFT_FACTOR) + UPLIFT_FLAT;
  if (LETTER_VALUE[ctx.letter] >= MIN_FACE) bid = Math.round(bid * FACTOR);
  if (LETTER_VALUE[ctx.letter] === 1) bid = Math.round(bid * CHEAP_FACTOR);
  if (IMITATE && bid > 0) {
    // Pay what the top-rated bots pay for this letter at this stage, blended with our own valuation.
    const third = Math.min(2, Math.floor((68 - (ctx.bagRemaining ?? 68)) / 23));
    bid = Math.round(IMITATE_BLEND * IMITATE[ctx.letter][third] + (1 - IMITATE_BLEND) * bid);
  }
  const remaining = ctx.bagRemaining ?? 68;
  if (SPEND_LAST > 0 && remaining > 0 && remaining <= SPEND_LAST && ctx.auctionType !== 'FirstPrice') {
    const rack = new Map(ctx.myRack); rack.set(ctx.letter, (rack.get(ctx.letter) ?? 0) + 1);
    const before = market.chooseWord({ ...ctx, bagRemaining: 0 }), after = market.chooseWord({ ...ctx, myRack: rack, bagRemaining: 0 });
    const gain = (after ? wordScore(after) : 0) - (before ? wordScore(before) : 0);
    // Cash is worthless after the last auction: pay up to the word gain for a tile that improves the payable word.
    if (gain > 0) bid = Math.max(bid, Math.min(ctx.myBalance, gain));
  }
  return Math.max(0, Math.min(ctx.myBalance, bid));
}
