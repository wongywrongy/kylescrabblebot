import * as premium from './strategy-premium.js';
import { createCashflowPolicy } from './experiment-cashflow-policy.js';

export function createHighFaceCashflowPolicy(base: typeof premium = premium) {
  const cashflow = createCashflowPolicy(base, 0.8);
  return {
    chooseWord: base.chooseWord,
    decideBid(ctx: premium.BidContext) {
      if (premium.LETTER_VALUE[ctx.letter] < 4) return base.decideBid(ctx);
      const myRack = new Map(ctx.myRack);
      myRack.set(ctx.letter, (myRack.get(ctx.letter) ?? 0) + 1);
      const after = base.chooseWord({ ...ctx, myRack });
      return after && base.wordScore(after) >= 30 ? cashflow.decideBid(ctx) : base.decideBid(ctx);
    },
  };
}
