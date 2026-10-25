import * as cap1 from './strategy-candidate.js';
import * as premium from './strategy-premium.js';
import type { BidContext } from './strategy-candidate.js';

export function createCashflowPolicy(base: typeof cap1, factor: number) {
  return {
    chooseWord: base.chooseWord,
    decideBid(ctx: BidContext): number {
      const bid = base.decideBid(ctx);
      if (ctx.myBalance <= 0 || (ctx.bagRemaining ?? 68) <= 5) return bid;
      const myRack = new Map(ctx.myRack);
      myRack.set(ctx.letter, (myRack.get(ctx.letter) ?? 0) + 1);
      const after = base.chooseWord({ ...ctx, myRack });
      // A held word only funds this purchase when the purchased copy is needed to spell it.
      if (!after || [...after].filter(c => c === ctx.letter).length <= (ctx.myRack.get(ctx.letter) ?? 0)) return bid;
      const before = base.chooseWord(ctx);
      const gain = Math.max(0, base.wordScore(after) - (before ? base.wordScore(before) : 0));
      const floor = Math.round(gain * factor * (ctx.auctionType === 'FirstPrice' ? 0.8 : 1));
      const maxOpponent = ctx.opponentBalances?.length ? Math.max(...ctx.opponentBalances) + 1 : Infinity;
      return Math.min(ctx.myBalance, maxOpponent, Math.max(bid, floor));
    },
  };
}

export { cap1, premium };
