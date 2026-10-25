import * as mc from './experiment-mc-fast.js';
export { LETTER_VALUE, wordScore, chooseWord } from './experiment-mc-fast.js';
import type { BidContext } from './experiment-mc-fast.js';

export function decideBid(ctx: BidContext) {
  const bid = mc.decideBid(ctx);
  if ((ctx.bagRemaining ?? 68) <= 15 || ctx.myBalance < 30 || !'AEINORST'.includes(ctx.letter)) return bid;
  const floor = 10 / (1 + 0.6 * (ctx.myRack.get(ctx.letter) ?? 0));
  return Math.min(ctx.myBalance, Math.max(bid, Math.round(floor * (ctx.auctionType === 'FirstPrice' ? 0.8 : 1))));
}
